/**
 * Shared payment-provider currency constants.
 *
 * This is the single source of truth for supported and unsupported currency/provider lists.
 * Both the API server (artifacts/api-server/src/routes/paymentLinks.ts)
 * and the web frontend (artifacts/print-agent-web/src/pages/dashboard/PaymentLinks.tsx)
 * import from here so the two never drift apart.
 */

/**
 * All currency codes accepted by the payment system.
 */
export const SUPPORTED_CURRENCIES = [
  "USD", "EUR", "AED", "CAD", "QAR", "SAR", "GBP", "AUD", "CHF", "SEK", "DKK", "LBP",
  "KWD", "BHD", "OMR",
] as const;

export type SupportedCurrency = typeof SUPPORTED_CURRENCIES[number];

/**
 * All payment providers accepted by the payment system.
 */
export const SUPPORTED_PROVIDERS = ["stripe", "paypal", "mamo"] as const;

export type SupportedProvider = typeof SUPPORTED_PROVIDERS[number];

/**
 * Currencies not accepted by Stripe.
 *
 * LBP — Lebanese Pound; not accepted by Stripe for international checkout sessions.
 */
export const STRIPE_UNSUPPORTED_CURRENCIES: ReadonlySet<string> = new Set(["LBP"]);

/**
 * Currencies not accepted by PayPal.
 *
 * AED, QAR, SAR, KWD, BHD, OMR — Gulf currencies not in PayPal's settlement list
 * DKK                           — Danish Krone; excluded from PayPal cross-border transfers
 * LBP                           — Lebanese Pound; not accepted by PayPal
 */
export const PAYPAL_UNSUPPORTED_CURRENCIES: ReadonlySet<string> = new Set([
  "AED",
  "QAR",
  "SAR",
  "DKK",
  "LBP",
  "KWD",
  "BHD",
  "OMR",
]);

/**
 * Currencies not accepted by Mamo Pay.
 *
 * Mamo Pay is a UAE-native provider supporting Gulf and major international currencies.
 * CAD, AUD, CHF, SEK, DKK, LBP — not supported by Mamo's hosted checkout.
 */
export const MAMO_UNSUPPORTED_CURRENCIES: ReadonlySet<string> = new Set([
  "CAD",
  "AUD",
  "CHF",
  "SEK",
  "DKK",
  "LBP",
]);

/**
 * Currencies selectable for a workshop cash desk (cash drawer / session).
 *
 * This is intentionally a small, region-relevant subset (not the full
 * payment-provider list) and is the single source of truth shared by the
 * cash-drawer API routes (artifacts/api-server/src/routes/cashDrawers.ts,
 * cashSessions.ts) and the cash-desk frontend pages so the two never drift.
 *
 * LBP — Lebanese Pound; cash desks frequently hold LBP alongside USD.
 */
export const CASH_DESK_CURRENCIES = [
  "AED",
  "USD",
  "EUR",
  "GBP",
  "SAR",
  "LBP",
] as const;

export type CashDeskCurrency = typeof CASH_DESK_CURRENCIES[number];
