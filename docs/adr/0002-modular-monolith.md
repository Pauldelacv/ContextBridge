# ADR 002 — Modular monolith, not microservices

**Status:** Accepted
**Date:** 2026-08-28

## Context

ContextBridge has parts that *look* like natural service boundaries: an integration
layer talking to third-party APIs, an ingestion pipeline, a retrieval layer, an LLM
layer, a web interface and a Slack interface. A microservice architecture would give
each its own deployable.

## Decision

Build a **modular monolith**: one Next.js application plus one worker process, both
running the same codebase, with module boundaries enforced in code rather than over
the network.

```
src/server/
  config/         env validation — the only reader of process.env
  db/             schema + connection
  auth/           sessions, passwords, tenant context
  integrations/   one directory per provider, behind SourceIntegration
  ingestion/      normalize → chunk → embed → store
  embeddings/     provider abstraction (voyage | openai | local)
  retrieval/      hybrid search, ranking, the ask path
  llm/            answer generation
  jobs/           queue + worker + handlers
  http/           route wrapper, retry, rate limiting
  observability/  metrics
```

The rule is that a module may depend on modules below it in the pipeline but not
above: `integrations` knows nothing about `retrieval`; `retrieval` knows nothing
about which provider a chunk came from.

## Rationale

**The boundaries are real; the network calls would not be.** Microservices buy
independent deployment, independent scaling and fault isolation. None of those are
needed here: there is one team, the whole system deploys together, and the only
component with a different scaling profile is the worker — which is already a
separate process reading the same queue table.

**They would cost the properties that matter most.** The multi-tenant guarantee is
that no query crosses an organization boundary. In-process, that is enforced by
every query carrying `organization_id` and by tests that assert it. Split across
services, it becomes a contract between services that has to be re-verified at every
hop. Similarly, ingestion writes a document, its chunks and its embeddings in one
transaction (ADR 001) — a split would make that a saga.

**The seams are already where they need to be.** `SourceIntegration` is the seam
for data sources, `EmbeddingProvider` for embeddings, `searchChunks` for retrieval.
If one of these ever needs to become a service, the interface already exists and the
extraction is mechanical. Building the network boundary *first*, before knowing
which side of it needs to scale, is the expensive order to do this in.

**Cost of being wrong is asymmetric.** Extracting a service from a well-factored
monolith is a known, bounded piece of work. Merging premature microservices back
together, after their schemas and deployment pipelines have diverged, is not.

## Consequences

- Two processes: `next start` (web) and `npm run worker` (ingestion). The worker can
  be scaled horizontally on its own — several workers share the queue safely via
  `FOR UPDATE SKIP LOCKED`.
- Module boundaries are a convention enforced by review and by the direction of
  imports, not by a compiler or a network. They can be violated by a careless import,
  which is the accepted cost.
- A slow ingestion run cannot starve the web process, because they are different
  processes, but they do share a database connection pool budget.
- Deployment is all-or-nothing: a change to the Slack formatter redeploys the
  retrieval layer too. At one-team scale this is a feature, not a cost.
