import { beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => {
  const getAccessToken = vi.fn();
  const getClient = vi.fn(() => Promise.resolve({ getAccessToken }));
  const GoogleAuth = vi.fn(function GoogleAuthMock() {
    return { getClient };
  });
  return { getAccessToken, getClient, GoogleAuth };
});

vi.mock("google-auth-library", () => ({ GoogleAuth: authMocks.GoogleAuth }));
vi.mock("./db", () => ({ db: { query: vi.fn(), connect: vi.fn() } }));
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("./credentialEncryption", () => ({
  encrypt: vi.fn((value: string) => `enc:${value}`),
  decrypt: vi.fn((value: string) => value.slice(4)),
}));

import {
  fetchGoogleAdsAnalyticsSpend,
  GoogleAdsAnalyticsError,
  normalizeCustomerId,
  resetGoogleAdsAuthCacheForTests,
  serviceAccountConfig,
  validateGoogleAdsAnalytics,
} from "./adPlatformSync";

const serviceAccount = JSON.stringify({
  type: "service_account",
  client_email: "ads-reader@example.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nmock\n-----END PRIVATE KEY-----\n",
});

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Google Ads service-account analytics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetGoogleAdsAuthCacheForTests();
    process.env.GOOGLE_ADS_SERVICE_ACCOUNT_JSON = serviceAccount;
    process.env.GOOGLE_ADS_CUSTOMER_ID = "123-456-7890";
    delete process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID;
    process.env.GOOGLE_ADS_WORKSPACE_OWNER_ID = "owner-1";
    authMocks.getAccessToken.mockResolvedValue({ token: "short-lived-token" });
  });

  it("reports missing and malformed service configuration with stable codes", async () => {
    delete process.env.GOOGLE_ADS_SERVICE_ACCOUNT_JSON;
    expect(() => serviceAccountConfig()).toThrowError(
      expect.objectContaining({ code: "missing_config" }),
    );

    process.env.GOOGLE_ADS_SERVICE_ACCOUNT_JSON = "{not-json";
    await expect(validateGoogleAdsAnalytics()).rejects.toMatchObject({
      code: "malformed_json",
    });

    process.env.GOOGLE_ADS_SERVICE_ACCOUNT_JSON = JSON.stringify({
      type: "service_account",
      client_email: "ads-reader@example.iam.gserviceaccount.com",
      private_key: "not a private key",
    });
    await expect(validateGoogleAdsAnalytics()).rejects.toMatchObject({
      code: "malformed_private_key",
    });
  });

  it("normalizes direct and manager customer IDs", () => {
    expect(normalizeCustomerId(" 123-456-7890 ")).toBe("1234567890");
    process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID = "987-654-3210";
    expect(serviceAccountConfig()).toMatchObject({
      customerId: "123-456-7890",
      loginCustomerId: "987-654-3210",
    });
    expect(() => normalizeCustomerId("not-an-id")).toThrowError(
      expect.objectContaining({ code: "invalid_customer_id" }),
    );
  });

  it("uses google-auth-library caching and sends the optional manager ID", async () => {
    process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID = "987-654-3210";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => response(200, {
        results: [{
          customer: {
            id: "1234567890",
            currencyCode: "AED",
            timeZone: "Asia/Dubai",
            descriptiveName: "Presentail",
          },
        }],
      }));

    await validateGoogleAdsAnalytics();
    await validateGoogleAdsAnalytics();

    expect(authMocks.GoogleAuth).toHaveBeenCalledTimes(1);
    expect(authMocks.getAccessToken).toHaveBeenCalledTimes(2);
    expect(authMocks.GoogleAuth).toHaveBeenCalledWith(expect.objectContaining({
      scopes: ["https://www.googleapis.com/auth/adwords"],
    }));
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/customers/1234567890/googleAds:search"),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer short-lived-token",
          "login-customer-id": "9876543210",
        }),
      }),
    );
  });

  it("rebuilds the auth client after a service-account secret rotation", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => response(200, {
      results: [{
        customer: {
          currencyCode: "AED",
          timeZone: "Asia/Dubai",
          descriptiveName: "Presentail",
        },
      }],
    }));

    await validateGoogleAdsAnalytics();
    process.env.GOOGLE_ADS_SERVICE_ACCOUNT_JSON = JSON.stringify({
      type: "service_account",
      client_email: "rotated-reader@example.iam.gserviceaccount.com",
      private_key: "-----BEGIN PRIVATE KEY-----\nrotated\n-----END PRIVATE KEY-----\n",
    });
    authMocks.getAccessToken
      .mockResolvedValueOnce({ token: "renewed-token" });
    await validateGoogleAdsAnalytics();

    expect(authMocks.GoogleAuth).toHaveBeenCalledTimes(2);
    const rotatedAuthOptions = (
      authMocks.GoogleAuth.mock.calls as unknown as Array<[{
        credentials: { client_email: string };
      }]>
    )[1][0];
    expect(rotatedAuthOptions).toEqual(expect.objectContaining({
      credentials: expect.objectContaining({
        client_email: "rotated-reader@example.iam.gserviceaccount.com",
      }),
    }));
  });

  it("classifies disabled API errors without exposing provider details", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("SERVICE_DISABLED private-key-material", { status: 403 }),
    );
    let caught: unknown;
    try {
      await validateGoogleAdsAnalytics();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GoogleAdsAnalyticsError);
    expect(caught).toMatchObject({ code: "api_disabled" });
    expect(String(caught)).not.toContain("private-key-material");
  });

  it("queries all required reporting fields and converts cost micros once", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock
      .mockResolvedValueOnce(response(200, {
        results: [{
          customer: {
            currencyCode: "USD",
            timeZone: "America/New_York",
            descriptiveName: "Presentail US",
          },
        }],
      }))
      .mockResolvedValueOnce(response(200, {
        results: [{
          campaign: { id: "42", name: "Brand", status: "ENABLED", advertisingChannelType: "SEARCH" },
          segments: { date: "2026-09-01" },
          metrics: {
            costMicros: "1234567",
            impressions: "100",
            clicks: "5",
            ctr: 0.05,
            averageCpc: "246913",
            conversions: "2",
            conversionsValue: "50",
          },
        }],
      }));

    const rows = await fetchGoogleAdsAnalyticsSpend("2026-09-01", "2026-09-01");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      spendAmount: 1.23,
      currency: "USD",
      conversions: 2,
    });
    const reportBody = JSON.parse(
      String((fetchMock.mock.calls[1][1] as RequestInit).body),
    ) as { query: string };
    expect(reportBody.query).toContain("campaign.status");
    expect(reportBody.query).toContain("campaign.advertising_channel_type");
    expect(reportBody.query).toContain("metrics.ctr");
    expect(reportBody.query).toContain("metrics.average_cpc");
    expect(reportBody.query).toContain("metrics.conversions_value");
  });
});