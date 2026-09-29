/**
 * reconcileInventoryConsumption
 *
 * Identifies order line items whose inventory consumption movements are missing.
 * It is report-only by default. Historical writes require both `--apply` and an
 * explicit acknowledgement that recipes, fulfilment locations, order quantities,
 * statuses, and unit conversions were independently verified.
 *
 * A line is considered "satisfied" when it has at least one UNREVERSED
 * product_consumption row (i.e., one that has not been offset by an
 * order_cancellation reversal). Lines with only reversed consumptions, or no
 * consumption at all, are treated as missing.
 *
 * Usage (from artifacts/api-server/):
 *   # Dry-run (no writes):
 *   node_modules/.bin/tsx scripts/src/reconcileInventoryConsumption.ts \
 *     --orgId <workspace_owner_id> \
 *     --from 2026-01-01 \
 *     --to 2026-08-01 \
 *     --dry-run
 *
 *   # Execute only after independently verifying historical evidence:
 *   node_modules/.bin/tsx scripts/src/reconcileInventoryConsumption.ts \
 *     --orgId <workspace_owner_id> \
 *     --from 2026-01-01 \
 *     --to 2026-08-01 \
 *     --apply \
 *     --acknowledge-history-reliable
 */

import { db } from "../../src/lib/db";
import { postRecipeConsumption } from "../../src/lib/recipeConsumption";
import { logger } from "../../src/lib/logger";
import { reconcileOperationalLedger } from "../../src/lib/inventoryReconciliation";

// Statuses that should have had inventory consumed
const QUALIFYING_STATUSES = [
  "ready_for_delivery",
  "out_for_delivery",
  "delivered",
  "completed",
];

interface CliFlags {
  orgId: string;
  from: string;
  to: string;
  dryRun: boolean;
  acknowledgeHistoryReliable: boolean;
}

function parseArgs(): CliFlags {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx !== -1 ? args[idx + 1] : undefined;
  };

  const orgId = get("--orgId");
  const from = get("--from");
  const to = get("--to");
  const apply = args.includes("--apply");
  const acknowledgeHistoryReliable = args.includes(
    "--acknowledge-history-reliable",
  );
  const dryRun = !apply;

  if (!orgId || !from || !to) {
    console.error("Usage: reconcileInventoryConsumption.ts --orgId <id> --from <ISO> --to <ISO> [--apply --acknowledge-history-reliable]");
    console.error("  --orgId  Workspace owner ID (required)");
    console.error("  --from   Start date ISO e.g. 2026-01-01 (required)");
    console.error("  --to     End date ISO e.g. 2026-08-01 (required, exclusive)");
    console.error("  Default: report only, no DB writes");
    process.exit(1);
  }
  if (apply && !acknowledgeHistoryReliable) {
    console.error(
      "--apply requires --acknowledge-history-reliable. Do not reconstruct uncertain historical consumption.",
    );
    process.exit(1);
  }

  return { orgId, from, to, dryRun, acknowledgeHistoryReliable };
}

interface EligibleOrder {
  order_id: string;
  ordered_at: Date;
  status: string;
}

interface MovementCheckResult {
  /** Number of expected (lineItemId, baseItemId) consumption pairs */
  expectedMovements: number;
  /** Number of pairs that already have an unreversed consumption movement */
  existingMovements: number;
  /** Number of pairs with no unreversed consumption movement (need backfill) */
  missingMovements: number;
  /** Lines that can't be reconciled (no recipe, no location) */
  ambiguous: number;
}

/**
 * Determine which (lineItemId, baseItemId) consumption pairs are missing
 * for an order.
 *
 * A pair is "existing" (satisfied) if it has at least one product_consumption
 * row that has NOT been reversed by an order_cancellation movement.
 * A pair is "missing" if it has zero unreversed consumption rows.
 *
 * This is safe to call repeatedly; it never writes to the DB.
 */
async function checkOrderMovements(
  orderId: string,
  workspaceOwnerId: string,
): Promise<MovementCheckResult> {
  // Fetch line items with recipe linkage
  const lineItems = await db.query<{
    line_item_id: string;
    product_id: number;
    inventory_tracked: boolean;
    quantity: string;
    base_item_id: number | null;
    recipe_qty: string | null;
  }>(
    `SELECT
       oli.id::text         AS line_item_id,
       p.id                 AS product_id,
       p.inventory_tracked  AS inventory_tracked,
       oli.quantity::text   AS quantity,
       bi.id                AS base_item_id,
       pr.quantity::text    AS recipe_qty
     FROM order_line_items oli
     JOIN products p ON p.id = oli.product_id
     LEFT JOIN product_recipes pr ON pr.product_id = p.id
     LEFT JOIN base_items bi ON bi.id = pr.base_item_id
     WHERE oli.order_id = $1
       AND p.workspace_owner_id = $2`,
    [orderId, workspaceOwnerId],
  );

  // Resolve location (florist assignment first, then orders.location_id)
  const locationRow = await db.query<{ location_id: number | null }>(
    `SELECT COALESCE(ofa.location_id, o.location_id) AS location_id
       FROM orders o
       LEFT JOIN order_florist_assignments ofa
         ON ofa.order_id = o.id AND ofa.workspace_owner_id = o.workspace_owner_id
      WHERE o.id = $1 AND o.workspace_owner_id = $2
      LIMIT 1`,
    [orderId, workspaceOwnerId],
  );
  const locationId = locationRow.rows[0]?.location_id ?? null;

  // Build expected (lineItemId, baseItemId) pairs (deduplicated)
  type Pair = { lineItemId: string; baseItemId: number };
  const expectedPairs = new Map<string, Pair>();
  let ambiguous = 0;

  for (const row of lineItems.rows) {
    if (!row.inventory_tracked) continue;
    if (row.base_item_id == null || row.recipe_qty == null) {
      ambiguous++;
      continue;
    }
    if (locationId == null) {
      ambiguous++;
      continue;
    }
    const key = `${row.line_item_id}:${row.base_item_id}`;
    if (!expectedPairs.has(key)) {
      expectedPairs.set(key, { lineItemId: row.line_item_id, baseItemId: row.base_item_id });
    }
  }

  const expectedMovements = expectedPairs.size;

  if (expectedMovements === 0) {
    return { expectedMovements: 0, existingMovements: 0, missingMovements: 0, ambiguous };
  }

  // For each expected pair, check whether an UNREVERSED product_consumption
  // row exists. A row is "reversed" when a matching order_cancellation movement
  // references it via reversal_of_id. A pair is "satisfied" when at least one
  // unreversed row exists — regardless of idempotency key format or cycle number.
  const lineItemIds = [...new Set([...expectedPairs.values()].map((p) => p.lineItemId))];
  const baseItemIds = [...new Set([...expectedPairs.values()].map((p) => p.baseItemId))];

  const activeRows = await db.query<{
    order_line_item_id: string;
    base_item_id: number;
    active_count: string;
  }>(
    `SELECT
       a.order_line_item_id,
       a.base_item_id,
       COUNT(*)::text AS active_count
     FROM base_item_stock_adjustments a
     WHERE a.order_id = $1
       AND a.workspace_owner_id = $2
        AND a.ledger_scope = 'base_item_operational'
       AND a.movement_type = 'product_consumption'
       AND a.order_line_item_id = ANY($3::text[])
       AND a.base_item_id = ANY($4::int[])
       AND NOT EXISTS (
         SELECT 1 FROM base_item_stock_adjustments r
           WHERE r.reversal_of_id = a.id
             AND r.ledger_scope = 'base_item_operational'
             AND r.movement_type = 'order_cancellation'
       )
     GROUP BY a.order_line_item_id, a.base_item_id`,
    [orderId, workspaceOwnerId, lineItemIds, baseItemIds],
  );

  const satisfiedPairs = new Set<string>();
  for (const r of activeRows.rows) {
    const pairKey = `${r.order_line_item_id}:${r.base_item_id}`;
    // Only mark as satisfied if this is an actually-expected pair.
    // The DB query uses ANY(lineItemIds) × ANY(baseItemIds), which can return
    // stale cross-pair rows (e.g. lineA × baseB when we only expect lineA × baseA).
    if (parseInt(r.active_count, 10) > 0 && expectedPairs.has(pairKey)) {
      satisfiedPairs.add(pairKey);
    }
  }

  const existingMovements = satisfiedPairs.size;
  const missingMovements = expectedMovements - existingMovements;

  return { expectedMovements, existingMovements, missingMovements, ambiguous };
}

async function run(): Promise<void> {
  const flags = parseArgs();

  console.log("=".repeat(70));
  console.log("Inventory Consumption Reconciliation");
  console.log("=".repeat(70));
  console.log(`  orgId:    ${flags.orgId}`);
  console.log(`  from:     ${flags.from}`);
  console.log(`  to:       ${flags.to}`);
  console.log(`  dry-run:  ${flags.dryRun}`);
  console.log("");
  console.log("Dry-run command:");
  console.log(
    `  node_modules/.bin/tsx scripts/src/reconcileInventoryConsumption.ts --orgId ${flags.orgId} --from ${flags.from} --to ${flags.to} --dry-run`,
  );
  console.log("Execute command:");
  console.log(
    `  node_modules/.bin/tsx scripts/src/reconcileInventoryConsumption.ts --orgId ${flags.orgId} --from ${flags.from} --to ${flags.to} --apply --acknowledge-history-reliable`,
  );
  console.log("=".repeat(70));
  console.log("");

  // Check feature flag
  const settingsRow = await db.query<{
    inventory_recipe_consumption_enabled: boolean;
    inventory_allow_negative_stock: boolean;
  }>(
    `SELECT inventory_recipe_consumption_enabled, inventory_allow_negative_stock
       FROM workspace_settings WHERE workspace_owner_id = $1`,
    [flags.orgId],
  );
  if (!settingsRow.rows[0]) {
    console.error(`No workspace_settings row found for orgId=${flags.orgId}`);
    process.exit(1);
  }
  const { inventory_recipe_consumption_enabled } = settingsRow.rows[0];
  if (!inventory_recipe_consumption_enabled) {
    console.warn(
      "⚠️  inventory_recipe_consumption_enabled is FALSE for this workspace.",
      "The report remains valid; historical writes are blocked until the pre-existing feature flag is enabled and all ledger checks pass.",
    );
  }

  // Never write historical consumption until every active Base Item/location
  // has a verified opening baseline and currently reconciles with on-hand.
  const ledgerReport = await reconcileOperationalLedger(db, flags.orgId);
  console.log("Operational ledger reconciliation:");
  console.log(
    `  pairs=${ledgerReport.totals.pairs} reconciled=${ledgerReport.totals.reconciled} ` +
      `discrepancies=${ledgerReport.totals.discrepancies} missingBaselines=${ledgerReport.totals.missingBaselines}`,
  );
  for (const row of ledgerReport.rows.filter((entry) => entry.status !== "reconciled")) {
    console.log(
      `  [${row.status.toUpperCase()}] baseItem=${row.baseItemId} location=${row.locationId} ` +
        `onHand=${row.onHandBalance} ledger=${row.ledgerBalance ?? "N/A"} ` +
        `discrepancy=${row.discrepancy ?? "N/A"}`,
    );
  }
  console.log("");
  if (!flags.dryRun && !ledgerReport.recipeConsumptionReady) {
    console.error(
      "Refusing --apply: verified opening balances and zero per-location reconciliation discrepancies are required.",
    );
    process.exit(1);
  }
  if (!flags.dryRun && !inventory_recipe_consumption_enabled) {
    console.error(
      "Refusing --apply: inventory_recipe_consumption_enabled is false. This task does not enable it.",
    );
    process.exit(1);
  }

  // Fetch qualifying orders
  const ordersResult = await db.query<EligibleOrder>(
    `SELECT o.id AS order_id, o.ordered_at, o.status
       FROM orders o
      WHERE o.workspace_owner_id = $1
        AND o.status = ANY($2::text[])
        AND o.ordered_at >= $3::timestamptz
        AND o.ordered_at <  $4::timestamptz
      ORDER BY o.ordered_at ASC`,
    [flags.orgId, QUALIFYING_STATUSES, flags.from, flags.to],
  );

  const orders = ordersResult.rows;
  console.log(`Eligible orders found: ${orders.length}`);
  console.log("");

  let ordersExamined = 0;
  let totalExpected = 0;
  let totalExisting = 0;
  let totalMissing = 0;
  let totalAmbiguous = 0;
  let failures = 0;

  for (const order of orders) {
    ordersExamined++;
    try {
      const check = await checkOrderMovements(order.order_id, flags.orgId);
      totalExpected += check.expectedMovements;
      totalExisting += check.existingMovements;
      totalMissing += check.missingMovements;
      totalAmbiguous += check.ambiguous;

      if (check.missingMovements > 0) {
        console.log(
          `  [MISSING] order=${order.order_id} status=${order.status} ` +
          `expected=${check.expectedMovements} existing=${check.existingMovements} ` +
          `missing=${check.missingMovements} ambiguous=${check.ambiguous}`,
        );

        if (!flags.dryRun) {
          // Execute: create missing movements for this order in its own transaction.
          // postRecipeConsumption is idempotent: it detects active (unreversed)
          // movements and skips them, so a second run is safe.
          const client = await db.connect();
          try {
            await client.query("BEGIN");
            const result = await postRecipeConsumption(client, order.order_id, flags.orgId);
            await client.query("COMMIT");
            if (result.skipped === "flag_off") {
              console.log(`    → skipped (flag_off)`);
            } else {
              console.log(
                `    → posted=${result.movementsPosted} skipped=${result.movementsSkipped}`,
              );
            }
          } catch (err) {
            await client.query("ROLLBACK").catch(() => {});
            console.error(`    → ERROR: ${err instanceof Error ? err.message : String(err)}`);
            failures++;
          } finally {
            client.release();
          }
        }
      }
    } catch (err) {
      console.error(
        `  [ERROR] order=${order.order_id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      failures++;
    }
  }

  console.log("");
  console.log("=".repeat(70));
  console.log("Summary");
  console.log("=".repeat(70));
  console.log(`  ordersExamined:    ${ordersExamined}`);
  console.log(`  expectedMovements: ${totalExpected}`);
  console.log(`  existingMovements: ${totalExisting}`);
  console.log(`  missingMovements:  ${totalMissing}`);
  console.log(`  ambiguous:         ${totalAmbiguous}`);
  console.log(`  failures:          ${failures}`);
  if (flags.dryRun) {
    console.log("");
    console.log("Dry-run complete — no DB writes were made.");
    console.log("Re-run without --dry-run to create missing movements.");
  } else {
    console.log("");
    console.log("Execution complete. Re-run with --dry-run to verify.");
  }
  console.log("=".repeat(70));
}

run()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    logger.error({ err }, "reconcileInventoryConsumption: fatal error");
    console.error(err);
    process.exit(1);
  });
