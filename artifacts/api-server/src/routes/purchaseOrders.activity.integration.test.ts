/**
 * Integration tests — purchase order activity log entries
 *
 * Verifies that the three mutating line-item handlers actually write rows into
 * purchase_order_activity with the correct event_type, description text, and
 * metadata JSON.  The database is real (PostgreSQL via DATABASE_URL); the suite
 * skips automatically when DATABASE_URL is not set.
 *
 * Covered:
 *   - POST   /purchase-orders/:id/line-items  → po_line_item_added
 *   - PATCH  /purchase-orders/:id/line-items/:lineItemId  → po_line_item_updated
 *   - DELETE /purchase-orders/:id/line-items/:lineItemId  → po_line_item_removed
 *   - POST   /purchase-orders  → po_created
 *   - PATCH  /purchase-orders/:id  (status change) → po_status_changed
 *   - POST   /purchase-orders/:id/receive  → po_received
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import pg from "pg";
import type { WorkspaceRequest } from "../lib/workspace";
import type { WorkspaceRole } from "./integrationTestTypes";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;

// ─────────────────────────────────────────────────────────────────────────────
// Unique owner ID so tests never collide with real workspace data
// ─────────────────────────────────────────────────────────────────────────────

const OWNER_ID = "__integration_test_po_activity__";
const USER_ID = "__integration_test_po_activity_user__";

// ─────────────────────────────────────────────────────────────────────────────
// Mocks — auth / workspace / logger / email only. db is NOT mocked.
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
  authed: (req: express.Request) => ({ ...req, userId: USER_ID }),
}));

let currentRole: WorkspaceRole = "owner";

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = OWNER_ID;
    wreq.workspaceRole = currentRole;
    wreq.workspaceActualRole = currentRole;
    wreq.userId = USER_ID;
    wreq.userEmail = "po-activity-test@example.com";
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

vi.mock("@clerk/express", () => ({
  clerkClient: {
    users: {
      getUserList: vi.fn().mockResolvedValue({ data: [] }),
    },
  },
}));

vi.mock("../lib/email", () => ({
  sendPurchaseOrderEmail: vi.fn().mockResolvedValue(undefined),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Import the router AFTER vi.mock declarations (hoisting boundary)
// ─────────────────────────────────────────────────────────────────────────────

import purchaseOrdersRouter from "./purchaseOrders";
import { sendPurchaseOrderEmail } from "../lib/email";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(purchaseOrdersRouter);
  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      console.error("TEST APP ERROR:", err?.message, err?.stack?.split("\n")[1]);
      res.status(500).json({ error: err?.message ?? "Internal server error" });
    },
  );
  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
// Type for rows read back from purchase_order_activity
// ─────────────────────────────────────────────────────────────────────────────

interface ActivityRow {
  id: number;
  purchase_order_id: number;
  workspace_owner_id: string;
  event_type: string;
  description: string;
  metadata: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!DATABASE_URL)(
  "PO activity log integration tests",
  () => {
    let pool: InstanceType<typeof Pool>;
    let app: express.Express;
    let supplierId: number;
    let locationId: number;

    beforeAll(async () => {
      currentRole = "owner";
      pool = new Pool({ connectionString: DATABASE_URL });
      app = makeApp();

      // Wipe any leftovers from a previous failed run
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

      // Seed location and supplier
      const loc = await pool.query<{ id: number }>(
        `INSERT INTO locations (workspace_owner_id, name) VALUES ($1, 'Activity Test Location') RETURNING id`,
        [OWNER_ID],
      );
      locationId = loc.rows[0].id;

      const sup = await pool.query<{ id: number }>(
        `INSERT INTO suppliers (workspace_owner_id, name)
         VALUES ($1, 'Activity Test Supplier') RETURNING id`,
        [OWNER_ID],
      );
      supplierId = sup.rows[0].id;
    });

    afterAll(async () => {
      if (!pool) return;
      // Cascade: deleting supplier removes purchase_orders and their activity rows
      await pool.query(
        `DELETE FROM suppliers WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM locations WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      await pool.end();
    });

    // ─────────────────────────────────────────────────────────────────────
    // POST /purchase-orders/:id/line-items → po_line_item_added
    // ─────────────────────────────────────────────────────────────────────

    describe("POST /purchase-orders/:id/line-items writes po_line_item_added activity", () => {
      let poId: number;
      let lineItemId: number;

      beforeAll(async () => {
        const pr = await pool.query<{ id: number }>(
          `INSERT INTO purchase_orders (workspace_owner_id, supplier_id, status, currency)
           VALUES ($1, $2, 'draft', 'AED') RETURNING id`,
          [OWNER_ID, supplierId],
        );
        poId = pr.rows[0].id;
      });

      afterAll(async () => {
        await pool.query(`DELETE FROM purchase_orders WHERE id = $1`, [poId]);
      });

      it("inserts exactly one po_line_item_added row after adding a line item", async () => {
        const res = await request(app)
          .post(`/purchase-orders/${poId}/line-items`)
          .send({ description: "Widget Alpha", quantity: "5", unit_price: "12.00", currency: "AED" });

        expect(res.status).toBe(201);
        lineItemId = res.body.line_item.id;

        const activity = await pool.query<ActivityRow>(
          `SELECT * FROM purchase_order_activity
             WHERE purchase_order_id = $1 AND event_type = 'po_line_item_added'
             ORDER BY created_at DESC LIMIT 1`,
          [poId],
        );
        expect(activity.rowCount).toBe(1);
      });

      it("activity row has the correct workspace_owner_id", async () => {
        const activity = await pool.query<ActivityRow>(
          `SELECT * FROM purchase_order_activity
             WHERE purchase_order_id = $1 AND event_type = 'po_line_item_added'`,
          [poId],
        );
        expect(activity.rows[0].workspace_owner_id).toBe(OWNER_ID);
      });

      it("activity description mentions the item name, quantity, and unit price", async () => {
        const activity = await pool.query<ActivityRow>(
          `SELECT description FROM purchase_order_activity
             WHERE purchase_order_id = $1 AND event_type = 'po_line_item_added'`,
          [poId],
        );
        const desc = activity.rows[0].description;
        expect(desc).toContain("Widget Alpha");
        expect(desc).toContain("5");
        expect(desc).toContain("12");
      });

      it("metadata contains line_item_id, description, quantity, unit_price, currency, and added_by", async () => {
        const activity = await pool.query<ActivityRow>(
          `SELECT metadata FROM purchase_order_activity
             WHERE purchase_order_id = $1 AND event_type = 'po_line_item_added'`,
          [poId],
        );
        const meta = activity.rows[0].metadata;
        expect(meta.line_item_id).toBe(lineItemId);
        expect(meta.description).toBe("Widget Alpha");
        expect(Number(meta.quantity)).toBe(5);
        expect(Number(meta.unit_price)).toBeCloseTo(12, 2);
        expect(meta.currency).toBe("AED");
        expect(meta.added_by).toBe(USER_ID);
      });
    });

    // ─────────────────────────────────────────────────────────────────────
    // PATCH /purchase-orders/:id/line-items/:lineItemId → po_line_item_updated
    // ─────────────────────────────────────────────────────────────────────

    describe("PATCH /purchase-orders/:id/line-items/:lineItemId writes po_line_item_updated activity", () => {
      let poId: number;
      let lineItemId: number;

      beforeAll(async () => {
        const pr = await pool.query<{ id: number }>(
          `INSERT INTO purchase_orders (workspace_owner_id, supplier_id, status, currency)
           VALUES ($1, $2, 'draft', 'AED') RETURNING id`,
          [OWNER_ID, supplierId],
        );
        poId = pr.rows[0].id;

        // Add a line item to update later
        const li = await pool.query<{ id: number }>(
          `INSERT INTO purchase_order_line_items (purchase_order_id, description, quantity, unit_price, currency)
           VALUES ($1, 'Widget Beta', 3, 20.00, 'AED') RETURNING id`,
          [poId],
        );
        lineItemId = li.rows[0].id;
      });

      afterAll(async () => {
        await pool.query(`DELETE FROM purchase_orders WHERE id = $1`, [poId]);
      });

      it("inserts exactly one po_line_item_updated row after updating a line item", async () => {
        const res = await request(app)
          .patch(`/purchase-orders/${poId}/line-items/${lineItemId}`)
          .send({ quantity: "10", unit_price: "25.00" });

        expect(res.status).toBe(200);

        const activity = await pool.query<ActivityRow>(
          `SELECT * FROM purchase_order_activity
             WHERE purchase_order_id = $1 AND event_type = 'po_line_item_updated'
             ORDER BY created_at DESC LIMIT 1`,
          [poId],
        );
        expect(activity.rowCount).toBe(1);
      });

      it("activity description mentions the item name", async () => {
        const activity = await pool.query<ActivityRow>(
          `SELECT description FROM purchase_order_activity
             WHERE purchase_order_id = $1 AND event_type = 'po_line_item_updated'`,
          [poId],
        );
        expect(activity.rows[0].description).toContain("Widget Beta");
      });

      it("metadata contains line_item_id, description, before, after, and updated_by", async () => {
        const activity = await pool.query<ActivityRow>(
          `SELECT metadata FROM purchase_order_activity
             WHERE purchase_order_id = $1 AND event_type = 'po_line_item_updated'`,
          [poId],
        );
        const meta = activity.rows[0].metadata;
        expect(meta.line_item_id).toBe(lineItemId);
        expect(meta.description).toBe("Widget Beta");
        expect(meta.updated_by).toBe(USER_ID);

        const before = meta.before as Record<string, unknown>;
        expect(Number(before.quantity)).toBeCloseTo(3, 2);
        expect(Number(before.unit_price)).toBeCloseTo(20, 2);
        expect(before.currency).toBe("AED");

        const after = meta.after as Record<string, unknown>;
        expect(Number(after.quantity)).toBeCloseTo(10, 2);
        expect(Number(after.unit_price)).toBeCloseTo(25, 2);
        expect(after.currency).toBe("AED");
      });

      it("before/after fields correctly reflect the old and new values", async () => {
        // Add a second update so we can verify before is the state after the first update
        const res = await request(app)
          .patch(`/purchase-orders/${poId}/line-items/${lineItemId}`)
          .send({ quantity: "1" });

        expect(res.status).toBe(200);

        const activity = await pool.query<ActivityRow>(
          `SELECT metadata FROM purchase_order_activity
             WHERE purchase_order_id = $1 AND event_type = 'po_line_item_updated'
             ORDER BY created_at DESC LIMIT 1`,
          [poId],
        );
        const meta = activity.rows[0].metadata;
        const before = meta.before as Record<string, unknown>;
        const after = meta.after as Record<string, unknown>;

        // before should reflect state after first update (qty=10, price=25)
        expect(Number(before.quantity)).toBeCloseTo(10, 2);
        expect(Number(before.unit_price)).toBeCloseTo(25, 2);
        // after should reflect the new state (qty=1, price unchanged=25)
        expect(Number(after.quantity)).toBeCloseTo(1, 2);
        expect(Number(after.unit_price)).toBeCloseTo(25, 2);
      });
    });

    // ─────────────────────────────────────────────────────────────────────
    // DELETE /purchase-orders/:id/line-items/:lineItemId → po_line_item_removed
    // ─────────────────────────────────────────────────────────────────────

    describe("DELETE /purchase-orders/:id/line-items/:lineItemId writes po_line_item_removed activity", () => {
      let poId: number;
      let lineItemId: number;

      beforeAll(async () => {
        const pr = await pool.query<{ id: number }>(
          `INSERT INTO purchase_orders (workspace_owner_id, supplier_id, status, currency)
           VALUES ($1, $2, 'draft', 'AED') RETURNING id`,
          [OWNER_ID, supplierId],
        );
        poId = pr.rows[0].id;

        const li = await pool.query<{ id: number }>(
          `INSERT INTO purchase_order_line_items (purchase_order_id, description, quantity, unit_price, currency)
           VALUES ($1, 'Widget Gamma', 7, 50.00, 'AED') RETURNING id`,
          [poId],
        );
        lineItemId = li.rows[0].id;
      });

      afterAll(async () => {
        await pool.query(`DELETE FROM purchase_orders WHERE id = $1`, [poId]);
      });

      it("inserts exactly one po_line_item_removed row after deleting a line item", async () => {
        const res = await request(app)
          .delete(`/purchase-orders/${poId}/line-items/${lineItemId}`);

        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);

        const activity = await pool.query<ActivityRow>(
          `SELECT * FROM purchase_order_activity
             WHERE purchase_order_id = $1 AND event_type = 'po_line_item_removed'
             ORDER BY created_at DESC LIMIT 1`,
          [poId],
        );
        expect(activity.rowCount).toBe(1);
      });

      it("activity description mentions the deleted item name, quantity, and unit price", async () => {
        const activity = await pool.query<ActivityRow>(
          `SELECT description FROM purchase_order_activity
             WHERE purchase_order_id = $1 AND event_type = 'po_line_item_removed'`,
          [poId],
        );
        const desc = activity.rows[0].description;
        expect(desc).toContain("Widget Gamma");
        expect(desc).toContain("7");
        expect(desc).toContain("50");
      });

      it("metadata contains line_item_id, description, quantity, unit_price, currency, and removed_by", async () => {
        const activity = await pool.query<ActivityRow>(
          `SELECT metadata FROM purchase_order_activity
             WHERE purchase_order_id = $1 AND event_type = 'po_line_item_removed'`,
          [poId],
        );
        const meta = activity.rows[0].metadata;
        expect(meta.line_item_id).toBe(lineItemId);
        expect(meta.description).toBe("Widget Gamma");
        expect(Number(meta.quantity)).toBeCloseTo(7, 2);
        expect(Number(meta.unit_price)).toBeCloseTo(50, 2);
        expect(meta.currency).toBe("AED");
        expect(meta.removed_by).toBe(USER_ID);
      });

      it("the line item no longer exists in the database after deletion", async () => {
        const liCheck = await pool.query(
          `SELECT id FROM purchase_order_line_items WHERE id = $1`,
          [lineItemId],
        );
        expect(liCheck.rowCount).toBe(0);
      });
    });

    // ─────────────────────────────────────────────────────────────────────
    // POST /purchase-orders → po_created
    // ─────────────────────────────────────────────────────────────────────

    describe("POST /purchase-orders writes po_created activity", () => {
      let poId: number;

      afterAll(async () => {
        if (poId) {
          await pool.query(`DELETE FROM purchase_orders WHERE id = $1`, [poId]);
        }
      });

      it("inserts exactly one po_created row after creating a purchase order", async () => {
        const res = await request(app)
          .post(`/purchase-orders`)
          .send({
            supplier_id: supplierId,
            location_id: locationId,
            currency: "AED",
            line_items: [
              { description: "Widget Delta", quantity: "4", unit_price: "15.00", currency: "AED" },
              { description: "Widget Epsilon", quantity: "2", unit_price: "30.00", currency: "AED" },
            ],
          });

        expect(res.status).toBe(201);
        poId = res.body.purchase_order.id;

        const activity = await pool.query<ActivityRow>(
          `SELECT * FROM purchase_order_activity
             WHERE purchase_order_id = $1 AND event_type = 'po_created'`,
          [poId],
        );
        expect(activity.rowCount).toBe(1);
      });

      it("activity row has the correct workspace_owner_id", async () => {
        const activity = await pool.query<ActivityRow>(
          `SELECT workspace_owner_id FROM purchase_order_activity
             WHERE purchase_order_id = $1 AND event_type = 'po_created'`,
          [poId],
        );
        expect(activity.rows[0].workspace_owner_id).toBe(OWNER_ID);
      });

      it("activity description mentions the line item count", async () => {
        const activity = await pool.query<ActivityRow>(
          `SELECT description FROM purchase_order_activity
             WHERE purchase_order_id = $1 AND event_type = 'po_created'`,
          [poId],
        );
        const desc = activity.rows[0].description;
        expect(desc).toContain("created");
        expect(desc).toContain("2");
      });

      it("metadata contains created_by, supplier_id, location_id, status, currency, and line_items_count", async () => {
        const activity = await pool.query<ActivityRow>(
          `SELECT metadata FROM purchase_order_activity
             WHERE purchase_order_id = $1 AND event_type = 'po_created'`,
          [poId],
        );
        const meta = activity.rows[0].metadata;
        expect(meta.created_by).toBe(USER_ID);
        expect(Number(meta.supplier_id)).toBe(supplierId);
        expect(Number(meta.location_id)).toBe(locationId);
        expect(meta.status).toBe("draft");
        expect(meta.currency).toBe("AED");
        expect(Number(meta.line_items_count)).toBe(2);
      });
    });

    // ─────────────────────────────────────────────────────────────────────
    // PATCH /purchase-orders/:id (status change) → po_status_changed
    // ─────────────────────────────────────────────────────────────────────

    describe("PATCH /purchase-orders/:id writes po_status_changed activity", () => {
      let poId: number;

      beforeAll(async () => {
        const pr = await pool.query<{ id: number }>(
          `INSERT INTO purchase_orders (workspace_owner_id, supplier_id, location_id, status, currency)
           VALUES ($1, $2, $3, 'draft', 'AED') RETURNING id`,
          [OWNER_ID, supplierId, locationId],
        );
        poId = pr.rows[0].id;
      });

      afterAll(async () => {
        await pool.query(`DELETE FROM purchase_orders WHERE id = $1`, [poId]);
      });

      it("inserts exactly one po_status_changed row after changing status", async () => {
        const res = await request(app)
          .patch(`/purchase-orders/${poId}`)
          .send({ status: "approved" });

        expect(res.status).toBe(200);

        const activity = await pool.query<ActivityRow>(
          `SELECT * FROM purchase_order_activity
             WHERE purchase_order_id = $1 AND event_type = 'po_status_changed'`,
          [poId],
        );
        expect(activity.rowCount).toBe(1);
      });

      it("activity row has the correct workspace_owner_id", async () => {
        const activity = await pool.query<ActivityRow>(
          `SELECT workspace_owner_id FROM purchase_order_activity
             WHERE purchase_order_id = $1 AND event_type = 'po_status_changed'`,
          [poId],
        );
        expect(activity.rows[0].workspace_owner_id).toBe(OWNER_ID);
      });

      it("activity description mentions the old and new status", async () => {
        const activity = await pool.query<ActivityRow>(
          `SELECT description FROM purchase_order_activity
             WHERE purchase_order_id = $1 AND event_type = 'po_status_changed'`,
          [poId],
        );
        const desc = activity.rows[0].description;
        expect(desc).toContain("draft");
        expect(desc).toContain("approved");
      });

      it("metadata contains from, to, and changed_by", async () => {
        const activity = await pool.query<ActivityRow>(
          `SELECT metadata FROM purchase_order_activity
             WHERE purchase_order_id = $1 AND event_type = 'po_status_changed'`,
          [poId],
        );
        const meta = activity.rows[0].metadata;
        expect(meta.from).toBe("draft");
        expect(meta.to).toBe("approved");
        expect(meta.changed_by).toBe(USER_ID);
      });

      it("does NOT insert a po_status_changed row when status is unchanged", async () => {
        const res = await request(app)
          .patch(`/purchase-orders/${poId}`)
          .send({ notes: "just a note, no status change" });

        expect(res.status).toBe(200);

        const activity = await pool.query<ActivityRow>(
          `SELECT * FROM purchase_order_activity
             WHERE purchase_order_id = $1 AND event_type = 'po_status_changed'`,
          [poId],
        );
        // Still only the single row from the earlier status change
        expect(activity.rowCount).toBe(1);
      });
    });

    // ─────────────────────────────────────────────────────────────────────
    // POST /purchase-orders/:id/receive → po_received
    // ─────────────────────────────────────────────────────────────────────

    describe("POST /purchase-orders/:id/receive writes po_received activity", () => {
      let poId: number;
      let lineItemId: number;
      let baseItemId: number;

      beforeAll(async () => {
        const pr = await pool.query<{ id: number }>(
          `INSERT INTO purchase_orders (workspace_owner_id, supplier_id, location_id, status, currency)
           VALUES ($1, $2, $3, 'approved', 'AED') RETURNING id`,
          [OWNER_ID, supplierId, locationId],
        );
        poId = pr.rows[0].id;

        // Receiving requires the line item to be linked to a base item.
        const bi = await pool.query<{ id: number }>(
          `INSERT INTO base_items (workspace_owner_id, name, code)
           VALUES ($1, 'Activity Test Base Item', 'ACT-TEST-BASE-001') RETURNING id`,
          [OWNER_ID],
        );
        baseItemId = bi.rows[0].id;

        const li = await pool.query<{ id: number }>(
          `INSERT INTO purchase_order_line_items (purchase_order_id, base_item_id, description, quantity, unit_price, currency)
           VALUES ($1, $2, 'Widget Zeta', 8, 40.00, 'AED') RETURNING id`,
          [poId, baseItemId],
        );
        lineItemId = li.rows[0].id;
      });

      afterAll(async () => {
        await pool.query(`DELETE FROM purchase_orders WHERE id = $1`, [poId]);
        await pool.query(
          `DELETE FROM base_item_stock_adjustments WHERE base_item_id = $1`,
          [baseItemId],
        );
        await pool.query(
          `DELETE FROM base_item_location_statuses WHERE base_item_id = $1`,
          [baseItemId],
        );
        await pool.query(`DELETE FROM base_items WHERE id = $1`, [baseItemId]);
      });

      it("inserts exactly one po_received row after receiving stock", async () => {
        const res = await request(app)
          .post(`/purchase-orders/${poId}/receive`)
          .send({
            location_id: locationId,
            receipts: [{ line_item_id: lineItemId, quantity: 5 }],
          });

        expect(res.status).toBe(200);

        const activity = await pool.query<ActivityRow>(
          `SELECT * FROM purchase_order_activity
             WHERE purchase_order_id = $1 AND event_type = 'po_received'`,
          [poId],
        );
        expect(activity.rowCount).toBe(1);
      });

      it("activity row has the correct workspace_owner_id", async () => {
        const activity = await pool.query<ActivityRow>(
          `SELECT workspace_owner_id FROM purchase_order_activity
             WHERE purchase_order_id = $1 AND event_type = 'po_received'`,
          [poId],
        );
        expect(activity.rows[0].workspace_owner_id).toBe(OWNER_ID);
      });

      it("activity description mentions the location name and received quantity", async () => {
        const activity = await pool.query<ActivityRow>(
          `SELECT description FROM purchase_order_activity
             WHERE purchase_order_id = $1 AND event_type = 'po_received'`,
          [poId],
        );
        const desc = activity.rows[0].description;
        expect(desc).toContain("Activity Test Location");
        expect(desc).toContain("5");
      });

      it("metadata contains location_id, location_name, received_by, and items", async () => {
        const activity = await pool.query<ActivityRow>(
          `SELECT metadata FROM purchase_order_activity
             WHERE purchase_order_id = $1 AND event_type = 'po_received'`,
          [poId],
        );
        const meta = activity.rows[0].metadata;
        expect(Number(meta.location_id)).toBe(locationId);
        expect(meta.location_name).toBe("Activity Test Location");
        expect(meta.received_by).toBe(USER_ID);

        const items = meta.items as Array<Record<string, unknown>>;
        expect(Array.isArray(items)).toBe(true);
        expect(items).toHaveLength(1);
        expect(Number(items[0].line_item_id)).toBe(lineItemId);
        expect(Number(items[0].base_item_id)).toBe(baseItemId);
        expect(Number(items[0].quantity_received)).toBe(5);
      });
    });

    // ─────────────────────────────────────────────────────────────────────
    // POST /purchase-orders/:id/send → po_sent
    // ─────────────────────────────────────────────────────────────────────

    describe("POST /purchase-orders/:id/send writes po_sent activity", () => {
      const SUPPLIER_EMAIL = "po-send-supplier@example.com";
      let poId: number;
      let emailSupplierId: number;

      beforeAll(async () => {
        // The send handler requires the supplier to have a contact_email,
        // so seed a dedicated supplier that has one.
        const sup = await pool.query<{ id: number }>(
          `INSERT INTO suppliers (workspace_owner_id, name, contact_email)
           VALUES ($1, 'Activity Test Send Supplier', $2) RETURNING id`,
          [OWNER_ID, SUPPLIER_EMAIL],
        );
        emailSupplierId = sup.rows[0].id;

        const pr = await pool.query<{ id: number }>(
          `INSERT INTO purchase_orders (workspace_owner_id, supplier_id, location_id, status, currency)
           VALUES ($1, $2, $3, 'approved', 'AED') RETURNING id`,
          [OWNER_ID, emailSupplierId, locationId],
        );
        poId = pr.rows[0].id;

        await pool.query(
          `INSERT INTO purchase_order_line_items (purchase_order_id, description, quantity, unit_price, currency)
           VALUES ($1, 'Widget Eta', 6, 35.00, 'AED')`,
          [poId],
        );

        // Reset the email spy so we can assert it is called exactly once
        // when the send below succeeds.
        vi.mocked(sendPurchaseOrderEmail).mockClear();
      });

      afterAll(async () => {
        await pool.query(`DELETE FROM purchase_orders WHERE id = $1`, [poId]);
        await pool.query(`DELETE FROM suppliers WHERE id = $1`, [emailSupplierId]);
      });

      it("inserts exactly one po_sent row after sending the purchase order", async () => {
        const res = await request(app).post(`/purchase-orders/${poId}/send`).send({});

        expect(res.status).toBe(200);

        const activity = await pool.query<ActivityRow>(
          `SELECT * FROM purchase_order_activity
             WHERE purchase_order_id = $1 AND event_type = 'po_sent'`,
          [poId],
        );
        expect(activity.rowCount).toBe(1);
      });

      it("activity row has the correct workspace_owner_id", async () => {
        const activity = await pool.query<ActivityRow>(
          `SELECT workspace_owner_id FROM purchase_order_activity
             WHERE purchase_order_id = $1 AND event_type = 'po_sent'`,
          [poId],
        );
        expect(activity.rows[0].workspace_owner_id).toBe(OWNER_ID);
      });

      it("activity description mentions the supplier email", async () => {
        const activity = await pool.query<ActivityRow>(
          `SELECT description FROM purchase_order_activity
             WHERE purchase_order_id = $1 AND event_type = 'po_sent'`,
          [poId],
        );
        expect(activity.rows[0].description).toContain(SUPPLIER_EMAIL);
      });

      it("metadata contains to_email and sent_by", async () => {
        const activity = await pool.query<ActivityRow>(
          `SELECT metadata FROM purchase_order_activity
             WHERE purchase_order_id = $1 AND event_type = 'po_sent'`,
          [poId],
        );
        const meta = activity.rows[0].metadata;
        expect(meta.to_email).toBe(SUPPLIER_EMAIL);
        expect(meta.sent_by).toBe(USER_ID);
      });

      it("calls sendPurchaseOrderEmail exactly once with the correct payload", () => {
        // The successful send happened in the first test of this block; the
        // spy was cleared in beforeAll so it reflects only that send.
        expect(sendPurchaseOrderEmail).toHaveBeenCalledTimes(1);

        // Seeded line item: quantity 6 × unit_price 35.00 = 210, rounded to 4dp.
        expect(sendPurchaseOrderEmail).toHaveBeenCalledWith(
          expect.objectContaining({
            toEmail: SUPPLIER_EMAIL,
            poNumberLabel: expect.stringContaining(String(poId)),
            supplierName: "Activity Test Send Supplier",
            locationName: "Activity Test Location",
            currency: "AED",
            effectiveTotal: "210.0000",
          }),
        );
      });
    });

    // ─────────────────────────────────────────────────────────────────────
    // POST /purchase-orders/:id/send — guardrail: supplier has no contact email
    // ─────────────────────────────────────────────────────────────────────

    describe("POST /purchase-orders/:id/send rejects when supplier has no contact email", () => {
      let poId: number;
      let noEmailSupplierId: number;

      beforeAll(async () => {
        // Seed a supplier WITHOUT a contact_email so the send guardrail fires.
        const sup = await pool.query<{ id: number }>(
          `INSERT INTO suppliers (workspace_owner_id, name)
           VALUES ($1, 'Activity Test No-Email Supplier') RETURNING id`,
          [OWNER_ID],
        );
        noEmailSupplierId = sup.rows[0].id;

        const pr = await pool.query<{ id: number }>(
          `INSERT INTO purchase_orders (workspace_owner_id, supplier_id, location_id, status, currency)
           VALUES ($1, $2, $3, 'approved', 'AED') RETURNING id`,
          [OWNER_ID, noEmailSupplierId, locationId],
        );
        poId = pr.rows[0].id;

        await pool.query(
          `INSERT INTO purchase_order_line_items (purchase_order_id, description, quantity, unit_price, currency)
           VALUES ($1, 'Widget Theta', 2, 40.00, 'AED')`,
          [poId],
        );
      });

      afterAll(async () => {
        await pool.query(`DELETE FROM purchase_orders WHERE id = $1`, [poId]);
        await pool.query(`DELETE FROM suppliers WHERE id = $1`, [noEmailSupplierId]);
      });

      it("returns 400 with the 'no contact email' message", async () => {
        const res = await request(app).post(`/purchase-orders/${poId}/send`).send({});

        expect(res.status).toBe(400);
        expect(res.body.error).toContain("no contact email");
      });

      it("does not write a po_sent activity row", async () => {
        const activity = await pool.query<ActivityRow>(
          `SELECT * FROM purchase_order_activity
             WHERE purchase_order_id = $1 AND event_type = 'po_sent'`,
          [poId],
        );
        expect(activity.rowCount).toBe(0);
      });

      it("leaves the purchase order status unchanged (not advanced to 'sent')", async () => {
        const po = await pool.query<{ status: string; sent_at: string | null }>(
          `SELECT status, sent_at FROM purchase_orders WHERE id = $1`,
          [poId],
        );
        expect(po.rows[0].status).toBe("approved");
        expect(po.rows[0].sent_at).toBeNull();
      });
    });

    // ─────────────────────────────────────────────────────────────────────
    // POST /purchase-orders/:id/send — guardrail: caller lacks suppliers.edit
    // ─────────────────────────────────────────────────────────────────────

    describe("POST /purchase-orders/:id/send rejects when caller lacks suppliers.edit permission", () => {
      const SUPPLIER_EMAIL = "po-send-perm-supplier@example.com";
      let poId: number;
      let permSupplierId: number;

      beforeAll(async () => {
        // A member without suppliers.edit in allowedPages should be denied.
        currentRole = "member";

        const sup = await pool.query<{ id: number }>(
          `INSERT INTO suppliers (workspace_owner_id, name, contact_email)
           VALUES ($1, 'Activity Test Perm Supplier', $2) RETURNING id`,
          [OWNER_ID, SUPPLIER_EMAIL],
        );
        permSupplierId = sup.rows[0].id;

        const pr = await pool.query<{ id: number }>(
          `INSERT INTO purchase_orders (workspace_owner_id, supplier_id, location_id, status, currency)
           VALUES ($1, $2, $3, 'approved', 'AED') RETURNING id`,
          [OWNER_ID, permSupplierId, locationId],
        );
        poId = pr.rows[0].id;

        await pool.query(
          `INSERT INTO purchase_order_line_items (purchase_order_id, description, quantity, unit_price, currency)
           VALUES ($1, 'Widget Iota', 4, 45.00, 'AED')`,
          [poId],
        );
      });

      afterAll(async () => {
        currentRole = "owner";
        await pool.query(`DELETE FROM purchase_orders WHERE id = $1`, [poId]);
        await pool.query(`DELETE FROM suppliers WHERE id = $1`, [permSupplierId]);
      });

      it("returns 403 with an 'insufficient permissions' message", async () => {
        const res = await request(app).post(`/purchase-orders/${poId}/send`).send({});

        expect(res.status).toBe(403);
        expect(res.body.error).toContain("permissions");
      });

      it("does not write a po_sent activity row", async () => {
        const activity = await pool.query<ActivityRow>(
          `SELECT * FROM purchase_order_activity
             WHERE purchase_order_id = $1 AND event_type = 'po_sent'`,
          [poId],
        );
        expect(activity.rowCount).toBe(0);
      });

      it("leaves the purchase order status unchanged (not advanced to 'sent')", async () => {
        const po = await pool.query<{ status: string; sent_at: string | null }>(
          `SELECT status, sent_at FROM purchase_orders WHERE id = $1`,
          [poId],
        );
        expect(po.rows[0].status).toBe("approved");
        expect(po.rows[0].sent_at).toBeNull();
      });
    });

    // ─────────────────────────────────────────────────────────────────────
    // POST /purchase-orders/:id/send — guardrail: non-existent PO id
    // ─────────────────────────────────────────────────────────────────────

    describe("POST /purchase-orders/:id/send returns 404 for a non-existent PO id", () => {
      const MISSING_PO_ID = 999_999_999;

      it("returns 404 with a 'not found' message", async () => {
        const res = await request(app)
          .post(`/purchase-orders/${MISSING_PO_ID}/send`)
          .send({});

        expect(res.status).toBe(404);
        expect(res.body.error).toContain("not found");
      });

      it("does not write a po_sent activity row for the missing id", async () => {
        const activity = await pool.query<ActivityRow>(
          `SELECT * FROM purchase_order_activity
             WHERE purchase_order_id = $1 AND event_type = 'po_sent'`,
          [MISSING_PO_ID],
        );
        expect(activity.rowCount).toBe(0);
      });
    });

    // ─────────────────────────────────────────────────────────────────────
    // POST /purchase-orders/:id/send — guardrail: cross-workspace PO id
    // ─────────────────────────────────────────────────────────────────────

    describe("POST /purchase-orders/:id/send returns 404 for a cross-workspace PO id", () => {
      const OTHER_OWNER_ID = "__integration_test_po_activity_other_owner__";
      let otherPoId: number;
      let otherSupplierId: number;

      beforeAll(async () => {
        // Seed a PO belonging to a DIFFERENT workspace owner. The send handler
        // scopes its lookup to wreq.workspaceOwnerId (OWNER_ID), so this PO must
        // be invisible — returning 404 rather than leaking another tenant's data.
        const sup = await pool.query<{ id: number }>(
          `INSERT INTO suppliers (workspace_owner_id, name, contact_email)
           VALUES ($1, 'Other Workspace Supplier', 'other-ws-supplier@example.com') RETURNING id`,
          [OTHER_OWNER_ID],
        );
        otherSupplierId = sup.rows[0].id;

        const pr = await pool.query<{ id: number }>(
          `INSERT INTO purchase_orders (workspace_owner_id, supplier_id, status, currency)
           VALUES ($1, $2, 'approved', 'AED') RETURNING id`,
          [OTHER_OWNER_ID, otherSupplierId],
        );
        otherPoId = pr.rows[0].id;

        await pool.query(
          `INSERT INTO purchase_order_line_items (purchase_order_id, description, quantity, unit_price, currency)
           VALUES ($1, 'Widget Kappa', 3, 55.00, 'AED')`,
          [otherPoId],
        );
      });

      afterAll(async () => {
        await pool.query(`DELETE FROM purchase_orders WHERE id = $1`, [otherPoId]);
        await pool.query(`DELETE FROM suppliers WHERE id = $1`, [otherSupplierId]);
      });

      it("returns 404 with a 'not found' message", async () => {
        const res = await request(app)
          .post(`/purchase-orders/${otherPoId}/send`)
          .send({});

        expect(res.status).toBe(404);
        expect(res.body.error).toContain("not found");
      });

      it("does not write a po_sent activity row for the cross-workspace PO", async () => {
        const activity = await pool.query<ActivityRow>(
          `SELECT * FROM purchase_order_activity
             WHERE purchase_order_id = $1 AND event_type = 'po_sent'`,
          [otherPoId],
        );
        expect(activity.rowCount).toBe(0);
      });

      it("leaves the cross-workspace purchase order status unchanged", async () => {
        const po = await pool.query<{ status: string; sent_at: string | null }>(
          `SELECT status, sent_at FROM purchase_orders WHERE id = $1`,
          [otherPoId],
        );
        expect(po.rows[0].status).toBe("approved");
        expect(po.rows[0].sent_at).toBeNull();
      });
    });
  },
);
