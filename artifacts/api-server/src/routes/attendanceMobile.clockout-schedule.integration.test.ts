/**
 * Integration test: clock-out with schedule flow.
 *
 * Exercises POST /attendance/clock-out against a real database using a
 * controlled clock-out timestamp (vi.setSystemTime) so that late_minutes,
 * early_leave_minutes, and overtime_minutes can be asserted exactly.
 *
 * Three schedule-resolution paths are covered independently:
 *
 *   1. Profile schedule — team_member_profiles.work_schedule_id is set.
 *      The route's COALESCE picks this profile-level schedule first.
 *
 *   2. Location fallback — the profile has no work_schedule_id, so the
 *      route falls back to locations.default_schedule_id for the session's
 *      assigned location.
 *
 *   3. Night-shift / cross-midnight — clock-in is on day N and clock-out is
 *      on day N+1.  The schedule lookup must use the clock-in date (not
 *      today's date) for the DOW lookup so that the correct schedule day is
 *      resolved regardless of when the employee actually clocks out.
 *
 * Auth and workspace middleware are mocked.  The real database pool is used
 * for all SQL.  Fake timers are activated only for the duration of each
 * clock-out HTTP call and restored immediately after to avoid interfering
 * with the pg connection pool's internal timers.
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

const OWNER_ID = "__att_clockout_sched_integ__";
const USER_ID  = "__att_clockout_sched_user__";

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
    wreq.workspaceOwnerId = OWNER_ID;
    wreq.workspaceRole    = "owner";
    wreq.workspaceActualRole = "owner";
    wreq.userId    = USER_ID;
    wreq.userEmail = "att-sched-test@example.com";
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
//
// IMPORTANT: these must be called BEFORE any vi.useFakeTimers() call so that
// they observe the real current date, which PostgreSQL also uses when
// evaluating timestamptz expressions.
// ─────────────────────────────────────────────────────────────────────────────

const DOW_NAMES = [
  "sunday", "monday", "tuesday", "wednesday",
  "thursday", "friday", "saturday",
] as const;

/** Real day-of-week string for today's UTC date. */
function realTodayDow(): string {
  return DOW_NAMES[new Date().getDay()];
}

/** Real day-of-week string for yesterday's UTC date. */
function realYesterdayDow(): string {
  const yesterday = new Date(Date.now() - 86_400_000);
  return DOW_NAMES[yesterday.getDay()];
}

/**
 * Build an ISO timestamp string for the real today's date at the given HH:MM
 * (treated as UTC, consistent with how the route stores all timestamps).
 */
function todayAtUtc(hhmm: string): string {
  const todayDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (real date)
  return `${todayDate}T${hhmm}:00.000Z`;
}

/**
 * Build an ISO timestamp string for yesterday's date at the given HH:MM (UTC).
 */
function yesterdayAtUtc(hhmm: string): string {
  const yesterdayDate = new Date(Date.now() - 86_400_000)
    .toISOString()
    .slice(0, 10);
  return `${yesterdayDate}T${hhmm}:00.000Z`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Database cleanup — removes all rows created under OWNER_ID.
// ─────────────────────────────────────────────────────────────────────────────

async function cleanup(pool: InstanceType<typeof Pool>): Promise<void> {
  // attendance_audit_logs → attendance_sessions → attendance_breaks (cascades)
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
  // work_schedule_days cascade when the parent work_schedule is deleted
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
     VALUES ($1, $2, 'att-sched-test@example.com', 'member')
     RETURNING id`,
    [OWNER_ID, USER_ID],
  );
  return r.rows[0].id;
}

/** Insert a team_members row and return its id. */
async function seedTeamMember(
  pool: InstanceType<typeof Pool>,
  memberDbId: number,
  opts: { locationId?: number | null } = {},
): Promise<number> {
  const r = await pool.query<{ id: number }>(
    `INSERT INTO team_members
       (workspace_owner_id, member_db_id, first_name, location_id)
     VALUES ($1, $2, 'AttTest', $3)
     RETURNING id`,
    [OWNER_ID, memberDbId, opts.locationId ?? null],
  );
  return r.rows[0].id;
}

/**
 * Insert a work_schedule + a work_schedule_days entry for the given
 * day-of-week (defaults to today's real day-of-week), then return the
 * schedule id.
 */
async function seedSchedule(
  pool: InstanceType<typeof Pool>,
  opts: { startTime: string; endTime: string; breakMinutes: number; dayOfWeek?: string },
): Promise<number> {
  const sched = await pool.query<{ id: number }>(
    `INSERT INTO work_schedules (workspace_owner_id, name, status)
     VALUES ($1, 'Test Schedule', 'active')
     RETURNING id`,
    [OWNER_ID],
  );
  const scheduleId = sched.rows[0].id;

  await pool.query(
    `INSERT INTO work_schedule_days
       (schedule_id, day_of_week, is_working_day, start_time, end_time, break_minutes)
     VALUES ($1, $2, true, $3::time, $4::time, $5)`,
    [scheduleId, opts.dayOfWeek ?? realTodayDow(), opts.startTime, opts.endTime, opts.breakMinutes],
  );
  return scheduleId;
}

/**
 * Insert a location; optionally set default_schedule_id.
 * Returns the location id.
 */
async function seedLocation(
  pool: InstanceType<typeof Pool>,
  defaultScheduleId: number | null = null,
): Promise<number> {
  const r = await pool.query<{ id: number }>(
    `INSERT INTO locations (workspace_owner_id, name, default_schedule_id)
     VALUES ($1, 'Test Location', $2)
     RETURNING id`,
    [OWNER_ID, defaultScheduleId],
  );
  return r.rows[0].id;
}

/**
 * Insert a team_member_profiles row; workScheduleId may be null for the
 * location-fallback path.
 */
async function seedProfile(
  pool: InstanceType<typeof Pool>,
  teamMemberId: number,
  workScheduleId: number | null = null,
): Promise<void> {
  await pool.query(
    `INSERT INTO team_member_profiles
       (workspace_owner_id, team_member_id, work_schedule_id, employment_type, status)
     VALUES ($1, $2, $3, 'full_time', 'active')`,
    [OWNER_ID, teamMemberId, workScheduleId],
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
  locationId: number | null = null,
): Promise<number> {
  const r = await pool.query<{ id: number }>(
    `INSERT INTO attendance_sessions
       (workspace_owner_id, employee_id, location_id, clock_in_at,
        clock_in_verification_status, status)
     VALUES ($1, $2, $3, $4, 'no_location', 'open')
     RETURNING id`,
    [OWNER_ID, employeeId, locationId, clockInAt],
  );
  return r.rows[0].id;
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!DATABASE_URL)(
  "POST /attendance/clock-out — schedule-based minute calculations (integration)",
  () => {
    let pool: InstanceType<typeof Pool>;
    let app: express.Express;

    // Compute the real today once so all helpers use the same date.
    const todayDow = realTodayDow();

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
      // Always restore real timers even if a test throws.
      vi.useRealTimers();
    });

    // ── Path 1: profile schedule ────────────────────────────────────────────

    it(
      "profile schedule — late arrival + early leave: " +
      "reports exact late_minutes and early_leave_minutes",
      async () => {
        // Schedule: 09:00–17:00 with 30 min scheduled break.
        // Clock in at 09:30 (30 min late, exceeds 5 min grace).
        // Clock out at 16:00 (60 min early leave).
        //
        // Expected:
        //   grossMinutes    = (16:00 - 09:30) = 390
        //   breakMinutes    = 0  (no breaks taken)
        //   paidMinutes     = 390
        //   lateMinutes     = 30
        //   earlyLeaveMinutes = 60
        //   overtimeMinutes = 0  (schedPaid = 480 - 30 = 450 > 390)

        const scheduleId = await seedSchedule(pool, {
          startTime: "09:00",
          endTime: "17:00",
          breakMinutes: 30,
        });

        const wmId = await seedWorkspaceMember(pool);
        const tmId = await seedTeamMember(pool, wmId);
        await seedProfile(pool, tmId, scheduleId);

        const clockInAt = todayAtUtc("09:30");
        await seedOpenSession(pool, tmId, clockInAt);

        const clockOutAt = todayAtUtc("16:00");
        vi.useFakeTimers();
        vi.setSystemTime(new Date(clockOutAt));

        const res = await request(app).post("/attendance/clock-out").send({});

        vi.useRealTimers();

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        const s = res.body.session;
        expect(s.status).toBe("completed");
        expect(s.gross_minutes).toBe(390);
        expect(s.break_minutes).toBe(0);
        expect(s.paid_minutes).toBe(390);
        expect(s.late_minutes).toBe(30);
        expect(s.early_leave_minutes).toBe(60);
        expect(s.overtime_minutes).toBe(0);

        // Verify the session was persisted correctly in the DB.
        const dbRow = await pool.query<{
          status: string;
          gross_minutes: number;
          paid_minutes: number;
          late_minutes: number;
          early_leave_minutes: number;
          overtime_minutes: number;
        }>(
          `SELECT status, gross_minutes, paid_minutes,
                  late_minutes, early_leave_minutes, overtime_minutes
             FROM attendance_sessions
            WHERE workspace_owner_id = $1 AND status = 'completed'
            LIMIT 1`,
          [OWNER_ID],
        );
        expect(dbRow.rows).toHaveLength(1);
        expect(dbRow.rows[0].gross_minutes).toBe(390);
        expect(dbRow.rows[0].late_minutes).toBe(30);
        expect(dbRow.rows[0].early_leave_minutes).toBe(60);
        expect(dbRow.rows[0].overtime_minutes).toBe(0);
      },
    );

    it(
      "profile schedule — on-time arrival + late departure: " +
      "reports exact overtime_minutes",
      async () => {
        // Schedule: 09:00–17:00 with 30 min scheduled break.
        // Clock in at 09:03 (within 5 min grace → lateMinutes = 0).
        // Clock out at 19:30 (150 min after schedule end).
        //
        // Expected:
        //   grossMinutes    = (19:30 - 09:03) = 627
        //   breakMinutes    = 0
        //   paidMinutes     = 627
        //   lateMinutes     = 0  (3 min ≤ LATE_GRACE_MINUTES = 5)
        //   earlyLeaveMinutes = 0
        //   overtimeMinutes = 627 - 450 = 177
        //                     (schedPaid = 480 min − 30 min break = 450)

        const scheduleId = await seedSchedule(pool, {
          startTime: "09:00",
          endTime: "17:00",
          breakMinutes: 30,
        });

        const wmId = await seedWorkspaceMember(pool);
        const tmId = await seedTeamMember(pool, wmId);
        await seedProfile(pool, tmId, scheduleId);

        const clockInAt = todayAtUtc("09:03");
        await seedOpenSession(pool, tmId, clockInAt);

        const clockOutAt = todayAtUtc("19:30");
        vi.useFakeTimers();
        vi.setSystemTime(new Date(clockOutAt));

        const res = await request(app).post("/attendance/clock-out").send({});

        vi.useRealTimers();

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        const s = res.body.session;
        expect(s.late_minutes).toBe(0);
        expect(s.early_leave_minutes).toBe(0);
        expect(s.overtime_minutes).toBe(177);
        expect(s.gross_minutes).toBe(627);
        expect(s.paid_minutes).toBe(627);
      },
    );

    it(
      "profile schedule — break time is deducted from paid_minutes " +
      "and affects overtime calculation",
      async () => {
        // Schedule: 08:00–16:00 with 0 min scheduled break.
        // Employee clocks in at 08:00 (on time).
        // Takes a 30 min break (seeded directly in the DB).
        // Clocks out at 17:00.
        //
        // Expected:
        //   grossMinutes    = (17:00 - 08:00) = 540
        //   breakMinutes    = 30
        //   paidMinutes     = 510
        //   lateMinutes     = 0
        //   earlyLeaveMinutes = 0
        //   overtimeMinutes = 510 - 480 = 30  (schedPaid = 480 − 0 = 480)

        const scheduleId = await seedSchedule(pool, {
          startTime: "08:00",
          endTime: "16:00",
          breakMinutes: 0,
        });

        const wmId = await seedWorkspaceMember(pool);
        const tmId = await seedTeamMember(pool, wmId);
        await seedProfile(pool, tmId, scheduleId);

        const clockInAt = todayAtUtc("08:00");
        const sessionId = await seedOpenSession(pool, tmId, clockInAt);

        // Seed a completed 30 min break within the session.
        await pool.query(
          `INSERT INTO attendance_breaks
             (attendance_session_id, employee_id, break_start_at, break_end_at, break_type)
           VALUES ($1, $2, $3, $4, 'lunch')`,
          [
            sessionId,
            tmId,
            todayAtUtc("12:00"),
            todayAtUtc("12:30"),
          ],
        );

        const clockOutAt = todayAtUtc("17:00");
        vi.useFakeTimers();
        vi.setSystemTime(new Date(clockOutAt));

        const res = await request(app).post("/attendance/clock-out").send({});

        vi.useRealTimers();

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        const s = res.body.session;
        expect(s.gross_minutes).toBe(540);
        expect(s.break_minutes).toBe(30);
        expect(s.paid_minutes).toBe(510);
        expect(s.late_minutes).toBe(0);
        expect(s.early_leave_minutes).toBe(0);
        expect(s.overtime_minutes).toBe(30);
      },
    );

    // ── Path 2: location fallback schedule ─────────────────────────────────

    it(
      `location fallback (${todayDow}) — no profile schedule: ` +
      "uses location's default_schedule_id and reports exact overtime_minutes",
      async () => {
        // Location's default schedule: 08:00–16:00 with 0 min break.
        // Profile has NO work_schedule_id (fallback path).
        // Clock in at 08:00 (on time).
        // Clock out at 17:00 (60 min overtime).
        //
        // Expected:
        //   grossMinutes    = 540
        //   breakMinutes    = 0
        //   paidMinutes     = 540
        //   lateMinutes     = 0
        //   earlyLeaveMinutes = 0
        //   overtimeMinutes = 540 - 480 = 60

        const scheduleId = await seedSchedule(pool, {
          startTime: "08:00",
          endTime: "16:00",
          breakMinutes: 0,
        });
        const locationId = await seedLocation(pool, scheduleId);

        const wmId = await seedWorkspaceMember(pool);
        const tmId = await seedTeamMember(pool, wmId, { locationId });
        // Profile explicitly has no work_schedule_id → triggers location fallback.
        await seedProfile(pool, tmId, null);

        const clockInAt = todayAtUtc("08:00");
        // Session carries the location_id so the route can JOIN locations.
        await seedOpenSession(pool, tmId, clockInAt, locationId);

        const clockOutAt = todayAtUtc("17:00");
        vi.useFakeTimers();
        vi.setSystemTime(new Date(clockOutAt));

        const res = await request(app).post("/attendance/clock-out").send({});

        vi.useRealTimers();

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        const s = res.body.session;
        expect(s.gross_minutes).toBe(540);
        expect(s.break_minutes).toBe(0);
        expect(s.paid_minutes).toBe(540);
        expect(s.late_minutes).toBe(0);
        expect(s.early_leave_minutes).toBe(0);
        expect(s.overtime_minutes).toBe(60);

        // Confirm the persisted row matches.
        const dbRow = await pool.query<{
          gross_minutes: number;
          paid_minutes: number;
          overtime_minutes: number;
        }>(
          `SELECT gross_minutes, paid_minutes, overtime_minutes
             FROM attendance_sessions
            WHERE workspace_owner_id = $1 AND status = 'completed'
            LIMIT 1`,
          [OWNER_ID],
        );
        expect(dbRow.rows[0].gross_minutes).toBe(540);
        expect(dbRow.rows[0].overtime_minutes).toBe(60);
      },
    );

    it(
      "location fallback — early leave and late arrival are computed " +
      "against the location schedule",
      async () => {
        // Location's default schedule: 09:00–18:00 with 60 min break.
        // Profile has NO work_schedule_id.
        // Clock in at 10:00 (60 min late, > 5 min grace).
        // Clock out at 16:00 (120 min early leave vs 18:00 end).
        //
        // Expected:
        //   grossMinutes    = (16:00 - 10:00) = 360
        //   breakMinutes    = 0
        //   paidMinutes     = 360
        //   lateMinutes     = 60
        //   earlyLeaveMinutes = 120
        //   overtimeMinutes = 0  (schedPaid = 540 − 60 = 480 > 360)

        const scheduleId = await seedSchedule(pool, {
          startTime: "09:00",
          endTime: "18:00",
          breakMinutes: 60,
        });
        const locationId = await seedLocation(pool, scheduleId);

        const wmId = await seedWorkspaceMember(pool);
        const tmId = await seedTeamMember(pool, wmId, { locationId });
        await seedProfile(pool, tmId, null);

        const clockInAt = todayAtUtc("10:00");
        await seedOpenSession(pool, tmId, clockInAt, locationId);

        const clockOutAt = todayAtUtc("16:00");
        vi.useFakeTimers();
        vi.setSystemTime(new Date(clockOutAt));

        const res = await request(app).post("/attendance/clock-out").send({});

        vi.useRealTimers();

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        const s = res.body.session;
        expect(s.gross_minutes).toBe(360);
        expect(s.break_minutes).toBe(0);
        expect(s.paid_minutes).toBe(360);
        expect(s.late_minutes).toBe(60);
        expect(s.early_leave_minutes).toBe(120);
        expect(s.overtime_minutes).toBe(0);
      },
    );

    // ── Night-shift / cross-midnight ────────────────────────────────────────

    it(
      "night shift — clock-in yesterday, clock-out today: " +
      "schedule lookup uses clock-in date (not today), late/overtime computed correctly",
      async () => {
        // Scenario: employee works a night shift.
        //   Schedule for yesterday's DOW: 22:00–23:00 (60 min), 0 break.
        //   No schedule is seeded for today's DOW — this is crucial: if the
        //   route used CURRENT_DATE instead of the clock-in date, no schedule
        //   would match and all penalty/overtime metrics would be zero.
        //
        //   Clock-in : yesterday 22:15 UTC  (15 min late; exceeds 5 min grace)
        //   Clock-out: today     07:00 UTC
        //
        // Expected with the fix (clock-in date used for DOW):
        //   grossMinutes      = (07:00 today − 22:15 yesterday) = 8h45m = 525
        //   breakMinutes      = 0
        //   paidMinutes       = 525
        //   lateMinutes       = 15  (22:15 > 22:00 + 5 min grace)
        //   earlyLeaveMinutes = 0   (clocked out well after schedEnd of 23:00)
        //   overtimeMinutes   = 525 − 60 = 465  (schedPaid = 60 min)

        const yesterdayDow = realYesterdayDow();

        const scheduleId = await seedSchedule(pool, {
          startTime: "22:00",
          endTime: "23:00",
          breakMinutes: 0,
          dayOfWeek: yesterdayDow,
        });

        const wmId = await seedWorkspaceMember(pool);
        const tmId = await seedTeamMember(pool, wmId);
        await seedProfile(pool, tmId, scheduleId);

        const clockInAt = yesterdayAtUtc("22:15");
        await seedOpenSession(pool, tmId, clockInAt);

        const clockOutAt = todayAtUtc("07:00");
        vi.useFakeTimers();
        vi.setSystemTime(new Date(clockOutAt));

        const res = await request(app).post("/attendance/clock-out").send({});

        vi.useRealTimers();

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        const s = res.body.session;
        expect(s.gross_minutes).toBe(525);
        expect(s.break_minutes).toBe(0);
        expect(s.paid_minutes).toBe(525);
        expect(s.late_minutes).toBe(15);
        expect(s.early_leave_minutes).toBe(0);
        expect(s.overtime_minutes).toBe(465);

        const dbRow = await pool.query<{
          gross_minutes: number;
          late_minutes: number;
          overtime_minutes: number;
        }>(
          `SELECT gross_minutes, late_minutes, overtime_minutes
             FROM attendance_sessions
            WHERE workspace_owner_id = $1 AND status = 'completed'
            LIMIT 1`,
          [OWNER_ID],
        );
        expect(dbRow.rows).toHaveLength(1);
        expect(dbRow.rows[0].gross_minutes).toBe(525);
        expect(dbRow.rows[0].late_minutes).toBe(15);
        expect(dbRow.rows[0].overtime_minutes).toBe(465);
      },
    );

    it(
      "night shift + location fallback — clock-in yesterday, clock-out today: " +
      "location default_schedule_id resolved via clock-in date, late/overtime correct",
      async () => {
        // Scenario: employee works a cross-midnight shift and the profile has
        // NO work_schedule_id — the route must fall back to the session's
        // location's default_schedule_id AND use the clock-in date (not today)
        // for the day-of-week lookup.
        //
        //   Location default schedule for yesterday's DOW: 22:00–23:00 (60 min), 0 break.
        //   No schedule seeded for today's DOW — confirms clock-in date is used.
        //
        //   Clock-in : yesterday 22:20 UTC  (20 min late; exceeds 5 min grace)
        //   Clock-out: today     05:00 UTC
        //
        // Expected:
        //   grossMinutes      = (05:00 today − 22:20 yesterday) = 6h40m = 400
        //   breakMinutes      = 0
        //   paidMinutes       = 400
        //   lateMinutes       = 20  (22:20 > 22:00 + 5 min grace)
        //   earlyLeaveMinutes = 0   (clocked out well after schedEnd of 23:00)
        //   overtimeMinutes   = 400 − 60 = 340  (schedPaid = 60 min)

        const yesterdayDow = realYesterdayDow();

        const scheduleId = await seedSchedule(pool, {
          startTime: "22:00",
          endTime: "23:00",
          breakMinutes: 0,
          dayOfWeek: yesterdayDow,
        });
        // Attach the schedule to the location (not the profile).
        const locationId = await seedLocation(pool, scheduleId);

        const wmId = await seedWorkspaceMember(pool);
        const tmId = await seedTeamMember(pool, wmId, { locationId });
        // Profile explicitly has no work_schedule_id → triggers location fallback.
        await seedProfile(pool, tmId, null);

        const clockInAt = yesterdayAtUtc("22:20");
        // Session must carry location_id so the route can JOIN locations.
        await seedOpenSession(pool, tmId, clockInAt, locationId);

        const clockOutAt = todayAtUtc("05:00");
        vi.useFakeTimers();
        vi.setSystemTime(new Date(clockOutAt));

        const res = await request(app).post("/attendance/clock-out").send({});

        vi.useRealTimers();

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        const s = res.body.session;
        expect(s.gross_minutes).toBe(400);
        expect(s.break_minutes).toBe(0);
        expect(s.paid_minutes).toBe(400);
        expect(s.late_minutes).toBe(20);
        expect(s.early_leave_minutes).toBe(0);
        expect(s.overtime_minutes).toBe(340);

        // Confirm the persisted row matches the in-memory values.
        const dbRow = await pool.query<{
          gross_minutes: number;
          late_minutes: number;
          overtime_minutes: number;
        }>(
          `SELECT gross_minutes, late_minutes, overtime_minutes
             FROM attendance_sessions
            WHERE workspace_owner_id = $1 AND status = 'completed'
            LIMIT 1`,
          [OWNER_ID],
        );
        expect(dbRow.rows).toHaveLength(1);
        expect(dbRow.rows[0].gross_minutes).toBe(400);
        expect(dbRow.rows[0].late_minutes).toBe(20);
        expect(dbRow.rows[0].overtime_minutes).toBe(340);
      },
    );

    // ── Missing schedule day (null gap) ─────────────────────────────────────

    it(
      "night shift — schedule exists but has no work_schedule_days row for yesterday's DOW: " +
      "late_minutes = 0, overtime_minutes = 0, gross_minutes still correct",
      async () => {
        // Scenario: the employee's profile has a work_schedule attached, but
        // that schedule has NO work_schedule_days entry for yesterday's day-of-
        // week — a schedule gap.  The cross-midnight session must still produce
        // a correct gross_minutes (the full elapsed minutes) while late_minutes
        // and overtime_minutes silently default to 0 rather than throwing or
        // producing garbage values.
        //
        //   Schedule only has a row for a DOW that is NOT yesterday, so the
        //   COALESCE in the route resolves the schedule id but the LEFT JOIN on
        //   work_schedule_days returns NULL columns — identical to the "no
        //   schedule" fallback path in calculateSessionMinutes.
        //
        //   Clock-in : yesterday 22:00 UTC
        //   Clock-out: today     06:00 UTC   (8 h = 480 min)
        //
        // Expected:
        //   grossMinutes      = 480
        //   breakMinutes      = 0
        //   paidMinutes       = 480
        //   lateMinutes       = 0  (no matching schedule day → no penalty)
        //   earlyLeaveMinutes = 0
        //   overtimeMinutes   = 0  (no matching schedule day → no overtime)

        // Pick a DOW that is guaranteed not to be yesterday's DOW so the
        // seeded work_schedule_days row never matches the clock-in date.
        const yesterdayDow = realYesterdayDow();
        const nonYesterdayDow = DOW_NAMES.find((d) => d !== yesterdayDow)!;

        // Seed the schedule with only an entry for nonYesterdayDow.
        const scheduleId = await seedSchedule(pool, {
          startTime: "09:00",
          endTime: "17:00",
          breakMinutes: 0,
          dayOfWeek: nonYesterdayDow,
        });

        const wmId = await seedWorkspaceMember(pool);
        const tmId = await seedTeamMember(pool, wmId);
        // Profile references the schedule — but the schedule has no row for
        // yesterday's DOW, which is the DOW that clock-in falls on.
        await seedProfile(pool, tmId, scheduleId);

        const clockInAt = yesterdayAtUtc("22:00");
        await seedOpenSession(pool, tmId, clockInAt);

        const clockOutAt = todayAtUtc("06:00");
        vi.useFakeTimers();
        vi.setSystemTime(new Date(clockOutAt));

        const res = await request(app).post("/attendance/clock-out").send({});

        vi.useRealTimers();

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        const s = res.body.session;
        expect(s.gross_minutes).toBe(480);
        expect(s.break_minutes).toBe(0);
        expect(s.paid_minutes).toBe(480);
        expect(s.late_minutes).toBe(0);
        expect(s.early_leave_minutes).toBe(0);
        expect(s.overtime_minutes).toBe(0);

        // Confirm the persisted row reflects the same values.
        const dbRow = await pool.query<{
          gross_minutes: number;
          late_minutes: number;
          overtime_minutes: number;
        }>(
          `SELECT gross_minutes, late_minutes, overtime_minutes
             FROM attendance_sessions
            WHERE workspace_owner_id = $1 AND status = 'completed'
            LIMIT 1`,
          [OWNER_ID],
        );
        expect(dbRow.rows).toHaveLength(1);
        expect(dbRow.rows[0].gross_minutes).toBe(480);
        expect(dbRow.rows[0].late_minutes).toBe(0);
        expect(dbRow.rows[0].overtime_minutes).toBe(0);
      },
    );

    // ── Null location + null profile schedule (schedule gap) ────────────────

    it(
      "night shift — no profile schedule AND no session location_id: " +
      "late_minutes = 0, overtime_minutes = 0, gross_minutes still correct",
      async () => {
        // Scenario: the profile has no work_schedule_id AND the session was
        // recorded with no location_id (NULL).  An unrelated work_schedule_days
        // row exists in the database (for a DOW that is not yesterday's) but it
        // is not reachable via any COALESCE path — the LEFT JOIN on
        // work_schedule_days produces NULL columns, identical to a schedule gap.
        // The clock-out must still succeed and gross_minutes must be correct.
        //
        //   Clock-in : yesterday 23:00 UTC
        //   Clock-out: today     07:00 UTC   (8 h = 480 min)
        //
        // Expected:
        //   grossMinutes      = 480
        //   breakMinutes      = 0
        //   paidMinutes       = 480
        //   lateMinutes       = 0  (COALESCE resolves NULL → no penalty)
        //   earlyLeaveMinutes = 0
        //   overtimeMinutes   = 0  (no matching schedule day → no overtime)

        // Seed a schedule with a work_schedule_days entry for a DOW that is
        // definitely NOT yesterday, and do NOT attach it to the profile or any
        // location — it is intentionally orphaned.
        const yesterdayDow = realYesterdayDow();
        const unrelatedDow = DOW_NAMES.find((d) => d !== yesterdayDow)!;

        await seedSchedule(pool, {
          startTime: "09:00",
          endTime: "17:00",
          breakMinutes: 0,
          dayOfWeek: unrelatedDow,
        });

        const wmId = await seedWorkspaceMember(pool);
        const tmId = await seedTeamMember(pool, wmId);
        // Profile has no work_schedule_id — no profile-level schedule.
        await seedProfile(pool, tmId, null);

        const clockInAt = yesterdayAtUtc("23:00");
        // Session has no location_id — no location-level fallback either.
        await seedOpenSession(pool, tmId, clockInAt, null);

        const clockOutAt = todayAtUtc("07:00");
        vi.useFakeTimers();
        vi.setSystemTime(new Date(clockOutAt));

        const res = await request(app).post("/attendance/clock-out").send({});

        vi.useRealTimers();

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        const s = res.body.session;
        expect(s.gross_minutes).toBe(480);
        expect(s.break_minutes).toBe(0);
        expect(s.paid_minutes).toBe(480);
        expect(s.late_minutes).toBe(0);
        expect(s.early_leave_minutes).toBe(0);
        expect(s.overtime_minutes).toBe(0);

        // Confirm the persisted row reflects the same values.
        const dbRow = await pool.query<{
          gross_minutes: number;
          late_minutes: number;
          overtime_minutes: number;
        }>(
          `SELECT gross_minutes, late_minutes, overtime_minutes
             FROM attendance_sessions
            WHERE workspace_owner_id = $1 AND status = 'completed'
            LIMIT 1`,
          [OWNER_ID],
        );
        expect(dbRow.rows).toHaveLength(1);
        expect(dbRow.rows[0].gross_minutes).toBe(480);
        expect(dbRow.rows[0].late_minutes).toBe(0);
        expect(dbRow.rows[0].overtime_minutes).toBe(0);
      },
    );

    // ── Missing schedule day via location fallback (null gap) ───────────────

    it(
      "night shift + location fallback — schedule exists but has no work_schedule_days " +
      "row for yesterday's DOW: late_minutes = 0, overtime_minutes = 0, gross_minutes correct",
      async () => {
        // Scenario: the profile has NO work_schedule_id → route falls back to
        // the session's location's default_schedule_id.  The location's schedule
        // exists but has NO work_schedule_days entry for yesterday's day-of-week
        // (the clock-in DOW).  The LEFT JOIN on work_schedule_days therefore
        // returns NULL columns — identical to the "no schedule" path inside
        // calculateSessionMinutes — so late/overtime are zero while gross_minutes
        // still reflects the full elapsed time.
        //
        // This is the symmetrical counterpart to the "profile schedule gap" test
        // above, but exercised through the location-fallback COALESCE branch.
        //
        //   Location default schedule: only has a day row for a DOW that is NOT
        //   yesterday's, so the LEFT JOIN on work_schedule_days matches nothing
        //   for the clock-in date.
        //
        //   Clock-in : yesterday 22:00 UTC
        //   Clock-out: today     06:00 UTC   (8 h = 480 min)
        //
        // Expected:
        //   grossMinutes      = 480
        //   breakMinutes      = 0
        //   paidMinutes       = 480
        //   lateMinutes       = 0  (no matching schedule day → no penalty)
        //   earlyLeaveMinutes = 0
        //   overtimeMinutes   = 0  (no matching schedule day → no overtime)

        // Pick a DOW that is guaranteed not to be yesterday's DOW so the
        // seeded work_schedule_days row never matches the clock-in date.
        const yesterdayDow = realYesterdayDow();
        const nonYesterdayDow = DOW_NAMES.find((d) => d !== yesterdayDow)!;

        // Seed the schedule with only an entry for nonYesterdayDow, then attach
        // it to a location — not to the profile.
        const scheduleId = await seedSchedule(pool, {
          startTime: "09:00",
          endTime: "17:00",
          breakMinutes: 0,
          dayOfWeek: nonYesterdayDow,
        });
        const locationId = await seedLocation(pool, scheduleId);

        const wmId = await seedWorkspaceMember(pool);
        const tmId = await seedTeamMember(pool, wmId, { locationId });
        // Profile has no work_schedule_id → triggers location fallback.
        await seedProfile(pool, tmId, null);

        const clockInAt = yesterdayAtUtc("22:00");
        // Session carries location_id so the route can JOIN locations for the
        // default_schedule_id fallback.
        await seedOpenSession(pool, tmId, clockInAt, locationId);

        const clockOutAt = todayAtUtc("06:00");
        vi.useFakeTimers();
        vi.setSystemTime(new Date(clockOutAt));

        const res = await request(app).post("/attendance/clock-out").send({});

        vi.useRealTimers();

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        const s = res.body.session;
        expect(s.gross_minutes).toBe(480);
        expect(s.break_minutes).toBe(0);
        expect(s.paid_minutes).toBe(480);
        expect(s.late_minutes).toBe(0);
        expect(s.early_leave_minutes).toBe(0);
        expect(s.overtime_minutes).toBe(0);

        // Confirm the persisted row reflects the same values.
        const dbRow = await pool.query<{
          gross_minutes: number;
          late_minutes: number;
          overtime_minutes: number;
        }>(
          `SELECT gross_minutes, late_minutes, overtime_minutes
             FROM attendance_sessions
            WHERE workspace_owner_id = $1 AND status = 'completed'
            LIMIT 1`,
          [OWNER_ID],
        );
        expect(dbRow.rows).toHaveLength(1);
        expect(dbRow.rows[0].gross_minutes).toBe(480);
        expect(dbRow.rows[0].late_minutes).toBe(0);
        expect(dbRow.rows[0].overtime_minutes).toBe(0);
      },
    );

    // ── Same-day: missing schedule day via location fallback (null gap) ─────

    it(
      "same-day + location fallback — schedule exists but has no work_schedule_days " +
      "row for today's DOW: late_minutes = 0, overtime_minutes = 0, gross_minutes correct",
      async () => {
        // Scenario: clock-in and clock-out on the same calendar day (no cross-
        // midnight).  The profile has NO work_schedule_id → the route falls back
        // to the session's location's default_schedule_id.  The location's
        // schedule exists but has NO work_schedule_days entry for today's
        // day-of-week — a schedule gap.  The LEFT JOIN on work_schedule_days
        // returns NULL columns, so late/overtime default to 0 while
        // gross_minutes still reflects the full elapsed time.
        //
        // This is the same-day counterpart to the cross-midnight
        // "night shift + location fallback — schedule gap" test above.
        //
        //   Location default schedule: only has a day row for a DOW that is NOT
        //   today's, so the LEFT JOIN on work_schedule_days matches nothing for
        //   the clock-in date.
        //
        //   Clock-in : today 09:00 UTC
        //   Clock-out: today 17:00 UTC   (8 h = 480 min)
        //
        // Expected:
        //   grossMinutes      = 480
        //   breakMinutes      = 0
        //   paidMinutes       = 480
        //   lateMinutes       = 0  (no matching schedule day → no penalty)
        //   earlyLeaveMinutes = 0
        //   overtimeMinutes   = 0  (no matching schedule day → no overtime)

        // Pick a DOW that is guaranteed not to be today's DOW so the seeded
        // work_schedule_days row never matches the clock-in date.
        const nonTodayDow = DOW_NAMES.find((d) => d !== todayDow)!;

        // Seed the schedule with only an entry for nonTodayDow, then attach it
        // to a location — not to the profile.
        const scheduleId = await seedSchedule(pool, {
          startTime: "09:00",
          endTime: "17:00",
          breakMinutes: 0,
          dayOfWeek: nonTodayDow,
        });
        const locationId = await seedLocation(pool, scheduleId);

        const wmId = await seedWorkspaceMember(pool);
        const tmId = await seedTeamMember(pool, wmId, { locationId });
        // Profile has no work_schedule_id → triggers location fallback.
        await seedProfile(pool, tmId, null);

        const clockInAt = todayAtUtc("09:00");
        // Session carries location_id so the route can JOIN locations for the
        // default_schedule_id fallback.
        await seedOpenSession(pool, tmId, clockInAt, locationId);

        const clockOutAt = todayAtUtc("17:00");
        vi.useFakeTimers();
        vi.setSystemTime(new Date(clockOutAt));

        const res = await request(app).post("/attendance/clock-out").send({});

        vi.useRealTimers();

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        const s = res.body.session;
        expect(s.gross_minutes).toBe(480);
        expect(s.break_minutes).toBe(0);
        expect(s.paid_minutes).toBe(480);
        expect(s.late_minutes).toBe(0);
        expect(s.early_leave_minutes).toBe(0);
        expect(s.overtime_minutes).toBe(0);

        // Confirm the persisted row reflects the same values.
        const dbRow = await pool.query<{
          gross_minutes: number;
          late_minutes: number;
          overtime_minutes: number;
        }>(
          `SELECT gross_minutes, late_minutes, overtime_minutes
             FROM attendance_sessions
            WHERE workspace_owner_id = $1 AND status = 'completed'
            LIMIT 1`,
          [OWNER_ID],
        );
        expect(dbRow.rows).toHaveLength(1);
        expect(dbRow.rows[0].gross_minutes).toBe(480);
        expect(dbRow.rows[0].late_minutes).toBe(0);
        expect(dbRow.rows[0].overtime_minutes).toBe(0);
      },
    );

    // ── No-schedule baseline ────────────────────────────────────────────────

    it(
      "no schedule attached — only gross_minutes and paid_minutes are set; " +
      "late/early_leave/overtime remain zero",
      async () => {
        // Neither the profile nor the location has a schedule.
        // Clock in at 09:00, clock out at 11:30.
        //
        // Expected:
        //   grossMinutes    = 150
        //   breakMinutes    = 0
        //   paidMinutes     = 150
        //   lateMinutes     = 0
        //   earlyLeaveMinutes = 0
        //   overtimeMinutes = 0

        const wmId = await seedWorkspaceMember(pool);
        const tmId = await seedTeamMember(pool, wmId);
        await seedProfile(pool, tmId, null);

        const clockInAt = todayAtUtc("09:00");
        await seedOpenSession(pool, tmId, clockInAt);

        const clockOutAt = todayAtUtc("11:30");
        vi.useFakeTimers();
        vi.setSystemTime(new Date(clockOutAt));

        const res = await request(app).post("/attendance/clock-out").send({});

        vi.useRealTimers();

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        const s = res.body.session;
        expect(s.gross_minutes).toBe(150);
        expect(s.break_minutes).toBe(0);
        expect(s.paid_minutes).toBe(150);
        expect(s.late_minutes).toBe(0);
        expect(s.early_leave_minutes).toBe(0);
        expect(s.overtime_minutes).toBe(0);
      },
    );
  },
);
