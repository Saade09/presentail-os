import { describe, expect, it } from "vitest";
import {
  calculateCmcOrderDiscount,
  CmcOrderDiscountError,
} from "./cmcOrderDiscount";

describe("calculateCmcOrderDiscount", () => {
  it("calculates percentage discounts from the item subtotal", () => {
    expect(
      calculateCmcOrderDiscount(
        { type: "percent", value: 12.5, reason: "Customer goodwill" },
        80,
      ),
    ).toMatchObject({ amount: 10, currency: "USD", reason: "Customer goodwill" });
  });

  it("keeps fixed discounts at or below the item subtotal", () => {
    expect(
      calculateCmcOrderDiscount(
        { type: "amount", value: 35, reason: "Service recovery" },
        50,
      ),
    ).toMatchObject({ amount: 35, value: 35 });
    expect(() =>
      calculateCmcOrderDiscount(
        { type: "amount", value: 50.01, reason: "Service recovery" },
        50,
      ),
    ).toThrow(CmcOrderDiscountError);
  });

  it("requires a positive value, reason, and Other explanation", () => {
    expect(() =>
      calculateCmcOrderDiscount({ type: "percent", value: 0, reason: "Customer goodwill" }, 100),
    ).toThrow("greater than zero");
    expect(() =>
      calculateCmcOrderDiscount({ type: "percent", value: 101, reason: "Customer goodwill" }, 100),
    ).toThrow("cannot exceed 100%");
    expect(() =>
      calculateCmcOrderDiscount({ type: "amount", value: 5, reason: "Other" }, 100),
    ).toThrow("explanation is required");
  });
});