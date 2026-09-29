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

let stubMemberDbId: number | null = 5;
let stubWorkspaceRole: "owner" | "member" = "member";

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
    wreq.workspaceOwnerId = "ws_owner_1";
    wreq.workspaceRole = stubWorkspaceRole;
    wreq.workspaceActualRole = stubWorkspaceRole;
    wreq.memberDbId = stubMemberDbId;
    wreq.userId = "user_caller";
    wreq.userEmail = "caller@example.com";
    wreq.allowedPages = undefined;
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
    (
      req as unknown as {
        log: {
          error: (...a: unknown[]) => void;
          warn: (...a: unknown[]) => void;
          info: (...a: unknown[]) => void;
        };
      }
    ).log = {
      error: () => {},
      warn: () => {},
      info: () => {},
    };
    next();
  });
  app.use(timeOffRouter);
  return app;
}

function makeBalanceRow(overrides: Record<string, unknown> = {}) {
  return {
    member_id: 10,
    member_user_id: "user_emp",
    member_email: "emp@example.com",
    policy_year: 2026,
    vacation_entitled: "15.00",
    vacation_used: "4.00",
    vacation_pending: "2.00",
    vacation_carryover: "0.00",
    sick_leave_entitled: "10.00",
    sick_leave_used: "1.00",
    sick_leave_pending: "0.00",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  drizzleQueue.length = 0;
  mockGetUserList.mockResolvedValue({ data: [] });
  stubMemberDbId = 5;
  stubWorkspaceRole = "member";
});

describe("GET /time-off/team/balances", () => {
  it("returns 403 when memberDbId is null (no member record)", async () => {
    stubMemberDbId = null;

    const res = await request(makeApp()).get("/time-off/team/balances");

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/member record not found/i);
  });

  it("returns 200 with an empty balances array when the manager has no direct reports", async () => {
    // Empty queue → popResult returns [] → drizzle select resolves to []
    const res = await request(makeApp()).get("/time-off/team/balances");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ balances: [] });
    expect(mockDrizzleSelect).toHaveBeenCalledTimes(1);
  });

  it("non-owner (manager) call returns 200 and makes exactly one drizzle select", async () => {
    stubWorkspaceRole = "member";

    const res = await request(makeApp()).get("/time-off/team/balances");

    expect(res.status).toBe(200);
    expect(mockDrizzleSelect).toHaveBeenCalledTimes(1);
  });

  it("owner call with ?all=true returns 200 and makes exactly one drizzle select", async () => {
    stubWorkspaceRole = "owner";

    const res = await request(makeApp()).get("/time-off/team/balances?all=true");

    expect(res.status).toBe(200);
    expect(mockDrizzleSelect).toHaveBeenCalledTimes(1);
  });

  it("returns correct balance fields for a direct report with a policy", async () => {
    drizzleQueue.push([makeBalanceRow()]);
    mockGetUserList.mockResolvedValueOnce({
      data: [{ id: "user_emp", firstName: "Jane", lastName: "Doe", hasImage: false, imageUrl: "" }],
    });

    const res = await request(makeApp()).get("/time-off/team/balances");

    expect(res.status).toBe(200);
    const balance = res.body.balances[0];
    expect(balance.member_id).toBe(10);
    expect(balance.member_email).toBe("emp@example.com");
    expect(balance.member_name).toBe("Jane Doe");
    expect(balance.has_policy).toBe(true);
    expect(balance.policy_year).toBe(2026);
    expect(balance.vacation_entitled).toBe(15);
    expect(balance.vacation_used).toBe(4);
    expect(balance.vacation_pending).toBe(2);
    expect(balance.vacation_carryover).toBe(0);
    expect(balance.vacation_remaining).toBeCloseTo(9);
    expect(balance.sick_leave_entitled).toBe(10);
    expect(balance.sick_leave_used).toBe(1);
    expect(balance.sick_leave_pending).toBe(0);
  });

  it("sets has_policy=false and null balance fields for a member with no policy", async () => {
    drizzleQueue.push([
      makeBalanceRow({
        policy_year: null,
        vacation_entitled: null,
        vacation_used: null,
        vacation_pending: null,
        vacation_carryover: null,
        sick_leave_entitled: null,
        sick_leave_used: null,
        sick_leave_pending: null,
      }),
    ]);
    mockGetUserList.mockResolvedValueOnce({ data: [] });

    const res = await request(makeApp()).get("/time-off/team/balances");

    expect(res.status).toBe(200);
    const balance = res.body.balances[0];
    expect(balance.has_policy).toBe(false);
    expect(balance.policy_year).toBeNull();
    expect(balance.vacation_entitled).toBeNull();
    expect(balance.vacation_remaining).toBeNull();
    expect(balance.sick_leave_entitled).toBeNull();
  });

  it("falls back to email as member_name when Clerk returns no profile", async () => {
    drizzleQueue.push([makeBalanceRow({ member_user_id: "user_unknown" })]);
    mockGetUserList.mockResolvedValueOnce({ data: [] });

    const res = await request(makeApp()).get("/time-off/team/balances");

    expect(res.status).toBe(200);
    expect(res.body.balances[0].member_name).toBe("emp@example.com");
  });

  it("owner sees multiple direct reports across the team", async () => {
    stubWorkspaceRole = "owner";
    drizzleQueue.push([
      makeBalanceRow({ member_id: 10, member_email: "alice@example.com", member_user_id: "user_a" }),
      makeBalanceRow({ member_id: 11, member_email: "bob@example.com", member_user_id: "user_b" }),
    ]);
    mockGetUserList.mockResolvedValueOnce({ data: [] });

    const res = await request(makeApp()).get("/time-off/team/balances");

    expect(res.status).toBe(200);
    expect(res.body.balances).toHaveLength(2);
    expect(res.body.balances[0].member_id).toBe(10);
    expect(res.body.balances[1].member_id).toBe(11);
  });

  it("vacation_remaining accounts for carryover: entitled + carryover - used - pending", async () => {
    drizzleQueue.push([
      makeBalanceRow({
        vacation_entitled: "20.00",
        vacation_carryover: "5.00",
        vacation_used: "6.00",
        vacation_pending: "3.00",
      }),
    ]);
    mockGetUserList.mockResolvedValueOnce({ data: [] });

    const res = await request(makeApp()).get("/time-off/team/balances");

    expect(res.status).toBe(200);
    expect(res.body.balances[0].vacation_remaining).toBeCloseTo(16);
  });
});
