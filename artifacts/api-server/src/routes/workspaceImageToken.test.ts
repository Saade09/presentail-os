import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceRequest } from "../lib/workspace";

const state = vi.hoisted(() => ({
  authDenied: false,
  workspaceDenied: false,
  workspaceOwnerId: "user_workspace_owner",
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (state.authDenied) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  },
}));

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (state.workspaceDenied) {
      res.status(403).json({ error: "no_access" });
      return;
    }
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = state.workspaceOwnerId;
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

import { verifyWorkspaceToken } from "../lib/imageSign";
import workspaceImageTokenRouter from "./workspaceImageToken";

const originalNodeEnv = process.env.NODE_ENV;
const originalSigningSecret = process.env.IMAGE_SIGNING_SECRET;

function makeApp() {
  const app = express();
  app.use(workspaceImageTokenRouter);
  return app;
}

function cookieHeader(response: request.Response): string {
  const cookies = response.headers["set-cookie"];
  expect(cookies).toBeDefined();
  expect(cookies).toHaveLength(1);
  return cookies[0];
}

beforeEach(() => {
  state.authDenied = false;
  state.workspaceDenied = false;
  state.workspaceOwnerId = "user_workspace_owner";
  process.env.IMAGE_SIGNING_SECRET = "workspace-image-token-test-secret";
  process.env.NODE_ENV = "development";
});

afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalSigningSecret === undefined) delete process.env.IMAGE_SIGNING_SECRET;
  else process.env.IMAGE_SIGNING_SECRET = originalSigningSecret;
});

describe("POST /workspace/image-token", () => {
  it("requires authentication and does not issue a token when auth is denied", async () => {
    state.authDenied = true;

    const response = await request(makeApp()).post("/workspace/image-token");

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: "Unauthorized" });
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("denies an unresolved workspace without issuing a token", async () => {
    state.workspaceDenied = true;

    const response = await request(makeApp()).post("/workspace/image-token");

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "no_access" });
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("resolves the tenant owner and scopes the issued token to that owner", async () => {
    state.workspaceOwnerId = "user_other_tenant_owner";

    const response = await request(makeApp()).post("/workspace/image-token");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    const cookie = cookieHeader(response);
    const token = cookie.match(/^ws_img=([^;]+)/)?.[1];
    expect(token).toBeTruthy();
    expect(verifyWorkspaceToken(decodeURIComponent(token!))).toBe(
      "user_other_tenant_owner",
    );
  });

  it("sets an HttpOnly, SameSite=Strict cookie without Secure in development", async () => {
    const response = await request(makeApp()).post("/workspace/image-token");

    const cookie = cookieHeader(response);
    expect(cookie).toMatch(/^ws_img=[^;]+; Max-Age=7200;/);
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).not.toContain("Secure");
  });

  it("sets a Secure HttpOnly, SameSite=Strict cookie in production", async () => {
    process.env.NODE_ENV = "production";

    const response = await request(makeApp()).post("/workspace/image-token");

    const cookie = cookieHeader(response);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("Max-Age=7200");
    expect(cookie).toContain("Path=/");
  });
});