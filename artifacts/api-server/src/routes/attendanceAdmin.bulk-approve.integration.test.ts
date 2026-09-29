/**
 * Integration test: admin attendance bulk-approve endpoint.
 *
 * Exercises:
 *   POST /admin/attendance/requests/bulk-approve
 *
 * Tests:
 *   1.  Returns 400 when ids is missing or empty.
 *   2.  Unknown request ID → per-item success:false ("Not found").
 *   3.  Already-approved (non-pending) request → per-item success:false ("Not pending").
 *   4.  Request with locked linked session → per-item success:false ("Session is locked").
 *   5.  Happy path: request status becomes 'approved' in the DB.
 *   6.  Linked session clock_in_at is updated to the requested value.
 *   7.  Minute fields are recalculated using schedule data when a schedule is present.
 *   8.  Mixed batch: one approves, one is locked — results array reflects both outcomes.
 *   9.  Audit log entry 'request_approved' is written for each approved item.
 *
 * Auth and workspace middleware are mocked as owner.
 * The real database pool is used for all SQL.
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

const OWNER_ID  = "__att_bulk_approve_integ__";
const USER_ID   = "__att_bulk_approve_user__";
const MEMBER_ID = "__att_bulk_approve_member__";

// ─────────────────────────────────────────────────────────────────────────────
// Mocks — only auth / workspace / logger / side-effect libs.
// db uses the real module so all SQL goes to the real database.
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
    wreq.userEmail = "att-bulk-approve-test@example.com";
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
// Fixed timestamps.
//
// 2025-01-06 is a Monday, which lets us seed work_schedule_days for 'monday'
// and get deterministic schedule lookups regardless of the real date.
// ─────────────────────────────────────────────────────────────────────────────

const CLOCK_IN_BASE  = "2025-01-06T09:30:00.000Z"; // 30 min after 09:00 schedule start
const CLOCK_OUT_BASE = "2025-01-06T17:00:00.000Z"; // exactly at schedule end

// ─────────────────────────────────────────────────────────────────────────────
// Database cleanup
// ─────────────────────────────────────────────────────────────────────────────

async function cleanup(pool: InstanceType<typeof Pool>): Promise<void> {
  await pool.query(
    `DELETE FROM attendance_audit_logs WHERE workspace_owner_id = $1`,
    [OWNER_ID],
  );
  await pool.query(
    `DELETE FROM attendance_requests WHERE workspace_owner_id = $1`,
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

async function seedWorkspaceMember(pool: InstanceType<typeof Pool>): Promise<number> {
  const r = await pool.query<{ id: number }>(
    `INSERT INTO workspace_members
       (workspace_owner_id, member_user_id, member_email, role)
     VALUES ($1, $2, 'att-bulk-approve-test@example.com', 'member')
     RETURNING id`,
    [OWNER_ID, MEMBER_ID],
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
     VALUES ($1, $2, 'BulkApproveTest')
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

async function seedMondaySchedule(
  pool: InstanceType<typeof Pool>,
  opts: { startTime: string; endTime: string; breakMinutes: number },
): Promise<number> {
  const sched = await pool.query<{ id: number }>(
    `INSERT INTO work_schedules (workspace_owner_id, name, status)
     VALUES ($1, 'Bulk-Approve Test Schedule', 'active')
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

async function seedSession(
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

async function seedAttendanceRequest(
  pool: InstanceType<typeof Pool>,
  employeeId: number,
  opts: {
    sessionId?: number | null;
    requestType?: string;
    requestedClockInAt?: string | null;
    requestedClockOutAt?: string | null;
    status?: string;
  } = {},
): Promise<number> {
  const r = await pool.query<{ id: number }>(
    `INSERT INTO attendance_requests
       (workspace_owner_id, employee_id, attendance_session_id,
        request_type, requested_clock_in_at, requested_clock_out_at, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      OWNER_ID,
      employeeId,
      opts.sessionId ?? null,
      opts.requestType ?? "edit_clock_in",
      opts.requestedClockInAt ?? null,
      opts.requestedClockOutAt ?? null,
      opts.status ?? "pending",
    ],
  );
  return r.rows[0].id;
}

// ─────────────────────────────────────────────────────────────────────────────
// DB row read helpers
// ─────────────────────────────────────────────────────────────────────────────

async function getRequestStatus(
  pool: InstanceType<typeof Pool>,
  requestId: number,
): Promise<string | undefined> {
  const r = await pool.query<{ status: string }>(
    `SELECT status FROM attendance_requests WHERE id = $1`,
    [requestId],
  );
  return r.rows[0]?.status;
}

async function getSession(
  pool: InstanceType<typeof Pool>,
  sessionId: number,
): Promise<{
  clock_in_at: Date;
  clock_out_at: Date | null;
  gross_minutes: number | null;
  paid_minutes: number | null;
  late_minutes: number;
  early_leave_minutes: number;
  overtime_minutes: number;
} | undefined> {
  const r = await pool.query(
    `SELECT clock_in_at, clock_out_at,
            gross_minutes, paid_minutes,
            late_minutes, early_leave_minutes, overtime_minutes
       FROM attendance_sessions WHERE id = $1`,
    [sessionId],
  );
  return r.rows[0] as ReturnType<typeof getSession> extends Promise<infer T> ? T : never;
}

async function getAuditActions(
  pool: InstanceType<typeof Pool>,
  requestId: number,
): Promise<string[]> {
  const r = await pool.query<{ action: string }>(
    `SELECT action FROM attendance_audit_logs
      WHERE workspace_owner_id = $1 AND attendance_request_id = $2
      ORDER BY created_at`,
    [OWNER_ID, requestId],
  );
  return r.rows.map((row) => row.action);
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!DATABASE_URL)(
  "POST /admin/attendance/requests/bulk-approve — integration",
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

    // ── Validation ─────────────────────────────────────────────────────────

    // 1. Missing / empty ids body
    it("returns 400 when ids is missing", async () => {
      const res = await request(app)
        .post("/admin/attendance/requests/bulk-approve")
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/ids/i);
    });

    it("returns 400 when ids is an empty array", async () => {
      const res = await request(app)
        .post("/admin/attendance/requests/bulk-approve")
        .send({ ids: [] });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/ids/i);
    });

    // ── Per-item error paths ────────────────────────────────────────────────

    // 2. Unknown request ID → success:false in results
    it("unknown request ID → per-item success:false with 'Not found'", async () => {
      const res = await request(app)
        .post("/admin/attendance/requests/bulk-approve")
        .send({ ids: [999999999] });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.results).toHaveLength(1);
      expect(res.body.results[0]).toMatchObject({
        id: 999999999,
        success: false,
        error: "Not found",
      });
      expect(res.body.succeeded).toBe(0);
      expect(res.body.failed).toBe(1);
    });

    // 3. Already-approved request → success:false
    it("already-approved request → per-item success:false with 'Not pending'", async () => {
      const sessionId = await seedSession(pool, tmId, { status: "completed" });
      const reqId = await seedAttendanceRequest(pool, tmId, {
        sessionId,
        requestType: "edit_clock_in",
        requestedClockInAt: CLOCK_IN_BASE,
        status: "approved",
      });

      const res = await request(app)
        .post("/admin/attendance/requests/bulk-approve")
        .send({ ids: [reqId] });
      expect(res.status).toBe(200);
      expect(res.body.results[0]).toMatchObject({
        id: reqId,
        success: false,
        error: "Not pending",
      });
    });

    // 4. Request linked to a locked session → success:false
    it("locked linked session → per-item success:false with 'Session is locked'", async () => {
      const sessionId = await seedSession(pool, tmId, { status: "locked" });
      const reqId = await seedAttendanceRequest(pool, tmId, {
        sessionId,
        requestType: "edit_clock_in",
        requestedClockInAt: CLOCK_IN_BASE,
      });

      const res = await request(app)
        .post("/admin/attendance/requests/bulk-approve")
        .send({ ids: [reqId] });
      expect(res.status).toBe(200);
      expect(res.body.results[0]).toMatchObject({
        id: reqId,
        success: false,
        error: "Session is locked",
      });
    });

    // ── Happy path ──────────────────────────────────────────────────────────

    // 5. Request status becomes 'approved' in the DB
    it("happy path: request status becomes 'approved' in the DB", async () => {
      const sessionId = await seedSession(pool, tmId, { status: "completed" });
      const reqId = await seedAttendanceRequest(pool, tmId, {
        sessionId,
        requestType: "edit_clock_in",
        requestedClockInAt: CLOCK_IN_BASE,
      });

      const res = await request(app)
        .post("/admin/attendance/requests/bulk-approve")
        .send({ ids: [reqId] });
      expect(res.status).toBe(200);
      expect(res.body.results[0]).toMatchObject({ id: reqId, success: true });
      expect(res.body.succeeded).toBe(1);
      expect(res.body.failed).toBe(0);

      expect(await getRequestStatus(pool, reqId)).toBe("approved");
    });

    // 6. Linked session clock_in_at is updated to the requested value
    it("linked session clock_in_at is updated to the requested corrected time", async () => {
      const correctedClockIn = "2025-01-06T09:00:00.000Z"; // earlier than seeded 09:30
      const sessionId = await seedSession(pool, tmId, {
        clockInAt: CLOCK_IN_BASE, // 09:30
        clockOutAt: CLOCK_OUT_BASE,
        status: "completed",
      });
      const reqId = await seedAttendanceRequest(pool, tmId, {
        sessionId,
        requestType: "edit_clock_in",
        requestedClockInAt: correctedClockIn,
      });

      const res = await request(app)
        .post("/admin/attendance/requests/bulk-approve")
        .send({ ids: [reqId] });
      expect(res.status).toBe(200);
      expect(res.body.results[0].success).toBe(true);

      const row = await getSession(pool, sessionId);
      expect(row).toBeDefined();
      // The session clock_in should now reflect the corrected time
      const clockInMs = new Date(row!.clock_in_at).getTime();
      expect(clockInMs).toBe(new Date(correctedClockIn).getTime());
    });

    // 7. Minute fields recalculated when a schedule is present
    //
    // Schedule: Monday 09:00–17:00, 30 min scheduled break.
    //
    // Session seeded with clock_in = 09:30 (30 min late), clock_out = 17:00.
    // Request corrects clock_in to 09:00 (on time).
    //
    // Expected recalculation (after applying the corrected clock_in = 09:00):
    //   effective_in  = 09:00, effective_out = 17:00
    //   gross_minutes = 17:00 − 09:00           = 480
    //   paid_minutes  = 480 − 0 (no logged break) = 480
    //   late_minutes  = 0   (arrived exactly at start, within 5-min grace)
    //   early_leave_minutes = 0
    //   overtime_minutes    = 480 − (480 − 30) = 30  (paid > schedPaid)
    it(
      "minute fields are recalculated using schedule data when a schedule is present",
      async () => {
        const scheduleId = await seedMondaySchedule(pool, {
          startTime:    "09:00",
          endTime:      "17:00",
          breakMinutes: 30,
        });

        await pool.query(
          `DELETE FROM team_member_profiles WHERE workspace_owner_id = $1`,
          [OWNER_ID],
        );
        await seedProfile(pool, tmId, scheduleId);

        const correctedClockIn = "2025-01-06T09:00:00.000Z";

        const sessionId = await seedSession(pool, tmId, {
          clockInAt:    CLOCK_IN_BASE,   // 09:30 — will be corrected to 09:00
          clockOutAt:   CLOCK_OUT_BASE,  // 17:00
          breakMinutes: 0,
          status:       "completed",
        });
        const reqId = await seedAttendanceRequest(pool, tmId, {
          sessionId,
          requestType:        "edit_clock_in",
          requestedClockInAt: correctedClockIn,
        });

        const res = await request(app)
          .post("/admin/attendance/requests/bulk-approve")
          .send({ ids: [reqId] });
        expect(res.status).toBe(200);
        expect(res.body.results[0].success).toBe(true);

        const row = await getSession(pool, sessionId);
        expect(row).toBeDefined();

        expect(Number(row!.gross_minutes)).toBe(480);
        expect(Number(row!.paid_minutes)).toBe(480);
        expect(Number(row!.late_minutes)).toBe(0);
        expect(Number(row!.early_leave_minutes)).toBe(0);
        expect(Number(row!.overtime_minutes)).toBe(30);
      },
    );

    // 8. Mixed batch: one succeeds, one fails (locked) — results reflect both
    it("mixed batch: approved and locked items both reported correctly", async () => {
      // Item A — pending request on a completed session → should succeed
      const sessionA = await seedSession(pool, tmId, { status: "completed" });
      const reqA = await seedAttendanceRequest(pool, tmId, {
        sessionId:          sessionA,
        requestType:        "edit_clock_in",
        requestedClockInAt: CLOCK_IN_BASE,
      });

      // Item B — pending request but session is locked → should fail
      const sessionB = await seedSession(pool, tmId, {
        clockInAt: "2025-01-06T08:00:00.000Z",
        status:    "locked",
      });
      const reqB = await seedAttendanceRequest(pool, tmId, {
        sessionId:          sessionB,
        requestType:        "edit_clock_in",
        requestedClockInAt: "2025-01-06T08:00:00.000Z",
      });

      const res = await request(app)
        .post("/admin/attendance/requests/bulk-approve")
        .send({ ids: [reqA, reqB] });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.succeeded).toBe(1);
      expect(res.body.failed).toBe(1);

      const resultA = res.body.results.find((r: { id: number }) => r.id === reqA);
      const resultB = res.body.results.find((r: { id: number }) => r.id === reqB);

      expect(resultA).toMatchObject({ id: reqA, success: true });
      expect(resultB).toMatchObject({ id: reqB, success: false, error: "Session is locked" });

      expect(await getRequestStatus(pool, reqA)).toBe("approved");
      expect(await getRequestStatus(pool, reqB)).toBe("pending");
    });

    // 9. Audit log: 'request_approved' entry is written for each approved item
    it("audit log: 'request_approved' entry is written for each approved item", async () => {
      const sessionId = await seedSession(pool, tmId, { status: "completed" });
      const reqId = await seedAttendanceRequest(pool, tmId, {
        sessionId,
        requestType:        "edit_clock_in",
        requestedClockInAt: CLOCK_IN_BASE,
      });

      await request(app)
        .post("/admin/attendance/requests/bulk-approve")
        .send({ ids: [reqId] });

      const actions = await getAuditActions(pool, reqId);
      expect(actions).toContain("request_approved");
    });
  },
);
