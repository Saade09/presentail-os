import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { db } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";

const router = Router();

router.use(requireAuth, resolveWorkspace);

const deviceRowSchema = z
  .object({
    id: z.number().int(),
    name: z.string().nullable(),
    machine_id: z.string().nullable(),
    location_id: z.number().int().nullable(),
  })
  .passthrough();

const devicesResponseSchema = z.object({
  devices: z.array(deviceRowSchema),
});

function sendValidated<T>(
  req: Request,
  res: Response,
  schema: z.ZodType<T>,
  payload: unknown,
  route: string,
): void {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    req.log.error(
      { err: parsed.error.issues, route },
      "Response validation failed",
    );
    res.status(500).json({ error: "Internal server error" });
    return;
  }
  res.json(parsed.data);
}

router.get("/devices", async (req, res) => {
  const wreq = workspace(req);
  const ownerId = wreq.workspaceOwnerId;
  const assignedLocationIds = wreq.assignedLocationIds;

  let result;
  if (assignedLocationIds !== null && assignedLocationIds.length > 0) {
    // Member is restricted to specific locations — only return devices in those locations.
    result = await db.query(
      `SELECT d.id, d.name, d.machine_id, d.os, d.agent_version, d.printers,
              d.last_seen_at, d.created_at, d.location_id,
              l.name AS location_name, l.country AS location_country
       FROM devices d
       LEFT JOIN locations l ON l.id = d.location_id
       WHERE d.user_id = $1 AND d.location_id = ANY($2::int[])
       ORDER BY d.last_seen_at DESC`,
      [ownerId, assignedLocationIds],
    );
  } else {
    result = await db.query(
      `SELECT d.id, d.name, d.machine_id, d.os, d.agent_version, d.printers,
              d.last_seen_at, d.created_at, d.location_id,
              l.name AS location_name, l.country AS location_country
       FROM devices d
       LEFT JOIN locations l ON l.id = d.location_id
       WHERE d.user_id = $1
       ORDER BY d.last_seen_at DESC`,
      [ownerId],
    );
  }
  sendValidated(
    req,
    res,
    devicesResponseSchema,
    { devices: result.rows },
    "GET /devices",
  );
});

router.delete("/devices/:id", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Only the workspace owner can remove devices" });
    return;
  }
  const ownerId = wreq.workspaceOwnerId;
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  await db.query(`DELETE FROM devices WHERE id = $1 AND user_id = $2`, [
    id,
    ownerId,
  ]);
  res.json({ ok: true });
});

export default router;
