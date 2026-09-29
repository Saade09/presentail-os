/**
 * Unit tests: paid-currency display conversion for the order detail page —
 * the implied per-order rate (paid_total ÷ USD total) used to show line
 * items and the subtotal in the currency the customer actually paid.
 */
import { describe, it, expect } from "vitest";
import {
  getPaidCurrencyConversion,
  convertToPaidCurrency,
  formatPaidCurrency,
  showsUsdApproximation,
  usdFallbackCurrencyLabel,
  getPaidOrderCurrency,
} from "./paidCurrencyDisplay";

describe("showsUsdApproximation", () => {
  it("shows the ≈ $ line for a genuine conversion rate", () => {
    expect(showsUsdApproximation({ currency: "AED", rate: 3.67 })).toBe(true);
    expect(showsUsdApproximation({ currency: "CHF", rate: 70 / 72 })).toBe(true);
  });

  it("suppresses the ≈ $ line when the rate is exactly 1 (bogus 1:1 mirror)", () => {
    expect(showsUsdApproximation({ currency: "AED", rate: 1 })).toBe(false);
  });
});

describe("usdFallbackCurrencyLabel", () => {
  it("keeps a USD label and an absent label", () => {
    expect(usdFallbackCurrencyLabel("USD")).toBe("USD");
    expect(usdFallbackCurrencyLabel("usd")).toBe("usd");
    expect(usdFallbackCurrencyLabel(undefined)).toBe("");
    expect(usdFallbackCurrencyLabel("")).toBe("");
  });

  it("corrects a non-USD stored label to USD (values are USD by construction)", () => {
    expect(usdFallbackCurrencyLabel("AED")).toBe("USD");
    expect(usdFallbackCurrencyLabel(" chf ")).toBe("USD");
  });
});

describe("getPaidCurrencyConversion", () => {
  it("returns the implied rate for a non-USD order", () => {
    const conversion = getPaidCurrencyConversion({
      totals: { total: 209, currency: "USD", paid_total: 785, paid_currency: "SAR" },
      payment_amount_usd: "209",
    });
    expect(conversion).not.toBeNull();
    expect(conversion?.currency).toBe("SAR");
    expect(conversion?.rate).toBeCloseTo(785 / 209, 10);
  });

  it("falls back to totals.total when payment_amount_usd is missing", () => {
    // GBP 55 on a USD 72 order: rate ≈ 0.764 (well outside the ±5% suppression band).
    const conversion = getPaidCurrencyConversion({
      totals: { total: 72, currency: "USD", paid_total: 55, paid_currency: "GBP" },
    });
    expect(conversion?.currency).toBe("GBP");
    expect(conversion?.rate).toBeCloseTo(55 / 72, 10);
  });

  it("returns null for USD orders", () => {
    expect(
      getPaidCurrencyConversion({
        totals: { total: 105, currency: "USD" },
        payment_amount_usd: 105,
      }),
    ).toBeNull();
    expect(
      getPaidCurrencyConversion({
        totals: { total: 105, paid_total: 105, paid_currency: "USD" },
        payment_amount_usd: 105,
      }),
    ).toBeNull();
  });

  it("returns null when the paid pair or USD total is unusable", () => {
    expect(getPaidCurrencyConversion({ totals: null })).toBeNull();
    expect(
      getPaidCurrencyConversion({
        totals: { paid_total: 785, paid_currency: "SAR" }, // no USD total anywhere
      }),
    ).toBeNull();
    expect(
      getPaidCurrencyConversion({
        totals: { total: 209, paid_total: 0, paid_currency: "SAR" },
      }),
    ).toBeNull();
    expect(
      getPaidCurrencyConversion({
        totals: { total: 0, paid_total: 785, paid_currency: "SAR" },
      }),
    ).toBeNull();
  });

  it("normalizes the currency code to uppercase", () => {
    const conversion = getPaidCurrencyConversion({
      totals: { total: 100, paid_total: 375, paid_currency: " sar " },
    });
    expect(conversion?.currency).toBe("SAR");
  });

  it("uses payment-row currency and equivalent amounts for legacy orders", () => {
    const conversion = getPaidCurrencyConversion({
      totals: { total: 70 },
      payment_currency: "sar",
      payment_amount: 150,
      payment_amount_usd: 40,
    });
    expect(conversion).toEqual({ currency: "SAR", rate: 3.75 });
  });

  it("prefers the commercial subtotal rate over a partial paid total", () => {
    const conversion = getPaidCurrencyConversion({
      totals: {
        subtotal: 70,
        paid_subtotal: 262.5,
        total: 70,
        paid_total: 75,
        paid_currency: "SAR",
      },
    });
    expect(conversion?.rate).toBe(3.75);
  });

  it("prefers a verified payment pair when totals and payment facts coexist", () => {
    const conversion = getPaidCurrencyConversion({
      totals: {
        subtotal: 70,
        paid_subtotal: 262.5,
        paid_currency: "SAR",
      },
      payment_currency: "AED",
      payment_amount: 367,
      payment_amount_usd: 100,
    });
    expect(conversion).toEqual({ currency: "AED", rate: 3.67 });
    expect(getPaidOrderCurrency({
      totals: { paid_currency: "SAR" },
      payment_currency: "AED",
    })).toBe("AED");
  });
});

describe("convertToPaidCurrency", () => {
  it("scales USD amounts by the implied rate", () => {
    const conversion = { currency: "SAR", rate: 785 / 209 };
    // Converting the full USD total reproduces the paid total exactly.
    expect(convertToPaidCurrency(209, conversion)).toBeCloseTo(785, 10);
    // A line item priced 29 USD scales proportionally.
    expect(convertToPaidCurrency(29, conversion)).toBeCloseTo(108.92, 2);
  });
});

describe("formatPaidCurrency", () => {
  it("formats known currencies with their symbol/code", () => {
    expect(formatPaidCurrency(785, "SAR")).toMatch(/785\.00/);
    expect(formatPaidCurrency(70, "CHF")).toMatch(/70\.00/);
  });

  it("falls back gracefully on an invalid currency code", () => {
    expect(formatPaidCurrency(10, "NOPE!")).toBe("10.00 NOPE!");
  });
});

describe("getPaidOrderCurrency", () => {
  it("returns the uppercase non-USD paid currency without requiring paid_total", () => {
    expect(getPaidOrderCurrency({ totals: { paid_currency: "eur" } })).toBe("EUR");
    expect(getPaidOrderCurrency({ totals: {}, payment_currency: "sar" })).toBe("SAR");
  });

  it("returns null for USD, missing, or blank paid currencies", () => {
    expect(getPaidOrderCurrency({ totals: { paid_currency: "USD" } })).toBeNull();
    expect(getPaidOrderCurrency({ totals: { paid_currency: "  " } })).toBeNull();
    expect(getPaidOrderCurrency({ totals: {} })).toBeNull();
    expect(getPaidOrderCurrency({ totals: null })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 1:1 suppression and near-parity currency handling
// ---------------------------------------------------------------------------

describe("getPaidCurrencyConversion — 1:1 suppression and near-parity handling", () => {
  it("suppresses when paid_total equals usd_total (rate = 1.0, the mislabeled 1:1 case)", () => {
    // AED 210 stored as the same number as USD 210: mislabeled order.
    expect(
      getPaidCurrencyConversion({
        totals: { total: 210, paid_total: 210, paid_currency: "AED" },
      }),
    ).toBeNull();
  });

  it("does NOT suppress near-parity EUR (rate ≈ 0.92 — valid, outside the 1:1 epsilon)", () => {
    // EUR 92 on USD 100: rate = 0.92 — a real European checkout.
    const conversion = getPaidCurrencyConversion({
      totals: { total: 100, paid_total: 92, paid_currency: "EUR" },
    });
    expect(conversion).not.toBeNull();
    expect(conversion?.currency).toBe("EUR");
    expect(conversion?.rate).toBeCloseTo(0.92, 5);
  });

  it("does NOT suppress near-parity CHF (rate ≈ 0.97 — valid, outside the 1:1 epsilon)", () => {
    // CHF 70 on USD 72: rate ≈ 0.972 — Swiss franc checkout.
    const conversion = getPaidCurrencyConversion({
      totals: { total: 72, paid_total: 70, paid_currency: "CHF" },
    });
    expect(conversion).not.toBeNull();
    expect(conversion?.currency).toBe("CHF");
    expect(conversion?.rate).toBeCloseTo(70 / 72, 5);
  });

  it("does NOT suppress SAR near-USD (rate ≈ 1.014) — only exact 1:1 is suppressed", () => {
    // SAR 212 on USD 209: rate ≈ 1.014 → no longer suppressed (only rate=1 is).
    const conversion = getPaidCurrencyConversion({
      totals: { total: 209, paid_total: 212, paid_currency: "SAR" },
    });
    expect(conversion).not.toBeNull();
    expect(conversion?.currency).toBe("SAR");
    expect(conversion?.rate).toBeCloseTo(212 / 209, 5);
  });

  it("does not suppress a genuine high-rate AED conversion", () => {
    // AED 770 on USD 209: rate ≈ 3.68 — genuine, not suppressed.
    const conversion = getPaidCurrencyConversion({
      totals: { total: 209, paid_total: 770, paid_currency: "AED" },
    });
    expect(conversion).not.toBeNull();
    expect(conversion?.currency).toBe("AED");
    expect(conversion?.rate).toBeCloseTo(770 / 209, 5);
  });
});

// ---------------------------------------------------------------------------
// formatPaidCurrency — currency-native decimal places
// ---------------------------------------------------------------------------

describe("formatPaidCurrency — currency-native decimal places", () => {
  it("formats JPY with zero decimal places (no fractional part)", () => {
    const formatted = formatPaidCurrency(16500, "JPY");
    // Intl.NumberFormat for JPY should produce no decimal point.
    expect(formatted).not.toMatch(/\./);
    expect(formatted).toMatch(/16[,.]?500/);
  });

  it("formats KWD with three decimal places", () => {
    const formatted = formatPaidCurrency(37, "KWD");
    // Three fractional digits for KWD.
    expect(formatted).toMatch(/37\.000/);
  });

  it("formats BHD with three decimal places", () => {
    const formatted = formatPaidCurrency(15.5, "BHD");
    expect(formatted).toMatch(/15\.500/);
  });

  it("formats SAR with two decimal places (unchanged from before)", () => {
    const formatted = formatPaidCurrency(785, "SAR");
    expect(formatted).toMatch(/785\.00/);
  });

  it("falls back gracefully on an invalid currency code (uses currencyDecimals default of 2)", () => {
    // Existing behaviour preserved.
    expect(formatPaidCurrency(10, "NOPE!")).toBe("10.00 NOPE!");
  });
});

