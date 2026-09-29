import { Router } from "express";
import { Readable } from "stream";
import { db } from "../lib/db";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { COOKIE_NAME, verifyWorkspaceToken } from "../lib/imageSign";

const router = Router();
const objectStorageService = new ObjectStorageService();
const PUBLIC_UNVERSIONED_CACHE_TTL_SECONDS = 86_400;
const PUBLIC_UNVERSIONED_STALE_TTL_SECONDS = 604_800;
const PUBLIC_IMMUTABLE_CACHE_TTL_SECONDS = 31_536_000;

/**
 * Resolve the workspace owner ID from the signed image cookie.
 * Returns the owner ID string, or null if the cookie is absent / invalid.
 */
function resolveOwner(req: Parameters<Parameters<typeof router.get>[1]>[0]): string | null {
  const cookies = (req as { cookies?: Record<string, string> }).cookies;
  const raw = cookies?.[COOKIE_NAME];
  return verifyWorkspaceToken(raw);
}

/**
 * GET /api/brands/:id/logo
 * Serve the primary brand logo.
 * Requires a valid workspace image cookie (set by POST /api/workspace/image-token).
 */
router.get("/brands/:id/logo", async (req, res) => {
  const ownerId = resolveOwner(req);
  if (!ownerId) {
    res.status(401).json({ error: "Missing or invalid image token" });
    return;
  }

  const id = parseInt(String(req.params.id), 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid brand id" });
    return;
  }

  const result = await db.query<{ logo_data: Buffer; logo_mime: string }>(
    `SELECT bl.logo_data, bl.logo_mime
       FROM brand_logos bl
       JOIN brands b ON b.id = bl.brand_id
      WHERE bl.brand_id = $1
        AND b.workspace_owner_id = $2
        AND bl.deleted_at IS NULL
      ORDER BY bl.sort_order ASC, bl.created_at ASC
      LIMIT 1`,
    [id, ownerId],
  );

  if (result.rowCount === 0) {
    res.status(404).json({ error: "No logo found" });
    return;
  }

  const { logo_data, logo_mime } = result.rows[0];
  res.setHeader("Content-Type", logo_mime);
  res.setHeader("Cache-Control", "private, max-age=60");
  res.send(logo_data);
});

/**
 * GET /api/brands/:id/logos/:logoId/image
 * Serve a specific brand logo by ID.
 * Requires a valid workspace image cookie.
 */
router.get("/brands/:id/logos/:logoId/image", async (req, res) => {
  const ownerId = resolveOwner(req);
  if (!ownerId) {
    res.status(401).json({ error: "Missing or invalid image token" });
    return;
  }

  const brandId = parseInt(String(req.params.id), 10);
  const logoId = parseInt(req.params.logoId, 10);
  if (Number.isNaN(brandId) || Number.isNaN(logoId)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const result = await db.query<{ logo_data: Buffer; logo_mime: string }>(
    `SELECT bl.logo_data, bl.logo_mime
       FROM brand_logos bl
       JOIN brands b ON b.id = bl.brand_id
      WHERE bl.id = $1
        AND bl.brand_id = $2
        AND b.workspace_owner_id = $3
        AND bl.deleted_at IS NULL`,
    [logoId, brandId, ownerId],
  );

  if (result.rowCount === 0) {
    res.status(404).json({ error: "Logo not found" });
    return;
  }

  const { logo_data, logo_mime } = result.rows[0];
  res.setHeader("Content-Type", logo_mime);
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.send(logo_data);
});

/**
 * GET /api/brands/:id/card-message
 * Serve the brand card message image.
 * Requires a valid workspace image cookie.
 */
router.get("/brands/:id/card-message", async (req, res) => {
  const ownerId = resolveOwner(req);
  if (!ownerId) {
    res.status(401).json({ error: "Missing or invalid image token" });
    return;
  }

  const id = parseInt(String(req.params.id), 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid brand id" });
    return;
  }

  const result = await db.query<{ card_message_data: Buffer; card_message_mime: string }>(
    `SELECT card_message_data, card_message_mime
       FROM brands
      WHERE id = $1
        AND workspace_owner_id = $2`,
    [id, ownerId],
  );

  if (result.rowCount === 0 || !result.rows[0].card_message_data) {
    res.status(404).json({ error: "No card message found" });
    return;
  }

  const { card_message_data, card_message_mime } = result.rows[0];
  res.setHeader("Content-Type", card_message_mime);
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.send(card_message_data);
});

/**
 * GET /api/brands/:id/cover-photos/:photoId/image
 * Serve a brand cover photo.
 * Requires a valid workspace image cookie.
 */
router.get("/brands/:id/cover-photos/:photoId/image", async (req, res) => {
  const ownerId = resolveOwner(req);
  if (!ownerId) {
    res.status(401).json({ error: "Missing or invalid image token" });
    return;
  }

  const brandId = parseInt(String(req.params.id), 10);
  const photoId = parseInt(req.params.photoId, 10);
  if (Number.isNaN(brandId) || Number.isNaN(photoId)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const result = await db.query<{ photo_data: Buffer; photo_mime: string }>(
    `SELECT bcp.photo_data, bcp.photo_mime
       FROM brand_cover_photos bcp
       JOIN brands b ON b.id = bcp.brand_id
      WHERE bcp.id = $1
        AND bcp.brand_id = $2
        AND b.workspace_owner_id = $3`,
    [photoId, brandId, ownerId],
  );

  if (result.rowCount === 0) {
    res.status(404).json({ error: "Cover photo not found" });
    return;
  }

  const { photo_data, photo_mime } = result.rows[0];
  res.setHeader("Content-Type", photo_mime);
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.send(photo_data);
});

/**
 * GET /api/channels/:id/logo
 * Serve the stored channel logo image.
 * Requires a valid workspace image cookie.
 */
router.get("/channels/:id/logo", async (req, res) => {
  const ownerId = resolveOwner(req);
  if (!ownerId) {
    res.status(401).json({ error: "Missing or invalid image token" });
    return;
  }

  const id = parseInt(String(req.params.id), 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid channel id" });
    return;
  }

  const result = await db.query<{ logo_data: Buffer; logo_mime_type: string }>(
    `SELECT logo_data, logo_mime_type
       FROM channels
      WHERE id = $1
        AND workspace_owner_id = $2
        AND logo_data IS NOT NULL`,
    [id, ownerId],
  );

  if ((result.rowCount ?? 0) === 0) {
    res.status(404).json({ error: "No logo found" });
    return;
  }

  const { logo_data, logo_mime_type } = result.rows[0];
  res.setHeader("Content-Type", logo_mime_type);
  res.setHeader("Cache-Control", "private, max-age=60");
  res.send(logo_data);
});

/**
 * GET /api/stickers/:id/thumbnail
 * Serve the extracted thumbnail PNG for a sticker.
 * Requires a valid workspace image cookie.
 * Returns 404 if no thumbnail has been generated (frontend falls back to emoji).
 */
router.get("/stickers/:id/thumbnail", async (req, res) => {
  const ownerId = resolveOwner(req);
  if (!ownerId) {
    res.status(401).json({ error: "Missing or invalid image token" });
    return;
  }

  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid sticker id" });
    return;
  }

  const result = await db.query<{ thumbnail_data: Buffer; thumbnail_mime: string }>(
    `SELECT thumbnail_data, thumbnail_mime
       FROM stickers
      WHERE id = $1
        AND workspace_owner_id = $2`,
    [id, ownerId],
  );

  if (result.rowCount === 0) {
    res.status(404).json({ error: "Sticker not found" });
    return;
  }

  const { thumbnail_data, thumbnail_mime } = result.rows[0];
  if (!thumbnail_data || !thumbnail_mime) {
    res.status(404).json({ error: "No thumbnail available" });
    return;
  }

  res.setHeader("Content-Type", thumbnail_mime);
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.send(thumbnail_data);
});

/**
 * GET /api/storage/objects/*
 *
 * Serve private objects from object storage.
 * Requires a valid workspace image cookie.
 * Workspace isolation is enforced by verifying that the first path segment
 * (which is always the workspace owner's Clerk user ID) matches the owner ID
 * embedded in the signed cookie.
 */
router.get("/storage/objects/*path", async (req, res) => {
  const ownerId = resolveOwner(req);
  if (!ownerId) {
    res.status(401).json({ error: "Missing or invalid image token" });
    return;
  }

  try {
    const raw = req.params.path;
    const wildcardPath = Array.isArray(raw) ? raw.join("/") : raw;

    const firstSegment = wildcardPath.split("/")[0];
    if (firstSegment !== ownerId) {
      res.status(403).json({ error: "Access denied" });
      return;
    }

    const objectPath = `/objects/${wildcardPath}`;
    const objectFile = await objectStorageService.getObjectEntityFile(objectPath);

    const response = await objectStorageService.downloadObject(objectFile);

    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));

    if (response.body) {
      const nodeStream = Readable.fromWeb(
        response.body as unknown as Parameters<typeof Readable.fromWeb>[0],
      );
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "Object not found" });
      return;
    }
    req.log.error({ err: error }, "Failed to serve object from storage");
    res.status(500).json({ error: "Failed to serve object" });
  }
});

/**
 * GET /api/storage/public-objects/*
 *
 * Serve public assets from PUBLIC_OBJECT_SEARCH_PATHS.
 * These are unconditionally public — no authentication or ACL checks — so
 * browsers can load product/catalog images directly via <img src=...>.
 *
 * Mounted here (in publicImagesRouter) rather than in storageRouter because
 * storageRouter is mounted after usersRouter, whose top-level
 * router.use(requireAuth) would reject unauthenticated requests with 401
 * before they reach the handler. publicImagesRouter is mounted before all
 * requireAuth routers.
 *
 * A permissive CORS header is set on this path only so cross-origin fetch()
 * and canvas reads work too, without loosening the global CORS policy.
 */
router.get("/storage/public-objects/*filePath", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");
  res.setHeader("Timing-Allow-Origin", "*");

  try {
    const raw = req.params.filePath;
    const filePath = Array.isArray(raw) ? raw.join("/") : raw;
    const file = await objectStorageService.searchPublicObject(filePath);
    if (!file) {
      res.status(404).json({ error: "File not found" });
      return;
    }

    const isVersionedProductDerivative =
      /^products\/.+-(?:display|thumbnail)-[a-f0-9]{16}\.webp$/i.test(filePath);
    const response = await objectStorageService.downloadObject(
      file,
      isVersionedProductDerivative
        ? PUBLIC_IMMUTABLE_CACHE_TTL_SECONDS
        : PUBLIC_UNVERSIONED_CACHE_TTL_SECONDS,
    );
    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));
    if (isVersionedProductDerivative) {
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    } else {
      res.setHeader(
        "Cache-Control",
        `public, max-age=${PUBLIC_UNVERSIONED_CACHE_TTL_SECONDS}, stale-while-revalidate=${PUBLIC_UNVERSIONED_STALE_TTL_SECONDS}`,
      );
    }

    if (response.body) {
      const nodeStream = Readable.fromWeb(
        response.body as unknown as Parameters<typeof Readable.fromWeb>[0],
      );
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    req.log.error({ err: error }, "Error serving public object");
    res.status(500).json({ error: "Failed to serve public object" });
  }
});

export default router;
