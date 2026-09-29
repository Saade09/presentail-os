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
  authed: (req: express.Request) => req,
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

import attendanceMobileRouter from "./attendanceMobile";

// ---------------------------------------------------------------------------
// Test app
// ---------------------------------------------------------------------------

const mockReqLog = vi.fn();

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: typeof mockReqLog }).log = mockReqLog;
    next();
  });
  app.use(attendanceMobileRouter);
  return app;
}

// ---------------------------------------------------------------------------
// GET /attendance/today
// ---------------------------------------------------------------------------
//
// DB call order — keep these mocks in sync whenever the route handler changes.
//
// HAPPY PATH (5 calls — open session + active break both present):
//   1. resolveEmployeeId      → SELECT tm.id FROM team_members JOIN workspace_members;
//                               returns { id }
//   2. open session           → SELECT s.*, l.* FROM attendance_sessions s
//                                LEFT JOIN locations l … WHERE status = 'open' LIMIT 1
//   3. active break           → SELECT * FROM attendance_breaks
//                                WHERE break_end_at IS NULL LIMIT 1
//                               *** only issued when step 2 returned an open session ***
//   4. assigned location      → SELECT l.* FROM team_members JOIN locations
//                                WHERE tm.id = $1
//   5. today's schedule       → SELECT ws.name, wsd.* FROM team_members
//                                LEFT JOIN work_schedules LEFT JOIN work_schedule_days
//
// Short-circuit paths:
//   - resolveEmployeeId returns empty  → 403, stops after call 1
//   - no open session found            → step 3 is skipped; only 4 calls total
//
// Adding a new db.query() to the handler requires a matching
// mockDbQuery.mockResolvedValueOnce(…) in EVERY test that reaches that code
// path.  Tests that don't reach the new call are unaffected.

describe("GET /attendance/today", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.resetAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubUserId = "user_abc";
  });

  it("returns 403 when the user has no team member record", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // resolveEmployeeId

    const res = await request(app).get("/attendance/today");

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/no team member record/i);
  });

  it("returns 200 with employeeId and null open session when clocked out", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 })  // resolveEmployeeId
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })              // open session (none — active break skipped)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })              // assigned location
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });             // today schedule

    const res = await request(app).get("/attendance/today");

    expect(res.status).toBe(200);
    expect(res.body.employeeId).toBe(42);
    expect(res.body.openSession).toBeNull();
    expect(res.body.activeBreak).toBeNull();
    expect(res.body.todaySchedule).toBeNull();
  });

  it("includes activeBreak and todaySchedule when an open session and active break exist", async () => {
    const fakeSession = { id: 7, status: "open" };
    const fakeBreak = { id: 3, break_start_at: "2025-01-01T10:00:00Z" };
    const fakeSchedule = { schedule_name: "Standard", day_of_week: "monday", is_working_day: true, start_time: "09:00", end_time: "17:00", break_minutes: 60 };

    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 })         // resolveEmployeeId
      .mockResolvedValueOnce({ rows: [fakeSession], rowCount: 1 })         // open session
      .mockResolvedValueOnce({ rows: [fakeBreak], rowCount: 1 })           // active break
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                   // assigned location
      .mockResolvedValueOnce({ rows: [fakeSchedule], rowCount: 1 });      // today schedule

    const res = await request(app).get("/attendance/today");

    expect(res.status).toBe(200);
    expect(res.body.openSession.id).toBe(7);
    expect(res.body.activeBreak.id).toBe(3);
    expect(res.body.todaySchedule.schedule_name).toBe("Standard");
  });
});

// ---------------------------------------------------------------------------
// POST /attendance/clock-in
// ---------------------------------------------------------------------------
//
// DB call order — keep these mocks in sync whenever the route handler changes.
//
// HAPPY PATH (successful clock-in):
//   1. resolveEmployeeId      → SELECT from team_members JOIN workspace_members; returns { id }
//   2. open-session guard     → SELECT id FROM attendance_sessions WHERE status='open' LIMIT 1
//   3. info query             → SELECT tm.location_id, loc_lat, loc_lon, geofence_radius_meters,
//                                attendance_enabled, allowed_remote FROM team_members
//                                LEFT JOIN locations LEFT JOIN team_member_profiles
//   4. INSERT session         → INSERT INTO attendance_sessions … RETURNING *
//   5. writeAuditLog          → INSERT INTO attendance_audit_logs (always fires after INSERT;
//                                failure is caught+logged, response is 201 regardless)
//
// Early exits (no INSERT):
//   - resolveEmployeeId returns empty  → 403, stops after call 1
//   - open-session guard finds a row   → 409, stops after call 2
//
// Adding a new db.query() to the handler requires a matching
// mockDbQuery.mockResolvedValueOnce(…) in EVERY test that reaches that code
// path.  Tests that don't reach the new call are unaffected.

describe("POST /attendance/clock-in", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.resetAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubUserId = "user_abc";
  });

  it("returns 403 when user has no team member record", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // resolveEmployeeId

    const res = await request(app).post("/attendance/clock-in").send({});

    expect(res.status).toBe(403);
  });

  it("returns 409 when an open session already exists", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 }) // resolveEmployeeId
      .mockResolvedValueOnce({ rows: [{ id: 99 }], rowCount: 1 }); // existing open session

    const res = await request(app).post("/attendance/clock-in").send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/open session already exists/i);
  });

  it("returns 201 with session on successful clock-in", async () => {
    const fakeSession = { id: 10, status: "open", clock_in_at: "2025-01-01T09:00:00Z" };

    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 })  // resolveEmployeeId
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })              // no existing open session
      .mockResolvedValueOnce({ rows: [{ location_id: 1, loc_lat: 25.2, loc_lon: 55.2, geofence_radius_meters: 100, attendance_enabled: true, allowed_remote: false }], rowCount: 1 }) // info
      .mockResolvedValueOnce({ rows: [fakeSession], rowCount: 1 })  // INSERT session
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });             // audit log

    const res = await request(app).post("/attendance/clock-in").send({
      latitude: 25.2,
      longitude: 55.2,
    });

    expect(res.status).toBe(201);
    expect(res.body.session.id).toBe(10);
    expect(res.body.verificationStatus).toBe("verified");
  });

  it("returns 201 even when the audit log INSERT fails after the session is created", async () => {
    const fakeSession = { id: 11, status: "open", clock_in_at: "2025-01-01T09:00:00Z" };

    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 })  // resolveEmployeeId
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })              // no existing open session
      .mockResolvedValueOnce({ rows: [{ location_id: 1, loc_lat: 25.2, loc_lon: 55.2, geofence_radius_meters: 100, attendance_enabled: true, allowed_remote: false }], rowCount: 1 }) // info
      .mockResolvedValueOnce({ rows: [fakeSession], rowCount: 1 })  // INSERT session
      .mockRejectedValueOnce(new Error("attendance_audit_logs table missing")); // audit log fails

    const res = await request(app).post("/attendance/clock-in").send({
      latitude: 25.2,
      longitude: 55.2,
    });

    expect(res.status).toBe(201);
    expect(res.body.session.id).toBe(11);
  });

  it("sets verification status to outside_geofence when far away and remote not allowed", async () => {
    const fakeSession = { id: 11, status: "open" };

    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 })  // resolveEmployeeId
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })              // no existing open session
      .mockResolvedValueOnce({ rows: [{ location_id: 1, loc_lat: 25.2, loc_lon: 55.2, geofence_radius_meters: 100, attendance_enabled: true, allowed_remote: false }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [fakeSession], rowCount: 1 })   // INSERT session
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });             // audit log

    const res = await request(app).post("/attendance/clock-in").send({
      latitude: 25.4,   // ~22 km away
      longitude: 55.2,
    });

    expect(res.status).toBe(201);
    expect(res.body.verificationStatus).toBe("outside_geofence");
  });

  it("sets verification status to manual_exception when far away but remote allowed", async () => {
    const fakeSession = { id: 12, status: "open" };

    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ location_id: 1, loc_lat: 25.2, loc_lon: 55.2, geofence_radius_meters: 100, attendance_enabled: true, allowed_remote: true }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [fakeSession], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).post("/attendance/clock-in").send({
      latitude: 25.4,
      longitude: 55.2,
    });

    expect(res.status).toBe(201);
    expect(res.body.verificationStatus).toBe("manual_exception");
  });
});

// ---------------------------------------------------------------------------
// POST /attendance/start-break
// ---------------------------------------------------------------------------
//
// DB call order — keep these mocks in sync whenever the route handler changes.
//
// HAPPY PATH (successful break start):
//   1. resolveEmployeeId      → SELECT from team_members JOIN workspace_members; returns { id }
//   2. open-session lookup    → SELECT id FROM attendance_sessions
//                                WHERE status='open' LIMIT 1
//   3. active-break guard     → SELECT id FROM attendance_breaks
//                                WHERE attendance_session_id=$session
//                                AND break_end_at IS NULL LIMIT 1
//   4. INSERT break           → INSERT INTO attendance_breaks
//                                (attendance_session_id, employee_id, break_start_at,
//                                 break_type, note) VALUES … RETURNING *
//
// Early exits (no INSERT):
//   - resolveEmployeeId returns empty  → 403, stops after call 1
//   - no open session found            → 404, stops after call 2
//   - active break already exists      → 409, stops after call 3
//
// Adding a new db.query() to the handler requires a matching
// mockDbQuery.mockResolvedValueOnce(…) in EVERY test that reaches that code
// path.  Tests that don't reach the new call are unaffected.

describe("POST /attendance/start-break", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.resetAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubUserId = "user_abc";
  });

  it("returns 403 when user has no team member record", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await request(app).post("/attendance/start-break").send({});
    expect(res.status).toBe(403);
  });

  it("returns 404 when no open session found", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 }) // resolveEmployeeId
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });           // no open session
    const res = await request(app).post("/attendance/start-break").send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/clock in first/i);
  });

  it("returns 409 when a break is already active", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 }) // resolveEmployeeId
      .mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 })  // open session
      .mockResolvedValueOnce({ rows: [{ id: 3 }], rowCount: 1 }); // active break exists
    const res = await request(app).post("/attendance/start-break").send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/break is already active/i);
  });

  it("returns 201 with break record on success", async () => {
    const fakeBreak = { id: 7, break_start_at: "2025-01-01T10:00:00Z", break_type: "lunch" };

    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 }) // resolveEmployeeId
      .mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 })  // open session
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })            // no active break
      .mockResolvedValueOnce({ rows: [fakeBreak], rowCount: 1 }); // INSERT break

    const res = await request(app).post("/attendance/start-break").send({ break_type: "lunch" });

    expect(res.status).toBe(201);
    expect(res.body.break.id).toBe(7);
    expect(res.body.break.break_type).toBe("lunch");
  });
});

// ---------------------------------------------------------------------------
// POST /attendance/end-break
// ---------------------------------------------------------------------------
//
// DB call order — keep these mocks in sync whenever the route handler changes.
//
// HAPPY PATH (successful break end):
//   1. resolveEmployeeId  → SELECT from team_members JOIN workspace_members; returns { id }
//   2. UPDATE with subquery → UPDATE attendance_breaks SET break_end_at=$1, updated_at=$1
//                              WHERE id = (
//                                SELECT ab.id FROM attendance_breaks ab
//                                 JOIN attendance_sessions s ON s.id = ab.attendance_session_id
//                                WHERE s.employee_id=$2 AND s.workspace_owner_id=$3
//                                  AND s.status='open' AND ab.break_end_at IS NULL
//                                ORDER BY ab.break_start_at DESC LIMIT 1
//                              )
//                              RETURNING *
//
// Early exits (no UPDATE rows returned):
//   - resolveEmployeeId returns empty          → 403, stops after call 1
//   - UPDATE returns 0 rows (no active break)  → 404, stops after call 2
//
// Adding a new db.query() to the handler requires a matching
// mockDbQuery.mockResolvedValueOnce(…) in EVERY test that reaches that code
// path.  Tests that don't reach the new call are unaffected.

describe("POST /attendance/end-break", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.resetAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubUserId = "user_abc";
  });

  it("returns 403 when user has no team member record", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await request(app).post("/attendance/end-break");
    expect(res.status).toBe(403);
  });

  it("returns 404 when no active break found", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 }) // resolveEmployeeId
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });           // UPDATE returns nothing
    const res = await request(app).post("/attendance/end-break");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no active break/i);
  });

  it("returns 200 with updated break on success", async () => {
    const updatedBreak = { id: 7, break_end_at: "2025-01-01T10:30:00Z" };

    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 })         // resolveEmployeeId
      .mockResolvedValueOnce({ rows: [updatedBreak], rowCount: 1 });       // UPDATE break

    const res = await request(app).post("/attendance/end-break");

    expect(res.status).toBe(200);
    expect(res.body.break.id).toBe(7);
    expect(res.body.break.break_end_at).toBe("2025-01-01T10:30:00Z");
  });
});

// ---------------------------------------------------------------------------
// POST /attendance/clock-out
// ---------------------------------------------------------------------------
//
// DB call order — keep these mocks in sync whenever the route handler changes.
//
// HAPPY PATH (successful clock-out):
//   1. resolveEmployeeId  → SELECT from team_members JOIN workspace_members; returns { id }
//   2. open session       → SELECT s.id, s.clock_in_at, s.location_id, l.*, tmp.allowed_remote
//                            FROM attendance_sessions LEFT JOIN locations
//                            LEFT JOIN team_member_profiles WHERE status='open' LIMIT 1
//   3. auto-close breaks  → UPDATE attendance_breaks SET break_end_at=now()
//                            WHERE attendance_session_id=$session AND break_end_at IS NULL
//                            (always runs; rowCount may be 0 when no break is open)
//   4. sum breaks         → SELECT break_start_at, break_end_at FROM attendance_breaks
//                            WHERE attendance_session_id=$session (always runs; may return 0 rows)
//   5. schedule lookup    → SELECT wsd.start_time, wsd.end_time, wsd.break_minutes
//                            FROM team_members LEFT JOIN team_member_profiles LEFT JOIN locations
//                            LEFT JOIN work_schedule_days for the clock-in day
//                            (always runs; may return 0 rows when employee has no assigned schedule)
//   6. UPDATE session     → UPDATE attendance_sessions SET clock_out_at, status,
//                            gross/break/paid/overtime/late/early_leave_minutes … RETURNING *
//   7. writeAuditLog      → INSERT INTO attendance_audit_logs (always fires after UPDATE;
//                            failure is caught+logged, response is 200 regardless)
//
// Early exits (no UPDATE):
//   - resolveEmployeeId returns empty → 403, stops after call 1
//   - no open session found           → 404, stops after call 2
//
// Adding a new db.query() to the handler requires a matching
// mockDbQuery.mockResolvedValueOnce(…) in EVERY test that reaches that code
// path.  Tests that don't reach the new call are unaffected.

describe("POST /attendance/clock-out", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.resetAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubUserId = "user_abc";
  });

  it("returns 403 when user has no team member record", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await request(app).post("/attendance/clock-out").send({});
    expect(res.status).toBe(403);
  });

  it("returns 404 when no open session found", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 }) // resolveEmployeeId
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });           // no open session
    const res = await request(app).post("/attendance/clock-out").send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no open session/i);
  });

  it("returns 200 with session data on successful clock-out", async () => {
    const openSession = {
      id: 10, clock_in_at: "2025-01-01T09:00:00Z",
      location_id: 1, loc_lat: 25.2, loc_lon: 55.2,
      geofence_radius_meters: 100, allowed_remote: false,
    };
    const updatedSession = {
      id: 10, status: "completed", paid_minutes: 450,
      clock_out_at: "2025-01-01T17:00:00Z",
    };

    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 })         // resolveEmployeeId
      .mockResolvedValueOnce({ rows: [openSession], rowCount: 1 })         // open session
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                    // auto-close active breaks
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                    // sum breaks
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                    // schedule lookup (no schedule)
      .mockResolvedValueOnce({ rows: [updatedSession], rowCount: 1 })      // UPDATE session
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });                   // audit log

    const res = await request(app).post("/attendance/clock-out").send({
      latitude: 25.2,
      longitude: 55.2,
    });

    expect(res.status).toBe(200);
    expect(res.body.session.id).toBe(10);
  });

  it("sets status to pending_review when clock-out is outside geofence", async () => {
    const openSession = {
      id: 10, clock_in_at: "2025-01-01T09:00:00Z",
      location_id: 1, loc_lat: 25.2, loc_lon: 55.2,
      geofence_radius_meters: 100, allowed_remote: false,
    };
    const updatedSession = { id: 10, status: "pending_review" };

    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [openSession], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                    // schedule lookup (no schedule)
      .mockResolvedValueOnce({ rows: [updatedSession], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).post("/attendance/clock-out").send({
      latitude: 25.4,  // far away
      longitude: 55.2,
    });

    expect(res.status).toBe(200);
    expect(res.body.session.status).toBe("pending_review");
  });

  it("passes late_minutes to UPDATE when employee has a schedule and clocked in late", async () => {
    // Clock-in 35 minutes after schedule start (> 5-minute grace period → 35 late minutes)
    const openSession = {
      id: 10, clock_in_at: "2025-01-01T09:35:00Z",
      location_id: 1, loc_lat: 25.2, loc_lon: 55.2,
      geofence_radius_meters: 100, allowed_remote: false,
    };
    // schedule: 09:00–17:00 with 0 break minutes (from team_member_profiles.work_schedule_id)
    const scheduleRow = { start_time: "09:00:00", end_time: "17:00:00", break_minutes: 0 };
    const updatedSession = {
      id: 10, status: "completed", paid_minutes: 385,
      late_minutes: 35, early_leave_minutes: 0, overtime_minutes: 0,
    };

    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 })         // resolveEmployeeId
      .mockResolvedValueOnce({ rows: [openSession], rowCount: 1 })         // open session
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                    // auto-close active breaks
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                    // sum breaks (0 break mins)
      .mockResolvedValueOnce({ rows: [scheduleRow], rowCount: 1 })         // schedule lookup (profile schedule)
      .mockResolvedValueOnce({ rows: [updatedSession], rowCount: 1 })      // UPDATE session
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });                   // audit log

    const res = await request(app).post("/attendance/clock-out").send({
      latitude: 25.2,
      longitude: 55.2,
    });

    expect(res.status).toBe(200);

    // Verify the schedule lookup included location_id ($3 param = 1)
    const scheduleCall = mockDbQuery.mock.calls[4];
    expect(scheduleCall[1][2]).toBe(1); // location_id passed as $3

    // Verify the UPDATE was called with the calculated late_minutes (index 11 = $12).
    // late_minutes depends only on clock-in time vs schedule start, so it's deterministic.
    // overtime_minutes depends on real clock-out time (now), so only verify it's a number.
    const updateCall = mockDbQuery.mock.calls[5];
    expect(updateCall[1][11]).toBe(35);            // late_minutes = 35 (deterministic)
    expect(updateCall[1][10]).toBeGreaterThanOrEqual(0); // overtime_minutes ≥ 0
    expect(updateCall[1][12]).toBe(0);             // early_leave_minutes = 0 (clocked out after sched end)
  });

  it("passes overtime_minutes to UPDATE when employee works past schedule end", async () => {
    // Clock-in on time (09:00), clock-out is now (taken as current time by the handler).
    // We simulate 30 minutes of overtime by setting clock_in_at to 07:30 against a 09:00-17:00 schedule.
    // Paid = gross - 0 break = 570 min. Sched paid = 480. Overtime = 90.
    const openSession = {
      id: 11, clock_in_at: "2025-01-01T08:30:00Z",
      location_id: 2, loc_lat: 25.2, loc_lon: 55.2,
      geofence_radius_meters: 100, allowed_remote: false,
    };
    // location fallback schedule: 09:00–17:00 (locations.default_schedule_id)
    const scheduleRow = { start_time: "09:00:00", end_time: "17:00:00", break_minutes: 0 };
    const updatedSession = {
      id: 11, status: "completed", paid_minutes: 570,
      late_minutes: 0, early_leave_minutes: 0, overtime_minutes: 90,
    };

    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 })         // resolveEmployeeId
      .mockResolvedValueOnce({ rows: [openSession], rowCount: 1 })         // open session
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                    // auto-close active breaks
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                    // sum breaks (0 break mins)
      .mockResolvedValueOnce({ rows: [scheduleRow], rowCount: 1 })         // schedule lookup (location fallback)
      .mockResolvedValueOnce({ rows: [updatedSession], rowCount: 1 })      // UPDATE session
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });                   // audit log

    const res = await request(app).post("/attendance/clock-out").send({
      latitude: 25.2,
      longitude: 55.2,
    });

    expect(res.status).toBe(200);

    // Verify the schedule lookup passed the correct location_id ($3 param = 2)
    const scheduleCall = mockDbQuery.mock.calls[4];
    expect(scheduleCall[1][2]).toBe(2); // location_id passed as $3

    // Verify overtime_minutes is non-zero in the UPDATE params (index 10 = $11)
    const updateCall = mockDbQuery.mock.calls[5];
    expect(updateCall[1][10]).toBeGreaterThan(0); // overtime_minutes > 0
    expect(updateCall[1][11]).toBe(0);            // late_minutes = 0 (clocked in before sched start)
  });
});

// ---------------------------------------------------------------------------
// POST /attendance/requests
// ---------------------------------------------------------------------------
//
// DB call order — keep these mocks in sync whenever the route handler changes.
//
// PATH A — no attendance_session_id (standalone request, e.g. missed_clock_in):
//   1. resolveEmployeeId  → SELECT from team_members; returns { id } or empty
//   2. dupCheck           → SELECT 1 FROM attendance_requests WHERE … AND attendance_session_id IS NULL
//   3. INSERT request     → INSERT INTO attendance_requests RETURNING *
//   4. manager push token → SELECT expo_push_token … (fire-and-forget; always runs after INSERT)
//
// PATH B — attendance_session_id provided (session-linked request, e.g. edit_clock_in):
//   1. resolveEmployeeId  → SELECT from team_members; returns { id } or empty
//   2. sessionCheck       → SELECT 1 FROM attendance_sessions WHERE id=$1 AND employee_id=$2 …
//   3. dupCheck           → SELECT 1 FROM attendance_requests WHERE … AND attendance_session_id=$session_id
//   4. INSERT request     → INSERT INTO attendance_requests RETURNING *
//   5. manager push token → SELECT expo_push_token … (fire-and-forget; always runs after INSERT)
//
// Early exits (no INSERT):
//   - resolveEmployeeId returns empty   → 403, stops after call 1
//   - sessionCheck returns empty        → 403, stops after call 2 (PATH B only)
//   - dupCheck returns a row            → 409, stops before INSERT
//
// Adding a new db.query() to the handler requires a matching
// mockDbQuery.mockResolvedValueOnce(…) in EVERY test that reaches that code
// path.  Tests that don't reach the new call are unaffected.

describe("POST /attendance/requests", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.resetAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubUserId = "user_abc";
  });

  it("returns 400 for an invalid request_type", async () => {
    const res = await request(app)
      .post("/attendance/requests")
      .send({ request_type: "bad_type" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/request_type must be one of/i);
  });

  it("returns 403 when user has no team member record", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .post("/attendance/requests")
      .send({ request_type: "missed_clock_in" });

    expect(res.status).toBe(403);
  });

  it("returns 201 with the created request", async () => {
    const fakeReq = { id: 5, request_type: "missed_clock_in", status: "pending" };

    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 }) // resolveEmployeeId
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })            // dupCheck → no existing pending
      .mockResolvedValueOnce({ rows: [fakeReq], rowCount: 1 });   // INSERT request

    const res = await request(app)
      .post("/attendance/requests")
      .send({ request_type: "missed_clock_in", reason: "Forgot to clock in" });

    expect(res.status).toBe(201);
    expect(res.body.request.id).toBe(5);
    expect(res.body.request.status).toBe("pending");
  });

  it("returns 403 when attendance_session_id belongs to another employee", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 }) // resolveEmployeeId
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });            // session check → not found

    const res = await request(app)
      .post("/attendance/requests")
      .send({ request_type: "edit_clock_in", attendance_session_id: 999, reason: "Wrong session" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/invalid attendance session/i);
  });

  it("sends a push notification to the manager with screen: approvals after a correction is submitted", async () => {
    const fakeReq = { id: 5, request_type: "edit_clock_in", status: "pending" };
    const managerRow = {
      expo_push_token: "ExponentPushToken[manager_abc]",
      first_name: "Jane",
      last_name: "Manager",
    };

    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 })     // resolveEmployeeId
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                // dupCheck → no existing pending
      .mockResolvedValueOnce({ rows: [fakeReq], rowCount: 1 })         // INSERT request
      .mockResolvedValueOnce({ rows: [managerRow], rowCount: 1 });     // manager push token lookup

    const res = await request(app)
      .post("/attendance/requests")
      .send({ request_type: "edit_clock_in", reason: "Wrong time recorded" });

    expect(res.status).toBe(201);

    // The push notification is fire-and-forget; wait for the async IIFE to resolve.
    await vi.waitFor(() => {
      expect(mockSendPush).toHaveBeenCalledOnce();
    });

    expect(mockSendPush).toHaveBeenCalledWith(
      "ExponentPushToken[manager_abc]",
      "New Correction Request",
      "Jane Manager submitted a clock-in edit request",
      { screen: "approvals" },
      expect.any(Function),
    );
  });

  it("does not send a push notification when the employee has no manager with a push token", async () => {
    const fakeReq = { id: 6, request_type: "missed_clock_in", status: "pending" };

    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 }) // resolveEmployeeId
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })            // dupCheck → no existing pending
      .mockResolvedValueOnce({ rows: [fakeReq], rowCount: 1 })     // INSERT request
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });            // no manager with push token

    const res = await request(app)
      .post("/attendance/requests")
      .send({ request_type: "missed_clock_in" });

    expect(res.status).toBe(201);

    // Give any pending microtasks a chance to flush, then confirm no push was sent.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockSendPush).not.toHaveBeenCalled();
  });

  it("returns 409 when a standalone (no session) pending request of the same type already exists", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 })           // resolveEmployeeId
      .mockResolvedValueOnce({ rows: [{ status: "pending" }], rowCount: 1 }); // dupCheck → duplicate found

    const res = await request(app)
      .post("/attendance/requests")
      .send({ request_type: "missed_clock_in", reason: "Forgot to clock in" });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/pending request.*already exists/i);
  });

  it("returns 409 when a session-linked pending request of the same type already exists", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 })     // resolveEmployeeId
      .mockResolvedValueOnce({ rows: [{ "?column?": 1 }], rowCount: 1 }) // sessionCheck → session valid
      .mockResolvedValueOnce({ rows: [{ status: "pending" }], rowCount: 1 }); // dupCheck → duplicate found

    const res = await request(app)
      .post("/attendance/requests")
      .send({ request_type: "edit_clock_in", attendance_session_id: 7, reason: "Already submitted" });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/pending request.*already exists/i);
  });

  it("returns 409 with a 'resolved' message when a matching approved request already exists", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 })           // resolveEmployeeId
      .mockResolvedValueOnce({ rows: [{ status: "approved" }], rowCount: 1 }); // dupCheck → approved found

    const res = await request(app)
      .post("/attendance/requests")
      .send({ request_type: "missed_clock_in", reason: "Trying again after approval" });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already been resolved/i);
  });

  it("returns 409 with a 'resolved' message when a matching declined request already exists", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 })           // resolveEmployeeId
      .mockResolvedValueOnce({ rows: [{ status: "declined" }], rowCount: 1 }); // dupCheck → declined found

    const res = await request(app)
      .post("/attendance/requests")
      .send({ request_type: "missed_clock_in", reason: "Trying again after decline" });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already been resolved/i);
  });

  it("returns 409 with a 'resolved' message when a session-linked approved request already exists", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 })             // resolveEmployeeId
      .mockResolvedValueOnce({ rows: [{ "?column?": 1 }], rowCount: 1 })      // sessionCheck → session valid
      .mockResolvedValueOnce({ rows: [{ status: "approved" }], rowCount: 1 }); // dupCheck → approved found

    const res = await request(app)
      .post("/attendance/requests")
      .send({ request_type: "edit_clock_in", attendance_session_id: 7, reason: "Already approved" });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already been resolved/i);
  });
});

// ---------------------------------------------------------------------------
// GET /attendance/my-timesheets
// ---------------------------------------------------------------------------
//
// DB call order — keep these mocks in sync whenever the route handler changes.
//
// HAPPY PATH (3 calls):
//   1. resolveEmployeeId  → SELECT tm.id FROM team_members JOIN workspace_members;
//                           returns { id }
//   2. SELECT sessions    → SELECT s.*, l.name AS location_name
//                            FROM attendance_sessions s LEFT JOIN locations l
//                            WHERE s.employee_id=$1 AND s.workspace_owner_id=$2
//                            [optional: AND s.clock_in_at >= $from / < $to]
//                            ORDER BY s.clock_in_at DESC LIMIT $limit OFFSET $offset
//   3. COUNT total        → SELECT COUNT(*) AS total FROM attendance_sessions s
//                            WHERE <same conditions minus pagination>
//
// Early exits (no SELECT sessions or COUNT):
//   - resolveEmployeeId returns empty → 403, stops after call 1
//
// Adding a new db.query() to the handler requires a matching
// mockDbQuery.mockResolvedValueOnce(…) in EVERY test that reaches that code
// path.  Tests that don't reach the new call are unaffected.

describe("GET /attendance/my-timesheets", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.resetAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubUserId = "user_abc";
  });

  it("returns 403 when user has no team member record", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await request(app).get("/attendance/my-timesheets");
    expect(res.status).toBe(403);
  });

  it("returns 200 with sessions and total", async () => {
    const sessions = [{ id: 1, status: "completed" }];

    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 })   // resolveEmployeeId
      .mockResolvedValueOnce({ rows: sessions, rowCount: 1 })         // SELECT sessions
      .mockResolvedValueOnce({ rows: [{ total: "1" }], rowCount: 1 }); // COUNT

    const res = await request(app).get("/attendance/my-timesheets");

    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(1);
    expect(res.body.total).toBe(1);
  });
});
