import type { NextFunction, Request, RequestHandler, Response } from "express";

const CLERK_SESSION_COOKIE = /^(?:__session|__client_uat)(?:_|$)/;

/**
 * The dashboard authenticates API requests with an Authorization bearer token.
 * A stale or partially-written Clerk cookie must not be parsed ahead of that
 * authoritative token because Clerk's middleware can throw while decoding it.
 */
export const preferBearerOverClerkCookies: RequestHandler = (req, _res, next) => {
  const authorization = req.headers.authorization;
  if (typeof authorization !== "string" || !/^Bearer\s+\S+/i.test(authorization)) {
    next();
    return;
  }

  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    const retained = cookieHeader
      .split(";")
      .map((cookie) => cookie.trim())
      .filter((cookie) => {
        const separator = cookie.indexOf("=");
        const name = separator >= 0 ? cookie.slice(0, separator).trim() : cookie;
        return !CLERK_SESSION_COOKIE.test(name);
      });

    if (retained.length > 0) req.headers.cookie = retained.join("; ");
    else delete req.headers.cookie;
  }

  const parsedCookies = (req as Request & { cookies?: Record<string, unknown> }).cookies;
  if (parsedCookies) {
    for (const name of Object.keys(parsedCookies)) {
      if (CLERK_SESSION_COOKIE.test(name)) delete parsedCookies[name];
    }
  }

  next();
};

function malformedClerkSession(error: unknown): boolean {
  if (error instanceof SyntaxError) return true;
  if (!error || typeof error !== "object") return false;
  const cause = (error as { cause?: unknown }).cause;
  return cause !== undefined && malformedClerkSession(cause);
}

/**
 * Clerk input-decoding failures are authentication failures, not application
 * crashes. Keep infrastructure errors visible to the global error handler.
 */
export function withClerkAuthBoundary(clerkAuth: RequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const authorization = req.headers.authorization;
    const requestMethod = (req.method ?? "GET").toUpperCase();
    const requestPath = (req.path ?? req.url ?? "").toLowerCase();
    const isMachineOdooAudit =
      requestMethod === "GET" &&
      requestPath === "/api/internal/finance/audit-approved-odoo" &&
      typeof authorization === "string" &&
      authorization.startsWith("Bearer ") &&
      authorization.length > "Bearer ".length;
    const isBearerMutation =
      typeof authorization === "string" &&
      authorization.startsWith("Bearer ") &&
      authorization.length > "Bearer ".length &&
      ["POST", "PUT", "PATCH", "DELETE"].includes(requestMethod);
    const requiresClerkRequestContext =
      requestPath.startsWith("/api/security/") ||
      requestPath.startsWith("/api/fleet/");

    // This exact machine-only read route authenticates a scoped HMAC token in
    // its first route handler. Clerk must not parse that token as a session.
    if (isMachineOdooAudit) {
      next();
      return;
    }

    // Mutating dashboard requests are verified directly by requireAuth. Do not
    // run the same Bearer token through Clerk middleware first: Clerk may reject
    // or throw while decoding one credential source before requireAuth gets the
    // opportunity to verify the authoritative token.
    if (isBearerMutation && !requiresClerkRequestContext) {
      next();
      return;
    }

    let handled = false;
    const handle = (error?: unknown) => {
      if (handled) return;
      if (!error) {
        handled = true;
        next();
        return;
      }
      if (malformedClerkSession(error)) {
        handled = true;
        req.log?.warn({ err: error }, "auth: rejected malformed Clerk session data");
        res.status(401).json({ error: "Unauthorized", code: "INVALID_SESSION" });
        return;
      }
      handled = true;
      next(error);
    };

    try {
      Promise.resolve(clerkAuth(req, res, handle)).catch(handle);
    } catch (error) {
      handle(error);
    }
  };
}