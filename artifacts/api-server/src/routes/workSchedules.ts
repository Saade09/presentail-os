import { Router } from "express";
import { db } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";
import { logger } from "../lib/logger";

const router = Router();

router.use(requireAuth, resolveWorkspace);

/**
 * GET /work-schedules
 * List work schedules for the workspace.
 */
router.get("/work-schedules", async (req, res) => {
  const wreq = workspace(req);
  try {
    const result = await db.query(
      `SELECT ws.*,
              json_agg(wsd.* ORDER BY
                CASE wsd.day_of_week
                  WHEN 'monday' THEN 1 WHEN 'tuesday' THEN 2 WHEN 'wednesday' THEN 3
                  WHEN 'thursday' THEN 4 WHEN 'friday' THEN 5 WHEN 'saturday' THEN 6
                  WHEN 'sunday' THEN 7 ELSE 8 END
              ) FILTER (WHERE wsd.id IS NOT NULL) AS days
         FROM work_schedules ws
         LEFT JOIN work_schedule_days wsd ON wsd.schedule_id = ws.id
        WHERE ws.workspace_owner_id = $1
        GROUP BY ws.id
        ORDER BY ws.name ASC`,
      [wreq.workspaceOwnerId],
    );
    res.json({ success: true, work_schedules: result.rows });
  } catch (err) {
    logger.error({ err }, "Failed to list work schedules");
    res.status(500).json({ error: "Failed to list work schedules" });
  }
});

/**
 * GET /work-schedules/:id
 * Get a single work schedule with days and exceptions.
 */
router.get("/work-schedules/:id", async (req, res) => {
  const wreq = workspace(req);
  const id = Number(req.params.id);
  try {
    const schedResult = await db.query(
      `SELECT * FROM work_schedules WHERE id = $1 AND workspace_owner_id = $2`,
      [id, wreq.workspaceOwnerId],
    );
    if (schedResult.rows.length === 0) {
      res.status(404).json({ error: "Work schedule not found" });
      return;
    }
    const daysResult = await db.query(
      `SELECT * FROM work_schedule_days WHERE schedule_id = $1
       ORDER BY CASE day_of_week
         WHEN 'monday' THEN 1 WHEN 'tuesday' THEN 2 WHEN 'wednesday' THEN 3
         WHEN 'thursday' THEN 4 WHEN 'friday' THEN 5 WHEN 'saturday' THEN 6
         WHEN 'sunday' THEN 7 ELSE 8 END`,
      [id],
    );
    const exceptResult = await db.query(
      `SELECT * FROM work_schedule_exceptions WHERE schedule_id = $1 ORDER BY start_date ASC`,
      [id],
    );
    res.json({
      success: true,
      work_schedule: {
        ...schedResult.rows[0],
        days: daysResult.rows,
        exceptions: exceptResult.rows,
      },
    });
  } catch (err) {
    logger.error({ err }, "Failed to get work schedule");
    res.status(500).json({ error: "Failed to get work schedule" });
  }
});

/**
 * POST /work-schedules
 * Create a new work schedule with optional days.
 */
router.post("/work-schedules", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Only owners can manage work schedules" });
    return;
  }
  const body = req.body as Record<string, unknown>;
  const name = typeof body.name === "string" ? body.name.trim() : null;
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  try {
    const overtimeAfter = body.overtime_after_minutes !== undefined
      ? Math.max(0, Number(body.overtime_after_minutes) || 0)
      : 480;
    const breakPolicy = body.break_policy_minutes !== undefined
      ? Math.max(0, Number(body.break_policy_minutes) || 0)
      : 0;
    const schedResult = await db.query(
      `INSERT INTO work_schedules
         (workspace_owner_id, name, description, default_timezone,
          overtime_after_minutes, break_policy_minutes)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [
        wreq.workspaceOwnerId,
        name,
        body.description || null,
        body.default_timezone || "UTC",
        overtimeAfter,
        breakPolicy,
      ],
    );
    const schedule = schedResult.rows[0] as { id: number };
    const days = Array.isArray(body.days) ? body.days as Record<string, unknown>[] : [];
    const dayRows: unknown[] = [];
    for (const day of days) {
      const dayResult = await db.query(
        `INSERT INTO work_schedule_days
           (schedule_id, day_of_week, is_working_day, start_time, end_time, break_minutes, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [
          schedule.id,
          day.day_of_week,
          day.is_working_day !== false,
          day.start_time || null,
          day.end_time || null,
          day.break_minutes || 0,
          day.notes || null,
        ],
      );
      dayRows.push(dayResult.rows[0]);
    }
    res.status(201).json({ success: true, work_schedule: { ...schedule, days: dayRows } });
  } catch (err) {
    logger.error({ err }, "Failed to create work schedule");
    res.status(500).json({ error: "Failed to create work schedule" });
  }
});

/**
 * PATCH /work-schedules/:id
 * Update a work schedule and its days.
 */
router.patch("/work-schedules/:id", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Only owners can manage work schedules" });
    return;
  }
  const id = Number(req.params.id);
  const body = req.body as Record<string, unknown>;
  const fields: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  if (typeof body.name === "string") { fields.push(`name = $${i++}`); params.push(body.name.trim()); }
  if (body.description !== undefined) { fields.push(`description = $${i++}`); params.push(body.description || null); }
  if (typeof body.default_timezone === "string") { fields.push(`default_timezone = $${i++}`); params.push(body.default_timezone); }
  if (typeof body.status === "string") { fields.push(`status = $${i++}`); params.push(body.status); }
  if (body.overtime_after_minutes !== undefined) {
    fields.push(`overtime_after_minutes = $${i++}`);
    params.push(Math.max(0, Number(body.overtime_after_minutes) || 0));
  }
  if (body.break_policy_minutes !== undefined) {
    fields.push(`break_policy_minutes = $${i++}`);
    params.push(Math.max(0, Number(body.break_policy_minutes) || 0));
  }
  try {
    if (fields.length > 0) {
      fields.push("updated_at = NOW()");
      params.push(id, wreq.workspaceOwnerId);
      const result = await db.query(
        `UPDATE work_schedules SET ${fields.join(", ")}
         WHERE id = $${i} AND workspace_owner_id = $${i + 1}
         RETURNING *`,
        params,
      );
      if (result.rows.length === 0) {
        res.status(404).json({ error: "Work schedule not found" });
        return;
      }
    }
    if (Array.isArray(body.days)) {
      await db.query(`DELETE FROM work_schedule_days WHERE schedule_id = $1`, [id]);
      for (const day of body.days as Record<string, unknown>[]) {
        await db.query(
          `INSERT INTO work_schedule_days
             (schedule_id, day_of_week, is_working_day, start_time, end_time, break_minutes, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [id, day.day_of_week, day.is_working_day !== false, day.start_time || null, day.end_time || null, day.break_minutes || 0, day.notes || null],
        );
      }
    }
    const schedResult = await db.query(`SELECT * FROM work_schedules WHERE id = $1`, [id]);
    const daysResult = await db.query(
      `SELECT * FROM work_schedule_days WHERE schedule_id = $1
       ORDER BY CASE day_of_week
         WHEN 'monday' THEN 1 WHEN 'tuesday' THEN 2 WHEN 'wednesday' THEN 3
         WHEN 'thursday' THEN 4 WHEN 'friday' THEN 5 WHEN 'saturday' THEN 6
         WHEN 'sunday' THEN 7 ELSE 8 END`,
      [id],
    );
    res.json({ success: true, work_schedule: { ...schedResult.rows[0], days: daysResult.rows } });
  } catch (err) {
    logger.error({ err }, "Failed to update work schedule");
    res.status(500).json({ error: "Failed to update work schedule" });
  }
});

/**
 * DELETE /work-schedules/:id
 * Delete a work schedule.
 */
router.delete("/work-schedules/:id", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Only owners can manage work schedules" });
    return;
  }
  const id = Number(req.params.id);
  try {
    const result = await db.query(
      `DELETE FROM work_schedules WHERE id = $1 AND workspace_owner_id = $2 RETURNING id`,
      [id, wreq.workspaceOwnerId],
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: "Work schedule not found" });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "Failed to delete work schedule");
    res.status(500).json({ error: "Failed to delete work schedule" });
  }
});

/**
 * POST /work-schedules/:id/exceptions
 * Add a schedule exception.
 */
router.post("/work-schedules/:id/exceptions", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Only owners can manage work schedules" });
    return;
  }
  const scheduleId = Number(req.params.id);
  const body = req.body as Record<string, unknown>;
  if (!body.name || !body.start_date || !body.end_date) {
    res.status(400).json({ error: "name, start_date, and end_date are required" });
    return;
  }
  try {
    const check = await db.query(
      `SELECT id FROM work_schedules WHERE id = $1 AND workspace_owner_id = $2`,
      [scheduleId, wreq.workspaceOwnerId],
    );
    if (check.rows.length === 0) {
      res.status(404).json({ error: "Work schedule not found" });
      return;
    }
    const result = await db.query(
      `INSERT INTO work_schedule_exceptions
         (schedule_id, name, start_date, end_date, is_working_day, start_time, end_time, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        scheduleId,
        body.name,
        body.start_date,
        body.end_date,
        body.is_working_day ?? null,
        body.start_time || null,
        body.end_time || null,
        body.notes || null,
      ],
    );
    res.status(201).json({ success: true, exception: result.rows[0] });
  } catch (err) {
    logger.error({ err }, "Failed to create work schedule exception");
    res.status(500).json({ error: "Failed to create work schedule exception" });
  }
});

/**
 * DELETE /work-schedules/:id/exceptions/:exceptionId
 * Remove a schedule exception.
 */
router.delete("/work-schedules/:id/exceptions/:exceptionId", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Only owners can manage work schedules" });
    return;
  }
  const scheduleId = Number(req.params.id);
  const exceptionId = Number(req.params.exceptionId);
  try {
    const check = await db.query(
      `SELECT ws.id FROM work_schedules ws
       JOIN work_schedule_exceptions wse ON wse.schedule_id = ws.id
       WHERE ws.id = $1 AND ws.workspace_owner_id = $2 AND wse.id = $3`,
      [scheduleId, wreq.workspaceOwnerId, exceptionId],
    );
    if (check.rows.length === 0) {
      res.status(404).json({ error: "Exception not found" });
      return;
    }
    await db.query(`DELETE FROM work_schedule_exceptions WHERE id = $1`, [exceptionId]);
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "Failed to delete work schedule exception");
    res.status(500).json({ error: "Failed to delete work schedule exception" });
  }
});

export default router;
