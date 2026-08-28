import { z } from "zod";
import { HttpStatusError, withRetry } from "@/server/http/retry";
import type { EmbeddingProvider } from "@/server/embeddings/types";
import { assertDimensions, l2Normalize } from "@/server/embeddings/types";

const ResponseSchema = z.object({
  data: z.array(z.object({ index: z.number().int(), embedding: z.array(z.number()) })),
});

const ENDPOINT = "https://api.voyageai.com/v1/embeddings";

/**
 * Voyage AI — Anthropic's recommended embedding vendor (the Claude API has no
 * embeddings endpoint of its own). `voyage-3-large` supports an explicit
 * output dimension, which is how it satisfies the schema's fixed-width vector
 * column.
 */
export function createVoyageEmbeddingProvider(
  apiKey: string,
  model = "voyage-3-large",
  dimensions = 1536,
): EmbeddingProvider {
  async function embed(texts: string[], inputType: "document" | "query"): Promise<number[][]> {
    return withRetry(
      async () => {
        const response = await fetch(ENDPOINT, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            input: texts,
            input_type: inputType,
            output_dimension: dimensions,
            truncation: true,
          }),
        });

        if (!response.ok) {
          const retryAfter = response.headers.get("retry-after");
          throw new HttpStatusError(
            response.status,
            `Voyage embeddings returned ${response.status}`,
            await response.text().catch(() => undefined),
            retryAfter ? Number(retryAfter) * 1000 : undefined,
          );
        }

        const parsed = ResponseSchema.parse(await response.json());
        // The API does not promise input order; sort by index before mapping back.
        const vectors = [...parsed.data]
          .sort((a, b) => a.index - b.index)
          .map((entry) => l2Normalize(entry.embedding));
        assertDimensions(vectors, dimensions, `voyage:${model}`);
        return vectors;
      },
      { label: "voyage.embeddings" },
    );
  }

  return {
    id: `voyage:${model}`,
    dimensions,
    maxBatchSize: 128,
    embedDocuments: (texts) => embed(texts, "document"),
    async embedQuery(text: string): Promise<number[]> {
      const [vector] = await embed([text], "query");
      if (!vector) throw new Error("Voyage returned no embedding for the query");
      return vector;
    },
  };
}
