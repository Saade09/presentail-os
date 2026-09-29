import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDbQuery = vi.fn();

vi.mock("./db", () => ({
  db: { query: (...args: unknown[]) => mockDbQuery(...args) },
}));

import { fetchAndStoreExchangeRates, getStoredRate } from "./exchangeRateService";

describe("exchangeRateService", () => {
  beforeEach(() => {
    mockDbQuery.mockReset();
  });

  it("converts an inverse manual USD/LBP row into LBP per USD for a direct lookup", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          rate: String(1 / 89_500),
          fetched_at: "2026-08-26T00:00:00.000Z",
          provider: "manual",
        },
      ],
    });

    await expect(getStoredRate("USD", "LBP", "__global__")).resolves.toEqual({
      rate: 89_500,
      fetched_at: "2026-08-26T00:00:00.000Z",
    });
  });

  it("uses the inverse manual USD/LBP row as USD per LBP for an inverse lookup", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            rate: String(1 / 89_500),
            fetched_at: "2026-08-26T00:00:00.000Z",
            provider: "manual",
          },
        ],
      });

    const result = await getStoredRate("LBP", "USD", "__global__");
    expect(result?.rate).toBeCloseTo(1 / 89_500, 12);
  });

  it("skips a malformed direct LBP/USD row when a valid canonical inverse row exists", async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [
          {
            rate: "89500",
            fetched_at: "2026-08-25T00:00:00.000Z",
            provider: "exchangerate-api.com",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            rate: String(1 / 89_500),
            fetched_at: "2026-08-26T00:00:00.000Z",
            provider: "manual",
          },
        ],
      });

    await expect(getStoredRate("LBP", "USD", "__global__")).resolves.toEqual({
      rate: 1 / 89_500,
      fetched_at: "2026-08-26T00:00:00.000Z",
    });
  });

  it("returns unavailable instead of exposing an implausibly directed LBP/USD rate", async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [
          {
            rate: "89500",
            fetched_at: "2026-08-25T00:00:00.000Z",
            provider: "exchangerate-api.com",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(getStoredRate("LBP", "USD", "__global__")).resolves.toBeNull();
  });

  it("does not overwrite manual rows during a provider refresh", async () => {
    const originalFetch = globalThis.fetch;
    const originalApiKey = process.env.EXCHANGE_RATE_API_KEY;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ conversion_rates: { LBP: 89_500 } }),
    }) as typeof fetch;
    process.env.EXCHANGE_RATE_API_KEY = "test-key";

    mockDbQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    try {
      await fetchAndStoreExchangeRates("__global__", "USD");
    } finally {
      globalThis.fetch = originalFetch;
      if (originalApiKey === undefined) {
        delete process.env.EXCHANGE_RATE_API_KEY;
      } else {
        process.env.EXCHANGE_RATE_API_KEY = originalApiKey;
      }
    }

    const upsertSql = String(mockDbQuery.mock.calls[1]?.[0]);
    expect(upsertSql).toContain("WHERE exchange_rates.provider != 'manual'");
  });
});