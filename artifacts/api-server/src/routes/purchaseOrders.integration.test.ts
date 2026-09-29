/**
 * Integration tests for the purchase orders endpoints
 *
 * Verifies:
 *   - POST /purchase-orders — create a PO linked to a supplier (with and without line items)
 *   - GET /purchase-orders — list all POs, with optional supplier_id filter
 *   - GET /purchase-orders/:id — fetch a single PO with calculated totals
 *   - PATCH /purchase-orders/:id — update status and other fields
 *   - DELETE /purchase-orders/:id — removes the PO and its line items
 *   - Deleting a supplier cascades and removes its POs and line items
 *   - Non-owner gets 403 on mutating endpoints
 *   - Error cases: invalid IDs, missing supplier_id, unknown PO
 *
 * Auth and workspace middleware are stubbed; the database is real.
 * The suite skips automatically when DATABASE_URL is not set.
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

const OWNER_ID = "__integration_test_purchase_orders__";
const USER_ID = "__integration_test_po_user__";

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
    wreq.userEmail = "po-test@example.com";
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
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!DATABASE_URL)(
  "Purchase Orders integration tests",
  () => {
    let pool: InstanceType<typeof Pool>;
    let app: express.Express;
    let supplierId: number;
    let altSupplierId: number;
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

      // Seed a location (required by POST /purchase-orders)
      const loc = await pool.query<{ id: number }>(
        `INSERT INTO locations (workspace_owner_id, name) VALUES ($1, 'PO Test Location') RETURNING id`,
        [OWNER_ID],
      );
      locationId = loc.rows[0].id;

      // Seed two suppliers
      const s1 = await pool.query<{ id: number }>(
        `INSERT INTO suppliers (workspace_owner_id, name, contact_email)
         VALUES ($1, 'PO Test Supplier', 'supplier@example.com') RETURNING id`,
        [OWNER_ID],
      );
      supplierId = s1.rows[0].id;

      const s2 = await pool.query<{ id: number }>(
        `INSERT INTO suppliers (workspace_owner_id, name)
         VALUES ($1, 'Alt PO Supplier') RETURNING id`,
        [OWNER_ID],
      );
      altSupplierId = s2.rows[0].id;
    });

    afterAll(async () => {
      if (!pool) return;
      // Cascade will clean up purchase_orders and line items
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
    // POST /purchase-orders
    // ─────────────────────────────────────────────────────────────────────

    describe("POST /purchase-orders", () => {
      it("creates a PO with required fields only (enters created)", async () => {
        const res = await request(app)
          .post("/purchase-orders")
          .send({ supplier_id: supplierId, location_id: locationId });

        expect(res.status).toBe(201);
        expect(res.body.purchase_order).toBeDefined();
        expect(res.body.purchase_order.supplier_id).toBe(supplierId);
        // The legacy pending_approval/approved states were retired. New POs
        // begin in created and can be sent directly from there.
        expect(res.body.purchase_order.status).toBe("created");
        expect(res.body.purchase_order.currency).toBe("AED");
        expect(res.body.purchase_order.workspace_owner_id).toBe(OWNER_ID);
        expect(res.body.purchase_order.line_items_count).toBe(0);
        expect(res.body.purchase_order.po_number_label).toMatch(/^PO-\d{4}$/);
      });

      it("creates a PO with a custom po_number and notes", async () => {
        const res = await request(app)
          .post("/purchase-orders")
          .send({
            supplier_id: supplierId,
            location_id: locationId,
            po_number: "CUSTOM-001",
            notes: "Rush order",
            currency: "USD",
          });

        expect(res.status).toBe(201);
        expect(res.body.purchase_order.po_number).toBe("CUSTOM-001");
        expect(res.body.purchase_order.po_number_label).toBe("CUSTOM-001");
        expect(res.body.purchase_order.notes).toBe("Rush order");
        expect(res.body.purchase_order.currency).toBe("USD");
      });

      it("creates a PO with inline line items atomically", async () => {
        const res = await request(app)
          .post("/purchase-orders")
          .send({
            supplier_id: supplierId,
            location_id: locationId,
            currency: "AED",
            line_items: [
              { description: "Widget A", quantity: "10", unit_price: "5.50" },
              { description: "Widget B", quantity: "2", unit_price: "100.00" },
            ],
          });

        expect(res.status).toBe(201);
        expect(res.body.purchase_order.line_items_count).toBe(2);

        // Verify line items were actually persisted
        const poId = res.body.purchase_order.id;
        const li = await pool.query(
          `SELECT * FROM purchase_order_line_items WHERE purchase_order_id = $1 ORDER BY id ASC`,
          [poId],
        );
        expect(li.rows).toHaveLength(2);
        expect(li.rows[0].description).toBe("Widget A");
        expect(parseFloat(li.rows[0].quantity)).toBe(10);
        expect(li.rows[1].description).toBe("Widget B");
      });

      it("returns 400 when supplier_id is missing", async () => {
        const res = await request(app)
          .post("/purchase-orders")
          .send({ notes: "no supplier" });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/supplier_id is required/i);
      });

      it("returns 404 when supplier_id does not belong to this workspace", async () => {
        const res = await request(app)
          .post("/purchase-orders")
          .send({ supplier_id: 999999999, location_id: locationId });

        expect(res.status).toBe(404);
        expect(res.body.error).toMatch(/supplier not found/i);
      });

      it("returns 400 when a line item is missing description", async () => {
        const res = await request(app)
          .post("/purchase-orders")
          .send({
            supplier_id: supplierId,
            location_id: locationId,
            line_items: [{ description: "", quantity: "1", unit_price: "10" }],
          });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/description is required/i);
      });

      it("returns 403 when a non-owner attempts to create a PO", async () => {
        currentRole = "member";
        const res = await request(app)
          .post("/purchase-orders")
          .send({ supplier_id: supplierId });

        currentRole = "owner";
        expect(res.status).toBe(403);
        expect(res.body.error).toMatch(/insufficient permissions/i);
      });
    });

    // ─────────────────────────────────────────────────────────────────────
    // POST /purchase-orders — linked base items vs standalone catalog items
    //
    // Regression coverage for the PO wizard bug where ordering a "linked base
    // item" returned a 404. The client cart submits a linked base item with
    // `supplier_catalog_item_id: null` + `base_item_id` set (no
    // supplier_catalog_items row exists for it), while a standalone item submits
    // `supplier_catalog_item_id: item.id`. Both shapes must be accepted, and a
    // cart mixing both must persist correctly.
    // ─────────────────────────────────────────────────────────────────────

    describe("POST /purchase-orders — linked base item line items", () => {
      let baseItemId: number;
      let standaloneCatalogItemId: number;

      beforeAll(async () => {
        const bi = await pool.query<{ id: number }>(
          `INSERT INTO base_items (workspace_owner_id, name, code)
           VALUES ($1, 'Linked Base Item', 'LBI-001') RETURNING id`,
          [OWNER_ID],
        );
        baseItemId = bi.rows[0].id;

        const sci = await pool.query<{ id: number }>(
          `INSERT INTO supplier_catalog_items
             (workspace_owner_id, supplier_id, name, price, currency)
           VALUES ($1, $2, 'Standalone Catalog Item', '4.00', 'AED') RETURNING id`,
          [OWNER_ID, supplierId],
        );
        standaloneCatalogItemId = sci.rows[0].id;
      });

      afterAll(async () => {
        await pool.query(`DELETE FROM base_items WHERE id = $1`, [baseItemId]);
      });

      it("accepts a linked base item (supplier_catalog_item_id null + base_item_id set)", async () => {
        const res = await request(app)
          .post("/purchase-orders")
          .send({
            supplier_id: supplierId,
            location_id: locationId,
            currency: "AED",
            line_items: [
              {
                supplier_catalog_item_id: null,
                base_item_id: baseItemId,
                description: "Linked Base Item",
                quantity: "3",
                unit_price: "12.50",
                currency: "AED",
              },
            ],
          });

        expect(res.status).toBe(201);
        expect(res.body.purchase_order.line_items_count).toBe(1);

        const poId = res.body.purchase_order.id;
        const li = await pool.query<{
          base_item_id: number | null;
          supplier_catalog_item_id: number | null;
          description: string;
        }>(
          `SELECT base_item_id, supplier_catalog_item_id, description
             FROM purchase_order_line_items WHERE purchase_order_id = $1`,
          [poId],
        );
        expect(li.rows).toHaveLength(1);
        expect(li.rows[0].base_item_id).toBe(baseItemId);
        expect(li.rows[0].supplier_catalog_item_id).toBeNull();

        await pool.query(`DELETE FROM purchase_orders WHERE id = $1`, [poId]);
      });

      it("accepts a standalone item (supplier_catalog_item_id set)", async () => {
        const res = await request(app)
          .post("/purchase-orders")
          .send({
            supplier_id: supplierId,
            location_id: locationId,
            currency: "AED",
            line_items: [
              {
                supplier_catalog_item_id: standaloneCatalogItemId,
                description: "Standalone Catalog Item",
                quantity: "5",
                unit_price: "4.00",
                currency: "AED",
              },
            ],
          });

        expect(res.status).toBe(201);
        expect(res.body.purchase_order.line_items_count).toBe(1);

        const poId = res.body.purchase_order.id;
        const li = await pool.query<{
          supplier_catalog_item_id: number | null;
        }>(
          `SELECT supplier_catalog_item_id
             FROM purchase_order_line_items WHERE purchase_order_id = $1`,
          [poId],
        );
        expect(li.rows[0].supplier_catalog_item_id).toBe(standaloneCatalogItemId);

        await pool.query(`DELETE FROM purchase_orders WHERE id = $1`, [poId]);
      });

      it("accepts a cart mixing a linked base item and a standalone item", async () => {
        const res = await request(app)
          .post("/purchase-orders")
          .send({
            supplier_id: supplierId,
            location_id: locationId,
            currency: "AED",
            line_items: [
              {
                supplier_catalog_item_id: null,
                base_item_id: baseItemId,
                description: "Linked Base Item",
                quantity: "2",
                unit_price: "12.50",
                currency: "AED",
              },
              {
                supplier_catalog_item_id: standaloneCatalogItemId,
                description: "Standalone Catalog Item",
                quantity: "3",
                unit_price: "4.00",
                currency: "AED",
              },
            ],
          });

        expect(res.status).toBe(201);
        expect(res.body.purchase_order.line_items_count).toBe(2);

        const poId = res.body.purchase_order.id;
        const li = await pool.query<{
          base_item_id: number | null;
          supplier_catalog_item_id: number | null;
        }>(
          `SELECT base_item_id, supplier_catalog_item_id
             FROM purchase_order_line_items WHERE purchase_order_id = $1`,
          [poId],
        );
        expect(li.rows).toHaveLength(2);

        const linked = li.rows.find((r) => r.supplier_catalog_item_id === null);
        const standalone = li.rows.find(
          (r) => r.supplier_catalog_item_id === standaloneCatalogItemId,
        );
        expect(linked?.base_item_id).toBe(baseItemId);
        expect(standalone).toBeDefined();

        await pool.query(`DELETE FROM purchase_orders WHERE id = $1`, [poId]);
      });

      it("rejects a standalone item whose supplier_catalog_item_id is not in this supplier", async () => {
        const res = await request(app)
          .post("/purchase-orders")
          .send({
            supplier_id: supplierId,
            location_id: locationId,
            line_items: [
              {
                supplier_catalog_item_id: 999999999,
                description: "Bogus",
                quantity: "1",
                unit_price: "1",
              },
            ],
          });

        expect(res.status).toBe(404);
        expect(res.body.error).toMatch(/supplier_catalog_item_id not found/i);
      });
    });

    // ─────────────────────────────────────────────────────────────────────
    // GET /purchase-orders
    // ─────────────────────────────────────────────────────────────────────

    describe("GET /purchase-orders", () => {
      let po1Id: number;
      let po2Id: number;

      beforeAll(async () => {
        // Create one PO per supplier so we can test filtering
        const r1 = await pool.query<{ id: number }>(
          `INSERT INTO purchase_orders (workspace_owner_id, supplier_id, status, currency)
           VALUES ($1, $2, 'draft', 'AED') RETURNING id`,
          [OWNER_ID, supplierId],
        );
        po1Id = r1.rows[0].id;

        const r2 = await pool.query<{ id: number }>(
          `INSERT INTO purchase_orders (workspace_owner_id, supplier_id, status, currency)
           VALUES ($1, $2, 'sent', 'USD') RETURNING id`,
          [OWNER_ID, altSupplierId],
        );
        po2Id = r2.rows[0].id;
      });

      afterAll(async () => {
        await pool.query(
          `DELETE FROM purchase_orders WHERE id = ANY($1::int[])`,
          [[po1Id, po2Id]],
        );
      });

      it("lists all POs for the workspace", async () => {
        const res = await request(app).get("/purchase-orders");

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.purchase_orders)).toBe(true);
        const ids = res.body.purchase_orders.map((p: { id: number }) => p.id);
        expect(ids).toContain(po1Id);
        expect(ids).toContain(po2Id);
      });

      it("filters by supplier_id", async () => {
        const res = await request(app).get(
          `/purchase-orders?supplier_id=${supplierId}`,
        );

        expect(res.status).toBe(200);
        const orders: Array<{ id: number; supplier_id: number }> =
          res.body.purchase_orders;
        const matchingIds = orders.filter((o) => o.supplier_id === supplierId).map((o) => o.id);
        const otherIds = orders.filter((o) => o.supplier_id !== supplierId).map((o) => o.id);
        expect(matchingIds).toContain(po1Id);
        expect(otherIds).not.toContain(po2Id);
      });

      it("includes supplier_name, line_items_count, and received_items_count in list results", async () => {
        const res = await request(app).get(
          `/purchase-orders?supplier_id=${supplierId}`,
        );

        expect(res.status).toBe(200);
        const po = res.body.purchase_orders.find(
          (p: { id: number }) => p.id === po1Id,
        );
        expect(po).toBeDefined();
        expect(po.supplier_name).toBe("PO Test Supplier");
        expect(typeof po.line_items_count).toBe("number");
        expect(typeof po.received_items_count).toBe("number");
      });
    });

    // ─────────────────────────────────────────────────────────────────────
    // GET /purchase-orders/:id
    // ─────────────────────────────────────────────────────────────────────

    describe("GET /purchase-orders/:id", () => {
      let poId: number;

      beforeAll(async () => {
        const r = await pool.query<{ id: number }>(
          `INSERT INTO purchase_orders (workspace_owner_id, supplier_id, status, currency, notes)
           VALUES ($1, $2, 'draft', 'AED', 'Detail test') RETURNING id`,
          [OWNER_ID, supplierId],
        );
        poId = r.rows[0].id;

        await pool.query(
          `INSERT INTO purchase_order_line_items (purchase_order_id, description, quantity, unit_price, currency)
           VALUES ($1, 'Item X', 3, 50, 'AED'), ($1, 'Item Y', 1, 200, 'AED')`,
          [poId],
        );
      });

      afterAll(async () => {
        await pool.query(`DELETE FROM purchase_orders WHERE id = $1`, [poId]);
      });

      it("returns a single PO with all fields", async () => {
        const res = await request(app).get(`/purchase-orders/${poId}`);

        expect(res.status).toBe(200);
        expect(res.body.purchase_order.id).toBe(poId);
        expect(res.body.purchase_order.notes).toBe("Detail test");
        expect(res.body.purchase_order.supplier_name).toBe("PO Test Supplier");
        expect(res.body.purchase_order.line_items_count).toBe(2);
        expect(res.body.purchase_order.po_number_label).toMatch(/^PO-\d{4}$/);
      });

      it("returns calculated totals from line items", async () => {
        const res = await request(app).get(`/purchase-orders/${poId}`);

        expect(res.status).toBe(200);
        // 3 * 50 + 1 * 200 = 350
        const po = res.body.purchase_order;
        expect(parseFloat(po.calculated_total)).toBeCloseTo(350, 2);
        expect(parseFloat(po.effective_total)).toBeCloseTo(350, 2);
      });

      it("returns 404 for an unknown PO id", async () => {
        const res = await request(app).get("/purchase-orders/999999999");

        expect(res.status).toBe(404);
        expect(res.body.error).toMatch(/not found/i);
      });

      it("returns 400 for a non-numeric PO id", async () => {
        const res = await request(app).get("/purchase-orders/abc");

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/invalid purchase order id/i);
      });
    });

    // ─────────────────────────────────────────────────────────────────────
    // PATCH /purchase-orders/:id
    // ─────────────────────────────────────────────────────────────────────

    describe("PATCH /purchase-orders/:id", () => {
      let poId: number;

      beforeAll(async () => {
        const r = await pool.query<{ id: number }>(
          `INSERT INTO purchase_orders (workspace_owner_id, supplier_id, status, currency)
           VALUES ($1, $2, 'draft', 'AED') RETURNING id`,
          [OWNER_ID, supplierId],
        );
        poId = r.rows[0].id;
      });

      afterAll(async () => {
        await pool.query(`DELETE FROM purchase_orders WHERE id = $1`, [poId]);
      });

      it("updates status from draft to sent", async () => {
        const res = await request(app)
          .patch(`/purchase-orders/${poId}`)
          .send({ status: "sent" });

        expect(res.status).toBe(200);
        expect(res.body.purchase_order.status).toBe("sent");
      });

      it("updates notes and currency", async () => {
        const res = await request(app)
          .patch(`/purchase-orders/${poId}`)
          .send({ notes: "Updated notes", currency: "USD" });

        expect(res.status).toBe(200);
        expect(res.body.purchase_order.notes).toBe("Updated notes");
        expect(res.body.purchase_order.currency).toBe("USD");
      });

      it("allows setting a manual total amount", async () => {
        const res = await request(app)
          .patch(`/purchase-orders/${poId}`)
          .send({
            total_amount: "9999.50",
            total_amount_manual_override: true,
          });

        expect(res.status).toBe(200);
        expect(parseFloat(res.body.purchase_order.total_amount)).toBeCloseTo(9999.5, 2);
        expect(res.body.purchase_order.total_amount_manual_override).toBe(true);
      });

      it("returns 404 when patching an unknown PO id", async () => {
        const res = await request(app)
          .patch("/purchase-orders/999999999")
          .send({ status: "sent" });

        expect(res.status).toBe(404);
        expect(res.body.error).toMatch(/not found/i);
      });

      it("returns 403 when non-owner attempts to patch", async () => {
        currentRole = "member";
        const res = await request(app)
          .patch(`/purchase-orders/${poId}`)
          .send({ status: "received" });

        currentRole = "owner";
        expect(res.status).toBe(403);
      });
    });

    // ─────────────────────────────────────────────────────────────────────
    // DELETE /purchase-orders/:id
    // ─────────────────────────────────────────────────────────────────────

    describe("DELETE /purchase-orders/:id", () => {
      it("deletes a PO and its line items", async () => {
        const r = await pool.query<{ id: number }>(
          `INSERT INTO purchase_orders (workspace_owner_id, supplier_id, status, currency)
           VALUES ($1, $2, 'draft', 'AED') RETURNING id`,
          [OWNER_ID, supplierId],
        );
        const poId = r.rows[0].id;

        await pool.query(
          `INSERT INTO purchase_order_line_items (purchase_order_id, description, quantity, unit_price, currency)
           VALUES ($1, 'Item to delete', 5, 10, 'AED')`,
          [poId],
        );

        const res = await request(app).delete(`/purchase-orders/${poId}`);
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);

        // Verify the PO is gone
        const poCheck = await pool.query(
          `SELECT id FROM purchase_orders WHERE id = $1`,
          [poId],
        );
        expect(poCheck.rowCount).toBe(0);

        // Verify line items are gone too
        const liCheck = await pool.query(
          `SELECT id FROM purchase_order_line_items WHERE purchase_order_id = $1`,
          [poId],
        );
        expect(liCheck.rowCount).toBe(0);
      });

      it("returns 404 when deleting an unknown PO id", async () => {
        const res = await request(app).delete("/purchase-orders/999999999");
        expect(res.status).toBe(404);
        expect(res.body.error).toMatch(/not found/i);
      });

      it("returns 403 when non-owner attempts to delete", async () => {
        const r = await pool.query<{ id: number }>(
          `INSERT INTO purchase_orders (workspace_owner_id, supplier_id, status, currency)
           VALUES ($1, $2, 'draft', 'AED') RETURNING id`,
          [OWNER_ID, supplierId],
        );
        const poId = r.rows[0].id;

        currentRole = "member";
        const res = await request(app).delete(`/purchase-orders/${poId}`);
        currentRole = "owner";

        expect(res.status).toBe(403);

        // Clean up
        await pool.query(`DELETE FROM purchase_orders WHERE id = $1`, [poId]);
      });
    });

    // ─────────────────────────────────────────────────────────────────────
    // recomputePoTotals — totals stay correct after line-item mutations
    // ─────────────────────────────────────────────────────────────────────

    describe("recomputePoTotals via line-item API", () => {
      let poId: number;

      beforeAll(async () => {
        // Create a PO with vat_exclusive @ 5% so VAT is easily predictable
        const pr = await pool.query<{ id: number }>(
          `INSERT INTO purchase_orders
             (workspace_owner_id, supplier_id, status, currency, vat_treatment, vat_rate)
           VALUES ($1, $2, 'draft', 'AED', 'vat_exclusive', 5)
           RETURNING id`,
          [OWNER_ID, supplierId],
        );
        poId = pr.rows[0].id;
      });

      afterAll(async () => {
        await pool.query(`DELETE FROM purchase_orders WHERE id = $1`, [poId]);
      });

      it("totals are null before any line items are added", async () => {
        const row = await pool.query<{
          subtotal_amount: string | null;
          vat_amount: string | null;
          grand_total_amount: string | null;
        }>(
          `SELECT subtotal_amount, vat_amount, grand_total_amount
             FROM purchase_orders WHERE id = $1`,
          [poId],
        );
        expect(row.rows[0].subtotal_amount).toBeNull();
        expect(row.rows[0].vat_amount).toBeNull();
        expect(row.rows[0].grand_total_amount).toBeNull();
      });

      it("adding a line item recomputes totals correctly (vat_exclusive 5%)", async () => {
        // qty=10, unit_price=20.00 → subtotal=200.00, VAT=10.00, grand=210.00
        const res = await request(app)
          .post(`/purchase-orders/${poId}/line-items`)
          .send({ description: "Item A", quantity: "10", unit_price: "20.00", currency: "AED" });

        expect(res.status).toBe(201);

        const row = await pool.query<{
          subtotal_amount: string;
          vat_amount: string;
          grand_total_amount: string;
        }>(
          `SELECT subtotal_amount, vat_amount, grand_total_amount
             FROM purchase_orders WHERE id = $1`,
          [poId],
        );
        expect(parseFloat(row.rows[0].subtotal_amount)).toBeCloseTo(200.00, 2);
        expect(parseFloat(row.rows[0].vat_amount)).toBeCloseTo(10.00, 2);
        expect(parseFloat(row.rows[0].grand_total_amount)).toBeCloseTo(210.00, 2);
      });

      it("updating a line item quantity recomputes totals correctly", async () => {
        // Fetch the line item that was just created
        const li = await pool.query<{ id: number }>(
          `SELECT id FROM purchase_order_line_items WHERE purchase_order_id = $1 ORDER BY id ASC LIMIT 1`,
          [poId],
        );
        const lineItemId = li.rows[0].id;

        // qty=10→20, unit_price=20.00 → subtotal=400.00, VAT=20.00, grand=420.00
        const res = await request(app)
          .patch(`/purchase-orders/${poId}/line-items/${lineItemId}`)
          .send({ quantity: "20" });

        expect(res.status).toBe(200);

        const row = await pool.query<{
          subtotal_amount: string;
          vat_amount: string;
          grand_total_amount: string;
        }>(
          `SELECT subtotal_amount, vat_amount, grand_total_amount
             FROM purchase_orders WHERE id = $1`,
          [poId],
        );
        expect(parseFloat(row.rows[0].subtotal_amount)).toBeCloseTo(400.00, 2);
        expect(parseFloat(row.rows[0].vat_amount)).toBeCloseTo(20.00, 2);
        expect(parseFloat(row.rows[0].grand_total_amount)).toBeCloseTo(420.00, 2);
      });

      it("adding a second line item accumulates in the totals", async () => {
        // Add second item: qty=5, unit_price=8.00 → adds 40.00 to subtotal
        // Combined subtotal=440.00, VAT=22.00, grand=462.00
        const res = await request(app)
          .post(`/purchase-orders/${poId}/line-items`)
          .send({ description: "Item B", quantity: "5", unit_price: "8.00", currency: "AED" });

        expect(res.status).toBe(201);

        const row = await pool.query<{
          subtotal_amount: string;
          vat_amount: string;
          grand_total_amount: string;
        }>(
          `SELECT subtotal_amount, vat_amount, grand_total_amount
             FROM purchase_orders WHERE id = $1`,
          [poId],
        );
        expect(parseFloat(row.rows[0].subtotal_amount)).toBeCloseTo(440.00, 2);
        expect(parseFloat(row.rows[0].vat_amount)).toBeCloseTo(22.00, 2);
        expect(parseFloat(row.rows[0].grand_total_amount)).toBeCloseTo(462.00, 2);
      });

      it("deleting a line item recomputes totals from the remaining items", async () => {
        // Delete Item A (qty=20, unit_price=20.00 = 400.00) leaving only Item B (qty=5, unit_price=8 = 40.00)
        // subtotal=40.00, VAT=2.00, grand=42.00
        const li = await pool.query<{ id: number }>(
          `SELECT id FROM purchase_order_line_items WHERE purchase_order_id = $1 ORDER BY id ASC LIMIT 1`,
          [poId],
        );
        const lineItemId = li.rows[0].id;

        const res = await request(app)
          .delete(`/purchase-orders/${poId}/line-items/${lineItemId}`);

        expect(res.status).toBe(200);

        const row = await pool.query<{
          subtotal_amount: string;
          vat_amount: string;
          grand_total_amount: string;
        }>(
          `SELECT subtotal_amount, vat_amount, grand_total_amount
             FROM purchase_orders WHERE id = $1`,
          [poId],
        );
        expect(parseFloat(row.rows[0].subtotal_amount)).toBeCloseTo(40.00, 2);
        expect(parseFloat(row.rows[0].vat_amount)).toBeCloseTo(2.00, 2);
        expect(parseFloat(row.rows[0].grand_total_amount)).toBeCloseTo(42.00, 2);
      });

      it("deleting all line items resets totals to zero", async () => {
        // Delete the remaining Item B
        const li = await pool.query<{ id: number }>(
          `SELECT id FROM purchase_order_line_items WHERE purchase_order_id = $1 ORDER BY id ASC LIMIT 1`,
          [poId],
        );
        const lineItemId = li.rows[0].id;

        const res = await request(app)
          .delete(`/purchase-orders/${poId}/line-items/${lineItemId}`);

        expect(res.status).toBe(200);

        const row = await pool.query<{
          subtotal_amount: string;
          vat_amount: string;
          grand_total_amount: string;
        }>(
          `SELECT subtotal_amount, vat_amount, grand_total_amount
             FROM purchase_orders WHERE id = $1`,
          [poId],
        );
        expect(parseFloat(row.rows[0].subtotal_amount)).toBeCloseTo(0.00, 2);
        expect(parseFloat(row.rows[0].vat_amount)).toBeCloseTo(0.00, 2);
        expect(parseFloat(row.rows[0].grand_total_amount)).toBeCloseTo(0.00, 2);
      });

      it("totals reflect vat_inclusive treatment correctly", async () => {
        // Switch the PO to vat_inclusive @ 10%
        // line item: qty=1, unit_price=110.00 → subtotal=110.00
        // VAT extracted = 110 - 110/1.10 = 10.00
        // grand_total = subtotal + vatAmount = 110 + 10 = 120.00
        // (computeCostSummary adds extracted VAT back on top of the raw line-item sum)
        await pool.query(
          `UPDATE purchase_orders SET vat_treatment = 'vat_inclusive', vat_rate = 10 WHERE id = $1`,
          [poId],
        );

        const res = await request(app)
          .post(`/purchase-orders/${poId}/line-items`)
          .send({ description: "Inclusive Item", quantity: "1", unit_price: "110.00", currency: "AED" });

        expect(res.status).toBe(201);

        const row = await pool.query<{
          subtotal_amount: string;
          vat_amount: string;
          grand_total_amount: string;
        }>(
          `SELECT subtotal_amount, vat_amount, grand_total_amount
             FROM purchase_orders WHERE id = $1`,
          [poId],
        );
        expect(parseFloat(row.rows[0].subtotal_amount)).toBeCloseTo(110.00, 2);
        expect(parseFloat(row.rows[0].vat_amount)).toBeCloseTo(10.00, 2);
        expect(parseFloat(row.rows[0].grand_total_amount)).toBeCloseTo(120.00, 2);
      });
    });

    // ─────────────────────────────────────────────────────────────────────
    // Supplier cascade delete
    // ─────────────────────────────────────────────────────────────────────

    describe("Supplier cascade delete", () => {
      beforeAll(async () => {
        // Live probe: verify ON DELETE CASCADE is actually wired on both FKs
        // before the rest of the suite relies on it. If a migration accidentally drops
        // a CASCADE clause, this fails with a clear message instead of a later row-count mismatch.
        const probeSupplier = await pool.query<{ id: number }>(
          `INSERT INTO suppliers (workspace_owner_id, name)
           VALUES ($1, 'Cascade Probe Supplier') RETURNING id`,
          [OWNER_ID],
        );
        const probeSupplierId = probeSupplier.rows[0].id;

        const probePo = await pool.query<{ id: number }>(
          `INSERT INTO purchase_orders (workspace_owner_id, supplier_id, status, currency)
           VALUES ($1, $2, 'draft', 'AED') RETURNING id`,
          [OWNER_ID, probeSupplierId],
        );
        const probePoId = probePo.rows[0].id;

        await pool.query(
          `INSERT INTO purchase_order_line_items (purchase_order_id, description, quantity, unit_price, currency)
           VALUES ($1, 'Probe item', 1, 1, 'AED')`,
          [probePoId],
        );

        await pool.query(`DELETE FROM suppliers WHERE id = $1`, [probeSupplierId]);

        const poCheck = await pool.query(
          `SELECT id FROM purchase_orders WHERE id = $1`,
          [probePoId],
        );
        if (poCheck.rowCount !== 0) {
          throw new Error(
            "ON DELETE CASCADE is missing on purchase_orders.supplier_id — deleting a supplier did not remove its purchase_orders",
          );
        }

        const liCheck = await pool.query(
          `SELECT id FROM purchase_order_line_items WHERE purchase_order_id = $1`,
          [probePoId],
        );
        if (liCheck.rowCount !== 0) {
          throw new Error(
            "ON DELETE CASCADE is missing on purchase_order_line_items.purchase_order_id — deleting a purchase_order did not remove its line_items",
          );
        }
      });

      it("deleting a supplier removes its POs and line items from the database", async () => {
        // Create a throwaway supplier
        const sr = await pool.query<{ id: number }>(
          `INSERT INTO suppliers (workspace_owner_id, name)
           VALUES ($1, 'Cascade Test Supplier') RETURNING id`,
          [OWNER_ID],
        );
        const cascadeSupplierId = sr.rows[0].id;

        // Create a PO for that supplier with a line item
        const pr = await pool.query<{ id: number }>(
          `INSERT INTO purchase_orders (workspace_owner_id, supplier_id, status, currency)
           VALUES ($1, $2, 'draft', 'AED') RETURNING id`,
          [OWNER_ID, cascadeSupplierId],
        );
        const poId = pr.rows[0].id;

        await pool.query(
          `INSERT INTO purchase_order_line_items (purchase_order_id, description, quantity, unit_price, currency)
           VALUES ($1, 'Cascaded item', 1, 25, 'AED')`,
          [poId],
        );

        // Confirm setup is correct
        const beforePo = await pool.query(
          `SELECT id FROM purchase_orders WHERE id = $1`,
          [poId],
        );
        expect(beforePo.rowCount).toBe(1);

        // Delete the supplier — ON DELETE CASCADE should remove the PO and its line items
        await pool.query(`DELETE FROM suppliers WHERE id = $1`, [cascadeSupplierId]);

        // The PO should be gone
        const afterPo = await pool.query(
          `SELECT id FROM purchase_orders WHERE id = $1`,
          [poId],
        );
        expect(afterPo.rowCount).toBe(0);

        // The line items should be gone (cascaded via purchase_orders FK)
        const afterLi = await pool.query(
          `SELECT id FROM purchase_order_line_items WHERE purchase_order_id = $1`,
          [poId],
        );
        expect(afterLi.rowCount).toBe(0);
      });
    });

    // ─────────────────────────────────────────────────────────────────────
    // recomputePoTotals — totals stay correct when PO header fields change
    // ─────────────────────────────────────────────────────────────────────

    describe("recomputePoTotals via PATCH header fields", () => {
      let poId: number;

      beforeAll(async () => {
        // Create a draft PO with vat_exclusive @ 5% and one line item:
        //   qty=4, unit_price=50.00 → line-items subtotal = 200.00
        //   baseline: subtotal=200, VAT=10.00, grand=210.00
        const pr = await pool.query<{ id: number }>(
          `INSERT INTO purchase_orders
             (workspace_owner_id, supplier_id, status, currency, vat_treatment, vat_rate)
           VALUES ($1, $2, 'draft', 'AED', 'vat_exclusive', 5)
           RETURNING id`,
          [OWNER_ID, supplierId],
        );
        poId = pr.rows[0].id;

        await pool.query(
          `INSERT INTO purchase_order_line_items
             (purchase_order_id, description, quantity, unit_price, currency)
           VALUES ($1, 'Header-field test item', 4, 50, 'AED')`,
          [poId],
        );
      });

      afterAll(async () => {
        await pool.query(`DELETE FROM purchase_orders WHERE id = $1`, [poId]);
      });

      it("setting discount_amount lowers grand_total correctly", async () => {
        // subtotal=200, VAT=5%→10, discount=20
        // grand = 200 - 20 + 0 + 10 = 190
        const res = await request(app)
          .patch(`/purchase-orders/${poId}`)
          .send({ discount_amount: "20" });

        expect(res.status).toBe(200);

        const row = await pool.query<{
          subtotal_amount: string;
          vat_amount: string;
          grand_total_amount: string;
        }>(
          `SELECT subtotal_amount, vat_amount, grand_total_amount
             FROM purchase_orders WHERE id = $1`,
          [poId],
        );
        expect(parseFloat(row.rows[0].subtotal_amount)).toBeCloseTo(200.00, 2);
        expect(parseFloat(row.rows[0].vat_amount)).toBeCloseTo(10.00, 2);
        expect(parseFloat(row.rows[0].grand_total_amount)).toBeCloseTo(190.00, 2);
      });

      it("setting delivery_fee_amount raises grand_total correctly", async () => {
        // discount_amount=20 carries from previous test
        // subtotal=200, VAT=10, discount=20, delivery=15
        // grand = 200 - 20 + 15 + 10 = 205
        const res = await request(app)
          .patch(`/purchase-orders/${poId}`)
          .send({ delivery_fee_amount: "15" });

        expect(res.status).toBe(200);

        const row = await pool.query<{
          subtotal_amount: string;
          vat_amount: string;
          grand_total_amount: string;
        }>(
          `SELECT subtotal_amount, vat_amount, grand_total_amount
             FROM purchase_orders WHERE id = $1`,
          [poId],
        );
        expect(parseFloat(row.rows[0].subtotal_amount)).toBeCloseTo(200.00, 2);
        expect(parseFloat(row.rows[0].vat_amount)).toBeCloseTo(10.00, 2);
        expect(parseFloat(row.rows[0].grand_total_amount)).toBeCloseTo(205.00, 2);
      });

      it("changing vat_rate updates vat_amount and grand_total correctly", async () => {
        // discount_amount=20, delivery_fee=15 carry from previous tests
        // subtotal=200, VAT=10%→20, discount=20, delivery=15
        // grand = 200 - 20 + 15 + 20 = 215
        const res = await request(app)
          .patch(`/purchase-orders/${poId}`)
          .send({ vat_rate: "10" });

        expect(res.status).toBe(200);

        const row = await pool.query<{
          subtotal_amount: string;
          vat_amount: string;
          grand_total_amount: string;
        }>(
          `SELECT subtotal_amount, vat_amount, grand_total_amount
             FROM purchase_orders WHERE id = $1`,
          [poId],
        );
        expect(parseFloat(row.rows[0].subtotal_amount)).toBeCloseTo(200.00, 2);
        expect(parseFloat(row.rows[0].vat_amount)).toBeCloseTo(20.00, 2);
        expect(parseFloat(row.rows[0].grand_total_amount)).toBeCloseTo(215.00, 2);
      });
    });
  },
);
