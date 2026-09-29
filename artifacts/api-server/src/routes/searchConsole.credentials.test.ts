import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import type { WorkspaceRequest } from "../lib/workspace";

const { mockDbQuery, mockClientQuery, mockClientRelease } = vi.hoisted(() => ({
  mockDbQuery: vi.fn(),
  mockClientQuery: vi.fn(),
  mockClientRelease: vi.fn(),
}));

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
    connect: async () => ({
      query: (...args: unknown[]) => mockClientQuery(...args),
      release: mockClientRelease,
    }),
  },
}));

vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (
    _req: Request,
    _res: Response,
    next: NextFunction,
  ) => next(),
}));

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (
    req: Request,
    _res: Response,
    next: NextFunction,
  ) => {
    const workspaceReq = req as unknown as WorkspaceRequest;
    workspaceReq.workspaceOwnerId = "owner_test";
    workspaceReq.workspaceRole = "owner";
    workspaceReq.allowedPages = [];
    workspaceReq.memberDbId = 1;
    next();
  },
  workspace: (req: Request) => req as unknown as WorkspaceRequest,
}));

vi.mock("../lib/oauthRedirect", () => ({
  externalOrigin: () => "https://dashboard.example.com",
}));

import searchConsoleRouter from "./searchConsole";
import {
  decryptGscOauthClient,
  encryptGscOauthClient,
  maskGscClientId,
} from "../lib/searchConsoleSync";

const ENCRYPTION_KEY = "11".repeat(32);
const SERVER_CLIENT_ID = "server-client-123456.apps.googleusercontent.com";
const SERVER_SECRET = "server-secret-value";
const WORKSPACE_CLIENT_ID = "workspace-client-987654.apps.googleusercontent.com";
const WORKSPACE_SECRET = "workspace-secret-value";

type RouteHandler = (req: Request, res: Response) => Promise<void>;

interface RouteLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ handle: RouteHandler }>;
  };
}

async function invokeRoute(
  method: "get" | "post" | "delete",
  path: string,
  options: {
    body?: unknown;
    query?: Record<string, string>;
    role?: "owner" | "member";
  } = {},
) {
  const layers = (searchConsoleRouter as unknown as { stack: RouteLayer[] }).stack;
  const layer = layers.find(
    (candidate) =>
      candidate.route?.path === path &&
      candidate.route.methods[method],
  );
  if (!layer?.route) throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);

  const req = {
    body: options.body ?? {},
    query: options.query ?? {},
    protocol: "https",
    hostname: "dashboard.example.com",
    workspaceOwnerId: "owner_test",
    workspaceRole: options.role ?? "owner",
    allowedPages: [],
    memberDbId: 1,
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as unknown as Request;

  let status = 200;
  let body: unknown;
  let redirect: string | undefined;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(value: unknown) {
      body = value;
      return this;
    },
    redirect(value: string) {
      redirect = value;
      return this;
    },
  } as unknown as Response;

  await layer.route.stack[0].handle(req, res);
  return { status, body: body as Record<string, unknown>, redirect };
}

function mockOauthConfig(encrypted: string | null) {
  mockDbQuery.mockImplementation((sql: unknown) => {
    const query = String(sql);
    if (query.includes("FROM search_console_oauth_config")) {
      return Promise.resolve({
        rows: encrypted
          ? [{
              id: 1,
              workspace_owner_id: "owner_test",
              oauth_client_encrypted: encrypted,
            }]
          : [],
        rowCount: encrypted ? 1 : 0,
      });
    }
    if (query.includes("FROM search_console_connections")) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    return Promise.resolve({ rows: [], rowCount: 1 });
  });
}

describe("Search Console credential management", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockClientQuery.mockReset();
    mockClientQuery.mockImplementation(async (sql: unknown) => {
      const query = String(sql);
      if (query.includes("FROM search_console_oauth_config")) {
        return { rows: [], rowCount: 0 };
      }
      if (query.includes("DELETE FROM search_console_connections")) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    process.env.CREDENTIAL_ENCRYPTION_KEY = ENCRYPTION_KEY;
    process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_ID = SERVER_CLIENT_ID;
    process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET = SERVER_SECRET;
    delete process.env.WOOCOMMERCE_ENCRYPTION_KEY;
  });

  afterEach(() => {
    delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    delete process.env.WOOCOMMERCE_ENCRYPTION_KEY;
    delete process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_ID;
    delete process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET;
    vi.unstubAllGlobals();
  });

  it("reports environment credentials with only a masked Client ID", async () => {
    mockOauthConfig(null);

    const response = await invokeRoute("get", "/seo/search-console/status");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      enabled: true,
      credentialsSaved: false,
      credentialsFromEnv: true,
      credentialSource: "environment",
      clientId: maskGscClientId(SERVER_CLIENT_ID),
    });
    expect(JSON.stringify(response.body)).not.toContain(SERVER_SECRET);
    expect(JSON.stringify(response.body)).not.toContain(SERVER_CLIENT_ID);
  });

  it("does not silently claim an environment fallback when workspace credential storage is unavailable", async () => {
    mockDbQuery.mockRejectedValue(new Error("relation search_console_oauth_config does not exist"));

    const response = await invokeRoute("get", "/seo/search-console/status");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      enabled: false,
      credentialsFromEnv: true,
      credentialSource: "none",
      clientId: null,
      credentialErrorCode: "credential_storage_unavailable",
    });
    expect(JSON.stringify(response.body)).not.toContain(SERVER_SECRET);
    expect(JSON.stringify(response.body)).not.toContain(SERVER_CLIENT_ID);
  });

  it("reports a workspace override ahead of environment credentials", async () => {
    const encrypted = encryptGscOauthClient({
      clientId: WORKSPACE_CLIENT_ID,
      clientSecret: WORKSPACE_SECRET,
    });
    mockOauthConfig(encrypted);

    const response = await invokeRoute("get", "/seo/search-console/status");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      credentialsSaved: true,
      credentialsFromEnv: true,
      credentialSource: "workspace",
      clientId: maskGscClientId(WORKSPACE_CLIENT_ID),
    });
    expect(JSON.stringify(response.body)).not.toContain(WORKSPACE_SECRET);
    expect(JSON.stringify(response.body)).not.toContain(SERVER_SECRET);
  });

  it("keeps the credential detail response secret-free for environment credentials", async () => {
    mockOauthConfig(null);

    const response = await invokeRoute("get", "/seo/search-console/credentials");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      saved: false,
      credentialsFromEnv: true,
      credentialSource: "environment",
      clientId: maskGscClientId(SERVER_CLIENT_ID),
    });
    expect(JSON.stringify(response.body)).not.toContain(SERVER_SECRET);
    expect(JSON.stringify(response.body)).not.toContain(SERVER_CLIENT_ID);
  });

  it("returns a recoverable error when credential storage has not been initialized", async () => {
    mockDbQuery.mockRejectedValue(new Error("relation search_console_oauth_config does not exist"));

    const response = await invokeRoute("get", "/seo/search-console/credentials");

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      code: "credential_storage_unavailable",
    });
    expect(JSON.stringify(response.body)).not.toContain(SERVER_SECRET);
    expect(JSON.stringify(response.body)).not.toContain(SERVER_CLIENT_ID);
  });

  it("creates or replaces an encrypted workspace override even when environment credentials exist", async () => {
    const response = await invokeRoute("post", "/seo/search-console/credentials", {
      body: {
        clientId: WORKSPACE_CLIENT_ID,
        clientSecret: WORKSPACE_SECRET,
      },
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      credentialSource: "workspace",
      clientId: maskGscClientId(WORKSPACE_CLIENT_ID),
      reauthorizationRequired: true,
    });
    expect(JSON.stringify(response.body)).not.toContain(WORKSPACE_SECRET);

    const insertCall = mockClientQuery.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO search_console_oauth_config"),
    );
    expect(insertCall).toBeDefined();
    const encrypted = (insertCall?.[1] as unknown[])[1] as string;
    expect(encrypted).not.toContain(WORKSPACE_SECRET);
    expect(decryptGscOauthClient(encrypted)).toEqual({
      clientId: WORKSPACE_CLIENT_ID,
      clientSecret: WORKSPACE_SECRET,
    });
    expect(mockClientQuery).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM search_console_oauth_states"),
      ["owner_test"],
    );
  });

  it("preserves an existing connection when identical workspace credentials are re-saved", async () => {
    const encrypted = encryptGscOauthClient({
      clientId: WORKSPACE_CLIENT_ID,
      clientSecret: WORKSPACE_SECRET,
    });
    mockClientQuery.mockImplementation(async (sql: unknown) => {
      if (String(sql).includes("FROM search_console_oauth_config")) {
        return {
          rows: [{
            id: 1,
            workspace_owner_id: "owner_test",
            oauth_client_encrypted: encrypted,
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    });

    const response = await invokeRoute("post", "/seo/search-console/credentials", {
      body: {
        clientId: ` ${WORKSPACE_CLIENT_ID} `,
        clientSecret: ` ${WORKSPACE_SECRET} `,
      },
    });

    expect(response.body).toMatchObject({
      ok: true,
      credentialSource: "workspace",
      reauthorizationRequired: false,
    });
    expect(mockClientQuery.mock.calls.some(([sql]) =>
      String(sql).includes("DELETE FROM search_console_connections"),
    )).toBe(false);
    expect(mockClientQuery).toHaveBeenCalledWith("COMMIT");
  });

  it("uses the workspace override for the next OAuth authorization URL", async () => {
    const encrypted = encryptGscOauthClient({
      clientId: WORKSPACE_CLIENT_ID,
      clientSecret: WORKSPACE_SECRET,
    });
    mockClientQuery.mockImplementation(async (sql: unknown) => {
      const query = String(sql);
      if (query.includes("FROM search_console_oauth_config")) {
        return { rows: [{ oauth_client_encrypted: encrypted }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    const response = await invokeRoute("get", "/seo/search-console/auth-url");

    expect(response.status).toBe(200);
    const url = new URL(response.body.url as string);
    expect(url.searchParams.get("client_id")).toBe(WORKSPACE_CLIENT_ID);
    expect(url.searchParams.get("state")).toMatch(/^[a-f0-9]{64}$/);
    expect(response.body.url).not.toContain(SERVER_CLIENT_ID);
    expect(response.body.url).not.toContain(WORKSPACE_SECRET);
    expect(mockClientQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO search_console_oauth_states"),
      [url.searchParams.get("state"), "owner_test"],
    );
    expect(mockClientQuery).toHaveBeenCalledWith(
      expect.stringContaining("pg_advisory_xact_lock"),
      ["gsc-oauth:owner_test"],
    );
  });

  it("clears the workspace override and explicitly falls back to environment credentials", async () => {
    mockClientQuery.mockImplementation(async (sql: unknown) => ({
      rows: String(sql).includes("connections_deleted")
        ? [{ connections_deleted: 1 }]
        : [],
      rowCount: 1,
    }));

    const response = await invokeRoute("delete", "/seo/search-console/credentials");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      credentialSource: "environment",
      reauthorizationRequired: true,
    });
    expect(mockClientQuery).toHaveBeenCalledWith(
      expect.stringContaining("pg_advisory_xact_lock"),
      ["gsc-oauth:owner_test"],
    );
  });

  it("reports no effective credentials after clearing when no environment fallback exists", async () => {
    delete process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_ID;
    delete process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET;
    mockClientQuery.mockImplementation(async (sql: unknown) => ({
      rows: String(sql).includes("connections_deleted")
        ? [{ connections_deleted: 1 }]
        : [],
      rowCount: 1,
    }));

    const response = await invokeRoute("delete", "/seo/search-console/credentials");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      credentialSource: "none",
      reauthorizationRequired: true,
    });
  });

  it("does not require reauthorization when clearing an override without a connection", async () => {
    mockClientQuery.mockImplementation(async (sql: unknown) => ({
      rows: String(sql).includes("connections_deleted")
        ? [{ connections_deleted: 0 }]
        : [],
      rowCount: 1,
    }));

    const response = await invokeRoute("delete", "/seo/search-console/credentials");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      credentialSource: "environment",
      reauthorizationRequired: false,
    });
    expect(mockClientQuery).toHaveBeenCalledWith(
      expect.stringContaining("invalidated_states"),
      ["owner_test"],
    );
  });

  it("rejects callback completion by a non-owner before consuming OAuth state", async () => {
    const response = await invokeRoute("get", "/seo/search-console/callback", {
      role: "member",
      query: { code: "auth_code", state: "valid_state" },
    });

    expect(response.redirect).toBe("/seo-analytics?gsc_error=owner_required");
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("rejects callbacks with missing, mismatched, or replayed state", async () => {
    const missing = await invokeRoute("get", "/seo/search-console/callback", {
      query: { code: "auth_code" },
    });
    expect(missing.redirect).toBe("/seo-analytics?gsc_error=state_missing");

    mockClientQuery.mockImplementation(async (sql: unknown) => ({
      rows: String(sql).includes("DELETE FROM search_console_oauth_states")
        ? []
        : [],
      rowCount: 0,
    }));
    const mismatched = await invokeRoute("get", "/seo/search-console/callback", {
      query: { code: "auth_code", state: "invalid_state" },
    });
    expect(mismatched.redirect).toBe("/seo-analytics?gsc_error=state_mismatch");

    delete process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_ID;
    delete process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET;
    let stateAvailable = true;
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockClientQuery.mockImplementation(async (sql: unknown) => {
      if (String(sql).includes("DELETE FROM search_console_oauth_states")) {
        if (!stateAvailable) return { rows: [], rowCount: 0 };
        stateAvailable = false;
        return {
          rows: [{ workspace_owner_id: "owner_test" }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const firstUse = await invokeRoute("get", "/seo/search-console/callback", {
      query: { code: "auth_code", state: "single_use_state" },
    });
    expect(firstUse.redirect).toBe(
      "/seo-analytics?gsc_error=not_configured",
    );

    const replay = await invokeRoute("get", "/seo/search-console/callback", {
      query: { code: "auth_code", state: "single_use_state" },
    });
    expect(replay.redirect).toBe("/seo-analytics?gsc_error=state_mismatch");
  });

  it("exchanges a valid callback code with the workspace override", async () => {
    const encrypted = encryptGscOauthClient({
      clientId: WORKSPACE_CLIENT_ID,
      clientSecret: WORKSPACE_SECRET,
    });
    let stateAvailable = true;
    mockDbQuery.mockImplementation(async (sql: unknown) => {
      const query = String(sql);
      if (query.includes("FROM search_console_oauth_config")) {
        return {
          rows: [{ oauth_client_encrypted: encrypted }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    mockClientQuery.mockImplementation(async (sql: unknown) => {
      const query = String(sql);
      if (query.includes("DELETE FROM search_console_oauth_states")) {
        if (!stateAvailable) return { rows: [], rowCount: 0 };
        stateAvailable = false;
        return {
          rows: [{ workspace_owner_id: "owner_test" }],
          rowCount: 1,
        };
      }
      if (query.includes("INSERT INTO search_console_connections")) {
        return { rows: [{ id: 99 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          access_token: "access_token",
          refresh_token: "refresh_token",
          expires_in: 3600,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          siteEntry: [{
            siteUrl: "sc-domain:example.com",
            permissionLevel: "siteOwner",
          }],
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const response = await invokeRoute("get", "/seo/search-console/callback", {
      query: { code: "auth_code", state: "single_use_state" },
    });

    expect(response.redirect).toBe("/seo-analytics?gsc_connected=1");
    const tokenRequest = fetchMock.mock.calls[0][1] as { body: string };
    const tokenBody = new URLSearchParams(tokenRequest.body);
    expect(tokenBody.get("client_id")).toBe(WORKSPACE_CLIENT_ID);
    expect(tokenBody.get("client_secret")).toBe(WORKSPACE_SECRET);
    expect(stateAvailable).toBe(false);
    expect(mockClientQuery).toHaveBeenCalledWith(
      expect.stringContaining("pg_advisory_lock"),
      ["gsc-oauth:owner_test"],
    );
    expect(mockClientQuery).toHaveBeenCalledWith(
      expect.stringContaining("pg_advisory_unlock"),
      ["gsc-oauth:owner_test"],
    );
  });

  it("consumes a supplied OAuth state when Google denies authorization", async () => {
    let stateAvailable = true;
    mockClientQuery.mockImplementation(async (sql: unknown) => {
      if (String(sql).includes("DELETE FROM search_console_oauth_states")) {
        if (!stateAvailable) return { rows: [], rowCount: 0 };
        stateAvailable = false;
        return {
          rows: [{ workspace_owner_id: "owner_test" }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    });

    const response = await invokeRoute("get", "/seo/search-console/callback", {
      query: { error: "access_denied", state: "denied_state" },
    });

    expect(response.redirect).toBe("/seo-analytics?gsc_error=access_denied");
    expect(mockClientQuery).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM search_console_oauth_states"),
      ["denied_state"],
    );

    const replay = await invokeRoute("get", "/seo/search-console/callback", {
      query: { code: "auth_code", state: "denied_state" },
    });
    expect(replay.redirect).toBe("/seo-analytics?gsc_error=state_mismatch");
  });

  it("returns a recoverable error when a secure OAuth state cannot be stored", async () => {
    mockClientQuery.mockImplementation(async (sql: unknown) => {
      const query = String(sql);
      if (query.includes("FROM search_console_oauth_config")) {
        return { rows: [], rowCount: 0 };
      }
      if (query.includes("INSERT INTO search_console_oauth_states")) {
        throw new Error("database unavailable");
      }
      return { rows: [], rowCount: 0 };
    });

    const response = await invokeRoute("get", "/seo/search-console/auth-url");

    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({ code: "oauth_state_failed" });
  });

  it("returns a recoverable configuration error when encryption is unavailable", async () => {
    delete process.env.CREDENTIAL_ENCRYPTION_KEY;

    const response = await invokeRoute("post", "/seo/search-console/credentials", {
      body: {
        clientId: WORKSPACE_CLIENT_ID,
        clientSecret: WORKSPACE_SECRET,
      },
    });

    expect(response.status).toBe(503);
    expect(response.body.code).toBe("encryption_unavailable");
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("rejects invalid input without replacing the active credential", async () => {
    const response = await invokeRoute("post", "/seo/search-console/credentials", {
      body: { clientId: " ", clientSecret: WORKSPACE_SECRET },
    });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("invalid_client_id");
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("reports save failures and leaves the previous credential active", async () => {
    mockClientQuery.mockImplementation(async (sql: unknown) => {
      if (String(sql).includes("INSERT INTO search_console_oauth_config")) {
        throw new Error("database unavailable");
      }
      return { rows: [], rowCount: 1 };
    });

    const response = await invokeRoute("post", "/seo/search-console/credentials", {
      body: {
        clientId: WORKSPACE_CLIENT_ID,
        clientSecret: WORKSPACE_SECRET,
      },
    });

    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({
      code: "save_failed",
      error: expect.stringContaining("previous credential remains active"),
    });
    expect(JSON.stringify(response.body)).not.toContain(WORKSPACE_SECRET);
    expect(mockClientQuery).toHaveBeenCalledWith("ROLLBACK");
  });
});