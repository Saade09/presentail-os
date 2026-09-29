import { db } from "./db";
import { logger } from "./logger";
import { sendExpoPushNotification } from "./expoPush";

const JOB_INTERVAL_MS = 5 * 60_000;
const INITIAL_DELAY_MS = 60_000;

async function teamMembersTableExists(): Promise<boolean> {
  const result = await db.query<{ exists: boolean }>(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'team_members'
    ) AS exists;
  `);
  return result.rows[0]?.exists ?? false;
}

/**
 * How many minutes after the first alert to send the follow-up reminder.
 * Configurable via MISSED_CLOCKOUT_REMINDER_DELAY_MINUTES env var; defaults to 30.
 */
const REMINDER_DELAY_MINUTES = (() => {
  const v = parseInt(process.env["MISSED_CLOCKOUT_REMINDER_DELAY_MINUTES"] ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : 30;
})();

/**
 * Format a DB time value ("HH:MM:SS" or "HH:MM") to a human-readable 12-hour
 * string such as "5:00 PM".
 */
function formatTime12h(timeStr: string): string {
  const [hhRaw, mmRaw] = timeStr.split(":");
  const hh = parseInt(hhRaw ?? "0", 10);
  const mm = mmRaw ?? "00";
  const period = hh >= 12 ? "PM" : "AM";
  const hour12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${hour12}:${mm} ${period}`;
}

/**
 * Format a fractional hours value as a compact human-readable string, e.g. "2 h".
 * Rounds to the nearest whole hour (minimum 1 h).
 */
function formatHoursAgo(hoursOverdue: number): string {
  const rounded = Math.max(1, Math.round(hoursOverdue));
  return `${rounded} h`;
}

type OverdueRow = {
  session_id: number;
  workspace_owner_id: string;
  employee_id: number;
  emp_first_name: string;
  emp_last_name: string | null;
  manager_id: number;
  manager_push_token: string;
  scheduled_end_time: string;
};

type ReminderRow = OverdueRow & {
  hours_overdue: number;
};

/**
 * Find all open attendance sessions that have passed their scheduled end time
 * and whose manager has not yet been notified.
 *
 * Conditions:
 *   - session is still open (no clock_out_at, status = 'open')
 *   - employee has a work schedule with an end_time for the clock-in day
 *   - the scheduled end time (in UTC) is in the past
 *   - missed_clockout_notif_sent_at IS NULL (not yet notified)
 *   - the employee's direct manager has an expo_push_token
 *   - session started within the last 40 hours (prevents surfacing ancient open sessions)
 */
async function fetchOverdueSessions(): Promise<OverdueRow[]> {
  const result = await db.query<OverdueRow>(
    `SELECT
       s.id                        AS session_id,
       s.workspace_owner_id,
       s.employee_id,
       tm.first_name               AS emp_first_name,
       tm.last_name                AS emp_last_name,
       mgr.id                      AS manager_id,
       mgr.expo_push_token         AS manager_push_token,
       wsd.end_time                AS scheduled_end_time
     FROM attendance_sessions s
     JOIN team_members tm  ON tm.id  = s.employee_id
     JOIN team_members mgr ON mgr.id = tm.manager_id
     LEFT JOIN team_member_profiles tmp
       ON  tmp.team_member_id    = tm.id
       AND tmp.workspace_owner_id = tm.workspace_owner_id
     LEFT JOIN locations l ON l.id = s.location_id
     JOIN work_schedule_days wsd
       ON  wsd.schedule_id = COALESCE(tmp.work_schedule_id, l.default_schedule_id)
       AND wsd.day_of_week = CASE EXTRACT(DOW FROM s.clock_in_at AT TIME ZONE 'UTC')
             WHEN 0 THEN 'sunday'    WHEN 1 THEN 'monday'
             WHEN 2 THEN 'tuesday'   WHEN 3 THEN 'wednesday'
             WHEN 4 THEN 'thursday'  WHEN 5 THEN 'friday'
             WHEN 6 THEN 'saturday'
           END
     WHERE s.status = 'open'
       AND s.clock_out_at IS NULL
       AND s.missed_clockout_notif_sent_at IS NULL
       AND wsd.is_working_day = true
       AND wsd.end_time IS NOT NULL
       AND (DATE(s.clock_in_at AT TIME ZONE 'UTC') + wsd.end_time::time) AT TIME ZONE 'UTC' < now()
       AND s.clock_in_at >= now() - INTERVAL '40 hours'
       AND mgr.expo_push_token IS NOT NULL`,
    [],
  );

  return result.rows;
}

/**
 * Find open sessions where the first alert was already sent at least
 * REMINDER_DELAY_MINUTES ago but the follow-up reminder has not yet been sent.
 * Returns the same columns as OverdueRow plus hours_overdue (fractional hours
 * since the shift's scheduled end time).
 *
 * No further notifications are sent after the reminder (reminder_sent_at set).
 */
async function fetchSessionsNeedingReminder(): Promise<ReminderRow[]> {
  const result = await db.query<ReminderRow>(
    `SELECT
       s.id                        AS session_id,
       s.workspace_owner_id,
       s.employee_id,
       tm.first_name               AS emp_first_name,
       tm.last_name                AS emp_last_name,
       mgr.id                      AS manager_id,
       mgr.expo_push_token         AS manager_push_token,
       wsd.end_time                AS scheduled_end_time,
       EXTRACT(EPOCH FROM (
         now() - ((DATE(s.clock_in_at AT TIME ZONE 'UTC') + wsd.end_time::time) AT TIME ZONE 'UTC')
       )) / 3600                   AS hours_overdue
     FROM attendance_sessions s
     JOIN team_members tm  ON tm.id  = s.employee_id
     JOIN team_members mgr ON mgr.id = tm.manager_id
     LEFT JOIN team_member_profiles tmp
       ON  tmp.team_member_id    = tm.id
       AND tmp.workspace_owner_id = tm.workspace_owner_id
     LEFT JOIN locations l ON l.id = s.location_id
     JOIN work_schedule_days wsd
       ON  wsd.schedule_id = COALESCE(tmp.work_schedule_id, l.default_schedule_id)
       AND wsd.day_of_week = CASE EXTRACT(DOW FROM s.clock_in_at AT TIME ZONE 'UTC')
             WHEN 0 THEN 'sunday'    WHEN 1 THEN 'monday'
             WHEN 2 THEN 'tuesday'   WHEN 3 THEN 'wednesday'
             WHEN 4 THEN 'thursday'  WHEN 5 THEN 'friday'
             WHEN 6 THEN 'saturday'
           END
     WHERE s.status = 'open'
       AND s.clock_out_at IS NULL
       AND s.missed_clockout_notif_sent_at IS NOT NULL
       AND s.missed_clockout_reminder_sent_at IS NULL
       AND s.missed_clockout_notif_sent_at < now() - ($1 * INTERVAL '1 minute')
       AND wsd.is_working_day = true
       AND wsd.end_time IS NOT NULL
       AND (DATE(s.clock_in_at AT TIME ZONE 'UTC') + wsd.end_time::time) AT TIME ZONE 'UTC' < now()
       AND s.clock_in_at >= now() - INTERVAL '40 hours'
       AND mgr.expo_push_token IS NOT NULL`,
    [REMINDER_DELAY_MINUTES],
  );

  return result.rows;
}

async function notifyManager(
  row: OverdueRow,
  title: string,
  body: string,
): Promise<boolean> {
  const pushResult = await sendExpoPushNotification(
    row.manager_push_token,
    title,
    body,
    { screen: "attendance" },
    async (staleToken: string) => {
      await db.query(
        `UPDATE team_members SET expo_push_token = NULL, updated_at = now()
          WHERE expo_push_token = $1`,
        [staleToken],
      );
    },
  );
  return pushResult.success;
}

async function runCheck(): Promise<void> {
  if (!(await teamMembersTableExists())) {
    return;
  }

  const [sessions, reminderSessions] = await Promise.all([
    fetchOverdueSessions(),
    fetchSessionsNeedingReminder(),
  ]);

  if (sessions.length === 0 && reminderSessions.length === 0) return;

  if (sessions.length > 0) {
    logger.info({ count: sessions.length }, "missed-clock-out job: found overdue open sessions");
  }
  if (reminderSessions.length > 0) {
    logger.info({ count: reminderSessions.length }, "missed-clock-out job: found sessions needing reminder");
  }

  for (const row of sessions) {
    const employeeName = [row.emp_first_name, row.emp_last_name].filter(Boolean).join(" ");
    const endTimeLabel = formatTime12h(row.scheduled_end_time);
    const title = "Missed Clock-Out";
    const body = `${employeeName} hasn't clocked out — shift ended at ${endTimeLabel}`;

    const ok = await notifyManager(row, title, body);
    if (!ok) {
      logger.warn(
        { sessionId: row.session_id, employeeId: row.employee_id },
        "missed-clock-out job: push notification failed after retries; leaving session unmarked for retry",
      );
      continue;
    }

    try {
      await db.query(
        `UPDATE attendance_sessions
            SET missed_clockout_notif_sent_at = now()
          WHERE id = $1`,
        [row.session_id],
      );
    } catch (err: unknown) {
      logger.warn(
        { err, sessionId: row.session_id },
        "missed-clock-out job: failed to mark session as notified",
      );
    }

    logger.info(
      { sessionId: row.session_id, employeeId: row.employee_id, managerId: row.manager_id },
      "missed-clock-out job: notification sent to manager",
    );
  }

  for (const row of reminderSessions) {
    const employeeName = [row.emp_first_name, row.emp_last_name].filter(Boolean).join(" ");
    const endTimeLabel = formatTime12h(row.scheduled_end_time);
    const hoursAgo = formatHoursAgo(row.hours_overdue);
    const title = "Still No Clock-Out";
    const body = `Still no clock-out — ${employeeName}'s shift ended at ${endTimeLabel} (${hoursAgo} ago)`;

    const ok = await notifyManager(row, title, body);
    if (!ok) {
      logger.warn(
        { sessionId: row.session_id, employeeId: row.employee_id },
        "missed-clock-out job: reminder push failed after retries; leaving reminder unmarked for retry",
      );
      continue;
    }

    try {
      await db.query(
        `UPDATE attendance_sessions
            SET missed_clockout_reminder_sent_at = now()
          WHERE id = $1`,
        [row.session_id],
      );
    } catch (err: unknown) {
      logger.warn(
        { err, sessionId: row.session_id },
        "missed-clock-out job: failed to mark reminder as sent",
      );
    }

    logger.info(
      { sessionId: row.session_id, employeeId: row.employee_id, managerId: row.manager_id },
      "missed-clock-out job: reminder notification sent to manager",
    );
  }
}

export function startMissedClockOutJob(): void {
  const tick = async () => {
    try {
      await runCheck();
    } catch (err: unknown) {
      logger.warn({ err }, "missed-clock-out job: unexpected error during check");
    }
  };

  setTimeout(tick, INITIAL_DELAY_MS);
  setInterval(tick, JOB_INTERVAL_MS);
  logger.info(
    { reminderDelayMinutes: REMINDER_DELAY_MINUTES },
    "Missed clock-out notification job started (runs every 5 minutes, first run in 60s)",
  );
}
