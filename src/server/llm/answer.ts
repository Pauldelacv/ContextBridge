import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { getEnv } from "@/server/config/env";
import { upstreamUnavailable } from "@/server/errors";
import { logger } from "@/server/logging/logger";
import { incrementCounter, observeDuration } from "@/server/observability/metrics";
import type { RetrievedChunk } from "@/server/retrieval/search";

export interface Citation {
  /** 1-based index into the sources shown to the model. */
  sourceNumber: number;
  chunkId: string;
  documentId: string;
  title: string;
  url: string | null;
  provider: string;
  excerpt: string;
}

export interface GeneratedAnswer {
  answer: string;
  citations: Citation[];
  /** True when retrieval found nothing usable and no model call was made. */
  abstained: boolean;
  model: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
}

/**
 * Frozen system prompt. Kept byte-stable and placed first so it stays a cache
 * prefix across every request — the volatile parts (sources, question) come
 * after it in the user turn.
 */
const SYSTEM_PROMPT = `You are ContextBridge, an assistant that answers questions using only a company's own internal documents.

You will receive numbered sources retrieved from the company's connected tools (Notion, Google Drive, Slack). Answer the user's question using those sources and nothing else.

Rules:
- Ground every factual claim in the provided sources. Never use outside knowledge to state a fact about this company.
- Cite the sources you used by their number. Cite only sources that genuinely support what you wrote.
- If the sources do not contain the answer, say so plainly and explain what is missing. Do not guess, and do not pad the answer with what the sources merely imply.
- If sources disagree, say so and present both, attributing each.
- Prefer the more recently updated source when two say different things about the same fact.
- Be concise and direct. Answer the question that was asked, in plain prose. Do not restate the question or describe your own process.
- Write for a colleague: no preamble, no "based on the provided sources".`;

const AnswerSchema = z.object({
  answer: z
    .string()
    .describe("The answer, in plain prose. Say plainly if the sources do not contain it."),
  citation_source_numbers: z
    .array(z.number().int())
    .describe("Numbers of the sources that directly support the answer. Empty if none do."),
  answered: z
    .boolean()
    .describe("True if the sources actually contained the answer; false if you had to abstain."),
});

let client: Anthropic | null = null;

function getClient(): Anthropic | null {
  const env = getEnv();
  if (!env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return client;
}

/** Renders retrieved chunks as the numbered source list the prompt refers to. */
export function formatSources(chunks: RetrievedChunk[]): string {
  return chunks
    .map((chunk, index) => {
      const trail = chunk.headingPath.length > 0 ? ` > ${chunk.headingPath.join(" > ")}` : "";
      const updated = chunk.sourceUpdatedAt
        ? ` | updated ${chunk.sourceUpdatedAt.toISOString().slice(0, 10)}`
        : "";
      return [
        `<source number="${index + 1}">`,
        `title: ${chunk.title}${trail}`,
        `origin: ${chunk.provider}${updated}`,
        chunk.url ? `url: ${chunk.url}` : "",
        "",
        chunk.content,
        `</source>`,
      ]
        .filter((line) => line !== "")
        .join("\n");
    })
    .join("\n\n");
}

function toCitations(sourceNumbers: number[], chunks: RetrievedChunk[]): Citation[] {
  const seen = new Set<number>();

  return sourceNumbers
    .filter((sourceNumber) => {
      // The model can hallucinate an index; drop anything out of range.
      if (sourceNumber < 1 || sourceNumber > chunks.length) return false;
      if (seen.has(sourceNumber)) return false;
      seen.add(sourceNumber);
      return true;
    })
    .map((sourceNumber) => {
      const chunk = chunks[sourceNumber - 1]!;
      return {
        sourceNumber,
        chunkId: chunk.chunkId,
        documentId: chunk.documentId,
        title: chunk.title,
        url: chunk.url,
        provider: chunk.provider,
        excerpt: chunk.content.slice(0, 320),
      };
    });
}

/**
 * Turns retrieved chunks into a cited answer.
 *
 * Citations are produced as structured output (source numbers) rather than
 * parsed out of prose, so they can be validated against what was actually
 * retrieved. A number the model invents for a source that does not exist is
 * dropped rather than shown to the user as a real reference.
 */
export async function generateAnswer(
  question: string,
  chunks: RetrievedChunk[],
): Promise<GeneratedAnswer> {
  if (chunks.length === 0) {
    return {
      answer:
        "I could not find anything about that in your connected sources. It may not be documented yet, or the source that holds it may not be connected.",
      citations: [],
      abstained: true,
      model: null,
      usage: null,
    };
  }

  const anthropic = getClient();
  if (!anthropic) {
    // Retrieval-only mode: without a key the app still returns ranked sources
    // rather than failing outright.
    logger.warn("llm.no_api_key");
    return {
      answer:
        "Answer generation is not configured on this deployment (ANTHROPIC_API_KEY is unset), so here are the most relevant passages from your sources.",
      citations: toCitations(
        chunks.slice(0, 3).map((_, index) => index + 1),
        chunks,
      ),
      abstained: true,
      model: null,
      usage: null,
    };
  }

  const env = getEnv();
  const startedAt = Date.now();

  try {
    const response = await anthropic.messages.parse({
      model: env.ANTHROPIC_MODEL,
      max_tokens: 16000,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: `Here are the sources retrieved for this question:\n\n${formatSources(chunks)}\n\nQuestion: ${question}`,
        },
      ],
      output_config: { format: zodOutputFormat(AnswerSchema) },
    });

    observeDuration("contextbridge_answer_duration_ms", Date.now() - startedAt, {}, "Answer latency");

    // A safety decline is a 200 with stop_reason "refusal" — check it before
    // reading content, which is empty in that case.
    if (response.stop_reason === "refusal") {
      incrementCounter("contextbridge_answers_total", { outcome: "refused" });
      return {
        answer:
          "I was not able to answer that question. Try rephrasing it, or ask about something else in your documentation.",
        citations: [],
        abstained: true,
        model: response.model,
        usage: null,
      };
    }

    const parsed = response.parsed_output;
    if (!parsed) throw new Error("Anthropic returned no parseable structured output");

    const citations = toCitations(parsed.citation_source_numbers, chunks);
    incrementCounter("contextbridge_answers_total", {
      outcome: parsed.answered ? "answered" : "abstained",
    });

    return {
      answer: parsed.answer,
      // An abstention with citations attached would be misleading.
      citations: parsed.answered ? citations : [],
      abstained: !parsed.answered,
      model: response.model,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  } catch (error) {
    incrementCounter("contextbridge_answers_total", { outcome: "error" });

    // Most specific first: the SDK gives a distinct class per status so
    // retryable and permanent failures stay distinguishable.
    if (error instanceof Anthropic.RateLimitError) {
      logger.warn("llm.rate_limited", { error });
      throw upstreamUnavailable("The answer service is rate limited — please try again shortly", error);
    }
    if (error instanceof Anthropic.AuthenticationError) {
      logger.error("llm.auth_failed", { error });
      throw upstreamUnavailable("Answer generation is misconfigured (invalid Anthropic API key)", error);
    }
    if (error instanceof Anthropic.APIConnectionError) {
      logger.error("llm.connection_failed", { error });
      throw upstreamUnavailable("Could not reach the answer service", error);
    }
    if (error instanceof Anthropic.APIError) {
      logger.error("llm.api_error", { error });
      throw upstreamUnavailable("The answer service returned an error", error);
    }
    throw error;
  }
}
