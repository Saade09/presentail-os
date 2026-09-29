import { Router, type Request, type Response } from "express";
import { Webhook } from "svix";
import { db } from "../lib/db";
import { getResendClient } from "../lib/email";
import { logger } from "../lib/logger";
import { broadcastEvent } from "../lib/eventsSse";
import {
  mapResendEventType,
  shouldUpgradeCommStatus,
  timestampColumnForStatus,
  isFailureCommStatus,
  recordCommActivityEvent,
  type OrderCommStatus,
} from "../lib/orderComms";
import {
  processSupplierStatementResendStatus,
  processSupplierStatementResendInbound,
  isSupplierStatementPayload,
  isSupplierStatementReceivingAddress,
  type ResendReceivedEmail,
} from "../lib/supplierStatementDelivery";

const router = Router();

type RawRequest = Request & { rawBody?: Buffer };
const MAX_SUPPLIER_ATTACHMENT_BYTES = 20 * 1024 * 1024;

async function readBoundedAttachment(response: globalThis.Response): Promise<Buffer> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_SUPPLIER_ATTACHMENT_BYTES) {
    throw new Error("attachment_too_large");
  }
  if (!response.body) throw new Error("attachment_body_missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_SUPPLIER_ATTACHMENT_BYTES) throw new Error("attachment_too_large");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

/**
 * POST /api/webhooks/resend
 * Receives Resend email delivery events (svix-signed), verified against
 * RESEND_WEBHOOK_SECRET. Matches events to order_communications rows via
 * provider_message_id (data.email_id), appends an idempotent event-ledger row
 * (unique svix-id), upgrades the row's status by precedence rank so
 * out-of-order deliveries never downgrade, sets per-status timestamps once,
 * and mirrors the first delivered/opened/failure transition into the order
 * Activity feed.
 */
router.post("/webhooks/resend", async (req: RawRequest, res: Response) => {
  const webhookSecret = process.env.RESEND_WEBHOOK_SECRET;
  if (!webhookSecret) {
    logger.warn("RESEND_WEBHOOK_SECRET not set — Resend webhook handler is disabled");
    res.status(503).json({ error: "Resend webhook not configured" });
    return;
  }

  const svixId = req.headers["svix-id"] as string | undefined;
  const svixTimestamp = req.headers["svix-timestamp"] as string | undefined;
  const svixSignature = req.headers["svix-signature"] as string | undefined;
  if (!svixId || !svixTimestamp || !svixSignature) {
    res.status(400).json({ error: "Missing svix headers" });
    return;
  }

  const rawBody = req.rawBody;
  if (!rawBody || rawBody.length === 0) {
    res.status(400).json({ error: "Missing request body" });
    return;
  }

  let payload: Record<string, unknown>;
  try {
    const wh = new Webhook(webhookSecret);
    payload = wh.verify(rawBody, {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    }) as Record<string, unknown>;
  } catch (err) {
    logger.warn({ err }, "Resend webhook signature verification failed");
    res.status(400).json({ error: "Invalid signature" });
    return;
  }

  const rawType = typeof payload["type"] === "string" ? (payload["type"] as string) : "";
  const data = (payload["data"] ?? {}) as Record<string, unknown>;
  const emailId = typeof data["email_id"] === "string" ? (data["email_id"] as string) : null;

  if (rawType === "email.received") {
    if (!emailId) {
      res.json({ received: true, ignored: true, reason: "missing_email_id" });
      return;
    }
    try {
      const resend = getResendClient();
      const received = await resend.emails.receiving.get(emailId);
      if (received.error || !received.data) {
        throw new Error(received.error?.message || "Resend received email could not be loaded");
      }
      const email = received.data;
      if (!isSupplierStatementReceivingAddress(email.to)) {
        res.json({ received: true, ignored: true });
        return;
      }
      const attachments: ResendReceivedEmail["attachments"] = [];
      for (const attachment of email.attachments ?? []) {
        try {
          const downloaded = await resend.emails.receiving.attachments.get({
            emailId,
            id: attachment.id,
          });
          if (downloaded.error || !downloaded.data?.download_url) {
            throw new Error(downloaded.error?.message || "attachment_download_url_missing");
          }
          if (downloaded.data.size > MAX_SUPPLIER_ATTACHMENT_BYTES) {
            attachments.push({
              ...attachment,
              bytes: undefined,
              download_error: "attachment_too_large",
            });
            continue;
          }
          const response = await fetch(downloaded.data.download_url);
          if (!response.ok) {
            throw new Error(`attachment_download_failed_${response.status}`);
          }
          const bytes = await readBoundedAttachment(response);
          attachments.push({ ...attachment, bytes });
        } catch (error) {
          if (error instanceof Error && error.message === "attachment_too_large") {
            attachments.push({ ...attachment, bytes: undefined, download_error: "attachment_too_large" });
          } else {
            throw error;
          }
        }
      }
      const result = await processSupplierStatementResendInbound({
        providerEventId: svixId,
        providerEmailId: emailId,
        email: {
          ...email,
          attachments,
        } as ResendReceivedEmail,
      });
      res.json({
        received: true,
        ...(result.handled ? { namespace: "supplier_statement_collection" } : { ignored: true }),
        ...(result.duplicate !== undefined ? { duplicate: result.duplicate } : {}),
        ...(result.classification ? { classification: result.classification } : {}),
      });
    } catch (err) {
      logger.error({ err, emailId }, "Error processing Resend received email");
      res.status(503).json({ error: "received_email_processing_unavailable" });
    }
    return;
  }

  const status = mapResendEventType(rawType);
  if (!status) {
    res.json({ received: true });
    return;
  }

  if (!emailId) {
    res.json({ received: true });
    return;
  }
  const resendOccurredAtRaw = payload["created_at"];
  const resendOccurredAt =
    typeof resendOccurredAtRaw === "string" && !Number.isNaN(Date.parse(resendOccurredAtRaw))
      ? new Date(resendOccurredAtRaw)
      : new Date();
  if (isSupplierStatementPayload(payload)) {
    await processSupplierStatementResendStatus({
      providerMessageId: emailId,
      providerEventId: svixId,
      status,
      payload,
      occurredAt: resendOccurredAt,
    });
    res.json({ received: true, namespace: "supplier_statement_collection" });
    return;
  }

  try {
    const commResult = await db.query<{
      id: string;
      workspace_owner_id: string;
      order_id: string;
      template_type: string;
      recipient_email: string | null;
      status: string;
      delivered_at: Date | null;
      opened_at: Date | null;
      clicked_at: Date | null;
    }>(
      `SELECT id, workspace_owner_id, order_id, template_type, recipient_email,
              status, delivered_at, opened_at, clicked_at
         FROM order_communications
        WHERE provider_message_id = $1
        LIMIT 1`,
      [emailId],
    );
    const comm = commResult.rows[0];
    if (!comm) {
      // Not one of our tracked order emails (e.g. staff/internal email).
      res.json({ received: true });
      return;
    }

    const occurredAtRaw = payload["created_at"];
    const occurredAt =
      typeof occurredAtRaw === "string" && !Number.isNaN(Date.parse(occurredAtRaw))
        ? new Date(occurredAtRaw)
        : new Date();

    // Store a minimal normalized payload (never raw HTML or full headers).
    const eventPayload: Record<string, unknown> = {};
    if (Array.isArray(data["to"])) eventPayload.to = data["to"];
    if (typeof data["subject"] === "string") eventPayload.subject = data["subject"];
    const bounce = data["bounce"] as Record<string, unknown> | undefined;
    if (bounce && typeof bounce === "object") eventPayload.bounce = bounce;
    if (typeof data["failed"] === "object" && data["failed"]) eventPayload.failed = data["failed"];

    // Idempotent event insert — duplicate svix deliveries are dropped here.
    const inserted = await db.query(
      `INSERT INTO order_communication_events
         (communication_id, provider_event_id, event_type, raw_type, occurred_at, payload)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (provider_event_id) WHERE provider_event_id IS NOT NULL
       DO NOTHING`,
      [comm.id, svixId, status, rawType, occurredAt, JSON.stringify(eventPayload)],
    );
    if ((inserted.rowCount ?? 0) === 0) {
      res.json({ received: true, duplicate: true });
      return;
    }

    // Rank-based status upgrade (never downgrade on out-of-order events).
    const upgrade = shouldUpgradeCommStatus(comm.status, status);

    // Per-status timestamps are set once (first event wins) even when the
    // status itself doesn't move (e.g. late "delivered" after "opened").
    const tsCol = timestampColumnForStatus(status);
    const setClauses: string[] = ["last_event_at = GREATEST(COALESCE(last_event_at, $2), $2)", "updated_at = now()"];
    const params: unknown[] = [comm.id, occurredAt];
    if (upgrade) {
      params.push(status);
      setClauses.push(`status = $${params.length}`);
      if (isFailureCommStatus(status)) {
        params.push(bounce && typeof bounce["message"] === "string" ? (bounce["message"] as string) : rawType);
        setClauses.push(`failure_reason = COALESCE($${params.length}, failure_reason)`);
      }
    }
    if (tsCol) {
      setClauses.push(`${tsCol} = COALESCE(${tsCol}, $2)`);
    }
    await db.query(
      `UPDATE order_communications SET ${setClauses.join(", ")} WHERE id = $1`,
      params,
    );

    // Broadcast SSE so the Order Detail card refreshes in real time.
    if (upgrade) {
      broadcastEvent(comm.workspace_owner_id, {
        event: "order.comm_status_updated",
        workspaceId: comm.workspace_owner_id,
        data: {
          orderId: comm.order_id,
          communicationId: comm.id,
          status,
        },
      });
    }

    // Activity timeline: record only the FIRST transition into a milestone
    // state to avoid noisy duplicates.
    const firstDelivered = status === "delivered" && !comm.delivered_at;
    const firstOpened = status === "opened" && !comm.opened_at;
    const failure = isFailureCommStatus(status) && upgrade;
    const activityType = firstDelivered
      ? "email_delivered"
      : firstOpened
        ? "email_opened"
        : failure
          ? status === "bounced"
            ? "email_bounced"
            : "email_failed"
          : null;
    if (activityType) {
      await recordCommActivityEvent({
        workspaceOwnerId: comm.workspace_owner_id,
        orderId: comm.order_id,
        eventType: activityType,
        payload: { template_type: comm.template_type, to: comm.recipient_email },
      });
    }
  } catch (err) {
    logger.error({ err, emailId }, "Error processing Resend webhook event");
  }

  res.json({ received: true });
});

export default router;
