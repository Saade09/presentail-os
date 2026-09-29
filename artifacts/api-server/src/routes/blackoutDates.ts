import { Router } from "express";
import { db } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";
import { logger } from "../lib/logger";

const router = Router();

router.use(requireAuth, resolveWorkspace);

/**
 * GET /blackout-dates
 * List blackout dates for the workspace.
 */
router.get("/blackout-dates", async (req, res) => {
  const wreq = workspace(req);
  const params: unknown[] = [wreq.workspaceOwnerId];
  let whereClause = "WHERE workspace_owner_id = $1";
  let i = 2;

  if (typeof req.query.date_from === "string") {
    whereClause += ` AND end_date >= $${i++}`;
    params.push(req.query.date_from);
  }
  if (typeof req.query.date_to === "string") {
    whereClause += ` AND start_date <= $${i++}`;
    params.push(req.query.date_to);
  }
  if (typeof req.query.status === "string") {
    whereClause += ` AND status = $${i++}`;
    params.push(req.query.status);
  }

  try {
    const result = await db.query(
      `SELECT * FROM blackout_dates ${whereClause} ORDER BY start_date ASC`,
      params,
    );
    res.json({ success: true, blackout_dates: result.rows });
  } catch (err) {
    logger.error({ err }, "Failed to list blackout dates");
    res.status(500).json({ error: "Failed to list blackout dates" });
  }
});

/**
 * GET /blackout-dates/active
 * Get currently active blackout dates (for time-off request validation).
 * Public within the workspace (any member can call this).
 */
router.get("/blackout-dates/active", async (req, res) => {
  const wreq = workspace(req);
  const today = new Date().toISOString().slice(0, 10);
  try {
    const result = await db.query(
      `SELECT * FROM blackout_dates
        WHERE workspace_owner_id = $1
          AND start_date <= $2 AND end_date >= $2
          AND status != 'cancelled'
        ORDER BY start_date ASC`,
      [wreq.workspaceOwnerId, today],
    );
    res.json({ success: true, blackout_dates: result.rows });
  } catch (err) {
    logger.error({ err }, "Failed to get active blackout dates");
    res.status(500).json({ error: "Failed to get active blackout dates" });
  }
});

/**
 * GET /blackout-dates/check
 * Check if a date range overlaps with any blackout dates.
 * Returns overlapping blackout dates for the given date range.
 */
router.get("/blackout-dates/check", async (req, res) => {
  const wreq = workspace(req);
  const startDate = req.query.start_date as string;
  const endDate = req.query.end_date as string;
  if (!startDate || !endDate) {
    res.status(400).json({ error: "start_date and end_date are required" });
    return;
  }
  try {
    const result = await db.query(
      `SELECT * FROM blackout_dates
        WHERE workspace_owner_id = $1
          AND start_date <= $3 AND end_date >= $2
          AND status != 'cancelled'
        ORDER BY start_date ASC`,
      [wreq.workspaceOwnerId, startDate, endDate],
    );
    res.json({ success: true, overlapping: result.rows, has_overlap: result.rows.length > 0 });
  } catch (err) {
    logger.error({ err }, "Failed to check blackout dates");
    res.status(500).json({ error: "Failed to check blackout dates" });
  }
});

/**
 * GET /blackout-dates/:id
 * Get a single blackout date.
 */
router.get("/blackout-dates/:id", async (req, res) => {
  const wreq = workspace(req);
  const id = Number(req.params.id);
  try {
    const result = await db.query(
      `SELECT * FROM blackout_dates WHERE id = $1 AND workspace_owner_id = $2`,
      [id, wreq.workspaceOwnerId],
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: "Blackout date not found" });
      return;
    }
    res.json({ success: true, blackout_date: result.rows[0] });
  } catch (err) {
    logger.error({ err }, "Failed to get blackout date");
    res.status(500).json({ error: "Failed to get blackout date" });
  }
});

/**
 * POST /blackout-dates
 * Create a new blackout date.
 */
router.post("/blackout-dates", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Only owners can manage blackout dates" });
    return;
  }
  const body = req.body as Record<string, unknown>;
  const name = typeof body.name === "string" ? body.name.trim() : null;
  if (!name || !body.start_date || !body.end_date) {
    res.status(400).json({ error: "name, start_date, and end_date are required" });
    return;
  }
  if (String(body.start_date) > String(body.end_date)) {
    res.status(400).json({ error: "start_date must be on or before end_date" });
    return;
  }
  const restrictionType = typeof body.restriction_type === "string" ? body.restriction_type : "warning_only";
  if (!["warning_only", "blocking", "manager_approval"].includes(restrictionType)) {
    res.status(400).json({ error: "Invalid restriction_type" });
    return;
  }
  try {
    const result = await db.query(
      `INSERT INTO blackout_dates
         (workspace_owner_id, name, description, start_date, end_date,
          restriction_type, affected_location_ids, affected_department_ids,
          affected_employee_ids, affected_leave_type_ids, employee_message,
          allow_exceptions, exception_approver_type, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [
        wreq.workspaceOwnerId,
        name,
        body.description || null,
        body.start_date,
        body.end_date,
        restrictionType,
        body.affected_location_ids || null,
        body.affected_department_ids || null,
        body.affected_employee_ids || null,
        body.affected_leave_type_ids || null,
        body.employee_message || null,
        body.allow_exceptions === true,
        body.exception_approver_type || null,
        body.status || "upcoming",
      ],
    );
    res.status(201).json({ success: true, blackout_date: result.rows[0] });
  } catch (err) {
    logger.error({ err }, "Failed to create blackout date");
    res.status(500).json({ error: "Failed to create blackout date" });
  }
});

/**
 * PATCH /blackout-dates/:id
 * Update a blackout date.
 */
router.patch("/blackout-dates/:id", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Only owners can manage blackout dates" });
    return;
  }
  const id = Number(req.params.id);
  const body = req.body as Record<string, unknown>;
  const allowed = [
    "name","description","start_date","end_date","restriction_type",
    "affected_location_ids","affected_department_ids","affected_employee_ids",
    "affected_leave_type_ids","employee_message","allow_exceptions",
    "exception_approver_type","status",
  ];
  const fields: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  for (const key of allowed) {
    if (key in body) {
      fields.push(`${key} = $${i++}`);
      const v = body[key];
      params.push(v === "" ? null : v);
    }
  }
  if (fields.length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }
  fields.push("updated_at = NOW()");
  params.push(id, wreq.workspaceOwnerId);
  try {
    const result = await db.query(
      `UPDATE blackout_dates SET ${fields.join(", ")}
       WHERE id = $${i} AND workspace_owner_id = $${i + 1}
       RETURNING *`,
      params,
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: "Blackout date not found" });
      return;
    }
    res.json({ success: true, blackout_date: result.rows[0] });
  } catch (err) {
    logger.error({ err }, "Failed to update blackout date");
    res.status(500).json({ error: "Failed to update blackout date" });
  }
});

/**
 * DELETE /blackout-dates/:id
 * Delete a blackout date.
 */
router.delete("/blackout-dates/:id", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Only owners can manage blackout dates" });
    return;
  }
  const id = Number(req.params.id);
  try {
    const result = await db.query(
      `DELETE FROM blackout_dates WHERE id = $1 AND workspace_owner_id = $2 RETURNING id`,
      [id, wreq.workspaceOwnerId],
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: "Blackout date not found" });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "Failed to delete blackout date");
    res.status(500).json({ error: "Failed to delete blackout date" });
  }
});

export default router;
