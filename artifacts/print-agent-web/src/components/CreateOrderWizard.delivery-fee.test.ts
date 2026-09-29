import { describe, expect, it } from "vitest";
import { calculateCityDeliveryFee } from "@/lib/cityDeliveryPricing";

describe("CreateOrderWizard city delivery pricing", () => {
  const chargedCity = {
    delivery_fee: "7.50",
    free_delivery_enabled: false,
    free_delivery_threshold: null,
    currency: "USD" as const,
  };
  const thresholdCity = {
    delivery_fee: "10",
    free_delivery_enabled: true,
    free_delivery_threshold: "50",
    currency: "USD" as const,
  };

  it("charges the configured standard fee", () => {
    expect(calculateCityDeliveryFee(chargedCity, 25, "USD")).toBe(7.5);
  });

  it.each([50, 75])("waives delivery at or beyond the threshold (%s)", (subtotal) => {
    expect(calculateCityDeliveryFee(thresholdCity, subtotal, "USD")).toBe(0);
  });

  it("restores the fee below the threshold", () => {
    expect(calculateCityDeliveryFee(thresholdCity, 49.99, "USD")).toBe(10);
  });

  it("refreshes for city and currency changes without retaining a stale fee", () => {
    expect(calculateCityDeliveryFee(chargedCity, 25, "USD")).toBe(7.5);
    expect(calculateCityDeliveryFee(null, 25, "USD")).toBe(0);
    expect(calculateCityDeliveryFee(chargedCity, 25, "AED")).toBe(0);
  });
});