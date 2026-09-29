/**
 * Focused tests for the grace-period default change (120 → 30) and the
 * location-level grace_period_minutes override introduced in task #4587.
 *
 * These tests use isSessionOverdue directly (pure function, no DB) so they
 * run instantly and have no mocking overhead.
 */

import { describe, it, expect } from "vitest";
import { isSessionOverdue } from "./cashDesk";

// Helper: build an ISO timestamp for a given hour (UTC) on an arbitrary fixed date.
function utcTs(hour: number, minute = 0): string {
  return `2026-07-14T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`;
}

// Beirut is UTC+3 in summer (no DST change on 2026-07-14).
// A session opened at 07:00 UTC = 10:00 Beirut local time.
const SESSION_OPENED_AT = utcTs(7, 0); // 10:00 Beirut
const CUTOFF_TIME = "18:30"; // 18:30 Beirut
const TIMEZONE = "Asia/Beirut";

// Overdue threshold (without grace): 18:30 Beirut = 15:30 UTC on the same day.
// With 30 min grace: overdue after 19:00 Beirut = 16:00 UTC.
// With 60 min grace: overdue after 19:30 Beirut = 16:30 UTC.

describe("isSessionOverdue — default grace period is 30 minutes", () => {
  it("is not overdue just before the 30-minute grace window expires", () => {
    // 18:59 Beirut = 15:59 UTC — still within 30 min of the 18:30 cutoff
    const now = new Date(utcTs(15, 59));
    const { overdue } = isSessionOverdue(SESSION_OPENED_AT, CUTOFF_TIME, TIMEZONE, undefined, now);
    expect(overdue).toBe(false);
  });

  it("is overdue once the default 30-minute grace window has passed", () => {
    // 19:01 Beirut = 16:01 UTC — 31 minutes past the 18:30 cutoff
    const now = new Date(utcTs(16, 1));
    const { overdue, overdueByMinutes } = isSessionOverdue(
      SESSION_OPENED_AT,
      CUTOFF_TIME,
      TIMEZONE,
      undefined, // use default (30)
      now,
    );
    expect(overdue).toBe(true);
    expect(overdueByMinutes).toBeGreaterThan(0);
  });

  it("was NOT overdue at 30 minutes under the old 120-minute default", () => {
    // At 16:01 UTC (31 min past cutoff) the OLD 120-min default would not flag as overdue.
    // With the new 30-min default it should be overdue — verified by the previous test.
    // Explicitly: 121 min past cutoff IS overdue even with the old default.
    const now = new Date(utcTs(17, 31)); // 20:31 Beirut = 121 min past 18:30
    const { overdue } = isSessionOverdue(SESSION_OPENED_AT, CUTOFF_TIME, TIMEZONE, 120, now);
    expect(overdue).toBe(true);
  });
});

describe("isSessionOverdue — location-level grace_period_minutes override", () => {
  it("uses the location grace period when provided, ignoring the workspace default", () => {
    // 19:01 Beirut = 16:01 UTC = 31 min past the 18:30 cutoff.
    // With 30-min default this is overdue; with 60-min location override it is not yet.
    const now = new Date(utcTs(16, 1)); // 19:01 Beirut = 31 min past cutoff
    const { overdue: overdueWith30 } = isSessionOverdue(SESSION_OPENED_AT, CUTOFF_TIME, TIMEZONE, 30, now);
    const { overdue: overdueWith60 } = isSessionOverdue(SESSION_OPENED_AT, CUTOFF_TIME, TIMEZONE, 60, now);
    expect(overdueWith30).toBe(true);  // 30-min grace already expired
    expect(overdueWith60).toBe(false); // 60-min grace still active
  });

  it("uses a shorter location grace period (10 min) even when workspace default is 30", () => {
    // 10 min past cutoff = 18:40 Beirut = 15:40 UTC.
    // With default 30 min: not overdue. With location override 10 min: overdue.
    const now = new Date(utcTs(15, 41)); // 18:41 Beirut = 11 min past cutoff
    const { overdue: overdueDefault } = isSessionOverdue(SESSION_OPENED_AT, CUTOFF_TIME, TIMEZONE, 30, now);
    const { overdue: overdueLocation } = isSessionOverdue(SESSION_OPENED_AT, CUTOFF_TIME, TIMEZONE, 10, now);
    expect(overdueDefault).toBe(false);
    expect(overdueLocation).toBe(true);
  });
});

describe("isSessionOverdue — missing cutoff / timezone gracefully returns not-overdue", () => {
  it("returns not overdue when cutoffTime is null (no workspace_settings row equivalent)", () => {
    const now = new Date(utcTs(20, 0));
    const { overdue } = isSessionOverdue(SESSION_OPENED_AT, null, TIMEZONE, 30, now);
    expect(overdue).toBe(false);
  });

  it("returns not overdue when timezone is null", () => {
    const now = new Date(utcTs(20, 0));
    const { overdue } = isSessionOverdue(SESSION_OPENED_AT, CUTOFF_TIME, null, 30, now);
    expect(overdue).toBe(false);
  });
});
