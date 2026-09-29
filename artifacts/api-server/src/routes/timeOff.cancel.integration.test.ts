/**
 * Integration tests for POST /time-off/requests/:id/cancel — email notification
 *
 * Verifies that when a workspace owner cancels an employee's leave request the
 * real email layer runs end-to-end (buildTimeOffCancelledHtml, subject
 * assembly, text body) and the outgoing Resend payload contains the correct
 * recipient address, employee name, leave-type name, date range, and
 * cancellation reason.
 *
 * Strategy
 * ─────────
 * • Auth, workspace, logger, Clerk, and timeOffSse are stubbed.
 * • The database layer is real (throwaway PostgreSQL via test:integration:local).
 * • The `resend` npm module is mocked so `emails.send` is a spy — the real
 *   sendTimeOffCancelledEmail / buildTimeOffCancelledHtml code runs, but no
 *   HTTP call leaves the process.
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

const OWNER_ID = "__integration_test_timeoff_cancel__";
const EMPLOYEE_USER_ID = "__integration_test_cancel_emp_user__";
const OWNER_USER_ID = "__integration_test_cancel_owner_user__";
const EMPLOYEE_EMAIL = "employee-cancel-test@example.com";
const OWNER_EMAIL = "owner-cancel-test@example.com";

// Mutable — set in beforeAll after member rows are seeded
let seededOwnerMemberDbId: number | null = null;

// ─────────────────────────────────────────────────────────────────────────────
// Mocks
// email module is NOT mocked — the real sendTimeOffCancelledEmail runs.
// Only the Resend transport is intercepted so no real HTTP request is made.
// ─────────────────────────────────────────────────────────────────────────────

// vi.hoisted ensures the spy is initialised before vi.mock factories run
// (vi.mock calls are hoisted above module-level const declarations).
const mockResendEmailsSend = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ data: { id: "test-id" }, error: null }),
);

vi.mock("resend", () => ({
  // Use a real class so `new Resend(...)` works properly as a constructor
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

// Clerk — fetchClerkNames returns no names; employee name falls back to email
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
  "POST /time-off/requests/:id/cancel — integration (email content)",
  () => {
    let pool: InstanceType<typeof Pool>;
    let app: express.Express;

    let employeeMemberId: number;
    let ownerMemberId: number;
    let leaveTypeId: number;
    let requestId: number;

    const LEAVE_START = "2099-06-01";
    const LEAVE_END = "2099-06-03";
    const TYPE_NAME = "Annual Leave";

    beforeAll(async () => {
      // Provide a fake API key so getResend() does not throw before our mock runs
      process.env.RESEND_API_KEY = "test_resend_key_integration";

      pool = new Pool({ connectionString: DATABASE_URL });
      app = makeApp();

      // Clean up any leftover rows from a previous failed run
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

      // Seed: owner workspace member (the canceller)
      const ownerRow = await pool.query<{ id: number }>(
        `INSERT INTO workspace_members (workspace_owner_id, member_user_id, member_email, role)
         VALUES ($1, $2, $3, 'owner') RETURNING id`,
        [OWNER_ID, OWNER_USER_ID, OWNER_EMAIL],
      );
      ownerMemberId = ownerRow.rows[0].id;
      seededOwnerMemberDbId = ownerMemberId;

      // Seed: a time_off_type for Annual Leave
      const typeRow = await pool.query<{ id: number }>(
        `INSERT INTO time_off_types
           (workspace_owner_id, code, name, is_paid, requires_approval)
         VALUES ($1, 'VACATION', $2, true, true) RETURNING id`,
        [OWNER_ID, TYPE_NAME],
      );
      leaveTypeId = typeRow.rows[0].id;

      // Seed: a PENDING time-off request for the employee
      const reqRow = await pool.query<{ id: number }>(
        `INSERT INTO time_off_requests
           (workspace_owner_id, member_id, type_id,
            start_date, end_date, total_days, status, reason)
         VALUES ($1, $2, $3, $4, $5, 3, 'PENDING', 'Family trip')
         RETURNING id`,
        [OWNER_ID, employeeMemberId, leaveTypeId, LEAVE_START, LEAVE_END],
      );
      requestId = reqRow.rows[0].id;
    });

    afterAll(async () => {
      if (!pool) return;
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

    it("sends the cancellation email to the employee with correct content when the owner cancels", async () => {
      const res = await request(app)
        .post(`/time-off/requests/${requestId}/cancel`)
        .send({ cancellation_reason: "Scheduling conflict" });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });

      // Resend transport must have been called exactly once
      expect(mockResendEmailsSend).toHaveBeenCalledTimes(1);

      const [[sentPayload]] = mockResendEmailsSend.mock.calls as [[{
        from: string;
        to: string;
        subject: string;
        html: string;
        text: string;
      }]];

      // Recipient must be the employee, not the owner
      expect(sentPayload.to).toBe(EMPLOYEE_EMAIL);

      // Subject must mention the employee identifier and the leave type
      // (Clerk returns no names, so name falls back to the employee email)
      expect(sentPayload.subject).toContain(EMPLOYEE_EMAIL);
      expect(sentPayload.subject.toLowerCase()).toContain("annual leave");
      expect(sentPayload.subject.toLowerCase()).toContain("cancelled");

      // Plain-text body must include the leave type, date range, and reason
      expect(sentPayload.text).toContain(TYPE_NAME);
      expect(sentPayload.text).toContain("Jun");   // part of the formatted date label
      expect(sentPayload.text).toContain("2099");
      expect(sentPayload.text).toContain("Scheduling conflict");

      // HTML body must also render employee-facing content
      expect(sentPayload.html).toContain(EMPLOYEE_EMAIL);   // name/greeting fallback
      expect(sentPayload.html).toContain(TYPE_NAME);
      expect(sentPayload.html).toContain("Scheduling conflict");
    });

    it("sends no email when the employee cancels their own request", async () => {
      // Seed a second PENDING request owned by the owner member
      const reqRow2 = await pool.query<{ id: number }>(
        `INSERT INTO time_off_requests
           (workspace_owner_id, member_id, type_id,
            start_date, end_date, total_days, status, reason)
         VALUES ($1, $2, $3, '2099-07-01', '2099-07-02', 2, 'PENDING', 'Personal')
         RETURNING id`,
        [OWNER_ID, ownerMemberId, leaveTypeId],
      );
      const selfRequestId = reqRow2.rows[0].id;

      // workspace mock sets memberDbId = ownerMemberId; the request also
      // belongs to ownerMemberId — this is a self-cancellation.
      const res = await request(app)
        .post(`/time-off/requests/${selfRequestId}/cancel`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });

      // No email must fire for self-cancellations
      expect(mockResendEmailsSend).not.toHaveBeenCalled();

      await pool.query(`DELETE FROM time_off_requests WHERE id = $1`, [selfRequestId]);
    });

    it("returns 409 when the request is already CANCELLED — no email resent", async () => {
      // The first test already cancelled requestId
      const res = await request(app)
        .post(`/time-off/requests/${requestId}/cancel`)
        .send({});

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/CANCELLED/);
      expect(mockResendEmailsSend).not.toHaveBeenCalled();
    });

    it("flips time_off_notifications.is_read to true when a PENDING request is cancelled", async () => {
      // Seed a fresh PENDING request so this test is fully independent
      const reqRow = await pool.query<{ id: number }>(
        `INSERT INTO time_off_requests
           (workspace_owner_id, member_id, type_id,
            start_date, end_date, total_days, status, reason)
         VALUES ($1, $2, $3, '2099-09-01', '2099-09-05', 5, 'PENDING', 'Notification clear test')
         RETURNING id`,
        [OWNER_ID, employeeMemberId, leaveTypeId],
      );
      const freshRequestId = reqRow.rows[0].id;

      // Insert an unread manager notification for this request
      await pool.query(
        `INSERT INTO time_off_notifications
           (workspace_owner_id, recipient_member_id, actor_member_id,
            type, title, body, entity_type, entity_id, is_read)
         VALUES ($1, $2, $3,
                 'TIME_OFF_REQUEST', 'Leave request pending', 'Employee submitted a leave request',
                 'time_off_request', $4, false)`,
        [OWNER_ID, ownerMemberId, employeeMemberId, freshRequestId],
      );

      // Confirm the row exists and is unread before cancellation
      const before = await pool.query<{ is_read: boolean }>(
        `SELECT is_read FROM time_off_notifications
          WHERE entity_type = 'time_off_request' AND entity_id = $1`,
        [freshRequestId],
      );
      expect(before.rows).toHaveLength(1);
      expect(before.rows[0].is_read).toBe(false);

      // Cancel the request via the live Express app
      const res = await request(app)
        .post(`/time-off/requests/${freshRequestId}/cancel`)
        .send({ cancellation_reason: "Notification clear integration test" });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });

      // The notification row must now be marked as read
      const after = await pool.query<{ is_read: boolean }>(
        `SELECT is_read FROM time_off_notifications
          WHERE entity_type = 'time_off_request' AND entity_id = $1`,
        [freshRequestId],
      );
      expect(after.rows).toHaveLength(1);
      expect(
        after.rows[0].is_read,
        "cancelling the request must flip is_read to true on the manager notification",
      ).toBe(true);
    });
  },
);
