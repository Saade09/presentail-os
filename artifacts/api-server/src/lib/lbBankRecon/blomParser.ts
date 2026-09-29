/**
 * BLOM Lebanon bank statement parser.
 *
 * Parses an .xlsx account statement exported from BLOM Bank and returns a
 * strongly-typed result containing statement header metadata, all posted
 * transaction rows, and the separate pending transaction rows.
 *
 * Uses the already-installed `exceljs` package (no known security advisories).
 * Legacy BIFF8 .xls files are not supported — users should export or save as
 * .xlsx before uploading.
 *
 * The parser is state-machine driven — it searches for structural markers
 * ("Account Statement", "brought forward", "Business Date", "Pending
 * Transactions") rather than relying on fixed row positions, so it is
 * resilient to minor layout changes between statement exports.
 */
import ExcelJS from "exceljs";

// ── Error type ────────────────────────────────────────────────────────────────

export class BLOMParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BLOMParseError";
  }
}

// ── Public result types ───────────────────────────────────────────────────────

export interface BLOMPostedRow {
  /** Date string as it appears in the statement, e.g. "01/07/2026". */
  businessDate: string;
  valueDate: string;
  /** Free-text narrative field; Unicode / Arabic content is preserved verbatim. */
  narrative: string;
  /** Optional detail line; Unicode / Arabic content is preserved verbatim. */
  details: string;
  transactionRef: string;
  /** Debit amount (positive, null when the row is a credit). */
  debitAmount: number | null;
  /** Credit amount (positive, null when the row is a debit). */
  creditAmount: number | null;
  /** Running / real-time balance at the end of this row (signed). */
  realtimeBalance: number;
  /**
   * 0-based worksheet row index — included in the fingerprint so that
   * repeated Transaction Ref values on different rows get unique fingerprints.
   */
  sourceRowIndex: number;
}

export interface BLOMPendingRow {
  businessDate: string;
  valueDate: string;
  narrative: string;
  details: string;
  transactionRef: string;
  debitAmount: number | null;
  creditAmount: number | null;
  sourceRowIndex: number;
}

export interface BLOMParseResult {
  accountType: string;
  maskedAccountNumber: string;
  currency: string;
  /** Statement start date string as it appears in the header. */
  periodStart: string;
  /** Statement end date string as it appears in the header. */
  periodEnd: string;
  /**
   * Signed opening balance extracted from the "Balance brought forward" row.
   * Negative = debit (account in deficit), positive = credit.
   */
  openingBalance: number;
  postedRows: BLOMPostedRow[];
  /** Pending / uncleared transactions — stored with line_type = "excluded". */
  pendingRows: BLOMPendingRow[];
  /**
   * Closing balance taken from the last realtime-balance cell in the POSTED
   * section only — NOT from any balance shown beneath the pending section.
   */
  closingBalance: number;
  /** Sum of all creditAmount values across posted rows. */
  moneyReceived: number;
  /** Sum of all debitAmount values across posted rows. */
  moneyPaid: number;
  /**
   * (openingBalance + moneyReceived − moneyPaid) − closingBalance.
   * A balanced statement produces 0.
   */
  balanceDifference: number;
  balanceCheckPassed: boolean;
}

// ── ExcelJS cell value extraction ─────────────────────────────────────────────

/**
 * Extract a plain JS primitive from an ExcelJS Cell, handling rich text,
 * formula results, hyperlinks, dates, and error cells.
 */
function extractCellValue(cell: ExcelJS.Cell): unknown {
  const v = cell.value;
  if (v === null || v === undefined) return null;

  // Rich text: { richText: [{ text, font? }, ...] }
  if (typeof v === "object" && "richText" in v) {
    return (v as ExcelJS.CellRichTextValue).richText.map((r) => r.text).join("");
  }

  // Formula cell: { formula, result, date1904 }
  if (typeof v === "object" && "formula" in v) {
    const fv = v as ExcelJS.CellFormulaValue;
    return fv.result ?? null;
  }

  // Shared formula
  if (typeof v === "object" && "sharedFormula" in v) {
    const sfv = v as ExcelJS.CellSharedFormulaValue;
    return sfv.result ?? null;
  }

  // Hyperlink: { text, hyperlink }
  if (typeof v === "object" && "hyperlink" in v) {
    return (v as ExcelJS.CellHyperlinkValue).text ?? null;
  }

  // Error cell
  if (typeof v === "object" && "error" in v) return null;

  // Date — format as DD/MM/YYYY to match BLOM statement style
  if (v instanceof Date) {
    const dd = String(v.getDate()).padStart(2, "0");
    const mm = String(v.getMonth() + 1).padStart(2, "0");
    return `${dd}/${mm}/${v.getFullYear()}`;
  }

  // Primitive: string, number, boolean
  return v;
}

/**
 * Load the first worksheet of an xlsx buffer into a 2-D array of plain values.
 * Each inner array is 0-indexed (column 0 = leftmost cell).  Empty cells are null.
 */
async function loadRows(buffer: Buffer): Promise<unknown[][]> {
  const workbook = new ExcelJS.Workbook();
  try {
    // ExcelJS types use an older non-generic Buffer; @types/node now uses
    // Buffer<ArrayBufferLike>.  They are structurally identical at runtime.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await workbook.xlsx.load(buffer as any);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toLowerCase().includes("password")) {
      throw new BLOMParseError("File is password-protected");
    }
    throw new BLOMParseError(`Cannot read workbook: ${msg}`);
  }

  if (!workbook.worksheets.length) {
    throw new BLOMParseError("Workbook is empty");
  }

  const ws = workbook.worksheets[0];
  const rows: unknown[][] = [];

  ws.eachRow({ includeEmpty: true }, (row) => {
    // row.values is 1-indexed; convert to 0-indexed.
    const rawVals = (row.values as unknown[]) ?? [];
    // rawVals[0] is always undefined (ExcelJS convention); rawVals[1..n] are cells.
    const colCount = rawVals.length > 1 ? rawVals.length - 1 : 0;
    const cells: unknown[] = new Array(colCount).fill(null);
    for (let col = 1; col <= colCount; col++) {
      cells[col - 1] = extractCellValue(row.getCell(col));
    }
    rows.push(cells);
  });

  return rows;
}

// ── Internal parsing helpers ───────────────────────────────────────────────────

type Cell = unknown;
type Row = Cell[];

function cellStr(cell: Cell): string {
  if (cell === null || cell === undefined) return "";
  return String(cell).trim();
}

function rowContainsCI(row: Row, substr: string): boolean {
  const lower = substr.toLowerCase();
  return row.some((c) => cellStr(c).toLowerCase().includes(lower));
}

function findColCI(row: Row, name: string): number {
  const lower = name.toLowerCase();
  return row.findIndex((c) => cellStr(c).toLowerCase().includes(lower));
}

function stripCommas(s: string): string {
  return s.replace(/,/g, "");
}

/**
 * Parse an amount that may carry a trailing " D" (debit = negative) or
 * " C" (credit = positive) suffix, or be a plain signed number/string.
 */
function parseSignedAmount(cell: Cell): number | null {
  if (cell === null || cell === undefined) return null;
  if (typeof cell === "number") return cell;

  const str = cellStr(cell);
  if (!str || str === "-") return null;

  const upper = str.toUpperCase();
  let sign = 1;
  let numStr = str;

  if (upper.endsWith(" D")) {
    sign = -1;
    numStr = str.slice(0, -2).trim();
  } else if (upper.endsWith(" C")) {
    numStr = str.slice(0, -2).trim();
  }

  const n = parseFloat(stripCommas(numStr));
  return isNaN(n) ? null : sign * n;
}

/**
 * Parse an unsigned amount from a Debit or Credit column.
 * Returns null for empty / dash / non-numeric cells.
 */
function parseUnsignedAmount(cell: Cell): number | null {
  if (cell === null || cell === undefined) return null;
  if (typeof cell === "number") return cell;

  const str = cellStr(cell);
  if (!str || str === "-") return null;

  const n = parseFloat(stripCommas(str));
  return isNaN(n) ? null : n;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ── Main parser ────────────────────────────────────────────────────────────────

/**
 * Parse a Buffer containing a BLOM .xlsx account statement.
 *
 * Throws {@link BLOMParseError} for any structural or content problem.
 * The caller should surface the message to the client with HTTP 422.
 */
export async function parseBLOMBuffer(buffer: Buffer): Promise<BLOMParseResult> {
  if (!buffer.length) {
    throw new BLOMParseError("File is empty");
  }

  const rows = await loadRows(buffer);

  if (!rows.length) {
    throw new BLOMParseError("Worksheet is empty");
  }

  // ── 1. Header / metadata scan (first 40 rows) ─────────────────────────────
  let accountStatementFound = false;
  let accountType = "";
  let maskedAccountNumber = "";
  let currency = "LBP";
  let periodStart = "";
  let periodEnd = "";

  const HEADER_SCAN_LIMIT = Math.min(rows.length, 40);

  for (let i = 0; i < HEADER_SCAN_LIMIT; i++) {
    const row = rows[i];
    if (!row?.length) continue;

    if (!accountStatementFound && rowContainsCI(row, "account statement")) {
      accountStatementFound = true;
    }

    const firstLower = cellStr(row[0]).toLowerCase();

    if (firstLower.includes("account type")) {
      accountType = cellStr(row[1]);
    } else if (firstLower.includes("account number")) {
      maskedAccountNumber = cellStr(row[1]);
    } else if (firstLower.includes("statement period")) {
      periodStart = cellStr(row[1]);
      periodEnd = cellStr(row[3]);
    } else if (firstLower.includes("currency")) {
      currency = cellStr(row[1]) || "LBP";
    }
  }

  if (!accountStatementFound) {
    throw new BLOMParseError(
      '"Account Statement" header not found in the first 40 rows',
    );
  }

  // ── 2. Brought-forward balance ─────────────────────────────────────────────
  let openingBalance: number | null = null;
  let bfwdRowIdx = -1;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row?.length) continue;

    if (rowContainsCI(row, "brought forward")) {
      for (let j = row.length - 1; j >= 0; j--) {
        const raw = row[j];
        if (raw !== null && raw !== undefined && cellStr(raw) !== "") {
          openingBalance = parseSignedAmount(raw);
          break;
        }
      }
      bfwdRowIdx = i;
      break;
    }
  }

  if (openingBalance === null || bfwdRowIdx === -1) {
    throw new BLOMParseError(
      '"Balance brought forward" row not found',
    );
  }

  // ── 3. Transaction table header ────────────────────────────────────────────
  let tableHeaderIdx = -1;
  let colBD = -1;
  let colVD = -1;
  let colNarr = -1;
  let colDet = -1;
  let colRef = -1;
  let colDr = -1;
  let colCr = -1;
  let colBal = -1;

  for (let i = bfwdRowIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row?.length) continue;

    if (rowContainsCI(row, "business date")) {
      tableHeaderIdx = i;
      colBD = findColCI(row, "business date");
      colVD = findColCI(row, "value date");
      colNarr = findColCI(row, "narrative");
      colDet = findColCI(row, "details");
      colRef = findColCI(row, "transaction ref");
      colDr = findColCI(row, "debit");
      colCr = findColCI(row, "credit");
      colBal = findColCI(row, "real-time balance");
      break;
    }
  }

  if (tableHeaderIdx === -1) {
    throw new BLOMParseError(
      '"Business Date" transaction table not found',
    );
  }
  if (colBD === -1) {
    throw new BLOMParseError(
      'Unreadable layout: "Business Date" column not identifiable',
    );
  }
  if (colBal === -1) {
    throw new BLOMParseError(
      'Unreadable layout: "Real-time Balance" column not identifiable',
    );
  }

  // ── 4. Posted transaction rows ─────────────────────────────────────────────
  const postedRows: BLOMPostedRow[] = [];
  let pendingStartIdx = -1;
  let closingBalance = 0;
  let closingBalanceFound = false;

  for (let i = tableHeaderIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row?.length) continue;

    if (rowContainsCI(row, "pending transactions")) {
      pendingStartIdx = i;
      break;
    }

    const bdCell = cellStr(row[colBD]);
    if (!bdCell) continue;

    const debit = colDr >= 0 ? parseUnsignedAmount(row[colDr]) : null;
    const credit = colCr >= 0 ? parseUnsignedAmount(row[colCr]) : null;
    const balance = parseSignedAmount(row[colBal]);

    if (balance === null) continue;

    postedRows.push({
      businessDate: bdCell,
      valueDate: colVD >= 0 ? cellStr(row[colVD]) : "",
      narrative: colNarr >= 0 ? cellStr(row[colNarr]) : "",
      details: colDet >= 0 ? cellStr(row[colDet]) : "",
      transactionRef: colRef >= 0 ? cellStr(row[colRef]) : "",
      debitAmount: debit,
      creditAmount: credit,
      realtimeBalance: balance,
      sourceRowIndex: i,
    });

    closingBalance = balance;
    closingBalanceFound = true;
  }

  if (!postedRows.length) {
    throw new BLOMParseError("No posted transactions found in statement");
  }
  if (!closingBalanceFound) {
    throw new BLOMParseError("Could not determine closing balance from posted section");
  }

  // ── 5. Pending transaction rows ────────────────────────────────────────────
  const pendingRows: BLOMPendingRow[] = [];

  if (pendingStartIdx !== -1) {
    for (let i = pendingStartIdx + 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row?.length) continue;

      if (rowContainsCI(row, "business date")) continue;

      const bdCell = cellStr(row[colBD]);
      if (!bdCell) continue;

      pendingRows.push({
        businessDate: bdCell,
        valueDate: colVD >= 0 ? cellStr(row[colVD]) : "",
        narrative: colNarr >= 0 ? cellStr(row[colNarr]) : "",
        details: colDet >= 0 ? cellStr(row[colDet]) : "",
        transactionRef: colRef >= 0 ? cellStr(row[colRef]) : "",
        debitAmount: colDr >= 0 ? parseUnsignedAmount(row[colDr]) : null,
        creditAmount: colCr >= 0 ? parseUnsignedAmount(row[colCr]) : null,
        sourceRowIndex: i,
      });
    }
  }

  // ── 6. Balance validation ──────────────────────────────────────────────────
  let moneyReceived = 0;
  let moneyPaid = 0;

  for (const row of postedRows) {
    if (row.creditAmount !== null) moneyReceived += row.creditAmount;
    if (row.debitAmount !== null) moneyPaid += row.debitAmount;
  }

  moneyReceived = round2(moneyReceived);
  moneyPaid = round2(moneyPaid);

  const calculatedClosing = round2(openingBalance + moneyReceived - moneyPaid);
  const closingRounded = round2(closingBalance);
  const balanceDifference = round2(calculatedClosing - closingRounded);
  const balanceCheckPassed = Math.abs(balanceDifference) < 0.005;

  return {
    accountType,
    maskedAccountNumber,
    currency,
    periodStart,
    periodEnd,
    openingBalance,
    postedRows,
    pendingRows,
    closingBalance: closingRounded,
    moneyReceived,
    moneyPaid,
    balanceDifference,
    balanceCheckPassed,
  };
}
