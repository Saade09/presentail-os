import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import express from "express";
import request from "supertest";

const workspaceAccess = vi.hoisted(() => ({
  role: "owner" as "owner" | "member",
  allowedPages: null as string[] | null,
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../lib/db", () => ({ db: { query: vi.fn(), connect: vi.fn() } }));
vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
}));
vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => next(),
  workspace: () => ({
    workspaceOwnerId: "owner-1",
    workspaceRole: workspaceAccess.role,
    workspaceActualRole: workspaceAccess.role,
    allowedPages: workspaceAccess.allowedPages,
  }),
  hasPageAccess: (
    wreq: { workspaceRole: "owner" | "member"; allowedPages: string[] | null },
    page: string,
  ) => wreq.workspaceRole === "owner" || !!wreq.allowedPages?.includes(page),
}));
vi.mock("../lib/googleBusinessProfile", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/googleBusinessProfile")>();
  return {
    ...actual,
    gbpOauthConfigured: vi.fn().mockReturnValue(true),
    resolveGbpOauthClient: vi.fn().mockResolvedValue({
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
    }),
    loadGbpConnection: vi.fn(),
    processGbpNotification: vi.fn(),
    exchangeGbpCode: vi.fn().mockResolvedValue({
      refreshToken: "rt", accessToken: "at", expiresAt: Date.now() + 3_600_000,
    }),
    getGbpAccessToken: vi.fn().mockResolvedValue("at"),
    listGbpAccounts: vi.fn().mockResolvedValue([
      { name: "accounts/999", accountName: "New Account", type: "PERSONAL" },
    ]),
    listAllGbpLocationOptions: vi.fn().mockResolvedValue([]),
    decryptGbpOauthClient: vi.fn().mockReturnValue({
      clientId: "workspace-client-id.apps.googleusercontent.com",
      clientSecret: "workspace-secret",
    }),
    decryptGbpCredentials: vi.fn().mockReturnValue({
      refreshToken: "rt", accessToken: "at", expiresAt: Date.now() + 3_600_000,
    }),
    updateGbpNotificationSetting: vi.fn().mockResolvedValue({
      pubsubTopic: "projects/p/topics/t",
      notificationTypes: ["NEW_REVIEW", "UPDATED_REVIEW"],
    }),
    encryptGbpCredentials: vi.fn().mockReturnValue("enc"),
  };
});

import gbpReviewsRouter, { gbpPubSubRouter } from "./gbpReviews";
import { db } from "../lib/db";
import {
  loadGbpConnection,
  processGbpNotification,
  GbpApiError,
  resolveGbpOauthClient,
} from "../lib/googleBusinessProfile";

const mockLoadConn = vi.mocked(loadGbpConnection);
const mockDbQuery = vi.mocked(db.query);
const mockDbConnect = vi.mocked(db.connect);
const mockProcess = vi.mocked(processGbpNotification);
const mockResolveGbpOauthClient = vi.mocked(resolveGbpOauthClient);

const mockLog = {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(),
};

const app = express();
app.use(express.json());
// Attach a mock pino-style req.log so catch-block req.log.error() calls don't throw.
app.use((req, _res, next) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (req as any).log = mockLog;
  next();
});
app.use("/api", gbpPubSubRouter);
app.use("/api", gbpReviewsRouter);

const TOKEN = "push-token-1";
const PINNED_REDIRECT = "https://os.presentail.com/api/reviews/google/callback";
const prevToken = process.env.GBP_PUBSUB_PUSH_TOKEN;
const prevTopic = process.env.GBP_PUBSUB_TOPIC;
const prevRedirect = process.env.GOOGLE_REDIRECT_URI;
const prevLegacyRedirect = process.env.GBP_OAUTH_REDIRECT_URI;

function envelope(notification: unknown) {
  return {
    message: {
      data: Buffer.from(JSON.stringify(notification)).toString("base64"),
      messageId: "m-1",
    },
    subscription: "projects/p/subscriptions/s",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  workspaceAccess.role = "owner";
  workspaceAccess.allowedPages = null;
  process.env.GBP_PUBSUB_PUSH_TOKEN = TOKEN;
  process.env.GBP_PUBSUB_TOPIC = "projects/p/topics/gbp-reviews";
  process.env.GOOGLE_REDIRECT_URI = PINNED_REDIRECT;
  delete process.env.GBP_OAUTH_REDIRECT_URI;
  mockProcess.mockResolvedValue("ok");
});

afterAll(() => {
  if (prevToken === undefined) delete process.env.GBP_PUBSUB_PUSH_TOKEN;
  else process.env.GBP_PUBSUB_PUSH_TOKEN = prevToken;
  if (prevTopic === undefined) delete process.env.GBP_PUBSUB_TOPIC;
  else process.env.GBP_PUBSUB_TOPIC = prevTopic;
  if (prevRedirect === undefined) delete process.env.GOOGLE_REDIRECT_URI;
  else process.env.GOOGLE_REDIRECT_URI = prevRedirect;
  if (prevLegacyRedirect === undefined) delete process.env.GBP_OAUTH_REDIRECT_URI;
  else process.env.GBP_OAUTH_REDIRECT_URI = prevLegacyRedirect;
});

describe("POST /api/webhooks/gbp-pubsub", () => {
  it("returns 503 when the push token is not configured", async () => {
    delete process.env.GBP_PUBSUB_PUSH_TOKEN;
    const res = await request(app).post("/api/webhooks/gbp-pubsub").send({});
    expect(res.status).toBe(503);
    expect(mockProcess).not.toHaveBeenCalled();
  });

  it("rejects a missing or wrong token with 401", async () => {
    const res = await request(app)
      .post("/api/webhooks/gbp-pubsub?token=wrong")
      .send(envelope({ notificationType: "NEW_REVIEW" }));
    expect(res.status).toBe(401);
    expect(mockProcess).not.toHaveBeenCalled();
  });

  it("decodes the Pub/Sub message and processes it (ack 204)", async () => {
    const notification = {
      notificationType: "NEW_REVIEW",
      reviewName: "accounts/111/locations/222/reviews/rev-1",
    };
    const res = await request(app)
      .post(`/api/webhooks/gbp-pubsub?token=${TOKEN}`)
      .send(envelope(notification));
    expect(res.status).toBe(204);
    expect(mockProcess).toHaveBeenCalledWith(notification);
  });

  it("acks duplicate/replayed deliveries the same way (idempotent processing)", async () => {
    const notification = {
      notificationType: "UPDATED_REVIEW",
      reviewName: "accounts/111/locations/222/reviews/rev-1",
    };
    for (let i = 0; i < 3; i++) {
      const res = await request(app)
        .post(`/api/webhooks/gbp-pubsub?token=${TOKEN}`)
        .send(envelope(notification));
      expect(res.status).toBe(204);
    }
    expect(mockProcess).toHaveBeenCalledTimes(3);
  });

  it("acks undecodable messages so Pub/Sub does not retry poison pills", async () => {
    const res = await request(app)
      .post(`/api/webhooks/gbp-pubsub?token=${TOKEN}`)
      .send({ message: { data: "!!!not-base64-json!!!", messageId: "m-2" } });
    expect(res.status).toBe(204);
    expect(mockProcess).not.toHaveBeenCalled();
  });

  it("returns 500 on transient processing failure so Pub/Sub retries", async () => {
    mockProcess.mockRejectedValueOnce(new Error("db down"));
    const res = await request(app)
      .post(`/api/webhooks/gbp-pubsub?token=${TOKEN}`)
      .send(envelope({ notificationType: "NEW_REVIEW", reviewName: "accounts/1/locations/2/reviews/3" }));
    expect(res.status).toBe(500);
  });

  it("acks permanent permission failures (403) instead of retrying forever", async () => {
    mockProcess.mockRejectedValueOnce(new GbpApiError("forbidden", 403));
    const res = await request(app)
      .post(`/api/webhooks/gbp-pubsub?token=${TOKEN}`)
      .send(envelope({ notificationType: "NEW_REVIEW", reviewName: "accounts/1/locations/2/reviews/3" }));
    expect(res.status).toBe(204);
  });
});

describe("GET /api/reviews/google/callback — error classification", () => {
  function stateOk() {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{ workspace_owner_id: "owner-1" }],
        rowCount: 1,
      } as never) // state DELETE
      .mockResolvedValue({ rows: [], rowCount: 0 } as never); // last_error UPDATE + upsert
  }

  it("redirects to api_disabled when GBP API returns 403 SERVICE_DISABLED", async () => {
    stateOk();
    const { exchangeGbpCode } = await import("../lib/googleBusinessProfile");
    vi.mocked(exchangeGbpCode).mockRejectedValueOnce(
      new GbpApiError("GBP OAuth token exchange failed (403): SERVICE_DISABLED", 403),
    );
    const res = await request(app).get(
      "/api/reviews/google/callback?code=abc&state=s1",
    );
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/review-rewards?gbp_error=api_disabled");
    // last_error must be persisted
    const update = mockDbQuery.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE gbp_connections SET last_error"),
    );
    expect(update).toBeTruthy();
    expect(String(update![1][1])).toContain("SERVICE_DISABLED");
  });

  it("redirects to quota_exceeded when GBP API returns 429 RESOURCE_EXHAUSTED", async () => {
    stateOk();
    const { listGbpAccounts } = await import("../lib/googleBusinessProfile");
    vi.mocked(listGbpAccounts).mockRejectedValueOnce(
      new GbpApiError("GBP accounts list failed (429): RESOURCE_EXHAUSTED", 429),
    );
    const res = await request(app).get(
      "/api/reviews/google/callback?code=abc&state=s2",
    );
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/review-rewards?gbp_error=quota_exceeded");
    const update = mockDbQuery.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE gbp_connections SET last_error"),
    );
    expect(update).toBeTruthy();
  });

  it("redirects to quota_exceeded when error message contains RESOURCE_EXHAUSTED (any status)", async () => {
    stateOk();
    const { exchangeGbpCode } = await import("../lib/googleBusinessProfile");
    vi.mocked(exchangeGbpCode).mockRejectedValueOnce(
      new GbpApiError("GBP OAuth token exchange failed (403): RESOURCE_EXHAUSTED quota exceeded", 403),
    );
    const res = await request(app).get(
      "/api/reviews/google/callback?code=abc&state=s3",
    );
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/review-rewards?gbp_error=quota_exceeded");
  });

  it("redirects to token_exchange_failed when the token exchange label appears in the error", async () => {
    stateOk();
    const { exchangeGbpCode } = await import("../lib/googleBusinessProfile");
    vi.mocked(exchangeGbpCode).mockRejectedValueOnce(
      new GbpApiError("GBP OAuth token exchange failed (401): invalid_client", 401),
    );
    const res = await request(app).get(
      "/api/reviews/google/callback?code=abc&state=s4",
    );
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/review-rewards?gbp_error=token_exchange_failed");
    const update = mockDbQuery.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE gbp_connections SET last_error"),
    );
    expect(update).toBeTruthy();
    expect(String(update![1][1])).toContain("token exchange");
  });

  it("redirects to token_exchange_failed when token response is missing fields", async () => {
    stateOk();
    const { exchangeGbpCode } = await import("../lib/googleBusinessProfile");
    vi.mocked(exchangeGbpCode).mockRejectedValueOnce(
      new GbpApiError("Token response missing access_token or refresh_token"),
    );
    const res = await request(app).get(
      "/api/reviews/google/callback?code=abc&state=s5",
    );
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/review-rewards?gbp_error=token_exchange_failed");
  });

  it("falls back to callback_failed for unknown errors", async () => {
    stateOk();
    const { exchangeGbpCode } = await import("../lib/googleBusinessProfile");
    vi.mocked(exchangeGbpCode).mockRejectedValueOnce(new Error("network timeout"));
    const res = await request(app).get(
      "/api/reviews/google/callback?code=abc&state=s6",
    );
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/review-rewards?gbp_error=callback_failed");
    const update = mockDbQuery.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE gbp_connections SET last_error"),
    );
    expect(update).toBeTruthy();
    expect(String(update![1][1])).toContain("network timeout");
  });
});

describe("GET /api/reviews/google/callback — OAuth state validation", () => {
  it("rejects a callback with no state", async () => {
    const res = await request(app).get("/api/reviews/google/callback?code=abc");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/review-rewards?gbp_error=state_missing");
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("rejects an unknown/expired/replayed state (single-use consume)", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never); // DELETE consumed nothing
    const res = await request(app).get(
      "/api/reviews/google/callback?code=abc&state=deadbeef",
    );
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/review-rewards?gbp_error=state_mismatch");
    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(String(sql)).toContain("DELETE FROM gbp_oauth_states");
    expect(params).toEqual(["deadbeef"]);
  });

  it("rejects a state issued to a different workspace", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ workspace_owner_id: "someone-else" }],
      rowCount: 1,
    } as never);
    const res = await request(app).get(
      "/api/reviews/google/callback?code=abc&state=deadbeef",
    );
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/review-rewards?gbp_error=state_mismatch");
  });

  it("resets the selected location and notification state on (re)connect", async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{ workspace_owner_id: "owner-1" }], rowCount: 1,
      } as never) // state consumed OK
      .mockResolvedValue({ rows: [], rowCount: 1 } as never); // upsert
    const res = await request(app).get(
      "/api/reviews/google/callback?code=abc&state=goodstate",
    );
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/review-rewards?gbp_connected=1");
    const gbp = await import("../lib/googleBusinessProfile");
    // Token exchange must use the exact pinned redirect URI.
    expect(vi.mocked(gbp.exchangeGbpCode)).toHaveBeenCalledWith(
      "abc",
      PINNED_REDIRECT,
      expect.objectContaining({ clientId: "test-client-id" }),
    );
    const upsert = mockDbQuery.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO gbp_connections"),
    );
    expect(upsert).toBeTruthy();
    const sql = String(upsert![0]);
    // Stale account/location pairing must be cleared — explicit reselection.
    expect(sql).toContain("location_name         = NULL");
    expect(sql).toContain("location_title        = NULL");
    expect(sql).toContain("notifications_state   = NULL");
  });
});

describe("GET /api/reviews/google/auth-url", () => {
  it("issues a high-entropy single-use state bound to the workspace", async () => {
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 1 } as never);
    const res = await request(app).get("/api/reviews/google/auth-url");
    expect(res.status).toBe(200);
    const authUrl = new URL(res.body.url);
    const state = authUrl.searchParams.get("state")!;
    expect(state).toMatch(/^[0-9a-f]{64}$/); // 32 random bytes, not the owner id
    expect(authUrl.searchParams.get("prompt")).toBe("consent select_account");
    const insert = mockDbQuery.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO gbp_oauth_states"),
    );
    expect(insert).toBeTruthy();
    expect(insert![1]).toEqual([state, "owner-1"]);
  });

  it("uses the effective dedicated GBP client ID for reconnect OAuth", async () => {
    mockResolveGbpOauthClient.mockResolvedValueOnce({
      clientId: "528216136004-dedicated.apps.googleusercontent.com",
      clientSecret: "dedicated-secret",
    });
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 1 } as never);

    const res = await request(app).get("/api/reviews/google/auth-url");

    expect(res.status).toBe(200);
    expect(new URL(res.body.url).searchParams.get("client_id")).toBe(
      "528216136004-dedicated.apps.googleusercontent.com",
    );
  });

  it("pins redirect_uri to GOOGLE_REDIRECT_URI regardless of request host/proto", async () => {
    const proxied = express();
    proxied.set("trust proxy", true);
    proxied.use(express.json());
    proxied.use("/api", gbpReviewsRouter);
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 1 } as never);
    const res = await request(proxied)
      .get("/api/reviews/google/auth-url")
      .set("X-Forwarded-Proto", "http") // request-derived values must be ignored
      .set("X-Forwarded-Host", "some-preview.replit.dev");
    expect(res.status).toBe(200);
    const url = new URL(res.body.url);
    expect(url.searchParams.get("redirect_uri")).toBe(PINNED_REDIRECT);
    expect(url.searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/business.manage",
    );
  });

  it("falls back to the request origin when GOOGLE_REDIRECT_URI is missing (dev mode)", async () => {
    delete process.env.GOOGLE_REDIRECT_URI;
    delete process.env.GBP_OAUTH_REDIRECT_URI;
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 1 } as never);
    const res = await request(app).get("/api/reviews/google/auth-url");
    // Should succeed — derives redirect URI from the request origin
    expect(res.status).toBe(200);
    const redirectUri = new URL(res.body.url).searchParams.get("redirect_uri")!;
    expect(redirectUri).toContain("/api/reviews/google/callback");
    expect(mockDbQuery).toHaveBeenCalled();
  });

  it("accepts legacy GBP_OAUTH_REDIRECT_URI, with GOOGLE_REDIRECT_URI taking precedence", async () => {
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 1 } as never);
    delete process.env.GOOGLE_REDIRECT_URI;
    process.env.GBP_OAUTH_REDIRECT_URI = "https://legacy.example.com/cb";
    let res = await request(app).get("/api/reviews/google/auth-url");
    expect(res.status).toBe(200);
    expect(new URL(res.body.url).searchParams.get("redirect_uri")).toBe(
      "https://legacy.example.com/cb",
    );
    process.env.GOOGLE_REDIRECT_URI = PINNED_REDIRECT;
    res = await request(app).get("/api/reviews/google/auth-url");
    expect(res.status).toBe(200);
    expect(new URL(res.body.url).searchParams.get("redirect_uri")).toBe(PINNED_REDIRECT);
  });
});

describe("location selection — multi-account + exclusive tenancy", () => {
  const CONN = {
    id: 1, workspace_owner_id: "owner-1", credentials_encrypted: "enc",
    account_name: "accounts/999", account_label: "New Account",
    location_name: null, location_title: null, notifications_state: null,
    last_error: null, last_synced_at: null,
  };

  it("lists locations across every managed account with account attribution", async () => {
    mockLoadConn.mockResolvedValue(CONN as never);
    const { listAllGbpLocationOptions } = await import("../lib/googleBusinessProfile");
    vi.mocked(listAllGbpLocationOptions).mockResolvedValueOnce([
      { name: "locations/1", title: "First", verified: true, accountName: "accounts/999", accountLabel: "New Account", locality: "Achrafieh" },
      { name: "locations/2", title: "Other-account loc", verified: true, accountName: "accounts/777", accountLabel: "Second Account", locality: null },
    ]);
    const res = await request(app).get("/api/reviews/google/locations");
    expect(res.status).toBe(200);
    expect(res.body.accounts).toEqual([
      { name: "accounts/999", accountName: "New Account", type: "PERSONAL" },
    ]);
    expect(res.body.connectedAccount).toEqual({
      name: "accounts/999",
      label: "New Account",
    });
    expect(res.body.locations).toHaveLength(2);
    expect(res.body.locations[1].accountName).toBe("accounts/777");
    expect(res.body.locations[0].locality).toBe("Achrafieh");
    expect(res.body.locations[1].locality).toBeNull();
  });

  it("persists the dedicated GBP client binding after a legacy token refresh recovers", async () => {
    mockLoadConn.mockResolvedValue(CONN as never);
    const gbp = await import("../lib/googleBusinessProfile");
    vi.mocked(gbp.decryptGbpCredentials).mockReturnValueOnce({
      refreshToken: "legacy-refresh",
      accessToken: null,
      expiresAt: null,
    });
    vi.mocked(gbp.getGbpAccessToken).mockImplementationOnce(async (creds) => {
      creds.accessToken = "recovered-access";
      creds.expiresAt = Date.now() + 3_600_000;
      creds.oauthClient = {
        clientId: "dedicated-client",
        clientSecret: "dedicated-secret",
      };
      return "recovered-access";
    });
    vi.mocked(gbp.listAllGbpLocationOptions).mockResolvedValueOnce([]);
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 1 } as never);

    const res = await request(app).get("/api/reviews/google/locations");

    expect(res.status).toBe(200);
    expect(gbp.encryptGbpCredentials).toHaveBeenCalledWith(
      expect.objectContaining({
        oauthClient: {
          clientId: "dedicated-client",
          clientSecret: "dedicated-secret",
        },
      }),
    );
    expect(mockDbQuery.mock.calls.some(([sql]) =>
      String(sql).includes("SET credentials_encrypted = $2"),
    )).toBe(true);
  });

  it("returns an actionable error when Google rejects all dedicated GBP clients", async () => {
    mockLoadConn.mockResolvedValue(CONN as never);
    const gbp = await import("../lib/googleBusinessProfile");
    vi.mocked(gbp.getGbpAccessToken).mockRejectedValueOnce(
      new GbpApiError(
        "GBP OAuth token refresh failed (401): The provided client secret is invalid.",
        401,
      ),
    );

    const res = await request(app).get("/api/reviews/google/locations");

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      code: "gbp_reauthorization_required",
      error: expect.stringContaining("dedicated Business Profile OAuth credentials"),
    });
  });

  it("keeps enabled database locations visible when Google omits them", async () => {
    mockLoadConn.mockResolvedValue(CONN as never);
    const { listAllGbpLocationOptions } = await import("../lib/googleBusinessProfile");
    vi.mocked(listAllGbpLocationOptions).mockResolvedValueOnce([
      { name: "locations/1", title: "Healthy", verified: true, accountName: "accounts/999", accountLabel: "New Account", locality: "Hamra" },
    ]);
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        { id: 1, location_name: "locations/1", location_title: "Healthy", location_locality: "Hamra", account_name: "accounts/999", is_enabled: true, last_error: null, last_synced_at: null, review_url: null },
        { id: 2, location_name: "locations/beirut", location_title: "Presentail", location_locality: "Beirut", account_name: "accounts/999", is_enabled: true, last_error: "Location unavailable", last_synced_at: null, review_url: null },
        { id: 3, location_name: "locations/old", location_title: "Old", location_locality: null, account_name: "accounts/999", is_enabled: false, last_error: null, last_synced_at: null, review_url: null },
      ],
      rowCount: 3,
    } as never);

    const res = await request(app).get("/api/reviews/google/locations");

    expect(res.status).toBe(200);
    expect(res.body.locations).toHaveLength(2);
    expect(res.body.locations[0]).toMatchObject({
      name: "locations/1", selected: true, connectionStatus: "connected", availableInGoogle: true,
    });
    expect(res.body.locations[1]).toMatchObject({
      name: "locations/beirut",
      title: "Presentail",
      locality: "Beirut",
      selected: true,
      isEnabled: true,
      verified: false,
      connectionStatus: "needs_attention",
      availableInGoogle: false,
      lastError: "Location unavailable",
    });
  });

  it("remaps an unambiguous renamed Google location without replacing its local row", async () => {
    mockLoadConn.mockResolvedValue(CONN as never);
    const { listAllGbpLocationOptions } = await import("../lib/googleBusinessProfile");
    vi.mocked(listAllGbpLocationOptions).mockResolvedValueOnce([
      {
        name: "locations/new-resource",
        title: "Presentail",
        locality: "Beirut",
        verified: true,
        accountName: "accounts/999",
        accountLabel: "New Account",
      },
    ]);
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{
          id: 42,
          gbp_connection_id: 1,
          location_name: "locations/old-resource",
          location_title: "Presentail",
          location_locality: "Beirut",
          account_name: "accounts/999",
          is_enabled: true,
          last_error: "Reconciliation failed: old resource",
          last_synced_at: null,
          review_url: null,
        }],
        rowCount: 1,
      } as never)
      .mockResolvedValue({ rows: [], rowCount: 1 } as never);

    const res = await request(app).get("/api/reviews/google/locations");

    expect(res.status).toBe(200);
    expect(res.body.locations).toEqual([
      expect.objectContaining({
        name: "locations/new-resource",
        connectionId: 42,
        selected: true,
        connectionStatus: "connected",
        availableInGoogle: true,
      }),
    ]);
    const remap = mockDbQuery.mock.calls.find(([sql]) =>
      String(sql).includes("SET location_name = $2"),
    );
    expect(remap?.[1]).toEqual([
      42,
      "locations/new-resource",
      "Presentail",
      "Beirut",
      "accounts/999",
      "owner-1",
      "locations/old-resource",
    ]);
    expect(String(remap?.[0])).toContain("last_error = NULL");
  });

  it("refreshes an exact location's account binding without replacing its local row", async () => {
    const connected = {
      ...CONN,
      account_name: "accounts/old",
      location_name: "locations/1",
    };
    mockLoadConn.mockResolvedValue(connected as never);
    const gbp = await import("../lib/googleBusinessProfile");
    vi.mocked(gbp.listAllGbpLocationOptions).mockResolvedValueOnce([
      {
        name: "locations/1",
        title: "Presentail Hamra",
        locality: "Hamra",
        verified: true,
        accountName: "accounts/new",
        accountLabel: "Presentail Group",
      },
    ]);
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{
          id: 42,
          gbp_connection_id: 1,
          location_name: "locations/1",
          location_title: "Presentail Hamra",
          location_locality: "Hamra",
          account_name: "accounts/old",
          is_enabled: true,
          last_error: "Review listing returned 404",
          last_synced_at: null,
          review_url: null,
        }],
        rowCount: 1,
      } as never)
      .mockResolvedValue({ rows: [], rowCount: 1 } as never);

    const res = await request(app).get("/api/reviews/google/locations");

    expect(res.status).toBe(200);
    expect(res.body.locations).toEqual([
      expect.objectContaining({
        name: "locations/1",
        connectionId: 42,
        selected: true,
        connectionStatus: "connected",
        accountName: "accounts/new",
      }),
    ]);
    const bindingUpdate = mockDbQuery.mock.calls.find(([sql]) =>
      String(sql).includes("SET account_name = $2"),
    );
    expect(bindingUpdate?.[1]).toEqual([
      42,
      "accounts/new",
      "Presentail Hamra",
      "Hamra",
      "owner-1",
      "locations/1",
      "accounts/old",
    ]);
  });

  it("removes an omitted stale location without disabling a selected healthy location", async () => {
    mockLoadConn.mockResolvedValue(CONN as never);
    const gbp = await import("../lib/googleBusinessProfile");
    vi.mocked(gbp.listAllGbpLocationOptions).mockResolvedValueOnce([
      { name: "locations/healthy", title: "Healthy", verified: true, accountName: "accounts/999", accountLabel: "New Account" },
    ]);
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const mockClient = {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      release: vi.fn(),
    };
    vi.mocked(db.connect).mockResolvedValue(mockClient as never);

    const res = await request(app)
      .post("/api/reviews/google/locations")
      .send({ locationNames: ["locations/healthy"] });

    expect(res.status).toBe(200);
    expect(res.body.enabledCount).toBe(1);
    const disable = mockClient.query.mock.calls.find(([sql]) =>
      String(sql).includes("Soft-disable") || String(sql).includes("SET is_enabled = false"),
    );
    expect(disable?.[1]).toEqual(["owner-1", ["locations/healthy"]]);
    const healthyUpsert = mockClient.query.mock.calls.find(([sql, params]) =>
      String(sql).includes("INSERT INTO gbp_location_connections") &&
      Array.isArray(params) &&
      params[2] === "locations/healthy",
    );
    expect(healthyUpsert).toBeTruthy();
  });

  it("allows owners to remove the final stale location without dropping the Google connection", async () => {
    mockLoadConn.mockResolvedValue(CONN as never);
    const gbp = await import("../lib/googleBusinessProfile");
    vi.mocked(gbp.listAllGbpLocationOptions).mockResolvedValueOnce([]);
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const mockClient = {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      release: vi.fn(),
    };
    vi.mocked(db.connect).mockResolvedValue(mockClient as never);

    const res = await request(app)
      .post("/api/reviews/google/locations")
      .send({ locationNames: [] });

    expect(res.status).toBe(200);
    expect(res.body.enabledCount).toBe(0);
    const clearParent = mockClient.query.mock.calls.find(([sql]) =>
      String(sql).includes("SET location_name = NULL"),
    );
    expect(clearParent?.[1]).toEqual(["owner-1"]);
  });

  it("selects a verified location from a non-first account, subscribing on the owning account", async () => {
    mockLoadConn.mockResolvedValue(CONN as never);
    // Preflight conflict check — no conflicts from other workspaces.
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    // Supply a mock pool client for the transaction.
    const mockClient = {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      release: vi.fn(),
    };
    vi.mocked(db.connect).mockResolvedValue(mockClient as never);
    const gbp = await import("../lib/googleBusinessProfile");
    vi.mocked(gbp.listAllGbpLocationOptions).mockResolvedValueOnce([
      { name: "locations/2", title: "Other", verified: true, accountName: "accounts/777", accountLabel: "Second Account" },
    ]);
    process.env.GBP_PUBSUB_TOPIC = "projects/p/topics/t";
    const res = await request(app)
      .post("/api/reviews/google/location")
      .send({ locationName: "locations/2" });
    expect(res.status).toBe(200);
    expect(vi.mocked(gbp.updateGbpNotificationSetting)).toHaveBeenCalledWith(
      "at", "accounts/777", "projects/p/topics/t",
    );
    // UPDATE gbp_connections is inside the transaction, so check mockClient.query.
    const update = (mockClient.query as ReturnType<typeof vi.fn>).mock.calls.find(([sql]: [unknown]) =>
      String(sql).includes("UPDATE gbp_connections"),
    );
    expect(update![1]).toEqual([
      "owner-1", "accounts/777", "Second Account", "locations/2", "Other",
      JSON.stringify({ pubsubTopic: "projects/p/topics/t", notificationTypes: ["NEW_REVIEW", "UPDATED_REVIEW"] }),
      null,
    ]);
  });

  it("allows a managed location when Google omits verification metadata", async () => {
    mockLoadConn.mockResolvedValue(CONN as never);
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    const mockClient = {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
      release: vi.fn(),
    };
    vi.mocked(db.connect).mockResolvedValue(mockClient as never);
    const gbp = await import("../lib/googleBusinessProfile");
    vi.mocked(gbp.listAllGbpLocationOptions).mockResolvedValueOnce([
      {
        name: "locations/no-verification-field",
        title: "Presentail",
        verified: null,
        accountName: "accounts/999",
        accountLabel: "New Account",
      },
    ]);

    const res = await request(app)
      .post("/api/reviews/google/locations")
      .send({ locationNames: ["locations/no-verification-field"] });

    expect(res.status).toBe(200);
    expect(mockClient.query.mock.calls.some(([sql]) =>
      String(sql).includes("INSERT INTO gbp_location_connections"),
    )).toBe(true);
  });

  it("returns 409 when the location is already connected to another workspace", async () => {
    mockLoadConn.mockResolvedValue(CONN as never);
    const gbp = await import("../lib/googleBusinessProfile");
    vi.mocked(gbp.listAllGbpLocationOptions).mockResolvedValueOnce([
      { name: "locations/2", title: "Other", verified: true, accountName: "accounts/777", accountLabel: null },
    ]);
    // Preflight returns a conflicting row owned by a different workspace.
    mockDbQuery.mockResolvedValueOnce({ rows: [{ location_name: "locations/2" }], rowCount: 1 } as never);
    const res = await request(app)
      .post("/api/reviews/google/location")
      .send({ locationName: "locations/2" });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("already connected to another workspace");
  });
});

describe("DELETE /api/reviews/google/connection", () => {
  it("clears OAuth credentials without cascading tracked location rows", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    const res = await request(app).delete("/api/reviews/google/connection");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const disconnect = mockDbQuery.mock.calls[0];
    expect(String(disconnect[0])).toContain("UPDATE gbp_connections");
    expect(String(disconnect[0])).toContain("credentials_encrypted = ''");
    expect(String(disconnect[0])).not.toContain("DELETE FROM");
    expect(String(disconnect[0])).not.toContain("gbp_location_connections");
  });
});

describe("GET /api/reviews/google/status", () => {
  it("reports shared credentials as authoritative even when a workspace fallback is saved", async () => {
    const previousClientId = process.env.GBP_OAUTH_CLIENT_ID;
    process.env.GBP_OAUTH_CLIENT_ID = "shared-client-id.apps.googleusercontent.com";
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ id: 1, workspace_owner_id: "owner-1", oauth_client_encrypted: "enc" }],
      rowCount: 1,
    } as never);

    try {
      const res = await request(app).get("/api/reviews/google/credentials");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        saved: true,
        credentialsFromEnv: true,
        credentialSource: "environment",
        clientId: "shared….com",
        credentialError: null,
      });
    } finally {
      if (previousClientId === undefined) delete process.env.GBP_OAUTH_CLIENT_ID;
      else process.env.GBP_OAUTH_CLIENT_ID = previousClientId;
    }
  });

  it("clears a workspace override instead of saving a competing client when GBP env credentials exist", async () => {
    const previousClientId = process.env.GBP_OAUTH_CLIENT_ID;
    const previousClientSecret = process.env.GBP_OAUTH_CLIENT_SECRET;
    process.env.GBP_OAUTH_CLIENT_ID = "528216136004-dedicated.apps.googleusercontent.com";
    process.env.GBP_OAUTH_CLIENT_SECRET = "dedicated-secret";

    const clientQuery = vi.fn(async (sql: string) => {
      if (sql.includes("FROM gbp_oauth_config")) {
        return {
          rows: [{
            id: 1,
            workspace_owner_id: "owner-1",
            oauth_client_encrypted: "enc",
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("DELETE FROM gbp_oauth_config")) {
        return { rows: [{ "?column?": 1 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    mockDbConnect.mockResolvedValueOnce({
      query: clientQuery,
      release: vi.fn(),
    } as never);

    try {
      const res = await request(app)
        .post("/api/reviews/google/credentials")
        .send({
          clientId: "528216136004-dedicated.apps.googleusercontent.com",
          clientSecret: "dedicated-secret",
        });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        credentialSource: "environment",
        clientId: "528216….com",
        workspaceOverrideCleared: true,
        reauthorizationRequired: false,
      });
      expect(clientQuery.mock.calls.some(([sql]) =>
        String(sql).includes("DELETE FROM gbp_oauth_config"),
      )).toBe(true);
      expect(clientQuery.mock.calls.some(([sql]) =>
        String(sql).includes("INSERT INTO gbp_oauth_config"),
      )).toBe(false);
      expect(clientQuery.mock.calls.some(([sql]) =>
        String(sql).includes("UPDATE gbp_connections"),
      )).toBe(false);
    } finally {
      if (previousClientId === undefined) delete process.env.GBP_OAUTH_CLIENT_ID;
      else process.env.GBP_OAUTH_CLIENT_ID = previousClientId;
      if (previousClientSecret === undefined) delete process.env.GBP_OAUTH_CLIENT_SECRET;
      else process.env.GBP_OAUTH_CLIENT_SECRET = previousClientSecret;
    }
  });

  it("clears a dormant workspace fallback without deleting the GBP connection", async () => {
    const clientQuery = vi.fn(async (sql: string) => {
      if (sql.includes("DELETE FROM gbp_oauth_config")) {
        return { rows: [{ "?column?": 1 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    mockDbConnect.mockResolvedValueOnce({
      query: clientQuery,
      release: vi.fn(),
    } as never);

    const res = await request(app).delete("/api/reviews/google/credentials");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      credentialSource: "environment",
      reauthorizationRequired: false,
    });
    expect(clientQuery.mock.calls.some(([sql]) =>
      String(sql).includes("DELETE FROM gbp_connections"),
    )).toBe(false);
  });

  it("lets a page-permitted member read safe connection status without credential details", async () => {
    workspaceAccess.role = "member";
    workspaceAccess.allowedPages = ["review-rewards"];
    mockLoadConn.mockResolvedValue({
      id: 1,
      workspace_owner_id: "owner-1",
      credentials_encrypted: "enc",
      account_name: "accounts/111",
      account_label: "Presentail",
      location_name: "locations/222",
      location_title: "Presentail Beirut",
      notifications_state: null,
      last_error: null,
      last_synced_at: "2026-08-12T00:00:00Z",
    });
    mockDbQuery.mockResolvedValue({ rows: [{ count: "1" }], rowCount: 1 } as never);

    const res = await request(app).get("/api/reviews/google/status");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      connected: true,
      enabledCount: 1,
      locationTitle: "Presentail Beirut",
    });
    expect(res.body).not.toHaveProperty("clientId");
    expect(res.body).not.toHaveProperty("credentialsSaved");
    expect(res.body).not.toHaveProperty("notifications");
    expect(res.body).not.toHaveProperty("lastError");
  });

  it("denies a member without the Review Rewards page permission", async () => {
    workspaceAccess.role = "member";
    workspaceAccess.allowedPages = [];

    const res = await request(app).get("/api/reviews/google/status");

    expect(res.status).toBe(403);
    expect(mockLoadConn).not.toHaveBeenCalled();
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("keeps Google setup and management endpoints owner-only", async () => {
    workspaceAccess.role = "member";
    workspaceAccess.allowedPages = ["review-rewards"];

    const responses = await Promise.all([
      request(app).get("/api/reviews/google/auth-url"),
      request(app).get("/api/reviews/google/callback?code=abc&state=state"),
      request(app).get("/api/reviews/google/credentials"),
      request(app).post("/api/reviews/google/credentials").send({ clientId: "id", clientSecret: "secret" }),
      request(app).delete("/api/reviews/google/credentials"),
      request(app).get("/api/reviews/google/locations"),
      request(app).post("/api/reviews/google/locations").send({ locationNames: [] }),
      request(app).post("/api/reviews/google/location").send({ locationName: "locations/1" }),
      request(app).delete("/api/reviews/google/connection"),
    ]);

    expect(responses.map((response) => response.status)).toEqual([
      403, 403, 403, 403, 403, 403, 403, 403, 403,
    ]);
    const gbp = await import("../lib/googleBusinessProfile");
    expect(vi.mocked(gbp.exchangeGbpCode)).not.toHaveBeenCalled();
  });

  it("reports a full connection with notification state", async () => {
    mockLoadConn.mockResolvedValue({
      id: 1,
      workspace_owner_id: "owner-1",
      credentials_encrypted: "enc",
      account_name: "accounts/111",
      account_label: "Presentail",
      location_name: "locations/222",
      location_title: "Presentail Beirut",
      notifications_state: JSON.stringify({
        pubsubTopic: "projects/p/topics/gbp-reviews",
        notificationTypes: ["NEW_REVIEW", "UPDATED_REVIEW"],
      }),
      last_error: null,
      last_synced_at: "2026-08-12T00:00:00Z",
    });
    const res = await request(app).get("/api/reviews/google/status");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      enabled: true,
      connected: true,
      accountName: "accounts/111",
      locationName: "locations/222",
      locationSelected: true,
      notificationsConfigured: true,
      pubsubTopicConfigured: true,
      pushTokenConfigured: true,
      lastError: null,
    });
    expect(res.body.notifications.notificationTypes).toEqual([
      "NEW_REVIEW",
      "UPDATED_REVIEW",
    ]);
  });

  it("reports not-connected and surfaces missing Pub/Sub config", async () => {
    delete process.env.GBP_PUBSUB_TOPIC;
    delete process.env.GBP_PUBSUB_PUSH_TOKEN;
    mockLoadConn.mockResolvedValue(null);
    const res = await request(app).get("/api/reviews/google/status");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      connected: false,
      locationSelected: false,
      notificationsConfigured: false,
      pubsubTopicConfigured: false,
      pushTokenConfigured: false,
    });
  });

  it("surfaces lastError from failed processing on the connection", async () => {
    mockLoadConn.mockResolvedValue({
      id: 1,
      workspace_owner_id: "owner-1",
      credentials_encrypted: "enc",
      account_name: "accounts/111",
      account_label: null,
      location_name: "locations/222",
      location_title: null,
      notifications_state: null,
      last_error: "Notification processing failed: GBP review fetch failed (500)",
      last_synced_at: null,
    });
    const res = await request(app).get("/api/reviews/google/status");
    expect(res.status).toBe(200);
    expect(res.body.lastError).toContain("Notification processing failed");
  });
});
