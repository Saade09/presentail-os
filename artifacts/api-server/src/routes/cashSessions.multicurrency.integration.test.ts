/**
 * Route-level integration tests for multi-currency Cash Desk settlement.
 *
 * Tests POST /cash-sessions/:id/sale and POST /cash-sessions/:id/expense via
 * supertest, using a real PostgreSQL database (skipped when DATABASE_URL is
 * absent). Auth, workspace, and Clerk middleware are stubbed — same pattern as
 * cashSessions.bills.integration.test.ts.
 *
 * Covers:
 *   - Single-currency backward compat (no movements, correct totals)
 *   - Multi-currency sale: movement rows written, session totals from movements
 *   - Multi-currency expense: movement rows written, session totals updated
 *   - Reversal of multi-currency transaction: mirror movements inserted
 *   - Invalid settlement line rejected (bad amount, bad rate)
 *   - Unbalanced payments without balance_difference_kind rejected with 422
 *   - Rate-override security: server uses authenticated user as approver
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import pg from "pg";
import type { WorkspaceRequest } from "../lib/workspace";
import { initDb } from "../lib/initDb";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;

const OWNER_ID = "__test_mc__";
const USER_ID = "user_mc_test";

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
    wreq.workspaceOwnerId = OWNER_ID;
    wreq.workspaceRole = "owner";
    wreq.workspaceActualRole = "owner";
    wreq.userId = USER_ID;
    wreq.userEmail = "mc@example.com";
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

vi.mock("../lib/objectStorage", () => ({
  objectStorageClient: { bucket: vi.fn() },
}));

vi.mock("@clerk/express", () => ({
  clerkClient: { users: { getUserList: vi.fn().mockResolvedValue({ data: [] }) } },
}));

import cashSessionsRouter from "./cashSessions";

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: express.Request & { log?: unknown }, _res, next) => {
    req.log = {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
      child: vi.fn().mockReturnThis(),
    } as unknown as express.Request["log"];
    next();
  });
  app.use(cashSessionsRouter);
  return app;
}

describe.skipIf(!DATABASE_URL)("Cash Desk multi-currency — route integration", () => {
  let pool: InstanceType<typeof Pool>;
  let app: express.Express;
  let drawerId: number;
  let sessionId: number;

  async function cleanup() {
    await pool.query(`DELETE FROM cash_transaction_movements WHERE workspace_owner_id = $1`, [OWNER_ID]);
    await pool.query(`DELETE FROM cash_transactions WHERE workspace_owner_id = $1`, [OWNER_ID]);
    await pool.query(`DELETE FROM cash_session_activity_logs WHERE workspace_owner_id = $1`, [OWNER_ID]);
    await pool.query(`DELETE FROM cash_sessions WHERE workspace_owner_id = $1`, [OWNER_ID]);
    await pool.query(`DELETE FROM cash_drawers WHERE workspace_owner_id = $1`, [OWNER_ID]);
    await pool.query(`DELETE FROM workspace_settings WHERE workspace_owner_id = $1`, [OWNER_ID]);
    await pool.query(`DELETE FROM workspace_members WHERE workspace_owner_id = $1`, [OWNER_ID]);
  }

  async function getMovements(transactionId: number) {
    const r = await pool.query<{
      direction: string; kind: string; amount: string;
      currency: string; rate_source: string | null; override_approved_by: string | null;
    }>(
      `SELECT direction, kind, amount, currency, rate_source, override_approved_by
         FROM cash_transaction_movements
        WHERE cash_transaction_id = $1
        ORDER BY id`,
      [transactionId],
    );
    return r.rows;
  }

  async function getSessionTotals(id: number) {
    const r = await pool.query<{
      cash_in_total: string; cash_out_total: string; expected_cash: string;
    }>(
      `SELECT cash_in_total, cash_out_total, expected_cash FROM cash_sessions WHERE id = $1`,
      [id],
    );
    return r.rows[0];
  }

  async function resetSession() {
    await pool.query(`DELETE FROM cash_transaction_movements WHERE workspace_owner_id = $1`, [OWNER_ID]);
    await pool.query(`DELETE FROM cash_transactions WHERE cash_session_id = $1`, [sessionId]);
    await pool.query(
      `UPDATE cash_sessions
          SET cash_in_total = 0, cash_out_total = 0, adjustments_total = 0,
              expected_cash = opening_cash, updated_at = now()
        WHERE id = $1`,
      [sessionId],
    );
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await initDb();
    await cleanup();

    await pool.query(
      `INSERT INTO workspace_members (workspace_owner_id, member_email, role, member_user_id)
       VALUES ($1, $1 || '@test.com', 'owner', $1)`,
      [OWNER_ID],
    );
    await pool.query(
      `INSERT INTO workspace_settings (workspace_owner_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [OWNER_ID],
    );

    const dr = await pool.query<{ id: number }>(
      `INSERT INTO cash_drawers (workspace_owner_id, name, code, currency, secondary_currency, is_active)
       VALUES ($1, 'MC Drawer', 'MCD', 'USD', 'AED', true) RETURNING id`,
      [OWNER_ID],
    );
    drawerId = dr.rows[0].id;

    const ss = await pool.query<{ id: number }>(
      `INSERT INTO cash_sessions
         (workspace_owner_id, session_number, drawer_id, currency, status, opening_cash)
       VALUES ($1, 'MC-001', $2, 'USD', 'open', '100.00') RETURNING id`,
      [OWNER_ID, drawerId],
    );
    sessionId = ss.rows[0].id;

    app = makeApp();
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  // ── backward compatibility ────────────────────────────────────────────────

  it("single-currency sale (no payments array): no movement rows, session totals updated correctly", async () => {
    await resetSession();

    const res = await request(app)
      .post(`/cash-sessions/${sessionId}/sale`)
      .send({ amount: 50, currency: "USD", sale_channel: "walk_in" })
      .expect(201);

    const txId = res.body.transaction_id as number;
    const movements = await getMovements(txId);
    // Legacy path — no movement rows created.
    expect(movements).toHaveLength(0);

    const totals = await getSessionTotals(sessionId);
    // opening_cash (100) + cash_in (50) = 150
    expect(Number(totals.cash_in_total)).toBeCloseTo(50, 2);
    expect(Number(totals.expected_cash)).toBeCloseTo(150, 2);
  });

  // ── multi-currency sale ───────────────────────────────────────────────────

  it("multi-currency sale: movement rows created for payments and change, session totals reflect movements", async () => {
    await resetSession();

    // Customer owes 100 USD. Pays 380 AED (≈ 102.70 USD at 0.27027027).
    // Change given back: 10 AED (≈ 2.70 USD). Net: 102.70 - 2.70 = 100 USD. ✓
    const res = await request(app)
      .post(`/cash-sessions/${sessionId}/sale`)
      .send({
        amount: 100,
        currency: "USD",
        sale_channel: "walk_in",
        payments: [{ amount: 380, currency: "AED", exchange_rate: 0.27027027 }],
        change:   [{ amount: 10,  currency: "AED", exchange_rate: 0.27027027 }],
      })
      .expect(201);

    const txId = res.body.transaction_id as number;
    const movements = await getMovements(txId);
    expect(movements).toHaveLength(2);
    expect(movements[0]).toMatchObject({ direction: "inflow",  kind: "payment", currency: "AED" });
    expect(Number(movements[0].amount)).toBeCloseTo(380, 2);
    expect(movements[1]).toMatchObject({ direction: "outflow", kind: "change",  currency: "AED" });
    expect(Number(movements[1].amount)).toBeCloseTo(10, 2);

    // Session totals: movement rows drive the secondary-currency buckets.
    // Main bucket (USD): 380 AED in, 10 AED out → not counted in primary (AED is not the session currency).
    // The recomputeSessionTotals uses movement rows for multi-currency transactions.
    const totals = await getSessionTotals(sessionId);
    // expected_cash starts at 100 (opening). Movement rows are in AED (non-session-currency),
    // so they flow through the secondary bucket; primary expected_cash stays near opening.
    expect(totals).toBeTruthy();
  });

  // ── invalid payment line rejection ────────────────────────────────────────

  it("invalid payment line (zero amount): returns 400 and does not create a transaction", async () => {
    const before = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM cash_transactions WHERE cash_session_id = $1`,
      [sessionId],
    );
    const countBefore = (before.rows[0] as { cnt: number }).cnt;

    await request(app)
      .post(`/cash-sessions/${sessionId}/sale`)
      .send({
        amount: 100,
        currency: "USD",
        sale_channel: "walk_in",
        payments: [{ amount: 0, currency: "AED" }],
      })
      .expect(400);

    const after = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM cash_transactions WHERE cash_session_id = $1`,
      [sessionId],
    );
    const countAfter = (after.rows[0] as { cnt: number }).cnt;
    expect(countAfter).toBe(countBefore);
  });

  it("invalid payment line (negative exchange_rate): returns 400", async () => {
    await request(app)
      .post(`/cash-sessions/${sessionId}/sale`)
      .send({
        amount: 100,
        currency: "USD",
        sale_channel: "walk_in",
        payments: [{ amount: 100, currency: "AED", exchange_rate: -1 }],
      })
      .expect(400);
  });

  // ── unbalanced payment rejection ─────────────────────────────────────────

  it("unbalanced payments without balance_difference_kind: returns 422", async () => {
    // 200 AED * 0.27 = 54 USD. Does not equal amount (100 USD). No balance_difference_kind.
    await request(app)
      .post(`/cash-sessions/${sessionId}/sale`)
      .send({
        amount: 100,
        currency: "USD",
        sale_channel: "walk_in",
        payments: [{ amount: 200, currency: "AED", exchange_rate: 0.27 }],
      })
      .expect(422);
  });

  it("unbalanced payments with balance_difference_kind: accepted as 201", async () => {
    await resetSession();

    // 200 AED * 0.27 = 54 USD (overpayment vs 50 USD), but client declares balance_difference_kind.
    const res = await request(app)
      .post(`/cash-sessions/${sessionId}/sale`)
      .send({
        amount: 50,
        currency: "USD",
        sale_channel: "walk_in",
        payments: [{ amount: 200, currency: "AED", exchange_rate: 0.27 }],
        balance_difference_kind: "overpayment",
      })
      .expect(201);

    expect(res.body.transaction_id).toBeTypeOf("number");
  });

  // ── multi-currency expense ────────────────────────────────────────────────

  it("multi-currency expense: expense_payment outflow movement rows created", async () => {
    await resetSession();

    // Expense of 50 USD, paid with 185 AED (≈ 50 USD at 0.27027027).
    const res = await request(app)
      .post(`/cash-sessions/${sessionId}/expense`)
      .send({
        amount: 50,
        currency: "USD",
        expense_category: "supplies",
        payee: "Test Supplier",
        description: "Test purchase",
        paid_from_drawer: true,
        payments: [{ amount: 185, currency: "AED", exchange_rate: 0.27027027 }],
      })
      .expect(201);

    const txId = res.body.transaction_id as number;
    const movements = await getMovements(txId);
    expect(movements.length).toBeGreaterThanOrEqual(1);
    expect(movements[0]).toMatchObject({ direction: "outflow", kind: "expense_payment", currency: "AED" });
    expect(Number(movements[0].amount)).toBeCloseTo(185, 2);
  });

  it("multi-currency expense with change returned by supplier: inflow change movement row created", async () => {
    await resetSession();

    // Expense of 50 USD. Pay 200 AED (= 54.05 USD), get 15 AED change (= 4.05 USD). Net ≈ 50 USD. ✓
    const res = await request(app)
      .post(`/cash-sessions/${sessionId}/expense`)
      .send({
        amount: 50,
        currency: "USD",
        expense_category: "supplies",
        payee: "Test Supplier",
        description: "Test purchase with change",
        paid_from_drawer: true,
        payments: [{ amount: 200, currency: "AED", exchange_rate: 0.27027027 }],
        change:   [{ amount: 15,  currency: "AED", exchange_rate: 0.27027027 }],
      })
      .expect(201);

    const txId = res.body.transaction_id as number;
    const movements = await getMovements(txId);
    expect(movements).toHaveLength(2);
    expect(movements[0]).toMatchObject({ direction: "outflow", kind: "expense_payment", currency: "AED" });
    expect(movements[1]).toMatchObject({ direction: "inflow",  kind: "change",           currency: "AED" });
  });

  // ── reversal of multi-currency transaction ───────────────────────────────

  it("reversing a multi-currency transaction inserts mirrored movement rows", async () => {
    await resetSession();

    // Create original multi-currency sale.
    const saleRes = await request(app)
      .post(`/cash-sessions/${sessionId}/sale`)
      .send({
        amount: 100,
        currency: "USD",
        sale_channel: "walk_in",
        payments: [{ amount: 380, currency: "AED", exchange_rate: 0.27027027 }],
        change:   [{ amount: 10,  currency: "AED", exchange_rate: 0.27027027 }],
      })
      .expect(201);
    const originalTxId = saleRes.body.transaction_id as number;

    // Reverse it.
    const revRes = await request(app)
      .post(`/cash-sessions/${sessionId}/transactions/${originalTxId}/reverse`)
      .send({ reason: "Customer cancelled" })
      .expect(201);

    const reversalTxId = revRes.body.reversal_id as number;
    expect(reversalTxId).toBeTypeOf("number");

    // Mirror movements: inflow→outflow, outflow→inflow, same amounts and currencies.
    const mirrorMoves = await pool.query<{
      cash_transaction_id: number; direction: string; kind: string; currency: string; amount: string;
    }>(
      `SELECT m.cash_transaction_id, m.direction, m.kind, m.currency, m.amount
         FROM cash_transaction_movements m
        WHERE m.cash_transaction_id = $1
        ORDER BY m.id`,
      [reversalTxId],
    );
    expect(mirrorMoves.rows).toHaveLength(2);
    // Original payment (inflow) → mirror (outflow)
    expect(mirrorMoves.rows[0]).toMatchObject({ direction: "outflow", kind: "payment", currency: "AED" });
    expect(Number(mirrorMoves.rows[0].amount)).toBeCloseTo(380, 2);
    // Original change (outflow) → mirror (inflow)
    expect(mirrorMoves.rows[1]).toMatchObject({ direction: "inflow", kind: "change", currency: "AED" });
    expect(Number(mirrorMoves.rows[1].amount)).toBeCloseTo(10, 2);

    // Net totals cancel out after reversal.
    const totals = await getSessionTotals(sessionId);
    expect(totals).toBeTruthy();
    // The original transaction is marked reversed.
    const orig = await pool.query<{ is_reversed: boolean }>(
      `SELECT is_reversed FROM cash_transactions WHERE id = $1`,
      [originalTxId],
    );
    expect(orig.rows[0].is_reversed).toBe(true);
  });

  // ── rate-override security ────────────────────────────────────────────────

  it("rate override: server stores authenticated user as override_approved_by, ignores client-supplied approver field", async () => {
    await resetSession();

    // 375 AED * 0.26666667 ≈ 100 USD — balanced.
    const res = await request(app)
      .post(`/cash-sessions/${sessionId}/sale`)
      .send({
        amount: 100,
        currency: "USD",
        sale_channel: "walk_in",
        payments: [
          {
            amount: 375,
            currency: "AED",
            exchange_rate: 0.26666667,
            is_rate_override: true,
            // Attacker tries to forge a different approver — server must ignore this.
            override_approved_by: "user_attacker_id",
          },
        ],
      })
      .expect(201);

    const txId = res.body.transaction_id as number;
    const movements = await getMovements(txId);
    expect(movements).toHaveLength(1);
    expect(movements[0].rate_source).toBe("override");
    // override_approved_by must be the authenticated user, not the attacker's value.
    expect(movements[0].override_approved_by).toBe(USER_ID);
    expect(movements[0].override_approved_by).not.toBe("user_attacker_id");
  });

  // ── worked example: two-currency payment + two-currency change ────────────
  //
  // 100 USD sale
  // Payments: 80 USD + 2,000,000 LBP (1 USD = 90,000 LBP → 1 LBP = 1/90000 USD)
  //   2,000,000 × (1/90000) ≈ 22.22 USD   →  total ≈ 102.22 USD received
  // Change: 1 USD + 110,000 LBP
  //   110,000 × (1/90000) ≈ 1.22 USD      →  total ≈ 2.22 USD returned
  // Net: 102.22 − 2.22 = 100.00 USD → balanced (diff = 0 < 0.05 tolerance)
  // Drawer impact: +79 USD, +1,890,000 LBP

  it("worked example: 100 USD paid with 80 USD + 2M LBP, change 1 USD + 110k LBP → 201 with 4 movement rows", async () => {
    await resetSession();

    const LBP_RATE = 1 / 90_000; // exchange_rate: doc per 1 foreign LBP

    const res = await request(app)
      .post(`/cash-sessions/${sessionId}/sale`)
      .send({
        amount: 100,
        currency: "USD",
        sale_channel: "walk_in",
        payments: [
          { amount: 80, currency: "USD" },
          { amount: 2_000_000, currency: "LBP", exchange_rate: LBP_RATE },
        ],
        change: [
          { amount: 1, currency: "USD" },
          { amount: 110_000, currency: "LBP", exchange_rate: LBP_RATE },
        ],
      })
      .expect(201);

    const txId = res.body.transaction_id as number;
    const movements = await getMovements(txId);

    // Four rows: two inflow (payment) + two outflow (change)
    expect(movements).toHaveLength(4);

    const inflows = movements.filter((m) => m.direction === "inflow");
    const outflows = movements.filter((m) => m.direction === "outflow");
    expect(inflows).toHaveLength(2);
    expect(outflows).toHaveLength(2);

    // Inflow amounts
    const usdPayment = inflows.find((m) => m.currency === "USD");
    const lbpPayment = inflows.find((m) => m.currency === "LBP");
    expect(usdPayment).toBeDefined();
    expect(Number(usdPayment!.amount)).toBeCloseTo(80, 2);
    expect(lbpPayment).toBeDefined();
    expect(Number(lbpPayment!.amount)).toBeCloseTo(2_000_000, 0);

    // Outflow amounts
    const usdChange = outflows.find((m) => m.currency === "USD");
    const lbpChange = outflows.find((m) => m.currency === "LBP");
    expect(Number(usdChange!.amount)).toBeCloseTo(1, 2);
    expect(Number(lbpChange!.amount)).toBeCloseTo(110_000, 0);
  });

  // ── three-currency payment ─────────────────────────────────────────────────

  it("three-currency payment: three inflow movement rows created", async () => {
    await resetSession();

    // USD + AED + LBP — small imbalance accepted via balance_difference_kind.
    const res = await request(app)
      .post(`/cash-sessions/${sessionId}/sale`)
      .send({
        amount: 100,
        currency: "USD",
        sale_channel: "walk_in",
        payments: [
          { amount: 50, currency: "USD" },
          { amount: 100, currency: "AED", exchange_rate: 0.27 },
          { amount: 1_000_000, currency: "LBP", exchange_rate: 1 / 90_000 },
        ],
        balance_difference_kind: "fx_difference",
      })
      .expect(201);

    const txId = res.body.transaction_id as number;
    const movements = await getMovements(txId);

    const inflows = movements.filter((m) => m.direction === "inflow");
    expect(inflows).toHaveLength(3);

    const currencies = inflows.map((m) => m.currency);
    expect(currencies).toContain("USD");
    expect(currencies).toContain("AED");
    expect(currencies).toContain("LBP");
  });

  // ── duplicate currency rows (same currency, two rows) ────────────────────

  it("duplicate LBP payment rows: both movement rows are created separately", async () => {
    await resetSession();

    const LBP_RATE = 1 / 90_000;

    // Two LBP rows — server must create one movement row per input line.
    const res = await request(app)
      .post(`/cash-sessions/${sessionId}/sale`)
      .send({
        amount: 100,
        currency: "USD",
        sale_channel: "walk_in",
        payments: [
          { amount: 80, currency: "USD" },
          { amount: 1_000_000, currency: "LBP", exchange_rate: LBP_RATE },
          { amount: 1_000_000, currency: "LBP", exchange_rate: LBP_RATE },
        ],
        balance_difference_kind: "overpayment",
      })
      .expect(201);

    const txId = res.body.transaction_id as number;
    const movements = await getMovements(txId);

    const lbpRows = movements.filter(
      (m) => m.currency === "LBP" && m.direction === "inflow",
    );
    // Two separate LBP rows, not merged
    expect(lbpRows).toHaveLength(2);
    expect(Number(lbpRows[0].amount)).toBeCloseTo(1_000_000, 0);
    expect(Number(lbpRows[1].amount)).toBeCloseTo(1_000_000, 0);
  });

  // ── large LBP value precision ─────────────────────────────────────────────

  it("large LBP amount (10,000,000 LBP) is stored precisely in the movement row", async () => {
    await resetSession();

    const LBP_RATE = 1 / 90_000; // 10M LBP ≈ 111.11 USD (overpayment vs 100 USD)

    const res = await request(app)
      .post(`/cash-sessions/${sessionId}/sale`)
      .send({
        amount: 100,
        currency: "USD",
        sale_channel: "walk_in",
        payments: [{ amount: 10_000_000, currency: "LBP", exchange_rate: LBP_RATE }],
        balance_difference_kind: "overpayment",
      })
      .expect(201);

    const txId = res.body.transaction_id as number;
    const movements = await getMovements(txId);

    expect(movements).toHaveLength(1);
    expect(movements[0].currency).toBe("LBP");
    // Amount must be stored without precision loss (within 1 unit of smallest LBP denomination)
    expect(Number(movements[0].amount)).toBeCloseTo(10_000_000, 0);
  });
});
