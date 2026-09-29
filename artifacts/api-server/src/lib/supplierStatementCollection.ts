export type StatementCadence = "monthly" | "quarterly";

export type JourneyStep = {
  order: number;
  channel: "email" | "whatsapp";
  delay_minutes: number;
  subject?: string | null;
  message?: string | null;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function parseIsoDate(value: unknown): string | null {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : value;
}

export function addMonths(dateString: string, months: number): string {
  const date = new Date(`${dateString}T00:00:00Z`);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.toISOString().slice(0, 10);
}

export function periodForCycle(cadence: StatementCadence, cycleDate = new Date()): {
  periodStart: string;
  periodEnd: string;
  periodLabel: string;
} {
  const current = new Date(Date.UTC(cycleDate.getUTCFullYear(), cycleDate.getUTCMonth(), 1));
  const monthOffset = cadence === "quarterly" ? -3 : -1;
  const start = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + monthOffset, 1));
  const end = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), 0));
  const periodStart = start.toISOString().slice(0, 10);
  const periodEnd = end.toISOString().slice(0, 10);
  const month = start.getUTCMonth();
  const year = start.getUTCFullYear();
  const periodLabel = cadence === "quarterly"
    ? `Q${Math.floor(month / 3) + 1} ${year}`
    : start.toLocaleString("en-US", { month: "long", timeZone: "UTC" }) + ` ${year}`;
  return { periodStart, periodEnd, periodLabel };
}

export function periodLabelForDates(start: string, end: string, cadence: StatementCadence): string {
  const date = new Date(`${start}T00:00:00Z`);
  if (cadence === "quarterly") {
    return `Q${Math.floor(date.getUTCMonth() / 3) + 1} ${date.getUTCFullYear()}`;
  }
  return `${date.toLocaleString("en-US", { month: "long", timeZone: "UTC" })} ${date.getUTCFullYear()}`;
}

export function nextCycleAt(periodEnd: string): Date {
  return new Date(Date.parse(`${periodEnd}T00:00:00Z`) + 86_400_000);
}

export function validateTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

function zonedParts(date: Date, timezone: string): { year: number; month: number; day: number; hour: number; minute: number } {
  const values = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => Number(values.find((part) => part.type === type)?.value ?? 0);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

function localTimeToUtc(localDate: string, localTime: string, timezone: string): Date {
  const [year, month, day] = localDate.split("-").map(Number);
  const [hour, minute] = localTime.slice(0, 5).split(":").map(Number);
  let candidate = new Date(Date.UTC(year, month - 1, day, hour, minute));
  for (let i = 0; i < 2; i++) {
    const actual = zonedParts(candidate, timezone);
    const desired = Date.UTC(year, month - 1, day, hour, minute);
    const observed = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute);
    candidate = new Date(candidate.getTime() + desired - observed);
  }
  return candidate;
}

export function calculateNextRun(
  schedule: {
    first_run_date: string;
    cadence: StatementCadence;
    local_day: number;
    local_time: string;
    timezone: string;
  },
  now = new Date(),
): Date {
  const first = new Date(`${schedule.first_run_date}T00:00:00Z`);
  const months = schedule.cadence === "quarterly" ? 3 : 1;
  for (let i = 0; i < 240; i++) {
    const anchor = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + i * months, 1));
    const lastDay = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 0)).getUTCDate();
    const localDate = `${anchor.getUTCFullYear()}-${String(anchor.getUTCMonth() + 1).padStart(2, "0")}-${String(Math.min(schedule.local_day, lastDay)).padStart(2, "0")}`;
    const candidate = localTimeToUtc(localDate, schedule.local_time, schedule.timezone);
    if (candidate.getTime() > now.getTime()) return candidate;
  }
  throw new Error("Could not calculate the next supplier statement run");
}

export function normalizeJourneySteps(value: unknown): JourneyStep[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    throw new Error("journey steps must contain between 1 and 20 steps");
  }
  return value.map((raw, index) => {
    const step = (raw ?? {}) as Record<string, unknown>;
    const channel = String(step.channel ?? "").toLowerCase();
    if (channel !== "email" && channel !== "whatsapp") throw new Error(`journey step ${index + 1} has an invalid channel`);
    const delay = Number(step.delay_minutes ?? step.delayMinutes ?? 0);
    if (!Number.isInteger(delay) || delay < 0 || delay > 60 * 24 * 90) {
      throw new Error(`journey step ${index + 1} has an invalid delay`);
    }
    return {
      order: index + 1,
      channel,
      delay_minutes: delay,
      subject: step.subject == null ? null : String(step.subject),
      message: step.message == null ? null : String(step.message),
    };
  });
}

export function buildStepSchedule(steps: JourneyStep[], base = new Date()): Array<JourneyStep & { scheduled_at: Date }> {
  let offset = 0;
  return steps.map((step) => {
    offset += step.delay_minutes;
    return { ...step, scheduled_at: new Date(base.getTime() + offset * 60_000) };
  });
}
