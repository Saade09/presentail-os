import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDbQuery, mockDecrypt } = vi.hoisted(() => ({
  mockDbQuery: vi.fn(),
  mockDecrypt: vi.fn(),
}));

vi.mock("./db", () => ({ db: { query: mockDbQuery } }));
vi.mock("./logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("./adPlatformSync", () => ({
  decryptCredentials: mockDecrypt,
}));

import {
  normalizeConversionFailureCode,
  parseGoogleAdsConversionMarkets,
  processPaymentLinkConversions,
  normalizeDestinationCountry,
  safeConversionFailureReason,
  uploadPaymentLinkConversion,
} from "./paymentLinkConversions";

const creds = {
  developerToken: "developer",
  clientId: "client",
  clientSecret: "secret",
  refreshToken: "refresh",
  customerId: "123-456-7890",
};

const job = {
  id: 7,
  workspace_owner_id: "owner",
  transaction_id: "payment-link:42",
  destination_country: "United Arab Emirates",
  click_id_type: "gclid" as const,
  click_id: "click-123",
  conversion_value: "25.00",
  currency: "AED",
  conversion_time: "2026-08-30T10:15:00.000Z",
};

describe("payment-link Google Ads conversions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
  });

  it("parses only explicit country-specific Ads destinations", () => {
    expect(parseGoogleAdsConversionMarkets(JSON.stringify({
      AE: { customerId: "123-456-7890", conversionActionId: "987" },
      default: { customerId: "111", conversionActionId: "222" },
    }))).toEqual({
      AE: { customerId: "1234567890", conversionActionId: "987" },
    });
  });

  it("normalizes stored country names and ISO codes for destination routing", () => {
    expect(normalizeDestinationCountry("United Arab Emirates")).toBe("AE");
    expect(normalizeDestinationCountry("lb")).toBe("LB");
    expect(normalizeDestinationCountry("Unknown market")).toBeNull();
  });

  it("maps internal failures to safe owner-visible reasons", () => {
    const code = normalizeConversionFailureCode(
      null,
      "No Google Ads conversion market configured for destination click-id-secret",
    );
    expect(code).toBe("destination_not_configured");
    expect(safeConversionFailureReason(code)).toBe(
      "No Google Ads conversion market is configured for this destination.",
    );
    expect(safeConversionFailureReason(code)).not.toContain("click-id-secret");
  });

  it("uploads value, currency, time, click id, and durable order id", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "access" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [{}] })));

    await uploadPaymentLinkConversion(
      job,
      { customerId: "1234567890", conversionActionId: "987" },
      creds,
    );

    const [, request] = vi.mocked(fetch).mock.calls[1];
    const body = JSON.parse(String(request?.body));
    expect(body.conversions[0]).toMatchObject({
      conversionAction: "customers/1234567890/conversionActions/987",
      conversionDateTime: "2026-08-30 10:15:00+00:00",
      conversionValue: 25,
      currencyCode: "AED",
      orderId: "payment-link:42",
      gclid: "click-123",
    });
  });

  it("uses the destination customer even when the connected account defaults elsewhere", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "access" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [{}] })));

    await uploadPaymentLinkConversion(
      job,
      { customerId: "9998887776", conversionActionId: "555" },
      creds,
    );

    expect(vi.mocked(fetch).mock.calls[1][0]).toBe(
      "https://googleads.googleapis.com/v21/customers/9998887776/conversionUploads:uploadClickConversions",
    );
  });

  it("retries transient upload failures without creating a second job", async () => {
    vi.stubEnv("GOOGLE_ADS_CONVERSION_MARKETS", JSON.stringify({
      AE: { customerId: "1234567890", conversionActionId: "987" },
    }));
    mockDbQuery
      .mockResolvedValueOnce({ rows: [job], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ credentials_encrypted: "encrypted" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    mockDecrypt.mockReturnValue(creds);
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "temporarily unavailable" }), { status: 503 }),
    );

    await processPaymentLinkConversions();

    expect(mockDbQuery.mock.calls[0][0]).toContain(
      "apc.auth_mode = 'service_account'",
    );
    const retry = mockDbQuery.mock.calls[2];
    expect(retry[0]).toContain("status = CASE");
    expect(retry[1]).toEqual([7, expect.any(String), true, "google_ads_authentication"]);
    expect(mockDbQuery).toHaveBeenCalledTimes(3);
  });

  it("retries transient partial failures returned with HTTP 200", async () => {
    vi.stubEnv("GOOGLE_ADS_CONVERSION_MARKETS", JSON.stringify({
      AE: { customerId: "1234567890", conversionActionId: "987" },
    }));
    mockDbQuery
      .mockResolvedValueOnce({ rows: [job], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ credentials_encrypted: "encrypted" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    mockDecrypt.mockReturnValue(creds);
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "access" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        partialFailureError: {
          code: 14,
          status: "UNAVAILABLE",
          message: "service temporarily unavailable",
        },
      })));

    await processPaymentLinkConversions();

    expect(mockDbQuery.mock.calls[2][1]).toEqual([
      7,
      expect.any(String),
      true,
      "google_ads_rejected",
    ]);
  });

  it("stores a stable reason code when destination configuration is missing", async () => {
    vi.stubEnv("GOOGLE_ADS_CONVERSION_MARKETS", "{}");
    mockDbQuery
      .mockResolvedValueOnce({ rows: [job], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await processPaymentLinkConversions();

    expect(mockDbQuery.mock.calls[1][1]).toEqual([
      7,
      "No Google Ads conversion market configured for destination",
      false,
      "destination_not_configured",
    ]);
  });

  it("uploads a manually requeued row with its unchanged durable order ID", async () => {
    vi.stubEnv("GOOGLE_ADS_CONVERSION_MARKETS", JSON.stringify({
      AE: { customerId: "123-456-7890", conversionActionId: "987" },
    }));
    mockDbQuery
      .mockResolvedValueOnce({ rows: [job], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ credentials_encrypted: "encrypted" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    mockDecrypt.mockReturnValue(creds);
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "access" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ results: [{}] })));

    await processPaymentLinkConversions();

    const uploadBody = JSON.parse(
      String((vi.mocked(fetch).mock.calls[1][1] as RequestInit).body),
    );
    expect(uploadBody.conversions[0].orderId).toBe(job.transaction_id);
    expect(mockDbQuery.mock.calls[2][0]).toContain("status = 'uploaded'");
    expect(mockDbQuery.mock.calls[2][1]).toEqual([job.id]);
  });
});