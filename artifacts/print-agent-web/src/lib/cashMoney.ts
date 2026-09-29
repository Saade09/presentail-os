/**
 * Shared money formatter for Cash Session screens.
 *
 * Rules:
 *  - null / undefined  → DASH (em-dash, "—")
 *  - LBP               → 0 decimal places, thousands separator, prefix  e.g. "LBP 125,000"
 *  - Other currencies  → 2 decimal places, thousands separator, prefix  e.g. "USD 53.00"
 *  - Actual zero       → formatted zero, never DASH                     e.g. "USD 0.00" / "LBP 0"
 *  - Negative zero     → normalised to positive zero
 *  - Positive values do NOT get a leading "+" unless opts.signed is true
 *  - Negative values use a proper minus sign "−" (U+2212), not a hyphen
 */

export const DASH = "—";

/** Currencies that display with zero decimal places. */
const ZERO_DECIMAL_CURRENCIES = new Set(["LBP"]);

/** Returns the number of fractional digits to display for the given currency. */
export function decimalPlaces(currency: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 0 : 2;
}

export type FormatCashMoneyOpts = {
  /**
   * If true, positive (non-zero) values are prefixed with "+".
   * Negative values always get "−" (U+2212).
   * Zero never gets a sign.
   */
  signed?: boolean;
};

/**
 * Format a cash amount for display.
 *
 * @param value    The numeric value (number, numeric string, null, or undefined).
 * @param currency ISO 4217 code used for: (a) decimal-place count, (b) prefix.
 *                 Omit only when you truly don't know the currency (falls back to 2 decimals, no prefix).
 * @param opts     Optional display flags.
 */
export function formatCashMoney(
  value: number | string | null | undefined,
  currency?: string,
  opts: FormatCashMoneyOpts = {},
): string {
  if (value == null || value === "") return DASH;

  const raw = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(raw)) return DASH;

  // Normalise negative zero → 0
  const n = raw === 0 ? 0 : raw;

  const digits = currency ? decimalPlaces(currency) : 2;
  const abs = Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });

  const currencyPrefix = currency ? `${currency} ` : "";

  if (n < 0) return `${currencyPrefix}−${abs}`;
  if (opts.signed && n > 0) return `${currencyPrefix}+${abs}`;
  return `${currencyPrefix}${abs}`;
}
