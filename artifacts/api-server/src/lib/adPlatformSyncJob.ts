import { db } from "./db";
import { logger } from "./logger";
import {
  isGoogleAdsWorkspaceAllowed,
  runAdPlatformSync,
  type ConnectionRow,
} from "./adPlatformSync";

const JOB_INTERVAL_MS = 60 * 60 * 1000; // hourly tick
const REFRESH_AFTER_HOURS = 20; // sync when last successful sync is older than this
const STALE_SYNC_AFTER_HOURS = 3; // 'syncing' older than this is a dead sync

/**
 * Scheduled refresh for connected ad platforms: re-fetches the recent spend
 * window (restatement-safe) roughly once a day per connection. A connection is
 * due when it has never synced, or its last sync is older than
 * REFRESH_AFTER_HOURS. Connections currently mid-sync are skipped, unless the
 * syncing state is stale (crash/restart mid-sync) — those are recovered.
 */
export async function runAdPlatformSyncTick(): Promise<void> {
  // Recover connections stuck in 'syncing' (process died mid-sync); without
  // this the row would be skipped forever by both scheduler and manual sync.
  await db.query(
    `UPDATE ad_platform_connections
        SET sync_status = 'error',
            last_error = 'Sync was interrupted (server restart); it will be retried automatically.',
            updated_at = now()
      WHERE sync_status = 'syncing'
        AND updated_at < now() - INTERVAL '${STALE_SYNC_AFTER_HOURS} hours'`,
  );
  const res = await db.query<ConnectionRow>(
    `SELECT id, workspace_owner_id, platform, credentials_encrypted, account_created_time
       FROM ad_platform_connections
      WHERE sync_status <> 'syncing'
         AND (platform <> 'google_ads' OR workspace_owner_id = $1)
        AND (last_sync_at IS NULL OR last_sync_at < now() - INTERVAL '${REFRESH_AFTER_HOURS} hours')
      ORDER BY last_sync_at ASC NULLS FIRST
       LIMIT 10`,
    [process.env.GOOGLE_ADS_WORKSPACE_OWNER_ID?.trim() ?? ""],
  );
  for (const conn of res.rows) {
    // Server-owned Google Ads credentials are intentionally single-tenant.
    if (conn.platform === "google_ads" && !isGoogleAdsWorkspaceAllowed(conn.workspace_owner_id)) {
      continue;
    }
    // Sequential on purpose: keeps external API pressure low.
    await runAdPlatformSync(conn, "recent");
  }
}

export function startAdPlatformSyncJob(): void {
  const tick = async () => {
    try {
      await runAdPlatformSyncTick();
    } catch (err) {
      logger.warn({ err }, "Ad platform sync job error");
    }
  };
  setInterval(tick, JOB_INTERVAL_MS);
  // Catch up shortly after startup.
  setTimeout(tick, 30 * 1000);
  logger.info("Ad platform sync background job started");
}
