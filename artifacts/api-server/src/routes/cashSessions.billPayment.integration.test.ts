/**
 * Integration tests: Bill-payment endpoints for cash sessions.
 *
 * Covers:
 *   GET  /api/cash-sessions/:id/payable-bills — search open/partial invoices
 *   POST /api/cash-sessions/:id/bill-payment  — full, partial, multi-currency,
 *                                               stale-balance guard, reversal
 *
 * Uses a real PostgreSQL database (skipped when DATABASE_URL is absent).
 * Auth, workspace, logger, Clerk, and object-storage middleware are stubbed —
 * same pattern as cashSessions.multicurrency.integration.test.ts.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import pg from "pg";
import type { WorkspaceRequest } from "../lib/workspace";
const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;

const OWNER_ID  = "__test_bill_payment__";
const USER_ID   = "user_bp_test";

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  authed: (_req: express.Request) => ({ userId: USER_ID }),
}));

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId     = OWNER_ID;
    wreq.workspaceRole        = "owner";
    wreq.workspaceActualRole  = "owner";
    wreq.userId               = USER_ID;
    wreq.userEmail            = "bp@example.com";
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

vi.mock("../lib/logger", () => ({
  logger: {
    info:  vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

vi.mock("../lib/objectStorage", () => ({
  objectStorageClient:  { bucket: vi.fn() },
  objectStorageService: { getPrivateObjectDir: vi.fn().mockReturnValue("/objects/private") },
}));

vi.mock("@clerk/express", () => ({
  clerkClient: { users: { getUserList: vi.fn().mockResolvedValue({ data: [] }) } },
}));

import cashSessionsRouter from "./cashSessions";

/** Ensure the new tables/columns introduced by this task exist in the test DB. */
async function ensureSchema(pool: InstanceType<typeof Pool>): Promise<void> {
  // New table added by this task.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS supplier_invoice_payments (
      id                    serial        PRIMARY KEY,
      workspace_owner_id    text          NOT NULL,
      supplier_invoice_id   integer       NOT NULL REFERENCES supplier_invoices(id) ON DELETE CASCADE,
      cash_transaction_id   integer       REFERENCES cash_transactions(id) ON DELETE SET NULL,
      amount                numeric(14,4) NOT NULL,
      currency              text          NOT NULL,
      exchange_rate         numeric(14,6),
      paid_at               timestamptz   NOT NULL DEFAULT now(),
      is_reversed           boolean       NOT NULL DEFAULT false,
      created_at            timestamptz   NOT NULL DEFAULT now()
    )
  `);
  // New column added by this task (idempotent).
  await pool.query(
    `ALTER TABLE supplier_invoices ADD COLUMN IF NOT EXISTS outstanding_balance numeric(14,4)`,
  );
}

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: express.Request & { log?: unknown }, _res, next) => {
    req.log = {
      info:  vi.fn(),
      warn:  vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn().mockReturnThis(),
    } as unknown as express.Request["log"];
    next();
  });
  app.use(cashSessionsRouter);
  return app;
}

describe.skipIf(!DATABASE_URL)("Cash Desk bill-payment — route integration", () => {
  let pool: InstanceType<typeof Pool>;
  let app: express.Express;
  let drawerId:  number;
  let sessionId: number;
  let supplierId: number;

  // ── helpers ────────────────────────────────────────────────────────────────

  async function cleanup() {
    await pool.query(`DELETE FROM supplier_invoice_payments WHERE workspace_owner_id = $1`, [OWNER_ID]);
    await pool.query(`DELETE FROM supplier_invoices WHERE workspace_owner_id = $1`, [OWNER_ID]);
    await pool.query(`DELETE FROM suppliers WHERE workspace_owner_id = $1`, [OWNER_ID]);
    await pool.query(`DELETE FROM cash_transaction_movements WHERE workspace_owner_id = $1`, [OWNER_ID]);
    await pool.query(`DELETE FROM cash_transactions WHERE workspace_owner_id = $1`, [OWNER_ID]);
    await pool.query(`DELETE FROM cash_session_activity_logs WHERE workspace_owner_id = $1`, [OWNER_ID]);
    await pool.query(`DELETE FROM cash_sessions WHERE workspace_owner_id = $1`, [OWNER_ID]);
    await pool.query(`DELETE FROM cash_drawers WHERE workspace_owner_id = $1`, [OWNER_ID]);
    await pool.query(`DELETE FROM workspace_settings WHERE workspace_owner_id = $1`, [OWNER_ID]);
    await pool.query(`DELETE FROM workspace_members WHERE workspace_owner_id = $1`, [OWNER_ID]);
  }

  async function createInvoice(opts: {
    amount: number;
    grandTotal?: number | null;
    currency?: string;
    status?: string;
    paymentStatus?: string;
    invoiceNumber?: string;
  }): Promise<number> {
    const currency = opts.currency ?? "AED";
    const status = opts.status ?? "issued";
    const paymentStatus = opts.paymentStatus ?? "unpaid";
    const grandTotal = opts.grandTotal !== undefined ? opts.grandTotal : null;
    const outstanding = grandTotal ?? opts.amount;

    const r = await pool.query<{ id: number }>(
      `INSERT INTO supplier_invoices
         (workspace_owner_id, supplier_id, amount, currency, status, payment_status,
          outstanding_balance, grand_total, invoice_number, issued_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       RETURNING id`,
      [
        OWNER_ID,
        supplierId,
        opts.amount.toFixed(4),
        currency,
        status,
        paymentStatus,
        outstanding.toFixed(4),
        grandTotal !== null ? grandTotal?.toFixed(4) : null,
        opts.invoiceNumber ?? null,
      ],
    );
    return r.rows[0].id;
  }

  async function getInvoice(id: number) {
    const r = await pool.query<{
      payment_status: string;
      outstanding_balance: string | null;
      paid_at: string | null;
    }>(
      `SELECT payment_status, outstanding_balance, paid_at FROM supplier_invoices WHERE id = $1`,
      [id],
    );
    return r.rows[0];
  }

  async function resetSession() {
    await pool.query(`DELETE FROM supplier_invoice_payments WHERE workspace_owner_id = $1`, [OWNER_ID]);
    await pool.query(`DELETE FROM cash_transaction_movements WHERE workspace_owner_id = $1`, [OWNER_ID]);
    await pool.query(`DELETE FROM cash_transactions WHERE cash_session_id = $1`, [sessionId]);
    await pool.query(
      `UPDATE cash_sessions
          SET cash_out_total = 0, expected_cash = opening_cash, updated_at = now()
        WHERE id = $1`,
      [sessionId],
    );
    // Reset all test invoices to their initial state
    await pool.query(
      `UPDATE supplier_invoices
          SET payment_status = 'unpaid',
              outstanding_balance = COALESCE(grand_total, amount),
              paid_at = NULL
        WHERE workspace_owner_id = $1`,
      [OWNER_ID],
    );
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    app  = makeApp();
    await ensureSchema(pool);
    await cleanup();

    // Workspace member (required by some middleware)
    await pool.query(
      `INSERT INTO workspace_members (workspace_owner_id, member_email, role, member_user_id)
       VALUES ($1, $1 || '@test.com', 'owner', $2)`,
      [OWNER_ID, USER_ID],
    );

    // Supplier
    const sRow = await pool.query<{ id: number }>(
      `INSERT INTO suppliers (workspace_owner_id, name) VALUES ($1, 'Test Supplier Ltd') RETURNING id`,
      [OWNER_ID],
    );
    supplierId = sRow.rows[0].id;

    // Drawer
    const dRow = await pool.query<{ id: number }>(
      `INSERT INTO cash_drawers (workspace_owner_id, name, code, currency, is_active)
       VALUES ($1, 'Test Drawer', 'TD', 'AED', true) RETURNING id`,
      [OWNER_ID],
    );
    drawerId = dRow.rows[0].id;

    // Open session
    const sRow2 = await pool.query<{ id: number }>(
      `INSERT INTO cash_sessions
         (workspace_owner_id, session_number, drawer_id, currency, status, opening_cash, expected_cash,
          cash_in_total, cash_out_total, adjustments_total, transfers_in_total, transfers_out_total)
       VALUES ($1, 'CS-TEST-0001', $2, 'AED', 'open', 1000, 1000, 0, 0, 0, 0, 0) RETURNING id`,
      [OWNER_ID, drawerId],
    );
    sessionId = sRow2.rows[0].id;
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  // ── GET /payable-bills ─────────────────────────────────────────────────────

  describe("GET /cash-sessions/:id/payable-bills", () => {
    let invoiceA: number;
    let invoiceB: number;
    let invoicePaid: number;
    let invoiceCancelled: number;
    let invoicePartial: number;

    beforeAll(async () => {
      // Clear invoices from other test suites
      await pool.query(`DELETE FROM supplier_invoices WHERE workspace_owner_id = $1`, [OWNER_ID]);

      invoiceA        = await createInvoice({ amount: 500, invoiceNumber: "INV-001" });
      invoiceB        = await createInvoice({ amount: 200, invoiceNumber: "INV-002" });
      invoicePaid     = await createInvoice({ amount: 100, paymentStatus: "paid", invoiceNumber: "INV-003" });
      invoiceCancelled = await createInvoice({ amount: 300, status: "cancelled", invoiceNumber: "INV-004" });
      invoicePartial  = await createInvoice({ amount: 400, paymentStatus: "partially_paid", invoiceNumber: "INV-005" });
    });

    it("returns unpaid and partially_paid bills, excludes paid and cancelled", async () => {
      const res = await request(app).get(`/cash-sessions/${sessionId}/payable-bills`);
      expect(res.status).toBe(200);
      const ids = (res.body.bills as Array<{ id: number }>).map((b) => b.id);
      expect(ids).toContain(invoiceA);
      expect(ids).toContain(invoiceB);
      expect(ids).toContain(invoicePartial);
      expect(ids).not.toContain(invoicePaid);
      expect(ids).not.toContain(invoiceCancelled);
    });

    it("includes expected fields in each bill", async () => {
      const res = await request(app).get(`/cash-sessions/${sessionId}/payable-bills`);
      expect(res.status).toBe(200);
      const bill = (res.body.bills as Array<Record<string, unknown>>).find((b) => b.id === invoiceA);
      expect(bill).toBeDefined();
      expect(bill).toMatchObject({
        id: invoiceA,
        invoice_number: "INV-001",
        supplier_id: supplierId,
        supplier_name: "Test Supplier Ltd",
        currency: "AED",
      });
      expect(bill!.outstanding_balance).toBeDefined();
    });

    it("filters by ?q= supplier name", async () => {
      const res = await request(app).get(`/cash-sessions/${sessionId}/payable-bills?q=Test+Supplier`);
      expect(res.status).toBe(200);
      expect((res.body.bills as unknown[]).length).toBeGreaterThan(0);
    });

    it("filters by ?q= invoice number", async () => {
      const res = await request(app).get(`/cash-sessions/${sessionId}/payable-bills?q=INV-001`);
      expect(res.status).toBe(200);
      const ids = (res.body.bills as Array<{ id: number }>).map((b) => b.id);
      expect(ids).toContain(invoiceA);
    });

    it("returns 404 for unknown session", async () => {
      const res = await request(app).get(`/cash-sessions/999999999/payable-bills`);
      expect(res.status).toBe(404);
    });
  });

  // ── POST /bill-payment ─────────────────────────────────────────────────────

  describe("POST /cash-sessions/:id/bill-payment — full payment", () => {
    let invoiceId: number;

    beforeEach(async () => {
      await resetSession();
      invoiceId = await createInvoice({ amount: 300, grandTotal: 300 });
    });

    it("marks the invoice as paid and sets outstanding_balance to 0", async () => {
      const res = await request(app)
        .post(`/cash-sessions/${sessionId}/bill-payment`)
        .send({
          supplier_invoice_id: invoiceId,
          payment_amount: 300,
          currency: "AED",
        });

      expect(res.status).toBe(201);
      expect(res.body.transaction_id).toBeTypeOf("number");
      expect(res.body.session).toBeDefined();

      const inv = await getInvoice(invoiceId);
      expect(inv.payment_status).toBe("paid");
      expect(Number(inv.outstanding_balance)).toBe(0);
      expect(inv.paid_at).not.toBeNull();
    });

    it("inserts a cash_transactions row with type=bill_payment direction=out", async () => {
      const res = await request(app)
        .post(`/cash-sessions/${sessionId}/bill-payment`)
        .send({ supplier_invoice_id: invoiceId, payment_amount: 300, currency: "AED" });

      expect(res.status).toBe(201);
      const txId = res.body.transaction_id as number;
      const tx = await pool.query<{ type: string; direction: string; amount: string }>(
        `SELECT type, direction, amount FROM cash_transactions WHERE id = $1`,
        [txId],
      );
      expect(tx.rows[0]).toMatchObject({ type: "bill_payment", direction: "out" });
      expect(Number(tx.rows[0].amount)).toBeCloseTo(300, 1);
    });

    it("inserts a supplier_invoice_payments row", async () => {
      const res = await request(app)
        .post(`/cash-sessions/${sessionId}/bill-payment`)
        .send({ supplier_invoice_id: invoiceId, payment_amount: 300, currency: "AED" });
      expect(res.status).toBe(201);
      const txId = res.body.transaction_id as number;
      const sip = await pool.query(
        `SELECT * FROM supplier_invoice_payments WHERE cash_transaction_id = $1`,
        [txId],
      );
      expect(sip.rows).toHaveLength(1);
      expect(Number(sip.rows[0].amount)).toBeCloseTo(300, 1);
      expect(sip.rows[0].is_reversed).toBe(false);
    });

    it("updates session totals (cash_out increases)", async () => {
      await request(app)
        .post(`/cash-sessions/${sessionId}/bill-payment`)
        .send({ supplier_invoice_id: invoiceId, payment_amount: 300, currency: "AED" });

      const sess = await pool.query<{ cash_out_total: string }>(
        `SELECT cash_out_total FROM cash_sessions WHERE id = $1`,
        [sessionId],
      );
      expect(Number(sess.rows[0].cash_out_total)).toBeCloseTo(300, 1);
    });
  });

  describe("POST /cash-sessions/:id/bill-payment — partial payment", () => {
    let invoiceId: number;

    beforeEach(async () => {
      await resetSession();
      invoiceId = await createInvoice({ amount: 1000, grandTotal: 1000 });
    });

    it("leaves invoice as partially_paid with correct outstanding_balance", async () => {
      const res = await request(app)
        .post(`/cash-sessions/${sessionId}/bill-payment`)
        .send({ supplier_invoice_id: invoiceId, payment_amount: 400, currency: "AED" });

      expect(res.status).toBe(201);
      const inv = await getInvoice(invoiceId);
      expect(inv.payment_status).toBe("partially_paid");
      expect(Number(inv.outstanding_balance)).toBeCloseTo(600, 1);
      expect(inv.paid_at).toBeNull();
    });

    it("second partial payment further reduces the balance", async () => {
      await request(app)
        .post(`/cash-sessions/${sessionId}/bill-payment`)
        .send({ supplier_invoice_id: invoiceId, payment_amount: 400, currency: "AED" });

      // Create second session to avoid session totals conflict — use a second transaction
      const res2 = await request(app)
        .post(`/cash-sessions/${sessionId}/bill-payment`)
        .send({ supplier_invoice_id: invoiceId, payment_amount: 400, currency: "AED" });

      expect(res2.status).toBe(201);
      const inv = await getInvoice(invoiceId);
      expect(inv.payment_status).toBe("partially_paid");
      expect(Number(inv.outstanding_balance)).toBeCloseTo(200, 1);
    });
  });

  describe("POST /cash-sessions/:id/bill-payment — validation", () => {
    let invoiceId: number;

    beforeEach(async () => {
      await resetSession();
      invoiceId = await createInvoice({ amount: 500 });
    });

    it("rejects payment_amount > outstanding_balance", async () => {
      const res = await request(app)
        .post(`/cash-sessions/${sessionId}/bill-payment`)
        .send({ supplier_invoice_id: invoiceId, payment_amount: 9999, currency: "AED" });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/outstanding/i);
    });

    it("rejects payment_amount <= 0", async () => {
      const res = await request(app)
        .post(`/cash-sessions/${sessionId}/bill-payment`)
        .send({ supplier_invoice_id: invoiceId, payment_amount: 0, currency: "AED" });
      expect(res.status).toBe(400);
    });

    it("rejects unknown invoice", async () => {
      const res = await request(app)
        .post(`/cash-sessions/${sessionId}/bill-payment`)
        .send({ supplier_invoice_id: 999999999, payment_amount: 100, currency: "AED" });
      expect(res.status).toBe(404);
    });

    it("rejects already-paid invoice (stale-balance guard)", async () => {
      // Manually mark invoice as paid
      await pool.query(
        `UPDATE supplier_invoices SET payment_status = 'paid', outstanding_balance = 0 WHERE id = $1`,
        [invoiceId],
      );
      const res = await request(app)
        .post(`/cash-sessions/${sessionId}/bill-payment`)
        .send({ supplier_invoice_id: invoiceId, payment_amount: 100, currency: "AED" });
      expect(res.status).toBe(409);
    });

    it("rejects cancelled invoice", async () => {
      await pool.query(
        `UPDATE supplier_invoices SET status = 'cancelled' WHERE id = $1`,
        [invoiceId],
      );
      const res = await request(app)
        .post(`/cash-sessions/${sessionId}/bill-payment`)
        .send({ supplier_invoice_id: invoiceId, payment_amount: 100, currency: "AED" });
      expect(res.status).toBe(409);
    });

    it("rejects payment on a closed session", async () => {
      await pool.query(
        `UPDATE cash_sessions SET status = 'pending_review' WHERE id = $1`,
        [sessionId],
      );
      const res = await request(app)
        .post(`/cash-sessions/${sessionId}/bill-payment`)
        .send({ supplier_invoice_id: invoiceId, payment_amount: 100, currency: "AED" });
      expect(res.status).toBe(409);
      // Restore session
      await pool.query(`UPDATE cash_sessions SET status = 'open' WHERE id = $1`, [sessionId]);
    });
  });

  describe("POST /cash-sessions/:id/bill-payment — multi-currency settlement", () => {
    let invoiceId: number;

    beforeEach(async () => {
      await resetSession();
      // Use a dual-currency drawer for this suite
      await pool.query(
        `UPDATE cash_drawers SET secondary_currency = 'USD' WHERE id = $1`,
        [drawerId],
      );
      await pool.query(
        `UPDATE cash_sessions SET secondary_currency = 'USD', opening_cash_secondary = 500,
                                   cash_in_total_secondary = 0, cash_out_total_secondary = 0,
                                   adjustments_total_secondary = 0, expected_cash_secondary = 500
         WHERE id = $1`,
        [sessionId],
      );
      invoiceId = await createInvoice({ amount: 500, currency: "AED" });
    });

    afterEach(async () => {
      await pool.query(
        `UPDATE cash_drawers SET secondary_currency = NULL WHERE id = $1`,
        [drawerId],
      );
      await pool.query(
        `UPDATE cash_sessions SET secondary_currency = NULL, opening_cash_secondary = NULL,
                                   cash_in_total_secondary = NULL, cash_out_total_secondary = NULL,
                                   adjustments_total_secondary = NULL, expected_cash_secondary = NULL
         WHERE id = $1`,
        [sessionId],
      );
    });

    it("records multi-currency payment with movement rows", async () => {
      const res = await request(app)
        .post(`/cash-sessions/${sessionId}/bill-payment`)
        .send({
          supplier_invoice_id: invoiceId,
          payment_amount: 500,
          currency: "AED",
          transaction_currency: "AED",
          payments: [{ amount: 136.17, currency: "USD", exchange_rate: 3.6725 }],
          change: [],
          balance_difference_kind: "rounding",
        });

      expect(res.status).toBe(201);
      const txId = res.body.transaction_id as number;
      const movements = await pool.query(
        `SELECT direction, kind, currency, amount FROM cash_transaction_movements WHERE cash_transaction_id = $1`,
        [txId],
      );
      expect(movements.rows).toHaveLength(1);
      expect(movements.rows[0]).toMatchObject({ direction: "outflow", kind: "expense_payment", currency: "USD" });

      const inv = await getInvoice(invoiceId);
      expect(inv.payment_status).toBe("paid");
    });
  });

  describe("POST /cash-sessions/:id/transactions/:txId/reverse — bill_payment reversal", () => {
    let invoiceId: number;

    beforeEach(async () => {
      await resetSession();
      invoiceId = await createInvoice({ amount: 600, grandTotal: 600 });
    });

    it("reversal restores outstanding_balance and reverts payment_status to unpaid", async () => {
      // Record a full payment
      const payRes = await request(app)
        .post(`/cash-sessions/${sessionId}/bill-payment`)
        .send({ supplier_invoice_id: invoiceId, payment_amount: 600, currency: "AED" });
      expect(payRes.status).toBe(201);
      const txId = payRes.body.transaction_id as number;

      // Verify it's paid
      expect((await getInvoice(invoiceId)).payment_status).toBe("paid");

      // Now reverse
      const revRes = await request(app)
        .post(`/cash-sessions/${sessionId}/transactions/${txId}/reverse`)
        .send({ reason: "Incorrect payment" });
      expect(revRes.status).toBe(201);

      // Invoice should be back to unpaid with full balance
      const inv = await getInvoice(invoiceId);
      expect(inv.payment_status).toBe("unpaid");
      expect(Number(inv.outstanding_balance)).toBeCloseTo(600, 1);
      expect(inv.paid_at).toBeNull();

      // supplier_invoice_payments row should be reversed
      const sipRow = await pool.query(
        `SELECT is_reversed FROM supplier_invoice_payments WHERE cash_transaction_id = $1`,
        [txId],
      );
      expect(sipRow.rows[0]?.is_reversed).toBe(true);
    });

    it("reversal of partial payment reverts to partially_paid if other payments remain", async () => {
      // Two partial payments
      const pay1 = await request(app)
        .post(`/cash-sessions/${sessionId}/bill-payment`)
        .send({ supplier_invoice_id: invoiceId, payment_amount: 200, currency: "AED" });
      const pay2 = await request(app)
        .post(`/cash-sessions/${sessionId}/bill-payment`)
        .send({ supplier_invoice_id: invoiceId, payment_amount: 200, currency: "AED" });
      expect(pay1.status).toBe(201);
      expect(pay2.status).toBe(201);

      // Reverse the first payment
      const revRes = await request(app)
        .post(`/cash-sessions/${sessionId}/transactions/${pay1.body.transaction_id}/reverse`)
        .send({ reason: "Entered twice" });
      expect(revRes.status).toBe(201);

      // Should be partially_paid with 400 outstanding (600 - 200 remaining)
      const inv = await getInvoice(invoiceId);
      expect(inv.payment_status).toBe("partially_paid");
      expect(Number(inv.outstanding_balance)).toBeCloseTo(400, 1);
    });
  });

  describe("POST /cash-sessions/:id/expense — paid_from_drawer backward compat", () => {
    it("records expense without paid_from_drawer field (treats absence as true)", async () => {
      await resetSession();
      const res = await request(app)
        .post(`/cash-sessions/${sessionId}/expense`)
        .send({
          amount: 50,
          currency: "AED",
          expense_category: "office_supplies",
          payee: "Stationery Store",
          description: "Pens and paper",
          // paid_from_drawer intentionally omitted
        });
      // Should succeed (201) now that absence is treated as true
      expect(res.status).toBe(201);
    });

    it("still rejects when paid_from_drawer is explicitly false", async () => {
      await resetSession();
      const res = await request(app)
        .post(`/cash-sessions/${sessionId}/expense`)
        .send({
          amount: 50,
          currency: "AED",
          expense_category: "office_supplies",
          payee: "Stationery Store",
          description: "Pens and paper",
          paid_from_drawer: false,
        });
      expect(res.status).toBe(400);
    });
  });
});
