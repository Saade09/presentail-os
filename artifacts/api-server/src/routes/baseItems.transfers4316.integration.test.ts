/**
 * Integration tests for task #4316 — Transfer idempotency & paired-row semantics.
 *
 * POST /base-items/:id/transfers
 *   1. Happy path – atomically moves stock, returns 201 with correct balances.
 *   2. Idempotent replay with identical payload – returns 200 with idempotent:true.
 *   3. Same transfer_action_id but changed payload – returns 409 conflict.
 *   4. Paired adjustment rows are both written atomically (transfer_out + transfer_in).
 *   5. Total stock is neutral across the two paired rows (out + in = 0 net).
 *   6. Negative-stock not allowed when workspace flag is false – returns 400.
 *   7. Negative-stock allowed when workspace flag is set – succeeds.
 *   8. transfer_action_id required and must be UUID – returns 400.
 *
 * Auth/workspace middleware is stubbed; the database is real.
 * Skips automatically when DATABASE_URL is not set.
 *
 * Run:
 *   bash artifacts/api-server/test-integration-local.sh \
 *     src/routes/baseItems.transfers4316.integration.test.ts
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import pg from "pg";
import { randomUUID } from "crypto";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;

// ─────────────────────────────────────────────────────────────────────────────
// Unique IDs so tests never collide with production data
// ─────────────────────────────────────────────────────────────────────────────

const OWNER_ID = "__integ_transfers4316__";
const USER_ID  = "__integ_transfers4316_user__";

// ─────────────────────────────────────────────────────────────────────────────
// Mocks
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("../lib/db", async () => {
  const { default: pgLib } = await import("pg");
  const pool = new pgLib.Pool({ connectionString: process.env.DATABASE_URL });
  return { db: pool };
});

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  authed: (req: express.Request) => req,
}));

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as import("../lib/workspace").WorkspaceRequest;
    wreq.workspaceOwnerId    = OWNER_ID;
    wreq.workspaceRole       = "owner";
    wreq.workspaceActualRole = "owner";
    wreq.userId    = USER_ID;
    wreq.userEmail = "transfers4316@example.com";
    next();
  },
  workspace: (req: express.Request) => req as unknown as import("../lib/workspace").WorkspaceRequest,
}));

vi.mock("../lib/logger", () => ({
  logger: {
    info:  vi.fn(), warn: vi.fn(), error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

vi.mock("../lib/objectStorage", () => ({
  objectStorageClient: { uploadFile: vi.fn(), deleteFile: vi.fn(), getSignedUrl: vi.fn() },
}));

vi.mock("@clerk/express", () => ({
  clerkClient: {
    users: {
      getUser: vi.fn(),
      getUserList: vi.fn().mockResolvedValue({ data: [] }),
    },
  },
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
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
// Router import (must come after vi.mock)
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
    (req as unknown as Record<string, unknown>).log = {
      error: () => undefined, warn: () => undefined, info: () => undefined,
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
  "Transfer idempotency & paired-row semantics — integration (task #4316)",
  () => {
    let pool: InstanceType<typeof Pool>;
    let app: express.Express;

    let baseItemId: number;
    let locAId: number; // country AE, initial stock 100
    let locBId: number; // country AE, initial stock 50

    // ─────────────────────────────────────────────────────────────────────────
    // Setup / teardown
    // ─────────────────────────────────────────────────────────────────────────

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL });
      app  = makeApp();

      // Wipe leftovers from previous failed runs
      await pool.query(`DELETE FROM base_item_stock_adjustments WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(
        `DELETE FROM base_item_stock_transfers WHERE base_item_id IN (SELECT id FROM base_items WHERE workspace_owner_id = $1)`,
        [OWNER_ID],
      );
      await pool.query(`DELETE FROM base_item_location_statuses WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM base_items WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM locations WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM workspace_settings WHERE workspace_owner_id = $1`, [OWNER_ID]);

      // Seed base item
      const biRes = await pool.query<{ id: number }>(
        `INSERT INTO base_items (workspace_owner_id, name, code, status, stock)
         VALUES ($1, 'Transfer4316 Item', 'TR4316-001', 'active', 150) RETURNING id`,
        [OWNER_ID],
      );
      baseItemId = biRes.rows[0].id;

      // Seed two same-country locations
      const locARes = await pool.query<{ id: number }>(
        `INSERT INTO locations (workspace_owner_id, name, country) VALUES ($1, 'Loc A AE', 'AE') RETURNING id`,
        [OWNER_ID],
      );
      locAId = locARes.rows[0].id;

      const locBRes = await pool.query<{ id: number }>(
        `INSERT INTO locations (workspace_owner_id, name, country) VALUES ($1, 'Loc B AE', 'AE') RETURNING id`,
        [OWNER_ID],
      );
      locBId = locBRes.rows[0].id;

      // Seed location statuses
      await pool.query(
        `INSERT INTO base_item_location_statuses (workspace_owner_id, base_item_id, location_id, is_active, stock)
         VALUES ($1, $2, $3, true, 100), ($1, $2, $4, true, 50)`,
        [OWNER_ID, baseItemId, locAId, locBId],
      );
    });

    afterAll(async () => {
      if (!pool) return;
      await pool.query(`DELETE FROM base_item_stock_adjustments WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(
        `DELETE FROM base_item_stock_transfers WHERE base_item_id IN (SELECT id FROM base_items WHERE workspace_owner_id = $1)`,
        [OWNER_ID],
      );
      await pool.query(`DELETE FROM base_item_location_statuses WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM base_items WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM locations WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM workspace_settings WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.end();
      await (routeDb as unknown as import("pg").Pool).end();
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Helper: reset location stock between tests
    // ─────────────────────────────────────────────────────────────────────────

    async function resetStock(): Promise<void> {
      await pool.query(
        `UPDATE base_item_location_statuses
            SET stock = CASE WHEN location_id = $1 THEN 100 WHEN location_id = $2 THEN 50 END
          WHERE base_item_id = $3`,
        [locAId, locBId, baseItemId],
      );
      await pool.query(`UPDATE base_items SET stock = 150 WHERE id = $1`, [baseItemId]);
      await pool.query(`DELETE FROM base_item_stock_adjustments WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(
        `DELETE FROM base_item_stock_transfers WHERE base_item_id = $1`,
        [baseItemId],
      );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 1 – Happy path
    // ─────────────────────────────────────────────────────────────────────────

    it("happy path: 201 with correct from/to stock after values", async () => {
      try {
        const actionId = randomUUID();
        const res = await request(app)
          .post(`/base-items/${baseItemId}/transfers`)
          .send({
            from_location_id: locAId,
            to_location_id:   locBId,
            quantity: 20,
            reason: "rebalance for test",
            transfer_action_id: actionId,
          });

        expect(res.status).toBe(201);
        expect(res.body.ok).toBe(true);
        expect(res.body.from_stock_after).toBe(80);
        expect(res.body.to_stock_after).toBe(70);
        expect(typeof res.body.transfer_id).toBe("number");

        // DB verification
        const locRows = await pool.query<{ location_id: number; stock: string }>(
          `SELECT location_id, stock FROM base_item_location_statuses
            WHERE base_item_id = $1 AND location_id = ANY($2::int[])`,
          [baseItemId, [locAId, locBId]],
        );
        const byLoc = new Map(locRows.rows.map((r) => [r.location_id, Number(r.stock)]));
        expect(byLoc.get(locAId)).toBe(80);
        expect(byLoc.get(locBId)).toBe(70);
      } finally {
        await resetStock();
      }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Test 2 – Idempotent replay
    // ─────────────────────────────────────────────────────────────────────────

    it("idempotent replay: same transfer_action_id + identical payload returns 200 with idempotent:true", async () => {
      try {
        const actionId = randomUUID();
        const body = {
          from_location_id: locAId,
          to_location_id:   locBId,
          quantity: 10,
          reason: "idempotency test",
          transfer_action_id: actionId,
        };

        const first = await request(app).post(`/base-items/${baseItemId}/transfers`).send(body);
        expect(first.status).toBe(201);
        const transferId = first.body.transfer_id;

        // Replay – same body, same actionId
        const second = await request(app).post(`/base-items/${baseItemId}/transfers`).send(body);
        expect(second.status).toBe(200);
        expect(second.body.idempotent).toBe(true);
        expect(second.body.transfer_id).toBe(transferId);

        // Stock should be the same as after the first call (not double-applied)
        const locRow = await pool.query<{ location_id: number; stock: string }>(
          `SELECT location_id, stock FROM base_item_location_statuses
            WHERE base_item_id = $1 AND location_id = ANY($2::int[])`,
          [baseItemId, [locAId, locBId]],
        );
        const byLoc = new Map(locRow.rows.map((r) => [r.location_id, Number(r.stock)]));
        expect(byLoc.get(locAId)).toBe(90);  // 100 - 10
        expect(byLoc.get(locBId)).toBe(60);  // 50 + 10
      } finally {
        await resetStock();
      }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Test 3 – Changed payload → 409
    // ─────────────────────────────────────────────────────────────────────────

    it("same transfer_action_id but different payload → 409 conflict", async () => {
      try {
        const actionId = randomUUID();
        const first = await request(app)
          .post(`/base-items/${baseItemId}/transfers`)
          .send({
            from_location_id: locAId,
            to_location_id:   locBId,
            quantity: 5,
            reason: "original reason",
            transfer_action_id: actionId,
          });
        expect(first.status).toBe(201);

        // Same actionId but different quantity
        const second = await request(app)
          .post(`/base-items/${baseItemId}/transfers`)
          .send({
            from_location_id: locAId,
            to_location_id:   locBId,
            quantity: 99,           // changed
            reason: "original reason",
            transfer_action_id: actionId,
          });
        expect(second.status).toBe(409);
        expect(second.body.error).toMatch(/already used with a different payload/i);
      } finally {
        await resetStock();
      }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Test 4 – Paired rows: transfer_out + transfer_in both written
    // ─────────────────────────────────────────────────────────────────────────

    it("paired rows: exactly one transfer_out and one transfer_in row written atomically", async () => {
      try {
        const actionId = randomUUID();
        const res = await request(app)
          .post(`/base-items/${baseItemId}/transfers`)
          .send({
            from_location_id: locAId,
            to_location_id:   locBId,
            quantity: 15,
            reason: "paired row test",
            transfer_action_id: actionId,
          });
        expect(res.status).toBe(201);

        const adjRows = await pool.query<{ movement_type: string; quantity_change: string; location_id: number }>(
          `SELECT movement_type, quantity_change::text, location_id
             FROM base_item_stock_adjustments
            WHERE workspace_owner_id = $1 AND base_item_id = $2
            ORDER BY movement_type`,
          [OWNER_ID, baseItemId],
        );
        expect(adjRows.rowCount).toBe(2);
        const types = adjRows.rows.map((r) => r.movement_type).sort();
        expect(types).toEqual(["transfer_in", "transfer_out"]);

        const outRow = adjRows.rows.find((r) => r.movement_type === "transfer_out")!;
        const inRow  = adjRows.rows.find((r) => r.movement_type === "transfer_in")!;
        expect(outRow.location_id).toBe(locAId);
        expect(inRow.location_id).toBe(locBId);
        expect(Number(outRow.quantity_change)).toBe(-15);
        expect(Number(inRow.quantity_change)).toBe(15);
      } finally {
        await resetStock();
      }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Test 5 – Neutral net effect (out + in = 0)
    // ─────────────────────────────────────────────────────────────────────────

    it("neutral net: sum of quantity_change across the two paired rows is zero", async () => {
      try {
        const actionId = randomUUID();
        const res = await request(app)
          .post(`/base-items/${baseItemId}/transfers`)
          .send({
            from_location_id: locAId,
            to_location_id:   locBId,
            quantity: 25,
            reason: "neutral net test",
            transfer_action_id: actionId,
          });
        expect(res.status).toBe(201);

        const sumRow = await pool.query<{ net: string }>(
          `SELECT SUM(quantity_change)::text AS net
             FROM base_item_stock_adjustments
            WHERE workspace_owner_id = $1 AND base_item_id = $2`,
          [OWNER_ID, baseItemId],
        );
        expect(Number(sumRow.rows[0].net)).toBe(0);
      } finally {
        await resetStock();
      }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Test 6 – Negative stock not allowed by default
    // ─────────────────────────────────────────────────────────────────────────

    it("returns 400 INSUFFICIENT_STOCK when negative stock flag is false (default)", async () => {
      // locB has 50; transferring 200 must fail
      const res = await request(app)
        .post(`/base-items/${baseItemId}/transfers`)
        .send({
          from_location_id: locBId,
          to_location_id:   locAId,
          quantity: 200,
          reason: "over-draw",
          transfer_action_id: randomUUID(),
        });

      expect(res.status).toBe(400);
      // The route returns the InventoryError code "INSUFFICIENT_STOCK" as the error field
      expect(JSON.stringify(res.body)).toMatch(/insufficient.?stock/i);

      // DB stock must be unchanged
      const locRow = await pool.query<{ stock: string }>(
        `SELECT stock FROM base_item_location_statuses WHERE base_item_id = $1 AND location_id = $2`,
        [baseItemId, locBId],
      );
      expect(Number(locRow.rows[0].stock)).toBe(50);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Test 7 – Negative stock allowed when workspace flag is set
    // ─────────────────────────────────────────────────────────────────────────

    it("allows stock to go negative when workspace inventory_allow_negative_stock = true", async () => {
      // Insert (or upsert) workspace_settings with the flag enabled
      await pool.query(
        `INSERT INTO workspace_settings (workspace_owner_id, inventory_allow_negative_stock)
         VALUES ($1, true)
         ON CONFLICT (workspace_owner_id) DO UPDATE SET inventory_allow_negative_stock = true`,
        [OWNER_ID],
      );

      try {
        const res = await request(app)
          .post(`/base-items/${baseItemId}/transfers`)
          .send({
            from_location_id: locBId,  // has 50
            to_location_id:   locAId,
            quantity: 200,             // exceeds stock
            reason: "over-draw allowed",
            transfer_action_id: randomUUID(),
          });

        expect(res.status).toBe(201);
        // locB stock should be 50 - 200 = -150
        const locRow = await pool.query<{ stock: string }>(
          `SELECT stock FROM base_item_location_statuses WHERE base_item_id = $1 AND location_id = $2`,
          [baseItemId, locBId],
        );
        expect(Number(locRow.rows[0].stock)).toBe(-150);
      } finally {
        // Remove the test-only settings row
        await pool.query(
          `DELETE FROM workspace_settings WHERE workspace_owner_id = $1`,
          [OWNER_ID],
        );
        await resetStock();
      }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Test 8 – transfer_action_id is required and must be a UUID
    // ─────────────────────────────────────────────────────────────────────────

    it("returns 400 when transfer_action_id is missing", async () => {
      const res = await request(app)
        .post(`/base-items/${baseItemId}/transfers`)
        .send({
          from_location_id: locAId,
          to_location_id:   locBId,
          quantity: 5,
          reason: "no action id",
          // no transfer_action_id
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/transfer_action_id is required/i);
    });

    it("returns 400 when transfer_action_id is not a valid UUID", async () => {
      const res = await request(app)
        .post(`/base-items/${baseItemId}/transfers`)
        .send({
          from_location_id: locAId,
          to_location_id:   locBId,
          quantity: 5,
          reason: "bad uuid",
          transfer_action_id: "not-a-uuid",
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/transfer_action_id is required/i);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Test: source and reference metadata stored on the adjustment rows
    // ─────────────────────────────────────────────────────────────────────────

    it("adjustment rows store source_type and reference_type metadata correctly", async () => {
      try {
        const actionId = randomUUID();
        const res = await request(app)
          .post(`/base-items/${baseItemId}/transfers`)
          .send({
            from_location_id: locAId,
            to_location_id:   locBId,
            quantity: 8,
            reason: "metadata test",
            transfer_action_id: actionId,
          });
        expect(res.status).toBe(201);

        const adjRows = await pool.query<{
          movement_type: string;
          source_type: string;
          reference_type: string;
          metadata_snapshot: unknown;
        }>(
          `SELECT movement_type, source_type, reference_type, metadata_snapshot
             FROM base_item_stock_adjustments
            WHERE workspace_owner_id = $1 AND base_item_id = $2
            ORDER BY movement_type`,
          [OWNER_ID, baseItemId],
        );
        expect(adjRows.rowCount).toBe(2);
        for (const row of adjRows.rows) {
          expect(row.source_type).toBe("stock_transfer");
          expect(row.reference_type).toBe("transfer");
          expect(row.metadata_snapshot).toBeDefined();
          const meta = row.metadata_snapshot as Record<string, unknown>;
          expect(meta.transferActionId).toBe(actionId);
        }
      } finally {
        await resetStock();
      }
    });
  },
);
