import { describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { preferBearerOverClerkCookies, withClerkAuthBoundary } from "./clerkAuthBoundary";

function request(headers: Record<string, string> = {}, cookies: Record<string, unknown> = {}) {
  return {
    headers,
    cookies,
    log: { warn: vi.fn() },
  } as unknown as Request;
}

function response() {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  return { value: { status } as unknown as Response, status, json };
}

describe("Clerk authentication boundary", () => {
  it("removes stale Clerk cookies when a Bearer token is authoritative", () => {
    const req = request(
      {
        authorization: "Bearer valid.jwt.token",
        cookie: "__session=truncated; preference=compact; __client_uat=123; __session_app=stale",
      },
      { __session: "truncated", preference: "compact", __client_uat: "123" },
    );
    const next = vi.fn();

    preferBearerOverClerkCookies(req, {} as Response, next);

    expect(req.headers.cookie).toBe("preference=compact");
    expect((req as Request & { cookies: Record<string, unknown> }).cookies).toEqual({ preference: "compact" });
    expect(next).toHaveBeenCalledOnce();
  });

  it("preserves Clerk cookies for cookie-only browser authentication", () => {
    const req = request({ cookie: "__session=valid; preference=compact" }, { __session: "valid" });
    const next = vi.fn();

    preferBearerOverClerkCookies(req, {} as Response, next);

    expect(req.headers.cookie).toBe("__session=valid; preference=compact");
    expect((req as Request & { cookies: Record<string, unknown> }).cookies.__session).toBe("valid");
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "bypasses Clerk middleware for Bearer-authenticated %s actions",
    (method) => {
      const clerkAuth = vi.fn((_req: Request, _res: Response, next: NextFunction) => next());
      const req = {
        ...request({ authorization: "Bearer valid.jwt.token" }),
        method,
      } as Request;
      const next = vi.fn();

      withClerkAuthBoundary(clerkAuth)(req, response().value, next as NextFunction);

      expect(clerkAuth).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["POST", "/api/orders/manual"],
    ["PATCH", "/api/orders/00000000-0000-0000-0000-000000000000"],
    ["POST", "/api/orders/00000000-0000-0000-0000-000000000000/line-items"],
    ["POST", "/api/products"],
    ["PATCH", "/api/products/1"],
    ["DELETE", "/api/products/1"],
    ["POST", "/api/cmc-pos/shifts"],
    ["DELETE", "/api/finance/ai-invoice-import/imports/1"],
    ["POST", "/api/orders/00000000-0000-0000-0000-000000000000/send-to-florist"],
  ])("bypasses Clerk for dashboard action %s %s", (method, path) => {
    const clerkAuth = vi.fn((_req: Request, _res: Response, next: NextFunction) => next());
    const req = {
      ...request({ authorization: "Bearer valid.jwt.token" }),
      method,
      path,
    } as Request;
    const next = vi.fn();

    withClerkAuthBoundary(clerkAuth)(req, response().value, next as NextFunction);

    expect(clerkAuth).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it("keeps Bearer-authenticated reads inside Clerk middleware", () => {
    const clerkAuth = vi.fn((_req: Request, _res: Response, next: NextFunction) => next());
    const req = {
      ...request({ authorization: "Bearer valid.jwt.token" }),
      method: "GET",
    } as Request;
    const next = vi.fn();

    withClerkAuthBoundary(clerkAuth)(req, response().value, next as NextFunction);

    expect(clerkAuth).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledOnce();
  });

  it("bypasses Clerk only for the scoped machine Odoo audit read", () => {
    const clerkAuth = vi.fn((_req: Request, _res: Response, next: NextFunction) => next());
    const req = {
      ...request({ authorization: "Bearer scoped.hmac.token" }),
      method: "GET",
      path: "/api/internal/finance/audit-approved-odoo",
    } as Request;
    const next = vi.fn();

    withClerkAuthBoundary(clerkAuth)(req, response().value, next as NextFunction);

    expect(clerkAuth).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it.each([
    ["GET", "/api/internal/finance/audit-approved-odoo/"],
    ["GET", "/api/internal/finance/audit-approved-odoo-extra"],
    ["HEAD", "/api/internal/finance/audit-approved-odoo"],
  ])("does not broaden the machine audit bypass to %s %s", (method, path) => {
    const clerkAuth = vi.fn((_req: Request, _res: Response, next: NextFunction) => next());
    const req = {
      ...request({ authorization: "Bearer scoped.hmac.token" }),
      method,
      path,
    } as Request;
    const next = vi.fn();

    withClerkAuthBoundary(clerkAuth)(req, response().value, next as NextFunction);

    expect(clerkAuth).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledOnce();
  });

  it.each([
    "/api/security/sessions/revoke-others",
    "/API/Security/sessions/revoke-others",
    "/api/fleet/me/availability",
    "/API/Fleet/me/availability",
  ])("keeps context-dependent mutation %s inside Clerk middleware", (path) => {
    const clerkAuth = vi.fn((_req: Request, _res: Response, next: NextFunction) => next());
    const req = {
      ...request({ authorization: "Bearer valid.jwt.token" }),
      method: "POST",
      path,
    } as Request;
    const next = vi.fn();

    withClerkAuthBoundary(clerkAuth)(req, response().value, next as NextFunction);

    expect(clerkAuth).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledOnce();
  });

  it("does not bypass Clerk for a non-canonical bearer scheme", () => {
    const clerkAuth = vi.fn((_req: Request, _res: Response, next: NextFunction) => next());
    const req = {
      ...request({ authorization: "bearer valid.jwt.token" }),
      method: "POST",
      path: "/api/cmc-pos/shifts",
    } as Request;
    const next = vi.fn();

    withClerkAuthBoundary(clerkAuth)(req, response().value, next as NextFunction);

    expect(clerkAuth).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledOnce();
  });

  it("returns 401 when Clerk rejects malformed session data", async () => {
    const clerkAuth: RequestHandler = async () => {
      throw new SyntaxError("Unexpected end of data");
    };
    const req = request();
    const res = response();
    const next = vi.fn();

    withClerkAuthBoundary(clerkAuth)(req, res.value, next as NextFunction);
    await vi.waitFor(() => expect(res.status).toHaveBeenCalledWith(401));

    expect(res.json).toHaveBeenCalledWith({ error: "Unauthorized", code: "INVALID_SESSION" });
    expect(next).not.toHaveBeenCalled();
  });

  it("passes non-input Clerk failures to the application error handler", async () => {
    const failure = new Error("Clerk service unavailable");
    const clerkAuth: RequestHandler = async () => {
      throw failure;
    };
    const next = vi.fn();

    withClerkAuthBoundary(clerkAuth)(request(), response().value, next as NextFunction);
    await vi.waitFor(() => expect(next).toHaveBeenCalledWith(failure));
  });
});