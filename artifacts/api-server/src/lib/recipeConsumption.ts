import type { PoolClient } from "pg";
import { InventoryError, postMovement } from "./inventoryService";
import { logger } from "./logger";

export interface SkippedEntry {
  reason:
    | "MISSING_FULFILMENT_LOCATION"
    | "MISSING_RECIPE"
    | "MISSING_LEDGER_BASELINE"
    | "INSUFFICIENT_STOCK"
    | "UNSUPPORTED_UNIT_CONVERSION"
    | "INTEGRITY_FAILURE"
    | "ALREADY_POSTED";
  baseItemId?: number;
  productId?: number;
  lineItemId?: string;
  locationId?: number;
  orderId?: string;
}

export interface RecipeConsumptionResult {
  skipped?: "flag_off";
  movementIds?: number[];
  movementsPosted?: number;
  movementsSkipped?: number;
  skippedEntries?: SkippedEntry[];
}

// ── Exception types exported for routes/tests ─────────────────────────────────

/**
 * All actionable soft-failure reason codes.  ALREADY_POSTED and flag_off never
 * produce an exception row.
 */
export type ExceptionReason =
  | "MISSING_FULFILMENT_LOCATION"
  | "MISSING_RECIPE"
  | "MISSING_LEDGER_BASELINE"
  | "INSUFFICIENT_STOCK"
  | "UNSUPPORTED_UNIT_CONVERSION"
  | "INTEGRITY_FAILURE";

/** Status of a durable exception record. */
export type ExceptionStatus = "open" | "resolved" | "retrying";

/**
 * Snapshot captured at the time of exception creation / last attempt.
 * Stored in the `source_snapshot` JSONB column.
 */
export interface ExceptionSourceSnapshot {
  /** Physical event name captured at failure time. */
  eventType?: "order.ready_for_delivery";
  /** Order ID of the ready_for_delivery event that triggered consumption. */
  orderId: string;
  lineItemId: string;
  productId?: number | null;
  baseItemId?: number | null;
  locationId?: number | null;
  /** The idempotency key that would be used to post the movement. */
  idempotencyKey: string;
  /** Monotonic identity of the physical ready-for-delivery event. */
  eventCycle?: number;
  /** Full recipe/quantity snapshot at time of failure. */
  recipeSnapshot?: object | null;
  /** Human-readable calculation string, if available. */
  calculation?: string | null;
  /** Additional failure detail from the underlying error. */
  failureDetail?: Record<string, unknown> | null;
}

/**
 * One attempt record stored in the `attempt_history` JSONB array.
 */
export interface ExceptionAttempt {
  attemptedAt: string; // ISO timestamp
  reason: ExceptionReason;
  detail: Record<string, unknown>;
  succeeded: boolean;
  movementId?: number | null;
}

/**
 * Full exception row as returned by the DB query.
 */
export interface RecipeConsumptionException {
  id: string; // UUID
  workspace_owner_id: string;
  order_id: string;
  line_item_id: string;
  base_item_id: number | null;
  product_id: number | null;
  location_id: number | null;
  reason: ExceptionReason;
  status: ExceptionStatus;
  idempotency_key: string;
  source_snapshot: ExceptionSourceSnapshot;
  attempt_history: ExceptionAttempt[];
  resolved_movement_id: number | null;
  created_at: string;
  updated_at: string;
}

interface RecipeLineRow {
  line_item_id: string;
  product_id: number;
  product_name: string;
  inventory_tracked: boolean;
  ordered_qty: string;
  base_item_id: number | null;
  base_item_name: string | null;
  recipe_qty: string | null;
  canonical_unit: string | null;
}

interface LedgerBaseline {
  cutover_balance: string;
}

/**
 * Multiply two decimal numbers (represented as strings or numbers) without
 * floating-point errors for typical recipe quantities.
 * Returns the result as a finite number rounded to 10 decimal places.
 */
function decimalMultiply(a: string | number, b: string | number): number {
  const fa = typeof a === "string" ? parseFloat(a) : a;
  const fb = typeof b === "string" ? parseFloat(b) : b;
  const result = fa * fb;
  return parseFloat(result.toPrecision(15));
}

/**
 * Build the idempotency key for a product_consumption movement.
 *
 * Format: `pc:<orderId>:<lineItemId>:<baseItemId>:c<reversedCount>`
 *
 * `reversedCount` = how many prior consumption cycles for this
 * (orderId, lineItemId, baseItemId) triple have been fully reversed by an
 * order_cancellation movement. This scopes the key to a fulfillment cycle:
 *
 * - First fulfillment: reversedCount=0 → key ends `:c0`
 * - After cancellation (1 reversal): reversedCount=1 → key ends `:c1`
 * - Retry within the same cycle: same reversedCount → same key → DB dedup
 *
 * This differs from using total consumption count as the cycle: using the
 * reversed count means an existing UNREVERSED movement always produces the
 * same key and is detected as a duplicate (idempotent retry), while
 * re-fulfilment after a cancellation gets a fresh key.
 */
export function buildConsumptionKey(
  orderId: string,
  lineItemId: string,
  baseItemId: number,
  reversedCount: number,
): string {
  return `pc:${orderId}:${lineItemId}:${baseItemId}:c${reversedCount}`;
}

/**
 * Upsert a durable recipe-consumption exception row.
 *
 * Uses INSERT … ON CONFLICT DO UPDATE to preserve the original exception while
 * appending to attempt_history.  The status is reset to "open" if a retry just
 * failed, keeping the exception visible for future operator attention.
 *
 * This write is part of the same transaction as the fulfilment transition.
 * Persistence failures must propagate so the transition can roll back rather
 * than commit an inventory event that has neither a movement nor a review item.
 */
export async function upsertRecipeConsumptionException(
  client: PoolClient,
  params: {
    workspaceOwnerId: string;
    orderId: string;
    lineItemId: string;
    baseItemId: number | null;
    productId: number | null;
    locationId: number | null;
    reason: ExceptionReason;
    idempotencyKey: string;
    sourceSnapshot: ExceptionSourceSnapshot;
    /** Append this attempt record; omit on first-time creation with no attempt yet. */
    attempt?: ExceptionAttempt;
  },
): Promise<string> {
  const {
    workspaceOwnerId,
    orderId,
    lineItemId,
    baseItemId,
    productId,
    locationId,
    reason,
    idempotencyKey,
    sourceSnapshot,
    attempt,
  } = params;

  const attemptJson = attempt ? JSON.stringify([attempt]) : "[]";

  const result = await client.query<{ id: string }>(
    `INSERT INTO recipe_consumption_exceptions
       (workspace_owner_id, order_id, line_item_id, base_item_id, product_id,
        location_id, reason, status, idempotency_key, source_snapshot,
        attempt_history, resolved_movement_id, created_at, updated_at)
     VALUES
       ($1, $2, $3, $4, $5, $6, $7, 'open', $8, $9::jsonb,
        $10::jsonb, NULL, now(), now())
     ON CONFLICT (workspace_owner_id, idempotency_key)
     DO UPDATE SET
       reason             = EXCLUDED.reason,
       status             = CASE
                              WHEN recipe_consumption_exceptions.status = 'resolved'
                              THEN recipe_consumption_exceptions.status
                              ELSE 'open'
                            END,
       location_id        = EXCLUDED.location_id,
       source_snapshot    = recipe_consumption_exceptions.source_snapshot,
       attempt_history    = CASE
                              WHEN $10::jsonb = '[]'::jsonb
                              THEN recipe_consumption_exceptions.attempt_history
                              ELSE recipe_consumption_exceptions.attempt_history || $10::jsonb
                            END,
       updated_at         = now()
     RETURNING id`,
    [
      workspaceOwnerId,
      orderId,
      lineItemId,
      baseItemId,
      productId,
      locationId,
      reason,
      idempotencyKey,
      JSON.stringify(sourceSnapshot),
      attemptJson,
    ],
  );

  return result.rows[0].id;
}

/**
 * postRecipeConsumption
 *
 * Called inside an open transaction when an order transitions to
 * ready_for_delivery. Consumes base item stock for all inventory-tracked
 * products in the order's line items.
 *
 * Returns { skipped: 'flag_off' } if feature flag is off.
 * Returns { movementIds, movementsPosted, movementsSkipped, skippedEntries }
 * for partial or full success — does NOT throw for missing location/recipe/baseline.
 *
 * **Idempotency / cycle design**
 *
 * For each (orderId, lineItemId, baseItemId) triple we query:
 *   - totalCount = total product_consumption rows ever posted
 *   - reversedCount = count of those that have been reversed by order_cancellation
 *   - activeCount = totalCount - reversedCount
 *
 * If activeCount > 0: an unreversed consumption already exists → ALREADY_POSTED skip.
 * If activeCount == 0: post with idempotencyKey = buildConsumptionKey(..., reversedCount).
 *
 * This means:
 *   - Retrying the same transition (webhook replay) hits the same key → DB dedup
 *   - Re-fulfilment after cancellation: reversedCount increments → fresh key → new movement
 *   - Reconciliation rerun: finds active movement → satisfied → no second post
 *
 * **Exception durability**
 *
 * Every actionable soft failure (MISSING_FULFILMENT_LOCATION, MISSING_RECIPE,
 * MISSING_LEDGER_BASELINE, INSUFFICIENT_STOCK, UNSUPPORTED_UNIT_CONVERSION,
 * INTEGRITY_FAILURE) upserts a durable exception row via
 * upsertRecipeConsumptionException so operators can review and retry.
 * ALREADY_POSTED and flag_off never produce exception rows.
 *
 * Actionable inventory failures are non-blocking only after their exception row
 * is durably written in the same transaction. A failure to write that review
 * item propagates so the status transition rolls back and the event can retry.
 */
export async function postRecipeConsumption(
  client: PoolClient,
  orderId: string,
  workspaceOwnerId: string,
  options?: {
    fulfillmentCycle?: number;
    orderedQuantityOverrides?: Record<string, number>;
  },
): Promise<RecipeConsumptionResult> {
  // 1. Check feature flag
  const flagRow = await client.query<{
    inventory_recipe_consumption_enabled: boolean;
    inventory_allow_negative_stock: boolean;
  }>(
    `SELECT inventory_recipe_consumption_enabled, inventory_allow_negative_stock
       FROM workspace_settings
      WHERE workspace_owner_id = $1`,
    [workspaceOwnerId],
  );
  const flagEnabled = flagRow.rows[0]?.inventory_recipe_consumption_enabled ?? false;
  const allowNegative = flagRow.rows[0]?.inventory_allow_negative_stock ?? false;

  if (!flagEnabled) {
    return { skipped: "flag_off" };
  }

  // 2. Resolve fulfilment location — prioritised chain:
  //    (a) order_florist_assignments.location_id
  //    (b) orders.location_id
  const assignmentRow = await client.query<{
    location_id: number;
    inventory_fulfillment_cycle: number;
    order_status: string;
  }>(
    `SELECT ofa.location_id,
            o.inventory_fulfillment_cycle,
            o.status AS order_status
       FROM order_florist_assignments ofa
       JOIN orders o
         ON o.id = ofa.order_id
        AND o.workspace_owner_id = ofa.workspace_owner_id
      WHERE ofa.order_id = $1 AND ofa.workspace_owner_id = $2
      LIMIT 1`,
    [orderId, workspaceOwnerId],
  );
  let fulfillmentLocationId: number | null =
    assignmentRow.rowCount && assignmentRow.rows[0]?.location_id
      ? assignmentRow.rows[0].location_id
      : null;
  let storedFulfillmentCycle =
    assignmentRow.rows[0]?.inventory_fulfillment_cycle ?? 0;
  let orderStatus = assignmentRow.rows[0]?.order_status ?? "";

  if (fulfillmentLocationId == null) {
    const orderRow = await client.query<{
      location_id: number | null;
      inventory_fulfillment_cycle: number;
      status: string;
    }>(
      `SELECT location_id, inventory_fulfillment_cycle, status
         FROM orders
        WHERE id = $1 AND workspace_owner_id = $2
        LIMIT 1`,
      [orderId, workspaceOwnerId],
    );
    fulfillmentLocationId = orderRow.rows[0]?.location_id ?? null;
    storedFulfillmentCycle =
      orderRow.rows[0]?.inventory_fulfillment_cycle ?? 0;
    orderStatus = orderRow.rows[0]?.status ?? "";
  }
  const eventCycle =
    options?.fulfillmentCycle ??
    Math.max(
      0,
      storedFulfillmentCycle - (orderStatus === "ready_for_delivery" ? 1 : 0),
    );

  // 3. Read all order line items joined to product recipes
  const lineItemsResult = await client.query<RecipeLineRow>(
    `SELECT
       oli.id::text             AS line_item_id,
       p.id                     AS product_id,
       p.name                   AS product_name,
       p.inventory_tracked      AS inventory_tracked,
       oli.quantity::text       AS ordered_qty,
       bi.id                    AS base_item_id,
       bi.name                  AS base_item_name,
       pr.quantity::text        AS recipe_qty,
       COALESCE(bip.unit, 'unit') AS canonical_unit
     FROM order_line_items oli
     JOIN products p ON p.id = oli.product_id
     LEFT JOIN product_recipes pr ON pr.product_id = p.id
     LEFT JOIN base_items bi ON bi.id = pr.base_item_id
     LEFT JOIN base_item_packages bip ON bip.base_item_id = bi.id AND bip.is_default = true
     WHERE oli.order_id = $1
       AND p.workspace_owner_id = $2`,
    [orderId, workspaceOwnerId],
  );

  const rows = lineItemsResult.rows;

  // Group by line_item_id to find tracked products
  type LineItemGroup = {
    lineItemId: string;
    productId: number;
    productName: string;
    inventoryTracked: boolean;
    orderedQty: number;
    recipes: Array<{ baseItemId: number; baseItemName: string; recipeQty: number; canonicalUnit: string }>;
  };

  const lineItemMap = new Map<string, LineItemGroup>();
  for (const row of rows) {
    if (!lineItemMap.has(row.line_item_id)) {
      lineItemMap.set(row.line_item_id, {
        lineItemId: row.line_item_id,
        productId: row.product_id,
        productName: row.product_name,
        inventoryTracked: row.inventory_tracked,
        orderedQty:
          options?.orderedQuantityOverrides?.[row.line_item_id] ??
          parseFloat(row.ordered_qty),
        recipes: [],
      });
    }
    const group = lineItemMap.get(row.line_item_id)!;
    if (row.base_item_id != null && row.recipe_qty != null) {
      group.recipes.push({
        baseItemId: row.base_item_id,
        baseItemName: row.base_item_name!,
        recipeQty: parseFloat(row.recipe_qty),
        canonicalUnit: row.canonical_unit ?? "unit",
      });
    }
  }

  const skippedEntries: SkippedEntry[] = [];

  // 4. Aggregate by (lineItemId, baseItemId) — skipping lines with missing
  //    recipe rather than throwing.
  type AggKey = string;
  type AggEntry = {
    lineItemId: string;
    baseItemId: number;
    baseItemName: string;
    productId: number;
    productName: string;
    orderedQty: number;
    totalRecipeQty: number;
    canonicalUnit: string;
  };
  const aggregated = new Map<AggKey, AggEntry>();

  for (const group of lineItemMap.values()) {
    if (!group.inventoryTracked) continue;

    // Missing recipe — skip with warning instead of throwing, persist exception
    if (group.recipes.length === 0) {
      logger.warn(
        {
          orderId,
          productId: group.productId,
          productName: group.productName,
          lineItemId: group.lineItemId,
          reason: "MISSING_RECIPE",
        },
        "recipeConsumption: tracked product has no recipe — skipping line",
      );
      skippedEntries.push({
        reason: "MISSING_RECIPE",
        productId: group.productId,
        lineItemId: group.lineItemId,
      });

      // Persist durable exception. If this fails, let the enclosing order
      // transition roll back so the physical event is never silently lost.
      const idempotencyKey =
        `pc:${orderId}:${group.lineItemId}:no_base_item:c${eventCycle}`;
      await upsertRecipeConsumptionException(client, {
          workspaceOwnerId,
          orderId,
          lineItemId: group.lineItemId,
          baseItemId: null,
          productId: group.productId,
          locationId: fulfillmentLocationId,
          reason: "MISSING_RECIPE",
          idempotencyKey,
          sourceSnapshot: {
            eventType: "order.ready_for_delivery",
            eventCycle,
            orderId,
            lineItemId: group.lineItemId,
            productId: group.productId,
            baseItemId: null,
            locationId: fulfillmentLocationId,
            idempotencyKey,
            failureDetail: {
              reason: "MISSING_RECIPE",
              productName: group.productName,
              orderedQty: String(group.orderedQty),
            },
          },
          attempt: {
            attemptedAt: new Date().toISOString(),
            reason: "MISSING_RECIPE",
            detail: { productId: group.productId, lineItemId: group.lineItemId },
            succeeded: false,
          },
      });

      continue;
    }

    for (const recipe of group.recipes) {
      if (
        !Number.isFinite(group.orderedQty) ||
        group.orderedQty <= 0 ||
        !Number.isFinite(recipe.recipeQty) ||
        recipe.recipeQty <= 0
      ) {
        const idempotencyKey = buildConsumptionKey(
          orderId,
          group.lineItemId,
          recipe.baseItemId,
          eventCycle,
        );
        const failureDetail = {
          reason: "INTEGRITY_FAILURE",
          orderedQty: group.orderedQty,
          recipeQty: recipe.recipeQty,
        };
        skippedEntries.push({
          reason: "INTEGRITY_FAILURE",
          productId: group.productId,
          baseItemId: recipe.baseItemId,
          lineItemId: group.lineItemId,
          orderId,
          locationId: fulfillmentLocationId ?? undefined,
        });
        await upsertRecipeConsumptionException(client, {
          workspaceOwnerId,
          orderId,
          lineItemId: group.lineItemId,
          baseItemId: recipe.baseItemId,
          productId: group.productId,
          locationId: fulfillmentLocationId,
          reason: "INTEGRITY_FAILURE",
          idempotencyKey,
          sourceSnapshot: {
            orderId,
            eventCycle,
            lineItemId: group.lineItemId,
            productId: group.productId,
            baseItemId: recipe.baseItemId,
            locationId: fulfillmentLocationId,
            idempotencyKey,
            failureDetail,
          },
          attempt: {
            attemptedAt: new Date().toISOString(),
            reason: "INTEGRITY_FAILURE",
            detail: failureDetail,
            succeeded: false,
          },
        });
        continue;
      }
      const key: AggKey = `${group.lineItemId}:${recipe.baseItemId}`;
      if (!aggregated.has(key)) {
        aggregated.set(key, {
          lineItemId: group.lineItemId,
          baseItemId: recipe.baseItemId,
          baseItemName: recipe.baseItemName,
          productId: group.productId,
          productName: group.productName,
          orderedQty: group.orderedQty,
          totalRecipeQty: recipe.recipeQty,
          canonicalUnit: recipe.canonicalUnit,
        });
      } else {
        aggregated.get(key)!.totalRecipeQty += recipe.recipeQty;
      }
    }
  }

  if (aggregated.size === 0) {
    return {
      movementIds: [],
      movementsPosted: 0,
      movementsSkipped: skippedEntries.length,
      skippedEntries,
    };
  }

  // 5. Resolve cycle state for all (lineItemId, baseItemId) pairs in one query.
  //
  //    For each pair:
  //      totalCount    = all product_consumption rows ever posted for this (orderId, lineItemId, baseItemId)
  //      reversedCount = how many of those have a matching order_cancellation reversal
  //      activeCount   = totalCount - reversedCount
  //
  //    activeCount > 0 → an unreversed consumption exists → ALREADY_POSTED (idempotent retry)
  //    activeCount == 0 → all consumed stock was returned → cycle = reversedCount → post new
  type CycleState = { totalCount: number; reversedCount: number };
  const cycleStates = new Map<string, CycleState>(); // key = "<lineItemId>:<baseItemId>"

  {
    const lineItemIds = [...new Set([...aggregated.values()].map((e) => e.lineItemId))];
    const baseItemIds = [...new Set([...aggregated.values()].map((e) => e.baseItemId))];

    const cycleRows = await client.query<{
      order_line_item_id: string;
      base_item_id: number;
      total_count: string;
      reversed_count: string;
    }>(
      `SELECT
         a.order_line_item_id,
         a.base_item_id,
         COUNT(*)::text                                            AS total_count,
         COUNT(r.id)::text                                         AS reversed_count
       FROM base_item_stock_adjustments a
       LEFT JOIN base_item_stock_adjustments r
         ON r.reversal_of_id = a.id AND r.movement_type = 'order_cancellation'
       WHERE a.order_id = $1
         AND a.workspace_owner_id = $2
         AND a.movement_type = 'product_consumption'
         AND a.order_line_item_id = ANY($3::text[])
         AND a.base_item_id = ANY($4::int[])
       GROUP BY a.order_line_item_id, a.base_item_id`,
      [orderId, workspaceOwnerId, lineItemIds, baseItemIds],
    );

    for (const r of cycleRows.rows) {
      cycleStates.set(`${r.order_line_item_id}:${r.base_item_id}`, {
        totalCount: parseInt(r.total_count, 10),
        reversedCount: parseInt(r.reversed_count, 10),
      });
    }
  }

  // 6. Validate cutover baseline and post movements per aggregate entry.
  //    Missing location or baseline → skip with logged warning (not throw).
  const movementIds: number[] = [];

  for (const entry of aggregated.values()) {
    const aggKey = `${entry.lineItemId}:${entry.baseItemId}`;
    const cycle = cycleStates.get(aggKey) ?? { totalCount: 0, reversedCount: 0 };
    const activeCount = cycle.totalCount - cycle.reversedCount;
    const canonicalConsumed = decimalMultiply(entry.orderedQty, entry.totalRecipeQty);
    const entryEventCycle =
      options?.fulfillmentCycle ??
      Math.max(eventCycle, cycle.reversedCount);
    const idempotencyKey = buildConsumptionKey(
      orderId,
      entry.lineItemId,
      entry.baseItemId,
      entryEventCycle,
    );
    const recipeSnapshot = {
      eventType: "order.ready_for_delivery",
      eventCycle: entryEventCycle,
      productId: entry.productId,
      productName: entry.productName,
      lineItemId: entry.lineItemId,
      orderedQty: String(entry.orderedQty),
      baseItemId: entry.baseItemId,
      baseItemName: entry.baseItemName,
      recipeQty: String(entry.totalRecipeQty),
      canonicalUnit: entry.canonicalUnit,
      canonicalQtyPerLineItem: String(canonicalConsumed),
      calculation: `${entry.orderedQty} ordered × ${entry.totalRecipeQty} recipe ${entry.canonicalUnit} = ${canonicalConsumed} ${entry.canonicalUnit}`,
      cycle: cycle.reversedCount,
    };

    // Location check per-entry
    if (fulfillmentLocationId == null) {
      logger.warn(
        {
          orderId,
          productId: entry.productId,
          baseItemId: entry.baseItemId,
          lineItemId: entry.lineItemId,
          reason: "MISSING_FULFILMENT_LOCATION",
        },
        "recipeConsumption: no fulfilment location for order — skipping base item movement",
      );
      skippedEntries.push({
        reason: "MISSING_FULFILMENT_LOCATION",
        productId: entry.productId,
        baseItemId: entry.baseItemId,
        lineItemId: entry.lineItemId,
        orderId,
      });

      // Persist durable exception before allowing the order transition to commit.
      await upsertRecipeConsumptionException(client, {
          workspaceOwnerId,
          orderId,
          lineItemId: entry.lineItemId,
          baseItemId: entry.baseItemId,
          productId: entry.productId,
          locationId: null,
          reason: "MISSING_FULFILMENT_LOCATION",
          idempotencyKey,
          sourceSnapshot: {
            orderId,
            lineItemId: entry.lineItemId,
            productId: entry.productId,
            baseItemId: entry.baseItemId,
            locationId: null,
            idempotencyKey,
            recipeSnapshot,
            calculation: recipeSnapshot.calculation,
            failureDetail: { reason: "MISSING_FULFILMENT_LOCATION" },
          },
          attempt: {
            attemptedAt: new Date().toISOString(),
            reason: "MISSING_FULFILMENT_LOCATION",
            detail: { orderId, lineItemId: entry.lineItemId, baseItemId: entry.baseItemId },
            succeeded: false,
          },
      });
      continue;
    }

    // Cycle-state check: if an unreversed consumption already exists, skip.
    // This is the primary application-level idempotency guard (DB key is the
    // safety net for concurrent inserts).
    if (activeCount > 0) {
      logger.warn(
        {
          orderId,
          productId: entry.productId,
          baseItemId: entry.baseItemId,
          locationId: fulfillmentLocationId,
          lineItemId: entry.lineItemId,
          cycle: cycle.reversedCount,
          activeCount,
          reason: "ALREADY_POSTED",
        },
        "recipeConsumption: unreversed consumption movement already exists — skipping",
      );
      skippedEntries.push({
        reason: "ALREADY_POSTED",
        baseItemId: entry.baseItemId,
        productId: entry.productId,
        lineItemId: entry.lineItemId,
      });
      // No exception row for ALREADY_POSTED — this is a successful idempotent check.
      continue;
    }

    // Cutover baseline check — required unless allow_negative_stock is on
    if (!allowNegative) {
      const baselineRow = await client.query<LedgerBaseline>(
        `SELECT cutover_balance FROM base_item_ledger_settings
          WHERE workspace_owner_id = $1 AND base_item_id = $2 AND location_id = $3`,
        [workspaceOwnerId, entry.baseItemId, fulfillmentLocationId],
      );
      if (baselineRow.rowCount === 0) {
        logger.warn(
          {
            orderId,
            productId: entry.productId,
            baseItemId: entry.baseItemId,
            baseItemName: entry.baseItemName,
            locationId: fulfillmentLocationId,
            lineItemId: entry.lineItemId,
            reason: "MISSING_LEDGER_BASELINE",
          },
          "recipeConsumption: no ledger baseline for base item/location and negative stock not allowed — skipping",
        );
        skippedEntries.push({
          reason: "MISSING_LEDGER_BASELINE",
          baseItemId: entry.baseItemId,
          productId: entry.productId,
          lineItemId: entry.lineItemId,
          locationId: fulfillmentLocationId,
        });

        // Persist durable exception before allowing the status transition to commit.
        await upsertRecipeConsumptionException(client, {
            workspaceOwnerId,
            orderId,
            lineItemId: entry.lineItemId,
            baseItemId: entry.baseItemId,
            productId: entry.productId,
            locationId: fulfillmentLocationId,
            reason: "MISSING_LEDGER_BASELINE",
            idempotencyKey,
            sourceSnapshot: {
              orderId,
              eventCycle,
              lineItemId: entry.lineItemId,
              productId: entry.productId,
              baseItemId: entry.baseItemId,
              locationId: fulfillmentLocationId,
              idempotencyKey,
              recipeSnapshot,
              calculation: recipeSnapshot.calculation,
              failureDetail: {
                reason: "MISSING_LEDGER_BASELINE",
                baseItemName: entry.baseItemName,
                locationId: fulfillmentLocationId,
              },
            },
            attempt: {
              attemptedAt: new Date().toISOString(),
              reason: "MISSING_LEDGER_BASELINE",
              detail: {
                baseItemId: entry.baseItemId,
                locationId: fulfillmentLocationId,
                lineItemId: entry.lineItemId,
              },
              succeeded: false,
            },
        });
        continue;
      }
    }

    const quantityChange = -canonicalConsumed;

    let result;
    try {
      result = await postMovement(client, {
        workspaceOwnerId,
        baseItemId: entry.baseItemId,
        locationId: fulfillmentLocationId,
        quantityChange,
        reason: `Order ${orderId}`,
        movementType: "product_consumption",
        orderId,
        orderLineItemId: entry.lineItemId,
        productId: entry.productId,
        idempotencyKey,
        recipeSnapshot,
        inventoryAllowNegativeStock: allowNegative,
      });
    } catch (err) {
      // INSUFFICIENT_STOCK is thrown by postMovement when allow_negative_stock=false
      // and stock would go negative. Report with a distinct reason code.
      if (err instanceof InventoryError && err.code === "INSUFFICIENT_STOCK") {
        logger.warn(
          {
            orderId,
            productId: entry.productId,
            baseItemId: entry.baseItemId,
            locationId: fulfillmentLocationId,
            lineItemId: entry.lineItemId,
            reason: "INSUFFICIENT_STOCK",
            ...err.detail,
          },
          "recipeConsumption: INSUFFICIENT_STOCK on postMovement — skipping",
        );
        skippedEntries.push({
          reason: "INSUFFICIENT_STOCK",
          baseItemId: entry.baseItemId,
          productId: entry.productId,
          lineItemId: entry.lineItemId,
          locationId: fulfillmentLocationId,
        });

        // Persist durable exception before allowing the status transition to commit.
        await upsertRecipeConsumptionException(client, {
            workspaceOwnerId,
            orderId,
            lineItemId: entry.lineItemId,
            baseItemId: entry.baseItemId,
            productId: entry.productId,
            locationId: fulfillmentLocationId,
            reason: "INSUFFICIENT_STOCK",
            idempotencyKey,
            sourceSnapshot: {
              orderId,
              eventCycle,
              lineItemId: entry.lineItemId,
              productId: entry.productId,
              baseItemId: entry.baseItemId,
              locationId: fulfillmentLocationId,
              idempotencyKey,
              recipeSnapshot,
              calculation: recipeSnapshot.calculation,
              failureDetail: {
                reason: "INSUFFICIENT_STOCK",
                ...err.detail,
              },
            },
            attempt: {
              attemptedAt: new Date().toISOString(),
              reason: "INSUFFICIENT_STOCK",
              detail: {
                baseItemId: entry.baseItemId,
                locationId: fulfillmentLocationId,
                ...err.detail,
              },
              succeeded: false,
            },
        });
        continue;
      }
      if (err instanceof InventoryError) {
        const failureDetail = { reason: err.code, ...err.detail };
        skippedEntries.push({
          reason: "INTEGRITY_FAILURE",
          baseItemId: entry.baseItemId,
          productId: entry.productId,
          lineItemId: entry.lineItemId,
          locationId: fulfillmentLocationId,
          orderId,
        });
        await upsertRecipeConsumptionException(client, {
          workspaceOwnerId,
          orderId,
          lineItemId: entry.lineItemId,
          baseItemId: entry.baseItemId,
          productId: entry.productId,
          locationId: fulfillmentLocationId,
          reason: "INTEGRITY_FAILURE",
          idempotencyKey,
          sourceSnapshot: {
            eventCycle: entryEventCycle,
            orderId,
            lineItemId: entry.lineItemId,
            productId: entry.productId,
            baseItemId: entry.baseItemId,
            locationId: fulfillmentLocationId,
            idempotencyKey,
            recipeSnapshot,
            calculation: recipeSnapshot.calculation,
            failureDetail,
          },
          attempt: {
            attemptedAt: new Date().toISOString(),
            reason: "INTEGRITY_FAILURE",
            detail: failureDetail,
            succeeded: false,
          },
        });
        continue;
      }
      throw err;
    }

    if (!result.posted) {
      // DB-level duplicate guard fired (concurrent insert). The application
      // check above should prevent this in normal operation; log it as a
      // warning but don't treat it as an error.
      logger.warn(
        {
          orderId,
          productId: entry.productId,
          baseItemId: entry.baseItemId,
          locationId: fulfillmentLocationId,
          lineItemId: entry.lineItemId,
          idempotencyKey,
          cycle: cycle.reversedCount,
          reason: "ALREADY_POSTED",
        },
        "recipeConsumption: DB idempotency key conflict (concurrent insert) — skipping",
      );
      skippedEntries.push({
        reason: "ALREADY_POSTED",
        baseItemId: entry.baseItemId,
        productId: entry.productId,
        lineItemId: entry.lineItemId,
      });
      // No exception row for ALREADY_POSTED — this is a successful idempotent check.
      continue;
    }

    if (result.movementId != null) {
      movementIds.push(result.movementId);
    }
  }

  const movementsPosted = movementIds.length;
  const movementsSkipped = skippedEntries.length;

  logger.info(
    {
      orderId,
      workspaceOwnerId,
      movementsPosted,
      movementsSkipped,
      skippedReasons: skippedEntries.map((s) => s.reason),
    },
    "recipeConsumption: completed",
  );

  return { movementIds, movementsPosted, movementsSkipped, skippedEntries };
}
