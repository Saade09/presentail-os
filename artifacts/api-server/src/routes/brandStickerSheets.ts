import { Router } from "express";
import multer from "multer";
import { randomUUID } from "crypto";
import { db } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace, type WorkspaceRequest } from "../lib/workspace";
import { objectStorageClient } from "../lib/objectStorage";
import { runPdfToImageInWorker } from "../lib/pdfToImagePool";
import { extractStickerThumbnail } from "../lib/extractStickerThumbnail";
import { logger } from "../lib/logger";

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
});

const VALID_SHEET_SIZES = ["a4", "a3", "letter", "custom"] as const;
const VALID_STATUSES = ["pending_review", "print_ready", "needs_changes", "archived"] as const;

type SheetRow = {
  id: number;
  workspace_owner_id: string;
  brand_id: number;
  brand_name: string;
  file_url: string;
  file_name: string;
  file_size: number;
  thumbnail_url: string | null;
  sheet_size: string;
  custom_width: string | null;
  custom_height: string | null;
  sticker_count: number;
  status: string;
  version_number: number;
  version_notes: string | null;
  is_active: boolean;
  uploaded_by_user_id: string;
  uploaded_at: string;
  reviewed_by_user_id: string | null;
  reviewed_at: string | null;
  approved_by_user_id: string | null;
  approved_at: string | null;
  change_request_notes: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

function canUpload(wreq: WorkspaceRequest): boolean {
  return (
    wreq.workspaceActualRole === "owner" ||
    (wreq.allowedPages?.includes("sticker-sheets.upload") ?? false) ||
    (wreq.allowedPages?.includes("stickers.upload") ?? false) ||
    (wreq.allowedPages?.includes("brands.manage") ?? false)
  );
}

function canApprove(wreq: WorkspaceRequest): boolean {
  return (
    wreq.workspaceActualRole === "owner" ||
    (wreq.allowedPages?.includes("sticker-sheets.approve") ?? false)
  );
}

function canRequestChanges(wreq: WorkspaceRequest): boolean {
  return (
    wreq.workspaceActualRole === "owner" ||
    (wreq.allowedPages?.includes("sticker-sheets.request-changes") ?? false)
  );
}

function canArchive(wreq: WorkspaceRequest): boolean {
  return (
    wreq.workspaceActualRole === "owner" ||
    (wreq.allowedPages?.includes("sticker-sheets.archive") ?? false)
  );
}

function canDelete(wreq: WorkspaceRequest): boolean {
  return (
    wreq.workspaceActualRole === "owner" ||
    (wreq.allowedPages?.includes("sticker-sheets.delete") ?? false)
  );
}

async function uploadPdfToStorage(
  buffer: Buffer,
  workspaceOwnerId: string,
): Promise<string> {
  const privateObjectDir = process.env.PRIVATE_OBJECT_DIR;
  if (!privateObjectDir) {
    throw new Error("PRIVATE_OBJECT_DIR not set");
  }
  const objectId = randomUUID();
  const fullPath = `${privateObjectDir}/${workspaceOwnerId}/sticker-sheets/${objectId}`;
  const parts = fullPath.startsWith("/") ? fullPath.slice(1).split("/") : fullPath.split("/");
  if (parts.length < 2) throw new Error("Invalid PRIVATE_OBJECT_DIR path");
  const bucketName = parts[0];
  const objectName = parts.slice(1).join("/");
  const bucket = objectStorageClient.bucket(bucketName);
  const file = bucket.file(objectName);
  await file.save(buffer, { contentType: "application/pdf", resumable: false });
  return `/objects/${workspaceOwnerId}/sticker-sheets/${objectId}`;
}

async function uploadThumbnailToStorage(
  buffer: Buffer,
  workspaceOwnerId: string,
): Promise<string> {
  const privateObjectDir = process.env.PRIVATE_OBJECT_DIR;
  if (!privateObjectDir) throw new Error("PRIVATE_OBJECT_DIR not set");
  const objectId = randomUUID();
  const fullPath = `${privateObjectDir}/${workspaceOwnerId}/sticker-sheet-thumbnails/${objectId}`;
  const parts = fullPath.startsWith("/") ? fullPath.slice(1).split("/") : fullPath.split("/");
  const bucketName = parts[0];
  const objectName = parts.slice(1).join("/");
  const bucket = objectStorageClient.bucket(bucketName);
  const file = bucket.file(objectName);
  await file.save(buffer, { contentType: "image/png", resumable: false });
  return `/objects/${workspaceOwnerId}/sticker-sheet-thumbnails/${objectId}`;
}

async function writeAuditLog(params: {
  workspaceOwnerId: string;
  sheetId: number | null;
  brandId: number | null;
  brandName: string;
  versionNumber: number | null;
  fileName: string | null;
  action: string;
  actorUserId: string;
  notes?: string | null;
}): Promise<void> {
  try {
    await db.query(
      `INSERT INTO brand_sticker_sheet_audit_log
         (workspace_owner_id, sheet_id, brand_id, brand_name, version_number, file_name, action, actor_user_id, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        params.workspaceOwnerId,
        params.sheetId,
        params.brandId,
        params.brandName,
        params.versionNumber,
        params.fileName,
        params.action,
        params.actorUserId,
        params.notes ?? null,
      ],
    );
  } catch (err) {
    logger.warn({ err }, "brand sticker sheet audit log write failed");
  }
}

router.use(requireAuth, resolveWorkspace);

/**
 * GET /api/brand-sticker-sheets
 * List brands with their current active (or most recent) sticker sheet.
 * Supports: ?brand_id, ?status, ?sheet_size, ?q (search brand name / file name), ?include_all_versions=true
 */
router.get("/brand-sticker-sheets", async (req, res) => {
  const wreq = workspace(req);

  const brandIdParam = req.query.brand_id ? parseInt(String(req.query.brand_id), 10) : null;
  const statusFilter = req.query.status ? String(req.query.status) : null;
  const sheetSizeFilter = req.query.sheet_size ? String(req.query.sheet_size) : null;
  const q = req.query.q ? String(req.query.q).trim() : null;
  const includeAllVersions = req.query.include_all_versions === "true";

  if (brandIdParam !== null && isNaN(brandIdParam)) {
    res.status(400).json({ error: "Invalid brand_id" });
    return;
  }

  if (includeAllVersions && brandIdParam) {
    const result = await db.query<SheetRow & { brand_name: string }>(
      `SELECT bss.*, b.name AS brand_name
         FROM brand_sticker_sheets bss
         JOIN brands b ON b.id = bss.brand_id
        WHERE bss.workspace_owner_id = $1
          AND bss.brand_id = $2
        ORDER BY bss.version_number DESC`,
      [wreq.workspaceOwnerId, brandIdParam],
    );
    res.json({ sheets: result.rows });
    return;
  }

  const brandRows = await db.query<{
    id: number;
    name: string;
    primary_logo_id: number | null;
  }>(
    `SELECT b.id, b.name,
            (SELECT bl.id FROM brand_logos bl WHERE bl.brand_id = b.id AND bl.deleted_at IS NULL ORDER BY bl.sort_order ASC LIMIT 1) AS primary_logo_id
       FROM brands b
      WHERE b.workspace_owner_id = $1
        ${brandIdParam ? "AND b.id = $2" : ""}
      ORDER BY b.name ASC`,
    brandIdParam ? [wreq.workspaceOwnerId, brandIdParam] : [wreq.workspaceOwnerId],
  );

  const brandIds = brandRows.rows.map((b) => b.id);
  if (brandIds.length === 0) {
    res.json({ brands: [] });
    return;
  }

  const sheetRows = await db.query<SheetRow & { brand_name: string }>(
    `SELECT DISTINCT ON (bss.brand_id)
            bss.*, b.name AS brand_name
       FROM brand_sticker_sheets bss
       JOIN brands b ON b.id = bss.brand_id
      WHERE bss.workspace_owner_id = $1
        AND bss.brand_id = ANY($2::int[])
        AND bss.status != 'archived'
      ORDER BY bss.brand_id, bss.is_active DESC, bss.version_number DESC`,
    [wreq.workspaceOwnerId, brandIds],
  );

  const sheetByBrandId = new Map<number, (SheetRow & { brand_name: string })>();
  for (const row of sheetRows.rows) {
    sheetByBrandId.set(row.brand_id, row);
  }

  const brandMap = new Map(brandRows.rows.map((b) => [b.id, b]));

  let combined = brandRows.rows.map((brand) => {
    const sheet = sheetByBrandId.get(brand.id) ?? null;
    return {
      brand_id: brand.id,
      brand_name: brand.name,
      primary_logo_id: brand.primary_logo_id,
      sheet,
    };
  });

  if (statusFilter) {
    if (statusFilter === "missing") {
      combined = combined.filter((r) => r.sheet === null);
    } else {
      combined = combined.filter((r) => r.sheet?.status === statusFilter);
    }
  }

  if (sheetSizeFilter) {
    combined = combined.filter((r) => r.sheet?.sheet_size === sheetSizeFilter);
  }

  if (q) {
    const lq = q.toLowerCase();
    combined = combined.filter(
      (r) =>
        r.brand_name.toLowerCase().includes(lq) ||
        (r.sheet?.file_name?.toLowerCase().includes(lq) ?? false),
    );
  }

  const summary = {
    total_brands: brandRows.rows.length,
    active_sheets: combined.filter((r) => r.sheet?.status === "print_ready" && r.sheet?.is_active).length,
    pending_review: combined.filter((r) => r.sheet?.status === "pending_review").length,
    missing_sheets: combined.filter((r) => r.sheet === null).length,
    needs_changes: combined.filter((r) => r.sheet?.status === "needs_changes").length,
  };

  res.json({ brands: combined, summary });
});

/**
 * GET /api/brand-sticker-sheets/:id
 * Get a single sticker sheet by ID.
 */
router.get("/brand-sticker-sheets/:id", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid sheet id" });
    return;
  }
  const result = await db.query<SheetRow & { brand_name: string }>(
    `SELECT bss.*, b.name AS brand_name
       FROM brand_sticker_sheets bss
       JOIN brands b ON b.id = bss.brand_id
      WHERE bss.id = $1 AND bss.workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (result.rowCount === 0) {
    res.status(404).json({ error: "Sheet not found" });
    return;
  }
  res.json({ sheet: result.rows[0] });
});

/**
 * POST /api/brand-sticker-sheets
 * Upload a new sticker sheet PDF for a brand.
 * Multipart: pdf (file), brand_id, sheet_size, sticker_count, version_notes, mark_as_ready (owner only)
 */
router.post("/brand-sticker-sheets", upload.single("pdf"), async (req, res) => {
  const wreq = workspace(req);
  if (!canUpload(wreq)) {
    res.status(403).json({ error: "Insufficient permissions to upload sticker sheets" });
    return;
  }

  const file = (req as unknown as { file?: Express.Multer.File }).file;
  if (!file) {
    res.status(400).json({ error: "Missing 'pdf' file field" });
    return;
  }

  const isPdf = file.buffer.length >= 4 &&
    file.buffer.slice(0, 4).toString("ascii") === "%PDF";
  if (!isPdf) {
    res.status(400).json({ error: "Uploaded file must be a PDF" });
    return;
  }

  const brandIdRaw = req.body?.brand_id;
  if (!brandIdRaw) {
    res.status(400).json({ error: "brand_id is required" });
    return;
  }
  const brandId = parseInt(String(brandIdRaw), 10);
  if (isNaN(brandId)) {
    res.status(400).json({ error: "Invalid brand_id" });
    return;
  }

  const brandCheck = await db.query<{ id: number; name: string }>(
    `SELECT id, name FROM brands WHERE id = $1 AND workspace_owner_id = $2`,
    [brandId, wreq.workspaceOwnerId],
  );
  if (brandCheck.rowCount === 0) {
    res.status(400).json({ error: "Brand not found" });
    return;
  }
  const brandName = brandCheck.rows[0].name;

  const sheetSizeRaw = String(req.body?.sheet_size ?? "a4");
  const sheetSize = (VALID_SHEET_SIZES as readonly string[]).includes(sheetSizeRaw)
    ? sheetSizeRaw
    : "a4";

  const stickerCount = parseInt(String(req.body?.sticker_count ?? "1"), 10);
  if (isNaN(stickerCount) || stickerCount < 1) {
    res.status(400).json({ error: "sticker_count must be a positive integer" });
    return;
  }

  const versionNotes = req.body?.version_notes ? String(req.body.version_notes).slice(0, 2000) : null;
  const markAsReady = wreq.workspaceActualRole === "owner" && req.body?.mark_as_ready === "true";

  const versionResult = await db.query<{ max_version: string | null }>(
    `SELECT MAX(version_number) AS max_version FROM brand_sticker_sheets WHERE brand_id = $1`,
    [brandId],
  );
  const nextVersion = parseInt(versionResult.rows[0]?.max_version ?? "0", 10) + 1;

  const fileName = (file.originalname || `sticker-sheet-v${nextVersion}.pdf`).slice(0, 255);
  const fileSize = file.buffer.length;

  let fileUrl: string;
  try {
    fileUrl = await uploadPdfToStorage(file.buffer, wreq.workspaceOwnerId);
  } catch (err) {
    logger.error({ err }, "Failed to upload sticker sheet PDF");
    res.status(500).json({ error: "Failed to upload PDF to storage" });
    return;
  }

  const initialStatus = markAsReady ? "print_ready" : "pending_review";

  const insertResult = await db.query<{ id: number }>(
    `INSERT INTO brand_sticker_sheets
       (workspace_owner_id, brand_id, file_url, file_name, file_size, sheet_size,
        sticker_count, status, version_number, version_notes, is_active,
        uploaded_by_user_id, approved_by_user_id, approved_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
             ${markAsReady ? "$13" : "NULL"},
             ${markAsReady ? "NOW()" : "NULL"})
     RETURNING id`,
    markAsReady
      ? [wreq.workspaceOwnerId, brandId, fileUrl, fileName, fileSize, sheetSize,
         stickerCount, initialStatus, nextVersion, versionNotes, false, wreq.userId, wreq.userId]
      : [wreq.workspaceOwnerId, brandId, fileUrl, fileName, fileSize, sheetSize,
         stickerCount, initialStatus, nextVersion, versionNotes, false, wreq.userId],
  );

  const sheetId = insertResult.rows[0].id;

  if (markAsReady) {
    await db.query(
      `UPDATE brand_sticker_sheets SET is_active = FALSE, archived_at = NOW(), status = 'archived', updated_at = NOW()
        WHERE brand_id = $1 AND is_active = TRUE AND id != $2`,
      [brandId, sheetId],
    );
    await db.query(
      `UPDATE brand_sticker_sheets SET is_active = TRUE, updated_at = NOW() WHERE id = $1`,
      [sheetId],
    );
  }

  void (async () => {
    try {
      const imageBuffer = await runPdfToImageInWorker(file.buffer);
      if (imageBuffer) {
        const thumbnail = await extractStickerThumbnail(imageBuffer, {
          workspaceOwnerId: wreq.workspaceOwnerId,
        });
        if (thumbnail) {
          const thumbnailUrl = await uploadThumbnailToStorage(thumbnail, wreq.workspaceOwnerId);
          await db.query(
            `UPDATE brand_sticker_sheets SET thumbnail_url = $1, updated_at = NOW() WHERE id = $2`,
            [thumbnailUrl, sheetId],
          );
          logger.info({ sheetId }, "brand sticker sheet thumbnail generated");
        }
      }
    } catch (err) {
      logger.warn({ err, sheetId }, "brand sticker sheet thumbnail generation failed");
    }
  })();

  await writeAuditLog({
    workspaceOwnerId: wreq.workspaceOwnerId,
    sheetId,
    brandId,
    brandName,
    versionNumber: nextVersion,
    fileName,
    action: markAsReady ? "uploaded_and_approved" : "uploaded",
    actorUserId: wreq.userId,
  });

  res.status(201).json({ sheet: { id: sheetId, version_number: nextVersion, status: initialStatus } });
});

/**
 * PATCH /api/brand-sticker-sheets/:id/approve
 * Approve a pending sheet: set status=print_ready, is_active=true, archive previous active.
 */
router.patch("/brand-sticker-sheets/:id/approve", async (req, res) => {
  const wreq = workspace(req);
  if (!canApprove(wreq)) {
    res.status(403).json({ error: "Insufficient permissions to approve sticker sheets" });
    return;
  }
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid sheet id" });
    return;
  }
  const sheetResult = await db.query<SheetRow & { brand_name: string }>(
    `SELECT bss.*, b.name AS brand_name
       FROM brand_sticker_sheets bss
       JOIN brands b ON b.id = bss.brand_id
      WHERE bss.id = $1 AND bss.workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (sheetResult.rowCount === 0) {
    res.status(404).json({ error: "Sheet not found" });
    return;
  }
  const sheet = sheetResult.rows[0];
  if (sheet.status === "print_ready" && sheet.is_active) {
    res.status(409).json({ error: "Sheet is already active and print-ready" });
    return;
  }

  await db.query(
    `UPDATE brand_sticker_sheets
        SET is_active = FALSE, status = 'archived', archived_at = NOW(), updated_at = NOW()
      WHERE brand_id = $1 AND is_active = TRUE AND id != $2`,
    [sheet.brand_id, id],
  );
  await db.query(
    `UPDATE brand_sticker_sheets
        SET status = 'print_ready', is_active = TRUE,
            reviewed_by_user_id = $1, reviewed_at = NOW(),
            approved_by_user_id = $1, approved_at = NOW(),
            updated_at = NOW()
      WHERE id = $2`,
    [wreq.userId, id],
  );

  await writeAuditLog({
    workspaceOwnerId: wreq.workspaceOwnerId,
    sheetId: id,
    brandId: sheet.brand_id,
    brandName: sheet.brand_name,
    versionNumber: sheet.version_number,
    fileName: sheet.file_name,
    action: "approved",
    actorUserId: wreq.userId,
  });

  res.json({ ok: true });
});

/**
 * PATCH /api/brand-sticker-sheets/:id/request-changes
 * Set status=needs_changes, store change_request_notes.
 */
router.patch("/brand-sticker-sheets/:id/request-changes", async (req, res) => {
  const wreq = workspace(req);
  if (!canRequestChanges(wreq)) {
    res.status(403).json({ error: "Insufficient permissions to request changes" });
    return;
  }
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid sheet id" });
    return;
  }
  const notes = String(req.body?.notes ?? "").trim();
  if (!notes) {
    res.status(400).json({ error: "Change request notes are required" });
    return;
  }
  const sheetResult = await db.query<SheetRow & { brand_name: string }>(
    `SELECT bss.*, b.name AS brand_name
       FROM brand_sticker_sheets bss
       JOIN brands b ON b.id = bss.brand_id
      WHERE bss.id = $1 AND bss.workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (sheetResult.rowCount === 0) {
    res.status(404).json({ error: "Sheet not found" });
    return;
  }
  const sheet = sheetResult.rows[0];

  await db.query(
    `UPDATE brand_sticker_sheets
        SET status = 'needs_changes', change_request_notes = $1,
            reviewed_by_user_id = $2, reviewed_at = NOW(),
            is_active = FALSE, updated_at = NOW()
      WHERE id = $3`,
    [notes.slice(0, 2000), wreq.userId, id],
  );

  await writeAuditLog({
    workspaceOwnerId: wreq.workspaceOwnerId,
    sheetId: id,
    brandId: sheet.brand_id,
    brandName: sheet.brand_name,
    versionNumber: sheet.version_number,
    fileName: sheet.file_name,
    action: "changes_requested",
    actorUserId: wreq.userId,
    notes: notes.slice(0, 500),
  });

  res.json({ ok: true });
});

/**
 * PATCH /api/brand-sticker-sheets/:id/archive
 */
router.patch("/brand-sticker-sheets/:id/archive", async (req, res) => {
  const wreq = workspace(req);
  if (!canArchive(wreq)) {
    res.status(403).json({ error: "Insufficient permissions to archive sticker sheets" });
    return;
  }
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid sheet id" });
    return;
  }
  const sheetResult = await db.query<SheetRow & { brand_name: string }>(
    `SELECT bss.*, b.name AS brand_name
       FROM brand_sticker_sheets bss
       JOIN brands b ON b.id = bss.brand_id
      WHERE bss.id = $1 AND bss.workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (sheetResult.rowCount === 0) {
    res.status(404).json({ error: "Sheet not found" });
    return;
  }
  const sheet = sheetResult.rows[0];

  await db.query(
    `UPDATE brand_sticker_sheets
        SET status = 'archived', is_active = FALSE, archived_at = NOW(), updated_at = NOW()
      WHERE id = $1`,
    [id],
  );

  await writeAuditLog({
    workspaceOwnerId: wreq.workspaceOwnerId,
    sheetId: id,
    brandId: sheet.brand_id,
    brandName: sheet.brand_name,
    versionNumber: sheet.version_number,
    fileName: sheet.file_name,
    action: "archived",
    actorUserId: wreq.userId,
  });

  res.json({ ok: true });
});

/**
 * PATCH /api/brand-sticker-sheets/:id/restore
 * Restore an older version: archive current active, set this one as active.
 */
router.patch("/brand-sticker-sheets/:id/restore", async (req, res) => {
  const wreq = workspace(req);
  if (!canApprove(wreq)) {
    res.status(403).json({ error: "Insufficient permissions to restore sticker sheets" });
    return;
  }
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid sheet id" });
    return;
  }
  const sheetResult = await db.query<SheetRow & { brand_name: string }>(
    `SELECT bss.*, b.name AS brand_name
       FROM brand_sticker_sheets bss
       JOIN brands b ON b.id = bss.brand_id
      WHERE bss.id = $1 AND bss.workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (sheetResult.rowCount === 0) {
    res.status(404).json({ error: "Sheet not found" });
    return;
  }
  const sheet = sheetResult.rows[0];

  await db.query(
    `UPDATE brand_sticker_sheets
        SET is_active = FALSE, status = 'archived', archived_at = NOW(), updated_at = NOW()
      WHERE brand_id = $1 AND is_active = TRUE AND id != $2`,
    [sheet.brand_id, id],
  );
  await db.query(
    `UPDATE brand_sticker_sheets
        SET status = 'print_ready', is_active = TRUE,
            archived_at = NULL, approved_by_user_id = $1, approved_at = NOW(), updated_at = NOW()
      WHERE id = $2`,
    [wreq.userId, id],
  );

  await writeAuditLog({
    workspaceOwnerId: wreq.workspaceOwnerId,
    sheetId: id,
    brandId: sheet.brand_id,
    brandName: sheet.brand_name,
    versionNumber: sheet.version_number,
    fileName: sheet.file_name,
    action: "restored",
    actorUserId: wreq.userId,
  });

  res.json({ ok: true });
});

/**
 * DELETE /api/brand-sticker-sheets/:id
 */
router.delete("/brand-sticker-sheets/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!canDelete(wreq)) {
    res.status(403).json({ error: "Insufficient permissions to delete sticker sheets" });
    return;
  }
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid sheet id" });
    return;
  }
  const sheetResult = await db.query<SheetRow & { brand_name: string }>(
    `SELECT bss.*, b.name AS brand_name
       FROM brand_sticker_sheets bss
       JOIN brands b ON b.id = bss.brand_id
      WHERE bss.id = $1 AND bss.workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (sheetResult.rowCount === 0) {
    res.status(404).json({ error: "Sheet not found" });
    return;
  }
  const sheet = sheetResult.rows[0];

  await db.query(`DELETE FROM brand_sticker_sheets WHERE id = $1`, [id]);

  await writeAuditLog({
    workspaceOwnerId: wreq.workspaceOwnerId,
    sheetId: id,
    brandId: sheet.brand_id,
    brandName: sheet.brand_name,
    versionNumber: sheet.version_number,
    fileName: sheet.file_name,
    action: "deleted",
    actorUserId: wreq.userId,
  });

  res.json({ ok: true });
});

/**
 * GET /api/brand-sticker-sheets/:id/file
 * Stream the PDF from object storage.
 */
router.get("/brand-sticker-sheets/:id/file", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid sheet id" });
    return;
  }
  const result = await db.query<{ file_url: string; file_name: string }>(
    `SELECT file_url, file_name FROM brand_sticker_sheets WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (result.rowCount === 0) {
    res.status(404).json({ error: "Sheet not found" });
    return;
  }
  const { file_url, file_name } = result.rows[0];

  const privateObjectDir = process.env.PRIVATE_OBJECT_DIR;
  if (!privateObjectDir || !file_url.startsWith("/objects/")) {
    res.status(404).json({ error: "File not available" });
    return;
  }

  let entityDir = privateObjectDir;
  if (!entityDir.endsWith("/")) entityDir = `${entityDir}/`;
  const entityId = file_url.replace(/^\/objects\//, "");
  const fullPath = `${entityDir}${entityId}`;
  const parts = fullPath.startsWith("/") ? fullPath.slice(1).split("/") : fullPath.split("/");
  const bucketName = parts[0];
  const objectName = parts.slice(1).join("/");

  try {
    const bucket = objectStorageClient.bucket(bucketName);
    const file = bucket.file(objectName);
    const [exists] = await file.exists();
    if (!exists) {
      res.status(404).json({ error: "File not found in storage" });
      return;
    }
    const safeName = file_name.replace(/[^\w\s.\-]/g, "_");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${safeName}"`);
    res.setHeader("Cache-Control", "private, max-age=3600");
    file.createReadStream().pipe(res);
  } catch (err) {
    logger.error({ err, sheetId: id }, "Failed to stream sticker sheet PDF");
    res.status(500).json({ error: "Failed to retrieve file" });
  }
});

/**
 * GET /api/brand-sticker-sheets/:id/thumbnail
 * Stream the thumbnail PNG from object storage.
 */
router.get("/brand-sticker-sheets/:id/thumbnail", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid sheet id" });
    return;
  }
  const result = await db.query<{ thumbnail_url: string | null }>(
    `SELECT thumbnail_url FROM brand_sticker_sheets WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (result.rowCount === 0) {
    res.status(404).json({ error: "Sheet not found" });
    return;
  }
  const { thumbnail_url } = result.rows[0];
  if (!thumbnail_url) {
    res.status(404).json({ error: "No thumbnail available" });
    return;
  }

  const privateObjectDir = process.env.PRIVATE_OBJECT_DIR;
  if (!privateObjectDir || !thumbnail_url.startsWith("/objects/")) {
    res.status(404).json({ error: "Thumbnail not available" });
    return;
  }

  let entityDir = privateObjectDir;
  if (!entityDir.endsWith("/")) entityDir = `${entityDir}/`;
  const entityId = thumbnail_url.replace(/^\/objects\//, "");
  const fullPath = `${entityDir}${entityId}`;
  const parts = fullPath.startsWith("/") ? fullPath.slice(1).split("/") : fullPath.split("/");
  const bucketName = parts[0];
  const objectName = parts.slice(1).join("/");

  try {
    const bucket = objectStorageClient.bucket(bucketName);
    const file = bucket.file(objectName);
    const [exists] = await file.exists();
    if (!exists) {
      res.status(404).json({ error: "Thumbnail not found in storage" });
      return;
    }
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "private, max-age=3600");
    file.createReadStream().pipe(res);
  } catch (err) {
    logger.error({ err, sheetId: id }, "Failed to stream sticker sheet thumbnail");
    res.status(500).json({ error: "Failed to retrieve thumbnail" });
  }
});

export default router;
