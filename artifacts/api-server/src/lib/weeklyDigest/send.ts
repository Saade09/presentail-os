// ---------------------------------------------------------------------------
// Weekly Sales Digest — build + send orchestration (task #2830)
// ---------------------------------------------------------------------------

import { db } from "../db";
import { logger } from "../logger";
import { sendWeeklyDigestEmail } from "../email";
import {
  buildWeeklyDigestData,
  weekStartKey,
  type WeekWindow,
} from "./aggregate";
import {
  buildWeeklyDigestHtml,
  buildWeeklyDigestText,
  buildWeeklyDigestSubject,
} from "./emailTemplate";
import { generateDigestInsights } from "./insights";

export interface DigestSettingsRow {
  workspace_owner_id: string;
  enabled: boolean;
  extra_recipients: string[];
}

export function normalizeExtraRecipients(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== "string") continue;
    const email = v.trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push(email);
  }
  return out;
}

/** Owner is always a recipient; extra recipients are appended (deduped). */
export async function resolveDigestRecipients(
  ownerId: string,
  extraRecipients: string[],
): Promise<string[]> {
  const result = await db.query(
    `SELECT DISTINCT member_email
       FROM workspace_members
      WHERE workspace_owner_id = $1
        AND role = 'owner'
        AND member_email IS NOT NULL
        AND notify_email_weekly_digest = true`,
    [ownerId],
  );
  const emails = new Set<string>();
  for (const row of result.rows as { member_email: string }[]) {
    const email = row.member_email?.trim().toLowerCase();
    if (email) emails.add(email);
  }
  for (const email of normalizeExtraRecipients(extraRecipients)) {
    emails.add(email);
  }
  return [...emails];
}

/**
 * One-off TEST send to explicit recipients only. Never touches the
 * weekly_digest_sends ledger and never reads/writes saved recipient settings,
 * so the real Monday send is unaffected.
 */
export async function sendWeeklyDigestTest(opts: {
  ownerId: string;
  window: WeekWindow;
  to: string[];
}): Promise<{ weekStart: string; recipients: string[] }> {
  const { ownerId, window, to } = opts;
  const recipients = normalizeExtraRecipients(to);
  if (recipients.length === 0) {
    throw new Error("sendWeeklyDigestTest requires at least one recipient");
  }
  const weekStart = weekStartKey(window);

  const data = await buildWeeklyDigestData(ownerId, window);
  const { insights, actions, source } = await generateDigestInsights(data, { workspaceOwnerId: ownerId });
  const subject = `[TEST] ${buildWeeklyDigestSubject(data)}`;
  const html = buildWeeklyDigestHtml({ data, insights, actions });
  const text = buildWeeklyDigestText({ data, insights, actions });

  await sendWeeklyDigestEmail({ to: recipients, subject, html, text });

  logger.info(
    { ownerId, weekStart, recipients, insightsSource: source },
    "Weekly digest TEST email sent (no ledger row recorded)",
  );
  return { weekStart, recipients };
}

export interface SendDigestResult {
  sent: boolean;
  reason?: "no_recipients" | "already_sent";
  recipients: string[];
  weekStart: string;
}

/**
 * Builds and sends the weekly digest for one workspace and week window.
 *
 * When `recordSend` is true (scheduled job), a row is claimed in
 * weekly_digest_sends first (ON CONFLICT DO NOTHING) so the same week can
 * never be double-sent; if the claim loses, the send is skipped. On send
 * failure the claim row is released. Manual "Send now" passes
 * recordSend=false and never touches the ledger.
 */
export async function buildAndSendWeeklyDigest(opts: {
  ownerId: string;
  window: WeekWindow;
  extraRecipients: string[];
  recordSend: boolean;
}): Promise<SendDigestResult> {
  const { ownerId, window, recordSend } = opts;
  const weekStart = weekStartKey(window);

  const recipients = await resolveDigestRecipients(ownerId, opts.extraRecipients);
  if (recipients.length === 0) {
    logger.warn({ ownerId, weekStart }, "Weekly digest skipped — no recipients");
    return { sent: false, reason: "no_recipients", recipients: [], weekStart };
  }

  if (recordSend) {
    const claim = await db.query(
      `INSERT INTO weekly_digest_sends (workspace_owner_id, week_start, recipients)
       VALUES ($1, $2, $3)
       ON CONFLICT (workspace_owner_id, week_start) DO NOTHING
       RETURNING id`,
      [ownerId, weekStart, JSON.stringify(recipients)],
    );
    if (claim.rowCount === 0) {
      logger.info({ ownerId, weekStart }, "Weekly digest already sent for this week — skipping");
      return { sent: false, reason: "already_sent", recipients, weekStart };
    }
  }

  try {
    const data = await buildWeeklyDigestData(ownerId, window);
    const { insights, actions, source } = await generateDigestInsights(data, { workspaceOwnerId: ownerId });
    const subject = buildWeeklyDigestSubject(data);
    const html = buildWeeklyDigestHtml({ data, insights, actions });
    const text = buildWeeklyDigestText({ data, insights, actions });

    await sendWeeklyDigestEmail({ to: recipients, subject, html, text });

    logger.info(
      { ownerId, weekStart, recipients: recipients.length, insightsSource: source },
      "Weekly digest sent",
    );
    return { sent: true, recipients, weekStart };
  } catch (err) {
    if (recordSend) {
      // Release the idempotency claim so a later tick can retry this week.
      await db
        .query(
          `DELETE FROM weekly_digest_sends WHERE workspace_owner_id = $1 AND week_start = $2`,
          [ownerId, weekStart],
        )
        .catch((cleanupErr) => {
          logger.warn({ cleanupErr, ownerId, weekStart }, "Failed to release digest send claim");
        });
    }
    throw err;
  }
}
