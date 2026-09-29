/**
 * Integration test: location update routes against a real PostgreSQL database.
 *
 * Background: the four `UPDATE locations ... RETURNING ${LOCATION_DETAIL_FIELDS}`
 * statements reuse a field list whose columns are prefixed with the `l.` alias
 * (defined for the detail SELECT). Without aliasing the UPDATE target as `l`,
 * Postgres rejects the whole statement with `missing FROM-clause entry for
 * table "l"` — a class of error that mock-based unit tests can never catch.
 * That bug made every location save (and florist assignment) fail in
 * production with a 500.
 *
 * This suite runs the full-update PATCH (including florist_member_ids
 * assignment and deselection), the partial PATCH (geofence/attendance), and
 * pause/resume against a real database, asserting both the returned payload
 * and the persisted rows.
 *
 * Auth / workspace / logger middleware are stubbed (same pattern as
 * cashSessions.bills.integration.test.ts); the database is real. The suite
 * skips automatically when DATABASE_URL is not set.
 *
 * Run via:
 *   bash artifacts/api-server/test-integration-local.sh src/routes/locations.update.integration.test.ts
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import pg from "pg";
import type { WorkspaceRequest } from "../lib/workspace";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;

const OWNER_ID = "__test_loc_update__";
const USER_ID = "__test_loc_update_user__";

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
    wreq.workspaceRole = "owner";
    wreq.workspaceActualRole = "owner";
    wreq.userId = USER_ID;
    wreq.userEmail = "loc-update@example.com";
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

import locationsRouter from "./locations";

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: express.Request & { log?: unknown }, _res, next) => {
    req.log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn().mockReturnThis(),
    } as unknown as express.Request["log"];
    next();
  });
  app.use(locationsRouter);
  return app;
}

describe.skipIf(!DATABASE_URL)("Location update routes (integration)", () => {
  let pool: InstanceType<typeof Pool>;
  let app: express.Express;
  let locationId: number;
  let otherLocationId: number;
  let floristRoleId: number;
  let floristMemberA: number;
  let floristMemberB: number;

  async function cleanup(): Promise<void> {
    await pool.query(`DELETE FROM workspace_members WHERE workspace_owner_id = $1`, [OWNER_ID]);
    await pool.query(`DELETE FROM workspace_roles WHERE workspace_owner_id = $1`, [OWNER_ID]);
    await pool.query(`DELETE FROM locations WHERE workspace_owner_id = $1`, [OWNER_ID]);
  }

  async function insertLocation(name: string): Promise<number> {
    const r = await pool.query<{ id: number }>(
      `INSERT INTO locations (workspace_owner_id, name, country, status)
       VALUES ($1, $2, 'Lebanon', 'setup_incomplete')
       RETURNING id`,
      [OWNER_ID, name],
    );
    return r.rows[0].id;
  }

  async function insertFloristMember(email: string): Promise<number> {
    const r = await pool.query<{ id: number }>(
      `INSERT INTO workspace_members
         (workspace_owner_id, member_user_id, member_email, role, custom_role_id, joined_at)
       VALUES ($1, $2, $3, 'member', $4, now())
       RETURNING id`,
      [OWNER_ID, `user_${email}`, email, floristRoleId],
    );
    return r.rows[0].id;
  }

  async function getFloristLocation(memberId: number): Promise<number | null> {
    const r = await pool.query<{ florist_location_id: number | null }>(
      `SELECT florist_location_id FROM workspace_members WHERE id = $1`,
      [memberId],
    );
    return r.rows[0]?.florist_location_id ?? null;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await cleanup();

    const role = await pool.query<{ id: number }>(
      `INSERT INTO workspace_roles (workspace_owner_id, name, allowed_pages)
       VALUES ($1, 'Florist', '["florist_orders"]'::jsonb)
       RETURNING id`,
      [OWNER_ID],
    );
    floristRoleId = role.rows[0].id;

    app = makeApp();
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM workspace_members WHERE workspace_owner_id = $1`, [OWNER_ID]);
    await pool.query(`DELETE FROM locations WHERE workspace_owner_id = $1`, [OWNER_ID]);
    locationId = await insertLocation("Main Studio");
    otherLocationId = await insertLocation("Second Studio");
    floristMemberA = await insertFloristMember("florist-a@example.com");
    floristMemberB = await insertFloristMember("florist-b@example.com");
  });

  // ── Full-update PATCH ─────────────────────────────────────────────────────

  it("saves a full update (name, rent, address) and returns the updated row", async () => {
    const res = await request(app).patch(`/locations/${locationId}`).send({
      name: "Renamed Studio",
      country: "Lebanon",
      location_type: "Point of Sale",
      annual_rent: 12000,
      rent_currency: "USD",
      payments_per_year: 4,
      address: "123 Bliss Street, Beirut",
    });

    expect(res.status).toBe(200);
    expect(res.body.location.name).toBe("Renamed Studio");
    expect(res.body.location.address).toBe("123 Bliss Street, Beirut");
    expect(Number(res.body.location.annual_rent)).toBe(12000);
    expect(res.body.location.rent_currency).toBe("USD");
    expect(res.body.location.payments_per_year).toBe(4);

    const row = await pool.query(
      `SELECT name, address, annual_rent, rent_currency, payments_per_year
         FROM locations WHERE id = $1`,
      [locationId],
    );
    expect(row.rows[0].name).toBe("Renamed Studio");
    expect(row.rows[0].address).toBe("123 Bliss Street, Beirut");
    expect(Number(row.rows[0].annual_rent)).toBe(12000);
  });

  it("assigns florists via florist_member_ids and persists florist_location_id", async () => {
    const res = await request(app).patch(`/locations/${locationId}`).send({
      name: "Main Studio",
      country: "Lebanon",
      florist_member_ids: [floristMemberA, floristMemberB],
    });

    expect(res.status).toBe(200);
    expect(await getFloristLocation(floristMemberA)).toBe(locationId);
    expect(await getFloristLocation(floristMemberB)).toBe(locationId);
  });

  it("deselecting a florist clears their florist_location_id, keeping the rest", async () => {
    await pool.query(
      `UPDATE workspace_members SET florist_location_id = $1 WHERE id = ANY($2::int[])`,
      [locationId, [floristMemberA, floristMemberB]],
    );

    const res = await request(app).patch(`/locations/${locationId}`).send({
      name: "Main Studio",
      country: "Lebanon",
      florist_member_ids: [floristMemberA],
    });

    expect(res.status).toBe(200);
    expect(await getFloristLocation(floristMemberA)).toBe(locationId);
    expect(await getFloristLocation(floristMemberB)).toBeNull();
  });

  it("assigning a florist to this location moves them off another location", async () => {
    await pool.query(
      `UPDATE workspace_members SET florist_location_id = $1 WHERE id = $2`,
      [otherLocationId, floristMemberA],
    );

    const res = await request(app).patch(`/locations/${locationId}`).send({
      name: "Main Studio",
      country: "Lebanon",
      florist_member_ids: [floristMemberA],
    });

    expect(res.status).toBe(200);
    expect(await getFloristLocation(floristMemberA)).toBe(locationId);
  });

  it("omitting florist_member_ids leaves assignments untouched", async () => {
    await pool.query(
      `UPDATE workspace_members SET florist_location_id = $1 WHERE id = $2`,
      [locationId, floristMemberA],
    );

    const res = await request(app).patch(`/locations/${locationId}`).send({
      name: "Main Studio",
      country: "Lebanon",
    });

    expect(res.status).toBe(200);
    expect(await getFloristLocation(floristMemberA)).toBe(locationId);
  });

  it("rejects florist_member_ids referencing a member without the florist role", async () => {
    const nonFlorist = await pool.query<{ id: number }>(
      `INSERT INTO workspace_members
         (workspace_owner_id, member_user_id, member_email, role, joined_at)
       VALUES ($1, 'user_plain', 'plain@example.com', 'member', now())
       RETURNING id`,
      [OWNER_ID],
    );

    const res = await request(app).patch(`/locations/${locationId}`).send({
      name: "Main Studio",
      country: "Lebanon",
      florist_member_ids: [nonFlorist.rows[0].id],
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/florist/i);
  });

  it("returns 404 for a location in another workspace", async () => {
    const foreign = await pool.query<{ id: number }>(
      `INSERT INTO locations (workspace_owner_id, name, country)
       VALUES ('__other_owner__', 'Foreign', 'Lebanon') RETURNING id`,
    );
    const res = await request(app).patch(`/locations/${foreign.rows[0].id}`).send({
      name: "Hijack",
      country: "Lebanon",
    });
    expect(res.status).toBe(404);
    await pool.query(`DELETE FROM locations WHERE workspace_owner_id = '__other_owner__'`);
  });

  // ── Partial PATCH (geofence/attendance) ──────────────────────────────────

  it("saves a partial update of geofence radius and attendance flag", async () => {
    const res = await request(app).patch(`/locations/${locationId}`).send({
      geofence_radius_meters: 250,
      attendance_enabled: false,
    });

    expect(res.status).toBe(200);
    expect(res.body.location.geofence_radius_meters).toBe(250);
    expect(res.body.location.attendance_enabled).toBe(false);

    const row = await pool.query(
      `SELECT geofence_radius_meters, attendance_enabled FROM locations WHERE id = $1`,
      [locationId],
    );
    expect(row.rows[0].geofence_radius_meters).toBe(250);
    expect(row.rows[0].attendance_enabled).toBe(false);
  });

  // ── Pause / Resume ────────────────────────────────────────────────────────

  it("pauses a location, recording who and why", async () => {
    const res = await request(app)
      .post(`/locations/${locationId}/pause`)
      .send({ reason: "Renovations" });

    expect(res.status).toBe(200);
    expect(res.body.location.status).toBe("paused");
    expect(res.body.location.pause_reason).toBe("Renovations");
    expect(res.body.location.paused_by).toBe(USER_ID);
    expect(res.body.location.paused_at).toBeTruthy();

    const row = await pool.query(
      `SELECT status, pause_reason, paused_by FROM locations WHERE id = $1`,
      [locationId],
    );
    expect(row.rows[0].status).toBe("paused");
    expect(row.rows[0].pause_reason).toBe("Renovations");
    expect(row.rows[0].paused_by).toBe(USER_ID);
  });

  it("resumes a paused location, clearing pause metadata", async () => {
    await pool.query(
      `UPDATE locations SET status = 'paused', paused_at = now(), paused_by = $2, pause_reason = 'x'
       WHERE id = $1`,
      [locationId, USER_ID],
    );

    const res = await request(app).post(`/locations/${locationId}/resume`).send({});

    expect(res.status).toBe(200);
    expect(res.body.location.status).toBe("active");
    expect(res.body.location.paused_at).toBeNull();
    expect(res.body.location.paused_by).toBeNull();
    expect(res.body.location.pause_reason).toBeNull();

    const row = await pool.query(`SELECT status FROM locations WHERE id = $1`, [locationId]);
    expect(row.rows[0].status).toBe("active");
  });
});
