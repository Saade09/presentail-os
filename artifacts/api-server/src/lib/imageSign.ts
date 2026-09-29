import { createHmac, timingSafeEqual } from "crypto";

export const COOKIE_NAME = "ws_img";

const TTL_SECONDS = 7200; // 2 hours

function getSecret(): string {
  const s =
    process.env.IMAGE_SIGNING_SECRET ??
    process.env.CLERK_SECRET_KEY ??
    "dev-fallback-not-for-production";
  if (
    s === "dev-fallback-not-for-production" &&
    process.env.NODE_ENV === "production"
  ) {
    throw new Error("IMAGE_SIGNING_SECRET (or CLERK_SECRET_KEY) must be set in production");
  }
  return s;
}

/**
 * Issue a short-lived HMAC token that encodes the workspace owner's Clerk user
 * ID.  The token is safe to store in a browser cookie; the secret never leaves
 * the server.
 *
 * Format: `<base64url(ownerId)>.<exp>.<hmac>` where exp is a Unix timestamp
 * (seconds) and hmac = HMAC-SHA256(secret, ownerId + "|" + exp).
 */
export function issueWorkspaceToken(ownerId: string): {
  token: string;
  maxAgeSeconds: number;
} {
  const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const payload = `${ownerId}|${exp}`;
  const mac = createHmac("sha256", getSecret())
    .update(payload)
    .digest("base64url");
  const ownerB64 = Buffer.from(ownerId).toString("base64url");
  return { token: `${ownerB64}.${exp}.${mac}`, maxAgeSeconds: TTL_SECONDS };
}

/**
 * Verify a workspace image token and return the encoded workspace owner ID.
 * Returns null if the token is missing, malformed, expired, or tampered with.
 */
export function verifyWorkspaceToken(token: unknown): string | null {
  if (typeof token !== "string" || !token) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [ownerB64, expStr, mac] = parts;

  const exp = parseInt(expStr, 10);
  if (Number.isNaN(exp) || exp < Math.floor(Date.now() / 1000)) return null;

  let ownerId: string;
  try {
    ownerId = Buffer.from(ownerB64, "base64url").toString("utf8");
  } catch {
    return null;
  }

  if (!ownerId.startsWith("user_") || ownerId.length < 10) return null;

  const payload = `${ownerId}|${exp}`;
  const expected = createHmac("sha256", getSecret())
    .update(payload)
    .digest("base64url");

  try {
    if (!timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  } catch {
    return null;
  }

  return ownerId;
}
