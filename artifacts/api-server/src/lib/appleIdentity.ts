import {
  createHmac,
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify as verifySignature,
} from "node:crypto";

const APPLE_ISSUER = "https://appleid.apple.com";
const APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys";
const LINK_TTL_SECONDS = 10 * 60;

export interface VerifiedAppleIdentity {
  sub: string;
  email?: string;
  emailVerified: boolean;
  isPrivateEmail: boolean;
}

interface AppleClaims {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
  sub?: string;
  email?: string;
  email_verified?: string | boolean;
  is_private_email?: string | boolean;
  nonce?: string;
}

interface AppleJwk {
  kty?: string;
  n?: string;
  e?: string;
  kid?: string;
  alg?: string;
  use?: string;
}

let jwksCache: { expiresAt: number; keys: AppleJwk[] } | null = null;

function decodeJson<T>(value: string): T {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
}

async function getAppleKeys(forceRefresh = false): Promise<AppleJwk[]> {
  if (!forceRefresh && jwksCache && jwksCache.expiresAt > Date.now()) return jwksCache.keys;
  const response = await fetch(APPLE_JWKS_URL);
  if (!response.ok) throw new Error("Apple identity service unavailable");
  const body = (await response.json()) as { keys?: AppleJwk[] };
  if (!body.keys?.length) throw new Error("Apple identity service returned no keys");
  jwksCache = { keys: body.keys, expiresAt: Date.now() + 60 * 60 * 1000 };
  return body.keys;
}

export async function verifyAppleIdentityToken(
  token: string,
  expectedNonce: string,
  audience = process.env.APPLE_CLIENT_ID || "com.presentail.osmobile",
): Promise<VerifiedAppleIdentity> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid Apple identity token");
  const [encodedHeader, encodedClaims, encodedSignature] = parts;
  const header = decodeJson<{ alg?: string; kid?: string }>(encodedHeader);
  const claims = decodeJson<AppleClaims>(encodedClaims);
  if (header.alg !== "RS256" || !header.kid) throw new Error("Invalid Apple identity token");

  let key = (await getAppleKeys()).find(
    (candidate) => candidate.kid === header.kid && candidate.alg === "RS256",
  );
  if (!key) {
    key = (await getAppleKeys(true)).find(
      (candidate) => candidate.kid === header.kid && candidate.alg === "RS256",
    );
  }
  if (!key) throw new Error("Unknown Apple signing key");
  const validSignature = verifySignature(
    "RSA-SHA256",
    Buffer.from(`${encodedHeader}.${encodedClaims}`),
    createPublicKey({ key: key as JsonWebKey, format: "jwk" }),
    Buffer.from(encodedSignature, "base64url"),
  );
  const now = Math.floor(Date.now() / 1000);
  const validAudience = Array.isArray(claims.aud)
    ? claims.aud.includes(audience)
    : claims.aud === audience;
  const nonceHash = createHash("sha256").update(expectedNonce).digest("hex");
  if (
    !validSignature ||
    claims.iss !== APPLE_ISSUER ||
    !validAudience ||
    !claims.sub ||
    !claims.exp ||
    claims.exp <= now ||
    (claims as AppleClaims & { nonce?: string }).nonce !== nonceHash ||
    (claims.iat !== undefined && claims.iat > now + 60)
  ) {
    throw new Error("Invalid or expired Apple identity token");
  }
  return {
    sub: claims.sub,
    email: claims.email?.toLowerCase(),
    emailVerified: claims.email_verified === true || claims.email_verified === "true",
    isPrivateEmail:
      claims.is_private_email === true ||
      claims.is_private_email === "true" ||
      claims.email?.toLowerCase().endsWith("@privaterelay.appleid.com") === true,
  };
}

function linkingSecret(): Buffer {
  const value = process.env.MOBILE_JWT_SECRET || process.env.CLERK_SECRET_KEY;
  if (!value) throw new Error("Mobile authentication secret is required");
  return Buffer.from(value);
}

export function createAppleLinkToken(subject: string): string {
  const payload = Buffer.from(
    JSON.stringify({ sub: subject, exp: Math.floor(Date.now() / 1000) + LINK_TTL_SECONDS }),
  ).toString("base64url");
  const signature = createHmac("sha256", linkingSecret()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyAppleLinkToken(token: string): string | null {
  try {
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra) return null;
    const expected = createHmac("sha256", linkingSecret()).update(payload).digest();
    const received = Buffer.from(signature, "base64url");
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;
    const parsed = decodeJson<{ sub?: string; exp?: number }>(payload);
    if (!parsed.sub || !parsed.exp || parsed.exp <= Math.floor(Date.now() / 1000)) return null;
    return parsed.sub;
  } catch {
    return null;
  }
}