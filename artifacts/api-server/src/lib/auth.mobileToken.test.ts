import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "crypto";

const mockCreateSession = vi.fn();
const mockGetSession = vi.fn();
const mockGetUser = vi.fn();
const mockRevokeSession = vi.fn();
const mockGetAuth = vi.fn<
  () => {
    userId: string | null;
    sessionClaims: Record<string, unknown> | null;
  }
>(() => ({ userId: null, sessionClaims: null }));
const mockVerifyToken = vi.fn();
const mockDbQuery = vi.fn();

vi.mock("./db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
  },
}));

vi.mock("@clerk/express", () => ({
  getAuth: () => mockGetAuth(),
  verifyToken: (...args: unknown[]) => mockVerifyToken(...args),
  clerkClient: {
    sessions: {
      createSession: (...args: unknown[]) => mockCreateSession(...args),
      getSession: (...args: unknown[]) => mockGetSession(...args),
      revokeSession: (...args: unknown[]) => mockRevokeSession(...args),
    },
    users: {
      getUser: (...args: unknown[]) => mockGetUser(...args),
    },
  },
}));

import {
  requireAuth,
  checkActiveMobileToken,
  revokeMobileToken,
  signMobileToken,
  verifyActiveMobileToken,
  verifyMobileToken,
} from "./auth";

function makeReq(token?: string) {
  return {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    log: { warn: vi.fn() },
  } as never;
}

function makeRes() {
  const res = {
    status: vi.fn(() => res),
    json: vi.fn(() => res),
  };
  return res;
}

function signLegacyToken(userId: string, email: string): string {
  const payload = Buffer.from(
    JSON.stringify({
      userId,
      email,
      exp: Math.floor(Date.now() / 1000) + 60,
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", "test-mobile-secret")
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

describe("revocable mobile authentication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MOBILE_JWT_SECRET = "test-mobile-secret";
    process.env.CLERK_SECRET_KEY = "sk_test_current-instance";
    mockCreateSession.mockResolvedValue({ id: "sess_mobile_1" });
    mockGetSession.mockResolvedValue({
      id: "sess_mobile_1",
      userId: "user_1",
      status: "active",
    });
    mockGetUser.mockResolvedValue({
      id: "user_1",
      banned: false,
      locked: false,
      updatedAt: 1_700_000_000_000,
    });
    mockRevokeSession.mockResolvedValue({ id: "sess_mobile_1", status: "revoked" });
    mockDbQuery.mockResolvedValue({ rowCount: 1, rows: [{ "?column?": 1 }] });
  });

  it("binds newly issued tokens to a Clerk session", async () => {
    const token = await signMobileToken("user_1", "user@example.com");

    expect(mockCreateSession).toHaveBeenCalledWith({ userId: "user_1" });
    expect(verifyMobileToken(token)).toEqual({
      userId: "user_1",
      email: "user@example.com",
      sessionId: "sess_mobile_1",
      sessionType: "clerk",
      userUpdatedAt: 1_700_000_000_000,
    });
  });

  it("falls back to user-bound tokens when production Clerk cannot create sessions", async () => {
    mockCreateSession.mockRejectedValueOnce({
      errors: [{ code: "request_invalid_for_environment" }],
    });

    const token = await signMobileToken("user_1", "user@example.com");

    expect(verifyMobileToken(token)).toEqual({
      userId: "user_1",
      email: "user@example.com",
      sessionId: expect.any(String),
      sessionType: "app",
      userUpdatedAt: 1_700_000_000_000,
    });
    await expect(verifyActiveMobileToken(token)).resolves.toEqual({
      userId: "user_1",
      email: "user@example.com",
      sessionId: expect.any(String),
      sessionType: "app",
      userUpdatedAt: 1_700_000_000_000,
    });
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(mockGetUser).toHaveBeenCalled();
    expect(mockDbQuery).toHaveBeenCalledTimes(2);
  });

  it("does not hide unexpected Clerk session creation errors", async () => {
    mockCreateSession.mockRejectedValueOnce(new Error("Clerk unavailable"));

    await expect(signMobileToken("user_1", "user@example.com")).rejects.toThrow(
      "Clerk unavailable",
    );
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it("revokes application-backed mobile sessions", async () => {
    mockCreateSession.mockRejectedValueOnce({
      errors: [{ code: "request_invalid_for_environment" }],
    });
    const token = await signMobileToken("user_1", "user@example.com");
    mockDbQuery.mockClear();

    await expect(revokeMobileToken(token)).resolves.toBe(true);

    expect(mockDbQuery).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE mobile_auth_sessions"),
      [expect.any(String), "user_1"],
    );
    expect(mockRevokeSession).not.toHaveBeenCalled();
  });

  it("rejects revoked application-backed mobile sessions", async () => {
    mockCreateSession.mockRejectedValueOnce({
      errors: [{ code: "request_invalid_for_environment" }],
    });
    const token = await signMobileToken("user_1", "user@example.com");
    mockDbQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    await expect(verifyActiveMobileToken(token)).resolves.toBeNull();
  });

  it("rejects a token after its Clerk session is revoked", async () => {
    const token = await signMobileToken("user_1", "user@example.com");
    mockGetSession.mockResolvedValue({ userId: "user_1", status: "revoked" });

    await expect(verifyActiveMobileToken(token)).resolves.toBeNull();
  });

  it("rejects a session belonging to a different user", async () => {
    const token = await signMobileToken("user_1", "user@example.com");
    mockGetSession.mockResolvedValue({ userId: "user_2", status: "active" });

    await expect(verifyActiveMobileToken(token)).resolves.toBeNull();
  });

  it("rejects legacy stateless tokens without consulting Clerk", async () => {
    const token = signLegacyToken("user_1", "user@example.com");

    await expect(verifyActiveMobileToken(token)).resolves.toBeNull();
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it("rejects disabled and locked Clerk users", async () => {
    const token = await signMobileToken("user_1", "user@example.com");
    mockGetUser.mockResolvedValue({
      id: "user_1",
      banned: true,
      locked: false,
      updatedAt: 1_700_000_000_000,
    });
    await expect(verifyActiveMobileToken(token)).resolves.toBeNull();

    mockGetUser.mockResolvedValue({
      id: "user_1",
      banned: false,
      locked: true,
      updatedAt: 1_700_000_000_000,
    });
    await expect(verifyActiveMobileToken(token)).resolves.toBeNull();
  });

  it("rejects a token after the Clerk user changes", async () => {
    const token = await signMobileToken("user_1", "user@example.com");
    mockGetUser.mockResolvedValue({
      id: "user_1",
      banned: false,
      locked: false,
      updatedAt: 1_700_000_000_001,
    });

    await expect(verifyActiveMobileToken(token)).resolves.toBeNull();
  });

  it("fails closed when Clerk cannot confirm current state", async () => {
    const token = await signMobileToken("user_1", "user@example.com");
    mockGetSession.mockRejectedValue(new Error("Clerk unavailable"));

    await expect(verifyActiveMobileToken(token)).resolves.toBeNull();
    await expect(checkActiveMobileToken(token)).resolves.toEqual({
      status: "unavailable",
    });
  });

  it("revokes a newly created session when token issuance cannot finish", async () => {
    mockGetUser.mockRejectedValueOnce(new Error("Clerk unavailable"));

    await expect(signMobileToken("user_1", "user@example.com")).rejects.toThrow(
      "Clerk unavailable",
    );
    expect(mockRevokeSession).toHaveBeenCalledWith("sess_mobile_1");
  });

  it("allows active tokens and sets the authenticated user", async () => {
    const token = await signMobileToken("user_1", "user@example.com");
    const req = makeReq(token);
    const res = makeRes();
    const next = vi.fn();

    await requireAuth(req, res as never, next);

    expect(next).toHaveBeenCalledOnce();
    expect((req as { userId?: string }).userId).toBe("user_1");
    expect(res.status).not.toHaveBeenCalled();
  });

  it("verifies Clerk bearer tokens against the configured backend instance", async () => {
    const token = "header.payload.signature";
    mockVerifyToken.mockResolvedValue({ sub: "user_current_instance" });
    const req = makeReq(token);
    const res = makeRes();
    const next = vi.fn();

    await requireAuth(req, res as never, next);

    expect(mockVerifyToken).toHaveBeenCalledWith(token, {
      secretKey: "sk_test_current-instance",
    });
    expect((req as { userId?: string }).userId).toBe("user_current_instance");
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("returns 401 when a Clerk bearer token belongs to another instance", async () => {
    mockGetAuth.mockReturnValueOnce({
      userId: "user_stale_instance",
      sessionClaims: { userId: "user_stale_instance" },
    });
    mockVerifyToken.mockRejectedValue(new Error("JWKS kid mismatch"));
    const res = makeRes();
    const next = vi.fn();

    await requireAuth(
      makeReq("header.stale-payload.signature"),
      res as never,
      next,
    );

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 for revoked tokens", async () => {
    const token = await signMobileToken("user_1", "user@example.com");
    mockGetSession.mockResolvedValue({ userId: "user_1", status: "revoked" });
    const res = makeRes();
    const next = vi.fn();

    await requireAuth(makeReq(token), res as never, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("fails closed when no mobile token secret is configured", async () => {
    const token = await signMobileToken("user_1", "user@example.com");
    const sessionCallsBeforeMissingSecret = mockCreateSession.mock.calls.length;
    const previousMobileSecret = process.env.MOBILE_JWT_SECRET;
    const previousClerkSecret = process.env.CLERK_SECRET_KEY;
    delete process.env.MOBILE_JWT_SECRET;
    delete process.env.CLERK_SECRET_KEY;

    try {
      expect(verifyMobileToken(token)).toBeNull();
      await expect(signMobileToken("user_1", "user@example.com")).rejects.toThrow(
        "MOBILE_JWT_SECRET or CLERK_SECRET_KEY is required",
      );
      expect(mockCreateSession).toHaveBeenCalledTimes(sessionCallsBeforeMissingSecret);
    } finally {
      if (previousMobileSecret === undefined) delete process.env.MOBILE_JWT_SECRET;
      else process.env.MOBILE_JWT_SECRET = previousMobileSecret;
      if (previousClerkSecret === undefined) delete process.env.CLERK_SECRET_KEY;
      else process.env.CLERK_SECRET_KEY = previousClerkSecret;
    }
  });
});