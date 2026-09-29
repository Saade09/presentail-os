import { describe, it, expect } from "vitest";
import {
  calculateTotersRevenue,
  displayRevenue,
  sumRevenueStrings,
  roundDisplay,
  normalizeTotersCode,
  normalizeTotersStatus,
  buildTotersFingerprint,
  parseTotersTimestamp,
  parseItemsTotal,
  mapTotersHeader,
  parseTotersRows,
  dedupeWithinFile,
  TOTERS_REVENUE_STATUS,
} from "./toters";

const HEADER = [
  "Code",
  "Client First Name",
  "Store",
  "status",
  "Order Time",
  "Delivery Time",
  "Arrived Time",
  "Approved On",
  "Marked As Ready Time",
  "Preparation Time",
  "Preparation Performance",
  "Items Total",
  "applied_promos",
  "applicable_vouchers",
];

function row(over: Partial<Record<string, unknown>> = {}): unknown[] {
  const base: Record<string, unknown> = {
    Code: "ABC-1",
    "Client First Name": "Rana",
    Store: "Presentail Achrafieh",
    status: "arrived",
    "Order Time": "2026-08-01 10:00:00",
    "Delivery Time": "2026-08-01 11:00:00",
    "Arrived Time": "2026-08-01 11:05:00",
    "Approved On": "2026-08-01 10:01:00",
    "Marked As Ready Time": "2026-08-01 10:30:00",
    "Preparation Time": "29",
    "Preparation Performance": "on_time",
    "Items Total": "4,200.00",
    applied_promos: "",
    applicable_vouchers: "",
    ...over,
  };
  return HEADER.map((h) => base[h]);
}

describe("calculateTotersRevenue", () => {
  it("converts 4,200.00 to the documented full-precision USD value", () => {
    // 4200 × 1500 ÷ 89700 = 70.23411371237458...
    const revenue = calculateTotersRevenue(4200);
    expect(revenue).toBe("70.23411371");
    expect(displayRevenue(revenue)).toBe(70.23);
  });

  it("stores full precision and only rounds for display", () => {
    const revenue = calculateTotersRevenue(100);
    // 100 × 1500 / 89700 = 1.67224080...
    expect(revenue).toBe("1.67224080");
    expect(displayRevenue(revenue)).toBe(1.67);
  });

  it("handles zero and fractional items totals", () => {
    expect(calculateTotersRevenue(0)).toBe("0.00000000");
    expect(displayRevenue(calculateTotersRevenue(0.01))).toBe(0);
  });
});

describe("aggregate-then-round", () => {
  it("matches the documented 394-order validation file: sum 1,257,151.19 → $21,022.60", () => {
    // Synthesized fixture equivalent to the real export: 394 arrived orders
    // whose raw Items Total sums to exactly 1,257,151.19.
    const itemsTotals = [...Array(393).fill(3190.74), 3190.37];
    const rawSum = itemsTotals.reduce((s, v) => s + v, 0);
    expect(Math.round(rawSum * 100) / 100).toBe(1_257_151.19);

    const perOrder = itemsTotals.map((v) => calculateTotersRevenue(v));
    const total = sumRevenueStrings(perOrder);
    expect(displayRevenue(total)).toBe(21_022.6);
  });

  it("sums unrounded values then rounds once (not per-order rounding)", () => {
    // Two orders of 0.30 each: per-order revenue 0.00501672...
    // Rounding each first would give 0.01 + 0.01 = 0.02; correct answer 0.01.
    const perOrder = [calculateTotersRevenue(0.3), calculateTotersRevenue(0.3)];
    const perOrderRounded = perOrder.map((r) => displayRevenue(r));
    expect(perOrderRounded).toEqual([0.01, 0.01]);
    expect(displayRevenue(sumRevenueStrings(perOrder))).toBe(0.01);
  });

  it("roundDisplay rounds half-up at 2 decimals", () => {
    expect(roundDisplay(70.234113)).toBe(70.23);
    expect(roundDisplay(70.235)).toBe(70.24);
  });
});

describe("normalization + fingerprint", () => {
  it("normalizes codes with trim and case", () => {
    expect(normalizeTotersCode("  abc-1 ")).toBe("ABC-1");
    expect(normalizeTotersCode("ABC-1")).toBe("ABC-1");
    expect(normalizeTotersCode("")).toBeNull();
    expect(normalizeTotersCode(null)).toBeNull();
  });

  it("normalizes statuses", () => {
    expect(normalizeTotersStatus(" Arrived ")).toBe("arrived");
    expect(normalizeTotersStatus("CANCELED")).toBe("canceled");
  });

  it("derives the fingerprint from the code when present", () => {
    const fp = buildTotersFingerprint({
      code: "ABC-1",
      clientFirstName: "Rana",
      store: "S",
      orderTime: new Date("2026-08-01T10:00:00Z"),
      itemsTotal: 4200,
    });
    expect(fp).toBe("code:ABC-1");
  });

  it("falls back to a content hash when the code is missing", () => {
    const base = {
      code: null,
      clientFirstName: "Rana",
      store: "Presentail",
      orderTime: new Date("2026-08-01T10:00:00Z"),
      itemsTotal: 4200,
    };
    const fp1 = buildTotersFingerprint(base);
    const fp2 = buildTotersFingerprint({ ...base, clientFirstName: " RANA " });
    const fp3 = buildTotersFingerprint({ ...base, itemsTotal: 4200.01 });
    expect(fp1.startsWith("fp:")).toBe(true);
    expect(fp2).toBe(fp1); // case/whitespace-insensitive on names
    expect(fp3).not.toBe(fp1); // amount participates in identity
  });
});

describe("cell parsing", () => {
  it("parses timestamps from strings and Dates, treating naive values as UTC", () => {
    expect(parseTotersTimestamp("2026-08-01 10:00:00")?.toISOString()).toBe(
      "2026-08-01T10:00:00.000Z",
    );
    expect(parseTotersTimestamp(new Date("2026-08-01T10:00:00Z"))?.toISOString()).toBe(
      "2026-08-01T10:00:00.000Z",
    );
    expect(parseTotersTimestamp("")).toBeNull();
    expect(parseTotersTimestamp("not a date")).toBeNull();
  });

  it("parses items totals with thousands separators", () => {
    expect(parseItemsTotal("4,200.00")).toBe(4200);
    expect(parseItemsTotal(1257151.19)).toBe(1257151.19);
    expect(parseItemsTotal("abc")).toBeNull();
    expect(parseItemsTotal("")).toBeNull();
  });
});

describe("header mapping + row validation", () => {
  it("maps the documented Toters header set", () => {
    const { columns, missing } = mapTotersHeader(HEADER);
    expect(missing).toEqual([]);
    expect(columns.code).toBe(0);
    expect(columns.itemsTotal).toBe(11);
    expect(columns.approvedTime).toBe(7);
    expect(columns.markedReadyTime).toBe(8);
  });

  it("reports missing required columns", () => {
    const { missing } = mapTotersHeader(["Code", "status", "Items Total"]);
    expect(missing).toEqual(expect.arrayContaining(["Client First Name", "Store", "Order Time"]));
  });

  it("parses valid rows and rejects invalid ones with reasons", () => {
    const rows = [
      HEADER,
      row(),
      row({ Code: "abc-2", status: "canceled" }),
      row({ Code: "BAD-TOTAL", "Items Total": "oops" }),
      row({ Code: "NO-TIME", "Order Time": "" }),
      row({ Code: "", "Client First Name": "", Store: "" }),
      HEADER.map(() => ""), // blank row: skipped silently
    ];
    const { columns } = mapTotersHeader(rows[0]);
    const { parsed, invalid } = parseTotersRows(rows, columns);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].code).toBe("ABC-1");
    expect(parsed[0].status).toBe(TOTERS_REVENUE_STATUS);
    expect(parsed[0].calculatedRevenue).toBe("70.23411371");
    expect(parsed[1].status).toBe("canceled");
    expect(invalid).toEqual([
      { row: 4, reason: "invalid_items_total" },
      { row: 5, reason: "missing_order_time" },
      { row: 6, reason: "missing_code_and_identity" },
    ]);
  });

  it("keeps rows without a Code by fingerprinting them", () => {
    const rows = [HEADER, row({ Code: "" })];
    const { columns } = mapTotersHeader(rows[0]);
    const { parsed, invalid } = parseTotersRows(rows, columns);
    expect(invalid).toEqual([]);
    expect(parsed[0].code).toBeNull();
    expect(parsed[0].fingerprint.startsWith("fp:")).toBe(true);
  });

  it("detects in-file duplicates (first occurrence wins)", () => {
    const rows = [HEADER, row(), row({ "Items Total": "1.00" }), row({ Code: "abc-1 " })];
    const { columns } = mapTotersHeader(rows[0]);
    const { parsed } = parseTotersRows(rows, columns);
    const { unique, duplicates } = dedupeWithinFile(parsed);
    expect(unique).toHaveLength(1);
    expect(duplicates).toHaveLength(2);
    expect(unique[0].calculatedRevenue).toBe("70.23411371");
  });
});
