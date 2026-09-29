/**
 * Integration test: PATCH /api/orders/:id cancel path — inventory consumption reversal.
 *
 * Verifies that cancelling a `ready_for_delivery` order via the general-purpose
 * PATCH /api/orders/:id route (not the dedicated status endpoint) correctly
 * creates reversal movements for any prior product_consumption rows.
 *
 * This guards against the regression where the PATCH route could bypass the
 * `postCancellationReversal` logic, leaving stock depleted after a cancellation.
 *
 * Scenarios:
 *   1. Cancelling a ready_for_delivery order → reversal movement created
 *   2. Re-running the same cancel PATCH → no duplicate reversal (idempotent)
 *   3. Order with no prior consumption rows → cancel succeeds, nothing to reverse
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
import { postMovement } from "../lib/inventoryService";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;

// ─────────────────────────────────────────────────────────────────────────────
// Unique workspace ID — never collides with real data
// ─────────────────────────────────────────────────────────────────────────────

const OWNER_ID = `__orders_inv_cancel_inttest_${Date.now()}`;
const USER_ID = "__orders_inv_cancel_user__";

// ─────────────────────────────────────────────────────────────────────────────
// Mocks — all side effects stubbed; db and inventory code are real
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
    wreq.userEmail = "inv-cancel-test@example.com";
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
    withTransaction: async <T>(fn: (client: import("pg").PoolClient) => Promise<T>): Promise<T> => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
  };
});

vi.mock("@clerk/express", () => ({
  clerkClient: {
    users: {
      getUser: vi.fn().mockResolvedValue({ id: "__orders_inv_cancel_user__" }),
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
import { db as routeDb } from "../lib/db";

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
  "PATCH /api/orders/:id cancel — inventory consumption reversal (integration)",
  () => {
    let pool: InstanceType<typeof Pool>;
    let app: express.Express;

    // IDs created during seeding
    let locationId: number;
    let baseItemId: number;
    let productId: number;

    // ── Setup / teardown ────────────────────────────────────────────────────

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL });
      app = makeApp();

      // Purge any leftover rows from a previous failed run
      await pool.query(`DELETE FROM orders WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM workspace_settings WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM product_recipes WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM products WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM base_item_ledger_settings WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM base_item_stock_adjustments WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM base_items WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM locations WHERE workspace_owner_id = $1`, [OWNER_ID]);

      // workspace_settings: enable recipe consumption + negative stock (so no baseline required)
      await pool.query(
        `INSERT INTO workspace_settings (workspace_owner_id, inventory_recipe_consumption_enabled, inventory_allow_negative_stock)
         VALUES ($1, true, true)
         ON CONFLICT (workspace_owner_id) DO UPDATE
           SET inventory_recipe_consumption_enabled = true,
               inventory_allow_negative_stock = true`,
        [OWNER_ID],
      );

      // Location
      const locRow = await pool.query<{ id: number }>(
        `INSERT INTO locations (workspace_owner_id, name, country)
         VALUES ($1, 'Test Warehouse', 'AE')
         RETURNING id`,
        [OWNER_ID],
      );
      locationId = locRow.rows[0].id;

      // Base item
      const biRow = await pool.query<{ id: number }>(
        `INSERT INTO base_items (workspace_owner_id, name, code)
         VALUES ($1, 'Ferrero Rocher 24pc', 'FR-24')
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
      await pool.query(
        `UPDATE base_items SET stock = 100 WHERE id = $1`,
        [baseItemId],
      );

      // Product (inventory_tracked = true)
      const prodRow = await pool.query<{ id: number }>(
        `INSERT INTO products (workspace_owner_id, name, inventory_tracked)
         VALUES ($1, 'Roses & Rocher Luxe Bundle', true)
         RETURNING id`,
        [OWNER_ID],
      );
      productId = prodRow.rows[0].id;

      // Recipe: 1 unit of product consumes 24 units of base item
      await pool.query(
        `INSERT INTO product_recipes (workspace_owner_id, product_id, base_item_id, quantity)
         VALUES ($1, $2, $3, 24)`,
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

    // ── Helper: seed a ready_for_delivery order with one line item and a
    //           product_consumption movement, return the order id and movement id.
    async function seedFulfilledOrder(): Promise<{
      orderId: string;
      consumptionId: number;
    }> {
      // Order at ready_for_delivery with location_id set (florist-assignment fallback)
      const orderRes = await pool.query<{ id: string }>(
        `INSERT INTO orders
           (workspace_owner_id, source, external_order_id, status, ordered_at,
            location_id, totals)
         VALUES ($1, 'dashboard', $2, 'ready_for_delivery', now(), $3, $4::jsonb)
         RETURNING id`,
        [
          OWNER_ID,
          `inv-cancel-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          locationId,
          JSON.stringify({ total: 100, currency: "AED" }),
        ],
      );
      const orderId = orderRes.rows[0].id;

      // Line item
      const liRes = await pool.query<{ id: string }>(
        `INSERT INTO order_line_items
           (order_id, product_id, name, quantity, unit_price, line_total)
         VALUES ($1, $2, 'Roses & Rocher Luxe Bundle', 1, 100, 100)
         RETURNING id::text AS id`,
        [orderId, productId],
      );
      const lineItemId = liRes.rows[0].id;

      // Post through the authoritative writer so the fixture's ledger and
      // per-location on-hand cache remain reconciled.
      const client = await pool.connect();
      let consumptionId: number;
      try {
        await client.query("BEGIN");
        const movement = await postMovement(client, {
          workspaceOwnerId: OWNER_ID,
          baseItemId,
          locationId,
          quantityChange: -24,
          reason: `Order ${orderId}`,
          movementType: "product_consumption",
          orderId,
          orderLineItemId: lineItemId,
          productId,
          idempotencyKey: `pc:${orderId}:${lineItemId}:${baseItemId}:c0`,
        });
        consumptionId = movement.movementId!;
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }

      return { orderId, consumptionId };
    }

    // ── Test 1: cancel creates reversal movement ───────────────────────────

    it("creates a reversal movement when a ready_for_delivery order is cancelled via PATCH", async () => {
      const { orderId, consumptionId } = await seedFulfilledOrder();

      const res = await request(app)
        .patch(`/api/orders/${orderId}`)
        .send({ status: "cancelled" })
        .set("Content-Type", "application/json");

      // Should succeed
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);

      // Verify a reversal row was inserted
      const reversal = await pool.query<{
        id: number;
        movement_type: string;
        reversal_of_id: number;
        quantity_change: string;
      }>(
        `SELECT id, movement_type, reversal_of_id, quantity_change
           FROM base_item_stock_adjustments
          WHERE workspace_owner_id = $1
            AND order_id = $2
            AND movement_type = 'order_cancellation'`,
        [OWNER_ID, orderId],
      );

      expect(reversal.rows).toHaveLength(1);
      expect(reversal.rows[0].reversal_of_id).toBe(consumptionId);
      // Quantity change should be positive (stock restored)
      expect(parseFloat(reversal.rows[0].quantity_change)).toBe(24);

      // Verify the order status is now cancelled
      const orderRow = await pool.query<{ status: string }>(
        `SELECT status FROM orders WHERE id = $1 AND workspace_owner_id = $2`,
        [orderId, OWNER_ID],
      );
      expect(orderRow.rows[0].status).toBe("cancelled");
    });

    // ── Test 2: second cancel PATCH is idempotent — no duplicate reversal ──

    it("does not create duplicate reversal when the same cancel PATCH is repeated", async () => {
      const { orderId } = await seedFulfilledOrder();

      // First cancel
      const res1 = await request(app)
        .patch(`/api/orders/${orderId}`)
        .send({ status: "cancelled" })
        .set("Content-Type", "application/json");
      expect(res1.status).toBeGreaterThanOrEqual(200);
      expect(res1.status).toBeLessThan(300);

      // Second cancel (same status — no-op at the route level since status already equals target)
      const res2 = await request(app)
        .patch(`/api/orders/${orderId}`)
        .send({ status: "cancelled" })
        .set("Content-Type", "application/json");
      expect(res2.status).toBeGreaterThanOrEqual(200);
      expect(res2.status).toBeLessThan(300);

      // Still exactly one reversal row
      const reversals = await pool.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt
           FROM base_item_stock_adjustments
          WHERE workspace_owner_id = $1
            AND order_id = $2
            AND movement_type = 'order_cancellation'`,
        [OWNER_ID, orderId],
      );
      expect(parseInt(reversals.rows[0].cnt, 10)).toBe(1);
    });

    // ── Test 3: cancelling an order with no prior consumption rows succeeds ──

    it("succeeds and creates no reversal when the order has no consumption movements", async () => {
      // Order with no consumption row (e.g. flag was off when it was fulfilled)
      const orderRes = await pool.query<{ id: string }>(
        `INSERT INTO orders
           (workspace_owner_id, source, external_order_id, status, ordered_at,
            location_id, totals)
         VALUES ($1, 'dashboard', $2, 'ready_for_delivery', now(), $3, $4::jsonb)
         RETURNING id`,
        [
          OWNER_ID,
          `inv-no-consumption-${Date.now()}`,
          locationId,
          JSON.stringify({ total: 50, currency: "AED" }),
        ],
      );
      const orderId = orderRes.rows[0].id;

      // Line item — but NO base_item_stock_adjustments row
      await pool.query(
        `INSERT INTO order_line_items (order_id, product_id, name, quantity, unit_price, line_total)
         VALUES ($1, $2, 'Test Product', 1, 50, 50)`,
        [orderId, productId],
      );

      const res = await request(app)
        .patch(`/api/orders/${orderId}`)
        .send({ status: "cancelled" })
        .set("Content-Type", "application/json");

      // Must succeed even though there's nothing to reverse
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);

      const reversal = await pool.query(
        `SELECT COUNT(*)::text AS cnt FROM base_item_stock_adjustments
          WHERE workspace_owner_id = $1 AND order_id = $2 AND movement_type = 'order_cancellation'`,
        [OWNER_ID, orderId],
      );
      expect(parseInt(reversal.rows[0].cnt, 10)).toBe(0);

      // Status is cancelled
      const orderRow = await pool.query<{ status: string }>(
        `SELECT status FROM orders WHERE id = $1 AND workspace_owner_id = $2`,
        [orderId, OWNER_ID],
      );
      expect(orderRow.rows[0].status).toBe("cancelled");
    });

    // ── Test 4: fulfil via PATCH, then cancel via PATCH — full cycle ────────

    it("full cycle: fulfil via PATCH then cancel via PATCH creates consumption then reversal", async () => {
      // Start with a pending/processing order — no consumption yet
      const orderRes = await pool.query<{ id: string }>(
        `INSERT INTO orders
           (workspace_owner_id, source, external_order_id, status, ordered_at,
            location_id, totals)
         VALUES ($1, 'dashboard', $2, 'processing', now(), $3, $4::jsonb)
         RETURNING id`,
        [
          OWNER_ID,
          `inv-full-cycle-${Date.now()}`,
          locationId,
          JSON.stringify({ total: 100, currency: "AED" }),
        ],
      );
      const orderId = orderRes.rows[0].id;

      await pool.query(
        `INSERT INTO order_line_items (order_id, product_id, name, quantity, unit_price, line_total)
         VALUES ($1, $2, 'Roses & Rocher Luxe Bundle', 1, 100, 100)`,
        [orderId, productId],
      );

      // Step 1: Transition to ready_for_delivery → consumption movement should be posted
      const r1 = await request(app)
        .patch(`/api/orders/${orderId}`)
        .send({ status: "ready_for_delivery" })
        .set("Content-Type", "application/json");
      expect(r1.status).toBeGreaterThanOrEqual(200);
      expect(r1.status).toBeLessThan(300);

      const consumptions = await pool.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt FROM base_item_stock_adjustments
          WHERE workspace_owner_id = $1 AND order_id = $2 AND movement_type = 'product_consumption'`,
        [OWNER_ID, orderId],
      );
      expect(parseInt(consumptions.rows[0].cnt, 10)).toBe(1);

      // Step 2: Cancel → reversal movement created
      const r2 = await request(app)
        .patch(`/api/orders/${orderId}`)
        .send({ status: "cancelled" })
        .set("Content-Type", "application/json");
      expect(r2.status).toBeGreaterThanOrEqual(200);
      expect(r2.status).toBeLessThan(300);

      const reversals = await pool.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt FROM base_item_stock_adjustments
          WHERE workspace_owner_id = $1 AND order_id = $2 AND movement_type = 'order_cancellation'`,
        [OWNER_ID, orderId],
      );
      expect(parseInt(reversals.rows[0].cnt, 10)).toBe(1);

      // Net stock impact = 0 (one consumption + one reversal of the same qty)
      const netImpact = await pool.query<{ net: string }>(
        `SELECT COALESCE(SUM(quantity_change), 0)::text AS net
           FROM base_item_stock_adjustments
          WHERE workspace_owner_id = $1 AND order_id = $2`,
        [OWNER_ID, orderId],
      );
      expect(parseFloat(netImpact.rows[0].net)).toBe(0);
    });
  },
);
