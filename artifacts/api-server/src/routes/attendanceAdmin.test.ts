import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockDbQuery = vi.fn();

vi.mock("../lib/db", () => ({
  db: { query: (...args: unknown[]) => mockDbQuery(...args) },
}));

const mockSendPush = vi.fn();

vi.mock("../lib/expoPush", () => ({
  sendExpoPushNotification: (...args: unknown[]) => mockSendPush(...args),
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

let stubWorkspaceOwnerId = "owner_123";
let stubActualRole = "owner";
let stubUserId = "user_abc";

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = stubWorkspaceOwnerId;
    wreq.workspaceActualRole = stubActualRole;
    wreq.workspaceRole = stubActualRole === "owner" ? "owner" : "member";
    wreq.userId = stubUserId;
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import attendanceAdminRouter from "./attendanceAdmin";

// ---------------------------------------------------------------------------
// Test app
// ---------------------------------------------------------------------------

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: () => void }).log = () => {};
    next();
  });
  app.use(attendanceAdminRouter);
  return app;
}

// ---------------------------------------------------------------------------
// GET /admin/attendance/live
// ---------------------------------------------------------------------------
//
// DB call order — keep these mocks in sync whenever the route handler changes.
//
// The handler calls getManagedEmployeeIds() before the try/catch.  For owners
// that helper returns null without touching the DB; for non-owners it issues
// one SELECT to resolve the list of managed employee IDs.
//
// HAPPY PATH — owner (1 DB call):
//   1. SELECT sessions  → big JOIN (attendance_sessions + team_members + locations
//                          + team_member_profiles + work_schedule_days) with the
//                          is_overdue CASE expression, filtered by today's date
//
// HAPPY PATH — manager with employees (2 DB calls):
//   1. getManagedEmployeeIds → SELECT emp.id FROM team_members emp JOIN … wm
//   2. SELECT sessions  → same JOIN but with AND s.employee_id IN (…)
//
// Short-circuit paths (no session query):
//   - non-owner with no managed employees → getManagedEmployeeIds (1 call) → 403
//
// Adding a new db.query() to the handler requires a matching
// mockDbQuery.mockResolvedValueOnce(…) in EVERY test that reaches that code
// path.  Tests that don't reach the new call are unaffected.

describe("GET /admin/attendance/live", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.resetAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubUserId = "user_abc";
  });

  it("returns 403 for non-owners", async () => {
    stubActualRole = "member";
    const res = await request(app).get("/admin/attendance/live");
    expect(res.status).toBe(403);
  });

  it("returns 200 with sessions for owner", async () => {
    const sessions = [{ id: 1, status: "open" }];
    mockDbQuery.mockResolvedValueOnce({ rows: sessions, rowCount: 1 });

    const res = await request(app).get("/admin/attendance/live");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.sessions).toHaveLength(1);
    expect(res.body.date).toBeDefined();
  });

  it("SQL includes is_overdue CASE expression and ORDER BY is_overdue DESC", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app).get("/admin/attendance/live");

    expect(mockDbQuery).toHaveBeenCalledOnce();
    const sql: string = mockDbQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/CASE\s+WHEN\s+s\.clock_out_at\s+IS\s+NULL/i);
    expect(sql).toMatch(/END\s+AS\s+is_overdue/i);
    expect(sql).toMatch(/ORDER\s+BY\s+is_overdue\s+DESC/i);
  });
});

// ---------------------------------------------------------------------------
// GET /admin/attendance/timesheets
// ---------------------------------------------------------------------------
//
// DB call order — keep these mocks in sync whenever the route handler changes.
//
// getManagedEmployeeIds() runs before the try/catch: 0 DB calls for owners
// (returns null), 1 DB call for non-owners (returns managed ID list or []).
//
// HAPPY PATH — owner (2 DB calls):
//   1. SELECT sessions  → SELECT s.*, tm.name, l.name FROM attendance_sessions s
//                          JOIN team_members tm LEFT JOIN locations l
//                          WHERE s.workspace_owner_id=$1 [+ optional filters]
//                          ORDER BY s.clock_in_at DESC LIMIT $n OFFSET $m
//   2. COUNT total      → SELECT COUNT(*) AS total FROM attendance_sessions s
//                          WHERE <same conditions minus pagination>
//
// Short-circuit paths (no session query):
//   - non-owner with no managed employees → getManagedEmployeeIds (1 call) → 403
//
// Adding a new db.query() to the handler requires a matching
// mockDbQuery.mockResolvedValueOnce(…) in EVERY test that reaches that code
// path.  Tests that don't reach the new call are unaffected.

describe("GET /admin/attendance/timesheets", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.resetAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubUserId = "user_abc";
  });

  it("returns 403 for non-owners", async () => {
    stubActualRole = "member";
    const res = await request(app).get("/admin/attendance/timesheets");
    expect(res.status).toBe(403);
  });

  it("returns 200 with paginated sessions", async () => {
    const sessions = [{ id: 1 }, { id: 2 }];
    mockDbQuery
      .mockResolvedValueOnce({ rows: sessions, rowCount: 2 })
      .mockResolvedValueOnce({ rows: [{ total: "2" }], rowCount: 1 });

    const res = await request(app).get("/admin/attendance/timesheets");

    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(2);
    expect(res.body.total).toBe(2);
  });

  it("respects status, from, to, employee_id and location_id filters", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ total: "0" }], rowCount: 1 });

    const res = await request(app).get(
      "/admin/attendance/timesheets?status=approved&from=2025-01-01&to=2025-02-01&employee_id=5&location_id=2",
    );

    expect(res.status).toBe(200);
    const firstCall = mockDbQuery.mock.calls[0];
    const sql = String(firstCall[0]);
    expect(sql).toMatch(/s\.status = \$\d+/);
    expect(sql).toMatch(/clock_in_at >= \$\d+/);
    expect(firstCall[1]).toContain("approved");
  });
});

// ---------------------------------------------------------------------------
// GET /admin/attendance/requests
// ---------------------------------------------------------------------------
//
// DB call order — keep these mocks in sync whenever the route handler changes.
//
// getManagedEmployeeIds() runs before the try/catch: 0 DB calls for owners
// (returns null), 1 DB call for non-owners (returns managed ID list or []).
//
// HAPPY PATH — owner (1 DB call):
//   1. SELECT requests  → SELECT ar.*, tm.name FROM attendance_requests ar
//                          JOIN team_members tm
//                          WHERE ar.workspace_owner_id=$1 AND ar.status=$2
//                          [+ optional employee_name ILIKE filter]
//                          ORDER BY ar.created_at DESC LIMIT $n OFFSET $m
//
// Short-circuit paths (no SELECT):
//   - non-owner with no managed employees → getManagedEmployeeIds (1 call) → 403
//
// Adding a new db.query() to the handler requires a matching
// mockDbQuery.mockResolvedValueOnce(…) in EVERY test that reaches that code
// path.  Tests that don't reach the new call are unaffected.

describe("GET /admin/attendance/requests", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.resetAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubUserId = "user_abc";
  });

  it("returns 403 for non-owners", async () => {
    stubActualRole = "member";
    const res = await request(app).get("/admin/attendance/requests");
    expect(res.status).toBe(403);
  });

  it("returns 200 with pending requests by default", async () => {
    const requests = [{ id: 1, status: "pending" }];
    mockDbQuery.mockResolvedValueOnce({ rows: requests, rowCount: 1 });

    const res = await request(app).get("/admin/attendance/requests");

    expect(res.status).toBe(200);
    expect(res.body.requests).toHaveLength(1);
    const sql = String(mockDbQuery.mock.calls[0][0]);
    expect(sql).toMatch(/ar\.status = \$\d+/);
    const params = mockDbQuery.mock.calls[0][1] as unknown[];
    expect(params).toContain("pending");
  });
});

// ---------------------------------------------------------------------------
// POST /admin/attendance/requests/:id/approve
// ---------------------------------------------------------------------------
//
// DB call order — keep these mocks in sync whenever the route handler changes.
//
// canManageEmployee() is called synchronously after the request is fetched.
// For owners it returns true immediately (0 DB calls); for non-owners it
// issues one SELECT to check the manager–employee relationship.
//
// HAPPY PATH — owner, no session link (3 synchronous + 1 async call):
//   1. SELECT request        → SELECT * FROM attendance_requests WHERE id=$1 …
//   2. UPDATE request        → UPDATE attendance_requests SET status='approved' …
//   3. writeAuditLog         → INSERT INTO attendance_audit_logs … (failure caught)
//   4. push token lookup     → SELECT expo_push_token FROM team_members WHERE id=$1
//                               (fire-and-forget; runs after response is sent)
//
// HAPPY PATH — owner, WITH session link AND both clock times present
//              (5 synchronous + 1 async call):
//   1. SELECT request        → SELECT * FROM attendance_requests WHERE id=$1 …
//   2. SELECT old session    → SELECT clock_in_at,clock_out_at,status,… FROM
//                               attendance_sessions WHERE id=$session …
//   3. UPDATE request        → UPDATE attendance_requests SET status='approved' …
//   4. fetchScheduleWindow   → SELECT wsd.start_time, wsd.end_time, wsd.break_minutes
//                               FROM team_members … LEFT JOIN work_schedule_days …
//                               *** only runs when effectiveClockIn AND effectiveClockOut
//                                   are both non-null ***
//   5. UPDATE session        → UPDATE attendance_sessions SET clock_in_at/clock_out_at,
//                               gross_minutes, paid_minutes, overtime/late/early_leave …
//   6. writeAuditLog         → INSERT INTO attendance_audit_logs …
//   7. push token lookup     → SELECT expo_push_token … (fire-and-forget)
//
// HAPPY PATH — owner, WITH session link, only one clock time corrected
//              (NO fetchScheduleWindow — session still open):
//   calls 1–3, 5 (no schedule lookup), 6, 7
//
// Early exits (no UPDATE):
//   - request not found              → 404, stops after call 1
//   - non-owner who is not a manager → 1+1 DB calls (SELECT request + canManageEmployee)
//                                      → 403
//   - request is not pending         → 409, stops after call 1
//   - linked session is locked       → 409, stops after call 2
//
// Adding a new db.query() to the handler requires a matching
// mockDbQuery.mockResolvedValueOnce(…) in EVERY test that reaches that code
// path.  Tests that don't reach the new call are unaffected.

describe("POST /admin/attendance/requests/:id/approve", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.resetAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubUserId = "user_abc";
  });

  it("returns 403 for non-owners (or non-managers)", async () => {
    stubActualRole = "member";
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{ id: 1, status: "pending", attendance_session_id: null, employee_id: 42, request_type: "missed_clock_in", requested_clock_in_at: null, requested_clock_out_at: null }],
        rowCount: 1,
      }) // SELECT request
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // canManageEmployee → no manager match
    const res = await request(app).post("/admin/attendance/requests/1/approve");
    expect(res.status).toBe(403);
  });

  it("returns 404 when request not found", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await request(app).post("/admin/attendance/requests/999/approve");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/request not found/i);
  });

  it("returns 409 when request is not pending", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ id: 1, status: "approved", attendance_session_id: null, employee_id: 42, request_type: "missed_clock_in", requested_clock_in_at: null, requested_clock_out_at: null }],
      rowCount: 1,
    });
    const res = await request(app).post("/admin/attendance/requests/1/approve");
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/not pending/i);
  });

  it("returns 200 and approves a pending request without a session link", async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{ id: 1, status: "pending", attendance_session_id: null, employee_id: 42, request_type: "missed_clock_in", requested_clock_in_at: null, requested_clock_out_at: null }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })  // UPDATE request
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // audit log

    const res = await request(app)
      .post("/admin/attendance/requests/1/approve")
      .send({ reviewer_note: "Looks good" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("returns 200 even when the audit log INSERT fails after the approval succeeds", async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{ id: 1, status: "pending", attendance_session_id: null, employee_id: 42, request_type: "missed_clock_in", requested_clock_in_at: null, requested_clock_out_at: null }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                         // UPDATE request
      .mockRejectedValueOnce(new Error("attendance_audit_logs table missing")); // audit log INSERT fails

    const res = await request(app)
      .post("/admin/attendance/requests/1/approve")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("updates the session's clock_in_at when approving a missed_clock_in with a session link", async () => {
    const reqTime = "2025-01-01T09:00:00Z";

    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{ id: 1, status: "pending", attendance_session_id: 5, employee_id: 42, request_type: "edit_clock_in", requested_clock_in_at: reqTime, requested_clock_out_at: null }],
        rowCount: 1,
      }) // SELECT request
      .mockResolvedValueOnce({ rows: [{ clock_in_at: "2025-01-01T10:00:00Z", clock_out_at: null, status: "completed" }], rowCount: 1 }) // SELECT old session (pre-check)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })  // UPDATE request
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })  // UPDATE session clock_in_at
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // audit log

    const res = await request(app)
      .post("/admin/attendance/requests/1/approve")
      .send({});

    expect(res.status).toBe(200);
    const updateSessionCall = mockDbQuery.mock.calls[3];
    expect(String(updateSessionCall[0])).toMatch(/UPDATE attendance_sessions/i);
    expect(String(updateSessionCall[0])).toMatch(/clock_in_at/i);
  });

  it("returns 409 when the linked session is locked (payroll lock) and leaves request pending", async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{ id: 1, status: "pending", attendance_session_id: 5, employee_id: 42, request_type: "edit_clock_in", requested_clock_in_at: "2025-01-01T09:00:00Z", requested_clock_out_at: null }],
        rowCount: 1,
      }) // SELECT request
      .mockResolvedValueOnce({ rows: [{ clock_in_at: "2025-01-01T10:00:00Z", clock_out_at: null, status: "locked" }], rowCount: 1 }); // SELECT old session → locked
    // NO UPDATE request should run after this

    const res = await request(app)
      .post("/admin/attendance/requests/1/approve")
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/locked/i);
    // Ensure no UPDATE attendance_requests was issued (only 2 db calls total)
    expect(mockDbQuery).toHaveBeenCalledTimes(2);
  });

  it("fires push notification with correct payload when employee has an expo push token", async () => {
    mockSendPush.mockResolvedValue(undefined);

    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{ id: 1, status: "pending", attendance_session_id: null, employee_id: 42, request_type: "edit_clock_in", requested_clock_in_at: null, requested_clock_out_at: null }],
        rowCount: 1,
      }) // SELECT request
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })  // UPDATE request
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // audit log
      .mockResolvedValueOnce({ rows: [{ expo_push_token: "ExponentPushToken[abc123]" }], rowCount: 1 }); // SELECT token (async)

    const res = await request(app).post("/admin/attendance/requests/1/approve").send({});
    expect(res.status).toBe(200);

    await vi.waitFor(() => expect(mockSendPush).toHaveBeenCalled());
    expect(mockSendPush).toHaveBeenCalledWith(
      "ExponentPushToken[abc123]",
      "Request Approved ✓",
      "Your clock-in edit request has been approved.",
      { screen: "my-requests" },
      expect.any(Function),
    );
  });

  it("does not fire push notification when employee has no expo push token", async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{ id: 1, status: "pending", attendance_session_id: null, employee_id: 42, request_type: "edit_clock_in", requested_clock_in_at: null, requested_clock_out_at: null }],
        rowCount: 1,
      }) // SELECT request
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })  // UPDATE request
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // audit log
      .mockResolvedValueOnce({ rows: [{ expo_push_token: null }], rowCount: 1 }); // SELECT token → null (async)

    const res = await request(app).post("/admin/attendance/requests/1/approve").send({});
    expect(res.status).toBe(200);

    // Allow the fire-and-forget task to settle
    await vi.waitFor(() => expect(mockDbQuery).toHaveBeenCalledTimes(4));
    expect(mockSendPush).not.toHaveBeenCalled();
  });

  it("stale-token callback clears expo_push_token from team_members when DeviceNotRegistered is returned", async () => {
    const pushToken = "ExponentPushToken[stale123]";

    // Simulate sendExpoPushNotification invoking the onDeviceNotRegistered callback,
    // which is what happens when Expo returns a DeviceNotRegistered error ticket.
    mockSendPush.mockImplementationOnce(
      async (
        token: string,
        _title: string,
        _body: string,
        _data: unknown,
        onDeviceNotRegistered?: (t: string) => Promise<void>,
      ) => {
        if (onDeviceNotRegistered) await onDeviceNotRegistered(token);
      },
    );

    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{ id: 1, status: "pending", attendance_session_id: null, employee_id: 42, request_type: "edit_clock_in", requested_clock_in_at: null, requested_clock_out_at: null }],
        rowCount: 1,
      }) // SELECT request
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })  // UPDATE request
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // audit log
      .mockResolvedValueOnce({ rows: [{ expo_push_token: pushToken }], rowCount: 1 }) // SELECT token (async)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE team_members (clear stale token)

    const res = await request(app).post("/admin/attendance/requests/1/approve").send({});
    expect(res.status).toBe(200);

    await vi.waitFor(() => expect(mockDbQuery).toHaveBeenCalledTimes(5));

    const clearCall = mockDbQuery.mock.calls[4];
    expect(String(clearCall[0])).toMatch(/UPDATE team_members/i);
    expect(String(clearCall[0])).toMatch(/expo_push_token = NULL/i);
    expect(clearCall[1]).toEqual([pushToken]);
  });

  it("clears expo_push_token from team_members when push notification fails after all retries", async () => {
    const pushToken = "ExponentPushToken[deadRetry]";

    // Simulate sendExpoPushNotification returning success: false after retry exhaustion
    mockSendPush.mockResolvedValueOnce({ success: false });

    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{ id: 1, status: "pending", attendance_session_id: null, employee_id: 42, request_type: "edit_clock_in", requested_clock_in_at: null, requested_clock_out_at: null }],
        rowCount: 1,
      }) // SELECT request
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })  // UPDATE request
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // audit log
      .mockResolvedValueOnce({ rows: [{ expo_push_token: pushToken }], rowCount: 1 }) // SELECT token (async)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE team_members (clear token on failure)

    const res = await request(app).post("/admin/attendance/requests/1/approve").send({});
    expect(res.status).toBe(200);

    await vi.waitFor(() => expect(mockDbQuery).toHaveBeenCalledTimes(5));

    const clearCall = mockDbQuery.mock.calls[4];
    expect(String(clearCall[0])).toMatch(/UPDATE team_members/i);
    expect(String(clearCall[0])).toMatch(/expo_push_token = NULL/i);
    expect(clearCall[1]).toEqual([pushToken]);
  });

  it("returns 200 (not 500) when called with no body (reviewer_note is optional)", async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{ id: 1, status: "pending", attendance_session_id: null, employee_id: 42, request_type: "missed_clock_in", requested_clock_in_at: null, requested_clock_out_at: null }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })  // UPDATE request
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // audit log

    const res = await request(app)
      .post("/admin/attendance/requests/1/approve")
      .set("Content-Type", "text/plain");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /admin/attendance/requests/:id/approve — schedule recalculation
// ---------------------------------------------------------------------------
//
// DB call order — keep these mocks in sync whenever the route handler changes.
//
// These tests focus on the recalculation paths for session-linked requests.
// The numbered calls below assume the owner role (canManageEmployee = 0 calls).
//
// HAPPY PATH — both effective clock times present (6 calls):
//   1. SELECT request        → returns pending request with attendance_session_id
//   2. SELECT old session    → returns existing clock_in/clock_out/break_minutes
//   3. UPDATE request        → SET status='approved' …
//   4. fetchScheduleWindow   → SELECT wsd.start_time … (1 call)
//   5. UPDATE session        → SET clock_in_at/clock_out_at + all minute fields
//   6. writeAuditLog         → INSERT INTO attendance_audit_logs …
//   (fire-and-forget push token lookup runs asynchronously as call 7)
//
// HAPPY PATH — no schedule row exists (6 calls, same sequence; call 4 returns empty):
//   Minute fields are zeroed via calculateSessionMinutes(…, undefined).
//
// HAPPY PATH — only clock_in corrected, session still open (no clock_out_at)
//              (5 calls — no fetchScheduleWindow, no recalculation):
//   1. SELECT request
//   2. SELECT old session    → clock_out_at IS NULL
//   3. UPDATE request
//   4. UPDATE session        → only clock_in_at + updated_at (no minute fields)
//   5. writeAuditLog
//   (fire-and-forget push token lookup as call 6)
//
// Adding a new db.query() to the handler requires a matching
// mockDbQuery.mockResolvedValueOnce(…) in EVERY test that reaches that code
// path.  Tests that don't reach the new call are unaffected.

describe("POST /admin/attendance/requests/:id/approve — schedule recalculation", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.resetAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubUserId = "user_abc";
  });

  it("recalculates minute fields using schedule when both effective clock times are present", async () => {
    const correctedClockIn = "2025-01-06T09:10:00Z";
    const existingClockOut = "2025-01-06T17:00:00Z";

    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{
          id: 1, status: "pending", attendance_session_id: 5, employee_id: 42,
          request_type: "edit_clock_in",
          requested_clock_in_at: correctedClockIn,
          requested_clock_out_at: null,
        }],
        rowCount: 1,
      }) // SELECT request
      .mockResolvedValueOnce({
        rows: [{
          clock_in_at: "2025-01-06T10:00:00Z",
          clock_out_at: existingClockOut,
          status: "completed",
          break_minutes: 30,
          location_id: 10,
        }],
        rowCount: 1,
      }) // SELECT old session
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE request
      .mockResolvedValueOnce({
        rows: [{ start_time: "09:00:00", end_time: "17:00:00", break_minutes: 30 }],
        rowCount: 1,
      }) // fetchScheduleWindow
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE session
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // audit log

    const res = await request(app).post("/admin/attendance/requests/1/approve").send({});
    expect(res.status).toBe(200);

    const updateSessionSql = String(mockDbQuery.mock.calls[4][0]);
    expect(updateSessionSql).toMatch(/UPDATE attendance_sessions/i);
    expect(updateSessionSql).toMatch(/gross_minutes/i);
    expect(updateSessionSql).toMatch(/paid_minutes/i);
    expect(updateSessionSql).toMatch(/late_minutes/i);
    expect(updateSessionSql).toMatch(/overtime_minutes/i);
    expect(updateSessionSql).toMatch(/early_leave_minutes/i);
    expect(updateSessionSql).toMatch(/clock_in_at/i);
  });

  it("recalculates with zeroed minute fields when no schedule row exists for the employee", async () => {
    const correctedClockOut = "2025-01-06T18:00:00Z";
    const existingClockIn = "2025-01-06T09:00:00Z";

    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{
          id: 1, status: "pending", attendance_session_id: 5, employee_id: 42,
          request_type: "edit_clock_out",
          requested_clock_in_at: null,
          requested_clock_out_at: correctedClockOut,
        }],
        rowCount: 1,
      }) // SELECT request
      .mockResolvedValueOnce({
        rows: [{
          clock_in_at: existingClockIn,
          clock_out_at: "2025-01-06T17:00:00Z",
          status: "completed",
          break_minutes: 0,
          location_id: null,
        }],
        rowCount: 1,
      }) // SELECT old session
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE request
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // fetchScheduleWindow → no schedule
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE session
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // audit log

    const res = await request(app).post("/admin/attendance/requests/1/approve").send({});
    expect(res.status).toBe(200);

    const updateSessionSql = String(mockDbQuery.mock.calls[4][0]);
    expect(updateSessionSql).toMatch(/UPDATE attendance_sessions/i);
    expect(updateSessionSql).toMatch(/gross_minutes/i);
    expect(updateSessionSql).toMatch(/late_minutes/i);
    expect(updateSessionSql).toMatch(/clock_out_at/i);

    const updateParams = mockDbQuery.mock.calls[4][1] as unknown[];
    expect(updateParams).toContain(0);
  });

  it("skips recalculation when only clock_in is corrected and session has no clock_out_at", async () => {
    const correctedClockIn = "2025-01-06T09:10:00Z";

    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{
          id: 1, status: "pending", attendance_session_id: 5, employee_id: 42,
          request_type: "edit_clock_in",
          requested_clock_in_at: correctedClockIn,
          requested_clock_out_at: null,
        }],
        rowCount: 1,
      }) // SELECT request
      .mockResolvedValueOnce({
        rows: [{
          clock_in_at: "2025-01-06T10:00:00Z",
          clock_out_at: null,
          status: "open",
          break_minutes: 0,
          location_id: null,
        }],
        rowCount: 1,
      }) // SELECT old session (no clock_out_at)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE request
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE session (no schedule lookup)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // audit log

    const res = await request(app).post("/admin/attendance/requests/1/approve").send({});
    expect(res.status).toBe(200);

    // Call index 3 is the session UPDATE (no schedule lookup in between)
    const updateSessionSql = String(mockDbQuery.mock.calls[3][0]);
    expect(updateSessionSql).toMatch(/UPDATE attendance_sessions/i);
    expect(updateSessionSql).not.toMatch(/gross_minutes/i);
    expect(updateSessionSql).not.toMatch(/late_minutes/i);
    // Allow the fire-and-forget push token lookup to settle (1 extra db call)
    await vi.waitFor(() => expect(mockDbQuery).toHaveBeenCalledTimes(6));
  });
});

// ---------------------------------------------------------------------------
// POST /admin/attendance/requests/:id/reject
// ---------------------------------------------------------------------------
//
// DB call order — keep these mocks in sync whenever the route handler changes.
//
// canManageEmployee() is called after the request is fetched.  For owners it
// returns true immediately (0 extra DB calls); for non-owners it issues one
// SELECT to verify the manager–employee relationship.
//
// HAPPY PATH — owner (3 synchronous + 1 async call):
//   1. SELECT request     → SELECT id, status, attendance_session_id, employee_id,
//                            request_type FROM attendance_requests WHERE id=$1 …
//   2. UPDATE request     → UPDATE attendance_requests SET status='rejected' …
//   3. writeAuditLog      → INSERT INTO attendance_audit_logs … (failure caught)
//   4. push token lookup  → SELECT expo_push_token FROM team_members WHERE id=$1
//                            (fire-and-forget; runs after response is sent)
//
// Early exits (no UPDATE):
//   - request not found              → 404, stops after call 1
//   - non-owner who is not a manager → 2 calls (SELECT request + canManageEmployee)
//                                      → 403
//   - request is not pending         → 409, stops after call 1 (status check)
//
// Adding a new db.query() to the handler requires a matching
// mockDbQuery.mockResolvedValueOnce(…) in EVERY test that reaches that code
// path.  Tests that don't reach the new call are unaffected.

describe("POST /admin/attendance/requests/:id/reject", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.resetAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubUserId = "user_abc";
  });

  it("returns 403 for non-owners (or non-managers)", async () => {
    stubActualRole = "member";
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{ id: 1, status: "pending", attendance_session_id: null, employee_id: 42 }],
        rowCount: 1,
      }) // SELECT request
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // canManageEmployee → no manager match
    const res = await request(app).post("/admin/attendance/requests/1/reject");
    expect(res.status).toBe(403);
  });

  it("returns 404 when request not found", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await request(app).post("/admin/attendance/requests/999/reject");
    expect(res.status).toBe(404);
  });

  it("returns 200 on successful rejection", async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{ id: 1, status: "pending", attendance_session_id: null, employee_id: 42 }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })  // UPDATE request
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // audit log

    const res = await request(app)
      .post("/admin/attendance/requests/1/reject")
      .send({ reviewer_note: "Not valid" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("fires push notification with correct payload when employee has an expo push token", async () => {
    mockSendPush.mockResolvedValue(undefined);

    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{ id: 1, status: "pending", attendance_session_id: null, employee_id: 42, request_type: "missed_clock_out" }],
        rowCount: 1,
      }) // SELECT request
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })  // UPDATE request
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // audit log
      .mockResolvedValueOnce({ rows: [{ expo_push_token: "ExponentPushToken[xyz789]" }], rowCount: 1 }); // SELECT token (async)

    const res = await request(app).post("/admin/attendance/requests/1/reject").send({});
    expect(res.status).toBe(200);

    await vi.waitFor(() => expect(mockSendPush).toHaveBeenCalled());
    expect(mockSendPush).toHaveBeenCalledWith(
      "ExponentPushToken[xyz789]",
      "Request Rejected",
      "Your missed clock-out request has been rejected.",
      { screen: "my-requests" },
      expect.any(Function),
    );
  });

  it("does not fire push notification when employee has no expo push token", async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{ id: 1, status: "pending", attendance_session_id: null, employee_id: 42, request_type: "missed_clock_out" }],
        rowCount: 1,
      }) // SELECT request
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })  // UPDATE request
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // audit log
      .mockResolvedValueOnce({ rows: [{ expo_push_token: null }], rowCount: 1 }); // SELECT token → null (async)

    const res = await request(app).post("/admin/attendance/requests/1/reject").send({});
    expect(res.status).toBe(200);

    // Allow the fire-and-forget task to settle
    await vi.waitFor(() => expect(mockDbQuery).toHaveBeenCalledTimes(4));
    expect(mockSendPush).not.toHaveBeenCalled();
  });

  it("returns 200 (not 500) when called with no body (reviewer_note is optional)", async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{ id: 1, status: "pending", attendance_session_id: null, employee_id: 42, request_type: "missed_clock_out" }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })  // UPDATE request
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // audit log

    const res = await request(app)
      .post("/admin/attendance/requests/1/reject")
      .set("Content-Type", "text/plain");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /admin/attendance/sessions/:id/approve
// ---------------------------------------------------------------------------
//
// DB call order — keep these mocks in sync whenever the route handler changes.
//
// canManageEmployee() is called after the session is fetched.  For owners it
// returns true immediately (0 extra DB calls); for non-owners it issues one
// SELECT to verify the manager–employee relationship.
//
// HAPPY PATH — owner, session has both clock_in_at and clock_out_at
//              (4 synchronous + 1 async call):
//   1. SELECT session     → SELECT id, status, employee_id, clock_in_at,
//                            clock_out_at, break_minutes, location_id …
//   2. fetchScheduleWindow → SELECT wsd.start_time, wsd.end_time, wsd.break_minutes
//                             FROM team_members … LEFT JOIN work_schedule_days …
//                             *** only when both clock_in_at AND clock_out_at are present ***
//   3. UPDATE session     → SET status='approved', approved_by, approved_at,
//                            gross_minutes, paid_minutes, overtime/late/early_leave …
//                            (with recalculated minute fields from fetchScheduleWindow)
//   4. writeAuditLog      → INSERT INTO attendance_audit_logs … (failure caught)
//   5. push token lookup  → SELECT expo_push_token … (fire-and-forget)
//
// HAPPY PATH — owner, clock_out_at IS NULL (3 synchronous + 1 async call):
//   Call 2 (fetchScheduleWindow) is skipped; UPDATE sets status only (no minute fields).
//   Sequence: 1 → 3 (no schedule fetch) → 4 → 5.
//
// Early exits (no UPDATE):
//   - session not found              → 404, stops after call 1
//   - session is locked              → 409, stops after call 1
//   - non-owner who is not a manager → 2 calls (SELECT session + canManageEmployee) → 403
//
// Adding a new db.query() to the handler requires a matching
// mockDbQuery.mockResolvedValueOnce(…) in EVERY test that reaches that code
// path.  Tests that don't reach the new call are unaffected.

describe("POST /admin/attendance/sessions/:id/approve", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.resetAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubUserId = "user_abc";
  });

  it("returns 404 when session not found", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await request(app).post("/admin/attendance/sessions/999/approve");
    expect(res.status).toBe(404);
  });

  it("returns 409 when session is locked", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5, status: "locked", employee_id: 42 }], rowCount: 1 }); // canManageEmployee not needed for owner

    const res = await request(app).post("/admin/attendance/sessions/5/approve");
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/locked/i);
  });

  it("returns 200 and approves session for owner", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5, status: "pending_review", employee_id: 42 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })  // UPDATE session
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // audit log

    const res = await request(app).post("/admin/attendance/sessions/5/approve");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("returns 403 for member who is not a manager of the employee", async () => {
    stubActualRole = "member";
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5, status: "pending_review", employee_id: 42 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // canManageEmployee check — not a manager

    const res = await request(app).post("/admin/attendance/sessions/5/approve");
    expect(res.status).toBe(403);
  });

  it("fires push notification with 'approved' decision when employee has an expo push token", async () => {
    mockSendPush.mockResolvedValue(undefined);

    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{ id: 5, status: "pending_review", employee_id: 42, clock_in_at: null, clock_out_at: null, break_minutes: null, location_id: null }],
        rowCount: 1,
      }) // SELECT session
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })  // UPDATE session
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // audit log
      .mockResolvedValueOnce({ rows: [{ expo_push_token: "ExponentPushToken[session123]" }], rowCount: 1 }); // SELECT token (async)

    const res = await request(app).post("/admin/attendance/sessions/5/approve");
    expect(res.status).toBe(200);

    await vi.waitFor(() => expect(mockSendPush).toHaveBeenCalled());
    expect(mockSendPush).toHaveBeenCalledWith(
      "ExponentPushToken[session123]",
      "Session Approved ✓",
      "Your attendance session has been approved.",
      { screen: "attendance" },
      expect.any(Function),
    );
  });

  it("does not fire push notification when employee has no expo push token (approve)", async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{ id: 5, status: "pending_review", employee_id: 42, clock_in_at: null, clock_out_at: null, break_minutes: null, location_id: null }],
        rowCount: 1,
      }) // SELECT session
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })  // UPDATE session
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // audit log
      .mockResolvedValueOnce({ rows: [{ expo_push_token: null }], rowCount: 1 }); // SELECT token → null (async)

    const res = await request(app).post("/admin/attendance/sessions/5/approve");
    expect(res.status).toBe(200);

    await vi.waitFor(() => expect(mockDbQuery).toHaveBeenCalledTimes(4));
    expect(mockSendPush).not.toHaveBeenCalled();
  });

  it("returns 200 even when the push notification fails (approve)", async () => {
    mockSendPush.mockRejectedValue(new Error("Push service unavailable"));

    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{ id: 5, status: "pending_review", employee_id: 42, clock_in_at: null, clock_out_at: null, break_minutes: null, location_id: null }],
        rowCount: 1,
      }) // SELECT session
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })  // UPDATE session
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // audit log
      .mockResolvedValueOnce({ rows: [{ expo_push_token: "ExponentPushToken[session123]" }], rowCount: 1 }); // SELECT token (async)

    const res = await request(app).post("/admin/attendance/sessions/5/approve");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    await vi.waitFor(() => expect(mockSendPush).toHaveBeenCalled());
  });
});

// ---------------------------------------------------------------------------
// POST /admin/attendance/sessions/:id/reject
// ---------------------------------------------------------------------------
//
// DB call order — keep these mocks in sync whenever the route handler changes.
//
// canManageEmployee() is called after the session is fetched.  For owners it
// returns true immediately (0 extra DB calls); for non-owners it issues one
// SELECT to verify the manager–employee relationship.
//
// HAPPY PATH — owner (3 synchronous + 1 async call):
//   1. SELECT session     → SELECT id, status, employee_id FROM attendance_sessions
//                            WHERE id=$1 AND workspace_owner_id=$2
//   2. UPDATE session     → SET status='rejected', rejected_by, rejected_at,
//                            manager_note = COALESCE($note, manager_note) …
//   3. writeAuditLog      → INSERT INTO attendance_audit_logs … (failure caught)
//   4. push token lookup  → SELECT expo_push_token FROM team_members WHERE id=$1
//                            (fire-and-forget; runs after response is sent)
//
// Early exits (no UPDATE):
//   - session not found  → 404, stops after call 1
//   - session is locked  → 409, stops after call 1
//
// Adding a new db.query() to the handler requires a matching
// mockDbQuery.mockResolvedValueOnce(…) in EVERY test that reaches that code
// path.  Tests that don't reach the new call are unaffected.

describe("POST /admin/attendance/sessions/:id/reject", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.resetAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubUserId = "user_abc";
  });

  it("returns 404 when session not found", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await request(app).post("/admin/attendance/sessions/999/reject");
    expect(res.status).toBe(404);
  });

  it("returns 200 and rejects session for owner", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5, status: "pending_review", employee_id: 42 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })  // UPDATE session
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // audit log

    const res = await request(app)
      .post("/admin/attendance/sessions/5/reject")
      .send({ manager_note: "Suspicious hours" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("fires push notification with 'rejected' decision when employee has an expo push token", async () => {
    mockSendPush.mockResolvedValue(undefined);

    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5, status: "pending_review", employee_id: 42 }], rowCount: 1 }) // SELECT session
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })  // UPDATE session
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // audit log
      .mockResolvedValueOnce({ rows: [{ expo_push_token: "ExponentPushToken[session456]" }], rowCount: 1 }); // SELECT token (async)

    const res = await request(app).post("/admin/attendance/sessions/5/reject").send({});
    expect(res.status).toBe(200);

    await vi.waitFor(() => expect(mockSendPush).toHaveBeenCalled());
    expect(mockSendPush).toHaveBeenCalledWith(
      "ExponentPushToken[session456]",
      "Session Reviewed",
      "Your attendance session has been reviewed — please check any notes from your manager.",
      { screen: "attendance" },
      expect.any(Function),
    );
  });

  it("does not fire push notification when employee has no expo push token (reject)", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5, status: "pending_review", employee_id: 42 }], rowCount: 1 }) // SELECT session
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })  // UPDATE session
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // audit log
      .mockResolvedValueOnce({ rows: [{ expo_push_token: null }], rowCount: 1 }); // SELECT token → null (async)

    const res = await request(app).post("/admin/attendance/sessions/5/reject").send({});
    expect(res.status).toBe(200);

    await vi.waitFor(() => expect(mockDbQuery).toHaveBeenCalledTimes(4));
    expect(mockSendPush).not.toHaveBeenCalled();
  });

  it("returns 200 even when the push notification fails (reject)", async () => {
    mockSendPush.mockRejectedValue(new Error("Push service unavailable"));

    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5, status: "pending_review", employee_id: 42 }], rowCount: 1 }) // SELECT session
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })  // UPDATE session
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // audit log
      .mockResolvedValueOnce({ rows: [{ expo_push_token: "ExponentPushToken[session456]" }], rowCount: 1 }); // SELECT token (async)

    const res = await request(app).post("/admin/attendance/sessions/5/reject").send({});
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    await vi.waitFor(() => expect(mockSendPush).toHaveBeenCalled());
  });

  it("returns 200 (not 500) when called with no body (manager_note is optional)", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5, status: "pending_review", employee_id: 42 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })  // UPDATE session
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // audit log

    const res = await request(app)
      .post("/admin/attendance/sessions/5/reject")
      .set("Content-Type", "text/plain");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PATCH /admin/attendance/sessions/:id
// ---------------------------------------------------------------------------
//
// DB call order — keep these mocks in sync whenever the route handler changes.
//
// canManageEmployee() is called after the session is fetched.  For owners it
// returns true immediately (0 extra DB calls); for non-owners it issues one
// SELECT to verify the manager–employee relationship.
//
// HAPPY PATH — notes-only patch (no time-affecting fields) (3 DB calls):
//   1. SELECT session     → SELECT * FROM attendance_sessions WHERE id=$1 …
//   2. UPDATE session     → SET <field>=…, updated_at=now() RETURNING *
//   3. writeAuditLog      → INSERT INTO attendance_audit_logs … (failure caught)
//
// HAPPY PATH — time-affecting field patched AND both effective clock times
//              are non-null (4 DB calls):
//   1. SELECT session     → SELECT * FROM attendance_sessions WHERE id=$1 …
//   2. fetchScheduleWindow → SELECT wsd.start_time, wsd.end_time, wsd.break_minutes …
//                             *** only when effectiveClockIn AND effectiveClockOut
//                                 are both non-null after applying the patch body ***
//   3. UPDATE session     → SET <fields> + gross/paid/overtime/late/early_leave …
//                            RETURNING *
//   4. writeAuditLog      → INSERT INTO attendance_audit_logs …
//
// HAPPY PATH — time-affecting field patched BUT clock_out_at is null
//              (3 DB calls — no fetchScheduleWindow):
//   Recalculation is skipped because we cannot compute duration without a clock_out.
//   Sequence: 1 → 3 (no recalc fields) → 4.
//
// Early exits (no UPDATE):
//   - session not found          → 404, stops after call 1
//   - session is locked          → 409, stops after call 1
//   - no valid fields in body    → 400, stops after call 1
//
// Adding a new db.query() to the handler requires a matching
// mockDbQuery.mockResolvedValueOnce(…) in EVERY test that reaches that code
// path.  Tests that don't reach the new call are unaffected.

describe("PATCH /admin/attendance/sessions/:id", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.resetAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubUserId = "user_abc";
  });

  it("returns 404 when session not found", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await request(app).patch("/admin/attendance/sessions/999").send({ manager_note: "ok" });
    expect(res.status).toBe(404);
  });

  it("returns 400 when no valid fields are provided", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 5, status: "completed", employee_id: 42 }], rowCount: 1 });

    const res = await request(app)
      .patch("/admin/attendance/sessions/5")
      .send({ invalid_field: "value" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no valid fields/i);
  });

  it("returns 409 when session is locked", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 5, status: "locked", employee_id: 42 }], rowCount: 1 });

    const res = await request(app)
      .patch("/admin/attendance/sessions/5")
      .send({ manager_note: "test" });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/locked/i);
  });

  it("returns 200 with the updated session", async () => {
    const updatedSession = { id: 5, manager_note: "Adjusted" };

    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5, status: "completed", employee_id: 42 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [updatedSession], rowCount: 1 })  // UPDATE RETURNING
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });               // audit log

    const res = await request(app)
      .patch("/admin/attendance/sessions/5")
      .send({ manager_note: "Adjusted" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.session.manager_note).toBe("Adjusted");
  });

  it("only updates allowed fields and ignores unknown ones", async () => {
    const updatedSession = { id: 5, employee_note: "Updated" };

    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5, status: "completed", employee_id: 42 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [updatedSession], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app)
      .patch("/admin/attendance/sessions/5")
      .send({ employee_note: "Updated", hacked_field: "evil" });

    const updateSql = String(mockDbQuery.mock.calls[1][0]);
    expect(updateSql).toMatch(/employee_note/);
    expect(updateSql).not.toMatch(/hacked_field/);
  });

  it("ignores status field to prevent lock bypass", async () => {
    const updatedSession = { id: 5, manager_note: "ok" };

    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5, status: "completed", employee_id: 42 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [updatedSession], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app)
      .patch("/admin/attendance/sessions/5")
      .send({ manager_note: "ok", status: "locked" });

    const updateSql = String(mockDbQuery.mock.calls[1][0]);
    expect(updateSql).toMatch(/manager_note/);
    expect(updateSql).not.toMatch(/status/);
  });

  it("recalculates minute fields with schedule when clock_in_at is patched", async () => {
    const existingSession = {
      id: 5, status: "completed", employee_id: 42,
      clock_in_at: "2025-01-06T09:30:00Z",
      clock_out_at: "2025-01-06T17:00:00Z",
      break_minutes: 60, location_id: 7,
    };

    mockDbQuery
      .mockResolvedValueOnce({ rows: [existingSession], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ start_time: "09:00:00", end_time: "17:00:00", break_minutes: 60 }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [existingSession], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .patch("/admin/attendance/sessions/5")
      .send({ clock_in_at: "2025-01-06T09:05:00Z" });

    expect(res.status).toBe(200);
    const updateSql = String(mockDbQuery.mock.calls[2][0]);
    expect(updateSql).toMatch(/late_minutes/i);
    expect(updateSql).toMatch(/overtime_minutes/i);
    expect(updateSql).toMatch(/gross_minutes/i);
    expect(updateSql).toMatch(/paid_minutes/i);
  });

  it("recalculates minute fields with no schedule when no schedule row exists", async () => {
    const existingSession = {
      id: 5, status: "completed", employee_id: 42,
      clock_in_at: "2025-01-06T09:00:00Z",
      clock_out_at: "2025-01-06T17:00:00Z",
      break_minutes: 30, location_id: null,
    };

    mockDbQuery
      .mockResolvedValueOnce({ rows: [existingSession], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [existingSession], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .patch("/admin/attendance/sessions/5")
      .send({ clock_out_at: "2025-01-06T17:00:00Z" });

    expect(res.status).toBe(200);
    const updateSql = String(mockDbQuery.mock.calls[2][0]);
    expect(updateSql).toMatch(/gross_minutes/i);
    const callParams = mockDbQuery.mock.calls[2][1] as unknown[];
    expect(callParams).toContain(0);
  });

  it("does not recalculate when only notes are updated", async () => {
    const existingSession = {
      id: 5, status: "completed", employee_id: 42,
      clock_in_at: "2025-01-06T09:00:00Z",
      clock_out_at: "2025-01-06T17:00:00Z",
      break_minutes: 60, location_id: null,
    };

    mockDbQuery
      .mockResolvedValueOnce({ rows: [existingSession], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [existingSession], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .patch("/admin/attendance/sessions/5")
      .send({ manager_note: "Looks fine" });

    expect(res.status).toBe(200);
    expect(mockDbQuery).toHaveBeenCalledTimes(3);
    const updateSql = String(mockDbQuery.mock.calls[1][0]);
    expect(updateSql).not.toMatch(/late_minutes/i);
    expect(updateSql).not.toMatch(/gross_minutes/i);
  });

  it("skips recalculation when clock_in_at is patched but clock_out remains null", async () => {
    const existingSession = {
      id: 5, status: "open", employee_id: 42,
      clock_in_at: "2025-01-06T09:30:00Z",
      clock_out_at: null,
      break_minutes: 0, location_id: null,
    };

    mockDbQuery
      .mockResolvedValueOnce({ rows: [existingSession], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [existingSession], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .patch("/admin/attendance/sessions/5")
      .send({ clock_in_at: "2025-01-06T09:00:00Z" });

    expect(res.status).toBe(200);
    expect(mockDbQuery).toHaveBeenCalledTimes(3);
    const updateSql = String(mockDbQuery.mock.calls[1][0]);
    expect(updateSql).not.toMatch(/gross_minutes/i);
  });

  it("returns 400 (not 500) when called with no body", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ id: 5, status: "completed", employee_id: 42, clock_in_at: null, clock_out_at: null, break_minutes: null, location_id: null }],
      rowCount: 1,
    });

    const res = await request(app)
      .patch("/admin/attendance/sessions/5")
      .set("Content-Type", "text/plain");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no valid fields/i);
  });
});

// ---------------------------------------------------------------------------
// POST /admin/attendance/requests/bulk-approve — no-body guard
// ---------------------------------------------------------------------------
//
// DB call order — keep these mocks in sync whenever the route handler changes.
//
// The handler validates the request body (ids array) before touching the DB.
// The tests in this describe block only exercise that early validation; they
// therefore make 0 DB calls and need no mockResolvedValueOnce setup.
//
// Full per-item DB call sequence (once per request ID inside the for-loop):
//   1. SELECT request          → SELECT * FROM attendance_requests WHERE id=$1 …
//   2. canManageEmployee check → 0 extra calls for owners; 1 SELECT for non-owners
//   3. SELECT old session      → only when attendance_session_id is set
//   4. UPDATE request          → SET status='approved' …
//   5. fetchScheduleWindow     → only when both effective clock times are present
//   6. UPDATE session          → only when attendance_session_id and clock times exist
//   7. writeAuditLog           → INSERT INTO attendance_audit_logs …
//   8. push notification       → SELECT expo_push_token … (fire-and-forget)
//
// Adding a new db.query() to the handler requires a matching
// mockDbQuery.mockResolvedValueOnce(…) in EVERY test that reaches that code
// path.  Tests that don't reach the new call are unaffected.

describe("POST /admin/attendance/requests/bulk-approve — no-body guard", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.resetAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubUserId = "user_abc";
  });

  it("returns 400 (not 500) when called with no body", async () => {
    const res = await request(app)
      .post("/admin/attendance/requests/bulk-approve")
      .set("Content-Type", "text/plain");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ids must be a non-empty array/i);
  });

  it("returns 400 (not 500) when body is empty JSON object", async () => {
    const res = await request(app)
      .post("/admin/attendance/requests/bulk-approve")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ids must be a non-empty array/i);
  });
});

// ---------------------------------------------------------------------------
// POST /admin/attendance/requests/bulk-reject — no-body guard
// ---------------------------------------------------------------------------
//
// DB call order — keep these mocks in sync whenever the route handler changes.
//
// The handler validates the request body (ids array) before touching the DB.
// The tests in this describe block only exercise that early validation; they
// therefore make 0 DB calls and need no mockResolvedValueOnce setup.
//
// Full per-item DB call sequence (once per request ID inside the for-loop):
//   1. SELECT request          → SELECT id, status, … FROM attendance_requests …
//   2. canManageEmployee check → 0 extra calls for owners; 1 SELECT for non-owners
//   3. UPDATE request          → SET status='rejected' …
//   4. writeAuditLog           → INSERT INTO attendance_audit_logs …
//   5. push notification       → SELECT expo_push_token … (fire-and-forget)
//
// Adding a new db.query() to the handler requires a matching
// mockDbQuery.mockResolvedValueOnce(…) in EVERY test that reaches that code
// path.  Tests that don't reach the new call are unaffected.

describe("POST /admin/attendance/requests/bulk-reject — no-body guard", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.resetAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubUserId = "user_abc";
  });

  it("returns 400 (not 500) when called with no body", async () => {
    const res = await request(app)
      .post("/admin/attendance/requests/bulk-reject")
      .set("Content-Type", "text/plain");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ids must be a non-empty array/i);
  });

  it("returns 400 (not 500) when body is empty JSON object", async () => {
    const res = await request(app)
      .post("/admin/attendance/requests/bulk-reject")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ids must be a non-empty array/i);
  });
});

// ---------------------------------------------------------------------------
// POST /admin/attendance/sessions/:id/approve — schedule recalculation
// ---------------------------------------------------------------------------
//
// DB call order — keep these mocks in sync whenever the route handler changes.
//
// These tests focus on the schedule-recalculation paths for session approval.
// All calls below assume the owner role (canManageEmployee = 0 extra DB calls).
//
// HAPPY PATH — both clock_in_at and clock_out_at present (4 synchronous + 1 async):
//   1. SELECT session        → returns session with both clock times + location_id
//   2. fetchScheduleWindow   → SELECT wsd.start_time, wsd.end_time, wsd.break_minutes …
//   3. UPDATE session        → SET status='approved' + all minute fields
//   4. writeAuditLog         → INSERT INTO attendance_audit_logs …
//   (fire-and-forget push token lookup runs asynchronously as call 5)
//
// HAPPY PATH — clock_out_at IS NULL (3 synchronous + 1 async):
//   fetchScheduleWindow (call 2) is skipped; UPDATE sets status only (no minute fields).
//   Sequence: 1 → 3 (no schedule fetch) → 4 → 5.
//
// HAPPY PATH — no schedule row exists (4 calls; call 2 returns empty rows):
//   calculateSessionMinutes is called with undefined schedule; all penalty fields → 0.
//
// Adding a new db.query() to the handler requires a matching
// mockDbQuery.mockResolvedValueOnce(…) in EVERY test that reaches that code
// path.  Tests that don't reach the new call are unaffected.

describe("POST /admin/attendance/sessions/:id/approve — schedule recalculation", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.resetAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubUserId = "user_abc";
  });

  it("recalculates minute fields using schedule when session has both clock times", async () => {
    const clockIn = "2025-01-06T09:10:00Z";
    const clockOut = "2025-01-06T17:00:00Z";

    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{
          id: 5, status: "pending_review", employee_id: 42,
          clock_in_at: clockIn, clock_out_at: clockOut,
          break_minutes: 60, location_id: 10,
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{ start_time: "09:00:00", end_time: "17:00:00", break_minutes: 60 }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).post("/admin/attendance/sessions/5/approve");
    expect(res.status).toBe(200);

    const updateSql = String(mockDbQuery.mock.calls[2][0]);
    expect(updateSql).toMatch(/late_minutes/i);
    expect(updateSql).toMatch(/overtime_minutes/i);
    expect(updateSql).toMatch(/gross_minutes/i);

    const updateParams = mockDbQuery.mock.calls[2][1] as unknown[];
    expect(updateParams).toContain(10);
  });

  it("approves without recalculating when clock_out_at is null", async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{
          id: 5, status: "pending_review", employee_id: 42,
          clock_in_at: "2025-01-06T09:00:00Z", clock_out_at: null,
          break_minutes: 0, location_id: null,
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).post("/admin/attendance/sessions/5/approve");
    expect(res.status).toBe(200);

    // The second DB call (index 1) must be the UPDATE — no schedule lookup in between
    const secondSql = String(mockDbQuery.mock.calls[1][0]);
    expect(secondSql).toMatch(/UPDATE attendance_sessions/i);
    expect(secondSql).not.toMatch(/late_minutes/i);
  });

  it("approves with recalculation even when no schedule row exists (zeroed overtime/late)", async () => {
    const clockIn = "2025-01-06T09:00:00Z";
    const clockOut = "2025-01-06T17:00:00Z";

    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{
          id: 5, status: "pending_review", employee_id: 42,
          clock_in_at: clockIn, clock_out_at: clockOut,
          break_minutes: 30, location_id: null,
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).post("/admin/attendance/sessions/5/approve");
    expect(res.status).toBe(200);

    const updateSql = String(mockDbQuery.mock.calls[2][0]);
    expect(updateSql).toMatch(/gross_minutes/i);
    expect(updateSql).toMatch(/late_minutes/i);

    const updateParams = mockDbQuery.mock.calls[2][1] as unknown[];
    expect(updateParams).toContain(0);
  });
});

// ---------------------------------------------------------------------------
// POST /admin/attendance/sessions/:id/lock
// ---------------------------------------------------------------------------
//
// DB call order — keep these mocks in sync whenever the route handler changes.
//
// This endpoint is owner-only.  The owner check happens before any DB call;
// non-owners receive 403 immediately with 0 DB calls.
//
// HAPPY PATH — owner (3 synchronous + 1 async call):
//   1. SELECT session     → SELECT id, status, employee_id FROM attendance_sessions
//                            WHERE id=$1 AND workspace_owner_id=$2
//   2. UPDATE session     → SET status='locked', updated_at=$1 WHERE id=$2
//   3. writeAuditLog      → INSERT INTO attendance_audit_logs … (failure caught)
//   4. push notification  → sendAttendanceSessionPush (fire-and-forget via
//                            sendAttendanceSessionPush; not a direct db.query)
//
// Early exits (no UPDATE):
//   - session not found                          → 404, stops after call 1
//   - session.status === 'locked'                → 409, stops after call 1
//   - session.status NOT IN (approved,completed) → 409, stops after call 1
//
// Adding a new db.query() to the handler requires a matching
// mockDbQuery.mockResolvedValueOnce(…) in EVERY test that reaches that code
// path.  Tests that don't reach the new call are unaffected.

describe("POST /admin/attendance/sessions/:id/lock", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.resetAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubUserId = "user_abc";
  });

  it("returns 403 for non-owners", async () => {
    stubActualRole = "member";
    const res = await request(app).post("/admin/attendance/sessions/5/lock");
    expect(res.status).toBe(403);
  });

  it("returns 404 when session not found", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await request(app).post("/admin/attendance/sessions/999/lock");
    expect(res.status).toBe(404);
  });

  it("returns 409 when session is already locked", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 5, status: "locked" }], rowCount: 1 });
    const res = await request(app).post("/admin/attendance/sessions/5/lock");
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already locked/i);
  });

  it("returns 409 when session is not in approved or completed status", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 5, status: "open" }], rowCount: 1 });
    const res = await request(app).post("/admin/attendance/sessions/5/lock");
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/approved or completed/i);
  });

  it("returns 200 and locks an approved session", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5, status: "approved", employee_id: 42 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })  // UPDATE
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // audit log
      .mockResolvedValueOnce({ rows: [{ expo_push_token: null }], rowCount: 1 }); // token lookup (async)

    const res = await request(app).post("/admin/attendance/sessions/5/lock");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("also locks a completed session", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 6, status: "completed", employee_id: 7 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ expo_push_token: null }], rowCount: 1 }); // token lookup (async)

    const res = await request(app).post("/admin/attendance/sessions/6/lock");
    expect(res.status).toBe(200);
  });

  it("fires push notification with correct payload when employee has an expo push token", async () => {
    mockSendPush.mockResolvedValue(undefined);

    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5, status: "approved", employee_id: 42 }], rowCount: 1 }) // SELECT session
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })  // UPDATE
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // audit log
      .mockResolvedValueOnce({ rows: [{ expo_push_token: "ExponentPushToken[lock789]" }], rowCount: 1 }); // token lookup (async)

    const res = await request(app).post("/admin/attendance/sessions/5/lock");
    expect(res.status).toBe(200);

    await vi.waitFor(() => expect(mockSendPush).toHaveBeenCalled());
    expect(mockSendPush).toHaveBeenCalledWith(
      "ExponentPushToken[lock789]",
      "Session Locked",
      "Your attendance session has been finalized.",
      { screen: "attendance" },
      expect.any(Function),
    );
  });

  it("does not fire push notification when employee has no expo push token (lock)", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5, status: "approved", employee_id: 42 }], rowCount: 1 }) // SELECT session
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })  // UPDATE
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // audit log
      .mockResolvedValueOnce({ rows: [{ expo_push_token: null }], rowCount: 1 }); // token lookup → null (async)

    const res = await request(app).post("/admin/attendance/sessions/5/lock");
    expect(res.status).toBe(200);

    await vi.waitFor(() => expect(mockDbQuery).toHaveBeenCalledTimes(4));
    expect(mockSendPush).not.toHaveBeenCalled();
  });

  it("returns 200 even when the push notification fails (lock)", async () => {
    mockSendPush.mockRejectedValue(new Error("Push service unavailable"));

    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5, status: "approved", employee_id: 42 }], rowCount: 1 }) // SELECT session
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })  // UPDATE
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // audit log
      .mockResolvedValueOnce({ rows: [{ expo_push_token: "ExponentPushToken[lock789]" }], rowCount: 1 }); // token lookup (async)

    const res = await request(app).post("/admin/attendance/sessions/5/lock");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    await vi.waitFor(() => expect(mockSendPush).toHaveBeenCalled());
  });
});

// ---------------------------------------------------------------------------
// GET /admin/attendance/export.csv
// ---------------------------------------------------------------------------
//
// DB call order — keep these mocks in sync whenever the route handler changes.
//
// This endpoint is owner-only.  The owner check happens before any DB call;
// non-owners receive 403 immediately with 0 DB calls.
//
// HAPPY PATH — owner (1 DB call):
//   1. SELECT sessions    → SELECT s.id, tm.first_name||…last_name AS employee_name,
//                            s.clock_in_at, s.clock_out_at, gross/break/paid/
//                            overtime/late/early_leave minutes, s.status,
//                            clock_in/out_verification_status, l.name AS location_name
//                            FROM attendance_sessions s
//                            JOIN team_members tm ON tm.id = s.employee_id
//                            LEFT JOIN locations l ON l.id = s.location_id
//                            WHERE s.workspace_owner_id=$1
//                            [+ optional ?from / ?to (clock_in_at range)]
//                            [+ optional ?employee_id]
//                            AND s.status IN ('approved','locked','completed')
//                            ORDER BY s.clock_in_at ASC
//                            (no LIMIT — full export)
//
// Status filtering is HARDCODED — callers cannot override it via query params.
// Response is returned as text/csv; no second query is issued.
//
// Adding a new db.query() to the handler requires a matching
// mockDbQuery.mockResolvedValueOnce(…) in EVERY test that reaches that code
// path.  Tests that don't reach the new call are unaffected.

describe("GET /admin/attendance/export.csv", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.resetAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubUserId = "user_abc";
  });

  it("returns 403 for non-owners", async () => {
    stubActualRole = "member";
    const res = await request(app).get("/admin/attendance/export.csv");
    expect(res.status).toBe(403);
  });

  it("returns CSV with header row when there are no rows", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await request(app).get("/admin/attendance/export.csv");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.text).toMatch(/employee_name/);
  });

  it("returns CSV rows for each session", async () => {
    const row = {
      id: 1,
      employee_name: "Alice Smith",
      clock_in_at: "2025-01-01T09:00:00Z",
      clock_out_at: "2025-01-01T17:00:00Z",
      gross_minutes: 480,
      break_minutes: 60,
      paid_minutes: 420,
      overtime_minutes: 0,
      late_minutes: 0,
      early_leave_minutes: 0,
      status: "approved",
      clock_in_verification_status: "verified",
      clock_out_verification_status: "verified",
      location_name: "HQ",
    };

    mockDbQuery.mockResolvedValueOnce({ rows: [row], rowCount: 1 });
    const res = await request(app).get("/admin/attendance/export.csv");

    expect(res.status).toBe(200);
    expect(res.text).toContain("Alice Smith");
    expect(res.text).toContain("approved");
    expect(res.text).toContain("HQ");
  });

  it("escapes commas and quotes in CSV values", async () => {
    const row = {
      id: 2,
      employee_name: 'Bob, "The Manager"',
      clock_in_at: "2025-01-01T09:00:00Z",
      clock_out_at: null,
      gross_minutes: null,
      break_minutes: null,
      paid_minutes: null,
      overtime_minutes: null,
      late_minutes: null,
      early_leave_minutes: null,
      status: "open",
      clock_in_verification_status: "verified",
      clock_out_verification_status: null,
      location_name: null,
    };

    mockDbQuery.mockResolvedValueOnce({ rows: [row], rowCount: 1 });
    const res = await request(app).get("/admin/attendance/export.csv");

    expect(res.status).toBe(200);
    expect(res.text).toContain('"Bob, ""The Manager"""');
  });

  it("includes overtime_minutes, late_minutes, early_leave_minutes columns and outputs 0 when DB values are null", async () => {
    // Simulate what the DB returns after COALESCE(col, 0): source columns are NULL
    // but the query coerces them to 0 so blank cells never appear in the export.
    const row = {
      id: 3,
      employee_name: "Carol Jones",
      clock_in_at: "2025-02-01T08:00:00Z",
      clock_out_at: "2025-02-01T16:00:00Z",
      gross_minutes: 0,
      break_minutes: 0,
      paid_minutes: 0,
      // These three columns are the focus: DB source is NULL, COALESCE returns 0.
      overtime_minutes: 0,
      late_minutes: 0,
      early_leave_minutes: 0,
      status: "approved",
      clock_in_verification_status: "verified",
      clock_out_verification_status: "verified",
      location_name: "Branch A",
    };

    mockDbQuery.mockResolvedValueOnce({ rows: [row], rowCount: 1 });
    const res = await request(app).get("/admin/attendance/export.csv");

    expect(res.status).toBe(200);

    const lines = res.text.split("\n");
    const headerLine = lines[0];
    const dataLine = lines[1];

    // Header must contain all three column names.
    expect(headerLine).toContain("overtime_minutes");
    expect(headerLine).toContain("late_minutes");
    expect(headerLine).toContain("early_leave_minutes");

    // Resolve column positions from the header so the test stays correct even
    // if column order ever changes.
    const headers = headerLine.split(",");
    const overtimeIdx = headers.indexOf("overtime_minutes");
    const lateIdx = headers.indexOf("late_minutes");
    const earlyLeaveIdx = headers.indexOf("early_leave_minutes");

    expect(overtimeIdx).toBeGreaterThanOrEqual(0);
    expect(lateIdx).toBeGreaterThanOrEqual(0);
    expect(earlyLeaveIdx).toBeGreaterThanOrEqual(0);

    const cells = dataLine.split(",");
    // Each cell must be "0", not an empty string.
    expect(cells[overtimeIdx]).toBe("0");
    expect(cells[lateIdx]).toBe("0");
    expect(cells[earlyLeaveIdx]).toBe("0");
  });
});

// ---------------------------------------------------------------------------
// GET /admin/attendance/sessions/:id/audit-log
// ---------------------------------------------------------------------------
//
// DB call order — keep these mocks in sync whenever the route handler changes.
//
// This endpoint is owner-only.  The owner check happens before any DB call;
// non-owners receive 403 immediately with 0 DB calls.
//
// HAPPY PATH — owner (1 DB call):
//   1. SELECT audit log   → SELECT * FROM attendance_audit_logs
//                            WHERE attendance_session_id = $1
//                              AND workspace_owner_id = $2
//                            ORDER BY created_at ASC
//                            (no JOIN — raw log rows returned as-is)
//
// No second query is issued.  Returns an empty array when no log rows exist.
//
// Adding a new db.query() to the handler requires a matching
// mockDbQuery.mockResolvedValueOnce(…) in EVERY test that reaches that code
// path.  Tests that don't reach the new call are unaffected.

describe("GET /admin/attendance/sessions/:id/audit-log", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.resetAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubUserId = "user_abc";
  });

  it("returns 403 for non-owners", async () => {
    stubActualRole = "member";
    const res = await request(app).get("/admin/attendance/sessions/5/audit-log");
    expect(res.status).toBe(403);
  });

  it("returns 200 with audit log entries", async () => {
    const logs = [{ id: 1, action: "clock_in" }, { id: 2, action: "clock_out" }];
    mockDbQuery.mockResolvedValueOnce({ rows: logs, rowCount: 2 });

    const res = await request(app).get("/admin/attendance/sessions/5/audit-log");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.logs).toHaveLength(2);
    expect(res.body.logs[0].action).toBe("clock_in");
  });

  it("passes the correct workspaceOwnerId and sessionId", async () => {
    stubWorkspaceOwnerId = "owner_xyz";
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app).get("/admin/attendance/sessions/42/audit-log");

    const [, params] = mockDbQuery.mock.calls[0];
    expect(params).toContain(42);
    expect(params).toContain("owner_xyz");
  });
});
