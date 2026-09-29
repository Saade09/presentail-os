import type { PoolClient } from "pg";
import { reverseMovement } from "./inventoryService";
import { logger } from "./logger";

export interface CancellationReversalResult {
  movementIds: number[];
  skippedCount: number;
}

interface OriginalConsumptionRow {
  id: number;
  base_item_id: number;
  location_id: number | null;
  quantity_change: string;
  workspace_owner_id: string;
  order_id: string | null;
  order_line_item_id: string | null;
  product_id: number | null;
}

/**
 * postCancellationReversal
 *
 * Called inside an open transaction when an order is cancelled and was
 * previously moved to ready_for_delivery (or beyond).
 *
 * Finds all product_consumption ledger rows for the order that have not yet
 * been reversed, and posts a reversal for each.
 *
 * Each reversal is independently idempotent via key `rev:cancel:{originalMovementId}`.
 * A second attempt on the same row returns posted:false (duplicate key) — no error.
 * Partial reversals are supported: only unreversed rows are processed.
 *
 * Movements with null location_id are logged as warnings rather than silently
 * skipped, so operations teams can identify orphaned movements.
 */
export async function postCancellationReversal(
  client: PoolClient,
  orderId: string,
  workspaceOwnerId: string,
): Promise<CancellationReversalResult> {
  // Find all product_consumption rows for this order that have no reversal yet
  const originalRows = await client.query<OriginalConsumptionRow>(
    `SELECT a.id, a.base_item_id, a.location_id, a.quantity_change,
            a.workspace_owner_id, a.order_id, a.order_line_item_id, a.product_id
       FROM base_item_stock_adjustments a
      WHERE a.order_id = $1
        AND a.workspace_owner_id = $2
        AND a.movement_type = 'product_consumption'
        AND NOT EXISTS (
          SELECT 1 FROM base_item_stock_adjustments r
           WHERE r.reversal_of_id = a.id
             AND r.movement_type = 'order_cancellation'
        )`,
    [orderId, workspaceOwnerId],
  );

  if (originalRows.rowCount === 0) {
    return { movementIds: [], skippedCount: 0 };
  }

  const movementIds: number[] = [];
  let skippedCount = 0;

  for (const original of originalRows.rows) {
    // Log movements with null location rather than silently skipping
    if (!original.location_id) {
      logger.warn(
        {
          orderId,
          originalMovementId: original.id,
          baseItemId: original.base_item_id,
          productId: original.product_id,
          orderLineItemId: original.order_line_item_id,
          reason: "NULL_LOCATION_ID",
        },
        "cancellationReversal: original consumption movement has null location_id — skipping reversal; manual investigation required",
      );
      skippedCount++;
      continue;
    }

    const idempotencyKey = `rev:cancel:${original.id}`;

    const result = await reverseMovement(client, {
      workspaceOwnerId,
      movementId: original.id,
      reason: `Cancellation reversal of order ${orderId}`,
      movementType: "order_cancellation",
      idempotencyKey,
      inventoryAllowNegativeStock: true,
      sourceType: "order_cancellation",
      sourceId: orderId,
      sourceLabelSnapshot: `Cancellation of order ${orderId}`,
    });

    if (!result.posted) {
      logger.warn(
        {
          orderId,
          originalMovementId: original.id,
          idempotencyKey,
          reason: "ALREADY_POSTED",
        },
        "cancellationReversal: reversal already posted (duplicate idempotency key) — skipping",
      );
      skippedCount++;
      continue;
    }

    if (result.movementId != null) {
      movementIds.push(result.movementId);
    }
  }

  logger.info(
    {
      orderId,
      workspaceOwnerId,
      movementsPosted: movementIds.length,
      movementsSkipped: skippedCount,
    },
    "cancellationReversal: completed",
  );

  return { movementIds, skippedCount };
}
