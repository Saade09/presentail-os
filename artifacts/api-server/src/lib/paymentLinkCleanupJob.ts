import type { PoolClient } from "pg";
import { db } from "./db";
import { logger } from "./logger";

const EXPIRE_AFTER_DAYS = 7;
const DELETE_AFTER_DAYS = 30;
const JOB_INTERVAL_MS = 60 * 60 * 1000;
const INITIAL_DELAY_MS = 30_000;

/**
 * Stable PostgreSQL advisory lock key used to elect a single cleanup leader
 * across all API server instances.  The value is arbitrary but must be a
 * consistent 32-bit integer so every instance tries the same lock.
 */
const CLEANUP_ADVISORY_LOCK_ID = 714_209_381;

export async function runCleanup(): Promise<void> {
  const client = await db.connect();
  try {
    await runCleanupOnClient(client);
  } finally {
    client.release();
  }
}

/**
 * Runs the cleanup UPDATE and DELETE inside a single transaction on the
 * provided client so they share the same DB session as the advisory lock.
 *
 * Both statements are wrapped in BEGIN / COMMIT so that a mid-tick crash
 * or DB connection drop causes an automatic ROLLBACK — leaving no orphaned
 * rows in a half-finished state.
 */
async function runCleanupOnClient(client: PoolClient): Promise<void> {
  await client.query("BEGIN");

  try {
    const expireResult = await client.query(`
      UPDATE payment_links
         SET status = 'expired'
       WHERE status = 'active'
         AND created_at < now() - ($1 || ' days')::interval
    `, [EXPIRE_AFTER_DAYS]);

    const expiredCount = expireResult.rowCount ?? 0;

    const deleteResult = await client.query(`
      DELETE FROM payment_links
       WHERE status = 'expired'
         AND created_at < now() - ($1 || ' days')::interval
    `, [DELETE_AFTER_DAYS]);

    const deletedCount = deleteResult.rowCount ?? 0;

    await client.query("COMMIT");

    logger.info(
      { expiredCount, deletedCount },
      `payment-link cleanup: expired ${expiredCount} active link(s), deleted ${deletedCount} old expired link(s)`,
    );
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Swallow rollback errors — the original error is what matters.
    }
    throw err;
  }
}

/**
 * Acquires a PostgreSQL session-level advisory lock, runs the cleanup, then
 * releases the lock — all on the same dedicated DB client.
 *
 * WHY a dedicated client matters
 * ─────────────────────────────
 * PostgreSQL session-level advisory locks (`pg_try_advisory_lock` /
 * `pg_advisory_unlock`) are scoped to the *connection* that acquired them.
 * When using a connection pool, successive `pool.query()` calls may be
 * dispatched to different connections, which would:
 *   • silently fail to release the lock (unlock runs on the wrong session), or
 *   • leave the lock held indefinitely by an idle pooled connection.
 *
 * By checking out a single `PoolClient`, we guarantee that the lock query,
 * every cleanup query, and the unlock query all run on the same session.
 * The client is released in a `finally` block; if the process crashes without
 * releasing the client, PostgreSQL automatically releases any advisory locks
 * bound to that connection when the session is terminated.
 *
 * If another instance already holds the lock the tick is skipped — no error
 * is raised and no duplicate work is done.
 */
export async function runCleanupWithLock(): Promise<void> {
  const client = await db.connect();

  try {
    const lockResult = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS acquired",
      [CLEANUP_ADVISORY_LOCK_ID],
    );

    const acquired = lockResult.rows[0]?.acquired;

    if (!acquired) {
      logger.info(
        "Payment link cleanup skipped — another instance holds the advisory lock",
      );
      return;
    }

    try {
      await runCleanupOnClient(client);
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [CLEANUP_ADVISORY_LOCK_ID]);
    }
  } finally {
    client.release();
  }
}

export function startPaymentLinkCleanupJob(): void {
  const tick = async () => {
    try {
      await runCleanupWithLock();
    } catch (err) {
      logger.warn({ err }, "Payment link cleanup job error");
    }
  };

  setTimeout(tick, INITIAL_DELAY_MS);
  setInterval(tick, JOB_INTERVAL_MS);

  logger.info("Payment link cleanup background job started (runs every hour, first run in 30s)");
}
