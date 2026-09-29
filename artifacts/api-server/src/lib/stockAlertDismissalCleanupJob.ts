import { db } from "./db";
import { logger } from "./logger";

const JOB_INTERVAL_MS = 24 * 60 * 60 * 1000;
const INITIAL_DELAY_MS = 60_000;

/**
 * Stable PostgreSQL advisory lock key used to elect a single cleanup leader
 * across all API server instances.  The value is arbitrary but must be a
 * consistent 32-bit integer so every instance tries the same lock.
 */
const CLEANUP_ADVISORY_LOCK_ID = 823_541_097;

export async function runCleanup(): Promise<void> {
  const client = await db.connect();

  try {
    const lockResult = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS acquired",
      [CLEANUP_ADVISORY_LOCK_ID],
    );

    const acquired = lockResult.rows[0]?.acquired;

    if (!acquired) {
      logger.info(
        "Stock alert dismissal cleanup skipped — another instance holds the advisory lock",
      );
      return;
    }

    try {
      const result = await client.query(`
        DELETE FROM stock_alert_dismissals
         WHERE expires_at < now()
      `);

      const count = result.rowCount ?? 0;

      if (count > 0) {
        logger.info(
          { count },
          `stock-alert-dismissal cleanup: pruned ${count} expired dismissal row(s)`,
        );
      } else {
        logger.info("stock-alert-dismissal cleanup: no expired rows found");
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [CLEANUP_ADVISORY_LOCK_ID]);
    }
  } finally {
    client.release();
  }
}

export function startStockAlertDismissalCleanupJob(): void {
  const tick = async () => {
    try {
      await runCleanup();
    } catch (err) {
      logger.warn({ err }, "Stock alert dismissal cleanup job error");
    }
  };

  setTimeout(tick, INITIAL_DELAY_MS);
  setInterval(tick, JOB_INTERVAL_MS);

  logger.info(
    "Stock alert dismissal cleanup job started (runs every 24 h, first run in 60s)",
  );
}
