/**
 * Token-bucket rate limiter.
 *
 * In-process only — deliberately. It protects a single worker from burning
 * through a provider's quota and shields the ask endpoint from one tenant
 * hammering it. A multi-instance deployment would move this to Redis or
 * Postgres; the interface below is what would be swapped.
 */
export interface RateLimiter {
  /** Resolves once a token is available. */
  acquire(): Promise<void>;
  /** Non-blocking variant: false when the caller should be rejected outright. */
  tryAcquire(): boolean;
}

export interface RateLimitOptions {
  /** Sustained rate. */
  tokensPerInterval: number;
  intervalMs: number;
  /** Burst size; defaults to the per-interval rate. */
  burst?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createRateLimiter(options: RateLimitOptions): RateLimiter {
  const capacity = options.burst ?? options.tokensPerInterval;
  const refillPerMs = options.tokensPerInterval / options.intervalMs;

  let tokens = capacity;
  let lastRefill = Date.now();

  const refill = (): void => {
    const now = Date.now();
    tokens = Math.min(capacity, tokens + (now - lastRefill) * refillPerMs);
    lastRefill = now;
  };

  return {
    tryAcquire(): boolean {
      refill();
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
    async acquire(): Promise<void> {
      for (;;) {
        refill();
        if (tokens >= 1) {
          tokens -= 1;
          return;
        }
        await sleep(Math.max(10, Math.ceil((1 - tokens) / refillPerMs)));
      }
    },
  };
}

const keyedLimiters = new Map<string, RateLimiter>();

/** Per-key limiter (e.g. one bucket per organization on the ask endpoint). */
export function getRateLimiter(key: string, options: RateLimitOptions): RateLimiter {
  let limiter = keyedLimiters.get(key);
  if (!limiter) {
    limiter = createRateLimiter(options);
    keyedLimiters.set(key, limiter);
  }
  return limiter;
}

/** Test-only: drop all keyed buckets. */
export function resetRateLimiters(): void {
  keyedLimiters.clear();
}
