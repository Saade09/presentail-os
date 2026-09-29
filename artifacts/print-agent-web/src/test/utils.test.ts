import { describe, it, expect } from "vitest";
import { formatAED } from "@/lib/utils";

describe("formatAED", () => {
  it("formats a whole number", () => {
    expect(formatAED(100)).toBe("100 AED");
  });

  it("formats zero", () => {
    expect(formatAED(0)).toBe("0 AED");
  });

  it("rounds a decimal input to the nearest whole number", () => {
    expect(formatAED(49.7)).toBe("50 AED");
    expect(formatAED(49.4)).toBe("49 AED");
  });

  it("accepts a numeric string and formats it correctly", () => {
    expect(formatAED("75")).toBe("75 AED");
    expect(formatAED("12.9")).toBe("13 AED");
  });

  it("returns '—' for NaN input", () => {
    expect(formatAED(NaN)).toBe("—");
  });

  it("returns '—' for a non-numeric string", () => {
    expect(formatAED("invalid")).toBe("—");
  });

  it("returns '—' for a partial numeric string like '12abc'", () => {
    expect(formatAED("12abc")).toBe("—");
  });

  it("returns '—' for null", () => {
    expect(formatAED(null)).toBe("—");
  });

  it("returns '—' for undefined", () => {
    expect(formatAED(undefined)).toBe("—");
  });

  it("returns '—' for Infinity", () => {
    expect(formatAED(Infinity)).toBe("—");
  });

  it("formats a negative number", () => {
    expect(formatAED(-10)).toBe("-10 AED");
    expect(formatAED(-49.7)).toBe("-50 AED");
  });

  it("formats a very large number", () => {
    expect(formatAED(1000000)).toBe("1000000 AED");
    expect(formatAED(1_000_000_000)).toBe("1000000000 AED");
  });

  it("returns '—' for -Infinity", () => {
    expect(formatAED(-Infinity)).toBe("—");
  });

  it("returns '—' for an empty string", () => {
    expect(formatAED("")).toBe("—");
  });

  it("returns '—' for a whitespace-only string", () => {
    expect(formatAED("   ")).toBe("—");
  });
});
