import { db } from "./db";
import { objectStorageService } from "./objectStorage";
import { logger } from "./logger";

/**
 * Returns true when the stored image URL points at a private object-storage
 * path that can be mirrored to the public bucket. Base item images imported
 * from XLSX may be external https URLs — those are already publicly loadable
 * and are intentionally not mirrored.
 */
function isPrivateObjectPath(imageUrl: string | null): imageUrl is string {
  return typeof imageUrl === "string" && imageUrl.startsWith("/objects/");
}

/**
 * Mirrors a base item's private image into the public bucket and persists the
 * resulting public key onto the row, so the public website can render it via
 * an auth-free URL (see `buildPublicObjectUrl`).
 *
 * - The image is copied under the stable key `base-items/<id>`.
 * - When `imageUrl` is null (or an external URL that is not a private
 *   `/objects/` path) the stored public key is cleared to null.
 *
 * All failures are logged and swallowed so they never break base item CRUD.
 * Idempotent — re-running overwrites the public destination.
 */
export async function syncBaseItemPublicImage(
  id: number,
  imageUrl: string | null,
  ownerId: string,
): Promise<void> {
  try {
    let publicKey: string | null = null;
    if (isPrivateObjectPath(imageUrl)) {
      publicKey = await objectStorageService.copyPrivateObjectToPublic(
        imageUrl,
        `base-items/${id}`,
        ownerId,
      );
    }

    await db.query(
      `UPDATE base_items
          SET image_public_path = $1
        WHERE id = $2 AND workspace_owner_id = $3`,
      [publicKey, id, ownerId],
    );
  } catch (err) {
    logger.error({ err, id }, "Failed to sync base item public image");
  }
}

type BackfillRow = {
  id: number;
  workspace_owner_id: string;
  image_url: string | null;
};

/**
 * One-time idempotent backfill: for every base item whose private image lacks
 * a public copy, mirror it into the public bucket and persist the key. Safe to
 * run on every startup — already-backfilled rows are skipped by the WHERE
 * clause, and individual failures are logged without aborting the batch.
 */
export async function backfillBaseItemPublicImages(): Promise<void> {
  let rows: BackfillRow[];
  try {
    rows = (
      await db.query<BackfillRow>(
        `SELECT id, workspace_owner_id, image_url
           FROM base_items
          WHERE image_url LIKE '/objects/%'
            AND image_public_path IS NULL`,
      )
    ).rows;
  } catch (err) {
    logger.error({ err }, "Base item public-image backfill: query failed");
    return;
  }

  if (rows.length === 0) return;

  logger.info({ count: rows.length }, "Base item public-image backfill: starting");

  for (const row of rows) {
    await syncBaseItemPublicImage(row.id, row.image_url, row.workspace_owner_id);
  }

  logger.info({ total: rows.length }, "Base item public-image backfill: complete");
}
