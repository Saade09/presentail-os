import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import pg from "pg";
import {
  establishOpeningBalance,
  postMovement,
  reverseMovement,
} from "./inventoryService";
import { reconcileOperationalLedger } from "./inventoryReconciliation";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const OWNER_ID = "__integration_inventory_ledger_foundation__";
const USER_ID = "__integration_inventory_ledger_user__";

describe.skipIf(!DATABASE_URL)(
  "Base Item operational ledger foundation (real database)",
  () => {
    let pool: InstanceType<typeof Pool>;
    let baseItemId: number;
    let locationAId: number;
    let locationBId: number;

    async function clearLedgerAndResetStock(): Promise<void> {
      await pool.query(
        `DELETE FROM base_item_stock_adjustments WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM base_item_ledger_settings WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      await pool.query(
        `UPDATE base_item_location_statuses
            SET stock = CASE
              WHEN location_id = $1 THEN 10
              WHEN location_id = $2 THEN 4
            END
          WHERE workspace_owner_id = $3
            AND base_item_id = $4`,
        [locationAId, locationBId, OWNER_ID, baseItemId],
      );
      await pool.query(
        `UPDATE base_items SET stock = 14
          WHERE id = $1 AND workspace_owner_id = $2`,
        [baseItemId, OWNER_ID],
      );
    }

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL });

      await pool.query(
        `DELETE FROM base_item_stock_adjustments WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM base_item_ledger_settings WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM base_item_location_statuses WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      await pool.query(`DELETE FROM base_items WHERE workspace_owner_id = $1`, [
        OWNER_ID,
      ]);
      await pool.query(`DELETE FROM locations WHERE workspace_owner_id = $1`, [
        OWNER_ID,
      ]);

      const baseItem = await pool.query<{ id: number }>(
        `INSERT INTO base_items
           (workspace_owner_id, name, code, status, stock)
         VALUES ($1, 'Ledger Foundation Item', 'LEDGER-FOUNDATION', 'active', 14)
         RETURNING id`,
        [OWNER_ID],
      );
      baseItemId = baseItem.rows[0].id;

      const locations = await pool.query<{ id: number }>(
        `INSERT INTO locations (workspace_owner_id, name, country)
         VALUES
           ($1, 'Ledger Location A', 'AE'),
           ($1, 'Ledger Location B', 'AE')
         RETURNING id`,
        [OWNER_ID],
      );
      [locationAId, locationBId] = locations.rows.map((row) => row.id);

      await pool.query(
        `INSERT INTO base_item_location_statuses
           (workspace_owner_id, base_item_id, location_id, is_active, stock)
         VALUES
           ($1, $2, $3, true, 10),
           ($1, $2, $4, true, 4)`,
        [OWNER_ID, baseItemId, locationAId, locationBId],
      );
    });

    beforeEach(clearLedgerAndResetStock);

    afterAll(async () => {
      if (!pool) return;
      await pool.query(
        `DELETE FROM base_item_stock_adjustments WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM base_item_ledger_settings WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM base_item_location_statuses WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      await pool.query(`DELETE FROM base_items WHERE workspace_owner_id = $1`, [
        OWNER_ID,
      ]);
      await pool.query(`DELETE FROM locations WHERE workspace_owner_id = $1`, [
        OWNER_ID,
      ]);
      await pool.end();
    });

    it("checks durable idempotency before re-evaluating an already changed balance", async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const first = await postMovement(client, {
          workspaceOwnerId: OWNER_ID,
          baseItemId,
          locationId: locationAId,
          quantityChange: -7,
          reason: "Verified stock issue",
          movementType: "manual_adjustment",
          createdByUserId: USER_ID,
          adjustmentActionId: "9a5ddf4b-4061-45f0-a6b5-f2b55d2757aa",
          idempotencyKey: "ledger-foundation:idempotency",
        });
        const retry = await postMovement(client, {
          workspaceOwnerId: OWNER_ID,
          baseItemId,
          locationId: locationAId,
          quantityChange: -7,
          reason: "Verified stock issue",
          movementType: "manual_adjustment",
          createdByUserId: USER_ID,
          adjustmentActionId: "9a5ddf4b-4061-45f0-a6b5-f2b55d2757aa",
          idempotencyKey: "ledger-foundation:idempotency",
        });
        await client.query("COMMIT");

        expect(first.posted).toBe(true);
        expect(retry).toMatchObject({
          posted: false,
          reason: "duplicate",
          movementId: first.movementId,
          stockAfter: 3,
        });
      } finally {
        client.release();
      }

      const persisted = await pool.query<{
        count: string;
        stock: string;
      }>(
        `SELECT
           (SELECT COUNT(*)::text
              FROM base_item_stock_adjustments
             WHERE workspace_owner_id = $1
               AND idempotency_key = 'ledger-foundation:idempotency') AS count,
           (SELECT stock::text
              FROM base_item_location_statuses
             WHERE base_item_id = $2 AND location_id = $3) AS stock`,
        [OWNER_ID, baseItemId, locationAId],
      );
      expect(persisted.rows[0]).toEqual({ count: "1", stock: "3" });
    });

    it("rejects movement directions that contradict the operational taxonomy", async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await expect(
          postMovement(client, {
            workspaceOwnerId: OWNER_ID,
            baseItemId,
            locationId: locationAId,
            quantityChange: -2,
            reason: "Invalid negative receipt",
            movementType: "purchase_order_receipt",
          }),
        ).rejects.toMatchObject({
          code: "INVALID_MOVEMENT",
        });
        await expect(
          postMovement(client, {
            workspaceOwnerId: OWNER_ID,
            baseItemId,
            locationId: locationAId,
            quantityChange: 2,
            reason: "Invalid positive waste",
            movementType: "waste_damage",
          }),
        ).rejects.toMatchObject({
          code: "INVALID_MOVEMENT",
        });
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }

      const movementCount = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM base_item_stock_adjustments
          WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      expect(movementCount.rows[0].count).toBe("0");
    });

    it("captures immutable contract snapshots and reverses by appending exactly one compensating row", async () => {
      const client = await pool.connect();
      let originalId: number;
      try {
        await client.query("BEGIN");
        const original = await postMovement(client, {
          workspaceOwnerId: OWNER_ID,
          baseItemId,
          locationId: locationAId,
          quantityChange: 5,
          reason: "Counted inbound stock",
          movementType: "inventory_count_correction",
          createdByUserId: USER_ID,
          idempotencyKey: "ledger-foundation:original",
          referenceType: "stock_count",
          referenceId: "COUNT-001",
          referenceLabelSnapshot: "Stock count COUNT-001",
        });
        originalId = original.movementId!;

        const reversal = await reverseMovement(client, {
          workspaceOwnerId: OWNER_ID,
          movementId: originalId,
          reason: "Count was entered twice",
          idempotencyKey: "ledger-foundation:reversal",
          createdByUserId: USER_ID,
        });
        const retry = await reverseMovement(client, {
          workspaceOwnerId: OWNER_ID,
          movementId: originalId,
          reason: "Count was entered twice",
          idempotencyKey: "ledger-foundation:reversal",
          createdByUserId: USER_ID,
        });
        await client.query("COMMIT");

        expect(reversal.posted).toBe(true);
        expect(retry).toMatchObject({
          posted: false,
          reason: "duplicate",
          movementId: reversal.movementId,
        });
      } finally {
        client.release();
      }

      const movements = await pool.query<{
        id: number;
        quantity_change: string;
        reversal_of_id: number | null;
        canonical_unit: string | null;
        base_item_name_snapshot: string | null;
        location_name_snapshot: string | null;
        actor_type: string | null;
        source_type: string | null;
        reference_type: string | null;
        reference_id: string | null;
        ledger_scope: string;
      }>(
        `SELECT
           id, quantity_change, reversal_of_id, canonical_unit,
           base_item_name_snapshot, location_name_snapshot,
           actor_type, source_type, reference_type, reference_id, ledger_scope
         FROM base_item_stock_adjustments
         WHERE workspace_owner_id = $1
         ORDER BY id`,
        [OWNER_ID],
      );
      expect(movements.rows).toHaveLength(2);
      expect(Number(movements.rows[0].quantity_change)).toBe(5);
      expect(movements.rows[0]).toMatchObject({
        reversal_of_id: null,
        canonical_unit: "unit",
        base_item_name_snapshot: "Ledger Foundation Item",
        location_name_snapshot: "Ledger Location A",
        actor_type: "user",
        source_type: "inventory_count_correction",
        reference_type: "stock_count",
        reference_id: "COUNT-001",
        ledger_scope: "base_item_operational",
      });
      expect(Number(movements.rows[1].quantity_change)).toBe(-5);
      expect(movements.rows[1].reversal_of_id).toBe(originalId);

      const balance = await pool.query<{ stock: string; total: string }>(
        `SELECT
           bils.stock::text AS stock,
           bi.stock::text AS total
         FROM base_item_location_statuses bils
         JOIN base_items bi ON bi.id = bils.base_item_id
         WHERE bils.base_item_id = $1 AND bils.location_id = $2`,
        [baseItemId, locationAId],
      );
      expect(balance.rows[0]).toEqual({ stock: "10", total: "14" });
    });

    it("creates immutable per-location opening balances and reports discrepancies without repairing them", async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const first = await establishOpeningBalance(client, {
          workspaceOwnerId: OWNER_ID,
          baseItemId,
          locationId: locationAId,
          verifiedByUserId: USER_ID,
          reason: "Physical count signed off",
        });
        const retry = await establishOpeningBalance(client, {
          workspaceOwnerId: OWNER_ID,
          baseItemId,
          locationId: locationAId,
          verifiedByUserId: USER_ID,
          reason: "A later rerun must not replace the baseline",
          cutoverAt: new Date("2030-01-01T00:00:00.000Z"),
        });
        await establishOpeningBalance(client, {
          workspaceOwnerId: OWNER_ID,
          baseItemId,
          locationId: locationBId,
          verifiedByUserId: USER_ID,
          reason: "Physical count signed off",
        });
        await postMovement(client, {
          workspaceOwnerId: OWNER_ID,
          baseItemId,
          locationId: locationAId,
          quantityChange: 2,
          reason: "Received after cutover",
          movementType: "purchase_order_receipt",
          createdByUserId: USER_ID,
          purchaseOrderId: null,
          idempotencyKey: "ledger-foundation:after-cutover",
        });
        await client.query("COMMIT");

        expect(first).toMatchObject({
          created: true,
          cutoverBalance: 10,
        });
        expect(retry).toMatchObject({
          created: false,
          movementId: first.movementId,
          cutoverAt: first.cutoverAt,
          cutoverBalance: 10,
        });
      } finally {
        client.release();
      }

      const reconciled = await reconcileOperationalLedger(
        pool,
        OWNER_ID,
        baseItemId,
      );
      expect(reconciled.recipeConsumptionReady).toBe(true);
      expect(reconciled.totals).toEqual({
        pairs: 2,
        reconciled: 2,
        discrepancies: 0,
        missingBaselines: 0,
      });
      expect(
        reconciled.rows.find((row) => row.locationId === locationAId),
      ).toMatchObject({
        onHandBalance: 12,
        cutoverBalance: 10,
        movementTotalAfterCutover: 2,
        ledgerBalance: 12,
        discrepancy: 0,
        status: "reconciled",
      });

      await pool.query(
        `UPDATE base_item_location_statuses
            SET stock = 11
          WHERE base_item_id = $1 AND location_id = $2`,
        [baseItemId, locationAId],
      );
      const ledgerCountBefore = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM base_item_stock_adjustments
          WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      const discrepancy = await reconcileOperationalLedger(
        pool,
        OWNER_ID,
        baseItemId,
      );
      const ledgerCountAfter = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM base_item_stock_adjustments
          WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );

      expect(discrepancy.recipeConsumptionReady).toBe(false);
      expect(
        discrepancy.rows.find((row) => row.locationId === locationAId),
      ).toMatchObject({
        onHandBalance: 11,
        ledgerBalance: 12,
        discrepancy: -1,
        status: "discrepancy",
      });
      expect(ledgerCountAfter.rows[0].count).toBe(
        ledgerCountBefore.rows[0].count,
      );
    });
  },
);