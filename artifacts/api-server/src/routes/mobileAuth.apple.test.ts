import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const { mockSendEmail } = vi.hoisted(() => ({ mockSendEmail: vi.fn() }));
const mockVerifyApple = vi.fn();
const mockCreateLinkToken = vi.fn();
const mockVerifyLinkToken = vi.fn();
const mockQuery = vi.fn();
const mockConnect = vi.fn();
const mockGetUser = vi.fn();
const mockGetUserList = vi.fn();
const mockSignMobileToken = vi.fn();

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: (...args: unknown[]) => mockSendEmail(...args) };
  },
}));

vi.mock("../lib/appleIdentity", () => ({
  verifyAppleIdentityToken: (...args: unknown[]) => mockVerifyApple(...args),
  createAppleLinkToken: (...args: unknown[]) => mockCreateLinkToken(...args),
  verifyAppleLinkToken: (...args: unknown[]) => mockVerifyLinkToken(...args),
}));
vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockQuery(...args),
    connect: (...args: unknown[]) => mockConnect(...args),
  },
}));
vi.mock("@clerk/express", () => ({
  clerkClient: {
    users: {
      getUser: (...args: unknown[]) => mockGetUser(...args),
      getUserList: (...args: unknown[]) => mockGetUserList(...args),
    },
  },
}));
vi.mock("../lib/auth", () => ({
  signMobileToken: (...args: unknown[]) => mockSignMobileToken(...args),
  verifyActiveMobileToken: vi.fn(),
}));
vi.mock("../lib/otpRateLimit", () => ({
  consumeOtpRateLimit: vi.fn().mockResolvedValue(true),
  otpRateLimitClientIp: () => "203.0.113.1",
}));

import mobileAuthRouter from "./mobileAuth";

const user = {
  id: "user_1",
  primaryEmailAddressId: "email_1",
  emailAddresses: [{ id: "email_1", emailAddress: "member@example.com" }],
  firstName: "Pat",
  lastName: "Member",
};

function app() {
  const value = express();
  value.use(express.json());
  value.use((req, _res, next) => {
    (req as unknown as { log: Record<string, unknown> }).log = {
      error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(),
    };
    next();
  });
  value.use("/api", mobileAuthRouter);
  return value;
}

const appleRequest = { identityToken: "jwt", nonce: "n".repeat(32) };

describe("mobile Sign in with Apple", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RESEND_API_KEY = "test-resend-key";
    mockVerifyApple.mockResolvedValue({
      sub: "apple-sub-1",
      email: "member@example.com",
      emailVerified: true,
      isPrivateEmail: false,
    });
    mockCreateLinkToken.mockReturnValue("signed-link-token");
    mockSignMobileToken.mockResolvedValue("mobile-token");
    mockSendEmail.mockResolvedValue({ data: { id: "email-1" }, error: null });
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("uses an existing subject mapping on repeat sign-in without Apple email", async () => {
    mockVerifyApple.mockResolvedValue({
      sub: "apple-sub-1", emailVerified: false, isPrivateEmail: false,
    });
    mockQuery
      .mockResolvedValueOnce({ rows: [{}], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ clerk_user_id: "user_1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ "?column?": 1 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    mockGetUser.mockResolvedValue(user);

    const response = await request(app()).post("/api/mobile/auth/apple").send(appleRequest);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ token: "mobile-token", user: { id: "user_1" } });
    expect(mockGetUserList).not.toHaveBeenCalled();
  });

  it("atomically links a verified non-private matching email", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{}], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{}], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    mockGetUserList.mockResolvedValue({ data: [user] });

    const response = await request(app()).post("/api/mobile/auth/apple").send(appleRequest);

    expect(response.status).toBe(200);
    expect(mockQuery.mock.calls[3][0]).toContain("INSERT INTO apple_identities");
  });

  it("requires email proof for private relay and unrecognized identities", async () => {
    mockVerifyApple.mockResolvedValue({
      sub: "private-sub",
      email: "relay@privaterelay.appleid.com",
      emailVerified: true,
      isPrivateEmail: true,
    });
    mockQuery
      .mockResolvedValueOnce({ rows: [{}], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const response = await request(app()).post("/api/mobile/auth/apple").send(appleRequest);

    expect(response.status).toBe(202);
    expect(response.body).toEqual({
      code: "APPLE_EMAIL_LINK_REQUIRED",
      requiresLink: true,
      linkToken: "signed-link-token",
      message: "Verify your invited Presentail email to continue",
    });
    expect(mockGetUserList).not.toHaveBeenCalled();
  });

  it("returns a clear generic error for invalid or expired Apple credentials", async () => {
    mockVerifyApple.mockRejectedValue(new Error("expired"));
    const response = await request(app()).post("/api/mobile/auth/apple").send({
      identityToken: "bad", nonce: "n".repeat(32),
    });
    expect(response.status).toBe(401);
    expect(response.body.code).toBe("APPLE_CREDENTIALS_INVALID");
    expect(response.body.error).toBe("Invalid or expired Apple sign-in. Please try again.");
  });

  it("prevents one Apple or Clerk identity from being linked twice", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{}], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{}], rowCount: 1 })
      .mockRejectedValueOnce(Object.assign(new Error("duplicate"), { code: "23505" }));
    mockGetUserList.mockResolvedValue({ data: [user] });

    const response = await request(app()).post("/api/mobile/auth/apple").send(appleRequest);

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/already linked/i);
  });

  it("rejects a replay after the single-use nonce was consumed", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const response = await request(app()).post("/api/mobile/auth/apple").send(appleRequest);
    expect(response.status).toBe(401);
    expect(response.body.error).toMatch(/already used/i);
    expect(response.body.code).toBe("APPLE_NONCE_EXPIRED");
  });

  it("completes the invited-email link with the same OTP flow", async () => {
    mockVerifyApple.mockResolvedValue({
      sub: "private-sub",
      email: "relay@privaterelay.appleid.com",
      emailVerified: true,
      isPrivateEmail: true,
    });
    mockQuery
      .mockResolvedValueOnce({ rows: [{}], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    mockVerifyLinkToken.mockReturnValue("private-sub");
    mockGetUserList.mockResolvedValue({ data: [user] });
    const clientQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    mockConnect.mockResolvedValue({ query: clientQuery, release: vi.fn() });

    const challenge = await request(app()).post("/api/mobile/auth/apple").send(appleRequest);
    expect(challenge.status).toBe(202);

    const otpResponse = await request(app())
      .post("/api/mobile/auth/otp/request")
      .send({ email: "member@example.com" });
    expect(otpResponse.status).toBe(200);
    const sentHtml = String(mockSendEmail.mock.calls[0]?.[0]?.html);
    const otp = sentHtml.match(/>(\d{6})<\/span>/)?.[1];
    expect(otp).toMatch(/^\d{6}$/);

    const response = await request(app())
      .post("/api/mobile/auth/apple/link")
      .send({ linkToken: "signed-link-token", email: "member@example.com", otp });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ token: "mobile-token", user: { id: "user_1" } });
    expect(clientQuery).toHaveBeenCalledWith("COMMIT");
  });

  it("returns bounded outcomes for expired links and unauthorized invited emails", async () => {
    mockVerifyLinkToken.mockReturnValueOnce(null).mockReturnValueOnce("private-sub");
    const expired = await request(app())
      .post("/api/mobile/auth/apple/link")
      .send({ linkToken: "expired", email: "member@example.com", otp: "123456" });
    expect(expired.status).toBe(401);
    expect(expired.body.code).toBe("APPLE_LINK_EXPIRED");

    mockGetUserList.mockResolvedValue({ data: [user] });
    const otpResponse = await request(app())
      .post("/api/mobile/auth/otp/request")
      .send({ email: "member@example.com" });
    expect(otpResponse.status).toBe(200);
    const sentHtml = String(mockSendEmail.mock.calls[0]?.[0]?.html);
    const otp = sentHtml.match(/>(\d{6})<\/span>/)?.[1];
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const unauthorized = await request(app())
      .post("/api/mobile/auth/apple/link")
      .send({ linkToken: "signed-link-token", email: "member@example.com", otp });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.body.code).toBe("APPLE_ACCOUNT_NOT_AUTHORIZED");
  });
});