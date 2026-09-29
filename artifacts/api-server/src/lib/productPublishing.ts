import { db } from "./db";
import { logger } from "./logger";
import { fireProductWebhook, type ProductWebhookEvent } from "./productWebhook";

type PublishFields = {
  public_slug?: string | null;
  public_title?: string | null;
  short_description?: string | null;
  long_description?: string | null;
  seo_title?: string | null;
  seo_description?: string | null;
  og_image_url?: string | null;
  featured?: boolean;
  sort_order?: number | null;
  badges?: unknown;
  extra_fields?: unknown;
  price_override?: string | null;
  sale_price_override?: string | null;
  currency_override?: string | null;
};

type PublicationRow = {
  id: number;
  product_id: number;
  channel_id: number;
  publication_status: string;
  is_visible: boolean;
  public_slug: string | null;
  brand_id?: number | null;
};

async function getPublication(productId: number, channelId: number): Promise<PublicationRow | null> {
  const result = await db.query<PublicationRow>(
    `SELECT pp.id, pp.product_id, pp.channel_id, pp.publication_status, pp.is_visible, pp.public_slug,
            b.id AS brand_id
       FROM product_publications pp
       LEFT JOIN products p ON p.id = pp.product_id
       LEFT JOIN brands b ON lower(b.name) = lower(p.brand) AND b.workspace_owner_id = p.workspace_owner_id
      WHERE pp.product_id = $1 AND pp.channel_id = $2`,
    [productId, channelId],
  );
  return result.rows[0] ?? null;
}

async function writeSyncLog(
  productId: number,
  channelId: number,
  eventType: string,
  status: string,
  message?: string,
  changedFields?: string[],
): Promise<void> {
  await db.query(
    `INSERT INTO product_sync_logs (product_id, channel_id, event_type, changed_fields, status, message)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [productId, channelId, eventType, changedFields ? JSON.stringify(changedFields) : null, status, message ?? null],
  );
}

async function getChannelWorkspace(channelId: number): Promise<string | null> {
  const r = await db.query<{ workspace_owner_id: string }>(
    `SELECT workspace_owner_id FROM publishing_channels WHERE id = $1`,
    [channelId],
  );
  return r.rows[0]?.workspace_owner_id ?? null;
}

function buildApiUrl(productId: number, channelSlug: string): string {
  return `/api/catalog/v1/products/${productId}?channel=${channelSlug}`;
}

async function getChannelSlug(channelId: number): Promise<string> {
  const r = await db.query<{ slug: string }>(
    `SELECT slug FROM publishing_channels WHERE id = $1`,
    [channelId],
  );
  return r.rows[0]?.slug ?? String(channelId);
}

async function dispatchProductEvent(
  productId: number,
  channelId: number,
  workspaceOwnerId: string,
  event: ProductWebhookEvent,
  changedFields: string[] | null,
  brandId: number | null,
  publicSlug: string | null,
): Promise<void> {
  try {
    const channelSlug = await getChannelSlug(channelId);
    await fireProductWebhook(channelId, workspaceOwnerId, event, {
      id: `evt_${Date.now()}_${productId}`,
      event,
      created_at: new Date().toISOString(),
      brand_id: brandId,
      channel_id: channelId,
      product_id: productId,
      product_slug: publicSlug,
      changed_fields: changedFields,
      api_url: buildApiUrl(productId, channelSlug),
    });
  } catch (err) {
    logger.error({ err, productId, channelId, event }, "productPublishing: webhook dispatch failed (non-fatal)");
  }
}

export async function publishProduct(
  productId: number,
  channelId: number,
  fields: PublishFields,
  userId: string,
): Promise<void> {
  const existing = await getPublication(productId, channelId);
  const workspaceOwnerId = await getChannelWorkspace(channelId);
  if (!workspaceOwnerId) {
    logger.warn({ productId, channelId }, "publishProduct: channel not found");
    return;
  }

  const fieldMap: Record<string, string> = {
    public_slug: "public_slug",
    public_title: "public_title",
    short_description: "short_description",
    long_description: "long_description",
    seo_title: "seo_title",
    seo_description: "seo_description",
    og_image_url: "og_image_url",
    featured: "featured",
    sort_order: "sort_order",
    price_override: "price_override",
    sale_price_override: "sale_price_override",
    currency_override: "currency_override",
  };

  // Build a single UPSERT that applies override fields on both INSERT and conflict-UPDATE.
  const insertCols = [
    "product_id", "channel_id", "workspace_owner_id",
    "publication_status", "is_visible", "published_at", "sync_status", "last_synced_at",
  ];
  const insertPhs = ["$1", "$2", "$3", "'published'", "true", "now()", "'synced'", "now()"];
  const upsertParams: unknown[] = [productId, channelId, workspaceOwnerId];
  const overrideSets: string[] = [];

  for (const [key, col] of Object.entries(fieldMap)) {
    const val = (fields as Record<string, unknown>)[key];
    if (val !== undefined) {
      upsertParams.push(val);
      const ph = `$${upsertParams.length}`;
      insertCols.push(col);
      insertPhs.push(ph);
      overrideSets.push(`${col} = ${ph}`);
    }
  }
  if (fields.badges !== undefined) {
    upsertParams.push(JSON.stringify(fields.badges));
    const ph = `$${upsertParams.length}`;
    insertCols.push("badges");
    insertPhs.push(ph);
    overrideSets.push(`badges = ${ph}`);
  }
  if (fields.extra_fields !== undefined) {
    upsertParams.push(JSON.stringify(fields.extra_fields));
    const ph = `$${upsertParams.length}`;
    insertCols.push("extra_fields");
    insertPhs.push(ph);
    overrideSets.push(`extra_fields = ${ph}`);
  }

  const upsertUpdateSets = [
    "publication_status = 'published'",
    "is_visible = true",
    "published_at = COALESCE(product_publications.published_at, now())",
    "sync_status = 'synced'",
    "last_synced_at = now()",
    "updated_at = now()",
    ...overrideSets,
  ];

  await db.query(
    `INSERT INTO product_publications (${insertCols.join(", ")})
     VALUES (${insertPhs.join(", ")})
     ON CONFLICT (product_id, channel_id) DO UPDATE SET ${upsertUpdateSets.join(", ")}`,
    upsertParams,
  );

  await writeSyncLog(productId, channelId, "published", "ok", `Published by ${userId}`);
  void dispatchProductEvent(productId, channelId, workspaceOwnerId, "product.published", null, null, fields.public_slug ?? null);
}

export async function unpublishProduct(
  productId: number,
  channelId: number,
  userId: string,
): Promise<void> {
  const workspaceOwnerId = await getChannelWorkspace(channelId);
  if (!workspaceOwnerId) return;

  await db.query(
    `UPDATE product_publications SET publication_status = 'unpublished', is_visible = false, unpublished_at = now(), updated_at = now()
     WHERE product_id = $1 AND channel_id = $2`,
    [productId, channelId],
  );
  await writeSyncLog(productId, channelId, "unpublished", "ok", `Unpublished by ${userId}`);
  void dispatchProductEvent(productId, channelId, workspaceOwnerId, "product.unpublished", null, null, null);
}

export async function hideProduct(
  productId: number,
  channelId: number,
  userId: string,
): Promise<void> {
  const workspaceOwnerId = await getChannelWorkspace(channelId);
  if (!workspaceOwnerId) return;

  await db.query(
    `UPDATE product_publications SET is_visible = false, updated_at = now()
     WHERE product_id = $1 AND channel_id = $2`,
    [productId, channelId],
  );
  await writeSyncLog(productId, channelId, "hidden", "ok", `Hidden by ${userId}`);
  void dispatchProductEvent(productId, channelId, workspaceOwnerId, "product.hidden", null, null, null);
}

export async function unhideProduct(
  productId: number,
  channelId: number,
  userId: string,
): Promise<void> {
  const workspaceOwnerId = await getChannelWorkspace(channelId);
  if (!workspaceOwnerId) return;

  await db.query(
    `UPDATE product_publications
        SET is_visible = true, publication_status = 'published', updated_at = now()
      WHERE product_id = $1 AND channel_id = $2`,
    [productId, channelId],
  );
  await writeSyncLog(productId, channelId, "unhidden", "ok", `Unhidden by ${userId}`);
  void dispatchProductEvent(productId, channelId, workspaceOwnerId, "product.unhidden", null, null, null);
}

export async function updatePublicationFields(
  productId: number,
  channelId: number,
  fields: PublishFields,
  userId: string,
): Promise<void> {
  const workspaceOwnerId = await getChannelWorkspace(channelId);
  if (!workspaceOwnerId) return;

  const setFields: string[] = ["updated_at = now()"];
  const params: unknown[] = [productId, channelId];

  const fieldMap: Record<string, string> = {
    publication_status: "publication_status",
    is_visible: "is_visible",
    public_slug: "public_slug",
    public_title: "public_title",
    short_description: "short_description",
    long_description: "long_description",
    seo_title: "seo_title",
    seo_description: "seo_description",
    og_image_url: "og_image_url",
    featured: "featured",
    sort_order: "sort_order",
    price_override: "price_override",
    sale_price_override: "sale_price_override",
    currency_override: "currency_override",
  };

  for (const [key, col] of Object.entries(fieldMap)) {
    const val = (fields as Record<string, unknown>)[key];
    if (val !== undefined) {
      params.push(val);
      setFields.push(`${col} = $${params.length}`);
    }
  }

  if (fields.badges !== undefined) {
    params.push(JSON.stringify(fields.badges));
    setFields.push(`badges = $${params.length}`);
  }
  if (fields.extra_fields !== undefined) {
    params.push(JSON.stringify(fields.extra_fields));
    setFields.push(`extra_fields = $${params.length}`);
  }

  if (setFields.length > 1) {
    await db.query(
      `UPDATE product_publications SET ${setFields.join(", ")} WHERE product_id = $1 AND channel_id = $2`,
      params,
    );
  }

  await writeSyncLog(productId, channelId, "fields_updated", "ok", `Fields updated by ${userId}`);
  void dispatchProductEvent(productId, channelId, workspaceOwnerId, "product.updated", null, null, null);
}

/**
 * Called after a product is updated. Marks all its publications as out_of_date
 * and fires webhook events for each channel.
 */
export async function notifyProductChanged(
  productId: number,
  workspaceOwnerId: string,
  changedFields: string[],
  events: ProductWebhookEvent[],
): Promise<void> {
  const pubs = await db.query<{
    channel_id: number;
    public_slug: string | null;
    brand_id: number | null;
  }>(
    `SELECT pp.channel_id, pp.public_slug,
            b.id AS brand_id
       FROM product_publications pp
       LEFT JOIN products p ON p.id = pp.product_id
       LEFT JOIN brands b ON lower(b.name) = lower(p.brand) AND b.workspace_owner_id = p.workspace_owner_id
      WHERE pp.product_id = $1
        AND pp.publication_status = 'published'
        AND pp.is_visible = true`,
    [productId],
  );

  if (pubs.rowCount === 0) return;

  await db.query(
    `UPDATE product_publications SET sync_status = 'out_of_date', updated_at = now()
     WHERE product_id = $1 AND publication_status = 'published' AND is_visible = true`,
    [productId],
  );

  for (const pub of pubs.rows) {
    await writeSyncLog(productId, pub.channel_id, "product_changed", "ok", undefined, changedFields);

    for (const event of events) {
      void dispatchProductEvent(
        productId,
        pub.channel_id,
        workspaceOwnerId,
        event,
        changedFields,
        pub.brand_id,
        pub.public_slug,
      );
    }
  }
}

/**
 * After POST /api/products, auto-publish to channels with auto_publish_new_products = true
 * whose brand matches the product's brand.
 */
export async function autoPublishToChannels(
  productId: number,
  workspaceOwnerId: string,
  productBrand: string | null,
): Promise<void> {
  try {
    const channels = await db.query<{ id: number; default_currency: string }>(
      `SELECT pc.id, pc.default_currency
         FROM publishing_channels pc
        WHERE pc.workspace_owner_id = $1
          AND pc.status = 'active'
          AND pc.auto_publish_new_products = true
          AND (
            pc.brand_id IS NULL
            OR EXISTS (
              SELECT 1 FROM brands b
               WHERE b.id = pc.brand_id
                 AND lower(b.name) = lower($2)
                 AND b.workspace_owner_id = $1
            )
          )`,
      [workspaceOwnerId, productBrand ?? ""],
    );

    for (const ch of channels.rows) {
      await db.query(
        `INSERT INTO product_publications
           (product_id, channel_id, workspace_owner_id, publication_status, is_visible, published_at, sync_status, last_synced_at)
         VALUES ($1, $2, $3, 'published', true, now(), 'synced', now())
         ON CONFLICT (product_id, channel_id) DO NOTHING`,
        [productId, ch.id, workspaceOwnerId],
      );
      await writeSyncLog(productId, ch.id, "auto_published", "ok", "Auto-published on create");
      void dispatchProductEvent(productId, ch.id, workspaceOwnerId, "product.published", null, null, null);
      void dispatchProductEvent(productId, ch.id, workspaceOwnerId, "product.created", null, null, null);
    }
  } catch (err) {
    logger.error({ err, productId }, "autoPublishToChannels: error (non-fatal)");
  }
}
