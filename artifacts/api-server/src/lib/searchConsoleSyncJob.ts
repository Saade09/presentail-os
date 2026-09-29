import { db } from "./db";
import { logger } from "./logger";
import {
  runSearchConsoleSync,
  GSC_RECENT_SYNC_DAYS,
  type GscConnectionRow,
} from "./searchConsoleSync";

const JOB_INTERVAL_MS = 60 * 60 * 1000; // hourly tick
const REFRESH_AFTER_HOURS = 23; // sync when last sync is older than this
const STALE_SYNC_AFTER_HOURS = 3; // 'syncing' older than this is a dead sync

/**
 * Scheduled refresh for connected Search Console properties: re-fetches the
 * recent window (last GSC_RECENT_SYNC_DAYS days) roughly once a day per
 * connection. Connections mid-sync are skipped, unless the syncing state is
 * stale (crash/restart mid-sync) — those are recovered.
 */
export async function runSearchConsoleSyncTick(): Promise<void> {
  // Recover connections stuck in 'syncing'.
  await db.query(
    `UPDATE search_console_connections
        SET sync_status = 'error',
            last_error = 'Sync was interrupted (server restart); it will be retried automatically.',
            updated_at = now()
      WHERE sync_status = 'syncing'
        AND updated_at < now() - INTERVAL '${STALE_SYNC_AFTER_HOURS} hours'`,
  );

  const res = await db.query<GscConnectionRow>(
    `SELECT id, workspace_owner_id, site_url, credentials_encrypted
       FROM search_console_connections
      WHERE sync_status <> 'syncing'
        AND (last_sync_at IS NULL OR last_sync_at < now() - INTERVAL '${REFRESH_AFTER_HOURS} hours')
      ORDER BY last_sync_at ASC NULLS FIRST
      LIMIT 10`,
  );

  for (const conn of res.rows) {
    await runSearchConsoleSync(conn, "recent");
  }
}

export function startSearchConsoleSyncJob(): void {
  const tick = async () => {
    try {
      await runSearchConsoleSyncTick();
    } catch (err) {
      logger.warn({ err }, "Search Console sync job error");
    }
  };
  setInterval(tick, JOB_INTERVAL_MS);
  // Catch up shortly after startup.
  setTimeout(tick, 45 * 1000);
  logger.info("Search Console sync background job started");
}
