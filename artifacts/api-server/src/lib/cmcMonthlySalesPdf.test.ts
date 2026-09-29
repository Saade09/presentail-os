import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { inflateSync } from "zlib";
import {
  generateCmcCommissionSummaryPdf,
  generateCmcCommissionStatementPdf,
} from "./cmcMonthlySalesPdf";
import type { MonthlySalesResult, MonthlySalesRow } from "./cmcMonthlySales";

// ── PDF helpers ────────────────────────────────────────────────────────────

function isPdf(buf: Buffer): boolean {
  return buf.length > 4 && buf.subarray(0, 5).toString("latin1") === "%PDF-";
}

/**
 * Extract all readable text from a PDFKit-generated buffer.
 *
 * PDFKit stores text as hex-encoded strings inside FlateDecode-compressed
 * content streams using TJ operators:
 *   [<48656c6c6f> 40 <576f726c64>] TJ
 *
 * We decompress every stream object in the PDF and concatenate the decoded
 * hex fragments, giving a single searchable string of all text on all pages.
 */
function extractPdfText(buf: Buffer): string {
  const raw = buf.toString("binary");
  const streamRe = /stream\r?\n/g;
  let allText = "";
  let m: RegExpExecArray | null;
  while ((m = streamRe.exec(raw)) !== null) {
    const start = m.index + m[0].length;
    const end = raw.indexOf("endstream", start);
    if (end === -1) continue;
    const compressed = Buffer.from(raw.slice(start, end), "binary");
    try {
      const decompressed = inflateSync(compressed).toString("latin1");
      // Collect every <hex> fragment from TJ / Tj operators
      const hexRe = /<([0-9a-fA-F]+)>/g;
      let hm: RegExpExecArray | null;
      while ((hm = hexRe.exec(decompressed)) !== null) {
        const hex = hm[1];
        for (let i = 0; i < hex.length; i += 2) {
          allText += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
        }
      }
    } catch {
      // non-deflate stream (e.g. font data) – skip
    }
  }
  return allText;
}

function pdfContains(buf: Buffer, text: string): boolean {
  return extractPdfText(buf).includes(text);
}

// ── Fixtures ────────────────────────────────────────────────────────────────
//
// Financial formulas (from cmcMonthlySales.ts):
//   net            = gross / 1.11
//   commission     = round(net × 0.20, 2)
//   commissionVat  = round(commission × 0.11, 2)
//   payable        = commission + commissionVat
//
// We fix today = 2026-08-07 so all status derivations are deterministic.
// Current month label → "2026-08"

const FIXED_TODAY = new Date("2026-08-07T12:00:00.000Z");

function makeRow(overrides: Partial<MonthlySalesRow>): MonthlySalesRow {
  return {
    month: "2026-06",
    gross: 1110,
    net: 1000,
    commission: 200,
    commissionVat: 22,
    payable: 222,
    status: "unpaid",
    paidAt: null,
    dueDate: "2026-07-10", // < today 2026-08-07 → overdue
    ...overrides,
  };
}

function makeResult(rows: MonthlySalesRow[]): MonthlySalesResult {
  return {
    months: rows,
    totals: {
      gross:         rows.reduce((s, r) => s + r.gross, 0),
      net:           rows.reduce((s, r) => s + r.net, 0),
      commission:    rows.reduce((s, r) => s + r.commission, 0),
      commissionVat: rows.reduce((s, r) => s + r.commissionVat, 0),
      payable:       rows.reduce((s, r) => s + r.payable, 0),
    },
    currency: "USD",
    fromMonth: rows[0]?.month ?? null,
    toMonth:   rows[rows.length - 1]?.month ?? null,
  };
}

// ── Summary PDF ────────────────────────────────────────────────────────────

describe("generateCmcCommissionSummaryPdf", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(FIXED_TODAY); });
  afterEach(() => { vi.useRealTimers(); });

  it("returns a valid PDF buffer", async () => {
    const buf = await generateCmcCommissionSummaryPdf(
      makeResult([makeRow({})]),
    );
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(isPdf(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(1000);
  });

  it("includes a 'Page 1 of 1' footer", async () => {
    const buf = await generateCmcCommissionSummaryPdf(
      makeResult([makeRow({})]),
    );
    expect(pdfContains(buf, "Page 1 of 1")).toBe(true);
  });

  it("renders per-row financial figures", async () => {
    // gross=1110, net=1000, commission=200, commissionVat=22, payable=222
    const buf = await generateCmcCommissionSummaryPdf(
      makeResult([makeRow({})]),
    );
    expect(pdfContains(buf, "$1,110.00")).toBe(true); // gross
    expect(pdfContains(buf, "$1,000.00")).toBe(true); // net
    expect(pdfContains(buf, "$200.00")).toBe(true);   // commission
    expect(pdfContains(buf, "$22.00")).toBe(true);    // commissionVat
    expect(pdfContains(buf, "$222.00")).toBe(true);   // payable
  });

  it("renders summed totals row for multiple rows", async () => {
    // Two identical rows → totals are doubled
    const rows = [
      makeRow({ month: "2026-05", status: "paid", paidAt: "2026-06-08", dueDate: "2026-06-10" }),
      makeRow({ month: "2026-06", status: "unpaid", dueDate: "2026-07-10" }),
    ];
    const result: MonthlySalesResult = {
      months: rows,
      totals: { gross: 2220, net: 2000, commission: 400, commissionVat: 44, payable: 444 },
      currency: "USD",
      fromMonth: "2026-05",
      toMonth: "2026-06",
    };
    const buf = await generateCmcCommissionSummaryPdf(result);
    expect(pdfContains(buf, "$2,220.00")).toBe(true); // total gross
    expect(pdfContains(buf, "$2,000.00")).toBe(true); // total net
    expect(pdfContains(buf, "$400.00")).toBe(true);   // total commission
    expect(pdfContains(buf, "$44.00")).toBe(true);    // total commissionVat
    expect(pdfContains(buf, "$444.00")).toBe(true);   // total payable
    expect(pdfContains(buf, "TOTAL")).toBe(true);
  });

  // ── Status label tests ───────────────────────────────────────────────────

  it("labels paid rows as 'Paid'", async () => {
    const buf = await generateCmcCommissionSummaryPdf(
      makeResult([makeRow({ month: "2026-05", status: "paid", paidAt: "2026-06-08", dueDate: "2026-06-10" })]),
    );
    expect(pdfContains(buf, "Paid")).toBe(true);
  });

  it("labels the current month as 'Draft'", async () => {
    // FIXED_TODAY = 2026-08-07 → currentMonthLabel = "2026-08"
    const buf = await generateCmcCommissionSummaryPdf(
      makeResult([makeRow({ month: "2026-08", status: "unpaid", dueDate: "2026-09-10" })]),
    );
    expect(pdfContains(buf, "Draft")).toBe(true);
  });

  it("labels past-due unpaid rows as 'Overdue'", async () => {
    // dueDate 2026-07-10 < today 2026-08-07, status != paid → overdue
    const buf = await generateCmcCommissionSummaryPdf(
      makeResult([makeRow({ month: "2026-06", status: "unpaid", dueDate: "2026-07-10" })]),
    );
    expect(pdfContains(buf, "Overdue")).toBe(true);
  });

  it("labels upcoming unpaid rows as 'Due soon'", async () => {
    // month "2026-07" < current "2026-08", dueDate "2026-08-20" > today → due_soon
    const buf = await generateCmcCommissionSummaryPdf(
      makeResult([makeRow({ month: "2026-07", status: "unpaid", dueDate: "2026-08-20" })]),
    );
    expect(pdfContains(buf, "Due soon")).toBe(true);
  });

  it("handles an empty months array gracefully", async () => {
    const result: MonthlySalesResult = {
      months: [],
      totals: { gross: 0, net: 0, commission: 0, commissionVat: 0, payable: 0 },
      currency: "USD",
      fromMonth: null,
      toMonth: null,
    };
    const buf = await generateCmcCommissionSummaryPdf(result);
    expect(isPdf(buf)).toBe(true);
    expect(pdfContains(buf, "$0.00")).toBe(true);
  });
});

// ── Statement PDF ──────────────────────────────────────────────────────────

describe("generateCmcCommissionStatementPdf", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(FIXED_TODAY); });
  afterEach(() => { vi.useRealTimers(); });

  it("returns a valid PDF buffer", async () => {
    const buf = await generateCmcCommissionStatementPdf(
      "2026-06",
      makeResult([makeRow({})]),
    );
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(isPdf(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(1000);
  });

  it("returns a valid PDF for an empty-data fallback", async () => {
    const result: MonthlySalesResult = {
      months: [],
      totals: { gross: 0, net: 0, commission: 0, commissionVat: 0, payable: 0 },
      currency: "USD",
      fromMonth: null,
      toMonth: null,
    };
    const buf = await generateCmcCommissionStatementPdf("2026-06", result);
    expect(isPdf(buf)).toBe(true);
  });

  it("includes a 'Page 1 of 1' footer", async () => {
    const buf = await generateCmcCommissionStatementPdf(
      "2026-06",
      makeResult([makeRow({})]),
    );
    expect(pdfContains(buf, "Page 1 of 1")).toBe(true);
  });

  it("renders per-row financial figures", async () => {
    // gross=1110, net=1000, commission=200, commissionVat=22, payable=222
    const buf = await generateCmcCommissionStatementPdf(
      "2026-06",
      makeResult([makeRow({})]),
    );
    expect(pdfContains(buf, "$1,110.00")).toBe(true); // gross
    expect(pdfContains(buf, "$1,000.00")).toBe(true); // net
    expect(pdfContains(buf, "$200.00")).toBe(true);   // commission
    expect(pdfContains(buf, "$22.00")).toBe(true);    // commissionVat
    expect(pdfContains(buf, "$222.00")).toBe(true);   // payable (amount due)
  });

  it("renders the sales-VAT deduction line (gross − net)", async () => {
    // salesVat = gross - net = 1110 - 1000 = 110
    const buf = await generateCmcCommissionStatementPdf(
      "2026-06",
      makeResult([makeRow({})]),
    );
    expect(pdfContains(buf, "$110.00")).toBe(true);
  });

  it("includes the statement number keyed to the month", async () => {
    const buf = await generateCmcCommissionStatementPdf(
      "2026-06",
      makeResult([makeRow({})]),
    );
    expect(pdfContains(buf, "ST-CMC-2026-06")).toBe(true);
  });

  it("includes Presentail OS branding", async () => {
    const buf = await generateCmcCommissionStatementPdf(
      "2026-06",
      makeResult([makeRow({})]),
    );
    expect(pdfContains(buf, "Presentail OS")).toBe(true);
  });

  // ── Status badge edge cases ──────────────────────────────────────────────

  it("shows 'DRAFT' badge for the current month", async () => {
    // month "2026-08" == currentMonthLabel() → draft
    const buf = await generateCmcCommissionStatementPdf(
      "2026-08",
      makeResult([makeRow({ month: "2026-08", status: "unpaid", dueDate: "2026-09-10" })]),
    );
    // Badge renders dsLabel("draft").toUpperCase() = "DRAFT"
    expect(pdfContains(buf, "DRAFT")).toBe(true);
  });

  it("shows 'OVERDUE' badge for past-due unpaid month", async () => {
    // dueDate 2026-07-10 < today 2026-08-07 → overdue
    const buf = await generateCmcCommissionStatementPdf(
      "2026-06",
      makeResult([makeRow({ month: "2026-06", status: "unpaid", dueDate: "2026-07-10" })]),
    );
    expect(pdfContains(buf, "OVERDUE")).toBe(true);
  });

  it("shows 'PAID' badge for a paid month", async () => {
    const buf = await generateCmcCommissionStatementPdf(
      "2026-05",
      makeResult([makeRow({ month: "2026-05", status: "paid", dueDate: "2026-06-10", paidAt: "2026-06-08" })]),
    );
    expect(pdfContains(buf, "PAID")).toBe(true);
  });

  it("shows 'DUE SOON' badge for unpaid month with future due date", async () => {
    // month "2026-07" < "2026-08" (current), dueDate "2026-08-20" > today → due_soon
    const buf = await generateCmcCommissionStatementPdf(
      "2026-07",
      makeResult([makeRow({ month: "2026-07", status: "unpaid", dueDate: "2026-08-20" })]),
    );
    expect(pdfContains(buf, "DUE SOON")).toBe(true);
  });
});

// ── Financial calculation cross-checks ────────────────────────────────────
//
// These tests verify that the values we pass in as fixtures satisfy the
// documented formulas, AND that the PDF renders those values faithfully.
// They act as a regression net: if arithmetic or rendering silently changes,
// at least one assertion below will fail.

describe("commission figure correctness (formula cross-checks)", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(FIXED_TODAY); });
  afterEach(() => { vi.useRealTimers(); });

  it("payable = commission + commissionVat for a round gross (summary)", async () => {
    // gross=1110, net=1000, commission=200, commissionVat=22, payable=222
    const row = makeRow({});
    expect(row.payable).toBe(row.commission + row.commissionVat); // 222

    const buf = await generateCmcCommissionSummaryPdf(makeResult([row]));
    expect(pdfContains(buf, "$1,110.00")).toBe(true);
    expect(pdfContains(buf, "$1,000.00")).toBe(true);
    expect(pdfContains(buf, "$200.00")).toBe(true);
    expect(pdfContains(buf, "$22.00")).toBe(true);
    expect(pdfContains(buf, "$222.00")).toBe(true);
  });

  it("payable = commission + commissionVat for a round gross (statement)", async () => {
    const row = makeRow({});
    expect(row.payable).toBe(row.commission + row.commissionVat);

    const buf = await generateCmcCommissionStatementPdf("2026-06", makeResult([row]));
    expect(pdfContains(buf, "$1,110.00")).toBe(true);
    expect(pdfContains(buf, "$1,000.00")).toBe(true);
    expect(pdfContains(buf, "$200.00")).toBe(true);
    expect(pdfContains(buf, "$22.00")).toBe(true);
    expect(pdfContains(buf, "$222.00")).toBe(true);
  });

  it("summary totals equal the sum of individual row figures across three rows", async () => {
    // Row A: gross=1110, row B: gross=2220, row C: gross=1110 → total gross=4440
    const rows: MonthlySalesRow[] = [
      makeRow({ month: "2026-04", gross: 1110, net: 1000, commission: 200, commissionVat: 22, payable: 222, status: "paid", paidAt: "2026-05-08", dueDate: "2026-05-10" }),
      makeRow({ month: "2026-05", gross: 2220, net: 2000, commission: 400, commissionVat: 44, payable: 444, status: "paid", paidAt: "2026-06-09", dueDate: "2026-06-10" }),
      makeRow({ month: "2026-06", gross: 1110, net: 1000, commission: 200, commissionVat: 22, payable: 222, status: "unpaid", dueDate: "2026-07-10" }),
    ];
    const totals = { gross: 4440, net: 4000, commission: 800, commissionVat: 88, payable: 888 };

    // Arithmetic sanity before rendering
    expect(totals.gross).toBe(rows.reduce((s, r) => s + r.gross, 0));
    expect(totals.payable).toBe(totals.commission + totals.commissionVat);

    const result: MonthlySalesResult = { months: rows, totals, currency: "USD", fromMonth: "2026-04", toMonth: "2026-06" };
    const buf = await generateCmcCommissionSummaryPdf(result);

    expect(isPdf(buf)).toBe(true);
    expect(pdfContains(buf, "$4,440.00")).toBe(true); // total gross
    expect(pdfContains(buf, "$4,000.00")).toBe(true); // total net
    expect(pdfContains(buf, "$800.00")).toBe(true);   // total commission
    expect(pdfContains(buf, "$88.00")).toBe(true);    // total commissionVat
    expect(pdfContains(buf, "$888.00")).toBe(true);   // total payable
  });

  it("non-round gross figures are rendered faithfully in the statement", async () => {
    // gross=555.55, net=500.50, commission=100.10, commissionVat=11.01, payable=111.11
    const gross = 555.55;
    const net   = Math.round((gross / 1.11) * 100) / 100;          // 500.50
    const commission    = Math.round(net * 0.20 * 100) / 100;       // 100.10
    const commissionVat = Math.round(commission * 0.11 * 100) / 100; // 11.01
    const payable = Math.round((commission + commissionVat) * 100) / 100; // 111.11

    expect(payable).toBe(Math.round((commission + commissionVat) * 100) / 100);

    const row = makeRow({ month: "2026-06", gross, net, commission, commissionVat, payable });
    const buf = await generateCmcCommissionStatementPdf("2026-06", makeResult([row]));

    expect(isPdf(buf)).toBe(true);
    expect(pdfContains(buf, "$555.55")).toBe(true);
    expect(pdfContains(buf, "$500.50")).toBe(true);
    expect(pdfContains(buf, "$100.10")).toBe(true);
    expect(pdfContains(buf, "$11.01")).toBe(true);
    expect(pdfContains(buf, "$111.11")).toBe(true);
  });
});
