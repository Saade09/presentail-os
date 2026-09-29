/**
 * Public Catalog API v1
 * GET /api/catalog/v1/products
 * GET /api/catalog/v1/products/:id
 * GET /api/catalog/v1/products/slug/:slug
 * GET /api/catalog/v1/brands
 * GET /api/catalog/v1/categories
 * GET /api/catalog/v1/occasions
 * GET /api/catalog/v1/recipients
 * GET /api/catalog/v1/delivery-cities
 * GET /api/catalog/v1/availability
 *
 * Auth: Bearer <catalog_api_key> or X-Presentail-Api-Key: <key>
 */

import { Router } from "express";
import { db } from "../lib/db";
import { requireCatalogApiKey, catalogApiKeyed } from "../lib/catalogApiKeyAuth";
import { serializeCatalogProduct } from "../lib/catalogSerializer";
import { serializeCatalogEvent } from "../lib/eventCatalogSerializer";
import { logger } from "../lib/logger";
import { buildPublicObjectUrl } from "../lib/objectStorage";

const router = Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ChannelRow = {
  id: number;
  slug: string;
  name: string;
  status: string;
  default_currency: string;
  workspace_owner_id: string;
};

async function resolveChannel(
  workspaceOwnerId: string,
  channelParam: string | undefined,
  scopedChannelId: number | null,
): Promise<ChannelRow | null> {
  if (scopedChannelId !== null) {
    const r = await db.query<ChannelRow>(
      `SELECT id, slug, name, status, default_currency, workspace_owner_id
         FROM publishing_channels
        WHERE id = $1 AND workspace_owner_id = $2 AND status = 'active'`,
      [scopedChannelId, workspaceOwnerId],
    );
    return r.rows[0] ?? null;
  }

  if (!channelParam) {
    const r = await db.query<ChannelRow>(
      `SELECT id, slug, name, status, default_currency, workspace_owner_id
         FROM publishing_channels
        WHERE workspace_owner_id = $1 AND status = 'active'
        ORDER BY created_at ASC LIMIT 1`,
      [workspaceOwnerId],
    );
    return r.rows[0] ?? null;
  }

  const bySlug = await db.query<ChannelRow>(
    `SELECT id, slug, name, status, default_currency, workspace_owner_id
       FROM publishing_channels
      WHERE workspace_owner_id = $1 AND slug = $2 AND status = 'active'`,
    [workspaceOwnerId, channelParam],
  );
  if (bySlug.rows[0]) return bySlug.rows[0];

  const byId = parseInt(channelParam, 10);
  if (Number.isFinite(byId) && byId > 0) {
    const r = await db.query<ChannelRow>(
      `SELECT id, slug, name, status, default_currency, workspace_owner_id
         FROM publishing_channels
        WHERE workspace_owner_id = $1 AND id = $2 AND status = 'active'`,
      [workspaceOwnerId, byId],
    );
    return r.rows[0] ?? null;
  }

  return null;
}

type ProductRow = {
  id: number;
  workspace_owner_id: string;
  name: string;
  price_usd: string | null;
  price_aed: string | null;
  main_image_url: string | null;
  additional_image_urls: string[];
  image_public_path: string | null;
  additional_image_public_paths: string[] | null;
  description: string | null;
  status: string;
  brand: string | null;
  tags: string[];
  category: string | null;
  sku: string | null;
  created_at: string;
  updated_at: string | null;
  is_archived: boolean;
  brand_id: number | null;
};

type PubRow = {
  id: number;
  channel_id: number;
  publication_status: string;
  is_visible: boolean;
  featured: boolean;
  sort_order: number | null;
  published_at: string | null;
  last_synced_at: string | null;
  public_slug: string | null;
  public_title: string | null;
  short_description: string | null;
  long_description: string | null;
  seo_title: string | null;
  seo_description: string | null;
  og_image_url: string | null;
  price_override: string | null;
  sale_price_override: string | null;
  currency_override: string | null;
  badges: unknown;
  extra_fields: unknown;
};

async function getRelations(productId: number, workspaceOwnerId: string): Promise<{
  occasions: string[];
  recipients: string[];
  categories: string[];
  delivery_cities: string[];
}> {
  const [occ, rec, cat, cities] = await Promise.all([
    db.query<{ name: string }>(
      `SELECT o.name FROM product_occasions po JOIN occasions o ON o.id = po.attribute_id WHERE po.product_id = $1 AND o.workspace_owner_id = $2`,
      [productId, workspaceOwnerId],
    ),
    db.query<{ name: string }>(
      `SELECT r.name FROM product_recipients pr JOIN recipients r ON r.id = pr.attribute_id WHERE pr.product_id = $1 AND r.workspace_owner_id = $2`,
      [productId, workspaceOwnerId],
    ),
    db.query<{ name: string }>(
      `SELECT cc.name FROM product_catalog_categories pcc JOIN catalog_categories cc ON cc.id = pcc.attribute_id WHERE pcc.product_id = $1 AND cc.workspace_owner_id = $2`,
      [productId, workspaceOwnerId],
    ),
    db.query<{ name: string }>(
      // Default-on: a product delivers to every active workspace city unless an
      // explicit row disables that city OR its country is disabled at the
      // (parallel) country-availability level.
      `SELECT dc.name FROM delivery_cities dc
         WHERE dc.workspace_owner_id = $2 AND dc.is_active = true
           AND NOT EXISTS (
             SELECT 1 FROM product_city_availability pca
              WHERE pca.product_id = $1 AND pca.city_id = dc.id AND pca.is_available = false
           )
           AND NOT EXISTS (
             SELECT 1 FROM product_country_availability pcoa
              WHERE pcoa.product_id = $1 AND UPPER(pcoa.country_code) = UPPER(dc.country_code) AND pcoa.is_available = false
           )`,
      [productId, workspaceOwnerId],
    ),
  ]);
  return {
    occasions: occ.rows.map((r) => r.name),
    recipients: rec.rows.map((r) => r.name),
    categories: cat.rows.map((r) => r.name),
    delivery_cities: cities.rows.map((r) => r.name),
  };
}

// ---------------------------------------------------------------------------
// All routes require catalog API key
// ---------------------------------------------------------------------------

router.use("/catalog/v1", requireCatalogApiKey);

// ---------------------------------------------------------------------------
// GET /api/catalog/v1/products
// ---------------------------------------------------------------------------

router.get("/catalog/v1/products", async (req, res) => {
  const keyed = catalogApiKeyed(req);
  const { catalogWorkspaceOwnerId, catalogChannelId } = keyed;

  const channelParam = typeof req.query.channel === "string" ? req.query.channel : undefined;
  const channel = await resolveChannel(catalogWorkspaceOwnerId, channelParam, catalogChannelId);
  if (!channel) {
    res.status(400).json({ success: false, error: "Channel not found or not active. Pass ?channel=<slug>." });
    return;
  }

  // Parse filters
  const brandFilter = typeof req.query.brand === "string" && req.query.brand ? req.query.brand : null;
  const brandIdFilter = typeof req.query.brand_id === "string" && req.query.brand_id ? parseInt(req.query.brand_id, 10) : null;
  const categoryFilter = typeof req.query.category === "string" && req.query.category ? req.query.category : null;
  const occasionFilter = typeof req.query.occasion === "string" && req.query.occasion ? req.query.occasion : null;
  const recipientFilter = typeof req.query.recipient === "string" && req.query.recipient ? req.query.recipient : null;
  const deliveryCityFilter = typeof req.query.delivery_city === "string" && req.query.delivery_city ? req.query.delivery_city : null;
  const deliveryCityIdFilter = typeof req.query.delivery_city_id === "string" && req.query.delivery_city_id ? parseInt(req.query.delivery_city_id, 10) : null;
  const countryFilter = typeof req.query.country === "string" && req.query.country.trim()
    ? req.query.country.trim().toUpperCase()
    : typeof req.query.country_code === "string" && req.query.country_code.trim()
      ? req.query.country_code.trim().toUpperCase()
      : null;
  const featuredFilter = req.query.featured === "true" ? true : req.query.featured === "false" ? false : null;
  const availableFilter = req.query.available === "true" ? true : req.query.available === "false" ? false : null;
  const updatedSince = typeof req.query.updated_since === "string" && req.query.updated_since ? req.query.updated_since : null;
  const limitRaw = parseInt(typeof req.query.limit === "string" ? req.query.limit : "20", 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 && limitRaw <= 100 ? limitRaw : 20;
  const cursorRaw = typeof req.query.cursor === "string" && req.query.cursor ? parseInt(req.query.cursor, 10) : null;
  const cursor = cursorRaw !== null && Number.isFinite(cursorRaw) && cursorRaw > 0 ? cursorRaw : null;

  const conditions: string[] = [
    "p.workspace_owner_id = $1",
    "pp.channel_id = $2",
    "pp.publication_status = 'published'",
    "pp.is_visible = true",
    "p.is_archived = false",
  ];
  const params: unknown[] = [catalogWorkspaceOwnerId, channel.id];

  if (brandFilter) {
    params.push(`%${brandFilter.replace(/([%_\\])/g, "\\$1")}%`);
    conditions.push(`lower(p.brand) ILIKE lower($${params.length}) ESCAPE '\\'`);
  }
  if (Number.isFinite(brandIdFilter) && brandIdFilter! > 0) {
    params.push(brandIdFilter);
    conditions.push(`EXISTS (SELECT 1 FROM brands b WHERE b.id = $${params.length} AND lower(b.name) = lower(p.brand) AND b.workspace_owner_id = p.workspace_owner_id)`);
  }
  if (categoryFilter) {
    params.push(`%${categoryFilter.replace(/([%_\\])/g, "\\$1")}%`);
    conditions.push(`EXISTS (SELECT 1 FROM product_catalog_categories pcc JOIN catalog_categories cc ON cc.id = pcc.attribute_id WHERE pcc.product_id = p.id AND lower(cc.name) ILIKE lower($${params.length}) ESCAPE '\\')`);
  }
  if (occasionFilter) {
    params.push(occasionFilter);
    conditions.push(`EXISTS (SELECT 1 FROM product_occasions po JOIN occasions o ON o.id = po.attribute_id WHERE po.product_id = p.id AND lower(o.name) = lower($${params.length}))`);
  }
  if (recipientFilter) {
    params.push(recipientFilter);
    conditions.push(`EXISTS (SELECT 1 FROM product_recipients pr JOIN recipients r ON r.id = pr.attribute_id WHERE pr.product_id = p.id AND lower(r.name) = lower($${params.length}))`);
  }
  if (deliveryCityFilter) {
    params.push(deliveryCityFilter);
    conditions.push(`EXISTS (SELECT 1 FROM delivery_cities dc WHERE dc.workspace_owner_id = p.workspace_owner_id AND lower(dc.name) = lower($${params.length}) AND NOT EXISTS (SELECT 1 FROM product_city_availability pca WHERE pca.product_id = p.id AND pca.city_id = dc.id AND pca.is_available = false) AND NOT EXISTS (SELECT 1 FROM product_country_availability pcoa WHERE pcoa.product_id = p.id AND UPPER(pcoa.country_code) = UPPER(dc.country_code) AND pcoa.is_available = false))`);
  }
  if (Number.isFinite(deliveryCityIdFilter) && deliveryCityIdFilter! > 0) {
    params.push(deliveryCityIdFilter);
    conditions.push(`NOT EXISTS (SELECT 1 FROM product_city_availability pca WHERE pca.product_id = p.id AND pca.city_id = $${params.length} AND pca.is_available = false)`);
    conditions.push(`NOT EXISTS (SELECT 1 FROM delivery_cities dc JOIN product_country_availability pcoa ON pcoa.product_id = p.id AND UPPER(pcoa.country_code) = UPPER(dc.country_code) WHERE dc.id = $${params.length} AND dc.workspace_owner_id = p.workspace_owner_id AND pcoa.is_available = false)`);
  }
  if (countryFilter) {
    params.push(countryFilter);
    // Parallel default-on country guard: hide products explicitly disabled for
    // the requested country.
    conditions.push(`NOT EXISTS (SELECT 1 FROM product_country_availability pcoa WHERE pcoa.product_id = p.id AND UPPER(pcoa.country_code) = $${params.length} AND pcoa.is_available = false)`);
  }
  if (featuredFilter !== null) {
    params.push(featuredFilter);
    conditions.push(`pp.featured = $${params.length}`);
  }
  if (availableFilter !== null) {
    conditions.push(availableFilter ? `p.status = 'available'` : `p.status != 'available'`);
  }
  if (updatedSince) {
    params.push(updatedSince);
    conditions.push(`pp.updated_at >= $${params.length}`);
  }
  if (cursor) {
    params.push(cursor);
    conditions.push(`p.id < $${params.length}`);
  }

  const where = conditions.join(" AND ");
  params.push(limit + 1);
  const limitParam = params.length;

  try {
    const result = await db.query<ProductRow & PubRow & { brand_id: number | null }>(
      `SELECT p.id, p.workspace_owner_id, p.name, p.price_usd, p.price_aed,
              p.main_image_url, p.additional_image_urls,
              p.image_public_path, p.additional_image_public_paths, p.description,
              p.status, p.brand, p.tags, p.sku, p.created_at,
              p.is_archived,
              pp.id AS pub_id, pp.channel_id, pp.publication_status, pp.is_visible,
              pp.featured, pp.sort_order, pp.published_at, pp.last_synced_at,
              pp.public_slug, pp.public_title, pp.short_description, pp.long_description,
              pp.seo_title, pp.seo_description, pp.og_image_url,
              pp.price_override, pp.sale_price_override, pp.currency_override,
              pp.badges, pp.extra_fields, pp.updated_at,
              b.id AS brand_id
         FROM products p
         JOIN product_publications pp ON pp.product_id = p.id
         LEFT JOIN brands b ON lower(b.name) = lower(p.brand) AND b.workspace_owner_id = p.workspace_owner_id
        WHERE ${where}
        ORDER BY COALESCE(pp.sort_order, 9999) ASC, p.id DESC
        LIMIT $${limitParam}`,
      params,
    );

    const rows = result.rows;
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && pageRows.length > 0 ? pageRows[pageRows.length - 1].id : null;

    const products = await Promise.all(
      pageRows.map(async (row) => {
        const relations = await getRelations(row.id, catalogWorkspaceOwnerId);
        return serializeCatalogProduct(
          row,
          {
            id: (row as { pub_id?: number }).pub_id ?? 0,
            channel_id: row.channel_id,
            publication_status: row.publication_status,
            is_visible: row.is_visible,
            featured: row.featured,
            sort_order: row.sort_order,
            published_at: row.published_at,
            last_synced_at: row.last_synced_at,
            public_slug: row.public_slug,
            public_title: row.public_title,
            short_description: row.short_description,
            long_description: row.long_description,
            seo_title: row.seo_title,
            seo_description: row.seo_description,
            og_image_url: row.og_image_url,
            price_override: row.price_override,
            sale_price_override: row.sale_price_override,
            currency_override: row.currency_override,
            badges: row.badges,
            extra_fields: row.extra_fields,
          },
          { ...relations, brand_id: row.brand_id },
          channel.default_currency,
        );
      }),
    );

    res.json({
      success: true,
      channel: { id: channel.id, slug: channel.slug, name: channel.name },
      products,
      pagination: {
        limit,
        has_more: hasMore,
        next_cursor: nextCursor,
      },
    });
  } catch (err) {
    logger.error({ err }, "GET /catalog/v1/products error");
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/catalog/v1/products/slug/:slug  — must come before /:id
// ---------------------------------------------------------------------------

router.get("/catalog/v1/products/slug/:slug", async (req, res) => {
  const keyed = catalogApiKeyed(req);
  const { catalogWorkspaceOwnerId, catalogChannelId } = keyed;
  const channelParam = typeof req.query.channel === "string" ? req.query.channel : undefined;
  const channel = await resolveChannel(catalogWorkspaceOwnerId, channelParam, catalogChannelId);
  if (!channel) {
    res.status(400).json({ success: false, error: "Channel not found or not active." });
    return;
  }

  const slug = req.params.slug;

  try {
    const result = await db.query<ProductRow & PubRow & { brand_id: number | null }>(
      `SELECT p.id, p.workspace_owner_id, p.name, p.price_usd, p.price_aed,
              p.main_image_url, p.additional_image_urls,
              p.image_public_path, p.additional_image_public_paths, p.description,
              p.status, p.brand, p.tags, p.sku, p.created_at,
              p.is_archived,
              pp.id AS pub_id, pp.channel_id, pp.publication_status, pp.is_visible,
              pp.featured, pp.sort_order, pp.published_at, pp.last_synced_at,
              pp.public_slug, pp.public_title, pp.short_description, pp.long_description,
              pp.seo_title, pp.seo_description, pp.og_image_url,
              pp.price_override, pp.sale_price_override, pp.currency_override,
              pp.badges, pp.extra_fields, pp.updated_at,
              b.id AS brand_id
         FROM products p
         JOIN product_publications pp ON pp.product_id = p.id
         LEFT JOIN brands b ON lower(b.name) = lower(p.brand) AND b.workspace_owner_id = p.workspace_owner_id
        WHERE p.workspace_owner_id = $1
          AND pp.channel_id = $2
          AND pp.publication_status = 'published'
          AND pp.is_visible = true
          AND p.is_archived = false
          AND (pp.public_slug = $3 OR (pp.public_slug IS NULL AND p.sku = $3))
        LIMIT 1`,
      [catalogWorkspaceOwnerId, channel.id, slug],
    );

    if (!result.rows[0]) {
      res.status(404).json({ success: false, error: "Product not found" });
      return;
    }

    const row = result.rows[0];
    const relations = await getRelations(row.id, catalogWorkspaceOwnerId);
    const product = serializeCatalogProduct(
      row,
      {
        id: (row as { pub_id?: number }).pub_id ?? 0,
        channel_id: row.channel_id,
        publication_status: row.publication_status,
        is_visible: row.is_visible,
        featured: row.featured,
        sort_order: row.sort_order,
        published_at: row.published_at,
        last_synced_at: row.last_synced_at,
        public_slug: row.public_slug,
        public_title: row.public_title,
        short_description: row.short_description,
        long_description: row.long_description,
        seo_title: row.seo_title,
        seo_description: row.seo_description,
        og_image_url: row.og_image_url,
        price_override: row.price_override,
        sale_price_override: row.sale_price_override,
        currency_override: row.currency_override,
        badges: row.badges,
        extra_fields: row.extra_fields,
      },
      { ...relations, brand_id: row.brand_id },
      channel.default_currency,
    );

    res.json({ success: true, product });
  } catch (err) {
    logger.error({ err }, "GET /catalog/v1/products/slug/:slug error");
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/catalog/v1/products/:id
// ---------------------------------------------------------------------------

router.get("/catalog/v1/products/:id", async (req, res) => {
  const keyed = catalogApiKeyed(req);
  const { catalogWorkspaceOwnerId, catalogChannelId } = keyed;
  const channelParam = typeof req.query.channel === "string" ? req.query.channel : undefined;
  const channel = await resolveChannel(catalogWorkspaceOwnerId, channelParam, catalogChannelId);
  if (!channel) {
    res.status(400).json({ success: false, error: "Channel not found or not active." });
    return;
  }

  const productId = parseInt(req.params.id, 10);
  if (!Number.isFinite(productId) || productId <= 0) {
    res.status(400).json({ success: false, error: "Invalid product ID" });
    return;
  }

  try {
    const result = await db.query<ProductRow & PubRow & { brand_id: number | null }>(
      `SELECT p.id, p.workspace_owner_id, p.name, p.price_usd, p.price_aed,
              p.main_image_url, p.additional_image_urls,
              p.image_public_path, p.additional_image_public_paths, p.description,
              p.status, p.brand, p.tags, p.sku, p.created_at,
              p.is_archived,
              pp.id AS pub_id, pp.channel_id, pp.publication_status, pp.is_visible,
              pp.featured, pp.sort_order, pp.published_at, pp.last_synced_at,
              pp.public_slug, pp.public_title, pp.short_description, pp.long_description,
              pp.seo_title, pp.seo_description, pp.og_image_url,
              pp.price_override, pp.sale_price_override, pp.currency_override,
              pp.badges, pp.extra_fields, pp.updated_at,
              b.id AS brand_id
         FROM products p
         JOIN product_publications pp ON pp.product_id = p.id
         LEFT JOIN brands b ON lower(b.name) = lower(p.brand) AND b.workspace_owner_id = p.workspace_owner_id
        WHERE p.id = $1
          AND p.workspace_owner_id = $2
          AND pp.channel_id = $3
          AND pp.publication_status = 'published'
          AND pp.is_visible = true
          AND p.is_archived = false
        LIMIT 1`,
      [productId, catalogWorkspaceOwnerId, channel.id],
    );

    if (!result.rows[0]) {
      res.status(404).json({ success: false, error: "Product not found or not published in this channel" });
      return;
    }

    const row = result.rows[0];
    const relations = await getRelations(row.id, catalogWorkspaceOwnerId);
    const product = serializeCatalogProduct(
      row,
      {
        id: (row as { pub_id?: number }).pub_id ?? 0,
        channel_id: row.channel_id,
        publication_status: row.publication_status,
        is_visible: row.is_visible,
        featured: row.featured,
        sort_order: row.sort_order,
        published_at: row.published_at,
        last_synced_at: row.last_synced_at,
        public_slug: row.public_slug,
        public_title: row.public_title,
        short_description: row.short_description,
        long_description: row.long_description,
        seo_title: row.seo_title,
        seo_description: row.seo_description,
        og_image_url: row.og_image_url,
        price_override: row.price_override,
        sale_price_override: row.sale_price_override,
        currency_override: row.currency_override,
        badges: row.badges,
        extra_fields: row.extra_fields,
      },
      { ...relations, brand_id: row.brand_id },
      channel.default_currency,
    );

    res.json({ success: true, product });
  } catch (err) {
    logger.error({ err }, "GET /catalog/v1/products/:id error");
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/catalog/v1/brands
// ---------------------------------------------------------------------------

router.get("/catalog/v1/brands", async (req, res) => {
  const keyed = catalogApiKeyed(req);
  const { catalogWorkspaceOwnerId } = keyed;
  try {
    const result = await db.query<{ id: number; name: string; slug: string | null; description: string | null; primary_logo_id: number | null }>(
      `SELECT id, name, slug, description, primary_logo_id
         FROM brands
        WHERE workspace_owner_id = $1
          AND is_archived = false
        ORDER BY name ASC`,
      [catalogWorkspaceOwnerId],
    );
    res.json({ success: true, brands: result.rows });
  } catch (err) {
    logger.error({ err }, "GET /catalog/v1/brands error");
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/catalog/v1/categories
// ---------------------------------------------------------------------------

router.get("/catalog/v1/categories", async (req, res) => {
  const keyed = catalogApiKeyed(req);
  const { catalogWorkspaceOwnerId } = keyed;
  try {
    const result = await db.query<{ image_public_path: string | null }>(
      `SELECT id, name, slug, description, image_url, image_public_path, sort_order, is_active
         FROM catalog_categories
        WHERE workspace_owner_id = $1 AND is_active = true
        ORDER BY sort_order ASC, name ASC`,
      [catalogWorkspaceOwnerId],
    );
    const categories = result.rows.map((r) => ({
      ...r,
      image_public_url: buildPublicObjectUrl(r.image_public_path),
    }));
    res.json({ success: true, categories });
  } catch (err) {
    logger.error({ err }, "GET /catalog/v1/categories error");
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/catalog/v1/occasions
// ---------------------------------------------------------------------------

router.get("/catalog/v1/occasions", async (req, res) => {
  const keyed = catalogApiKeyed(req);
  const { catalogWorkspaceOwnerId } = keyed;
  try {
    const result = await db.query<{ image_public_path: string | null }>(
      `SELECT id, name, slug, description, image_url, image_public_path, sort_order, is_active
         FROM occasions
        WHERE workspace_owner_id = $1 AND is_active = true
        ORDER BY sort_order ASC, name ASC`,
      [catalogWorkspaceOwnerId],
    );
    const occasions = result.rows.map((r) => ({
      ...r,
      image_public_url: buildPublicObjectUrl(r.image_public_path),
    }));
    res.json({ success: true, occasions });
  } catch (err) {
    logger.error({ err }, "GET /catalog/v1/occasions error");
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/catalog/v1/recipients
// ---------------------------------------------------------------------------

router.get("/catalog/v1/recipients", async (req, res) => {
  const keyed = catalogApiKeyed(req);
  const { catalogWorkspaceOwnerId } = keyed;
  try {
    const result = await db.query<{ image_public_path: string | null }>(
      `SELECT id, name, slug, description, image_url, image_public_path, sort_order, is_active
         FROM recipients
        WHERE workspace_owner_id = $1 AND is_active = true
        ORDER BY sort_order ASC, name ASC`,
      [catalogWorkspaceOwnerId],
    );
    const recipients = result.rows.map((r) => ({
      ...r,
      image_public_url: buildPublicObjectUrl(r.image_public_path),
    }));
    res.json({ success: true, recipients });
  } catch (err) {
    logger.error({ err }, "GET /catalog/v1/recipients error");
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/catalog/v1/delivery-cities
// ---------------------------------------------------------------------------

router.get("/catalog/v1/delivery-cities", async (req, res) => {
  const keyed = catalogApiKeyed(req);
  const { catalogWorkspaceOwnerId } = keyed;
  try {
    const result = await db.query(
      `SELECT id, name, slug, country, is_active
         FROM delivery_cities
        WHERE workspace_owner_id = $1 AND is_active = true
        ORDER BY name ASC`,
      [catalogWorkspaceOwnerId],
    );
    res.json({ success: true, delivery_cities: result.rows });
  } catch (err) {
    logger.error({ err }, "GET /catalog/v1/delivery-cities error");
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/catalog/v1/availability
// ---------------------------------------------------------------------------

router.get("/catalog/v1/availability", async (req, res) => {
  const keyed = catalogApiKeyed(req);
  const { catalogWorkspaceOwnerId, catalogChannelId } = keyed;
  const channelParam = typeof req.query.channel === "string" ? req.query.channel : undefined;
  const channel = await resolveChannel(catalogWorkspaceOwnerId, channelParam, catalogChannelId);
  if (!channel) {
    res.status(400).json({ success: false, error: "Channel not found or not active." });
    return;
  }

  const productIdRaw = typeof req.query.product_id === "string" ? parseInt(req.query.product_id, 10) : null;
  if (!productIdRaw || !Number.isFinite(productIdRaw)) {
    res.status(400).json({ success: false, error: "product_id query param is required" });
    return;
  }

  try {
    const result = await db.query<{
      product_id: number;
      publication_status: string;
      is_visible: boolean;
      status: string;
    }>(
      `SELECT pp.product_id, pp.publication_status, pp.is_visible, p.status
         FROM product_publications pp
         JOIN products p ON p.id = pp.product_id
        WHERE pp.product_id = $1 AND pp.channel_id = $2 AND p.workspace_owner_id = $3`,
      [productIdRaw, channel.id, catalogWorkspaceOwnerId],
    );

    if (!result.rows[0]) {
      res.json({
        success: true,
        product_id: productIdRaw,
        channel_id: channel.id,
        is_published: false,
        is_visible: false,
        availability: "unavailable",
      });
      return;
    }

    const row = result.rows[0];
    const isPublished = row.publication_status === "published" && row.is_visible;
    const avail = row.status === "available" ? "in_stock" : row.status === "out_of_stock" ? "out_of_stock" : "unavailable";

    res.json({
      success: true,
      product_id: productIdRaw,
      channel_id: channel.id,
      is_published: isPublished,
      is_visible: row.is_visible,
      publication_status: row.publication_status,
      availability: isPublished ? avail : "unavailable",
    });
  } catch (err) {
    logger.error({ err }, "GET /catalog/v1/availability error");
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/catalog/v1/events
// ---------------------------------------------------------------------------

router.get("/catalog/v1/events", async (req, res) => {
  const keyed = catalogApiKeyed(req);
  const { catalogWorkspaceOwnerId, catalogChannelId } = keyed;

  const channelParam = typeof req.query.channel === "string" ? req.query.channel : undefined;
  const channel = await resolveChannel(catalogWorkspaceOwnerId, channelParam, catalogChannelId);
  if (!channel) {
    res.status(400).json({ success: false, error: "Channel not found or not active. Pass ?channel=<slug>." });
    return;
  }

  const occasionFilter = typeof req.query.occasion === "string" && req.query.occasion ? req.query.occasion : null;
  const featuredFilter = req.query.featured === "true" ? true : req.query.featured === "false" ? false : null;
  const updatedSince = typeof req.query.updated_since === "string" && req.query.updated_since ? req.query.updated_since : null;
  const limitRaw = parseInt(typeof req.query.limit === "string" ? req.query.limit : "20", 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 && limitRaw <= 100 ? limitRaw : 20;
  const cursorRaw = typeof req.query.cursor === "string" && req.query.cursor ? parseInt(req.query.cursor, 10) : null;
  const cursor = cursorRaw !== null && Number.isFinite(cursorRaw) && cursorRaw > 0 ? cursorRaw : null;

  const conditions: string[] = [
    "e.workspace_owner_id = $1",
    "ep.channel_id = $2",
    "ep.publication_status = 'published'",
    "ep.is_visible = true",
    "e.is_archived = false",
  ];
  const params: unknown[] = [catalogWorkspaceOwnerId, channel.id];

  if (occasionFilter) {
    params.push(occasionFilter);
    conditions.push(
      `EXISTS (SELECT 1 FROM event_occasions eo JOIN occasions o ON o.id = eo.attribute_id WHERE eo.event_id = e.id AND lower(o.name) = lower($${params.length}))`,
    );
  }
  if (featuredFilter !== null) {
    params.push(featuredFilter);
    conditions.push(`ep.featured = $${params.length}`);
  }
  if (updatedSince) {
    params.push(updatedSince);
    conditions.push(`ep.updated_at >= $${params.length}`);
  }
  if (cursor) {
    params.push(cursor);
    conditions.push(`e.id < $${params.length}`);
  }

  const where = conditions.join(" AND ");
  params.push(limit + 1);
  const limitParam = params.length;

  try {
    type EventPubRow = {
      id: number;
      workspace_owner_id: string;
      name: string;
      description: string | null;
      starting_price_usd: string | null;
      starting_price_aed: string | null;
      main_image_url: string | null;
      additional_image_urls: string[];
      image_public_path: string | null;
      additional_image_public_paths: string[] | null;
      status: string;
      is_archived: boolean;
      created_at: string;
      updated_at: string | null;
      pub_id: number;
      channel_id: number;
      publication_status: string;
      is_visible: boolean;
      featured: boolean;
      sort_order: number | null;
      published_at: string | null;
      last_synced_at: string | null;
      public_slug: string | null;
      public_title: string | null;
      short_description: string | null;
      long_description: string | null;
      seo_title: string | null;
      seo_description: string | null;
      og_image_url: string | null;
      price_override: string | null;
      sale_price_override: string | null;
      currency_override: string | null;
      badges: unknown;
      extra_fields: unknown;
    };

    const result = await db.query<EventPubRow>(
      `SELECT e.id, e.workspace_owner_id, e.name, e.description,
              e.starting_price_usd, e.starting_price_aed,
              e.main_image_url, e.additional_image_urls,
              e.image_public_path, e.additional_image_public_paths,
              e.status, e.is_archived, e.created_at,
              ep.id AS pub_id, ep.channel_id, ep.publication_status, ep.is_visible,
              ep.featured, ep.sort_order, ep.published_at, ep.last_synced_at,
              ep.public_slug, ep.public_title, ep.short_description, ep.long_description,
              ep.seo_title, ep.seo_description, ep.og_image_url,
              ep.price_override, ep.sale_price_override, ep.currency_override,
              ep.badges, ep.extra_fields, ep.updated_at
         FROM events e
         JOIN event_publications ep ON ep.event_id = e.id
        WHERE ${where}
        ORDER BY COALESCE(ep.sort_order, 9999) ASC, e.id DESC
        LIMIT $${limitParam}`,
      params,
    );

    const rows = result.rows;
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && pageRows.length > 0 ? pageRows[pageRows.length - 1].id : null;

    const events = await Promise.all(
      pageRows.map(async (row) => {
        const occ = await db.query<{ name: string }>(
          `SELECT o.name FROM event_occasions eo JOIN occasions o ON o.id = eo.attribute_id WHERE eo.event_id = $1 AND o.workspace_owner_id = $2`,
          [row.id, catalogWorkspaceOwnerId],
        );
        return serializeCatalogEvent(
          row,
          {
            id: row.pub_id,
            channel_id: row.channel_id,
            publication_status: row.publication_status,
            is_visible: row.is_visible,
            featured: row.featured,
            sort_order: row.sort_order,
            published_at: row.published_at,
            last_synced_at: row.last_synced_at,
            public_slug: row.public_slug,
            public_title: row.public_title,
            short_description: row.short_description,
            long_description: row.long_description,
            seo_title: row.seo_title,
            seo_description: row.seo_description,
            og_image_url: row.og_image_url,
            price_override: row.price_override,
            sale_price_override: row.sale_price_override,
            currency_override: row.currency_override,
            badges: row.badges,
            extra_fields: row.extra_fields,
          },
          { occasions: occ.rows.map((r) => r.name) },
          channel.default_currency,
        );
      }),
    );

    res.json({
      success: true,
      channel: { id: channel.id, slug: channel.slug, name: channel.name },
      events,
      pagination: { limit, has_more: hasMore, next_cursor: nextCursor },
    });
  } catch (err) {
    logger.error({ err }, "GET /catalog/v1/events error");
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/catalog/v1/events/:id
// ---------------------------------------------------------------------------

router.get("/catalog/v1/events/:id", async (req, res) => {
  const keyed = catalogApiKeyed(req);
  const { catalogWorkspaceOwnerId, catalogChannelId } = keyed;
  const channelParam = typeof req.query.channel === "string" ? req.query.channel : undefined;
  const channel = await resolveChannel(catalogWorkspaceOwnerId, channelParam, catalogChannelId);
  if (!channel) {
    res.status(400).json({ success: false, error: "Channel not found or not active." });
    return;
  }

  const eventId = parseInt(req.params.id, 10);
  if (!Number.isFinite(eventId) || eventId <= 0) {
    res.status(400).json({ success: false, error: "Invalid event ID" });
    return;
  }

  try {
    const result = await db.query(
      `SELECT e.id, e.workspace_owner_id, e.name, e.description,
              e.starting_price_usd, e.starting_price_aed,
              e.main_image_url, e.additional_image_urls,
              e.image_public_path, e.additional_image_public_paths,
              e.status, e.is_archived, e.created_at,
              ep.id AS pub_id, ep.channel_id, ep.publication_status, ep.is_visible,
              ep.featured, ep.sort_order, ep.published_at, ep.last_synced_at,
              ep.public_slug, ep.public_title, ep.short_description, ep.long_description,
              ep.seo_title, ep.seo_description, ep.og_image_url,
              ep.price_override, ep.sale_price_override, ep.currency_override,
              ep.badges, ep.extra_fields, ep.updated_at
         FROM events e
         JOIN event_publications ep ON ep.event_id = e.id
        WHERE e.id = $1
          AND e.workspace_owner_id = $2
          AND ep.channel_id = $3
          AND ep.publication_status = 'published'
          AND ep.is_visible = true
          AND e.is_archived = false
        LIMIT 1`,
      [eventId, catalogWorkspaceOwnerId, channel.id],
    );

    if (!result.rows[0]) {
      res.status(404).json({ success: false, error: "Event not found or not published in this channel" });
      return;
    }

    const row = result.rows[0] as {
      id: number; workspace_owner_id: string; name: string; description: string | null;
      starting_price_usd: string | null; starting_price_aed: string | null;
      main_image_url: string | null; additional_image_urls: string[];
      image_public_path: string | null; additional_image_public_paths: string[] | null;
      status: string; is_archived: boolean; created_at: string; updated_at: string | null;
      pub_id: number; channel_id: number; publication_status: string; is_visible: boolean;
      featured: boolean; sort_order: number | null; published_at: string | null;
      last_synced_at: string | null; public_slug: string | null; public_title: string | null;
      short_description: string | null; long_description: string | null;
      seo_title: string | null; seo_description: string | null; og_image_url: string | null;
      price_override: string | null; sale_price_override: string | null;
      currency_override: string | null; badges: unknown; extra_fields: unknown;
    };

    const occ = await db.query<{ name: string }>(
      `SELECT o.name FROM event_occasions eo JOIN occasions o ON o.id = eo.attribute_id WHERE eo.event_id = $1 AND o.workspace_owner_id = $2`,
      [row.id, catalogWorkspaceOwnerId],
    );

    const event = serializeCatalogEvent(
      row,
      {
        id: row.pub_id,
        channel_id: row.channel_id,
        publication_status: row.publication_status,
        is_visible: row.is_visible,
        featured: row.featured,
        sort_order: row.sort_order,
        published_at: row.published_at,
        last_synced_at: row.last_synced_at,
        public_slug: row.public_slug,
        public_title: row.public_title,
        short_description: row.short_description,
        long_description: row.long_description,
        seo_title: row.seo_title,
        seo_description: row.seo_description,
        og_image_url: row.og_image_url,
        price_override: row.price_override,
        sale_price_override: row.sale_price_override,
        currency_override: row.currency_override,
        badges: row.badges,
        extra_fields: row.extra_fields,
      },
      { occasions: occ.rows.map((r) => r.name) },
      channel.default_currency,
    );

    res.json({ success: true, event });
  } catch (err) {
    logger.error({ err }, "GET /catalog/v1/events/:id error");
    res.status(500).json({ success: false, error: "Internal server error" });
  }
});

export default router;
