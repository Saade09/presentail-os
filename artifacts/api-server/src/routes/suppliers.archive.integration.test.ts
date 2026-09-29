/**
 * Integration test: verifies that soft-archiving a supplier (is_archived = true)
 * does NOT break the GET /suppliers/:id/spend-trend HTTP endpoint.
 *
 * The spend-trend route's supplier-existence check is:
 *   SELECT id FROM suppliers WHERE id = $1 AND workspace_owner_id = $2
 * — it deliberately omits is_archived, so archived suppliers must still respond
 * with HTTP 200 and the correct aggregated totals.
 *
 * Auth + workspace middleware are mocked so no Clerk session is required.
 * db (pg.Pool) is the real singleton pointed at the integration test database.
 *
 * Skips automatically when DATABASE_URL is not set.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import pg from "pg";
import type { WorkspaceRequest } from "../lib/workspace";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;

const OWNER_ID = "__archive_spend_trend_owner__";

// ─────────────────────────────────────────────────────────────────────────────
// Mocks: auth + workspace + logger + clerkClient.
// db is intentionally NOT mocked — it points to the real integration database.
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
    wreq.userId = OWNER_ID;
    wreq.userEmail = "archive-test-owner@example.com";
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

// Imports MUST come AFTER vi.mock declarations so hoisting applies correctly.
import suppliersRouter from "./suppliers";

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(suppliersRouter);
  return app;
}

async function cleanUp(pool: InstanceType<typeof Pool>): Promise<void> {
  await pool.query(
    `DELETE FROM suppliers WHERE workspace_owner_id = $1`,
    [OWNER_ID],
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!DATABASE_URL)(
  "GET /suppliers/:id/spend-trend — archived supplier (HTTP integration)",
  () => {
    let pool: InstanceType<typeof Pool>;
    const app = makeApp();

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL });
      await cleanUp(pool);
    });

    afterAll(async () => {
      if (!pool) return;
      await cleanUp(pool);
      await pool.end();
    });

    it("returns HTTP 200 with correct totals after the supplier is archived", async () => {
      const { rows } = await pool.query<{ id: number }>(
        `INSERT INTO suppliers (workspace_owner_id, name, currency_pref)
         VALUES ($1, 'Archived SpendTrend HTTP Supplier', 'AED') RETURNING id`,
        [OWNER_ID],
      );
      const supplierId = rows[0].id;
      const currentYear = new Date().getFullYear();

      await pool.query(
        `INSERT INTO supplier_invoices
           (supplier_id, workspace_owner_id, amount, currency, status, issued_at)
         VALUES
           ($1, $2, 2000, 'AED', 'paid',      make_timestamptz($3, 2, 10, 0, 0, 0)),
           ($1, $2,  800, 'AED', 'issued',    make_timestamptz($3, 4, 5, 0, 0, 0)),
           ($1, $2,  150, 'AED', 'cancelled', make_timestamptz($3, 4, 20, 0, 0, 0))`,
        [supplierId, OWNER_ID, currentYear],
      );

      await pool.query(
        `UPDATE suppliers SET is_archived = true WHERE id = $1`,
        [supplierId],
      );

      const res = await request(app)
        .get(`/suppliers/${supplierId}/spend-trend`)
        .query({ year: currentYear })
        .expect(200);

      expect(res.body.year, "response year must match the requested year").toBe(currentYear);
      expect(Array.isArray(res.body.months), "months must be an array").toBe(true);
      expect(res.body.months).toHaveLength(12);

      const feb = res.body.months.find((m: { month: number }) => m.month === 2);
      expect(feb, "February must be present").toBeDefined();
      expect(feb.total, "February paid invoice must be included").toBe(2000);

      const apr = res.body.months.find((m: { month: number }) => m.month === 4);
      expect(apr, "April must be present").toBeDefined();
      expect(apr.total, "April cancelled invoice must be excluded; only issued 800 counts").toBe(800);

      const otherMonths = res.body.months.filter(
        (m: { month: number; total: number }) => m.month !== 2 && m.month !== 4,
      );
      for (const m of otherMonths) {
        expect(m.total, `month ${m.month} must have a zero total`).toBe(0);
      }
    });

    it("returns HTTP 404 when the supplier does not exist (sanity check)", async () => {
      await request(app)
        .get(`/suppliers/999999999/spend-trend`)
        .expect(404);
    });

    it("archived supplier is still returned by the route even without is_archived filter", async () => {
      const { rows } = await pool.query<{ id: number }>(
        `INSERT INTO suppliers (workspace_owner_id, name)
         VALUES ($1, 'Archived Exist Check Supplier') RETURNING id`,
        [OWNER_ID],
      );
      const supplierId = rows[0].id;

      await pool.query(
        `UPDATE suppliers SET is_archived = true WHERE id = $1`,
        [supplierId],
      );

      const res = await request(app)
        .get(`/suppliers/${supplierId}/spend-trend`)
        .expect(200);

      expect(res.body.months, "months array must be returned for an archived supplier with no invoices").toHaveLength(12);
      const allZero = (res.body.months as Array<{ total: number }>).every((m) => m.total === 0);
      expect(allZero, "all months must be zero when no invoices exist").toBe(true);
    });
  },
);
