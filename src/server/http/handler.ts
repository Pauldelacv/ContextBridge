import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { createLogger } from "@/server/logging/logger";
import { recordRequest } from "@/server/observability/metrics";
import { toPublicError, validationFailed } from "@/server/errors";

export interface RouteContext {
  requestId: string;
  logger: ReturnType<typeof createLogger>;
}

type Handler<T> = (request: Request, context: RouteContext) => Promise<T>;

/**
 * The one place HTTP concerns live: request id, timing, error translation,
 * metrics. Route handlers stay thin and throw `AppError`s instead of hand-
 * rolling status codes.
 */
export function route<T>(name: string, handler: Handler<T>) {
  return async (request: Request): Promise<Response> => {
    const requestId = request.headers.get("x-request-id") ?? randomUUID();
    const log = createLogger({ requestId, route: name, method: request.method });
    const startedAt = Date.now();

    try {
      const result = await handler(request, { requestId, logger: log });
      const durationMs = Date.now() - startedAt;
      recordRequest(name, 200, durationMs);
      log.info("request.completed", { durationMs, status: 200 });

      if (result instanceof Response) return result;
      return NextResponse.json(result ?? { ok: true }, { headers: { "x-request-id": requestId } });
    } catch (error) {
      // Zod failures are client errors, not bugs — translate before reporting.
      const normalised =
        error instanceof ZodError
          ? validationFailed("Request validation failed", error.issues)
          : error;

      const publicError = toPublicError(normalised);
      const durationMs = Date.now() - startedAt;
      recordRequest(name, publicError.status, durationMs);

      if (publicError.status >= 500) log.error("request.failed", { durationMs, error: normalised });
      else log.warn("request.rejected", { durationMs, status: publicError.status, code: publicError.code });

      return NextResponse.json(
        { error: { code: publicError.code, message: publicError.message, details: publicError.details } },
        { status: publicError.status, headers: { "x-request-id": requestId } },
      );
    }
  };
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw validationFailed("Request body must be valid JSON");
  }
}
