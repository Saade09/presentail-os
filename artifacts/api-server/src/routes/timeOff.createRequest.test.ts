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
const mockCalculateWorkingDays = vi.fn();
vi.mock("../lib/timeOffBalances", () => ({
  getOrCreateBalance: (...args: unknown[]) => mockGetOrCreateBalance(...args),
  calculateWorkingDays: (...args: unknown[]) => mockCalculateWorkingDays(...args),
  computeVacationRemaining: vi.fn().mockReturnValue(8.5),
}));

vi.mock("../lib/timeOffSse", () => ({
  subscribe: vi.fn(),
  broadcast: vi.fn(),
}));

const mockSendTimeOffRequestSubmittedEmail = vi.fn().mockResolvedValue(undefined);
const mockSendTimeOffRequestConfirmationEmail = vi.fn().mockResolvedValue(undefined);

vi.mock("../lib/email", () => ({
  sendTimeOffDecisionEmail: vi.fn().mockResolvedValue(undefined),
  sendTimeOffRequestSubmittedEmail: (...args: unknown[]) =>
    mockSendTimeOffRequestSubmittedEmail(...args),
  sendTimeOffRequestConfirmationEmail: (...args: unknown[]) =>
    mockSendTimeOffRequestConfirmationEmail(...args),
  sendAnnualLeavePolicyAssignedEmail: vi.fn().mockResolvedValue(undefined),
  sendTimeOffCancelledEmail: vi.fn().mockResolvedValue(undefined),
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
    wreq.userId = "user_req";
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
  vacation_pending: "1.50",
  vacation_carryover: "0.00",
  sick_leave_entitled: "10.00",
  sick_leave_used: "0.00",
  sick_leave_pending: "0.00",
};

const VALID_BODY = {
  typeCode: "VACATION",
  startDate: "2026-06-10",
  endDate: "2026-06-12",
};

const MEMBER_ROW_WITH_MANAGER = {
  manager_member_id: 7,
  requester_email: "req@example.com",
  requester_user_id: "user_req",
  manager_user_id: "user_mgr",
  manager_email: "mgr@example.com",
  manager_notify_email: true,
  working_days: null,
};

const MEMBER_ROW_NO_MANAGER = {
  manager_member_id: null,
  requester_email: "req@example.com",
  requester_user_id: "user_req",
  manager_user_id: null,
  manager_email: null,
  manager_notify_email: null,
  working_days: null,
};

// ---------------------------------------------------------------------------
// POST /time-off/requests
// ---------------------------------------------------------------------------

describe("POST /time-off/requests", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    drizzleQueue.length = 0;
    stubMemberDbId = 1;
    stubWorkspaceRole = "member";
    stubWorkspaceOwnerId = "ws_owner";
    mockGetOrCreateBalance.mockResolvedValue(BALANCE_ROW);
    mockCalculateWorkingDays.mockReturnValue(1);
    mockGetUserList.mockResolvedValue({ data: [] });
    mockSendTimeOffRequestSubmittedEmail.mockResolvedValue(undefined);
    mockSendTimeOffRequestConfirmationEmail.mockResolvedValue(undefined);
  });

  // ----------------------------------------------------------
  // 403 — memberDbId is null
  // ----------------------------------------------------------

  it("returns 403 when memberDbId is null (member record not found)", async () => {
    stubMemberDbId = null;

    const res = await request(makeApp())
      .post("/time-off/requests")
      .send(VALID_BODY);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/member record not found/i);
    expect(mockDrizzleSelect).not.toHaveBeenCalled();
  });

  // ----------------------------------------------------------
  // 400 — validation failures
  // ----------------------------------------------------------

  it("returns 400 when required fields are missing from the body", async () => {
    const res = await request(makeApp())
      .post("/time-off/requests")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/validation failed/i);
    expect(mockDrizzleSelect).not.toHaveBeenCalled();
  });

  it("returns 400 when typeCode is not an accepted value", async () => {
    const res = await request(makeApp())
      .post("/time-off/requests")
      .send({ ...VALID_BODY, typeCode: "PERSONAL_DAY" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/validation failed/i);
  });

  it("returns 400 when startDate does not match the YYYY-MM-DD pattern", async () => {
    const res = await request(makeApp())
      .post("/time-off/requests")
      .send({ ...VALID_BODY, startDate: "10-06-2026" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/validation failed/i);
  });

  it("returns 400 when startDate is after endDate", async () => {
    const res = await request(makeApp())
      .post("/time-off/requests")
      .send({ ...VALID_BODY, startDate: "2026-06-15", endDate: "2026-06-10" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/startDate must be on or before endDate/i);
  });

  // ----------------------------------------------------------
  // Successful submission — manager assigned
  //
  // Queue order (manager-assigned path, 6 drizzle ops):
  //   1. type SELECT
  //   2. overlap SELECT  → push []
  //   3. member SELECT
  //   4. INSERT request returning [{id}]
  //   5. UPDATE balance  → pops from empty
  //   6. INSERT notification → pops from empty
  // ----------------------------------------------------------

  it("returns 201 PENDING with autoApproved false when a manager is assigned", async () => {
    drizzleQueue.push([{ id: 3, name: "Vacation" }]); // 1: type
    drizzleQueue.push([]);                              // 2: overlap (none)
    drizzleQueue.push([MEMBER_ROW_WITH_MANAGER]);       // 3: member
    drizzleQueue.push([{ id: 101 }]);                   // 4: INSERT returning

    mockGetOrCreateBalance.mockResolvedValueOnce(BALANCE_ROW);

    mockGetUserList.mockResolvedValueOnce({
      data: [{ id: "user_req", firstName: "Alice", lastName: "Requester", hasImage: false, imageUrl: "" }],
    });
    mockGetUserList.mockResolvedValueOnce({
      data: [{ id: "user_req", firstName: "Alice", lastName: "Requester", hasImage: false, imageUrl: "" }],
    });

    const res = await request(makeApp())
      .post("/time-off/requests")
      .send(VALID_BODY);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      request: { id: 101, status: "PENDING", totalDays: 1 },
      autoApproved: false,
    });

    expect(mockSendTimeOffRequestSubmittedEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        toEmail: "mgr@example.com",
        typeName: "Vacation",
        startDate: "2026-06-10",
        endDate: "2026-06-12",
        requesterName: "Alice Requester",
      }),
    );

    expect(mockGetUserList).toHaveBeenCalledWith(
      expect.objectContaining({ userId: expect.arrayContaining(["user_req"]) }),
    );

    expect(mockSendTimeOffRequestConfirmationEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        toEmail: "req@example.com",
        typeName: "Vacation",
      }),
    );
  });

  // ----------------------------------------------------------
  // Successful submission — no manager assigned, notifies owners
  //
  // Queue order (no-manager path, 7 drizzle ops):
  //   1. type SELECT
  //   2. overlap SELECT   → push []
  //   3. member SELECT
  //   4. INSERT request returning [{id}]
  //   5. UPDATE balance   → push [] placeholder
  //   6. owners SELECT
  //   7. INSERT notification → pops from empty
  // ----------------------------------------------------------

  it("returns 201 and notifies workspace owners when no manager is assigned", async () => {
    drizzleQueue.push([{ id: 3, name: "Vacation" }]); // 1: type
    drizzleQueue.push([]);                              // 2: overlap (none)
    drizzleQueue.push([MEMBER_ROW_NO_MANAGER]);         // 3: member
    drizzleQueue.push([{ id: 102 }]);                   // 4: INSERT returning
    drizzleQueue.push([]);                              // 5: UPDATE balance placeholder
    drizzleQueue.push([{ id: 5, member_email: "owner@example.com", notify_email_on_time_off_request: true }]); // 6: owners

    mockGetOrCreateBalance.mockResolvedValueOnce(BALANCE_ROW);
    mockGetUserList.mockResolvedValue({ data: [] });

    const res = await request(makeApp())
      .post("/time-off/requests")
      .send(VALID_BODY);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      request: { id: 102, status: "PENDING", totalDays: 1 },
      autoApproved: false,
    });

    expect(mockSendTimeOffRequestSubmittedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ toEmail: "owner@example.com" }),
    );

    expect(mockSendTimeOffRequestConfirmationEmail).toHaveBeenCalledWith(
      expect.objectContaining({ toEmail: "req@example.com" }),
    );
  });

  // ----------------------------------------------------------
  // "No active time-off policy" — balance update is non-fatal
  // ----------------------------------------------------------

  it("returns 201 even when getOrCreateBalance throws 'no active time-off policy'", async () => {
    drizzleQueue.push([{ id: 3, name: "Vacation" }]); // 1: type
    drizzleQueue.push([]);                              // 2: overlap
    drizzleQueue.push([MEMBER_ROW_WITH_MANAGER]);       // 3: member
    drizzleQueue.push([{ id: 103 }]);                   // 4: INSERT returning

    mockGetOrCreateBalance.mockRejectedValueOnce(
      new Error("no active time-off policy assigned"),
    );
    mockGetUserList.mockResolvedValue({ data: [] });

    const res = await request(makeApp())
      .post("/time-off/requests")
      .send(VALID_BODY);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      request: { id: 103, status: "PENDING" },
      autoApproved: false,
    });
  });
});
