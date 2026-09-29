import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

// ---------------------------------------------------------------------------
// Drizzle queue mock — declared before importing the module under test
// ---------------------------------------------------------------------------

const drizzleQueue: unknown[][] = [];
function popResult() {
  return drizzleQueue.length > 0 ? drizzleQueue.shift()! : [];
}
function makeChain(result: unknown[]) {
  const p = Promise.resolve(result);
  const chain: Record<string, unknown> = {
    from: () => chain, where: () => chain, orderBy: () => chain,
    limit: () => chain, offset: () => chain, innerJoin: () => chain,
    leftJoin: () => chain, set: () => chain, values: () => chain,
    returning: () => p, onConflictDoUpdate: () => p,
    then: p.then.bind(p), catch: p.catch.bind(p), finally: p.finally.bind(p),
  };
  return chain;
}

const mockDrizzleSelect = vi.fn();
const mockDrizzleInsert = vi.fn();
const mockDrizzleUpdate = vi.fn();
const mockDrizzleDelete = vi.fn();

vi.mock("../lib/drizzle", () => ({
  drizzleDb: {
    select: (...a: unknown[]) => { mockDrizzleSelect(...a); return makeChain(popResult()); },
    insert: (...a: unknown[]) => { mockDrizzleInsert(...a); return makeChain(popResult()); },
    update: (...a: unknown[]) => { mockDrizzleUpdate(...a); return makeChain(popResult()); },
    delete: (...a: unknown[]) => { mockDrizzleDelete(...a); return makeChain(popResult()); },
  },
}));

vi.mock("../lib/db", () => ({ db: {} }));

vi.mock("../lib/auth", () => ({
  requireAuth: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => next(),
}));

const mockGetOrCreateBalance = vi.fn();
vi.mock("../lib/timeOffBalances", () => ({
  getOrCreateBalance: (...args: unknown[]) => mockGetOrCreateBalance(...args),
  calculateWorkingDays: vi.fn().mockReturnValue(1),
  computeVacationRemaining: vi.fn().mockReturnValue(8.5),
}));

vi.mock("../lib/timeOffSse", () => ({
  subscribe: vi.fn(),
  broadcast: vi.fn(),
}));

const mockSendTimeOffCancelledEmail = vi.fn();
vi.mock("../lib/email", () => ({
  sendTimeOffDecisionEmail: vi.fn().mockResolvedValue(undefined),
  sendTimeOffRequestSubmittedEmail: vi.fn().mockResolvedValue(undefined),
  sendTimeOffRequestConfirmationEmail: vi.fn().mockResolvedValue(undefined),
  sendAnnualLeavePolicyAssignedEmail: vi.fn().mockResolvedValue(undefined),
  sendTimeOffCancelledEmail: (...args: unknown[]) =>
    mockSendTimeOffCancelledEmail(...args),
}));

const mockGetUserList = vi.fn();
vi.mock("@clerk/express", () => ({
  clerkClient: {
    users: {
      getUserList: (...args: unknown[]) => mockGetUserList(...args),
    },
  },
}));

vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

let stubMemberDbId: number | null = 1;
let stubWorkspaceOwnerId = "ws_owner";
let stubWorkspaceRole = "member";

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = stubWorkspaceOwnerId;
    wreq.workspaceRole = stubWorkspaceRole as "owner" | "member";
    wreq.workspaceActualRole = stubWorkspaceRole as "owner" | "member";
    wreq.memberDbId = stubMemberDbId;
    wreq.userId = "user_self";
    wreq.userEmail = "self@example.com";
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

import timeOffRouter from "./timeOff";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => {
    (_req as unknown as { log: object }).log = {
      error: () => {},
      warn: () => {},
      info: () => {},
    };
    next();
  });
  app.use(timeOffRouter);
  return app;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FUTURE_DATE = "2099-12-31";
const PAST_DATE = "2020-01-01";

const PENDING_VACATION_REQUEST = {
  id: 42,
  member_id: 1,
  status: "PENDING",
  type_id: 10,
  total_days: "3.00",
  start_date: FUTURE_DATE,
  end_date: FUTURE_DATE,
  type_code: "VACATION",
  type_name: "Annual Leave",
  half_day: false,
  half_day_period: null,
};

const APPROVED_FUTURE_VACATION_REQUEST = {
  ...PENDING_VACATION_REQUEST,
  status: "APPROVED",
};

const PENDING_SICK_LEAVE_REQUEST = {
  ...PENDING_VACATION_REQUEST,
  type_code: "SICK_LEAVE",
  type_name: "Sick Leave",
};

const BALANCE_ROW = {
  id: 10,
  member_id: 1,
  policy_id: 5,
  policy_year: 2099,
  vacation_entitled: "15.00",
  vacation_used: "5.00",
  vacation_pending: "3.00",
  vacation_carryover: "0.00",
  sick_leave_entitled: "10.00",
  sick_leave_used: "0.00",
  sick_leave_pending: "3.00",
};

// ---------------------------------------------------------------------------
// POST /time-off/requests/:id/cancel
// ---------------------------------------------------------------------------

describe("POST /time-off/requests/:id/cancel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    drizzleQueue.length = 0;
    stubMemberDbId = 1;
    stubWorkspaceOwnerId = "ws_owner";
    stubWorkspaceRole = "member";
    mockGetOrCreateBalance.mockResolvedValue(BALANCE_ROW);
    mockGetUserList.mockResolvedValue({ data: [] });
    mockSendTimeOffCancelledEmail.mockResolvedValue(undefined);
  });

  // -------------------------------------------------------------------------
  // Successful self-cancellation of a PENDING VACATION request
  // -------------------------------------------------------------------------

  it("returns 200 and cancels a PENDING VACATION request owned by the caller", async () => {
    // Queue: select request (all subsequent update ops pop from empty queue)
    drizzleQueue.push([PENDING_VACATION_REQUEST]);

    const res = await request(makeApp())
      .post("/time-off/requests/42/cancel")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    // 3 drizzle updates: cancel status + clear notification + balance decrement
    expect(mockDrizzleUpdate).toHaveBeenCalledTimes(3);

    // Balance must be decremented via getOrCreateBalance
    expect(mockGetOrCreateBalance).toHaveBeenCalledWith(
      expect.anything(),
      1,
      "ws_owner",
      2099,
    );

    // No cancellation email for self-cancellation
    expect(mockSendTimeOffCancelledEmail).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Successful self-cancellation of a PENDING SICK_LEAVE request
  // -------------------------------------------------------------------------

  it("decrements sick_leave_pending when cancelling a PENDING SICK_LEAVE request", async () => {
    drizzleQueue.push([PENDING_SICK_LEAVE_REQUEST]);

    const res = await request(makeApp())
      .post("/time-off/requests/42/cancel")
      .send({});

    expect(res.status).toBe(200);
    // 3 drizzle updates: cancel + notifications + sick_leave_pending decrement
    expect(mockDrizzleUpdate).toHaveBeenCalledTimes(3);
    expect(mockGetOrCreateBalance).toHaveBeenCalledWith(
      expect.anything(),
      1,
      "ws_owner",
      2099,
    );
  });

  // -------------------------------------------------------------------------
  // Balance restoration when cancelling an APPROVED (future) request
  // -------------------------------------------------------------------------

  it("decrements vacation_used when cancelling an APPROVED future VACATION request", async () => {
    drizzleQueue.push([APPROVED_FUTURE_VACATION_REQUEST]);

    const res = await request(makeApp())
      .post("/time-off/requests/42/cancel")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    expect(mockGetOrCreateBalance).toHaveBeenCalledWith(
      expect.anything(),
      1,
      "ws_owner",
      2099,
    );
    // 3 drizzle updates: cancel + notifications + vacation_used decrement
    expect(mockDrizzleUpdate).toHaveBeenCalledTimes(3);
  });

  // -------------------------------------------------------------------------
  // 403 — caller does not own the request and is not a workspace owner
  // -------------------------------------------------------------------------

  it("returns 403 when the caller does not own the request", async () => {
    drizzleQueue.push([{ ...PENDING_VACATION_REQUEST, member_id: 99 }]);

    const res = await request(makeApp())
      .post("/time-off/requests/42/cancel")
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/can only cancel your own/i);

    // Only the fetch query ran — no updates after the permission check
    expect(mockDrizzleSelect).toHaveBeenCalledTimes(1);
    expect(mockDrizzleUpdate).not.toHaveBeenCalled();
    expect(mockGetOrCreateBalance).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Workspace owner can cancel another member's request
  // -------------------------------------------------------------------------

  it("allows a workspace owner to cancel another member's PENDING request", async () => {
    stubWorkspaceRole = "owner";

    // Queue: select request; UPDATE cancel; UPDATE notifications; UPDATE balance;
    //        select employee; select canceller
    drizzleQueue.push([{ ...PENDING_VACATION_REQUEST, member_id: 99 }]);
    drizzleQueue.push([]); // UPDATE cancel placeholder
    drizzleQueue.push([]); // UPDATE notifications placeholder
    drizzleQueue.push([]); // UPDATE balance placeholder (VACATION PENDING decrement)
    drizzleQueue.push([{ member_email: "emp@example.com", member_user_id: "user_emp" }]);
    drizzleQueue.push([{ member_email: "owner@example.com", member_user_id: "user_self" }]);

    mockGetUserList
      .mockResolvedValueOnce({
        data: [{ id: "user_emp", firstName: "Emp", lastName: "Loyee" }],
      })
      .mockResolvedValueOnce({
        data: [{ id: "user_self", firstName: "Owner", lastName: "User" }],
      });

    const res = await request(makeApp())
      .post("/time-off/requests/42/cancel")
      .send({ cancellation_reason: "Scheduling conflict" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    expect(mockSendTimeOffCancelledEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        toEmail: "emp@example.com",
        cancellationReason: "Scheduling conflict",
      }),
    );
  });

  // -------------------------------------------------------------------------
  // 409 — request is already DECLINED
  // -------------------------------------------------------------------------

  it("returns 409 when the request is already DECLINED", async () => {
    drizzleQueue.push([{ ...PENDING_VACATION_REQUEST, status: "DECLINED" }]);

    const res = await request(makeApp())
      .post("/time-off/requests/42/cancel")
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/DECLINED/);
    expect(mockGetOrCreateBalance).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 409 — request is already CANCELLED
  // -------------------------------------------------------------------------

  it("returns 409 when the request is already CANCELLED", async () => {
    drizzleQueue.push([{ ...PENDING_VACATION_REQUEST, status: "CANCELLED" }]);

    const res = await request(makeApp())
      .post("/time-off/requests/42/cancel")
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/CANCELLED/);
    expect(mockGetOrCreateBalance).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 409 — APPROVED request that has already started
  // -------------------------------------------------------------------------

  it("returns 409 when trying to cancel an APPROVED request that has already started", async () => {
    drizzleQueue.push([{ ...PENDING_VACATION_REQUEST, status: "APPROVED", start_date: PAST_DATE }]);

    const res = await request(makeApp())
      .post("/time-off/requests/42/cancel")
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already started/i);
    expect(mockGetOrCreateBalance).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 404 — request not found
  // -------------------------------------------------------------------------

  it("returns 404 when the request does not exist", async () => {
    // empty queue → popResult returns [] → tor is undefined → 404

    const res = await request(makeApp())
      .post("/time-off/requests/999/cancel")
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  // -------------------------------------------------------------------------
  // 403 — memberDbId is null
  // -------------------------------------------------------------------------

  it("returns 403 when memberDbId is null", async () => {
    stubMemberDbId = null;

    const res = await request(makeApp())
      .post("/time-off/requests/42/cancel")
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/member record not found/i);
    expect(mockDrizzleSelect).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 400 — invalid request id
  // -------------------------------------------------------------------------

  it("returns 400 when the request id is not a number", async () => {
    const res = await request(makeApp())
      .post("/time-off/requests/not-a-number/cancel")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid request id/i);
  });

  // -------------------------------------------------------------------------
  // Email failure is swallowed — cancellation still succeeds
  // -------------------------------------------------------------------------

  it("returns 200 and records the cancellation even when sendTimeOffCancelledEmail throws", async () => {
    stubWorkspaceRole = "owner";

    // Request belongs to a different member (99) so the email path is triggered.
    // Queue: select request; UPDATE cancel; UPDATE notifications; UPDATE balance;
    //        select employee; select canceller
    drizzleQueue.push([{ ...PENDING_VACATION_REQUEST, member_id: 99 }]);
    drizzleQueue.push([]); // UPDATE cancel placeholder
    drizzleQueue.push([]); // UPDATE notifications placeholder
    drizzleQueue.push([]); // UPDATE balance placeholder (VACATION PENDING decrement)
    drizzleQueue.push([{ member_email: "emp@example.com", member_user_id: "user_emp" }]);
    drizzleQueue.push([{ member_email: "owner@example.com", member_user_id: "user_self" }]);

    mockGetUserList.mockResolvedValue({ data: [] });

    // Make the email sender throw to simulate a provider outage.
    mockSendTimeOffCancelledEmail.mockRejectedValueOnce(new Error("Email provider down"));

    const res = await request(makeApp())
      .post("/time-off/requests/42/cancel")
      .send({ cancellation_reason: "Restructuring" });

    // The route must still succeed.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    // 3 drizzle updates: cancel + clear notification + balance decrement
    expect(mockDrizzleUpdate).toHaveBeenCalledTimes(3);
  });
});
