/**
 * Unit tests for getMerchantConfigStatus — the non-throwing configuration
 * check surfaced by the merchant-sync-status endpoint so the dashboard can
 * report missing/invalid Merchant Center configuration explicitly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./googleMerchantAuth", () => ({
  getMerchantAccessToken: vi.fn().mockResolvedValue("test-token"),
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  buildInsertBody,
  deleteProductInput,
  getMerchantAccountConfig,
  getMerchantConfigStatus,
  insertProductInput,
  insertProductInputForConfig,
  verifyMerchantAccountAccessForConfig,
} from "./merchantCenterClient";

const ORIGINAL_ENV = process.env;

const merchantInput = {
  offerId: "SKU1-LB",
  contentLanguage: "en",
  feedLabel: "LB",
  productAttributes: {
    title: "Test Product",
    description: "A product",
    link: "https://presentail.com/en-lb/beirut/product/test",
    imageLink: "https://example.com/img.jpg",
    additionalImageLinks: ["https://example.com/alt.jpg"],
    availability: "IN_STOCK",
    condition: "NEW" as const,
    price: { amount: 10, amountMicros: "10000000", currencyCode: "USD" },
    identifierExists: false as const,
    brand: "Presentail",
    googleProductCategory: "Flowers",
  },
};

describe("getMerchantConfigStatus", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.GOOGLE_MERCHANT_ACCOUNT_ID;
    delete process.env.GOOGLE_MERCHANT_DATA_SOURCE_ID;
    delete process.env.GOOGLE_MERCHANT_DATA_SOURCE_NAME;
    delete process.env.GOOGLE_MERCHANT_AE_ACCOUNT_ID;
    delete process.env.GOOGLE_MERCHANT_AE_DATA_SOURCE_ID;
    delete process.env.GOOGLE_MERCHANT_AE_DATA_SOURCE_NAME;
    delete process.env.GOOGLE_MERCHANT_LB_ACCOUNT_ID;
    delete process.env.GOOGLE_MERCHANT_LB_DATA_SOURCE_ID;
    delete process.env.GOOGLE_MERCHANT_LB_DATA_SOURCE_NAME;
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.unstubAllGlobals();
  });

  function setMarketConfig(country: "AE" | "LB", accountId: string, dataSourceId: string): void {
    process.env[`GOOGLE_MERCHANT_${country}_ACCOUNT_ID`] = accountId;
    process.env[`GOOGLE_MERCHANT_${country}_DATA_SOURCE_ID`] = dataSourceId;
    process.env[`GOOGLE_MERCHANT_${country}_DATA_SOURCE_NAME`] = `accounts/${accountId}/dataSources/${dataSourceId}`;
  }

  it("requires explicit configuration for both markets", () => {
    const status = getMerchantConfigStatus();
    expect(status.ok).toBe(false);
    expect(status.problems).toHaveLength(2);
    expect(status.problems[0]).toContain("AE");
    expect(status.markets?.AE.ok).toBe(false);
    expect(status.markets?.LB.ok).toBe(false);
  });

  it("is ok only when all six per-country values are valid", () => {
    setMarketConfig("AE", "5689332635", "10717818297");
    setMarketConfig("LB", "5844806121", "10717818285");
    expect(getMerchantConfigStatus()).toMatchObject({ ok: true, problems: [] });
  });

  it("does not use the legacy generic destination as a fallback", () => {
    process.env.GOOGLE_MERCHANT_ACCOUNT_ID = "5689332635";
    process.env.GOOGLE_MERCHANT_DATA_SOURCE_ID = "10702284911";
    process.env.GOOGLE_MERCHANT_DATA_SOURCE_NAME = "accounts/5689332635/dataSources/10702284911";

    const status = getMerchantConfigStatus();
    expect(status.ok).toBe(false);
    expect(status.markets?.AE.ok).toBe(false);
    expect(status.markets?.LB.ok).toBe(false);
  });

  it("reports a problem when a per-country data-source resource name is malformed", () => {
    setMarketConfig("LB", "5844806121", "10717818285");
    process.env.GOOGLE_MERCHANT_LB_DATA_SOURCE_NAME = "accounts/5844806121/dataSources/not-a-number";
    const status = getMerchantConfigStatus();
    expect(status.ok).toBe(false);
    expect(status.markets?.LB.problems[0]).toContain("numeric ID");
  });

  it("requires the explicit data-source name even when account and ID are set", () => {
    process.env.GOOGLE_MERCHANT_LB_ACCOUNT_ID = "5844806121";
    process.env.GOOGLE_MERCHANT_LB_DATA_SOURCE_ID = "10717818285";
    const status = getMerchantConfigStatus();
    expect(status.ok).toBe(false);
    expect(status.markets?.LB.problems[0]).toContain("GOOGLE_MERCHANT_LB_DATA_SOURCE_NAME");
  });

  it("resolves each market only to its explicit destination", () => {
    setMarketConfig("AE", "5689332635", "10717818297");
    setMarketConfig("LB", "5844806121", "10717818285");
    expect(getMerchantAccountConfig("AE")).toEqual({
      country: "AE",
      accountId: "5689332635",
      dataSourceId: "10717818297",
      dataSourceName: "accounts/5689332635/dataSources/10717818297",
    });
    expect(getMerchantAccountConfig("LB")).toEqual({
      country: "LB",
      accountId: "5844806121",
      dataSourceId: "10717818285",
      dataSourceName: "accounts/5844806121/dataSources/10717818285",
    });
  });
});

describe("ProductInput request body", () => {
  it("serializes the mapped product fields under productAttributes", () => {
    const body = buildInsertBody(merchantInput);

    expect(body).toEqual({
      offerId: "SKU1-LB",
      contentLanguage: "en",
      feedLabel: "LB",
      productAttributes: {
        title: "Test Product",
        description: "A product",
        link: "https://presentail.com/en-lb/beirut/product/test",
        imageLink: "https://example.com/img.jpg",
        additionalImageLinks: ["https://example.com/alt.jpg"],
        availability: "IN_STOCK",
        condition: "NEW",
        price: { amountMicros: "10000000", currencyCode: "USD" },
        identifierExists: false,
        brand: "Presentail",
        googleProductCategory: "Flowers",
      },
    });
    expect(body).not.toHaveProperty("attributes");
  });

  it("sends the same canonical body returned by buildInsertBody", async () => {
    process.env.GOOGLE_MERCHANT_ACCOUNT_ID = "5689332635";
    process.env.GOOGLE_MERCHANT_DATA_SOURCE_ID = "123456";
    const responseText = JSON.stringify({ name: "accounts/5689332635/productInputs/test" });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: vi.fn().mockResolvedValue(responseText),
    });
    vi.stubGlobal("fetch", fetchMock);

    await insertProductInput(merchantInput);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://merchantapi.googleapis.com/products/v1/accounts/5689332635/productInputs:insert?dataSource=accounts/5689332635/dataSources/123456",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(buildInsertBody(merchantInput)),
      }),
    );
    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body as string) as Record<string, unknown>;
    expect(sentBody).not.toHaveProperty("attributes");
    expect(sentBody.productAttributes).toEqual(buildInsertBody(merchantInput).productAttributes);
  });

  it("routes an explicit Lebanon offer only to its account and data source", async () => {
    process.env.GOOGLE_MERCHANT_LB_ACCOUNT_ID = "5844806121";
    process.env.GOOGLE_MERCHANT_LB_DATA_SOURCE_ID = "10717818285";
    process.env.GOOGLE_MERCHANT_LB_DATA_SOURCE_NAME = "accounts/5844806121/dataSources/10717818285";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: vi.fn().mockResolvedValue("{}"),
    });
    vi.stubGlobal("fetch", fetchMock);

    await insertProductInputForConfig(getMerchantAccountConfig("LB"), merchantInput);

    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://merchantapi.googleapis.com/products/v1/accounts/5844806121/productInputs:insert?dataSource=accounts%2F5844806121%2FdataSources%2F10717818285",
    );
  });
});

describe("market account access", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("accepts inherited access when the exact account and data source are readable", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        name: "readable-resource",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(verifyMerchantAccountAccessForConfig({
      country: "LB",
      accountId: "5844806121",
      dataSourceId: "10717818285",
      dataSourceName: "accounts/5844806121/dataSources/10717818285",
    })).resolves.toMatchObject({ ok: true });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://merchantapi.googleapis.com/accounts/v1/accounts/5844806121",
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://merchantapi.googleapis.com/datasources/v1/accounts/5844806121/dataSources/10717818285",
      expect.any(Object),
    );
  });

  it("rejects access when the exact configured data source is unreadable", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ name: "accounts/5844806121" }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: vi.fn().mockResolvedValue({ error: { status: "PERMISSION_DENIED" } }),
      });
    vi.stubGlobal("fetch", fetchMock);

    await expect(verifyMerchantAccountAccessForConfig({
      country: "LB",
      accountId: "5844806121",
      dataSourceId: "10717818285",
      dataSourceName: "accounts/5844806121/dataSources/10717818285",
    })).resolves.toMatchObject({ ok: false });
  });
});

describe("deleteProductInput", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    process.env.GOOGLE_MERCHANT_ACCOUNT_ID = "5689332635";
    process.env.GOOGLE_MERCHANT_DATA_SOURCE_ID = "123456";
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.unstubAllGlobals();
  });

  it("deletes the productInputs resource corresponding to a stored products name", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: vi.fn().mockResolvedValue(""),
    });
    vi.stubGlobal("fetch", fetchMock);

    await deleteProductInput("accounts/5689332635/products/online~en~LB~SKU1-LB");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://merchantapi.googleapis.com/products/v1/accounts/5689332635/productInputs/online~en~LB~SKU1-LB?dataSource=accounts/5689332635/dataSources/123456",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("includes the HTTP status without exposing credentials when deletion fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: vi.fn().mockResolvedValue('{"error":"unavailable"}'),
    }));

    await expect(
      deleteProductInput("accounts/5689332635/productInputs/online~en~LB~SKU1-LB"),
    ).rejects.toThrow("deleteProductInput HTTP 503");
  });
});
