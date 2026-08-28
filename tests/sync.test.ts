import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

/**
 * The Notion connector is replaced with a controllable generator so the sync
 * driver can be tested on its own: cursor persistence, deletion handling,
 * status transitions and failure behaviour, without touching the network.
 */
const scripted: {
  pages: Array<{
    documents: Array<Record<string, unknown>>;
    deletedExternalIds?: string[];
    cursor: Record<string, unknown>;
  }>;
  throwAfterPage: number | null;
  seenModes: string[];
  seenCursors: unknown[];
} = { pages: [], throwAfterPage: null, seenModes: [], seenCursors: [] };

vi.mock("@/server/integrations/notion", () => ({
  notionIntegration: {
    provider: "notion",
    displayName: "Notion",
    description: "test double",
    supportsIncrementalSync: true,
    isConfigured: () => true,
    buildAuthorizationUrl: () => "https://example.test/authorize",
    completeAuthorization: async () => ({
      externalAccountId: "workspace",
      displayName: "Workspace",
      credentials: {},
    }),
    async *sync(context: { mode: string; cursor: unknown }) {
      scripted.seenModes.push(context.mode);
      scripted.seenCursors.push(context.cursor);

      for (const [index, page] of scripted.pages.entries()) {
        if (scripted.throwAfterPage !== null && index === scripted.throwAfterPage) {
          throw new Error("provider exploded mid-sync");
        }
        yield page;
      }
    },
  },
}));

const { closeDb, getDb } = await import("@/server/db/client");
const { documents, integrations, organizations, syncJobs } = await import("@/server/db/schema");
const { encryptCredentials } = await import("@/server/integrations/credentials");
const { runSync } = await import("@/server/jobs/handlers/sync");
const { createLogger } = await import("@/server/logging/logger");
const { resetDatabase } = await import("./helpers/db");

const db = getDb();
const log = createLogger({ test: true });

const page = (externalId: string, content: string) => ({
  externalId,
  title: `Doc ${externalId}`,
  url: `https://notion.so/${externalId}`,
  content,
  metadata: {},
  sourceUpdatedAt: new Date("2026-05-01T00:00:00Z"),
});

async function seed(): Promise<{ organizationId: string; integrationId: string; jobId: string }> {
  const [organization] = await db
    .insert(organizations)
    .values({ name: "Sync Co", slug: `sync-${Math.random().toString(36).slice(2, 8)}` })
    .returning({ id: organizations.id });

  const [integration] = await db
    .insert(integrations)
    .values({
      organizationId: organization!.id,
      provider: "notion",
      externalAccountId: "workspace",
      displayName: "Workspace",
      credentials: encryptCredentials({ accessToken: "token" }),
      updatedAt: new Date(),
    })
    .returning({ id: integrations.id });

  const [job] = await db
    .insert(syncJobs)
    .values({
      organizationId: organization!.id,
      integrationId: integration!.id,
      type: "integration.full_sync",
      idempotencyKey: `key-${Math.random()}`,
    })
    .returning({ id: syncJobs.id });

  return {
    organizationId: organization!.id,
    integrationId: integration!.id,
    jobId: job!.id,
  };
}

async function loadJob(jobId: string) {
  const [job] = await db.select().from(syncJobs).where(eq(syncJobs.id, jobId));
  return job!;
}

describe("sync driver", () => {
  beforeEach(async () => {
    await resetDatabase();
    scripted.pages = [];
    scripted.throwAfterPage = null;
    scripted.seenModes = [];
    scripted.seenCursors = [];
  });

  afterAll(async () => {
    await closeDb();
  });

  it("ingests every page and records a summary", async () => {
    const seeded = await seed();
    scripted.pages = [
      { documents: [page("a", "Alpha content about billing.")], cursor: { step: 1 } },
      { documents: [page("b", "Beta content about payroll.")], cursor: { step: 2 } },
    ];

    const summary = await runSync(await loadJob(seeded.jobId), log);

    expect(summary.pages).toBe(2);
    expect(summary.documentsSeen).toBe(2);
    expect(summary.created).toBe(2);

    const stored = await db
      .select()
      .from(documents)
      .where(eq(documents.integrationId, seeded.integrationId));
    expect(stored).toHaveLength(2);
  });

  it("persists the cursor after every page so a crash resumes", async () => {
    const seeded = await seed();
    scripted.pages = [
      { documents: [page("a", "Alpha.")], cursor: { step: 1 } },
      { documents: [page("b", "Beta.")], cursor: { step: 2 } },
    ];
    // Fail on the third page, after two have been applied and checkpointed.
    scripted.throwAfterPage = 2;
    scripted.pages.push({ documents: [page("c", "Gamma.")], cursor: { step: 3 } });

    await expect(runSync(await loadJob(seeded.jobId), log)).rejects.toThrow("provider exploded");

    const [integration] = await db
      .select()
      .from(integrations)
      .where(eq(integrations.id, seeded.integrationId));

    // The checkpoint from the last successful page survived the failure.
    expect(integration!.cursor).toEqual({ step: 2 });
    expect(integration!.status).toBe("error");
    expect(integration!.lastError).toContain("provider exploded");

    const stored = await db
      .select()
      .from(documents)
      .where(eq(documents.integrationId, seeded.integrationId));
    expect(stored).toHaveLength(2);
  });

  it("marks the integration connected and stamps lastSyncedAt on success", async () => {
    const seeded = await seed();
    scripted.pages = [{ documents: [page("a", "Alpha.")], cursor: { done: true } }];

    await runSync(await loadJob(seeded.jobId), log);

    const [integration] = await db
      .select()
      .from(integrations)
      .where(eq(integrations.id, seeded.integrationId));

    expect(integration!.status).toBe("connected");
    expect(integration!.lastSyncedAt).not.toBeNull();
    expect(integration!.lastError).toBeNull();
    expect(integration!.cursor).toEqual({ done: true });
  });

  it("reconciles documents a full sync no longer reports", async () => {
    const seeded = await seed();

    scripted.pages = [
      { documents: [page("a", "Alpha."), page("b", "Beta.")], cursor: { step: 1 } },
    ];
    await runSync(await loadJob(seeded.jobId), log);

    // Second full sync: "b" has disappeared upstream.
    scripted.pages = [{ documents: [page("a", "Alpha.")], cursor: { step: 2 } }];
    const summary = await runSync(await loadJob(seeded.jobId), log);

    expect(summary.deleted).toBe(1);

    const stored = await db
      .select()
      .from(documents)
      .where(eq(documents.integrationId, seeded.integrationId));

    const gone = stored.find((row) => row.externalId === "b");
    const kept = stored.find((row) => row.externalId === "a");
    expect(gone!.deletedAt).not.toBeNull();
    expect(kept!.deletedAt).toBeNull();
  });

  it("does not reconcile deletions on an incremental sync", async () => {
    const seeded = await seed();
    scripted.pages = [
      { documents: [page("a", "Alpha."), page("b", "Beta.")], cursor: { step: 1 } },
    ];
    await runSync(await loadJob(seeded.jobId), log);

    await db
      .update(syncJobs)
      .set({ type: "integration.incremental_sync" })
      .where(eq(syncJobs.id, seeded.jobId));

    // An incremental sync only reports what changed — silence is not deletion.
    scripted.pages = [{ documents: [page("a", "Alpha revised.")], cursor: { step: 2 } }];
    const summary = await runSync(await loadJob(seeded.jobId), log);

    expect(scripted.seenModes.at(-1)).toBe("incremental");
    expect(summary.deleted).toBe(0);

    const stored = await db
      .select()
      .from(documents)
      .where(eq(documents.integrationId, seeded.integrationId));
    expect(stored.find((row) => row.externalId === "b")!.deletedAt).toBeNull();
  });

  it("applies provider-reported deletions", async () => {
    const seeded = await seed();
    scripted.pages = [{ documents: [page("a", "Alpha."), page("b", "Beta.")], cursor: {} }];
    await runSync(await loadJob(seeded.jobId), log);

    scripted.pages = [
      { documents: [page("a", "Alpha.")], deletedExternalIds: ["b"], cursor: {} },
    ];
    const summary = await runSync(await loadJob(seeded.jobId), log);

    expect(summary.deleted).toBeGreaterThanOrEqual(1);
  });

  it("hands the stored cursor back to the provider on the next run", async () => {
    const seeded = await seed();
    scripted.pages = [{ documents: [page("a", "Alpha.")], cursor: { watermark: "2026-05-01" } }];
    await runSync(await loadJob(seeded.jobId), log);

    scripted.pages = [{ documents: [], cursor: { watermark: "2026-06-01" } }];
    await runSync(await loadJob(seeded.jobId), log);

    expect(scripted.seenCursors[0]).toEqual({});
    expect(scripted.seenCursors[1]).toEqual({ watermark: "2026-05-01" });
  });

  it("re-running an unchanged sync writes no new documents", async () => {
    const seeded = await seed();
    scripted.pages = [{ documents: [page("a", "Alpha content that stays put.")], cursor: {} }];

    await runSync(await loadJob(seeded.jobId), log);
    const summary = await runSync(await loadJob(seeded.jobId), log);

    expect(summary.created).toBe(0);
    expect(summary.unchanged).toBe(1);
  });
});
