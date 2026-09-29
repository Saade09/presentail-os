import { describe, expect, it, vi } from "vitest";
import { createSessionJwtCache } from "../../e2e/session-jwt-cache";

function jwt(expSeconds: number, marker: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ exp: expSeconds, marker }),
  ).toString("base64url");
  return `${header}.${payload}.signature`;
}

describe("session JWT cache", () => {
  it("mints a fresh token after the original token expires", async () => {
    let nowMs = 1_700_000_000_000;
    const getToken = vi
      .fn()
      .mockResolvedValueOnce({ jwt: jwt(nowMs / 1000 + 60, "original") })
      .mockImplementation(async () => ({
        jwt: jwt(nowMs / 1000 + 60, "refreshed"),
      }));
    const cache = createSessionJwtCache({
      source: { getToken },
      now: () => nowMs,
    });

    const original = await cache.get("session-id");
    nowMs += 61_000;
    const refreshed = await cache.get("session-id");

    expect(refreshed).not.toBe(original);
    expect(getToken).toHaveBeenCalledTimes(2);
  });
});