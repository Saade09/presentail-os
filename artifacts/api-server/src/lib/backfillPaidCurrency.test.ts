/**
 * Unit tests: backfillPaidCurrencyAmounts — the idempotent startup backfill
 * that repairs existing non-USD orders using raw_payload.payment.totalAmount /
 * currencyCode (writes the paid pair into orders.totals and pairs
 * order_payment.amount with its currency).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockDbQuery = vi.fn();

vi.mock("./db", () => ({
  db: { query: (...args: unknown[]) => mockDbQuery(...args) },
}));

vi.mock("./logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const mockVerifyStripeAmount = vi.fn();

vi.mock("./stripeAmountVerification", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./stripeAmountVerification")>();
  return {
    ...actual,
    verifyStripePaymentIntentAmount: (...args: unknown[]) => mockVerifyStripeAmount(...args),
  };
});

import {
  backfillPaidCurrencyAmounts,
  repairStripePaidAmounts,
  repairMislabeledPaidPairs,
} from "./backfillPaidCurrency";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_default");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("backfillPaidCurrencyAmounts", () => {
  it("does nothing when no candidate rows exist", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await backfillPaidCurrencyAmounts();

    expect(mockDbQuery).toHaveBeenCalledTimes(1);
    const selectSql = mockDbQuery.mock.calls[0]?.[0] as string;
    // The WHERE clause is what makes the backfill idempotent.
    expect(selectSql).toContain("upper(trim(p.currency)) <> 'USD'");
    expect(selectSql).toContain("jsonb_typeof(o.raw_payload->'payment'->'totalAmount') = 'number'");
    expect(selectSql).toContain("p.amount IS NULL OR o.totals->>'paid_currency' IS NULL");
  });

  it("writes the paid pair to totals and order_payment.amount for a CHF order", async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [
          {
            id: "order-1",
            payment_currency: "CHF",
            raw_payment: { totalAmount: 70, currencyCode: "CHF" },
          },
        ],
        rowCount: 1,
      })
      .mockResolvedValue({ rows: [], rowCount: 1 });

    await backfillPaidCurrencyAmounts();

    expect(mockDbQuery).toHaveBeenCalledTimes(3);

    const totalsUpdate = mockDbQuery.mock.calls[1];
    expect(totalsUpdate?.[0]).toContain("UPDATE orders");
    expect(totalsUpdate?.[0]).toContain("'paid_total'");
    expect(totalsUpdate?.[0]).toContain("'paid_currency'");
    expect(totalsUpdate?.[1]).toEqual(["order-1", 70, "CHF"]);

    const paymentUpdate = mockDbQuery.mock.calls[2];
    expect(paymentUpdate?.[0]).toContain("UPDATE order_payment SET amount = $2");
    expect(paymentUpdate?.[1]).toEqual(["order-1", 70]);
  });

  it("falls back to the stored payment currency when raw currencyCode is missing", async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [
          {
            id: "order-2",
            payment_currency: "gbp",
            raw_payment: { totalAmount: 55.5 },
          },
        ],
        rowCount: 1,
      })
      .mockResolvedValue({ rows: [], rowCount: 1 });

    await backfillPaidCurrencyAmounts();

    const totalsUpdate = mockDbQuery.mock.calls[1];
    expect(totalsUpdate?.[1]).toEqual(["order-2", 55.5, "GBP"]);
  });

  it("skips rows with a non-finite or negative paid amount", async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [
          { id: "bad-1", payment_currency: "EUR", raw_payment: { totalAmount: "abc" } },
          { id: "bad-2", payment_currency: "EUR", raw_payment: { totalAmount: -5 } },
        ],
        rowCount: 2,
      })
      .mockResolvedValue({ rows: [], rowCount: 1 });

    await backfillPaidCurrencyAmounts();

    // Only the SELECT ran — no UPDATEs for invalid amounts.
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
  });

  it("continues with remaining rows when one row fails", async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [
          { id: "order-a", payment_currency: "EUR", raw_payment: { totalAmount: 10, currencyCode: "EUR" } },
          { id: "order-b", payment_currency: "CAD", raw_payment: { totalAmount: 20, currencyCode: "CAD" } },
        ],
        rowCount: 2,
      })
      // order-a totals UPDATE fails
      .mockRejectedValueOnce(new Error("boom"))
      // order-b updates succeed
      .mockResolvedValue({ rows: [], rowCount: 1 });

    await backfillPaidCurrencyAmounts();

    const orderBTotals = mockDbQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("UPDATE orders") && c[1]?.[0] === "order-b",
    );
    expect(orderBTotals).toBeTruthy();
    expect(orderBTotals?.[1]).toEqual(["order-b", 20, "CAD"]);
  });

  it("swallows a failing candidate query without throwing", async () => {
    mockDbQuery.mockRejectedValueOnce(new Error("db down"));
    await expect(backfillPaidCurrencyAmounts()).resolves.toBeUndefined();
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
  });
});

describe("repairStripePaidAmounts", () => {
  const candidateRow = (overrides: Record<string, unknown> = {}) => ({
    id: "order-1",
    provider_ref: "pi_3Abc123",
    paid_total: "210",
    paid_currency: "SAR",
    ...overrides,
  });

  it("skips entirely when no Stripe keys are configured", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    vi.stubEnv("STRIPE_SECRET_KEY_UAE", "");

    await repairStripePaidAmounts();

    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("selects only unverified recent non-USD Stripe-intent orders", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await repairStripePaidAmounts();

    expect(mockDbQuery).toHaveBeenCalledTimes(1);
    const selectSql = mockDbQuery.mock.calls[0]?.[0] as string;
    expect(selectSql).toContain("p.provider_ref LIKE 'pi\\_%'");
    expect(selectSql).toContain("upper(trim(p.currency)) <> 'USD'");
    expect(selectSql).toContain("o.totals->>'stripe_verified' IS NULL");
    expect(selectSql).toContain("LIMIT $2");
  });

  it("corrects a mismatched order with the Stripe amount and marks it verified", async () => {
    // Stored SAR 210 (the wrong storefront figure), Stripe charged 785 SAR.
    mockDbQuery
      .mockResolvedValueOnce({ rows: [candidateRow()], rowCount: 1 })
      .mockResolvedValue({ rows: [], rowCount: 1 });
    mockVerifyStripeAmount.mockResolvedValue({ status: "ok", amount: 785, currency: "SAR" });

    await repairStripePaidAmounts();

    expect(mockVerifyStripeAmount).toHaveBeenCalledWith("pi_3Abc123");

    const totalsUpdate = mockDbQuery.mock.calls[1];
    expect(totalsUpdate?.[0]).toContain("UPDATE orders");
    expect(totalsUpdate?.[0]).toContain("'paid_total'");
    expect(totalsUpdate?.[0]).toContain("'stripe_verified'");
    expect(totalsUpdate?.[1]).toEqual(["order-1", 785, "SAR"]);

    const paymentUpdate = mockDbQuery.mock.calls[2];
    expect(paymentUpdate?.[0]).toContain(
      "UPDATE order_payment SET amount = $2, currency = $3",
    );
    expect(paymentUpdate?.[1]).toEqual(["order-1", 785, "SAR"]);
  });

  it("only marks verified (no correction) when the stored pair matches Stripe", async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [candidateRow({ paid_total: "785", paid_currency: "SAR" })],
        rowCount: 1,
      })
      .mockResolvedValue({ rows: [], rowCount: 1 });
    mockVerifyStripeAmount.mockResolvedValue({ status: "ok", amount: 785, currency: "SAR" });

    await repairStripePaidAmounts();

    // SELECT + one totals UPDATE (marker only), no order_payment UPDATE.
    expect(mockDbQuery).toHaveBeenCalledTimes(2);
    const markerUpdate = mockDbQuery.mock.calls[1];
    expect(markerUpdate?.[0]).toContain("'stripe_verified'");
    expect(markerUpdate?.[0]).not.toContain("'paid_total'");
    expect(markerUpdate?.[1]).toEqual(["order-1"]);
  });

  it("marks a definitively unknown intent as not_found so it is never re-queried", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [candidateRow()], rowCount: 1 })
      .mockResolvedValue({ rows: [], rowCount: 1 });
    mockVerifyStripeAmount.mockResolvedValue({ status: "not_found" });

    await repairStripePaidAmounts();

    expect(mockDbQuery).toHaveBeenCalledTimes(2);
    const markerUpdate = mockDbQuery.mock.calls[1];
    expect(markerUpdate?.[0]).toContain("'not_found'");
    expect(markerUpdate?.[1]).toEqual(["order-1"]);
  });

  it("leaves rows untouched on Stripe errors so they retry next startup", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [candidateRow()], rowCount: 1 })
      .mockResolvedValue({ rows: [], rowCount: 1 });
    mockVerifyStripeAmount.mockResolvedValue({ status: "error" });

    await repairStripePaidAmounts();

    // Only the SELECT ran — no marker, so the next startup retries.
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
  });

  it("continues with remaining rows when one row fails", async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [
          candidateRow({ id: "order-a", provider_ref: "pi_3AAA" }),
          candidateRow({ id: "order-b", provider_ref: "pi_3BBB" }),
        ],
        rowCount: 2,
      })
      // order-a totals UPDATE fails
      .mockRejectedValueOnce(new Error("boom"))
      // order-b updates succeed
      .mockResolvedValue({ rows: [], rowCount: 1 });
    mockVerifyStripeAmount.mockResolvedValue({ status: "ok", amount: 500, currency: "AED" });

    await repairStripePaidAmounts();

    const orderBUpdate = mockDbQuery.mock.calls.find(
      (c) =>
        typeof c[0] === "string" && c[0].includes("UPDATE orders") && c[1]?.[0] === "order-b",
    );
    expect(orderBUpdate).toBeTruthy();
    expect(orderBUpdate?.[1]).toEqual(["order-b", 500, "AED"]);
  });

  it("swallows a failing candidate query without throwing", async () => {
    mockDbQuery.mockRejectedValueOnce(new Error("db down"));
    await expect(repairStripePaidAmounts()).resolves.toBeUndefined();
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
    expect(mockVerifyStripeAmount).not.toHaveBeenCalled();
  });
});

describe("repairMislabeledPaidPairs", () => {
  /** The QAR 680-style bug row: totals carry the USD figure labeled QAR. */
  const mislabeledRow = (overrides: Record<string, unknown> = {}) => ({
    id: "order-qar-1",
    paid_total: "168",
    paid_currency: "QAR",
    usd_total: "168",
    paid_subtotal: null,
    paid_shipping: null,
    raw_payment: { totalUsd: 168 },
    has_paid_line_prices: false,
    provider_ref: null,
    amount_usd: "168",
    ...overrides,
  });

  it("selects only non-USD, unverified, unchecked paid pairs", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await repairMislabeledPaidPairs();

    expect(mockDbQuery).toHaveBeenCalledTimes(1);
    const selectSql = mockDbQuery.mock.calls[0]?.[0] as string;
    expect(selectSql).toContain("upper(trim(o.totals->>'paid_currency')) <> 'USD'");
    expect(selectSql).toContain("(o.totals->>'stripe_verified') IS DISTINCT FROM 'true'");
    expect(selectSql).toContain("o.totals->>'paid_pair_checked' IS NULL");
  });

  it("clears a mislabeled pair with no Stripe ref (the QAR 680 order shape)", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [mislabeledRow()], rowCount: 1 })
      .mockResolvedValue({ rows: [], rowCount: 1 });

    await repairMislabeledPaidPairs();

    expect(mockVerifyStripeAmount).not.toHaveBeenCalled();

    const paymentUpdate = mockDbQuery.mock.calls[1];
    expect(paymentUpdate?.[0]).toContain(
      "UPDATE order_payment SET currency = 'USD', amount = amount_usd",
    );
    expect(paymentUpdate?.[1]).toEqual(["order-qar-1"]);

    const lineItemUpdate = mockDbQuery.mock.calls[2];
    expect(lineItemUpdate?.[0]).toContain("SET paid_unit_price = NULL, paid_line_total = NULL");
    expect(lineItemUpdate?.[1]).toEqual(["order-qar-1"]);

    // Marker write is LAST so a partial failure retries next startup.
    const totalsUpdate = mockDbQuery.mock.calls[3];
    expect(totalsUpdate?.[0]).toContain("- 'paid_total' - 'paid_currency' - 'paid_subtotal' - 'paid_shipping'");
    expect(totalsUpdate?.[0]).toContain("'paid_pair_checked', 'cleared'");
    expect(totalsUpdate?.[1]).toEqual(["order-qar-1"]);
  });

  it("trusts a corroborated near-USD GCC pair (breakdown present) and only marks it checked", async () => {
    // AED 170 on USD 168 WITH a paid-currency breakdown — same corroboration
    // exemption as ingest: the pair must survive startup untouched.
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [
          mislabeledRow({
            id: "order-aed-corroborated",
            paid_total: "170",
            paid_currency: "AED",
            paid_subtotal: "152",
            paid_shipping: "18",
            raw_payment: { totalUsd: 168, subtotalAmount: 152, deliveryFeeAmount: 18 },
          }),
        ],
        rowCount: 1,
      })
      .mockResolvedValue({ rows: [], rowCount: 1 });

    await repairMislabeledPaidPairs();

    expect(mockVerifyStripeAmount).not.toHaveBeenCalled();
    expect(mockDbQuery).toHaveBeenCalledTimes(2);
    const markUpdate = mockDbQuery.mock.calls[1];
    expect(markUpdate?.[0]).toContain("'paid_pair_checked', true");
    expect(markUpdate?.[0]).not.toContain("- 'paid_total'");
    expect(markUpdate?.[1]).toEqual(["order-aed-corroborated"]);
  });

  it("trusts a pair corroborated only by stored line-item paid prices", async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [
          mislabeledRow({
            id: "order-lines-corroborated",
            paid_total: "170",
            paid_currency: "AED",
            has_paid_line_prices: true,
          }),
        ],
        rowCount: 1,
      })
      .mockResolvedValue({ rows: [], rowCount: 1 });

    await repairMislabeledPaidPairs();

    expect(mockDbQuery).toHaveBeenCalledTimes(2);
    expect(mockDbQuery.mock.calls[1]?.[0]).toContain("'paid_pair_checked', true");
  });

  it("corrects a mislabeled pair via Stripe when a payment intent ref exists", async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [mislabeledRow({ provider_ref: "pi_3Qar680" })],
        rowCount: 1,
      })
      .mockResolvedValue({ rows: [], rowCount: 1 });
    mockVerifyStripeAmount.mockResolvedValue({ status: "ok", amount: 630, currency: "QAR" });

    await repairMislabeledPaidPairs();

    expect(mockVerifyStripeAmount).toHaveBeenCalledWith("pi_3Qar680");

    const paymentUpdate = mockDbQuery.mock.calls[1];
    expect(paymentUpdate?.[0]).toContain("UPDATE order_payment SET amount = $2, currency = $3");
    expect(paymentUpdate?.[1]).toEqual(["order-qar-1", 630, "QAR"]);

    // Stale line-item paid prices came from the same mislabeled payload.
    const lineItemUpdate = mockDbQuery.mock.calls[2];
    expect(lineItemUpdate?.[0]).toContain("SET paid_unit_price = NULL, paid_line_total = NULL");

    // Marker write is LAST so a partial failure retries next startup.
    const totalsUpdate = mockDbQuery.mock.calls[3];
    expect(totalsUpdate?.[0]).toContain("'paid_total'");
    expect(totalsUpdate?.[0]).toContain("'stripe_verified'");
    expect(totalsUpdate?.[1]).toEqual(["order-qar-1", 630, "QAR"]);
  });

  it("marks a plausible pair checked without touching its amounts", async () => {
    // Genuine QAR 630 on a USD 168 charge (~the 3.64 peg).
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [mislabeledRow({ paid_total: "630" })],
        rowCount: 1,
      })
      .mockResolvedValue({ rows: [], rowCount: 1 });

    await repairMislabeledPaidPairs();

    expect(mockDbQuery).toHaveBeenCalledTimes(2);
    const markUpdate = mockDbQuery.mock.calls[1];
    expect(markUpdate?.[0]).toContain("'paid_pair_checked', true");
    expect(markUpdate?.[0]).not.toContain("paid_total");
  });

  it("leaves the row unmarked on a transient Stripe error so it retries next startup", async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [mislabeledRow({ provider_ref: "pi_3Qar680" })],
        rowCount: 1,
      })
      .mockResolvedValue({ rows: [], rowCount: 1 });
    mockVerifyStripeAmount.mockResolvedValue({ status: "error" });

    await repairMislabeledPaidPairs();

    expect(mockDbQuery).toHaveBeenCalledTimes(1); // select only
  });

  it("clears the pair when Stripe definitively does not know the intent", async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [mislabeledRow({ provider_ref: "pi_3Qar680" })],
        rowCount: 1,
      })
      .mockResolvedValue({ rows: [], rowCount: 1 });
    mockVerifyStripeAmount.mockResolvedValue({ status: "not_found" });

    await repairMislabeledPaidPairs();

    const totalsUpdate = mockDbQuery.mock.calls[3];
    expect(totalsUpdate?.[0]).toContain("'paid_pair_checked', 'cleared'");
  });

  it("continues with remaining rows when one row fails", async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [mislabeledRow({ id: "order-bad" }), mislabeledRow({ id: "order-good" })],
        rowCount: 2,
      })
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue({ rows: [], rowCount: 1 });

    await repairMislabeledPaidPairs();

    const goodCalls = mockDbQuery.mock.calls.filter((c) =>
      (c[1] as unknown[] | undefined)?.includes("order-good"),
    );
    expect(goodCalls.length).toBeGreaterThan(0);
  });

  it("swallows a failing candidate query without throwing", async () => {
    mockDbQuery.mockRejectedValueOnce(new Error("db down"));
    await expect(repairMislabeledPaidPairs()).resolves.toBeUndefined();
  });
});
