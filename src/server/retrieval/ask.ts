import { z } from "zod";
import { getDb } from "@/server/db/client";
import { queryLogs } from "@/server/db/schema";
import type { IntegrationProvider } from "@/server/db/schema";
import { rateLimited } from "@/server/errors";
import { getRateLimiter } from "@/server/http/rate-limit";
import { logger } from "@/server/logging/logger";
import { generateAnswer } from "@/server/llm/answer";
import type { Citation } from "@/server/llm/answer";
import { searchChunks } from "@/server/retrieval/search";
import type { RetrievedChunk } from "@/server/retrieval/search";

export const AskInput = z.object({
  question: z.string().trim().min(3, "Ask a slightly longer question").max(1000),
  providers: z.array(z.enum(["notion", "google_drive", "slack"])).optional(),
  limit: z.number().int().min(1).max(25).optional(),
});
export type AskInput = z.infer<typeof AskInput>;

export interface AskResult {
  question: string;
  answer: string;
  citations: Citation[];
  sources: Array<{
    chunkId: string;
    documentId: string;
    title: string;
    url: string | null;
    provider: IntegrationProvider;
    excerpt: string;
    score: number;
  }>;
  abstained: boolean;
  latencyMs: number;
  queryLogId: string | null;
}

export interface AskContext {
  organizationId: string;
  userId?: string | null;
  surface: "web" | "slack";
}

/**
 * One tenant should not be able to exhaust the answer budget for everyone
 * else, and a runaway script should not run up an API bill. 30 questions a
 * minute is far above human use and far below either failure mode.
 */
function assertWithinRateLimit(organizationId: string): void {
  const limiter = getRateLimiter(`ask:${organizationId}`, {
    tokensPerInterval: 30,
    intervalMs: 60_000,
    burst: 10,
  });
  if (!limiter.tryAcquire()) {
    throw rateLimited("Too many questions in a short period — please wait a moment");
  }
}

/**
 * The end-to-end question path: retrieve, generate, log.
 *
 * Every query is logged with the chunks it retrieved, which is what makes
 * answer quality reviewable after the fact — without it, "the answer was
 * wrong" is unfalsifiable.
 */
export async function ask(input: AskInput, context: AskContext): Promise<AskResult> {
  assertWithinRateLimit(context.organizationId);

  const startedAt = Date.now();
  const log = logger.child({ organizationId: context.organizationId, surface: context.surface });

  let chunks: RetrievedChunk[] = [];
  try {
    chunks = await searchChunks({
      organizationId: context.organizationId,
      query: input.question,
      limit: input.limit ?? 10,
      providers: input.providers,
    });

    const generated = await generateAnswer(input.question, chunks);
    const latencyMs = Date.now() - startedAt;

    const [logged] = await getDb()
      .insert(queryLogs)
      .values({
        organizationId: context.organizationId,
        userId: context.userId ?? null,
        surface: context.surface,
        question: input.question,
        answer: generated.answer,
        citations: generated.citations,
        retrievedChunkIds: chunks.map((chunk) => chunk.chunkId),
        latencyMs,
      })
      .returning({ id: queryLogs.id });

    log.info("ask.completed", {
      latencyMs,
      retrieved: chunks.length,
      cited: generated.citations.length,
      abstained: generated.abstained,
    });

    return {
      question: input.question,
      answer: generated.answer,
      citations: generated.citations,
      sources: chunks.map((chunk) => ({
        chunkId: chunk.chunkId,
        documentId: chunk.documentId,
        title: chunk.title,
        url: chunk.url,
        provider: chunk.provider,
        excerpt: chunk.content.slice(0, 320),
        score: Number(chunk.score.toFixed(4)),
      })),
      abstained: generated.abstained,
      latencyMs,
      queryLogId: logged?.id ?? null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Failures are logged as queries too: an error rate is only visible if
    // the failures land in the same place as the successes.
    await getDb()
      .insert(queryLogs)
      .values({
        organizationId: context.organizationId,
        userId: context.userId ?? null,
        surface: context.surface,
        question: input.question,
        answer: null,
        citations: [],
        retrievedChunkIds: chunks.map((chunk) => chunk.chunkId),
        latencyMs: Date.now() - startedAt,
        error: message.slice(0, 2000),
      })
      .catch(() => undefined);

    log.error("ask.failed", { error });
    throw error;
  }
}
