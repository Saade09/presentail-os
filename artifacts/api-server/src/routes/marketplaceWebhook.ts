import { Router } from "express";
import { createHash, timingSafeEqual } from "crypto";
import multer from "multer";
import { db } from "../lib/db";
import { logger } from "../lib/logger";
import { objectStorageClient } from "../lib/objectStorage";
import { extractTotersPdf, normalizeMerchantName, type TotersExtractedMetric, type TotersExtractedItem } from "../lib/totersPdfExtractor";
import { extractMarketplaceReportWithAI } from "../lib/aiMarketplaceExtractor";

const router = Router();

const MAX_PDF_SIZE = 20 * 1024 * 1024;

/**
 * Map the structured metrics array into flat scalar fields that the review
 * wizard reads directly (e.g. `total_orders`, `total_revenue`, `rating`).
 */
function flattenExtractedMetrics(metrics: TotersExtractedMetric[]): Record<string, number | null> {
  const metricKeyMap: Record<string, string> = {
    total_orders: "total_orders",
    total_revenue: "total_revenue",
    net_revenue: "net_revenue",
    avg_order_value: "average_order_value",
    rating: "rating",
    acceptance_rate: "acceptance_rate",
    cancellation_rate: "cancel_rate",
    avg_delivery_time: "avg_delivery_time_min",
    new_customers: "new_customers",
    total_customers: "total_customers",
    impressions: "impressions",
    conversion_rate: "conversion_rate",
    promo_cost: "promo_cost",
    commission: "commission",
  };

  const flat: Record<string, number | null> = {};
  for (const metric of metrics) {
    const flatKey = metricKeyMap[metric.name];
    if (flatKey && metric.value !== null) {
      flat[flatKey] = metric.value;
    }
  }
  return flat;
}

/**
 * Convert bestSellingItems (extractor shape) into the `items` array shape that
 * the review wizard uses for display in Step 5.
 */
function normalizeItemsForWizard(
  bestSellingItems: TotersExtractedItem[],
): Array<{ item_name: string; rank: number; quantity: number | null; revenue: number | null; match_status: string }> {
  return bestSellingItems.map((item) => ({
    item_name: item.name,
    rank: item.rank,
    quantity: item.quantity,
    revenue: item.revenue,
    match_status: "needs_review",
  }));
}

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

function validateSecret(provided: string | undefined): boolean {
  const expected = process.env.MARKETPLACE_WEBHOOK_SECRET;
  if (!expected) {
    logger.warn("MARKETPLACE_WEBHOOK_SECRET not set — rejecting marketplace webhook");
    return false;
  }
  if (!provided) return false;
  try {
    const expBuf = Buffer.from(expected, "utf8");
    const provBuf = Buffer.from(provided, "utf8");
    if (expBuf.length !== provBuf.length) return false;
    return timingSafeEqual(expBuf, provBuf);
  } catch {
    return false;
  }
}

function getConfiguredWorkspaceOwnerId(): string | null {
  const configuredOwnerId = process.env.MARKETPLACE_WEBHOOK_WORKSPACE_OWNER_ID?.trim();
  if (!configuredOwnerId) {
    logger.warn(
      "MARKETPLACE_WEBHOOK_WORKSPACE_OWNER_ID not set — rejecting marketplace webhook",
    );
    return null;
  }
  return configuredOwnerId;
}

async function storePdfToObjectStorage(
  buffer: Buffer,
  sha256: string,
  workspaceOwnerId: string,
): Promise<string> {
  const privateObjectDir = process.env.PRIVATE_OBJECT_DIR;
  if (!privateObjectDir) {
    throw new Error("PRIVATE_OBJECT_DIR not set");
  }
  const fullPath = `${privateObjectDir}/${workspaceOwnerId}/marketplace-reports/${sha256}.pdf`;
  const parts = fullPath.startsWith("/") ? fullPath.slice(1).split("/") : fullPath.split("/");
  if (parts.length < 2) throw new Error("Invalid PRIVATE_OBJECT_DIR path");
  const bucketName = parts[0];
  const objectName = parts.slice(1).join("/");
  const bucket = objectStorageClient.bucket(bucketName);
  const file = bucket.file(objectName);
  await file.save(buffer, { contentType: "application/pdf", resumable: false });
  return `/objects/${workspaceOwnerId}/marketplace-reports/${sha256}.pdf`;
}

async function runExtractionAndMatching(
  importId: number,
  pdfBuffer: Buffer,
  workspaceOwnerId: string,
): Promise<void> {
  try {
    // Read current row so we can preserve manually-set brand/location when no
    // alias match is found — avoids silently downgrading a manual upload.
    const currentRow = await db.query<{
      detected_brand_id: number | null;
      detected_location_id: number | null;
      source_type: string;
      marketplace: string;
    }>(
      `SELECT detected_brand_id, detected_location_id, source_type, marketplace
         FROM marketplace_report_imports
        WHERE id = $1`,
      [importId],
    );

    const existingBrandId = currentRow.rows[0]?.detected_brand_id ?? null;
    const existingLocationId = currentRow.rows[0]?.detected_location_id ?? null;
    const isManualUpload = currentRow.rows[0]?.source_type === "manual_upload";
    const importMarketplace = currentRow.rows[0]?.marketplace ?? "toters";

    let extracted: Awaited<ReturnType<typeof extractTotersPdf>>;
    try {
      extracted = await extractMarketplaceReportWithAI(pdfBuffer, {
        workspaceOwnerId,
      });
      logger.info({ importId }, "Marketplace import: AI extraction succeeded");
    } catch (aiErr) {
      logger.warn({ err: aiErr, importId }, "Marketplace import: AI extraction failed, falling back to regex extractor");
      extracted = await extractTotersPdf(pdfBuffer);
    }

    const normalizedMerchant = extracted.merchantName
      ? normalizeMerchantName(extracted.merchantName)
      : null;

    // Start with whatever the row already has (preserves manual values).
    let detectedBrandId: number | null = existingBrandId;
    let detectedLocationId: number | null = existingLocationId;
    let importStatus = "needs_review";

    let autoMatchedAliasId: number | null = null;

    if (normalizedMerchant) {
      const aliasRow = await db.query<{ id: number; brand_id: number | null; location_id: number | null }>(
        `SELECT id, brand_id, location_id FROM marketplace_brand_aliases
          WHERE workspace_owner_id = $1
            AND lower(marketplace) = lower($2)
            AND alias_name = $3
          LIMIT 1`,
        [workspaceOwnerId, importMarketplace, normalizedMerchant],
      );
      if (aliasRow.rows[0]) {
        // Alias match wins; overwrite any existing value.
        detectedBrandId = aliasRow.rows[0].brand_id;
        detectedLocationId = aliasRow.rows[0].location_id;
        autoMatchedAliasId = aliasRow.rows[0].id;
        // Stamp last_used_at so owners can see which aliases are active.
        await db.query(
          `UPDATE marketplace_brand_aliases
              SET last_used_at = now(), updated_at = now()
            WHERE id = $1`,
          [aliasRow.rows[0].id],
        );
      } else if (isManualUpload) {
        // No alias found; preserve what the operator set manually — do not null it out.
        detectedBrandId = existingBrandId;
        detectedLocationId = existingLocationId;
      }
    }

    if (detectedBrandId && extracted.reportPeriodStart && extracted.reportPeriodEnd) {
      importStatus = "ready_to_approve";
    }

    const flatMetrics = flattenExtractedMetrics(extracted.metrics);
    const wizardItems = normalizeItemsForWizard(extracted.bestSellingItems);

    await db.query(
      `UPDATE marketplace_report_imports
          SET detected_merchant_name  = $1,
              detected_brand_id       = $2,
              detected_location_id    = $3,
              auto_matched_alias_id   = $4,
              report_period_start     = $5,
              report_period_end       = $6,
              extracted_data          = $7,
              import_status           = $8,
              updated_at              = now()
        WHERE id = $9`,
      [
        extracted.merchantName,
        detectedBrandId,
        detectedLocationId,
        autoMatchedAliasId,
        extracted.reportPeriodStart,
        extracted.reportPeriodEnd,
        JSON.stringify({
          merchantName: extracted.merchantName,
          country: extracted.country,
          address: extracted.address,
          metrics: extracted.metrics,
          weeklyTrends: extracted.weeklyTrends,
          bestSellingItems: extracted.bestSellingItems,
          items: wizardItems,
          ...(extracted.confidence !== undefined ? { confidence: extracted.confidence } : {}),
          ...flatMetrics,
        }),
        importStatus,
        importId,
      ],
    );

    logger.info({ importId, importStatus, detectedBrandId }, "Marketplace import extraction complete");
  } catch (err) {
    logger.error({ err, importId }, "Marketplace import extraction failed");
    await db.query(
      `UPDATE marketplace_report_imports SET import_status = 'extraction_failed', updated_at = now() WHERE id = $1`,
      [importId],
    ).catch(() => {});
  }
}

/**
 * POST /webhooks/marketplace-reports/toters
 * Accepts multipart/form-data with a PDF attachment from Toters email forwarding.
 * Validates shared secret, deduplicates, stores PDF, creates import record.
 * Returns 200 immediately; extraction runs async.
 */
router.post(
  "/webhooks/marketplace-reports/toters",
  (req, res, next) => {
    const secret = (req.headers["x-marketplace-secret"] ?? req.headers["x-webhook-secret"]) as string | undefined;
    if (!validateSecret(secret)) {
      res.status(401).json({ success: false, error: "Invalid or missing webhook secret" });
      return;
    }

    const configuredWorkspaceOwnerId = getConfiguredWorkspaceOwnerId();
    if (!configuredWorkspaceOwnerId) {
      res.status(503).json({
        success: false,
        error: "Marketplace webhook workspace is not configured",
      });
      return;
    }

    res.locals.marketplaceWebhookWorkspaceOwnerId = configuredWorkspaceOwnerId;
    next();
  },
  upload.single("pdf"),
  async (req, res) => {
    const file = (req as unknown as { file?: Express.Multer.File }).file;
    if (!file) {
      res.status(400).json({ success: false, error: "PDF file is required (field name: pdf)" });
      return;
    }

    const emailMessageId = typeof req.body.message_id === "string" ? req.body.message_id.trim() : null;
    const configuredWorkspaceOwnerId =
      res.locals.marketplaceWebhookWorkspaceOwnerId as string;
    const requestedWorkspaceOwnerId =
      typeof req.body.workspace_owner_id === "string"
        ? req.body.workspace_owner_id.trim()
        : null;

    if (!requestedWorkspaceOwnerId) {
      res.status(400).json({ success: false, error: "workspace_owner_id is required" });
      return;
    }

    if (requestedWorkspaceOwnerId !== configuredWorkspaceOwnerId) {
      logger.warn(
        { requestedWorkspaceOwnerId },
        "Marketplace webhook rejected workspace_owner_id mismatch",
      );
      res.status(403).json({ success: false, error: "Invalid workspace_owner_id" });
      return;
    }

    // The request field is only an assertion. Use the server-side configured
    // value for all storage and database operations.
    const workspaceOwnerId = configuredWorkspaceOwnerId;

    const sha256 = createHash("sha256").update(file.buffer).digest("hex");

    const dupCheck = await db.query<{ id: number }>(
      `SELECT id FROM marketplace_report_imports
        WHERE workspace_owner_id = $1
          AND pdf_sha256 = $2
          AND import_status != 'duplicate'
        LIMIT 1`,
      [workspaceOwnerId, sha256],
    );

    if (dupCheck.rows[0]) {
      logger.info({ sha256, existingId: dupCheck.rows[0].id }, "Duplicate marketplace PDF detected by SHA-256");
      res.status(200).json({ success: true, duplicate: true, existing_import_id: dupCheck.rows[0].id });
      return;
    }

    if (emailMessageId) {
      const msgDupCheck = await db.query<{ id: number }>(
        `SELECT id FROM marketplace_report_imports
          WHERE workspace_owner_id = $1
            AND email_message_id = $2
          LIMIT 1`,
        [workspaceOwnerId, emailMessageId],
      );
      if (msgDupCheck.rows[0]) {
        res.status(200).json({ success: true, duplicate: true, existing_import_id: msgDupCheck.rows[0].id });
        return;
      }
    }

    let pdfStoragePath: string;
    try {
      pdfStoragePath = await storePdfToObjectStorage(file.buffer, sha256, workspaceOwnerId);
    } catch (err) {
      logger.error({ err }, "Failed to store marketplace PDF");
      res.status(500).json({ success: false, error: "Failed to store PDF" });
      return;
    }

    const insertResult = await db.query<{ id: number }>(
      `INSERT INTO marketplace_report_imports
         (workspace_owner_id, source_type, marketplace, import_status, pdf_storage_path, pdf_sha256, email_message_id)
       VALUES ($1, 'webhook_email', 'toters', 'pending', $2, $3, $4)
       RETURNING id`,
      [workspaceOwnerId, pdfStoragePath, sha256, emailMessageId],
    );

    const importId = insertResult.rows[0].id;

    res.status(202).json({ success: true, import_id: importId });

    void runExtractionAndMatching(importId, file.buffer, workspaceOwnerId);
  },
);

export { storePdfToObjectStorage, runExtractionAndMatching };
export default router;
