/**
 * Integration test: attendance guard paths.
 *
 * Covers three real-world error / edge-case paths that have no integration
 * coverage elsewhere:
 *
 *   1. POST /attendance/clock-in returns 409 when an open session already
 *      exists for the employee.
 *
 *   2. POST /attendance/clock-out auto-closes an active break and counts
 *      its elapsed minutes in break_minutes.
 *
 *   3. POST /attendance/clock-out returns 404 when there is no open session.
 *
 * Auth and workspace middleware are mocked.  The real database pool is used
 * for all SQL.
 *
 * Skips automatically when DATABASE_URL is not set.
 *
 * Run via:
 *   pnpm --filter @workspace/api-server run test:integration:local
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import pg from "pg";
import type { WorkspaceRequest } from "../lib/workspace";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;

// ─────────────────────────────────────────────────────────────────────────────
// Stable test-scope identifiers — chosen to avoid collisions with real data.
// ─────────────────────────────────────────────────────────────────────────────

const OWNER_ID = "__att_guards_integ_owner__";
const USER_ID  = "__att_guards_integ_user__";

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
    wreq.userEmail = "att-guards-test@example.com";
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
// Time helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build an ISO timestamp string for the real today's date at the given HH:MM
 * (treated as UTC, consistent with how the route stores all timestamps).
 */
function todayAtUtc(hhmm: string): string {
  const todayDate = new Date().toISOString().slice(0, 10);
  return `${todayDate}T${hhmm}:00.000Z`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Database cleanup — removes all rows created under OWNER_ID.
// ─────────────────────────────────────────────────────────────────────────────

async function cleanup(pool: InstanceType<typeof Pool>): Promise<void> {
  await pool.query(
    `DELETE FROM attendance_audit_logs WHERE workspace_owner_id = $1`,
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
    `DELETE FROM work_schedules WHERE workspace_owner_id = $1`,
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
async function seedWorkspaceMember(pool: InstanceType<typeof Pool>): Promise<number> {
  const r = await pool.query<{ id: number }>(
    `INSERT INTO workspace_members
       (workspace_owner_id, member_user_id, member_email, role)
     VALUES ($1, $2, 'att-guards-test@example.com', 'member')
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
     VALUES ($1, $2, 'GuardsTest')
     RETURNING id`,
    [OWNER_ID, memberDbId],
  );
  return r.rows[0].id;
}

/** Insert a team_member_profiles row (no schedule needed for guard tests). */
async function seedProfile(
  pool: InstanceType<typeof Pool>,
  teamMemberId: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO team_member_profiles
       (workspace_owner_id, team_member_id, employment_type, status)
     VALUES ($1, $2, 'full_time', 'active')`,
    [OWNER_ID, teamMemberId],
  );
}

/**
 * Insert an open attendance_session with a controlled clock_in_at timestamp.
 * Returns the session id.
 */
async function seedOpenSession(
  pool: InstanceType<typeof Pool>,
  employeeId: number,
  clockInAt: string,
): Promise<number> {
  const r = await pool.query<{ id: number }>(
    `INSERT INTO attendance_sessions
       (workspace_owner_id, employee_id, clock_in_at,
        clock_in_verification_status, status)
     VALUES ($1, $2, $3, 'no_location', 'open')
     RETURNING id`,
    [OWNER_ID, employeeId, clockInAt],
  );
  return r.rows[0].id;
}

/**
 * Insert an open (no break_end_at) attendance_break for a session.
 */
async function seedOpenBreak(
  pool: InstanceType<typeof Pool>,
  sessionId: number,
  employeeId: number,
  breakStartAt: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO attendance_breaks
       (attendance_session_id, employee_id, break_start_at, break_type)
     VALUES ($1, $2, $3, 'rest')`,
    [sessionId, employeeId, breakStartAt],
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!DATABASE_URL)(
  "attendance mobile guard paths (integration)",
  () => {
    let pool: InstanceType<typeof Pool>;
    let app: express.Express;

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
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    // ── Guard 1: duplicate clock-in ─────────────────────────────────────────

    it(
      "POST /attendance/clock-in returns 409 when an open session already exists",
      async () => {
        const wmId = await seedWorkspaceMember(pool);
        const tmId = await seedTeamMember(pool, wmId);
        await seedProfile(pool, tmId);

        // Pre-seed an open session so the guard fires.
        await seedOpenSession(pool, tmId, todayAtUtc("09:00"));

        const res = await request(app)
          .post("/attendance/clock-in")
          .send({});

        expect(res.status).toBe(409);
        expect(res.body.error).toMatch(/open session already exists/i);

        // Confirm no second session was inserted.
        const count = await pool.query<{ cnt: string }>(
          `SELECT COUNT(*) AS cnt
             FROM attendance_sessions
            WHERE workspace_owner_id = $1`,
          [OWNER_ID],
        );
        expect(Number(count.rows[0].cnt)).toBe(1);
      },
    );

    // ── Guard 2: auto-close active break on clock-out ───────────────────────

    it(
      "POST /attendance/clock-out auto-closes an active break and reflects its minutes in break_minutes",
      async () => {
        // Clock in at 08:00. Start a break at 12:00 (no end yet).
        // Clock out at 13:00 — the break should be auto-closed at 13:00,
        // contributing 60 min to break_minutes.
        //
        // Expected:
        //   grossMinutes = (13:00 - 08:00) = 300
        //   breakMinutes = 60  (auto-closed at clock-out time)
        //   paidMinutes  = 240

        const wmId = await seedWorkspaceMember(pool);
        const tmId = await seedTeamMember(pool, wmId);
        await seedProfile(pool, tmId);

        const clockInAt = todayAtUtc("08:00");
        const sessionId = await seedOpenSession(pool, tmId, clockInAt);

        // Seed an open break starting at 12:00.
        await seedOpenBreak(pool, sessionId, tmId, todayAtUtc("12:00"));

        const clockOutAt = todayAtUtc("13:00");
        vi.useFakeTimers();
        vi.setSystemTime(new Date(clockOutAt));

        const res = await request(app)
          .post("/attendance/clock-out")
          .send({});

        vi.useRealTimers();

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        const s = res.body.session;
        expect(s.status).toBe("completed");
        expect(s.gross_minutes).toBe(300);
        expect(s.break_minutes).toBe(60);
        expect(s.paid_minutes).toBe(240);

        // Verify the break was closed in the database.
        const breakRow = await pool.query<{ break_end_at: string; note: string }>(
          `SELECT break_end_at, note
             FROM attendance_breaks
            WHERE attendance_session_id = $1`,
          [sessionId],
        );
        expect(breakRow.rows).toHaveLength(1);
        expect(breakRow.rows[0].break_end_at).not.toBeNull();
        expect(breakRow.rows[0].note).toBe("Auto-closed on clock-out");
      },
    );

    // ── Guard 3: clock-out with no open session ─────────────────────────────

    it(
      "POST /attendance/clock-out returns 404 when there is no open session",
      async () => {
        // Employee exists but has never clocked in (or already clocked out).
        const wmId = await seedWorkspaceMember(pool);
        const tmId = await seedTeamMember(pool, wmId);
        await seedProfile(pool, tmId);

        const res = await request(app)
          .post("/attendance/clock-out")
          .send({});

        expect(res.status).toBe(404);
        expect(res.body.error).toMatch(/no open session/i);
      },
    );
  },
);
