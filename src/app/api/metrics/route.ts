import { renderMetrics } from "@/server/observability/metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Prometheus scrape endpoint. */
export function GET(): Response {
  return new Response(renderMetrics(), {
    headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
  });
}
