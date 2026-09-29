export type DeliveryPricingCurrency = "USD" | "AED" | "EUR" | "GBP" | "SAR";

export type DeliveryPricingCity = {
  delivery_fee: string;
  free_delivery_enabled: boolean;
  free_delivery_threshold: string | null;
  currency: DeliveryPricingCurrency;
};

export function calculateCityDeliveryFee(
  city: DeliveryPricingCity | null,
  subtotal: number,
  currency: DeliveryPricingCurrency,
): number {
  if (!city || city.currency !== currency) return 0;
  const threshold =
    city.free_delivery_threshold == null ? null : Number(city.free_delivery_threshold);
  if (
    city.free_delivery_enabled &&
    threshold != null &&
    Number.isFinite(threshold) &&
    subtotal >= threshold
  ) {
    return 0;
  }
  const fee = Number(city.delivery_fee);
  return Number.isFinite(fee) && fee > 0 ? fee : 0;
}