import { db } from "./db";
import { logger } from "./logger";
import {
  fireCatalogAttributeWebhook,
  fireCatalogDataWebhook,
  type CatalogAttributeType,
  type CatalogWebhookEvent,
} from "./catalogWebhook";
import { fireDeliveryConfigUpdated } from "./deliveryWebhook";
import { buildPublicObjectUrl } from "./objectStorage";

/**
 * Manual snapshot publish.
 *
 * Pushes a full current snapshot of all workspace data to the connected
 * website using the existing webhook dispatch system. Each area is published
 * independently — a failure in one area does not abort the others — and every
 * area returns a structured result so the caller can surface per-area
 * success/failure to the UI.
 *
 * "Success" here means the data was read and the relevant webhook events were
 * dispatched (delivery rows enqueued) without throwing. The underlying webhook
 * delivery (the outbound HTTP POST + retries) remains fire-and-forget, exactly
 * as it is for the automatic webhooks fired on every individual change.
 */

export type PublishArea = "delivery" | "catalog_attributes" | "products";

export type PublishAreaResult = {
  area: PublishArea;
  success: boolean;
  /** Number of records (or snapshots) dispatched for this area. */
  count: number;
  error?: string;
};

export type PublishSnapshotResult = {
  success: boolean;
  results: PublishAreaResult[];
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Publish a full delivery-config snapshot (countries / cities / slots / fees).
 * Reuses `fireDeliveryConfigUpdated`, which builds and dispatches the complete
 * snapshot in one call.
 */
export async function publishDelivery(ownerId: string): Promise<PublishAreaResult> {
  try {
    await fireDeliveryConfigUpdated(ownerId);
    return { area: "delivery", success: true, count: 1 };
  } catch (err) {
    logger.error({ err, ownerId }, "publishSnapshot: delivery publish failed");
    return { area: "delivery", success: false, count: 0, error: errorMessage(err) };
  }
}

const ATTRIBUTE_TYPES: Array<{
  type: CatalogAttributeType;
  table: string;
  suffix: string;
}> = [
  { type: "occasions", table: "occasions", suffix: "occasion" },
  { type: "catalog_categories", table: "catalog_categories", suffix: "catalog_category" },
  { type: "catalog_brands", table: "catalog_brands", suffix: "catalog_brand" },
  { type: "recipients", table: "recipients", suffix: "recipient" },
];

type AttributeDbRow = {
  id: number;
  workspace_owner_id: string;
  name: string;
  slug: string;
  description: string | null;
  image_url: string | null;
  image_public_path: string | null;
  sort_order: number;
  is_active: boolean;
  is_featured: boolean | null;
  created_at: Date;
  updated_at: Date;
};

/**
 * Attribute types that carry an `is_featured` mega-menu flag and the flat
 * legacy `image` field. Occasions and catalog categories support it; brands and
 * recipients do not. Mirrors `supportsFeatured` in `routes/catalogAttributes.ts`
 * so both publish paths emit identical shapes.
 */
function supportsFeatured(type: CatalogAttributeType): boolean {
  return type === "occasions" || type === "catalog_categories";
}

/**
 * Build the webhook attribute payload in the exact same shape produced by the
 * per-change attribute routes (snake_case fields + `image_public_url`, plus the
 * `featured` / `image` mega-menu fields for occasions and catalog categories).
 */
function buildAttributePayload(
  type: CatalogAttributeType,
  row: AttributeDbRow,
): Record<string, unknown> {
  const apiRow = {
    id: row.id,
    workspace_owner_id: row.workspace_owner_id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    image_url: row.image_url,
    image_public_url: buildPublicObjectUrl(row.image_public_path ?? null),
    sort_order: row.sort_order,
    is_active: row.is_active,
    is_featured: row.is_featured ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (supportsFeatured(type)) {
    return {
      ...apiRow,
      featured: Boolean(apiRow.is_featured),
      image: apiRow.image_url ?? null,
    };
  }
  return apiRow;
}

/**
 * Publish a full snapshot of all catalog attributes (occasions, categories,
 * brands, recipients) by firing an `.updated` event per record.
 */
export async function publishCatalogAttributes(ownerId: string): Promise<PublishAreaResult> {
  try {
    let count = 0;
    for (const { type, table, suffix } of ATTRIBUTE_TYPES) {
      // `is_featured` only exists on the occasions table; select a constant
      // `false` for the other attribute types so the payload shape is uniform.
      const featuredSelect = table === "occasions" ? "is_featured" : "false AS is_featured";
      const result = await db.query<AttributeDbRow>(
        `SELECT id, workspace_owner_id, name, slug, description, image_url,
                image_public_path, sort_order, is_active, ${featuredSelect},
                created_at, updated_at
           FROM ${table}
          WHERE workspace_owner_id = $1
          ORDER BY sort_order, name`,
        [ownerId],
      );
      const event = `catalog_attribute.${suffix}.updated` as CatalogWebhookEvent;
      for (const row of result.rows) {
        await fireCatalogAttributeWebhook(event, type, buildAttributePayload(type, row), ownerId);
        count += 1;
      }
    }
    return { area: "catalog_attributes", success: true, count };
  } catch (err) {
    logger.error({ err, ownerId }, "publishSnapshot: catalog-attributes publish failed");
    return { area: "catalog_attributes", success: false, count: 0, error: errorMessage(err) };
  }
}

/**
 * Publish a full snapshot of all products by firing a `product.updated` event
 * per product, followed by a single `catalog.products.changed` event so
 * subscribers know to reconcile the whole catalog.
 */
export async function publishProducts(ownerId: string): Promise<PublishAreaResult> {
  try {
    const result = await db.query<Record<string, unknown>>(
      `SELECT * FROM products WHERE workspace_owner_id = $1 ORDER BY id`,
      [ownerId],
    );
    for (const product of result.rows) {
      await fireCatalogDataWebhook("product.updated", ownerId, { product });
    }
    await fireCatalogDataWebhook("catalog.products.changed", ownerId, {
      action: "republished",
      count: result.rows.length,
    });
    return { area: "products", success: true, count: result.rows.length };
  } catch (err) {
    logger.error({ err, ownerId }, "publishSnapshot: products publish failed");
    return { area: "products", success: false, count: 0, error: errorMessage(err) };
  }
}

/**
 * Publish a full snapshot of every area. Areas run sequentially; each is
 * independently guarded so a failure in one does not prevent the others from
 * publishing. `success` is true only when every area succeeded.
 */
export async function publishAllSnapshot(ownerId: string): Promise<PublishSnapshotResult> {
  const results: PublishAreaResult[] = [
    await publishDelivery(ownerId),
    await publishCatalogAttributes(ownerId),
    await publishProducts(ownerId),
  ];
  return { success: results.every((r) => r.success), results };
}
