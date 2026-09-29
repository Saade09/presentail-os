/**
 * Pure helpers for delivery punctuality display on the Order Detail page.
 *
 * All timestamp comparisons use UTC milliseconds. Formatting is done in the
 * order's operational IANA timezone via native Intl APIs — no extra dependency.
 */

export type PunctualityVerdict = "early" | "on_time" | "late" | "unavailable";

export interface PunctualityResult {
  verdict: PunctualityVerdict;
  /**
   * Formatted delivery time, e.g. "12:54 PM".
   * Always non-empty when verdict ≠ 'unavailable'.
   */
  deliveredLabel: string;
  /**
   * Human variance string for early/late verdicts,
   * e.g. "18 min before window" / "24 min after window".
   * Absent for on_time and unavailable.
   */
  varianceLabel?: string;
}

/**
 * Classify a delivery against a promised window.
 *
 * - Boundary times (exactly at windowStart or windowEnd) → "on_time".
 * - Returns 'unavailable' when any required input is missing or unparseable.
 * - Handles cross-midnight windows correctly because all comparisons are in
 *   UTC milliseconds and all timestamps are ISO 8601 strings.
 */
export function computePunctuality(
  deliveredAt: string | null | undefined,
  windowStart: string | null | undefined,
  windowEnd: string | null | undefined,
  timezone: string,
): PunctualityResult {
  if (!deliveredAt || !windowStart || !windowEnd) {
    return { verdict: "unavailable", deliveredLabel: "" };
  }

  const delivered = new Date(deliveredAt);
  const start = new Date(windowStart);
  const end = new Date(windowEnd);

  if (
    isNaN(delivered.getTime()) ||
    isNaN(start.getTime()) ||
    isNaN(end.getTime())
  ) {
    return { verdict: "unavailable", deliveredLabel: "" };
  }

  const deliveredMs = delivered.getTime();
  const startMs = start.getTime();
  const endMs = end.getTime();

  const deliveredLabel = formatTimeInTz(delivered, timezone);

  if (deliveredMs < startMs) {
    const varMin = Math.round((startMs - deliveredMs) / 60_000);
    return {
      verdict: "early",
      deliveredLabel,
      varianceLabel: `${varMin} min before window`,
    };
  }

  if (deliveredMs > endMs) {
    const varMin = Math.round((deliveredMs - endMs) / 60_000);
    return {
      verdict: "late",
      deliveredLabel,
      varianceLabel: `${varMin} min after window`,
    };
  }

  return { verdict: "on_time", deliveredLabel };
}

/**
 * Format a Date as "h:mm AM/PM" in the given IANA timezone.
 * Falls back to the system/UTC locale on invalid timezone strings.
 */
export function formatTimeInTz(date: Date, timezone: string): string {
  const opts: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
  };
  try {
    return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: timezone }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-US", opts).format(date);
  }
}

/**
 * Format a status-transition ISO timestamp for display beneath a stepper step.
 *
 * - Same calendar day as `orderedAt` (in the given timezone) → `"h:mm AM/PM"`
 * - Different calendar day → `"MMM D · h:mm AM/PM"`
 *
 * Returns an empty string for invalid inputs.
 */
export function formatStepTimestamp(
  iso: string,
  orderedAt: string | null,
  timezone: string,
): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";

  const sameDay =
    orderedAt ? isSameDayInTz(new Date(orderedAt), d, timezone) : false;

  if (sameDay) {
    return formatTimeInTz(d, timezone);
  }

  try {
    const datePart = new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      timeZone: timezone,
    }).format(d);
    const timePart = formatTimeInTz(d, timezone);
    return `${datePart} · ${timePart}`;
  } catch {
    return formatTimeInTz(d, timezone);
  }
}

/**
 * True when two Date values fall on the same calendar day in the given timezone.
 * Falls back to UTC date comparison on invalid timezone strings.
 */
function isSameDayInTz(a: Date, b: Date, timezone: string): boolean {
  try {
    // en-CA locale produces YYYY-MM-DD, making string equality comparison trivial.
    const fmt = new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone: timezone,
    });
    return fmt.format(a) === fmt.format(b);
  } catch {
    return a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);
  }
}
