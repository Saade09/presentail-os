/**
 * Business logic helpers for Time & Attendance minute calculations.
 *
 * All inputs and outputs are in minutes (integers) unless noted.
 */

export type ScheduleWindow = {
  /** HH:MM string, e.g. "09:00" */
  startTime: string;
  /** HH:MM string, e.g. "17:00" */
  endTime: string;
  /** Scheduled break minutes (from work_schedule_days.break_minutes) */
  scheduledBreakMinutes: number;
};

export type SessionMinuteResult = {
  grossMinutes: number;
  breakMinutes: number;
  paidMinutes: number;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  overtimeMinutes: number;
};

/** Grace period for lateness in minutes (arriving within 5 min is not late). */
const LATE_GRACE_MINUTES = 5;

/**
 * Parse a "HH:MM" time string into the number of minutes since midnight.
 */
function timeStrToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * Calculate all minute-level metrics for an attendance session.
 *
 * @param clockInAt  - ISO timestamp of when the employee clocked in.
 * @param clockOutAt - ISO timestamp of when the employee clocked out.
 * @param breakMinutes - Total minutes spent on breaks (sum of completed breaks).
 * @param schedule   - Optional scheduled window for the day.
 */
export function calculateSessionMinutes(
  clockInAt: Date | string,
  clockOutAt: Date | string,
  breakMinutes: number,
  schedule?: ScheduleWindow,
): SessionMinuteResult {
  const inTs = new Date(clockInAt).getTime();
  const outTs = new Date(clockOutAt).getTime();

  const grossMinutes = Math.max(0, Math.round((outTs - inTs) / 60_000));
  const paidMinutes = Math.max(0, grossMinutes - breakMinutes);

  let lateMinutes = 0;
  let earlyLeaveMinutes = 0;
  let overtimeMinutes = 0;

  if (schedule) {
    // Determine the date from the clock-in timestamp so we can build absolute
    // timestamps for the schedule window.
    const dateStr = new Date(clockInAt).toISOString().slice(0, 10); // YYYY-MM-DD
    const schedStart = new Date(`${dateStr}T${schedule.startTime}:00`).getTime();
    let schedEnd = new Date(`${dateStr}T${schedule.endTime}:00`).getTime();
    // Overnight shift: end time is earlier in the day than start time (e.g. 22:00–06:00).
    // Advance schedEnd by 24 hours so the window spans midnight correctly.
    if (schedEnd <= schedStart) {
      schedEnd += 24 * 60 * 60 * 1000;
    }
    const schedMinutes = Math.max(
      0,
      Math.round((schedEnd - schedStart) / 60_000),
    );

    // Late: clocked in more than LATE_GRACE_MINUTES after schedule start
    const minsLate = Math.round((inTs - schedStart) / 60_000);
    if (minsLate > LATE_GRACE_MINUTES) {
      lateMinutes = minsLate;
    }

    // Early leave: clocked out before schedule end
    const minsEarly = Math.round((schedEnd - outTs) / 60_000);
    if (minsEarly > 0) {
      earlyLeaveMinutes = minsEarly;
    }

    // Overtime: paid minutes exceed the scheduled paid minutes (sched minus break)
    const schedPaid = Math.max(
      0,
      schedMinutes - (schedule.scheduledBreakMinutes ?? 0),
    );
    if (paidMinutes > schedPaid) {
      overtimeMinutes = paidMinutes - schedPaid;
    }
  }

  return {
    grossMinutes,
    breakMinutes,
    paidMinutes,
    lateMinutes,
    earlyLeaveMinutes,
    overtimeMinutes,
  };
}

/**
 * Sum the completed break minutes from a list of break records.
 */
export function sumBreakMinutes(
  breaks: Array<{ break_start_at: string | Date; break_end_at: string | Date | null }>,
): number {
  return breaks.reduce((total, b) => {
    if (!b.break_end_at) return total;
    const start = new Date(b.break_start_at).getTime();
    const end = new Date(b.break_end_at).getTime();
    return total + Math.max(0, Math.round((end - start) / 60_000));
  }, 0);
}
