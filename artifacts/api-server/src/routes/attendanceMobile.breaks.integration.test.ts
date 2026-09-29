/**
 * Integration test: break start / end attendance flow.
 *
 * Exercises POST /attendance/start-break and POST /attendance/end-break against
 * a real database to verify:
 *
 *   1. Starting a break when an open session exists — attendance_breaks row
 *      is created with break_end_at = NULL.
 *
 *   2. Duplicate active-break guard — attempting to start a second break while
 *      one is already open returns 409.
 *
 *   3. Ending a break — break_end_at is populated on the correct row.
 *
 *   4. End-break with no active break — returns 404.
 *
 *   5. Start-break with no open session — returns 404.
 *
 *   6. Auto-close of an active break when clocking out — the break row's
 *      break_end_at is set, and the session transitions to 'completed'.
 *
 * Auth and workspace middleware are mocked.  The real database pool is used
 * for all SQL.
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

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;

// ─────────────────────────────────────────────────────────────────────────────
// Stable test-scope identifiers — chosen to avoid collisions with real data.
// ─────────────────────────────────────────────────────────────────────────────

const OWNER_ID = "__att_breaks_integ__";
const USER_ID  = "__att_breaks_user__";

// ─────────────────────────────────────────────────────────────────────────────
// Mocks — only auth / workspace / logger.  db uses the real module.
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
    wreq.workspaceOwnerId    = OWNER_ID;
    wreq.workspaceRole       = "owner";
    wreq.workspaceActualRole = "owner";
    wreq.userId    = USER_ID;
    wreq.userEmail = "att-breaks-test@example.com";
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

// Silence SSE broadcast — not under test here.
vi.mock("../lib/attendanceSse", () => ({
  broadcastAttendanceRequest: vi.fn(),
}));

// Silence Expo push notifications — not under test here.
vi.mock("../lib/expoPush", () => ({
  sendExpoPushNotification: vi.fn(),
}));

// Imports MUST follow vi.mock declarations (hoisting boundary).
import attendanceMobileRouter from "./attendanceMobile";

// ─────────────────────────────────────────────────────────────────────────────
// App factory
// ─────────────────────────────────────────────────────────────────────────────

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(attendanceMobileRouter);
  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
// Database cleanup — removes all rows created under OWNER_ID.
// ─────────────────────────────────────────────────────────────────────────────

async function cleanup(pool: InstanceType<typeof Pool>): Promise<void> {
  // Breaks reference sessions which reference team_members; delete in order.
  await pool.query(
    `DELETE FROM attendance_audit_logs WHERE workspace_owner_id = $1`,
    [OWNER_ID],
  );
  await pool.query(
    `DELETE FROM attendance_breaks
       WHERE attendance_session_id IN (
         SELECT id FROM attendance_sessions WHERE workspace_owner_id = $1
       )`,
    [OWNER_ID],
  );
  await pool.query(
    `DELETE FROM attendance_sessions WHERE workspace_owner_id = $1`,
    [OWNER_ID],
  );
  await pool.query(
    `DELETE FROM team_member_profiles WHERE workspace_owner_id = $1`,
    [OWNER_ID],
  );
  await pool.query(
    `DELETE FROM team_members WHERE workspace_owner_id = $1`,
    [OWNER_ID],
  );
  await pool.query(
    `DELETE FROM workspace_members WHERE workspace_owner_id = $1`,
    [OWNER_ID],
  );
  await pool.query(
    `DELETE FROM locations WHERE workspace_owner_id = $1`,
    [OWNER_ID],
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Seed helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Insert a workspace_members row and return its id. */
async function seedWorkspaceMember(
  pool: InstanceType<typeof Pool>,
): Promise<number> {
  const r = await pool.query<{ id: number }>(
    `INSERT INTO workspace_members
       (workspace_owner_id, member_user_id, member_email, role)
     VALUES ($1, $2, 'att-breaks-test@example.com', 'member')
     RETURNING id`,
    [OWNER_ID, USER_ID],
  );
  return r.rows[0].id;
}

/** Insert a team_members row and return its id. */
async function seedTeamMember(
  pool: InstanceType<typeof Pool>,
  memberDbId: number,
): Promise<number> {
  const r = await pool.query<{ id: number }>(
    `INSERT INTO team_members
       (workspace_owner_id, member_db_id, first_name)
     VALUES ($1, $2, 'BreaksTest')
     RETURNING id`,
    [OWNER_ID, memberDbId],
  );
  return r.rows[0].id;
}

/** Insert a team_member_profiles row. */
async function seedProfile(
  pool: InstanceType<typeof Pool>,
  teamMemberId: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO team_member_profiles
       (workspace_owner_id, team_member_id, employment_type, status, allowed_remote_clock_in)
     VALUES ($1, $2, 'full_time', 'active', false)`,
    [OWNER_ID, teamMemberId],
  );
}

/** Insert an open attendance_session. Returns the session id. */
async function seedOpenSession(
  pool: InstanceType<typeof Pool>,
  employeeId: number,
): Promise<number> {
  const r = await pool.query<{ id: number }>(
    `INSERT INTO attendance_sessions
       (workspace_owner_id, employee_id, clock_in_at,
        clock_in_verification_status, status)
     VALUES ($1, $2, NOW(), 'no_location', 'open')
     RETURNING id`,
    [OWNER_ID, employeeId],
  );
  return r.rows[0].id;
}

/** Insert an active (open) attendance_break. Returns the break id. */
async function seedActiveBreak(
  pool: InstanceType<typeof Pool>,
  sessionId: number,
  employeeId: number,
): Promise<number> {
  const r = await pool.query<{ id: number }>(
    `INSERT INTO attendance_breaks
       (attendance_session_id, employee_id, break_start_at, break_type)
     VALUES ($1, $2, NOW(), 'other')
     RETURNING id`,
    [sessionId, employeeId],
  );
  return r.rows[0].id;
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!DATABASE_URL)(
  "POST /attendance/start-break and /attendance/end-break — break lifecycle (integration)",
  () => {
    let pool: InstanceType<typeof Pool>;
    let app: express.Express;

    // Shared employee IDs — re-resolved in each test after cleanup+re-seed.
    let tmId = 0;

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL });
      await cleanup(pool);
      app = makeApp();
    });

    afterAll(async () => {
      if (!pool) return;
      await cleanup(pool);
      await pool.end();
    });

    beforeEach(async () => {
      // Each test starts from a clean slate so they are order-independent.
      await cleanup(pool);

      // Seed the base rows every test needs.
      const wmId = await seedWorkspaceMember(pool);
      tmId = await seedTeamMember(pool, wmId);
      await seedProfile(pool, tmId);
    });

    // ── 1. Start a break when an open session exists ──────────────────────────

    it(
      "start-break when an open session exists — creates attendance_breaks row " +
      "with break_end_at = NULL",
      async () => {
        const sessionId = await seedOpenSession(pool, tmId);

        const res = await request(app)
          .post("/attendance/start-break")
          .send({ break_type: "lunch", note: "Lunch break" });

        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.break).toBeDefined();
        expect(res.body.break.attendance_session_id).toBe(sessionId);
        expect(res.body.break.employee_id).toBe(tmId);
        expect(res.body.break.break_type).toBe("lunch");
        expect(res.body.break.break_end_at).toBeNull();

        // Verify the row is really in the DB.
        const dbRow = await pool.query<{
          attendance_session_id: number;
          break_end_at: string | null;
          break_type: string;
        }>(
          `SELECT attendance_session_id, break_end_at, break_type
             FROM attendance_breaks
            WHERE attendance_session_id = $1`,
          [sessionId],
        );
        expect(dbRow.rows).toHaveLength(1);
        expect(dbRow.rows[0].break_end_at).toBeNull();
        expect(dbRow.rows[0].break_type).toBe("lunch");
      },
    );

    // ── 2. Duplicate active-break guard (409) ─────────────────────────────────

    it(
      "start-break when a break is already active — returns 409 and does not " +
      "create a second break row",
      async () => {
        const sessionId = await seedOpenSession(pool, tmId);
        await seedActiveBreak(pool, sessionId, tmId);

        const res = await request(app)
          .post("/attendance/start-break")
          .send({});

        expect(res.status).toBe(409);
        expect(res.body.error).toMatch(/break is already active/i);

        // Confirm still only one break row.
        const countResult = await pool.query<{ cnt: string }>(
          `SELECT COUNT(*) AS cnt FROM attendance_breaks
            WHERE attendance_session_id = $1`,
          [sessionId],
        );
        expect(Number(countResult.rows[0].cnt)).toBe(1);
      },
    );

    // ── 3. End a break — break_end_at is populated ────────────────────────────

    it(
      "end-break when an active break exists — sets break_end_at and returns " +
      "the updated break row",
      async () => {
        const sessionId = await seedOpenSession(pool, tmId);
        const breakId = await seedActiveBreak(pool, sessionId, tmId);

        const res = await request(app)
          .post("/attendance/end-break")
          .send({});

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.break).toBeDefined();
        expect(res.body.break.id).toBe(breakId);
        expect(res.body.break.break_end_at).not.toBeNull();

        // Confirm the DB row was updated.
        const dbRow = await pool.query<{ break_end_at: string | null }>(
          `SELECT break_end_at FROM attendance_breaks WHERE id = $1`,
          [breakId],
        );
        expect(dbRow.rows).toHaveLength(1);
        expect(dbRow.rows[0].break_end_at).not.toBeNull();
      },
    );

    // ── 4. End-break with no active break → 404 ───────────────────────────────

    it(
      "end-break when no active break exists — returns 404",
      async () => {
        // Open session but no break rows.
        await seedOpenSession(pool, tmId);

        const res = await request(app)
          .post("/attendance/end-break")
          .send({});

        expect(res.status).toBe(404);
        expect(res.body.error).toMatch(/no active break/i);
      },
    );

    // ── 5. Start-break with no open session → 404 ─────────────────────────────

    it(
      "start-break when there is no open session — returns 404",
      async () => {
        // No session seeded — employee has no open session.
        const res = await request(app)
          .post("/attendance/start-break")
          .send({});

        expect(res.status).toBe(404);
        expect(res.body.error).toMatch(/no open session/i);
      },
    );

    // ── 6. Auto-close active break on clock-out ───────────────────────────────

    it(
      "clock-out while a break is active — auto-closes the break and transitions " +
      "session to 'completed'",
      async () => {
        const sessionId = await seedOpenSession(pool, tmId);
        const breakId = await seedActiveBreak(pool, sessionId, tmId);

        // Verify break is open before clock-out.
        const beforeBreak = await pool.query<{ break_end_at: string | null }>(
          `SELECT break_end_at FROM attendance_breaks WHERE id = $1`,
          [breakId],
        );
        expect(beforeBreak.rows[0].break_end_at).toBeNull();

        const res = await request(app)
          .post("/attendance/clock-out")
          .send({});

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.session.status).toBe("completed");

        // The break row must now have break_end_at set.
        const afterBreak = await pool.query<{
          break_end_at: string | null;
          note: string | null;
        }>(
          `SELECT break_end_at, note FROM attendance_breaks WHERE id = $1`,
          [breakId],
        );
        expect(afterBreak.rows).toHaveLength(1);
        expect(afterBreak.rows[0].break_end_at).not.toBeNull();
        expect(afterBreak.rows[0].note).toMatch(/auto-closed/i);

        // Session must be closed.
        const sessionRow = await pool.query<{ status: string }>(
          `SELECT status FROM attendance_sessions WHERE id = $1`,
          [sessionId],
        );
        expect(sessionRow.rows[0].status).toBe("completed");
      },
    );
  },
);
