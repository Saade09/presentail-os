/**
 * Integration tests: archived suppliers are excluded from the active supplier
 * list but their historical invoices and purchase orders remain accessible.
 *
 * Verifies:
 *   - GET /suppliers (no include_archived) — archived supplier is NOT returned
 *   - GET /suppliers/:id/invoices — returns HTTP 200 with all historical invoices
 *   - GET /purchase-orders?supplier_id=N — returns HTTP 200 with all historical POs
 *
 * Auth and workspace middleware are stubbed. The database is real.
 * The suite skips automatically when DATABASE_URL is not set.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import pg from "pg";
import type { WorkspaceRequest } from "../lib/workspace";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;

const OWNER_ID = "__archived_supplier_http_test_owner__";
const USER_ID = "__archived_supplier_http_test_user__";

// ─────────────────────────────────────────────────────────────────────────────
// Mocks — auth / workspace / logger / email / clerk only. db is NOT mocked.
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
  authed: (req: express.Request) => ({ ...req, userId: USER_ID }),
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
    wreq.userEmail = "archived-supplier-test@example.com";
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

// Import routers AFTER vi.mock declarations (hoisting boundary)
import suppliersRouter from "./suppliers";
import purchaseOrdersRouter from "./purchaseOrders";

// ─────────────────────────────────────────────────────────────────────────────
// Express app fixture
// ─────────────────────────────────────────────────────────────────────────────

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(suppliersRouter);
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
  "Archived supplier — HTTP endpoint behaviour (integration)",
  () => {
    let pool: InstanceType<typeof Pool>;
    let app: express.Express;
    let activeSupplierId: number;
    let archivedSupplierId: number;

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL });
      app = makeApp();

      // Wipe any leftovers from a previous failed run
      await pool.query(`DELETE FROM suppliers WHERE workspace_owner_id = $1`, [OWNER_ID]);

      // Seed an active supplier that should always appear in the default list
      const activeResult = await pool.query<{ id: number }>(
        `INSERT INTO suppliers (workspace_owner_id, name)
         VALUES ($1, 'HTTP Test Active Supplier') RETURNING id`,
        [OWNER_ID],
      );
      activeSupplierId = activeResult.rows[0].id;

      // Seed the supplier that will be archived after data is attached
      const archivedResult = await pool.query<{ id: number }>(
        `INSERT INTO suppliers (workspace_owner_id, name, currency_pref)
         VALUES ($1, 'HTTP Test Archived Supplier', 'AED') RETURNING id`,
        [OWNER_ID],
      );
      archivedSupplierId = archivedResult.rows[0].id;

      // Attach two invoices to the supplier before archiving
      await pool.query(
        `INSERT INTO supplier_invoices
           (supplier_id, workspace_owner_id, amount, currency, status, issued_at)
         VALUES
           ($1, $2, 800,  'AED', 'paid',   NOW() - INTERVAL '3 months'),
           ($1, $2, 400,  'AED', 'issued', NOW() - INTERVAL '1 month')`,
        [archivedSupplierId, OWNER_ID],
      );

      // Attach two purchase orders (with line items) to the supplier before archiving
      const poResult = await pool.query<{ id: number }>(
        `INSERT INTO purchase_orders (workspace_owner_id, supplier_id, status)
         VALUES ($1, $2, 'received'),
                ($1, $2, 'sent')
         RETURNING id`,
        [OWNER_ID, archivedSupplierId],
      );
      const poId = poResult.rows[0].id;

      await pool.query(
        `INSERT INTO purchase_order_line_items
           (purchase_order_id, description, quantity, unit_price, currency)
         VALUES
           ($1, 'Widget A', 10, 5.00, 'AED'),
           ($1, 'Widget B',  3, 15.00, 'AED')`,
        [poId],
      );

      // Now archive the supplier
      await pool.query(`UPDATE suppliers SET is_archived = true WHERE id = $1`, [archivedSupplierId]);
    });

    afterAll(async () => {
      if (!pool) return;
      // CASCADE will clean up invoices, POs, and line items
      await pool.query(`DELETE FROM suppliers WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.end();
    });

    // ─────────────────────────────────────────────────────────────────────
    // GET /suppliers — default (no include_archived)
    // ─────────────────────────────────────────────────────────────────────

    it("GET /suppliers excludes the archived supplier from the default response", async () => {
      const res = await request(app).get("/suppliers");

      expect(res.status).toBe(200);
      expect(res.body.suppliers).toBeDefined();

      const ids: number[] = res.body.suppliers.map((s: { id: number }) => s.id);
      expect(ids).toContain(activeSupplierId);
      expect(ids).not.toContain(archivedSupplierId);
    });

    it("GET /suppliers?include_archived=true includes the archived supplier", async () => {
      const res = await request(app).get("/suppliers?include_archived=true");

      expect(res.status).toBe(200);
      const ids: number[] = res.body.suppliers.map((s: { id: number }) => s.id);
      expect(ids).toContain(archivedSupplierId);
    });

    // ─────────────────────────────────────────────────────────────────────
    // GET /suppliers/:id/invoices — historical invoices still visible
    // ─────────────────────────────────────────────────────────────────────

    it("GET /suppliers/:id/invoices returns HTTP 200 for an archived supplier", async () => {
      const res = await request(app).get(`/suppliers/${archivedSupplierId}/invoices`);
      expect(res.status).toBe(200);
    });

    it("GET /suppliers/:id/invoices returns all pre-archive historical invoices", async () => {
      const res = await request(app).get(`/suppliers/${archivedSupplierId}/invoices`);

      expect(res.status).toBe(200);
      expect(res.body.invoices).toBeDefined();
      expect(res.body.invoice_count).toBe(2);
      expect(res.body.invoices).toHaveLength(2);

      const statuses: string[] = res.body.invoices.map((inv: { status: string }) => inv.status);
      expect(statuses).toContain("paid");
      expect(statuses).toContain("issued");
    });

    it("GET /suppliers/:id/invoices includes spend_ytd aggregate for an archived supplier", async () => {
      const res = await request(app).get(`/suppliers/${archivedSupplierId}/invoices`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("spend_ytd");
      expect(parseFloat(res.body.spend_ytd)).toBeGreaterThanOrEqual(0);
    });

    // ─────────────────────────────────────────────────────────────────────
    // GET /purchase-orders?supplier_id=N — historical POs still visible
    // ─────────────────────────────────────────────────────────────────────

    it("GET /purchase-orders?supplier_id=N returns HTTP 200 for an archived supplier", async () => {
      const res = await request(app).get(
        `/purchase-orders?supplier_id=${archivedSupplierId}`,
      );
      expect(res.status).toBe(200);
    });

    it("GET /purchase-orders?supplier_id=N returns all pre-archive historical POs", async () => {
      const res = await request(app).get(
        `/purchase-orders?supplier_id=${archivedSupplierId}`,
      );

      expect(res.status).toBe(200);
      expect(res.body.purchase_orders).toBeDefined();
      expect(res.body.purchase_orders).toHaveLength(2);

      const statuses: string[] = res.body.purchase_orders.map(
        (po: { status: string }) => po.status,
      );
      expect(statuses).toContain("received");
      expect(statuses).toContain("sent");
    });

    it("GET /purchase-orders?supplier_id=N includes line_items_count for archived supplier POs", async () => {
      const res = await request(app).get(
        `/purchase-orders?supplier_id=${archivedSupplierId}`,
      );

      expect(res.status).toBe(200);
      const receivedPo = res.body.purchase_orders.find(
        (po: { status: string }) => po.status === "received",
      );
      expect(receivedPo).toBeDefined();
      expect(receivedPo.line_items_count).toBe(2);
    });
  },
);
