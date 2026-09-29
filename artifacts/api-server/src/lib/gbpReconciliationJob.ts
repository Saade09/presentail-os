import { db } from "./db";
import { logger } from "./logger";
import {
  decryptGbpCredentials,
  getGbpAccessToken,
  resolveGbpOauthClient,
  listRecentGbpReviews,
  fetchGbpReview,
  fetchGbpLocation,
  upsertFetchedReview,
  handleDeletedReview,
  clearGbpLocationError,
  recordGbpLocationError,
} from "./googleBusinessProfile";
import { REWARD_PENDING_DAYS } from "./reviewAttribution";
const JOB_INTERVAL_MS = 60 * 60 * 1000; // hourly

interface GbpLocationReconcileRow {
  location_id: number;
  location_name: string;
  workspace_owner_id: string;
  location_synced_at: string | null;
  connection_id: number;
  credentials_encrypted: string;
  /** Per-location account name (from gbp_location_connections.account_name);
   *  falls back to the parent gbp_connections value for legacy rows. */
  account_name: string | null;
}

const REGION_CODE_TO_COUNTRY: Record<string, string> = {
  LB: "Lebanon",
  AE: "UAE",
};

/**
 * Refresh the mutable GBP metadata used by Review Rewards labels. This is
 * deliberately isolated from review reconciliation: a metadata/API outage
 * must not prevent existing reviews from being ingested or deletion checks
 * from running.
 */
async function refreshGbpLocationMetadata(
  accessToken: string,
  loc: GbpLocationReconcileRow,
): Promise<void> {
  try {
    const remote = await fetchGbpLocation(accessToken, loc.location_name);
    if (!remote) return;

    const country = remote.regionCode
      ? (REGION_CODE_TO_COUNTRY[remote.regionCode] ?? null)
      : null;
    await db.query(
      `UPDATE gbp_location_connections
          SET location_title = COALESCE($2, location_title),
              location_locality = COALESCE($3, location_locality),
              account_name = COALESCE($4, account_name),
              country = COALESCE($5, country),
              updated_at = now()
        WHERE id = $1`,
      [
        loc.location_id,
        remote.title,
        remote.locality,
        loc.account_name,
        country,
      ],
    );
  } catch (err) {
    logger.warn(
      { err, locationId: loc.location_id, workspaceOwnerId: loc.workspace_owner_id },
      "gbp reconciliation: location metadata refresh failed; continuing with review sync",
    );
  }
}

/**
 * Periodic reconciliation sweep for connected Business Profile locations.
 * Iterates over `gbp_location_connections` (joined with `gbp_connections` for
 * credentials), one row per enabled GBP location, ordered by least-recently
 * synced so stale locations are prioritised.
 *
 *  1. Re-lists the most recent reviews to catch notifications that Pub/Sub
 *     missed (upserts are idempotent by google reviewId).
 *  2. Re-checks stored, non-deleted reviews still inside the reward pending
 *     window; reviews that 404 on direct fetch were deleted — pending
 *     rewards are voided.
 */
export async function runGbpReconciliationTick(): Promise<void> {
  const res = await db.query<GbpLocationReconcileRow>(
    `SELECT glc.id AS location_id, glc.location_name, glc.workspace_owner_id,
            glc.last_synced_at AS location_synced_at,
            gc.id AS connection_id, gc.credentials_encrypted,
            COALESCE(glc.account_name, gc.account_name) AS account_name
       FROM gbp_location_connections glc
       JOIN gbp_connections gc ON gc.id = glc.gbp_connection_id
      WHERE glc.is_enabled = true
        AND gc.credentials_encrypted <> ''
      ORDER BY glc.last_synced_at ASC NULLS FIRST
      LIMIT 10`,
  );

  for (const loc of res.rows) {
    try {
      const creds = decryptGbpCredentials(loc.credentials_encrypted);
      const oauthClient = await resolveGbpOauthClient(loc.workspace_owner_id);
      const accessToken = await getGbpAccessToken(creds, oauthClient ?? undefined);

      await refreshGbpLocationMetadata(accessToken, loc);

      // 1) Catch missed notifications — paginate the listing bounded to the
      // pending window so >50 new/updated reviews between sweeps still ingest.
      const updatedSince = new Date(
        Date.now() - (REWARD_PENDING_DAYS + 1) * 24 * 60 * 60 * 1000,
      );
      const recent = await listRecentGbpReviews(
        accessToken,
        loc.account_name!,
        loc.location_name,
        { updatedSince },
      );
      const liveIds = new Set(recent.map((r) => r.reviewId));
      for (const review of recent) {
        await upsertFetchedReview(loc.workspace_owner_id, review, loc.location_id);
      }

      // 2) Detect deletions during the pending window. Scoped by provenance:
      // only reviews attributed to this location are checked — reviews from a
      // previously selected location/account would 404 here and must never be
      // voided by that false signal.
      const locationPrefix = `${loc.account_name}/${loc.location_name}/reviews/`;
      const stored = await db.query<{ google_review_id: string; gbp_review_name: string }>(
        `SELECT google_review_id, gbp_review_name
           FROM google_reviews
          WHERE workspace_owner_id = $1
            AND (
              gbp_location_id = $2
              OR (gbp_location_id IS NULL AND gbp_review_name LIKE $3)
            )
            AND is_deleted = false
            AND review_created_at >= now() - INTERVAL '${REWARD_PENDING_DAYS + 1} days'`,
        [loc.workspace_owner_id, loc.location_id, `${locationPrefix}%`],
      );
      for (const row of stored.rows) {
        if (liveIds.has(row.google_review_id)) continue;
        // Not in the recent listing — confirm with a direct fetch before voiding.
        if (!row.gbp_review_name) continue;
        const live = await fetchGbpReview(accessToken, row.gbp_review_name);
        if (live === null) {
          await handleDeletedReview(loc.workspace_owner_id, row.google_review_id);
        }
      }

      await clearGbpLocationError(loc.location_id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        { err, locationId: loc.location_id, workspaceOwnerId: loc.workspace_owner_id },
        "gbp reconciliation: sweep failed for location",
      );
      await recordGbpLocationError(
        loc.location_id,
        `Reconciliation failed: ${message}`,
      ).catch(() => {});
    }
  }
}

export function startGbpReconciliationJob(): void {
  const tick = async () => {
    try {
      await runGbpReconciliationTick();
    } catch (err) {
      logger.warn({ err }, "GBP reconciliation job error");
    }
  };
  setInterval(tick, JOB_INTERVAL_MS);
  // Catch up shortly after startup.
  setTimeout(tick, 60 * 1000);
  logger.info("GBP review reconciliation background job started");
}
