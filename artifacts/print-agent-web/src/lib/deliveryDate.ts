function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function hasProvidedValue(value: unknown): boolean {
  return value != null && (typeof value !== "string" || value.trim() !== "");
}

function parseTimestamp(value: unknown): Date | null {
  const raw = nonEmptyString(value);
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseCalendarDate(value: unknown): { date: Date; key: string } | null {
  const raw = nonEmptyString(value);
  if (!raw) return null;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day
    ) {
      return null;
    }
    return { date, key: raw };
  }
  const date = parseTimestamp(raw);
  return date ? { date, key: raw } : null;
}

function parseTimeToken(value: string): number | null {
  const match = /^(\d{1,2})(?::([0-5]\d))?\s*(am|pm)?$/i.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const meridiem = match[3]?.toLowerCase();
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    return ((hour % 12) + (meridiem === "pm" ? 12 : 0)) * 60 + minute;
  }
  return hour <= 23 ? hour * 60 + minute : null;
}

/** Legacy slots may be either a time range or a named storefront slot. */
function isUsableLegacySlot(value: unknown): value is string {
  const raw = nonEmptyString(value);
  if (!raw) return false;
  if (/^(morning|afternoon|evening|night|express)$/i.test(raw)) return true;
  const parts = raw.split(/\s*(?:–|—|-|\bto\b)\s*/i);
  return parts.length === 2 && parts.every((part) => parseTimeToken(part) != null);
}

export type DeliveryScheduleSource = "canonical" | "legacy" | "unscheduled" | "invalid";

export type DeliveryScheduleInput = {
  windowStart?: unknown;
  windowEnd?: unknown;
  legacyDate?: unknown;
  legacySlot?: unknown;
};

export type DeliverySchedule = {
  source: DeliveryScheduleSource;
  date: Date;
  dateKey: string;
  start: Date | null;
  end: Date | null;
  slot: string | null;
};

/**
 * Resolve the one delivery schedule used by every order surface.
 *
 * A canonical timestamp wins whenever either canonical endpoint is usable.
 * Otherwise a legacy date + slot pair is accepted. Placement timestamps are
 * intentionally not inputs: an order being created is never a delivery date.
 */
export function resolveDeliverySchedule(input: DeliveryScheduleInput): DeliverySchedule {
  const start = parseTimestamp(input.windowStart);
  const end = parseTimestamp(input.windowEnd);
  if (start || end) {
    const date = start ?? end!;
    return {
      source: "canonical",
      date,
      dateKey: date.toISOString().slice(0, 10),
      start,
      end,
      slot: null,
    };
  }

  const legacyDate = parseCalendarDate(input.legacyDate);
  const legacySlot = nonEmptyString(input.legacySlot);
  if (legacyDate && isUsableLegacySlot(legacySlot)) {
    return {
      source: "legacy",
      date: legacyDate.date,
      dateKey: legacyDate.key.length === 10 ? legacyDate.key : legacyDate.date.toISOString().slice(0, 10),
      start: null,
      end: null,
      slot: legacySlot,
    };
  }

  const hasInput =
    hasProvidedValue(input.windowStart) ||
    hasProvidedValue(input.windowEnd) ||
    hasProvidedValue(input.legacyDate) ||
    hasProvidedValue(input.legacySlot);
  if (hasInput) {
    return {
      source: "invalid",
      date: new Date(0),
      dateKey: "",
      start: null,
      end: null,
      slot: null,
    };
  }
  return {
    source: "unscheduled",
    date: new Date(0),
    dateKey: "",
    start: null,
    end: null,
    slot: null,
  };
}

/** Formats a valid website-metadata delivery date without guessing on bad input. */
export function formatDeliveryDate(value: unknown): string | null {
  const parsed = parseCalendarDate(value);
  if (!parsed) return null;
  return parsed.date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Compatibility helper for callers that only need a date. Canonical delivery
 * timestamps take precedence over legacy metadata.
 */
export function getDeliveryDate(
  deliveryDate: unknown,
  windowStart: string | null,
): Date | null {
  const canonical = parseTimestamp(windowStart);
  if (canonical) return canonical;
  return parseCalendarDate(deliveryDate)?.date ?? null;
}

/** Midnight of the given date in local time. */
function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * Whole-day offset of `date` relative to `from` (default now): 0 = same day,
 * 1 = tomorrow, -1 = yesterday, negative = in the past (overdue).
 */
export function dayOffset(date: Date, from: Date = new Date()): number {
  const a = startOfDay(date).getTime();
  const b = startOfDay(from).getTime();
  return Math.round((a - b) / 86_400_000);
}

function zonedDateParts(value: Date, timeZone: string): {
  year: number;
  month: number;
  day: number;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: get("year"), month: get("month"), day: get("day") };
}

export function marketDateKey(value: Date, timeZone: string): string {
  const safeTimeZone = validTimeZoneOrUtc(timeZone);
  const { year, month, day } = zonedDateParts(value, safeTimeZone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export type OperationalDeliveryWindow = {
  relativeLabel: "Today" | "Tomorrow" | null;
  dateLabel: string;
  timeLabel: string;
  fullLabel: string;
};

export type RescheduleSlotOption = {
  id: string;
  label: string;
  start_time: string;
  end_time: string;
  window_start: string;
  window_end: string;
  capacity?: number | null;
};

export type RescheduleOptionsResponse = {
  success: boolean;
  date: string;
  timezone: string;
  slots: RescheduleSlotOption[];
};

/**
 * Preserve actionable availability messages while hiding transport-only 5xx
 * text and implementation details from staff.
 */
export function rescheduleErrorMessage(
  error: unknown,
  unexpectedMessage: string,
): string {
  const candidate = error as {
    status?: number;
    message?: string;
    data?: { error?: unknown; message?: unknown } | null;
    body?: { error?: unknown; message?: unknown } | null;
  } | null;
  const payload = candidate?.data ?? candidate?.body;
  const payloadMessage =
    typeof payload?.error === "string"
      ? payload.error
      : typeof payload?.message === "string"
        ? payload.message
        : null;
  const message =
    payloadMessage ??
    (typeof candidate?.message === "string" ? candidate.message : "");
  if (
    (candidate?.status != null && candidate.status >= 500) ||
    /^HTTP 5\d\d\b/i.test(message)
  ) {
    return unexpectedMessage;
  }
  return message || unexpectedMessage;
}

function validTimeZoneOrUtc(timeZone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
    return timeZone;
  } catch {
    return "UTC";
  }
}

function dateFromKey(key: string): Date {
  return new Date(`${key}T00:00:00.000Z`);
}

function nextCalendarDateKey(key: string): string {
  const date = dateFromKey(key);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

export function deliveryScheduleDateKey(
  schedule: DeliverySchedule,
  timeZone: string,
): string {
  if (schedule.source === "unscheduled" || schedule.source === "invalid") return "";
  return schedule.source === "legacy"
    ? schedule.dateKey
    : marketDateKey(schedule.date, validTimeZoneOrUtc(timeZone));
}

/**
 * Returns the canonical YYYY-MM-DD value for the reschedule date input.
 * This intentionally resolves the same schedule used by "Current schedule" so
 * canonical market timestamps and legacy calendar dates cannot diverge.
 */
export function rescheduleInitialDate(
  input: DeliveryScheduleInput,
  timeZone: string,
  now: Date = new Date(),
): string {
  const schedule = resolveDeliverySchedule(input);
  return deliveryScheduleDateKey(schedule, timeZone) || marketDateKey(now, timeZone);
}

/**
 * Converts a resolved schedule to its market-time presentation. Legacy slots
 * retain their original text; canonical windows are formatted from timestamps.
 */
export function formatDeliverySchedule(
  schedule: DeliverySchedule | null,
  timeZone: string,
  now: Date = new Date(),
): OperationalDeliveryWindow | null {
  if (!schedule || schedule.source === "invalid" || schedule.source === "unscheduled") return null;
  const safeTimeZone = validTimeZoneOrUtc(timeZone);
  const date = schedule.source === "legacy"
    ? dateFromKey(schedule.dateKey)
    : schedule.date;
  const dateKey = deliveryScheduleDateKey(schedule, safeTimeZone);
  const todayKey = marketDateKey(now, safeTimeZone);
  const tomorrowKey = nextCalendarDateKey(todayKey);
  const relativeLabel =
    dateKey === todayKey ? "Today" : dateKey === tomorrowKey ? "Tomorrow" : null;
  const explicitDate = new Intl.DateTimeFormat("en-US", {
    timeZone: schedule.source === "legacy" ? "UTC" : safeTimeZone,
    weekday: relativeLabel ? undefined : "short",
    month: "short",
    day: "numeric",
  }).format(date);
  const dateLabel = relativeLabel ? `${relativeLabel}, ${explicitDate}` : explicitDate;
  let timeLabel = schedule.slot;
  const displayStart = schedule.start ?? schedule.end;
  if (!timeLabel && displayStart) {
    const timeFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone: safeTimeZone,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
    const startTime = timeFormatter.format(displayStart).replace(/\s/g, " ");
    const endTime = schedule.start && schedule.end
      ? timeFormatter.format(schedule.end).replace(/\s/g, " ")
      : null;
    timeLabel = endTime ? `${startTime}–${endTime}` : startTime;
  }
  return {
    relativeLabel,
    dateLabel,
    timeLabel: timeLabel ?? "",
    fullLabel: `${dateLabel}${timeLabel ? ` · ${timeLabel}` : ""}`,
  };
}

/**
 * Formats a delivery window in the order market's timezone. Relative labels
 * always retain the calendar date and overnight windows retain both times.
 */
export function formatOperationalDeliveryWindow(
  windowStart: string | null,
  windowEnd: string | null,
  timeZone: string,
  now: Date = new Date(),
): OperationalDeliveryWindow | null {
  return formatDeliverySchedule(
    resolveDeliverySchedule({ windowStart, windowEnd }),
    timeZone,
    now,
  );
}
