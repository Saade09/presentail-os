/**
 * Integration tests: CMC POS cash shift management — HTTP-level
 *
 * Tests call the actual Express route handlers via supertest with a real
 * PostgreSQL database. Auth and workspace middleware are mocked to inject a
 * fixed owner and user identity; everything else (SQL, transactions, helpers)
 * is real.
 *
 * Skips automatically when DATABASE_URL is not set.
 *
 * Run via:
 *   pnpm --filter @workspace/api-server run test:integration:local
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import pg from "pg";
import type { WorkspaceRequest } from "../lib/workspace";
import { randomUUID } from "crypto";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;

// ─────────────────────────────────────────────────────────────────────────────
// Stable test identifiers
// ─────────────────────────────────────────────────────────────────────────────

const OWNER_ID = "__cmc_shift_route_integ__";
const USER_A   = "cmc_shift_route_user_a";
const USER_B   = "cmc_shift_route_user_b";

// ─────────────────────────────────────────────────────────────────────────────
// Mocks — auth / workspace / logger / side effects only.
// db, cashDesk helpers, and real SQL all use the real module.
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("../lib/auth", () => ({
  requireAuth: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => next(),
  authed: (req: express.Request) => req,
}));

// Allow per-request user/role switching via test headers.
vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    const wreq = req as unknown as WorkspaceRequest & { userId?: string };
    const isMember = req.headers["x-test-role"] === "member";
    const pagesHeader = req.headers["x-test-pages"];
    const allowedPages = typeof pagesHeader === "string" && pagesHeader.length > 0
      ? pagesHeader.split(",")
      : null;
    wreq.workspaceOwnerId    = OWNER_ID;
    wreq.workspaceRole       = isMember ? "member" : "owner";
    wreq.workspaceActualRole = wreq.workspaceRole;
    wreq.allowedPages        = allowedPages;
    const headerUser = req.headers["x-test-user-id"];
    wreq.userId = typeof headerUser === "string" ? headerUser : USER_A;
    (req as unknown as Record<string, unknown>).userId = wreq.userId;
    wreq.userEmail = `${wreq.userId}@test.example`;
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

vi.mock("../lib/objectStorage", () => ({
  objectStorageClient: { upload: vi.fn().mockResolvedValue({ publicUrl: "https://example.com/img.jpg" }) },
}));

vi.mock("../lib/tookan", () => ({
  isTookanEnabled: vi.fn().mockResolvedValue(false),
  createTookanStockRequestTask: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/orderCreate", () => ({
  createManualOrder: vi.fn().mockResolvedValue({ id: 1 }),
}));

vi.mock("../lib/cmcMonthlySales", () => ({
  computeMonthlySales: vi.fn().mockResolvedValue({}),
  resolveMonthBounds: vi.fn().mockReturnValue({ from: new Date(), to: new Date() }),
}));

vi.mock("../lib/cmcMonthlySalesPdf", () => ({
  generateCmcCommissionSummaryPdf:   vi.fn().mockResolvedValue(Buffer.from("")),
  generateCmcCommissionStatementPdf: vi.fn().mockResolvedValue(Buffer.from("")),
}));

vi.mock("../lib/cmcOrderSse", () => ({
  broadcastCmcOrder: vi.fn(),
  subscribeCmcOrders: vi.fn(),
}));

// Imports MUST follow vi.mock (hoisting boundary).
import cmcPosRouter from "./cmcPos";

// ─────────────────────────────────────────────────────────────────────────────
// App factory
// ─────────────────────────────────────────────────────────────────────────────

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api", cmcPosRouter);
  // Error handler: surface the error message so test failures are debuggable
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const e = err as { message?: string; code?: string; stack?: string };
    console.error("[TEST-APP ERROR]", e?.message ?? String(err), e?.code, e?.stack?.split("\n")[1]);
    res.status(500).json({ error: e?.message ?? String(err), code: e?.code });
  });
  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
// DB helpers (direct SQL for test-state setup only)
// ─────────────────────────────────────────────────────────────────────────────

let pool: InstanceType<typeof Pool>;

async function q<T extends pg.QueryResultRow = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(sql, params);
}

async function setupLocation(name = "Test Location"): Promise<number> {
  const r = await q<{ id: number }>(
    `INSERT INTO locations (workspace_owner_id, name, country, status)
     VALUES ($1, $2, 'Lebanon', 'active') RETURNING id`,
    [OWNER_ID, name],
  );
  return r.rows[0].id;
}

async function setupDrawer(locationId: number, currency = "USD"): Promise<{ drawerId: number; code: string }> {
  const code = `TD${locationId}`;
  const r = await q<{ id: number }>(
    `INSERT INTO cash_drawers (workspace_owner_id, name, code, location_id, currency, is_active)
     VALUES ($1, $2, $3, $4, $5, true) RETURNING id`,
    [OWNER_ID, `Drawer ${locationId}`, code, locationId, currency],
  );
  return { drawerId: r.rows[0].id, code };
}

async function setupOpenSession(drawerId: number, locationId: number, openingCash = 100): Promise<number> {
  const year = new Date().getFullYear();
  const sessNum = `INT-TEST-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const r = await q<{ id: number }>(
    `INSERT INTO cash_sessions
       (workspace_owner_id, session_number, drawer_id, location_id, currency,
        status, opening_cash, expected_cash, opened_by_clerk_id)
     VALUES ($1, $2, $3, $4, 'USD', 'open', $5, $5, $6)
     RETURNING id`,
    [OWNER_ID, sessNum, drawerId, locationId, openingCash.toFixed(2), USER_A],
  );
  return r.rows[0].id;
}

// ─────────────────────────────────────────────────────────────────────────────
// Setup / Teardown
// ─────────────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  if (!DATABASE_URL) return;
  pool = new Pool({ connectionString: DATABASE_URL });

  // Minimal workspace_members rows (some tables FK to member)
  for (const [userId, email] of [[USER_A, "test-a@example.com"], [USER_B, "test-b@example.com"]]) {
    await q(
      `INSERT INTO workspace_members (workspace_owner_id, member_user_id, member_email, role)
       VALUES ($1, $2, $3, 'member') ON CONFLICT DO NOTHING`,
      [OWNER_ID, userId, email],
    );
  }
});

afterAll(async () => {
  if (!pool) return;
  await q(`DELETE FROM cash_transactions WHERE workspace_owner_id = $1`, [OWNER_ID]);
  await q(`DELETE FROM cash_session_activity_logs WHERE workspace_owner_id = $1`, [OWNER_ID]);
  await q(`DELETE FROM cash_sessions WHERE workspace_owner_id = $1`, [OWNER_ID]);
  await q(`DELETE FROM cmc_sales WHERE workspace_owner_id = $1`, [OWNER_ID]);
  await q(`UPDATE cmc_shifts SET cash_session_id = NULL WHERE workspace_owner_id = $1`, [OWNER_ID]);
  await q(`DELETE FROM cmc_shifts WHERE workspace_owner_id = $1`, [OWNER_ID]);
  await q(`DELETE FROM cash_drawers WHERE workspace_owner_id = $1`, [OWNER_ID]);
  await q(`DELETE FROM locations WHERE workspace_owner_id = $1`, [OWNER_ID]);
  await q(`DELETE FROM workspace_members WHERE workspace_owner_id = $1`, [OWNER_ID]);
  await pool.end();
});

beforeEach(async () => {
  if (!pool) return;
  await q(`DELETE FROM cash_transactions WHERE workspace_owner_id = $1`, [OWNER_ID]);
  await q(`DELETE FROM cash_session_activity_logs WHERE workspace_owner_id = $1`, [OWNER_ID]);
  await q(`DELETE FROM cash_sessions WHERE workspace_owner_id = $1`, [OWNER_ID]);
  await q(`DELETE FROM cmc_sales WHERE workspace_owner_id = $1`, [OWNER_ID]);
  await q(`UPDATE cmc_shifts SET cash_session_id = NULL WHERE workspace_owner_id = $1`, [OWNER_ID]);
  await q(`DELETE FROM cmc_shifts WHERE workspace_owner_id = $1`, [OWNER_ID]);
  await q(`DELETE FROM cash_drawers WHERE workspace_owner_id = $1`, [OWNER_ID]);
  await q(`DELETE FROM locations WHERE workspace_owner_id = $1`, [OWNER_ID]);
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper: skip gracefully when no DATABASE_URL
// ─────────────────────────────────────────────────────────────────────────────
function skipIfNoDb() {
  if (!DATABASE_URL) {
    console.log("DATABASE_URL not set — skipping integration test");
    return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("CMC POS shift management — route-level", () => {

  // ── Shift open ─────────────────────────────────────────────────────────────

  describe("POST /api/cmc-pos/shifts — open a shift", () => {
    it("auto-creates a cash session linked to the shift when a drawer exists", async () => {
      if (skipIfNoDb()) return;
      const app = makeApp();
      const locationId = await setupLocation("Auto-Session Loc");
      await setupDrawer(locationId);

      const res = await request(app)
        .post("/api/cmc-pos/shifts")
        .set("x-test-user-id", USER_A)
        .send({ location_id: locationId, opening_cash: 150 });

      expect(res.status).toBe(201);
      expect(res.body.cash_session_id).toBeTypeOf("number");

      // Verify in DB
      const sess = await q<{ opening_cash: string; status: string }>(
        `SELECT opening_cash, status FROM cash_sessions WHERE id = $1`,
        [res.body.cash_session_id],
      );
      expect(sess.rows).toHaveLength(1);
      expect(Number(sess.rows[0].opening_cash)).toBe(150);
      expect(sess.rows[0].status).toBe("open");
    });

    it("allows a CMC POS member to start a linked session without generic Cash Desk permission", async () => {
      if (skipIfNoDb()) return;
      const app = makeApp();
      const locationId = await setupLocation("CMC-Only Authorization Loc");
      await setupDrawer(locationId, "USD");

      const res = await request(app)
        .post("/api/cmc-pos/shifts")
        .set("x-test-user-id", USER_A)
        .set("x-test-role", "member")
        .set("x-test-pages", "cmc-pos")
        .send({ location_id: locationId, opening_cash: 80 });

      expect(res.status).toBe(201);
      expect(res.body.cash_session_id).toBeTypeOf("number");
      const shift = await q<{ currency: string; cash_session_id: number }>(
        `SELECT currency, cash_session_id FROM cmc_shifts WHERE id = $1`,
        [res.body.shift.id],
      );
      expect(shift.rows[0]).toMatchObject({ currency: "USD", cash_session_id: res.body.cash_session_id });
    });

    it("opens a dual-currency shift without currency: defaults to primary currency and succeeds", async () => {
      // When no `currency` is supplied for a dual-currency drawer the route defaults
      // to the drawer's primary currency for the shift (rather than rejecting with 422).
      // Without opening_cash_secondary the session is single-currency (secondary_currency = null).
      if (skipIfNoDb()) return;
      const app = makeApp();
      const locationId = await setupLocation("Dual CCY Default Loc");

      await q(
        `INSERT INTO cash_drawers (workspace_owner_id, name, location_id, code, currency, secondary_currency, is_active)
         VALUES ($1, 'Dual Drawer', $2, 'DUAL-A1', 'AED', 'USD', true)`,
        [OWNER_ID, locationId],
      );

      const openRes = await request(app)
        .post("/api/cmc-pos/shifts")
        .set("x-test-user-id", USER_A)
        .send({ location_id: locationId, opening_cash: 200 });

      expect(openRes.status).toBe(201);
      expect(openRes.body.cash_session_id).toBeTypeOf("number");

      // Shift currency must default to the drawer's primary currency (AED)
      const shift = await q<{ currency: string }>(
        `SELECT currency FROM cmc_shifts WHERE workspace_owner_id = $1 AND opened_by_user_id = $2 AND status = 'open'`,
        [OWNER_ID, USER_A],
      );
      expect(shift.rows).toHaveLength(1);
      expect(shift.rows[0].currency).toBe("AED");

      // Without opening_cash_secondary the session stays single-currency
      const sess = await q<{ currency: string; secondary_currency: string | null }>(
        `SELECT currency, secondary_currency FROM cash_sessions WHERE id = $1`,
        [openRes.body.cash_session_id],
      );
      expect(sess.rows).toHaveLength(1);
      expect(sess.rows[0].currency).toBe("AED");
      expect(sess.rows[0].secondary_currency).toBeNull();
    });

    it("opens a dual-currency shift with opening_cash_secondary: records both opening balances in the session", async () => {
      // When opening_cash_secondary is supplied the session is created with both
      // opening balances so the cashier's initial float for each currency is tracked.
      if (skipIfNoDb()) return;
      const app = makeApp();
      const locationId = await setupLocation("Dual CCY Both Balances Loc");

      await q(
        `INSERT INTO cash_drawers (workspace_owner_id, name, location_id, code, currency, secondary_currency, is_active)
         VALUES ($1, 'Dual Drawer', $2, 'DUAL-B1', 'AED', 'LBP', true)`,
        [OWNER_ID, locationId],
      );

      const openRes = await request(app)
        .post("/api/cmc-pos/shifts")
        .set("x-test-user-id", USER_A)
        .send({ location_id: locationId, opening_cash: 500, opening_cash_secondary: 1000000 });

      expect(openRes.status).toBe(201);

      const sess = await q<{
        currency: string; secondary_currency: string | null;
        opening_cash: string; opening_cash_secondary: string | null;
      }>(
        `SELECT currency, secondary_currency, opening_cash, opening_cash_secondary
           FROM cash_sessions WHERE id = $1`,
        [openRes.body.cash_session_id],
      );
      expect(sess.rows).toHaveLength(1);
      expect(sess.rows[0].currency).toBe("AED");
      expect(sess.rows[0].secondary_currency).toBe("LBP");
      expect(Number(sess.rows[0].opening_cash)).toBe(500);
      expect(Number(sess.rows[0].opening_cash_secondary)).toBe(1000000);
    });

    it("returns 422 DUAL_CURRENCY_DRAWER_NOT_SUPPORTED when an invalid currency is supplied for a dual-currency drawer", async () => {
      // Supplying a currency that does not match either of the drawer's currencies
      // must still be rejected — it indicates a client bug.
      if (skipIfNoDb()) return;
      const app = makeApp();
      const locationId = await setupLocation("Dual CCY Bad Currency Loc");

      await q(
        `INSERT INTO cash_drawers (workspace_owner_id, name, location_id, code, currency, secondary_currency, is_active)
         VALUES ($1, 'Dual Drawer', $2, 'DUAL-C1', 'AED', 'USD', true)`,
        [OWNER_ID, locationId],
      );

      const openRes = await request(app)
        .post("/api/cmc-pos/shifts")
        .set("x-test-user-id", USER_A)
        .send({ location_id: locationId, opening_cash: 100, currency: "GBP" });

      expect(openRes.status).toBe(422);
      expect(openRes.body.code).toBe("DUAL_CURRENCY_DRAWER_NOT_SUPPORTED");

      // No shift or session should have been created
      const shifts = await q(
        `SELECT id FROM cmc_shifts WHERE workspace_owner_id = $1 AND opened_by_user_id = $2 AND status = 'open'`,
        [OWNER_ID, USER_A],
      );
      expect(shifts.rows).toHaveLength(0);
    });

    it("returns 409 when the same user already has an open shift", async () => {
      if (skipIfNoDb()) return;
      const app = makeApp();
      const locationId = await setupLocation("Dup Shift Loc");
      await setupDrawer(locationId);

      // Open first shift
      const first = await request(app)
        .post("/api/cmc-pos/shifts")
        .set("x-test-user-id", USER_A)
        .send({ location_id: locationId, opening_cash: 50 });
      expect(first.status).toBe(201);

      // Try to open a second shift for the same user
      const second = await request(app)
        .post("/api/cmc-pos/shifts")
        .set("x-test-user-id", USER_A)
        .send({ location_id: locationId, opening_cash: 50 });
      expect(second.status).toBe(409);
      expect(second.body.error).toMatch(/already have an open shift/i);
    });

    it("returns 409 (LOCATION_SESSION_IN_USE) when another user's shift owns the location's session", async () => {
      if (skipIfNoDb()) return;
      const app = makeApp();
      const locationId = await setupLocation("Concurrency Loc");
      await setupDrawer(locationId);

      // USER_A opens a shift → claims the session
      const firstRes = await request(app)
        .post("/api/cmc-pos/shifts")
        .set("x-test-user-id", USER_A)
        .send({ location_id: locationId, opening_cash: 100 });
      expect(firstRes.status).toBe(201);

      // USER_B tries to open a shift at the same location
      const secondRes = await request(app)
        .post("/api/cmc-pos/shifts")
        .set("x-test-user-id", USER_B)
        .send({ location_id: locationId, opening_cash: 100 });
      expect(secondRes.status).toBe(409);
      expect(secondRes.body.code).toBe("LOCATION_SESSION_IN_USE");
    });

    it("concurrent opens from two users produce exactly one open shift and one open session", async () => {
      if (skipIfNoDb()) return;
      const app = makeApp();
      const locationId = await setupLocation("Concurrent Open Loc");
      await setupDrawer(locationId);

      // Fire both requests simultaneously — only one should win the drawer lock
      const [r1, r2] = await Promise.all([
        request(app)
          .post("/api/cmc-pos/shifts")
          .set("x-test-user-id", USER_A)
          .send({ location_id: locationId, opening_cash: 100 }),
        request(app)
          .post("/api/cmc-pos/shifts")
          .set("x-test-user-id", USER_B)
          .send({ location_id: locationId, opening_cash: 100 }),
      ]);

      const statuses = [r1.status, r2.status].sort();
      // Exactly one 201 and one 409
      expect(statuses).toEqual([201, 409]);

      // Exactly one open session in the DB for this workspace
      const sessions = await q<{ id: number }>(
        `SELECT id FROM cash_sessions WHERE workspace_owner_id = $1 AND status = 'open'`,
        [OWNER_ID],
      );
      expect(sessions.rows).toHaveLength(1);

      // Exactly one open shift
      const shifts = await q<{ id: number }>(
        `SELECT id FROM cmc_shifts WHERE workspace_owner_id = $1 AND status = 'open'`,
        [OWNER_ID],
      );
      expect(shifts.rows).toHaveLength(1);
    });
  });

  // ── Cash sale gate ──────────────────────────────────────────────────────────

  describe("POST /api/cmc-pos/sales — cash sale gate", () => {
    it("returns 422 NO_ACTIVE_CASH_SESSION for cash payment with no open session", async () => {
      if (skipIfNoDb()) return;
      const app = makeApp();
      const locationId = await setupLocation("No-Session Loc");
      // No drawer, no session

      const res = await request(app)
        .post("/api/cmc-pos/sales")
        .set("x-test-user-id", USER_A)
        .send({
          location_id: locationId,
          payment_method: "cash",
          line_items: [{ product_id: null, name: "Test Item", qty: 1, unit_price: 25, total_price: 25 }],
          subtotal: 25,
          discount_amount: 0,
          total: 25,
          idempotency_key: randomUUID(),
        });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe("NO_ACTIVE_CASH_SESSION");
    });

    it("creates a cash_transaction ledger entry for a cash sale with an active session", async () => {
      if (skipIfNoDb()) return;
      const app = makeApp();
      const locationId = await setupLocation("Cash Sale Loc");
      await setupDrawer(locationId);
      // Open a shift via HTTP — auto-creates and links the cash session
      const shiftOpen = await request(app)
        .post("/api/cmc-pos/shifts")
        .set("x-test-user-id", USER_A)
        .send({ location_id: locationId, opening_cash: 100 });
      expect(shiftOpen.status).toBe(201);

      const idKey = randomUUID();
      const res = await request(app)
        .post("/api/cmc-pos/sales")
        .set("x-test-user-id", USER_A)
        .send({
          location_id: locationId,
          payment_method: "cash",
          line_items: [{ product_id: null, name: "Test Item", qty: 1, unit_price: 40, total_price: 40 }],
          subtotal: 40,
          discount_amount: 0,
          total: 40,
          idempotency_key: idKey,
        });

      expect(res.status).toBe(201);

      const txns = await q<{ type: string; amount: string; direction: string }>(
        `SELECT type, amount, direction FROM cash_transactions
          WHERE workspace_owner_id = $1 AND type = 'cash_sale'`,
        [OWNER_ID],
      );
      expect(txns.rows).toHaveLength(1);
      expect(Number(txns.rows[0].amount)).toBe(40);
      expect(txns.rows[0].direction).toBe("in");
    });

    it("is idempotent: duplicate idempotency_key does not create double ledger entry", async () => {
      if (skipIfNoDb()) return;
      const app = makeApp();
      const locationId = await setupLocation("Idempotent Loc");
      await setupDrawer(locationId);
      // Open a shift via HTTP — auto-creates and links the cash session
      const shiftOpen = await request(app)
        .post("/api/cmc-pos/shifts")
        .set("x-test-user-id", USER_A)
        .send({ location_id: locationId, opening_cash: 100 });
      expect(shiftOpen.status).toBe(201);

      const idKey = randomUUID();
      const payload = {
        location_id: locationId,
        payment_method: "cash",
        line_items: [{ product_id: null, name: "Widget", qty: 1, unit_price: 30, total_price: 30 }],
        subtotal: 30,
        discount_amount: 0,
        total: 30,
        idempotency_key: idKey,
      };

      const r1 = await request(app).post("/api/cmc-pos/sales").set("x-test-user-id", USER_A).send(payload);
      expect(r1.status).toBe(201);

      const r2 = await request(app).post("/api/cmc-pos/sales").set("x-test-user-id", USER_A).send(payload);
      // Route should return the existing sale (200/201) rather than create a duplicate
      expect([200, 201]).toContain(r2.status);

      const txns = await q(
        `SELECT id FROM cash_transactions WHERE workspace_owner_id = $1 AND type = 'cash_sale'`,
        [OWNER_ID],
      );
      // Must remain exactly 1 entry despite two requests
      expect(txns.rows).toHaveLength(1);
    });

    it("blocks USER_B from posting a cash sale to USER_A's open session", async () => {
      if (skipIfNoDb()) return;
      const app = makeApp();
      const locationId = await setupLocation("Auth Guard Loc");
      await setupDrawer(locationId);

      // USER_A opens a shift → creates and links a cash session
      const openRes = await request(app)
        .post("/api/cmc-pos/shifts")
        .set("x-test-user-id", USER_A)
        .send({ location_id: locationId, opening_cash: 100 });
      expect(openRes.status).toBe(201);

      // USER_B tries to post a cash sale at the same location — no open shift for USER_B
      const saleRes = await request(app)
        .post("/api/cmc-pos/sales")
        .set("x-test-user-id", USER_B)
        .send({
          location_id: locationId,
          payment_method: "cash",
          line_items: [{ product_id: null, name: "Steal Sale", qty: 1, unit_price: 99, total_price: 99 }],
          subtotal: 99,
          discount_amount: 0,
          total: 99,
          idempotency_key: randomUUID(),
        });

      // Must be rejected — USER_B has no active shift
      expect(saleRes.status).toBe(422);
      expect(saleRes.body.code).toBe("NO_ACTIVE_CASH_SESSION");

      // USER_A's session must have no cash_transaction from the rejected sale
      const txns = await q(
        `SELECT id FROM cash_transactions WHERE workspace_owner_id = $1 AND type = 'cash_sale'`,
        [OWNER_ID],
      );
      expect(txns.rows).toHaveLength(0);
    });

    it("rejects a cash sale when the client sends a shift_id belonging to another user", async () => {
      if (skipIfNoDb()) return;
      const app = makeApp();
      const locationId = await setupLocation("Shift ID Guard Loc");
      await setupDrawer(locationId);

      // USER_A opens a shift
      const openRes = await request(app)
        .post("/api/cmc-pos/shifts")
        .set("x-test-user-id", USER_A)
        .send({ location_id: locationId, opening_cash: 100 });
      expect(openRes.status).toBe(201);
      const userAShiftId = openRes.body.shift.id as number;

      // USER_A successfully records a cash sale (control — establishes session)
      const ok = await request(app)
        .post("/api/cmc-pos/sales")
        .set("x-test-user-id", USER_A)
        .send({
          location_id: locationId,
          payment_method: "cash",
          shift_id: userAShiftId,
          line_items: [{ product_id: null, name: "Legit Sale", qty: 1, unit_price: 50, total_price: 50 }],
          subtotal: 50,
          discount_amount: 0,
          total: 50,
          idempotency_key: randomUUID(),
        });
      expect(ok.status).toBe(201);

      // USER_A supplying a wrong shift_id should be rejected (shift_id ≠ caller's active shift)
      // To test this we need a second shift_id that's NOT USER_A's shift.
      // The simplest way: supply a completely invalid shift_id (999999) — server resolves
      // caller's shift server-side and rejects the mismatch.
      const badShiftRes = await request(app)
        .post("/api/cmc-pos/sales")
        .set("x-test-user-id", USER_A)
        .send({
          location_id: locationId,
          payment_method: "cash",
          shift_id: 999999, // not USER_A's active shift
          line_items: [{ product_id: null, name: "Forged Sale", qty: 1, unit_price: 25, total_price: 25 }],
          subtotal: 25,
          discount_amount: 0,
          total: 25,
          idempotency_key: randomUUID(),
        });

      expect(badShiftRes.status).toBe(403);
      expect(badShiftRes.body.code).toBe("SHIFT_OWNERSHIP");
    });

    it("does not create a cash_transaction for a non-cash sale", async () => {
      if (skipIfNoDb()) return;
      const app = makeApp();
      const locationId = await setupLocation("Card Sale Loc");
      const { drawerId } = await setupDrawer(locationId);
      await setupOpenSession(drawerId, locationId, 100);

      const res = await request(app)
        .post("/api/cmc-pos/sales")
        .set("x-test-user-id", USER_A)
        .send({
          location_id: locationId,
          payment_method: "card",
          line_items: [{ product_id: null, name: "Card Item", qty: 1, unit_price: 60, total_price: 60 }],
          subtotal: 60,
          discount_amount: 0,
          total: 60,
          idempotency_key: randomUUID(),
        });

      expect(res.status).toBe(201);

      const txns = await q(
        `SELECT id FROM cash_transactions WHERE workspace_owner_id = $1 AND type = 'cash_sale'`,
        [OWNER_ID],
      );
      expect(txns.rows).toHaveLength(0);
    });
  });

  // ── Shift close ─────────────────────────────────────────────────────────────

  describe("POST /api/cmc-pos/shifts/close — reconciliation", () => {
    it("closes shift and session atomically when totals match expected", async () => {
      if (skipIfNoDb()) return;
      const app = makeApp();
      const locationId = await setupLocation("Clean Close Loc");
      await setupDrawer(locationId);

      // Open shift → auto-creates session with opening_cash=200
      const openRes = await request(app)
        .post("/api/cmc-pos/shifts")
        .set("x-test-user-id", USER_A)
        .send({ location_id: locationId, opening_cash: 200 });
      expect(openRes.status).toBe(201);
      const sessionId = openRes.body.cash_session_id as number;

      const closeRes = await request(app)
        .post("/api/cmc-pos/shifts/close")
        .set("x-test-user-id", USER_A)
        .send({ cash_kept: 200, cash_transferred: 0 });

      expect(closeRes.status).toBe(200);

      const sess = await q<{ status: string; actual_cash: string }>(
        `SELECT status, actual_cash FROM cash_sessions WHERE id = $1`, [sessionId],
      );
      expect(sess.rows[0].status).toBe("pending_review");
      // actual_cash = kept + transferred = 200 + 0 = 200
      expect(Number(sess.rows[0].actual_cash)).toBe(200);
    });

    it("closes a stranded shift linked to an already-finalized session without changing that session", async () => {
      if (skipIfNoDb()) return;
      const app = makeApp();
      const locationId = await setupLocation("Finalized Session Recovery Loc");
      await setupDrawer(locationId, "LBP");

      const openRes = await request(app)
        .post("/api/cmc-pos/shifts")
        .set("x-test-user-id", USER_A)
        .send({ location_id: locationId, opening_cash: 250000 });
      expect(openRes.status).toBe(201);
      const sessionId = openRes.body.cash_session_id as number;

      const reconciliation = { counts: [{ currency: "LBP", expected: 250000, actual: 245000, variance: -5000 }] };
      await q(
        `UPDATE cash_sessions
            SET status = 'pending_review', closed_at = now(), closed_by_clerk_id = $1,
                actual_cash = 245000, expected_cash = 250000, difference = -5000,
                reconciliation = $2::jsonb
          WHERE id = $3`,
        [USER_B, JSON.stringify(reconciliation), sessionId],
      );
      const before = await q<{
        status: string; actual_cash: string; expected_cash: string; difference: string; reconciliation: unknown;
      }>(
        `SELECT status, actual_cash, expected_cash, difference, reconciliation FROM cash_sessions WHERE id = $1`,
        [sessionId],
      );
      const logsBefore = await q(
        `SELECT id FROM cash_session_activity_logs WHERE cash_session_id = $1`,
        [sessionId],
      );

      // Transfers are unsafe after finalization and must be rejected before a
      // recovery close can proceed.
      const transferAttempt = await request(app)
        .post("/api/cmc-pos/shifts/close")
        .set("x-test-user-id", USER_A)
        .send({ cash_kept: 0, cash_transferred: 50 });
      expect(transferAttempt.status).toBe(422);
      expect(transferAttempt.body.code).toBe("FINALIZED_SESSION_TRANSFER_UNSUPPORTED");

      const closeRes = await request(app)
        .post("/api/cmc-pos/shifts/close")
        .set("x-test-user-id", USER_A)
        .send({ cash_kept: 0, cash_transferred: 0, location_id: locationId });
      expect(closeRes.status).toBe(200);
      expect(closeRes.body.session_already_finalized).toBe(true);
      expect(closeRes.body.message).toMatch(/left unchanged/i);
      expect(closeRes.body.expected_balance).toBe(250000);
      expect(closeRes.body.discrepancy).toBe(-5000);

      const after = await q<{
        status: string; actual_cash: string; expected_cash: string; difference: string; reconciliation: unknown;
      }>(
        `SELECT status, actual_cash, expected_cash, difference, reconciliation FROM cash_sessions WHERE id = $1`,
        [sessionId],
      );
      expect(after.rows[0]).toEqual(before.rows[0]);
      const logsAfter = await q(
        `SELECT id FROM cash_session_activity_logs WHERE cash_session_id = $1`,
        [sessionId],
      );
      expect(logsAfter.rows).toHaveLength(logsBefore.rows.length);

      const shift = await q<{ status: string; closing_cash_kept: string; closing_cash_transferred: string }>(
        `SELECT status, closing_cash_kept, closing_cash_transferred FROM cmc_shifts WHERE id = $1`,
        [openRes.body.shift.id],
      );
      expect(shift.rows[0].status).toBe("closed");
      expect(Number(shift.rows[0].closing_cash_kept)).toBe(245000);
      expect(Number(shift.rows[0].closing_cash_transferred)).toBe(0);
    });

    it("returns a finalized linked session while its CMC shift is still open", async () => {
      if (skipIfNoDb()) return;
      const app = makeApp();
      const locationId = await setupLocation("Finalized Drawer Lookup Loc");
      await setupDrawer(locationId, "USD");
      const openRes = await request(app)
        .post("/api/cmc-pos/shifts")
        .set("x-test-user-id", USER_A)
        .send({ location_id: locationId, opening_cash: 120 });
      expect(openRes.status).toBe(201);

      await q(
        `UPDATE cash_sessions
            SET status = 'closed', closed_at = now(), closed_by_clerk_id = $1,
                actual_cash = 120, expected_cash = 120, difference = 0
          WHERE id = $2`,
        [USER_A, openRes.body.cash_session_id],
      );

      const drawerRes = await request(app)
        .get(`/api/cmc-pos/cash-drawer?location_id=${locationId}`)
        .set("x-test-user-id", USER_A);

      expect(drawerRes.status).toBe(200);
      expect(drawerRes.body.session).toMatchObject({
        id: openRes.body.cash_session_id,
        status: "closed",
        currency: "USD",
      });
      expect(drawerRes.body.drawer_currency).toBe("USD");
      expect(drawerRes.body.shift_currency).toBe("USD");
    });

    it("allows a discrepancy when a reconciliation note is provided", async () => {
      if (skipIfNoDb()) return;
      const app = makeApp();
      const locationId = await setupLocation("Discrepancy OK Loc");
      await setupDrawer(locationId);

      const openRes = await request(app)
        .post("/api/cmc-pos/shifts")
        .set("x-test-user-id", USER_A)
        .send({ location_id: locationId, opening_cash: 100 });
      expect(openRes.status).toBe(201);
      const sessionId = openRes.body.cash_session_id as number;

      // Kept only 95 (short $5) but provides a note
      const closeRes = await request(app)
        .post("/api/cmc-pos/shifts/close")
        .set("x-test-user-id", USER_A)
        .send({
          cash_kept: 95,
          cash_transferred: 0,
          discrepancy_note: "Till short $5 — recount confirmed",
        });

      expect(closeRes.status).toBe(200);
      expect(closeRes.body.discrepancy).toBeCloseTo(-5, 1);

      const sess = await q<{ difference: string; actual_cash: string }>(
        `SELECT difference, actual_cash FROM cash_sessions WHERE id = $1`, [sessionId],
      );
      expect(Number(sess.rows[0].difference)).toBeCloseTo(-5, 1);
      // actual_cash = kept + transferred = 95 + 0 = 95
      expect(Number(sess.rows[0].actual_cash)).toBe(95);
    });

    it("returns 422 DISCREPANCY_NOTE_REQUIRED when discrepancy exists but no note is provided", async () => {
      if (skipIfNoDb()) return;
      const app = makeApp();
      const locationId = await setupLocation("No Note Loc");
      await setupDrawer(locationId);

      const openRes = await request(app)
        .post("/api/cmc-pos/shifts")
        .set("x-test-user-id", USER_A)
        .send({ location_id: locationId, opening_cash: 100 });
      expect(openRes.status).toBe(201);

      const closeRes = await request(app)
        .post("/api/cmc-pos/shifts/close")
        .set("x-test-user-id", USER_A)
        .send({ cash_kept: 90, cash_transferred: 0 }); // $10 short, no note

      expect(closeRes.status).toBe(422);
      expect(closeRes.body.code).toBe("DISCREPANCY_NOTE_REQUIRED");
    });

    it("creates paired transfer transactions and sets actual_cash = kept + transferred", async () => {
      if (skipIfNoDb()) return;
      const app = makeApp();
      const srcLocationId = await setupLocation("Transfer Src Loc");
      const dstLocationId = await setupLocation("Transfer Dst Loc");
      const { drawerId: srcDrawerId } = await setupDrawer(srcLocationId);
      const { drawerId: dstDrawerId } = await setupDrawer(dstLocationId);
      const dstSessionId = await setupOpenSession(dstDrawerId, dstLocationId, 50);

      // Open source shift (opening_cash=300)
      const openRes = await request(app)
        .post("/api/cmc-pos/shifts")
        .set("x-test-user-id", USER_A)
        .send({ location_id: srcLocationId, opening_cash: 300 });
      expect(openRes.status).toBe(201);
      const srcSessionId = openRes.body.cash_session_id as number;

      // Close: keep 200, transfer 100 to dstLocation
      const closeRes = await request(app)
        .post("/api/cmc-pos/shifts/close")
        .set("x-test-user-id", USER_A)
        .send({
          cash_kept: 200,
          cash_transferred: 100,
          destination_location_id: dstLocationId,
        });

      expect(closeRes.status).toBe(200);

      // actual_cash on session = kept + transferred = 300 (no discrepancy)
      const srcSess = await q<{ actual_cash: string; difference: string }>(
        `SELECT actual_cash, difference FROM cash_sessions WHERE id = $1`, [srcSessionId],
      );
      expect(Number(srcSess.rows[0].actual_cash)).toBe(300);
      expect(Number(srcSess.rows[0].difference)).toBeCloseTo(0, 1);

      // Paired transfer transactions with shared transfer_id
      const txns = await q<{ direction: string; cash_session_id: number; transfer_id: string }>(
        `SELECT direction, cash_session_id, transfer_id
           FROM cash_transactions
          WHERE workspace_owner_id = $1 AND type = 'transfer'
          ORDER BY direction`,
        [OWNER_ID],
      );
      expect(txns.rows).toHaveLength(2);
      const outTx = txns.rows.find((r) => r.direction === "out");
      const inTx  = txns.rows.find((r) => r.direction === "in");
      expect(outTx?.cash_session_id).toBe(srcSessionId);
      expect(inTx?.cash_session_id).toBe(dstSessionId);
      expect(outTx?.transfer_id).toBe(inTx?.transfer_id); // shared UUID
    });

    it("computes expected balance from live ledger — immediate sale-then-close requires no reconciliation note", async () => {
      // The close endpoint reads expected balance from committed cash_transactions,
      // NOT from the stale expected_cash column.  A cash sale committed immediately
      // before close must be reflected in the balance without any manual recompute.
      if (skipIfNoDb()) return;
      const app = makeApp();
      const locationId = await setupLocation("Live Ledger Loc");
      await setupDrawer(locationId);

      // Open shift (opening=500)
      const openRes = await request(app)
        .post("/api/cmc-pos/shifts")
        .set("x-test-user-id", USER_A)
        .send({ location_id: locationId, opening_cash: 500 });
      expect(openRes.status).toBe(201);
      const srcSessionId = openRes.body.cash_session_id as number;

      // Record a cash sale of 100 — fire-and-forget recomputeSessionTotals
      // means expected_cash column is still 500 in the DB.
      const saleRes = await request(app)
        .post("/api/cmc-pos/sales")
        .set("x-test-user-id", USER_A)
        .send({
          location_id: locationId,
          payment_method: "cash",
          line_items: [{ product_id: null, name: "Item", qty: 1, unit_price: 100, total_price: 100 }],
          subtotal: 100, discount_amount: 0, total: 100,
          idempotency_key: randomUUID(),
        });
      expect(saleRes.status).toBe(201);

      // Verify expected_cash column is still stale (500) — recompute hasn't run
      const stale = await q<{ expected_cash: string }>(
        `SELECT expected_cash FROM cash_sessions WHERE id = $1`, [srcSessionId],
      );
      expect(Number(stale.rows[0].expected_cash)).toBeCloseTo(500, 1);

      // Close IMMEDIATELY after sale without waiting for recompute.
      // Close with kept=600 (opening 500 + sale 100 = expected 600 from ledger).
      // Should be balanced (discrepancy = 0), so no note required.
      const closeRes = await request(app)
        .post("/api/cmc-pos/shifts/close")
        .set("x-test-user-id", USER_A)
        .send({ cash_kept: 600, cash_transferred: 0 });
      expect(closeRes.status).toBe(200);  // balanced: no note needed
      expect(closeRes.body.expected_balance).toBeCloseTo(600, 1);
      expect(closeRes.body.discrepancy).toBeCloseTo(0, 1);

      // Session reconciliation is frozen correctly
      const sess = await q<{
        actual_cash: string; expected_cash: string; difference: string; status: string;
      }>(`SELECT actual_cash, expected_cash, difference, status FROM cash_sessions WHERE id = $1`,
        [srcSessionId],
      );
      expect(sess.rows[0].status).toBe("pending_review");
      expect(Number(sess.rows[0].actual_cash)).toBeCloseTo(600, 1);
      expect(Number(sess.rows[0].expected_cash)).toBeCloseTo(600, 1);
      expect(Number(sess.rows[0].difference)).toBeCloseTo(0, 1);
    });

    it("source session reconciliation values survive a post-close recomputeSessionTotals call", async () => {
      // recomputeSessionTotals skips non-open sessions; after a transfer the
      // outgoing transfer row must NOT corrupt the frozen reconciliation.
      if (skipIfNoDb()) return;
      const app = makeApp();
      const srcLocationId = await setupLocation("Freeze Src Loc");
      const dstLocationId = await setupLocation("Freeze Dst Loc");
      const { drawerId: srcDrawerId } = await setupDrawer(srcLocationId);
      const { drawerId: dstDrawerId } = await setupDrawer(dstLocationId);
      const dstSessionId = await setupOpenSession(dstDrawerId, dstLocationId, 0);

      // Open shift (opening=500)
      const openRes = await request(app)
        .post("/api/cmc-pos/shifts")
        .set("x-test-user-id", USER_A)
        .send({ location_id: srcLocationId, opening_cash: 500 });
      expect(openRes.status).toBe(201);
      const srcSessionId = openRes.body.cash_session_id as number;

      // Close with kept=350, transfer=150 → total=500 (balanced with opening=500)
      const closeRes = await request(app)
        .post("/api/cmc-pos/shifts/close")
        .set("x-test-user-id", USER_A)
        .send({ cash_kept: 350, cash_transferred: 150, destination_location_id: dstLocationId });
      expect(closeRes.status).toBe(200);

      // Frozen reconciliation
      const before = await q<{
        actual_cash: string; expected_cash: string; difference: string;
      }>(`SELECT actual_cash, expected_cash, difference FROM cash_sessions WHERE id = $1`,
        [srcSessionId],
      );
      expect(Number(before.rows[0].actual_cash)).toBeCloseTo(500, 1);
      expect(Number(before.rows[0].expected_cash)).toBeCloseTo(500, 1);
      expect(Number(before.rows[0].difference)).toBeCloseTo(0, 1);

      // Simulate a late recomputeSessionTotals call from another page/process.
      // Without the status='open' guard this would corrupt expected_cash to
      // opening - transfer_out = 500 - 150 = 350.
      const { recomputeSessionTotals: recompute } = await import("../lib/cashDesk.js");
      await recompute(srcSessionId, OWNER_ID);

      // Values must be unchanged — recompute must be a no-op on pending_review
      const after = await q<{
        actual_cash: string; expected_cash: string; difference: string;
      }>(`SELECT actual_cash, expected_cash, difference FROM cash_sessions WHERE id = $1`,
        [srcSessionId],
      );
      expect(Number(after.rows[0].actual_cash)).toBeCloseTo(500, 1);
      expect(Number(after.rows[0].expected_cash)).toBeCloseTo(500, 1);
      expect(Number(after.rows[0].difference)).toBeCloseTo(0, 1);

      // Destination received the transfer; its expected_cash = 0 + 150 = 150
      const destSess = await q<{ expected_cash: string }>(
        `SELECT expected_cash FROM cash_sessions WHERE id = $1`, [dstSessionId],
      );
      expect(Number(destSess.rows[0].expected_cash)).toBeCloseTo(150, 1);
    });

    it("returns 422 NO_DEST_SESSION when destination location has no open session", async () => {
      if (skipIfNoDb()) return;
      const app = makeApp();
      const srcLocationId = await setupLocation("No Dest Sess Src Loc");
      const dstLocationId = await setupLocation("No Dest Sess Dst Loc");
      await setupDrawer(srcLocationId);
      await setupDrawer(dstLocationId);
      // No open session at destination

      const openRes = await request(app)
        .post("/api/cmc-pos/shifts")
        .set("x-test-user-id", USER_A)
        .send({ location_id: srcLocationId, opening_cash: 200 });
      expect(openRes.status).toBe(201);

      const closeRes = await request(app)
        .post("/api/cmc-pos/shifts/close")
        .set("x-test-user-id", USER_A)
        .send({
          cash_kept: 100,
          cash_transferred: 100,
          destination_location_id: dstLocationId,
          discrepancy_note: "Transfer intended",
        });

      expect(closeRes.status).toBe(422);
      expect(closeRes.body.code).toBe("NO_DEST_SESSION");
    });

    it("dual-currency close: freezes actual_cash_secondary, expected_cash_secondary, difference_secondary on the session", async () => {
      // When a dual-currency shift is closed with cash_kept_secondary the route must
      // compute the secondary expected balance from committed ledger rows (same as
      // primary) and freeze all three secondary reconciliation columns on the session.
      if (skipIfNoDb()) return;
      const app = makeApp();
      const locationId = await setupLocation("Dual CCY Close Loc");

      await q(
        `INSERT INTO cash_drawers (workspace_owner_id, name, location_id, code, currency, secondary_currency, is_active)
         VALUES ($1, 'Dual Close Drawer', $2, 'DUAL-CL1', 'AED', 'LBP', true)`,
        [OWNER_ID, locationId],
      );

      // Open a dual-currency shift: AED 500, LBP 1_000_000
      const openRes = await request(app)
        .post("/api/cmc-pos/shifts")
        .set("x-test-user-id", USER_A)
        .send({ location_id: locationId, opening_cash: 500, opening_cash_secondary: 1000000 });
      expect(openRes.status).toBe(201);
      const sessionId = openRes.body.cash_session_id as number;

      // Close: AED matches (500 kept, balanced), LBP matches (1_000_000 kept, balanced)
      const closeRes = await request(app)
        .post("/api/cmc-pos/shifts/close")
        .set("x-test-user-id", USER_A)
        .send({ cash_kept: 500, cash_transferred: 0, cash_kept_secondary: 1000000 });

      expect(closeRes.status).toBe(200);
      expect(closeRes.body.expected_balance).toBeCloseTo(500, 1);
      expect(closeRes.body.expected_balance_secondary).toBeCloseTo(1000000, 1);
      expect(closeRes.body.discrepancy_secondary).toBeCloseTo(0, 1);

      // All six reconciliation columns must be frozen on the session
      const sess = await q<{
        actual_cash: string; expected_cash: string; difference: string;
        actual_cash_secondary: string | null;
        expected_cash_secondary: string | null;
        difference_secondary: string | null;
        status: string;
      }>(
        `SELECT actual_cash, expected_cash, difference,
                actual_cash_secondary, expected_cash_secondary, difference_secondary,
                status
           FROM cash_sessions WHERE id = $1`,
        [sessionId],
      );
      expect(sess.rows[0].status).toBe("pending_review");
      expect(Number(sess.rows[0].actual_cash)).toBeCloseTo(500, 1);
      expect(Number(sess.rows[0].expected_cash)).toBeCloseTo(500, 1);
      expect(Number(sess.rows[0].difference)).toBeCloseTo(0, 1);
      expect(Number(sess.rows[0].actual_cash_secondary)).toBeCloseTo(1000000, 1);
      expect(Number(sess.rows[0].expected_cash_secondary)).toBeCloseTo(1000000, 1);
      expect(Number(sess.rows[0].difference_secondary)).toBeCloseTo(0, 1);
    });

    it("dual-currency close: secondary-only discrepancy triggers DISCREPANCY_NOTE_REQUIRED when no note is provided", async () => {
      // If the primary count is balanced but the secondary count differs from its
      // expected balance by more than $0.009, a reconciliation note is still required.
      if (skipIfNoDb()) return;
      const app = makeApp();
      const locationId = await setupLocation("Dual CCY Sec Discrepancy Loc");

      await q(
        `INSERT INTO cash_drawers (workspace_owner_id, name, location_id, code, currency, secondary_currency, is_active)
         VALUES ($1, 'Dual Disc Drawer', $2, 'DUAL-CL2', 'AED', 'LBP', true)`,
        [OWNER_ID, locationId],
      );

      const openRes = await request(app)
        .post("/api/cmc-pos/shifts")
        .set("x-test-user-id", USER_A)
        .send({ location_id: locationId, opening_cash: 300, opening_cash_secondary: 500000 });
      expect(openRes.status).toBe(201);

      // Close: AED is balanced (300 kept), LBP is short (only 450_000 counted vs 500_000 expected), no note
      const closeRes = await request(app)
        .post("/api/cmc-pos/shifts/close")
        .set("x-test-user-id", USER_A)
        .send({ cash_kept: 300, cash_transferred: 0, cash_kept_secondary: 450000 });

      expect(closeRes.status).toBe(422);
      expect(closeRes.body.code).toBe("DISCREPANCY_NOTE_REQUIRED");

      // Close again with a note — must succeed
      const closeWithNote = await request(app)
        .post("/api/cmc-pos/shifts/close")
        .set("x-test-user-id", USER_A)
        .send({
          cash_kept: 300,
          cash_transferred: 0,
          cash_kept_secondary: 450000,
          discrepancy_note: "LBP short 50,000 — recount confirmed",
        });

      expect(closeWithNote.status).toBe(200);
      expect(closeWithNote.body.discrepancy_secondary).toBeCloseTo(-50000, 0);
    });
  });

  // ── Legacy close guard ──────────────────────────────────────────────────────

  describe("POST /api/cmc-pos/shifts/:id/close — legacy endpoint guard", () => {
    it("returns 409 USE_RECONCILIATION_CLOSE for a shift that has a linked cash session", async () => {
      if (skipIfNoDb()) return;
      const app = makeApp();
      const locationId = await setupLocation("Legacy Close Guard Loc");
      await setupDrawer(locationId);

      // Open a shift — this auto-creates and links a cash session
      const openRes = await request(app)
        .post("/api/cmc-pos/shifts")
        .set("x-test-user-id", USER_A)
        .send({ location_id: locationId, opening_cash: 100 });
      expect(openRes.status).toBe(201);
      const shiftId = openRes.body.shift?.id as number;

      // Attempt to close via the legacy endpoint
      const closeRes = await request(app)
        .post(`/api/cmc-pos/shifts/${shiftId}/close`)
        .set("x-test-user-id", USER_A)
        .send({ totals_by_method: {} });

      expect(closeRes.status).toBe(409);
      expect(closeRes.body.code).toBe("USE_RECONCILIATION_CLOSE");

      // Session must still be open (not orphaned)
      const sess = await q<{ status: string }>(
        `SELECT status FROM cash_sessions WHERE id = $1`, [openRes.body.cash_session_id],
      );
      expect(sess.rows[0].status).toBe("open");
    });

    it("returns 422 NO_ACTIVE_DRAWER when starting a shift at a location with no active cash drawer", async () => {
      if (skipIfNoDb()) return;
      const app = makeApp();
      // Location exists but has no active drawer
      const locationId = await setupLocation("Drawerless Loc");
      // No setupDrawer call

      const openRes = await request(app)
        .post("/api/cmc-pos/shifts")
        .set("x-test-user-id", USER_A)
        .send({ location_id: locationId, opening_cash: 0 });
      expect(openRes.status).toBe(422);
      expect(openRes.body.code).toBe("NO_ACTIVE_DRAWER");

      // Verify no shift row was persisted
      const rows = await q<{ id: number }>(
        `SELECT id FROM cmc_shifts WHERE workspace_owner_id = $1 AND location_id = $2`,
        [OWNER_ID, locationId],
      );
      expect(rows.rowCount).toBe(0);
    });

    it("allows the legacy endpoint for a historical shift with no linked cash session", async () => {
      if (skipIfNoDb()) return;
      const app = makeApp();
      // Simulate a historical null-session shift (created before the NO_ACTIVE_DRAWER
      // guard was added) by inserting it directly via SQL.
      const locationId = await setupLocation("Legacy Drawerless Loc");

      const shiftRow = await q<{ id: number }>(
        `INSERT INTO cmc_shifts
           (workspace_owner_id, location_id, opened_by_user_id, opening_cash, cash_session_id, status)
         VALUES ($1, $2, $3, 0, NULL, 'open') RETURNING id`,
        [OWNER_ID, locationId, USER_A],
      );
      const shiftId = shiftRow.rows[0].id;

      const closeRes = await request(app)
        .post(`/api/cmc-pos/shifts/${shiftId}/close`)
        .set("x-test-user-id", USER_A)
        .send({});
      expect(closeRes.status).toBe(200);
    });

    it("closes a historical drawer-less shift directly via the reconciliation endpoint (no NO_LINKED_SESSION error)", async () => {
      if (skipIfNoDb()) return;
      const app = makeApp();
      // Simulate a historical null-session shift inserted directly (cannot be created
      // via the API anymore — the NO_ACTIVE_DRAWER guard prevents it).
      const locationId = await setupLocation("Legacy Drawerless Recon Loc");

      const shiftRow = await q<{ id: number }>(
        `INSERT INTO cmc_shifts
           (workspace_owner_id, location_id, opened_by_user_id, opening_cash, cash_session_id, status)
         VALUES ($1, $2, $3, 0, NULL, 'open') RETURNING id`,
        [OWNER_ID, locationId, USER_A],
      );
      const shiftId = shiftRow.rows[0].id;

      // Drawer-less shifts close directly — cash reconciliation is skipped.
      const closeRes = await request(app)
        .post("/api/cmc-pos/shifts/close")
        .set("x-test-user-id", USER_A)
        .send({ cash_kept: 0, cash_transferred: 0 });
      expect(closeRes.status).toBe(200);
      expect(closeRes.body.drawerless).toBe(true);
      expect(closeRes.body.shift.id).toBe(shiftId);

      const row = await q<{ status: string; closed_by_user_id: string | null }>(
        `SELECT status, closed_by_user_id FROM cmc_shifts WHERE id = $1`,
        [shiftId],
      );
      expect(row.rows[0].status).toBe("closed");
      expect(row.rows[0].closed_by_user_id).toBe(USER_A);
    });

    it("rejects a transfer during a drawer-less close (no session to record the outgoing cash)", async () => {
      if (skipIfNoDb()) return;
      const app = makeApp();
      const locationId = await setupLocation("Drawerless Transfer Loc");
      await q(
        `INSERT INTO cmc_shifts
           (workspace_owner_id, location_id, opened_by_user_id, opening_cash, cash_session_id, status)
         VALUES ($1, $2, $3, 0, NULL, 'open')`,
        [OWNER_ID, locationId, USER_A],
      );

      const closeRes = await request(app)
        .post("/api/cmc-pos/shifts/close")
        .set("x-test-user-id", USER_A)
        .send({ cash_kept: 0, cash_transferred: 50, destination_location_id: locationId + 1 });
      expect(closeRes.status).toBe(422);
      expect(closeRes.body.code).toBe("NO_LINKED_SESSION");
    });
  });

  // ── Non-opener close & clean reopen ─────────────────────────────────────────

  describe("POST /api/cmc-pos/shifts/close — any CMC POS user can close the location's shift", () => {
    it("lets USER_B close a shift opened by USER_A, recording USER_B as the closer", async () => {
      if (skipIfNoDb()) return;
      const app = makeApp();
      const locationId = await setupLocation("Non-Opener Close Loc");
      await setupDrawer(locationId);

      const openRes = await request(app)
        .post("/api/cmc-pos/shifts")
        .set("x-test-user-id", USER_A)
        .send({ location_id: locationId, opening_cash: 100 });
      expect(openRes.status).toBe(201);
      const sessionId = openRes.body.cash_session_id as number;

      // USER_B (not the opener) closes the shift with matching totals
      const closeRes = await request(app)
        .post("/api/cmc-pos/shifts/close")
        .set("x-test-user-id", USER_B)
        .send({ cash_kept: 100, cash_transferred: 0, location_id: locationId });
      expect(closeRes.status).toBe(200);
      expect(closeRes.body.shift.opened_by_user_id).toBe(USER_A);
      expect(closeRes.body.shift.closed_by_user_id).toBe(USER_B);
      expect(closeRes.body.shift.status).toBe("closed");

      // Linked session is released (no longer open)
      const sess = await q<{ status: string }>(
        `SELECT status FROM cash_sessions WHERE id = $1`, [sessionId],
      );
      expect(sess.rows[0].status).toBe("pending_review");
    });

    it("observed sequence: A opens, B closes, A reopens immediately with no 409", async () => {
      if (skipIfNoDb()) return;
      const app = makeApp();
      const locationId = await setupLocation("Reopen Sequence Loc");
      await setupDrawer(locationId);

      // 1. USER_A opens a shift
      const open1 = await request(app)
        .post("/api/cmc-pos/shifts")
        .set("x-test-user-id", USER_A)
        .send({ location_id: locationId, opening_cash: 50 });
      expect(open1.status).toBe(201);

      // 2. USER_B closes it (previously 404'd — only the opener's shift matched)
      const close1 = await request(app)
        .post("/api/cmc-pos/shifts/close")
        .set("x-test-user-id", USER_B)
        .send({ cash_kept: 50, cash_transferred: 0 });
      expect(close1.status).toBe(200);

      // 3. USER_A reopens — must not 409 on the closed shift or a stale session lock
      const open2 = await request(app)
        .post("/api/cmc-pos/shifts")
        .set("x-test-user-id", USER_A)
        .send({ location_id: locationId, opening_cash: 50 });
      expect(open2.status).toBe(201);
      expect(open2.body.cash_session_id).toBeTypeOf("number");
      expect(open2.body.cash_session_id).not.toBe(open1.body.cash_session_id);

      // 4. And USER_B can close the reopened shift too
      const close2 = await request(app)
        .post("/api/cmc-pos/shifts/close")
        .set("x-test-user-id", USER_B)
        .send({ cash_kept: 50, cash_transferred: 0 });
      expect(close2.status).toBe(200);

      // No open shifts or sessions remain
      const openShifts = await q(
        `SELECT id FROM cmc_shifts WHERE workspace_owner_id = $1 AND status = 'open'`, [OWNER_ID],
      );
      expect(openShifts.rowCount).toBe(0);
      const openSessions = await q(
        `SELECT id FROM cash_sessions WHERE workspace_owner_id = $1 AND status = 'open'`, [OWNER_ID],
      );
      expect(openSessions.rowCount).toBe(0);
    });

    it("a shift closed by someone else no longer counts against its opener's duplicate-shift check", async () => {
      if (skipIfNoDb()) return;
      const app = makeApp();
      const locationId = await setupLocation("Dup Check Consistency Loc");
      await setupDrawer(locationId);

      const open1 = await request(app)
        .post("/api/cmc-pos/shifts")
        .set("x-test-user-id", USER_A)
        .send({ location_id: locationId, opening_cash: 0 });
      expect(open1.status).toBe(201);

      // While open it DOES count
      const dup = await request(app)
        .post("/api/cmc-pos/shifts")
        .set("x-test-user-id", USER_A)
        .send({ location_id: locationId, opening_cash: 0 });
      expect(dup.status).toBe(409);

      // USER_B closes A's shift
      const close = await request(app)
        .post("/api/cmc-pos/shifts/close")
        .set("x-test-user-id", USER_B)
        .send({ cash_kept: 0, cash_transferred: 0 });
      expect(close.status).toBe(200);

      // A can open again — the closed shift no longer blocks
      const open2 = await request(app)
        .post("/api/cmc-pos/shifts")
        .set("x-test-user-id", USER_A)
        .send({ location_id: locationId, opening_cash: 0 });
      expect(open2.status).toBe(201);
    });

    it("scopes the close to the requested location when location_id is provided", async () => {
      if (skipIfNoDb()) return;
      const app = makeApp();
      const locA = await setupLocation("Scoped Close Loc A");
      const locB = await setupLocation("Scoped Close Loc B");
      await setupDrawer(locA);
      await setupDrawer(locB);

      const openA = await request(app)
        .post("/api/cmc-pos/shifts")
        .set("x-test-user-id", USER_A)
        .send({ location_id: locA, opening_cash: 10 });
      expect(openA.status).toBe(201);
      const openB = await request(app)
        .post("/api/cmc-pos/shifts")
        .set("x-test-user-id", USER_B)
        .send({ location_id: locB, opening_cash: 20 });
      expect(openB.status).toBe(201);

      // Close only location A's shift (even though B's is more recent)
      const closeRes = await request(app)
        .post("/api/cmc-pos/shifts/close")
        .set("x-test-user-id", USER_B)
        .send({ cash_kept: 10, cash_transferred: 0, location_id: locA });
      expect(closeRes.status).toBe(200);
      expect(closeRes.body.shift.location_id).toBe(locA);

      // Location B's shift is still open
      const stillOpen = await q<{ location_id: number }>(
        `SELECT location_id FROM cmc_shifts WHERE workspace_owner_id = $1 AND status = 'open'`, [OWNER_ID],
      );
      expect(stillOpen.rowCount).toBe(1);
      expect(stillOpen.rows[0].location_id).toBe(locB);
    });
  });

  // ── Transfer currency mismatch ────────────────────────────────────────────────

  describe("POST /api/cmc-pos/shifts/close — currency-mismatch transfer rejection", () => {
    it("returns 422 CURRENCY_MISMATCH_TRANSFER when source and destination sessions use different currencies", async () => {
      // A transfer of 100 from an AED session to a USD session would record
      // AED 100 out and USD 100 in — numerically equal but economically wrong.
      // The endpoint must reject this with a clear error.
      if (skipIfNoDb()) return;
      const app = makeApp();
      const srcLocationId = await setupLocation("Mismatch Src Loc");
      const dstLocationId = await setupLocation("Mismatch Dst Loc");

      // Source: AED drawer
      const srcCode = `MMSRC${srcLocationId}`;
      const srcDrawerRes = await q<{ id: number }>(
        `INSERT INTO cash_drawers (workspace_owner_id, name, code, location_id, currency, is_active)
         VALUES ($1, $2, $3, $4, 'AED', true) RETURNING id`,
        [OWNER_ID, `AED Drawer`, srcCode, srcLocationId],
      );
      const srcDrawerId = srcDrawerRes.rows[0].id;

      // Destination: USD drawer + open session
      const dstCode = `MMDST${dstLocationId}`;
      const dstDrawerRes = await q<{ id: number }>(
        `INSERT INTO cash_drawers (workspace_owner_id, name, code, location_id, currency, is_active)
         VALUES ($1, $2, $3, $4, 'USD', true) RETURNING id`,
        [OWNER_ID, `USD Drawer`, dstCode, dstLocationId],
      );
      const dstDrawerId = dstDrawerRes.rows[0].id;
      await setupOpenSession(dstDrawerId, dstLocationId, 0);

      // Open a shift at the AED location (creates an AED session)
      const openRes = await request(app)
        .post("/api/cmc-pos/shifts")
        .set("x-test-user-id", USER_A)
        .send({ location_id: srcLocationId, opening_cash: 500 });
      expect(openRes.status).toBe(201);
      expect(openRes.body.cash_session_id).toBeGreaterThan(0);

      // Attempt to transfer to the USD destination
      const closeRes = await request(app)
        .post("/api/cmc-pos/shifts/close")
        .set("x-test-user-id", USER_A)
        .send({
          cash_kept: 400,
          cash_transferred: 100,
          destination_location_id: dstLocationId,
        });
      expect(closeRes.status).toBe(422);
      expect(closeRes.body.code).toBe("CURRENCY_MISMATCH_TRANSFER");
      expect(closeRes.body.source_currency).toBe("AED");
      expect(closeRes.body.destination_currency).toBe("USD");

      // Shift must still be open — no partial close
      const shiftRow = await q<{ status: string }>(
        `SELECT status FROM cmc_shifts WHERE opened_by_user_id = $1 AND workspace_owner_id = $2 AND status = 'open'`,
        [USER_A, OWNER_ID],
      );
      expect(shiftRow.rows).toHaveLength(1);
    });
  });

  describe("POST /api/cmc-pos/shifts/close — currency-mismatch enforced inside transaction", () => {
    it("returns 422 CURRENCY_MISMATCH_TRANSFER when destination session currency differs from source (transactional check)", async () => {
      // Simulates the rollover race: the pre-transaction check passed on a
      // same-currency session, but by the time the transaction locks the
      // destination, a different-currency session is the active one.
      // We reproduce the race by directly inserting a mismatched session
      // and pre-closing the matching one between pre-check and the tx lock.
      if (skipIfNoDb()) return;
      const app = makeApp();
      const srcLocationId = await setupLocation("TxMismatch Src");
      const dstLocationId = await setupLocation("TxMismatch Dst");

      // Source: AED drawer
      const srcCode = `TXSRC${srcLocationId}`;
      await q(
        `INSERT INTO cash_drawers (workspace_owner_id, name, code, location_id, currency, is_active)
         VALUES ($1, $2, $3, $4, 'AED', true)`,
        [OWNER_ID, "AED Drawer TxM", srcCode, srcLocationId],
      );

      // Destination: AED session initially (passes pre-check), then we close it
      // and open a USD session before the tx starts. Since we can't truly race in
      // a single-process integration test, we directly set up the post-race state:
      // destination has only a USD session open.
      const dstCode = `TXDST${dstLocationId}`;
      const dstDrawerRes = await q<{ id: number }>(
        `INSERT INTO cash_drawers (workspace_owner_id, name, code, location_id, currency, is_active)
         VALUES ($1, $2, $3, $4, 'USD', true) RETURNING id`,
        [OWNER_ID, "USD Drawer TxM", dstCode, dstLocationId],
      );
      const dstDrawerId = dstDrawerRes.rows[0].id;
      // Open a USD session at the destination
      await setupOpenSession(dstDrawerId, dstLocationId, 0);

      // Open AED source shift
      const openRes = await request(app)
        .post("/api/cmc-pos/shifts")
        .set("x-test-user-id", USER_A)
        .send({ location_id: srcLocationId, opening_cash: 300 });
      expect(openRes.status).toBe(201);

      // Attempt transfer to USD destination — CURRENCY_MISMATCH_TRANSFER expected
      const closeRes = await request(app)
        .post("/api/cmc-pos/shifts/close")
        .set("x-test-user-id", USER_A)
        .send({ cash_kept: 200, cash_transferred: 100, destination_location_id: dstLocationId });
      expect(closeRes.status).toBe(422);
      expect(closeRes.body.code).toBe("CURRENCY_MISMATCH_TRANSFER");
      expect(closeRes.body.source_currency).toBe("AED");
      expect(closeRes.body.destination_currency).toBe("USD");

      // Source shift must still be open — the whole transaction rolled back
      const shiftRow = await q<{ status: string }>(
        `SELECT status FROM cmc_shifts WHERE opened_by_user_id = $1 AND workspace_owner_id = $2 AND status = 'open'`,
        [USER_A, OWNER_ID],
      );
      expect(shiftRow.rows).toHaveLength(1);

      // No outgoing transfer row should exist on the source session
      const srcSessionId = openRes.body.cash_session_id as number;
      const txRows = await q<{ type: string }>(
        `SELECT type FROM cash_transactions WHERE cash_session_id = $1`, [srcSessionId],
      );
      expect(txRows.rows.filter((r) => r.type === "transfer")).toHaveLength(0);
    });
  });

  // ── Transfer race: concurrent destination close ──────────────────────────────

  describe("POST /api/cmc-pos/shifts/close — concurrent destination-close race", () => {
    it("returns 409 DEST_SESSION_CLOSED_RACE and rolls back when destination session closes mid-transaction", async () => {
      if (skipIfNoDb()) return;
      const app = makeApp();
      const srcLocationId = await setupLocation("Race Src Loc");
      const dstLocationId = await setupLocation("Race Dst Loc");
      const { drawerId: srcDrawerId } = await setupDrawer(srcLocationId);
      const { drawerId: dstDrawerId } = await setupDrawer(dstLocationId);

      // Open source shift (auto-creates src session with opening_cash=300)
      const openRes = await request(app)
        .post("/api/cmc-pos/shifts")
        .set("x-test-user-id", USER_A)
        .send({ location_id: srcLocationId, opening_cash: 300 });
      expect(openRes.status).toBe(201);
      const srcShiftId = openRes.body.shift.id as number;
      const srcSessionId = openRes.body.cash_session_id as number;

      // Create destination session
      const dstSessionId = await setupOpenSession(dstDrawerId, dstLocationId, 50);

      // ── Simulate the mid-transaction race via a real HTTP server ─────────────
      // supertest lazily sends requests (only when awaited), so we must use a real
      // bound server + Node.js native fetch so the request starts processing
      // immediately — concurrent with our lock-and-close sequence.
      //
      // Strategy:
      //   1. Bind the Express app to a real port.
      //   2. Acquire a FOR UPDATE lock on the destination session (holds it).
      //   3. Call fetch() on the close endpoint — it starts processing NOW, in
      //      the same event loop.  Pre-validation reads session as 'open' (plain
      //      SELECT is not blocked by FOR UPDATE).  The handler then starts a
      //      transaction and blocks when it tries FOR UPDATE on the same row.
      //   4. Wait briefly (event loop yields to the HTTP handler).
      //   5. Close the destination session and COMMIT — releasing the lock.
      //   6. The blocked HTTP handler resumes, sees status ≠ 'open', throws
      //      DEST_SESSION_CLOSED_RACE → route returns 409 and rolls back the tx.
      //   7. Verify: source shift/session still open (rollback was atomic).

      const server = app.listen(0);
      const port = (server.address() as { port: number }).port;
      const lockClient = await pool.connect();

      try {
        // Step 2: hold the lock
        await lockClient.query("BEGIN");
        await lockClient.query(
          "SELECT id FROM cash_sessions WHERE id = $1 FOR UPDATE",
          [dstSessionId],
        );

        // Step 3: fire the HTTP request immediately via native fetch (non-lazy)
        const fetchPromise = fetch(`http://127.0.0.1:${port}/api/cmc-pos/shifts/close`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-test-user-id": USER_A,
          },
          body: JSON.stringify({
            cash_kept: 0,
            cash_transferred: 300,
            destination_location_id: dstLocationId,
          }),
        });

        // Step 4: yield to the event loop so the handler can run past pre-validation
        // and reach the blocked FOR UPDATE
        await new Promise((r) => setTimeout(r, 500));

        // Step 5: close session and commit — releases the lock
        await lockClient.query(
          "UPDATE cash_sessions SET status = 'pending_review', closed_at = now() WHERE id = $1",
          [dstSessionId],
        );
        await lockClient.query("COMMIT");

        // Step 6: await the response
        const httpRes = await fetchPromise;
        const body = await httpRes.json() as { code?: string };

        expect(httpRes.status).toBe(409);
        expect(body.code).toBe("DEST_SESSION_CLOSED_RACE");
      } finally {
        lockClient.release();
        await new Promise<void>((r) => server.close(() => r()));
      }

      // Step 7: verify atomicity — source shift and session must still be open
      const srcShiftRow = await q<{ status: string }>(
        `SELECT status FROM cmc_shifts WHERE id = $1`, [srcShiftId],
      );
      expect(srcShiftRow.rows[0].status).toBe("open");

      const srcSessRow = await q<{ status: string }>(
        `SELECT status FROM cash_sessions WHERE id = $1`, [srcSessionId],
      );
      expect(srcSessRow.rows[0].status).toBe("open");
    });
  });

  // ── Audit trail ─────────────────────────────────────────────────────────────

  // ── Legacy-duplicate remediation (production safety) ─────────────────────────
  // These tests verify that the initDb.ts pre-index remediation queries correctly
  // resolve pre-existing duplicate open rows that would otherwise cause the
  // CREATE UNIQUE INDEX to fail on upgraded production databases.

  describe("Legacy-duplicate remediation — pre-index migration safety", () => {
    it("closes duplicate open cash sessions for the same drawer, keeping only the newest", async () => {
      if (skipIfNoDb()) return;
      const locationId = await setupLocation("Remediation Session Loc");
      const { drawerId } = await setupDrawer(locationId);

      // Seed two open sessions directly (bypassing the route's uniqueness guard)
      // to simulate a legacy database state predating the unique index.
      const olderSessNum = `REM-OLDER-${Date.now()}`;
      const newerSessNum = `REM-NEWER-${Date.now()}`;

      // Drop the unique index temporarily so we can insert duplicates
      await q(`DROP INDEX IF EXISTS idx_cash_sessions_one_open_per_drawer`);

      const olderResult = await q<{ id: number }>(
        `INSERT INTO cash_sessions
           (workspace_owner_id, session_number, drawer_id, location_id, currency,
            status, opening_cash, expected_cash, opened_by_clerk_id, opened_at)
         VALUES ($1, $2, $3, $4, 'USD', 'open', 100, 100, $5, now() - interval '1 hour')
         RETURNING id`,
        [OWNER_ID, olderSessNum, drawerId, locationId, USER_A],
      );
      const newerId = (await q<{ id: number }>(
        `INSERT INTO cash_sessions
           (workspace_owner_id, session_number, drawer_id, location_id, currency,
            status, opening_cash, expected_cash, opened_by_clerk_id, opened_at)
         VALUES ($1, $2, $3, $4, 'USD', 'open', 200, 200, $5, now())
         RETURNING id`,
        [OWNER_ID, newerSessNum, drawerId, locationId, USER_A],
      )).rows[0].id;
      const olderId = olderResult.rows[0].id;

      // Run the remediation query (from initDb.ts)
      await q(`
        UPDATE cash_sessions
           SET status = 'pending_review', closed_at = COALESCE(closed_at, now())
         WHERE status = 'open'
           AND id NOT IN (
             SELECT DISTINCT ON (drawer_id) id
               FROM cash_sessions
              WHERE status = 'open'
              ORDER BY drawer_id, opened_at DESC NULLS LAST
           )
      `);

      // Verify: only the newest survives as 'open'
      const sessions = await q<{ id: number; status: string }>(
        `SELECT id, status FROM cash_sessions WHERE id = ANY($1)`,
        [[olderId, newerId]],
      );
      const byId = Object.fromEntries(sessions.rows.map((r) => [r.id, r.status]));
      expect(byId[olderId]).toBe("pending_review");
      expect(byId[newerId]).toBe("open");

      // Verify the unique index can now be (re)created without error
      await q(`CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_sessions_one_open_per_drawer ON cash_sessions(drawer_id) WHERE status = 'open'`);
    });

    it("closes duplicate open cmc_shifts for the same workspace+user, keeping only the newest", async () => {
      if (skipIfNoDb()) return;
      const locationId = await setupLocation("Remediation Shift Loc");

      // Seed two open shifts directly to simulate a legacy database state
      await q(`DROP INDEX IF EXISTS idx_cmc_shifts_one_open_per_user`);

      const olderShiftResult = await q<{ id: number }>(
        `INSERT INTO cmc_shifts
           (workspace_owner_id, location_id, opened_by_user_id, status, opened_at)
         VALUES ($1, $2, $3, 'open', now() - interval '1 hour')
         RETURNING id`,
        [OWNER_ID, locationId, USER_A],
      );
      const newerShiftResult = await q<{ id: number }>(
        `INSERT INTO cmc_shifts
           (workspace_owner_id, location_id, opened_by_user_id, status, opened_at)
         VALUES ($1, $2, $3, 'open', now())
         RETURNING id`,
        [OWNER_ID, locationId, USER_A],
      );
      const olderShiftId = olderShiftResult.rows[0].id;
      const newerShiftId = newerShiftResult.rows[0].id;

      // Run the remediation query (from initDb.ts)
      await q(`
        UPDATE cmc_shifts
           SET status = 'closed', closed_at = COALESCE(closed_at, now())
         WHERE status = 'open'
           AND id NOT IN (
             SELECT DISTINCT ON (workspace_owner_id, opened_by_user_id) id
               FROM cmc_shifts
              WHERE status = 'open'
              ORDER BY workspace_owner_id, opened_by_user_id, opened_at DESC NULLS LAST
           )
      `);

      // Verify: only the newest remains 'open'
      const shifts = await q<{ id: number; status: string }>(
        `SELECT id, status FROM cmc_shifts WHERE id = ANY($1)`,
        [[olderShiftId, newerShiftId]],
      );
      const byId = Object.fromEntries(shifts.rows.map((r) => [r.id, r.status]));
      expect(byId[olderShiftId]).toBe("closed");
      expect(byId[newerShiftId]).toBe("open");

      // Verify the unique index can now be (re)created without error
      await q(`CREATE UNIQUE INDEX IF NOT EXISTS idx_cmc_shifts_one_open_per_user ON cmc_shifts(workspace_owner_id, opened_by_user_id) WHERE status = 'open'`);
    });
  });

  // ── Dual-currency drawer scenarios ──────────────────────────────────────────

  describe("POST /api/cmc-pos/shifts — dual-currency drawer", () => {
    async function setupDualDrawer(locationId: number, primary = "AED", secondary = "USD"): Promise<number> {
      const r = await q<{ id: number }>(
        `INSERT INTO cash_drawers (workspace_owner_id, name, location_id, code, currency, secondary_currency, is_active)
         VALUES ($1, 'Dual Drawer', $2, $3, $4, $5, true) RETURNING id`,
        [OWNER_ID, locationId, `DUAL-${locationId}`, primary, secondary],
      );
      return r.rows[0].id;
    }

    it("201: dual-currency drawer with valid currency param → shift created with chosen currency", async () => {
      if (skipIfNoDb()) return;
      const app = makeApp();
      const locationId = await setupLocation("Dual OK USD Loc");
      await setupDualDrawer(locationId, "AED", "USD");

      const res = await request(app)
        .post("/api/cmc-pos/shifts")
        .set("x-test-user-id", USER_A)
        .send({ location_id: locationId, opening_cash: 100, currency: "USD" });

      expect(res.status).toBe(201);
      expect(res.body.cash_session_id).toBeTypeOf("number");

      // Verify the shift persists the chosen currency
      const shiftRow = await q<{ currency: string }>(
        `SELECT currency FROM cmc_shifts WHERE id = $1`,
        [res.body.shift.id],
      );
      expect(shiftRow.rows[0].currency).toBe("USD");

      // The cash session must use the chosen currency
      const sessionRow = await q<{ currency: string; secondary_currency: string | null }>(
        `SELECT currency, secondary_currency FROM cash_sessions WHERE id = $1`,
        [res.body.cash_session_id],
      );
      expect(sessionRow.rows[0].currency).toBe("USD");
      // secondary_currency stays null → single-currency session
      expect(sessionRow.rows[0].secondary_currency).toBeNull();
    });

    it("201: dual-currency drawer with primary currency also works", async () => {
      if (skipIfNoDb()) return;
      const app = makeApp();
      const locationId = await setupLocation("Dual OK AED Loc");
      await setupDualDrawer(locationId, "AED", "USD");

      const res = await request(app)
        .post("/api/cmc-pos/shifts")
        .set("x-test-user-id", USER_A)
        .send({ location_id: locationId, opening_cash: 50, currency: "AED" });

      expect(res.status).toBe(201);

      const shiftRow = await q<{ currency: string }>(
        `SELECT currency FROM cmc_shifts WHERE id = $1`,
        [res.body.shift.id],
      );
      expect(shiftRow.rows[0].currency).toBe("AED");
    });

    it("201: dual-currency drawer without currency param → defaults to primary currency and succeeds", async () => {
      // Omitting `currency` no longer rejects — the route defaults to the drawer's
      // primary currency instead of returning DUAL_CURRENCY_DRAWER_NOT_SUPPORTED.
      if (skipIfNoDb()) return;
      const app = makeApp();
      const locationId = await setupLocation("Dual No Currency Loc");
      await setupDualDrawer(locationId, "AED", "USD");

      const res = await request(app)
        .post("/api/cmc-pos/shifts")
        .set("x-test-user-id", USER_A)
        .send({ location_id: locationId, opening_cash: 100 }); // no currency → defaults to AED

      expect(res.status).toBe(201);
      expect(res.body.cash_session_id).toBeTypeOf("number");

      // Shift currency must be the drawer's primary currency
      const shiftRow = await q<{ currency: string }>(
        `SELECT currency FROM cmc_shifts WHERE id = $1`,
        [res.body.shift.id],
      );
      expect(shiftRow.rows[0].currency).toBe("AED");
    });

    it("422 DUAL_CURRENCY_DRAWER_NOT_SUPPORTED: dual-currency drawer with invalid currency → rejected", async () => {
      if (skipIfNoDb()) return;
      const app = makeApp();
      const locationId = await setupLocation("Dual Bad Currency Loc");
      await setupDualDrawer(locationId, "AED", "USD");

      const res = await request(app)
        .post("/api/cmc-pos/shifts")
        .set("x-test-user-id", USER_A)
        .send({ location_id: locationId, opening_cash: 100, currency: "LBP" }); // not AED or USD

      expect(res.status).toBe(422);
      expect(res.body.code).toBe("DUAL_CURRENCY_DRAWER_NOT_SUPPORTED");
    });

    it("422 SESSION_CURRENCY_MISMATCH: rejects adopt of an existing single-currency session in the wrong currency", async () => {
      if (skipIfNoDb()) return;
      const app = makeApp();
      const locationId = await setupLocation("Dual Mismatch Loc");
      const drawerId = await setupDualDrawer(locationId, "AED", "USD");

      // Open a USD cash session directly (simulating Cash Desk flow)
      await setupOpenSession(drawerId, locationId, 0);
      // setupOpenSession creates a session with the workspace default currency;
      // let's verify by overriding it to USD explicitly
      await q(`UPDATE cash_sessions SET currency = 'USD', secondary_currency = NULL WHERE drawer_id = $1 AND status = 'open'`, [drawerId]);

      // Try to start a shift choosing AED — must be rejected (existing session is USD)
      const res = await request(app)
        .post("/api/cmc-pos/shifts")
        .set("x-test-user-id", USER_A)
        .send({ location_id: locationId, opening_cash: 0, currency: "AED" });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe("SESSION_CURRENCY_MISMATCH");
    });

    it("422 SESSION_CURRENCY_MISMATCH: rejects adopt of a dual-currency session even if currency matches primary", async () => {
      if (skipIfNoDb()) return;
      const app = makeApp();
      const locationId = await setupLocation("Dual Session Mismatch Loc");
      const drawerId = await setupDualDrawer(locationId, "AED", "USD");

      // Open a dual-currency session directly (simulating Cash Desk flow for a dual drawer)
      await setupOpenSession(drawerId, locationId, 0);
      await q(`UPDATE cash_sessions SET currency = 'AED', secondary_currency = 'USD' WHERE drawer_id = $1 AND status = 'open'`, [drawerId]);

      // Try to start a CMC shift with AED — must be rejected (existing session is dual-currency)
      const res = await request(app)
        .post("/api/cmc-pos/shifts")
        .set("x-test-user-id", USER_A)
        .send({ location_id: locationId, opening_cash: 0, currency: "AED" });

      expect(res.status).toBe(422);
      expect(res.body.code).toBe("SESSION_CURRENCY_MISMATCH");
    });

    it("201: adopts an existing single-currency session when currency matches the chosen currency", async () => {
      if (skipIfNoDb()) return;
      const app = makeApp();
      const locationId = await setupLocation("Dual Match Adopt Loc");
      const drawerId = await setupDualDrawer(locationId, "AED", "USD");

      // Open a USD session (matching what the operator will choose)
      const existingSessionId = await setupOpenSession(drawerId, locationId, 50);
      await q(`UPDATE cash_sessions SET currency = 'USD', secondary_currency = NULL WHERE id = $1`, [existingSessionId]);

      // Start shift choosing USD — should adopt the existing session
      const res = await request(app)
        .post("/api/cmc-pos/shifts")
        .set("x-test-user-id", USER_A)
        .send({ location_id: locationId, opening_cash: 50, currency: "USD" });

      expect(res.status).toBe(201);
      // Adopted session — same session id
      expect(res.body.cash_session_id).toBe(existingSessionId);

      const shiftRow = await q<{ currency: string }>(
        `SELECT currency FROM cmc_shifts WHERE id = $1`, [res.body.shift.id],
      );
      expect(shiftRow.rows[0].currency).toBe("USD");
    });

    it("reconciliation sums only the chosen currency's transactions at shift close", async () => {
      if (skipIfNoDb()) return;
      const app = makeApp();
      const locationId = await setupLocation("Dual Recon Loc");
      const drawerId = await setupDualDrawer(locationId, "AED", "USD");

      // Open shift choosing USD
      const openRes = await request(app)
        .post("/api/cmc-pos/shifts")
        .set("x-test-user-id", USER_A)
        .send({ location_id: locationId, opening_cash: 0, currency: "USD" });
      expect(openRes.status).toBe(201);
      const sessionId = openRes.body.cash_session_id as number;

      // Insert two cash_transactions: one USD (should count), one AED (must be excluded)
      await q(
        `INSERT INTO cash_transactions
           (workspace_owner_id, cash_session_id, location_id, currency, type, direction, amount, created_by_clerk_id)
         VALUES
           ($1, $2, $3, 'USD', 'cash_sale', 'in', 120, $4),
           ($1, $2, $3, 'AED', 'cash_sale', 'in', 500, $4)`,
        [OWNER_ID, sessionId, locationId, USER_A],
      );

      const closeRes = await request(app)
        .post("/api/cmc-pos/shifts/close")
        .set("x-test-user-id", USER_A)
        .send({ cash_kept: 120, cash_transferred: 0 }); // expected = 0 + 120 USD = 120

      expect(closeRes.status).toBe(200);
      // expected_balance must be 120 (USD only), not 620 (USD + AED)
      expect(closeRes.body.expected_balance).toBeCloseTo(120, 1);
      // discrepancy = kept − expected = 120 − 120 = 0
      expect(closeRes.body.discrepancy).toBeCloseTo(0, 2);
    });
  });

  describe("Discrepancy audit trail", () => {
    it("stores discrepancy_note on the shift row when note is provided", async () => {
      if (skipIfNoDb()) return;
      const app = makeApp();
      const locationId = await setupLocation("Audit Loc");
      await setupDrawer(locationId);

      const openRes = await request(app)
        .post("/api/cmc-pos/shifts")
        .set("x-test-user-id", USER_A)
        .send({ location_id: locationId, opening_cash: 100 });
      expect(openRes.status).toBe(201);
      const shiftId = openRes.body.shift?.id as number;

      await request(app)
        .post("/api/cmc-pos/shifts/close")
        .set("x-test-user-id", USER_A)
        .send({
          cash_kept: 90,
          cash_transferred: 0,
          discrepancy_note: "Short by $10 — unexpected",
        });

      const row = await q<{ discrepancy_note: string }>(
        `SELECT discrepancy_note FROM cmc_shifts WHERE id = $1`, [shiftId],
      );
      expect(row.rows[0].discrepancy_note).toBe("Short by $10 — unexpected");
    });
  });
});
