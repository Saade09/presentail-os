/**
 * Canonical order status set — the single source of truth shared by the
 * Orders list filter, the status badges (list + detail), and the order edit
 * form. The backend validation in `routes/orders.ts` accepts exactly this set,
 * so any status selectable in the UI is always persistable.
 */
export const ORDER_STATUSES = [
  "pending",
  "processing",
  "preparing",
  "ready_for_delivery",
  "out_for_delivery",
  "completed",
  "cancelled",
  "on_hold",
  "refunded",
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * Defensive normalization for stale/variant status values before any badge
 * color or label lookup:
 * - lowercases and converts spaces/hyphens to underscores so display-label
 *   variants ("Ready For Delivery", "on-hold") resolve to canonical snake_case
 *   enum keys;
 * - maps the legacy "delivered" status (merged into "completed", data migrated
 *   on server startup) to "completed" for any value cached client-side or
 *   missed by the migration.
 */
export function normalizeOrderStatus(status: string): string {
  const normalized = status.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return normalized === "delivered" ? "completed" : normalized;
}

/**
 * Tailwind classes for each status badge, keyed by canonical snake_case
 * status (always look up via `normalizeOrderStatus`).
 *
 * The five active lifecycle statuses use the approved five-color palette
 * (exact background/text pairs, WCAG AA for normal text); red stays reserved
 * for cancelled/failed states. The explicit `hover:bg-[...]` keeps the badge
 * background stable inside hoverable rows (the base Badge variant otherwise
 * applies its own hover background).
 */
export const ORDER_STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800 border-yellow-200 hover:bg-yellow-100",
  processing: "bg-[#EDE9FE] text-[#6D28D9] border-[#DDD6FE] hover:bg-[#EDE9FE]",
  preparing: "bg-[#FCE7F3] text-[#9D174D] border-[#FBCFE8] hover:bg-[#FCE7F3]",
  ready_for_delivery:
    "bg-[#FEF3C7] text-[#92400E] border-[#FDE68A] hover:bg-[#FEF3C7]",
  out_for_delivery:
    "bg-[#DBEAFE] text-[#1D4ED8] border-[#BFDBFE] hover:bg-[#DBEAFE]",
  completed: "bg-[#DCFCE7] text-[#166534] border-[#BBF7D0] hover:bg-[#DCFCE7]",
  cancelled: "bg-red-100 text-red-800 border-red-200 hover:bg-red-100",
  on_hold: "bg-orange-100 text-orange-800 border-orange-200 hover:bg-orange-100",
  refunded: "bg-purple-100 text-purple-800 border-purple-200 hover:bg-purple-100",
  // Non-lifecycle status seen on ingested/external orders; red is reserved
  // for failure states.
  failed: "bg-red-200 text-red-900 border-red-300 hover:bg-red-200",
};

/** Neutral fallback for unknown/unmapped statuses. */
export const ORDER_STATUS_FALLBACK_CLASS =
  "bg-secondary text-secondary-foreground";

/** Resolve badge classes for any raw status string (normalizes first). */
export function orderStatusBadgeClass(status: string): string {
  return (
    ORDER_STATUS_COLORS[normalizeOrderStatus(status)] ??
    ORDER_STATUS_FALLBACK_CLASS
  );
}

/** i18n key for each status label. */
export const ORDER_STATUS_LABEL_KEYS: Record<OrderStatus, string> = {
  pending: "orders.statusPending",
  processing: "orders.statusProcessing",
  preparing: "orders.statusPreparing",
  ready_for_delivery: "orders.statusReadyForDelivery",
  out_for_delivery: "orders.statusOutForDelivery",
  completed: "orders.statusCompleted",
  cancelled: "orders.statusCancelled",
  on_hold: "orders.statusOnHold",
  refunded: "orders.statusRefunded",
};
