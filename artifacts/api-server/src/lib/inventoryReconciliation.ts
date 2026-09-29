import type { Pool, PoolClient } from "pg";

export type InventoryReconciliationStatus =
  | "reconciled"
  | "discrepancy"
  | "missing_baseline";

export interface InventoryReconciliationRow {
  workspaceOwnerId: string;
  baseItemId: number;
  baseItemName: string;
  locationId: number;
  locationName: string;
  onHandBalance: number;
  cutoverAt: Date | null;
  cutoverBalance: number | null;
  movementTotalAfterCutover: number;
  ledgerBalance: number | null;
  discrepancy: number | null;
  status: InventoryReconciliationStatus;
}

export interface InventoryReconciliationReport {
  workspaceOwnerId: string;
  generatedAt: Date;
  rows: InventoryReconciliationRow[];
  totals: {
    pairs: number;
    reconciled: number;
    discrepancies: number;
    missingBaselines: number;
  };
  recipeConsumptionReady: boolean;
}

interface ReconciliationDbRow {
  workspace_owner_id: string;
  base_item_id: number;
  base_item_name: string;
  location_id: number;
  location_name: string;
  on_hand_balance: string;
  cutover_at: Date | null;
  cutover_balance: string | null;
  movement_total_after_cutover: string;
}

/**
 * Read-only per-location reconciliation for the Base Item operational ledger.
 *
 * The report never repairs either side. Operators must investigate a
 * discrepancy and post an explicit correction; history is never rewritten.
 */
export async function reconcileOperationalLedger(
  db: Pool | PoolClient,
  workspaceOwnerId: string,
  baseItemId?: number | null,
): Promise<InventoryReconciliationReport> {
  const params: Array<string | number> = [workspaceOwnerId];
  const baseItemFilter =
    baseItemId == null ? "" : `AND bils.base_item_id = $${params.push(baseItemId)}`;

  const result = await db.query<ReconciliationDbRow>(
    `SELECT
       bils.workspace_owner_id,
       bils.base_item_id,
       bi.name AS base_item_name,
       bils.location_id,
       l.name AS location_name,
       bils.stock::text AS on_hand_balance,
       ls.cutover_at,
       ls.cutover_balance::text,
       COALESCE(SUM(
         CASE
           WHEN a.id IS NOT NULL
            AND a.cutover_baseline = false
            AND a.created_at > ls.cutover_at
           THEN a.quantity_change
           ELSE 0
         END
       ), 0)::text AS movement_total_after_cutover
     FROM base_item_location_statuses bils
     JOIN base_items bi
       ON bi.id = bils.base_item_id
      AND bi.workspace_owner_id = bils.workspace_owner_id
     JOIN locations l
       ON l.id = bils.location_id
      AND l.workspace_owner_id = bils.workspace_owner_id
     LEFT JOIN base_item_ledger_settings ls
       ON ls.workspace_owner_id = bils.workspace_owner_id
      AND ls.base_item_id = bils.base_item_id
      AND ls.location_id = bils.location_id
     LEFT JOIN base_item_stock_adjustments a
       ON a.workspace_owner_id = bils.workspace_owner_id
      AND a.base_item_id = bils.base_item_id
      AND a.location_id = bils.location_id
      AND a.ledger_scope = 'base_item_operational'
      AND ls.cutover_at IS NOT NULL
      AND a.created_at > ls.cutover_at
     WHERE bils.workspace_owner_id = $1
       AND bils.is_active = true
       ${baseItemFilter}
     GROUP BY
       bils.workspace_owner_id, bils.base_item_id, bi.name,
       bils.location_id, l.name, bils.stock,
       ls.cutover_at, ls.cutover_balance
     ORDER BY bi.name ASC, l.name ASC, bils.base_item_id, bils.location_id`,
    params,
  );

  const rows = result.rows.map((row): InventoryReconciliationRow => {
    const onHandBalance = parseFloat(row.on_hand_balance);
    const cutoverBalance =
      row.cutover_balance == null ? null : parseFloat(row.cutover_balance);
    const movementTotalAfterCutover = parseFloat(
      row.movement_total_after_cutover,
    );
    const ledgerBalance =
      cutoverBalance == null
        ? null
        : cutoverBalance + movementTotalAfterCutover;
    const discrepancy =
      ledgerBalance == null ? null : onHandBalance - ledgerBalance;
    const status: InventoryReconciliationStatus =
      cutoverBalance == null
        ? "missing_baseline"
        : Math.abs(discrepancy ?? 0) < 0.000001
          ? "reconciled"
          : "discrepancy";

    return {
      workspaceOwnerId: row.workspace_owner_id,
      baseItemId: row.base_item_id,
      baseItemName: row.base_item_name,
      locationId: row.location_id,
      locationName: row.location_name,
      onHandBalance,
      cutoverAt: row.cutover_at,
      cutoverBalance,
      movementTotalAfterCutover,
      ledgerBalance,
      discrepancy,
      status,
    };
  });

  const totals = {
    pairs: rows.length,
    reconciled: rows.filter((row) => row.status === "reconciled").length,
    discrepancies: rows.filter((row) => row.status === "discrepancy").length,
    missingBaselines: rows.filter(
      (row) => row.status === "missing_baseline",
    ).length,
  };

  return {
    workspaceOwnerId,
    generatedAt: new Date(),
    rows,
    totals,
    recipeConsumptionReady:
      rows.length > 0 &&
      totals.discrepancies === 0 &&
      totals.missingBaselines === 0,
  };
}