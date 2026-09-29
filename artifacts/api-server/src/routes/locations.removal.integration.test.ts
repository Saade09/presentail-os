/**
 * Integration test: verifies that removing a brand or a member from a location
 * writes brand_removed / member_removed events to location_activity_log and
 * that those events subsequently appear in GET /locations/:id/activity with
 * the correct actor_email.
 *
 * Auth and workspace middleware are stubbed (same pattern used by
 * locations.activity.integration.test.ts).  The PostgreSQL database is real
 * (provided by test-integration-local.sh).
 *
 * The suite is skipped automatically when DATABASE_URL is not set.
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

const OWNER_ID = "__test_location_removal__";
const ACTOR_EMAIL = "removal-actor@example.com";

// Mutable so each suite can point the middleware at its own owner row.
let activeMockOwnerId = OWNER_ID;

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
    wreq.workspaceOwnerId = activeMockOwnerId;
    wreq.workspaceRole = "owner";
    wreq.workspaceActualRole = "owner";
    wreq.userId = "__test_removal_user__";
    wreq.userEmail = ACTOR_EMAIL;
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
  "brand_removed and member_removed events appear in activity feed (integration)",
  () => {
    let pool: InstanceType<typeof Pool>;
    let app: express.Express;

    let locationId: number;
    let brandId: number;
    let memberId: number;

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL });
      app = makeApp();

      // ── Cleanup leftovers from previous failed runs ──────────────────────
      await pool.query(`DELETE FROM location_activity_log WHERE workspace_owner_id = $1`, [
        OWNER_ID,
      ]);
      await pool.query(`DELETE FROM member_locations ml
        USING workspace_members wm
        WHERE ml.member_id = wm.id AND wm.workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(
        `DELETE FROM location_brands WHERE workspace_owner_id = $1`,
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
      await pool.query(`DELETE FROM brands WHERE workspace_owner_id = $1`, [OWNER_ID]);

      // ── Seed: location ───────────────────────────────────────────────────
      const locResult = await pool.query<{ id: number }>(
        `INSERT INTO locations (workspace_owner_id, name, country)
         VALUES ($1, 'Removal Test Location', 'Lebanon')
         RETURNING id`,
        [OWNER_ID],
      );
      locationId = locResult.rows[0].id;

      // ── Seed: brand + link to location ───────────────────────────────────
      const brandResult = await pool.query<{ id: number }>(
        `INSERT INTO brands (workspace_owner_id, name) VALUES ($1, 'Removable Brand') RETURNING id`,
        [OWNER_ID],
      );
      brandId = brandResult.rows[0].id;

      await pool.query(
        `INSERT INTO location_brands (workspace_owner_id, location_id, brand_id)
         VALUES ($1, $2, $3)`,
        [OWNER_ID, locationId, brandId],
      );

      // ── Seed: workspace member + link to location ─────────────────────────
      const memberResult = await pool.query<{ id: number }>(
        `INSERT INTO workspace_members (workspace_owner_id, member_email, role)
         VALUES ($1, 'removable-member@test.com', 'member')
         RETURNING id`,
        [OWNER_ID],
      );
      memberId = memberResult.rows[0].id;

      await pool.query(
        `INSERT INTO member_locations (member_id, location_id)
         VALUES ($1, $2)`,
        [memberId, locationId],
      );
    });

    afterAll(async () => {
      if (!pool) return;
      // Delete in FK-safe order; most cascades handle child rows automatically.
      await pool.query(`DELETE FROM location_activity_log WHERE workspace_owner_id = $1`, [
        OWNER_ID,
      ]);
      await pool.query(`DELETE FROM member_locations ml
        USING workspace_members wm
        WHERE ml.member_id = wm.id AND wm.workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(
        `DELETE FROM location_brands WHERE workspace_owner_id = $1`,
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
      await pool.query(`DELETE FROM brands WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.end();
    });

    // ─────────────────────────────────────────────────────────────────────────
    // brand_removed
    // ─────────────────────────────────────────────────────────────────────────

    it("DELETE /locations/:id/brands/:brandId returns 200", async () => {
      const res = await request(app).delete(
        `/locations/${locationId}/brands/${brandId}`,
      );
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true });
    });

    it("brand_removed event appears in activity feed with correct brand name and actor email", async () => {
      const res = await request(app).get(`/locations/${locationId}/activity`);
      expect(res.status).toBe(200);

      const events = res.body.events as Array<{
        event_type: string;
        subject_name: string;
        actor_name: string;
      }>;

      const brandRemovedEvents = events.filter((e) => e.event_type === "brand_removed");
      expect(brandRemovedEvents.length).toBeGreaterThan(0);

      const evt = brandRemovedEvents[0];
      expect(evt.subject_name).toBe("Removable Brand");
      expect(evt.actor_name).toBe(ACTOR_EMAIL);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // member_removed
    // ─────────────────────────────────────────────────────────────────────────

    it("DELETE /locations/:id/members/:memberId returns 200", async () => {
      const res = await request(app).delete(
        `/locations/${locationId}/members/${memberId}`,
      );
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true });
    });

    it("member_removed event appears in activity feed with correct member email and actor email", async () => {
      const res = await request(app).get(`/locations/${locationId}/activity`);
      expect(res.status).toBe(200);

      const events = res.body.events as Array<{
        event_type: string;
        subject_name: string;
        actor_name: string;
      }>;

      const memberRemovedEvents = events.filter((e) => e.event_type === "member_removed");
      expect(memberRemovedEvents.length).toBeGreaterThan(0);

      const evt = memberRemovedEvents[0];
      expect(evt.subject_name).toBe("removable-member@test.com");
      expect(evt.actor_name).toBe(ACTOR_EMAIL);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Both events are present together after both removals
    // ─────────────────────────────────────────────────────────────────────────

    it("activity feed contains both brand_removed and member_removed after both removals", async () => {
      const res = await request(app).get(`/locations/${locationId}/activity`);
      expect(res.status).toBe(200);

      const eventTypes = (res.body.events as Array<{ event_type: string }>).map(
        (e) => e.event_type,
      );
      expect(eventTypes).toContain("brand_removed");
      expect(eventTypes).toContain("member_removed");
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Edge-case suite: DELETE for never-linked brand / member must NOT log anything
// ─────────────────────────────────────────────────────────────────────────────

const OWNER_ID_UNLINKED = "__test_location_removal_unlinked__";

describe.skipIf(!DATABASE_URL)(
  "no activity-log entry when brand or member was never linked (integration)",
  () => {
    let pool: InstanceType<typeof Pool>;
    let app: express.Express;

    let locationId: number;
    let unlinkedBrandId: number;
    let unlinkedMemberId: number;

    beforeAll(async () => {
      activeMockOwnerId = OWNER_ID_UNLINKED;
      pool = new Pool({ connectionString: DATABASE_URL });
      app = makeApp();

      // ── Cleanup leftovers from previous failed runs ──────────────────────
      await pool.query(
        `DELETE FROM location_activity_log WHERE workspace_owner_id = $1`,
        [OWNER_ID_UNLINKED],
      );
      await pool.query(
        `DELETE FROM locations WHERE workspace_owner_id = $1`,
        [OWNER_ID_UNLINKED],
      );
      await pool.query(
        `DELETE FROM workspace_members WHERE workspace_owner_id = $1`,
        [OWNER_ID_UNLINKED],
      );
      await pool.query(`DELETE FROM brands WHERE workspace_owner_id = $1`, [
        OWNER_ID_UNLINKED,
      ]);

      // ── Seed: location (nothing linked to it) ────────────────────────────
      const locResult = await pool.query<{ id: number }>(
        `INSERT INTO locations (workspace_owner_id, name, country)
         VALUES ($1, 'Unlinked Test Location', 'Lebanon')
         RETURNING id`,
        [OWNER_ID_UNLINKED],
      );
      locationId = locResult.rows[0].id;

      // ── Seed: brand that is NOT linked to the location ───────────────────
      const brandResult = await pool.query<{ id: number }>(
        `INSERT INTO brands (workspace_owner_id, name)
         VALUES ($1, 'Never Linked Brand')
         RETURNING id`,
        [OWNER_ID_UNLINKED],
      );
      unlinkedBrandId = brandResult.rows[0].id;

      // ── Seed: workspace member NOT linked to the location ─────────────────
      const memberResult = await pool.query<{ id: number }>(
        `INSERT INTO workspace_members (workspace_owner_id, member_email, role)
         VALUES ($1, 'never-linked-member@test.com', 'member')
         RETURNING id`,
        [OWNER_ID_UNLINKED],
      );
      unlinkedMemberId = memberResult.rows[0].id;
    });

    afterAll(async () => {
      activeMockOwnerId = OWNER_ID;
      if (!pool) return;
      await pool.query(
        `DELETE FROM location_activity_log WHERE workspace_owner_id = $1`,
        [OWNER_ID_UNLINKED],
      );
      await pool.query(
        `DELETE FROM locations WHERE workspace_owner_id = $1`,
        [OWNER_ID_UNLINKED],
      );
      await pool.query(
        `DELETE FROM workspace_members WHERE workspace_owner_id = $1`,
        [OWNER_ID_UNLINKED],
      );
      await pool.query(`DELETE FROM brands WHERE workspace_owner_id = $1`, [
        OWNER_ID_UNLINKED,
      ]);
      await pool.end();
    });

    it("DELETE /locations/:id/brands/:brandId for a never-linked brand still returns 200", async () => {
      const res = await request(app).delete(
        `/locations/${locationId}/brands/${unlinkedBrandId}`,
      );
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true });
    });

    it("no brand_removed event is logged when the brand was not linked", async () => {
      const { rows } = await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM location_activity_log
          WHERE workspace_owner_id = $1
            AND location_id = $2
            AND event_type = 'brand_removed'
            AND subject_id = $3`,
        [OWNER_ID_UNLINKED, locationId, String(unlinkedBrandId)],
      );
      expect(Number(rows[0].count)).toBe(0);
    });

    it("DELETE /locations/:id/members/:memberId for a never-linked member still returns 200", async () => {
      const res = await request(app).delete(
        `/locations/${locationId}/members/${unlinkedMemberId}`,
      );
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true });
    });

    it("no member_removed event is logged when the member was not linked", async () => {
      const { rows } = await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM location_activity_log
          WHERE workspace_owner_id = $1
            AND location_id = $2
            AND event_type = 'member_removed'
            AND subject_id = $3`,
        [OWNER_ID_UNLINKED, locationId, String(unlinkedMemberId)],
      );
      expect(Number(rows[0].count)).toBe(0);
    });
  },
);
