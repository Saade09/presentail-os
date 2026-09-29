export type CmcOrderDiscountInput = {
  type: "percent" | "amount";
  value: number;
  reason: string;
  explanation?: string | null;
};

export type CmcOrderDiscount = CmcOrderDiscountInput & {
  amount: number;
  currency: string;
};

/** A validation error that routes can safely expose to the staff member. */
export class CmcOrderDiscountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CmcOrderDiscountError";
  }
}

const roundMoney = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

/**
 * Calculate a CMC new-order discount from the authoritative item subtotal.
 * Client-provided totals are intentionally never used here.
 */
export function calculateCmcOrderDiscount(
  input: CmcOrderDiscountInput,
  itemSubtotal: number,
  currency = "USD",
): CmcOrderDiscount {
  const subtotal = roundMoney(itemSubtotal);
  if (!Number.isFinite(subtotal) || subtotal < 0) {
    throw new CmcOrderDiscountError("Order item subtotal is invalid");
  }
  if (!Number.isFinite(input.value) || input.value <= 0) {
    throw new CmcOrderDiscountError("Discount value must be greater than zero");
  }
  const reason = input.reason.trim();
  if (!reason) {
    throw new CmcOrderDiscountError("A discount reason is required");
  }
  const explanation = input.explanation?.trim() || null;
  if (reason.toLowerCase() === "other" && !explanation) {
    throw new CmcOrderDiscountError("An explanation is required when the discount reason is Other");
  }

  let amount: number;
  if (input.type === "percent") {
    if (input.value > 100) {
      throw new CmcOrderDiscountError("Percentage discount cannot exceed 100%");
    }
    amount = roundMoney((subtotal * input.value) / 100);
  } else if (input.type === "amount") {
    if (input.value > subtotal) {
      throw new CmcOrderDiscountError("Discount cannot exceed the item subtotal");
    }
    amount = roundMoney(input.value);
  } else {
    throw new CmcOrderDiscountError("Discount type must be percent or amount");
  }

  return {
    type: input.type,
    value: roundMoney(input.value),
    reason,
    explanation,
    amount: Math.min(amount, subtotal),
    currency: currency.trim().toUpperCase() || "USD",
  };
}