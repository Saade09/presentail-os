import { describe, it, expect } from "vitest";
import { generateAddressToken, hashAddressToken, tokenHashesEqual, TOKEN_RE } from "./tokens";

describe("address tokens", () => {
  it("generates url-safe tokens matching the accepted pattern with sha256 hashes", () => {
    const { token, tokenHash } = generateAddressToken();
    expect(TOKEN_RE.test(token)).toBe(true);
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashAddressToken(token)).toBe(tokenHash);
  });

  it("never repeats and never exposes the token in the hash", () => {
    const a = generateAddressToken();
    const b = generateAddressToken();
    expect(a.token).not.toBe(b.token);
    expect(a.tokenHash).not.toContain(a.token);
  });

  it("compares hashes timing-safely (equal and unequal)", () => {
    const { token, tokenHash } = generateAddressToken();
    expect(tokenHashesEqual(hashAddressToken(token), tokenHash)).toBe(true);
    expect(tokenHashesEqual(hashAddressToken("wrong-token-wrong-token-wrong"), tokenHash)).toBe(false);
  });

  it("rejects junk token shapes via TOKEN_RE", () => {
    expect(TOKEN_RE.test("short")).toBe(false);
    expect(TOKEN_RE.test("has spaces in it which is definitely bad")).toBe(false);
    expect(TOKEN_RE.test("<script>alert(1)</script>aaaaaaaa")).toBe(false);
  });
});
