import { describe, expect, it } from "vitest";
import { currenciesCompatible, parseBankAmounts } from "./bankReconValidation";

describe("bank reconciliation source validation", () => {
  it("rejects malformed and dual-sided monetary strings", () => {
    expect(() => parseBankAmounts("1.2.3", null)).toThrow(/non-negative decimal/);
    expect(() => parseBankAmounts("10.00", "1.00")).toThrow(/both be positive/);
    expect(() => parseBankAmounts(null, "0.00")).toThrow(/exactly one positive/i);
    expect(() => parseBankAmounts("-1", null)).toThrow(/non-negative decimal/);
  });

  it("treats the company-currency journal sentinel and Lebanese aliases consistently", () => {
    expect(currenciesCompatible("Lebanese pound", "LBP")).toBe(true);
    expect(currenciesCompatible("ل.ل", "LBP")).toBe(true);
    expect(currenciesCompatible(null, "LBP")).toBe(false);
  });
});
