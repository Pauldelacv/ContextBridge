import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import { getDb } from "@/server/db/client";

let migrated = false;

/** Applies migrations once per test process. */
export async function ensureSchema(): Promise<void> {
  if (migrated) return;
  await migrate(getDb(), { migrationsFolder: "./drizzle" });
  migrated = true;
}

/** Wipes tenant data between tests. CASCADE handles the dependency order. */
export async function resetDatabase(): Promise<void> {
  await ensureSchema();
  await getDb().execute(sql`
    TRUNCATE TABLE query_logs, sync_jobs, chunks, documents, integrations,
                   sessions, memberships, users, organizations
    RESTART IDENTITY CASCADE
  `);
}
