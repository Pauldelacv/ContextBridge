import { EMBEDDING_DIMENSIONS } from "@/server/db/schema";

export { EMBEDDING_DIMENSIONS };

/**
 * The seam between the ingestion/retrieval layers and whichever embedding
 * vendor is configured. Nothing above this interface knows a vendor name.
 *
 * `embedDocuments` and `embedQuery` are separate because good embedding models
 * are asymmetric: they encode a passage and a question differently, and using
 * the wrong side measurably hurts recall.
 */
export interface EmbeddingProvider {
  /** Stable identifier stored on each chunk, e.g. "voyage:voyage-3-large". */
  readonly id: string;
  readonly dimensions: number;
  /** Largest batch the provider accepts in one call. */
  readonly maxBatchSize: number;
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}

export function assertDimensions(vectors: number[][], expected: number, providerId: string): void {
  for (const vector of vectors) {
    if (vector.length !== expected) {
      throw new Error(
        `Embedding provider ${providerId} returned ${vector.length} dimensions, expected ${expected}`,
      );
    }
  }
}

/** Cosine similarity assumes unit vectors; normalising once here keeps it true. */
export function l2Normalize(vector: number[]): number[] {
  let sumOfSquares = 0;
  for (const value of vector) sumOfSquares += value * value;
  if (sumOfSquares === 0) return vector;
  const norm = Math.sqrt(sumOfSquares);
  return vector.map((value) => value / norm);
}
