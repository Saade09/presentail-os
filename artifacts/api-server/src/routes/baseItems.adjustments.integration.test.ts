/**
 * Integration tests: stock adjustments routes against a real PostgreSQL instance.
 *
 * Scenarios covered:
 *
 *  POST /base-items/:id/adjustments
 *    1. Happy path — creates an adjustment row and updates location stock atomically.
 *    2. Invalid location_id (not linked to the base item) — returns 400.
 *    3. Missing / invalid reason — returns 400.
 *    4. quantity_change of 0 — returns 400.
 *
 *  GET /base-items/:id/adjustments
 *    5. Returns adjustment with correct quantity_change and stock_after values.
 *    6. Filters by location_id.
 *    7. Filters by movement_type.
 *    8. Filters by date_from / date_to.
 *
 * Auth and workspace middleware are stubbed; the database is real.
 * Tests seed their own rows under a unique OWNER_ID and clean up in afterAll.
 *
 * The suite skips automatically when DATABASE_URL is not set, making it safe
 * to run in environments without a live database.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import pg from "pg";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;

// ─────────────────────────────────────────────────────────────────────────────
// Unique identifiers so tests never collide with real workspace data
// ─────────────────────────────────────────────────────────────────────────────

const OWNER_ID = "__integration_test_bi_adjustments__";
const USER_ID = "__integration_test_bi_adjustments_user__";

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
    wreq.workspaceRole = "owner";
    wreq.workspaceActualRole = "owner";
    wreq.userId = USER_ID;
    wreq.userEmail = "adjustments-test@example.com";
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
  "Stock adjustments routes — integration (real database)",
  () => {
    let pool: InstanceType<typeof Pool>;
    let app: express.Express;

    let baseItemId: number;
    let locAId: number; // location with seeded stock
    let locBId: number; // second location, different country
    let unlinkedLocId: number; // location NOT linked to the base item

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
        `DELETE FROM base_item_location_statuses WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      await pool.query(`DELETE FROM base_items WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM locations WHERE workspace_owner_id = $1`, [OWNER_ID]);

      // Seed base item
      const biResult = await pool.query<{ id: number }>(
        `INSERT INTO base_items (workspace_owner_id, name, code, status, stock)
         VALUES ($1, 'Adjustments Test Item', 'ADJ-TEST-001', 'active', 0)
         RETURNING id`,
        [OWNER_ID],
      );
      baseItemId = biResult.rows[0].id;

      // Seed two locations (different countries)
      const locAResult = await pool.query<{ id: number }>(
        `INSERT INTO locations (workspace_owner_id, name, country)
         VALUES ($1, 'Dubai Store', 'AE')
         RETURNING id`,
        [OWNER_ID],
      );
      locAId = locAResult.rows[0].id;

      const locBResult = await pool.query<{ id: number }>(
        `INSERT INTO locations (workspace_owner_id, name, country)
         VALUES ($1, 'Beirut Store', 'LB')
         RETURNING id`,
        [OWNER_ID],
      );
      locBId = locBResult.rows[0].id;

      // A location that is NOT linked to the base item (no location_status row)
      const unlinkedResult = await pool.query<{ id: number }>(
        `INSERT INTO locations (workspace_owner_id, name, country)
         VALUES ($1, 'Unlinked Warehouse', 'AE')
         RETURNING id`,
        [OWNER_ID],
      );
      unlinkedLocId = unlinkedResult.rows[0].id;

      // Seed location statuses for locA and locB only
      await pool.query(
        `INSERT INTO base_item_location_statuses
           (workspace_owner_id, base_item_id, location_id, is_active, stock)
         VALUES
           ($1, $2, $3, true, 50),
           ($1, $2, $4, true, 20)`,
        [OWNER_ID, baseItemId, locAId, locBId],
      );

      // Sync total stock
      await pool.query(
        `UPDATE base_items SET stock = 70 WHERE id = $1`,
        [baseItemId],
      );
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
        `DELETE FROM base_item_location_statuses WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      await pool.query(`DELETE FROM base_items WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM locations WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.end();
      await (routeDb as unknown as import("pg").Pool).end();
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Helper: reset stock to known starting values between tests
    // ─────────────────────────────────────────────────────────────────────────

    async function resetStock(): Promise<void> {
      await pool.query(
        `UPDATE base_item_location_statuses
            SET stock = CASE
              WHEN location_id = $1 THEN 50
              WHEN location_id = $2 THEN 20
            END
          WHERE base_item_id = $3`,
        [locAId, locBId, baseItemId],
      );
      await pool.query(
        `UPDATE base_items SET stock = 70 WHERE id = $1`,
        [baseItemId],
      );
      await pool.query(
        `DELETE FROM base_item_stock_adjustments WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
    }

    // =========================================================================
    // POST /base-items/:id/adjustments — happy path
    // =========================================================================

    it("happy path: creates an adjustment row and updates location and total stock", async () => {
      try {
        const res = await request(app)
          .post(`/base-items/${baseItemId}/adjustments`)
          .send({
            location_id: locAId,
            quantity_change: 10,
            reason: "receive",
            movement_type: "manual",
            note: "integration test receive",
          });

        expect(res.status).toBe(201);
        expect(res.body.adjustment).toBeDefined();
        expect(Number(res.body.adjustment.quantity_change)).toBe(10);
        expect(Number(res.body.adjustment.stock_after)).toBe(60);   // 50 + 10
        expect(res.body.adjustment.movement_type).toBe("manual_adjustment");
        expect(res.body.adjustment.location_name).toBe("Dubai Store");
        expect(res.body.previous_quantity).toBe(50);
        expect(res.body.new_quantity).toBe(60);
        expect(res.body.stock).toBe(80);   // 60 (locA) + 20 (locB)

        // Verify location stock updated in DB
        const locRow = await pool.query<{ stock: string }>(
          `SELECT stock FROM base_item_location_statuses
            WHERE base_item_id = $1 AND location_id = $2`,
          [baseItemId, locAId],
        );
        expect(Number(locRow.rows[0].stock)).toBe(60);

        // Verify base_items.stock updated
        const biRow = await pool.query<{ stock: string }>(
          `SELECT stock FROM base_items WHERE id = $1`,
          [baseItemId],
        );
        expect(Number(biRow.rows[0].stock)).toBe(80);

        // Verify adjustment row exists in DB
        const adjRows = await pool.query(
          `SELECT quantity_change, stock_after, movement_type
             FROM base_item_stock_adjustments
            WHERE workspace_owner_id = $1 AND base_item_id = $2`,
          [OWNER_ID, baseItemId],
        );
        expect(adjRows.rowCount).toBe(1);
        expect(Number(adjRows.rows[0].quantity_change)).toBe(10);
        expect(Number(adjRows.rows[0].stock_after)).toBe(60);
        expect(adjRows.rows[0].movement_type).toBe("manual_adjustment");
      } finally {
        await resetStock();
      }
    });

    it("negative quantity_change reduces location stock (removal)", async () => {
      try {
        const res = await request(app)
          .post(`/base-items/${baseItemId}/adjustments`)
          .send({
            location_id: locAId,
            quantity_change: -15,
            reason: "damage",
          });

        expect(res.status).toBe(201);
        expect(res.body.new_quantity).toBe(35);   // 50 - 15
        expect(res.body.stock).toBe(55);          // 35 + 20
      } finally {
        await resetStock();
      }
    });

    it("returns 400 when quantity_change would drive location stock below zero", async () => {
      // locA has 50 units; removing 60 would result in -10
      const res = await request(app)
        .post(`/base-items/${baseItemId}/adjustments`)
        .send({
          location_id: locAId,
          quantity_change: -60,
          reason: "damage",
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/below zero/i);

      // Stock must be unchanged — no adjustment row written
      const locRow = await pool.query<{ stock: string }>(
        `SELECT stock FROM base_item_location_statuses
          WHERE base_item_id = $1 AND location_id = $2`,
        [baseItemId, locAId],
      );
      expect(Number(locRow.rows[0].stock)).toBe(50);

      const adjCount = await pool.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM base_item_stock_adjustments
          WHERE workspace_owner_id = $1 AND base_item_id = $2`,
        [OWNER_ID, baseItemId],
      );
      expect(Number(adjCount.rows[0].cnt)).toBe(0);
    });

    it("removing exactly the available stock (reaching zero) is allowed — 201 with new_quantity 0", async () => {
      // Removing exactly 50 from a location with 50 → 0, should succeed
      try {
        const res = await request(app)
          .post(`/base-items/${baseItemId}/adjustments`)
          .send({
            location_id: locAId,
            quantity_change: -50,
            reason: "damage",
          });

        expect(res.status).toBe(201);
        expect(res.body.new_quantity).toBe(0);
      } finally {
        await resetStock();
      }
    });

    // =========================================================================
    // POST /base-items/:id/adjustments — validation errors
    // =========================================================================

    it("returns 400 when location_id does not refer to an active location for this base item", async () => {
      const res = await request(app)
        .post(`/base-items/${baseItemId}/adjustments`)
        .send({
          location_id: unlinkedLocId,
          quantity_change: 5,
          reason: "receive",
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/active location/i);

      // No adjustment row should have been created
      const adjCount = await pool.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM base_item_stock_adjustments
          WHERE workspace_owner_id = $1 AND base_item_id = $2`,
        [OWNER_ID, baseItemId],
      );
      expect(Number(adjCount.rows[0].cnt)).toBe(0);
    });

    it("returns 400 when quantity_change is 0", async () => {
      const res = await request(app)
        .post(`/base-items/${baseItemId}/adjustments`)
        .send({
          location_id: locAId,
          quantity_change: 0,
          reason: "receive",
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/non-zero/i);
    });

    it("returns 400 when reason is invalid", async () => {
      const res = await request(app)
        .post(`/base-items/${baseItemId}/adjustments`)
        .send({
          location_id: locAId,
          quantity_change: 5,
          reason: "not_a_real_reason",
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/reason must be one of/i);
    });

    it("returns 400 when location_id is missing", async () => {
      const res = await request(app)
        .post(`/base-items/${baseItemId}/adjustments`)
        .send({
          quantity_change: 5,
          reason: "receive",
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/location_id/i);
    });

    // =========================================================================
    // GET /base-items/:id/adjustments — retrieval and filters
    // =========================================================================

    it("GET returns all adjustments for the base item with correct values", async () => {
      // Seed two adjustments: one on locA, one on locB
      await pool.query(
        `INSERT INTO base_item_stock_adjustments
           (workspace_owner_id, base_item_id, location_id, quantity_change, reason, movement_type, stock_after, created_by_user_id, ledger_scope)
         VALUES
           ($1, $2, $3, 10, 'receive', 'manual', 60, $5, 'legacy_base_item'),
           ($1, $2, $4, -5, 'damage', 'damage', 15, $5, 'legacy_base_item')`,
        [OWNER_ID, baseItemId, locAId, locBId, USER_ID],
      );

      try {
        const res = await request(app).get(`/base-items/${baseItemId}/adjustments`);

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.adjustments)).toBe(true);
        expect(res.body.adjustments.length).toBe(2);

        const adj = res.body.adjustments.find(
          (a: { location_id: number; quantity_change: number }) => a.location_id === locAId,
        );
        expect(adj).toBeDefined();
        expect(adj.quantity_change).toBe(10);
        expect(adj.stock_after).toBe(60);
        expect(adj.stock_before).toBe(50);    // stock_after - quantity_change
      } finally {
        await pool.query(
          `DELETE FROM base_item_stock_adjustments WHERE workspace_owner_id = $1`,
          [OWNER_ID],
        );
      }
    });

    it("GET filters by location_id", async () => {
      await pool.query(
        `INSERT INTO base_item_stock_adjustments
           (workspace_owner_id, base_item_id, location_id, quantity_change, reason, movement_type, stock_after, created_by_user_id, ledger_scope)
         VALUES
           ($1, $2, $3, 10, 'receive', 'manual', 60, $5, 'legacy_base_item'),
           ($1, $2, $4, -5, 'damage', 'damage', 15, $5, 'legacy_base_item')`,
        [OWNER_ID, baseItemId, locAId, locBId, USER_ID],
      );

      try {
        const res = await request(app)
          .get(`/base-items/${baseItemId}/adjustments`)
          .query({ location_id: locAId });

        expect(res.status).toBe(200);
        expect(res.body.adjustments.length).toBe(1);
        expect(res.body.adjustments[0].location_id).toBe(locAId);
      } finally {
        await pool.query(
          `DELETE FROM base_item_stock_adjustments WHERE workspace_owner_id = $1`,
          [OWNER_ID],
        );
      }
    });

    it("GET filters by movement_type", async () => {
      await pool.query(
        `INSERT INTO base_item_stock_adjustments
           (workspace_owner_id, base_item_id, location_id, quantity_change, reason, movement_type, stock_after, created_by_user_id, ledger_scope)
         VALUES
           ($1, $2, $3, 10, 'receive', 'manual', 60, $4, 'legacy_base_item'),
           ($1, $2, $3, -5, 'damage', 'damage', 55, $4, 'legacy_base_item')`,
        [OWNER_ID, baseItemId, locAId, USER_ID],
      );

      try {
        const res = await request(app)
          .get(`/base-items/${baseItemId}/adjustments`)
          .query({ movement_type: "damage" });

        expect(res.status).toBe(200);
        expect(res.body.adjustments.length).toBe(1);
        expect(res.body.adjustments[0].movement_type).toBe("damage");
        expect(res.body.adjustments[0].quantity_change).toBe(-5);
      } finally {
        await pool.query(
          `DELETE FROM base_item_stock_adjustments WHERE workspace_owner_id = $1`,
          [OWNER_ID],
        );
      }
    });

    it("GET filters by date_from and date_to", async () => {
      // Insert one "old" adjustment with an explicit past timestamp and one "today"
      await pool.query(
        `INSERT INTO base_item_stock_adjustments
           (workspace_owner_id, base_item_id, location_id, quantity_change, reason, movement_type, stock_after, created_by_user_id, created_at, ledger_scope)
         VALUES
           ($1, $2, $3, 5, 'receive', 'manual', 55, $4, '2020-01-01T00:00:00Z', 'legacy_base_item'),
           ($1, $2, $3, 3, 'correction', 'manual', 58, $4, now(), 'legacy_base_item')`,
        [OWNER_ID, baseItemId, locAId, USER_ID],
      );

      try {
        // Only the 2020 adjustment should come back
        const res = await request(app)
          .get(`/base-items/${baseItemId}/adjustments`)
          .query({ date_from: "2020-01-01", date_to: "2020-01-01" });

        expect(res.status).toBe(200);
        expect(res.body.adjustments.length).toBe(1);
        expect(res.body.adjustments[0].quantity_change).toBe(5);

        // Only today's adjustment
        const today = new Date().toISOString().slice(0, 10);
        const res2 = await request(app)
          .get(`/base-items/${baseItemId}/adjustments`)
          .query({ date_from: today, date_to: today });

        expect(res2.status).toBe(200);
        expect(res2.body.adjustments.length).toBe(1);
        expect(res2.body.adjustments[0].quantity_change).toBe(3);
      } finally {
        await pool.query(
          `DELETE FROM base_item_stock_adjustments WHERE workspace_owner_id = $1`,
          [OWNER_ID],
        );
      }
    });

    it("GET returns 404 for a base item that does not belong to the workspace", async () => {
      const res = await request(app).get(`/base-items/999999999/adjustments`);
      expect(res.status).toBe(404);
    });
  },
);
