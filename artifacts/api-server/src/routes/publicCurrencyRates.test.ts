import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

const mockDbQuery = vi.fn();

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
  },
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import publicCurrencyRatesRouter from "./publicCurrencyRates";

// ---------------------------------------------------------------------------
// Test app
// ---------------------------------------------------------------------------

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (
      req as unknown as {
        log: { error: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; info: (...a: unknown[]) => void };
      }
    ).log = { error: () => {}, warn: () => {}, info: () => {} };
    next();
  });
  app.use(publicCurrencyRatesRouter);
  return app;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * DB call order in the route:
 *   1. workspace_members  — owner existence check
 *   2. exchange_rate_settings — workspace currency settings
 *   3. exchange_rates — stored rates for the base currency
 */
function setupSuccessMocks({
  settings = {
    base_currency: "USD",
    default_markup_percentage: "5.00",
    rounding_rule: "round_up_whole",
    updated_at: "2024-01-15T10:00:00.000Z",
  },
  rates = [
    { target_currency: "AED", rate: "3.67", fetched_at: "2024-01-15T10:00:00.000Z" },
    { target_currency: "EUR", rate: "0.92", fetched_at: "2024-01-15T10:00:00.000Z" },
  ],
}: {
  settings?: {
    base_currency: string;
    default_markup_percentage: string;
    rounding_rule: string;
    updated_at: string | null;
  } | null;
  rates?: Array<{ target_currency: string; rate: string; fetched_at: string }>;
} = {}) {
  mockDbQuery
    .mockResolvedValueOnce({ rows: [{ user_id: "owner_1" }], rowCount: 1 })
    .mockResolvedValueOnce({
      rows: settings ? [settings] : [],
      rowCount: settings ? 1 : 0,
    })
    .mockResolvedValueOnce({ rows: rates, rowCount: rates.length });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe("GET /public/currency-rates", () => {
  describe("400 — missing workspace param", () => {
    it("returns 400 when the workspace query param is absent", async () => {
      const res = await request(makeApp()).get("/public/currency-rates");
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/workspace/i);
    });

    it("returns 400 when workspace is an empty string", async () => {
      const res = await request(makeApp()).get("/public/currency-rates?workspace=");
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/workspace/i);
    });

    it("returns 400 when workspace is only whitespace", async () => {
      const res = await request(makeApp()).get("/public/currency-rates?workspace=%20%20");
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/workspace/i);
    });

    it("does not query the database when workspace param is missing", async () => {
      await request(makeApp()).get("/public/currency-rates");
      expect(mockDbQuery).not.toHaveBeenCalled();
    });
  });

  describe("404 — workspace owner not found", () => {
    it("returns 404 when no owner row exists for the given workspace param", async () => {
      mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const res = await request(makeApp()).get("/public/currency-rates?workspace=unknown_owner");
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/workspace not found/i);
    });

    it("queries workspace_members with the provided workspace param", async () => {
      mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await request(makeApp()).get("/public/currency-rates?workspace=owner_42");

      const [sql, params] = mockDbQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/workspace_members/i);
      expect(params).toContain("owner_42");
    });
  });

  describe("503 — no exchange rates stored", () => {
    it("returns 503 when exchange rates table is empty for the workspace base currency", async () => {
      mockDbQuery
        .mockResolvedValueOnce({ rows: [{ user_id: "owner_1" }], rowCount: 1 })
        .mockResolvedValueOnce({
          rows: [
            {
              base_currency: "USD",
              default_markup_percentage: "0.00",
              rounding_rule: "round_up_whole",
              updated_at: null,
            },
          ],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const res = await request(makeApp()).get("/public/currency-rates?workspace=owner_1");
      expect(res.status).toBe(503);
      expect(res.body.error).toMatch(/exchange rates/i);
    });

    it("returns 503 when no settings row exists and the global rates table is also empty", async () => {
      mockDbQuery
        .mockResolvedValueOnce({ rows: [{ user_id: "owner_1" }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const res = await request(makeApp()).get("/public/currency-rates?workspace=owner_1");
      expect(res.status).toBe(503);
    });
  });

  describe("200 — success", () => {
    it("returns 200 with the correct top-level shape", async () => {
      setupSuccessMocks();

      const res = await request(makeApp()).get("/public/currency-rates?workspace=owner_1");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        base_currency: expect.any(String),
        default_markup_percentage: expect.any(Number),
        rounding_rule: expect.any(String),
        last_updated_at: expect.any(String),
        available_currencies: expect.any(Array),
        rates: expect.any(Array),
      });
    });

    it("returns the correct base_currency from settings", async () => {
      setupSuccessMocks({ settings: { base_currency: "AED", default_markup_percentage: "3.00", rounding_rule: "none", updated_at: "2024-01-15T10:00:00.000Z" } });

      const res = await request(makeApp()).get("/public/currency-rates?workspace=owner_1");
      expect(res.status).toBe(200);
      expect(res.body.base_currency).toBe("AED");
    });

    it("returns default_markup_percentage as a number", async () => {
      setupSuccessMocks();

      const res = await request(makeApp()).get("/public/currency-rates?workspace=owner_1");
      expect(res.status).toBe(200);
      expect(res.body.default_markup_percentage).toBe(5);
    });

    it("returns rounding_rule from settings", async () => {
      setupSuccessMocks();

      const res = await request(makeApp()).get("/public/currency-rates?workspace=owner_1");
      expect(res.status).toBe(200);
      expect(res.body.rounding_rule).toBe("round_up_whole");
    });

    it("returns available_currencies listing each target currency", async () => {
      setupSuccessMocks();

      const res = await request(makeApp()).get("/public/currency-rates?workspace=owner_1");
      expect(res.status).toBe(200);
      expect(res.body.available_currencies).toEqual(["AED", "EUR"]);
    });

    it("returns each rate entry with currency, rate (number), and fetched_at", async () => {
      setupSuccessMocks();

      const res = await request(makeApp()).get("/public/currency-rates?workspace=owner_1");
      expect(res.status).toBe(200);
      expect(res.body.rates).toHaveLength(2);
      expect(res.body.rates[0]).toMatchObject({
        currency: "AED",
        rate: 3.67,
        fetched_at: expect.any(String),
      });
      expect(res.body.rates[1]).toMatchObject({
        currency: "EUR",
        rate: 0.92,
        fetched_at: expect.any(String),
      });
    });

    it("uses USD as the default base_currency when no settings row exists", async () => {
      mockDbQuery
        .mockResolvedValueOnce({ rows: [{ user_id: "owner_1" }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({
          rows: [{ target_currency: "AED", rate: "3.67", fetched_at: "2024-01-15T10:00:00.000Z" }],
          rowCount: 1,
        });

      const res = await request(makeApp()).get("/public/currency-rates?workspace=owner_1");
      expect(res.status).toBe(200);
      expect(res.body.base_currency).toBe("USD");
      expect(res.body.default_markup_percentage).toBe(0);
      expect(res.body.rounding_rule).toBe("round_up_whole");
    });

    it("queries exchange_rates with the correct base_currency from settings", async () => {
      setupSuccessMocks({
        settings: {
          base_currency: "EUR",
          default_markup_percentage: "2.50",
          rounding_rule: "round_nearest_whole",
          updated_at: "2024-01-15T10:00:00.000Z",
        },
      });

      await request(makeApp()).get("/public/currency-rates?workspace=owner_1");

      const ratesQueryCall = mockDbQuery.mock.calls.find(
        ([sql]: [string]) => typeof sql === "string" && sql.includes("exchange_rates"),
      );
      expect(ratesQueryCall).toBeDefined();
      expect(ratesQueryCall?.[1]).toContain("EUR");
    });

    it("sets last_updated_at from the first rate row's fetched_at", async () => {
      const fetchedAt = "2024-03-20T08:30:00.000Z";
      setupSuccessMocks({
        rates: [
          { target_currency: "AED", rate: "3.67", fetched_at: fetchedAt },
        ],
      });

      const res = await request(makeApp()).get("/public/currency-rates?workspace=owner_1");
      expect(res.status).toBe(200);
      expect(res.body.last_updated_at).toBe(fetchedAt);
    });
  });
});
