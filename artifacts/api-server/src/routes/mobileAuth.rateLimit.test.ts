import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const mockConsumeOtpRateLimit = vi.fn();
const mockGetUserList = vi.fn();

vi.mock("../lib/otpRateLimit", () => ({
  consumeOtpRateLimit: (...args: unknown[]) => mockConsumeOtpRateLimit(...args),
  otpRateLimitClientIp: () => "203.0.113.10",
}));

vi.mock("@clerk/express", () => ({
  clerkClient: {
    users: {
      getUserList: (...args: unknown[]) => mockGetUserList(...args),
    },
  },
}));

vi.mock("../lib/auth", () => ({
  signMobileToken: vi.fn(),
  verifyActiveMobileToken: vi.fn(),
}));

import mobileAuthRouter from "./mobileAuth";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: unknown }).log = {
      error: vi.fn(),
      warn: vi.fn(),
    };
    next();
  });
  app.use("/api", mobileAuthRouter);
  return app;
}

describe("mobile OTP route rate limits", () => {
  beforeEach(() => {
    mockConsumeOtpRateLimit.mockReset();
    mockConsumeOtpRateLimit.mockResolvedValue(false);
    mockGetUserList.mockReset();
  });

  it("blocks a limited OTP request before Clerk or Resend work", async () => {
    const res = await request(makeApp())
      .post("/api/mobile/auth/otp/request")
      .send({ email: "User@Example.com" });

    expect(res.status).toBe(429);
    expect(mockGetUserList).not.toHaveBeenCalled();
    expect(mockConsumeOtpRateLimit).toHaveBeenCalledWith(
      [
        "mobile:request:ip:203.0.113.10",
        "mobile:request:account:user@example.com",
      ],
      { maxRequests: 5, windowMs: 15 * 60 * 1000 },
    );
  });

  it("blocks a limited OTP verification before reading the OTP store", async () => {
    const res = await request(makeApp())
      .post("/api/mobile/auth/otp/verify")
      .send({ email: "user@example.com", otp: "123456" });

    expect(res.status).toBe(429);
    expect(mockGetUserList).not.toHaveBeenCalled();
    expect(mockConsumeOtpRateLimit).toHaveBeenCalledWith(
      [
        "mobile:verify:ip:203.0.113.10",
        "mobile:verify:account:user@example.com",
      ],
      { maxRequests: 10, windowMs: 15 * 60 * 1000 },
    );
  });
});