/**
 * Integration test: GET /api/cash-bills consolidated bill report.
 *
 * Background: bills (cash_transactions with type='bill') were only visible on
 * the individual cash session detail page. The new GET /cash-bills route
 * aggregates every bill across all sessions for a workspace, with drawer /
 * location context and the invoice attachment path, filterable by location and
 * date range. Because the route is raw SQL with several joins, this test runs
 * it against a real PostgreSQL database to catch column-name drift that mock
 * tests cannot.
 *
 * Auth / workspace / logger / object storage middleware are stubbed (same
 * pattern as workshopSales.cashRefund.integration.test.ts); the database is
 * real. The suite skips automatically when DATABASE_URL is not set.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import pg from "pg";
import type { WorkspaceRequest } from "../lib/workspace";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;

const OWNER_ID = "__test_cash_bills__";
const USER_ID = "__test_cash_bills_user__";

vi.mock("../lib/auth", () => ({
  requireAuth: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => next(),
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
    wreq.userEmail = "cash-bills@example.com";
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

vi.mock("../lib/objectStorage", () => ({
  objectStorageClient: {
    bucket: vi.fn(),
  },
}));

// Clerk name resolution is best-effort; stub it so the test needs no creds.
vi.mock("@clerk/express", () => ({
  clerkClient: {
    users: {
      getUserList: vi.fn().mockResolvedValue({ data: [] }),
    },
  },
}));

import cashSessionsRouter from "./cashSessions";

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: express.Request & { log?: unknown }, _res, next) => {
    req.log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn().mockReturnThis(),
    } as unknown as express.Request["log"];
    next();
  });
  app.use(cashSessionsRouter);
  return app;
}

describe.skipIf(!DATABASE_URL)("GET /cash-bills — consolidated bill report (integration)", () => {
  let pool: InstanceType<typeof Pool>;
  let app: express.Express;
  let locationA: number;
  let locationB: number;
  let drawerId: number;
  let sessionId: number;

  async function cleanup(): Promise<void> {
    await pool.query(`DELETE FROM cash_transactions WHERE workspace_owner_id = $1`, [OWNER_ID]);
    await pool.query(`DELETE FROM cash_session_activity_logs WHERE workspace_owner_id = $1`, [OWNER_ID]);
    await pool.query(`DELETE FROM cash_sessions WHERE workspace_owner_id = $1`, [OWNER_ID]);
    await pool.query(`DELETE FROM cash_drawers WHERE workspace_owner_id = $1`, [OWNER_ID]);
    await pool.query(`DELETE FROM locations WHERE workspace_owner_id = $1`, [OWNER_ID]);
  }

  async function insertBill(opts: {
    locationId: number;
    amount: number;
    currency?: string;
    description: string;
    attachmentUrl?: string | null;
    date: string;
  }): Promise<void> {
    await pool.query(
      `INSERT INTO cash_transactions
         (workspace_owner_id, cash_session_id, cash_drawer_id, location_id, currency,
          type, direction, amount, description, reference_type, attachment_url,
          created_by_clerk_id, transaction_date)
       VALUES ($1, $2, $3, $4, $5, 'bill', 'out', $6, $7, 'bill', $8, $9, $10)`,
      [
        OWNER_ID,
        sessionId,
        drawerId,
        opts.locationId,
        opts.currency ?? "AED",
        opts.amount.toFixed(2),
        opts.description,
        opts.attachmentUrl ?? null,
        USER_ID,
        opts.date,
      ],
    );
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    app = makeApp();
    await cleanup();

    const locA = await pool.query<{ id: number }>(
      `INSERT INTO locations (workspace_owner_id, name) VALUES ($1, $2) RETURNING id`,
      [OWNER_ID, "Bills Location A"],
    );
    locationA = locA.rows[0].id;
    const locB = await pool.query<{ id: number }>(
      `INSERT INTO locations (workspace_owner_id, name) VALUES ($1, $2) RETURNING id`,
      [OWNER_ID, "Bills Location B"],
    );
    locationB = locB.rows[0].id;

    const drawer = await pool.query<{ id: number }>(
      `INSERT INTO cash_drawers (workspace_owner_id, name, code, location_id, currency)
       VALUES ($1, 'Bills Drawer', 'BDRW', $2, 'AED') RETURNING id`,
      [OWNER_ID, locationA],
    );
    drawerId = drawer.rows[0].id;

    const session = await pool.query<{ id: number }>(
      `INSERT INTO cash_sessions
         (workspace_owner_id, session_number, drawer_id, location_id, currency,
          status, opening_cash, expected_cash)
       VALUES ($1, 'CS-BILLS-1', $2, $3, 'AED', 'open', '0.00', '0.00')
       RETURNING id`,
      [OWNER_ID, drawerId, locationA],
    );
    sessionId = session.rows[0].id;
  });

  afterAll(async () => {
    if (!pool) return;
    await cleanup();
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM cash_transactions WHERE workspace_owner_id = $1`, [OWNER_ID]);
  });

  it("returns all bills with session/drawer/location context and invoice path", async () => {
    await insertBill({
      locationId: locationA,
      amount: 30,
      description: "Office supplies",
      attachmentUrl: `/objects/${OWNER_ID}/cash-bills/inv1`,
      date: "2026-06-10T10:00:00Z",
    });

    const res = await request(app).get("/cash-bills");
    expect(res.status).toBe(200);
    expect(res.body.bills).toHaveLength(1);
    const bill = res.body.bills[0];
    expect(bill.description).toBe("Office supplies");
    expect(bill.drawer_name).toBe("Bills Drawer");
    expect(bill.location_name).toBe("Bills Location A");
    expect(bill.session_number).toBe("CS-BILLS-1");
    expect(bill.attachment_url).toBe(`/objects/${OWNER_ID}/cash-bills/inv1`);
    expect(Number(bill.amount)).toBeCloseTo(30, 2);
  });

  it("only includes type='bill' transactions, not sales/adjustments", async () => {
    await insertBill({ locationId: locationA, amount: 30, description: "A bill", date: "2026-06-10T10:00:00Z" });
    await pool.query(
      `INSERT INTO cash_transactions
         (workspace_owner_id, cash_session_id, cash_drawer_id, location_id, currency,
          type, direction, amount, description, transaction_date)
       VALUES ($1, $2, $3, $4, 'AED', 'sale', 'in', '50.00', 'a sale', '2026-06-10T11:00:00Z')`,
      [OWNER_ID, sessionId, drawerId, locationA],
    );

    const res = await request(app).get("/cash-bills");
    expect(res.status).toBe(200);
    expect(res.body.bills).toHaveLength(1);
    expect(res.body.bills[0].description).toBe("A bill");
  });

  it("filters by location_id", async () => {
    await insertBill({ locationId: locationA, amount: 30, description: "A-bill", date: "2026-06-10T10:00:00Z" });
    await insertBill({ locationId: locationB, amount: 40, description: "B-bill", date: "2026-06-10T10:00:00Z" });

    const res = await request(app).get(`/cash-bills?location_id=${locationB}`);
    expect(res.status).toBe(200);
    expect(res.body.bills).toHaveLength(1);
    expect(res.body.bills[0].description).toBe("B-bill");
  });

  it("filters by date range (from/to on transaction_date)", async () => {
    await insertBill({ locationId: locationA, amount: 10, description: "old", date: "2026-05-01T10:00:00Z" });
    await insertBill({ locationId: locationA, amount: 20, description: "in-range", date: "2026-06-15T10:00:00Z" });
    await insertBill({ locationId: locationA, amount: 30, description: "future", date: "2026-07-01T10:00:00Z" });

    const res = await request(app).get("/cash-bills?from=2026-06-01&to=2026-06-30");
    expect(res.status).toBe(200);
    expect(res.body.bills).toHaveLength(1);
    expect(res.body.bills[0].description).toBe("in-range");
  });

  it("summary totals bills per currency without FX mixing", async () => {
    await insertBill({ locationId: locationA, amount: 30, currency: "AED", description: "aed1", date: "2026-06-10T10:00:00Z" });
    await insertBill({ locationId: locationA, amount: 20, currency: "AED", description: "aed2", date: "2026-06-11T10:00:00Z" });
    await insertBill({ locationId: locationA, amount: 15, currency: "USD", description: "usd1", date: "2026-06-12T10:00:00Z" });

    const res = await request(app).get("/cash-bills");
    expect(res.status).toBe(200);
    expect(res.body.summary.total_count).toBe(3);
    const byCur: { currency: string; total: string; bill_count: number }[] = res.body.summary.by_currency;
    const aed = byCur.find((c) => c.currency === "AED")!;
    const usd = byCur.find((c) => c.currency === "USD")!;
    expect(Number(aed.total)).toBeCloseTo(50, 2);
    expect(aed.bill_count).toBe(2);
    expect(Number(usd.total)).toBeCloseTo(15, 2);
    expect(usd.bill_count).toBe(1);
  });
});
