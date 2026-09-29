import { Router, type Request, type Response } from "express";
import { randomBytes, createHash, randomUUID } from "crypto";
import multer from "multer";
import { db } from "../lib/db.js";
import { requireAuth } from "../lib/auth.js";
import { hasPageAccess, resolveWorkspace, workspace } from "../lib/workspace.js";
import { logger } from "../lib/logger.js";
import { requireScannerDevice, scannerDevice } from "../lib/scannerAuth.js";
import { broadcastEvent } from "../lib/eventsSse.js";
import { ObjectNotFoundError, objectStorageService } from "../lib/objectStorage.js";
import {
  persistInvoiceSource,
  processInvoiceAsync,
  type FinanceEntityRow,
} from "./finance.js";

const router = Router();
export const scannerPublicRouter = Router();
export const scannerDeviceRouter = Router();

// ── Owner-authenticated management sub-router ────────────────────────────────

const authRouter = Router();
// Scope Clerk auth to /scanner/* paths only. This router is mounted at root
// (router.use(authRouter)), so without a path guard requireAuth would fire for
// every request passing through scanner.ts — including API-key-authenticated
// routes like POST /orders — and reject them with 401.
authRouter.use("/scanner", requireAuth, resolveWorkspace);

function canManageScanners(wreq: ReturnType<typeof workspace>): boolean {
  return hasPageAccess(wreq, "invoice-scanners");
}

function requireScannerManagementAccess(
  req: Request,
  res: Response,
): boolean {
  if (canManageScanners(workspace(req))) return true;
  res.status(403).json({ error: "Invoice Scanners access required" });
  return false;
}

// Pairing code: 8 uppercase alphanumeric chars (no 0/O/1/I)
function generatePairingCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  const bytes = randomBytes(8);
  for (const b of bytes) {
    code += chars[b % chars.length];
  }
  return code;
}

// Opaque device token: 32 random bytes as hex (64 chars)
function generateDeviceToken(): string {
  return randomBytes(32).toString("hex");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function scannerStationSelect(): string {
  return `ss.id,
          ss.workspace_owner_id,
          ss.name,
          ss.entity_id AS default_entity_id,
          COALESCE(fe.display_name, fe.legal_name) AS default_entity_name,
          fe.is_active AS default_entity_active,
          ss.location,
          ss.status,
          ss.last_seen_at,
          ss.agent_version,
          ss.queued_count,
          ss.created_at,
          ss.updated_at`;
}

// GET /scanner/stations — list stations for workspace
authRouter.get("/scanner/stations", async (req, res) => {
  if (!requireScannerManagementAccess(req, res)) return;
  const wreq = workspace(req);

  const result = await db.query(
    `SELECT ${scannerStationSelect()},
            (SELECT COUNT(*) FROM scanner_device_tokens sdt WHERE sdt.station_id = ss.id)::int AS token_count
       FROM scanner_stations ss
       LEFT JOIN finance_entities fe ON fe.id = ss.entity_id
      WHERE ss.workspace_owner_id = $1
      ORDER BY ss.created_at DESC`,
    [wreq.workspaceOwnerId],
  );
  res.json({ stations: result.rows });
});

// POST /scanner/stations — create station
authRouter.post("/scanner/stations", async (req, res) => {
  if (!requireScannerManagementAccess(req, res)) return;
  const wreq = workspace(req);

  const { name, default_entity_id, location } = req.body as Record<string, unknown>;
  if (!name || typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  const entityId = parseInt(String(default_entity_id ?? ""), 10);
  if (isNaN(entityId)) {
    res.status(400).json({ error: "default_entity_id is required" });
    return;
  }
  const entityCheck = await db.query(
    `SELECT id FROM finance_entities WHERE id = $1 AND workspace_owner_id = $2 AND is_active = true`,
    [entityId, wreq.workspaceOwnerId],
  );
  if (entityCheck.rowCount === 0) {
    res.status(404).json({ error: "Default entity not found or inactive" });
    return;
  }

  const result = await db.query(
    `WITH inserted AS (
       INSERT INTO scanner_stations (workspace_owner_id, name, entity_id, location)
       VALUES ($1, $2, $3, $4)
       RETURNING *
     )
     SELECT i.id, i.workspace_owner_id, i.name,
            i.entity_id AS default_entity_id,
            COALESCE(fe.display_name, fe.legal_name) AS default_entity_name,
            i.location, i.status, i.last_seen_at, i.agent_version,
            i.queued_count, i.created_at, i.updated_at
       FROM inserted i
       JOIN finance_entities fe ON fe.id = i.entity_id`,
    [
      wreq.workspaceOwnerId,
      name.trim(),
      entityId,
      location ? String(location).trim() : null,
    ],
  );
  res.status(201).json({ station: result.rows[0] });
});

// PATCH /scanner/stations/:id — update name, entity, location, or status
authRouter.patch("/scanner/stations/:id", async (req, res) => {
  if (!requireScannerManagementAccess(req, res)) return;
  const wreq = workspace(req);

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid station id" });
    return;
  }

  const existing = await db.query<{ name: string }>(
    `SELECT * FROM scanner_stations WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (existing.rowCount === 0) {
    res.status(404).json({ error: "Station not found" });
    return;
  }

  const body = req.body as Record<string, unknown>;
  const fields: string[] = [];
  const values: unknown[] = [];

  const appendField = (col: string, val: unknown) => {
    values.push(val);
    fields.push(`${col} = $${values.length}`);
  };

  if ("name" in body) {
    appendField("name", body.name ? String(body.name).trim() : existing.rows[0].name);
  }
  if ("location" in body) {
    appendField("location", body.location ? String(body.location).trim() : null);
  }
  if ("status" in body) {
    const s = String(body.status);
    if (s !== "active" && s !== "disabled") {
      res.status(400).json({ error: "status must be 'active' or 'disabled'" });
      return;
    }
    appendField("status", s);
  }
  if ("default_entity_id" in body) {
    const eid = parseInt(String(body.default_entity_id ?? ""), 10);
    if (isNaN(eid)) {
      res.status(400).json({ error: "default_entity_id is required" });
      return;
    }
    const entityCheck = await db.query(
      `SELECT id FROM finance_entities WHERE id = $1 AND workspace_owner_id = $2 AND is_active = true`,
      [eid, wreq.workspaceOwnerId],
    );
    if (entityCheck.rowCount === 0) {
      res.status(404).json({ error: "Default entity not found or inactive" });
      return;
    }
    appendField("entity_id", eid);
  }

  if (fields.length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }

  values.push(id, wreq.workspaceOwnerId);
  const result = await db.query(
    `WITH updated AS (
       UPDATE scanner_stations SET ${fields.join(", ")}, updated_at = now()
       WHERE id = $${values.length - 1} AND workspace_owner_id = $${values.length}
       RETURNING *
     )
     SELECT u.id, u.workspace_owner_id, u.name,
            u.entity_id AS default_entity_id,
            COALESCE(fe.display_name, fe.legal_name) AS default_entity_name,
             fe.is_active AS default_entity_active,
            u.location, u.status, u.last_seen_at, u.agent_version,
            u.queued_count, u.created_at, u.updated_at
       FROM updated u
       LEFT JOIN finance_entities fe ON fe.id = u.entity_id`,
    values,
  );
  res.json({ station: result.rows[0] });
});

// DELETE /scanner/stations/:id — soft-disable station and revoke all tokens
authRouter.delete("/scanner/stations/:id", async (req, res) => {
  if (!requireScannerManagementAccess(req, res)) return;
  const wreq = workspace(req);

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid station id" });
    return;
  }

  const result = await db.query(
    `UPDATE scanner_stations SET status = 'disabled', updated_at = now()
     WHERE id = $1 AND workspace_owner_id = $2
     RETURNING id`,
    [id, wreq.workspaceOwnerId],
  );
  if (result.rowCount === 0) {
    res.status(404).json({ error: "Station not found" });
    return;
  }

  await db.query(`DELETE FROM scanner_device_tokens WHERE station_id = $1`, [id]);
  res.json({ success: true });
});

// POST /scanner/stations/:id/pairing-code — generate a new pairing code (15 min expiry)
authRouter.post("/scanner/stations/:id/pairing-code", async (req, res) => {
  if (!requireScannerManagementAccess(req, res)) return;
  const wreq = workspace(req);

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid station id" });
    return;
  }

  const stationResult = await db.query<{
    id: number;
    entity_id: number | null;
    status: string;
    default_entity_active: boolean;
  }>(
    `SELECT ss.id, ss.entity_id, ss.status,
            (fe.id IS NOT NULL) AS default_entity_active
       FROM scanner_stations ss
       LEFT JOIN finance_entities fe
         ON fe.id = ss.entity_id
        AND fe.workspace_owner_id = ss.workspace_owner_id
        AND fe.is_active = true
      WHERE ss.id = $1 AND ss.workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (stationResult.rowCount === 0) {
    res.status(404).json({ error: "Station not found" });
    return;
  }
  if (stationResult.rows[0].status !== "active") {
    res.status(409).json({
      error: "Enable this scanner station before generating a pairing code",
      code: "SCANNER_STATION_DISABLED",
    });
    return;
  }
  if (
    !stationResult.rows[0].entity_id ||
    !stationResult.rows[0].default_entity_active
  ) {
    res.status(409).json({
      error:
        "Select an active default entity for this station before generating a pairing code",
      code: "SCANNER_CONFIGURATION_REQUIRED",
    });
    return;
  }

  // Invalidate any prior unused codes for this station
  await db.query(
    `DELETE FROM scanner_pairing_codes WHERE station_id = $1 AND used_at IS NULL`,
    [id],
  );

  const code = generatePairingCode();
  const correlationId = randomUUID();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

  const codeResult = await db.query(
    `INSERT INTO scanner_pairing_codes
       (station_id, workspace_owner_id, code, expires_at, correlation_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, code, expires_at, created_at, correlation_id`,
    [id, wreq.workspaceOwnerId, code, expiresAt.toISOString(), correlationId],
  );

  logger.info(
    {
      correlationId,
      stationId: id,
      workspaceOwnerId: wreq.workspaceOwnerId,
      expiresAt: expiresAt.toISOString(),
      event: "scanner_pairing_code_generated",
    },
    "scanner pairing lifecycle",
  );
  res.status(201).json({ pairing_code: codeResult.rows[0] });
});

// POST /scanner/stations/:id/revoke — revoke device tokens without disabling station
authRouter.post("/scanner/stations/:id/revoke", async (req, res) => {
  if (!requireScannerManagementAccess(req, res)) return;
  const wreq = workspace(req);

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid station id" });
    return;
  }

  const stationResult = await db.query(
    `SELECT id FROM scanner_stations WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (stationResult.rowCount === 0) {
    res.status(404).json({ error: "Station not found" });
    return;
  }

  const deleteResult = await db.query(
    `DELETE FROM scanner_device_tokens WHERE station_id = $1 RETURNING id`,
    [id],
  );

  res.json({ success: true, revoked: deleteResult.rowCount ?? 0 });
});

// Mount auth router into main router
router.use(authRouter);

// ── Public pairing endpoint — no user session required ───────────────────────

// POST /scanner/pair — device submits pairing code + device info; receives bearer token.
// This router is mounted before clerkMiddleware in app.ts so an unpaired device
// can redeem its one-time code without already having a Clerk browser session.
scannerPublicRouter.post("/scanner/pair", async (req, res) => {
  const { code, device_info } = req.body as Record<string, unknown>;
  const requestCorrelationId =
    typeof req.headers["x-correlation-id"] === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      req.headers["x-correlation-id"],
    )
      ? req.headers["x-correlation-id"]
      : randomUUID();

  logger.info(
    {
      correlationId: requestCorrelationId,
      method: req.method,
      endpoint: req.path,
      event: "scanner_pairing_request_received",
    },
    "scanner pairing lifecycle",
  );

  if (!code || typeof code !== "string" || !code.trim()) {
    logger.info(
      {
        correlationId: requestCorrelationId,
        result: "missing_code",
        event: "scanner_pairing_decided",
      },
      "scanner pairing lifecycle",
    );
    res.status(400).json({
      result: "missing_code",
      error: "Pairing code is required.",
      correlation_id: requestCorrelationId,
    });
    return;
  }

  const normalizedCode = code.trim().toUpperCase();
  const rawToken = generateDeviceToken();
  const tokenHash = hashToken(rawToken);
  const pairingResult = await db.query<{
    result: "accepted" | "expired_code" | "used_code" | "station_disabled" | "inactive_entity";
    correlation_id: string;
    station_id: number;
    workspace_owner_id: string;
    name: string;
    default_entity_id: number | null;
    default_entity_name: string | null;
    location: string | null;
    credential_issued_at: string | null;
  }>(
    `WITH candidate AS (
       SELECT spc.id AS pairing_code_id,
              spc.station_id,
              spc.workspace_owner_id,
              spc.correlation_id,
              ss.name,
              ss.entity_id AS default_entity_id,
              COALESCE(fe.display_name, fe.legal_name) AS default_entity_name,
              ss.location,
              CASE
                WHEN spc.used_at IS NOT NULL THEN 'used_code'
                WHEN spc.expires_at <= now() THEN 'expired_code'
                WHEN ss.status <> 'active' THEN 'station_disabled'
                WHEN ss.entity_id IS NULL OR fe.id IS NULL THEN 'inactive_entity'
                ELSE 'accepted'
              END AS candidate_result
         FROM scanner_pairing_codes spc
         JOIN scanner_stations ss
           ON ss.id = spc.station_id
          AND ss.workspace_owner_id = spc.workspace_owner_id
         LEFT JOIN finance_entities fe
           ON fe.id = ss.entity_id
          AND fe.workspace_owner_id = ss.workspace_owner_id
          AND fe.is_active = true
        WHERE spc.code = $1
        LIMIT 1
     ),
     claimed AS (
       UPDATE scanner_pairing_codes spc
          SET used_at = now()
         FROM candidate c
        WHERE spc.id = c.pairing_code_id
          AND c.candidate_result = 'accepted'
          AND spc.used_at IS NULL
          AND spc.expires_at > now()
        RETURNING spc.station_id
     ),
     token_insert AS (
       INSERT INTO scanner_device_tokens
              (station_id, workspace_owner_id, token_hash, device_info, pairing_correlation_id)
       SELECT c.station_id, c.workspace_owner_id, $2, $3::jsonb, c.correlation_id
         FROM candidate c
         JOIN claimed USING (station_id)
       RETURNING station_id, created_at
     )
     SELECT CASE
              WHEN c.candidate_result = 'accepted' AND ti.station_id IS NULL
                THEN 'used_code'
              ELSE c.candidate_result
            END AS result,
            c.correlation_id,
            c.station_id,
            c.workspace_owner_id,
            c.name,
            c.default_entity_id,
            c.default_entity_name,
            c.location,
            ti.created_at AS credential_issued_at
       FROM candidate c
       LEFT JOIN token_insert ti USING (station_id)`,
    [
      normalizedCode,
      tokenHash,
      device_info != null && typeof device_info === "object"
        ? JSON.stringify(device_info)
        : "{}",
    ],
  );

  if (pairingResult.rowCount === 0) {
    logger.info(
      {
        correlationId: requestCorrelationId,
        result: "invalid_code",
        event: "scanner_pairing_decided",
      },
      "scanner pairing lifecycle",
    );
    res.status(400).json({
      result: "invalid_code",
      error: "Pairing code was not recognized.",
      correlation_id: requestCorrelationId,
    });
    return;
  }

  const station = pairingResult.rows[0];
  const correlationId = station.correlation_id || requestCorrelationId;
  if (station.result !== "accepted" || !station.credential_issued_at) {
    const outcomes = {
      expired_code: {
        status: 410,
        error: "Pairing code expired. Generate a fresh code in Presentail OS.",
      },
      used_code: {
        status: 410,
        error: "Pairing code was already used. Generate a fresh code in Presentail OS.",
      },
      station_disabled: {
        status: 403,
        error: "Scanner station is disabled. Enable it before generating a fresh code.",
      },
      inactive_entity: {
        status: 409,
        error: "Scanner station needs an active default entity before pairing.",
      },
    } as const;
    const rejectionResult = station.result as Exclude<
      typeof station.result,
      "accepted"
    >;
    const outcome = outcomes[rejectionResult];
    logger.info(
      {
        correlationId,
        requestCorrelationId,
        stationId: station.station_id,
        result: rejectionResult,
        event: "scanner_pairing_decided",
      },
      "scanner pairing lifecycle",
    );
    res.status(outcome.status).json({
      result: rejectionResult,
      error: outcome.error,
      correlation_id: correlationId,
    });
    return;
  }

  logger.info(
    {
      correlationId,
      requestCorrelationId,
      stationId: station.station_id,
      result: "accepted",
      event: "scanner_credential_issued",
    },
    "scanner pairing lifecycle",
  );
  res.status(200).json({
    result: "accepted",
    correlation_id: correlationId,
    // Kept for installed 1.0.1 clients while 1.0.2 moves to the structured
    // credential object below.
    token: rawToken,
    credential: {
      token: rawToken,
      token_type: "Bearer",
      issued_at: station.credential_issued_at,
      expires_at: null,
    },
    station: {
      id: station.station_id,
      name: station.name,
      default_entity_id: station.default_entity_id,
      default_entity_name: station.default_entity_name,
      location: station.location,
    },
  });
});

// ── Scanner-device-authenticated endpoints ────────────────────────────────────

const SCANNER_MIME_TYPES = new Set(["application/pdf", "image/jpeg", "image/png"]);
const SCANNER_EXTENSIONS = new Set([".pdf", ".jpg", ".jpeg", ".png"]);
const MAX_SCANNER_FILE_SIZE =
  parseInt(process.env.AI_INVOICE_MAX_PDF_MB ?? "20") * 1024 * 1024;
const GENERIC_SCANNER_MIME_TYPES = new Set(["application/octet-stream"]);

type ScannerMimeType = "application/pdf" | "image/jpeg" | "image/png";

/** Identify supported scanner files from their trusted file signatures. */
function detectScannerMimeType(buffer: Buffer): ScannerMimeType | null {
  if (buffer.length < 4) return null;
  if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) {
    return "application/pdf";
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 8 &&
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).equals(
      buffer.subarray(0, 8),
    )
  ) {
    return "image/png";
  }
  return null;
}

const scannerUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SCANNER_FILE_SIZE, files: 1 },
  fileFilter(_req, file, cb) {
    // The scanner agent 1.0.3 sends extensionless files as
    // application/octet-stream. Content validation happens after multer has
    // buffered the file so those uploads can be identified by their bytes.
    cb(null, true);
  },
});

// POST /scanner/upload — scanner-device-authenticated single-file upload
scannerDeviceRouter.post(
  "/scanner/upload",
  requireScannerDevice,
  scannerUpload.single("file"),
  async (req, res) => {
    const sreq = scannerDevice(req);
    const file = req.file;

    if (!file) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }

    // Resolve the expected type from trusted metadata first. For the
    // extensionless/generic shape emitted by Scanner Agent 1.0.3, use the
    // content signature instead. Metadata is never sufficient on its own:
    // the detected signature must always agree with a declared supported type
    // or supported extension.
    const ext = file.originalname.toLowerCase().match(/\.[^.]+$/)?.[0] ?? "";
    const extensionMime: ScannerMimeType | null =
      ext === ".pdf"
        ? "application/pdf"
        : ext === ".jpg" || ext === ".jpeg"
          ? "image/jpeg"
          : ext === ".png"
            ? "image/png"
            : null;
    const declaredMime = SCANNER_MIME_TYPES.has(file.mimetype)
      ? (file.mimetype as ScannerMimeType)
      : null;
    const isGenericMime = GENERIC_SCANNER_MIME_TYPES.has(file.mimetype);
    const expectedMime = declaredMime ?? extensionMime;
    const detectedMime = detectScannerMimeType(file.buffer);

    if (!detectedMime) {
      res.status(400).json({
        error: expectedMime
          ? "File content does not match its declared type"
          : "Unsupported file type",
      });
      return;
    }

    // Preserve the existing allowlist for non-generic MIME types while
    // allowing the agent's application/octet-stream payload to be inferred.
    if (!expectedMime && !isGenericMime) {
      res.status(400).json({ error: "Unsupported file type" });
      return;
    }

    if (expectedMime && detectedMime !== expectedMime) {
      res.status(400).json({ error: "File content does not match its declared type" });
      return;
    }
    const resolvedMime = detectedMime;

    // Station must have a default entity configured
    const entityId = sreq.scannerEntityId;
    if (!entityId) {
      res.status(409).json({
        error: "Scanner station has no default entity. Edit the station in Presentail OS, select an active entity, then re-pair the agent.",
      });
      return;
    }

    const entityResult = await db.query<FinanceEntityRow>(
      `SELECT * FROM finance_entities WHERE id = $1 AND workspace_owner_id = $2 AND is_active = true`,
      [entityId, sreq.scannerWorkspaceOwnerId],
    );
    if (entityResult.rowCount === 0) {
      res.status(409).json({
        error: "Scanner station default entity is inactive. Select an active entity in Presentail OS, then re-pair the agent.",
      });
      return;
    }
    const entity = entityResult.rows[0];

    // SHA-256 for idempotency
    const fileSha256 = createHash("sha256").update(file.buffer).digest("hex");
    const idempotencyClient = await db.connect();
    try {
      // A session-scoped lock covers the database lookup, source verification,
      // source repair, and extraction kickoff. This prevents simultaneous
      // first uploads or retries for one workspace/hash from duplicating work.
      await idempotencyClient.query(
        `SELECT pg_advisory_lock(hashtextextended($1, 0))`,
        [`scanner-upload:${sreq.scannerWorkspaceOwnerId}:${fileSha256}`],
      );

    // Idempotency check: same workspace + same hash → return existing import
    const existingImport = await idempotencyClient.query<{ id: number; pdf_storage_path: string | null }>(
      `SELECT id, pdf_storage_path FROM ai_invoice_imports
        WHERE workspace_owner_id = $1 AND file_sha256 = $2
        LIMIT 1`,
      [sreq.scannerWorkspaceOwnerId, fileSha256],
    );
    if (existingImport.rows[0]?.pdf_storage_path) {
      try {
        await objectStorageService.getObjectEntityFile(existingImport.rows[0].pdf_storage_path);
        res.status(200).json({
          import_id: existingImport.rows[0].id,
          duplicate: true,
          source_verified: true,
          message: "File already imported",
        });
        return;
      } catch (err) {
        if (!(err instanceof ObjectNotFoundError)) {
          logger.warn(
            { err, importId: existingImport.rows[0].id },
            "scanner: duplicate source verification failed",
          );
          res.status(503).json({
            import_id: existingImport.rows[0].id,
            retryable: true,
            error: "Source document could not be verified. Scanner will retry.",
          });
          return;
        }
        logger.warn(
          { err, importId: existingImport.rows[0].id },
          "scanner: duplicate source object missing; repairing from retry",
        );
      }
    }

    // captured_at from request body (ISO string from scanning device)
    const capturedAtRaw = req.body?.captured_at;
    const capturedAt =
      typeof capturedAtRaw === "string" && capturedAtRaw
        ? (() => {
            try {
              return new Date(capturedAtRaw).toISOString();
            } catch {
              return null;
            }
          })()
        : null;

    const requestedBatchId = typeof req.body?.source_batch_id === "string" && /^[A-Za-z0-9._:-]{1,120}$/.test(req.body.source_batch_id)
      ? req.body.source_batch_id
      : null;
    const requestedPageNumber = Number(req.body?.source_page_number);
    const requestedPageCount = Number(req.body?.source_page_count);
    const hasPageProvenance = !!requestedBatchId
      && Number.isInteger(requestedPageNumber)
      && requestedPageNumber > 0
      && Number.isInteger(requestedPageCount)
      && requestedPageCount >= requestedPageNumber;

    const sourceFilename =
      typeof req.body?.original_filename === "string" && req.body.original_filename.trim()
        ? req.body.original_filename.trim()
        : file.originalname;
    let importId = existingImport.rows[0]?.id;
    if (!importId) {
      const insertResult = await idempotencyClient.query<{ id: number }>(
        `INSERT INTO ai_invoice_imports
           (workspace_owner_id, entity_id, status, original_filename,
              source, scanner_station_id, file_sha256, captured_at, scanner_uploaded_at,
              source_batch_id, source_page_number, source_page_count)
           VALUES ($1, $2, 'uploaded', $3, 'scanner', $4, $5, $6, now(), $7, $8, $9)
          RETURNING id`,
        [
          sreq.scannerWorkspaceOwnerId,
          entityId,
          sourceFilename,
          sreq.scannerStationId,
          fileSha256,
          capturedAt,
          hasPageProvenance ? requestedBatchId : null,
          hasPageProvenance ? requestedPageNumber : null,
          hasPageProvenance ? requestedPageCount : null,
        ],
      );
      importId = insertResult.rows[0].id;
    }

    try {
      await persistInvoiceSource(
        importId,
        { originalname: sourceFilename, buffer: file.buffer },
        resolvedMime,
        sreq.scannerWorkspaceOwnerId,
      );
    } catch (err) {
      logger.warn({ err, importId }, "scanner: required invoice source storage failed");
      await db.query(
        `UPDATE ai_invoice_imports
            SET status='failed',
                processing_step='source_storage_failed',
                error_message='Source document storage failed. Scanner will retry.',
                updated_at=now()
          WHERE id=$1 AND workspace_owner_id=$2`,
        [importId, sreq.scannerWorkspaceOwnerId],
      );
      res.status(503).json({
        import_id: importId,
        retryable: true,
        error: "Source document storage failed. Scanner will retry.",
      });
      return;
    }

    // SSE broadcast so OS dashboard can invalidate Recent Imports query
    broadcastEvent(sreq.scannerWorkspaceOwnerId, {
      event: "finance.scanner_import.created",
      workspaceId: sreq.scannerWorkspaceOwnerId,
      data: { importId, stationId: sreq.scannerStationId, filename: sourceFilename },
    });

    // Kick off AI extraction pipeline asynchronously
    void processInvoiceAsync(
      importId,
      { buffer: file.buffer, mimeType: resolvedMime },
      entity,
      sreq.scannerWorkspaceOwnerId,
      true,
    ).catch((err) => {
      logger.error({ err, importId }, "scanner: async invoice processing failed");
    });

    res.status(202).json({
      import_id: importId,
      source_stored: true,
      message: "Upload accepted, processing started",
    });
    } finally {
      try {
        await idempotencyClient.query(
          `SELECT pg_advisory_unlock(hashtextextended($1, 0))`,
          [`scanner-upload:${sreq.scannerWorkspaceOwnerId}:${fileSha256}`],
        );
      } finally {
        idempotencyClient.release();
      }
    }
  },
);

// PATCH /scanner/heartbeat — device updates last_seen_at, agent version, and queue size
scannerDeviceRouter.patch("/scanner/heartbeat", requireScannerDevice, async (req, res) => {
  const sreq = scannerDevice(req);
  const correlationId =
    sreq.scannerPairingCorrelationId ||
    (typeof req.headers["x-correlation-id"] === "string"
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        req.headers["x-correlation-id"],
      )
      ? req.headers["x-correlation-id"]
      : randomUUID());
  logger.info(
    {
      correlationId,
      stationId: sreq.scannerStationId,
      agentVersion: req.body?.agent_version ?? null,
      queuedCount: req.body?.queued_count ?? null,
      event: "scanner_heartbeat_received",
    },
    "scanner pairing lifecycle",
  );
  if (!sreq.scannerEntityId || sreq.scannerEntityActive === false) {
    res.status(409).json({
      error:
        "Scanner station default entity is missing or inactive. Select an active entity in Presentail OS, then re-pair the agent.",
      code: "SCANNER_CONFIGURATION_REQUIRED",
    });
    return;
  }
  const { agent_version, queued_count } = req.body as Record<string, unknown>;
  const queueCount =
    typeof queued_count === "number" && Number.isInteger(queued_count)
      ? Math.max(0, Math.min(queued_count, 100_000))
      : 0;

  await db.query(
    `UPDATE scanner_stations
        SET last_seen_at = now(),
            agent_version = COALESCE($1, agent_version),
            queued_count = $2,
            updated_at = now()
      WHERE id = $3`,
    [
      agent_version != null ? String(agent_version) : null,
      queueCount,
      sreq.scannerStationId,
    ],
  );

  logger.info(
    {
      correlationId,
      stationId: sreq.scannerStationId,
      agentVersion: agent_version ?? null,
      queuedCount: queueCount,
      event: "scanner_station_connected",
    },
    "scanner pairing lifecycle",
  );
  res.json({
    ok: true,
    station_id: sreq.scannerStationId,
    correlation_id: correlationId,
    station: {
      id: sreq.scannerStationId,
      name: sreq.scannerStationName,
      default_entity_id: sreq.scannerEntityId,
      default_entity_name: sreq.scannerEntityName,
      location: sreq.scannerLocation,
    },
  });
});

export default router;
