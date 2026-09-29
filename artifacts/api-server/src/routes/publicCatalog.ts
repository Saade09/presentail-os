/**
 * Public Catalog API — unauthenticated read-only endpoints for external websites.
 *
 * Workspace is identified by ?workspace=<slug_or_clerk_user_id>.
 * API-key authentication is supported as an alternative to the workspace param and
 * is required for the protected /public/catalog/customers endpoint.
 *
 * All list endpoints include Last-Modified + ETag headers for efficient polling.
 */
import { Router, type Request, type Response } from "express";
import crypto from "crypto";
import { db } from "../lib/db";
import { requireApiKey, type ApiKeyAuthedRequest } from "../lib/apiKeyAuth";
import { resolvePublicWorkspace, resolveCityFilter } from "../lib/resolvePublicWorkspace";
import { buildPublicObjectUrl } from "../lib/objectStorage";

const router = Router();

// ---------------------------------------------------------------------------
// Caching helpers
// ---------------------------------------------------------------------------

function computeETag(data: unknown): string {
  const body = JSON.stringify(data);
  return `"${crypto.createHash("md5").update(body).digest("hex")}"`;
}

function respondWithCaching(
  req: Request,
  res: Response,
  data: unknown,
  lastModified?: Date | null,
): void {
  if (lastModified) {
    res.set("Last-Modified", lastModified.toUTCString());
  }
  const etag = computeETag(data);
  res.set("ETag", etag);

  // Conditional: If-None-Match (ETag-based)
  if (req.headers["if-none-match"] === etag) {
    res.status(304).end();
    return;
  }

  // Conditional: If-Modified-Since (date-based, only when Last-Modified is known)
  if (lastModified) {
    const ifModifiedSince = req.headers["if-modified-since"];
    if (ifModifiedSince) {
      const since = new Date(ifModifiedSince);
      if (!Number.isNaN(since.getTime()) && lastModified <= since) {
        res.status(304).end();
        return;
      }
    }
  }

  res.json(data);
}

function maxDate(dates: Array<string | Date | null | undefined>): Date | null {
  let max: Date | null = null;
  for (const d of dates) {
    if (!d) continue;
    const t = d instanceof Date ? d : new Date(d);
    if (!max || t > max) max = t;
  }
  return max;
}

// ---------------------------------------------------------------------------
// Workspace + city resolution guard (used in every public endpoint)
// ---------------------------------------------------------------------------

type ResolvedCtx = { ownerId: string; cityId: number | null; countryCode: string | null };

async function resolveCtx(
  req: Request,
  res: Response,
): Promise<ResolvedCtx | null> {
  const workspaceResult = await resolvePublicWorkspace(req);
  if ("error" in workspaceResult) {
    if (workspaceResult.error === "missing_workspace") {
      res.status(400).json({ error: "workspace query parameter is required" });
    } else {
      res.status(404).json({ error: "Workspace not found" });
    }
    return null;
  }
  const { ownerId } = workspaceResult;
  const cityResult = await resolveCityFilter(req, ownerId);
  if ("error" in cityResult) {
    res.status(cityResult.status).json({ error: cityResult.error });
    return null;
  }
  return { ownerId, cityId: cityResult.cityId, countryCode: cityResult.countryCode };
}

// ---------------------------------------------------------------------------
// GET /api/public/catalog/products
// Paginated product list. Returns status=available by default.
// ---------------------------------------------------------------------------

router.get("/public/catalog/products", async (req, res) => {
  const ctx = await resolveCtx(req, res);
  if (!ctx) return;
  const { ownerId, cityId, countryCode } = ctx;

  const includeUnavailable = req.query.include_unavailable === "true";
  const rawPage = parseInt(typeof req.query.page === "string" ? req.query.page : "1", 10);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;
  const rawPageSize = parseInt(typeof req.query.pageSize === "string" ? req.query.pageSize : "25", 10);
  const pageSize = ([10, 25, 50, 100] as number[]).includes(rawPageSize) ? rawPageSize : 25;

  const conditions: string[] = ["p.workspace_owner_id = $1", "p.is_archived = false"];
  const params: unknown[] = [ownerId];

  if (!includeUnavailable) {
    conditions.push("p.status = 'available'");
  }

  if (cityId !== null) {
    params.push(cityId);
    // Default-on: a product is available in every city unless an explicit row
    // disables it. Hide only products explicitly disabled for this city.
    conditions.push(
      `NOT EXISTS (
         SELECT 1 FROM product_city_availability pca
          WHERE pca.product_id = p.id
            AND pca.city_id = $${params.length}
            AND pca.is_available = false
       )`,
    );
  }

  if (countryCode !== null) {
    params.push(countryCode);
    // Parallel default-on country guard: hide products explicitly disabled for
    // the visitor's country.
    conditions.push(
      `NOT EXISTS (
         SELECT 1 FROM product_country_availability pcoa
          WHERE pcoa.product_id = p.id
            AND UPPER(pcoa.country_code) = $${params.length}
            AND pcoa.is_available = false
       )`,
    );
  }

  const brand = typeof req.query.brand === "string" && req.query.brand.trim() ? req.query.brand.trim() : null;
  if (brand !== null) {
    params.push(`%${brand.replace(/([%_\\])/g, "\\$1")}%`);
    conditions.push(`lower(p.brand) ILIKE lower($${params.length}) ESCAPE '\\'`);
  }

  const category = typeof req.query.category === "string" && req.query.category.trim() ? req.query.category.trim() : null;
  if (category !== null) {
    params.push(`%${category.replace(/([%_\\])/g, "\\$1")}%`);
    conditions.push(`EXISTS (SELECT 1 FROM product_catalog_categories pcc JOIN catalog_categories cc ON cc.id = pcc.attribute_id WHERE pcc.product_id = p.id AND lower(cc.name) ILIKE lower($${params.length}) ESCAPE '\\')`);
  }

  const q = typeof req.query.q === "string" && req.query.q.trim() ? req.query.q.trim() : null;
  if (q !== null) {
    params.push(`%${q.replace(/([%_\\])/g, "\\$1")}%`);
    conditions.push(`(p.name ILIKE $${params.length} ESCAPE '\\' OR p.sku ILIKE $${params.length} ESCAPE '\\')`);
  }

  const where = conditions.join(" AND ");

  const countResult = await db.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM products p WHERE ${where}`,
    params,
  );
  const total = parseInt(countResult.rows[0]?.count ?? "0", 10);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const offset = (safePage - 1) * pageSize;

  params.push(pageSize);
  const limitParam = params.length;
  params.push(offset);
  const offsetParam = params.length;

  type PublicProductRow = {
    id: number;
    name: string;
    price_usd: string | null;
    price_aed: string | null;
    discount_price_usd: string | null;
    discount_price_aed: string | null;
    main_image_url: string | null;
    additional_image_urls: string[] | null;
    image_public_path: string | null;
    additional_image_public_paths: string[] | null;
    image_display_public_path: string | null;
    image_thumbnail_public_path: string | null;
    additional_image_display_public_paths: Array<string | null> | null;
    additional_image_thumbnail_public_paths: Array<string | null> | null;
    description: string | null;
    status: string;
    brand: string | null;
    tags: string[] | null;
    category: string | null;
    sku: string | null;
    updated_at: string | null;
    express_delivery_enabled: boolean;
    has_input_field: boolean;
    letter_input_enabled: boolean;
    is_upsell: boolean;
    occasions: string | null;
    recipients: string | null;
  };

  const result = await db.query<PublicProductRow>(
    `SELECT p.id, p.name, p.price_usd, p.price_aed,
            p.discount_price_usd, p.discount_price_aed,
            p.main_image_url, p.additional_image_urls,
             p.image_public_path, p.additional_image_public_paths,
             p.image_display_public_path, p.image_thumbnail_public_path,
             p.additional_image_display_public_paths, p.additional_image_thumbnail_public_paths,
             p.description,
            p.status, p.brand, p.tags, p.express_delivery_enabled, p.has_input_field, p.letter_input_enabled, p.is_upsell,
            (SELECT cc.name FROM product_catalog_categories pcc JOIN catalog_categories cc ON cc.id = pcc.attribute_id WHERE pcc.product_id = p.id ORDER BY cc.name ASC LIMIT 1) AS category,
            p.sku, p.created_at AS updated_at,
            (SELECT json_agg(json_build_object('id', o.id, 'name', o.name, 'slug', o.slug))
               FROM product_occasions po
               JOIN occasions o ON o.id = po.attribute_id
              WHERE po.product_id = p.id) AS occasions,
            (SELECT json_agg(json_build_object('id', r.id, 'name', r.name, 'slug', r.slug))
               FROM product_recipients pr
               JOIN recipients r ON r.id = pr.attribute_id
              WHERE pr.product_id = p.id) AS recipients
       FROM products p
      WHERE ${where}
      ORDER BY p.created_at DESC
      LIMIT $${limitParam} OFFSET $${offsetParam}`,
    params,
  );

  const lastModified = maxDate(result.rows.map((r) => r.updated_at));
  const payload = {
    products: result.rows.map((r) => {
      const {
        image_public_path,
        additional_image_public_paths,
        image_display_public_path,
        image_thumbnail_public_path,
        additional_image_display_public_paths,
        additional_image_thumbnail_public_paths,
        ...rest
      } = r;
      const externalMainFallback = /^https?:\/\//i.test(r.main_image_url ?? "")
        ? r.main_image_url
        : null;
      const mapAdditional = (paths: Array<string | null> | null) => {
        const sources = r.additional_image_urls ?? [];
        return Array.from(
          { length: Math.max(sources.length, paths?.length ?? 0) },
          (_, index) => {
            const source = sources[index];
            return (
              buildPublicObjectUrl(paths?.[index]) ??
              (source && /^https?:\/\//i.test(source) ? source : null)
            );
          },
        );
      };
      return {
        ...rest,
        hasLetterField: r.letter_input_enabled === true,
        main_image_public_url: buildPublicObjectUrl(image_public_path) ?? externalMainFallback,
        main_image_display_public_url:
          buildPublicObjectUrl(image_display_public_path) ?? externalMainFallback,
        main_image_thumbnail_public_url:
          buildPublicObjectUrl(image_thumbnail_public_path) ?? externalMainFallback,
        additional_image_public_urls: mapAdditional(additional_image_public_paths),
        additional_image_display_public_urls: mapAdditional(additional_image_display_public_paths),
        additional_image_thumbnail_public_urls: mapAdditional(additional_image_thumbnail_public_paths),
        occasions: Array.isArray(r.occasions) ? r.occasions : r.occasions ? (JSON.parse(r.occasions as unknown as string) as object[]) : [],
        recipients: Array.isArray(r.recipients) ? r.recipients : r.recipients ? (JSON.parse(r.recipients as unknown as string) as object[]) : [],
      };
    }),
    total,
    page: safePage,
    pageSize,
    totalPages,
  };
  respondWithCaching(req, res, payload, lastModified);
});

// ---------------------------------------------------------------------------
// GET /api/public/catalog/products/:id
// Single product detail.
// ---------------------------------------------------------------------------

router.get("/public/catalog/products/:id", async (req, res) => {
  const ctx = await resolveCtx(req, res);
  if (!ctx) return;
  const { ownerId, cityId, countryCode } = ctx;

  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "Invalid product id" });
    return;
  }

  // Default-on availability guards: a product is visible everywhere unless an
  // explicit row disables it for the visitor's resolved city / country. Mirror
  // the list endpoint so a hidden product cannot be fetched directly by id.
  const conditions: string[] = ["p.id = $1", "p.workspace_owner_id = $2", "p.is_archived = false"];
  const params: unknown[] = [id, ownerId];

  if (cityId !== null) {
    params.push(cityId);
    conditions.push(
      `NOT EXISTS (
         SELECT 1 FROM product_city_availability pca
          WHERE pca.product_id = p.id
            AND pca.city_id = $${params.length}
            AND pca.is_available = false
       )`,
    );
  }

  if (countryCode !== null) {
    params.push(countryCode);
    conditions.push(
      `NOT EXISTS (
         SELECT 1 FROM product_country_availability pcoa
          WHERE pcoa.product_id = p.id
            AND UPPER(pcoa.country_code) = $${params.length}
            AND pcoa.is_available = false
       )`,
    );
  }

  type PublicProductDetailRow = {
    id: number;
    name: string;
    price_usd: string | null;
    price_aed: string | null;
    discount_price_usd: string | null;
    discount_price_aed: string | null;
    main_image_url: string | null;
    additional_image_urls: string[] | null;
    image_public_path: string | null;
    additional_image_public_paths: string[] | null;
    image_display_public_path: string | null;
    image_thumbnail_public_path: string | null;
    additional_image_display_public_paths: Array<string | null> | null;
    additional_image_thumbnail_public_paths: Array<string | null> | null;
    description: string | null;
    status: string;
    brand: string | null;
    tags: string[] | null;
    category: string | null;
    sku: string | null;
    updated_at: string | null;
    express_delivery_enabled: boolean;
    has_input_field: boolean;
    letter_input_enabled: boolean;
    is_upsell: boolean;
    occasions: string | null;
    recipients: string | null;
  };

  const result = await db.query<PublicProductDetailRow>(
    `SELECT p.id, p.name, p.price_usd, p.price_aed,
            p.discount_price_usd, p.discount_price_aed,
            p.main_image_url, p.additional_image_urls,
             p.image_public_path, p.additional_image_public_paths,
             p.image_display_public_path, p.image_thumbnail_public_path,
             p.additional_image_display_public_paths, p.additional_image_thumbnail_public_paths,
             p.description,
            p.status, p.brand, p.tags, p.express_delivery_enabled, p.has_input_field, p.letter_input_enabled, p.is_upsell,
            (SELECT cc.name FROM product_catalog_categories pcc JOIN catalog_categories cc ON cc.id = pcc.attribute_id WHERE pcc.product_id = p.id ORDER BY cc.name ASC LIMIT 1) AS category,
            p.sku, p.created_at AS updated_at,
            (SELECT json_agg(json_build_object('id', o.id, 'name', o.name, 'slug', o.slug))
               FROM product_occasions po
               JOIN occasions o ON o.id = po.attribute_id
              WHERE po.product_id = p.id) AS occasions,
            (SELECT json_agg(json_build_object('id', r.id, 'name', r.name, 'slug', r.slug))
               FROM product_recipients pr
               JOIN recipients r ON r.id = pr.attribute_id
              WHERE pr.product_id = p.id) AS recipients
       FROM products p
      WHERE ${conditions.join(" AND ")}`,
    params,
  );

  if (result.rowCount === 0) {
    res.status(404).json({ error: "Product not found" });
    return;
  }

  const row = result.rows[0];
  const {
    image_public_path,
    additional_image_public_paths,
    image_display_public_path,
    image_thumbnail_public_path,
    additional_image_display_public_paths,
    additional_image_thumbnail_public_paths,
    ...rest
  } = row;
  const externalMainFallback = /^https?:\/\//i.test(row.main_image_url ?? "")
    ? row.main_image_url
    : null;
  const mapAdditional = (paths: Array<string | null> | null) => {
    const sources = row.additional_image_urls ?? [];
    return Array.from(
      { length: Math.max(sources.length, paths?.length ?? 0) },
      (_, index) => {
        const source = sources[index];
        return (
          buildPublicObjectUrl(paths?.[index]) ??
          (source && /^https?:\/\//i.test(source) ? source : null)
        );
      },
    );
  };
  const product = {
    ...rest,
    hasLetterField: row.letter_input_enabled === true,
    main_image_public_url: buildPublicObjectUrl(image_public_path) ?? externalMainFallback,
    main_image_display_public_url:
      buildPublicObjectUrl(image_display_public_path) ?? externalMainFallback,
    main_image_thumbnail_public_url:
      buildPublicObjectUrl(image_thumbnail_public_path) ?? externalMainFallback,
    additional_image_public_urls: mapAdditional(additional_image_public_paths),
    additional_image_display_public_urls: mapAdditional(additional_image_display_public_paths),
    additional_image_thumbnail_public_urls: mapAdditional(additional_image_thumbnail_public_paths),
    occasions: Array.isArray(row.occasions) ? row.occasions : row.occasions ? (JSON.parse(row.occasions as unknown as string) as object[]) : [],
    recipients: Array.isArray(row.recipients) ? row.recipients : row.recipients ? (JSON.parse(row.recipients as unknown as string) as object[]) : [],
  };
  respondWithCaching(req, res, { product }, row.updated_at ? new Date(row.updated_at) : null);
});

// ---------------------------------------------------------------------------
// GET /api/public/catalog/base-items
// Paginated base-item list with packaging. Returns status=active by default.
// Workspace identified via API key OR ?workspace=<slug_or_clerk_user_id>.
// ---------------------------------------------------------------------------

type PublicBaseItemRow = {
  id: number;
  name: string;
  code: string | null;
  image_url: string | null;
  image_public_path: string | null;
  category_id: number | null;
  main_category_name: string | null;
  sub_category_name: string | null;
  status: string;
  type: string | null;
  updated_at: string | null;
  packages: string | null;
};

const BASE_ITEM_PACKAGES_SUBQUERY = `
            (SELECT json_agg(json_build_object(
                      'id', pkg.id,
                      'name', pkg.name,
                      'unit', pkg.unit,
                      'quantity', pkg.quantity,
                      'is_default', pkg.is_default)
                      ORDER BY pkg.is_default DESC, pkg.id ASC)
               FROM base_item_packages pkg
              WHERE pkg.base_item_id = bi.id) AS packages`;

function mapPublicBaseItem(row: PublicBaseItemRow) {
  const { image_public_path, ...rest } = row;
  return {
    ...rest,
    image_public_url: buildPublicObjectUrl(image_public_path),
    packages: Array.isArray(row.packages)
      ? row.packages
      : row.packages
        ? (JSON.parse(row.packages as unknown as string) as object[])
        : [],
  };
}

router.get("/public/catalog/base-items", async (req, res) => {
  const ctx = await resolveCtx(req, res);
  if (!ctx) return;
  const { ownerId } = ctx;

  const includeInactive = req.query.include_inactive === "true";
  const rawPage = parseInt(typeof req.query.page === "string" ? req.query.page : "1", 10);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;
  const rawPageSize = parseInt(typeof req.query.pageSize === "string" ? req.query.pageSize : "25", 10);
  const pageSize = ([10, 25, 50, 100] as number[]).includes(rawPageSize) ? rawPageSize : 25;

  const conditions: string[] = ["bi.workspace_owner_id = $1"];
  const params: unknown[] = [ownerId];

  if (!includeInactive) {
    conditions.push("bi.status = 'active'");
  }

  const rawCatId = typeof req.query.category_id === "string" ? parseInt(req.query.category_id, 10) : NaN;
  if (Number.isFinite(rawCatId)) {
    params.push(rawCatId);
    conditions.push(`bi.category_id = $${params.length}`);
  }

  const q = typeof req.query.q === "string" && req.query.q.trim() ? req.query.q.trim() : null;
  if (q !== null) {
    params.push(`%${q.replace(/([%_\\])/g, "\\$1")}%`);
    conditions.push(`(bi.name ILIKE $${params.length} ESCAPE '\\' OR bi.code ILIKE $${params.length} ESCAPE '\\')`);
  }

  const where = conditions.join(" AND ");

  const countResult = await db.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM base_items bi WHERE ${where}`,
    params,
  );
  const total = parseInt(countResult.rows[0]?.count ?? "0", 10);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const offset = (safePage - 1) * pageSize;

  params.push(pageSize);
  const limitParam = params.length;
  params.push(offset);
  const offsetParam = params.length;

  const result = await db.query<PublicBaseItemRow>(
    `SELECT bi.id, bi.name, bi.code, bi.image_url, bi.image_public_path, bi.category_id,
            main_cat.name AS main_category_name,
            sub_cat.name  AS sub_category_name,
            bi.status, bi.type, bi.created_at AS updated_at,${BASE_ITEM_PACKAGES_SUBQUERY}
       FROM base_items bi
       LEFT JOIN base_item_categories sub_cat  ON sub_cat.id = bi.category_id
       LEFT JOIN base_item_categories main_cat ON main_cat.id = sub_cat.parent_id
                                              OR (sub_cat.parent_id IS NULL AND main_cat.id = bi.category_id)
      WHERE ${where}
      ORDER BY bi.created_at DESC
      LIMIT $${limitParam} OFFSET $${offsetParam}`,
    params,
  );

  const lastModified = maxDate(result.rows.map((r) => r.updated_at));
  const payload = {
    base_items: result.rows.map(mapPublicBaseItem),
    total,
    page: safePage,
    pageSize,
    totalPages,
  };
  respondWithCaching(req, res, payload, lastModified);
});

// ---------------------------------------------------------------------------
// GET /api/public/catalog/base-items/:id
// Single base-item detail with packaging.
// ---------------------------------------------------------------------------

router.get("/public/catalog/base-items/:id", async (req, res) => {
  const ctx = await resolveCtx(req, res);
  if (!ctx) return;
  const { ownerId } = ctx;

  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "Invalid base item id" });
    return;
  }

  const result = await db.query<PublicBaseItemRow>(
    `SELECT bi.id, bi.name, bi.code, bi.image_url, bi.image_public_path, bi.category_id,
            main_cat.name AS main_category_name,
            sub_cat.name  AS sub_category_name,
            bi.status, bi.type, bi.created_at AS updated_at,${BASE_ITEM_PACKAGES_SUBQUERY}
       FROM base_items bi
       LEFT JOIN base_item_categories sub_cat  ON sub_cat.id = bi.category_id
       LEFT JOIN base_item_categories main_cat ON main_cat.id = sub_cat.parent_id
                                              OR (sub_cat.parent_id IS NULL AND main_cat.id = bi.category_id)
      WHERE bi.id = $1 AND bi.workspace_owner_id = $2`,
    [id, ownerId],
  );

  if (result.rowCount === 0) {
    res.status(404).json({ error: "Base item not found" });
    return;
  }

  const baseItem = mapPublicBaseItem(result.rows[0]);
  respondWithCaching(
    req,
    res,
    { base_item: baseItem },
    result.rows[0].updated_at ? new Date(result.rows[0].updated_at) : null,
  );
});

// ---------------------------------------------------------------------------
// GET /api/public/catalog/brands
// Brand list with public logo/cover photo URLs.
// ---------------------------------------------------------------------------

router.get("/public/catalog/brands", async (req, res) => {
  const ctx = await resolveCtx(req, res);
  if (!ctx) return;
  const { ownerId } = ctx;

  type BrandPublicRow = {
    id: number;
    name: string;
    description: string | null;
    has_logo: boolean;
    logo_count: string;
    cover_photo_count: string;
    cover_photo_ids: string | null;
    updated_at: string | null;
    created_at: string;
  };

  const result = await db.query<BrandPublicRow>(
    `SELECT b.id, b.name, b.description,
            EXISTS(SELECT 1 FROM brand_logos bl WHERE bl.brand_id = b.id AND bl.deleted_at IS NULL) AS has_logo,
            (SELECT COUNT(*) FROM brand_logos bl WHERE bl.brand_id = b.id AND bl.deleted_at IS NULL)::text AS logo_count,
            (SELECT COUNT(*) FROM brand_cover_photos bcp WHERE bcp.brand_id = b.id)::text AS cover_photo_count,
            (SELECT json_agg(bcp.id ORDER BY bcp.created_at ASC)
               FROM brand_cover_photos bcp WHERE bcp.brand_id = b.id) AS cover_photo_ids,
            b.updated_at,
            b.created_at
       FROM brands b
      WHERE b.workspace_owner_id = $1
      ORDER BY b.created_at ASC`,
    [ownerId],
  );

  const brands = result.rows.map((row) => {
    const logoUrl = row.has_logo ? `/api/public/catalog/brands/${row.id}/logo` : null;
    const coverPhotoIds: number[] = Array.isArray(row.cover_photo_ids)
      ? row.cover_photo_ids
      : row.cover_photo_ids
        ? (JSON.parse(row.cover_photo_ids as unknown as string) as number[])
        : [];
    const coverPhotoUrls = coverPhotoIds.map(
      (pid) => `/api/public/catalog/brands/${row.id}/cover-photos/${pid}`,
    );
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      logo_url: logoUrl,
      cover_photo_urls: coverPhotoUrls,
      updated_at: row.updated_at,
      created_at: row.created_at,
    };
  });

  const lastModified = maxDate(result.rows.map((r) => r.updated_at ?? r.created_at));
  respondWithCaching(req, res, { brands }, lastModified);
});

// ---------------------------------------------------------------------------
// GET /api/public/catalog/brands/:id/logo
// Serve the primary brand logo as a binary image (no auth required).
// ---------------------------------------------------------------------------

router.get("/public/catalog/brands/:id/logo", async (req, res) => {
  const workspaceResult = await resolvePublicWorkspace(req);
  if ("error" in workspaceResult) {
    if (workspaceResult.error === "missing_workspace") {
      res.status(400).json({ error: "workspace query parameter is required" });
    } else {
      res.status(404).json({ error: "Workspace not found" });
    }
    return;
  }
  const { ownerId } = workspaceResult;

  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) {
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
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send(logo_data);
});

// ---------------------------------------------------------------------------
// GET /api/public/catalog/brands/:id/cover-photos/:photoId
// Serve a brand cover photo as a binary image (no auth required).
// ---------------------------------------------------------------------------

router.get("/public/catalog/brands/:id/cover-photos/:photoId", async (req, res) => {
  const workspaceResult = await resolvePublicWorkspace(req);
  if ("error" in workspaceResult) {
    if (workspaceResult.error === "missing_workspace") {
      res.status(400).json({ error: "workspace query parameter is required" });
    } else {
      res.status(404).json({ error: "Workspace not found" });
    }
    return;
  }
  const { ownerId } = workspaceResult;

  const brandId = parseInt(req.params.id, 10);
  const photoId = parseInt(req.params.photoId, 10);
  if (!Number.isFinite(brandId) || brandId <= 0 || !Number.isFinite(photoId) || photoId <= 0) {
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
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send(photo_data);
});

// ---------------------------------------------------------------------------
// GET /api/public/catalog/banners
// Active homepage banners in display order. Accepts ?workspace= param.
// ---------------------------------------------------------------------------

router.get("/public/catalog/banners", async (req, res) => {
  const ctx = await resolveCtx(req, res);
  if (!ctx) return;
  const { ownerId } = ctx;

  type BannerRow = {
    id: number;
    internal_name: string;
    title: string | null;
    headline: string | null;
    subtitle: string | null;
    cta_text: string | null;
    country_codes: string[];
    city_ids: number[];
    is_global_for_country: boolean;
    desktop_enabled: boolean;
    desktop_media_type: string | null;
    desktop_media_url: string | null;
    desktop_fallback_url: string | null;
    desktop_link_url: string | null;
    mobile_enabled: boolean;
    mobile_media_type: string | null;
    mobile_media_url: string | null;
    mobile_fallback_url: string | null;
    mobile_link_url: string | null;
    start_at: Date | null;
    end_at: Date | null;
    sort_order: number;
    priority: number;
    updated_at: Date;
  };

  const result = await db.query<BannerRow>(
    `SELECT id, internal_name, title, headline, subtitle, cta_text,
            country_codes, city_ids, is_global_for_country,
            desktop_enabled, desktop_media_type, desktop_media_url, desktop_fallback_url, desktop_link_url,
            mobile_enabled, mobile_media_type, mobile_media_url, mobile_fallback_url, mobile_link_url,
            start_at, end_at, sort_order, priority, updated_at
       FROM homepage_banners
      WHERE workspace_owner_id = $1
        AND is_active = true
      ORDER BY sort_order ASC, priority ASC, created_at DESC`,
    [ownerId],
  );

  const banners = result.rows.map((row) => ({
    id: row.id,
    internal_name: row.internal_name,
    title: row.title,
    headline: row.headline,
    subtitle: row.subtitle,
    cta_text: row.cta_text,
    country_codes: row.country_codes,
    city_ids: row.city_ids,
    is_global_for_country: row.is_global_for_country,
    desktop: {
      enabled: row.desktop_enabled,
      media_type: row.desktop_media_type,
      media_url: row.desktop_media_url,
      fallback_image_url: row.desktop_fallback_url,
      link_url: row.desktop_link_url,
    },
    mobile: {
      enabled: row.mobile_enabled,
      media_type: row.mobile_media_type,
      media_url: row.mobile_media_url,
      fallback_image_url: row.mobile_fallback_url,
      link_url: row.mobile_link_url,
    },
    start_at: row.start_at?.toISOString() ?? null,
    end_at: row.end_at?.toISOString() ?? null,
    sort_order: row.sort_order,
    priority: row.priority,
  }));

  const lastModified = maxDate(result.rows.map((r) => r.updated_at));
  respondWithCaching(req, res, { banners }, lastModified);
});

// ---------------------------------------------------------------------------
// GET /api/public/catalog/occasions
// Active occasions for the workspace, with optional city filter.
// Supports ?sort=best_selling to rank occasions by revenue (last 90 days,
// non-cancelled orders) descending; zero-revenue occasions fall back to
// manual sort_order.
// ---------------------------------------------------------------------------

router.get("/public/catalog/occasions", async (req, res) => {
  const ctx = await resolveCtx(req, res);
  if (!ctx) return;
  const { ownerId, cityId } = ctx;

  const featuredOnly = req.query.featured === "true";
  const sortBestSelling = req.query.sort === "best_selling";

  type OccasionRow = {
    id: number;
    name: string;
    slug: string;
    description: string | null;
    image_url: string | null;
    image_public_path: string | null;
    sort_order: number;
    is_featured: boolean;
    updated_at: Date | null;
  };

  const featuredClause = featuredOnly ? " AND o.is_featured = true" : "";

  // Revenue join: LEFT JOIN a 90-day revenue subquery so we can order by it.
  // Scoped to the workspace; cancelled orders are excluded.
  const revenueJoin = sortBestSelling
    ? `LEFT JOIN (
         SELECT po.attribute_id AS occasion_id,
                SUM(oli.line_total) AS total_revenue
           FROM product_occasions po
           JOIN order_line_items oli ON oli.product_id = po.product_id
           JOIN orders ord ON ord.id = oli.order_id
          WHERE ord.workspace_owner_id = $1
            AND ord.status != 'cancelled'
            AND ord.created_at >= NOW() - INTERVAL '90 days'
          GROUP BY po.attribute_id
       ) rev ON rev.occasion_id = o.id`
    : "";

  // When sorting by best-selling, rank by revenue DESC then fall back to
  // sort_order for ties and for occasions with no recorded sales (revenue = 0).
  const orderClause = sortBestSelling
    ? "COALESCE(rev.total_revenue, 0) DESC, o.sort_order ASC, o.name ASC"
    : "o.sort_order ASC, o.name ASC";

  const result = cityId !== null
    ? await db.query<OccasionRow>(
        `SELECT o.id, o.name, o.slug, o.description, o.image_url, o.image_public_path, o.sort_order, o.is_featured, o.updated_at
           FROM occasions o
           ${revenueJoin}
          WHERE o.workspace_owner_id = $1 AND o.is_active = true${featuredClause}
            AND NOT EXISTS (
              SELECT 1 FROM occasion_city_availability oca
               WHERE oca.occasion_id = o.id AND oca.city_id = $2 AND oca.is_enabled = false
            )
          ORDER BY ${orderClause}`,
        [ownerId, cityId],
      )
    : await db.query<OccasionRow>(
        `SELECT o.id, o.name, o.slug, o.description, o.image_url, o.image_public_path, o.sort_order, o.is_featured, o.updated_at
           FROM occasions o
           ${revenueJoin}
          WHERE o.workspace_owner_id = $1 AND o.is_active = true${featuredClause}
          ORDER BY ${orderClause}`,
        [ownerId],
      );

  const lastModified = maxDate(result.rows.map((r) => r.updated_at));
  const occasions = result.rows.map((r) => ({
    ...r,
    featured: Boolean(r.is_featured),
    image: r.image_url ?? null,
    image_public_url: buildPublicObjectUrl(r.image_public_path),
  }));
  respondWithCaching(req, res, { occasions }, lastModified);
});

// ---------------------------------------------------------------------------
// GET /api/public/catalog/categories
// Active catalog categories for the workspace, with optional city filter.
// ---------------------------------------------------------------------------

router.get("/public/catalog/categories", async (req, res) => {
  const ctx = await resolveCtx(req, res);
  if (!ctx) return;
  const { ownerId, cityId } = ctx;

  const featuredOnly = req.query.featured === "true";

  type CategoryRow = {
    id: number;
    name: string;
    slug: string;
    description: string | null;
    image_url: string | null;
    image_public_path: string | null;
    sort_order: number;
    is_featured: boolean;
    is_upsell: boolean;
    updated_at: Date | null;
  };

  const featuredClause = featuredOnly ? " AND cc.is_featured = true" : "";
  const featuredClauseNoAlias = featuredOnly ? " AND is_featured = true" : "";

  const result = cityId !== null
    ? await db.query<CategoryRow>(
        `SELECT cc.id, cc.name, cc.slug, cc.description, cc.image_url, cc.image_public_path, cc.sort_order, cc.is_featured, cc.is_upsell, cc.updated_at
           FROM catalog_categories cc
          WHERE cc.workspace_owner_id = $1 AND cc.is_active = true${featuredClause}
            AND NOT EXISTS (
              SELECT 1 FROM catalog_category_city_availability cca
               WHERE cca.catalog_category_id = cc.id AND cca.city_id = $2 AND cca.is_enabled = false
            )
          ORDER BY cc.sort_order ASC, cc.name ASC`,
        [ownerId, cityId],
      )
    : await db.query<CategoryRow>(
        `SELECT id, name, slug, description, image_url, image_public_path, sort_order, is_featured, is_upsell, updated_at
           FROM catalog_categories
          WHERE workspace_owner_id = $1 AND is_active = true${featuredClauseNoAlias}
          ORDER BY sort_order ASC, name ASC`,
        [ownerId],
      );

  const lastModified = maxDate(result.rows.map((r) => r.updated_at));
  const categories = result.rows.map((r) => ({
    ...r,
    featured: Boolean(r.is_featured),
    is_upsell: Boolean(r.is_upsell),
    image: r.image_url ?? null,
    image_public_url: buildPublicObjectUrl(r.image_public_path),
  }));
  respondWithCaching(req, res, { categories }, lastModified);
});

// ---------------------------------------------------------------------------
// GET /api/public/catalog/customers
// Owner-only: requires valid workspace API key. Paginated customer list.
// ---------------------------------------------------------------------------

router.get("/public/catalog/customers", requireApiKey, async (req, res) => {
  const apiReq = req as ApiKeyAuthedRequest;
  const ownerId = apiReq.userId;

  const page = Math.max(1, parseInt((req.query.page as string) || "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt((req.query.limit as string) || "50", 10)));
  const offset = (page - 1) * limit;
  const search = ((req.query.search as string) || "").trim();

  const conds: string[] = ["workspace_owner_id = $1"];
  const params: unknown[] = [ownerId];

  if (search) {
    const like = `%${search.replace(/([%_\\])/g, "\\$1")}%`;
    conds.push(
      `(COALESCE(first_name,'') ILIKE $2 ESCAPE '\\' OR COALESCE(last_name,'') ILIKE $2 ESCAPE '\\'` +
        ` OR COALESCE(email,'') ILIKE $2 ESCAPE '\\' OR COALESCE(phone,'') ILIKE $2 ESCAPE '\\')`,
    );
    params.push(like);
  }

  const where = conds.join(" AND ");
  const limitIdx = params.length + 1;
  const offsetIdx = params.length + 2;

  type CustomerRow = {
    id: number;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    phone: string | null;
    country: string | null;
    city: string | null;
    total_orders: number;
    total_spent: string;
    last_order_at: string | null;
    created_at: string;
  };

  const [rowsRes, countRes] = await Promise.all([
    db.query<CustomerRow>(
      `SELECT id, first_name, last_name, email, phone, country, city,
              total_orders, total_spent, last_order_at, created_at
         FROM customers
        WHERE ${where}
        ORDER BY created_at DESC, id DESC
        LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      [...params, limit, offset],
    ),
    db.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM customers WHERE ${where}`,
      params,
    ),
  ]);

  res.json({
    customers: rowsRes.rows,
    total: parseInt(String(countRes.rows[0]?.total ?? "0"), 10),
    page,
    limit,
  });
});

// ---------------------------------------------------------------------------
// GET /api/public/catalog/events
// Paginated public event list. Returns non-archived events by default.
// ---------------------------------------------------------------------------

router.get("/public/catalog/events", async (req, res) => {
  const ctx = await resolveCtx(req, res);
  if (!ctx) return;
  const { ownerId } = ctx;

  const rawPage = parseInt(typeof req.query.page === "string" ? req.query.page : "1", 10);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;
  const rawPageSize = parseInt(typeof req.query.pageSize === "string" ? req.query.pageSize : "25", 10);
  const pageSize = ([10, 25, 50, 100] as number[]).includes(rawPageSize) ? rawPageSize : 25;

  const includeUnavailable = req.query.include_unavailable === "true";

  const conditions: string[] = ["e.workspace_owner_id = $1", "e.is_archived = false"];
  const params: unknown[] = [ownerId];

  if (!includeUnavailable) {
    conditions.push("e.status = 'available'");
  }

  const q = typeof req.query.q === "string" && req.query.q.trim() ? req.query.q.trim() : null;
  if (q !== null) {
    params.push(`%${q.replace(/([%_\\])/g, "\\$1")}%`);
    conditions.push(`e.name ILIKE $${params.length} ESCAPE '\\'`);
  }

  const occasionFilter = typeof req.query.occasion === "string" && req.query.occasion.trim() ? req.query.occasion.trim() : null;
  if (occasionFilter !== null) {
    params.push(occasionFilter);
    conditions.push(
      `EXISTS (SELECT 1 FROM event_occasions eo JOIN occasions o ON o.id = eo.attribute_id WHERE eo.event_id = e.id AND lower(o.name) = lower($${params.length}))`,
    );
  }

  const where = conditions.join(" AND ");

  const countResult = await db.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM events e WHERE ${where}`,
    params,
  );
  const total = parseInt(countResult.rows[0]?.count ?? "0", 10);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const offset = (safePage - 1) * pageSize;

  params.push(pageSize);
  const limitParam = params.length;
  params.push(offset);
  const offsetParam = params.length;

  type PublicEventRow = {
    id: number;
    name: string;
    description: string | null;
    starting_price_usd: string | null;
    starting_price_aed: string | null;
    status: string;
    main_image_url: string | null;
    additional_image_urls: string[] | null;
    image_public_path: string | null;
    additional_image_public_paths: string[] | null;
    updated_at: string | null;
    occasions: string | null;
  };

  const result = await db.query<PublicEventRow>(
    `SELECT e.id, e.name, e.description, e.starting_price_usd, e.starting_price_aed,
            e.status, e.main_image_url, e.additional_image_urls,
            e.image_public_path, e.additional_image_public_paths,
            e.updated_at,
            (SELECT json_agg(json_build_object('id', o.id, 'name', o.name, 'slug', o.slug))
               FROM event_occasions eo
               JOIN occasions o ON o.id = eo.attribute_id
              WHERE eo.event_id = e.id) AS occasions
       FROM events e
      WHERE ${where}
      ORDER BY e.created_at DESC
      LIMIT $${limitParam} OFFSET $${offsetParam}`,
    params,
  );

  const lastModified = maxDate(result.rows.map((r) => r.updated_at));
  const payload = {
    events: result.rows.map((r) => {
      const { image_public_path, additional_image_public_paths, ...rest } = r;
      return {
        ...rest,
        main_image_public_url: buildPublicObjectUrl(image_public_path),
        additional_image_public_urls: (additional_image_public_paths ?? []).map((p) =>
          buildPublicObjectUrl(p),
        ),
        occasions: Array.isArray(r.occasions)
          ? r.occasions
          : r.occasions
            ? (JSON.parse(r.occasions as unknown as string) as object[])
            : [],
      };
    }),
    total,
    page: safePage,
    pageSize,
    totalPages,
  };
  respondWithCaching(req, res, payload, lastModified);
});

// ---------------------------------------------------------------------------
// GET /api/public/catalog/events/:id
// Single public event detail.
// ---------------------------------------------------------------------------

router.get("/public/catalog/events/:id", async (req, res) => {
  const ctx = await resolveCtx(req, res);
  if (!ctx) return;
  const { ownerId } = ctx;

  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "Invalid event id" });
    return;
  }

  type PublicEventDetailRow = {
    id: number;
    name: string;
    description: string | null;
    starting_price_usd: string | null;
    starting_price_aed: string | null;
    status: string;
    main_image_url: string | null;
    additional_image_urls: string[] | null;
    image_public_path: string | null;
    additional_image_public_paths: string[] | null;
    updated_at: string | null;
    occasions: string | null;
  };

  const result = await db.query<PublicEventDetailRow>(
    `SELECT e.id, e.name, e.description, e.starting_price_usd, e.starting_price_aed,
            e.status, e.main_image_url, e.additional_image_urls,
            e.image_public_path, e.additional_image_public_paths,
            e.updated_at,
            (SELECT json_agg(json_build_object('id', o.id, 'name', o.name, 'slug', o.slug))
               FROM event_occasions eo
               JOIN occasions o ON o.id = eo.attribute_id
              WHERE eo.event_id = e.id) AS occasions
       FROM events e
      WHERE e.id = $1 AND e.workspace_owner_id = $2 AND e.is_archived = false`,
    [id, ownerId],
  );

  if (result.rowCount === 0) {
    res.status(404).json({ error: "Event not found" });
    return;
  }

  const row = result.rows[0];
  const { image_public_path, additional_image_public_paths, ...rest } = row;
  const event = {
    ...rest,
    main_image_public_url: buildPublicObjectUrl(image_public_path),
    additional_image_public_urls: (additional_image_public_paths ?? []).map((p) =>
      buildPublicObjectUrl(p),
    ),
    occasions: Array.isArray(row.occasions)
      ? row.occasions
      : row.occasions
        ? (JSON.parse(row.occasions as unknown as string) as object[])
        : [],
  };

  respondWithCaching(req, res, { event }, row.updated_at ? new Date(row.updated_at) : null);
});

// ---------------------------------------------------------------------------
// GET /api/public/catalog/places
// Unauthenticated address-book place search for external website checkout.
//
// Returns only safe, curated fields — no internal_notes, entrance_notes,
// contact data, delivery history, audit events, ai_invalid, or counts.
// Only non-archived places with a trusted verification_state are returned.
//
// Query params:
//   workspace  — required; workspace slug or clerk user id
//   q          — optional; ILIKE search on canonical_name and alias_text
//   country / country_code — optional; filter by dc.country_code
//   city_slug / city_id    — optional; filter to one delivery city
// ---------------------------------------------------------------------------

router.get("/public/catalog/places", async (req, res) => {
  const ctx = await resolveCtx(req, res);
  if (!ctx) return;
  const { ownerId, cityId, countryCode } = ctx;

  const conditions: string[] = [
    "p.workspace_owner_id = $1",
    "p.archived_at IS NULL",
    // checkout_ready is the explicit per-place checkout gate (defaults to false).
    // Only places where staff have explicitly enabled checkout are surfaced here.
    "p.checkout_ready = true",
    "p.verification_state = ANY(ARRAY['ai_verified','staff_verified','delivery_verified']::place_verification_state[])",
    "p.latitude IS NOT NULL",
    "p.longitude IS NOT NULL",
    "p.location_conflict = false",
  ];
  const params: unknown[] = [ownerId];

  if (cityId !== null) {
    params.push(cityId);
    conditions.push(`p.city_id = $${params.length}`);
  }

  if (countryCode !== null) {
    params.push(countryCode.toUpperCase());
    conditions.push(`UPPER(dc.country_code) = $${params.length}`);
  }

  const q =
    typeof req.query.q === "string" && req.query.q.trim() ? req.query.q.trim() : null;
  if (q !== null) {
    const like = `%${q.replace(/([%_\\])/g, "\\$1")}%`;
    params.push(like);
    conditions.push(
      `(p.canonical_name ILIKE $${params.length} ESCAPE '\\' OR EXISTS (
         SELECT 1 FROM place_aliases pa
          WHERE pa.place_id = p.id
            AND pa.deleted_at IS NULL
            AND pa.approval_state = 'approved'
            AND pa.alias_text ILIKE $${params.length} ESCAPE '\\'
       ))`,
    );
  }

  const where = conditions.join(" AND ");

  type PublicPlaceRow = {
    id: string;
    canonical_name: string;
    place_type: string;
    area: string | null;
    city_name: string | null;
    country_code: string | null;
    latitude: string | null;
    longitude: string | null;
    verification_state: string;
    aliases: string | null;
    updated_at: string;
  };

  const result = await db.query<PublicPlaceRow>(
    `SELECT p.id, p.canonical_name, p.place_type, p.area,
            dc.name AS city_name, dc.country_code,
            p.latitude, p.longitude, p.verification_state,
            p.updated_at,
            (SELECT json_agg(pa.alias_text ORDER BY pa.created_at ASC)
               FROM place_aliases pa
              WHERE pa.place_id = p.id
                AND pa.deleted_at IS NULL
                AND pa.approval_state = 'approved') AS aliases
       FROM places p
       LEFT JOIN delivery_cities dc ON dc.id = p.city_id
      WHERE ${where}
      ORDER BY p.canonical_name ASC
      LIMIT 20`,
    params,
  );

  const places = result.rows.map((r) => ({
    id: r.id,
    canonicalName: r.canonical_name,
    placeType: r.place_type,
    area: r.area ?? null,
    cityName: r.city_name ?? null,
    country: r.country_code ?? null,
    aliases: Array.isArray(r.aliases)
      ? (r.aliases as string[])
      : r.aliases
        ? (JSON.parse(r.aliases as unknown as string) as string[])
        : [],
    latitude: r.latitude != null ? parseFloat(r.latitude) : null,
    longitude: r.longitude != null ? parseFloat(r.longitude) : null,
    verificationState: r.verification_state,
  }));

  res.json({ places });
});

export default router;
