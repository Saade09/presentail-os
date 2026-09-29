import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/db", () => ({ db: { query: vi.fn() } }));

import { db } from "../lib/db";
import { computeKpis } from "./storeAnalytics.js";

const mockedQuery = vi.mocked(db.query);

const range = {
  from: new Date("2026-07-01T00:00:00Z"),
  to: new Date("2026-07-15T00:00:00Z"),
};
const filters = { countryCode: null, cityId: null, brand: null, channel: null };

const baseRow = {
  total_all: "12",
  valid_orders: "10",
  total_revenue: "1000",
  cancelled_refunded: "2",
  completed: "8",
  concluded: "10",
  total_cogs: null as string | null,
  total_line_revenue: null as string | null,
  costed_line_revenue: null as string | null,
};

describe("computeKpis COGS coverage plumbing", () => {
  beforeEach(() => {
    mockedQuery.mockReset();
  });

  it("selects the line-revenue columns the coverage math depends on", async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [baseRow] } as never);
    await computeKpis("owner-1", range, filters);
    const sql = mockedQuery.mock.calls[0]![0] as string;
    // Regression guard: the final SELECT must surface these CTE aggregates,
    // otherwise cogsCoveragePct silently becomes null for every window.
    expect(sql).toMatch(/AS total_line_revenue/);
    expect(sql).toMatch(/AS costed_line_revenue/);
    expect(sql).toMatch(/AS total_cogs/);
  });

  it("computes cogsCoveragePct as costed share of line revenue", async () => {
    mockedQuery.mockResolvedValueOnce({
      rows: [
        {
          ...baseRow,
          total_cogs: "200",
          total_line_revenue: "800",
          costed_line_revenue: "600",
        },
      ],
    } as never);
    const k = await computeKpis("owner-1", range, filters);
    expect(k.cogsCoveragePct).toBe(75);
    expect(k.grossMarginUsd).toBe(800);
  });

  it("returns null coverage when there is no line revenue", async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [baseRow] } as never);
    const k = await computeKpis("owner-1", range, filters);
    expect(k.cogsCoveragePct).toBeNull();
  });
});
