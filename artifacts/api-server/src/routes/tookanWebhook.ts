import { Router, type Request, type Response } from "express";
import { timingSafeEqual } from "crypto";
import { logger } from "../lib/logger";
import { fireWebhookEvent } from "../lib/catalogWebhook";
import { parseTookanCompletionDatetime, syncTookanOrderStatus, syncTookanBranchRequestStatus } from "../lib/tookan";
import { notifyOrderStatusEmail, recordOrderEvent } from "./orders";
import { notifyOrderStatusWhatsApp } from "../lib/orderWhatsappNotify";
import { enqueueDeliveredWhatsappNotification } from "../lib/deliveredWhatsappJob";
import { maybeEnqueueTrustpilotInvitation } from "../lib/trustpilotInvitations";

const router = Router();

/**
 * Constant-time comparison of the provided secret against the configured one.
 * Both sides are trimmed first: a trailing newline/space accidentally pasted
 * into the deployment secret or the Tookan webhook URL is the most common cause
 * of an otherwise-correct secret failing (length mismatch → 401), and
 * surrounding whitespace is never a meaningful part of a shared secret.
 */
function secretMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided.trim());
  const b = Buffer.from(expected.trim());
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * POST /api/webhooks/tookan
 *
 * Receives Tookan task status updates and syncs them back onto the matching OS
 * order (looked up by tookan_job_id). When the Tookan status is in the
 * assignment family (assigned, started, in_progress, accepted), the order is
 * moved to `out_for_delivery`; when it is "Successful" (job_status 2), the
 * order is marked `completed` in Presentail OS.
 *
 * Auth: Tookan does not sign its webhooks, so we require a shared secret
 * (TOOKAN_WEBHOOK_SECRET) passed in the `x-tookan-webhook-secret` header.
 * Secrets in query parameters are deliberately not accepted because URLs are
 * routinely captured in access logs and other infrastructure telemetry. When
 * the secret is not configured the endpoint returns 503 (mirrors the Stripe
 * webhook), so we never process unauthenticated webhook traffic.
 */
router.post("/webhooks/tookan", async (req: Request, res: Response) => {
  const secret = process.env.TOOKAN_WEBHOOK_SECRET;
  if (!secret) {
    res.status(503).json({ error: "Tookan webhook not configured" });
    return;
  }

  const headerSecret = req.headers["x-tookan-webhook-secret"];
  const provided = typeof headerSecret === "string" ? headerSecret : undefined;

  if (!secretMatches(provided, secret)) {
    // Diagnose secret mismatches from logs WITHOUT ever logging the secret
    // values: whether one was supplied and the trimmed lengths. A length
    // mismatch here is the tell-tale sign of a stale/rotated deployment secret
    // or a copy-paste error in the Tookan configuration.
    logger.warn(
      {
        providedPresent: provided !== undefined,
        providedLength: provided?.trim().length ?? 0,
        expectedLength: secret.trim().length,
      },
      "tookan webhook: rejected — secret mismatch",
    );
    res.status(401).json({ error: "Invalid webhook secret" });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const jobIdRaw = body.job_id ?? body.jobId;
  const jobStatusRaw = body.job_status ?? body.jobStatus;
  const jobId = jobIdRaw === null || jobIdRaw === undefined ? "" : String(jobIdRaw);
  const jobStatus = Number(jobStatusRaw);

  // TEMPORARY (debugging): log the full incoming Tookan payload so the exact
  // field names and status codes Tookan sends can be confirmed from production
  // logs. The secret travels in the URL/header, never the body, so no secret is
  // exposed here. Remove or lower to debug level once the mapping is verified.
  logger.info({ body }, "tookan webhook: full payload (debug)");

  // Structured summary of the delivery-relevant fields; `fields` lists all body
  // keys to surface any fleet/agent field naming.
  logger.info(
    {
      jobId,
      jobStatus,
      jobStatusRaw,
      fleetId: body.fleet_id ?? body.fleetId ?? null,
      fleetName: body.fleet_name ?? body.fleetName ?? null,
      agentId: body.agent_id ?? body.agentId ?? null,
      fields: Object.keys(body),
    },
    "tookan webhook: received status update",
  );

  if (!jobId || Number.isNaN(jobStatus)) {
    res.status(400).json({ error: "Missing or invalid job_id / job_status" });
    return;
  }

  try {
    const result = await syncTookanOrderStatus(
      jobId,
      jobStatus,
      parseTookanCompletionDatetime(body),
    );

    // Also sync branch-request status — unmatched lookups are silent no-ops.
    const branchResult = await syncTookanBranchRequestStatus(jobId, jobStatus, "tookan_webhook");
    if (branchResult.matched) {
      logger.info(
        { jobId, jobStatus, requestId: branchResult.requestId, newStatus: branchResult.newStatus },
        "tookan webhook: branch request sync result",
      );
    }

    if (!result.matched && !branchResult.matched) {
      logger.info({ jobId, jobStatus }, "tookan webhook: no matching order or branch request for job_id");
      res.json({ received: true, matched: false });
      return;
    }

    const statusChanged = result.newStatus !== null || branchResult.newStatus !== null;

    if (statusChanged && result.workspaceOwnerId && result.orderId) {
      // Attributable activity record so the Tookan-driven transition shows up
      // in the order detail Activity feed (actor is the system, not a user).
      recordOrderEvent({
        workspaceOwnerId: result.workspaceOwnerId,
        orderId: result.orderId,
        eventType: "status_changed",
        payload: { from: result.previousStatus, to: result.newStatus, source: "tookan_webhook" },
      });
      void fireWebhookEvent("order.status_updated", result.workspaceOwnerId, {
        orderId: result.orderId,
        appOrderId: result.externalOrderId ?? null,
        status: result.newStatus,
        updatedAt: new Date().toISOString(),
      });
      // Customer-facing status email (out for delivery / delivered) —
      // best-effort, fire-and-forget so a send failure never fails the webhook.
      notifyOrderStatusEmail(
        result.orderId,
        result.externalOrderId ?? result.orderId,
        result.newStatus!,
        result.workspaceOwnerId,
      ).catch((err) =>
        logger.warn({ err, orderId: result.orderId }, "tookan webhook: status email failed"),
      );
      if (result.newStatus === "completed") {
        void enqueueDeliveredWhatsappNotification(
          result.orderId,
          result.externalOrderId ?? result.orderId,
          result.workspaceOwnerId,
        );
      } else {
        void notifyOrderStatusWhatsApp(
          result.orderId,
          result.externalOrderId ?? result.orderId,
          result.newStatus!,
          result.workspaceOwnerId,
        );
      }
      // Trustpilot service-review invitation — only fires on a genuine
      // transition INTO completed; the queue dedupes per order. Best-effort.
      void maybeEnqueueTrustpilotInvitation(
        result.orderId,
        result.previousStatus,
        result.newStatus,
      );
    }

    res.json({ received: true, matched: result.matched || branchResult.matched, statusChanged });
  } catch (err) {
    logger.error({ err, jobId }, "tookan webhook: failed to sync order status");
    res.status(500).json({ error: "Internal error" });
  }
});

export default router;
