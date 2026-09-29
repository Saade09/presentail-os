import { Router } from "express";
import { and, asc, count, desc, eq, gte, lte, sql } from "drizzle-orm";
import { drizzleDb } from "../lib/drizzle.js";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";
import { logger } from "../lib/logger";
import { attendanceRecords, teamMembers } from "@workspace/db/schema";

const router = Router();

router.use(requireAuth, resolveWorkspace);

/**
 * Reusable snake_case field selection for attendance_records rows.
 * Preserves the API response shape that existing clients depend on.
 */
const arFields = {
  id: attendanceRecords.id,
  workspace_owner_id: attendanceRecords.workspaceOwnerId,
  employee_id: attendanceRecords.employeeId,
  attendance_date: attendanceRecords.attendanceDate,
  scheduled_start: attendanceRecords.scheduledStart,
  scheduled_end: attendanceRecords.scheduledEnd,
  clock_in: attendanceRecords.clockIn,
  clock_out: attendanceRecords.clockOut,
  break_minutes: attendanceRecords.breakMinutes,
  total_minutes: attendanceRecords.totalMinutes,
  status: attendanceRecords.status,
  location_id: attendanceRecords.locationId,
  source: attendanceRecords.source,
  notes: attendanceRecords.notes,
  created_by: attendanceRecords.createdBy,
  updated_by: attendanceRecords.updatedBy,
  created_at: attendanceRecords.createdAt,
  updated_at: attendanceRecords.updatedAt,
} as const;

/**
 * GET /attendance
 * List attendance records. Query params: employee_id, date_from, date_to, status
 */
router.get("/attendance", async (req, res) => {
  const wreq = workspace(req);

  const conditions = [eq(attendanceRecords.workspaceOwnerId, wreq.workspaceOwnerId)];
  if (req.query.employee_id) {
    conditions.push(eq(attendanceRecords.employeeId, Number(req.query.employee_id)));
  }
  if (typeof req.query.date_from === "string") {
    conditions.push(gte(attendanceRecords.attendanceDate, req.query.date_from));
  }
  if (typeof req.query.date_to === "string") {
    conditions.push(lte(attendanceRecords.attendanceDate, req.query.date_to));
  }
  if (typeof req.query.status === "string") {
    conditions.push(eq(attendanceRecords.status, req.query.status));
  }

  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Number(req.query.offset) || 0;

  try {
    const where = and(...conditions);

    const records = await drizzleDb
      .select({
        ...arFields,
        employee_name: sql<string>`${teamMembers.firstName} || COALESCE(' ' || ${teamMembers.lastName}, '')`,
      })
      .from(attendanceRecords)
      .leftJoin(teamMembers, eq(teamMembers.id, attendanceRecords.employeeId))
      .where(where)
      .orderBy(desc(attendanceRecords.attendanceDate), asc(attendanceRecords.employeeId))
      .limit(limit)
      .offset(offset);

    const [countRow] = await drizzleDb
      .select({ total: count() })
      .from(attendanceRecords)
      .where(where);

    res.json({
      success: true,
      records,
      total: Number(countRow?.total ?? 0),
      limit,
      offset,
    });
  } catch (err) {
    logger.error({ err }, "Failed to list attendance records");
    res.status(500).json({ error: "Failed to list attendance records" });
  }
});

/**
 * GET /attendance/:id
 * Get a single attendance record.
 */
router.get("/attendance/:id", async (req, res) => {
  const wreq = workspace(req);
  const id = Number(req.params.id);
  try {
    const [record] = await drizzleDb
      .select({
        ...arFields,
        employee_name: sql<string>`${teamMembers.firstName} || COALESCE(' ' || ${teamMembers.lastName}, '')`,
      })
      .from(attendanceRecords)
      .leftJoin(teamMembers, eq(teamMembers.id, attendanceRecords.employeeId))
      .where(and(eq(attendanceRecords.id, id), eq(attendanceRecords.workspaceOwnerId, wreq.workspaceOwnerId)));

    if (!record) {
      res.status(404).json({ error: "Attendance record not found" });
      return;
    }
    res.json({ success: true, record });
  } catch (err) {
    logger.error({ err }, "Failed to get attendance record");
    res.status(500).json({ error: "Failed to get attendance record" });
  }
});

/**
 * POST /attendance
 * Create an attendance record.
 */
router.post("/attendance", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Only owners can manage attendance records" });
    return;
  }
  const body = req.body as Record<string, unknown>;
  if (!body.employee_id || !body.attendance_date) {
    res.status(400).json({ error: "employee_id and attendance_date are required" });
    return;
  }
  try {
    const [record] = await drizzleDb
      .insert(attendanceRecords)
      .values({
        workspaceOwnerId: wreq.workspaceOwnerId,
        employeeId: Number(body.employee_id),
        attendanceDate: body.attendance_date as string,
        scheduledStart: (body.scheduled_start as string) || null,
        scheduledEnd: (body.scheduled_end as string) || null,
        clockIn: (body.clock_in as string) ? new Date(body.clock_in as string) : null,
        clockOut: (body.clock_out as string) ? new Date(body.clock_out as string) : null,
        breakMinutes: Number(body.break_minutes) || 0,
        totalMinutes: body.total_minutes ? Number(body.total_minutes) : null,
        status: (body.status as string) || "present",
        locationId: body.location_id ? Number(body.location_id) : null,
        source: (body.source as string) || "manual",
        notes: (body.notes as string) || null,
        createdBy: wreq.userId,
      })
      .returning(arFields);
    res.status(201).json({ success: true, record });
  } catch (err) {
    logger.error({ err }, "Failed to create attendance record");
    res.status(500).json({ error: "Failed to create attendance record" });
  }
});

/**
 * PATCH /attendance/:id
 * Update an attendance record.
 */
router.patch("/attendance/:id", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Only owners can manage attendance records" });
    return;
  }
  const id = Number(req.params.id);
  const body = req.body as Record<string, unknown>;

  type AttendanceUpdate = Partial<{
    scheduledStart: string | null;
    scheduledEnd: string | null;
    clockIn: Date | null;
    clockOut: Date | null;
    breakMinutes: number;
    totalMinutes: number | null;
    status: string;
    locationId: number | null;
    notes: string | null;
    updatedBy: string;
    updatedAt: Date;
  }>;

  const updates: AttendanceUpdate = {};
  if ("scheduled_start" in body) updates.scheduledStart = (body.scheduled_start as string) === "" ? null : (body.scheduled_start as string | null);
  if ("scheduled_end" in body) updates.scheduledEnd = (body.scheduled_end as string) === "" ? null : (body.scheduled_end as string | null);
  if ("clock_in" in body) updates.clockIn = (body.clock_in as string) === "" || body.clock_in == null ? null : new Date(body.clock_in as string);
  if ("clock_out" in body) updates.clockOut = (body.clock_out as string) === "" || body.clock_out == null ? null : new Date(body.clock_out as string);
  if ("break_minutes" in body) updates.breakMinutes = Number(body.break_minutes);
  if ("total_minutes" in body) updates.totalMinutes = body.total_minutes === "" || body.total_minutes == null ? null : Number(body.total_minutes);
  if ("status" in body) updates.status = body.status as string;
  if ("location_id" in body) updates.locationId = body.location_id === "" || body.location_id == null ? null : Number(body.location_id);
  if ("notes" in body) updates.notes = body.notes === "" ? null : (body.notes as string | null);

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }
  updates.updatedBy = wreq.userId;
  updates.updatedAt = new Date();

  try {
    const [record] = await drizzleDb
      .update(attendanceRecords)
      .set(updates)
      .where(and(eq(attendanceRecords.id, id), eq(attendanceRecords.workspaceOwnerId, wreq.workspaceOwnerId)))
      .returning(arFields);

    if (!record) {
      res.status(404).json({ error: "Attendance record not found" });
      return;
    }
    res.json({ success: true, record });
  } catch (err) {
    logger.error({ err }, "Failed to update attendance record");
    res.status(500).json({ error: "Failed to update attendance record" });
  }
});

/**
 * DELETE /attendance/:id
 * Delete an attendance record.
 */
router.delete("/attendance/:id", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Only owners can manage attendance records" });
    return;
  }
  const id = Number(req.params.id);
  try {
    const [deleted] = await drizzleDb
      .delete(attendanceRecords)
      .where(and(eq(attendanceRecords.id, id), eq(attendanceRecords.workspaceOwnerId, wreq.workspaceOwnerId)))
      .returning({ id: attendanceRecords.id });

    if (!deleted) {
      res.status(404).json({ error: "Attendance record not found" });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "Failed to delete attendance record");
    res.status(500).json({ error: "Failed to delete attendance record" });
  }
});

/**
 * GET /attendance/summary
 * Get attendance summary stats for a date range.
 */
router.get("/attendance/summary", async (req, res) => {
  const wreq = workspace(req);

  const conditions = [eq(attendanceRecords.workspaceOwnerId, wreq.workspaceOwnerId)];
  if (typeof req.query.date_from === "string") {
    conditions.push(gte(attendanceRecords.attendanceDate, req.query.date_from));
  }
  if (typeof req.query.date_to === "string") {
    conditions.push(lte(attendanceRecords.attendanceDate, req.query.date_to));
  }

  try {
    const rows = await drizzleDb
      .select({ status: attendanceRecords.status, count: count() })
      .from(attendanceRecords)
      .where(and(...conditions))
      .groupBy(attendanceRecords.status);

    const summary: Record<string, number> = {};
    for (const row of rows) {
      summary[row.status] = Number(row.count);
    }
    res.json({ success: true, summary });
  } catch (err) {
    logger.error({ err }, "Failed to get attendance summary");
    res.status(500).json({ error: "Failed to get attendance summary" });
  }
});

export default router;
