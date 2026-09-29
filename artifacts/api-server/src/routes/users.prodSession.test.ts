/**
 * Regression test for the production "session expired" incident:
 * a VALID production Clerk session (issuer clerk.presentail.com) calling
 * GET /api/users must reach the route and return 200 — and the two failure
 * modes must map to distinct statuses:
 *   - no Clerk session            → 401 (auth failure)
 *   - session OK, no OS membership → 403 { error: "no_access" } (account
 *     mapping problem — must NOT be presented as an expired session)
 *
 * Unlike users.test.ts (which stubs auth/workspace), this file runs the REAL
 * requireAuth and resolveWorkspace middleware; only @clerk/express and the DB
 * are mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ---------------------------------------------------------------------------
// Mocks — declared before importing the modules under test
// ---------------------------------------------------------------------------

const PROD_USER_ID = "user_3DRR3R8a_regression";
const PROD_EMAIL = "owner@presentail.com";

// Production-shaped Clerk session claims (issuer clerk.presentail.com).
let mockAuthResult: { userId: string | null; sessionClaims?: Record<string, unknown> } | null = null;

const mockGetUser = vi.fn();
const mockVerifyToken = vi.fn();

vi.mock("@clerk/express", () => ({
  getAuth: () => mockAuthResult,
  verifyToken: (...args: unknown[]) => mockVerifyToken(...args),
  clerkClient: {
    users: {
      getUser: (...args: unknown[]) => mockGetUser(...args),
      deleteUser: vi.fn(),
    },
    sessions: { getSessionList: vi.fn(), revokeSession: vi.fn() },
  },
}));

const mockDbQuery = vi.fn();
const mockClientQuery = vi.fn();

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
    connect: async () => ({
      query: (...args: unknown[]) => mockClientQuery(...args),
      release: vi.fn(),
    }),
  },
  withTransaction: async (
    client: { query: (...a: unknown[]) => unknown },
    fn: () => Promise<unknown>,
  ) => fn(),
}));

vi.mock("../lib/email", () => ({ sendInviteEmail: vi.fn() }));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import usersRouter from "./users";

// ---------------------------------------------------------------------------
// Test app — mirrors production mounting (router under /api)
// ---------------------------------------------------------------------------

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: Record<string, ReturnType<typeof vi.fn>> }).log = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    };
    next();
  });
  app.use("/api", usersRouter);
  return app;
}

const app = makeApp();

const MEMBERSHIP_ROW = {
  id: 75,
  workspace_owner_id: PROD_USER_ID,
  role: "owner",
  member_email: PROD_EMAIL,
  custom_role_id: null,
  allowed_pages: null,
  revoked_at: null,
  access_expires_at: null,
};

/** Route db.query by SQL text — order-independent, resilient to new queries. */
function routeDbBySql() {
  mockDbQuery.mockImplementation((sql: string) => {
    if (sql.includes("wm.member_user_id = $1") && sql.includes("wm.revoked_at IS NULL")) {
      // findMembership (resolveWorkspace)
      return Promise.resolve({ rows: [MEMBERSHIP_ROW] });
    }
    if (sql.includes("wm.workspace_owner_id = $1")) {
      // GET /users member list
      return Promise.resolve({
        rows: [
          {
            id: 75,
            email: PROD_EMAIL,
            role: "owner",
            custom_role_id: null,
            member_user_id: PROD_USER_ID,
            joined: true,
            joined_at: "2026-05-08T12:18:19.102Z",
            invited_at: "2026-05-08T12:18:19.102Z",
            invited_by_email: null,
            role_name: null,
            manager_member_id: null,
            manager_email: null,
            job_title: null,
            start_date: null,
            department: null,
            location: null,
            employment_type: null,
            employment_status: null,
            working_days: null,
            florist_location_id: null,
            invite_token: null,
            access_expires_at: null,
            revoked_at: null,
          },
        ],
      });
    }
    // member_locations batch fetch, and anything else
    return Promise.resolve({ rows: [] });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CLERK_SECRET_KEY = "sk_test_current-instance";
  mockAuthResult = null;
  mockGetUser.mockResolvedValue({
    id: PROD_USER_ID,
    primaryEmailAddressId: "em_1",
    emailAddresses: [{ id: "em_1", emailAddress: PROD_EMAIL }],
  });
});

describe("GET /api/users with a production-shaped Clerk session", () => {
  it("returns 200 and the member list for a valid session with an OS membership", async () => {
    mockAuthResult = {
      userId: PROD_USER_ID,
      sessionClaims: {
        iss: "https://clerk.presentail.com",
        azp: "https://os.presentail.com",
        sub: PROD_USER_ID,
      },
    };
    mockVerifyToken.mockResolvedValue({ sub: PROD_USER_ID });
    routeDbBySql();

    const res = await request(app)
      .get("/api/users")
      .set("Authorization", "Bearer header.payload.signature");

    expect(res.status).toBe(200);
    expect(res.body.members).toHaveLength(1);
    expect(res.body.members[0].email).toBe(PROD_EMAIL);
    expect(res.body.me).toMatchObject({ role: "owner", email: PROD_EMAIL });
  });

  it("returns 401 when there is no Clerk session at all", async () => {
    mockAuthResult = null;
    const res = await request(app).get("/api/users");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it.each([
    ["expired", new Error("token is expired")],
    ["invalid", new Error("token signature is invalid")],
  ])("returns 401 for an explicitly rejected %s bearer token", async (_label, error) => {
    mockAuthResult = null;
    mockVerifyToken.mockRejectedValue(error);

    const res = await request(app)
      .get("/api/users")
      .set("Authorization", "Bearer header.payload.signature");

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
    expect(mockVerifyToken).toHaveBeenCalledWith(
      "header.payload.signature",
      { secretKey: "sk_test_current-instance" },
    );
  });

  it("returns 401 for a cookie-only identity even when Clerk middleware hydrated a stale user", async () => {
    mockAuthResult = {
      userId: "user_from_old_clerk_instance",
      sessionClaims: {
        iss: "https://old-clerk-instance.example",
        sub: "user_from_old_clerk_instance",
      },
    };
    mockDbQuery.mockResolvedValue({ rows: [] });
    mockGetUser.mockRejectedValue({
      status: 404,
      errors: [{ code: "resource_not_found" }],
    });

    const res = await request(app)
      .get("/api/users")
      .set("Host", "os.presentail.com")
      .set("Cookie", "__session=stale-old-instance-token; __client_uat=123");

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: "Unauthorized",
      code: "stale_clerk_session",
    });
    const clearedCookies = res.headers["set-cookie"] as unknown as string[];
    expect(clearedCookies).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^__session=;/),
        expect.stringMatching(/^__client_uat=;/),
        expect.stringMatching(/^__session=;.*Domain=\.presentail\.com/i),
        expect.stringMatching(/^__client_uat=;.*Domain=\.presentail\.com/i),
      ]),
    );
    expect(mockVerifyToken).not.toHaveBeenCalled();
    expect(mockGetUser).toHaveBeenCalledWith("user_from_old_clerk_instance");
    expect(mockDbQuery).toHaveBeenCalledOnce();
  });

  it("returns 403 no_access (NOT 401) when the session is valid but no OS membership exists", async () => {
    mockAuthResult = {
      userId: "user_without_membership",
      sessionClaims: {
        iss: "https://clerk.presentail.com",
        azp: "https://os.presentail.com",
        sub: "user_without_membership",
      },
    };
    mockVerifyToken.mockResolvedValue({ sub: "user_without_membership" });
    // findMembership and everything else → empty; claimMembership tx → empty.
    mockDbQuery.mockResolvedValue({ rows: [] });
    mockClientQuery.mockResolvedValue({ rows: [] });

    const res = await request(app)
      .get("/api/users")
      .set("Authorization", "Bearer header.payload.signature");

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "no_access" });
  });
});
