import { describe, it, expect } from "vitest";
import { calculateSessionMinutes, sumBreakMinutes } from "./attendanceCalc";

// ─── sumBreakMinutes ──────────────────────────────────────────────────────────

describe("sumBreakMinutes", () => {
  it("returns 0 for an empty break list", () => {
    expect(sumBreakMinutes([])).toBe(0);
  });

  it("skips breaks with no end time", () => {
    expect(
      sumBreakMinutes([
        { break_start_at: "2025-01-01T09:00:00Z", break_end_at: null },
      ]),
    ).toBe(0);
  });

  it("sums a single completed break", () => {
    expect(
      sumBreakMinutes([
        { break_start_at: "2025-01-01T09:00:00Z", break_end_at: "2025-01-01T09:30:00Z" },
      ]),
    ).toBe(30);
  });

  it("sums multiple completed breaks", () => {
    expect(
      sumBreakMinutes([
        { break_start_at: "2025-01-01T09:00:00Z", break_end_at: "2025-01-01T09:15:00Z" }, // 15 min
        { break_start_at: "2025-01-01T12:00:00Z", break_end_at: "2025-01-01T12:45:00Z" }, // 45 min
      ]),
    ).toBe(60);
  });

  it("ignores open breaks when mixed with closed ones", () => {
    expect(
      sumBreakMinutes([
        { break_start_at: "2025-01-01T09:00:00Z", break_end_at: "2025-01-01T09:20:00Z" }, // 20 min
        { break_start_at: "2025-01-01T14:00:00Z", break_end_at: null },                    // open
      ]),
    ).toBe(20);
  });
});

// ─── calculateSessionMinutes ──────────────────────────────────────────────────

describe("calculateSessionMinutes — no schedule", () => {
  const clockIn = "2025-01-01T09:00:00Z";
  const clockOut = "2025-01-01T17:00:00Z"; // 8 h = 480 min

  it("computes gross = clock-out minus clock-in", () => {
    const r = calculateSessionMinutes(clockIn, clockOut, 0);
    expect(r.grossMinutes).toBe(480);
  });

  it("computes paid = gross minus break", () => {
    const r = calculateSessionMinutes(clockIn, clockOut, 60);
    expect(r.paidMinutes).toBe(420);
  });

  it("returns 0 for late, earlyLeave, overtime when no schedule given", () => {
    const r = calculateSessionMinutes(clockIn, clockOut, 30);
    expect(r.lateMinutes).toBe(0);
    expect(r.earlyLeaveMinutes).toBe(0);
    expect(r.overtimeMinutes).toBe(0);
  });

  it("grossMinutes is never negative even if clockOut < clockIn", () => {
    const r = calculateSessionMinutes("2025-01-01T17:00:00Z", "2025-01-01T09:00:00Z", 0);
    expect(r.grossMinutes).toBe(0);
  });
});

describe("calculateSessionMinutes — with schedule", () => {
  const schedule = {
    startTime: "09:00",
    endTime: "17:00",   // scheduled: 480 min; break: 60 min → scheduledPaid: 420 min
    scheduledBreakMinutes: 60,
  };

  it("detects no lateness when clocking in on time", () => {
    const r = calculateSessionMinutes("2025-01-01T09:00:00Z", "2025-01-01T17:00:00Z", 60, schedule);
    expect(r.lateMinutes).toBe(0);
  });

  it("detects no lateness within grace period (5 min)", () => {
    const r = calculateSessionMinutes("2025-01-01T09:03:00Z", "2025-01-01T17:00:00Z", 60, schedule);
    expect(r.lateMinutes).toBe(0);
  });

  it("detects lateness beyond grace period", () => {
    const r = calculateSessionMinutes("2025-01-01T09:10:00Z", "2025-01-01T17:00:00Z", 60, schedule);
    expect(r.lateMinutes).toBe(10);
  });

  it("detects early leave", () => {
    const r = calculateSessionMinutes("2025-01-01T09:00:00Z", "2025-01-01T16:30:00Z", 60, schedule);
    expect(r.earlyLeaveMinutes).toBe(30);
  });

  it("detects no early leave when clocking out on time", () => {
    const r = calculateSessionMinutes("2025-01-01T09:00:00Z", "2025-01-01T17:00:00Z", 60, schedule);
    expect(r.earlyLeaveMinutes).toBe(0);
  });

  it("detects overtime when paid minutes exceed scheduled paid minutes", () => {
    // clocks out at 18:00 → grossMinutes = 540 - 60 break = 480 paid; scheduledPaid = 420 → OT = 60
    const r = calculateSessionMinutes("2025-01-01T09:00:00Z", "2025-01-01T18:00:00Z", 60, schedule);
    expect(r.overtimeMinutes).toBe(60);
  });

  it("detects no overtime when paid equals scheduled paid", () => {
    const r = calculateSessionMinutes("2025-01-01T09:00:00Z", "2025-01-01T17:00:00Z", 60, schedule);
    expect(r.overtimeMinutes).toBe(0);
  });

  it("propagates breakMinutes in result", () => {
    const r = calculateSessionMinutes("2025-01-01T09:00:00Z", "2025-01-01T17:00:00Z", 45, schedule);
    expect(r.breakMinutes).toBe(45);
  });
});

describe("calculateSessionMinutes — overnight schedule (22:00–06:00)", () => {
  // Schedule spans midnight: 22:00 to 06:00 next day = 480 min; break 30 min → scheduledPaid 450 min
  const schedule = {
    startTime: "22:00",
    endTime: "06:00",
    scheduledBreakMinutes: 30,
  };

  it("computes schedMinutes as 480 (not 0) for an overnight window", () => {
    // On time, no break: grossMinutes = 480, scheduledPaid = 450 → overtime = 30
    const r = calculateSessionMinutes(
      "2025-01-01T22:00:00Z",
      "2025-01-02T06:00:00Z",
      0,
      schedule,
    );
    expect(r.grossMinutes).toBe(480);
    expect(r.overtimeMinutes).toBe(30); // 480 paid − 450 scheduledPaid
  });

  it("detects no lateness when clocking in on time for overnight shift", () => {
    const r = calculateSessionMinutes(
      "2025-01-01T22:00:00Z",
      "2025-01-02T06:00:00Z",
      30,
      schedule,
    );
    expect(r.lateMinutes).toBe(0);
  });

  it("detects lateness beyond grace period for overnight shift", () => {
    // Clocked in at 22:10 → 10 min late (> 5 min grace)
    const r = calculateSessionMinutes(
      "2025-01-01T22:10:00Z",
      "2025-01-02T06:00:00Z",
      30,
      schedule,
    );
    expect(r.lateMinutes).toBe(10);
  });

  it("detects early leave for overnight shift", () => {
    // Clocked out at 05:30 → 30 min early
    const r = calculateSessionMinutes(
      "2025-01-01T22:00:00Z",
      "2025-01-02T05:30:00Z",
      30,
      schedule,
    );
    expect(r.earlyLeaveMinutes).toBe(30);
  });

  it("detects no early leave when clocking out on time for overnight shift", () => {
    const r = calculateSessionMinutes(
      "2025-01-01T22:00:00Z",
      "2025-01-02T06:00:00Z",
      30,
      schedule,
    );
    expect(r.earlyLeaveMinutes).toBe(0);
  });

  it("detects overtime for overnight shift", () => {
    // Clocked out at 07:00 → gross = 540 min − 30 break = 510 paid; scheduledPaid = 450 → OT = 60
    const r = calculateSessionMinutes(
      "2025-01-01T22:00:00Z",
      "2025-01-02T07:00:00Z",
      30,
      schedule,
    );
    expect(r.overtimeMinutes).toBe(60);
  });
});
