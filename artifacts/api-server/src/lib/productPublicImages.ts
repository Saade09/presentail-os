import { createHash } from "crypto";
import { db } from "./db";
import { objectStorageService } from "./objectStorage";
import { logger } from "./logger";
import { generateProductImageDerivatives } from "./imageResize";

const RETRY_DELAY_MS = 5 * 60 * 1000;
let backfillRetryTimer: NodeJS.Timeout | null = null;

function scheduleBackfillRetry(): void {
  if (backfillRetryTimer) return;
  backfillRetryTimer = setTimeout(() => {
    backfillRetryTimer = null;
    void backfillProductPublicImages();
  }, RETRY_DELAY_MS);
  backfillRetryTimer.unref?.();
}

function versionForSource(source: string): string {
  return createHash("sha1").update(source).digest("hex").slice(0, 16);
}

async function generatePublicDerivatives(
  sourceUrl: string,
  baseKey: string,
  ownerId: string,
): Promise<{ display: string; thumbnail: string } | null> {
  // External/legacy URLs are deliberately not fetched server-side. They
  // remain the API fallback and avoid turning product saves into SSRF risks.
  if (!sourceUrl.startsWith("/objects/")) return null;

  const sourceFile = await objectStorageService.getObjectEntityFile(sourceUrl);
  const [sourceBytes] = await sourceFile.download();
  const derivatives = await generateProductImageDerivatives(sourceBytes);
  const version = versionForSource(sourceUrl);
  const display = `${baseKey}-display-${version}.webp`;
  const thumbnail = `${baseKey}-thumbnail-${version}.webp`;

  await Promise.all([
    objectStorageService.savePublicObject(display, derivatives.display, "image/webp", ownerId),
    objectStorageService.savePublicObject(thumbnail, derivatives.thumbnail, "image/webp", ownerId),
  ]);
  return { display, thumbnail };
}

async function attempt<T>(
  operation: () => Promise<T>,
  context: Record<string, unknown>,
): Promise<T | null> {
  try {
    return await operation();
  } catch (err) {
    logger.warn({ err, ...context }, "Product image operation failed; will retry");
    return null;
  }
}

/**
 * Mirrors product originals into the public bucket and creates bounded WebP
 * derivatives. Every operation is best-effort so product CRUD never depends
 * on storage or image processing being available.
 */
export async function syncProductPublicImages(
  id: number,
  mainImageUrl: string | null,
  additionalImageUrls: string[],
  ownerId: string,
): Promise<void> {
  let shouldRetry = false;
  const mainPublicKey = mainImageUrl
    ? await attempt(
        () => objectStorageService.copyPrivateObjectToPublic(mainImageUrl, `products/${id}/main`, ownerId),
        { id, image: "main", operation: "copy" },
      )
    : null;
  const mainDerivatives = mainImageUrl
    ? await attempt(
        () => generatePublicDerivatives(mainImageUrl, `products/${id}/main`, ownerId),
        { id, image: "main", operation: "derivative" },
      )
    : null;
  if (
    mainImageUrl?.startsWith("/objects/") &&
    (!mainPublicKey || !mainDerivatives)
  ) {
    shouldRetry = true;
  }

  // Keep arrays positionally aligned with the source array. PostgreSQL arrays
  // represent failed/missing entries as NULL; API mapping turns those into
  // null URLs and source fallbacks where appropriate.
  const additionalPublicKeys: Array<string | null> = [];
  const additionalDisplays: Array<string | null> = [];
  const additionalThumbnails: Array<string | null> = [];
  for (let i = 0; i < additionalImageUrls.length; i++) {
    const url = additionalImageUrls[i];
    if (!url) {
      additionalPublicKeys.push(null);
      additionalDisplays.push(null);
      additionalThumbnails.push(null);
      continue;
    }
    const key = await attempt(
      () => objectStorageService.copyPrivateObjectToPublic(url, `products/${id}/additional-${i}`, ownerId),
      { id, image: `additional-${i}`, operation: "copy" },
    );
    const derivatives = await attempt(
      () => generatePublicDerivatives(url, `products/${id}/additional-${i}`, ownerId),
      { id, image: `additional-${i}`, operation: "derivative" },
    );
    additionalPublicKeys.push(key);
    additionalDisplays.push(derivatives?.display ?? null);
    additionalThumbnails.push(derivatives?.thumbnail ?? null);
    if (url.startsWith("/objects/") && (!key || !derivatives)) {
      shouldRetry = true;
    }
  }

  try {
    await db.query(
      `UPDATE products
          SET image_public_path = $1,
              additional_image_public_paths = $2,
              image_display_public_path = $3,
              image_thumbnail_public_path = $4,
              additional_image_display_public_paths = $5,
              additional_image_thumbnail_public_paths = $6
        WHERE id = $7
          AND workspace_owner_id = $8
          AND main_image_url IS NOT DISTINCT FROM $9
          AND additional_image_urls IS NOT DISTINCT FROM $10::text[]`,
      [
        mainPublicKey,
        additionalPublicKeys,
        mainDerivatives?.display ?? null,
        mainDerivatives?.thumbnail ?? null,
        additionalDisplays,
        additionalThumbnails,
        id,
        ownerId,
        mainImageUrl,
        additionalImageUrls,
      ],
    );
  } catch (err) {
    logger.warn({ err, id }, "Failed to persist product public image paths; will retry");
    shouldRetry = true;
  }
  if (shouldRetry) {
    scheduleBackfillRetry();
  }
}

type BackfillRow = {
  id: number;
  workspace_owner_id: string;
  main_image_url: string | null;
  additional_image_urls: string[] | null;
  image_display_public_path: string | null;
  image_thumbnail_public_path: string | null;
  additional_image_display_public_paths: Array<string | null> | null;
  additional_image_thumbnail_public_paths: Array<string | null> | null;
};

/**
 * Idempotent backfill for original public copies and optimized derivatives.
 * Failed processing/storage leaves fields empty, so the row is selected again
 * on the next startup and safely retried.
 */
export async function backfillProductPublicImages(): Promise<void> {
  let rows: BackfillRow[];
  try {
    rows = (
      await db.query<BackfillRow>(
        `SELECT id, workspace_owner_id, main_image_url, additional_image_urls,
                image_display_public_path, image_thumbnail_public_path,
                additional_image_display_public_paths,
                additional_image_thumbnail_public_paths
           FROM products
          WHERE (main_image_url LIKE '/objects/%' AND (
                   image_public_path IS NULL
                OR image_display_public_path IS NULL
                OR image_thumbnail_public_path IS NULL
              ))
             OR EXISTS (
                  SELECT 1
                    FROM generate_subscripts(additional_image_urls, 1) AS i
                   WHERE additional_image_urls[i] LIKE '/objects/%'
                     AND (
                          additional_image_public_paths[i] IS NULL
                       OR additional_image_display_public_paths[i] IS NULL
                       OR additional_image_thumbnail_public_paths[i] IS NULL
                     )
                )`,
      )
    ).rows;
  } catch (err) {
    logger.error({ err }, "Product public-image backfill: query failed");
    return;
  }

  if (rows.length === 0) return;

  logger.info({ count: rows.length }, "Product public-image backfill: starting");
  for (const row of rows) {
    await syncProductPublicImages(
      row.id,
      row.main_image_url,
      Array.isArray(row.additional_image_urls) ? row.additional_image_urls : [],
      row.workspace_owner_id,
    );
  }
  logger.info({ total: rows.length }, "Product public-image backfill: complete");
}