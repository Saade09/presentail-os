import type { Product } from "@workspace/db/schema";
import { db } from "./db";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Payload type — snapshot of product fields needed by googleMerchant.ts
// ---------------------------------------------------------------------------

export interface MerchantSyncPayload {
  id: number;
  name: string;
  priceUsd: string | null;
  priceAed: string | null;
  discountPriceUsd: string | null;
  discountPriceAed: string | null;
  mainImageUrl: string | null;
  additionalImageUrls: string[];
  description: string | null;
  descriptionAr: string | null;
  status: string;
  brand: string | null;
  sku: string | null;
  isArchived: boolean;
  category: string | null;
  googleProductCategory: string | null;
  targetCountry: string | null;
  contentLanguage: string | null;
}

export type MerchantSyncOperation = "CREATE_OR_UPDATE" | "DELETE";

// ---------------------------------------------------------------------------
// buildMerchantSyncPayload — snapshot of product fields for the queue row
// ---------------------------------------------------------------------------

export function buildMerchantSyncPayload(product: Product): MerchantSyncPayload {
  return {
    id: product.id,
    name: product.name,
    priceUsd: product.priceUsd,
    priceAed: product.priceAed,
    discountPriceUsd: product.discountPriceUsd ?? null,
    discountPriceAed: product.discountPriceAed ?? null,
    mainImageUrl: product.mainImageUrl ?? null,
    additionalImageUrls: product.additionalImageUrls ?? [],
    description: product.description ?? null,
    descriptionAr: product.descriptionAr ?? null,
    status: product.status,
    brand: product.brand ?? null,
    sku: product.sku ?? null,
    isArchived: product.isArchived,
    category: null,
    googleProductCategory: product.googleProductCategory ?? null,
    targetCountry: product.targetCountry ?? null,
    contentLanguage: product.contentLanguage ?? null,
  };
}

// ---------------------------------------------------------------------------
// enqueueMerchantSyncJob — raw INSERT of a PENDING job row
// ---------------------------------------------------------------------------

export async function enqueueMerchantSyncJob(
  product: Product,
  operation: MerchantSyncOperation,
): Promise<void> {
  const payload = buildMerchantSyncPayload(product);
  await db.query(
    `INSERT INTO merchant_sync_jobs (product_id, operation, status, payload, created_at, updated_at)
     VALUES ($1, $2, 'PENDING', $3::jsonb, now(), now())
     ON CONFLICT DO NOTHING`,
    [product.id, operation, JSON.stringify(payload)],
  );
  logger.info(
    { productId: product.id, operation },
    "merchantSyncQueue: job enqueued",
  );
}

// ---------------------------------------------------------------------------
// markProductMerchantPending — UPDATE products to set PENDING + clear error
// ---------------------------------------------------------------------------

export async function markProductMerchantPending(productId: number): Promise<void> {
  await db.query(
    `UPDATE products
        SET merchant_sync_status = 'PENDING',
            merchant_sync_error  = NULL
      WHERE id = $1`,
    [productId],
  );
}

// ---------------------------------------------------------------------------
// enqueueProductCreateOrUpdateSync — INSERT job + mark product PENDING
// Skips when product.merchantSyncDisabled is true.
// ---------------------------------------------------------------------------

export async function enqueueProductCreateOrUpdateSync(product: Product): Promise<void> {
  if (product.merchantSyncDisabled) {
    logger.info(
      { productId: product.id },
      "merchantSyncQueue: skipping CREATE_OR_UPDATE — merchantSyncDisabled is true",
    );
    return;
  }
  // A product row does not own a Merchant market. Automatic triggers must not
  // revive the retired target_country default; an owner must reconcile LB/AE.
  await db.query(
    `UPDATE products SET merchant_sync_status='ACTION_REQUIRED',
      merchant_sync_error='Merchant reconciliation required: choose an explicit country' WHERE id=$1`,
    [product.id],
  );
  logger.info({ productId: product.id }, "merchantSyncQueue: automatic sync withheld pending country reconciliation");
}

// ---------------------------------------------------------------------------
// enqueueMerchantSyncBackfill — enqueue the ENTIRE eligible catalog (no cap).
//
// 1. Stale active jobs are reset back to PENDING so previously-stuck products
//    get re-processed instead of being skipped forever:
//      - RETRY_WAITING jobs (regardless of backoff) restart immediately, and
//      - RUNNING jobs untouched for 10+ minutes (crashed worker) are reclaimed.
// 2. Every eligible product without an active job gets a new PENDING job in a
//    single batched INSERT ... SELECT (payloads are built at process time by
//    the worker, so only the product id is stored).
//
// Returns { enqueued, inserted, reset } where enqueued = inserted + reset.
// ---------------------------------------------------------------------------

export interface MerchantSyncBackfillResult {
  /** Total jobs now queued because of this call (inserted + reset). */
  enqueued: number;
  /** Newly created jobs. */
  inserted: number;
  /** Previously-stuck jobs reset back to PENDING. */
  reset: number;
}

export interface SelectedMerchantSyncResult {
  /** Newly queued selected products. */
  queued: number;
  /** Requested products skipped because they are foreign, unavailable, disabled, or already active. */
  skipped: number;
}

export interface SelectedMerchantUnsyncResult {
  /** Products in this workspace that were persistently excluded. */
  excluded: number;
  /** New DELETE jobs queued for products that have a GMC identifier. */
  queued: number;
  /** Requested IDs that were not products in this workspace. */
  skipped: number;
}

/**
 * Queue only the requested eligible products for an immediate Merchant Center
 * re-sync. Unlike the full-catalog backfill, this never resets an active job:
 * callers deliberately chose specific products, so PENDING/RUNNING/RETRY_WAITING
 * rows are skipped to avoid duplicate work. Completed and failed jobs do not
 * block a fresh job.
 *
 * Jobs retain the process-time payload pattern and store only the product id.
 */
export async function enqueueSelectedMerchantSync(
  workspaceId: string,
  productIds: number[],
): Promise<SelectedMerchantSyncResult> {
  const requestedIds = Array.from(new Set(productIds));
  if (requestedIds.length === 0) {
    return { queued: 0, skipped: 0 };
  }

  const result = await db.query<{ queued: number; skipped: number }>(
    `WITH requested AS (
       SELECT DISTINCT unnest($2::int[]) AS id
     ),
     eligible AS (
       SELECT p.id
         FROM products p
         JOIN requested r ON r.id = p.id
        WHERE p.workspace_owner_id = $1
          AND p.status = 'available'
          AND p.is_archived IS NOT TRUE
          AND p.merchant_sync_disabled IS NOT TRUE
          AND NOT EXISTS (
            SELECT 1
              FROM merchant_sync_jobs j
             WHERE j.product_id = p.id
               AND j.status IN ('PENDING', 'RUNNING', 'RETRY_WAITING')
          )
     ),
     inserted AS (
       INSERT INTO merchant_sync_jobs (product_id, operation, status, payload, created_at, updated_at)
       SELECT id, 'CREATE_OR_UPDATE', 'PENDING', jsonb_build_object('id', id), now(), now()
         FROM eligible
       ON CONFLICT DO NOTHING
       RETURNING product_id
     ),
     marked AS (
       UPDATE products p
          SET merchant_sync_status = 'PENDING',
              merchant_sync_error = NULL
         FROM inserted i
        WHERE p.id = i.product_id
          AND p.workspace_owner_id = $1
       RETURNING p.id
     )
     SELECT
       (SELECT COUNT(*)::int FROM marked) AS queued,
       (
         (SELECT COUNT(*) FROM requested) -
         (SELECT COUNT(*) FROM marked)
       )::int AS skipped`,
    [workspaceId, requestedIds],
  );

  const queued = Number(result.rows[0]?.queued ?? 0);
  const skipped = Number(result.rows[0]?.skipped ?? requestedIds.length - queued);
  const selectedResult = { queued, skipped };
  logger.info({ workspaceId, requested: requestedIds.length, ...selectedResult }, "merchantSyncQueue: selected products queued");
  return selectedResult;
}

/**
 * Persistently exclude selected products from GMC and queue their removal.
 *
 * This is intentionally one SQL statement: the workspace check, disable,
 * superseding of active CREATE_OR_UPDATE work, and DELETE insertion must share
 * one database snapshot. DELETE jobs use the stored resource name when
 * available and otherwise retain the deterministic identifiers needed by the
 * worker to reconstruct it.
 */
export async function enqueueSelectedMerchantUnsync(
  workspaceId: string,
  productIds: number[],
): Promise<SelectedMerchantUnsyncResult> {
  const requestedIds = Array.from(new Set(productIds));
  if (requestedIds.length === 0) {
    return { excluded: 0, queued: 0, skipped: 0 };
  }

  const result = await db.query<{
    excluded: number;
    queued: number;
    skipped: number;
  }>(
    `WITH requested AS (
       SELECT DISTINCT unnest($2::int[]) AS id
     ),
     owned AS (
       SELECT p.*
         FROM products p
         JOIN requested r ON r.id = p.id
        WHERE p.workspace_owner_id = $1
     ),
     disabled AS (
       UPDATE products p
          SET merchant_sync_disabled = TRUE,
              merchant_sync_status = 'DISABLED',
              merchant_sync_error = NULL,
              merchant_last_response = NULL
         FROM owned o
        WHERE p.id = o.id
        RETURNING p.id
     ),
     superseded AS (
       UPDATE merchant_sync_jobs j
          SET status = 'FAILED',
              last_error = 'Superseded by product exclusion from Google Merchant Center',
              updated_at = now()
         FROM disabled d
        WHERE j.product_id = d.id
          AND j.operation = 'CREATE_OR_UPDATE'
          AND j.status IN ('PENDING', 'RUNNING', 'RETRY_WAITING')
        RETURNING j.id, j.product_id
     ),
     delete_candidates AS (
       SELECT o.id, o.sku, o.merchant_resource_name, o.target_country, o.content_language
         FROM owned o
         JOIN disabled d ON d.id = o.id
        WHERE o.merchant_resource_name IS NOT NULL
           OR o.merchant_synced_at IS NOT NULL
           OR o.merchant_sync_status IN ('PENDING', 'SYNCED', 'FAILED', 'ACTION_REQUIRED')
           OR EXISTS (SELECT 1 FROM superseded s WHERE s.product_id = o.id)
           OR EXISTS (
             SELECT 1
               FROM merchant_sync_jobs j
              WHERE j.product_id = o.id
                AND j.operation = 'DELETE'
                AND j.status IN ('PENDING', 'RUNNING', 'RETRY_WAITING')
           )
     ),
     inserted AS (
       INSERT INTO merchant_sync_jobs
         (product_id, operation, status, payload, created_at, updated_at)
       SELECT id, 'DELETE', 'PENDING',
              jsonb_build_object(
                'id', id,
                'sku', sku,
                'merchantResourceName', merchant_resource_name,
                'targetCountry', target_country,
                'contentLanguage', content_language
              ),
              now(), now()
         FROM delete_candidates
       ON CONFLICT DO NOTHING
       RETURNING product_id
     )
     SELECT
       (SELECT COUNT(*)::int FROM disabled) AS excluded,
       (SELECT COUNT(*)::int FROM inserted) AS queued,
       ((SELECT COUNT(*) FROM requested) - (SELECT COUNT(*) FROM disabled))::int AS skipped`,
    [workspaceId, requestedIds],
  );

  const row = result.rows[0];
  const unsyncResult = {
    excluded: Number(row?.excluded ?? 0),
    queued: Number(row?.queued ?? 0),
    skipped: Number(row?.skipped ?? requestedIds.length),
  };
  logger.info(
    { workspaceId, requested: requestedIds.length, ...unsyncResult },
    "merchantSyncQueue: selected products excluded from GMC",
  );
  return unsyncResult;
}

export async function enqueueMerchantSyncBackfill(
  workspaceId: string,
): Promise<MerchantSyncBackfillResult> {
  // Step 1 — reset stale active jobs so their products re-sync now.
  const resetRes = await db.query<{ count: number }>(
    `WITH reset AS (
       UPDATE merchant_sync_jobs j
          SET status = 'PENDING',
              attempts = 0,
              last_error = NULL,
              next_retry_at = NULL,
              updated_at = now()
         FROM products p
        WHERE p.id = j.product_id
          AND p.workspace_owner_id = $1
          AND (
            j.status = 'RETRY_WAITING'
            OR (j.status = 'RUNNING' AND j.updated_at < now() - INTERVAL '10 minutes')
          )
       RETURNING j.product_id
     ),
     marked AS (
       UPDATE products
          SET merchant_sync_status = 'PENDING',
              merchant_sync_error  = NULL
        WHERE id IN (SELECT product_id FROM reset)
       RETURNING id
     )
     SELECT COUNT(*)::int AS count FROM reset`,
    [workspaceId],
  );
  const reset = Number(resetRes.rows[0]?.count ?? 0);

  // Step 2 — enqueue every eligible product without an active job. No LIMIT:
  // the whole catalog is covered in one batched INSERT ... SELECT.
  const insertRes = await db.query<{ count: number }>(
    `WITH eligible AS (
       SELECT p.id
         FROM products p
        WHERE p.workspace_owner_id = $1
          AND (p.merchant_sync_disabled IS NOT TRUE)
          AND NOT EXISTS (
            SELECT 1 FROM merchant_sync_jobs j
             WHERE j.product_id = p.id
               AND j.status IN ('PENDING', 'RUNNING', 'RETRY_WAITING')
          )
     ),
     inserted AS (
       INSERT INTO merchant_sync_jobs (product_id, operation, status, payload, created_at, updated_at)
       SELECT id, 'CREATE_OR_UPDATE', 'PENDING', jsonb_build_object('id', id), now(), now()
         FROM eligible
        ON CONFLICT DO NOTHING
       RETURNING product_id
     ),
     marked AS (
       UPDATE products
          SET merchant_sync_status = 'PENDING',
              merchant_sync_error  = NULL
        WHERE id IN (SELECT product_id FROM inserted)
       RETURNING id
     )
     SELECT COUNT(*)::int AS count FROM inserted`,
    [workspaceId],
  );
  const inserted = Number(insertRes.rows[0]?.count ?? 0);

  const result: MerchantSyncBackfillResult = {
    enqueued: inserted + reset,
    inserted,
    reset,
  };
  logger.info({ workspaceId, ...result }, "merchantSyncQueue: backfill enqueued");
  return result;
}

// ---------------------------------------------------------------------------
// enqueueProductDeleteSync — INSERT DELETE job with minimal payload
// ---------------------------------------------------------------------------

export async function enqueueProductDeleteSync(product: Product): Promise<void> {
  logger.warn({ productId: product.id }, "merchantSyncQueue: legacy product delete withheld; reconciliation approval required");
  return;
  /* c8 ignore start */
  const payload = {
    id: product.id,
    sku: product.sku ?? null,
    merchantResourceName: product.merchantResourceName ?? null,
  };
  await db.query(
    `INSERT INTO merchant_sync_jobs (product_id, operation, status, payload, created_at, updated_at)
      VALUES ($1, 'DELETE', 'PENDING', $2::jsonb, now(), now())
      ON CONFLICT DO NOTHING`,
    [product.id, JSON.stringify(payload)],
  );
  logger.info(
    { productId: product.id },
    "merchantSyncQueue: DELETE job enqueued",
  );
  /* c8 ignore stop */
}
