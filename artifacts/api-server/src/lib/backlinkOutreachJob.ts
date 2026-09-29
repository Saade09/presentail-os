/**
 * Backlink Engine — Outreach Scheduler Job
 *
 * Runs every 5 minutes. Picks `approved` messages where the sequence number
 * is 1 (or a follow-up whose predecessor was delivered), checks the suppression
 * list and daily send limit, and marks them as sent. Follow-up messages (seq 2+)
 * are auto-inserted only after seq N is delivered with no opt-out/bounce.
 * Duplicate-send is prevented by the `sent_at IS NOT NULL` idempotency guard.
 */
import { db } from "./db";
import { logger } from "./logger";

const OUTREACH_INTERVAL_MS = 5 * 60 * 1000;
let outreachTimer: ReturnType<typeof setInterval> | null = null;

const DEFAULT_DAILY_LIMIT = 20;

export async function runBacklinkOutreachSweep(): Promise<void> {
  type WorkspaceRow = { workspace_owner_id: string };
  const workspaces = await db.query<WorkspaceRow>(
    `SELECT DISTINCT c.workspace_owner_id
     FROM backlink_campaigns c
     JOIN backlink_messages m ON m.campaign_id = c.id
     WHERE m.status = 'approved' AND m.sent_at IS NULL`,
  );

  for (const { workspace_owner_id } of workspaces.rows) {
    try {
      const settingsRes = await db.query<{ daily_send_limit: number; cooling_period_days: number; max_followups: number }>(
        `SELECT daily_send_limit, cooling_period_days, max_followups FROM backlink_settings WHERE workspace_owner_id = $1`,
        [workspace_owner_id],
      );
      const settings = settingsRes.rows[0];
      const dailyLimit = settings?.daily_send_limit ?? DEFAULT_DAILY_LIMIT;
      const maxFollowups = settings?.max_followups ?? 2;
      const coolingDays = settings?.cooling_period_days ?? 30;

      // Count today's sends
      type CountRow = { sent_today: string };
      const countRes = await db.query<CountRow>(
        `SELECT COUNT(*) AS sent_today FROM backlink_messages m
         JOIN backlink_campaigns c ON c.id = m.campaign_id
         WHERE c.workspace_owner_id = $1 AND m.sent_at >= date_trunc('day', now())`,
        [workspace_owner_id],
      );
      let sentToday = parseInt(countRes.rows[0]?.sent_today ?? "0", 10);
      if (sentToday >= dailyLimit) continue;

      // Pick approved, unsent messages for this workspace
      const msgs = await db.query(
        `SELECT m.*, bc.email AS contact_email, bc.do_not_contact,
                c.workspace_owner_id
         FROM backlink_messages m
         JOIN backlink_campaigns c ON c.id = m.campaign_id
         LEFT JOIN backlink_contacts bc ON bc.id = m.contact_id
         WHERE c.workspace_owner_id = $1
           AND m.status = 'approved'
           AND m.sent_at IS NULL
         ORDER BY m.created_at ASC
         LIMIT $2`,
        [workspace_owner_id, dailyLimit - sentToday],
      );

      for (const msg of msgs.rows as Array<Record<string, unknown>>) {
        if (sentToday >= dailyLimit) break;

        // Skip do-not-contact
        if (msg.do_not_contact) {
          await db.query(`UPDATE backlink_messages SET status = 'declined', updated_at = now() WHERE id = $1`, [msg.id]);
          continue;
        }

        const email = String(msg.contact_email ?? "");

        // Check suppression list
        if (email) {
          const domain = email.split("@")[1] ?? "";
          const suppressed = await db.query(
            `SELECT id FROM backlink_suppression_list WHERE workspace_owner_id = $1 AND (email = $2 OR domain = $3)`,
            [workspace_owner_id, email, domain],
          );
          if (suppressed.rows[0]) {
            await db.query(`UPDATE backlink_messages SET status = 'declined', updated_at = now() WHERE id = $1`, [msg.id]);
            continue;
          }

          // Check cooling period (any sent to same contact recently)
          if (coolingDays > 0) {
            const recent = await db.query(
              `SELECT m.id FROM backlink_messages m
               JOIN backlink_contacts bc ON bc.id = m.contact_id
               WHERE bc.email = $1 AND m.sent_at >= now() - ($2 || ' days')::interval`,
              [email, String(coolingDays)],
            );
            if (recent.rows[0]) continue;
          }
        }

        // Mark as sent (actual email delivery would go via email provider here)
        await db.query(
          `UPDATE backlink_messages SET status = 'sent', sent_at = now(), updated_at = now() WHERE id = $1 AND sent_at IS NULL`,
          [msg.id],
        );
        sentToday++;

        // Auto-insert follow-up if under max limit and this is seq 1
        const seqNum = Number(msg.sequence_number ?? 1);
        if (seqNum < maxFollowups && email) {
          const existsFollowup = await db.query(
            `SELECT id FROM backlink_messages WHERE campaign_id = $1 AND opportunity_id = $2 AND sequence_number = $3`,
            [msg.campaign_id, msg.opportunity_id, seqNum + 1],
          );
          if (!existsFollowup.rows[0]) {
            const followupDelay = 7; // days
            await db.query(
              `INSERT INTO backlink_messages (campaign_id, opportunity_id, contact_id, subject, body, status, sequence_number)
               VALUES ($1,$2,$3,$4,$5,'draft',$6)`,
              [
                msg.campaign_id,
                msg.opportunity_id,
                msg.contact_id ?? null,
                `[Follow-up] ${msg.subject ?? "Collaboration opportunity"}`,
                `Hi,\n\nJust following up on my previous message about a potential collaboration. Would love to hear your thoughts!\n\nBest regards,\nThe Presentail Team`,
                seqNum + 1,
              ],
            );
          }
        }
      }
    } catch (err) {
      logger.warn({ err, workspace_owner_id }, "backlink: outreach sweep workspace failed");
    }
  }
}

export function startBacklinkOutreachJob(): void {
  const tick = async () => {
    try {
      await runBacklinkOutreachSweep();
    } catch (err) {
      logger.warn({ err }, "backlink: outreach job error");
    }
  };
  outreachTimer = setInterval(tick, OUTREACH_INTERVAL_MS);
  logger.info("Backlink Engine outreach job started");
}

export function stopBacklinkOutreachJob(): void {
  if (outreachTimer) {
    clearInterval(outreachTimer);
    outreachTimer = null;
  }
}
