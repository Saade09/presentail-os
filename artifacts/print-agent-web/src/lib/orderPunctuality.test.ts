import { describe, it, expect } from "vitest";
import {
  computePunctuality,
  formatStepTimestamp,
  formatTimeInTz,
} from "./orderPunctuality";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function addMinutes(iso: string, minutes: number): string {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
}

const WINDOW_START = "2026-08-10T10:00:00.000Z";
const WINDOW_END = "2026-08-10T12:00:00.000Z";
const TZ = "UTC";

// ---------------------------------------------------------------------------
// computePunctuality — missing / invalid inputs
// ---------------------------------------------------------------------------

describe("computePunctuality — missing inputs", () => {
  it("returns unavailable when deliveredAt is null", () => {
    expect(computePunctuality(null, WINDOW_START, WINDOW_END, TZ).verdict).toBe("unavailable");
  });

  it("returns unavailable when windowStart is null", () => {
    expect(computePunctuality(WINDOW_START, null, WINDOW_END, TZ).verdict).toBe("unavailable");
  });

  it("returns unavailable when windowEnd is null", () => {
    expect(computePunctuality(WINDOW_START, WINDOW_START, null, TZ).verdict).toBe("unavailable");
  });

  it("returns empty deliveredLabel when unavailable", () => {
    expect(computePunctuality(null, WINDOW_START, WINDOW_END, TZ).deliveredLabel).toBe("");
  });

  it("returns unavailable for invalid deliveredAt string", () => {
    expect(computePunctuality("not-a-date", WINDOW_START, WINDOW_END, TZ).verdict).toBe("unavailable");
  });

  it("returns unavailable for invalid windowStart string", () => {
    expect(computePunctuality(WINDOW_START, "bad", WINDOW_END, TZ).verdict).toBe("unavailable");
  });
});

// ---------------------------------------------------------------------------
// computePunctuality — on_time
// ---------------------------------------------------------------------------

describe("computePunctuality — on_time", () => {
  it("is on_time when delivered exactly at windowStart (boundary inclusive)", () => {
    const r = computePunctuality(WINDOW_START, WINDOW_START, WINDOW_END, TZ);
    expect(r.verdict).toBe("on_time");
    expect(r.varianceLabel).toBeUndefined();
  });

  it("is on_time when delivered exactly at windowEnd (boundary inclusive)", () => {
    const r = computePunctuality(WINDOW_END, WINDOW_START, WINDOW_END, TZ);
    expect(r.verdict).toBe("on_time");
  });

  it("is on_time when delivered in the middle of the window", () => {
    const mid = addMinutes(WINDOW_START, 30);
    expect(computePunctuality(mid, WINDOW_START, WINDOW_END, TZ).verdict).toBe("on_time");
  });

  it("includes a non-empty deliveredLabel with AM/PM for on_time", () => {
    const r = computePunctuality(WINDOW_START, WINDOW_START, WINDOW_END, TZ);
    expect(r.deliveredLabel).toMatch(/AM|PM/i);
  });
});

// ---------------------------------------------------------------------------
// computePunctuality — early
// ---------------------------------------------------------------------------

describe("computePunctuality — early", () => {
  it("is early when delivered 1 ms before windowStart", () => {
    const justBefore = new Date(new Date(WINDOW_START).getTime() - 1).toISOString();
    expect(computePunctuality(justBefore, WINDOW_START, WINDOW_END, TZ).verdict).toBe("early");
  });

  it("calculates 18 min variance correctly", () => {
    const early = addMinutes(WINDOW_START, -18);
    const r = computePunctuality(early, WINDOW_START, WINDOW_END, TZ);
    expect(r.verdict).toBe("early");
    expect(r.varianceLabel).toBe("18 min before window");
  });

  it("rounds fractional minutes (17.5 → 18)", () => {
    const early = new Date(new Date(WINDOW_START).getTime() - 17.5 * 60_000).toISOString();
    const r = computePunctuality(early, WINDOW_START, WINDOW_END, TZ);
    expect(r.varianceLabel).toBe("18 min before window");
  });

  it("includes a non-empty deliveredLabel when early", () => {
    const r = computePunctuality(addMinutes(WINDOW_START, -30), WINDOW_START, WINDOW_END, TZ);
    expect(r.deliveredLabel).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// computePunctuality — late
// ---------------------------------------------------------------------------

describe("computePunctuality — late", () => {
  it("is late when delivered 1 ms after windowEnd", () => {
    const justAfter = new Date(new Date(WINDOW_END).getTime() + 1).toISOString();
    expect(computePunctuality(justAfter, WINDOW_START, WINDOW_END, TZ).verdict).toBe("late");
  });

  it("calculates 24 min variance correctly", () => {
    const late = addMinutes(WINDOW_END, 24);
    const r = computePunctuality(late, WINDOW_START, WINDOW_END, TZ);
    expect(r.verdict).toBe("late");
    expect(r.varianceLabel).toBe("24 min after window");
  });

  it("rounds fractional minutes (23.5 → 24)", () => {
    const late = new Date(new Date(WINDOW_END).getTime() + 23.5 * 60_000).toISOString();
    expect(computePunctuality(late, WINDOW_START, WINDOW_END, TZ).varianceLabel).toBe("24 min after window");
  });
});

// ---------------------------------------------------------------------------
// computePunctuality — cross-midnight windows
// ---------------------------------------------------------------------------

describe("computePunctuality — cross-midnight windows", () => {
  const mStart = "2026-08-10T23:00:00.000Z";
  const mEnd   = "2026-08-11T01:00:00.000Z";

  it("is on_time when delivered just after midnight within window", () => {
    expect(computePunctuality("2026-08-11T00:30:00.000Z", mStart, mEnd, TZ).verdict).toBe("on_time");
  });

  it("is early when delivered 60 min before the window start", () => {
    const r = computePunctuality("2026-08-10T22:00:00.000Z", mStart, mEnd, TZ);
    expect(r.verdict).toBe("early");
    expect(r.varianceLabel).toBe("60 min before window");
  });

  it("is late when delivered 45 min after the window end", () => {
    const r = computePunctuality("2026-08-11T01:45:00.000Z", mStart, mEnd, TZ);
    expect(r.verdict).toBe("late");
    expect(r.varianceLabel).toBe("45 min after window");
  });
});

// ---------------------------------------------------------------------------
// computePunctuality — timezone in deliveredLabel
// ---------------------------------------------------------------------------

describe("computePunctuality — timezone formatting", () => {
  it("formats deliveredLabel differently across timezones", () => {
    // 09:00 UTC = 12:00 Asia/Beirut (UTC+3)
    const delivered = "2026-08-10T09:00:00.000Z";
    const rBeirut = computePunctuality(delivered, WINDOW_START, WINDOW_END, "Asia/Beirut");
    const rUtc    = computePunctuality(delivered, WINDOW_START, WINDOW_END, TZ);
    expect(rBeirut.deliveredLabel).not.toBe(rUtc.deliveredLabel);
  });

  it("does not throw for an invalid timezone string", () => {
    expect(() =>
      computePunctuality(WINDOW_START, WINDOW_START, WINDOW_END, "Invalid/Zone"),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// formatStepTimestamp
// ---------------------------------------------------------------------------

describe("formatStepTimestamp", () => {
  const orderedAt = "2026-08-10T06:00:00.000Z";
  const sameDay   = "2026-08-10T09:30:00.000Z";
  const nextDay   = "2026-08-11T09:30:00.000Z";

  it("returns only h:mm AM/PM for a same-day timestamp", () => {
    const label = formatStepTimestamp(sameDay, orderedAt, "UTC");
    expect(label).toMatch(/^\d{1,2}:\d{2}\s*(AM|PM)$/i);
    expect(label).not.toContain("·");
  });

  it("returns 'MMM D · h:mm AM/PM' for a cross-day timestamp", () => {
    const label = formatStepTimestamp(nextDay, orderedAt, "UTC");
    expect(label).toContain("·");
    expect(label).toMatch(/[A-Z][a-z]{2}\s+\d+/);
  });

  it("returns empty string for an invalid ISO string", () => {
    expect(formatStepTimestamp("not-a-date", orderedAt, "UTC")).toBe("");
  });

  it("uses cross-day format when orderedAt is null (cannot determine same-day)", () => {
    const label = formatStepTimestamp(sameDay, null, "UTC");
    expect(label).toContain("·");
  });

  it("accounts for timezone offset in same-day determination", () => {
    // 2026-08-10T22:00Z = Aug 11 in Asia/Beirut (UTC+3), Aug 10 in UTC
    // orderedAt = 2026-08-10T06:00Z = Aug 10 in both
    const ts = "2026-08-10T22:00:00.000Z";
    const ordered = "2026-08-10T06:00:00.000Z";
    // In Beirut: ts is Aug 11, ordered is Aug 10 → cross-day
    expect(formatStepTimestamp(ts, ordered, "Asia/Beirut")).toContain("·");
    // In UTC: both are Aug 10 → same-day
    expect(formatStepTimestamp(ts, ordered, "UTC")).not.toContain("·");
  });
});

// ---------------------------------------------------------------------------
// formatTimeInTz
// ---------------------------------------------------------------------------

describe("formatTimeInTz", () => {
  it("formats 14:30 UTC correctly", () => {
    const d = new Date("2026-08-10T14:30:00.000Z");
    expect(formatTimeInTz(d, "UTC")).toBe("2:30 PM");
  });

  it("applies timezone offset — 14:30 UTC = 5:30 PM Asia/Beirut", () => {
    const d = new Date("2026-08-10T14:30:00.000Z");
    expect(formatTimeInTz(d, "Asia/Beirut")).toBe("5:30 PM");
  });

  it("does not throw for an invalid timezone string", () => {
    expect(() => formatTimeInTz(new Date(), "Invalid/Zone")).not.toThrow();
  });
});
