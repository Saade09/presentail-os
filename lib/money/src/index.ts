/**
 * Shared currency utility functions.
 *
 * Single source of truth for ISO 4217 minor-unit rules used by both the
 * ingest routes (server-side) and the paid-currency display layer (client-side).
 * Prevents future currency-rule drift between ingestion and display.
 */

/** Currencies charged in whole units (no minor-unit division). */
export const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA",
  "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF",
]);

/** Currencies that use 3 decimal places (1/1000 minor units). */
export const THREE_DECIMAL_CURRENCIES = new Set([
  "BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND",
]);

/**
 * Number of fractional digits a currency uses per ISO 4217 (0, 2, or 3).
 * Examples: JPY → 0, USD/EUR/SAR → 2, KWD/BHD/OMR → 3.
 */
export function currencyDecimals(currency: string): number {
  const upper = currency.toUpperCase();
  if (ZERO_DECIMAL_CURRENCIES.has(upper)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(upper)) return 3;
  return 2;
}

/**
 * Converts a Stripe minor-unit amount to major units for its currency.
 * Supports zero-decimal (JPY → 1:1), three-decimal (KWD → ÷1000), and
 * standard two-decimal currencies (÷100).
 */
export function stripeMinorToMajor(amount: number, currency: string): number {
  const upper = currency.toUpperCase();
  if (ZERO_DECIMAL_CURRENCIES.has(upper)) return amount;
  if (THREE_DECIMAL_CURRENCIES.has(upper)) return Math.round(amount) / 1000;
  return Math.round(amount) / 100;
}

/**
 * Converts a major-unit amount to Stripe minor units for its currency.
 * Respects zero-decimal currencies (JPY, KRW, …) which have no fractional part.
 */
export function stripeMajorToMinor(amount: number, currency: string): number {
  const upper = currency.toUpperCase();
  if (ZERO_DECIMAL_CURRENCIES.has(upper)) return Math.round(amount);
  if (THREE_DECIMAL_CURRENCIES.has(upper)) return Math.round(amount * 1000);
  return Math.round(amount * 100);
}

/**
 * Round a monetary amount to the correct decimal precision for the given
 * currency, using integer arithmetic to avoid floating-point drift.
 */
export function applyRounding(amount: number, currency: string): number {
  const decimals = currencyDecimals(currency);
  const factor = Math.pow(10, decimals);
  return Math.round(amount * factor) / factor;
}

/**
 * Compute `paid_line_total = paid_unit_price × quantity` using integer
 * minor-unit arithmetic to avoid floating-point errors (e.g. 55.1 × 2 =
 * 110.20000000000001 in IEEE 754). Returns a decimal string ready for DB
 * storage (e.g. "110.00" for SAR, "11000" for JPY, "55.500" for KWD).
 *
 * @param unitPrice  Major-unit paid unit price (e.g. 55.5 SAR)
 * @param quantity   Item quantity (positive integer)
 * @param currency   ISO 4217 currency code (determines decimal places)
 */
export function computeLineTotal(
  unitPrice: number,
  quantity: number,
  currency: string,
): string {
  const decimals = currencyDecimals(currency);
  const factor = Math.pow(10, decimals);
  const minorUnit = Math.round(unitPrice * factor);
  const totalMinor = minorUnit * quantity;
  if (decimals === 0) return String(totalMinor);
  return (totalMinor / factor).toFixed(decimals);
}
