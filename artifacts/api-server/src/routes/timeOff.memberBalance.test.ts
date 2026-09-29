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

vi.mock("@clerk/express", () => ({
  clerkClient: {
    users: {
      getUserList: vi.fn().mockResolvedValue({ data: [] }),
    },
  },
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn().mockReturnThis() },
}));

let stubMemberDbId: number | null = 1;
let stubWorkspaceRole: "owner" | "member" = "owner";
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
    wreq.userId = "user_viewer";
    wreq.userEmail = "viewer@example.com";
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
  id: 42,
  member_id: 20,
  policy_id: 5,
  policy_year: 2026,
  vacation_entitled: "15.00",
  vacation_used: "4.00",
  vacation_pending: "2.50",
  vacation_carryover: "0.00",
  sick_leave_entitled: "10.00",
  sick_leave_used: "1.00",
  sick_leave_pending: "0.00",
};

// ---------------------------------------------------------------------------
// GET /time-off/members/:memberId/balance
// ---------------------------------------------------------------------------

describe("GET /time-off/members/:memberId/balance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    drizzleQueue.length = 0;
    stubMemberDbId = 1;
    stubWorkspaceRole = "owner";
    stubWorkspaceOwnerId = "ws_owner";
    mockGetOrCreateBalance.mockResolvedValue(BALANCE_ROW);
  });

  it("returns 200 with balance data when called by workspace owner", async () => {
    // owner path: memberCheck → getOrCreateBalance
    drizzleQueue.push([{ id: 20 }]);

    const res = await request(makeApp()).get("/time-off/members/20/balance");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      balance: {
        vacation_entitled: "15.00",
        vacation_used: "4.00",
        vacation_pending: "2.50",
        vacation_remaining: 8.5,
        manager_name: null,
      },
    });
    expect(mockGetOrCreateBalance).toHaveBeenCalledWith(
      expect.anything(),
      20,
      "ws_owner",
      expect.any(Number),
    );
  });

  it("returns 200 when the caller is the member's assigned manager (non-owner)", async () => {
    stubWorkspaceRole = "member";
    stubMemberDbId = 7; // manager's id

    // managerCheck: target member's manager_member_id = 7 (matches viewer)
    drizzleQueue.push([{ manager_member_id: 7 }]);
    // memberCheck: member exists
    drizzleQueue.push([{ id: 20 }]);

    const res = await request(makeApp()).get("/time-off/members/20/balance");

    expect(res.status).toBe(200);
    expect(res.body.balance).not.toBeNull();
  });

  it("returns 403 when caller is a non-owner who is not the assigned manager", async () => {
    stubWorkspaceRole = "member";
    stubMemberDbId = 7; // viewer

    // managerCheck: target member's manager_member_id = 99 (not the viewer)
    drizzleQueue.push([{ manager_member_id: 99 }]);

    const res = await request(makeApp()).get("/time-off/members/20/balance");

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/insufficient permissions/i);
  });

  it("returns 403 when the viewer has no member record (memberDbId is null)", async () => {
    stubMemberDbId = null;

    const res = await request(makeApp()).get("/time-off/members/20/balance");

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/member record not found/i);
  });

  it("returns 400 when memberId is not a valid integer", async () => {
    const res = await request(makeApp()).get("/time-off/members/abc/balance");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid member id/i);
  });

  it("returns 404 when the target member does not belong to the workspace", async () => {
    // owner path, but memberCheck returns no rows
    drizzleQueue.push([]);

    const res = await request(makeApp()).get("/time-off/members/999/balance");

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/member not found/i);
  });

  it("returns balance: null when no time-off policy is assigned", async () => {
    // memberCheck passes
    drizzleQueue.push([{ id: 20 }]);
    // getOrCreateBalance throws the known "no active time-off policy" error
    mockGetOrCreateBalance.mockRejectedValueOnce(
      new Error("no active time-off policy assigned"),
    );

    const res = await request(makeApp()).get("/time-off/members/20/balance");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      balance: null,
      message: "No time-off policy assigned",
    });
  });
});
