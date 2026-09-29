/**
 * Integration tests: auto-tax resolution on purchase order line items
 *
 * Verifies that the tax_rules SQL query — including the location-specific vs
 * country-fallback ORDER BY — works correctly end-to-end against a real
 * Postgres instance:
 *
 *   - A location-specific rule takes precedence over a country-only fallback
 *   - When no location-specific rule exists, the country fallback is used
 *   - Posting a line item whose base item has tax_category = "not_classified"
 *     inserts no tax fields (applied_tax_rate / tax_amount / taxable_amount are null)
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

const OWNER_ID = "__integration_test_po_tax__";
const USER_ID = "__integration_test_po_tax_user__";

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
    wreq.userEmail = "po-tax-test@example.com";
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

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!DATABASE_URL)(
  "Purchase order auto-tax resolution integration tests",
  () => {
    let pool: InstanceType<typeof Pool>;
    let app: express.Express;

    // Seeded IDs
    let supplierId: number;
    let locationSpecificId: number;   // has a location-scoped tax rule
    let locationFallbackId: number;   // no location-scoped rule; relies on country fallback
    let baseItemTaxableId: number;    // tax_category = 'standard_taxable'
    let baseItemNotClassifiedId: number; // tax_category = 'not_classified'

    // PO IDs — one per location so each test gets a clean PO
    let poSpecificLocationId: number;
    let poFallbackLocationId: number;

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL });
      app = makeApp();

      // ── Clean up any leftovers from a previous failed run ──────────────────
      await pool.query(
        `DELETE FROM purchase_order_line_items
           WHERE purchase_order_id IN (
             SELECT id FROM purchase_orders WHERE workspace_owner_id = $1
           )`,
        [OWNER_ID],
      );
      await pool.query(`DELETE FROM purchase_orders WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM tax_rules WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM locations WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM suppliers WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM base_items WHERE workspace_owner_id = $1`, [OWNER_ID]);

      // ── Supplier ───────────────────────────────────────────────────────────
      const supplierResult = await pool.query<{ id: number }>(
        `INSERT INTO suppliers (workspace_owner_id, name)
         VALUES ($1, 'Tax Test Supplier') RETURNING id`,
        [OWNER_ID],
      );
      supplierId = supplierResult.rows[0].id;

      // ── Locations (both in country 'AE') ──────────────────────────────────
      const locSpecResult = await pool.query<{ id: number }>(
        `INSERT INTO locations (workspace_owner_id, name, country)
         VALUES ($1, 'Tax Location Specific', 'AE') RETURNING id`,
        [OWNER_ID],
      );
      locationSpecificId = locSpecResult.rows[0].id;

      const locFallResult = await pool.query<{ id: number }>(
        `INSERT INTO locations (workspace_owner_id, name, country)
         VALUES ($1, 'Tax Location Fallback', 'AE') RETURNING id`,
        [OWNER_ID],
      );
      locationFallbackId = locFallResult.rows[0].id;

      // ── Tax rules ─────────────────────────────────────────────────────────
      // Location-specific rule: 5 % for standard_taxable at locationSpecific
      await pool.query(
        `INSERT INTO tax_rules
           (workspace_owner_id, country_code, location_id, tax_category, rate_percent, is_active, effective_from)
         VALUES ($1, 'AE', $2, 'standard_taxable', 5.0000, true, CURRENT_DATE)`,
        [OWNER_ID, locationSpecificId],
      );

      // Country-level fallback rule: 15 % for standard_taxable — no location_id
      await pool.query(
        `INSERT INTO tax_rules
           (workspace_owner_id, country_code, location_id, tax_category, rate_percent, is_active, effective_from)
         VALUES ($1, 'AE', NULL, 'standard_taxable', 15.0000, true, CURRENT_DATE)`,
        [OWNER_ID],
      );

      // ── Base items ────────────────────────────────────────────────────────
      const biTaxableResult = await pool.query<{ id: number }>(
        `INSERT INTO base_items (workspace_owner_id, name, code, tax_category)
         VALUES ($1, 'Taxable Item', 'TAX-TAXABLE', 'standard_taxable') RETURNING id`,
        [OWNER_ID],
      );
      baseItemTaxableId = biTaxableResult.rows[0].id;

      const biNotClassResult = await pool.query<{ id: number }>(
        `INSERT INTO base_items (workspace_owner_id, name, code, tax_category)
         VALUES ($1, 'Not Classified Item', 'TAX-NOT-CLASS', 'not_classified') RETURNING id`,
        [OWNER_ID],
      );
      baseItemNotClassifiedId = biNotClassResult.rows[0].id;

      // ── Purchase orders (one per location) ───────────────────────────────
      const poSpecResult = await pool.query<{ id: number }>(
        `INSERT INTO purchase_orders
           (workspace_owner_id, supplier_id, status, currency, location_id, updated_at)
         VALUES ($1, $2, 'sent', 'AED', $3, now())
         RETURNING id`,
        [OWNER_ID, supplierId, locationSpecificId],
      );
      poSpecificLocationId = poSpecResult.rows[0].id;

      const poFallResult = await pool.query<{ id: number }>(
        `INSERT INTO purchase_orders
           (workspace_owner_id, supplier_id, status, currency, location_id, updated_at)
         VALUES ($1, $2, 'sent', 'AED', $3, now())
         RETURNING id`,
        [OWNER_ID, supplierId, locationFallbackId],
      );
      poFallbackLocationId = poFallResult.rows[0].id;
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
      await pool.query(`DELETE FROM purchase_orders WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM tax_rules WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM locations WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM suppliers WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM base_items WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.end();
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Scenario 1: location-specific rule takes precedence over country fallback
    // ─────────────────────────────────────────────────────────────────────────

    it("uses the location-specific tax rule (5 %) when both a location rule and a country fallback exist", async () => {
      const res = await request(app)
        .post(`/purchase-orders/${poSpecificLocationId}/line-items`)
        .send({
          base_item_id: baseItemTaxableId,
          description: "Taxable line — specific location",
          quantity: "1",
          unit_price: "100.00",
        });

      expect(res.status).toBe(201);

      const li = res.body.line_item;
      expect(li.tax_category).toBe("standard_taxable");
      expect(parseFloat(li.applied_tax_rate)).toBe(5);
      expect(parseFloat(li.taxable_amount)).toBeCloseTo(100, 2);
      // tax_amount = 100 * 5 / 100 = 5.00
      expect(parseFloat(li.tax_amount)).toBeCloseTo(5, 2);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Scenario 2: country-level fallback is used when no location-specific rule
    // ─────────────────────────────────────────────────────────────────────────

    it("falls back to the country-level tax rule (15 %) when no location-specific rule matches", async () => {
      const res = await request(app)
        .post(`/purchase-orders/${poFallbackLocationId}/line-items`)
        .send({
          base_item_id: baseItemTaxableId,
          description: "Taxable line — fallback location",
          quantity: "1",
          unit_price: "200.00",
        });

      expect(res.status).toBe(201);

      const li = res.body.line_item;
      expect(li.tax_category).toBe("standard_taxable");
      expect(parseFloat(li.applied_tax_rate)).toBe(15);
      expect(parseFloat(li.taxable_amount)).toBeCloseTo(200, 2);
      // tax_amount = 200 * 15 / 100 = 30.00
      expect(parseFloat(li.tax_amount)).toBeCloseTo(30, 2);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Scenario 3: tax_category = "not_classified" → no tax fields populated
    // ─────────────────────────────────────────────────────────────────────────

    it("inserts no tax fields when the base item has tax_category = 'not_classified'", async () => {
      const res = await request(app)
        .post(`/purchase-orders/${poSpecificLocationId}/line-items`)
        .send({
          base_item_id: baseItemNotClassifiedId,
          description: "Non-taxable line",
          quantity: "3",
          unit_price: "50.00",
        });

      expect(res.status).toBe(201);

      const li = res.body.line_item;
      expect(li.tax_category).toBe("not_classified");
      expect(li.applied_tax_rate).toBeNull();
      expect(li.taxable_amount).toBeNull();
      expect(li.tax_amount).toBeNull();
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Scenario 4: verify the precedence math with a multi-unit line item
    // ─────────────────────────────────────────────────────────────────────────

    it("calculates tax_amount correctly from quantity × unit_price with the location-specific rate", async () => {
      const res = await request(app)
        .post(`/purchase-orders/${poSpecificLocationId}/line-items`)
        .send({
          base_item_id: baseItemTaxableId,
          description: "Multi-unit taxable line",
          quantity: "4",
          unit_price: "25.00",
        });

      expect(res.status).toBe(201);

      const li = res.body.line_item;
      // net = 4 × 25 = 100; rate = 5 %; tax = 5.00
      expect(parseFloat(li.taxable_amount)).toBeCloseTo(100, 2);
      expect(parseFloat(li.applied_tax_rate)).toBe(5);
      expect(parseFloat(li.tax_amount)).toBeCloseTo(5, 2);
    });
  },
);
