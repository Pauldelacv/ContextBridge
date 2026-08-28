/**
 * Applies the SQL migrations in ./drizzle. Safe to run repeatedly — drizzle
 * records what it has applied in its own journal table.
 */
import "./load-env";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { closeDb, getDb } from "../src/server/db/client";
import { logger } from "../src/server/logging/logger";

async function main(): Promise<void> {
  logger.info("Running database migrations");
  await migrate(getDb(), { migrationsFolder: "./drizzle" });
  logger.info("Migrations complete");
  await closeDb();
}

main().catch((error: unknown) => {
  logger.error("Migration failed", { error });
  process.exitCode = 1;
});
