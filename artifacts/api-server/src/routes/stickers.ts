import { Router } from "express";
import multer from "multer";
import { and, asc, eq } from "drizzle-orm";
import { drizzleDb } from "../lib/drizzle.js";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace, type WorkspaceRequest } from "../lib/workspace";
import { extractStickerThumbnail } from "../lib/extractStickerThumbnail";
import { runPdfToImageInWorker } from "../lib/pdfToImagePool";
import { logger } from "../lib/logger";
import { stickers, brands } from "@workspace/db/schema";

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

/**
 * Per-sticker thumbnail regeneration rate limit.
 * Prevents repeated expensive PDF processing by the same workspace.
 */
const REGEN_COOLDOWN_MS = 60_000;
const regenCooldowns = new Map<string, number>();

function checkRegenRateLimit(workspaceOwnerId: string, stickerId: number): boolean {
  const key = `${workspaceOwnerId}:${stickerId}`;
  const now = Date.now();
  const last = regenCooldowns.get(key) ?? 0;
  if (now - last < REGEN_COOLDOWN_MS) return false;
  regenCooldowns.set(key, now);
  return true;
}

/** Returns true if the buffer starts with magic bytes for PDF or common image formats. */
function isAcceptedFileType(buf: Buffer): boolean {
  if (buf.length < 4) return false;
  if (buf.slice(0, 4).equals(Buffer.from("%PDF"))) return true;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  if (buf.length >= 12 && buf.slice(8, 12).toString("ascii") === "WEBP") return true;
  if (buf.slice(0, 3).toString("ascii") === "GIF") return true;
  return false;
}

// ─── Authenticated routes ─────────────────────────────────────────────────────
// The public GET /stickers/:id/thumbnail image route is handled by publicImagesRouter
// mounted before this router in routes/index.ts.

router.use(requireAuth, resolveWorkspace);

/** Returns true if the user may upload stickers (owner, designer, brands.manage, or stickers.upload). */
function canUpload(wreq: WorkspaceRequest): boolean {
  return (
    wreq.workspaceActualRole === "owner" ||
    wreq.workspaceActualRole === "designer" ||
    (wreq.allowedPages?.includes("brands.manage") ?? false) ||
    (wreq.allowedPages?.includes("stickers.upload") ?? false)
  );
}

/** Returns true if the user may rename or delete stickers (owner, designer, or brands.manage). */
function canManage(wreq: WorkspaceRequest): boolean {
  return (
    wreq.workspaceActualRole === "owner" ||
    wreq.workspaceActualRole === "designer" ||
    (wreq.allowedPages?.includes("brands.manage") ?? false)
  );
}

/**
 * GET /api/stickers
 * List all uploaded stickers for the workspace. All roles.
 * Optional ?brand_id= filter.
 */
router.get("/stickers", async (req, res) => {
  const wreq = workspace(req);
  const brandIdParam = req.query.brand_id;
  const brandId = brandIdParam ? parseInt(String(brandIdParam), 10) : null;

  if (brandIdParam !== undefined && (brandId === null || Number.isNaN(brandId))) {
    res.status(400).json({ error: "Invalid brand_id" });
    return;
  }

  const conditions = [eq(stickers.workspaceOwnerId, wreq.workspaceOwnerId)];
  if (brandId !== null) {
    conditions.push(eq(stickers.brandId, brandId));
  }

  const rows = await drizzleDb
    .select({
      id: stickers.id,
      name: stickers.name,
      file_name: stickers.fileName,
      created_at: stickers.createdAt,
      brand_id: stickers.brandId,
      brand_name: brands.name,
    })
    .from(stickers)
    .leftJoin(brands, eq(brands.id, stickers.brandId))
    .where(and(...conditions))
    .orderBy(asc(stickers.createdAt));

  res.json({ stickers: rows });
});

/**
 * GET /api/stickers/:id/file
 * Download the original PDF for a custom sticker. All authenticated workspace members.
 */
router.get("/stickers/:id/file", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid sticker id" });
    return;
  }

  const rows = await drizzleDb
    .select({ pdfData: stickers.pdfData, fileName: stickers.fileName })
    .from(stickers)
    .where(and(eq(stickers.id, id), eq(stickers.workspaceOwnerId, wreq.workspaceOwnerId)));

  if (rows.length === 0) {
    res.status(404).json({ error: "Sticker not found" });
    return;
  }

  const { pdfData, fileName } = rows[0];
  const safeName = fileName.replace(/[^\w\s.\-]/g, "_");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
  res.send(pdfData);
});

/**
 * POST /api/stickers  multipart: pdf (file), name (field)
 * Upload a new sticker PDF. Owner or Designer only.
 */
router.post("/stickers", upload.single("pdf"), async (req, res) => {
  const wreq = workspace(req);
  if (!canUpload(wreq)) {
    res.status(403).json({ error: "Insufficient permissions to upload stickers" });
    return;
  }

  const file = (req as unknown as { file?: Express.Multer.File }).file;
  if (!file) {
    res.status(400).json({ error: "Missing 'pdf' file field" });
    return;
  }
  if (!isAcceptedFileType(file.buffer)) {
    res.status(400).json({ error: "Uploaded file must be a PDF or image (PNG, JPEG, WebP, GIF)" });
    return;
  }

  const name = String(req.body?.name ?? "").trim().slice(0, 200);
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  const brandIdRaw = req.body?.brand_id;
  if (!brandIdRaw) {
    res.status(400).json({ error: "brand_id is required" });
    return;
  }
  const brandId = parseInt(String(brandIdRaw), 10);
  if (Number.isNaN(brandId)) {
    res.status(400).json({ error: "Invalid brand_id" });
    return;
  }

  // Verify the brand belongs to this workspace.
  const brandRows = await drizzleDb
    .select({ id: brands.id })
    .from(brands)
    .where(and(eq(brands.id, brandId), eq(brands.workspaceOwnerId, wreq.workspaceOwnerId)));
  if (brandRows.length === 0) {
    res.status(400).json({ error: "Brand not found" });
    return;
  }

  const fileName = file.originalname.slice(0, 255) || `${name}.pdf`;

  const [inserted] = await drizzleDb
    .insert(stickers)
    .values({
      workspaceOwnerId: wreq.workspaceOwnerId,
      name,
      fileName,
      pdfData: file.buffer,
      brandId,
    })
    .returning({
      id: stickers.id,
      name: stickers.name,
      file_name: stickers.fileName,
      created_at: stickers.createdAt,
      brand_id: stickers.brandId,
    });

  const sticker = { ...inserted, brand_name: null };

  // Attempt thumbnail extraction inline — never fail the upload on error.
  let thumbnailGenerated = false;
  try {
    const imageBuffer = await runPdfToImageInWorker(file.buffer);
    if (imageBuffer) {
      const thumbnail = await extractStickerThumbnail(imageBuffer, {
        workspaceOwnerId: wreq.workspaceOwnerId,
      });
      if (thumbnail) {
        await drizzleDb
          .update(stickers)
          .set({ thumbnailData: thumbnail, thumbnailMime: "image/png" })
          .where(eq(stickers.id, sticker.id));
        thumbnailGenerated = true;
        logger.info({ stickerId: sticker.id }, "sticker thumbnail extracted and saved");
      } else {
        logger.info({ stickerId: sticker.id }, "sticker thumbnail extraction returned null — using placeholder");
      }
    } else {
      logger.info({ stickerId: sticker.id }, "pdfToImage returned null — using placeholder");
    }
  } catch (err) {
    logger.warn({ err, stickerId: sticker.id }, "thumbnail extraction failed — upload still succeeded");
  }

  res.status(201).json({ sticker, thumbnail_generated: thumbnailGenerated });
});

/**
 * GET /api/stickers/:id/thumbnail
 * Serve the extracted thumbnail PNG for a custom sticker.
 * Returns 404 if no thumbnail has been generated (frontend falls back to emoji).
 */
router.get("/stickers/:id/thumbnail", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid sticker id" });
    return;
  }

  const rows = await drizzleDb
    .select({ thumbnailData: stickers.thumbnailData, thumbnailMime: stickers.thumbnailMime })
    .from(stickers)
    .where(and(eq(stickers.id, id), eq(stickers.workspaceOwnerId, wreq.workspaceOwnerId)));

  if (rows.length === 0) {
    res.status(404).json({ error: "Sticker not found" });
    return;
  }

  const { thumbnailData, thumbnailMime } = rows[0];
  if (!thumbnailData || !thumbnailMime) {
    res.status(404).json({ error: "No thumbnail available" });
    return;
  }

  res.setHeader("Content-Type", thumbnailMime);
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send(thumbnailData);
});

/**
 * PATCH /api/stickers/:id  { name?, brand_id? }
 * Rename or move a sticker to a different brand. Owner or Designer only.
 */
router.patch("/stickers/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!canManage(wreq)) {
    res.status(403).json({ error: "Insufficient permissions to update stickers" });
    return;
  }

  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid sticker id" });
    return;
  }

  const body = req.body ?? {};
  const hasName = "name" in body;
  const hasBrandId = "brand_id" in body;

  if (!hasName && !hasBrandId) {
    res.status(400).json({ error: "name or brand_id is required" });
    return;
  }

  const updates: Partial<typeof stickers.$inferInsert> = {};

  if (hasName) {
    const newName = String(body.name ?? "").trim().slice(0, 200);
    if (!newName) {
      res.status(400).json({ error: "name cannot be empty" });
      return;
    }
    updates.name = newName;
  }

  if (hasBrandId) {
    const rawBrandId = body.brand_id;
    let resolvedBrandId: number | null = null;

    if (rawBrandId !== null && rawBrandId !== undefined) {
      const brandId = parseInt(String(rawBrandId), 10);
      if (Number.isNaN(brandId)) {
        res.status(400).json({ error: "Invalid brand_id" });
        return;
      }
      const brandRows = await drizzleDb
        .select({ id: brands.id })
        .from(brands)
        .where(and(eq(brands.id, brandId), eq(brands.workspaceOwnerId, wreq.workspaceOwnerId)));
      if (brandRows.length === 0) {
        res.status(404).json({ error: "Brand not found" });
        return;
      }
      resolvedBrandId = brandId;
    }
    updates.brandId = resolvedBrandId;
  }

  const updated = await drizzleDb
    .update(stickers)
    .set(updates)
    .where(and(eq(stickers.id, id), eq(stickers.workspaceOwnerId, wreq.workspaceOwnerId)))
    .returning({
      id: stickers.id,
      name: stickers.name,
      file_name: stickers.fileName,
      created_at: stickers.createdAt,
      brand_id: stickers.brandId,
    });

  if (updated.length === 0) {
    res.status(404).json({ error: "Sticker not found" });
    return;
  }

  res.json({ sticker: updated[0] });
});

/**
 * POST /api/stickers/:id/thumbnail
 * Re-run thumbnail extraction for an existing sticker. Owner or Designer only.
 */
router.post("/stickers/:id/thumbnail", async (req, res) => {
  const wreq = workspace(req);
  if (!canManage(wreq)) {
    res.status(403).json({ error: "Insufficient permissions to regenerate thumbnails" });
    return;
  }

  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid sticker id" });
    return;
  }

  if (!checkRegenRateLimit(wreq.workspaceOwnerId, id)) {
    res.status(429).json({ error: "Thumbnail regeneration requested too frequently. Please wait before retrying." });
    return;
  }

  const rows = await drizzleDb
    .select({ pdfData: stickers.pdfData })
    .from(stickers)
    .where(and(eq(stickers.id, id), eq(stickers.workspaceOwnerId, wreq.workspaceOwnerId)));

  if (rows.length === 0) {
    res.status(404).json({ error: "Sticker not found" });
    return;
  }

  const { pdfData } = rows[0];

  try {
    const imageBuffer = await runPdfToImageInWorker(pdfData);
    if (!imageBuffer) {
      res.json({ ok: true, thumbnail_generated: false });
      return;
    }

    const thumbnail = await extractStickerThumbnail(imageBuffer, {
      workspaceOwnerId: wreq.workspaceOwnerId,
    });
    if (!thumbnail) {
      res.json({ ok: true, thumbnail_generated: false });
      return;
    }

    await drizzleDb
      .update(stickers)
      .set({ thumbnailData: thumbnail, thumbnailMime: "image/png" })
      .where(eq(stickers.id, id));

    logger.info({ stickerId: id }, "sticker thumbnail regenerated and saved");
    res.json({ ok: true, thumbnail_generated: true });
  } catch (err) {
    logger.warn({ err, stickerId: id }, "thumbnail regeneration failed");
    res.status(500).json({ error: "Thumbnail extraction failed" });
  }
});

/**
 * DELETE /api/stickers/:id
 * Delete a sticker. Owner or Designer only.
 */
router.delete("/stickers/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!canManage(wreq)) {
    res.status(403).json({ error: "Insufficient permissions to delete stickers" });
    return;
  }

  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid sticker id" });
    return;
  }

  const deleted = await drizzleDb
    .delete(stickers)
    .where(and(eq(stickers.id, id), eq(stickers.workspaceOwnerId, wreq.workspaceOwnerId)))
    .returning({ id: stickers.id });

  if (deleted.length === 0) {
    res.status(404).json({ error: "Sticker not found" });
    return;
  }

  res.json({ ok: true });
});

export default router;
