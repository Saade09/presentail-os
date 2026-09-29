/**
 * Integration tests for PATCH /time-off/requests/:id/status (approve & decline)
 * — notification-clearing behaviour
 *
 * Verifies that when a manager approves or declines a PENDING leave request
 * the time_off_notifications row for that request is flipped to is_read = true,
 * so the bell badge disappears from the manager's UI after acting.
 *
 * Strategy
 * ─────────
 * • Auth, workspace, logger, Clerk, and timeOffSse are stubbed.
 * • The database layer is real (throwaway PostgreSQL via test:integration:local).
 * • The `resend` npm module is mocked so no real HTTP call leaves the process.
 *
 * The suite skips automatically when DATABASE_URL is not set.
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
// Unique IDs so test rows never collide with real workspace data
// ─────────────────────────────────────────────────────────────────────────────

const OWNER_ID = "__integration_test_timeoff_apprdecl__";
const EMPLOYEE_USER_ID = "__integration_test_apprdecl_emp_user__";
const OWNER_USER_ID = "__integration_test_apprdecl_owner_user__";
const EMPLOYEE_EMAIL = "employee-apprdecl-test@example.com";
const OWNER_EMAIL = "owner-apprdecl-test@example.com";

// Mutable — set in beforeAll after member rows are seeded
let seededOwnerMemberDbId: number | null = null;

// ─────────────────────────────────────────────────────────────────────────────
// Mocks
// ─────────────────────────────────────────────────────────────────────────────

const mockResendEmailsSend = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ data: { id: "test-id" }, error: null }),
);

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: mockResendEmailsSend };
  },
}));

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
    wreq.userId = OWNER_USER_ID;
    wreq.userEmail = OWNER_EMAIL;
    wreq.memberDbId = seededOwnerMemberDbId;
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

vi.mock("../lib/timeOffSse", () => ({
  subscribe: vi.fn(),
  broadcast: vi.fn(),
}));

// Clerk — fetchClerkNames returns no names; name falls back to email
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
// Import router AFTER vi.mock declarations (hoisting boundary)
// ─────────────────────────────────────────────────────────────────────────────

import timeOffRouter from "./timeOff";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
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
  "PATCH /time-off/requests/:id/status — integration (notification clearing)",
  () => {
    let pool: InstanceType<typeof Pool>;
    let app: express.Express;

    let employeeMemberId: number;
    let ownerMemberId: number;
    let leaveTypeId: number;

    beforeAll(async () => {
      process.env.RESEND_API_KEY = "test_resend_key_integration";

      pool = new Pool({ connectionString: DATABASE_URL });
      app = makeApp();

      // Clean up any leftover rows from a previous failed run
      await pool.query(
        `DELETE FROM time_off_notifications WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM time_off_requests WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM time_off_types WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM workspace_members WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );

      // Seed: employee workspace member
      const employeeRow = await pool.query<{ id: number }>(
        `INSERT INTO workspace_members (workspace_owner_id, member_user_id, member_email, role)
         VALUES ($1, $2, $3, 'member') RETURNING id`,
        [OWNER_ID, EMPLOYEE_USER_ID, EMPLOYEE_EMAIL],
      );
      employeeMemberId = employeeRow.rows[0].id;

      // Seed: owner workspace member (the reviewer)
      const ownerRow = await pool.query<{ id: number }>(
        `INSERT INTO workspace_members (workspace_owner_id, member_user_id, member_email, role)
         VALUES ($1, $2, $3, 'owner') RETURNING id`,
        [OWNER_ID, OWNER_USER_ID, OWNER_EMAIL],
      );
      ownerMemberId = ownerRow.rows[0].id;
      seededOwnerMemberDbId = ownerMemberId;

      // Seed: a leave type that skips balance logic (code is neither VACATION nor SICK_LEAVE)
      const typeRow = await pool.query<{ id: number }>(
        `INSERT INTO time_off_types
           (workspace_owner_id, code, name, is_paid, requires_approval)
         VALUES ($1, 'PERSONAL', 'Personal Leave', true, true) RETURNING id`,
        [OWNER_ID],
      );
      leaveTypeId = typeRow.rows[0].id;
    });

    afterAll(async () => {
      if (!pool) return;
      await pool.query(
        `DELETE FROM time_off_notifications WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM time_off_requests WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM time_off_types WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM workspace_members WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      await pool.end();
      delete process.env.RESEND_API_KEY;
    });

    beforeEach(() => {
      mockResendEmailsSend.mockClear();
    });

    // ── Helper: seed a fresh PENDING request + a matching unread notification ──

    async function seedPendingRequestWithNotification(): Promise<{
      requestId: number;
      notificationId: number;
    }> {
      const reqRow = await pool.query<{ id: number }>(
        `INSERT INTO time_off_requests
           (workspace_owner_id, member_id, type_id,
            start_date, end_date, total_days, status, reason)
         VALUES ($1, $2, $3, '2099-08-01', '2099-08-03', 3, 'PENDING', 'Notification clear test')
         RETURNING id`,
        [OWNER_ID, employeeMemberId, leaveTypeId],
      );
      const requestId = reqRow.rows[0].id;

      const notifRow = await pool.query<{ id: number }>(
        `INSERT INTO time_off_notifications
           (workspace_owner_id, recipient_member_id, actor_member_id,
            type, title, body, entity_type, entity_id, is_read)
         VALUES ($1, $2, $3,
                 'TIME_OFF_REQUEST', 'Leave request pending', 'Employee submitted a leave request',
                 'time_off_request', $4, false)
         RETURNING id`,
        [OWNER_ID, ownerMemberId, employeeMemberId, requestId],
      );
      const notificationId = notifRow.rows[0].id;

      return { requestId, notificationId };
    }

    it("flips time_off_notifications.is_read to true when a manager APPROVES a pending request", async () => {
      const { requestId, notificationId } = await seedPendingRequestWithNotification();

      // Confirm the notification is unread before acting
      const before = await pool.query<{ is_read: boolean }>(
        `SELECT is_read FROM time_off_notifications WHERE id = $1`,
        [notificationId],
      );
      expect(before.rows).toHaveLength(1);
      expect(before.rows[0].is_read).toBe(false);

      // Approve the request via the live Express app
      const res = await request(app)
        .patch(`/time-off/requests/${requestId}/status`)
        .send({ status: "APPROVED" });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, status: "APPROVED" });

      // The notification row must now be marked as read
      const after = await pool.query<{ is_read: boolean }>(
        `SELECT is_read FROM time_off_notifications WHERE id = $1`,
        [notificationId],
      );
      expect(after.rows).toHaveLength(1);
      expect(
        after.rows[0].is_read,
        "approving a request must flip is_read to true on the manager notification",
      ).toBe(true);
    });

    it("flips time_off_notifications.is_read to true when a manager DECLINES a pending request", async () => {
      const { requestId, notificationId } = await seedPendingRequestWithNotification();

      // Confirm the notification is unread before acting
      const before = await pool.query<{ is_read: boolean }>(
        `SELECT is_read FROM time_off_notifications WHERE id = $1`,
        [notificationId],
      );
      expect(before.rows).toHaveLength(1);
      expect(before.rows[0].is_read).toBe(false);

      // Decline the request via the live Express app
      const res = await request(app)
        .patch(`/time-off/requests/${requestId}/status`)
        .send({ status: "DECLINED", managerNote: "Insufficient coverage" });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, status: "DECLINED" });

      // The notification row must now be marked as read
      const after = await pool.query<{ is_read: boolean }>(
        `SELECT is_read FROM time_off_notifications WHERE id = $1`,
        [notificationId],
      );
      expect(after.rows).toHaveLength(1);
      expect(
        after.rows[0].is_read,
        "declining a request must flip is_read to true on the manager notification",
      ).toBe(true);
    });

    it("clears the notification even when multiple unread notifications exist for different requests", async () => {
      // Seed two separate requests each with their own notification
      const first = await seedPendingRequestWithNotification();
      const second = await seedPendingRequestWithNotification();

      // Approve only the first request
      const res = await request(app)
        .patch(`/time-off/requests/${first.requestId}/status`)
        .send({ status: "APPROVED" });

      expect(res.status).toBe(200);

      // First notification must be read; second must still be unread
      const firstNotif = await pool.query<{ is_read: boolean }>(
        `SELECT is_read FROM time_off_notifications WHERE id = $1`,
        [first.notificationId],
      );
      expect(firstNotif.rows[0].is_read).toBe(true);

      const secondNotif = await pool.query<{ is_read: boolean }>(
        `SELECT is_read FROM time_off_notifications WHERE id = $1`,
        [second.notificationId],
      );
      expect(secondNotif.rows[0].is_read).toBe(false);

      // Clean up the second request so it doesn't interfere with other tests
      await pool.query(`DELETE FROM time_off_notifications WHERE id = $1`, [second.notificationId]);
      await pool.query(`DELETE FROM time_off_requests WHERE id = $1`, [second.requestId]);
    });

    it("returns 409 when request is already APPROVED — no double-processing", async () => {
      const { requestId } = await seedPendingRequestWithNotification();

      // First approval
      await request(app)
        .patch(`/time-off/requests/${requestId}/status`)
        .send({ status: "APPROVED" });

      // Second attempt must be rejected
      const res = await request(app)
        .patch(`/time-off/requests/${requestId}/status`)
        .send({ status: "APPROVED" });

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/PENDING/i);
    });
  },
);
