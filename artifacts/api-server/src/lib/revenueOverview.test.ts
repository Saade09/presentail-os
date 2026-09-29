import { describe, it, expect } from "vitest";
import {
  granularityFor,
  computePulse,
  enumerateBuckets,
  assembleSeries,
  computeSnapshot,
  emptyStreamTotals,
  pctChange,
  roundMoney,
  PULSE_THRESHOLDS,
  type StreamTotals,
} from "./revenueOverview";

function range(fromIso: string, toIso: string) {
  return { from: new Date(fromIso), to: new Date(toIso) };
}

describe("granularityFor", () => {
  it("uses hourly buckets for ranges up to 2 days", () => {
    expect(granularityFor(range("2026-08-01T00:00:00Z", "2026-08-02T00:00:00Z"))).toBe("hour");
    expect(granularityFor(range("2026-08-01T00:00:00Z", "2026-08-03T00:00:00Z"))).toBe("hour");
  });
  it("uses daily buckets up to 31 days", () => {
    expect(granularityFor(range("2026-08-01T00:00:00Z", "2026-08-10T00:00:00Z"))).toBe("day");
    expect(granularityFor(range("2026-07-01T00:00:00Z", "2026-08-01T00:00:00Z"))).toBe("day");
  });
  it("uses weekly buckets up to 180 days", () => {
    expect(granularityFor(range("2026-02-01T00:00:00Z", "2026-06-01T00:00:00Z"))).toBe("week");
  });
  it("uses monthly buckets beyond 180 days", () => {
    expect(granularityFor(range("2025-01-01T00:00:00Z", "2026-01-01T00:00:00Z"))).toBe("month");
  });
});

describe("computePulse", () => {
  it("is on track when change >= at-risk threshold", () => {
    const p = computePulse(96, 100); // -4%
    expect(p.status).toBe("on_track");
    expect(p.changePct).toBeCloseTo(-4);
    expect(p.reason).toContain(`${PULSE_THRESHOLDS.atRiskBelowPct}%`);
  });
  it("is at risk between thresholds", () => {
    const p = computePulse(85, 100); // -15%
    expect(p.status).toBe("at_risk");
    expect(p.reason).toContain(`${PULSE_THRESHOLDS.offTrackBelowPct}%`);
  });
  it("is off track below the off-track threshold", () => {
    const p = computePulse(70, 100); // -30%
    expect(p.status).toBe("off_track");
  });
  it("reports no_data when both periods are empty", () => {
    expect(computePulse(0, 0).status).toBe("no_data");
    expect(computePulse(0, null).status).toBe("no_data");
  });
  it("is on track with new activity and no baseline", () => {
    const p = computePulse(500, 0);
    expect(p.status).toBe("on_track");
    expect(p.changePct).toBeNull();
  });
});

describe("enumerateBuckets", () => {
  it("enumerates daily buckets covering the range", () => {
    const buckets = enumerateBuckets(range("2026-08-01T00:00:00Z", "2026-08-04T00:00:00Z"), "day");
    expect(buckets).toEqual([
      "2026-08-01T00:00:00.000Z",
      "2026-08-02T00:00:00.000Z",
      "2026-08-03T00:00:00.000Z",
    ]);
  });
  it("aligns week buckets to Monday like date_trunc('week')", () => {
    // 2026-08-05 is a Wednesday; the containing week starts Monday 08-03.
    const buckets = enumerateBuckets(range("2026-08-05T00:00:00Z", "2026-08-17T00:00:00Z"), "week");
    expect(buckets[0]).toBe("2026-08-03T00:00:00.000Z");
  });
  it("aligns month buckets to the first of the month", () => {
    const buckets = enumerateBuckets(range("2026-03-15T00:00:00Z", "2026-06-01T00:00:00Z"), "month");
    expect(buckets[0]).toBe("2026-03-01T00:00:00.000Z");
    expect(buckets).toHaveLength(3);
  });
});

describe("assembleSeries", () => {
  it("leaves gaps (null) where a stream has no rows, and totals treat gaps as 0", () => {
    const buckets = [
      "2026-08-01T00:00:00.000Z",
      "2026-08-02T00:00:00.000Z",
      "2026-08-03T00:00:00.000Z",
    ];
    const series = assembleSeries(buckets, {
      ecommerce: [
        { bucket: "2026-08-01T00:00:00.000Z", revenue: 100, orders: 2, refunds: 0 },
        { bucket: "2026-08-03T00:00:00.000Z", revenue: 50, orders: 1, refunds: 0 },
      ],
      retail: [{ bucket: "2026-08-02T00:00:00.000Z", revenue: 30, orders: 1, refunds: 0 }],
      cmc: [],
      toters: [{ bucket: "2026-08-03T00:00:00.000Z", revenue: 20, orders: 1, refunds: 0 }],
    });
    expect(series).toHaveLength(3);
    expect(series[0]).toMatchObject({ ecommerce: 100, retail: null, cmc: null, total: 100 });
    expect(series[1]).toMatchObject({ ecommerce: null, retail: 30, cmc: null, total: 30 });
    expect(series[2]).toMatchObject({ ecommerce: 50, retail: null, cmc: null, toters: 20, total: 70 });
  });
});

describe("computeSnapshot", () => {
  function totals(over: Partial<StreamTotals>): StreamTotals {
    return { ...emptyStreamTotals(), ...over };
  }

  it("computes orders, AOV and refund rate", () => {
    const snap = computeSnapshot(
      {
        ecommerce: totals({ revenue: 800, orders: 8, refunds: 100 }),
        retail: totals({ revenue: 150, orders: 3 }),
        cmc: totals({ revenue: 50, orders: 1 }),
        toters: totals({ revenue: 200, orders: 4 }),
      },
      { cogsUsd: 0, costedRevenueUsd: 0 },
    );
    expect(snap.orders.value).toBe(16);
    expect(snap.aov.value).toBeCloseTo(1200 / 16, 2);
    // refunds / (revenue + refunds) = 100 / 1300
    expect(snap.refundRate.value).toBeCloseTo(7.69, 1);
  });

  it("marks gross margin unavailable when COGS coverage is insufficient", () => {
    const snap = computeSnapshot(
      {
        ecommerce: totals({ revenue: 900, orders: 9 }),
        retail: totals({ revenue: 100, orders: 2 }),
        cmc: totals({ revenue: 0, orders: 0 }),
        toters: totals({ revenue: 0, orders: 0 }),
      },
      { cogsUsd: 40, costedRevenueUsd: 100 }, // 10% coverage
    );
    expect(snap.grossMargin.available).toBe(false);
    expect(snap.grossMargin.value).toBeNull();
    expect(snap.grossMargin.reason).toContain("COGS");
    expect(snap.grossMargin.coveragePct).toBe(10);
  });

  it("computes gross margin when coverage >= 95%", () => {
    const snap = computeSnapshot(
      {
        ecommerce: totals({ revenue: 0, orders: 0 }),
        retail: totals({ revenue: 100, orders: 2 }),
        cmc: totals({ revenue: 0, orders: 0 }),
        toters: totals({ revenue: 0, orders: 0 }),
      },
      { cogsUsd: 40, costedRevenueUsd: 100 },
    );
    expect(snap.grossMargin.available).toBe(true);
    expect(snap.grossMargin.value).toBe(60);
  });

  it("marks AOV and refund rate unavailable with no activity", () => {
    const snap = computeSnapshot(
      {
        ecommerce: totals({}),
        retail: totals({}),
        cmc: totals({}),
        toters: totals({}),
      },
      { cogsUsd: 0, costedRevenueUsd: 0 },
    );
    expect(snap.aov.available).toBe(false);
    expect(snap.refundRate.available).toBe(false);
    expect(snap.orders.value).toBe(0);
  });
});

describe("pctChange / roundMoney", () => {
  it("computes percent change against a baseline", () => {
    expect(pctChange(110, 100)).toBeCloseTo(10);
    expect(pctChange(90, 100)).toBeCloseTo(-10);
    expect(pctChange(50, 0)).toBeNull();
    expect(pctChange(50, null)).toBeNull();
  });
  it("rounds to cents", () => {
    expect(roundMoney(10.005)).toBeCloseTo(10.01, 10);
    expect(roundMoney(0.1 + 0.2)).toBe(0.3);
  });
});
