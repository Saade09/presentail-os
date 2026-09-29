import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

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

vi.mock("../lib/timeOffBalances", () => ({
  getOrCreateBalance: vi.fn().mockResolvedValue({ id: 99 }),
  calculateWorkingDays: vi.fn().mockReturnValue(1),
  computeVacationRemaining: vi.fn().mockReturnValue(10),
}));

vi.mock("../lib/timeOffSse", () => ({
  subscribe: vi.fn(),
  broadcast: vi.fn(),
}));

const mockSendTimeOffDecisionEmail = vi.fn().mockResolvedValue(undefined);
vi.mock("../lib/email", () => ({
  sendTimeOffDecisionEmail: (...args: unknown[]) => mockSendTimeOffDecisionEmail(...args),
  sendTimeOffRequestSubmittedEmail: vi.fn().mockResolvedValue(undefined),
  sendTimeOffRequestConfirmationEmail: vi.fn().mockResolvedValue(undefined),
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

let stubMemberDbId: number | null = 5;
let stubWorkspaceRole: "owner" | "member" = "member";
let stubAllowedPages: string[] | undefined = undefined;

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    const wreq = req as unknown as {
      workspaceOwnerId: string;
      workspaceRole: string;
      workspaceActualRole: string;
      memberDbId: number | null;
      userId: string;
      userEmail: string;
      allowedPages: string[] | undefined;
    };
    wreq.workspaceOwnerId = "ws_owner";
    wreq.workspaceRole = stubWorkspaceRole;
    wreq.workspaceActualRole = stubWorkspaceRole;
    wreq.memberDbId = stubMemberDbId;
    wreq.userId = "user_caller";
    wreq.userEmail = "caller@example.com";
    wreq.allowedPages = stubAllowedPages;
    next();
  },
  workspace: (req: express.Request) => req,
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import timeOffRouter from "./timeOff";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: { error: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; info: (...a: unknown[]) => void } }).log = {
      error: () => {},
      warn: () => {},
      info: () => {},
    };
    next();
  });
  app.use(timeOffRouter);
  return app;
}

const PENDING_ROW = (overrides: Record<string, unknown> = {}) => ({
  id: 7,
  member_id: 10,
  manager_member_id: 5,
  status: "PENDING",
  type_code: "VACATION",
  type_name: "Vacation",
  total_days: "1.0",
  start_date: "2026-06-01",
  end_date: "2026-06-01",
  half_day: false,
  half_day_period: null,
  member_email: "employee@example.com",
  member_user_id: "user_emp",
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  drizzleQueue.length = 0;
  mockGetUserList.mockResolvedValue({ data: [] });
  mockSendTimeOffDecisionEmail.mockResolvedValue(undefined);
  stubMemberDbId = 5;
  stubWorkspaceRole = "member";
  stubAllowedPages = undefined;
});

describe("POST /time-off/requests/:id/approve", () => {
  it("returns 403 when caller is neither the assigned manager nor an admin", async () => {
    drizzleQueue.push([PENDING_ROW({ manager_member_id: 99 })]);

    const res = await request(makeApp())
      .post("/time-off/requests/7/approve")
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not authorized/i);
  });

  it("returns 409 when the request is not PENDING (already APPROVED)", async () => {
    drizzleQueue.push([PENDING_ROW({ status: "APPROVED" })]);

    const res = await request(makeApp())
      .post("/time-off/requests/7/approve")
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/PENDING/);
  });

  it("returns 409 when the request is already DECLINED", async () => {
    drizzleQueue.push([PENDING_ROW({ status: "DECLINED" })]);

    const res = await request(makeApp())
      .post("/time-off/requests/7/approve")
      .send({});

    expect(res.status).toBe(409);
  });

  it("returns 404 when the request does not exist", async () => {
    // empty queue → popResult returns [] → drizzleDb.select resolves to [] → tor is undefined → 404

    const res = await request(makeApp())
      .post("/time-off/requests/999/approve")
      .send({});

    expect(res.status).toBe(404);
  });

  it("returns 200 when caller is the assigned manager", async () => {
    drizzleQueue.push([PENDING_ROW({ manager_member_id: 5 })]);

    const res = await request(makeApp())
      .post("/time-off/requests/7/approve")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("returns 200 when caller is the workspace owner (not the direct manager)", async () => {
    stubWorkspaceRole = "owner";
    drizzleQueue.push([PENDING_ROW({ manager_member_id: 99 })]);

    const res = await request(makeApp())
      .post("/time-off/requests/7/approve")
      .send({});

    expect(res.status).toBe(200);
  });

  it("returns 200 when caller has the time-off.manage permission", async () => {
    stubAllowedPages = ["time-off.manage"];
    drizzleQueue.push([PENDING_ROW({ manager_member_id: 99 })]);

    const res = await request(makeApp())
      .post("/time-off/requests/7/approve")
      .send({});

    expect(res.status).toBe(200);
  });

  it("calls sendTimeOffDecisionEmail with status APPROVED on successful approval", async () => {
    drizzleQueue.push([PENDING_ROW({ manager_member_id: 5 })]);

    const res = await request(makeApp())
      .post("/time-off/requests/7/approve")
      .send({});

    expect(res.status).toBe(200);
    expect(mockSendTimeOffDecisionEmail).toHaveBeenCalledOnce();
    expect(mockSendTimeOffDecisionEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        toEmail: "employee@example.com",
        status: "APPROVED",
        typeName: "Vacation",
        startDate: "2026-06-01",
        endDate: "2026-06-01",
      }),
    );
  });

  it("does not call sendTimeOffDecisionEmail when memberDbId is null (returns 403)", async () => {
    stubMemberDbId = null;

    const res = await request(makeApp())
      .post("/time-off/requests/7/approve")
      .send({});

    expect(res.status).toBe(403);
    expect(mockSendTimeOffDecisionEmail).not.toHaveBeenCalled();
  });

  it("on approve of a VACATION request, issues balance bookkeeping and in-app notification", async () => {
    drizzleQueue.push([
      PENDING_ROW({
        manager_member_id: 5,
        type_code: "VACATION",
        total_days: "3.0",
      }),
    ]);

    const res = await request(makeApp())
      .post("/time-off/requests/7/approve")
      .send({});

    expect(res.status).toBe(200);

    // 1 drizzle update for request status + 1 drizzle update for balance
    expect(mockDrizzleUpdate).toHaveBeenCalledTimes(2);
    // 1 drizzle insert for in-app notification
    expect(mockDrizzleInsert).toHaveBeenCalledTimes(1);
  });
});

describe("POST /time-off/requests/:id/decline", () => {
  it("returns 403 when caller is neither the assigned manager nor an admin", async () => {
    drizzleQueue.push([PENDING_ROW({ manager_member_id: 99 })]);

    const res = await request(makeApp())
      .post("/time-off/requests/7/decline")
      .send({ managerNote: "no" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not authorized/i);
  });

  it("returns 409 when the request is not PENDING", async () => {
    drizzleQueue.push([PENDING_ROW({ status: "APPROVED" })]);

    const res = await request(makeApp())
      .post("/time-off/requests/7/decline")
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/PENDING/);
  });

  it("returns 200 when the assigned manager declines a pending request", async () => {
    drizzleQueue.push([PENDING_ROW({ manager_member_id: 5 })]);

    const res = await request(makeApp())
      .post("/time-off/requests/7/decline")
      .send({ managerNote: "Capacity issue" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("returns 200 for an owner declining someone else's request", async () => {
    stubWorkspaceRole = "owner";
    drizzleQueue.push([PENDING_ROW({ manager_member_id: 99 })]);

    const res = await request(makeApp())
      .post("/time-off/requests/7/decline")
      .send({});

    expect(res.status).toBe(200);
  });

  it("returns 404 when the request does not exist", async () => {
    // empty queue → 404

    const res = await request(makeApp())
      .post("/time-off/requests/999/decline")
      .send({});

    expect(res.status).toBe(404);
    expect(mockSendTimeOffDecisionEmail).not.toHaveBeenCalled();
  });

  it("returns 403 when memberDbId is null (member record not found)", async () => {
    stubMemberDbId = null;

    const res = await request(makeApp())
      .post("/time-off/requests/7/decline")
      .send({});

    expect(res.status).toBe(403);
    expect(mockSendTimeOffDecisionEmail).not.toHaveBeenCalled();
  });

  it("calls sendTimeOffDecisionEmail with status DECLINED on successful decline", async () => {
    drizzleQueue.push([PENDING_ROW({ manager_member_id: 5 })]);

    const res = await request(makeApp())
      .post("/time-off/requests/7/decline")
      .send({ managerNote: "Capacity issue" });

    expect(res.status).toBe(200);
    expect(mockSendTimeOffDecisionEmail).toHaveBeenCalledOnce();
    expect(mockSendTimeOffDecisionEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        toEmail: "employee@example.com",
        status: "DECLINED",
        typeName: "Vacation",
        startDate: "2026-06-01",
        endDate: "2026-06-01",
        managerNote: "Capacity issue",
      }),
    );
  });

  it("on decline of a VACATION request, issues balance update and in-app notification", async () => {
    drizzleQueue.push([
      PENDING_ROW({
        manager_member_id: 5,
        type_code: "VACATION",
        total_days: "3.0",
      }),
    ]);

    const res = await request(makeApp())
      .post("/time-off/requests/7/decline")
      .send({ managerNote: "Capacity issue" });

    expect(res.status).toBe(200);

    // 1 drizzle update for request status (DECLINED) + 1 drizzle update for balance (pending decrement)
    expect(mockDrizzleUpdate).toHaveBeenCalledTimes(2);
    // 1 drizzle insert for in-app notification
    expect(mockDrizzleInsert).toHaveBeenCalledTimes(1);
  });
});
