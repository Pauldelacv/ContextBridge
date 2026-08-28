import { describe, expect, it } from "vitest";
import { createLocalEmbeddingProvider } from "@/server/embeddings/local";
import { EMBEDDING_DIMENSIONS } from "@/server/embeddings/types";

const provider = createLocalEmbeddingProvider();

const cosine = (a: number[], b: number[]): number =>
  a.reduce((total, value, index) => total + value * (b[index] ?? 0), 0);

describe("local embedding provider", () => {
  it("emits vectors of exactly the schema dimension", async () => {
    const [vector] = await provider.embedDocuments(["hello world"]);
    expect(vector).toHaveLength(EMBEDDING_DIMENSIONS);
  });

  it("is deterministic", async () => {
    const [first] = await provider.embedDocuments(["the vacation policy is 25 days"]);
    const [second] = await provider.embedDocuments(["the vacation policy is 25 days"]);
    expect(first).toEqual(second);
  });

  it("produces unit vectors so cosine similarity is well defined", async () => {
    const [vector] = await provider.embedDocuments(["onboarding checklist for new engineers"]);
    expect(cosine(vector!, vector!)).toBeCloseTo(1, 5);
  });

  it("scores related text above unrelated text", async () => {
    const [target] = await provider.embedDocuments([
      "Employees get 25 days of paid vacation per year.",
    ]);
    const related = await provider.embedQuery("How many vacation days do employees get?");
    const unrelated = await provider.embedQuery("What is the Kubernetes ingress controller?");

    expect(cosine(target!, related)).toBeGreaterThan(cosine(target!, unrelated));
  });

  it("handles empty and symbol-only text without throwing", async () => {
    const vectors = await provider.embedDocuments(["", "!!! ???"]);
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toHaveLength(EMBEDDING_DIMENSIONS);
  });
});
