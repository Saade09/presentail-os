import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

vi.mock("./db", () => ({ db: { query: vi.fn(), connect: vi.fn() } }));
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("./credentialEncryption", () => ({
  encrypt: (s: string) => `enc:${s}`,
  decrypt: (s: string) => s.replace(/^enc:/, ""),
}));
vi.mock("./reviewAttribution", () => ({
  ingestReview: vi.fn(),
  markReviewDeleted: vi.fn(),
  REWARD_PENDING_DAYS: 7,
}));

import { db } from "./db";
import { ingestReview, markReviewDeleted } from "./reviewAttribution";
import {
  processGbpNotification,
  upsertFetchedReview,
  handleDeletedReview,
  resolveGbpOauthClient,
  gbpOauthConfigured,
  maskGbpClientId,
  fetchGbpLocation,
  exchangeGbpCode,
  getGbpAccessToken,
  type GbpCredentials,
} from "./googleBusinessProfile";

const mockQuery = vi.mocked(db.query);
const mockIngest = vi.mocked(ingestReview);
const mockMarkDeleted = vi.mocked(markReviewDeleted);

const CONN_ROW = {
  id: 1,
  workspace_owner_id: "owner-1",
  credentials_encrypted: `enc:${JSON.stringify({
    refreshToken: "rt",
    accessToken: "at",
    expiresAt: Date.now() + 3_600_000,
  })}`,
  account_name: "accounts/111",
  account_label: "Presentail",
  location_name: "locations/222",
  location_title: "Presentail Beirut",
  notifications_state: null,
  last_error: null,
  last_synced_at: null,
};

// Real GBP v4 Review responses omit the full `name` resource field — the
// implementation must derive provenance from the request context.
const REVIEW_JSON = {
  reviewId: "rev-1",
  reviewer: { displayName: "Jane" },
  starRating: "FIVE",
  comment: "Great!",
  createTime: "2026-08-10T10:00:00Z",
  updateTime: "2026-08-10T10:00:00Z",
};

function fetchResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response;
}

const originalFetch = global.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 } as never);
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.unstubAllEnvs();
});

describe("Google Business Profile OAuth client resolution", () => {
  it("uses encrypted workspace credentials when shared GBP secrets are absent", async () => {
    vi.stubEnv("GBP_OAUTH_CLIENT_ID", "");
    vi.stubEnv("GBP_OAUTH_CLIENT_SECRET", "");
    const query = {
      query: vi.fn().mockResolvedValue({
        rows: [{
          oauth_client_encrypted: `enc:${JSON.stringify({
            clientId: "workspace-client-id.apps.googleusercontent.com",
            clientSecret: "workspace-secret",
          })}`,
        }],
      }),
    };

    await expect(resolveGbpOauthClient("owner-1", query as never)).resolves.toEqual(
      expect.objectContaining({
        clientId: "workspace-client-id.apps.googleusercontent.com",
        clientSecret: "workspace-secret",
      }),
    );
    expect(maskGbpClientId("workspace-client-id.apps.googleusercontent.com")).toBe(
      "worksp….com",
    );
  });

  it("uses only the dedicated GBP environment credentials", async () => {
    vi.stubEnv("GBP_OAUTH_CLIENT_ID", "gbp-client-id.apps.googleusercontent.com");
    vi.stubEnv("GBP_OAUTH_CLIENT_SECRET", "gbp-client-secret");
    vi.stubEnv("GOOGLE_CLIENT_ID", "business-posts-client-id.apps.googleusercontent.com");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "business-posts-client-secret");

    const query = vi.fn();
    await expect(resolveGbpOauthClient("owner-1", { query } as never)).resolves.toEqual({
      clientId: "gbp-client-id.apps.googleusercontent.com",
      clientSecret: "gbp-client-secret",
    });
    expect(query).not.toHaveBeenCalled();
    expect(gbpOauthConfigured()).toBe(true);
  });

  it("keeps the tracked deployment metadata from defining a GBP client", () => {
    const dotReplit = fs.readFileSync(
      path.resolve(import.meta.dirname, "../../../../.replit"),
      "utf8",
    );
    expect(dotReplit).not.toMatch(/^GBP_OAUTH_CLIENT_ID\s*=/m);
    expect(dotReplit).not.toMatch(/^GBP_OAUTH_CLIENT_SECRET\s*=/m);
  });

  it("does not treat generic Google credentials as GBP credentials", async () => {
    vi.stubEnv("GBP_OAUTH_CLIENT_ID", "");
    vi.stubEnv("GBP_OAUTH_CLIENT_SECRET", "");
    vi.stubEnv("GOOGLE_CLIENT_ID", "business-posts-client-id.apps.googleusercontent.com");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "business-posts-client-secret");

    await expect(resolveGbpOauthClient("owner-1", {
      query: vi.fn().mockResolvedValue({ rows: [] }),
    } as never)).resolves.toBeNull();
    expect(gbpOauthConfigured()).toBe(false);
  });

  it("binds newly exchanged refresh tokens to the exact dedicated GBP client", async () => {
    global.fetch = vi.fn().mockResolvedValue(fetchResponse(200, {
      access_token: "access-1",
      refresh_token: "refresh-1",
      expires_in: 3600,
    }));

    const credentials = await exchangeGbpCode(
      "code",
      "https://example.com/callback",
      { clientId: "dedicated-client", clientSecret: "dedicated-secret" },
    );

    expect(credentials.oauthClient).toEqual({
      clientId: "dedicated-client",
      clientSecret: "dedicated-secret",
    });
  });

  it("recovers a bound refresh token after a secret rotation for the same client ID", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fetchResponse(401, {
        error: "invalid_client",
        error_description: "The provided client secret is invalid.",
      }))
      .mockResolvedValueOnce(fetchResponse(200, {
        access_token: "recovered-access",
        expires_in: 3600,
      }));
    global.fetch = fetchMock;
    const credentials: GbpCredentials = {
      refreshToken: "legacy-refresh",
      accessToken: null,
      expiresAt: null,
      oauthClient: {
        clientId: "dedicated-client",
        clientSecret: "stale-secret",
      },
    };

    await expect(getGbpAccessToken(credentials, {
      clientId: "dedicated-client",
      clientSecret: "current-secret",
    })).resolves.toBe("recovered-access");

    expect(credentials.oauthClient).toEqual({
      clientId: "dedicated-client",
      clientSecret: "current-secret",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("requires reconnect immediately when a cached token is bound to a different client ID", async () => {
    global.fetch = vi.fn();
    const credentials: GbpCredentials = {
      refreshToken: "bound-refresh",
      accessToken: "still-valid-access",
      expiresAt: Date.now() + 3_600_000,
      oauthClient: {
        clientId: "issuing-client",
        clientSecret: "issuing-secret",
      },
    };

    await expect(getGbpAccessToken(credentials, {
      clientId: "different-authoritative-client",
      clientSecret: "different-secret",
    })).rejects.toMatchObject({
      status: 401,
      code: "oauth_client_mismatch",
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("turns an unrecoverable legacy invalid_grant response into reconnect-required", async () => {
    global.fetch = vi.fn().mockResolvedValue(fetchResponse(400, {
      error: "invalid_grant",
      error_description: "Bad Request",
    }));
    const credentials: GbpCredentials = {
      refreshToken: "bound-refresh",
      accessToken: null,
      expiresAt: null,
    };

    await expect(getGbpAccessToken(credentials, {
      clientId: "authoritative-client",
      clientSecret: "authoritative-secret",
    })).rejects.toMatchObject({
      status: 401,
      code: "invalid_grant",
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const body = new URLSearchParams(String(vi.mocked(global.fetch).mock.calls[0][1]?.body));
    expect(body.get("client_id")).toBe("authoritative-client");
  });
});

describe("processGbpNotification", () => {
  it("ignores non-review notification types", async () => {
    expect(
      await processGbpNotification({ notificationType: "GOOGLE_UPDATE" }),
    ).toBe("ignored");
    expect(mockIngest).not.toHaveBeenCalled();
  });

  it("ignores notifications for unconnected locations", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never); // findByLocation
    expect(
      await processGbpNotification({
        notificationType: "NEW_REVIEW",
        reviewName: "accounts/111/locations/999/reviews/rev-9",
      }),
    ).toBe("ignored");
    expect(mockIngest).not.toHaveBeenCalled();
    expect(String(mockQuery.mock.calls[0][0])).toContain("gc.credentials_encrypted <> ''");
    expect(String(mockQuery.mock.calls[1][0])).toContain("credentials_encrypted <> ''");
  });

  it("ignores notifications whose locationName does not match the review resource", async () => {
    for (const locationName of ["locations/999", "accounts/111/locations/999"]) {
      expect(
        await processGbpNotification({
          notificationType: "NEW_REVIEW",
          reviewName: "accounts/111/locations/222/reviews/rev-1",
          locationName,
        }),
      ).toBe("ignored");
    }
    expect(mockIngest).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("accepts the account-qualified locationName compatibility variant", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [CONN_ROW], rowCount: 1 } as never);
    global.fetch = vi.fn().mockResolvedValue(fetchResponse(200, REVIEW_JSON));
    mockIngest.mockResolvedValue({
      reviewId: 10, created: true, matchStatus: "unmatched",
      matchedProfileId: null, rewardId: null,
    } as never);
    expect(
      await processGbpNotification({
        notificationType: "NEW_REVIEW",
        reviewName: "accounts/111/locations/222/reviews/rev-1",
        locationName: "accounts/111/locations/222",
      }),
    ).toBe("ok");
  });

  it("fetches the review and ingests it from the documented GBP envelope (reviewName + locationName)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [CONN_ROW], rowCount: 1 } as never); // findByLocation
    global.fetch = vi.fn().mockResolvedValue(fetchResponse(200, REVIEW_JSON));
    mockIngest.mockResolvedValue({
      reviewId: 10, created: true, matchStatus: "auto_matched",
      matchedProfileId: 5, rewardId: 3,
    } as never);

    expect(
      await processGbpNotification({
        notificationType: "NEW_REVIEW",
        reviewName: "accounts/111/locations/222/reviews/rev-1",
        locationName: "locations/222", // canonical documented form
      }),
    ).toBe("ok");
    // Provenance persisted from the notification's reviewName even though the
    // fetched v4 payload omits `name`.
    const provCall = mockQuery.mock.calls.find(([sql]) =>
      String(sql).includes("SET gbp_review_name"),
    );
    expect(provCall).toBeTruthy();
    expect(provCall![1]).toEqual([
      "owner-1",
      "rev-1",
      "accounts/111/locations/222/reviews/rev-1",
    ]);

    expect(mockIngest).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceOwnerId: "owner-1",
        googleReviewId: "rev-1",
        reviewerName: "Jane",
        rating: 5,
        comment: "Great!",
      }),
    );
  });

  it("is idempotent on replay: duplicate notification creates no extra records", async () => {
    global.fetch = vi.fn().mockResolvedValue(fetchResponse(200, REVIEW_JSON));

    // First delivery — new review.
    mockQuery.mockResolvedValueOnce({ rows: [CONN_ROW], rowCount: 1 } as never);
    mockIngest.mockResolvedValueOnce({
      reviewId: 10, created: true, matchStatus: "unmatched",
      matchedProfileId: null, rewardId: null,
    } as never);
    await processGbpNotification({
      notificationType: "NEW_REVIEW",
      review: "accounts/111/locations/222/reviews/rev-1",
    });
    const queriesAfterFirst = mockQuery.mock.calls.length;

    // Replay — ingestReview dedupes by google reviewId (created: false),
    // so the only extra write is the mutable-field refresh, never a new row.
    mockQuery.mockResolvedValueOnce({ rows: [CONN_ROW], rowCount: 1 } as never);
    mockIngest.mockResolvedValueOnce({
      reviewId: 10, created: false, matchStatus: "unmatched",
      matchedProfileId: null, rewardId: null,
    } as never);
    await processGbpNotification({
      notificationType: "UPDATED_REVIEW",
      reviewName: "accounts/111/locations/222/reviews/rev-1",
    });

    expect(mockIngest).toHaveBeenCalledTimes(2);
    const replayQueries = mockQuery.mock.calls.slice(queriesAfterFirst);
    const inserts = replayQueries.filter(([sql]) =>
      String(sql).includes("INSERT INTO google_reviews"),
    );
    expect(inserts).toHaveLength(0);
    const updates = replayQueries.filter(([sql]) =>
      String(sql).includes("UPDATE google_reviews"),
    );
    expect(updates).toHaveLength(1);
  });

  it("voids the reward when the review fetch 404s (deleted review)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [CONN_ROW], rowCount: 1 } as never); // findByLocation
    global.fetch = vi.fn().mockResolvedValue(
      fetchResponse(404, { error: { message: "not found" } }),
    );
    // handleDeletedReview lookup: stored, not yet deleted.
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 10, is_deleted: false }], rowCount: 1,
    } as never);

    expect(
      await processGbpNotification({
        notificationType: "UPDATED_REVIEW",
        reviewName: "accounts/111/locations/222/reviews/rev-1",
      }),
    ).toBe("ok");
    expect(mockMarkDeleted).toHaveBeenCalledWith("owner-1", 10);
    expect(mockIngest).not.toHaveBeenCalled();
  });

  it("records the error on the connection and rethrows on transient fetch failure", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [CONN_ROW], rowCount: 1 } as never);
    global.fetch = vi.fn().mockResolvedValue(
      fetchResponse(500, { error: { message: "backend error" } }),
    );

    await expect(
      processGbpNotification({
        notificationType: "NEW_REVIEW",
        reviewName: "accounts/111/locations/222/reviews/rev-1",
      }),
    ).rejects.toThrow(/GBP review fetch failed \(500\)/);

    const errorUpdate = mockQuery.mock.calls.find(([sql]) =>
      String(sql).includes("SET last_error = $2"),
    );
    expect(errorUpdate).toBeTruthy();
    expect(String(errorUpdate![1]![1])).toContain("Notification processing failed");
  });
});

describe("listRecentGbpReviews pagination", () => {
  function page(reviews: unknown[], nextPageToken?: string) {
    return fetchResponse(200, { reviews, nextPageToken });
  }
  // Raw v4 payloads omit `name` — provenance must be derived.
  const raw = (id: string, updateTime: string) => ({
    reviewId: id,
    starRating: "FOUR",
    updateTime,
    createTime: updateTime,
  });

  it("follows nextPageToken across multiple pages", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(page([raw("a", "2026-08-12T10:00:00Z")], "tok-2"))
      .mockResolvedValueOnce(page([raw("b", "2026-08-11T10:00:00Z")], "tok-3"))
      .mockResolvedValueOnce(page([raw("c", "2026-08-10T10:00:00Z")]));
    global.fetch = fetchMock;

    const { listRecentGbpReviews } = await import("./googleBusinessProfile");
    const reviews = await listRecentGbpReviews("at", "accounts/111", "locations/222");
    expect(reviews.map((r) => r.reviewId)).toEqual(["a", "b", "c"]);
    // Provenance is derived from the account/location even though the raw
    // v4 payload has no `name` field.
    expect(reviews[0].name).toBe("accounts/111/locations/222/reviews/a");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[1][0])).toContain("pageToken=tok-2");
    expect(String(fetchMock.mock.calls[2][0])).toContain("pageToken=tok-3");
  });

  it("stops paginating once results predate updatedSince", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(page([raw("a", "2026-08-12T10:00:00Z")], "tok-2"))
      .mockResolvedValueOnce(page([raw("b", "2026-01-01T10:00:00Z")], "tok-3"));
    global.fetch = fetchMock;

    const { listRecentGbpReviews } = await import("./googleBusinessProfile");
    const reviews = await listRecentGbpReviews("at", "accounts/111", "locations/222", {
      updatedSince: new Date("2026-08-01T00:00:00Z"),
    });
    expect(reviews.map((r) => r.reviewId)).toEqual(["a", "b"]);
    expect(fetchMock).toHaveBeenCalledTimes(2); // tok-3 never fetched
  });

  it("caps the sweep at maxPages", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      page([raw("x", "2026-08-12T10:00:00Z")], "tok-next"),
    );
    global.fetch = fetchMock;

    const { listRecentGbpReviews } = await import("./googleBusinessProfile");
    await listRecentGbpReviews("at", "accounts/111", "locations/222", { maxPages: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("account/location discovery pagination", () => {
  it("follows nextPageToken for accounts and locations", async () => {
    const fetchMock = vi
      .fn()
      // accounts page 1 + 2
      .mockResolvedValueOnce(fetchResponse(200, {
        accounts: [{ name: "accounts/1", accountName: "A" }], nextPageToken: "ap2",
      }))
      .mockResolvedValueOnce(fetchResponse(200, {
        accounts: [{ name: "accounts/2", accountName: "B" }],
      }))
      // locations for accounts/1: pages 1 + 2
      .mockResolvedValueOnce(fetchResponse(200, {
        locations: [{
          name: "locations/11",
          title: "L11",
          storefrontAddress: {
            addressLines: ["Hamra Street 12"],
            locality: "Beirut",
            administrativeArea: "Beirut",
          },
          metadata: { hasVoiceOfMerchant: true },
        }],
        nextPageToken: "lp2",
      }))
      .mockResolvedValueOnce(fetchResponse(200, {
        locations: [{ name: "locations/12", title: "L12" }],
      }))
      // locations for accounts/2
      .mockResolvedValueOnce(fetchResponse(200, {
        locations: [{ name: "locations/21", title: "L21", metadata: { hasVoiceOfMerchant: true } }],
      }));
    global.fetch = fetchMock;

    const { listAllGbpLocationOptions } = await import("./googleBusinessProfile");
    const options = await listAllGbpLocationOptions("at");
    expect(options.map((o) => o.name)).toEqual(["locations/11", "locations/12", "locations/21"]);
    expect(options[2].accountName).toBe("accounts/2");
    expect(options[0].address).toBe("Hamra Street 12, Beirut");
    expect(String(fetchMock.mock.calls[1][0])).toContain("pageToken=ap2");
    expect(String(fetchMock.mock.calls[3][0])).toContain("pageToken=lp2");
  });

  it("falls back to the administrative area when locality is absent", async () => {
    global.fetch = vi.fn().mockResolvedValue(fetchResponse(200, {
      locations: [{
        name: "locations/dubai",
        title: "Presentail",
        storefrontAddress: {
          administrativeArea: "Dubai",
          regionCode: "AE",
        },
      }, {
        name: "locations/beirut",
        title: "Presentail",
        storefrontAddress: {
          locality: "Beirut",
          administrativeArea: "Mount Lebanon",
          regionCode: "LB",
        },
      }, {
        name: "locations/unverified",
        title: "Presentail",
        metadata: { hasVoiceOfMerchant: false },
      }],
    }));

    const { listGbpLocations } = await import("./googleBusinessProfile");
    await expect(listGbpLocations("at", "accounts/1")).resolves.toEqual([
      expect.objectContaining({
        name: "locations/dubai",
        locality: "Dubai",
        regionCode: "AE",
        verified: null,
      }),
      expect.objectContaining({
        name: "locations/beirut",
        locality: "Beirut",
        regionCode: "LB",
        verified: null,
      }),
      expect.objectContaining({
        name: "locations/unverified",
        verified: false,
      }),
    ]);
  });

  it("fetches one location's current structured metadata", async () => {
    global.fetch = vi.fn().mockResolvedValue(fetchResponse(200, {
      name: "locations/11",
      title: "Presentail",
      storefrontAddress: {
        locality: "Beirut",
        administrativeArea: "Beirut",
        regionCode: "LB",
      },
      metadata: { hasVoiceOfMerchant: true },
    }));

    await expect(fetchGbpLocation("at", "locations/11")).resolves.toEqual({
      name: "locations/11",
      title: "Presentail",
      address: "Beirut",
      verified: true,
      regionCode: "LB",
      locality: "Beirut",
    });
    expect(String(vi.mocked(global.fetch).mock.calls[0][0])).toContain(
      "locations/11?readMask=name,title,storefrontAddress,metadata",
    );
  });
});

describe("upsertFetchedReview", () => {
  it("records provenance (full resource name) for newly created reviews without refreshing fields", async () => {
    mockIngest.mockResolvedValue({
      reviewId: 11, created: true, matchStatus: "unmatched",
      matchedProfileId: null, rewardId: null,
    } as never);
    const result = await upsertFetchedReview("owner-1", {
      name: "accounts/111/locations/222/reviews/rev-2",
      reviewId: "rev-2", reviewerName: "Bob", rating: 4,
      comment: null, createTime: null, updateTime: null,
    });
    expect(result).toEqual({ reviewId: 11, created: true });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain("SET gbp_review_name");
    expect(params).toEqual(["owner-1", "rev-2", "accounts/111/locations/222/reviews/rev-2"]);
  });
});

describe("handleDeletedReview", () => {
  it("is a no-op for unknown or already-deleted reviews", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    expect(await handleDeletedReview("owner-1", "rev-x")).toBe(false);

    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 10, is_deleted: true }], rowCount: 1,
    } as never);
    expect(await handleDeletedReview("owner-1", "rev-1")).toBe(false);
    expect(mockMarkDeleted).not.toHaveBeenCalled();
  });
});
