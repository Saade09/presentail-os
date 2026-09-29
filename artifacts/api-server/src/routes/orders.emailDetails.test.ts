/**
 * Unit tests: lookupOrderEmailDetails — the amount line used by the customer
 * confirmation / staff new-order emails must state the currency the customer
 * actually paid (totals.paid_total + paid_currency) when present, and keep the
 * legacy USD formatting otherwise.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";

const mockDbQuery = vi.fn();
const mockClientQuery = vi.fn();
const mockClientRelease = vi.fn();
const mockDbConnect = vi.fn(async () => ({
  query: (...args: unknown[]) => mockClientQuery(...args),
  release: (...args: unknown[]) => mockClientRelease(...args),
}));

vi.mock("../lib/orderWhatsappNotify", () => ({
  notifyOrderStatusWhatsApp: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
    connect: () => mockDbConnect(),
  },
  withTransaction: async (_client: unknown, fn: () => Promise<unknown>) => fn(),
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  authed: (req: express.Request) => req,
}));

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
  workspace: (req: express.Request) => req,
  hasPageAccess: () => true,
}));

vi.mock("../lib/email", () => ({
  sendOrderStatusEmail: vi.fn(),
  ORDER_STATUS_EMAIL_STATUSES: new Set<string>(),
}));

vi.mock("../lib/catalogWebhook", () => ({
  fireWebhookEvent: vi.fn(),
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("@clerk/express", () => ({
  clerkClient: { users: { getUser: vi.fn() } },
}));

vi.mock("stripe", () => ({ default: class StripeMock {} }));

import { lookupOrderEmailDetails } from "./orders";

beforeEach(() => {
  vi.clearAllMocks();
  // Default: any query resolves empty (covers the line-items + products lookups).
  mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

function stubOrderTotals(
  totals: Record<string, unknown> | null,
  extra?: {
    requested_delivery_date?: string | null;
    delivery_address?: string | null;
    delivery_district?: string | null;
    delivery_city?: string | null;
    delivery_country?: string | null;
    delivery_instructions?: string | null;
    delivery_time_slot?: string | null;
    card_message?: string | null;
    card_from?: string | null;
    card_to?: string | null;
    payment_method?: string | null;
    payment_currency?: string | null;
    payment_amount?: string | null;
    coupon_discount_usd?: string | null;
    coupon_code?: string | null;
    customer_name?: string | null;
    customer_email?: string | null;
    customer_phone?: string | null;
    recipient_name?: string | null;
    recipient_phone?: string | null;
  },
): void {
  mockDbQuery.mockResolvedValueOnce({
    rows: [
      {
        totals,
        window_start: null,
        requested_delivery_date: extra?.requested_delivery_date ?? null,
        delivery_address: extra?.delivery_address ?? null,
        delivery_district: extra?.delivery_district ?? null,
        delivery_city: extra?.delivery_city ?? null,
        delivery_country: extra?.delivery_country ?? null,
        delivery_instructions: extra?.delivery_instructions ?? null,
        delivery_time_slot: extra?.delivery_time_slot ?? null,
        card_message: extra?.card_message ?? null,
        card_from: extra?.card_from ?? null,
        card_to: extra?.card_to ?? null,
        payment_method: extra?.payment_method ?? null,
        payment_currency: extra?.payment_currency ?? null,
        payment_amount: extra?.payment_amount ?? null,
        coupon_discount_usd: extra?.coupon_discount_usd ?? null,
        coupon_code: extra?.coupon_code ?? null,
        customer_name: extra?.customer_name ?? null,
        customer_email: extra?.customer_email ?? null,
        customer_phone: extra?.customer_phone ?? null,
        recipient_name: extra?.recipient_name ?? null,
        recipient_phone: extra?.recipient_phone ?? null,
      },
    ],
    rowCount: 1,
  });
}

describe("lookupOrderEmailDetails — amountPaidText currency", () => {
  it("uses the paid currency and paid amount when the paid pair is stored", async () => {
    stubOrderTotals({
      subtotal: 60,
      shipping: 12,
      total: 72,
      currency: "USD",
      paid_total: 70,
      paid_currency: "CHF",
    });

    const details = await lookupOrderEmailDetails("order-1", "owner_1");
    expect(details.amountPaidText).toBe("CHF 70.00");
  });

  it("keeps the USD total for orders without a paid pair (legacy/USD)", async () => {
    stubOrderTotals({ subtotal: 94, shipping: 11, total: 105, currency: "USD" });

    const details = await lookupOrderEmailDetails("order-2", "owner_1");
    expect(details.amountPaidText).toBe("$105.00");
  });

  it("falls back to the USD total when the paid pair is incomplete", async () => {
    // paid_total without a currency must not produce a mislabeled amount.
    stubOrderTotals({ total: 72, currency: "USD", paid_total: 70 });

    const details = await lookupOrderEmailDetails("order-3", "owner_1");
    expect(details.amountPaidText).toBe("$72.00");
  });

  it("returns null when no totals are stored", async () => {
    stubOrderTotals(null);

    const details = await lookupOrderEmailDetails("order-4", "owner_1");
    expect(details.amountPaidText).toBeNull();
  });
});

describe("lookupOrderEmailDetails — line-item priceText currency", () => {
  it("prefers the stored charged paid-currency line total when present", async () => {
    // USD total 15.5 paid as AED 57 → but the storefront charged AED 55 for
    // the item (rounded to the nearest 5); the stored value must win over the
    // implied-rate conversion.
    stubOrderTotals({
      subtotal: 14.44,
      shipping: 1.06,
      total: 15.5,
      currency: "USD",
      paid_total: 57,
      paid_currency: "AED",
    });
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        { name: "Rose Bouquet", quantity: "1", line_total: "14.44", unit_price: "14.44", paid_line_total: "55", image_url: null, product_id: null, sku: null },
      ],
      rowCount: 1,
    });

    const details = await lookupOrderEmailDetails("order-5a", "owner_1");
    expect(details.items[0].priceText).toBe("AED 55.00");
  });

  it("rounds the implied-rate conversion to the nearest 5 for legacy non-USD orders", async () => {
    // USD total 106 paid as AED 425 → implied rate 425/106; no stored paid
    // line totals, so amounts round to the nearest multiple of 5 to match the
    // storefront's 0/5/10 display rounding.
    stubOrderTotals({
      subtotal: 63,
      shipping: 43,
      total: 106,
      currency: "USD",
      paid_total: 425,
      paid_currency: "AED",
    });
    // Line items (no product_id/sku so the products image lookup is skipped).
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        { name: "Congrats Bundle", quantity: "1", line_total: "31", unit_price: "31", paid_line_total: null, image_url: null, product_id: null, sku: null },
        { name: "Gold Ring Balloon Bundle", quantity: "1", line_total: "32", unit_price: "32", paid_line_total: null, image_url: null, product_id: null, sku: null },
      ],
      rowCount: 2,
    });

    const details = await lookupOrderEmailDetails("order-5", "owner_1");
    const rate = 425 / 106;
    expect(details.items).toHaveLength(2);
    // 31 * rate ≈ 124.29 → 125; 32 * rate ≈ 128.30 → 130.
    expect(details.items[0].priceText).toBe(
      `AED ${(Math.round((31 * rate) / 5) * 5).toFixed(2)}`,
    );
    expect(details.items[1].priceText).toBe(
      `AED ${(Math.round((32 * rate) / 5) * 5).toFixed(2)}`,
    );
    expect(details.items[0].priceText).toBe("AED 125.00");
    expect(details.items[1].priceText).toBe("AED 130.00");
    expect(details.amountPaidText).toBe("AED 425.00");
    // No USD approximation anywhere in the item price texts.
    for (const item of details.items) {
      expect(item.priceText).not.toContain("≈");
      expect(item.priceText).not.toContain("$");
      expect(item.priceText).not.toContain("USD");
    }
  });

  it("keeps exact USD line totals for USD/legacy orders (no rounding)", async () => {
    stubOrderTotals({ subtotal: 94, shipping: 11, total: 105, currency: "USD" });
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        { name: "Widget", quantity: "2", line_total: "53", unit_price: "26.5", paid_line_total: null, image_url: null, product_id: null, sku: null },
      ],
      rowCount: 1,
    });

    const details = await lookupOrderEmailDetails("order-6", "owner_1");
    expect(details.items[0].priceText).toBe("$53.00");
    expect(details.items[0].priceText).not.toContain("≈");
  });

  it("ignores a stored paid line total for USD-paid orders", async () => {
    // No paid pair in totals → paidConversion is null; the stored USD line
    // total must be used untouched even if paid_line_total is populated.
    stubOrderTotals({ subtotal: 50, shipping: 0, total: 50, currency: "USD" });
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        { name: "Widget", quantity: "1", line_total: "50", unit_price: "50", paid_line_total: "50", image_url: null, product_id: null, sku: null },
      ],
      rowCount: 1,
    });

    const details = await lookupOrderEmailDetails("order-6a", "owner_1");
    expect(details.items[0].priceText).toBe("$50.00");
  });
});

describe("lookupOrderEmailDetails — pricing breakdown / method / card message", () => {
  it("maps persisted customer, recipient, delivery, and card context for staff notifications", async () => {
    stubOrderTotals(
      { subtotal: 79.99, shipping: 5, total: 84.99, currency: "USD" },
      {
        requested_delivery_date: "2026-06-10",
        delivery_address: "17 Bliss Street",
        delivery_district: "Hamra",
        delivery_city: "Beirut",
        delivery_country: "Lebanon",
        delivery_instructions: "Ring the doorbell twice",
        delivery_time_slot: "2:00 PM – 5:00 PM",
        card_message: "Happy birthday, Ahmad!",
        card_from: "Sarah",
        card_to: "Ahmad",
        customer_name: "Sarah Khalil",
        customer_email: "sarah@example.com",
        customer_phone: "+96170000001",
        recipient_name: "Ahmad Mansour",
        recipient_phone: "+96170000002",
      },
    );
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          name: "White Roses",
          quantity: "1",
          line_total: "79.99",
          unit_price: "79.99",
          paid_line_total: null,
          image_url: null,
          product_id: null,
          sku: null,
        },
      ],
      rowCount: 1,
    });

    const details = await lookupOrderEmailDetails("order-rich-details", "owner_1");

    expect(details).toMatchObject({
      customerName: "Sarah Khalil",
      customerEmail: "sarah@example.com",
      customerPhone: "+96170000001",
      recipientName: "Ahmad Mansour",
      recipientPhone: "+96170000002",
      deliveryAddress: "17 Bliss Street",
      deliveryDistrict: "Hamra",
      deliveryCity: "Beirut",
      deliveryCountry: "Lebanon",
      deliveryInstructions: "Ring the doorbell twice",
      deliveryDateText: "10 June 2026",
      deliveryTimeSlot: "2:00 PM – 5:00 PM",
      cardMessage: "Happy birthday, Ahmad!",
      cardFrom: "Sarah",
      cardTo: "Ahmad",
      amountPaidText: "$84.99",
    });
    expect(details.items).toEqual([
      expect.objectContaining({ name: "White Roses", quantity: 1, priceText: "$79.99" }),
    ]);
  });

  it("prefers stored charged subtotal/delivery fee for non-USD orders", async () => {
    // Website sent the exact charged amounts (paid_subtotal/paid_shipping);
    // they must win over any implied-rate conversion.
    stubOrderTotals(
      {
        subtotal: 63,
        shipping: 43,
        total: 106,
        currency: "USD",
        paid_total: 425,
        paid_currency: "AED",
        paid_subtotal: 250,
        paid_shipping: 175,
      },
      { card_message: "Happy birthday, Maya!", payment_method: "stripe" },
    );

    const details = await lookupOrderEmailDetails("order-7", "owner_1");
    expect(details.subtotalText).toBe("AED 250.00");
    expect(details.deliveryFeeText).toBe("AED 175.00");
    expect(details.amountPaidText).toBe("AED 425.00");
    expect(details.paymentMethodText).toBe("Stripe");
    expect(details.cardMessage).toBe("Happy birthday, Maya!");
  });

  it("shows a stored zero charged delivery fee as Free", async () => {
    stubOrderTotals({
      subtotal: 63,
      shipping: 5,
      total: 68,
      currency: "USD",
      paid_total: 250,
      paid_currency: "AED",
      paid_subtotal: 250,
      paid_shipping: 0,
    });

    const details = await lookupOrderEmailDetails("order-7a", "owner_1");
    expect(details.deliveryFeeText).toBe("Free");
  });

  it("rounds the implied-rate subtotal/delivery fee to the nearest 5 for legacy non-USD orders", async () => {
    // USD total 106 paid as AED 425 → implied rate 425/106. No stored charged
    // amounts, so the conversion rounds to the nearest 5 like line items:
    // 63 * rate ≈ 252.59 → 255; 43 * rate ≈ 172.41 → 170.
    stubOrderTotals(
      {
        subtotal: 63,
        shipping: 43,
        total: 106,
        currency: "USD",
        paid_total: 425,
        paid_currency: "AED",
      },
      { payment_method: "stripe" },
    );

    const details = await lookupOrderEmailDetails("order-7b", "owner_1");
    expect(details.subtotalText).toBe("AED 255.00");
    expect(details.deliveryFeeText).toBe("AED 170.00");
    expect(details.amountPaidText).toBe("AED 425.00");
    expect(details.subtotalText).not.toContain("≈");
    expect(details.deliveryFeeText).not.toContain("≈");
  });

  it("ignores stored charged amounts for USD-paid orders (no paid pair)", async () => {
    // No paid_total/paid_currency → paidConversion is null; the USD figures
    // are shown exactly even if paid_subtotal/paid_shipping are populated.
    stubOrderTotals({
      subtotal: 94,
      shipping: 11,
      total: 105,
      currency: "USD",
      paid_subtotal: 350,
      paid_shipping: 40,
    });

    const details = await lookupOrderEmailDetails("order-7c", "owner_1");
    expect(details.subtotalText).toBe("$94.00");
    expect(details.deliveryFeeText).toBe("$11.00");
  });

  it("keeps the USD subtotal/delivery fee for USD/legacy orders", async () => {
    stubOrderTotals(
      { subtotal: 94, shipping: 11, total: 105, currency: "USD" },
      { payment_method: "cash_on_delivery" },
    );

    const details = await lookupOrderEmailDetails("order-8", "owner_1");
    expect(details.subtotalText).toBe("$94.00");
    expect(details.deliveryFeeText).toBe("$11.00");
    expect(details.paymentMethodText).toBe("Cash on Delivery");
    expect(details.cardMessage).toBeNull();
  });

  it("shows a zero delivery fee as Free", async () => {
    stubOrderTotals({ subtotal: 50, shipping: 0, total: 50, currency: "USD" });

    const details = await lookupOrderEmailDetails("order-9", "owner_1");
    expect(details.deliveryFeeText).toBe("Free");
  });

  it("returns null breakdown fields when totals lack them", async () => {
    stubOrderTotals({ total: 72, currency: "USD" });

    const details = await lookupOrderEmailDetails("order-10", "owner_1");
    expect(details.subtotalText).toBeNull();
    expect(details.deliveryFeeText).toBeNull();
    expect(details.paymentMethodText).toBeNull();
    expect(details.cardMessage).toBeNull();
  });
});

describe("lookupOrderEmailDetails — stored paid data is trusted (no plausibility guard)", () => {
  it("shows AED amounts when the paid total is numerically close to the USD total (reported bug)", async () => {
    // The dashboard shows "AED 170.00" for this order (it renders
    // totals.paid_total/paid_currency verbatim). A previous ±2% implied-rate
    // heuristic discarded the paid pair here (170 / 168 ≈ 1.012), making the
    // emails show USD while the dashboard showed AED. The emails must agree
    // with the dashboard.
    stubOrderTotals({
      subtotal: 150,
      shipping: 18,
      total: 168,
      currency: "USD",
      paid_total: 170,
      paid_currency: "AED",
      paid_subtotal: 152,
      paid_shipping: 18,
    });
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          name: "Gift Box",
          quantity: "1",
          line_total: "150",
          unit_price: "150",
          paid_line_total: "152",
          image_url: null,
          product_id: null,
          sku: null,
        },
      ],
      rowCount: 1,
    });

    const details = await lookupOrderEmailDetails("order-aed-close", "owner_1");

    // Everything is stated in the paid currency — no USD anywhere.
    expect(details.amountPaidText).toBe("AED 170.00");
    expect(details.subtotalText).toBe("AED 152.00");
    expect(details.deliveryFeeText).toBe("AED 18.00");
    expect(details.items[0].priceText).toBe("AED 152.00");
    for (const text of [
      details.amountPaidText,
      details.subtotalText,
      details.deliveryFeeText,
      details.items[0].priceText,
    ]) {
      expect(text).not.toContain("USD");
    }
  });

  it("shows AED amounts even at an exactly 1:1 implied rate", async () => {
    // Even the pathological-looking 1.0 rate must be rendered as stored,
    // because the dashboard renders it as stored — the two must never diverge.
    stubOrderTotals({
      subtotal: 450,
      shipping: 50,
      total: 500,
      currency: "USD",
      paid_total: 500,
      paid_currency: "AED",
    });

    const details = await lookupOrderEmailDetails("order-1to1", "owner_1");
    expect(details.amountPaidText).toBe("AED 500.00");
    expect(details.amountPaidText).not.toContain("USD");
  });

  it("always renders the amount and currency as an atomic pair (never USD number + foreign label)", async () => {
    // The repaired QAR 680 shape: totals carry a genuine paid pair. The email
    // must take BOTH the number and the label from the pair — the USD figure
    // must never leak out under the paid-currency label.
    stubOrderTotals({
      subtotal: 150,
      shipping: 18,
      total: 168,
      currency: "USD",
      paid_total: 680,
      paid_currency: "QAR",
    });

    const details = await lookupOrderEmailDetails("order-qar-680", "owner_1");
    expect(details.amountPaidText).toBe("QAR 680.00");
    expect(details.amountPaidText).not.toContain("168");
    expect(details.amountPaidText).not.toContain("USD");
    expect(details.amountPaidText).not.toContain("$");
  });

  it("shows AED amounts for a normal AED order (rate ≈ 3.78)", async () => {
    stubOrderTotals({
      subtotal: 450,
      shipping: 50,
      total: 500,
      currency: "USD",
      paid_total: 1890,
      paid_currency: "AED",
    });

    const details = await lookupOrderEmailDetails("order-legit-aed", "owner_1");
    expect(details.amountPaidText).toBe("AED 1,890.00");
    expect(details.amountPaidText).not.toContain("USD");
  });

  it("keeps plain USD display for USD-only orders", async () => {
    stubOrderTotals({ subtotal: 150, shipping: 18, total: 168, currency: "USD" });
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        { name: "Gift Box", quantity: "1", line_total: "150", unit_price: "150", paid_line_total: null, image_url: null, product_id: null, sku: null },
      ],
      rowCount: 1,
    });

    const details = await lookupOrderEmailDetails("order-usd-only", "owner_1");
    expect(details.amountPaidText).toBe("$168.00");
    expect(details.subtotalText).toBe("$150.00");
    expect(details.deliveryFeeText).toBe("$18.00");
    expect(details.items[0].priceText).toBe("$150.00");
  });
});

describe("lookupOrderEmailDetails — non-USD payment currency without paid amounts (mislabel guard)", () => {
  it("labels everything USD when payment currency is AED but no paid amounts exist anywhere", async () => {
    // Reported bug (LB-2047 shape): payment.currencyCode arrived as AED but
    // neither totals.paid_* nor order_payment.amount hold a paid figure. The
    // stored USD numbers must NEVER be relabeled as AED.
    stubOrderTotals(
      { subtotal: 60, shipping: 10, total: 70, currency: "USD" },
      { payment_currency: "AED", payment_amount: null },
    );
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        { name: "Gift Box", quantity: "1", line_total: "60", unit_price: "60", paid_line_total: null, image_url: null, product_id: null, sku: null },
      ],
      rowCount: 1,
    });

    const details = await lookupOrderEmailDetails("order-mislabel-1", "owner_1");
    expect(details.amountPaidText).toBe("$70.00");
    expect(details.subtotalText).toBe("$60.00");
    expect(details.deliveryFeeText).toBe("$10.00");
    expect(details.items[0].priceText).toBe("$60.00");
    for (const text of [
      details.amountPaidText,
      details.subtotalText,
      details.deliveryFeeText,
      details.items[0].priceText,
    ]) {
      expect(text).not.toContain("AED");
    }
  });

  it("labels USD figures USD even when totals.currency itself is a foreign code without paid amounts", async () => {
    // Payload anomaly: totals.currency says AED but the stored figures are the
    // USD numbers and no paid pair exists — the label must be corrected to USD.
    stubOrderTotals({ subtotal: 60, shipping: 10, total: 70, currency: "AED" });
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        { name: "Gift Box", quantity: "1", line_total: "60", unit_price: "60", paid_line_total: null, image_url: null, product_id: null, sku: null },
      ],
      rowCount: 1,
    });

    const details = await lookupOrderEmailDetails("order-mislabel-2", "owner_1");
    expect(details.amountPaidText).toBe("$70.00");
    expect(details.subtotalText).toBe("$60.00");
    expect(details.deliveryFeeText).toBe("$10.00");
    expect(details.items[0].priceText).toBe("$60.00");
  });

  it("still uses the order_payment paid pair when a genuine amount exists there", async () => {
    // The order_payment fallback stays intact: currency AND amount present →
    // paid-currency display with the implied rate.
    stubOrderTotals(
      { subtotal: 60, shipping: 10, total: 70, currency: "USD" },
      { payment_currency: "AED", payment_amount: "265" },
    );

    const details = await lookupOrderEmailDetails("order-mislabel-3", "owner_1");
    expect(details.amountPaidText).toBe("AED 265.00");
  });
});

describe("lookupOrderEmailDetails — discountText", () => {
  it("renders the totals.discount as a negative amount with the coupon code", async () => {
    stubOrderTotals(
      { subtotal: 63.64, shipping: 31.82, discount: 60.46, total: 35, currency: "USD" },
      { coupon_code: "SAVE10" },
    );

    const details = await lookupOrderEmailDetails("order-11", "owner_1");
    expect(details.discountText).toBe("-$60.46 (SAVE10)");
  });

  it("converts the discount to the paid currency for non-USD orders", async () => {
    // USD total 35 paid as AED 128.5 → implied rate 128.5/35.
    stubOrderTotals(
      {
        subtotal: 63.64,
        shipping: 31.82,
        discount: 60.46,
        total: 35,
        currency: "USD",
        paid_total: 128.5,
        paid_currency: "AED",
      },
      { coupon_code: "WELCOME" },
    );

    const details = await lookupOrderEmailDetails("order-12", "owner_1");
    // Implied-rate conversions round to the nearest 5 (like the other
    // fallback amounts): 60.46 * (128.5/35) ≈ 221.97 → 220.
    expect(details.discountText).toBe("-AED 220.00 (WELCOME)");
  });

  it("falls back to the coupon-redemption ledger amount when totals.discount is absent", async () => {
    stubOrderTotals(
      { subtotal: 50, shipping: 10, total: 50, currency: "USD" },
      { coupon_discount_usd: "10.00", coupon_code: "TEN" },
    );

    const details = await lookupOrderEmailDetails("order-13", "owner_1");
    expect(details.discountText).toBe("-$10.00 (TEN)");
  });

  it("omits the coupon code suffix when no code is known", async () => {
    stubOrderTotals({ subtotal: 50, shipping: 10, discount: 5, total: 55, currency: "USD" });

    const details = await lookupOrderEmailDetails("order-14", "owner_1");
    expect(details.discountText).toBe("-$5.00");
  });

  it("returns null for zero or absent discounts", async () => {
    stubOrderTotals({ subtotal: 94, shipping: 11, discount: 0, total: 105, currency: "USD" });
    const zero = await lookupOrderEmailDetails("order-15", "owner_1");
    expect(zero.discountText).toBeNull();

    stubOrderTotals({ subtotal: 94, shipping: 11, total: 105, currency: "USD" });
    const absent = await lookupOrderEmailDetails("order-16", "owner_1");
    expect(absent.discountText).toBeNull();
  });
});
