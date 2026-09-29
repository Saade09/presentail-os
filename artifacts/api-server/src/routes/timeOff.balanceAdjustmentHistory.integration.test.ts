/**
 * Integration test: balance adjustment history audit trail.
 *
 * Verifies that calling POST /time-off/policies/:id/balance-adjustment twice
 * for the same member produces two separate rows in time_off_balance_adjustments
 * (i.e. the audit trail is append-only — rows are never overwritten).
 *
 * The test also asserts that the before→after chain is correct: each
 * adjustment's `vacation_entitled_before` matches the prior row's
 * `vacation_entitled_after`.
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

const OWNER_ID = "__tob_adj_history_integ__";

// ─────────────────────────────────────────────────────────────────────────────
// Mutable state set after seeding (workspace mock reads this).
// ─────────────────────────────────────────────────────────────────────────────

let ownerMemberDbId: number | null = null;

// ─────────────────────────────────────────────────────────────────────────────
// Mocks — only auth / workspace / logger / side-effects.  db uses real module.
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
    wreq.workspaceRole       = "owner";
    wreq.workspaceActualRole = "owner";
    wreq.userId              = "__tob_adj_history_user__";
    wreq.userEmail           = "tob-adj-history@example.com";
    wreq.memberDbId          = ownerMemberDbId;
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

vi.mock("../lib/timeOffSse", () => ({
  subscribe: vi.fn(),
  broadcast: vi.fn(),
}));

vi.mock("../lib/email", () => ({
  sendTimeOffDecisionEmail:             vi.fn().mockResolvedValue(undefined),
  sendTimeOffRequestSubmittedEmail:      vi.fn().mockResolvedValue(undefined),
  sendTimeOffRequestConfirmationEmail:   vi.fn().mockResolvedValue(undefined),
  sendAnnualLeavePolicyAssignedEmail:    vi.fn().mockResolvedValue(undefined),
  sendTimeOffCancelledEmail:             vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@clerk/express", () => ({
  clerkClient: {
    users: {
      getUserList: vi.fn().mockResolvedValue({ data: [] }),
    },
  },
}));

vi.mock("../lib/timeOffBalances", () => ({
  getOrCreateBalance:      vi.fn(),
  calculateWorkingDays:    vi.fn().mockReturnValue(1),
  computeVacationRemaining: vi.fn().mockReturnValue(8),
}));

vi.mock("../lib/holidayImportService", () => ({
  getSupportedCountries: vi.fn().mockResolvedValue([]),
  getSupportedRegions:   vi.fn().mockResolvedValue([]),
  getHolidays:           vi.fn().mockResolvedValue([]),
  getAvailableTypes:     vi.fn().mockResolvedValue([]),
}));

// Imports MUST follow vi.mock declarations (hoisting boundary).
import timeOffRouter from "./timeOff";

// ─────────────────────────────────────────────────────────────────────────────
// App factory
// ─────────────────────────────────────────────────────────────────────────────

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(timeOffRouter);
  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
// Database cleanup — removes all rows created under OWNER_ID.
// ─────────────────────────────────────────────────────────────────────────────

async function cleanup(pool: InstanceType<typeof Pool>): Promise<void> {
  // Delete child rows before parent rows (FK order).
  await pool.query(
    `DELETE FROM time_off_balance_adjustments
       WHERE member_id IN (
         SELECT id FROM workspace_members WHERE workspace_owner_id = $1
       )`,
    [OWNER_ID],
  );
  await pool.query(
    `DELETE FROM time_off_balances
       WHERE member_id IN (
         SELECT id FROM workspace_members WHERE workspace_owner_id = $1
       )`,
    [OWNER_ID],
  );
  await pool.query(
    `DELETE FROM time_off_policies WHERE workspace_owner_id = $1`,
    [OWNER_ID],
  );
  await pool.query(
    `DELETE FROM workspace_members WHERE workspace_owner_id = $1`,
    [OWNER_ID],
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Seed helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Insert a workspace_members row and return its numeric id. */
async function seedWorkspaceMember(
  pool: InstanceType<typeof Pool>,
  opts: { userId: string; email: string; role?: string },
): Promise<number> {
  const r = await pool.query<{ id: number }>(
    `INSERT INTO workspace_members
       (workspace_owner_id, member_user_id, member_email, role)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [OWNER_ID, opts.userId, opts.email, opts.role ?? "member"],
  );
  return r.rows[0].id;
}

/** Insert a time_off_policies row and return its id. */
async function seedPolicy(pool: InstanceType<typeof Pool>): Promise<number> {
  const r = await pool.query<{ id: number }>(
    `INSERT INTO time_off_policies
       (workspace_owner_id, name, vacation_days_per_year, accrual_type, is_active)
     VALUES ($1, 'Test Policy', 20, 'ANNUAL_GRANT', true)
     RETURNING id`,
    [OWNER_ID],
  );
  return r.rows[0].id;
}

/** Insert a time_off_balances row with a given initial vacation_entitled. */
async function seedBalance(
  pool: InstanceType<typeof Pool>,
  memberId: number,
  policyId: number,
  vacationEntitled: number,
): Promise<void> {
  const policyYear = new Date().getFullYear();
  await pool.query(
    `INSERT INTO time_off_balances
       (member_id, policy_id, policy_year, vacation_entitled, vacation_used,
        vacation_pending, vacation_carryover, sick_leave_entitled,
        sick_leave_used, sick_leave_pending)
     VALUES ($1, $2, $3, $4, 0, 0, 0, NULL, 0, 0)`,
    [memberId, policyId, policyYear, vacationEntitled],
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!DATABASE_URL)(
  "POST /time-off/policies/:id/balance-adjustment — audit trail is append-only (integration)",
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
      ownerMemberDbId = null;
    });

    it(
      "two sequential adjustments produce two distinct history rows with correct before→after chain",
      async () => {
        // ── Seed ──────────────────────────────────────────────────────────────
        // Owner member (used as adjusted_by_member_id in INSERT).
        const ownerDbId = await seedWorkspaceMember(pool, {
          userId: "__tob_adj_owner_user__",
          email:  "tob-adj-owner@example.com",
          role:   "owner",
        });
        ownerMemberDbId = ownerDbId;

        // Target member whose balance will be adjusted.
        const targetDbId = await seedWorkspaceMember(pool, {
          userId: "__tob_adj_target_user__",
          email:  "tob-adj-target@example.com",
          role:   "member",
        });

        const policyId = await seedPolicy(pool);

        // Initial balance: 15 days entitled.
        await seedBalance(pool, targetDbId, policyId, 15);

        // ── First adjustment: 15 → 20 ─────────────────────────────────────────
        const res1 = await request(app)
          .post(`/time-off/policies/${policyId}/balance-adjustment`)
          .send({
            memberId:          targetDbId,
            vacationEntitled:  20,
            adjustmentReason:  "Annual review — extra days granted",
          });

        expect(res1.status).toBe(200);
        expect(res1.body.ok).toBe(true);

        // ── Second adjustment: 20 → 25 ────────────────────────────────────────
        const res2 = await request(app)
          .post(`/time-off/policies/${policyId}/balance-adjustment`)
          .send({
            memberId:          targetDbId,
            vacationEntitled:  25,
            adjustmentReason:  "Correction — five more days added",
          });

        expect(res2.status).toBe(200);
        expect(res2.body.ok).toBe(true);

        // ── Fetch adjustment history ───────────────────────────────────────────
        const getRes = await request(app)
          .get(`/time-off/members/${targetDbId}/balance/adjustments`);

        expect(getRes.status).toBe(200);

        const { adjustments } = getRes.body as {
          adjustments: Array<{
            id: number;
            policy_year: number;
            vacation_entitled_before: number;
            vacation_entitled_after:  number;
            amount_changed:           number;
            reason:                   string;
            adjusted_at:              string;
          }>;
        };

        // Two separate rows — never overwritten.
        expect(adjustments).toHaveLength(2);

        // Results are ordered newest-first (ORDER BY created_at DESC).
        const [newest, oldest] = adjustments;

        // Second adjustment: 20 → 25
        expect(newest.vacation_entitled_before).toBe(20);
        expect(newest.vacation_entitled_after).toBe(25);
        expect(newest.amount_changed).toBe(5);
        expect(newest.reason).toBe("Correction — five more days added");

        // First adjustment: 15 → 20
        expect(oldest.vacation_entitled_before).toBe(15);
        expect(oldest.vacation_entitled_after).toBe(20);
        expect(oldest.amount_changed).toBe(5);
        expect(oldest.reason).toBe("Annual review — extra days granted");

        // Chain integrity: newest.before === oldest.after
        expect(newest.vacation_entitled_before).toBe(oldest.vacation_entitled_after);

        // Both rows share the same policy_year.
        expect(newest.policy_year).toBe(new Date().getFullYear());
        expect(oldest.policy_year).toBe(new Date().getFullYear());

        // Confirm directly in DB that exactly two rows exist.
        const policyYear = new Date().getFullYear();
        const dbRows = await pool.query<{
          vacation_entitled_before: string;
          vacation_entitled_after:  string;
        }>(
          `SELECT vacation_entitled_before, vacation_entitled_after
             FROM time_off_balance_adjustments
            WHERE member_id = $1 AND policy_year = $2
            ORDER BY created_at ASC`,
          [targetDbId, policyYear],
        );
        expect(dbRows.rows).toHaveLength(2);
        expect(Number(dbRows.rows[0].vacation_entitled_before)).toBe(15);
        expect(Number(dbRows.rows[0].vacation_entitled_after)).toBe(20);
        expect(Number(dbRows.rows[1].vacation_entitled_before)).toBe(20);
        expect(Number(dbRows.rows[1].vacation_entitled_after)).toBe(25);
      },
    );

    it(
      "self-facing GET /time-off/balance/adjustments returns the member's own adjustment history",
      async () => {
        // ── Seed ──────────────────────────────────────────────────────────────
        const ownerDbId = await seedWorkspaceMember(pool, {
          userId: "__tob_adj_self_owner__",
          email:  "tob-adj-self-owner@example.com",
          role:   "owner",
        });
        ownerMemberDbId = ownerDbId;

        const targetDbId = await seedWorkspaceMember(pool, {
          userId: "__tob_adj_self_target__",
          email:  "tob-adj-self-target@example.com",
          role:   "member",
        });

        const policyId = await seedPolicy(pool);
        await seedBalance(pool, targetDbId, policyId, 10);

        // ── Create two adjustments as owner ───────────────────────────────────
        const res1 = await request(app)
          .post(`/time-off/policies/${policyId}/balance-adjustment`)
          .send({
            memberId:          targetDbId,
            vacationEntitled:  14,
            adjustmentReason:  "First self adjustment",
          });
        expect(res1.status).toBe(200);
        expect(res1.body.ok).toBe(true);

        const res2 = await request(app)
          .post(`/time-off/policies/${policyId}/balance-adjustment`)
          .send({
            memberId:          targetDbId,
            vacationEntitled:  18,
            adjustmentReason:  "Second self adjustment",
          });
        expect(res2.status).toBe(200);
        expect(res2.body.ok).toBe(true);

        // ── Switch mock to the target member and call self-facing route ───────
        ownerMemberDbId = targetDbId;

        const getRes = await request(app)
          .get("/time-off/balance/adjustments");

        expect(getRes.status).toBe(200);

        const { adjustments } = getRes.body as {
          adjustments: Array<{
            id: number;
            policy_year: number;
            vacation_entitled_before: number;
            vacation_entitled_after:  number;
            amount_changed:           number;
            reason:                   string;
            adjusted_at:              string;
          }>;
        };

        expect(adjustments).toHaveLength(2);

        // Results are ordered newest-first.
        const [newest, oldest] = adjustments;

        // Second adjustment: 14 → 18
        expect(newest.vacation_entitled_before).toBe(14);
        expect(newest.vacation_entitled_after).toBe(18);
        expect(newest.amount_changed).toBe(4);
        expect(newest.reason).toBe("Second self adjustment");

        // First adjustment: 10 → 14
        expect(oldest.vacation_entitled_before).toBe(10);
        expect(oldest.vacation_entitled_after).toBe(14);
        expect(oldest.amount_changed).toBe(4);
        expect(oldest.reason).toBe("First self adjustment");

        // Chain integrity.
        expect(newest.vacation_entitled_before).toBe(oldest.vacation_entitled_after);

        // Both rows share the same policy_year.
        expect(newest.policy_year).toBe(new Date().getFullYear());
        expect(oldest.policy_year).toBe(new Date().getFullYear());
      },
    );
  },
);
