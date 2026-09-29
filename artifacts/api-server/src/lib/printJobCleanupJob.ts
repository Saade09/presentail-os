import { db } from "./db";
import { logger } from "./logger";

const JOB_INTERVAL_MS = 5 * 60 * 1000;

async function runCleanup(): Promise<void> {
  const result = await db.query(
    `DELETE FROM print_jobs
     WHERE deleted_at IS NOT NULL
       AND deleted_at < now() - INTERVAL '10 minutes'
     RETURNING id`,
  );
  const count = result.rowCount ?? 0;
  if (count > 0) {
    logger.info({ count }, "Cleaned up soft-deleted print jobs");
  }
}

export function startPrintJobCleanupJob(): void {
  const tick = async () => {
    try {
      await runCleanup();
    } catch (err) {
      logger.warn({ err }, "Print job cleanup job error");
    }
  };

  setInterval(tick, JOB_INTERVAL_MS);
  logger.info("Print job cleanup background job started");
}
