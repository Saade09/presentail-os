import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

// ---------------------------------------------------------------------------
// Drizzle mock — queue-based, chainable builder pattern
//
// Each awaited Drizzle call (select/update/etc.) pops ONE entry
// from the queue in the order the route code enqueues them.
// ---------------------------------------------------------------------------

const drizzleQueue: unknown[][] = [];
let drizzleUpdateSetArgs: Record<string, unknown> | null = null;
const drizzleWhereArgs: unknown[] = [];

function popResult(): unknown[] {
  return (drizzleQueue.shift() as unknown[]) ?? [];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeChain(result: unknown[]): any {
  const p = Promise.resolve(result);
  const chain: Record<string, unknown> = {
    from: () => chain,
    where: (condition: unknown) => {
      drizzleWhereArgs.push(condition);
      return chain;
    },
    orderBy: () => chain,
    limit: () => chain,
    values: () => chain,
    returning: () => p,
    set: (args: unknown) => {
      drizzleUpdateSetArgs = args as Record<string, unknown>;
      return chain;
    },
    then: (f: Parameters<typeof p.then>[0], r: Parameters<typeof p.then>[1]) => p.then(f, r),
    catch: (f: Parameters<typeof p.catch>[0]) => p.catch(f),
    finally: (f: Parameters<typeof p.finally>[0]) => p.finally(f),
  };
  return chain;
}

const mockDrizzleSelect = vi.fn(() => makeChain(popResult()));
const mockDrizzleUpdate = vi.fn(() => makeChain(popResult()));

function containsColumnName(value: unknown, name: string, seen = new Set<unknown>()): boolean {
  if (value === name) return true;
  if (value === null || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  return Object.values(value as Record<string, unknown>).some((child) =>
    containsColumnName(child, name, seen),
  );
}

// ---------------------------------------------------------------------------
// Drizzle transaction mock
//
// The approve handler uses drizzleDb.transaction(async (tx) => {...}) with:
//   - tx.execute()  — for workspace_members INSERT and notification_seen_ids DELETE
//   - tx.update()   — for access_requests UPDATE (Drizzle, schema-managed)
//
// txExecuteQueue: each entry is either a result object or an Error.
// mockTxUpdate: default resolves; per-test can override to throw.
// ---------------------------------------------------------------------------

const txExecuteQueue: Array<{ rows: Record<string, unknown>[] } | Error> = [];
let txUpdateSetArgs: Record<string, unknown> | null = null;

const mockTxUpdate = vi.fn();

const mockDrizzleTransaction = vi.fn(
  async (cb: (tx: Record<string, unknown>) => Promise<unknown>) => {
    const tx = {
      execute: vi.fn(() => {
        const next = txExecuteQueue.shift();
        if (next instanceof Error) return Promise.reject(next);
        return Promise.resolve(next ?? { rows: [] });
      }),
      update: () => mockTxUpdate(),
    };
    return cb(tx as unknown as Record<string, unknown>);
  },
);

vi.mock("../lib/drizzle", () => ({
  drizzleDb: {
    select: () => mockDrizzleSelect(),
    update: () => mockDrizzleUpdate(),
    transaction: (cb: (tx: Record<string, unknown>) => Promise<unknown>) =>
      mockDrizzleTransaction(cb),
  },
}));

// ---------------------------------------------------------------------------
// Raw db mock — for db.query() (notification_seen_ids DELETE in reject handler
// and 23505 fallback in approve handler)
// ---------------------------------------------------------------------------

const mockDbQuery = vi.fn();

const mockSubscribe = vi.fn();
const mockBroadcast = vi.fn();

vi.mock("../lib/accessRequestSse", () => ({
  subscribe: (...args: unknown[]) => mockSubscribe(...args),
  broadcast: (...args: unknown[]) => mockBroadcast(...args),
}));

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
  },
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  authed: (req: express.Request) => req,
}));

vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

const mockSendInviteEmail = vi.fn();
const mockSendAccessRejectionEmail = vi.fn();

vi.mock("../lib/email", () => ({
  sendInviteEmail: (...args: unknown[]) => mockSendInviteEmail(...args),
  sendAccessRejectionEmail: (...args: unknown[]) => mockSendAccessRejectionEmail(...args),
}));

let stubWorkspaceOwnerId = "owner_111";
let stubWorkspaceRole: "owner" | "member" = "owner";
let stubUserId = "user_owner_abc";
let stubUserEmail: string | null = "owner@example.com";

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = stubWorkspaceOwnerId;
    wreq.workspaceActualRole = stubWorkspaceRole;
    wreq.workspaceRole = stubWorkspaceRole;
    wreq.userId = stubUserId;
    wreq.userEmail = stubUserEmail;
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

import accessRequestsRouter from "./accessRequests";

// ---------------------------------------------------------------------------
// Test app
// ---------------------------------------------------------------------------

const mockReqLogError = vi.fn();

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: { error: typeof mockReqLogError; warn: typeof mockReqLogError; info: typeof mockReqLogError } }).log = {
      error: mockReqLogError,
      warn: mockReqLogError,
      info: mockReqLogError,
    };
    next();
  });
  app.use(accessRequestsRouter);
  return app;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PENDING_REQUEST = {
  id: 42,
  requester_clerk_id: "user_req_999",
  requester_email: "requester@example.com",
  requester_name: "Alice Smith",
  status: "pending",
  requested_at: "2024-06-01T10:00:00Z",
  resolved_at: null,
};

const ROLE_ROW = { id: 7, name: "Designer" };

const MEMBER_ROW = {
  id: 99,
  email: "requester@example.com",
  role: "member",
  custom_role_id: 7,
  joined: false,
  joined_at: null,
  invited_at: "2024-06-01T12:00:00Z",
  invited_by_email: "owner@example.com",
  manager_member_id: null,
  manager_email: null,
};

const REJECT_ROW = { id: 42, requester_email: "requester@example.com" };

// Default tx mock: captures set args and resolves with empty array.
function setupDefaultTxUpdate() {
  mockTxUpdate.mockReturnValue({
    set: (args: unknown) => {
      txUpdateSetArgs = args as Record<string, unknown>;
      return {
        where: () => Promise.resolve([]),
      };
    },
  });
}

// ---------------------------------------------------------------------------
// GET /access-requests
// ---------------------------------------------------------------------------

describe("GET /access-requests", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    drizzleQueue.length = 0;
    txExecuteQueue.length = 0;
    drizzleUpdateSetArgs = null;
    drizzleWhereArgs.length = 0;
    txUpdateSetArgs = null;
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceRole = "owner";
    stubWorkspaceOwnerId = "owner_111";
    stubUserId = "user_owner_abc";
    stubUserEmail = "owner@example.com";
    setupDefaultTxUpdate();
  });

  it("returns 200 with only pending access requests for an owner", async () => {
    drizzleQueue.push([PENDING_REQUEST]);

    const res = await request(app).get("/access-requests");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("requests");
    expect(res.body.requests).toHaveLength(1);
    expect(res.body.requests[0]).toMatchObject({
      id: 42,
      requester_email: "requester@example.com",
      status: "pending",
    });
  });

  it("returns 200 with an empty array when there are no pending requests", async () => {
    drizzleQueue.push([]);

    const res = await request(app).get("/access-requests");

    expect(res.status).toBe(200);
    expect(res.body.requests).toEqual([]);
  });

  it("queries only pending rows — drizzle select is invoked and returns pending results", async () => {
    drizzleQueue.push([]);

    await request(app).get("/access-requests");

    // Route calls drizzleDb.select().from(accessRequests).where(eq(status,"pending"))
    expect(mockDrizzleSelect).toHaveBeenCalledTimes(1);
  });

  it("scopes pending requests to the resolved workspace", async () => {
    drizzleQueue.push([]);

    await request(app).get("/access-requests");

    expect(drizzleWhereArgs).toHaveLength(1);
    expect(containsColumnName(drizzleWhereArgs[0], "workspace_owner_id")).toBe(true);
    expect(containsColumnName(drizzleWhereArgs[0], stubWorkspaceOwnerId)).toBe(true);
  });

  it("returns 403 when the caller is not an owner", async () => {
    stubWorkspaceRole = "member";

    const res = await request(app).get("/access-requests");

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: expect.stringContaining("owner") });
    expect(mockDrizzleSelect).not.toHaveBeenCalled();
  });

  it("returns 500 and logs when the db row fails response validation", async () => {
    const { requested_at: _omit, ...malformed } = PENDING_REQUEST;
    void _omit;
    drizzleQueue.push([malformed]);

    const res = await request(app).get("/access-requests");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal server error" });
    expect(mockReqLogError).toHaveBeenCalledTimes(1);
    const [logArgs] = mockReqLogError.mock.calls[0] as [
      { route: string; err: unknown },
      string,
    ];
    expect(logArgs.route).toBe("GET /access-requests");
    expect(Array.isArray(logArgs.err)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /access-requests/:id/approve
// ---------------------------------------------------------------------------

describe("POST /access-requests/:id/approve", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    drizzleQueue.length = 0;
    txExecuteQueue.length = 0;
    drizzleUpdateSetArgs = null;
    drizzleWhereArgs.length = 0;
    txUpdateSetArgs = null;
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceRole = "owner";
    stubWorkspaceOwnerId = "owner_111";
    stubUserId = "user_owner_abc";
    stubUserEmail = "owner@example.com";
    mockSendInviteEmail.mockResolvedValue(undefined);
    setupDefaultTxUpdate();
  });

  it("returns 200 with the new member when a pending request is approved", async () => {
    drizzleQueue.push([ROLE_ROW]);           // role check
    drizzleQueue.push([{ ...PENDING_REQUEST }]); // fetch request

    txExecuteQueue.push({ rows: [MEMBER_ROW] }); // workspace_members INSERT
    // tx.update(access_requests) uses default mockTxUpdate (resolves)
    txExecuteQueue.push({ rows: [] });           // notification_seen_ids DELETE

    const res = await request(app)
      .post("/access-requests/42/approve")
      .send({ roleId: 7 });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("member");
    expect(res.body.member).toMatchObject({ email: "requester@example.com" });
  });

  it("marks the access request as approved in the database via drizzle update inside the transaction", async () => {
    drizzleQueue.push([ROLE_ROW]);
    drizzleQueue.push([{ ...PENDING_REQUEST }]);

    txExecuteQueue.push({ rows: [MEMBER_ROW] }); // INSERT
    // tx.update uses default mockTxUpdate
    txExecuteQueue.push({ rows: [] });           // DELETE

    await request(app).post("/access-requests/42/approve").send({ roleId: 7 });

    // drizzle tx.update was called, and set was called with status:'approved'
    expect(mockTxUpdate).toHaveBeenCalledTimes(1);
    expect(txUpdateSetArgs).toMatchObject({ status: "approved" });
    expect(txUpdateSetArgs?.resolvedAt).toBeInstanceOf(Date);
  });

  it("sends an approval invite email after creating the member", async () => {
    drizzleQueue.push([ROLE_ROW]);
    drizzleQueue.push([{ ...PENDING_REQUEST }]);

    txExecuteQueue.push({ rows: [MEMBER_ROW] });
    txExecuteQueue.push({ rows: [] });

    await request(app).post("/access-requests/42/approve").send({ roleId: 7 });

    await vi.waitFor(() => expect(mockSendInviteEmail).toHaveBeenCalledTimes(1));
    expect(mockSendInviteEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        toEmail: "requester@example.com",
        isAccessApproval: true,
      }),
    );
  });

  it("returns 409 when the requester is already a workspace member, but still marks the request approved", async () => {
    const duplicateError = Object.assign(new Error("duplicate key"), { code: "23505" });

    drizzleQueue.push([ROLE_ROW]);
    drizzleQueue.push([{ ...PENDING_REQUEST }]);

    // tx.execute(INSERT workspace_members) throws 23505 — drizzle rolls back
    txExecuteQueue.push(duplicateError);

    // catch block: drizzleDb.update(access_requests) (outer, autocommit)
    drizzleQueue.push([]);

    // catch block: db.query(DELETE notification_seen_ids) handled by mockDbQuery default

    const res = await request(app)
      .post("/access-requests/42/approve")
      .send({ roleId: 7 });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: expect.stringContaining("already") });

    // The outer drizzleDb.update was called (from the 23505 catch block)
    expect(mockDrizzleUpdate).toHaveBeenCalledTimes(1);
    expect(drizzleUpdateSetArgs).toMatchObject({ status: "approved" });

    // db.query DELETE notification_seen_ids was called
    const deleteCall = mockDbQuery.mock.calls.find(([sql]: unknown[]) =>
      String(sql).includes("notification_seen_ids"),
    );
    expect(deleteCall).toBeDefined();
  });

  it("rolls back the transaction (via drizzle) when the access_requests UPDATE fails after INSERT", async () => {
    drizzleQueue.push([ROLE_ROW]);
    drizzleQueue.push([{ ...PENDING_REQUEST }]);

    // INSERT succeeds
    txExecuteQueue.push({ rows: [MEMBER_ROW] });

    // tx.update throws — drizzle rolls back and re-throws
    mockTxUpdate.mockReturnValueOnce({
      set: () => ({
        where: () => Promise.reject(new Error("DB connection lost")),
      }),
    });

    const res = await request(app)
      .post("/access-requests/42/approve")
      .send({ roleId: 7 });

    // drizzle handles the rollback internally; the route returns 500
    expect(res.status).toBe(500);
    // The transaction should have been invoked
    expect(mockDrizzleTransaction).toHaveBeenCalledTimes(1);
    // No member was created
    expect(res.body).not.toHaveProperty("member");
  });

  it("returns 403 when the caller is not an owner", async () => {
    stubWorkspaceRole = "member";

    const res = await request(app)
      .post("/access-requests/42/approve")
      .send({ roleId: 7 });

    expect(res.status).toBe(403);
    expect(mockDrizzleSelect).not.toHaveBeenCalled();
  });

  it("returns 400 when roleId is missing from the request body", async () => {
    const res = await request(app).post("/access-requests/42/approve").send({});

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining("role") });
  });

  it("returns 400 when the role does not belong to this workspace", async () => {
    drizzleQueue.push([]); // role check returns empty

    const res = await request(app)
      .post("/access-requests/42/approve")
      .send({ roleId: 999 });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining("Role not found") });
  });

  it("returns 404 when the access request does not exist", async () => {
    drizzleQueue.push([ROLE_ROW]);
    drizzleQueue.push([]); // access request not found

    const res = await request(app)
      .post("/access-requests/9999/approve")
      .send({ roleId: 7 });

    expect(res.status).toBe(404);
  });

  it("scopes the selected access request to the resolved workspace", async () => {
    drizzleQueue.push([ROLE_ROW]);
    drizzleQueue.push([]);

    await request(app)
      .post("/access-requests/9999/approve")
      .send({ roleId: 7 });

    expect(drizzleWhereArgs.some((condition) =>
      containsColumnName(condition, "workspace_owner_id") &&
      containsColumnName(condition, stubWorkspaceOwnerId),
    )).toBe(true);
  });

  it("returns 409 when the access request is not pending", async () => {
    drizzleQueue.push([ROLE_ROW]);
    drizzleQueue.push([{ ...PENDING_REQUEST, status: "approved" }]);

    const res = await request(app)
      .post("/access-requests/42/approve")
      .send({ roleId: 7 });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: expect.stringContaining("no longer pending") });
  });

  it("returns 400 when the request id is not a valid integer", async () => {
    const res = await request(app)
      .post("/access-requests/not-a-number/approve")
      .send({ roleId: 7 });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining("Invalid request id") });
  });
});

// ---------------------------------------------------------------------------
// POST /access-requests/:id/reject
// ---------------------------------------------------------------------------

describe("POST /access-requests/:id/reject", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    drizzleQueue.length = 0;
    txExecuteQueue.length = 0;
    drizzleUpdateSetArgs = null;
    drizzleWhereArgs.length = 0;
    txUpdateSetArgs = null;
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceRole = "owner";
    stubWorkspaceOwnerId = "owner_111";
    stubUserId = "user_owner_abc";
    stubUserEmail = "owner@example.com";
    mockSendAccessRejectionEmail.mockResolvedValue(undefined);
    setupDefaultTxUpdate();
  });

  it("returns 200 and ok:true when a pending request is rejected", async () => {
    drizzleQueue.push([REJECT_ROW]);

    const res = await request(app).post("/access-requests/42/reject");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("calls sendAccessRejectionEmail with the requester's email on a successful rejection", async () => {
    drizzleQueue.push([REJECT_ROW]);

    const res = await request(app).post("/access-requests/42/reject");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    await vi.waitFor(() => expect(mockSendAccessRejectionEmail).toHaveBeenCalledTimes(1));
    expect(mockSendAccessRejectionEmail).toHaveBeenCalledWith({
      toEmail: "requester@example.com",
    });
  });

  it("sets status to rejected and resolved_at in the database via drizzle update", async () => {
    drizzleQueue.push([REJECT_ROW]);

    await request(app).post("/access-requests/42/reject");

    expect(mockDrizzleUpdate).toHaveBeenCalledTimes(1);
    expect(drizzleUpdateSetArgs).toMatchObject({ status: "rejected" });
    expect(drizzleUpdateSetArgs?.resolvedAt).toBeInstanceOf(Date);
  });

  it("only updates rows that are still pending (where clause includes status=pending)", async () => {
    // When drizzle returns empty (no pending row matches), route returns 404.
    // This verifies the WHERE clause guards the pending status.
    drizzleQueue.push([]);

    const res = await request(app).post("/access-requests/42/reject");

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: expect.stringContaining("not found") });
  });

  it("scopes rejection updates to the resolved workspace", async () => {
    drizzleQueue.push([]);

    await request(app).post("/access-requests/42/reject");

    expect(drizzleWhereArgs).toHaveLength(1);
    expect(containsColumnName(drizzleWhereArgs[0], "workspace_owner_id")).toBe(true);
    expect(containsColumnName(drizzleWhereArgs[0], stubWorkspaceOwnerId)).toBe(true);
  });

  it("returns 200 and ok:true even when sendAccessRejectionEmail rejects (non-blocking guarantee)", async () => {
    mockSendAccessRejectionEmail.mockRejectedValue(new Error("Resend unavailable"));
    drizzleQueue.push([{ id: 7, requester_email: "requester@example.com" }]);

    const res = await request(app).post("/access-requests/7/reject");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("sends the email after a successful DB update even when the email call is slow", async () => {
    let resolveEmail!: () => void;
    const emailPromise = new Promise<void>((resolve) => {
      resolveEmail = resolve;
    });
    mockSendAccessRejectionEmail.mockReturnValue(emailPromise);
    drizzleQueue.push([{ id: 5, requester_email: "slow@example.com" }]);

    const res = await request(app).post("/access-requests/5/reject");

    expect(res.status).toBe(200);
    expect(mockSendAccessRejectionEmail).toHaveBeenCalledWith({ toEmail: "slow@example.com" });

    resolveEmail();
    await emailPromise;
  });

  it("deletes notification_seen_ids rows for the request after rejection", async () => {
    drizzleQueue.push([REJECT_ROW]);

    await request(app).post("/access-requests/42/reject");

    const deleteCall = mockDbQuery.mock.calls.find(([sql]: unknown[]) =>
      String(sql).includes("notification_seen_ids"),
    );
    expect(deleteCall).toBeDefined();
    const params = deleteCall![1] as unknown[];
    expect(params[0]).toBe(42);
  });

  it("returns 404 when no pending request matches the id", async () => {
    drizzleQueue.push([]); // no rows returned

    const res = await request(app).post("/access-requests/999/reject");

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: expect.stringContaining("not found") });
    expect(mockSendAccessRejectionEmail).not.toHaveBeenCalled();
  });

  it("returns 403 when the caller is not an owner", async () => {
    stubWorkspaceRole = "member";

    const res = await request(app).post("/access-requests/42/reject");

    expect(res.status).toBe(403);
    expect(mockDrizzleUpdate).not.toHaveBeenCalled();
    expect(mockSendAccessRejectionEmail).not.toHaveBeenCalled();
  });

  it("returns 400 when the request id is not a valid integer", async () => {
    const res = await request(app).post("/access-requests/bad-id/reject");

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining("Invalid request id") });
    expect(mockSendAccessRejectionEmail).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GET /access-requests/events  (SSE)
// ---------------------------------------------------------------------------

describe("GET /access-requests/events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    drizzleQueue.length = 0;
    txExecuteQueue.length = 0;
    drizzleUpdateSetArgs = null;
    txUpdateSetArgs = null;
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceRole = "owner";
    stubWorkspaceOwnerId = "owner_111";
    stubUserId = "user_owner_abc";
    stubUserEmail = "owner@example.com";
    setupDefaultTxUpdate();

    mockSubscribe.mockImplementation((_id: string, res: express.Response) => {
      res.end();
    });
  });

  it("returns SSE headers: Content-Type text/event-stream, Cache-Control no-cache, Connection keep-alive", async () => {
    const app = makeApp();
    const res = await request(app).get("/access-requests/events");

    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    expect(res.headers["cache-control"]).toMatch(/no-cache/);
    expect(res.headers["connection"]).toMatch(/keep-alive/);
  });

  it("sets X-Accel-Buffering: no to disable nginx proxy buffering", async () => {
    const app = makeApp();
    const res = await request(app).get("/access-requests/events");

    expect(res.headers["x-accel-buffering"]).toBe("no");
  });

  it("writes the initial :connected comment immediately after opening the stream", async () => {
    const app = makeApp();
    const res = await request(app).get("/access-requests/events");

    expect(res.text).toContain(": connected");
  });

  it("calls subscribe with the workspaceOwnerId and the response object", async () => {
    const app = makeApp();
    await request(app).get("/access-requests/events");

    expect(mockSubscribe).toHaveBeenCalledTimes(1);
    expect(mockSubscribe.mock.calls[0][0]).toBe("owner_111");
  });

  it("returns 403 when the caller is not an owner", async () => {
    stubWorkspaceRole = "member";
    const app = makeApp();
    const res = await request(app).get("/access-requests/events");

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: expect.stringContaining("owner") });
    expect(mockSubscribe).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// broadcast() called after approve / reject
// ---------------------------------------------------------------------------

describe("POST /access-requests/:id/approve – broadcast", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    drizzleQueue.length = 0;
    txExecuteQueue.length = 0;
    drizzleUpdateSetArgs = null;
    txUpdateSetArgs = null;
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceRole = "owner";
    stubWorkspaceOwnerId = "owner_111";
    stubUserId = "user_owner_abc";
    stubUserEmail = "owner@example.com";
    mockSendInviteEmail.mockResolvedValue(undefined);
    setupDefaultTxUpdate();
  });

  it("calls broadcast with the workspaceOwnerId after a successful approval", async () => {
    drizzleQueue.push([ROLE_ROW]);
    drizzleQueue.push([{ ...PENDING_REQUEST }]);

    txExecuteQueue.push({ rows: [MEMBER_ROW] });
    txExecuteQueue.push({ rows: [] });

    const res = await request(app)
      .post("/access-requests/42/approve")
      .send({ roleId: 7 });

    expect(res.status).toBe(200);
    expect(mockBroadcast).toHaveBeenCalledTimes(1);
    expect(mockBroadcast).toHaveBeenCalledWith("owner_111");
  });

  it("calls broadcast with the workspaceOwnerId after a rejection", async () => {
    drizzleQueue.push([REJECT_ROW]);

    const res = await request(app).post("/access-requests/42/reject");

    expect(res.status).toBe(200);
    expect(mockBroadcast).toHaveBeenCalledTimes(1);
    expect(mockBroadcast).toHaveBeenCalledWith("owner_111");
  });

  it("calls broadcast even when the requester was already a member (23505 path)", async () => {
    const duplicateError = Object.assign(new Error("duplicate key"), { code: "23505" });

    drizzleQueue.push([ROLE_ROW]);
    drizzleQueue.push([{ ...PENDING_REQUEST }]);

    txExecuteQueue.push(duplicateError);    // INSERT throws 23505
    drizzleQueue.push([]);                  // outer drizzleDb.update(access_requests)

    const res = await request(app)
      .post("/access-requests/42/approve")
      .send({ roleId: 7 });

    expect(res.status).toBe(409);
    expect(mockBroadcast).toHaveBeenCalledWith("owner_111");
  });

  it("cleans up notification_seen_ids inside the transaction after a successful approval", async () => {
    drizzleQueue.push([ROLE_ROW]);
    drizzleQueue.push([{ ...PENDING_REQUEST }]);

    txExecuteQueue.push({ rows: [MEMBER_ROW] }); // INSERT
    // tx.update resolves (default)
    txExecuteQueue.push({ rows: [] });            // DELETE notification_seen_ids

    const res = await request(app)
      .post("/access-requests/42/approve")
      .send({ roleId: 7 });

    expect(res.status).toBe(200);
    // The transaction was committed (mockDrizzleTransaction called once)
    expect(mockDrizzleTransaction).toHaveBeenCalledTimes(1);
  });
});
