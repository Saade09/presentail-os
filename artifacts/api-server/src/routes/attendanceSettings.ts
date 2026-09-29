import { Router } from "express";
import { db } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";
import { logger } from "../lib/logger";

const router = Router();

router.use(requireAuth, resolveWorkspace);

/**
 * GET /attendance-settings/locations
 * List all workspace locations with their attendance/geofence configuration.
 */
router.get("/attendance-settings/locations", async (req, res) => {
  const wreq = workspace(req);
  try {
    const result = await db.query(
      `SELECT l.id, l.name, l.latitude, l.longitude,
              l.geofence_radius_meters, l.attendance_enabled,
              l.default_schedule_id,
              ws.name AS default_schedule_name
         FROM locations l
         LEFT JOIN work_schedules ws ON ws.id = l.default_schedule_id
        WHERE l.workspace_owner_id = $1
          AND l.status = 'active'
        ORDER BY l.name ASC`,
      [wreq.workspaceOwnerId],
    );
    res.json({ success: true, locations: result.rows });
  } catch (err) {
    logger.error({ err }, "attendance-settings/locations GET failed");
    res.status(500).json({ error: "Failed to load location attendance settings" });
  }
});

/**
 * PATCH /attendance-settings/locations/:id
 * Update geofence radius, coordinates, attendance toggle, and default schedule
 * for a location. Owner only.
 */
router.patch("/attendance-settings/locations/:id", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Only owners can update attendance settings" });
    return;
  }
  const locationId = Number(req.params.id);
  if (!Number.isFinite(locationId)) {
    res.status(400).json({ error: "Invalid location id" });
    return;
  }
  const body = req.body as Record<string, unknown>;

  const fields: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  if (body.geofence_radius_meters !== undefined) {
    const radius = Number(body.geofence_radius_meters);
    if (!Number.isFinite(radius) || radius < 10 || radius > 50000) {
      res.status(400).json({ error: "geofence_radius_meters must be between 10 and 50000" });
      return;
    }
    fields.push(`geofence_radius_meters = $${i++}`);
    params.push(Math.round(radius));
  }
  if (body.latitude !== undefined) {
    const lat = body.latitude === null ? null : Number(body.latitude);
    if (lat !== null && (lat < -90 || lat > 90)) {
      res.status(400).json({ error: "latitude must be between -90 and 90" });
      return;
    }
    fields.push(`latitude = $${i++}`);
    params.push(lat);
  }
  if (body.longitude !== undefined) {
    const lon = body.longitude === null ? null : Number(body.longitude);
    if (lon !== null && (lon < -180 || lon > 180)) {
      res.status(400).json({ error: "longitude must be between -180 and 180" });
      return;
    }
    fields.push(`longitude = $${i++}`);
    params.push(lon);
  }
  if (body.attendance_enabled !== undefined) {
    fields.push(`attendance_enabled = $${i++}`);
    params.push(Boolean(body.attendance_enabled));
  }
  if (body.default_schedule_id !== undefined) {
    if (body.default_schedule_id === null) {
      fields.push(`default_schedule_id = $${i++}`);
      params.push(null);
    } else {
      const schedId = Number(body.default_schedule_id);
      if (!Number.isFinite(schedId)) {
        res.status(400).json({ error: "default_schedule_id must be a valid integer or null" });
        return;
      }
      // Verify schedule belongs to workspace
      const schedCheck = await db.query(
        `SELECT id FROM work_schedules WHERE id = $1 AND workspace_owner_id = $2`,
        [schedId, wreq.workspaceOwnerId],
      );
      if (schedCheck.rows.length === 0) {
        res.status(404).json({ error: "Work schedule not found" });
        return;
      }
      fields.push(`default_schedule_id = $${i++}`);
      params.push(schedId);
    }
  }

  if (fields.length === 0) {
    res.status(400).json({ error: "No valid fields to update" });
    return;
  }

  params.push(locationId, wreq.workspaceOwnerId);
  try {
    const result = await db.query(
      `UPDATE locations
          SET ${fields.join(", ")}
        WHERE id = $${i} AND workspace_owner_id = $${i + 1}
        RETURNING id, name, latitude, longitude,
                  geofence_radius_meters, attendance_enabled, default_schedule_id`,
      params,
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: "Location not found" });
      return;
    }
    res.json({ success: true, location: result.rows[0] });
  } catch (err) {
    logger.error({ err }, "attendance-settings/locations/:id PATCH failed");
    res.status(500).json({ error: "Failed to update location attendance settings" });
  }
});

export default router;
