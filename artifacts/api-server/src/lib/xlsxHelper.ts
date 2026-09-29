/**
 * Spreadsheet helper using ExcelJS.
 * Replaces the abandoned xlsx (SheetJS) package to avoid CVE-2023-30533 / CVE-2024-22363.
 */
import ExcelJS from "exceljs";
import { Readable } from "node:stream";

type CellValue =
  | string
  | number
  | boolean
  | Date
  | ExcelJS.CellErrorValue
  | ExcelJS.CellRichTextValue
  | ExcelJS.CellHyperlinkValue
  | ExcelJS.CellFormulaValue
  | ExcelJS.CellSharedFormulaValue
  | null;

function resolveCellValue(cell: ExcelJS.Cell): unknown {
  const v = cell.value as CellValue;
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === "object") {
    if ("richText" in v) return (v as ExcelJS.CellRichTextValue).richText.map((r) => r.text).join("");
    if ("result" in v) return (v as ExcelJS.CellFormulaValue).result ?? null;
    if ("hyperlink" in v) return (v as ExcelJS.CellHyperlinkValue).text ?? null;
    if ("error" in v) return null;
    // shared formula
    if ("sharedFormula" in v) return (v as unknown as { result?: unknown }).result ?? null;
  }
  return v;
}

function formatDateYMD(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Returns true if the buffer is an Office Open XML (xlsx/xls) file.
 * xlsx files start with PK magic bytes (0x50 0x4b).
 */
function isXlsxBuffer(buffer: Buffer): boolean {
  return buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b;
}

async function loadWorkbook(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  if (isXlsxBuffer(buffer)) {
    // ExcelJS types reference the older Buffer without generic; cast via unknown to satisfy both sides.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (workbook.xlsx.load as any)(buffer);
  } else {
    // Treat as CSV
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (workbook.csv.read as any)(Readable.from(buffer));
  }
  return workbook;
}

/**
 * Parse a spreadsheet (xlsx or csv) buffer into an array of row objects,
 * where keys are taken from the first (header) row.
 *
 * Replaces: XLSX.read + XLSX.utils.sheet_to_json(sheet, { defval, raw: false, dateNF: "YYYY-MM-DD" })
 */
export async function parseSpreadsheetToJson(
  buffer: Buffer,
  opts: { defval?: unknown } = {},
): Promise<Record<string, unknown>[]> {
  const workbook = await loadWorkbook(buffer);
  const ws = workbook.worksheets[0];
  if (!ws) return [];

  const colCount = ws.columnCount;
  const headerRow = ws.getRow(1);
  const headers: string[] = [];
  for (let c = 1; c <= colCount; c++) {
    const val = resolveCellValue(headerRow.getCell(c));
    headers.push(String(val ?? ""));
  }

  const rows: Record<string, unknown>[] = [];
  ws.eachRow((row, rowNum) => {
    if (rowNum === 1) return; // skip header
    const obj: Record<string, unknown> = {};
    for (let c = 1; c <= colCount; c++) {
      let val = resolveCellValue(row.getCell(c));
      if (val === null || val === undefined) {
        val = opts.defval ?? null;
      } else if (val instanceof Date) {
        val = formatDateYMD(val);
      }
      obj[headers[c - 1]] = val;
    }
    rows.push(obj);
  });

  return rows;
}

/**
 * Parse a spreadsheet (xlsx or csv) buffer into an array of string arrays
 * (including the header row as the first element).
 *
 * Replaces: XLSX.read + XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" })
 */
export async function parseSpreadsheetToRows(buffer: Buffer, defval = ""): Promise<string[][]> {
  const workbook = await loadWorkbook(buffer);
  const ws = workbook.worksheets[0];
  if (!ws) return [];

  const colCount = ws.columnCount;
  const result: string[][] = [];
  ws.eachRow((row, _rowNum) => {
    const arr: string[] = [];
    for (let c = 1; c <= colCount; c++) {
      const val = resolveCellValue(row.getCell(c));
      if (val === null || val === undefined) {
        arr.push(defval);
      } else if (val instanceof Date) {
        arr.push(formatDateYMD(val));
      } else {
        arr.push(String(val));
      }
    }
    result.push(arr);
  });

  return result;
}

/**
 * Build an xlsx buffer from one or more named sheets of JSON row data.
 *
 * Replaces: XLSX.utils.book_new + json_to_sheet + book_append_sheet + XLSX.write
 */
export async function writeXlsx(sheets: { name: string; data: Record<string, unknown>[] }[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  for (const { name, data } of sheets) {
    const ws = workbook.addWorksheet(name);
    if (data.length === 0) continue;
    const columns = Object.keys(data[0]);
    ws.columns = columns.map((key) => ({ header: key, key }));
    for (const row of data) {
      ws.addRow(row);
    }
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
