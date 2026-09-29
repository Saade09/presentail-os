import { Router, type Request, type Response } from "express";
import multer from "multer";
import { randomUUID, createHash } from "crypto";
import { z } from "zod";
import { clerkClient } from "@clerk/express";
import { db } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";
import { objectStorageClient } from "../lib/objectStorage";
import { logger } from "../lib/logger";
import { sendLowStockAlertEmail } from "../lib/email";
import { syncBaseItemPublicImage } from "../lib/baseItemPublicImages";
import { callAI } from "../lib/ai/callAI";
import { subscribeToLowStock, broadcastLowStock } from "../lib/lowStockSse";
import {
  postMovement,
  InventoryError,
  type OperationalMovementType,
} from "../lib/inventoryService";
import {
  canViewStockMovementLedger,
  escapeCsvCell,
  escapeCsvTextCell,
  resolveStockMovementQuery,
  type StockMovementFilters,
} from "../lib/stockMovementReporting";
import { validateXlsxUpload } from "../lib/xlsxUploadValidation";

const router = Router();

const baseItemRowSchema = z
  .object({
    id: z.number().int(),
    workspace_owner_id: z.string(),
    name: z.string(),
    code: z.string().optional(),
    image_url: z.string().nullable().optional(),
    category_id: z.number().int().nullable(),
    alternate_name: z.string().nullable().optional(),
    accounting_category: z.string().nullable().optional(),
    tax_rate: z.union([z.string(), z.number()]).nullable().optional(),
    tax_category: z.string().optional(),
    created_at: z.union([z.string(), z.date()]),
    main_category_name: z.string().nullable(),
    sub_category_name: z.string().nullable(),
    stock: z.union([z.string(), z.number()]).optional(),
    low_stock_threshold: z.union([z.string(), z.number()]).optional(),
    used_in_products: z.number().int().optional(),
    status: z.string().optional(),
    type: z.string().nullable().optional(),
    merged_into_base_item_id: z.number().int().nullable().optional(),
    merged_into_name: z.string().nullable().optional(),
    total_spend: z.string().optional(),
    spend_ytd: z.string().optional(),
  })
  .passthrough();

const baseItemsResponseSchema = z.object({
  items: z.array(baseItemRowSchema),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
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
  limits: { fileSize: 15 * 1024 * 1024 },
});

router.use(requireAuth, resolveWorkspace);

const SSE_HEARTBEAT_MS = 30_000;

/**
 * GET /base-items/low-stock-events
 * SSE stream that pushes a "low_stock" event whenever a stock adjustment or
 * transfer causes a location to cross into low-stock territory. Accessible to
 * owners and members with the base_items.manage permission.
 */
router.get("/base-items/low-stock-events", (req, res) => {
  const wreq = workspace(req);
  if (!canManage(wreq)) {
    res.status(403).json({ error: "Requires owner or base_items.manage permission" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  res.write(": connected\n\n");

  subscribeToLowStock(wreq.workspaceOwnerId, res);

  const heartbeat = setInterval(() => {
    try {
      res.write(": heartbeat\n\n");
    } catch {
      clearInterval(heartbeat);
    }
  }, SSE_HEARTBEAT_MS);

  req.on("close", () => {
    clearInterval(heartbeat);
  });
});

const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp"] as const;
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;
const CODE_MAX_ATTEMPTS = 20;

type BaseItemRow = {
  id: number;
  workspace_owner_id: string;
  name: string;
  code: string;
  image_url: string | null;
  category_id: number | null;
  alternate_name: string | null;
  accounting_category: string | null;
  tax_rate: string | null;
  tax_category: string;
  created_at: string;
  main_category_name: string | null;
  sub_category_name: string | null;
  stock: number;
  low_stock_threshold: number;
  used_in_products?: number;
  total_count?: string;
  total_spend?: string;
  spend_ytd?: string;
};

type LocationStatusRow = {
  location_id: number;
  location_name: string;
  country: string;
  is_active: boolean;
  stock: number;
  low_stock_threshold: number;
};

type ProductLinkRow = {
  id: number;
  name: string;
  sku: string | null;
  category: string | null;
  status: string;
  image_url: string | null;
  brand_id: number | null;
  brand_logo_id: number | null;
  quantity: string;
  unit: string | null;
  recipe_updated_at: string;
  recipe_line_item_id: number;
};

function canManage(wreq: ReturnType<typeof workspace>): boolean {
  return wreq.workspaceRole === "owner" || (wreq.allowedPages?.includes("base_items.manage") ?? false);
}

function canCreate(wreq: ReturnType<typeof workspace>): boolean {
  return wreq.workspaceRole === "owner"
    || (wreq.allowedPages?.includes("base_items.manage") ?? false)
    || (wreq.allowedPages?.includes("base_items.create") ?? false);
}

function canDelete(wreq: ReturnType<typeof workspace>): boolean {
  // Deleting a base item is a destructive, owner-only action. The legacy
  // base_items.manage / base_items.delete page permissions no longer grant it.
  return wreq.workspaceRole === "owner";
}

function canView(wreq: ReturnType<typeof workspace>): boolean {
  return wreq.workspaceRole === "owner"
    || (wreq.allowedPages?.includes("base_items.manage") ?? false)
    || (wreq.allowedPages?.includes("base_items.view") ?? false);
}

function generateCode(): string {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let code = letters[Math.floor(Math.random() * letters.length)];
  for (let i = 1; i < CODE_LENGTH; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

async function generateUniqueCode(workspaceOwnerId: string): Promise<string> {
  for (let attempt = 0; attempt < CODE_MAX_ATTEMPTS; attempt++) {
    const candidate = generateCode();
    const existing = await db.query<{ id: number }>(
      `SELECT id FROM base_items WHERE code = $1 AND workspace_owner_id = $2`,
      [candidate, workspaceOwnerId],
    );
    if (existing.rowCount === 0) {
      return candidate;
    }
  }
  throw new Error("CODE_SPACE_EXHAUSTED");
}

/**
 * Check whether the given location's stock has newly crossed below its effective
 * low-stock threshold (i.e., stockBefore > threshold >= stockAfter), and if so,
 * send alert emails to all workspace owners and members with base_items.manage
 * permission.
 *
 * Crossing semantics: alerts fire only when stock transitions from above to at/below
 * the threshold, preventing repeated alerts on subsequent updates that remain low.
 *
 * Deduplication: the INSERT uses ON CONFLICT to atomically guard against concurrent
 * requests. At most one notification per (workspace, base_item, location) is sent
 * per 24-hour window. Errors are caught and logged so the caller is never affected.
 */
async function fireAndForgetLowStockAlert(opts: {
  workspaceOwnerId: string;
  baseItemId: number;
  locationId: number;
  locationStockBefore: number;
  locationStockAfter: number;
}): Promise<void> {
  const { workspaceOwnerId, baseItemId, locationId, locationStockBefore, locationStockAfter } = opts;
  try {
    // Load base item name
    const itemResult = await db.query<{ name: string }>(
      `SELECT name FROM base_items WHERE id = $1 AND workspace_owner_id = $2`,
      [baseItemId, workspaceOwnerId],
    );
    if ((itemResult.rowCount ?? 0) === 0) return;
    const itemName = itemResult.rows[0].name;

    // Load location name, country, and per-location threshold
    const locResult = await db.query<{
      location_name: string; country: string; loc_threshold: string;
    }>(
      `SELECT l.name AS location_name, COALESCE(l.country, '') AS country,
              COALESCE(bils.low_stock_threshold, 0) AS loc_threshold
         FROM locations l
         LEFT JOIN base_item_location_statuses bils
           ON bils.location_id = l.id AND bils.base_item_id = $2
        WHERE l.id = $1 AND l.workspace_owner_id = $3`,
      [locationId, baseItemId, workspaceOwnerId],
    );
    if ((locResult.rowCount ?? 0) === 0) return;
    const { location_name: locationName, country, loc_threshold } = locResult.rows[0];
    const locThreshold = Number(loc_threshold);

    // Load country-level default threshold
    const ctryResult = await db.query<{ default_low_stock_threshold: string }>(
      `SELECT default_low_stock_threshold
         FROM base_item_country_thresholds
        WHERE base_item_id = $1 AND country = $2`,
      [baseItemId, country],
    );
    const countryThreshold = (ctryResult.rowCount ?? 0) > 0
      ? Number(ctryResult.rows[0].default_low_stock_threshold)
      : 0;

    // Effective threshold: location-level takes priority; fall back to country default
    const effectiveThreshold = locThreshold > 0 ? locThreshold : countryThreshold;

    // No threshold configured — nothing to alert on
    if (effectiveThreshold <= 0) return;

    // Crossing check: only alert when stock newly crosses from above to at/below.
    // This prevents repeated alerts when stock is adjusted while already low.
    if (!(locationStockBefore > effectiveThreshold && locationStockAfter <= effectiveThreshold)) return;

    // Atomic dedup: insert or update the dedup row only when the last alert is
    // older than 24 hours (ON CONFLICT … DO UPDATE … WHERE expired).
    // If the existing row is still fresh (< 24 h old), the DO UPDATE WHERE clause
    // does not match → no row is touched → RETURNING is empty → skip.
    const dedupResult = await db.query<{ id: number }>(
      `INSERT INTO low_stock_alert_notifications
         (workspace_owner_id, base_item_id, location_id, sent_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (workspace_owner_id, base_item_id, location_id)
         DO UPDATE SET sent_at = now()
         WHERE low_stock_alert_notifications.sent_at <= now() - interval '24 hours'
       RETURNING id`,
      [workspaceOwnerId, baseItemId, locationId],
    );
    if ((dedupResult.rowCount ?? 0) === 0) return;

    // Fetch all recipients: owners + members with base_items.manage permission
    const recipientsResult = await db.query<{ member_email: string }>(
      `SELECT DISTINCT wm.member_email
         FROM workspace_members wm
         LEFT JOIN workspace_roles wr ON wr.id = wm.custom_role_id
        WHERE wm.workspace_owner_id = $1
          AND wm.joined_at IS NOT NULL
          AND (
            wm.role = 'owner'
            OR wr.allowed_pages @> '["base_items.manage"]'::jsonb
          )`,
      [workspaceOwnerId],
    );

    const deficit = effectiveThreshold - locationStockAfter;

    // Send emails concurrently; individual failures are logged but don't throw
    await Promise.all(
      recipientsResult.rows.map((r) =>
        sendLowStockAlertEmail({
          toEmail: r.member_email,
          itemName,
          locationName,
          country,
          currentStock: locationStockAfter,
          effectiveThreshold,
          deficit,
        }).catch((err) => {
          logger.warn(
            { err, toEmail: r.member_email, baseItemId, locationId },
            "Low-stock alert email delivery failed",
          );
        }),
      ),
    );

    logger.info(
      {
        workspaceOwnerId, baseItemId, locationId,
        itemName, locationName,
        stockBefore: locationStockBefore, currentStock: locationStockAfter,
        effectiveThreshold, deficit,
        recipientCount: recipientsResult.rows.length,
      },
      "Low-stock alert notifications dispatched",
    );

    // Broadcast to all dashboard tabs currently connected to the SSE stream.
    broadcastLowStock(workspaceOwnerId, {
      itemName,
      locationName,
      currentStock: locationStockAfter,
      baseItemId,
    });
  } catch (err) {
    logger.warn(
      { err, workspaceOwnerId, baseItemId, locationId },
      "fireAndForgetLowStockAlert: unexpected error (suppressed)",
    );
  }
}

async function uploadImageToStorage(buffer: Buffer, mime: string, workspaceOwnerId: string): Promise<string> {
  const privateObjectDir = process.env.PRIVATE_OBJECT_DIR;
  if (!privateObjectDir) throw new Error("PRIVATE_OBJECT_DIR not set");

  const objectId = randomUUID();
  const fullPath = `${privateObjectDir}/${workspaceOwnerId}/base-items/${objectId}`;
  const parts = fullPath.startsWith("/") ? fullPath.slice(1).split("/") : fullPath.split("/");
  if (parts.length < 2) throw new Error("Invalid PRIVATE_OBJECT_DIR path");
  const bucketName = parts[0];
  const objectName = parts.slice(1).join("/");

  const bucket = objectStorageClient.bucket(bucketName);
  const file = bucket.file(objectName);
  await file.save(buffer, { contentType: mime, resumable: false });

  return `/objects/${workspaceOwnerId}/base-items/${objectId}`;
}

const BASE_ITEM_SELECT = `
  SELECT bi.id, bi.workspace_owner_id, bi.name, bi.code, bi.image_url, bi.category_id,
         bi.alternate_name, bi.accounting_category, bi.tax_rate, bi.tax_category, bi.created_at,
         bi.stock, bi.low_stock_threshold,
         main_cat.name AS main_category_name,
         sub_cat.name  AS sub_category_name
    FROM base_items bi
    LEFT JOIN base_item_categories sub_cat  ON sub_cat.id  = bi.category_id
    LEFT JOIN base_item_categories main_cat ON main_cat.id = sub_cat.parent_id
                                           OR (sub_cat.parent_id IS NULL AND main_cat.id = bi.category_id)
`;

/**
 * POST /api/base-items/upload-image
 */
router.post("/base-items/upload-image", upload.single("image"), async (req, res) => {
  const wreq = workspace(req);
  if (!canCreate(wreq)) {
    res.status(403).json({ error: "Creating base items requires owner access or the Manage or Create base items permission" });
    return;
  }

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
    logger.error({ err }, "Failed to upload base item image");
    res.status(500).json({ error: "Failed to upload image" });
  }
});

const STYLE_SUFFIXES: Record<string, string> = {
  photographic:
    ", photorealistic product photo, subject centered and isolated on a pure white background, clean studio lighting, square composition, no shadows or gradients, professional product photography",
  minimal:
    ", clean minimal product photo, isolated on pure white background, soft diffuse lighting, clean lines, minimal style, professional product photography",
  illustration:
    ", artistic digital illustration, decorative style, vibrant colors, detailed artwork, white background",
};

const VALID_STYLES = ["photographic", "minimal", "illustration"] as const;
const VALID_COUNTS = [1, 2, 4] as const;
const BASE_ITEM_IMAGE_SIZE = "1024x1024";
const BASE_ITEM_IMAGE_QUALITY = "medium";

/**
 * POST /api/base-items/generate-image
 * Generate one or more images with AI from a text prompt.
 * Body: { prompt: string, count?: 1|2|4, style?: "photographic"|"minimal"|"illustration" }
 * Returns: { urls: string[] }
 */
router.post("/base-items/generate-image", async (req, res) => {
  const wreq = workspace(req);
  if (!canCreate(wreq)) {
    res.status(403).json({ error: "Creating base items requires owner access or the Manage or Create base items permission" });
    return;
  }

  const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
  if (!prompt) {
    res.status(400).json({ error: "prompt is required" });
    return;
  }

  const rawCount = Number(req.body?.count ?? 1);
  const count: 1 | 2 | 4 = (VALID_COUNTS as readonly number[]).includes(rawCount) ? (rawCount as 1 | 2 | 4) : 1;

  const rawStyle = typeof req.body?.style === "string" ? req.body.style : "photographic";
  const style = (VALID_STYLES as readonly string[]).includes(rawStyle) ? rawStyle : "photographic";
  const styleSuffix = STYLE_SUFFIXES[style];

  try {
    const { generateImageBuffer } = await import("@workspace/integrations-openai-ai-server/image");
    const styledPrompt = prompt + styleSuffix;

    const buffers = await Promise.all(
      Array.from({ length: count }, () => callAI({
        actionKey: "base_items.image_generation",
        surface: "base_items",
        provider: "openai",
        api: "image",
        model: "gpt-image-1",
        sessionId: `workspace:${wreq.workspaceOwnerId}`,
        imageSize: BASE_ITEM_IMAGE_SIZE,
        imageQuality: BASE_ITEM_IMAGE_QUALITY,
        call: () => generateImageBuffer(styledPrompt, BASE_ITEM_IMAGE_SIZE, undefined, {
          quality: BASE_ITEM_IMAGE_QUALITY,
        }),
      })),
    );

    const urls: string[] = [];
    for (const buffer of buffers) {
      if (!buffer || buffer.length === 0) {
        res.status(502).json({ error: "Image generation returned an empty result. Please try again." });
        return;
      }
      const objectPath = await uploadImageToStorage(buffer, "image/png", wreq.workspaceOwnerId);
      urls.push(objectPath);
    }

    res.json({ urls });
  } catch (err) {
    logger.error({ err }, "Failed to generate base item image");
    res.status(500).json({ error: "Failed to generate image. Please try again." });
  }
});

/**
 * GET /api/base-items/summary
 * Returns aggregate counts for the dashboard summary cards.
 * Must be registered before GET /base-items/:id.
 */
router.get("/base-items/summary", async (req, res) => {
  const wreq = workspace(req);
  const result = await db.query<{ total: string; flower: string; packaging: string; uncategorized: string }>(
    `SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (
          WHERE LOWER(COALESCE(main_cat.name, '')) LIKE '%flower%'
             OR LOWER(COALESCE(sub_cat.name, '')) LIKE '%flower%'
        ) AS flower,
        COUNT(*) FILTER (
          WHERE LOWER(COALESCE(main_cat.name, '')) LIKE '%packag%'
             OR LOWER(COALESCE(sub_cat.name, '')) LIKE '%packag%'
        ) AS packaging,
        COUNT(*) FILTER (WHERE bi.category_id IS NULL) AS uncategorized
       FROM base_items bi
       LEFT JOIN base_item_categories sub_cat  ON sub_cat.id = bi.category_id
       LEFT JOIN base_item_categories main_cat ON main_cat.id = sub_cat.parent_id
                                              OR (sub_cat.parent_id IS NULL AND main_cat.id = bi.category_id)
      WHERE bi.workspace_owner_id = $1`,
    [wreq.workspaceOwnerId],
  );
  const row = result.rows[0];
  res.json({
    total: parseInt(row.total, 10),
    flower: parseInt(row.flower, 10),
    packaging: parseInt(row.packaging, 10),
    uncategorized: parseInt(row.uncategorized, 10),
  });
});

/**
 * GET /api/base-items/spend-breakdown
 * Returns top N base items by YTD spend, sorted descending.
 * Must be registered before GET /base-items/:id.
 */
router.get("/base-items/spend-breakdown", async (req, res) => {
  const wreq = workspace(req);
  const limitRaw = parseInt(String(req.query.limit ?? "10"), 10);
  const limit = isNaN(limitRaw) || limitRaw < 1 || limitRaw > 100 ? 10 : limitRaw;

  const result = await db.query<{
    id: number;
    name: string;
    category: string | null;
    spend_ytd: string;
    total_spend: string;
  }>(
    `SELECT
        bi.id,
        bi.name,
        COALESCE(mc.name, c.name) AS category,
        COALESCE(SUM(CASE WHEN si.status <> 'cancelled' AND si.issued_at >= date_trunc('year', NOW()) THEN si.amount ELSE 0 END)::text, '0') AS spend_ytd,
        COALESCE(SUM(CASE WHEN si.status <> 'cancelled' THEN si.amount ELSE 0 END)::text, '0') AS total_spend
       FROM base_items bi
       JOIN supplier_invoices si
         ON si.reference_id = bi.id
        AND si.reference_type = 'base_item'
        AND si.workspace_owner_id = bi.workspace_owner_id
  LEFT JOIN base_item_categories c  ON c.id  = bi.category_id
  LEFT JOIN base_item_categories mc ON mc.id = c.parent_id
      WHERE bi.workspace_owner_id = $1
        AND bi.status = 'active'
        AND bi.merged_into_base_item_id IS NULL
   GROUP BY bi.id, bi.name, mc.name, c.name
     HAVING SUM(CASE WHEN si.status <> 'cancelled' AND si.issued_at >= date_trunc('year', NOW()) THEN si.amount ELSE 0 END) > 0
   ORDER BY SUM(CASE WHEN si.status <> 'cancelled' AND si.issued_at >= date_trunc('year', NOW()) THEN si.amount ELSE 0 END) DESC
      LIMIT $2`,
    [wreq.workspaceOwnerId, limit],
  );

  res.json({ items: result.rows });
});

/**
 * GET /api/base-items/spend-summary
 * Returns all-time and YTD spend totals across active base items for the workspace.
 * Uses a single aggregation query with conditional aggregates.
 * Must be registered before GET /base-items/:id.
 */
router.get("/base-items/spend-summary", async (req, res) => {
  const wreq = workspace(req);
  const result = await db.query<{ total_spend: string; spend_ytd: string }>(
    `SELECT
        COALESCE(SUM(CASE WHEN si.status <> 'cancelled' THEN si.amount ELSE 0 END)::text, '0') AS total_spend,
        COALESCE(SUM(CASE WHEN si.status <> 'cancelled' AND si.issued_at >= date_trunc('year', NOW()) THEN si.amount ELSE 0 END)::text, '0') AS spend_ytd
       FROM supplier_invoices si
       JOIN base_items bi ON bi.id = si.reference_id
                         AND bi.workspace_owner_id = si.workspace_owner_id
      WHERE si.reference_type = 'base_item'
        AND si.workspace_owner_id = $1
        AND bi.status = 'active'`,
    [wreq.workspaceOwnerId],
  );
  const row = result.rows[0];
  res.json({
    total_spend: row?.total_spend ?? "0",
    spend_ytd: row?.spend_ytd ?? "0",
  });
});

const VALID_SORTS = ["newest", "oldest", "name_asc", "name_desc", "category", "updated", "spend_desc", "spend_asc"] as const;
const VALID_STATUSES = ["active", "archived", "merged", "all"] as const;

async function appendAuditLog(
  workspaceOwnerId: string,
  userId: string,
  action: string,
  affectedIds: number[],
  previousValues?: unknown,
  newValues?: unknown,
): Promise<void> {
  await db.query(
    `INSERT INTO base_item_audit_log
       (workspace_owner_id, action, user_id, affected_ids, previous_values, new_values)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [workspaceOwnerId, action, userId, JSON.stringify(affectedIds), previousValues ?? null, newValues ?? null],
  );
}

/**
 * POST /api/base-items/bulk-update-category
 * Update category_id for given base item IDs. Owner or base_items.manage.
 */
router.post("/base-items/bulk-update-category", async (req, res) => {
  const wreq = workspace(req);
  if (!canManage(wreq)) {
    res.status(403).json({ error: "Managing base items requires owner access or the Manage base items permission" });
    return;
  }

  const { ids, category_id } = req.body ?? {};
  if (!Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ error: "ids must be a non-empty array" });
    return;
  }
  if (!ids.every((id: unknown) => typeof id === "number" && Number.isSafeInteger(id) && id > 0)) {
    res.status(400).json({ error: "Every id must be a positive integer" });
    return;
  }
  const itemIds = ids as number[];
  if (new Set(itemIds).size !== itemIds.length) {
    res.status(400).json({ error: "Duplicate ids are not allowed" });
    return;
  }

  let categoryId: number | null = null;
  if (category_id != null && category_id !== "") {
    if (typeof category_id !== "number" || !Number.isSafeInteger(category_id) || category_id <= 0) {
      res.status(400).json({ error: "Invalid category_id" });
      return;
    }
    categoryId = category_id;
  }

  const client = await db.connect();
  let previousValues: Record<number, number | null> = {};
  let updatedCount = 0;
  try {
    await client.query("BEGIN");

    if (categoryId !== null) {
      const categoryResult = await client.query<{
        id: number;
        parent_id: number | null;
        status: string;
      }>(
        `SELECT id, parent_id, status
           FROM base_item_categories
          WHERE id = $1 AND workspace_owner_id = $2
          FOR UPDATE`,
        [categoryId, wreq.workspaceOwnerId],
      );
      if (categoryResult.rowCount === 0) {
        await client.query("ROLLBACK");
        res.status(404).json({ error: "Category not found in this workspace" });
        return;
      }

      const category = categoryResult.rows[0];
      if (category.status !== "active") {
        await client.query("ROLLBACK");
        res.status(400).json({ error: "The selected category is inactive" });
        return;
      }

      if (category.parent_id === null) {
        const childrenResult = await client.query<{ id: number }>(
          `SELECT id
             FROM base_item_categories
            WHERE parent_id = $1
              AND workspace_owner_id = $2
              AND status = 'active'
            LIMIT 1`,
          [categoryId, wreq.workspaceOwnerId],
        );
        if ((childrenResult.rowCount ?? 0) > 0) {
          await client.query("ROLLBACK");
          res.status(400).json({ error: "Select an active subcategory instead of its parent category" });
          return;
        }
      } else {
        const parentResult = await client.query<{
          id: number;
          parent_id: number | null;
          status: string;
        }>(
          `SELECT id, parent_id, status
             FROM base_item_categories
            WHERE id = $1 AND workspace_owner_id = $2
            FOR SHARE`,
          [category.parent_id, wreq.workspaceOwnerId],
        );
        const parent = parentResult.rows[0];
        if (!parent || parent.parent_id !== null || parent.status !== "active") {
          await client.query("ROLLBACK");
          res.status(400).json({ error: "The selected category is not eligible for Base Items" });
          return;
        }
      }
    }

    const selectedItems = await client.query<{ id: number; category_id: number | null }>(
      `SELECT id, category_id
         FROM base_items
        WHERE workspace_owner_id = $1
          AND id = ANY($2::int[])
          AND status != 'merged'
        FOR UPDATE`,
      [wreq.workspaceOwnerId, itemIds],
    );
    if ((selectedItems.rowCount ?? 0) !== itemIds.length) {
      await client.query("ROLLBACK");
      res.status(404).json({
        error: "One or more selected Base Items were not found in this workspace or are not eligible",
      });
      return;
    }

    previousValues = selectedItems.rows.reduce((acc: Record<number, number | null>, row) => {
      acc[row.id] = row.category_id;
      return acc;
    }, {});

    const updateResult = await client.query<{ id: number }>(
      `UPDATE base_items
          SET category_id = $2
        WHERE workspace_owner_id = $1
          AND id = ANY($3::int[])
          AND status != 'merged'
        RETURNING id`,
      [wreq.workspaceOwnerId, categoryId, itemIds],
    );
    updatedCount = updateResult.rowCount ?? 0;
    if (updatedCount !== itemIds.length) {
      await client.query("ROLLBACK");
      res.status(409).json({ error: "The Base Items changed while the update was in progress; no categories were changed" });
      return;
    }

    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      req.log.error({ rollbackErr, itemIds }, "Rollback failed after bulk category update error");
    }
    req.log.error({ err, itemIds, categoryId }, "Bulk category update transaction failed");
    throw err;
  } finally {
    client.release();
  }

  try {
    await appendAuditLog(
      wreq.workspaceOwnerId, wreq.userId, "bulk_update_category", itemIds,
      previousValues,
      { category_id: categoryId },
    );
  } catch (auditErr) {
    req.log.error({ err: auditErr, itemIds }, "bulk_update_category audit log INSERT failed; update itself succeeded");
  }

  res.json({ ok: true, updated: updatedCount });
});

/**
 * POST /api/base-items/bulk-update-type
 * Update type for given base item IDs. Owner-only.
 */
router.post("/base-items/bulk-update-type", async (req, res) => {
  const wreq = workspace(req);
  if (!canManage(wreq)) {
    res.status(403).json({ error: "Managing base items requires owner access or the Manage base items permission" });
    return;
  }

  const { ids, type } = req.body ?? {};
  if (!Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ error: "ids must be a non-empty array" });
    return;
  }
  const itemIds = ids.map((id: unknown) => parseInt(String(id), 10)).filter((id: number) => !isNaN(id));
  if (itemIds.length === 0) {
    res.status(400).json({ error: "No valid IDs provided" });
    return;
  }

  const trimmedType = typeof type === "string" ? type.trim() || null : null;

  const placeholders = itemIds.map((_: number, i: number) => `$${i + 3}`).join(", ");
  const prev = await db.query<{ id: number; type: string | null }>(
    `SELECT id, type FROM base_items WHERE workspace_owner_id = $1 AND id IN (${placeholders})`,
    [wreq.workspaceOwnerId, ...itemIds],
  );

  await db.query(
    `UPDATE base_items SET type = $2 WHERE workspace_owner_id = $1 AND id IN (${placeholders})`,
    [wreq.workspaceOwnerId, trimmedType, ...itemIds],
  );

  try {
    await appendAuditLog(
      wreq.workspaceOwnerId, wreq.userId, "bulk_update_type", itemIds,
      prev.rows.reduce((acc: Record<number, string | null>, r) => { acc[r.id] = r.type; return acc; }, {}),
      { type: trimmedType },
    );
  } catch (auditErr) {
    req.log.error({ err: auditErr, itemIds }, "bulk_update_type audit log INSERT failed; update itself succeeded");
  }

  res.json({ ok: true, updated: itemIds.length });
});

/**
 * POST /api/base-items/bulk-archive
 * Archive given base item IDs (soft-delete). Owner-only.
 */
router.post("/base-items/bulk-archive", async (req, res) => {
  const wreq = workspace(req);
  if (!canManage(wreq)) {
    res.status(403).json({ error: "Managing base items requires owner access or the Manage base items permission" });
    return;
  }

  const { ids } = req.body ?? {};
  if (!Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ error: "ids must be a non-empty array" });
    return;
  }
  const itemIds = ids.map((id: unknown) => parseInt(String(id), 10)).filter((id: number) => !isNaN(id));
  if (itemIds.length === 0) {
    res.status(400).json({ error: "No valid IDs provided" });
    return;
  }

  const placeholders = itemIds.map((_: number, i: number) => `$${i + 4}`).join(", ");
  await db.query(
    `UPDATE base_items
        SET status = 'archived', archived_at = now(), archived_by_user_id = $2
      WHERE workspace_owner_id = $1
        AND status = 'active'
        AND id IN (${placeholders})`,
    [wreq.workspaceOwnerId, wreq.userId, ...itemIds],
  );

  try {
    await appendAuditLog(
      wreq.workspaceOwnerId, wreq.userId, "bulk_archive", itemIds,
      { status: "active" }, { status: "archived" },
    );
  } catch (auditErr) {
    req.log.error({ err: auditErr, itemIds }, "bulk_archive audit log INSERT failed; archive itself succeeded");
  }

  res.json({ ok: true, archived: itemIds.length });
});

/**
 * POST /api/base-items/bulk-add-supplier
 * Link a supplier to multiple base items (idempotent — already-linked items are a no-op).
 */
router.post("/base-items/bulk-add-supplier", async (req, res) => {
  const wreq = workspace(req);
  if (!canManage(wreq)) {
    res.status(403).json({ error: "Managing base items requires owner access or the Manage base items permission" });
    return;
  }

  const { baseItemIds, supplierId } = req.body ?? {};
  if (!Array.isArray(baseItemIds) || baseItemIds.length === 0) {
    res.status(400).json({ error: "baseItemIds must be a non-empty array" });
    return;
  }
  const itemIds = baseItemIds.map((id: unknown) => parseInt(String(id), 10)).filter((id: number) => !isNaN(id));
  if (itemIds.length === 0) {
    res.status(400).json({ error: "No valid baseItemIds provided" });
    return;
  }

  const supplierIdInt = parseInt(String(supplierId ?? ""), 10);
  if (isNaN(supplierIdInt)) {
    res.status(400).json({ error: "supplierId is required and must be a valid integer" });
    return;
  }

  const supplierCheck = await db.query(
    `SELECT id FROM suppliers WHERE id = $1 AND workspace_owner_id = $2 AND is_archived = false`,
    [supplierIdInt, wreq.workspaceOwnerId],
  );
  if (supplierCheck.rowCount === 0) {
    res.status(404).json({ error: "Supplier not found" });
    return;
  }

  // Verify all base items belong to the workspace
  const placeholders = itemIds.map((_: number, i: number) => `$${i + 2}`).join(", ");
  const biCheck = await db.query<{ id: number }>(
    `SELECT id FROM base_items WHERE workspace_owner_id = $1 AND id IN (${placeholders})`,
    [wreq.workspaceOwnerId, ...itemIds],
  );
  const validIds = biCheck.rows.map((r) => r.id);
  if (validIds.length === 0) {
    res.status(404).json({ error: "No valid base items found" });
    return;
  }

  // Upsert — insert rows that don't exist yet; skip existing ones
  let added = 0;
  for (const biId of validIds) {
    const result = await db.query(
      `INSERT INTO base_item_suppliers (workspace_owner_id, base_item_id, supplier_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (workspace_owner_id, base_item_id, supplier_id) DO NOTHING`,
      [wreq.workspaceOwnerId, biId, supplierIdInt],
    );
    added += result.rowCount ?? 0;
  }

  res.json({ ok: true, added, skipped: validIds.length - added });
});

/**
 * POST /api/base-items/bulk-remove-supplier
 * Remove a supplier link from multiple base items.
 * Does not affect existing PO line item snapshots.
 */
router.post("/base-items/bulk-remove-supplier", async (req, res) => {
  const wreq = workspace(req);
  if (!canManage(wreq)) {
    res.status(403).json({ error: "Managing base items requires owner access or the Manage base items permission" });
    return;
  }

  const { baseItemIds, supplierId } = req.body ?? {};
  if (!Array.isArray(baseItemIds) || baseItemIds.length === 0) {
    res.status(400).json({ error: "baseItemIds must be a non-empty array" });
    return;
  }
  const itemIds = baseItemIds.map((id: unknown) => parseInt(String(id), 10)).filter((id: number) => !isNaN(id));
  if (itemIds.length === 0) {
    res.status(400).json({ error: "No valid baseItemIds provided" });
    return;
  }

  const supplierIdInt = parseInt(String(supplierId ?? ""), 10);
  if (isNaN(supplierIdInt)) {
    res.status(400).json({ error: "supplierId is required and must be a valid integer" });
    return;
  }

  const placeholders = itemIds.map((_: number, i: number) => `$${i + 3}`).join(", ");
  const result = await db.query(
    `DELETE FROM base_item_suppliers
      WHERE workspace_owner_id = $1
        AND supplier_id = $2
        AND base_item_id IN (${placeholders})`,
    [wreq.workspaceOwnerId, supplierIdInt, ...itemIds],
  );

  res.json({ ok: true, removed: result.rowCount ?? 0 });
});

/**
 * POST /api/base-items/merge
 * Merge selected base items into a master item. Owner-only.
 * Reassigns product_recipes and base_item_suppliers rows to master,
 * then marks duplicates as 'merged'.
 */
router.post("/base-items/merge", async (req, res) => {
  const wreq = workspace(req);
  if (!canManage(wreq)) {
    res.status(403).json({ error: "Managing base items requires owner access or the Manage base items permission" });
    return;
  }

  const { ids, master_id } = req.body ?? {};
  if (!Array.isArray(ids) || ids.length < 2) {
    res.status(400).json({ error: "ids must have at least 2 items" });
    return;
  }
  const masterId = parseInt(String(master_id), 10);
  if (isNaN(masterId)) {
    res.status(400).json({ error: "master_id is required and must be a valid integer" });
    return;
  }
  const itemIds = ids.map((id: unknown) => parseInt(String(id), 10)).filter((id: number) => !isNaN(id));
  if (!itemIds.includes(masterId)) {
    res.status(400).json({ error: "master_id must be one of the selected ids" });
    return;
  }
  const duplicateIds = itemIds.filter((id: number) => id !== masterId);

  const placeholders = itemIds.map((_: number, i: number) => `$${i + 2}`).join(", ");
  const check = await db.query<{ id: number }>(
    `SELECT id FROM base_items
      WHERE workspace_owner_id = $1
        AND id IN (${placeholders})
        AND status = 'active'`,
    [wreq.workspaceOwnerId, ...itemIds],
  );
  if ((check.rowCount ?? 0) < itemIds.length) {
    res.status(400).json({ error: "One or more base items not found or not active" });
    return;
  }

  const dupPlaceholders = duplicateIds.map((_: number, i: number) => `$${i + 2}`).join(", ");

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // Fail fast if a concurrent merge holds the lock for more than 5 seconds
    // rather than hanging the HTTP connection indefinitely.
    await client.query("SET LOCAL lock_timeout = '5s'");

    // Re-check active status inside the transaction with FOR UPDATE so the
    // rows are locked before any mutation.  A concurrent merge that deactivates
    // one of these items will block here until our transaction finishes (or we
    // block on theirs), preventing silent partial merges.
    const lockPlaceholders = itemIds.map((_: number, i: number) => `$${i + 2}`).join(", ");
    let locked: import("pg").QueryResult<{ id: number }>;
    try {
      locked = await client.query<{ id: number }>(
        `SELECT id FROM base_items
          WHERE workspace_owner_id = $1
            AND id IN (${lockPlaceholders})
            AND status = 'active'
          FOR UPDATE`,
        [wreq.workspaceOwnerId, ...itemIds],
      );
    } catch (lockErr: unknown) {
      await client.query("ROLLBACK");
      const pgCode = (lockErr as { code?: string }).code;
      if (pgCode === "55P03") {
        res.status(409).json({ error: "Another merge is in progress for the same items; please try again" });
        return;
      }
      throw lockErr;
    }
    if ((locked.rowCount ?? 0) < itemIds.length) {
      await client.query("ROLLBACK");
      res.status(409).json({ error: "One or more base items no longer active; merge aborted due to concurrent modification" });
      return;
    }

    // Recipe replacement elsewhere locks its Product first.  Lock every
    // product whose recipe can change here in a stable order before touching
    // product_recipes, so neither operation can lose a semantic change.
    const affectedProducts = await client.query<{ id: number }>(
      `SELECT id
         FROM products
        WHERE workspace_owner_id = $1
          AND id IN (
            SELECT product_id
              FROM product_recipes
             WHERE workspace_owner_id = $1
               AND base_item_id = ANY($2::integer[])
          )
        ORDER BY id
        FOR UPDATE`,
      [wreq.workspaceOwnerId, itemIds],
    );
    const affectedProductIds = affectedProducts.rows.map((product) => product.id);

    await client.query(
      `DELETE FROM product_recipes
        WHERE base_item_id IN (${dupPlaceholders})
          AND workspace_owner_id = $${duplicateIds.length + 2}
          AND product_id IN (
             SELECT product_id
               FROM product_recipes
              WHERE base_item_id = $1
                AND workspace_owner_id = $${duplicateIds.length + 2}
          )`,
      [masterId, ...duplicateIds, wreq.workspaceOwnerId],
    );

    await client.query(
      `UPDATE product_recipes
          SET base_item_id = $1
        WHERE base_item_id IN (${dupPlaceholders})
          AND workspace_owner_id = $${duplicateIds.length + 2}`,
      [masterId, ...duplicateIds, wreq.workspaceOwnerId],
    );
    if (affectedProductIds.length > 0) {
      await client.query(
        `UPDATE products
            SET recipe_version = recipe_version + 1
          WHERE workspace_owner_id = $1
            AND id = ANY($2::integer[])`,
        [wreq.workspaceOwnerId, affectedProductIds],
      );
    }

    await client.query(
      `DELETE FROM base_item_location_statuses
        WHERE base_item_id IN (${dupPlaceholders})
          AND location_id IN (
            SELECT location_id FROM base_item_location_statuses WHERE base_item_id = $1
          )`,
      [masterId, ...duplicateIds],
    );

    await client.query(
      `UPDATE base_item_location_statuses
          SET base_item_id = $1
        WHERE base_item_id IN (${dupPlaceholders})`,
      [masterId, ...duplicateIds],
    );

    await client.query(
      `UPDATE base_item_suppliers
          SET base_item_id = $1
        WHERE base_item_id IN (${dupPlaceholders})
          AND workspace_owner_id = $${duplicateIds.length + 2}`,
      [masterId, ...duplicateIds, wreq.workspaceOwnerId],
    );

    // NOTE: params for this query place userId at $2 and duplicateIds starting
    // at $3, so we cannot reuse dupPlaceholders (which starts at $2).
    const updateBaseItemsDupPlaceholders = duplicateIds
      .map((_: number, i: number) => `$${i + 3}`)
      .join(", ");
    await client.query(
      `UPDATE base_items
          SET status = 'merged',
              merged_into_base_item_id = $1,
              merged_at = now(),
              merged_by_user_id = $2
        WHERE id IN (${updateBaseItemsDupPlaceholders})
          AND workspace_owner_id = $${duplicateIds.length + 3}`,
      [masterId, wreq.userId, ...duplicateIds, wreq.workspaceOwnerId],
    );

    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      req.log.error({ rollbackErr, masterId, duplicateIds }, "Rollback failed after merge error");
    }
    req.log.error({ err, masterId, duplicateIds }, "Base item merge transaction failed");
    throw err;
  } finally {
    client.release();
  }

  try {
    await appendAuditLog(
      wreq.workspaceOwnerId, wreq.userId, "merge", itemIds,
      { duplicates: duplicateIds }, { master_id: masterId },
    );
  } catch (auditErr) {
    req.log.error(
      { err: auditErr, masterId, duplicateIds },
      "Base item merge audit log INSERT failed; merge itself succeeded",
    );
  }

  res.json({ ok: true, master_id: masterId, merged: duplicateIds });
});

/**
 * GET /api/base-items/check-name
 * Returns exact and similar name matches across ALL base items for the workspace.
 * Registered before GET /base-items/:id to avoid path-parameter capture.
 * Query params: ?name=<string>
 */
router.get("/base-items/check-name", async (req, res) => {
  const wreq = workspace(req);

  const name = typeof req.query.name === "string" ? req.query.name.trim() : "";
  if (!name) {
    res.json({ exactMatch: null, similarMatches: [] });
    return;
  }

  const rows = await db.query<{ name: string }>(
    `SELECT name FROM base_items WHERE workspace_owner_id = $1 AND status = 'active'`,
    [wreq.workspaceOwnerId],
  );

  const lower = name.toLowerCase();
  let exactMatch: string | null = null;
  const similarMatches: string[] = [];

  for (const row of rows.rows) {
    const rowLower = row.name.trim().toLowerCase();
    if (rowLower === lower) {
      exactMatch = row.name;
    } else if (rowLower.includes(lower) || lower.includes(rowLower)) {
      similarMatches.push(row.name);
    }
  }

  res.json({ exactMatch, similarMatches });
});

/**
 * GET /api/base-items/stock-alerts
 * Returns all active base item / location pairs where the effective threshold is set and
 * current stock is at or below that threshold. Scoped to the caller's workspace.
 *
 * Query params:
 *   include_dismissed=true  — include alerts the current member has dismissed (default: omit them)
 */
router.get("/base-items/stock-alerts", async (req, res) => {
  const wreq = workspace(req);
  const includeDismissed = req.query.include_dismissed === "true";
  const memberDbId = wreq.memberDbId ?? 0;

  const result = await db.query<{
    base_item_id: number;
    base_item_name: string;
    base_item_code: string;
    location_id: number;
    location_name: string;
    country: string;
    stock: string;
    loc_threshold: string;
    country_threshold: string;
    dismissed: boolean;
    expires_at: string | null;
  }>(
    `SELECT bi.id AS base_item_id,
            bi.name AS base_item_name,
            bi.code AS base_item_code,
            l.id AS location_id,
            l.name AS location_name,
            COALESCE(l.country, '') AS country,
            COALESCE(bils.stock, 0) AS stock,
            COALESCE(bils.low_stock_threshold, 0) AS loc_threshold,
            COALESCE(bct.default_low_stock_threshold, 0) AS country_threshold,
            (sad.id IS NOT NULL) AS dismissed,
            sad.expires_at
       FROM base_items bi
       JOIN locations l ON l.workspace_owner_id = bi.workspace_owner_id
       LEFT JOIN base_item_location_statuses bils
         ON bils.base_item_id = bi.id AND bils.location_id = l.id
       LEFT JOIN base_item_country_thresholds bct
         ON bct.base_item_id = bi.id AND bct.country = COALESCE(l.country, '')
       LEFT JOIN stock_alert_dismissals sad
         ON sad.base_item_id = bi.id
        AND sad.location_id = l.id
        AND sad.member_id = $2
        AND sad.expires_at > now()
        AND sad.stock_at_dismissal = COALESCE(bils.stock, 0)
      WHERE bi.workspace_owner_id = $1
        AND bi.status = 'active'
        AND COALESCE(bils.is_active, true) = true
      ORDER BY bi.name ASC, l.country ASC, l.name ASC`,
    [wreq.workspaceOwnerId, memberDbId],
  );

  const alerts: Array<{
    base_item_id: number;
    base_item_name: string;
    base_item_code: string;
    location_id: number;
    location_name: string;
    country: string;
    stock: number;
    effective_threshold: number;
    deficit: number;
    dismissed: boolean;
    expires_at: string | null;
  }> = [];

  for (const row of result.rows) {
    const stock = Number(row.stock);
    const locThreshold = Number(row.loc_threshold);
    const countryThreshold = Number(row.country_threshold);
    const effectiveThreshold = locThreshold > 0 ? locThreshold : countryThreshold;

    if (effectiveThreshold > 0 && stock <= effectiveThreshold) {
      const dismissed = Boolean(row.dismissed);
      if (!includeDismissed && dismissed) continue;
      alerts.push({
        base_item_id: row.base_item_id,
        base_item_name: row.base_item_name,
        base_item_code: row.base_item_code,
        location_id: row.location_id,
        location_name: row.location_name,
        country: row.country,
        stock,
        effective_threshold: effectiveThreshold,
        deficit: Math.max(0, effectiveThreshold - stock + 1),
        dismissed,
        expires_at: dismissed ? (row.expires_at ?? null) : null,
      });
    }
  }

  res.json({ alerts, total: alerts.length });
});

/**
 * POST /api/base-items/stock-alerts/dismiss
 * Snoozes a stock alert for the current member for a chosen duration.
 * Body: { base_item_id: number, location_id: number, stock: number, duration_hours?: number, expires_at?: string }
 * Exactly one of duration_hours or expires_at may be provided; defaults to 24 hours.
 */
router.post("/base-items/stock-alerts/dismiss", async (req, res) => {
  const wreq = workspace(req);
  const memberDbId = wreq.memberDbId;
  if (!memberDbId) {
    res.status(403).json({ error: "Member record not found" });
    return;
  }

  const bodySchema = z
    .object({
      base_item_id: z.number().int().positive(),
      location_id: z.number().int().positive(),
      stock: z.number().int().min(0),
      duration_hours: z.number().positive().max(8760).optional(),
      expires_at: z.string().datetime().optional(),
    })
    .refine((d) => !(d.duration_hours != null && d.expires_at != null), {
      message: "Provide only one of duration_hours or expires_at",
    });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  const { base_item_id, location_id, stock, duration_hours, expires_at } = parsed.data;

  const ownerCheck = await db.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM base_items bi
        JOIN locations l ON l.workspace_owner_id = bi.workspace_owner_id
       WHERE bi.id = $1 AND l.id = $2 AND bi.workspace_owner_id = $3
     ) AS exists`,
    [base_item_id, location_id, wreq.workspaceOwnerId],
  );
  if (!ownerCheck.rows[0]?.exists) {
    res.status(404).json({ error: "Alert not found" });
    return;
  }

  let expiresExpr: string;
  const queryParams: unknown[] = [memberDbId, base_item_id, location_id, stock];

  if (expires_at != null) {
    expiresExpr = "$5";
    queryParams.push(expires_at);
  } else if (duration_hours != null) {
    expiresExpr = `now() + ($5 * INTERVAL '1 hour')`;
    queryParams.push(duration_hours);
  } else {
    expiresExpr = "now() + INTERVAL '24 hours'";
  }

  await db.query(
    `INSERT INTO stock_alert_dismissals
       (member_id, base_item_id, location_id, dismissed_at, expires_at, stock_at_dismissal)
     VALUES ($1, $2, $3, now(), ${expiresExpr}, $4)
     ON CONFLICT (member_id, base_item_id, location_id)
     DO UPDATE SET dismissed_at = now(), expires_at = ${expiresExpr},
                   stock_at_dismissal = EXCLUDED.stock_at_dismissal`,
    queryParams,
  );

  res.json({ success: true });
});

/**
 * POST /api/base-items/stock-alerts/dismiss-all
 * Snoozes every currently-active (non-dismissed) stock alert for the current member in one
 * batch. Accepts the same duration_hours / expires_at options as the single-alert endpoint.
 * Body: { duration_hours?: number, expires_at?: string }
 */
router.post("/base-items/stock-alerts/dismiss-all", async (req, res) => {
  const wreq = workspace(req);
  const memberDbId = wreq.memberDbId;
  if (!memberDbId) {
    res.status(403).json({ error: "Member record not found" });
    return;
  }

  const bodySchema = z
    .object({
      duration_hours: z.number().positive().max(8760).optional(),
      expires_at: z.string().datetime().optional(),
    })
    .refine((d) => !(d.duration_hours != null && d.expires_at != null), {
      message: "Provide only one of duration_hours or expires_at",
    });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  const { duration_hours, expires_at } = parsed.data;

  let expiresExpr: string;
  const queryParams: unknown[] = [memberDbId, wreq.workspaceOwnerId];

  if (expires_at != null) {
    expiresExpr = "$3";
    queryParams.push(expires_at);
  } else if (duration_hours != null) {
    expiresExpr = `now() + ($3 * INTERVAL '1 hour')`;
    queryParams.push(duration_hours);
  } else {
    expiresExpr = "now() + INTERVAL '24 hours'";
  }

  // Single INSERT … SELECT that finds all active alerts and dismisses them.
  // "Active" means: threshold is set, stock is at or below it, and no valid
  // dismissal row already exists for this member.
  await db.query(
    `INSERT INTO stock_alert_dismissals
       (member_id, base_item_id, location_id, dismissed_at, expires_at, stock_at_dismissal)
     SELECT $1,
            bi.id,
            l.id,
            now(),
            ${expiresExpr},
            COALESCE(bils.stock, 0)
       FROM base_items bi
       JOIN locations l ON l.workspace_owner_id = bi.workspace_owner_id
       LEFT JOIN base_item_location_statuses bils
         ON bils.base_item_id = bi.id AND bils.location_id = l.id
       LEFT JOIN base_item_country_thresholds bct
         ON bct.base_item_id = bi.id AND bct.country = COALESCE(l.country, '')
       LEFT JOIN stock_alert_dismissals sad
         ON sad.base_item_id = bi.id
        AND sad.location_id = l.id
        AND sad.member_id = $1
        AND sad.expires_at > now()
        AND sad.stock_at_dismissal = COALESCE(bils.stock, 0)
      WHERE bi.workspace_owner_id = $2
        AND bi.status = 'active'
        AND COALESCE(bils.is_active, true) = true
        AND sad.id IS NULL
        AND (CASE WHEN COALESCE(bils.low_stock_threshold, 0) > 0
                  THEN COALESCE(bils.low_stock_threshold, 0)
                  ELSE COALESCE(bct.default_low_stock_threshold, 0) END) > 0
        AND COALESCE(bils.stock, 0) <=
            (CASE WHEN COALESCE(bils.low_stock_threshold, 0) > 0
                  THEN COALESCE(bils.low_stock_threshold, 0)
                  ELSE COALESCE(bct.default_low_stock_threshold, 0) END)
     ON CONFLICT (member_id, base_item_id, location_id)
     DO UPDATE SET dismissed_at = now(),
                   expires_at = EXCLUDED.expires_at,
                   stock_at_dismissal = EXCLUDED.stock_at_dismissal`,
    queryParams,
  );

  res.json({ success: true });
});

/**
 * DELETE /api/base-items/stock-alerts/dismiss-all
 * Removes all dismissal rows for the current member in the workspace,
 * restoring every snoozed alert in one batch.
 */
router.delete("/base-items/stock-alerts/dismiss-all", async (req, res) => {
  const wreq = workspace(req);
  const memberDbId = wreq.memberDbId;
  if (!memberDbId) {
    res.status(403).json({ error: "Member record not found" });
    return;
  }

  await db.query(
    `DELETE FROM stock_alert_dismissals sad
      USING base_items bi
      WHERE sad.member_id = $1
        AND sad.base_item_id = bi.id
        AND bi.workspace_owner_id = $2`,
    [memberDbId, wreq.workspaceOwnerId],
  );

  res.json({ success: true });
});

/**
 * DELETE /api/base-items/stock-alerts/dismiss
 * Removes a dismissal for the current member, restoring the alert.
 * Body: { base_item_id: number, location_id: number }
 */
router.delete("/base-items/stock-alerts/dismiss", async (req, res) => {
  const wreq = workspace(req);
  const memberDbId = wreq.memberDbId;
  if (!memberDbId) {
    res.status(403).json({ error: "Member record not found" });
    return;
  }

  const bodySchema = z.object({
    base_item_id: z.number().int().positive(),
    location_id: z.number().int().positive(),
  });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  const { base_item_id, location_id } = parsed.data;

  const ownerCheck = await db.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM base_items bi
        JOIN locations l ON l.workspace_owner_id = bi.workspace_owner_id
       WHERE bi.id = $1 AND l.id = $2 AND bi.workspace_owner_id = $3
     ) AS exists`,
    [base_item_id, location_id, wreq.workspaceOwnerId],
  );
  if (!ownerCheck.rows[0]?.exists) {
    res.status(404).json({ error: "Alert not found" });
    return;
  }

  await db.query(
    `DELETE FROM stock_alert_dismissals
      WHERE member_id = $1 AND base_item_id = $2 AND location_id = $3`,
    [memberDbId, base_item_id, location_id],
  );

  res.json({ success: true });
});

/**
 * GET /api/base-items
 * Supports ?q=, ?category_id=, ?main_category_id=, ?image_status=, ?sort=, ?page=, ?limit=, ?status= filters.
 */
router.get("/base-items", async (req, res) => {
  const wreq = workspace(req);

  const rawStatus = typeof req.query.status === "string" ? req.query.status : "active";
  const statusFilter = (VALID_STATUSES as readonly string[]).includes(rawStatus) ? rawStatus : "active";

  const conditions: string[] = ["bi.workspace_owner_id = $1"];
  const params: unknown[] = [wreq.workspaceOwnerId];

  if (statusFilter !== "all") {
    params.push(statusFilter);
    conditions.push(`bi.status = $${params.length}`);
  }

  const q = typeof req.query.q === "string" && req.query.q.trim() ? req.query.q.trim() : null;
  if (q !== null) {
    params.push(`%${q.replace(/([%_\\])/g, "\\$1")}%`);
    conditions.push(`(bi.name ILIKE $${params.length} ESCAPE '\\' OR bi.code ILIKE $${params.length} ESCAPE '\\')`);
  }

  const rawCatId = typeof req.query.category_id === "string" ? req.query.category_id : null;
  const catId = rawCatId !== null ? parseInt(rawCatId, 10) : NaN;
  if (rawCatId === "none") {
    conditions.push(`bi.category_id IS NULL`);
  } else if (!isNaN(catId)) {
    params.push(catId);
    conditions.push(`bi.category_id = $${params.length}`);
  }

  const mainCatId = typeof req.query.main_category_id === "string" ? parseInt(req.query.main_category_id, 10) : NaN;
  if (!isNaN(mainCatId) && isNaN(catId) && rawCatId !== "none") {
    params.push(mainCatId);
    conditions.push(
      `(bi.category_id = $${params.length} OR bi.category_id IN (SELECT id FROM base_item_categories WHERE parent_id = $${params.length} AND workspace_owner_id = $1))`,
    );
  }

  const typeFilter = typeof req.query.type === "string" ? req.query.type : null;
  if (typeFilter === "flower" && rawCatId !== "none" && isNaN(catId) && isNaN(mainCatId)) {
    conditions.push(
      `(LOWER(COALESCE(main_cat.name, '')) LIKE '%flower%' OR LOWER(COALESCE(sub_cat.name, '')) LIKE '%flower%')`,
    );
  } else if (typeFilter === "packaging" && rawCatId !== "none" && isNaN(catId) && isNaN(mainCatId)) {
    conditions.push(
      `(LOWER(COALESCE(main_cat.name, '')) LIKE '%packag%' OR LOWER(COALESCE(sub_cat.name, '')) LIKE '%packag%')`,
    );
  }

  const imageStatus = typeof req.query.image_status === "string" ? req.query.image_status : null;
  if (imageStatus === "has") {
    conditions.push(`bi.image_url IS NOT NULL AND bi.image_url <> ''`);
  } else if (imageStatus === "missing") {
    conditions.push(`(bi.image_url IS NULL OR bi.image_url = '')`);
  }

  const rawSort = typeof req.query.sort === "string" ? req.query.sort : "newest";
  const sort = VALID_SORTS.includes(rawSort as typeof VALID_SORTS[number]) ? rawSort : "newest";

  const sortClause =
    sort === "oldest"     ? "bi.created_at ASC"  :
    sort === "name_asc"   ? "bi.name ASC"        :
    sort === "name_desc"  ? "bi.name DESC"       :
    sort === "category"   ? "COALESCE(main_cat.name, '') ASC, COALESCE(sub_cat.name, '') ASC, bi.name ASC" :
    sort === "updated"    ? "bi.created_at DESC" :
    sort === "spend_desc" ? "total_spend DESC NULLS LAST, bi.name ASC" :
    sort === "spend_asc"  ? "total_spend ASC NULLS LAST, bi.name ASC" :
                            "bi.created_at DESC";

  const rawPage  = typeof req.query.page  === "string" ? parseInt(req.query.page, 10)  : 1;
  const rawLimit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : 10;
  const page     = isNaN(rawPage)  || rawPage  < 1   ? 1   : rawPage;
  const pageSize = isNaN(rawLimit) || rawLimit < 1   ? 10  : Math.min(rawLimit, 100);
  const offset   = (page - 1) * pageSize;

  const whereClause = `WHERE ${conditions.join(" AND ")}`;

  const countResult = await db.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM base_items bi
       LEFT JOIN base_item_categories sub_cat  ON sub_cat.id = bi.category_id
       LEFT JOIN base_item_categories main_cat ON main_cat.id = sub_cat.parent_id
                                              OR (sub_cat.parent_id IS NULL AND main_cat.id = bi.category_id)
     ${whereClause}`,
    params,
  );
  const total = parseInt(countResult.rows[0].count, 10);

  params.push(pageSize, offset);
  const result = await db.query<BaseItemRow>(
    `SELECT bi.id, bi.workspace_owner_id, bi.name, bi.code, bi.image_url, bi.category_id,
            bi.alternate_name, bi.accounting_category, bi.tax_rate, bi.tax_category, bi.created_at,
            bi.stock, bi.low_stock_threshold,
            bi.status, bi.type,
            bi.merged_into_base_item_id,
            master.name AS merged_into_name,
            main_cat.name AS main_category_name,
            sub_cat.name  AS sub_category_name,
            (SELECT COUNT(DISTINCT pr.product_id)::int
               FROM product_recipes pr
              WHERE pr.base_item_id = bi.id
                AND pr.workspace_owner_id = $1
            ) AS used_in_products,
            (SELECT COALESCE(SUM(CASE WHEN si.status <> 'cancelled' THEN si.amount ELSE 0 END), 0)
               FROM supplier_invoices si
              WHERE si.reference_type = 'base_item'
                AND si.reference_id = bi.id
                AND si.workspace_owner_id = $1
            ) AS total_spend,
            (SELECT COALESCE(SUM(CASE WHEN si.status <> 'cancelled' THEN si.amount ELSE 0 END), 0)
               FROM supplier_invoices si
              WHERE si.reference_type = 'base_item'
                AND si.reference_id = bi.id
                AND si.workspace_owner_id = $1
                AND si.issued_at >= date_trunc('year', NOW())
            ) AS spend_ytd
       FROM base_items bi
       LEFT JOIN base_item_categories sub_cat  ON sub_cat.id = bi.category_id
       LEFT JOIN base_item_categories main_cat ON main_cat.id = sub_cat.parent_id
                                              OR (sub_cat.parent_id IS NULL AND main_cat.id = bi.category_id)
       LEFT JOIN base_items master ON master.id = bi.merged_into_base_item_id
     ${whereClause}
     ORDER BY ${sortClause}
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  sendValidated(
    req,
    res,
    baseItemsResponseSchema,
    { items: result.rows, total, page, pageSize },
    "GET /base-items",
  );
});

/**
 * POST /api/base-items
 * Create a base item. Owner or base_items.manage or base_items.create.
 */
router.post("/base-items", async (req, res) => {
  const wreq = workspace(req);
  if (!canCreate(wreq)) {
    res.status(403).json({ error: "Creating base items requires owner access or the Manage or Create base items permission" });
    return;
  }

  const { name, image_url, category_id } = req.body ?? {};
  const trimmedName = String(name ?? "").trim();
  if (!trimmedName) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  let categoryId: number | null = null;
  if (category_id != null && category_id !== "") {
    categoryId = parseInt(String(category_id), 10);
    if (isNaN(categoryId) || categoryId <= 0) {
      res.status(400).json({ error: "Invalid category_id" });
      return;
    }
    const catCheck = await db.query(
      `SELECT id FROM base_item_categories WHERE id = $1 AND workspace_owner_id = $2`,
      [categoryId, wreq.workspaceOwnerId],
    );
    if (catCheck.rowCount === 0) {
      res.status(404).json({ error: "Category not found" });
      return;
    }
  }

  const imageUrl = image_url ? String(image_url) : null;

  try {
    const code = await generateUniqueCode(wreq.workspaceOwnerId);
    const result = await db.query<BaseItemRow>(
      `INSERT INTO base_items (workspace_owner_id, name, code, image_url, category_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, workspace_owner_id, name, code, image_url, category_id, created_at`,
      [wreq.workspaceOwnerId, trimmedName, code, imageUrl, categoryId],
    );
    const row = result.rows[0];
    // Mirror the private image to the public bucket (fire-and-forget) so the
    // public website can render it without auth.
    if (imageUrl) {
      void syncBaseItemPublicImage(row.id, imageUrl, wreq.workspaceOwnerId);
    }
    res.status(201).json({ item: row });
  } catch (err) {
    if (err instanceof Error && err.message === "CODE_SPACE_EXHAUSTED") {
      res.status(500).json({ error: "Code space exhausted. Please contact support.", code: "CODE_SPACE_EXHAUSTED" });
      return;
    }
    throw err;
  }
});

/**
 * PATCH /api/base-items/:id
 * Update a base item. Owner or base_items.manage.
 */
router.patch("/base-items/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!canManage(wreq)) {
    res.status(403).json({ error: "Managing base items requires owner access or the Manage base items permission" });
    return;
  }

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid base item id" });
    return;
  }

  const existing = await db.query<BaseItemRow>(
    `SELECT * FROM base_items WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (existing.rowCount === 0) {
    res.status(404).json({ error: "Base item not found" });
    return;
  }

  const prev = existing.rows[0];
  const body = req.body ?? {};

  const name = "name" in body ? String(body.name ?? "").trim() : prev.name;
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  const imageUrl = "image_url" in body ? (body.image_url || null) : prev.image_url;

  const alternateName = "alternate_name" in body
    ? (body.alternate_name ? String(body.alternate_name).trim() || null : null)
    : prev.alternate_name;

  const accountingCategory = "accounting_category" in body
    ? (body.accounting_category ? String(body.accounting_category).trim() || null : null)
    : prev.accounting_category;

  let taxRate: string | null = prev.tax_rate;
  if ("tax_rate" in body) {
    if (body.tax_rate == null || body.tax_rate === "") {
      taxRate = null;
    } else {
      const parsed = parseFloat(String(body.tax_rate));
      if (isNaN(parsed) || parsed < 0 || parsed > 100) {
        res.status(400).json({ error: "tax_rate must be a number between 0 and 100" });
        return;
      }
      taxRate = String(parsed);
    }
  }

  const VALID_TAX_CATEGORIES = [
    "not_classified", "standard_taxable", "zero_rated", "exempt",
    "non_taxable", "food_grocery", "packaging", "service", "import_related",
  ] as const;
  let taxCategory: string = prev.tax_category ?? "not_classified";
  if ("tax_category" in body) {
    const tc = String(body.tax_category ?? "").trim();
    if (!(VALID_TAX_CATEGORIES as readonly string[]).includes(tc)) {
      res.status(400).json({ error: `tax_category must be one of: ${VALID_TAX_CATEGORIES.join(", ")}` });
      return;
    }
    taxCategory = tc;
  }

  let categoryId: number | null = prev.category_id;
  if ("category_id" in body) {
    if (body.category_id == null || body.category_id === "") {
      categoryId = null;
    } else {
      categoryId = parseInt(String(body.category_id), 10);
      if (isNaN(categoryId) || categoryId <= 0) {
        res.status(400).json({ error: "Invalid category_id" });
        return;
      }
      const catCheck = await db.query(
        `SELECT id FROM base_item_categories WHERE id = $1 AND workspace_owner_id = $2`,
        [categoryId, wreq.workspaceOwnerId],
      );
      if (catCheck.rowCount === 0) {
        res.status(404).json({ error: "Category not found" });
        return;
      }
    }
  }

  let stock: number = prev.stock;
  if ("stock" in body) {
    if (body.stock == null || body.stock === "") {
      stock = 0;
    } else {
      const parsed = parseFloat(String(body.stock));
      if (isNaN(parsed) || parsed < 0) {
        res.status(400).json({ error: "stock must be a non-negative number" });
        return;
      }
      stock = parsed;
    }
  }

  let lowStockThreshold: number = prev.low_stock_threshold;
  if ("low_stock_threshold" in body) {
    if (body.low_stock_threshold == null || body.low_stock_threshold === "") {
      lowStockThreshold = 0;
    } else {
      const parsed = parseFloat(String(body.low_stock_threshold));
      if (isNaN(parsed) || parsed < 0) {
        res.status(400).json({ error: "low_stock_threshold must be a non-negative number" });
        return;
      }
      lowStockThreshold = parsed;
    }
  }

  const result = await db.query<BaseItemRow>(
    `UPDATE base_items
        SET name = $1, image_url = $2, category_id = $3,
            alternate_name = $4, accounting_category = $5, tax_rate = $6,
            stock = $7, low_stock_threshold = $8, tax_category = $9
      WHERE id = $10 AND workspace_owner_id = $11
     RETURNING id, workspace_owner_id, name, code, image_url, category_id,
               alternate_name, accounting_category, tax_rate, tax_category, created_at,
               stock, low_stock_threshold`,
    [name, imageUrl, categoryId, alternateName, accountingCategory, taxRate, stock, lowStockThreshold, taxCategory, id, wreq.workspaceOwnerId],
  );
  // Keep the public, auth-free image copy in sync when the image changed
  // (fire-and-forget — failures are logged inside the helper).
  if (imageUrl !== prev.image_url) {
    void syncBaseItemPublicImage(id, imageUrl, wreq.workspaceOwnerId);
  }
  res.json({ item: result.rows[0] });
});

/**
 * GET /api/base-items/import/template
 * Download a pre-filled .xlsx template with column headers and one example row.
 * Owner-only. Registered before /base-items/:id.
 */
router.get("/base-items/import/template", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Only the workspace owner can download the import template" });
    return;
  }

  try {
    const ExcelJS = (await import("exceljs")).default;
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Base Items");

    sheet.columns = [
      { header: "Name", key: "name", width: 30 },
      { header: "Code", key: "code", width: 15 },
      { header: "Category", key: "category", width: 25 },
      { header: "Image URL", key: "image_url", width: 50 },
      { header: "Alternate Name", key: "alternate_name", width: 30 },
      { header: "Accounting Category", key: "accounting_category", width: 25 },
      { header: "Type", key: "type", width: 20 },
      { header: "Tax Rate", key: "tax_rate", width: 12 },
      { header: "Tax Category", key: "tax_category", width: 20 },
      { header: "Stock", key: "stock", width: 12 },
      { header: "Low Stock Threshold", key: "low_stock_threshold", width: 20 },
    ];

    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true };
    headerRow.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFE8F0FE" },
    };

    sheet.addRow({
      name: "White Rose",
      code: "WR001",
      category: "Flowers",
      image_url: "https://example.com/white-rose.jpg",
      alternate_name: "Rosa blanca",
      accounting_category: "Florals",
      type: "Flower",
      tax_rate: "5",
      tax_category: "standard_taxable",
      stock: "100",
      low_stock_threshold: "10",
    });

    const exampleRow = sheet.getRow(2);
    exampleRow.font = { italic: true, color: { argb: "FF808080" } };

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="base-items-import-template.xlsx"');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    logger.error({ err }, "Failed to generate import template");
    res.status(500).json({ error: "Failed to generate template" });
  }
});

/**
 * POST /api/base-items/import
 * Bulk import base items from an Excel/CSV file.
 * Owner-only. Registered before /base-items/:id.
 */
router.post("/base-items/import", upload.single("file"), async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Only the workspace owner can import base items" });
    return;
  }

  const file = (req as unknown as { file?: Express.Multer.File }).file;
  if (!file) {
    res.status(400).json({ error: "A file is required" });
    return;
  }

  const filename = file.originalname.toLowerCase();
  const isXlsx = filename.endsWith(".xlsx");
  const isLegacyXls = filename.endsWith(".xls");
  const isCsv = filename.endsWith(".csv");
  if (!isXlsx && !isLegacyXls && !isCsv) {
    res.status(400).json({ error: "Only .xlsx, .xls, and .csv files are accepted" });
    return;
  }

  // The filename and MIME type are both supplied by the client. Verify the
  // container signature before handing an alleged XLSX to ExcelJS. Legacy
  // .xls files are not supported by xlsxHelper and must not be treated as CSV.
  if (isLegacyXls) {
    res.status(400).json({ error: "Legacy .xls files are not supported. Please save the file as .xlsx or .csv." });
    return;
  }
  if (isXlsx) {
    const xlsxValidation = validateXlsxUpload(file.buffer);
    if (!xlsxValidation.valid) {
      logger.warn(
        { reason: xlsxValidation.reason },
        "Rejected invalid base items XLSX upload",
      );
      res.status(400).json({ error: "The file contents do not match a safe .xlsx format." });
      return;
    }
  }

  type ParsedRow = {
    rowIndex: number; // 1-indexed spreadsheet row number
    name: string;
    code?: string;
    category?: string;
    image_url?: string;
    alternate_name?: string;
    accounting_category?: string;
    type?: string;
    tax_rate?: string;
    tax_category?: string;
    stock?: string;
    low_stock_threshold?: string;
  };

  // errorRows holds rows that have a data problem that prevents import (e.g. missing Name)
  type ErrorRow = { row: number; error: string };
  const errorRows: ErrorRow[] = [];
  let parsedRows: ParsedRow[] = [];

  try {
    const { parseSpreadsheetToRows } = await import("../lib/xlsxHelper.js");
    const rows = await parseSpreadsheetToRows(file.buffer, "");

    if (rows.length < 2) {
      res.status(400).json({ error: "No data rows found in the file." });
      return;
    }

    // Build header index map from the first row.
    const headerRow = rows[0].map((h) => String(h ?? "").trim().toLowerCase());
    const getColIdx = (...names: string[]): number => {
      for (const n of names) {
        const idx = headerRow.indexOf(n.toLowerCase());
        if (idx !== -1) return idx;
      }
      return -1;
    };

    const COL = {
      name: getColIdx("name"),
      code: getColIdx("code"),
      category: getColIdx("category"),
      image_url: getColIdx("image url", "image_url", "imageurl"),
      alternate_name: getColIdx("alternate name", "alternate_name", "alternatename"),
      accounting_category: getColIdx("accounting category", "accounting_category"),
      type: getColIdx("type"),
      tax_rate: getColIdx("tax rate", "tax_rate", "taxrate"),
      tax_category: getColIdx("tax category", "tax_category"),
      stock: getColIdx("stock"),
      low_stock_threshold: getColIdx("low stock threshold", "low_stock_threshold"),
    };

    const getCell = (row: string[], idx: number): string | undefined => {
      if (idx === -1) return undefined;
      const val = row[idx];
      const str = String(val ?? "").trim();
      return str === "" ? undefined : str;
    };

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 1; // 1-indexed spreadsheet row (header is row 1)
      const name = getCell(row, COL.name);

      // Track rows with no Name as errors for preview
      if (!name) {
        // Skip truly blank rows (all cells empty)
        const hasData = row.some((c) => String(c ?? "").trim() !== "");
        if (hasData) errorRows.push({ row: rowNum, error: "missing_name" });
        continue;
      }

      parsedRows.push({
        rowIndex: rowNum,
        name,
        code: getCell(row, COL.code),
        category: getCell(row, COL.category),
        image_url: getCell(row, COL.image_url),
        alternate_name: getCell(row, COL.alternate_name),
        accounting_category: getCell(row, COL.accounting_category),
        type: getCell(row, COL.type),
        tax_rate: getCell(row, COL.tax_rate),
        tax_category: getCell(row, COL.tax_category),
        stock: getCell(row, COL.stock),
        low_stock_threshold: getCell(row, COL.low_stock_threshold),
      });
    }
  } catch (err) {
    logger.error({ err }, "Failed to parse import file");
    res.status(400).json({ error: "Could not parse the file. Please ensure it is a valid Excel or CSV file." });
    return;
  }

  if (parsedRows.length === 0) {
    res.status(400).json({ error: "No data rows found in the file." });
    return;
  }

  const [existingItemsResult, categoriesResult] = await Promise.all([
    db.query<{ id: number; name: string; code: string | null }>(
      `SELECT id, LOWER(name) AS name, LOWER(code) AS code FROM base_items WHERE workspace_owner_id = $1`,
      [wreq.workspaceOwnerId],
    ),
    db.query<{ id: number; name: string; parent_id: number | null }>(
      `SELECT id, name, parent_id FROM base_item_categories WHERE workspace_owner_id = $1`,
      [wreq.workspaceOwnerId],
    ),
  ]);

  const existingNames = new Set<string>();
  const existingCodes = new Set<string>();
  const existingIdByName = new Map<string, number>();
  const existingIdByCode = new Map<string, number>();
  for (const r of existingItemsResult.rows) {
    existingNames.add(r.name);
    existingIdByName.set(r.name, r.id);
    if (r.code) {
      existingCodes.add(r.code);
      existingIdByCode.set(r.code, r.id);
    }
  }

  const categoryByName = new Map<string, number>();
  for (const cat of categoriesResult.rows) {
    categoryByName.set(cat.name.toLowerCase(), cat.id);
  }

  const updateMode = req.query.update_mode === "true" || req.query.update_mode === "1";

  type SkippedRow = { row: number; name: string; reason: string };
  type WarningRow = { row: number; field: string; message: string };
  type ValidRow = ParsedRow & { category_id: number | null };
  type UpdateRow = ParsedRow & { category_id: number | null; existing_id: number };

  const skipped: SkippedRow[] = [];
  const warnings: WarningRow[] = [];
  const valid: ValidRow[] = [];
  const toUpdate: UpdateRow[] = [];
  const seenNamesInBatch = new Set<string>();
  const seenCodesInBatch = new Set<string>();
  const seenUpdateIds = new Set<number>();

  const VALID_TAX_CATEGORIES = ["not_classified", "standard_taxable", "exempt"];
  // Accept relative /objects/ paths and http(s):// URLs as valid image URLs.
  const isValidImageUrl = (v: string) =>
    v.startsWith("/objects/") || /^https?:\/\//i.test(v);

  for (const row of parsedRows) {
    const rowNum = row.rowIndex;
    const nameLower = row.name.toLowerCase();
    const codeLower = row.code?.toLowerCase();

    const nameInDb = existingNames.has(nameLower);
    const codeInDb = codeLower !== undefined && existingCodes.has(codeLower);
    const nameInBatch = seenNamesInBatch.has(nameLower);
    const codeInBatch = codeLower !== undefined && seenCodesInBatch.has(codeLower);

    if (nameInDb || codeInDb || nameInBatch || codeInBatch) {
      if (updateMode && (nameInDb || codeInDb)) {
        // Resolve the existing item's ID (name match takes priority)
        const existingId = existingIdByName.get(nameLower) ?? (codeLower ? existingIdByCode.get(codeLower) : undefined);
        if (existingId !== undefined && !seenUpdateIds.has(existingId)) {
          // Image URL validation — non-blocking; warn and clear invalid values.
          if (row.image_url && !isValidImageUrl(row.image_url)) {
            warnings.push({ row: rowNum, field: "Image URL", message: `invalid_image_url:${row.image_url}` });
            row.image_url = undefined;
          }

          let categoryId: number | null = null;
          if (row.category) {
            const resolved = categoryByName.get(row.category.toLowerCase());
            if (resolved !== undefined) {
              categoryId = resolved;
            } else {
              warnings.push({ row: rowNum, field: "Category", message: `category_not_found:${row.category}` });
            }
          }

          if (row.tax_category && !VALID_TAX_CATEGORIES.includes(row.tax_category)) {
            warnings.push({ row: rowNum, field: "Tax Category", message: `invalid_tax_category:${row.tax_category}` });
            row.tax_category = undefined;
          }

          seenUpdateIds.add(existingId);
          seenNamesInBatch.add(nameLower);
          if (codeLower) seenCodesInBatch.add(codeLower);
          toUpdate.push({ ...row, category_id: categoryId, existing_id: existingId });
          continue;
        }
      }
      // Skip: either not in update mode, both name+code only in batch (no DB match), or already queued for update
      const reason = (nameInDb || nameInBatch) ? "name_exists" : "code_exists";
      skipped.push({ row: rowNum, name: row.name, reason });
      continue;
    }

    // Image URL validation — non-blocking; warn and clear invalid values.
    if (row.image_url && !isValidImageUrl(row.image_url)) {
      warnings.push({
        row: rowNum,
        field: "Image URL",
        message: `invalid_image_url:${row.image_url}`,
      });
      row.image_url = undefined;
    }

    let categoryId: number | null = null;
    if (row.category) {
      const resolved = categoryByName.get(row.category.toLowerCase());
      if (resolved !== undefined) {
        categoryId = resolved;
      } else {
        warnings.push({
          row: rowNum,
          field: "Category",
          message: `category_not_found:${row.category}`,
        });
      }
    }

    if (row.tax_category && !VALID_TAX_CATEGORIES.includes(row.tax_category)) {
      warnings.push({
        row: rowNum,
        field: "Tax Category",
        message: `invalid_tax_category:${row.tax_category}`,
      });
      row.tax_category = undefined;
    }

    seenNamesInBatch.add(nameLower);
    if (codeLower) seenCodesInBatch.add(codeLower);

    valid.push({ ...row, category_id: categoryId });
  }

  // Build preview_rows for dry run (or when caller explicitly requests it)
  const dryRun = req.query.dry_run === "true" || req.query.dry_run === "1";

  type PreviewRow = {
    row: number;
    name?: string;
    code?: string;
    category?: string;
    status: "valid" | "skipped" | "error" | "update";
    skip_reason?: string;
    error_reason?: string;
  };
  const preview_rows: PreviewRow[] = [];

  // Error rows (missing Name) — included first, sorted by row number
  for (const e of errorRows) {
    preview_rows.push({ row: e.row, status: "error", error_reason: e.error });
  }

  const skippedByRow = new Map(skipped.map((s) => [s.row, s]));
  const updateByRow = new Map(toUpdate.map((u) => [u.rowIndex, u]));
  for (const row of parsedRows) {
    const s = skippedByRow.get(row.rowIndex);
    const u = updateByRow.get(row.rowIndex);
    if (s) {
      preview_rows.push({ row: row.rowIndex, name: row.name, code: row.code, category: row.category, status: "skipped", skip_reason: s.reason });
    } else if (u) {
      preview_rows.push({ row: row.rowIndex, name: row.name, code: row.code, category: row.category, status: "update" });
    } else {
      preview_rows.push({ row: row.rowIndex, name: row.name, code: row.code, category: row.category, status: "valid" });
    }
  }

  // Sort by row number so the preview table shows rows in file order
  preview_rows.sort((a, b) => a.row - b.row);

  if (dryRun || (valid.length === 0 && toUpdate.length === 0)) {
    res.json({ created: 0, updated: 0, skipped, warnings, preview_rows });
    return;
  }

  let createdCount = 0;
  let updatedCount = 0;
  // Collected during the transaction; public-image syncs fire only after COMMIT.
  const imageSyncQueue: { id: number; imageUrl: string }[] = [];
  try {
    const client = await db.connect();
    try {
      await client.query("BEGIN");

      for (const row of valid) {
        let code = row.code ?? null;
        if (!code) {
          let generated: string | null = null;
          for (let attempt = 0; attempt < CODE_MAX_ATTEMPTS; attempt++) {
            const candidate = generateCode();
            const existing = await client.query(
              `SELECT id FROM base_items WHERE code = $1 AND workspace_owner_id = $2`,
              [candidate, wreq.workspaceOwnerId],
            );
            if ((existing.rowCount ?? 0) === 0 && !seenCodesInBatch.has(candidate.toLowerCase())) {
              generated = candidate;
              seenCodesInBatch.add(candidate.toLowerCase());
              break;
            }
          }
          if (!generated) {
            warnings.push({ row: row.rowIndex, field: "Code", message: "code_generation_failed" });
            continue;
          }
          code = generated;
        }

        const taxRate = row.tax_rate != null && !isNaN(parseFloat(row.tax_rate)) ? row.tax_rate : null;
        const stock = row.stock != null && !isNaN(parseInt(row.stock, 10)) ? parseInt(row.stock, 10) : 0;
        const lowStockThreshold = row.low_stock_threshold != null && !isNaN(parseInt(row.low_stock_threshold, 10)) ? parseInt(row.low_stock_threshold, 10) : 0;
        const taxCategory = row.tax_category ?? "not_classified";

        const insertResult = await client.query<{ id: number }>(
          `INSERT INTO base_items
             (workspace_owner_id, name, code, image_url, category_id,
              alternate_name, accounting_category, tax_rate, tax_category,
              stock, low_stock_threshold, type)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           RETURNING id`,
          [
            wreq.workspaceOwnerId,
            row.name,
            code,
            row.image_url ?? null,
            row.category_id,
            row.alternate_name ?? null,
            row.accounting_category ?? null,
            taxRate,
            taxCategory,
            stock,
            lowStockThreshold,
            row.type ?? null,
          ],
        );
        if (row.image_url) {
          imageSyncQueue.push({ id: insertResult.rows[0].id, imageUrl: row.image_url });
        }
        createdCount++;
      }

      // Update existing items (update_mode only)
      for (const row of toUpdate) {
        const taxRate = row.tax_rate != null && !isNaN(parseFloat(row.tax_rate)) ? row.tax_rate : null;
        const stockVal = row.stock != null && !isNaN(parseInt(row.stock, 10)) ? parseInt(row.stock, 10) : null;
        const lowStockVal = row.low_stock_threshold != null && !isNaN(parseInt(row.low_stock_threshold, 10)) ? parseInt(row.low_stock_threshold, 10) : null;

        await client.query(
          `UPDATE base_items SET
             image_url           = COALESCE($1, image_url),
             category_id         = COALESCE($2::int, category_id),
             alternate_name      = COALESCE($3, alternate_name),
             accounting_category = COALESCE($4, accounting_category),
             type                = COALESCE($5, type),
             tax_rate            = COALESCE($6, tax_rate),
             tax_category        = COALESCE($7, tax_category),
             stock               = COALESCE($8::int, stock),
             low_stock_threshold = COALESCE($9::int, low_stock_threshold)
           WHERE id = $10 AND workspace_owner_id = $11`,
          [
            row.image_url ?? null,
            row.category_id,
            row.alternate_name ?? null,
            row.accounting_category ?? null,
            row.type ?? null,
            taxRate,
            row.tax_category ?? null,
            stockVal,
            lowStockVal,
            row.existing_id,
            wreq.workspaceOwnerId,
          ],
        );
        // COALESCE keeps the current image when the row omits one, so only an
        // explicitly provided image URL changes the image (and needs a sync).
        if (row.image_url && row.existing_id != null) {
          imageSyncQueue.push({ id: row.existing_id, imageUrl: row.image_url });
        }
        updatedCount++;
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    // Mirror imported private images to the public bucket only after the
    // transaction committed (fire-and-forget; the helper skips external
    // https URLs and clears any stale public copy for them).
    for (const entry of imageSyncQueue) {
      void syncBaseItemPublicImage(entry.id, entry.imageUrl, wreq.workspaceOwnerId);
    }
  } catch (err) {
    logger.error({ err }, "Failed to bulk import base items");
    res.status(500).json({ error: "Failed to import base items. Please try again." });
    return;
  }

  res.json({ created: createdCount, updated: updatedCount, skipped, warnings });
});

/**
 * GET /api/base-items/deletion-history
 * Workspace-wide list of base item deletions (action = 'delete'), newest first.
 * Owner-only. Surfaces deleted items that no longer exist via the stored
 * previous_values snapshot, with resolved actor names. Registered before the
 * `/base-items/:id` route so "deletion-history" is not parsed as an id.
 */
router.get("/base-items/deletion-history", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Only the workspace owner can view base item deletion history" });
    return;
  }

  const rawPage = typeof req.query.page === "string" ? parseInt(req.query.page, 10) : 1;
  const rawLimit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : 25;
  const page = isNaN(rawPage) || rawPage < 1 ? 1 : rawPage;
  const limit = isNaN(rawLimit) || rawLimit < 1 ? 25 : Math.min(rawLimit, 50);
  const offset = (page - 1) * limit;

  type DeletionRow = {
    id: number;
    user_id: string;
    affected_ids: number[];
    previous_values: unknown;
    created_at: string;
  };

  const [rows, countRow] = await Promise.all([
    db.query<DeletionRow>(
      `SELECT id, user_id, affected_ids, previous_values, created_at
         FROM base_item_audit_log
        WHERE workspace_owner_id = $1
          AND action = 'delete'
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3`,
      [wreq.workspaceOwnerId, limit, offset],
    ),
    db.query<{ total: string }>(
      `SELECT COUNT(*) AS total
         FROM base_item_audit_log
        WHERE workspace_owner_id = $1
          AND action = 'delete'`,
      [wreq.workspaceOwnerId],
    ),
  ]);

  const total = parseInt(countRow.rows[0]?.total ?? "0", 10);

  const userIds = [...new Set(rows.rows.map((r) => r.user_id).filter(Boolean))];
  const nameMap = new Map<string, string | null>();
  if (userIds.length > 0) {
    try {
      const clerkUsers = await clerkClient.users.getUserList({ userId: userIds, limit: 100 });
      for (const u of clerkUsers.data) {
        const parts = [u.firstName, u.lastName].filter(Boolean);
        nameMap.set(u.id, parts.length > 0 ? parts.join(" ") : null);
      }
    } catch (err) {
      logger.warn({ err }, "Failed to batch-fetch Clerk names for base item deletion history");
    }
  }

  const entries = rows.rows.map((r) => {
    const snapshot = (r.previous_values ?? null) as {
      name?: string | null;
      code?: string | null;
      category?: string | null;
      image_url?: string | null;
    } | null;
    return {
      id: r.id,
      user_id: r.user_id,
      actor_name: nameMap.get(r.user_id) ?? null,
      base_item_id: r.affected_ids?.[0] ?? null,
      item_name: snapshot?.name ?? null,
      item_code: snapshot?.code ?? null,
      item_category: snapshot?.category ?? null,
      item_image_url: snapshot?.image_url ?? null,
      created_at: r.created_at,
    };
  });

  res.json({ entries, total, page, limit });
});

/**
 * GET /api/base-items/:id
 * Return full base item row joined with its category name.
 */
router.get("/base-items/:id", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid base item id" });
    return;
  }

  const result = await db.query<BaseItemRow>(
    `${BASE_ITEM_SELECT}
      WHERE bi.id = $1 AND bi.workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (result.rowCount === 0) {
    res.status(404).json({ error: "Base item not found" });
    return;
  }
  res.json({ item: result.rows[0] });
});

/**
 * GET /api/base-items/:id/products
 * Return products linked via product_recipes (name, category, status, id).
 */
router.get("/base-items/:id/products", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid base item id" });
    return;
  }

  const check = await db.query(
    `SELECT id FROM base_items WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (check.rowCount === 0) {
    res.status(404).json({ error: "Base item not found" });
    return;
  }

  try {
    const result = await db.query<ProductLinkRow>(
      `SELECT p.id, p.name, p.sku,
              (SELECT cc.name FROM product_catalog_categories pcc JOIN catalog_categories cc ON cc.id = pcc.attribute_id WHERE pcc.product_id = p.id ORDER BY cc.name ASC LIMIT 1) AS category,
              p.status,
              p.main_image_url AS image_url,
              b.id AS brand_id,
              (SELECT bl.id FROM brand_logos bl
                WHERE bl.brand_id = b.id
                  AND bl.workspace_owner_id = $2
                  AND bl.deleted_at IS NULL
                ORDER BY bl.sort_order ASC
                LIMIT 1
              ) AS brand_logo_id,
              pr.quantity::text AS quantity,
              NULL::text AS unit,
              pr.created_at AS recipe_updated_at,
              pr.id AS recipe_line_item_id
         FROM products p
         JOIN product_recipes pr ON pr.product_id = p.id
         LEFT JOIN brands b
           ON LOWER(b.name) = LOWER(p.brand)
          AND b.workspace_owner_id = $2
        WHERE pr.base_item_id = $1
          AND pr.workspace_owner_id = $2
        ORDER BY pr.quantity DESC, p.name ASC`,
      [id, wreq.workspaceOwnerId],
    );
    res.json({ products: result.rows });
  } catch (err) {
    req.log.error({ err, baseItemId: id }, "Failed to load base item products");
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /api/base-items/:id/location-statuses
 * Return all workspace locations each with is_active (defaulting to true if no row exists).
 */
router.get("/base-items/:id/location-statuses", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid base item id" });
    return;
  }
  if (!canViewStockMovementLedger(wreq)) {
    res.status(403).json({ error: "forbidden" });
    return;
  }

  const check = await db.query(
    `SELECT id FROM base_items WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (check.rowCount === 0) {
    res.status(404).json({ error: "Base item not found" });
    return;
  }

  const restrictedLocationIds =
    wreq.assignedLocationIds !== null && wreq.assignedLocationIds.length > 0
      ? [...new Set(wreq.assignedLocationIds)]
      : null;
  const locationScopeSql = restrictedLocationIds
    ? "AND l.id = ANY($3::int[])"
    : "";
  const result = await db.query<LocationStatusRow>(
    `SELECT l.id AS location_id, l.name AS location_name,
            COALESCE(l.country, '') AS country,
            COALESCE(bils.is_active, true) AS is_active,
            COALESCE(bils.stock, 0) AS stock,
            COALESCE(bils.low_stock_threshold, 0) AS low_stock_threshold
       FROM locations l
       LEFT JOIN base_item_location_statuses bils
         ON bils.location_id = l.id AND bils.base_item_id = $1
      WHERE l.workspace_owner_id = $2
        ${locationScopeSql}
      ORDER BY l.country ASC, l.name ASC`,
    restrictedLocationIds
      ? [id, wreq.workspaceOwnerId, restrictedLocationIds]
      : [id, wreq.workspaceOwnerId],
  );
  res.json({ locationStatuses: result.rows });
});

/**
 * PATCH /api/base-items/:id/location-statuses/:locationId
 * Upsert the base_item_location_statuses row with the supplied isActive value.
 * Requires owner or base_items.manage.
 */
router.patch("/base-items/:id/location-statuses/:locationId", async (req, res) => {
  const wreq = workspace(req);
  if (!canManage(wreq)) {
    res.status(403).json({ error: "Managing base items requires owner access or the Manage base items permission" });
    return;
  }

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
    `SELECT id FROM base_items WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (check.rowCount === 0) {
    res.status(404).json({ error: "Base item not found" });
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
    `INSERT INTO base_item_location_statuses
       (workspace_owner_id, base_item_id, location_id, is_active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, now(), now())
     ON CONFLICT (base_item_id, location_id)
     DO UPDATE SET is_active = EXCLUDED.is_active, updated_at = now()`,
    [wreq.workspaceOwnerId, id, locationId, isActive],
  );
  res.json({ ok: true });
});

/**
 * PATCH /api/base-items/:id/location-stock/:locationId
 * Upsert per-location stock and low_stock_threshold.
 * Computes a delta movement via InventoryService (never posts the raw target).
 * Requires owner or base_items.manage.
 * Requires adjustment_action_id (uuid) in the request body for idempotency.
 */
router.patch("/base-items/:id/location-stock/:locationId", async (req, res) => {
  const wreq = workspace(req);
  if (!canManage(wreq)) {
    res.status(403).json({ error: "Managing base items requires owner access or the Manage base items permission" });
    return;
  }

  const id = parseInt(req.params.id, 10);
  const locationId = parseInt(req.params.locationId, 10);
  if (isNaN(id) || isNaN(locationId)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const { stock, lowStockThreshold, adjustment_action_id } = req.body ?? {};
  if (typeof stock !== "number" || stock < 0) {
    res.status(400).json({ error: "stock (non-negative number) is required" });
    return;
  }
  if (typeof lowStockThreshold !== "number" || lowStockThreshold < 0) {
    res.status(400).json({ error: "lowStockThreshold (non-negative number) is required" });
    return;
  }
  const parsedActionId = z.string().uuid().safeParse(adjustment_action_id);
  if (!parsedActionId.success) {
    res.status(400).json({ error: "adjustment_action_id is required and must be a UUID" });
    return;
  }
  const resolvedActionId = parsedActionId.data;

  const check = await db.query<{ id: number; inventory_allow_negative_stock: boolean }>(
    `SELECT bi.id,
            COALESCE(ws.inventory_allow_negative_stock, false) AS inventory_allow_negative_stock
       FROM base_items bi
       LEFT JOIN workspace_settings ws ON ws.workspace_owner_id = bi.workspace_owner_id
      WHERE bi.id = $1 AND bi.workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (check.rowCount === 0) {
    res.status(404).json({ error: "Base item not found" });
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
  const allowNegativeStock = check.rows[0].inventory_allow_negative_stock === true;

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const idempotencyKey = `manual-adjustment:${resolvedActionId}`;
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`${wreq.workspaceOwnerId}:${idempotencyKey}`],
    );
    const priorAction = await client.query<{
      id: number;
      base_item_id: number | null;
      location_id: number | null;
      metadata_snapshot: {
        requestedStock?: number;
        lowStockThreshold?: number;
      } | null;
    }>(
      `SELECT id, base_item_id, location_id, metadata_snapshot
         FROM base_item_stock_adjustments
        WHERE workspace_owner_id = $1 AND idempotency_key = $2
        LIMIT 1`,
      [wreq.workspaceOwnerId, idempotencyKey],
    );
    if (priorAction.rowCount! > 0) {
      const prior = priorAction.rows[0];
      const samePayload =
        prior.base_item_id === id &&
        prior.location_id === locationId &&
        Number(prior.metadata_snapshot?.requestedStock) === stock &&
        Number(prior.metadata_snapshot?.lowStockThreshold) === lowStockThreshold;
      await client.query("ROLLBACK");
      if (!samePayload) {
        res.status(409).json({
          error: "adjustment_action_id already used with a different payload",
          adjustment_id: prior.id,
        });
        return;
      }
      res.json({ ok: true, idempotent: true, adjustment_id: prior.id });
      return;
    }

    // Always upsert the threshold, regardless of stock change
    await client.query(
      `INSERT INTO base_item_location_statuses
         (workspace_owner_id, base_item_id, location_id, is_active, stock, low_stock_threshold, created_at, updated_at)
       VALUES ($1, $2, $3, true, 0, $4, now(), now())
       ON CONFLICT (base_item_id, location_id)
       DO UPDATE SET low_stock_threshold = EXCLUDED.low_stock_threshold, updated_at = now()`,
      [wreq.workspaceOwnerId, id, locationId, lowStockThreshold],
    );

    // Read current stock inside transaction (lock the row)
    const stockRow = await client.query<{ stock: string }>(
      `SELECT COALESCE(stock, 0)::text AS stock
         FROM base_item_location_statuses
        WHERE base_item_id = $1 AND location_id = $2
        FOR UPDATE`,
      [id, locationId],
    );
    const currentStock = stockRow.rowCount! > 0 ? parseFloat(stockRow.rows[0].stock) : 0;
    const quantityChange = stock - currentStock;

    if (quantityChange !== 0) {
      await postMovement(client, {
        workspaceOwnerId: wreq.workspaceOwnerId,
        baseItemId: id,
        locationId,
        quantityChange,
        reason: "Stock set manually",
        movementType: "inventory_count_correction",
        createdByUserId: wreq.userId,
        adjustmentActionId: resolvedActionId,
        idempotencyKey,
        inventoryAllowNegativeStock: allowNegativeStock,
        actorType: "user",
        actorId: wreq.userId,
        sourceType: "inventory_count",
        sourceId: resolvedActionId,
        sourceLabelSnapshot: "Location stock count",
        referenceType: "stock_adjustment",
        referenceId: resolvedActionId,
        referenceLabelSnapshot: "Stock set manually",
        metadataSnapshot: {
          requestedStock: stock,
          previousStock: currentStock,
          lowStockThreshold,
        },
      });
    }

    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

// ─── Canonical Units of Measure ────────────────────────────────────────────

const SUPPLIER_PRICING_UOM_CONTEXT = "supplier_pricing";

type UomRow = {
  code: string;
  display_name: string;
  aliases: string[];
};

type ParsedPricingUomInput =
  | { provided: false; code: null }
  | { provided: true; code: string | null }
  | { provided: true; code: null; error: string };

function parsePricingUomInput(body: Record<string, unknown>): ParsedPricingUomInput {
  const hasCode = Object.prototype.hasOwnProperty.call(body, "pricing_uom_code");
  const hasCompatibilityCode = Object.prototype.hasOwnProperty.call(body, "pricing_uom");
  if (!hasCode && !hasCompatibilityCode) return { provided: false, code: null };

  const parseValue = (value: unknown): { valid: boolean; code: string | null } => {
    if (value == null || value === "") return { valid: true, code: null };
    if (typeof value !== "string") return { valid: false, code: null };
    const code = value.trim();
    return code ? { valid: true, code } : { valid: true, code: null };
  };

  const canonical = hasCode ? parseValue(body.pricing_uom_code) : null;
  const compatibility = hasCompatibilityCode ? parseValue(body.pricing_uom) : null;
  if (canonical?.valid === false || compatibility?.valid === false) {
    return { provided: true, code: null, error: "pricing_uom_code must be a string or null" };
  }
  if (canonical && compatibility && canonical.code !== compatibility.code) {
    return { provided: true, code: null, error: "pricing_uom_code and pricing_uom must match when both are supplied" };
  }
  return { provided: true, code: canonical?.code ?? compatibility?.code ?? null };
}

async function findAvailableSupplierPricingUom(code: string) {
  const result = await db.query<{ code: string; display_name: string }>(
    `SELECT uc.code, uc.display_name
       FROM uom_catalog uc
       JOIN uom_context_availability uca
         ON uca.uom_code = uc.code
        AND uca.context = $2
        AND uca.is_active = true
      WHERE uc.code = $1
        AND uc.is_active = true`,
    [code, SUPPLIER_PRICING_UOM_CONTEXT],
  );
  return result.rows[0] ?? null;
}

/**
 * GET /api/uoms?context=supplier_pricing&q=
 */
router.get("/uoms", async (req, res) => {
  const context = typeof req.query.context === "string"
    ? req.query.context.trim()
    : SUPPLIER_PRICING_UOM_CONTEXT;
  if (context !== SUPPLIER_PRICING_UOM_CONTEXT) {
    res.status(400).json({ error: "Unsupported UOM context" });
    return;
  }

  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const search = q ? `%${q}%` : null;
  const result = await db.query<UomRow>(
    `SELECT uc.code,
            uc.display_name,
            COALESCE(
              array_agg(ua.alias ORDER BY ua.alias) FILTER (WHERE ua.id IS NOT NULL),
              ARRAY[]::text[]
            ) AS aliases
       FROM uom_catalog uc
       JOIN uom_context_availability uca
         ON uca.uom_code = uc.code
        AND uca.context = $1
        AND uca.is_active = true
       LEFT JOIN uom_aliases ua
         ON ua.uom_code = uc.code
        AND ua.is_active = true
      WHERE uc.is_active = true
        AND (
          $2::text IS NULL
          OR uc.code ILIKE $2
          OR uc.display_name ILIKE $2
          OR EXISTS (
            SELECT 1
              FROM uom_aliases usa
             WHERE usa.uom_code = uc.code
               AND usa.is_active = true
               AND usa.alias ILIKE $2
          )
        )
      GROUP BY uc.code, uc.display_name, uc.sort_order
      ORDER BY uc.sort_order, uc.display_name`,
    [context, search],
  );
  res.json({ context, uoms: result.rows });
});

// ─── Base Item Packages ────────────────────────────────────────────────────

type PackageRow = {
  id: number;
  workspace_owner_id: string;
  base_item_id: number;
  name: string;
  unit: string | null;
  unit_uom_code?: string | null;
  unit_uom_display_name?: string | null;
  quantity: number;
  barcode: string | null;
  is_default: boolean;
  created_at: string;
};

const BASE_ITEM_PACKAGE_SELECT = `
  SELECT bip.*,
         resolved.code AS unit_uom_code,
         resolved.display_name AS unit_uom_display_name
    FROM base_item_packages bip
    LEFT JOIN LATERAL (
      SELECT uc.code, uc.display_name
        FROM uom_aliases ua
        JOIN uom_catalog uc
          ON uc.code = ua.uom_code
         AND uc.is_active = true
        JOIN uom_context_availability uca
          ON uca.uom_code = uc.code
         AND uca.context = 'supplier_pricing'
         AND uca.is_active = true
       WHERE ua.normalized_alias = regexp_replace(lower(btrim(bip.unit)), '[[:space:]]+', ' ', 'g')
         AND ua.is_active = true
       LIMIT 1
    ) resolved ON true
`;

/**
 * GET /api/base-items/:id/packages
 */
router.get("/base-items/:id/packages", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid base item id" }); return; }

  const check = await db.query(`SELECT id FROM base_items WHERE id = $1 AND workspace_owner_id = $2`, [id, wreq.workspaceOwnerId]);
  if (check.rowCount === 0) { res.status(404).json({ error: "Base item not found" }); return; }

  const result = await db.query<PackageRow>(
    `${BASE_ITEM_PACKAGE_SELECT}
      WHERE bip.base_item_id = $1
        AND bip.workspace_owner_id = $2
      ORDER BY bip.is_default DESC, bip.created_at ASC`,
    [id, wreq.workspaceOwnerId],
  );
  res.json({ packages: result.rows });
});

/**
 * POST /api/base-items/:id/packages
 */
router.post("/base-items/:id/packages", async (req, res) => {
  const wreq = workspace(req);
  if (!canManage(wreq)) { res.status(403).json({ error: "Insufficient permissions" }); return; }

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid base item id" }); return; }

  const check = await db.query(`SELECT id FROM base_items WHERE id = $1 AND workspace_owner_id = $2`, [id, wreq.workspaceOwnerId]);
  if (check.rowCount === 0) { res.status(404).json({ error: "Base item not found" }); return; }

  const { name, unit, quantity, barcode } = req.body ?? {};
  const trimmedName = String(name ?? "").trim();
  if (!trimmedName) { res.status(400).json({ error: "name is required" }); return; }

  const qty = parseInt(String(quantity ?? ""), 10);
  if (isNaN(qty) || qty < 1) { res.status(400).json({ error: "quantity must be a positive integer" }); return; }
  if (qty < 2) { res.status(400).json({ error: "Additional packages must have quantity greater than 1" }); return; }

  const dupCheck = await db.query(
    `SELECT id FROM base_item_packages WHERE base_item_id = $1 AND workspace_owner_id = $2 AND LOWER(name) = LOWER($3)`,
    [id, wreq.workspaceOwnerId, trimmedName],
  );
  if (dupCheck.rowCount && dupCheck.rowCount > 0) { res.status(400).json({ error: "A package with this name already exists" }); return; }

  const result = await db.query<{ id: number }>(
    `INSERT INTO base_item_packages (workspace_owner_id, base_item_id, name, unit, quantity, barcode, is_default)
     VALUES ($1, $2, $3, $4, $5, $6, false) RETURNING id`,
    [wreq.workspaceOwnerId, id, trimmedName, unit ? String(unit).trim() || null : null, qty, barcode ? String(barcode).trim() || null : null],
  );
  const created = await db.query<PackageRow>(
    `${BASE_ITEM_PACKAGE_SELECT}
      WHERE bip.id = $1 AND bip.base_item_id = $2 AND bip.workspace_owner_id = $3`,
    [result.rows[0].id, id, wreq.workspaceOwnerId],
  );
  res.status(201).json({ package: created.rows[0] });
});

/**
 * PATCH /api/base-items/:id/packages/:packageId
 */
router.patch("/base-items/:id/packages/:packageId", async (req, res) => {
  const wreq = workspace(req);
  if (!canManage(wreq)) { res.status(403).json({ error: "Insufficient permissions" }); return; }

  const id = parseInt(req.params.id, 10);
  const packageId = parseInt(req.params.packageId, 10);
  if (isNaN(id) || isNaN(packageId)) { res.status(400).json({ error: "Invalid id" }); return; }

  const existing = await db.query<PackageRow>(
    `SELECT * FROM base_item_packages WHERE id = $1 AND base_item_id = $2 AND workspace_owner_id = $3`,
    [packageId, id, wreq.workspaceOwnerId],
  );
  if (existing.rowCount === 0) { res.status(404).json({ error: "Package not found" }); return; }

  const prev = existing.rows[0];
  const body = req.body ?? {};

  const trimmedName = "name" in body ? String(body.name ?? "").trim() : prev.name;
  if (!trimmedName) { res.status(400).json({ error: "name is required" }); return; }

  const qty = "quantity" in body ? parseInt(String(body.quantity ?? ""), 10) : prev.quantity;
  if (isNaN(qty) || qty < 1) { res.status(400).json({ error: "quantity must be a positive integer" }); return; }
  if (!prev.is_default && qty < 2) { res.status(400).json({ error: "Additional packages must have quantity greater than 1" }); return; }

  if ("name" in body && trimmedName !== prev.name) {
    const dupCheck = await db.query(
      `SELECT id FROM base_item_packages WHERE base_item_id = $1 AND workspace_owner_id = $2 AND LOWER(name) = LOWER($3) AND id != $4`,
      [id, wreq.workspaceOwnerId, trimmedName, packageId],
    );
    if (dupCheck.rowCount && dupCheck.rowCount > 0) { res.status(400).json({ error: "A package with this name already exists" }); return; }
  }

  const unit = "unit" in body ? (body.unit ? String(body.unit).trim() || null : null) : prev.unit;
  const barcode = "barcode" in body ? (body.barcode ? String(body.barcode).trim() || null : null) : prev.barcode;

  await db.query(
    `UPDATE base_item_packages SET name = $1, unit = $2, quantity = $3, barcode = $4 WHERE id = $5`,
    [trimmedName, unit, qty, barcode, packageId],
  );
  const updated = await db.query<PackageRow>(
    `${BASE_ITEM_PACKAGE_SELECT}
      WHERE bip.id = $1 AND bip.base_item_id = $2 AND bip.workspace_owner_id = $3`,
    [packageId, id, wreq.workspaceOwnerId],
  );
  res.json({ package: updated.rows[0] });
});

/**
 * DELETE /api/base-items/:id/packages/:packageId
 */
router.delete("/base-items/:id/packages/:packageId", async (req, res) => {
  const wreq = workspace(req);
  if (!canManage(wreq)) { res.status(403).json({ error: "Insufficient permissions" }); return; }

  const id = parseInt(req.params.id, 10);
  const packageId = parseInt(req.params.packageId, 10);
  if (isNaN(id) || isNaN(packageId)) { res.status(400).json({ error: "Invalid id" }); return; }

  const existing = await db.query<PackageRow>(
    `SELECT * FROM base_item_packages WHERE id = $1 AND base_item_id = $2 AND workspace_owner_id = $3`,
    [packageId, id, wreq.workspaceOwnerId],
  );
  if (existing.rowCount === 0) { res.status(404).json({ error: "Package not found" }); return; }

  const pkg = existing.rows[0];
  if (pkg.is_default) { res.status(400).json({ error: "Cannot delete the default package" }); return; }

  await db.query(`DELETE FROM base_item_packages WHERE id = $1`, [packageId]);
  res.json({ ok: true });
});

// ─── Base Item Suppliers ───────────────────────────────────────────────────

type BaseItemSupplierRow = {
  id: number;
  workspace_owner_id: string;
  base_item_id: number;
  supplier_id: number;
  package_id: number | null;
  supplier_item_name: string | null;
  supplier_item_code: string | null;
  pricing_uom: string | null;
  pricing_uom_code: string | null;
  pricing_uom_display_name: string | null;
  pricing_uom_legacy: string | null;
  price: string | null;
  currency: string;
  is_preferred: boolean;
  is_default_order_unit: boolean;
  name_ar: string | null;
  name_ar_source: string | null;
  created_at: string;
  supplier_name: string;
  package_name: string | null;
};

const BASE_ITEM_SUPPLIER_SELECT = `
  SELECT bis.id,
         bis.workspace_owner_id,
         bis.base_item_id,
         bis.supplier_id,
         bis.package_id,
         bis.supplier_item_name,
         bis.supplier_item_code,
         COALESCE(uc.display_name, bis.pricing_uom) AS pricing_uom,
         bis.pricing_uom_code,
         uc.display_name AS pricing_uom_display_name,
         CASE
           WHEN bis.pricing_uom_code IS NULL
            AND NULLIF(btrim(bis.pricing_uom), '') IS NOT NULL
           THEN bis.pricing_uom
           ELSE NULL
         END AS pricing_uom_legacy,
         bis.price,
         bis.currency,
         bis.is_preferred,
         bis.is_default_order_unit,
         bis.name_ar,
         bis.name_ar_source,
         bis.created_at,
         s.name AS supplier_name,
         bip.name AS package_name
    FROM base_item_suppliers bis
    JOIN suppliers s ON s.id = bis.supplier_id
    LEFT JOIN base_item_packages bip ON bip.id = bis.package_id
    LEFT JOIN uom_catalog uc ON uc.code = bis.pricing_uom_code
`;

/**
 * GET /api/base-items/:id/suppliers
 */
router.get("/base-items/:id/suppliers", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid base item id" }); return; }

  const check = await db.query(`SELECT id FROM base_items WHERE id = $1 AND workspace_owner_id = $2`, [id, wreq.workspaceOwnerId]);
  if (check.rowCount === 0) { res.status(404).json({ error: "Base item not found" }); return; }

  const result = await db.query<BaseItemSupplierRow>(
    `${BASE_ITEM_SUPPLIER_SELECT} WHERE bis.base_item_id = $1 AND bis.workspace_owner_id = $2 ORDER BY bis.created_at ASC`,
    [id, wreq.workspaceOwnerId],
  );
  res.json({ suppliers: result.rows });
});

/**
 * POST /api/base-items/:id/suppliers
 */
router.post("/base-items/:id/suppliers", async (req, res) => {
  const wreq = workspace(req);
  if (!canManage(wreq)) { res.status(403).json({ error: "Insufficient permissions" }); return; }

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid base item id" }); return; }

  const check = await db.query(`SELECT id FROM base_items WHERE id = $1 AND workspace_owner_id = $2`, [id, wreq.workspaceOwnerId]);
  if (check.rowCount === 0) { res.status(404).json({ error: "Base item not found" }); return; }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const { supplier_id, package_id, supplier_item_name, supplier_item_code, price, currency, is_preferred, is_default_order_unit } = body;

  const supplierId = parseInt(String(supplier_id ?? ""), 10);
  if (isNaN(supplierId)) { res.status(400).json({ error: "supplier_id is required" }); return; }

  const supplierCheck = await db.query(`SELECT id FROM suppliers WHERE id = $1 AND workspace_owner_id = $2 AND is_archived = false`, [supplierId, wreq.workspaceOwnerId]);
  if (supplierCheck.rowCount === 0) { res.status(404).json({ error: "Supplier not found" }); return; }

  let packageId: number | null = null;
  if (package_id != null && package_id !== "") {
    packageId = parseInt(String(package_id), 10);
    if (isNaN(packageId)) { res.status(400).json({ error: "Invalid package_id" }); return; }
    const pkgCheck = await db.query(`SELECT id FROM base_item_packages WHERE id = $1 AND base_item_id = $2 AND workspace_owner_id = $3`, [packageId, id, wreq.workspaceOwnerId]);
    if (pkgCheck.rowCount === 0) { res.status(404).json({ error: "Package not found" }); return; }
  }

  let parsedPrice: number | null = null;
  if (price != null && price !== "") {
    parsedPrice = parseFloat(String(price));
    if (isNaN(parsedPrice) || parsedPrice < 0) { res.status(400).json({ error: "price must be a non-negative number" }); return; }
  }

  const curr = typeof currency === "string" ? currency.toUpperCase() : "AED";
  if (!["AED", "USD"].includes(curr)) { res.status(400).json({ error: "currency must be AED or USD" }); return; }

  const pricingUomInput = parsePricingUomInput(body);
  if ("error" in pricingUomInput) {
    res.status(400).json({ error: pricingUomInput.error });
    return;
  }
  const canonicalUom = pricingUomInput.code
    ? await findAvailableSupplierPricingUom(pricingUomInput.code)
    : null;
  if (pricingUomInput.code && !canonicalUom) {
    res.status(400).json({ error: "pricing_uom_code must be an active canonical supplier pricing UOM code" });
    return;
  }

  const result = await db.query<BaseItemSupplierRow>(
    `INSERT INTO base_item_suppliers
       (workspace_owner_id, base_item_id, supplier_id, package_id, supplier_item_name, supplier_item_code, pricing_uom_code, pricing_uom, price, currency, is_preferred, is_default_order_unit)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    [
      wreq.workspaceOwnerId, id, supplierId, packageId,
      supplier_item_name ? String(supplier_item_name).trim() || null : null,
      supplier_item_code ? String(supplier_item_code).trim() || null : null,
      canonicalUom?.code ?? null,
      canonicalUom?.display_name ?? null,
      parsedPrice, curr,
      is_preferred === true, is_default_order_unit === true,
    ],
  );

  const full = await db.query<BaseItemSupplierRow>(
    `${BASE_ITEM_SUPPLIER_SELECT} WHERE bis.id = $1`,
    [result.rows[0].id],
  );
  res.status(201).json({ supplier: full.rows[0] });
});

/**
 * PATCH /api/base-items/:id/suppliers/:supplierId
 */
router.patch("/base-items/:id/suppliers/:supplierId", async (req, res) => {
  const wreq = workspace(req);
  if (!canManage(wreq)) { res.status(403).json({ error: "Insufficient permissions" }); return; }

  const id = parseInt(req.params.id, 10);
  const linkId = parseInt(req.params.supplierId, 10);
  if (isNaN(id) || isNaN(linkId)) { res.status(400).json({ error: "Invalid id" }); return; }

  const existing = await db.query<BaseItemSupplierRow>(
    `SELECT * FROM base_item_suppliers WHERE id = $1 AND base_item_id = $2 AND workspace_owner_id = $3`,
    [linkId, id, wreq.workspaceOwnerId],
  );
  if (existing.rowCount === 0) { res.status(404).json({ error: "Supplier link not found" }); return; }

  const prev = existing.rows[0];
  const body = (req.body ?? {}) as Record<string, unknown>;

  const supplierId = "supplier_id" in body ? parseInt(String(body.supplier_id ?? ""), 10) : prev.supplier_id;
  if (isNaN(supplierId)) { res.status(400).json({ error: "Invalid supplier_id" }); return; }
  if ("supplier_id" in body) {
    const supplierCheck = await db.query(`SELECT id FROM suppliers WHERE id = $1 AND workspace_owner_id = $2 AND is_archived = false`, [supplierId, wreq.workspaceOwnerId]);
    if (supplierCheck.rowCount === 0) { res.status(404).json({ error: "Supplier not found" }); return; }
  }

  let packageId: number | null = prev.package_id;
  if ("package_id" in body) {
    if (body.package_id == null || body.package_id === "") {
      packageId = null;
    } else {
      packageId = parseInt(String(body.package_id), 10);
      if (isNaN(packageId)) { res.status(400).json({ error: "Invalid package_id" }); return; }
      const pkgCheck = await db.query(`SELECT id FROM base_item_packages WHERE id = $1 AND base_item_id = $2 AND workspace_owner_id = $3`, [packageId, id, wreq.workspaceOwnerId]);
      if (pkgCheck.rowCount === 0) { res.status(404).json({ error: "Package not found" }); return; }
    }
  }

  let parsedPrice: number | null = prev.price != null ? parseFloat(String(prev.price)) : null;
  if ("price" in body) {
    if (body.price == null || body.price === "") {
      parsedPrice = null;
    } else {
      parsedPrice = parseFloat(String(body.price));
      if (isNaN(parsedPrice) || parsedPrice < 0) { res.status(400).json({ error: "price must be a non-negative number" }); return; }
    }
  }

  let curr = prev.currency;
  if ("currency" in body) {
    curr = typeof body.currency === "string" ? body.currency.toUpperCase() : "AED";
    if (!["AED", "USD"].includes(curr)) { res.status(400).json({ error: "currency must be AED or USD" }); return; }
  }

  const supplierItemName = "supplier_item_name" in body ? (body.supplier_item_name ? String(body.supplier_item_name).trim() || null : null) : prev.supplier_item_name;
  const supplierItemCode = "supplier_item_code" in body ? (body.supplier_item_code ? String(body.supplier_item_code).trim() || null : null) : prev.supplier_item_code;
  let pricingUomCode = prev.pricing_uom_code;
  let pricingUomCompatibility = prev.pricing_uom;
  const pricingUomInput = parsePricingUomInput(body);
  if ("error" in pricingUomInput) {
    res.status(400).json({ error: pricingUomInput.error });
    return;
  }
  if (pricingUomInput.provided && pricingUomInput.code) {
    const canonicalUom = await findAvailableSupplierPricingUom(pricingUomInput.code);
    if (!canonicalUom) {
      res.status(400).json({ error: "pricing_uom_code must be an active canonical supplier pricing UOM code" });
      return;
    }
    pricingUomCode = canonicalUom.code;
    pricingUomCompatibility = canonicalUom.display_name;
  } else if (pricingUomInput.provided && !pricingUomInput.code && prev.pricing_uom_code) {
    // An explicit clear removes a canonical selection, but never silently drops
    // unresolved legacy text. Legacy values remain until canonical replacement.
    pricingUomCode = null;
    pricingUomCompatibility = null;
  }
  const isPreferred = "is_preferred" in body ? body.is_preferred === true : prev.is_preferred;
  const isDefaultOrderUnit = "is_default_order_unit" in body ? body.is_default_order_unit === true : prev.is_default_order_unit;

  // name_ar: only written when explicitly provided in the body
  // A user-supplied value always sets name_ar_source = 'manual'.
  // Omitting name_ar from the body leaves the stored value untouched.
  // name_ar_source = 'manual' rows are never overwritten by automated paths.
  let nameAr: string | null = prev.name_ar;
  let nameArSource: string | null = prev.name_ar_source;
  if ("name_ar" in body) {
    const supplied = body.name_ar != null && String(body.name_ar).trim() !== ""
      ? String(body.name_ar).trim()
      : null;
    nameAr = supplied;
    nameArSource = supplied != null ? "manual" : nameArSource;
  }

  await db.query(
    `UPDATE base_item_suppliers
       SET supplier_id = $1, package_id = $2, supplier_item_name = $3, supplier_item_code = $4,
            pricing_uom_code = $5, pricing_uom = $6, price = $7, currency = $8,
            is_preferred = $9, is_default_order_unit = $10,
            name_ar = $11, name_ar_source = $12
      WHERE id = $13`,
    [supplierId, packageId, supplierItemName, supplierItemCode, pricingUomCode, pricingUomCompatibility, parsedPrice, curr, isPreferred, isDefaultOrderUnit, nameAr, nameArSource, linkId],
  );

  const full = await db.query<BaseItemSupplierRow>(
    `${BASE_ITEM_SUPPLIER_SELECT} WHERE bis.id = $1`,
    [linkId],
  );
  res.json({ supplier: full.rows[0] });
});

/**
 * DELETE /api/base-items/:id/suppliers/:supplierId
 */
router.delete("/base-items/:id/suppliers/:supplierId", async (req, res) => {
  const wreq = workspace(req);
  if (!canManage(wreq)) { res.status(403).json({ error: "Insufficient permissions" }); return; }

  const id = parseInt(req.params.id, 10);
  const linkId = parseInt(req.params.supplierId, 10);
  if (isNaN(id) || isNaN(linkId)) { res.status(400).json({ error: "Invalid id" }); return; }

  const check = await db.query(
    `SELECT id FROM base_item_suppliers WHERE id = $1 AND base_item_id = $2 AND workspace_owner_id = $3`,
    [linkId, id, wreq.workspaceOwnerId],
  );
  if (check.rowCount === 0) { res.status(404).json({ error: "Supplier link not found" }); return; }

  await db.query(`DELETE FROM base_item_suppliers WHERE id = $1`, [linkId]);
  res.json({ ok: true });
});

// ─── Base Item Stock Adjustments ──────────────────────────────────────────

const VALID_REASONS = ["receive", "remove", "damage", "correction", "return", "other"] as const;
type AdjustmentReason = typeof VALID_REASONS[number];

type StockAdjustmentRow = {
  id: number;
  workspace_owner_id: string;
  base_item_id: number;
  quantity_change: string;
  reason: AdjustmentReason;
  movement_type: string | null;
  note: string | null;
  stock_after: string;
  created_by_user_id: string | null;
  created_at: string;
  location_id: number | null;
  location_name?: string | null;
  country?: string | null;
  transfer_id: number | null;
  from_location_id?: number | null;
  from_location_name?: string | null;
  to_location_id?: number | null;
  to_location_name?: string | null;
  purchase_order_id: number | null;
  po_number_label: string | null;
};

/**
 * GET /api/base-items/:id/inventory-overview
 * Country-grouped inventory summary with effective threshold inheritance,
 * low-stock/out-of-stock location counts, and suggested reorder actions.
 */
router.get("/base-items/:id/inventory-overview", async (req, res) => {
  const wreq = workspace(req);
  if (!canView(wreq)) { res.status(403).json({ error: "Viewing base item inventory requires owner access or the View/Manage base items permission" }); return; }
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid base item id" }); return; }

  const check = await db.query(
    `SELECT id FROM base_items WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (check.rowCount === 0) { res.status(404).json({ error: "Base item not found" }); return; }

  // Load all locations with stock data
  const locsResult = await db.query<{
    location_id: number; location_name: string; country: string;
    is_active: boolean; stock: string; low_stock_threshold: string;
  }>(
    `SELECT l.id AS location_id, l.name AS location_name,
            COALESCE(l.country, '') AS country,
            COALESCE(bils.is_active, true) AS is_active,
            COALESCE(bils.stock, 0) AS stock,
            COALESCE(bils.low_stock_threshold, 0) AS low_stock_threshold
       FROM locations l
       LEFT JOIN base_item_location_statuses bils
         ON bils.location_id = l.id AND bils.base_item_id = $1
      WHERE l.workspace_owner_id = $2
      ORDER BY l.country ASC, l.name ASC`,
    [id, wreq.workspaceOwnerId],
  );

  // Load country thresholds
  const thresholdsResult = await db.query<{
    id: number; base_item_id: number; country: string;
    default_low_stock_threshold: string; created_at: string; updated_at: string;
  }>(
    `SELECT * FROM base_item_country_thresholds WHERE base_item_id = $1`,
    [id],
  );
  const thresholdMap = new Map<string, number>(
    thresholdsResult.rows.map(t => [t.country, Number(t.default_low_stock_threshold)]),
  );

  // Group locations by country
  type CountrySummary = {
    country: string;
    total_stock: number;
    active_location_count: number;
    low_stock_location_count: number;
    out_of_stock_location_count: number;
    status: "in_stock" | "low_stock" | "out_of_stock" | "alert_disabled";
  };

  const countryMap = new Map<string, CountrySummary>();
  let globalTotal = 0;
  const suggestedActions: Array<{
    location_id: number; location_name: string; country: string;
    stock: number; effective_threshold: number; deficit: number;
  }> = [];

  for (const loc of locsResult.rows) {
    const stock = Number(loc.stock);
    const locThreshold = Number(loc.low_stock_threshold);
    const country = loc.country;
    const countryDefault = thresholdMap.get(country) ?? 0;
    const effectiveThreshold = locThreshold > 0 ? locThreshold : countryDefault;

    if (!countryMap.has(country)) {
      countryMap.set(country, {
        country,
        total_stock: 0,
        active_location_count: 0,
        low_stock_location_count: 0,
        out_of_stock_location_count: 0,
        status: "in_stock",
      });
    }
    const cs = countryMap.get(country)!;

    if (loc.is_active) {
      cs.total_stock += stock;
      cs.active_location_count += 1;
      globalTotal += stock;

      if (stock === 0) {
        cs.out_of_stock_location_count += 1;
      } else if (effectiveThreshold > 0 && stock <= effectiveThreshold) {
        cs.low_stock_location_count += 1;
        suggestedActions.push({
          location_id: loc.location_id,
          location_name: loc.location_name,
          country,
          stock,
          effective_threshold: effectiveThreshold,
          deficit: Math.max(0, effectiveThreshold - stock + 1),
        });
      }
    }
  }

  // Track per-country: whether any active location has a non-zero effective threshold
  const countryHasAnyThreshold = new Map<string, boolean>();
  for (const loc of locsResult.rows) {
    if (!loc.is_active) continue;
    const locThreshold = Number(loc.low_stock_threshold);
    const countryDefault = thresholdMap.get(loc.country) ?? 0;
    const effectiveThreshold = locThreshold > 0 ? locThreshold : countryDefault;
    if (effectiveThreshold > 0) {
      countryHasAnyThreshold.set(loc.country, true);
    } else if (!countryHasAnyThreshold.has(loc.country)) {
      countryHasAnyThreshold.set(loc.country, false);
    }
  }

  // Compute per-country status
  for (const cs of countryMap.values()) {
    const anyThresholdSet = countryHasAnyThreshold.get(cs.country) ?? false;
    if (cs.active_location_count === 0 || !anyThresholdSet) {
      cs.status = "alert_disabled";
    } else if (cs.out_of_stock_location_count === cs.active_location_count) {
      cs.status = "out_of_stock";
    } else if (cs.low_stock_location_count > 0 || cs.out_of_stock_location_count > 0) {
      cs.status = "low_stock";
    } else {
      cs.status = "in_stock";
    }
  }

  res.json({
    countries: Array.from(countryMap.values()),
    global_total: globalTotal,
    locations: locsResult.rows.map(l => ({
      ...l,
      stock: Number(l.stock),
      low_stock_threshold: Number(l.low_stock_threshold),
    })),
    country_thresholds: thresholdsResult.rows.map(t => ({
      ...t,
      default_low_stock_threshold: Number(t.default_low_stock_threshold),
    })),
    suggested_actions: suggestedActions,
  });
});

/**
 * GET /api/base-items/:id/country-thresholds
 * List country-level default low-stock thresholds.
 */
router.get("/base-items/:id/country-thresholds", async (req, res) => {
  const wreq = workspace(req);
  if (!canView(wreq)) { res.status(403).json({ error: "Viewing base item inventory requires owner access or the View/Manage base items permission" }); return; }
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid base item id" }); return; }

  const check = await db.query(
    `SELECT id FROM base_items WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (check.rowCount === 0) { res.status(404).json({ error: "Base item not found" }); return; }

  const result = await db.query(
    `SELECT * FROM base_item_country_thresholds WHERE base_item_id = $1 ORDER BY country ASC`,
    [id],
  );
  res.json({ thresholds: result.rows.map((t: { default_low_stock_threshold: string }) => ({
    ...t,
    default_low_stock_threshold: Number(t.default_low_stock_threshold),
  })) });
});

/**
 * PUT /api/base-items/:id/country-thresholds/:country
 * Upsert the default low-stock threshold for a specific country.
 * Requires manage permission.
 */
router.put("/base-items/:id/country-thresholds/:country", async (req, res) => {
  const wreq = workspace(req);
  if (!canManage(wreq)) {
    res.status(403).json({ error: "Managing base items requires owner access or the Manage base items permission" });
    return;
  }

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid base item id" }); return; }

  const country = req.params.country?.trim();
  if (!country) { res.status(400).json({ error: "country is required" }); return; }

  const { default_low_stock_threshold } = req.body ?? {};
  const threshold = parseFloat(String(default_low_stock_threshold ?? ""));
  if (isNaN(threshold) || threshold < 0) {
    res.status(400).json({ error: "default_low_stock_threshold must be a non-negative number" });
    return;
  }

  const check = await db.query(
    `SELECT id FROM base_items WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (check.rowCount === 0) { res.status(404).json({ error: "Base item not found" }); return; }

  const result = await db.query<{
    id: number; base_item_id: number; country: string;
    default_low_stock_threshold: string; created_at: string; updated_at: string;
  }>(
    `INSERT INTO base_item_country_thresholds (base_item_id, country, default_low_stock_threshold, created_at, updated_at)
     VALUES ($1, $2, $3, now(), now())
     ON CONFLICT (base_item_id, country)
     DO UPDATE SET default_low_stock_threshold = EXCLUDED.default_low_stock_threshold, updated_at = now()
     RETURNING *`,
    [id, country, threshold],
  );
  const row = result.rows[0];
  res.json({ ...row, default_low_stock_threshold: Number(row.default_low_stock_threshold) });
});

/**
 * POST /api/base-items/:id/transfers
 * Atomically transfer stock from one active location to another (same country).
 * Requires manage permission.
 */
router.post("/base-items/:id/transfers", async (req, res) => {
  const wreq = workspace(req);
  if (!canManage(wreq)) {
    res.status(403).json({ error: "Managing base items requires owner access or the Manage base items permission" });
    return;
  }

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid base item id" }); return; }

  const check = await db.query<{ id: number; inventory_allow_negative_stock: boolean }>(
    `SELECT bi.id,
            COALESCE(ws.inventory_allow_negative_stock, false) AS inventory_allow_negative_stock
       FROM base_items bi
       LEFT JOIN workspace_settings ws ON ws.workspace_owner_id = bi.workspace_owner_id
      WHERE bi.id = $1 AND bi.workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (check.rowCount === 0) { res.status(404).json({ error: "Base item not found" }); return; }

  const {
    from_location_id,
    to_location_id,
    quantity,
    reason,
    note,
    transfer_action_id,
  } = req.body ?? {};
  const fromId = parseInt(String(from_location_id ?? ""), 10);
  const toId = parseInt(String(to_location_id ?? ""), 10);
  const qty = parseFloat(String(quantity ?? ""));

  if (isNaN(fromId) || isNaN(toId)) {
    res.status(400).json({ error: "from_location_id and to_location_id must be integers" });
    return;
  }
  if (fromId === toId) {
    res.status(400).json({ error: "from_location_id and to_location_id must be different" });
    return;
  }
  if (isNaN(qty) || qty <= 0) {
    res.status(400).json({ error: "quantity must be a positive number" });
    return;
  }
  if (!reason || typeof reason !== "string" || !reason.trim()) {
    res.status(400).json({ error: "reason is required" });
    return;
  }
  const parsedActionId = z.string().uuid().safeParse(transfer_action_id);
  if (!parsedActionId.success) {
    res.status(400).json({ error: "transfer_action_id is required and must be a UUID" });
    return;
  }
  const transferActionId = parsedActionId.data;

  // Validate both locations belong to this base item, are active, and share same country
  const locResult = await db.query<{
    location_id: number; location_name: string; country: string; stock: string;
  }>(
    `SELECT bils.location_id, l.name AS location_name, COALESCE(l.country, '') AS country, bils.stock
       FROM base_item_location_statuses bils
       JOIN locations l ON l.id = bils.location_id
      WHERE bils.base_item_id = $1
        AND bils.location_id = ANY($2::int[])
        AND bils.is_active = true
        AND l.workspace_owner_id = $3`,
    [id, [fromId, toId], wreq.workspaceOwnerId],
  );

  const fromRow = locResult.rows.find(r => r.location_id === fromId);
  const toRow = locResult.rows.find(r => r.location_id === toId);

  if (!fromRow || !toRow) {
    // Determine which workspace locations actually exist so we can tell the
    // caller whether the offending ID is unknown to this workspace or simply
    // not an active location for this base item.
    const existResult = await db.query<{ id: number }>(
      `SELECT id FROM locations WHERE id = ANY($1::int[]) AND workspace_owner_id = $2`,
      [[fromId, toId], wreq.workspaceOwnerId],
    );
    const existingIds = new Set(existResult.rows.map(r => r.id));

    const describe = (field: string, locationId: number) =>
      existingIds.has(locationId)
        ? `${field} (location ${locationId}) exists but is not an active location for this base item`
        : `${field} (location ${locationId}) does not exist in this workspace`;

    if (!fromRow) {
      res.status(400).json({ error: describe("from_location_id", fromId) });
      return;
    }
    if (!toRow) {
      res.status(400).json({ error: describe("to_location_id", toId) });
      return;
    }
  }
  if (fromRow.country !== toRow.country) {
    res.status(400).json({
      error: `Cross-country transfers are not allowed (${fromRow.country} → ${toRow.country}). Both locations must be in the same country.`,
    });
    return;
  }

  const trimmedNote = note ? String(note).trim() || null : null;
  const country = fromRow.country;
  const allowNegativeStock = check.rows[0].inventory_allow_negative_stock === true;
  const payloadHash = createHash("sha256")
    .update(JSON.stringify({
      baseItemId: id,
      fromLocationId: fromId,
      toLocationId: toId,
      quantity: qty,
      reason: reason.trim(),
      note: trimmedNote,
    }))
    .digest("hex");

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // Claim the client action before touching stock. The unique index makes
    // concurrent retries coalesce into the original transfer.
    const transferResult = await client.query<{ id: number }>(
      `INSERT INTO base_item_stock_transfers
         (workspace_owner_id, base_item_id, country, from_location_id, to_location_id, quantity, reason,
          note, performed_by_user_id, idempotency_key, payload_hash, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
       ON CONFLICT (workspace_owner_id, idempotency_key)
         WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        wreq.workspaceOwnerId,
        id,
        country,
        fromId,
        toId,
        qty,
        reason.trim(),
        trimmedNote,
        wreq.userId,
        transferActionId,
        payloadHash,
      ],
    );
    if (transferResult.rowCount === 0) {
      const existingTransfer = await client.query<{
        id: number;
        payload_hash: string;
      }>(
        `SELECT id, payload_hash
           FROM base_item_stock_transfers
          WHERE workspace_owner_id = $1 AND idempotency_key = $2
          FOR UPDATE`,
        [wreq.workspaceOwnerId, transferActionId],
      );
      const existing = existingTransfer.rows[0];
      if (!existing || existing.payload_hash !== payloadHash) {
        await client.query("ROLLBACK");
        res.status(409).json({
          error: "transfer_action_id already used with a different payload",
          transfer_id: existing?.id,
        });
        return;
      }
      const balances = await db.query<{ location_id: number; stock: string }>(
        `SELECT location_id, stock::text
           FROM base_item_location_statuses
          WHERE base_item_id = $1 AND location_id = ANY($2::int[])`,
        [id, [fromId, toId]],
      );
      const byLocation = new Map(balances.rows.map((row) => [row.location_id, Number(row.stock)]));
      await client.query("ROLLBACK");
      res.status(200).json({
        ok: true,
        transfer_id: existing.id,
        from_stock_after: byLocation.get(fromId) ?? Number(fromRow.stock),
        to_stock_after: byLocation.get(toId) ?? Number(toRow.stock),
        idempotent: true,
      });
      return;
    }
    const transferId = transferResult.rows[0].id;

    // Post transfer_out and transfer_in via InventoryService
    const outbound = await postMovement(client, {
      workspaceOwnerId: wreq.workspaceOwnerId,
      baseItemId: id,
      locationId: fromId,
      quantityChange: -qty,
      reason: reason.trim(),
      movementType: "transfer_out",
      note: trimmedNote,
      createdByUserId: wreq.userId,
      transferId,
      idempotencyKey: `transfer-out:${transferId}`,
      inventoryAllowNegativeStock: allowNegativeStock,
      actorType: "user",
      actorId: wreq.userId,
      sourceType: "stock_transfer",
      sourceId: String(transferId),
      sourceLabelSnapshot: `${fromRow.location_name} → ${toRow.location_name}`,
      referenceType: "transfer",
      referenceId: String(transferId),
      referenceLabelSnapshot: reason.trim(),
      metadataSnapshot: {
        transferActionId,
        pairedMovement: "outbound",
        fromLocationId: fromId,
        toLocationId: toId,
        country,
      },
    });
    const inbound = await postMovement(client, {
      workspaceOwnerId: wreq.workspaceOwnerId,
      baseItemId: id,
      locationId: toId,
      quantityChange: qty,
      reason: reason.trim(),
      movementType: "transfer_in",
      note: trimmedNote,
      createdByUserId: wreq.userId,
      transferId,
      idempotencyKey: `transfer-in:${transferId}`,
      inventoryAllowNegativeStock: allowNegativeStock,
      actorType: "user",
      actorId: wreq.userId,
      sourceType: "stock_transfer",
      sourceId: String(transferId),
      sourceLabelSnapshot: `${fromRow.location_name} → ${toRow.location_name}`,
      referenceType: "transfer",
      referenceId: String(transferId),
      referenceLabelSnapshot: reason.trim(),
      metadataSnapshot: {
        transferActionId,
        pairedMovement: "inbound",
        fromLocationId: fromId,
        toLocationId: toId,
        country,
      },
    });

    await client.query("COMMIT");
    const fromStockAfter = outbound.stockAfter ?? Number(fromRow.stock) - qty;
    const toStockAfter = inbound.stockAfter ?? Number(toRow.stock) + qty;
    // Complete alert processing before finishing the request. The helper
    // suppresses notification failures, while awaiting it prevents background
    // database work from escaping the request lifecycle.
    // Only the from-location can cross into low stock (its stock was reduced).
    // The to-location gained stock, so it moves away from low-stock — no alert needed.
    await fireAndForgetLowStockAlert({
      workspaceOwnerId: wreq.workspaceOwnerId,
      baseItemId: id,
      locationId: fromId,
      locationStockBefore: fromStockAfter + qty,
      locationStockAfter: fromStockAfter,
    });
    res.status(201).json({ ok: true, transfer_id: transferId, from_stock_after: fromStockAfter, to_stock_after: toStockAfter });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err instanceof InventoryError && err.code === "INSUFFICIENT_STOCK") {
      res.status(400).json({ error: err.code, details: err.detail });
      return;
    }
    throw err;
  } finally {
    client.release();
  }
});

/**
 * GET /api/base-items/:id/adjustments
 * List recent stock adjustments (newest first, max 100). Supports optional
 * filtering by country, location_id, movement_type, date_from, date_to.
 */
router.get("/base-items/:id/adjustments", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid base item id" }); return; }

  const check = await db.query(
    `SELECT id FROM base_items WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (check.rowCount === 0) { res.status(404).json({ error: "Base item not found" }); return; }

  const params: (string | number)[] = [id, wreq.workspaceOwnerId];
  const filters: string[] = [];

  const countryFilter = req.query.country as string | undefined;
  if (countryFilter) {
    params.push(countryFilter);
    filters.push(`l.country = $${params.length}`);
  }

  const locationIdFilter = parseInt(String(req.query.location_id ?? ""), 10);
  if (!isNaN(locationIdFilter)) {
    params.push(locationIdFilter);
    filters.push(`a.location_id = $${params.length}`);
  }

  const movementTypeFilter = req.query.movement_type as string | undefined;
  if (movementTypeFilter) {
    params.push(movementTypeFilter);
    filters.push(`a.movement_type = $${params.length}`);
  }

  const dateFrom = req.query.date_from as string | undefined;
  if (dateFrom) {
    params.push(dateFrom);
    filters.push(`a.created_at >= $${params.length}::date`);
  }

  const dateTo = req.query.date_to as string | undefined;
  if (dateTo) {
    params.push(dateTo);
    filters.push(`a.created_at < ($${params.length}::date + interval '1 day')`);
  }

  const whereClause = filters.length > 0 ? `AND ${filters.join(" AND ")}` : "";

  const result = await db.query<StockAdjustmentRow>(
    `SELECT a.*,
            l.name AS location_name,
            COALESCE(l.country, '') AS country,
            po.id AS purchase_order_id,
            COALESCE(po.po_number, 'PO-' || LPAD(po.id::text, 4, '0')) AS po_number_label,
            t.from_location_id,
            fl.name AS from_location_name,
            t.to_location_id,
            tl.name AS to_location_name
       FROM base_item_stock_adjustments a
       JOIN locations l
         ON l.id = a.location_id
        AND l.workspace_owner_id = a.workspace_owner_id
       LEFT JOIN purchase_orders po ON po.id = a.purchase_order_id AND po.workspace_owner_id = a.workspace_owner_id
       LEFT JOIN base_item_stock_transfers t ON t.id = a.transfer_id
       LEFT JOIN locations fl ON fl.id = t.from_location_id
       LEFT JOIN locations tl ON tl.id = t.to_location_id
      WHERE a.base_item_id = $1 AND a.workspace_owner_id = $2
      ${whereClause}
      ORDER BY a.created_at DESC
      LIMIT 100`,
    params,
  );
  res.json({
    adjustments: result.rows.map((row) => ({
      ...row,
      quantity_change: Number(row.quantity_change),
      stock_after: Number(row.stock_after),
      stock_before: Number(row.stock_after) - Number(row.quantity_change),
    })),
  });
});

/**
 * POST /api/base-items/:id/adjustments
 * Record a stock adjustment. Uses InventoryService for atomic ledger + stock update.
 * Requires manage permission.
 * Body: { quantity_change, reason, note?, location_id, movement_type?, adjustment_action_id }
 */
router.post("/base-items/:id/adjustments", async (req, res) => {
  const wreq = workspace(req);
  if (!canManage(wreq)) {
    res.status(403).json({ error: "Managing base items requires owner access or the Manage base items permission" });
    return;
  }

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid base item id" }); return; }

  const existing = await db.query<{
    id: number;
    stock: string;
    inventory_allow_negative_stock: boolean;
  }>(
    `SELECT bi.id, bi.stock,
            COALESCE(ws.inventory_allow_negative_stock, false) AS inventory_allow_negative_stock
       FROM base_items bi
       LEFT JOIN workspace_settings ws ON ws.workspace_owner_id = bi.workspace_owner_id
      WHERE bi.id = $1 AND bi.workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (existing.rowCount === 0) { res.status(404).json({ error: "Base item not found" }); return; }

  const { quantity_change, reason, note, location_id, movement_type, adjustment_action_id } = req.body ?? {};

  const locationId = parseInt(String(location_id ?? ""), 10);
  if (isNaN(locationId)) {
    res.status(400).json({ error: "location_id is required and must be an integer" });
    return;
  }

  const quantityChange = parseFloat(String(quantity_change ?? ""));
  if (isNaN(quantityChange) || quantityChange === 0) {
    res.status(400).json({ error: "quantity_change must be a non-zero number" });
    return;
  }

  if (!VALID_REASONS.includes(reason as AdjustmentReason)) {
    res.status(400).json({
      error: `reason must be one of: ${VALID_REASONS.join(", ")}`,
    });
    return;
  }

  const parsedActionId = z.string().uuid().safeParse(adjustment_action_id);
  if (!parsedActionId.success) {
    res.status(400).json({ error: "adjustment_action_id is required and must be a UUID" });
    return;
  }
  const resolvedAdjActionId = parsedActionId.data;

  const trimmedNote = note ? String(note).trim() || null : null;
  const requestedMovementType = movement_type ? String(movement_type).trim() || null : null;
  const reasonMovementTypes: Record<AdjustmentReason, OperationalMovementType> = {
    receive: "manual_adjustment",
    remove: "manual_adjustment",
    damage: "waste_damage",
    correction: "inventory_count_correction",
    return: "customer_return",
    other: "manual_adjustment",
  };
  const allowedManualMovementTypes = new Set<OperationalMovementType>([
    "manual_adjustment",
    "waste_damage",
    "inventory_count_correction",
    "customer_return",
    "supplier_return",
  ]);
  const normalizedRequestedType =
    requestedMovementType === "manual"
      ? "manual_adjustment"
      : requestedMovementType;
  const operationalMovementType =
    normalizedRequestedType &&
    allowedManualMovementTypes.has(normalizedRequestedType as OperationalMovementType)
      ? (normalizedRequestedType as OperationalMovementType)
      : reasonMovementTypes[reason as AdjustmentReason];
  if (operationalMovementType === "waste_damage" && quantityChange > 0) {
    res.status(400).json({ error: "waste_damage quantity_change must be negative" });
    return;
  }
  if (operationalMovementType === "customer_return" && quantityChange < 0) {
    res.status(400).json({ error: "customer_return quantity_change must be positive" });
    return;
  }
  if (operationalMovementType === "supplier_return" && quantityChange > 0) {
    res.status(400).json({ error: "supplier_return quantity_change must be negative" });
    return;
  }

  const locationCheck = await db.query<{ location_id: number; stock: string; location_name: string }>(
    `SELECT bils.location_id, bils.stock, l.name AS location_name
       FROM base_item_location_statuses bils
       JOIN locations l ON l.id = bils.location_id
      WHERE bils.base_item_id = $1 AND bils.location_id = $2 AND bils.is_active = true
        AND l.workspace_owner_id = $3`,
    [id, locationId, wreq.workspaceOwnerId],
  );
  if (locationCheck.rowCount === 0) {
    res.status(400).json({ error: "location_id must refer to an active location for this base item" });
    return;
  }

  const currentLocationStock = parseFloat(String(locationCheck.rows[0].stock ?? "0"));
  const locationName = locationCheck.rows[0].location_name;

  const allowNegativeStock = existing.rows[0].inventory_allow_negative_stock === true;

  const idempotencyKey = `adj:${resolvedAdjActionId}`;

  const client = await db.connect();
  let insertedRow: StockAdjustmentRow | undefined;
  try {
    await client.query("BEGIN");

    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`${wreq.workspaceOwnerId}:${idempotencyKey}`],
    );

    // Check idempotency: if a row with this key already exists, return it
    const existing409 = await client.query<StockAdjustmentRow>(
      `SELECT * FROM base_item_stock_adjustments
        WHERE workspace_owner_id = $1 AND idempotency_key = $2`,
      [wreq.workspaceOwnerId, idempotencyKey],
    );
    if (existing409.rowCount! > 0) {
      await client.query("ROLLBACK");
      const row = existing409.rows[0];
      const samePayload =
        row.base_item_id === id &&
        row.location_id === locationId &&
        Number(row.quantity_change) === quantityChange &&
        row.reason === reason &&
        row.movement_type === operationalMovementType &&
        (row.note ?? null) === trimmedNote;
      if (!samePayload) {
        res.status(409).json({
          error: "adjustment_action_id already used with a different payload",
          adjustment_id: row.id,
        });
        return;
      }
      const total = await db.query<{ stock: string }>(
        `SELECT stock FROM base_items WHERE id = $1 AND workspace_owner_id = $2`,
        [id, wreq.workspaceOwnerId],
      );
      res.status(200).json({
        adjustment: { ...row, location_name: locationName },
        stock: parseFloat(total.rows[0]?.stock ?? "0"),
        previous_quantity: currentLocationStock,
        new_quantity: parseFloat(String(row.stock_after ?? "0")),
        idempotent: true,
      });
      return;
    }

    const movement = await postMovement(client, {
      workspaceOwnerId: wreq.workspaceOwnerId,
      baseItemId: id,
      locationId,
      quantityChange,
      reason,
      movementType: operationalMovementType,
      note: trimmedNote,
      createdByUserId: wreq.userId,
      adjustmentActionId: resolvedAdjActionId,
      idempotencyKey,
      inventoryAllowNegativeStock: allowNegativeStock,
      actorType: "user",
      actorId: wreq.userId,
      sourceType: "stock_adjustment",
      sourceId: resolvedAdjActionId,
      sourceLabelSnapshot: `${operationalMovementType}: ${reason}`,
      referenceType: "stock_adjustment",
      referenceId: resolvedAdjActionId,
      referenceLabelSnapshot: reason,
      metadataSnapshot: {
        requestedMovementType: requestedMovementType ?? null,
        normalizedMovementType: operationalMovementType,
        reason,
      },
    });

    const rowResult = await client.query<StockAdjustmentRow>(
      `SELECT * FROM base_item_stock_adjustments
        WHERE workspace_owner_id = $1 AND idempotency_key = $2`,
      [wreq.workspaceOwnerId, idempotencyKey],
    );
    insertedRow = rowResult.rows[0];

    if (!movement.posted) {
      const row = insertedRow;
      const samePayload =
        row != null &&
        row.base_item_id === id &&
        row.location_id === locationId &&
        Number(row.quantity_change) === quantityChange &&
        row.reason === reason &&
        row.movement_type === operationalMovementType &&
        (row.note ?? null) === trimmedNote;
      await client.query("ROLLBACK");
      if (!samePayload) {
        res.status(409).json({
          error: "adjustment_action_id already used with a different payload",
          adjustment_id: row?.id,
        });
        return;
      }
      res.status(200).json({
        adjustment: { ...row, location_name: locationName },
        stock: parseFloat(existing.rows[0]?.stock ?? "0"),
        previous_quantity: currentLocationStock,
        new_quantity: parseFloat(String(row?.stock_after ?? currentLocationStock)),
        idempotent: true,
      });
      return;
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    if (err instanceof InventoryError && err.code === "INSUFFICIENT_STOCK") {
      res.status(400).json({ error: err.code, details: err.detail });
      return;
    }
    throw err;
  } finally {
    client.release();
  }

  const locationStockAfter = parseFloat(String(insertedRow?.stock_after ?? (currentLocationStock + quantityChange)));
  const totalResult = await db.query<{ stock: string }>(
    `SELECT stock FROM base_items WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  const totalStock = parseFloat(totalResult.rows[0]?.stock ?? "0");

  // Keep notification database work inside the request lifecycle. Delivery
  // and lookup failures are suppressed by the helper and never affect stock.
  await fireAndForgetLowStockAlert({
    workspaceOwnerId: wreq.workspaceOwnerId,
    baseItemId: id,
    locationId: locationId,
    locationStockBefore: currentLocationStock,
    locationStockAfter: locationStockAfter,
  });

  res.status(201).json({
    adjustment: { ...(insertedRow ?? {}), location_name: locationName },
    stock: totalStock,
    previous_quantity: currentLocationStock,
    new_quantity: locationStockAfter,
  });
});

/**
 * POST /api/base-items/:id/duplicate
 * Clone a base item as "Copy of [Name]". Returns the new item id.
 */
router.post("/base-items/:id/duplicate", async (req, res) => {
  const wreq = workspace(req);
  if (!canCreate(wreq)) {
    res.status(403).json({ error: "Creating base items requires owner access or the Manage or Create base items permission" });
    return;
  }

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid base item id" });
    return;
  }

  const existing = await db.query<BaseItemRow>(
    `SELECT * FROM base_items WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (existing.rowCount === 0) {
    res.status(404).json({ error: "Base item not found" });
    return;
  }
  const src = existing.rows[0];

  const newName = `Copy of ${src.name}`;
  const code = await generateUniqueCode(wreq.workspaceOwnerId);
  const result = await db.query<BaseItemRow>(
    `INSERT INTO base_items
       (workspace_owner_id, name, code, image_url, category_id,
        alternate_name, accounting_category, tax_rate, tax_category, stock, low_stock_threshold, type, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'active')
     RETURNING id, name, code`,
    [
      wreq.workspaceOwnerId, newName, code,
      src.image_url, src.category_id,
      src.alternate_name, src.accounting_category, src.tax_rate,
      src.tax_category ?? "not_classified",
      src.stock, src.low_stock_threshold,
      (src as unknown as { type?: string | null }).type ?? null,
    ],
  );

  try {
    await appendAuditLog(
      wreq.workspaceOwnerId, wreq.userId, "duplicate", [id],
      null, { new_id: result.rows[0].id },
    );
  } catch (auditErr) {
    req.log.error({ err: auditErr, sourceId: id, newId: result.rows[0].id }, "duplicate audit log INSERT failed; duplicate itself succeeded");
  }

  // The clone shares the source's private image URL — give it its own public
  // copy so the website can render the duplicate too (fire-and-forget).
  if (src.image_url) {
    void syncBaseItemPublicImage(result.rows[0].id, src.image_url, wreq.workspaceOwnerId);
  }

  res.status(201).json({ item: result.rows[0] });
});

/**
 * GET /api/base-items/:id/usage
 * Return products that reference this base item via product_recipes.
 */
router.get("/base-items/:id/usage", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid base item id" });
    return;
  }

  const check = await db.query(
    `SELECT id FROM base_items WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (check.rowCount === 0) {
    res.status(404).json({ error: "Base item not found" });
    return;
  }

  const result = await db.query<{
    product_id: number;
    product_name: string;
    quantity: number;
    brand: string | null;
    status: string;
  }>(
    `SELECT p.id AS product_id, p.name AS product_name,
            pr.quantity,
            p.brand,
            p.status
       FROM product_recipes pr
       JOIN products p ON p.id = pr.product_id
      WHERE pr.base_item_id = $1
        AND pr.workspace_owner_id = $2
      ORDER BY p.name ASC`,
    [id, wreq.workspaceOwnerId],
  );

  res.json({ products: result.rows });
});

/**
 * GET /api/base-items/:id/audit-log
 * Returns paginated audit log entries where this item appears in affected_ids.
 * Accessible to owners and members with base_items.manage or base_items.view.
 */
router.get("/base-items/:id/audit-log", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid base item id" });
    return;
  }

  const check = await db.query(
    `SELECT id FROM base_items WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (check.rowCount === 0) {
    res.status(404).json({ error: "Base item not found" });
    return;
  }

  const rawPage = typeof req.query.page === "string" ? parseInt(req.query.page, 10) : 1;
  const rawLimit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : 25;
  const page = isNaN(rawPage) || rawPage < 1 ? 1 : rawPage;
  const limit = isNaN(rawLimit) || rawLimit < 1 ? 25 : Math.min(rawLimit, 50);
  const offset = (page - 1) * limit;

  type AuditLogRow = {
    id: number;
    action: string;
    user_id: string;
    affected_ids: number[];
    previous_values: unknown;
    new_values: unknown;
    created_at: string;
  };

  const [rows, countRow] = await Promise.all([
    db.query<AuditLogRow>(
      `SELECT id, action, user_id, affected_ids, previous_values, new_values, created_at
         FROM base_item_audit_log
        WHERE workspace_owner_id = $1
          AND affected_ids @> $2::jsonb
        ORDER BY created_at DESC
        LIMIT $3 OFFSET $4`,
      [wreq.workspaceOwnerId, JSON.stringify([id]), limit, offset],
    ),
    db.query<{ total: string }>(
      `SELECT COUNT(*) AS total
         FROM base_item_audit_log
        WHERE workspace_owner_id = $1
          AND affected_ids @> $2::jsonb`,
      [wreq.workspaceOwnerId, JSON.stringify([id])],
    ),
  ]);

  const total = parseInt(countRow.rows[0]?.total ?? "0", 10);

  // Resolve actor names from Clerk
  const userIds = [...new Set(rows.rows.map((r) => r.user_id).filter(Boolean))];
  const nameMap = new Map<string, string | null>();
  if (userIds.length > 0) {
    try {
      const clerkUsers = await clerkClient.users.getUserList({ userId: userIds, limit: 100 });
      for (const u of clerkUsers.data) {
        const parts = [u.firstName, u.lastName].filter(Boolean);
        nameMap.set(u.id, parts.length > 0 ? parts.join(" ") : null);
      }
    } catch (err) {
      logger.warn({ err }, "Failed to batch-fetch Clerk names for base item audit log");
    }
  }

  const entries = rows.rows.map((r) => ({
    id: r.id,
    action: r.action,
    user_id: r.user_id,
    actor_name: nameMap.get(r.user_id) ?? null,
    affected_ids: r.affected_ids,
    previous_values: r.previous_values ?? null,
    new_values: r.new_values ?? null,
    created_at: r.created_at,
  }));

  res.json({ entries, total, page, limit });
});

/**
 * GET /api/base-items/:id/invoices
 * List supplier invoices linked to this base item (reference_type = 'base_item').
 * Returns all-time and YTD spend totals. Accessible to owners and members with base_items.view or base_items.manage.
 */
router.get("/base-items/:id/invoices", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid base item id" });
    return;
  }

  const check = await db.query(
    `SELECT id FROM base_items WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (check.rowCount === 0) {
    res.status(404).json({ error: "Base item not found" });
    return;
  }

  type InvoiceRow = {
    id: number;
    supplier_id: number;
    supplier_name: string;
    amount: string;
    currency: string;
    status: string;
    invoice_number: string | null;
    issued_at: string;
    paid_at: string | null;
    notes: string | null;
    created_at: string;
  };

  const [invoicesResult, spendResult, spendYtdResult] = await Promise.all([
    db.query<InvoiceRow>(
      `SELECT si.id, si.supplier_id, s.name AS supplier_name,
              si.amount, si.currency, si.status, si.invoice_number,
              si.issued_at, si.paid_at, si.notes, si.created_at
         FROM supplier_invoices si
         JOIN suppliers s ON s.id = si.supplier_id
        WHERE si.reference_type = 'base_item'
          AND si.reference_id = $1
          AND si.workspace_owner_id = $2
        ORDER BY si.issued_at DESC`,
      [id, wreq.workspaceOwnerId],
    ),
    db.query<{ total_spend: string }>(
      `SELECT COALESCE(SUM(CASE WHEN status <> 'cancelled' THEN amount ELSE 0 END)::text, '0') AS total_spend
         FROM supplier_invoices
        WHERE reference_type = 'base_item'
          AND reference_id = $1
          AND workspace_owner_id = $2`,
      [id, wreq.workspaceOwnerId],
    ),
    db.query<{ spend_ytd: string }>(
      `SELECT COALESCE(SUM(CASE WHEN status <> 'cancelled' THEN amount ELSE 0 END)::text, '0') AS spend_ytd
         FROM supplier_invoices
        WHERE reference_type = 'base_item'
          AND reference_id = $1
          AND workspace_owner_id = $2
          AND issued_at >= date_trunc('year', NOW())`,
      [id, wreq.workspaceOwnerId],
    ),
  ]);

  res.json({
    invoices: invoicesResult.rows,
    invoice_count: invoicesResult.rowCount ?? 0,
    total_spend: spendResult.rows[0]?.total_spend ?? "0",
    spend_ytd: spendYtdResult.rows[0]?.spend_ytd ?? "0",
  });
});

/**
 * DELETE /api/base-items/:id
 * Permanently delete a base item. Owner-only. Records a `delete` audit entry
 * with a snapshot of the item before removing it (atomic).
 */
router.delete("/base-items/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!canDelete(wreq)) {
    res.status(403).json({ error: "Only the workspace owner can delete base items" });
    return;
  }

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid base item id" });
    return;
  }

  // Read a snapshot, write the audit record, and delete the row atomically so a
  // base item can never be removed without a matching `delete` audit entry.
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const snapshot = await client.query<{
      name: string;
      code: string | null;
      image_url: string | null;
      category_name: string | null;
    }>(
      `SELECT bi.name, bi.code, bi.image_url, sub_cat.name AS category_name
         FROM base_items bi
         LEFT JOIN base_item_categories sub_cat ON sub_cat.id = bi.category_id
        WHERE bi.id = $1 AND bi.workspace_owner_id = $2
        FOR UPDATE OF bi`,
      [id, wreq.workspaceOwnerId],
    );

    if (snapshot.rowCount === 0) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Base item not found" });
      return;
    }

    const row = snapshot.rows[0]!;
    const previousValues = {
      name: row.name,
      code: row.code ?? null,
      category: row.category_name ?? null,
      image_url: row.image_url ?? null,
    };

    await client.query(
      `INSERT INTO base_item_audit_log
         (workspace_owner_id, action, user_id, affected_ids, previous_values, new_values)
       VALUES ($1, 'delete', $2, $3, $4, NULL)`,
      [wreq.workspaceOwnerId, wreq.userId, JSON.stringify([id]), JSON.stringify(previousValues)],
    );

    await client.query(
      `DELETE FROM base_items WHERE id = $1 AND workspace_owner_id = $2`,
      [id, wreq.workspaceOwnerId],
    );

    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      req.log.error({ rollbackErr, id }, "Rollback failed after base item delete error");
    }
    req.log.error({ err, id }, "Base item delete transaction failed");
    throw err;
  } finally {
    client.release();
  }

  res.json({ ok: true });
});

// ── GET /api/base-items/:id/stock-movements ─────────────────────────────────
/**
 * Paginated stock movement ledger for a single base item.
 * Returns movements in reverse-chronological order with a correct running
 * balance (pre-cutover rows excluded from the window via CASE expression).
 *
 * Query params:
 *   page           (default 1)
 *   limit          (default 50, max 200)
 *   locationId     (integer, optional)
 *   movementType   (string, optional — 'purchase_received' maps to both 'receive' and 'purchase_order_receipt')
 *   from           (date YYYY-MM-DD, optional)
 *   to             (date YYYY-MM-DD, optional)
 *   tz             (IANA timezone, optional, default UTC)
 *   country        (string, optional)
 *   q              (string, optional — reference search)
 */
router.get("/base-items/:id/stock-movements", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid base item id" });
    return;
  }

  const resolvedQuery = resolveStockMovementQuery(
    req.query as Record<string, unknown>,
    wreq,
  );
  if (!resolvedQuery.ok) {
    res.status(resolvedQuery.status).json({ error: resolvedQuery.error });
    return;
  }
  const filters = resolvedQuery.filters;

  const check = await db.query(
    `SELECT id FROM base_items WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (check.rowCount === 0) {
    res.status(404).json({ error: "Base item not found" });
    return;
  }

  const page = filters.page;
  const limit = filters.limit;
  const offset = (page - 1) * limit;
  const tz = filters.tz;
  const fromRaw = filters.from;
  const toRaw = filters.to;

  // Build filter clauses.  Two strings share the same params array:
  //   countParts  — table-aliased expressions, used in the direct-join count query
  //   cteParts    — unqualified CTE column names, used in the outer SELECT … FROM all_rows
  const outerParams: unknown[] = [wreq.workspaceOwnerId, id];
  const countParts: string[] = [];
  const cteParts: string[] = [];
  const innerScopeParts: string[] = [];
  let permittedLocationsPosition: number | null = null;
  let locationPosition: number | null = null;
  let countryPosition: number | null = null;

  if (filters.permittedLocationIds) {
    const position = outerParams.length + 1;
    permittedLocationsPosition = position;
    countParts.push(`a.location_id = ANY($${position}::int[])`);
    cteParts.push(`location_id = ANY($${position}::int[])`);
    innerScopeParts.push(`a.location_id = ANY($${position}::int[])`);
    outerParams.push(filters.permittedLocationIds);
  }

  const filterLocationId = filters.locationId ?? null;
  if (filterLocationId !== null) {
    const position = outerParams.length + 1;
    locationPosition = position;
    countParts.push(`a.location_id = $${position}`);
    cteParts.push(`location_id = $${position}`);
    innerScopeParts.push(`a.location_id = $${position}`);
    outerParams.push(filterLocationId);
  }

  // Country filter: count uses l.country (joined); CTE projects it as location_country
  const rawCountry = filters.country;
  if (rawCountry) {
    const position = outerParams.length + 1;
    countryPosition = position;
    countParts.push(`l.country = $${position}`);
    cteParts.push(`location_country = $${position}`);
    innerScopeParts.push(`l.country = $${position}`);
    outerParams.push(rawCountry);
  }

  // Movement type filter — map 'purchase_received' to both legacy types
  const rawMovementType = filters.movementType;
  if (rawMovementType) {
    if (rawMovementType === "purchase_received") {
      countParts.push(`a.movement_type IN ('receive', 'purchase_order_receipt')`);
      cteParts.push(`movement_type IN ('receive', 'purchase_order_receipt')`);
    } else {
      countParts.push(`a.movement_type = $${outerParams.length + 1}`);
      cteParts.push(`movement_type = $${outerParams.length + 1}`);
      outerParams.push(rawMovementType);
    }
  }

  // Date range filter (inclusive from, exclusive to+1day, in user timezone)
  let fromUtc: string | null = null;
  let toUtc: string | null = null;
  if (fromRaw && /^\d{4}-\d{2}-\d{2}$/.test(fromRaw)) {
    countParts.push(`a.created_at >= ($${outerParams.length + 1}::date::timestamp AT TIME ZONE $${outerParams.length + 2})`);
    cteParts.push(`created_at >= ($${outerParams.length + 1}::date::timestamp AT TIME ZONE $${outerParams.length + 2})`);
    fromUtc = fromRaw;
    outerParams.push(fromRaw, tz);
  }
  if (toRaw && /^\d{4}-\d{2}-\d{2}$/.test(toRaw)) {
    countParts.push(`a.created_at < (($${outerParams.length + 1}::date + interval '1 day') AT TIME ZONE $${outerParams.length + 2})`);
    cteParts.push(`created_at < (($${outerParams.length + 1}::date + interval '1 day') AT TIME ZONE $${outerParams.length + 2})`);
    toUtc = toRaw;
    outerParams.push(toRaw, tz);
  }

  // Reference search: count uses table aliases; CTE outer uses projected column names
  const rawQ = filters.q;
  if (rawQ) {
    const qLike = `%${rawQ}%`;
    countParts.push(`(
      COALESCE(a.reference_label_snapshot, '') ILIKE $${outerParams.length + 1}
      OR a.id::text ILIKE $${outerParams.length + 1}
      OR COALESCE(a.reversal_of_id::text, '') ILIKE $${outerParams.length + 1}
      OR COALESCE(a.reference_id, '') ILIKE $${outerParams.length + 1}
      OR o.display_order_number ILIKE $${outerParams.length + 1}
      OR COALESCE(po.po_number, 'PO-' || LPAD(po.id::text, 4, '0')) ILIKE $${outerParams.length + 1}
      OR ('T-' || LPAD(t.id::text, 4, '0')) ILIKE $${outerParams.length + 1}
      OR p.name ILIKE $${outerParams.length + 1}
      OR a.reason ILIKE $${outerParams.length + 1}
      OR a.note ILIKE $${outerParams.length + 1}
    )`);
    cteParts.push(`(
      COALESCE(reference_label_snapshot, '') ILIKE $${outerParams.length + 1}
      OR id::text ILIKE $${outerParams.length + 1}
      OR COALESCE(reversal_of_id::text, '') ILIKE $${outerParams.length + 1}
      OR COALESCE(reference_id, '') ILIKE $${outerParams.length + 1}
      OR display_order_number ILIKE $${outerParams.length + 1}
      OR po_label ILIKE $${outerParams.length + 1}
      OR transfer_label ILIKE $${outerParams.length + 1}
      OR product_name ILIKE $${outerParams.length + 1}
      OR reason ILIKE $${outerParams.length + 1}
      OR note ILIKE $${outerParams.length + 1}
    )`);
    outerParams.push(qLike);
  }

  // countWhere: for the direct-join count query (table aliases valid)
  // outerWhere: for the CTE outer SELECT … FROM all_rows (unqualified column names)
  const countWhere = countParts.length > 0 ? `AND ${countParts.join(" AND ")}` : "";
  const outerWhere = cteParts.length > 0 ? `AND ${cteParts.join(" AND ")}` : "";
  const innerScopeWhere =
    innerScopeParts.length > 0 ? `AND ${innerScopeParts.join(" AND ")}` : "";

  // ── Summary: opening / received / consumed / closing ────────────────────
  // Opening balance per location = cutover_balance + SUM(post-cutover moves strictly before from)
  const summaryParams: unknown[] = [wreq.workspaceOwnerId, id];
  const openingScopeParts: string[] = [];

  // With no range start, the opening is the verified cutover balance itself;
  // post-cutover rows belong entirely to the current received/consumed window.
  let openingFromClause = "AND false";
  if (fromUtc) {
    openingFromClause = `AND a2.created_at < ($${summaryParams.length + 1}::date::timestamp AT TIME ZONE $${summaryParams.length + 2})`;
    summaryParams.push(fromUtc, tz);
  }

  if (filters.permittedLocationIds) {
    openingScopeParts.push(`ls.location_id = ANY($${summaryParams.length + 1}::int[])`);
    summaryParams.push(filters.permittedLocationIds);
  }
  if (filterLocationId !== null) {
    openingScopeParts.push(`ls.location_id = $${summaryParams.length + 1}`);
    summaryParams.push(filterLocationId);
  }
  if (rawCountry) {
    openingScopeParts.push(`l.country = $${summaryParams.length + 1}`);
    summaryParams.push(rawCountry);
  }
  const openingScopeWhere =
    openingScopeParts.length > 0 ? `AND ${openingScopeParts.join(" AND ")}` : "";

  const openingResult = await db.query<{ opening_balance: string }>(
    `SELECT COALESCE(SUM(
       ls.cutover_balance
       + COALESCE((
           SELECT SUM(
             CASE
               WHEN a2.cutover_baseline = false AND a2.created_at > ls.cutover_at
               THEN a2.quantity_change
               ELSE 0
             END
           )
           FROM base_item_stock_adjustments a2
           WHERE a2.workspace_owner_id = ls.workspace_owner_id
             AND a2.base_item_id = ls.base_item_id
             AND a2.location_id  = ls.location_id
             AND a2.ledger_scope = 'base_item_operational'
             ${openingFromClause}
         ), 0)
     ), 0) AS opening_balance
     FROM base_item_ledger_settings ls
      JOIN locations l
        ON l.id = ls.location_id
       AND l.workspace_owner_id = ls.workspace_owner_id
     WHERE ls.workspace_owner_id = $1
       AND ls.base_item_id = $2
        ${openingScopeWhere}`,
    summaryParams,
  );

  // In-range received/consumed
  const inRangeParams: unknown[] = [wreq.workspaceOwnerId, id];
  const inRangeParts: string[] = [];
  if (fromUtc) {
    inRangeParts.push(`a.created_at >= ($${inRangeParams.length + 1}::date::timestamp AT TIME ZONE $${inRangeParams.length + 2})`);
    inRangeParams.push(fromUtc, tz);
  }
  if (toUtc) {
    inRangeParts.push(`a.created_at < (($${inRangeParams.length + 1}::date + interval '1 day') AT TIME ZONE $${inRangeParams.length + 2})`);
    inRangeParams.push(toUtc, tz);
  }
  if (filters.permittedLocationIds) {
    inRangeParts.push(`a.location_id = ANY($${inRangeParams.length + 1}::int[])`);
    inRangeParams.push(filters.permittedLocationIds);
  }
  if (filterLocationId !== null) {
    inRangeParts.push(`a.location_id = $${inRangeParams.length + 1}`);
    inRangeParams.push(filterLocationId);
  }
  if (rawCountry) {
    inRangeParts.push(`l.country = $${inRangeParams.length + 1}`);
    inRangeParams.push(rawCountry);
  }
  if (rawMovementType) {
    if (rawMovementType === "purchase_received") {
      inRangeParts.push(`a.movement_type IN ('receive', 'purchase_order_receipt')`);
    } else {
      inRangeParts.push(`a.movement_type = $${inRangeParams.length + 1}`);
      inRangeParams.push(rawMovementType);
    }
  }
  if (rawQ) {
    inRangeParts.push(`(
      COALESCE(a.reference_label_snapshot, '') ILIKE $${inRangeParams.length + 1}
      OR a.id::text ILIKE $${inRangeParams.length + 1}
      OR COALESCE(a.reversal_of_id::text, '') ILIKE $${inRangeParams.length + 1}
      OR COALESCE(a.reference_id, '') ILIKE $${inRangeParams.length + 1}
      OR o.display_order_number ILIKE $${inRangeParams.length + 1}
      OR COALESCE(po.po_number, 'PO-' || LPAD(po.id::text, 4, '0')) ILIKE $${inRangeParams.length + 1}
      OR ('T-' || LPAD(t.id::text, 4, '0')) ILIKE $${inRangeParams.length + 1}
      OR p.name ILIKE $${inRangeParams.length + 1}
      OR a.reason ILIKE $${inRangeParams.length + 1}
      OR a.note ILIKE $${inRangeParams.length + 1}
    )`);
    inRangeParams.push(`%${rawQ}%`);
  }
  const inRangeWhere = inRangeParts.length > 0 ? `AND ${inRangeParts.join(" AND ")}` : "";

  const inRangeResult = await db.query<{ received: string; consumed: string }>(
    `SELECT
       COALESCE(SUM(CASE WHEN a.quantity_change > 0 AND NOT a.cutover_baseline THEN a.quantity_change ELSE 0 END), 0) AS received,
       COALESCE(SUM(CASE WHEN a.quantity_change < 0 AND NOT a.cutover_baseline THEN ABS(a.quantity_change) ELSE 0 END), 0) AS consumed
     FROM base_item_stock_adjustments a
     JOIN locations l
       ON l.id = a.location_id
      AND l.workspace_owner_id = a.workspace_owner_id
     LEFT JOIN orders o
       ON o.id::text = a.order_id
      AND o.workspace_owner_id = a.workspace_owner_id
     LEFT JOIN purchase_orders po
       ON po.id = a.purchase_order_id
      AND po.workspace_owner_id = a.workspace_owner_id
     LEFT JOIN base_item_stock_transfers t
       ON t.id = a.transfer_id
      AND t.base_item_id = a.base_item_id
     LEFT JOIN products p
       ON p.id = a.product_id
      AND p.workspace_owner_id = a.workspace_owner_id
     LEFT JOIN base_item_ledger_settings ls
            ON ls.workspace_owner_id = a.workspace_owner_id
           AND ls.base_item_id = a.base_item_id
           AND ls.location_id  = a.location_id
     WHERE a.workspace_owner_id = $1
         AND a.base_item_id = $2
         AND a.ledger_scope = 'base_item_operational'
         AND (ls.cutover_at IS NULL OR a.created_at >= ls.cutover_at OR a.cutover_baseline = true)
       ${inRangeWhere}`,
    inRangeParams,
  );

  const openingBalance = parseFloat(openingResult.rows[0]?.opening_balance ?? "0");
  const received  = parseFloat(inRangeResult.rows[0]?.received  ?? "0");
  const consumed  = parseFloat(inRangeResult.rows[0]?.consumed  ?? "0");
  const closingBalance = openingBalance + received - consumed;

  // ── Count (respects all outer filters including reference search) ─────────
  const countResult = await db.query<{ total: string }>(
    `SELECT COUNT(*) AS total
       FROM base_item_stock_adjustments a
       LEFT JOIN locations l ON l.id = a.location_id
       LEFT JOIN orders o ON o.id::text = a.order_id AND o.workspace_owner_id = a.workspace_owner_id
       LEFT JOIN purchase_orders po ON po.id = a.purchase_order_id AND po.workspace_owner_id = a.workspace_owner_id
       LEFT JOIN base_item_stock_transfers t
         ON t.id = a.transfer_id
        AND t.base_item_id = a.base_item_id
       LEFT JOIN products p
         ON p.id = a.product_id
        AND p.workspace_owner_id = a.workspace_owner_id
       LEFT JOIN base_item_ledger_settings ls
              ON ls.workspace_owner_id = a.workspace_owner_id
             AND ls.base_item_id = a.base_item_id
             AND ls.location_id  = a.location_id
      WHERE a.workspace_owner_id = $1
        AND a.base_item_id = $2
        AND a.ledger_scope = 'base_item_operational'
        AND (ls.cutover_at IS NULL OR a.created_at >= ls.cutover_at OR a.cutover_baseline = true)
        ${countWhere}`,
    outerParams,
  );
  const total = parseInt(countResult.rows[0]?.total ?? "0", 10);

  // ── Data rows with correct running balance window ─────────────────────────
  const dataParams = [...outerParams, limit, offset];
  const openingScopePartsForData: string[] = [];
  if (permittedLocationsPosition !== null) {
    openingScopePartsForData.push(
      `ls_scope.location_id = ANY($${permittedLocationsPosition}::int[])`,
    );
  }
  if (locationPosition !== null) {
    openingScopePartsForData.push(`ls_scope.location_id = $${locationPosition}`);
  }
  if (countryPosition !== null) {
    openingScopePartsForData.push(`l_scope.country = $${countryPosition}`);
  }
  const openingScopeWhereForData =
    openingScopePartsForData.length > 0
      ? `AND ${openingScopePartsForData.join(" AND ")}`
      : "";
  const runningBalanceExpression =
    filterLocationId === null
      ? `(SELECT opening_balance FROM scope_opening)
         + SUM(
             CASE
               WHEN a.cutover_baseline = false
                AND (ls.cutover_at IS NULL OR a.created_at > ls.cutover_at)
               THEN a.quantity_change
               ELSE 0
             END
           ) OVER (
             ORDER BY a.created_at ASC, a.id ASC
             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
           )`
      : `COALESCE(ls.cutover_balance, 0)
         + SUM(
             CASE
               WHEN a.cutover_baseline = false
                AND (ls.cutover_at IS NULL OR a.created_at > ls.cutover_at)
               THEN a.quantity_change
               ELSE 0
             END
           ) OVER (
             PARTITION BY a.base_item_id, a.location_id
             ORDER BY a.created_at ASC, a.id ASC
             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
           )`;
  const sortColumn: Record<StockMovementFilters["sortBy"], string> = {
    date: "created_at",
    type: "movement_type",
    reference: "reference_label",
    location: "location_name",
    quantity: "quantity_change",
    balance: "running_balance",
  };
  const orderBy = `${sortColumn[filters.sortBy]} ${filters.sortDirection.toUpperCase()} NULLS LAST, created_at DESC, id DESC`;

  const dataResult = await db.query<{
    id: number;
    created_at: string;
    quantity_change: string;
    running_balance: string;
    reason: string;
    note: string | null;
    movement_type: string | null;
    location_id: number | null;
    location_name: string | null;
    created_by_user_id: string | null;
    source_display_name: string | null;
    order_id: string | null;
    order_line_item_id: string | null;
    product_id: number | null;
    product_name: string | null;
    purchase_order_id: number | null;
    transfer_id: number | null;
    reversal_of_id: number | null;
    recipe_snapshot: object | null;
    cutover_baseline: boolean;
    idempotency_key: string | null;
    reference_label: string | null;
    display_order_number: string | null;
    po_label: string | null;
    transfer_label: string | null;
    source_type: string | null;
    source_id: string | null;
    source_label_snapshot: string | null;
    reference_type: string | null;
    reference_id: string | null;
    reference_label_snapshot: string | null;
    metadata_snapshot: object | null;
  }>(
    `WITH scope_opening AS (
       SELECT COALESCE(SUM(ls_scope.cutover_balance), 0) AS opening_balance
         FROM base_item_ledger_settings ls_scope
         JOIN locations l_scope
           ON l_scope.id = ls_scope.location_id
          AND l_scope.workspace_owner_id = ls_scope.workspace_owner_id
        WHERE ls_scope.workspace_owner_id = $1
          AND ls_scope.base_item_id = $2
          ${openingScopeWhereForData}
     ),
     all_rows AS (
       SELECT
         a.id,
         a.created_at,
         a.quantity_change,
         a.reason,
         a.note,
         a.movement_type,
         a.location_id,
         a.created_by_user_id,
         a.order_id,
         a.order_line_item_id,
         a.product_id,
         a.purchase_order_id,
         a.transfer_id,
         a.reversal_of_id,
         a.recipe_snapshot,
         a.cutover_baseline,
         a.idempotency_key,
          a.source_type,
          a.source_id,
          a.source_label_snapshot,
          a.reference_type,
          a.reference_id,
          a.reference_label_snapshot,
          a.metadata_snapshot,
         l.name AS location_name,
         COALESCE(l.country, '') AS location_country,
         p.name AS product_name,
         o.display_order_number,
         COALESCE(po.po_number, 'PO-' || LPAD(po.id::text, 4, '0')) AS po_label,
         CASE WHEN t.id IS NOT NULL THEN 'T-' || LPAD(t.id::text, 4, '0') ELSE NULL END AS transfer_label,
          COALESCE(
            a.actor_label_snapshot,
            wm.member_email,
            a.source_label_snapshot,
            'System'
          ) AS source_display_name,
         ls.cutover_balance,
         ls.cutover_at,
          ${runningBalanceExpression} AS running_balance
       FROM base_item_stock_adjustments a
        JOIN locations l
          ON l.id = a.location_id
         AND l.workspace_owner_id = a.workspace_owner_id
        LEFT JOIN products p
          ON p.id = a.product_id
         AND p.workspace_owner_id = a.workspace_owner_id
       LEFT JOIN orders o         ON o.id::text = a.order_id AND o.workspace_owner_id = a.workspace_owner_id
       LEFT JOIN purchase_orders po ON po.id = a.purchase_order_id AND po.workspace_owner_id = a.workspace_owner_id
        LEFT JOIN base_item_stock_transfers t
          ON t.id = a.transfer_id
         AND t.base_item_id = a.base_item_id
       LEFT JOIN workspace_members wm
              ON wm.member_user_id = a.created_by_user_id
             AND wm.workspace_owner_id = a.workspace_owner_id
       LEFT JOIN base_item_ledger_settings ls
              ON ls.base_item_id       = a.base_item_id
             AND ls.location_id        = a.location_id
             AND ls.workspace_owner_id = a.workspace_owner_id
        WHERE a.workspace_owner_id = $1
          AND a.base_item_id       = $2
          AND a.ledger_scope       = 'base_item_operational'
           ${innerScopeWhere}
     )
     SELECT
       id, created_at, quantity_change, running_balance,
       reason, note, movement_type,
       location_id, location_name, location_country,
       created_by_user_id, source_display_name,
       order_id, order_line_item_id,
       product_id, product_name,
       purchase_order_id, transfer_id, reversal_of_id,
       recipe_snapshot, cutover_baseline, idempotency_key,
        source_type, source_id, source_label_snapshot,
        reference_type, reference_id, reference_label_snapshot, metadata_snapshot,
       display_order_number, po_label, transfer_label,
       COALESCE(
          reference_label_snapshot,
         display_order_number,
         po_label,
         transfer_label,
         product_name,
         reason
       ) AS reference_label
     FROM all_rows
     WHERE (cutover_at IS NULL OR created_at >= cutover_at OR cutover_baseline = true)
       ${outerWhere}
      ORDER BY ${orderBy}
     LIMIT $${outerParams.length + 1} OFFSET $${outerParams.length + 2}`,
    dataParams,
  );

  res.json({
    movements: dataResult.rows,
    total,
    page,
    limit,
    summary: {
      openingBalance,
      received,
      consumed,
      closingBalance,
    },
  });
});

// ── GET /api/base-items/:id/stock-movements/export ───────────────────────────
/**
 * CSV export of the stock movement ledger (max 10 000 rows).
 * Accepts the same query params as the list endpoint (except page/limit).
 */
router.get("/base-items/:id/stock-movements/export", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid base item id" });
    return;
  }

  const resolvedQuery = resolveStockMovementQuery(
    req.query as Record<string, unknown>,
    wreq,
  );
  if (!resolvedQuery.ok) {
    res.status(resolvedQuery.status).json({ error: resolvedQuery.error });
    return;
  }
  const filters = resolvedQuery.filters;

  const check = await db.query(
    `SELECT id FROM base_items WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (check.rowCount === 0) {
    res.status(404).json({ error: "Base item not found" });
    return;
  }

  const tz = filters.tz;
  const fromRaw = filters.from;
  const toRaw = filters.to;

  // Export has no separate count query, so outerWhere uses unqualified CTE column names only.
  const outerParams: unknown[] = [wreq.workspaceOwnerId, id];
  const outerParts: string[] = [];
  const innerScopeParts: string[] = [];
  let permittedLocationsPosition: number | null = null;
  let locationPosition: number | null = null;
  let countryPosition: number | null = null;

  if (filters.permittedLocationIds) {
    const position = outerParams.length + 1;
    permittedLocationsPosition = position;
    outerParts.push(`location_id = ANY($${position}::int[])`);
    innerScopeParts.push(`a.location_id = ANY($${position}::int[])`);
    outerParams.push(filters.permittedLocationIds);
  }

  const filterLocationId = filters.locationId ?? null;
  if (filterLocationId !== null) {
    const position = outerParams.length + 1;
    locationPosition = position;
    outerParts.push(`location_id = $${position}`);
    innerScopeParts.push(`a.location_id = $${position}`);
    outerParams.push(filterLocationId);
  }

  // Country: CTE projects l.country as location_country
  const rawCountry = filters.country;
  if (rawCountry) {
    const position = outerParams.length + 1;
    countryPosition = position;
    outerParts.push(`location_country = $${position}`);
    innerScopeParts.push(`l.country = $${position}`);
    outerParams.push(rawCountry);
  }

  const rawMovementType = filters.movementType;
  if (rawMovementType) {
    if (rawMovementType === "purchase_received") {
      outerParts.push(`movement_type IN ('receive', 'purchase_order_receipt')`);
    } else {
      outerParts.push(`movement_type = $${outerParams.length + 1}`);
      outerParams.push(rawMovementType);
    }
  }

  if (fromRaw && /^\d{4}-\d{2}-\d{2}$/.test(fromRaw)) {
    outerParts.push(`created_at >= ($${outerParams.length + 1}::date::timestamp AT TIME ZONE $${outerParams.length + 2})`);
    outerParams.push(fromRaw, tz);
  }
  if (toRaw && /^\d{4}-\d{2}-\d{2}$/.test(toRaw)) {
    outerParts.push(`created_at < (($${outerParams.length + 1}::date + interval '1 day') AT TIME ZONE $${outerParams.length + 2})`);
    outerParams.push(toRaw, tz);
  }

  // Reference search — uses CTE-projected column names (no table aliases)
  const rawQ = filters.q;
  if (rawQ) {
    const qLike = `%${rawQ}%`;
    outerParts.push(`(
      COALESCE(reference_label_snapshot, '') ILIKE $${outerParams.length + 1}
      OR id::text ILIKE $${outerParams.length + 1}
      OR COALESCE(reversal_of_id::text, '') ILIKE $${outerParams.length + 1}
      OR COALESCE(reference_id, '') ILIKE $${outerParams.length + 1}
      OR display_order_number ILIKE $${outerParams.length + 1}
      OR po_label ILIKE $${outerParams.length + 1}
      OR transfer_label ILIKE $${outerParams.length + 1}
      OR product_name ILIKE $${outerParams.length + 1}
      OR reason ILIKE $${outerParams.length + 1}
      OR note ILIKE $${outerParams.length + 1}
    )`);
    outerParams.push(qLike);
  }

  const outerWhere = outerParts.length > 0 ? `AND ${outerParts.join(" AND ")}` : "";
  const innerScopeWhere =
    innerScopeParts.length > 0 ? `AND ${innerScopeParts.join(" AND ")}` : "";
  const openingScopeParts: string[] = [];
  if (permittedLocationsPosition !== null) {
    openingScopeParts.push(
      `ls_scope.location_id = ANY($${permittedLocationsPosition}::int[])`,
    );
  }
  if (locationPosition !== null) {
    openingScopeParts.push(`ls_scope.location_id = $${locationPosition}`);
  }
  if (countryPosition !== null) {
    openingScopeParts.push(`l_scope.country = $${countryPosition}`);
  }
  const openingScopeWhere =
    openingScopeParts.length > 0 ? `AND ${openingScopeParts.join(" AND ")}` : "";
  const runningBalanceExpression =
    filterLocationId === null
      ? `(SELECT opening_balance FROM scope_opening)
         + SUM(
             CASE
               WHEN a.cutover_baseline = false
                AND (ls.cutover_at IS NULL OR a.created_at > ls.cutover_at)
               THEN a.quantity_change
               ELSE 0
             END
           ) OVER (
             ORDER BY a.created_at ASC, a.id ASC
             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
           )`
      : `COALESCE(ls.cutover_balance, 0)
         + SUM(
             CASE
               WHEN a.cutover_baseline = false
                AND (ls.cutover_at IS NULL OR a.created_at > ls.cutover_at)
               THEN a.quantity_change
               ELSE 0
             END
           ) OVER (
             PARTITION BY a.base_item_id, a.location_id
             ORDER BY a.created_at ASC, a.id ASC
             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
           )`;
  const sortColumn: Record<StockMovementFilters["sortBy"], string> = {
    date: "created_at",
    type: "movement_type",
    reference: "reference_label",
    location: "location_name",
    quantity: "quantity_change",
    balance: "running_balance",
  };
  const orderBy = `${sortColumn[filters.sortBy]} ${filters.sortDirection.toUpperCase()} NULLS LAST, created_at DESC, id DESC`;

  const exportResult = await db.query<{
    created_at: string;
    movement_type: string | null;
    reference_label: string | null;
    location_name: string | null;
    quantity_change: string;
    running_balance: string;
    source_display_name: string | null;
    note: string | null;
  }>(
    `WITH scope_opening AS (
       SELECT COALESCE(SUM(ls_scope.cutover_balance), 0) AS opening_balance
         FROM base_item_ledger_settings ls_scope
         JOIN locations l_scope
           ON l_scope.id = ls_scope.location_id
          AND l_scope.workspace_owner_id = ls_scope.workspace_owner_id
        WHERE ls_scope.workspace_owner_id = $1
          AND ls_scope.base_item_id = $2
          ${openingScopeWhere}
     ),
     all_rows AS (
       SELECT
         a.id, a.created_at, a.quantity_change, a.reason, a.note,
         a.movement_type, a.location_id, a.created_by_user_id,
         a.order_id, a.purchase_order_id, a.transfer_id, a.product_id,
         a.cutover_baseline,
          a.reference_label_snapshot,
         l.name AS location_name,
         COALESCE(l.country, '') AS location_country,
         p.name AS product_name,
         o.display_order_number,
         COALESCE(po.po_number, 'PO-' || LPAD(po.id::text, 4, '0')) AS po_label,
         CASE WHEN t.id IS NOT NULL THEN 'T-' || LPAD(t.id::text, 4, '0') ELSE NULL END AS transfer_label,
          COALESCE(
            a.actor_label_snapshot,
            wm.member_email,
            a.source_label_snapshot,
            'System'
          ) AS source_display_name,
         ls.cutover_balance,
         ls.cutover_at,
          ${runningBalanceExpression} AS running_balance
       FROM base_item_stock_adjustments a
        JOIN locations l
          ON l.id = a.location_id
         AND l.workspace_owner_id = a.workspace_owner_id
        LEFT JOIN products p
          ON p.id = a.product_id
         AND p.workspace_owner_id = a.workspace_owner_id
       LEFT JOIN orders o ON o.id::text = a.order_id AND o.workspace_owner_id = a.workspace_owner_id
       LEFT JOIN purchase_orders po ON po.id = a.purchase_order_id AND po.workspace_owner_id = a.workspace_owner_id
        LEFT JOIN base_item_stock_transfers t
          ON t.id = a.transfer_id
         AND t.base_item_id = a.base_item_id
       LEFT JOIN workspace_members wm ON wm.member_user_id = a.created_by_user_id AND wm.workspace_owner_id = a.workspace_owner_id
       LEFT JOIN base_item_ledger_settings ls ON ls.base_item_id = a.base_item_id AND ls.location_id = a.location_id AND ls.workspace_owner_id = a.workspace_owner_id
        WHERE a.workspace_owner_id = $1
          AND a.base_item_id = $2
          AND a.ledger_scope = 'base_item_operational'
           ${innerScopeWhere}
     )
     SELECT
       created_at, movement_type, location_name, quantity_change, running_balance,
       source_display_name, note,
        COALESCE(
          reference_label_snapshot,
          display_order_number,
          po_label,
          transfer_label,
          product_name,
          reason
        ) AS reference_label
     FROM all_rows
     WHERE (cutover_at IS NULL OR created_at >= cutover_at OR cutover_baseline = true)
       ${outerWhere}
      ORDER BY ${orderBy}
     LIMIT 10000`,
    [...outerParams],
  );

  const csvRows: string[] = [
    ["Date", "Movement type", "Reference", "Location", "Quantity in", "Quantity out", "Running balance", "Source", "Notes"].join(","),
    ...exportResult.rows.map((r) => {
      const qty = parseFloat(r.quantity_change);
      const qtyIn  = qty > 0 ? qty.toString() : "";
      const qtyOut = qty < 0 ? Math.abs(qty).toString() : "";
      const balance = parseFloat(r.running_balance).toFixed(2);
      return [
        escapeCsvCell(new Date(r.created_at).toISOString()),
        escapeCsvCell(r.movement_type),
        escapeCsvTextCell(r.reference_label),
        escapeCsvTextCell(r.location_name),
        escapeCsvCell(qtyIn),
        escapeCsvCell(qtyOut),
        escapeCsvCell(balance),
        escapeCsvTextCell(r.source_display_name ?? "System"),
        escapeCsvTextCell(r.note),
      ].join(",");
    }),
  ];

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="stock-movements-${id}.csv"`);
  res.send(csvRows.join("\n"));
});

export default router;
