/**
 * Integration test: verifies that total_amount_manual_override = true
 * locks the PO's total_amount when line items are added, updated, or deleted.
 *
 * Also covers the inverse: with override = false the total_amount is
 * recalculated from the line items after every mutation.
 *
 * Auth and workspace middleware are stubbed so no real Clerk credentials are
 * needed. The database is real — tests seed their own rows under a unique
 * OWNER_ID and clean up in afterAll.
 *
 * The suite skips automatically when DATABASE_URL is not set.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import pg from "pg";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;

const OWNER_ID = "__integration_test_po_locked_total__";
const USER_ID = "__integration_test_po_locked_total_user__";

// ─────────────────────────────────────────────────────────────────────────────
// Mocks — auth / workspace / logger / email / clerkClient / db.
// db is mocked with a real Pool so SQL runs against a live Postgres instance.
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("../lib/db", async () => {
  const { default: pgLib } = await import("pg");
  const pool = new pgLib.Pool({ connectionString: process.env.DATABASE_URL });
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
    wreq.userEmail = "po-test@example.com";
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

vi.mock("../lib/email", () => ({
  sendPurchaseOrderEmail: vi.fn().mockResolvedValue(undefined),
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

// ─────────────────────────────────────────────────────────────────────────────
// Import router AFTER vi.mock declarations (hoisting boundary)
// ─────────────────────────────────────────────────────────────────────────────

import purchaseOrdersRouter from "./purchaseOrders";
import { db as routeDb } from "../lib/db";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
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
  app.use(purchaseOrdersRouter);
  app.use(
    (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err?.message ?? String(err) });
    },
  );
  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!DATABASE_URL)(
  "Purchase order line items — locked total (integration)",
  () => {
    let pool: InstanceType<typeof Pool>;
    let app: express.Express;
    let supplierId: number;
    let locationId: number;

    // ─────────────────────────────────────────────────────────────────────────
    // Setup / teardown
    // ─────────────────────────────────────────────────────────────────────────

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL });
      app = makeApp();

      // Wipe any leftovers from a previous failed run
      await pool.query(
        `DELETE FROM purchase_order_line_items
          WHERE purchase_order_id IN (
            SELECT id FROM purchase_orders WHERE workspace_owner_id = $1
          )`,
        [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM purchase_orders WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM suppliers WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM locations WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );

      // Seed a location (required by POST /purchase-orders)
      const locResult = await pool.query<{ id: number }>(
        `INSERT INTO locations (workspace_owner_id, name) VALUES ($1, 'Locked-Total Test Location') RETURNING id`,
        [OWNER_ID],
      );
      locationId = locResult.rows[0].id;

      // Seed a supplier
      const supplierResult = await pool.query<{ id: number }>(
        `INSERT INTO suppliers (workspace_owner_id, name)
         VALUES ($1, 'Locked-Total Test Supplier')
         RETURNING id`,
        [OWNER_ID],
      );
      supplierId = supplierResult.rows[0].id;
    });

    afterAll(async () => {
      if (!pool) return;
      await pool.query(
        `DELETE FROM purchase_order_line_items
          WHERE purchase_order_id IN (
            SELECT id FROM purchase_orders WHERE workspace_owner_id = $1
          )`,
        [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM purchase_orders WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM suppliers WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM locations WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      await pool.end();
      await (routeDb as unknown as import("pg").Pool).end();
    });

    // Reads total_amount directly from the DB, bypassing any computed fields.
    async function fetchTotal(poId: number): Promise<string | null> {
      const result = await pool.query<{ total_amount: string | null }>(
        `SELECT total_amount FROM purchase_orders WHERE id = $1`,
        [poId],
      );
      return result.rows[0]?.total_amount ?? null;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Locked-total scenarios (override = true)
    // ─────────────────────────────────────────────────────────────────────────

    it(
      "preserves total_amount when override=true and a line item is added",
      async () => {
        // Create a PO with a manually-locked total of 999.99
        const createRes = await request(app)
          .post("/purchase-orders")
          .send({
            supplier_id: supplierId,
            location_id: locationId,
            total_amount: "999.99",
            total_amount_manual_override: true,
            currency: "AED",
          });
        expect(createRes.status).toBe(201);
        const poId: number = createRes.body.purchase_order.id;

        try {
          // Add a line item whose calculated value (5 × 10 = 50) differs from the locked total
          const addRes = await request(app)
            .post(`/purchase-orders/${poId}/line-items`)
            .send({ description: "Widget", quantity: "5", unit_price: "10" });
          expect(addRes.status).toBe(201);

          const total = await fetchTotal(poId);
          expect(parseFloat(total!)).toBeCloseTo(999.99, 2);
        } finally {
          await pool.query(
            `DELETE FROM purchase_order_line_items WHERE purchase_order_id = $1`,
            [poId],
          );
          await pool.query(`DELETE FROM purchase_orders WHERE id = $1`, [poId]);
        }
      },
    );

    it(
      "preserves total_amount when override=true and a line item is updated",
      async () => {
        const createRes = await request(app)
          .post("/purchase-orders")
          .send({
            supplier_id: supplierId,
            location_id: locationId,
            total_amount: "999.99",
            total_amount_manual_override: true,
            currency: "AED",
            line_items: [{ description: "Widget", quantity: "1", unit_price: "1" }],
          });
        expect(createRes.status).toBe(201);
        const poId: number = createRes.body.purchase_order.id;

        const liResult = await pool.query<{ id: number }>(
          `SELECT id FROM purchase_order_line_items WHERE purchase_order_id = $1`,
          [poId],
        );
        const lineItemId = liResult.rows[0].id;

        try {
          // Update the line item to a wildly different price (100 × 200 = 20 000)
          const patchRes = await request(app)
            .patch(`/purchase-orders/${poId}/line-items/${lineItemId}`)
            .send({ quantity: "100", unit_price: "200" });
          expect(patchRes.status).toBe(200);

          const total = await fetchTotal(poId);
          expect(parseFloat(total!)).toBeCloseTo(999.99, 2);
        } finally {
          await pool.query(
            `DELETE FROM purchase_order_line_items WHERE purchase_order_id = $1`,
            [poId],
          );
          await pool.query(`DELETE FROM purchase_orders WHERE id = $1`, [poId]);
        }
      },
    );

    it(
      "preserves total_amount when override=true and a line item is deleted",
      async () => {
        const createRes = await request(app)
          .post("/purchase-orders")
          .send({
            supplier_id: supplierId,
            location_id: locationId,
            total_amount: "999.99",
            total_amount_manual_override: true,
            currency: "AED",
            line_items: [{ description: "Widget", quantity: "5", unit_price: "10" }],
          });
        expect(createRes.status).toBe(201);
        const poId: number = createRes.body.purchase_order.id;

        const liResult = await pool.query<{ id: number }>(
          `SELECT id FROM purchase_order_line_items WHERE purchase_order_id = $1`,
          [poId],
        );
        const lineItemId = liResult.rows[0].id;

        try {
          const deleteRes = await request(app)
            .delete(`/purchase-orders/${poId}/line-items/${lineItemId}`);
          expect(deleteRes.status).toBe(200);

          const total = await fetchTotal(poId);
          expect(parseFloat(total!)).toBeCloseTo(999.99, 2);
        } finally {
          await pool.query(
            `DELETE FROM purchase_order_line_items WHERE purchase_order_id = $1`,
            [poId],
          );
          await pool.query(`DELETE FROM purchase_orders WHERE id = $1`, [poId]);
        }
      },
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Auto-recalculate scenarios (override = false)
    // ─────────────────────────────────────────────────────────────────────────

    it(
      "recalculates total_amount when override=false and a line item is added",
      async () => {
        const createRes = await request(app)
          .post("/purchase-orders")
          .send({
            supplier_id: supplierId,
            location_id: locationId,
            total_amount_manual_override: false,
            currency: "AED",
          });
        expect(createRes.status).toBe(201);
        const poId: number = createRes.body.purchase_order.id;

        try {
          // 3 × 7 = 21
          const addRes = await request(app)
            .post(`/purchase-orders/${poId}/line-items`)
            .send({ description: "Gadget", quantity: "3", unit_price: "7" });
          expect(addRes.status).toBe(201);

          const total = await fetchTotal(poId);
          expect(parseFloat(total!)).toBeCloseTo(21, 4);
        } finally {
          await pool.query(
            `DELETE FROM purchase_order_line_items WHERE purchase_order_id = $1`,
            [poId],
          );
          await pool.query(`DELETE FROM purchase_orders WHERE id = $1`, [poId]);
        }
      },
    );

    it(
      "recalculates total_amount when override=false and a line item is updated",
      async () => {
        const createRes = await request(app)
          .post("/purchase-orders")
          .send({
            supplier_id: supplierId,
            location_id: locationId,
            total_amount_manual_override: false,
            currency: "AED",
            line_items: [{ description: "Gadget", quantity: "3", unit_price: "7" }],
          });
        expect(createRes.status).toBe(201);
        const poId: number = createRes.body.purchase_order.id;

        const liResult = await pool.query<{ id: number }>(
          `SELECT id FROM purchase_order_line_items WHERE purchase_order_id = $1`,
          [poId],
        );
        const lineItemId = liResult.rows[0].id;

        try {
          // 2 × 5 = 10
          const patchRes = await request(app)
            .patch(`/purchase-orders/${poId}/line-items/${lineItemId}`)
            .send({ quantity: "2", unit_price: "5" });
          expect(patchRes.status).toBe(200);

          const total = await fetchTotal(poId);
          expect(parseFloat(total!)).toBeCloseTo(10, 4);
        } finally {
          await pool.query(
            `DELETE FROM purchase_order_line_items WHERE purchase_order_id = $1`,
            [poId],
          );
          await pool.query(`DELETE FROM purchase_orders WHERE id = $1`, [poId]);
        }
      },
    );

    it(
      "recalculates total_amount to 0 when override=false and the last line item is deleted",
      async () => {
        const createRes = await request(app)
          .post("/purchase-orders")
          .send({
            supplier_id: supplierId,
            location_id: locationId,
            total_amount_manual_override: false,
            currency: "AED",
            line_items: [{ description: "Gadget", quantity: "3", unit_price: "7" }],
          });
        expect(createRes.status).toBe(201);
        const poId: number = createRes.body.purchase_order.id;

        const liResult = await pool.query<{ id: number }>(
          `SELECT id FROM purchase_order_line_items WHERE purchase_order_id = $1`,
          [poId],
        );
        const lineItemId = liResult.rows[0].id;

        try {
          const deleteRes = await request(app)
            .delete(`/purchase-orders/${poId}/line-items/${lineItemId}`);
          expect(deleteRes.status).toBe(200);

          // COALESCE(SUM(...), 0) → 0 when no line items remain
          const total = await fetchTotal(poId);
          expect(parseFloat(total!)).toBeCloseTo(0, 4);
        } finally {
          await pool.query(
            `DELETE FROM purchase_order_line_items WHERE purchase_order_id = $1`,
            [poId],
          );
          await pool.query(`DELETE FROM purchase_orders WHERE id = $1`, [poId]);
        }
      },
    );
  },
);
