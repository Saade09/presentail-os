import { createHash } from "crypto";
import { isIP } from "net";
import type { Request } from "express";
import { db } from "./db";

export interface OtpRateLimit {
  maxRequests: number;
  windowMs: number;
}

function hashBucket(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function isPrivateProxyAddress(address: string): boolean {
  const normalized = address.replace(/^::ffff:/, "");
  if (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized.startsWith("10.") ||
    normalized.startsWith("192.168.")
  ) {
    return true;
  }
  const parts = normalized.split(".");
  if (parts.length === 4 && parts[0] === "172") {
    const second = Number(parts[1]);
    if (second >= 16 && second <= 31) return true;
  }
  return normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:");
}

/**
 * Resolve the client address without trusting a caller-controlled leftmost
 * X-Forwarded-For value. Replit's private reverse proxy appends the address
 * closest to it, so only the rightmost valid forwarded address is accepted,
 * and only when the direct peer is a private/loopback proxy.
 */
export function otpRateLimitClientIp(req: Request): string {
  const direct = req.socket.remoteAddress ?? "unknown";
  if (!isPrivateProxyAddress(direct)) return direct;

  const forwarded = req.headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded.join(",") : forwarded;
  if (!raw) return direct;

  const candidates = raw.split(",").map((part) => part.trim());
  const proxyAdjacent = candidates.at(-1) ?? "";
  return isIP(proxyAdjacent) ? proxyAdjacent : direct;
}

/**
 * Atomically consume shared PostgreSQL-backed rate-limit buckets.
 *
 * All keys are hashed before storage so email addresses and phone numbers are
 * not retained in the limiter table. Expired buckets are deleted in bounded
 * batches as part of normal traffic.
 */
export async function consumeOtpRateLimit(
  keys: string[],
  limit: OtpRateLimit,
): Promise<boolean> {
  const bucketHashes = [...new Set(keys.map(hashBucket))];
  const result = await db.query<{ allowed: boolean }>(
    `WITH expired AS (
       SELECT bucket_hash
         FROM otp_rate_limits
        WHERE window_expires_at <= NOW()
          AND NOT (bucket_hash = ANY($1::text[]))
        ORDER BY window_expires_at
        LIMIT 100
     ),
     deleted AS (
       DELETE FROM otp_rate_limits
        WHERE bucket_hash IN (SELECT bucket_hash FROM expired)
          AND window_expires_at <= NOW()
     ),
     input AS (
       SELECT UNNEST($1::text[]) AS bucket_hash
     ),
     upserted AS (
       INSERT INTO otp_rate_limits (bucket_hash, request_count, window_expires_at)
       SELECT bucket_hash, 1, NOW() + ($2::bigint * INTERVAL '1 millisecond')
         FROM input
       ON CONFLICT (bucket_hash) DO UPDATE SET
         request_count = CASE
           WHEN otp_rate_limits.window_expires_at <= NOW() THEN 1
           ELSE otp_rate_limits.request_count + 1
         END,
         window_expires_at = CASE
           WHEN otp_rate_limits.window_expires_at <= NOW()
             THEN NOW() + ($2::bigint * INTERVAL '1 millisecond')
           ELSE otp_rate_limits.window_expires_at
         END
       RETURNING request_count
     )
     SELECT COALESCE(BOOL_AND(request_count <= $3), false) AS allowed
       FROM upserted`,
    [bucketHashes, limit.windowMs, limit.maxRequests],
  );
  return result.rows[0]?.allowed === true;
}