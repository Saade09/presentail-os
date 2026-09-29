/**
 * Background job that alerts team members when a cash session has been open
 * too long or has passed its location's daily-close cutoff.
 *
 * Runs every POLL_INTERVAL_MS (5 minutes) and executes four independent checks:
 *
 *  - long_open        : session open > 8 hours — notify managers
 *  - closing_time     : past the cutoff time but still within the grace period
 *                       — notify the session opener
 *  - overdue          : past cutoff + grace — notify opener and broadcast SSE
 *  - manager_escalation: 60 min past grace — fan out to workspace owners /
 *                        cash_sessions.approve role members
 *
 * Each notification stage is idempotent via the `cash_session_reminders` DB
 * table. A row is inserted (ON CONFLICT DO NOTHING) before sending; if a row
 * already exists the send is skipped. This survives server restarts, replacing
 * the old in-memory Sets.
 */

import { db } from "./db";
import { logger } from "./logger";
import { broadcastEvent } from "./eventsSse";
import {
  notifyCashSessionLongOpenAlerts,
  notifyCashSessionClosingTimeAlert,
  notifyCashSessionOverdueAlerts,
  notifyCashSessionManagerEscalationAlerts,
} from "./orderAlerts";

const POLL_INTERVAL_MS = 5 * 60 * 1_000; // 5 minutes
const LONG_OPEN_THRESHOLD_HOURS = 8;
const MANAGER_ESCALATION_MINUTES_PAST_GRACE = 60;

// ── Row types ─────────────────────────────────────────────────────────────────

type LongOpenRow = {
  id: number;
  session_number: string;
  workspace_owner_id: string;
  drawer_name: string | null;
  location_name: string | null;
  opened_at: string;
};

type ClosingTimeRow = {
  id: number;
  session_number: string;
  workspace_owner_id: string;
  drawer_name: string | null;
  location_name: string | null;
  opened_at: string;
  opener_expo_token: string | null;
};

type OverdueRow = {
  id: number;
  session_number: string;
  workspace_owner_id: string;
  drawer_name: string | null;
  location_name: string | null;
  opened_at: string;
  overdue_at: string;
  location_timezone: string;
  opener_expo_token: string | null;
};

type ManagerEscalationRow = {
  id: number;
  session_number: string;
  workspace_owner_id: string;
  drawer_name: string | null;
  location_name: string | null;
  opened_at: string;
};

// ── DB idempotency helper ──────────────────────────────────────────────────────

/**
 * Attempts to record a reminder for the given (session, type) pair.
 * Returns true if the row was newly inserted — meaning this stage fires for
 * the first time and the notification should be sent.
 * Returns false if a row already existed — skip sending (already done).
 */
export async function markReminderSent(
  workspaceId: string,
  sessionId: number,
  reminderType: "closing_time" | "overdue" | "manager_escalation" | "long_open",
): Promise<boolean> {
  const result = await db.query(
    `INSERT INTO cash_session_reminders (workspace_id, cash_session_id, reminder_type)
     VALUES ($1, $2, $3)
     ON CONFLICT (cash_session_id, reminder_type) DO NOTHING`,
    [workspaceId, sessionId, reminderType],
  );
  return (result.rowCount ?? 0) > 0;
}

// ── Check functions ───────────────────────────────────────────────────────────

/** 8-hour long-open alert — notifies managers. */
async function runLongOpenCheck(): Promise<void> {
  const result = await db.query<LongOpenRow>(
    `SELECT cs.id,
            cs.session_number,
            cs.workspace_owner_id,
            d.name  AS drawer_name,
            l.name  AS location_name,
            cs.opened_at
       FROM cash_sessions cs
       JOIN cash_drawers d  ON d.id  = cs.drawer_id
       LEFT JOIN locations l ON l.id = cs.location_id
      WHERE cs.status  = 'open'
        AND cs.opened_at < now() - ($1 || ' hours')::interval`,
    [LONG_OPEN_THRESHOLD_HOURS],
  );

  for (const row of result.rows) {
    const isFirst = await markReminderSent(row.workspace_owner_id, row.id, "long_open");
    if (!isFirst) continue;

    const label = row.drawer_name ?? row.session_number;

    broadcastEvent(row.workspace_owner_id, {
      event: "cash_session.long_open",
      workspaceId: row.workspace_owner_id,
      data: {
        id: row.id,
        sessionNumber: row.session_number,
        drawerName: row.drawer_name,
        locationName: row.location_name,
        openedAt: row.opened_at,
      },
    });

    void notifyCashSessionLongOpenAlerts(
      row.workspace_owner_id,
      row.id,
      row.session_number,
      label,
    );
  }
}

/**
 * Stage 1 — closing-time reminder.
 * Fires when the session is past the cutoff time but still within the grace
 * period. Notifies the session opener via Expo push.
 */
async function runClosingTimeCheck(): Promise<void> {
  const result = await db.query<ClosingTimeRow>(
    `SELECT cs.id,
            cs.session_number,
            cs.workspace_owner_id,
            d.name  AS drawer_name,
            l.name  AS location_name,
            cs.opened_at,
            tm.expo_push_token AS opener_expo_token
       FROM cash_sessions cs
       JOIN cash_drawers d ON d.id = cs.drawer_id
       LEFT JOIN locations l ON l.id = cs.location_id
       LEFT JOIN workspace_settings ws ON ws.workspace_owner_id = cs.workspace_owner_id
       LEFT JOIN team_members tm ON tm.id = cs.opened_by_member_id
      WHERE cs.status = 'open'
        AND l.same_day_cutoff_time IS NOT NULL
        AND l.timezone IS NOT NULL
        -- Past the cutoff time (in location timezone)
        AND (
          date_trunc('day', cs.opened_at AT TIME ZONE l.timezone)
          + l.same_day_cutoff_time::interval
        ) AT TIME ZONE l.timezone < now()
        -- But still within the grace window (not yet overdue)
        AND (
          date_trunc('day', cs.opened_at AT TIME ZONE l.timezone)
          + l.same_day_cutoff_time::interval
          + COALESCE(l.grace_period_minutes, ws.cash_session_overdue_grace_minutes, 30) * INTERVAL '1 minute'
        ) AT TIME ZONE l.timezone >= now()`,
  );

  for (const row of result.rows) {
    const isFirst = await markReminderSent(row.workspace_owner_id, row.id, "closing_time");
    if (!isFirst) continue;

    void notifyCashSessionClosingTimeAlert(
      row.workspace_owner_id,
      row.id,
      row.session_number,
      row.drawer_name,
      row.opener_expo_token,
    );
  }
}

/**
 * Stage 2 — overdue alert.
 * Fires when the session is past cutoff + grace. Notifies the session opener
 * via Expo push and broadcasts the enriched cash_session.overdue SSE event.
 */
async function runOverdueCheck(): Promise<void> {
  const result = await db.query<OverdueRow>(
    `SELECT cs.id,
            cs.session_number,
            cs.workspace_owner_id,
            d.name AS drawer_name,
            l.name AS location_name,
            cs.opened_at,
            (
              date_trunc('day', cs.opened_at AT TIME ZONE l.timezone)
              + l.same_day_cutoff_time::interval
              + COALESCE(l.grace_period_minutes, ws.cash_session_overdue_grace_minutes, 30) * INTERVAL '1 minute'
            ) AT TIME ZONE l.timezone AS overdue_at,
            l.timezone AS location_timezone,
            tm.expo_push_token AS opener_expo_token
       FROM cash_sessions cs
       JOIN cash_drawers d ON d.id = cs.drawer_id
       LEFT JOIN locations l ON l.id = cs.location_id
       LEFT JOIN workspace_settings ws ON ws.workspace_owner_id = cs.workspace_owner_id
       LEFT JOIN team_members tm ON tm.id = cs.opened_by_member_id
      WHERE cs.status = 'open'
        AND l.same_day_cutoff_time IS NOT NULL
        AND l.timezone IS NOT NULL
        AND (
          date_trunc('day', cs.opened_at AT TIME ZONE l.timezone)
          + l.same_day_cutoff_time::interval
          + COALESCE(l.grace_period_minutes, ws.cash_session_overdue_grace_minutes, 30) * INTERVAL '1 minute'
        ) AT TIME ZONE l.timezone < now()`,
  );

  for (const row of result.rows) {
    const isFirst = await markReminderSent(row.workspace_owner_id, row.id, "overdue");
    if (!isFirst) continue;

    broadcastEvent(row.workspace_owner_id, {
      event: "cash_session.overdue",
      workspaceId: row.workspace_owner_id,
      data: {
        id: row.id,
        sessionNumber: row.session_number,
        drawerName: row.drawer_name,
        locationName: row.location_name,
        openedAt: row.opened_at,
        overdueAt: row.overdue_at,
        locationTimezone: row.location_timezone,
      },
    });

    void notifyCashSessionOverdueAlerts(
      row.workspace_owner_id,
      row.id,
      row.session_number,
      row.drawer_name,
      row.opener_expo_token,
    );
  }
}

/**
 * Stage 3 — manager escalation.
 * Fires 60 minutes after the grace period expired. Fans out to workspace
 * owners and members with the cash_sessions.approve permission.
 */
async function runManagerEscalationCheck(): Promise<void> {
  const result = await db.query<ManagerEscalationRow>(
    `SELECT cs.id,
            cs.session_number,
            cs.workspace_owner_id,
            d.name AS drawer_name,
            l.name AS location_name,
            cs.opened_at
       FROM cash_sessions cs
       JOIN cash_drawers d ON d.id = cs.drawer_id
       LEFT JOIN locations l ON l.id = cs.location_id
       LEFT JOIN workspace_settings ws ON ws.workspace_owner_id = cs.workspace_owner_id
      WHERE cs.status = 'open'
        AND l.same_day_cutoff_time IS NOT NULL
        AND l.timezone IS NOT NULL
        AND (
          date_trunc('day', cs.opened_at AT TIME ZONE l.timezone)
          + l.same_day_cutoff_time::interval
          + COALESCE(l.grace_period_minutes, ws.cash_session_overdue_grace_minutes, 30) * INTERVAL '1 minute'
          + $1 * INTERVAL '1 minute'
        ) AT TIME ZONE l.timezone < now()`,
    [MANAGER_ESCALATION_MINUTES_PAST_GRACE],
  );

  for (const row of result.rows) {
    const isFirst = await markReminderSent(row.workspace_owner_id, row.id, "manager_escalation");
    if (!isFirst) continue;

    void notifyCashSessionManagerEscalationAlerts(
      row.workspace_owner_id,
      row.id,
      row.session_number,
      row.drawer_name,
    );
  }
}

// ── Poller orchestration ──────────────────────────────────────────────────────

async function runCheck(): Promise<void> {
  await Promise.all([
    runLongOpenCheck(),
    runClosingTimeCheck(),
    runOverdueCheck(),
    runManagerEscalationCheck(),
  ]);
}

export function startCashSessionPoller(): void {
  const tick = async () => {
    try {
      await runCheck();
    } catch (err) {
      logger.warn({ err }, "Cash-session poller error");
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, POLL_INTERVAL_MS);

  timer.unref?.();

  logger.info("Cash-session long-open/overdue poller started");
}
