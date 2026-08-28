import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { getEnv } from "@/server/config/env";
import * as schema from "@/server/db/schema";

export type Database = NodePgDatabase<typeof schema>;

/**
 * A single pool per process. Next.js dev reloads modules on every edit, so the
 * pool is parked on `globalThis` to avoid leaking a connection pool per reload.
 */
const globalForDb = globalThis as unknown as { __contextbridgePool?: pg.Pool };

export function getPool(): pg.Pool {
  if (!globalForDb.__contextbridgePool) {
    globalForDb.__contextbridgePool = new pg.Pool({
      connectionString: getEnv().DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
    });
  }
  return globalForDb.__contextbridgePool;
}

let cachedDb: Database | null = null;

export function getDb(): Database {
  if (!cachedDb) {
    cachedDb = drizzle(getPool(), { schema });
  }
  return cachedDb;
}

export async function closeDb(): Promise<void> {
  if (globalForDb.__contextbridgePool) {
    await globalForDb.__contextbridgePool.end();
    globalForDb.__contextbridgePool = undefined;
    cachedDb = null;
  }
}
