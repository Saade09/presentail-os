import { Router, type Request, type Response } from "express";
import multer from "multer";
import { imageSize } from "image-size";
import { z } from "zod";
import archiver from "archiver";
import ExcelJS from "exceljs";
import sharp from "sharp";
import { smartResizeBuffer } from "../lib/imageResize";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { db, withTransaction } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace, type WorkspaceRequest } from "../lib/workspace";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { fireCatalogDataWebhook } from "../lib/catalogWebhook";

const router = Router();

const brandRowSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    description: z.string().nullable().optional(),
    target_cogs: z.string().nullable().optional(),
    has_card_message: z.boolean().optional(),
    has_logo: z.boolean().optional(),
    sticker_count: z.union([z.string(), z.number()]).optional(),
    product_count: z.union([z.string(), z.number()]).optional(),
    failed_import_count: z.number().int().optional(),
    created_at: z.union([z.string(), z.date()]),
  })
  .passthrough();

const brandsResponseSchema = z.object({
  brands: z.array(brandRowSchema),
  workspaceJobCount: z.number().int(),
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

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const uploadCoverPhoto = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

// ─── Authenticated routes ─────────────────────────────────────────────────────
// Public image-serving routes (logo, card-message, cover-photos) are handled by
// publicImagesRouter mounted before this router in routes/index.ts.

router.use(requireAuth, resolveWorkspace);

/** Returns true if the user may create/edit brand content (owner, designer, or brands.manage custom permission). */
function canManageBrand(wreq: WorkspaceRequest): boolean {
  return (
    wreq.workspaceActualRole === "owner" ||
    wreq.workspaceActualRole === "designer" ||
    (wreq.allowedPages?.includes("brands.manage") ?? false)
  );
}

const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp"] as const;

function hasPermission(wreq: ReturnType<typeof workspace>, perm: string): boolean {
  return wreq.workspaceActualRole === "owner" || (wreq.allowedPages?.includes(perm) ?? false);
}

type BrandRow = {
  id: number;
  workspace_owner_id: string;
  name: string;
  description: string | null;
  target_cogs: string | null;
  has_card_message: boolean;
  created_at: string;
  updated_at: string | null;
  sticker_count: string;
  product_count: string;
  has_logo: boolean;
};

type BrandRowBasic = {
  id: number;
  name: string;
  description: string | null;
  target_cogs: string | null;
  created_at: string;
};

/**
 * GET /api/brands
 * List all brands for the workspace, with sticker counts.
 */
router.get("/brands", async (req, res) => {
  const wreq = workspace(req);
  const [brandsResult, jobCountResult] = await Promise.all([
    db.query<BrandRow>(
      `SELECT b.id, b.name, b.description, b.target_cogs, b.created_at,
              b.updated_at,
              (b.card_message_data IS NOT NULL) AS has_card_message,
              COUNT(DISTINCT s.id) AS sticker_count,
              (SELECT COUNT(*) FROM products p
                WHERE p.brand = b.name
                  AND p.workspace_owner_id = b.workspace_owner_id) AS product_count,
              EXISTS(
                SELECT 1 FROM brand_logos bl
                 WHERE bl.brand_id = b.id AND bl.deleted_at IS NULL
              ) AS has_logo,
              (b.card_message_data IS NOT NULL) AS has_card_message,
              (SELECT bl.id FROM brand_logos bl
                WHERE bl.brand_id = b.id AND bl.deleted_at IS NULL
                ORDER BY bl.sort_order ASC LIMIT 1) AS primary_logo_id,
              (SELECT COUNT(*) FROM marketplace_report_imports mri
                WHERE mri.detected_brand_id = b.id
                  AND mri.workspace_owner_id = b.workspace_owner_id
                  AND mri.import_status IN ('extraction_failed', 'needs_review'))::int AS failed_import_count
         FROM brands b
         LEFT JOIN stickers s
           ON s.brand_id = b.id
          AND s.workspace_owner_id = b.workspace_owner_id
        WHERE b.workspace_owner_id = $1
        GROUP BY b.id
        ORDER BY b.created_at ASC`,
      [wreq.workspaceOwnerId],
    ),
    db.query<{ count: string }>(
      `SELECT COUNT(*) AS count
         FROM print_jobs
        WHERE user_id = $1
          AND status IN ('done', 'completed')
          AND deleted_at IS NULL`,
      [wreq.workspaceOwnerId],
    ).catch(() => ({ rows: [{ count: "0" }] })),
  ]);
  const workspaceJobCount = parseInt(jobCountResult.rows[0]?.count ?? "0", 10);
  sendValidated(
    req,
    res,
    brandsResponseSchema,
    { brands: brandsResult.rows, workspaceJobCount },
    "GET /brands",
  );
});

/**
 * GET /api/brands/:id/cogs-summary
 * Return COGS target + workspace-level completed job count for a brand.
 */
router.get("/brands/:id/cogs-summary", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(String(req.params.id), 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid brand id" });
    return;
  }

  const [brandResult, jobCountResult] = await Promise.all([
    db.query<{ target_cogs: string | null }>(
      `SELECT target_cogs FROM brands WHERE id = $1 AND workspace_owner_id = $2`,
      [id, wreq.workspaceOwnerId],
    ),
    db.query<{ count: string }>(
      `SELECT COUNT(*) AS count
         FROM print_jobs
        WHERE user_id = $1
          AND status IN ('done', 'completed')
          AND deleted_at IS NULL`,
      [wreq.workspaceOwnerId],
    ),
  ]);

  if (brandResult.rowCount === 0) {
    res.status(404).json({ error: "Brand not found" });
    return;
  }

  const targetCogs = brandResult.rows[0].target_cogs !== null
    ? parseFloat(brandResult.rows[0].target_cogs)
    : null;
  const completedJobCount = parseInt(jobCountResult.rows[0]?.count ?? "0", 10);

  res.json({ target_cogs: targetCogs, actual_cogs: null, completed_job_count: completedJobCount });
});

/**
 * GET /api/brands/:id/cogs-trend?granularity=month|week
 * Return COGS % per period (month or week) for the brand's workspace jobs.
 * actual_cogs is null until per-job cost tracking is added; periods are
 * populated with job counts so the chart has data to display immediately.
 */
router.get("/brands/:id/cogs-trend", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(String(req.params.id), 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid brand id" });
    return;
  }

  const granularity = req.query.granularity === "week" ? "week" : "month";

  const brandResult = await db.query<{ target_cogs: string | null; created_at: string }>(
    `SELECT target_cogs, created_at FROM brands WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );

  if (brandResult.rowCount === 0) {
    res.status(404).json({ error: "Brand not found" });
    return;
  }

  const targetCogs = brandResult.rows[0].target_cogs !== null
    ? parseFloat(brandResult.rows[0].target_cogs)
    : null;

  const brandCreatedAt = new Date(brandResult.rows[0].created_at);

  const jobsResult = await db.query<{ period: string; job_count: string }>(
    `SELECT date_trunc($1, completed_at AT TIME ZONE 'UTC')::date::text AS period,
            COUNT(*) AS job_count
       FROM print_jobs
      WHERE user_id = $2
        AND status IN ('done', 'completed')
        AND deleted_at IS NULL
        AND completed_at IS NOT NULL
      GROUP BY 1
      ORDER BY 1 ASC`,
    [granularity, wreq.workspaceOwnerId],
  );

  const jobsByPeriod: Record<string, number> = {};
  for (const row of jobsResult.rows) {
    jobsByPeriod[row.period] = parseInt(row.job_count, 10);
  }

  const now = new Date();
  const periods: { period: string; label: string; job_count: number; actual_cogs: number | null }[] = [];

  if (granularity === "month") {
    const start = new Date(Date.UTC(brandCreatedAt.getUTCFullYear(), brandCreatedAt.getUTCMonth(), 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const cur = new Date(start);
    while (cur <= end) {
      const key = cur.toISOString().slice(0, 7);
      const periodKey = `${key}-01`;
      const label = cur.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
      periods.push({
        period: key,
        label,
        job_count: jobsByPeriod[periodKey] ?? 0,
        actual_cogs: null,
      });
      cur.setUTCMonth(cur.getUTCMonth() + 1);
    }
  } else {
    const msPerWeek = 7 * 24 * 60 * 60 * 1000;
    const startMs = brandCreatedAt.getTime();
    const nowMs = now.getTime();
    const startWeek = startMs - ((startMs / msPerWeek) % msPerWeek) * msPerWeek;
    const endWeek = nowMs - ((nowMs / msPerWeek) % msPerWeek) * msPerWeek;
    let cur = startWeek;
    while (cur <= endWeek) {
      const d = new Date(cur);
      const key = d.toISOString().slice(0, 10);
      const label = d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
      periods.push({
        period: key,
        label,
        job_count: jobsByPeriod[key] ?? 0,
        actual_cogs: null,
      });
      cur += msPerWeek;
    }
  }

  res.json({ granularity, target_cogs: targetCogs, periods });
});

/**
 * GET /api/brands/:id/analytics?period=30d&granularity=month
 * Return aggregated sales analytics for a brand sourced from native orders.
 *
 * Query params:
 *   period      – "7d" | "30d" | "90d" | "1y"   (default: "30d")
 *   granularity – "day" | "week" | "month"        (default: "month")
 *
 * Products belonging to the brand are matched against order line_items by
 * name (case-insensitive) or internal product_id, following the same strategy
 * used in GET /api/products/:id/sales-history.
 */
router.get("/brands/:id/analytics", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(String(req.params.id), 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid brand id" });
    return;
  }

  const VALID_PERIODS = ["7d", "30d", "90d", "1y"] as const;
  type Period = typeof VALID_PERIODS[number];
  const periodParam = String(req.query.period ?? "30d");
  const period: Period = (VALID_PERIODS as readonly string[]).includes(periodParam)
    ? (periodParam as Period)
    : "30d";

  const VALID_GRAN = ["day", "week", "month"] as const;
  type Granularity = typeof VALID_GRAN[number];
  const granParam = String(req.query.granularity ?? "month");
  const granularity: Granularity = (VALID_GRAN as readonly string[]).includes(granParam as Granularity)
    ? (granParam as Granularity)
    : "month";

  const periodDays: Record<Period, number> = { "7d": 7, "30d": 30, "90d": 90, "1y": 365 };
  const fromDate = new Date(Date.now() - periodDays[period] * 24 * 60 * 60 * 1000);

  const brandResult = await db.query<{ name: string }>(
    `SELECT name FROM brands WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (brandResult.rowCount === 0) {
    res.status(404).json({ error: "Brand not found" });
    return;
  }
  const brandName = brandResult.rows[0].name;

  // Shared CTE: all products for this brand + matched order line items.
  // Line items are matched by case-insensitive name OR product_id (same
  // logic as /api/products/:id/sales-history).
  const baseCte = `
    WITH brand_products AS (
      SELECT id, name,
             (SELECT cc.name FROM product_catalog_categories pcc JOIN catalog_categories cc ON cc.id = pcc.attribute_id WHERE pcc.product_id = products.id ORDER BY cc.name ASC LIMIT 1) AS category,
             status
      FROM products
      WHERE workspace_owner_id = $1
        AND lower(brand) = lower($2)
    ),
    matched_lines AS (
      SELECT
        o.id AS order_id,
        o.ordered_at,
        o.channel AS store_name,
        COALESCE(NULLIF(li.line_total, ''), '0')::numeric    AS line_total,
        COALESCE(NULLIF(li.quantity, ''), '0')::numeric      AS quantity,
        bp.name                                                  AS product_name,
        bp.category                                              AS product_category,
        bp.status                                                AS product_status
      FROM orders o
      JOIN order_line_items li ON li.order_id = o.id
      JOIN brand_products bp ON (
        lower(COALESCE(li.name, '')) = lower(bp.name)
        OR (
          bp.id IS NOT NULL
          AND li.product_id IS NOT NULL
          AND li.product_id = bp.id
        )
      )
      WHERE o.ordered_at >= $3
        AND o.workspace_owner_id = $1
        AND o.status NOT IN ('cancelled', 'refunded', 'failed', 'trash')
    )
  `;
  const baseParams: unknown[] = [wreq.workspaceOwnerId, brandName, fromDate];

  const [
    kpiResult,
    trendResult,
    categoryResult,
    channelResult,
    topProductsResult,
    productCountResult,
  ] = await Promise.all([
    db.query<{ total_revenue: string; total_orders: string; total_units: string }>(
      `${baseCte}
       SELECT
         COALESCE(SUM(line_total),             0) AS total_revenue,
         COUNT(DISTINCT order_id)                 AS total_orders,
         COALESCE(SUM(quantity),               0) AS total_units
       FROM matched_lines`,
      baseParams,
    ),

    db.query<{ period_date: string; revenue: string; orders: string }>(
      `${baseCte}
       SELECT
         date_trunc($4, ordered_at AT TIME ZONE 'UTC')::date::text AS period_date,
         COALESCE(SUM(line_total), 0)                                   AS revenue,
         COUNT(DISTINCT order_id)                                       AS orders
       FROM matched_lines
       GROUP BY 1
       ORDER BY 1 ASC`,
      [...baseParams, granularity],
    ),

    db.query<{ name: string; revenue: string }>(
      `${baseCte}
       SELECT
         COALESCE(NULLIF(product_category, ''), 'Uncategorized') AS name,
         COALESCE(SUM(line_total), 0)                             AS revenue
       FROM matched_lines
       GROUP BY 1
       ORDER BY 2 DESC`,
      baseParams,
    ),

    db.query<{ channel: string; revenue: string; orders: string }>(
      `${baseCte}
       SELECT
         store_name                       AS channel,
         COALESCE(SUM(line_total), 0)     AS revenue,
         COUNT(DISTINCT order_id)         AS orders
       FROM matched_lines
       GROUP BY 1
       ORDER BY 2 DESC`,
      baseParams,
    ),

    db.query<{ name: string; category: string | null; orders: string; revenue_usd: string; status: string }>(
      `${baseCte}
       SELECT
         product_name                       AS name,
         product_category                   AS category,
         COUNT(DISTINCT order_id)           AS orders,
         COALESCE(SUM(line_total), 0)       AS revenue_usd,
         MAX(product_status)                AS status
       FROM matched_lines
       GROUP BY product_name, product_category
       ORDER BY 3 DESC, 4 DESC
       LIMIT 10`,
      baseParams,
    ),

    db.query<{ total_products: string; active_products: string }>(
      `SELECT
         COUNT(*)                                          AS total_products,
         COUNT(*) FILTER (WHERE status = 'available')     AS active_products
       FROM products
       WHERE workspace_owner_id = $1
         AND lower(brand) = lower($2)`,
      [wreq.workspaceOwnerId, brandName],
    ),
  ]);

  const kRow = kpiResult.rows[0];
  const totalRevenue = parseFloat(kRow?.total_revenue ?? "0");
  const totalOrders = parseInt(kRow?.total_orders ?? "0", 10);
  const avgOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;
  const totalUnits = parseFloat(kRow?.total_units ?? "0");

  const pcRow = productCountResult.rows[0];
  const totalProducts = parseInt(pcRow?.total_products ?? "0", 10);
  const activeProducts = parseInt(pcRow?.active_products ?? "0", 10);

  const salesTrend = trendResult.rows.map((r) => {
    const d = new Date(r.period_date + "T00:00:00Z");
    const label =
      granularity === "month"
        ? d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" })
        : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    return {
      period: label,
      revenue: parseFloat(r.revenue),
      orders: parseInt(r.orders, 10),
    };
  });

  const totalCatRevenue = categoryResult.rows.reduce((s, r) => s + parseFloat(r.revenue), 0);
  const categoryBreakdown = categoryResult.rows.map((r) => ({
    name: r.name,
    value:
      totalCatRevenue > 0
        ? Math.round((parseFloat(r.revenue) / totalCatRevenue) * 100)
        : 0,
  }));

  res.json({
    period,
    granularity,
    kpis: {
      total_revenue: totalRevenue,
      total_orders: totalOrders,
      avg_order_value: avgOrderValue,
      total_units: totalUnits,
      active_products: activeProducts,
      total_products: totalProducts,
    },
    sales_trend: salesTrend,
    category_breakdown: categoryBreakdown,
    channel_breakdown: channelResult.rows.map((r) => ({
      channel: r.channel,
      revenue: parseFloat(r.revenue),
      orders: parseInt(r.orders, 10),
    })),
    top_products: topProductsResult.rows.map((r) => ({
      name: r.name,
      category: r.category ?? null,
      orders: parseInt(r.orders, 10),
      revenue_usd: parseFloat(r.revenue_usd),
      status: r.status,
    })),
  });
});

/**
 * GET /api/brands/:id
 * Get a single brand with sticker count.
 */
router.get("/brands/:id", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(String(req.params.id), 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid brand id" });
    return;
  }

  const result = await db.query<BrandRow>(
    `SELECT b.id, b.name, b.description, b.target_cogs, b.created_at,
            (b.card_message_data IS NOT NULL) AS has_card_message,
            COUNT(s.id) AS sticker_count,
            EXISTS(
              SELECT 1 FROM brand_logos bl
               WHERE bl.brand_id = b.id AND bl.deleted_at IS NULL
            ) AS has_logo,
            (b.card_message_data IS NOT NULL) AS has_card_message
       FROM brands b
       LEFT JOIN stickers s
         ON s.brand_id = b.id
        AND s.workspace_owner_id = b.workspace_owner_id
      WHERE b.workspace_owner_id = $1 AND b.id = $2
      GROUP BY b.id`,
    [wreq.workspaceOwnerId, id],
  );

  if (result.rowCount === 0) {
    res.status(404).json({ error: "Brand not found" });
    return;
  }

  res.json({ brand: result.rows[0] });
});

type ExportChannelConfigRow = {
  id: number;
  channel_name: string;
  width_px: number;
  height_px: number;
  output_format: string;
};

type ExportProductRow = {
  id: number;
  name: string;
  price_usd: string | null;
  price_aed: string | null;
  category: string | null;
  description: string | null;
  main_image_url: string | null;
};

type PreparedBrandExport = {
  products: ExportProductRow[];
  xlsxBuffer: Buffer;
  channelConfig: ExportChannelConfigRow | null;
  zipFilename: string;
  /** Number of products that carry an image worth processing. */
  imageCount: number;
};

/**
 * Resolve the brand, validate query params, fetch the products, and build the
 * products.xlsx workbook. Returns either the prepared export payload or an
 * error tuple that the caller should surface to the client.
 */
async function prepareBrandExport(
  req: Request,
  brandId: number,
  workspaceOwnerId: string,
): Promise<
  | { ok: true; data: PreparedBrandExport }
  | { ok: false; status: number; error: string }
> {
  const brandCheck = await db.query<{ name: string }>(
    `SELECT name FROM brands WHERE id = $1 AND workspace_owner_id = $2`,
    [brandId, workspaceOwnerId],
  );
  if (brandCheck.rowCount === 0) {
    return { ok: false, status: 404, error: "Brand not found" };
  }
  const brandName = brandCheck.rows[0].name;

  const rawAvailability = req.query.availability;
  const availability =
    rawAvailability === "available" || rawAvailability === "unavailable"
      ? rawAvailability
      : "all";

  const channelConfigIdRaw = req.query.channelConfigId;
  const channelConfigIdParsed =
    channelConfigIdRaw !== undefined && channelConfigIdRaw !== ""
      ? parseInt(String(channelConfigIdRaw), 10)
      : null;

  if (
    channelConfigIdParsed !== null &&
    (Number.isNaN(channelConfigIdParsed) || channelConfigIdParsed <= 0)
  ) {
    return { ok: false, status: 400, error: "Invalid channelConfigId" };
  }

  let channelConfig: ExportChannelConfigRow | null = null;
  if (channelConfigIdParsed !== null) {
    const configResult = await db.query<ExportChannelConfigRow>(
      `SELECT cic.id, c.name AS channel_name, cic.width_px, cic.height_px,
              COALESCE(cic.output_format, 'jpeg') AS output_format
         FROM channel_image_configs cic
         JOIN channels c ON c.id = cic.channel_id
        WHERE cic.id = $1 AND cic.workspace_owner_id = $2`,
      [channelConfigIdParsed, workspaceOwnerId],
    );
    if ((configResult.rowCount ?? 0) === 0) {
      return {
        ok: false,
        status: 400,
        error: "Channel image config not found or does not belong to this workspace",
      };
    }
    channelConfig = configResult.rows[0];
  }

  const conditions: string[] = ["workspace_owner_id = $1", "lower(brand) = lower($2)"];
  const params: unknown[] = [workspaceOwnerId, brandName];

  if (availability === "available") {
    conditions.push("status = 'available'");
  } else if (availability === "unavailable") {
    conditions.push("status IN ('not_available', 'out_of_stock')");
  }

  const result = await db.query<ExportProductRow>(
    `SELECT id, name, price_usd, price_aed,
            (SELECT cc.name FROM product_catalog_categories pcc JOIN catalog_categories cc ON cc.id = pcc.attribute_id WHERE pcc.product_id = products.id ORDER BY cc.name ASC LIMIT 1) AS category,
            description, main_image_url
       FROM products
      WHERE ${conditions.join(" AND ")}
      ORDER BY created_at DESC`,
    params,
  );

  const products = result.rows;

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Products");
  sheet.columns = [
    { header: "Product Name", key: "name", width: 35 },
    { header: "Product Price USD", key: "price_usd", width: 18 },
    { header: "Product Price AED", key: "price_aed", width: 18 },
    { header: "Category", key: "category", width: 20 },
    { header: "Description", key: "description", width: 50 },
  ];

  for (const p of products) {
    sheet.addRow({
      name: p.name,
      price_usd: p.price_usd !== null ? parseFloat(p.price_usd) : "",
      price_aed: p.price_aed !== null ? parseFloat(p.price_aed) : "",
      category: p.category ?? "",
      description: p.description ?? "",
    });
  }

  const xlsxBuffer = Buffer.from(await workbook.xlsx.writeBuffer());

  const safeBase = brandName.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const filterSuffix = availability !== "all" ? `-${availability}` : "";
  const channelSlug = channelConfig
    ? `-${channelConfig.channel_name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`
    : "";
  const zipFilename = `${safeBase}${filterSuffix}${channelSlug}-products-export.zip`;

  const imageCount = products.filter(
    (p) => p.main_image_url && p.main_image_url.startsWith("/objects/"),
  ).length;

  return {
    ok: true,
    data: { products, xlsxBuffer, channelConfig, zipFilename, imageCount },
  };
}

/**
 * Append products.xlsx and every product image to the archive. Invokes
 * `onProgress(processed, total)` after each image is processed (whether it was
 * appended, resized, or skipped) so callers can stream progress. The caller is
 * responsible for piping the archive somewhere and calling `archive.finalize()`.
 */
async function appendBrandExportEntries(
  req: Request,
  archive: archiver.Archiver,
  prepared: PreparedBrandExport,
  onProgress?: (processed: number, total: number) => void,
  shouldAbort?: () => boolean,
): Promise<void> {
  const { products, xlsxBuffer, channelConfig, imageCount } = prepared;

  archive.append(xlsxBuffer, { name: "products.xlsx" });

  const objectStorageService = new ObjectStorageService();
  let processed = 0;
  for (const p of products) {
    // Stop building as soon as the client disconnects (e.g. user cancelled).
    if (shouldAbort?.()) break;
    if (!p.main_image_url || !p.main_image_url.startsWith("/objects/")) continue;
    try {
      const file = await objectStorageService.getObjectEntityFile(p.main_image_url);
      const [metadata] = await file.getMetadata();
      const contentType = (metadata.contentType as string) || "image/jpeg";

      if (channelConfig) {
        const outputFormat =
          channelConfig.output_format === "png" || channelConfig.output_format === "webp"
            ? (channelConfig.output_format as "png" | "webp")
            : "jpeg";
        const targetExt = outputFormat === "jpeg" ? "jpg" : outputFormat;
        const safeName = p.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 80);

        const chunks: Buffer[] = [];
        const readStream = file.createReadStream();
        await new Promise<void>((resolve, reject) => {
          readStream.on("data", (chunk: Buffer) => chunks.push(chunk));
          readStream.on("end", resolve);
          readStream.on("error", reject);
        });
        const originalBuffer = Buffer.concat(chunks);

        let finalBuffer: Buffer;
        let finalExt: string;
        try {
          finalBuffer = await smartResizeBuffer(
            originalBuffer,
            channelConfig.width_px,
            channelConfig.height_px,
            outputFormat,
          );
          finalExt = targetExt;
        } catch (resizeErr) {
          req.log.warn({ err: resizeErr, productId: p.id }, "Sharp resize failed, falling back to original");
          finalBuffer = originalBuffer;
          // Preserve original extension so bytes and filename always match
          finalExt = contentType === "image/png" ? "png" : contentType === "image/webp" ? "webp" : "jpg";
        }

        const imageFilename = `images/${safeName}-${p.id}.${finalExt}`;
        archive.append(finalBuffer, { name: imageFilename });
      } else {
        const ext = contentType === "image/png" ? "png" : contentType === "image/webp" ? "webp" : "jpg";
        const safeName = p.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 80);
        const imageFilename = `images/${safeName}-${p.id}.${ext}`;
        // Buffer the original so the read stream is fully consumed before we
        // report progress and move on (mirrors the resize branch).
        const chunks: Buffer[] = [];
        const readStream = file.createReadStream();
        await new Promise<void>((resolve, reject) => {
          readStream.on("data", (chunk: Buffer) => chunks.push(chunk));
          readStream.on("end", resolve);
          readStream.on("error", reject);
        });
        archive.append(Buffer.concat(chunks), { name: imageFilename });
      }
    } catch (err) {
      if (!(err instanceof ObjectNotFoundError)) {
        req.log.warn({ err, productId: p.id }, "Skipping image for product during export");
      }
    } finally {
      processed += 1;
      onProgress?.(processed, imageCount);
    }
  }
}

/**
 * In-memory store of finished export ZIPs that have been written to a temp file
 * and are awaiting a one-time download via {@link downloadExportToken}. Entries
 * are single-use and expire after EXPORT_DOWNLOAD_TTL_MS.
 */
type PendingExportDownload = {
  filePath: string;
  filename: string;
  workspaceOwnerId: string;
  expiresAt: number;
};
const pendingExportDownloads = new Map<string, PendingExportDownload>();
const EXPORT_DOWNLOAD_TTL_MS = 10 * 60 * 1000;

function removePendingExport(token: string): void {
  const entry = pendingExportDownloads.get(token);
  if (!entry) return;
  pendingExportDownloads.delete(token);
  fs.promises.unlink(entry.filePath).catch(() => {});
}

function sweepExpiredExports(): void {
  const now = Date.now();
  for (const [token, entry] of pendingExportDownloads) {
    if (entry.expiresAt <= now) removePendingExport(token);
  }
}

/**
 * GET /api/brands/:id/products/export?availability=all|available|unavailable
 * Stream a ZIP containing products.xlsx and images/ for the brand's products.
 * (Non-streaming variant — downloads the ZIP directly.)
 */
router.get("/brands/:id/products/export", async (req, res) => {
  const wreq = workspace(req);
  const brandId = parseInt(String(req.params.id), 10);
  if (Number.isNaN(brandId)) {
    res.status(400).json({ error: "Invalid brand id" });
    return;
  }

  const prep = await prepareBrandExport(req, brandId, wreq.workspaceOwnerId);
  if (!prep.ok) {
    res.status(prep.status).json({ error: prep.error });
    return;
  }

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${prep.data.zipFilename}"`);

  const archive = archiver("zip", { zlib: { level: 6 } });
  archive.on("error", (err) => {
    req.log.error({ err }, "Archiver error during brand products export");
  });
  archive.pipe(res);

  await appendBrandExportEntries(req, archive, prep.data);
  await archive.finalize();
});

/**
 * GET /api/brands/:id/products/export/progress?availability=...&channelConfigId=...
 * Server-Sent Events stream that builds the export ZIP to a temp file while
 * emitting `progress` events ({ processed, total }) as each image is processed.
 * When finished it emits a `done` event carrying a one-time download token that
 * the client passes to the download route below to fetch the finished ZIP.
 */
router.get("/brands/:id/products/export/progress", async (req, res) => {
  const wreq = workspace(req);
  const brandId = parseInt(String(req.params.id), 10);
  if (Number.isNaN(brandId)) {
    res.status(400).json({ error: "Invalid brand id" });
    return;
  }

  const prep = await prepareBrandExport(req, brandId, wreq.workspaceOwnerId);
  if (!prep.ok) {
    res.status(prep.status).json({ error: prep.error });
    return;
  }

  sweepExpiredExports();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  send("start", { total: prep.data.imageCount, filename: prep.data.zipFilename });

  const tmpPath = path.join(os.tmpdir(), `brand-export-${randomUUID()}.zip`);
  const fileStream = fs.createWriteStream(tmpPath);
  const archive = archiver("zip", { zlib: { level: 6 } });

  let clientGone = false;
  req.on("close", () => {
    clientGone = true;
  });

  try {
    const archiveDone = new Promise<void>((resolve, reject) => {
      fileStream.on("close", resolve);
      fileStream.on("error", reject);
      archive.on("error", reject);
    });
    archive.pipe(fileStream);

    await appendBrandExportEntries(
      req,
      archive,
      prep.data,
      (processed, total) => {
        if (!clientGone) send("progress", { processed, total });
      },
      () => clientGone,
    );
    await archive.finalize();
    await archiveDone;

    if (clientGone) {
      fs.promises.unlink(tmpPath).catch(() => {});
      res.end();
      return;
    }

    const token = randomUUID();
    pendingExportDownloads.set(token, {
      filePath: tmpPath,
      filename: prep.data.zipFilename,
      workspaceOwnerId: wreq.workspaceOwnerId,
      expiresAt: Date.now() + EXPORT_DOWNLOAD_TTL_MS,
    });
    // Auto-expire the temp file if the client never downloads it.
    setTimeout(() => removePendingExport(token), EXPORT_DOWNLOAD_TTL_MS).unref();

    send("done", { token, filename: prep.data.zipFilename });
    res.end();
  } catch (err) {
    req.log.error({ err }, "Brand products export (streaming) failed");
    fs.promises.unlink(tmpPath).catch(() => {});
    if (!clientGone) {
      send("error", { message: "Export failed while building the ZIP." });
      res.end();
    }
  }
});

/**
 * GET /api/brands/:id/products/export/download/:token
 * One-time download of a ZIP that was built by the progress stream above. The
 * temp file is deleted once the download completes.
 */
router.get("/brands/:id/products/export/download/:token", async (req, res) => {
  const wreq = workspace(req);
  const token = String(req.params.token);
  const entry = pendingExportDownloads.get(token);

  if (!entry || entry.expiresAt <= Date.now()) {
    if (entry) removePendingExport(token);
    res.status(404).json({ error: "Export not found or expired" });
    return;
  }
  if (entry.workspaceOwnerId !== wreq.workspaceOwnerId) {
    res.status(404).json({ error: "Export not found or expired" });
    return;
  }

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${entry.filename}"`);

  const readStream = fs.createReadStream(entry.filePath);
  readStream.on("error", (err) => {
    req.log.error({ err }, "Failed to stream brand export ZIP");
    removePendingExport(token);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to read export" });
    } else {
      res.end();
    }
  });
  res.on("close", () => {
    // Single-use: drop the entry and temp file once the response is done.
    removePendingExport(token);
  });
  readStream.pipe(res);
});

/**
 * GET /api/brands/:id/stickers
 * List all stickers belonging to a brand.
 */
router.get("/brands/:id/stickers", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(String(req.params.id), 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid brand id" });
    return;
  }

  const brandCheck = await db.query(
    `SELECT id FROM brands WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (brandCheck.rowCount === 0) {
    res.status(404).json({ error: "Brand not found" });
    return;
  }

  const result = await db.query(
    `SELECT s.id, s.name, s.file_name, s.created_at, s.brand_id
       FROM stickers s
      WHERE s.workspace_owner_id = $1 AND s.brand_id = $2
      ORDER BY s.created_at ASC`,
    [wreq.workspaceOwnerId, id],
  );
  res.json({ stickers: result.rows });
});

/**
 * POST /api/brands  multipart: name (field), logo (file — required, square, min 300×300)
 * Create a new brand. Owner or Designer only.
 */
router.post("/brands", upload.single("logo"), async (req, res) => {
  const wreq = workspace(req);
  if (!canManageBrand(wreq) && !hasPermission(wreq, "brands.create")) {
    res.status(403).json({ error: "You do not have permission to create brands" });
    return;
  }

  const name = String(req.body?.name ?? "").trim().slice(0, 200);
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  const description = req.body?.description ? String(req.body.description).trim().slice(0, 1000) || null : null;
  const targetCogsRaw = req.body?.target_cogs !== undefined && req.body.target_cogs !== "" ? parseFloat(req.body.target_cogs) : null;
  const targetCogs = (targetCogsRaw !== null && !Number.isNaN(targetCogsRaw) && targetCogsRaw >= 0 && targetCogsRaw <= 100) ? targetCogsRaw : null;

  const file = (req as unknown as { file?: Express.Multer.File }).file;
  if (!file) {
    res.status(400).json({ error: "A logo image is required" });
    return;
  }

  const mime = file.mimetype as string;
  if (!ALLOWED_MIME.includes(mime as typeof ALLOWED_MIME[number])) {
    res.status(400).json({ error: "Logo must be a JPEG, PNG, or WebP image" });
    return;
  }

  let dims: { width?: number; height?: number };
  try {
    dims = imageSize(file.buffer);
  } catch {
    res.status(400).json({ error: "Could not read image dimensions" });
    return;
  }

  const w = dims.width ?? 0;
  const h = dims.height ?? 0;

  if (w !== h) {
    res.status(400).json({ error: "Logo must be square (width must equal height)" });
    return;
  }
  if (w < 200) {
    res.status(400).json({ error: "Logo must be at least 200 × 200 pixels" });
    return;
  }

  const existingName = await db.query(
    `SELECT id FROM brands WHERE workspace_owner_id = $1 AND lower(name) = lower($2) LIMIT 1`,
    [wreq.workspaceOwnerId, name],
  );
  if ((existingName.rowCount ?? 0) > 0) {
    res.status(409).json({ error: "A brand with this name already exists" });
    return;
  }

  // Use a pinned client so both inserts share the same connection and transaction.
  // withTransaction retries automatically on serialization failures (40001/40P01).
  const client = await db.connect();
  let newBrand: BrandRowBasic;
  try {
    newBrand = await withTransaction(client, async () => {
      const result = await client.query<BrandRowBasic>(
        `INSERT INTO brands (workspace_owner_id, name, description, target_cogs, logo_data, logo_mime)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, name, description, target_cogs, created_at`,
        [wreq.workspaceOwnerId, name, description, targetCogs, file.buffer, mime],
      );
      const brand = result.rows[0];
      await client.query(
        `INSERT INTO brand_logos (brand_id, workspace_owner_id, logo_data, logo_mime, sort_order)
         VALUES ($1, $2, $3, $4, 0)`,
        [brand.id, wreq.workspaceOwnerId, file.buffer, mime],
      );
      return brand;
    });
  } finally {
    client.release();
  }

  void fireCatalogDataWebhook("catalog.brands.changed", wreq.workspaceOwnerId, { action: "created", brand_id: newBrand!.id });
  res.status(201).json({ brand: { ...newBrand!, has_logo: true, has_card_message: false, sticker_count: "0" } });
});

/**
 * GET /api/brands/:id/logo
 * Serve the primary (lowest sort_order) logo for a brand.
 * Backward-compat route — authenticated, workspace-scoped.
 */
router.get("/brands/:id/logo", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(String(req.params.id), 10);
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid brand id" }); return; }

  const result = await db.query<{ logo_data: Buffer; logo_mime: string }>(
    `SELECT logo_data, logo_mime
       FROM brand_logos
      WHERE brand_id = $1
        AND workspace_owner_id = $2
        AND deleted_at IS NULL
      ORDER BY sort_order ASC, created_at ASC
      LIMIT 1`,
    [id, wreq.workspaceOwnerId],
  );
  if (result.rowCount === 0) { res.status(404).json({ error: "No logo found" }); return; }

  const { logo_data, logo_mime } = result.rows[0];
  res.setHeader("Content-Type", logo_mime);
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send(logo_data);
});

/**
 * PATCH /api/brands/:id/logo  multipart: logo (file — required, square, min 200×200)
 * Replace the primary (sort_order=0) logo for a brand. Owner or Designer only.
 * Kept for backwards compatibility — prefer the /logos endpoints for multi-logo management.
 */
router.patch("/brands/:id/logo", upload.single("logo"), async (req, res) => {
  const wreq = workspace(req);
  if (!canManageBrand(wreq) && !hasPermission(wreq, "brands.manage-logos")) {
    res.status(403).json({ error: "You do not have permission to manage logos" });
    return;
  }

  const id = parseInt(String(req.params.id), 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid brand id" });
    return;
  }

  const brandCheck = await db.query(
    `SELECT id FROM brands WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (brandCheck.rowCount === 0) {
    res.status(404).json({ error: "Brand not found" });
    return;
  }

  const file = (req as unknown as { file?: Express.Multer.File }).file;
  if (!file) {
    res.status(400).json({ error: "A logo image is required" });
    return;
  }

  const mime = file.mimetype as string;
  if (!ALLOWED_MIME.includes(mime as typeof ALLOWED_MIME[number])) {
    res.status(400).json({ error: "Logo must be a JPEG, PNG, or WebP image" });
    return;
  }

  let dims: { width?: number; height?: number };
  try {
    dims = imageSize(file.buffer);
  } catch {
    res.status(400).json({ error: "Could not read image dimensions" });
    return;
  }

  const w = dims.width ?? 0;
  const h = dims.height ?? 0;

  if (w !== h) {
    res.status(400).json({ error: "Logo must be square (width must equal height)" });
    return;
  }
  if (w < 200) {
    res.status(400).json({ error: "Logo must be at least 200 × 200 pixels" });
    return;
  }

  // Update the primary logo in brand_logos and the legacy brands column atomically.
  // If the server crashes between the two writes the tables would be out of sync,
  // so both are wrapped in a single transaction.
  // withTransaction retries automatically on serialization failures (40001/40P01).
  const logoClient = await db.connect();
  try {
    await withTransaction(logoClient, async () => {
      const primaryLogo = await logoClient.query<{ id: number }>(
        `SELECT id FROM brand_logos
          WHERE brand_id = $1 AND workspace_owner_id = $2 AND deleted_at IS NULL
          ORDER BY sort_order ASC, created_at ASC
          LIMIT 1`,
        [id, wreq.workspaceOwnerId],
      );

      if (primaryLogo.rowCount && primaryLogo.rowCount > 0) {
        await logoClient.query(
          `UPDATE brand_logos SET logo_data = $1, logo_mime = $2 WHERE id = $3`,
          [file.buffer, mime, primaryLogo.rows[0].id],
        );
      } else {
        await logoClient.query(
          `INSERT INTO brand_logos (brand_id, workspace_owner_id, logo_data, logo_mime, sort_order)
           VALUES ($1, $2, $3, $4, 0)`,
          [id, wreq.workspaceOwnerId, file.buffer, mime],
        );
      }

      // Also update the legacy brands column for full compatibility.
      await logoClient.query(
        `UPDATE brands SET logo_data = $1, logo_mime = $2, updated_at = now() WHERE id = $3 AND workspace_owner_id = $4`,
        [file.buffer, mime, id, wreq.workspaceOwnerId],
      );
    });
  } finally {
    logoClient.release();
  }

  res.json({ ok: true });
});

/**
 * PATCH /api/brands/:id  { name }
 * Rename a brand. Owner or Designer only.
 */
router.patch("/brands/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!canManageBrand(wreq) && !hasPermission(wreq, "brands.edit")) {
    res.status(403).json({ error: "You do not have permission to edit brands" });
    return;
  }

  const id = parseInt(String(req.params.id), 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid brand id" });
    return;
  }

  const name = String(req.body?.name ?? "").trim().slice(0, 200);
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  const description = req.body?.description !== undefined
    ? (String(req.body.description).trim().slice(0, 1000) || null)
    : undefined;
  const targetCogsRaw = req.body?.target_cogs !== undefined
    ? (req.body.target_cogs === "" || req.body.target_cogs === null ? null : parseFloat(req.body.target_cogs))
    : undefined;
  const targetCogs = targetCogsRaw === undefined ? undefined
    : (targetCogsRaw !== null && !Number.isNaN(targetCogsRaw) && targetCogsRaw >= 0 && targetCogsRaw <= 100)
      ? targetCogsRaw
      : null;

  const existingName = await db.query(
    `SELECT id FROM brands WHERE workspace_owner_id = $1 AND lower(name) = lower($2) AND id <> $3 LIMIT 1`,
    [wreq.workspaceOwnerId, name, id],
  );
  if ((existingName.rowCount ?? 0) > 0) {
    res.status(409).json({ error: "A brand with this name already exists" });
    return;
  }

  const setClauses = ["name = $1", "updated_at = now()"];
  const params: unknown[] = [name];
  if (description !== undefined) { setClauses.push(`description = $${params.length + 1}`); params.push(description); }
  if (targetCogs !== undefined) { setClauses.push(`target_cogs = $${params.length + 1}`); params.push(targetCogs); }
  params.push(id, wreq.workspaceOwnerId);

  const result = await db.query<BrandRowBasic>(
    `UPDATE brands SET ${setClauses.join(", ")}
      WHERE id = $${params.length - 1} AND workspace_owner_id = $${params.length}
      RETURNING id, name, description, target_cogs, created_at`,
    params,
  );

  if (result.rowCount === 0) {
    res.status(404).json({ error: "Brand not found" });
    return;
  }

  void fireCatalogDataWebhook("catalog.brands.changed", wreq.workspaceOwnerId, { action: "updated", brand_id: id });
  res.json({ brand: result.rows[0] });
});

/**
 * DELETE /api/brands/:id
 * Delete a brand. Owner, Designer, or user with brands.delete permission.
 * Blocked if any stickers are still assigned to it.
 */
router.delete("/brands/:id", async (req, res) => {
  const wreq = workspace(req);
  const canDelete =
    wreq.workspaceActualRole === "owner" ||
    wreq.workspaceActualRole === "designer" ||
    (wreq.allowedPages?.includes("brands.delete") ?? false);
  if (!canDelete) {
    res.status(403).json({ error: "You do not have permission to delete brands" });
    return;
  }

  const id = parseInt(String(req.params.id), 10);
  if (Number.isNaN(id)) {
    res.status(400).json({ error: "Invalid brand id" });
    return;
  }

  const stickerCheck = await db.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM stickers WHERE brand_id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  const stickerCount = parseInt(stickerCheck.rows[0]?.count ?? "0", 10);
  if (stickerCount > 0) {
    res.status(409).json({
      error: `Cannot delete this brand — it still has ${stickerCount} sticker${stickerCount === 1 ? "" : "s"} assigned to it. Reassign or delete the stickers first.`,
    });
    return;
  }

  const result = await db.query(
    `DELETE FROM brands WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );

  if (result.rowCount === 0) {
    res.status(404).json({ error: "Brand not found" });
    return;
  }

  void fireCatalogDataWebhook("catalog.brands.changed", wreq.workspaceOwnerId, { action: "deleted", brand_id: id });
  res.json({ ok: true });
});

// ─── Brand Logos (multi-logo management) ─────────────────────────────────────

type BrandLogoRow = {
  id: number;
  brand_id: number;
  label: string | null;
  logo_mime: string;
  sort_order: number;
  created_at: string;
};

/**
 * GET /api/brands/:id/logos
 * List all logos for a brand (metadata only, no binary data).
 */
router.get("/brands/:id/logos", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(String(req.params.id), 10);
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid brand id" }); return; }

  const brandCheck = await db.query(
    `SELECT id FROM brands WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (brandCheck.rowCount === 0) { res.status(404).json({ error: "Brand not found" }); return; }

  const result = await db.query<BrandLogoRow>(
    `SELECT id, brand_id, label, logo_mime, sort_order, created_at
       FROM brand_logos
      WHERE brand_id = $1 AND workspace_owner_id = $2 AND deleted_at IS NULL
      ORDER BY sort_order ASC, created_at ASC`,
    [id, wreq.workspaceOwnerId],
  );
  res.json({ logos: result.rows });
});

/**
 * GET /api/brands/:id/logos/:logoId/image
 * Serve a specific brand logo as binary data. Authenticated, workspace-scoped.
 */
router.get("/brands/:id/logos/:logoId/image", async (req, res) => {
  const wreq = workspace(req);
  const brandId = parseInt(String(req.params.id), 10);
  const logoId = parseInt(req.params.logoId, 10);
  if (Number.isNaN(brandId) || Number.isNaN(logoId)) {
    res.status(400).json({ error: "Invalid id" }); return;
  }

  const result = await db.query<{ logo_data: Buffer; logo_mime: string }>(
    `SELECT logo_data, logo_mime
       FROM brand_logos
      WHERE id = $1
        AND brand_id = $2
        AND workspace_owner_id = $3
        AND deleted_at IS NULL`,
    [logoId, brandId, wreq.workspaceOwnerId],
  );
  if (result.rowCount === 0) { res.status(404).json({ error: "Logo not found" }); return; }

  const { logo_data, logo_mime } = result.rows[0];
  res.setHeader("Content-Type", logo_mime);
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send(logo_data);
});

/**
 * POST /api/brands/:id/logos  multipart: logo (file), label (optional field)
 * Add a new logo to a brand. Owner or Designer only.
 */
router.post("/brands/:id/logos", upload.single("logo"), async (req, res) => {
  const wreq = workspace(req);
  if (!canManageBrand(wreq) && !hasPermission(wreq, "brands.manage-logos")) {
    res.status(403).json({ error: "You do not have permission to manage logos" }); return;
  }

  const id = parseInt(String(req.params.id), 10);
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid brand id" }); return; }

  const brandCheck = await db.query(
    `SELECT id FROM brands WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (brandCheck.rowCount === 0) { res.status(404).json({ error: "Brand not found" }); return; }

  const file = (req as unknown as { file?: Express.Multer.File }).file;
  if (!file) { res.status(400).json({ error: "A logo image is required" }); return; }

  const mime = file.mimetype as string;
  if (!ALLOWED_MIME.includes(mime as typeof ALLOWED_MIME[number])) {
    res.status(400).json({ error: "Logo must be a JPEG, PNG, or WebP image" }); return;
  }

  let dims: { width?: number; height?: number };
  try { dims = imageSize(file.buffer); } catch {
    res.status(400).json({ error: "Could not read image dimensions" }); return;
  }

  const w = dims.width ?? 0;
  const h = dims.height ?? 0;
  if (w !== h) { res.status(400).json({ error: "Logo must be square (width must equal height)" }); return; }
  if (w < 200) { res.status(400).json({ error: "Logo must be at least 200 × 200 pixels" }); return; }

  const label = req.body?.label ? String(req.body.label).trim().slice(0, 100) || null : null;

  // Determine the next sort_order.
  const maxOrder = await db.query<{ max: number | null }>(
    `SELECT MAX(sort_order) AS max FROM brand_logos WHERE brand_id = $1 AND workspace_owner_id = $2 AND deleted_at IS NULL`,
    [id, wreq.workspaceOwnerId],
  );
  const nextOrder = ((maxOrder.rows[0]?.max) ?? -1) + 1;

  const result = await db.query<BrandLogoRow>(
    `INSERT INTO brand_logos (brand_id, workspace_owner_id, label, logo_data, logo_mime, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, brand_id, label, logo_mime, sort_order, created_at`,
    [id, wreq.workspaceOwnerId, label, file.buffer, mime, nextOrder],
  );
  res.status(201).json({ logo: result.rows[0] });
});

/**
 * PATCH /api/brands/:id/logos/:logoId  { label }
 * Update the label of a specific logo. Owner or Designer only.
 */
router.patch("/brands/:id/logos/:logoId", async (req, res) => {
  const wreq = workspace(req);
  if (!canManageBrand(wreq) && !hasPermission(wreq, "brands.manage-logos")) {
    res.status(403).json({ error: "You do not have permission to manage logos" }); return;
  }

  const brandId = parseInt(String(req.params.id), 10);
  const logoId = parseInt(req.params.logoId, 10);
  if (Number.isNaN(brandId) || Number.isNaN(logoId)) {
    res.status(400).json({ error: "Invalid id" }); return;
  }

  const label = req.body?.label !== undefined
    ? (String(req.body.label).trim().slice(0, 100) || null)
    : undefined;

  const result = await db.query<BrandLogoRow>(
    `UPDATE brand_logos SET label = $1
      WHERE id = $2 AND brand_id = $3 AND workspace_owner_id = $4 AND deleted_at IS NULL
      RETURNING id, brand_id, label, logo_mime, sort_order, created_at`,
    [label ?? null, logoId, brandId, wreq.workspaceOwnerId],
  );
  if (result.rowCount === 0) { res.status(404).json({ error: "Logo not found" }); return; }
  res.json({ logo: result.rows[0] });
});

/**
 * PUT /api/brands/:id/logos/reorder  { ids: number[] }
 * Reorder logos for a brand. Owner or Designer only.
 * ids must contain all non-deleted logo ids for the brand in the desired order.
 */
router.put("/brands/:id/logos/reorder", async (req, res) => {
  const wreq = workspace(req);
  if (!canManageBrand(wreq) && !hasPermission(wreq, "brands.manage-logos")) {
    res.status(403).json({ error: "You do not have permission to manage logos" }); return;
  }

  const id = parseInt(String(req.params.id), 10);
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid brand id" }); return; }

  const ids: unknown = req.body?.ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.some((x) => typeof x !== "number")) {
    res.status(400).json({ error: "ids must be a non-empty array of logo id numbers" }); return;
  }

  const logoIds = ids as number[];

  // Reject duplicates before hitting the DB.
  if (new Set(logoIds).size !== logoIds.length) {
    res.status(400).json({ error: "ids must not contain duplicates" }); return;
  }

  // Verify all ids belong to this brand/workspace and are not deleted.
  const existing = await db.query<{ id: number }>(
    `SELECT id FROM brand_logos
      WHERE brand_id = $1 AND workspace_owner_id = $2 AND deleted_at IS NULL`,
    [id, wreq.workspaceOwnerId],
  );
  const existingIds = new Set(existing.rows.map((r) => r.id));
  if (logoIds.length !== existingIds.size || !logoIds.every((lid) => existingIds.has(lid))) {
    res.status(400).json({ error: "ids must match all existing logos for this brand" }); return;
  }

  // Atomically update sort_order for all logos in one statement.
  const newOrders = logoIds.map((_lid, i) => i);
  await db.query(
    `UPDATE brand_logos AS bl
        SET sort_order = mapping.new_order
       FROM unnest($1::int[], $2::int[]) AS mapping(logo_id, new_order)
      WHERE bl.id       = mapping.logo_id
        AND bl.brand_id = $3
        AND bl.workspace_owner_id = $4`,
    [logoIds, newOrders, id, wreq.workspaceOwnerId],
  );

  res.json({ ok: true });
});

/**
 * DELETE /api/brands/:id/logos/:logoId
 * Soft-delete a logo. Owner or Designer only. Blocked if this is the only logo.
 */
router.delete("/brands/:id/logos/:logoId", async (req, res) => {
  const wreq = workspace(req);
  if (!canManageBrand(wreq) && !hasPermission(wreq, "brands.manage-logos")) {
    res.status(403).json({ error: "You do not have permission to manage logos" }); return;
  }

  const brandId = parseInt(String(req.params.id), 10);
  const logoId = parseInt(req.params.logoId, 10);
  if (Number.isNaN(brandId) || Number.isNaN(logoId)) {
    res.status(400).json({ error: "Invalid id" }); return;
  }

  // Wrap the existence/count check and the soft-delete UPDATE in a single
  // transaction.  We first lock all active logos for this brand (FOR UPDATE)
  // so that two concurrent deletes cannot both pass the "is not last" check.
  // FOR UPDATE cannot be combined with aggregate functions, so we lock first
  // then derive logo_exists and is_last from the locked rows in application code.
  // withTransaction retries automatically on serialization failures (40001/40P01).

  // Sentinel errors used to signal business-logic rejections from within the
  // transaction callback without triggering retry logic.
  class LogoNotFoundError extends Error {}
  class LogoIsLastError extends Error {}

  const deleteClient = await db.connect();
  try {
    await withTransaction(deleteClient, async () => {
      // Lock every active logo belonging to this brand.
      const lockedRows = await deleteClient.query<{ id: number }>(
        `SELECT id FROM brand_logos
          WHERE brand_id = $1 AND workspace_owner_id = $2 AND deleted_at IS NULL
            FOR UPDATE`,
        [brandId, wreq.workspaceOwnerId],
      );
      const activeIds = lockedRows.rows.map((r) => r.id);
      const logo_exists = activeIds.includes(logoId);
      const is_last = activeIds.length === 1;

      if (!logo_exists) throw new LogoNotFoundError();
      if (is_last) throw new LogoIsLastError();

      await deleteClient.query(
        `UPDATE brand_logos SET deleted_at = now()
          WHERE id = $1 AND brand_id = $2 AND workspace_owner_id = $3 AND deleted_at IS NULL`,
        [logoId, brandId, wreq.workspaceOwnerId],
      );
    });
  } catch (err) {
    if (err instanceof LogoNotFoundError) {
      res.status(404).json({ error: "Logo not found" });
      return;
    }
    if (err instanceof LogoIsLastError) {
      res.status(409).json({ error: "A brand must always keep at least one logo" });
      return;
    }
    throw err;
  } finally {
    deleteClient.release();
  }
  res.json({ ok: true });
});

/**
 * POST /api/brands/:id/logos/:logoId/restore
 * Restore a soft-deleted logo (undo). Owner or Designer only.
 */
router.post("/brands/:id/logos/:logoId/restore", async (req, res) => {
  const wreq = workspace(req);
  if (!canManageBrand(wreq) && !hasPermission(wreq, "brands.manage-logos")) {
    res.status(403).json({ error: "You do not have permission to manage logos" }); return;
  }

  const brandId = parseInt(String(req.params.id), 10);
  const logoId = parseInt(req.params.logoId, 10);
  if (Number.isNaN(brandId) || Number.isNaN(logoId)) {
    res.status(400).json({ error: "Invalid id" }); return;
  }

  const result = await db.query(
    `UPDATE brand_logos SET deleted_at = NULL
      WHERE id = $1 AND brand_id = $2 AND workspace_owner_id = $3 AND deleted_at IS NOT NULL`,
    [logoId, brandId, wreq.workspaceOwnerId],
  );
  if (result.rowCount === 0) { res.status(404).json({ error: "Logo not found or not deleted" }); return; }
  res.json({ ok: true });
});

/**
 * DELETE /api/brands/:id/logos/:logoId/permanent
 * Permanently delete a soft-deleted logo (called by the frontend after the undo window expires).
 */
router.delete("/brands/:id/logos/:logoId/permanent", async (req, res) => {
  const wreq = workspace(req);
  if (!canManageBrand(wreq) && !hasPermission(wreq, "brands.manage-logos")) {
    res.status(403).json({ error: "You do not have permission to manage logos" }); return;
  }

  const brandId = parseInt(String(req.params.id), 10);
  const logoId = parseInt(req.params.logoId, 10);
  if (Number.isNaN(brandId) || Number.isNaN(logoId)) {
    res.status(400).json({ error: "Invalid id" }); return;
  }

  const result = await db.query(
    `DELETE FROM brand_logos
      WHERE id = $1 AND brand_id = $2 AND workspace_owner_id = $3 AND deleted_at IS NOT NULL`,
    [logoId, brandId, wreq.workspaceOwnerId],
  );
  if (result.rowCount === 0) { res.status(404).json({ error: "Logo not found or not soft-deleted" }); return; }
  res.json({ ok: true });
});

// ─── Card Message ────────────────────────────────────────────────────────────

const CARD_MSG_MIME = ["image/jpeg", "image/png"] as const;


/**
 * PUT /api/brands/:id/card-message  multipart: image (file — JPEG or PNG)
 * Upload or replace the card message image. Owner or Designer only.
 */
router.put("/brands/:id/card-message", upload.single("image"), async (req, res) => {
  const wreq = workspace(req);
  if (!canManageBrand(wreq) && !hasPermission(wreq, "brands.manage-card-message")) {
    res.status(403).json({ error: "You do not have permission to manage card messages" }); return;
  }

  const id = parseInt(String(req.params.id), 10);
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid brand id" }); return; }

  const brandCheck = await db.query(
    `SELECT id FROM brands WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (brandCheck.rowCount === 0) { res.status(404).json({ error: "Brand not found" }); return; }

  const file = (req as unknown as { file?: Express.Multer.File }).file;
  if (!file) { res.status(400).json({ error: "An image file is required" }); return; }

  const mime = file.mimetype as string;
  if (!CARD_MSG_MIME.includes(mime as typeof CARD_MSG_MIME[number])) {
    res.status(400).json({ error: "Card message must be a JPEG or PNG image" }); return;
  }

  await db.query(
    `UPDATE brands SET card_message_data = $1, card_message_mime = $2, updated_at = now() WHERE id = $3 AND workspace_owner_id = $4`,
    [file.buffer, mime, id, wreq.workspaceOwnerId],
  );

  res.json({ ok: true });
});

/**
 * DELETE /api/brands/:id/card-message
 * Remove the card message image. Owner or Designer only.
 */
router.delete("/brands/:id/card-message", async (req, res) => {
  const wreq = workspace(req);
  if (!canManageBrand(wreq) && !hasPermission(wreq, "brands.manage-card-message")) {
    res.status(403).json({ error: "You do not have permission to manage card messages" }); return;
  }

  const id = parseInt(String(req.params.id), 10);
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid brand id" }); return; }

  const result = await db.query(
    `UPDATE brands SET card_message_data = NULL, card_message_mime = NULL, updated_at = now()
      WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (result.rowCount === 0) { res.status(404).json({ error: "Brand not found" }); return; }

  res.json({ ok: true });
});

// ─── Cover Photos ────────────────────────────────────────────────────────────

const COVER_LABELS = [
  "All Year",
  "Christmas",
  "New Year's",
  "Valentine's Day",
  "Women's Day",
  "Mother's Day",
  "Father's Day",
  "Easter",
  "Eid",
] as const;

type CoverPhotoRow = {
  id: number;
  brand_id: number;
  label: string;
  photo_mime: string;
  created_at: string;
};

/**
 * GET /api/brands/:id/cover-photos
 * List all cover photos for a brand (metadata only, no binary data).
 */
router.get("/brands/:id/cover-photos", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(String(req.params.id), 10);
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid brand id" }); return; }

  const brandCheck = await db.query(
    `SELECT id FROM brands WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (brandCheck.rowCount === 0) { res.status(404).json({ error: "Brand not found" }); return; }

  const result = await db.query<CoverPhotoRow>(
    `SELECT id, brand_id, label, photo_mime, created_at
       FROM brand_cover_photos
      WHERE workspace_owner_id = $1 AND brand_id = $2
      ORDER BY created_at ASC`,
    [wreq.workspaceOwnerId, id],
  );
  res.json({ coverPhotos: result.rows });
});


/**
 * POST /api/brands/:id/cover-photos  multipart: label (field) + photo (file)
 * Upload a new cover photo for a brand. Owner or Designer only.
 */
router.post("/brands/:id/cover-photos", uploadCoverPhoto.single("photo"), async (req, res) => {
  const wreq = workspace(req);
  if (!canManageBrand(wreq) && !hasPermission(wreq, "brands.manage-cover-photos")) {
    res.status(403).json({ error: "You do not have permission to manage cover photos" }); return;
  }

  const id = parseInt(String(req.params.id), 10);
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid brand id" }); return; }

  const brandCheck = await db.query(
    `SELECT id FROM brands WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (brandCheck.rowCount === 0) { res.status(404).json({ error: "Brand not found" }); return; }

  const label = String(req.body?.label ?? "").trim();
  if (!COVER_LABELS.includes(label as typeof COVER_LABELS[number])) {
    res.status(400).json({ error: `label must be one of: ${COVER_LABELS.join(", ")}` }); return;
  }

  const file = (req as unknown as { file?: Express.Multer.File }).file;
  if (!file) { res.status(400).json({ error: "A photo image is required" }); return; }

  const mime = file.mimetype as string;
  if (!ALLOWED_MIME.includes(mime as typeof ALLOWED_MIME[number])) {
    res.status(400).json({ error: "Photo must be a JPEG, PNG, or WebP image" }); return;
  }

  const result = await db.query<CoverPhotoRow>(
    `INSERT INTO brand_cover_photos (workspace_owner_id, brand_id, label, photo_data, photo_mime)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, brand_id, label, photo_mime, created_at`,
    [wreq.workspaceOwnerId, id, label, file.buffer, mime],
  );
  res.status(201).json({ coverPhoto: result.rows[0] });
});

/**
 * DELETE /api/brands/:id/cover-photos/:photoId
 * Delete a cover photo. Owner or Designer only.
 */
router.delete("/brands/:id/cover-photos/:photoId", async (req, res) => {
  const wreq = workspace(req);
  if (!canManageBrand(wreq) && !hasPermission(wreq, "brands.manage-cover-photos")) {
    res.status(403).json({ error: "You do not have permission to manage cover photos" }); return;
  }

  const brandId = parseInt(String(req.params.id), 10);
  const photoId = parseInt(req.params.photoId, 10);
  if (Number.isNaN(brandId) || Number.isNaN(photoId)) {
    res.status(400).json({ error: "Invalid id" }); return;
  }

  const result = await db.query(
    `DELETE FROM brand_cover_photos
      WHERE id = $1 AND brand_id = $2 AND workspace_owner_id = $3`,
    [photoId, brandId, wreq.workspaceOwnerId],
  );
  if (result.rowCount === 0) { res.status(404).json({ error: "Cover photo not found" }); return; }

  res.json({ ok: true });
});

/**
 * GET /api/brands/:id/cover-photos/:photoId/image
 * Serve a specific brand cover photo as binary data. Authenticated, workspace-scoped.
 */
router.get("/brands/:id/cover-photos/:photoId/image", async (req, res) => {
  const wreq = workspace(req);
  const brandId = parseInt(String(req.params.id), 10);
  const photoId = parseInt(req.params.photoId, 10);
  if (Number.isNaN(brandId) || Number.isNaN(photoId)) {
    res.status(400).json({ error: "Invalid id" }); return;
  }

  const result = await db.query<{ photo_data: Buffer; photo_mime: string }>(
    `SELECT photo_data, photo_mime
       FROM brand_cover_photos
      WHERE id = $1
        AND brand_id = $2
        AND workspace_owner_id = $3`,
    [photoId, brandId, wreq.workspaceOwnerId],
  );
  if (result.rowCount === 0) { res.status(404).json({ error: "Cover photo not found" }); return; }

  const { photo_data, photo_mime } = result.rows[0];
  res.setHeader("Content-Type", photo_mime);
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send(photo_data);
});

/**
 * GET /api/brands/:id/items
 * List base items linked to this brand via product recipes.
 */
router.get("/brands/:id/items", async (req, res) => {
  const wreq = workspace(req);
  const brandId = parseInt(String(req.params.id), 10);
  if (Number.isNaN(brandId)) { res.status(400).json({ error: "Invalid brand id" }); return; }

  const brandCheck = await db.query<{ name: string }>(
    `SELECT name FROM brands WHERE id = $1 AND workspace_owner_id = $2`,
    [brandId, wreq.workspaceOwnerId],
  );
  if (brandCheck.rowCount === 0) { res.status(404).json({ error: "Brand not found" }); return; }

  const result = await db.query<{
    id: number;
    code: string;
    name: string;
    main_image_url: string | null;
    main_category_name: string | null;
    sub_category_name: string | null;
  }>(
    `SELECT DISTINCT
        bi.id,
        bi.code,
        bi.name,
        bi.main_image_url,
        main_cat.name AS main_category_name,
        sub_cat.name  AS sub_category_name
      FROM base_items bi
      JOIN product_recipes pr ON pr.base_item_id = bi.id AND pr.workspace_owner_id = $1
      JOIN products p ON p.id = pr.product_id AND p.workspace_owner_id = $1
      LEFT JOIN base_item_categories sub_cat  ON sub_cat.id  = bi.category_id
      LEFT JOIN base_item_categories main_cat ON main_cat.id = sub_cat.parent_id
                                             OR (sub_cat.parent_id IS NULL AND main_cat.id = bi.category_id)
      WHERE LOWER(p.brand) = LOWER($2)
        AND bi.workspace_owner_id = $1
        AND (bi.status IS NULL OR bi.status != 'merged')
      ORDER BY bi.name ASC`,
    [wreq.workspaceOwnerId, brandCheck.rows[0].name],
  );

  res.json({ items: result.rows });
});

export default router;
