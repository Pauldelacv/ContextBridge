import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeDb, getDb } from "@/server/db/client";
import { chunks, documents, integrations, organizations } from "@/server/db/schema";
import { encryptCredentials } from "@/server/integrations/credentials";
import { deleteDocument, ingestDocument, reconcileDeletions } from "@/server/ingestion/pipeline";
import type { NormalizedDocument } from "@/server/ingestion/normalize";
import { resetDatabase } from "./helpers/db";

const db = getDb();

async function seedTenant(name: string): Promise<{ organizationId: string; integrationId: string }> {
  const [organization] = await db
    .insert(organizations)
    .values({ name, slug: `${name.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}` })
    .returning({ id: organizations.id });

  const [integration] = await db
    .insert(integrations)
    .values({
      organizationId: organization!.id,
      provider: "notion",
      externalAccountId: `workspace-${name}`,
      displayName: `${name} Notion`,
      credentials: encryptCredentials({ accessToken: "test-token" }),
      updatedAt: new Date(),
    })
    .returning({ id: integrations.id });

  return { organizationId: organization!.id, integrationId: integration!.id };
}

const doc = (overrides: Partial<NormalizedDocument> = {}): NormalizedDocument => ({
  externalId: "page-1",
  title: "Expense Policy",
  url: "https://notion.so/page-1",
  content: "# Expense Policy\n\nEmployees may spend up to 75 euros per day on meals while travelling.",
  metadata: { space: "Finance" },
  sourceUpdatedAt: new Date("2026-01-01T00:00:00Z"),
  ...overrides,
});

describe("ingestion pipeline", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeDb();
  });

  it("creates a document with embedded chunks", async () => {
    const tenant = await seedTenant("Acme");

    const result = await ingestDocument(doc(), { ...tenant, provider: "notion" });

    expect(result.outcome).toBe("created");
    expect(result.chunkCount).toBeGreaterThan(0);
    expect(result.embeddedChunks).toBe(result.chunkCount);

    const stored = await db.select().from(chunks).where(eq(chunks.documentId, result.documentId));
    expect(stored).toHaveLength(result.chunkCount);
    for (const chunk of stored) {
      expect(chunk.embedding).not.toBeNull();
      expect(chunk.embeddingModel).toBe("local:hashing-v1");
      expect(chunk.organizationId).toBe(tenant.organizationId);
    }
  });

  it("is idempotent: re-ingesting unchanged content embeds nothing", async () => {
    const tenant = await seedTenant("Acme");

    const first = await ingestDocument(doc(), { ...tenant, provider: "notion" });
    const second = await ingestDocument(doc(), { ...tenant, provider: "notion" });

    expect(second.outcome).toBe("unchanged");
    expect(second.embeddedChunks).toBe(0);
    expect(second.documentId).toBe(first.documentId);
    expect(second.chunkCount).toBe(first.chunkCount);
  });

  it("treats a title-only change as a real change", async () => {
    const tenant = await seedTenant("Acme");
    await ingestDocument(doc(), { ...tenant, provider: "notion" });

    const result = await ingestDocument(doc({ title: "Travel Expense Policy" }), {
      ...tenant,
      provider: "notion",
    });

    expect(result.outcome).toBe("updated");
    const [stored] = await db.select().from(documents).where(eq(documents.id, result.documentId));
    expect(stored!.title).toBe("Travel Expense Policy");
  });

  it("reuses embeddings for paragraphs that survived an edit", async () => {
    const tenant = await seedTenant("Acme");

    const sections = Array.from(
      { length: 6 },
      (_, index) => `## Section ${index}\n\n${"detail ".repeat(120)}`,
    );
    const original = doc({ content: sections.join("\n\n") });
    const first = await ingestDocument(original, { ...tenant, provider: "notion" });
    expect(first.embeddedChunks).toBeGreaterThan(1);

    // Change one section; the rest is byte-identical.
    const edited = doc({
      content: [...sections.slice(0, 5), "## Section 5\n\nCompletely rewritten content here."].join("\n\n"),
    });
    const second = await ingestDocument(edited, { ...tenant, provider: "notion" });

    expect(second.outcome).toBe("updated");
    expect(second.embeddedChunks).toBeLessThan(first.embeddedChunks);
    expect(second.embeddedChunks).toBeGreaterThan(0);
  });

  it("soft-deletes a document and drops its chunks", async () => {
    const tenant = await seedTenant("Acme");
    const created = await ingestDocument(doc(), { ...tenant, provider: "notion" });

    const { deleted } = await deleteDocument("page-1", {
      integrationId: tenant.integrationId,
      provider: "notion",
    });

    expect(deleted).toBe(true);
    const [stored] = await db.select().from(documents).where(eq(documents.id, created.documentId));
    expect(stored!.deletedAt).not.toBeNull();
    const remaining = await db.select().from(chunks).where(eq(chunks.documentId, created.documentId));
    expect(remaining).toHaveLength(0);
  });

  it("reconciles documents the provider stopped reporting", async () => {
    const tenant = await seedTenant("Acme");
    await ingestDocument(doc({ externalId: "page-1" }), { ...tenant, provider: "notion" });
    await ingestDocument(doc({ externalId: "page-2", title: "Security" }), {
      ...tenant,
      provider: "notion",
    });

    const removed = await reconcileDeletions(["page-1"], {
      integrationId: tenant.integrationId,
      provider: "notion",
    });

    expect(removed).toBe(1);
    const [survivor] = await db
      .select()
      .from(documents)
      .where(and(eq(documents.integrationId, tenant.integrationId), eq(documents.externalId, "page-1")));
    expect(survivor!.deletedAt).toBeNull();
  });

  it("restores a document that reappears upstream", async () => {
    const tenant = await seedTenant("Acme");
    await ingestDocument(doc(), { ...tenant, provider: "notion" });
    await deleteDocument("page-1", { integrationId: tenant.integrationId, provider: "notion" });

    const restored = await ingestDocument(doc(), { ...tenant, provider: "notion" });

    const [stored] = await db.select().from(documents).where(eq(documents.id, restored.documentId));
    expect(stored!.deletedAt).toBeNull();
    const rechunked = await db.select().from(chunks).where(eq(chunks.documentId, restored.documentId));
    expect(rechunked.length).toBeGreaterThan(0);
  });
});
