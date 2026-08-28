/**
 * Application error taxonomy. Route handlers translate these into HTTP
 * responses in exactly one place (`src/server/http/handler.ts`), so no route
 * needs its own try/catch ladder.
 */
export type AppErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "validation_failed"
  | "conflict"
  | "rate_limited"
  | "upstream_unavailable"
  | "internal";

const STATUS_BY_CODE: Record<AppErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 422,
  conflict: 409,
  rate_limited: 429,
  upstream_unavailable: 503,
  internal: 500,
};

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly status: number;
  readonly details: unknown;
  /** Retryable errors tell the job queue to schedule another attempt. */
  readonly retryable: boolean;

  constructor(
    code: AppErrorCode,
    message: string,
    options: { details?: unknown; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "AppError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = options.details;
    this.retryable = options.retryable ?? (code === "rate_limited" || code === "upstream_unavailable");
  }
}

export const unauthenticated = (message = "Authentication required") =>
  new AppError("unauthenticated", message);

export const forbidden = (message = "You do not have access to this resource") =>
  new AppError("forbidden", message);

export const notFound = (message = "Resource not found") => new AppError("not_found", message);

export const validationFailed = (message: string, details?: unknown) =>
  new AppError("validation_failed", message, { details });

export const conflict = (message: string) => new AppError("conflict", message);

export const rateLimited = (message = "Too many requests") => new AppError("rate_limited", message);

export const upstreamUnavailable = (message: string, cause?: unknown) =>
  new AppError("upstream_unavailable", message, { cause, retryable: true });

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/** Never leak an internal message to a client; log the original, return a safe one. */
export function toPublicError(error: unknown): {
  code: AppErrorCode;
  status: number;
  message: string;
  details?: unknown;
} {
  if (isAppError(error)) {
    return {
      code: error.code,
      status: error.status,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
  return { code: "internal", status: 500, message: "Internal server error" };
}
