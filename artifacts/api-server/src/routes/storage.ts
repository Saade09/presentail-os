import { randomUUID } from "node:crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod/v4";
import {
  RequestUploadUrlBody,
  RequestUploadUrlResponse,
} from "@workspace/api-zod";
import { ObjectStorageService, buildPublicObjectUrl } from "../lib/objectStorage";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

const UPLOAD_MAX_SIZE_BYTES = 100 * 1024 * 1024;
const ALLOWED_UPLOAD_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "application/pdf",
]);

/**
 * POST /storage/uploads/request-url
 *
 * Request a presigned URL for file upload.
 * The client sends JSON metadata (name, size, contentType) — NOT the file.
 * Then uploads the file directly to the returned presigned URL.
 * Requires Clerk authentication and workspace membership.
 */
router.post("/storage/uploads/request-url", requireAuth, resolveWorkspace, async (req: Request, res: Response) => {
  const parsed = RequestUploadUrlBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Missing or invalid required fields" });
    return;
  }

  const { name, size, contentType } = parsed.data;

  if (size <= 0 || size > UPLOAD_MAX_SIZE_BYTES) {
    res.status(400).json({ error: `File size must be between 1 byte and ${UPLOAD_MAX_SIZE_BYTES / (1024 * 1024)} MB` });
    return;
  }

  if (!ALLOWED_UPLOAD_CONTENT_TYPES.has(contentType)) {
    res.status(400).json({ error: "Unsupported content type. Allowed types: JPEG, PNG, WebP, GIF, PDF" });
    return;
  }

  try {
    const wreq = workspace(req);

    const { signedUrl, requiredHeaders } = await objectStorageService.getObjectEntityUploadURL(
      wreq.workspaceOwnerId,
      contentType,
      size,
    );
    const objectPath = objectStorageService.normalizeObjectEntityPath(signedUrl);

    res.json(
      RequestUploadUrlResponse.parse({
        uploadURL: signedUrl,
        objectPath,
        requiredUploadHeaders: requiredHeaders,
        metadata: { name, size, contentType },
      }),
    );
  } catch (error) {
    req.log.error({ err: error }, "Error generating upload URL");
    res.status(500).json({ error: "Failed to generate upload URL" });
  }
});

/**
 * POST /storage/uploads/make-public
 *
 * Promote a just-uploaded PRIVATE object (`/objects/<owner>/uploads/<id>`) into
 * the auth-free public bucket and return an absolute, online URL the storefront
 * (and the dashboard preview) can load directly. Used by features like homepage
 * banners that must persist a public online link instead of a private object
 * path that only resolves through the cookie-gated storage route.
 *
 * SECURITY: the object's owner segment must match the caller's workspace, so a
 * member cannot publish another tenant's private object.
 */
router.post(
  "/storage/uploads/make-public",
  requireAuth,
  resolveWorkspace,
  async (req: Request, res: Response) => {
    const parsed = z
      .object({ objectPath: z.string().min(1) })
      .safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Missing or invalid objectPath" });
      return;
    }

    const { objectPath } = parsed.data;
    if (!objectPath.startsWith("/objects/")) {
      res.status(400).json({ error: "objectPath must be a private object path" });
      return;
    }

    const wreq = workspace(req);
    // Presigned uploads always land at `/objects/<workspaceOwnerId>/uploads/<id>`
    // (see getObjectEntityUploadURL). Constrain promotion to exactly that prefix
    // so a member can only publish their own workspace's freshly uploaded files,
    // not arbitrary private objects belonging to other tenants or other features.
    const expectedPrefix = `/objects/${wreq.workspaceOwnerId}/uploads/`;
    if (!objectPath.startsWith(expectedPrefix)) {
      res.status(403).json({ error: "Object cannot be published from this workspace" });
      return;
    }

    try {
      const baseKey = `uploads/public/${randomUUID()}`;
      const publicKey = await objectStorageService.copyPrivateObjectToPublic(
        objectPath,
        baseKey,
        wreq.workspaceOwnerId,
      );
      res.json({ url: buildPublicObjectUrl(publicKey), publicPath: publicKey });
    } catch (error) {
      req.log.error({ err: error }, "Error promoting object to public bucket");
      res.status(500).json({ error: "Failed to publish object" });
    }
  },
);

// GET /storage/public-objects/* is intentionally handled by publicImagesRouter
// (artifacts/api-server/src/routes/publicImages.ts), mounted before this router
// (and before all requireAuth routers) in routes/index.ts. Mounting it here
// would place it after usersRouter's top-level requireAuth, which rejects
// unauthenticated requests with 401 before they reach the handler.
//
// GET /storage/objects/* is likewise handled by publicImagesRouter. That route
// validates the Clerk user ID prefix for tenant isolation and serves the object
// without a session cookie.

export default router;
