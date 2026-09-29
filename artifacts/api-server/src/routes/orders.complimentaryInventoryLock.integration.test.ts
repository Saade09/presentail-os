/**
 * Integration test: complimentary line items and real inventory/recipe
 * consumption.
 *
 * Verifies two things end-to-end against a real database:
 *   1. A complimentary line item consumes recipe/base-item stock exactly
 *      like a regular line item when the order transitions to
 *      ready_for_delivery — consumption is driven by product_id/quantity,
 *      never by price.
 *   2. Once that consumption has been posted, the add/quantity-edit/remove
 *      line-item routes reject further complimentary changes on that order
 *      (409) rather than silently drifting the stock ledger, since recipe
 *      consumption is posted once atomically and is not incrementally
 *      reconciled against later line-item edits.
 *
 * Auth/workspace and all side-effect modules (email, tookan, webhooks, etc.)
 * are stubbed. The database is real. Skips automatically when DATABASE_URL is
 * not set.
 *
 * Run via:
 *   pnpm --filter @workspace/api-server run test:integration:local
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import pg from "pg";
import type { WorkspaceRequest } from "../lib/workspace";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;

const OWNER_ID = `__orders_comp_inv_inttest_${Date.now()}`;
const USER_ID = "__orders_comp_inv_user__";

// ─────────────────────────────────────────────────────────────────────────────
// Mocks — same set as orders.inventoryCancel.integration.test.ts (same router)
// ─────────────────────────────────────────────────────────────────────────────

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
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = OWNER_ID;
    wreq.workspaceRole = "owner";
    wreq.workspaceActualRole = "owner";
    wreq.userId = USER_ID;
    wreq.userEmail = "comp-inv-test@example.com";
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
  hasPageAccess: () => true,
}));

vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

vi.mock("../lib/catalogWebhook", () => ({
  fireWebhookEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/email", () => ({
  sendOrderStatusEmail: vi.fn().mockResolvedValue(undefined),
  sendOrderRefundEmail: vi.fn().mockResolvedValue(undefined),
  sendOrderPaymentInstructionsEmail: vi.fn().mockResolvedValue(undefined),
  sendOrderPaymentReceivedEmail: vi.fn().mockResolvedValue(undefined),
  ORDER_STATUS_EMAIL_STATUSES: new Set(["processing", "ready_for_delivery", "out_for_delivery", "delivered"]),
}));

vi.mock("../lib/tookan", () => ({
  isTookanEnabled: vi.fn().mockReturnValue(false),
  retryTookanDeliveryTask: vi.fn().mockResolvedValue(undefined),
  backfillTookanDeliveryTasks: vi.fn().mockResolvedValue(undefined),
  editTookanDeliveryTask: vi.fn().mockResolvedValue(undefined),
  TOOKAN_MISSING_ADDRESS_ERROR: "address_missing",
}));

vi.mock("../lib/trustpilotInvitations", () => ({
  maybeEnqueueTrustpilotInvitation: vi.fn().mockResolvedValue(undefined),
  processTrustpilotInvitation: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/trustpilot", () => ({
  isTrustpilotEnabled: vi.fn().mockReturnValue(false),
  isTrustpilotTestMode: vi.fn().mockReturnValue(false),
}));

vi.mock("../lib/slack", () => ({
  isUaeCountryCode: vi.fn().mockReturnValue(false),
  notifyNewUaeOrderToSlack: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/orderComms", () => ({
  trackOrderEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/objectStorage", () => ({
  PUBLIC_OBJECT_HOST: "https://storage.test",
  buildPublicObjectUrl: vi.fn().mockReturnValue("https://storage.test/img"),
  objectStorageClient: {
    uploadFile: vi.fn(),
    deleteFile: vi.fn(),
    getSignedUrl: vi.fn(),
  },
}));

vi.mock("../lib/giftCardPdf", () => ({
  buildGiftCardPdf: vi.fn().mockResolvedValue(Buffer.from("pdf")),
}));

vi.mock("../lib/orderInvoicePdf", () => ({
  buildOrderInvoicePdf: vi.fn().mockResolvedValue(Buffer.from("pdf")),
  resolveInvoiceSenderLines: vi.fn().mockResolvedValue([]),
  isWhishPayment: vi.fn().mockReturnValue(false),
  includedVatAmount: vi.fn().mockReturnValue(0),
  WHISH_VAT_RATE: 0.11,
}));

vi.mock("../lib/contactUpsert", () => ({
  normalizePhone: vi.fn((p: string) => p),
}));

vi.mock("../lib/genderInference", () => ({
  queueGenderInference: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/orderCreate", () => ({
  createManualOrder: vi.fn(),
  ContactNotFoundError: class ContactNotFoundError extends Error {},
}));

vi.mock("../lib/stripeAmountVerification", () => ({
  stripeMajorToMinor: vi.fn(),
  currencyDecimals: vi.fn().mockReturnValue(2),
}));

vi.mock("./paymentLinks", () => ({
  isUaeStripeCountry: vi.fn().mockReturnValue(false),
}));

vi.mock("../lib/db", async () => {
  const pgModule = await import("pg");
  const pool = new pgModule.default.Pool({ connectionString: process.env.DATABASE_URL });
  return {
    db: pool,
    // Real signature: withTransaction(client, fn) — runs BEGIN/COMMIT/ROLLBACK
    // on the caller-supplied client and invokes fn with no arguments.
    withTransaction: async <T>(
      client: import("pg").PoolClient,
      fn: () => Promise<T>,
    ): Promise<T> => {
      try {
        await client.query("BEGIN");
        const result = await fn();
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      }
    },
  };
});

vi.mock("@clerk/express", () => ({
  clerkClient: {
    users: {
      getUser: vi
        .fn()
        .mockResolvedValue({ id: "__orders_comp_inv_user__", firstName: "Sarah", lastName: "Test" }),
      getUserList: vi.fn().mockResolvedValue({ data: [] }),
    },
  },
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
}));

vi.mock("stripe", () => ({
  default: class {
    refunds = { create: vi.fn().mockResolvedValue({ id: "re_test" }) };
  },
}));

// ─────────────────────────────────────────────────────────────────────────────
// Imports — AFTER vi.mock (hoisting boundary)
// ─────────────────────────────────────────────────────────────────────────────

import ordersRouter from "./orders";

// ─────────────────────────────────────────────────────────────────────────────
// App factory
// ─────────────────────────────────────────────────────────────────────────────

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: Record<string, (...args: unknown[]) => void> }).log = {
      error: () => {},
      warn: () => {},
      info: () => {},
      debug: () => {},
    };
    next();
  });
  app.use("/api", ordersRouter);
  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!DATABASE_URL)(
  "Complimentary line items — real recipe consumption and post-fulfilment lock (integration)",
  () => {
    let pool: InstanceType<typeof Pool>;
    let app: express.Express;

    let locationId: number;
    let baseItemId: number;
    let productId: number;

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL });
      app = makeApp();

      await pool.query(`DELETE FROM orders WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM workspace_settings WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM product_recipes WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM products WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM base_item_ledger_settings WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM base_item_stock_adjustments WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM base_items WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM locations WHERE workspace_owner_id = $1`, [OWNER_ID]);

      await pool.query(
        `INSERT INTO workspace_settings (workspace_owner_id, inventory_recipe_consumption_enabled, inventory_allow_negative_stock)
         VALUES ($1, true, true)
         ON CONFLICT (workspace_owner_id) DO UPDATE
           SET inventory_recipe_consumption_enabled = true,
               inventory_allow_negative_stock = true`,
        [OWNER_ID],
      );

      const locRow = await pool.query<{ id: number }>(
        `INSERT INTO locations (workspace_owner_id, name, country)
         VALUES ($1, 'Comp Test Warehouse', 'AE')
         RETURNING id`,
        [OWNER_ID],
      );
      locationId = locRow.rows[0].id;

      const biRow = await pool.query<{ id: number }>(
        `INSERT INTO base_items (workspace_owner_id, name, code)
         VALUES ($1, 'Red Heart Balloon', 'BAL-RH')
         RETURNING id`,
        [OWNER_ID],
      );
      baseItemId = biRow.rows[0].id;
      await pool.query(
        `INSERT INTO base_item_location_statuses
           (workspace_owner_id, base_item_id, location_id, is_active, stock)
         VALUES ($1, $2, $3, true, 100)`,
        [OWNER_ID, baseItemId, locationId],
      );
      await pool.query(`UPDATE base_items SET stock = 100 WHERE id = $1`, [baseItemId]);

      const prodRow = await pool.query<{ id: number }>(
        `INSERT INTO products (workspace_owner_id, name, inventory_tracked, price_usd)
         VALUES ($1, 'Red Heart Balloons', true, 7.5)
         RETURNING id`,
        [OWNER_ID],
      );
      productId = prodRow.rows[0].id;

      // Recipe: 1 unit of product consumes 1 unit of base item
      await pool.query(
        `INSERT INTO product_recipes (workspace_owner_id, product_id, base_item_id, quantity)
         VALUES ($1, $2, $3, 1)`,
        [OWNER_ID, productId, baseItemId],
      );
    });

    afterAll(async () => {
      if (!pool) return;
      await pool.query(`DELETE FROM orders WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM workspace_settings WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM product_recipes WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM products WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM base_item_ledger_settings WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM base_item_stock_adjustments WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM base_items WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM locations WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.end();
    });

    async function seedProcessingOrder(): Promise<string> {
      const orderRes = await pool.query<{ id: string }>(
        `INSERT INTO orders
           (workspace_owner_id, source, external_order_id, status, ordered_at,
            location_id, totals)
         VALUES ($1, 'dashboard', $2, 'processing', now(), $3, $4::jsonb)
         RETURNING id`,
        [
          OWNER_ID,
          `comp-inv-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          locationId,
          JSON.stringify({ subtotal: 0, total: 0, shipping: 0, currency: "USD" }),
        ],
      );
      return orderRes.rows[0].id;
    }

    it("consumes recipe stock identically to a regular item once a complimentary item's order reaches ready_for_delivery", async () => {
      const orderId = await seedProcessingOrder();

      const addRes = await request(app)
        .post(`/api/orders/${orderId}/line-items`)
        .send({ product_id: productId, quantity: 4, complimentary: { reason: "customer_service_gesture" } })
        .set("Content-Type", "application/json");
      expect(addRes.status).toBe(201);
      expect(addRes.body.line_item.is_complimentary).toBe(true);
      expect(parseFloat(addRes.body.line_item.unit_price)).toBe(0);

      const transitionRes = await request(app)
        .patch(`/api/orders/${orderId}`)
        .send({ status: "ready_for_delivery" })
        .set("Content-Type", "application/json");
      expect(transitionRes.status).toBeGreaterThanOrEqual(200);
      expect(transitionRes.status).toBeLessThan(300);

      // Consumption is driven by quantity, not the $0 price: 4 units ordered,
      // recipe consumes 1 base-item unit per product unit → 4 consumed.
      const movement = await pool.query<{ quantity_change: string }>(
        `SELECT quantity_change FROM base_item_stock_adjustments
          WHERE workspace_owner_id = $1 AND order_id = $2 AND movement_type = 'product_consumption'`,
        [OWNER_ID, orderId],
      );
      expect(movement.rows).toHaveLength(1);
      expect(parseFloat(movement.rows[0].quantity_change)).toBe(-4);
    });

    it("rejects adding a complimentary item once the order's consumption has already been posted, leaving stock untouched", async () => {
      const orderId = await seedProcessingOrder();

      // Seed one regular item and fulfil it so consumption is posted.
      await pool.query(
        `INSERT INTO order_line_items (order_id, product_id, name, quantity, unit_price, line_total)
         VALUES ($1, $2, 'Red Heart Balloons', 2, 7.5, 15)`,
        [orderId, productId],
      );
      const fulfil = await request(app)
        .patch(`/api/orders/${orderId}`)
        .send({ status: "ready_for_delivery" })
        .set("Content-Type", "application/json");
      expect(fulfil.status).toBeGreaterThanOrEqual(200);
      expect(fulfil.status).toBeLessThan(300);

      const stockBefore = await pool.query<{ stock: string }>(
        `SELECT stock::text AS stock FROM base_item_location_statuses
          WHERE workspace_owner_id = $1 AND base_item_id = $2 AND location_id = $3`,
        [OWNER_ID, baseItemId, locationId],
      );

      const addRes = await request(app)
        .post(`/api/orders/${orderId}/line-items`)
        .send({ product_id: productId, quantity: 3, complimentary: { reason: "vip_gesture" } })
        .set("Content-Type", "application/json");
      expect(addRes.status).toBe(409);

      // No second consumption movement, no stock drift.
      const movements = await pool.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt FROM base_item_stock_adjustments
          WHERE workspace_owner_id = $1 AND order_id = $2`,
        [OWNER_ID, orderId],
      );
      expect(parseInt(movements.rows[0].cnt, 10)).toBe(1);

      const stockAfter = await pool.query<{ stock: string }>(
        `SELECT stock::text AS stock FROM base_item_location_statuses
          WHERE workspace_owner_id = $1 AND base_item_id = $2 AND location_id = $3`,
        [OWNER_ID, baseItemId, locationId],
      );
      expect(stockAfter.rows[0].stock).toBe(stockBefore.rows[0].stock);
    });

    it("rejects removing a complimentary item once the order's consumption has already been posted, leaving stock untouched", async () => {
      const orderId = await seedProcessingOrder();

      const addRes = await request(app)
        .post(`/api/orders/${orderId}/line-items`)
        .send({ product_id: productId, quantity: 5, complimentary: { reason: "damaged_replacement_item" } })
        .set("Content-Type", "application/json");
      expect(addRes.status).toBe(201);
      const lineItemId = addRes.body.line_item.id as string;

      const fulfil = await request(app)
        .patch(`/api/orders/${orderId}`)
        .send({ status: "ready_for_delivery" })
        .set("Content-Type", "application/json");
      expect(fulfil.status).toBeGreaterThanOrEqual(200);
      expect(fulfil.status).toBeLessThan(300);

      const stockBefore = await pool.query<{ stock: string }>(
        `SELECT stock::text AS stock FROM base_item_location_statuses
          WHERE workspace_owner_id = $1 AND base_item_id = $2 AND location_id = $3`,
        [OWNER_ID, baseItemId, locationId],
      );

      const deleteRes = await request(app).delete(
        `/api/orders/${orderId}/line-items/${lineItemId}`,
      );
      expect(deleteRes.status).toBe(409);

      // Line item still present, consumption movement still exactly one, no reversal, no stock drift.
      const lineItemStillThere = await pool.query(
        `SELECT id FROM order_line_items WHERE id = $1`,
        [lineItemId],
      );
      expect(lineItemStillThere.rows).toHaveLength(1);

      const movements = await pool.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt FROM base_item_stock_adjustments
          WHERE workspace_owner_id = $1 AND order_id = $2`,
        [OWNER_ID, orderId],
      );
      expect(parseInt(movements.rows[0].cnt, 10)).toBe(1);

      const stockAfter = await pool.query<{ stock: string }>(
        `SELECT stock::text AS stock FROM base_item_location_statuses
          WHERE workspace_owner_id = $1 AND base_item_id = $2 AND location_id = $3`,
        [OWNER_ID, baseItemId, locationId],
      );
      expect(stockAfter.rows[0].stock).toBe(stockBefore.rows[0].stock);
    });

    it("keeps rejecting a complimentary add after the order moves on from ready_for_delivery, since consumption stays posted", async () => {
      const orderId = await seedProcessingOrder();

      // Seed one regular item and fulfil it so consumption is posted.
      await pool.query(
        `INSERT INTO order_line_items (order_id, product_id, name, quantity, unit_price, line_total)
         VALUES ($1, $2, 'Red Heart Balloons', 2, 7.5, 15)`,
        [orderId, productId],
      );
      const fulfil = await request(app)
        .patch(`/api/orders/${orderId}`)
        .send({ status: "ready_for_delivery" })
        .set("Content-Type", "application/json");
      expect(fulfil.status).toBeGreaterThanOrEqual(200);
      expect(fulfil.status).toBeLessThan(300);

      // Order moves on from ready_for_delivery (e.g. put on hold) — the
      // lock must still key off the durable consumption evidence, not the
      // order's current status.
      const holdRes = await request(app)
        .patch(`/api/orders/${orderId}`)
        .send({ status: "on_hold" })
        .set("Content-Type", "application/json");
      expect(holdRes.status).toBeGreaterThanOrEqual(200);
      expect(holdRes.status).toBeLessThan(300);

      const statusRow = await pool.query<{ status: string }>(
        `SELECT status FROM orders WHERE id = $1`,
        [orderId],
      );
      expect(statusRow.rows[0].status).toBe("on_hold");

      const addRes = await request(app)
        .post(`/api/orders/${orderId}/line-items`)
        .send({ product_id: productId, quantity: 3, complimentary: { reason: "vip_gesture" } })
        .set("Content-Type", "application/json");
      expect(addRes.status).toBe(409);

      const movements = await pool.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt FROM base_item_stock_adjustments
          WHERE workspace_owner_id = $1 AND order_id = $2`,
        [OWNER_ID, orderId],
      );
      expect(parseInt(movements.rows[0].cnt, 10)).toBe(1);
    });

    it("keeps rejecting a complimentary removal once consumption is posted even if recipe consumption is disabled afterward", async () => {
      const orderId = await seedProcessingOrder();

      const addRes = await request(app)
        .post(`/api/orders/${orderId}/line-items`)
        .send({ product_id: productId, quantity: 5, complimentary: { reason: "damaged_replacement_item" } })
        .set("Content-Type", "application/json");
      expect(addRes.status).toBe(201);
      const lineItemId = addRes.body.line_item.id as string;

      const fulfil = await request(app)
        .patch(`/api/orders/${orderId}`)
        .send({ status: "ready_for_delivery" })
        .set("Content-Type", "application/json");
      expect(fulfil.status).toBeGreaterThanOrEqual(200);
      expect(fulfil.status).toBeLessThan(300);

      // Disable the workspace-wide feature flag after stock was already
      // posted — this must not reopen the lock on this order.
      await pool.query(
        `UPDATE workspace_settings SET inventory_recipe_consumption_enabled = false
          WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );

      const deleteRes = await request(app).delete(
        `/api/orders/${orderId}/line-items/${lineItemId}`,
      );
      expect(deleteRes.status).toBe(409);

      const lineItemStillThere = await pool.query(
        `SELECT id FROM order_line_items WHERE id = $1`,
        [lineItemId],
      );
      expect(lineItemStillThere.rows).toHaveLength(1);
    });
  },
);
