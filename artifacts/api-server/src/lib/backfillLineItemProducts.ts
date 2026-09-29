import { db } from "./db";
import { logger } from "./logger";

/**
 * Idempotent startup backfill: link legacy order line items to their catalog
 * product and fill in the missing product image.
 *
 * Historically the external order ingest inserted `order_line_items` without
 * `image_url` and left `product_id` null whenever the incoming identifier
 * didn't resolve by sku/id, so the Florist Console showed a placeholder box
 * and no recipe. This backfill repairs existing rows:
 *
 *   1. `product_id` — for rows with a null product link, match a workspace
 *      product by exact sku first, then by exact (case-insensitive) name.
 *      Ambiguous name matches resolve deterministically to the lowest id.
 *   2. `image_url` — for linked rows missing an image, copy the product's
 *      `main_image_url`.
 *
 * Safe to run on every startup — already-fixed rows are excluded by the WHERE
 * clauses, and each step is best-effort (failures are logged, not thrown).
 */
export async function backfillLineItemProducts(): Promise<void> {
  // Step 1a: link by exact sku (workspace-scoped, non-archived products).
  let linkedBySku = 0;
  try {
    const res = await db.query(
      `UPDATE order_line_items oli
          SET product_id = sub.pid
         FROM (
           SELECT oli.id AS line_item_id, min(p.id) AS pid
             FROM order_line_items oli
             JOIN orders o ON o.id = oli.order_id
             JOIN products p
               ON p.workspace_owner_id = o.workspace_owner_id
              AND p.is_archived = false
              AND p.sku IS NOT NULL
              AND p.sku = oli.sku
            WHERE oli.product_id IS NULL
              AND oli.sku IS NOT NULL
            GROUP BY oli.id
         ) sub
        WHERE oli.id = sub.line_item_id`,
    );
    linkedBySku = res.rowCount ?? 0;
  } catch (err) {
    logger.error({ err }, "Line-item product backfill: sku linking failed");
  }

  // Step 1b: link remaining rows by exact (case-insensitive) product name.
  let linkedByName = 0;
  try {
    const res = await db.query(
      `UPDATE order_line_items oli
          SET product_id = sub.pid
         FROM (
           SELECT oli.id AS line_item_id, min(p.id) AS pid
             FROM order_line_items oli
             JOIN orders o ON o.id = oli.order_id
             JOIN products p
               ON p.workspace_owner_id = o.workspace_owner_id
              AND p.is_archived = false
              AND lower(p.name) = lower(oli.name)
            WHERE oli.product_id IS NULL
            GROUP BY oli.id
         ) sub
        WHERE oli.id = sub.line_item_id`,
    );
    linkedByName = res.rowCount ?? 0;
  } catch (err) {
    logger.error({ err }, "Line-item product backfill: name linking failed");
  }

  // Step 2: fill missing images from the linked product's main image.
  let imagesFilled = 0;
  try {
    const res = await db.query(
      `UPDATE order_line_items oli
          SET image_url = p.main_image_url
         FROM products p
        WHERE p.id = oli.product_id
          AND oli.image_url IS NULL
          AND p.main_image_url IS NOT NULL`,
    );
    imagesFilled = res.rowCount ?? 0;
  } catch (err) {
    logger.error({ err }, "Line-item product backfill: image fill failed");
  }

  if (linkedBySku > 0 || linkedByName > 0 || imagesFilled > 0) {
    logger.info(
      { linkedBySku, linkedByName, imagesFilled },
      "Line-item product backfill: complete",
    );
  }
}
