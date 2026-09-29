import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const mockDbQuery = vi.fn();

vi.mock("../lib/db", () => ({
  db: { query: (...args: unknown[]) => mockDbQuery(...args) },
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  authed: (req: unknown) => req,
}));

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: any, _res: unknown, next: () => void) => {
    req.workspaceOwnerId = "owner-1";
    req.userId = "user-1";
    next();
  },
  workspace: (req: any) => req,
}));

const mockGetStoredRate = vi.fn();
vi.mock("../lib/exchangeRateService", () => ({
  getStoredRate: (...args: unknown[]) => mockGetStoredRate(...args),
}));

import revenueOverviewRouter from "./revenueOverview";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    next();
  });
  app.use("/api", revenueOverviewRouter);
  return app;
}

/**
 * Route SQL is dispatched by content (not call order) so the test is robust
 * to internal parallelism. Handlers can inspect the SQL + params.
 */
type SqlHandler = (sql: string, params: unknown[]) => { rows: unknown[] } | null;

function dispatchSql(handlers: SqlHandler[]) {
  mockDbQuery.mockImplementation((sql: string, params: unknown[]) => {
    for (const h of handlers) {
      const result = h(sql, params);
      if (result) return Promise.resolve(result);
    }
    return Promise.resolve({ rows: [] });
  });
}

const inCurrentPeriod = (params: unknown[], from: string) =>
  (params[1] as Date).toISOString() >= from;

beforeEach(() => {
  mockDbQuery.mockReset();
  mockGetStoredRate.mockReset();
  mockGetStoredRate.mockResolvedValue({ rate: 1, fetched_at: new Date().toISOString() });
});

const FROM = "2026-08-01T00:00:00.000Z";
const TO = "2026-08-08T00:00:00.000Z";

describe("GET /api/revenue-overview", () => {
  it("reconciles total revenue exactly to the sum of the three streams", async () => {
    dispatchSql([
      (sql, params) =>
        sql.includes("FROM orders o") && inCurrentPeriod(params, FROM)
          ? {
              rows: [
                {
                  bucket: "2026-08-01T00:00:00.000Z",
                  orders: "3",
                  revenue: "300.50",
                  refunds: "0",
                  last_activity: "2026-08-01T10:00:00.000Z",
                },
              ],
            }
          : null,
      (sql, params) =>
        sql.includes("FROM workshop_sales") && inCurrentPeriod(params, FROM)
          ? {
              rows: [
                {
                  bucket: "2026-08-02T00:00:00.000Z",
                  currency: "USD",
                  orders: "2",
                  revenue: "120.25",
                  cogs: null,
                  costed_revenue: null,
                  last_activity: "2026-08-02T09:00:00.000Z",
                },
              ],
            }
          : null,
      (sql, params) =>
        sql.includes("FROM cmc_sales cs") && inCurrentPeriod(params, FROM)
          ? {
              rows: [
                {
                  bucket: "2026-08-03T00:00:00.000Z",
                  orders: "1",
                  revenue: "79.25",
                  refunds: "0",
                  last_activity: "2026-08-03T12:00:00.000Z",
                },
              ],
            }
          : null,
    ]);

    const res = await request(buildApp()).get(
      `/api/revenue-overview?from=${FROM}&to=${TO}`,
    );
    expect(res.status).toBe(200);

    const streams = res.body.totals.streams;
    const sum = streams.reduce((s: number, x: { revenue: number }) => s + x.revenue, 0);
    expect(res.body.totals.totalRevenue).toBeCloseTo(sum, 10);
    expect(res.body.totals.totalRevenue).toBeCloseTo(500, 5);

    const byKey = Object.fromEntries(streams.map((s: { key: string }) => [s.key, s]));
    expect(byKey.ecommerce.revenue).toBeCloseTo(300.5, 5);
    expect(byKey.retail.revenue).toBeCloseTo(120.25, 5);
    expect(byKey.cmc.revenue).toBeCloseTo(79.25, 5);
    // Shares reconcile to ~100 after rounding.
    const shareSum = streams.reduce(
      (s: number, x: { shareOfTotal: number }) => s + x.shareOfTotal,
      0,
    );
    expect(Math.abs(shareSum - 100)).toBeLessThanOrEqual(0.3);
    expect(res.body.currency).toBe("USD");
    expect(res.body.definitions).toHaveProperty("ecommerce");
  });

  it("deduplicates: excludes CMC-linked orders and mirrored cash-ledger rows", async () => {
    dispatchSql([]);
    const res = await request(buildApp()).get(
      `/api/revenue-overview?from=${FROM}&to=${TO}`,
    );
    expect(res.status).toBe(200);

    const allSql = mockDbQuery.mock.calls.map((c) => String(c[0]));
    const ordersSql = allSql.find((s) => s.includes("FROM orders o"));
    expect(ordersSql).toBeTruthy();
    // A CMC sale linked to an order is counted once (under CMC).
    expect(ordersSql).toContain("NOT EXISTS (SELECT 1 FROM cmc_sales cs WHERE cs.order_id = o.id)");

    const cashSql = allSql.find(
      (s) => s.includes("FROM cash_transactions ct") && s.includes("ct.type = 'sale'"),
    );
    expect(cashSql).toBeTruthy();
    // Workshop-sale payment mirrors and CMC sale mirrors are excluded from retail.
    expect(cashSql).toContain("'workshop_sale_payment'");
    expect(cashSql).toContain("'cmc_sale'");
    expect(cashSql).toContain("NOT IN");
  });

  it("computes comparison values and change percentages for compareMode=previous", async () => {
    dispatchSql([
      (sql, params) =>
        sql.includes("FROM orders o")
          ? {
              rows: [
                {
                  bucket: (params[1] as Date).toISOString(),
                  orders: "1",
                  revenue: inCurrentPeriod(params, FROM) ? "200" : "100",
                  refunds: "0",
                  last_activity: null,
                },
              ],
            }
          : null,
    ]);

    const res = await request(buildApp()).get(
      `/api/revenue-overview?from=${FROM}&to=${TO}&compareMode=previous`,
    );
    expect(res.status).toBe(200);
    expect(res.body.comparison).toMatchObject({ mode: "previous" });

    const ecom = res.body.totals.streams.find((s: { key: string }) => s.key === "ecommerce");
    expect(ecom.revenue).toBe(200);
    expect(ecom.comparisonRevenue).toBe(100);
    expect(ecom.changePct).toBeCloseTo(100);
    expect(res.body.totals.comparisonTotal).toBe(100);
    expect(res.body.totals.totalChangePct).toBeCloseTo(100);
  });

  it("omits comparison but still derives Channel Pulse from the previous period", async () => {
    dispatchSql([
      (sql, params) =>
        sql.includes("FROM orders o")
          ? {
              rows: [
                {
                  bucket: (params[1] as Date).toISOString(),
                  orders: "1",
                  revenue: inCurrentPeriod(params, FROM) ? "70" : "100", // -30%
                  refunds: "0",
                  last_activity: null,
                },
              ],
            }
          : null,
    ]);

    const res = await request(buildApp()).get(
      `/api/revenue-overview?from=${FROM}&to=${TO}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.comparison).toBeNull();
    const ecom = res.body.totals.streams.find((s: { key: string }) => s.key === "ecommerce");
    expect(ecom.changePct).toBeNull();

    const pulse = res.body.pulse.find((p: { stream: string }) => p.stream === "ecommerce");
    expect(pulse.status).toBe("off_track");
    expect(pulse.changePct).toBeCloseTo(-30);
    expect(pulse.reason).toContain("-30");
    expect(pulse.thresholds).toEqual({ atRiskBelowPct: -5, offTrackBelowPct: -20 });
  });

  it("selects bucket granularity from the range length", async () => {
    dispatchSql([]);
    const app = buildApp();

    const short = await request(app).get(
      "/api/revenue-overview?from=2026-08-01T00:00:00Z&to=2026-08-02T00:00:00Z",
    );
    expect(short.body.granularity).toBe("hour");

    const monthLong = await request(app).get(
      "/api/revenue-overview?from=2026-07-01T00:00:00Z&to=2026-08-01T00:00:00Z",
    );
    expect(monthLong.body.granularity).toBe("day");

    const year = await request(app).get(
      "/api/revenue-overview?from=2025-08-01T00:00:00Z&to=2026-08-01T00:00:00Z",
    );
    expect(year.body.granularity).toBe("month");
    // hour granularity is interpolated into date_trunc for the short range.
    expect(
      mockDbQuery.mock.calls.some((c) => String(c[0]).includes("date_trunc('hour'")),
    ).toBe(true);
  });

  it("flags the retail stream partial when a currency has no stored USD rate", async () => {
    mockGetStoredRate.mockImplementation(async (from: string) =>
      from === "AED" ? null : { rate: 1, fetched_at: new Date().toISOString() },
    );
    dispatchSql([
      (sql, params) =>
        sql.includes("FROM workshop_sales") && inCurrentPeriod(params, FROM)
          ? {
              rows: [
                {
                  bucket: "2026-08-02T00:00:00.000Z",
                  currency: "USD",
                  orders: "1",
                  revenue: "100",
                  cogs: null,
                  costed_revenue: null,
                  last_activity: null,
                },
                {
                  bucket: "2026-08-02T00:00:00.000Z",
                  currency: "AED",
                  orders: "1",
                  revenue: "500",
                  cogs: null,
                  costed_revenue: null,
                  last_activity: null,
                },
              ],
            }
          : null,
    ]);

    const res = await request(buildApp()).get(
      `/api/revenue-overview?from=${FROM}&to=${TO}`,
    );
    expect(res.status).toBe(200);
    const retail = res.body.totals.streams.find((s: { key: string }) => s.key === "retail");
    // Unconvertible AED row is excluded, not fabricated.
    expect(retail.revenue).toBe(100);
    const avail = res.body.availability.find((a: { stream: string }) => a.stream === "retail");
    expect(avail.partial).toBe(true);
    expect(avail.reason).toContain("AED");
  });

  it("flags retail partial when a cash refund's currency has no stored USD rate", async () => {
    mockGetStoredRate.mockImplementation(async (from: string) =>
      from === "LBP" ? null : { rate: 1, fetched_at: new Date().toISOString() },
    );
    dispatchSql([
      (sql, params) =>
        sql.includes("ct.type = 'refund'") && inCurrentPeriod(params, FROM)
          ? { rows: [{ currency: "LBP", refunds: "150000" }] }
          : null,
    ]);

    const res = await request(buildApp()).get(
      `/api/revenue-overview?from=${FROM}&to=${TO}`,
    );
    expect(res.status).toBe(200);
    const retail = res.body.totals.streams.find((s: { key: string }) => s.key === "retail");
    // Unconvertible refund is excluded, not fabricated.
    expect(retail.refunds).toBe(0);
    const avail = res.body.availability.find((a: { stream: string }) => a.stream === "retail");
    expect(avail.partial).toBe(true);
    expect(avail.reason).toContain("LBP");
  });

  it("includes LBP retail revenue using the normalized global stored rate", async () => {
    mockGetStoredRate.mockImplementation(async (from: string, to: string, owner: string) =>
      from === "LBP" && to === "USD" && owner === "__global__"
        ? { rate: 1 / 89_500, fetched_at: new Date().toISOString() }
        : null,
    );
    dispatchSql([
      (sql, params) =>
        sql.includes("FROM workshop_sales") && inCurrentPeriod(params, FROM)
          ? {
              rows: [
                {
                  bucket: "2026-08-02T00:00:00.000Z",
                  currency: "LBP",
                  orders: "1",
                  revenue: "3640000",
                  cogs: null,
                  costed_revenue: null,
                  last_activity: null,
                },
              ],
            }
          : null,
    ]);

    const res = await request(buildApp()).get(
      `/api/revenue-overview?from=${FROM}&to=${TO}`,
    );
    expect(res.status).toBe(200);
    const retail = res.body.totals.streams.find((s: { key: string }) => s.key === "retail");
    expect(retail.revenue).toBeCloseTo(3_640_000 / 89_500, 2);
    expect(res.body.totals.totalRevenue).toBeCloseTo(3_640_000 / 89_500, 2);
    const availability = res.body.availability.find(
      (a: { stream: string }) => a.stream === "retail",
    );
    expect(availability.partial).toBe(false);
    expect(mockGetStoredRate).toHaveBeenCalledWith("LBP", "USD", "__global__");
  });

  it("excludes LBP retail revenue when lookup returns an implausibly directed rate", async () => {
    mockGetStoredRate.mockResolvedValue({
      rate: 89_500,
      fetched_at: new Date().toISOString(),
    });
    dispatchSql([
      (sql, params) =>
        sql.includes("FROM workshop_sales") && inCurrentPeriod(params, FROM)
          ? {
              rows: [
                {
                  bucket: "2026-08-02T00:00:00.000Z",
                  currency: "LBP",
                  orders: "1",
                  revenue: "3640000",
                  cogs: null,
                  costed_revenue: null,
                  last_activity: null,
                },
              ],
            }
          : null,
    ]);

    const res = await request(buildApp()).get(
      `/api/revenue-overview?from=${FROM}&to=${TO}`,
    );
    expect(res.status).toBe(200);
    const retail = res.body.totals.streams.find((s: { key: string }) => s.key === "retail");
    expect(retail.revenue).toBe(0);
    expect(res.body.totals.totalRevenue).toBe(0);
    const availability = res.body.availability.find(
      (a: { stream: string }) => a.stream === "retail",
    );
    expect(availability.partial).toBe(true);
    expect(availability.reason).toContain("LBP");
  });

  it("marks a stream unavailable (not fatal) when its source query fails", async () => {
    mockDbQuery.mockImplementation((sql: string) => {
      // Match only the CMC stream query (the orders query embeds a
      // cmc_sales NOT EXISTS subquery for dedup and must keep working).
      if (String(sql).includes("FROM cmc_sales cs") && !String(sql).includes("FROM orders o")) {
        return Promise.reject(new Error("relation missing"));
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await request(buildApp()).get(
      `/api/revenue-overview?from=${FROM}&to=${TO}`,
    );
    expect(res.status).toBe(200);
    const cmc = res.body.availability.find((a: { stream: string }) => a.stream === "cmc");
    expect(cmc.available).toBe(false);
    expect(cmc.reason).toContain("CMC");
    const ecom = res.body.availability.find((a: { stream: string }) => a.stream === "ecommerce");
    expect(ecom.available).toBe(true);
  });

  it("includes Toters as a fourth stream without changing the others", async () => {
    dispatchSql([
      (sql, params) =>
        sql.includes("FROM orders o") && inCurrentPeriod(params, FROM)
          ? {
              rows: [
                {
                  bucket: "2026-08-01T00:00:00.000Z",
                  orders: "3",
                  revenue: "300.50",
                  refunds: "0",
                  last_activity: null,
                },
              ],
            }
          : null,
      (sql, params) =>
        sql.includes("FROM toters_orders t") &&
        !sql.includes("t.store AS store") &&
        inCurrentPeriod(params, FROM)
          ? {
              rows: [
                {
                  bucket: "2026-08-02T00:00:00.000Z",
                  orders: "2",
                  // Unrounded stored values: 70.23411371 + 1.67224080
                  revenue: "71.90635451",
                  last_activity: "2026-08-02T09:00:00.000Z",
                },
              ],
            }
          : null,
      (sql, params) =>
        sql.includes("t.store AS store") && inCurrentPeriod(params, FROM)
          ? {
              rows: [
                { store: "Presentail Achrafieh", orders: "1", revenue: "70.23411371" },
                { store: "Presentail Hamra", orders: "1", revenue: "1.67224080" },
              ],
            }
          : null,
    ]);

    const res = await request(buildApp()).get(
      `/api/revenue-overview?from=${FROM}&to=${TO}`,
    );
    expect(res.status).toBe(200);

    const byKey = Object.fromEntries(
      res.body.totals.streams.map((s: { key: string }) => [s.key, s]),
    );
    // Toters aggregate: sum unrounded, round once for display.
    expect(byKey.toters.revenue).toBe(71.91);
    expect(byKey.toters.orders).toBe(2);
    // Existing streams unchanged.
    expect(byKey.ecommerce.revenue).toBeCloseTo(300.5, 5);
    // Total = E-Commerce + Retail + CMC + Toters.
    expect(res.body.totals.totalRevenue).toBeCloseTo(300.5 + 71.91, 2);

    // Toters appears in series, pulse, and availability.
    expect(res.body.series.some((p: { toters: number | null }) => p.toters === 71.91)).toBe(true);
    expect(res.body.pulse.some((p: { stream: string }) => p.stream === "toters")).toBe(true);
    const avail = res.body.availability.find((a: { stream: string }) => a.stream === "toters");
    expect(avail).toMatchObject({ available: true, label: "Toters" });

    // Revenue by Toters store breakdown.
    expect(res.body.totersByStore).toEqual([
      { store: "Presentail Achrafieh", revenue: 70.23, orders: 1 },
      { store: "Presentail Hamra", revenue: 1.67, orders: 1 },
    ]);

    // Toters is only queried with arrived status and the stored revenue column.
    const totersSql = mockDbQuery.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes("FROM toters_orders t") && !s.includes("t.store AS store"));
    expect(totersSql).toContain("t.status = 'arrived'");
    expect(totersSql).toContain("calculated_revenue");
    expect(res.body.definitions).toHaveProperty("toters");
  });

  it("aggregates series with gaps preserved (missing buckets are null)", async () => {
    dispatchSql([
      (sql, params) =>
        sql.includes("FROM orders o") && inCurrentPeriod(params, FROM)
          ? {
              rows: [
                {
                  bucket: "2026-08-01T00:00:00.000Z",
                  orders: "1",
                  revenue: "100",
                  refunds: "0",
                  last_activity: null,
                },
                {
                  bucket: "2026-08-03T00:00:00.000Z",
                  orders: "1",
                  revenue: "60",
                  refunds: "0",
                  last_activity: null,
                },
              ],
            }
          : null,
    ]);

    const res = await request(buildApp()).get(
      `/api/revenue-overview?from=${FROM}&to=${TO}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.series).toHaveLength(7);
    const day2 = res.body.series[1];
    expect(day2.ecommerce).toBeNull();
    expect(day2.total).toBe(0);
    expect(res.body.series[0].ecommerce).toBe(100);
    expect(res.body.series[2].ecommerce).toBe(60);
  });
});
