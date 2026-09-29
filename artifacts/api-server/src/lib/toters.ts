/**
 * Pure helpers for the Toters sales CSV import.
 *
 * Revenue rule: every imported order's revenue is calculated separately as
 *
 *   calculated_revenue = Items Total × 1,500 ÷ 89,700
 *
 * and treated as USD (no further FX conversion). The result is stored with
 * full precision (numeric(18,8)); only displayed values are rounded to two
 * decimals, and aggregates sum the unrounded stored values then round once.
 *
 * Dedup rule: the normalized Toters `Code` is the primary order identity.
 * Rows without a Code get a content fingerprint from client name + store +
 * exact order timestamp + original Items Total.
 */

import { createHash } from "crypto";

export const TOTERS_SOURCE = "toters";
export const TOTERS_RATE_NUMERATOR = 1500;
export const TOTERS_RATE_DENOMINATOR = 89700;

/** Statuses that contribute revenue. All other statuses are stored but excluded. */
export const TOTERS_REVENUE_STATUS = "arrived";

/** Scale used when persisting calculated revenue (numeric(18,8)). */
export const REVENUE_SCALE = 8;

/**
 * Convert an original Items Total into calculated USD revenue with exact
 * decimal arithmetic, returned as a string with 8 fractional digits
 * (matching the numeric(18,8) storage column).
 *
 * Implementation: Items Total is taken at 4 decimal places (cents×100 —
 * the numeric(14,4) storage precision), then multiplied by 1500/89700 using
 * BigInt with half-up rounding at the 8th decimal, so no float drift can
 * accumulate.
 */
export function calculateTotersRevenue(itemsTotal: number): string {
  if (!Number.isFinite(itemsTotal)) throw new Error("itemsTotal must be finite");
  const negative = itemsTotal < 0;
  const scaled4 = BigInt(Math.round(Math.abs(itemsTotal) * 10_000)); // items total at scale 4
  // revenue = itemsTotal * N / D; compute at scale 8:
  //   scaled8 = scaled4 * N * 10^4 / D   (half-up)
  const numer = scaled4 * BigInt(TOTERS_RATE_NUMERATOR) * 10_000n;
  const denom = BigInt(TOTERS_RATE_DENOMINATOR);
  const q = numer / denom;
  const r = numer % denom;
  const rounded = r * 2n >= denom ? q + 1n : q;
  const abs = formatScaled(rounded, REVENUE_SCALE);
  return negative ? `-${abs}` : abs;
}

function formatScaled(v: bigint, scale: number): string {
  const s = v.toString().padStart(scale + 1, "0");
  return `${s.slice(0, -scale)}.${s.slice(-scale)}`;
}

/** Round a numeric value to 2 decimals for display (half-up, float-safe). */
export function roundDisplay(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

/**
 * Sum full-precision revenue strings (as produced by calculateTotersRevenue
 * or read back from numeric(18,8) columns) without float drift, returning
 * the unrounded sum as a scale-8 string.
 */
export function sumRevenueStrings(values: readonly string[]): string {
  let total = 0n;
  for (const v of values) total += parseScaled(v, REVENUE_SCALE);
  const negative = total < 0n;
  const abs = formatScaled(negative ? -total : total, REVENUE_SCALE);
  return negative ? `-${abs}` : abs;
}

function parseScaled(value: string, scale: number): bigint {
  const trimmed = value.trim();
  const negative = trimmed.startsWith("-");
  const body = negative ? trimmed.slice(1) : trimmed;
  const [intPart, fracPart = ""] = body.split(".");
  const frac = (fracPart + "0".repeat(scale)).slice(0, scale);
  // Round half-up on the first dropped digit, if any.
  const dropped = fracPart.length > scale ? fracPart.charCodeAt(scale) - 48 : 0;
  let v = BigInt(intPart || "0") * BigInt(10 ** scale) + BigInt(frac || "0");
  if (dropped >= 5) v += 1n;
  return negative ? -v : v;
}

/** Display string (2 decimals) for a scale-8 revenue string. Rounds once. */
export function displayRevenue(scale8: string): number {
  const v = parseScaled(scale8, REVENUE_SCALE);
  const negative = v < 0n;
  const abs = negative ? -v : v;
  const factor = BigInt(10 ** (REVENUE_SCALE - 2));
  const q = abs / factor;
  const r = abs % factor;
  const cents = r * 2n >= factor ? q + 1n : q;
  return (negative ? -Number(cents) : Number(cents)) / 100;
}

/** Normalize a Toters order Code for uniqueness: trim + uppercase. Empty → null. */
export function normalizeTotersCode(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (s === "") return null;
  return s.toUpperCase();
}

/** Normalize a status value: trim + lowercase. */
export function normalizeTotersStatus(raw: unknown): string {
  return String(raw ?? "").trim().toLowerCase();
}

/**
 * Deduplication fingerprint. When a Code exists the fingerprint is derived
 * from it (so the code and fingerprint unique indexes agree); otherwise it
 * hashes client name + store + exact order timestamp + original items total.
 */
export function buildTotersFingerprint(input: {
  code: string | null;
  clientFirstName: string | null;
  store: string | null;
  orderTime: Date | null;
  itemsTotal: number;
}): string {
  if (input.code) return `code:${input.code}`;
  const parts = [
    (input.clientFirstName ?? "").trim().toLowerCase(),
    (input.store ?? "").trim().toLowerCase(),
    input.orderTime ? input.orderTime.toISOString() : "",
    input.itemsTotal.toFixed(4),
  ].join("|");
  return `fp:${createHash("sha256").update(parts).digest("hex")}`;
}

/**
 * Parse a spreadsheet cell into a Date. Accepts Date instances (xlsx),
 * ISO-8601 strings, and "YYYY-MM-DD HH:mm[:ss]" (treated as UTC).
 * Returns null when empty or unparseable.
 */
export function parseTotersTimestamp(raw: unknown): Date | null {
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw;
  const s = String(raw).trim();
  if (s === "") return null;
  // "YYYY-MM-DD HH:mm[:ss]" → treat as UTC to keep imports deterministic.
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/.exec(s);
  const candidate = m ? `${m[1]}T${m[2]}Z` : s;
  const d = new Date(candidate);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Parse an Items Total cell ("4,200.00", 4200, " 12.5 ") into a number, or null. */
export function parseItemsTotal(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  const s = String(raw).trim().replace(/,/g, "");
  if (s === "") return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

// ---------------------------------------------------------------------------
// CSV row model + validation
// ---------------------------------------------------------------------------

export type TotersParsedRow = {
  /** 1-indexed spreadsheet row number (header is row 1). */
  rowIndex: number;
  code: string | null;
  clientFirstName: string | null;
  store: string | null;
  status: string;
  orderTime: Date | null;
  deliveryTime: Date | null;
  arrivedTime: Date | null;
  approvedTime: Date | null;
  markedReadyTime: Date | null;
  itemsTotal: number;
  /** Full-precision calculated USD revenue (scale-8 string). */
  calculatedRevenue: string;
  fingerprint: string;
};

export type TotersInvalidRow = { row: number; reason: string };

export const TOTERS_REQUIRED_COLUMNS = [
  "code",
  "client first name",
  "store",
  "status",
  "order time",
  "items total",
] as const;

export type TotersHeaderIndex = Record<
  | "code"
  | "clientFirstName"
  | "store"
  | "status"
  | "orderTime"
  | "deliveryTime"
  | "arrivedTime"
  | "approvedTime"
  | "markedReadyTime"
  | "itemsTotal",
  number
>;

/**
 * Map the header row to column indexes. Returns the missing required column
 * names (empty array = header is valid).
 */
export function mapTotersHeader(headerRow: unknown[]): {
  columns: TotersHeaderIndex;
  missing: string[];
} {
  const normalized = headerRow.map((h) => String(h ?? "").trim().toLowerCase());
  const idx = (...names: string[]): number => {
    for (const n of names) {
      const i = normalized.indexOf(n);
      if (i !== -1) return i;
    }
    return -1;
  };
  const columns: TotersHeaderIndex = {
    code: idx("code"),
    clientFirstName: idx("client first name", "client_first_name"),
    store: idx("store"),
    status: idx("status"),
    orderTime: idx("order time", "order_time"),
    deliveryTime: idx("delivery time", "delivery_time"),
    arrivedTime: idx("arrived time", "arrived_time"),
    approvedTime: idx("approved on", "approved_on", "approved time"),
    markedReadyTime: idx("marked as ready time", "marked_as_ready_time", "marked ready time"),
    itemsTotal: idx("items total", "items_total"),
  };
  const missing: string[] = [];
  if (columns.code === -1) missing.push("Code");
  if (columns.clientFirstName === -1) missing.push("Client First Name");
  if (columns.store === -1) missing.push("Store");
  if (columns.status === -1) missing.push("status");
  if (columns.orderTime === -1) missing.push("Order Time");
  if (columns.itemsTotal === -1) missing.push("Items Total");
  return { columns, missing };
}

/**
 * Parse and validate all data rows (rows[1..]) of a Toters CSV.
 * Blank rows are skipped silently; rows with data problems are reported in
 * `invalid` with a machine-readable reason.
 */
export function parseTotersRows(
  rows: unknown[][],
  columns: TotersHeaderIndex,
): { parsed: TotersParsedRow[]; invalid: TotersInvalidRow[] } {
  const parsed: TotersParsedRow[] = [];
  const invalid: TotersInvalidRow[] = [];

  const cell = (row: unknown[], idx: number): unknown =>
    idx === -1 ? null : row[idx] ?? null;
  const cellText = (row: unknown[], idx: number): string | null => {
    const v = cell(row, idx);
    const s = String(v ?? "").trim();
    return s === "" ? null : s;
  };

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 1;
    const hasData = row.some((c) => String(c ?? "").trim() !== "");
    if (!hasData) continue;

    const code = normalizeTotersCode(cell(row, columns.code));
    const clientFirstName = cellText(row, columns.clientFirstName);
    const store = cellText(row, columns.store);
    const status = normalizeTotersStatus(cell(row, columns.status));
    const orderTimeRaw = cell(row, columns.orderTime);
    const orderTime = parseTotersTimestamp(orderTimeRaw);
    const itemsTotal = parseItemsTotal(cell(row, columns.itemsTotal));

    if (status === "") {
      invalid.push({ row: rowNum, reason: "missing_status" });
      continue;
    }
    if (itemsTotal === null || itemsTotal < 0) {
      invalid.push({ row: rowNum, reason: "invalid_items_total" });
      continue;
    }
    if (orderTime === null) {
      invalid.push({
        row: rowNum,
        reason:
          orderTimeRaw === null || String(orderTimeRaw ?? "").trim() === ""
            ? "missing_order_time"
            : "invalid_order_time",
      });
      continue;
    }
    // Rows with no Code need enough content for a stable fingerprint.
    if (!code && !clientFirstName && !store) {
      invalid.push({ row: rowNum, reason: "missing_code_and_identity" });
      continue;
    }

    parsed.push({
      rowIndex: rowNum,
      code,
      clientFirstName,
      store,
      status,
      orderTime,
      deliveryTime: parseTotersTimestamp(cell(row, columns.deliveryTime)),
      arrivedTime: parseTotersTimestamp(cell(row, columns.arrivedTime)),
      approvedTime: parseTotersTimestamp(cell(row, columns.approvedTime)),
      markedReadyTime: parseTotersTimestamp(cell(row, columns.markedReadyTime)),
      itemsTotal,
      calculatedRevenue: calculateTotersRevenue(itemsTotal),
      fingerprint: buildTotersFingerprint({
        code,
        clientFirstName,
        store,
        orderTime,
        itemsTotal,
      }),
    });
  }

  return { parsed, invalid };
}

/**
 * Split parsed rows into unique rows and in-file duplicates. The first
 * occurrence of a fingerprint wins; later occurrences are duplicates.
 */
export function dedupeWithinFile(parsed: readonly TotersParsedRow[]): {
  unique: TotersParsedRow[];
  duplicates: TotersParsedRow[];
} {
  const seen = new Set<string>();
  const unique: TotersParsedRow[] = [];
  const duplicates: TotersParsedRow[] = [];
  for (const row of parsed) {
    if (seen.has(row.fingerprint)) {
      duplicates.push(row);
    } else {
      seen.add(row.fingerprint);
      unique.push(row);
    }
  }
  return { unique, duplicates };
}
