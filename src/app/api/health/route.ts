import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/server/db/client";
import { route } from "@/server/http/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Liveness plus a real dependency check. A health endpoint that does not
 * touch the database reports healthy while every request fails.
 */
export const GET = route("health", async () => {
  const checks: Record<string, "ok" | "failed"> = {};

  try {
    await getDb().execute(sql`SELECT 1`);
    checks.database = "ok";
  } catch {
    checks.database = "failed";
  }

  try {
    await getDb().execute(sql`SELECT 1 FROM pg_extension WHERE extname = 'vector'`);
    checks.pgvector = "ok";
  } catch {
    checks.pgvector = "failed";
  }

  const healthy = Object.values(checks).every((status) => status === "ok");
  return NextResponse.json(
    { status: healthy ? "ok" : "degraded", checks },
    { status: healthy ? 200 : 503 },
  );
});
