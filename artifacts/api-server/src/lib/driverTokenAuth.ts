import type { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { db } from "./db";
import { getAuth } from "@clerk/express";

export interface DriverAuthedRequest extends Request {
  driverId: number;
  driverWorkspaceOwnerId: string;
}

export const DRIVER_TOKEN_PREFIX = "fdt_live_";

export interface IssuedDriverToken {
  plaintext: string;
  hash: string;
  prefix: string;
  expiresAt: Date;
}

const TOKEN_EXPIRY_DAYS = 30;

/** Generate a fresh driver bearer token (returns plaintext + hash). */
export function generateDriverToken(): IssuedDriverToken {
  const random = crypto.randomBytes(24).toString("hex");
  const plaintext = `${DRIVER_TOKEN_PREFIX}${random}`;
  const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
  return {
    plaintext,
    hash: hashDriverToken(plaintext),
    prefix: plaintext.slice(0, 16),
    expiresAt,
  };
}

/** Stable SHA-256 hash for storing tokens at rest. */
export function hashDriverToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * Issue a fresh active token for a driver, revoking any previously active
 * tokens. Returns the plaintext exactly once — it is never stored or returned
 * again. Revoked tokens are kept for audit purposes.
 */
export async function issueDriverToken(driverId: number): Promise<IssuedDriverToken> {
  const issued = generateDriverToken();
  await db.query(
    `UPDATE fleet_driver_api_tokens
        SET revoked_at = COALESCE(revoked_at, now())
      WHERE driver_id = $1 AND revoked_at IS NULL`,
    [driverId],
  );
  await db.query(
    `INSERT INTO fleet_driver_api_tokens (driver_id, token_hash, token_prefix, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [driverId, issued.hash, issued.prefix, issued.expiresAt],
  );
  return issued;
}

/** Revoke all currently-active tokens for a driver. */
export async function revokeDriverTokens(driverId: number): Promise<void> {
  await db.query(
    `UPDATE fleet_driver_api_tokens
        SET revoked_at = now()
      WHERE driver_id = $1 AND revoked_at IS NULL`,
    [driverId],
  );
}

/**
 * Express middleware that resolves an `Authorization: Bearer <token>` header
 * to an active driver. Accepts two forms:
 *
 * 1. Legacy `fdt_live_...` bearer tokens — looked up in fleet_driver_api_tokens.
 * 2. Clerk session JWTs — validated by clerkMiddleware(); the driver is looked
 *    up by clerkUserId, and publicMetadata.userType must equal "driver".
 *
 * Rejects with 401/403 for invalid/expired tokens, deactivated drivers, and
 * non-driver Clerk users.
 */
export async function requireDriverToken(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.header("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    res.status(401).json({
      success: false,
      error: { code: "MISSING_TOKEN", message: "Missing Bearer token" },
    });
    return;
  }
  const raw = match[1].trim();

  // Path 1: legacy fdt_live_ bearer token
  if (raw.startsWith(DRIVER_TOKEN_PREFIX)) {
    const tokenHash = hashDriverToken(raw);
    const result = await db.query<{
      id: number;
      driver_id: number;
      workspace_owner_id: string;
      onboarding_status: string;
      deleted_at: string | null;
      expires_at: string | null;
    }>(
      `SELECT t.id, t.driver_id, t.expires_at, d.workspace_owner_id, d.onboarding_status, d.deleted_at
         FROM fleet_driver_api_tokens t
         JOIN fleet_drivers d ON d.id = t.driver_id
        WHERE t.token_hash = $1 AND t.revoked_at IS NULL
        LIMIT 1`,
      [tokenHash],
    );
    const row = result.rows[0];
    if (!row || row.deleted_at || row.onboarding_status !== "approved") {
      res.status(401).json({
        success: false,
        error: { code: "INVALID_TOKEN", message: "Token is invalid or revoked" },
      });
      return;
    }
    if (row.expires_at && new Date(row.expires_at) < new Date()) {
      res.status(401).json({
        success: false,
        error: { code: "TOKEN_EXPIRED", message: "Token has expired, please log in again" },
      });
      return;
    }
    (req as DriverAuthedRequest).driverId = row.driver_id;
    (req as DriverAuthedRequest).driverWorkspaceOwnerId = row.workspace_owner_id;
    // Best-effort touch
    db.query(`UPDATE fleet_driver_api_tokens SET last_used_at = now() WHERE id = $1`, [row.id])
      .catch(() => {});
    next();
    return;
  }

  // Path 2: Clerk session JWT
  // clerkMiddleware() has already run and parsed the session; we read it here.
  const auth = getAuth(req);
  const clerkUserId = auth?.userId;

  if (!clerkUserId) {
    res.status(401).json({
      success: false,
      error: { code: "INVALID_TOKEN", message: "Invalid token format" },
    });
    return;
  }

  // Verify publicMetadata.userType === "driver" from session claims.
  const meta = auth?.sessionClaims?.["publicMetadata"] as Record<string, unknown> | undefined;
  if (meta?.["userType"] !== "driver") {
    res.status(403).json({
      success: false,
      error: {
        code: "NOT_A_DRIVER",
        message:
          "This phone number is not registered as a Presentail driver. Please contact operations.",
      },
    });
    return;
  }

  // Look up the driver by Clerk user ID.
  const driverResult = await db.query<{
    id: number;
    workspace_owner_id: string;
    onboarding_status: string;
    status: string;
    deleted_at: string | null;
  }>(
    `SELECT id, workspace_owner_id, onboarding_status, status, deleted_at
       FROM fleet_drivers
      WHERE clerk_user_id = $1
        AND deleted_at IS NULL
      LIMIT 1`,
    [clerkUserId],
  );

  const driver = driverResult.rows[0];
  if (!driver) {
    res.status(403).json({
      success: false,
      error: {
        code: "NOT_A_DRIVER",
        message:
          "This phone number is not registered as a Presentail driver. Please contact operations.",
      },
    });
    return;
  }

  if (driver.onboarding_status !== "approved" || driver.status !== "active") {
    res.status(403).json({
      success: false,
      error: {
        code: "DRIVER_NOT_ACTIVE",
        message: "Your driver account is not yet approved or has been deactivated.",
      },
    });
    return;
  }

  (req as DriverAuthedRequest).driverId = driver.id;
  (req as DriverAuthedRequest).driverWorkspaceOwnerId = driver.workspace_owner_id;
  next();
}

/** Narrow a Request after `requireDriverToken` has run. */
export function driverAuthed(req: Request): DriverAuthedRequest {
  return req as DriverAuthedRequest;
}
