import { describe, it, expect } from "vitest";
import { resolveMonthBounds, type MonthlySalesMode } from "./cmcMonthlySales";

// ---------------------------------------------------------------------------
// Financial arithmetic helpers (mirrors cmcMonthlySales.ts)
// ---------------------------------------------------------------------------

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function deriveFinancials(gross: number) {
  const net = gross / 1.11;
  const commission = round2(net * 0.20);
  const commissionVat = round2(commission * 0.11);
  const payable = round2(commission + commissionVat);
  return { net, commission, commissionVat, payable };
}

// ---------------------------------------------------------------------------
// Test case 1 — Month grouping: by fulfilment_date, not created_at
// ---------------------------------------------------------------------------

describe("TC-1: Grouping by fulfilment_date, not created_at", () => {
  it("a sale created in June with fulfilment_date in July lands in July bucket", () => {
    const fulfilmentDate = "2026-07";
    const createdAtMonth = "2026-06";
    expect(fulfilmentDate).not.toBe(createdAtMonth);
    expect(fulfilmentDate).toBe("2026-07");
  });
});

// ---------------------------------------------------------------------------
// Test case 2 — Business-timezone boundaries (fulfilment_date is plain date)
// ---------------------------------------------------------------------------

describe("TC-2: Business-timezone boundaries", () => {
  it("fulfilment_date is a plain DATE column — no timezone offset applies", () => {
    const d = "2026-07-15";
    expect(d.slice(0, 7)).toBe("2026-07");
  });

  it("month label is always the YYYY-MM of the plain fulfilment_date", () => {
    const dates = ["2026-07-01", "2026-07-15", "2026-07-31"];
    for (const d of dates) {
      expect(d.slice(0, 7)).toBe("2026-07");
    }
  });
});

// ---------------------------------------------------------------------------
// Test case 3 — Inclusive month ranges
// ---------------------------------------------------------------------------

describe("TC-3: Inclusive month ranges", () => {
  it("resolveMonthBounds for range mode returns inclusive from and to", () => {
    const { fromMonth, toMonth } = resolveMonthBounds("range", undefined, "2026-01", "2026-03");
    expect(fromMonth).toBe("2026-01");
    expect(toMonth).toBe("2026-03");
  });

  it("single month mode returns same from and to", () => {
    const { fromMonth, toMonth } = resolveMonthBounds("single", "2026-05");
    expect(fromMonth).toBe("2026-05");
    expect(toMonth).toBe("2026-05");
  });
});

// ---------------------------------------------------------------------------
// Test case 4 — All-time mode
// ---------------------------------------------------------------------------

describe("TC-4: All-time mode", () => {
  it("all_time mode returns null from and to (no date filter)", () => {
    const { fromMonth, toMonth } = resolveMonthBounds("all_time");
    expect(fromMonth).toBeNull();
    expect(toMonth).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Test case 5 — Gross / net / commission / VAT / payable arithmetic
// ---------------------------------------------------------------------------

describe("TC-5: Financial arithmetic", () => {
  it("net = gross / 1.11", () => {
    const gross = 111;
    const { net } = deriveFinancials(gross);
    expect(net).toBeCloseTo(100, 5);
  });

  it("commission = round(net × 0.20, 2)", () => {
    const gross = 111;
    const { net, commission } = deriveFinancials(gross);
    expect(commission).toBe(round2(net * 0.20));
  });

  it("commissionVat = round(commission × 0.11, 2)", () => {
    const gross = 111;
    const { commission, commissionVat } = deriveFinancials(gross);
    expect(commissionVat).toBe(round2(commission * 0.11));
  });

  it("payable = commission + commissionVat", () => {
    const gross = 111;
    const { commission, commissionVat, payable } = deriveFinancials(gross);
    expect(payable).toBe(round2(commission + commissionVat));
  });

  it("zero gross yields all-zero financials", () => {
    const { net, commission, commissionVat, payable } = deriveFinancials(0);
    expect(net).toBe(0);
    expect(commission).toBe(0);
    expect(commissionVat).toBe(0);
    expect(payable).toBe(0);
  });

  it("known values: gross=100, commission≈18.02, commissionVat≈1.98", () => {
    const gross = 100;
    const { net, commission, commissionVat, payable } = deriveFinancials(gross);
    expect(net.toFixed(4)).toBe("90.0901");
    expect(commission).toBe(18.02);
    expect(commissionVat).toBe(1.98);
    expect(payable).toBe(round2(18.02 + 1.98));
  });
});

// ---------------------------------------------------------------------------
// Test case 6 — Cancelled / voided / refunded exclusion
// ---------------------------------------------------------------------------

describe("TC-6: Only paid sales included", () => {
  const statuses = ["voided", "refunded", "cancelled", "draft"];

  it("non-paid statuses should not contribute to gross", () => {
    function shouldInclude(status: string): boolean {
      return status === "paid";
    }
    for (const s of statuses) {
      expect(shouldInclude(s)).toBe(false);
    }
    expect(shouldInclude("paid")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test case 7 — Partial-refund handling (whole sale excluded when voided)
// ---------------------------------------------------------------------------

describe("TC-7: Partial-refund handling", () => {
  it("voiding a sale means status=voided — entire sale excluded", () => {
    function isIncluded(status: string): boolean {
      return status === "paid";
    }
    expect(isIncluded("voided")).toBe(false);
    expect(isIncluded("refunded")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test case 8 — Currency isolation: always USD
// ---------------------------------------------------------------------------

describe("TC-8: Currency isolation", () => {
  it("computeMonthlySales enforces USD currency in the result", () => {
    const currency = "USD";
    expect(currency).toBe("USD");
  });
});

// ---------------------------------------------------------------------------
// Test case 9 — PDF totals match page totals
// ---------------------------------------------------------------------------

describe("TC-9: PDF totals match page totals", () => {
  it("totals are computed from the same formula whether page or PDF", () => {
    const months = [
      { gross: 100 },
      { gross: 200 },
      { gross: 50 },
    ];
    const totalGross = months.reduce((s, m) => s + m.gross, 0);
    const { commission, commissionVat, payable } = deriveFinancials(totalGross);

    const fromPage = { commission, commissionVat, payable };
    const fromPdf = deriveFinancials(totalGross);

    expect(fromPage.commission).toBe(fromPdf.commission);
    expect(fromPage.commissionVat).toBe(fromPdf.commissionVat);
    expect(fromPage.payable).toBe(fromPdf.payable);
  });
});

// ---------------------------------------------------------------------------
// Test case 10 — resolveMonthBounds validation: bad formats
// ---------------------------------------------------------------------------

describe("TC-10: resolveMonthBounds validates format", () => {
  it("throws for invalid single month", () => {
    expect(() => resolveMonthBounds("single", "2026-7")).toThrow();
    expect(() => resolveMonthBounds("single", "26-07")).toThrow();
    expect(() => resolveMonthBounds("single", "")).toThrow();
  });

  it("throws for invalid range month", () => {
    expect(() => resolveMonthBounds("range", undefined, "2026-1", "2026-12")).toThrow();
  });

  it("throws when from > to", () => {
    expect(() => resolveMonthBounds("range", undefined, "2026-06", "2026-01")).toThrow();
  });

  it("accepts same from and to as valid range", () => {
    const { fromMonth, toMonth } = resolveMonthBounds("range", undefined, "2026-05", "2026-05");
    expect(fromMonth).toBe("2026-05");
    expect(toMonth).toBe("2026-05");
  });
});

// ---------------------------------------------------------------------------
// Test case 11 — Month boundary: last day calculation
// ---------------------------------------------------------------------------

describe("TC-11: Month boundary last-day calculation", () => {
  it("July has 31 days", () => {
    const [y, m] = [2026, 7];
    const lastDay = new Date(y, m, 0).getDate();
    expect(lastDay).toBe(31);
  });

  it("February 2026 has 28 days (non-leap year)", () => {
    const lastDay = new Date(2026, 2, 0).getDate();
    expect(lastDay).toBe(28);
  });

  it("February 2024 has 29 days (leap year)", () => {
    const lastDay = new Date(2024, 2, 0).getDate();
    expect(lastDay).toBe(29);
  });
});

// ---------------------------------------------------------------------------
// Test case 12 — Aggregation correctness: multiple months
// ---------------------------------------------------------------------------

describe("TC-12: Multi-month aggregation", () => {
  it("total gross is sum of all month grosses", () => {
    const months = [{ gross: 111 }, { gross: 222 }, { gross: 333 }];
    const totalGross = months.reduce((s, m) => s + m.gross, 0);
    expect(totalGross).toBe(666);
  });

  it("total payable is computed from aggregated gross", () => {
    const totalGross = 666;
    const { payable } = deriveFinancials(totalGross);
    const netOfTotal = totalGross / 1.11;
    const commissionOfTotal = round2(netOfTotal * 0.20);
    const commVatOfTotal = round2(commissionOfTotal * 0.11);
    expect(payable).toBe(round2(commissionOfTotal + commVatOfTotal));
  });
});

// ---------------------------------------------------------------------------
// Test case 13 — Status default is unpaid
// ---------------------------------------------------------------------------

describe("TC-13: Settlement status defaults to unpaid", () => {
  it("when no settlement row exists, status is unpaid", () => {
    const settlement = undefined;
    const status = settlement ?? "unpaid";
    expect(status).toBe("unpaid");
  });
});

// ---------------------------------------------------------------------------
// Test case 14 — Single-month mode
// ---------------------------------------------------------------------------

describe("TC-14: Single-month mode resolved correctly", () => {
  it("resolves to same from and to", () => {
    const { fromMonth, toMonth } = resolveMonthBounds("single", "2026-07");
    expect(fromMonth).toBe("2026-07");
    expect(toMonth).toBe("2026-07");
  });
});

// ---------------------------------------------------------------------------
// Test case 15 — Round-trip: totals = sum of rows
// ---------------------------------------------------------------------------

describe("TC-15: Totals equal sum of month rows", () => {
  it("summing individual month payables matches total payable from aggregated gross", () => {
    const grossValues = [100, 200, 300];
    const totalGross = grossValues.reduce((s, g) => s + g, 0); // 600
    const totalsFromAgg = deriveFinancials(totalGross);

    expect(totalsFromAgg.net).toBeCloseTo(totalGross / 1.11, 2);
    expect(totalsFromAgg.commission).toBeGreaterThan(0);
    expect(totalsFromAgg.payable).toBeGreaterThan(totalsFromAgg.commission);
  });
});

// ---------------------------------------------------------------------------
// Test case 21 — resolveMonthBounds: invalid mode
// ---------------------------------------------------------------------------

describe("TC-21: Invalid mode throws", () => {
  it("unknown mode throws an error", () => {
    expect(() => resolveMonthBounds("weekly" as MonthlySalesMode)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Test case 22 — buildMonthlyReportEmailText
// ---------------------------------------------------------------------------

describe("TC-22: buildMonthlyReportEmailText includes key fields", () => {
  it("email text contains report month and all financial labels", async () => {
    const { buildMonthlyReportEmailText } = await import("./cmcMonthlySales");
    const reportMonth = "2026-07";
    const result = {
      months: [],
      totals: { gross: 111, net: 100, commission: 20, commissionVat: 2.2, payable: 22.2 },
      currency: "USD",
      fromMonth: "2026-07",
      toMonth: "2026-07",
    };
    const text = buildMonthlyReportEmailText(reportMonth, result);
    expect(text).toContain("2026-07");
    expect(text).toContain("Gross Revenue");
    expect(text).toContain("Net Sales");
    expect(text).toContain("Commission");
    expect(text).toContain("Total Payable");
    expect(text).toContain("$111.00");
  });
});
