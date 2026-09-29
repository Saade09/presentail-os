/**
 * Unit tests: checkPaidPairPlausibility — the broad rate-based guard that
 * catches the storefront's mislabeled paid pair (the USD figure paired with a
 * foreign currency code) without discarding genuine paid amounts.
 */
import { describe, it, expect } from "vitest";
import {
  checkPaidPairPlausibility,
  PAID_PAIR_TOLERANCE_FACTOR,
  REFERENCE_USD_RATES,
} from "./paidPairPlausibility";

describe("checkPaidPairPlausibility", () => {
  it("rejects the USD figure mislabeled as QAR (the observed bug shape)", () => {
    // Storefront sent totalAmount 168 + currencyCode QAR for a USD 168 order
    // that was actually charged ~QAR 630. Implied rate 1.0 vs the ~3.64 peg.
    const res = checkPaidPairPlausibility(168, "QAR", 168);
    expect(res.plausible).toBe(false);
    expect(res.impliedRate).toBeCloseTo(1);
    expect(res.referenceRate).toBe(REFERENCE_USD_RATES.QAR);
  });

  it("rejects the USD figure mislabeled as AED", () => {
    expect(checkPaidPairPlausibility(170, "AED", 168).plausible).toBe(false);
  });

  it("accepts a genuine QAR amount at the pegged rate", () => {
    // QAR 630 on a USD 168 charge — implied 3.75 vs peg 3.64.
    expect(checkPaidPairPlausibility(630, "QAR", 168).plausible).toBe(true);
  });

  it("accepts genuine near-USD amounts for currencies whose rate is near 1", () => {
    // EUR/GBP/CHF etc. genuinely produce paid amounts numerically close to
    // the USD figure — the removed ±2% near-equality heuristic wrongly
    // discarded these; the rate check must not.
    expect(checkPaidPairPlausibility(60, "EUR", 66).plausible).toBe(true);
    expect(checkPaidPairPlausibility(325, "GBP", 325).plausible).toBe(true);
    expect(checkPaidPairPlausibility(70, "CHF", 72).plausible).toBe(true);
    expect(checkPaidPairPlausibility(155, "AUD", 153).plausible).toBe(true);
  });

  it("tolerates large FX drift and storefront markup/rounding", () => {
    // Anything within the generous factor band passes — real FX moves and
    // storefront markups never approach the tolerance factor.
    const ref = REFERENCE_USD_RATES.AED;
    expect(
      checkPaidPairPlausibility(100 * ref * (PAID_PAIR_TOLERANCE_FACTOR * 0.9), "AED", 100)
        .plausible,
    ).toBe(true);
    expect(
      checkPaidPairPlausibility((100 * ref) / (PAID_PAIR_TOLERANCE_FACTOR * 0.9), "AED", 100)
        .plausible,
    ).toBe(true);
  });

  it("fails open for USD, unknown currencies, and missing/invalid inputs", () => {
    expect(checkPaidPairPlausibility(168, "USD", 168).plausible).toBe(true);
    expect(checkPaidPairPlausibility(168, "XXX", 168).plausible).toBe(true);
    expect(checkPaidPairPlausibility(168, "QAR", null).plausible).toBe(true);
    expect(checkPaidPairPlausibility(168, "QAR", 0).plausible).toBe(true);
    expect(checkPaidPairPlausibility(null, "QAR", 168).plausible).toBe(true);
    expect(checkPaidPairPlausibility(0, "QAR", 168).plausible).toBe(true);
    expect(checkPaidPairPlausibility(168, null, 168).plausible).toBe(true);
    expect(checkPaidPairPlausibility(Number.NaN, "QAR", 168).plausible).toBe(true);
  });

  it("rejects a zero-decimal-style mislabel for high-rate currencies", () => {
    // USD figure labeled JPY: implied 1 vs ~150.
    expect(checkPaidPairPlausibility(168, "JPY", 168).plausible).toBe(false);
  });
});
