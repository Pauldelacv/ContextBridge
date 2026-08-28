import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb } from "@/server/db/client";
import { organizations, syncJobs } from "@/server/db/schema";
import {
  buildIdempotencyKey,
  claimNextJob,
  completeJob,
  enqueueJob,
  failJob,
  reclaimStalledJobs,
} from "@/server/jobs/queue";
import { resetDatabase } from "./helpers/db";

const db = getDb();

async function seedOrganization(): Promise<string> {
  const [organization] = await db
    .insert(organizations)
    .values({ name: "Queue Co", slug: `queue-${Math.random().toString(36).slice(2, 8)}` })
    .returning({ id: organizations.id });
  return organization!.id;
}

describe("sync job queue", () => {
  let organizationId: string;

  beforeEach(async () => {
    await resetDatabase();
    organizationId = await seedOrganization();
  });

  afterAll(async () => {
    await closeDb();
  });

  it("enqueues a job", async () => {
    const { job, deduplicated } = await enqueueJob({
      organizationId,
      type: "integration.full_sync",
      idempotencyKey: buildIdempotencyKey(["sync", "abc", "full"]),
    });

    expect(deduplicated).toBe(false);
    expect(job?.status).toBe("pending");
    expect(job?.attempts).toBe(0);
  });

  it("collapses duplicate enqueues while a job is still pending", async () => {
    const key = buildIdempotencyKey(["sync", "abc", "full"]);

    const first = await enqueueJob({ organizationId, type: "integration.full_sync", idempotencyKey: key });
    const second = await enqueueJob({ organizationId, type: "integration.full_sync", idempotencyKey: key });
    const third = await enqueueJob({ organizationId, type: "integration.full_sync", idempotencyKey: key });

    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(third.deduplicated).toBe(true);

    const rows = await db.select().from(syncJobs).where(eq(syncJobs.organizationId, organizationId));
    expect(rows).toHaveLength(1);
  });

  it("revives a settled job under the same key instead of refusing forever", async () => {
    const key = buildIdempotencyKey(["sync", "abc", "full"]);

    const { job } = await enqueueJob({ organizationId, type: "integration.full_sync", idempotencyKey: key });
    await completeJob(job!.id);

    // A later manual sync must be able to run again.
    const revived = await enqueueJob({
      organizationId,
      type: "integration.full_sync",
      idempotencyKey: key,
    });

    expect(revived.deduplicated).toBe(false);
    expect(revived.job?.status).toBe("pending");
    expect(revived.job?.attempts).toBe(0);
    expect(revived.job?.id).toBe(job!.id);
  });

  it("hands one job to exactly one worker", async () => {
    await enqueueJob({
      organizationId,
      type: "integration.full_sync",
      idempotencyKey: buildIdempotencyKey(["one"]),
    });

    // Two workers racing for a single job: SKIP LOCKED must give it to one.
    const [a, b] = await Promise.all([claimNextJob("worker-a"), claimNextJob("worker-b")]);

    const claimed = [a, b].filter((job) => job !== null);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.status).toBe("running");
    expect(claimed[0]!.attempts).toBe(1);
  });

  it("distributes several jobs across concurrent workers without overlap", async () => {
    for (let index = 0; index < 6; index += 1) {
      await enqueueJob({
        organizationId,
        type: "integration.incremental_sync",
        idempotencyKey: buildIdempotencyKey(["job", index]),
      });
    }

    const claims = await Promise.all(
      Array.from({ length: 6 }, (_, index) => claimNextJob(`worker-${index}`)),
    );

    const ids = claims.filter((job) => job !== null).map((job) => job!.id);
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
  });

  it("does not claim a job scheduled for the future", async () => {
    await enqueueJob({
      organizationId,
      type: "integration.full_sync",
      idempotencyKey: buildIdempotencyKey(["later"]),
      runAt: new Date(Date.now() + 60_000),
    });

    expect(await claimNextJob("worker-a")).toBeNull();
  });

  it("reschedules a retryable failure with backoff", async () => {
    const { job } = await enqueueJob({
      organizationId,
      type: "integration.full_sync",
      idempotencyKey: buildIdempotencyKey(["retry"]),
    });
    const claimed = await claimNextJob("worker-a");

    const { status } = await failJob(claimed!.id, "upstream timed out", { retryable: true });
    expect(status).toBe("pending");

    const [row] = await db.select().from(syncJobs).where(eq(syncJobs.id, job!.id));
    expect(row!.attempts).toBe(1);
    expect(row!.lastError).toBe("upstream timed out");
    // Backoff pushes run_at into the future, so it is not immediately reclaimed.
    expect(row!.runAt.getTime()).toBeGreaterThan(Date.now());
    expect(await claimNextJob("worker-b")).toBeNull();
  });

  it("dead-letters a non-retryable failure immediately", async () => {
    await enqueueJob({
      organizationId,
      type: "integration.full_sync",
      idempotencyKey: buildIdempotencyKey(["fatal"]),
    });
    const claimed = await claimNextJob("worker-a");

    const { status } = await failJob(claimed!.id, "invalid oauth scope", { retryable: false });

    expect(status).toBe("dead");
    const [row] = await db.select().from(syncJobs).where(eq(syncJobs.id, claimed!.id));
    expect(row!.status).toBe("dead");
    expect(row!.completedAt).not.toBeNull();
  });

  it("dead-letters once attempts are exhausted", async () => {
    const { job } = await enqueueJob({
      organizationId,
      type: "integration.full_sync",
      idempotencyKey: buildIdempotencyKey(["exhaust"]),
      maxAttempts: 2,
    });

    // Attempt 1: retryable, so it goes back to pending.
    await claimNextJob("worker-a");
    expect((await failJob(job!.id, "boom", { retryable: true })).status).toBe("pending");

    // Make it due again, then burn the last attempt.
    await db.update(syncJobs).set({ runAt: new Date() }).where(eq(syncJobs.id, job!.id));
    await claimNextJob("worker-a");
    expect((await failJob(job!.id, "boom", { retryable: true })).status).toBe("dead");
  });

  it("reclaims jobs abandoned by a crashed worker", async () => {
    await enqueueJob({
      organizationId,
      type: "integration.full_sync",
      idempotencyKey: buildIdempotencyKey(["stalled"]),
    });
    const claimed = await claimNextJob("worker-that-died");

    // Nothing to reclaim while the lock is fresh.
    expect(await reclaimStalledJobs(15 * 60 * 1000)).toBe(0);

    // Simulate the worker having held the lock for an hour.
    await db
      .update(syncJobs)
      .set({ lockedAt: sql`now() - interval '1 hour'` })
      .where(eq(syncJobs.id, claimed!.id));

    expect(await reclaimStalledJobs(15 * 60 * 1000)).toBe(1);

    const requeued = await claimNextJob("worker-b");
    expect(requeued?.id).toBe(claimed!.id);
    expect(requeued?.lockedBy).toBe("worker-b");
  });
});
