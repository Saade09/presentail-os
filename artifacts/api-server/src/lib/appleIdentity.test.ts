import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, createHash, createSign } from "node:crypto";
import { verifyAppleIdentityToken } from "./appleIdentity";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = publicKey.export({ format: "jwk" });
const kid = "apple-test-key";
const nonce = "server-issued-single-use-nonce-value";

function token(overrides: Record<string, unknown> = {}) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: "https://appleid.apple.com",
    aud: "com.presentail.osmobile",
    sub: "apple-subject-1",
    exp: Math.floor(Date.now() / 1000) + 300,
    iat: Math.floor(Date.now() / 1000),
    email: "member@example.com",
    email_verified: "true",
    nonce: createHash("sha256").update(nonce).digest("hex"),
    ...overrides,
  })).toString("base64url");
  const signature = createSign("RSA-SHA256")
    .update(`${header}.${payload}`)
    .sign(privateKey)
    .toString("base64url");
  return `${header}.${payload}.${signature}`;
}

describe("Apple identity token verification", () => {
  beforeAll(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] }),
    }));
  });

  afterEach(() => vi.clearAllMocks());

  it("accepts a correctly signed token for the iOS bundle identifier", async () => {
    await expect(verifyAppleIdentityToken(token(), nonce)).resolves.toMatchObject({
      sub: "apple-subject-1",
      email: "member@example.com",
      emailVerified: true,
      isPrivateEmail: false,
    });
  });

  it.each([
    ["issuer", { iss: "https://attacker.example" }],
    ["audience", { aud: "another.app" }],
    ["expiry", { exp: Math.floor(Date.now() / 1000) - 1 }],
    ["stable subject", { sub: "" }],
  ])("rejects an invalid %s", async (_label, overrides) => {
    await expect(verifyAppleIdentityToken(token(overrides), nonce)).rejects.toThrow(
      "Invalid or expired Apple identity token",
    );
  });

  it("detects Apple's private relay addresses", async () => {
    await expect(verifyAppleIdentityToken(token({
      email: "relay@privaterelay.appleid.com",
      is_private_email: "true",
    }), nonce)).resolves.toMatchObject({ isPrivateEmail: true });
  });

  it("rejects a token bound to a different nonce", async () => {
    await expect(verifyAppleIdentityToken(token(), "different-nonce")).rejects.toThrow(
      "Invalid or expired Apple identity token",
    );
  });
});