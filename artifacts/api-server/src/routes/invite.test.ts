import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ---------------------------------------------------------------------------
// Mocks — declared before importing the module under test
// ---------------------------------------------------------------------------

const mockDbQuery = vi.fn();
const mockDbConnect = vi.fn();

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
    connect: (...args: unknown[]) => mockDbConnect(...args),
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

const mockGetClerkUser = vi.fn();

vi.mock("@clerk/express", () => ({
  clerkClient: {
    users: {
      getUser: (...args: unknown[]) => mockGetClerkUser(...args),
    },
  },
}));

const mockSendInviteEmail = vi.fn();

vi.mock("../lib/email", () => ({
  sendInviteEmail: (...args: unknown[]) => mockSendInviteEmail(...args),
}));

import type { WorkspaceRequest } from "../lib/workspace";

let stubWorkspaceOwnerId = "owner_123";
let stubActualRole = "owner";
let stubUserId = "user_abc";
let stubUserEmail: string | null = "owner@example.com";

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = stubWorkspaceOwnerId;
    wreq.workspaceActualRole = stubActualRole;
    wreq.workspaceRole = stubActualRole === "owner" ? "owner" : "member";
    wreq.userId = stubUserId;
    wreq.userEmail = stubUserEmail;
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

import inviteRouter from "./invite";
import usersRouter from "./users";

// ---------------------------------------------------------------------------
// Test app
// ---------------------------------------------------------------------------

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(inviteRouter);
  return app;
}

// ---------------------------------------------------------------------------
// GET /invite/:token
// ---------------------------------------------------------------------------

describe("GET /invite/:token", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("returns 200 with email, invitedBy, and workspaceName for a valid unclaimed token", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          member_email: "invited@example.com",
          invited_by_email: "boss@example.com",
          workspace_owner_id: "clerk_owner_id",
          member_user_id: null,
        },
      ],
      rowCount: 1,
    });
    mockGetClerkUser.mockResolvedValueOnce({
      firstName: "Alice",
      lastName: "Smith",
      primaryEmailAddress: null,
    });

    const res = await request(app).get("/invite/valid-token-abc");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      email: "invited@example.com",
      invitedBy: "boss@example.com",
      workspaceName: "Alice Smith's workspace",
    });
  });

  it("returns 404 when the token does not match any row (e.g. after a resend invalidates the old token)", async () => {
    // Simulates what happens when the old invite_token has been overwritten by resend-invite:
    // the DB no longer holds a row matching the superseded token.
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/invite/superseded-old-token");

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: expect.any(String) });
  });

  it("returns 410 when the invite token has already been claimed (member_user_id is set)", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          member_email: "claimed@example.com",
          invited_by_email: "boss@example.com",
          workspace_owner_id: "clerk_owner_id",
          member_user_id: "user_already_joined",
        },
      ],
      rowCount: 1,
    });

    const res = await request(app).get("/invite/already-claimed-token");

    expect(res.status).toBe(410);
    expect(res.body).toMatchObject({ error: expect.any(String) });
  });

  it("returns 400 for a token that exceeds 128 characters", async () => {
    const longToken = "a".repeat(129);

    const res = await request(app).get(`/invite/${longToken}`);

    expect(res.status).toBe(400);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("still returns 200 even when the Clerk user lookup fails (workspaceName is null)", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          member_email: "invited@example.com",
          invited_by_email: "boss@example.com",
          workspace_owner_id: "clerk_owner_id",
          member_user_id: null,
        },
      ],
      rowCount: 1,
    });
    mockGetClerkUser.mockRejectedValueOnce(new Error("Clerk unavailable"));

    const res = await request(app).get("/invite/valid-token-xyz");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      email: "invited@example.com",
      invitedBy: "boss@example.com",
    });
    expect(res.body.workspaceName).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GET /invite/:old-token after resend-invite — token invalidation
// ---------------------------------------------------------------------------

describe("Token invalidation: old invite token is rejected after resend", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("returns 404 for the old token once a new one has been issued", async () => {
    // After POST /users/:id/resend-invite updates invite_token to a new UUID,
    // the old token is no longer stored in any row.  The GET /invite/:token
    // handler will find no matching row and respond with 404.
    const OLD_TOKEN = "aaaaaaaa-old-token-no-longer-in-db";

    // Simulate the DB state after resend: the old token is gone.
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get(`/invite/${OLD_TOKEN}`);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "Invite not found" });
  });
});

// ---------------------------------------------------------------------------
// End-to-end chained scenario: resend-invite → old token rejected
// ---------------------------------------------------------------------------

describe("Chained: POST /users/:id/resend-invite then GET /invite/:oldToken", () => {
  // Mount both routers on a single combined app so the full flow is exercised
  // in a single test without crossing process boundaries.
  const combinedApp = express();
  combinedApp.use(express.json());
  combinedApp.use(usersRouter);
  combinedApp.use(inviteRouter);

  const OLD_TOKEN = "bbbbbbbb-original-token-before-resend";
  const MEMBER_ID = 77;
  const PENDING_MEMBER_ROW = {
    id: MEMBER_ID,
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
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubActualRole = "owner";
    stubWorkspaceOwnerId = "owner_123";
    stubUserEmail = "owner@example.com";
    mockSendInviteEmail.mockResolvedValue(undefined);
  });

  it("rejects the old invite token with 404 after a successful resend-invite", async () => {
    // Step 1 — resend-invite: UPDATE sets a new token, role lookup follows
    mockDbQuery
      .mockResolvedValueOnce({ rows: [PENDING_MEMBER_ROW], rowCount: 1 })   // UPDATE workspace_members
      .mockResolvedValueOnce({ rows: [{ name: "Designer" }] });              // SELECT role name

    const resendRes = await request(combinedApp)
      .post(`/users/${MEMBER_ID}/resend-invite`);

    expect(resendRes.status).toBe(200);
    expect(resendRes.body).toHaveProperty("member");

    // Capture the new token that was written to the DB (first param of first query)
    const newToken = mockDbQuery.mock.calls[0][1][0] as string;
    expect(newToken).toBeTruthy();
    expect(newToken).not.toBe(OLD_TOKEN);

    // Step 2 — attempt to use the OLD token: DB returns no row (it now holds newToken)
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const oldTokenRes = await request(combinedApp).get(`/invite/${OLD_TOKEN}`);

    expect(oldTokenRes.status).toBe(404);
    expect(oldTokenRes.body).toMatchObject({ error: "Invite not found" });
  });

  it("allows the NEW token to be used after a successful resend-invite", async () => {
    // Step 1 — resend-invite
    mockDbQuery
      .mockResolvedValueOnce({ rows: [PENDING_MEMBER_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ name: "Designer" }] });

    await request(combinedApp).post(`/users/${MEMBER_ID}/resend-invite`);

    const newToken = mockDbQuery.mock.calls[0][1][0] as string;

    // Step 2 — use the NEW token: DB now returns the member row (token matches)
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          member_email: PENDING_MEMBER_ROW.email,
          invited_by_email: PENDING_MEMBER_ROW.invited_by_email,
          workspace_owner_id: stubWorkspaceOwnerId,
          member_user_id: null,
        },
      ],
      rowCount: 1,
    });
    mockGetClerkUser.mockRejectedValueOnce(new Error("Clerk not needed here"));

    const newTokenRes = await request(combinedApp).get(`/invite/${newToken}`);

    expect(newTokenRes.status).toBe(200);
    expect(newTokenRes.body).toMatchObject({
      email: PENDING_MEMBER_ROW.email,
      invitedBy: PENDING_MEMBER_ROW.invited_by_email,
    });
  });
});

// ---------------------------------------------------------------------------
// GET /invite/:token — expiry checks
// ---------------------------------------------------------------------------

describe("GET /invite/:token — expiry", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("returns 410 with 'Invite expired' when invite_expires_at is in the past", async () => {
    const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000); // yesterday
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          member_email: "expired@example.com",
          invited_by_email: "boss@example.com",
          workspace_owner_id: "clerk_owner_id",
          member_user_id: null,
          invite_expires_at: pastDate,
        },
      ],
      rowCount: 1,
    });

    const res = await request(app).get("/invite/expired-token");

    expect(res.status).toBe(410);
    expect(res.body).toMatchObject({ error: "Invite expired" });
    expect(mockGetClerkUser).not.toHaveBeenCalled();
  });

  it("returns 200 when invite_expires_at is in the future", async () => {
    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // one week from now
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          member_email: "valid@example.com",
          invited_by_email: "boss@example.com",
          workspace_owner_id: "clerk_owner_id",
          member_user_id: null,
          invite_expires_at: futureDate,
        },
      ],
      rowCount: 1,
    });
    mockGetClerkUser.mockResolvedValueOnce({
      firstName: "Bob",
      lastName: "Jones",
      primaryEmailAddress: null,
    });

    const res = await request(app).get("/invite/not-yet-expired-token");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ email: "valid@example.com" });
  });

  it("returns 200 when invite_expires_at is null (no expiry set)", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          member_email: "no-expiry@example.com",
          invited_by_email: "boss@example.com",
          workspace_owner_id: "clerk_owner_id",
          member_user_id: null,
          invite_expires_at: null,
        },
      ],
      rowCount: 1,
    });
    mockGetClerkUser.mockResolvedValueOnce({
      firstName: "Carol",
      lastName: null,
      primaryEmailAddress: null,
    });

    const res = await request(app).get("/invite/no-expiry-token");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ email: "no-expiry@example.com" });
  });
});

// ---------------------------------------------------------------------------
// POST /invite/claim — expiry and basic flow checks
// ---------------------------------------------------------------------------

describe("POST /invite/claim — expiry", () => {
  const app = makeApp();

  // A reusable mock client factory for db.connect()
  function makeMockClient(queries: Array<{ rows: unknown[]; rowCount: number }>) {
    const mockClientQuery = vi.fn();
    queries.forEach((result) => mockClientQuery.mockResolvedValueOnce(result));
    // Any extra calls (BEGIN, COMMIT, ROLLBACK) return a harmless empty result
    mockClientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    return {
      query: mockClientQuery,
      release: vi.fn(),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("returns 410 with 'Invite expired' when the invite has expired at claim time", async () => {
    const pastDate = new Date(Date.now() - 60 * 60 * 1000); // one hour ago

    mockGetClerkUser.mockResolvedValueOnce({
      primaryEmailAddress: { emailAddress: "claimer@example.com" },
      emailAddresses: [],
    });

    const client = makeMockClient([
      { rows: [], rowCount: 0 },            // BEGIN
      {
        rows: [{ member_email: "claimer@example.com", invite_expires_at: pastDate, workspace_owner_id: "owner_123" }],
        rowCount: 1,
      },                                    // invite row lookup → expired invite
    ]);
    mockDbConnect.mockResolvedValueOnce(client);

    const res = await request(app)
      .post("/invite/claim")
      .send({ token: "expired-claim-token" });

    expect(res.status).toBe(410);
    expect(res.body).toMatchObject({ error: "Invite expired" });
  });

  it("returns 200 when the invite is valid (not yet expired) at claim time", async () => {
    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    mockGetClerkUser.mockResolvedValueOnce({
      primaryEmailAddress: { emailAddress: "claimer@example.com" },
      emailAddresses: [],
    });

    const client = makeMockClient([
      { rows: [], rowCount: 0 },            // BEGIN
      {
        rows: [{ member_email: "claimer@example.com", invite_expires_at: futureDate, workspace_owner_id: "owner_123" }],
        rowCount: 1,
      },                                    // invite row → valid, not expired
      { rows: [], rowCount: 0 },            // existing membership check → none
      { rows: [], rowCount: 1 },            // UPDATE (claim)
    ]);
    mockDbConnect.mockResolvedValueOnce(client);

    const res = await request(app)
      .post("/invite/claim")
      .send({ token: "valid-claim-token" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
  });

  it("returns 200 when invite_expires_at is null (no expiry) at claim time", async () => {
    mockGetClerkUser.mockResolvedValueOnce({
      primaryEmailAddress: { emailAddress: "claimer@example.com" },
      emailAddresses: [],
    });

    const client = makeMockClient([
      { rows: [], rowCount: 0 },            // BEGIN
      {
        rows: [{ member_email: "claimer@example.com", invite_expires_at: null, workspace_owner_id: "owner_123" }],
        rowCount: 1,
      },                                    // invite row → no expiry set
      { rows: [], rowCount: 0 },            // existing membership check → none
      { rows: [], rowCount: 1 },            // UPDATE (claim)
    ]);
    mockDbConnect.mockResolvedValueOnce(client);

    const res = await request(app)
      .post("/invite/claim")
      .send({ token: "no-expiry-claim-token" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
  });

  it("returns 410 when the invite token is not found or already used at claim time", async () => {
    mockGetClerkUser.mockResolvedValueOnce({
      primaryEmailAddress: { emailAddress: "claimer@example.com" },
      emailAddresses: [],
    });

    const client = makeMockClient([
      { rows: [], rowCount: 0 },   // BEGIN
      { rows: [], rowCount: 0 },   // invite row lookup → not found / already claimed
    ]);
    mockDbConnect.mockResolvedValueOnce(client);

    const res = await request(app)
      .post("/invite/claim")
      .send({ token: "invalid-or-used-token" });

    expect(res.status).toBe(410);
    expect(res.body).toMatchObject({ error: expect.stringContaining("Invite token") });
  });

  it("returns 200 with alreadyMember when the user is already a member of this workspace (idempotent re-claim)", async () => {
    mockGetClerkUser.mockResolvedValueOnce({
      primaryEmailAddress: { emailAddress: "already@example.com" },
      emailAddresses: [],
    });

    const client = makeMockClient([
      { rows: [], rowCount: 0 },            // BEGIN
      {
        rows: [{ member_email: "already@example.com", invite_expires_at: null, workspace_owner_id: "owner_123" }],
        rowCount: 1,
      },                                    // invite row → found (token still unclaimed in DB)
      { rows: [{ id: 5 }], rowCount: 1 },  // existing membership check → already a member of this workspace
      { rows: [], rowCount: 0 },            // UPDATE (no-op — member_user_id was already set by some other path)
    ]);
    mockDbConnect.mockResolvedValueOnce(client);

    const res = await request(app)
      .post("/invite/claim")
      .send({ token: "any-token" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, alreadyMember: true });
  });

  it("still claims the invite when the user already has a membership in a different workspace", async () => {
    // Regression test for the cross-workspace short-circuit bug:
    // a user with a membership in workspace B must still be able to claim an
    // invite for workspace A, and after claiming, GET /invite/:token must
    // return 410 ("already used") instead of 200.

    mockGetClerkUser.mockResolvedValueOnce({
      primaryEmailAddress: { emailAddress: "migrated@example.com" },
      emailAddresses: [],
    });

    const client = makeMockClient([
      { rows: [], rowCount: 0 },            // BEGIN
      {
        rows: [{ member_email: "migrated@example.com", invite_expires_at: null, workspace_owner_id: "workspace_A_owner" }],
        rowCount: 1,
      },                                    // invite row lookup → found for workspace A
      { rows: [], rowCount: 0 },            // existing membership check for workspace A → none (user only has workspace B)
      { rows: [], rowCount: 1 },            // UPDATE → claims the token
    ]);
    mockDbConnect.mockResolvedValueOnce(client);

    const res = await request(app)
      .post("/invite/claim")
      .send({ token: "workspace-a-invite-token" });

    expect(res.status).toBe(200);
    // Must NOT include alreadyMember — the user was not already a member of workspace A
    expect(res.body).toMatchObject({ ok: true });
    expect(res.body.alreadyMember).toBeUndefined();

    // Verify the UPDATE was called (token was claimed) and the correct token was used
    const updateCall = client.query.mock.calls.find(
      (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("UPDATE workspace_members"),
    );
    expect(updateCall).toBeDefined();
    // The second param in the UPDATE params array is the invite token
    expect((updateCall![1] as unknown[])[1]).toBe("workspace-a-invite-token");
  });

  it("returns 400 when no token is provided", async () => {
    const res = await request(app)
      .post("/invite/claim")
      .send({});

    expect(res.status).toBe(400);
    expect(mockDbConnect).not.toHaveBeenCalled();
  });
});
