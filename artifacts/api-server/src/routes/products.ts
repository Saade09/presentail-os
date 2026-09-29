import { Router, type Request, type Response } from "express";
import multer from "multer";
import { randomUUID } from "crypto";
import sharp from "sharp";
import { smartResizeBuffer } from "../lib/imageResize";
import { z } from "zod";
import { db } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { hasPageAccess, resolveWorkspace, workspace } from "../lib/workspace";
import { hasCmcPosNewOrderAccess } from "../lib/cmcAccess";
import { buildPublicObjectUrl, objectStorageClient } from "../lib/objectStorage";
import { logger } from "../lib/logger";
import { maybeAutoActivateLocationsByBrand } from "../lib/locationSetup";
import { autoPublishToChannels as autoPublishToChannelsRaw, notifyProductChanged as notifyProductChangedRaw } from "../lib/productPublishing";
import type { ProductWebhookEvent } from "../lib/productWebhook";
import { fireCatalogDataWebhook as fireCatalogDataWebhookRaw } from "../lib/catalogWebhook";
import { syncProductPublicImages as syncProductPublicImagesRaw } from "../lib/productPublicImages";
import { getCountryMetadata, isExcludedCountry, DEFAULT_COUNTRIES } from "../lib/defaults";
import {
  enqueueProductCreateOrUpdateSync as enqueueProductCreateOrUpdateSyncRaw,
  enqueueProductDeleteSync as enqueueProductDeleteSyncRaw,
  enqueueMerchantSyncBackfill,
  enqueueSelectedMerchantSync,
  enqueueSelectedMerchantUnsync,
} from "../lib/merchantSyncQueue";
import { buildMerchantProductInput } from "../lib/googleMerchant";
import { insertProductInput, buildInsertBody, verifyMerchantAccountAccess, fetchProductStatus, getMerchantConfigStatus } from "../lib/merchantCenterClient";
import { deriveProductsResourceName } from "../lib/merchantSyncJob";
import {
  approveDeletionItems,
  approveReconciliationRun,
  applyApprovedDeleteBatch,
  applyApprovedRun,
  createMarketReconciliationDryRuns,
  merchantReconciliationExecutionEnabled,
} from "../lib/merchantReconciliation";

// Fire-and-forget integrations are still observed: a rejected post-commit
// promise must not become an unhandled rejection after the response is sent.
function reportPostCommitFailure(err: unknown, operation: string): void {
  logger.error({ err, operation }, "Product post-commit side effect failed");
}
function runPostCommit(operation: string, invoke: () => unknown): void {
  try {
    void Promise.resolve(invoke()).catch((err) => reportPostCommitFailure(err, operation));
  } catch (err) {
    reportPostCommitFailure(err, operation);
  }
}
function enqueueProductCreateOrUpdateSync(...args: Parameters<typeof enqueueProductCreateOrUpdateSyncRaw>): void {
  runPostCommit("merchant create/update", () => enqueueProductCreateOrUpdateSyncRaw(...args));
}
function enqueueProductDeleteSync(...args: Parameters<typeof enqueueProductDeleteSyncRaw>): void {
  runPostCommit("merchant delete", () => enqueueProductDeleteSyncRaw(...args));
}
function autoPublishToChannels(...args: Parameters<typeof autoPublishToChannelsRaw>): void {
  runPostCommit("channel publish", () => autoPublishToChannelsRaw(...args));
}
function notifyProductChanged(...args: Parameters<typeof notifyProductChangedRaw>): void {
  runPostCommit("product notification", () => notifyProductChangedRaw(...args));
}
function fireCatalogDataWebhook(...args: Parameters<typeof fireCatalogDataWebhookRaw>): void {
  runPostCommit("catalog webhook", () => fireCatalogDataWebhookRaw(...args));
}
function syncProductPublicImages(...args: Parameters<typeof syncProductPublicImagesRaw>): void {
  runPostCommit("public image sync", () => syncProductPublicImagesRaw(...args));
}

const router = Router();
/** Merchant reconciliation controls external inventory and is owner-only. */
export function merchantReconciliationOwnerOnly(role: string | undefined): boolean {
  return role === "owner";
}

const productRowSchema = z
  .object({
    id: z.number().int(),
    workspace_owner_id: z.string(),
    name: z.string(),
    price_usd: z.union([z.string(), z.number()]).nullable(),
    price_aed: z.union([z.string(), z.number()]).nullable(),
    discount_price_usd: z.union([z.string(), z.number()]).nullable().optional(),
    discount_price_aed: z.union([z.string(), z.number()]).nullable().optional(),
    main_image_url: z.string().nullable(),
    additional_image_urls: z.array(z.string()).nullable(),
    description: z.string().nullable(),
    status: z.string(),
    brand: z.string().nullable(),
    tags: z.array(z.string()).nullable(),
    category: z.string().nullable(),
    sku: z.string().nullable(),
    created_at: z.union([z.string(), z.date()]),
    is_archived: z.boolean().optional(),
    cogs_usd: z.union([z.string(), z.number()]).nullable().optional(),
    updated_at: z.union([z.string(), z.date()]).nullable().optional(),
    delivery_disabled_count: z.coerce.number().int().optional(),
  })
  .passthrough();

const productsListResponseSchema = z.object({
  products: z.array(productRowSchema),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
  totalPages: z.number().int(),
  total_delivery_cities: z.number().int(),
});

const orderCatalogProductSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  price_usd: z.union([z.string(), z.number()]).nullable(),
  price_aed: z.union([z.string(), z.number()]).nullable(),
  main_image_url: z.string().nullable(),
  main_image_display_url: z.string().nullable(),
  main_image_thumbnail_url: z.string().nullable(),
  status: z.string(),
  sku: z.string().nullable(),
  has_input_field: z.boolean(),
  letter_input_enabled: z.boolean(),
});

const orderCatalogResponseSchema = z.object({
  products: z.array(orderCatalogProductSchema),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
  totalPages: z.number().int(),
});

function sendValidated<T>(
  req: Request,
  res: Response,
  schema: z.ZodType<T>,
  payload: unknown,
  route: string,
): void {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    req.log.error(
      { err: parsed.error.issues, route },
      "Response validation failed",
    );
    res.status(500).json({ error: "Internal server error" });
    return;
  }
  res.json(parsed.data);
}

/**
 * Resolve an optional discount (sale) price from a request body field.
 * Empty/absent values mean "no sale" (null). When provided it must be a
 * non-negative number and strictly less than the corresponding regular price.
 */
function resolveDiscountPrice(
  raw: unknown,
  regular: number,
  label: string,
): { error: string } | { value: number | null } {
  if (
    raw === undefined ||
    raw === null ||
    (typeof raw === "string" && raw.trim() === "")
  ) {
    return { value: null };
  }
  const parsed = parseFloat(String(raw));
  if (isNaN(parsed) || parsed < 0) {
    return { error: `${label} must be a non-negative number` };
  }
  if (parsed >= regular) {
    return { error: `${label} must be less than the regular price` };
  }
  return { value: parsed };
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

router.use(requireAuth, resolveWorkspace);

/**
 * GET /api/order-catalog/products
 *
 * Least-privilege catalog read for the two order-creation flows. This must
 * remain outside the /products permission middleware: the regular Products
 * endpoints expose management and reporting data and intentionally require
 * Products-page access.
 */
router.get("/order-catalog/products", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPageAccess(wreq, "orders") && !hasCmcPosNewOrderAccess(wreq)) {
    res.status(403).json({ error: "You do not have access to create orders" });
    return;
  }

  const f = parseProductFilterParams(req);
  const pageRaw = parseInt(typeof req.query.page === "string" ? req.query.page : "1", 10);
  const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? pageRaw : 1;
  const pageSizeRaw = parseInt(
    typeof req.query.pageSize === "string" ? req.query.pageSize : "25",
    10,
  );
  const pageSize = (VALID_PAGE_SIZES as readonly number[]).includes(pageSizeRaw)
    ? pageSizeRaw
    : 25;

  const conditions: string[] = [
    "p.workspace_owner_id = $1",
    "p.is_archived = false",
  ];
  const params: unknown[] = [wreq.workspaceOwnerId];

  if (f.statusValues.length > 0) {
    const placeholders = f.statusValues.map((status) => {
      params.push(status);
      return `$${params.length}`;
    });
    conditions.push(`p.status IN (${placeholders.join(", ")})`);
  }
  appendContentFilterConditions(f, conditions, params);

  const whereClause = conditions.join(" AND ");
  const countResult = await db.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM products p WHERE ${whereClause}`,
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

  type OrderCatalogImageRow = {
    id: number;
    name: string;
    price_usd: string | number | null;
    price_aed: string | number | null;
    main_image_url: string | null;
    image_display_public_path: string | null;
    image_thumbnail_public_path: string | null;
    status: string;
    sku: string | null;
    has_input_field: boolean;
    letter_input_enabled: boolean;
  };

  const result = await db.query<OrderCatalogImageRow>(
    `SELECT p.id, p.name, p.price_usd, p.price_aed, p.main_image_url,
            p.image_display_public_path, p.image_thumbnail_public_path,
            p.status, p.sku, p.has_input_field, p.letter_input_enabled
       FROM products p
      WHERE ${whereClause}
      ORDER BY p.created_at DESC
      LIMIT $${limitParam} OFFSET $${offsetParam}`,
    params,
  );

  sendValidated(
    req,
    res,
    orderCatalogResponseSchema,
    {
      products: result.rows.map((product) => ({
        id: product.id,
        name: product.name,
        price_usd: product.price_usd,
        price_aed: product.price_aed,
        main_image_url: product.main_image_url,
        main_image_display_url:
          buildPublicObjectUrl(product.image_display_public_path) ?? product.main_image_url,
        main_image_thumbnail_url:
          buildPublicObjectUrl(product.image_thumbnail_public_path) ?? product.main_image_url,
        status: product.status,
        sku: product.sku,
        has_input_field: product.has_input_field,
        letter_input_enabled: product.letter_input_enabled,
      })),
      total,
      page: safePage,
      pageSize,
      totalPages,
    },
    "GET /order-catalog/products",
  );
});

router.use("/products", (req, res, next) => {
  if (
    req.method !== "GET" ||
    hasPageAccess(workspace(req), "products") ||
    hasPageAccess(workspace(req), "products.manage")
  ) {
    next();
    return;
  }
  res.status(403).json({ error: "You do not have access to products" });
});

const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp"] as const;
const VALID_STATUSES = ["available", "out_of_stock", "not_available"] as const;
const MAX_ADDITIONAL_IMAGES = 5;
const MAX_IMAGE_DIMENSION = 4096;
const MAX_SOURCE_IMAGE_BYTES = 50 * 1024 * 1024;

/**
 * Returns true when url is null/empty OR is an object path scoped to the given workspace.
 * Prevents one workspace from referencing another workspace's private objects.
 */
function isOwnedObjectPath(url: string | null, workspaceOwnerId: string): boolean {
  if (!url) return true;
  return url.startsWith(`/objects/${workspaceOwnerId}/`);
}

type ProductRow = {
  id: number;
  workspace_owner_id: string;
  name: string;
  price_usd: string;
  price_aed: string;
  discount_price_usd?: string | null;
  discount_price_aed?: string | null;
  main_image_url: string | null;
  additional_image_urls: string[];
  image_public_path?: string | null;
  additional_image_public_paths?: Array<string | null> | null;
  image_display_public_path?: string | null;
  image_thumbnail_public_path?: string | null;
  additional_image_display_public_paths?: Array<string | null> | null;
  additional_image_thumbnail_public_paths?: Array<string | null> | null;
  description: string | null;
  status: string;
  brand: string | null;
  tags: string[];
  category: string | null;
  sku: string | null;
  created_at: string;
  is_archived: boolean;
  express_delivery_enabled: boolean;
  has_input_field: boolean;
  letter_input_enabled: boolean;
  is_upsell: boolean;
  is_cmc: boolean;
  inventory_tracked: boolean;
  catalog_brand?: AttributeLink | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
};

function decorateProductImageUrls(row: ProductRow): ProductRow {
  const {
    image_public_path,
    additional_image_public_paths,
    image_display_public_path,
    image_thumbnail_public_path,
    additional_image_display_public_paths,
    additional_image_thumbnail_public_paths,
    ...product
  } = row;
  const additionalSources = Array.isArray(row.additional_image_urls)
    ? row.additional_image_urls
    : [];
  const mapAdditional = (
    paths: Array<string | null> | null | undefined,
    allowPrivateFallback: boolean,
  ) =>
    additionalSources.map((source, index) =>
      buildPublicObjectUrl(paths?.[index]) ??
      (allowPrivateFallback ? source : /^https?:\/\//i.test(source) ? source : null),
    );

  return {
    ...product,
    main_image_public_url:
      buildPublicObjectUrl(image_public_path) ??
      (/^https?:\/\//i.test(row.main_image_url ?? "") ? row.main_image_url : null),
    main_image_display_url:
      buildPublicObjectUrl(image_display_public_path) ?? row.main_image_url,
    main_image_thumbnail_url:
      buildPublicObjectUrl(image_thumbnail_public_path) ?? row.main_image_url,
    additional_image_public_urls: mapAdditional(additional_image_public_paths, false),
    additional_image_display_urls: mapAdditional(additional_image_display_public_paths, true),
    additional_image_thumbnail_urls: mapAdditional(additional_image_thumbnail_public_paths, true),
  };
}

/** One option in the combined Catalog-Category + Occasion picker. */
type ProductCategoryOption = {
  kind: "catalog_category" | "occasion";
  id: number;
  name: string;
  slug: string;
};

/** A catalog-category / occasion link attached to a product response. */
type AttributeLink = { id: number; name: string; slug: string };

/**
 * SQL fragment that aggregates a product's linked catalog categories and
 * occasions into two JSON array columns. `alias` is the table alias of the
 * `products` row in the surrounding query (a server-side constant, never user
 * input). Produces columns `catalog_categories` and `occasions`.
 */
function attributeAggSql(alias: string): string {
  return `
    COALESCE((
      SELECT json_agg(json_build_object('id', cc.id, 'name', cc.name, 'slug', cc.slug) ORDER BY cc.name)
        FROM product_catalog_categories pcc
        JOIN catalog_categories cc ON cc.id = pcc.attribute_id
       WHERE pcc.product_id = ${alias}.id
    ), '[]'::json) AS catalog_categories,
    COALESCE((
      SELECT json_agg(json_build_object('id', o.id, 'name', o.name, 'slug', o.slug) ORDER BY o.name)
        FROM product_occasions po
        JOIN occasions o ON o.id = po.attribute_id
       WHERE po.product_id = ${alias}.id
    ), '[]'::json) AS occasions`;
}

/**
 * Replaces the set of catalog-category or occasion links for a product. Only
 * IDs that belong to the workspace are linked (invalid IDs are silently
 * dropped). Returns the resolved {id,name,slug} rows that were linked, for
 * echoing back in the API response. `joinTable` / `attrTable` are server-side
 * literals, never user input, so interpolation is safe.
 */
async function replaceProductAttributeLinks(
  productId: number,
  ownerId: string,
  joinTable: "product_catalog_categories" | "product_occasions",
  attrTable: "catalog_categories" | "occasions",
  ids: number[],
): Promise<AttributeLink[]> {
  let valid: AttributeLink[] = [];
  if (ids.length > 0) {
    const r = await db.query<AttributeLink>(
      `SELECT id, name, slug FROM ${attrTable}
        WHERE id = ANY($1) AND workspace_owner_id = $2
        ORDER BY name`,
      [ids, ownerId],
    );
    valid = r.rows;
  }
  await db.query(`DELETE FROM ${joinTable} WHERE product_id = $1`, [productId]);
  for (const link of valid) {
    await db.query(
      `INSERT INTO ${joinTable} (product_id, attribute_id) VALUES ($1, $2)
       ON CONFLICT (product_id, attribute_id) DO NOTHING`,
      [productId, link.id],
    );
  }
  return valid;
}

/**
 * Replaces a product's single optional catalog-brand link (via the
 * product_catalog_brands join). Pass `null` to clear it. The brand id is
 * validated against catalog_brands scoped to the workspace; an unknown id
 * results in no link. Returns the linked brand (or null).
 */
async function replaceProductCatalogBrand(
  productId: number,
  ownerId: string,
  brandId: number | null,
): Promise<AttributeLink | null> {
  let valid: AttributeLink | null = null;
  if (brandId !== null) {
    const r = await db.query<AttributeLink>(
      `SELECT id, name, slug FROM catalog_brands
        WHERE id = $1 AND workspace_owner_id = $2`,
      [brandId, ownerId],
    );
    valid = r.rows[0] ?? null;
  }
  await db.query(`DELETE FROM product_catalog_brands WHERE product_id = $1`, [productId]);
  if (valid) {
    await db.query(
      `INSERT INTO product_catalog_brands (product_id, attribute_id) VALUES ($1, $2)
       ON CONFLICT (product_id, attribute_id) DO NOTHING`,
      [productId, valid.id],
    );
  }
  return valid;
}

/**
 * Parses a request body field that should be a single optional catalog-brand id.
 * Returns `undefined` when the field is absent (leave links untouched), `null`
 * when explicitly cleared (empty string / null), or a positive integer.
 */
function parseCatalogBrandId(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const n = typeof value === "number" ? value : parseInt(String(value), 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Fetches the single catalog-brand currently linked to a product (or null).
 */
async function fetchProductCatalogBrand(productId: number): Promise<AttributeLink | null> {
  const r = await db.query<AttributeLink>(
    `SELECT cb.id, cb.name, cb.slug
       FROM product_catalog_brands pcb
       JOIN catalog_brands cb ON cb.id = pcb.attribute_id
      WHERE pcb.product_id = $1
      ORDER BY cb.name ASC
      LIMIT 1`,
    [productId],
  );
  return r.rows[0] ?? null;
}

/**
 * Parses a request-body field that should be an array of attribute IDs. Returns
 * `null` when the field is absent (meaning "do not touch the links"), or a
 * de-duplicated array of positive integers when present (an empty array clears
 * all links).
 */
function parseAttributeIds(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const ids = value
    .map((v) => (typeof v === "number" ? v : parseInt(String(v), 10)))
    .filter((n) => Number.isInteger(n) && n > 0);
  return Array.from(new Set(ids));
}

const SKU_MAX_ATTEMPTS = 20;
const _parsedThreshold = parseInt(process.env.SKU_WARN_THRESHOLD ?? "10", 10);
const SKU_WARN_THRESHOLD = Number.isFinite(_parsedThreshold) && _parsedThreshold > 0 ? _parsedThreshold : 10;

async function generateUniqueSku(workspaceOwnerId: string): Promise<string> {
  for (let attempt = 0; attempt < SKU_MAX_ATTEMPTS; attempt++) {
    const candidate = String(Math.floor(Math.random() * 10_000_000)).padStart(7, "0");
    const existing = await db.query<{ id: number }>(
      `SELECT id FROM products WHERE sku = $1 AND workspace_owner_id = $2`,
      [candidate, workspaceOwnerId],
    );
    if (existing.rowCount === 0) {
      if (attempt >= SKU_WARN_THRESHOLD) {
        logger.warn(
          { attempt, workspaceOwnerId },
          "SKU generation required many attempts — SKU space may be near exhaustion for this workspace",
        );
      }
      return candidate;
    }
  }
  logger.error(
    { maxAttempts: SKU_MAX_ATTEMPTS, workspaceOwnerId },
    "SKU generation exhausted all attempts — SKU space is full for this workspace",
  );
  throw new Error("SKU_SPACE_EXHAUSTED");
}

function ownerOnly(wreq: ReturnType<typeof workspace>, res: Parameters<Parameters<typeof router.get>[1]>[1]): boolean {
  if (wreq.workspaceRole !== "owner" && !wreq.allowedPages?.includes("products.manage")) {
    res.status(403).json({ error: "Managing products requires owner access or the Manage products permission" });
    return false;
  }
  return true;
}

async function uploadImageToStorage(buffer: Buffer, mime: string, workspaceOwnerId: string): Promise<string> {
  const privateObjectDir = process.env.PRIVATE_OBJECT_DIR;
  if (!privateObjectDir) {
    throw new Error("PRIVATE_OBJECT_DIR not set");
  }

  const objectId = randomUUID();
  const fullPath = `${privateObjectDir}/${workspaceOwnerId}/products/${objectId}`;

  const parts = fullPath.startsWith("/") ? fullPath.slice(1).split("/") : fullPath.split("/");
  if (parts.length < 2) throw new Error("Invalid PRIVATE_OBJECT_DIR path");
  const bucketName = parts[0];
  const objectName = parts.slice(1).join("/");

  const bucket = objectStorageClient.bucket(bucketName);
  const file = bucket.file(objectName);

  await file.save(buffer, {
    contentType: mime,
    resumable: false,
  });

  return `/objects/${workspaceOwnerId}/products/${objectId}`;
}

/**
 * POST /api/products/upload-image
 * Upload a product image and return its object path (URL).
 * Requires owner role or products.manage permission.
 */
router.post("/products/upload-image", upload.single("image"), async (req, res) => {
  const wreq = workspace(req);
  if (!ownerOnly(wreq, res)) return;

  const file = (req as unknown as { file?: Express.Multer.File }).file;
  if (!file) {
    res.status(400).json({ error: "An image file is required" });
    return;
  }

  const mime = file.mimetype as string;
  if (!ALLOWED_MIME.includes(mime as typeof ALLOWED_MIME[number])) {
    res.status(400).json({ error: "Image must be a JPEG, PNG, or WebP file" });
    return;
  }

  try {
    const objectPath = await uploadImageToStorage(file.buffer, mime, wreq.workspaceOwnerId);
    res.json({ url: objectPath });
  } catch (err) {
    logger.error({ err }, "Failed to upload product image");
    res.status(500).json({ error: "Failed to upload image" });
  }
});

const VALID_PAGE_SIZES = [10, 25, 50, 100] as const;

/**
 * Inline SQL that computes cogs_usd for a single product (keyed on p.id).
 * Returns NULL when the recipe is empty or any item lacks a USD preferred price.
 */
const COGS_LATERAL_SQL = `
  LEFT JOIN LATERAL (
    SELECT
      CASE
        WHEN COUNT(pr.base_item_id) = 0 THEN NULL
        WHEN COUNT(pr.base_item_id) FILTER (
          WHERE bis.price IS NOT NULL AND bis.currency = 'USD'
        ) = COUNT(pr.base_item_id)
        THEN SUM(pr.quantity::numeric * bis.price::numeric)
        ELSE NULL
      END AS cogs_usd
    FROM product_recipes pr
    LEFT JOIN base_item_suppliers bis
      ON bis.base_item_id = pr.base_item_id
     AND bis.workspace_owner_id = pr.workspace_owner_id
     AND bis.is_preferred = true
    WHERE pr.product_id = p.id
      AND pr.workspace_owner_id = p.workspace_owner_id
  ) cogs_data ON true`;

/**
 * SQL scalar subquery that derives a product's primary (alphabetically-first)
 * catalog category name from the product_catalog_categories join. Replaces the
 * retired free-text `products.category` column so the `category` field stays
 * populated from the single source of truth (catalog categories). `alias` is a
 * server-side table alias, never user input.
 */
function primaryCategorySql(alias: string): string {
  return `(SELECT cc.name
             FROM product_catalog_categories pcc
             JOIN catalog_categories cc ON cc.id = pcc.attribute_id
            WHERE pcc.product_id = ${alias}.id
            ORDER BY cc.name ASC
            LIMIT 1)`;
}

/** Fetch a product's derived primary catalog category name (or null). */
async function fetchPrimaryCategory(productId: number): Promise<string | null> {
  const r = await db.query<{ category: string | null }>(
    `SELECT ${primaryCategorySql("p")} AS category FROM products p WHERE p.id = $1`,
    [productId],
  );
  return r.rows[0]?.category ?? null;
}

/** Normalize an attribute display name to its slug form. */
function slugifyAttr(name: string): string {
  return name.toLowerCase().trim().replace(/['']/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

type ProductFilterParams = {
  qFilter: string | null;
  statusValues: string[];
  brandValues: string[];
  brandSearch: string | null;
  categoryValues: string[];
  occasionNames: string[];
  occasionId: number | null;
  recipientNames: string[];
  recipientId: number | null;
  catalogBrandIds: number[];
  catalogBrandSlugs: string[];
  cogsMinPct: number | null;
  cogsMaxPct: number | null;
  hasCogsFilter: boolean;
};

/**
 * Parse the shared product filter query params used by both the list
 * (`GET /products`) and the KPI summary (`GET /products/summary`) so the two
 * endpoints stay in lockstep. Does NOT parse pagination, city, or archive
 * toggles — those are list-specific and handled inline.
 */
function parseProductFilterParams(req: Request): ProductFilterParams {
  const qFilter = typeof req.query.q === "string" && req.query.q.trim() ? req.query.q.trim() : null;

  const cogsMinPctRaw = req.query.cogs_min_pct;
  const cogsMaxPctRaw = req.query.cogs_max_pct;
  const cogsMinPct = typeof cogsMinPctRaw === "string" && cogsMinPctRaw !== ""
    ? parseFloat(cogsMinPctRaw) : null;
  const cogsMaxPct = typeof cogsMaxPctRaw === "string" && cogsMaxPctRaw !== ""
    ? parseFloat(cogsMaxPctRaw) : null;
  const hasCogsFilter = (cogsMinPct !== null && Number.isFinite(cogsMinPct)) ||
    (cogsMaxPct !== null && Number.isFinite(cogsMaxPct));

  const rawStatus = req.query.status;
  const statusValues: string[] = Array.isArray(rawStatus)
    ? (rawStatus as string[]).filter((s) => VALID_STATUSES.includes(s as typeof VALID_STATUSES[number]))
    : typeof rawStatus === "string" && rawStatus
    ? [rawStatus].filter((s) => VALID_STATUSES.includes(s as typeof VALID_STATUSES[number]))
    : [];

  const rawBrand = req.query.brand;
  const brandValues: string[] = Array.isArray(rawBrand)
    ? (rawBrand as string[]).filter(Boolean)
    : typeof rawBrand === "string" && rawBrand
    ? [rawBrand]
    : [];

  const brandSearchRaw = req.query.brandSearch;
  const brandSearch = typeof brandSearchRaw === "string" && brandSearchRaw.trim() ? brandSearchRaw.trim() : null;

  const rawCategory = req.query.category;
  const categoryValues: string[] = Array.isArray(rawCategory)
    ? (rawCategory as string[]).filter(Boolean)
    : typeof rawCategory === "string" && rawCategory
    ? [rawCategory]
    : [];

  const occasionRaw = req.query.occasion;
  const occasionNames: string[] = Array.isArray(occasionRaw)
    ? (occasionRaw as string[]).filter(Boolean)
    : typeof occasionRaw === "string" && occasionRaw
    ? [occasionRaw]
    : [];

  const occasionIdRaw = req.query.occasion_id;
  const occasionIdVal = typeof occasionIdRaw === "string" && occasionIdRaw ? parseInt(occasionIdRaw, 10) : null;
  const occasionId = occasionIdVal !== null && Number.isFinite(occasionIdVal) && occasionIdVal > 0 ? occasionIdVal : null;

  const recipientRaw = req.query.recipient;
  const recipientNames: string[] = Array.isArray(recipientRaw)
    ? (recipientRaw as string[]).filter(Boolean)
    : typeof recipientRaw === "string" && recipientRaw
    ? [recipientRaw]
    : [];

  const recipientIdRaw = req.query.recipient_id;
  const recipientIdVal = typeof recipientIdRaw === "string" && recipientIdRaw ? parseInt(recipientIdRaw, 10) : null;
  const recipientId = recipientIdVal !== null && Number.isFinite(recipientIdVal) && recipientIdVal > 0 ? recipientIdVal : null;

  const catalogBrandIdRaw = req.query.catalog_brand_id;
  const catalogBrandIds: number[] = (Array.isArray(catalogBrandIdRaw)
    ? (catalogBrandIdRaw as unknown[])
    : catalogBrandIdRaw != null && catalogBrandIdRaw !== ""
    ? [catalogBrandIdRaw]
    : [])
    .map((v) => parseInt(String(v), 10))
    .filter((n) => Number.isFinite(n) && n > 0);

  const catalogBrandRaw = req.query.catalog_brand;
  const catalogBrandSlugs: string[] = (Array.isArray(catalogBrandRaw)
    ? (catalogBrandRaw as string[])
    : typeof catalogBrandRaw === "string" && catalogBrandRaw
    ? [catalogBrandRaw]
    : []).filter(Boolean);

  return {
    qFilter,
    statusValues,
    brandValues,
    brandSearch,
    categoryValues,
    occasionNames,
    occasionId,
    recipientNames,
    recipientId,
    catalogBrandIds,
    catalogBrandSlugs,
    cogsMinPct,
    cogsMaxPct,
    hasCogsFilter,
  };
}

/**
 * Append the shared "content" filter conditions (legacy brand, brand search,
 * category, free-text search, occasion, recipient, and catalog brand) to a
 * conditions/params array. `params[0]` must be the workspace owner id ($1),
 * which the workspace-scoped slug EXISTS clauses reference. Callers append
 * status, archive, city, and COGS conditions themselves. Used by both the list
 * and summary endpoints so their filtering stays identical.
 */
function appendContentFilterConditions(
  f: ProductFilterParams,
  conditions: string[],
  params: unknown[],
): void {
  if (f.brandValues.length > 0) {
    const clauses = f.brandValues.map((b) => {
      params.push(`%${b.replace(/([%_\\])/g, "\\$1")}%`);
      return `lower(p.brand) ILIKE lower($${params.length}) ESCAPE '\\'`;
    });
    conditions.push(`(${clauses.join(" OR ")})`);
  }
  if (f.brandSearch !== null) {
    params.push(`%${f.brandSearch.replace(/([%_\\])/g, "\\$1").toLowerCase()}%`);
    conditions.push(`lower(p.brand) ILIKE lower($${params.length}) ESCAPE '\\'`);
  }
  if (f.categoryValues.length > 0) {
    const clauses = f.categoryValues.map((c) => {
      params.push(`%${c.replace(/([%_\\])/g, "\\$1").toLowerCase()}%`);
      return `EXISTS (SELECT 1 FROM product_catalog_categories pcc JOIN catalog_categories cc ON cc.id = pcc.attribute_id WHERE pcc.product_id = p.id AND lower(cc.name) ILIKE $${params.length} ESCAPE '\\')`;
    });
    conditions.push(`(${clauses.join(" OR ")})`);
  }
  if (f.qFilter !== null) {
    params.push(`%${f.qFilter.replace(/([%_\\])/g, "\\$1")}%`);
    conditions.push(`(p.name ILIKE $${params.length} ESCAPE '\\' OR p.sku ILIKE $${params.length} ESCAPE '\\')`);
  }
  if (f.occasionId !== null) {
    params.push(f.occasionId);
    conditions.push(`EXISTS (SELECT 1 FROM product_occasions po WHERE po.product_id = p.id AND po.attribute_id = $${params.length})`);
  } else if (f.occasionNames.length > 0) {
    const slugClauses = f.occasionNames.map((name) => {
      params.push(slugifyAttr(name));
      return `EXISTS (SELECT 1 FROM product_occasions po JOIN occasions o ON o.id = po.attribute_id WHERE po.product_id = p.id AND o.slug = $${params.length} AND o.workspace_owner_id = $1)`;
    });
    conditions.push(`(${slugClauses.join(" OR ")})`);
  }
  if (f.recipientId !== null) {
    params.push(f.recipientId);
    conditions.push(`EXISTS (SELECT 1 FROM product_recipients pr WHERE pr.product_id = p.id AND pr.attribute_id = $${params.length})`);
  } else if (f.recipientNames.length > 0) {
    const slugClauses = f.recipientNames.map((name) => {
      params.push(slugifyAttr(name));
      return `EXISTS (SELECT 1 FROM product_recipients pr JOIN recipients r ON r.id = pr.attribute_id WHERE pr.product_id = p.id AND r.slug = $${params.length} AND r.workspace_owner_id = $1)`;
    });
    conditions.push(`(${slugClauses.join(" OR ")})`);
  }
  if (f.catalogBrandIds.length > 0 || f.catalogBrandSlugs.length > 0) {
    const brandClauses: string[] = [];
    for (const id of f.catalogBrandIds) {
      params.push(id);
      brandClauses.push(`EXISTS (SELECT 1 FROM product_catalog_brands pcb WHERE pcb.product_id = p.id AND pcb.attribute_id = $${params.length})`);
    }
    for (const slug of f.catalogBrandSlugs) {
      params.push(slugifyAttr(slug));
      brandClauses.push(`EXISTS (SELECT 1 FROM product_catalog_brands pcb JOIN catalog_brands cb ON cb.id = pcb.attribute_id WHERE pcb.product_id = p.id AND cb.slug = $${params.length} AND cb.workspace_owner_id = $1)`);
    }
    conditions.push(`(${brandClauses.join(" OR ")})`);
  }
}

/**
 * GET /api/products/summary
 * Returns KPI counts for the workspace catalog: total, available_count,
 * hidden_count, missing_info_count, missing_images_count, avg_cogs_pct,
 * archived_count. Honors the same catalog/content filters as `GET /products`
 * (legacy brand, brand search, category, search, occasion, recipient, catalog
 * brand) so the KPI cards reflect the active filter selection. Status/tab and
 * COGS filters are intentionally excluded: the summary drives the status tab
 * counts and the COGS KPI, so applying them would zero out the very numbers the
 * cards display.
 */
router.get("/products/summary", async (req, res) => {
  const wreq = workspace(req);

  const summaryFilters = parseProductFilterParams(req);
  const contentConditions: string[] = [];
  const params: unknown[] = [wreq.workspaceOwnerId];
  appendContentFilterConditions(summaryFilters, contentConditions, params);
  const contentWhere = contentConditions.length > 0 ? ` AND ${contentConditions.join(" AND ")}` : "";

  const result = await db.query<{
    total: string;
    available_count: string;
    hidden_count: string;
    missing_info_count: string;
    missing_images_count: string;
    avg_cogs_pct: string | null;
    archived_count: string;
  }>(
    `WITH cogs_base AS (
       SELECT
         p.id,
         p.status,
         p.name,
         p.price_usd,
         p.price_aed,
         p.main_image_url,
         p.brand,
         ${primaryCategorySql("p")} AS category,
         p.sku,
         (SELECT
            CASE
              WHEN COUNT(pr.base_item_id) = 0 THEN NULL
              WHEN COUNT(pr.base_item_id) FILTER (
                WHERE bis.price IS NOT NULL AND bis.currency = 'USD'
              ) = COUNT(pr.base_item_id)
              THEN SUM(pr.quantity::numeric * bis.price::numeric)
              ELSE NULL
            END
          FROM product_recipes pr
          LEFT JOIN base_item_suppliers bis
            ON bis.base_item_id = pr.base_item_id
           AND bis.workspace_owner_id = pr.workspace_owner_id
           AND bis.is_preferred = true
          WHERE pr.product_id = p.id
            AND pr.workspace_owner_id = p.workspace_owner_id
         ) AS cogs_usd
       FROM products p
       WHERE p.workspace_owner_id = $1
         AND p.is_archived = false${contentWhere}
     )
     SELECT
       COUNT(*)::text                                                                    AS total,
       COUNT(*) FILTER (WHERE status = 'available')::text                               AS available_count,
       COUNT(*) FILTER (WHERE status != 'available')::text                              AS hidden_count,
       COUNT(*) FILTER (WHERE
         (name IS NULL OR name = '') OR
         price_usd IS NULL OR price_aed IS NULL OR
         main_image_url IS NULL OR
         (brand IS NULL OR brand = '') OR
         (category IS NULL OR category = '') OR
         sku IS NULL OR
         cogs_usd IS NULL
       )::text                                                                          AS missing_info_count,
       COUNT(*) FILTER (WHERE main_image_url IS NULL)::text                             AS missing_images_count,
       AVG(
         CASE WHEN cogs_usd IS NOT NULL AND price_usd::numeric > 0
              THEN cogs_usd / price_usd::numeric * 100
              ELSE NULL END
       )::text                                                                          AS avg_cogs_pct,
       (SELECT COUNT(*)::text FROM products p WHERE p.workspace_owner_id = $1 AND p.is_archived = true${contentWhere}) AS archived_count
     FROM cogs_base`,
    params,
  );
  const row = result.rows[0];
  res.json({
    total: parseInt(row.total, 10),
    available_count: parseInt(row.available_count, 10),
    hidden_count: parseInt(row.hidden_count, 10),
    missing_info_count: parseInt(row.missing_info_count, 10),
    missing_images_count: parseInt(row.missing_images_count, 10),
    avg_cogs_pct: row.avg_cogs_pct != null ? parseFloat(row.avg_cogs_pct) : null,
    archived_count: parseInt(row.archived_count, 10),
  });
});

/**
 * GET /api/products
 * List products for the workspace with server-side pagination.
 * Supports ?brand=, ?status=, ?category=, ?q=, ?brandSearch= filters.
 * Supports ?occasion= (slug, array-capable) / ?occasion_id= to filter by occasion.
 * Supports ?recipient= (slug, array-capable) / ?recipient_id= to filter by recipient.
 * Supports ?catalog_brand= (slug, array-capable) / ?catalog_brand_id= (array-capable)
 *   to filter by the structured catalog Brand attribute.
 * Supports ?cogs_min_pct= and ?cogs_max_pct= to filter by computed COGS %.
 * Supports ?page= (integer ≥ 1, default 1) and ?pageSize= (10/25/50/100, default 25).
 * Returns { products, total, page, pageSize, totalPages }.
 */
router.get("/products", async (req, res) => {
  const wreq = workspace(req);
  const f = parseProductFilterParams(req);

  const citySlugRaw = typeof req.query.city_slug === "string" && req.query.city_slug.trim() ? req.query.city_slug.trim() : null;
  const cityIdRaw = typeof req.query.city_id === "string" && req.query.city_id ? parseInt(req.query.city_id, 10) : null;
  const cityIdParam = cityIdRaw !== null && Number.isFinite(cityIdRaw) && cityIdRaw > 0 ? cityIdRaw : null;

  let resolvedCityId: number | null = cityIdParam;
  if (citySlugRaw !== null && resolvedCityId === null) {
    const cityRow = await db.query<{ id: number }>(
      `SELECT id FROM delivery_cities WHERE workspace_owner_id = $1 AND slug = $2 AND is_active = true LIMIT 1`,
      [wreq.workspaceOwnerId, citySlugRaw],
    );
    if (!cityRow.rows[0]) {
      res.status(404).json({ error: `No active delivery city found with slug '${citySlugRaw}'` });
      return;
    }
    resolvedCityId = cityRow.rows[0].id;
  }

  const rawPage = parseInt(typeof req.query.page === "string" ? req.query.page : "1", 10);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;

  const rawPageSize = parseInt(typeof req.query.pageSize === "string" ? req.query.pageSize : "25", 10);
  const pageSize = (VALID_PAGE_SIZES as readonly number[]).includes(rawPageSize) ? rawPageSize : 25;

  const includeArchived = req.query.include_archived === "true";
  const archivedOnly = req.query.archived_only === "true";

  const conditions: string[] = ["p.workspace_owner_id = $1"];
  const params: unknown[] = [wreq.workspaceOwnerId];

  if (archivedOnly) {
    conditions.push("p.is_archived = true");
  } else if (!includeArchived) {
    conditions.push("p.is_archived = false");
  }

  if (f.statusValues.length > 0) {
    const placeholders = f.statusValues.map((s) => {
      params.push(s);
      return `$${params.length}`;
    });
    conditions.push(`p.status IN (${placeholders.join(", ")})`);
  }
  appendContentFilterConditions(f, conditions, params);
  // city filter (default-on): a product is available in every delivery city
  // unless an explicit row disables it. Hide only products explicitly disabled
  // for the selected city.
  if (resolvedCityId !== null) {
    params.push(resolvedCityId);
    conditions.push(
      `NOT EXISTS (SELECT 1 FROM product_city_availability pca WHERE pca.product_id = p.id AND pca.city_id = $${params.length} AND pca.is_available = false)`,
    );
  }

  let cogsConditions = "";
  if (f.hasCogsFilter) {
    const cogsPctExpr = `(cogs_data.cogs_usd / NULLIF(p.price_usd::numeric, 0) * 100)`;
    const parts: string[] = [];
    if (f.cogsMinPct !== null && Number.isFinite(f.cogsMinPct)) {
      params.push(f.cogsMinPct);
      parts.push(`cogs_data.cogs_usd IS NOT NULL AND ${cogsPctExpr} >= $${params.length}`);
    }
    if (f.cogsMaxPct !== null && Number.isFinite(f.cogsMaxPct)) {
      params.push(f.cogsMaxPct);
      parts.push(`cogs_data.cogs_usd IS NOT NULL AND ${cogsPctExpr} <= $${params.length}`);
    }
    cogsConditions = parts.length > 0 ? ` AND (${parts.join(" AND ")})` : "";
  }

  const whereClause = conditions.join(" AND ");
  const fullWhere = `${whereClause}${cogsConditions}`;

  const countResult = await db.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM products p${f.hasCogsFilter ? COGS_LATERAL_SQL : ""} WHERE ${fullWhere}`,
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

  const result = await db.query<ProductRow>(
    `SELECT p.id, p.workspace_owner_id, p.name, p.price_usd, p.price_aed,
            p.discount_price_usd, p.discount_price_aed,
             p.main_image_url, p.additional_image_urls,
             p.image_public_path, p.additional_image_public_paths,
             p.image_display_public_path, p.image_thumbnail_public_path,
             p.additional_image_display_public_paths, p.additional_image_thumbnail_public_paths,
             p.description,
            p.status, p.brand, p.tags, ${primaryCategorySql("p")} AS category, p.sku, p.created_at,
            p.is_archived, p.express_delivery_enabled, p.has_input_field, p.letter_input_enabled, p.is_upsell, p.is_cmc,
            p.inventory_tracked,
            p.merchant_sync_status, p.merchant_sync_error, p.merchant_synced_at, p.merchant_sync_disabled,
            (SELECT json_build_object('id', cb.id, 'name', cb.name, 'slug', cb.slug)
               FROM product_catalog_brands pcb
               JOIN catalog_brands cb ON cb.id = pcb.attribute_id
              WHERE pcb.product_id = p.id
              ORDER BY cb.name ASC
              LIMIT 1) AS catalog_brand,
            cogs_data.cogs_usd,
            (SELECT COUNT(*)::int
               FROM product_city_availability pca
               JOIN delivery_cities dc ON dc.id = pca.city_id
              WHERE pca.product_id = p.id
                AND pca.is_available = false
                AND dc.workspace_owner_id = p.workspace_owner_id) AS delivery_disabled_count,
            ${attributeAggSql("p")}
       FROM products p
       ${COGS_LATERAL_SQL}
      WHERE ${fullWhere}
      ORDER BY p.created_at DESC
      LIMIT $${limitParam} OFFSET $${offsetParam}`,
    params,
  );

  // Total number of delivery cities configured for this workspace, so the
  // dashboard can render a per-product "Delivers to X of Y cities" indicator.
  const cityCountResult = await db.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM delivery_cities WHERE workspace_owner_id = $1`,
    [wreq.workspaceOwnerId],
  );
  const totalDeliveryCities = parseInt(cityCountResult.rows[0]?.count ?? "0", 10);

  sendValidated(
    req,
    res,
    productsListResponseSchema,
    {
      products: result.rows.map(decorateProductImageUrls),
      total,
      page: safePage,
      pageSize,
      totalPages,
      total_delivery_cities: totalDeliveryCities,
    },
    "GET /products",
  );
});

/**
 * GET /api/products/categories
 * Return the distinct catalog-category names linked to the workspace's products.
 * (The legacy free-text products.category column has been retired; categories now
 * live in product_catalog_categories.)
 */
router.get("/products/categories", async (req, res) => {
  const wreq = workspace(req);
  const brand = typeof req.query.brand === "string" && req.query.brand.trim() ? req.query.brand.trim() : null;
  const params: unknown[] = [wreq.workspaceOwnerId];
  let brandClause = "";
  if (brand) {
    params.push(brand);
    brandClause = `AND lower(p.brand) = lower($${params.length})`;
  }
  const result = await db.query<{ category: string }>(
    `SELECT DISTINCT cc.name AS category
       FROM product_catalog_categories pcc
       JOIN catalog_categories cc ON cc.id = pcc.attribute_id
       JOIN products p ON p.id = pcc.product_id
      WHERE p.workspace_owner_id = $1
        AND cc.name IS NOT NULL
        AND cc.name <> ''
        ${brandClause}
      ORDER BY cc.name`,
    params,
  );
  res.json({ categories: result.rows.map((r) => r.category) });
});

/**
 * GET /api/products/category-options
 * Combined, workspace-scoped search across Catalog Categories + Occasions for
 * the product category/occasion multi-select picker. Each option is tagged with
 * its `kind` ("catalog_category" | "occasion"). Optional `?q=` filters by name.
 */
router.get("/products/category-options", async (req, res) => {
  const wreq = workspace(req);
  const q = typeof req.query.q === "string" && req.query.q.trim() ? req.query.q.trim() : null;
  const params: unknown[] = [wreq.workspaceOwnerId];
  let nameClause = "";
  if (q) {
    params.push(`%${q.replace(/([%_\\])/g, "\\$1")}%`);
    nameClause = `AND name ILIKE $${params.length} ESCAPE '\\'`;
  }
  const result = await db.query<ProductCategoryOption>(
    `SELECT 'catalog_category' AS kind, id, name, slug FROM catalog_categories
       WHERE workspace_owner_id = $1 AND is_active = true ${nameClause}
     UNION ALL
     SELECT 'occasion' AS kind, id, name, slug FROM occasions
       WHERE workspace_owner_id = $1 AND is_active = true ${nameClause}
     ORDER BY kind, name
     LIMIT 100`,
    params,
  );
  res.json({ options: result.rows });
});

/**
 * GET /api/products/export
 * Download workspace products as a CSV file.
 * Columns: id, name, sku, brand, category, price_usd, price_aed, cogs_usd, status.
 *
 * Optional query parameter:
 *   ?ids=1,2,3   — export only the specified product IDs (comma-separated).
 *   Omit to export all workspace products.
 */
router.get("/products/export", async (req, res) => {
  const wreq = workspace(req);

  const idsRaw = req.query.ids;
  let ids: number[] | null = null;
  if (typeof idsRaw === "string" && idsRaw.trim()) {
    ids = idsRaw
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !isNaN(n) && n > 0);
    if (ids.length === 0) {
      res.status(400).json({ error: "No valid product IDs provided" });
      return;
    }
    if (ids.length > 500) {
      res.status(400).json({ error: "Cannot export more than 500 products at once" });
      return;
    }
  }

  const params: unknown[] = [wreq.workspaceOwnerId];
  let idClause = "";
  if (ids) {
    const placeholders = ids.map((_, i) => `$${i + 2}`).join(", ");
    idClause = `AND p.id IN (${placeholders})`;
    params.push(...ids);
  }

  type ExportRow = {
    id: number;
    name: string;
    sku: string | null;
    brand: string | null;
    category: string | null;
    price_usd: string | null;
    price_aed: string | null;
    cogs_usd: string | null;
    status: string;
  };

  const result = await db.query<ExportRow>(
    `SELECT p.id, p.name, p.sku, p.brand, ${primaryCategorySql("p")} AS category,
            p.price_usd, p.price_aed, p.status,
            cogs_data.cogs_usd
       FROM products p
       ${COGS_LATERAL_SQL}
      WHERE p.workspace_owner_id = $1
        ${idClause}
      ORDER BY p.name ASC`,
    params,
  );

  function csvCell(v: string | number | null | undefined): string {
    if (v == null) return "";
    const s = String(v);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }

  const header = ["id", "name", "sku", "brand", "category", "price_usd", "price_aed", "cogs_usd", "status"].join(",");
  const rows = result.rows.map((r) =>
    [
      r.id,
      csvCell(r.name),
      csvCell(r.sku),
      csvCell(r.brand),
      csvCell(r.category),
      r.price_usd ?? "",
      r.price_aed ?? "",
      r.cogs_usd ?? "",
      csvCell(r.status),
    ].join(","),
  );
  const csv = [header, ...rows].join("\n");

  const date = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="products-export-${date}.csv"`);
  res.setHeader("Cache-Control", "no-store");
  res.send(csv);
});

type RecipeRow = {
  base_item_id: number;
  name: string;
  code: string;
  image_url: string | null;
  quantity: string;
};

/**
 * GET /api/products/by-location/:locationId
 * Return products available at a given location (is_active = true, defaulting to true).
 * Must be registered before /products/:id to avoid Express treating "by-location" as an id.
 */
router.get("/products/by-location/:locationId", async (req, res) => {
  const wreq = workspace(req);
  const locationId = parseInt(req.params.locationId, 10);
  if (isNaN(locationId)) {
    res.status(400).json({ error: "Invalid location id" });
    return;
  }

  const locCheck = await db.query(
    `SELECT id FROM locations WHERE id = $1 AND workspace_owner_id = $2`,
    [locationId, wreq.workspaceOwnerId],
  );
  if (locCheck.rowCount === 0) {
    res.status(404).json({ error: "Location not found" });
    return;
  }

  const result = await db.query<ProductRow>(
    `SELECT p.id, p.workspace_owner_id, p.name, p.price_usd, p.price_aed,
             p.main_image_url, p.additional_image_urls,
             p.image_public_path, p.additional_image_public_paths,
             p.image_display_public_path, p.image_thumbnail_public_path,
             p.additional_image_display_public_paths, p.additional_image_thumbnail_public_paths,
             p.description,
            p.status, p.brand, p.tags, ${primaryCategorySql("p")} AS category, p.created_at
       FROM products p
      WHERE p.workspace_owner_id = $1
        AND COALESCE(
          (SELECT pls.is_active FROM product_location_statuses pls
            WHERE pls.product_id = p.id AND pls.location_id = $2),
          true
        ) = true
      ORDER BY p.name ASC`,
    [wreq.workspaceOwnerId, locationId],
  );
  res.json({ products: result.rows.map(decorateProductImageUrls) });
});

/**
 * GET /api/products/merchant-sync-status
 * Returns aggregate sync job counts and the last 20 products with issues.
 * Strict owner-only (workspaceRole must equal "owner"; products.manage permission
 * is intentionally not sufficient — this exposes internal sync diagnostics).
 */
router.get("/products/merchant-sync-status", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "This endpoint requires workspace owner access" });
    return;
  }

  try {
    // Aggregate counts from merchant_sync_jobs scoped to this workspace.
    const countsRes = await db.query<{ status: string; count: string }>(
      `SELECT j.status, COUNT(*) AS count
         FROM merchant_sync_jobs j
         JOIN products p ON p.id = j.product_id
        WHERE p.workspace_owner_id = $1
        GROUP BY j.status`,
      [wreq.workspaceOwnerId],
    );

    const counts: Record<string, number> = {};
    for (const row of countsRes.rows) {
      counts[row.status.toLowerCase()] = parseInt(row.count, 10);
    }

    // Last 20 products with issues (FAILED or SYNCED with an error/disapproval).
    const issuesRes = await db.query<{
      id: number;
      name: string;
      merchant_sync_status: string | null;
      merchant_sync_error: string | null;
      merchant_synced_at: string | null;
    }>(
      `SELECT id, name, merchant_sync_status, merchant_sync_error, merchant_synced_at
         FROM products
        WHERE workspace_owner_id = $1
          AND merchant_sync_status IN ('FAILED', 'SYNCED', 'ACTION_REQUIRED')
          AND merchant_sync_error IS NOT NULL
        ORDER BY COALESCE(merchant_synced_at, updated_at) DESC
        LIMIT 20`,
      [wreq.workspaceOwnerId],
    );

    res.json({
      counts: {
        pending: counts["pending"] ?? 0,
        running: counts["running"] ?? 0,
        completed: counts["completed"] ?? 0,
        failed: counts["failed"] ?? 0,
        retry_waiting: counts["retry_waiting"] ?? 0,
      },
      // Explicit configuration health so the dashboard can say "sync is
      // misconfigured" instead of jobs silently queueing forever.
      config: getMerchantConfigStatus(),
      issues: issuesRes.rows.map((p) => ({
        id: p.id,
        name: p.name,
        status: p.merchant_sync_status,
        error: p.merchant_sync_error,
        syncedAt: p.merchant_synced_at,
      })),
    });
  } catch (err) {
    logger.error({ err }, "merchant-sync-status: failed");
    res.status(500).json({ error: "Failed to fetch merchant sync status" });
  }
});

/**
 * Temporary, owner-only, read-only production database identity diagnostic.
 * Remove after the Merchant reconciliation database mismatch is resolved.
 */
router.get("/products/merchant-database-diagnostic", async (req, res) => {
  const wreq = workspace(req);
  if (!merchantReconciliationOwnerOnly(wreq.workspaceActualRole)) {
    res.status(403).json({ error: "Owner access required" });
    return;
  }

  try {
    const result = await db.query<{
      database_name: string;
      product_count: string;
      merchant_offer_states_exists: boolean;
      merchant_reconciliation_runs_exists: boolean;
      merchant_reconciliation_items_exists: boolean;
    }>(`
      SELECT
        current_database() AS database_name,
        (SELECT COUNT(*)::text FROM products) AS product_count,
        to_regclass('public.merchant_offer_states') IS NOT NULL
          AS merchant_offer_states_exists,
        to_regclass('public.merchant_reconciliation_runs') IS NOT NULL
          AS merchant_reconciliation_runs_exists,
        to_regclass('public.merchant_reconciliation_items') IS NOT NULL
          AS merchant_reconciliation_items_exists
    `);
    const diagnostic = result.rows[0];
    if (!diagnostic) {
      res.status(500).json({ error: "Database diagnostic returned no result" });
      return;
    }
    res.json({
      database: diagnostic.database_name,
      productCount: Number(diagnostic.product_count),
      tables: {
        merchantOfferStates: diagnostic.merchant_offer_states_exists,
        merchantReconciliationRuns: diagnostic.merchant_reconciliation_runs_exists,
        merchantReconciliationItems: diagnostic.merchant_reconciliation_items_exists,
      },
    });
  } catch (err) {
    req.log.error({ err }, "merchant database diagnostic failed");
    res.status(500).json({ error: "Failed to inspect database identity" });
  }
});

/**
 * GET /api/products/:id
 * Return a single product by ID for the workspace, including its recipe.
 */
router.get("/products/:id", async (req, res) => {
  const wreq = workspace(req);

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid product id" });
    return;
  }

  const result = await db.query<ProductRow>(
    `SELECT p.id, p.workspace_owner_id, p.name, p.price_usd, p.price_aed,
            p.discount_price_usd, p.discount_price_aed,
             p.main_image_url, p.additional_image_urls,
             p.image_public_path, p.additional_image_public_paths,
             p.image_display_public_path, p.image_thumbnail_public_path,
             p.additional_image_display_public_paths, p.additional_image_thumbnail_public_paths,
             p.description,
            p.status, p.brand, p.tags, ${primaryCategorySql("p")} AS category, p.created_at,
            p.is_archived, p.express_delivery_enabled, p.has_input_field, p.letter_input_enabled, p.is_upsell, p.is_cmc,
            p.inventory_tracked,
            p.merchant_sync_status, p.merchant_sync_error, p.merchant_synced_at, p.merchant_sync_disabled,
            (SELECT json_build_object('id', cb.id, 'name', cb.name, 'slug', cb.slug)
               FROM product_catalog_brands pcb
               JOIN catalog_brands cb ON cb.id = pcb.attribute_id
              WHERE pcb.product_id = p.id
              ORDER BY cb.name ASC
              LIMIT 1) AS catalog_brand,
            ${attributeAggSql("p")}
       FROM products p
      WHERE p.id = $1 AND p.workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );

  if (result.rowCount === 0) {
    res.status(404).json({ error: "Product not found" });
    return;
  }

  const recipeResult = await db.query<RecipeRow>(
    `SELECT pr.base_item_id, bi.name, bi.code, bi.image_url, pr.quantity
       FROM product_recipes pr
       JOIN base_items bi ON bi.id = pr.base_item_id
      WHERE pr.product_id = $1 AND pr.workspace_owner_id = $2
      ORDER BY pr.sort_order ASC, pr.created_at ASC`,
    [id, wreq.workspaceOwnerId],
  );

  res.json({ product: decorateProductImageUrls(result.rows[0]), recipe: recipeResult.rows });
});

type CogsRow = {
  base_item_id: number;
  name: string;
  code: string;
  image_url: string | null;
  quantity: string;
  unit_price: string | null;
  currency: string | null;
  pricing_uom: string | null;
};

/**
 * GET /api/products/:id/cogs
 * Returns per-ingredient cost rows (using preferred supplier price) and totals.
 */
router.get("/products/:id/cogs", async (req, res) => {
  const wreq = workspace(req);

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid product id" });
    return;
  }

  const productCheck = await db.query<{ id: number; brand: string | null }>(
    `SELECT id, brand FROM products WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (productCheck.rowCount === 0) {
    res.status(404).json({ error: "Product not found" });
    return;
  }

  const productBrand = productCheck.rows[0].brand;
  let brandTargetCogs: number | null = null;
  if (productBrand) {
    const brandRes = await db.query<{ target_cogs: string | null }>(
      `SELECT target_cogs FROM brands
        WHERE workspace_owner_id = $1 AND lower(name) = lower($2)
        LIMIT 1`,
      [wreq.workspaceOwnerId, productBrand],
    );
    if (brandRes.rowCount && brandRes.rows[0].target_cogs != null) {
      const parsed = parseFloat(brandRes.rows[0].target_cogs);
      if (Number.isFinite(parsed)) brandTargetCogs = parsed;
    }
  }

  const result = await db.query<CogsRow>(
    `SELECT pr.base_item_id,
            bi.name,
            bi.code,
            bi.image_url,
            pr.quantity,
            bis.price       AS unit_price,
            bis.currency    AS currency,
            COALESCE(uc.display_name, bis.pricing_uom) AS pricing_uom
       FROM product_recipes pr
       JOIN base_items bi ON bi.id = pr.base_item_id
       LEFT JOIN base_item_suppliers bis
         ON bis.base_item_id = pr.base_item_id
        AND bis.workspace_owner_id = pr.workspace_owner_id
        AND bis.is_preferred = true
        AND bis.price IS NOT NULL
        LEFT JOIN uom_catalog uc ON uc.code = bis.pricing_uom_code
      WHERE pr.product_id = $1 AND pr.workspace_owner_id = $2
      ORDER BY pr.sort_order ASC, pr.created_at ASC`,
    [id, wreq.workspaceOwnerId],
  );

  const items = result.rows.map((row) => {
    const quantity = parseFloat(row.quantity);
    const unitPrice = row.unit_price != null ? parseFloat(row.unit_price) : null;
    const lineCost =
      unitPrice != null && Number.isFinite(unitPrice) && Number.isFinite(quantity)
        ? unitPrice * quantity
        : null;
    return {
      base_item_id: row.base_item_id,
      name: row.name,
      code: row.code,
      image_url: row.image_url,
      quantity,
      unit_price: unitPrice,
      currency: row.currency,
      pricing_uom: row.pricing_uom,
      line_cost: lineCost,
    };
  });

  let missingPricingCount = 0;
  const totalsByCurrencyMap = new Map<string, number>();
  for (const it of items) {
    if (it.line_cost == null || it.currency == null) {
      missingPricingCount += 1;
      continue;
    }
    totalsByCurrencyMap.set(it.currency, (totalsByCurrencyMap.get(it.currency) ?? 0) + it.line_cost);
  }
  const totals_by_currency = Array.from(totalsByCurrencyMap.entries()).map(([currency, total]) => ({
    currency,
    total,
  }));
  const mixed_currencies = totals_by_currency.length > 1;
  const total_cogs = totals_by_currency.length === 1 ? totals_by_currency[0].total : null;
  const currency = totals_by_currency.length === 1 ? totals_by_currency[0].currency : null;

  res.json({
    items,
    totals: {
      total_cogs,
      currency,
      missing_pricing_count: missingPricingCount,
      mixed_currencies,
      totals_by_currency,
      brand_target_cogs: brandTargetCogs,
    },
  });
});

type SalesHistoryRow = {
  order_id: string;
  display_order_number: string | null;
  external_order_id: string | null;
  status: string;
  ordered_at: string | null;
  currency: string | null;
  quantity: string | null;
  unit_price: string | null;
  line_total: string | null;
};

const salesHistoryQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(200).optional().default(50),
});

const salesHistoryItemSchema = z.object({
  order_id: z.string(),
  order_display_number: z.string().nullable(),
  external_order_id: z.string().nullable(),
  status: z.string(),
  date: z.string().nullable(),
  quantity: z.number(),
  unit_price: z.number().nullable(),
  line_total: z.number().nullable(),
  currency: z.string().nullable(),
});

const salesHistoryResponseSchema = z.object({
  items: z.array(salesHistoryItemSchema),
  totals: z.object({
    total_quantity: z.number(),
    revenue_by_currency: z.array(
      z.object({ currency: z.string(), total: z.number() }),
    ),
  }),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
  totalPages: z.number().int(),
  matchKey: z.literal("both"),
});

/**
 * GET /api/products/:id/sales-history
 *
 * Returns per-line sales records for a product across the workspace's orders.
 * Lines are matched against order_line_items by product_id or name.
 *
 * Aggregate totals (quantity sum + revenue grouped by currency) reflect the
 * active date filter and ignore pagination.
 */
router.get("/products/:id/sales-history", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid product id" });
    return;
  }

  const parsed = salesHistoryQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid query parameters",
      details: parsed.error.issues.map((i) => `${i.path.join(".") || "root"}: ${i.message}`),
    });
    return;
  }
  const { from, to, page, pageSize } = parsed.data;

  const productResult = await db.query<{ id: number; name: string }>(
    `SELECT id, name FROM products WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (productResult.rowCount === 0) {
    res.status(404).json({ error: "Product not found" });
    return;
  }
  const product = productResult.rows[0];

  const params: unknown[] = [wreq.workspaceOwnerId, id, product.name];
  const matchKey = "both" as const;
  const matchPredicate = `(li.product_id = $2 OR lower(li.name) = lower($3))`;

  const dateClauses: string[] = [];
  if (from) {
    params.push(from);
    dateClauses.push(`o.ordered_at >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    dateClauses.push(`o.ordered_at <= $${params.length}`);
  }
  const dateClause = dateClauses.length > 0 ? ` AND ${dateClauses.join(" AND ")}` : "";

  const baseCte = `
    WITH matched AS (
      SELECT o.id AS order_id,
             o.display_order_number,
             o.external_order_id,
             o.status,
             o.ordered_at,
             o.totals->>'currency' AS currency,
             li.quantity::text,
             li.unit_price::text,
             li.line_total::text
        FROM order_line_items li
        JOIN orders o ON o.id = li.order_id
       WHERE o.workspace_owner_id = $1
         AND ${matchPredicate}
         ${dateClause}
    )`;

  params.push(pageSize);
  const limitParam = params.length;
  const offset = (page - 1) * pageSize;
  params.push(offset);
  const offsetParam = params.length;

  const [rowsResult, countResult, totalsResult] = await Promise.all([
    db.query<SalesHistoryRow>(
      `${baseCte}
       SELECT * FROM matched
        ORDER BY ordered_at DESC NULLS LAST, order_id DESC
        LIMIT $${limitParam} OFFSET $${offsetParam}`,
      params,
    ),
    db.query<{ total: string }>(
      `${baseCte} SELECT COUNT(*) AS total FROM matched`,
      params.slice(0, params.length - 2),
    ),
    db.query<{ currency: string | null; quantity_sum: string | null; revenue_sum: string | null }>(
      `${baseCte}
       SELECT currency,
              COALESCE(SUM(NULLIF(quantity, '')::numeric), 0) AS quantity_sum,
              COALESCE(SUM(NULLIF(line_total, '')::numeric), 0) AS revenue_sum
         FROM matched
        GROUP BY currency`,
      params.slice(0, params.length - 2),
    ),
  ]);

  const items = rowsResult.rows.map((r) => ({
    order_id: r.order_id,
    order_display_number: r.display_order_number ?? null,
    external_order_id: r.external_order_id ?? null,
    status: r.status,
    date: r.ordered_at != null ? new Date(r.ordered_at).toISOString() : null,
    quantity: r.quantity != null ? Number(r.quantity) : 0,
    unit_price: r.unit_price != null && r.unit_price !== "" ? Number(r.unit_price) : null,
    line_total: r.line_total != null && r.line_total !== "" ? Number(r.line_total) : null,
    currency: r.currency,
  }));

  let totalQuantity = 0;
  const revenueMap = new Map<string, number>();
  for (const row of totalsResult.rows) {
    const qty = row.quantity_sum != null ? Number(row.quantity_sum) : 0;
    if (Number.isFinite(qty)) totalQuantity += qty;
    const rev = row.revenue_sum != null ? Number(row.revenue_sum) : 0;
    const cur = row.currency ?? "";
    if (cur && Number.isFinite(rev) && rev !== 0) {
      revenueMap.set(cur, (revenueMap.get(cur) ?? 0) + rev);
    }
  }
  const total = parseInt(countResult.rows[0]?.total ?? "0", 10);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  sendValidated(
    req,
    res,
    salesHistoryResponseSchema,
    {
      items,
      totals: {
        total_quantity: totalQuantity,
        revenue_by_currency: Array.from(revenueMap.entries()).map(([currency, total]) => ({ currency, total })),
      },
      page,
      pageSize,
      total,
      totalPages,
      matchKey,
    },
    "GET /products/:id/sales-history",
  );
});

const salesHistoryExportQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

/**
 * GET /api/products/:id/sales-history/export
 *
 * Streams the full (non-paginated) sales history for a product as a CSV file,
 * respecting the same from/to date filters as the paginated endpoint.
 * Columns: date, store, order_id, status, quantity, unit_price, line_total, currency
 */
router.get("/products/:id/sales-history/export", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid product id" });
    return;
  }

  const parsed = salesHistoryExportQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid query parameters",
      details: parsed.error.issues.map((i) => `${i.path.join(".") || "root"}: ${i.message}`),
    });
    return;
  }
  const { from, to } = parsed.data;

  const productResult = await db.query<{ id: number; name: string }>(
    `SELECT id, name FROM products WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (productResult.rowCount === 0) {
    res.status(404).json({ error: "Product not found" });
    return;
  }
  const product = productResult.rows[0];

  const params: unknown[] = [wreq.workspaceOwnerId, id, product.name];
  const matchPredicate = `(li.product_id = $2 OR lower(li.name) = lower($3))`;

  const dateClauses: string[] = [];
  if (from) {
    params.push(from);
    dateClauses.push(`o.ordered_at >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    dateClauses.push(`o.ordered_at <= $${params.length}`);
  }
  const dateClause = dateClauses.length > 0 ? ` AND ${dateClauses.join(" AND ")}` : "";

  const baseCte = `
    WITH matched AS (
      SELECT o.id AS order_id,
             o.display_order_number,
             o.external_order_id,
             o.status,
             o.ordered_at,
             o.totals->>'currency' AS currency,
             li.quantity::text,
             li.unit_price::text,
             li.line_total::text
        FROM order_line_items li
        JOIN orders o ON o.id = li.order_id
       WHERE o.workspace_owner_id = $1
         AND ${matchPredicate}
         ${dateClause}
    )`;

  const rowsResult = await db.query<SalesHistoryRow>(
    `${baseCte}
     SELECT * FROM matched
      ORDER BY ordered_at DESC NULLS LAST, order_id DESC`,
    params,
  );

  function csvEscape(value: string | null | undefined): string {
    if (value == null) return "";
    const s = String(value);
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  }

  const safeProductName = product.name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60);
  const filename = `sales-history-${safeProductName}.csv`;

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

  const headers = ["date", "order_ref", "status", "quantity", "unit_price", "line_total", "currency"];
  res.write(headers.join(",") + "\n");

  const EXPORT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const r of rowsResult.rows) {
    const date = r.ordered_at ? new Date(r.ordered_at).toISOString() : "";
    const quantity = r.quantity != null && r.quantity !== "" ? String(Number(r.quantity)) : "";
    const unitPrice = r.unit_price != null && r.unit_price !== "" ? String(Number(r.unit_price)) : "";
    const lineTotal = r.line_total != null && r.line_total !== "" ? String(Number(r.line_total)) : "";
    const orderRef = r.display_order_number
      ? `#${r.display_order_number}`
      : r.external_order_id && !EXPORT_UUID_RE.test(r.external_order_id)
        ? `#${r.external_order_id}`
        : `#${r.order_id.slice(0, 8)}…`;
    const row = [
      csvEscape(date),
      csvEscape(orderRef),
      csvEscape(r.status),
      csvEscape(quantity),
      csvEscape(unitPrice),
      csvEscape(lineTotal),
      csvEscape(r.currency),
    ];
    res.write(row.join(",") + "\n");
  }

  res.end();
});

/**
 * PUT /api/products/:id/recipe
 * Upsert the full recipe for a product.
 * Accepts { items: Array<{ base_item_id: number, quantity: number }> }.
 * Requires owner role or products.manage permission.
 */
router.put("/products/:id/recipe", async (req, res) => {
  const wreq = workspace(req);
  if (!ownerOnly(wreq, res)) return;

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid product id" });
    return;
  }

  const productCheck = await db.query<{ id: number }>(
    `SELECT id FROM products WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (productCheck.rowCount === 0) {
    res.status(404).json({ error: "Product not found" });
    return;
  }

  const items: Array<{ base_item_id: number; quantity: number; sort_order?: number }> = Array.isArray(req.body?.items)
    ? req.body.items
    : [];

  for (const item of items) {
    const qty = parseFloat(String(item.quantity));
    if (isNaN(qty) || qty <= 0) {
      res.status(400).json({ error: "Each recipe item must have a positive quantity" });
      return;
    }
  }

  const incomingIds = items.map((it) => Number(it.base_item_id));

  if (incomingIds.length > 0) {
    const baseCheck = await db.query<{ id: number }>(
      `SELECT id FROM base_items WHERE id = ANY($1) AND workspace_owner_id = $2`,
      [incomingIds, wreq.workspaceOwnerId],
    );
    if ((baseCheck.rowCount ?? 0) !== incomingIds.length) {
      res.status(400).json({ error: "One or more base items not found in this workspace" });
      return;
    }
  }

  const client = await db.connect();
  let versionResult: import("pg").QueryResult<{ recipe_version: number }>;
  let recipeResult: import("pg").QueryResult<RecipeRow>;
  try {
    await client.query("BEGIN");

    // The lock is intentionally acquired before the delete.  Base Item merge
    // takes the same Product lock before rewriting recipes, which serializes
    // the two semantic recipe mutations.
    const lockedProduct = await client.query<{ id: number }>(
      `SELECT id
         FROM products
        WHERE id = $1 AND workspace_owner_id = $2
        FOR UPDATE`,
      [id, wreq.workspaceOwnerId],
    );
    if (lockedProduct.rowCount === 0) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Product not found" });
      return;
    }

    await client.query(
      `DELETE FROM product_recipes WHERE product_id = $1 AND workspace_owner_id = $2`,
      [id, wreq.workspaceOwnerId],
    );

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const sortOrder = typeof item.sort_order === "number" ? item.sort_order : i;
      await client.query(
        `INSERT INTO product_recipes (workspace_owner_id, product_id, base_item_id, quantity, sort_order)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (product_id, base_item_id) DO UPDATE SET quantity = EXCLUDED.quantity, sort_order = EXCLUDED.sort_order`,
        [wreq.workspaceOwnerId, id, Number(item.base_item_id), parseFloat(String(item.quantity)), sortOrder],
      );
    }
    versionResult = await client.query<{ recipe_version: number }>(
      `UPDATE products
          SET recipe_version = recipe_version + 1
        WHERE id = $1 AND workspace_owner_id = $2
        RETURNING recipe_version`,
      [id, wreq.workspaceOwnerId],
    );

    recipeResult = await client.query<RecipeRow>(
      `SELECT pr.base_item_id, bi.name, bi.code, bi.image_url, pr.quantity
         FROM product_recipes pr
         JOIN base_items bi ON bi.id = pr.base_item_id
        WHERE pr.product_id = $1 AND pr.workspace_owner_id = $2
        ORDER BY pr.sort_order ASC, pr.created_at ASC`,
      [id, wreq.workspaceOwnerId],
    );
    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original database error if the rollback itself fails.
    }
    throw err;
  } finally {
    client.release();
  }

  res.json({
    recipe: recipeResult.rows,
    live_recipe_version: Number(versionResult.rows[0]?.recipe_version ?? 0),
  });
});

/**
 * POST /api/products
 * Create a new product. Requires owner role or products.manage permission.
 */
router.post("/products", async (req, res) => {
  const wreq = workspace(req);
  if (!ownerOnly(wreq, res)) return;

  const { name, price_usd, price_aed, main_image_url, additional_image_urls, description, status, brand, tags, express_delivery_enabled, has_input_field, letter_input_enabled, is_upsell, is_cmc: is_cmc_raw, inventory_tracked: inventory_tracked_raw } = req.body ?? {};

  const trimmedName = String(name ?? "").trim();
  if (!trimmedName) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  const parsedPriceUsd = parseFloat(price_usd);
  if (isNaN(parsedPriceUsd) || parsedPriceUsd < 0) {
    res.status(400).json({ error: "price_usd must be a non-negative number" });
    return;
  }

  const parsedPriceAed = parseFloat(price_aed);
  if (isNaN(parsedPriceAed) || parsedPriceAed < 0) {
    res.status(400).json({ error: "price_aed must be a non-negative number" });
    return;
  }

  const discountUsdResult = resolveDiscountPrice(req.body?.discount_price_usd, parsedPriceUsd, "discount_price_usd");
  if ("error" in discountUsdResult) {
    res.status(400).json({ error: discountUsdResult.error });
    return;
  }
  const discountAedResult = resolveDiscountPrice(req.body?.discount_price_aed, parsedPriceAed, "discount_price_aed");
  if ("error" in discountAedResult) {
    res.status(400).json({ error: discountAedResult.error });
    return;
  }
  const discountPriceUsd = discountUsdResult.value;
  const discountPriceAed = discountAedResult.value;

  const validStatus = VALID_STATUSES.includes(status) ? status : "available";
  const trimmedBrand = brand ? String(brand).trim() || null : null;
  const trimmedDescription = description ? String(description).trim() || null : null;
  const mainImageUrl = main_image_url ? String(main_image_url) : null;
  if (!isOwnedObjectPath(mainImageUrl, wreq.workspaceOwnerId)) {
    res.status(400).json({ error: "main_image_url must reference an object within your workspace" });
    return;
  }
  const additionalUrls: string[] = Array.isArray(additional_image_urls) ? additional_image_urls.filter(Boolean) : [];
  if (additionalUrls.length > MAX_ADDITIONAL_IMAGES) {
    res.status(400).json({ error: `A product may have at most ${MAX_ADDITIONAL_IMAGES} additional images` });
    return;
  }
  const tagList: string[] = Array.isArray(tags) ? tags.filter(Boolean) : [];
  // Default-on: a product is express-eligible unless explicitly disabled.
  const expressDeliveryEnabled = typeof express_delivery_enabled === "boolean" ? express_delivery_enabled : true;
  // Default-off: products do not show a personalization input unless enabled.
  const hasInputField = typeof has_input_field === "boolean" ? has_input_field : false;
  // Default-off: products do not show a single-letter input unless enabled.
  const letterInputEnabled = typeof letter_input_enabled === "boolean" ? letter_input_enabled : false;
  // Default-off: products are not upsell items unless explicitly enabled.
  const isUpsell = typeof is_upsell === "boolean" ? is_upsell : false;
  const isCmc = typeof is_cmc_raw === "boolean" ? is_cmc_raw : false;
  const inventoryTracked = typeof inventory_tracked_raw === "boolean" ? inventory_tracked_raw : false;

  let insertResult: { rows: ProductRow[] } | null = null;
  try {
    for (let attempt = 0; attempt < SKU_MAX_ATTEMPTS; attempt++) {
      const sku = await generateUniqueSku(wreq.workspaceOwnerId);
      try {
        insertResult = (await db.query(
          `INSERT INTO products
             (workspace_owner_id, name, price_usd, price_aed, discount_price_usd, discount_price_aed,
              main_image_url, additional_image_urls,
              description, status, brand, tags, sku, express_delivery_enabled, has_input_field, letter_input_enabled, is_upsell, is_cmc, inventory_tracked)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
           RETURNING *`,
          [wreq.workspaceOwnerId, trimmedName, parsedPriceUsd, parsedPriceAed, discountPriceUsd, discountPriceAed, mainImageUrl, additionalUrls, trimmedDescription, validStatus, trimmedBrand, tagList, sku, expressDeliveryEnabled, hasInputField, letterInputEnabled, isUpsell, isCmc, inventoryTracked],
        )) as { rows: ProductRow[] };
        break;
      } catch (err: unknown) {
        const pgErr = err as { code?: string };
        if (pgErr?.code === "23505") {
          continue;
        }
        throw err;
      }
    }
  } catch (err: unknown) {
    const isSkuExhaustion = err instanceof Error && err.message === "SKU_SPACE_EXHAUSTED";
    if (!isSkuExhaustion) throw err;
    res.status(500).json({
      error: "SKU space is near full for this workspace. Please contact support.",
      code: "SKU_SPACE_EXHAUSTED",
    });
    return;
  }
  if (!insertResult) {
    logger.error(
      { maxAttempts: SKU_MAX_ATTEMPTS, workspaceOwnerId: wreq.workspaceOwnerId },
      "SKU insert retries exhausted due to repeated unique constraint violations",
    );
    res.status(500).json({
      error: "SKU space is near full for this workspace. Please contact support.",
      code: "SKU_SPACE_EXHAUSTED",
    });
    return;
  }
  if (validStatus !== "not_available" && trimmedBrand) {
    await maybeAutoActivateLocationsByBrand(wreq.workspaceOwnerId, trimmedBrand, req.log);
  }
  const newProduct = insertResult.rows[0];
  // Enqueue a Google Merchant Center sync job for the new product.
  void enqueueProductCreateOrUpdateSync(newProduct as unknown as import("@workspace/db/schema").Product);
  // Mirror the product images into the public bucket so external consumers can
  // render them via auth-free URLs. Failures are logged and swallowed inside.
  void syncProductPublicImages(
    Number(newProduct.id),
    mainImageUrl,
    additionalUrls,
    wreq.workspaceOwnerId,
  );
  // Non-blocking: auto-publish to channels configured with auto_publish_new_products=true.
  void autoPublishToChannels(Number(newProduct.id), wreq.workspaceOwnerId, trimmedBrand ?? null);
  // Non-blocking: notify subscribers that the product catalog changed.
  void fireCatalogDataWebhook("catalog.products.changed", wreq.workspaceOwnerId, { action: "created", product_id: newProduct.id });
  void fireCatalogDataWebhook("product.created", wreq.workspaceOwnerId, { product: newProduct as unknown as Record<string, unknown> });

  // Catalog-category + occasion links (the new combined picker). Only written
  // when the field is present in the body. Categorization now lives entirely in
  // these join tables (the legacy free-text `category` column has been retired).
  const responseProduct: ProductRow = { ...newProduct };
  const catalogCategoryIds = parseAttributeIds(req.body?.catalog_category_ids);
  if (catalogCategoryIds !== null) {
    responseProduct.catalog_categories = await replaceProductAttributeLinks(
      Number(newProduct.id), wreq.workspaceOwnerId, "product_catalog_categories", "catalog_categories", catalogCategoryIds,
    );
  }
  const occasionIds = parseAttributeIds(req.body?.occasion_ids);
  if (occasionIds !== null) {
    responseProduct.occasions = await replaceProductAttributeLinks(
      Number(newProduct.id), wreq.workspaceOwnerId, "product_occasions", "occasions", occasionIds,
    );
  }
  // Optional single catalog-brand link (separate from the required text `brand`).
  const newCatalogBrandId = parseCatalogBrandId(req.body?.catalog_brand_id);
  if (newCatalogBrandId !== undefined) {
    responseProduct.catalog_brand = await replaceProductCatalogBrand(
      Number(newProduct.id), wreq.workspaceOwnerId, newCatalogBrandId,
    );
  }
  // Keep the derived `category` field consistent with the catalog-category links.
  responseProduct.category = await fetchPrimaryCategory(Number(newProduct.id));

  res.status(201).json({ product: decorateProductImageUrls(responseProduct) });
});

/**
 * POST /api/products/:id/duplicate
 * Create a full copy of an existing product within the caller's workspace. The
 * copy carries over every catalog field (name prefixed with "Copy of "), the
 * category/occasion/catalog-brand associations, and the source product's
 * country + city availability rows. A fresh unique SKU is generated. Requires
 * owner role or the products.manage permission (same gating as create).
 */
router.post("/products/:id/duplicate", async (req, res) => {
  const wreq = workspace(req);
  if (!ownerOnly(wreq, res)) return;

  const sourceId = parseInt(req.params.id, 10);
  if (isNaN(sourceId)) {
    res.status(400).json({ error: "Invalid product id" });
    return;
  }

  const sourceResult = await db.query<ProductRow>(
    `SELECT * FROM products WHERE id = $1 AND workspace_owner_id = $2`,
    [sourceId, wreq.workspaceOwnerId],
  );
  if (sourceResult.rowCount === 0) {
    res.status(404).json({ error: "Product not found" });
    return;
  }
  const source = sourceResult.rows[0];

  const copyName = `Copy of ${source.name}`;
  const additionalUrls: string[] = Array.isArray(source.additional_image_urls)
    ? source.additional_image_urls.filter(Boolean)
    : [];
  const tagList: string[] = Array.isArray(source.tags) ? source.tags.filter(Boolean) : [];

  let insertResult: { rows: ProductRow[] } | null = null;
  try {
    for (let attempt = 0; attempt < SKU_MAX_ATTEMPTS; attempt++) {
      const sku = await generateUniqueSku(wreq.workspaceOwnerId);
      try {
        insertResult = (await db.query(
          `INSERT INTO products
             (workspace_owner_id, name, price_usd, price_aed, discount_price_usd, discount_price_aed,
              main_image_url, additional_image_urls,
              description, status, brand, tags, sku, express_delivery_enabled, has_input_field, letter_input_enabled, is_upsell, is_cmc)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
           RETURNING *`,
          [
            wreq.workspaceOwnerId,
            copyName,
            source.price_usd,
            source.price_aed,
            source.discount_price_usd ?? null,
            source.discount_price_aed ?? null,
            source.main_image_url,
            additionalUrls,
            source.description,
            source.status,
            source.brand,
            tagList,
            sku,
            source.express_delivery_enabled,
            source.has_input_field,
            source.letter_input_enabled,
            source.is_upsell,
            source.is_cmc ?? false,
          ],
        )) as { rows: ProductRow[] };
        break;
      } catch (err: unknown) {
        const pgErr = err as { code?: string };
        if (pgErr?.code === "23505") {
          continue;
        }
        throw err;
      }
    }
  } catch (err: unknown) {
    const isSkuExhaustion = err instanceof Error && err.message === "SKU_SPACE_EXHAUSTED";
    if (!isSkuExhaustion) throw err;
    res.status(500).json({
      error: "SKU space is near full for this workspace. Please contact support.",
      code: "SKU_SPACE_EXHAUSTED",
    });
    return;
  }
  if (!insertResult) {
    logger.error(
      { maxAttempts: SKU_MAX_ATTEMPTS, workspaceOwnerId: wreq.workspaceOwnerId },
      "SKU insert retries exhausted due to repeated unique constraint violations",
    );
    res.status(500).json({
      error: "SKU space is near full for this workspace. Please contact support.",
      code: "SKU_SPACE_EXHAUSTED",
    });
    return;
  }
  const newProduct = insertResult.rows[0];
  const newId = Number(newProduct.id);

  // Copy category / occasion / catalog-brand associations.
  await db.query(
    `INSERT INTO product_catalog_categories (product_id, attribute_id)
       SELECT $1, attribute_id FROM product_catalog_categories WHERE product_id = $2
       ON CONFLICT (product_id, attribute_id) DO NOTHING`,
    [newId, sourceId],
  );
  await db.query(
    `INSERT INTO product_occasions (product_id, attribute_id)
       SELECT $1, attribute_id FROM product_occasions WHERE product_id = $2
       ON CONFLICT (product_id, attribute_id) DO NOTHING`,
    [newId, sourceId],
  );
  await db.query(
    `INSERT INTO product_catalog_brands (product_id, attribute_id)
       SELECT $1, attribute_id FROM product_catalog_brands WHERE product_id = $2
       ON CONFLICT (product_id, attribute_id) DO NOTHING`,
    [newId, sourceId],
  );

  // Copy country + city availability overrides (default-on toggle-off rows).
  await db.query(
    `INSERT INTO product_country_availability (product_id, country_code, is_available, created_at, updated_at)
       SELECT $1, country_code, is_available, now(), now()
         FROM product_country_availability WHERE product_id = $2
       ON CONFLICT (product_id, country_code) DO NOTHING`,
    [newId, sourceId],
  );
  await db.query(
    `INSERT INTO product_city_availability (product_id, city_id, is_available, created_at, updated_at)
       SELECT $1, city_id, is_available, now(), now()
         FROM product_city_availability WHERE product_id = $2
       ON CONFLICT (product_id, city_id) DO NOTHING`,
    [newId, sourceId],
  );

  if (source.status !== "not_available" && source.brand) {
    await maybeAutoActivateLocationsByBrand(wreq.workspaceOwnerId, source.brand, req.log);
  }
  // Mirror the copied images into the public bucket (best-effort, non-throwing).
  void syncProductPublicImages(newId, source.main_image_url, additionalUrls, wreq.workspaceOwnerId);
  // Non-blocking side effects, mirroring the create flow.
  void autoPublishToChannels(newId, wreq.workspaceOwnerId, source.brand ?? null);
  void fireCatalogDataWebhook("catalog.products.changed", wreq.workspaceOwnerId, { action: "created", product_id: newId });
  void fireCatalogDataWebhook("product.created", wreq.workspaceOwnerId, { product: newProduct as unknown as Record<string, unknown> });

  // Re-fetch the created product with its resolved associations for the response.
  const fullResult = await db.query<ProductRow>(
    `SELECT p.id, p.workspace_owner_id, p.name, p.price_usd, p.price_aed,
            p.discount_price_usd, p.discount_price_aed,
            p.main_image_url, p.additional_image_urls, p.description,
            p.status, p.brand, p.tags, ${primaryCategorySql("p")} AS category, p.created_at,
            p.is_archived, p.express_delivery_enabled, p.has_input_field, p.letter_input_enabled, p.is_upsell, p.is_cmc,
            p.inventory_tracked,
            (SELECT json_build_object('id', cb.id, 'name', cb.name, 'slug', cb.slug)
               FROM product_catalog_brands pcb
               JOIN catalog_brands cb ON cb.id = pcb.attribute_id
              WHERE pcb.product_id = p.id
              ORDER BY cb.name ASC
              LIMIT 1) AS catalog_brand,
            ${attributeAggSql("p")}
       FROM products p
      WHERE p.id = $1 AND p.workspace_owner_id = $2`,
    [newId, wreq.workspaceOwnerId],
  );

  res.status(201).json({
    product: decorateProductImageUrls(fullResult.rows[0] ?? newProduct),
  });
});

/**
 * PATCH /api/products/bulk
 * Bulk-update up to 500 products. Supported update fields:
 *   - status, brand, is_archived (column updates, applied as before)
 *   - add_catalog_category_ids / add_occasion_ids: ADDITIVE attribute links
 *     (appended to each product's existing links, deduped; existing links are
 *     never removed)
 *   - catalog_brand_id: sets the single item-brand link on each product
 *     (replaces any existing brand link — products carry at most one)
 *   - country_availability / city_availability: upserts default-on exclusion
 *     rows, same model as the per-product availability endpoints
 * Only fields present in the updates object are applied; omitting a field
 * leaves it unchanged. Requires owner role or products.manage permission.
 */
router.patch("/products/bulk", async (req, res) => {
  const wreq = workspace(req);
  if (!ownerOnly(wreq, res)) return;

  const bodySchema = z.object({
    ids: z.array(z.number().int().positive()).min(1).max(500),
    updates: z
      .object({
        status: z.enum(VALID_STATUSES).optional(),
        brand: z.string().nullable().optional(),
        is_archived: z.boolean().optional(),
        add_catalog_category_ids: z.array(z.number().int().positive()).max(100).optional(),
        add_occasion_ids: z.array(z.number().int().positive()).max(100).optional(),
        catalog_brand_id: z.number().int().positive().optional(),
        country_availability: z
          .array(z.object({ country_code: z.string().trim().min(2), is_available: z.boolean() }))
          .max(100)
          .optional(),
        city_availability: z
          .array(z.object({ city_id: z.number().int().positive(), is_available: z.boolean() }))
          .max(500)
          .optional(),
      })
      .refine(
        (obj) => Object.values(obj).some((v) => v !== undefined),
        { message: "At least one update field is required" },
      ),
  });

  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid request body",
      details: parsed.error.issues.map((i) => `${i.path.join(".") || "root"}: ${i.message}`),
    });
    return;
  }

  const { ids, updates } = parsed.data;

  // Resolve the subset of requested ids that actually belong to this workspace;
  // every follow-up write is restricted to these.
  const ownedResult = await db.query<{ id: number }>(
    `SELECT id FROM products WHERE workspace_owner_id = $1 AND id = ANY($2::int[])`,
    [wreq.workspaceOwnerId, ids],
  );
  const ownedIds = ownedResult.rows.map((r) => r.id);
  if (ownedIds.length === 0) {
    res.json({ updated: 0 });
    return;
  }

  // ── Plain column updates (status / brand / is_archived) ──────────────────
  const setClauses: string[] = [];
  const params: unknown[] = [wreq.workspaceOwnerId];

  if (updates.status !== undefined) {
    params.push(updates.status);
    setClauses.push(`status = $${params.length}`);
  }
  if ("brand" in updates) {
    const brand = typeof updates.brand === "string" ? updates.brand.trim() || null : null;
    params.push(brand);
    setClauses.push(`brand = $${params.length}`);
  }
  if (updates.is_archived !== undefined) {
    params.push(updates.is_archived);
    setClauses.push(`is_archived = $${params.length}`);
  }

  if (setClauses.length > 0) {
    const idPlaceholders = ownedIds.map((_, i) => `$${params.length + 1 + i}`).join(", ");
    params.push(...ownedIds);
    await db.query(
      `UPDATE products SET ${setClauses.join(", ")} WHERE workspace_owner_id = $1 AND id IN (${idPlaceholders})`,
      params,
    );
    // Enqueue Merchant Center sync for each updated product.
    const updatedRows = await db.query<ProductRow>(
      `SELECT * FROM products WHERE workspace_owner_id = $1 AND id = ANY($2::int[])`,
      [wreq.workspaceOwnerId, ownedIds],
    );
    for (const row of updatedRows.rows) {
      void enqueueProductCreateOrUpdateSync(row as unknown as import("@workspace/db/schema").Product);
    }
  }

  // ── Additive catalog-category / occasion links ────────────────────────────
  async function appendAttributeLinks(
    joinTable: "product_catalog_categories" | "product_occasions",
    attrTable: "catalog_categories" | "occasions",
    attrIds: number[],
  ): Promise<void> {
    if (attrIds.length === 0) return;
    const valid = await db.query<{ id: number }>(
      `SELECT id FROM ${attrTable} WHERE id = ANY($1) AND workspace_owner_id = $2`,
      [attrIds, wreq.workspaceOwnerId],
    );
    for (const attr of valid.rows) {
      await db.query(
        `INSERT INTO ${joinTable} (product_id, attribute_id)
         SELECT pid, $2 FROM unnest($1::int[]) AS pid
         ON CONFLICT (product_id, attribute_id) DO NOTHING`,
        [ownedIds, attr.id],
      );
    }
  }
  if (updates.add_catalog_category_ids) {
    await appendAttributeLinks("product_catalog_categories", "catalog_categories", updates.add_catalog_category_ids);
  }
  if (updates.add_occasion_ids) {
    await appendAttributeLinks("product_occasions", "occasions", updates.add_occasion_ids);
  }

  // ── Item brand (single-link: setting replaces any existing brand link) ────
  if (updates.catalog_brand_id !== undefined) {
    const brandCheck = await db.query<{ id: number }>(
      `SELECT id FROM catalog_brands WHERE id = $1 AND workspace_owner_id = $2`,
      [updates.catalog_brand_id, wreq.workspaceOwnerId],
    );
    if (brandCheck.rowCount === 0) {
      res.status(400).json({ error: "catalog_brand_id does not reference a catalog brand in your workspace" });
      return;
    }
    await db.query(`DELETE FROM product_catalog_brands WHERE product_id = ANY($1::int[])`, [ownedIds]);
    await db.query(
      `INSERT INTO product_catalog_brands (product_id, attribute_id)
       SELECT pid, $2 FROM unnest($1::int[]) AS pid
       ON CONFLICT (product_id, attribute_id) DO NOTHING`,
      [ownedIds, updates.catalog_brand_id],
    );
  }

  // ── Country / city availability (default-on exclusion model) ─────────────
  if (updates.country_availability && updates.country_availability.length > 0) {
    const universe = await getWorkspaceCountryCodes(wreq.workspaceOwnerId);
    const validCodes = new Set(universe.map((c) => c.code));
    for (const u of updates.country_availability) {
      const code = u.country_code.trim().toUpperCase();
      if (!validCodes.has(code)) continue;
      await db.query(
        `INSERT INTO product_country_availability (product_id, country_code, is_available, created_at, updated_at)
         SELECT pid, $2, $3, now(), now() FROM unnest($1::int[]) AS pid
         ON CONFLICT (product_id, country_code)
         DO UPDATE SET is_available = EXCLUDED.is_available, updated_at = now()`,
        [ownedIds, code, u.is_available],
      );
    }
  }
  if (updates.city_availability && updates.city_availability.length > 0) {
    const cityIds = updates.city_availability.map((u) => u.city_id);
    const validCityResult = await db.query<{ id: number }>(
      `SELECT id FROM delivery_cities WHERE workspace_owner_id = $1 AND id = ANY($2::int[])`,
      [wreq.workspaceOwnerId, cityIds],
    );
    const validCityIds = new Set(validCityResult.rows.map((r) => r.id));
    for (const u of updates.city_availability) {
      if (!validCityIds.has(u.city_id)) continue;
      await db.query(
        `INSERT INTO product_city_availability (product_id, city_id, is_available, created_at, updated_at)
         SELECT pid, $2, $3, now(), now() FROM unnest($1::int[]) AS pid
         ON CONFLICT (product_id, city_id)
         DO UPDATE SET is_available = EXCLUDED.is_available, updated_at = now()`,
        [ownedIds, u.city_id, u.is_available],
      );
    }
  }

  res.json({ updated: ownedIds.length });
  void fireCatalogDataWebhook("catalog.products.changed", wreq.workspaceOwnerId, {
    action: "bulk_updated",
    product_ids: ownedIds,
  });
});

/**
 * POST /api/products/bulk-delete
 * Permanently delete up to 500 products. Owner only — the products.manage
 * page permission is NOT sufficient for bulk deletion.
 */
router.post("/products/bulk-delete", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Only the workspace owner can bulk-delete products" });
    return;
  }

  const bodySchema = z.object({
    ids: z.array(z.number().int().positive()).min(1).max(500),
  });
  const parsed = bodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      error: "Invalid request body",
      details: parsed.error.issues.map((i) => `${i.path.join(".") || "root"}: ${i.message}`),
    });
    return;
  }

  // Fetch owned product rows before deletion to snapshot payloads for Merchant sync.
  const preBulkDelete = await db.query<ProductRow>(
    `SELECT * FROM products WHERE workspace_owner_id = $1 AND id = ANY($2::int[])`,
    [wreq.workspaceOwnerId, parsed.data.ids],
  );

  const deletedResult = await db.query<{ id: number }>(
    `DELETE FROM products WHERE workspace_owner_id = $1 AND id = ANY($2::int[]) RETURNING id`,
    [wreq.workspaceOwnerId, parsed.data.ids],
  );
  const deletedIds = deletedResult.rows.map((r) => r.id);

  // Enqueue Merchant Center delete jobs after the rows are gone.
  for (const row of preBulkDelete.rows) {
    void enqueueProductDeleteSync(row as unknown as import("@workspace/db/schema").Product);
  }

  res.json({ deleted: deletedIds.length });
  for (const id of deletedIds) {
    void fireCatalogDataWebhook("catalog.products.changed", wreq.workspaceOwnerId, { action: "deleted", product_id: id });
    void fireCatalogDataWebhook("product.deleted", wreq.workspaceOwnerId, { id, deleted: true });
  }
});

/**
 * PATCH /api/products/:id
 * Update a product. Requires owner role or products.manage permission.
 */
router.patch("/products/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!ownerOnly(wreq, res)) return;

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid product id" });
    return;
  }

  const existing = await db.query<ProductRow>(
    `SELECT * FROM products WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (existing.rowCount === 0) {
    res.status(404).json({ error: "Product not found" });
    return;
  }

  const prev = existing.rows[0];
  const body = req.body ?? {};

  const name = "name" in body ? String(body.name ?? "").trim() : prev.name;
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  const price_usd = "price_usd" in body ? parseFloat(body.price_usd) : parseFloat(prev.price_usd);
  const price_aed = "price_aed" in body ? parseFloat(body.price_aed) : parseFloat(prev.price_aed);

  if (isNaN(price_usd) || price_usd < 0) {
    res.status(400).json({ error: "price_usd must be a non-negative number" });
    return;
  }
  if (isNaN(price_aed) || price_aed < 0) {
    res.status(400).json({ error: "price_aed must be a non-negative number" });
    return;
  }

  let discount_price_usd: number | null;
  if ("discount_price_usd" in body) {
    const r = resolveDiscountPrice(body.discount_price_usd, price_usd, "discount_price_usd");
    if ("error" in r) {
      res.status(400).json({ error: r.error });
      return;
    }
    discount_price_usd = r.value;
  } else {
    discount_price_usd = prev.discount_price_usd != null ? parseFloat(String(prev.discount_price_usd)) : null;
  }
  let discount_price_aed: number | null;
  if ("discount_price_aed" in body) {
    const r = resolveDiscountPrice(body.discount_price_aed, price_aed, "discount_price_aed");
    if ("error" in r) {
      res.status(400).json({ error: r.error });
      return;
    }
    discount_price_aed = r.value;
  } else {
    discount_price_aed = prev.discount_price_aed != null ? parseFloat(String(prev.discount_price_aed)) : null;
  }

  const status = "status" in body && VALID_STATUSES.includes(body.status) ? body.status : prev.status;
  const main_image_url = "main_image_url" in body ? (body.main_image_url || null) : prev.main_image_url;
  if (!isOwnedObjectPath(main_image_url, wreq.workspaceOwnerId)) {
    res.status(400).json({ error: "main_image_url must reference an object within your workspace" });
    return;
  }
  let additional_image_urls = prev.additional_image_urls;
  if ("additional_image_urls" in body) {
    const requestedAdditionalUrls = body.additional_image_urls;
    if (!Array.isArray(requestedAdditionalUrls) || requestedAdditionalUrls.some((url: unknown) =>
      typeof url !== "string" || url.length === 0 || !isOwnedObjectPath(url, wreq.workspaceOwnerId)
    )) {
      res.status(400).json({ error: "additional_image_urls must be an array of objects within your workspace" });
      return;
    }
    additional_image_urls = requestedAdditionalUrls;
  }
  if (additional_image_urls.length > MAX_ADDITIONAL_IMAGES) {
    res.status(400).json({ error: `A product may have at most ${MAX_ADDITIONAL_IMAGES} additional images` });
    return;
  }
  const description = "description" in body ? (String(body.description ?? "").trim() || null) : prev.description;
  const brand = "brand" in body ? (String(body.brand ?? "").trim() || null) : prev.brand;
  const tags = "tags" in body ? (Array.isArray(body.tags) ? body.tags.filter(Boolean) : []) : prev.tags;
  const is_archived = "is_archived" in body && typeof body.is_archived === "boolean" ? body.is_archived : prev.is_archived;
  const express_delivery_enabled = "express_delivery_enabled" in body && typeof body.express_delivery_enabled === "boolean"
    ? body.express_delivery_enabled
    : prev.express_delivery_enabled;
  const has_input_field = "has_input_field" in body && typeof body.has_input_field === "boolean"
    ? body.has_input_field
    : prev.has_input_field;
  const letter_input_enabled = "letter_input_enabled" in body && typeof body.letter_input_enabled === "boolean"
    ? body.letter_input_enabled
    : prev.letter_input_enabled;
  const is_upsell = "is_upsell" in body && typeof body.is_upsell === "boolean"
    ? body.is_upsell
    : prev.is_upsell;
  const is_cmc = "is_cmc" in body && typeof body.is_cmc === "boolean"
    ? body.is_cmc
    : (prev.is_cmc ?? false);
  const inventory_tracked = "inventory_tracked" in body && typeof body.inventory_tracked === "boolean"
    ? body.inventory_tracked
    : (prev.inventory_tracked ?? false);
  const merchant_sync_disabled = "merchant_sync_disabled" in body && typeof body.merchant_sync_disabled === "boolean"
    ? body.merchant_sync_disabled
    : (prev.merchant_sync_disabled ?? false);

  const result = await db.query<ProductRow>(
    `UPDATE products
        SET image_public_path = CASE WHEN main_image_url IS DISTINCT FROM $4 THEN NULL ELSE image_public_path END,
            image_display_public_path = CASE WHEN main_image_url IS DISTINCT FROM $4 THEN NULL ELSE image_display_public_path END,
            image_thumbnail_public_path = CASE WHEN main_image_url IS DISTINCT FROM $4 THEN NULL ELSE image_thumbnail_public_path END,
            additional_image_public_paths = CASE WHEN additional_image_urls IS DISTINCT FROM $5::text[] THEN '{}'::text[] ELSE additional_image_public_paths END,
            additional_image_display_public_paths = CASE WHEN additional_image_urls IS DISTINCT FROM $5::text[] THEN '{}'::text[] ELSE additional_image_display_public_paths END,
            additional_image_thumbnail_public_paths = CASE WHEN additional_image_urls IS DISTINCT FROM $5::text[] THEN '{}'::text[] ELSE additional_image_thumbnail_public_paths END,
            name = $1, price_usd = $2, price_aed = $3, main_image_url = $4,
            additional_image_urls = $5, description = $6, status = $7,
            brand = $8, tags = $9, is_archived = $10, express_delivery_enabled = $11,
            has_input_field = $12, letter_input_enabled = $13, discount_price_usd = $14, discount_price_aed = $15,
            is_upsell = $16, is_cmc = $17, inventory_tracked = $18, merchant_sync_disabled = $19
      WHERE id = $20 AND workspace_owner_id = $21
      RETURNING *`,
    [name, price_usd, price_aed, main_image_url, additional_image_urls, description, status, brand, tags, is_archived, express_delivery_enabled, has_input_field, letter_input_enabled, discount_price_usd, discount_price_aed, is_upsell, is_cmc, inventory_tracked, merchant_sync_disabled, id, wreq.workspaceOwnerId],
  );

  const warnings: Array<{ area: string; message: string }> = [];
  async function runPostSaveStep<T>(
    area: string,
    message: string,
    operation: () => Promise<T>,
  ): Promise<T | undefined> {
    try {
      return await operation();
    } catch (err) {
      warnings.push({ area, message });
      req.log?.error?.(
        { err, productId: id, area },
        "Product update post-save operation failed",
      );
      return undefined;
    }
  }

  if (status !== "not_available" && brand) {
    await runPostSaveStep(
      "location activation",
      "Location activation could not be refreshed.",
      () => maybeAutoActivateLocationsByBrand(wreq.workspaceOwnerId, brand, req.log),
    );
  }

  // ── Seed initial CMC stock (idempotent: skipped if an 'initial' row exists) ──
  const initialCmcStockRaw = body.initial_cmc_stock;
  if (is_cmc && typeof initialCmcStockRaw === "number" && Number.isFinite(initialCmcStockRaw) && initialCmcStockRaw >= 0) {
    await runPostSaveStep(
      "initial stock",
      "The product was saved, but its initial stock could not be recorded.",
      async () => {
        const existingInitial = await db.query<{ id: number }>(
          `SELECT id FROM base_item_stock_adjustments
            WHERE product_id = $1 AND workspace_owner_id = $2 AND reason = 'initial'
            LIMIT 1`,
          [id, wreq.workspaceOwnerId],
        );
        if ((existingInitial.rowCount ?? 0) === 0) {
          const callerUserId = (req as unknown as { userId?: string }).userId ?? null;
          await db.query(
            `INSERT INTO base_item_stock_adjustments
               (workspace_owner_id, base_item_id, location_id, quantity_change, reason,
                 movement_type, note, stock_after, created_by_user_id, product_id,
                 ledger_scope)
              VALUES ($1, NULL, NULL, $2, 'initial', 'in', NULL, $2, $3, $4,
                      'cmc_product_compat')`,
            [wreq.workspaceOwnerId, initialCmcStockRaw, callerUserId, id],
          );
        }
      },
    );
  }

  // Enqueue a Google Merchant Center sync job for the updated product.
  enqueueProductCreateOrUpdateSync(
    result.rows[0] as unknown as import("@workspace/db/schema").Product,
  );

  const changedFields: string[] = [];
  const webhookEvents: ProductWebhookEvent[] = [];
  if (name !== prev.name) changedFields.push("name");
  if (description !== prev.description) changedFields.push("description");
  if (brand !== prev.brand) changedFields.push("brand");
  if (JSON.stringify(tags) !== JSON.stringify(prev.tags)) changedFields.push("tags");
  if (price_usd !== parseFloat(String(prev.price_usd)) || price_aed !== parseFloat(String(prev.price_aed))) {
    changedFields.push("price_usd", "price_aed");
    webhookEvents.push("product.price_updated");
  }
  if (status !== prev.status) {
    changedFields.push("status");
    webhookEvents.push("product.availability_updated");
  }
  if (main_image_url !== prev.main_image_url ||
      JSON.stringify(additional_image_urls) !== JSON.stringify(prev.additional_image_urls)) {
    changedFields.push("images");
    webhookEvents.push("product.images_updated");
    // Re-mirror the (possibly cleared) images into the public bucket.
    void syncProductPublicImages(id, main_image_url, additional_image_urls, wreq.workspaceOwnerId);
  }
  if (changedFields.length > 0) {
    webhookEvents.push("product.updated");
    void notifyProductChanged(id, wreq.workspaceOwnerId, changedFields, webhookEvents);
    void fireCatalogDataWebhook("catalog.products.changed", wreq.workspaceOwnerId, { action: "updated", product_id: id });
    void fireCatalogDataWebhook("product.updated", wreq.workspaceOwnerId, { product: result.rows[0] as unknown as Record<string, unknown> });
  }

  // Catalog-category + occasion links (the new combined picker). Each is only
  // replaced when its field is present in the body; the legacy free-text
  // `category` column is left untouched (read-only).
  const responseProduct: ProductRow = { ...result.rows[0] };
  const catalogCategoryIds = parseAttributeIds(body.catalog_category_ids);
  if (catalogCategoryIds !== null) {
    const linkedCategories = await runPostSaveStep(
      "catalog categories",
      "The product was saved, but its catalog categories could not be updated.",
      () => replaceProductAttributeLinks(
        id, wreq.workspaceOwnerId, "product_catalog_categories", "catalog_categories", catalogCategoryIds,
      ),
    );
    if (linkedCategories !== undefined) responseProduct.catalog_categories = linkedCategories;
  }
  const occasionIds = parseAttributeIds(body.occasion_ids);
  if (occasionIds !== null) {
    const linkedOccasions = await runPostSaveStep(
      "occasions",
      "The product was saved, but its occasions could not be updated.",
      () => replaceProductAttributeLinks(
        id, wreq.workspaceOwnerId, "product_occasions", "occasions", occasionIds,
      ),
    );
    if (linkedOccasions !== undefined) responseProduct.occasions = linkedOccasions;
  }
  // Optional single catalog-brand link (separate from the required text `brand`).
  const patchCatalogBrandId = parseCatalogBrandId(body.catalog_brand_id);
  if (patchCatalogBrandId !== undefined) {
    const linkedBrand = await runPostSaveStep(
      "catalog brand",
      "The product was saved, but its catalog brand could not be updated.",
      () => replaceProductCatalogBrand(
        id, wreq.workspaceOwnerId, patchCatalogBrandId,
      ),
    );
    if (linkedBrand !== undefined) responseProduct.catalog_brand = linkedBrand;
  } else {
    const linkedBrand = await runPostSaveStep(
      "catalog brand",
      "The product was saved, but its catalog brand could not be loaded.",
      () => fetchProductCatalogBrand(id),
    );
    if (linkedBrand !== undefined) responseProduct.catalog_brand = linkedBrand;
  }
  // Keep the derived `category` field consistent with the catalog-category links
  // (the legacy free-text column has been retired, so it is no longer RETURNED).
  const primaryCategory = await runPostSaveStep(
    "catalog category",
    "The product was saved, but its primary category could not be loaded.",
    () => fetchPrimaryCategory(id),
  );
  if (primaryCategory !== undefined) responseProduct.category = primaryCategory;

  res.json({ product: decorateProductImageUrls(responseProduct), warnings });
});

type LocationStatusRow = {
  location_id: number;
  location_name: string;
  is_active: boolean;
};

/**
 * GET /api/products/:id/location-statuses
 * Return all workspace locations each with is_active (defaulting to true if no row exists).
 */
router.get("/products/:id/location-statuses", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid product id" });
    return;
  }

  const check = await db.query(
    `SELECT id FROM products WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (check.rowCount === 0) {
    res.status(404).json({ error: "Product not found" });
    return;
  }

  const result = await db.query<LocationStatusRow>(
    `SELECT l.id AS location_id, l.name AS location_name,
            COALESCE(pls.is_active, true) AS is_active
       FROM locations l
       LEFT JOIN product_location_statuses pls
         ON pls.location_id = l.id AND pls.product_id = $1
      WHERE l.workspace_owner_id = $2
      ORDER BY l.name ASC`,
    [id, wreq.workspaceOwnerId],
  );
  res.json({ locationStatuses: result.rows });
});

/**
 * PATCH /api/products/:id/location-statuses/:locationId
 * Upsert the product_location_statuses row with the supplied isActive value.
 * Requires owner role or products.manage permission.
 */
router.patch("/products/:id/location-statuses/:locationId", async (req, res) => {
  const wreq = workspace(req);
  if (!ownerOnly(wreq, res)) return;

  const id = parseInt(req.params.id, 10);
  const locationId = parseInt(req.params.locationId, 10);
  if (isNaN(id) || isNaN(locationId)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const { isActive } = req.body ?? {};
  if (typeof isActive !== "boolean") {
    res.status(400).json({ error: "isActive (boolean) is required" });
    return;
  }

  const check = await db.query(
    `SELECT id FROM products WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (check.rowCount === 0) {
    res.status(404).json({ error: "Product not found" });
    return;
  }

  const locCheck = await db.query(
    `SELECT id FROM locations WHERE id = $1 AND workspace_owner_id = $2`,
    [locationId, wreq.workspaceOwnerId],
  );
  if (locCheck.rowCount === 0) {
    res.status(404).json({ error: "Location not found" });
    return;
  }

  await db.query(
    `INSERT INTO product_location_statuses
       (workspace_owner_id, product_id, location_id, is_active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, now(), now())
     ON CONFLICT (product_id, location_id)
     DO UPDATE SET is_active = EXCLUDED.is_active, updated_at = now()`,
    [wreq.workspaceOwnerId, id, locationId, isActive],
  );
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Product city availability (default-on, toggle-off model)
//
// A product is available in EVERY workspace delivery city by default. An
// explicit `product_city_availability` row with is_available=false disables a
// specific city. The GET endpoint therefore reports a city as enabled unless an
// explicit disabling row exists (COALESCE(..., true)).
// ---------------------------------------------------------------------------

const productCityAvailabilityBatchSchema = z.array(
  z.object({ city_id: z.number().int().positive(), is_available: z.boolean() }),
);

router.get("/products/:id/city-availability", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid product id" });
    return;
  }

  const check = await db.query(
    `SELECT id FROM products WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (check.rowCount === 0) {
    res.status(404).json({ error: "Product not found" });
    return;
  }

  const citiesResult = await db.query(
    `SELECT dc.id          AS city_id,
            dc.name        AS city_name,
            dc.country_code,
            dc.slug        AS city_slug,
            dc.is_active   AS city_is_active,
            COALESCE(pca.is_available, true) AS is_available,
            pca.updated_at
       FROM delivery_cities dc
       LEFT JOIN product_city_availability pca
         ON pca.product_id = $1 AND pca.city_id = dc.id
      WHERE dc.workspace_owner_id = $2
      ORDER BY dc.country_code ASC, dc.sort_order ASC, dc.name ASC`,
    [id, wreq.workspaceOwnerId],
  );
  const cities = citiesResult.rows as Array<{ is_available: boolean }>;
  const total_cities = cities.length;
  const enabled_count = cities.filter((c) => c.is_available).length;
  res.json({ cities, enabled_count, total_cities });
});

router.put("/products/:id/city-availability", async (req, res) => {
  const wreq = workspace(req);
  if (!ownerOnly(wreq, res)) return;

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid product id" });
    return;
  }

  const check = await db.query(
    `SELECT id FROM products WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (check.rowCount === 0) {
    res.status(404).json({ error: "Product not found" });
    return;
  }

  const parsed = productCityAvailabilityBatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed" });
    return;
  }
  const updates = parsed.data;
  if (updates.length === 0) {
    res.json({ success: true });
    return;
  }

  // Validate that the city IDs belong to this workspace.
  const cityIds = updates.map((u) => u.city_id);
  const validCityResult = await db.query<{ id: number }>(
    `SELECT id FROM delivery_cities WHERE workspace_owner_id = $1 AND id = ANY($2::int[])`,
    [wreq.workspaceOwnerId, cityIds],
  );
  const validIds = new Set(validCityResult.rows.map((r) => r.id));

  for (const u of updates) {
    if (!validIds.has(u.city_id)) continue;
    await db.query(
      `INSERT INTO product_city_availability (product_id, city_id, is_available, created_at, updated_at)
       VALUES ($1, $2, $3, now(), now())
       ON CONFLICT (product_id, city_id)
       DO UPDATE SET is_available = EXCLUDED.is_available, updated_at = now()`,
      [id, u.city_id, u.is_available],
    );
  }

  res.json({ success: true });
  void fireCatalogDataWebhook("catalog.products.changed", wreq.workspaceOwnerId, {
    action: "city_availability_updated",
    product_id: id,
  });
  void fireCatalogDataWebhook("product.updated", wreq.workspaceOwnerId, {
    product: { id, city_availability_updated: true } as unknown as Record<string, unknown>,
  });
});

// ---------------------------------------------------------------------------
// Product country availability (default-on, toggle-off model)
//
// Parallel to city availability but keyed by ISO 3166-1 alpha-2 country code
// (uppercase). The country universe is the workspace's enabled
// `available_countries`. A product is available in EVERY enabled country by
// default; an explicit `product_country_availability` row with
// is_available=false hides it from that country. The GET endpoint therefore
// reports a country as enabled unless an explicit disabling row exists.
// ---------------------------------------------------------------------------

const productCountryAvailabilityBatchSchema = z.array(
  z.object({ country_code: z.string().trim().min(2), is_available: z.boolean() }),
);

async function getWorkspaceCountryCodes(
  ownerId: string,
): Promise<Array<{ code: string; name: string; flag_emoji: string | null }>> {
  const result = await db.query<{ available_countries: string[] | null }>(
    `SELECT available_countries FROM workspace_settings WHERE workspace_owner_id = $1`,
    [ownerId],
  );
  const names =
    result.rowCount === 0
      ? DEFAULT_COUNTRIES
      : (() => {
          const arr = result.rows[0].available_countries ?? [];
          const filtered = arr.filter((c) => !isExcludedCountry(c));
          return filtered.length > 0 ? filtered : DEFAULT_COUNTRIES;
        })();
  const out: Array<{ code: string; name: string; flag_emoji: string | null }> = [];
  const seen = new Set<string>();
  for (const name of names) {
    const meta = getCountryMetadata(name);
    if (!meta) continue;
    const code = meta.code.toUpperCase();
    if (seen.has(code)) continue;
    seen.add(code);
    out.push({ code, name: meta.name, flag_emoji: meta.flagEmoji });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

router.get("/products/:id/country-availability", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid product id" });
    return;
  }

  const check = await db.query(
    `SELECT id FROM products WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (check.rowCount === 0) {
    res.status(404).json({ error: "Product not found" });
    return;
  }

  const universe = await getWorkspaceCountryCodes(wreq.workspaceOwnerId);
  const rowsResult = await db.query<{
    country_code: string;
    is_available: boolean;
    updated_at: string | null;
  }>(
    `SELECT UPPER(country_code) AS country_code, is_available, updated_at
       FROM product_country_availability
      WHERE product_id = $1`,
    [id],
  );
  const byCode = new Map(rowsResult.rows.map((r) => [r.country_code.toUpperCase(), r]));

  const countries = universe.map((c) => {
    const existing = byCode.get(c.code);
    return {
      country_code: c.code,
      country_name: c.name,
      flag_emoji: c.flag_emoji,
      is_available: existing ? existing.is_available : true,
      updated_at: existing ? existing.updated_at : null,
    };
  });
  const total_countries = countries.length;
  const enabled_count = countries.filter((c) => c.is_available).length;
  res.json({ countries, enabled_count, total_countries });
});

router.put("/products/:id/country-availability", async (req, res) => {
  const wreq = workspace(req);
  if (!ownerOnly(wreq, res)) return;

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid product id" });
    return;
  }

  const check = await db.query(
    `SELECT id FROM products WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (check.rowCount === 0) {
    res.status(404).json({ error: "Product not found" });
    return;
  }

  const parsed = productCountryAvailabilityBatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed" });
    return;
  }
  const updates = parsed.data;
  if (updates.length === 0) {
    res.json({ success: true });
    return;
  }

  // Only accept country codes that belong to this workspace's enabled set.
  const universe = await getWorkspaceCountryCodes(wreq.workspaceOwnerId);
  const validCodes = new Set(universe.map((c) => c.code));

  for (const u of updates) {
    const code = u.country_code.trim().toUpperCase();
    if (!validCodes.has(code)) continue;
    await db.query(
      `INSERT INTO product_country_availability (product_id, country_code, is_available, created_at, updated_at)
       VALUES ($1, $2, $3, now(), now())
       ON CONFLICT (product_id, country_code)
       DO UPDATE SET is_available = EXCLUDED.is_available, updated_at = now()`,
      [id, code, u.is_available],
    );
  }

  res.json({ success: true });
  void fireCatalogDataWebhook("catalog.products.changed", wreq.workspaceOwnerId, {
    action: "country_availability_updated",
    product_id: id,
  });
  void fireCatalogDataWebhook("product.updated", wreq.workspaceOwnerId, {
    product: { id, country_availability_updated: true } as unknown as Record<string, unknown>,
  });
});

router.patch("/products/:id/country-availability/bulk", async (req, res) => {
  const wreq = workspace(req);
  if (!ownerOnly(wreq, res)) return;

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid product id" });
    return;
  }

  const enableAll = req.body?.enable_all;
  if (typeof enableAll !== "boolean") {
    res.status(400).json({ error: "enable_all (boolean) is required" });
    return;
  }

  const check = await db.query(
    `SELECT id FROM products WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (check.rowCount === 0) {
    res.status(404).json({ error: "Product not found" });
    return;
  }

  const universe = await getWorkspaceCountryCodes(wreq.workspaceOwnerId);
  for (const c of universe) {
    await db.query(
      `INSERT INTO product_country_availability (product_id, country_code, is_available, created_at, updated_at)
       VALUES ($1, $2, $3, now(), now())
       ON CONFLICT (product_id, country_code)
       DO UPDATE SET is_available = EXCLUDED.is_available, updated_at = now()`,
      [id, c.code, enableAll],
    );
  }

  res.json({ success: true });
  void fireCatalogDataWebhook("catalog.products.changed", wreq.workspaceOwnerId, {
    action: "country_availability_updated",
    product_id: id,
  });
  void fireCatalogDataWebhook("product.updated", wreq.workspaceOwnerId, {
    product: { id, country_availability_updated: true } as unknown as Record<string, unknown>,
  });
});

router.patch("/products/:id/city-availability/bulk", async (req, res) => {
  const wreq = workspace(req);
  if (!ownerOnly(wreq, res)) return;

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid product id" });
    return;
  }

  const enableAll = req.body?.enable_all;
  if (typeof enableAll !== "boolean") {
    res.status(400).json({ error: "enable_all (boolean) is required" });
    return;
  }

  const check = await db.query(
    `SELECT id FROM products WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (check.rowCount === 0) {
    res.status(404).json({ error: "Product not found" });
    return;
  }

  const allCitiesResult = await db.query<{ id: number }>(
    `SELECT id FROM delivery_cities WHERE workspace_owner_id = $1`,
    [wreq.workspaceOwnerId],
  );

  for (const city of allCitiesResult.rows) {
    await db.query(
      `INSERT INTO product_city_availability (product_id, city_id, is_available, created_at, updated_at)
       VALUES ($1, $2, $3, now(), now())
       ON CONFLICT (product_id, city_id)
       DO UPDATE SET is_available = EXCLUDED.is_available, updated_at = now()`,
      [id, city.id, enableAll],
    );
  }

  res.json({ success: true });
  void fireCatalogDataWebhook("catalog.products.changed", wreq.workspaceOwnerId, {
    action: "city_availability_updated",
    product_id: id,
  });
  void fireCatalogDataWebhook("product.updated", wreq.workspaceOwnerId, {
    product: { id, city_availability_updated: true } as unknown as Record<string, unknown>,
  });
});

/**
 * GET /api/products/:id/download-image?width=W&height=H
 * Fetch the product's primary image, resize/crop it to the requested dimensions,
 * and stream it back with Content-Disposition: attachment so the browser downloads it.
 * Both width and height must be provided as strictly positive integers.
 */
router.get("/products/:id/download-image", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid product id" });
    return;
  }

  const widthRaw = req.query.width;
  const heightRaw = req.query.height;
  const width = typeof widthRaw === "string" ? parseInt(widthRaw, 10) : NaN;
  const height = typeof heightRaw === "string" ? parseInt(heightRaw, 10) : NaN;

  if (!Number.isInteger(width) || width <= 0) {
    res.status(400).json({ error: "width must be a positive integer" });
    return;
  }
  if (!Number.isInteger(height) || height <= 0) {
    res.status(400).json({ error: "height must be a positive integer" });
    return;
  }
  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
    res.status(400).json({ error: `width and height must not exceed ${MAX_IMAGE_DIMENSION}` });
    return;
  }

  const productResult = await db.query<{ main_image_url: string | null; name: string }>(
    `SELECT main_image_url, name FROM products WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if ((productResult.rowCount ?? 0) === 0) {
    res.status(404).json({ error: "Product not found" });
    return;
  }

  const { main_image_url, name: productName } = productResult.rows[0];
  if (!main_image_url) {
    res.status(404).json({ error: "Product has no primary image" });
    return;
  }

  // Enforce workspace isolation: reject any stored URL that doesn't belong to this workspace.
  if (!isOwnedObjectPath(main_image_url, wreq.workspaceOwnerId)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  // Parse the object path to find the bucket and file name.
  // main_image_url is stored as /objects/{workspaceOwnerId}/products/{objectId}
  const privateObjectDir = process.env.PRIVATE_OBJECT_DIR;
  if (!privateObjectDir) {
    res.status(500).json({ error: "Storage not configured" });
    return;
  }

  let objectPath: string;
  if (main_image_url.startsWith("/objects/")) {
    // Strip the leading /objects/ prefix — the path below workspaceOwnerId
    const withoutObjects = main_image_url.slice("/objects/".length);
    const fullPath = `${privateObjectDir}/${withoutObjects}`;
    const parts = fullPath.startsWith("/") ? fullPath.slice(1).split("/") : fullPath.split("/");
    if (parts.length < 2) {
      res.status(500).json({ error: "Invalid image path" });
      return;
    }
    objectPath = fullPath;
  } else {
    res.status(400).json({ error: "Unsupported image URL format" });
    return;
  }

  try {
    const parts = objectPath.startsWith("/") ? objectPath.slice(1).split("/") : objectPath.split("/");
    const bucketName = parts[0];
    const objectName = parts.slice(1).join("/");
    const bucket = objectStorageClient.bucket(bucketName);
    const file = bucket.file(objectName);
    const [exists] = await file.exists();
    if (!exists) {
      res.status(404).json({ error: "Image not found in storage" });
      return;
    }

    const [fileMetadata] = await file.getMetadata();
    if (fileMetadata.size && Number(fileMetadata.size) > MAX_SOURCE_IMAGE_BYTES) {
      res.status(413).json({ error: "Image file is too large to process" });
      return;
    }

    const [buffer] = await file.download();
    const resized = await smartResizeBuffer(buffer, width, height, "png");

    const safeName = productName.replace(/[^a-z0-9_\-]/gi, "_").toLowerCase();
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}_${width}x${height}.png"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(resized);
  } catch (err) {
    logger.error({ err }, "Failed to download and resize product image");
    res.status(500).json({ error: "Failed to process image" });
  }
});

/**
 * GET /api/products/:id/images/download-original
 * Stream the raw (unmodified) primary image from object storage with
 * Content-Disposition: attachment so the browser downloads it.
 * No resizing or format conversion is performed.
 */
router.get("/products/:id/images/download-original", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid product id" });
    return;
  }

  const productResult = await db.query<{ main_image_url: string | null; name: string }>(
    `SELECT main_image_url, name FROM products WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if ((productResult.rowCount ?? 0) === 0) {
    res.status(404).json({ error: "Product not found" });
    return;
  }

  const { main_image_url, name: productName } = productResult.rows[0];
  if (!main_image_url) {
    res.status(404).json({ error: "Product has no primary image" });
    return;
  }

  if (!isOwnedObjectPath(main_image_url, wreq.workspaceOwnerId)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const privateObjectDir = process.env.PRIVATE_OBJECT_DIR;
  if (!privateObjectDir) {
    res.status(500).json({ error: "Storage not configured" });
    return;
  }

  if (!main_image_url.startsWith("/objects/")) {
    res.status(400).json({ error: "Unsupported image URL format" });
    return;
  }

  try {
    const withoutObjects = main_image_url.slice("/objects/".length);
    const fullPath = `${privateObjectDir}/${withoutObjects}`;
    const parts = fullPath.startsWith("/") ? fullPath.slice(1).split("/") : fullPath.split("/");
    const bucketName = parts[0];
    const objectName = parts.slice(1).join("/");
    const bucket = objectStorageClient.bucket(bucketName);
    const file = bucket.file(objectName);
    const [exists] = await file.exists();
    if (!exists) {
      res.status(404).json({ error: "Image not found in storage" });
      return;
    }

    const [metadata] = await file.getMetadata();
    const contentType = (metadata.contentType as string) || "application/octet-stream";

    // Derive a sensible extension from the content type
    const extMap: Record<string, string> = {
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
    };
    const ext = extMap[contentType] ?? "bin";

    const safeName = productName.replace(/[^a-z0-9_\-]/gi, "_").toLowerCase();
    const filename = `${safeName}-original.${ext}`;

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Cache-Control", "no-store");
    if (metadata.size) {
      res.setHeader("Content-Length", String(metadata.size));
    }

    file.createReadStream().pipe(res);
  } catch (err) {
    logger.error({ err }, "Failed to stream original product image");
    res.status(500).json({ error: "Failed to download image" });
  }
});

/**
 * DELETE /api/products/:id
 * Delete a product. Requires owner role or products.manage permission.
 */
router.delete("/products/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!ownerOnly(wreq, res)) return;

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid product id" });
    return;
  }
  const activeOffers = await db.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM merchant_offer_states WHERE workspace_owner_id=$1 AND product_id=$2 AND is_owned IS TRUE AND deleted_at IS NULL`,
    [wreq.workspaceOwnerId, id],
  );
  if (Number(activeOffers.rows[0]?.count ?? 0) > 0) {
    res.status(409).json({ error: "Product has active Merchant offers; reconcile and approve their deletion before hard delete" });
    return;
  }
  const pendingMerchantWork = await db.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM merchant_sync_jobs j JOIN products p ON p.id=j.product_id
      WHERE p.workspace_owner_id=$1 AND j.product_id=$2 AND j.operation='CREATE_OR_UPDATE'
        AND j.status IN ('PENDING','RUNNING','RETRY_WAITING')
      UNION ALL
     SELECT COUNT(*)::text FROM merchant_reconciliation_items i JOIN merchant_reconciliation_runs r ON r.id=i.run_id
      WHERE r.workspace_owner_id=$1 AND i.product_id=$2 AND (
        r.status IN ('DRAFT','APPROVED') OR (r.status='APPLIED' AND EXISTS (
          SELECT 1 FROM merchant_sync_jobs aj WHERE aj.reconciliation_item_id=i.id
            AND aj.status IN ('PENDING','RUNNING','RETRY_WAITING')
        )))`,
    [wreq.workspaceOwnerId, id],
  );
  if (pendingMerchantWork.rows.some((r) => Number(r.count) > 0)) {
    res.status(409).json({ error: "Product has Merchant reconciliation work; resolve it before hard delete" });
    return;
  }

  // Fetch the product before deletion so the payload snapshot is captured.
  const preDelete = await db.query<ProductRow>(
    `SELECT * FROM products WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (preDelete.rowCount && preDelete.rowCount > 0) {
    void enqueueProductDeleteSync(preDelete.rows[0] as unknown as import("@workspace/db/schema").Product);
  }

  await db.query(
    `DELETE FROM products WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  void fireCatalogDataWebhook("catalog.products.changed", wreq.workspaceOwnerId, { action: "deleted", product_id: id });
  void fireCatalogDataWebhook("product.deleted", wreq.workspaceOwnerId, { id, deleted: true });
  res.json({ ok: true });
});

/**
 * POST /api/products/merchant-sync-backfill
 * Enqueues all eligible products that have never been successfully synced to
 * Google Merchant Center (no PENDING/RUNNING/RETRY_WAITING job exists for them).
 * Idempotent — running it twice does not create duplicate jobs.
 * Owner-only.
 */
router.post("/products/merchant-sync-backfill", async (req, res) => {
  const wreq = workspace(req);
  if (!ownerOnly(wreq, res)) return;
  res.status(409).json({ error: "Merchant sync is country-scoped; create an LB or AE reconciliation dry run instead" });
  return;

  try {
    const result = await enqueueMerchantSyncBackfill(wreq.workspaceOwnerId);
    res.json({ enqueued: result.enqueued, inserted: result.inserted, reset: result.reset });
  } catch (err) {
    logger.error({ err }, "merchant-sync-backfill: failed");
    res.status(500).json({ error: "Failed to enqueue merchant sync backfill" });
  }
});

// Reconciliation is owner-only and deliberately queues work only after review;
// these endpoints never invoke Google.
router.post("/products/merchant-reconciliation/dry-run", async (req, res): Promise<void> => {
  const wreq = workspace(req);
  if (!merchantReconciliationOwnerOnly(wreq.workspaceRole)) { res.status(403).json({ error: "This endpoint requires workspace owner access" }); return; }
  const parsed = z.object({
    countries: z.array(z.enum(["AE", "LB"])).min(1).max(2).transform((values) => Array.from(new Set(values))),
    contentLanguage: z.literal("en"),
    includeGoogle: z.boolean().default(false),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "countries must contain UAE, Lebanon, or both, and contentLanguage must be en" }); return; }
  try {
    const results = await createMarketReconciliationDryRuns(
      wreq.workspaceOwnerId,
      wreq.userId ?? wreq.workspaceOwnerId,
      parsed.data.countries,
      parsed.data.contentLanguage,
      parsed.data.includeGoogle,
    );
    res.status(201).json({ results });
  } catch (err) { req.log.error({ err }, "merchant reconciliation dry run failed"); res.status(400).json({ error: err instanceof Error ? err.message : "Failed to create reconciliation dry run" }); }
});

router.get("/products/merchant-reconciliation/latest", async (req, res): Promise<void> => {
  const wreq = workspace(req);
  if (!merchantReconciliationOwnerOnly(wreq.workspaceRole)) { res.status(403).json({ error: "This endpoint requires workspace owner access" }); return; }
  const result = await db.query(`SELECT DISTINCT ON (country) *
    FROM merchant_reconciliation_runs
    WHERE workspace_owner_id=$1 AND country IN ('AE','LB')
    ORDER BY country,created_at DESC,id DESC`, [wreq.workspaceOwnerId]);
  const runs = Object.fromEntries(result.rows.map((run) => [run.country, run]));
  res.json({ runs, executionEnabled: merchantReconciliationExecutionEnabled() });
});

router.get("/products/merchant-reconciliation/:runId", async (req, res): Promise<void> => {
  const wreq = workspace(req); if (!merchantReconciliationOwnerOnly(wreq.workspaceRole)) { res.status(403).json({ error: "This endpoint requires workspace owner access" }); return; }
  const runId = Number(req.params.runId); if (!Number.isSafeInteger(runId)) { res.status(400).json({ error: "Invalid run id" }); return; }
  const run = await db.query(`SELECT * FROM merchant_reconciliation_runs WHERE id=$1 AND workspace_owner_id=$2`, [runId, wreq.workspaceOwnerId]);
  if (!run.rows[0]) { res.status(404).json({ error: "Run not found" }); return; }
  const items = await db.query(
    `SELECT i.*,
       replacement.approval_status AS replacement_approval_status,
       replacement.approval_deadline_at AS replacement_approval_deadline,
       replacement.approval_checked_at AS replacement_approval_checked_at,
       replacement.last_error AS replacement_approval_error
     FROM merchant_reconciliation_items i
     LEFT JOIN LATERAL (
       SELECT s.approval_status,s.approval_deadline_at,s.approval_checked_at,s.last_error
       FROM merchant_offer_states s
       WHERE s.workspace_owner_id=$2
         AND s.product_id=i.product_id
         AND s.account_id=COALESCE(i.state_identity->'replacement'->>'accountId',i.state_identity->>'accountId')
         AND s.data_source_id=COALESCE(i.state_identity->'replacement'->>'dataSourceId',i.state_identity->>'dataSourceId')
         AND s.country=COALESCE(i.state_identity->'replacement'->>'country',i.country)
         AND s.content_language=COALESCE(i.state_identity->'replacement'->>'contentLanguage',i.content_language)
         AND s.offer_id=COALESCE(i.state_identity->'replacement'->>'offerId',i.offer_id)
         AND s.payload_hash=COALESCE(i.state_identity->'replacement'->>'payloadHash',i.state_identity->>'payloadHash')
         AND s.is_owned IS TRUE AND s.deleted_at IS NULL
       LIMIT 1
     ) replacement ON TRUE
     WHERE i.run_id=$1
     ORDER BY i.id`,
    [runId, wreq.workspaceOwnerId],
  );
  res.json({
    run: run.rows[0],
    items: items.rows,
    executionEnabled: merchantReconciliationExecutionEnabled(),
  });
});

router.post("/products/merchant-reconciliation/:runId/approve-deletions", async (req, res): Promise<void> => {
  const wreq = workspace(req); if (!merchantReconciliationOwnerOnly(wreq.workspaceRole)) { res.status(403).json({ error: "This endpoint requires workspace owner access" }); return; }
  const runId = Number(req.params.runId);
  const parsed = z.object({ itemIds: z.array(z.coerce.number().int().positive()).min(1), approveLastOffer: z.boolean().default(false) }).safeParse(req.body);
  if (!Number.isSafeInteger(runId) || !parsed.success) { res.status(400).json({ error: "Invalid deletion approval request" }); return; }
  res.json({ approved: await approveDeletionItems(wreq.workspaceOwnerId, runId, parsed.data.itemIds, parsed.data.approveLastOffer) });
});

router.post("/products/merchant-reconciliation/:runId/apply", async (req, res): Promise<void> => {
  const wreq = workspace(req); if (!merchantReconciliationOwnerOnly(wreq.workspaceRole)) { res.status(403).json({ error: "This endpoint requires workspace owner access" }); return; }
  const runId = Number(req.params.runId); if (!Number.isSafeInteger(runId)) { res.status(400).json({ error: "Invalid run id" }); return; }
  try { res.json({ queued: await applyApprovedRun(wreq.workspaceOwnerId, runId) }); }
  catch (err) { res.status(409).json({ error: err instanceof Error ? err.message : "Run cannot be applied" }); }
});

router.post("/products/merchant-reconciliation/:runId/apply-delete-batch", async (req, res): Promise<void> => {
  const wreq = workspace(req);
  if (!merchantReconciliationOwnerOnly(wreq.workspaceRole)) {
    res.status(403).json({ error: "This endpoint requires workspace owner access" });
    return;
  }
  const runId = Number(req.params.runId);
  const parsed = z.object({ batchSize: z.number().int().min(25).max(50) }).safeParse(req.body);
  if (!Number.isSafeInteger(runId) || !parsed.success) {
    res.status(400).json({ error: "Delete batch size must be between 25 and 50" });
    return;
  }
  try {
    res.json({ queued: await applyApprovedDeleteBatch(wreq.workspaceOwnerId, runId, parsed.data.batchSize) });
  } catch (err) {
    res.status(409).json({ error: err instanceof Error ? err.message : "Delete batch cannot be applied" });
  }
});

router.post("/products/merchant-reconciliation/:runId/approve", async (req, res): Promise<void> => {
  const wreq = workspace(req); if (!merchantReconciliationOwnerOnly(wreq.workspaceRole)) { res.status(403).json({ error: "This endpoint requires workspace owner access" }); return; }
  const runId = Number(req.params.runId); if (!Number.isSafeInteger(runId)) { res.status(400).json({ error: "Invalid run id" }); return; }
  try {
    const approved = await approveReconciliationRun(wreq.workspaceOwnerId, runId, wreq.userId ?? wreq.workspaceOwnerId);
    if (!approved) { res.status(409).json({ error: "Run is blocked, already processed, or has unapproved deletions" }); return; }
    res.json({ approved: true });
  } catch (err) {
    res.status(409).json({ error: err instanceof Error ? err.message : "Merchant image preflight failed" });
  }
});

/**
 * POST /api/products/merchant-sync-selected
 * Queues only selected, currently available products for a Merchant Center
 * re-sync. Strict owner-only: the products.manage permission is not sufficient
 * because this controls an external catalog integration.
 */
router.post("/products/merchant-sync-selected", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "This endpoint requires workspace owner access" });
    return;
  }
  res.status(409).json({ error: "Merchant sync is country-scoped; use a country reconciliation dry run instead" });
});

/**
 * POST /api/products/merchant-unsync-selected
 * Excludes selected products from future GMC syncs and queues their removal
 * from Merchant Center. Strict owner-only because this changes an external
 * catalog and is not covered by the regular products.manage permission.
 */
router.post("/products/merchant-unsync-selected", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "This endpoint requires workspace owner access" });
    return;
  }
  res.status(409).json({ error: "Merchant removal requires reviewed country reconciliation; no product was changed" });
});

/**
 * POST /api/products/:id/merchant-sync-test
 * Manual diagnostic endpoint for testing Google Merchant Center product sync.
 * Runs all four completion checks and returns a full diagnostic object.
 * Owner-only.
 */
router.post("/products/:id/merchant-sync-test", async (req, res) => {
  const wreq = workspace(req);
  if (!ownerOnly(wreq, res)) return;
  res.status(409).json({
    error: "Direct Merchant writes are disabled; use a reviewed reconciliation run",
  });
});

export default router;
