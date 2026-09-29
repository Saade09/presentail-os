/**
 * Maps the stored `orders.tookan_status` label (plus whether a Tookan job id
 * exists) to the badge shown on the Order Detail page.
 *
 * The backend stores human-readable progression labels once Tookan reports
 * progress via webhook/poller: assigned, started, successful, failed,
 * in_progress, unassigned, accepted, declined, cancelled, deleted, or a
 * fallback `status_<n>` for unknown numeric codes. Before any progression is
 * reported the status is one of: created, failed, awaiting_payment (or null).
 */

const GREEN = "bg-green-100 text-green-800 border-green-300 hover:bg-green-100 border text-xs";
const BLUE = "bg-blue-100 text-blue-800 border-blue-300 hover:bg-blue-100 border text-xs";
const RED = "bg-red-100 text-red-800 border-red-300 hover:bg-red-100 border text-xs";
const AMBER = "bg-amber-100 text-amber-800 border-amber-300 hover:bg-amber-100 border text-xs";
const NEUTRAL = "bg-secondary text-secondary-foreground border text-xs";

export interface TookanBadge {
  /** i18n key under the `orders.` namespace, e.g. `orders.tookanStatusCreated`. */
  labelKey: string;
  className: string;
}

const STATUS_BADGES: Record<string, TookanBadge> = {
  created: { labelKey: "orders.tookanStatusCreated", className: GREEN },
  successful: { labelKey: "orders.tookanStatusSuccessful", className: GREEN },
  assigned: { labelKey: "orders.tookanStatusAssigned", className: BLUE },
  started: { labelKey: "orders.tookanStatusStarted", className: BLUE },
  in_progress: { labelKey: "orders.tookanStatusInProgress", className: BLUE },
  arrived: { labelKey: "orders.tookanStatusArrived", className: BLUE },
  accepted: { labelKey: "orders.tookanStatusAccepted", className: BLUE },
  unassigned: { labelKey: "orders.tookanStatusUnassigned", className: AMBER },
  failed: { labelKey: "orders.tookanStatusFailed", className: RED },
  declined: { labelKey: "orders.tookanStatusDeclined", className: RED },
  cancelled: { labelKey: "orders.tookanStatusCancelled", className: RED },
  deleted: { labelKey: "orders.tookanStatusDeleted", className: RED },
  awaiting_payment: { labelKey: "orders.tookanStatusAwaitingPayment", className: AMBER },
};

/**
 * Resolve the Tookan status badge for an order.
 *
 * - Known statuses map to their specific label + color.
 * - Any unrecognized status (e.g. `status_<n>`) on an order that HAS a job id
 *   shows "Created" — never "Not Created".
 * - "Not Created" appears only when there is no job id and the status isn't a
 *   recognized one (failed / awaiting_payment still show even without a job).
 */
export function getTookanStatusBadge(
  status: string | null | undefined,
  jobId: string | number | null | undefined,
): TookanBadge {
  const normalized = (status ?? "").trim().toLowerCase();
  const known = STATUS_BADGES[normalized];
  if (known) return known;
  if (jobId !== null && jobId !== undefined && String(jobId).trim() !== "") {
    return STATUS_BADGES.created;
  }
  return { labelKey: "orders.tookanStatusNotCreated", className: NEUTRAL };
}
