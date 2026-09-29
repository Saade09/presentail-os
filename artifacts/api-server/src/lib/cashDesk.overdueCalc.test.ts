/**
 * Unit tests for `computeShiftOverdue` — the pure function that determines
 * whether a shift has run past its location's daily-close cutoff + grace period
 * and returns the exact UTC timestamp at which it became (or will become) overdue.
 *
 * No DB or mocking required — all scenarios use injectable `now` timestamps.
 */

import { describe, it, expect } from "vitest";
import { computeShiftOverdue } from "./cashDesk";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a UTC ISO string at a specific hour:minute on a fixed calendar date. */
function utcTs(hour: number, minute = 0, date = "2026-08-10"): string {
  return `${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`;
}

// ── Constants for Beirut-based tests ─────────────────────────────────────────
// On 2026-08-10 Beirut is UTC+3 (no DST change on this date).
// A session opened at 09:00 UTC = 12:00 Beirut local time.
// Cutoff configured at 22:00 Beirut = 19:00 UTC on the opening day.
// With default 30-min grace: overdue after 22:30 Beirut = 19:30 UTC.

const BEIRUT_TZ        = "Asia/Beirut";
const BEIRUT_CUTOFF    = "22:00"; // local time
const SESSION_OPENED   = utcTs(9, 0); // 09:00 UTC = 12:00 Beirut

// ── Suite 1: grace period boundary ───────────────────────────────────────────

describe("computeShiftOverdue — grace period boundary (Beirut)", () => {
  it("is not overdue just before the grace window expires (1 min early)", () => {
    // 22:29 Beirut = 19:29 UTC — still within 30-min grace
    const now = new Date(utcTs(19, 29));
    const { isOverdue, overdueAt } = computeShiftOverdue(
      SESSION_OPENED, BEIRUT_CUTOFF, BEIRUT_TZ, 30, now,
    );
    expect(isOverdue).toBe(false);
    // overdueAt is still returned even when not yet overdue
    expect(overdueAt).toBeInstanceOf(Date);
  });

  it("becomes overdue 1 minute after the grace window expires", () => {
    // 22:31 Beirut = 19:31 UTC — 31 minutes past the 22:00 cutoff
    const now = new Date(utcTs(19, 31));
    const { isOverdue, overdueAt } = computeShiftOverdue(
      SESSION_OPENED, BEIRUT_CUTOFF, BEIRUT_TZ, 30, now,
    );
    expect(isOverdue).toBe(true);
    // overdueAt should be very close to 22:30 Beirut (19:30 UTC)
    expect(overdueAt).toBeInstanceOf(Date);
    const expectedOverdueUtcMs = new Date(utcTs(19, 30)).getTime();
    // Allow ±1 minute tolerance for offset-probe rounding
    expect(Math.abs(overdueAt!.getTime() - expectedOverdueUtcMs)).toBeLessThan(60_001);
  });

  it("respects a 60-minute location-level grace override", () => {
    // 22:45 Beirut = 19:45 UTC — 45 min past cutoff.
    // Default 30-min grace: already overdue.
    // 60-min location grace: not yet overdue.
    const now = new Date(utcTs(19, 45));
    const { isOverdue: with30 } = computeShiftOverdue(SESSION_OPENED, BEIRUT_CUTOFF, BEIRUT_TZ, 30, now);
    const { isOverdue: with60 } = computeShiftOverdue(SESSION_OPENED, BEIRUT_CUTOFF, BEIRUT_TZ, 60, now);
    expect(with30).toBe(true);
    expect(with60).toBe(false);
  });
});

// ── Suite 2: null/missing inputs ─────────────────────────────────────────────

describe("computeShiftOverdue — null cutoffTime or timezone", () => {
  it("returns isOverdue=false when cutoffTime is null (location has no closing rule)", () => {
    const now = new Date(utcTs(23, 0));
    const { isOverdue, overdueAt } = computeShiftOverdue(SESSION_OPENED, null, BEIRUT_TZ, 30, now);
    expect(isOverdue).toBe(false);
    expect(overdueAt).toBeNull();
  });

  it("returns isOverdue=false when timezone is null", () => {
    const now = new Date(utcTs(23, 0));
    const { isOverdue, overdueAt } = computeShiftOverdue(SESSION_OPENED, BEIRUT_CUTOFF, null, 30, now);
    expect(isOverdue).toBe(false);
    expect(overdueAt).toBeNull();
  });

  it("returns isOverdue=false when both cutoffTime and timezone are null", () => {
    const { isOverdue } = computeShiftOverdue(SESSION_OPENED, null, null, 30, new Date());
    expect(isOverdue).toBe(false);
  });

  it("treats null graceMinutes as 30-minute default", () => {
    // 22:31 Beirut = 19:31 UTC — just past a 30-min grace window
    const now = new Date(utcTs(19, 31));
    const { isOverdue: withNullGrace }  = computeShiftOverdue(SESSION_OPENED, BEIRUT_CUTOFF, BEIRUT_TZ, null,      now);
    const { isOverdue: with30 }         = computeShiftOverdue(SESSION_OPENED, BEIRUT_CUTOFF, BEIRUT_TZ, 30,        now);
    const { isOverdue: withUndefined }  = computeShiftOverdue(SESSION_OPENED, BEIRUT_CUTOFF, BEIRUT_TZ, undefined, now);
    expect(withNullGrace).toBe(with30);
    expect(withUndefined).toBe(with30);
    // Both should be true: 31 min past cutoff > 30-min grace
    expect(with30).toBe(true);
  });
});

// ── Suite 3: Asia/Beirut midnight crossing ────────────────────────────────────
// A session opened late on one day with a cutoff past midnight tests DST-safe
// calendar-date derivation in the timezone arithmetic.

describe("computeShiftOverdue — midnight crossing in Asia/Beirut", () => {
  it("correctly flags overdue when the session opened near midnight and the cutoff is early next morning", () => {
    // Session opened at 22:00 UTC = 01:00 Beirut on 2026-08-11 (next day).
    // Cutoff = 03:00 Beirut on the opening day (2026-08-11).
    // 03:00 Beirut = 00:00 UTC on 2026-08-11.
    // With 30-min grace: overdue after 00:30 UTC on 2026-08-11.
    const openedAt    = utcTs(22, 0, "2026-08-10"); // 01:00 Beirut on Aug 11
    const cutoffLocal = "03:00"; // 03:00 Beirut on the opening-day (Aug 11)
    // Cutoff UTC = 00:00 on Aug 11; +30 min grace = 00:30 Aug 11
    const beforeGrace = new Date(utcTs(0, 29, "2026-08-11")); // 00:29 UTC Aug 11
    const afterGrace  = new Date(utcTs(0, 31, "2026-08-11")); // 00:31 UTC Aug 11

    const { isOverdue: notYet } = computeShiftOverdue(openedAt, cutoffLocal, BEIRUT_TZ, 30, beforeGrace);
    const { isOverdue: overdue } = computeShiftOverdue(openedAt, cutoffLocal, BEIRUT_TZ, 30, afterGrace);

    expect(notYet).toBe(false);
    expect(overdue).toBe(true);
  });
});

// ── Suite 4: intentional overnight shifts ─────────────────────────────────────

describe("computeShiftOverdue — intentional overnight shift (no cutoff)", () => {
  it("never flags an overnight shift as overdue when the location has no cutoff configured", () => {
    // An overnight shift opened at 22:00 that's still open 10 hours later at 08:00.
    const openedAt = utcTs(22, 0);
    const now      = new Date(utcTs(8, 0, "2026-08-11")); // next day
    const { isOverdue } = computeShiftOverdue(openedAt, null, BEIRUT_TZ, 30, now);
    expect(isOverdue).toBe(false);
  });

  it("does flag an overnight shift as overdue when the location does have a cutoff", () => {
    // Same session, but now the location has a cutoff at 02:00 Beirut (23:00 UTC).
    // With 30-min grace: overdue after 02:30 Beirut = 23:30 UTC on Aug 10.
    const openedAt = utcTs(22, 0); // 22:00 UTC Aug 10
    const now      = new Date(utcTs(23, 31));  // 23:31 UTC Aug 10 — 1 min past grace
    const { isOverdue } = computeShiftOverdue(openedAt, "02:00", BEIRUT_TZ, 30, now);
    expect(isOverdue).toBe(true);
  });
});

// ── Suite 5: overdueAt accuracy ───────────────────────────────────────────────

describe("computeShiftOverdue — overdueAt timestamp", () => {
  it("always returns overdueAt regardless of whether the shift is currently overdue", () => {
    // A future now — shift not overdue yet
    const future = new Date(utcTs(19, 0)); // before 22:30 Beirut = 19:30 UTC
    const { isOverdue, overdueAt } = computeShiftOverdue(SESSION_OPENED, BEIRUT_CUTOFF, BEIRUT_TZ, 30, future);
    expect(isOverdue).toBe(false);
    expect(overdueAt).not.toBeNull();
  });

  it("overdueAt equals cutoff + grace in UTC", () => {
    // Beirut cutoff at 22:00 + 30 min grace = 22:30 Beirut = 19:30 UTC
    const now = new Date(utcTs(19, 35)); // definitely overdue
    const { overdueAt } = computeShiftOverdue(SESSION_OPENED, BEIRUT_CUTOFF, BEIRUT_TZ, 30, now);
    const expectedMs = new Date(utcTs(19, 30)).getTime();
    // Allow ±1 minute for the offset-probe rounding in the algorithm
    expect(Math.abs(overdueAt!.getTime() - expectedMs)).toBeLessThan(60_001);
  });
});
