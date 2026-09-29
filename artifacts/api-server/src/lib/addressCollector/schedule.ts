/**
 * Address Collector — pure scheduling math.
 *
 * All outreach timing is computed relative to the delivery-window START:
 *   first message  immediate for Express/same-day, otherwise −4h
 *                  (or immediately when that lead time has passed)
 *   human escalation −45m
 *
 * Quiet hours (default 21:00–09:00 in the delivery location's timezone)
 * defer the initial message send to the next 09:00 local. Escalation is an
 * internal ops signal and is never deferred. The address_collection template
 * is deliberately sent at most once; reminder action types remain understood
 * for legacy rows but are never planned.
 */

export type ScheduledActionType =
  | "first_message"
  | "reminder"
  | "final_reminder"
  | "escalation"
  | "sms_fallback"
  | "wa_delivery_check"
  | "manual_reminder";

export type PlannedAction = {
  type: ScheduledActionType;
  /** UTC instant at which the action should run (already quiet-hour deferred). */
  at: Date;
  /** Human-readable rule that produced this action (for the activity log). */
  rule: string;
};

export type QuietHours = { startHour: number; endHour: number };

export const DEFAULT_QUIET_HOURS: QuietHours = { startHour: 21, endHour: 9 };

const HOUR = 3600_000;
const MIN = 60_000;

/** Country-code → IANA timezone for the markets we deliver in. */
const COUNTRY_TIMEZONES: Record<string, string> = {
  LB: "Asia/Beirut",
  AE: "Asia/Dubai",
  QA: "Asia/Qatar",
  KW: "Asia/Kuwait",
  SA: "Asia/Riyadh",
  BH: "Asia/Bahrain",
  OM: "Asia/Muscat",
  JO: "Asia/Amman",
  EG: "Africa/Cairo",
  CY: "Asia/Nicosia",
};

/**
 * Resolve the delivery timezone: delivery country code first, then the
 * workspace-wide TOOKAN_TIMEZONE, then Asia/Beirut (primary market).
 */
export function resolveDeliveryTimezone(countryCode: string | null | undefined): string {
  const cc = (countryCode ?? "").trim().toUpperCase();
  if (cc && COUNTRY_TIMEZONES[cc]) return COUNTRY_TIMEZONES[cc];
  const envTz = process.env.TOOKAN_TIMEZONE?.trim();
  if (envTz) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: envTz });
      return envTz;
    } catch {
      /* invalid env timezone — fall through */
    }
  }
  return "Asia/Beirut";
}

type TzParts = { y: number; m: number; d: number; h: number; min: number; s: number };

function tzParts(date: Date, timeZone: string): TzParts {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const { type, value } of dtf.formatToParts(date)) p[type] = value;
  return {
    y: Number(p.year),
    m: Number(p.month),
    d: Number(p.day),
    h: Number(p.hour) % 24,
    min: Number(p.minute),
    s: Number(p.second),
  };
}

/** Convert a wall-clock time in `timeZone` to the corresponding UTC instant. */
function zonedTimeToUtc(
  y: number,
  m: number,
  d: number,
  h: number,
  timeZone: string,
  min = 0,
): Date {
  const target = Date.UTC(y, m - 1, d, h, min, 0);
  let guess = new Date(target);
  for (let i = 0; i < 3; i++) {
    const p = tzParts(guess, timeZone);
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s);
    const diff = target - asUtc;
    if (diff === 0) break;
    guess = new Date(guess.getTime() + diff);
  }
  return guess;
}

function isSameLocalDay(a: Date, b: Date, timeZone: string): boolean {
  const ap = tzParts(a, timeZone);
  const bp = tzParts(b, timeZone);
  return ap.y === bp.y && ap.m === bp.m && ap.d === bp.d;
}

/** True when the instant falls inside quiet hours in the given timezone. */
export function isQuietHour(
  at: Date,
  timeZone: string,
  qh: QuietHours = DEFAULT_QUIET_HOURS,
): boolean {
  const { h } = tzParts(at, timeZone);
  if (qh.startHour === qh.endHour) return false; // disabled
  if (qh.startHour > qh.endHour) return h >= qh.startHour || h < qh.endHour; // spans midnight
  return h >= qh.startHour && h < qh.endHour;
}

/**
 * Defer an instant out of quiet hours: anything in [startHour, midnight) moves
 * to the NEXT day's endHour local; anything in [midnight, endHour) moves to
 * the SAME day's endHour local. Instants outside quiet hours pass through.
 */
export function deferForQuietHours(
  at: Date,
  timeZone: string,
  qh: QuietHours = DEFAULT_QUIET_HOURS,
): Date {
  if (!isQuietHour(at, timeZone, qh)) return at;
  const p = tzParts(at, timeZone);
  if (qh.startHour > qh.endHour && p.h >= qh.startHour) {
    // Late evening — next day at endHour local.
    const next = tzParts(new Date(at.getTime() + 24 * HOUR), timeZone);
    return zonedTimeToUtc(next.y, next.m, next.d, qh.endHour, timeZone);
  }
  // Early morning — same local day at endHour.
  return zonedTimeToUtc(p.y, p.m, p.d, qh.endHour, timeZone);
}

export function parseQuietHoursEnv(raw: string | undefined): QuietHours {
  // Format: "21-9" (startHour-endHour, 24h clock).
  const m = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec((raw ?? "").trim());
  if (!m) return DEFAULT_QUIET_HOURS;
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (start < 0 || start > 23 || end < 0 || end > 23) return DEFAULT_QUIET_HOURS;
  return { startHour: start, endHour: end };
}

/**
 * Compute the initial outreach plan for a collection request.
 *
 * Express and delivery-local same-day orders send the initial message
 * immediately. Future-day orders send at max(now, W−4h). Escalation remains
 * max(now, W−45m). Without a window, the initial message is immediate and
 * escalation is +3h45m.
 *
 * Quiet hours defer the message sends; escalation is never deferred.
 */
export function computeSchedule(opts: {
  now: Date;
  windowStart: Date | null;
  timezone: string;
  isExpress?: boolean;
  quietHours?: QuietHours;
}): PlannedAction[] {
  const { now, windowStart, timezone } = opts;
  const qh = opts.quietHours ?? DEFAULT_QUIET_HOURS;
  const defer = (d: Date) => deferForQuietHours(d, timezone, qh);

  const out: PlannedAction[] = [];
  if (!windowStart) {
    out.push({ type: "first_message", at: defer(now), rule: "no-window: immediate" });
    out.push({ type: "escalation", at: new Date(now.getTime() + 3 * HOUR + 45 * MIN), rule: "no-window: +3h45m" });
    return out;
  }

  const W = windowStart.getTime();
  const sameDay = isSameLocalDay(now, windowStart, timezone);
  const leadTime = W - 4 * HOUR;
  const sendImmediately = opts.isExpress === true || sameDay || now.getTime() >= leadTime;
  const firstPlanned = sendImmediately ? now : new Date(leadTime);
  const first = defer(firstPlanned);
  out.push({
    type: "first_message",
    at: first,
    rule:
      opts.isExpress === true
        ? "express: immediate"
        : sameDay
          ? "same-day: immediate"
          : now.getTime() >= leadTime
            ? "lead time passed: immediate"
            : "future delivery: window −4h",
  });
  out.push({
    type: "escalation",
    at: new Date(Math.max(now.getTime(), W - 45 * MIN)),
    rule: "window −45m",
  });
  return out;
}

/**
 * Best-effort parse of a delivery date + storefront slot label (e.g.
 * "4–7 PM", "10 AM–1 PM", "16:00-19:00") into a window start/end in the
 * delivery timezone. Returns nulls when the slot cannot be parsed — callers
 * fall back to the windowless schedule.
 */
export function parseDateSlotToWindow(
  date: string | null | undefined,
  slot: string | null | undefined,
  timezone: string,
): { windowStart: Date | null; windowEnd: Date | null } {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec((date ?? "").trim());
  if (!dm) return { windowStart: null, windowEnd: null };
  const [y, mo, d] = [Number(dm[1]), Number(dm[2]), Number(dm[3])];

  const s = (slot ?? "").trim();
  if (!s) return { windowStart: null, windowEnd: null };
  const times = [...s.matchAll(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?/gi)].filter((m) => m[0].trim() !== "");
  if (times.length < 1) return { windowStart: null, windowEnd: null };

  const toTime = (
    m: RegExpMatchArray,
    fallbackMeridiem: string | null,
  ): { hour: number; minute: number } | null => {
    let h = Number(m[1]);
    if (!Number.isFinite(h) || h > 23) return null;
    const minute = Number(m[2] ?? 0);
    if (!Number.isFinite(minute) || minute > 59) return null;
    const mer = (m[3] ?? fallbackMeridiem ?? "").toUpperCase();
    if (mer === "PM" && h < 12) h += 12;
    if (mer === "AM" && h === 12) h = 0;
    return { hour: h, minute };
  };
  // "4–7 PM": the first time borrows the second's meridiem.
  const secondMer = times[1]?.[3] ?? null;
  const start = toTime(times[0], secondMer);
  if (start == null) return { windowStart: null, windowEnd: null };
  const windowStart = zonedTimeToUtc(y, mo, d, start.hour, timezone, start.minute);
  let windowEnd: Date | null = null;
  if (times[1]) {
    const end = toTime(times[1], null);
    if (end != null) {
      windowEnd = zonedTimeToUtc(y, mo, d, end.hour, timezone, end.minute);
    }
  }
  return { windowStart, windowEnd };
}
