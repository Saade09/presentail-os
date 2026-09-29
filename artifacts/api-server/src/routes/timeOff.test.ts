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
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  authed: (req: express.Request) => req,
}));

const mockSendTimeOffDecisionEmail = vi.fn().mockResolvedValue(undefined);
const mockSendTimeOffRequestSubmittedEmail = vi.fn().mockResolvedValue(undefined);
const mockSendTimeOffRequestConfirmationEmail = vi.fn().mockResolvedValue(undefined);
const mockSendTimeOffCancelledEmail = vi.fn().mockResolvedValue(undefined);
vi.mock("../lib/email", () => ({
  sendTimeOffDecisionEmail: (...args: unknown[]) => mockSendTimeOffDecisionEmail(...args),
  sendTimeOffRequestSubmittedEmail: (...args: unknown[]) =>
    mockSendTimeOffRequestSubmittedEmail(...args),
  sendTimeOffRequestConfirmationEmail: (...args: unknown[]) =>
    mockSendTimeOffRequestConfirmationEmail(...args),
  sendTimeOffCancelledEmail: (...args: unknown[]) => mockSendTimeOffCancelledEmail(...args),
}));

const { mockGetUserList } = vi.hoisted(() => ({
  mockGetUserList: vi.fn().mockResolvedValue({ data: [] }),
}));

vi.mock("@clerk/express", () => ({
  clerkClient: {
    users: {
      getUserList: mockGetUserList,
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

const mockBroadcast = vi.fn();
vi.mock("../lib/timeOffSse", () => ({
  subscribe: vi.fn(),
  broadcast: (...args: unknown[]) => mockBroadcast(...args),
}));

const mockGetOrCreateBalance = vi.fn();
vi.mock("../lib/timeOffBalances", () => ({
  getOrCreateBalance: (...args: unknown[]) => mockGetOrCreateBalance(...args),
  calculateWorkingDays: vi.fn(() => 1),
  computeVacationRemaining: vi.fn(() => 0),
}));

import { calculateWorkingDays } from "../lib/timeOffBalances";

let stubWorkspaceOwnerId = "owner_111";
let stubWorkspaceRole: "owner" | "member" = "member";
let stubMemberDbId: number | null = 50;
let stubUserEmail: string | null = "manager@example.com";
let stubUserId = "user_manager";

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.userId = stubUserId;
    wreq.workspaceOwnerId = stubWorkspaceOwnerId;
    wreq.workspaceRole = stubWorkspaceRole;
    wreq.workspaceActualRole = stubWorkspaceRole;
    wreq.userEmail = stubUserEmail;
    wreq.memberDbId = stubMemberDbId;
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

import timeOffRouter from "./timeOff";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(timeOffRouter);
  return app;
}

// ---------------------------------------------------------------------------
// PATCH /time-off/requests/:id/status
// ---------------------------------------------------------------------------

describe("PATCH /time-off/requests/:id/status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    drizzleQueue.length = 0;
    stubWorkspaceOwnerId = "owner_111";
    stubWorkspaceRole = "member";
    stubMemberDbId = 50;
    stubUserEmail = "manager@example.com";
    stubUserId = "user_manager";
    mockGetOrCreateBalance.mockResolvedValue({ id: 999 });
    mockSendTimeOffDecisionEmail.mockResolvedValue(undefined);
  });

  function pendingRequestRow(overrides: Partial<{
    id: number;
    member_id: number;
    manager_member_id: number | null;
    status: string;
    type_id: number;
    type_code: string;
    type_name: string;
    total_days: string;
    start_date: string;
    end_date: string;
    half_day: boolean;
    half_day_period: "AM" | "PM" | null;
    member_email: string;
    member_user_id: string | null;
    member_notify_email_on_decision: boolean | null;
  }> = {}) {
    return {
      id: 123,
      member_id: 77,
      manager_member_id: 50,
      status: "PENDING",
      type_id: 1,
      type_code: "VACATION",
      type_name: "Vacation",
      total_days: "2.00",
      start_date: "2026-06-01",
      end_date: "2026-06-02",
      half_day: false,
      half_day_period: null,
      member_email: "employee@example.com",
      member_user_id: "user_employee",
      member_notify_email_on_decision: null,
      ...overrides,
    };
  }

  it("approves a pending request when called by the assigned manager", async () => {
    drizzleQueue.push([pendingRequestRow()]);
    // 3 updates (request status + balance + notifications) pop from empty queue

    const res = await request(makeApp())
      .patch("/time-off/requests/123/status")
      .send({ status: "APPROVED", managerNote: "Looks good" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
    expect(mockBroadcast).toHaveBeenCalledWith(50);

    // 1 select (lookup) + 3 updates (request + balance + notifications)
    expect(mockDrizzleSelect).toHaveBeenCalledTimes(1);
    expect(mockDrizzleUpdate).toHaveBeenCalledTimes(3);
  });

  it("declines a pending request and only decrements pending balance", async () => {
    drizzleQueue.push([pendingRequestRow()]);

    const res = await request(makeApp())
      .patch("/time-off/requests/123/status")
      .send({ status: "DECLINED" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });

    // 1 select + 3 updates (request + balance pending-only + notifications)
    expect(mockDrizzleSelect).toHaveBeenCalledTimes(1);
    expect(mockDrizzleUpdate).toHaveBeenCalledTimes(3);
  });

  it("allows the workspace owner to review even when not the assigned manager", async () => {
    stubWorkspaceRole = "owner";
    stubMemberDbId = 1;

    drizzleQueue.push([pendingRequestRow({ manager_member_id: 50 })]);

    const res = await request(makeApp())
      .patch("/time-off/requests/123/status")
      .send({ status: "APPROVED" });

    expect(res.status).toBe(200);
  });

  it("returns 403 when the caller is neither the assigned manager nor the owner", async () => {
    stubWorkspaceRole = "member";
    stubMemberDbId = 1;

    drizzleQueue.push([pendingRequestRow({ manager_member_id: 50 })]);

    const res = await request(makeApp())
      .patch("/time-off/requests/123/status")
      .send({ status: "APPROVED" });

    expect(res.status).toBe(403);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it("returns 404 when the request does not exist", async () => {
    // Empty queue → select resolves to [] → 404

    const res = await request(makeApp())
      .patch("/time-off/requests/999/status")
      .send({ status: "APPROVED" });

    expect(res.status).toBe(404);
  });

  it("returns 409 when the request is no longer PENDING", async () => {
    drizzleQueue.push([pendingRequestRow({ status: "APPROVED" })]);

    const res = await request(makeApp())
      .patch("/time-off/requests/123/status")
      .send({ status: "APPROVED" });

    expect(res.status).toBe(409);
  });

  it("returns 400 for an invalid status value", async () => {
    const res = await request(makeApp())
      .patch("/time-off/requests/123/status")
      .send({ status: "MAYBE" });

    expect(res.status).toBe(400);
    expect(mockDrizzleSelect).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid request id", async () => {
    const res = await request(makeApp())
      .patch("/time-off/requests/not-a-number/status")
      .send({ status: "APPROVED" });

    expect(res.status).toBe(400);
    expect(mockDrizzleSelect).not.toHaveBeenCalled();
  });

  it("returns 403 when the caller has no member record", async () => {
    stubMemberDbId = null;

    const res = await request(makeApp())
      .patch("/time-off/requests/123/status")
      .send({ status: "APPROVED" });

    expect(res.status).toBe(403);
  });

  it("emails the requesting employee with the decision and dates on approval", async () => {
    drizzleQueue.push([pendingRequestRow()]);

    await request(makeApp())
      .patch("/time-off/requests/123/status")
      .send({ status: "APPROVED", managerNote: "Enjoy the break" });

    expect(mockSendTimeOffDecisionEmail).toHaveBeenCalledTimes(1);
    expect(mockSendTimeOffDecisionEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        toEmail: "employee@example.com",
        status: "APPROVED",
        typeName: "Vacation",
        startDate: "2026-06-01",
        endDate: "2026-06-02",
        managerNote: "Enjoy the break",
      }),
    );
  });

  it("emails the requesting employee on a declined request", async () => {
    drizzleQueue.push([pendingRequestRow()]);

    await request(makeApp())
      .patch("/time-off/requests/123/status")
      .send({ status: "DECLINED" });

    expect(mockSendTimeOffDecisionEmail).toHaveBeenCalledTimes(1);
    expect(mockSendTimeOffDecisionEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        toEmail: "employee@example.com",
        status: "DECLINED",
        managerNote: null,
      }),
    );
  });

  it("does not email when authorization fails", async () => {
    stubWorkspaceRole = "member";
    stubMemberDbId = 1;

    drizzleQueue.push([pendingRequestRow({ manager_member_id: 50 })]);

    await request(makeApp())
      .patch("/time-off/requests/123/status")
      .send({ status: "APPROVED" });

    expect(mockSendTimeOffDecisionEmail).not.toHaveBeenCalled();
  });

  it("still returns 200 when sending the decision email fails", async () => {
    mockSendTimeOffDecisionEmail.mockRejectedValueOnce(new Error("smtp down"));

    drizzleQueue.push([pendingRequestRow()]);

    const res = await request(makeApp())
      .patch("/time-off/requests/123/status")
      .send({ status: "APPROVED" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
  });

  it("marks any related notifications for this manager as read", async () => {
    drizzleQueue.push([pendingRequestRow()]);

    await request(makeApp())
      .patch("/time-off/requests/123/status")
      .send({ status: "APPROVED" });

    // 3 drizzle updates: request status + balance + notifications mark-read
    expect(mockDrizzleUpdate).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// POST /time-off/requests/:id/approve and /decline
// (the endpoints that the manager-facing /time-off/approvals page actually
// calls; PATCH /status is the older shape and is covered above)
// ---------------------------------------------------------------------------

describe("POST /time-off/requests/:id/approve", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    drizzleQueue.length = 0;
    stubWorkspaceOwnerId = "owner_111";
    stubWorkspaceRole = "member";
    stubMemberDbId = 50;
    stubUserEmail = "manager@example.com";
    stubUserId = "user_manager";
    mockGetOrCreateBalance.mockResolvedValue({ id: 999 });
  });

  function pendingRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 123,
      member_id: 77,
      manager_member_id: 50,
      status: "PENDING",
      type_code: "VACATION",
      type_name: "Vacation",
      total_days: "2.00",
      start_date: "2026-06-01",
      member_email: "employee@example.com",
      ...overrides,
    };
  }

  it("returns 403 when the caller is neither the assigned manager nor an admin", async () => {
    stubWorkspaceRole = "member";
    stubMemberDbId = 1;

    drizzleQueue.push([pendingRow({ manager_member_id: 50 })]);

    const res = await request(makeApp()).post("/time-off/requests/123/approve");

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: expect.any(String) });
    expect(mockBroadcast).not.toHaveBeenCalled();
    expect(mockDrizzleSelect).toHaveBeenCalledTimes(1);
  });

  it("returns 409 when the request is no longer PENDING", async () => {
    drizzleQueue.push([pendingRow({ status: "APPROVED" })]);

    const res = await request(makeApp()).post("/time-off/requests/123/approve");

    expect(res.status).toBe(409);
    expect(mockBroadcast).not.toHaveBeenCalled();
    expect(mockDrizzleSelect).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// POST /time-off/requests (create / submit)
// ---------------------------------------------------------------------------

describe("POST /time-off/requests (create / submit)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    drizzleQueue.length = 0;
    stubWorkspaceOwnerId = "owner_111";
    stubWorkspaceRole = "member";
    stubMemberDbId = 77; // requester
    stubUserEmail = "employee@example.com";
    stubUserId = "user_employee";
    mockGetOrCreateBalance.mockResolvedValue({ id: 999 });
    mockSendTimeOffRequestSubmittedEmail.mockResolvedValue(undefined);
  });

  // ---------------------------------------------------------------------------
  // Queue order for the manager-assigned happy path (6 drizzle ops):
  //   1. SELECT time_off_types
  //   2. SELECT time_off_requests (overlap check) → push []
  //   3. SELECT workspace_members (member + manager info)
  //   4. INSERT time_off_requests RETURNING id
  //   5. UPDATE time_off_balances (vacation_pending++) → pops from empty
  //   6. INSERT time_off_notifications → pops from empty
  // ---------------------------------------------------------------------------
  function setupCreateMocks(opts: {
    managerEmail?: string | null;
    managerMemberId?: number | null;
    requesterEmail?: string | null;
  } = {}) {
    const {
      managerEmail = "manager@example.com",
      managerMemberId = 50,
      requesterEmail = "employee@example.com",
    } = opts;

    drizzleQueue.push([{ id: 1, name: "Vacation" }]); // 1: type lookup
    drizzleQueue.push([]);                              // 2: overlap check (none)
    drizzleQueue.push([{                               // 3: member lookup
      manager_member_id: managerMemberId,
      requester_email: requesterEmail,
      requester_user_id: "user_employee",
      manager_user_id: managerMemberId ? "user_manager" : null,
      manager_email: managerEmail,
      manager_notify_email: true,
      working_days: null,
    }]);
    drizzleQueue.push([{ id: 555 }]);                   // 4: INSERT returning
    // 5 (UPDATE balance) and 6 (INSERT notification) pop from empty queue
  }

  // ---------------------------------------------------------------------------
  // Queue order for the no-manager path (7+ drizzle ops):
  //   1. SELECT type, 2. SELECT overlap → [], 3. SELECT member,
  //   4. INSERT request → [{id}], 5. UPDATE balance → [] placeholder,
  //   6. SELECT owners, 7+. INSERT notification per owner → pop from empty
  // ---------------------------------------------------------------------------
  function setupCreateMocksNoManager(opts: {
    owners?: Array<{ id: number; member_email: string | null; notify_email_on_time_off_request?: boolean | null }>;
    requesterEmail?: string | null;
  } = {}) {
    const {
      owners = [{ id: 1, member_email: "owner@example.com", notify_email_on_time_off_request: true }],
      requesterEmail = "employee@example.com",
    } = opts;

    drizzleQueue.push([{ id: 1, name: "Vacation" }]); // 1: type
    drizzleQueue.push([]);                              // 2: overlap (none)
    drizzleQueue.push([{                               // 3: member (no manager)
      manager_member_id: null,
      requester_email: requesterEmail,
      requester_user_id: "user_employee",
      manager_user_id: null,
      manager_email: null,
      manager_notify_email: null,
      working_days: null,
    }]);
    drizzleQueue.push([{ id: 555 }]);                   // 4: INSERT returning
    drizzleQueue.push([]);                              // 5: UPDATE balance placeholder
    drizzleQueue.push(owners);                         // 6: owners SELECT
    // INSERT notifications for each owner pop from empty queue
  }

  it("emails the manager with request details after a successful submit", async () => {
    mockGetUserList
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({
        data: [{ id: "user_employee", firstName: "Alex", lastName: "Doe" }],
      });
    setupCreateMocks();

    const res = await request(makeApp())
      .post("/time-off/requests")
      .send({
        typeCode: "VACATION",
        startDate: "2026-06-01",
        endDate: "2026-06-02",
        reason: "Family trip",
      });

    expect(res.status).toBe(201);
    expect(mockSendTimeOffRequestSubmittedEmail).toHaveBeenCalledTimes(1);
    expect(mockSendTimeOffRequestSubmittedEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        toEmail: "manager@example.com",
        requesterName: "Alex Doe",
        typeName: "Vacation",
        startDate: "2026-06-01",
        endDate: "2026-06-02",
        reason: "Family trip",
        approvalsUrl: expect.stringMatching(
          /^https?:\/\/[^/]+\/time-off\/approvals$/,
        ),
      }),
    );

    // 3 selects (type + overlap + member), 2 inserts (request + notification), 1 update (balance)
    expect(mockDrizzleSelect).toHaveBeenCalledTimes(3);
    expect(mockDrizzleInsert).toHaveBeenCalledTimes(2);
    expect(mockDrizzleUpdate).toHaveBeenCalledTimes(1);
  });

  it("emails the employee with confirmation details after a successful submit", async () => {
    setupCreateMocks();

    const res = await request(makeApp())
      .post("/time-off/requests")
      .send({
        typeCode: "VACATION",
        startDate: "2026-06-01",
        endDate: "2026-06-02",
        reason: "Family trip",
      });

    expect(res.status).toBe(201);
    expect(mockSendTimeOffRequestConfirmationEmail).toHaveBeenCalledTimes(1);
    expect(mockSendTimeOffRequestConfirmationEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        toEmail: "employee@example.com",
        typeName: "Vacation",
        startDate: "2026-06-01",
        endDate: "2026-06-02",
        reason: "Family trip",
        myRequestsUrl: expect.stringMatching(
          /^https?:\/\/[^/]+\/time-off\/my$/,
        ),
      }),
    );

    expect(mockDrizzleSelect).toHaveBeenCalledTimes(3);
    expect(mockDrizzleInsert).toHaveBeenCalledTimes(2);
    expect(mockDrizzleUpdate).toHaveBeenCalledTimes(1);
  });

  it("still returns 201 when the manager email helper throws", async () => {
    mockSendTimeOffRequestSubmittedEmail.mockRejectedValueOnce(new Error("smtp down"));
    setupCreateMocks();

    const res = await request(makeApp())
      .post("/time-off/requests")
      .send({
        typeCode: "VACATION",
        startDate: "2026-06-01",
        endDate: "2026-06-02",
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ request: { id: 555, status: "PENDING" } });
    expect(mockDrizzleSelect).toHaveBeenCalledTimes(3);
    expect(mockDrizzleInsert).toHaveBeenCalledTimes(2);
    expect(mockDrizzleUpdate).toHaveBeenCalledTimes(1);
  });

  it("skips the email when the manager has no email on file", async () => {
    setupCreateMocks({ managerEmail: null });

    const res = await request(makeApp())
      .post("/time-off/requests")
      .send({
        typeCode: "VACATION",
        startDate: "2026-06-01",
        endDate: "2026-06-02",
      });

    expect(res.status).toBe(201);
    expect(mockSendTimeOffRequestSubmittedEmail).not.toHaveBeenCalled();
    expect(mockDrizzleSelect).toHaveBeenCalledTimes(3);
    expect(mockDrizzleInsert).toHaveBeenCalledTimes(2);
    expect(mockDrizzleUpdate).toHaveBeenCalledTimes(1);
  });

  it("notifies and emails the workspace owner when the requester has no manager", async () => {
    mockGetUserList
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({
        data: [{ id: "user_employee", firstName: "Alex", lastName: "Doe" }],
      });
    setupCreateMocksNoManager();

    const res = await request(makeApp())
      .post("/time-off/requests")
      .send({
        typeCode: "VACATION",
        startDate: "2026-06-01",
        endDate: "2026-06-02",
        reason: "Family trip",
      });

    expect(res.status).toBe(201);

    // Owner received an in-app notification + SSE broadcast.
    expect(mockBroadcast).toHaveBeenCalledWith(1);

    // Owner received an email with request details.
    expect(mockSendTimeOffRequestSubmittedEmail).toHaveBeenCalledTimes(1);
    expect(mockSendTimeOffRequestSubmittedEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        toEmail: "owner@example.com",
        requesterName: "Alex Doe",
        typeName: "Vacation",
        startDate: "2026-06-01",
        endDate: "2026-06-02",
        reason: "Family trip",
      }),
    );

    // 4 selects (type + overlap + member + owners), 2 inserts (request + notif), 1 update (balance)
    expect(mockDrizzleSelect).toHaveBeenCalledTimes(4);
    expect(mockDrizzleInsert).toHaveBeenCalledTimes(2);
    expect(mockDrizzleUpdate).toHaveBeenCalledTimes(1);
  });

  it("notifies every workspace owner when there are multiple owners and no manager", async () => {
    setupCreateMocksNoManager({
      owners: [
        { id: 1, member_email: "owner1@example.com", notify_email_on_time_off_request: true },
        { id: 2, member_email: "owner2@example.com", notify_email_on_time_off_request: true },
      ],
    });

    const res = await request(makeApp())
      .post("/time-off/requests")
      .send({
        typeCode: "VACATION",
        startDate: "2026-06-01",
        endDate: "2026-06-02",
      });

    expect(res.status).toBe(201);
    expect(mockBroadcast).toHaveBeenCalledWith(1);
    expect(mockBroadcast).toHaveBeenCalledWith(2);
    expect(mockSendTimeOffRequestSubmittedEmail).toHaveBeenCalledTimes(2);
    const recipients = mockSendTimeOffRequestSubmittedEmail.mock.calls.map(
      (c) => (c[0] as { toEmail: string }).toEmail,
    );
    expect(recipients).toEqual(
      expect.arrayContaining(["owner1@example.com", "owner2@example.com"]),
    );

    // 4 selects, 3 inserts (request + 2 notifications), 1 update
    expect(mockDrizzleSelect).toHaveBeenCalledTimes(4);
    expect(mockDrizzleInsert).toHaveBeenCalledTimes(3);
    expect(mockDrizzleUpdate).toHaveBeenCalledTimes(1);
  });

  it("skips notifying the requester even if they are also a workspace owner", async () => {
    // stubMemberDbId is 77 (the requester). Include 77 in the owners list.
    setupCreateMocksNoManager({
      owners: [
        { id: 77, member_email: "self-owner@example.com", notify_email_on_time_off_request: true },
        { id: 2, member_email: "owner2@example.com", notify_email_on_time_off_request: true },
      ],
    });

    const res = await request(makeApp())
      .post("/time-off/requests")
      .send({
        typeCode: "VACATION",
        startDate: "2026-06-01",
        endDate: "2026-06-02",
      });

    expect(res.status).toBe(201);
    expect(mockBroadcast).not.toHaveBeenCalledWith(77);
    expect(mockBroadcast).toHaveBeenCalledWith(2);
    expect(mockSendTimeOffRequestSubmittedEmail).toHaveBeenCalledTimes(1);
    expect(mockSendTimeOffRequestSubmittedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ toEmail: "owner2@example.com" }),
    );

    // 4 selects, 2 inserts (request + 1 notification, requester skipped), 1 update
    expect(mockDrizzleSelect).toHaveBeenCalledTimes(4);
    expect(mockDrizzleInsert).toHaveBeenCalledTimes(2);
    expect(mockDrizzleUpdate).toHaveBeenCalledTimes(1);
  });

  it("auto-approves the request when the requester is the sole workspace owner", async () => {
    // The sole owner (id 77) submits — no manager, no other owner.
    // The route should immediately APPROVE rather than leave it pending forever.
    stubWorkspaceRole = "owner";

    // Queue (8 ops): type, overlap, member, INSERT{id:555}, UPDATE balance++, owners, UPDATE APPROVED, UPDATE balance--
    drizzleQueue.push([{ id: 1, name: "Vacation" }]);
    drizzleQueue.push([]);
    drizzleQueue.push([{
      manager_member_id: null,
      requester_email: "owner@example.com",
      requester_user_id: "user_owner",
      manager_user_id: null,
      manager_email: null,
      manager_notify_email: null,
      working_days: null,
    }]);
    drizzleQueue.push([{ id: 555 }]);
    drizzleQueue.push([]); // UPDATE balance++ placeholder
    drizzleQueue.push([{ id: 77, member_email: "owner@example.com", notify_email_on_time_off_request: true }]);
    // UPDATE APPROVED and UPDATE balance-- pop from empty queue

    const res = await request(makeApp())
      .post("/time-off/requests")
      .send({
        typeCode: "VACATION",
        startDate: "2026-06-01",
        endDate: "2026-06-02",
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      request: { id: 555, status: "APPROVED" },
      autoApproved: true,
    });

    // No in-app notification or email sent to anyone.
    expect(mockBroadcast).not.toHaveBeenCalled();
    expect(mockSendTimeOffRequestSubmittedEmail).not.toHaveBeenCalled();

    // 4 selects, 1 insert (request only, no notifications), 3 updates (balance++ + APPROVED + balance--)
    expect(mockDrizzleSelect).toHaveBeenCalledTimes(4);
    expect(mockDrizzleInsert).toHaveBeenCalledTimes(1);
    expect(mockDrizzleUpdate).toHaveBeenCalledTimes(3);
  });

  it("returns 400 when a half-day request falls on a non-working day", async () => {
    const sunThuSchedule = {
      sunday: true, monday: true, tuesday: true,
      wednesday: true, thursday: true,
      friday: false, saturday: false,
    };

    drizzleQueue.push([{ id: 1, name: "Vacation" }]); // type
    drizzleQueue.push([]);                              // overlap
    drizzleQueue.push([{                               // member
      manager_member_id: null,
      requester_email: "employee@example.com",
      requester_user_id: "user_employee",
      manager_user_id: null,
      manager_email: null,
      manager_notify_email: null,
      working_days: sunThuSchedule,
    }]);

    // 2026-06-05 is a Friday — not a working day on the Sun–Thu schedule.
    const res = await request(makeApp())
      .post("/time-off/requests")
      .send({
        typeCode: "VACATION",
        startDate: "2026-06-05",
        endDate: "2026-06-05",
        halfDay: true,
        halfDayPeriod: "AM",
      });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: "Half-day requests must fall on a working day based on your work schedule.",
    });

    // No INSERT should have been attempted.
    expect(mockDrizzleInsert).not.toHaveBeenCalled();

    // No email or notification should have been sent.
    expect(mockSendTimeOffRequestSubmittedEmail).not.toHaveBeenCalled();
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it("returns 400 when a half-day request falls on a weekend (default Mon–Fri schedule)", async () => {
    drizzleQueue.push([{ id: 1, name: "Vacation" }]); // type
    drizzleQueue.push([]);                              // overlap
    drizzleQueue.push([{                               // member — no custom working_days (defaults to Mon–Fri)
      manager_member_id: null,
      requester_email: "employee@example.com",
      requester_user_id: "user_employee",
      manager_user_id: null,
      manager_email: null,
      manager_notify_email: null,
      working_days: null,
    }]);

    // 2026-06-06 is a Saturday — not a working day on the default Mon–Fri schedule.
    const res = await request(makeApp())
      .post("/time-off/requests")
      .send({
        typeCode: "VACATION",
        startDate: "2026-06-06",
        endDate: "2026-06-06",
        halfDay: true,
        halfDayPeriod: "PM",
      });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: "Half-day requests must fall on a working day based on your work schedule.",
    });

    expect(mockDrizzleInsert).not.toHaveBeenCalled();
  });

  it("returns 400 when the date range contains no working days for the member's schedule", async () => {
    vi.mocked(calculateWorkingDays).mockReturnValueOnce(0);

    const sunThuSchedule = {
      sunday: true, monday: true, tuesday: true,
      wednesday: true, thursday: true,
      friday: false, saturday: false,
    };

    drizzleQueue.push([{ id: 1, name: "Vacation" }]); // type
    drizzleQueue.push([]);                              // overlap
    drizzleQueue.push([{                               // member — Sun–Thu schedule
      manager_member_id: null,
      requester_email: "employee@example.com",
      requester_user_id: "user_employee",
      manager_user_id: null,
      manager_email: null,
      manager_notify_email: null,
      working_days: sunThuSchedule,
    }]);

    const res = await request(makeApp())
      .post("/time-off/requests")
      .send({
        typeCode: "VACATION",
        startDate: "2026-06-05", // Friday
        endDate: "2026-06-06",   // Saturday
      });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: "The selected date range contains no working days based on your work schedule.",
    });

    expect(mockDrizzleInsert).not.toHaveBeenCalled();
    expect(mockSendTimeOffRequestSubmittedEmail).not.toHaveBeenCalled();
    expect(mockBroadcast).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /time-off/notifications/seen-all
// ---------------------------------------------------------------------------

describe("POST /time-off/notifications/seen-all", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    drizzleQueue.length = 0;
    stubWorkspaceOwnerId = "owner_111";
    stubWorkspaceRole = "member";
    stubMemberDbId = 50;
    stubUserEmail = "manager@example.com";
    stubUserId = "user_manager";
  });

  it("marks all unread TIME_OFF_REQUEST notifications for the current manager as read", async () => {
    // returning([{id}]) resolves to an array of 3 rows → updated.length = 3
    drizzleQueue.push([{ id: 1 }, { id: 2 }, { id: 3 }]);

    const res = await request(makeApp()).post("/time-off/notifications/seen-all");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, updated: 3 });

    expect(mockDrizzleUpdate).toHaveBeenCalledTimes(1);
  });

  it("returns 403 when the caller has no member record", async () => {
    stubMemberDbId = null;

    const res = await request(makeApp()).post("/time-off/notifications/seen-all");

    expect(res.status).toBe(403);
    expect(mockDrizzleUpdate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GET /time-off/notifications
// ---------------------------------------------------------------------------

describe("GET /time-off/notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    drizzleQueue.length = 0;
    stubWorkspaceOwnerId = "owner_111";
    stubWorkspaceRole = "member";
    stubMemberDbId = 50;
    stubUserEmail = "manager@example.com";
    stubUserId = "user_manager";
  });

  it("populates actor_name from Clerk and includes actor_email", async () => {
    const { clerkClient } = await import("@clerk/express");
    (clerkClient.users.getUserList as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: [{ id: "user_actor_1", firstName: "Alice", lastName: "Anderson" }],
    });

    drizzleQueue.push([{
      id: 1,
      type: "TIME_OFF_REQUEST",
      title: "New Vacation request",
      body: "Alice Anderson has requested vacation from 2026-06-01 to 2026-06-02.",
      entity_id: 99,
      is_read: false,
      created_at: "2026-05-01T00:00:00.000Z",
      actor_user_id: "user_actor_1",
      actor_email: "alice@example.com",
    }]);

    const res = await request(makeApp()).get("/time-off/notifications");

    expect(res.status).toBe(200);
    expect(res.body.notifications).toHaveLength(1);
    expect(res.body.notifications[0]).toMatchObject({
      id: 1,
      actor_name: "Alice Anderson",
      actor_email: "alice@example.com",
    });
  });

  it("returns actor_name=null and falls back to actor_email when Clerk has no name", async () => {
    const { clerkClient } = await import("@clerk/express");
    (clerkClient.users.getUserList as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: [{ id: "user_actor_2", firstName: null, lastName: null }],
    });

    drizzleQueue.push([{
      id: 2,
      type: "TIME_OFF_REQUEST",
      title: "New Vacation request",
      body: "bob@example.com has requested vacation.",
      entity_id: 100,
      is_read: false,
      created_at: "2026-05-01T00:00:00.000Z",
      actor_user_id: "user_actor_2",
      actor_email: "bob@example.com",
    }]);

    const res = await request(makeApp()).get("/time-off/notifications");

    expect(res.status).toBe(200);
    expect(res.body.notifications[0]).toMatchObject({
      actor_name: null,
      actor_email: "bob@example.com",
    });
  });
});

// ---------------------------------------------------------------------------
// POST /time-off/requests/:id/decline
// ---------------------------------------------------------------------------

describe("POST /time-off/requests/:id/decline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    drizzleQueue.length = 0;
    stubWorkspaceOwnerId = "owner_111";
    stubWorkspaceRole = "member";
    stubMemberDbId = 50;
    stubUserEmail = "manager@example.com";
    stubUserId = "user_manager";
    mockGetOrCreateBalance.mockResolvedValue({ id: 999 });
  });

  function pendingRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 123,
      member_id: 77,
      manager_member_id: 50,
      status: "PENDING",
      type_code: "VACATION",
      type_name: "Vacation",
      total_days: "2.00",
      start_date: "2026-06-01",
      member_email: "employee@example.com",
      ...overrides,
    };
  }

  it("returns 403 when the caller is neither the assigned manager nor an admin", async () => {
    stubWorkspaceRole = "member";
    stubMemberDbId = 1;

    drizzleQueue.push([pendingRow({ manager_member_id: 50 })]);

    const res = await request(makeApp())
      .post("/time-off/requests/123/decline")
      .send({ managerNote: "no" });

    expect(res.status).toBe(403);
    expect(mockBroadcast).not.toHaveBeenCalled();
    expect(mockDrizzleSelect).toHaveBeenCalledTimes(1);
  });

  it("returns 409 when the request is no longer PENDING", async () => {
    drizzleQueue.push([pendingRow({ status: "DECLINED" })]);

    const res = await request(makeApp())
      .post("/time-off/requests/123/decline")
      .send({ managerNote: "no" });

    expect(res.status).toBe(409);
    expect(mockBroadcast).not.toHaveBeenCalled();
    expect(mockDrizzleSelect).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// POST /time-off/requests/:id/cancel
// ---------------------------------------------------------------------------

describe("POST /time-off/requests/:id/cancel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    drizzleQueue.length = 0;
    stubWorkspaceOwnerId = "owner_111";
    stubWorkspaceRole = "member";
    stubMemberDbId = 50;
    stubUserEmail = "employee@example.com";
    stubUserId = "user_employee";
    mockGetOrCreateBalance.mockResolvedValue({ id: 999 });
  });

  function cancelRequestRow(overrides: Partial<{
    id: number;
    member_id: number;
    status: string;
    type_id: number;
    type_code: string;
    type_name: string;
    total_days: string;
    start_date: string;
    end_date: string;
    half_day: boolean;
    half_day_period: "AM" | "PM" | null;
  }> = {}) {
    return {
      id: 123,
      member_id: 50, // same as stubMemberDbId — self-cancellation by default
      status: "PENDING",
      type_id: 1,
      type_code: "OTHER",
      type_name: "Other",
      total_days: "1.00",
      start_date: "2026-09-01",
      end_date: "2026-09-01",
      half_day: false,
      half_day_period: null,
      ...overrides,
    };
  }

  it("marks the manager's unread notification as read when a request is cancelled", async () => {
    // type_code=OTHER, self-cancel → 2 updates: cancel + notifications
    drizzleQueue.push([cancelRequestRow()]);

    const res = await request(makeApp()).post("/time-off/requests/123/cancel").send({});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });

    // 2 drizzle updates: cancel status + notifications mark-read (type=OTHER, no balance)
    expect(mockDrizzleUpdate).toHaveBeenCalledTimes(2);
  });

  it("returns 200 and accepts a cancellation_reason in the body", async () => {
    drizzleQueue.push([cancelRequestRow()]);

    const res = await request(makeApp())
      .post("/time-off/requests/123/cancel")
      .send({ cancellation_reason: "Plans changed" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
  });

  it("still clears the notification even when the cancelled request was APPROVED (future start date)", async () => {
    const futureDate = "2030-01-01";
    drizzleQueue.push([cancelRequestRow({ status: "APPROVED", start_date: futureDate, end_date: futureDate })]);

    const res = await request(makeApp()).post("/time-off/requests/123/cancel").send({});

    expect(res.status).toBe(200);
    // 2 updates: cancel + notifications (type=OTHER, no balance)
    expect(mockDrizzleUpdate).toHaveBeenCalledTimes(2);
  });

  it("returns 403 when the caller has no member record", async () => {
    stubMemberDbId = null;

    const res = await request(makeApp()).post("/time-off/requests/123/cancel").send({});

    expect(res.status).toBe(403);
    expect(mockDrizzleSelect).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-numeric request id", async () => {
    const res = await request(makeApp()).post("/time-off/requests/not-a-number/cancel").send({});

    expect(res.status).toBe(400);
    expect(mockDrizzleSelect).not.toHaveBeenCalled();
  });

  it("returns 404 when the request does not exist in the workspace", async () => {
    // Empty queue → select resolves to [] → 404

    const res = await request(makeApp()).post("/time-off/requests/999/cancel").send({});

    expect(res.status).toBe(404);
  });

  it("returns 403 when a non-owner tries to cancel another member's request", async () => {
    stubWorkspaceRole = "member";
    stubMemberDbId = 50;

    drizzleQueue.push([cancelRequestRow({ member_id: 77 })]);

    const res = await request(makeApp()).post("/time-off/requests/123/cancel").send({});

    expect(res.status).toBe(403);
  });

  it("returns 409 when the request is already in a terminal status", async () => {
    drizzleQueue.push([cancelRequestRow({ status: "CANCELLED" })]);

    const res = await request(makeApp()).post("/time-off/requests/123/cancel").send({});

    expect(res.status).toBe(409);
  });

  it("returns 409 when an APPROVED request has already started", async () => {
    drizzleQueue.push([cancelRequestRow({ status: "APPROVED", start_date: "2020-01-01", end_date: "2020-01-01" })]);

    const res = await request(makeApp()).post("/time-off/requests/123/cancel").send({});

    expect(res.status).toBe(409);
  });

  it("allows a workspace owner to cancel another member's request", async () => {
    stubWorkspaceRole = "owner";
    stubMemberDbId = 1;

    // type=OTHER, owner-cancel → 2 updates + 2 selects (employee + canceller) for email
    drizzleQueue.push([cancelRequestRow({ member_id: 77 })]);
    drizzleQueue.push([]); // UPDATE cancel placeholder
    drizzleQueue.push([]); // UPDATE notifications placeholder
    drizzleQueue.push([{ member_email: "emp@example.com", member_user_id: "user_emp" }]);
    drizzleQueue.push([{ member_email: "owner@example.com", member_user_id: "user_owner" }]);

    const res = await request(makeApp()).post("/time-off/requests/123/cancel").send({});

    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// PATCH /public-holidays/calendars/:id/holidays/:holidayId
// Confirms the server always returns YYYY-MM-DD date strings.
// ---------------------------------------------------------------------------

describe("PATCH /public-holidays/calendars/:id/holidays/:holidayId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    drizzleQueue.length = 0;
    stubWorkspaceOwnerId = "owner_111";
    stubWorkspaceRole = "owner";
    stubMemberDbId = 1;
    stubUserEmail = "owner@example.com";
    stubUserId = "user_owner";
  });

  it("returns YYYY-MM-DD date strings even when the DB returns full ISO timestamps", async () => {
    // Queue: ownership check select, UPDATE placeholder, updated row select
    drizzleQueue.push([{ id: 99 }]);
    drizzleQueue.push([]); // UPDATE placeholder
    drizzleQueue.push([{
      id: 99,
      calendar_id: 5,
      workspace_owner_id: "owner_111",
      name: "New Year",
      date: "2026-01-01",
      end_date: "2026-01-01",
      is_paid: true,
      description: null,
      created_by_member_id: 1,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    }]);

    const res = await request(makeApp())
      .patch("/public-holidays/calendars/5/holidays/99")
      .send({ name: "New Year" });

    expect(res.status).toBe(200);
    expect(res.body.holiday).toMatchObject({
      id: 99,
      date: "2026-01-01",
      end_date: "2026-01-01",
    });

    // 2 selects (ownership check + updated row), 1 update
    expect(mockDrizzleSelect).toHaveBeenCalledTimes(2);
    expect(mockDrizzleUpdate).toHaveBeenCalledTimes(1);
  });

  it("returns 404 when the holiday does not belong to the calendar", async () => {
    // Empty queue → ownership check returns [] → 404

    const res = await request(makeApp())
      .patch("/public-holidays/calendars/5/holidays/999")
      .send({ name: "Ghost Day" });

    expect(res.status).toBe(404);
  });
});
