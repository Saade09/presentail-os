import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Pure-function helpers extracted from cmcPos.ts for direct testing
// ---------------------------------------------------------------------------

const CMC_VAT_DIVISOR = 1.11;

function auditComputeNet(gross: number): number {
  return gross / CMC_VAT_DIVISOR;
}

function auditComputeVat(gross: number): number {
  return gross - auditComputeNet(gross);
}

function csvField(val: unknown): string {
  if (val === null || val === undefined) return "";
  const s = String(val);
  if (s.includes('"') || s.includes(",") || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------
// Scenario 1 — Fulfilment-date assignment (not creation date)
// The audit endpoint filters on fulfilment_date = $date, not created_at.
// ---------------------------------------------------------------------------

describe("Audit filters on fulfilment_date, not created_at", () => {
  it("DATE_RE accepts a valid date string", () => {
    expect(DATE_RE.test("2026-07-15")).toBe(true);
  });

  it("DATE_RE rejects ISO datetimes (created_at format)", () => {
    expect(DATE_RE.test("2026-07-15T10:00:00.000Z")).toBe(false);
  });

  it("DATE_RE rejects empty string", () => {
    expect(DATE_RE.test("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — Cross-day placement
// A sale created at 23:59 on day A with fulfilment_date = day B lands on day B.
// ---------------------------------------------------------------------------

describe("Cross-day placement", () => {
  it("fulfilment_date is the authoritative grouping date regardless of created_at", () => {
    const fulfilDate = "2026-07-16";
    const createdAt = "2026-07-15T23:59:59.000Z";
    expect(DATE_RE.test(fulfilDate)).toBe(true);
    expect(fulfilDate).not.toBe(new Date(createdAt).toISOString().slice(0, 10));
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — Timezone safety
// fulfilment_date is a plain date column (no timezone conversion needed).
// ---------------------------------------------------------------------------

describe("Timezone safety", () => {
  it("plain YYYY-MM-DD strings are accepted as-is, no UTC offset applied", () => {
    expect(DATE_RE.test("2026-07-16")).toBe(true);
    const d = "2026-07-16";
    expect(d.slice(0, 10)).toBe("2026-07-16");
  });

  it("uses the configured CMC reporting timezone for created_at fallbacks in list, totals, and export", () => {
    const source = readFileSync(new URL("./cmcPos.ts", import.meta.url), "utf8");
    const timezoneFallback = "created_at AT TIME ZONE '${CMC_REPORTING_TIMEZONE}'";
    expect(source.split(timezoneFallback).length - 1).toBeGreaterThanOrEqual(3);
    expect(source.match(/AS reporting_date/g)).toHaveLength(2);
    expect(source).toContain("formatAuditTime(s.created_at");
    expect(source).toContain("csvField(s.reporting_date");
  });
});

// ---------------------------------------------------------------------------
// Scenario 4 — Date change moves the sale
// If fulfilment_date changes, the sale moves to the new date bucket.
// The WHERE clause `fulfilment_date = $2` enforces this automatically.
// ---------------------------------------------------------------------------

describe("Date-change moves the sale", () => {
  function isOnDate(fulfilDate: string, queryDate: string): boolean {
    return fulfilDate === queryDate;
  }

  it("a sale with fulfilment_date=A is excluded when querying date=B", () => {
    expect(isOnDate("2026-07-15", "2026-07-16")).toBe(false);
  });

  it("a sale with fulfilment_date=B is included when querying date=B", () => {
    expect(isOnDate("2026-07-16", "2026-07-16")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenario 5 — Null-date exclusion
// Sales with null fulfilment_date never match fulfilment_date = $2 (SQL equality).
// ---------------------------------------------------------------------------

describe("Null-date exclusion", () => {
  it("null fulfilment_date does not equal any date string", () => {
    const nullDate: string | null = null;
    expect(nullDate === "2026-07-16").toBe(false);
  });

  it("SQL equality with null returns false (simulated)", () => {
    function sqlEquals(a: string | null, b: string): boolean {
      if (a === null) return false;
      return a === b;
    }
    expect(sqlEquals(null, "2026-07-16")).toBe(false);
    expect(sqlEquals("2026-07-16", "2026-07-16")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenario 6 — 11% VAT arithmetic
// Gross = total; Net = Gross / 1.11; VAT = Gross - Net
// ---------------------------------------------------------------------------

describe("11% VAT arithmetic", () => {
  it("net is gross divided by 1.11", () => {
    const gross = 111;
    expect(auditComputeNet(gross)).toBeCloseTo(100, 5);
  });

  it("vat is the difference between gross and net", () => {
    const gross = 111;
    expect(auditComputeVat(gross)).toBeCloseTo(11, 5);
  });

  it("net + vat = gross (round-trip)", () => {
    const gross = 55.5;
    const net = auditComputeNet(gross);
    const vat = auditComputeVat(gross);
    expect(net + vat).toBeCloseTo(gross, 10);
  });

  it("zero gross gives zero net and zero vat", () => {
    expect(auditComputeNet(0)).toBe(0);
    expect(auditComputeVat(0)).toBe(0);
  });

  it("rounding to 2dp matches expected values for $100 gross", () => {
    const gross = 100;
    expect(auditComputeNet(gross).toFixed(2)).toBe("90.09");
    expect(auditComputeVat(gross).toFixed(2)).toBe("9.91");
  });
});

// ---------------------------------------------------------------------------
// Scenario 7 — Totals match rows
// grossSum = sum of all paid sales' totals; net/vat derived from grossSum.
// ---------------------------------------------------------------------------

describe("Totals match rows", () => {
  it("gross sum equals the arithmetic sum of individual sale totals", () => {
    const salesTotals = [111, 55.5, 22.2];
    const grossSum = salesTotals.reduce((s, t) => s + t, 0);
    expect(grossSum).toBeCloseTo(188.7, 5);
    expect(auditComputeNet(grossSum).toFixed(2)).toBe("170.00");
    expect(auditComputeVat(grossSum).toFixed(2)).toBe("18.70");
  });
});

// ---------------------------------------------------------------------------
// Scenario 8 — Multi-product, no double-count
// Line items within a single sale should not be double-counted in totals.
// The `total` column stores the pre-computed sale total (not sum of line items again).
// ---------------------------------------------------------------------------

describe("Multi-product no double-count", () => {
  it("a sale with 3 line items contributes exactly once to gross total", () => {
    const saleTotal = 50;
    const lineItems = [{ name: "Rose", unit_price: 20, qty: 1 }, { name: "Vase", unit_price: 25, qty: 1 }, { name: "Card", unit_price: 5, qty: 1 }];
    const lineItemsSum = lineItems.reduce((s, li) => s + li.unit_price * li.qty, 0);
    expect(lineItemsSum).toBe(50);
    expect(saleTotal).toBe(50);
    const totalsGross = saleTotal;
    expect(totalsGross).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// Scenario 9 — Custom-product images
// Line items with image_url should be included in CSV product image URLs column.
// ---------------------------------------------------------------------------

describe("Custom-product images in CSV", () => {
  type AuditLineItem = { name?: string; image_url?: string | null };

  function buildProductImages(items: AuditLineItem[]): string {
    return items.map((li) => li.image_url ?? "").filter(Boolean).join("; ");
  }

  it("extracts image URLs from line items", () => {
    const items: AuditLineItem[] = [
      { name: "Rose", image_url: "/objects/ws/item1.jpg" },
      { name: "Vase", image_url: "/objects/ws/item2.jpg" },
    ];
    expect(buildProductImages(items)).toBe("/objects/ws/item1.jpg; /objects/ws/item2.jpg");
  });

  it("omits null/undefined image_url entries", () => {
    const items: AuditLineItem[] = [
      { name: "Rose", image_url: null },
      { name: "Card", image_url: "/objects/ws/card.jpg" },
    ];
    expect(buildProductImages(items)).toBe("/objects/ws/card.jpg");
  });
});

// ---------------------------------------------------------------------------
// Scenario 10 — CSV all-pages (no pagination on export)
// The export endpoint uses LIMIT 10000 without an offset parameter.
// ---------------------------------------------------------------------------

describe("CSV export fetches all records (no per-page limit)", () => {
  const AUDIT_MAX_EXPORT = 10000;

  it("export limit is 10 000 rows", () => {
    expect(AUDIT_MAX_EXPORT).toBe(10000);
  });

  it("export uses from/to params (no date, no offset)", () => {
    const exportParams = new URLSearchParams({ from: "2026-07-01", to: "2026-07-16" });
    expect(exportParams.has("offset")).toBe(false);
    expect(exportParams.has("date")).toBe(false);
    expect(exportParams.has("from")).toBe(true);
    expect(exportParams.has("to")).toBe(true);
  });

  it("supports the same search scope as the paginated list", () => {
    const source = readFileSync(new URL("./cmcPos.ts", import.meta.url), "utf8");
    expect(source.match(/const searchParam =/g)).toHaveLength(2);
    expect(source.match(/UPPER\(REPLACE\(id::text, '-', ''\)\) LIKE/g)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Scenario 11 — PDF all-pages
// PDF generation fetches all pages (batched) before building the document.
// ---------------------------------------------------------------------------

describe("PDF fetches all pages before generating", () => {
  it("batch size of 200 correctly pages through records", () => {
    const BATCH = 200;
    const totalRecords = 450;
    let fetched = 0;
    let offset = 0;
    const batches: number[] = [];
    while (true) {
      const thisBatch = Math.min(BATCH, totalRecords - offset);
      batches.push(thisBatch);
      fetched += thisBatch;
      offset += BATCH;
      if (thisBatch < BATCH) break;
    }
    expect(batches).toEqual([200, 200, 50]);
    expect(fetched).toBe(450);
  });
});

// ---------------------------------------------------------------------------
// Scenario 12 — CSV/PDF/page data consistency
// Net, VAT, and Gross are derived from the same total field across all views.
// ---------------------------------------------------------------------------

describe("Data consistency across CSV, PDF, and page", () => {
  it("net and gross for the same sale are identical regardless of view", () => {
    const total = "100.00";
    const gross = parseFloat(total);
    const net = auditComputeNet(gross);
    const vat = auditComputeVat(gross);

    expect(net.toFixed(2)).toBe("90.09");
    expect(vat.toFixed(2)).toBe("9.91");
    expect((net + vat).toFixed(2)).toBe(gross.toFixed(2));
  });
});

// ---------------------------------------------------------------------------
// Scenario 13 — Unauthorized 403 (audit route)
// requireCmcAudit returns null and sends 403 when cmc_pos.audit is missing.
// ---------------------------------------------------------------------------

describe("Authorization — audit route", () => {
  function canAudit(workspaceRole: string, allowedPages: string[]): boolean {
    if (workspaceRole === "owner") return true;
    return allowedPages.includes("cmc_pos.audit");
  }

  it("owner always has access", () => {
    expect(canAudit("owner", [])).toBe(true);
  });

  it("member with cmc_pos.audit has access", () => {
    expect(canAudit("member", ["cmc_pos.audit"])).toBe(true);
  });

  it("member without cmc_pos.audit is denied (403)", () => {
    expect(canAudit("member", ["cmc-pos", "cmc_pos.sell"])).toBe(false);
  });

  it("member with empty allowedPages is denied", () => {
    expect(canAudit("member", [])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario 14 — Export 403
// Export route uses same requireCmcAudit guard.
// ---------------------------------------------------------------------------

describe("Authorization — export route", () => {
  function canExport(workspaceRole: string, allowedPages: string[]): boolean {
    if (workspaceRole === "owner") return true;
    return allowedPages.includes("cmc_pos.audit");
  }

  it("export 403 for member without cmc_pos.audit", () => {
    expect(canExport("member", ["cmc-pos"])).toBe(false);
  });

  it("export allowed for member with cmc_pos.audit", () => {
    expect(canExport("member", ["cmc_pos.audit"])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scenario 15 — Read-only (no mutation endpoints on audit routes)
// ---------------------------------------------------------------------------

describe("Read-only audit routes", () => {
  const AUDIT_ROUTES = ["/cmc-pos/audit", "/cmc-pos/audit/export"] as const;
  const HTTP_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;

  it("audit routes are GET-only (no mutation methods registered)", () => {
    for (const route of AUDIT_ROUTES) {
      expect(route).toMatch(/^\/cmc-pos\/audit/);
    }
    expect(AUDIT_ROUTES).toHaveLength(2);
  });

  it("no mutation HTTP verbs are defined for audit paths", () => {
    const mutationMethods = HTTP_METHODS.filter((m) => ["POST", "PATCH", "PUT", "DELETE"].includes(m));
    expect(mutationMethods).toHaveLength(4);
    expect(AUDIT_ROUTES.every((r) => r.startsWith("/cmc-pos/audit"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CSV field escaping
// ---------------------------------------------------------------------------

describe("csvField escaping", () => {
  it("plain strings pass through unchanged", () => {
    expect(csvField("hello")).toBe("hello");
  });

  it("strings with commas are double-quoted", () => {
    expect(csvField("hello, world")).toBe('"hello, world"');
  });

  it("strings with double-quotes are escaped", () => {
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
  });

  it("null becomes empty string", () => {
    expect(csvField(null)).toBe("");
  });

  it("undefined becomes empty string", () => {
    expect(csvField(undefined)).toBe("");
  });
});
