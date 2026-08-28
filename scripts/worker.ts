/**
 * Background worker entrypoint. Runs alongside the web process:
 *   npm run worker
 */
import "./load-env";
import { closeDb } from "../src/server/db/client";
import { logger } from "../src/server/logging/logger";
import { runWorker } from "../src/server/jobs/worker";

const controller = new AbortController();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    logger.info("worker.shutdown_requested", { signal });
    controller.abort();
  });
}

runWorker({ signal: controller.signal })
  .catch((error: unknown) => {
    logger.error("worker.crashed", { error });
    process.exitCode = 1;
  })
  .finally(() => closeDb());
