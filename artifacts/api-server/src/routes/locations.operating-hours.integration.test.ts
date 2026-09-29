/**
 * Integration test: verifies that the `has_operating_hours` computed column in
 * GET /api/locations is evaluated correctly against a real PostgreSQL database
 * for the four boundary cases (NULL, empty object, all-closed days, one active
 * day).
 *
 * Auth and workspace middleware are stubbed (same pattern used by
 * locations.removal.integration.test.ts).  The PostgreSQL database is real
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

const OWNER_ID = "__test_operating_hours__";

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
    wreq.userId = "__test_op_hours_user__";
    wreq.userEmail = "op-hours-test@example.com";
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
  "GET /locations — has_operating_hours boundary cases (integration)",
  () => {
    let pool: InstanceType<typeof Pool>;
    let app: express.Express;

    let nullHoursId: number;
    let emptyHoursId: number;
    let allClosedId: number;
    let oneOpenId: number;

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL });
      app = makeApp();

      // ── Cleanup leftovers from previous failed runs ──────────────────────
      await pool.query(
        `DELETE FROM locations WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );

      // ── Seed: location with operating_hours = NULL ────────────────────────
      const r1 = await pool.query<{ id: number }>(
        `INSERT INTO locations (workspace_owner_id, name, country, operating_hours)
         VALUES ($1, 'OH-Null', 'Lebanon', NULL)
         RETURNING id`,
        [OWNER_ID],
      );
      nullHoursId = r1.rows[0].id;

      // ── Seed: location with operating_hours = '{}' ────────────────────────
      const r2 = await pool.query<{ id: number }>(
        `INSERT INTO locations (workspace_owner_id, name, country, operating_hours)
         VALUES ($1, 'OH-Empty', 'Lebanon', '{}'::jsonb)
         RETURNING id`,
        [OWNER_ID],
      );
      emptyHoursId = r2.rows[0].id;

      // ── Seed: location where every day has closed: true ──────────────────
      const allClosed = {
        monday: { closed: true, open: "", close: "" },
        tuesday: { closed: true, open: "", close: "" },
        wednesday: { closed: true, open: "", close: "" },
        thursday: { closed: true, open: "", close: "" },
        friday: { closed: true, open: "", close: "" },
        saturday: { closed: true, open: "", close: "" },
        sunday: { closed: true, open: "", close: "" },
      };
      const r3 = await pool.query<{ id: number }>(
        `INSERT INTO locations (workspace_owner_id, name, country, operating_hours)
         VALUES ($1, 'OH-AllClosed', 'Lebanon', $2::jsonb)
         RETURNING id`,
        [OWNER_ID, JSON.stringify(allClosed)],
      );
      allClosedId = r3.rows[0].id;

      // ── Seed: location where one day is open with valid times ─────────────
      const oneOpen = {
        monday: { closed: false, open: "09:00", close: "18:00" },
        tuesday: { closed: true, open: "", close: "" },
        wednesday: { closed: true, open: "", close: "" },
        thursday: { closed: true, open: "", close: "" },
        friday: { closed: true, open: "", close: "" },
        saturday: { closed: true, open: "", close: "" },
        sunday: { closed: true, open: "", close: "" },
      };
      const r4 = await pool.query<{ id: number }>(
        `INSERT INTO locations (workspace_owner_id, name, country, operating_hours)
         VALUES ($1, 'OH-OneOpen', 'Lebanon', $2::jsonb)
         RETURNING id`,
        [OWNER_ID, JSON.stringify(oneOpen)],
      );
      oneOpenId = r4.rows[0].id;
    });

    afterAll(async () => {
      if (!pool) return;
      await pool.query(
        `DELETE FROM locations WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      await pool.end();
    });

    // ── Helper: fetch a specific location from the list response ─────────────

    async function fetchLocation(
      app: express.Express,
      id: number,
    ): Promise<{ has_operating_hours: boolean } | undefined> {
      const res = await request(app).get("/locations");
      expect(res.status).toBe(200);
      const rows = (res.body.locations ?? res.body) as Array<{
        id: number;
        has_operating_hours: boolean;
      }>;
      return rows.find((r) => r.id === id);
    }

    // ─────────────────────────────────────────────────────────────────────────

    it("has_operating_hours is false when operating_hours is NULL", async () => {
      const row = await fetchLocation(app, nullHoursId);
      expect(row).toBeDefined();
      expect(row!.has_operating_hours).toBe(false);
    });

    it("has_operating_hours is false when operating_hours is an empty object", async () => {
      const row = await fetchLocation(app, emptyHoursId);
      expect(row).toBeDefined();
      expect(row!.has_operating_hours).toBe(false);
    });

    it("has_operating_hours is false when every day has closed: true", async () => {
      const row = await fetchLocation(app, allClosedId);
      expect(row).toBeDefined();
      expect(row!.has_operating_hours).toBe(false);
    });

    it("has_operating_hours is true when at least one day has closed: false with valid open/close times", async () => {
      const row = await fetchLocation(app, oneOpenId);
      expect(row).toBeDefined();
      expect(row!.has_operating_hours).toBe(true);
    });
  },
);
