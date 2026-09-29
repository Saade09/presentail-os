/**
 * Rate-based plausibility check for a paid (amount, currency) pair.
 *
 * The external storefront has repeatedly sent a mislabeled paid pair: the USD
 * figure paired with a foreign `currencyCode` (e.g. `totalAmount: 168,
 * currencyCode: "QAR"` on a USD 168 order that Stripe actually charged
 * QAR 630). When no Stripe payment-intent ref is available to correct it, the
 * mislabeled pair used to be stored verbatim, so emails/dashboard showed the
 * USD number labeled with the foreign currency.
 *
 * This module sanity-checks the claimed foreign amount against the USD amount
 * of the SAME charge using approximate reference exchange rates. The tolerance
 * is deliberately very generous (a multiplicative factor, not a percentage):
 * an earlier ±2% "near the USD figure" heuristic was removed because it
 * discarded genuine paid amounts that merely happened to be numerically close
 * to the USD total. Here a pair is only rejected when the implied rate is
 * wildly inconsistent with the reference rate — e.g. a claimed QAR amount
 * equal to the USD figure implies a rate of ~1.0 against a real (pegged) rate
 * of ~3.64, which is off by a factor of ~3.6 and cannot be a real charge.
 *
 * Fail-open by design: unknown currencies, missing USD reference amounts, or
 * non-positive inputs are treated as plausible — the guard must never discard
 * data it cannot actually judge.
 */

/**
 * Approximate USD → currency reference rates. Pegged currencies (GCC, JOD,
 * BHD…) are exact; free-floating ones are rough mid-2020s values. Staleness is
 * fine: the tolerance factor below absorbs multi-year drift. Do NOT use these
 * for conversion/display — plausibility judgement only.
 */
export const REFERENCE_USD_RATES: Record<string, number> = {
  AED: 3.6725,
  SAR: 3.75,
  QAR: 3.64,
  BHD: 0.376,
  OMR: 0.3845,
  KWD: 0.3066,
  JOD: 0.709,
  EUR: 0.92,
  GBP: 0.79,
  CHF: 0.88,
  CAD: 1.36,
  AUD: 1.52,
  NZD: 1.66,
  JPY: 150,
  SEK: 10.5,
  NOK: 10.7,
  DKK: 6.9,
  SGD: 1.34,
  HKD: 7.8,
  CNY: 7.2,
  INR: 84,
  PKR: 278,
  PHP: 57,
  THB: 35,
  MYR: 4.5,
  IDR: 15800,
  KRW: 1350,
  TRY: 34,
  EGP: 48,
  MXN: 18,
  BRL: 5.4,
  ZAR: 18,
  ILS: 3.7,
  PLN: 4.0,
  CZK: 23,
  HUF: 360,
  RON: 4.6,
  BGN: 1.8,
};

/**
 * How far the implied rate (paidAmount ÷ usdAmount) may deviate from the
 * reference rate, as a multiplicative factor in either direction, before the
 * pair is considered mislabeled. 2.5× is far beyond any real FX movement or
 * storefront markup/rounding, but comfortably catches the observed failure
 * mode (USD figure labeled as a ~3.6-pegged GCC currency → ~3.6× off).
 */
export const PAID_PAIR_TOLERANCE_FACTOR = 2.5;

export type PaidPairPlausibility = {
  plausible: boolean;
  /** paidAmount ÷ usdAmount, when both were usable. */
  impliedRate: number | null;
  /** Reference USD→currency rate, when known. */
  referenceRate: number | null;
};

/**
 * Judge whether `paidAmount` in `paidCurrency` is a plausible amount for a
 * charge whose USD value is `usdAmount`. Both figures must describe the SAME
 * charge (e.g. `payment.totalAmount` vs `payment.totalUsd`) — comparing a
 * partial/deposit payment against a full order total would misfire.
 */
export function checkPaidPairPlausibility(
  paidAmount: number | null | undefined,
  paidCurrency: string | null | undefined,
  usdAmount: number | null | undefined,
): PaidPairPlausibility {
  const code = typeof paidCurrency === "string" ? paidCurrency.trim().toUpperCase() : "";
  // Nothing to judge → plausible (fail open).
  if (
    !code ||
    code === "USD" ||
    typeof paidAmount !== "number" ||
    !Number.isFinite(paidAmount) ||
    paidAmount <= 0 ||
    typeof usdAmount !== "number" ||
    !Number.isFinite(usdAmount) ||
    usdAmount <= 0
  ) {
    return { plausible: true, impliedRate: null, referenceRate: null };
  }
  const referenceRate = REFERENCE_USD_RATES[code];
  const impliedRate = paidAmount / usdAmount;
  if (referenceRate == null) {
    // Unknown currency — cannot judge, fail open.
    return { plausible: true, impliedRate, referenceRate: null };
  }
  const plausible =
    impliedRate >= referenceRate / PAID_PAIR_TOLERANCE_FACTOR &&
    impliedRate <= referenceRate * PAID_PAIR_TOLERANCE_FACTOR;
  return { plausible, impliedRate, referenceRate };
}
