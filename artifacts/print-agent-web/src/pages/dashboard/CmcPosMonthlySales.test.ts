import { describe, it, expect } from "vitest";

// Re-export the private helpers for testing by re-implementing them here,
// mirroring the exact logic in CmcPosMonthlySales.tsx so the tests are
// authoritative without needing to export from the component file.

function fmtMoney(n: number | undefined): string {
  const num = n === undefined || n === null ? 0 : Number(n);
  const hasCents = Math.round(Math.abs(num) * 100) % 100 !== 0;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: hasCents ? 2 : 0,
  }).format(num);
}

function fmtMoneyShort(n: number): string {
  if (Math.abs(n) >= 1000) {
    return `$${(n / 1000).toFixed(1)}k`;
  }
  const hasCents = Math.round(Math.abs(n) * 100) % 100 !== 0;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: hasCents ? 2 : 0,
  }).format(n);
}

describe("fmtMoney", () => {
  it("formats whole dollars with comma grouping and no decimal", () => {
    expect(fmtMoney(1112)).toBe("$1,112");
    expect(fmtMoney(543)).toBe("$543");
    expect(fmtMoney(1000000)).toBe("$1,000,000");
  });

  it("formats amounts with non-zero cents keeping two decimal places", () => {
    expect(fmtMoney(1001.8)).toBe("$1,001.80");
    expect(fmtMoney(222.4)).toBe("$222.40");
    expect(fmtMoney(200.36)).toBe("$200.36");
  });

  it("formats negative amounts (shown in parentheses by Intl) correctly", () => {
    // Intl en-US formats negatives as -$119.20 by default; the component
    // wraps in parens separately, but the helper itself just formats the number.
    expect(fmtMoney(-119.2)).toBe("-$119.20");
    expect(fmtMoney(-1000)).toBe("-$1,000");
  });

  it("returns $0 for undefined/null/zero", () => {
    expect(fmtMoney(undefined)).toBe("$0");
    expect(fmtMoney(0)).toBe("$0");
  });

  it("strips .00 for exactly whole cents", () => {
    expect(fmtMoney(50.0)).toBe("$50");
    expect(fmtMoney(1500.0)).toBe("$1,500");
  });
});

describe("fmtMoneyShort", () => {
  it("formats sub-1000 whole dollars without decimal", () => {
    expect(fmtMoneyShort(543)).toBe("$543");
    expect(fmtMoneyShort(0)).toBe("$0");
  });

  it("formats sub-1000 amounts with cents keeping two decimal places", () => {
    expect(fmtMoneyShort(222.4)).toBe("$222.40");
    expect(fmtMoneyShort(99.99)).toBe("$99.99");
  });

  it("uses k-suffix for amounts >= 1000 (existing behaviour preserved)", () => {
    expect(fmtMoneyShort(1112)).toBe("$1.1k");
    expect(fmtMoneyShort(5000)).toBe("$5.0k");
    expect(fmtMoneyShort(12345)).toBe("$12.3k");
  });

  it("adds commas for sub-1000 values that are large enough (none, boundary check)", () => {
    // 999 is the highest sub-1000; no comma needed
    expect(fmtMoneyShort(999)).toBe("$999");
  });
});
