/**
 * Merchant Center product sync background worker.
 *
 * Polls merchant_sync_jobs every 30 seconds. For each PENDING job:
 *   - CREATE_OR_UPDATE: reads the product's CURRENT row (process-time payload,
 *     so product fixes take effect on the next attempt), resolves private
 *     /objects/... images to public HTTPS URLs, validates, calls
 *     insertProductInput, marks COMPLETED / FAILED.
 *   - DELETE: removes the product input from Merchant Center, treating an
 *     already-missing input as successful and applying normal retry handling
 *     to other failures.
 *
 * Validation failures (zero price, missing image, …) are PERMANENT product-level
 * failures: the job fails immediately with no retries and the product row gets a
 * human-readable error plus merchant_sync_status = 'ACTION_REQUIRED'.
 *
 * Throughput: up to 50 jobs are claimed per tick and processed with a small
 * concurrency pool. The old in-job 5–50s post-insert status poll is replaced by
 * a separate lightweight status-check pass (checkSyncedProductStatuses) that
 * runs after the job batch and annotates recently-synced products with any
 * item-level issues Google reports.
 *
 * Also recovers RUNNING jobs older than 10 minutes (crash recovery), and an
 * in-process guard prevents overlapping ticks from double-processing.
 */

import { db, withTransaction } from "./db";
import { logger } from "./logger";
import {
  buildMerchantProductInput,
  validateMerchantProduct,
  type MerchantProductInput,
  type DeliveryConfig,
} from "./googleMerchant";
import {
  insertProductInput,
  deleteProductInputForConfig,
  insertProductInputForConfig,
  fetchProductStatus,
  fetchProductStatusForConfig,
  getMerchantAccountConfig,
  validateMerchantConfig,
} from "./merchantCenterClient";
import { buildPublicObjectUrl } from "./objectStorage";
import { syncProductPublicImages } from "./productPublicImages";
import type { Product } from "@workspace/db/schema";
import { allDesiredOffersApproved } from "./merchantReconciliation";
import {
  LEBANON_CREATE_AND_UPDATE_SCOPE,
  LEBANON_CREATE_UPDATE_DELETE_SCOPE,
  LEBANON_CREATE_ONLY_SCOPE,
  LEBANON_ACCOUNT_ID,
  LEBANON_DATA_SOURCE_ID,
  LEBANON_DATA_SOURCE_NAME,
  UAE_CREATE_AND_UPDATE_SCOPE,
  UAE_CREATE_ONLY_SCOPE,
  UAE_ACCOUNT_ID,
  UAE_DATA_SOURCE_ID,
  UAE_DATA_SOURCE_NAME,
  merchantExecutionAllows,
  merchantExecutionScope,
  merchantExecutionScopeAe,
  merchantExecutionScopeSql,
  merchantReconciliationExecutionEnabled,
} from "./merchantExecutionScope";

const POLL_INTERVAL_MS = 30_000;
const INITIAL_DELAY_MS = 15_000;
const STALE_RUNNING_MINUTES = 10;
const BATCH_SIZE = 50;
const JOB_CONCURRENCY = 5;
const MAX_ATTEMPTS = 5;
const STATUS_CHECK_BATCH = 20;
const APPROVAL_WINDOW_HOURS = 48;
const DISAPPROVED_RECHECK_HOURS = 1;
const TIMED_OUT_RECHECK_HOURS = 6;

export type GoogleOfferApproval = "APPROVED" | "DISAPPROVED" | "VERIFYING";
const REQUIRED_APPROVAL_CONTEXTS = ["FREE_LISTINGS", "SHOPPING_ADS"] as const;

/** Pure interpretation of the Merchant API's country approval evidence. Both
 * contexts are required because Free Listings approval does not imply ad serving. */
export function parseGoogleOfferApproval(raw: unknown, country: string): { status: GoogleOfferApproval; evidence: Record<string, unknown> } {
  const product = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const status = product.productStatus && typeof product.productStatus === "object" ? product.productStatus as Record<string, unknown> : product;
  const destinations = Array.isArray(status.destinationStatuses) ? status.destinationStatuses as Array<Record<string, unknown>> : [];
  const issues = Array.isArray(status.itemLevelIssues)
    ? status.itemLevelIssues as Array<Record<string, unknown>>
    : [];
  const blockingIssues = (context: string) => issues.filter((issue) => {
    const issueContext = String(issue.reportingContext ?? issue.destination ?? "").toUpperCase();
    if (issueContext && issueContext !== context) return false;
    const affectedCountries = Array.isArray(issue.affectedCountries)
      ? issue.affectedCountries.map((value) => String(value).toUpperCase())
      : [];
    const affectsCountry = affectedCountries.length === 0 || affectedCountries.includes(country.toUpperCase());
    return affectsCountry && String(issue.servability ?? "").toUpperCase() === "NOT_SERVABLE";
  });
  const contextEvidence = Object.fromEntries(REQUIRED_APPROVAL_CONTEXTS.map((context) => {
    const destination = destinations.find((d) => String(d.reportingContext ?? "").toUpperCase() === context) ?? {};
    const countries = (key: string) => Array.isArray(destination[key]) ? destination[key]!.map(String) : [];
    const approved = countries("approvedCountries").some((v) => v.toUpperCase() === country.toUpperCase());
    const pending = countries("pendingCountries").some((v) => v.toUpperCase() === country.toUpperCase());
    const disapproved = countries("disapprovedCountries").some((v) => v.toUpperCase() === country.toUpperCase());
    return [context, {
      approvedCountries: countries("approvedCountries"),
      pendingCountries: countries("pendingCountries"),
      disapprovedCountries: countries("disapprovedCountries"),
      approved,
      pending,
      disapproved,
      blockingIssues: blockingIssues(context),
    }];
  }));
  const evidence = { requiredContexts: REQUIRED_APPROVAL_CONTEXTS, contexts: contextEvidence, itemLevelIssues: issues };
  const contextResults = Object.values(contextEvidence) as Array<{ approved: boolean; pending: boolean; disapproved: boolean; blockingIssues: unknown[] }>;
  if (contextResults.some((result) => result.disapproved || result.blockingIssues.length > 0)) {
    return { status: "DISAPPROVED", evidence };
  }
  if (contextResults.every((result) => result.approved)) return { status: "APPROVED", evidence };
  return { status: "VERIFYING", evidence };
}

/**
 * Derive the Products resource name from a ProductInput resource name.
 *
 * productInputs:insert returns:  accounts/{id}/productInputs/online~en~LB~SKU1
 * Products GET endpoint needs:   accounts/{id}/products/online~en~LB~SKU1
 *
 * The only difference is the path segment (/productInputs/ → /products/).
 */
export function deriveProductsResourceName(productInputName: string): string {
  return productInputName.replace("/productInputs/", "/products/");
}

/** Convert either stored resource form to the productInputs resource form. */
export function deriveProductInputResourceName(productResourceName: string): string {
  return productResourceName.replace("/products/", "/productInputs/");
}

/** HTTP status codes in error messages that indicate permanent failures (no retry). */
const PERMANENT_ERROR_CODES = [400, 401, 403, 404, 422];

/**
 * Returns true when the error message contains a permanent HTTP error code
 * (400, 401, 403, 404, 422) indicating the request will never succeed on retry.
 */
function isPermanentError(errorMsg: string): boolean {
  return PERMANENT_ERROR_CODES.some((code) => {
    // Match patterns like "HTTP 400", "status 400", " 400 ", or JSON "code":400
    const patterns = [
      new RegExp(`HTTP\\s+${code}\\b`, "i"),
      new RegExp(`status\\s*[=:]?\\s*${code}\\b`, "i"),
      new RegExp(`"code"\\s*:\\s*${code}\\b`),
      new RegExp(`\\b${code}\\b`), // broad fallback — any mention of the code
    ];
    return patterns.some((re) => re.test(errorMsg));
  });
}

interface MerchantSyncJobRow {
  id: string;
  product_id: number | null;
  operation: string;
  payload?: Record<string, unknown> | null;
}

interface MerchantDeletePayload {
  id?: number | null;
  sku?: string | null;
  merchantResourceName?: string | null;
  targetCountry?: string | null;
  contentLanguage?: string | null;
  reconciliationItemId?: number | null;
  offerId?: string | null;
  country?: string | null;
  stateIdentity?: {
    accountId?: string;
    dataSourceId?: string;
    dataSourceName?: string;
    replacement?: {
      accountId: string;
      dataSourceId: string;
      dataSourceName: string;
      country: "LB" | "AE";
      contentLanguage: string;
      offerId: string;
      payloadHash: string;
    } | null;
  };
}

/** Row from delivery_settings used to build the GMC shipping attribute. */
interface DeliverySettingsRow {
  workspace_owner_id: string;
  global_standard_fee: string | null;
  global_free_delivery_threshold: string | null;
}

/** Snake_case product row selected fresh at process time. */
export interface ProductSyncRow {
  id: number;
  workspace_owner_id: string;
  name: string;
  price_usd: string | null;
  price_aed: string | null;
  discount_price_usd: string | null;
  discount_price_aed: string | null;
  main_image_url: string | null;
  additional_image_urls: string[] | null;
  image_public_path: string | null;
  additional_image_public_paths: string[] | null;
  description: string | null;
  description_ar: string | null;
  status: string;
  brand: string | null;
  sku: string | null;
  is_archived: boolean;
  google_product_category: string | null;
  target_country: string | null;
  content_language: string | null;
  merchant_sync_disabled: boolean | null;
  merchant_resource_name?: string | null;
}

const PRODUCT_SYNC_COLUMNS = `id, workspace_owner_id, name, price_usd, price_aed,
       discount_price_usd, discount_price_aed,
       main_image_url, additional_image_urls,
       image_public_path, additional_image_public_paths,
       description, description_ar, status, brand, sku, is_archived,
       google_product_category, target_country, content_language,
       merchant_sync_disabled, merchant_resource_name`;

/**
 * Resolve a product's images to HTTPS URLs suitable for Google Merchant Center.
 *
 * - URLs that already start with https:// are used verbatim.
 * - Private /objects/... paths are substituted with their public-bucket copy
 *   (image_public_path / additional_image_public_paths) via buildPublicObjectUrl.
 * - Additional images with no HTTPS resolution are dropped (GMC rejects them).
 */
export function resolveHttpsImageUrls(row: ProductSyncRow): {
  mainImageUrl: string | null;
  additionalImageUrls: string[];
} {
  let mainImageUrl = row.main_image_url;
  if (mainImageUrl && !mainImageUrl.startsWith("https://")) {
    mainImageUrl = buildPublicObjectUrl(row.image_public_path) ?? mainImageUrl;
  }

  const additionalImageUrls = (row.additional_image_urls ?? [])
    .map((url, i) => {
      if (!url) return null;
      if (url.startsWith("https://")) return url;
      return buildPublicObjectUrl(row.additional_image_public_paths?.[i] ?? null);
    })
    .filter((u): u is string => typeof u === "string" && u.startsWith("https://"));

  return { mainImageUrl, additionalImageUrls };
}

/** True when the product has a private image without a public-bucket copy yet. */
export function needsImagePromotion(row: ProductSyncRow): boolean {
  const mainNeeds =
    !!row.main_image_url &&
    !row.main_image_url.startsWith("https://") &&
    !row.image_public_path;
  if (mainNeeds) return true;
  const additional = row.additional_image_urls ?? [];
  return additional.some(
    (url, i) =>
      !!url &&
      !url.startsWith("https://") &&
      !(row.additional_image_public_paths?.[i]),
  );
}

/** Build a Product-compatible object from a fresh row + resolved image URLs. */
function buildProductLike(
  row: ProductSyncRow,
  mainImageUrl: string | null,
  additionalImageUrls: string[],
): Product {
  const productLike = {
    id: row.id,
    name: row.name,
    priceUsd: row.price_usd,
    priceAed: row.price_aed,
    discountPriceUsd: row.discount_price_usd,
    discountPriceAed: row.discount_price_aed,
    mainImageUrl,
    additionalImageUrls,
    description: row.description,
    descriptionAr: row.description_ar,
    status: row.status,
    brand: row.brand,
    sku: row.sku,
    isArchived: row.is_archived,
    googleProductCategory: row.google_product_category,
    targetCountry: row.target_country,
    contentLanguage: row.content_language,
    // fields required by Product type but not used by buildMerchantProductInput
    workspaceOwnerId: row.workspace_owner_id,
    category: null,
    tags: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    expressDeliveryEnabled: true,
    hasInputField: false,
    letterInputEnabled: false,
    isUpsell: false,
    isCmc: false,
    inventoryTracked: false,
    merchantSyncDisabled: row.merchant_sync_disabled ?? false,
    merchantSyncStatus: null,
    merchantSyncError: null,
    merchantSyncedAt: null,
    merchantResourceName: null,
  };
  return productLike as unknown as Product;
}

async function markJobCompleted(jobId: string): Promise<void> {
  await db.query(
    `UPDATE merchant_sync_jobs
        SET status = 'COMPLETED', completed_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'RUNNING'`,
    [jobId],
  );
}

async function releaseDependentOfferJob(jobId: string): Promise<void> {
  await db.query(`UPDATE merchant_sync_jobs SET status='PENDING',updated_at=now()
    WHERE depends_on_job_id=$1 AND status='WAITING_DEPENDENCY'
      AND EXISTS (SELECT 1 FROM merchant_sync_jobs predecessor WHERE predecessor.id=$1 AND predecessor.status='COMPLETED')`, [jobId]);
}

async function completeDeleteAndRelease(jobId: string, reconciliationItemId: number): Promise<void> {
  const client = await db.connect();
  try {
    await withTransaction(client, async () => {
      const completed = await client.query(
        `UPDATE merchant_sync_jobs SET status='COMPLETED',completed_at=now(),updated_at=now()
          WHERE id=$1 AND status='RUNNING' RETURNING id`,
        [jobId],
      );
      if ((completed.rowCount ?? 0) !== 1) throw new Error("DELETE job was no longer RUNNING");
      const transitioned = await client.query(
        `UPDATE merchant_offer_states s SET deleted_at=now(),is_owned=FALSE,sync_status='DELETED',updated_at=now()
          FROM merchant_reconciliation_items i JOIN merchant_reconciliation_runs r ON r.id=i.run_id
          WHERE i.id=$1 AND s.workspace_owner_id=r.workspace_owner_id AND s.product_id=i.product_id
          AND s.country=i.country AND s.content_language=i.content_language AND s.offer_id=i.offer_id
          AND s.account_id=i.state_identity->>'accountId' AND s.data_source_id=i.state_identity->>'dataSourceId'
            AND s.is_owned IS TRUE AND s.deleted_at IS NULL RETURNING s.product_id`,
        [reconciliationItemId],
      );
      if ((transitioned.rowCount ?? 0) !== 1) throw new Error("Exact owned offer state could not be transitioned to deleted");
      await client.query(
        `UPDATE merchant_sync_jobs SET status='PENDING',updated_at=now()
          WHERE depends_on_job_id=$1 AND status='WAITING_DEPENDENCY'
            AND EXISTS (SELECT 1 FROM merchant_sync_jobs predecessor WHERE predecessor.id=$1 AND predecessor.status='COMPLETED')`,
        [jobId],
      );
    });
  } finally {
    client.release();
  }
}

/** Permanently fail a job (no retries) with the given error. */
async function markJobPermanentlyFailed(jobId: string, errorMsg: string): Promise<void> {
  await db.query(
    `UPDATE merchant_sync_jobs
        SET status = 'FAILED', last_error = $2, attempts = GREATEST(attempts, $3), updated_at = now()
      WHERE id = $1 AND status = 'RUNNING'`,
    [jobId, errorMsg, MAX_ATTEMPTS],
  );
}

function buildFallbackProductInputResourceName(
  payload: MerchantDeletePayload,
  row?: ProductSyncRow,
): string | null {
  const productId = payload.id ?? row?.id;
  const sku = (payload.sku ?? row?.sku)?.trim() || (productId != null ? `PRESENTAIL-${productId}` : null);
  const country = (payload.country ?? payload.targetCountry)?.trim().toUpperCase();
  const language = (payload.contentLanguage ?? row?.content_language)?.trim().toLowerCase();
  if (!sku || !country) return null;
  return `accounts/${process.env.GOOGLE_MERCHANT_ACCOUNT_ID}/productInputs/online~${language || "en"}~${country}~${sku}-${country}`;
}

/**
 * A CREATE_OR_UPDATE can be in flight when an owner excludes the product. If
 * Google accepts that stale create after the queued DELETE already ran, the
 * product would otherwise be resurrected. Re-arm any active delete (including
 * RUNNING) or add a fresh one so the final external state is always deleted.
 *
 * markJobCompleted only completes RUNNING jobs, so resetting a concurrently
 * running delete to PENDING prevents that stale worker from consuming the
 * re-armed job after its API call returns.
 */
async function ensureDeleteAfterLateCreate(
  product: ProductSyncRow,
  merchantResourceName: string | null,
): Promise<void> {
  // Legacy product-level creates have no offer ownership identity. Never invent
  // a country/delete target; reconciliation is the only permitted delete path.
  logger.warn({ productId: product.id }, "merchantSyncJob: late legacy create requires reconciliation review");
  return;
  /* c8 ignore start -- retained below only as historical migration reference */
  await db.query(
    `WITH rearmed AS (
       UPDATE merchant_sync_jobs
          SET status = 'PENDING',
              attempts = 0,
              last_error = NULL,
              next_retry_at = NULL,
              completed_at = NULL,
              payload = jsonb_build_object(
                'id', $1::int,
                'sku', $2::text,
                'merchantResourceName', $3::text,
                'targetCountry', $4::text,
                'contentLanguage', $5::text
              ),
              updated_at = now()
        WHERE product_id = $1
          AND operation = 'DELETE'
          AND status IN ('PENDING', 'RUNNING', 'RETRY_WAITING')
        RETURNING id
     )
     INSERT INTO merchant_sync_jobs
       (product_id, operation, status, payload, created_at, updated_at)
     SELECT $1, 'DELETE', 'PENDING',
            jsonb_build_object(
              'id', $1::int,
              'sku', $2::text,
              'merchantResourceName', $3::text,
              'targetCountry', $4::text,
              'contentLanguage', $5::text
            ),
            now(), now()
      WHERE NOT EXISTS (SELECT 1 FROM rearmed)
     ON CONFLICT DO NOTHING`,
    [
      product.id,
      product.sku,
      merchantResourceName,
      null,
      null,
    ],
  );
  /* c8 ignore stop */
}

async function processDeleteJob(
  job: MerchantSyncJobRow,
  row: ProductSyncRow | undefined,
): Promise<void> {
  const payload = (job.payload ?? {}) as MerchantDeletePayload;
  if (!merchantExecutionAllows({
    action: "DELETE",
    country: payload.country === "AE" ? "AE" : "LB",
    accountId: payload.stateIdentity?.accountId ?? "",
    dataSourceId: payload.stateIdentity?.dataSourceId ?? "",
    dataSourceName: payload.stateIdentity?.dataSourceName ?? "",
  })) {
    await markJobPermanentlyFailed(job.id, "Merchant DELETE is outside the configured execution scope");
    return;
  }
  // DELETE is intentionally impossible for legacy jobs. A guarded job must
  // reference an approved reconciliation item and the exact locally-owned offer.
  if (!payload.reconciliationItemId || !payload.offerId || !payload.country || !payload.contentLanguage) {
    await markJobPermanentlyFailed(job.id, "Unguarded legacy DELETE job refused; create and approve a reconciliation run");
    return;
  }
  const guard = await db.query<{ merchant_resource_name: string | null; account_id: string; data_source_id: string; data_source_name: string; country: "LB" | "AE"; workspace_owner_id: string; product_id: number }>(
    `SELECT s.merchant_resource_name, s.account_id, s.data_source_id, s.data_source_name, s.country,
            r.workspace_owner_id,i.product_id
       FROM merchant_reconciliation_items i
       JOIN merchant_reconciliation_runs r ON r.id=i.run_id
       JOIN merchant_offer_states s ON s.workspace_owner_id=r.workspace_owner_id AND s.product_id=i.product_id
          AND s.country=i.country AND s.content_language=i.content_language AND s.offer_id=i.offer_id
          AND s.account_id=i.state_identity->>'accountId' AND s.data_source_id=i.state_identity->>'dataSourceId'
      WHERE i.id=$1 AND i.action='DELETE' AND i.delete_approved IS TRUE
        AND r.status IN ('APPROVED','APPLIED','APPLYING') AND COALESCE((r.summary->>'blocked')::boolean,FALSE) IS FALSE
        AND s.is_owned IS TRUE AND s.deleted_at IS NULL
        AND s.account_id=i.state_identity->>'accountId' AND s.data_source_id=i.state_identity->>'dataSourceId'
        AND s.data_source_name=i.state_identity->>'dataSourceName'
         AND (COALESCE((i.state_identity->>'isLastOffer')::boolean,FALSE) IS FALSE OR i.last_offer_approved IS TRUE)
         AND (i.state_identity->'replacement'='null'::jsonb OR EXISTS (
           SELECT 1 FROM merchant_offer_states replacement
            WHERE replacement.workspace_owner_id=r.workspace_owner_id
              AND replacement.product_id=i.product_id
              AND replacement.account_id=i.state_identity->'replacement'->>'accountId'
              AND replacement.data_source_id=i.state_identity->'replacement'->>'dataSourceId'
              AND replacement.country=i.state_identity->'replacement'->>'country'
              AND replacement.content_language=i.state_identity->'replacement'->>'contentLanguage'
              AND replacement.offer_id=i.state_identity->'replacement'->>'offerId'
              AND replacement.payload_hash=i.state_identity->'replacement'->>'payloadHash'
              AND replacement.approval_status='APPROVED'
              AND replacement.is_owned IS TRUE AND replacement.deleted_at IS NULL))`,
    [payload.reconciliationItemId],
  );
  const storedResourceName = guard.rows[0]?.merchant_resource_name ?? null;
  if (!storedResourceName) {
    await markJobPermanentlyFailed(job.id, "Guarded DELETE refused: approved locally-owned offer state with resource name was not found");
    return;
  }
  const productInputName = deriveProductInputResourceName(storedResourceName);

  if (!merchantReconciliationExecutionEnabled()) {
    await markJobPermanentlyFailed(job.id, "Merchant reconciliation execution is disabled");
    return;
  }

  if (!(await allDesiredOffersApproved(guard.rows[0].workspace_owner_id, [guard.rows[0].country]))) {
    await markJobPermanentlyFailed(job.id, `Guarded DELETE refused: the ${guard.rows[0].country} replacement approval gate is no longer satisfied`);
    return;
  }

  const replacement = payload.stateIdentity?.replacement;
  if (replacement) {
    const replacementState = await db.query<{ merchant_resource_name: string; workspace_owner_id: string; product_id: number }>(
      `SELECT merchant_resource_name,workspace_owner_id,product_id
       FROM merchant_offer_states
       WHERE workspace_owner_id=$1 AND product_id=$2
         AND account_id=$3 AND data_source_id=$4 AND country=$5
         AND content_language=$6 AND offer_id=$7 AND payload_hash=$8
         AND approval_status='APPROVED' AND is_owned IS TRUE
         AND deleted_at IS NULL AND merchant_resource_name IS NOT NULL`,
      [guard.rows[0].workspace_owner_id, guard.rows[0].product_id, replacement.accountId, replacement.dataSourceId, replacement.country, replacement.contentLanguage, replacement.offerId, replacement.payloadHash],
    );
    const replacementRow = replacementState.rows[0];
    if (!replacementRow) {
      await markJobPermanentlyFailed(job.id, "Guarded DELETE refused: exact approved replacement evidence is missing");
      return;
    }
    try {
      const liveStatus = await fetchProductStatusForConfig({
        country: replacement.country,
        accountId: replacement.accountId,
        dataSourceId: replacement.dataSourceId,
        dataSourceName: replacement.dataSourceName,
      }, deriveProductsResourceName(replacementRow.merchant_resource_name));
      const parsed = parseGoogleOfferApproval(liveStatus, replacement.country);
      await db.query(
        `UPDATE merchant_offer_states
         SET approval_status=$1,approval_evidence=$2::jsonb,approval_checked_at=now(),
             last_error=CASE WHEN $1='APPROVED' THEN NULL ELSE 'Replacement is no longer approved; deletion remains blocked' END,
             updated_at=now()
         WHERE workspace_owner_id=$3 AND product_id=$4 AND account_id=$5
           AND data_source_id=$6 AND country=$7 AND content_language=$8
           AND offer_id=$9 AND payload_hash=$10`,
        [parsed.status, JSON.stringify(parsed.evidence), replacementRow.workspace_owner_id, replacementRow.product_id, replacement.accountId, replacement.dataSourceId, replacement.country, replacement.contentLanguage, replacement.offerId, replacement.payloadHash],
      );
      if (parsed.status !== "APPROVED") {
        await markJobPermanentlyFailed(job.id, "Guarded DELETE refused: replacement is not currently approved for both Free Listings and Shopping Ads");
        return;
      }
    } catch (error) {
      await markJobPermanentlyFailed(job.id, `Guarded DELETE refused: replacement approval recheck failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
  }

  try {
    await deleteProductInputForConfig({
      country: guard.rows[0].country,
      accountId: guard.rows[0].account_id,
      dataSourceId: guard.rows[0].data_source_id,
      dataSourceName: guard.rows[0].data_source_name,
    }, productInputName);
    logger.info(
      { jobId: job.id, productId: job.product_id },
      "merchantSyncJob: product removed from Google Merchant Center",
    );
    await completeDeleteAndRelease(job.id, payload.reconciliationItemId);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);

    // Google returns 404 when the product input is already absent. That is
    // the desired end state for an unsync operation, so make it idempotent.
    if (/HTTP\s+404\b/.test(errorMsg)) {
      logger.info(
        { jobId: job.id, productId: job.product_id },
        "merchantSyncJob: DELETE target was already absent from Google Merchant Center",
      );
      await completeDeleteAndRelease(job.id, payload.reconciliationItemId);
      return;
    }

    logger.warn(
      { jobId: job.id, productId: job.product_id, err },
      "merchantSyncJob: failed to remove product from Google Merchant Center",
    );
    const attemptsRes = await db.query<{ attempts: number }>(
      `SELECT attempts FROM merchant_sync_jobs WHERE id = $1`,
      [job.id],
    );
    const attempts = attemptsRes.rows[0]?.attempts ?? MAX_ATTEMPTS;
    const permanentFailure = attempts >= MAX_ATTEMPTS || isPermanentError(errorMsg);

    if (!permanentFailure) {
      const delayMinutes = Math.min(30, Math.pow(2, attempts));
      await db.query(
        `UPDATE merchant_sync_jobs
            SET status = 'RETRY_WAITING',
                last_error = $2,
                next_retry_at = now() + ($3 || ' minutes')::interval,
                updated_at = now()
          WHERE id = $1 AND status = 'RUNNING'`,
        [job.id, errorMsg, String(delayMinutes)],
      );
    } else {
      await markJobPermanentlyFailed(job.id, errorMsg);
    }

    if (job.product_id != null) {
      await db.query(
        `UPDATE products
            SET merchant_sync_status = 'FAILED',
                merchant_sync_error = $2
          WHERE id = $1`,
        [job.product_id, errorMsg],
      );
    }
  }
}

/**
 * Process a single claimed job. All external failures are handled inside;
 * throws only on unexpected programming errors (caught by the pool loop).
 *
 * `publicSlug` is the stored `product_publications.public_slug` for this
 * product (most-recent publication row). When non-empty it is used as the
 * product URL slug instead of the name-derived fallback.
 *
 * `deliveryConfig` is the workspace delivery settings used to attach the GMC
 * shipping attribute. Omitted gracefully when absent.
 */
async function processJob(job: MerchantSyncJobRow, row: ProductSyncRow | undefined, publicSlug?: string | null, deliveryConfig?: DeliveryConfig): Promise<void> {
  if (job.operation === "DELETE") {
    await processDeleteJob(job, row);
    return;
  }
  const guarded = job.payload as { reconciliationItemId?: number; offerId?: string; country?: "LB" | "AE"; contentLanguage?: string; executionScope?: string; stateIdentity?: { payload?: MerchantProductInput; payloadHash?: string; accountId?: string; dataSourceId?: string; dataSourceName?: string } } | undefined;
  if (guarded?.reconciliationItemId) {
    const verified = await db.query<{ workspace_owner_id: string; action: string; country: "LB" | "AE"; content_language: string; offer_id: string; payload: MerchantProductInput; payload_hash: string; predecessor_hash: string | null; account_id: string; data_source_id: string; data_source_name: string }>(
      `SELECT r.workspace_owner_id,i.action,i.country,i.content_language,i.offer_id,
              i.state_identity->'payload' AS payload,i.state_identity->>'payloadHash' AS payload_hash,
              i.state_identity->>'predecessorPayloadHash' AS predecessor_hash,
              i.state_identity->>'accountId' AS account_id,i.state_identity->>'dataSourceId' AS data_source_id,i.state_identity->>'dataSourceName' AS data_source_name
         FROM merchant_sync_jobs j JOIN merchant_reconciliation_items i ON i.id=j.reconciliation_item_id
         JOIN merchant_reconciliation_runs r ON r.id=i.run_id JOIN products p ON p.id=i.product_id
         LEFT JOIN merchant_offer_states s ON s.workspace_owner_id=r.workspace_owner_id AND s.product_id=i.product_id
            AND s.country=i.country AND s.content_language=i.content_language AND s.offer_id=i.offer_id
            AND s.account_id=i.state_identity->>'accountId' AND s.data_source_id=i.state_identity->>'dataSourceId'
        WHERE j.id=$1 AND j.reconciliation_item_id=$2 AND r.status='APPLIED'
          AND i.action IN ('CREATE','UPDATE') AND p.workspace_owner_id=r.workspace_owner_id
          AND j.offer_country=i.country AND j.offer_content_language=i.content_language
          AND NOT EXISTS (SELECT 1 FROM merchant_sync_jobs other WHERE other.id<>j.id AND other.product_id=j.product_id
            AND other.offer_country=j.offer_country AND other.offer_content_language=j.offer_content_language
            AND other.status IN ('PENDING','RUNNING','RETRY_WAITING'))
          AND ((i.action='CREATE' AND (s.product_id IS NULL OR s.is_owned IS FALSE OR s.deleted_at IS NOT NULL))
            OR (i.action='UPDATE' AND s.is_owned IS TRUE AND s.deleted_at IS NULL
              AND s.account_id=i.state_identity->>'accountId' AND s.data_source_id=i.state_identity->>'dataSourceId'
              AND s.data_source_name=i.state_identity->>'dataSourceName'
              AND s.payload_hash IS NOT DISTINCT FROM i.state_identity->>'predecessorPayloadHash'))
        FOR UPDATE OF j,i,r,p`,
      [job.id, guarded.reconciliationItemId],
    );
    const persisted = verified.rows[0];
    const identity = guarded.stateIdentity;
    if (!persisted || !guarded.offerId || guarded.offerId !== persisted.offer_id || guarded.country !== persisted.country || guarded.contentLanguage !== persisted.content_language ||
      JSON.stringify(identity?.payload) !== JSON.stringify(persisted.payload) || identity?.payloadHash !== persisted.payload_hash ||
      identity?.accountId !== persisted.account_id || identity?.dataSourceId !== persisted.data_source_id || identity?.dataSourceName !== persisted.data_source_name) {
      await markJobPermanentlyFailed(job.id, "Guarded create/update job lacks an explicit offer payload/configuration");
      return;
    }
    try {
      if (!merchantReconciliationExecutionEnabled()) {
        await markJobPermanentlyFailed(job.id, "Merchant reconciliation execution is disabled");
        return;
      }
      const activeScope = persisted.country === "AE"
        ? merchantExecutionScopeAe()
        : merchantExecutionScope();
      const requiresScopeBinding =
        activeScope === LEBANON_CREATE_AND_UPDATE_SCOPE
        || activeScope === LEBANON_CREATE_UPDATE_DELETE_SCOPE
        || activeScope === UAE_CREATE_ONLY_SCOPE
        || activeScope === UAE_CREATE_AND_UPDATE_SCOPE;
      if (requiresScopeBinding && guarded.executionScope !== activeScope) {
        await markJobPermanentlyFailed(job.id, "Merchant job was queued under a different execution scope");
        return;
      }
      if (!merchantExecutionAllows({
        action: persisted.action as "CREATE" | "UPDATE",
        country: persisted.country,
        accountId: persisted.account_id,
        dataSourceId: persisted.data_source_id,
        dataSourceName: persisted.data_source_name,
      })) {
        await markJobPermanentlyFailed(job.id, "Merchant operation is outside the configured execution scope");
        return;
      }
      const activeConfig = getMerchantAccountConfig(persisted.country);
      if (
        activeConfig.accountId !== persisted.account_id
        || activeConfig.dataSourceId !== persisted.data_source_id
        || activeConfig.dataSourceName !== persisted.data_source_name
      ) {
        await markJobPermanentlyFailed(job.id, `${persisted.country} Merchant destination changed after review; create a new reconciliation run`);
        return;
      }
      const response = await insertProductInputForConfig({ country: persisted.country, accountId: persisted.account_id, dataSourceId: persisted.data_source_id, dataSourceName: persisted.data_source_name }, persisted.payload);
      const name = typeof (response as Record<string, unknown>)?.name === "string" ? (response as Record<string, unknown>).name as string : null;
      await db.query(`INSERT INTO merchant_offer_states(workspace_owner_id,product_id,country,content_language,offer_id,account_id,data_source_id,data_source_name,merchant_resource_name,is_owned,sync_status,approval_status,approval_evidence,approval_checked_at,approval_deadline_at,payload_hash,payload_snapshot,last_synced_at,last_attempt_at,updated_at)
        SELECT r.workspace_owner_id,i.product_id,i.country,i.content_language,i.offer_id,$2,$3,$4,$5,TRUE,'SYNCED','VERIFYING',NULL,NULL,now() + INTERVAL '48 hours',$6,$7::jsonb,now(),now(),now()
        FROM merchant_reconciliation_items i JOIN merchant_reconciliation_runs r ON r.id=i.run_id WHERE i.id=$1
        ON CONFLICT(workspace_owner_id,product_id,country,content_language,account_id,data_source_id,offer_id) DO UPDATE SET merchant_resource_name=EXCLUDED.merchant_resource_name,is_owned=TRUE,sync_status='SYNCED',approval_status='VERIFYING',approval_evidence=NULL,approval_checked_at=NULL,approval_deadline_at=now() + INTERVAL '48 hours',payload_hash=EXCLUDED.payload_hash,payload_snapshot=EXCLUDED.payload_snapshot,last_synced_at=now(),last_error=NULL,updated_at=now()
        WHERE ($8='CREATE' AND merchant_offer_states.is_owned IS FALSE)
           OR ($8='UPDATE' AND merchant_offer_states.is_owned IS TRUE AND merchant_offer_states.deleted_at IS NULL
               AND merchant_offer_states.payload_hash IS NOT DISTINCT FROM $9)`,
        [guarded.reconciliationItemId, persisted.account_id, persisted.data_source_id, persisted.data_source_name, name, persisted.payload_hash, JSON.stringify(persisted.payload), persisted.action, persisted.predecessor_hash]);
      await markJobCompleted(job.id);
    } catch (err) { await markJobPermanentlyFailed(job.id, err instanceof Error ? err.message : String(err)); }
    return;
  }
  // Product-level jobs predate country-scoped ownership and cannot safely infer
  // a market. They are intentionally terminal until recreated via reconciliation.
  if (!guarded) {
    await markJobPermanentlyFailed(job.id, "Legacy CREATE_OR_UPDATE job refused: create a country reconciliation run");
    return;
  }

  // CREATE_OR_UPDATE — the payload is built from the CURRENT product row so
  // fixes made after enqueue time are picked up on the next attempt.
  if (!row) {
    logger.warn(
      { jobId: job.id, productId: job.product_id },
      "merchantSyncJob: product no longer exists — permanently failing job",
    );
    await markJobPermanentlyFailed(job.id, "Product no longer exists");
    return;
  }

  if (row.merchant_sync_disabled) {
    logger.info(
      { jobId: job.id, productId: row.id },
      "merchantSyncJob: merchant sync disabled for product — completing job without sending",
    );
    await markJobCompleted(job.id);
    return;
  }

  let productRow = row;

  // Promote private /objects/... images to the public bucket when they have no
  // public copy yet (public-image-bucket pattern), then re-read the public keys.
  if (needsImagePromotion(productRow)) {
    await syncProductPublicImages(
      productRow.id,
      productRow.main_image_url,
      (productRow.additional_image_urls ?? []).filter((u): u is string => !!u),
      productRow.workspace_owner_id,
    );
    const reread = await db.query<Pick<ProductSyncRow, "image_public_path" | "additional_image_public_paths">>(
      `SELECT image_public_path, additional_image_public_paths FROM products WHERE id = $1`,
      [productRow.id],
    );
    if (reread.rows[0]) {
      productRow = { ...productRow, ...reread.rows[0] };
    }
  }

  const { mainImageUrl, additionalImageUrls } = resolveHttpsImageUrls(productRow);
  const productLike = buildProductLike(productRow, mainImageUrl, additionalImageUrls);

  // Validation failures are product-data problems: retrying cannot fix them, so
  // fail the job permanently and surface an actionable error on the product row.
  const validation = validateMerchantProduct(productLike, publicSlug);
  if (!validation.valid) {
    const detail = validation.errors.join("; ");
    logger.warn(
      { jobId: job.id, productId: productRow.id, errors: validation.errors },
      "merchantSyncJob: product failed validation — permanent, needs product fix",
    );
    await markJobPermanentlyFailed(job.id, `[VALIDATION] ${detail}`);
    await db.query(
      `UPDATE products
          SET merchant_sync_status = 'ACTION_REQUIRED',
              merchant_sync_error  = $2
        WHERE id = $1`,
      [
        productRow.id,
        `Product data issue — fix the product, then re-sync: ${detail}`,
      ],
    );
    return;
  }

  try {
    const input: MerchantProductInput = buildMerchantProductInput(productLike, publicSlug, deliveryConfig);
    const googleResponse = (await insertProductInput(input)) as Record<string, unknown>;
    const googleResponseName = typeof googleResponse?.name === "string" ? googleResponse.name : null;

    logger.info(
      { jobId: job.id, productId: productRow.id, offerId: input.offerId, googleResponseName },
      "merchantSyncJob: product synced to Google Merchant Center",
    );

    // merchant_last_response is cleared so the deferred status-check pass
    // (checkSyncedProductStatuses) knows this sync has not been checked yet.
    const productUpdate = await db.query(
      `UPDATE products
          SET merchant_sync_status   = 'SYNCED',
              merchant_synced_at     = now(),
              merchant_sync_error    = NULL,
              merchant_resource_name = COALESCE($2, merchant_resource_name),
              merchant_last_response = NULL
         WHERE id = $1
           AND merchant_sync_disabled IS NOT TRUE
       RETURNING id`,
      [productRow.id, googleResponseName],
    );
    await markJobCompleted(job.id);

    if ((productUpdate.rowCount ?? 0) === 0) {
      logger.info(
        { jobId: job.id, productId: productRow.id },
        "merchantSyncJob: stale create completed after product exclusion; re-arming delete",
      );
      await ensureDeleteAfterLateCreate(productRow, googleResponseName);
    }
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.warn(
      { jobId: job.id, productId: productRow.id, err },
      "merchantSyncJob: failed to sync product",
    );

    // An insert can be accepted by Google while the client observes a
    // timeout/reset. If exclusion happened during that ambiguous request, the
    // response path above is unavailable, so re-arm deletion from the current
    // product state before recording the create failure.
    try {
      const currentProduct = await db.query<Pick<
        ProductSyncRow,
        "merchant_sync_disabled" | "merchant_resource_name" | "sku" | "target_country" | "content_language"
      >>(
        `SELECT merchant_sync_disabled, merchant_resource_name, sku, target_country, content_language
           FROM products
          WHERE id = $1`,
        [productRow.id],
      );
      const current = currentProduct.rows[0];
      if (current?.merchant_sync_disabled) {
        await ensureDeleteAfterLateCreate(
          { ...productRow, ...current },
          current.merchant_resource_name ?? null,
        );
      }
    } catch (rearmError) {
      logger.error(
        { jobId: job.id, productId: productRow.id, err: rearmError },
        "merchantSyncJob: failed to re-arm deletion after ambiguous create failure",
      );
    }

    // Fetch current attempt count to decide retry vs permanent failure.
    const attemptsRes = await db.query<{ attempts: number }>(
      `SELECT attempts FROM merchant_sync_jobs WHERE id = $1`,
      [job.id],
    );
    const attempts = attemptsRes.rows[0]?.attempts ?? MAX_ATTEMPTS;

    // Permanent HTTP errors (400/401/403/404/422) should never be retried.
    const permanentFailure = attempts >= MAX_ATTEMPTS || isPermanentError(errorMsg);

    if (!permanentFailure) {
      // Exponential back-off: min(30, 2^attempts) minutes
      const delayMinutes = Math.min(30, Math.pow(2, attempts));
      await db.query(
        `UPDATE merchant_sync_jobs
            SET status = 'RETRY_WAITING',
                last_error = $2,
                next_retry_at = now() + ($3 || ' minutes')::interval,
                updated_at = now()
           WHERE id = $1 AND status = 'RUNNING'`,
        [job.id, errorMsg, String(delayMinutes)],
      );
      logger.info(
        { jobId: job.id, productId: productRow.id, attempts, delayMinutes },
        "merchantSyncJob: job queued for retry",
      );
    } else {
      const reason = isPermanentError(errorMsg) ? "permanent HTTP error (no retry)" : "max attempts exhausted";
      logger.warn(
        { jobId: job.id, productId: productRow.id, attempts, reason },
        "merchantSyncJob: job permanently failed",
      );
      await markJobPermanentlyFailed(job.id, errorMsg);
    }

    await db.query(
      `UPDATE products
          SET merchant_sync_status = 'FAILED',
              merchant_sync_error  = $2
         WHERE id = $1 AND merchant_sync_disabled IS NOT TRUE`,
      [productRow.id, errorMsg],
    );
  }
}

export async function processPendingJobs(): Promise<void> {
  if (!merchantReconciliationExecutionEnabled()) return;
  const executionScope = merchantExecutionScopeSql();
  // Recover stale RUNNING jobs (crash recovery)
  await db.query(
    `UPDATE merchant_sync_jobs
        SET status = 'PENDING', updated_at = now()
      WHERE status = 'RUNNING'
        AND updated_at < now() - INTERVAL '${STALE_RUNNING_MINUTES} minutes'`,
  );

  // Atomically claim a batch of PENDING/RETRY_WAITING jobs and mark them RUNNING
  // in a single statement. FOR UPDATE SKIP LOCKED prevents a concurrent worker
  // from picking up the same rows.
  const res = await db.query<MerchantSyncJobRow>(
    `WITH claimed AS (
       UPDATE merchant_sync_jobs
          SET status = 'RUNNING', attempts = attempts + 1, updated_at = now()
        WHERE id IN (
          SELECT id FROM merchant_sync_jobs
           WHERE (status = 'PENDING'
              OR (status = 'RETRY_WAITING' AND next_retry_at <= now()))
             AND (${executionScope.clause})
           ORDER BY created_at ASC
           LIMIT $1
           FOR UPDATE SKIP LOCKED
        )
       RETURNING id, product_id, operation, payload
     )
     SELECT * FROM claimed`,
    [BATCH_SIZE, ...executionScope.params],
  );

  if (res.rows.length === 0) return;

  // Fetch the CURRENT product rows for all claimed jobs in one query.
  const productIds = Array.from(
    new Set(res.rows.map((j) => j.product_id).filter((id): id is number => id != null)),
  );
  const productMap = new Map<number, ProductSyncRow>();
  if (productIds.length > 0) {
    const productsRes = await db.query<ProductSyncRow>(
      `SELECT ${PRODUCT_SYNC_COLUMNS} FROM products WHERE id = ANY($1::int[])`,
      [productIds],
    );
    for (const p of productsRes.rows) productMap.set(p.id, p);
  }

  // Fetch delivery settings for each workspace that owns a product in this
  // batch. Used to attach the GMC shipping attribute so products are approved
  // (not just limited) in Shopping ads.
  const workspaceIds = Array.from(new Set([...productMap.values()].map((p) => p.workspace_owner_id)));
  const deliveryConfigMap = new Map<string, DeliveryConfig>();
  if (workspaceIds.length > 0) {
    const dsRes = await db.query<DeliverySettingsRow>(
      `SELECT workspace_owner_id, global_standard_fee, global_free_delivery_threshold
         FROM delivery_settings
        WHERE workspace_owner_id = ANY($1::text[])`,
      [workspaceIds],
    );
    for (const ds of dsRes.rows) {
      const standardFee = ds.global_standard_fee != null ? parseFloat(ds.global_standard_fee) : null;
      const freeThreshold = ds.global_free_delivery_threshold != null ? parseFloat(ds.global_free_delivery_threshold) : null;
      deliveryConfigMap.set(ds.workspace_owner_id, {
        globalStandardFee: Number.isFinite(standardFee as number) ? (standardFee as number) : null,
        globalFreeDeliveryThreshold: Number.isFinite(freeThreshold as number) ? (freeThreshold as number) : null,
      });
    }
  }

  // Fetch the most-recent publication slug per product so the GMC link uses the
  // stored public_slug (set in the Publishing tab) rather than the name-derived
  // fallback that can produce 404s when the product name was edited or a custom
  // slug was configured.
  const publicSlugMap = new Map<number, string | null>();
  if (productIds.length > 0) {
    const pubSlugsRes = await db.query<{ product_id: number; public_slug: string | null }>(
      `SELECT DISTINCT ON (product_id) product_id, public_slug
         FROM product_publications
        WHERE product_id = ANY($1::int[])
        ORDER BY product_id, updated_at DESC NULLS LAST`,
      [productIds],
    );
    for (const r of pubSlugsRes.rows) {
      publicSlugMap.set(r.product_id, r.public_slug);
    }
  }

  // Process with a small concurrency pool for throughput.
  const queue = [...res.rows];
  const workerLoop = async (): Promise<void> => {
    for (;;) {
      const job = queue.shift();
      if (!job) return;
      const productRow = job.product_id != null ? productMap.get(job.product_id) : undefined;
      const publicSlug = job.product_id != null ? (publicSlugMap.get(job.product_id) ?? null) : null;
      const deliveryConfig = productRow ? deliveryConfigMap.get(productRow.workspace_owner_id) : undefined;
      try {
        await processJob(job, productRow, publicSlug, deliveryConfig);
      } catch (err) {
        logger.warn({ jobId: job.id, err }, "merchantSyncJob: unexpected job processing error");
        try {
          await markJobPermanentlyFailed(job.id, err instanceof Error ? err.message : String(err));
        } catch {
          // best-effort — the stale-RUNNING recovery will eventually reclaim it
        }
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(JOB_CONCURRENCY, queue.length) }, () => workerLoop()),
  );
}

/**
 * Deferred, lightweight status-check pass.
 *
 * Instead of sleeping 5–50s inside every job waiting for Google to index the
 * product, recently-synced products (merchant_last_response IS NULL) are polled
 * here — at most STATUS_CHECK_BATCH per tick, one GET each, no sleeps. Item-level
 * issues are recorded on merchant_sync_error; the check result is stored in
 * merchant_last_response so each sync is only checked once (404 "not indexed
 * yet" leaves the row unchecked for the next tick, bounded by a 2-hour window).
 */
export async function checkSyncedProductStatuses(): Promise<void> {
  if (!merchantReconciliationExecutionEnabled()) return;
  // Legacy product-level status rows have no explicit market identity and are
  // never inspected while a write scope is active.
  if (merchantExecutionScope()) return;
  const res = await db.query<{ id: number; merchant_resource_name: string }>(
    `SELECT id, merchant_resource_name
       FROM products
      WHERE merchant_sync_status = 'SYNCED'
        AND merchant_resource_name IS NOT NULL
        AND merchant_last_response IS NULL
        AND merchant_synced_at > now() - INTERVAL '2 hours'
        AND merchant_synced_at < now() - INTERVAL '60 seconds'
      ORDER BY merchant_synced_at ASC
      LIMIT ${STATUS_CHECK_BATCH}`,
  );

  for (const row of res.rows) {
    const productsResourceName = deriveProductsResourceName(row.merchant_resource_name);
    try {
      const statusRaw = await fetchProductStatus(productsResourceName);
      const statusRecord = statusRaw as Record<string, unknown>;
      // Google returns a singular "productStatus" object (not plural)
      const productStatus = statusRecord?.productStatus as Record<string, unknown> | undefined;
      const itemLevelIssues = Array.isArray(productStatus?.itemLevelIssues)
        ? (productStatus.itemLevelIssues as Array<Record<string, unknown>>)
        : [];

      let issueError: string | null = null;
      if (itemLevelIssues.length > 0) {
        const first = itemLevelIssues[0];
        const issueTitle = typeof first?.title === "string" ? first.title : undefined;
        const issueStatus = typeof first?.servability === "string" ? first.servability : undefined;
        issueError = [issueStatus, issueTitle].filter(Boolean).join(": ") || "Google reported an item-level issue";
        logger.warn(
          { productId: row.id, issueCount: itemLevelIssues.length, firstIssue: first },
          "merchantSyncJob: Google reported item-level issues",
        );
      }

      await db.query(
        `UPDATE products
            SET merchant_last_response = $2::jsonb,
                merchant_sync_error    = $3
          WHERE id = $1`,
        [
          row.id,
          JSON.stringify({
            checkedAt: new Date().toISOString(),
            issueCount: itemLevelIssues.length,
            ...(itemLevelIssues.length > 0 ? { firstIssue: itemLevelIssues[0] } : {}),
          }),
          issueError,
        ],
      );
    } catch (pollErr) {
      const pollErrMsg = pollErr instanceof Error ? pollErr.message : String(pollErr);
      if (/HTTP\s+404\b/.test(pollErrMsg)) {
        // Not yet indexed — leave unchecked; retried next tick within the window.
        logger.info(
          { productId: row.id },
          "merchantSyncJob: product not yet indexed (404), will re-check next tick",
        );
        continue;
      }
      // Unexpected error — record the check so this row does not loop forever.
      logger.warn(
        { productId: row.id, err: pollErr },
        "merchantSyncJob: status check failed unexpectedly (non-fatal)",
      );
      await db.query(
        `UPDATE products SET merchant_last_response = $2::jsonb WHERE id = $1`,
        [row.id, JSON.stringify({ checkedAt: new Date().toISOString(), checkError: pollErrMsg })],
      );
    }
  }
}

/** Poll persisted offer evidence. Disapprovals and locally timed-out reviews
 * remain eligible for slower rechecks because Google's evaluation can change. */
export async function checkPendingOfferApprovals(): Promise<void> {
  if (!merchantReconciliationExecutionEnabled()) return;
  await db.query(`UPDATE merchant_offer_states
    SET approval_status='TIMED_OUT',
        last_error='Google approval was not confirmed within 48 hours; deletion remains blocked',
        approval_checked_at=now(),updated_at=now()
    WHERE is_owned IS TRUE AND deleted_at IS NULL
      AND approval_status IN ('PENDING','VERIFYING','ERROR')
      AND approval_deadline_at <= now()`);
  const scope = merchantExecutionScope();
  const aeScope = merchantExecutionScopeAe();
  const isLebanonWriteScope =
    scope === LEBANON_CREATE_ONLY_SCOPE
    || scope === LEBANON_CREATE_AND_UPDATE_SCOPE
    || scope === LEBANON_CREATE_UPDATE_DELETE_SCOPE;
  const isUaeWriteScope =
    aeScope === UAE_CREATE_ONLY_SCOPE
    || aeScope === UAE_CREATE_AND_UPDATE_SCOPE;
  const scopeConditions: string[] = [];
  const scopeParams: Array<number | string> = [STATUS_CHECK_BATCH];
  const addScopeParam = (value: string): string => {
    scopeParams.push(value);
    return `$${scopeParams.length}`;
  };
  if (isLebanonWriteScope) {
    const account = addScopeParam(LEBANON_ACCOUNT_ID);
    const dataSource = addScopeParam(LEBANON_DATA_SOURCE_ID);
    const dataSourceName = addScopeParam(LEBANON_DATA_SOURCE_NAME);
    scopeConditions.push(
      `(country='LB' AND account_id=${account} AND data_source_id=${dataSource} AND data_source_name=${dataSourceName})`,
    );
  }
  if (isUaeWriteScope) {
    const account = addScopeParam(UAE_ACCOUNT_ID);
    const dataSource = addScopeParam(UAE_DATA_SOURCE_ID);
    const dataSourceName = addScopeParam(UAE_DATA_SOURCE_NAME);
    scopeConditions.push(
      `(country='AE' AND account_id=${account} AND data_source_id=${dataSource} AND data_source_name=${dataSourceName})`,
    );
  }
  const scopeClause = scopeConditions.length > 0
    ? `AND (${scopeConditions.join(" OR ")})`
    : "AND FALSE";
  const pending = await db.query<{ workspace_owner_id: string; product_id: number; country: string; content_language: string; account_id: string; data_source_id: string; data_source_name: string; offer_id: string; merchant_resource_name: string; approval_status: string }>(
    `SELECT workspace_owner_id,product_id,country,content_language,account_id,data_source_id,data_source_name,offer_id,merchant_resource_name,approval_status
       FROM merchant_offer_states
      WHERE is_owned IS TRUE AND deleted_at IS NULL
        AND NULLIF(merchant_resource_name,'') IS NOT NULL
        AND (
          (approval_status IN ('PENDING','VERIFYING','ERROR') AND approval_deadline_at > now())
          OR (
            approval_status='DISAPPROVED'
            AND (
              approval_checked_at IS NULL
              OR approval_checked_at <= now() - INTERVAL '${DISAPPROVED_RECHECK_HOURS} hour'
            )
          )
          OR (
            approval_status='TIMED_OUT'
            AND (
              approval_checked_at IS NULL
              OR approval_checked_at <= now() - INTERVAL '${TIMED_OUT_RECHECK_HOURS} hours'
            )
          )
        )
        ${scopeClause}
       ORDER BY COALESCE(approval_checked_at,last_synced_at) ASC NULLS FIRST LIMIT $1`, scopeParams,
  );
  for (const offer of pending.rows) {
    if (!offer.merchant_resource_name) continue;
    try {
      const raw = await fetchProductStatusForConfig({ country: offer.country as "LB" | "AE", accountId: offer.account_id, dataSourceId: offer.data_source_id, dataSourceName: offer.data_source_name }, deriveProductsResourceName(offer.merchant_resource_name));
      const parsed = parseGoogleOfferApproval(raw, offer.country);
      await db.query(`UPDATE merchant_offer_states
        SET approval_status=CASE
              WHEN $1='VERIFYING' AND approval_deadline_at <= now() THEN 'TIMED_OUT'
              ELSE $1
            END,
            approval_evidence=$2::jsonb,approval_checked_at=now(),
            last_error=CASE
              WHEN $1='DISAPPROVED' THEN 'Google reports this offer as disapproved; deletion remains blocked'
              WHEN $1='VERIFYING' AND approval_deadline_at <= now()
                THEN 'Google approval was not confirmed within 48 hours; deletion remains blocked'
              ELSE NULL
            END,
            updated_at=now()
        WHERE workspace_owner_id=$3 AND product_id=$4 AND country=$5 AND content_language=$6 AND account_id=$7 AND data_source_id=$8 AND offer_id=$9`,
        [parsed.status, JSON.stringify(parsed.evidence), offer.workspace_owner_id, offer.product_id, offer.country, offer.content_language, offer.account_id, offer.data_source_id, offer.offer_id]);
    } catch (error) {
      await db.query(`UPDATE merchant_offer_states
        SET approval_status=CASE
              WHEN $1='DISAPPROVED' THEN 'DISAPPROVED'
              WHEN $1='TIMED_OUT' THEN 'TIMED_OUT'
              WHEN approval_deadline_at <= now() THEN 'TIMED_OUT'
              ELSE 'ERROR'
            END,
            approval_evidence=CASE WHEN $1 IN ('DISAPPROVED','TIMED_OUT') THEN approval_evidence ELSE $2::jsonb END,
            last_error=$3,approval_checked_at=now(),updated_at=now()
        WHERE workspace_owner_id=$4 AND product_id=$5 AND country=$6 AND content_language=$7 AND account_id=$8 AND data_source_id=$9 AND offer_id=$10`,
        [offer.approval_status, JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), error instanceof Error ? error.message : String(error), offer.workspace_owner_id, offer.product_id, offer.country, offer.content_language, offer.account_id, offer.data_source_id, offer.offer_id]);
    }
  }
}

export function startMerchantSyncJob(): void {
  if (!merchantReconciliationExecutionEnabled()) {
    logger.info("Merchant reconciliation execution disabled; no Google calls will be made");
    return;
  }
  // Validate GMC configuration at startup so misconfigurations appear in logs immediately.
  validateMerchantConfig();

  // Guard against overlapping ticks double-processing (a large batch can take
  // longer than one poll interval).
  let tickRunning = false;
  const tick = async () => {
    if (tickRunning) {
      logger.info("merchantSyncJob: previous tick still running — skipping this tick");
      return;
    }
    tickRunning = true;
    try {
      await processPendingJobs();
      await checkSyncedProductStatuses();
      await checkPendingOfferApprovals();
    } catch (err) {
      logger.warn({ err }, "merchantSyncJob: tick error");
    } finally {
      tickRunning = false;
    }
  };

  setInterval(tick, POLL_INTERVAL_MS);
  setTimeout(tick, INITIAL_DELAY_MS);
  logger.info("Merchant Center sync background job started");
}
