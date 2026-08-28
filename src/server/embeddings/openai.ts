import { z } from "zod";
import { HttpStatusError, withRetry } from "@/server/http/retry";
import type { EmbeddingProvider } from "@/server/embeddings/types";
import { assertDimensions, l2Normalize } from "@/server/embeddings/types";

const ResponseSchema = z.object({
  data: z.array(z.object({ index: z.number().int(), embedding: z.array(z.number()) })),
});

const ENDPOINT = "https://api.openai.com/v1/embeddings";

/**
 * OpenAI embeddings. `text-embedding-3-small` is natively 1536-dimensional,
 * matching the schema contract without a projection step. Its embeddings are
 * symmetric, so queries and documents share one code path.
 */
export function createOpenAiEmbeddingProvider(
  apiKey: string,
  model = "text-embedding-3-small",
  dimensions = 1536,
): EmbeddingProvider {
  async function embed(texts: string[]): Promise<number[][]> {
    return withRetry(
      async () => {
        const response = await fetch(ENDPOINT, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ model, input: texts, dimensions }),
        });

        if (!response.ok) {
          const retryAfter = response.headers.get("retry-after");
          throw new HttpStatusError(
            response.status,
            `OpenAI embeddings returned ${response.status}`,
            await response.text().catch(() => undefined),
            retryAfter ? Number(retryAfter) * 1000 : undefined,
          );
        }

        const parsed = ResponseSchema.parse(await response.json());
        const vectors = [...parsed.data]
          .sort((a, b) => a.index - b.index)
          .map((entry) => l2Normalize(entry.embedding));
        assertDimensions(vectors, dimensions, `openai:${model}`);
        return vectors;
      },
      { label: "openai.embeddings" },
    );
  }

  return {
    id: `openai:${model}`,
    dimensions,
    maxBatchSize: 128,
    embedDocuments: embed,
    async embedQuery(text: string): Promise<number[]> {
      const [vector] = await embed([text]);
      if (!vector) throw new Error("OpenAI returned no embedding for the query");
      return vector;
    },
  };
}
