/**
 * Integration test: cancelling a workshop sale and its (lack of) effect on the
 * location's open cash session.
 *
 * Background (Task #2476): `POST /workshop-sales/:id/payments` auto-links a cash
 * payment to the location's currently-open cash session as a `sale`/`in`
 * cash_transaction (raising expected_cash). The per-payment refund path
 * (`DELETE /workshop-sales/:id/payments/:paymentId`) mirrors that by recording a
 * reversing `refund`/`out` cash_transaction so expected_cash drops back down
 * (covered by workshopSales.cashRefund.integration.test.ts).
 *
 * The separate cancel flow (`POST /workshop-sales/:id/cancel`) is a related but
 * previously untested path. This suite pins down what cancelling a paid cash
 * sale does to the linked cash session.
 *
 * FINDING (documented gap): cancelling a workshop sale does NOT reverse any
 * recorded cash payments out of the open shift. The cancel handler only flips
 * `status` to `cancelled` and writes an activity log — it never calls
 * `recordCashTransaction`. So the original `sale`/`in` transaction stays linked
 * and expected_cash remains elevated after cancellation. These tests assert that
 * current behavior so the gap is explicit and any future change (reversing cash
 * on cancel) will deliberately flip these assertions.
 *
 * These tests call the real route handlers via HTTP (supertest) against a real
 * PostgreSQL database. Auth / workspace / logger / object storage middleware are
 * stubbed (same pattern as workshopSales.cashRefund.integration.test.ts) so the
 * test does not need real Clerk credentials. The database is real.
 *
 * The suite skips automatically when DATABASE_URL is not set.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import pg from "pg";
import type { WorkspaceRequest } from "../lib/workspace";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;

const OWNER_ID = "__test_workshop_cash_cancel__";
const USER_ID = "__test_workshop_cash_cancel_user__";

// ─────────────────────────────────────────────────────────────────────────────
// Mocks — auth / workspace / logger / object storage only.
// db is NOT mocked; the real pool is used throughout (cashDesk + the route share
// the same `../lib/db` singleton against DATABASE_URL).
// ─────────────────────────────────────────────────────────────────────────────

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
    wreq.userEmail = "workshop-cash-cancel@example.com";
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

// ─────────────────────────────────────────────────────────────────────────────
// Imports — MUST come after vi.mock declarations (hoisting boundary)
// ─────────────────────────────────────────────────────────────────────────────

import workshopSalesRouter from "./workshopSales";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  // Provide req.log used by the route handlers.
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
  app.use(workshopSalesRouter);
  return app;
}

describe.skipIf(!DATABASE_URL)(
  "POST /workshop-sales/:id/cancel — cash session effect (integration)",
  () => {
    let pool: InstanceType<typeof Pool>;
    let app: express.Express;
    let locationId: number;
    let drawerId: number;

    async function cleanup(): Promise<void> {
      // cash_transactions reference the session/drawer; delete them first.
      await pool.query(`DELETE FROM cash_transactions WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM cash_session_activity_logs WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM cash_sessions WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM workshop_sale_payments WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM workshop_sale_activity_logs WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM workshop_sales WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM cash_drawers WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM locations WHERE workspace_owner_id = $1`, [OWNER_ID]);
    }

    async function createSale(): Promise<number> {
      const r = await pool.query<{ id: number }>(
        `INSERT INTO workshop_sales
           (workspace_owner_id, order_number, location_id, currency)
         VALUES ($1, $2, $3, 'AED')
         RETURNING id`,
        [OWNER_ID, `WS-CANCEL-${Date.now()}-${Math.floor(Math.random() * 100000)}`, locationId],
      );
      return r.rows[0].id;
    }

    async function openSession(openingCash: number): Promise<number> {
      const r = await pool.query<{ id: number }>(
        `INSERT INTO cash_sessions
           (workspace_owner_id, session_number, drawer_id, location_id, currency,
            status, opening_cash, expected_cash)
         VALUES ($1, $2, $3, $4, 'AED', 'open', $5, $5)
         RETURNING id`,
        [OWNER_ID, `CS-CANCEL-${Date.now()}`, drawerId, locationId, openingCash.toFixed(2)],
      );
      return r.rows[0].id;
    }

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL });
      app = makeApp();
      await cleanup();

      const locRes = await pool.query<{ id: number }>(
        `INSERT INTO locations (workspace_owner_id, name) VALUES ($1, $2) RETURNING id`,
        [OWNER_ID, "Cash Cancel Test Location"],
      );
      locationId = locRes.rows[0].id;

      const drawerRes = await pool.query<{ id: number }>(
        `INSERT INTO cash_drawers (workspace_owner_id, name, code, location_id, currency)
         VALUES ($1, 'Test Drawer', 'TDRWC', $2, 'AED')
         RETURNING id`,
        [OWNER_ID, locationId],
      );
      drawerId = drawerRes.rows[0].id;
    });

    afterAll(async () => {
      if (!pool) return;
      await cleanup();
      await pool.end();
    });

    beforeEach(async () => {
      // Reset per-test mutable data (sessions, transactions, sales, payments)
      // while keeping the shared location + drawer.
      await pool.query(`DELETE FROM cash_transactions WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM cash_session_activity_logs WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM cash_sessions WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM workshop_sale_payments WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM workshop_sale_activity_logs WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM workshop_sales WHERE workspace_owner_id = $1`, [OWNER_ID]);
    });

    it("cancelling a paid cash sale does NOT reverse cash out of the open shift (documented gap)", async () => {
      const sessionId = await openSession(100);
      const saleId = await createSale();

      // Record a cash payment of 40.00 — raises expected_cash from 100 → 140
      // and links a `sale`/`in` transaction to the open session.
      const payRes = await request(app)
        .post(`/workshop-sales/${saleId}/payments`)
        .send({ amount: 40, method: "cash", currency: "AED" });
      expect(payRes.status).toBe(201);
      const paymentId = payRes.body.id as number;
      expect(Number.isInteger(paymentId)).toBe(true);

      const afterPay = await pool.query<{ expected_cash: string }>(
        `SELECT expected_cash FROM cash_sessions WHERE id = $1`,
        [sessionId],
      );
      expect(Number(afterPay.rows[0].expected_cash)).toBeCloseTo(140, 2);

      const saleTx = await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM cash_transactions
          WHERE cash_session_id = $1 AND type = 'sale' AND direction = 'in'
            AND reference_type = 'workshop_sale_payment' AND reference_id = $2`,
        [sessionId, String(paymentId)],
      );
      expect(parseInt(saleTx.rows[0].count, 10)).toBe(1);

      // Cancel the sale.
      const cancelRes = await request(app)
        .post(`/workshop-sales/${saleId}/cancel`)
        .send({ reason: "customer changed their mind" });
      expect(cancelRes.status).toBe(200);
      expect(cancelRes.body.sale.status).toBe("cancelled");

      // GAP: no reversing `refund`/`out` transaction is recorded on cancel.
      const refundTx = await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM cash_transactions
          WHERE cash_session_id = $1 AND type = 'refund' AND direction = 'out'`,
        [sessionId],
      );
      expect(parseInt(refundTx.rows[0].count, 10)).toBe(0);

      // The original `sale`/`in` transaction is still linked to the session.
      const saleTxAfter = await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM cash_transactions
          WHERE cash_session_id = $1 AND type = 'sale' AND direction = 'in'`,
        [sessionId],
      );
      expect(parseInt(saleTxAfter.rows[0].count, 10)).toBe(1);

      // expected_cash stays elevated at 140 — cancellation did not give the cash
      // back to the drawer. (If cancel is ever changed to reverse cash, this
      // assertion should flip to 100.)
      const afterCancel = await pool.query<{ expected_cash: string }>(
        `SELECT expected_cash FROM cash_sessions WHERE id = $1`,
        [sessionId],
      );
      expect(Number(afterCancel.rows[0].expected_cash)).toBeCloseTo(140, 2);
    });

    it("the per-payment refund — not cancel — is what reverses cash from the shift", async () => {
      // This documents the supported path for taking cash back out of the shift:
      // refunding the individual cash payment, not cancelling the sale.
      const sessionId = await openSession(100);
      const saleId = await createSale();

      const payRes = await request(app)
        .post(`/workshop-sales/${saleId}/payments`)
        .send({ amount: 40, method: "cash", currency: "AED" });
      expect(payRes.status).toBe(201);
      const paymentId = payRes.body.id as number;

      expect(
        Number(
          (
            await pool.query<{ expected_cash: string }>(
              `SELECT expected_cash FROM cash_sessions WHERE id = $1`,
              [sessionId],
            )
          ).rows[0].expected_cash,
        ),
      ).toBeCloseTo(140, 2);

      // Refund the payment (the supported reversal path).
      const refundRes = await request(app).delete(
        `/workshop-sales/${saleId}/payments/${paymentId}`,
      );
      expect(refundRes.status).toBe(200);
      expect(refundRes.body.success).toBe(true);

      const refundTx = await pool.query<{ count: string; amount: string }>(
        `SELECT COUNT(*) AS count, COALESCE(MAX(amount), '0') AS amount
           FROM cash_transactions
          WHERE cash_session_id = $1 AND type = 'refund' AND direction = 'out'
            AND reference_type = 'workshop_sale_payment_refund'
            AND reference_id = $2`,
        [sessionId, String(paymentId)],
      );
      expect(parseInt(refundTx.rows[0].count, 10)).toBe(1);
      expect(Number(refundTx.rows[0].amount)).toBeCloseTo(40, 2);

      // expected_cash drops back to the opening amount once the payment is
      // refunded.
      const afterRefund = await pool.query<{ expected_cash: string }>(
        `SELECT expected_cash FROM cash_sessions WHERE id = $1`,
        [sessionId],
      );
      expect(Number(afterRefund.rows[0].expected_cash)).toBeCloseTo(100, 2);
    });
  },
);
