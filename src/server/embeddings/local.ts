import type { EmbeddingProvider } from "@/server/embeddings/types";
import { EMBEDDING_DIMENSIONS, l2Normalize } from "@/server/embeddings/types";

/**
 * A deterministic, dependency-free embedding provider.
 *
 * It is a signed hashing vectorizer over unigrams and bigrams: each term is
 * hashed to a dimension and a sign, term frequencies are damped, and the
 * result is L2-normalised. That gives real lexical similarity under cosine
 * distance — not semantic, but enough that retrieval genuinely works.
 *
 * Why it exists: dev setup, CI and the test-suite all run the full ingestion
 * and retrieval path with no API key, no network and no cost, and the results
 * are reproducible. Production points EMBEDDING_PROVIDER at a real model.
 */
const FNV_OFFSET_BASIS = 2166136261;
const FNV_PRIME = 16777619;

function fnv1a(text: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1 && token.length < 40);
}

function embedText(text: string, dimensions: number): number[] {
  const tokens = tokenize(text);
  const counts = new Map<string, number>();

  const add = (term: string): void => {
    counts.set(term, (counts.get(term) ?? 0) + 1);
  };
  for (let index = 0; index < tokens.length; index += 1) {
    add(tokens[index]!);
    // Bigrams give the vector a little word-order sensitivity.
    if (index + 1 < tokens.length) add(`${tokens[index]!}_${tokens[index + 1]!}`);
  }

  const vector = new Array<number>(dimensions).fill(0);
  for (const [term, count] of counts) {
    const hash = fnv1a(term);
    const bucket = hash % dimensions;
    const sign = (hash >>> 31) & 1 ? 1 : -1;
    // Sub-linear damping so a term repeated 50 times does not dominate.
    vector[bucket] = (vector[bucket] ?? 0) + sign * (1 + Math.log(count));
  }

  return l2Normalize(vector);
}

export function createLocalEmbeddingProvider(
  dimensions: number = EMBEDDING_DIMENSIONS,
): EmbeddingProvider {
  return {
    id: "local:hashing-v1",
    dimensions,
    maxBatchSize: 512,
    async embedDocuments(texts: string[]): Promise<number[][]> {
      return texts.map((text) => embedText(text, dimensions));
    },
    async embedQuery(text: string): Promise<number[]> {
      return embedText(text, dimensions);
    },
  };
}
