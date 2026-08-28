import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getDb } from "@/server/db/client";
import { integrations, organizations } from "@/server/db/schema";
import type { IntegrationProvider } from "@/server/db/schema";
import { encryptCredentials } from "@/server/integrations/credentials";
import { ingestDocument } from "@/server/ingestion/pipeline";
import { searchChunks } from "@/server/retrieval/search";
import { resetDatabase } from "./helpers/db";

const db = getDb();

async function seedTenant(
  name: string,
  provider: IntegrationProvider = "notion",
): Promise<{ organizationId: string; integrationId: string }> {
  const [organization] = await db
    .insert(organizations)
    .values({ name, slug: `${name}-${Math.random().toString(36).slice(2, 8)}` })
    .returning({ id: organizations.id });

  const [integration] = await db
    .insert(integrations)
    .values({
      organizationId: organization!.id,
      provider,
      externalAccountId: `account-${name}-${provider}`,
      displayName: `${name} ${provider}`,
      credentials: encryptCredentials({ accessToken: "test" }),
      updatedAt: new Date(),
    })
    .returning({ id: integrations.id });

  return { organizationId: organization!.id, integrationId: integration!.id };
}

let acme: { organizationId: string; integrationId: string };
let acmeSlack: { organizationId: string; integrationId: string };
let rival: { organizationId: string; integrationId: string };

describe("hybrid retrieval", () => {
  beforeAll(async () => {
    await resetDatabase();

    acme = await seedTenant("acme");
    rival = await seedTenant("rival");

    // Slack lives under the same tenant but a different integration.
    const [slackIntegration] = await db
      .insert(integrations)
      .values({
        organizationId: acme.organizationId,
        provider: "slack",
        externalAccountId: "T-acme",
        displayName: "Acme Slack",
        credentials: encryptCredentials({ accessToken: "test" }),
        updatedAt: new Date(),
      })
      .returning({ id: integrations.id });
    acmeSlack = { organizationId: acme.organizationId, integrationId: slackIntegration!.id };

    await ingestDocument(
      {
        externalId: "vacation",
        title: "Time Off Policy",
        url: "https://notion.so/vacation",
        content:
          "# Time Off Policy\n\nEvery full-time employee receives 25 days of paid vacation per calendar year. Unused days may be carried into the first quarter of the following year.",
        metadata: {},
        sourceUpdatedAt: new Date("2026-02-01T00:00:00Z"),
      },
      { ...acme, provider: "notion" },
    );

    await ingestDocument(
      {
        externalId: "deploy",
        title: "Deployment Runbook",
        url: "https://notion.so/deploy",
        content:
          "# Deployment Runbook\n\nRun the migration job before promoting the release. If the health check fails with error code ERR_4021, roll back immediately.",
        metadata: {},
        sourceUpdatedAt: new Date("2026-03-01T00:00:00Z"),
      },
      { ...acme, provider: "notion" },
    );

    await ingestDocument(
      {
        externalId: "C123:1700000000.000100",
        title: "#support: laptop refresh",
        url: "https://app.slack.com/archives/C123/p1700000000000100",
        content:
          "# #support: laptop refresh\n\nDana (2026-04-01): How often do we replace laptops?\n\nSam (2026-04-01): The hardware refresh cycle is every three years, or sooner if the machine fails.",
        metadata: {},
        sourceUpdatedAt: new Date("2026-04-01T00:00:00Z"),
      },
      { ...acmeSlack, provider: "slack" },
    );

    // A different tenant with deliberately similar content.
    await ingestDocument(
      {
        externalId: "rival-vacation",
        title: "Rival Time Off Policy",
        url: "https://notion.so/rival-vacation",
        content:
          "# Rival Time Off Policy\n\nEvery full-time employee receives 40 days of paid vacation per calendar year.",
        metadata: {},
        sourceUpdatedAt: new Date("2026-02-01T00:00:00Z"),
      },
      { ...rival, provider: "notion" },
    );
  });

  afterAll(async () => {
    await closeDb();
  });

  it("finds the relevant document for a paraphrased question", async () => {
    const results = await searchChunks({
      organizationId: acme.organizationId,
      query: "How many paid vacation days do employees get?",
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.title).toBe("Time Off Policy");
    expect(results[0]!.content).toContain("25 days");
  });

  it("finds an exact token that a pure vector search would smooth away", async () => {
    const results = await searchChunks({
      organizationId: acme.organizationId,
      query: "ERR_4021",
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.title).toBe("Deployment Runbook");
    // The keyword arm is what found it.
    expect(results[0]!.keywordScore).toBeGreaterThan(0);
  });

  it("never returns another tenant's chunks", async () => {
    const results = await searchChunks({
      organizationId: acme.organizationId,
      query: "How many paid vacation days do employees get?",
      limit: 25,
    });

    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(result.title).not.toContain("Rival");
      expect(result.content).not.toContain("40 days");
    }
  });

  it("scopes each tenant to its own answer to the same question", async () => {
    const rivalResults = await searchChunks({
      organizationId: rival.organizationId,
      query: "How many paid vacation days do employees get?",
    });

    expect(rivalResults.length).toBeGreaterThan(0);
    expect(rivalResults[0]!.content).toContain("40 days");
  });

  it("filters by provider when asked", async () => {
    const results = await searchChunks({
      organizationId: acme.organizationId,
      query: "laptop replacement hardware refresh",
      providers: ["slack"],
    });

    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(result.provider).toBe("slack");
    }
  });

  it("returns nothing for an empty query instead of everything", async () => {
    const results = await searchChunks({ organizationId: acme.organizationId, query: "   " });
    expect(results).toEqual([]);
  });

  it("carries the heading trail and url through to the result", async () => {
    const results = await searchChunks({
      organizationId: acme.organizationId,
      query: "carry over unused vacation days",
    });

    const top = results[0]!;
    expect(top.url).toBe("https://notion.so/vacation");
    expect(top.headingPath).toContain("Time Off Policy");
  });

  it("respects the per-document cap so one page cannot fill the context", async () => {
    const longDocument = Array.from(
      { length: 20 },
      (_, index) => `## Section ${index}\n\nvacation policy detail ${"more ".repeat(80)}`,
    ).join("\n\n");

    await ingestDocument(
      {
        externalId: "long-vacation",
        title: "Vacation FAQ",
        url: null,
        content: longDocument,
        metadata: {},
        sourceUpdatedAt: new Date(),
      },
      { ...acme, provider: "notion" },
    );

    const results = await searchChunks({
      organizationId: acme.organizationId,
      query: "vacation policy detail",
      limit: 6,
      maxPerDocument: 2,
    });

    const perDocument = new Map<string, number>();
    for (const result of results) {
      perDocument.set(result.documentId, (perDocument.get(result.documentId) ?? 0) + 1);
    }

    const mostFromOneDocument = [...perDocument.values()].sort((a, b) => b - a)[0] ?? 0;
    expect(mostFromOneDocument).toBeLessThanOrEqual(2);
    // The cap is hard: it returns fewer results rather than topping up from
    // the document it just limited.
    expect(results.length).toBeLessThanOrEqual(6);
    expect(results.length).toBeGreaterThan(1);
    expect(perDocument.size).toBeGreaterThan(1);
  });
});
