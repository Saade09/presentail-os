import { Router, type Request, type Response } from "express";
import multer from "multer";
import { imageSize } from "image-size";
import sharp from "sharp";
import { z } from "zod";
import { db } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";

const router = Router();

const channelRowSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    has_cover_photo: z.boolean(),
    cover_photo_width: z.number().int().nullable(),
    cover_photo_height: z.number().int().nullable(),
    has_logo: z.boolean().optional(),
    created_at: z.union([z.string(), z.date()]),
  })
  .passthrough();

const channelsResponseSchema = z.object({
  channels: z.array(channelRowSchema),
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

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// ─── Authenticated routes ─────────────────────────────────────────────────────
// The public GET /channels/:id/logo image route is handled by publicImagesRouter
// mounted before this router in routes/index.ts.

router.use(requireAuth, resolveWorkspace);

const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp"] as const;

type ChannelRow = {
  id: number;
  name: string;
  has_cover_photo: boolean;
  cover_photo_width: number | null;
  cover_photo_height: number | null;
  has_logo: boolean;
  created_at: string;
};

/**
 * Parse a raw value as a strictly positive integer.
 * Returns the integer, or `null` if the raw value is absent / empty string.
 * Returns `NaN` if the value is present but not a valid positive integer
 * (callers should treat NaN as a 400 error).
 */
function parsePositiveInt(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return NaN;
  return n;
}

type DimensionResult =
  | { ok: true; width: number; height: number }
  | { ok: false; error: string };

/**
 * Validate cover-photo dimensions.
 * When `hasCoverPhoto` is true both width and height must be provided as
 * strictly positive integers.
 */
function validateDimensions(body: Record<string, unknown>): DimensionResult {
  const width = parsePositiveInt(body.cover_photo_width);
  const height = parsePositiveInt(body.cover_photo_height);

  if (width === null) {
    return { ok: false, error: "cover_photo_width is required and must be a positive integer" };
  }
  if (Number.isNaN(width)) {
    return { ok: false, error: "cover_photo_width must be a positive integer" };
  }
  if (height === null) {
    return { ok: false, error: "cover_photo_height is required and must be a positive integer" };
  }
  if (Number.isNaN(height)) {
    return { ok: false, error: "cover_photo_height must be a positive integer" };
  }

  return { ok: true, width, height };
}

const MAX_LOGO_PX = 500;

/**
 * Validate a logo file: must be square and an allowed MIME type.
 * Size is not checked here — oversized logos are auto-resized by resizeLogo().
 * Returns { ok: true, mime } or { ok: false, error }.
 */
type LogoValidationResult =
  | { ok: true; mime: string }
  | { ok: false; error: string };

function validateLogo(file: Express.Multer.File): LogoValidationResult {
  const mime = file.mimetype as string;
  if (!ALLOWED_MIME.includes(mime as typeof ALLOWED_MIME[number])) {
    return { ok: false, error: "Logo must be a JPEG, PNG, or WebP image" };
  }

  let dims: { width?: number; height?: number };
  try {
    dims = imageSize(file.buffer);
  } catch {
    return { ok: false, error: "Could not read image dimensions" };
  }

  const w = dims.width ?? 0;
  const h = dims.height ?? 0;

  if (w === 0) {
    return { ok: false, error: "Could not read image dimensions" };
  }
  if (w !== h) {
    return { ok: false, error: "Logo must be square (width must equal height)" };
  }

  return { ok: true, mime };
}

/**
 * Resize a logo buffer to at most MAX_LOGO_PX × MAX_LOGO_PX if needed.
 * Returns the original buffer unchanged when it already fits.
 * Output is always PNG so the mime type is normalised.
 */
async function resizeLogo(buffer: Buffer, mime: string): Promise<{ buffer: Buffer; mime: string }> {
  const dims = imageSize(buffer);
  const w = dims.width ?? 0;
  if (w <= MAX_LOGO_PX) return { buffer, mime };
  const resized = await sharp(buffer)
    .resize(MAX_LOGO_PX, MAX_LOGO_PX, { fit: "fill" })
    .png()
    .toBuffer();
  return { buffer: resized, mime: "image/png" };
}

/**
 * GET /api/channels
 * List all channels for the workspace.
 * Owners always get the full list.
 * Members with a custom role only see channels granted to that role.
 * Members with no custom role see no channels.
 */
router.get("/channels", async (req, res) => {
  const wreq = workspace(req);

  if (wreq.workspaceRole === "owner" || wreq.allowedPages?.includes("channels.manage")) {
    const result = await db.query<ChannelRow>(
      `SELECT id, name, has_cover_photo, cover_photo_width, cover_photo_height,
              (logo_data IS NOT NULL) AS has_logo, created_at
         FROM channels
        WHERE workspace_owner_id = $1
        ORDER BY created_at ASC`,
      [wreq.workspaceOwnerId],
    );
    sendValidated(
      req,
      res,
      channelsResponseSchema,
      { channels: result.rows },
      "GET /channels",
    );
    return;
  }

  if (!wreq.customRoleId) {
    sendValidated(
      req,
      res,
      channelsResponseSchema,
      { channels: [] },
      "GET /channels",
    );
    return;
  }

  const result = await db.query<ChannelRow>(
    `SELECT c.id, c.name, c.has_cover_photo, c.cover_photo_width, c.cover_photo_height,
            (c.logo_data IS NOT NULL) AS has_logo,
            c.created_at
       FROM channels c
       JOIN role_channel_access rca ON rca.channel_id = c.id AND rca.role_id = $1
      WHERE c.workspace_owner_id = $2
      ORDER BY c.created_at ASC`,
    [wreq.customRoleId, wreq.workspaceOwnerId],
  );
  sendValidated(
    req,
    res,
    channelsResponseSchema,
    { channels: result.rows },
    "GET /channels",
  );
});

/**
 * GET /api/channels/:id/logo
 * Serve the stored channel logo image.
 */
router.get("/channels/:id/logo", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(String(req.params.id), 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid channel id" });
    return;
  }

  const result = await db.query<{ logo_data: Buffer; logo_mime_type: string }>(
    `SELECT logo_data, logo_mime_type
       FROM channels
      WHERE id = $1 AND workspace_owner_id = $2 AND logo_data IS NOT NULL`,
    [id, wreq.workspaceOwnerId],
  );

  if ((result.rowCount ?? 0) === 0) {
    res.status(404).json({ error: "No logo found" });
    return;
  }

  const { logo_data, logo_mime_type } = result.rows[0];
  res.setHeader("Content-Type", logo_mime_type);
  res.setHeader("Cache-Control", "public, max-age=60");
  res.send(logo_data);
});

/**
 * POST /api/channels  multipart: name, has_cover_photo, cover_photo_width?, cover_photo_height?, logo?
 * Create a new channel. Owner only.
 * When has_cover_photo is true, both cover_photo_width and cover_photo_height
 * must be supplied as strictly positive integers.
 * Logo is optional: square, at most 500×500, JPEG/PNG/WebP.
 */
router.post("/channels", upload.single("logo"), async (req, res) => {
  const wreq = workspace(req);
  const canCreate =
    wreq.workspaceActualRole === "owner" ||
    wreq.allowedPages?.includes("channels.manage") ||
    wreq.allowedPages?.includes("channels.create");
  if (!canCreate) {
    res.status(403).json({ error: "Only owners or members with the Manage Channels permission can manage channels" });
    return;
  }

  const name = String(req.body?.name ?? "").trim().slice(0, 200);
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  const hasCoverPhoto =
    req.body?.has_cover_photo !== false && req.body?.has_cover_photo !== "false";
  let width: number | null = null;
  let height: number | null = null;

  if (hasCoverPhoto) {
    const dims = validateDimensions(req.body ?? {});
    if (!dims.ok) {
      res.status(400).json({ error: dims.error });
      return;
    }
    width = dims.width;
    height = dims.height;
  }

  const file = (req as unknown as { file?: Express.Multer.File }).file;
  let logoData: Buffer | null = null;
  let logoMimeType: string | null = null;

  if (file) {
    const canManageLogo =
      wreq.workspaceActualRole === "owner" ||
      wreq.allowedPages?.includes("channels.manage") ||
      wreq.allowedPages?.includes("channels.manage-logo");
    if (!canManageLogo) {
      res.status(403).json({ error: "Only owners or members with the Manage Channel Logos permission can upload channel logos" });
      return;
    }
    const logoResult = validateLogo(file);
    if (!logoResult.ok) {
      res.status(400).json({ error: logoResult.error });
      return;
    }
    const resized = await resizeLogo(file.buffer, logoResult.mime);
    logoData = resized.buffer;
    logoMimeType = resized.mime;
  }

  const existing = await db.query(
    `SELECT id FROM channels WHERE workspace_owner_id = $1 AND lower(name) = lower($2)`,
    [wreq.workspaceOwnerId, name],
  );
  if ((existing.rowCount ?? 0) > 0) {
    res.status(409).json({ error: "A channel with this name already exists" });
    return;
  }

  const result = await db.query<ChannelRow>(
    `INSERT INTO channels (workspace_owner_id, name, has_cover_photo, cover_photo_width, cover_photo_height, logo_data, logo_mime_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, name, has_cover_photo, cover_photo_width, cover_photo_height,
               (logo_data IS NOT NULL) AS has_logo, created_at`,
    [wreq.workspaceOwnerId, name, hasCoverPhoto, width, height, logoData, logoMimeType],
  );
  res.status(201).json({ channel: result.rows[0] });
});

/**
 * PUT /api/channels/:id  multipart: name, has_cover_photo, cover_photo_width?, cover_photo_height?, logo?
 * Update a channel. Owner only.
 * When has_cover_photo is true, both cover_photo_width and cover_photo_height
 * must be supplied as strictly positive integers.
 * Logo is optional: square, at most 500×500, JPEG/PNG/WebP.
 */
router.put("/channels/:id", upload.single("logo"), async (req, res) => {
  const wreq = workspace(req);
  const canEdit =
    wreq.workspaceActualRole === "owner" ||
    wreq.allowedPages?.includes("channels.manage") ||
    wreq.allowedPages?.includes("channels.edit");
  if (!canEdit) {
    res.status(403).json({ error: "Only owners or members with the Manage Channels permission can manage channels" });
    return;
  }

  const id = parseInt(String(req.params.id), 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid channel id" });
    return;
  }

  const existing = await db.query(
    `SELECT id FROM channels WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if ((existing.rowCount ?? 0) === 0) {
    res.status(404).json({ error: "Channel not found" });
    return;
  }

  const name = String(req.body?.name ?? "").trim().slice(0, 200);
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  const hasCoverPhoto =
    req.body?.has_cover_photo !== false && req.body?.has_cover_photo !== "false";
  let width: number | null = null;
  let height: number | null = null;

  if (hasCoverPhoto) {
    const dims = validateDimensions(req.body ?? {});
    if (!dims.ok) {
      res.status(400).json({ error: dims.error });
      return;
    }
    width = dims.width;
    height = dims.height;
  }

  const file = (req as unknown as { file?: Express.Multer.File }).file;
  let logoData: Buffer | null | undefined = undefined;
  let logoMimeType: string | null | undefined = undefined;

  if (file) {
    const canManageLogo =
      wreq.workspaceActualRole === "owner" ||
      wreq.allowedPages?.includes("channels.manage") ||
      wreq.allowedPages?.includes("channels.manage-logo");
    if (!canManageLogo) {
      res.status(403).json({ error: "Only owners or members with the Manage Channel Logos permission can upload channel logos" });
      return;
    }
    const logoResult = validateLogo(file);
    if (!logoResult.ok) {
      res.status(400).json({ error: logoResult.error });
      return;
    }
    const resized = await resizeLogo(file.buffer, logoResult.mime);
    logoData = resized.buffer;
    logoMimeType = resized.mime;
  } else if (req.body?.remove_logo === "true") {
    logoData = null;
    logoMimeType = null;
  }

  const conflict = await db.query(
    `SELECT id FROM channels WHERE workspace_owner_id = $1 AND lower(name) = lower($2) AND id != $3`,
    [wreq.workspaceOwnerId, name, id],
  );
  if ((conflict.rowCount ?? 0) > 0) {
    res.status(409).json({ error: "A channel with this name already exists" });
    return;
  }

  let result;
  if (logoData !== undefined) {
    result = await db.query<ChannelRow>(
      `UPDATE channels
          SET name = $1, has_cover_photo = $2, cover_photo_width = $3, cover_photo_height = $4,
              logo_data = $5, logo_mime_type = $6
        WHERE id = $7 AND workspace_owner_id = $8
        RETURNING id, name, has_cover_photo, cover_photo_width, cover_photo_height,
                  (logo_data IS NOT NULL) AS has_logo, created_at`,
      [name, hasCoverPhoto, width, height, logoData, logoMimeType, id, wreq.workspaceOwnerId],
    );
  } else {
    result = await db.query<ChannelRow>(
      `UPDATE channels
          SET name = $1, has_cover_photo = $2, cover_photo_width = $3, cover_photo_height = $4
        WHERE id = $5 AND workspace_owner_id = $6
        RETURNING id, name, has_cover_photo, cover_photo_width, cover_photo_height,
                  (logo_data IS NOT NULL) AS has_logo, created_at`,
      [name, hasCoverPhoto, width, height, id, wreq.workspaceOwnerId],
    );
  }

  res.json({ channel: result.rows[0] });
});

/**
 * DELETE /api/channels/:id
 * Delete a channel. Owner only.
 */
router.delete("/channels/:id", async (req, res) => {
  const wreq = workspace(req);
  const canDelete =
    wreq.workspaceActualRole === "owner" ||
    wreq.allowedPages?.includes("channels.manage") ||
    wreq.allowedPages?.includes("channels.delete");
  if (!canDelete) {
    res.status(403).json({ error: "Only owners or members with the Manage Channels permission can manage channels" });
    return;
  }

  const id = parseInt(String(req.params.id), 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid channel id" });
    return;
  }

  const result = await db.query(
    `DELETE FROM channels WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if ((result.rowCount ?? 0) === 0) {
    res.status(404).json({ error: "Channel not found" });
    return;
  }
  res.json({ ok: true });
});

export default router;
