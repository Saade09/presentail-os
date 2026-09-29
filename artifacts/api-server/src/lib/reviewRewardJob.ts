import { db, withTransaction } from "./db";
import { logger } from "./logger";
import { recordAudit } from "./reviewAttribution";

const JOB_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Review reward lifecycle sweep:
 *  - approves pending rewards whose 7-day pending window has elapsed AND whose
 *    review still exists (not deleted);
 *  - voids pending/approved-unpaid rewards whose review was deleted (safety
 *    net — deletion voiding also happens inline at ingest time).
 */
export async function runReviewRewardSweep(): Promise<void> {
  // Each batch transition commits atomically with its audit entries — a
  // reward is never voided/approved without the matching audit record.
  const client = await db.connect();
  let voidedCount = 0;
  let approvedCount = 0;
  try {
    voidedCount = await withTransaction(client, async () => {
      const voided = await client.query<{
        id: number;
        workspace_owner_id: string;
        review_id: number;
      }>(
        `UPDATE review_rewards r
            SET status = 'voided', voided_at = now(),
                void_reason = 'review deleted on Google', updated_at = now()
           FROM google_reviews g
          WHERE g.id = r.review_id
            AND g.is_deleted = true
            AND r.status IN ('pending', 'approved')
          RETURNING r.id, r.workspace_owner_id, r.review_id`,
      );
      for (const row of voided.rows) {
        await recordAudit(
          {
            workspaceOwnerId: row.workspace_owner_id,
            reviewId: row.review_id,
            rewardId: row.id,
            action: "reward_voided",
            actorUserId: null,
            details: { reason: "review deleted on Google", source: "sweep" },
          },
          client,
        );
      }
      return voided.rows.length;
    });

    approvedCount = await withTransaction(client, async () => {
      const approved = await client.query<{
        id: number;
        workspace_owner_id: string;
        review_id: number;
      }>(
        `UPDATE review_rewards r
            SET status = 'approved', approved_at = now(), updated_at = now()
           FROM google_reviews g
          WHERE g.id = r.review_id
            AND g.is_deleted = false
            AND r.status = 'pending'
            AND r.pending_until <= now()
          RETURNING r.id, r.workspace_owner_id, r.review_id`,
      );
      for (const row of approved.rows) {
        await recordAudit(
          {
            workspaceOwnerId: row.workspace_owner_id,
            reviewId: row.review_id,
            rewardId: row.id,
            action: "reward_approved",
            actorUserId: null,
            details: { source: "sweep" },
          },
          client,
        );
      }
      return approved.rows.length;
    });
  } finally {
    client.release();
  }

  if (voidedCount > 0 || approvedCount > 0) {
    logger.info(
      { approved: approvedCount, voided: voidedCount },
      "review reward sweep: rewards transitioned",
    );
  }
}

export function startReviewRewardJob(): void {
  const tick = async () => {
    try {
      await runReviewRewardSweep();
    } catch (err) {
      logger.warn({ err }, "Review reward sweep job error");
    }
  };
  setInterval(tick, JOB_INTERVAL_MS);
  setTimeout(tick, 20 * 1000);
  logger.info("Review reward background job started");
}
