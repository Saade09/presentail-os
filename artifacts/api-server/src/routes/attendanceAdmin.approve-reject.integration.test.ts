/**
 * Integration test: admin attendance single-request approve and reject endpoints.
 *
 * Exercises:
 *   POST /admin/attendance/requests/:id/approve
 *   POST /admin/attendance/requests/:id/reject
 *
 * Tests — approve:
 *   1.  404 when the request is not found.
 *   2.  409 when the request is not pending.
 *   3.  409 when the linked session is locked.
 *   4.  Happy path: request status becomes 'approved' in the DB.
 *   5.  Linked session clock_in_at is updated for edit_clock_in type.
 *   6.  Linked session clock_out_at is updated for edit_clock_out type.
 *   7.  Minute fields are recalculated when a schedule is present.
 *   8.  New session created for missed_clock_in with no linked session.
 *   9.  Audit log 'request_approved' entry written.
 *
 * Tests — reject:
 *   10. 404 when the request is not found.
 *   11. 409 when the request is not pending.
 *   12. Happy path: request status becomes 'rejected' in the DB.
 *   13. Audit log 'request_rejected' entry written.
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

const OWNER_ID  = "__att_approve_reject_integ__";
const USER_ID   = "__att_approve_reject_user__";
const MEMBER_ID = "__att_approve_reject_member__";

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
    wreq.userEmail = "att-approve-reject-test@example.com";
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
     VALUES ($1, $2, 'att-approve-reject-test@example.com', 'member')
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
     VALUES ($1, $2, 'ApproveRejectTest')
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
     VALUES ($1, 'Approve-Reject Test Schedule', 'active')
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
    clockOutAt?: string | null;
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
      opts.clockInAt    ?? CLOCK_IN_BASE,
      opts.clockOutAt   !== undefined ? opts.clockOutAt : CLOCK_OUT_BASE,
      opts.status       ?? "completed",
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

async function getRequest(
  pool: InstanceType<typeof Pool>,
  requestId: number,
): Promise<{ status: string; attendance_session_id: number | null } | undefined> {
  const r = await pool.query<{ status: string; attendance_session_id: number | null }>(
    `SELECT status, attendance_session_id FROM attendance_requests WHERE id = $1`,
    [requestId],
  );
  return r.rows[0];
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
  "POST /admin/attendance/requests/:id/approve and :id/reject — integration",
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

    // ─────────────────────────────────────────────────────────────────────────
    // APPROVE
    // ─────────────────────────────────────────────────────────────────────────

    // 1. 404 when the request does not exist
    it("approve: returns 404 when request is not found", async () => {
      const res = await request(app)
        .post("/admin/attendance/requests/999999999/approve")
        .send({});
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/not found/i);
    });

    // 2. 409 when request is not pending (already approved)
    it("approve: returns 409 when request is not pending", async () => {
      const sessionId = await seedSession(pool, tmId, { status: "completed" });
      const reqId = await seedAttendanceRequest(pool, tmId, {
        sessionId,
        requestType: "edit_clock_in",
        requestedClockInAt: CLOCK_IN_BASE,
        status: "approved",
      });

      const res = await request(app)
        .post(`/admin/attendance/requests/${reqId}/approve`)
        .send({});
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/not pending/i);
    });

    // 3. 409 when linked session is locked
    it("approve: returns 409 when linked session is locked", async () => {
      const sessionId = await seedSession(pool, tmId, { status: "locked" });
      const reqId = await seedAttendanceRequest(pool, tmId, {
        sessionId,
        requestType: "edit_clock_in",
        requestedClockInAt: CLOCK_IN_BASE,
      });

      const res = await request(app)
        .post(`/admin/attendance/requests/${reqId}/approve`)
        .send({});
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/locked/i);
    });

    // 4. Happy path: request status becomes 'approved'
    it("approve: request status becomes 'approved' in the DB", async () => {
      const sessionId = await seedSession(pool, tmId, { status: "completed" });
      const reqId = await seedAttendanceRequest(pool, tmId, {
        sessionId,
        requestType: "edit_clock_in",
        requestedClockInAt: CLOCK_IN_BASE,
      });

      const res = await request(app)
        .post(`/admin/attendance/requests/${reqId}/approve`)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const row = await getRequest(pool, reqId);
      expect(row?.status).toBe("approved");
    });

    // 5. Session clock_in_at is updated for edit_clock_in
    it("approve: linked session clock_in_at is updated for edit_clock_in type", async () => {
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
        .post(`/admin/attendance/requests/${reqId}/approve`)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const row = await getSession(pool, sessionId);
      expect(row).toBeDefined();
      expect(new Date(row!.clock_in_at).getTime()).toBe(new Date(correctedClockIn).getTime());
    });

    // 6. Session clock_out_at is updated for edit_clock_out
    it("approve: linked session clock_out_at is updated for edit_clock_out type", async () => {
      const correctedClockOut = "2025-01-06T18:00:00.000Z"; // later than seeded 17:00
      const sessionId = await seedSession(pool, tmId, {
        clockInAt: CLOCK_IN_BASE,
        clockOutAt: CLOCK_OUT_BASE, // 17:00
        status: "completed",
      });
      const reqId = await seedAttendanceRequest(pool, tmId, {
        sessionId,
        requestType: "edit_clock_out",
        requestedClockOutAt: correctedClockOut,
      });

      const res = await request(app)
        .post(`/admin/attendance/requests/${reqId}/approve`)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const row = await getSession(pool, sessionId);
      expect(row).toBeDefined();
      expect(new Date(row!.clock_out_at!).getTime()).toBe(new Date(correctedClockOut).getTime());
    });

    // 7. Minute fields recalculated when schedule is present
    //
    // Schedule: Monday 09:00–17:00, 30 min scheduled break.
    //
    // Session seeded with clock_in = 09:30 (30 min late), clock_out = 17:00.
    // Request corrects clock_in to 09:00 (on time).
    //
    // Expected recalculation (after applying corrected clock_in = 09:00):
    //   gross_minutes        = 17:00 − 09:00           = 480
    //   paid_minutes         = 480 − 0 (no logged break) = 480
    //   late_minutes         = 0   (arrived at start, within 5-min grace)
    //   early_leave_minutes  = 0
    //   overtime_minutes     = 480 − (480 − 30) = 30  (paid > schedPaid)
    it("approve: minute fields are recalculated using schedule data when a schedule is present", async () => {
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
        .post(`/admin/attendance/requests/${reqId}/approve`)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const row = await getSession(pool, sessionId);
      expect(row).toBeDefined();
      expect(Number(row!.gross_minutes)).toBe(480);
      expect(Number(row!.paid_minutes)).toBe(480);
      expect(Number(row!.late_minutes)).toBe(0);
      expect(Number(row!.early_leave_minutes)).toBe(0);
      expect(Number(row!.overtime_minutes)).toBe(30);
    });

    // 8. New session created for missed_clock_in with no linked session
    it("approve: creates a new session for missed_clock_in with no linked session", async () => {
      const missedClockIn = "2025-01-06T08:00:00.000Z";
      const reqId = await seedAttendanceRequest(pool, tmId, {
        sessionId:          null, // no linked session
        requestType:        "missed_clock_in",
        requestedClockInAt: missedClockIn,
      });

      const res = await request(app)
        .post(`/admin/attendance/requests/${reqId}/approve`)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Verify a new session was created and linked
      const updatedReq = await getRequest(pool, reqId);
      expect(updatedReq?.status).toBe("approved");
      expect(updatedReq?.attendance_session_id).not.toBeNull();

      const newSessionId = updatedReq!.attendance_session_id!;
      const sessionRow = await getSession(pool, newSessionId);
      expect(sessionRow).toBeDefined();
      expect(new Date(sessionRow!.clock_in_at).getTime()).toBe(new Date(missedClockIn).getTime());
    });

    // 9. Audit log 'request_approved' entry written
    it("approve: audit log 'request_approved' entry is written", async () => {
      const sessionId = await seedSession(pool, tmId, { status: "completed" });
      const reqId = await seedAttendanceRequest(pool, tmId, {
        sessionId,
        requestType:        "edit_clock_in",
        requestedClockInAt: CLOCK_IN_BASE,
      });

      await request(app)
        .post(`/admin/attendance/requests/${reqId}/approve`)
        .send({});

      const actions = await getAuditActions(pool, reqId);
      expect(actions).toContain("request_approved");
    });

    // ─────────────────────────────────────────────────────────────────────────
    // REJECT
    // ─────────────────────────────────────────────────────────────────────────

    // 10. 404 when the request does not exist
    it("reject: returns 404 when request is not found", async () => {
      const res = await request(app)
        .post("/admin/attendance/requests/999999999/reject")
        .send({});
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/not found/i);
    });

    // 11. 409 when request is not pending
    it("reject: returns 409 when request is not pending", async () => {
      const sessionId = await seedSession(pool, tmId, { status: "completed" });
      const reqId = await seedAttendanceRequest(pool, tmId, {
        sessionId,
        requestType: "edit_clock_in",
        requestedClockInAt: CLOCK_IN_BASE,
        status: "rejected",
      });

      const res = await request(app)
        .post(`/admin/attendance/requests/${reqId}/reject`)
        .send({});
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/not pending/i);
    });

    // 12. Happy path: request status becomes 'rejected'
    it("reject: request status becomes 'rejected' in the DB", async () => {
      const sessionId = await seedSession(pool, tmId, { status: "completed" });
      const reqId = await seedAttendanceRequest(pool, tmId, {
        sessionId,
        requestType:        "edit_clock_in",
        requestedClockInAt: CLOCK_IN_BASE,
      });

      const res = await request(app)
        .post(`/admin/attendance/requests/${reqId}/reject`)
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const row = await getRequest(pool, reqId);
      expect(row?.status).toBe("rejected");
    });

    // 13. Audit log 'request_rejected' entry written
    it("reject: audit log 'request_rejected' entry is written", async () => {
      const sessionId = await seedSession(pool, tmId, { status: "completed" });
      const reqId = await seedAttendanceRequest(pool, tmId, {
        sessionId,
        requestType:        "edit_clock_in",
        requestedClockInAt: CLOCK_IN_BASE,
      });

      await request(app)
        .post(`/admin/attendance/requests/${reqId}/reject`)
        .send({});

      const actions = await getAuditActions(pool, reqId);
      expect(actions).toContain("request_rejected");
    });
  },
);
