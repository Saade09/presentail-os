/**
 * setLedgerCutover.ts
 *
 * CLI script to write cutover baseline rows for a workspace. Must be run
 * AFTER any legacy stock adjustments have been recorded and BEFORE turning
 * on inventory_recipe_consumption_enabled.
 *
 * Usage:
 *   # Required first pass (default is report-only):
 *   pnpm --filter @workspace/scripts run set-ledger-cutover \
 *     --workspace-owner-id=<id> [--base-item-id=<id>]
 *
 *   # Apply only after the report is physically verified:
 *   pnpm --filter @workspace/scripts run set-ledger-cutover \
 *     --workspace-owner-id=<id> [--base-item-id=<id>] \
 *     --apply --verified-by-user-id=<clerk-user-id>
 *
 * What it does per (base_item_id, location_id) pair:
 *   1. Creates a pre-committed run record in base_item_cutover_runs (status=running)
 *   2. Reads the current stock from base_item_location_statuses
 *   3. Upserts a row in base_item_ledger_settings
 *   4. Inserts a base_item_stock_adjustments row with cutover_baseline=true (idempotent)
 *   5. Updates run record to completed with a report
 *
 * The command is dry-run by default. `--apply` is required for writes.
 * Existing cutovers are immutable: reruns report them and never move their
 * timestamp or replace their verified balance.
 */

import pg from "pg";
import process from "process";

const { Pool } = pg;

function parseArgs(): {
  workspaceOwnerId: string;
  baseItemId: number | null;
  dryRun: boolean;
  verifiedByUserId: string | null;
} {
  const args = process.argv.slice(2);
  let workspaceOwnerId = "";
  let baseItemId: number | null = null;
  let apply = false;
  let verifiedByUserId: string | null = null;

  for (const arg of args) {
    if (arg === "--dry-run") continue;
    if (arg === "--apply") { apply = true; continue; }
    const [key, val] = arg.split("=");
    if (!key || val === undefined) continue;
    if (key === "--workspace-owner-id") {
      workspaceOwnerId = val;
    } else if (key === "--base-item-id") {
      const n = parseInt(val, 10);
      if (!isNaN(n)) baseItemId = n;
    } else if (key === "--verified-by-user-id") {
      verifiedByUserId = val.trim() || null;
    }
  }

  if (!workspaceOwnerId) {
    console.error("Error: --workspace-owner-id is required");
    process.exit(1);
  }
  if (apply && !verifiedByUserId) {
    console.error("Error: --verified-by-user-id is required with --apply");
    process.exit(1);
  }

  return {
    workspaceOwnerId,
    baseItemId,
    dryRun: !apply,
    verifiedByUserId,
  };
}

async function main() {
  const { workspaceOwnerId, baseItemId, dryRun, verifiedByUserId } = parseArgs();

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  // ── 1. Pre-commit a run record (outside the main transaction) ────────────
  let runId: number | null = null;
  if (!dryRun) {
    const runResult = await pool.query<{ id: number }>(
      `INSERT INTO base_item_cutover_runs
         (workspace_owner_id, base_item_id, status, started_at)
       VALUES ($1, $2, 'running', now())
       RETURNING id`,
      [workspaceOwnerId, baseItemId],
    );
    runId = runResult.rows[0].id;
    console.log(`Run record created: id=${runId}`);
  } else {
    console.log("[DRY RUN] No changes will be written.\n");
  }

  let processed = 0;
  let skipped = 0;
  const errors: string[] = [];
  const reconciliation: Array<{
    baseItemId: number;
    locationId: number;
    onHand: number;
    ledgerBalance: number | null;
    discrepancy: number | null;
    status: "reconciled" | "discrepancy" | "missing_baseline";
  }> = [];

  try {
    const filterParts = ["bils.workspace_owner_id = $1"];
    const filterParams: unknown[] = [workspaceOwnerId];

    if (baseItemId !== null) {
      filterParts.push(`bils.base_item_id = $${filterParams.length + 1}`);
      filterParams.push(baseItemId);
    }

    const rows = await pool.query<{
      base_item_id: number;
      base_item_name: string;
      location_id: number;
      location_name: string;
      stock: string;
    }>(
      `SELECT bils.base_item_id, bi.name AS base_item_name,
              bils.location_id, l.name AS location_name,
              bils.stock
         FROM base_item_location_statuses bils
         JOIN base_items bi ON bi.id = bils.base_item_id
         JOIN locations l ON l.id = bils.location_id
         WHERE ${filterParts.join(" AND ")}
          AND bils.is_active = true`,
      filterParams,
    );

    if (rows.rowCount === 0) {
      console.log(`No active location-status rows found for workspace ${workspaceOwnerId}${baseItemId ? ` (base item ${baseItemId})` : ""}.`);
      if (!dryRun && runId !== null) {
        await pool.query(
          `UPDATE base_item_cutover_runs
              SET status = 'completed', completed_at = now(),
                  report_json = $1::jsonb
            WHERE id = $2`,
          [JSON.stringify({ processed: 0, skipped: 0, errors: [] }), runId],
        );
      }
      process.exit(0);
    }

    console.log(`Found ${rows.rowCount} location(s) to process.\n`);

    for (const row of rows.rows) {
      const balance = parseFloat(row.stock);
      const idempotencyKey = `cutover:${row.base_item_id}:${row.location_id}`;
      const label = `${row.base_item_name} (${row.base_item_id}) @ ${row.location_name} (${row.location_id})`;

      if (dryRun) {
        console.log(`[DRY RUN] Would process: ${label} — balance: ${balance}`);
        processed++;
        continue;
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const existing = await client.query<{
          cutover_at: Date;
          cutover_balance: string;
        }>(
          `SELECT cutover_at, cutover_balance
             FROM base_item_ledger_settings
            WHERE workspace_owner_id = $1
              AND base_item_id = $2
              AND location_id = $3
            FOR UPDATE`,
          [workspaceOwnerId, row.base_item_id, row.location_id],
        );
        if (existing.rowCount! > 0) {
          await client.query("ROLLBACK");
          console.log(
            `[SKIPPED] ${label} — verified cutover already exists at ${existing.rows[0].cutover_at.toISOString()} with balance ${existing.rows[0].cutover_balance}`,
          );
          skipped++;
          continue;
        }

        const cutoverAt = new Date();
        const verificationReason =
          "Physically verified opening balance for Base Item ledger cutover";

        await client.query(
          `INSERT INTO base_item_ledger_settings
             (workspace_owner_id, base_item_id, location_id, cutover_at,
              cutover_balance, verified_by_user_id, verification_reason)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            workspaceOwnerId,
            row.base_item_id,
            row.location_id,
            cutoverAt,
            balance,
            verifiedByUserId,
            verificationReason,
          ],
        );

        // Idempotent baseline movement
        const insert = await client.query<{ id: number }>(
          `INSERT INTO base_item_stock_adjustments
             (workspace_owner_id, base_item_id, location_id, quantity_change, reason,
               movement_type, stock_after, idempotency_key, cutover_baseline,
               ledger_scope, canonical_unit, base_item_name_snapshot,
               location_name_snapshot, actor_type, actor_id,
               actor_label_snapshot, source_type, source_id,
               source_label_snapshot, reference_type, reference_id,
               reference_label_snapshot, metadata_snapshot, created_at)
            VALUES ($1, $2, $3, 0, $6,
                    'opening_balance', $4, $5, true,
                    'base_item_operational',
                    COALESCE((
                      SELECT bip.unit FROM base_item_packages bip
                       WHERE bip.base_item_id = $2 AND bip.is_default = true
                       ORDER BY bip.id LIMIT 1
                    ), 'unit'),
                    $7, $8, 'migration', $9, $9,
                    'verified_cutover', $10, $11,
                    'opening_balance', $10, $11, $12::jsonb, $13)
            ON CONFLICT (workspace_owner_id, idempotency_key)
              WHERE idempotency_key IS NOT NULL DO NOTHING
           RETURNING id`,
          [
            workspaceOwnerId,
            row.base_item_id,
            row.location_id,
            balance,
            idempotencyKey,
            verificationReason,
            row.base_item_name,
            row.location_name,
            verifiedByUserId,
            `${row.base_item_id}:${row.location_id}`,
            `Verified opening balance for ${row.base_item_name} at ${row.location_name}`,
            JSON.stringify({
              verified: true,
              balanceSource: "base_item_location_statuses",
            }),
            cutoverAt,
          ],
        );

        await client.query("COMMIT");

        if ((insert.rowCount ?? 0) > 0) {
          console.log(`[DONE]    ${label} — balance: ${balance}`);
          processed++;
        } else {
          console.log(`[SKIPPED] ${label} — already has cutover row`);
          skipped++;
        }
      } catch (err) {
        await client.query("ROLLBACK");
        const msg = `${label}: ${(err as Error).message}`;
        console.error(`[ERROR]   ${msg}`);
        errors.push(msg);
      } finally {
        client.release();
      }
    }

    // Read-only reconciliation after the proposed/applied pass. Dry-run rows
    // without baselines are deliberately reported as missing rather than
    // pretending that the current on-hand value is already verified.
    const reconciliationRows = await pool.query<{
      base_item_id: number;
      location_id: number;
      on_hand: string;
      ledger_balance: string | null;
    }>(
      `SELECT
         bils.base_item_id,
         bils.location_id,
         bils.stock::text AS on_hand,
         CASE
           WHEN ls.id IS NULL THEN NULL
           ELSE (
             ls.cutover_balance
             + COALESCE(SUM(
                 CASE
                   WHEN a.cutover_baseline = false
                    AND a.created_at > ls.cutover_at
                   THEN a.quantity_change
                   ELSE 0
                 END
               ), 0)
           )::text
         END AS ledger_balance
       FROM base_item_location_statuses bils
       LEFT JOIN base_item_ledger_settings ls
         ON ls.workspace_owner_id = bils.workspace_owner_id
        AND ls.base_item_id = bils.base_item_id
        AND ls.location_id = bils.location_id
       LEFT JOIN base_item_stock_adjustments a
         ON a.workspace_owner_id = bils.workspace_owner_id
        AND a.base_item_id = bils.base_item_id
        AND a.location_id = bils.location_id
        AND a.ledger_scope = 'base_item_operational'
       WHERE bils.workspace_owner_id = $1
         AND bils.is_active = true
         ${baseItemId == null ? "" : "AND bils.base_item_id = $2"}
       GROUP BY bils.base_item_id, bils.location_id, bils.stock,
                ls.id, ls.cutover_balance`,
      baseItemId == null ? [workspaceOwnerId] : [workspaceOwnerId, baseItemId],
    );
    for (const row of reconciliationRows.rows) {
      const onHand = parseFloat(row.on_hand);
      const ledgerBalance =
        row.ledger_balance == null ? null : parseFloat(row.ledger_balance);
      const discrepancy =
        ledgerBalance == null ? null : onHand - ledgerBalance;
      const status =
        ledgerBalance == null
          ? "missing_baseline"
          : Math.abs(discrepancy ?? 0) < 0.000001
            ? "reconciled"
            : "discrepancy";
      reconciliation.push({
        baseItemId: row.base_item_id,
        locationId: row.location_id,
        onHand,
        ledgerBalance,
        discrepancy,
        status,
      });
      console.log(
        `[${status.toUpperCase()}] base_item=${row.base_item_id} location=${row.location_id} on_hand=${onHand} ledger=${ledgerBalance ?? "N/A"} discrepancy=${discrepancy ?? "N/A"}`,
      );
    }

    console.log(`\n${dryRun ? "[DRY RUN] " : ""}Done. Processed: ${processed}, Skipped (already existed): ${skipped}${errors.length > 0 ? `, Errors: ${errors.length}` : ""}`);

    // ── Update run record to completed ───────────────────────────────────
    if (!dryRun && runId !== null) {
      const finalStatus = errors.length > 0 ? "completed_with_errors" : "completed";
      await pool.query(
        `UPDATE base_item_cutover_runs
            SET status = $1, completed_at = now(), report_json = $2::jsonb
          WHERE id = $3`,
        [
          finalStatus,
          JSON.stringify({ processed, skipped, errors, reconciliation }),
          runId,
        ],
      );
      console.log(`Run record ${runId} updated to ${finalStatus}.`);
    }
  } catch (err) {
    console.error("Fatal error:", err);
    if (!dryRun && runId !== null) {
      await pool.query(
        `UPDATE base_item_cutover_runs
            SET status = 'failed', completed_at = now(), report_json = $1::jsonb
          WHERE id = $2`,
        [JSON.stringify({ error: (err as Error).message }), runId],
      ).catch(() => { /* best effort */ });
    }
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
