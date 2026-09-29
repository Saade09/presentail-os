import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

const { mockDbQuery, mockValidateGoogleAds } = vi.hoisted(() => ({
  mockDbQuery: vi.fn(),
  mockValidateGoogleAds: vi.fn(),
}));

vi.mock("../lib/db", () => ({
  db: { query: (...args: unknown[]) => mockDbQuery(...args) },
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
}));

let workspaceRole: "owner" | "member" = "owner";
vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = "owner_123";
    wreq.workspaceRole = workspaceRole;
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

vi.mock("../lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock("../lib/adPlatformSync", () => ({
  AD_PLATFORMS: ["google_ads", "meta_ads"],
  PLATFORM_SOURCE: {
    google_ads: "google_ads_api",
    meta_ads: "meta_ads_api",
  },
  encryptCredentials: vi.fn(),
  runAdPlatformSync: vi.fn(),
  validateGoogleAdsAnalytics: mockValidateGoogleAds,
  serviceAccountConfig: () => ({
    customerId: "123-456-7890",
    serviceAccountJson: "{\"redacted\":true}",
    loginCustomerId: null,
  }),
  GOOGLE_ADS_CONFIG_VARS: [
    "GOOGLE_ADS_SERVICE_ACCOUNT_JSON",
    "GOOGLE_ADS_CUSTOMER_ID",
    "GOOGLE_ADS_LOGIN_CUSTOMER_ID",
    "GOOGLE_ADS_WORKSPACE_OWNER_ID",
  ],
  GoogleAdsAnalyticsError: class GoogleAdsAnalyticsError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  },
  isGoogleAdsWorkspaceAllowed: (ownerId: string) =>
    ownerId === process.env.GOOGLE_ADS_WORKSPACE_OWNER_ID,
  validateMetaAds: vi.fn(),
}));

import adPlatformsRouter from "./adPlatforms";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as never;
    next();
  });
  app.use(adPlatformsRouter);
  return app;
}

describe("paid-link Ads conversion health alerts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspaceRole = "owner";
    process.env.GOOGLE_ADS_SERVICE_ACCOUNT_JSON = "{\"redacted\":true}";
    process.env.GOOGLE_ADS_CUSTOMER_ID = "123-456-7890";
    process.env.GOOGLE_ADS_WORKSPACE_OWNER_ID = "owner_123";
  });

  it("verifies Google server configuration and persists only safe metadata", async () => {
    mockValidateGoogleAds.mockResolvedValue({
      accountLabel: "Presentail Ads (1234567890)",
      currency: "AED",
      timeZone: "Asia/Dubai",
    });
    mockDbQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{
          id: 8,
          workspace_owner_id: "owner_123",
          platform: "google_ads",
          credentials_encrypted: "marker",
          account_created_time: null,
        }],
        rowCount: 1,
      });

    const response = await request(makeApp()).post("/ad-platforms/google_ads/verify");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      verified: true,
      customerId: "1234567890",
      accountName: "Presentail Ads (1234567890)",
      currency: "AED",
      timezone: "Asia/Dubai",
    });
    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toContain("auth_mode");
    expect(sql).not.toContain("serviceAccountJson");
    expect(JSON.stringify(params)).not.toContain("redacted");
  });

  it("denies Google verification outside the configured workspace", async () => {
    process.env.GOOGLE_ADS_WORKSPACE_OWNER_ID = "another-owner";
    const response = await request(makeApp()).post("/ad-platforms/google_ads/verify");
    expect(response.status).toBe(403);
    expect(mockValidateGoogleAds).not.toHaveBeenCalled();
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("groups failures by destination and exposes only safe reasons", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 41,
            destination_country: "United Arab Emirates",
            attempt_count: 3,
            failure_reason: "google_ads_authentication",
            last_error: "invalid refresh token click-id-secret",
            failed_at: "2026-08-30T10:00:00.000Z",
          },
          {
            id: 42,
            destination_country: "AE",
            attempt_count: 10,
            failure_reason: "retry_exhausted",
            last_error: "provider payload included click-id-secret",
            failed_at: "2026-08-30T09:00:00.000Z",
          },
        ],
        rowCount: 2,
      });

    const response = await request(makeApp()).get("/ad-platforms");

    expect(response.status).toBe(200);
    expect(response.body.conversionFailures).toMatchObject({
      total: 2,
      markets: [
        {
          countryCode: "AE",
          marketName: "United Arab Emirates",
          failedCount: 2,
        },
      ],
    });
    expect(response.body.conversionFailures.markets[0].failures[0]).toEqual({
      id: 41,
      attemptCount: 3,
      failedAt: "2026-08-30T10:00:00.000Z",
      reasonCode: "google_ads_authentication",
      reason: "Google Ads rejected the connection. Reconnect Google Ads and try again.",
    });
    expect(JSON.stringify(response.body)).not.toContain("click-id-secret");
    expect(JSON.stringify(response.body)).not.toContain("refresh token");
  });

  it("requeues the existing failed row without changing its transaction key", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 41 }], rowCount: 1 });

    const response = await request(makeApp())
      .post("/ad-platforms/conversion-failures/41/retry");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ queued: true });
    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toContain("SET status = 'retry'");
    expect(sql).toContain("attempt_count = 0");
    expect(sql).not.toMatch(/transaction_id\s*=/i);
    expect(sql).not.toMatch(/INSERT/i);
    expect(params).toEqual([41, "owner_123"]);
  });

  it("keeps conversion health data owner-only", async () => {
    workspaceRole = "member";

    const response = await request(makeApp()).get("/ad-platforms");

    expect(response.status).toBe(403);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("does not reveal whether another workspace owns a failure ID", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const response = await request(makeApp())
      .post("/ad-platforms/conversion-failures/999/retry");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Conversion failure not found" });
    expect(mockDbQuery.mock.calls[0][1]).toEqual([999, "owner_123"]);
    expect(mockDbQuery.mock.calls[1][1]).toEqual([999, "owner_123"]);
  });
});