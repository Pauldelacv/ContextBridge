import { and, count, eq, inArray, isNull } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import type { Database } from "@/server/db/client";
import { chunks, documents } from "@/server/db/schema";
import type { IntegrationProvider } from "@/server/db/schema";
import { getEmbeddingProvider } from "@/server/embeddings";
import type { EmbeddingProvider } from "@/server/embeddings";
import { chunkText, formatChunkForEmbedding } from "@/server/ingestion/chunk";
import type { ChunkOptions } from "@/server/ingestion/chunk";
import { documentContentHash, normalizeText, normalizeTitle } from "@/server/ingestion/normalize";
import type { NormalizedDocument } from "@/server/ingestion/normalize";
import { recordIngestion } from "@/server/observability/metrics";
import type { Logger } from "@/server/logging/logger";
import { logger as defaultLogger } from "@/server/logging/logger";

export type IngestOutcome = "created" | "updated" | "unchanged" | "deleted";

export interface IngestResult {
  documentId: string;
  outcome: IngestOutcome;
  chunkCount: number;
  /** Chunks that actually needed an embedding call this run. */
  embeddedChunks: number;
}

export interface IngestContext {
  organizationId: string;
  integrationId: string;
  provider: IntegrationProvider;
  db?: Database;
  embeddings?: EmbeddingProvider;
  chunkOptions?: ChunkOptions;
  logger?: Logger;
}

/**
 * Ingests one normalized document.
 *
 * The pipeline is idempotent by design: re-running it on unchanged content is
 * cheap and writes nothing. Two hashes make that work — a document hash that
 * short-circuits the whole run, and per-chunk hashes that let an edit to one
 * paragraph of a long page re-embed only that paragraph.
 */
export async function ingestDocument(
  input: NormalizedDocument,
  context: IngestContext,
): Promise<IngestResult> {
  const db = context.db ?? getDb();
  const embeddings = context.embeddings ?? getEmbeddingProvider();
  const log = (context.logger ?? defaultLogger).child({
    integrationId: context.integrationId,
    externalId: input.externalId,
  });

  const normalized: NormalizedDocument = {
    ...input,
    title: normalizeTitle(input.title),
    content: normalizeText(input.content),
  };
  const contentHash = documentContentHash(normalized);

  const [existing] = await db
    .select({
      id: documents.id,
      contentHash: documents.contentHash,
      indexedAt: documents.indexedAt,
      deletedAt: documents.deletedAt,
    })
    .from(documents)
    .where(
      and(
        eq(documents.integrationId, context.integrationId),
        eq(documents.externalId, normalized.externalId),
      ),
    )
    .limit(1);

  // Nothing changed upstream and the document is already indexed: stop here.
  if (
    existing &&
    existing.contentHash === contentHash &&
    existing.indexedAt !== null &&
    existing.deletedAt === null
  ) {
    recordIngestion(context.provider, "unchanged");
    log.debug("ingest.unchanged", { documentId: existing.id });
    const [counted] = await db
      .select({ count: count() })
      .from(chunks)
      .where(eq(chunks.documentId, existing.id));
    return {
      documentId: existing.id,
      outcome: "unchanged",
      chunkCount: counted?.count ?? 0,
      embeddedChunks: 0,
    };
  }

  const outcome: IngestOutcome = existing ? "updated" : "created";

  const [document] = await db
    .insert(documents)
    .values({
      organizationId: context.organizationId,
      integrationId: context.integrationId,
      provider: context.provider,
      externalId: normalized.externalId,
      title: normalized.title,
      url: normalized.url,
      content: normalized.content,
      contentHash,
      metadata: normalized.metadata,
      sourceUpdatedAt: normalized.sourceUpdatedAt,
      deletedAt: null,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [documents.integrationId, documents.externalId],
      set: {
        title: normalized.title,
        url: normalized.url,
        content: normalized.content,
        contentHash,
        metadata: normalized.metadata,
        sourceUpdatedAt: normalized.sourceUpdatedAt,
        deletedAt: null,
        updatedAt: new Date(),
      },
    })
    .returning({ id: documents.id });

  if (!document) throw new Error(`Failed to upsert document ${normalized.externalId}`);

  const nextChunks = chunkText(normalized.content, context.chunkOptions);

  // Reuse embeddings for chunk text that survived the edit unchanged. On a long
  // page where one paragraph moved, this turns a full re-embed into a few calls.
  const reusable = new Map<string, number[]>();
  if (existing) {
    const previous = await db
      .select({
        contentHash: chunks.contentHash,
        embedding: chunks.embedding,
        embeddingModel: chunks.embeddingModel,
      })
      .from(chunks)
      .where(eq(chunks.documentId, document.id));

    for (const row of previous) {
      // An embedding from a different model is not interchangeable.
      if (row.embedding && row.embeddingModel === embeddings.id) {
        reusable.set(row.contentHash, row.embedding);
      }
    }
  }

  const toEmbed = nextChunks.filter((chunk) => !reusable.has(chunk.contentHash));
  const freshVectors =
    toEmbed.length > 0
      ? await embeddings.embedDocuments(
          toEmbed.map((chunk) => formatChunkForEmbedding(normalized.title, chunk)),
        )
      : [];

  const vectorByHash = new Map(reusable);
  toEmbed.forEach((chunk, index) => {
    const vector = freshVectors[index];
    if (vector) vectorByHash.set(chunk.contentHash, vector);
  });

  await db.transaction(async (tx) => {
    // Ordinals are positional, so a rewrite replaces the set rather than
    // patching it — the reuse above already saved the expensive part.
    await tx.delete(chunks).where(eq(chunks.documentId, document.id));

    if (nextChunks.length > 0) {
      await tx.insert(chunks).values(
        nextChunks.map((chunk) => ({
          organizationId: context.organizationId,
          documentId: document.id,
          ordinal: chunk.ordinal,
          content: chunk.content,
          contentHash: chunk.contentHash,
          tokenEstimate: chunk.tokenEstimate,
          embedding: vectorByHash.get(chunk.contentHash) ?? null,
          embeddingModel: vectorByHash.has(chunk.contentHash) ? embeddings.id : null,
          metadata: {
            headingPath: chunk.headingPath,
            title: normalized.title,
            url: normalized.url,
            provider: context.provider,
            ...normalized.metadata,
          },
        })),
      );
    }

    await tx
      .update(documents)
      .set({ indexedAt: new Date(), updatedAt: new Date() })
      .where(eq(documents.id, document.id));
  });

  recordIngestion(context.provider, outcome);
  log.info("ingest.indexed", {
    documentId: document.id,
    outcome,
    chunkCount: nextChunks.length,
    embeddedChunks: toEmbed.length,
    reusedChunks: nextChunks.length - toEmbed.length,
  });

  return {
    documentId: document.id,
    outcome,
    chunkCount: nextChunks.length,
    embeddedChunks: toEmbed.length,
  };
}

/**
 * Marks a document deleted upstream. The row is kept (audit trail, and a
 * restore is a re-ingest) but its chunks go, so it stops being retrievable
 * immediately.
 */
export async function deleteDocument(
  externalId: string,
  context: Pick<IngestContext, "integrationId" | "provider" | "db" | "logger">,
): Promise<{ deleted: boolean }> {
  const db = context.db ?? getDb();

  const [document] = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.integrationId, context.integrationId), eq(documents.externalId, externalId)))
    .limit(1);

  if (!document) return { deleted: false };

  await db.transaction(async (tx) => {
    await tx.delete(chunks).where(eq(chunks.documentId, document.id));
    await tx
      .update(documents)
      .set({ deletedAt: new Date(), indexedAt: null, updatedAt: new Date() })
      .where(eq(documents.id, document.id));
  });

  recordIngestion(context.provider, "deleted");
  (context.logger ?? defaultLogger).info("ingest.deleted", { documentId: document.id, externalId });
  return { deleted: true };
}

/**
 * After a full sync, anything the provider did not mention no longer exists
 * there. Comparing against the ids we just saw is how deletions get detected
 * for providers with no deletion webhook.
 */
export async function reconcileDeletions(
  seenExternalIds: string[],
  context: Pick<IngestContext, "integrationId" | "provider" | "db" | "logger">,
): Promise<number> {
  const db = context.db ?? getDb();

  const live = await db
    .select({ id: documents.id, externalId: documents.externalId })
    .from(documents)
    .where(and(eq(documents.integrationId, context.integrationId), isNull(documents.deletedAt)));

  const seen = new Set(seenExternalIds);
  const stale = live.filter((row) => !seen.has(row.externalId));
  if (stale.length === 0) return 0;

  const staleIds = stale.map((row) => row.id);
  await db.transaction(async (tx) => {
    await tx.delete(chunks).where(inArray(chunks.documentId, staleIds));
    await tx
      .update(documents)
      .set({ deletedAt: new Date(), indexedAt: null, updatedAt: new Date() })
      .where(inArray(documents.id, staleIds));
  });

  for (const _ of stale) recordIngestion(context.provider, "deleted");
  (context.logger ?? defaultLogger).info("ingest.reconciled", { removed: stale.length });
  return stale.length;
}
