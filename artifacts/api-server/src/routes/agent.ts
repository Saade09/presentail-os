import { Router } from "express";
import { db } from "../lib/db";
import { requireApiKey, type ApiKeyAuthedRequest } from "../lib/apiKeyAuth";

const router = Router();

// All /agent endpoints use API-key (Bearer) auth, NOT Clerk session auth.
// They are called by the locally-installed Print Agent on the user's Mac/PC.

router.post("/agent/register", requireApiKey, async (req, res) => {
  const userId = (req as ApiKeyAuthedRequest).userId;
  const body = req.body || {};
  const machineId = String(body.machine_id || "").trim();
  const name = String(body.name || "Untitled device").trim().slice(0, 200);
  const os = String(body.os || "").trim().slice(0, 64) || null;
  const agentVersion =
    String(body.agent_version || "").trim().slice(0, 32) || null;
  const printers = sanitizePrinters(body.printers);

  if (!machineId || machineId.length > 200) {
    res.status(400).json({ error: "machine_id required" });
    return;
  }

  const result = await db.query(
    `INSERT INTO devices (user_id, name, machine_id, os, agent_version, printers, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (user_id, machine_id) DO UPDATE
       SET name = EXCLUDED.name,
           os = EXCLUDED.os,
           agent_version = EXCLUDED.agent_version,
           printers = EXCLUDED.printers,
           last_seen_at = now()
     RETURNING id, name, machine_id, last_seen_at`,
    [userId, name, machineId, os, agentVersion, JSON.stringify(printers)],
  );

  res.json({ device: result.rows[0] });
});

router.post("/agent/heartbeat", requireApiKey, async (req, res) => {
  const userId = (req as ApiKeyAuthedRequest).userId;
  const body = req.body || {};
  const machineId = String(body.machine_id || "").trim();
  const printers =
    body.printers === undefined || body.printers === null
      ? null
      : sanitizePrinters(body.printers);

  if (!machineId) {
    res.status(400).json({ error: "machine_id required" });
    return;
  }

  const result =
    printers !== null
      ? await db.query(
          `UPDATE devices SET last_seen_at = now(), printers = $3, offline_alert_sent_at = NULL
           WHERE user_id = $1 AND machine_id = $2`,
          [userId, machineId, JSON.stringify(printers)],
        )
      : await db.query(
          `UPDATE devices SET last_seen_at = now(), offline_alert_sent_at = NULL
           WHERE user_id = $1 AND machine_id = $2`,
          [userId, machineId],
        );

  // If no row was updated, this device has never registered (or was deleted).
  // Tell the agent to re-register so the next cycle recovers cleanly.
  if (result.rowCount === 0) {
    res.status(404).json({ error: "device_not_registered" });
    return;
  }

  res.json({ ok: true });
});

// GET /api/agent/jobs — agent polls for pending jobs on its machine
// Returns up to 5 jobs and atomically claims them (status → 'claimed').
router.get("/agent/jobs", requireApiKey, async (req, res) => {
  const userId = (req as ApiKeyAuthedRequest).userId;
  const machineId = String(req.query.machine_id || "").trim();
  if (!machineId) {
    res.status(400).json({ error: "machine_id query param required" });
    return;
  }

  // Find the device row so we can filter jobs by device_id
  const devResult = await db.query(
    `SELECT id FROM devices WHERE user_id = $1 AND machine_id = $2 LIMIT 1`,
    [userId, machineId],
  );
  if (devResult.rowCount === 0) {
    res.json({ jobs: [] });
    return;
  }
  const deviceId = (devResult.rows[0] as { id: number }).id;

  // Atomically claim up to 5 pending jobs for this device
  const claimed = await db.query(
    `UPDATE print_jobs
        SET status = 'claimed', claimed_at = now()
      WHERE id IN (
        SELECT id FROM print_jobs
        WHERE device_id = $1 AND status = 'pending'
        ORDER BY created_at
        LIMIT 5
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, printer_name, file_name, copies,
                encode(pdf_data, 'base64') AS pdf_b64`,
    [deviceId],
  );

  res.json({ jobs: claimed.rows });
});

// GET /api/agent/jobs/:id/status — agent polls a claimed job's status mid-processing
// The agent should call this periodically while printing so it can abort early
// if the user cancels the job.  Returns { id, status, cancelled } where
// cancelled is true when the job was cancelled and the agent should stop.
router.get("/agent/jobs/:id/status", requireApiKey, async (req, res) => {
  const userId = (req as ApiKeyAuthedRequest).userId;
  const jobId = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(jobId)) {
    res.status(400).json({ error: "Invalid job id" });
    return;
  }

  const result = await db.query(
    `SELECT id, status FROM print_jobs WHERE id = $1 AND user_id = $2 LIMIT 1`,
    [jobId, userId],
  );
  if (result.rowCount === 0) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  const job = result.rows[0] as { id: number; status: string };
  res.json({ id: job.id, status: job.status, cancelled: job.status === "cancelled" });
});

// POST /api/agent/jobs/:id/done — agent reports job completion
router.post("/agent/jobs/:id/done", requireApiKey, async (req, res) => {
  const userId = (req as ApiKeyAuthedRequest).userId;
  const jobId = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(jobId)) {
    res.status(400).json({ error: "Invalid job id" });
    return;
  }

  const body = req.body || {};
  const success = body.success === true || body.success === "true";
  const errorMsg = typeof body.error === "string" ? body.error.slice(0, 1000) : null;
  const reportedPages =
    typeof body.pages === "number" && Number.isFinite(body.pages) && body.pages > 0
      ? Math.floor(body.pages)
      : null;

  const result = await db.query(
    `UPDATE print_jobs
        SET status = $1, error = $2, completed_at = now()
            ${reportedPages !== null ? ", pages = $5" : ""}
      WHERE id = $3 AND user_id = $4 AND status IN ('claimed','pending')
      RETURNING id, status`,
    reportedPages !== null
      ? [success ? "done" : "failed", errorMsg, jobId, userId, reportedPages]
      : [success ? "done" : "failed", errorMsg, jobId, userId],
  );

  if (result.rowCount === 0) {
    // Check whether the job was cancelled so the agent can stop processing it.
    const cancelledCheck = await db.query(
      `SELECT id FROM print_jobs WHERE id = $1 AND user_id = $2 AND status = 'cancelled' LIMIT 1`,
      [jobId, userId],
    );
    if ((cancelledCheck.rowCount ?? 0) > 0) {
      res.json({ ok: true, cancelled: true });
      return;
    }
    res.status(404).json({ error: "Job not found or already completed" });
    return;
  }

  res.json({ ok: true, job: result.rows[0] });
});

function sanitizePrinters(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((p) => typeof p === "string")
    .map((p) => (p as string).slice(0, 255))
    .slice(0, 50);
}

export default router;
