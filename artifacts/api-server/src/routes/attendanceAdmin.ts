import { Router } from "express";
import { db } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";
import { logger } from "../lib/logger";
import { calculateSessionMinutes, sumBreakMinutes } from "../lib/attendanceCalc";
import { sendExpoPushNotification } from "../lib/expoPush";
import { subscribeAttendance } from "../lib/attendanceSse";

const router = Router();

router.use(requireAuth, resolveWorkspace);

// ─── Helpers ──────────────────────────────────────────────────────────────────

const REQUEST_TYPE_LABELS: Record<string, string> = {
  edit_clock_in: "Clock-in edit",
  edit_clock_out: "Clock-out edit",
  missed_clock_in: "Missed clock-in",
  missed_clock_out: "Missed clock-out",
  offsite_clock_in: "Remote clock-in",
  offsite_clock_out: "Remote clock-out",
};

/**
 * Look up the employee's Expo push token and send an attendance correction
 * decision notification. Clears the stored token if it's no longer registered.
 * This is fire-and-forget — callers should void + catch.
 */
async function sendAttendanceCorrectionPush(
  employeeId: number,
  requestType: string,
  decision: "approved" | "rejected",
): Promise<void> {
  const tokenResult = await db.query<{ expo_push_token: string | null }>(
    `SELECT expo_push_token FROM team_members WHERE id = $1`,
    [employeeId],
  );
  const token = tokenResult.rows[0]?.expo_push_token;
  if (!token) return;

  const typeLabel = REQUEST_TYPE_LABELS[requestType] ?? "Attendance correction";
  const title = decision === "approved" ? "Request Approved ✓" : "Request Rejected";
  const body =
    decision === "approved"
      ? `Your ${typeLabel.toLowerCase()} request has been approved.`
      : `Your ${typeLabel.toLowerCase()} request has been rejected.`;

  const result = await sendExpoPushNotification(
    token,
    title,
    body,
    { screen: "my-requests" },
    async (staleToken: string) => {
      await db.query(
        `UPDATE team_members SET expo_push_token = NULL, updated_at = now() WHERE expo_push_token = $1`,
        [staleToken],
      );
    },
  );

  if (!result.success) {
    await db.query(
      `UPDATE team_members SET expo_push_token = NULL, updated_at = now() WHERE expo_push_token = $1`,
      [token],
    );
  }
}

/**
 * Look up the employee's Expo push token and send an attendance session
 * decision notification. Clears the stored token if it's no longer registered.
 * This is fire-and-forget — callers should void + catch.
 */
async function sendAttendanceSessionPush(
  employeeId: number,
  decision: "approved" | "rejected" | "locked",
): Promise<void> {
  const tokenResult = await db.query<{ expo_push_token: string | null }>(
    `SELECT expo_push_token FROM team_members WHERE id = $1`,
    [employeeId],
  );
  const token = tokenResult.rows[0]?.expo_push_token;
  if (!token) return;

  const title =
    decision === "approved"
      ? "Session Approved ✓"
      : decision === "locked"
        ? "Session Locked"
        : "Session Reviewed";
  const body =
    decision === "approved"
      ? "Your attendance session has been approved."
      : decision === "locked"
        ? "Your attendance session has been finalized."
        : "Your attendance session has been reviewed — please check any notes from your manager.";

  const result = await sendExpoPushNotification(
    token,
    title,
    body,
    { screen: "attendance" },
    async (staleToken: string) => {
      await db.query(
        `UPDATE team_members SET expo_push_token = NULL, updated_at = now() WHERE expo_push_token = $1`,
        [staleToken],
      );
    },
  );

  if (!result.success) {
    await db.query(
      `UPDATE team_members SET expo_push_token = NULL, updated_at = now() WHERE expo_push_token = $1`,
      [token],
    );
  }
}

async function writeAuditLog(opts: {
  workspaceOwnerId: string;
  sessionId: number | null;
  requestId: number | null;
  actorUserId: string;
  action: string;
  oldValue?: unknown;
  newValue?: unknown;
}): Promise<void> {
  try {
    await db.query(
      `INSERT INTO attendance_audit_logs
         (workspace_owner_id, attendance_session_id, attendance_request_id,
          actor_user_id, action, old_value_json, new_value_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        opts.workspaceOwnerId,
        opts.sessionId ?? null,
        opts.requestId ?? null,
        opts.actorUserId,
        opts.action,
        opts.oldValue !== undefined ? JSON.stringify(opts.oldValue) : null,
        opts.newValue !== undefined ? JSON.stringify(opts.newValue) : null,
      ],
    );
  } catch (err) {
    logger.warn({ err, action: opts.action, sessionId: opts.sessionId, requestId: opts.requestId }, "attendance_audit_logs INSERT failed; primary operation already succeeded");
  }
}

/**
 * Look up the employee's work schedule for the given session date.
 * Priority: team_member_profiles.work_schedule_id → locations.default_schedule_id.
 * Returns undefined when no schedule is configured for that day.
 */
async function fetchScheduleWindow(
  workspaceOwnerId: string,
  employeeId: number,
  locationId: number | null,
  sessionDate: Date,
): Promise<import("../lib/attendanceCalc").ScheduleWindow | undefined> {
  const DAY_NAMES = [
    "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
  ] as const;
  const dayOfWeek = DAY_NAMES[sessionDate.getDay()];
  const result = await db.query(
    `SELECT wsd.start_time, wsd.end_time, wsd.break_minutes
       FROM team_members tm
       LEFT JOIN team_member_profiles tmp
         ON tmp.team_member_id = tm.id
        AND tmp.workspace_owner_id = tm.workspace_owner_id
       LEFT JOIN locations l ON l.id = $3
       LEFT JOIN work_schedule_days wsd
         ON wsd.schedule_id = COALESCE(tmp.work_schedule_id, l.default_schedule_id)
        AND wsd.day_of_week = $4
      WHERE tm.id = $1 AND tm.workspace_owner_id = $2
      LIMIT 1`,
    [employeeId, workspaceOwnerId, locationId, dayOfWeek],
  );
  const row = result.rows[0] as
    | { start_time: string; end_time: string; break_minutes: number }
    | undefined;
  if (row?.start_time && row?.end_time) {
    return {
      startTime: row.start_time.slice(0, 5),
      endTime: row.end_time.slice(0, 5),
      scheduledBreakMinutes: row.break_minutes ?? 0,
    };
  }
  return undefined;
}

/** Returns true if the caller is an owner or a manager for the given employee. */
async function canManageEmployee(
  workspaceOwnerId: string,
  callerUserId: string,
  callerRole: string,
  employeeId: number,
): Promise<boolean> {
  if (callerRole === "owner") return true;
  // Schema sentinel: reads workspace_members.member_user_id (WHERE wm.member_user_id = $3).
  // Update here if member_user_id is renamed.
  const r = await db.query(
    `SELECT 1
       FROM team_members emp
       JOIN team_members mgr ON mgr.id = emp.manager_id
       JOIN workspace_members wm ON wm.id = mgr.member_db_id
      WHERE emp.id = $1
        AND emp.workspace_owner_id = $2
        AND wm.member_user_id = $3
      LIMIT 1`,
    [employeeId, workspaceOwnerId, callerUserId],
  );
  return r.rows.length > 0;
}

/** Returns the employee IDs this caller manages, or null if owner (all access). */
async function getManagedEmployeeIds(
  workspaceOwnerId: string,
  callerUserId: string,
  callerRole: string,
): Promise<number[] | null> {
  if (callerRole === "owner") return null;
  // Schema sentinel: reads workspace_members.member_user_id (WHERE wm.member_user_id = $2).
  // Update here if member_user_id is renamed.
  const r = await db.query<{ id: number }>(
    `SELECT emp.id
       FROM team_members emp
       JOIN team_members mgr ON mgr.id = emp.manager_id
       JOIN workspace_members wm ON wm.id = mgr.member_db_id
      WHERE emp.workspace_owner_id = $1
        AND wm.member_user_id = $2`,
    [workspaceOwnerId, callerUserId],
  );
  return r.rows.map((row) => row.id);
}

// ─── GET /api/admin/attendance/live ───────────────────────────────────────────

router.get("/admin/attendance/live", async (req, res) => {
  const wreq = workspace(req);
  const missedClockout = req.query.missed_clockout === "true";
  const missedClockoutCond = missedClockout ? "\n            AND s.missed_clockout_notif_sent_at IS NOT NULL" : "";
  const managedIds = await getManagedEmployeeIds(
    wreq.workspaceOwnerId, wreq.userId, wreq.workspaceRole,
  );
  if (managedIds === null) {
    // owner — full access
    try {
      const today = new Date().toISOString().slice(0, 10);
      const result = await db.query(
        `SELECT s.*,
                tm.first_name || COALESCE(' ' || tm.last_name, '') AS employee_name,
                l.name AS location_name,
                (
                  SELECT json_agg(ab ORDER BY ab.break_start_at DESC)
                    FROM attendance_breaks ab
                   WHERE ab.attendance_session_id = s.id
                ) AS breaks,
                wsd.end_time AS scheduled_end_time,
                CASE
                  WHEN s.clock_out_at IS NULL
                    AND s.status = 'open'
                    AND wsd.end_time IS NOT NULL
                    AND wsd.is_working_day = true
                    AND (DATE(s.clock_in_at AT TIME ZONE 'UTC') + wsd.end_time::time) AT TIME ZONE 'UTC' < now()
                    AND s.clock_in_at >= now() - INTERVAL '40 hours'
                  THEN true
                  ELSE false
                END AS is_overdue
           FROM attendance_sessions s
           JOIN team_members tm ON tm.id = s.employee_id
           LEFT JOIN locations l ON l.id = s.location_id
           LEFT JOIN team_member_profiles tmp
             ON tmp.team_member_id = tm.id
             AND tmp.workspace_owner_id = tm.workspace_owner_id
           LEFT JOIN work_schedule_days wsd
             ON wsd.schedule_id = COALESCE(tmp.work_schedule_id, l.default_schedule_id)
             AND wsd.day_of_week = CASE EXTRACT(DOW FROM s.clock_in_at AT TIME ZONE 'UTC')
                   WHEN 0 THEN 'sunday'    WHEN 1 THEN 'monday'
                   WHEN 2 THEN 'tuesday'   WHEN 3 THEN 'wednesday'
                   WHEN 4 THEN 'thursday'  WHEN 5 THEN 'friday'
                   WHEN 6 THEN 'saturday'
                 END
          WHERE s.workspace_owner_id = $1
            AND DATE(s.clock_in_at AT TIME ZONE 'UTC') = $2${missedClockoutCond}
          ORDER BY is_overdue DESC, s.clock_in_at DESC`,
        [wreq.workspaceOwnerId, today],
      );
      res.json({ success: true, sessions: result.rows, date: today });
    } catch (err) {
      logger.error({ err }, "admin/attendance/live failed");
      res.status(500).json({ error: "Failed to load live attendance" });
    }
    return;
  }
  if (managedIds.length === 0) {
    res.status(403).json({ error: "Insufficient permissions" });
    return;
  }
  try {
    const today = new Date().toISOString().slice(0, 10);
    const placeholders = managedIds.map((_, i) => `$${i + 3}`).join(",");
    const result = await db.query(
      `SELECT s.*,
              tm.first_name || COALESCE(' ' || tm.last_name, '') AS employee_name,
              l.name AS location_name,
              (
                SELECT json_agg(ab ORDER BY ab.break_start_at DESC)
                  FROM attendance_breaks ab
                 WHERE ab.attendance_session_id = s.id
              ) AS breaks,
              wsd.end_time AS scheduled_end_time,
              CASE
                WHEN s.clock_out_at IS NULL
                  AND s.status = 'open'
                  AND wsd.end_time IS NOT NULL
                  AND wsd.is_working_day = true
                  AND (DATE(s.clock_in_at AT TIME ZONE 'UTC') + wsd.end_time::time) AT TIME ZONE 'UTC' < now()
                  AND s.clock_in_at >= now() - INTERVAL '40 hours'
                THEN true
                ELSE false
              END AS is_overdue
         FROM attendance_sessions s
         JOIN team_members tm ON tm.id = s.employee_id
         LEFT JOIN locations l ON l.id = s.location_id
         LEFT JOIN team_member_profiles tmp
           ON tmp.team_member_id = tm.id
           AND tmp.workspace_owner_id = tm.workspace_owner_id
         LEFT JOIN work_schedule_days wsd
           ON wsd.schedule_id = COALESCE(tmp.work_schedule_id, l.default_schedule_id)
           AND wsd.day_of_week = CASE EXTRACT(DOW FROM s.clock_in_at AT TIME ZONE 'UTC')
                 WHEN 0 THEN 'sunday'    WHEN 1 THEN 'monday'
                 WHEN 2 THEN 'tuesday'   WHEN 3 THEN 'wednesday'
                 WHEN 4 THEN 'thursday'  WHEN 5 THEN 'friday'
                 WHEN 6 THEN 'saturday'
               END
        WHERE s.workspace_owner_id = $1
          AND DATE(s.clock_in_at AT TIME ZONE 'UTC') = $2
          AND s.employee_id IN (${placeholders})${missedClockoutCond}
        ORDER BY is_overdue DESC, s.clock_in_at DESC`,
      [wreq.workspaceOwnerId, today, ...managedIds],
    );
    res.json({ success: true, sessions: result.rows, date: today });
  } catch (err) {
    logger.error({ err }, "admin/attendance/live failed");
    res.status(500).json({ error: "Failed to load live attendance" });
  }
});

// ─── GET /api/admin/attendance/timesheets ─────────────────────────────────────

router.get("/admin/attendance/timesheets", async (req, res) => {
  const wreq = workspace(req);
  const managedIds = await getManagedEmployeeIds(
    wreq.workspaceOwnerId, wreq.userId, wreq.workspaceRole,
  );
  if (managedIds !== null && managedIds.length === 0) {
    res.status(403).json({ error: "Insufficient permissions" });
    return;
  }
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Number(req.query.offset) || 0;
    const params: unknown[] = [wreq.workspaceOwnerId];
    const conds: string[] = ["s.workspace_owner_id = $1"];
    let i = 2;

    if (typeof req.query.employee_id === "string") {
      const requestedId = Number(req.query.employee_id);
      if (managedIds !== null && !managedIds.includes(requestedId)) {
        res.status(403).json({ error: "Insufficient permissions for this employee" });
        return;
      }
      conds.push(`s.employee_id = $${i++}`);
      params.push(requestedId);
    } else if (managedIds !== null) {
      // No employee filter requested — restrict to managed employees
      const placeholders = managedIds.map((_, idx) => `$${i++}`).join(",");
      conds.push(`s.employee_id IN (${placeholders})`);
      params.push(...managedIds);
    }
    if (typeof req.query.from === "string") {
      conds.push(`s.clock_in_at >= $${i++}`);
      params.push(req.query.from);
    }
    if (typeof req.query.to === "string") {
      conds.push(`s.clock_in_at < $${i++}`);
      params.push(req.query.to);
    }
    if (typeof req.query.status === "string") {
      conds.push(`s.status = $${i++}`);
      params.push(req.query.status);
    }
    if (typeof req.query.location_id === "string") {
      conds.push(`s.location_id = $${i++}`);
      params.push(Number(req.query.location_id));
    }
    if (req.query.missed_clockout === "true") {
      conds.push(`s.missed_clockout_notif_sent_at IS NOT NULL`);
    }

    params.push(limit, offset);
    const result = await db.query(
      `SELECT s.*,
              tm.first_name || COALESCE(' ' || tm.last_name, '') AS employee_name,
              l.name AS location_name
         FROM attendance_sessions s
         JOIN team_members tm ON tm.id = s.employee_id
         LEFT JOIN locations l ON l.id = s.location_id
        WHERE ${conds.join(" AND ")}
        ORDER BY s.clock_in_at DESC
        LIMIT $${i} OFFSET $${i + 1}`,
      params,
    );
    const countResult = await db.query(
      `SELECT COUNT(*) AS total FROM attendance_sessions s
        WHERE ${conds.join(" AND ")}`,
      params.slice(0, params.length - 2),
    );

    res.json({
      success: true,
      sessions: result.rows,
      total: Number(countResult.rows[0]?.total ?? 0),
      limit,
      offset,
    });
  } catch (err) {
    logger.error({ err }, "admin/attendance/timesheets failed");
    res.status(500).json({ error: "Failed to load timesheets" });
  }
});

// ─── GET /api/admin/attendance/requests/pending-count ─────────────────────────

router.get("/admin/attendance/requests/pending-count", async (req, res) => {
  const wreq = workspace(req);
  const managedIds = await getManagedEmployeeIds(
    wreq.workspaceOwnerId, wreq.userId, wreq.workspaceRole,
  );
  if (managedIds !== null && managedIds.length === 0) {
    res.json({ success: true, count: 0 });
    return;
  }
  try {
    // Count pending correction requests
    const reqParams: unknown[] = [wreq.workspaceOwnerId];
    const reqConds: string[] = ["ar.workspace_owner_id = $1", "ar.status = 'pending'"];
    let i = 2;

    if (managedIds !== null) {
      const placeholders = managedIds.map((_, idx) => `$${i++}`).join(",");
      reqConds.push(`ar.employee_id IN (${placeholders})`);
      reqParams.push(...managedIds);
    }

    const reqResult = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count
         FROM attendance_requests ar
        WHERE ${reqConds.join(" AND ")}`,
      reqParams,
    );

    // Count open (completed but not yet approved/rejected) sessions
    const sessParams: unknown[] = [wreq.workspaceOwnerId];
    const sessConds: string[] = [
      "s.workspace_owner_id = $1",
      "s.status = 'open'",
      "s.clock_out_at IS NOT NULL",
    ];
    let j = 2;

    if (managedIds !== null) {
      const placeholders = managedIds.map((_, idx) => `$${j++}`).join(",");
      sessConds.push(`s.employee_id IN (${placeholders})`);
      sessParams.push(...managedIds);
    }

    const sessResult = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count
         FROM attendance_sessions s
        WHERE ${sessConds.join(" AND ")}`,
      sessParams,
    );

    const correctionCount = Number(reqResult.rows[0]?.count ?? 0);
    const sessionCount = Number(sessResult.rows[0]?.count ?? 0);

    res.json({ success: true, count: correctionCount + sessionCount });
  } catch (err) {
    logger.error({ err }, "admin/attendance/requests/pending-count failed");
    res.status(500).json({ error: "Failed to load pending count" });
  }
});

// ─── GET /api/admin/attendance/requests ───────────────────────────────────────

router.get("/admin/attendance/requests", async (req, res) => {
  const wreq = workspace(req);
  const managedIds = await getManagedEmployeeIds(
    wreq.workspaceOwnerId, wreq.userId, wreq.workspaceRole,
  );
  if (managedIds !== null && managedIds.length === 0) {
    res.status(403).json({ error: "Insufficient permissions" });
    return;
  }
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Number(req.query.offset) || 0;
    const statusFilter = typeof req.query.status === "string" ? req.query.status : "pending";

    const params: unknown[] = [wreq.workspaceOwnerId, statusFilter];
    const conds: string[] = ["ar.workspace_owner_id = $1", "ar.status = $2"];
    let i = 3;

    if (managedIds !== null) {
      const placeholders = managedIds.map((_, idx) => `$${i++}`).join(",");
      conds.push(`ar.employee_id IN (${placeholders})`);
      params.push(...managedIds);
    }

    if (typeof req.query.employee_name === "string" && req.query.employee_name.trim()) {
      conds.push(`(tm.first_name || COALESCE(' ' || tm.last_name, '')) ILIKE $${i++}`);
      params.push(`%${req.query.employee_name.trim()}%`);
    }

    const result = await db.query(
      `SELECT ar.*,
              tm.first_name || COALESCE(' ' || tm.last_name, '') AS employee_name
         FROM attendance_requests ar
         JOIN team_members tm ON tm.id = ar.employee_id
        WHERE ${conds.join(" AND ")}
        ORDER BY ar.created_at DESC
        LIMIT $${i} OFFSET $${i + 1}`,
      [...params, limit, offset],
    );

    res.json({ success: true, requests: result.rows, limit, offset });
  } catch (err) {
    logger.error({ err }, "admin/attendance/requests failed");
    res.status(500).json({ error: "Failed to load correction requests" });
  }
});

// ─── POST /api/admin/attendance/requests/bulk-approve ─────────────────────────

router.post("/admin/attendance/requests/bulk-approve", async (req, res) => {
  const wreq = workspace(req);
  const body = (req.body ?? {}) as { ids?: number[]; reviewer_note?: string };
  if (!Array.isArray(body.ids) || body.ids.length === 0) {
    res.status(400).json({ error: "ids must be a non-empty array" });
    return;
  }
  const ids = body.ids.map(Number).filter((n) => Number.isFinite(n));
  if (ids.length === 0) {
    res.status(400).json({ error: "ids must be a non-empty array of integers" });
    return;
  }

  const results: { id: number; success: boolean; error?: string }[] = [];
  const now = new Date();

  for (const requestId of ids) {
    try {
      const reqResult = await db.query(
        `SELECT * FROM attendance_requests
          WHERE id = $1 AND workspace_owner_id = $2`,
        [requestId, wreq.workspaceOwnerId],
      );
      if (reqResult.rows.length === 0) {
        results.push({ id: requestId, success: false, error: "Not found" });
        continue;
      }
      const attReq = reqResult.rows[0] as {
        id: number;
        status: string;
        attendance_session_id: number | null;
        employee_id: number;
        request_type: string;
        requested_clock_in_at: string | null;
        requested_clock_out_at: string | null;
      };

      const allowed = await canManageEmployee(
        wreq.workspaceOwnerId, wreq.userId, wreq.workspaceRole, attReq.employee_id,
      );
      if (!allowed) {
        results.push({ id: requestId, success: false, error: "Insufficient permissions" });
        continue;
      }
      if (attReq.status !== "pending") {
        results.push({ id: requestId, success: false, error: "Not pending" });
        continue;
      }

      let oldSession: Record<string, unknown> | null = null;
      if (attReq.attendance_session_id) {
        const oldResult = await db.query(
          `SELECT clock_in_at, clock_out_at, status, break_minutes, location_id FROM attendance_sessions
            WHERE id = $1 AND employee_id = $2 AND workspace_owner_id = $3`,
          [attReq.attendance_session_id, attReq.employee_id, wreq.workspaceOwnerId],
        );
        if (oldResult.rows.length === 0) {
          results.push({ id: requestId, success: false, error: "Linked session not found" });
          continue;
        }
        const sessionRow = oldResult.rows[0] as {
          clock_in_at: string;
          clock_out_at: string | null;
          status: string;
          break_minutes: number | null;
          location_id: number | null;
        };
        if (sessionRow.status === "locked") {
          results.push({ id: requestId, success: false, error: "Session is locked" });
          continue;
        }
        oldSession = {
          clock_in_at: sessionRow.clock_in_at,
          clock_out_at: sessionRow.clock_out_at,
          break_minutes: sessionRow.break_minutes,
          location_id: sessionRow.location_id,
        };
      }

      await db.query(
        `UPDATE attendance_requests
            SET status = 'approved', reviewed_by = $1, reviewed_at = $2,
                reviewer_note = $3, updated_at = $2, is_read = true
          WHERE id = $4`,
        [wreq.userId, now.toISOString(), body.reviewer_note ?? null, requestId],
      );

      if (attReq.attendance_session_id && oldSession) {
        const effectiveClockIn = (
          attReq.requested_clock_in_at &&
          ["edit_clock_in", "missed_clock_in", "offsite_clock_in"].includes(attReq.request_type)
        ) ? attReq.requested_clock_in_at : (oldSession.clock_in_at as string | null);

        const effectiveClockOut = (
          attReq.requested_clock_out_at &&
          ["edit_clock_out", "missed_clock_out", "offsite_clock_out"].includes(attReq.request_type)
        ) ? attReq.requested_clock_out_at : (oldSession.clock_out_at as string | null);

        const updates: string[] = ["updated_at = $1"];
        const uParams: unknown[] = [now.toISOString()];
        let pi = 2;
        if (
          attReq.requested_clock_in_at &&
          ["edit_clock_in", "missed_clock_in", "offsite_clock_in"].includes(attReq.request_type)
        ) {
          updates.push(`clock_in_at = $${pi++}`);
          uParams.push(attReq.requested_clock_in_at);
        }
        if (
          attReq.requested_clock_out_at &&
          ["edit_clock_out", "missed_clock_out", "offsite_clock_out"].includes(attReq.request_type)
        ) {
          updates.push(`clock_out_at = $${pi++}`);
          uParams.push(attReq.requested_clock_out_at);
        }

        if (effectiveClockIn && effectiveClockOut) {
          const schedule = await fetchScheduleWindow(
            wreq.workspaceOwnerId,
            attReq.employee_id,
            oldSession.location_id as number | null,
            new Date(effectiveClockIn),
          );
          const calc = calculateSessionMinutes(
            effectiveClockIn,
            effectiveClockOut,
            (oldSession.break_minutes as number | null) ?? 0,
            schedule,
          );
          updates.push(
            `gross_minutes = $${pi++}`,
            `paid_minutes = $${pi++}`,
            `overtime_minutes = $${pi++}`,
            `late_minutes = $${pi++}`,
            `early_leave_minutes = $${pi++}`,
          );
          uParams.push(
            calc.grossMinutes,
            calc.paidMinutes,
            calc.overtimeMinutes,
            calc.lateMinutes,
            calc.earlyLeaveMinutes,
          );
        }

        if (updates.length > 1) {
          uParams.push(attReq.attendance_session_id, wreq.workspaceOwnerId);
          await db.query(
            `UPDATE attendance_sessions SET ${updates.join(", ")}
              WHERE id = $${pi} AND workspace_owner_id = $${pi + 1}`,
            uParams,
          );
        }
      } else if (
        !attReq.attendance_session_id &&
        attReq.requested_clock_in_at &&
        ["missed_clock_in", "offsite_clock_in"].includes(attReq.request_type)
      ) {
        // No linked session — create a new attendance_sessions row for the missed clock-in.
        // The unique index on (employee_id, clock_in_at) is the unconditional guard against
        // duplicates; a 23505 from the DB is surfaced as a per-item failure rather than a 409.
        let newSessionId: number;
        try {
          const insertResult = await db.query<{ id: number }>(
            `INSERT INTO attendance_sessions
               (workspace_owner_id, employee_id, clock_in_at,
                clock_in_verification_status, status)
             VALUES ($1, $2, $3, 'no_location', 'open')
             RETURNING id`,
            [wreq.workspaceOwnerId, attReq.employee_id, attReq.requested_clock_in_at],
          );
          newSessionId = insertResult.rows[0].id;
        } catch (err: unknown) {
          if ((err as { code?: string }).code === "23505") {
            await db.query(
              `UPDATE attendance_requests SET status = 'pending', reviewed_by = NULL, reviewed_at = NULL, reviewer_note = NULL WHERE id = $1`,
              [requestId],
            );
            results.push({ id: requestId, success: false, error: "A session for this employee and clock-in time already exists" });
            continue;
          }
          throw err;
        }
        await db.query(
          `UPDATE attendance_requests SET attendance_session_id = $1 WHERE id = $2`,
          [newSessionId, requestId],
        );
      } else if (
        !attReq.attendance_session_id &&
        attReq.requested_clock_out_at &&
        ["missed_clock_out", "offsite_clock_out"].includes(attReq.request_type)
      ) {
        // No linked session — create a new completed attendance_sessions row for the missed clock-out.
        // clock_in_at is NOT NULL so we use the requested_clock_out_at as a stand-in.
        // The unique index on (employee_id, clock_in_at) guards against duplicates; a 23505 is
        // surfaced as a per-item failure rather than letting a 500 propagate.
        let newSessionId: number;
        try {
          const insertResult = await db.query<{ id: number }>(
            `INSERT INTO attendance_sessions
               (workspace_owner_id, employee_id, clock_in_at, clock_out_at,
                clock_in_verification_status, clock_out_verification_status, status)
             VALUES ($1, $2, $3, $3, 'no_location', 'no_location', 'completed')
             RETURNING id`,
            [wreq.workspaceOwnerId, attReq.employee_id, attReq.requested_clock_out_at],
          );
          newSessionId = insertResult.rows[0].id;
        } catch (err: unknown) {
          if ((err as { code?: string }).code === "23505") {
            await db.query(
              `UPDATE attendance_requests SET status = 'pending', reviewed_by = NULL, reviewed_at = NULL, reviewer_note = NULL WHERE id = $1`,
              [requestId],
            );
            results.push({ id: requestId, success: false, error: "A session for this employee and clock-out time already exists" });
            continue;
          }
          throw err;
        }
        await db.query(
          `UPDATE attendance_requests SET attendance_session_id = $1 WHERE id = $2`,
          [newSessionId, requestId],
        );
      }

      await writeAuditLog({
        workspaceOwnerId: wreq.workspaceOwnerId,
        sessionId: attReq.attendance_session_id,
        requestId,
        actorUserId: wreq.userId,
        action: "request_approved",
        oldValue: oldSession,
        newValue: {
          requested_clock_in_at: attReq.requested_clock_in_at,
          requested_clock_out_at: attReq.requested_clock_out_at,
        },
      });

      void sendAttendanceCorrectionPush(attReq.employee_id, attReq.request_type, "approved").catch(
        (err: unknown) => logger.warn({ err }, "Failed to send attendance correction push (bulk approve)"),
      );

      results.push({ id: requestId, success: true });
    } catch (err) {
      logger.error({ err, requestId }, "bulk-approve item failed");
      results.push({ id: requestId, success: false, error: "Internal error" });
    }
  }

  const succeeded = results.filter((r) => r.success).length;
  res.json({ success: true, results, succeeded, failed: results.length - succeeded });
});

// ─── POST /api/admin/attendance/requests/bulk-reject ──────────────────────────

router.post("/admin/attendance/requests/bulk-reject", async (req, res) => {
  const wreq = workspace(req);
  const body = (req.body ?? {}) as { ids?: number[]; reviewer_note?: string };
  if (!Array.isArray(body.ids) || body.ids.length === 0) {
    res.status(400).json({ error: "ids must be a non-empty array" });
    return;
  }
  const ids = body.ids.map(Number).filter((n) => Number.isFinite(n));
  if (ids.length === 0) {
    res.status(400).json({ error: "ids must be a non-empty array of integers" });
    return;
  }

  const results: { id: number; success: boolean; error?: string }[] = [];
  const now = new Date();

  for (const requestId of ids) {
    try {
      const reqResult = await db.query(
        `SELECT id, status, attendance_session_id, employee_id, request_type
           FROM attendance_requests
          WHERE id = $1 AND workspace_owner_id = $2`,
        [requestId, wreq.workspaceOwnerId],
      );
      if (reqResult.rows.length === 0) {
        results.push({ id: requestId, success: false, error: "Not found" });
        continue;
      }
      const attReq = reqResult.rows[0] as {
        id: number;
        status: string;
        attendance_session_id: number | null;
        employee_id: number;
        request_type: string;
      };

      const allowed = await canManageEmployee(
        wreq.workspaceOwnerId, wreq.userId, wreq.workspaceRole, attReq.employee_id,
      );
      if (!allowed) {
        results.push({ id: requestId, success: false, error: "Insufficient permissions" });
        continue;
      }
      if (attReq.status !== "pending") {
        results.push({ id: requestId, success: false, error: "Not pending" });
        continue;
      }

      await db.query(
        `UPDATE attendance_requests
            SET status = 'rejected', reviewed_by = $1, reviewed_at = $2,
                reviewer_note = $3, updated_at = $2, is_read = true
          WHERE id = $4`,
        [wreq.userId, now.toISOString(), body.reviewer_note ?? null, requestId],
      );

      await writeAuditLog({
        workspaceOwnerId: wreq.workspaceOwnerId,
        sessionId: attReq.attendance_session_id,
        requestId,
        actorUserId: wreq.userId,
        action: "request_rejected",
      });

      void sendAttendanceCorrectionPush(attReq.employee_id, attReq.request_type, "rejected").catch(
        (err: unknown) => logger.warn({ err }, "Failed to send attendance correction push (bulk reject)"),
      );

      results.push({ id: requestId, success: true });
    } catch (err) {
      logger.error({ err, requestId }, "bulk-reject item failed");
      results.push({ id: requestId, success: false, error: "Internal error" });
    }
  }

  const succeeded = results.filter((r) => r.success).length;
  res.json({ success: true, results, succeeded, failed: results.length - succeeded });
});

// ─── POST /api/admin/attendance/requests/:id/approve ──────────────────────────

router.post("/admin/attendance/requests/:id/approve", async (req, res) => {
  const wreq = workspace(req);
  const requestId = Number(req.params.id);
  const body = (req.body ?? {}) as { reviewer_note?: string };
  try {
    // Fetch the request
    const reqResult = await db.query(
      `SELECT * FROM attendance_requests
        WHERE id = $1 AND workspace_owner_id = $2`,
      [requestId, wreq.workspaceOwnerId],
    );
    if (reqResult.rows.length === 0) {
      res.status(404).json({ error: "Request not found" });
      return;
    }
    const attReq = reqResult.rows[0] as {
      id: number;
      status: string;
      attendance_session_id: number | null;
      employee_id: number;
      request_type: string;
      requested_clock_in_at: string | null;
      requested_clock_out_at: string | null;
    };
    const allowed = await canManageEmployee(
      wreq.workspaceOwnerId, wreq.userId, wreq.workspaceRole, attReq.employee_id,
    );
    if (!allowed) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }
    if (attReq.status !== "pending") {
      res.status(409).json({ error: "Request is not pending" });
      return;
    }

    const now = new Date();

    // Pre-check: if linked to a session, verify it exists and is NOT locked before mutating anything
    let oldSession: Record<string, unknown> | null = null;
    if (attReq.attendance_session_id) {
      const oldResult = await db.query(
        `SELECT clock_in_at, clock_out_at, status, break_minutes, location_id FROM attendance_sessions
          WHERE id = $1 AND employee_id = $2 AND workspace_owner_id = $3`,
        [attReq.attendance_session_id, attReq.employee_id, wreq.workspaceOwnerId],
      );
      if (oldResult.rows.length === 0) {
        res.status(404).json({ error: "Linked session not found" });
        return;
      }
      const sessionRow = oldResult.rows[0] as {
        clock_in_at: string;
        clock_out_at: string | null;
        status: string;
        break_minutes: number | null;
        location_id: number | null;
      };
      if (sessionRow.status === "locked") {
        res.status(409).json({ error: "Session is locked and cannot be modified" });
        return;
      }
      oldSession = {
        clock_in_at: sessionRow.clock_in_at,
        clock_out_at: sessionRow.clock_out_at,
        break_minutes: sessionRow.break_minutes,
        location_id: sessionRow.location_id,
      };
    }

    // Mark request approved (only after all pre-checks pass)
    await db.query(
      `UPDATE attendance_requests
          SET status = 'approved', reviewed_by = $1, reviewed_at = $2,
              reviewer_note = $3, updated_at = $2, is_read = true
        WHERE id = $4`,
      [wreq.userId, now.toISOString(), body.reviewer_note ?? null, requestId],
    );

    // Apply correction to the linked session, or create a new one for missed clock-ins
    if (attReq.attendance_session_id && oldSession) {
      // Determine effective clock times after applying the correction
      const effectiveClockIn = (
        attReq.requested_clock_in_at &&
        ["edit_clock_in", "missed_clock_in", "offsite_clock_in"].includes(attReq.request_type)
      ) ? attReq.requested_clock_in_at : (oldSession.clock_in_at as string | null);

      const effectiveClockOut = (
        attReq.requested_clock_out_at &&
        ["edit_clock_out", "missed_clock_out", "offsite_clock_out"].includes(attReq.request_type)
      ) ? attReq.requested_clock_out_at : (oldSession.clock_out_at as string | null);

      const updates: string[] = ["updated_at = $1"];
      const uParams: unknown[] = [now.toISOString()];
      let pi = 2;

      if (
        attReq.requested_clock_in_at &&
        ["edit_clock_in", "missed_clock_in", "offsite_clock_in"].includes(attReq.request_type)
      ) {
        updates.push(`clock_in_at = $${pi++}`);
        uParams.push(attReq.requested_clock_in_at);
      }
      if (
        attReq.requested_clock_out_at &&
        ["edit_clock_out", "missed_clock_out", "offsite_clock_out"].includes(attReq.request_type)
      ) {
        updates.push(`clock_out_at = $${pi++}`);
        uParams.push(attReq.requested_clock_out_at);
      }

      // Recalculate derived minute fields when both clock times are available
      if (effectiveClockIn && effectiveClockOut) {
        const schedule = await fetchScheduleWindow(
          wreq.workspaceOwnerId,
          attReq.employee_id,
          oldSession.location_id as number | null,
          new Date(effectiveClockIn),
        );
        const calc = calculateSessionMinutes(
          effectiveClockIn,
          effectiveClockOut,
          (oldSession.break_minutes as number | null) ?? 0,
          schedule,
        );
        updates.push(
          `gross_minutes = $${pi++}`,
          `paid_minutes = $${pi++}`,
          `overtime_minutes = $${pi++}`,
          `late_minutes = $${pi++}`,
          `early_leave_minutes = $${pi++}`,
        );
        uParams.push(
          calc.grossMinutes,
          calc.paidMinutes,
          calc.overtimeMinutes,
          calc.lateMinutes,
          calc.earlyLeaveMinutes,
        );
      }

      if (updates.length > 1) {
        uParams.push(attReq.attendance_session_id, wreq.workspaceOwnerId);
        await db.query(
          `UPDATE attendance_sessions SET ${updates.join(", ")}
            WHERE id = $${pi} AND workspace_owner_id = $${pi + 1}`,
          uParams,
        );
      }
    } else if (
      !attReq.attendance_session_id &&
      attReq.requested_clock_in_at &&
      ["missed_clock_in", "offsite_clock_in"].includes(attReq.request_type)
    ) {
      // No linked session — create a new attendance_sessions row for the missed clock-in.
      // The unique index on (employee_id, clock_in_at) makes the DB the unconditional
      // guard against duplicate sessions. Any concurrent INSERT that races past the
      // application-level check will receive error code 23505, which we catch and
      // surface as 409 rather than letting a 500 propagate.
      let newSessionId: number;
      try {
        const insertResult = await db.query<{ id: number }>(
          `INSERT INTO attendance_sessions
             (workspace_owner_id, employee_id, clock_in_at,
              clock_in_verification_status, status)
           VALUES ($1, $2, $3, 'no_location', 'open')
           RETURNING id`,
          [wreq.workspaceOwnerId, attReq.employee_id, attReq.requested_clock_in_at],
        );
        newSessionId = insertResult.rows[0].id;
      } catch (err: unknown) {
        if ((err as { code?: string }).code === "23505") {
          res.status(409).json({
            error: "A session for this employee and clock-in time already exists",
          });
          return;
        }
        throw err;
      }
      // Link the request back to the newly created session
      await db.query(
        `UPDATE attendance_requests SET attendance_session_id = $1 WHERE id = $2`,
        [newSessionId, requestId],
      );
    } else if (
      !attReq.attendance_session_id &&
      attReq.requested_clock_out_at &&
      ["missed_clock_out", "offsite_clock_out"].includes(attReq.request_type)
    ) {
      // No linked session — create a new completed attendance_sessions row for the missed clock-out.
      // clock_in_at is NOT NULL so we use the requested_clock_out_at as a stand-in; the session
      // records that the shift ended at that time even though the start is unknown.
      // The unique index on (employee_id, clock_in_at) guards against duplicate sessions. Any
      // concurrent INSERT that races past the application-level check will receive error code
      // 23505, which we catch and surface as 409 rather than letting a 500 propagate.
      let newSessionId: number;
      try {
        const insertResult = await db.query<{ id: number }>(
          `INSERT INTO attendance_sessions
             (workspace_owner_id, employee_id, clock_in_at, clock_out_at,
              clock_in_verification_status, clock_out_verification_status, status)
           VALUES ($1, $2, $3, $3, 'no_location', 'no_location', 'completed')
           RETURNING id`,
          [wreq.workspaceOwnerId, attReq.employee_id, attReq.requested_clock_out_at],
        );
        newSessionId = insertResult.rows[0].id;
      } catch (err: unknown) {
        if ((err as { code?: string }).code === "23505") {
          res.status(409).json({
            error: "A session for this employee and clock-out time already exists",
          });
          return;
        }
        throw err;
      }
      // Link the request back to the newly created session
      await db.query(
        `UPDATE attendance_requests SET attendance_session_id = $1 WHERE id = $2`,
        [newSessionId, requestId],
      );
    }

    await writeAuditLog({
      workspaceOwnerId: wreq.workspaceOwnerId,
      sessionId: attReq.attendance_session_id,
      requestId,
      actorUserId: wreq.userId,
      action: "request_approved",
      oldValue: oldSession,
      newValue: {
        requested_clock_in_at: attReq.requested_clock_in_at,
        requested_clock_out_at: attReq.requested_clock_out_at,
      },
    });

    // Fire push notification to the employee (best-effort, non-blocking)
    void sendAttendanceCorrectionPush(attReq.employee_id, attReq.request_type, "approved").catch(
      (err: unknown) => logger.warn({ err }, "Failed to send attendance correction push (approve)"),
    );

    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "admin/attendance/requests/:id/approve failed");
    res.status(500).json({ error: "Failed to approve request" });
  }
});

// ─── POST /api/admin/attendance/requests/:id/reject ───────────────────────────

router.post("/admin/attendance/requests/:id/reject", async (req, res) => {
  const wreq = workspace(req);
  const requestId = Number(req.params.id);
  const body = (req.body ?? {}) as { reviewer_note?: string };
  try {
    const reqResult = await db.query(
      `SELECT id, status, attendance_session_id, employee_id, request_type
         FROM attendance_requests
        WHERE id = $1 AND workspace_owner_id = $2`,
      [requestId, wreq.workspaceOwnerId],
    );
    if (reqResult.rows.length === 0) {
      res.status(404).json({ error: "Request not found" });
      return;
    }
    const attReq = reqResult.rows[0] as { id: number; status: string; attendance_session_id: number | null; employee_id: number; request_type: string };
    const allowed = await canManageEmployee(
      wreq.workspaceOwnerId, wreq.userId, wreq.workspaceRole, attReq.employee_id,
    );
    if (!allowed) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }
    if (attReq.status !== "pending") {
      res.status(409).json({ error: "Request is not pending" });
      return;
    }
    const now = new Date();
    await db.query(
      `UPDATE attendance_requests
          SET status = 'rejected', reviewed_by = $1, reviewed_at = $2,
              reviewer_note = $3, updated_at = $2, is_read = true
        WHERE id = $4`,
      [wreq.userId, now.toISOString(), body.reviewer_note ?? null, requestId],
    );
    await writeAuditLog({
      workspaceOwnerId: wreq.workspaceOwnerId,
      sessionId: attReq.attendance_session_id,
      requestId,
      actorUserId: wreq.userId,
      action: "request_rejected",
    });

    // Fire push notification to the employee (best-effort, non-blocking)
    void sendAttendanceCorrectionPush(attReq.employee_id, attReq.request_type, "rejected").catch(
      (err: unknown) => logger.warn({ err }, "Failed to send attendance correction push (reject)"),
    );

    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "admin/attendance/requests/:id/reject failed");
    res.status(500).json({ error: "Failed to reject request" });
  }
});

// ─── POST /api/admin/attendance/sessions/:id/approve ──────────────────────────

router.post("/admin/attendance/sessions/:id/approve", async (req, res) => {
  const wreq = workspace(req);
  const sessionId = Number(req.params.id);
  try {
    const sessionResult = await db.query(
      `SELECT id, status, employee_id, clock_in_at, clock_out_at, break_minutes, location_id
         FROM attendance_sessions
        WHERE id = $1 AND workspace_owner_id = $2`,
      [sessionId, wreq.workspaceOwnerId],
    );
    if (sessionResult.rows.length === 0) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const session = sessionResult.rows[0] as {
      id: number;
      status: string;
      employee_id: number;
      clock_in_at: string | null;
      clock_out_at: string | null;
      break_minutes: number | null;
      location_id: number | null;
    };

    const allowed = await canManageEmployee(
      wreq.workspaceOwnerId, wreq.userId, wreq.workspaceRole, session.employee_id,
    );
    if (!allowed) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }
    if (session.status === "locked") {
      res.status(409).json({ error: "Session is locked and cannot be modified" });
      return;
    }

    const now = new Date();

    // Recalculate derived minute fields using the employee's schedule so that
    // late_minutes / overtime_minutes are set correctly when the manager approves.
    let calc: import("../lib/attendanceCalc").SessionMinuteResult | null = null;
    if (session.clock_in_at && session.clock_out_at) {
      const schedule = await fetchScheduleWindow(
        wreq.workspaceOwnerId,
        session.employee_id,
        session.location_id,
        new Date(session.clock_in_at),
      );
      calc = calculateSessionMinutes(
        session.clock_in_at,
        session.clock_out_at,
        session.break_minutes ?? 0,
        schedule,
      );
    }

    if (calc) {
      await db.query(
        `UPDATE attendance_sessions
            SET status = 'approved', approved_by = $1, approved_at = $2, updated_at = $2,
                gross_minutes = $3, paid_minutes = $4, overtime_minutes = $5,
                late_minutes = $6, early_leave_minutes = $7
          WHERE id = $8`,
        [
          wreq.userId, now.toISOString(),
          calc.grossMinutes, calc.paidMinutes, calc.overtimeMinutes,
          calc.lateMinutes, calc.earlyLeaveMinutes,
          sessionId,
        ],
      );
    } else {
      await db.query(
        `UPDATE attendance_sessions
            SET status = 'approved', approved_by = $1, approved_at = $2, updated_at = $2
          WHERE id = $3`,
        [wreq.userId, now.toISOString(), sessionId],
      );
    }
    await writeAuditLog({
      workspaceOwnerId: wreq.workspaceOwnerId,
      sessionId,
      requestId: null,
      actorUserId: wreq.userId,
      action: "session_approved",
      newValue: { status: "approved" },
    });

    // Fire push notification to the employee (best-effort, non-blocking)
    void sendAttendanceSessionPush(session.employee_id, "approved").catch(
      (err: unknown) => logger.warn({ err }, "Failed to send attendance session push (approve)"),
    );

    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "admin/attendance/sessions/:id/approve failed");
    res.status(500).json({ error: "Failed to approve session" });
  }
});

// ─── POST /api/admin/attendance/sessions/:id/reject ───────────────────────────

router.post("/admin/attendance/sessions/:id/reject", async (req, res) => {
  const wreq = workspace(req);
  const sessionId = Number(req.params.id);
  const body = (req.body ?? {}) as { manager_note?: string };
  try {
    const sessionResult = await db.query(
      `SELECT id, status, employee_id FROM attendance_sessions
        WHERE id = $1 AND workspace_owner_id = $2`,
      [sessionId, wreq.workspaceOwnerId],
    );
    if (sessionResult.rows.length === 0) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const session = sessionResult.rows[0] as { id: number; status: string; employee_id: number };

    const allowed = await canManageEmployee(
      wreq.workspaceOwnerId, wreq.userId, wreq.workspaceRole, session.employee_id,
    );
    if (!allowed) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }
    if (session.status === "locked") {
      res.status(409).json({ error: "Session is locked and cannot be modified" });
      return;
    }

    const now = new Date();
    await db.query(
      `UPDATE attendance_sessions
          SET status = 'rejected', rejected_by = $1, rejected_at = $2,
              manager_note = COALESCE($3, manager_note), updated_at = $2
        WHERE id = $4`,
      [wreq.userId, now.toISOString(), body.manager_note ?? null, sessionId],
    );
    await writeAuditLog({
      workspaceOwnerId: wreq.workspaceOwnerId,
      sessionId,
      requestId: null,
      actorUserId: wreq.userId,
      action: "session_rejected",
      newValue: { status: "rejected" },
    });

    // Fire push notification to the employee (best-effort, non-blocking)
    void sendAttendanceSessionPush(session.employee_id, "rejected").catch(
      (err: unknown) => logger.warn({ err }, "Failed to send attendance session push (reject)"),
    );

    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "admin/attendance/sessions/:id/reject failed");
    res.status(500).json({ error: "Failed to reject session" });
  }
});

// ─── PATCH /api/admin/attendance/sessions/:id ─────────────────────────────────

const EDITABLE_SESSION_FIELDS = [
  "clock_in_at",
  "clock_out_at",
  "break_minutes",
  "paid_minutes",
  "employee_note",
  "manager_note",
  // "status" is intentionally excluded — status transitions (including locking)
  // must go through dedicated endpoints with proper authorization checks.
] as const;

router.patch("/admin/attendance/sessions/:id", async (req, res) => {
  const wreq = workspace(req);
  const sessionId = Number(req.params.id);
  const body = (req.body ?? {}) as Record<string, unknown>;
  try {
    const sessionResult = await db.query(
      `SELECT * FROM attendance_sessions WHERE id = $1 AND workspace_owner_id = $2`,
      [sessionId, wreq.workspaceOwnerId],
    );
    if (sessionResult.rows.length === 0) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const session = sessionResult.rows[0] as {
      id: number;
      status: string;
      employee_id: number;
      clock_in_at: string | null;
      clock_out_at: string | null;
      break_minutes: number | null;
      location_id: number | null;
    };

    const allowed = await canManageEmployee(
      wreq.workspaceOwnerId, wreq.userId, wreq.workspaceRole, session.employee_id,
    );
    if (!allowed) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }
    if (session.status === "locked") {
      res.status(409).json({ error: "Session is locked and cannot be modified" });
      return;
    }
    if (session.status === "rejected") {
      res.status(409).json({
        error: "Session is rejected and cannot be edited directly. Reopen the session first.",
      });
      return;
    }

    const fields: string[] = [];
    const params: unknown[] = [];
    let pi = 1;

    for (const key of EDITABLE_SESSION_FIELDS) {
      if (key in body) {
        fields.push(`${key} = $${pi++}`);
        params.push(body[key] === "" ? null : body[key]);
      }
    }
    if (fields.length === 0) {
      res.status(400).json({ error: "No valid fields to update" });
      return;
    }

    // When any time-affecting field is being changed, recalculate all derived
    // minute metrics so late_minutes / overtime_minutes stay accurate.
    const TIME_AFFECTING_FIELDS = new Set(["clock_in_at", "clock_out_at", "break_minutes"]);
    const needsRecalc = EDITABLE_SESSION_FIELDS.some(
      (f) => TIME_AFFECTING_FIELDS.has(f) && f in body,
    );
    if (needsRecalc) {
      const effectiveClockIn =
        (body.clock_in_at as string | null | undefined) ?? session.clock_in_at;
      const effectiveClockOut =
        (body.clock_out_at as string | null | undefined) ?? session.clock_out_at;
      const effectiveBreakMinutes =
        body.break_minutes !== undefined
          ? Number(body.break_minutes)
          : (session.break_minutes ?? 0);

      if (effectiveClockIn && effectiveClockOut) {
        const schedule = await fetchScheduleWindow(
          wreq.workspaceOwnerId,
          session.employee_id,
          session.location_id,
          new Date(effectiveClockIn),
        );
        const calc = calculateSessionMinutes(
          effectiveClockIn,
          effectiveClockOut,
          effectiveBreakMinutes,
          schedule,
        );
        fields.push(
          `gross_minutes = $${pi++}`,
          `paid_minutes = $${pi++}`,
          `overtime_minutes = $${pi++}`,
          `late_minutes = $${pi++}`,
          `early_leave_minutes = $${pi++}`,
        );
        params.push(
          calc.grossMinutes,
          calc.paidMinutes,
          calc.overtimeMinutes,
          calc.lateMinutes,
          calc.earlyLeaveMinutes,
        );
      }
    }

    fields.push(`updated_at = $${pi++}`);
    params.push(new Date().toISOString());
    params.push(sessionId, wreq.workspaceOwnerId);

    const updated = await db.query(
      `UPDATE attendance_sessions SET ${fields.join(", ")}
        WHERE id = $${pi} AND workspace_owner_id = $${pi + 1}
        RETURNING *`,
      params,
    );

    await writeAuditLog({
      workspaceOwnerId: wreq.workspaceOwnerId,
      sessionId,
      requestId: null,
      actorUserId: wreq.userId,
      action: "session_manual_edit",
      oldValue: session,
      newValue: body,
    });

    res.json({ success: true, session: updated.rows[0] });
  } catch (err) {
    logger.error({ err }, "admin/attendance/sessions/:id PATCH failed");
    res.status(500).json({ error: "Failed to update session" });
  }
});

// ─── POST /api/admin/attendance/sessions/:id/lock ─────────────────────────────

router.post("/admin/attendance/sessions/:id/lock", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Only owners can lock sessions" });
    return;
  }
  const sessionId = Number(req.params.id);
  try {
    const sessionResult = await db.query(
      `SELECT id, status, employee_id FROM attendance_sessions
        WHERE id = $1 AND workspace_owner_id = $2`,
      [sessionId, wreq.workspaceOwnerId],
    );
    if (sessionResult.rows.length === 0) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const session = sessionResult.rows[0] as { id: number; status: string; employee_id: number };
    if (session.status === "locked") {
      res.status(409).json({ error: "Session is already locked" });
      return;
    }
    if (!["approved", "completed"].includes(session.status)) {
      res.status(409).json({ error: "Session must be approved or completed before locking" });
      return;
    }

    const now = new Date();
    await db.query(
      `UPDATE attendance_sessions SET status = 'locked', updated_at = $1 WHERE id = $2`,
      [now.toISOString(), sessionId],
    );
    await writeAuditLog({
      workspaceOwnerId: wreq.workspaceOwnerId,
      sessionId,
      requestId: null,
      actorUserId: wreq.userId,
      action: "session_locked",
      newValue: { status: "locked", locked_at: now.toISOString() },
    });

    // Fire push notification to the employee (best-effort, non-blocking)
    void sendAttendanceSessionPush(session.employee_id, "locked").catch(
      (err: unknown) => logger.warn({ err }, "Failed to send attendance session push (lock)"),
    );

    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "admin/attendance/sessions/:id/lock failed");
    res.status(500).json({ error: "Failed to lock session" });
  }
});

// ─── GET /api/admin/attendance/export.csv ─────────────────────────────────────

router.get("/admin/attendance/export.csv", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Insufficient permissions" });
    return;
  }
  try {
    const params: unknown[] = [wreq.workspaceOwnerId];
    const conds: string[] = ["s.workspace_owner_id = $1"];
    let i = 2;

    if (typeof req.query.from === "string") {
      conds.push(`s.clock_in_at >= $${i++}`);
      params.push(req.query.from);
    }
    if (typeof req.query.to === "string") {
      conds.push(`s.clock_in_at < $${i++}`);
      params.push(req.query.to);
    }
    if (typeof req.query.employee_id === "string") {
      conds.push(`s.employee_id = $${i++}`);
      params.push(Number(req.query.employee_id));
    }

    const result = await db.query(
      `SELECT
              s.id,
              tm.first_name || COALESCE(' ' || tm.last_name, '') AS employee_name,
              s.clock_in_at,
              s.clock_out_at,
              COALESCE(s.gross_minutes, 0) AS gross_minutes,
              COALESCE(s.break_minutes, 0) AS break_minutes,
              COALESCE(s.paid_minutes, 0) AS paid_minutes,
              COALESCE(s.overtime_minutes, 0) AS overtime_minutes,
              COALESCE(s.late_minutes, 0) AS late_minutes,
              COALESCE(s.early_leave_minutes, 0) AS early_leave_minutes,
              s.status,
              s.clock_in_verification_status,
              s.clock_out_verification_status,
              l.name AS location_name
         FROM attendance_sessions s
         JOIN team_members tm ON tm.id = s.employee_id
         LEFT JOIN locations l ON l.id = s.location_id
        WHERE ${conds.join(" AND ")}
          AND s.status IN ('approved','locked','completed')
        ORDER BY s.clock_in_at ASC`,
      params,
    );

    const headers = [
      "id",
      "employee_name",
      "clock_in_at",
      "clock_out_at",
      "gross_minutes",
      "break_minutes",
      "paid_minutes",
      "overtime_minutes",
      "late_minutes",
      "early_leave_minutes",
      "status",
      "clock_in_verification_status",
      "clock_out_verification_status",
      "location_name",
    ];

    const escape = (v: unknown): string => {
      if (v == null) return "";
      const s = String(v);
      if (s.includes(",") || s.includes('"') || s.includes("\n")) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    };

    const lines = [
      headers.join(","),
      ...result.rows.map((row) =>
        headers.map((h) => escape((row as Record<string, unknown>)[h])).join(","),
      ),
    ];

    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="attendance-export-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    res.send(lines.join("\n"));
  } catch (err) {
    logger.error({ err }, "admin/attendance/export.csv failed");
    res.status(500).json({ error: "Failed to export attendance" });
  }
});

// ─── GET /api/admin/attendance/sessions/:id/audit-log ────────────────────────

router.get("/admin/attendance/sessions/:id/audit-log", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Insufficient permissions" });
    return;
  }
  const sessionId = Number(req.params.id);
  try {
    const result = await db.query(
      `SELECT * FROM attendance_audit_logs
        WHERE attendance_session_id = $1
          AND workspace_owner_id = $2
        ORDER BY created_at ASC`,
      [sessionId, wreq.workspaceOwnerId],
    );
    res.json({ success: true, logs: result.rows });
  } catch (err) {
    logger.error({ err }, "admin/attendance/sessions/:id/audit-log failed");
    res.status(500).json({ error: "Failed to load audit log" });
  }
});

// ─── POST /api/admin/attendance/requests/seen ─────────────────────────────────

/**
 * Mark attendance correction requests as read for the current manager/owner.
 * Body: { ids: number[] }
 */
router.post("/admin/attendance/requests/seen", async (req, res) => {
  const wreq = workspace(req);
  const managedIds = await getManagedEmployeeIds(
    wreq.workspaceOwnerId, wreq.userId, wreq.workspaceRole,
  );
  if (managedIds !== null && managedIds.length === 0) {
    res.status(403).json({ error: "Insufficient permissions" });
    return;
  }

  const body = (req.body ?? {}) as { ids?: unknown };
  if (
    !Array.isArray(body.ids) ||
    body.ids.length === 0 ||
    !body.ids.every((id) => typeof id === "number" && Number.isInteger(id) && id > 0)
  ) {
    res.status(400).json({ error: "ids must be a non-empty array of positive integers" });
    return;
  }
  const ids = body.ids as number[];

  try {
    const conds: string[] = ["workspace_owner_id = $1"];
    const params: unknown[] = [wreq.workspaceOwnerId];
    let i = 2;

    const placeholders = ids.map(() => `$${i++}`).join(", ");
    conds.push(`id IN (${placeholders})`);
    params.push(...ids);

    if (managedIds !== null) {
      const empPlaceholders = managedIds.map(() => `$${i++}`).join(", ");
      conds.push(`employee_id IN (${empPlaceholders})`);
      params.push(...managedIds);
    }

    await db.query(
      `UPDATE attendance_requests SET is_read = true WHERE ${conds.join(" AND ")}`,
      params,
    );

    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "admin/attendance/requests/seen failed");
    res.status(500).json({ error: "Failed to mark requests as read" });
  }
});

// ─── GET /api/admin/attendance/requests/events ────────────────────────────────

/**
 * SSE stream — emits a "changed" event whenever a new correction request is submitted
 * by any employee in this workspace. Both owners and managers can subscribe.
 */
router.get("/admin/attendance/requests/events", async (req, res) => {
  const wreq = workspace(req);
  const managedIds = await getManagedEmployeeIds(
    wreq.workspaceOwnerId, wreq.userId, wreq.workspaceRole,
  );
  if (managedIds !== null && managedIds.length === 0) {
    res.status(403).json({ error: "Insufficient permissions" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  res.write(": connected\n\n");

  subscribeAttendance(wreq.workspaceOwnerId, res);
});

export default router;
