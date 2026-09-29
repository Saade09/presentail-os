import { Router } from "express";
import { db } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";
import { findCountryByCode } from "../lib/defaults";
import { ObjectStorageService } from "../lib/objectStorage";
import { setObjectAclPolicy } from "../lib/objectAcl";

const router = Router();

router.use(requireAuth, resolveWorkspace);

const objectStorage = new ObjectStorageService();

function ownerOnly(role: string): boolean {
  return role === "owner";
}

/**
 * PUT /country-flags/:code
 * Body: { object_path: string }  // e.g. "/objects/<workspaceOwnerId>/uploads/abc.svg"
 *
 * Records (or replaces) a per-workspace flag override for the given country.
 * The uploaded object is flipped to public-read ACL so the storefront can
 * fetch it without auth.
 */
router.put("/country-flags/:code", async (req, res) => {
  const wreq = workspace(req);
  if (!ownerOnly(wreq.workspaceRole)) {
    res.status(403).json({ error: "owner_only" });
    return;
  }

  const code = String(req.params.code || "").trim().toLowerCase();
  const entry = findCountryByCode(code);
  if (!entry) {
    res.status(400).json({ error: "Unknown country code" });
    return;
  }

  const objectPath =
    typeof req.body?.object_path === "string" ? req.body.object_path.trim() : "";
  if (!objectPath.startsWith(`/objects/${wreq.workspaceOwnerId}/`)) {
    res.status(400).json({
      error: "object_path must be a workspace-owned /objects/<ownerId>/... path",
    });
    return;
  }

  // Make the uploaded object publicly readable (storefront surfaces it
  // without authentication via the bundled `/api/storage/objects/...` route).
  // Also enforce that the uploaded blob is actually an image; the client-side
  // accept= attribute is not sufficient on its own.
  try {
    const file = await objectStorage.getObjectEntityFile(objectPath);
    const [metadata] = await file.getMetadata();
    const contentType = String(metadata?.contentType ?? "").toLowerCase();
    const allowed = new Set([
      "image/svg+xml",
      "image/png",
      "image/jpeg",
      "image/webp",
    ]);
    if (!allowed.has(contentType)) {
      res.status(400).json({
        error: "object must be an image (svg, png, jpeg, or webp)",
      });
      return;
    }
    await setObjectAclPolicy(file, {
      owner: wreq.workspaceOwnerId,
      visibility: "public",
    });
  } catch (err) {
    req.log.error({ err, objectPath }, "Failed to set ACL on flag override");
    res.status(400).json({ error: "Object not found or inaccessible" });
    return;
  }

  const imageUrl = `/api/storage${objectPath}`;
  await db.query(
    `INSERT INTO country_flag_overrides (workspace_owner_id, country_code, image_url)
     VALUES ($1, $2, $3)
     ON CONFLICT (workspace_owner_id, country_code) DO UPDATE
       SET image_url = EXCLUDED.image_url,
           updated_at = now()`,
    [wreq.workspaceOwnerId, entry.code, imageUrl],
  );

  res.json({ country_code: entry.code, image_url: imageUrl });
});

/**
 * DELETE /country-flags/:code
 * Removes a per-workspace override; the bundled default flag will be used
 * again. Owner-only.
 */
router.delete("/country-flags/:code", async (req, res) => {
  const wreq = workspace(req);
  if (!ownerOnly(wreq.workspaceRole)) {
    res.status(403).json({ error: "owner_only" });
    return;
  }

  const code = String(req.params.code || "").trim().toLowerCase();
  const entry = findCountryByCode(code);
  if (!entry) {
    res.status(400).json({ error: "Unknown country code" });
    return;
  }

  await db.query(
    `DELETE FROM country_flag_overrides
      WHERE workspace_owner_id = $1 AND country_code = $2`,
    [wreq.workspaceOwnerId, entry.code],
  );

  res.json({ ok: true });
});

export default router;
