import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { drizzleDb } from "./drizzle.js";
import { occasions, catalogCategories, catalogBrands, recipients } from "@workspace/db";
import { objectStorageService } from "./objectStorage";
import { logger } from "./logger";

// Each catalog-attribute table that carries a public, auth-free image copy.
// `keyPrefix` namespaces the object key in the public bucket (matching the
// create/update sync in routes/catalogAttributes.ts).
const BACKFILL_TABLES: { keyPrefix: string; table: PgTable }[] = [
  { keyPrefix: "occasions", table: occasions },
  { keyPrefix: "catalog_categories", table: catalogCategories },
  { keyPrefix: "catalog_brands", table: catalogBrands },
  { keyPrefix: "recipients", table: recipients },
];

/**
 * One-time idempotent backfill for a single catalog-attribute table: for every
 * row that has a private `image_url` but no public copy yet
 * (`image_public_path` IS NULL), copy the image into the public bucket and
 * persist the resulting public key. Safe to run on every startup —
 * already-backfilled rows are skipped by the WHERE clause, and individual
 * failures are logged without aborting the batch.
 */
async function backfillTable(keyPrefix: string, table: PgTable): Promise<void> {
  // All catalog-attribute tables share the same column names; `as any` is
  // required because TypeScript cannot resolve column access on PgTable.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const t = table as any;
  const idCol = t.id as PgColumn;
  const imageUrlCol = t.imageUrl as PgColumn;
  const imagePublicPathCol = t.imagePublicPath as PgColumn;
  const ownerCol = t.workspaceOwnerId as PgColumn;

  let rows: { id: number; imageUrl: string | null; workspaceOwnerId: string }[];
  try {
    rows = (await drizzleDb
      .select({ id: idCol, imageUrl: imageUrlCol, workspaceOwnerId: ownerCol })
      .from(table)
      .where(
        and(isNotNull(imageUrlCol), isNull(imagePublicPathCol)),
      )) as { id: number; imageUrl: string | null; workspaceOwnerId: string }[];
  } catch (err) {
    logger.error({ err, keyPrefix }, "Catalog attribute public-image backfill: query failed");
    return;
  }

  if (rows.length === 0) return;

  logger.info({ count: rows.length, keyPrefix }, "Catalog attribute public-image backfill: starting");

  let succeeded = 0;
  for (const row of rows) {
    if (!row.imageUrl) continue;
    try {
      const publicKey = await objectStorageService.copyPrivateObjectToPublic(
        row.imageUrl,
        `${keyPrefix}/${row.id}`,
        row.workspaceOwnerId,
      );
      await drizzleDb
        .update(table)
        .set({ imagePublicPath: publicKey })
        .where(eq(idCol, row.id));
      succeeded += 1;
    } catch (err) {
      logger.error({ err, keyPrefix, id: row.id }, "Catalog attribute public-image backfill: row failed");
    }
  }

  logger.info(
    { succeeded, total: rows.length, keyPrefix },
    "Catalog attribute public-image backfill: complete",
  );
}

/**
 * Backfills the public, auth-free image copy for every catalog-attribute type
 * (occasions, catalog categories, catalog brands, recipients). Each table is
 * processed independently so a failure in one does not block the others.
 */
export async function backfillOccasionPublicImages(): Promise<void> {
  for (const { keyPrefix, table } of BACKFILL_TABLES) {
    await backfillTable(keyPrefix, table);
  }
}
