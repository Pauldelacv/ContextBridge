/**
 * Loads `.env` for the standalone scripts (worker, migrate, seed).
 *
 * Next.js loads .env files itself, but a plain `tsx scripts/...` process does
 * not — so without this, `npm run worker` would come up with no DATABASE_URL
 * while `npm run dev` worked fine. Imported for its side effect, before any
 * module that reads the environment.
 */
import { existsSync } from "node:fs";

for (const file of [".env.local", ".env"]) {
  if (!existsSync(file)) continue;
  try {
    // Node's built-in loader; it does not overwrite variables already set,
    // so a real environment always wins over the file.
    process.loadEnvFile(file);
  } catch {
    // Unreadable or malformed: fall through to the real environment, which
    // env.ts will then validate and report on properly.
  }
}
