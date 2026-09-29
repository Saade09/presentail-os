import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

// ---------------------------------------------------------------------------
// Mocks — declared before importing the module under test
// ---------------------------------------------------------------------------

const mockDbQuery = vi.fn();
const mockDbClientQuery = vi.fn();
const mockDbClientRelease = vi.fn();

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
    connect: async () => ({
      query: (...args: unknown[]) => mockDbClientQuery(...args),
      release: mockDbClientRelease,
    }),
  },
  withTransaction: async (client: { query: (...a: unknown[]) => unknown }, fn: () => Promise<unknown>) => {
    await client.query("BEGIN");
    try {
      const result = await fn();
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch { /* swallow */ }
      throw err;
    }
  },
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  authed: (req: express.Request) => req,
}));

const mockSendInviteEmail = vi.fn();

vi.mock("../lib/email", () => ({
  sendInviteEmail: (...args: unknown[]) => mockSendInviteEmail(...args),
}));

// Configurable workspace stub (mirrors the pattern used in brands.test.ts)
let stubWorkspaceOwnerId = "owner_123";
let stubActualRole = "owner";
let stubUserId = "user_abc";
let stubUserEmail: string | null = "owner@example.com";
let stubMemberDbId: number | null = 7;

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = stubWorkspaceOwnerId;
    wreq.workspaceActualRole = stubActualRole;
    wreq.workspaceRole = stubActualRole === "owner" ? "owner" : "member";
    wreq.userId = stubUserId;
    wreq.userEmail = stubUserEmail;
    wreq.memberDbId = stubMemberDbId;
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const mockDeleteUser = vi.fn();
const mockGetSessionList = vi.fn();
const mockRevokeSession = vi.fn();

vi.mock("@clerk/express", () => ({
  clerkClient: {
    users: {
      deleteUser: (...args: unknown[]) => mockDeleteUser(...args),
    },
    sessions: {
      getSessionList: (...args: unknown[]) => mockGetSessionList(...args),
      revokeSession: (...args: unknown[]) => mockRevokeSession(...args),
    },
  },
}));

import usersRouter from "./users";

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
  app.use(usersRouter);
  return app;
}

describe("failed access request tenant isolation", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubUserId = "user_abc";
    stubUserEmail = "owner@example.com";
  });

  it("lists only failed requests for the resolved workspace", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/users/failed-access-requests");

    expect(res.status).toBe(200);
    expect(mockDbQuery).toHaveBeenCalledWith(
      expect.stringMatching(/workspace_owner_id\s*=\s*\$1/i),
      [stubWorkspaceOwnerId],
    );
  });

  it("cannot dismiss a failed request from another workspace", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).delete("/users/failed-access-requests/42");

    expect(res.status).toBe(404);
    expect(mockDbQuery).toHaveBeenCalledWith(
      expect.stringMatching(/id\s*=\s*\$1[\s\S]*workspace_owner_id\s*=\s*\$2/i),
      [42, stubWorkspaceOwnerId],
    );
  });
});

describe("GET /users — response validation", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubUserId = "user_abc";
    stubUserEmail = "owner@example.com";
  });

  it("returns 500 and logs when a member row fails response validation", async () => {
    // Members SELECT
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          // id should be a number — string here triggers Zod failure
          id: "not-a-number",
          email: "x@example.com",
          role: "member",
          joined: true,
          custom_role_id: null,
          user_id: "user_x",
          assigned_location_ids: null,
        },
      ],
    });
    // Locations lookup (member_locations JOIN)
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    // workspace_member_roles lookup (multi-role junction table)
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get("/users");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal server error" });
    expect(mockReqLogError).toHaveBeenCalledWith(
      expect.objectContaining({ route: "GET /users", err: expect.any(Array) }),
      "Response validation failed",
    );
  });
});

// ---------------------------------------------------------------------------
// POST /users — invite a member
// ---------------------------------------------------------------------------

describe("POST /users — invite email is sent when a user is approved", () => {
  const app = makeApp();

  const MEMBER_ROW = {
    id: 99,
    email: "newmember@example.com",
    role: "member",
    custom_role_id: 7,
    joined: false,
    joined_at: null,
    invited_at: "2024-01-01T00:00:00Z",
    invited_by_email: "owner@example.com",
    manager_member_id: null,
    manager_email: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubUserId = "user_abc";
    stubUserEmail = "owner@example.com";
    // Default: all client queries resolve successfully (BEGIN / COMMIT / etc.)
    mockDbClientQuery.mockResolvedValue({ rows: [] });
    mockDbClientRelease.mockReturnValue(undefined);
  });

  it("calls sendInviteEmail with the invited email, inviter email, and role name on success", async () => {
    mockSendInviteEmail.mockResolvedValue(undefined);

    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 7, name: "Designer" }], rowCount: 1 }); // role check
    mockDbClientQuery
      .mockResolvedValueOnce({ rows: [] })                                   // BEGIN
      .mockResolvedValueOnce({ rows: [{ ...MEMBER_ROW }], rowCount: 1 })   // INSERT
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                     // UPDATE dismissed
      .mockResolvedValueOnce({ rows: [] });                                  // COMMIT

    const res = await request(app)
      .post("/users")
      .send({ email: "newmember@example.com", roleId: 7 });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("member");

    expect(mockSendInviteEmail).toHaveBeenCalledTimes(1);
    expect(mockSendInviteEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        toEmail: "newmember@example.com",
        invitedByEmail: "owner@example.com",
        role: "Designer",
        isAccessApproval: false,
        inviteToken: expect.any(String),
      }),
    );
  });

  it("normalises the invited email address to lowercase before passing it to sendInviteEmail", async () => {
    mockSendInviteEmail.mockResolvedValue(undefined);

    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 3, name: "Customer Service Agent" }], rowCount: 1 });
    mockDbClientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ ...MEMBER_ROW, email: "user@example.com", custom_role_id: 3 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await request(app)
      .post("/users")
      .send({ email: "User@EXAMPLE.COM", roleId: 3 });

    expect(mockSendInviteEmail).toHaveBeenCalledWith(
      expect.objectContaining({ toEmail: "user@example.com" }),
    );
  });

  it("passes the inviter email from the workspace context to sendInviteEmail", async () => {
    stubUserEmail = "boss@company.com";
    mockSendInviteEmail.mockResolvedValue(undefined);

    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 5, name: "Designer" }], rowCount: 1 });
    mockDbClientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ ...MEMBER_ROW, email: "colleague@company.com", custom_role_id: 5, invited_by_email: "boss@company.com" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await request(app)
      .post("/users")
      .send({ email: "colleague@company.com", roleId: 5 });

    expect(mockSendInviteEmail).toHaveBeenCalledWith(
      expect.objectContaining({ invitedByEmail: "boss@company.com" }),
    );
  });

  it("swallows errors thrown by sendInviteEmail (fire-and-forget)", async () => {
    mockSendInviteEmail.mockRejectedValue(new Error("SMTP unavailable"));

    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 7, name: "Designer" }], rowCount: 1 });
    mockDbClientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ ...MEMBER_ROW, email: "member@example.com" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post("/users")
      .send({ email: "member@example.com", roleId: 7 });

    // The route must still respond 200 even though the email call rejected.
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("member");
    expect(mockSendInviteEmail).toHaveBeenCalledTimes(1);
  });

  it("does NOT call sendInviteEmail when the caller is not an owner", async () => {
    stubActualRole = "member";

    const res = await request(app)
      .post("/users")
      .send({ email: "someone@example.com", roleId: 7 });

    expect(res.status).toBe(403);
    expect(mockSendInviteEmail).not.toHaveBeenCalled();
  });

  it("does NOT call sendInviteEmail when the email is invalid", async () => {
    const res = await request(app)
      .post("/users")
      .send({ email: "not-an-email", roleId: 7 });

    expect(res.status).toBe(400);
    expect(mockSendInviteEmail).not.toHaveBeenCalled();
  });

  it("does NOT call sendInviteEmail when the role is not found in the workspace", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // role check fails

    const res = await request(app)
      .post("/users")
      .send({ email: "valid@example.com", roleId: 999 });

    expect(res.status).toBe(400);
    expect(mockSendInviteEmail).not.toHaveBeenCalled();
  });

  it("does NOT call sendInviteEmail when the email is already in the workspace (409)", async () => {
    const duplicateError = Object.assign(new Error("duplicate key"), { code: "23505" });

    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 7, name: "Designer" }], rowCount: 1 }) // role found
      .mockResolvedValueOnce({ rows: [{ id: 42 }] }); // existing member lookup
    mockDbClientQuery
      .mockResolvedValueOnce({ rows: [] })      // BEGIN
      .mockRejectedValueOnce(duplicateError)     // INSERT → 23505
      .mockResolvedValueOnce({ rows: [] });      // ROLLBACK

    const res = await request(app)
      .post("/users")
      .send({ email: "duplicate@example.com", roleId: 7 });

    expect(res.status).toBe(409);
    expect(res.body.existing_person_id).toBe("wm_42");
    expect(mockSendInviteEmail).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /users/:id/resend-invite — generate a fresh token and resend invite
// ---------------------------------------------------------------------------

describe("POST /users/:id/resend-invite", () => {
  const app = makeApp();

  const PENDING_MEMBER = {
    id: 42,
    email: "pending@example.com",
    role: "member",
    custom_role_id: 7,
    joined: false,
    joined_at: null,
    invited_at: "2024-01-01T00:00:00Z",
    invited_by_email: "owner@example.com",
    manager_member_id: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubUserId = "user_abc";
    stubUserEmail = "owner@example.com";
  });

  it("returns 200 with the updated member for a pending (not-yet-joined) member", async () => {
    mockSendInviteEmail.mockResolvedValue(undefined);
    mockDbQuery
      .mockResolvedValueOnce({ rows: [PENDING_MEMBER], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ name: "Designer" }] });

    const res = await request(app).post(`/users/${PENDING_MEMBER.id}/resend-invite`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("member");
    expect(res.body.member).toMatchObject({ id: PENDING_MEMBER.id, email: PENDING_MEMBER.email });
  });

  it("calls sendInviteEmail with a fresh token string", async () => {
    mockSendInviteEmail.mockResolvedValue(undefined);
    mockDbQuery
      .mockResolvedValueOnce({ rows: [PENDING_MEMBER], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ name: "Designer" }] });

    await request(app).post(`/users/${PENDING_MEMBER.id}/resend-invite`);

    expect(mockSendInviteEmail).toHaveBeenCalledTimes(1);
    expect(mockSendInviteEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        toEmail: PENDING_MEMBER.email,
        isAccessApproval: false,
        inviteToken: expect.any(String),
      }),
    );
  });

  it("generates a NEW token (different from any previously stored value)", async () => {
    mockSendInviteEmail.mockResolvedValue(undefined);
    mockDbQuery
      .mockResolvedValueOnce({ rows: [PENDING_MEMBER], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ name: "Designer" }] });

    await request(app).post(`/users/${PENDING_MEMBER.id}/resend-invite`);

    // The UPDATE query must be called with a non-empty token as $1
    const updateCall = mockDbQuery.mock.calls[0];
    const tokenArg = updateCall[1][0]; // first element of the params array
    expect(typeof tokenArg).toBe("string");
    expect(tokenArg.length).toBeGreaterThan(0);

    // sendInviteEmail receives the same token that was written to the DB
    const emailCallArgs = mockSendInviteEmail.mock.calls[0][0] as { inviteToken: string };
    expect(emailCallArgs.inviteToken).toBe(tokenArg);
  });

  it("returns 403 when the caller is not an owner", async () => {
    stubActualRole = "member";

    const res = await request(app).post(`/users/42/resend-invite`);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: expect.stringContaining("permission") });
    expect(mockSendInviteEmail).not.toHaveBeenCalled();
  });

  it("returns 404 and sends no email when the member has already joined", async () => {
    // The UPDATE query filters on `member_user_id IS NULL`, so a joined member
    // matches no row and the handler responds with 404.
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).post(`/users/42/resend-invite`);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: expect.any(String) });
    expect(mockSendInviteEmail).not.toHaveBeenCalled();
  });

  it("returns 404 and sends no email when the member does not exist in this workspace", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).post(`/users/9999/resend-invite`);

    expect(res.status).toBe(404);
    expect(mockSendInviteEmail).not.toHaveBeenCalled();
  });

  it("uses the invited_by_email stored on the member row as the inviter address", async () => {
    mockSendInviteEmail.mockResolvedValue(undefined);
    const memberWithCustomInviter = {
      ...PENDING_MEMBER,
      invited_by_email: "original-inviter@example.com",
    };
    mockDbQuery
      .mockResolvedValueOnce({ rows: [memberWithCustomInviter], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ name: "Designer" }] });

    await request(app).post(`/users/${PENDING_MEMBER.id}/resend-invite`);

    expect(mockSendInviteEmail).toHaveBeenCalledWith(
      expect.objectContaining({ invitedByEmail: "original-inviter@example.com" }),
    );
  });

  it("falls back to the requester's email when invited_by_email is null", async () => {
    stubUserEmail = "current-owner@example.com";
    mockSendInviteEmail.mockResolvedValue(undefined);
    const memberWithNullInviter = { ...PENDING_MEMBER, invited_by_email: null };
    mockDbQuery
      .mockResolvedValueOnce({ rows: [memberWithNullInviter], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ name: "Designer" }] });

    await request(app).post(`/users/${PENDING_MEMBER.id}/resend-invite`);

    expect(mockSendInviteEmail).toHaveBeenCalledWith(
      expect.objectContaining({ invitedByEmail: "current-owner@example.com" }),
    );
  });

  it("swallows errors thrown by sendInviteEmail (fire-and-forget)", async () => {
    mockSendInviteEmail.mockRejectedValue(new Error("SMTP failure"));
    mockDbQuery
      .mockResolvedValueOnce({ rows: [PENDING_MEMBER], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ name: "Designer" }] });

    const res = await request(app).post(`/users/${PENDING_MEMBER.id}/resend-invite`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("member");
  });

  it("returns 400 for a non-numeric member id", async () => {
    const res = await request(app).post(`/users/not-a-number/resend-invite`);

    expect(res.status).toBe(400);
    expect(mockDbQuery).not.toHaveBeenCalled();
    expect(mockSendInviteEmail).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /users — pending access_request is dismissed after a successful invite
// ---------------------------------------------------------------------------

describe("POST /users — pending access_request is cleared when an invite is sent", () => {
  const app = makeApp();

  const APPLICANT_ROW = {
    id: 55,
    email: "applicant@example.com",
    role: "member",
    custom_role_id: 7,
    joined: false,
    joined_at: null,
    invited_at: "2024-01-01T00:00:00Z",
    invited_by_email: "owner@example.com",
    manager_member_id: null,
    manager_email: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubUserId = "user_abc";
    stubUserEmail = "owner@example.com";
    mockDbClientQuery.mockResolvedValue({ rows: [] });
    mockDbClientRelease.mockReturnValue(undefined);
  });

  it("dismisses only the invited workspace's pending request for the email", async () => {
    mockSendInviteEmail.mockResolvedValue(undefined);

    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 7, name: "Designer" }], rowCount: 1 }); // role check
    mockDbClientQuery
      .mockResolvedValueOnce({ rows: [] })                                      // BEGIN
      .mockResolvedValueOnce({ rows: [{ ...APPLICANT_ROW }], rowCount: 1 })   // INSERT
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                        // UPDATE dismissed
      .mockResolvedValueOnce({ rows: [] });                                     // COMMIT

    const res = await request(app)
      .post("/users")
      .send({ email: "applicant@example.com", roleId: 7 });

    expect(res.status).toBe(200);

    const dismissCall = mockDbClientQuery.mock.calls.find(([sql]: [string]) =>
      /UPDATE\s+access_requests/i.test(sql) &&
      /status\s*=\s*'dismissed'/i.test(sql),
    );

    expect(dismissCall).toBeDefined();
    const [sql, params] = dismissCall as [string, unknown[]];
    expect(sql).toMatch(/workspace_owner_id\s*=\s*\$1/i);
    expect(sql).toMatch(/requester_email\s*=\s*\$2/i);
    expect(params).toEqual(["owner_123", "applicant@example.com"]);
  });

  it("issues the dismiss UPDATE after the workspace_members INSERT inside the same transaction", async () => {
    mockSendInviteEmail.mockResolvedValue(undefined);

    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 7, name: "Designer" }], rowCount: 1 });
    mockDbClientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ ...APPLICANT_ROW, id: 56 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await request(app)
      .post("/users")
      .send({ email: "applicant@example.com", roleId: 7 });

    const callLabels = mockDbClientQuery.mock.calls.map(([sql]: [string]) => {
      if (/^BEGIN$/i.test(sql)) return "begin";
      if (/INSERT INTO workspace_members/i.test(sql)) return "memberInsert";
      if (/UPDATE\s+access_requests/i.test(sql)) return "dismissRequest";
      if (/^COMMIT$/i.test(sql)) return "commit";
      return "other";
    });

    const insertIdx = callLabels.indexOf("memberInsert");
    const dismissIdx = callLabels.indexOf("dismissRequest");

    expect(insertIdx).toBeGreaterThanOrEqual(0);
    expect(dismissIdx).toBeGreaterThan(insertIdx);
  });

  it("does NOT dismiss access_requests when the invited email is already in the workspace (409)", async () => {
    const duplicateError = Object.assign(new Error("duplicate key"), { code: "23505" });

    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 7, name: "Designer" }], rowCount: 1 }) // role found
      .mockResolvedValueOnce({ rows: [{ id: 42 }] }); // existing member lookup
    mockDbClientQuery
      .mockResolvedValueOnce({ rows: [] })    // BEGIN
      .mockRejectedValueOnce(duplicateError)   // INSERT → 23505
      .mockResolvedValueOnce({ rows: [] });    // ROLLBACK

    const res = await request(app)
      .post("/users")
      .send({ email: "duplicate@example.com", roleId: 7 });

    expect(res.status).toBe(409);
    expect(res.body.existing_person_id).toBe("wm_42");

    const dismissCall = mockDbClientQuery.mock.calls.find(([sql]: [string]) =>
      /UPDATE\s+access_requests/i.test(sql),
    );
    expect(dismissCall).toBeUndefined();
  });

  it("rolls back the transaction when the dismiss UPDATE fails after INSERT", async () => {
    mockSendInviteEmail.mockResolvedValue(undefined);

    const dbError = new Error("DB error on dismiss");
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 7, name: "Designer" }], rowCount: 1 });
    mockDbClientQuery
      .mockResolvedValueOnce({ rows: [] })                                      // BEGIN
      .mockResolvedValueOnce({ rows: [{ ...APPLICANT_ROW }], rowCount: 1 })   // INSERT succeeds
      .mockRejectedValueOnce(dbError)                                           // UPDATE dismissed fails
      .mockResolvedValueOnce({ rows: [] });                                     // ROLLBACK

    const res = await request(app)
      .post("/users")
      .send({ email: "applicant@example.com", roleId: 7 });

    expect(res.status).toBe(500);

    const rollbackCall = mockDbClientQuery.mock.calls.find(([sql]: [string]) =>
      /^ROLLBACK$/i.test(sql),
    );
    expect(rollbackCall).toBeDefined();
    expect(mockDbClientRelease).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// PATCH /users/:id — change a member's role and/or manager
// ---------------------------------------------------------------------------

describe("PATCH /users/:id — change role and/or manager", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubUserId = "user_abc";
    stubUserEmail = "owner@example.com";
  });

  it("returns 200 with the updated member row after a successful role change", async () => {
    const updatedMember = {
      id: 42,
      email: "member@example.com",
      role: "member",
      custom_role_id: 9,
      joined: true,
      joined_at: "2024-03-01T00:00:00Z",
      invited_at: "2024-01-01T00:00:00Z",
      invited_by_email: "owner@example.com",
      manager_member_id: null,
    };

    // First db.query:  role ownership check
    // Second db.query: existing custom_role_id lookup (for audit log)
    // Third db.query:  UPDATE workspace_members … RETURNING
    // Fourth db.query: audit log INSERT (old null → new 9)
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 9 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ custom_role_id: null }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [updatedMember], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app)
      .patch("/users/42")
      .send({ roleId: 9 });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("member");
    expect(res.body.member).toMatchObject({ id: 42, custom_role_id: 9 });
  });

  it("returns 200 with manager_email populated after a successful manager change", async () => {
    const updatedMember = {
      id: 42,
      email: "member@example.com",
      role: "member",
      custom_role_id: null,
      joined: true,
      joined_at: "2024-03-01T00:00:00Z",
      invited_at: "2024-01-01T00:00:00Z",
      invited_by_email: "owner@example.com",
      manager_member_id: 7,
    };

    // First db.query: manager workspace membership check
    // Second db.query: UPDATE … RETURNING
    // Third db.query: fetch manager's email
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [updatedMember], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ member_email: "manager@example.com" }] });

    const res = await request(app)
      .patch("/users/42")
      .send({ managerMemberId: 7 });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("member");
    expect(res.body.member).toMatchObject({
      id: 42,
      manager_member_id: 7,
      manager_email: "manager@example.com",
    });
  });

  it("returns 400 when trying to set a member as their own manager", async () => {
    const res = await request(app)
      .patch("/users/42")
      .send({ managerMemberId: 42 });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringMatching(/own manager/i) });
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 403 when the caller is not a workspace owner", async () => {
    stubActualRole = "member";

    const res = await request(app)
      .patch("/users/42")
      .send({ roleId: 9 });

    expect(res.status).toBe(403);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 200 even when the role_change_audit_log INSERT fails after the UPDATE succeeds", async () => {
    const updatedMember = {
      id: 42,
      email: "member@example.com",
      role: "member",
      custom_role_id: 9,
      joined: true,
      joined_at: "2024-03-01T00:00:00Z",
      invited_at: "2024-01-01T00:00:00Z",
      invited_by_email: "owner@example.com",
      manager_member_id: null,
    };

    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 9 }], rowCount: 1 })              // role ownership check
      .mockResolvedValueOnce({ rows: [{ custom_role_id: null }], rowCount: 1 }) // existing custom_role_id lookup
      .mockResolvedValueOnce({ rows: [updatedMember], rowCount: 1 })           // UPDATE workspace_members RETURNING
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                        // DELETE workspace_member_roles
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                        // INSERT workspace_member_roles
      .mockRejectedValueOnce(new Error("role_change_audit_log table missing")); // INSERT audit log fails (swallowed)

    const res = await request(app)
      .patch("/users/42")
      .send({ roleId: 9 });

    expect(res.status).toBe(200);
    expect(res.body.member).toMatchObject({ id: 42, custom_role_id: 9 });
  });

  it("returns 400 when the roleId belongs to a different workspace", async () => {
    // Role check returns zero rows — role not found in this workspace
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .patch("/users/42")
      .send({ roleId: 999 });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringMatching(/role not found/i) });
  });

  it("returns 200 with both fields updated when roleId and managerMemberId are sent together", async () => {
    const updatedMember = {
      id: 42,
      email: "member@example.com",
      role: "member",
      custom_role_id: 9,
      joined: true,
      joined_at: "2024-03-01T00:00:00Z",
      invited_at: "2024-01-01T00:00:00Z",
      invited_by_email: "owner@example.com",
      manager_member_id: 7,
    };

    // Call 1: role ownership check
    // Call 2: manager workspace membership check
    // Call 3: existing custom_role_id lookup (for audit log)
    // Call 4: UPDATE workspace_members … RETURNING
    // Call 5: DELETE workspace_member_roles (multi-role junction table)
    // Call 6: INSERT workspace_member_roles
    // Call 7: audit log INSERT (old null → new 9)
    // Call 8: fetch manager's email
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 9 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ custom_role_id: null }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [updatedMember], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ member_email: "manager@example.com" }] });

    const res = await request(app)
      .patch("/users/42")
      .send({ roleId: 9, managerMemberId: 7 });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("member");
    expect(res.body.member).toMatchObject({
      id: 42,
      custom_role_id: 9,
      manager_member_id: 7,
      manager_email: "manager@example.com",
    });

    // Verify the exact number of db calls: role check + manager check + existing + UPDATE + DELETE wmr + INSERT wmr + audit INSERT + email lookup
    expect(mockDbQuery).toHaveBeenCalledTimes(8);
  });
});

// ---------------------------------------------------------------------------
// DELETE /users/:id then POST /users — re-invite sends a fresh email
// ---------------------------------------------------------------------------

describe("DELETE /users/:id followed by POST /users — re-invite sends a fresh invite email", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubUserId = "user_abc";
    stubUserEmail = "owner@example.com";
    mockDbClientQuery.mockResolvedValue({ rows: [] });
    mockDbClientRelease.mockReturnValue(undefined);
  });

  it("calls sendInviteEmail exactly once for the re-invite POST after the same member is deleted", async () => {
    mockSendInviteEmail.mockResolvedValue(undefined);

    const TARGET_EMAIL = "reinvited@example.com";
    const ROLE_ID = 7;
    const ROLE_NAME = "Designer";
    const MEMBER_ID = 99;

    // ── Step 1: initial invite ──────────────────────────────────────────────
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: ROLE_ID, name: ROLE_NAME }], rowCount: 1 }); // role check
    mockDbClientQuery
      .mockResolvedValueOnce({ rows: [] })  // BEGIN
      .mockResolvedValueOnce({
        rows: [{
          id: MEMBER_ID,
          email: TARGET_EMAIL,
          role: "member",
          custom_role_id: ROLE_ID,
          joined: false,
          joined_at: null,
          invited_at: "2024-06-01T00:00:00Z",
          invited_by_email: "owner@example.com",
          manager_member_id: null,
          manager_email: null,
        }],
        rowCount: 1,
      })                                    // INSERT
      .mockResolvedValueOnce({ rows: [] }) // UPDATE dismissed
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const firstInviteRes = await request(app)
      .post("/users")
      .send({ email: TARGET_EMAIL, roleId: ROLE_ID });

    expect(firstInviteRes.status).toBe(200);
    expect(mockSendInviteEmail).toHaveBeenCalledTimes(1);

    // ── Step 2: delete that member (same id returned from step 1) ──────────
    // Pending invite: member_user_id is null → no Clerk deletion
    mockDbQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ member_user_id: null }] });

    const deleteRes = await request(app).delete(`/users/${MEMBER_ID}`);
    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body).toEqual({ ok: true });

    // Deletion must not trigger any additional email call
    expect(mockSendInviteEmail).toHaveBeenCalledTimes(1);

    // ── Step 3: re-invite the same email ───────────────────────────────────
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: ROLE_ID, name: ROLE_NAME }], rowCount: 1 }); // role check
    mockDbClientQuery
      .mockResolvedValueOnce({ rows: [] })  // BEGIN
      .mockResolvedValueOnce({
        rows: [{
          id: 101,
          email: TARGET_EMAIL,
          role: "member",
          custom_role_id: ROLE_ID,
          joined: false,
          joined_at: null,
          invited_at: "2024-06-02T00:00:00Z",
          invited_by_email: "owner@example.com",
          manager_member_id: null,
          manager_email: null,
        }],
        rowCount: 1,
      })                                    // INSERT
      .mockResolvedValueOnce({ rows: [] }) // UPDATE dismissed
      .mockResolvedValueOnce({ rows: [] }); // COMMIT

    const reInviteRes = await request(app)
      .post("/users")
      .send({ email: TARGET_EMAIL, roleId: ROLE_ID });

    expect(reInviteRes.status).toBe(200);
    expect(reInviteRes.body).toHaveProperty("member");

    // sendInviteEmail must have been called exactly once more — for the re-invite
    expect(mockSendInviteEmail).toHaveBeenCalledTimes(2);
    expect(mockSendInviteEmail).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        toEmail: TARGET_EMAIL,
        invitedByEmail: "owner@example.com",
        role: ROLE_NAME,
        isAccessApproval: false,
        inviteToken: expect.any(String),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// DELETE /users/:id — Clerk deletion
// ---------------------------------------------------------------------------

describe("DELETE /users/:id — Clerk deletion", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubUserId = "user_abc";
    stubUserEmail = "owner@example.com";
    mockDeleteUser.mockResolvedValue(undefined);
    mockGetSessionList.mockResolvedValue({ data: [] });
    mockRevokeSession.mockResolvedValue(undefined);
  });

  it("calls clerkClient.users.deleteUser with the member's Clerk user ID for a joined member", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ member_user_id: "user_clerk_xyz" }],
    });

    const res = await request(app).delete("/users/42");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockDeleteUser).toHaveBeenCalledOnce();
    expect(mockDeleteUser).toHaveBeenCalledWith("user_clerk_xyz");
  });

  it("does not call clerkClient.users.deleteUser for a pending invite (member_user_id is null)", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ member_user_id: null }],
    });

    const res = await request(app).delete("/users/43");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockDeleteUser).not.toHaveBeenCalled();
    expect(mockGetSessionList).not.toHaveBeenCalled();
  });

  it("still returns 200 { ok: true } when Clerk returns a 404 (user already deleted)", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ member_user_id: "user_clerk_gone" }],
    });
    mockDeleteUser.mockRejectedValueOnce(Object.assign(new Error("Not found"), { status: 404 }));

    const res = await request(app).delete("/users/44");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockReqLogError).not.toHaveBeenCalled();
  });

  it("still returns 200 { ok: true } and logs the error when Clerk fails with a non-404 error", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ member_user_id: "user_clerk_err" }],
    });
    mockDeleteUser.mockRejectedValueOnce(Object.assign(new Error("Server error"), { status: 500 }));

    const res = await request(app).delete("/users/45");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockReqLogError).toHaveBeenCalledOnce();
    expect(mockReqLogError).toHaveBeenCalledWith(
      expect.objectContaining({ memberUserId: "user_clerk_err" }),
      "Failed to delete Clerk user after member removal",
    );
  });

  it("revokes all active sessions before deleting the user", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ member_user_id: "user_clerk_sessions" }],
    });
    mockGetSessionList.mockResolvedValueOnce({
      data: [{ id: "sess_aaa" }, { id: "sess_bbb" }],
    });

    const res = await request(app).delete("/users/46");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockGetSessionList).toHaveBeenCalledOnce();
    expect(mockGetSessionList).toHaveBeenCalledWith({ userId: "user_clerk_sessions" });
    expect(mockRevokeSession).toHaveBeenCalledTimes(2);
    expect(mockRevokeSession).toHaveBeenCalledWith("sess_aaa");
    expect(mockRevokeSession).toHaveBeenCalledWith("sess_bbb");
    expect(mockDeleteUser).toHaveBeenCalledOnce();
  });

  it("still deletes the user and returns 200 when session revocation fails", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ member_user_id: "user_clerk_revoke_fail" }],
    });
    mockGetSessionList.mockRejectedValueOnce(new Error("Clerk unavailable"));

    const res = await request(app).delete("/users/47");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockReqLogError).toHaveBeenCalledWith(
      expect.objectContaining({ memberUserId: "user_clerk_revoke_fail" }),
      "Failed to revoke Clerk sessions before member deletion",
    );
    expect(mockDeleteUser).toHaveBeenCalledOnce();
    expect(mockDeleteUser).toHaveBeenCalledWith("user_clerk_revoke_fail");
  });

  it("skips session revocation and delete for a pending invite", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ member_user_id: null }],
    });

    const res = await request(app).delete("/users/48");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockGetSessionList).not.toHaveBeenCalled();
    expect(mockRevokeSession).not.toHaveBeenCalled();
    expect(mockDeleteUser).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GET /users/me/preferences & PATCH /users/me/preferences
// ---------------------------------------------------------------------------

describe("GET /users/me/preferences", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubMemberDbId = 7;
    stubActualRole = "member";
    stubUserId = "user_abc";
  });

  it("returns empty object for a new member with no preferences set", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ ui_preferences: {} }],
    });

    const res = await request(app).get("/users/me/preferences");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ui_preferences: {} });
    expect(mockDbQuery).toHaveBeenCalledOnce();
    expect(mockDbQuery.mock.calls[0][1]).toEqual([7]);
  });

  it("returns existing preferences when the member has some set", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ ui_preferences: { show_spend_column: true } }],
    });

    const res = await request(app).get("/users/me/preferences");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ui_preferences: { show_spend_column: true } });
  });

  it("returns 404 when memberDbId is null", async () => {
    stubMemberDbId = null;

    const res = await request(app).get("/users/me/preferences");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Member record not found" });
    expect(mockDbQuery).not.toHaveBeenCalled();
  });
});

describe("PATCH /users/me/preferences", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubMemberDbId = 7;
    stubActualRole = "member";
    stubUserId = "user_abc";
  });

  it("persists show_spend_column: true and returns the updated prefs", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ ui_preferences: { show_spend_column: true } }],
    });

    const res = await request(app)
      .patch("/users/me/preferences")
      .send({ show_spend_column: true });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ui_preferences: { show_spend_column: true } });
    expect(mockDbQuery).toHaveBeenCalledOnce();
    const [sql, params] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/UPDATE workspace_members/i);
    expect(params[0]).toBe(JSON.stringify({ show_spend_column: true }));
    expect(params[1]).toBe(7);
  });

  it("persists show_spend_column: false", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ ui_preferences: { show_spend_column: false } }],
    });

    const res = await request(app)
      .patch("/users/me/preferences")
      .send({ show_spend_column: false });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ui_preferences: { show_spend_column: false } });
  });

  it("reflects the updated value on a subsequent GET", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ ui_preferences: { show_spend_column: true } }],
    });

    const patchRes = await request(app)
      .patch("/users/me/preferences")
      .send({ show_spend_column: true });

    expect(patchRes.status).toBe(200);

    mockDbQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ ui_preferences: { show_spend_column: true } }],
    });

    const getRes = await request(app).get("/users/me/preferences");

    expect(getRes.status).toBe(200);
    expect(getRes.body).toEqual({ ui_preferences: { show_spend_column: true } });
  });

  it("rejects an unknown key with 400", async () => {
    const res = await request(app)
      .patch("/users/me/preferences")
      .send({ unknown_key: true });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "No recognised preference keys provided" });
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("rejects show_spend_column with a non-boolean value with 400", async () => {
    const res = await request(app)
      .patch("/users/me/preferences")
      .send({ show_spend_column: "yes" });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "show_spend_column must be a boolean" });
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("rejects a non-object body with 400", async () => {
    const res = await request(app)
      .patch("/users/me/preferences")
      .send([{ show_spend_column: true }]);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Body must be a JSON object" });
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 404 when memberDbId is null", async () => {
    stubMemberDbId = null;

    const res = await request(app)
      .patch("/users/me/preferences")
      .send({ show_spend_column: true });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Member record not found" });
    expect(mockDbQuery).not.toHaveBeenCalled();
  });
});
