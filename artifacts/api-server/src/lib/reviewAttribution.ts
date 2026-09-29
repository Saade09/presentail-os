import { createHash } from "crypto";
import { db, withTransaction } from "./db";
import { logger } from "./logger";

/** Thrown when a concurrent writer claimed the scan/review first. */
export class MatchConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MatchConflictError";
  }
}

/**
 * Google Review Rewards — attribution + reward services.
 *
 * `ingestReview` is the internal entry point the (separate) Google Business
 * Profile ingestion task feeds reviews into. It upserts the review record
 * idempotently by (workspace, google_review_id), applies the 6-hour
 * most-recent-eligible-scan attribution rule, and creates at most one pending
 * reward per Google review id. Ambiguous cases are flagged `needs_review` and
 * are never silently assigned.
 */

/** Default Google review URL used when the workspace has none configured. */
export const DEFAULT_GOOGLE_REVIEW_URL = "https://g.page/r/CRUeLHTYI2EZEBM/review";

/** Attribution window: a review matches scans in the preceding 6 hours. */
export const MATCH_WINDOW_MS = 6 * 60 * 60 * 1000;

/** Rewards stay pending for 7 days before auto-approval. */
export const REWARD_PENDING_DAYS = 7;

/** Repeat scans from the same device hash within this window are flagged. */
export const RAPID_SCAN_WINDOW_MINUTES = 10;

/** Anonymized device hash: salted SHA-256 of ip + user agent, truncated. */
export function computeDeviceHash(ip: string, userAgent: string): string {
  const salt = process.env.REVIEW_SCAN_HASH_SALT ?? "presentail-review-rewards";
  return createHash("sha256").update(`${salt}|${ip}|${userAgent}`).digest("hex").slice(0, 16);
}

export interface IngestReviewInput {
  workspaceOwnerId: string;

  googleReviewId: string;

  reviewerName?: string | null;

  rating?: number | null;

  comment?: string | null;
  /** When the review was created on Google. Defaults to now. */

  reviewCreatedAt?: Date;
  /** When true, the review was deleted on Google — voids any pending reward. */

  isDeleted?: boolean;
  /**
   * `gbp_location_connections.id` for the location this review arrived from.
   * Written to `google_reviews.gbp_location_id` on insert so attribution can
   * be scoped per location. Null means unknown / legacy (no location filter).
   */

  gbpLocationId?: number | null;
}

export interface IngestReviewResult {
  reviewId: number;
  created: boolean;
  matchStatus: string;
  matchedProfileId: number | null;
  rewardId: number | null;
}

interface ReviewRow {
  id: number;
  match_status: string;
  matched_profile_id: number | null;
  is_deleted: boolean;
}

/**
 * Idempotently upsert an ingested Google review and run attribution.
 *
 * - New review → insert + attempt auto-match (or needs_review / unmatched).
 * - Existing review → no re-matching, no duplicate rewards. Only the deletion
 *   transition is applied (marks deleted + voids a pending reward).
 */
export async function ingestReview(input: IngestReviewInput): Promise<IngestReviewResult> {
  const reviewCreatedAt = input.reviewCreatedAt ?? new Date();

  const existing = await db.query<ReviewRow>(
    `SELECT id, match_status, matched_profile_id, is_deleted
       FROM google_reviews
      WHERE workspace_owner_id = $1 AND google_review_id = $2`,
    [input.workspaceOwnerId, input.googleReviewId],
  );

  if (existing.rows.length > 0) {
    const row = existing.rows[0];
    if (input.isDeleted && !row.is_deleted) {
      await markReviewDeleted(input.workspaceOwnerId, row.id);
    }
    const reward = await db.query<{ id: number }>(
      `SELECT id FROM review_rewards WHERE review_id = $1`,
      [row.id],
    );
    return {
      reviewId: row.id,
      created: false,
      matchStatus: row.match_status,
      matchedProfileId: row.matched_profile_id,
      rewardId: reward.rows[0]?.id ?? null,
    };
  }

  const inserted = await db.query<{ id: number }>(
    `INSERT INTO google_reviews
       (workspace_owner_id, google_review_id, reviewer_name, rating, comment,
        review_created_at, is_deleted, deleted_at, match_status, gbp_location_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $7 THEN now() END, 'pending', $8)
     ON CONFLICT (workspace_owner_id, google_review_id) DO NOTHING
     RETURNING id`,
    [
      input.workspaceOwnerId,
      input.googleReviewId,
      input.reviewerName ?? null,
      input.rating ?? null,
      input.comment ?? null,
      reviewCreatedAt,
      Boolean(input.isDeleted),
      input.gbpLocationId ?? null,
    ],
  );

  // Lost a concurrent insert race — treat as existing (idempotent).
  if (inserted.rows.length === 0) {
    return ingestReview(input);
  }

  const reviewId = inserted.rows[0].id;

  if (input.isDeleted) {
    await db.query(
      `UPDATE google_reviews SET match_status = 'unmatched', match_reason = 'ingested as deleted', updated_at = now() WHERE id = $1`,
      [reviewId],
    );
    return { reviewId, created: true, matchStatus: "unmatched", matchedProfileId: null, rewardId: null };
  }

  const match = await attributeReview(input.workspaceOwnerId, reviewId, reviewCreatedAt, input.gbpLocationId ?? null);
  return { reviewId, created: true, ...match };
}

interface AttributionOutcome {
  matchStatus: string;
  matchedProfileId: number | null;
  rewardId: number | null;
}

/**
 * Apply the 6-hour most-recent-eligible-scan rule for a stored review.
 *
 * Eligible scans: same workspace, unmatched, not flagged, active profile,
 * scanned within (reviewCreatedAt - 6h, reviewCreatedAt].
 * When `gbpLocationId` is provided, only scans from profiles with a matching
 * (or unset) `gbp_location_id` are eligible — enabling location-scoped
 * attribution for multi-location workspaces.
 *
 * Do-not-auto-match conditions (all → needs_review, never silently assigned):
 *  - multiple plausible employees (distinct profiles) in the window
 *  - the review predates every scan (only later scans exist)
 *  - no eligible scan at all, but recent scan activity exists
 * When there is no scan activity whatsoever, the review is simply `unmatched`.
 */
export async function attributeReview(
  workspaceOwnerId: string,
  reviewId: number,
  reviewCreatedAt: Date,
  gbpLocationId?: number | null,
): Promise<AttributionOutcome> {
  const windowStart = new Date(reviewCreatedAt.getTime() - MATCH_WINDOW_MS);

  const eligible = await db.query<{ id: number; profile_id: number; scanned_at: Date }>(
    `SELECT s.id, s.profile_id, s.scanned_at
       FROM review_scans s
       JOIN employee_review_profiles p ON p.id = s.profile_id
      WHERE s.workspace_owner_id = $1
        AND s.match_status = 'unmatched'
        AND s.flagged = false
        AND p.is_active = true
        AND p.archived_at IS NULL
        AND s.scanned_at > $2
        AND s.scanned_at <= $3
        AND ($4::int IS NULL OR s.gbp_location_id IS NULL OR s.gbp_location_id = $4)
      ORDER BY s.scanned_at DESC`,
    [workspaceOwnerId, windowStart, reviewCreatedAt, gbpLocationId ?? null],
  );

  const distinctProfiles = new Set(eligible.rows.map((r) => r.profile_id));

  if (distinctProfiles.size === 1) {
    const scan = eligible.rows[0];
    try {
      const rewardId = await confirmMatch({
        workspaceOwnerId,
        reviewId,
        scanId: scan.id,
        profileId: scan.profile_id,
        matchStatus: "auto_matched",
        reason: "single eligible profile within 6-hour window",
      });
      return { matchStatus: "auto_matched", matchedProfileId: scan.profile_id, rewardId };
    } catch (err) {
      if (err instanceof MatchConflictError) {
        // A concurrent writer claimed the scan or review — never guess;
        // route to manual review instead.
        await setNeedsReview(reviewId, `auto-match conflict: ${err.message}`);
        return { matchStatus: "needs_review", matchedProfileId: null, rewardId: null };
      }
      throw err;
    }
  }

  if (distinctProfiles.size > 1) {
    await setNeedsReview(reviewId, "multiple plausible employees scanned within the 6-hour window");
    return { matchStatus: "needs_review", matchedProfileId: null, rewardId: null };
  }

  // No eligible scan in the window. If there is any unmatched scan AFTER the
  // review time (review predates scan) or recent unmatched activity, flag for
  // manual review; otherwise leave unmatched.
  const laterOrRecent = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM review_scans s
      WHERE s.workspace_owner_id = $1
        AND s.match_status = 'unmatched'
        AND (s.scanned_at > $2 OR (s.flagged = true AND s.scanned_at > $3))`,
    [workspaceOwnerId, reviewCreatedAt, windowStart],
  );
  if (Number(laterOrRecent.rows[0]?.n ?? 0) > 0) {
    await setNeedsReview(reviewId, "no eligible scan; review predates scan or only flagged scans in window");
    return { matchStatus: "needs_review", matchedProfileId: null, rewardId: null };
  }

  await db.query(
    `UPDATE google_reviews
        SET match_status = 'unmatched', match_reason = 'no scan activity in window', updated_at = now()
      WHERE id = $1 AND match_status = 'pending'`,
    [reviewId],
  );
  return { matchStatus: "unmatched", matchedProfileId: null, rewardId: null };
}

async function setNeedsReview(reviewId: number, reason: string): Promise<void> {
  await db.query(
    `UPDATE google_reviews
        SET match_status = 'needs_review', match_reason = $2, updated_at = now()
      WHERE id = $1 AND match_status IN ('pending', 'needs_review')`,
    [reviewId, reason],
  );
}

export interface ConfirmMatchInput {
  workspaceOwnerId: string;
  reviewId: number;
  scanId: number | null;
  profileId: number;
  matchStatus: "auto_matched" | "manually_matched";
  reason: string;
  actorUserId?: string;
}

/**
 * Atomically write a confirmed match onto both the scan and the review, and
 * create the pending reward (exactly one per review — enforced by the unique
 * index). Runs in a single transaction with conditional claims so concurrent
 * ingests / manual resolutions cannot double-assign a scan or split the
 * review assignment from the reward.
 *
 * Throws {@link MatchConflictError} (after rollback) when another writer
 * already claimed the review or the scan.
 */
export async function confirmMatch(input: ConfirmMatchInput): Promise<number | null> {
  const { workspaceOwnerId, reviewId, scanId, profileId } = input;

  const client = await db.connect();
  try {
    return await withTransaction(client, async () => {
      // Conditionally claim the review — only unresolved states are claimable.
      const claimed = await client.query<{ id: number }>(
        `UPDATE google_reviews
            SET match_status = $2, matched_scan_id = $3, matched_profile_id = $4,
                match_reason = $5, match_resolved_by = $6,
                match_resolved_at = now(), updated_at = now()
          WHERE id = $1
            AND workspace_owner_id = $7
            AND is_deleted = false
            AND match_status IN ('pending', 'needs_review', 'unmatched')
          RETURNING id`,
        [
          reviewId,
          input.matchStatus,
          scanId,
          profileId,
          input.reason,
          input.actorUserId ?? null,
          workspaceOwnerId,
        ],
      );
      if (claimed.rows.length === 0) {
        throw new MatchConflictError("review already resolved by a concurrent writer");
      }

      // Conditionally claim the scan — must still be unmatched.
      if (scanId !== null) {
        const scanClaim = await client.query<{ id: number }>(
          `UPDATE review_scans
              SET match_status = 'matched', matched_review_id = $2
            WHERE id = $1 AND match_status = 'unmatched'
            RETURNING id`,
          [scanId, reviewId],
        );
        if (scanClaim.rows.length === 0) {
          throw new MatchConflictError("scan already matched by a concurrent writer");
        }
      }

      const profile = await client.query<{ reward_amount: string }>(
        `SELECT reward_amount FROM employee_review_profiles WHERE id = $1`,
        [profileId],
      );
      const amount = profile.rows[0]?.reward_amount ?? "0";

      // Reward is equal regardless of star rating; one max per review id.
      // gbp_location_id is copied from the review row so the reward stays
      // attributed to the correct location without a separate lookup parameter.
      const reward = await client.query<{ id: number }>(
        `INSERT INTO review_rewards
           (workspace_owner_id, review_id, profile_id, amount, status, pending_until, gbp_location_id)
         SELECT $1, $2, $3, $4, 'pending', now() + make_interval(days => $5), gbp_location_id
           FROM google_reviews WHERE id = $2
         ON CONFLICT (review_id) DO NOTHING
         RETURNING id`,
        [workspaceOwnerId, reviewId, profileId, amount, REWARD_PENDING_DAYS],
      );
      if (reward.rows.length === 0) {
        // A reward already exists for this review (e.g. re-assign after a
        // previous match). Never create a second one.
        const existing = await client.query<{ id: number }>(
          `SELECT id FROM review_rewards WHERE review_id = $1`,
          [reviewId],
        );
        return existing.rows[0]?.id ?? null;
      }

      await recordAudit(
        {
          workspaceOwnerId,
          reviewId,
          rewardId: reward.rows[0].id,
          action: input.matchStatus === "auto_matched" ? "auto_match" : "manual_match",
          actorUserId: input.actorUserId ?? null,
          details: { scanId, profileId, reason: input.reason },
        },
        client,
      );
      return reward.rows[0].id;
    });
  } finally {
    client.release();
  }
}

/** Mark a review deleted and void its reward (pending or approved-not-paid). */
export async function markReviewDeleted(
  workspaceOwnerId: string,
  reviewId: number,
): Promise<void> {
  // Deletion flag, reward voiding, and the audit entry commit atomically —
  // a reward can never be voided without its audit record.
  const client = await db.connect();
  try {
    const voidedRewardId = await withTransaction(client, async () => {
      await client.query(
        `UPDATE google_reviews
            SET is_deleted = true, deleted_at = now(), updated_at = now()
          WHERE id = $1 AND is_deleted = false`,
        [reviewId],
      );
      const voided = await client.query<{ id: number }>(
        `UPDATE review_rewards
            SET status = 'voided', voided_at = now(),
                void_reason = 'review deleted on Google', updated_at = now()
          WHERE review_id = $1 AND status IN ('pending', 'approved')
          RETURNING id`,
        [reviewId],
      );
      if (voided.rows.length === 0) return null;
      await recordAudit(
        {
          workspaceOwnerId,
          reviewId,
          rewardId: voided.rows[0].id,
          action: "reward_voided",
          actorUserId: null,
          details: { reason: "review deleted on Google" },
        },
        client,
      );
      return voided.rows[0].id;
    });
    if (voidedRewardId !== null) {
      logger.info({ reviewId, rewardId: voidedRewardId }, "review reward voided: review deleted");
    }
  } finally {
    client.release();
  }
}

export async function recordAudit(
  entry: {
    workspaceOwnerId: string;
    reviewId: number | null;
    rewardId: number | null;
    action: string;
    actorUserId: string | null;
    details?: unknown;
  },
  queryable: { query: (text: string, params?: unknown[]) => Promise<unknown> } = db,
): Promise<void> {
  await queryable.query(
    `INSERT INTO review_match_audit
       (workspace_owner_id, review_id, reward_id, action, actor_user_id, details)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      entry.workspaceOwnerId,
      entry.reviewId,
      entry.rewardId,
      entry.action,
      entry.actorUserId,
      entry.details === undefined ? null : JSON.stringify(entry.details),
    ],
  );
}

/**
 * The public scan route 302-redirects visitors to this admin-configured URL,
 * so it must be an actual Google review-link shape — never `javascript:`,
 * `data:`, an arbitrary site, or a Google host used as an open-redirect
 * springboard (e.g. `https://www.google.com/url?q=https://evil.example`).
 * Per-host path rules limit accepted URLs to known review destinations.
 */
export function isSafeReviewUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  const path = url.pathname;
  switch (host) {
    case "g.page":
      // Business Profile short links, e.g. /r/{token}/review or /{name}/review
      return path.length > 1;
    case "maps.app.goo.gl":
      // Maps share short links, e.g. /AbCdEf
      return path.length > 1;
    case "goo.gl":
      // Legacy Maps short links only.
      return path.startsWith("/maps/");
    case "search.google.com":
      // Canonical write-review deep link.
      return path === "/local/writereview";
    case "google.com":
    case "www.google.com":
    case "maps.google.com":
      // Maps place pages only — notably NOT /url (Google's outbound
      // redirector) or any other path.
      return path === "/maps" || path.startsWith("/maps/");
    default:
      return false;
  }
}

/**
 * Resolve the workspace's Google review URL (falls back to the default).
 * Defensively re-validates the stored value so a bad row can never turn the
 * public redirect into an open redirect.
 */
export async function getGoogleReviewUrl(workspaceOwnerId: string): Promise<string> {
  const res = await db.query<{ google_review_url: string | null }>(
    `SELECT google_review_url FROM workspace_settings WHERE workspace_owner_id = $1`,
    [workspaceOwnerId],
  );
  const stored = res.rows[0]?.google_review_url?.trim();
  if (stored && isSafeReviewUrl(stored)) return stored;
  return DEFAULT_GOOGLE_REVIEW_URL;
}
