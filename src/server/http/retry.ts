import { upstreamUnavailable } from "@/server/errors";
import type { Logger } from "@/server/logging/logger";

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  logger?: Logger;
  label?: string;
  /** Default: retry 429 and 5xx, plus network errors. */
  isRetryable?: (error: unknown) => boolean;
}

export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "HttpStatusError";
  }
}

export function defaultIsRetryable(error: unknown): boolean {
  if (error instanceof HttpStatusError) return error.status === 429 || error.status >= 500;
  // Undici/fetch network failures surface as plain TypeErrors.
  return error instanceof TypeError;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Exponential backoff with full jitter. Jitter matters here: without it, every
 * worker that hit the same provider rate limit retries in lockstep.
 */
export async function withRetry<T>(operation: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 4;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 15_000;
  const isRetryable = options.isRetryable ?? defaultIsRetryable;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !isRetryable(error)) break;

      // Honour Retry-After when the provider tells us how long to wait.
      const serverDelay = error instanceof HttpStatusError ? error.retryAfterMs : undefined;
      const backoff = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      const delay = serverDelay ?? Math.random() * backoff;

      options.logger?.warn("upstream.retry", {
        label: options.label,
        attempt,
        attempts,
        delayMs: Math.round(delay),
        error,
      });
      await sleep(delay);
    }
  }

  throw upstreamUnavailable(
    `${options.label ?? "Upstream request"} failed after ${attempts} attempts`,
    lastError,
  );
}
