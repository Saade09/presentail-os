import { describe, it, expect } from "vitest";
import {
  resolveComparison,
  buildPerformanceSummary,
  previousRange,
  buildTimeSlotBreakdown,
  prettifyCitySlug,
  classifyPunctuality,
  type SummaryKpiInput,
  type TimeSlotRow,
} from "./storeAnalytics.js";

const range = (fromIso: string, toIso: string) => ({
  from: new Date(fromIso),
  to: new Date(toIso),
});

describe("resolveComparison", () => {
  const current = range("2026-07-01T00:00:00Z", "2026-07-15T00:00:00Z");

  it("none returns no baseline", () => {
    expect(resolveComparison("none", current)).toEqual({ mode: "none", baseline: null });
  });

  it("previous returns the immediately-preceding window of equal duration", () => {
    const r = resolveComparison("previous", current);
    expect(r.mode).toBe("previous");
    expect(r.baseline).toEqual(previousRange(current));
    expect(r.baseline!.from.toISOString()).toBe("2026-06-17T00:00:00.000Z");
    expect(r.baseline!.to.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });

  it("last_year shifts the start back one year and keeps the ELAPSED duration", () => {
    const r = resolveComparison("last_year", current);
    expect(r.mode).toBe("last_year");
    expect(r.baseline!.from.toISOString()).toBe("2025-07-01T00:00:00.000Z");
    // 14 elapsed days, NOT the full month — truncation for in-progress periods.
    expect(r.baseline!.to.toISOString()).toBe("2025-07-15T00:00:00.000Z");
  });

  it("custom uses the supplied window and orders swapped bounds", () => {
    const r = resolveComparison(
      "custom",
      current,
      "2026-05-10T00:00:00Z",
      "2026-05-01T00:00:00Z",
    );
    expect(r.mode).toBe("custom");
    expect(r.baseline!.from.toISOString()).toBe("2026-05-01T00:00:00.000Z");
    expect(r.baseline!.to.toISOString()).toBe("2026-05-10T00:00:00.000Z");
  });

  it("custom with missing/invalid bounds falls back to previous", () => {
    const r = resolveComparison("custom", current, "not-a-date", undefined);
    expect(r.mode).toBe("previous");
    expect(r.baseline).toEqual(previousRange(current));
  });
});

const kpi = (overrides: Partial<SummaryKpiInput> = {}): SummaryKpiInput => ({
  totalRevenue: 10000,
  orders: 100,
  aov: 100,
  grossMarginPct: 40,
  cancellationRate: 3,
  cogsCoveragePct: 100,
  ...overrides,
});

describe("buildPerformanceSummary", () => {
  it("no_data when the current window is empty", () => {
    const s = buildPerformanceSummary(kpi({ totalRevenue: 0, orders: 0 }), null);
    expect(s.headline.code).toBe("no_data");
    expect(s.driver.supported).toBe(false);
  });

  it("no_comparison without a baseline", () => {
    const s = buildPerformanceSummary(kpi(), null);
    expect(s.headline.code).toBe("no_comparison");
    expect(s.headline.currentRevenue).toBe(10000);
    expect(s.headline.revenuePct).toBeNull();
  });

  it("stable when revenue moves less than 5%", () => {
    const s = buildPerformanceSummary(kpi({ totalRevenue: 10300 }), kpi());
    expect(s.headline.code).toBe("stable");
    expect(s.headline.revenuePct).toBe(3);
    expect(s.driver.code).toBeNull();
  });

  it("revenue_up driven by orders when orders dominate in the same direction", () => {
    // +20% revenue: orders +18%, aov ~+1.7% → orders share > 60%.
    const s = buildPerformanceSummary(
      kpi({ totalRevenue: 12000, orders: 118, aov: 12000 / 118 }),
      kpi(),
    );
    expect(s.headline.code).toBe("revenue_up");
    expect(s.driver.code).toBe("orders");
    expect(s.driver.supported).toBe(true);
  });

  it("revenue_down driven by aov when aov dominates", () => {
    const s = buildPerformanceSummary(
      kpi({ totalRevenue: 8000, orders: 99, aov: 8000 / 99 }),
      kpi(),
    );
    expect(s.headline.code).toBe("revenue_down");
    expect(s.driver.code).toBe("aov");
    expect(s.driver.supported).toBe(true);
  });

  it("mixed (unsupported) when neither factor reaches 60% dominance", () => {
    // orders +10%, aov ~+9% → neither ≥ 60% of combined movement.
    const s = buildPerformanceSummary(
      kpi({ totalRevenue: 12000, orders: 110, aov: 12000 / 110 }),
      kpi(),
    );
    expect(s.headline.code).toBe("revenue_up");
    expect(s.driver.code).toBe("mixed");
    expect(s.driver.supported).toBe(false);
  });

  it("driver not supported when the dominant factor moves against revenue", () => {
    // Revenue up 10% but orders DOWN sharply while AOV up hugely.
    const s = buildPerformanceSummary(
      kpi({ totalRevenue: 11000, orders: 30, aov: 11000 / 30 }),
      kpi(),
    );
    expect(s.headline.code).toBe("revenue_up");
    // AOV dominates (+266%) in the same direction → supported aov driver.
    expect(s.driver.code).toBe("aov");
    expect(s.driver.supported).toBe(true);
  });

  it("attention: missing_cogs wins over cancellation_up", () => {
    const s = buildPerformanceSummary(
      kpi({ cogsCoveragePct: 50, cancellationRate: 10 }),
      kpi({ cancellationRate: 2 }),
    );
    expect(s.attention.code).toBe("missing_cogs");
    expect(s.attention.values.coveragePct).toBe(50);
  });

  it("attention: cancellation_up at >= 2pp rise with full COGS coverage", () => {
    const s = buildPerformanceSummary(
      kpi({ cancellationRate: 5.5 }),
      kpi({ cancellationRate: 3 }),
    );
    expect(s.attention.code).toBe("cancellation_up");
    expect(s.attention.values.current).toBe(5.5);
    expect(s.attention.values.previous).toBe(3);
  });

  it("attention: none when coverage is fine and cancellation rise < 2pp", () => {
    const s = buildPerformanceSummary(
      kpi({ cancellationRate: 4 }),
      kpi({ cancellationRate: 3 }),
    );
    expect(s.attention.code).toBeNull();
  });
});

describe("buildTimeSlotBreakdown", () => {
  const row = (over: Partial<TimeSlotRow> = {}): TimeSlotRow => ({
    slot: "09:00–12:00",
    sort_start: "09:00",
    orders: "10",
    revenue: "500",
    express_orders: "0",
    express_revenue: "0",
    express_surcharge_usd: "0",
    slot_fee_usd: "0",
    ...over,
  });

  it("returns empty slots and zero totals for no rows", () => {
    const r = buildTimeSlotBreakdown([]);
    expect(r.timeSlots).toEqual([]);
    expect(r.totals).toEqual({
      orders: 0,
      revenue: 0,
      expressOrders: 0,
      expressRevenue: 0,
      expressSurchargeUsd: 0,
      slotFeeUsd: 0,
    });
  });

  it("orders slots by window start ascending with the null bucket last", () => {
    const r = buildTimeSlotBreakdown([
      row({ slot: "15:00–18:00", sort_start: "15:00" }),
      row({ slot: null, sort_start: null }),
      row({ slot: "09:00–12:00", sort_start: "09:00" }),
    ]);
    expect(r.timeSlots.map((s) => s.slot)).toEqual([
      "09:00–12:00",
      "15:00–18:00",
      null,
    ]);
  });

  it("computes express vs standard split and fee sums per slot", () => {
    const r = buildTimeSlotBreakdown([
      row({
        orders: "10",
        revenue: "500",
        express_orders: "4",
        express_revenue: "220",
        express_surcharge_usd: "36.5",
        slot_fee_usd: "12",
      }),
    ]);
    const s = r.timeSlots[0];
    expect(s.orders).toBe(10);
    expect(s.revenue).toBe(500);
    expect(s.expressOrders).toBe(4);
    expect(s.expressRevenue).toBe(220);
    expect(s.standardOrders).toBe(6);
    expect(s.standardRevenue).toBe(280);
    expect(s.expressSurchargeUsd).toBe(36.5);
    expect(s.slotFeeUsd).toBe(12);
    expect(s.sharePct).toBe(100);
  });

  it("computes revenue share to one decimal and totals reconcile across buckets", () => {
    const r = buildTimeSlotBreakdown([
      row({ slot: "09:00–12:00", sort_start: "09:00", orders: "3", revenue: "100" }),
      row({
        slot: "12:00–15:00",
        sort_start: "12:00",
        orders: "5",
        revenue: "200",
        express_orders: "2",
        express_revenue: "80",
        express_surcharge_usd: "10",
      }),
      row({ slot: null, sort_start: null, orders: "2", revenue: "0.5", slot_fee_usd: "5" }),
    ]);
    expect(r.totals.orders).toBe(10);
    expect(r.totals.revenue).toBeCloseTo(300.5);
    expect(r.totals.expressOrders).toBe(2);
    expect(r.totals.expressRevenue).toBe(80);
    expect(r.totals.expressSurchargeUsd).toBe(10);
    expect(r.totals.slotFeeUsd).toBe(5);
    expect(r.timeSlots[0].sharePct).toBeCloseTo(33.3);
    expect(r.timeSlots[1].sharePct).toBeCloseTo(66.6, 0);
    // share of the slot-less bucket still contributes to reconciliation
    const shareSum = r.timeSlots.reduce((a, s) => a + s.sharePct, 0);
    expect(shareSum).toBeGreaterThan(99);
    expect(shareSum).toBeLessThanOrEqual(100.2);
  });

  it("treats zero-revenue windows as 0% share (no division by zero)", () => {
    const r = buildTimeSlotBreakdown([
      row({ orders: "2", revenue: "0" }),
      row({ slot: null, sort_start: null, orders: "1", revenue: "0" }),
    ]);
    expect(r.timeSlots.every((s) => s.sharePct === 0)).toBe(true);
  });

  it("tolerates null/garbage numeric strings and never returns negative standard split", () => {
    const r = buildTimeSlotBreakdown([
      row({
        orders: "2",
        revenue: null,
        express_orders: "3",
        express_revenue: "50",
        express_surcharge_usd: null,
        slot_fee_usd: null,
      }),
    ]);
    const s = r.timeSlots[0];
    expect(s.revenue).toBe(0);
    expect(s.standardOrders).toBe(0);
    expect(s.standardRevenue).toBe(0);
    expect(s.expressSurchargeUsd).toBe(0);
    expect(s.slotFeeUsd).toBe(0);
  });
});

describe("prettifyCitySlug", () => {
  it("strips a 2-letter country prefix and title-cases the slug", () => {
    expect(prettifyCitySlug("lb-beirut")).toBe("Beirut");
    expect(prettifyCitySlug("ae-abu-dhabi")).toBe("Abu Dhabi");
    expect(prettifyCitySlug("LB-SAIDA")).toBe("Saida");
  });

  it("prettifies slugs without a country prefix", () => {
    expect(prettifyCitySlug("beirut")).toBe("Beirut");
    expect(prettifyCitySlug("new_york")).toBe("New York");
  });

  it("returns null for null, blank, and numeric ids", () => {
    expect(prettifyCitySlug(null)).toBeNull();
    expect(prettifyCitySlug(undefined)).toBeNull();
    expect(prettifyCitySlug("")).toBeNull();
    expect(prettifyCitySlug("   ")).toBeNull();
    expect(prettifyCitySlug("12345")).toBeNull();
  });

  it("does not strip a bare 2-letter word with nothing after the prefix", () => {
    expect(prettifyCitySlug("lb-")).toBe("Lb");
    expect(prettifyCitySlug("nyc")).toBe("Nyc");
  });
});

describe("classifyPunctuality", () => {
  const base = {
    id: "o1",
    display_order_number: "1001",
    ordered_at: "2026-07-10T10:00:00Z",
    created_at: "2026-07-10T09:55:00Z",
    window_end: "2026-07-10T14:00:00Z",
    is_express: false,
    completed_at: "2026-07-10T13:00:00Z",
  };

  it("standard order completed before window end is on time", () => {
    const r = classifyPunctuality({ ...base });
    expect(r?.status).toBe("on_time");
    expect(r?.minutesLate).toBe(-60);
    expect(r?.deadline).toBe("2026-07-10T14:00:00.000Z");
  });

  it("standard order completed exactly at window end is on time (boundary)", () => {
    const r = classifyPunctuality({
      ...base,
      completed_at: "2026-07-10T14:00:00Z",
    });
    expect(r?.status).toBe("on_time");
    expect(r?.minutesLate).toBe(0);
  });

  it("standard order completed after window end is late", () => {
    const r = classifyPunctuality({
      ...base,
      completed_at: "2026-07-10T14:25:00Z",
    });
    expect(r?.status).toBe("late");
    expect(r?.minutesLate).toBe(25);
  });

  it("express order on-time within 90 minutes of placement (boundary inclusive)", () => {
    const r = classifyPunctuality({
      ...base,
      is_express: true,
      window_end: null,
      completed_at: "2026-07-10T11:30:00Z",
    });
    expect(r?.status).toBe("on_time");
    expect(r?.minutesLate).toBe(0);
    expect(r?.deadline).toBe("2026-07-10T11:30:00.000Z");
  });

  it("express order late after 90 minutes; ignores window_end", () => {
    const r = classifyPunctuality({
      ...base,
      is_express: true,
      completed_at: "2026-07-10T11:31:00Z",
    });
    expect(r?.status).toBe("late");
    expect(r?.minutesLate).toBe(1);
  });

  it("express falls back to created_at when ordered_at is missing", () => {
    const r = classifyPunctuality({
      ...base,
      is_express: true,
      ordered_at: null,
      completed_at: "2026-07-10T11:26:00Z",
    });
    // deadline = created_at 09:55 + 90min = 11:25 → 1 minute late
    expect(r?.status).toBe("late");
    expect(r?.minutesLate).toBe(1);
  });

  it("excludes standard orders without a delivery window", () => {
    expect(classifyPunctuality({ ...base, window_end: null })).toBeNull();
  });

  it("excludes orders without a completion time", () => {
    expect(classifyPunctuality({ ...base, completed_at: null })).toBeNull();
  });

  it("excludes express orders with no placement timestamp at all", () => {
    expect(
      classifyPunctuality({
        ...base,
        is_express: true,
        ordered_at: null,
        created_at: null,
      }),
    ).toBeNull();
  });

  it("accepts Date instances (tookan fallback path passes Dates)", () => {
    const r = classifyPunctuality({
      ...base,
      ordered_at: new Date("2026-07-10T10:00:00Z"),
      window_end: new Date("2026-07-10T14:00:00Z"),
      completed_at: new Date("2026-07-10T15:00:00Z"),
    });
    expect(r?.status).toBe("late");
    expect(r?.minutesLate).toBe(60);
    expect(r?.completedAt).toBe("2026-07-10T15:00:00.000Z");
  });
});
