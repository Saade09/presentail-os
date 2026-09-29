import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

// ---------------------------------------------------------------------------
// Drizzle queue mock
// ---------------------------------------------------------------------------

const drizzleQueue: unknown[][] = [];

function popResult(): unknown[] {
  return (drizzleQueue.shift() as unknown[]) ?? [];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeChain(result: unknown[]): any {
  const p = Promise.resolve(result);
  const chain: Record<string, unknown> = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    offset: () => chain,
    innerJoin: () => chain,
    leftJoin: () => chain,
    set: () => chain,
    values: () => chain,
    returning: () => p,
    onConflictDoUpdate: () => p,
    then: (f: Parameters<typeof p.then>[0], r: Parameters<typeof p.then>[1]) => p.then(f, r),
    catch: (f: Parameters<typeof p.catch>[0]) => p.catch(f),
    finally: (f: Parameters<typeof p.finally>[0]) => p.finally(f),
  };
  return chain;
}

const mockDrizzleSelect = vi.fn(() => makeChain(popResult()));
const mockDrizzleInsert = vi.fn(() => makeChain(popResult()));
const mockDrizzleUpdate = vi.fn(() => makeChain(popResult()));
const mockDrizzleDelete = vi.fn(() => ({ where: () => Promise.resolve() }));

vi.mock("../lib/drizzle", () => ({
  drizzleDb: {
    select: () => mockDrizzleSelect(),
    insert: () => mockDrizzleInsert(),
    update: () => mockDrizzleUpdate(),
    delete: () => mockDrizzleDelete(),
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

vi.mock("../lib/email", () => ({
  sendTimeOffDecisionEmail: vi.fn().mockResolvedValue(undefined),
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

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = stubWorkspaceOwnerId;
    wreq.workspaceRole = "member";
    wreq.workspaceActualRole = "member";
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

// ---------------------------------------------------------------------------
// GET /time-off/balance
// ---------------------------------------------------------------------------

describe("GET /time-off/balance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    drizzleQueue.length = 0;
    stubMemberDbId = 1;
    stubWorkspaceOwnerId = "ws_owner";
    mockGetOrCreateBalance.mockResolvedValue(BALANCE_ROW);
    mockGetUserList.mockResolvedValue({ data: [] });
  });

  it("returns 200 with balance data and manager name when a manager is assigned", async () => {
    drizzleQueue.push([{ manager_user_id: "user_mgr", manager_email: "mgr@example.com" }]);
    mockGetUserList.mockResolvedValueOnce({
      data: [
        {
          id: "user_mgr",
          firstName: "Alice",
          lastName: "Smith",
          hasImage: false,
          imageUrl: "",
        },
      ],
    });

    const res = await request(makeApp()).get("/time-off/balance");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      balance: {
        vacation_entitled: "15.00",
        vacation_used: "3.00",
        vacation_pending: "1.50",
        vacation_remaining: 8.5,
        manager_name: "Alice Smith",
      },
    });
    expect(mockGetOrCreateBalance).toHaveBeenCalledWith(
      expect.anything(),
      1,
      "ws_owner",
      expect.any(Number),
    );
    expect(mockGetUserList).toHaveBeenCalledWith({
      userId: ["user_mgr"],
      limit: 100,
    });
  });

  it("returns 200 with manager_name null when no manager is assigned", async () => {
    drizzleQueue.push([{ manager_user_id: null, manager_email: null }]);

    const res = await request(makeApp()).get("/time-off/balance");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      balance: {
        vacation_remaining: 8.5,
        manager_name: null,
      },
    });
    expect(mockGetUserList).not.toHaveBeenCalled();
  });

  it("returns balance: null and a message when no time-off policy is assigned", async () => {
    mockGetOrCreateBalance.mockRejectedValueOnce(
      new Error("no active time-off policy assigned"),
    );

    const res = await request(makeApp()).get("/time-off/balance");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      balance: null,
      message: "No time-off policy assigned",
    });
  });

  it("returns 403 when memberDbId is null (member record not found)", async () => {
    stubMemberDbId = null;

    const res = await request(makeApp()).get("/time-off/balance");

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/member record not found/i);
    expect(mockGetOrCreateBalance).not.toHaveBeenCalled();
  });
});
