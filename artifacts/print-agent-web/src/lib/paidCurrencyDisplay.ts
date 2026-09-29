/**
 * Paid-currency display conversion for the order detail page.
 *
 * Line items and totals are stored in USD, but for orders paid in another
 * currency (totals.paid_total / totals.paid_currency) the page shows amounts
 * in the paid currency, converted with the order's implied rate:
 *
 *   rate = paid_total ÷ USD total
 *
 * No external exchange rates are involved — the conversion is exact for the
 * order total by construction and proportional for its parts.
 */

import { currencyDecimals } from "@workspace/money";

function toFiniteNumber(value: unknown): number | null {
  if (value == null) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export type PaidCurrencyConversion = {
  /** Uppercase ISO currency code the customer actually paid in (never USD). */
  currency: string;
  /** Implied per-order rate: paid_total ÷ USD total. */
  rate: number;
};

/**
 * Returns the paid-currency conversion for an order, or null when the order
 * was paid in USD (or lacks the data to convert) — in which case the page
 * renders plain USD amounts exactly as before.
 *
 * Suppression rules:
 *  - paid_currency is absent or equals USD → null (no conversion).
 *  - paid_total is missing or ≤ 0 → null.
 *  - USD total is missing or ≤ 0 → null.
 *  - rate ≈ 1 (within 5 %): the paid amounts are likely a mislabeled order
 *    where the USD figure was stored under a foreign currency code. Suppress
 *    rather than show a misleading near-1:1 display.
 */
export function getPaidCurrencyConversion(order: {
  totals: Record<string, unknown> | null;
  payment_amount?: string | number | null;
  payment_amount_usd?: string | number | null;
  payment_currency?: string | null;
}): PaidCurrencyConversion | null {
  const totals = order.totals ?? {};
  const paidCurrency =
    typeof order.payment_currency === "string" && order.payment_currency.trim() !== ""
      ? order.payment_currency.trim().toUpperCase()
      : typeof totals.paid_currency === "string" && totals.paid_currency.trim() !== ""
        ? totals.paid_currency.trim().toUpperCase()
        : null;
  if (!paidCurrency || paidCurrency === "USD") return null;

  const paidSubtotal = toFiniteNumber(totals.paid_subtotal);
  const usdSubtotal = toFiniteNumber(totals.subtotal);
  const paymentAmount = toFiniteNumber(order.payment_amount);
  const paymentAmountUsd = toFiniteNumber(order.payment_amount_usd);
  const paidTotal = toFiniteNumber(totals.paid_total);
  const usdTotal = toFiniteNumber(totals.total ?? totals.grand_total ?? totals.order_total);
  const rate =
    paymentAmount != null && paymentAmount > 0 && paymentAmountUsd != null && paymentAmountUsd > 0
        ? paymentAmount / paymentAmountUsd
        : paidSubtotal != null && paidSubtotal > 0 && usdSubtotal != null && usdSubtotal > 0
          ? paidSubtotal / usdSubtotal
          : paidTotal != null && paidTotal > 0 && usdTotal != null && usdTotal > 0
            ? paidTotal / usdTotal
            : null;
  if (rate == null) return null;

  // Only suppress a true 1:1 mirror — a sign the USD amount was mislabeled
  // as a foreign currency (e.g. "SAR 210" that is actually USD 210).
  // Near-parity currencies like EUR and CHF are legitimate and must NOT be
  // suppressed; their rate differs from 1 by a small but real amount.
  // We allow a float-precision epsilon (1e-9) to cover rounding artifacts.
  if (Math.abs(rate - 1) < 1e-9) return null;

  return { currency: paidCurrency, rate };
}

/**
 * Whether the "≈ $" USD approximation line should be shown for a conversion.
 * A rate of exactly 1 means the paid figure mirrors the USD figure (typically
 * a mislabeled ingest where the USD amount was paired with a foreign currency
 * code) — showing "AED 70.00 ≈ $70.00" would advertise a bogus 1:1 rate.
 */
export function showsUsdApproximation(
  conversion: PaidCurrencyConversion,
): boolean {
  return conversion.rate !== 1;
}

/**
 * Currency label safe to pair with the stored USD figures when the order has
 * no usable paid-currency conversion. Stored totals/line amounts are USD by
 * construction, so a non-USD stored label (a payload anomaly) must be
 * corrected to "USD" instead of relabeling USD numbers. An absent label stays
 * absent (callers render a bare number).
 */
export function usdFallbackCurrencyLabel(storedCurrency: unknown): string {
  const c = typeof storedCurrency === "string" ? storedCurrency.trim() : "";
  if (c === "") return "";
  return c.toUpperCase() === "USD" ? c : "USD";
}

/**
 * Uppercase non-USD currency the customer paid in (totals.paid_currency), or
 * null for USD/legacy orders. Unlike getPaidCurrencyConversion this does NOT
 * require a usable paid_total, so it can label per-line stored paid amounts
 * (paid_unit_price / paid_line_total) even when no implied rate exists.
 */
export function getPaidOrderCurrency(order: {
  totals: Record<string, unknown> | null;
  payment_currency?: string | null;
}): string | null {
  const totals = order.totals ?? {};
  const paidCurrency =
    typeof order.payment_currency === "string" && order.payment_currency.trim() !== ""
      ? order.payment_currency.trim().toUpperCase()
      : typeof totals.paid_currency === "string" && totals.paid_currency.trim() !== ""
        ? totals.paid_currency.trim().toUpperCase()
        : null;
  if (!paidCurrency || paidCurrency === "USD") return null;
  return paidCurrency;
}

/** Converts a USD amount into the paid currency using the implied rate. */
export function convertToPaidCurrency(
  usdAmount: number,
  conversion: PaidCurrencyConversion,
): number {
  return usdAmount * conversion.rate;
}

/**
 * Formats an amount in the given currency (e.g. "SAR 785.00").
 *
 * Uses the currency's ISO 4217 fractional-digit rule via Intl.NumberFormat —
 * zero-decimal currencies (JPY) show no fractional part; three-decimal
 * currencies (KWD, BHD, OMR) show three decimal places; most others show two.
 */
export function formatPaidCurrency(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      // Do NOT override minimumFractionDigits — let the currency's ISO 4217
      // rule apply (0 for JPY, 2 for most, 3 for KWD/BHD/OMR).
    }).format(amount);
  } catch {
    // Fallback for unrecognised currency codes: use the shared decimal rule.
    const decimals = currencyDecimals(currency);
    return `${amount.toFixed(decimals)} ${currency}`.trim();
  }
}
