export type BannerStatus = "Draft" | "Inactive" | "Paused" | "Scheduled" | "Live" | "Expired";

export interface BannerStatusInput {
  is_active: boolean;
  activated_at: Date | string | null;
  start_at: Date | string | null;
  end_at: Date | string | null;
  status_override?: string | null;
}

function toMs(value: Date | string | null): number | null {
  if (value === null) return null;
  if (value instanceof Date) return value.getTime();
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

/**
 * Compute the public-facing status of a homepage banner.
 *
 * Rules (in order):
 *   - Paused   → status_override = 'paused' (explicitly paused by an admin)
 *   - Draft    → toggle is off AND was never activated (brand new, never published)
 *   - Inactive → toggle is off but was previously activated (unpublished)
 *   - Expired  → toggle on but end_at has passed
 *   - Scheduled → toggle on but start_at is in the future
 *   - Live     → toggle on and currently within window
 *
 * Schedule comparisons use absolute UTC time (start_at / end_at are stored as
 * timestamptz). The banner's `timezone` column is metadata describing how the
 * admin entered the wall-clock values; conversion to UTC happens client-side.
 */
export function computeBannerStatus(b: BannerStatusInput, nowMs: number = Date.now()): BannerStatus {
  if (b.status_override === "paused") return "Paused";
  if (!b.is_active) {
    return b.activated_at == null ? "Draft" : "Inactive";
  }
  const start = toMs(b.start_at);
  const end = toMs(b.end_at);
  if (end != null && end < nowMs) return "Expired";
  if (start != null && start > nowMs) return "Scheduled";
  return "Live";
}
