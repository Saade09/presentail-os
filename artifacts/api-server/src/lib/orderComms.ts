import { db } from "./db";
import { logger } from "./logger";
import type { OrderEmailSendResult } from "./email";
import type { RespondIoSendResult } from "./respondio";

/**
 * Customer Communications tracking — records every outgoing order email or
 * WhatsApp attempt
 * attempt in `order_communications` and mirrors major milestones into the
 * order Activity timeline (`order_events`). Everything here is best-effort /
 * fail-open: a tracking failure must never break the email send or the calling
 * order mutation.
 */

/** Template types recorded for order emails. */
export type OrderCommTemplateType =
  | "order_confirmation"
  | "payment_instructions"
  | "payment_received"
  | "status_update"
  | "delivery_rescheduled"
  | "refund";

export type OrderCommChannel = "email" | "whatsapp" | "tookan";

export const ORDER_COMM_TEMPLATE_TYPES: readonly OrderCommTemplateType[] = [
  "order_confirmation",
  "payment_instructions",
  "payment_received",
  "status_update",
  "delivery_rescheduled",
  "refund",
];

/** Normalized communication statuses (superset of Resend's event types). */
export type OrderCommStatus =
  | "not_sent"
  | "scheduled"
  | "sending"
  | "sent"
  /** Respond.io accepted the message; this is not delivery or read. */
  | "accepted"
  | "deferred"
  | "delivered"
  | "opened"
  | "clicked"
  | "failed"
  | "bounced"
  | "dropped"
  | "suppressed";

/**
 * Ordering used to decide whether an incoming (possibly out-of-order) provider
 * event may overwrite the stored status. Higher rank wins; equal rank never
 * downgrades. Failure states outrank everything so a bounce reported after a
 * "delivered" glitch stays visible.
 */
export const ORDER_COMM_STATUS_RANK: Record<OrderCommStatus, number> = {
  not_sent: 0,
  scheduled: 1,
  sending: 2,
  sent: 3,
  accepted: 3,
  deferred: 4,
  delivered: 5,
  opened: 6,
  clicked: 7,
  failed: 8,
  bounced: 8,
  dropped: 8,
  suppressed: 8,
};

/** True for statuses rendered as failures (red badges) in the UI. */
export function isFailureCommStatus(status: string): boolean {
  return (
    status === "failed" ||
    status === "bounced" ||
    status === "dropped" ||
    status === "suppressed"
  );
}

/**
 * Returns true when a stored status may be replaced by `next` — i.e. `next`
 * strictly outranks `current`. Unknown stored values rank as 0 so real events
 * always win.
 */
export function shouldUpgradeCommStatus(current: string, next: OrderCommStatus): boolean {
  const currentRank = ORDER_COMM_STATUS_RANK[current as OrderCommStatus] ?? 0;
  return ORDER_COMM_STATUS_RANK[next] > currentRank;
}

/**
 * Maps a Resend webhook event type (e.g. "email.delivered") to a normalized
 * communication status. Returns null for irrelevant/unknown event types.
 */
export function mapResendEventType(type: string): OrderCommStatus | null {
  switch (type) {
    case "email.scheduled":
      return "scheduled";
    case "email.sent":
      return "sent";
    case "email.delivered":
      return "delivered";
    case "email.delivery_delayed":
      return "deferred";
    case "email.opened":
      return "opened";
    case "email.clicked":
      return "clicked";
    case "email.bounced":
      return "bounced";
    case "email.complained":
      return "suppressed";
    case "email.failed":
      return "failed";
    default:
      return null;
  }
}

/**
 * Timestamp column set (once, first event wins) when a communication reaches
 * the given status. Failure states only touch last_event_at.
 */
export function timestampColumnForStatus(status: OrderCommStatus): string | null {
  switch (status) {
    case "sent":
      return "sent_at";
    case "delivered":
      return "delivered_at";
    case "opened":
      return "opened_at";
    case "clicked":
      return "clicked_at";
    default:
      return null;
  }
}

/**
 * Best-effort insert into the shared order Activity feed. Mirrors
 * recordOrderEvent in routes/orders.ts but lives here to avoid a lib→routes
 * import cycle; the actor name is passed in directly when known.
 */
export async function recordCommActivityEvent(opts: {
  workspaceOwnerId: string;
  orderId: string;
  eventType: string;
  payload?: Record<string, unknown> | null;
  actorUserId?: string | null;
  actorName?: string | null;
}): Promise<void> {
  try {
    await db.query(
      `INSERT INTO order_events
         (workspace_owner_id, order_id, event_type, payload, actor_user_id, actor_name)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
      [
        opts.workspaceOwnerId,
        opts.orderId,
        opts.eventType,
        opts.payload ? JSON.stringify(opts.payload) : null,
        opts.actorUserId ?? null,
        opts.actorName ?? null,
      ],
    );
  } catch (err) {
    logger.warn(
      { err, orderId: opts.orderId, eventType: opts.eventType },
      "Failed to record communication activity event",
    );
  }
}

export type TrackOrderEmailOpts = {
  workspaceOwnerId: string;
  orderId: string;
  templateType: OrderCommTemplateType;
  recipientRole?: "customer" | "recipient";
  recipientName?: string | null;
  recipientEmail: string | null;
  /** Set for manual sends/resends from the dashboard. */
  triggeredByUserId?: string | null;
  triggeredByName?: string | null;
  /** True when this is a manual resend (records an email_resent activity). */
  isResend?: boolean;
  /** Stable workflow key used to make provider retries safe. */
  idempotencyKey?: string;
};

export type TrackOrderWhatsAppOpts = {
  workspaceOwnerId: string;
  orderId: string;
  /** Canonical UI/API template key, not an unrestricted message body. */
  templateType: string;
  /** Exact approved Respond.io template name sent to the provider. */
  templateName: string;
  recipientRole?: "customer";
  recipientName?: string | null;
  recipientPhone: string | null;
  triggeredByUserId?: string | null;
  triggeredByName?: string | null;
  isResend?: boolean;
  /**
   * A preflight reason means no provider call should be made. The attempt is
   * still recorded so staff can see why an automatic update was unavailable.
   */
  skipReason?: string | null;
};

/**
 * Wraps an order email send with Customer Communications tracking:
 *  - no recipient email → records a `not_sent` row and skips the send,
 *  - otherwise inserts a `sending` attempt row, runs `sendFn`, then updates
 *    the row to sent/failed/not_sent (skipped) with the provider message id,
 *  - mirrors sent/failed/resent milestones into the order Activity feed.
 *
 * Fully fail-open: if any tracking step throws, the send still happens (or its
 * failure is only logged) and callers are never blocked.
 */
export async function trackOrderEmail(
  opts: TrackOrderEmailOpts,
  sendFn: () => Promise<OrderEmailSendResult>,
): Promise<OrderEmailSendResult | null> {
  const role = opts.recipientRole ?? "customer";

  // Missing recipient email — record a not_sent row, nothing to send.
  if (!opts.recipientEmail) {
    try {
      await db.query(
        `INSERT INTO order_communications
           (workspace_owner_id, order_id, template_type, recipient_role,
            recipient_name, recipient_email, status, attempt, failure_reason,
            triggered_by_user_id, triggered_by_name)
         VALUES ($1, $2, $3, $4, $5, NULL, 'not_sent',
                 COALESCE((SELECT MAX(attempt) FROM order_communications
                            WHERE order_id = $2 AND template_type = $3 AND recipient_role = $4), 0) + 1,
                 'No email address', $6, $7)`,
        [
          opts.workspaceOwnerId,
          opts.orderId,
          opts.templateType,
          role,
          opts.recipientName ?? null,
          opts.triggeredByUserId ?? null,
          opts.triggeredByName ?? null,
        ],
      );
    } catch (err) {
      logger.warn(
        { err, orderId: opts.orderId, templateType: opts.templateType },
        "Failed to record not-sent communication",
      );
    }
    return null;
  }

  // Insert the attempt row before sending (fail-open).
  let commId: string | null = null;
  try {
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO order_communications
         (workspace_owner_id, order_id, template_type, recipient_role,
          recipient_name, recipient_email, status, attempt,
          triggered_by_user_id, triggered_by_name, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, 'sending',
               COALESCE((SELECT MAX(attempt) FROM order_communications
                          WHERE order_id = $2 AND template_type = $3 AND recipient_role = $4), 0) + 1,
               $7, $8, $9)
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
       DO NOTHING
       RETURNING id`,
      [
        opts.workspaceOwnerId,
        opts.orderId,
        opts.templateType,
        role,
        opts.recipientName ?? null,
        opts.recipientEmail,
        opts.triggeredByUserId ?? null,
        opts.triggeredByName ?? null,
        opts.idempotencyKey ?? null,
      ],
    );
    commId = inserted.rows[0]?.id ?? null;
    if (!commId && opts.idempotencyKey) {
      const existing = await db.query<{ id: string; status: string }>(
        `SELECT id, status FROM order_communications WHERE idempotency_key = $1 LIMIT 1`,
        [opts.idempotencyKey],
      );
      const row = existing.rows[0];
      if (row && ["sent", "delivered", "opened", "clicked"].includes(row.status)) {
        return null;
      }
      commId = row?.id ?? null;
    }
  } catch (err) {
    logger.warn(
      { err, orderId: opts.orderId, templateType: opts.templateType },
      "Failed to record communication attempt — email still sent",
    );
  }

  let result: OrderEmailSendResult;
  try {
    result = await sendFn();
  } catch (err) {
    // Send helper threw unexpectedly — record the failure and swallow (all
    // existing call sites treat sends as best-effort).
    logger.warn({ err, orderId: opts.orderId }, "Order email send threw");
    if (commId) {
      await updateCommAfterSend(commId, {
        sent: false,
        skipped: false,
        messageId: null,
        errorMessage: err instanceof Error ? err.message : "Send failed",
        subject: "",
      }).catch(() => undefined);
      void recordCommActivityEvent({
        workspaceOwnerId: opts.workspaceOwnerId,
        orderId: opts.orderId,
        eventType: "email_failed",
        payload: { template_type: opts.templateType, to: opts.recipientEmail },
        actorUserId: opts.triggeredByUserId ?? null,
        actorName: opts.triggeredByName ?? null,
      });
    }
    return null;
  }

  if (commId) {
    await updateCommAfterSend(commId, result).catch((err) =>
      logger.warn({ err, commId }, "Failed to update communication after send"),
    );
    const eventType = result.sent
      ? opts.isResend
        ? "email_resent"
        : "email_sent"
      : result.skipped
        ? null
        : "email_failed";
    if (eventType) {
      void recordCommActivityEvent({
        workspaceOwnerId: opts.workspaceOwnerId,
        orderId: opts.orderId,
        eventType,
        payload: {
          template_type: opts.templateType,
          to: opts.recipientEmail,
          subject: result.subject || null,
        },
        actorUserId: opts.triggeredByUserId ?? null,
        actorName: opts.triggeredByName ?? null,
      });
    }
  }

  return result;
}

/**
 * Wraps an approved Respond.io WhatsApp template send with the same
 * fail-open tracking guarantees as email. `accepted` means only that
 * Respond.io accepted the request; provider delivery/read webhooks are a
 * separate concern and therefore do not set those timestamps here.
 */
export async function trackOrderWhatsApp(
  opts: TrackOrderWhatsAppOpts,
  sendFn?: () => Promise<RespondIoSendResult>,
): Promise<RespondIoSendResult | null> {
  const role = opts.recipientRole ?? "customer";
  const isSkipped = Boolean(opts.skipReason) || !opts.recipientPhone;
  let commId: string | null = null;

  try {
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO order_communications
         (workspace_owner_id, order_id, template_type, channel, recipient_role,
          recipient_name, recipient_phone, template_name, provider, status,
          attempt, failure_reason, triggered_by_user_id, triggered_by_name)
       VALUES ($1, $2, $3, 'whatsapp', $4, $5, $6, $7, 'respondio', $8,
               COALESCE((SELECT MAX(attempt) FROM order_communications
                          WHERE order_id = $2 AND template_type = $3
                            AND channel = 'whatsapp' AND recipient_role = $4), 0) + 1,
               $9, $10, $11)
       RETURNING id`,
      [
        opts.workspaceOwnerId,
        opts.orderId,
        opts.templateType,
        role,
        opts.recipientName ?? null,
        opts.recipientPhone ?? null,
        opts.templateName,
        isSkipped ? "not_sent" : "sending",
        opts.skipReason ?? (opts.recipientPhone ? null : "No WhatsApp number"),
        opts.triggeredByUserId ?? null,
        opts.triggeredByName ?? null,
      ],
    );
    commId = inserted.rows[0]?.id ?? null;
  } catch (err) {
    logger.warn(
      { err, orderId: opts.orderId, templateType: opts.templateType },
      "Failed to record WhatsApp communication attempt",
    );
  }

  if (isSkipped || !sendFn) {
    if (commId) {
      void recordCommActivityEvent({
        workspaceOwnerId: opts.workspaceOwnerId,
        orderId: opts.orderId,
        eventType: "whatsapp_not_sent",
        payload: {
          template_type: opts.templateType,
          template_name: opts.templateName,
          to: opts.recipientPhone,
          reason: opts.skipReason ?? "No WhatsApp number",
        },
        actorUserId: opts.triggeredByUserId ?? null,
        actorName: opts.triggeredByName ?? null,
      });
    }
    return null;
  }

  let result: RespondIoSendResult;
  try {
    result = await sendFn();
  } catch (err) {
    result = {
      ok: false,
      retryable: true,
      errorCode: "unexpected_error",
      errorMessage: err instanceof Error ? err.message : "WhatsApp send failed",
    };
  }

  if (commId) {
    try {
      if (result.ok) {
        await db.query(
          `UPDATE order_communications
              SET status = 'accepted', provider_message_id = $2,
                  sent_at = now(), last_event_at = now(), updated_at = now()
            WHERE id = $1`,
          [commId, result.providerRef],
        );
      } else {
        await db.query(
          `UPDATE order_communications
              SET status = 'failed', failure_reason = $2,
                  last_event_at = now(), updated_at = now()
            WHERE id = $1`,
          [commId, result.errorMessage],
        );
      }
    } catch (err) {
      logger.warn({ err, commId }, "Failed to update WhatsApp communication after send");
    }

    void recordCommActivityEvent({
      workspaceOwnerId: opts.workspaceOwnerId,
      orderId: opts.orderId,
      eventType: result.ok
        ? opts.isResend
          ? "whatsapp_resent"
          : "whatsapp_accepted"
        : "whatsapp_failed",
      payload: {
        template_type: opts.templateType,
        template_name: opts.templateName,
        to: opts.recipientPhone,
        provider_ref: result.ok ? result.providerRef : null,
        error: result.ok ? null : result.errorMessage,
      },
      actorUserId: opts.triggeredByUserId ?? null,
      actorName: opts.triggeredByName ?? null,
    });
  }

  return result;
}

/** Updates an attempt row after the provider send completed (or failed). */
async function updateCommAfterSend(
  commId: string,
  result: OrderEmailSendResult,
): Promise<void> {
  if (result.sent) {
    await db.query(
      `UPDATE order_communications
          SET status = 'sent', provider_message_id = $2, subject = $3,
              sent_at = now(), last_event_at = now(), updated_at = now()
        WHERE id = $1`,
      [commId, result.messageId, result.subject || null],
    );
  } else if (result.skipped) {
    await db.query(
      `UPDATE order_communications
          SET status = 'not_sent', failure_reason = $2, subject = $3, updated_at = now()
        WHERE id = $1`,
      [commId, result.errorMessage ?? "Email service not configured", result.subject || null],
    );
  } else {
    await db.query(
      `UPDATE order_communications
          SET status = 'failed', failure_reason = $2, subject = $3,
              last_event_at = now(), updated_at = now()
        WHERE id = $1`,
      [commId, result.errorMessage ?? "Send failed", result.subject || null],
    );
  }
}
