/**
 * Integration test: admin timesheet session-edit endpoints.
 *
 * Exercises PATCH /admin/attendance/sessions/:id against a real database to
 * verify:
 *
 *   1. Returns 404 when the session does not exist.
 *
 *   2. Returns 409 when the session is locked.
 *
 *   3. Updating clock_in_at — the new timestamp persists in the DB.
 *
 *   4. Updating clock_out_at — the new timestamp persists in the DB.
 *
 *   5. Updating clock_in_at when a work schedule is linked — all derived
 *      minute fields (gross_minutes, paid_minutes, late_minutes,
 *      early_leave_minutes, overtime_minutes) are recalculated and
 *      persisted correctly.
 *
 * Auth and workspace middleware are mocked as owner.  The real database pool
 * is used for all SQL.
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

const OWNER_ID = "__att_admin_sessions_integ__";
const USER_ID  = "__att_admin_sessions_user__";

// ─────────────────────────────────────────────────────────────────────────────
// Mocks — only auth / workspace / logger / side-effect libs.
// db uses the real module.
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
    wreq.userEmail = "att-admin-sessions-test@example.com";
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

vi.mock("../lib/attendanceSse", () => ({
  broadcastAttendanceRequest: vi.fn(),
  subscribeAttendance: vi.fn(),
}));

vi.mock("../lib/expoPush", () => ({
  sendExpoPushNotification: vi.fn(),
}));

// Imports MUST follow vi.mock declarations (hoisting boundary).
import attendanceAdminRouter from "./attendanceAdmin";

// ─────────────────────────────────────────────────────────────────────────────
// App factory
// ─────────────────────────────────────────────────────────────────────────────

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(attendanceAdminRouter);
  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixed timestamps used across tests.
//
// 2025-01-06 is a Monday, which lets us seed a work_schedule_days entry for
// 'monday' and get deterministic schedule lookups regardless of the real date.
// ─────────────────────────────────────────────────────────────────────────────

const CLOCK_IN_BASE  = "2025-01-06T09:30:00.000Z"; // 30 min after schedule start
const CLOCK_OUT_BASE = "2025-01-06T17:00:00.000Z"; // exactly at schedule end

// ─────────────────────────────────────────────────────────────────────────────
// Database cleanup — removes all rows created under OWNER_ID.
// ─────────────────────────────────────────────────────────────────────────────

async function cleanup(pool: InstanceType<typeof Pool>): Promise<void> {
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
    `DELETE FROM work_schedules WHERE workspace_owner_id = $1`,
    [OWNER_ID],
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Seed helpers
// ─────────────────────────────────────────────────────────────────────────────

async function seedWorkspaceMember(
  pool: InstanceType<typeof Pool>,
): Promise<number> {
  const r = await pool.query<{ id: number }>(
    `INSERT INTO workspace_members
       (workspace_owner_id, member_user_id, member_email, role)
     VALUES ($1, $2, 'att-admin-sessions-test@example.com', 'member')
     RETURNING id`,
    [OWNER_ID, USER_ID],
  );
  return r.rows[0].id;
}

async function seedTeamMember(
  pool: InstanceType<typeof Pool>,
  memberDbId: number,
): Promise<number> {
  const r = await pool.query<{ id: number }>(
    `INSERT INTO team_members
       (workspace_owner_id, member_db_id, first_name)
     VALUES ($1, $2, 'SessionEditTest')
     RETURNING id`,
    [OWNER_ID, memberDbId],
  );
  return r.rows[0].id;
}

async function seedProfile(
  pool: InstanceType<typeof Pool>,
  teamMemberId: number,
  workScheduleId: number | null = null,
): Promise<void> {
  await pool.query(
    `INSERT INTO team_member_profiles
       (workspace_owner_id, team_member_id, work_schedule_id, employment_type, status, allowed_remote_clock_in)
     VALUES ($1, $2, $3, 'full_time', 'active', false)`,
    [OWNER_ID, teamMemberId, workScheduleId],
  );
}

/**
 * Seed a work_schedule + a work_schedule_days entry for Monday (the day of
 * CLOCK_IN_BASE = 2025-01-06).  Returns the schedule id.
 */
async function seedMondaySchedule(
  pool: InstanceType<typeof Pool>,
  opts: { startTime: string; endTime: string; breakMinutes: number },
): Promise<number> {
  const sched = await pool.query<{ id: number }>(
    `INSERT INTO work_schedules (workspace_owner_id, name, status)
     VALUES ($1, 'Admin Test Schedule', 'active')
     RETURNING id`,
    [OWNER_ID],
  );
  const scheduleId = sched.rows[0].id;

  await pool.query(
    `INSERT INTO work_schedule_days
       (schedule_id, day_of_week, is_working_day, start_time, end_time, break_minutes)
     VALUES ($1, 'monday', true, $2::time, $3::time, $4)`,
    [scheduleId, opts.startTime, opts.endTime, opts.breakMinutes],
  );
  return scheduleId;
}

/**
 * Seed a completed attendance_session.  Returns the session id.
 */
async function seedCompletedSession(
  pool: InstanceType<typeof Pool>,
  employeeId: number,
  opts: {
    clockInAt?: string;
    clockOutAt?: string;
    breakMinutes?: number;
    status?: string;
  } = {},
): Promise<number> {
  const r = await pool.query<{ id: number }>(
    `INSERT INTO attendance_sessions
       (workspace_owner_id, employee_id, clock_in_at, clock_out_at,
        clock_in_verification_status, status, break_minutes)
     VALUES ($1, $2, $3, $4, 'no_location', $5, $6)
     RETURNING id`,
    [
      OWNER_ID,
      employeeId,
      opts.clockInAt  ?? CLOCK_IN_BASE,
      opts.clockOutAt ?? CLOCK_OUT_BASE,
      opts.status     ?? "completed",
      opts.breakMinutes ?? 0,
    ],
  );
  return r.rows[0].id;
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!DATABASE_URL)(
  "PATCH /admin/attendance/sessions/:id — timesheet session edit (integration)",
  () => {
    let pool: InstanceType<typeof Pool>;
    let app: express.Express;
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
      await cleanup(pool);
      const wmId = await seedWorkspaceMember(pool);
      tmId = await seedTeamMember(pool, wmId);
      await seedProfile(pool, tmId);
    });

    // ── 1. Session not found → 404 ────────────────────────────────────────────

    it("returns 404 when the session does not exist", async () => {
      const res = await request(app)
        .patch("/admin/attendance/sessions/999999999")
        .send({ manager_note: "test" });

      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/not found/i);
    });

    // ── 2. Locked session → 409 ───────────────────────────────────────────────

    it("returns 409 when the session is locked", async () => {
      const sessionId = await seedCompletedSession(pool, tmId, { status: "locked" });

      const res = await request(app)
        .patch(`/admin/attendance/sessions/${sessionId}`)
        .send({ manager_note: "should be blocked" });

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/locked/i);
    });

    // ── 3. Update clock_in_at — value persists in DB ──────────────────────────

    it(
      "updating clock_in_at — the new timestamp is persisted in the DB and " +
      "returned in the response",
      async () => {
        const sessionId = await seedCompletedSession(pool, tmId);

        const newClockIn = "2025-01-06T08:45:00.000Z";

        const res = await request(app)
          .patch(`/admin/attendance/sessions/${sessionId}`)
          .send({ clock_in_at: newClockIn });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.session).toBeDefined();

        // Verify the DB row was updated.
        const dbRow = await pool.query<{ clock_in_at: string }>(
          `SELECT clock_in_at FROM attendance_sessions WHERE id = $1`,
          [sessionId],
        );
        expect(dbRow.rows).toHaveLength(1);
        const storedTs = new Date(dbRow.rows[0].clock_in_at).toISOString();
        expect(storedTs).toBe(newClockIn);
      },
    );

    // ── 4. Update clock_out_at — value persists in DB ─────────────────────────

    it(
      "updating clock_out_at — the new timestamp is persisted in the DB and " +
      "returned in the response",
      async () => {
        const sessionId = await seedCompletedSession(pool, tmId);

        const newClockOut = "2025-01-06T18:00:00.000Z";

        const res = await request(app)
          .patch(`/admin/attendance/sessions/${sessionId}`)
          .send({ clock_out_at: newClockOut });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        const dbRow = await pool.query<{ clock_out_at: string }>(
          `SELECT clock_out_at FROM attendance_sessions WHERE id = $1`,
          [sessionId],
        );
        expect(dbRow.rows).toHaveLength(1);
        const storedTs = new Date(dbRow.rows[0].clock_out_at).toISOString();
        expect(storedTs).toBe(newClockOut);
      },
    );

    // ── 5. Minute recalculation with schedule ─────────────────────────────────
    //
    // Schedule: Monday 09:00–17:00, 30 min scheduled break.
    //
    // Initial session state (seeded directly — no prior calculation):
    //   clock_in_at  = 2025-01-06T09:30Z  (30 min late)
    //   clock_out_at = 2025-01-06T17:00Z  (on time)
    //   break_minutes = 0
    //
    // PATCH sets clock_in_at = 2025-01-06T08:00Z (1 h early).
    //
    // Expected recalculation:
    //   gross_minutes       = (17:00 − 08:00)           = 540
    //   paid_minutes        = 540 − 0 (break)           = 540
    //   late_minutes        = 0  (arrived before sched)
    //   early_leave_minutes = 0  (clocked out at sched end)
    //   overtime_minutes    = 540 − (480 − 30) = 90     (paid > schedPaid)

    it(
      "updating clock_in_at with a schedule linked — all derived minute fields " +
      "are recalculated and persisted correctly in the DB",
      async () => {
        // Attach a Monday schedule to the employee.
        const scheduleId = await seedMondaySchedule(pool, {
          startTime:   "09:00",
          endTime:     "17:00",
          breakMinutes: 30,
        });

        // Re-seed the profile with the schedule linked.
        await pool.query(
          `DELETE FROM team_member_profiles WHERE workspace_owner_id = $1`,
          [OWNER_ID],
        );
        await seedProfile(pool, tmId, scheduleId);

        const sessionId = await seedCompletedSession(pool, tmId, {
          clockInAt:    CLOCK_IN_BASE,   // 09:30
          clockOutAt:   CLOCK_OUT_BASE,  // 17:00
          breakMinutes: 0,
        });

        const newClockIn = "2025-01-06T08:00:00.000Z";

        const res = await request(app)
          .patch(`/admin/attendance/sessions/${sessionId}`)
          .send({ clock_in_at: newClockIn });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        // Read the updated row directly from the DB.
        const dbRow = await pool.query<{
          clock_in_at:        string;
          gross_minutes:      number | null;
          paid_minutes:       number | null;
          late_minutes:       number;
          early_leave_minutes: number;
          overtime_minutes:   number;
        }>(
          `SELECT clock_in_at, gross_minutes, paid_minutes,
                  late_minutes, early_leave_minutes, overtime_minutes
             FROM attendance_sessions
            WHERE id = $1`,
          [sessionId],
        );
        expect(dbRow.rows).toHaveLength(1);
        const row = dbRow.rows[0];

        // clock_in_at must reflect the PATCH value.
        expect(new Date(row.clock_in_at).toISOString()).toBe(newClockIn);

        // Derived minute fields must reflect recalculation.
        expect(row.gross_minutes).toBe(540);
        expect(row.paid_minutes).toBe(540);
        expect(row.late_minutes).toBe(0);
        expect(row.early_leave_minutes).toBe(0);
        expect(row.overtime_minutes).toBe(90);
      },
    );

    // ── 6. clock_out_at edit with schedule — gross and paid recalculated ──────
    //
    // PATCH sets clock_out_at = 2025-01-06T16:00Z (1 h early leave).
    //
    // Expected recalculation (clock_in stays at 09:30):
    //   gross_minutes       = (16:00 − 09:30)           = 390
    //   paid_minutes        = 390 − 0 (break)           = 390
    //   late_minutes        = 30  (arrived 30 min after sched start, > 5 grace)
    //   early_leave_minutes = 60  (clocked out 1 h before sched end)
    //   overtime_minutes    = 0   (paid < schedPaid)

    it(
      "updating clock_out_at with a schedule linked — early_leave_minutes and " +
      "gross_minutes are recalculated and persisted correctly in the DB",
      async () => {
        const scheduleId = await seedMondaySchedule(pool, {
          startTime:   "09:00",
          endTime:     "17:00",
          breakMinutes: 0,
        });

        await pool.query(
          `DELETE FROM team_member_profiles WHERE workspace_owner_id = $1`,
          [OWNER_ID],
        );
        await seedProfile(pool, tmId, scheduleId);

        const sessionId = await seedCompletedSession(pool, tmId, {
          clockInAt:    CLOCK_IN_BASE,   // 09:30
          clockOutAt:   CLOCK_OUT_BASE,  // 17:00
          breakMinutes: 0,
        });

        const newClockOut = "2025-01-06T16:00:00.000Z";

        const res = await request(app)
          .patch(`/admin/attendance/sessions/${sessionId}`)
          .send({ clock_out_at: newClockOut });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        const dbRow = await pool.query<{
          clock_out_at:       string;
          gross_minutes:      number | null;
          paid_minutes:       number | null;
          late_minutes:       number;
          early_leave_minutes: number;
          overtime_minutes:   number;
        }>(
          `SELECT clock_out_at, gross_minutes, paid_minutes,
                  late_minutes, early_leave_minutes, overtime_minutes
             FROM attendance_sessions
            WHERE id = $1`,
          [sessionId],
        );
        expect(dbRow.rows).toHaveLength(1);
        const row = dbRow.rows[0];

        expect(new Date(row.clock_out_at).toISOString()).toBe(newClockOut);
        expect(row.gross_minutes).toBe(390);
        expect(row.paid_minutes).toBe(390);
        expect(row.late_minutes).toBe(30);
        expect(row.early_leave_minutes).toBe(60);
        expect(row.overtime_minutes).toBe(0);
      },
    );

    // ── 7. Audit log entry is created on successful edit ──────────────────────

    it(
      "a successful PATCH creates a session_manual_edit audit log entry",
      async () => {
        const sessionId = await seedCompletedSession(pool, tmId);

        await request(app)
          .patch(`/admin/attendance/sessions/${sessionId}`)
          .send({ manager_note: "Corrected by admin" });

        const auditRow = await pool.query<{ action: string }>(
          `SELECT action FROM attendance_audit_logs
            WHERE workspace_owner_id = $1
              AND attendance_session_id = $2`,
          [OWNER_ID, sessionId],
        );
        expect(auditRow.rows.length).toBeGreaterThanOrEqual(1);
        expect(auditRow.rows[0].action).toBe("session_manual_edit");
      },
    );
  },
);
