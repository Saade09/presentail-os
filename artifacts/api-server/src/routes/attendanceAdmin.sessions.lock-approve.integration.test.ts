/**
 * Integration test: admin timesheet session lock, approve, and reject endpoints.
 *
 * Exercises:
 *   POST /admin/attendance/sessions/:id/lock
 *   POST /admin/attendance/sessions/:id/approve
 *   POST /admin/attendance/sessions/:id/reject
 *
 * Tests for lock:
 *   1. Returns 404 when the session does not exist.
 *   2. Returns 403 when the caller is not an owner.
 *   3. Returns 409 when the session is already locked.
 *   4. Returns 409 when the session status is not approved or completed.
 *   5. Locking an approved session → status becomes 'locked' in the DB.
 *   6. Locking a completed session → status becomes 'locked' in the DB.
 *   7. Lock writes a 'session_locked' audit log entry.
 *   8. A locked session returns 409 on a subsequent PATCH (cannot be edited).
 *
 * Tests for approve:
 *   9.  Returns 404 when the session does not exist.
 *  10.  Returns 409 when the session is already locked.
 *  11.  Approving a completed session (no schedule) → status becomes 'approved' in the DB.
 *  12.  Approve writes a 'session_approved' audit log entry.
 *  13.  Approving with a schedule linked → derived minute fields are recalculated
 *       and persisted correctly in the DB.
 *
 * Tests for reject:
 *  14.  Returns 404 when the session does not exist.
 *  15.  Returns 409 when the session is locked.
 *  16.  Rejecting a completed session → status becomes 'rejected' in the DB.
 *  17.  Reject persists manager_note in the DB.
 *  18.  Reject writes a 'session_rejected' audit log entry.
 *
 * Auth and workspace middleware are mocked as owner unless stated otherwise.
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
import type { WorkspaceRole } from "./integrationTestTypes";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;

// ─────────────────────────────────────────────────────────────────────────────
// Stable test-scope identifiers — chosen to avoid collisions with real data.
// ─────────────────────────────────────────────────────────────────────────────

const OWNER_ID  = "__att_lock_approve_integ__";
const USER_ID   = "__att_lock_approve_user__";
const MEMBER_ID = "__att_lock_approve_member__";

// ─────────────────────────────────────────────────────────────────────────────
// Mutable role — defaults to "owner"; individual tests flip this to exercise
// the 403 path without spawning a second test suite.
// ─────────────────────────────────────────────────────────────────────────────

let currentRole: WorkspaceRole = "owner";

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
    wreq.workspaceRole       = currentRole as WorkspaceRequest["workspaceRole"];
    wreq.workspaceActualRole = currentRole as WorkspaceRequest["workspaceActualRole"];
    wreq.userId    = USER_ID;
    wreq.userEmail = "att-lock-approve-test@example.com";
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
     VALUES ($1, $2, 'att-lock-approve-test@example.com', 'member')
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
     VALUES ($1, $2, 'LockApproveTest')
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
     VALUES ($1, 'Lock-Approve Test Schedule', 'active')
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

// ─────────────────────────────────────────────────────────────────────────────
// Helpers to read DB rows directly
// ─────────────────────────────────────────────────────────────────────────────

async function getSessionStatus(
  pool: InstanceType<typeof Pool>,
  sessionId: number,
): Promise<string | undefined> {
  const r = await pool.query<{ status: string }>(
    `SELECT status FROM attendance_sessions WHERE id = $1`,
    [sessionId],
  );
  return r.rows[0]?.status;
}

async function getAuditLogs(
  pool: InstanceType<typeof Pool>,
  sessionId: number,
): Promise<Array<{ action: string }>> {
  const r = await pool.query<{ action: string }>(
    `SELECT action FROM attendance_audit_logs
      WHERE workspace_owner_id = $1 AND attendance_session_id = $2
      ORDER BY created_at`,
    [OWNER_ID, sessionId],
  );
  return r.rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!DATABASE_URL)(
  "POST /admin/attendance/sessions/:id/lock + /approve — integration",
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
      currentRole = "owner";
      await cleanup(pool);
      const wmId = await seedWorkspaceMember(pool);
      tmId = await seedTeamMember(pool, wmId);
      await seedProfile(pool, tmId);
    });

    // ── LOCK ──────────────────────────────────────────────────────────────────

    // 1. 404 when session does not exist
    it("lock: returns 404 when the session does not exist", async () => {
      const res = await request(app).post("/admin/attendance/sessions/999999999/lock");
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/not found/i);
    });

    // 2. 403 when caller is not owner
    it("lock: returns 403 when the caller is not an owner", async () => {
      const sessionId = await seedSession(pool, tmId, { status: "completed" });
      currentRole = "member";

      const res = await request(app).post(`/admin/attendance/sessions/${sessionId}/lock`);
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/owner/i);
    });

    // 3. 409 when session is already locked
    it("lock: returns 409 when the session is already locked", async () => {
      const sessionId = await seedSession(pool, tmId, { status: "locked" });

      const res = await request(app).post(`/admin/attendance/sessions/${sessionId}/lock`);
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/already locked/i);
    });

    // 4. 409 when status is not approved or completed
    it("lock: returns 409 when the session status is not approved or completed", async () => {
      const sessionId = await seedSession(pool, tmId, { status: "active" });

      const res = await request(app).post(`/admin/attendance/sessions/${sessionId}/lock`);
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/approved or completed/i);
    });

    // 5. Locking an approved session → DB status becomes 'locked'
    it("lock: approved session → status becomes 'locked' in the DB", async () => {
      const sessionId = await seedSession(pool, tmId, { status: "approved" });

      const res = await request(app).post(`/admin/attendance/sessions/${sessionId}/lock`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      expect(await getSessionStatus(pool, sessionId)).toBe("locked");
    });

    // 6. Locking a completed session → DB status becomes 'locked'
    it("lock: completed session → status becomes 'locked' in the DB", async () => {
      const sessionId = await seedSession(pool, tmId, { status: "completed" });

      const res = await request(app).post(`/admin/attendance/sessions/${sessionId}/lock`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      expect(await getSessionStatus(pool, sessionId)).toBe("locked");
    });

    // 7. Lock writes a 'session_locked' audit log entry
    it("lock: writes a 'session_locked' audit log entry", async () => {
      const sessionId = await seedSession(pool, tmId, { status: "completed" });

      await request(app).post(`/admin/attendance/sessions/${sessionId}/lock`);

      const logs = await getAuditLogs(pool, sessionId);
      expect(logs.length).toBeGreaterThanOrEqual(1);
      expect(logs.some((l) => l.action === "session_locked")).toBe(true);
    });

    // 8. Locked session → PATCH returns 409
    it("lock: a locked session cannot be edited via PATCH (returns 409)", async () => {
      const sessionId = await seedSession(pool, tmId, { status: "completed" });

      // Lock the session first.
      const lockRes = await request(app).post(`/admin/attendance/sessions/${sessionId}/lock`);
      expect(lockRes.status).toBe(200);

      // Attempt to edit the now-locked session.
      const patchRes = await request(app)
        .patch(`/admin/attendance/sessions/${sessionId}`)
        .send({ manager_note: "should be blocked" });
      expect(patchRes.status).toBe(409);
      expect(patchRes.body.error).toMatch(/locked/i);
    });

    // ── APPROVE ───────────────────────────────────────────────────────────────

    // 9. 404 when session does not exist
    it("approve: returns 404 when the session does not exist", async () => {
      const res = await request(app).post("/admin/attendance/sessions/999999999/approve");
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/not found/i);
    });

    // 10. 409 when session is locked
    it("approve: returns 409 when the session is locked", async () => {
      const sessionId = await seedSession(pool, tmId, { status: "locked" });

      const res = await request(app).post(`/admin/attendance/sessions/${sessionId}/approve`);
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/locked/i);
    });

    // 11. Approving a completed session (no schedule) → DB status becomes 'approved'
    it("approve: completed session (no schedule) → status becomes 'approved' in the DB", async () => {
      const sessionId = await seedSession(pool, tmId, { status: "completed" });

      const res = await request(app).post(`/admin/attendance/sessions/${sessionId}/approve`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      expect(await getSessionStatus(pool, sessionId)).toBe("approved");
    });

    // 12. Approve writes a 'session_approved' audit log entry
    it("approve: writes a 'session_approved' audit log entry", async () => {
      const sessionId = await seedSession(pool, tmId, { status: "completed" });

      await request(app).post(`/admin/attendance/sessions/${sessionId}/approve`);

      const logs = await getAuditLogs(pool, sessionId);
      expect(logs.length).toBeGreaterThanOrEqual(1);
      expect(logs.some((l) => l.action === "session_approved")).toBe(true);
    });

    // 13. Approve with schedule → derived minute fields recalculated in DB
    //
    // Schedule: Monday 09:00–17:00, 30 min scheduled break.
    //
    // Session state (seeded directly):
    //   clock_in_at  = 2025-01-06T09:30Z  (30 min late, > 5 min grace)
    //   clock_out_at = 2025-01-06T17:00Z  (exactly on time)
    //   break_minutes = 0  (no logged break)
    //
    // Expected recalculation:
    //   gross_minutes       = 17:00 − 09:30             = 450
    //   paid_minutes        = 450 − 0                   = 450
    //   late_minutes        = 30  (arrived 30 min after schedule start)
    //   early_leave_minutes = 0   (clocked out at schedule end)
    //   overtime_minutes    = 0   (paid 450 < sched paid 450; schedPaid = 480−30=450)

    it(
      "approve: with schedule linked — derived minute fields are recalculated " +
      "and persisted correctly in the DB",
      async () => {
        const scheduleId = await seedMondaySchedule(pool, {
          startTime:    "09:00",
          endTime:      "17:00",
          breakMinutes: 30,
        });

        // Re-seed profile with schedule attached.
        await pool.query(
          `DELETE FROM team_member_profiles WHERE workspace_owner_id = $1`,
          [OWNER_ID],
        );
        await seedProfile(pool, tmId, scheduleId);

        const sessionId = await seedSession(pool, tmId, {
          clockInAt:    CLOCK_IN_BASE,   // 09:30
          clockOutAt:   CLOCK_OUT_BASE,  // 17:00
          breakMinutes: 0,
          status:       "completed",
        });

        const res = await request(app).post(`/admin/attendance/sessions/${sessionId}/approve`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        const dbRow = await pool.query<{
          status:              string;
          gross_minutes:       number | null;
          paid_minutes:        number | null;
          late_minutes:        number;
          early_leave_minutes: number;
          overtime_minutes:    number;
        }>(
          `SELECT status, gross_minutes, paid_minutes,
                  late_minutes, early_leave_minutes, overtime_minutes
             FROM attendance_sessions
            WHERE id = $1`,
          [sessionId],
        );
        expect(dbRow.rows).toHaveLength(1);
        const row = dbRow.rows[0];

        expect(row.status).toBe("approved");

        // Recalculation: 09:30 → 17:00 = 450 gross; sched paid = 480 − 30 = 450.
        expect(row.gross_minutes).toBe(450);
        expect(row.paid_minutes).toBe(450);
        expect(row.late_minutes).toBe(30);
        expect(row.early_leave_minutes).toBe(0);
        expect(row.overtime_minutes).toBe(0);
      },
    );

    // ── REJECT ────────────────────────────────────────────────────────────────

    // 14. 404 when session does not exist
    it("reject: returns 404 when the session does not exist", async () => {
      const res = await request(app).post("/admin/attendance/sessions/999999999/reject");
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/not found/i);
    });

    // 15. 409 when session is locked
    it("reject: returns 409 when the session is locked", async () => {
      const sessionId = await seedSession(pool, tmId, { status: "locked" });

      const res = await request(app).post(`/admin/attendance/sessions/${sessionId}/reject`);
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/locked/i);
    });

    // 16. Rejecting a completed session → DB status becomes 'rejected'
    it("reject: completed session → status becomes 'rejected' in the DB", async () => {
      const sessionId = await seedSession(pool, tmId, { status: "completed" });

      const res = await request(app).post(`/admin/attendance/sessions/${sessionId}/reject`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      expect(await getSessionStatus(pool, sessionId)).toBe("rejected");
    });

    // 17. Reject persists manager_note in the DB
    it("reject: manager_note is persisted in the DB", async () => {
      const sessionId = await seedSession(pool, tmId, { status: "completed" });

      const res = await request(app)
        .post(`/admin/attendance/sessions/${sessionId}/reject`)
        .send({ manager_note: "Hours do not match timesheet records" });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const dbRow = await pool.query<{ manager_note: string | null }>(
        `SELECT manager_note FROM attendance_sessions WHERE id = $1`,
        [sessionId],
      );
      expect(dbRow.rows[0]?.manager_note).toBe("Hours do not match timesheet records");
    });

    // 18. Reject writes a 'session_rejected' audit log entry
    it("reject: writes a 'session_rejected' audit log entry", async () => {
      const sessionId = await seedSession(pool, tmId, { status: "completed" });

      await request(app).post(`/admin/attendance/sessions/${sessionId}/reject`);

      const logs = await getAuditLogs(pool, sessionId);
      expect(logs.length).toBeGreaterThanOrEqual(1);
      expect(logs.some((l) => l.action === "session_rejected")).toBe(true);
    });

    // ── PATCH on rejected session ──────────────────────────────────────────────

    // 19. PATCH a rejected session → 409
    it("patch: returns 409 when the session status is 'rejected'", async () => {
      const sessionId = await seedSession(pool, tmId, { status: "rejected" });

      const res = await request(app)
        .patch(`/admin/attendance/sessions/${sessionId}`)
        .send({ manager_note: "trying to edit a rejected session" });

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/rejected/i);
    });

    // 20. PATCH a rejected session does not change any DB fields
    it("patch: rejected session is not modified in the DB", async () => {
      const sessionId = await seedSession(pool, tmId, { status: "rejected" });

      await request(app)
        .patch(`/admin/attendance/sessions/${sessionId}`)
        .send({ manager_note: "should not persist" });

      const dbRow = await pool.query<{ manager_note: string | null }>(
        `SELECT manager_note FROM attendance_sessions WHERE id = $1`,
        [sessionId],
      );
      expect(dbRow.rows[0]?.manager_note).toBeNull();
    });

    // 21. PATCH a rejected session error message mentions 'Reopen'
    it("patch: rejected session error message instructs the caller to reopen first", async () => {
      const sessionId = await seedSession(pool, tmId, { status: "rejected" });

      const res = await request(app)
        .patch(`/admin/attendance/sessions/${sessionId}`)
        .send({ break_minutes: 15 });

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/reopen/i);
    });
  },
);
