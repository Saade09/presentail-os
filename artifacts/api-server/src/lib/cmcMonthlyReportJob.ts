import { db } from "./db";
import { logger } from "./logger";
import { computeMonthlySales } from "./cmcMonthlySales";
import { generateCmcMonthlySalesPdf } from "./cmcMonthlySalesPdf";
import { sendCmcMonthlyReportEmail } from "./email";

const JOB_INTERVAL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;

const BACKOFF_MINUTES = [1, 5, 15, 60, 240];

function previousMonthLabel(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  if (month === 0) {
    return `${year - 1}-12`;
  }
  return `${year}-${String(month).padStart(2, "0")}`;
}

function currentMonthLabel(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function isFirstOfMonth(): boolean {
  return new Date().getUTCDate() === 1;
}

type Recipient = { userId: string; email: string; workspaceOwnerId: string };
type PendingDelivery = {
  id: number;
  workspaceOwnerId: string;
  reportMonth: string;
  email: string;
};

async function resolveRecipients(workspaceOwnerId: string): Promise<Recipient[]> {
  const result = await db.query(
    `SELECT DISTINCT m.member_user_id AS user_id, m.email
       FROM workspace_members m
      WHERE m.workspace_owner_id = $1
        AND m.member_user_id IS NOT NULL
        AND m.email IS NOT NULL
        AND (
          m.workspace_role = 'owner'
          OR m.allowed_pages @> '["cmc-pos"]'::jsonb
          OR m.allowed_pages @> '["cmc_pos.audit"]'::jsonb
          OR m.allowed_pages @> '["cmc_pos.monthly_sales"]'::jsonb
        )`,
    [workspaceOwnerId],
  );
  return result.rows.map((r) => ({
    userId: r.user_id as string,
    email: r.email as string,
    workspaceOwnerId,
  }));
}

async function getWorkspacesWithCmcPos(): Promise<string[]> {
  const result = await db.query(
    `SELECT DISTINCT workspace_owner_id FROM cmc_sales LIMIT 500`,
    [],
  );
  return result.rows.map((r) => r.workspace_owner_id as string);
}

export async function processCmcMonthlyReportDelivery(
  delivery: PendingDelivery,
): Promise<void> {
  try {
    const salesData = await computeMonthlySales(
      delivery.workspaceOwnerId,
      "single",
      delivery.reportMonth,
    );
    const pdfBuffer = await generateCmcMonthlySalesPdf(delivery.reportMonth, salesData);
    const providerMessageId = await sendCmcMonthlyReportEmail({
      toEmail: delivery.email,
      reportMonth: delivery.reportMonth,
      salesData,
      pdfBuffer,
    });

    await db.query(
      `UPDATE cmc_monthly_report_deliveries
          SET status = 'sent', sent_at = now(), provider_message_id = $1
        WHERE id = $2 AND status = 'processing'`,
      [providerMessageId, delivery.id],
    );
    logger.info(
      {
        email: delivery.email,
        reportMonth: delivery.reportMonth,
        workspaceOwnerId: delivery.workspaceOwnerId,
      },
      "CMC monthly report email sent",
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await db.query(
      `UPDATE cmc_monthly_report_deliveries
          SET status = 'failed', failure_reason = $1
        WHERE id = $2 AND status = 'processing'`,
      [reason.slice(0, 500), delivery.id],
    );
    logger.error(
      { err, email: delivery.email, reportMonth: delivery.reportMonth },
      "CMC monthly report: email send failed",
    );
  }
}

async function processPendingDeliveries(): Promise<void> {
  const pendingRows = await db.query(
    `SELECT id, workspace_owner_id, report_month, recipient_email
       FROM cmc_monthly_report_deliveries
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT 50`,
    [],
  );

  for (const row of pendingRows.rows) {
    const deliveryId = row.id as number;
    const claim = await db.query(
      `UPDATE cmc_monthly_report_deliveries
          SET status = 'processing', attempt_count = attempt_count + 1, last_attempt_at = now()
        WHERE id = $1 AND status = 'pending'`,
      [deliveryId],
    );

    // Another API instance may have claimed this row between SELECT and UPDATE.
    if (claim.rowCount === 0) continue;

    await processCmcMonthlyReportDelivery({
      id: deliveryId,
      workspaceOwnerId: row.workspace_owner_id as string,
      reportMonth: row.report_month as string,
      email: row.recipient_email as string,
    });
  }
}

async function runMonthlyReport(
  workspaceOwnerId: string,
  reportMonth: string,
): Promise<void> {
  const recipients = await resolveRecipients(workspaceOwnerId);
  if (recipients.length === 0) {
    logger.info({ workspaceOwnerId, reportMonth }, "CMC monthly report: no recipients, skipping");
    return;
  }

  for (const r of recipients) {
    await db.query(
      `INSERT INTO cmc_monthly_report_deliveries
         (workspace_owner_id, report_month, recipient_user_id, recipient_email, status)
       VALUES ($1, $2, $3, $4, 'pending')
       ON CONFLICT (workspace_owner_id, report_month, recipient_user_id) DO NOTHING`,
      [workspaceOwnerId, reportMonth, r.userId, r.email],
    );
  }

  await processPendingDeliveries();
}

export async function retryFailedDeliveries(): Promise<void> {
  const now = new Date();
  const failedRows = await db.query(
    `SELECT id, workspace_owner_id, report_month, recipient_user_id, recipient_email, attempt_count, last_attempt_at
       FROM cmc_monthly_report_deliveries
      WHERE status = 'failed'
        AND attempt_count < $1
      LIMIT 50`,
    [MAX_ATTEMPTS],
  );

  for (const row of failedRows.rows) {
    const attemptCount = row.attempt_count as number;
    const backoffMin = BACKOFF_MINUTES[
      Math.max(0, Math.min(attemptCount - 1, BACKOFF_MINUTES.length - 1))
    ];
    const lastAttempt = row.last_attempt_at ? new Date(row.last_attempt_at as string) : new Date(0);
    const nextRetryAt = new Date(lastAttempt.getTime() + backoffMin * 60 * 1000);
    if (now < nextRetryAt) continue;

    await db.query(
      `UPDATE cmc_monthly_report_deliveries SET status = 'pending' WHERE id = $1 AND status = 'failed'`,
      [row.id],
    );
  }
}

async function catchUpIfMissed(): Promise<void> {
  const prevMonth = previousMonthLabel();
  const workspaces = await getWorkspacesWithCmcPos();

  for (const wid of workspaces) {
    const existing = await db.query(
      `SELECT COUNT(*) AS cnt FROM cmc_monthly_report_deliveries WHERE workspace_owner_id = $1 AND report_month = $2`,
      [wid, prevMonth],
    );
    const cnt = parseInt(existing.rows[0]?.cnt ?? "0");
    if (cnt === 0) {
      logger.info({ workspaceOwnerId: wid, prevMonth }, "CMC monthly report: catch-up running for missed month");
      try {
        await runMonthlyReport(wid, prevMonth);
      } catch (err) {
        logger.error({ err, workspaceOwnerId: wid, prevMonth }, "CMC monthly report catch-up failed");
      }
    }
  }
}

async function tick(): Promise<void> {
  try {
    await retryFailedDeliveries();

    if (isFirstOfMonth()) {
      const prevMonth = previousMonthLabel();
      const workspaces = await getWorkspacesWithCmcPos();
      for (const wid of workspaces) {
        try {
          await runMonthlyReport(wid, prevMonth);
        } catch (err) {
          logger.error({ err, workspaceOwnerId: wid, prevMonth }, "CMC monthly report tick failed");
        }
      }
    }

    // This also handles rows made pending by retryFailedDeliveries on non-first
    // days, and rows left pending after a transient startup failure.
    await processPendingDeliveries();
  } catch (err) {
    logger.error({ err }, "CMC monthly report job tick error");
  }
}

export function startCmcMonthlyReportJob(): void {
  logger.info("CMC monthly report job started");

  void catchUpIfMissed().catch((err) => {
    logger.error({ err }, "CMC monthly report catch-up error on startup");
  });

  setInterval(() => { void tick(); }, JOB_INTERVAL_MS);
}

export { runMonthlyReport, resolveRecipients, previousMonthLabel, currentMonthLabel, isFirstOfMonth };
