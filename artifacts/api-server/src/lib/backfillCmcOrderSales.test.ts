import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDbQuery = vi.fn();
vi.mock("./db", () => ({
  db: { query: (...args: unknown[]) => mockDbQuery(...args) },
}));

const mockLoggerInfo = vi.fn();
vi.mock("./logger", () => ({
  logger: { info: (...args: unknown[]) => mockLoggerInfo(...args), warn: vi.fn(), error: vi.fn() },
}));

import { backfillCmcOrderSales } from "./backfillCmcOrderSales";

beforeEach(() => {
  vi.clearAllMocks();
  mockDbQuery.mockResolvedValue({ rowCount: 0, rows: [] });
});

describe("backfillCmcOrderSales", () => {
  it("repairs the mis-sourced M-1063 order, narrowly keyed and idempotently", async () => {
    await backfillCmcOrderSales();
    const repair = String(mockDbQuery.mock.calls[0][0]);
    expect(repair).toMatch(/UPDATE orders/i);
    expect(repair).toContain("SET source = 'cmc-pos'");
    // Narrow key: exact workspace + number + creation date + current source,
    // so re-running (or another workspace's M-1063) can never be touched.
    expect(repair).toContain("display_order_number = 'M-1063'");
    expect(repair).toContain("source = 'manual'");
    expect(repair).toContain("DATE '2026-08-13'");
    expect(repair).toContain("workspace_owner_id = 'user_3DCcbYtdoRYrTOqHwKxb1gwXxJR'");
    expect(repair).toContain(`'{created_via}', '"cmc_new_order"'`);
  });

  it("inserts missing cmc_sales rows only for cmc-pos orders without one", async () => {
    await backfillCmcOrderSales();
    const insert = String(mockDbQuery.mock.calls[1][0]);
    expect(insert).toMatch(/INSERT INTO cmc_sales/i);
    expect(insert).toContain("'order'");
    expect(insert).toContain("'cmc-pos'");
    // Sale is dated by the order's CREATION day, never the delivery window.
    expect(insert).toContain("(o.created_at)::date");
    expect(insert).not.toMatch(/window_start/i);
    // Idempotency: NOT EXISTS guard + unique-index conflict backstop.
    expect(insert).toMatch(/NOT EXISTS \(SELECT 1 FROM cmc_sales s WHERE s\.order_id = o\.id\)/);
    expect(insert).toMatch(/ON CONFLICT \(order_id\) WHERE order_id IS NOT NULL DO NOTHING/);
    // Only cmc-pos-sourced orders are eligible.
    expect(insert).toContain("o.source = 'cmc-pos'");
  });

  it("runs the source repair BEFORE the insert so M-1063 is picked up in one pass", async () => {
    await backfillCmcOrderSales();
    expect(mockDbQuery.mock.calls.length).toBe(2);
    expect(String(mockDbQuery.mock.calls[0][0])).toMatch(/UPDATE orders/i);
    expect(String(mockDbQuery.mock.calls[1][0])).toMatch(/INSERT INTO cmc_sales/i);
  });

  it("logs counts when rows were repaired or inserted", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 3, rows: [] });
    await backfillCmcOrderSales();
    expect(mockLoggerInfo).toHaveBeenCalledTimes(2);
  });
});
