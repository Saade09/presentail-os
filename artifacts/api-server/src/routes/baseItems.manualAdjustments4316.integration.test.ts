/**
 * Integration tests for task #4316 — Manual movement taxonomy & adjustment idempotency.
 *
 * POST /base-items/:id/adjustments
 *   1.  increase (receive)  → movement_type = manual_adjustment, positive quantity_change.
 *   2.  decrease (remove)   → movement_type = manual_adjustment, negative quantity_change.
 *   3.  waste_damage        → movement_type = waste_damage, negative required.
 *   4.  inventory_count_correction → movement_type = inventory_count_correction.
 *   5.  customer_return     → movement_type = customer_return, positive required.
 *   6.  supplier_return     → movement_type = supplier_return, negative required.
 *   7.  reason is required (invalid reason → 400).
 *   8.  location_id is required → 400.
 *   9.  adjustment_action_id required and must be UUID → 400.
 *  10.  Idempotent replay (same action_id + same payload) → 200, idempotent:true.
 *  11.  Same action_id but changed payload → 409.
 *  12.  source_type, reference_type, and metadata_snapshot stored correctly.
 *  13.  Location stock and total stock reconcile after adjustment.
 *  14.  Negative stock rejected when workspace flag is false.
 *  15.  Negative stock allowed when workspace flag is true.
 *
 * Auth/workspace middleware is stubbed; the database is real.
 * Skips automatically when DATABASE_URL is not set.
 *
 * Run:
 *   bash artifacts/api-server/test-integration-local.sh \
 *     src/routes/baseItems.manualAdjustments4316.integration.test.ts
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import pg from "pg";
import { randomUUID } from "crypto";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;

// ─────────────────────────────────────────────────────────────────────────────
// Unique IDs
// ─────────────────────────────────────────────────────────────────────────────

const OWNER_ID = "__integ_manualadj4316__";
const USER_ID  = "__integ_manualadj4316_user__";

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
    wreq.userEmail = "manualadj4316@example.com";
    next();
  },
  workspace: (req: express.Request) => req as unknown as import("../lib/workspace").WorkspaceRequest,
}));

vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(),
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
  "Manual movement taxonomy & adjustment idempotency — integration (task #4316)",
  () => {
    let pool: InstanceType<typeof Pool>;
    let app: express.Express;

    let baseItemId: number;
    let locId: number;         // main active location, initial stock 100
    let secondLocId: number;   // second location, initial stock 20

    // ─────────────────────────────────────────────────────────────────────────
    // Setup / teardown
    // ─────────────────────────────────────────────────────────────────────────

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL });
      app  = makeApp();

      // Wipe leftovers
      await pool.query(`DELETE FROM base_item_stock_adjustments WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM base_item_location_statuses WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM base_items WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM locations WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM workspace_settings WHERE workspace_owner_id = $1`, [OWNER_ID]);

      // Seed base item
      const biRes = await pool.query<{ id: number }>(
        `INSERT INTO base_items (workspace_owner_id, name, code, status, stock)
         VALUES ($1, 'ManualAdj4316 Item', 'MA4316-001', 'active', 120) RETURNING id`,
        [OWNER_ID],
      );
      baseItemId = biRes.rows[0].id;

      // Seed locations
      const locRes = await pool.query<{ id: number }>(
        `INSERT INTO locations (workspace_owner_id, name, country) VALUES ($1, 'Main Loc AE', 'AE') RETURNING id`,
        [OWNER_ID],
      );
      locId = locRes.rows[0].id;

      const loc2Res = await pool.query<{ id: number }>(
        `INSERT INTO locations (workspace_owner_id, name, country) VALUES ($1, 'Second Loc AE', 'AE') RETURNING id`,
        [OWNER_ID],
      );
      secondLocId = loc2Res.rows[0].id;

      // Seed location statuses
      await pool.query(
        `INSERT INTO base_item_location_statuses (workspace_owner_id, base_item_id, location_id, is_active, stock)
         VALUES ($1, $2, $3, true, 100), ($1, $2, $4, true, 20)`,
        [OWNER_ID, baseItemId, locId, secondLocId],
      );
    });

    afterAll(async () => {
      if (!pool) return;
      await pool.query(`DELETE FROM base_item_stock_adjustments WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM base_item_location_statuses WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM base_items WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM locations WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM workspace_settings WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.end();
      await (routeDb as unknown as import("pg").Pool).end();
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Helper
    // ─────────────────────────────────────────────────────────────────────────

    async function resetStock(): Promise<void> {
      await pool.query(
        `UPDATE base_item_location_statuses
            SET stock = CASE WHEN location_id = $1 THEN 100 WHEN location_id = $2 THEN 20 END
          WHERE base_item_id = $3`,
        [locId, secondLocId, baseItemId],
      );
      await pool.query(`UPDATE base_items SET stock = 120 WHERE id = $1`, [baseItemId]);
      await pool.query(`DELETE FROM base_item_stock_adjustments WHERE workspace_owner_id = $1`, [OWNER_ID]);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 1 – increase (receive → manual_adjustment)
    // ─────────────────────────────────────────────────────────────────────────

    it("reason=receive → movement_type manual_adjustment, positive quantity_change", async () => {
      try {
        const res = await request(app)
          .post(`/base-items/${baseItemId}/adjustments`)
          .send({
            location_id: locId,
            quantity_change: 15,
            reason: "receive",
            adjustment_action_id: randomUUID(),
          });

        expect(res.status).toBe(201);
        expect(res.body.adjustment.movement_type).toBe("manual_adjustment");
        expect(Number(res.body.adjustment.quantity_change)).toBe(15);
        expect(res.body.new_quantity).toBe(115);
      } finally {
        await resetStock();
      }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Test 2 – decrease (remove → manual_adjustment)
    // ─────────────────────────────────────────────────────────────────────────

    it("reason=remove → movement_type manual_adjustment, negative quantity_change", async () => {
      try {
        const res = await request(app)
          .post(`/base-items/${baseItemId}/adjustments`)
          .send({
            location_id: locId,
            quantity_change: -10,
            reason: "remove",
            adjustment_action_id: randomUUID(),
          });

        expect(res.status).toBe(201);
        expect(res.body.adjustment.movement_type).toBe("manual_adjustment");
        expect(Number(res.body.adjustment.quantity_change)).toBe(-10);
        expect(res.body.new_quantity).toBe(90);
      } finally {
        await resetStock();
      }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Test 3 – waste_damage
    // ─────────────────────────────────────────────────────────────────────────

    it("reason=damage → movement_type waste_damage (must be negative)", async () => {
      try {
        const res = await request(app)
          .post(`/base-items/${baseItemId}/adjustments`)
          .send({
            location_id: locId,
            quantity_change: -5,
            reason: "damage",
            adjustment_action_id: randomUUID(),
          });

        expect(res.status).toBe(201);
        expect(res.body.adjustment.movement_type).toBe("waste_damage");
        expect(Number(res.body.adjustment.quantity_change)).toBe(-5);
      } finally {
        await resetStock();
      }
    });

    it("waste_damage with positive quantity_change → 400", async () => {
      const res = await request(app)
        .post(`/base-items/${baseItemId}/adjustments`)
        .send({
          location_id: locId,
          quantity_change: 5,       // must be negative for waste_damage
          reason: "damage",
          adjustment_action_id: randomUUID(),
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/waste_damage quantity_change must be negative/i);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Test 4 – inventory_count_correction
    // ─────────────────────────────────────────────────────────────────────────

    it("reason=correction → movement_type inventory_count_correction", async () => {
      try {
        const res = await request(app)
          .post(`/base-items/${baseItemId}/adjustments`)
          .send({
            location_id: locId,
            quantity_change: 3,
            reason: "correction",
            adjustment_action_id: randomUUID(),
          });

        expect(res.status).toBe(201);
        expect(res.body.adjustment.movement_type).toBe("inventory_count_correction");
      } finally {
        await resetStock();
      }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Test 5 – customer_return (positive)
    // ─────────────────────────────────────────────────────────────────────────

    it("reason=return → movement_type customer_return (positive)", async () => {
      try {
        const res = await request(app)
          .post(`/base-items/${baseItemId}/adjustments`)
          .send({
            location_id: locId,
            quantity_change: 2,
            reason: "return",
            adjustment_action_id: randomUUID(),
          });

        expect(res.status).toBe(201);
        expect(res.body.adjustment.movement_type).toBe("customer_return");
      } finally {
        await resetStock();
      }
    });

    it("customer_return with negative quantity_change → 400", async () => {
      const res = await request(app)
        .post(`/base-items/${baseItemId}/adjustments`)
        .send({
          location_id: locId,
          quantity_change: -2,
          reason: "return",
          adjustment_action_id: randomUUID(),
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/customer_return quantity_change must be positive/i);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Test 6 – supplier_return (negative)
    // ─────────────────────────────────────────────────────────────────────────

    it("movement_type=supplier_return → accepted with negative quantity_change", async () => {
      try {
        const res = await request(app)
          .post(`/base-items/${baseItemId}/adjustments`)
          .send({
            location_id: locId,
            quantity_change: -4,
            reason: "other",
            movement_type: "supplier_return",
            adjustment_action_id: randomUUID(),
          });

        expect(res.status).toBe(201);
        expect(res.body.adjustment.movement_type).toBe("supplier_return");
      } finally {
        await resetStock();
      }
    });

    it("supplier_return with positive quantity_change → 400", async () => {
      const res = await request(app)
        .post(`/base-items/${baseItemId}/adjustments`)
        .send({
          location_id: locId,
          quantity_change: 4,
          reason: "other",
          movement_type: "supplier_return",
          adjustment_action_id: randomUUID(),
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/supplier_return quantity_change must be negative/i);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Test 7 – invalid reason → 400
    // ─────────────────────────────────────────────────────────────────────────

    it("invalid reason → 400 with hint listing valid reasons", async () => {
      const res = await request(app)
        .post(`/base-items/${baseItemId}/adjustments`)
        .send({
          location_id: locId,
          quantity_change: 5,
          reason: "not_a_real_reason",
          adjustment_action_id: randomUUID(),
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/reason must be one of/i);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Test 8 – location_id required
    // ─────────────────────────────────────────────────────────────────────────

    it("missing location_id → 400", async () => {
      const res = await request(app)
        .post(`/base-items/${baseItemId}/adjustments`)
        .send({
          quantity_change: 5,
          reason: "receive",
          adjustment_action_id: randomUUID(),
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/location_id/i);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Test 9 – adjustment_action_id required and must be UUID
    // ─────────────────────────────────────────────────────────────────────────

    it("missing adjustment_action_id → 400", async () => {
      const res = await request(app)
        .post(`/base-items/${baseItemId}/adjustments`)
        .send({
          location_id: locId,
          quantity_change: 5,
          reason: "receive",
          // no adjustment_action_id
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/adjustment_action_id is required/i);
    });

    it("non-UUID adjustment_action_id → 400", async () => {
      const res = await request(app)
        .post(`/base-items/${baseItemId}/adjustments`)
        .send({
          location_id: locId,
          quantity_change: 5,
          reason: "receive",
          adjustment_action_id: "not-a-uuid",
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/adjustment_action_id is required/i);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Test 10 – Idempotent replay (same action_id + same payload → 200)
    // ─────────────────────────────────────────────────────────────────────────

    it("idempotent replay: same action_id + identical payload → 200 with idempotent:true", async () => {
      try {
        const actionId = randomUUID();
        const body = {
          location_id: locId,
          quantity_change: 7,
          reason: "receive",
          adjustment_action_id: actionId,
        };

        const first = await request(app).post(`/base-items/${baseItemId}/adjustments`).send(body);
        expect(first.status).toBe(201);

        const second = await request(app).post(`/base-items/${baseItemId}/adjustments`).send(body);
        expect(second.status).toBe(200);
        expect(second.body.idempotent).toBe(true);
        // Stock should not have changed again
        expect(second.body.new_quantity).toBe(first.body.new_quantity);
      } finally {
        await resetStock();
      }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Test 11 – Changed payload → 409
    // ─────────────────────────────────────────────────────────────────────────

    it("same action_id but different quantity_change → 409 conflict", async () => {
      try {
        const actionId = randomUUID();
        const first = await request(app)
          .post(`/base-items/${baseItemId}/adjustments`)
          .send({
            location_id: locId,
            quantity_change: 6,
            reason: "receive",
            adjustment_action_id: actionId,
          });
        expect(first.status).toBe(201);

        const second = await request(app)
          .post(`/base-items/${baseItemId}/adjustments`)
          .send({
            location_id: locId,
            quantity_change: 99, // changed
            reason: "receive",
            adjustment_action_id: actionId,
          });
        expect(second.status).toBe(409);
        expect(second.body.error).toMatch(/already used with a different payload/i);
      } finally {
        await resetStock();
      }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Test 12 – source/reference metadata stored on adjustment rows
    // ─────────────────────────────────────────────────────────────────────────

    it("source_type, reference_type, and metadata_snapshot stored on adjustment row", async () => {
      try {
        const actionId = randomUUID();
        const res = await request(app)
          .post(`/base-items/${baseItemId}/adjustments`)
          .send({
            location_id: locId,
            quantity_change: 5,
            reason: "receive",
            adjustment_action_id: actionId,
          });
        expect(res.status).toBe(201);

        const row = await pool.query<{
          source_type: string;
          reference_type: string;
          metadata_snapshot: unknown;
          idempotency_key: string;
        }>(
          `SELECT source_type, reference_type, metadata_snapshot, idempotency_key
             FROM base_item_stock_adjustments
            WHERE workspace_owner_id = $1 AND base_item_id = $2 AND location_id = $3
            ORDER BY created_at DESC LIMIT 1`,
          [OWNER_ID, baseItemId, locId],
        );
        expect(row.rowCount).toBe(1);
        expect(row.rows[0].source_type).toBe("stock_adjustment");
        expect(row.rows[0].reference_type).toBe("stock_adjustment");
        expect(row.rows[0].idempotency_key).toBe(`adj:${actionId}`);
        const meta = row.rows[0].metadata_snapshot as Record<string, unknown>;
        expect(meta).toBeDefined();
        expect(meta.reason).toBe("receive");
      } finally {
        await resetStock();
      }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Test 13 – Location stock and total reconcile after adjustment
    // ─────────────────────────────────────────────────────────────────────────

    it("location stock + total stock reconcile after adjustment", async () => {
      try {
        const res = await request(app)
          .post(`/base-items/${baseItemId}/adjustments`)
          .send({
            location_id: locId,
            quantity_change: 12,
            reason: "receive",
            adjustment_action_id: randomUUID(),
          });
        expect(res.status).toBe(201);

        // Check location stock in DB
        const locRow = await pool.query<{ stock: string }>(
          `SELECT stock FROM base_item_location_statuses WHERE base_item_id = $1 AND location_id = $2`,
          [baseItemId, locId],
        );
        expect(Number(locRow.rows[0].stock)).toBe(112); // 100 + 12

        // Total from base_items.stock
        const biRow = await pool.query<{ stock: string }>(
          `SELECT stock FROM base_items WHERE id = $1`,
          [baseItemId],
        );
        // 100 + 12 + 20 (secondLoc unchanged)
        expect(Number(biRow.rows[0].stock)).toBe(132);

        // Also verify the response values
        expect(res.body.new_quantity).toBe(112);
        expect(res.body.stock).toBe(132);
        expect(res.body.previous_quantity).toBe(100);
      } finally {
        await resetStock();
      }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Test 14 – Negative stock rejected (flag = false)
    // ─────────────────────────────────────────────────────────────────────────

    it("returns 400 INSUFFICIENT_STOCK when negative stock flag is false", async () => {
      // locId has 100; removing 200 should fail
      const res = await request(app)
        .post(`/base-items/${baseItemId}/adjustments`)
        .send({
          location_id: locId,
          quantity_change: -200,
          reason: "damage",
          adjustment_action_id: randomUUID(),
        });

      expect(res.status).toBe(400);
      // The route returns the InventoryError code "INSUFFICIENT_STOCK" as the error field
      expect(JSON.stringify(res.body)).toMatch(/insufficient.?stock/i);

      // Stock must be unchanged
      const locRow = await pool.query<{ stock: string }>(
        `SELECT stock FROM base_item_location_statuses WHERE base_item_id = $1 AND location_id = $2`,
        [baseItemId, locId],
      );
      expect(Number(locRow.rows[0].stock)).toBe(100);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Test 15 – Negative stock allowed when flag is true
    // ─────────────────────────────────────────────────────────────────────────

    it("allows negative stock when workspace inventory_allow_negative_stock = true", async () => {
      await pool.query(
        `INSERT INTO workspace_settings (workspace_owner_id, inventory_allow_negative_stock)
         VALUES ($1, true)
         ON CONFLICT (workspace_owner_id) DO UPDATE SET inventory_allow_negative_stock = true`,
        [OWNER_ID],
      );

      try {
        const res = await request(app)
          .post(`/base-items/${baseItemId}/adjustments`)
          .send({
            location_id: locId,
            quantity_change: -200,
            reason: "damage",
            adjustment_action_id: randomUUID(),
          });

        expect(res.status).toBe(201);
        expect(res.body.new_quantity).toBe(-100); // 100 - 200

        const locRow = await pool.query<{ stock: string }>(
          `SELECT stock FROM base_item_location_statuses WHERE base_item_id = $1 AND location_id = $2`,
          [baseItemId, locId],
        );
        expect(Number(locRow.rows[0].stock)).toBe(-100);
      } finally {
        await pool.query(
          `DELETE FROM workspace_settings WHERE workspace_owner_id = $1`,
          [OWNER_ID],
        );
        await resetStock();
      }
    });
  },
);
