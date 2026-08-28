import { sql } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import type { Database } from "@/server/db/client";
import type { IntegrationProvider } from "@/server/db/schema";
import { getEmbeddingProvider } from "@/server/embeddings";
import type { EmbeddingProvider } from "@/server/embeddings";
import { observeDuration } from "@/server/observability/metrics";

export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  provider: IntegrationProvider;
  title: string;
  url: string | null;
  content: string;
  ordinal: number;
  headingPath: string[];
  /** Cosine similarity in [0, 1]; higher is closer. */
  vectorScore: number;
  /** Postgres full-text rank, 0 when the row did not match lexically. */
  keywordScore: number;
  /** Fused score the results are ordered by. */
  score: number;
  sourceUpdatedAt: Date | null;
}

export interface SearchOptions {
  organizationId: string;
  query: string;
  limit?: number;
  /** Restrict to specific sources, e.g. only Notion. */
  providers?: IntegrationProvider[];
  /** Drop results below this fused score. */
  minScore?: number;
  /** Cap on chunks returned per document, so one page cannot fill the context. */
  maxPerDocument?: number;
  db?: Database;
  embeddings?: EmbeddingProvider;
}

interface SearchRow extends Record<string, unknown> {
  chunk_id: string;
  document_id: string;
  provider: IntegrationProvider;
  title: string;
  url: string | null;
  content: string;
  ordinal: number;
  metadata: Record<string, unknown> | null;
  vector_score: number | string;
  keyword_score: number | string;
  source_updated_at: Date | null;
}

/**
 * Reciprocal Rank Fusion constant. 60 is the value from the original RRF
 * paper and is deliberately large: it flattens the contribution of rank so a
 * result ranked 1st by one retriever cannot single-handedly win.
 */
const RRF_K = 60;

/**
 * Hybrid retrieval: vector search fused with Postgres full-text search.
 *
 * Vector search alone misses exact tokens — an error code, a policy number, a
 * person's surname — because embeddings smooth them away. Keyword search alone
 * misses paraphrase. Fusing both ranks with RRF costs one extra CTE and
 * measurably improves recall on the queries employees actually type.
 *
 * Tenant isolation is not a filter applied afterwards: `organization_id` is in
 * the WHERE clause of both retrieval arms, so a row from another tenant is
 * never a candidate in the first place.
 */
export async function searchChunks(options: SearchOptions): Promise<RetrievedChunk[]> {
  const db = options.db ?? getDb();
  const embeddings = options.embeddings ?? getEmbeddingProvider();
  const limit = options.limit ?? 12;
  const maxPerDocument = options.maxPerDocument ?? 3;
  const providers = options.providers ?? [];

  const trimmed = options.query.trim();
  if (trimmed.length === 0) return [];

  const startedAt = Date.now();
  const queryVector = await embeddings.embedQuery(trimmed);
  // pgvector's text input format.
  const vectorLiteral = `[${queryVector.join(",")}]`;

  // Over-fetch from each arm so fusion has something to work with.
  const candidateLimit = Math.max(limit * 4, 40);

  // Bind each provider as its own parameter: passing a JS array as a single
  // bind produces a malformed Postgres array literal.
  const providerFilter =
    providers.length > 0
      ? sql`AND d.provider IN (${sql.join(
          providers.map((provider) => sql`${provider}`),
          sql`, `,
        )})`
      : sql``;

  const result = await db.execute<SearchRow>(sql`
    WITH vector_candidates AS (
      SELECT
        c.id,
        row_number() OVER (ORDER BY c.embedding <=> ${vectorLiteral}::vector) AS rank,
        1 - (c.embedding <=> ${vectorLiteral}::vector) AS score
      FROM chunks c
      JOIN documents d ON d.id = c.document_id
      WHERE c.organization_id = ${options.organizationId}
        AND c.embedding IS NOT NULL
        AND d.deleted_at IS NULL
        ${providerFilter}
      ORDER BY c.embedding <=> ${vectorLiteral}::vector
      LIMIT ${candidateLimit}
    ),
    keyword_candidates AS (
      SELECT
        c.id,
        row_number() OVER (
          ORDER BY ts_rank_cd(to_tsvector('english', c.content), plainto_tsquery('english', ${trimmed})) DESC
        ) AS rank,
        ts_rank_cd(to_tsvector('english', c.content), plainto_tsquery('english', ${trimmed})) AS score
      FROM chunks c
      JOIN documents d ON d.id = c.document_id
      WHERE c.organization_id = ${options.organizationId}
        AND d.deleted_at IS NULL
        AND to_tsvector('english', c.content) @@ plainto_tsquery('english', ${trimmed})
        ${providerFilter}
      ORDER BY score DESC
      LIMIT ${candidateLimit}
    ),
    fused AS (
      SELECT
        COALESCE(v.id, k.id) AS id,
        COALESCE(v.score, 0) AS vector_score,
        COALESCE(k.score, 0) AS keyword_score,
        COALESCE(1.0 / (${RRF_K} + v.rank), 0) + COALESCE(1.0 / (${RRF_K} + k.rank), 0) AS fused_score
      FROM vector_candidates v
      FULL OUTER JOIN keyword_candidates k ON k.id = v.id
    )
    SELECT
      c.id                AS chunk_id,
      c.document_id       AS document_id,
      d.provider          AS provider,
      d.title             AS title,
      d.url               AS url,
      c.content           AS content,
      c.ordinal           AS ordinal,
      c.metadata          AS metadata,
      f.vector_score      AS vector_score,
      f.keyword_score     AS keyword_score,
      d.source_updated_at AS source_updated_at
    FROM fused f
    JOIN chunks c ON c.id = f.id
    JOIN documents d ON d.id = c.document_id
    WHERE c.organization_id = ${options.organizationId}
    ORDER BY f.fused_score DESC
    LIMIT ${candidateLimit}
  `);

  observeDuration("contextbridge_retrieval_duration_ms", Date.now() - startedAt, {}, "Retrieval latency");

  const rows = result.rows.map((row) => {
    const metadata = (row.metadata ?? {}) as { headingPath?: unknown };
    const vectorScore = Number(row.vector_score);
    const keywordScore = Number(row.keyword_score);

    return {
      chunkId: row.chunk_id,
      documentId: row.document_id,
      provider: row.provider,
      title: row.title,
      url: row.url,
      content: row.content,
      ordinal: row.ordinal,
      headingPath: Array.isArray(metadata.headingPath) ? (metadata.headingPath as string[]) : [],
      vectorScore,
      keywordScore,
      // Presented score: cosine similarity is the interpretable one, lifted a
      // little when the keyword arm agrees.
      score: vectorScore + (keywordScore > 0 ? 0.05 : 0),
      sourceUpdatedAt: row.source_updated_at,
    } satisfies RetrievedChunk;
  });

  return diversify(rows, limit, maxPerDocument, options.minScore);
}

/**
 * Caps how many chunks any single document contributes.
 *
 * Without this, a long document that is broadly on-topic crowds out a short
 * one that answers the question exactly — and the answer gets worse while the
 * scores look fine.
 *
 * The cap is hard: when it binds, this returns fewer results rather than
 * topping up from the document it just limited. Backfilling would hand the
 * context window straight back to the document the cap exists to contain.
 */
function diversify(
  rows: RetrievedChunk[],
  limit: number,
  maxPerDocument: number,
  minScore?: number,
): RetrievedChunk[] {
  const perDocument = new Map<string, number>();
  const selected: RetrievedChunk[] = [];

  for (const row of rows) {
    if (minScore !== undefined && row.score < minScore) continue;

    const used = perDocument.get(row.documentId) ?? 0;
    if (used >= maxPerDocument) continue;

    perDocument.set(row.documentId, used + 1);
    selected.push(row);
    if (selected.length === limit) break;
  }

  return selected;
}
