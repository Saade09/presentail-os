/**
 * Integration test: attendance adjustment request flow.
 *
 * Exercises POST /attendance/requests and the admin approve/reject endpoints
 * against a real PostgreSQL instance to verify that multi-step DB writes,
 * status transitions, and session mutations behave correctly under real SQL
 * constraints (not mocked away by unit tests).
 *
 * Tests:
 *   1. Create a request with a valid type → 201, row persisted.
 *   2. Create a request with an invalid type → 400, no row written.
 *   3. Create a second pending request for the same session — application guard
 *      returns 409 and only one pending row exists.
 *   4. Create a second standalone (no session) pending request for the same
 *      type — both the application guard and the DB-level partial unique index
 *      prevent it → 409, only one pending row.
 *   5. Approve a standalone request (no linked session) → status = 'approved',
 *      audit log written.
 *   6. Approve a request linked to a session with requested_clock_out_at →
 *      session.clock_out_at is updated, minute fields recalculated.
 *   7. Reject a pending request → status = 'rejected', audit log written.
 *   8. Approve an already-approved (non-pending) request → 409.
 *   9. Approve a request that does not exist → 404.
 *  10. No team member record → 403 on POST /attendance/requests.
 *  13. Approve missed_clock_in a second time when a session already exists for
 *      that employee + clock-in time → 409 (idempotency guard).
 *  13b. Approve offsite_clock_in a second time when a session already exists for
 *       that employee + clock-in time → 409 (idempotency guard).
 *  16. Bulk-approve two missed_clock_out requests for the same employee and
 *      same requested_clock_out_at → one success:true, one success:false
 *      (duplicate), only one attendance_sessions row created.
 *  17. Bulk-approve two missed_clock_in requests (missed_clock_in +
 *      offsite_clock_in) for the same employee and same requested_clock_in_at
 *      → one success:true, one success:false (duplicate), only one
 *      attendance_sessions row created.
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

const OWNER_ID        = "__att_adj_req_integ__";
const USER_ID         = "__att_adj_req_user__";
const MANAGER_USER_ID = "__att_adj_req_mgr__";

// User that has NO team_members row — for the 403 test.
const USER_ID_NO_MEMBER = "__att_adj_req_nomember__";

// ─────────────────────────────────────────────────────────────────────────────
// Mocks — only auth / workspace / logger / SSE / push.  db uses the real module.
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("../lib/auth", () => ({
  requireAuth: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => next(),
  authed: (req: express.Request) => req,
}));

let activeUserId   = USER_ID;
let activeUserRole: "owner" | "member" = "owner";

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId    = OWNER_ID;
    wreq.workspaceRole       = activeUserRole;
    wreq.workspaceActualRole = activeUserRole;
    wreq.userId    = activeUserId;
    wreq.userEmail = "att-adj-req-test@example.com";
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
  sendExpoPushNotification: vi.fn().mockResolvedValue({ success: true }),
}));

// Imports MUST follow vi.mock declarations (hoisting boundary).
import attendanceMobileRouter from "./attendanceMobile";
import attendanceAdminRouter  from "./attendanceAdmin";

// ─────────────────────────────────────────────────────────────────────────────
// App factory — mounts both routers so we can exercise create + approve/reject.
// ─────────────────────────────────────────────────────────────────────────────

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(attendanceMobileRouter);
  app.use(attendanceAdminRouter);
  return app;
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
    `DELETE FROM attendance_requests WHERE workspace_owner_id = $1`,
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

async function seedWorkspaceMember(
  pool: InstanceType<typeof Pool>,
  userId = USER_ID,
): Promise<number> {
  const r = await pool.query<{ id: number }>(
    `INSERT INTO workspace_members
       (workspace_owner_id, member_user_id, member_email, role)
     VALUES ($1, $2, 'att-adj-req-test@example.com', 'member')
     RETURNING id`,
    [OWNER_ID, userId],
  );
  return r.rows[0].id;
}

async function seedTeamMember(
  pool: InstanceType<typeof Pool>,
  memberDbId: number,
  opts: { locationId?: number | null; managerId?: number | null } = {},
): Promise<number> {
  const r = await pool.query<{ id: number }>(
    `INSERT INTO team_members
       (workspace_owner_id, member_db_id, first_name, location_id, manager_id)
     VALUES ($1, $2, 'AdjReqTest', $3, $4)
     RETURNING id`,
    [OWNER_ID, memberDbId, opts.locationId ?? null, opts.managerId ?? null],
  );
  return r.rows[0].id;
}

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

async function seedOpenSession(
  pool: InstanceType<typeof Pool>,
  employeeId: number,
): Promise<number> {
  const r = await pool.query<{ id: number }>(
    `INSERT INTO attendance_sessions
       (workspace_owner_id, employee_id, clock_in_at,
        clock_in_verification_status, status)
     VALUES ($1, $2, NOW() - INTERVAL '4 hours', 'no_location', 'open')
     RETURNING id`,
    [OWNER_ID, employeeId],
  );
  return r.rows[0].id;
}

async function seedCompletedSession(
  pool: InstanceType<typeof Pool>,
  employeeId: number,
  opts: { clockInAt?: string; clockOutAt?: string } = {},
): Promise<number> {
  const clockIn  = opts.clockInAt  ?? new Date(Date.now() - 8 * 3600_000).toISOString();
  const clockOut = opts.clockOutAt ?? new Date(Date.now() - 1 * 3600_000).toISOString();
  const r = await pool.query<{ id: number }>(
    `INSERT INTO attendance_sessions
       (workspace_owner_id, employee_id,
        clock_in_at, clock_out_at,
        clock_in_verification_status, clock_out_verification_status,
        gross_minutes, paid_minutes, status)
     VALUES ($1, $2, $3, $4, 'verified', 'verified', 420, 420, 'completed')
     RETURNING id`,
    [OWNER_ID, employeeId, clockIn, clockOut],
  );
  return r.rows[0].id;
}

async function seedLockedSession(
  pool: InstanceType<typeof Pool>,
  employeeId: number,
): Promise<number> {
  const clockIn  = new Date(Date.now() - 8 * 3600_000).toISOString();
  const clockOut = new Date(Date.now() - 1 * 3600_000).toISOString();
  const r = await pool.query<{ id: number }>(
    `INSERT INTO attendance_sessions
       (workspace_owner_id, employee_id,
        clock_in_at, clock_out_at,
        clock_in_verification_status, clock_out_verification_status,
        gross_minutes, paid_minutes, status)
     VALUES ($1, $2, $3, $4, 'verified', 'verified', 420, 420, 'locked')
     RETURNING id`,
    [OWNER_ID, employeeId, clockIn, clockOut],
  );
  return r.rows[0].id;
}

/** Insert a pending attendance_request directly into the DB. */
async function seedRequest(
  pool: InstanceType<typeof Pool>,
  employeeId: number,
  requestType: string,
  sessionId: number | null = null,
): Promise<number> {
  const r = await pool.query<{ id: number }>(
    `INSERT INTO attendance_requests
       (workspace_owner_id, employee_id, attendance_session_id, request_type,
        reason, status)
     VALUES ($1, $2, $3, $4, 'Integration test seed', 'pending')
     RETURNING id`,
    [OWNER_ID, employeeId, sessionId, requestType],
  );
  return r.rows[0].id;
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!DATABASE_URL)(
  "Attendance adjustment request flow — create, approve, reject (integration)",
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
      await cleanup(pool);
      activeUserId   = USER_ID;
      activeUserRole = "owner";
    });

    // ── 1. Create a valid adjustment request ─────────────────────────────────

    it(
      "POST /attendance/requests — valid request_type creates a pending row " +
      "and returns 201",
      async () => {
        const wmId = await seedWorkspaceMember(pool);
        const tmId = await seedTeamMember(pool, wmId);
        await seedProfile(pool, tmId);

        const res = await request(app)
          .post("/attendance/requests")
          .send({
            request_type: "missed_clock_in",
            reason: "Forgot to clock in this morning",
          });

        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.request).toBeDefined();
        expect(typeof res.body.request.id).toBe("number");

        // Confirm the row was persisted with status = 'pending'.
        const dbRow = await pool.query<{ status: string; request_type: string }>(
          `SELECT status, request_type
             FROM attendance_requests
            WHERE workspace_owner_id = $1`,
          [OWNER_ID],
        );
        expect(dbRow.rows).toHaveLength(1);
        expect(dbRow.rows[0].status).toBe("pending");
        expect(dbRow.rows[0].request_type).toBe("missed_clock_in");
      },
    );

    // ── 2. Invalid request_type is rejected before any DB write ──────────────

    it(
      "POST /attendance/requests — invalid request_type returns 400 and " +
      "writes no row to the database",
      async () => {
        const wmId = await seedWorkspaceMember(pool);
        const tmId = await seedTeamMember(pool, wmId);
        await seedProfile(pool, tmId);

        const res = await request(app)
          .post("/attendance/requests")
          .send({ request_type: "not_a_valid_type" });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/request_type must be one of/i);

        const countResult = await pool.query<{ cnt: string }>(
          `SELECT COUNT(*) AS cnt FROM attendance_requests
            WHERE workspace_owner_id = $1`,
          [OWNER_ID],
        );
        expect(Number(countResult.rows[0].cnt)).toBe(0);
      },
    );

    // ── 3. No DB constraint prevents a second pending request ─────────────────

    it(
      "POST /attendance/requests — duplicate pending request for the same " +
      "session and type is rejected with 409",
      async () => {
        const wmId = await seedWorkspaceMember(pool);
        const tmId = await seedTeamMember(pool, wmId);
        await seedProfile(pool, tmId);
        const sessionId = await seedOpenSession(pool, tmId);

        const first = await request(app)
          .post("/attendance/requests")
          .send({ request_type: "offsite_clock_in", attendance_session_id: sessionId });
        expect(first.status).toBe(201);

        const second = await request(app)
          .post("/attendance/requests")
          .send({ request_type: "offsite_clock_in", attendance_session_id: sessionId });
        expect(second.status).toBe(409);
        expect(second.body.error).toMatch(/pending request.*already exists/i);

        // Only the first row should be present.
        const countResult = await pool.query<{ cnt: string }>(
          `SELECT COUNT(*) AS cnt FROM attendance_requests
            WHERE workspace_owner_id = $1 AND status = 'pending'`,
          [OWNER_ID],
        );
        expect(Number(countResult.rows[0].cnt)).toBe(1);
      },
    );

    // ── 4. Duplicate standalone (no session) pending request is rejected ────────

    it(
      "POST /attendance/requests — second pending request with the same type " +
      "and no linked session is rejected with 409 (app guard + DB index)",
      async () => {
        const wmId = await seedWorkspaceMember(pool);
        const tmId = await seedTeamMember(pool, wmId);
        await seedProfile(pool, tmId);

        // First standalone request — no attendance_session_id.
        const first = await request(app)
          .post("/attendance/requests")
          .send({ request_type: "other", reason: "First standalone request" });
        expect(first.status).toBe(201);

        // Second standalone request — same type, still no session.
        const second = await request(app)
          .post("/attendance/requests")
          .send({ request_type: "other", reason: "Duplicate standalone request" });
        expect(second.status).toBe(409);
        expect(second.body.error).toMatch(/pending request.*already exists/i);

        // Only the first row should be present.
        const countResult = await pool.query<{ cnt: string }>(
          `SELECT COUNT(*) AS cnt FROM attendance_requests
            WHERE workspace_owner_id = $1 AND status = 'pending'`,
          [OWNER_ID],
        );
        expect(Number(countResult.rows[0].cnt)).toBe(1);

        // Verify the DB index itself blocks a direct insert (bypassing app layer).
        await expect(
          pool.query(
            `INSERT INTO attendance_requests
               (workspace_owner_id, employee_id, attendance_session_id,
                request_type, reason, status)
             VALUES ($1, $2, NULL, 'other', 'Direct insert bypass', 'pending')`,
            [OWNER_ID, tmId],
          ),
        ).rejects.toThrow(/unique/i);
      },
    );

    // ── 5. User with no team_members row gets 403 ─────────────────────────────

    it(
      "POST /attendance/requests — user with no team_members row returns 403",
      async () => {
        activeUserId = USER_ID_NO_MEMBER;
        await seedWorkspaceMember(pool, USER_ID_NO_MEMBER);

        const res = await request(app)
          .post("/attendance/requests")
          .send({ request_type: "other", reason: "test" });

        expect(res.status).toBe(403);
        expect(res.body.error).toMatch(/No team member record/i);

        const countResult = await pool.query<{ cnt: string }>(
          `SELECT COUNT(*) AS cnt FROM attendance_requests WHERE workspace_owner_id = $1`,
          [OWNER_ID],
        );
        expect(Number(countResult.rows[0].cnt)).toBe(0);
      },
    );

    // ── 5. Approve a standalone request (no linked session) ───────────────────

    it(
      "POST /admin/attendance/requests/:id/approve — pending request with no " +
      "linked session is approved; status transitions to 'approved' and an " +
      "audit log row is written",
      async () => {
        const wmId  = await seedWorkspaceMember(pool);
        const tmId  = await seedTeamMember(pool, wmId);
        await seedProfile(pool, tmId);

        const requestId = await seedRequest(pool, tmId, "other");

        const res = await request(app)
          .post(`/admin/attendance/requests/${requestId}/approve`)
          .send({ reviewer_note: "Looks good" });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        // Verify DB state.
        const dbRow = await pool.query<{
          status: string;
          reviewed_by: string | null;
          reviewer_note: string | null;
        }>(
          `SELECT status, reviewed_by, reviewer_note
             FROM attendance_requests WHERE id = $1`,
          [requestId],
        );
        expect(dbRow.rows).toHaveLength(1);
        expect(dbRow.rows[0].status).toBe("approved");
        expect(dbRow.rows[0].reviewed_by).toBe(USER_ID);
        expect(dbRow.rows[0].reviewer_note).toBe("Looks good");

        // Audit log.
        const auditRow = await pool.query<{ action: string }>(
          `SELECT action FROM attendance_audit_logs
            WHERE workspace_owner_id = $1 AND attendance_request_id = $2`,
          [OWNER_ID, requestId],
        );
        expect(auditRow.rows).toHaveLength(1);
        expect(auditRow.rows[0].action).toBe("request_approved");
      },
    );

    // ── 6. Approve a request linked to a session — clock_out_at applied ───────

    it(
      "POST /admin/attendance/requests/:id/approve — request linked to a " +
      "completed session with requested_clock_out_at updates the session's " +
      "clock_out_at and recalculates paid_minutes",
      async () => {
        const wmId = await seedWorkspaceMember(pool);
        const tmId = await seedTeamMember(pool, wmId);
        await seedProfile(pool, tmId);

        const clockIn  = new Date(Date.now() - 8 * 3600_000).toISOString();
        const clockOut = new Date(Date.now() - 1 * 3600_000).toISOString();
        const sessionId = await seedCompletedSession(pool, tmId, {
          clockInAt:  clockIn,
          clockOutAt: clockOut,
        });

        // Request to edit the clock-out to 30 minutes later.
        const newClockOut = new Date(Date.now() - 30 * 60_000).toISOString();
        const requestId = await pool.query<{ id: number }>(
          `INSERT INTO attendance_requests
             (workspace_owner_id, employee_id, attendance_session_id,
              request_type, requested_clock_out_at, reason, status)
           VALUES ($1, $2, $3, 'edit_clock_out', $4, 'Left later', 'pending')
           RETURNING id`,
          [OWNER_ID, tmId, sessionId, newClockOut],
        ).then((r) => r.rows[0].id);

        const res = await request(app)
          .post(`/admin/attendance/requests/${requestId}/approve`)
          .send({});

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        // Session's clock_out_at should now equal the requested value.
        const sessionRow = await pool.query<{
          clock_out_at: Date;
          paid_minutes: number | null;
        }>(
          `SELECT clock_out_at, paid_minutes
             FROM attendance_sessions WHERE id = $1`,
          [sessionId],
        );
        expect(sessionRow.rows).toHaveLength(1);
        const storedOut = new Date(sessionRow.rows[0].clock_out_at).toISOString();
        expect(storedOut).toBe(new Date(newClockOut).toISOString());
        // paid_minutes should have been recalculated (positive number).
        expect(Number(sessionRow.rows[0].paid_minutes)).toBeGreaterThan(0);
      },
    );

    // ── 7. Reject a pending request ───────────────────────────────────────────

    it(
      "POST /admin/attendance/requests/:id/reject — pending request is " +
      "rejected; status becomes 'rejected' and an audit log row is written",
      async () => {
        const wmId = await seedWorkspaceMember(pool);
        const tmId = await seedTeamMember(pool, wmId);
        await seedProfile(pool, tmId);

        const requestId = await seedRequest(pool, tmId, "missed_clock_out");

        const res = await request(app)
          .post(`/admin/attendance/requests/${requestId}/reject`)
          .send({ reviewer_note: "No supporting evidence provided" });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        const dbRow = await pool.query<{
          status: string;
          reviewed_by: string | null;
          reviewer_note: string | null;
        }>(
          `SELECT status, reviewed_by, reviewer_note
             FROM attendance_requests WHERE id = $1`,
          [requestId],
        );
        expect(dbRow.rows).toHaveLength(1);
        expect(dbRow.rows[0].status).toBe("rejected");
        expect(dbRow.rows[0].reviewed_by).toBe(USER_ID);
        expect(dbRow.rows[0].reviewer_note).toBe("No supporting evidence provided");

        // Audit log.
        const auditRow = await pool.query<{ action: string }>(
          `SELECT action FROM attendance_audit_logs
            WHERE workspace_owner_id = $1 AND attendance_request_id = $2`,
          [OWNER_ID, requestId],
        );
        expect(auditRow.rows).toHaveLength(1);
        expect(auditRow.rows[0].action).toBe("request_rejected");
      },
    );

    // ── 8. Approve a non-pending request → 409 ────────────────────────────────

    it(
      "POST /admin/attendance/requests/:id/approve — already-approved request " +
      "returns 409",
      async () => {
        const wmId = await seedWorkspaceMember(pool);
        const tmId = await seedTeamMember(pool, wmId);
        await seedProfile(pool, tmId);

        // Seed a request that is already approved.
        const requestId = await pool.query<{ id: number }>(
          `INSERT INTO attendance_requests
             (workspace_owner_id, employee_id, request_type, reason, status,
              reviewed_by, reviewed_at)
           VALUES ($1, $2, 'other', 'Previously approved', 'approved',
                   $3, now())
           RETURNING id`,
          [OWNER_ID, tmId, USER_ID],
        ).then((r) => r.rows[0].id);

        const res = await request(app)
          .post(`/admin/attendance/requests/${requestId}/approve`)
          .send({});

        expect(res.status).toBe(409);
        expect(res.body.error).toMatch(/not pending/i);
      },
    );

    // ── 9. Approve a request that does not exist → 404 ────────────────────────

    it(
      "POST /admin/attendance/requests/:id/approve — non-existent request id " +
      "returns 404",
      async () => {
        const res = await request(app)
          .post("/admin/attendance/requests/999999999/approve")
          .send({});

        expect(res.status).toBe(404);
        expect(res.body.error).toMatch(/not found/i);
      },
    );

    // ── 10. Approve a request linked to a locked session → 409 ───────────────

    it(
      "POST /admin/attendance/requests/:id/approve — request linked to a " +
      "locked session returns 409 with an error matching 'locked'",
      async () => {
        const wmId = await seedWorkspaceMember(pool);
        const tmId = await seedTeamMember(pool, wmId);
        await seedProfile(pool, tmId);

        const sessionId = await seedLockedSession(pool, tmId);
        const requestId = await seedRequest(pool, tmId, "edit_clock_out", sessionId);

        const res = await request(app)
          .post(`/admin/attendance/requests/${requestId}/approve`)
          .send({});

        expect(res.status).toBe(409);
        expect(res.body.error).toMatch(/locked/i);

        // The request must remain pending — no mutation should have occurred.
        const dbRow = await pool.query<{ status: string }>(
          `SELECT status FROM attendance_requests WHERE id = $1`,
          [requestId],
        );
        expect(dbRow.rows[0].status).toBe("pending");
      },
    );

    // ── 11. Approve missed_clock_in with no linked session → new session created

    it(
      "POST /admin/attendance/requests/:id/approve — missed_clock_in with no " +
      "attendance_session_id creates a new attendance_sessions row with the " +
      "requested clock-in time and links it back to the request",
      async () => {
        const wmId = await seedWorkspaceMember(pool);
        const tmId = await seedTeamMember(pool, wmId);
        await seedProfile(pool, tmId);

        const requestedClockIn = new Date(Date.now() - 6 * 3600_000).toISOString();

        // Seed a missed_clock_in request with no linked session
        const requestId = await pool.query<{ id: number }>(
          `INSERT INTO attendance_requests
             (workspace_owner_id, employee_id, attendance_session_id,
              request_type, requested_clock_in_at, reason, status)
           VALUES ($1, $2, NULL, 'missed_clock_in', $3, 'Forgot to clock in', 'pending')
           RETURNING id`,
          [OWNER_ID, tmId, requestedClockIn],
        ).then((r) => r.rows[0].id);

        // Confirm no session exists before approval
        const beforeCount = await pool.query<{ cnt: string }>(
          `SELECT COUNT(*) AS cnt FROM attendance_sessions
            WHERE workspace_owner_id = $1 AND employee_id = $2`,
          [OWNER_ID, tmId],
        );
        expect(Number(beforeCount.rows[0].cnt)).toBe(0);

        const res = await request(app)
          .post(`/admin/attendance/requests/${requestId}/approve`)
          .send({ reviewer_note: "Approved — missed punch confirmed" });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        // A new attendance_sessions row must now exist for the employee
        const sessionRows = await pool.query<{
          id: number;
          clock_in_at: Date;
          status: string;
          clock_in_verification_status: string;
        }>(
          `SELECT id, clock_in_at, status, clock_in_verification_status
             FROM attendance_sessions
            WHERE workspace_owner_id = $1 AND employee_id = $2`,
          [OWNER_ID, tmId],
        );
        expect(sessionRows.rows).toHaveLength(1);
        const session = sessionRows.rows[0];
        expect(session.status).toBe("open");
        expect(new Date(session.clock_in_at).toISOString()).toBe(
          new Date(requestedClockIn).toISOString(),
        );

        // The request row must now reference the newly created session
        const reqRow = await pool.query<{
          status: string;
          attendance_session_id: number | null;
        }>(
          `SELECT status, attendance_session_id
             FROM attendance_requests WHERE id = $1`,
          [requestId],
        );
        expect(reqRow.rows).toHaveLength(1);
        expect(reqRow.rows[0].status).toBe("approved");
        expect(reqRow.rows[0].attendance_session_id).toBe(session.id);
      },
    );

    // ── 12. Approve missed_clock_out with no linked session → new session created

    it(
      "POST /admin/attendance/requests/:id/approve — missed_clock_out with no " +
      "attendance_session_id creates a new completed attendance_sessions row " +
      "with clock_out_at matching requested_clock_out_at and links it back",
      async () => {
        const wmId = await seedWorkspaceMember(pool);
        const tmId = await seedTeamMember(pool, wmId);
        await seedProfile(pool, tmId);

        const requestedClockOut = new Date(Date.now() - 2 * 3600_000).toISOString();

        // Seed a missed_clock_out request with no linked session
        const requestId = await pool.query<{ id: number }>(
          `INSERT INTO attendance_requests
             (workspace_owner_id, employee_id, attendance_session_id,
              request_type, requested_clock_out_at, reason, status)
           VALUES ($1, $2, NULL, 'missed_clock_out', $3, 'Forgot to clock out', 'pending')
           RETURNING id`,
          [OWNER_ID, tmId, requestedClockOut],
        ).then((r) => r.rows[0].id);

        // Confirm no session exists before approval
        const beforeCount = await pool.query<{ cnt: string }>(
          `SELECT COUNT(*) AS cnt FROM attendance_sessions
            WHERE workspace_owner_id = $1 AND employee_id = $2`,
          [OWNER_ID, tmId],
        );
        expect(Number(beforeCount.rows[0].cnt)).toBe(0);

        const res = await request(app)
          .post(`/admin/attendance/requests/${requestId}/approve`)
          .send({ reviewer_note: "Approved — missed punch confirmed" });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        // A new attendance_sessions row must now exist for the employee
        const sessionRows = await pool.query<{
          id: number;
          clock_out_at: Date;
          status: string;
          clock_out_verification_status: string;
        }>(
          `SELECT id, clock_out_at, status, clock_out_verification_status
             FROM attendance_sessions
            WHERE workspace_owner_id = $1 AND employee_id = $2`,
          [OWNER_ID, tmId],
        );
        expect(sessionRows.rows).toHaveLength(1);
        const session = sessionRows.rows[0];
        expect(session.status).toBe("completed");
        expect(new Date(session.clock_out_at).toISOString()).toBe(
          new Date(requestedClockOut).toISOString(),
        );

        // The request row must now reference the newly created session
        const reqRow = await pool.query<{
          status: string;
          attendance_session_id: number | null;
        }>(
          `SELECT status, attendance_session_id
             FROM attendance_requests WHERE id = $1`,
          [requestId],
        );
        expect(reqRow.rows).toHaveLength(1);
        expect(reqRow.rows[0].status).toBe("approved");
        expect(reqRow.rows[0].attendance_session_id).toBe(session.id);
      },
    );

    // ── 12b. Approve offsite_clock_out with no linked session → new session created

    it(
      "POST /admin/attendance/requests/:id/approve — offsite_clock_out with no " +
      "attendance_session_id creates a new completed attendance_sessions row " +
      "with clock_out_at matching requested_clock_out_at and links it back",
      async () => {
        const wmId = await seedWorkspaceMember(pool);
        const tmId = await seedTeamMember(pool, wmId);
        await seedProfile(pool, tmId);

        const requestedClockOut = new Date(Date.now() - 3 * 3600_000).toISOString();

        // Seed an offsite_clock_out request with no linked session
        const requestId = await pool.query<{ id: number }>(
          `INSERT INTO attendance_requests
             (workspace_owner_id, employee_id, attendance_session_id,
              request_type, requested_clock_out_at, reason, status)
           VALUES ($1, $2, NULL, 'offsite_clock_out', $3, 'Worked offsite, forgot to punch', 'pending')
           RETURNING id`,
          [OWNER_ID, tmId, requestedClockOut],
        ).then((r) => r.rows[0].id);

        // Confirm no session exists before approval
        const beforeCount = await pool.query<{ cnt: string }>(
          `SELECT COUNT(*) AS cnt FROM attendance_sessions
            WHERE workspace_owner_id = $1 AND employee_id = $2`,
          [OWNER_ID, tmId],
        );
        expect(Number(beforeCount.rows[0].cnt)).toBe(0);

        const res = await request(app)
          .post(`/admin/attendance/requests/${requestId}/approve`)
          .send({ reviewer_note: "Approved — offsite punch confirmed" });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        // A new attendance_sessions row must now exist for the employee
        const sessionRows = await pool.query<{
          id: number;
          clock_out_at: Date;
          status: string;
        }>(
          `SELECT id, clock_out_at, status
             FROM attendance_sessions
            WHERE workspace_owner_id = $1 AND employee_id = $2`,
          [OWNER_ID, tmId],
        );
        expect(sessionRows.rows).toHaveLength(1);
        const session = sessionRows.rows[0];
        expect(session.status).toBe("completed");
        expect(new Date(session.clock_out_at).toISOString()).toBe(
          new Date(requestedClockOut).toISOString(),
        );

        // The request row must now reference the newly created session
        const reqRow = await pool.query<{
          status: string;
          attendance_session_id: number | null;
        }>(
          `SELECT status, attendance_session_id
             FROM attendance_requests WHERE id = $1`,
          [requestId],
        );
        expect(reqRow.rows).toHaveLength(1);
        expect(reqRow.rows[0].status).toBe("approved");
        expect(reqRow.rows[0].attendance_session_id).toBe(session.id);
      },
    );

    // ── 12c. Approve offsite_clock_in with no linked session → new session created

    it(
      "POST /admin/attendance/requests/:id/approve — offsite_clock_in with no " +
      "attendance_session_id creates a new attendance_sessions row with " +
      "clock_in_at matching requested_clock_in_at and links it back",
      async () => {
        const wmId = await seedWorkspaceMember(pool);
        const tmId = await seedTeamMember(pool, wmId);
        await seedProfile(pool, tmId);

        const requestedClockIn = new Date(Date.now() - 4 * 3600_000).toISOString();

        // Seed an offsite_clock_in request with no linked session
        const requestId = await pool.query<{ id: number }>(
          `INSERT INTO attendance_requests
             (workspace_owner_id, employee_id, attendance_session_id,
              request_type, requested_clock_in_at, reason, status)
           VALUES ($1, $2, NULL, 'offsite_clock_in', $3, 'Clocked in from offsite location', 'pending')
           RETURNING id`,
          [OWNER_ID, tmId, requestedClockIn],
        ).then((r) => r.rows[0].id);

        // Confirm no session exists before approval
        const beforeCount = await pool.query<{ cnt: string }>(
          `SELECT COUNT(*) AS cnt FROM attendance_sessions
            WHERE workspace_owner_id = $1 AND employee_id = $2`,
          [OWNER_ID, tmId],
        );
        expect(Number(beforeCount.rows[0].cnt)).toBe(0);

        const res = await request(app)
          .post(`/admin/attendance/requests/${requestId}/approve`)
          .send({ reviewer_note: "Approved — offsite clock-in confirmed" });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        // A new attendance_sessions row must now exist for the employee
        const sessionRows = await pool.query<{
          id: number;
          clock_in_at: Date;
          status: string;
        }>(
          `SELECT id, clock_in_at, status
             FROM attendance_sessions
            WHERE workspace_owner_id = $1 AND employee_id = $2`,
          [OWNER_ID, tmId],
        );
        expect(sessionRows.rows).toHaveLength(1);
        const session = sessionRows.rows[0];
        expect(session.status).toBe("open");
        expect(new Date(session.clock_in_at).toISOString()).toBe(
          new Date(requestedClockIn).toISOString(),
        );

        // The request row must now reference the newly created session
        const reqRow = await pool.query<{
          status: string;
          attendance_session_id: number | null;
        }>(
          `SELECT status, attendance_session_id
             FROM attendance_requests WHERE id = $1`,
          [requestId],
        );
        expect(reqRow.rows).toHaveLength(1);
        expect(reqRow.rows[0].status).toBe("approved");
        expect(reqRow.rows[0].attendance_session_id).toBe(session.id);
      },
    );

    // ── 13b. Double-approve offsite_clock_in → 409 (idempotency guard) ──────
    //
    // This test mirrors test 13 but for the offsite_clock_in type, which
    // follows the same code path (INSERT into attendance_sessions keyed on
    // employee_id + clock_in_at) and therefore must also be blocked by the
    // same DB unique constraint (23505).

    it(
      "POST /admin/attendance/requests/:id/approve — second approval of an " +
      "offsite_clock_in request when a session for that employee + clock-in " +
      "time already exists returns 409 (DB unique constraint fires)",
      async () => {
        const wmId = await seedWorkspaceMember(pool);
        const tmId = await seedTeamMember(pool, wmId);
        await seedProfile(pool, tmId);

        const requestedClockIn = new Date(Date.now() - 6 * 3600_000).toISOString();

        // Seed an offsite_clock_in request with no linked session.
        const requestId = await pool.query<{ id: number }>(
          `INSERT INTO attendance_requests
             (workspace_owner_id, employee_id, attendance_session_id,
              request_type, requested_clock_in_at, reason, status)
           VALUES ($1, $2, NULL, 'offsite_clock_in', $3, 'Duplicate guard test offsite', 'pending')
           RETURNING id`,
          [OWNER_ID, tmId, requestedClockIn],
        ).then((r) => r.rows[0].id);

        // First approval — must succeed and create a session.
        const first = await request(app)
          .post(`/admin/attendance/requests/${requestId}/approve`)
          .send({});
        expect(first.status).toBe(200);
        expect(first.body.success).toBe(true);

        // Confirm one session now exists.
        const afterFirst = await pool.query<{ cnt: string }>(
          `SELECT COUNT(*) AS cnt FROM attendance_sessions
            WHERE workspace_owner_id = $1 AND employee_id = $2`,
          [OWNER_ID, tmId],
        );
        expect(Number(afterFirst.rows[0].cnt)).toBe(1);

        // Verify the DB-level unique constraint fires directly: a bare INSERT
        // (no ON CONFLICT clause) for the same employee_id + clock_in_at must
        // raise error code 23505.
        let constraintCode: string | undefined;
        try {
          await pool.query(
            `INSERT INTO attendance_sessions
               (workspace_owner_id, employee_id, clock_in_at,
                clock_in_verification_status, status)
             VALUES ($1, $2, $3, 'no_location', 'open')`,
            [OWNER_ID, tmId, requestedClockIn],
          );
        } catch (err: unknown) {
          constraintCode = (err as { code?: string }).code;
        }
        expect(constraintCode).toBe("23505");

        // Simulate a race / admin error: reset the request back to 'pending'
        // without touching attendance_session_id (mirrors a concurrent read
        // that saw 'pending' before the first approval committed).
        await pool.query(
          `UPDATE attendance_requests
              SET status = 'pending', attendance_session_id = NULL
            WHERE id = $1`,
          [requestId],
        );

        // Second approval — the approve handler must catch the 23505 from the
        // DB unique constraint and return 409 instead of letting a 500 propagate.
        const second = await request(app)
          .post(`/admin/attendance/requests/${requestId}/approve`)
          .send({});
        expect(second.status).toBe(409);
        expect(second.body.error).toMatch(/already exists/i);

        // No duplicate session must have been inserted.
        const afterSecond = await pool.query<{ cnt: string }>(
          `SELECT COUNT(*) AS cnt FROM attendance_sessions
            WHERE workspace_owner_id = $1 AND employee_id = $2`,
          [OWNER_ID, tmId],
        );
        expect(Number(afterSecond.rows[0].cnt)).toBe(1);
      },
    );

    // ── 13. Double-approve missed_clock_in → 409 (idempotency guard) ─────────
    //
    // This test verifies two layers of protection:
    //   a) The approve endpoint catches a DB unique-constraint violation (23505)
    //      on attendance_sessions(employee_id, clock_in_at) and returns 409.
    //   b) A bare INSERT without ON CONFLICT also raises 23505, confirming the
    //      DB-level index is the unconditional guard.

    it(
      "POST /admin/attendance/requests/:id/approve — second approval of a " +
      "missed_clock_in request when a session for that employee + clock-in " +
      "time already exists returns 409 (DB unique constraint fires)",
      async () => {
        const wmId = await seedWorkspaceMember(pool);
        const tmId = await seedTeamMember(pool, wmId);
        await seedProfile(pool, tmId);

        const requestedClockIn = new Date(Date.now() - 7 * 3600_000).toISOString();

        // Seed a missed_clock_in request with no linked session.
        const requestId = await pool.query<{ id: number }>(
          `INSERT INTO attendance_requests
             (workspace_owner_id, employee_id, attendance_session_id,
              request_type, requested_clock_in_at, reason, status)
           VALUES ($1, $2, NULL, 'missed_clock_in', $3, 'Duplicate guard test', 'pending')
           RETURNING id`,
          [OWNER_ID, tmId, requestedClockIn],
        ).then((r) => r.rows[0].id);

        // First approval — must succeed and create a session.
        const first = await request(app)
          .post(`/admin/attendance/requests/${requestId}/approve`)
          .send({});
        expect(first.status).toBe(200);
        expect(first.body.success).toBe(true);

        // Confirm one session now exists.
        const afterFirst = await pool.query<{ cnt: string }>(
          `SELECT COUNT(*) AS cnt FROM attendance_sessions
            WHERE workspace_owner_id = $1 AND employee_id = $2`,
          [OWNER_ID, tmId],
        );
        expect(Number(afterFirst.rows[0].cnt)).toBe(1);

        // Verify the DB-level unique constraint fires directly: a bare INSERT
        // (no ON CONFLICT clause) for the same employee_id + clock_in_at must
        // raise error code 23505.
        let constraintCode: string | undefined;
        try {
          await pool.query(
            `INSERT INTO attendance_sessions
               (workspace_owner_id, employee_id, clock_in_at,
                clock_in_verification_status, status)
             VALUES ($1, $2, $3, 'no_location', 'open')`,
            [OWNER_ID, tmId, requestedClockIn],
          );
        } catch (err: unknown) {
          constraintCode = (err as { code?: string }).code;
        }
        expect(constraintCode).toBe("23505");

        // Simulate a race / admin error: reset the request back to 'pending'
        // without touching attendance_session_id (mirrors a concurrent read
        // that saw 'pending' before the first approval committed).
        await pool.query(
          `UPDATE attendance_requests
              SET status = 'pending', attendance_session_id = NULL
            WHERE id = $1`,
          [requestId],
        );

        // Second approval — the approve handler now catches the 23505 from the
        // DB unique constraint and returns 409 instead of letting a 500 propagate.
        const second = await request(app)
          .post(`/admin/attendance/requests/${requestId}/approve`)
          .send({});
        expect(second.status).toBe(409);
        expect(second.body.error).toMatch(/already exists/i);

        // No duplicate session must have been inserted.
        const afterSecond = await pool.query<{ cnt: string }>(
          `SELECT COUNT(*) AS cnt FROM attendance_sessions
            WHERE workspace_owner_id = $1 AND employee_id = $2`,
          [OWNER_ID, tmId],
        );
        expect(Number(afterSecond.rows[0].cnt)).toBe(1);
      },
    );

    // ── 13c. Duplicate approval of missed_clock_out → 409 ────────────────────
    //   a) First approval creates a session keyed by (employee_id, clock_in_at)
    //      where clock_in_at = requested_clock_out_at.
    //   b) Resetting the request to pending and re-approving triggers the 23505
    //      unique constraint and the handler returns 409.

    it(
      "POST /admin/attendance/requests/:id/approve — second approval of a " +
      "missed_clock_out request when a session for that employee + clock-out " +
      "time already exists returns 409 (DB unique constraint fires)",
      async () => {
        const wmId = await seedWorkspaceMember(pool);
        const tmId = await seedTeamMember(pool, wmId);
        await seedProfile(pool, tmId);

        const requestedClockOut = new Date(Date.now() - 3 * 3600_000).toISOString();

        // Seed a missed_clock_out request with no linked session.
        const requestId = await pool.query<{ id: number }>(
          `INSERT INTO attendance_requests
             (workspace_owner_id, employee_id, attendance_session_id,
              request_type, requested_clock_out_at, reason, status)
           VALUES ($1, $2, NULL, 'missed_clock_out', $3, 'Duplicate guard test', 'pending')
           RETURNING id`,
          [OWNER_ID, tmId, requestedClockOut],
        ).then((r) => r.rows[0].id);

        // First approval — must succeed and create a session.
        const first = await request(app)
          .post(`/admin/attendance/requests/${requestId}/approve`)
          .send({});
        expect(first.status).toBe(200);
        expect(first.body.success).toBe(true);

        // Confirm one session now exists.
        const afterFirst = await pool.query<{ cnt: string }>(
          `SELECT COUNT(*) AS cnt FROM attendance_sessions
            WHERE workspace_owner_id = $1 AND employee_id = $2`,
          [OWNER_ID, tmId],
        );
        expect(Number(afterFirst.rows[0].cnt)).toBe(1);

        // Verify the DB-level unique constraint fires directly: a bare INSERT
        // (no ON CONFLICT clause) for the same employee_id + clock_in_at must
        // raise error code 23505 (clock_in_at = requested_clock_out_at for
        // missed_clock_out sessions).
        let constraintCode: string | undefined;
        try {
          await pool.query(
            `INSERT INTO attendance_sessions
               (workspace_owner_id, employee_id, clock_in_at, clock_out_at,
                clock_in_verification_status, clock_out_verification_status, status)
             VALUES ($1, $2, $3, $3, 'no_location', 'no_location', 'completed')`,
            [OWNER_ID, tmId, requestedClockOut],
          );
        } catch (err: unknown) {
          constraintCode = (err as { code?: string }).code;
        }
        expect(constraintCode).toBe("23505");

        // Simulate a race / admin error: reset the request back to 'pending'
        // without touching attendance_session_id (mirrors a concurrent read
        // that saw 'pending' before the first approval committed).
        await pool.query(
          `UPDATE attendance_requests
              SET status = 'pending', attendance_session_id = NULL
            WHERE id = $1`,
          [requestId],
        );

        // Second approval — the approve handler now catches the 23505 from the
        // DB unique constraint and returns 409 instead of letting a 500 propagate.
        const second = await request(app)
          .post(`/admin/attendance/requests/${requestId}/approve`)
          .send({});
        expect(second.status).toBe(409);
        expect(second.body.error).toMatch(/already exists/i);

        // No duplicate session must have been inserted.
        const afterSecond = await pool.query<{ cnt: string }>(
          `SELECT COUNT(*) AS cnt FROM attendance_sessions
            WHERE workspace_owner_id = $1 AND employee_id = $2`,
          [OWNER_ID, tmId],
        );
        expect(Number(afterSecond.rows[0].cnt)).toBe(1);
      },
    );

    // ── Session-level locked guards ───────────────────────────────────────────

    it(
      "POST /admin/attendance/sessions/:id/approve — locked session returns " +
      "409 with an error matching 'locked' and the session is unchanged",
      async () => {
        const wmId = await seedWorkspaceMember(pool);
        const tmId = await seedTeamMember(pool, wmId);
        await seedProfile(pool, tmId);

        const sessionId = await seedLockedSession(pool, tmId);

        const res = await request(app)
          .post(`/admin/attendance/sessions/${sessionId}/approve`)
          .send({});

        expect(res.status).toBe(409);
        expect(res.body.error).toMatch(/locked/i);

        // The session must remain locked — status must not have changed.
        const dbRow = await pool.query<{ status: string }>(
          `SELECT status FROM attendance_sessions WHERE id = $1`,
          [sessionId],
        );
        expect(dbRow.rows[0].status).toBe("locked");
      },
    );

    it(
      "POST /admin/attendance/sessions/:id/reject — locked session returns " +
      "409 with an error matching 'locked' and the session is unchanged",
      async () => {
        const wmId = await seedWorkspaceMember(pool);
        const tmId = await seedTeamMember(pool, wmId);
        await seedProfile(pool, tmId);

        const sessionId = await seedLockedSession(pool, tmId);

        const res = await request(app)
          .post(`/admin/attendance/sessions/${sessionId}/reject`)
          .send({ manager_note: "Should not apply" });

        expect(res.status).toBe(409);
        expect(res.body.error).toMatch(/locked/i);

        // The session must remain locked — status must not have changed.
        const dbRow = await pool.query<{ status: string; manager_note: string | null }>(
          `SELECT status, manager_note FROM attendance_sessions WHERE id = $1`,
          [sessionId],
        );
        expect(dbRow.rows[0].status).toBe("locked");
        expect(dbRow.rows[0].manager_note).toBeNull();
      },
    );

    it(
      "PATCH /admin/attendance/sessions/:id — locked session returns 409 " +
      "with an error matching 'locked' and the session is unchanged",
      async () => {
        const wmId = await seedWorkspaceMember(pool);
        const tmId = await seedTeamMember(pool, wmId);
        await seedProfile(pool, tmId);

        const sessionId = await seedLockedSession(pool, tmId);

        const res = await request(app)
          .patch(`/admin/attendance/sessions/${sessionId}`)
          .send({ employee_note: "Should not apply" });

        expect(res.status).toBe(409);
        expect(res.body.error).toMatch(/locked/i);

        // The session must remain locked and the note must not have been written.
        const dbRow = await pool.query<{ status: string; employee_note: string | null }>(
          `SELECT status, employee_note FROM attendance_sessions WHERE id = $1`,
          [sessionId],
        );
        expect(dbRow.rows[0].status).toBe("locked");
        expect(dbRow.rows[0].employee_note).toBeNull();
      },
    );

    // ── 14. Bulk-approve missed_clock_out with no linked session → new session created

    it(
      "POST /admin/attendance/requests/bulk-approve — missed_clock_out with no " +
      "attendance_session_id creates a new completed attendance_sessions row " +
      "and links it back; entry in results has success:true",
      async () => {
        const wmId = await seedWorkspaceMember(pool);
        const tmId = await seedTeamMember(pool, wmId);
        await seedProfile(pool, tmId);

        const requestedClockOut = new Date(Date.now() - 2 * 3600_000).toISOString();

        // Seed a missed_clock_out request with no linked session
        const requestId = await pool.query<{ id: number }>(
          `INSERT INTO attendance_requests
             (workspace_owner_id, employee_id, attendance_session_id,
              request_type, requested_clock_out_at, reason, status)
           VALUES ($1, $2, NULL, 'missed_clock_out', $3, 'Forgot to clock out', 'pending')
           RETURNING id`,
          [OWNER_ID, tmId, requestedClockOut],
        ).then((r) => r.rows[0].id);

        // Confirm no session exists before approval
        const beforeCount = await pool.query<{ cnt: string }>(
          `SELECT COUNT(*) AS cnt FROM attendance_sessions
            WHERE workspace_owner_id = $1 AND employee_id = $2`,
          [OWNER_ID, tmId],
        );
        expect(Number(beforeCount.rows[0].cnt)).toBe(0);

        const res = await request(app)
          .post("/admin/attendance/requests/bulk-approve")
          .send({ ids: [requestId] });

        expect(res.status).toBe(200);

        const entry = (res.body.results as { id: number; success: boolean; error?: string }[])
          .find((r) => r.id === requestId);
        expect(entry).toBeDefined();
        expect(entry!.success).toBe(true);

        // A new completed attendance_sessions row must now exist for the employee
        const sessionRows = await pool.query<{
          id: number;
          clock_out_at: Date;
          status: string;
          clock_out_verification_status: string;
        }>(
          `SELECT id, clock_out_at, status, clock_out_verification_status
             FROM attendance_sessions
            WHERE workspace_owner_id = $1 AND employee_id = $2`,
          [OWNER_ID, tmId],
        );
        expect(sessionRows.rows).toHaveLength(1);
        const session = sessionRows.rows[0];
        expect(session.status).toBe("completed");
        expect(new Date(session.clock_out_at).toISOString()).toBe(
          new Date(requestedClockOut).toISOString(),
        );

        // The request row must now reference the newly created session and be approved
        const reqRow = await pool.query<{
          status: string;
          attendance_session_id: number | null;
        }>(
          `SELECT status, attendance_session_id
             FROM attendance_requests WHERE id = $1`,
          [requestId],
        );
        expect(reqRow.rows).toHaveLength(1);
        expect(reqRow.rows[0].status).toBe("approved");
        expect(reqRow.rows[0].attendance_session_id).toBe(session.id);
      },
    );

    // ── 14b. Duplicate bulk-approve of missed_clock_out → success:false ───────
    //   a) First bulk-approve creates a session keyed by (employee_id, clock_in_at)
    //      where clock_in_at = requested_clock_out_at.
    //   b) Resetting the request to pending and re-running bulk-approve triggers
    //      the 23505 unique constraint; the handler records success:false instead
    //      of propagating a 500.

    it(
      "POST /admin/attendance/requests/bulk-approve — second bulk-approval of a " +
      "missed_clock_out request when a session for that employee + clock-out " +
      "time already exists returns success:false with error matching /already exists/i",
      async () => {
        const wmId = await seedWorkspaceMember(pool);
        const tmId = await seedTeamMember(pool, wmId);
        await seedProfile(pool, tmId);

        const requestedClockOut = new Date(Date.now() - 4 * 3600_000).toISOString();

        // Seed a missed_clock_out request with no linked session.
        const requestId = await pool.query<{ id: number }>(
          `INSERT INTO attendance_requests
             (workspace_owner_id, employee_id, attendance_session_id,
              request_type, requested_clock_out_at, reason, status)
           VALUES ($1, $2, NULL, 'missed_clock_out', $3, 'Duplicate bulk-approve guard test', 'pending')
           RETURNING id`,
          [OWNER_ID, tmId, requestedClockOut],
        ).then((r) => r.rows[0].id);

        // First bulk-approve — must succeed and create a session.
        const first = await request(app)
          .post("/admin/attendance/requests/bulk-approve")
          .send({ ids: [requestId] });
        expect(first.status).toBe(200);
        const firstEntry = (first.body.results as { id: number; success: boolean }[])
          .find((r) => r.id === requestId);
        expect(firstEntry!.success).toBe(true);

        // Confirm one session now exists.
        const afterFirst = await pool.query<{ cnt: string }>(
          `SELECT COUNT(*) AS cnt FROM attendance_sessions
            WHERE workspace_owner_id = $1 AND employee_id = $2`,
          [OWNER_ID, tmId],
        );
        expect(Number(afterFirst.rows[0].cnt)).toBe(1);

        // Simulate a race / admin error: reset the request back to 'pending'
        // without touching the session row — mirrors a concurrent read that saw
        // 'pending' before the first approval committed.
        await pool.query(
          `UPDATE attendance_requests
              SET status = 'pending', attendance_session_id = NULL
            WHERE id = $1`,
          [requestId],
        );

        // Second bulk-approve — the bulk handler must catch the 23505 from the
        // DB unique constraint and record success:false instead of propagating a 500.
        const second = await request(app)
          .post("/admin/attendance/requests/bulk-approve")
          .send({ ids: [requestId] });
        expect(second.status).toBe(200);

        const secondEntry = (second.body.results as { id: number; success: boolean; error?: string }[])
          .find((r) => r.id === requestId);
        expect(secondEntry).toBeDefined();
        expect(secondEntry!.success).toBe(false);
        expect(secondEntry!.error).toMatch(/already exists/i);

        // No duplicate session must have been inserted.
        const afterSecond = await pool.query<{ cnt: string }>(
          `SELECT COUNT(*) AS cnt FROM attendance_sessions
            WHERE workspace_owner_id = $1 AND employee_id = $2`,
          [OWNER_ID, tmId],
        );
        expect(Number(afterSecond.rows[0].cnt)).toBe(1);
      },
    );

    // ── 15. Batch-approve a request linked to a locked session ────────────────

    it(
      "POST /admin/attendance/requests/bulk-approve — request linked to a " +
      "locked session returns success:false with error matching 'locked' for that entry",
      async () => {
        const wmId = await seedWorkspaceMember(pool);
        const tmId = await seedTeamMember(pool, wmId);
        await seedProfile(pool, tmId);

        const sessionId = await seedLockedSession(pool, tmId);
        const requestId = await seedRequest(pool, tmId, "edit_clock_out", sessionId);

        const res = await request(app)
          .post("/admin/attendance/requests/bulk-approve")
          .send({ ids: [requestId] });

        expect(res.status).toBe(200);

        const entry = (res.body.results as { id: number; success: boolean; error?: string }[])
          .find((r) => r.id === requestId);
        expect(entry).toBeDefined();
        expect(entry!.success).toBe(false);
        expect(entry!.error).toMatch(/locked/i);

        // The request must remain pending — no mutation should have occurred.
        const dbRow = await pool.query<{ status: string }>(
          `SELECT status FROM attendance_requests WHERE id = $1`,
          [requestId],
        );
        expect(dbRow.rows[0].status).toBe("pending");
      },
    );

    // ── 16. Bulk-approve two missed_clock_out requests for the same employee
    //        and the same requested_clock_out_at — duplicate session guard fires ─

    it(
      "POST /admin/attendance/requests/bulk-approve — two missed_clock_out " +
      "requests for the same employee and requested_clock_out_at yield one " +
      "success:true and one success:false (duplicate), and only one " +
      "attendance_sessions row is created",
      async () => {
        const wmId = await seedWorkspaceMember(pool);
        const tmId = await seedTeamMember(pool, wmId);
        await seedProfile(pool, tmId);

        // Both requests share the exact same requested_clock_out_at timestamp.
        const requestedClockOut = new Date(Date.now() - 3 * 3600_000).toISOString();

        // Use two distinct types that both route through the missed-clock-out
        // INSERT branch.  A partial unique index (uq_att_requests_pending_null_session_type)
        // prevents two pending, no-session rows of the SAME type for the same employee,
        // so we use 'missed_clock_out' + 'offsite_clock_out' — both share identical
        // bulk-approve INSERT logic and the same requested_clock_out_at, which means
        // whichever runs second will collide on the attendance_sessions unique index.
        const req1Id = await pool.query<{ id: number }>(
          `INSERT INTO attendance_requests
             (workspace_owner_id, employee_id, attendance_session_id,
              request_type, requested_clock_out_at, reason, status)
           VALUES ($1, $2, NULL, 'missed_clock_out', $3, 'Duplicate test A', 'pending')
           RETURNING id`,
          [OWNER_ID, tmId, requestedClockOut],
        ).then((r) => r.rows[0].id);

        const req2Id = await pool.query<{ id: number }>(
          `INSERT INTO attendance_requests
             (workspace_owner_id, employee_id, attendance_session_id,
              request_type, requested_clock_out_at, reason, status)
           VALUES ($1, $2, NULL, 'offsite_clock_out', $3, 'Duplicate test B', 'pending')
           RETURNING id`,
          [OWNER_ID, tmId, requestedClockOut],
        ).then((r) => r.rows[0].id);

        // Submit both in one bulk-approve call.
        const res = await request(app)
          .post("/admin/attendance/requests/bulk-approve")
          .send({ ids: [req1Id, req2Id] });

        expect(res.status).toBe(200);

        const results = res.body.results as { id: number; success: boolean; error?: string }[];

        const entry1 = results.find((r) => r.id === req1Id);
        const entry2 = results.find((r) => r.id === req2Id);
        expect(entry1).toBeDefined();
        expect(entry2).toBeDefined();

        // Exactly one must succeed and one must fail with a duplicate message.
        const successes = results.filter((r) => r.success);
        const failures  = results.filter((r) => !r.success);
        expect(successes).toHaveLength(1);
        expect(failures).toHaveLength(1);
        expect(failures[0]!.error).toMatch(/duplicate|already exists/i);

        // Only one attendance_sessions row must exist for this employee.
        const sessionRows = await pool.query<{ id: number }>(
          `SELECT id FROM attendance_sessions
            WHERE workspace_owner_id = $1 AND employee_id = $2`,
          [OWNER_ID, tmId],
        );
        expect(sessionRows.rows).toHaveLength(1);

        // The failed request must remain 'pending' — no state mutation should
        // have occurred for it (the INSERT was rolled back by the 23505 catch).
        const failedId = failures[0]!.id;
        const failedReqRow = await pool.query<{ status: string }>(
          `SELECT status FROM attendance_requests WHERE id = $1`,
          [failedId],
        );
        expect(failedReqRow.rows[0].status).toBe("pending");
      },
    );

    // ── 17. Bulk-approve two missed_clock_in requests for the same employee
    //        and the same requested_clock_in_at — duplicate session guard fires ─

    it(
      "POST /admin/attendance/requests/bulk-approve — two missed_clock_in " +
      "requests for the same employee and requested_clock_in_at yield one " +
      "success:true and one success:false (duplicate), and only one " +
      "attendance_sessions row is created",
      async () => {
        const wmId = await seedWorkspaceMember(pool);
        const tmId = await seedTeamMember(pool, wmId);
        await seedProfile(pool, tmId);

        // Both requests share the exact same requested_clock_in_at timestamp.
        const requestedClockIn = new Date(Date.now() - 4 * 3600_000).toISOString();

        // Use two distinct types that both route through the missed-clock-in
        // INSERT branch.  A partial unique index (uq_att_requests_pending_null_session_type)
        // prevents two pending, no-session rows of the SAME type for the same employee,
        // so we use 'missed_clock_in' + 'offsite_clock_in' — both share identical
        // bulk-approve INSERT logic and the same requested_clock_in_at, which means
        // whichever runs second will collide on the attendance_sessions unique index.
        const req1Id = await pool.query<{ id: number }>(
          `INSERT INTO attendance_requests
             (workspace_owner_id, employee_id, attendance_session_id,
              request_type, requested_clock_in_at, reason, status)
           VALUES ($1, $2, NULL, 'missed_clock_in', $3, 'Duplicate clock-in test A', 'pending')
           RETURNING id`,
          [OWNER_ID, tmId, requestedClockIn],
        ).then((r) => r.rows[0].id);

        const req2Id = await pool.query<{ id: number }>(
          `INSERT INTO attendance_requests
             (workspace_owner_id, employee_id, attendance_session_id,
              request_type, requested_clock_in_at, reason, status)
           VALUES ($1, $2, NULL, 'offsite_clock_in', $3, 'Duplicate clock-in test B', 'pending')
           RETURNING id`,
          [OWNER_ID, tmId, requestedClockIn],
        ).then((r) => r.rows[0].id);

        // Submit both in one bulk-approve call.
        const res = await request(app)
          .post("/admin/attendance/requests/bulk-approve")
          .send({ ids: [req1Id, req2Id] });

        expect(res.status).toBe(200);

        const results = res.body.results as { id: number; success: boolean; error?: string }[];

        const entry1 = results.find((r) => r.id === req1Id);
        const entry2 = results.find((r) => r.id === req2Id);
        expect(entry1).toBeDefined();
        expect(entry2).toBeDefined();

        // Exactly one must succeed and one must fail with a duplicate message.
        const successes = results.filter((r) => r.success);
        const failures  = results.filter((r) => !r.success);
        expect(successes).toHaveLength(1);
        expect(failures).toHaveLength(1);
        expect(failures[0]!.error).toMatch(/duplicate|already exists/i);

        // Only one attendance_sessions row must exist for this employee.
        const sessionRows = await pool.query<{ id: number }>(
          `SELECT id FROM attendance_sessions
            WHERE workspace_owner_id = $1 AND employee_id = $2`,
          [OWNER_ID, tmId],
        );
        expect(sessionRows.rows).toHaveLength(1);

        // The failed request must remain 'pending' — no state mutation should
        // have occurred for it (the INSERT was rolled back by the 23505 catch).
        const failedId = failures[0]!.id;
        const failedReqRow = await pool.query<{ status: string }>(
          `SELECT status FROM attendance_requests WHERE id = $1`,
          [failedId],
        );
        expect(failedReqRow.rows[0].status).toBe("pending");
      },
    );
  },
);
