import { describe, it, expect, vi, beforeEach } from "vitest";
import { isTokenExpiringSoon, refreshMetaLongLivedToken, hmacSha256Hex } from "../tokenRefresh";
import { ProviderAuthError } from "../../errors";

// ---------------------------------------------------------------------------
// isTokenExpiringSoon
// ---------------------------------------------------------------------------

describe("isTokenExpiringSoon", () => {
  it("returns false when expiresAt is null", () => {
    expect(isTokenExpiringSoon(null)).toBe(false);
  });

  it("returns false when token expires in 2 hours", () => {
    const twoHoursFromNow = new Date(Date.now() + 2 * 60 * 60 * 1000);
    expect(isTokenExpiringSoon(twoHoursFromNow)).toBe(false);
  });

  it("returns true when token expires in 30 minutes", () => {
    const thirtyMinsFromNow = new Date(Date.now() + 30 * 60 * 1000);
    expect(isTokenExpiringSoon(thirtyMinsFromNow)).toBe(true);
  });

  it("returns true when token is already expired", () => {
    const pastDate = new Date(Date.now() - 60 * 1000);
    expect(isTokenExpiringSoon(pastDate)).toBe(true);
  });

  it("returns true when token expires in exactly 1 hour (boundary)", () => {
    const exactlyOneHour = new Date(Date.now() + 60 * 60 * 1000 - 1);
    expect(isTokenExpiringSoon(exactlyOneHour)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// hmacSha256Hex
// ---------------------------------------------------------------------------

describe("hmacSha256Hex", () => {
  it("produces consistent HMAC-SHA256 hex output", () => {
    const result = hmacSha256Hex("secret", "payload");
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces different outputs for different secrets", () => {
    const r1 = hmacSha256Hex("secret1", "payload");
    const r2 = hmacSha256Hex("secret2", "payload");
    expect(r1).not.toBe(r2);
  });

  it("produces different outputs for different payloads", () => {
    const r1 = hmacSha256Hex("secret", "payload1");
    const r2 = hmacSha256Hex("secret", "payload2");
    expect(r1).not.toBe(r2);
  });

  it("works with Buffer payloads", () => {
    const result = hmacSha256Hex("secret", Buffer.from("payload"));
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces same output for Buffer and string with same content", () => {
    const r1 = hmacSha256Hex("secret", "payload");
    const r2 = hmacSha256Hex("secret", Buffer.from("payload"));
    expect(r1).toBe(r2);
  });
});

// ---------------------------------------------------------------------------
// refreshMetaLongLivedToken
// ---------------------------------------------------------------------------

describe("refreshMetaLongLivedToken", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns new access token and expiry on success", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: "new-long-lived-token-abc",
          token_type: "bearer",
          expires_in: 5184000,
        }),
        { status: 200 },
      ),
    );

    const result = await refreshMetaLongLivedToken("old-token", "app-id", "app-secret");
    expect(result.accessToken).toBe("new-long-lived-token-abc");
    expect(result.expiresAt).toBeInstanceOf(Date);
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("throws ProviderAuthError on HTTP failure", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response("Unauthorized", { status: 401 }),
    );

    await expect(
      refreshMetaLongLivedToken("bad-token", "app-id", "app-secret"),
    ).rejects.toThrow(ProviderAuthError);
  });

  it("throws ProviderAuthError when response contains error field", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: { message: "Invalid token", code: 190 },
        }),
        { status: 200 },
      ),
    );

    await expect(
      refreshMetaLongLivedToken("bad-token", "app-id", "app-secret"),
    ).rejects.toThrow(ProviderAuthError);
  });

  it("throws ProviderAuthError when response has no access_token", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ token_type: "bearer" }),
        { status: 200 },
      ),
    );

    await expect(
      refreshMetaLongLivedToken("old-token", "app-id", "app-secret"),
    ).rejects.toThrow(ProviderAuthError);
  });

  it("uses default 60-day expiry when expires_in is missing", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ access_token: "new-token" }),
        { status: 200 },
      ),
    );

    const result = await refreshMetaLongLivedToken("old-token", "app-id", "app-secret");
    const sixtyDaysMs = 60 * 24 * 60 * 60 * 1000;
    const diff = result.expiresAt.getTime() - Date.now();
    // Should be approximately 60 days (within 1 minute tolerance)
    expect(diff).toBeGreaterThan(sixtyDaysMs - 60000);
    expect(diff).toBeLessThan(sixtyDaysMs + 60000);
  });
});
