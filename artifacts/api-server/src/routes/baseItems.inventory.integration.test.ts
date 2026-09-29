/**
 * Integration tests: inventory transfer and threshold routes against a real
 * PostgreSQL instance.
 *
 * Scenarios covered:
 *
 *  POST /base-items/:id/transfers
 *    1. Happy path — atomically moves stock, returns 201 with correct after-values.
 *    2. Rollback on insufficient stock — returns 400 before any transaction begins.
 *    3. Cross-country transfer rejected — returns 400.
 *
 *  PUT /base-items/:id/country-thresholds/:country
 *    4. Upsert creates a new row.
 *    5. Upsert updates an existing row (ON CONFLICT).
 *
 *  GET /base-items/:id/inventory-overview
 *    6. Country grouping and threshold inheritance reflect real data.
 *
 * Auth and workspace middleware are stubbed; the database is real.
 * Tests seed their own rows under a unique OWNER_ID and clean up in afterAll.
 *
 * The suite skips automatically when DATABASE_URL is not set, making it safe
 * to run in environments without a live database.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import pg from "pg";
import { randomUUID } from "node:crypto";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;

// ─────────────────────────────────────────────────────────────────────────────
// Unique identifiers so tests never collide with real workspace data
// ─────────────────────────────────────────────────────────────────────────────

const OWNER_ID = "__integration_test_bi_inventory__";
const USER_ID = "__integration_test_bi_inventory_user__";
const { testWorkspaceAccess } = vi.hoisted(() => ({
  testWorkspaceAccess: {
    role: "owner" as "owner" | "member",
    allowedPages: null as string[] | null,
    assignedLocationIds: null as number[] | null,
  },
}));

// ─────────────────────────────────────────────────────────────────────────────
// Mocks — auth / workspace / logger / objectStorage / clerkClient / db
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("../lib/db", async () => {
  const { default: pgLib } = await import("pg");
  const pool = new pgLib.Pool({
    connectionString: process.env.DATABASE_URL,
  });
  return { db: pool };
});

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
  authed: (req: express.Request) => req,
}));

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    const wreq = req as unknown as import("../lib/workspace").WorkspaceRequest;
    wreq.workspaceOwnerId = OWNER_ID;
    wreq.workspaceRole = testWorkspaceAccess.role;
    wreq.workspaceActualRole = testWorkspaceAccess.role;
    wreq.userId = USER_ID;
    wreq.userEmail = "inventory-test@example.com";
    wreq.allowedPages = testWorkspaceAccess.allowedPages;
    wreq.assignedLocationIds = testWorkspaceAccess.assignedLocationIds;
    next();
  },
  workspace: (req: express.Request) =>
    req as unknown as import("../lib/workspace").WorkspaceRequest,
}));

vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

vi.mock("../lib/objectStorage", () => ({
  objectStorageClient: {
    uploadFile: vi.fn(),
    deleteFile: vi.fn(),
    getSignedUrl: vi.fn(),
  },
}));

vi.mock("@clerk/express", () => ({
  clerkClient: {
    users: {
      getUser: vi.fn(),
      getUserList: vi.fn().mockResolvedValue({ data: [] }),
    },
  },
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
}));

vi.mock("../lib/email", () => ({
  sendLowStockAlertEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/lowStockSse", () => ({
  subscribeToLowStock: vi.fn(),
  broadcastLowStock: vi.fn(),
}));

vi.mock("@workspace/integrations-openai-ai-server/image", () => ({
  generateImageBuffer: vi.fn(),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Import the router AFTER vi.mock declarations (hoisting boundary)
// ─────────────────────────────────────────────────────────────────────────────

import baseItemsRouter from "./baseItems";
import { db as routeDb } from "../lib/db";

// ─────────────────────────────────────────────────────────────────────────────
// App factory
// ─────────────────────────────────────────────────────────────────────────────

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (req as unknown as Record<string, any>).log = {
      error: () => undefined,
      warn: () => undefined,
      info: () => undefined,
    };
    next();
  });
  app.use(baseItemsRouter);
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err?.message ?? String(err) });
  });
  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!DATABASE_URL)(
  "Inventory transfer and threshold routes — integration (real database)",
  () => {
    let pool: InstanceType<typeof Pool>;
    let app: express.Express;

    // IDs created during seeding
    let baseItemId: number;
    let locAId: number; // Location A — country "AE"
    let locBId: number; // Location B — country "AE"
    let locCId: number; // Location C — country "LB" (different country)

    // ─────────────────────────────────────────────────────────────────────────
    // Setup / teardown
    // ─────────────────────────────────────────────────────────────────────────

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL });
      app = makeApp();

      // Wipe any leftovers from a previous failed run
      await pool.query(
        `DELETE FROM base_item_stock_adjustments WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM base_item_stock_transfers WHERE base_item_id IN (
           SELECT id FROM base_items WHERE workspace_owner_id = $1
         )`,
        [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM base_item_country_thresholds WHERE base_item_id IN (
           SELECT id FROM base_items WHERE workspace_owner_id = $1
         )`,
        [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM base_item_location_statuses WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      await pool.query(`DELETE FROM base_items WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM locations WHERE workspace_owner_id = $1`, [OWNER_ID]);

      // Seed base item
      const biResult = await pool.query<{ id: number }>(
        `INSERT INTO base_items (workspace_owner_id, name, code, status, stock)
         VALUES ($1, 'Inventory Test Item', 'INV-TEST-001', 'active', 0)
         RETURNING id`,
        [OWNER_ID],
      );
      baseItemId = biResult.rows[0].id;

      // Seed three locations
      const locAResult = await pool.query<{ id: number }>(
        `INSERT INTO locations (workspace_owner_id, name, country)
         VALUES ($1, 'Dubai Warehouse', 'AE')
         RETURNING id`,
        [OWNER_ID],
      );
      locAId = locAResult.rows[0].id;

      const locBResult = await pool.query<{ id: number }>(
        `INSERT INTO locations (workspace_owner_id, name, country)
         VALUES ($1, 'Abu Dhabi Warehouse', 'AE')
         RETURNING id`,
        [OWNER_ID],
      );
      locBId = locBResult.rows[0].id;

      const locCResult = await pool.query<{ id: number }>(
        `INSERT INTO locations (workspace_owner_id, name, country)
         VALUES ($1, 'Beirut Warehouse', 'LB')
         RETURNING id`,
        [OWNER_ID],
      );
      locCId = locCResult.rows[0].id;

      // Seed location statuses (is_active = true, initial stock)
      await pool.query(
        `INSERT INTO base_item_location_statuses
           (workspace_owner_id, base_item_id, location_id, is_active, stock)
         VALUES
           ($1, $2, $3, true, 100),
           ($1, $2, $4, true, 50),
           ($1, $2, $5, true, 30)`,
        [OWNER_ID, baseItemId, locAId, locBId, locCId],
      );

      // Sync base_items.stock to reflect the seeded location totals
      await pool.query(
        `UPDATE base_items SET stock = 180 WHERE id = $1`,
        [baseItemId],
      );
    });

    beforeEach(() => {
      testWorkspaceAccess.role = "owner";
      testWorkspaceAccess.allowedPages = null;
      testWorkspaceAccess.assignedLocationIds = null;
    });

    afterAll(async () => {
      if (!pool) return;
      await pool.query(
        `DELETE FROM base_item_stock_adjustments WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM base_item_stock_transfers WHERE base_item_id IN (
           SELECT id FROM base_items WHERE workspace_owner_id = $1
         )`,
        [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM base_item_country_thresholds WHERE base_item_id IN (
           SELECT id FROM base_items WHERE workspace_owner_id = $1
         )`,
        [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM base_item_location_statuses WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      await pool.query(`DELETE FROM base_items WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM locations WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.end();
      await (routeDb as unknown as import("pg").Pool).end();
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Helper: reset location stock to known starting values between transfer
    // tests so they don't interfere with each other.
    // ─────────────────────────────────────────────────────────────────────────

    async function resetStock(): Promise<void> {
      await pool.query(
        `UPDATE base_item_location_statuses
            SET stock = CASE
              WHEN location_id = $1 THEN 100
              WHEN location_id = $2 THEN 50
              WHEN location_id = $3 THEN 30
            END
          WHERE base_item_id = $4`,
        [locAId, locBId, locCId, baseItemId],
      );
      await pool.query(
        `UPDATE base_items SET stock = 180 WHERE id = $1`,
        [baseItemId],
      );
      // Remove any adjustment / transfer records so counts stay predictable
      await pool.query(
        `DELETE FROM base_item_stock_adjustments WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM base_item_ledger_settings WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM base_item_stock_transfers WHERE base_item_id = $1`,
        [baseItemId],
      );
    }

    // =========================================================================
    // POST /base-items/:id/transfers
    // =========================================================================

    it("happy path: transfers stock between two same-country locations atomically", async () => {
      try {
        const res = await request(app)
          .post(`/base-items/${baseItemId}/transfers`)
          .send({
            transfer_action_id: randomUUID(),
            from_location_id: locAId,
            to_location_id: locBId,
            quantity: 20,
            reason: "rebalance",
            note: "integration test",
          });

        expect(res.status).toBe(201);
        expect(res.body.ok).toBe(true);
        expect(res.body.from_stock_after).toBe(80);  // 100 - 20
        expect(res.body.to_stock_after).toBe(70);    // 50 + 20
        expect(typeof res.body.transfer_id).toBe("number");

        // Verify DB state directly
        const locRows = await pool.query<{ location_id: number; stock: string }>(
          `SELECT location_id, stock FROM base_item_location_statuses
            WHERE base_item_id = $1 AND location_id = ANY($2::int[])`,
          [baseItemId, [locAId, locBId]],
        );
        const byLoc = new Map(locRows.rows.map((r) => [r.location_id, Number(r.stock)]));
        expect(byLoc.get(locAId)).toBe(80);
        expect(byLoc.get(locBId)).toBe(70);

        // base_items.stock must remain the same total (AE only: was 150, still 150)
        const biRow = await pool.query<{ stock: string }>(
          `SELECT stock FROM base_items WHERE id = $1`,
          [baseItemId],
        );
        // total across all active locations (AE: 150, LB: 30)
        expect(Number(biRow.rows[0].stock)).toBe(180);

        // Two adjustment rows must exist (transfer_out + transfer_in)
        const adjRows = await pool.query<{ movement_type: string }>(
          `SELECT movement_type FROM base_item_stock_adjustments
            WHERE workspace_owner_id = $1 AND base_item_id = $2
            ORDER BY movement_type`,
          [OWNER_ID, baseItemId],
        );
        expect(adjRows.rowCount).toBe(2);
        const types = adjRows.rows.map((r) => r.movement_type).sort();
        expect(types).toEqual(["transfer_in", "transfer_out"]);

        // Transfer record must exist
        const transferRow = await pool.query<{ id: number; quantity: string }>(
          `SELECT id, quantity FROM base_item_stock_transfers WHERE id = $1`,
          [res.body.transfer_id],
        );
        expect(transferRow.rowCount).toBe(1);
        expect(Number(transferRow.rows[0].quantity)).toBe(20);
      } finally {
        await resetStock();
      }
    });

    it("rejects transfer when source has insufficient stock", async () => {
      const res = await request(app)
        .post(`/base-items/${baseItemId}/transfers`)
        .send({
          transfer_action_id: randomUUID(),
          from_location_id: locBId,  // has 50
          to_location_id: locAId,
          quantity: 999,             // more than available
          reason: "overstock",
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("INSUFFICIENT_STOCK");

      // Nothing should have changed in the DB
      const locRow = await pool.query<{ stock: string }>(
        `SELECT stock FROM base_item_location_statuses
          WHERE base_item_id = $1 AND location_id = $2`,
        [baseItemId, locBId],
      );
      expect(Number(locRow.rows[0].stock)).toBe(50);

      const adjCount = await pool.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM base_item_stock_adjustments
          WHERE workspace_owner_id = $1 AND base_item_id = $2`,
        [OWNER_ID, baseItemId],
      );
      expect(Number(adjCount.rows[0].cnt)).toBe(0);
    });

    it("rejects cross-country transfers", async () => {
      const res = await request(app)
        .post(`/base-items/${baseItemId}/transfers`)
        .send({
          transfer_action_id: randomUUID(),
          from_location_id: locAId,  // country AE
          to_location_id: locCId,    // country LB
          quantity: 5,
          reason: "cross-country attempt",
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/cross-country/i);
    });

    it("rejects self-transfer (from and to are the same location)", async () => {
      const res = await request(app)
        .post(`/base-items/${baseItemId}/transfers`)
        .send({
          transfer_action_id: randomUUID(),
          from_location_id: locAId,
          to_location_id: locAId,
          quantity: 10,
          reason: "self-transfer attempt",
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/must be different/i);
    });

    it("rejects quantity = 0", async () => {
      const res = await request(app)
        .post(`/base-items/${baseItemId}/transfers`)
        .send({
          transfer_action_id: randomUUID(),
          from_location_id: locAId,
          to_location_id: locBId,
          quantity: 0,
          reason: "zero quantity attempt",
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/positive number/i);
    });

    it("rejects transfer to an inactive location", async () => {
      // Temporarily mark locB as inactive for this base item
      await pool.query(
        `UPDATE base_item_location_statuses SET is_active = false
          WHERE base_item_id = $1 AND location_id = $2`,
        [baseItemId, locBId],
      );

      try {
        const res = await request(app)
          .post(`/base-items/${baseItemId}/transfers`)
          .send({
            transfer_action_id: randomUUID(),
            from_location_id: locAId,
            to_location_id: locBId,
            quantity: 10,
            reason: "inactive destination test",
          });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(
          new RegExp(`to_location_id \\(location ${locBId}\\) exists but is not an active location`, "i"),
        );
      } finally {
        // Restore locB to active
        await pool.query(
          `UPDATE base_item_location_statuses SET is_active = true
            WHERE base_item_id = $1 AND location_id = $2`,
          [baseItemId, locBId],
        );
      }
    });

    it("rejects transfer from an inactive source location", async () => {
      // Temporarily mark locA as inactive for this base item
      await pool.query(
        `UPDATE base_item_location_statuses SET is_active = false
          WHERE base_item_id = $1 AND location_id = $2`,
        [baseItemId, locAId],
      );

      try {
        const res = await request(app)
          .post(`/base-items/${baseItemId}/transfers`)
          .send({
            transfer_action_id: randomUUID(),
            from_location_id: locAId,
            to_location_id: locBId,
            quantity: 10,
            reason: "inactive source test",
          });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(
          new RegExp(`from_location_id \\(location ${locAId}\\) exists but is not an active location`, "i"),
        );

        // Stock should be untouched
        const locRow = await pool.query<{ stock: string }>(
          `SELECT stock FROM base_item_location_statuses
            WHERE base_item_id = $1 AND location_id = $2`,
          [baseItemId, locAId],
        );
        expect(Number(locRow.rows[0].stock)).toBe(100);
      } finally {
        // Restore locA to active
        await pool.query(
          `UPDATE base_item_location_statuses SET is_active = true
            WHERE base_item_id = $1 AND location_id = $2`,
          [baseItemId, locAId],
        );
      }
    });

    it("rejects transfer from an unknown / non-existent source location", async () => {
      const res = await request(app)
        .post(`/base-items/${baseItemId}/transfers`)
        .send({
          transfer_action_id: randomUUID(),
          from_location_id: 999999, // does not exist in any workspace
          to_location_id: locBId,
          quantity: 10,
          reason: "unknown source location test",
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/from_location_id \(location 999999\) does not exist in this workspace/i);

      // Stock must be untouched and no adjustment/transfer rows created
      const locRow = await pool.query<{ stock: string }>(
        `SELECT stock FROM base_item_location_statuses
          WHERE base_item_id = $1 AND location_id = $2`,
        [baseItemId, locBId],
      );
      expect(Number(locRow.rows[0].stock)).toBe(50);

      const adjCount = await pool.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM base_item_stock_adjustments
          WHERE workspace_owner_id = $1 AND base_item_id = $2`,
        [OWNER_ID, baseItemId],
      );
      expect(Number(adjCount.rows[0].cnt)).toBe(0);
    });

    it("rejects transfer to an unknown / non-existent destination location", async () => {
      const res = await request(app)
        .post(`/base-items/${baseItemId}/transfers`)
        .send({
          transfer_action_id: randomUUID(),
          from_location_id: locAId,
          to_location_id: 999999, // does not exist in any workspace
          quantity: 10,
          reason: "unknown destination location test",
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/to_location_id \(location 999999\) does not exist in this workspace/i);

      // Stock must be untouched and no adjustment/transfer rows created
      const locRow = await pool.query<{ stock: string }>(
        `SELECT stock FROM base_item_location_statuses
          WHERE base_item_id = $1 AND location_id = $2`,
        [baseItemId, locAId],
      );
      expect(Number(locRow.rows[0].stock)).toBe(100);

      const adjCount = await pool.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM base_item_stock_adjustments
          WHERE workspace_owner_id = $1 AND base_item_id = $2`,
        [OWNER_ID, baseItemId],
      );
      expect(Number(adjCount.rows[0].cnt)).toBe(0);
    });

    it("adjustment rows have correct stock_after values for both transfer_out and transfer_in", async () => {
      try {
        const transferQty = 15;
        const res = await request(app)
          .post(`/base-items/${baseItemId}/transfers`)
          .send({
            transfer_action_id: randomUUID(),
            from_location_id: locAId,  // starts at 100
            to_location_id: locBId,    // starts at 50
            quantity: transferQty,
            reason: "stock_after verification",
          });

        expect(res.status).toBe(201);

        const adjRows = await pool.query<{
          movement_type: string;
          stock_after: string;
          location_id: number;
        }>(
          `SELECT movement_type, stock_after, location_id
             FROM base_item_stock_adjustments
            WHERE workspace_owner_id = $1 AND base_item_id = $2
            ORDER BY movement_type`,
          [OWNER_ID, baseItemId],
        );

        expect(adjRows.rowCount).toBe(2);

        const outRow = adjRows.rows.find((r) => r.movement_type === "transfer_out");
        const inRow  = adjRows.rows.find((r) => r.movement_type === "transfer_in");

        expect(outRow).toBeDefined();
        expect(inRow).toBeDefined();

        // transfer_out: locA went from 100 → 100 - 15 = 85
        expect(outRow!.location_id).toBe(locAId);
        expect(Number(outRow!.stock_after)).toBe(100 - transferQty);

        // transfer_in: locB went from 50 → 50 + 15 = 65
        expect(inRow!.location_id).toBe(locBId);
        expect(Number(inRow!.stock_after)).toBe(50 + transferQty);
      } finally {
        await resetStock();
      }
    });

    // =========================================================================
    // PUT /base-items/:id/country-thresholds/:country
    // =========================================================================

    it("upsert creates a new country threshold row", async () => {
      const res = await request(app)
        .put(`/base-items/${baseItemId}/country-thresholds/AE`)
        .send({ default_low_stock_threshold: 10 });

      expect(res.status).toBe(200);
      expect(res.body.base_item_id).toBe(baseItemId);
      expect(res.body.country).toBe("AE");
      expect(res.body.default_low_stock_threshold).toBe(10);
      expect(typeof res.body.id).toBe("number");

      // Verify the row exists in the DB
      const dbRow = await pool.query<{ default_low_stock_threshold: string }>(
        `SELECT default_low_stock_threshold FROM base_item_country_thresholds
          WHERE base_item_id = $1 AND country = $2`,
        [baseItemId, "AE"],
      );
      expect(dbRow.rowCount).toBe(1);
      expect(Number(dbRow.rows[0].default_low_stock_threshold)).toBe(10);
    });

    it("upsert updates the threshold when the row already exists", async () => {
      // Row for AE was created by the previous test; update it to 25
      const res = await request(app)
        .put(`/base-items/${baseItemId}/country-thresholds/AE`)
        .send({ default_low_stock_threshold: 25 });

      expect(res.status).toBe(200);
      expect(res.body.default_low_stock_threshold).toBe(25);

      // Only one row should exist (no duplicate created by upsert)
      const dbRows = await pool.query(
        `SELECT * FROM base_item_country_thresholds
          WHERE base_item_id = $1 AND country = $2`,
        [baseItemId, "AE"],
      );
      expect(dbRows.rowCount).toBe(1);
      expect(Number(dbRows.rows[0].default_low_stock_threshold)).toBe(25);
    });

    // =========================================================================
    // GET /base-items/:id/inventory-overview
    // =========================================================================

    it("inventory-overview groups countries correctly and inherits country threshold", async () => {
      // At this point:
      //   - locA (AE): stock=100, loc-level threshold=0 → inherits country threshold (AE=25)
      //   - locB (AE): stock=50,  loc-level threshold=0 → inherits country threshold (AE=25)
      //   - locC (LB): stock=30,  loc-level threshold=0, no country threshold set

      const res = await request(app).get(`/base-items/${baseItemId}/inventory-overview`);

      expect(res.status).toBe(200);

      // Countries array
      const countries: Array<{
        country: string;
        total_stock: number;
        active_location_count: number;
        low_stock_location_count: number;
        out_of_stock_location_count: number;
        status: string;
      }> = res.body.countries;

      expect(Array.isArray(countries)).toBe(true);

      const ae = countries.find((c) => c.country === "AE");
      const lb = countries.find((c) => c.country === "LB");

      expect(ae).toBeDefined();
      expect(lb).toBeDefined();

      // AE: 100 + 50 = 150 total, neither location is below threshold of 25
      expect(ae!.total_stock).toBe(150);
      expect(ae!.active_location_count).toBe(2);
      expect(ae!.low_stock_location_count).toBe(0);
      expect(ae!.out_of_stock_location_count).toBe(0);
      expect(ae!.status).toBe("in_stock");

      // LB: 30 total, no threshold set → alert_disabled
      expect(lb!.total_stock).toBe(30);
      expect(lb!.active_location_count).toBe(1);
      expect(lb!.status).toBe("alert_disabled");

      // Global total: 150 + 30 = 180
      expect(res.body.global_total).toBe(180);

      // country_thresholds array must include the AE row we upserted
      const thresholds: Array<{ country: string; default_low_stock_threshold: number }> =
        res.body.country_thresholds;
      const aeThreshold = thresholds.find((t) => t.country === "AE");
      expect(aeThreshold).toBeDefined();
      expect(aeThreshold!.default_low_stock_threshold).toBe(25);
    });

    // =========================================================================
    // GET /base-items/:id/adjustments — transfer rows
    // =========================================================================

    it("stock-adjustments list includes both transfer_out and transfer_in rows after a transfer", async () => {
      try {
        const transferQty = 25;

        // Perform a transfer from locA → locB
        const transferRes = await request(app)
          .post(`/base-items/${baseItemId}/transfers`)
          .send({
            transfer_action_id: randomUUID(),
            from_location_id: locAId,
            to_location_id: locBId,
            quantity: transferQty,
            reason: "rebalance",
            note: "adjustments list test",
          });

        expect(transferRes.status).toBe(201);
        const transferId: number = transferRes.body.transfer_id;
        expect(typeof transferId).toBe("number");

        // Fetch the adjustment history via the API
        const adjRes = await request(app).get(`/base-items/${baseItemId}/adjustments`);

        expect(adjRes.status).toBe(200);

        const adjustments: Array<{
          movement_type: string;
          quantity_change: number;
          transfer_id: number | null;
          location_id: number;
        }> = adjRes.body.adjustments;

        expect(Array.isArray(adjustments)).toBe(true);

        // There must be at least two rows for this transfer
        const outRow = adjustments.find(
          (a) => a.movement_type === "transfer_out" && a.transfer_id === transferId,
        );
        const inRow = adjustments.find(
          (a) => a.movement_type === "transfer_in" && a.transfer_id === transferId,
        );

        expect(outRow).toBeDefined();
        expect(inRow).toBeDefined();

        // transfer_out: quantity_change must be negative
        expect(outRow!.quantity_change).toBe(-transferQty);
        expect(outRow!.location_id).toBe(locAId);

        // transfer_in: quantity_change must be positive
        expect(inRow!.quantity_change).toBe(transferQty);
        expect(inRow!.location_id).toBe(locBId);

        // Both rows must reference the same transfer_id
        expect(outRow!.transfer_id).toBe(inRow!.transfer_id);
      } finally {
        await resetStock();
      }
    });

    it("inventory-overview marks location as low_stock when stock <= inherited country threshold", async () => {
      // Reduce locA stock to 20, which is below the AE threshold of 25
      await pool.query(
        `UPDATE base_item_location_statuses SET stock = 20
          WHERE base_item_id = $1 AND location_id = $2`,
        [baseItemId, locAId],
      );

      try {
        const res = await request(app).get(`/base-items/${baseItemId}/inventory-overview`);

        expect(res.status).toBe(200);

        const ae = (res.body.countries as Array<{ country: string; low_stock_location_count: number; status: string }>)
          .find((c) => c.country === "AE");

        expect(ae).toBeDefined();
        expect(ae!.low_stock_location_count).toBe(1);
        expect(ae!.status).toBe("low_stock");

        // suggested_actions must include locA
        const actions: Array<{ location_id: number; stock: number; effective_threshold: number }> =
          res.body.suggested_actions;
        const locAAction = actions.find((a) => a.location_id === locAId);
        expect(locAAction).toBeDefined();
        expect(locAAction!.stock).toBe(20);
        expect(locAAction!.effective_threshold).toBe(25);
      } finally {
        // Restore locA stock
        await pool.query(
          `UPDATE base_item_location_statuses SET stock = 100
            WHERE base_item_id = $1 AND location_id = $2`,
          [baseItemId, locAId],
        );
      }
    });

    // =========================================================================
    // GET /base-items/:id/adjustments — filters across transfer + manual rows
    //
    // Seeds a mix of movement types and locations:
    //   - a real transfer locA → locB (transfer_out on locA, transfer_in on locB)
    //   - a manual adjustment on locA
    //   - a manual adjustment on locB
    //
    // and verifies location_id / movement_type filters (including transfer
    // movement types) and that combining both filters narrows correctly.
    // =========================================================================

    describe("GET /base-items/:id/adjustments — location & movement_type filters", () => {
      beforeAll(async () => {
        // Clean slate so row counts are deterministic
        await resetStock();

        // Real transfer locA → locB: writes transfer_out (locA, -10) and
        // transfer_in (locB, +10) adjustment rows tied to a transfer record.
        const transferRes = await request(app)
          .post(`/base-items/${baseItemId}/transfers`)
          .send({
            transfer_action_id: randomUUID(),
            from_location_id: locAId,
            to_location_id: locBId,
            quantity: 10,
            reason: "rebalance",
            note: "filter seed transfer",
          });
        expect(transferRes.status).toBe(201);

        // Two manual adjustments — one per location — so each location ends up
        // with one transfer row and one manual row.
        await pool.query(
          `INSERT INTO base_item_stock_adjustments
              (workspace_owner_id, base_item_id, location_id, quantity_change,
               reason, movement_type, stock_after, created_by_user_id,
               ledger_scope, canonical_unit, base_item_name_snapshot,
               location_name_snapshot, actor_type, actor_id,
               actor_label_snapshot, source_type, source_label_snapshot,
               reference_type, reference_label_snapshot)
           VALUES
              ($1, $2, $3, 5, 'receive', 'manual_adjustment', 95, $5,
               'base_item_operational', 'unit', 'Integration Base Item',
               'Location A', 'user', $5, $5, 'manual_adjustment', 'receive',
               'manual_adjustment', 'receive'),
              ($1, $2, $4, 8, 'receive', 'manual_adjustment', 68, $5,
               'base_item_operational', 'unit', 'Integration Base Item',
               'Location B', 'user', $5, $5, 'manual_adjustment', 'receive',
               'manual_adjustment', 'receive')`,
          [OWNER_ID, baseItemId, locAId, locBId, USER_ID],
        );
      });

      afterAll(async () => {
        await resetStock();
      });

      it("returns all seeded rows when no filter is applied", async () => {
        const res = await request(app).get(`/base-items/${baseItemId}/adjustments`);

        expect(res.status).toBe(200);
        // transfer_out + transfer_in + 2 manual = 4 rows
        expect(res.body.adjustments.length).toBe(4);
      });

      it("?location_id=X returns only rows for that location", async () => {
        const res = await request(app)
          .get(`/base-items/${baseItemId}/adjustments`)
          .query({ location_id: locAId });

        expect(res.status).toBe(200);

        const rows: Array<{ location_id: number; movement_type: string }> =
          res.body.adjustments;

        // locA has exactly the transfer_out row and one manual row
        expect(rows.length).toBe(2);
        expect(rows.every((r) => r.location_id === locAId)).toBe(true);

        const types = rows.map((r) => r.movement_type).sort();
        expect(types).toEqual(["manual_adjustment", "transfer_out"]);
      });

      it("?movement_type=transfer_out returns only transfer_out rows", async () => {
        const res = await request(app)
          .get(`/base-items/${baseItemId}/adjustments`)
          .query({ movement_type: "transfer_out" });

        expect(res.status).toBe(200);

        const rows: Array<{
          location_id: number;
          movement_type: string;
          quantity_change: number;
        }> = res.body.adjustments;

        // Only the single transfer_out row (on locA) should match
        expect(rows.length).toBe(1);
        expect(rows[0].movement_type).toBe("transfer_out");
        expect(rows[0].location_id).toBe(locAId);
        expect(rows[0].quantity_change).toBe(-10);
      });

      it("?movement_type=transfer_in returns only the transfer_in row", async () => {
        const res = await request(app)
          .get(`/base-items/${baseItemId}/adjustments`)
          .query({ movement_type: "transfer_in" });

        expect(res.status).toBe(200);

        const rows: Array<{
          location_id: number;
          movement_type: string;
          quantity_change: number;
        }> = res.body.adjustments;

        expect(rows.length).toBe(1);
        expect(rows[0].movement_type).toBe("transfer_in");
        expect(rows[0].location_id).toBe(locBId);
        expect(rows[0].quantity_change).toBe(10);
      });

      it("combining location_id and movement_type returns the correct subset", async () => {
        // locA + manual → exactly the one manual row on locA
        const matchRes = await request(app)
          .get(`/base-items/${baseItemId}/adjustments`)
          .query({ location_id: locAId, movement_type: "manual_adjustment" });

        expect(matchRes.status).toBe(200);
        expect(matchRes.body.adjustments.length).toBe(1);
        expect(matchRes.body.adjustments[0].location_id).toBe(locAId);
        expect(matchRes.body.adjustments[0].movement_type).toBe("manual_adjustment");
        expect(matchRes.body.adjustments[0].quantity_change).toBe(5);

        // locB + transfer_out → no rows (the transfer_out lives on locA)
        const emptyRes = await request(app)
          .get(`/base-items/${baseItemId}/adjustments`)
          .query({ location_id: locBId, movement_type: "transfer_out" });

        expect(emptyRes.status).toBe(200);
        expect(emptyRes.body.adjustments.length).toBe(0);
      });
    });

    it("stock movements reports only post-cutover operational ledger rows", async () => {
      await resetStock();
      try {
        await pool.query(
          `INSERT INTO base_item_ledger_settings
             (workspace_owner_id, base_item_id, location_id, cutover_at,
              cutover_balance, verified_by_user_id, verification_reason)
           VALUES ($1, $2, $3, clock_timestamp(), 0, $4, 'integration baseline')`,
          [OWNER_ID, baseItemId, locAId, USER_ID],
        );
        await pool.query(
          `INSERT INTO base_item_stock_adjustments
             (workspace_owner_id, base_item_id, location_id, quantity_change,
              reason, movement_type, stock_after, cutover_baseline, ledger_scope, canonical_unit,
              base_item_name_snapshot, location_name_snapshot, actor_type, actor_id,
              source_type, source_label_snapshot, reference_type, reference_label_snapshot,
              created_at)
           VALUES
             ($1, $2, $3, 0, 'Verified opening balance', 'opening_balance', 0, true,
              'base_item_operational', 'unit', 'Inventory Test Item', 'Dubai Warehouse',
              'user', $4, 'opening_balance', 'integration baseline',
              'opening_balance', 'integration baseline', clock_timestamp()),
             ($1, $2, $3, 99, 'legacy before cutover', 'manual_adjustment', 99, false,
              'base_item_operational', 'unit', 'Inventory Test Item', 'Dubai Warehouse',
              'user', $4, 'manual_adjustment', 'legacy', 'manual_adjustment', 'legacy',
              clock_timestamp() - interval '1 hour'),
             ($1, $2, $3, 7, 'product-only compatibility row', 'cmc_return', 7, false,
              'cmc_product_compat', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
              clock_timestamp()),
             ($1, $2, $3, 10, 'post-cutover adjustment', 'manual_adjustment', 10, false,
              'base_item_operational', 'unit', 'Inventory Test Item', 'Dubai Warehouse',
              'user', $4, 'manual_adjustment', 'integration test',
              'manual_adjustment', 'integration test', clock_timestamp())`,
          [OWNER_ID, baseItemId, locAId, USER_ID],
        );

        const res = await request(app).get(`/base-items/${baseItemId}/stock-movements`);

        expect(res.status).toBe(200);
        expect(res.body.total).toBe(2);
        expect(res.body.movements.map((m: { reason: string }) => m.reason).sort()).toEqual([
          "Verified opening balance",
          "post-cutover adjustment",
        ]);
        expect(res.body.summary).toMatchObject({
          openingBalance: 0,
          received: 10,
          consumed: 0,
          closingBalance: 10,
        });
      } finally {
        await resetStock();
      }
    });

    it("stock movement list and export enforce location scope and consolidate transfer pairs", async () => {
      await resetStock();
      try {
        await pool.query(
          `INSERT INTO base_item_ledger_settings
             (workspace_owner_id, base_item_id, location_id, cutover_at,
              cutover_balance, verified_by_user_id, verification_reason)
           VALUES
             ($1, $2, $3, clock_timestamp() - interval '2 hours', 100, $5, 'scope baseline'),
             ($1, $2, $4, clock_timestamp() - interval '2 hours', 50, $5, 'scope baseline')`,
          [OWNER_ID, baseItemId, locAId, locBId, USER_ID],
        );
        await pool.query(
          `INSERT INTO base_item_stock_adjustments
             (workspace_owner_id, base_item_id, location_id, quantity_change,
              reason, movement_type, stock_after, cutover_baseline, ledger_scope,
              canonical_unit, base_item_name_snapshot, location_name_snapshot,
              actor_type, actor_id, actor_label_snapshot, source_type, source_id,
              source_label_snapshot, reference_type, reference_id,
              reference_label_snapshot, metadata_snapshot, created_at)
           VALUES
             ($1, $2, $3, -20, 'Internal transfer out', 'transfer_out', 80, false,
              'base_item_operational', 'unit', 'Inventory Test Item', 'Dubai Warehouse',
              'user', $5, 'Scope Tester', 'transfer', '777', 'Internal transfer',
              'transfer', '777', 'T-0777', '{}'::jsonb,
              clock_timestamp() - interval '30 minutes'),
             ($1, $2, $4, 20, 'Internal transfer in', 'transfer_in', 70, false,
              'base_item_operational', 'unit', 'Inventory Test Item', 'Abu Dhabi Warehouse',
              'user', $5, 'Scope Tester', 'transfer', '777', 'Internal transfer',
              'transfer', '777', 'T-0777', '{}'::jsonb,
              clock_timestamp() - interval '29 minutes')`,
          [OWNER_ID, baseItemId, locAId, locBId, USER_ID],
        );

        const consolidated = await request(app)
          .get(`/base-items/${baseItemId}/stock-movements`)
          .query({ country: "AE", sortBy: "date", sortDirection: "desc" });

        expect(consolidated.status).toBe(200);
        expect(consolidated.body.total).toBe(2);
        expect(consolidated.body.summary).toEqual({
          openingBalance: 150,
          received: 20,
          consumed: 20,
          closingBalance: 150,
        });
        expect(Number(consolidated.body.movements[0].running_balance)).toBe(150);
        expect(Number(consolidated.body.movements[1].running_balance)).toBe(130);
        expect(consolidated.body.movements[0]).toMatchObject({
          reference_type: "transfer",
          reference_id: "777",
          reference_label: "T-0777",
          source_display_name: "Scope Tester",
        });

        const targetMovementId = consolidated.body.movements[1].id as number;
        const byMovementId = await request(app)
          .get(`/base-items/${baseItemId}/stock-movements`)
          .query({ q: String(targetMovementId) });
        expect(byMovementId.status).toBe(200);
        expect(
          byMovementId.body.movements.some(
            (movement: { id: number }) => movement.id === targetMovementId,
          ),
        ).toBe(true);

        const invalidFilters = await request(app)
          .get(`/base-items/${baseItemId}/stock-movements`)
          .query({ from: "not-a-date" });
        expect(invalidFilters.status).toBe(400);

        testWorkspaceAccess.role = "member";
        testWorkspaceAccess.allowedPages = ["base_items.view"];
        testWorkspaceAccess.assignedLocationIds = [locAId];

        const scoped = await request(app)
          .get(`/base-items/${baseItemId}/stock-movements`)
          .query({ country: "AE" });
        expect(scoped.status).toBe(200);
        expect(scoped.body.total).toBe(1);
        expect(scoped.body.movements[0].location_id).toBe(locAId);
        expect(scoped.body.summary).toEqual({
          openingBalance: 100,
          received: 0,
          consumed: 20,
          closingBalance: 80,
        });

        const scopedLocationChoices = await request(app)
          .get(`/base-items/${baseItemId}/location-statuses`);
        expect(scopedLocationChoices.status).toBe(200);
        expect(
          scopedLocationChoices.body.locationStatuses.map(
            (location: { location_id: number }) => location.location_id,
          ),
        ).toEqual([locAId]);

        const deniedList = await request(app)
          .get(`/base-items/${baseItemId}/stock-movements`)
          .query({ locationId: locBId });
        expect(deniedList.status).toBe(403);

        const deniedExport = await request(app)
          .get(`/base-items/${baseItemId}/stock-movements/export`)
          .query({ locationId: locBId });
        expect(deniedExport.status).toBe(403);

        const scopedExport = await request(app)
          .get(`/base-items/${baseItemId}/stock-movements/export`)
          .query({ country: "AE" });
        expect(scopedExport.status).toBe(200);
        expect(scopedExport.text).toContain("Dubai Warehouse");
        expect(scopedExport.text).not.toContain("Abu Dhabi Warehouse");
        expect(scopedExport.text).toContain("T-0777");
      } finally {
        await resetStock();
      }
    });

    it.each([
      {
        timezone: "Asia/Dubai",
        before: "2026-08-19T19:59:59.000Z",
        start: "2026-08-19T20:00:00.000Z",
        end: "2026-08-20T19:59:59.000Z",
        after: "2026-08-20T20:00:00.000Z",
      },
      {
        timezone: "America/New_York",
        before: "2026-08-20T03:59:59.000Z",
        start: "2026-08-20T04:00:00.000Z",
        end: "2026-08-21T03:59:59.000Z",
        after: "2026-08-21T04:00:00.000Z",
      },
    ])(
      "uses local-midnight boundaries for $timezone in list, summary, and CSV",
      async ({ timezone, before, start, end, after }) => {
        await resetStock();
        try {
          await pool.query(
            `INSERT INTO base_item_ledger_settings
               (workspace_owner_id, base_item_id, location_id, cutover_at,
                cutover_balance, verified_by_user_id, verification_reason)
             VALUES ($1, $2, $3, '2026-08-18T00:00:00.000Z', 100, $4, 'timezone baseline')`,
            [OWNER_ID, baseItemId, locAId, USER_ID],
          );
          await pool.query(
            `INSERT INTO base_item_stock_adjustments
               (workspace_owner_id, base_item_id, location_id, quantity_change,
                reason, movement_type, stock_after, cutover_baseline, ledger_scope,
                canonical_unit, base_item_name_snapshot, location_name_snapshot,
                 actor_type, actor_id, actor_label_snapshot, source_type, source_id,
                 source_label_snapshot, reference_type, reference_id,
                 reference_label_snapshot, metadata_snapshot, created_at)
             VALUES
               ($1, $2, $3, 1, 'Before day', 'manual_adjustment', 101, false,
                'base_item_operational', 'unit', 'Inventory Test Item', 'Dubai Warehouse',
                'user', $4, 'Timezone Tester', 'stock_adjustment', 'before', 'Before day',
                'stock_adjustment', 'before',
                'TZ-BEFORE', '{}'::jsonb, $5::timestamptz),
               ($1, $2, $3, 2, 'At local midnight', 'manual_adjustment', 103, false,
                'base_item_operational', 'unit', 'Inventory Test Item', 'Dubai Warehouse',
                'user', $4, 'Timezone Tester', 'stock_adjustment', 'start', 'At local midnight',
                'stock_adjustment', 'start',
                'TZ-START', '{}'::jsonb, $6::timestamptz),
               ($1, $2, $3, 3, 'Before next midnight', 'manual_adjustment', 106, false,
                'base_item_operational', 'unit', 'Inventory Test Item', 'Dubai Warehouse',
                'user', $4, 'Timezone Tester', 'stock_adjustment', 'end', 'Before next midnight',
                'stock_adjustment', 'end',
                'TZ-END', '{}'::jsonb, $7::timestamptz),
               ($1, $2, $3, 4, 'At next midnight', 'manual_adjustment', 110, false,
                'base_item_operational', 'unit', 'Inventory Test Item', 'Dubai Warehouse',
                'user', $4, 'Timezone Tester', 'stock_adjustment', 'after', 'At next midnight',
                'stock_adjustment', 'after',
                'TZ-AFTER', '{}'::jsonb, $8::timestamptz)`,
            [OWNER_ID, baseItemId, locAId, USER_ID, before, start, end, after],
          );

          const query = {
            locationId: locAId,
            from: "2026-08-20",
            to: "2026-08-20",
            tz: timezone,
          };
          const list = await request(app)
            .get(`/base-items/${baseItemId}/stock-movements`)
            .query(query);
          expect(list.status).toBe(200);
          expect(list.body.total).toBe(2);
          expect(
            list.body.movements.map(
              (movement: { reference_label: string }) => movement.reference_label,
            ),
          ).toEqual(["TZ-END", "TZ-START"]);
          expect(list.body.summary).toEqual({
            openingBalance: 101,
            received: 5,
            consumed: 0,
            closingBalance: 106,
          });

          const csv = await request(app)
            .get(`/base-items/${baseItemId}/stock-movements/export`)
            .query(query);
          expect(csv.status).toBe(200);
          expect(csv.text).toContain("TZ-START");
          expect(csv.text).toContain("TZ-END");
          expect(csv.text).not.toContain("TZ-BEFORE");
          expect(csv.text).not.toContain("TZ-AFTER");
        } finally {
          await resetStock();
        }
      },
    );
  },
);
