# ContextBridge

**An AI knowledge layer that connects fragmented company knowledge.**

Companies already have the answers — in Notion, in Google Drive, in a Slack thread
from four months ago. The information exists; it is just fragmented. ContextBridge
ingests those sources into one searchable layer and answers questions against it,
with citations back to the document the answer came from.

```
    Notion        Google Drive        Slack
      │                │                │
      └────────────────┼────────────────┘
                       ▼
              Integration Layer          OAuth · API clients · rate limits · retries
                       ▼
              Ingestion Pipeline         fetch · normalize · dedupe · chunk · embed
                       ▼
            PostgreSQL + pgvector        documents · chunks · vectors · job queue
                       ▼
               Retrieval Layer           tenant filter · hybrid search · ranking
                       ▼
                     Claude              grounded answer + validated citations
                       ▼
            Web  ·  Slack (/contextbridge)
```

---

## Quick start

Requires Node 20+ and Docker (or a local PostgreSQL 16 with pgvector).

```bash
git clone <this repo> && cd ContextBridge
npm install
cp .env.example .env

docker compose up -d          # PostgreSQL 16 + pgvector
npm run db:migrate            # apply schema
npm run db:seed               # demo org with content across all three sources

npm run dev                   # web app on http://localhost:3000
npm run worker                # ingestion worker (separate terminal)
```

Sign in with **`demo@contextbridge.dev` / `contextbridge-demo`** and ask something
like *"How much can I expense for a client dinner?"*.

Nothing above needs an API key. The default embedding provider is a deterministic
local one, so the whole ingestion and retrieval path runs offline. Set
`ANTHROPIC_API_KEY` to turn on answer generation; without it the app returns ranked
source passages instead of a synthesised answer.

---

## What this demonstrates

| Concern | Where it lives |
|---|---|
| Third-party integration | `src/server/integrations/{notion,google-drive,slack}` |
| OAuth + credential handling | `integrations/service.ts`, `integrations/credentials.ts` |
| Reliable ingestion | `src/server/ingestion/pipeline.ts` |
| Asynchronous workflows | `src/server/jobs/` (ADR 003) |
| Multi-tenancy | `db/schema.ts`, `auth/session.ts` (ADR 004) |
| Vector search + retrieval | `src/server/retrieval/search.ts` |
| Synchronization & updates | `jobs/handlers/sync.ts` |
| Usable interface | `src/app/`, `src/components/` |
| Production concerns | logging, metrics, health, rate limits, error taxonomy |

Architecture decisions are recorded in [`docs/adr/`](docs/adr/):

- [ADR 001 — PostgreSQL + pgvector](docs/adr/0001-postgresql-pgvector.md)
- [ADR 002 — Modular monolith](docs/adr/0002-modular-monolith.md)
- [ADR 003 — Asynchronous ingestion](docs/adr/0003-asynchronous-ingestion.md)
- [ADR 004 — Multi-tenancy strategy](docs/adr/0004-multi-tenancy.md)

---

## How it works

### Ingestion is idempotent by design

Re-running a sync on unchanged content is cheap and writes nothing. Two hashes do
the work:

- A **document hash** over title, URL and body short-circuits the whole run when
  nothing changed upstream. A rename counts as a change, because it is one.
- **Per-chunk hashes** let an edit to one paragraph of a long page re-embed only
  that paragraph. Everything untouched keeps its existing vector — provided the
  embedding model has not changed, which is why `chunks.embedding_model` is stored.

Deletions are handled two ways: providers with a change feed report them directly,
and a full sync reconciles by comparing what it saw against what is stored, since
anything the source no longer mentions is gone.

### Chunking is structure-aware

Chunking is where retrieval quality is won or lost. The chunker packs whole
paragraphs up to a token target, breaks at Markdown headings (a natural section
boundary), tracks a depth-indexed heading trail, and carries a sentence-aligned
overlap so a fact spanning a boundary stays retrievable from either side. Each
chunk is embedded with its document title and heading trail prefixed, so an orphaned
sentence — *"It renews annually."* — still carries the subject it belongs to.

### Retrieval is hybrid

Vector search alone misses exact tokens: error codes, policy numbers, surnames.
Keyword search alone misses paraphrase. ContextBridge runs both — pgvector cosine
similarity and Postgres full-text search — and fuses the rankings with Reciprocal
Rank Fusion. A per-document cap stops one long page from filling the context window
and crowding out the short document that actually answers the question.

### Answers are grounded and citations are verified

The model returns its citations as structured output — source numbers, not prose —
so they can be checked against what was actually retrieved. A number pointing at a
source that does not exist is dropped rather than shown as a real reference. The
prompt instructs abstention when the sources do not contain the answer, and an
abstention is never dressed up with citations.

### Tenancy is enforced in the query

Every tenant-owned row carries `organization_id`. The tenant comes from the signed
session cookie, never from the request — no endpoint accepts an organization id, so
there is no field in which to ask for someone else's data. Both arms of retrieval
carry the filter in their own `WHERE` clause, so another tenant's row is never a
candidate. This is covered by a test where two organizations hold contradictory
answers to the same question.

---

## Adding a data source

Implement `SourceIntegration` (`src/server/integrations/types.ts`) and add one line
to the registry. Nothing else changes — normalization, chunking, embedding, storage,
retrieval and the UI are all provider-agnostic.

```ts
export interface SourceIntegration {
  readonly provider: IntegrationProvider;
  readonly supportsIncrementalSync: boolean;
  isConfigured(): boolean;
  buildAuthorizationUrl(state: string): string;
  completeAuthorization(code: string): Promise<IntegrationConnection>;
  // Yields pages; the driver checkpoints the cursor after each one.
  sync(context: SyncContext): AsyncGenerator<SyncPage, void, undefined>;
}
```

The generator shape is what makes syncs resumable: a worker that dies 900 pages into
a workspace resumes at page 900 rather than starting over.

---

## Configuration

Every variable is validated at startup by `src/server/config/env.ts` — the only
module that reads `process.env`. See `.env.example` for the full list.

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL with pgvector |
| `SESSION_SECRET` | Signs session cookies |
| `CREDENTIAL_SECRET` | Encrypts stored OAuth tokens (AES-256-GCM) |
| `EMBEDDING_PROVIDER` | `local` (default, offline) · `voyage` · `openai` |
| `ANTHROPIC_API_KEY` | Enables answer generation; retrieval-only without it |
| `NOTION_*`, `GOOGLE_*`, `SLACK_*` | Per-connector OAuth credentials |

Connectors without credentials are shown in the UI as unavailable rather than
failing at connect time.

> `CREDENTIAL_SECRET` is not rotatable in place: stored tokens are encrypted under
> it, and changing it makes existing integrations undecryptable. The system detects
> this and reports it as a non-retryable error telling you to reconnect the source,
> rather than retrying forever.

### Embedding providers

`local` is a deterministic signed hashing vectorizer over unigrams and bigrams. It
gives real lexical similarity under cosine distance — not semantic, but enough that
retrieval genuinely works — so dev, CI and the test suite run the full path with no
API key, no network and no cost, reproducibly. Production points
`EMBEDDING_PROVIDER` at Voyage or OpenAI. All three emit 1536 dimensions, which the
schema requires because pgvector indexes are dimension-bound.

---

## Slack interface

Point a slash command at `POST /api/slack/command`. Requests are verified by HMAC
signature with a five-minute replay window.

Slack allows three seconds before showing the user a timeout, which retrieval plus
generation does not fit in — so the handler acknowledges immediately and posts the
cited answer to `response_url` when it is ready. The Slack team id is what maps an
inbound command to its tenant.

---

## Operations

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Liveness **and** a real Postgres + pgvector check |
| `GET /api/metrics` | Prometheus exposition — requests, jobs, ingestion, retrieval and answer latency |

Logs are structured JSON, one line per event, with a bound context (request id,
organization, job id) carried through a request or job. Every question is logged
with the chunks it retrieved — successes and failures alike — which is what makes
answer quality reviewable after the fact.

---

## Tests

```bash
npm test          # 73 tests
npm run typecheck
```

Tests run against real PostgreSQL and pgvector rather than mocks, because the things
most worth testing here — HNSW search, `FOR UPDATE SKIP LOCKED`, transactional
ingestion, tenant isolation — are database behaviour. Set `TEST_DATABASE_URL` to
point at a scratch database (defaults to `contextbridge_test`).

What they cover: structure-aware chunking and heading trails; idempotent ingestion
and embedding reuse; deletion and reconciliation; hybrid retrieval, provider
filtering and the per-document cap; **cross-tenant isolation, with two organizations
holding contradictory answers to the same question**; queue idempotency,
`SKIP LOCKED` handing one job to exactly one of several racing workers, backoff,
dead-lettering and stall recovery; per-page cursor checkpointing so a mid-sync crash
resumes; password hashing, credential-tampering detection, session-cookie forgery,
OAuth state re-pointing, Slack signature and replay windows, and immediate effect of
membership revocation.

---

## Deliberate limits

Things a production deployment would need that are consciously not here:

- **Postgres RLS is not enabled.** Tenant isolation is enforced in the application
  and tested; RLS would move it into the database. Deferred because it needs careful
  handling around connection pooling — see ADR 004.
- **Rate limiters are in-process.** They protect one worker from a provider's quota
  and one endpoint from one tenant. A multi-instance deployment needs a shared
  limiter; the interface anticipates it.
- **No webhook receivers.** Sync is polling-based and incremental. Notion, Drive and
  Slack all offer push; the job queue already has the idempotency to accept it.
- **No re-embedding migration.** Changing embedding model invalidates stored vectors.
  `chunks.embedding_model` records which model produced each one, so the backfill is
  writable — it just is not written.
- **No answer-quality evaluation harness.** Query logs capture what was retrieved and
  what was answered, which is the raw material for one.
