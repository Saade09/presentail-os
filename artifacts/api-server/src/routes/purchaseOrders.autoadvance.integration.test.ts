/**
 * Integration tests: purchase order auto-advance on received_quantity updates
 *
 * Verifies that `syncPoStatus` (called after PATCH and POST line-item requests)
 * correctly promotes the parent PO status:
 *
 *   - Updating received_quantity on SOME (but not all) items → status "partial"
 *   - Updating received_quantity on ALL items to >= quantity → status "received"
 *   - Items with no received_quantity leave the PO status unchanged
 *   - POST line-item with received_quantity pre-filled triggers auto-advance
 *
 * Auth and workspace middleware are stubbed; the database is real (pg.Pool).
 * The suite skips automatically when DATABASE_URL is not set.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import pg from "pg";
import type { WorkspaceRequest } from "../lib/workspace";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;

// ─────────────────────────────────────────────────────────────────────────────
// Unique owner so tests never collide with real workspace data
// ─────────────────────────────────────────────────────────────────────────────

const OWNER_ID = "__integration_test_po_autoadvance__";
const USER_ID = "__integration_test_po_aa_user__";

// ─────────────────────────────────────────────────────────────────────────────
// Mocks — auth / workspace / logger / email / clerkClient.
// db is NOT mocked — the real lib/db Pool connects to DATABASE_URL.
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
  authed: (req: express.Request) => ({
    ...(req as unknown as WorkspaceRequest),
    userId: USER_ID,
  }),
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
    wreq.userEmail = "po-aa-test@example.com";
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
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
      getUserList: vi.fn().mockResolvedValue({ data: [] }),
    },
  },
}));

// Import router AFTER vi.mock declarations (hoisting boundary)
import purchaseOrdersRouter from "./purchaseOrders";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(purchaseOrdersRouter);
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err.message, stack: err.stack });
  });
  return app;
}

async function getPoStatus(pool: InstanceType<typeof Pool>, poId: number): Promise<string> {
  const result = await pool.query<{ status: string }>(
    `SELECT status FROM purchase_orders WHERE id = $1`,
    [poId],
  );
  return result.rows[0].status;
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!DATABASE_URL)(
  "Purchase order auto-advance integration tests",
  () => {
    let pool: InstanceType<typeof Pool>;
    let app: express.Express;
    let supplierId: number;

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

      // Seed a supplier
      const supplierResult = await pool.query<{ id: number }>(
        `INSERT INTO suppliers (workspace_owner_id, name)
         VALUES ($1, 'Auto-Advance Test Supplier') RETURNING id`,
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
      await pool.end();
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Helper: seed a fresh PO with N line items (no received_quantity)
    // ─────────────────────────────────────────────────────────────────────────

    async function seedPoWithItems(
      itemCount: number,
      quantity = "10",
    ): Promise<{ poId: number; lineItemIds: number[] }> {
      const poResult = await pool.query<{ id: number }>(
        `INSERT INTO purchase_orders
           (workspace_owner_id, supplier_id, status, currency, updated_at)
         VALUES ($1, $2, 'sent', 'AED', now())
         RETURNING id`,
        [OWNER_ID, supplierId],
      );
      const poId = poResult.rows[0].id;

      const lineItemIds: number[] = [];
      for (let i = 0; i < itemCount; i++) {
        const liResult = await pool.query<{ id: number }>(
          `INSERT INTO purchase_order_line_items
             (purchase_order_id, description, quantity, unit_price, currency)
           VALUES ($1, $2, $3, '5.00', 'AED')
           RETURNING id`,
          [poId, `Item ${i + 1}`, quantity],
        );
        lineItemIds.push(liResult.rows[0].id);
      }

      return { poId, lineItemIds };
    }

    // ─────────────────────────────────────────────────────────────────────
    // Scenario 1: no received_quantity → status unchanged
    // ─────────────────────────────────────────────────────────────────────

    it("leaves PO status unchanged when no items have a received_quantity", async () => {
      const { poId, lineItemIds } = await seedPoWithItems(2);

      // PATCH without received_quantity (only update description)
      const res = await request(app)
        .patch(`/purchase-orders/${poId}/line-items/${lineItemIds[0]}`)
        .send({ description: "Updated Item 1" });

      expect(res.status).toBe(200);

      const status = await getPoStatus(pool, poId);
      expect(status).toBe("sent");
    });

    // ─────────────────────────────────────────────────────────────────────
    // Scenario 2: some items received → status "partial"
    // ─────────────────────────────────────────────────────────────────────

    it("sets PO status to 'partial' when only some items are received", async () => {
      const { poId, lineItemIds } = await seedPoWithItems(3);

      // Mark the first item as fully received
      const res = await request(app)
        .patch(`/purchase-orders/${poId}/line-items/${lineItemIds[0]}`)
        .send({ received_quantity: "10" });

      expect(res.status).toBe(200);
      expect(parseFloat(res.body.line_item.received_quantity)).toBe(10);

      const status = await getPoStatus(pool, poId);
      expect(status).toBe("partial");
    });

    it("sets PO status to 'partial' when some items are partially received (less than quantity)", async () => {
      const { poId, lineItemIds } = await seedPoWithItems(2);

      // Mark the first item with a partial received quantity (5 out of 10)
      const res = await request(app)
        .patch(`/purchase-orders/${poId}/line-items/${lineItemIds[0]}`)
        .send({ received_quantity: "5" });

      expect(res.status).toBe(200);

      const status = await getPoStatus(pool, poId);
      expect(status).toBe("partial");
    });

    // ─────────────────────────────────────────────────────────────────────
    // Scenario 3: all items fully received → status "received"
    // ─────────────────────────────────────────────────────────────────────

    it("sets PO status to 'received' when all items have received_quantity >= quantity", async () => {
      const { poId, lineItemIds } = await seedPoWithItems(2);

      // Mark both items as fully received
      for (const lineItemId of lineItemIds) {
        const res = await request(app)
          .patch(`/purchase-orders/${poId}/line-items/${lineItemId}`)
          .send({ received_quantity: "10" });
        expect(res.status).toBe(200);
      }

      const status = await getPoStatus(pool, poId);
      expect(status).toBe("received");
    });

    it("sets PO status to 'received' when received_quantity exceeds quantity", async () => {
      const { poId, lineItemIds } = await seedPoWithItems(1);

      // Receive more than ordered (over-delivery)
      const res = await request(app)
        .patch(`/purchase-orders/${poId}/line-items/${lineItemIds[0]}`)
        .send({ received_quantity: "15" });

      expect(res.status).toBe(200);

      const status = await getPoStatus(pool, poId);
      expect(status).toBe("received");
    });

    it("advances from 'partial' to 'received' when the last outstanding item is received", async () => {
      const { poId, lineItemIds } = await seedPoWithItems(2);

      // Receive the first item → partial
      await request(app)
        .patch(`/purchase-orders/${poId}/line-items/${lineItemIds[0]}`)
        .send({ received_quantity: "10" });

      expect(await getPoStatus(pool, poId)).toBe("partial");

      // Receive the second item → received
      const res = await request(app)
        .patch(`/purchase-orders/${poId}/line-items/${lineItemIds[1]}`)
        .send({ received_quantity: "10" });

      expect(res.status).toBe(200);
      expect(await getPoStatus(pool, poId)).toBe("received");
    });

    // ─────────────────────────────────────────────────────────────────────
    // Scenario 4: POST line-item with received_quantity pre-filled
    // ─────────────────────────────────────────────────────────────────────

    it("auto-advances to 'partial' when a new line item is POSTed with a non-zero received_quantity alongside unreceived items", async () => {
      // Create a PO with one existing unrecieved line item
      const { poId } = await seedPoWithItems(1);

      // POST a second line item that is already fully received
      const res = await request(app)
        .post(`/purchase-orders/${poId}/line-items`)
        .send({
          description: "Pre-received item",
          quantity: "5",
          unit_price: "20.00",
          received_quantity: "5",
        });

      expect(res.status).toBe(201);
      expect(parseFloat(res.body.line_item.received_quantity)).toBe(5);

      // First item has no received_quantity, second does → partial
      const status = await getPoStatus(pool, poId);
      expect(status).toBe("partial");
    });

    it("auto-advances to 'received' when a new line item is POSTed with received_quantity and all existing items are also fully received", async () => {
      // Create a PO with one fully-received existing line item
      const { poId, lineItemIds } = await seedPoWithItems(1);

      await request(app)
        .patch(`/purchase-orders/${poId}/line-items/${lineItemIds[0]}`)
        .send({ received_quantity: "10" });

      expect(await getPoStatus(pool, poId)).toBe("received");

      // POST a new line item that is also fully received
      const res = await request(app)
        .post(`/purchase-orders/${poId}/line-items`)
        .send({
          description: "Another received item",
          quantity: "3",
          unit_price: "10.00",
          received_quantity: "3",
        });

      expect(res.status).toBe(201);

      // All items received → still "received"
      const status = await getPoStatus(pool, poId);
      expect(status).toBe("received");
    });

    it("does NOT advance status when a new line item is POSTed without received_quantity", async () => {
      const { poId } = await seedPoWithItems(1);

      // POST a new line item with no received_quantity
      const res = await request(app)
        .post(`/purchase-orders/${poId}/line-items`)
        .send({
          description: "Unrecieved item",
          quantity: "4",
          unit_price: "8.00",
        });

      expect(res.status).toBe(201);
      expect(res.body.line_item.received_quantity).toBeNull();

      // Neither item has been received → status unchanged ("sent")
      const status = await getPoStatus(pool, poId);
      expect(status).toBe("sent");
    });

    // ─────────────────────────────────────────────────────────────────────
    // Edge case: single-item PO
    // ─────────────────────────────────────────────────────────────────────

    it("advances a single-item PO directly to 'received' when that item is received", async () => {
      const { poId, lineItemIds } = await seedPoWithItems(1);

      const res = await request(app)
        .patch(`/purchase-orders/${poId}/line-items/${lineItemIds[0]}`)
        .send({ received_quantity: "10" });

      expect(res.status).toBe(200);
      expect(await getPoStatus(pool, poId)).toBe("received");
    });

    it("does not change status to 'partial' for a single-item PO when received_quantity is 0", async () => {
      const { poId, lineItemIds } = await seedPoWithItems(1);

      // received_quantity of 0 means "not received" (any_received stays 0)
      const res = await request(app)
        .patch(`/purchase-orders/${poId}/line-items/${lineItemIds[0]}`)
        .send({ received_quantity: "0" });

      expect(res.status).toBe(200);

      // syncPoStatus: anyReceived === 0, so no update → still "sent"
      const status = await getPoStatus(pool, poId);
      expect(status).toBe("sent");
    });
  },
);
