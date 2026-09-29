import { db } from "./db";
import { logger } from "./logger";
import {
  isTookanEnabled,
  getTookanJobStatuses,
  syncTookanOrderStatus,
  syncTookanBranchRequestStatus,
  tookanStatusLabel,
} from "./tookan";
import { fireWebhookEvent } from "./catalogWebhook";
import { notifyOrderStatusEmail, recordOrderEvent } from "../routes/orders";
import { notifyOrderStatusWhatsApp } from "./orderWhatsappNotify";
import { enqueueDeliveredWhatsappNotification } from "./deliveredWhatsappJob";
import { maybeEnqueueTrustpilotInvitation } from "./trustpilotInvitations";

const JOB_INTERVAL_MS = 2 * 60 * 1000;

/**
 * Max Tookan jobs polled per tick. Bounds both the DB query and the single
 * get_job_details batch call.
 */
const MAX_JOBS_PER_TICK = 50;

/**
 * Safety net for Tookan status transitions that never arrive as webhooks.
 * Tookan's Delivery Notifications have no "Agent Assigned" webhook event, so
 * a task created unassigned and later assigned to an agent from the Tookan
 * dashboard produces no webhook until the driver taps Start. This job polls
 * the live job_status for recent, non-terminal orders that have a Tookan task
 * and applies the same sync + side effects as the webhook route whenever the
 * stored Tookan status label is stale.
 *
 * Also polls non-terminal cmc_requests (branch requests) with a tookan_job_id
 * so driver-assignment transitions propagate even when no webhook fires.
 */
export async function runTookanStatusPoll(): Promise<void> {
  if (!isTookanEnabled()) return;

  const res = await db.query<{
    id: string;
    tookan_job_id: string;
    status: string;
    tookan_status: string | null;
  }>(
    `SELECT id, tookan_job_id, status, tookan_status
       FROM orders
      WHERE tookan_job_id IS NOT NULL
        AND status NOT IN ('completed', 'cancelled', 'refunded')
        AND created_at > now() - INTERVAL '14 days'
      ORDER BY created_at DESC
      LIMIT $1`,
    [MAX_JOBS_PER_TICK],
  );

  // Also fetch non-terminal branch requests with a real tookan_job_id
  const branchRes = await db.query<{
    id: string;
    tookan_job_id: string;
    status: string;
  }>(
    `SELECT id, tookan_job_id, status
       FROM cmc_requests
      WHERE tookan_job_id IS NOT NULL
        AND tookan_job_id != 'pending'
        AND status NOT IN ('received', 'cancelled')
        AND created_at > now() - INTERVAL '14 days'
      ORDER BY created_at DESC
      LIMIT $1`,
    [MAX_JOBS_PER_TICK],
  );

  if (res.rows.length === 0 && branchRes.rows.length === 0) return;

  // Collect all unique job IDs across both tables for a single batch fetch
  const byJobId = new Map(res.rows.map((r) => [r.tookan_job_id, r]));
  const branchByJobId = new Map(branchRes.rows.map((r) => [r.tookan_job_id, r]));
  const allJobIds = new Set([...byJobId.keys(), ...branchByJobId.keys()]);

  const statuses = await getTookanJobStatuses([...allJobIds]);

  for (const { jobId, jobStatus, completedAt } of statuses) {
    // ── Regular OS orders ──────────────────────────────────────────────────
    const order = byJobId.get(jobId);
    if (order) {
      // Skip when the stored label already matches — avoids rewriting
      // updated_at on every tick for orders whose status hasn't moved.
      const label = tookanStatusLabel(jobStatus);
      if (label !== (order.tookan_status ?? "")) {
        try {
          const result = await syncTookanOrderStatus(jobId, jobStatus, completedAt);
          if (
            result.matched &&
            result.newStatus !== null &&
            result.workspaceOwnerId &&
            result.orderId
          ) {
            logger.info(
              {
                orderId: result.orderId,
                jobId,
                jobStatus,
                from: result.previousStatus,
                to: result.newStatus,
              },
              "tookan poll: order status updated (missed webhook)",
            );
            recordOrderEvent({
              workspaceOwnerId: result.workspaceOwnerId,
              orderId: result.orderId,
              eventType: "status_changed",
              payload: {
                from: result.previousStatus,
                to: result.newStatus,
                source: "tookan_poll",
              },
            });
            void fireWebhookEvent("order.status_updated", result.workspaceOwnerId, {
              orderId: result.orderId,
              appOrderId: result.externalOrderId ?? null,
              status: result.newStatus,
              updatedAt: new Date().toISOString(),
            });
            // Customer-facing status email (out for delivery / delivered) —
            // best-effort, fire-and-forget so a send failure never fails the poll.
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
                result.newStatus,
                result.workspaceOwnerId,
              );
            }
            notifyOrderStatusEmail(
              result.orderId,
              result.externalOrderId ?? result.orderId,
              result.newStatus,
              result.workspaceOwnerId,
            ).catch((emailErr) =>
              logger.warn(
                { err: emailErr, orderId: result.orderId },
                "tookan poll: status email failed",
              ),
            );
            // Trustpilot service-review invitation — only fires on a genuine
            // transition INTO completed; the queue dedupes per order. Best-effort.
            void maybeEnqueueTrustpilotInvitation(
              result.orderId,
              result.previousStatus,
              result.newStatus,
            );
          }
        } catch (err) {
          logger.warn({ err, jobId }, "tookan poll: failed to sync order status");
        }
      }
    }

    // ── Branch requests (cmc_requests) ────────────────────────────────────
    if (branchByJobId.has(jobId)) {
      try {
        const branchResult = await syncTookanBranchRequestStatus(jobId, jobStatus, "tookan_poll");
        if (branchResult.matched && branchResult.newStatus !== null) {
          logger.info(
            {
              requestId: branchResult.requestId,
              jobId,
              jobStatus,
              from: branchResult.previousStatus,
              to: branchResult.newStatus,
            },
            "tookan poll: branch request status updated (missed webhook)",
          );
        }
      } catch (err) {
        logger.warn({ err, jobId }, "tookan poll: failed to sync branch request status");
      }
    }
  }
}

export function startTookanStatusPollJob(): void {
  const tick = async () => {
    try {
      await runTookanStatusPoll();
    } catch (err) {
      logger.warn({ err }, "Tookan status poll job error");
    }
  };

  setInterval(tick, JOB_INTERVAL_MS);
  // Run once shortly after startup so a fresh deploy catches up quickly.
  setTimeout(tick, 15 * 1000);
  logger.info("Tookan status poll background job started");
}
