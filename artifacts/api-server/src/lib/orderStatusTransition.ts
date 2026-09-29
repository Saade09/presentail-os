import type { Pool } from "pg";
import { postRecipeConsumption } from "./recipeConsumption";
import { postCancellationReversal } from "./cancellationReversal";
import { InventoryError } from "./inventoryService";
import { logger } from "./logger";
import {
  createAutomaticAddressCollectionRequest,
  finalizeAddressCollectionForOrder,
} from "./addressCollector/service";
import { completeFloristAssignmentForOrder } from "./floristOrderCompletion";
import { enqueueRealDeliveryPublication } from "./realDeliveryPublication";

export interface TransitionResult {
  success: boolean;
  previousStatus: string;
  newStatus: string;
  /** Previous payment state when a refunded order was locally restored. */
  previousPaymentStatus?: string | null;
  /**
   * True when `allowedFromStatuses` was provided and the order's current
   * status was not in the allowed set — the transition was intentionally
   * skipped and no DB writes occurred.
   */
  skipped?: boolean;
  movementsPosted?: number;
  movementsSkipped?: number;
  error?: {
    code:
      | "INVENTORY_POSTING_ERROR"
      | "REFUNDED_PAYMENT_NOT_FOUND"
      | "REFUNDED_PAYMENT_UPDATE_FAILED";
    detail: {
      code: string;
      baseItemId?: number;
      productId?: number;
      locationId?: number;
      orderId?: string;
      [key: string]: unknown;
    };
  };
}

// Statuses that count as "fulfillment started or later" for cancellation reversal
const FULFILMENT_STARTED_STATUSES = new Set([
  "ready_for_delivery",
  "out_for_delivery",
  "delivered",
  "completed",
]);

/**
 * transitionOrderStatus
 *
 * Single entry point for all order status writes. Handles:
 * - Row-level locking (SELECT FOR UPDATE) to prevent concurrent transitions
 * - Recipe consumption posting when transitioning to ready_for_delivery
 * - Cancellation reversal posting when transitioning to cancelled from fulfillment
 * - All inside a single database transaction
 *
 * The transaction is rolled back ONLY on genuine DB errors (thrown exceptions).
 * Inventory consumption skips (missing location, recipe, or baseline) are
 * non-blocking — the order status update still commits with a summary of
 * movementsPosted / movementsSkipped in the result.
 *
 * Side effects (webhooks, emails, SSE, low-stock alerts) are returned as
 * callbacks to the caller and must be invoked AFTER the response is sent.
 */
export async function transitionOrderStatus(
  pool: Pool,
  params: {
    orderId: string;
    newStatus: string;
    workspaceOwnerId: string;
    actorUserId: string | null;
    /**
     * When provided, the transition is silently skipped (no DB writes, no
     * error) if the order's current status is NOT in this set.
     * `ready_for_delivery` used as `newStatus` and already present in the
     * order is therefore safe to list as an allowed source to make a call
     * idempotent, or to omit it entirely to treat it as a skip condition.
     */
    allowedFromStatuses?: string[];
    /**
     * For an authorized transition away from `refunded`, mark the local
     * payment row paid in this same transaction. Refund amounts and provider
     * references remain untouched.
     */
    restoreRefundedPayment?: boolean;
  },
): Promise<TransitionResult> {
  const { orderId, newStatus, workspaceOwnerId } = params;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Lock the order row to prevent concurrent transitions
    const lockResult = await client.query<{
      id: string;
      status: string;
      external_order_id: string | null;
      inventory_fulfillment_cycle: number;
    }>(
      `SELECT id, status, external_order_id, inventory_fulfillment_cycle
         FROM orders
        WHERE id = $1 AND workspace_owner_id = $2
        FOR UPDATE`,
      [orderId, workspaceOwnerId],
    );

    if (lockResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return {
        success: false,
        previousStatus: "",
        newStatus,
        error: {
          code: "INVENTORY_POSTING_ERROR",
          detail: { code: "ORDER_NOT_FOUND", orderId },
        },
      };
    }

    const previousStatus = lockResult.rows[0].status;

    // Eligibility gate: if the caller restricted the allowed source states
    // (e.g. auto-advance after Slack send should never touch cancelled /
    // on_hold / refunded / delivered orders), roll back and signal a skip.
    // The check happens inside the FOR UPDATE transaction so it is
    // atomic with the status read — no race between the check and the write.
    if (params.allowedFromStatuses && !params.allowedFromStatuses.includes(previousStatus)) {
      await client.query("ROLLBACK");
      return { success: true, previousStatus, newStatus, skipped: true };
    }

    let previousPaymentStatus: string | null | undefined;
    if (params.restoreRefundedPayment) {
      if (previousStatus !== "refunded" || newStatus === "refunded") {
        await client.query("ROLLBACK");
        return { success: true, previousStatus, newStatus, skipped: true };
      }

      const paymentLock = await client.query<{ status: string }>(
        `SELECT status
           FROM order_payment
          WHERE order_id = $1
          FOR UPDATE`,
        [orderId],
      );
      if (paymentLock.rows.length === 0) {
        await client.query("ROLLBACK");
        return {
          success: false,
          previousStatus,
          newStatus,
          error: {
            code: "REFUNDED_PAYMENT_NOT_FOUND",
            detail: { code: "PAYMENT_NOT_FOUND", orderId },
          },
        };
      }
      previousPaymentStatus = paymentLock.rows[0].status;

      const paymentUpdate = await client.query(
        `UPDATE order_payment
            SET status = 'paid', updated_at = now()
          WHERE order_id = $1`,
        [orderId],
      );
      if (paymentUpdate.rowCount !== 1) {
        await client.query("ROLLBACK");
        return {
          success: false,
          previousStatus,
          newStatus,
          error: {
            code: "REFUNDED_PAYMENT_UPDATE_FAILED",
            detail: { code: "PAYMENT_UPDATE_FAILED", orderId },
          },
        };
      }
    }

    const storedFulfillmentCycle =
      lockResult.rows[0].inventory_fulfillment_cycle ?? 0;
    const fulfillmentCycle =
      newStatus === "ready_for_delivery"
        ? previousStatus === "ready_for_delivery"
          ? Math.max(0, storedFulfillmentCycle - 1)
          : storedFulfillmentCycle
        : null;

    // Update the order status
    await client.query(
      `UPDATE orders
          SET status = $1,
              inventory_fulfillment_cycle = CASE
                WHEN $1 = 'ready_for_delivery' AND status <> 'ready_for_delivery'
                THEN inventory_fulfillment_cycle + 1
                ELSE inventory_fulfillment_cycle
              END,
              updated_at = now()
        WHERE id = $2 AND workspace_owner_id = $3`,
      [newStatus, orderId, workspaceOwnerId],
    );

    // An order-level completion bypasses florist-side photo verification by
    // design, but the linked assignment must not remain in the active queue.
    // Keep this in the same transaction so order and assignment cannot drift.
    if (newStatus === "completed") {
      await completeFloristAssignmentForOrder(client, orderId, workspaceOwnerId);
      const assignments = await client.query<{ id: number }>(
        `SELECT id FROM order_florist_assignments WHERE order_id=$1 AND workspace_owner_id=$2`,
        [orderId, workspaceOwnerId],
      );
      for (const assignment of assignments.rows) {
        await enqueueRealDeliveryPublication(client, assignment.id, workspaceOwnerId);
      }
    }

    if (newStatus === "completed" || newStatus === "delivered") {
      await finalizeAddressCollectionForOrder(client, {
        orderId,
        workspaceOwnerId,
        outcome: "order_delivered",
        reason: "Parent order delivered",
        source: "order_status_transition",
        actor: params.actorUserId ? `user:${params.actorUserId}` : "system",
      });
    } else if (newStatus === "cancelled" || newStatus === "refunded") {
      await finalizeAddressCollectionForOrder(client, {
        orderId,
        workspaceOwnerId,
        outcome: "order_cancelled",
        reason: newStatus === "refunded" ? "Parent order refunded" : "Parent order cancelled",
        source: "order_status_transition",
        actor: params.actorUserId ? `user:${params.actorUserId}` : "system",
      });
    }

    let movementsPosted = 0;
    let movementsSkipped = 0;

    // Recipe consumption on ready_for_delivery transition.
    // Only genuine DB errors (not InventoryError soft skips) cause a rollback.
    if (newStatus === "ready_for_delivery") {
      try {
        const consumptionResult = await postRecipeConsumption(
          client,
          orderId,
          workspaceOwnerId,
          { fulfillmentCycle: fulfillmentCycle ?? 0 },
        );
        if (consumptionResult.skipped === "flag_off") {
          // Feature flag off — no movements attempted
        } else {
          movementsPosted += consumptionResult.movementsPosted ?? 0;
          movementsSkipped += consumptionResult.movementsSkipped ?? 0;
          if ((consumptionResult.movementsSkipped ?? 0) > 0) {
            logger.warn(
              {
                orderId,
                workspaceOwnerId,
                movementsPosted: consumptionResult.movementsPosted,
                movementsSkipped: consumptionResult.movementsSkipped,
                skippedEntries: consumptionResult.skippedEntries,
              },
              "orderStatusTransition: some inventory movements were skipped (non-blocking)",
            );
          }
        }
      } catch (err) {
        // Only roll back on real DB errors — InventoryError.INSUFFICIENT_STOCK
        // is already soft-handled inside postRecipeConsumption; any remaining
        // InventoryError here is unexpected and should roll back.
        await client.query("ROLLBACK");
        if (err instanceof InventoryError) {
          return {
            success: false,
            previousStatus,
            newStatus,
            error: {
              code: "INVENTORY_POSTING_ERROR",
              detail: { code: err.code, ...err.detail },
            },
          };
        }
        throw err;
      }
    }

    // Cancellation reversal when cancelling a fulfillment-started order
    if (newStatus === "cancelled" && FULFILMENT_STARTED_STATUSES.has(previousStatus)) {
      try {
        const reversalResult = await postCancellationReversal(client, orderId, workspaceOwnerId);
        movementsPosted += reversalResult.movementIds.length;
        movementsSkipped += reversalResult.skippedCount;
      } catch (err) {
        await client.query("ROLLBACK");
        if (err instanceof InventoryError) {
          return {
            success: false,
            previousStatus,
            newStatus,
            error: {
              code: "INVENTORY_POSTING_ERROR",
              detail: { code: err.code, ...err.detail },
            },
          };
        }
        throw err;
      }
    }

    await client.query("COMMIT");
    logger.debug(
      { orderId, previousStatus, newStatus, workspaceOwnerId, movementsPosted, movementsSkipped },
      "orderStatusTransition: committed",
    );

    if (newStatus === "processing" && previousStatus !== "processing") {
      void createAutomaticAddressCollectionRequest({
        workspaceOwnerId,
        orderId,
      }).catch((err) => {
        logger.warn(
          { err, orderId, workspaceOwnerId },
          "orderStatusTransition: automatic address collection trigger failed",
        );
      });
    }

    return {
      success: true,
      previousStatus,
      newStatus,
      ...(previousPaymentStatus === undefined ? {} : { previousPaymentStatus }),
      movementsPosted,
      movementsSkipped,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
