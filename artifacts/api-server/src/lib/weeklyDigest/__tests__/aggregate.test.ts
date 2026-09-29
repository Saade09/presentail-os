// Unit tests for the Weekly Sales Digest aggregation math (task #2830).
// Pure functions only — no database.

import { describe, it, expect } from "vitest";
import {
  getLastCompletedWeek,
  getPreviousWeek,
  isoWeekNumber,
  weekStartKey,
  pctChange,
  computeWeeklyMetrics,
  computeDeliveryStats,
  computeFunnelStats,
  computeCmcMetrics,
  markNewBestSellers,
  type WeeklyRawData,
  type RawOrderRow,
  type RawLineItemRow,
  type RawCmcSaleRow,
  type WeekWindow,
} from "../aggregate";

// A fixed window: Monday 2026-06-22 → Monday 2026-06-29 (exclusive)
const WINDOW: WeekWindow = {
  start: new Date("2026-06-22T00:00:00.000Z"),
  end: new Date("2026-06-29T00:00:00.000Z"),
};

function makeOrder(overrides: Partial<RawOrderRow> = {}): RawOrderRow {
  return {
    id: overrides.id ?? `o-${Math.random().toString(36).slice(2)}`,
    status: "completed",
    channel: "website",
    source: "presentail",
    totals: { subtotal: 100, shipping: 0, discount: 0, total: 100, currency: "USD" },
    delivery_address: { countryCode: "LB", district: "Beirut" },
    ordered_at: "2026-06-23T10:00:00.000Z",
    payment_amount_usd: null,
    payment_status: "paid",
    ...overrides,
  };
}

function makeRaw(overrides: Partial<WeeklyRawData> = {}): WeeklyRawData {
  return {
    window: WINDOW,
    orders: [],
    lineItems: [],
    customers: [],
    coupons: { redemption_count: 0, total_discount_usd: 0 },
    webEvents: { product_views: 0, add_to_carts: 0, purchases: 0 },
    cmcSales: [],
    ...overrides,
  };
}

function makeCmcSale(overrides: Partial<RawCmcSaleRow> = {}): RawCmcSaleRow {
  return {
    id: `cmc-${Math.random().toString(36).slice(2)}`,
    status: "paid",
    total: "111.00",
    fulfilment_date: "2026-06-23",
    created_at: "2026-06-23T10:00:00.000Z",
    ...overrides,
  };
}

describe("week windows", () => {
  it("getLastCompletedWeek returns the prior Mon–Sun week (from a Wednesday)", () => {
    const w = getLastCompletedWeek(new Date("2026-07-01T15:30:00.000Z")); // Wed
    expect(w.start.toISOString()).toBe("2026-06-22T00:00:00.000Z"); // Monday
    expect(w.end.toISOString()).toBe("2026-06-29T00:00:00.000Z");
  });

  it("getLastCompletedWeek on a Monday returns the week that just ended", () => {
    const w = getLastCompletedWeek(new Date("2026-06-29T06:00:00.000Z")); // Mon
    expect(w.start.toISOString()).toBe("2026-06-22T00:00:00.000Z");
    expect(w.end.toISOString()).toBe("2026-06-29T00:00:00.000Z");
  });

  it("getPreviousWeek shifts back exactly 7 days", () => {
    const prev = getPreviousWeek(WINDOW);
    expect(prev.start.toISOString()).toBe("2026-06-15T00:00:00.000Z");
    expect(prev.end.toISOString()).toBe("2026-06-22T00:00:00.000Z");
  });

  it("isoWeekNumber matches known ISO weeks", () => {
    expect(isoWeekNumber(new Date("2026-06-29T00:00:00.000Z"))).toBe(27);
    expect(isoWeekNumber(new Date("2026-01-01T00:00:00.000Z"))).toBe(1);
    expect(isoWeekNumber(new Date("2027-01-01T00:00:00.000Z"))).toBe(53); // 2026 has 53 ISO weeks
  });

  it("weekStartKey is the Monday ISO date", () => {
    expect(weekStartKey(WINDOW)).toBe("2026-06-22");
  });
});

describe("pctChange", () => {
  it("computes percentage change", () => {
    expect(pctChange(120, 100)).toBe(20);
    expect(pctChange(80, 100)).toBe(-20);
  });
  it("returns null when previous is zero", () => {
    expect(pctChange(50, 0)).toBeNull();
  });
});

describe("computeWeeklyMetrics", () => {
  it("computes totals, AOV, and discounts; gross = net + discounts", () => {
    const raw = makeRaw({
      orders: [
        makeOrder({ id: "a", totals: { total: 100, discount: 10 } }),
        makeOrder({ id: "b", totals: { total: 50, discount: 0 } }),
      ],
    });
    const m = computeWeeklyMetrics(raw);
    expect(m.orders).toBe(2);
    expect(m.netSalesUsd).toBe(150);
    expect(m.discountsUsd).toBe(10);
    expect(m.grossSalesUsd).toBe(160);
    expect(m.aovUsd).toBe(75);
  });

  it("excludes cancelled and refunded orders from sales but counts them separately", () => {
    const raw = makeRaw({
      orders: [
        makeOrder({ id: "a", totals: { total: 100, discount: 0 } }),
        makeOrder({ id: "b", status: "cancelled", totals: { total: 40, discount: 0 } }),
        makeOrder({ id: "c", status: "refunded", totals: { total: 60, discount: 0 } }),
        makeOrder({
          id: "d",
          payment_status: "refunded",
          totals: { total: 30, discount: 0 },
        }),
      ],
    });
    const m = computeWeeklyMetrics(raw);
    expect(m.orders).toBe(1);
    expect(m.netSalesUsd).toBe(100);
    expect(m.cancelledOrders).toBe(1);
    expect(m.cancelledUsd).toBe(40);
    expect(m.refundedOrders).toBe(2);
    expect(m.refundedUsd).toBe(90);
  });

  it("falls back to payment amount when totals.total is missing", () => {
    const raw = makeRaw({
      orders: [makeOrder({ id: "a", totals: null, payment_amount_usd: "42.50" })],
    });
    const m = computeWeeklyMetrics(raw);
    expect(m.netSalesUsd).toBe(42.5);
  });

  it("computes COGS and margin only over COGS-covered revenue", () => {
    const items: RawLineItemRow[] = [
      {
        order_id: "a",
        product_id: 1,
        name: "Roses",
        quantity: 2,
        unit_price: 50,
        line_total: 100,
        category: "Flowers",
        cogs_usd: 20, // per unit → 40 total
        occasions: null,
        recipients: null,
      },
      {
        order_id: "a",
        product_id: 2,
        name: "Mystery Box",
        quantity: 1,
        unit_price: 60,
        line_total: 60,
        category: null,
        cogs_usd: null, // unknown COGS — excluded from margin
        occasions: null,
        recipients: null,
      },
    ];
    const raw = makeRaw({
      orders: [makeOrder({ id: "a", totals: { total: 160, discount: 0 } })],
      lineItems: items,
    });
    const m = computeWeeklyMetrics(raw);
    expect(m.cogsUsd).toBe(40);
    expect(m.cogsCoveredSalesUsd).toBe(100);
    expect(m.grossMarginPct).toBe(60); // (100-40)/100
    const roses = m.bestSellers.find((b) => b.name === "Roses");
    const box = m.bestSellers.find((b) => b.name === "Mystery Box");
    expect(roses?.marginPct).toBe(60);
    expect(box?.marginPct).toBeNull();
  });

  it("ignores line items from cancelled orders", () => {
    const raw = makeRaw({
      orders: [makeOrder({ id: "x", status: "cancelled" })],
      lineItems: [
        {
          order_id: "x",
          product_id: 1,
          name: "Roses",
          quantity: 1,
          unit_price: 100,
          line_total: 100,
          category: "Flowers",
          cogs_usd: 10,
          occasions: null,
          recipients: null,
        },
      ],
    });
    const m = computeWeeklyMetrics(raw);
    expect(m.bestSellers).toHaveLength(0);
    expect(m.cogsUsd).toBe(0);
  });

  it("breaks down by country, city, and channel", () => {
    const raw = makeRaw({
      orders: [
        makeOrder({
          id: "a",
          delivery_address: { countryCode: "LB", district: "Beirut" },
          channel: "website",
          totals: { total: 100, discount: 0 },
        }),
        makeOrder({
          id: "b",
          delivery_address: { countryCode: "AE", district: "Dubai" },
          channel: null,
          source: "instagram",
          totals: { total: 200, discount: 0 },
        }),
        makeOrder({
          id: "c",
          delivery_address: null,
          channel: "website",
          totals: { total: 50, discount: 0 },
        }),
      ],
    });
    const m = computeWeeklyMetrics(raw);
    expect(m.byCountry.find((r) => r.label === "AE")?.salesUsd).toBe(200);
    expect(m.byCountry.find((r) => r.label === "LB")?.salesUsd).toBe(100);
    expect(m.byCountry.find((r) => r.label === "Unknown")?.salesUsd).toBe(50);
    expect(m.byCity.find((r) => r.label === "Dubai")?.orders).toBe(1);
    expect(m.byChannel.find((r) => r.label === "instagram")?.salesUsd).toBe(200);
    // Sorted by sales desc
    expect(m.byCountry[0].label).toBe("AE");
  });

  it("computes new vs returning customers and guest vs registered orders", () => {
    const raw = makeRaw({
      orders: [
        makeOrder({ id: "a" }),
        makeOrder({ id: "b" }),
        makeOrder({ id: "c" }), // no contact → guest
      ],
      customers: [
        {
          order_id: "a",
          contact_id: "c1",
          email: "new@x.com",
          first_order_at: "2026-06-23T10:00:00.000Z", // inside window → new
        },
        {
          order_id: "b",
          contact_id: "c2",
          email: "old@x.com",
          first_order_at: "2026-01-05T10:00:00.000Z", // before window → returning
        },
      ],
    });
    const m = computeWeeklyMetrics(raw);
    expect(m.newCustomers).toBe(1);
    expect(m.returningCustomers).toBe(1);
    expect(m.repeatRatePct).toBe(50);
    expect(m.registeredOrders).toBe(2);
    expect(m.guestOrders).toBe(1);
  });

  it("seeds all 7 days in the daily breakdown and buckets orders by day", () => {
    const raw = makeRaw({
      orders: [
        makeOrder({ id: "a", ordered_at: "2026-06-22T09:00:00.000Z", totals: { total: 10, discount: 0 } }),
        makeOrder({ id: "b", ordered_at: "2026-06-28T23:00:00.000Z", totals: { total: 20, discount: 0 } }),
      ],
    });
    const m = computeWeeklyMetrics(raw);
    expect(m.daily).toHaveLength(7);
    expect(m.daily[0]).toEqual({ date: "2026-06-22", orders: 1, salesUsd: 10 });
    expect(m.daily[6]).toEqual({ date: "2026-06-28", orders: 1, salesUsd: 20 });
    expect(m.daily[3].orders).toBe(0);
  });

  it("attributes revenue to occasions and recipients", () => {
    const raw = makeRaw({
      orders: [makeOrder({ id: "a" })],
      lineItems: [
        {
          order_id: "a",
          product_id: 1,
          name: "Roses",
          quantity: 1,
          unit_price: 100,
          line_total: 100,
          category: "Flowers",
          cogs_usd: null,
          occasions: ["Birthday", "Anniversary"],
          recipients: ["Her"],
        },
      ],
    });
    const m = computeWeeklyMetrics(raw);
    expect(m.byOccasion.find((r) => r.label === "Birthday")?.salesUsd).toBe(100);
    expect(m.byOccasion.find((r) => r.label === "Anniversary")?.salesUsd).toBe(100);
    expect(m.byRecipient.find((r) => r.label === "Her")?.salesUsd).toBe(100);
  });

  it("passes coupon stats through", () => {
    const raw = makeRaw({ coupons: { redemption_count: 3, total_discount_usd: 45.5 } });
    const m = computeWeeklyMetrics(raw);
    expect(m.couponRedemptions).toBe(3);
    expect(m.couponDiscountUsd).toBe(45.5);
  });
});

describe("computeDeliveryStats", () => {
  const base = {
    status: "completed",
    ordered_at: "2026-06-23T10:00:00.000Z",
    window_start: "2026-06-24T14:00:00.000Z",
    window_end: "2026-06-24T18:00:00.000Z",
  };

  it("returns all-null/zero when there are no orders", () => {
    const d = computeDeliveryStats([]);
    expect(d.deliveryOrders).toBe(0);
    expect(d.onTimeRatePct).toBeNull();
    expect(d.avgDeliveryTimeHours).toBeNull();
    expect(d.lateDeliveries).toBe(0);
  });

  it("classifies on-time vs late from delivered_at vs window_end", () => {
    const d = computeDeliveryStats([
      makeOrder({ ...base, delivered_at: "2026-06-24T17:00:00.000Z" }), // on time
      makeOrder({ ...base, delivered_at: "2026-06-24T19:30:00.000Z" }), // late
      makeOrder({ ...base, delivered_at: "2026-06-24T18:00:00.000Z" }), // boundary = on time
    ]);
    expect(d.onTimeDeliveries).toBe(2);
    expect(d.lateDeliveries).toBe(1);
    expect(d.onTimeRatePct).toBeCloseTo(66.67, 1);
  });

  it("excludes deliveries missing delivered_at or window_end from the rate", () => {
    const d = computeDeliveryStats([
      makeOrder({ ...base, delivered_at: null }), // delivered, no timestamp
      makeOrder({ ...base, window_end: null, delivered_at: "2026-06-24T12:00:00.000Z" }),
    ]);
    expect(d.onTimeRatePct).toBeNull();
    expect(d.deliveredOrders).toBe(2);
    // avg time still computable from delivered_at
    expect(d.avgDeliveryTimeHours).toBeCloseTo(26, 1);
  });

  it("counts same-day and express orders", () => {
    const d = computeDeliveryStats([
      makeOrder({
        ...base,
        window_start: "2026-06-23T16:00:00.000Z", // same UTC day as ordered_at
        delivery_type: "express",
      }),
      makeOrder({ ...base }), // next-day, standard
    ]);
    expect(d.sameDayOrders).toBe(1);
    expect(d.expressOrders).toBe(1);
  });

  it("excludes pickup, cancelled and refunded orders", () => {
    const d = computeDeliveryStats([
      makeOrder({ ...base, delivery_type: "pickup" }),
      makeOrder({ ...base, status: "cancelled" }),
      makeOrder({ ...base, status: "refunded" }),
      makeOrder({ ...base }),
    ]);
    expect(d.deliveryOrders).toBe(1);
  });

  it("averages delivery time in hours and ignores negative deltas", () => {
    const d = computeDeliveryStats([
      makeOrder({ ...base, delivered_at: "2026-06-23T14:00:00.000Z" }), // 4h
      makeOrder({ ...base, delivered_at: "2026-06-23T18:00:00.000Z" }), // 8h
      makeOrder({ ...base, delivered_at: "2026-06-23T08:00:00.000Z" }), // negative → ignored
    ]);
    expect(d.avgDeliveryTimeHours).toBe(6);
  });

  it("non-delivered orders never count toward on-time/late or avg time", () => {
    const d = computeDeliveryStats([
      makeOrder({
        ...base,
        status: "processing",
        tookan_status: "started",
        delivered_at: "2026-06-24T17:00:00.000Z",
      }),
    ]);
    expect(d.deliveredOrders).toBe(0);
    expect(d.onTimeRatePct).toBeNull();
    expect(d.avgDeliveryTimeHours).toBeNull();
  });

  it("tookan_status successful counts as delivered", () => {
    const d = computeDeliveryStats([
      makeOrder({
        ...base,
        status: "processing",
        tookan_status: "successful",
        delivered_at: "2026-06-24T17:00:00.000Z",
      }),
    ]);
    expect(d.deliveredOrders).toBe(1);
    expect(d.onTimeDeliveries).toBe(1);
  });

  it("is attached to computeWeeklyMetrics output", () => {
    const m = computeWeeklyMetrics(
      makeRaw({ orders: [makeOrder({ ...base, delivered_at: "2026-06-24T17:00:00.000Z" })] }),
    );
    expect(m.delivery.deliveryOrders).toBe(1);
    expect(m.delivery.onTimeRatePct).toBe(100);
  });
});

describe("computeFunnelStats", () => {
  it("marks untracked and nulls rates when there are no views", () => {
    const f = computeFunnelStats({ product_views: 0, add_to_carts: 5, purchases: 2 });
    expect(f.tracked).toBe(false);
    expect(f.addToCartRatePct).toBeNull();
    expect(f.conversionRatePct).toBeNull();
  });

  it("computes add-to-cart and conversion rates from views", () => {
    const f = computeFunnelStats({ product_views: 200, add_to_carts: 30, purchases: 8 });
    expect(f.tracked).toBe(true);
    expect(f.addToCartRatePct).toBe(15);
    expect(f.conversionRatePct).toBe(4);
  });

  it("is attached to computeWeeklyMetrics output", () => {
    const m = computeWeeklyMetrics(
      makeRaw({ webEvents: { product_views: 100, add_to_carts: 10, purchases: 5 } }),
    );
    expect(m.funnel.productViews).toBe(100);
    expect(m.funnel.conversionRatePct).toBe(5);
  });
});

describe("markNewBestSellers", () => {
  it("badges products absent from the previous week's top list", () => {
    const cur = computeWeeklyMetrics(
      makeRaw({
        orders: [makeOrder({ id: "a" })],
        lineItems: [
          { order_id: "a", product_id: 1, name: "Roses", quantity: 1, unit_price: 100, line_total: 100, category: null, cogs_usd: null, occasions: null, recipients: null },
          { order_id: "a", product_id: 2, name: "Tulips", quantity: 1, unit_price: 50, line_total: 50, category: null, cogs_usd: null, occasions: null, recipients: null },
        ],
      }),
    );
    const prev = computeWeeklyMetrics(
      makeRaw({
        orders: [makeOrder({ id: "p" })],
        lineItems: [
          { order_id: "p", product_id: 1, name: "Roses", quantity: 1, unit_price: 100, line_total: 100, category: null, cogs_usd: null, occasions: null, recipients: null },
        ],
      }),
    );
    markNewBestSellers(cur, prev);
    expect(cur.bestSellers.find((b) => b.name === "Roses")?.isNew).toBe(false);
    expect(cur.bestSellers.find((b) => b.name === "Tulips")?.isNew).toBe(true);
  });
});

// ── computeCmcMetrics ────────────────────────────────────────────────────────

describe("computeCmcMetrics", () => {
  it("returns zeros for an empty sales list", () => {
    const m = computeCmcMetrics([]);
    expect(m.saleCount).toBe(0);
    expect(m.grossSalesUsd).toBe(0);
    expect(m.netSalesUsd).toBe(0);
    expect(m.commissionUsd).toBe(0);
    expect(m.commissionVatUsd).toBe(0);
    expect(m.payableUsd).toBe(0);
  });

  it("applies the correct financial formulas for a single paid sale", () => {
    // gross = 111.00, net = 111/1.11 = 100, commission = 20, commissionVat = 2.2, payable = 22.2
    const m = computeCmcMetrics([makeCmcSale({ total: "111.00" })]);
    expect(m.saleCount).toBe(1);
    expect(m.grossSalesUsd).toBe(111);
    expect(m.netSalesUsd).toBeCloseTo(100, 1);
    expect(m.commissionUsd).toBe(20);
    expect(m.commissionVatUsd).toBe(2.2);
    expect(m.payableUsd).toBe(22.2);
  });

  it("sums multiple paid sales", () => {
    const sales = [
      makeCmcSale({ total: "111.00" }), // net 100
      makeCmcSale({ total: "55.50" }),  // net 50
    ];
    const m = computeCmcMetrics(sales);
    expect(m.saleCount).toBe(2);
    expect(m.grossSalesUsd).toBeCloseTo(166.5, 2);
    expect(m.netSalesUsd).toBeCloseTo(150, 1);
  });

  it("excludes voided and refunded sales", () => {
    const sales = [
      makeCmcSale({ total: "111.00", status: "paid" }),
      makeCmcSale({ total: "200.00", status: "voided" }),
      makeCmcSale({ total: "300.00", status: "refunded" }),
    ];
    const m = computeCmcMetrics(sales);
    expect(m.saleCount).toBe(1);
    expect(m.grossSalesUsd).toBe(111);
  });

  it("returns zeros gracefully when all sales are voided/refunded", () => {
    const sales = [
      makeCmcSale({ total: "111.00", status: "voided" }),
    ];
    const m = computeCmcMetrics(sales);
    expect(m.saleCount).toBe(0);
    expect(m.grossSalesUsd).toBe(0);
    expect(m.payableUsd).toBe(0);
  });
});

// ── CMC POS in computeWeeklyMetrics ─────────────────────────────────────────

describe("computeWeeklyMetrics — CMC POS integration", () => {
  it("adds a 'CMC POS' row to byChannel when there are paid CMC sales", () => {
    const raw = makeRaw({
      cmcSales: [makeCmcSale({ total: "111.00" })],
    });
    const m = computeWeeklyMetrics(raw);
    const cmcChannel = m.byChannel.find((r) => r.label === "CMC POS");
    expect(cmcChannel).toBeDefined();
    expect(cmcChannel!.orders).toBe(1);
    expect(cmcChannel!.salesUsd).toBeCloseTo(111, 2);
  });

  it("folds CMC gross into the headline netSalesUsd", () => {
    const raw = makeRaw({
      orders: [makeOrder({ totals: { total: 50, subtotal: 50, discount: 0, shipping: 0, currency: "USD" } })],
      cmcSales: [makeCmcSale({ total: "111.00" })],
    });
    const m = computeWeeklyMetrics(raw);
    // OS net 50 + CMC gross 111 = 161
    expect(m.netSalesUsd).toBeCloseTo(161, 2);
  });

  it("attributes CMC sale to fulfilment_date day in the daily table", () => {
    const raw = makeRaw({
      cmcSales: [makeCmcSale({ total: "111.00", fulfilment_date: "2026-06-25", created_at: "2026-06-23T10:00:00.000Z" })],
    });
    const m = computeWeeklyMetrics(raw);
    const day = m.daily.find((d) => d.date === "2026-06-25");
    expect(day?.salesUsd).toBeCloseTo(111, 2);
  });

  it("falls back to created_at when fulfilment_date is null", () => {
    const raw = makeRaw({
      cmcSales: [makeCmcSale({ total: "55.50", fulfilment_date: null, created_at: "2026-06-24T08:00:00.000Z" })],
    });
    const m = computeWeeklyMetrics(raw);
    const day = m.daily.find((d) => d.date === "2026-06-24");
    expect(day?.salesUsd).toBeCloseTo(55.5, 2);
  });

  it("does not pollute byChannel when there are no CMC sales", () => {
    const raw = makeRaw({ orders: [makeOrder()] });
    const m = computeWeeklyMetrics(raw);
    const cmcChannel = m.byChannel.find((r) => r.label === "CMC POS");
    expect(cmcChannel).toBeUndefined();
  });

  it("includes cmcMetrics with correct formulas", () => {
    const raw = makeRaw({
      cmcSales: [makeCmcSale({ total: "111.00" })],
    });
    const m = computeWeeklyMetrics(raw);
    expect(m.cmcMetrics.saleCount).toBe(1);
    expect(m.cmcMetrics.grossSalesUsd).toBe(111);
    expect(m.cmcMetrics.commissionUsd).toBe(20);
    expect(m.cmcMetrics.commissionVatUsd).toBe(2.2);
    expect(m.cmcMetrics.payableUsd).toBe(22.2);
  });
});
