import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import type { Database } from "@/server/db/client";
import type { SyncJob, SyncJobStatus, SyncJobType } from "@/server/db/schema";

/**
 * Claiming a job needs `FOR UPDATE SKIP LOCKED`, which means raw SQL — and
 * raw SQL returns the database's own snake_case column names rather than the
 * camelCase field names the schema exposes. This row type and mapper make that
 * boundary explicit; without it every multi-word field silently reads as
 * `undefined` at runtime while still type-checking.
 */
interface SyncJobRow extends Record<string, unknown> {
  id: string;
  organization_id: string;
  integration_id: string | null;
  type: SyncJobType;
  payload: Record<string, unknown>;
  status: SyncJobStatus;
  idempotency_key: string;
  attempts: number;
  max_attempts: number;
  run_at: Date;
  locked_at: Date | null;
  locked_by: string | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

function toSyncJob(row: SyncJobRow): SyncJob {
  return {
    id: row.id,
    organizationId: row.organization_id,
    integrationId: row.integration_id,
    type: row.type,
    payload: row.payload,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    runAt: row.run_at,
    lockedAt: row.locked_at,
    lockedBy: row.locked_by,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

export interface EnqueueInput {
  organizationId: string;
  integrationId?: string | null;
  type: SyncJobType;
  payload?: Record<string, unknown>;
  /**
   * Collapses duplicate work. A webhook redelivered three times, or an
   * impatient user clicking "Sync now" twice, must not produce three syncs.
   */
  idempotencyKey?: string;
  runAt?: Date;
  maxAttempts?: number;
}

export function buildIdempotencyKey(parts: Array<string | number | null | undefined>): string {
  return createHash("sha256").update(parts.map((part) => String(part ?? "")).join("|")).digest("hex");
}

/**
 * Enqueues a job, or revives the row if an identical job already finished.
 *
 * The unique key means at most one row per logical job. While that row is
 * pending or running, a duplicate enqueue is a no-op — which is exactly the
 * semantics a webhook handler wants.
 */
export async function enqueueJob(
  input: EnqueueInput,
  db: Database = getDb(),
): Promise<{ job: SyncJob | null; deduplicated: boolean }> {
  const idempotencyKey =
    input.idempotencyKey ??
    buildIdempotencyKey([input.organizationId, input.integrationId, input.type, Date.now()]);

  const result = await db.execute<SyncJobRow>(sql`
    INSERT INTO sync_jobs (
      organization_id, integration_id, type, payload, status,
      idempotency_key, attempts, max_attempts, run_at
    )
    VALUES (
      ${input.organizationId}, ${input.integrationId ?? null}, ${input.type},
      ${JSON.stringify(input.payload ?? {})}::jsonb, 'pending',
      ${idempotencyKey}, 0, ${input.maxAttempts ?? 5}, ${input.runAt ?? new Date()}
    )
    ON CONFLICT (idempotency_key) DO UPDATE SET
      status = 'pending',
      payload = EXCLUDED.payload,
      attempts = 0,
      run_at = EXCLUDED.run_at,
      locked_at = NULL,
      locked_by = NULL,
      last_error = NULL,
      completed_at = NULL,
      updated_at = now()
    -- Only revive a settled job; leave queued and in-flight work alone.
    WHERE sync_jobs.status IN ('succeeded', 'failed', 'dead')
    RETURNING *
  `);

  const row = result.rows[0];
  return { job: row ? toSyncJob(row) : null, deduplicated: row === undefined };
}

/**
 * Claims one due job.
 *
 * `FOR UPDATE SKIP LOCKED` is what lets several workers share this table
 * without a broker: each transaction takes a row nobody else holds, and
 * contention costs a skipped row rather than a lock wait (ADR 0003).
 */
export async function claimNextJob(workerId: string, db: Database = getDb()): Promise<SyncJob | null> {
  const result = await db.execute<SyncJobRow>(sql`
    UPDATE sync_jobs SET
      status = 'running',
      attempts = attempts + 1,
      locked_at = now(),
      locked_by = ${workerId},
      updated_at = now()
    WHERE id = (
      SELECT id FROM sync_jobs
      WHERE status = 'pending' AND run_at <= now()
      ORDER BY run_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING *
  `);
  const row = result.rows[0];
  return row ? toSyncJob(row) : null;
}

export async function completeJob(jobId: string, db: Database = getDb()): Promise<void> {
  await db.execute(sql`
    UPDATE sync_jobs SET
      status = 'succeeded', locked_at = NULL, locked_by = NULL,
      last_error = NULL, completed_at = now(), updated_at = now()
    WHERE id = ${jobId}
  `);
}

/** Backoff schedule for retries, capped so a broken source is retried hourly. */
export function retryDelayMs(attempts: number): number {
  const base = Math.min(2 ** attempts * 1000, 60 * 60 * 1000);
  // Jitter: without it, everything that failed in one outage retries together.
  return Math.round(base * (0.5 + Math.random() * 0.5));
}

/**
 * Records a failure. A job that has attempts left is rescheduled with backoff;
 * one that has exhausted them (or failed unretryably) becomes `dead` and waits
 * for a human — silently dropping it would hide a broken integration.
 */
export async function failJob(
  jobId: string,
  error: string,
  options: { retryable: boolean },
  db: Database = getDb(),
): Promise<{ status: "pending" | "dead" }> {
  const result = await db.execute<{ status: "pending" | "dead" }>(sql`
    UPDATE sync_jobs SET
      status = CASE
        WHEN ${options.retryable} AND attempts < max_attempts THEN 'pending'
        ELSE 'dead'
      END,
      run_at = CASE
        WHEN ${options.retryable} AND attempts < max_attempts
        THEN now() + (${retryDelayMs(1)}::int * power(2, attempts)::int) * interval '1 millisecond'
        ELSE run_at
      END,
      locked_at = NULL,
      locked_by = NULL,
      last_error = ${error.slice(0, 4000)},
      completed_at = CASE
        WHEN ${options.retryable} AND attempts < max_attempts THEN NULL
        ELSE now()
      END,
      updated_at = now()
    WHERE id = ${jobId}
    RETURNING status
  `);
  return { status: result.rows[0]?.status ?? "dead" };
}

/**
 * Returns jobs abandoned by a worker that died mid-run to the queue.
 *
 * Without this a crashed worker's in-flight jobs stay `running` forever and
 * that integration silently stops syncing.
 */
export async function reclaimStalledJobs(
  stalledAfterMs: number,
  db: Database = getDb(),
): Promise<number> {
  const result = await db.execute(sql`
    UPDATE sync_jobs SET
      status = 'pending', locked_at = NULL, locked_by = NULL, updated_at = now(),
      last_error = coalesce(last_error, 'Reclaimed after worker stall')
    WHERE status = 'running'
      AND locked_at < now() - (${stalledAfterMs}::bigint * interval '1 millisecond')
    RETURNING id
  `);
  return result.rowCount ?? 0;
}
