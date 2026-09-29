import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockDbQuery } = vi.hoisted(() => ({
  mockDbQuery: vi.fn(),
}));

vi.mock("./db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
  },
}));

vi.mock("./logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  encryptGscOauthClient,
  fetchSearchConsoleRows,
  resolveGscOauthClient,
  type GscCredentials,
  type GscOauthClient,
} from "./searchConsoleSync";

const ENCRYPTION_KEY = "22".repeat(32);

describe("Search Console OAuth client resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    process.env.CREDENTIAL_ENCRYPTION_KEY = ENCRYPTION_KEY;
    process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_ID = "server-client";
    process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET = "server-secret";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    delete process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_ID;
    delete process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET;
  });

  it("prefers a valid workspace override to server credentials", async () => {
    const workspaceClient: GscOauthClient = {
      clientId: "workspace-client",
      clientSecret: "workspace-secret",
    };
    mockDbQuery.mockResolvedValue({
      rows: [{
        oauth_client_encrypted: encryptGscOauthClient(workspaceClient),
      }],
      rowCount: 1,
    });

    await expect(resolveGscOauthClient("owner_test")).resolves.toEqual(workspaceClient);
  });

  it("uses the resolved workspace client when refreshing an expired access token", async () => {
    const workspaceClient: GscOauthClient = {
      clientId: "workspace-refresh-client",
      clientSecret: "workspace-refresh-secret",
    };
    const creds: GscCredentials = {
      refreshToken: "refresh-token",
      accessToken: null,
      expiresAt: null,
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "new-access-token",
        expires_in: 3600,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ rows: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));

    await fetchSearchConsoleRows(
      creds,
      "https://example.com/",
      "2026-08-01",
      "2026-08-02",
      workspaceClient,
    );

    const tokenBody = String(fetchMock.mock.calls[0]?.[1]?.body);
    const params = new URLSearchParams(tokenBody);
    expect(params.get("client_id")).toBe(workspaceClient.clientId);
    expect(params.get("client_secret")).toBe(workspaceClient.clientSecret);
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer new-access-token",
    });
  });
});