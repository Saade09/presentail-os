/**
 * Controlled migration for orders that predate canonical delivery windows.
 *
 * Commands:
 *   dry-run (default)              report candidates, classifications, and changes
 *   apply                          migrate only unambiguous candidates
 *
 * Optional flags:
 *   --output <path>                write the JSON report without overwriting a file
 *   --workspace-owner-id <id>      limit the report/migration to one workspace
 *
 * This script is intentionally separate from initDb. It must be run by an
 * operator after reviewing the dry-run report.
 */
import { writeFile } from "node:fs/promises";
import { db, withTransaction } from "../lib/db.js";

const PAGE_SIZE = 1_000;
const LEGACY_SLOT_NAMES = /^(morning|afternoon|evening|night)$/i;
const LEGACY_SLOT_RANGE =
  /^(\d{1,2}(?::[0-5]\d)?\s*(?:am|pm)?)\s*(?:–|—|-|\bto\b)\s*(\d{1,2}(?::[0-5]\d)?\s*(?:am|pm)?)$/i;

export type NormalizationMode = "dry-run" | "apply";

export type NormalizationOptions = {
  mode: NormalizationMode;
  outputPath?: string;
  workspaceOwnerId?: string;
};

export type LegacyOrderRow = {
  id: string;
  workspace_owner_id: string;
  window_start: string | null;
  window_end: string | null;
  legacy_date: string | null;
  legacy_slot: string | null;
  city_matches: Array<{ id: number; timezone: string; match_rank: number }> | null;
};

export type NormalizationClassification =
  | "valid"
  | "invalid"
  | "ambiguous";

export type NormalizationDecision = {
  order_id: string;
  workspace_owner_id: string;
  classification: NormalizationClassification;
  reasons: string[];
  legacy_date: string | null;
  legacy_slot: string | null;
  timezone: string | null;
  window_start: string | null;
  window_end: string | null;
};

export type NormalizationReport = {
  report_version: 1;
  generated_at: string;
  mode: NormalizationMode;
  workspace_owner_id: string | null;
  summary: {
    candidate_rows: number;
    valid_rows: number;
    invalid_rows: number;
    ambiguous_rows: number;
    migrated_rows: number;
    skipped_due_to_concurrent_change: number;
  };
  decisions: NormalizationDecision[];
};

type Queryable = {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
};

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseCalendarDate(value: unknown): string | null {
  const raw = nonEmptyString(value);
  if (!raw) return null;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (dateOnly) {
    const date = new Date(
      Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])),
    );
    if (
      date.getUTCFullYear() !== Number(dateOnly[1]) ||
      date.getUTCMonth() !== Number(dateOnly[2]) - 1 ||
      date.getUTCDate() !== Number(dateOnly[3])
    ) {
      return null;
    }
    return raw;
  }

  const timestamp = new Date(raw);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString().slice(0, 10);
}

function parseTimeToken(value: string): { minutes: number; hasMeridiem: boolean } | null {
  const match = /^(\d{1,2})(?::([0-5]\d))?\s*(am|pm)?$/i.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const meridiem = match[3]?.toLowerCase();
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    return {
      minutes: ((hour % 12) + (meridiem === "pm" ? 12 : 0)) * 60 + minute,
      hasMeridiem: true,
    };
  }
  if (hour > 23) return null;
  return { minutes: hour * 60 + minute, hasMeridiem: false };
}

function parseLegacySlot(value: unknown):
  | { kind: "named"; value: string }
  | { kind: "range"; startMinutes: number; endMinutes: number }
  | { kind: "invalid" } {
  const raw = nonEmptyString(value);
  if (!raw) return { kind: "invalid" };
  if (LEGACY_SLOT_NAMES.test(raw)) return { kind: "named", value: raw };

  const match = LEGACY_SLOT_RANGE.exec(raw);
  if (!match) return { kind: "invalid" };
  const start = parseTimeToken(match[1]);
  const end = parseTimeToken(match[2]);
  if (!start || !end) return { kind: "invalid" };

  // A single meridiem on a range such as "9 - 12 PM" does not identify the
  // start half of the day reliably. The web resolver may display this legacy
  // value, but a destructive migration must send it for manual review.
  if (start.hasMeridiem !== end.hasMeridiem) return { kind: "invalid" };
  return {
    kind: "range",
    startMinutes: start.minutes,
    endMinutes: end.minutes,
  };
}

function isValidTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

function addOneDay(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

/**
 * Convert a local calendar date/time to an ISO instant without relying on the
 * machine timezone. This mirrors the order rescheduling path.
 */
function zonedDateTimeToIso(date: string, minutes: number, timezone: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const desiredUtc = Date.UTC(year, month - 1, day, Math.floor(minutes / 60), minutes % 60);
  let guess = desiredUtc;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = formatter.formatToParts(new Date(guess));
    const get = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((part) => part.type === type)?.value ?? 0);
    const representedUtc = Date.UTC(
      get("year"),
      get("month") - 1,
      get("day"),
      get("hour"),
      get("minute"),
    );
    guess += desiredUtc - representedUtc;
  }
  return new Date(guess).toISOString();
}

export function parseNormalizationOptions(
  argv: string[] = process.argv.slice(2),
): NormalizationOptions {
  let mode: NormalizationMode = "dry-run";
  let outputPath: string | undefined;
  let workspaceOwnerId: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "dry-run" || arg === "--dry-run") {
      mode = "dry-run";
    } else if (arg === "apply" || arg === "--apply") {
      mode = "apply";
    } else if (arg === "--output") {
      outputPath = argv[++index];
      if (!outputPath) throw new Error("--output requires a path");
    } else if (arg === "--workspace-owner-id") {
      workspaceOwnerId = argv[++index];
      if (!workspaceOwnerId) throw new Error("--workspace-owner-id requires a value");
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { mode, outputPath, workspaceOwnerId };
}

export function classifyLegacyOrder(row: LegacyOrderRow): NormalizationDecision {
  const reasons: string[] = [];
  const date = parseCalendarDate(row.legacy_date);
  const slot = parseLegacySlot(row.legacy_slot);
  const matches = row.city_matches ?? [];
  const bestMatchRank = matches.length > 0
    ? Math.min(...matches.map((match) => match.match_rank))
    : null;
  const bestMatches = bestMatchRank === null
    ? []
    : matches.filter((match) => match.match_rank === bestMatchRank);
  const timezone = bestMatches.length === 1 ? nonEmptyString(bestMatches[0]?.timezone) : null;

  if (!nonEmptyString(row.legacy_date)) reasons.push("missing_date");
  else if (!date) reasons.push("malformed_date");

  if (!nonEmptyString(row.legacy_slot)) reasons.push("missing_slot");
  else if (slot.kind === "invalid") reasons.push("malformed_or_ambiguous_slot");
  else if (slot.kind === "named") reasons.push("named_slot_has_no_exact_window");

  if (matches.length === 0) reasons.push("delivery_city_not_resolved");
  else if (bestMatches.length > 1) reasons.push("delivery_city_is_ambiguous");
  else if (!timezone || !isValidTimeZone(timezone)) reasons.push("delivery_timezone_invalid");

  if (date && slot.kind === "range" && bestMatches.length === 1 && timezone && isValidTimeZone(timezone)) {
    const endDate = slot.endMinutes <= slot.startMinutes ? addOneDay(date) : date;
    return {
      order_id: row.id,
      workspace_owner_id: row.workspace_owner_id,
      classification: "valid",
      reasons: [],
      legacy_date: row.legacy_date,
      legacy_slot: row.legacy_slot,
      timezone,
      window_start: zonedDateTimeToIso(date, slot.startMinutes, timezone),
      window_end: zonedDateTimeToIso(endDate, slot.endMinutes, timezone),
    };
  }

  const classification: NormalizationClassification =
    reasons.some((reason) =>
      ["named_slot_has_no_exact_window", "delivery_city_not_resolved", "delivery_city_is_ambiguous", "delivery_timezone_invalid"].includes(reason),
    )
      ? "ambiguous"
      : "invalid";
  return {
    order_id: row.id,
    workspace_owner_id: row.workspace_owner_id,
    classification,
    reasons,
    legacy_date: row.legacy_date,
    legacy_slot: row.legacy_slot,
    timezone,
    window_start: null,
    window_end: null,
  };
}

const CANDIDATE_QUERY = `
  SELECT
    o.id,
    o.workspace_owner_id,
    o.window_start,
    o.window_end,
    o.delivery_address->>'date' AS legacy_date,
    o.delivery_address->>'slot' AS legacy_slot,
    (
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', candidate.id,
          'timezone', candidate.timezone,
          'match_rank', candidate.match_rank
        )
        ORDER BY candidate.match_rank, candidate.id
      )
      FROM (
        SELECT
          dc.id,
          COALESCE(NULLIF(to_jsonb(dc)->>'delivery_timezone', ''), 'UTC') AS timezone,
          CASE
            WHEN NULLIF(btrim(o.delivery_address->>'cityId'), '') = dc.id::text
              OR lower(NULLIF(btrim(o.delivery_address->>'cityId'), '')) = lower(dc.slug) THEN 0
            WHEN NULLIF(btrim(o.delivery_address->>'city_id'), '') = dc.id::text
              OR lower(NULLIF(btrim(o.delivery_address->>'city_id'), '')) = lower(dc.slug) THEN 1
            WHEN lower(NULLIF(btrim(o.delivery_address->>'cityName'), '')) = lower(dc.name) THEN 2
            WHEN lower(NULLIF(btrim(o.delivery_address->>'city'), '')) = lower(dc.name) THEN 3
            ELSE 4
          END AS match_rank
        FROM delivery_cities dc
        WHERE dc.workspace_owner_id = o.workspace_owner_id
          AND (
            NULLIF(btrim(o.delivery_address->>'cityId'), '') = dc.id::text
            OR lower(NULLIF(btrim(o.delivery_address->>'cityId'), '')) = lower(dc.slug)
            OR NULLIF(btrim(o.delivery_address->>'city_id'), '') = dc.id::text
            OR lower(NULLIF(btrim(o.delivery_address->>'city_id'), '')) = lower(dc.slug)
            OR lower(NULLIF(btrim(o.delivery_address->>'cityName'), '')) = lower(dc.name)
            OR lower(NULLIF(btrim(o.delivery_address->>'city'), '')) = lower(dc.name)
            OR lower(NULLIF(btrim(o.delivery_address->>'district'), '')) = lower(dc.name)
          )
      ) candidate
    ) AS city_matches
  FROM orders o
  WHERE o.id > $1::uuid
    AND o.window_start IS NULL
    AND o.window_end IS NULL
    AND o.delivery_address IS NOT NULL
    AND (
      NULLIF(btrim(o.delivery_address->>'date'), '') IS NOT NULL
      OR NULLIF(btrim(o.delivery_address->>'slot'), '') IS NOT NULL
    )
    AND ($2::text IS NULL OR o.workspace_owner_id = $2)
  ORDER BY o.id
  LIMIT $3
`;

function normalizeCityMatches(value: unknown): LegacyOrderRow["city_matches"] {
  if (!Array.isArray(value)) return null;
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const record = candidate as Record<string, unknown>;
    const id = Number(record.id);
    const timezone = typeof record.timezone === "string" ? record.timezone : "";
    const matchRank = Number(record.match_rank);
    return Number.isInteger(id) && timezone && Number.isInteger(matchRank)
      ? [{ id, timezone, match_rank: matchRank }]
      : [];
  });
}

export async function readLegacyOrderPage(
  queryable: Queryable,
  lastId: string,
  workspaceOwnerId?: string,
): Promise<LegacyOrderRow[]> {
  const result = await queryable.query<LegacyOrderRow>(CANDIDATE_QUERY, [
    lastId,
    workspaceOwnerId ?? null,
    PAGE_SIZE,
  ]);
  return result.rows.map((row) => ({
    ...row,
    city_matches: normalizeCityMatches(row.city_matches),
  }));
}

export async function buildNormalizationReport(
  queryable: Queryable,
  options: { mode: NormalizationMode; workspaceOwnerId?: string },
): Promise<NormalizationReport> {
  const decisions: NormalizationDecision[] = [];
  let lastId = "00000000-0000-0000-0000-000000000000";

  for (;;) {
    const rows = await readLegacyOrderPage(queryable, lastId, options.workspaceOwnerId);
    if (rows.length === 0) break;
    for (const row of rows) {
      decisions.push(classifyLegacyOrder(row));
      lastId = row.id;
    }
  }

  const validRows = decisions.filter((decision) => decision.classification === "valid");
  return {
    report_version: 1,
    generated_at: new Date().toISOString(),
    mode: options.mode,
    workspace_owner_id: options.workspaceOwnerId ?? null,
    summary: {
      candidate_rows: decisions.length,
      valid_rows: validRows.length,
      invalid_rows: decisions.filter((decision) => decision.classification === "invalid").length,
      ambiguous_rows: decisions.filter((decision) => decision.classification === "ambiguous").length,
      migrated_rows: 0,
      skipped_due_to_concurrent_change: 0,
    },
    decisions,
  };
}

export async function applyNormalization(
  queryable: Queryable,
  report: NormalizationReport,
): Promise<NormalizationReport> {
  let migratedRows = 0;
  let skippedDueToConcurrentChange = 0;
  for (const decision of report.decisions) {
    if (decision.classification !== "valid") continue;
    const result = await queryable.query(
      `UPDATE orders
          SET window_start = $1::timestamptz,
              window_end = $2::timestamptz,
              updated_at = now()
        WHERE id = $3::uuid
          AND workspace_owner_id = $4
          AND window_start IS NULL
          AND window_end IS NULL`,
      [
        decision.window_start,
        decision.window_end,
        decision.order_id,
        decision.workspace_owner_id,
      ],
    );
    if ((result.rowCount ?? 0) === 1) migratedRows++;
    else skippedDueToConcurrentChange++;
  }
  return {
    ...report,
    summary: {
      ...report.summary,
      migrated_rows: migratedRows,
      skipped_due_to_concurrent_change: skippedDueToConcurrentChange,
    },
  };
}

async function writeReport(report: NormalizationReport, outputPath?: string): Promise<void> {
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath) {
    await writeFile(outputPath, serialized, { encoding: "utf8", flag: "wx" });
  } else {
    console.log(serialized);
  }
}

async function main(): Promise<void> {
  const options = parseNormalizationOptions();
  const report = await buildNormalizationReport(db, options);
  if (options.mode === "apply") {
    const client = await db.connect();
    try {
      const applied = await withTransaction(client, () => applyNormalization(client, report));
      await writeReport(applied, options.outputPath);
    } finally {
      client.release();
    }
  } else {
    await writeReport(report, options.outputPath);
  }
}

if (process.argv[1]?.endsWith("normalize-order-delivery-schedules.ts")) {
  await main().finally(() => db.end());
}