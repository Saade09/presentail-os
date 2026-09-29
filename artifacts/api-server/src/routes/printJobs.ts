import { Router, type Request, type Response } from "express";
import { db } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { hasPageAccess, resolveWorkspace, workspace } from "../lib/workspace";

const router = Router();

router.use(requireAuth, resolveWorkspace);

function requirePrintHistoryAccess(req: Request, res: Response): boolean {
  if (hasPageAccess(workspace(req), "print-history")) return true;
  res.status(403).json({ error: "You do not have access to print history" });
  return false;
}

function locationScope(assignedLocationIds: number[] | null): {
  sql: string;
  params: unknown[];
} {
  if (assignedLocationIds === null || assignedLocationIds.length === 0) {
    return { sql: "", params: [] };
  }
  return {
    sql: ` AND EXISTS (
      SELECT 1 FROM devices d
       WHERE d.id = print_jobs.device_id
         AND d.location_id = ANY($3::int[])
    )`,
    params: [assignedLocationIds],
  };
}

router.get("/print-jobs", async (req, res) => {
  const wreq = workspace(req);
  if (!requirePrintHistoryAccess(req, res)) return;
  const ownerId = wreq.workspaceOwnerId;
  const assignedLocationIds = wreq.assignedLocationIds;
  const raw = parseInt((req.query.limit as string) ?? "100", 10);
  const limit = Math.max(1, Math.min(Number.isFinite(raw) && raw > 0 ? raw : 100, 500));

  // Lightweight inline cleanup: permanently remove any of this user's
  // soft-deleted jobs whose 10-minute grace period has already expired.
  if (assignedLocationIds !== null && assignedLocationIds.length > 0) {
    await db.query(
      `DELETE FROM print_jobs
       WHERE user_id = $1
         AND deleted_at IS NOT NULL
         AND deleted_at < now() - INTERVAL '10 minutes'
         AND EXISTS (
           SELECT 1 FROM devices d
            WHERE d.id = print_jobs.device_id
              AND d.location_id = ANY($2::int[])
         )`,
      [ownerId, assignedLocationIds],
    );
  } else {
    await db.query(
      `DELETE FROM print_jobs
       WHERE user_id = $1
         AND deleted_at IS NOT NULL
         AND deleted_at < now() - INTERVAL '10 minutes'`,
      [ownerId],
    );
  }

  let result;
  if (assignedLocationIds !== null && assignedLocationIds.length > 0) {
    // Member is restricted to specific locations — only return jobs from devices in those locations.
    result = await db.query(
      `SELECT pj.id, pj.device_name, pj.printer_name, pj.file_name, pj.pages, pj.copies,
              pj.status, pj.error, pj.created_at, pj.completed_at, pj.pre_cancel_status
       FROM print_jobs pj
       JOIN devices d ON d.id = pj.device_id
       WHERE pj.user_id = $1 AND pj.deleted_at IS NULL AND d.location_id = ANY($3::int[])
       ORDER BY pj.created_at DESC LIMIT $2`,
      [ownerId, limit, assignedLocationIds],
    );
  } else {
    result = await db.query(
      `SELECT id, device_name, printer_name, file_name, pages, copies, status, error,
              created_at, completed_at, pre_cancel_status
       FROM print_jobs WHERE user_id = $1 AND deleted_at IS NULL
       ORDER BY created_at DESC LIMIT $2`,
      [ownerId, limit],
    );
  }
  res.json({ jobs: result.rows });
});

router.post("/print-jobs", async (req, res) => {
  const ownerId = workspace(req).workspaceOwnerId;

  const deviceId = parseInt(String(req.body?.device_id ?? ""), 10);
  if (!Number.isFinite(deviceId) || deviceId <= 0) {
    res.status(400).json({ error: "device_id is required and must be a positive integer" });
    return;
  }

  const printerName = String(req.body?.printer_name ?? "").trim().slice(0, 255);
  if (!printerName) {
    res.status(400).json({ error: "printer_name is required" });
    return;
  }

  const fileName = String(req.body?.file_name ?? "").trim().slice(0, 255);
  if (!fileName) {
    res.status(400).json({ error: "file_name is required" });
    return;
  }

  const pages = Math.max(0, parseInt(String(req.body?.pages ?? "1"), 10) || 1);
  const copies = Math.max(1, Math.min(parseInt(String(req.body?.copies ?? "1"), 10) || 1, 99));

  const devCheck = await db.query(
    `SELECT id, name FROM devices WHERE id = $1 AND user_id = $2 LIMIT 1`,
    [deviceId, ownerId],
  );
  if (devCheck.rowCount === 0) {
    res.status(404).json({ error: "device_id not found or not yours" });
    return;
  }

  const deviceName = (devCheck.rows[0] as { id: number; name: string }).name;

  const result = await db.query(
    `INSERT INTO print_jobs
       (user_id, device_id, device_name, printer_name, file_name, copies, status, pages, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'done', $7, now())
     RETURNING id, status, created_at`,
    [ownerId, deviceId, deviceName, printerName, fileName, copies, pages],
  );

  const job = result.rows[0] as { id: number; status: string; created_at: string };
  res.status(201).json({ id: job.id, status: job.status, created_at: job.created_at });
});

router.delete("/print-jobs/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!requirePrintHistoryAccess(req, res)) return;
  const ownerId = wreq.workspaceOwnerId;
  const scope = locationScope(wreq.assignedLocationIds);
  const jobId = parseInt(req.params.id, 10);
  if (!Number.isFinite(jobId) || jobId <= 0) {
    res.status(400).json({ error: "Invalid job id" });
    return;
  }

  const check = await db.query(
    `SELECT id, status FROM print_jobs WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL${scope.sql} LIMIT 1`,
    [jobId, ownerId, ...scope.params],
  );
  if (check.rowCount === 0) {
    res.status(404).json({ error: "Print job not found" });
    return;
  }

  await db.query(
    `UPDATE print_jobs SET deleted_at = now()
      WHERE id = $1 AND user_id = $2${scope.sql}`,
    [jobId, ownerId, ...scope.params],
  );
  res.json({ ok: true });
});

router.post("/print-jobs/:id/restore", async (req, res) => {
  const wreq = workspace(req);
  if (!requirePrintHistoryAccess(req, res)) return;
  const ownerId = wreq.workspaceOwnerId;
  const scope = locationScope(wreq.assignedLocationIds);
  const jobId = parseInt(req.params.id, 10);
  if (!Number.isFinite(jobId) || jobId <= 0) {
    res.status(400).json({ error: "Invalid job id" });
    return;
  }

  const check = await db.query(
    `SELECT id FROM print_jobs WHERE id = $1 AND user_id = $2 AND deleted_at IS NOT NULL${scope.sql} LIMIT 1`,
    [jobId, ownerId, ...scope.params],
  );
  if (check.rowCount === 0) {
    res.status(404).json({ error: "Print job not found or not deleted" });
    return;
  }

  await db.query(
    `UPDATE print_jobs SET deleted_at = NULL
      WHERE id = $1 AND user_id = $2${scope.sql}`,
    [jobId, ownerId, ...scope.params],
  );
  res.json({ ok: true });
});

router.delete("/print-jobs/:id/permanent", async (req, res) => {
  const wreq = workspace(req);
  if (!requirePrintHistoryAccess(req, res)) return;
  const ownerId = wreq.workspaceOwnerId;
  const scope = locationScope(wreq.assignedLocationIds);
  const jobId = parseInt(req.params.id, 10);
  if (!Number.isFinite(jobId) || jobId <= 0) {
    res.status(400).json({ error: "Invalid job id" });
    return;
  }

  const check = await db.query(
    `SELECT id, status FROM print_jobs WHERE id = $1 AND user_id = $2${scope.sql} LIMIT 1`,
    [jobId, ownerId, ...scope.params],
  );
  if (check.rowCount === 0) {
    res.status(404).json({ error: "Print job not found" });
    return;
  }

  const status = (check.rows[0] as { id: number; status: string }).status;

  if (status === "pending" || status === "claimed") {
    // Atomically cancel only if still in a cancellable state (guards against a
    // race where the agent completes the job between our SELECT and this UPDATE).
    const cancelled = await db.query(
      `UPDATE print_jobs SET status = 'cancelled', pre_cancel_status = status
       WHERE id = $1 AND user_id = $2 AND status IN ('pending', 'claimed')${scope.sql}
       RETURNING id`,
      [jobId, ownerId, ...scope.params],
    );
    if ((cancelled.rowCount ?? 0) === 0) {
      // Agent completed the job in the brief window — treat as already finished.
      res.json({ ok: true, already_completed: true });
    } else {
      res.json({ ok: true, cancelled: true });
    }
  } else {
    await db.query(
      `DELETE FROM print_jobs WHERE id = $1 AND user_id = $2${scope.sql}`,
      [jobId, ownerId, ...scope.params],
    );
    res.json({ ok: true, deleted: true });
  }
});

export default router;
