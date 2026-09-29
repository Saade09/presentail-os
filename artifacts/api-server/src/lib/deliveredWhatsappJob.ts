import { db } from "./db";
import { logger } from "./logger";
import { notifyDeliveredOrderWhatsApp } from "./orderWhatsappNotify";

/**
 * Delayed WhatsApp "order delivered" notification queue.
 *
 * When an order transitions to `completed`, instead of immediately sending the
 * `order_delivered` WhatsApp template, a row is inserted into
 * `whatsapp_delivered_notifications` with `send_at = now() + 3 minutes`.
 *
 * A periodic sweep picks up due rows, atomically claims them, calls
 * `notifyDeliveredOrderWhatsApp(…)`, and marks the row `sent`.
 * Failed rows are retried with short back-off up to MAX_ATTEMPTS; after
 * exhaustion or a non-retryable outcome they are marked `failed`.
 *
 * The 3-minute window gives staff a brief review period before the customer
 * is notified. If the server restarts within those 3 minutes, the pending row
 * survives in the database and the notification is sent once the delay elapses.
 */

export const MAX_DELIVERED_WHATSAPP_ATTEMPTS = 3;

/** Backoff schedule (minutes) indexed by the attempt count AFTER the failure. */
const BACKOFF_MINUTES = [1, 5];

const SWEEP_INTERVAL_MS = 30_000;

/** Rows stuck in `processing` longer than this are reclaimed by the sweep. */
const STUCK_PROCESSING_MINUTES = 10;

export function backoffMinutesForDeliveredAttempt(attemptCount: number): number {
  const idx = Math.min(Math.max(attemptCount - 1, 0), BACKOFF_MINUTES.length - 1);
  return BACKOFF_MINUTES[idx];
}

/**
 * Enqueue a delayed `order_delivered` WhatsApp notification for one order.
 * Fire-and-forget safe: never throws.
 * Uses ON CONFLICT(order_id) DO NOTHING so repeat completions are idempotent.
 */
export async function enqueueDeliveredWhatsappNotification(
  orderId: string,
  orderNumber: string,
  workspaceOwnerId: string,
): Promise<void> {
  try {
    const result = await db.query(
      `INSERT INTO whatsapp_delivered_notifications
         (order_id, workspace_owner_id, order_number, status,
          send_at, next_attempt_at)
       VALUES ($1, $2, $3, 'pending',
               now() + INTERVAL '3 minutes',
               now() + INTERVAL '3 minutes')
       ON CONFLICT (order_id) DO NOTHING`,
      [orderId, workspaceOwnerId, orderNumber],
    );
    if ((result.rowCount ?? 0) > 0) {
      logger.info(
        { orderId, orderNumber, workspaceOwnerId },
        "delivered-whatsapp: notification enqueued (3-minute delay)",
      );
    } else {
      logger.info(
        { orderId },
        "delivered-whatsapp: enqueue skipped — row already exists (idempotent)",
      );
    }
  } catch (err) {
    logger.warn({ err, orderId }, "delivered-whatsapp: failed to enqueue notification");
  }
}

type NotificationRow = {
  id: string;
  order_id: string;
  workspace_owner_id: string;
  order_number: string;
  attempt_count: number;
};

/**
 * Atomically claim and process one pending/due notification row.
 * The claim UPDATE only matches rows that are due (next_attempt_at <= now())
 * so the 3-minute delay is enforced at the database level.
 */
export async function processDeliveredNotification(notificationId: string): Promise<void> {
  logger.info({ notificationId }, "delivered-whatsapp: process attempt started — claiming row");

  const claim = await db.query<NotificationRow>(
    `UPDATE whatsapp_delivered_notifications
        SET status = 'processing', updated_at = now()
      WHERE id = $1
        AND status IN ('pending', 'processing')
        AND next_attempt_at <= now()
        AND (
          status = 'pending'
          OR (status = 'processing' AND updated_at < now() - INTERVAL '${STUCK_PROCESSING_MINUTES} minutes')
        )
      RETURNING id, order_id, workspace_owner_id, order_number, attempt_count`,
    [notificationId],
  );

  const row = claim.rows[0];
  if (!row) {
    logger.info(
      { notificationId },
      "delivered-whatsapp: claim skipped — row not claimable (not pending/due or already claimed)",
    );
    return;
  }

  logger.info(
    { notificationId: row.id, orderId: row.order_id, attemptCount: row.attempt_count },
    "delivered-whatsapp: row claimed for processing",
  );

  try {
    const result = await notifyDeliveredOrderWhatsApp(
      row.order_id,
      row.order_number,
      row.workspace_owner_id,
    );

    // notifyDeliveredOrderWhatsApp returns null for skipped (no consent, no phone,
    // provider not configured, etc.) — these are not failures: mark sent so we
    // don't keep retrying permanently.
    const ok = result === null || result.ok === true;
    const isRetryable =
      result !== null &&
      result.ok === false &&
      (result as { retryable?: boolean }).retryable === true;
    const attempts = row.attempt_count + 1;

    if (ok || (!isRetryable && result !== null && result.ok === false)) {
      // Success (null = skipped/no-op) or non-retryable failure → mark sent/failed
      const finalStatus = ok ? "sent" : "failed";
      const lastError =
        result !== null && result.ok === false
          ? (result as { errorMessage?: string }).errorMessage?.slice(0, 2000) ?? null
          : null;
      await db.query(
        `UPDATE whatsapp_delivered_notifications
            SET status = $2,
                attempt_count = $3,
                last_error = $4,
                last_attempt_at = now(),
                updated_at = now()
          WHERE id = $1`,
        [row.id, finalStatus, attempts, lastError],
      );
      logger.info(
        { notificationId: row.id, orderId: row.order_id, finalStatus },
        `delivered-whatsapp: notification ${finalStatus}`,
      );
      return;
    }

    // Retryable failure
    if (attempts >= MAX_DELIVERED_WHATSAPP_ATTEMPTS) {
      // Exhausted — mark failed
      const errorMessage =
        result !== null && result.ok === false
          ? (result as { errorMessage?: string }).errorMessage?.slice(0, 2000) ?? "Max attempts reached"
          : "Max attempts reached";
      await db.query(
        `UPDATE whatsapp_delivered_notifications
            SET status = 'failed',
                attempt_count = $2,
                last_error = $3,
                last_attempt_at = now(),
                updated_at = now()
          WHERE id = $1`,
        [row.id, attempts, errorMessage],
      );
      logger.warn(
        { notificationId: row.id, orderId: row.order_id, attempts },
        "delivered-whatsapp: notification failed permanently (max attempts reached)",
      );
    } else {
      const backoff = backoffMinutesForDeliveredAttempt(attempts);
      const errorMessage =
        result !== null && result.ok === false
          ? (result as { errorMessage?: string }).errorMessage?.slice(0, 2000) ?? "Retryable failure"
          : "Retryable failure";
      await db.query(
        `UPDATE whatsapp_delivered_notifications
            SET status = 'pending',
                attempt_count = $2,
                last_error = $3,
                next_attempt_at = now() + ($4 || ' minutes')::interval,
                last_attempt_at = now(),
                updated_at = now()
          WHERE id = $1`,
        [row.id, attempts, errorMessage, String(backoff)],
      );
      logger.warn(
        { notificationId: row.id, orderId: row.order_id, backoffMinutes: backoff, attempts },
        "delivered-whatsapp: notification attempt failed — will retry",
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const attempts = row.attempt_count + 1;
    logger.warn({ err, notificationId: row.id, orderId: row.order_id }, "delivered-whatsapp: unexpected error during processing");

    if (attempts >= MAX_DELIVERED_WHATSAPP_ATTEMPTS) {
      await db.query(
        `UPDATE whatsapp_delivered_notifications
            SET status = 'failed',
                attempt_count = $2,
                last_error = $3,
                last_attempt_at = now(),
                updated_at = now()
          WHERE id = $1`,
        [row.id, attempts, message.slice(0, 2000)],
      );
    } else {
      const backoff = backoffMinutesForDeliveredAttempt(attempts);
      await db.query(
        `UPDATE whatsapp_delivered_notifications
            SET status = 'pending',
                attempt_count = $2,
                last_error = $3,
                next_attempt_at = now() + ($4 || ' minutes')::interval,
                last_attempt_at = now(),
                updated_at = now()
          WHERE id = $1`,
        [row.id, attempts, message.slice(0, 2000), String(backoff)],
      );
    }
  }
}

/** Sweep: process up to 20 due pending (or stuck-processing) notifications. */
export async function runDeliveredWhatsappSweep(): Promise<void> {
  const due = await db.query<{ id: string }>(
    `SELECT id FROM whatsapp_delivered_notifications
      WHERE (
              status = 'pending'
              OR (status = 'processing' AND updated_at < now() - INTERVAL '${STUCK_PROCESSING_MINUTES} minutes')
            )
        AND next_attempt_at <= now()
      ORDER BY next_attempt_at ASC
      LIMIT 20`,
  );
  for (const { id } of due.rows) {
    try {
      await processDeliveredNotification(id);
    } catch (err) {
      logger.warn({ err, notificationId: id }, "delivered-whatsapp: sweep processing failed");
    }
  }
}

export function startDeliveredWhatsappJob(): void {
  const tick = async () => {
    try {
      await runDeliveredWhatsappSweep();
    } catch (err) {
      logger.warn({ err }, "delivered-whatsapp job error");
    }
  };
  setInterval(tick, SWEEP_INTERVAL_MS);
  setTimeout(tick, 15_000);
  logger.info("Delivered WhatsApp notification background job started");
}
