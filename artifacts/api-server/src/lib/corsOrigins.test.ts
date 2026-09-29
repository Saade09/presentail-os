import { describe, expect, it } from "vitest";
import { isAllowedCorsOrigin } from "./corsOrigins";

describe("isAllowedCorsOrigin", () => {
  it.each([
    "https://os.presentail.com",
    "https://print.presentail.com",
    "https://presentail.com",
    "https://www.presentail.com",
  ])(
    "allows the trusted production origin %s even when NODE_ENV is missing",
    (origin) => {
      expect(isAllowedCorsOrigin(origin)).toBe(true);
    },
  );

  it("allows explicitly configured origins", () => {
    expect(
      isAllowedCorsOrigin("https://admin.example.com", {
        nodeEnv: "production",
        additionalOrigins:
          "https://other.example.com, https://admin.example.com",
      }),
    ).toBe(true);
  });

  it("allows Replit preview origins only outside production", () => {
    const origin = "https://example.replit.dev";

    expect(isAllowedCorsOrigin(origin, { nodeEnv: "development" })).toBe(true);
    expect(isAllowedCorsOrigin(origin, { nodeEnv: "production" })).toBe(false);
  });

  it("rejects unknown and malformed origins", () => {
    expect(
      isAllowedCorsOrigin("https://attacker.example", {
        nodeEnv: "production",
      }),
    ).toBe(false);
    expect(isAllowedCorsOrigin("not a url", { nodeEnv: "development" })).toBe(
      false,
    );
  });

  it("allows requests without an Origin header", () => {
    expect(isAllowedCorsOrigin(undefined, { nodeEnv: "production" })).toBe(true);
  });
});