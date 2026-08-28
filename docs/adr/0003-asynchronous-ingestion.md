# ADR 003 — Asynchronous ingestion on a Postgres-backed queue

**Status:** Accepted
**Date:** 2026-08-28

## Context

Connecting a data source triggers work that is slow, rate-limited and failure-prone:

- A Notion workspace of 5,000 pages is tens of thousands of API calls, because
  Notion returns block children one level at a time.
- Every provider imposes rate limits (Notion ~3 req/s, Slack ~50 req/min).
- Embedding thousands of chunks means many calls to an embedding API.
- Any of it can fail halfway: an expired token, a 429, a network blip, a deploy.

A full sync takes minutes to hours. It cannot run inside an HTTP request.

## Decision

Ingestion runs **asynchronously in background jobs**, on a queue implemented as a
Postgres table (`sync_jobs`) drained by a separate worker process.

Job claiming uses `FOR UPDATE SKIP LOCKED`:

```sql
UPDATE sync_jobs SET status = 'running', attempts = attempts + 1, locked_by = $1
WHERE id = (
  SELECT id FROM sync_jobs
  WHERE status = 'pending' AND run_at <= now()
  ORDER BY run_at ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
RETURNING *
```

## Rationale

**Why asynchronous.** An HTTP request cannot span an hour, and a user connecting
Notion should get a response immediately — "connected, syncing now" — not a spinner
tied to a request that will time out. Retrying is also only possible once the work
outlives the request that asked for it.

**Why a database queue rather than Redis/BullMQ or SQS.** The system already has a
transactional database it trusts (ADR 001). A queue table adds no new infrastructure,
no new failure mode, and no new thing to secure. It also gives properties a broker
would not, for free:

- *Enqueue is transactional with the data change that caused it.* Connecting an
  integration and queueing its first sync commit together, so there is no window
  where a source exists with no sync queued.
- *The queue is queryable.* The dashboard's "recent sync jobs" panel is a `SELECT`.
  With a broker it would need a separate status store, kept in sync.
- *Backups cover the queue.* Restoring the database restores in-flight work.

`FOR UPDATE SKIP LOCKED` is what makes this safe under concurrency: each worker
claims a row nobody else holds, and contention costs a skipped row rather than a
lock wait. Several workers can run against one table with no coordination.

**Why polling rather than LISTEN/NOTIFY.** A one-second poll is invisible to users
for work measured in minutes, and it has none of LISTEN/NOTIFY's reconnection and
missed-notification edge cases. The interval is configurable
(`WORKER_POLL_INTERVAL_MS`).

## Reliability properties

The queue is the place where "reliable ingestion" is actually made true:

- **Idempotency at enqueue.** Each job carries an idempotency key. A webhook
  redelivered three times, or a user clicking "Sync now" twice, collapses onto one
  pending job. A key whose job has already settled is revived rather than refused,
  so the same logical sync can run again later.
- **Idempotency at apply.** Every document goes through the hash-guarded pipeline,
  so replaying a page that was already applied writes nothing (see
  `src/server/ingestion/pipeline.ts`).
- **Resumability.** The provider cursor is persisted after *every page*, not at the
  end. A worker that dies 900 pages into a workspace resumes at page 900.
- **Retry with jittered exponential backoff.** Without jitter, everything that
  failed during one provider outage retries in lockstep and causes the next one.
- **Retryability is classified, not assumed.** A 429 or a 5xx is retryable; an
  invalid OAuth scope or an undecryptable credential is not, and dead-letters on the
  first attempt rather than burning five.
- **Dead-lettering, not silent dropping.** A job that exhausts its attempts becomes
  `dead` with its last error recorded and surfaces on the dashboard. Silently
  dropping it would let an integration stop syncing unnoticed — the worst outcome
  for a system whose value is being up to date.
- **Stall recovery.** A reaper returns jobs whose worker died mid-run (`locked_at`
  older than the stall timeout) to `pending`. Without it, a crashed worker's
  in-flight jobs stay `running` forever and that source silently stops syncing.

## Consequences

- Deployment needs a second process (`npm run worker`). A web-only deployment
  accepts jobs and never runs them — the dashboard makes that visible as jobs
  stuck in `pending`.
- Ingestion is eventually consistent: a document connected now is searchable in
  seconds to minutes. The UI says so rather than implying otherwise.
- At high job volume the polling workers add constant small query load. The path
  beyond that is LISTEN/NOTIFY or a broker; the `enqueueJob`/`claimNextJob`
  interface is where that swap would happen.
- In-process rate limiters (`src/server/http/rate-limit.ts`) protect one worker's
  view of a provider quota. Several workers against one tenant's Notion workspace
  would need a shared limiter; the interface anticipates that.
