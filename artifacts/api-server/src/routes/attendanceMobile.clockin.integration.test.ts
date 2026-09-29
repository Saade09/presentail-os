/**
 * Integration test: clock-in attendance flow.
 *
 * Exercises POST /attendance/clock-in against a real database to verify:
 *
 *   1. On-time clock-in with a valid location — geofence coordinates land
 *      inside the radius → clock_in_verification_status = "verified".
 *
 *   2. Clock-in outside geofence radius — coordinates exceed the location's
 *      radius → clock_in_verification_status = "outside_geofence".
 *
 *   3. Clock-in with no profile row — team member exists but has no
 *      team_member_profiles row; allowed_remote defaults to false via the LEFT
 *      JOIN; session is still created with status "no_location" when no GPS
 *      coordinates are sent.
 *
 *   4. Duplicate open-session guard — attempting to clock in when an open
 *      session already exists returns 409.
 *
 *   5. No team member record — user has no team_members row → 403.
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

const OWNER_ID = "__att_clockin_integ__";
const USER_ID  = "__att_clockin_user__";

// User that has NO team_members row — for the 403 test.
const USER_ID_NO_MEMBER = "__att_clockin_user_nomember__";

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

// activeUserId is mutated per-test so we can swap between the normal user
// (who has a team_members row) and the user who has no such row.
let activeUserId = USER_ID;

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
    wreq.userId    = activeUserId;
    wreq.userEmail = "att-clockin-test@example.com";
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
// Geofence test coordinates
//
// Location anchor: Dubai Marina area (25.0760, 55.1330).
// A point that is ~0 m away (same coords) → "verified".
// A point that is ~1.5 km away (lat+0.014) → "outside_geofence".
// Geofence radius: 200 m.
// ─────────────────────────────────────────────────────────────────────────────

const LOC_LAT = 25.076;
const LOC_LON = 55.133;
const GEO_RADIUS = 200;          // metres

// Exactly the same point → distance 0 m → within radius.
const POINT_INSIDE_LAT = 25.076;
const POINT_INSIDE_LON = 55.133;

// ~1.57 km north → outside 200 m radius.
const POINT_OUTSIDE_LAT = 25.090;
const POINT_OUTSIDE_LON = 55.133;

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
  userId = USER_ID,
): Promise<number> {
  const r = await pool.query<{ id: number }>(
    `INSERT INTO workspace_members
       (workspace_owner_id, member_user_id, member_email, role)
     VALUES ($1, $2, 'att-clockin-test@example.com', 'member')
     RETURNING id`,
    [OWNER_ID, userId],
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
     VALUES ($1, $2, 'ClockinTest', $3)
     RETURNING id`,
    [OWNER_ID, memberDbId, opts.locationId ?? null],
  );
  return r.rows[0].id;
}

/** Insert a team_member_profiles row; workScheduleId may be null. */
async function seedProfile(
  pool: InstanceType<typeof Pool>,
  teamMemberId: number,
  opts: { allowedRemote?: boolean } = {},
): Promise<void> {
  await pool.query(
    `INSERT INTO team_member_profiles
       (workspace_owner_id, team_member_id, employment_type, status, allowed_remote_clock_in)
     VALUES ($1, $2, 'full_time', 'active', $3)`,
    [OWNER_ID, teamMemberId, opts.allowedRemote ?? false],
  );
}

/**
 * Insert a location with geofence coordinates and return its id.
 */
async function seedLocation(
  pool: InstanceType<typeof Pool>,
  opts: {
    lat: number;
    lon: number;
    radiusMeters: number;
  },
): Promise<number> {
  const r = await pool.query<{ id: number }>(
    `INSERT INTO locations
       (workspace_owner_id, name, latitude, longitude, geofence_radius_meters, attendance_enabled)
     VALUES ($1, 'Test Location', $2, $3, $4, true)
     RETURNING id`,
    [OWNER_ID, opts.lat, opts.lon, opts.radiusMeters],
  );
  return r.rows[0].id;
}

/**
 * Insert an open attendance_session. Returns the session id.
 */
async function seedOpenSession(
  pool: InstanceType<typeof Pool>,
  employeeId: number,
  locationId: number | null = null,
): Promise<number> {
  const r = await pool.query<{ id: number }>(
    `INSERT INTO attendance_sessions
       (workspace_owner_id, employee_id, location_id, clock_in_at,
        clock_in_verification_status, status)
     VALUES ($1, $2, $3, NOW(), 'no_location', 'open')
     RETURNING id`,
    [OWNER_ID, employeeId, locationId],
  );
  return r.rows[0].id;
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!DATABASE_URL)(
  "POST /attendance/clock-in — geofencing, session creation, and guard checks (integration)",
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
      // Reset active user to the default.
      activeUserId = USER_ID;
    });

    // ── 1. On-time clock-in within geofence ──────────────────────────────────

    it(
      "clock-in with GPS inside geofence radius — session created with " +
      "clock_in_verification_status = 'verified'",
      async () => {
        const locationId = await seedLocation(pool, {
          lat: LOC_LAT,
          lon: LOC_LON,
          radiusMeters: GEO_RADIUS,
        });

        const wmId = await seedWorkspaceMember(pool);
        const tmId = await seedTeamMember(pool, wmId, { locationId });
        await seedProfile(pool, tmId);

        const res = await request(app)
          .post("/attendance/clock-in")
          .send({
            latitude: POINT_INSIDE_LAT,
            longitude: POINT_INSIDE_LON,
            accuracy_meters: 10,
          });

        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.verificationStatus).toBe("verified");
        expect(res.body.session.status).toBe("open");
        expect(res.body.session.clock_in_verification_status).toBe("verified");
        expect(res.body.session.location_id).toBe(locationId);
        expect(res.body.session.clock_in_latitude).toBeCloseTo(POINT_INSIDE_LAT, 4);
        expect(res.body.session.clock_in_longitude).toBeCloseTo(POINT_INSIDE_LON, 4);
        // Distance should be 0 or very small (same point).
        expect(Number(res.body.session.clock_in_distance_meters)).toBeLessThanOrEqual(1);

        // Confirm the row was persisted.
        const dbRow = await pool.query<{
          status: string;
          clock_in_verification_status: string;
          location_id: number;
        }>(
          `SELECT status, clock_in_verification_status, location_id
             FROM attendance_sessions
            WHERE workspace_owner_id = $1
            LIMIT 1`,
          [OWNER_ID],
        );
        expect(dbRow.rows).toHaveLength(1);
        expect(dbRow.rows[0].status).toBe("open");
        expect(dbRow.rows[0].clock_in_verification_status).toBe("verified");
        expect(dbRow.rows[0].location_id).toBe(locationId);
      },
    );

    // ── 2. Clock-in outside geofence radius ──────────────────────────────────

    it(
      "clock-in with GPS outside geofence radius — session created with " +
      "clock_in_verification_status = 'outside_geofence'",
      async () => {
        const locationId = await seedLocation(pool, {
          lat: LOC_LAT,
          lon: LOC_LON,
          radiusMeters: GEO_RADIUS,
        });

        const wmId = await seedWorkspaceMember(pool);
        const tmId = await seedTeamMember(pool, wmId, { locationId });
        // allowed_remote_clock_in = false (default) → outside_geofence, not manual_exception.
        await seedProfile(pool, tmId, { allowedRemote: false });

        const res = await request(app)
          .post("/attendance/clock-in")
          .send({
            latitude: POINT_OUTSIDE_LAT,
            longitude: POINT_OUTSIDE_LON,
            accuracy_meters: 10,
          });

        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.verificationStatus).toBe("outside_geofence");
        expect(res.body.session.clock_in_verification_status).toBe("outside_geofence");
        // Distance should reflect actual distance, which exceeds the radius.
        const dist = Number(res.body.session.clock_in_distance_meters);
        expect(dist).toBeGreaterThan(GEO_RADIUS);

        // Confirm the row in the DB.
        const dbRow = await pool.query<{ clock_in_verification_status: string }>(
          `SELECT clock_in_verification_status
             FROM attendance_sessions
            WHERE workspace_owner_id = $1
            LIMIT 1`,
          [OWNER_ID],
        );
        expect(dbRow.rows).toHaveLength(1);
        expect(dbRow.rows[0].clock_in_verification_status).toBe("outside_geofence");
      },
    );

    // ── 3. Clock-in with no profile row ──────────────────────────────────────

    it(
      "clock-in with no team_member_profiles row — session created with " +
      "status 'no_location' when no GPS coordinates are sent",
      async () => {
        // No profile row is seeded. The LEFT JOIN in the route returns null for
        // allowed_remote_clock_in, which COALESCE maps to false.  With no GPS
        // coordinates in the request body, geoVerdict returns "no_location".
        const wmId = await seedWorkspaceMember(pool);
        // Team member has no location assignment either.
        await seedTeamMember(pool, wmId, { locationId: null });
        // Deliberately skip seedProfile so the LEFT JOIN has no profile match.

        const res = await request(app)
          .post("/attendance/clock-in")
          .send({}); // no GPS payload

        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.verificationStatus).toBe("no_location");
        expect(res.body.session.clock_in_verification_status).toBe("no_location");
        expect(res.body.session.status).toBe("open");

        // Audit log should be present.
        const auditRow = await pool.query<{ action: string }>(
          `SELECT action FROM attendance_audit_logs
            WHERE workspace_owner_id = $1
            LIMIT 1`,
          [OWNER_ID],
        );
        expect(auditRow.rows).toHaveLength(1);
        expect(auditRow.rows[0].action).toBe("clock_in");
      },
    );

    // ── 4. Duplicate open-session guard ──────────────────────────────────────

    it(
      "clock-in when an open session already exists — returns 409 and leaves " +
      "only the original session in the database",
      async () => {
        const wmId = await seedWorkspaceMember(pool);
        const tmId = await seedTeamMember(pool, wmId);
        await seedProfile(pool, tmId);

        // Plant an existing open session.
        await seedOpenSession(pool, tmId);

        const res = await request(app)
          .post("/attendance/clock-in")
          .send({});

        expect(res.status).toBe(409);
        expect(res.body.error).toMatch(/open session already exists/i);

        // Confirm only one session row exists (the original seeded one).
        const countResult = await pool.query<{ cnt: string }>(
          `SELECT COUNT(*) AS cnt FROM attendance_sessions
            WHERE workspace_owner_id = $1`,
          [OWNER_ID],
        );
        expect(Number(countResult.rows[0].cnt)).toBe(1);
      },
    );

    // ── 5. No team member record → 403 ───────────────────────────────────────

    it(
      "clock-in when user has no team_members row — returns 403",
      async () => {
        // Switch to the user who has no team_members record.
        activeUserId = USER_ID_NO_MEMBER;

        // Seed a workspace_members row for this user (they are a workspace
        // member but not in team_members).
        await seedWorkspaceMember(pool, USER_ID_NO_MEMBER);

        const res = await request(app)
          .post("/attendance/clock-in")
          .send({});

        expect(res.status).toBe(403);
        expect(res.body.error).toMatch(/No team member record/i);

        // No session should have been created.
        const countResult = await pool.query<{ cnt: string }>(
          `SELECT COUNT(*) AS cnt FROM attendance_sessions
            WHERE workspace_owner_id = $1`,
          [OWNER_ID],
        );
        expect(Number(countResult.rows[0].cnt)).toBe(0);
      },
    );
  },
);
