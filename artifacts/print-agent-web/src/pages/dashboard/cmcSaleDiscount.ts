export type DiscountType = "percent" | "amount";

export type SaleTotals = {
  subtotal: number;
  /** Computed discount in dollars, capped so the total never goes negative. */
  discountAmount: number;
  total: number;
};

/**
 * Compute the shelf-sale totals with an optional total-level discount.
 * The discount applies to the COMBINED subtotal (shelf + custom items).
 * - percent: capped at 100%
 * - amount: capped at the subtotal
 * An empty/zero/invalid value means no discount.
 */
export function computeSaleTotals(
  shelfSubtotal: number,
  customSubtotal: number,
  discountType: DiscountType,
  discountValueRaw: string,
): SaleTotals {
  const subtotal = shelfSubtotal + customSubtotal;
  const parsed = parseFloat(discountValueRaw);
  const value = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  let discountAmount = 0;
  if (value > 0) {
    if (discountType === "percent") {
      const pct = Math.min(value, 100);
      discountAmount = Math.round(subtotal * pct) / 100;
    } else {
      discountAmount = Math.min(value, subtotal);
    }
  }
  const total = Math.max(0, subtotal - discountAmount);
  return { subtotal, discountAmount, total };
}

/** Clamp the entered discount value to valid bounds for the given type. */
export function clampDiscountValue(
  discountType: DiscountType,
  discountValueRaw: string,
  subtotal: number,
): number {
  const parsed = parseFloat(discountValueRaw);
  const value = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  return discountType === "percent" ? Math.min(value, 100) : Math.min(value, subtotal);
}
