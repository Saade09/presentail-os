/**
 * Integration tests for GET /time-off/balance/adjustments
 *
 * Verifies that when a time_off_balance_adjustments row exists for the
 * authenticated member, the endpoint returns the expected adjustment entry
 * including the adjuster's name, reason, and computed amount_changed.
 *
 * Auth and workspace middleware are stubbed; the database is real.
 * The suite skips automatically when DATABASE_URL is not set.
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
// Unique owner ID so test rows never collide with real workspace data
// ─────────────────────────────────────────────────────────────────────────────

const OWNER_ID = "__integration_test_timeoff_balance_adjustments__";
const USER_ID = "__integration_test_toba_user__";

// Mutable — set in beforeAll after the member row is seeded
let seededMemberDbId: number | null = null;

// ─────────────────────────────────────────────────────────────────────────────
// Mocks — auth / workspace / logger / clerkClient only; db is real
// ─────────────────────────────────────────────────────────────────────────────

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
    wreq.userId = USER_ID;
    wreq.userEmail = "timeoff-adj-test@example.com";
    wreq.memberDbId = seededMemberDbId;
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

// Stub Clerk so fetchClerkNames falls back to the email stored in workspace_members
vi.mock("@clerk/express", () => ({
  clerkClient: {
    users: {
      getUser: vi.fn(),
      getUserList: vi.fn().mockResolvedValue({ data: [] }),
    },
  },
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Import the router AFTER vi.mock declarations (hoisting boundary)
// ─────────────────────────────────────────────────────────────────────────────

import timeOffRouter from "./timeOff";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  // Attach a minimal req.log so route handlers that call req.log.* don't throw
  app.use((req, _res, next) => {
    (req as unknown as Record<string, unknown>).log = {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    };
    next();
  });
  app.use(timeOffRouter);
  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!DATABASE_URL)(
  "GET /time-off/balance/adjustments — integration",
  () => {
    let pool: InstanceType<typeof Pool>;
    let app: express.Express;

    let memberMemberId: number;   // the member whose adjustments we query
    let adjusterMemberId: number; // the member who performed the adjustment
    let policyId: number;
    let adjustmentId: number;

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL });
      app = makeApp();

      // Clean up any leftover rows from a previous failed run
      await pool.query(
        `DELETE FROM time_off_balance_adjustments
          WHERE member_id IN (
            SELECT id FROM workspace_members WHERE workspace_owner_id = $1
          )`,
        [OWNER_ID],
      );
      await pool.query(`DELETE FROM time_off_policies WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM workspace_members WHERE workspace_owner_id = $1`, [OWNER_ID]);

      // Seed: workspace_members for the member under test
      const memberRow = await pool.query<{ id: number }>(
        `INSERT INTO workspace_members (workspace_owner_id, member_user_id, member_email, role)
         VALUES ($1, $2, $3, 'member') RETURNING id`,
        [OWNER_ID, USER_ID, "member@example.com"],
      );
      memberMemberId = memberRow.rows[0].id;
      seededMemberDbId = memberMemberId;

      // Seed: workspace_members for the adjuster (a different member)
      const adjusterRow = await pool.query<{ id: number }>(
        `INSERT INTO workspace_members (workspace_owner_id, member_user_id, member_email, role)
         VALUES ($1, 'adj_user_id', 'adjuster@example.com', 'owner') RETURNING id`,
        [OWNER_ID],
      );
      adjusterMemberId = adjusterRow.rows[0].id;

      // Seed: a time_off_policies row (needed for the FK)
      const policyRow = await pool.query<{ id: number }>(
        `INSERT INTO time_off_policies (workspace_owner_id, name)
         VALUES ($1, 'Standard Policy') RETURNING id`,
        [OWNER_ID],
      );
      policyId = policyRow.rows[0].id;

      // Seed: the adjustment row
      const adjRow = await pool.query<{ id: number }>(
        `INSERT INTO time_off_balance_adjustments
           (member_id, policy_id, policy_year, vacation_entitled_before,
            vacation_entitled_after, reason, adjusted_by_member_id)
         VALUES ($1, $2, 2026, 15, 18, 'Annual grant top-up', $3)
         RETURNING id`,
        [memberMemberId, policyId, adjusterMemberId],
      );
      adjustmentId = adjRow.rows[0].id;
    });

    afterAll(async () => {
      if (!pool) return;
      await pool.query(
        `DELETE FROM time_off_balance_adjustments WHERE id = $1`,
        [adjustmentId],
      );
      await pool.query(`DELETE FROM time_off_policies WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM workspace_members WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.end();
    });

    it("returns the seeded adjustment with correct fields", async () => {
      const res = await request(app).get("/time-off/balance/adjustments");

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("adjustments");

      const adjustments: Array<{
        id: number;
        policy_year: number;
        vacation_entitled_before: number;
        vacation_entitled_after: number;
        amount_changed: number;
        reason: string;
        adjusted_by_name: string;
        adjusted_at: string;
      }> = res.body.adjustments;

      expect(adjustments.length).toBeGreaterThanOrEqual(1);

      const adj = adjustments.find((a) => a.id === adjustmentId);
      expect(adj).toBeDefined();
      expect(adj!.policy_year).toBe(2026);
      expect(adj!.vacation_entitled_before).toBe(15);
      expect(adj!.vacation_entitled_after).toBe(18);
      expect(adj!.amount_changed).toBe(3);
      expect(adj!.reason).toBe("Annual grant top-up");
      // Clerk returns no users, so the name falls back to the adjuster's email
      expect(adj!.adjusted_by_name).toBe("adjuster@example.com");
      expect(adj!.adjusted_at).toBeTruthy();
    });

    it("returns an empty array when the member has no adjustments", async () => {
      // Temporarily point the workspace mock at a different (non-existent) member
      const originalId = seededMemberDbId;
      seededMemberDbId = adjusterMemberId; // adjuster has no adjustment rows targeting them

      const res = await request(app).get("/time-off/balance/adjustments");

      seededMemberDbId = originalId;

      expect(res.status).toBe(200);
      expect(res.body.adjustments).toEqual([]);
    });

    it("returns 403 when memberDbId is null", async () => {
      const originalId = seededMemberDbId;
      seededMemberDbId = null;

      const res = await request(app).get("/time-off/balance/adjustments");

      seededMemberDbId = originalId;

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/member record not found/i);
    });
  },
);
