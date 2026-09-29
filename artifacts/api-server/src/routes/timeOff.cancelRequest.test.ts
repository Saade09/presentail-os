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

const mockSendTimeOffCancelledEmail = vi.fn().mockResolvedValue(undefined);

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
let stubWorkspaceRole: "owner" | "member" = "member";
let stubWorkspaceOwnerId = "ws_owner";
let stubUserId = "user_req";

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = stubWorkspaceOwnerId;
    wreq.workspaceRole = stubWorkspaceRole;
    wreq.workspaceActualRole = stubWorkspaceRole;
    wreq.memberDbId = stubMemberDbId;
    wreq.userId = stubUserId;
    wreq.userEmail = "req@example.com";
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

const BALANCE_ROW = {
  id: 10,
  member_id: 1,
  policy_id: 5,
  policy_year: 2026,
  vacation_entitled: "15.00",
  vacation_used: "3.00",
  vacation_pending: "2.00",
  vacation_carryover: "0.00",
  sick_leave_entitled: "10.00",
  sick_leave_used: "0.00",
  sick_leave_pending: "0.00",
};

const PENDING_VACATION_REQUEST = {
  id: 42,
  member_id: 1,
  status: "PENDING",
  type_id: 3,
  total_days: "2.00",
  start_date: "2026-07-01",
  end_date: "2026-07-02",
  type_code: "VACATION",
  type_name: "Vacation",
  half_day: false,
  half_day_period: null,
};

// ---------------------------------------------------------------------------
// POST /time-off/requests/:id/cancel
// ---------------------------------------------------------------------------

describe("POST /time-off/requests/:id/cancel", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    drizzleQueue.length = 0;
    stubMemberDbId = 1;
    stubWorkspaceRole = "member";
    stubWorkspaceOwnerId = "ws_owner";
    stubUserId = "user_req";
    mockGetOrCreateBalance.mockResolvedValue(BALANCE_ROW);
    mockGetUserList.mockResolvedValue({ data: [] });
    mockSendTimeOffCancelledEmail.mockResolvedValue(undefined);
  });

  // ----------------------------------------------------------
  // 403 — memberDbId is null
  // ----------------------------------------------------------

  it("returns 403 when memberDbId is null (member record not found)", async () => {
    stubMemberDbId = null;

    const res = await request(makeApp())
      .post("/time-off/requests/42/cancel")
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/member record not found/i);
    expect(mockDrizzleSelect).not.toHaveBeenCalled();
  });

  // ----------------------------------------------------------
  // 404 — request not found / belongs to another workspace
  // ----------------------------------------------------------

  it("returns 404 when the request does not exist", async () => {
    // Empty queue → drizzle select resolves to [] → 404
    const res = await request(makeApp())
      .post("/time-off/requests/999/cancel")
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/request not found/i);
  });

  it("returns 404 when the request belongs to a different workspace", async () => {
    // The route filters by workspace_owner_id so cross-workspace requests
    // return an empty result — same 404 path.
    const res = await request(makeApp())
      .post("/time-off/requests/42/cancel")
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/request not found/i);
  });

  // ----------------------------------------------------------
  // 409 — terminal-state requests cannot be cancelled
  // ----------------------------------------------------------

  it("returns 409 when the request is already DECLINED", async () => {
    drizzleQueue.push([{ ...PENDING_VACATION_REQUEST, status: "DECLINED" }]);

    const res = await request(makeApp())
      .post("/time-off/requests/42/cancel")
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/DECLINED/);
    expect(mockDrizzleSelect).toHaveBeenCalledTimes(1);
    expect(mockDrizzleUpdate).not.toHaveBeenCalled();
  });

  it("returns 409 when the request is already CANCELLED", async () => {
    drizzleQueue.push([{ ...PENDING_VACATION_REQUEST, status: "CANCELLED" }]);

    const res = await request(makeApp())
      .post("/time-off/requests/42/cancel")
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/CANCELLED/);
    expect(mockDrizzleSelect).toHaveBeenCalledTimes(1);
    expect(mockDrizzleUpdate).not.toHaveBeenCalled();
  });

  // ----------------------------------------------------------
  // Successful cancellation — PENDING request, balance reversal
  // ----------------------------------------------------------

  it("returns 200 and reverses vacation_pending when cancelling a PENDING VACATION request", async () => {
    drizzleQueue.push([PENDING_VACATION_REQUEST]);
    mockGetOrCreateBalance.mockResolvedValueOnce(BALANCE_ROW);

    const res = await request(makeApp())
      .post("/time-off/requests/42/cancel")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    // 3 drizzle updates: cancel + notifications + vacation_pending decrement
    expect(mockDrizzleUpdate).toHaveBeenCalledTimes(3);
    expect(mockGetOrCreateBalance).toHaveBeenCalledWith(
      expect.anything(),
      1,
      "ws_owner",
      2026,
    );
  });

  it("still returns 200 when getOrCreateBalance throws during PENDING cancellation", async () => {
    drizzleQueue.push([PENDING_VACATION_REQUEST]);
    mockGetOrCreateBalance.mockRejectedValueOnce(
      new Error("no active time-off policy assigned"),
    );

    const res = await request(makeApp())
      .post("/time-off/requests/42/cancel")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  // ----------------------------------------------------------
  // Successful cancellation — APPROVED-future request
  // ----------------------------------------------------------

  it("returns 200 and reverses vacation_used when cancelling an APPROVED future VACATION request", async () => {
    const futureApproved = {
      ...PENDING_VACATION_REQUEST,
      status: "APPROVED",
      start_date: "2099-12-01",
      end_date: "2099-12-02",
    };

    drizzleQueue.push([futureApproved]);
    mockGetOrCreateBalance.mockResolvedValueOnce(BALANCE_ROW);

    const res = await request(makeApp())
      .post("/time-off/requests/42/cancel")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    // 3 drizzle updates: cancel + notifications + vacation_used decrement
    expect(mockDrizzleUpdate).toHaveBeenCalledTimes(3);
    expect(mockGetOrCreateBalance).toHaveBeenCalledWith(
      expect.anything(),
      1,
      "ws_owner",
      2099,
    );
  });

  // ----------------------------------------------------------
  // sendTimeOffCancelledEmail is called when an owner cancels
  // a different member's request
  // ----------------------------------------------------------

  it("calls sendTimeOffCancelledEmail when an owner cancels another member's request", async () => {
    stubWorkspaceRole = "owner";
    stubUserId = "user_owner";
    stubMemberDbId = 1;

    const anotherMembersRequest = {
      ...PENDING_VACATION_REQUEST,
      member_id: 2,
    };

    // Queue: select request; updates pop from empty; select employee; select canceller
    drizzleQueue.push([anotherMembersRequest]);
    drizzleQueue.push([]); // UPDATE cancel
    drizzleQueue.push([]); // UPDATE notifications
    drizzleQueue.push([]); // UPDATE balance (VACATION pending decrement)
    drizzleQueue.push([{ member_email: "employee@example.com", member_user_id: "user_emp" }]);
    drizzleQueue.push([{ member_email: "owner@example.com", member_user_id: "user_owner" }]);

    mockGetOrCreateBalance.mockResolvedValueOnce(BALANCE_ROW);

    mockGetUserList
      .mockResolvedValueOnce({
        data: [{ id: "user_emp", firstName: "Bob", lastName: "Employee", hasImage: false, imageUrl: "" }],
      })
      .mockResolvedValueOnce({
        data: [{ id: "user_owner", firstName: "Alice", lastName: "Owner", hasImage: false, imageUrl: "" }],
      });

    const res = await request(makeApp())
      .post("/time-off/requests/42/cancel")
      .send({ cancellation_reason: "Shift change" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    expect(mockSendTimeOffCancelledEmail).toHaveBeenCalledTimes(1);
    expect(mockSendTimeOffCancelledEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        toEmail: "employee@example.com",
        typeName: "Vacation",
        startDate: "2026-07-01",
        endDate: "2026-07-02",
        totalDays: 2,
        cancellationReason: "Shift change",
      }),
    );
  });

  it("does NOT call sendTimeOffCancelledEmail when a member cancels their own request", async () => {
    // member_id on the request matches the canceller's memberDbId
    drizzleQueue.push([PENDING_VACATION_REQUEST]);
    mockGetOrCreateBalance.mockResolvedValueOnce(BALANCE_ROW);

    const res = await request(makeApp())
      .post("/time-off/requests/42/cancel")
      .send({});

    expect(res.status).toBe(200);
    expect(mockSendTimeOffCancelledEmail).not.toHaveBeenCalled();
  });
});
