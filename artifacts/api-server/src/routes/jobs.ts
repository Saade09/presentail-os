import { Router } from "express";
import multer from "multer";
import { db } from "../lib/db";
import { requireApiKey, type ApiKeyAuthedRequest } from "../lib/apiKeyAuth";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// POST /api/jobs — submit a remote print job (API key auth)
// multipart/form-data fields: file (PDF), device_id, printer, copies, title
router.post("/jobs", requireApiKey, upload.single("file"), async (req, res) => {
  const userId = (req as ApiKeyAuthedRequest).userId;

  const file = (req as any).file as Express.Multer.File | undefined;
  if (!file) {
    res.status(400).json({ error: "Missing 'file' field (PDF)" });
    return;
  }
  if (!file.buffer.slice(0, 4).equals(Buffer.from("%PDF"))) {
    res.status(400).json({ error: "Uploaded file does not look like a valid PDF" });
    return;
  }

  const deviceId = String(req.body?.device_id || "").trim() || null;
  const printerName = String(req.body?.printer || "").trim().slice(0, 255) || null;
  const title = String(req.body?.title || file.originalname || "print-job").trim().slice(0, 255);
  const copies = Math.max(1, Math.min(parseInt(req.body?.copies ?? "1", 10) || 1, 99));

  // Validate device_id belongs to this user (if provided)
  if (deviceId) {
    const devCheck = await db.query(
      `SELECT id FROM devices WHERE id = $1 AND user_id = $2 LIMIT 1`,
      [deviceId, userId],
    );
    if (devCheck.rowCount === 0) {
      res.status(404).json({ error: "device_id not found or not yours" });
      return;
    }
  }

  const result = await db.query(
    `INSERT INTO print_jobs
       (user_id, device_id, device_name, printer_name, file_name, copies, pdf_data, status, pages)
     VALUES (
       $1, $2,
       (SELECT name FROM devices WHERE id = $2),
       $3, $4, $5, $6, 'pending', 0
     )
     RETURNING id, status, created_at`,
    [userId, deviceId, printerName, title, copies, file.buffer],
  );

  const job = result.rows[0] as { id: number; status: string; created_at: string };
  res.status(201).json({ id: job.id, status: job.status, created_at: job.created_at });
});

// GET /api/jobs/:id — poll job status (API key auth)
router.get("/jobs/:id", requireApiKey, async (req, res) => {
  const userId = (req as ApiKeyAuthedRequest).userId;
  const jobId = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(jobId)) {
    res.status(400).json({ error: "Invalid job id" });
    return;
  }

  const result = await db.query(
    `SELECT id, device_id, device_name, printer_name, file_name, copies,
            status, error, pages, created_at, completed_at, claimed_at
     FROM print_jobs
     WHERE id = $1 AND user_id = $2`,
    [jobId, userId],
  );
  if (result.rowCount === 0) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  res.json({ job: result.rows[0] });
});

export default router;
