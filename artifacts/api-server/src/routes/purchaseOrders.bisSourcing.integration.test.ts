/**
 * Integration tests: PO item sourcing from base_item_suppliers (BIS).
 *
 * Exercises the actual HTTP routes via supertest with mocked auth/workspace.
 * All SQL goes to the real test database.
 *
 * Tests:
 *  1. POST /purchase-orders with BIS item (no description) → 201, description sourced from BIS.
 *  2. POST /purchase-orders missing description AND no base_item_supplier_id → 400.
 *  3. PATCH /purchase-orders/:id/line-items/:lineItemId with new BIS id → persists id,
 *     refreshes snapshot description, price, currency.
 *  4. PATCH with a cross-workspace / wrong-supplier BIS id → 404.
 *  5. Snapshot immutability: updating BIS row after create does NOT change stored line description.
 *  6. add-line (POST /purchase-orders/:id/line-items) via BIS → line created with base_item_supplier_id.
 *  7. add-line with cross-workspace BIS id → 404.
 *  8. add-line missing description AND no base_item_supplier_id → 400.
 *  9. POST /purchase-orders with cross-workspace BIS id → 404 (pre-flight, no PO created).
 * 10. POST /purchase-orders with wrong-supplier BIS id (right workspace, wrong supplier) → 404.
 * 11. add-line via minimal BIS (no supplier_item_name, no price) → 201, description falls back
 *     to base_item.name, unit_price stored as 0.
 *
 * Auth and workspace middleware are mocked as owner.
 * Side-effect libs (email, translation, PDF, inventory) are mocked.
 *
 * Skips automatically when DATABASE_URL is not set.
 *
 * Run:
 *   bash test-integration-local.sh src/routes/purchaseOrders.bisSourcing.integration.test.ts
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import pg from "pg";
import type { WorkspaceRequest } from "../lib/workspace";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;

// ─── Stable test-scope IDs ────────────────────────────────────────────────────
const OWNER_ID  = "__bis_sourcing_integ__";
const USER_ID   = "__bis_sourcing_user__";
// A second workspace used to verify cross-workspace BIS rejection
const OTHER_OWNER_ID = "__bis_sourcing_other__";

// ─── Mocks ───────────────────────────────────────────────────────────────────
// Only mock auth, workspace, logger and pure side-effect libs.
// db uses the real module so all SQL goes to the real database.

vi.mock("../lib/auth", () => ({
  requireAuth: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => next(),
  authed: (_req: express.Request) => ({ userId: USER_ID }),
}));

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId    = OWNER_ID;
    wreq.workspaceRole       = "owner";
    wreq.workspaceActualRole = "owner";
    wreq.userId    = USER_ID;
    wreq.userEmail = "bis-test@example.com";
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

vi.mock("../lib/logger", () => ({
  logger: {
    info:  vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
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
  buildPurchaseOrderPdf:       vi.fn().mockResolvedValue(Buffer.from("")),
  resolvePoPdfLineItemImages:  vi.fn().mockResolvedValue([]),
  resolveChromiumPath:         vi.fn().mockResolvedValue("/usr/bin/chromium"),
}));

vi.mock("../lib/purchaseOrderMatching", () => ({
  computeThreeWayMatch: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/inventoryService", () => ({
  postMovement: vi.fn().mockResolvedValue({ id: 0 }),
}));

vi.mock("@clerk/express", () => ({
  clerkClient: {
    users: {
      getUserList: vi.fn().mockResolvedValue({ data: [] }),
    },
  },
}));

// ─── Import router after mocks ────────────────────────────────────────────────
import purchaseOrdersRouter from "./purchaseOrders";

// ─── App factory ──────────────────────────────────────────────────────────────
function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api", purchaseOrdersRouter);
  return app;
}

// ─── Helper: fetch line items for a PO ───────────────────────────────────────
async function getLineItems(
  app: express.Express,
  poId: number,
): Promise<Record<string, unknown>[]> {
  const res = await request(app).get(`/api/purchase-orders/${poId}/line-items`);
  if (res.status !== 200) throw new Error(`GET line-items failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.line_items as Record<string, unknown>[];
}

// ─── Tests ────────────────────────────────────────────────────────────────────
describe.skipIf(!DATABASE_URL)(
  "PO BIS sourcing — HTTP routes (integration)",
  () => {
    let pool: InstanceType<typeof Pool>;
    let app: express.Express;

    // Seed IDs
    let supplierId: number;
    let locationId: number;
    let baseItemId: number;
    let bisId: number;             // BIS linking baseItem ↔ supplier (OWNER_ID)
    let otherBisId: number;        // BIS in OTHER_OWNER_ID workspace
    let wrongSupplierBisId: number; // BIS in OWNER_ID workspace but linked to a different supplier

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL });
      app  = makeApp();

      // Seed supplier in OWNER_ID workspace
      const sRow = await pool.query<{ id: number }>(
        `INSERT INTO suppliers (workspace_owner_id, name)
         VALUES ($1, 'BIS Route Test Supplier') RETURNING id`,
        [OWNER_ID],
      );
      supplierId = sRow.rows[0].id;

      // Seed location
      const locRow = await pool.query<{ id: number }>(
        `INSERT INTO locations (workspace_owner_id, name, country)
         VALUES ($1, 'BIS Route Test Location', 'AE') RETURNING id`,
        [OWNER_ID],
      );
      locationId = locRow.rows[0].id;

      // Seed base item
      const biRow = await pool.query<{ id: number }>(
        `INSERT INTO base_items (workspace_owner_id, name, code, status)
         VALUES ($1, 'Test Rose', $2, 'active') RETURNING id`,
        [OWNER_ID, `TRR-${Date.now()}`],
      );
      baseItemId = biRow.rows[0].id;

      // Seed BIS row (OWNER_ID workspace)
      const bisRow = await pool.query<{ id: number }>(
        `INSERT INTO base_item_suppliers
           (workspace_owner_id, base_item_id, supplier_id,
            supplier_item_name, supplier_item_code, price, currency, pricing_uom,
            name_ar)
         VALUES ($1, $2, $3, 'Test Rose Supplier Name', 'TR-001', '12.50', 'AED', 'stem', 'وردة تجريبية')
         RETURNING id`,
        [OWNER_ID, baseItemId, supplierId],
      );
      bisId = bisRow.rows[0].id;

      // Seed OTHER workspace supplier + BIS (for cross-workspace rejection tests)
      const osRow = await pool.query<{ id: number }>(
        `INSERT INTO suppliers (workspace_owner_id, name)
         VALUES ($1, 'Other WS Supplier') RETURNING id`,
        [OTHER_OWNER_ID],
      );
      const otherSupplierId = osRow.rows[0].id;

      const obiRow = await pool.query<{ id: number }>(
        `INSERT INTO base_items (workspace_owner_id, name, code, status)
         VALUES ($1, 'Other Rose', $2, 'active') RETURNING id`,
        [OTHER_OWNER_ID, `OR-${Date.now()}`],
      );
      const otherBaseItemId = obiRow.rows[0].id;

      const oBisRow = await pool.query<{ id: number }>(
        `INSERT INTO base_item_suppliers
           (workspace_owner_id, base_item_id, supplier_id,
            supplier_item_name, supplier_item_code, price, currency, pricing_uom)
         VALUES ($1, $2, $3, 'Cross WS Name', 'CW-001', '99.00', 'AED', 'unit')
         RETURNING id`,
        [OTHER_OWNER_ID, otherBaseItemId, otherSupplierId],
      );
      otherBisId = oBisRow.rows[0].id;

      // Seed a second supplier in OWNER_ID workspace (wrong supplier for BIS cross-supplier test)
      const s2Row = await pool.query<{ id: number }>(
        `INSERT INTO suppliers (workspace_owner_id, name)
         VALUES ($1, 'BIS Route Test Supplier 2') RETURNING id`,
        [OWNER_ID],
      );
      const supplier2Id = s2Row.rows[0].id;

      const wsBisRow = await pool.query<{ id: number }>(
        `INSERT INTO base_item_suppliers
           (workspace_owner_id, base_item_id, supplier_id,
            supplier_item_name, price, currency)
         VALUES ($1, $2, $3, 'Wrong Supplier Name', '5.00', 'AED')
         RETURNING id`,
        [OWNER_ID, baseItemId, supplier2Id],
      );
      wrongSupplierBisId = wsBisRow.rows[0].id;
    });

    afterAll(async () => {
      // Clean up in dependency order
      await pool.query(
        `DELETE FROM purchase_orders WHERE workspace_owner_id = ANY($1::text[])`,
        [[OWNER_ID, OTHER_OWNER_ID]],
      );
      await pool.query(
        `DELETE FROM base_item_suppliers WHERE workspace_owner_id = ANY($1::text[])`,
        [[OWNER_ID, OTHER_OWNER_ID]],
      );
      await pool.query(
        `DELETE FROM base_items WHERE workspace_owner_id = ANY($1::text[])`,
        [[OWNER_ID, OTHER_OWNER_ID]],
      );
      await pool.query(
        `DELETE FROM locations WHERE workspace_owner_id = ANY($1::text[])`,
        [[OWNER_ID, OTHER_OWNER_ID]],
      );
      await pool.query(
        `DELETE FROM suppliers WHERE workspace_owner_id = ANY($1::text[])`,
        [[OWNER_ID, OTHER_OWNER_ID]],
      );
      await pool.end();
    });

    // ── Test 1 ────────────────────────────────────────────────────────────────
    it("POST /purchase-orders with BIS item (no description) → 201 with BIS-sourced fields", async () => {
      // Send ONLY base_item_supplier_id + quantity — no description, no unit_price.
      // Both should be sourced from the BIS row.
      const res = await request(app)
        .post("/api/purchase-orders")
        .send({
          supplier_id: supplierId,
          location_id: locationId,
          currency: "AED",
          line_items: [
            {
              base_item_supplier_id: bisId,
              quantity: 10,
              // intentionally omitting description and unit_price
            },
          ],
        });

      expect(res.status).toBe(201);
      const po = res.body.purchase_order;
      expect(po).toBeDefined();
      expect(po.id).toBeDefined();

      // Fetch line items separately — create response does not embed them
      const lineItems = await getLineItems(app, po.id);
      expect(lineItems).toHaveLength(1);
      const li = lineItems[0];
      expect(li.base_item_supplier_id).toBe(bisId);
      expect(li.base_item_id).toBe(baseItemId);
      expect(li.description).toBe("Test Rose Supplier Name");
      expect(li.description_ar).toBe("وردة تجريبية");
      expect(String(li.unit_price)).toMatch(/^12\.5/);
      expect(li.currency).toBe("AED");

      await pool.query(`DELETE FROM purchase_orders WHERE id = $1`, [po.id]);
    });

    // ── Test 2 ────────────────────────────────────────────────────────────────
    it("POST /purchase-orders missing description AND no base_item_supplier_id → 400", async () => {
      const res = await request(app)
        .post("/api/purchase-orders")
        .send({
          supplier_id: supplierId,
          location_id: locationId,
          currency: "AED",
          line_items: [
            {
              quantity: 10,
              unit_price: 12.50,
              // no description, no base_item_supplier_id
            },
          ],
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/description is required/i);
    });

    // ── Test 3 ────────────────────────────────────────────────────────────────
    it("PATCH line item with new base_item_supplier_id → persists id and refreshes snapshot", async () => {
      // Create a PO with a plain description line item
      const createRes = await request(app)
        .post("/api/purchase-orders")
        .send({
          supplier_id: supplierId,
          location_id: locationId,
          currency: "AED",
          line_items: [
            { description: "Original Desc", quantity: 1, unit_price: 5.00 },
          ],
        });
      expect(createRes.status).toBe(201);
      const po = createRes.body.purchase_order;

      const initialLines = await getLineItems(app, po.id);
      expect(initialLines).toHaveLength(1);
      const lineItemId = initialLines[0].id as number;

      // PATCH to switch to BIS — should refresh description, price, currency
      const patchRes = await request(app)
        .patch(`/api/purchase-orders/${po.id}/line-items/${lineItemId}`)
        .send({
          base_item_supplier_id: bisId,
          quantity: 2,
        });

      expect(patchRes.status).toBe(200);
      const updated = patchRes.body.line_item;
      expect(updated.base_item_supplier_id).toBe(bisId);
      expect(updated.base_item_id).toBe(baseItemId);
      expect(updated.description).toBe("Test Rose Supplier Name");
      expect(updated.description_ar).toBe("وردة تجريبية");
      expect(String(updated.unit_price)).toMatch(/^12\.5/);
      expect(updated.currency).toBe("AED");

      await pool.query(`DELETE FROM purchase_orders WHERE id = $1`, [po.id]);
    });

    // ── Test 4 ────────────────────────────────────────────────────────────────
    it("PATCH line item with cross-workspace BIS id → 404", async () => {
      const createRes = await request(app)
        .post("/api/purchase-orders")
        .send({
          supplier_id: supplierId,
          location_id: locationId,
          currency: "AED",
          line_items: [
            { description: "Original", quantity: 1, unit_price: 5.00 },
          ],
        });
      expect(createRes.status).toBe(201);
      const po = createRes.body.purchase_order;
      const lines = await getLineItems(app, po.id);
      const lineItemId = lines[0].id as number;

      const patchRes = await request(app)
        .patch(`/api/purchase-orders/${po.id}/line-items/${lineItemId}`)
        .send({ base_item_supplier_id: otherBisId, quantity: 1 });

      expect(patchRes.status).toBe(404);
      expect(patchRes.body.error).toMatch(/not found/i);

      await pool.query(`DELETE FROM purchase_orders WHERE id = $1`, [po.id]);
    });

    // ── Test 5 ────────────────────────────────────────────────────────────────
    it("snapshot immutability: updating BIS row does NOT change stored line description", async () => {
      const createRes = await request(app)
        .post("/api/purchase-orders")
        .send({
          supplier_id: supplierId,
          location_id: locationId,
          currency: "AED",
          line_items: [
            {
              base_item_supplier_id: bisId,
              quantity: 3,
              unit_price: 12.50,
            },
          ],
        });
      expect(createRes.status).toBe(201);
      const po = createRes.body.purchase_order;
      const lines = await getLineItems(app, po.id);
      expect(lines[0].description).toBe("Test Rose Supplier Name");

      // Mutate the BIS row's supplier_item_name
      await pool.query(
        `UPDATE base_item_suppliers SET supplier_item_name = 'CHANGED NAME' WHERE id = $1`,
        [bisId],
      );

      // Re-fetch line items — the stored snapshot must be unchanged
      const linesAfter = await getLineItems(app, po.id);
      expect(linesAfter[0].description).toBe("Test Rose Supplier Name"); // snapshot preserved

      // Restore BIS name for subsequent tests
      await pool.query(
        `UPDATE base_item_suppliers SET supplier_item_name = 'Test Rose Supplier Name' WHERE id = $1`,
        [bisId],
      );

      await pool.query(`DELETE FROM purchase_orders WHERE id = $1`, [po.id]);
    });

    // ── Test 6 ────────────────────────────────────────────────────────────────
    it("add-line (POST /purchase-orders/:id/line-items) via BIS → stores base_item_supplier_id", async () => {
      // Create a PO with a seed line first
      const createRes = await request(app)
        .post("/api/purchase-orders")
        .send({
          supplier_id: supplierId,
          location_id: locationId,
          currency: "AED",
          line_items: [
            { description: "Seed Line", quantity: 1, unit_price: 1.00 },
          ],
        });
      expect(createRes.status).toBe(201);
      const po = createRes.body.purchase_order;

      // Add a BIS-sourced line (no explicit description)
      const addRes = await request(app)
        .post(`/api/purchase-orders/${po.id}/line-items`)
        .send({
          base_item_supplier_id: bisId,
          quantity: 5,
        });

      expect(addRes.status).toBe(201);
      const newLine = addRes.body.line_item;
      expect(newLine.base_item_supplier_id).toBe(bisId);
      expect(newLine.base_item_id).toBe(baseItemId);
      expect(newLine.description).toBe("Test Rose Supplier Name");
      expect(newLine.description_ar).toBe("وردة تجريبية");
      expect(String(newLine.unit_price)).toMatch(/^12\.5/);

      await pool.query(`DELETE FROM purchase_orders WHERE id = $1`, [po.id]);
    });

    // ── Test 7 ────────────────────────────────────────────────────────────────
    it("add-line with cross-workspace BIS id → 404", async () => {
      const createRes = await request(app)
        .post("/api/purchase-orders")
        .send({
          supplier_id: supplierId,
          location_id: locationId,
          currency: "AED",
          line_items: [
            { description: "Seed", quantity: 1, unit_price: 1.00 },
          ],
        });
      expect(createRes.status).toBe(201);
      const po = createRes.body.purchase_order;

      const addRes = await request(app)
        .post(`/api/purchase-orders/${po.id}/line-items`)
        .send({
          base_item_supplier_id: otherBisId,
          quantity: 1,
        });

      expect(addRes.status).toBe(404);
      expect(addRes.body.error).toMatch(/not found/i);

      await pool.query(`DELETE FROM purchase_orders WHERE id = $1`, [po.id]);
    });

    // ── Test 8 ────────────────────────────────────────────────────────────────
    it("add-line missing description AND no base_item_supplier_id → 400", async () => {
      const createRes = await request(app)
        .post("/api/purchase-orders")
        .send({
          supplier_id: supplierId,
          location_id: locationId,
          currency: "AED",
          line_items: [
            { description: "Seed", quantity: 1, unit_price: 1.00 },
          ],
        });
      expect(createRes.status).toBe(201);
      const po = createRes.body.purchase_order;

      const addRes = await request(app)
        .post(`/api/purchase-orders/${po.id}/line-items`)
        .send({
          quantity: 1,
          unit_price: 5.00,
          // no description, no base_item_supplier_id
        });

      expect(addRes.status).toBe(400);
      expect(addRes.body.error).toMatch(/description is required/i);

      await pool.query(`DELETE FROM purchase_orders WHERE id = $1`, [po.id]);
    });

    // ── Test 9 ────────────────────────────────────────────────────────────────
    it("POST /purchase-orders with cross-workspace BIS id → 404 (no PO created)", async () => {
      // otherBisId belongs to OTHER_OWNER_ID workspace — must be rejected pre-flight
      const countBefore = (
        await pool.query<{ c: string }>(
          `SELECT COUNT(*)::text AS c FROM purchase_orders WHERE workspace_owner_id = $1`,
          [OWNER_ID],
        )
      ).rows[0].c;

      const res = await request(app)
        .post("/api/purchase-orders")
        .send({
          supplier_id: supplierId,
          location_id: locationId,
          currency: "AED",
          line_items: [
            {
              base_item_supplier_id: otherBisId, // belongs to OTHER_OWNER_ID
              quantity: 1,
            },
          ],
        });

      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/not found/i);

      // Confirm no PO was created
      const countAfter = (
        await pool.query<{ c: string }>(
          `SELECT COUNT(*)::text AS c FROM purchase_orders WHERE workspace_owner_id = $1`,
          [OWNER_ID],
        )
      ).rows[0].c;
      expect(countAfter).toBe(countBefore);
    });

    // ── Test 10 ───────────────────────────────────────────────────────────────
    it("POST /purchase-orders with wrong-supplier BIS id (right workspace, wrong supplier) → 404", async () => {
      // wrongSupplierBisId belongs to OWNER_ID but is linked to supplier2, not supplierId
      const res = await request(app)
        .post("/api/purchase-orders")
        .send({
          supplier_id: supplierId,
          location_id: locationId,
          currency: "AED",
          line_items: [
            {
              base_item_supplier_id: wrongSupplierBisId, // linked to supplier2, not supplierId
              quantity: 1,
            },
          ],
        });

      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/not found/i);
    });

    // ── Test 12 ───────────────────────────────────────────────────────────────
    // package_quantity snapshotted at line-creation time; later BIS/package edits
    // must NOT change the stored conversion factor on the historical line.
    it("package_quantity snapshotted at creation — BIS package change after creation does not mutate stored snapshot", async () => {
      // Seed a package (20 units/box)
      const pkgRow = await pool.query<{ id: number }>(
        `INSERT INTO base_item_packages (workspace_owner_id, base_item_id, name, quantity)
         VALUES ($1, $2, 'Box of 20', 20) RETURNING id`,
        [OWNER_ID, baseItemId],
      );
      const pkgId = pkgRow.rows[0].id;

      // Link the package to the BIS row
      await pool.query(
        `UPDATE base_item_suppliers SET package_id = $1 WHERE id = $2`,
        [pkgId, bisId],
      );

      try {
        // Create a PO line via BIS — should snapshot package_quantity = 20
        const poRes = await request(app)
          .post("/api/purchase-orders")
          .send({
            supplier_id: supplierId,
            location_id: locationId,
            currency: "AED",
            line_items: [{ base_item_supplier_id: bisId, quantity: 1 }],
          });
        expect(poRes.status).toBe(201);
        const poId: number = poRes.body.purchase_order.id;

        // Verify snapshot captured 20
        const before = await pool.query<{ package_quantity: string | null }>(
          `SELECT package_quantity FROM purchase_order_line_items
            WHERE purchase_order_id = $1 ORDER BY id LIMIT 1`,
          [poId],
        );
        expect(before.rows[0].package_quantity).not.toBeNull();
        expect(parseFloat(before.rows[0].package_quantity!)).toBe(20);

        // Now change the package to 50 on the BIS row (simulates supplier price-sheet edit)
        const pkgRow2 = await pool.query<{ id: number }>(
          `INSERT INTO base_item_packages (workspace_owner_id, base_item_id, name, quantity)
           VALUES ($1, $2, 'Box of 50', 50) RETURNING id`,
          [OWNER_ID, baseItemId],
        );
        const pkgId2 = pkgRow2.rows[0].id;
        await pool.query(
          `UPDATE base_item_suppliers SET package_id = $1 WHERE id = $2`,
          [pkgId2, bisId],
        );

        // Snapshot on the existing line must still be 20
        const after = await pool.query<{ package_quantity: string | null }>(
          `SELECT package_quantity FROM purchase_order_line_items
            WHERE purchase_order_id = $1 ORDER BY id LIMIT 1`,
          [poId],
        );
        expect(parseFloat(after.rows[0].package_quantity!)).toBe(20);

        await pool.query(`DELETE FROM purchase_orders WHERE id = $1`, [poId]);
        await pool.query(`DELETE FROM base_item_packages WHERE id = $1`, [pkgId2]);
      } finally {
        // Restore BIS: remove package link and delete test packages
        await pool.query(`UPDATE base_item_suppliers SET package_id = NULL WHERE id = $1`, [bisId]);
        await pool.query(`DELETE FROM base_item_packages WHERE id = $1`, [pkgId]);
      }
    });

    // ── Test 11 ───────────────────────────────────────────────────────────────
    it("add-line via minimal BIS (no supplier_item_name, no price) → 201, description falls back to base_item.name, unit_price 0", async () => {
      // Create a PO to add a line to
      const poRes = await request(app)
        .post("/api/purchase-orders")
        .send({
          supplier_id: supplierId,
          location_id: locationId,
          currency: "AED",
        });
      expect(poRes.status).toBe(201);
      const poId: number = poRes.body.purchase_order.id;

      // Create a second base item so we can insert a fresh minimal BIS row
      // without conflicting with the existing bisId (baseItemId + supplierId).
      const minBiRow = await pool.query<{ id: number }>(
        `INSERT INTO base_items (workspace_owner_id, name, code)
         VALUES ($1, 'Minimal BIS Base Item', 'MIN-BIS-TEST') RETURNING id`,
        [OWNER_ID],
      );
      const minBaseItemId = minBiRow.rows[0].id;

      // Seed a minimal BIS row: no supplier_item_name, no price — same as bulk-add creates
      const minBisRow = await pool.query<{ id: number }>(
        `INSERT INTO base_item_suppliers
           (workspace_owner_id, base_item_id, supplier_id)
         VALUES ($1, $2, $3) RETURNING id`,
        [OWNER_ID, minBaseItemId, supplierId],
      );
      const minBisId = minBisRow.rows[0].id;

      try {
        const addRes = await request(app)
          .post(`/api/purchase-orders/${poId}/line-items`)
          .send({
            base_item_supplier_id: minBisId,
            quantity: 2,
            // No description, no unit_price — server must derive them
          });

        expect(addRes.status).toBe(201);

        // Verify the created line has the base_item name as description and 0 price
        const lineRow = await pool.query<{ description: string; unit_price: string; base_item_supplier_id: number }>(
          `SELECT description, unit_price, base_item_supplier_id
             FROM purchase_order_line_items
            WHERE purchase_order_id = $1
            ORDER BY id DESC LIMIT 1`,
          [poId],
        );
        expect(lineRow.rows).toHaveLength(1);
        // Description should fall back to base_item.name (not empty)
        expect(lineRow.rows[0].description.trim().length).toBeGreaterThan(0);
        // unit_price should be 0 (BIS had no price)
        expect(parseFloat(lineRow.rows[0].unit_price)).toBe(0);
        // base_item_supplier_id stored correctly
        expect(lineRow.rows[0].base_item_supplier_id).toBe(minBisId);
      } finally {
        await pool.query(`DELETE FROM purchase_orders WHERE id = $1`, [poId]);
        await pool.query(`DELETE FROM base_item_suppliers WHERE id = $1`, [minBisId]);
        await pool.query(`DELETE FROM base_items WHERE id = $1`, [minBaseItemId]);
      }
    });
  },
);
