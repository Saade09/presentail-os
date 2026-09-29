import { describe, expect, it } from "vitest";
import { deleteCircuitBreaker } from "./merchantReconciliation";
import { evaluateMerchantEligibility, isPhaseOneMarket, merchantStockStatus } from "./merchantEligibility";

const context = { country: "LB", contentLanguage: "en", hasActiveVisiblePublishedPublication: true, countryExcluded: false, defaultCityExcluded: false };

describe("merchant Phase 1 eligibility", () => {
  it("requires an explicit supported country/language and records presence reasons", () => {
    expect(evaluateMerchantEligibility({ isArchived: false, merchantSyncDisabled: false }, context)).toEqual({ eligible: true, reasons: [] });
    expect(evaluateMerchantEligibility({ isArchived: true, merchantSyncDisabled: true }, { ...context, countryExcluded: true, defaultCityExcluded: true })).toEqual({
      eligible: false, reasons: ["archived", "merchant_disabled", "explicit_country_exclusion", "exact_default_city_exclusion"],
    });
    expect(evaluateMerchantEligibility({ isArchived: false, merchantSyncDisabled: false }, { ...context, contentLanguage: "ar" }).eligible).toBe(false);
    expect(isPhaseOneMarket("CY", "en")).toBe(false);
  });

  it("maps stock states without treating payload validity as absence", () => {
    expect(merchantStockStatus("available")).toBe("IN_STOCK");
    expect(merchantStockStatus("out_of_stock")).toBe("OUT_OF_STOCK");
    expect(merchantStockStatus("not_available")).toBe("OUT_OF_STOCK");
  });

  it("opens the delete circuit breaker over absolute or percentage limits", () => {
    expect(deleteCircuitBreaker(100, 200)).toMatch(/100/);
    expect(deleteCircuitBreaker(11, 100)).toMatch(/10%/);
    expect(deleteCircuitBreaker(9, 100)).toBeNull();
  });
});