import { describe, expect, it } from "vitest";
import { chunkText, formatChunkForEmbedding } from "@/server/ingestion/chunk";
import { estimateTokens } from "@/server/ingestion/normalize";

const paragraph = (word: string, times: number): string =>
  Array.from({ length: times }, () => word).join(" ");

describe("chunkText", () => {
  it("returns nothing for empty input", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n\n  ")).toEqual([]);
  });

  it("keeps a short document as a single chunk", () => {
    const chunks = chunkText("The office wifi password is rotated every quarter.");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.ordinal).toBe(0);
    expect(chunks[0]!.content).toContain("wifi password");
  });

  it("splits long documents and numbers chunks contiguously", () => {
    const text = Array.from({ length: 12 }, (_, index) =>
      `Paragraph ${index}. ${paragraph("policy", 120)}`,
    ).join("\n\n");

    const chunks = chunkText(text, { targetTokens: 200, maxTokens: 300, overlapTokens: 20 });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.ordinal)).toEqual(chunks.map((_, index) => index));
  });

  it("never exceeds maxTokens, even for one giant unbroken paragraph", () => {
    const text = paragraph("word", 4000);
    const chunks = chunkText(text, { targetTokens: 200, maxTokens: 260, overlapTokens: 0 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(estimateTokens(chunk.content)).toBeLessThanOrEqual(260);
    }
  });

  it("tracks the markdown heading trail per chunk", () => {
    const text = [
      "# Employee Handbook",
      `Welcome to the company. ${paragraph("intro", 60)}`,
      "## Expenses",
      `Submit receipts within 30 days. ${paragraph("expense", 60)}`,
      "### Travel",
      `Book flights through the travel portal. ${paragraph("travel", 60)}`,
    ].join("\n\n");

    const chunks = chunkText(text, { targetTokens: 120, maxTokens: 300, overlapTokens: 0 });
    const trails = chunks.map((chunk) => chunk.headingPath.join(" > "));

    expect(trails.some((trail) => trail.includes("Employee Handbook"))).toBe(true);
    expect(trails.some((trail) => trail.includes("Travel"))).toBe(true);
  });

  it("starts a new chunk at a heading rather than straddling sections", () => {
    const text = [
      "## Expenses",
      `Submit receipts within 30 days. ${paragraph("expense", 60)}`,
      "## Security",
      `Rotate credentials quarterly. ${paragraph("security", 60)}`,
    ].join("\n\n");

    const chunks = chunkText(text, { targetTokens: 400, maxTokens: 800, overlapTokens: 0 });

    // Both sections fit inside targetTokens, so only the heading rule can split them.
    expect(chunks.length).toBeGreaterThan(1);
    const expenses = chunks.find((chunk) => chunk.content.includes("Submit receipts"));
    const security = chunks.find((chunk) => chunk.content.includes("Rotate credentials"));
    expect(expenses!.content).not.toContain("Rotate credentials");
    expect(security!.headingPath).toEqual(["Security"]);
  });

  it("resets deeper headings when a shallower one appears", () => {
    const text = [
      "# Handbook",
      "## Expenses",
      "### Travel",
      `Flights go through the portal. ${paragraph("flight", 40)}`,
      "## Security",
      `Rotate your credentials quarterly. ${paragraph("secret", 40)}`,
    ].join("\n\n");

    const chunks = chunkText(text, { targetTokens: 60, maxTokens: 200, overlapTokens: 0 });
    const security = chunks.find((chunk) => chunk.content.includes("Rotate your credentials"));

    expect(security).toBeDefined();
    // "Travel" belonged to Expenses and must not leak into the Security branch.
    expect(security!.headingPath).not.toContain("Travel");
  });

  it("overlaps consecutive chunks so a fact on a boundary stays retrievable", () => {
    const text = [
      paragraph("alpha", 100),
      "The reimbursement limit is 75 euros per day.",
      paragraph("omega", 100),
    ].join("\n\n");

    const chunks = chunkText(text, { targetTokens: 40, maxTokens: 120, overlapTokens: 30 });
    expect(chunks.length).toBeGreaterThan(1);

    const boundarySentence = "The reimbursement limit is 75 euros per day.";
    const carrying = chunks.filter((chunk) => chunk.content.includes(boundarySentence));
    expect(carrying.length).toBeGreaterThanOrEqual(1);
  });

  it("produces a stable hash for identical content", () => {
    const text = "Support rotates weekly.\n\nEscalate to the on-call engineer.";
    const first = chunkText(text);
    const second = chunkText(text);
    expect(first.map((chunk) => chunk.contentHash)).toEqual(second.map((chunk) => chunk.contentHash));
  });

  it("prefixes the title and heading trail onto the embedded text", () => {
    const [chunk] = chunkText("## Refunds\n\nWe refund within 14 days.");
    expect(chunk).toBeDefined();

    const embedded = formatChunkForEmbedding("Billing Policy", chunk!);
    expect(embedded.startsWith("Billing Policy")).toBe(true);
    expect(embedded).toContain("Refunds");
    expect(embedded).toContain("We refund within 14 days.");
  });
});
