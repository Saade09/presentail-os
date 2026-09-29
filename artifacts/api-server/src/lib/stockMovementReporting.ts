import { z } from "zod";
import { OPERATIONAL_MOVEMENT_TYPES } from "./inventoryService";
import type { WorkspaceRequest } from "./workspace";

const REPORT_MOVEMENT_TYPES = [
  ...OPERATIONAL_MOVEMENT_TYPES,
  "purchase_received",
  "receive",
  "wastage",
  "cutover_baseline",
] as const;

const stockMovementQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    locationId: z.preprocess(
      (value) => value === "" || value == null ? undefined : value,
      z.coerce.number().int().positive().optional(),
    ),
    movementType: z.preprocess(
      (value) => value === "" || value == null ? undefined : value,
      z.enum(REPORT_MOVEMENT_TYPES).optional(),
    ),
    from: z.preprocess(
      (value) => value === "" || value == null ? undefined : value,
      z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    ),
    to: z.preprocess(
      (value) => value === "" || value == null ? undefined : value,
      z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    ),
    tz: z.preprocess(
      (value) => value === "" || value == null ? "UTC" : value,
      z.string().min(1).max(100).default("UTC"),
    ),
    country: z.preprocess(
      (value) => typeof value === "string" && value.trim() ? value.trim() : undefined,
      z.string().max(100).optional(),
    ),
    q: z.preprocess(
      (value) => typeof value === "string" && value.trim() ? value.trim() : undefined,
      z.string().max(200).optional(),
    ),
    sortBy: z.enum(["date", "type", "reference", "location", "quantity", "balance"]).default("date"),
    sortDirection: z.enum(["asc", "desc"]).default("desc"),
  })
  .superRefine((value, ctx) => {
    if (value.from && value.to && value.from > value.to) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["to"],
        message: "to must be on or after from",
      });
    }
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value.tz }).format();
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tz"],
        message: "Invalid IANA timezone",
      });
    }
  });

export type StockMovementFilters = z.infer<typeof stockMovementQuerySchema> & {
  permittedLocationIds: number[] | null;
};

export type StockMovementQueryResult =
  | { ok: true; filters: StockMovementFilters }
  | { ok: false; status: 400 | 403; error: string };

export function canViewStockMovementLedger(wreq: WorkspaceRequest): boolean {
  return wreq.workspaceRole === "owner"
    || (wreq.allowedPages?.includes("base_items.view") ?? false)
    || (wreq.allowedPages?.includes("base_items.manage") ?? false);
}

/**
 * The list and CSV export intentionally share this boundary. It validates every
 * supported report option and resolves the member's location scope before any
 * ledger query is assembled.
 */
export function resolveStockMovementQuery(
  query: Record<string, unknown>,
  wreq: WorkspaceRequest,
): StockMovementQueryResult {
  if (!canViewStockMovementLedger(wreq)) {
    return { ok: false, status: 403, error: "forbidden" };
  }

  const parsed = stockMovementQuerySchema.safeParse(query);
  if (!parsed.success) {
    return { ok: false, status: 400, error: "Invalid stock movement filters" };
  }

  const permittedLocationIds =
    wreq.assignedLocationIds !== null && wreq.assignedLocationIds.length > 0
      ? [...new Set(wreq.assignedLocationIds)]
      : null;

  if (
    parsed.data.locationId != null
    && permittedLocationIds
    && !permittedLocationIds.includes(parsed.data.locationId)
  ) {
    return { ok: false, status: 403, error: "Location access denied" };
  }

  return {
    ok: true,
    filters: {
      ...parsed.data,
      permittedLocationIds,
    },
  };
}

export function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  return `"${String(value).replace(/"/g, '""')}"`;
}

/**
 * Spreadsheet applications may execute CSV text beginning with formula
 * operators. Prefix those cells with a literal apostrophe before normal CSV
 * escaping; the apostrophe is treated as text rather than a formula.
 */
export function escapeCsvTextCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const raw = String(value);
  const safe = /^\s*[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return escapeCsvCell(safe);
}