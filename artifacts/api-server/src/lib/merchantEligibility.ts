/**
 * Phase 1 Merchant eligibility is deliberately independent from payload
 * validation: an invalid payload needs review, not deletion.
 */
export const PHASE_ONE_MARKETS = [{ country: "LB", contentLanguage: "en" }, { country: "AE", contentLanguage: "en" }] as const;
export type MerchantCountry = (typeof PHASE_ONE_MARKETS)[number]["country"];
export type MerchantContentLanguage = "en";
export type MerchantPresenceReason =
  | "archived"
  | "merchant_disabled"
  | "no_active_visible_published_publication"
  | "explicit_country_exclusion"
  | "exact_default_city_exclusion";

export interface EligibilityProduct {
  isArchived: boolean;
  merchantSyncDisabled: boolean | null;
}

export interface EligibilityContext {
  country: string;
  contentLanguage: string;
  hasActiveVisiblePublishedPublication: boolean;
  /** Explicit false row in product_country_availability. */
  countryExcluded: boolean;
  /** Explicit false availability for precisely this market's default city. */
  defaultCityExcluded: boolean;
}

export interface MerchantEligibility {
  eligible: boolean;
  reasons: MerchantPresenceReason[];
}

export function isPhaseOneMarket(country: string, contentLanguage: string): boolean {
  return PHASE_ONE_MARKETS.some((m) => m.country === country.toUpperCase() && m.contentLanguage === contentLanguage.toLowerCase());
}

/** Requires both country and language; there is intentionally no implicit LB. */
export function evaluateMerchantEligibility(product: EligibilityProduct, context: EligibilityContext): MerchantEligibility {
  if (!isPhaseOneMarket(context.country, context.contentLanguage)) {
    return { eligible: false, reasons: ["no_active_visible_published_publication"] };
  }
  const reasons: MerchantPresenceReason[] = [];
  if (product.isArchived) reasons.push("archived");
  if (product.merchantSyncDisabled === true) reasons.push("merchant_disabled");
  if (!context.hasActiveVisiblePublishedPublication) reasons.push("no_active_visible_published_publication");
  if (context.countryExcluded) reasons.push("explicit_country_exclusion");
  if (context.defaultCityExcluded) reasons.push("exact_default_city_exclusion");
  return { eligible: reasons.length === 0, reasons };
}

export function merchantStockStatus(status: string): "IN_STOCK" | "OUT_OF_STOCK" {
  return status === "available" ? "IN_STOCK" : "OUT_OF_STOCK";
}