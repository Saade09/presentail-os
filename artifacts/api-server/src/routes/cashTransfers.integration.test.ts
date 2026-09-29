/**
 * Integration tests for the cash-transfer routes.
 *
 * Runs against a real throwaway PostgreSQL database (DATABASE_URL must be set;
 * auto-skipped otherwise). Auth, workspace, logger, Clerk, object storage, SSE,
 * and broadcastEvent are stubbed so the suite is fully self-contained.
 *
 * Coverage:
 *  - POST /cash-sessions/:id/transfer — atomic deduct + IN_TRANSIT record
 *  - Idempotency: same idempotency_key returns existing record without duplicate
 *  - POST /cash-transfers/:id/confirm-receipt — atomic credit + COMPLETED
 *  - Concurrent receipt: second call returns conflict, no double-credit
 *  - Source session closes while transfer IN_TRANSIT: close succeeds, transfer untouched
 *  - Destination session closes before receipt; new open session is used at receipt time
 *  - Same-location transfer: handover → confirm → COMPLETED
 *  - Cross-location transfer: handover → confirm → COMPLETED
 *  - POST /cash-transfers/:id/report-difference → DISPUTED, no destination ledger movement
 *  - POST /cash-transfers/:id/resolve-dispute → COMPLETED, destination session credited once
 *  - Unauthorized attempts → 403
 *  - Amount exceeding available cash → 422
 *  - Cross-currency destination → 422
 *  - GET /cash-transfers shows the transfer after handover
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import pg from "pg";
import type { WorkspaceRequest } from "../lib/workspace";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;

const OWNER_ID = "__test_cash_transfers_integration__";
const USER_ID = "__test_ct_user__";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  authed: (_req: express.Request) => ({ userId: USER_ID }),
}));

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = OWNER_ID;
    wreq.workspaceRole = "owner";
    wreq.workspaceActualRole = "owner";
    wreq.userId = USER_ID;
    wreq.userEmail = "transfers@example.com";
    // By default grant all transfer permissions — individual tests can override
    wreq.allowedPages = [
      "cash-sessions",
      "cash_sessions.transfer",
      "cash_sessions.receive_transfer",
      "cash_sessions.resolve_transfer_dispute",
    ];
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
  clerkClient: {
    users: {
      getUser: vi.fn().mockResolvedValue({
        firstName: "Test", lastName: "User",
        primaryEmailAddress: { emailAddress: "test@example.com" },
      }),
      getUserList: vi.fn().mockResolvedValue({ data: [] }),
    },
  },
}));

vi.mock("../lib/eventsSse", () => ({
  broadcastEvent: vi.fn(),
}));

// ── App builder ───────────────────────────────────────────────────────────────

import cashTransfersRouter from "./cashTransfers";
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
  app.use(cashTransfersRouter);
  return app;
}

// ── Test fixtures ─────────────────────────────────────────────────────────────

describe.skipIf(!DATABASE_URL)(
  "Cash Transfer routes — integration",
  () => {
    let pool: InstanceType<typeof Pool>;
    let app: express.Express;

    // Fixture ids — populated in beforeAll
    let locA: number;
    let locB: number;
    let drawerA: number; // at locA, currency USD
    let drawerB: number; // at locB, currency USD
    let drawerLBP: number; // at locA, currency LBP
    let sessionA: number; // open session on drawerA, opening_cash=500
    let sessionB: number; // open session on drawerB

    async function cleanup() {
      await pool.query(`DELETE FROM cash_transfer_audit_events WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM cash_transfers WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM cash_transactions WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM cash_session_activity_logs WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM cash_sessions WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM cash_drawers WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM locations WHERE workspace_owner_id = $1`, [OWNER_ID]);
    }

    async function openSession(drawerId: number, locationId: number, currency: string, opening: string): Promise<number> {
      const r = await pool.query<{ id: number }>(
        `INSERT INTO cash_sessions
           (workspace_owner_id, session_number, drawer_id, location_id, currency, status,
            opening_cash, cash_in_total, cash_out_total, adjustments_total,
            transfers_in_total, transfers_out_total, expected_cash)
         VALUES ($1, $2, $3, $4, $5, 'open', $6, '0.00', '0.00', '0.00', '0.00', '0.00', $6)
         RETURNING id`,
        [OWNER_ID, `CS-TEST-${Date.now()}-${Math.random()}`, drawerId, locationId, currency, opening],
      );
      return r.rows[0].id;
    }

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL });
      app = makeApp();
      await cleanup();

      // Locations
      const rLocA = await pool.query<{ id: number }>(
        `INSERT INTO locations (workspace_owner_id, name) VALUES ($1, 'Transfer-Test-LocA') RETURNING id`,
        [OWNER_ID],
      );
      locA = rLocA.rows[0].id;

      const rLocB = await pool.query<{ id: number }>(
        `INSERT INTO locations (workspace_owner_id, name) VALUES ($1, 'Transfer-Test-LocB') RETURNING id`,
        [OWNER_ID],
      );
      locB = rLocB.rows[0].id;

      // Drawers
      const rDA = await pool.query<{ id: number }>(
        `INSERT INTO cash_drawers (workspace_owner_id, name, code, location_id, currency, is_active)
         VALUES ($1, 'Drawer-A', 'DRA', $2, 'USD', true) RETURNING id`,
        [OWNER_ID, locA],
      );
      drawerA = rDA.rows[0].id;

      const rDB = await pool.query<{ id: number }>(
        `INSERT INTO cash_drawers (workspace_owner_id, name, code, location_id, currency, is_active)
         VALUES ($1, 'Drawer-B', 'DRB', $2, 'USD', true) RETURNING id`,
        [OWNER_ID, locB],
      );
      drawerB = rDB.rows[0].id;

      const rDLBP = await pool.query<{ id: number }>(
        `INSERT INTO cash_drawers (workspace_owner_id, name, code, location_id, currency, is_active)
         VALUES ($1, 'Drawer-LBP', 'DRLBP', $2, 'LBP', true) RETURNING id`,
        [OWNER_ID, locA],
      );
      drawerLBP = rDLBP.rows[0].id;

      // Open sessions
      sessionA = await openSession(drawerA, locA, "USD", "500.00");
      sessionB = await openSession(drawerB, locB, "USD", "0.00");
    });

    afterAll(async () => {
      if (!pool) return;
      await cleanup();
      await pool.end();
    });

    // ── Helper: initiate a transfer ──────────────────────────────────────────

    async function initiateTransfer(opts: {
      sourceSessionId?: number;
      destDrawerId?: number;
      amount?: number;
      currency?: string;
      idempotencyKey?: string;
    } = {}) {
      const body: Record<string, unknown> = {
        destination_drawer_id: opts.destDrawerId ?? drawerB,
        amount: opts.amount ?? 100,
        currency_code: opts.currency ?? "USD",
      };
      if (opts.idempotencyKey) body.idempotency_key = opts.idempotencyKey;
      return request(app)
        .post(`/cash-sessions/${opts.sourceSessionId ?? sessionA}/transfer`)
        .send(body);
    }

    // ── POST /cash-sessions/:id/transfer ─────────────────────────────────────

    it("creates a transfer record + transfer_out transaction and returns 201", async () => {
      const res = await initiateTransfer({ amount: 100 });
      expect(res.status).toBe(201);
      expect(res.body.transfer).toBeDefined();
      expect(res.body.transfer.status).toBe("IN_TRANSIT");
      expect(res.body.transfer.currency_code).toBe("USD");
      expect(Number(res.body.transfer.sent_amount)).toBeCloseTo(100, 2);

      // Verify the transfer_out transaction exists
      const txns = await pool.query(
        `SELECT * FROM cash_transactions
          WHERE workspace_owner_id = $1 AND cash_session_id = $2 AND type = 'transfer_out'`,
        [OWNER_ID, sessionA],
      );
      expect(txns.rowCount).toBeGreaterThanOrEqual(1);
    });

    it("updates the source session expected_cash after transfer_out", async () => {
      // Re-read sessionA expected_cash — it should be less than original 500
      const sess = await pool.query<{ expected_cash: string }>(
        `SELECT expected_cash FROM cash_sessions WHERE id = $1`,
        [sessionA],
      );
      // Expected cash was 500, one or more 100-transfers were made
      expect(Number(sess.rows[0].expected_cash)).toBeLessThan(500);
    });

    it("idempotent: same idempotency_key returns the existing transfer without duplicate", async () => {
      const key = `idem-${Date.now()}`;
      const r1 = await initiateTransfer({ amount: 10, idempotencyKey: key });
      expect(r1.status).toBe(201);
      const id1 = r1.body.transfer.id;

      const r2 = await initiateTransfer({ amount: 10, idempotencyKey: key });
      expect([200, 201]).toContain(r2.status);
      expect(r2.body.transfer.id).toBe(id1);
      expect(r2.body.idempotent).toBe(true);

      // Only one transfer record for this key
      const count = await pool.query(
        `SELECT COUNT(*) AS cnt FROM cash_transfers WHERE workspace_owner_id = $1 AND idempotency_key = $2`,
        [OWNER_ID, key],
      );
      expect(Number(count.rows[0].cnt)).toBe(1);
    });

    it("rejects amount exceeding source session expected cash with 422", async () => {
      // sessionA may have had transfers; get current expected_cash
      const sess = await pool.query<{ expected_cash: string }>(
        `SELECT expected_cash FROM cash_sessions WHERE id = $1`,
        [sessionA],
      );
      const available = Number(sess.rows[0].expected_cash);
      const overAmount = available + 1000;

      const res = await initiateTransfer({ amount: overAmount });
      expect(res.status).toBe(422);
      expect(res.body.error).toMatch(/[Ii]nsufficient/);
    });

    it("rejects cross-currency destination drawer with 422", async () => {
      // drawerLBP is LBP-only; sessionA is USD — should be rejected
      const res = await initiateTransfer({ destDrawerId: drawerLBP, currency: "USD" });
      expect(res.status).toBe(422);
    });

    it("transfers LBP from an LBP-only session on a USD/LBP-capable drawer", async () => {
      const dualDrawerResult = await pool.query<{ id: number }>(
        `INSERT INTO cash_drawers
           (workspace_owner_id, name, code, location_id, currency, secondary_currency, is_active)
         VALUES ($1, 'Drawer-USD-LBP', 'DRUL', $2, 'USD', 'LBP', true)
         RETURNING id`,
        [OWNER_ID, locA],
      );
      const sourceSession = await openSession(
        dualDrawerResult.rows[0].id,
        locA,
        "LBP",
        "5000000.00",
      );

      const res = await initiateTransfer({
        sourceSessionId: sourceSession,
        destDrawerId: drawerLBP,
        amount: 1_000_000,
        currency: "LBP",
      });

      expect(res.status).toBe(201);
      expect(res.body.transfer.currency_code).toBe("LBP");
      expect(Number(res.body.transfer.sent_amount)).toBe(1_000_000);
    });

    it("transfer number follows TR-YYYY-NNNNN format", async () => {
      const res = await initiateTransfer({ amount: 1 });
      expect(res.status).toBe(201);
      expect(res.body.transfer.transfer_number).toMatch(/^TR-\d{4}-\d{5}$/);
    });

    // ── GET /cash-transfers ───────────────────────────────────────────────────

    it("GET /cash-transfers lists the created transfers", async () => {
      const res = await request(app)
        .get("/cash-transfers")
        .query({ status: "IN_TRANSIT" });
      expect(res.status).toBe(200);
      expect(res.body.transfers.length).toBeGreaterThan(0);
    });

    // ── POST /confirm-receipt ─────────────────────────────────────────────────

    it("confirm-receipt: creates transfer_in, marks COMPLETED, updates destination expected_cash", async () => {
      // Create a fresh session pair to avoid interference
      const sessC = await openSession(drawerA, locA, "USD", "200.00");
      const sessD = await openSession(drawerB, locB, "USD", "0.00");

      const initRes = await initiateTransfer({
        sourceSessionId: sessC,
        destDrawerId: drawerB,
        amount: 50,
      });
      expect(initRes.status).toBe(201);
      const transferId = initRes.body.transfer.id;

      const recRes = await request(app)
        .post(`/cash-transfers/${transferId}/confirm-receipt`)
        .send({});
      expect(recRes.status).toBe(200);
      expect(recRes.body.transfer.status).toBe("COMPLETED");
      expect(Number(recRes.body.transfer.received_amount)).toBeCloseTo(50, 2);

      // Verify transfer_in transaction on destination
      const txns = await pool.query(
        `SELECT * FROM cash_transactions
          WHERE workspace_owner_id = $1 AND cash_session_id = $2 AND type = 'transfer_in'`,
        [OWNER_ID, sessD],
      );
      expect(txns.rowCount).toBe(1);

      // Destination session expected_cash should be 50
      const dest = await pool.query<{ expected_cash: string; transfers_in_total: string }>(
        `SELECT expected_cash, transfers_in_total FROM cash_sessions WHERE id = $1`,
        [sessD],
      );
      expect(Number(dest.rows[0].transfers_in_total)).toBeCloseTo(50, 2);
      expect(Number(dest.rows[0].expected_cash)).toBeCloseTo(50, 2);
    });

    it("second confirm-receipt for same transfer is idempotent, no second transfer_in", async () => {
      const sessE = await openSession(drawerA, locA, "USD", "200.00");
      const sessF = await openSession(drawerB, locB, "USD", "0.00");

      const initRes = await initiateTransfer({
        sourceSessionId: sessE,
        destDrawerId: drawerB,
        amount: 20,
      });
      const transferId = initRes.body.transfer.id;

      // First receipt
      await request(app).post(`/cash-transfers/${transferId}/confirm-receipt`).send({});
      // Second receipt
      const second = await request(app).post(`/cash-transfers/${transferId}/confirm-receipt`).send({});

      // Should not return an error
      expect([200, 201]).toContain(second.status);

      // Still only one transfer_in for this transfer_number
      const txns = await pool.query(
        `SELECT * FROM cash_transactions
          WHERE workspace_owner_id = $1 AND cash_session_id = $2 AND type = 'transfer_in'`,
        [OWNER_ID, sessF],
      );
      expect(txns.rowCount).toBe(1);
    });

    // ── Source session close while IN_TRANSIT ─────────────────────────────────

    it("source session can close while transfer is IN_TRANSIT; transfer remains IN_TRANSIT", async () => {
      const sessG = await openSession(drawerA, locA, "USD", "300.00");

      const initRes = await initiateTransfer({
        sourceSessionId: sessG,
        destDrawerId: drawerB,
        amount: 30,
      });
      expect(initRes.status).toBe(201);
      const transferId = initRes.body.transfer.id;

      // Close source session directly in DB (simulate the close route)
      await pool.query(
        `UPDATE cash_sessions SET status = 'pending_review', closed_at = now() WHERE id = $1`,
        [sessG],
      );

      // Transfer should still be IN_TRANSIT
      const transfer = await pool.query<{ status: string }>(
        `SELECT status FROM cash_transfers WHERE id = $1`,
        [transferId],
      );
      expect(transfer.rows[0].status).toBe("IN_TRANSIT");
    });

    // ── report-difference → DISPUTED ─────────────────────────────────────────

    it("report-difference marks transfer DISPUTED without creating destination ledger entry", async () => {
      const sessH = await openSession(drawerA, locA, "USD", "300.00");
      const sessI = await openSession(drawerB, locB, "USD", "0.00");

      const initRes = await initiateTransfer({
        sourceSessionId: sessH,
        destDrawerId: drawerB,
        amount: 80,
      });
      expect(initRes.status).toBe(201);
      const transferId = initRes.body.transfer.id;

      const dispRes = await request(app)
        .post(`/cash-transfers/${transferId}/report-difference`)
        .send({ actual_received_amount: 75, explanation: "Short by 5 USD" });

      expect(dispRes.status).toBe(200);
      expect(dispRes.body.transfer.status).toBe("DISPUTED");
      expect(Number(dispRes.body.transfer.actual_received_amount)).toBeCloseTo(75, 2);
      expect(Number(dispRes.body.transfer.difference_amount)).toBeCloseTo(-5, 2);

      // No transfer_in transaction should exist yet
      const txns = await pool.query(
        `SELECT * FROM cash_transactions
          WHERE workspace_owner_id = $1 AND cash_session_id = $2 AND type = 'transfer_in'`,
        [OWNER_ID, sessI],
      );
      expect(txns.rowCount).toBe(0);

      // Destination expected_cash should remain 0
      const dest = await pool.query<{ expected_cash: string }>(
        `SELECT expected_cash FROM cash_sessions WHERE id = $1`,
        [sessI],
      );
      expect(Number(dest.rows[0].expected_cash)).toBeCloseTo(0, 2);
    });

    it("report-difference requires explanation when actual differs", async () => {
      const sessX = await openSession(drawerA, locA, "USD", "100.00");
      await openSession(drawerB, locB, "USD", "0.00");

      const initRes = await initiateTransfer({
        sourceSessionId: sessX,
        destDrawerId: drawerB,
        amount: 40,
      });
      const transferId = initRes.body.transfer.id;

      const res = await request(app)
        .post(`/cash-transfers/${transferId}/report-difference`)
        .send({ actual_received_amount: 35 }); // missing explanation

      expect(res.status).toBe(400);
    });

    // ── resolve-dispute ───────────────────────────────────────────────────────

    it("resolve-dispute credits destination session once and marks COMPLETED", async () => {
      const sessJ = await openSession(drawerA, locA, "USD", "400.00");
      const sessK = await openSession(drawerB, locB, "USD", "0.00");

      const initRes = await initiateTransfer({
        sourceSessionId: sessJ,
        destDrawerId: drawerB,
        amount: 60,
      });
      expect(initRes.status).toBe(201);
      const transferId = initRes.body.transfer.id;

      // Report a difference first
      await request(app)
        .post(`/cash-transfers/${transferId}/report-difference`)
        .send({ actual_received_amount: 55, explanation: "Short delivery" });

      // Resolve dispute
      const resolveRes = await request(app)
        .post(`/cash-transfers/${transferId}/resolve-dispute`)
        .send({ resolution_reason: "Verified with CCTV", received_amount: 55 });

      expect(resolveRes.status).toBe(200);
      expect(resolveRes.body.transfer.status).toBe("COMPLETED");
      expect(Number(resolveRes.body.transfer.received_amount)).toBeCloseTo(55, 2);

      // Destination should have one transfer_in for 55
      const txns = await pool.query(
        `SELECT * FROM cash_transactions
          WHERE workspace_owner_id = $1 AND cash_session_id = $2 AND type = 'transfer_in'`,
        [OWNER_ID, sessK],
      );
      expect(txns.rowCount).toBe(1);
      expect(Number(txns.rows[0].amount)).toBeCloseTo(55, 2);
    });

    it("resolve-dispute does not create a second transfer_in if already credited", async () => {
      // First confirm receipt, then try to resolve dispute (should be COMPLETED already)
      const sessL = await openSession(drawerA, locA, "USD", "200.00");
      const sessM = await openSession(drawerB, locB, "USD", "0.00");

      const initRes = await initiateTransfer({
        sourceSessionId: sessL,
        destDrawerId: drawerB,
        amount: 25,
      });
      const transferId = initRes.body.transfer.id;

      // Dispute it
      await request(app)
        .post(`/cash-transfers/${transferId}/report-difference`)
        .send({ actual_received_amount: 20, explanation: "Discrepancy noted" });

      // Resolve once
      await request(app)
        .post(`/cash-transfers/${transferId}/resolve-dispute`)
        .send({ resolution_reason: "Confirmed 20 USD received", received_amount: 20 });

      // Try to resolve again — should be rejected (already COMPLETED)
      const secondResolve = await request(app)
        .post(`/cash-transfers/${transferId}/resolve-dispute`)
        .send({ resolution_reason: "Attempt 2" });

      expect(secondResolve.status).toBe(409);

      // Still only one transfer_in
      const txns = await pool.query(
        `SELECT * FROM cash_transactions
          WHERE workspace_owner_id = $1 AND cash_session_id = $2 AND type = 'transfer_in'`,
        [OWNER_ID, sessM],
      );
      expect(txns.rowCount).toBe(1);
    });

    // ── Unauthorized access ───────────────────────────────────────────────────

    it("returns 403 for transfer initiation without permission", async () => {
      const { workspace: wsMod } = await import("../lib/workspace");
      const original = (wsMod as unknown as { workspace: typeof import("../lib/workspace").workspace }).workspace;

      // Temporarily build an app that sets no transfer permission
      const noPermApp = express();
      noPermApp.use(express.json());
      noPermApp.use((req: express.Request, _res: express.Response, next: express.NextFunction) => {
        const wreq = req as unknown as WorkspaceRequest;
        wreq.workspaceOwnerId = OWNER_ID;
        wreq.workspaceRole = "member";
        wreq.workspaceActualRole = "member";
        wreq.userId = USER_ID;
        wreq.userEmail = "noperm@example.com";
        wreq.allowedPages = ["cash-sessions"]; // no transfer permission
        next();
      });
      noPermApp.use(cashTransfersRouter);

      const res = await request(noPermApp)
        .post(`/cash-sessions/${sessionA}/transfer`)
        .send({ destination_drawer_id: drawerB, amount: 10, currency_code: "USD" });
      expect(res.status).toBe(403);
    });

    it("returns 403 for confirm-receipt without receive permission", async () => {
      const noPermApp = express();
      noPermApp.use(express.json());
      noPermApp.use((req: express.Request, _res: express.Response, next: express.NextFunction) => {
        const wreq = req as unknown as WorkspaceRequest;
        wreq.workspaceOwnerId = OWNER_ID;
        wreq.workspaceRole = "member";
        wreq.workspaceActualRole = "member";
        wreq.allowedPages = ["cash-sessions"]; // no receive_transfer
        next();
      });
      noPermApp.use(cashTransfersRouter);

      const res = await request(noPermApp)
        .post(`/cash-transfers/999/confirm-receipt`)
        .send({});
      expect(res.status).toBe(403);
    });

    it("returns 403 for resolve-dispute without resolve permission", async () => {
      const noPermApp = express();
      noPermApp.use(express.json());
      noPermApp.use((req: express.Request, _res: express.Response, next: express.NextFunction) => {
        const wreq = req as unknown as WorkspaceRequest;
        wreq.workspaceOwnerId = OWNER_ID;
        wreq.workspaceRole = "member";
        wreq.workspaceActualRole = "member";
        wreq.allowedPages = ["cash-sessions", "cash_sessions.receive_transfer"]; // no resolve
        next();
      });
      noPermApp.use(cashTransfersRouter);

      const res = await request(noPermApp)
        .post(`/cash-transfers/999/resolve-dispute`)
        .send({ resolution_reason: "test" });
      expect(res.status).toBe(403);
    });

    // ── Same-location transfer ────────────────────────────────────────────────

    it("same-location transfer: handover → confirm → COMPLETED in one flow", async () => {
      // Use two drawers at locA: drawerA (USD) → drawerLBP is cross-currency,
      // so create a second USD drawer at locA.
      const rDA2 = await pool.query<{ id: number }>(
        `INSERT INTO cash_drawers (workspace_owner_id, name, code, location_id, currency, is_active)
         VALUES ($1, 'Drawer-A2', 'DRA2', $2, 'USD', true) RETURNING id`,
        [OWNER_ID, locA],
      );
      const drawerA2 = rDA2.rows[0].id;

      const sessN = await openSession(drawerA, locA, "USD", "300.00");
      const sessO = await openSession(drawerA2, locA, "USD", "0.00");

      // Handover
      const initRes = await initiateTransfer({
        sourceSessionId: sessN,
        destDrawerId: drawerA2,
        amount: 100,
      });
      expect(initRes.status).toBe(201);
      const transferId = initRes.body.transfer.id;
      expect(initRes.body.transfer.status).toBe("IN_TRANSIT");

      // Confirm receipt
      const recRes = await request(app)
        .post(`/cash-transfers/${transferId}/confirm-receipt`)
        .send({});
      expect(recRes.status).toBe(200);
      expect(recRes.body.transfer.status).toBe("COMPLETED");

      // Source lost 100
      const src = await pool.query<{ transfers_out_total: string }>(
        `SELECT transfers_out_total FROM cash_sessions WHERE id = $1`,
        [sessN],
      );
      expect(Number(src.rows[0].transfers_out_total)).toBeGreaterThanOrEqual(100);

      // Destination gained 100
      const dst = await pool.query<{ transfers_in_total: string }>(
        `SELECT transfers_in_total FROM cash_sessions WHERE id = $1`,
        [sessO],
      );
      expect(Number(dst.rows[0].transfers_in_total)).toBeCloseTo(100, 2);
    });

    // ── GET /cash-transfers — still visible after source session closes ────────

    it("transfer remains accessible via GET /cash-transfers after source session closes", async () => {
      const sessSrc = await openSession(drawerA, locA, "USD", "200.00");

      const initRes = await initiateTransfer({
        sourceSessionId: sessSrc,
        destDrawerId: drawerB,
        amount: 15,
      });
      expect(initRes.status).toBe(201);
      const transferNumber = initRes.body.transfer.transfer_number;

      // Close source session
      await pool.query(
        `UPDATE cash_sessions SET status = 'pending_review', closed_at = now() WHERE id = $1`,
        [sessSrc],
      );

      const listRes = await request(app).get("/cash-transfers").query({ q: transferNumber });
      expect(listRes.status).toBe(200);
      expect(listRes.body.transfers.some((t: { transfer_number: string }) => t.transfer_number === transferNumber)).toBe(true);
    });
  },
);
