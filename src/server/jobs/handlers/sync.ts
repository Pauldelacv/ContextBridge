import { eq } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { integrations } from "@/server/db/schema";
import type { SyncJob } from "@/server/db/schema";
import { notFound } from "@/server/errors";
import { decryptCredentials, encryptCredentials } from "@/server/integrations/credentials";
import { getIntegration } from "@/server/integrations/registry";
import type { SyncCursor } from "@/server/integrations/types";
import { deleteDocument, ingestDocument, reconcileDeletions } from "@/server/ingestion/pipeline";
import type { Logger } from "@/server/logging/logger";

export interface SyncSummary {
  documentsSeen: number;
  created: number;
  updated: number;
  unchanged: number;
  deleted: number;
  pages: number;
}

/**
 * Drives one integration's sync from its cursor to exhaustion.
 *
 * Two properties matter here and are worth the extra bookkeeping:
 *
 * 1. **Resumable.** The cursor is persisted after every page, so a worker that
 *    dies 900 pages into a Notion workspace resumes at page 900, not page 0.
 * 2. **Idempotent.** Every document goes through the hash-guarded pipeline, so
 *    replaying a page that was already applied writes nothing.
 */
export async function runSync(
  job: SyncJob,
  logger: Logger,
  signal?: AbortSignal,
): Promise<SyncSummary> {
  const db = getDb();

  if (!job.integrationId) throw notFound("Sync job has no integration");

  const [record] = await db
    .select()
    .from(integrations)
    .where(eq(integrations.id, job.integrationId))
    .limit(1);
  if (!record) throw notFound("Integration no longer exists");

  const integration = getIntegration(record.provider);
  const mode: "full" | "incremental" =
    job.type === "integration.incremental_sync" && integration.supportsIncrementalSync
      ? "incremental"
      : "full";

  const log = logger.child({ provider: record.provider, integrationId: record.id, mode });

  await db
    .update(integrations)
    .set({ status: "syncing", lastError: null, updatedAt: new Date() })
    .where(eq(integrations.id, record.id));

  const summary: SyncSummary = {
    documentsSeen: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    deleted: 0,
    pages: 0,
  };
  const seenExternalIds: string[] = [];

  try {
    const credentials = decryptCredentials<Record<string, unknown>>(record.credentials);

    const pages = integration.sync({
      organizationId: record.organizationId,
      integrationId: record.id,
      credentials,
      config: record.config,
      cursor: record.cursor as SyncCursor,
      mode,
      logger: log,
      signal,
      onCredentialsRefreshed: async (refreshed) => {
        await db
          .update(integrations)
          .set({ credentials: encryptCredentials(refreshed), updatedAt: new Date() })
          .where(eq(integrations.id, record.id));
        log.info("sync.credentials_refreshed");
      },
    });

    for await (const page of pages) {
      if (signal?.aborted) break;
      summary.pages += 1;

      for (const document of page.documents) {
        const result = await ingestDocument(document, {
          organizationId: record.organizationId,
          integrationId: record.id,
          provider: record.provider,
          logger: log,
        });
        summary.documentsSeen += 1;
        seenExternalIds.push(document.externalId);
        if (result.outcome === "created") summary.created += 1;
        else if (result.outcome === "updated") summary.updated += 1;
        else summary.unchanged += 1;
      }

      for (const externalId of page.deletedExternalIds ?? []) {
        const { deleted } = await deleteDocument(externalId, {
          integrationId: record.id,
          provider: record.provider,
          logger: log,
        });
        if (deleted) summary.deleted += 1;
      }

      // Persist progress before fetching the next page — this is what makes
      // the sync resumable rather than all-or-nothing.
      await db
        .update(integrations)
        .set({ cursor: page.cursor, updatedAt: new Date() })
        .where(eq(integrations.id, record.id));
    }

    // A full sync has seen everything the source holds, so anything it did not
    // mention is gone. Incremental syncs cannot make that claim.
    if (mode === "full" && !signal?.aborted) {
      summary.deleted += await reconcileDeletions(seenExternalIds, {
        integrationId: record.id,
        provider: record.provider,
        logger: log,
      });
    }

    await db
      .update(integrations)
      .set({
        status: "connected",
        lastSyncedAt: new Date(),
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(integrations.id, record.id));

    log.info("sync.completed", { ...summary });
    return summary;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .update(integrations)
      .set({ status: "error", lastError: message.slice(0, 2000), updatedAt: new Date() })
      .where(eq(integrations.id, record.id));
    throw error;
  }
}
