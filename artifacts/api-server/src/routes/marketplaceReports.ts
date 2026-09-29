import { Router } from "express";
import { createHash } from "crypto";
import multer from "multer";
import { z } from "zod";
import { Readable } from "stream";
import { db, withTransaction } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";
import { logger } from "../lib/logger";
import { objectStorageClient, ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { extractTotersPdf, normalizeMerchantName, levenshteinSimilarity } from "../lib/totersPdfExtractor";
import { storePdfToObjectStorage, runExtractionAndMatching } from "./marketplaceWebhook";

const router = Router();

router.use(requireAuth, resolveWorkspace);

const MAX_PDF_SIZE = 20 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PDF_SIZE },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === "application/pdf") {
      cb(null, true);
    } else {
      cb(new Error("Only PDF files are accepted"));
    }
  },
});

function isOwner(wreq: ReturnType<typeof workspace>): boolean {
  return wreq.workspaceRole === "owner";
}

const patchImportSchema = z.object({
  detected_merchant_name: z.string().max(500).optional(),
  detected_brand_id: z.number().int().positive().nullable().optional(),
  detected_location_id: z.number().int().positive().nullable().optional(),
  report_period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  report_period_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  marketplace: z.string().max(100).optional(),
  import_status: z.enum(["pending", "needs_review", "ready_to_approve", "rejected"]).optional(),
  notes: z.string().max(2000).optional(),
  extracted_data: z.record(z.unknown()).optional(),
});

const createAliasSchema = z.object({
  marketplace: z.string().min(1).max(100),
  alias_name: z.string().min(1).max(500),
  brand_id: z.number().int().positive(),
  location_id: z.number().int().positive().nullable().optional(),
});
const updateAliasSchema = createAliasSchema;

/**
 * Run product matching for best-selling items of an import.
 */
async function matchProducts(importId: number, workspaceOwnerId: string): Promise<void> {
  const importRow = await db.query<{
    detected_brand_id: number | null;
    extracted_data: { bestSellingItems?: Array<{ name: string; rank: number; quantity?: number | null; revenue?: number | null }> } | null;
  }>(
    `SELECT detected_brand_id, extracted_data FROM marketplace_report_imports WHERE id = $1 AND workspace_owner_id = $2`,
    [importId, workspaceOwnerId],
  );

  if (!importRow.rows[0] || !importRow.rows[0].detected_brand_id) return;

  const brandId = importRow.rows[0].detected_brand_id;
  const items = importRow.rows[0].extracted_data?.bestSellingItems ?? [];
  if (!items.length) return;

  const productsResult = await db.query<{ id: number; name: string }>(
    `SELECT p.id, p.name
       FROM products p
       JOIN brands b ON lower(p.brand) = lower(b.name) AND b.workspace_owner_id = p.workspace_owner_id
      WHERE p.workspace_owner_id = $1
        AND b.id = $2
        AND p.is_archived = false`,
    [workspaceOwnerId, brandId],
  );

  const products = productsResult.rows;

  const importData = importRow.rows[0].extracted_data;
  const updatedItems = items.map((item) => {
    const normalizedItemName = normalizeMerchantName(item.name);
    let bestMatchId: number | null = null;
    let bestScore = 0;
    let matchStatus = "unmatched";

    for (const product of products) {
      const exactMatch = product.name.toLowerCase() === item.name.toLowerCase();
      if (exactMatch) {
        bestMatchId = product.id;
        bestScore = 1;
        matchStatus = "matched";
        break;
      }

      const normalizedProduct = normalizeMerchantName(product.name);
      if (normalizedProduct === normalizedItemName) {
        bestMatchId = product.id;
        bestScore = 0.95;
        matchStatus = "matched";
        break;
      }

      const score = levenshteinSimilarity(normalizedProduct, normalizedItemName);
      if (score > bestScore && score >= 0.7) {
        bestScore = score;
        bestMatchId = product.id;
        matchStatus = score >= 0.9 ? "matched" : "partial";
      }
    }

    return {
      ...item,
      matchedProductId: bestMatchId,
      matchScore: bestScore,
      matchStatus,
    };
  });

  const productMap = new Map(products.map((p) => [p.id, p.name]));

  const wizardItems = updatedItems.map((item) => ({
    item_name: item.name,
    rank: item.rank,
    quantity: item.quantity ?? null,
    revenue: item.revenue ?? null,
    match_status: item.matchStatus === "matched" ? "matched" : item.matchStatus === "partial" ? "needs_review" : "needs_review",
    matched_product_id: item.matchedProductId ?? null,
    matched_product_name: item.matchedProductId != null ? (productMap.get(item.matchedProductId) ?? null) : null,
  }));

  const updatedData = { ...importData, bestSellingItems: updatedItems, items: wizardItems };
  await db.query(
    `UPDATE marketplace_report_imports SET extracted_data = $1, updated_at = now() WHERE id = $2`,
    [JSON.stringify(updatedData), importId],
  );
}

/**
 * POST /api/brands/:brandId/marketplace-reports/imports/manual
 * Manually upload a PDF report for a brand with optional metadata.
 */
router.post(
  "/brands/:brandId/marketplace-reports/imports/manual",
  upload.single("pdf"),
  async (req, res) => {
    const wreq = workspace(req);
    if (!isOwner(wreq)) {
      res.status(403).json({ success: false, error: "Owner access required" });
      return;
    }

    const brandId = parseInt(String(req.params.brandId), 10);
    if (Number.isNaN(brandId)) {
      res.status(400).json({ success: false, error: "Invalid brand ID" });
      return;
    }

    const brandCheck = await db.query<{ id: number }>(
      `SELECT id FROM brands WHERE id = $1 AND workspace_owner_id = $2`,
      [brandId, wreq.workspaceOwnerId],
    );
    if (!brandCheck.rows[0]) {
      res.status(404).json({ success: false, error: "Brand not found" });
      return;
    }

    const file = (req as unknown as { file?: Express.Multer.File }).file;
    if (!file) {
      res.status(400).json({ success: false, error: "PDF file is required (field name: pdf)" });
      return;
    }

    const marketplace = typeof req.body.marketplace === "string" ? req.body.marketplace.trim() : "toters";
    const locationId = req.body.location_id ? parseInt(String(req.body.location_id), 10) : null;
    const notes = typeof req.body.notes === "string" ? req.body.notes.trim() : null;
    const reportPeriodStart = typeof req.body.report_period_start === "string" ? req.body.report_period_start : null;
    const reportPeriodEnd = typeof req.body.report_period_end === "string" ? req.body.report_period_end : null;

    const sha256 = createHash("sha256").update(file.buffer).digest("hex");

    const dupCheck = await db.query<{ id: number }>(
      `SELECT id FROM marketplace_report_imports
        WHERE workspace_owner_id = $1 AND pdf_sha256 = $2 AND import_status != 'duplicate'
        LIMIT 1`,
      [wreq.workspaceOwnerId, sha256],
    );
    if (dupCheck.rows[0]) {
      res.status(200).json({ success: true, duplicate: true, existing_import_id: dupCheck.rows[0].id });
      return;
    }

    let pdfStoragePath: string;
    try {
      pdfStoragePath = await storePdfToObjectStorage(file.buffer, sha256, wreq.workspaceOwnerId);
    } catch (err) {
      logger.error({ err }, "Failed to store manual marketplace PDF");
      res.status(500).json({ success: false, error: "Failed to store PDF" });
      return;
    }

    const insertResult = await db.query<{ id: number }>(
      `INSERT INTO marketplace_report_imports
         (workspace_owner_id, source_type, marketplace, import_status, pdf_storage_path, pdf_sha256,
          detected_brand_id, detected_location_id, report_period_start, report_period_end, notes)
       VALUES ($1, 'manual_upload', $2, 'pending', $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        wreq.workspaceOwnerId,
        marketplace,
        pdfStoragePath,
        sha256,
        brandId,
        locationId ?? null,
        reportPeriodStart,
        reportPeriodEnd,
        notes,
      ],
    );

    const importId = insertResult.rows[0].id;

    res.status(201).json({ success: true, import_id: importId });

    void runExtractionAndMatching(importId, file.buffer, wreq.workspaceOwnerId);
  },
);

/**
 * GET /api/brands/:brandId/marketplace-report-imports
 * List all imports for a brand (owner only).
 */
router.get("/brands/:brandId/marketplace-report-imports", async (req, res) => {
  const wreq = workspace(req);
  if (!isOwner(wreq)) {
    res.status(403).json({ success: false, error: "Owner access required" });
    return;
  }

  const brandId = parseInt(String(req.params.brandId), 10);
  if (Number.isNaN(brandId)) {
    res.status(400).json({ success: false, error: "Invalid brand ID" });
    return;
  }

  const brandCheck = await db.query<{ id: number }>(
    `SELECT id FROM brands WHERE id = $1 AND workspace_owner_id = $2`,
    [brandId, wreq.workspaceOwnerId],
  );
  if (!brandCheck.rows[0]) {
    res.status(404).json({ success: false, error: "Brand not found" });
    return;
  }

  const result = await db.query(
    `SELECT mri.*,
            b.name AS brand_name,
            l.name AS location_name,
            mba.alias_name AS auto_matched_alias_name
       FROM marketplace_report_imports mri
       LEFT JOIN brands b ON b.id = mri.detected_brand_id
       LEFT JOIN locations l ON l.id = mri.detected_location_id
       LEFT JOIN marketplace_brand_aliases mba ON mba.id = mri.auto_matched_alias_id
      WHERE mri.workspace_owner_id = $1
        AND mri.detected_brand_id = $2
      ORDER BY mri.created_at DESC`,
    [wreq.workspaceOwnerId, brandId],
  );

  res.json({ success: true, imports: result.rows });
});

/**
 * GET /api/marketplace-report-imports/:importId
 * Get full import detail.
 */
router.get("/marketplace-report-imports/:importId", async (req, res) => {
  const wreq = workspace(req);
  if (!isOwner(wreq)) {
    res.status(403).json({ success: false, error: "Owner access required" });
    return;
  }

  const importId = parseInt(String(req.params.importId), 10);
  if (Number.isNaN(importId)) {
    res.status(400).json({ success: false, error: "Invalid import ID" });
    return;
  }

  const result = await db.query(
    `SELECT mri.*,
            b.name AS brand_name,
            l.name AS location_name,
            mba.alias_name AS auto_matched_alias_name
       FROM marketplace_report_imports mri
       LEFT JOIN brands b ON b.id = mri.detected_brand_id
       LEFT JOIN locations l ON l.id = mri.detected_location_id
       LEFT JOIN marketplace_brand_aliases mba ON mba.id = mri.auto_matched_alias_id
      WHERE mri.id = $1 AND mri.workspace_owner_id = $2`,
    [importId, wreq.workspaceOwnerId],
  );

  if (!result.rows[0]) {
    res.status(404).json({ success: false, error: "Import not found" });
    return;
  }

  res.json({ success: true, import: result.rows[0] });
});

/**
 * PATCH /api/marketplace-report-imports/:importId
 * Edit detected/extracted values before approval.
 */
router.patch("/marketplace-report-imports/:importId", async (req, res) => {
  const wreq = workspace(req);
  if (!isOwner(wreq)) {
    res.status(403).json({ success: false, error: "Owner access required" });
    return;
  }

  const importId = parseInt(String(req.params.importId), 10);
  if (Number.isNaN(importId)) {
    res.status(400).json({ success: false, error: "Invalid import ID" });
    return;
  }

  const parsed = patchImportSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: "Validation failed", issues: parsed.error.issues });
    return;
  }

  const importCheck = await db.query<{ id: number; import_status: string }>(
    `SELECT id, import_status FROM marketplace_report_imports WHERE id = $1 AND workspace_owner_id = $2`,
    [importId, wreq.workspaceOwnerId],
  );
  if (!importCheck.rows[0]) {
    res.status(404).json({ success: false, error: "Import not found" });
    return;
  }
  if (importCheck.rows[0].import_status === "approved") {
    res.status(409).json({ success: false, error: "Cannot edit an approved import" });
    return;
  }

  const data = parsed.data;
  const setClauses: string[] = [];
  const params: unknown[] = [];

  if (data.detected_merchant_name !== undefined) {
    params.push(data.detected_merchant_name);
    setClauses.push(`detected_merchant_name = $${params.length}`);
  }
  if (data.detected_brand_id !== undefined) {
    params.push(data.detected_brand_id);
    setClauses.push(`detected_brand_id = $${params.length}`);
  }
  if (data.detected_location_id !== undefined) {
    params.push(data.detected_location_id);
    setClauses.push(`detected_location_id = $${params.length}`);
  }
  if (data.report_period_start !== undefined) {
    params.push(data.report_period_start);
    setClauses.push(`report_period_start = $${params.length}`);
  }
  if (data.report_period_end !== undefined) {
    params.push(data.report_period_end);
    setClauses.push(`report_period_end = $${params.length}`);
  }
  if (data.marketplace !== undefined) {
    params.push(data.marketplace);
    setClauses.push(`marketplace = $${params.length}`);
  }
  if (data.import_status !== undefined) {
    params.push(data.import_status);
    setClauses.push(`import_status = $${params.length}`);
  }
  if (data.notes !== undefined) {
    params.push(data.notes);
    setClauses.push(`notes = $${params.length}`);
  }
  if (data.extracted_data !== undefined) {
    params.push(JSON.stringify(data.extracted_data));
    setClauses.push(`extracted_data = $${params.length}`);
  }

  if (setClauses.length === 0) {
    res.status(400).json({ success: false, error: "No fields to update" });
    return;
  }

  setClauses.push("updated_at = now()");
  params.push(importId);

  const result = await db.query(
    `UPDATE marketplace_report_imports SET ${setClauses.join(", ")} WHERE id = $${params.length} RETURNING *`,
    params,
  );

  res.json({ success: true, import: result.rows[0] });
});

/**
 * POST /api/marketplace-report-imports/:importId/match-products
 * Re-run product matching on demand.
 */
router.post("/marketplace-report-imports/:importId/match-products", async (req, res) => {
  const wreq = workspace(req);
  if (!isOwner(wreq)) {
    res.status(403).json({ success: false, error: "Owner access required" });
    return;
  }

  const importId = parseInt(String(req.params.importId), 10);
  if (Number.isNaN(importId)) {
    res.status(400).json({ success: false, error: "Invalid import ID" });
    return;
  }

  const importCheck = await db.query<{ id: number }>(
    `SELECT id FROM marketplace_report_imports WHERE id = $1 AND workspace_owner_id = $2`,
    [importId, wreq.workspaceOwnerId],
  );
  if (!importCheck.rows[0]) {
    res.status(404).json({ success: false, error: "Import not found" });
    return;
  }

  try {
    await matchProducts(importId, wreq.workspaceOwnerId);
    const updated = await db.query(
      `SELECT extracted_data FROM marketplace_report_imports WHERE id = $1`,
      [importId],
    );
    res.json({ success: true, extracted_data: updated.rows[0]?.extracted_data });
  } catch (err) {
    logger.error({ err, importId }, "Product matching failed");
    res.status(500).json({ success: false, error: "Product matching failed" });
  }
});

/**
 * POST /api/marketplace-report-imports/:importId/retry
 * Re-queue PDF extraction for an import that previously failed.
 * Only allowed when import_status = 'extraction_failed'.
 */
router.post("/marketplace-report-imports/:importId/retry", async (req, res) => {
  const wreq = workspace(req);
  if (!isOwner(wreq)) {
    res.status(403).json({ success: false, error: "Owner access required" });
    return;
  }

  const importId = parseInt(String(req.params.importId), 10);
  if (Number.isNaN(importId)) {
    res.status(400).json({ success: false, error: "Invalid import ID" });
    return;
  }

  const importRow = await db.query<{
    id: number;
    import_status: string;
    pdf_storage_path: string | null;
  }>(
    `SELECT id, import_status, pdf_storage_path
       FROM marketplace_report_imports
      WHERE id = $1 AND workspace_owner_id = $2`,
    [importId, wreq.workspaceOwnerId],
  );

  if (!importRow.rows[0]) {
    res.status(404).json({ success: false, error: "Import not found" });
    return;
  }

  if (importRow.rows[0].import_status !== "extraction_failed") {
    res.status(409).json({ success: false, error: "Import is not in extraction_failed state" });
    return;
  }

  const pdfPath = importRow.rows[0].pdf_storage_path;
  if (!pdfPath) {
    res.status(422).json({ success: false, error: "No PDF stored for this import" });
    return;
  }

  let pdfBuffer: Buffer;
  try {
    const file = await objectStorageService.getObjectEntityFile(pdfPath);
    const response = await objectStorageService.downloadObject(file, 3600);
    if (!response.body) {
      throw new Error("Empty response body from object storage");
    }
    const { Readable } = await import("stream");
    const nodeStream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
    const chunks: Buffer[] = [];
    for await (const chunk of nodeStream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBufferLike));
    }
    pdfBuffer = Buffer.concat(chunks);
  } catch (err) {
    logger.error({ err, importId }, "Failed to retrieve PDF for retry");
    res.status(500).json({ success: false, error: "Failed to retrieve stored PDF" });
    return;
  }

  await db.query(
    `UPDATE marketplace_report_imports SET import_status = 'pending', updated_at = now() WHERE id = $1`,
    [importId],
  );

  res.status(202).json({ success: true, import_id: importId });

  void runExtractionAndMatching(importId, pdfBuffer, wreq.workspaceOwnerId);
});

/**
 * POST /api/marketplace-report-imports/:importId/re-extract
 * Re-run AI extraction for any non-approved import, regardless of current status.
 * Useful for imports stuck in needs_review that were processed before the AI extractor.
 */
router.post("/marketplace-report-imports/:importId/re-extract", async (req, res) => {
  const wreq = workspace(req);
  if (!isOwner(wreq)) {
    res.status(403).json({ success: false, error: "Owner access required" });
    return;
  }

  const importId = parseInt(String(req.params.importId), 10);
  if (Number.isNaN(importId)) {
    res.status(400).json({ success: false, error: "Invalid import ID" });
    return;
  }

  const importRow = await db.query<{
    id: number;
    import_status: string;
    pdf_storage_path: string | null;
  }>(
    `SELECT id, import_status, pdf_storage_path
       FROM marketplace_report_imports
      WHERE id = $1 AND workspace_owner_id = $2`,
    [importId, wreq.workspaceOwnerId],
  );

  if (!importRow.rows[0]) {
    res.status(404).json({ success: false, error: "Import not found" });
    return;
  }

  if (importRow.rows[0].import_status === "approved") {
    res.status(409).json({ success: false, error: "Import is already approved" });
    return;
  }

  const pdfPath = importRow.rows[0].pdf_storage_path;
  if (!pdfPath) {
    res.status(422).json({ success: false, error: "No PDF stored for this import" });
    return;
  }

  let pdfBuffer: Buffer;
  try {
    const file = await objectStorageService.getObjectEntityFile(pdfPath);
    const response = await objectStorageService.downloadObject(file, 3600);
    if (!response.body) {
      throw new Error("Empty response body from object storage");
    }
    const { Readable } = await import("stream");
    const nodeStream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
    const chunks: Buffer[] = [];
    for await (const chunk of nodeStream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBufferLike));
    }
    pdfBuffer = Buffer.concat(chunks);
  } catch (err) {
    logger.error({ err, importId }, "Failed to retrieve PDF for re-extract");
    res.status(500).json({ success: false, error: "Failed to retrieve stored PDF" });
    return;
  }

  await db.query(
    `UPDATE marketplace_report_imports SET import_status = 'pending', updated_at = now() WHERE id = $1`,
    [importId],
  );

  res.status(202).json({ success: true, import_id: importId });

  void runExtractionAndMatching(importId, pdfBuffer, wreq.workspaceOwnerId);
});

/**
 * POST /api/marketplace-report-imports/:importId/approve
 * Promote an import to an approved report.
 */
router.post("/marketplace-report-imports/:importId/approve", async (req, res) => {
  const wreq = workspace(req);
  if (!isOwner(wreq)) {
    res.status(403).json({ success: false, error: "Owner access required" });
    return;
  }

  const importId = parseInt(String(req.params.importId), 10);
  if (Number.isNaN(importId)) {
    res.status(400).json({ success: false, error: "Invalid import ID" });
    return;
  }

  type ImportRow = {
    id: number;
    workspace_owner_id: string;
    marketplace: string;
    import_status: string;
    detected_brand_id: number | null;
    detected_location_id: number | null;
    report_period_start: string | null;
    report_period_end: string | null;
    extracted_data: {
      metrics?: Array<{ name: string; value: number | null; unit: string | null; category: string }>;
      weeklyTrends?: Array<{ weekLabel: string; weekStart: string | null; value: number | null; metricName: string }>;
      bestSellingItems?: Array<{ rank: number; name: string; quantity: number | null; revenue: number | null; matchedProductId?: number | null; matchScore?: number | null; matchStatus?: string }>;
    } | null;
  };

  const importRow = await db.query<ImportRow>(
    `SELECT * FROM marketplace_report_imports WHERE id = $1 AND workspace_owner_id = $2`,
    [importId, wreq.workspaceOwnerId],
  );

  if (!importRow.rows[0]) {
    res.status(404).json({ success: false, error: "Import not found" });
    return;
  }

  const imp = importRow.rows[0];

  if (imp.import_status === "approved") {
    res.status(409).json({ success: false, error: "Import already approved" });
    return;
  }

  if (!imp.detected_brand_id) {
    res.status(422).json({ success: false, error: "Brand must be set before approving" });
    return;
  }
  if (!imp.report_period_start || !imp.report_period_end) {
    res.status(422).json({ success: false, error: "Report period (start and end) must be set before approving" });
    return;
  }

  // Match on (workspace, marketplace, brand, location, period).
  // location_id uses 0 as the sentinel for "global/no specific location".
  const locationId = imp.detected_location_id ?? 0;
  const dupCheck = await db.query<{ id: number }>(
    `SELECT id FROM marketplace_reports
      WHERE workspace_owner_id = $1
        AND marketplace = $2
        AND brand_id = $3
        AND location_id = $4
        AND report_period_start = $5
        AND report_period_end = $6
      LIMIT 1`,
    [
      wreq.workspaceOwnerId,
      imp.marketplace,
      imp.detected_brand_id,
      locationId,
      imp.report_period_start,
      imp.report_period_end,
    ],
  );

  if (dupCheck.rows[0]) {
    await db.query(
      `UPDATE marketplace_report_imports
          SET import_status = 'duplicate', approved_report_id = $1, updated_at = now()
        WHERE id = $2`,
      [dupCheck.rows[0].id, importId],
    );
    res.status(409).json({
      success: false,
      error: "A report already exists for this marketplace/brand/location/period",
      existing_report_id: dupCheck.rows[0].id,
    });
    return;
  }

  const client = await db.connect();
  try {
    const reportId = await withTransaction(client, async () => {
      const reportInsert = await client.query<{ id: number }>(
        `INSERT INTO marketplace_reports
           (workspace_owner_id, import_id, marketplace, brand_id, location_id, report_period_start, report_period_end)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          wreq.workspaceOwnerId,
          importId,
          imp.marketplace,
          imp.detected_brand_id,
          locationId,
          imp.report_period_start,
          imp.report_period_end,
        ],
      );

      const reportId = reportInsert.rows[0].id;
      const extractedData = imp.extracted_data;

      if (extractedData?.metrics?.length) {
        for (const metric of extractedData.metrics) {
          await client.query(
            `INSERT INTO marketplace_report_metrics (report_id, metric_name, metric_value, metric_unit, category)
             VALUES ($1, $2, $3, $4, $5)`,
            [reportId, metric.name, metric.value, metric.unit, metric.category],
          );
        }
      }

      if (extractedData?.weeklyTrends?.length) {
        for (const trend of extractedData.weeklyTrends) {
          await client.query(
            `INSERT INTO marketplace_report_weekly_trends (report_id, week_label, week_start, value, metric_name)
             VALUES ($1, $2, $3, $4, $5)`,
            [reportId, trend.weekLabel, trend.weekStart ?? null, trend.value, trend.metricName],
          );
        }
      }

      if (extractedData?.bestSellingItems?.length) {
        for (const item of extractedData.bestSellingItems) {
          await client.query(
            `INSERT INTO marketplace_report_items
               (report_id, item_name, rank, quantity, revenue, match_status, matched_product_id, match_score)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              reportId,
              item.name,
              item.rank,
              item.quantity ?? null,
              item.revenue ?? null,
              item.matchStatus ?? "unmatched",
              item.matchedProductId ?? null,
              item.matchScore ?? null,
            ],
          );
        }
      }

      await client.query(
        `UPDATE marketplace_report_imports
            SET import_status = 'approved', approved_report_id = $1, updated_at = now()
          WHERE id = $2`,
        [reportId, importId],
      );

      return reportId;
    });

    res.status(201).json({ success: true, report_id: reportId });
  } catch (err) {
    logger.error({ err, importId }, "Failed to approve marketplace import");
    res.status(500).json({ success: false, error: "Failed to create report" });
  } finally {
    client.release();
  }
});

/**
 * GET /api/brands/:brandId/marketplace-reports
 * List approved reports for a brand with optional filters.
 */
router.get("/brands/:brandId/marketplace-reports", async (req, res) => {
  const wreq = workspace(req);
  if (!isOwner(wreq)) {
    res.status(403).json({ success: false, error: "Owner access required" });
    return;
  }

  const brandId = parseInt(String(req.params.brandId), 10);
  if (Number.isNaN(brandId)) {
    res.status(400).json({ success: false, error: "Invalid brand ID" });
    return;
  }

  const brandCheck = await db.query<{ id: number }>(
    `SELECT id FROM brands WHERE id = $1 AND workspace_owner_id = $2`,
    [brandId, wreq.workspaceOwnerId],
  );
  if (!brandCheck.rows[0]) {
    res.status(404).json({ success: false, error: "Brand not found" });
    return;
  }

  const conditions: string[] = ["mr.workspace_owner_id = $1", "mr.brand_id = $2"];
  const params: unknown[] = [wreq.workspaceOwnerId, brandId];

  const marketplace = typeof req.query.marketplace === "string" ? req.query.marketplace.trim() : null;
  if (marketplace) {
    params.push(marketplace);
    conditions.push(`mr.marketplace = $${params.length}`);
  }

  const locationId = req.query.location_id ? parseInt(String(req.query.location_id), 10) : null;
  if (locationId && Number.isFinite(locationId)) {
    params.push(locationId);
    conditions.push(`mr.location_id = $${params.length}`);
  }

  const dateFrom = typeof req.query.date_from === "string" ? req.query.date_from : null;
  if (dateFrom) {
    params.push(dateFrom);
    conditions.push(`mr.report_period_start >= $${params.length}`);
  }

  const dateTo = typeof req.query.date_to === "string" ? req.query.date_to : null;
  if (dateTo) {
    params.push(dateTo);
    conditions.push(`mr.report_period_end <= $${params.length}`);
  }

  const result = await db.query(
    `SELECT mr.*,
            b.name AS brand_name,
            l.name AS location_name,
            mri.detected_merchant_name
       FROM marketplace_reports mr
       JOIN brands b ON b.id = mr.brand_id
       LEFT JOIN locations l ON l.id = mr.location_id
       LEFT JOIN marketplace_report_imports mri ON mri.id = mr.import_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY mr.report_period_start DESC`,
    params,
  );

  res.json({ success: true, reports: result.rows });
});

/**
 * GET /api/marketplace-reports/inbound-email
 * Returns the owner's dedicated inbound email address for marketplace reports.
 * Must be placed before /:reportId to avoid Express treating "inbound-email" as an ID.
 */
router.get("/marketplace-reports/inbound-email", async (req, res) => {
  const wreq = workspace(req);
  if (!isOwner(wreq)) {
    res.status(403).json({ success: false, error: "Owner access required" });
    return;
  }

  const domain = process.env.MARKETPLACE_INBOUND_DOMAIN ?? "inbound.presentail.com";
  const email = `marketplace-reports+${wreq.workspaceOwnerId}@${domain}`;

  res.json({ success: true, email, domain });
});

/**
 * GET /api/marketplace-reports/:reportId
 * Full report detail with metrics, trends, and items.
 */
router.get("/marketplace-reports/:reportId", async (req, res) => {
  const wreq = workspace(req);
  if (!isOwner(wreq)) {
    res.status(403).json({ success: false, error: "Owner access required" });
    return;
  }

  const reportId = parseInt(String(req.params.reportId), 10);
  if (Number.isNaN(reportId)) {
    res.status(400).json({ success: false, error: "Invalid report ID" });
    return;
  }

  const reportResult = await db.query(
    `SELECT mr.*,
            b.name AS brand_name,
            l.name AS location_name,
            mri.detected_merchant_name
       FROM marketplace_reports mr
       JOIN brands b ON b.id = mr.brand_id
       LEFT JOIN locations l ON l.id = mr.location_id
       LEFT JOIN marketplace_report_imports mri ON mri.id = mr.import_id
      WHERE mr.id = $1 AND mr.workspace_owner_id = $2`,
    [reportId, wreq.workspaceOwnerId],
  );

  if (!reportResult.rows[0]) {
    res.status(404).json({ success: false, error: "Report not found" });
    return;
  }

  const [metricsResult, trendsResult, itemsResult] = await Promise.all([
    db.query(
      `SELECT * FROM marketplace_report_metrics WHERE report_id = $1 ORDER BY category, metric_name`,
      [reportId],
    ),
    db.query(
      `SELECT * FROM marketplace_report_weekly_trends WHERE report_id = $1 ORDER BY week_start NULLS LAST, id`,
      [reportId],
    ),
    db.query(
      `SELECT mri.*, p.name AS matched_product_name
         FROM marketplace_report_items mri
         LEFT JOIN products p ON p.id = mri.matched_product_id
        WHERE mri.report_id = $1
        ORDER BY mri.rank NULLS LAST, mri.id`,
      [reportId],
    ),
  ]);

  res.json({
    success: true,
    report: {
      ...reportResult.rows[0],
      metrics: metricsResult.rows,
      weekly_trends: trendsResult.rows,
      items: itemsResult.rows,
    },
  });
});

const objectStorageService = new ObjectStorageService();

/**
 * GET /api/marketplace-reports/:reportId/source-pdf
 * Proxy the stored PDF from object storage.
 */
router.get("/marketplace-reports/:reportId/source-pdf", async (req, res) => {
  const wreq = workspace(req);
  if (!isOwner(wreq)) {
    res.status(403).json({ success: false, error: "Owner access required" });
    return;
  }

  const reportId = parseInt(String(req.params.reportId), 10);
  if (Number.isNaN(reportId)) {
    res.status(400).json({ success: false, error: "Invalid report ID" });
    return;
  }

  const reportResult = await db.query<{ import_id: number }>(
    `SELECT import_id FROM marketplace_reports WHERE id = $1 AND workspace_owner_id = $2`,
    [reportId, wreq.workspaceOwnerId],
  );

  if (!reportResult.rows[0]) {
    res.status(404).json({ success: false, error: "Report not found" });
    return;
  }

  const importResult = await db.query<{ pdf_storage_path: string | null; pdf_sha256: string | null }>(
    `SELECT pdf_storage_path, pdf_sha256 FROM marketplace_report_imports WHERE id = $1`,
    [reportResult.rows[0].import_id],
  );

  const pdfPath = importResult.rows[0]?.pdf_storage_path;
  if (!pdfPath) {
    res.status(404).json({ success: false, error: "PDF not found for this report" });
    return;
  }

  try {
    const file = await objectStorageService.getObjectEntityFile(pdfPath);
    const response = await objectStorageService.downloadObject(file, 3600);

    res.setHeader("Content-Disposition", `inline; filename="marketplace-report-${reportId}.pdf"`);
    response.headers.forEach((value, key) => res.setHeader(key, value));

    if (response.body) {
      const nodeStream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      res.status(404).json({ success: false, error: "PDF file not found in storage" });
      return;
    }
    logger.error({ err, reportId }, "Failed to serve marketplace report PDF");
    res.status(500).json({ success: false, error: "Failed to retrieve PDF" });
  }
});

/**
 * POST /api/marketplace-brand-aliases
 * Create or update a brand-alias mapping.
 */
router.post("/marketplace-brand-aliases", async (req, res) => {
  const wreq = workspace(req);
  if (!isOwner(wreq)) {
    res.status(403).json({ success: false, error: "Owner access required" });
    return;
  }

  const parsed = createAliasSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: "Validation failed", issues: parsed.error.issues });
    return;
  }

  const { marketplace, alias_name, brand_id, location_id } = parsed.data;

  const brandCheck = await db.query<{ id: number }>(
    `SELECT id FROM brands WHERE id = $1 AND workspace_owner_id = $2`,
    [brand_id, wreq.workspaceOwnerId],
  );
  if (!brandCheck.rows[0]) {
    res.status(404).json({ success: false, error: "Brand not found" });
    return;
  }

  const normalizedAlias = normalizeMerchantName(alias_name);

  const result = await db.query(
    `INSERT INTO marketplace_brand_aliases
       (workspace_owner_id, marketplace, alias_name, brand_id, location_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (workspace_owner_id, marketplace, alias_name)
     DO UPDATE SET brand_id = EXCLUDED.brand_id, location_id = EXCLUDED.location_id, updated_at = now()
     RETURNING *`,
    [wreq.workspaceOwnerId, marketplace, normalizedAlias, brand_id, location_id ?? null],
  );

  res.status(201).json({ success: true, alias: result.rows[0] });
});

/**
 * PATCH /api/marketplace-brand-aliases/:id
 * Update a brand-alias mapping without changing its record identity.
 */
router.patch("/marketplace-brand-aliases/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!isOwner(wreq)) {
    res.status(403).json({ success: false, error: "Owner access required" });
    return;
  }

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ success: false, error: "Invalid alias id" });
    return;
  }

  const parsed = updateAliasSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: "Validation failed", issues: parsed.error.issues });
    return;
  }

  const { marketplace, alias_name, brand_id, location_id } = parsed.data;
  const brandCheck = await db.query<{ id: number }>(
    `SELECT id FROM brands WHERE id = $1 AND workspace_owner_id = $2`,
    [brand_id, wreq.workspaceOwnerId],
  );
  if (!brandCheck.rows[0]) {
    res.status(404).json({ success: false, error: "Brand not found" });
    return;
  }

  if (location_id != null) {
    const locationCheck = await db.query<{ id: number }>(
      `SELECT id FROM locations WHERE id = $1 AND workspace_owner_id = $2`,
      [location_id, wreq.workspaceOwnerId],
    );
    if (!locationCheck.rows[0]) {
      res.status(404).json({ success: false, error: "Location not found" });
      return;
    }
  }

  const normalizedAlias = normalizeMerchantName(alias_name);
  const conflict = await db.query<{ id: number }>(
    `SELECT id
       FROM marketplace_brand_aliases
      WHERE workspace_owner_id = $1
        AND marketplace = $2
        AND alias_name = $3
        AND id <> $4`,
    [wreq.workspaceOwnerId, marketplace, normalizedAlias, id],
  );
  if (conflict.rows[0]) {
    res.status(409).json({ success: false, error: "An alias with this marketplace and name already exists" });
    return;
  }

  try {
    const result = await db.query(
      `UPDATE marketplace_brand_aliases
          SET marketplace = $2,
              alias_name = $3,
              brand_id = $4,
              location_id = $5,
              updated_at = now()
        WHERE id = $1
          AND workspace_owner_id = $6
      RETURNING *`,
      [id, marketplace, normalizedAlias, brand_id, location_id ?? null, wreq.workspaceOwnerId],
    );

    if (!result.rows[0]) {
      res.status(404).json({ success: false, error: "Alias not found" });
      return;
    }

    res.json({ success: true, alias: result.rows[0] });
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "23505") {
      res.status(409).json({ success: false, error: "An alias with this marketplace and name already exists" });
      return;
    }
    throw err;
  }
});

/**
 * DELETE /api/marketplace-brand-aliases/:id
 * Delete a brand-alias mapping.
 */
router.delete("/marketplace-brand-aliases/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!isOwner(wreq)) {
    res.status(403).json({ success: false, error: "Owner access required" });
    return;
  }

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ success: false, error: "Invalid alias id" });
    return;
  }

  const result = await db.query(
    `DELETE FROM marketplace_brand_aliases
      WHERE id = $1 AND workspace_owner_id = $2
      RETURNING id`,
    [id, wreq.workspaceOwnerId],
  );

  if (!result.rows[0]) {
    res.status(404).json({ success: false, error: "Alias not found" });
    return;
  }

  res.json({ success: true });
});

/**
 * GET /api/marketplace-brand-aliases
 * List brand-alias mappings for the workspace.
 */
router.get("/marketplace-brand-aliases", async (req, res) => {
  const wreq = workspace(req);
  if (!isOwner(wreq)) {
    res.status(403).json({ success: false, error: "Owner access required" });
    return;
  }

  const result = await db.query(
    `SELECT mba.*, b.name AS brand_name, l.name AS location_name
       FROM marketplace_brand_aliases mba
       LEFT JOIN brands b ON b.id = mba.brand_id
       LEFT JOIN locations l ON l.id = mba.location_id
      WHERE mba.workspace_owner_id = $1
      ORDER BY mba.marketplace, mba.alias_name`,
    [wreq.workspaceOwnerId],
  );

  res.json({ success: true, aliases: result.rows });
});

export default router;
