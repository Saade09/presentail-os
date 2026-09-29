import { Router } from "express";
import { db } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";
import { logger } from "../lib/logger";
import { distanceMeters } from "../lib/haversine";
import { calculateSessionMinutes, sumBreakMinutes } from "../lib/attendanceCalc";
import { broadcastAttendanceRequest } from "../lib/attendanceSse";
import { sendExpoPushNotification } from "../lib/expoPush";

const router = Router();

const REQUEST_TYPE_LABELS: Record<string, string> = {
  edit_clock_in: "Clock-in edit",
  edit_clock_out: "Clock-out edit",
  missed_clock_in: "Missed clock-in",
  missed_clock_out: "Missed clock-out",
  offsite_clock_in: "Remote clock-in",
  offsite_clock_out: "Remote clock-out",
  other: "Other",
};

router.use(requireAuth, resolveWorkspace);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolve the team_members.id for the authenticated Clerk user within the
 * workspace. Returns null if the user has no team member record.
 */
// Schema sentinel: resolveEmployeeId JOINs workspace_members and reads
// wm.member_user_id (WHERE $2). Update here if member_user_id is renamed.
async function resolveEmployeeId(
  workspaceOwnerId: string,
  clerkUserId: string,
): Promise<number | null> {
  const r = await db.query<{ id: number }>(
    `SELECT tm.id
       FROM team_members tm
       JOIN workspace_members wm ON wm.id = tm.member_db_id
      WHERE tm.workspace_owner_id = $1
        AND wm.member_user_id = $2
      LIMIT 1`,
    [workspaceOwnerId, clerkUserId],
  );
  return r.rows[0]?.id ?? null;
}

type GeofenceVerdict = "verified" | "outside_geofence" | "no_location" | "manual_exception";

/**
 * Determine the clock-in/out geofence verification status.
 */
function geoVerdict(opts: {
  locationLat: number | null;
  locationLon: number | null;
  radiusMeters: number;
  pointLat: number | null;
  pointLon: number | null;
  allowRemote: boolean;
}): { status: GeofenceVerdict; distanceMeters: number | null } {
  if (opts.pointLat === null || opts.pointLat === undefined || opts.pointLon === null || opts.pointLon === undefined) {
    return { status: "no_location", distanceMeters: null };
  }
  if (opts.locationLat === null || opts.locationLat === undefined || opts.locationLon === null || opts.locationLon === undefined) {
    if (opts.allowRemote) return { status: "manual_exception", distanceMeters: null };
    return { status: "no_location", distanceMeters: null };
  }
  const dist = distanceMeters(
    opts.locationLat,
    opts.locationLon,
    opts.pointLat,
    opts.pointLon,
  );
  if (dist <= opts.radiusMeters) {
    return { status: "verified", distanceMeters: dist };
  }
  if (opts.allowRemote) {
    return { status: "manual_exception", distanceMeters: dist };
  }
  return { status: "outside_geofence", distanceMeters: dist };
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

// ─── GET /api/attendance/today ─────────────────────────────────────────────────

router.get("/attendance/today", async (req, res) => {
  const wreq = workspace(req);
  try {
    const employeeId = await resolveEmployeeId(wreq.workspaceOwnerId, wreq.userId);
    if (!employeeId) {
      res.status(403).json({ error: "No team member record found for this user" });
      return;
    }

    const today = new Date().toISOString().slice(0, 10);

    // Open session
    const sessionResult = await db.query(
      `SELECT s.*,
              l.name          AS location_name,
              l.latitude      AS loc_lat,
              l.longitude     AS loc_lon,
              l.geofence_radius_meters
         FROM attendance_sessions s
         LEFT JOIN locations l ON l.id = s.location_id
        WHERE s.employee_id = $1
          AND s.workspace_owner_id = $2
          AND DATE(s.clock_in_at AT TIME ZONE 'UTC') = $3
          AND s.status = 'open'
        ORDER BY s.clock_in_at DESC
        LIMIT 1`,
      [employeeId, wreq.workspaceOwnerId, today],
    );
    const openSession = sessionResult.rows[0] ?? null;

    // Active break
    let activeBreak = null;
    if (openSession) {
      const breakResult = await db.query(
        `SELECT * FROM attendance_breaks
          WHERE attendance_session_id = $1
            AND break_end_at IS NULL
          ORDER BY break_start_at DESC
          LIMIT 1`,
        [openSession.id],
      );
      activeBreak = breakResult.rows[0] ?? null;
    }

    // Assigned location from team_members
    const locResult = await db.query(
      `SELECT l.id, l.name, l.latitude, l.longitude, l.geofence_radius_meters, l.attendance_enabled
         FROM team_members tm
         JOIN locations l ON l.id = tm.location_id
        WHERE tm.id = $1`,
      [employeeId],
    );
    const assignedLocation = locResult.rows[0] ?? null;

    // Today's work schedule
    const schedResult = await db.query(
      `SELECT ws.name AS schedule_name,
              wsd.day_of_week, wsd.is_working_day,
              wsd.start_time, wsd.end_time, wsd.break_minutes
         FROM team_members tm
         LEFT JOIN work_schedules ws ON ws.id = tm.work_schedule_id
         LEFT JOIN work_schedule_days wsd
           ON wsd.schedule_id = tm.work_schedule_id
          AND wsd.day_of_week = CASE EXTRACT(DOW FROM CURRENT_DATE)
             WHEN 0 THEN 'sunday'    WHEN 1 THEN 'monday'
             WHEN 2 THEN 'tuesday'   WHEN 3 THEN 'wednesday'
             WHEN 4 THEN 'thursday' WHEN 5 THEN 'friday'
             WHEN 6 THEN 'saturday'
           END
        WHERE tm.id = $1
        LIMIT 1`,
      [employeeId],
    );
    const todaySchedule = schedResult.rows[0] ?? null;

    res.json({ success: true, employeeId, openSession, activeBreak, assignedLocation, today, todaySchedule });
  } catch (err) {
    logger.error({ err }, "attendance/today failed");
    res.status(500).json({ error: "Failed to load today's attendance" });
  }
});

// ─── POST /api/attendance/clock-in ────────────────────────────────────────────

router.post("/attendance/clock-in", async (req, res) => {
  const wreq = workspace(req);
  const body = req.body as {
    latitude?: number;
    longitude?: number;
    accuracy_meters?: number;
    note?: string;
  };
  try {
    const employeeId = await resolveEmployeeId(wreq.workspaceOwnerId, wreq.userId);
    if (!employeeId) {
      res.status(403).json({ error: "No team member record found for this user" });
      return;
    }

    // Guard: one open session at a time
    const existing = await db.query(
      `SELECT id FROM attendance_sessions
        WHERE employee_id = $1
          AND workspace_owner_id = $2
          AND status = 'open'
        LIMIT 1`,
      [employeeId, wreq.workspaceOwnerId],
    );
    if (existing.rows.length > 0) {
      res.status(409).json({ error: "An open session already exists. Clock out first." });
      return;
    }

    // Resolve assigned location and profile for geofencing
    const infoResult = await db.query(
      `SELECT tm.location_id,
              l.latitude          AS loc_lat,
              l.longitude         AS loc_lon,
              l.geofence_radius_meters,
              l.attendance_enabled,
              COALESCE(tmp.allowed_remote_clock_in, false) AS allowed_remote
         FROM team_members tm
         LEFT JOIN locations l ON l.id = tm.location_id
         LEFT JOIN team_member_profiles tmp ON tmp.team_member_id = tm.id
          AND tmp.workspace_owner_id = tm.workspace_owner_id
        WHERE tm.id = $1`,
      [employeeId],
    );
    const info = infoResult.rows[0] as {
      location_id: number | null;
      loc_lat: number | null;
      loc_lon: number | null;
      geofence_radius_meters: number;
      attendance_enabled: boolean;
      allowed_remote: boolean;
    } | undefined;

    const verdict = geoVerdict({
      locationLat: info?.loc_lat ?? null,
      locationLon: info?.loc_lon ?? null,
      radiusMeters: info?.geofence_radius_meters ?? 100,
      pointLat: body.latitude ?? null,
      pointLon: body.longitude ?? null,
      allowRemote: info?.allowed_remote ?? false,
    });

    const now = new Date();
    const result = await db.query(
      `INSERT INTO attendance_sessions
         (workspace_owner_id, employee_id, location_id,
          clock_in_at,
          clock_in_latitude, clock_in_longitude, clock_in_accuracy_meters, clock_in_distance_meters,
          clock_in_verification_status,
          status, employee_note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'open',$10)
       RETURNING *`,
      [
        wreq.workspaceOwnerId,
        employeeId,
        info?.location_id ?? null,
        now.toISOString(),
        body.latitude ?? null,
        body.longitude ?? null,
        body.accuracy_meters ?? null,
        verdict.distanceMeters,
        verdict.status,
        body.note ?? null,
      ],
    );
    const session = result.rows[0];

    await writeAuditLog({
      workspaceOwnerId: wreq.workspaceOwnerId,
      sessionId: session.id,
      requestId: null,
      actorUserId: wreq.userId,
      action: "clock_in",
      newValue: { clock_in_at: now.toISOString(), verification_status: verdict.status },
    });

    res.status(201).json({ success: true, session, verificationStatus: verdict.status });
  } catch (err) {
    logger.error({ err }, "attendance/clock-in failed");
    res.status(500).json({ error: "Failed to clock in" });
  }
});

// ─── POST /api/attendance/start-break ─────────────────────────────────────────

router.post("/attendance/start-break", async (req, res) => {
  const wreq = workspace(req);
  const body = req.body as { break_type?: string; note?: string };
  try {
    const employeeId = await resolveEmployeeId(wreq.workspaceOwnerId, wreq.userId);
    if (!employeeId) {
      res.status(403).json({ error: "No team member record found for this user" });
      return;
    }

    // Find open session
    const sessionResult = await db.query(
      `SELECT id FROM attendance_sessions
        WHERE employee_id = $1 AND workspace_owner_id = $2 AND status = 'open'
        LIMIT 1`,
      [employeeId, wreq.workspaceOwnerId],
    );
    if (sessionResult.rows.length === 0) {
      res.status(404).json({ error: "No open session found. Clock in first." });
      return;
    }
    const sessionId = sessionResult.rows[0].id as number;

    // Guard: one active break at a time
    const activeBreak = await db.query(
      `SELECT id FROM attendance_breaks
        WHERE attendance_session_id = $1 AND break_end_at IS NULL
        LIMIT 1`,
      [sessionId],
    );
    if (activeBreak.rows.length > 0) {
      res.status(409).json({ error: "A break is already active. End it first." });
      return;
    }

    const now = new Date();
    const result = await db.query(
      `INSERT INTO attendance_breaks
         (attendance_session_id, employee_id, break_start_at, break_type, note)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING *`,
      [sessionId, employeeId, now.toISOString(), body.break_type ?? "other", body.note ?? null],
    );

    res.status(201).json({ success: true, break: result.rows[0] });
  } catch (err) {
    logger.error({ err }, "attendance/start-break failed");
    res.status(500).json({ error: "Failed to start break" });
  }
});

// ─── POST /api/attendance/end-break ───────────────────────────────────────────

router.post("/attendance/end-break", async (req, res) => {
  const wreq = workspace(req);
  try {
    const employeeId = await resolveEmployeeId(wreq.workspaceOwnerId, wreq.userId);
    if (!employeeId) {
      res.status(403).json({ error: "No team member record found for this user" });
      return;
    }

    const now = new Date();
    const result = await db.query(
      `UPDATE attendance_breaks
          SET break_end_at = $1, updated_at = $1
        WHERE id = (
          SELECT ab.id FROM attendance_breaks ab
           JOIN attendance_sessions s ON s.id = ab.attendance_session_id
          WHERE s.employee_id = $2
            AND s.workspace_owner_id = $3
            AND s.status = 'open'
            AND ab.break_end_at IS NULL
          ORDER BY ab.break_start_at DESC
          LIMIT 1
        )
        RETURNING *`,
      [now.toISOString(), employeeId, wreq.workspaceOwnerId],
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: "No active break found." });
      return;
    }
    res.json({ success: true, break: result.rows[0] });
  } catch (err) {
    logger.error({ err }, "attendance/end-break failed");
    res.status(500).json({ error: "Failed to end break" });
  }
});

// ─── POST /api/attendance/clock-out ───────────────────────────────────────────

router.post("/attendance/clock-out", async (req, res) => {
  const wreq = workspace(req);
  const body = req.body as {
    latitude?: number;
    longitude?: number;
    accuracy_meters?: number;
    note?: string;
  };
  try {
    const employeeId = await resolveEmployeeId(wreq.workspaceOwnerId, wreq.userId);
    if (!employeeId) {
      res.status(403).json({ error: "No team member record found for this user" });
      return;
    }

    // Find open session
    const sessionResult = await db.query<{
      id: number;
      clock_in_at: string;
      location_id: number | null;
    }>(
      `SELECT s.id, s.clock_in_at, s.location_id,
              l.latitude AS loc_lat, l.longitude AS loc_lon,
              l.geofence_radius_meters,
              COALESCE(tmp.allowed_remote_clock_in, false) AS allowed_remote
         FROM attendance_sessions s
         LEFT JOIN locations l ON l.id = s.location_id
         LEFT JOIN team_member_profiles tmp ON tmp.team_member_id = $1
          AND tmp.workspace_owner_id = $2
        WHERE s.employee_id = $1
          AND s.workspace_owner_id = $2
          AND s.status = 'open'
        LIMIT 1`,
      [employeeId, wreq.workspaceOwnerId],
    );
    if (sessionResult.rows.length === 0) {
      res.status(404).json({ error: "No open session found." });
      return;
    }
    const sessionRow = sessionResult.rows[0] as {
      id: number;
      clock_in_at: string;
      location_id: number | null;
      loc_lat: number | null;
      loc_lon: number | null;
      geofence_radius_meters: number;
      allowed_remote: boolean;
    };

    const now = new Date();

    // Auto-close any active break
    await db.query(
      `UPDATE attendance_breaks
          SET break_end_at = $1,
              updated_at = $1,
              note = COALESCE(note, 'Auto-closed on clock-out')
        WHERE attendance_session_id = $2
          AND break_end_at IS NULL`,
      [now.toISOString(), sessionRow.id],
    );

    // Sum all breaks for this session
    const breaksResult = await db.query(
      `SELECT break_start_at, break_end_at
         FROM attendance_breaks
        WHERE attendance_session_id = $1`,
      [sessionRow.id],
    );
    const breakMinutes = sumBreakMinutes(breaksResult.rows);

    // Geofence verdict for clock-out
    const verdict = geoVerdict({
      locationLat: sessionRow.loc_lat,
      locationLon: sessionRow.loc_lon,
      radiusMeters: sessionRow.geofence_radius_meters ?? 100,
      pointLat: body.latitude ?? null,
      pointLon: body.longitude ?? null,
      allowRemote: sessionRow.allowed_remote ?? false,
    });

    // Resolve employee's work schedule for the clock-in day to compute
    // late/early/overtime.  We deliberately use the clock-in timestamp, not
    // the current date, so that night shifts and long shifts that cross
    // midnight look up the schedule for the day the shift *started* rather
    // than the day the employee clocks out.
    // Priority: team_member_profiles.work_schedule_id → locations.default_schedule_id.
    let schedule: import("../lib/attendanceCalc").ScheduleWindow | undefined;
    const scheduleResult = await db.query(
      `SELECT wsd.start_time, wsd.end_time, wsd.break_minutes
         FROM team_members tm
         LEFT JOIN team_member_profiles tmp
           ON tmp.team_member_id = tm.id
          AND tmp.workspace_owner_id = tm.workspace_owner_id
         LEFT JOIN locations l ON l.id = $3
         LEFT JOIN work_schedule_days wsd
           ON wsd.schedule_id = COALESCE(tmp.work_schedule_id, l.default_schedule_id)
          AND wsd.day_of_week = CASE EXTRACT(DOW FROM $4::timestamptz)
             WHEN 0 THEN 'sunday'    WHEN 1 THEN 'monday'
             WHEN 2 THEN 'tuesday'   WHEN 3 THEN 'wednesday'
             WHEN 4 THEN 'thursday' WHEN 5 THEN 'friday'
             WHEN 6 THEN 'saturday'
           END
        WHERE tm.id = $1 AND tm.workspace_owner_id = $2
        LIMIT 1`,
      [employeeId, wreq.workspaceOwnerId, sessionRow.location_id ?? null, sessionRow.clock_in_at],
    );
    const schedRow = scheduleResult.rows[0] as
      | { start_time: string; end_time: string; break_minutes: number }
      | undefined;
    if (schedRow?.start_time && schedRow?.end_time) {
      schedule = {
        startTime: schedRow.start_time.slice(0, 5),   // HH:MM from time type
        endTime: schedRow.end_time.slice(0, 5),
        scheduledBreakMinutes: schedRow.break_minutes ?? 0,
      };
    }

    const calc = calculateSessionMinutes(
      sessionRow.clock_in_at,
      now.toISOString(),
      breakMinutes,
      schedule,
    );

    // Determine final status: pending_review if outside geofence, else completed
    const newStatus =
      verdict.status === "outside_geofence" ? "pending_review" : "completed";

    const updated = await db.query(
      `UPDATE attendance_sessions
          SET clock_out_at = $1,
              clock_out_latitude = $2,
              clock_out_longitude = $3,
              clock_out_accuracy_meters = $4,
              clock_out_distance_meters = $5,
              clock_out_verification_status = $6,
              status = $7,
              gross_minutes = $8,
              break_minutes = $9,
              paid_minutes = $10,
              overtime_minutes = $11,
              late_minutes = $12,
              early_leave_minutes = $13,
              employee_note = COALESCE($14, employee_note),
              updated_at = $1
        WHERE id = $15
        RETURNING *`,
      [
        now.toISOString(),
        body.latitude ?? null,
        body.longitude ?? null,
        body.accuracy_meters ?? null,
        verdict.distanceMeters,
        verdict.status,
        newStatus,
        calc.grossMinutes,
        calc.breakMinutes,
        calc.paidMinutes,
        calc.overtimeMinutes,
        calc.lateMinutes,
        calc.earlyLeaveMinutes,
        body.note ?? null,
        sessionRow.id,
      ],
    );

    await writeAuditLog({
      workspaceOwnerId: wreq.workspaceOwnerId,
      sessionId: sessionRow.id,
      requestId: null,
      actorUserId: wreq.userId,
      action: "clock_out",
      newValue: {
        clock_out_at: now.toISOString(),
        status: newStatus,
        paid_minutes: calc.paidMinutes,
        verification_status: verdict.status,
      },
    });

    res.json({ success: true, session: updated.rows[0], verificationStatus: verdict.status });
  } catch (err) {
    logger.error({ err }, "attendance/clock-out failed");
    res.status(500).json({ error: "Failed to clock out" });
  }
});

// ─── GET /api/attendance/my-timesheets ────────────────────────────────────────

router.get("/attendance/my-timesheets", async (req, res) => {
  const wreq = workspace(req);
  try {
    const employeeId = await resolveEmployeeId(wreq.workspaceOwnerId, wreq.userId);
    if (!employeeId) {
      res.status(403).json({ error: "No team member record found for this user" });
      return;
    }

    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const offset = Number(req.query.offset) || 0;

    const params: unknown[] = [employeeId, wreq.workspaceOwnerId];
    const conds: string[] = ["s.employee_id = $1", "s.workspace_owner_id = $2"];
    let i = 3;

    if (typeof req.query.from === "string") {
      conds.push(`s.clock_in_at >= $${i++}`);
      params.push(req.query.from);
    }
    if (typeof req.query.to === "string") {
      conds.push(`s.clock_in_at < $${i++}`);
      params.push(req.query.to);
    }

    params.push(limit, offset);
    const result = await db.query(
      `SELECT s.*,
              l.name AS location_name
         FROM attendance_sessions s
         LEFT JOIN locations l ON l.id = s.location_id
        WHERE ${conds.join(" AND ")}
        ORDER BY s.clock_in_at DESC
        LIMIT $${i} OFFSET $${i + 1}`,
      params,
    );

    const countResult = await db.query(
      `SELECT COUNT(*) AS total FROM attendance_sessions s
        WHERE ${conds.slice(0, conds.length).join(" AND ")}`,
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
    logger.error({ err }, "attendance/my-timesheets failed");
    res.status(500).json({ error: "Failed to load timesheets" });
  }
});

// ─── GET /api/attendance/my-requests ──────────────────────────────────────────

router.get("/attendance/my-requests", async (req, res) => {
  const wreq = workspace(req);
  try {
    const employeeId = await resolveEmployeeId(wreq.workspaceOwnerId, wreq.userId);
    if (!employeeId) {
      res.status(403).json({ error: "No team member record found for this user" });
      return;
    }

    const params: unknown[] = [employeeId, wreq.workspaceOwnerId];
    const conds: string[] = ["r.employee_id = $1", "r.workspace_owner_id = $2"];
    let i = 3;

    if (typeof req.query.status === "string") {
      conds.push(`r.status = $${i++}`);
      params.push(req.query.status);
    }

    if (typeof req.query.session_id === "string") {
      conds.push(`r.attendance_session_id = $${i++}`);
      params.push(Number(req.query.session_id));
    }

    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Number(req.query.offset) || 0;
    params.push(limit, offset);

    const result = await db.query(
      `SELECT r.*
         FROM attendance_requests r
        WHERE ${conds.join(" AND ")}
        ORDER BY r.created_at DESC
        LIMIT $${i} OFFSET $${i + 1}`,
      params,
    );

    res.json({ success: true, requests: result.rows });
  } catch (err) {
    logger.error({ err }, "attendance/my-requests GET failed");
    res.status(500).json({ error: "Failed to load correction requests" });
  }
});

// ─── POST /api/attendance/requests ────────────────────────────────────────────

router.post("/attendance/requests", async (req, res) => {
  const wreq = workspace(req);
  const body = req.body as {
    attendance_session_id?: number;
    request_type?: string;
    requested_clock_in_at?: string;
    requested_clock_out_at?: string;
    requested_location_id?: number;
    reason?: string;
  };

  const VALID_REQUEST_TYPES = new Set([
    "missed_clock_in",
    "missed_clock_out",
    "edit_clock_in",
    "edit_clock_out",
    "offsite_clock_in",
    "offsite_clock_out",
    "other",
  ]);

  if (!body.request_type || !VALID_REQUEST_TYPES.has(body.request_type)) {
    res.status(400).json({
      error: `request_type must be one of: ${[...VALID_REQUEST_TYPES].join(", ")}`,
    });
    return;
  }

  try {
    const employeeId = await resolveEmployeeId(wreq.workspaceOwnerId, wreq.userId);
    if (!employeeId) {
      res.status(403).json({ error: "No team member record found for this user" });
      return;
    }

    // If a session is linked, verify it belongs to this employee in this workspace
    if (body.attendance_session_id) {
      const sessionCheck = await db.query(
        `SELECT 1 FROM attendance_sessions
          WHERE id = $1 AND employee_id = $2 AND workspace_owner_id = $3
          LIMIT 1`,
        [body.attendance_session_id, employeeId, wreq.workspaceOwnerId],
      );
      if (sessionCheck.rows.length === 0) {
        res.status(403).json({ error: "Invalid attendance session for this employee" });
        return;
      }
    }

    // Guard against duplicate requests for the same session + type in any non-cancelled state
    const dupCheck = await db.query<{ status: string }>(
      `SELECT status FROM attendance_requests
        WHERE employee_id = $1
          AND attendance_session_id IS NOT DISTINCT FROM $2
          AND request_type = $3
          AND status IN ('pending', 'approved', 'declined')
        LIMIT 1`,
      [employeeId, body.attendance_session_id ?? null, body.request_type],
    );
    if (dupCheck.rows.length > 0) {
      const existingStatus = dupCheck.rows[0].status;
      const errorMessage =
        existingStatus === "pending"
          ? "A pending request of this type already exists for this session"
          : "A request of this type for this session has already been resolved";
      res.status(409).json({ error: errorMessage });
      return;
    }

    const result = await db.query(
      `INSERT INTO attendance_requests
         (workspace_owner_id, employee_id, attendance_session_id, request_type,
          requested_clock_in_at, requested_clock_out_at, requested_location_id, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        wreq.workspaceOwnerId,
        employeeId,
        body.attendance_session_id ?? null,
        body.request_type,
        body.requested_clock_in_at ?? null,
        body.requested_clock_out_at ?? null,
        body.requested_location_id ?? null,
        body.reason ?? null,
      ],
    );

    const newRequest = result.rows[0] as { id: number };

    broadcastAttendanceRequest(wreq.workspaceOwnerId);

    // Fire-and-forget push notification to the employee's manager(s)
    void (async () => {
      try {
        const managerResult = await db.query<{
          expo_push_token: string | null;
          first_name: string;
          last_name: string | null;
        }>(
          `SELECT mgr.expo_push_token,
                  emp.first_name,
                  emp.last_name
             FROM team_members emp
             JOIN team_members mgr ON mgr.id = emp.manager_id
            WHERE emp.id = $1
              AND emp.workspace_owner_id = $2
              AND mgr.expo_push_token IS NOT NULL
            LIMIT 1`,
          [employeeId, wreq.workspaceOwnerId],
        );
        if (managerResult.rows.length === 0) return;
        const { expo_push_token: token, first_name, last_name } = managerResult.rows[0];
        if (!token) return;
        const employeeName = [first_name, last_name].filter(Boolean).join(" ");
        const typeLabel =
          REQUEST_TYPE_LABELS[body.request_type ?? ""] ?? "correction request";
        await sendExpoPushNotification(
          token,
          "New Correction Request",
          `${employeeName} submitted a ${typeLabel.toLowerCase()} request`,
          { screen: "approvals" },
          async (staleToken: string) => {
            await db.query(
              `UPDATE team_members SET expo_push_token = NULL, updated_at = now()
                WHERE expo_push_token = $1`,
              [staleToken],
            );
          },
        );
      } catch (err: unknown) {
        logger.warn({ err }, "Failed to send correction request push notification to manager");
      }
    })();

    res.status(201).json({ success: true, request: newRequest });
  } catch (err) {
    logger.error({ err }, "attendance/requests POST failed");
    res.status(500).json({ error: "Failed to create correction request" });
  }
});

// ─── POST /api/attendance/push-token ─────────────────────────────────────────

router.post("/attendance/push-token", async (req, res) => {
  const wreq = workspace(req);
  const body = req.body as { expo_push_token?: unknown };
  const token = body.expo_push_token;
  if (
    typeof token !== "string" ||
    !/^ExponentPushToken\[.+\]$|^ExpoPushToken\[.+\]$/.test(token)
  ) {
    res.status(400).json({ error: "Invalid Expo push token format" });
    return;
  }
  const employeeId = await resolveEmployeeId(wreq.workspaceOwnerId, wreq.userId);
  if (employeeId === null) {
    res.status(403).json({ error: "No team member record for this user" });
    return;
  }
  try {
    await db.query(
      `UPDATE team_members SET expo_push_token = $1, updated_at = now() WHERE id = $2`,
      [token, employeeId],
    );
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "attendance/push-token POST failed");
    res.status(500).json({ error: "Failed to save push token" });
  }
});

export default router;
