/**
 * Integration tests for GET /suppliers/:id/spend-trend
 *
 * Verifies:
 *   - Always returns exactly 12 months for the current calendar year
 *   - Correctly sums non-cancelled invoice amounts per month
 *   - Excludes cancelled invoices from monthly totals
 *   - Excludes invoices dated in a different year
 *   - Returns 404 for an unknown supplier id
 *   - Returns 400 for a non-numeric supplier id
 *
 * Auth and workspace middleware are stubbed; the database is real.
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
// Unique owner ID so tests never collide with real workspace data
// ─────────────────────────────────────────────────────────────────────────────

const OWNER_ID = "__integration_test_supplier_spend_trend__";
const USER_ID = "__integration_test_sst_user__";

// ─────────────────────────────────────────────────────────────────────────────
// Mocks — auth / workspace / logger / clerkClient only. db is NOT mocked.
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
    wreq.userEmail = "sst-test@example.com";
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

// ─────────────────────────────────────────────────────────────────────────────
// Import the router AFTER vi.mock declarations (hoisting boundary)
// ─────────────────────────────────────────────────────────────────────────────

import suppliersRouter from "./suppliers";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(suppliersRouter);
  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!DATABASE_URL)(
  "GET /suppliers/:id/spend-trend integration tests",
  () => {
    let pool: InstanceType<typeof Pool>;
    let app: express.Express;
    let supplierId: number;
    const currentYear = new Date().getFullYear();

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL });
      app = makeApp();

      // Wipe any leftovers from a previous failed run
      await pool.query(
        `DELETE FROM supplier_invoices WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM suppliers WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );

      // Seed a supplier with a known currency preference
      const supplierResult = await pool.query<{ id: number }>(
        `INSERT INTO suppliers (workspace_owner_id, name, currency_pref)
         VALUES ($1, 'Trend Supplier', 'AED') RETURNING id`,
        [OWNER_ID],
      );
      supplierId = supplierResult.rows[0].id;

      // Seed invoices for the current year:
      //   Jan: 100 (issued) + 50 (paid) = 150
      //   Mar: 200 (issued) + 75 (cancelled — excluded) = 200
      //   Jun: 300 (paid)
      // All other months: no invoices → total 0
      await pool.query(
        `INSERT INTO supplier_invoices
           (supplier_id, workspace_owner_id, amount, currency, status, issued_at)
         VALUES
           ($1, $2, 100, 'AED', 'issued',    make_date($3, 1, 15)),
           ($1, $2,  50, 'AED', 'paid',      make_date($3, 1, 20)),
           ($1, $2, 200, 'AED', 'issued',    make_date($3, 3, 10)),
           ($1, $2,  75, 'AED', 'cancelled', make_date($3, 3, 10)),
           ($1, $2, 300, 'AED', 'paid',      make_date($3, 6,  1))`,
        [supplierId, OWNER_ID, currentYear],
      );

      // Seed an invoice for the previous year — must NOT appear in results
      await pool.query(
        `INSERT INTO supplier_invoices
           (supplier_id, workspace_owner_id, amount, currency, status, issued_at)
         VALUES ($1, $2, 9999, 'AED', 'paid', make_date($3, 6, 1))`,
        [supplierId, OWNER_ID, currentYear - 1],
      );
    });

    afterAll(async () => {
      if (!pool) return;
      await pool.query(
        `DELETE FROM supplier_invoices WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM suppliers WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      await pool.end();
    });

    // ─────────────────────────────────────────────────────────────────────
    // Happy path
    // ─────────────────────────────────────────────────────────────────────

    it("returns exactly 12 months for the current year", async () => {
      const res = await request(app).get(`/suppliers/${supplierId}/spend-trend`);

      expect(res.status).toBe(200);
      expect(res.body.year).toBe(currentYear);
      expect(Array.isArray(res.body.months)).toBe(true);
      expect(res.body.months).toHaveLength(12);

      const monthNumbers: number[] = res.body.months.map(
        (m: { month: number }) => m.month,
      );
      expect(monthNumbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    });

    it("correctly sums non-cancelled invoices per month", async () => {
      const res = await request(app).get(`/suppliers/${supplierId}/spend-trend`);

      expect(res.status).toBe(200);
      const months: Array<{ month: number; total: number }> = res.body.months;

      const byMonth = Object.fromEntries(months.map((m) => [m.month, m.total]));

      // January: 100 + 50 = 150
      expect(byMonth[1]).toBe(150);
      // March: 200 (cancelled 75 is excluded)
      expect(byMonth[3]).toBe(200);
      // June: 300
      expect(byMonth[6]).toBe(300);
    });

    it("returns zero for months with no invoices", async () => {
      const res = await request(app).get(`/suppliers/${supplierId}/spend-trend`);

      expect(res.status).toBe(200);
      const months: Array<{ month: number; total: number }> = res.body.months;

      const emptyMonths = [2, 4, 5, 7, 8, 9, 10, 11, 12];
      for (const m of emptyMonths) {
        const row = months.find((r) => r.month === m);
        expect(row).toBeDefined();
        expect(row!.total).toBe(0);
      }
    });

    it("excludes cancelled invoices from monthly totals", async () => {
      const res = await request(app).get(`/suppliers/${supplierId}/spend-trend`);

      expect(res.status).toBe(200);
      const months: Array<{ month: number; total: number }> = res.body.months;

      // March had a 75 cancelled invoice; only the 200 issued one should count
      const march = months.find((m) => m.month === 3)!;
      expect(march.total).toBe(200);
    });

    it("excludes invoices from a different year", async () => {
      const res = await request(app).get(`/suppliers/${supplierId}/spend-trend`);

      expect(res.status).toBe(200);
      const months: Array<{ month: number; total: number }> = res.body.months;

      // The previous-year 9999 invoice was also in June; it must not be counted
      const june = months.find((m) => m.month === 6)!;
      expect(june.total).toBe(300);
    });

    it("returns the supplier currency", async () => {
      const res = await request(app).get(`/suppliers/${supplierId}/spend-trend`);

      expect(res.status).toBe(200);
      expect(res.body.currency).toBe("AED");
    });

    it("returns zero totals for a supplier with no invoices in the current year", async () => {
      // Insert a separate supplier with no invoices
      const emptyResult = await pool.query<{ id: number }>(
        `INSERT INTO suppliers (workspace_owner_id, name, currency_pref)
         VALUES ($1, 'Empty Supplier', 'USD') RETURNING id`,
        [OWNER_ID],
      );
      const emptySupplierId = emptyResult.rows[0].id;

      const res = await request(app).get(
        `/suppliers/${emptySupplierId}/spend-trend`,
      );

      expect(res.status).toBe(200);
      expect(res.body.months).toHaveLength(12);
      for (const m of res.body.months as Array<{ total: number }>) {
        expect(m.total).toBe(0);
      }

      await pool.query(`DELETE FROM suppliers WHERE id = $1`, [emptySupplierId]);
    });

    // ─────────────────────────────────────────────────────────────────────
    // Error cases
    // ─────────────────────────────────────────────────────────────────────

    it("returns 404 for an unknown supplier id", async () => {
      const res = await request(app).get("/suppliers/999999999/spend-trend");

      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/not found/i);
    });

    it("returns 400 for a non-numeric supplier id", async () => {
      const res = await request(app).get("/suppliers/abc/spend-trend");

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/invalid supplier id/i);
    });
  },
);
