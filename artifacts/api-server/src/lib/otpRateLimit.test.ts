import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDbQuery = vi.fn();

vi.mock("./db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
  },
}));

import { consumeOtpRateLimit, otpRateLimitClientIp } from "./otpRateLimit";

describe("shared OTP rate limiter", () => {
  beforeEach(() => {
    mockDbQuery.mockReset();
  });

  it("returns the atomic database decision and hashes public identifiers", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ allowed: true }] });

    await expect(
      consumeOtpRateLimit(
        ["mobile:request:ip:203.0.113.1", "mobile:request:account:user@example.com"],
        { maxRequests: 5, windowMs: 900_000 },
      ),
    ).resolves.toBe(true);

    const [sql, params] = mockDbQuery.mock.calls[0] as [string, [string[], number, number]];
    expect(sql).toContain("ON CONFLICT (bucket_hash) DO UPDATE");
    expect(sql).toContain("BOOL_AND(request_count <= $3)");
    expect(sql).toContain("NOT (bucket_hash = ANY($1::text[]))");
    expect(sql).toContain("AND window_expires_at <= NOW()");
    expect(params[0]).toHaveLength(2);
    expect(params[0].join(" ")).not.toContain("user@example.com");
    expect(params.slice(1)).toEqual([900_000, 5]);
  });

  it("fails closed when any shared bucket exceeds its limit", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ allowed: false }] });

    await expect(
      consumeOtpRateLimit(["fleet:verify:ip:203.0.113.1"], {
        maxRequests: 10,
        windowMs: 900_000,
      }),
    ).resolves.toBe(false);
  });
});

describe("OTP limiter client IP resolution", () => {
  function requestWith({
    direct,
    forwarded,
  }: {
    direct: string;
    forwarded?: string;
  }) {
    return {
      socket: { remoteAddress: direct },
      headers: forwarded ? { "x-forwarded-for": forwarded } : {},
    } as never;
  }

  it("uses the proxy-adjacent address instead of a spoofable leftmost value", () => {
    const req = requestWith({
      direct: "10.0.0.5",
      forwarded: "198.51.100.10, 203.0.113.20",
    });

    expect(otpRateLimitClientIp(req)).toBe("203.0.113.20");
  });

  it("ignores forwarded headers from a public direct peer", () => {
    const req = requestWith({
      direct: "198.51.100.40",
      forwarded: "203.0.113.20",
    });

    expect(otpRateLimitClientIp(req)).toBe("198.51.100.40");
  });

  it("falls back to the direct proxy when the final forwarded value is invalid", () => {
    const req = requestWith({
      direct: "10.0.0.5",
      forwarded: "203.0.113.20, not-an-ip",
    });

    expect(otpRateLimitClientIp(req)).toBe("10.0.0.5");
  });
});