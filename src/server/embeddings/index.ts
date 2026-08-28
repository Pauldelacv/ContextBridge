import { getEnv } from "@/server/config/env";
import { recordEmbedding } from "@/server/observability/metrics";
import { createLocalEmbeddingProvider } from "@/server/embeddings/local";
import { createOpenAiEmbeddingProvider } from "@/server/embeddings/openai";
import { createVoyageEmbeddingProvider } from "@/server/embeddings/voyage";
import { EMBEDDING_DIMENSIONS } from "@/server/embeddings/types";
import type { EmbeddingProvider } from "@/server/embeddings/types";

export type { EmbeddingProvider };
export { EMBEDDING_DIMENSIONS };

/** Wraps any provider so batching and metrics are not each vendor's problem. */
function instrument(provider: EmbeddingProvider): EmbeddingProvider {
  return {
    ...provider,
    async embedDocuments(texts: string[]): Promise<number[][]> {
      const results: number[][] = [];
      for (let offset = 0; offset < texts.length; offset += provider.maxBatchSize) {
        const batch = texts.slice(offset, offset + provider.maxBatchSize);
        const startedAt = Date.now();
        results.push(...(await provider.embedDocuments(batch)));
        recordEmbedding(
          provider.id,
          batch.reduce((total, text) => total + Math.ceil(text.length / 4), 0),
          Date.now() - startedAt,
        );
      }
      return results;
    },
  };
}

let cached: EmbeddingProvider | null = null;

export function getEmbeddingProvider(): EmbeddingProvider {
  if (cached) return cached;
  const env = getEnv();

  switch (env.EMBEDDING_PROVIDER) {
    case "voyage": {
      if (!env.VOYAGE_API_KEY) throw new Error("EMBEDDING_PROVIDER=voyage requires VOYAGE_API_KEY");
      cached = instrument(createVoyageEmbeddingProvider(env.VOYAGE_API_KEY));
      break;
    }
    case "openai": {
      if (!env.OPENAI_API_KEY) throw new Error("EMBEDDING_PROVIDER=openai requires OPENAI_API_KEY");
      cached = instrument(createOpenAiEmbeddingProvider(env.OPENAI_API_KEY));
      break;
    }
    default:
      cached = instrument(createLocalEmbeddingProvider());
  }
  return cached;
}

/** Test-only: allow a suite to inject a stub provider. */
export function setEmbeddingProvider(provider: EmbeddingProvider | null): void {
  cached = provider;
}
