/**
 * Integration tests: CMC POS overdue session resolution — HTTP-level
 *
 * Covers:
 *  1. Blocking guardrail — starting a new shift returns 409 when an unresolved
 *     overdue session exists on the same drawer.
 *  2. Immediate closure — different closers and discrepancies do not create an
 *     approval-pending state or require a separate note.
 *  3. Dual-currency reconciliation — both currency counts are frozen accurately.
 *  4. Sequential and concurrent double-close protection rejects repeat attempts.
 *  5. Business date preserved — after resolution the cash_session_resolutions row
 *     stores the original opening-day date, not the resolution date.
 *  6. Manager escalation idempotency — the cash_session_reminders DB constraint
 *     prevents duplicate rows for (cash_session_id, reminder_type).
 *
 * Auth and workspace middleware are mocked to inject fixed identities; everything
 * else (SQL, transactions, cashDesk helpers) runs against a real database.
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

// ── Stable test identifiers ───────────────────────────────────────────────────

const OWNER_ID = "__cmc_overdue_integ__";
const USER_A   = "cmc_overdue_user_a";
const USER_B   = "cmc_overdue_user_b";

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  authed: (req: express.Request) => req,
}));

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest & { userId?: string };
    const headerUser = req.headers["x-test-user-id"];
    wreq.workspaceOwnerId    = OWNER_ID;
    wreq.workspaceRole       = "owner";
    wreq.workspaceActualRole = "owner";
    wreq.allowedPages        = null;
    wreq.userId = typeof headerUser === "string" ? headerUser : USER_A;
    (req as unknown as Record<string, unknown>).userId = wreq.userId;
    wreq.userEmail = `${wreq.userId}@test.example`;
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

vi.mock("../lib/logger", () => ({
  logger: {
    info:  vi.fn(), warn:  vi.fn(), error: vi.fn(),
    debug: vi.fn(), child: vi.fn().mockReturnThis(),
  },
}));

vi.mock("../lib/objectStorage", () => ({
  objectStorageClient: {
    upload: vi.fn().mockResolvedValue({ publicUrl: "https://example.com/img.jpg" }),
  },
}));

vi.mock("../lib/tookan", () => ({
  isTookanEnabled: vi.fn().mockResolvedValue(false),
  createTookanStockRequestTask: vi.fn().mockResolvedValue(undefined),
  createTookanReturnTask: vi.fn().mockResolvedValue(undefined),
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

vi.mock("../lib/eventsSse", () => ({
  broadcastEvent: vi.fn(),
}));

vi.mock("../lib/orderAlerts", () => ({
  notifyCashSessionLongOpenAlerts:          vi.fn().mockResolvedValue(undefined),
  notifyCashSessionClosingTimeAlert:        vi.fn().mockResolvedValue(undefined),
  notifyCashSessionOverdueAlerts:           vi.fn().mockResolvedValue(undefined),
  notifyCashSessionManagerEscalationAlerts: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/inventoryService", () => ({
  postMovement: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@clerk/express", () => ({
  clerkClient: {
    users: { getUserList: vi.fn().mockResolvedValue({ data: [] }) },
  },
}));

// Import AFTER vi.mock (hoisting boundary).
import cmcPosRouter from "./cmcPos";

// ── App factory ───────────────────────────────────────────────────────────────

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api", cmcPosRouter);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const e = err as { message?: string; code?: string; stack?: string };
    console.error("[TEST-APP ERROR]", e?.message ?? String(err), e?.code, e?.stack?.split("\n")[1]);
    res.status(500).json({ error: e?.message ?? String(err), code: e?.code });
  });
  return app;
}

// ── DB helpers ────────────────────────────────────────────────────────────────

let pool: InstanceType<typeof Pool>;

async function q<T extends pg.QueryResultRow = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(sql, params);
}

/** Create a location configured for overdue detection. */
async function setupOverdueLocation(name: string): Promise<number> {
  const r = await q<{ id: number }>(
    `INSERT INTO locations
       (workspace_owner_id, name, country, status, timezone, same_day_cutoff_time, grace_period_minutes)
     VALUES ($1, $2, 'Lebanon', 'active', 'UTC', '01:00', 30)
     RETURNING id`,
    [OWNER_ID, name],
  );
  return r.rows[0].id;
}

async function setupDrawer(
  locationId: number,
  currency = "USD",
  secondaryCurrency: string | null = null,
): Promise<{ drawerId: number; code: string }> {
  const code = `OD${locationId}`;
  const r = await q<{ id: number }>(
    `INSERT INTO cash_drawers
       (workspace_owner_id, name, code, location_id, currency, secondary_currency, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, true)
     RETURNING id`,
    [OWNER_ID, `Drawer ${locationId}`, code, locationId, currency, secondaryCurrency],
  );
  return { drawerId: r.rows[0].id, code };
}

/**
 * Opens a normal (non-overdue) shift via the route, then back-dates both the
 * cash_session and cmc_shift so `computeShiftOverdue` considers the session
 * overdue (opened 48 hours ago, cutoff was 01:00 UTC 47 hours ago).
 *
 * Returns the shift and session IDs.
 */
async function openAndMakeOverdue(
  app: express.Express,
  locationId: number,
  opener: string,
  openingCashSecondary?: number,
): Promise<{ shiftId: number; sessionId: number }> {
  const openRes = await request(app)
    .post("/api/cmc-pos/shifts")
    .set("x-test-user-id", opener)
    .send({
      location_id: locationId,
      opening_cash: 100,
      ...(openingCashSecondary !== undefined
        ? { opening_cash_secondary: openingCashSecondary }
        : {}),
    });

  if (openRes.status !== 201) {
    throw new Error(
      `openAndMakeOverdue: shift open failed (${openRes.status}): ${JSON.stringify(openRes.body)}`,
    );
  }

  const shiftId   = openRes.body.shift.id as number;
  const sessionId = openRes.body.cash_session_id as number;

  // Back-date to 48 hours ago so the cutoff (01:00 UTC yesterday) is long past
  await q(
    `UPDATE cash_sessions SET opened_at = now() - interval '48 hours' WHERE id = $1`,
    [sessionId],
  );
  await q(
    `UPDATE cmc_shifts SET opened_at = now() - interval '48 hours' WHERE id = $1`,
    [shiftId],
  );

  return { shiftId, sessionId };
}

// ── Setup / Teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  if (!DATABASE_URL) return;
  pool = new Pool({ connectionString: DATABASE_URL });

  for (const [userId, email] of [
    [USER_A, "od-test-a@example.com"],
    [USER_B, "od-test-b@example.com"],
  ]) {
    await q(
      `INSERT INTO workspace_members (workspace_owner_id, member_user_id, member_email, role)
       VALUES ($1, $2, $3, 'member') ON CONFLICT DO NOTHING`,
      [OWNER_ID, userId, email],
    );
  }
});

afterAll(async () => {
  if (!pool) return;
  await cleanupAll();
  await q(`DELETE FROM workspace_members WHERE workspace_owner_id = $1`, [OWNER_ID]);
  await pool.end();
});

async function cleanupAll() {
  await q(`DELETE FROM cash_session_reminders WHERE workspace_id = $1`,       [OWNER_ID]);
  await q(`DELETE FROM cash_session_resolutions WHERE workspace_id = $1`,     [OWNER_ID]);
  await q(`DELETE FROM cash_transactions WHERE workspace_owner_id = $1`,      [OWNER_ID]);
  await q(`DELETE FROM cash_session_activity_logs WHERE workspace_owner_id = $1`, [OWNER_ID]);
  await q(`DELETE FROM cash_sessions WHERE workspace_owner_id = $1`,          [OWNER_ID]);
  await q(`DELETE FROM cmc_sales WHERE workspace_owner_id = $1`,              [OWNER_ID]);
  await q(`UPDATE cmc_shifts SET cash_session_id = NULL WHERE workspace_owner_id = $1`, [OWNER_ID]);
  await q(`DELETE FROM cmc_shifts WHERE workspace_owner_id = $1`,             [OWNER_ID]);
  await q(`DELETE FROM cash_drawers WHERE workspace_owner_id = $1`,           [OWNER_ID]);
  await q(`DELETE FROM locations WHERE workspace_owner_id = $1`,              [OWNER_ID]);
}

beforeEach(async () => {
  if (!pool) return;
  await cleanupAll();
});

function skipIfNoDb() {
  if (!DATABASE_URL) {
    console.log("DATABASE_URL not set — skipping integration test");
    return true;
  }
  return false;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("CMC POS overdue resolution — route-level integration", () => {

  // ── 1. Blocking guardrail ──────────────────────────────────────────────────

  describe("POST /api/cmc-pos/shifts — blocking guardrail", () => {
    it("returns 409 OVERDUE_SESSION_UNRESOLVED when an unresolved overdue session exists for the drawer", async () => {
      if (skipIfNoDb()) return;
      const app        = makeApp();
      const locationId = await setupOverdueLocation("Guardrail Loc");
      await setupDrawer(locationId);

      // Open a shift as USER_A, then make it overdue
      await openAndMakeOverdue(app, locationId, USER_A);

      // USER_B tries to open a new shift on the same drawer
      const res = await request(app)
        .post("/api/cmc-pos/shifts")
        .set("x-test-user-id", USER_B)
        .send({ location_id: locationId, opening_cash: 50 });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("OVERDUE_SESSION_UNRESOLVED");
    });

    it("allows a new shift when there is NO overdue session at the drawer", async () => {
      if (skipIfNoDb()) return;
      const app        = makeApp();
      const locationId = await setupOverdueLocation("No Overdue Loc");
      await setupDrawer(locationId);

      // USER_A opens a fresh (non-overdue) shift — should succeed
      const res = await request(app)
        .post("/api/cmc-pos/shifts")
        .set("x-test-user-id", USER_A)
        .send({ location_id: locationId, opening_cash: 100 });

      expect(res.status).toBe(201);
      expect(res.body.shift?.id).toBeTypeOf("number");
    });
  });

  // ── 2. Finalized session / open shift recovery ─────────────────────────────
  describe("POST /api/cmc-pos/shifts/close — finalized session recovery", () => {
    it.each(["approved", "closed"] as const)(
      "closes only the overdue shift when its linked session is already %s",
      async (finalizedStatus) => {
        if (skipIfNoDb()) return;
        const app = makeApp();
        const locationId = await setupOverdueLocation(`Finalized ${finalizedStatus} Recovery Loc`);
        await setupDrawer(locationId);
        const { shiftId, sessionId } = await openAndMakeOverdue(app, locationId, USER_A);

        const reconciliation = {
          counts: [{ currency: "USD", expected: 100, actual: 92, variance: -8 }],
          source: "cash-desk",
        };
        await q(
          `UPDATE cash_sessions
              SET status = $1, closed_at = now(), closed_by_clerk_id = $2,
                  actual_cash = 92, expected_cash = 100, difference = -8,
                  reconciliation = $3::jsonb
            WHERE id = $4 AND workspace_owner_id = $5`,
          [finalizedStatus, USER_B, JSON.stringify(reconciliation), sessionId, OWNER_ID],
        );

        const before = await q(
          `SELECT status, actual_cash, expected_cash, difference, reconciliation,
                  closed_at, closed_by_clerk_id
             FROM cash_sessions
            WHERE id = $1 AND workspace_owner_id = $2`,
          [sessionId, OWNER_ID],
        );
        const logsBefore = await q(
          `SELECT id, action, detail
             FROM cash_session_activity_logs
            WHERE cash_session_id = $1
            ORDER BY id`,
          [sessionId],
        );

        const activeBeforeRecovery = await request(app)
          .get(`/api/cmc-pos/shifts/active?location_id=${locationId}`)
          .set("x-test-user-id", USER_A);
        expect(activeBeforeRecovery.status).toBe(200);
        expect(activeBeforeRecovery.body.shift).toMatchObject({
          id: shiftId,
          isOverdue: true,
          cash_session_status: finalizedStatus,
        });

        const closeRes = await request(app)
          .post("/api/cmc-pos/shifts/close")
          .set("x-test-user-id", USER_A)
          .send({ cash_kept: 0, cash_transferred: 0, location_id: locationId });

        expect(closeRes.status).toBe(200);
        expect(closeRes.body.session_already_finalized).toBe(true);
        expect(closeRes.body.message).toMatch(/reconciliation and audit trail were left unchanged/i);

        const after = await q(
          `SELECT status, actual_cash, expected_cash, difference, reconciliation,
                  closed_at, closed_by_clerk_id
             FROM cash_sessions
            WHERE id = $1 AND workspace_owner_id = $2`,
          [sessionId, OWNER_ID],
        );
        expect(after.rows).toEqual(before.rows);

        const logsAfter = await q(
          `SELECT id, action, detail
             FROM cash_session_activity_logs
            WHERE cash_session_id = $1
            ORDER BY id`,
          [sessionId],
        );
        expect(logsAfter.rows).toEqual(logsBefore.rows);

        const shift = await q<{ status: string; closing_cash_kept: string; closing_cash_transferred: string }>(
          `SELECT status, closing_cash_kept, closing_cash_transferred
             FROM cmc_shifts
            WHERE id = $1 AND workspace_owner_id = $2`,
          [shiftId, OWNER_ID],
        );
        expect(shift.rows[0]).toMatchObject({
          status: "closed",
          closing_cash_transferred: "0.00",
        });
        expect(Number(shift.rows[0].closing_cash_kept)).toBe(92);

        // Once the stranded shift is closed, the normal CMC start flow can open
        // a fresh linked session on the same drawer.
        const nextShift = await request(app)
          .post("/api/cmc-pos/shifts")
          .set("x-test-user-id", USER_A)
          .send({ location_id: locationId, opening_cash: 92 });
        expect(nextShift.status).toBe(201);
        expect(nextShift.body.cash_session_id).toBeTypeOf("number");
        expect(nextShift.body.cash_session_id).not.toBe(sessionId);
      },
    );

    it("allows only one concurrent recovery to close a finalized session's overdue shift", async () => {
      if (skipIfNoDb()) return;
      const app = makeApp();
      const locationId = await setupOverdueLocation("Concurrent Finalized Recovery Loc");
      await setupDrawer(locationId);
      const { shiftId, sessionId } = await openAndMakeOverdue(app, locationId, USER_A);

      await q(
        `UPDATE cash_sessions
            SET status = 'closed', closed_at = now(), closed_by_clerk_id = $1,
                actual_cash = 100, expected_cash = 100, difference = 0
          WHERE id = $2 AND workspace_owner_id = $3`,
        [USER_B, sessionId, OWNER_ID],
      );
      const sessionBefore = await q(
        `SELECT status, actual_cash, expected_cash, difference, closed_at, closed_by_clerk_id
           FROM cash_sessions
          WHERE id = $1 AND workspace_owner_id = $2`,
        [sessionId, OWNER_ID],
      );

      const recover = (userId: string) =>
        request(app)
          .post("/api/cmc-pos/shifts/close")
          .set("x-test-user-id", userId)
          .send({ cash_kept: 0, cash_transferred: 0, location_id: locationId });
      const responses = await Promise.all([recover(USER_A), recover(USER_B)]);

      expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
      const rejected = responses.find((response) => response.status !== 200);
      expect([404, 409]).toContain(rejected?.status);

      const sessionAfter = await q(
        `SELECT status, actual_cash, expected_cash, difference, closed_at, closed_by_clerk_id
           FROM cash_sessions
          WHERE id = $1 AND workspace_owner_id = $2`,
        [sessionId, OWNER_ID],
      );
      expect(sessionAfter.rows).toEqual(sessionBefore.rows);

      const shift = await q<{ status: string }>(
        `SELECT status FROM cmc_shifts WHERE id = $1 AND workspace_owner_id = $2`,
        [shiftId, OWNER_ID],
      );
      expect(shift.rows[0].status).toBe("closed");
    });
  });

  // ── 2. Immediate closure and duplicate protection ─────────────────────────

  describe("POST /api/cmc-pos/shifts/resolve — duplicate resolution protection", () => {
    it("closes immediately for a different closer with a discrepancy and no note", async () => {
      if (skipIfNoDb()) return;
      const app        = makeApp();
      const locationId = await setupOverdueLocation("Immediate Close Loc");
      await setupDrawer(locationId);

      const { shiftId, sessionId } = await openAndMakeOverdue(app, locationId, USER_A);

      const res = await request(app)
        .post("/api/cmc-pos/shifts/resolve")
        .set("x-test-user-id", USER_B)
        .send({
          shiftId,
          countedBalance: 90,
          currency: "USD",
          reason: "other",
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe("closed");
      expect(res.body.resolution.approval_required).toBe(false);
      expect(res.body.resolution.approval_status).toBeNull();
      expect(res.body.resolution.note).toBeNull();

      const state = await q<{
        shift_status: string;
        session_status: string;
        difference: string;
        closed_by_user_id: string;
      }>(
        `SELECT s.status AS shift_status, s.closed_by_user_id,
                cs.status AS session_status, cs.difference
           FROM cmc_shifts s
           JOIN cash_sessions cs ON cs.id = s.cash_session_id
          WHERE s.id = $1 AND cs.id = $2`,
        [shiftId, sessionId],
      );
      expect(state.rows[0]).toMatchObject({
        shift_status: "closed",
        session_status: "closed",
        closed_by_user_id: USER_B,
      });
      expect(Number(state.rows[0].difference)).toBeCloseTo(-10, 2);
    });

    it("serializes concurrent resolve attempts so only one closes the session", async () => {
      if (skipIfNoDb()) return;
      const app        = makeApp();
      const locationId = await setupOverdueLocation("Concurrent Close Loc");
      await setupDrawer(locationId);
      const { shiftId } = await openAndMakeOverdue(app, locationId, USER_A);

      const resolveRequest = (userId: string) =>
        request(app)
          .post("/api/cmc-pos/shifts/resolve")
          .set("x-test-user-id", userId)
          .send({
            shiftId,
            countedBalance: 100,
            currency: "USD",
            reason: "forgot_to_close",
          });

      const responses = await Promise.all([
        resolveRequest(USER_A),
        resolveRequest(USER_B),
      ]);
      expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
      const rejected = responses.find((response) => response.status !== 201);
      expect([404, 409]).toContain(rejected?.status);
      if (rejected?.status === 409) {
        expect(rejected.body.code).toBe("SESSION_ALREADY_CLOSED");
      }
    });

    it("returns 404 for a second resolve attempt when the first already closed the session", async () => {
      if (skipIfNoDb()) return;
      const app        = makeApp();
      const locationId = await setupOverdueLocation("Auto-Close Loc");
      await setupDrawer(locationId);

      // Open shift as USER_A and make it overdue
      const { shiftId } = await openAndMakeOverdue(app, locationId, USER_A);

      // USER_A resolves their own shift (same opener) → no approval needed → session auto-closed
      const firstRes = await request(app)
        .post("/api/cmc-pos/shifts/resolve")
        .set("x-test-user-id", USER_A)
        .send({
          shiftId,
          countedBalance: 100,
          currency: "USD",
          reason: "forgot_to_close",
        });

      expect(firstRes.status).toBe(201);
      expect(firstRes.body.status).toBe("closed");

      // Second attempt — shift is now closed → 404 Active shift not found
      const secondRes = await request(app)
        .post("/api/cmc-pos/shifts/resolve")
        .set("x-test-user-id", USER_A)
        .send({
          shiftId,
          countedBalance: 100,
          currency: "USD",
          reason: "forgot_to_close",
        });

      expect(secondRes.status).toBe(404);
    });
  });

  describe("POST /api/cmc-pos/shifts/resolve — dual-currency reconciliation", () => {
    it("closes an overdue dual-currency session and freezes both currency counts without approval", async () => {
      if (skipIfNoDb()) return;
      const app        = makeApp();
      const locationId = await setupOverdueLocation("Dual Currency Resolve Loc");
      await setupDrawer(locationId, "USD", "LBP");
      const { shiftId, sessionId } = await openAndMakeOverdue(
        app,
        locationId,
        USER_A,
        1_000_000,
      );

      await q(
        `INSERT INTO cash_transactions
           (workspace_owner_id, cash_session_id, location_id, currency, type, direction, amount, created_by_clerk_id)
         VALUES
           ($1, $2, $3, 'USD', 'cash_sale', 'in', 25, $4),
           ($1, $2, $3, 'LBP', 'expense', 'out', 100000, $4)`,
        [OWNER_ID, sessionId, locationId, USER_A],
      );

      const res = await request(app)
        .post("/api/cmc-pos/shifts/resolve")
        .set("x-test-user-id", USER_B)
        .send({
          shiftId,
          countedBalance: 120,
          countedBalanceSecondary: 850_000,
          currency: "USD",
          reason: "other",
        });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe("closed");
      expect(res.body.resolution.approval_required).toBe(false);
      expect(res.body.resolution.reason).toBe("other");
      expect(res.body.resolution.secondary_currency).toBe("LBP");
      expect(Number(res.body.resolution.expected_balance_secondary)).toBe(900_000);
      expect(Number(res.body.resolution.difference_secondary)).toBe(-50_000);

      const session = await q<{
        status: string;
        actual_cash: string;
        expected_cash: string;
        difference: string;
        actual_cash_secondary: string;
        expected_cash_secondary: string;
        difference_secondary: string;
      }>(
        `SELECT status, actual_cash, expected_cash, difference,
                actual_cash_secondary, expected_cash_secondary, difference_secondary
           FROM cash_sessions
          WHERE id = $1 AND workspace_owner_id = $2`,
        [sessionId, OWNER_ID],
      );
      expect(session.rows[0].status).toBe("closed");
      expect(Number(session.rows[0].actual_cash)).toBe(120);
      expect(Number(session.rows[0].expected_cash)).toBe(125);
      expect(Number(session.rows[0].difference)).toBe(-5);
      expect(Number(session.rows[0].actual_cash_secondary)).toBe(850_000);
      expect(Number(session.rows[0].expected_cash_secondary)).toBe(900_000);
      expect(Number(session.rows[0].difference_secondary)).toBe(-50_000);

      const activity = await q<{ detail: Record<string, unknown> }>(
        `SELECT detail
           FROM cash_session_activity_logs
          WHERE cash_session_id = $1 AND action = 'resolved'
          ORDER BY id DESC LIMIT 1`,
        [sessionId],
      );
      const activityDetail = typeof activity.rows[0].detail === "string"
        ? JSON.parse(activity.rows[0].detail) as Record<string, unknown>
        : activity.rows[0].detail;
      expect(activityDetail).toMatchObject({
        reason: "other",
        counted_balance: 120,
        secondary_currency: "LBP",
        counted_balance_secondary: 850_000,
        expected_balance_secondary: 900_000,
        difference_secondary: -50_000,
      });
    });
  });

  // ── 3. Business date preserved ────────────────────────────────────────────

  describe("POST /api/cmc-pos/shifts/resolve — business date", () => {
    it("stores the opening day's local date in original_business_date (not the resolution date)", async () => {
      if (skipIfNoDb()) return;
      const app        = makeApp();
      const locationId = await setupOverdueLocation("Business Date Loc");
      await setupDrawer(locationId);

      // Open shift and make it overdue (session opened 48h ago)
      const { shiftId, sessionId } = await openAndMakeOverdue(app, locationId, USER_A);

      // Look up the actual opened_at that was back-dated to get expected date
      const sessRow = await q<{ opened_at: string }>(
        `SELECT opened_at FROM cash_sessions WHERE id = $1`,
        [sessionId],
      );
      const openedAt = new Date(sessRow.rows[0].opened_at);
      // UTC date of the opening (the location timezone is 'UTC' in tests)
      const expectedDate = openedAt.toISOString().slice(0, 10); // "YYYY-MM-DD"

      // Resolve it
      const res = await request(app)
        .post("/api/cmc-pos/shifts/resolve")
        .set("x-test-user-id", USER_A)
        .send({
          shiftId,
          countedBalance: 100,
          currency: "USD",
          reason: "forgot_to_close",
        });

      expect(res.status).toBe(201);

      // Verify the resolution row preserves the opening day, not today's date
      const resolution = await q<{
        original_business_date: string;
        resolved_at: string;
      }>(
        `SELECT original_business_date, resolved_at
           FROM cash_session_resolutions
          WHERE cash_session_id = $1 AND workspace_id = $2`,
        [sessionId, OWNER_ID],
      );

      expect(resolution.rows).toHaveLength(1);
      const row = resolution.rows[0];

      // original_business_date should be the opening day (48 h ago), NOT today
      const storedBusinessDate = new Date(row.original_business_date).toISOString().slice(0, 10);
      expect(storedBusinessDate).toBe(expectedDate);

      // resolved_at should be approximately now (today), confirming the dates differ
      const resolvedDate = new Date(row.resolved_at).toISOString().slice(0, 10);
      expect(resolvedDate).not.toBe(expectedDate);
    });

    it("shift history API returns resolution details for a resolved-late shift", async () => {
      if (skipIfNoDb()) return;
      const app        = makeApp();
      const locationId = await setupOverdueLocation("History API Loc");
      await setupDrawer(locationId);

      const { shiftId, sessionId } = await openAndMakeOverdue(app, locationId, USER_A);
      const sessRow = await q<{ opened_at: string }>(
        `SELECT opened_at FROM cash_sessions WHERE id = $1`,
        [sessionId],
      );
      const expectedDate = new Date(sessRow.rows[0].opened_at).toISOString().slice(0, 10);

      // Resolve
      await request(app)
        .post("/api/cmc-pos/shifts/resolve")
        .set("x-test-user-id", USER_A)
        .send({ shiftId, countedBalance: 100, currency: "USD", reason: "forgot_to_close" });

      // Fetch shift history
      const histRes = await request(app)
        .get(`/api/cmc-pos/shifts?location_id=${locationId}`)
        .set("x-test-user-id", USER_A);

      expect(histRes.status).toBe(200);
      const resolved = histRes.body.shifts.find((s: Record<string, unknown>) => s.id === shiftId);
      expect(resolved).toBeDefined();
      expect(resolved.resolution_id).toBeTypeOf("number");
      expect(resolved.resolution_reason).toBe("forgot_to_close");
      expect(new Date(resolved.original_business_date as string).toISOString().slice(0, 10)).toBe(expectedDate);
    });

    it("?filter=overdue returns only shifts with a resolution record", async () => {
      if (skipIfNoDb()) return;
      const app        = makeApp();
      const locationId = await setupOverdueLocation("Filter Overdue Loc");
      await setupDrawer(locationId);

      // Create ONE overdue-resolved shift
      const { shiftId: overdueShiftId } = await openAndMakeOverdue(app, locationId, USER_A);
      await request(app)
        .post("/api/cmc-pos/shifts/resolve")
        .set("x-test-user-id", USER_A)
        .send({ shiftId: overdueShiftId, countedBalance: 100, currency: "USD", reason: "forgot_to_close" });

      // Fetch with filter=overdue
      const filteredRes = await request(app)
        .get(`/api/cmc-pos/shifts?location_id=${locationId}&filter=overdue`)
        .set("x-test-user-id", USER_A);

      expect(filteredRes.status).toBe(200);
      const shifts = filteredRes.body.shifts as Array<{ id: number; resolution_id: number | null }>;
      // All returned shifts must have a resolution_id
      expect(shifts.length).toBeGreaterThan(0);
      expect(shifts.every((s) => s.resolution_id != null)).toBe(true);
      expect(shifts.some((s) => s.id === overdueShiftId)).toBe(true);
    });
  });

  // ── 4. Manager escalation idempotency ─────────────────────────────────────

  describe("Manager escalation idempotency — DB constraint", () => {
    it("allows only one cash_session_reminders row per (cash_session_id, reminder_type)", async () => {
      if (skipIfNoDb()) return;
      const app        = makeApp();
      const locationId = await setupOverdueLocation("Escalation Dedup Loc");
      await setupDrawer(locationId);

      const { sessionId } = await openAndMakeOverdue(app, locationId, USER_A);

      // Insert manager_escalation reminder for this session
      const first = await q(
        `INSERT INTO cash_session_reminders (workspace_id, cash_session_id, reminder_type)
         VALUES ($1, $2, 'manager_escalation')
         ON CONFLICT (cash_session_id, reminder_type) DO NOTHING`,
        [OWNER_ID, sessionId],
      );
      expect((first.rowCount ?? 0)).toBe(1); // inserted

      // Insert again — should be a no-op
      const second = await q(
        `INSERT INTO cash_session_reminders (workspace_id, cash_session_id, reminder_type)
         VALUES ($1, $2, 'manager_escalation')
         ON CONFLICT (cash_session_id, reminder_type) DO NOTHING`,
        [OWNER_ID, sessionId],
      );
      expect((second.rowCount ?? 0)).toBe(0); // conflicted, no new row

      // Exactly one row exists
      const count = await q<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt
           FROM cash_session_reminders
          WHERE cash_session_id = $1 AND reminder_type = 'manager_escalation'`,
        [sessionId],
      );
      expect(Number(count.rows[0].cnt)).toBe(1);
    });

    it("tracks different reminder types independently for the same session", async () => {
      if (skipIfNoDb()) return;
      const app        = makeApp();
      const locationId = await setupOverdueLocation("Multi-Type Reminder Loc");
      await setupDrawer(locationId);

      const { sessionId } = await openAndMakeOverdue(app, locationId, USER_A);

      for (const type of ["closing_time", "overdue", "manager_escalation", "long_open"] as const) {
        const r1 = await q(
          `INSERT INTO cash_session_reminders (workspace_id, cash_session_id, reminder_type)
           VALUES ($1, $2, $3)
           ON CONFLICT (cash_session_id, reminder_type) DO NOTHING`,
          [OWNER_ID, sessionId, type],
        );
        expect((r1.rowCount ?? 0)).toBe(1); // each type gets its own row

        // Duplicate for the same type is rejected
        const r2 = await q(
          `INSERT INTO cash_session_reminders (workspace_id, cash_session_id, reminder_type)
           VALUES ($1, $2, $3)
           ON CONFLICT (cash_session_id, reminder_type) DO NOTHING`,
          [OWNER_ID, sessionId, type],
        );
        expect((r2.rowCount ?? 0)).toBe(0);
      }

      // Total: exactly 4 rows (one per type)
      const count = await q<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt FROM cash_session_reminders WHERE cash_session_id = $1`,
        [sessionId],
      );
      expect(Number(count.rows[0].cnt)).toBe(4);
    });
  });
});
