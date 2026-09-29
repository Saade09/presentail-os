import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetUserList = vi.fn();
const mockVerifyPassword = vi.fn();
const mockCreateSession = vi.fn();
const mockGetSession = vi.fn();
const mockGetUser = vi.fn();
const mockRevokeSession = vi.fn();
const mockCreateSignInToken = vi.fn();
const mockDbQuery = vi.fn();

vi.mock("@clerk/express", () => ({
  getAuth: vi.fn(() => ({ userId: null, sessionClaims: null })),
  verifyToken: vi.fn(),
  clerkClient: {
    users: {
      getUserList: (...args: unknown[]) => mockGetUserList(...args),
      verifyPassword: (...args: unknown[]) => mockVerifyPassword(...args),
      getUser: (...args: unknown[]) => mockGetUser(...args),
    },
    sessions: {
      createSession: (...args: unknown[]) => mockCreateSession(...args),
      getSession: (...args: unknown[]) => mockGetSession(...args),
      revokeSession: (...args: unknown[]) => mockRevokeSession(...args),
    },
    signInTokens: {
      createSignInToken: (...args: unknown[]) => mockCreateSignInToken(...args),
    },
  },
}));

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
  },
}));

import mobileAuthRouter from "./mobileAuth";

function app() {
  const value = express();
  value.use(express.json());
  value.use((req, _res, next) => {
    (req as unknown as { log: Record<string, unknown> }).log = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    };
    next();
  });
  value.use("/api", mobileAuthRouter);
  return value;
}

describe("mobile password authentication in production Clerk", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MOBILE_JWT_SECRET = "test-mobile-secret";
    mockGetUserList.mockResolvedValue({
      data: [
        {
          id: "user_1",
          passwordEnabled: true,
          primaryEmailAddressId: "email_1",
          emailAddresses: [{ id: "email_1", emailAddress: "member@example.com" }],
          firstName: "Pat",
          lastName: "Member",
        },
      ],
    });
    mockVerifyPassword.mockResolvedValue({ verified: true });
    mockCreateSession.mockRejectedValue({
      errors: [{ code: "request_invalid_for_environment" }],
    });
    mockGetUser.mockResolvedValue({
      id: "user_1",
      banned: false,
      locked: false,
      updatedAt: 1_700_000_000_000,
    });
    mockDbQuery.mockResolvedValue({ rowCount: 1, rows: [{ "?column?": 1 }] });
    mockCreateSignInToken.mockResolvedValue({ token: "ticket_mobile_1" });
  });

  it("returns a usable token instead of HTTP 500", async () => {
    const login = await request(app())
      .post("/api/mobile/auth/login")
      .send({ email: "member@example.com", password: "correct-password" });

    expect(login.status).toBe(200);
    expect(login.body.token).toEqual(expect.any(String));
    expect(login.body.user.email).toBe("member@example.com");
    expect(mockDbQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO mobile_auth_sessions"),
      expect.arrayContaining(["user_1", 1_700_000_000_000]),
    );

    const me = await request(app())
      .get("/api/mobile/auth/me")
      .set("Authorization", `Bearer ${login.body.token}`);

    expect(me.status).toBe(200);
    expect(me.body).toEqual({ userId: "user_1", email: "member@example.com" });
  });

  it("issues a short-lived no-store dashboard bootstrap URL for an active token", async () => {
    const login = await request(app())
      .post("/api/mobile/auth/login")
      .send({ email: "member@example.com", password: "correct-password" });

    const response = await request(app())
      .post("/api/mobile/auth/web-session")
      .set("Authorization", `Bearer ${login.body.token}`);

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(response.headers.pragma).toBe("no-cache");
    expect(response.body).toEqual({
      bootstrapUrl:
        "https://os.presentail.com/sign-in?__clerk_ticket=ticket_mobile_1&mobile_handoff=1",
    });
    expect(mockCreateSignInToken).toHaveBeenCalledWith({
      userId: "user_1",
      expiresInSeconds: 60,
    });
  });

  it("rejects invalid or revoked native tokens without asking Clerk for a ticket", async () => {
    const response = await request(app())
      .post("/api/mobile/auth/web-session")
      .set("Authorization", "Bearer invalid-token");

    expect(response.status).toBe(401);
    expect(response.headers["x-mobile-auth"]).toBe("invalid");
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(mockCreateSignInToken).not.toHaveBeenCalled();
  });

  it("returns a retryable provider error without exposing a fallback URL", async () => {
    const login = await request(app())
      .post("/api/mobile/auth/login")
      .send({ email: "member@example.com", password: "correct-password" });
    mockCreateSignInToken.mockRejectedValueOnce(new Error("Clerk unavailable"));

    const response = await request(app())
      .post("/api/mobile/auth/web-session")
      .set("Authorization", `Bearer ${login.body.token}`);

    expect(response.status).toBe(502);
    expect(response.body).toEqual({
      error: "Unable to open the dashboard right now",
    });
    expect(response.body.bootstrapUrl).toBeUndefined();
  });

  it("keeps dependency outages retryable instead of invalidating the native session", async () => {
    const login = await request(app())
      .post("/api/mobile/auth/login")
      .send({ email: "member@example.com", password: "correct-password" });
    mockGetUser.mockRejectedValueOnce(new Error("Clerk unavailable"));

    const response = await request(app())
      .post("/api/mobile/auth/web-session")
      .set("Authorization", `Bearer ${login.body.token}`);

    expect(response.status).toBe(503);
    expect(response.headers["x-mobile-auth"]).toBeUndefined();
    expect(response.body).toEqual({
      error: "Authentication service unavailable",
    });
    expect(mockCreateSignInToken).not.toHaveBeenCalled();
  });
});