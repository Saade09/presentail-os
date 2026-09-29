// ---------------------------------------------------------------------------
// Weekly Sales Digest — scheduled job (task #2830)
//
// Follows the paymentLinkCleanupJob pattern: hourly tick, PostgreSQL advisory
// lock so only one API instance does the work. On Monday (UTC, from 06:00)
// it iterates enabled workspaces and sends the digest for the last completed
// Monday–Sunday week. Per-week idempotency is enforced by the unique
// weekly_digest_sends ledger inside buildAndSendWeeklyDigest, so overlapping
// ticks or restarts can never double-send.
// ---------------------------------------------------------------------------

import { db } from "./db";
import { logger } from "./logger";
import { getLastCompletedWeek } from "./weeklyDigest/aggregate";
import { buildAndSendWeeklyDigest, normalizeExtraRecipients } from "./weeklyDigest/send";

const JOB_INTERVAL_MS = 60 * 60 * 1000;
const INITIAL_DELAY_MS = 45_000;

/** Arbitrary but stable 32-bit advisory lock key for this job. */
const DIGEST_ADVISORY_LOCK_ID = 828_311_047;

/** Send window: Monday 06:00 UTC onward (any Monday hour ≥ 6). */
export function isDigestSendTime(now: Date = new Date()): boolean {
  return now.getUTCDay() === 1 && now.getUTCHours() >= 6;
}

export async function runWeeklyDigestTick(now: Date = new Date()): Promise<void> {
  if (!isDigestSendTime(now)) return;

  const window = getLastCompletedWeek(now);

  const result = await db.query(
    `SELECT workspace_owner_id, extra_recipients
       FROM weekly_digest_settings
      WHERE enabled = true`,
  );

  for (const row of result.rows as {
    workspace_owner_id: string;
    extra_recipients: unknown;
  }[]) {
    try {
      await buildAndSendWeeklyDigest({
        ownerId: row.workspace_owner_id,
        window,
        extraRecipients: normalizeExtraRecipients(row.extra_recipients),
        recordSend: true,
      });
    } catch (err) {
      logger.warn(
        { err, ownerId: row.workspace_owner_id },
        "Weekly digest send failed for workspace — will retry next tick",
      );
    }
  }
}

export async function runWeeklyDigestTickWithLock(now: Date = new Date()): Promise<void> {
  if (!isDigestSendTime(now)) return;

  const client = await db.connect();
  try {
    const lockResult = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS acquired",
      [DIGEST_ADVISORY_LOCK_ID],
    );
    if (!lockResult.rows[0]?.acquired) {
      logger.info("Weekly digest tick skipped — another instance holds the advisory lock");
      return;
    }
    try {
      await runWeeklyDigestTick(now);
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [DIGEST_ADVISORY_LOCK_ID]);
    }
  } finally {
    client.release();
  }
}

export function startWeeklyDigestJob(): void {
  const tick = async () => {
    try {
      await runWeeklyDigestTickWithLock();
    } catch (err) {
      logger.warn({ err }, "Weekly digest job error");
    }
  };

  setTimeout(tick, INITIAL_DELAY_MS);
  setInterval(tick, JOB_INTERVAL_MS);

  logger.info(
    "Weekly digest background job started (hourly tick; sends Monday mornings UTC)",
  );
}
