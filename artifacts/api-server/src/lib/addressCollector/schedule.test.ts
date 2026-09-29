import { describe, it, expect } from "vitest";
import {
  computeSchedule,
  deferForQuietHours,
  isQuietHour,
  parseQuietHoursEnv,
  parseDateSlotToWindow,
  resolveDeliveryTimezone,
  DEFAULT_QUIET_HOURS,
} from "./schedule";

const TZ = "Asia/Beirut"; // UTC+3 in summer (EEST)

// Helper: build a UTC instant for a Beirut local hour on 2026-08-20 (EEST, +3).
function beirut(hour: number, minute = 0): Date {
  return new Date(Date.UTC(2026, 7, 20, hour - 3, minute));
}

describe("computeSchedule", () => {
  const noQuietHours = { startHour: 0, endHour: 0 };

  it("sends Express delivery outreach immediately even for a future delivery day", () => {
    const now = beirut(10);
    const windowStart = beirut(38); // 2 PM local the next day
    const plan = computeSchedule({
      now,
      windowStart,
      timezone: TZ,
      isExpress: true,
      quietHours: noQuietHours,
    });
    expect(plan[0]).toMatchObject({ type: "first_message", rule: "express: immediate" });
    expect(plan[0].at.getTime()).toBe(now.getTime());
  });

  it("sends same-day non-Express outreach immediately", () => {
    const now = beirut(10);
    const windowStart = beirut(16);
    const plan = computeSchedule({
      now,
      windowStart,
      timezone: TZ,
      isExpress: false,
      quietHours: noQuietHours,
    });
    expect(plan[0]).toMatchObject({ type: "first_message", rule: "same-day: immediate" });
    expect(plan[0].at.getTime()).toBe(now.getTime());
  });

  it("plans a future-day 2 PM–6 PM slot for exactly 10 AM local", () => {
    const now = beirut(10);
    const { windowStart, windowEnd } = parseDateSlotToWindow(
      "2026-08-21",
      "2:00 PM–6:00 PM",
      TZ,
    );
    expect(windowStart?.getTime()).toBe(beirut(38).getTime());
    expect(windowEnd?.getTime()).toBe(beirut(42).getTime());
    const plan = computeSchedule({
      now,
      windowStart: windowStart!,
      timezone: TZ,
      quietHours: noQuietHours,
    });
    const byType = Object.fromEntries(plan.map((p) => [p.type, p.at.getTime()]));
    expect(byType.first_message).toBe(beirut(34).getTime()); // 10 AM next day
    expect(byType.escalation).toBe(beirut(37, 15).getTime());
    expect(plan.map((p) => p.type)).toEqual(["first_message", "escalation"]);
  });

  it("sends immediately when a future-day request is created after the four-hour lead time", () => {
    const windowStart = beirut(26); // 2 AM local the next day; lead time is 10 PM
    const now = beirut(23); // 11 PM local on the request-creation day
    const plan = computeSchedule({
      now,
      windowStart,
      timezone: TZ,
      quietHours: noQuietHours,
    });
    const types = plan.map((p) => p.type);
    expect(types).toEqual(["first_message", "escalation"]);
    const first = plan.find((p) => p.type === "first_message")!;
    expect(first.at.getTime()).toBe(now.getTime());
    expect(first.rule).toBe("lead time passed: immediate");
    // Escalation never earlier than now
    const esc = plan.find((p) => p.type === "escalation")!;
    expect(esc.at.getTime()).toBeGreaterThanOrEqual(now.getTime());
  });

  it("uses the delivery timezone, not the UTC calendar, for same-day detection", () => {
    const timezone = "Asia/Dubai";
    const now = new Date("2026-08-20T20:30:00.000Z"); // Aug 21, 00:30 Dubai
    const windowStart = new Date("2026-08-21T10:00:00.000Z"); // Aug 21, 14:00 Dubai
    const plan = computeSchedule({
      now,
      windowStart,
      timezone,
      quietHours: noQuietHours,
    });
    expect(plan[0]).toMatchObject({ rule: "same-day: immediate" });
    expect(plan[0].at.getTime()).toBe(now.getTime());
  });

  it("produces one immediate message and escalation for windowless orders", () => {
    const now = beirut(10);
    const plan = computeSchedule({ now, windowStart: null, timezone: TZ });
    expect(plan.map((p) => p.type)).toEqual(["first_message", "escalation"]);
    expect(plan[0].at.getTime()).toBe(now.getTime());
  });

  it("defers message sends out of quiet hours but never defers escalation", () => {
    const windowStart = beirut(26); // 2 AM next day local — first message lands at 22:00 (quiet)
    const now = beirut(20);
    const plan = computeSchedule({ now, windowStart, timezone: TZ });
    const first = plan.find((p) => p.type === "first_message")!;
    // 22:00 local is inside 21–9 quiet hours → deferred to 09:00 local next day
    expect(isQuietHour(first.at, TZ)).toBe(false);
    const esc = plan.find((p) => p.type === "escalation")!;
    // escalation at window−45m = 01:15 local — quiet hours, but NOT deferred
    expect(isQuietHour(esc.at, TZ)).toBe(true);
  });
});

describe("quiet hours", () => {
  it("detects the spanning-midnight quiet window", () => {
    expect(isQuietHour(beirut(22), TZ)).toBe(true);
    expect(isQuietHour(beirut(3), TZ)).toBe(true);
    expect(isQuietHour(beirut(9), TZ)).toBe(false);
    expect(isQuietHour(beirut(12), TZ)).toBe(false);
    expect(isQuietHour(beirut(20, 59), TZ)).toBe(false);
  });

  it("defers late-evening sends to next morning 09:00 local", () => {
    const deferred = deferForQuietHours(beirut(22), TZ);
    // next day 09:00 Beirut = 06:00 UTC
    expect(deferred.toISOString()).toBe(new Date(Date.UTC(2026, 7, 21, 6)).toISOString());
  });

  it("defers early-morning sends to the same morning 09:00 local", () => {
    const deferred = deferForQuietHours(beirut(5), TZ);
    expect(deferred.toISOString()).toBe(new Date(Date.UTC(2026, 7, 20, 6)).toISOString());
  });

  it("passes through non-quiet instants unchanged", () => {
    const at = beirut(14);
    expect(deferForQuietHours(at, TZ).getTime()).toBe(at.getTime());
  });

  it("parses the quiet-hours env format and falls back on junk", () => {
    expect(parseQuietHoursEnv("22-8")).toEqual({ startHour: 22, endHour: 8 });
    expect(parseQuietHoursEnv("banana")).toEqual(DEFAULT_QUIET_HOURS);
    expect(parseQuietHoursEnv(undefined)).toEqual(DEFAULT_QUIET_HOURS);
    expect(parseQuietHoursEnv("25-9")).toEqual(DEFAULT_QUIET_HOURS);
  });
});

describe("parseDateSlotToWindow", () => {
  it("parses '4–7 PM' style slots (first time borrows second meridiem)", () => {
    const { windowStart, windowEnd } = parseDateSlotToWindow("2026-08-20", "4–7 PM", TZ);
    expect(windowStart?.toISOString()).toBe(beirut(16).toISOString());
    expect(windowEnd?.toISOString()).toBe(beirut(19).toISOString());
  });

  it("parses 24h slots", () => {
    const { windowStart, windowEnd } = parseDateSlotToWindow("2026-08-20", "16:00-19:00", TZ);
    expect(windowStart?.toISOString()).toBe(beirut(16).toISOString());
    expect(windowEnd?.toISOString()).toBe(beirut(19).toISOString());
  });

  it("preserves slot minutes when converting from delivery-local time", () => {
    const { windowStart, windowEnd } = parseDateSlotToWindow("2026-08-20", "14:30-18:15", TZ);
    expect(windowStart?.toISOString()).toBe(beirut(14, 30).toISOString());
    expect(windowEnd?.toISOString()).toBe(beirut(18, 15).toISOString());
  });

  it("returns nulls for unparseable input", () => {
    expect(parseDateSlotToWindow(null, "4-7 PM", TZ).windowStart).toBeNull();
    expect(parseDateSlotToWindow("2026-08-20", "", TZ).windowStart).toBeNull();
    expect(parseDateSlotToWindow("someday", "4-7 PM", TZ).windowStart).toBeNull();
  });
});

describe("resolveDeliveryTimezone", () => {
  it("maps market country codes", () => {
    expect(resolveDeliveryTimezone("LB")).toBe("Asia/Beirut");
    expect(resolveDeliveryTimezone("ae")).toBe("Asia/Dubai");
  });
  it("falls back to Asia/Beirut for unknown codes", () => {
    const prev = process.env.TOOKAN_TIMEZONE;
    delete process.env.TOOKAN_TIMEZONE;
    expect(resolveDeliveryTimezone("ZZ")).toBe("Asia/Beirut");
    expect(resolveDeliveryTimezone(null)).toBe("Asia/Beirut");
    if (prev !== undefined) process.env.TOOKAN_TIMEZONE = prev;
  });
});
