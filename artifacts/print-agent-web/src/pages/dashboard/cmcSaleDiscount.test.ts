import { describe, it, expect } from "vitest";
import { computeSaleTotals, clampDiscountValue } from "./cmcSaleDiscount";

describe("computeSaleTotals", () => {
  it("returns no discount when the value is empty", () => {
    expect(computeSaleTotals(20, 30, "amount", "")).toEqual({
      subtotal: 50,
      discountAmount: 0,
      total: 50,
    });
  });

  it("treats invalid or negative values as no discount", () => {
    expect(computeSaleTotals(20, 30, "amount", "abc").total).toBe(50);
    expect(computeSaleTotals(20, 30, "percent", "-5").total).toBe(50);
    expect(computeSaleTotals(20, 30, "amount", "0").discountAmount).toBe(0);
  });

  it("applies a percentage discount to the combined subtotal", () => {
    const r = computeSaleTotals(20, 30, "percent", "10");
    expect(r.discountAmount).toBe(5); // 10% of $50, custom items included
    expect(r.total).toBe(45);
  });

  it("caps percentage at 100% so the total never goes negative", () => {
    const r = computeSaleTotals(20, 30, "percent", "150");
    expect(r.discountAmount).toBe(50);
    expect(r.total).toBe(0);
  });

  it("applies a fixed amount larger than the shelf subtotal but within the combined subtotal", () => {
    const r = computeSaleTotals(20, 30, "amount", "35");
    expect(r.discountAmount).toBe(35);
    expect(r.total).toBe(15);
  });

  it("caps a fixed amount at the combined subtotal", () => {
    const r = computeSaleTotals(20, 30, "amount", "80");
    expect(r.discountAmount).toBe(50);
    expect(r.total).toBe(0);
  });

  it("rounds percentage discounts to cents", () => {
    const r = computeSaleTotals(10.05, 0, "percent", "33");
    expect(r.discountAmount).toBe(3.32); // 3.3165 → 3.32
    expect(r.total).toBeCloseTo(6.73, 2);
  });
});

describe("clampDiscountValue", () => {
  it("clamps percent to 100 and amount to the subtotal", () => {
    expect(clampDiscountValue("percent", "120", 50)).toBe(100);
    expect(clampDiscountValue("percent", "15", 50)).toBe(15);
    expect(clampDiscountValue("amount", "80", 50)).toBe(50);
    expect(clampDiscountValue("amount", "20", 50)).toBe(20);
  });

  it("returns 0 for empty or invalid input", () => {
    expect(clampDiscountValue("amount", "", 50)).toBe(0);
    expect(clampDiscountValue("percent", "x", 50)).toBe(0);
  });
});
