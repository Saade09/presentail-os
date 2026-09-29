/**
 * Integration tests for task #4316 — PO receipt: package conversion, idempotency,
 * source metadata, and receipt-event counter.
 *
 * POST /api/purchase-orders/:id/receive
 *   1.  Happy path: receives stock, updates location stock, returns event_id.
 *   2.  Package conversion: received quantity (boxes) × package_qty (units/box) = inventory delta.
 *   3.  receive_action_id is required → 400.
 *   4.  Idempotent replay: same action_id + identical payload → 200 idempotent:true,
 *       receipt_event inserted exactly once.
 *   5.  Same action_id but different payload → 409 conflict.
 *   6.  Receiving blocked when PO status is not receivable (e.g. "draft") → 409.
 *   7.  Source metadata fields (source_type, source_id, reference_type, reference_id,
 *       metadata_snapshot) stored correctly on the stock adjustment row.
 *   8.  Receipt counter on the PO line increments only once on replay.
 *
 * Auth/workspace middleware is stubbed; the database is real.
 * Skips automatically when DATABASE_URL is not set.
 *
 * Run:
 *   bash artifacts/api-server/test-integration-local.sh \
 *     src/routes/purchaseOrders.receive4316.integration.test.ts
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

const OWNER_ID = "__integ_poreceive4316__";
const USER_ID  = "__integ_poreceive4316_user__";

// ─────────────────────────────────────────────────────────────────────────────
// Mocks
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  authed: (_req: express.Request) => ({ userId: USER_ID }),
}));

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as import("../lib/workspace").WorkspaceRequest;
    wreq.workspaceOwnerId    = OWNER_ID;
    wreq.workspaceRole       = "owner";
    wreq.workspaceActualRole = "owner";
    wreq.userId    = USER_ID;
    wreq.userEmail = "poreceive4316@example.com";
    next();
  },
  workspace: (req: express.Request) => req as unknown as import("../lib/workspace").WorkspaceRequest,
}));

vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

vi.mock("../lib/email", () => ({
  sendPurchaseOrderEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/translation", () => ({
  translateToArabic: vi.fn().mockResolvedValue(null),
}));

vi.mock("../lib/poPdf", () => ({
  buildPurchaseOrderPdf:      vi.fn().mockResolvedValue(Buffer.from("")),
  resolvePoPdfLineItemImages: vi.fn().mockResolvedValue([]),
  resolveChromiumPath:        vi.fn().mockResolvedValue("/usr/bin/chromium"),
}));

vi.mock("../lib/purchaseOrderMatching", () => ({
  computeThreeWayMatch: vi.fn().mockResolvedValue(undefined),
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

// ─────────────────────────────────────────────────────────────────────────────
// Router import (must come after vi.mock)
// ─────────────────────────────────────────────────────────────────────────────

import purchaseOrdersRouter from "./purchaseOrders";

// ─────────────────────────────────────────────────────────────────────────────
// App factory
// ─────────────────────────────────────────────────────────────────────────────

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api", purchaseOrdersRouter);
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err?.message ?? String(err) });
  });
  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!DATABASE_URL)(
  "PO receipt: package conversion, idempotency, source metadata — integration (task #4316)",
  () => {
    let pool: InstanceType<typeof Pool>;
    let app: express.Express;

    // Seed entities
    let supplierId: number;
    let locationId: number;
    let baseItemId: number;

    // ─────────────────────────────────────────────────────────────────────────
    // Setup / teardown
    // ─────────────────────────────────────────────────────────────────────────

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL });
      app  = makeApp();

      // Wipe leftovers
      await pool.query(
        `DELETE FROM purchase_order_receipt_events WHERE workspace_owner_id = $1`, [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM base_item_stock_adjustments WHERE workspace_owner_id = $1`, [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM purchase_orders WHERE workspace_owner_id = $1`, [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM base_item_location_statuses WHERE workspace_owner_id = $1`, [OWNER_ID],
      );
      await pool.query(`DELETE FROM base_items WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM locations WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM suppliers WHERE workspace_owner_id = $1`, [OWNER_ID]);

      // Seed supplier
      const sRes = await pool.query<{ id: number }>(
        `INSERT INTO suppliers (workspace_owner_id, name) VALUES ($1, 'Receive4316 Supplier') RETURNING id`,
        [OWNER_ID],
      );
      supplierId = sRes.rows[0].id;

      // Seed location
      const locRes = await pool.query<{ id: number }>(
        `INSERT INTO locations (workspace_owner_id, name, country) VALUES ($1, 'Receive4316 Loc', 'AE') RETURNING id`,
        [OWNER_ID],
      );
      locationId = locRes.rows[0].id;

      // Seed base item
      const biRes = await pool.query<{ id: number }>(
        `INSERT INTO base_items (workspace_owner_id, name, code, status, stock)
         VALUES ($1, 'Receive4316 Item', 'RCV4316-001', 'active', 0) RETURNING id`,
        [OWNER_ID],
      );
      baseItemId = biRes.rows[0].id;

      // Seed location status (is_active = true)
      await pool.query(
        `INSERT INTO base_item_location_statuses (workspace_owner_id, base_item_id, location_id, is_active, stock)
         VALUES ($1, $2, $3, true, 0)`,
        [OWNER_ID, baseItemId, locationId],
      );
    });

    afterAll(async () => {
      if (!pool) return;
      await pool.query(
        `DELETE FROM purchase_order_receipt_events WHERE workspace_owner_id = $1`, [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM base_item_stock_adjustments WHERE workspace_owner_id = $1`, [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM purchase_orders WHERE workspace_owner_id = $1`, [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM base_item_location_statuses WHERE workspace_owner_id = $1`, [OWNER_ID],
      );
      await pool.query(`DELETE FROM base_items WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM locations WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM suppliers WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.end();
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Helper: create a PO with one line item linked to baseItemId, set status
    // to supplier_accepted so we can receive against it.
    // ─────────────────────────────────────────────────────────────────────────

    async function createReceivablePo(opts: {
      quantity?: number;
      packageQty?: number | null;
    } = {}): Promise<{ poId: number; lineItemId: number }> {
      const qty = opts.quantity ?? 10;

      const poRes = await pool.query<{ id: number }>(
        `INSERT INTO purchase_orders
           (workspace_owner_id, supplier_id, location_id, status, currency, created_at, updated_at)
         VALUES ($1, $2, $3, 'supplier_accepted', 'AED', now(), now())
         RETURNING id`,
        [OWNER_ID, supplierId, locationId],
      );
      const poId = poRes.rows[0].id;

      const liRes = await pool.query<{ id: number }>(
        `INSERT INTO purchase_order_line_items
           (purchase_order_id, base_item_id, description, quantity, unit_price, currency,
            package_quantity, created_at, updated_at)
         VALUES ($1, $2, 'Test Line Item', $3, 10.00, 'AED', $4, now(), now())
         RETURNING id`,
        [poId, baseItemId, qty, opts.packageQty ?? null],
      );
      const lineItemId = liRes.rows[0].id;

      return { poId, lineItemId };
    }

    async function resetItemStock(): Promise<void> {
      await pool.query(
        `UPDATE base_item_location_statuses SET stock = 0 WHERE base_item_id = $1`,
        [baseItemId],
      );
      await pool.query(`UPDATE base_items SET stock = 0 WHERE id = $1`, [baseItemId]);
      await pool.query(
        `DELETE FROM base_item_stock_adjustments WHERE workspace_owner_id = $1`, [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM purchase_order_receipt_events WHERE workspace_owner_id = $1`, [OWNER_ID],
      );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test 1 – Happy path
    // ─────────────────────────────────────────────────────────────────────────

    it("happy path: receives stock, updates location stock, returns event_id", async () => {
      const { poId, lineItemId } = await createReceivablePo({ quantity: 10 });

      try {
        const actionId = randomUUID();
        const res = await request(app)
          .post(`/api/purchase-orders/${poId}/receive`)
          .send({
            location_id: locationId,
            receive_action_id: actionId,
            receipts: [{ line_item_id: lineItemId, quantity: 5 }],
          });

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.received)).toBe(true);
        expect(res.body.received).toHaveLength(1);
        expect(res.body.received[0].line_item_id).toBe(lineItemId);
        expect(typeof res.body.event_id).toBe("string");

        // Location stock should be 5
        const locRow = await pool.query<{ stock: string }>(
          `SELECT stock FROM base_item_location_statuses WHERE base_item_id = $1 AND location_id = $2`,
          [baseItemId, locationId],
        );
        expect(Number(locRow.rows[0].stock)).toBe(5);
      } finally {
        await pool.query(`DELETE FROM purchase_orders WHERE id = $1`, [poId]);
        await resetItemStock();
      }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Test 2 – Package conversion
    // ─────────────────────────────────────────────────────────────────────────

    it("package conversion: received_qty × package_qty = inventory delta", async () => {
      // packageQty = 20 (e.g. box of 20 units); receiving 3 boxes → +60 units
      const { poId, lineItemId } = await createReceivablePo({ quantity: 10, packageQty: 20 });

      try {
        const actionId = randomUUID();
        const res = await request(app)
          .post(`/api/purchase-orders/${poId}/receive`)
          .send({
            location_id: locationId,
            receive_action_id: actionId,
            receipts: [{ line_item_id: lineItemId, quantity: 3 }],
          });

        expect(res.status).toBe(200);

        // 3 boxes × 20 units = 60 inventory units added
        const locRow = await pool.query<{ stock: string }>(
          `SELECT stock FROM base_item_location_statuses WHERE base_item_id = $1 AND location_id = $2`,
          [baseItemId, locationId],
        );
        expect(Number(locRow.rows[0].stock)).toBe(60);

        // Verify metadata_snapshot stores supplier qty and canonical qty
        const adjRow = await pool.query<{ metadata_snapshot: unknown }>(
          `SELECT metadata_snapshot FROM base_item_stock_adjustments
            WHERE workspace_owner_id = $1 AND base_item_id = $2
            ORDER BY created_at DESC LIMIT 1`,
          [OWNER_ID, baseItemId],
        );
        expect(adjRow.rowCount).toBe(1);
        const meta = adjRow.rows[0].metadata_snapshot as Record<string, unknown>;
        expect(meta.supplierQuantity).toBe(3);
        expect(meta.packageQuantity).toBe(20);
        expect(meta.canonicalQuantity).toBe(60);
      } finally {
        await pool.query(`DELETE FROM purchase_orders WHERE id = $1`, [poId]);
        await resetItemStock();
      }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Test 3 – receive_action_id is required
    // ─────────────────────────────────────────────────────────────────────────

    it("missing receive_action_id → 400", async () => {
      const { poId, lineItemId } = await createReceivablePo();

      try {
        const res = await request(app)
          .post(`/api/purchase-orders/${poId}/receive`)
          .send({
            location_id: locationId,
            // no receive_action_id
            receipts: [{ line_item_id: lineItemId, quantity: 1 }],
          });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/receive_action_id is required/i);
      } finally {
        await pool.query(`DELETE FROM purchase_orders WHERE id = $1`, [poId]);
      }
    });

    it("non-UUID receive_action_id → 400", async () => {
      const { poId, lineItemId } = await createReceivablePo();

      try {
        const res = await request(app)
          .post(`/api/purchase-orders/${poId}/receive`)
          .send({
            location_id: locationId,
            receive_action_id: "bad-id",
            receipts: [{ line_item_id: lineItemId, quantity: 1 }],
          });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/receive_action_id is required/i);
      } finally {
        await pool.query(`DELETE FROM purchase_orders WHERE id = $1`, [poId]);
      }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Test 4 – Idempotent replay: receipt_event inserted exactly once
    // ─────────────────────────────────────────────────────────────────────────

    it("idempotent replay: same action_id + identical payload → 200 idempotent:true, event created once", async () => {
      const { poId, lineItemId } = await createReceivablePo({ quantity: 10 });

      try {
        const actionId = randomUUID();
        const body = {
          location_id: locationId,
          receive_action_id: actionId,
          receipts: [{ line_item_id: lineItemId, quantity: 4 }],
        };

        // First call
        const first = await request(app).post(`/api/purchase-orders/${poId}/receive`).send(body);
        expect(first.status).toBe(200);
        const eventId = first.body.event_id;
        expect(typeof eventId).toBe("string");

        // Replay
        const second = await request(app).post(`/api/purchase-orders/${poId}/receive`).send(body);
        expect(second.status).toBe(200);
        expect(second.body.idempotent).toBe(true);
        expect(second.body.event_id).toBe(eventId);

        // receipt_event inserted exactly once
        const eventCount = await pool.query<{ cnt: string }>(
          `SELECT COUNT(*)::text AS cnt FROM purchase_order_receipt_events
            WHERE workspace_owner_id = $1 AND receive_action_id = $2`,
          [OWNER_ID, actionId],
        );
        expect(Number(eventCount.rows[0].cnt)).toBe(1);

        // Stock must be 4 (not 8)
        const locRow = await pool.query<{ stock: string }>(
          `SELECT stock FROM base_item_location_statuses WHERE base_item_id = $1 AND location_id = $2`,
          [baseItemId, locationId],
        );
        expect(Number(locRow.rows[0].stock)).toBe(4);
      } finally {
        await pool.query(`DELETE FROM purchase_orders WHERE id = $1`, [poId]);
        await resetItemStock();
      }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Test 5 – Changed payload → 409
    // ─────────────────────────────────────────────────────────────────────────

    it("same receive_action_id but different payload → 409 conflict", async () => {
      const { poId, lineItemId } = await createReceivablePo({ quantity: 10 });

      try {
        const actionId = randomUUID();
        const first = await request(app)
          .post(`/api/purchase-orders/${poId}/receive`)
          .send({
            location_id: locationId,
            receive_action_id: actionId,
            receipts: [{ line_item_id: lineItemId, quantity: 2 }],
          });
        expect(first.status).toBe(200);

        // Same actionId but different quantity
        const second = await request(app)
          .post(`/api/purchase-orders/${poId}/receive`)
          .send({
            location_id: locationId,
            receive_action_id: actionId,
            receipts: [{ line_item_id: lineItemId, quantity: 9 }], // changed
          });
        expect(second.status).toBe(409);
        expect(second.body.error).toMatch(/already used with a different payload/i);
      } finally {
        await pool.query(`DELETE FROM purchase_orders WHERE id = $1`, [poId]);
        await resetItemStock();
      }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Test 6 – Blocked when PO status is not receivable
    // ─────────────────────────────────────────────────────────────────────────

    it("returns 409 when PO is not in a receivable status (draft)", async () => {
      const poRes = await pool.query<{ id: number }>(
        `INSERT INTO purchase_orders
           (workspace_owner_id, supplier_id, location_id, status, currency, created_at, updated_at)
         VALUES ($1, $2, $3, 'draft', 'AED', now(), now())
         RETURNING id`,
        [OWNER_ID, supplierId, locationId],
      );
      const draftPoId = poRes.rows[0].id;

      const liRes = await pool.query<{ id: number }>(
        `INSERT INTO purchase_order_line_items
           (purchase_order_id, base_item_id, description, quantity, unit_price, currency, created_at, updated_at)
         VALUES ($1, $2, 'Draft Line', 10, 5.00, 'AED', now(), now())
         RETURNING id`,
        [draftPoId, baseItemId],
      );
      const lineItemId = liRes.rows[0].id;

      try {
        const res = await request(app)
          .post(`/api/purchase-orders/${draftPoId}/receive`)
          .send({
            location_id: locationId,
            receive_action_id: randomUUID(),
            receipts: [{ line_item_id: lineItemId, quantity: 1 }],
          });

        expect(res.status).toBe(409);
        expect(res.body.code).toBe("acceptance_required");
      } finally {
        await pool.query(`DELETE FROM purchase_orders WHERE id = $1`, [draftPoId]);
      }
    });

    it("revalidates status under row lock and cannot receive after a concurrent cancellation", async () => {
      const { poId, lineItemId } = await createReceivablePo({ quantity: 10 });
      const blocker = await pool.connect();
      try {
        await blocker.query("BEGIN");
        await blocker.query(
          `UPDATE purchase_orders SET status = 'cancelled' WHERE id = $1`,
          [poId],
        );

        const responsePromise = request(app)
          .post(`/api/purchase-orders/${poId}/receive`)
          .send({
            location_id: locationId,
            receive_action_id: randomUUID(),
            receipts: [{ line_item_id: lineItemId, quantity: 2 }],
          })
          .then((response) => response);

        await new Promise((resolve) => setTimeout(resolve, 50));
        await blocker.query("COMMIT");
        const response = await responsePromise;

        expect(response.status).toBe(409);
        expect(response.body.code).toBe("acceptance_required");
        const receiptCount = await pool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count
             FROM purchase_order_receipt_events
            WHERE purchase_order_id = $1`,
          [poId],
        );
        expect(Number(receiptCount.rows[0].count)).toBe(0);
      } finally {
        try {
          await blocker.query("ROLLBACK");
        } catch {
          // Transaction already committed.
        }
        blocker.release();
        await pool.query(`DELETE FROM purchase_orders WHERE id = $1`, [poId]);
        await resetItemStock();
      }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Test 7 – Source metadata fields on the adjustment row
    // ─────────────────────────────────────────────────────────────────────────

    it("adjustment row stores source_type, source_id, reference_type, reference_id, metadata_snapshot", async () => {
      const { poId, lineItemId } = await createReceivablePo({ quantity: 10 });

      try {
        const actionId = randomUUID();
        const res = await request(app)
          .post(`/api/purchase-orders/${poId}/receive`)
          .send({
            location_id: locationId,
            receive_action_id: actionId,
            receipts: [{ line_item_id: lineItemId, quantity: 3 }],
          });
        expect(res.status).toBe(200);
        const eventId = res.body.event_id;

        const adjRow = await pool.query<{
          source_type: string;
          source_id: string;
          reference_type: string;
          reference_id: string;
          metadata_snapshot: unknown;
          movement_type: string;
        }>(
          `SELECT source_type, source_id, reference_type, reference_id,
                  metadata_snapshot, movement_type
             FROM base_item_stock_adjustments
            WHERE workspace_owner_id = $1 AND base_item_id = $2
            ORDER BY created_at DESC LIMIT 1`,
          [OWNER_ID, baseItemId],
        );
        expect(adjRow.rowCount).toBe(1);
        const row = adjRow.rows[0];
        expect(row.movement_type).toBe("purchase_order_receipt");
        expect(row.source_type).toBe("purchase_order_receipt");
        expect(row.source_id).toBe(eventId);
        expect(row.reference_type).toBe("purchase_order");
        expect(row.reference_id).toBe(String(poId));
        const meta = row.metadata_snapshot as Record<string, unknown>;
        expect(meta.receiveActionId).toBe(actionId);
        expect(meta.receiptEventId).toBe(eventId);
        expect(meta.purchaseOrderLineItemId).toBe(lineItemId);
      } finally {
        await pool.query(`DELETE FROM purchase_orders WHERE id = $1`, [poId]);
        await resetItemStock();
      }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Test 8 – Receipt counter on PO line increments only once on replay
    // ─────────────────────────────────────────────────────────────────────────

    it("receipt counter on PO line increments exactly once on idempotent replay", async () => {
      const { poId, lineItemId } = await createReceivablePo({ quantity: 10 });

      try {
        const actionId = randomUUID();
        const body = {
          location_id: locationId,
          receive_action_id: actionId,
          receipts: [{ line_item_id: lineItemId, quantity: 6 }],
        };

        await request(app).post(`/api/purchase-orders/${poId}/receive`).send(body);
        await request(app).post(`/api/purchase-orders/${poId}/receive`).send(body); // replay

        const liRow = await pool.query<{ received_quantity: string }>(
          `SELECT received_quantity FROM purchase_order_line_items WHERE id = $1`,
          [lineItemId],
        );
        // Should be 6, not 12
        expect(Number(liRow.rows[0].received_quantity)).toBe(6);
      } finally {
        await pool.query(`DELETE FROM purchase_orders WHERE id = $1`, [poId]);
        await resetItemStock();
      }
    });
  },
);
