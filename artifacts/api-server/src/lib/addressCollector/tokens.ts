/**
 * Address Collector — secure link tokens.
 *
 * Tokens are high-entropy (192-bit) base64url strings. Only the SHA-256 hash
 * is ever stored; the plaintext token exists solely inside the outbound
 * message link. Lookups hash the presented token and compare against the
 * stored hash, so a database read can never reveal a usable link.
 */
import { createHash, randomBytes, timingSafeEqual } from "crypto";

export const TOKEN_RE = /^[A-Za-z0-9_-]{24,64}$/;

export function generateAddressToken(): { token: string; tokenHash: string } {
  const token = randomBytes(24).toString("base64url");
  return { token, tokenHash: hashAddressToken(token) };
}

export function hashAddressToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Constant-time comparison of two hex hashes. */
export function tokenHashesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ba.length !== bb.length || ba.length === 0) return false;
  return timingSafeEqual(ba, bb);
}
