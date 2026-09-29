/**
 * Pure logic for the Orders board (Kanban) view: column bucketing, sort
 * ordering, and drag-and-drop transition validation. Kept dependency-free of
 * React/network so it is exhaustively unit-testable and so `OrdersBoard.tsx`
 * stays focused on rendering.
 */
import { normalizeOrderStatus } from "@/lib/orderStatus";
import { STEPPER_FLOW } from "@/components/OrderStatusStepper";
import { computePunctuality, type PunctualityVerdict } from "@/lib/orderPunctuality";
import { getUrgency, isAtRiskOrder, type OrderRow } from "./orderRowHelpers";

export const BOARD_COLUMNS = [
  { key: "processing", statuses: ["pending", "processing"] },
  { key: "preparing", statuses: ["preparing"] },
  { key: "ready_for_delivery", statuses: ["ready_for_delivery"] },
  { key: "out_for_delivery", statuses: ["out_for_delivery"] },
  { key: "completed", statuses: ["completed"] },
] as const;

export type BoardColumnKey = (typeof BOARD_COLUMNS)[number]["key"];

export const BOARD_COLUMN_KEYS: readonly BoardColumnKey[] = BOARD_COLUMNS.map((c) => c.key);

/** The concrete status a card is moved to when dropped on a given column. */
export const COLUMN_TARGET_STATUS: Record<BoardColumnKey, string> = {
  processing: "processing",
  preparing: "preparing",
  ready_for_delivery: "ready_for_delivery",
  out_for_delivery: "out_for_delivery",
  completed: "completed",
};

const STATUS_TO_COLUMN: Partial<Record<string, BoardColumnKey>> = {};
for (const col of BOARD_COLUMNS) {
  for (const status of col.statuses) STATUS_TO_COLUMN[status] = col.key;
}

/**
 * Maps a raw order status to its board column, or null for statuses the
 * board doesn't represent (cancelled/on_hold/refunded — those stay list-only).
 */
export function getBoardColumnKey(status: string): BoardColumnKey | null {
  return STATUS_TO_COLUMN[normalizeOrderStatus(status)] ?? null;
}

/** Buckets a set of orders into their board columns, dropping unrepresented statuses. */
export function bucketOrdersByColumn(
  orders: OrderRow[],
  overrideStatusById?: Map<string, string>,
): Record<BoardColumnKey, OrderRow[]> {
  const buckets = Object.fromEntries(BOARD_COLUMN_KEYS.map((k) => [k, [] as OrderRow[]])) as Record<
    BoardColumnKey,
    OrderRow[]
  >;
  for (const order of orders) {
    const effectiveStatus = overrideStatusById?.get(order.id) ?? order.status;
    const col = getBoardColumnKey(effectiveStatus);
    if (col) buckets[col].push(order);
  }
  return buckets;
}

/** Re-exported for board sorting/badges — a single source of truth with the list's At Risk card. */
export { isAtRiskOrder };

/**
 * Active-column sort: At Risk/late orders first, then by soonest delivery
 * window end (orders with no resolvable window sort last).
 */
export function compareActiveOrders(a: OrderRow, b: OrderRow, nowMs: number): number {
  const riskA = isAtRiskOrder(a, nowMs) ? 0 : 1;
  const riskB = isAtRiskOrder(b, nowMs) ? 0 : 1;
  if (riskA !== riskB) return riskA - riskB;
  const endA = getUrgency(a, nowMs).endMs ?? Number.MAX_SAFE_INTEGER;
  const endB = getUrgency(b, nowMs).endMs ?? Number.MAX_SAFE_INTEGER;
  if (endA !== endB) return endA - endB;
  return a.id.localeCompare(b.id);
}

/** Completed-column sort: most-recently-completed first, undated completions last. */
export function compareCompletedOrders(a: OrderRow, b: OrderRow): number {
  const da = a.delivered_at ? Date.parse(a.delivered_at) : NaN;
  const db = b.delivered_at ? Date.parse(b.delivered_at) : NaN;
  const hasA = Number.isFinite(da);
  const hasB = Number.isFinite(db);
  if (hasA && hasB) return db - da;
  if (hasA) return -1;
  if (hasB) return 1;
  return Date.parse(b.created_at) - Date.parse(a.created_at);
}

/** Sorts a column's orders using the appropriate comparator for its stage. */
export function sortColumnOrders(
  columnKey: BoardColumnKey,
  orders: OrderRow[],
  nowMs: number,
): OrderRow[] {
  const copy = [...orders];
  if (columnKey === "completed") {
    copy.sort(compareCompletedOrders);
  } else {
    copy.sort((a, b) => compareActiveOrders(a, b, nowMs));
  }
  return copy;
}

// ---------------------------------------------------------------------------
// Drag-and-drop transition validation
// ---------------------------------------------------------------------------

export type TransitionKind = "none" | "forward" | "forward-skip" | "backward";

/**
 * Classifies a status change using the same linear fulfilment flow as the
 * order detail stepper. "none" means the statuses map to the same flow step
 * (e.g. dropping a pending order back on the Processing column) — no API
 * call is needed. Statuses outside the flow (cancelled/on_hold/refunded)
 * never appear as drag targets, so they are not handled here.
 */
export function classifyTransition(fromStatus: string, toStatus: string): TransitionKind {
  const flow = STEPPER_FLOW as readonly string[];
  const fromIdx = flow.indexOf(normalizeOrderStatus(fromStatus));
  const toIdx = flow.indexOf(normalizeOrderStatus(toStatus));
  if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return "none";
  if (toIdx < fromIdx) return "backward";
  if (toIdx - fromIdx > 1) return "forward-skip";
  return "forward";
}

/** Statuses whose entry has downstream operational effects and should be confirmed. */
const CONFIRM_ON_ENTER = new Set(["ready_for_delivery", "out_for_delivery", "completed"]);

/**
 * Whether a valid drag-and-drop move should prompt for confirmation before
 * saving: any backward/skip move (already gated to owners), or a forward move
 * into a stage with downstream effects (dispatch, delivery, completion).
 */
export function requiresConfirmation(toStatus: string, kind: TransitionKind): boolean {
  if (kind === "backward" || kind === "forward-skip") return true;
  return CONFIRM_ON_ENTER.has(normalizeOrderStatus(toStatus));
}

/**
 * Whether a plain "orders edit" permission suffices for this move, or whether
 * it additionally requires the elevated (owner) override reserved for
 * backward/skip transitions.
 */
export function isElevatedTransition(kind: TransitionKind): boolean {
  return kind === "backward" || kind === "forward-skip";
}

// ---------------------------------------------------------------------------
// Card display helpers
// ---------------------------------------------------------------------------

export type BoardPunctuality = { verdict: PunctualityVerdict } | null;

/** Completed-card punctuality badge, reusing the shared timezone-aware calculator as-is. */
export function boardPunctuality(order: OrderRow): BoardPunctuality {
  const result = computePunctuality(
    order.delivered_at,
    order.window_start,
    order.window_end,
    order.delivery_timezone || "UTC",
  );
  return { verdict: result.verdict };
}

/** Resolves the district/city text shown on a card, first non-empty field wins. */
export function boardAreaLabel(order: OrderRow): string {
  const addr = order.delivery_address ?? {};
  for (const key of ["district", "city", "area", "locality", "neighborhood"]) {
    const value = addr[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/** Resolves the delivery time-slot label shown on a card. */
export function boardSlotLabel(order: OrderRow): string {
  const addr = order.delivery_address ?? {};
  const slot = addr["slot"];
  return typeof slot === "string" ? slot.trim() : "";
}
