import { Router, type Request, type Response } from "express";
import { db } from "../lib/db";
import { resolveApiKeyWorkspace } from "../lib/apiKeyAuth";
import { PUBLIC_OBJECT_HOST, buildPublicObjectUrl } from "../lib/objectStorage";

const router = Router();

/** Maximum page size accepted from the `pageSize` query param. */
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;

/**
 * Convert a stored image reference into an absolute, publicly addressable URL.
 *
 * Product images are stored as workspace-relative object paths
 * (e.g. `/objects/<owner>/products/<uuid>`) which are served by the object
 * route at `/api/storage/objects/<owner>/...`. External consumers need an
 * absolute URL, so we prefix the public host (PUBLIC_BASE_URL when configured,
 * otherwise the shared PUBLIC_OBJECT_HOST). Values that are already absolute
 * (http/https) are passed through unchanged.
 */
function toAbsoluteImageUrl(stored: string | null | undefined): string | null {
  if (!stored) return null;
  const trimmed = stored.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;

  const base = (process.env.PUBLIC_BASE_URL?.replace(/\/+$/, "")) || PUBLIC_OBJECT_HOST;

  // Stored private object path → served via the storage object route.
  if (trimmed.startsWith("/objects/")) {
    return `${base}/api/storage${trimmed}`;
  }
  // Any other root-relative serving path (e.g. /api/storage/...).
  if (trimmed.startsWith("/")) {
    return `${base}${trimmed}`;
  }
  return `${base}/${trimmed}`;
}

/**
 * GET /api/products  (API-key authenticated variant)
 *
 * Returns products in a camelCase shape suitable for external storefronts.
 * Falls through (calls next()) when no API key is present so the Clerk-auth
 * internal route can handle the request.
 *
 * Query params:
 *   countryCode  — filter to products available in cities of that country (e.g. lb, ae)
 *   cityId       — filter by city slug (e.g. beirut)
 *   q            — name search
 *   inStockOnly  — "true" to return only status=available products (default: true for external)
 *   page         — integer ≥ 1 (default 1)
 *   pageSize     — any positive integer, capped at 100 (default 25)
 *
 * Response:
 *   { products: [...], total, page, pageSize, totalPages }
 *
 * Product shape:
 *   id, sku, name, price (USD), inStock, featured, images[{url,alt}],
 *   categories[{id,slug,name}], occasions[{id,slug,name}], brands[{id,slug,name}],
 *   deliverableCountries (string[]), deliverableCities (string[])
 *
 * Image URLs are absolute (prefixed with PUBLIC_BASE_URL / PUBLIC_OBJECT_HOST).
 *
 * deliverableCities / deliverableCountries:
 *   Per-product availability follows the same default-on, toggle-off model used
 *   across the catalog: a product is deliverable to EVERY active workspace
 *   delivery city by default, and owners disable specific cities via an explicit
 *   product_city_availability row (is_available = false). The response therefore
 *   returns every active workspace city slug / country code EXCEPT those a
 *   product has explicitly disabled. A product disabled in every city returns
 *   empty lists. The countryCode / cityId filters honor the same model.
 */
router.get("/products", async (req: Request, res: Response, next) => {
  const ownerId = await resolveApiKeyWorkspace(req);
  if (!ownerId) {
    next();
    return;
  }

  const q = typeof req.query.q === "string" && req.query.q.trim() ? req.query.q.trim() : null;
  const countryCode = typeof req.query.countryCode === "string" && req.query.countryCode.trim()
    ? req.query.countryCode.trim().toUpperCase() : null;
  const citySlug = typeof req.query.cityId === "string" && req.query.cityId.trim()
    ? req.query.cityId.trim().toLowerCase() : null;
  const inStockOnly = req.query.inStockOnly !== "false";

  const rawPage = parseInt(typeof req.query.page === "string" ? req.query.page : "1", 10);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;
  const rawPageSize = parseInt(typeof req.query.pageSize === "string" ? req.query.pageSize : "", 10);
  const pageSize = Number.isFinite(rawPageSize) && rawPageSize >= 1
    ? Math.min(rawPageSize, MAX_PAGE_SIZE)
    : DEFAULT_PAGE_SIZE;

  const conditions: string[] = ["p.workspace_owner_id = $1", "p.is_archived = false"];
  const params: unknown[] = [ownerId];

  if (inStockOnly) {
    conditions.push("p.status = 'available'");
  }
  if (q !== null) {
    params.push(`%${q.replace(/([%_\\])/g, "\\$1")}%`);
    conditions.push(`p.name ILIKE $${params.length} ESCAPE '\\'`);
  }
  // City/country filters follow the default-on, toggle-off availability model:
  // a product is deliverable to every active workspace delivery city unless an
  // explicit product_city_availability row disables that city (is_available =
  // false). So a product matches a country/city filter when at least one active
  // workspace city in that country/with that slug is NOT explicitly disabled.
  if (countryCode !== null) {
    params.push(countryCode);
    conditions.push(
      `EXISTS (
        SELECT 1 FROM delivery_cities dc2
        WHERE dc2.workspace_owner_id = p.workspace_owner_id
          AND dc2.is_active = true
          AND UPPER(dc2.country_code) = $${params.length}
          AND NOT EXISTS (
            SELECT 1 FROM product_city_availability pca2
            WHERE pca2.product_id = p.id AND pca2.city_id = dc2.id
              AND pca2.is_available = false
          )
      )`,
    );
    // Parallel default-on country guard: also hide products explicitly disabled
    // for this country at the country-availability level.
    conditions.push(
      `NOT EXISTS (
        SELECT 1 FROM product_country_availability pcoa
        WHERE pcoa.product_id = p.id AND UPPER(pcoa.country_code) = $${params.length}
          AND pcoa.is_available = false
      )`,
    );
  }
  if (citySlug !== null) {
    params.push(citySlug);
    conditions.push(
      `EXISTS (
        SELECT 1 FROM delivery_cities dc3
        WHERE dc3.workspace_owner_id = p.workspace_owner_id
          AND dc3.is_active = true
          AND dc3.slug = $${params.length}
          AND NOT EXISTS (
            SELECT 1 FROM product_city_availability pca3
            WHERE pca3.product_id = p.id AND pca3.city_id = dc3.id
              AND pca3.is_available = false
          )
          AND NOT EXISTS (
            SELECT 1 FROM product_country_availability pcoa3
            WHERE pcoa3.product_id = p.id
              AND UPPER(pcoa3.country_code) = UPPER(dc3.country_code)
              AND pcoa3.is_available = false
          )
      )`,
    );
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

  params.push(pageSize, offset);
  const limitParam = params.length - 1;
  const offsetParam = params.length;

  type ProductRow = {
    id: string;
    sku: string | null;
    name: string;
    price_usd: string | null;
    price_aed: string | null;
    discount_price_usd: string | null;
    discount_price_aed: string | null;
    status: string;
    main_image_url: string | null;
    additional_image_urls: string[] | null;
    image_public_path: string | null;
    additional_image_public_paths: string[] | null;
    description: string | null;
    tags: string[] | null;
    brand: string | null;
    has_input_field: boolean;
    letter_input_enabled: boolean;
    is_upsell: boolean;
    occasions_json: unknown;
    catalog_categories_json: unknown;
    catalog_brands_json: unknown;
    deliverable_cities: string[] | null;
    deliverable_countries: string[] | null;
  };

  const result = await db.query<ProductRow>(
    `SELECT
        p.id, p.sku, p.name, p.price_usd, p.price_aed,
        p.discount_price_usd, p.discount_price_aed, p.status,
        p.main_image_url, p.additional_image_urls,
        p.image_public_path, p.additional_image_public_paths,
        p.description, p.tags,
        p.brand, p.has_input_field, p.letter_input_enabled, p.is_upsell,
        (
          SELECT COALESCE(
            json_agg(json_build_object('id', o.id, 'slug', o.slug, 'name', o.name)
                     ORDER BY o.name),
            '[]'::json
          )
          FROM product_occasions po
          JOIN occasions o ON o.id = po.attribute_id
          WHERE po.product_id = p.id
        ) AS occasions_json,
        (
          SELECT COALESCE(
            json_agg(json_build_object('id', cc.id, 'slug', cc.slug, 'name', cc.name)
                     ORDER BY cc.name),
            '[]'::json
          )
          FROM product_catalog_categories pcc
          JOIN catalog_categories cc ON cc.id = pcc.attribute_id
          WHERE pcc.product_id = p.id
        ) AS catalog_categories_json,
        (
          SELECT COALESCE(
            json_agg(json_build_object('id', cb.id, 'slug', cb.slug, 'name', cb.name)
                     ORDER BY cb.name),
            '[]'::json
          )
          FROM product_catalog_brands pcb
          JOIN catalog_brands cb ON cb.id = pcb.attribute_id
          WHERE pcb.product_id = p.id
        ) AS catalog_brands_json,
        (
          SELECT COALESCE(array_agg(DISTINCT dc.slug), ARRAY[]::text[])
          FROM delivery_cities dc
          WHERE dc.workspace_owner_id = p.workspace_owner_id
            AND dc.is_active = true
            AND NOT EXISTS (
              SELECT 1 FROM product_city_availability pca
              WHERE pca.product_id = p.id AND pca.city_id = dc.id
                AND pca.is_available = false
            )
            AND NOT EXISTS (
              SELECT 1 FROM product_country_availability pcoa
              WHERE pcoa.product_id = p.id
                AND UPPER(pcoa.country_code) = UPPER(dc.country_code)
                AND pcoa.is_available = false
            )
        ) AS deliverable_cities,
        (
          SELECT COALESCE(array_agg(DISTINCT UPPER(dc.country_code)), ARRAY[]::text[])
          FROM delivery_cities dc
          WHERE dc.workspace_owner_id = p.workspace_owner_id
            AND dc.is_active = true
            AND NOT EXISTS (
              SELECT 1 FROM product_city_availability pca
              WHERE pca.product_id = p.id AND pca.city_id = dc.id
                AND pca.is_available = false
            )
            AND NOT EXISTS (
              SELECT 1 FROM product_country_availability pcoa
              WHERE pcoa.product_id = p.id
                AND UPPER(pcoa.country_code) = UPPER(dc.country_code)
                AND pcoa.is_available = false
            )
        ) AS deliverable_countries
      FROM products p
     WHERE ${where}
     ORDER BY p.created_at DESC
     LIMIT $${limitParam} OFFSET $${offsetParam}`,
    params,
  );

  const products = result.rows.map((p) => {
    const images: Array<{ url: string; alt: string }> = [];
    // Prefer the public, auth-free copy; fall back to the (possibly
    // auth-required) absolute URL of the private object when no public copy
    // exists yet.
    const mainUrl =
      buildPublicObjectUrl(p.image_public_path) ?? toAbsoluteImageUrl(p.main_image_url);
    if (mainUrl) images.push({ url: mainUrl, alt: p.name });
    const additionalPublicPaths = p.additional_image_public_paths ?? [];
    (p.additional_image_urls ?? []).forEach((url, i) => {
      const abs =
        buildPublicObjectUrl(additionalPublicPaths[i]) ?? toAbsoluteImageUrl(url);
      if (abs) images.push({ url: abs, alt: p.name });
    });

    type AttrItem = { id: number | string; slug: string; name: string };
    const occasions = Array.isArray(p.occasions_json) ? (p.occasions_json as AttrItem[]) : [];
    const catalogCategories = Array.isArray(p.catalog_categories_json)
      ? (p.catalog_categories_json as AttrItem[]) : [];
    const catalogBrands = Array.isArray(p.catalog_brands_json)
      ? (p.catalog_brands_json as AttrItem[]) : [];

    // Categories come straight from the catalog-category join (the legacy
    // free-text category column has been retired).
    const categories: AttrItem[] = [...catalogCategories];

    // Merge catalog brands with the legacy text brand field.
    const brands: AttrItem[] = [...catalogBrands];
    if (p.brand && !brands.some((b) => b.name.toLowerCase() === p.brand!.toLowerCase())) {
      const slug = p.brand.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
      brands.push({ id: slug, slug, name: p.brand });
    }

    // Per-product delivery availability (default-on, toggle-off model):
    // every active workspace delivery city is included unless the product has an
    // explicit product_city_availability row disabling that city. A product the
    // owner has disabled everywhere therefore returns empty lists.
    const deliverableCities = p.deliverable_cities ?? [];
    const deliverableCountries = p.deliverable_countries ?? [];

    return {
      id: p.id,
      sku: p.sku ?? null,
      name: p.name,
      description: p.description ?? null,
      price: p.price_usd != null ? parseFloat(p.price_usd) : null,
      priceAed: p.price_aed != null ? parseFloat(p.price_aed) : null,
      discountPrice: p.discount_price_usd != null ? parseFloat(p.discount_price_usd) : null,
      discountPriceAed: p.discount_price_aed != null ? parseFloat(p.discount_price_aed) : null,
      inStock: p.status === "available",
      featured: false,
      hasInputField: p.has_input_field === true,
      letterInputEnabled: p.letter_input_enabled === true,
      hasLetterField: p.letter_input_enabled === true,
      isUpsell: p.is_upsell === true,
      images,
      categories,
      occasions,
      brands,
      tags: p.tags ?? [],
      deliverableCountries,
      deliverableCities,
    };
  });

  res.json({ products, total, page: safePage, pageSize, totalPages });
});

export default router;
