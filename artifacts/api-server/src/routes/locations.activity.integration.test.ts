/**
 * Integration test: verifies that GET /locations/:id/activity returns the
 * correct events from each of the four source tables, enforces the per-type
 * time-window filters, excludes soft-deleted / non-done print_jobs, and
 * delivers results in descending occurred_at order.
 *
 * Auth and workspace middleware are stubbed (same pattern as
 * products.recipe.integration.test.ts) so the test does not need real Clerk
 * credentials.  The PostgreSQL database is real (provided by
 * test-integration-local.sh).
 *
 * The test is skipped automatically when DATABASE_URL is not set, making it
 * safe to run in CI environments without a live database.
 *
 * Run via:
 *   pnpm --filter @workspace/api-server run test:integration:local
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import pg from "pg";
import type { WorkspaceRequest } from "../lib/workspace";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;

// ─────────────────────────────────────────────────────────────────────────────
// Mocks — auth / workspace / logger only.
// db is NOT mocked; the real pool is used throughout.
// ─────────────────────────────────────────────────────────────────────────────

const OWNER_ID = "__test_location_activity_feed__";

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
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
    wreq.userId = "__test_activity_user__";
    wreq.userEmail = "activity-test@example.com";
    wreq.assignedLocationIds = null;
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

// ─────────────────────────────────────────────────────────────────────────────
// Imports — MUST come after vi.mock declarations (hoisting boundary)
// ─────────────────────────────────────────────────────────────────────────────

import locationsRouter from "./locations";

// ─────────────────────────────────────────────────────────────────────────────
// Test app factory
// ─────────────────────────────────────────────────────────────────────────────

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  const mockLog = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
  app.use((req, _res, next) => {
    (req as unknown as { log: typeof mockLog }).log = mockLog;
    next();
  });
  app.use(locationsRouter);
  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!DATABASE_URL)(
  "GET /locations/:id/activity — behaviour (integration)",
  () => {
    let pool: InstanceType<typeof Pool>;
    let app: express.Express;

    // Seeded IDs — filled in beforeAll.
    let locationId: number;
    let deviceInWindowId: number;
    let deviceOutWindowId: number;

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL });
      app = makeApp();

      // ── Cleanup leftovers from previous failed runs ──────────────────────
      await pool.query(`DELETE FROM print_jobs   WHERE user_id = $1`, [OWNER_ID]);
      await pool.query(
        `DELETE FROM devices WHERE user_id = $1`,
        [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM locations WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM workspace_members WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM brands WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );

      // ── Seed: location ───────────────────────────────────────────────────
      const locResult = await pool.query<{ id: number }>(
        `INSERT INTO locations (workspace_owner_id, name, country)
         VALUES ($1, 'Activity Test Location', 'Lebanon')
         RETURNING id`,
        [OWNER_ID],
      );
      locationId = locResult.rows[0].id;

      // ── Seed: devices (for device_heartbeat events) ──────────────────────
      // In-window: last_seen_at 3 days ago (< 7 days)
      const devInResult = await pool.query<{ id: number }>(
        `INSERT INTO devices (user_id, name, machine_id, location_id, last_seen_at)
         VALUES ($1, 'In-Window Device', 'mach-in-001', $2, now() - INTERVAL '3 days')
         RETURNING id`,
        [OWNER_ID, locationId],
      );
      deviceInWindowId = devInResult.rows[0].id;

      // Out-of-window: last_seen_at 10 days ago (> 7 days → excluded)
      const devOutResult = await pool.query<{ id: number }>(
        `INSERT INTO devices (user_id, name, machine_id, location_id, last_seen_at)
         VALUES ($1, 'Out-Window Device', 'mach-out-001', $2, now() - INTERVAL '10 days')
         RETURNING id`,
        [OWNER_ID, locationId],
      );
      deviceOutWindowId = devOutResult.rows[0].id;

      // ── Seed: brands + location_brands (for brand_linked events) ─────────
      const brandInResult = await pool.query<{ id: number }>(
        `INSERT INTO brands (workspace_owner_id, name) VALUES ($1, 'In-Window Brand') RETURNING id`,
        [OWNER_ID],
      );
      const brandInId = brandInResult.rows[0].id;

      const brandOutResult = await pool.query<{ id: number }>(
        `INSERT INTO brands (workspace_owner_id, name) VALUES ($1, 'Out-Window Brand') RETURNING id`,
        [OWNER_ID],
      );
      const brandOutId = brandOutResult.rows[0].id;

      // In-window: linked 15 days ago (< 30 days)
      await pool.query(
        `INSERT INTO location_brands (workspace_owner_id, location_id, brand_id, created_at)
         VALUES ($1, $2, $3, now() - INTERVAL '15 days')`,
        [OWNER_ID, locationId, brandInId],
      );
      // Out-of-window: linked 35 days ago (> 30 days → excluded)
      await pool.query(
        `INSERT INTO location_brands (workspace_owner_id, location_id, brand_id, created_at)
         VALUES ($1, $2, $3, now() - INTERVAL '35 days')`,
        [OWNER_ID, locationId, brandOutId],
      );

      // ── Seed: workspace_members + member_locations (for member_added events)
      const memberInResult = await pool.query<{ id: number }>(
        `INSERT INTO workspace_members (workspace_owner_id, member_email, role)
         VALUES ($1, 'in-window-member@test.com', 'member')
         RETURNING id`,
        [OWNER_ID],
      );
      const memberInId = memberInResult.rows[0].id;

      const memberOutResult = await pool.query<{ id: number }>(
        `INSERT INTO workspace_members (workspace_owner_id, member_email, role)
         VALUES ($1, 'out-window-member@test.com', 'member')
         RETURNING id`,
        [OWNER_ID],
      );
      const memberOutId = memberOutResult.rows[0].id;

      // In-window: assigned 20 days ago (< 30 days)
      await pool.query(
        `INSERT INTO member_locations (member_id, location_id, created_at)
         VALUES ($1, $2, now() - INTERVAL '20 days')`,
        [memberInId, locationId],
      );
      // Out-of-window: assigned 40 days ago (> 30 days → excluded)
      await pool.query(
        `INSERT INTO member_locations (member_id, location_id, created_at)
         VALUES ($1, $2, now() - INTERVAL '40 days')`,
        [memberOutId, locationId],
      );

      // ── Seed: print_jobs (for job_completed events) ──────────────────────
      // In-window, status=done, not deleted: 6 hours ago (< 24 hours)
      await pool.query(
        `INSERT INTO print_jobs (user_id, device_id, file_name, status, created_at)
         VALUES ($1, $2, 'in-window-job.pdf', 'done', now() - INTERVAL '6 hours')`,
        [OWNER_ID, deviceInWindowId],
      );
      // Out-of-window, status=done: 30 hours ago (> 24 hours → excluded)
      await pool.query(
        `INSERT INTO print_jobs (user_id, device_id, file_name, status, created_at)
         VALUES ($1, $2, 'out-window-job.pdf', 'done', now() - INTERVAL '30 hours')`,
        [OWNER_ID, deviceInWindowId],
      );
      // In-window but status=failed (not 'done' → excluded)
      await pool.query(
        `INSERT INTO print_jobs (user_id, device_id, file_name, status, created_at)
         VALUES ($1, $2, 'failed-job.pdf', 'failed', now() - INTERVAL '1 hour')`,
        [OWNER_ID, deviceInWindowId],
      );
      // In-window, status=done, but soft-deleted (→ excluded)
      await pool.query(
        `INSERT INTO print_jobs (user_id, device_id, file_name, status, created_at, deleted_at)
         VALUES ($1, $2, 'deleted-job.pdf', 'done', now() - INTERVAL '2 hours', now())`,
        [OWNER_ID, deviceInWindowId],
      );
    });

    afterAll(async () => {
      if (!pool) return;
      // Delete in FK-safe order.
      await pool.query(`DELETE FROM print_jobs WHERE user_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM devices    WHERE user_id = $1`, [OWNER_ID]);
      // Locations ON DELETE CASCADE cleans up location_brands and member_locations.
      await pool.query(`DELETE FROM locations  WHERE workspace_owner_id = $1`, [OWNER_ID]);
      // workspace_members ON DELETE CASCADE cleans up member_locations.
      await pool.query(`DELETE FROM workspace_members WHERE workspace_owner_id = $1`, [OWNER_ID]);
      // brands ON DELETE CASCADE cleans up location_brands.
      await pool.query(`DELETE FROM brands     WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.end();
    });

    // ─────────────────────────────────────────────────────────────────────────
    // All four event types are returned for in-window records
    // ─────────────────────────────────────────────────────────────────────────

    it("returns device_heartbeat events only for devices whose last_seen_at is within 7 days", async () => {
      const res = await request(app).get(`/locations/${locationId}/activity`);
      expect(res.status).toBe(200);

      const heartbeats = (res.body.events as Array<{ event_type: string; subject_name: string }>)
        .filter((e) => e.event_type === "device_heartbeat");

      const names = heartbeats.map((e) => e.subject_name);
      expect(names).toContain("In-Window Device");
      expect(names).not.toContain("Out-Window Device");
    });

    it("returns brand_linked events only for location_brands rows created within 30 days", async () => {
      const res = await request(app).get(`/locations/${locationId}/activity`);
      expect(res.status).toBe(200);

      const branded = (res.body.events as Array<{ event_type: string; subject_name: string }>)
        .filter((e) => e.event_type === "brand_linked");

      const names = branded.map((e) => e.subject_name);
      expect(names).toContain("In-Window Brand");
      expect(names).not.toContain("Out-Window Brand");
    });

    it("returns member_added events only for member_locations rows created within 30 days", async () => {
      const res = await request(app).get(`/locations/${locationId}/activity`);
      expect(res.status).toBe(200);

      const members = (res.body.events as Array<{ event_type: string; subject_name: string }>)
        .filter((e) => e.event_type === "member_added");

      const names = members.map((e) => e.subject_name);
      expect(names).toContain("in-window-member@test.com");
      expect(names).not.toContain("out-window-member@test.com");
    });

    it("returns job_completed events only for done, non-deleted print_jobs created within 24 hours", async () => {
      const res = await request(app).get(`/locations/${locationId}/activity`);
      expect(res.status).toBe(200);

      const jobs = (res.body.events as Array<{ event_type: string; subject_name: string }>)
        .filter((e) => e.event_type === "job_completed");

      const names = jobs.map((e) => e.subject_name);
      expect(names).toContain("in-window-job.pdf");
      expect(names).not.toContain("out-window-job.pdf");
      expect(names).not.toContain("failed-job.pdf");
      expect(names).not.toContain("deleted-job.pdf");
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Ordering
    // ─────────────────────────────────────────────────────────────────────────

    it("returns all in-window events sorted in descending occurred_at order", async () => {
      const res = await request(app).get(`/locations/${locationId}/activity`);
      expect(res.status).toBe(200);

      const events = res.body.events as Array<{ occurred_at: string }>;
      expect(events.length).toBeGreaterThan(0);

      for (let i = 0; i < events.length - 1; i++) {
        const t1 = new Date(events[i].occurred_at).getTime();
        const t2 = new Date(events[i + 1].occurred_at).getTime();
        expect(t1).toBeGreaterThanOrEqual(t2);
      }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Devices from OTHER locations / workspaces are not included
    // ─────────────────────────────────────────────────────────────────────────

    it("does not include device_heartbeat events from devices at a different location", async () => {
      // Create a second location and a device there — should never appear in
      // the first location's activity feed.
      const loc2Result = await pool.query<{ id: number }>(
        `INSERT INTO locations (workspace_owner_id, name, country)
         VALUES ($1, 'Other Location', 'Lebanon')
         RETURNING id`,
        [OWNER_ID],
      );
      const loc2Id = loc2Result.rows[0].id;

      await pool.query(
        `INSERT INTO devices (user_id, name, machine_id, location_id, last_seen_at)
         VALUES ($1, 'Other Location Device', 'mach-other-001', $2, now() - INTERVAL '1 hour')`,
        [OWNER_ID, loc2Id],
      );

      const res = await request(app).get(`/locations/${locationId}/activity`);
      expect(res.status).toBe(200);

      const names = (res.body.events as Array<{ event_type: string; subject_name: string }>)
        .filter((e) => e.event_type === "device_heartbeat")
        .map((e) => e.subject_name);

      expect(names).not.toContain("Other Location Device");

      // Cleanup: deleting loc2 cascades to its location_brands / member_locations;
      // devices at loc2 must be deleted first since there is no FK cascade on devices.
      await pool.query(`DELETE FROM devices WHERE machine_id = 'mach-other-001'`);
      await pool.query(`DELETE FROM locations WHERE id = $1`, [loc2Id]);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 404 when location does not belong to this workspace
    // ─────────────────────────────────────────────────────────────────────────

    it("returns 404 for a location id that does not belong to the workspace", async () => {
      const res = await request(app).get("/locations/999999999/activity");
      expect(res.status).toBe(404);
    });
  },
);
