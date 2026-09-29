import type { PoolClient } from "pg";
import { logger } from "./logger";

/**
 * Canonical movement taxonomy for the Base Item operational ledger.
 *
 * `inventory_movements` is a separate analytics/costing store. It is
 * intentionally not part of this contract and must not be used to derive
 * Base Item on-hand balances.
 */
export const OPERATIONAL_MOVEMENT_TYPES = [
  "opening_balance",
  "purchase_order_receipt",
  "product_consumption",
  "transfer_in",
  "transfer_out",
  "waste_damage",
  "manual_adjustment",
  "customer_return",
  "supplier_return",
  "order_cancellation",
  "inventory_count_correction",
  "reversal",
  "cmc_return",
  "cmc_return_reversal",
] as const;

export type OperationalMovementType = (typeof OPERATIONAL_MOVEMENT_TYPES)[number];

export class InventoryError extends Error {
  constructor(
    public readonly code:
      | "INSUFFICIENT_STOCK"
      | "MISSING_FULFILMENT_LOCATION"
      | "MISSING_RECIPE"
      | "MISSING_LEDGER_BASELINE"
      | "INVALID_LEDGER_TARGET"
      | "INVALID_MOVEMENT"
      | "MOVEMENT_NOT_FOUND"
      | "MOVEMENT_ALREADY_REVERSED"
      | "OPENING_BALANCE_EXISTS",
    public readonly detail: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = "InventoryError";
  }
}

export interface PostMovementParams {
  workspaceOwnerId: string;
  baseItemId: number;
  locationId: number;
  quantityChange: number;
  reason: string;
  movementType: OperationalMovementType;
  note?: string | null;
  createdByUserId?: string | null;
  adjustmentActionId?: string | null;
  purchaseOrderId?: number | null;
  transferId?: number | null;
  orderId?: string | null;
  orderLineItemId?: string | null;
  productId?: number | null;
  idempotencyKey?: string | null;
  reversalOfId?: number | null;
  recipeSnapshot?: object | null;
  cutoverBaseline?: boolean;
  inventoryAllowNegativeStock?: boolean;
  canonicalUnit?: string | null;
  actorType?: "user" | "system" | "migration";
  actorId?: string | null;
  actorLabelSnapshot?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
  sourceLabelSnapshot?: string | null;
  referenceType?: string | null;
  referenceId?: string | null;
  referenceLabelSnapshot?: string | null;
  metadataSnapshot?: object | null;
}

export interface PostMovementResult {
  posted: boolean;
  reason?: "duplicate";
  movementId?: number;
  stockAfter?: number;
  allowedNegative?: boolean;
}

interface LedgerTargetSnapshot {
  base_item_name: string;
  location_name: string;
  canonical_unit: string;
}

interface ReversibleMovementRow {
  id: number;
  workspace_owner_id: string;
  base_item_id: number | null;
  location_id: number | null;
  quantity_change: string;
  movement_type: string | null;
  reason: string;
  note: string | null;
  created_by_user_id: string | null;
  purchase_order_id: number | null;
  transfer_id: number | null;
  order_id: string | null;
  order_line_item_id: string | null;
  product_id: number | null;
  recipe_snapshot: object | null;
  canonical_unit: string | null;
  source_type: string | null;
  source_id: string | null;
  source_label_snapshot: string | null;
  reference_type: string | null;
  reference_id: string | null;
  reference_label_snapshot: string | null;
  metadata_snapshot: object | null;
}

export interface ReverseMovementParams {
  workspaceOwnerId: string;
  movementId: number;
  reason: string;
  note?: string | null;
  movementType?: Extract<
    OperationalMovementType,
    "order_cancellation" | "reversal" | "cmc_return_reversal"
  >;
  idempotencyKey: string;
  createdByUserId?: string | null;
  actorType?: "user" | "system" | "migration";
  actorId?: string | null;
  actorLabelSnapshot?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
  sourceLabelSnapshot?: string | null;
  inventoryAllowNegativeStock?: boolean;
}

export interface EstablishOpeningBalanceParams {
  workspaceOwnerId: string;
  baseItemId: number;
  locationId: number;
  verifiedByUserId: string;
  verifiedByLabel?: string | null;
  reason: string;
  idempotencyKey?: string;
  cutoverAt?: Date;
}

export interface EstablishOpeningBalanceResult {
  created: boolean;
  movementId: number;
  cutoverAt: Date;
  cutoverBalance: number;
}

function assertMovementInput(params: PostMovementParams): void {
  if (!OPERATIONAL_MOVEMENT_TYPES.includes(params.movementType)) {
    throw new InventoryError("INVALID_MOVEMENT", {
      movementType: params.movementType,
    });
  }
  if (!Number.isFinite(params.quantityChange)) {
    throw new InventoryError("INVALID_MOVEMENT", {
      quantityChange: params.quantityChange,
    });
  }
  if (params.quantityChange === 0 && !params.cutoverBaseline) {
    throw new InventoryError("INVALID_MOVEMENT", {
      quantityChange: params.quantityChange,
      reason: "Operational movements must have a non-zero signed quantity",
    });
  }
  const positiveOnly = new Set<OperationalMovementType>([
    "purchase_order_receipt",
    "transfer_in",
    "customer_return",
    "order_cancellation",
    "cmc_return_reversal",
  ]);
  const negativeOnly = new Set<OperationalMovementType>([
    "product_consumption",
    "transfer_out",
    "waste_damage",
    "supplier_return",
    "cmc_return",
  ]);
  if (
    (positiveOnly.has(params.movementType) && params.quantityChange <= 0) ||
    (negativeOnly.has(params.movementType) && params.quantityChange >= 0)
  ) {
    throw new InventoryError("INVALID_MOVEMENT", {
      movementType: params.movementType,
      quantityChange: params.quantityChange,
      reason: `Movement type ${params.movementType} has an invalid quantity direction`,
    });
  }
  if (!params.reason.trim()) {
    throw new InventoryError("INVALID_MOVEMENT", {
      reason: "A non-empty reason is required",
    });
  }
}

async function loadLedgerTargetSnapshot(
  client: PoolClient,
  workspaceOwnerId: string,
  baseItemId: number,
  locationId: number,
): Promise<LedgerTargetSnapshot> {
  const result = await client.query<LedgerTargetSnapshot>(
    `SELECT
       bi.name AS base_item_name,
       l.name AS location_name,
       COALESCE((
         SELECT bip.unit
           FROM base_item_packages bip
          WHERE bip.base_item_id = bi.id
            AND bip.is_default = true
          ORDER BY bip.id ASC
          LIMIT 1
       ), 'unit') AS canonical_unit
     FROM base_items bi
     JOIN locations l
       ON l.id = $3
      AND l.workspace_owner_id = $1
    WHERE bi.id = $2
      AND bi.workspace_owner_id = $1`,
    [workspaceOwnerId, baseItemId, locationId],
  );
  if (result.rowCount === 0) {
    throw new InventoryError("INVALID_LEDGER_TARGET", {
      workspaceOwnerId,
      baseItemId,
      locationId,
    });
  }
  return result.rows[0];
}

/**
 * InventoryService.postMovement
 *
 * The ONLY place in the codebase that writes to base_item_stock_adjustments,
 * base_item_location_statuses, and base_items.stock. All callers pass an
 * already-started Postgres client (within an open transaction).
 *
 * Idempotency: if idempotencyKey is set and already exists, returns
 * { posted: false, reason: 'duplicate' } without error.
 *
 * Negative stock: if movement would drive location stock below 0:
 *   - inventoryAllowNegativeStock=false (default): throws InventoryError('INSUFFICIENT_STOCK')
 *   - inventoryAllowNegativeStock=true: posts with allowedNegative:true in result
 */
export async function postMovement(
  client: PoolClient,
  params: PostMovementParams,
): Promise<PostMovementResult> {
  assertMovementInput(params);

  const {
    workspaceOwnerId,
    baseItemId,
    locationId,
    quantityChange,
    reason,
    movementType,
    note = null,
    createdByUserId = null,
    adjustmentActionId = null,
    purchaseOrderId = null,
    transferId = null,
    orderId = null,
    orderLineItemId = null,
    productId = null,
    idempotencyKey = null,
    reversalOfId = null,
    recipeSnapshot = null,
    cutoverBaseline = false,
    inventoryAllowNegativeStock = false,
    canonicalUnit = null,
    actorType = createdByUserId ? "user" : "system",
    actorId = createdByUserId,
    actorLabelSnapshot = null,
    sourceType = null,
    sourceId = null,
    sourceLabelSnapshot = null,
    referenceType = null,
    referenceId = null,
    referenceLabelSnapshot = null,
    metadataSnapshot = null,
  } = params;

  // 1. Resolve the target snapshots, lock the balance, and check idempotency
  // in one read. Keeping these together avoids evaluating a duplicate retry
  // against an already-changed balance without adding an extra round trip.
  type StockContextRow = LedgerTargetSnapshot & {
    status_id: number | null;
    stock: string;
    duplicate_id: number | null;
    duplicate_stock_after: string | null;
  };
  const stockRow = await client.query<StockContextRow>(
    `WITH target AS (
       SELECT
         bi.id AS base_item_id,
         bi.name AS base_item_name,
         l.id AS location_id,
         l.name AS location_name,
         COALESCE((
           SELECT bip.unit
             FROM base_item_packages bip
            WHERE bip.base_item_id = bi.id
              AND bip.is_default = true
            ORDER BY bip.id ASC
            LIMIT 1
         ), 'unit') AS canonical_unit
       FROM base_items bi
       JOIN locations l
         ON l.id = $3
        AND l.workspace_owner_id = $1
      WHERE bi.id = $2
        AND bi.workspace_owner_id = $1
     ),
     locked_status AS (
       INSERT INTO base_item_location_statuses
         (workspace_owner_id, base_item_id, location_id, stock, is_active)
       SELECT $1, target.base_item_id, target.location_id, 0, true
         FROM target
       ON CONFLICT (base_item_id, location_id)
       DO UPDATE SET stock = base_item_location_statuses.stock
       RETURNING id, stock
     )
     SELECT
       locked_status.id AS status_id,
       locked_status.stock::text AS stock,
       target.base_item_name,
       target.location_name,
       target.canonical_unit,
       duplicate.id AS duplicate_id,
       duplicate.stock_after::text AS duplicate_stock_after
     FROM target
     JOIN locked_status ON true
     LEFT JOIN LATERAL (
       SELECT a.id, a.stock_after
         FROM base_item_stock_adjustments a
        WHERE $4::text IS NOT NULL
          AND a.workspace_owner_id = $1
          AND a.idempotency_key = $4
        LIMIT 1
     ) duplicate ON true`,
    [workspaceOwnerId, baseItemId, locationId, idempotencyKey],
  );

  if (stockRow.rowCount === 0) {
    throw new InventoryError("INVALID_LEDGER_TARGET", {
      workspaceOwnerId,
      baseItemId,
      locationId,
    });
  }

  if (stockRow.rows[0]?.duplicate_id != null) {
    return {
      posted: false,
      reason: "duplicate",
      movementId: stockRow.rows[0].duplicate_id,
      stockAfter: parseFloat(stockRow.rows[0].duplicate_stock_after ?? "0"),
    };
  }

  const targetSnapshot = stockRow.rows[0];
  const currentStock = parseFloat(stockRow.rows[0]?.stock ?? "0");
  const projectedStock = currentStock + quantityChange;
  let allowedNegative = false;

  // 2. Negative-stock policy check
  if (projectedStock < 0) {
    if (!inventoryAllowNegativeStock) {
      throw new InventoryError("INSUFFICIENT_STOCK", {
        baseItemId,
        locationId,
        currentStock,
        quantityChange,
        projectedStock,
      });
    }
    allowedNegative = true;
    logger.warn(
      { baseItemId, locationId, currentStock, quantityChange },
      "inventoryService: negative stock allowed by workspace setting",
    );
  }

  const stockAfter = projectedStock;

  const resolvedReferenceType =
    referenceType ??
    (orderId
      ? "order"
      : purchaseOrderId
        ? "purchase_order"
        : transferId
          ? "transfer"
          : adjustmentActionId
            ? "stock_adjustment"
            : movementType);
  const resolvedReferenceId =
    referenceId ??
    (orderId ??
      (purchaseOrderId != null
        ? String(purchaseOrderId)
        : transferId != null
          ? String(transferId)
          : adjustmentActionId ?? idempotencyKey));

  // 3. Idempotent append. Contract snapshots are captured in the same row;
  // no caller is allowed to stamp or rewrite the row after insertion.
  const insertResult = await client.query<{ id: number }>(
    `INSERT INTO base_item_stock_adjustments
       (workspace_owner_id, base_item_id, location_id, quantity_change, reason,
        movement_type, note, stock_after, created_by_user_id,
        purchase_order_id, transfer_id,
        order_id, order_line_item_id, product_id,
         idempotency_key, reversal_of_id, recipe_snapshot, cutover_baseline,
         adjustment_action_id, ledger_scope, canonical_unit,
         base_item_name_snapshot, location_name_snapshot,
         actor_type, actor_id, actor_label_snapshot,
         source_type, source_id, source_label_snapshot,
         reference_type, reference_id, reference_label_snapshot,
         metadata_snapshot, created_at)
     VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
       $11, $12, $13, $14, $15, $16, $17, $18, $19, 'base_item_operational',
       $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32,
       clock_timestamp()
     )
     ON CONFLICT (workspace_owner_id, idempotency_key)
       WHERE idempotency_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      workspaceOwnerId, baseItemId, locationId, quantityChange, reason,
      movementType, note, stockAfter, createdByUserId,
      purchaseOrderId, transferId,
      orderId, orderLineItemId, productId,
      idempotencyKey, reversalOfId,
      recipeSnapshot ? JSON.stringify(recipeSnapshot) : null,
      cutoverBaseline,
      adjustmentActionId,
      canonicalUnit ?? targetSnapshot.canonical_unit ?? "unit",
      targetSnapshot.base_item_name ?? `Base Item ${baseItemId}`,
      targetSnapshot.location_name ?? `Location ${locationId}`,
      actorType,
      actorId ?? createdByUserId ?? "system",
      actorLabelSnapshot ?? createdByUserId ?? "System",
      sourceType ?? movementType,
      sourceId ?? resolvedReferenceId ?? idempotencyKey,
      sourceLabelSnapshot ?? reason,
      resolvedReferenceType,
      resolvedReferenceId,
      referenceLabelSnapshot ?? reason,
      metadataSnapshot ? JSON.stringify(metadataSnapshot) : JSON.stringify({}),
    ],
  );

  if (insertResult.rowCount === 0) {
    return { posted: false, reason: "duplicate" };
  }

  const movementId = insertResult.rows[0].id;

  // 4. Update location stock
  await client.query(
    `UPDATE base_item_location_statuses
        SET stock = $1, updated_at = now()
      WHERE base_item_id = $2 AND location_id = $3`,
    [stockAfter, baseItemId, locationId],
  );

  // 5. Recalculate total stock on base item
  await client.query(
    `UPDATE base_items
        SET stock = (
          SELECT COALESCE(SUM(stock), 0)
            FROM base_item_location_statuses
           WHERE base_item_id = $1 AND is_active = true
        )
      WHERE id = $1 AND workspace_owner_id = $2`,
    [baseItemId, workspaceOwnerId],
  );

  return { posted: true, movementId, stockAfter, allowedNegative };
}

/**
 * Append a compensating movement. The original row is never updated.
 * A partial unique index on reversal_of_id guarantees that an original
 * operational movement can only be reversed once, including concurrent retries.
 */
export async function reverseMovement(
  client: PoolClient,
  params: ReverseMovementParams,
): Promise<PostMovementResult> {
  if (!params.reason.trim() || !params.idempotencyKey.trim()) {
    throw new InventoryError("INVALID_MOVEMENT", {
      reason: "Reversal reason and idempotency key are required",
    });
  }

  const originalResult = await client.query<ReversibleMovementRow>(
    `SELECT
       id, workspace_owner_id, base_item_id, location_id, quantity_change,
       movement_type, reason, note, created_by_user_id, purchase_order_id,
       transfer_id, order_id, order_line_item_id, product_id, recipe_snapshot,
       canonical_unit, source_type, source_id, source_label_snapshot,
       reference_type, reference_id, reference_label_snapshot, metadata_snapshot
     FROM base_item_stock_adjustments
     WHERE id = $1
       AND workspace_owner_id = $2
       AND ledger_scope = 'base_item_operational'
     FOR UPDATE`,
    [params.movementId, params.workspaceOwnerId],
  );
  if (originalResult.rowCount === 0) {
    throw new InventoryError("MOVEMENT_NOT_FOUND", {
      movementId: params.movementId,
    });
  }
  const original = originalResult.rows[0];
  if (original.base_item_id == null || original.location_id == null) {
    throw new InventoryError("INVALID_LEDGER_TARGET", {
      movementId: params.movementId,
    });
  }

  const existing = await client.query<{ id: number; stock_after: string }>(
    `SELECT id, stock_after
       FROM base_item_stock_adjustments
      WHERE workspace_owner_id = $1
        AND reversal_of_id = $2
        AND ledger_scope = 'base_item_operational'
      LIMIT 1`,
    [params.workspaceOwnerId, params.movementId],
  );
  if (existing.rowCount! > 0) {
    return {
      posted: false,
      reason: "duplicate",
      movementId: existing.rows[0].id,
      stockAfter: parseFloat(existing.rows[0].stock_after),
    };
  }

  return postMovement(client, {
    workspaceOwnerId: params.workspaceOwnerId,
    baseItemId: original.base_item_id,
    locationId: original.location_id,
    quantityChange: -parseFloat(original.quantity_change),
    reason: params.reason.trim(),
    movementType: params.movementType ?? "reversal",
    note: params.note ?? null,
    createdByUserId: params.createdByUserId ?? null,
    purchaseOrderId: original.purchase_order_id,
    transferId: original.transfer_id,
    orderId: original.order_id,
    orderLineItemId: original.order_line_item_id,
    productId: original.product_id,
    idempotencyKey: params.idempotencyKey,
    reversalOfId: original.id,
    recipeSnapshot: original.recipe_snapshot,
    inventoryAllowNegativeStock: params.inventoryAllowNegativeStock ?? true,
    canonicalUnit: original.canonical_unit,
    actorType: params.actorType,
    actorId: params.actorId,
    actorLabelSnapshot: params.actorLabelSnapshot,
    sourceType: params.sourceType ?? "reversal",
    sourceId: params.sourceId ?? String(original.id),
    sourceLabelSnapshot:
      params.sourceLabelSnapshot ?? `Reversal of movement #${original.id}`,
    referenceType: original.reference_type,
    referenceId: original.reference_id,
    referenceLabelSnapshot: original.reference_label_snapshot,
    metadataSnapshot: {
      ...(original.metadata_snapshot ?? {}),
      reversalOfMovementId: original.id,
      originalMovementType: original.movement_type,
    },
  });
}

/**
 * Establish the one-time verified opening balance for a Base Item/location.
 * Existing baselines are returned unchanged; this function never moves a
 * cutover timestamp or silently replaces a verified balance.
 */
export async function establishOpeningBalance(
  client: PoolClient,
  params: EstablishOpeningBalanceParams,
): Promise<EstablishOpeningBalanceResult> {
  if (!params.verifiedByUserId.trim() || !params.reason.trim()) {
    throw new InventoryError("INVALID_MOVEMENT", {
      reason: "A verifier and reason are required for an opening balance",
    });
  }

  const snapshot = await loadLedgerTargetSnapshot(
    client,
    params.workspaceOwnerId,
    params.baseItemId,
    params.locationId,
  );
  const stockResult = await client.query<{ stock: string }>(
    `SELECT stock
       FROM base_item_location_statuses
      WHERE workspace_owner_id = $1
        AND base_item_id = $2
        AND location_id = $3
        AND is_active = true
      FOR UPDATE`,
    [params.workspaceOwnerId, params.baseItemId, params.locationId],
  );
  if (stockResult.rowCount === 0) {
    throw new InventoryError("INVALID_LEDGER_TARGET", {
      baseItemId: params.baseItemId,
      locationId: params.locationId,
      reason: "No active inventory balance exists for this location",
    });
  }

  const existing = await client.query<{
    cutover_at: Date;
    cutover_balance: string;
    movement_id: number | null;
  }>(
    `SELECT
       ls.cutover_at,
       ls.cutover_balance,
       (
         SELECT a.id
           FROM base_item_stock_adjustments a
          WHERE a.workspace_owner_id = ls.workspace_owner_id
            AND a.base_item_id = ls.base_item_id
            AND a.location_id = ls.location_id
            AND a.cutover_baseline = true
          ORDER BY a.id ASC
          LIMIT 1
       ) AS movement_id
     FROM base_item_ledger_settings ls
     WHERE ls.workspace_owner_id = $1
       AND ls.base_item_id = $2
       AND ls.location_id = $3
     FOR UPDATE`,
    [params.workspaceOwnerId, params.baseItemId, params.locationId],
  );
  if (existing.rowCount! > 0) {
    const row = existing.rows[0];
    if (row.movement_id == null) {
      throw new InventoryError("OPENING_BALANCE_EXISTS", {
        baseItemId: params.baseItemId,
        locationId: params.locationId,
        reason: "Opening-balance setting exists without its audit movement",
      });
    }
    return {
      created: false,
      movementId: row.movement_id,
      cutoverAt: row.cutover_at,
      cutoverBalance: parseFloat(row.cutover_balance),
    };
  }

  const cutoverAt = params.cutoverAt ?? new Date();
  const cutoverBalance = parseFloat(stockResult.rows[0].stock);
  const idempotencyKey =
    params.idempotencyKey ??
    `opening-balance:${params.workspaceOwnerId}:${params.baseItemId}:${params.locationId}`;

  await client.query(
    `INSERT INTO base_item_ledger_settings
       (workspace_owner_id, base_item_id, location_id, cutover_at, cutover_balance,
        verified_by_user_id, verified_by_label_snapshot, verification_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      params.workspaceOwnerId,
      params.baseItemId,
      params.locationId,
      cutoverAt,
      cutoverBalance,
      params.verifiedByUserId,
      params.verifiedByLabel ?? null,
      params.reason.trim(),
    ],
  );

  const insert = await client.query<{ id: number }>(
    `INSERT INTO base_item_stock_adjustments (
       workspace_owner_id, base_item_id, location_id, quantity_change, reason,
       movement_type, stock_after, created_by_user_id, idempotency_key,
       cutover_baseline, ledger_scope, canonical_unit,
       base_item_name_snapshot, location_name_snapshot,
       actor_type, actor_id, actor_label_snapshot,
       source_type, source_id, source_label_snapshot,
       reference_type, reference_id, reference_label_snapshot,
       metadata_snapshot, created_at
     ) VALUES (
       $1, $2, $3, 0, $4, 'opening_balance', $5, $6, $7,
       true, 'base_item_operational', $8, $9, $10,
       'migration', $6, $11,
       'verified_cutover', $12, $13,
       'opening_balance', $12, $13,
       $14::jsonb, $15
     )
     ON CONFLICT (workspace_owner_id, idempotency_key)
       WHERE idempotency_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      params.workspaceOwnerId,
      params.baseItemId,
      params.locationId,
      params.reason.trim(),
      cutoverBalance,
      params.verifiedByUserId,
      idempotencyKey,
      snapshot.canonical_unit,
      snapshot.base_item_name,
      snapshot.location_name,
      params.verifiedByLabel ?? null,
      `${params.baseItemId}:${params.locationId}`,
      `Verified opening balance for ${snapshot.base_item_name} at ${snapshot.location_name}`,
      JSON.stringify({ verified: true, balanceSource: "base_item_location_statuses" }),
      cutoverAt,
    ],
  );
  if (insert.rowCount === 0) {
    throw new InventoryError("OPENING_BALANCE_EXISTS", {
      idempotencyKey,
      reason: "Opening-balance idempotency key already exists",
    });
  }

  return {
    created: true,
    movementId: insert.rows[0].id,
    cutoverAt,
    cutoverBalance,
  };
}
