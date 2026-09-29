/**
 * Unit tests for the BLOM Lebanon bank statement parser.
 *
 * All test fixtures are built in-memory using ExcelJS so there are no external
 * files to maintain.  The July 2026 BLOM LBP fixture exercises the exact
 * figures from the product spec:
 *
 *   opening balance  −20 711 307
 *   money received    40 500 000
 *   money paid        19 533 969
 *   closing balance      254 724
 *   posted rows             13
 *   pending rows             4
 *   balance difference       0
 */
import { describe, it, expect, beforeAll } from "vitest";
import ExcelJS from "exceljs";
import { parseBLOMBuffer, BLOMParseError, type BLOMParseResult } from "./blomParser.js";
import { computeLineFingerprint } from "./fingerprint.js";

// ── Fixture builder helpers ───────────────────────────────────────────────────

type CellValue = string | number | null;

async function makeXlsxBuffer(rows: CellValue[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Account Statement");
  for (const rowData of rows) {
    ws.addRow(rowData);
  }
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

/**
 * Build a realistic BLOM statement in the canonical layout.
 *
 * Column order (posted table):
 *   Business Date | Value Date | Narrative | Details | Transaction Ref.
 *   | Debit | Credit | Real-time Balance
 */
async function makeStatementBuffer(opts: {
  broughtForwardCell: CellValue;
  postedTxRows: CellValue[][];
  pendingTxRows: CellValue[][];
  accountStatementHeader?: string;
  periodStart?: string;
  periodEnd?: string;
  currency?: string;
  accountNumber?: string;
  accountType?: string;
}): Promise<Buffer> {
  const {
    broughtForwardCell,
    postedTxRows,
    pendingTxRows,
    accountStatementHeader = "Account Statement",
    periodStart = "01/07/2026",
    periodEnd = "31/07/2026",
    currency = "LBP",
    accountNumber = "LB12 **** **** 1234",
    accountType = "Savings Account",
  } = opts;

  const rows: CellValue[][] = [
    [null, null, null, null, null, null, null, null, accountStatementHeader],
    ["Account Type:", accountType],
    ["Account Number:", accountNumber],
    ["Statement Period:", periodStart, "To", periodEnd],
    ["Currency:", currency],
    [],
    ["Balance brought forward", null, null, null, null, null, null, broughtForwardCell],
    [],
    [
      "Business Date",
      "Value Date",
      "Narrative",
      "Details",
      "Transaction Ref.",
      "Debit",
      "Credit",
      "Real-time Balance",
    ],
    ...postedTxRows,
    [],
    ["Pending Transactions"],
    ["Business Date", "Value Date", "Narrative", "Details", "Transaction Ref.", "Debit", "Credit"],
    ...pendingTxRows,
  ];

  return makeXlsxBuffer(rows);
}

// ── July 2026 BLOM LBP sample fixture ────────────────────────────────────────
//
// Running balance starting from −20 711 307:
//
//  1  +5 000 000 credit  → −15 711 307
//  2  −2 000 000 debit   → −17 711 307
//  3  +8 000 000 credit  →  −9 711 307
//  4  −3 533 969 debit   → −13 245 276  (same Ref as row 1 → distinct fingerprint)
//  5  +3 500 000 credit  →  −9 745 276
//  6  −4 000 000 debit   → −13 745 276  (Arabic narrative + details)
//  7  +10 000 000 credit →  −3 745 276
//  8  −5 000 000 debit   →  −8 745 276
//  9  +7 000 000 credit  →  −1 745 276
// 10  −2 000 000 debit   →  −3 745 276
// 11  +4 000 000 credit  →     254 724
// 12  −3 000 000 debit   →  −2 745 276
// 13  +3 000 000 credit  →     254 724  ← closing balance
//
// Sum of credits: 5+8+3.5+10+7+4+3 = 40 500 000 ✓
// Sum of debits:  2+3.533969+4+5+2+3 = 19 533 969 ✓

const JULY_2026_POSTED_ROWS: CellValue[][] = [
  ["01/07/2026", "01/07/2026", "Credit Transfer", "From Corp A",    "REF-001", null,      5_000_000, -15_711_307],
  ["02/07/2026", "02/07/2026", "ATM Withdrawal",  "ATM Downtown",   "REF-002", 2_000_000, null,      -17_711_307],
  ["05/07/2026", "05/07/2026", "Credit Transfer", "From Corp B",    "REF-003", null,      8_000_000,  -9_711_307],
  // Row 4: same Transaction Ref as row 1 — must produce a different fingerprint
  ["07/07/2026", "07/07/2026", "Bank Charges",    "Monthly fees",   "REF-001", 3_533_969, null,     -13_245_276],
  ["10/07/2026", "10/07/2026", "Credit Transfer", "Payment in",     "REF-005", null,      3_500_000,  -9_745_276],
  // Row 6: Arabic narrative and details
  ["12/07/2026", "12/07/2026", "تحويل بنكي",      "تفاصيل الدفعة", "REF-006", 4_000_000, null,     -13_745_276],
  ["15/07/2026", "15/07/2026", "Credit Transfer", "Large payment",  "REF-007", null,     10_000_000,  -3_745_276],
  ["18/07/2026", "18/07/2026", "Wire Transfer",   "Wire out",       "REF-008", 5_000_000, null,      -8_745_276],
  ["20/07/2026", "20/07/2026", "Credit Transfer", "Receivable",     "REF-009", null,      7_000_000,  -1_745_276],
  ["22/07/2026", "22/07/2026", "ATM Withdrawal",  "ATM Branch",     "REF-010", 2_000_000, null,      -3_745_276],
  ["24/07/2026", "24/07/2026", "Credit Transfer", "End payment",    "REF-011", null,      4_000_000,     254_724],
  ["25/07/2026", "25/07/2026", "Service Fee",     "Monthly charge", "REF-012", 3_000_000, null,      -2_745_276],
  ["31/07/2026", "31/07/2026", "Credit Transfer", "Month close",    "REF-013", null,      3_000_000,     254_724],
];

const JULY_2026_PENDING_ROWS: CellValue[][] = [
  ["31/07/2026", "01/08/2026", "Pending Credit 1", "Details",  "PND-001", null,    500_000],
  ["31/07/2026", "01/08/2026", "Pending Debit 1",  "Details",  "PND-002", 200_000, null],
  ["31/07/2026", "02/08/2026", "Pending Credit 2", "Details",  "PND-003", null,  1_000_000],
  ["31/07/2026", "02/08/2026", "Pending Debit 2",  "Details",  "PND-004", 300_000, null],
];

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("parseBLOMBuffer — July 2026 BLOM LBP sample fixture", () => {
  let result: BLOMParseResult;

  beforeAll(async () => {
    const buf = await makeStatementBuffer({
      broughtForwardCell: "20,711,307.00 D",
      postedTxRows: JULY_2026_POSTED_ROWS,
      pendingTxRows: JULY_2026_PENDING_ROWS,
    });
    result = await parseBLOMBuffer(buf);
  });

  it("extracts the correct opening balance (−20 711 307)", () => {
    expect(result.openingBalance).toBe(-20_711_307);
  });

  it("extracts 13 posted rows", () => {
    expect(result.postedRows).toHaveLength(13);
  });

  it("extracts 4 pending rows", () => {
    expect(result.pendingRows).toHaveLength(4);
  });

  it("computes money received = 40 500 000", () => {
    expect(result.moneyReceived).toBe(40_500_000);
  });

  it("computes money paid = 19 533 969", () => {
    expect(result.moneyPaid).toBe(19_533_969);
  });

  it("sets closing balance = 254 724 (last posted realtime balance)", () => {
    expect(result.closingBalance).toBe(254_724);
  });

  it("balance difference is 0 (balanced statement)", () => {
    expect(result.balanceDifference).toBe(0);
  });

  it("sets balanceCheckPassed = true", () => {
    expect(result.balanceCheckPassed).toBe(true);
  });

  it("parses the statement period", () => {
    expect(result.periodStart).toBe("01/07/2026");
    expect(result.periodEnd).toBe("31/07/2026");
  });

  it("parses the currency", () => {
    expect(result.currency).toBe("LBP");
  });

  it("parses account type and masked number", () => {
    expect(result.accountType).toBe("Savings Account");
    expect(result.maskedAccountNumber).toBe("LB12 **** **** 1234");
  });
});

// ── D/C opening balance variants ──────────────────────────────────────────────

describe("parseBLOMBuffer — D/C opening balance variants", () => {
  it("treats D (debit) suffix as a negative opening balance", async () => {
    const buf = await makeStatementBuffer({
      broughtForwardCell: "5,000,000.00 D",
      postedTxRows: [
        ["01/07/2026", "01/07/2026", "Test Credit", "Details", "REF-001", null, 5_000_000, 0],
      ],
      pendingTxRows: [],
    });
    const r = await parseBLOMBuffer(buf);
    expect(r.openingBalance).toBe(-5_000_000);
  });

  it("treats C (credit) suffix as a positive opening balance", async () => {
    const buf = await makeStatementBuffer({
      broughtForwardCell: "1,000,000.00 C",
      postedTxRows: [
        ["01/07/2026", "01/07/2026", "Test Debit", "Details", "REF-001", 500_000, null, 500_000],
      ],
      pendingTxRows: [],
    });
    const r = await parseBLOMBuffer(buf);
    expect(r.openingBalance).toBe(1_000_000);
  });

  it("treats a plain negative number as a negative opening balance", async () => {
    const buf = await makeStatementBuffer({
      broughtForwardCell: -3_000_000,
      postedTxRows: [
        ["01/07/2026", "01/07/2026", "Test Credit", "Details", "REF-001", null, 3_000_000, 0],
      ],
      pendingTxRows: [],
    });
    const r = await parseBLOMBuffer(buf);
    expect(r.openingBalance).toBe(-3_000_000);
  });
});

// ── Text-formatted dates and amounts ─────────────────────────────────────────

describe("parseBLOMBuffer — text-formatted dates and amounts", () => {
  it("strips thousands-separator commas from text amount strings", async () => {
    const buf = await makeStatementBuffer({
      broughtForwardCell: "20,711,307.00 D",
      postedTxRows: [
        ["01/07/2026", "01/07/2026", "Charge", "Details", "REF-001", "3,000,000.00", null, "-17,711,307.00"],
      ],
      pendingTxRows: [],
    });
    const r = await parseBLOMBuffer(buf);
    expect(r.postedRows[0].debitAmount).toBe(3_000_000);
  });

  it("preserves date strings verbatim", async () => {
    const buf = await makeStatementBuffer({
      broughtForwardCell: "1,000.00 D",
      postedTxRows: [
        ["15/07/2026", "16/07/2026", "Tx", "Details", "REF-001", null, 1_000, 0],
      ],
      pendingTxRows: [],
    });
    const r = await parseBLOMBuffer(buf);
    expect(r.postedRows[0].businessDate).toBe("15/07/2026");
    expect(r.postedRows[0].valueDate).toBe("16/07/2026");
  });
});

// ── Repeated Transaction Ref values ──────────────────────────────────────────

describe("parseBLOMBuffer — repeated Transaction Ref values", () => {
  it("does not collapse two rows with the same Transaction Ref", async () => {
    const buf = await makeStatementBuffer({
      broughtForwardCell: "1,000,000.00 D",
      postedTxRows: [
        ["01/07/2026", "01/07/2026", "Credit A", "Details", "SAME-REF", null, 500_000, -500_000],
        ["02/07/2026", "02/07/2026", "Credit B", "Details", "SAME-REF", null, 500_000,       0],
      ],
      pendingTxRows: [],
    });
    const r = await parseBLOMBuffer(buf);
    expect(r.postedRows).toHaveLength(2);
    expect(r.postedRows[0].transactionRef).toBe("SAME-REF");
    expect(r.postedRows[1].transactionRef).toBe("SAME-REF");
  });

  it("produces distinct fingerprints for same-Ref rows via sourceRowIndex", async () => {
    const buf = await makeStatementBuffer({
      broughtForwardCell: "1,000,000.00 D",
      postedTxRows: [
        ["01/07/2026", "01/07/2026", "Credit A", "Details", "DUP-REF", null, 500_000, -500_000],
        ["02/07/2026", "02/07/2026", "Credit B", "Details", "DUP-REF", null, 500_000,       0],
      ],
      pendingTxRows: [],
    });
    const r = await parseBLOMBuffer(buf);
    const accountId = 1;
    const fp1 = computeLineFingerprint({
      accountId,
      periodStart: r.periodStart,
      periodEnd: r.periodEnd,
      businessDate: r.postedRows[0].businessDate,
      valueDate: r.postedRows[0].valueDate,
      debitAmount: r.postedRows[0].debitAmount,
      creditAmount: r.postedRows[0].creditAmount,
      narrative: r.postedRows[0].narrative,
      transactionRef: r.postedRows[0].transactionRef,
      realtimeBalance: r.postedRows[0].realtimeBalance,
      sourceRowIndex: r.postedRows[0].sourceRowIndex,
    });
    const fp2 = computeLineFingerprint({
      accountId,
      periodStart: r.periodStart,
      periodEnd: r.periodEnd,
      businessDate: r.postedRows[1].businessDate,
      valueDate: r.postedRows[1].valueDate,
      debitAmount: r.postedRows[1].debitAmount,
      creditAmount: r.postedRows[1].creditAmount,
      narrative: r.postedRows[1].narrative,
      transactionRef: r.postedRows[1].transactionRef,
      realtimeBalance: r.postedRows[1].realtimeBalance,
      sourceRowIndex: r.postedRows[1].sourceRowIndex,
    });
    expect(fp1).not.toBe(fp2);
    expect(fp1).toMatch(/^[0-9a-f]{64}$/);
    expect(fp2).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── Unicode and Arabic narratives ─────────────────────────────────────────────

describe("parseBLOMBuffer — Unicode and Arabic narratives", () => {
  it("preserves Arabic narrative verbatim", async () => {
    const arabicNarrative = "تحويل بنكي";
    const arabicDetails = "تفاصيل الدفعة الشهرية";
    const buf = await makeStatementBuffer({
      broughtForwardCell: "100,000.00 D",
      postedTxRows: [
        ["01/07/2026", "01/07/2026", arabicNarrative, arabicDetails, "REF-001", null, 100_000, 0],
      ],
      pendingTxRows: [],
    });
    const r = await parseBLOMBuffer(buf);
    expect(r.postedRows[0].narrative).toBe(arabicNarrative);
    expect(r.postedRows[0].details).toBe(arabicDetails);
  });

  it("preserves mixed Arabic/Latin Unicode text", async () => {
    const mixedNarrative = "Transfer - تحويل رقم 12345";
    const buf = await makeStatementBuffer({
      broughtForwardCell: "50,000.00 C",
      postedTxRows: [
        ["01/07/2026", "01/07/2026", mixedNarrative, "Details", "REF-001", 50_000, null, 0],
      ],
      pendingTxRows: [],
    });
    const r = await parseBLOMBuffer(buf);
    expect(r.postedRows[0].narrative).toBe(mixedNarrative);
  });
});

// ── Pending section boundary detection ───────────────────────────────────────

describe("parseBLOMBuffer — pending section boundary detection", () => {
  it("stops collecting posted rows at the 'Pending Transactions' row", async () => {
    const buf = await makeStatementBuffer({
      broughtForwardCell: "1,000,000.00 D",
      postedTxRows: [
        ["01/07/2026", "01/07/2026", "Posted Tx", "Details", "REF-001", null, 400_000, -600_000],
        ["02/07/2026", "02/07/2026", "Posted Tx", "Details", "REF-002", null, 600_000,       0],
      ],
      pendingTxRows: [
        ["31/07/2026", "01/08/2026", "Pending Tx", "Details", "PND-001", 100_000, null],
      ],
    });
    const r = await parseBLOMBuffer(buf);
    expect(r.postedRows).toHaveLength(2);
    expect(r.pendingRows).toHaveLength(1);
  });

  it("skips the repeated Business Date header row inside the pending section", async () => {
    const buf = await makeStatementBuffer({
      broughtForwardCell: "500,000.00 D",
      postedTxRows: [
        ["01/07/2026", "01/07/2026", "Posted", "Details", "REF-001", null, 500_000, 0],
      ],
      pendingTxRows: [
        ["31/07/2026", "01/08/2026", "Pending A", "Details", "PND-001", null, 200_000],
        ["31/07/2026", "01/08/2026", "Pending B", "Details", "PND-002", 100_000, null],
      ],
    });
    const r = await parseBLOMBuffer(buf);
    expect(r.pendingRows).toHaveLength(2);
    expect(r.pendingRows[0].narrative).toBe("Pending A");
    expect(r.pendingRows[1].narrative).toBe("Pending B");
  });

  it("throws BLOMParseError when the posted section is present but has no transaction rows", async () => {
    // A statement where the transaction table header appears but has zero data rows
    // below it is structurally invalid: there is no closing balance to derive.
    // The parser must reject this case with a clear error rather than producing
    // an empty-rows result that would confuse downstream consumers.
    const rows: CellValue[][] = [
      [null, null, null, null, null, null, null, null, "Account Statement"],
      ["Account Type:", "Current Account"],
      ["Account Number:", "LB99 **** **** 9999"],
      ["Statement Period:", "01/07/2026", "To", "31/07/2026"],
      ["Currency:", "LBP"],
      [],
      ["Balance brought forward", null, null, null, null, null, null, "0.00 C"],
      [],
      [
        "Business Date", "Value Date", "Narrative", "Details",
        "Transaction Ref.", "Debit", "Credit", "Real-time Balance",
      ],
      // ← zero transaction rows: table header present, no data
    ];
    const buf = await makeXlsxBuffer(rows);
    await expect(parseBLOMBuffer(buf)).rejects.toThrow(BLOMParseError);
    await expect(parseBLOMBuffer(buf)).rejects.toThrow(/no posted|posted.*found/i);
  });

  it("returns empty pendingRows when there is no Pending Transactions section", async () => {
    const rows: CellValue[][] = [
      [null, null, null, null, null, null, null, null, "Account Statement"],
      ["Account Type:", "Current Account"],
      ["Account Number:", "LB99 **** **** 9999"],
      ["Statement Period:", "01/06/2026", "To", "30/06/2026"],
      ["Currency:", "LBP"],
      [],
      ["Balance brought forward", null, null, null, null, null, null, "200,000.00 D"],
      [],
      [
        "Business Date", "Value Date", "Narrative", "Details",
        "Transaction Ref.", "Debit", "Credit", "Real-time Balance",
      ],
      ["01/06/2026", "01/06/2026", "Income", "Details", "REF-001", null, 200_000, 0],
    ];
    const buf = await makeXlsxBuffer(rows);
    const r = await parseBLOMBuffer(buf);
    expect(r.pendingRows).toHaveLength(0);
    expect(r.postedRows).toHaveLength(1);
  });

  it("closing balance comes from the last posted row, not any figure after the pending section", async () => {
    const buf = await makeStatementBuffer({
      broughtForwardCell: "2,000,000.00 D",
      postedTxRows: [
        ["01/07/2026", "01/07/2026", "Credit A", "Details", "REF-001", null, 1_000_000, -1_000_000],
        ["02/07/2026", "02/07/2026", "Credit B", "Details", "REF-002", null, 1_000_000,          0],
      ],
      pendingTxRows: [
        ["31/07/2026", "01/08/2026", "Pending", "Details", "PND-001", 9_999_999, null],
      ],
    });
    const r = await parseBLOMBuffer(buf);
    expect(r.closingBalance).toBe(0);
  });
});

// ── Balance check pass / fail ─────────────────────────────────────────────────

describe("parseBLOMBuffer — balance validation", () => {
  it("sets balanceCheckPassed=true when the equation holds", async () => {
    const buf = await makeStatementBuffer({
      broughtForwardCell: "1,000,000.00 D",
      postedTxRows: [
        ["01/07/2026", "01/07/2026", "Credit", "Details", "REF-001", null, 1_000_000, 0],
      ],
      pendingTxRows: [],
    });
    const r = await parseBLOMBuffer(buf);
    expect(r.balanceDifference).toBe(0);
    expect(r.balanceCheckPassed).toBe(true);
  });

  it("sets balanceCheckPassed=false when the closing balance does not match", async () => {
    // opening(−1 000 000) + credit(1 000 000) = 0, but the realtime balance cell says 99 999
    const rows: CellValue[][] = [
      [null, null, null, null, null, null, null, null, "Account Statement"],
      ["Account Type:", "Current Account"],
      ["Account Number:", "LB99 **** **** 9999"],
      ["Statement Period:", "01/07/2026", "To", "31/07/2026"],
      ["Currency:", "LBP"],
      [],
      ["Balance brought forward", null, null, null, null, null, null, "1,000,000.00 D"],
      [],
      [
        "Business Date", "Value Date", "Narrative", "Details",
        "Transaction Ref.", "Debit", "Credit", "Real-time Balance",
      ],
      ["01/07/2026", "01/07/2026", "Credit", "Details", "REF-001", null, 1_000_000, 99_999],
    ];
    const buf = await makeXlsxBuffer(rows);
    const r = await parseBLOMBuffer(buf);
    expect(r.balanceCheckPassed).toBe(false);
    expect(r.balanceDifference).not.toBe(0);
  });
});

// ── Error cases ───────────────────────────────────────────────────────────────

describe("parseBLOMBuffer — error handling", () => {
  it("throws BLOMParseError for an empty buffer", async () => {
    await expect(parseBLOMBuffer(Buffer.alloc(0))).rejects.toThrow(BLOMParseError);
    await expect(parseBLOMBuffer(Buffer.alloc(0))).rejects.toThrow(/empty/i);
  });

  it("throws BLOMParseError for a non-spreadsheet buffer", async () => {
    await expect(parseBLOMBuffer(Buffer.from("not a spreadsheet"))).rejects.toThrow(BLOMParseError);
  });

  it("throws BLOMParseError when 'Account Statement' header is missing", async () => {
    const rows: CellValue[][] = [
      ["Account Type:", "Savings Account"],
      ["Account Number:", "LB12 **** **** 1234"],
      ["Statement Period:", "01/07/2026", "To", "31/07/2026"],
      ["Currency:", "LBP"],
      [],
      ["Balance brought forward", null, null, null, null, null, null, "500,000.00 D"],
      [],
      [
        "Business Date", "Value Date", "Narrative", "Details",
        "Transaction Ref.", "Debit", "Credit", "Real-time Balance",
      ],
      ["01/07/2026", "01/07/2026", "Tx", "Details", "REF-001", null, 500_000, 0],
    ];
    const buf = await makeXlsxBuffer(rows);
    await expect(parseBLOMBuffer(buf)).rejects.toThrow(BLOMParseError);
    await expect(parseBLOMBuffer(buf)).rejects.toThrow(/account statement/i);
  });

  it("throws BLOMParseError when the brought-forward row is missing", async () => {
    const rows: CellValue[][] = [
      [null, null, null, null, null, null, null, null, "Account Statement"],
      ["Account Type:", "Savings Account"],
      ["Account Number:", "LB12 **** **** 1234"],
      ["Statement Period:", "01/07/2026", "To", "31/07/2026"],
      ["Currency:", "LBP"],
      [],
      [
        "Business Date", "Value Date", "Narrative", "Details",
        "Transaction Ref.", "Debit", "Credit", "Real-time Balance",
      ],
      ["01/07/2026", "01/07/2026", "Tx", "Details", "REF-001", null, 500_000, 0],
    ];
    const buf = await makeXlsxBuffer(rows);
    await expect(parseBLOMBuffer(buf)).rejects.toThrow(BLOMParseError);
    await expect(parseBLOMBuffer(buf)).rejects.toThrow(/brought.forward/i);
  });

  it("throws BLOMParseError when the 'Business Date' transaction table is missing", async () => {
    const rows: CellValue[][] = [
      [null, null, null, null, null, null, null, null, "Account Statement"],
      ["Account Type:", "Savings Account"],
      ["Account Number:", "LB12 **** **** 1234"],
      ["Statement Period:", "01/07/2026", "To", "31/07/2026"],
      ["Currency:", "LBP"],
      [],
      ["Balance brought forward", null, null, null, null, null, null, "500,000.00 D"],
      [],
      ["Random text", "more text"],
    ];
    const buf = await makeXlsxBuffer(rows);
    await expect(parseBLOMBuffer(buf)).rejects.toThrow(BLOMParseError);
    await expect(parseBLOMBuffer(buf)).rejects.toThrow(/business date/i);
  });

  it("throws BLOMParseError for a worksheet with no rows", async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Empty");
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    await expect(parseBLOMBuffer(buf)).rejects.toThrow(BLOMParseError);
    await expect(parseBLOMBuffer(buf)).rejects.toThrow(/empty|account statement/i);
  });
});

// ── computeLineFingerprint ────────────────────────────────────────────────────

describe("computeLineFingerprint", () => {
  const baseInput = {
    accountId: 42,
    periodStart: "01/07/2026",
    periodEnd: "31/07/2026",
    businessDate: "15/07/2026",
    valueDate: "15/07/2026",
    debitAmount: null,
    creditAmount: 5_000_000,
    narrative: "Test Credit",
    transactionRef: "REF-001",
    realtimeBalance: -10_000_000,
    sourceRowIndex: 9,
  };

  it("returns a 64-character hex SHA-256 digest", () => {
    expect(computeLineFingerprint(baseInput)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces the same fingerprint for the same inputs", () => {
    expect(computeLineFingerprint(baseInput)).toBe(computeLineFingerprint(baseInput));
  });

  it("produces different fingerprints when only sourceRowIndex changes", () => {
    expect(computeLineFingerprint({ ...baseInput, sourceRowIndex: 9 })).not.toBe(
      computeLineFingerprint({ ...baseInput, sourceRowIndex: 10 }),
    );
  });

  it("produces different fingerprints when only accountId changes", () => {
    expect(computeLineFingerprint({ ...baseInput, accountId: 1 })).not.toBe(
      computeLineFingerprint({ ...baseInput, accountId: 2 }),
    );
  });

  it("produces different fingerprints for different periods", () => {
    expect(
      computeLineFingerprint({ ...baseInput, periodStart: "01/07/2026", periodEnd: "31/07/2026" }),
    ).not.toBe(
      computeLineFingerprint({ ...baseInput, periodStart: "01/08/2026", periodEnd: "31/08/2026" }),
    );
  });

  it("produces different fingerprints for debit vs credit amounts", () => {
    expect(computeLineFingerprint({ ...baseInput, creditAmount: 100, debitAmount: null })).not.toBe(
      computeLineFingerprint({ ...baseInput, creditAmount: null, debitAmount: 100 }),
    );
  });

  it("handles Arabic narrative without error", () => {
    expect(computeLineFingerprint({ ...baseInput, narrative: "تحويل بنكي" })).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });
});
