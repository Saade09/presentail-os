import type { Request, Response, NextFunction } from "express";
import { getAuth, clerkClient, verifyToken } from "@clerk/express";
import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import { db } from "./db";

/**
 * Coarse app-level user type stored in Clerk publicMetadata.
 *
 * NOTE: publicMetadata.userType is used only for coarse app-level routing
 * (e.g. blocking non-team users from Presentail OS). Sensitive permissions
 * and business logic must still be verified against the application database.
 */
export type UserType = "customer" | "driver" | "team";

export type AuthedRequest = Request & {
  userId: string;
};

/** Narrow a Request to AuthedRequest after `requireAuth` has run. */
export function authed(req: Request): AuthedRequest {
  return req as unknown as AuthedRequest;
}

// ─── Mobile token (HMAC-SHA256 with revocable backing session) ────────────────

function getMobileSecret(): Buffer {
  const secret = process.env.MOBILE_JWT_SECRET || process.env.CLERK_SECRET_KEY;
  if (!secret) {
    throw new Error("MOBILE_JWT_SECRET or CLERK_SECRET_KEY is required");
  }
  return Buffer.from(secret, "utf8");
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

export async function signMobileToken(userId: string, email: string): Promise<string> {
  // Validate the signing key before creating a backing Clerk session. A
  // misconfigured deployment must not leak active sessions it cannot use.
  const mobileSecret = getMobileSecret();
  let sessionId: string | null = null;
  let sessionType: "clerk" | "app" = "clerk";
  try {
    const session = await clerkClient.sessions.createSession({ userId });
    sessionId = session.id;
  } catch (error) {
    // Clerk production instances reject Backend API session creation with
    // request_invalid_for_environment. Mobile tokens remain bound to the
    // user's updatedAt/disabled state below, so production can authenticate
    // without relying on a development-only Clerk operation.
    const errors =
      error && typeof error === "object" && "errors" in error
        ? (error as { errors?: Array<{ code?: string }> }).errors
        : undefined;
    if (!errors?.some((entry) => entry.code === "request_invalid_for_environment")) {
      throw error;
    }
    sessionId = randomUUID();
    sessionType = "app";
  }
  let userUpdatedAt: number;
  try {
    const user = await clerkClient.users.getUser(userId);
    if (user.banned || user.locked) {
      throw new Error("Cannot issue a mobile token for a disabled user");
    }
    userUpdatedAt = user.updatedAt;
  } catch (error) {
    // Do not leave an active session behind when token issuance cannot finish.
    if (sessionId && sessionType === "clerk") {
      await clerkClient.sessions.revokeSession(sessionId).catch(() => undefined);
    }
    throw error;
  }
  const exp = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60; // 30 days
  if (sessionType === "app") {
    await db.query(
      `INSERT INTO mobile_auth_sessions
         (id, clerk_user_id, user_updated_at, expires_at)
       VALUES ($1, $2, $3, to_timestamp($4))`,
      [sessionId, userId, userUpdatedAt, exp],
    );
  }
  const payload = base64url(
    Buffer.from(
      JSON.stringify({ userId, email, sessionId, sessionType, userUpdatedAt, exp }),
      "utf8",
    ),
  );
  const sig = base64url(createHmac("sha256", mobileSecret).update(payload).digest());
  return `${payload}.${sig}`;
}

export function verifyMobileToken(
  token: string,
): {
  userId: string;
  email: string;
  sessionId: string;
  sessionType: "clerk" | "app";
  userUpdatedAt: number;
} | null {
  try {
    const dot = token.lastIndexOf(".");
    if (dot < 1) return null;
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = base64url(createHmac("sha256", getMobileSecret()).update(payload).digest());
    const sigBuf = Buffer.from(sig, "base64");
    const expBuf = Buffer.from(expected, "base64");
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;
    const data = JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as {
      userId?: string;
      email?: string;
      sessionId?: string;
      sessionType?: "clerk" | "app";
      userUpdatedAt?: number;
      exp?: number;
    };
    if (
      !data.userId ||
      !data.email ||
      !data.sessionId ||
      (data.sessionType !== undefined &&
        data.sessionType !== "clerk" &&
        data.sessionType !== "app") ||
      !Number.isFinite(data.userUpdatedAt) ||
      !data.exp
    ) {
      return null;
    }
    if (data.exp < Math.floor(Date.now() / 1000)) return null;
    return {
      userId: data.userId,
      email: data.email,
      sessionId: data.sessionId,
      // Tokens issued before application-backed sessions existed are Clerk-backed.
      sessionType: data.sessionType ?? "clerk",
      userUpdatedAt: data.userUpdatedAt!,
    };
  } catch {
    return null;
  }
}

export async function verifyActiveMobileToken(
  token: string,
): Promise<{
  userId: string;
  email: string;
  sessionId: string;
  sessionType: "clerk" | "app";
  userUpdatedAt: number;
} | null> {
  const result = await checkActiveMobileToken(token);
  return result.status === "active" ? result.mobile : null;
}

export type ActiveMobileTokenResult =
  | {
      status: "active";
      mobile: NonNullable<ReturnType<typeof verifyMobileToken>>;
    }
  | { status: "invalid" }
  | { status: "unavailable" };

function isClerkNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    status?: number;
    statusCode?: number;
    errors?: Array<{ code?: string }>;
  };
  return (
    candidate.status === 404 ||
    candidate.statusCode === 404 ||
    candidate.errors?.some((entry) =>
      ["resource_not_found", "session_not_found", "user_not_found"].includes(
        entry.code ?? "",
      ),
    ) === true
  );
}

export async function checkActiveMobileToken(
  token: string,
): Promise<ActiveMobileTokenResult> {
  const mobile = verifyMobileToken(token);
  if (!mobile) return { status: "invalid" };

  try {
    const [session, user] = await Promise.all([
      mobile.sessionType === "app"
        ? db.query(
            `SELECT 1 FROM mobile_auth_sessions
              WHERE id=$1 AND clerk_user_id=$2 AND revoked_at IS NULL
                AND expires_at > now() AND user_updated_at=$3
              LIMIT 1`,
            [mobile.sessionId, mobile.userId, mobile.userUpdatedAt],
          )
        : clerkClient.sessions.getSession(mobile.sessionId),
      clerkClient.users.getUser(mobile.userId),
    ]);
    const sessionIsActive =
      mobile.sessionType === "app"
        ? (session as { rowCount?: number }).rowCount === 1
        : (session as { status?: string; userId?: string }).status === "active" &&
          (session as { status?: string; userId?: string }).userId === mobile.userId;
    if (
      !sessionIsActive ||
      user.banned ||
      user.locked ||
      user.updatedAt !== mobile.userUpdatedAt
    ) {
      return { status: "invalid" };
    }
    return { status: "active", mobile };
  } catch (error) {
    // Missing/deleted Clerk resources are definitive authentication failures.
    // Dependency outages are different: callers that can offer retry should
    // preserve the valid local credential instead of signing the user out.
    return isClerkNotFoundError(error)
      ? { status: "invalid" }
      : { status: "unavailable" };
  }
}

export async function revokeMobileToken(token: string): Promise<boolean> {
  const mobile = verifyMobileToken(token);
  if (!mobile) return false;

  if (mobile.sessionType === "app") {
    const result = await db.query(
      `UPDATE mobile_auth_sessions
          SET revoked_at=now()
        WHERE id=$1 AND clerk_user_id=$2 AND revoked_at IS NULL`,
      [mobile.sessionId, mobile.userId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  await clerkClient.sessions.revokeSession(mobile.sessionId);
  return true;
}

/**
 * Sanitized diagnostics for a rejected bearer token: decodes the JWT header and
 * payload WITHOUT verifying, and logs only issuer / azp / key id / sub. Never
 * logs the token itself or any secret.
 */
function logRejectedBearerDiagnostics(req: Request, bearer: string): void {
  try {
    const [headerB64, payloadB64] = bearer.split(".");
    if (!headerB64 || !payloadB64) return;
    const decode = (part: string) =>
      JSON.parse(
        Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
      ) as Record<string, unknown>;
    const header = decode(headerB64);
    const payload = decode(payloadB64);
    req.log?.warn?.(
      {
        clerkSecretKeyPresent: Boolean(process.env.CLERK_SECRET_KEY),
        tokenIssuer: payload.iss,
        tokenAzp: payload.azp,
        tokenKid: header.kid,
        tokenSub: payload.sub,
        verification: "rejected_by_clerk_middleware",
      },
      "auth: bearer token rejected",
    );
    // Fire-and-forget: re-verify with @clerk/backend to capture Clerk's exact
    // rejection reason (signature mismatch, clock skew, expired, etc.). Logs
    // the error message only — never the token or secret.
    if (process.env.CLERK_SECRET_KEY) {
      void import("@clerk/express")
        .then((m) =>
          m.verifyToken(bearer, { secretKey: process.env.CLERK_SECRET_KEY! }),
        )
        .then(() => {
          req.log?.warn?.(
            { verifyTokenDirect: "succeeded" },
            "auth: direct verifyToken SUCCEEDED though middleware rejected — middleware config issue",
          );
        })
        .catch((err: unknown) => {
          req.log?.warn?.(
            {
              verifyTokenDirect: "failed",
              reason: err instanceof Error ? err.message : String(err),
            },
            "auth: direct verifyToken rejection reason",
          );
        });
    }
  } catch {
    req.log?.warn?.({ verification: "token_undecodable" }, "auth: bearer token rejected");
  }
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;
  const apiKeyReq = req as Request & { apiKeyReadAuth?: boolean; userId?: string };
  if (
    apiKeyReq.apiKeyReadAuth === true &&
    apiKeyReq.userId &&
    authHeader?.startsWith("Bearer pk_live_")
  ) {
    // apiKeyReadAuth already validated this read-only key and established the
    // workspace owner identity. Do not send workspace API keys through Clerk
    // JWT verification merely because both use the Authorization header.
    next();
    return;
  }

  if (authHeader?.startsWith("Bearer ")) {
    const bearer = authHeader.slice(7);

    // clerkMiddleware can hydrate getAuth() from an existing Clerk session
    // even when that session belongs to a different Clerk instance. Always
    // verify browser Bearer tokens against this API's configured secret before
    // trusting the attached identity. This turns a stale cross-instance
    // session into a 401 (which the web app can recover from) instead of a
    // misleading workspace-permission 403.
    if (bearer.split(".").length === 3 && process.env.CLERK_SECRET_KEY) {
      try {
        const verified = await verifyToken(bearer, {
          secretKey: process.env.CLERK_SECRET_KEY,
        });
        if (verified.sub) {
          (req as AuthedRequest).userId = verified.sub;
          next();
          return;
        }
      } catch {
        logRejectedBearerDiagnostics(req, bearer);
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
    }

    // Mobile app token — HMAC-signed token bound to a revocable Clerk session.
    const mobile = await verifyActiveMobileToken(bearer);
    if (mobile) {
      (req as AuthedRequest).userId = mobile.userId;
      next();
      return;
    }
    logRejectedBearerDiagnostics(req, bearer);
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const auth = getAuth(req);
  const userId = (auth?.sessionClaims as { userId?: string })?.userId || auth?.userId;
  if (userId) {
    (req as AuthedRequest).userId = userId;
    next();
    return;
  }

  // No Clerk session — honor a read-only identity established upstream by the
  // workspace API-key middleware (apiKeyReadAuth). That middleware only sets
  // this flag for GET/HEAD requests, so an API key can never reach a mutating
  // route this way.
  if (apiKeyReq.apiKeyReadAuth === true && apiKeyReq.userId) {
    next();
    return;
  }

  res.status(401).json({ error: "Unauthorized" });
}

/**
 * Reads the signed-in user's `publicMetadata.userType` from the Clerk
 * session claims attached to the request.
 *
 * NOTE: publicMetadata is for coarse app-level routing only. Sensitive
 * business logic must be verified against the application database.
 */
export function getCurrentUserType(req: Request): UserType | undefined {
  const auth = getAuth(req);
  const meta = auth?.sessionClaims?.["publicMetadata"] as Record<string, unknown> | undefined;
  const val = meta?.["userType"];
  if (val === "customer" || val === "driver" || val === "team") return val;
  return undefined;
}

/**
 * Express middleware that returns 403 if the signed-in user's userType
 * is not in the provided list.
 *
 * NOTE: publicMetadata is for coarse app-level routing only. Sensitive
 * business logic must still be verified against the application database.
 */
export function requireUserType(allowedTypes: UserType[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const userType = getCurrentUserType(req);
    if (!userType || !allowedTypes.includes(userType)) {
      res.status(403).json({ error: "Forbidden: insufficient user type" });
      return;
    }
    next();
  };
}

/**
 * Sets publicMetadata.userType for a user via the Clerk Admin API.
 * Server-side only — never call from client code.
 *
 * NOTE: publicMetadata is for coarse app-level routing only. Sensitive
 * business logic must still be verified against the application database.
 */
export async function setUserTypeForCurrentApp(
  userId: string,
  userType: UserType,
): Promise<void> {
  await clerkClient.users.updateUserMetadata(userId, {
    publicMetadata: { userType },
  });
}
