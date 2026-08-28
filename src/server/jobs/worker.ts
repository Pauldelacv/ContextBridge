import { randomUUID } from "node:crypto";
import { getEnv } from "@/server/config/env";
import { isAppError } from "@/server/errors";
import { createLogger } from "@/server/logging/logger";
import { recordJob } from "@/server/observability/metrics";
import { claimNextJob, completeJob, failJob, reclaimStalledJobs } from "@/server/jobs/queue";
import { runSync } from "@/server/jobs/handlers/sync";
import type { SyncJob } from "@/server/db/schema";

/** A job locked for longer than this is assumed to belong to a dead worker. */
const STALL_TIMEOUT_MS = 15 * 60 * 1000;
const REAP_INTERVAL_MS = 60 * 1000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function execute(job: SyncJob, signal: AbortSignal): Promise<void> {
  const log = createLogger({ jobId: job.id, jobType: job.type, organizationId: job.organizationId });

  switch (job.type) {
    case "integration.full_sync":
    case "integration.incremental_sync":
      await runSync(job, log, signal);
      return;
    case "document.ingest":
    case "document.delete":
      // Single-document jobs go through the same sync path: the provider's
      // cursor already knows how to fetch just what changed.
      await runSync(job, log, signal);
      return;
    default: {
      const exhaustive: never = job.type;
      throw new Error(`Unhandled job type: ${String(exhaustive)}`);
    }
  }
}

/**
 * Polls the queue and runs jobs until stopped.
 *
 * Polling rather than LISTEN/NOTIFY is a deliberate simplification: at this
 * scale a 1s poll is invisible to users and has none of the reconnection
 * edge cases (ADR 0003).
 */
export async function runWorker(options: { signal?: AbortSignal } = {}): Promise<void> {
  const env = getEnv();
  const workerId = `${process.pid}-${randomUUID().slice(0, 8)}`;
  const log = createLogger({ workerId });
  const controller = new AbortController();

  options.signal?.addEventListener("abort", () => controller.abort(), { once: true });

  log.info("worker.started", {
    concurrency: env.WORKER_CONCURRENCY,
    pollIntervalMs: env.WORKER_POLL_INTERVAL_MS,
  });

  let lastReapAt = 0;

  const loop = async (slot: number): Promise<void> => {
    const slotLog = log.child({ slot });

    while (!controller.signal.aborted) {
      // One slot is enough to run the reaper; it is cheap and idempotent.
      if (slot === 0 && Date.now() - lastReapAt > REAP_INTERVAL_MS) {
        lastReapAt = Date.now();
        try {
          const reclaimed = await reclaimStalledJobs(STALL_TIMEOUT_MS);
          if (reclaimed > 0) slotLog.warn("worker.reclaimed_stalled_jobs", { reclaimed });
        } catch (error) {
          slotLog.error("worker.reaper_failed", { error });
        }
      }

      let job: SyncJob | null = null;
      try {
        job = await claimNextJob(workerId);
      } catch (error) {
        slotLog.error("worker.claim_failed", { error });
        await sleep(env.WORKER_POLL_INTERVAL_MS);
        continue;
      }

      if (!job) {
        await sleep(env.WORKER_POLL_INTERVAL_MS);
        continue;
      }

      const startedAt = Date.now();
      try {
        await execute(job, controller.signal);
        await completeJob(job.id);
        recordJob(job.type, "succeeded", Date.now() - startedAt);
        slotLog.info("job.succeeded", { jobId: job.id, type: job.type, durationMs: Date.now() - startedAt });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Only errors we classified as transient earn a retry; a bad OAuth
        // scope would just burn five attempts.
        const retryable = isAppError(error) ? error.retryable : true;
        const { status } = await failJob(job.id, message, { retryable });

        recordJob(job.type, status === "dead" ? "dead" : "failed", Date.now() - startedAt);
        slotLog.error("job.failed", {
          jobId: job.id,
          type: job.type,
          attempts: job.attempts,
          nextStatus: status,
          retryable,
          error,
        });
      }
    }
  };

  await Promise.all(Array.from({ length: env.WORKER_CONCURRENCY }, (_, slot) => loop(slot)));
  log.info("worker.stopped");
}
