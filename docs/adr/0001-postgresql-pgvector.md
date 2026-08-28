# ADR 001 — PostgreSQL + pgvector as the only datastore

**Status:** Accepted
**Date:** 2026-08-28

## Context

ContextBridge needs to store four kinds of data:

1. Relational records — organizations, users, memberships, integrations, documents.
2. Vector embeddings, searched by approximate nearest neighbour.
3. A job queue for asynchronous ingestion.
4. Full-text search, to complement vector search.

The obvious alternative is a dedicated vector database (Pinecone, Weaviate, Qdrant,
Chroma) alongside Postgres, plus Redis for the queue.

## Decision

Use **PostgreSQL with the pgvector extension** as the single datastore for all four.

Embeddings live in a `vector(1536)` column on `chunks`, indexed with HNSW under
`vector_cosine_ops`. Full-text search uses a GIN index over
`to_tsvector('english', content)`. The job queue is a table (ADR 003).

## Rationale

**One transactional boundary.** A document, its chunks and their embeddings are
written in a single transaction. With a separate vector store, that write is a
distributed one: the document commits, the vector upsert fails, and the system now
has a document that cannot be retrieved and no way to notice. Reconciling two stores
is a genuine ongoing cost, and it buys nothing at this scale.

**Metadata filtering is a join, not a feature request.** Every query filters by
`organization_id`, often by provider, and always excludes soft-deleted documents.
In Postgres that is a `WHERE` clause and a join. Dedicated vector stores support
metadata filters, but with their own query dialect, their own indexing rules, and
their own limits on filter cardinality — and the tenant filter, the one that must
never be wrong, would live outside the database that owns the tenants.

**Hybrid retrieval comes free.** Fusing vector search with full-text search
measurably improves recall (see ADR context in `src/server/retrieval/search.ts`).
With both arms in the same database, that fusion is one SQL statement. Across two
systems it becomes two round trips and application-side merging.

**pgvector is sufficient at the target scale.** HNSW in pgvector handles millions
of vectors with sub-100ms queries. A company knowledge base is typically 10⁴–10⁶
chunks. The scale at which a dedicated vector database wins is well beyond where
this system needs to be, and that threshold is a good problem to have later.

**Operational cost.** One database to back up, monitor, secure and pay for. For a
system whose value proposition is consolidating fragmented tools, running three
datastores would be its own small irony.

## Consequences

- The embedding dimension is fixed at 1536 in the schema, because pgvector indexes
  are dimension-bound. Every embedding provider must emit that width
  (`EMBEDDING_DIMENSIONS` in `src/server/db/schema.ts`). Changing it is a migration
  plus a re-embed, which is why `chunks.embedding_model` records what produced each
  vector.
- HNSW index builds are memory-hungry on large tables. At the point where index
  build time becomes painful, partitioning `chunks` by organization is the next
  step — deliberately not done now.
- Very large tenants sharing one HNSW index will eventually see recall pressure
  from the tenant filter being applied after the ANN scan. The mitigation
  (per-tenant partial indexes, or partitioning) is available without changing the
  application layer.
- If the system ever genuinely outgrows pgvector, the retrieval layer is a single
  module (`src/server/retrieval/search.ts`) behind one function. That is the seam
  where a dedicated vector store would be introduced.
