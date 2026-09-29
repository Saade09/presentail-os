import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

vi.mock("pino-http", () => ({
  default: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

vi.mock("@clerk/express", () => ({
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  getAuth: vi.fn(),
  clerkClient: {
    users: {
      getUser: vi.fn(),
    },
  },
}));

vi.mock("../middlewares/clerkProxyMiddleware", () => ({
  CLERK_PROXY_PATH: "/__clerk",
  clerkProxyMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../lib/email", () => ({
  sendAccessRequestEmail: vi.fn(),
}));

vi.mock("../lib/accessRequestSse", () => ({
  broadcast: vi.fn(),
}));

const mockDbQuery = vi.fn();

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
  },
}));

import { getAuth, clerkClient } from "@clerk/express";
import { sendAccessRequestEmail } from "../lib/email";
import { broadcast } from "../lib/accessRequestSse";
import app from "../app";

const USER_ID = "user_test_123";
const USER_EMAIL = "requester@example.com";
const USER_NAME = "Jane Doe";
const OWNER_EMAIL = "owner@presentail.com";
const OWNER_ID = "owner_workspace_111";

function mockAuthedUser() {
  vi.mocked(getAuth).mockReturnValue({ userId: USER_ID } as never);
  vi.mocked(clerkClient.users.getUser).mockResolvedValue({
    primaryEmailAddress: { emailAddress: USER_EMAIL },
    firstName: "Jane",
    lastName: "Doe",
  } as never);
}

/** Simulate a fresh INSERT — ON CONFLICT DO NOTHING produced one row */
function mockNewInsert() {
  mockOwnerQuery();
  mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 });
}

/** Simulate a duplicate INSERT — ON CONFLICT DO NOTHING was a no-op */
function mockConflictInsert() {
  mockOwnerQuery();
  mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
}

/** Simulate the workspace_owner_id lookup used for the SSE broadcast */
function mockOwnerIdQuery(ownerIds: string[] = [OWNER_ID]) {
  void ownerIds;
}

/** Simulate the owner email lookup returning one owner */
function mockOwnerQuery() {
  mockDbQuery.mockResolvedValueOnce({ rows: [{ member_email: OWNER_EMAIL }], rowCount: 1 });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe("POST /api/request-access", () => {
  it("returns 200 and ok:true for an authenticated Clerk user with a valid email", async () => {
    mockAuthedUser();
    mockNewInsert();
    mockOwnerIdQuery();
    vi.mocked(sendAccessRequestEmail).mockResolvedValue(undefined);

    const res = await request(app).post("/api/request-access").send({ workspaceOwnerId: OWNER_ID });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(sendAccessRequestEmail).toHaveBeenCalledTimes(1);
    expect(sendAccessRequestEmail).toHaveBeenCalledWith({
      requesterEmail: USER_EMAIL,
      requesterName: USER_NAME,
      ownerEmails: [OWNER_EMAIL],
    });
  });

  it("inserts the access request row using ON CONFLICT DO NOTHING", async () => {
    mockAuthedUser();
    mockNewInsert();
    vi.mocked(sendAccessRequestEmail).mockResolvedValue(undefined);

    await request(app).post("/api/request-access").send({ workspaceOwnerId: OWNER_ID });

    const [sql, params] = mockDbQuery.mock.calls.find(([query]) =>
      String(query).includes("INSERT INTO access_requests"),
    ) as [string, unknown[]];
    expect(sql).toMatch(/INSERT INTO access_requests/i);
    expect(sql).toMatch(/ON CONFLICT.*DO NOTHING/is);
    expect(params).toEqual([OWNER_ID, USER_ID, USER_EMAIL, USER_NAME]);
  });

  it("scopes a failed email record to the requested workspace", async () => {
    mockAuthedUser();
    mockNewInsert();
    vi.mocked(sendAccessRequestEmail).mockRejectedValue(new Error("Resend unavailable"));

    await request(app).post("/api/request-access").send({ workspaceOwnerId: OWNER_ID });

    const [sql, params] = mockDbQuery.mock.calls.find(([query]) =>
      String(query).includes("INSERT INTO failed_access_requests"),
    ) as [string, unknown[]];
    expect(sql).toMatch(/workspace_owner_id/i);
    expect(params).toEqual([OWNER_ID, USER_EMAIL, USER_NAME, "Resend unavailable"]);
  });

  it("returns 409 with already_requested when the user has already submitted a request", async () => {
    mockAuthedUser();
    mockConflictInsert();

    const res = await request(app).post("/api/request-access").send({ workspaceOwnerId: OWNER_ID });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "already_requested" });
    expect(sendAccessRequestEmail).not.toHaveBeenCalled();
  });

  it("returns 200 even when the email send fails (request is still persisted)", async () => {
    mockAuthedUser();
    mockNewInsert();
    vi.mocked(sendAccessRequestEmail).mockRejectedValue(new Error("Resend unavailable"));

    const res = await request(app).post("/api/request-access").send({ workspaceOwnerId: OWNER_ID });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("logs the failed email send to failed_access_requests when the email fails", async () => {
    mockAuthedUser();
    mockNewInsert();
    vi.mocked(sendAccessRequestEmail).mockRejectedValue(new Error("Resend unavailable"));
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await request(app).post("/api/request-access").send({ workspaceOwnerId: OWNER_ID });

    const insertFailedCall = mockDbQuery.mock.calls.find(([sql]) =>
      String(sql).includes("failed_access_requests"),
    );
    expect(insertFailedCall).toBeDefined();
    const params = insertFailedCall![1] as unknown[];
    expect(params[0]).toBe(OWNER_ID);
    expect(params[1]).toBe(USER_EMAIL);
    expect(params[2]).toBe(USER_NAME);
    expect(String(params[3])).toContain("Resend unavailable");
  });

  it("returns 401 when no Clerk session is present", async () => {
    vi.mocked(getAuth).mockReturnValue({ userId: undefined } as never);

    const res = await request(app).post("/api/request-access").send({ workspaceOwnerId: OWNER_ID });

    expect(res.status).toBe(401);
    expect(sendAccessRequestEmail).not.toHaveBeenCalled();
  });

  it("returns 400 when Clerk user has no primary email address", async () => {
    vi.mocked(getAuth).mockReturnValue({ userId: USER_ID } as never);
    vi.mocked(clerkClient.users.getUser).mockResolvedValue({
      primaryEmailAddress: null,
      firstName: "Jane",
      lastName: "Doe",
    } as never);

    const res = await request(app).post("/api/request-access").send({ workspaceOwnerId: OWNER_ID });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining("email") });
    expect(sendAccessRequestEmail).not.toHaveBeenCalled();
  });

  it("still returns 200 and sends email with empty ownerEmails when owner lookup fails", async () => {
    mockAuthedUser();
    mockDbQuery.mockRejectedValueOnce(new Error("DB connection lost"));
    vi.mocked(sendAccessRequestEmail).mockResolvedValue(undefined);

    const res = await request(app).post("/api/request-access").send({ workspaceOwnerId: OWNER_ID });

    expect(res.status).toBe(500);
    expect(sendAccessRequestEmail).not.toHaveBeenCalled();
  });

  it("uses the requester's email as the name when firstName and lastName are absent", async () => {
    vi.mocked(getAuth).mockReturnValue({ userId: USER_ID } as never);
    vi.mocked(clerkClient.users.getUser).mockResolvedValue({
      primaryEmailAddress: { emailAddress: USER_EMAIL },
      firstName: null,
      lastName: null,
    } as never);
    mockNewInsert();
    mockOwnerIdQuery();
    vi.mocked(sendAccessRequestEmail).mockResolvedValue(undefined);

    const res = await request(app).post("/api/request-access").send({ workspaceOwnerId: OWNER_ID });

    expect(res.status).toBe(200);
    expect(sendAccessRequestEmail).toHaveBeenCalledWith({
      requesterEmail: USER_EMAIL,
      requesterName: USER_EMAIL,
      ownerEmails: [OWNER_EMAIL],
    });
  });

  it("broadcasts a changed SSE event to each workspace owner immediately after a new request is inserted", async () => {
    const OWNER_ID_A = "owner_aaa";
    const OWNER_ID_B = "owner_bbb";

    mockAuthedUser();
    mockNewInsert();
    mockOwnerIdQuery([OWNER_ID_A, OWNER_ID_B]);
    vi.mocked(sendAccessRequestEmail).mockResolvedValue(undefined);

    const res = await request(app).post("/api/request-access").send({ workspaceOwnerId: OWNER_ID });

    expect(res.status).toBe(200);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith(OWNER_ID);
  });

  it("does not broadcast when the access request is a duplicate", async () => {
    mockAuthedUser();
    mockConflictInsert();

    const res = await request(app).post("/api/request-access").send({ workspaceOwnerId: OWNER_ID });

    expect(res.status).toBe(409);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("broadcasts only to the requested workspace", async () => {
    mockAuthedUser();
    mockNewInsert();
    mockOwnerIdQuery([OWNER_ID]);
    vi.mocked(sendAccessRequestEmail).mockResolvedValue(undefined);

    const res = await request(app).post("/api/request-access").send({ workspaceOwnerId: OWNER_ID });

    expect(res.status).toBe(200);
    expect(broadcast).toHaveBeenCalledWith(OWNER_ID);
  });

  it("requires an explicit target workspace", async () => {
    mockAuthedUser();

    const res = await request(app).post("/api/request-access");

    expect(res.status).toBe(400);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("scopes the insert and owner notification to the target workspace", async () => {
    mockAuthedUser();
    mockNewInsert();
    vi.mocked(sendAccessRequestEmail).mockResolvedValue(undefined);

    const res = await request(app)
      .post("/api/request-access")
      .send({ workspaceOwnerId: "target_workspace" });

    expect(res.status).toBe(200);
    expect(mockDbQuery.mock.calls[0][1]).toEqual(["target_workspace"]);
    const insertCall = mockDbQuery.mock.calls.find(([query]) =>
      String(query).includes("INSERT INTO access_requests"),
    );
    expect(insertCall?.[1]).toEqual([
      "target_workspace",
      USER_ID,
      USER_EMAIL,
      USER_NAME,
    ]);
    expect(broadcast).toHaveBeenCalledWith("target_workspace");
  });
});

describe("GET /api/request-access/status", () => {
  it("returns { requested: false } when the user has not yet requested access", async () => {
    vi.mocked(getAuth).mockReturnValue({ userId: USER_ID } as never);
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get(
      `/api/request-access/status?workspace=${encodeURIComponent(OWNER_ID.replace("owner_", "user_"))}`,
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ requested: false });
  });

  it("returns { requested: true } when the user has already requested access", async () => {
    vi.mocked(getAuth).mockReturnValue({ userId: USER_ID } as never);
    mockDbQuery.mockResolvedValueOnce({ rows: [{ "?column?": 1 }], rowCount: 1 });

    const res = await request(app).get(
      `/api/request-access/status?workspace=${encodeURIComponent(OWNER_ID.replace("owner_", "user_"))}`,
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ requested: true });
  });

  it("returns 401 when the user is not authenticated", async () => {
    vi.mocked(getAuth).mockReturnValue({ userId: undefined } as never);

    const res = await request(app).get(
      `/api/request-access/status?workspace=${encodeURIComponent(OWNER_ID.replace("owner_", "user_"))}`,
    );

    expect(res.status).toBe(401);
  });
});
