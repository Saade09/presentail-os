import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import sharp from "sharp";
import { editImageBuffers } from "@workspace/integrations-openai-ai-server/image";
import { callAI } from "./ai/callAI";
import { db, withTransaction } from "./db";
import { logger } from "./logger";
import { objectStorageService } from "./objectStorage";

export const GALLERY_TYPES = [
  "alternative_composition",
  "close_up_details",
  "lifestyle_setting",
  "hand_held_scale",
] as const;
export type GalleryType = (typeof GALLERY_TYPES)[number];

export const PRODUCT_GALLERY_MODEL = process.env.PRODUCT_GALLERY_IMAGE_MODEL ?? "gpt-image-2";
export const PRODUCT_GALLERY_QUALITY = process.env.PRODUCT_GALLERY_IMAGE_QUALITY ?? "medium";
export const PRODUCT_GALLERY_SIZE = "1024x1024";
export const PRODUCT_GALLERY_FORMAT = "webp";
export const PRODUCT_GALLERY_PROMPT_VERSION = "product-gallery-fidelity-v2";

export const PRODUCT_GALLERY_MAX_ATTEMPTS = 3;
export const PRODUCT_GALLERY_PROVIDER_TIMEOUT_MS = positiveIntegerEnv(
  "PRODUCT_GALLERY_IMAGE_TIMEOUT_MS",
  120_000,
);
export const PRODUCT_GALLERY_GLOBAL_CONCURRENCY = 2;
export const PRODUCT_GALLERY_CANCELLATION_GRACE_MS = positiveIntegerEnv(
  "PRODUCT_GALLERY_CANCELLATION_GRACE_MS",
  30_000,
);
const MAX_SOURCE_BYTES = 50 * 1024 * 1024;
const MAX_SOURCE_DIMENSION = 4096;
const LEASE_SECONDS = Math.ceil(PRODUCT_GALLERY_PROVIDER_TIMEOUT_MS / 1000) + 60;
const WORKER_SLOT_LOCK_BASE = 48_740_000;

function positiveIntegerEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

type GalleryError = {
  code: string;
  message: string;
  retryable: boolean;
};

type ProductSnapshot = {
  name: string;
  category: string | null;
  description: string | null;
  recipe: Array<{ name: string; quantity: string | number | null }>;
};

type ClaimedCandidate = {
  id: string;
  run_id: string;
  gallery_type: GalleryType;
  attempts: number;
  retry_count: number;
  lease_token: string;
  workspace_owner_id: string;
  product_id: number;
  source_path: string;
  source_version: string;
  product_snapshot: ProductSnapshot;
  model: string;
  quality: string;
  output_size: string;
  output_format: string;
  prompt_version: string;
};

type WorkerSlot = {
  client: PoolClient;
  slotLockId: number;
  candidateLockKey?: string;
};

export const PRODUCT_GALLERY_STALL_TIMEOUT_MS = positiveIntegerEnv(
  "PRODUCT_GALLERY_STALL_TIMEOUT_MS",
  15 * 60 * 1000,
);

export class ProductGalleryActiveRunError extends Error {
  code = "ACTIVE_RUN_EXISTS";

  constructor() {
    super("A gallery run is already active for this source image.");
    this.name = "ProductGalleryActiveRunError";
  }
}

export class ProductGalleryDeadlineError extends Error {
  code = "PROVIDER_TIMEOUT";
  readonly providerSettled: Promise<void>;

  constructor(timeoutMs: number, providerSettled: Promise<void>) {
    super(`Image provider timed out after ${timeoutMs}ms`);
    this.name = "AbortError";
    this.providerSettled = providerSettled;
  }
}

export async function withProductGalleryDeadline<T>(
  call: (signal: AbortSignal) => Promise<T>,
  timeoutMs = PRODUCT_GALLERY_PROVIDER_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const providerCall = Promise.resolve().then(() => call(controller.signal));
  const providerSettled = providerCall.then(
    () => undefined,
    () => undefined,
  );
  let timeout: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = new ProductGalleryDeadlineError(timeoutMs, providerSettled);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
    timeout.unref?.();
  });
  try {
    return await Promise.race([providerCall, deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function sourceVersion(sourcePath: string): string {
  return createHash("sha256").update(sourcePath).digest("hex");
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

export function classifyGalleryError(error: unknown): GalleryError {
  const value = error as { status?: number; code?: string; name?: string };
  const raw = errorText(error);
  const normalized = raw.toLowerCase();
  if (raw === "UNSUPPORTED_SOURCE_MEDIA") {
    return { code: "UNSUPPORTED_SOURCE_MEDIA", message: "The primary image must be a JPEG, PNG, or WebP file.", retryable: false };
  }
  if (raw === "INVALID_SOURCE_MEDIA") {
    return { code: "INVALID_SOURCE_MEDIA", message: "The primary image is missing, corrupt, or too large.", retryable: false };
  }
  if (raw === "STORAGE_WRITE_FAILED") {
    return { code: "STORAGE_WRITE_FAILED", message: "The generated image could not be saved. Retry when storage is available.", retryable: true };
  }
  if (value.status === 429 || normalized.includes("rate limit")) {
    return { code: "PROVIDER_RATE_LIMITED", message: "The image provider is busy. This draft will retry automatically.", retryable: true };
  }
  if (
    value.status === 408 ||
    value.name === "AbortError" ||
    normalized.includes("timeout") ||
    normalized.includes("timed out")
  ) {
    return { code: "PROVIDER_TIMEOUT", message: "The image provider timed out. This draft will retry automatically.", retryable: true };
  }
  if (
    value.status === 400 &&
    (normalized.includes("moderation") || normalized.includes("safety") || normalized.includes("content policy"))
  ) {
    return { code: "MODERATION_REFUSAL", message: "The provider could not generate this image because of its safety policy.", retryable: false };
  }
  if ((value.status ?? 0) >= 500) {
    return { code: "PROVIDER_UNAVAILABLE", message: "The image provider is temporarily unavailable.", retryable: true };
  }
  return { code: "GENERATION_FAILED", message: "This image could not be generated.", retryable: false };
}

export function galleryFailureDisposition(
  error: unknown,
  retryCount: number,
): { status: "RETRY_WAITING" | "FAILED"; error: GalleryError } {
  const classified = classifyGalleryError(error);
  return {
    status: classified.retryable && retryCount < PRODUCT_GALLERY_MAX_ATTEMPTS
      ? "RETRY_WAITING"
      : "FAILED",
    error: classified,
  };
}

function galleryDirection(type: GalleryType): string {
  switch (type) {
    case "alternative_composition":
      return "Create a clean studio composition with the same product arranged from a fresh angle.";
    case "close_up_details":
      return `Create a TRUE CLOSE-UP DETAIL photograph of the exact product in the reference image.
This is a camera push-in, not a new arrangement and not a full-product re-render:
- Fill approximately 85–95% of the square frame with the product details.
- Use a tight crop at close camera distance, with the flowers, wrapping, ribbon, container, and finishing large and clearly visible.
- It is acceptable for the pedestal, background, or outer edges of the container to be cropped out.
- Do not pull back to show the whole product. Do not merely add or emphasize a ribbon.
- Do not add, remove, replace, resize, recolor, or redesign any product component or accessory.`;
    case "lifestyle_setting":
      return "Place the unchanged product in a tasteful, neutral lifestyle environment.";
    case "hand_held_scale":
      return "Show natural hands holding the same product for scale. Do not modify its scale or contents.";
  }
}

export function buildGalleryPrompt(type: GalleryType, snapshot: ProductSnapshot): string {
  const recipe = snapshot.recipe.length
    ? snapshot.recipe.map((item) => `${item.name}${item.quantity == null ? "" : ` (${item.quantity})`}`).join(", ")
    : "No reliable recipe data is available.";
  return `${galleryDirection(type)}

Product data:
- Name: ${snapshot.name}
- Category: ${snapshot.category ?? "Not set"}
- Description: ${snapshot.description ?? "Not set"}
- Recipe/components: ${recipe}

The primary image is the authoritative visual reference. Preserve the exact product identity. Preserve flower types, flower count where visible, dominant colors, wrapping paper, ribbon, vase or container, and visible branding. Do not add cards, balloons, chocolates, gifts, or unrelated accessories. Do not change the product into a materially different bouquet or arrangement. If product text conflicts with the image, follow the primary image. Keep any additional scene secondary to the product. Produce a photorealistic premium ecommerce image with no added text or watermark.

Prompt version: ${PRODUCT_GALLERY_PROMPT_VERSION}.`;
}

async function audit(
  workspaceOwnerId: string,
  productId: number,
  runId: string | null,
  candidateId: string | null,
  eventType: string,
  actorId: string | null,
  details: Record<string, unknown> = {},
): Promise<void> {
  await db.query(
    `INSERT INTO product_gallery_audit_events
       (workspace_owner_id, product_id, run_id, candidate_id, event_type, actor_id, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [workspaceOwnerId, productId, runId, candidateId, eventType, actorId, details],
  );
}

export async function reconcileProductGalleryRuns(runIds?: readonly string[]): Promise<void> {
  await db.query(
    `WITH counts AS (
       SELECT
          run_id,
          count(*) FILTER (WHERE c.status IN ('PENDING','PROCESSING','RETRY_WAITING')) AS active,
          count(*) FILTER (WHERE c.status = 'FAILED') AS failed,
         count(*) AS total
        FROM product_gallery_candidates c
        JOIN product_gallery_runs candidate_run ON candidate_run.id=c.run_id
       WHERE (
         ($1::bigint[] IS NULL AND candidate_run.status IN ('PENDING','RUNNING','RETRY_WAITING'))
         OR c.run_id = ANY(COALESCE($1::bigint[], ARRAY[]::bigint[]))
       )
       GROUP BY c.run_id
     )
     UPDATE product_gallery_runs r
        SET status = CASE
          WHEN counts.active > 0 THEN CASE
            WHEN EXISTS (SELECT 1 FROM product_gallery_candidates WHERE run_id=r.id AND status='PROCESSING')
              THEN 'RUNNING'
            WHEN EXISTS (SELECT 1 FROM product_gallery_candidates WHERE run_id=r.id AND status='RETRY_WAITING')
              THEN 'RETRY_WAITING'
            ELSE 'PENDING' END
          WHEN counts.failed = counts.total THEN 'FAILED'
          WHEN counts.failed > 0 THEN 'PARTIAL'
          ELSE 'COMPLETED'
        END,
        completed_at = CASE WHEN counts.active = 0 THEN now() ELSE NULL END,
        lease_token = NULL,
        lease_until = NULL,
        updated_at = now()
       FROM counts
       WHERE r.id=counts.run_id`,
    [runIds?.length ? runIds : null],
  );
}

async function acquireWorkerSlot(): Promise<WorkerSlot | null> {
  const client = await db.connect();
  try {
    for (let slot = 0; slot < PRODUCT_GALLERY_GLOBAL_CONCURRENCY; slot += 1) {
      const slotLockId = WORKER_SLOT_LOCK_BASE + slot;
      const result = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock($1) AS acquired",
        [slotLockId],
      );
      if (result.rows[0]?.acquired) return { client, slotLockId };
    }
    client.release();
    return null;
  } catch (error) {
    client.release();
    throw error;
  }
}

async function releaseGlobalWorkerSlot(slot: WorkerSlot): Promise<void> {
  await slot.client.query("SELECT pg_advisory_unlock($1)", [slot.slotLockId]);
}

async function releaseCandidateOwnership(slot: WorkerSlot): Promise<void> {
  try {
    if (slot.candidateLockKey) {
      await slot.client.query(
        "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
        [slot.candidateLockKey],
      );
    }
  } finally {
    slot.client.release();
  }
}

async function releaseWorkerSlot(slot: WorkerSlot): Promise<void> {
  await releaseGlobalWorkerSlot(slot);
  await releaseCandidateOwnership(slot);
}

function cancellationGrace(): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, PRODUCT_GALLERY_CANCELLATION_GRACE_MS);
    timeout.unref?.();
  });
}

async function claimCandidate(slot: WorkerSlot): Promise<ClaimedCandidate | null> {
  const leaseToken = randomUUID();
  await slot.client.query("BEGIN");
  try {
    const due = await slot.client.query<{ id: string }>(
      `SELECT c.id
         FROM product_gallery_candidates c
         JOIN product_gallery_runs r ON r.id=c.run_id
        WHERE c.status IN ('PENDING','RETRY_WAITING')
           AND r.status IN ('PENDING','RUNNING','RETRY_WAITING')
          AND (c.next_attempt_at IS NULL OR c.next_attempt_at <= now())
           AND c.retry_count < $1
        ORDER BY c.created_at, c.id
        FOR UPDATE OF c SKIP LOCKED
         LIMIT 20`,
      [PRODUCT_GALLERY_MAX_ATTEMPTS],
    );
    if (!due.rows.length) {
      await slot.client.query("COMMIT");
      return null;
    }
    let id: string | undefined;
    for (const row of due.rows) {
      const candidateLockKey = `product-gallery-candidate:${row.id}`;
      const lock = await slot.client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
        [candidateLockKey],
      );
      if (lock.rows[0]?.acquired) {
        id = row.id;
        slot.candidateLockKey = candidateLockKey;
        break;
      }
    }
    if (!id) {
      await slot.client.query("COMMIT");
      return null;
    }
    const result = await slot.client.query<ClaimedCandidate>(
      `UPDATE product_gallery_candidates c
        SET status='PROCESSING',
            attempts=c.attempts+1,
            retry_count=c.retry_count+1,
            lease_token=$2,
            lease_until=now()+($3 || ' seconds')::interval,
            next_attempt_at=NULL,
            updated_at=now()
        FROM product_gallery_runs r
       WHERE c.id=$1 AND r.id=c.run_id
         AND r.status IN ('PENDING','RUNNING','RETRY_WAITING')
     RETURNING c.id, c.run_id, c.gallery_type, c.attempts, c.retry_count, c.lease_token,
       r.workspace_owner_id, r.product_id, r.source_path, r.source_version,
       r.product_snapshot, r.model, r.quality, r.output_size, r.output_format, r.prompt_version`,
      [id, leaseToken, LEASE_SECONDS],
    );
    const claimed = result.rows[0] ?? null;
    if (claimed) {
      await slot.client.query(
      `UPDATE product_gallery_runs
          SET status='RUNNING', lease_token=$2, lease_until=now()+($3 || ' seconds')::interval, updated_at=now()
        WHERE id=$1`,
        [claimed.run_id, leaseToken, LEASE_SECONDS],
      );
    }
    await slot.client.query("COMMIT");
    return claimed;
  } catch (error) {
    await slot.client.query("ROLLBACK").catch(() => {});
    if (slot.candidateLockKey) {
      await slot.client.query(
        "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
        [slot.candidateLockKey],
      ).catch(() => {});
      slot.candidateLockKey = undefined;
    }
    throw error;
  }
}

async function processCandidate(
  candidate: ClaimedCandidate,
): Promise<{ releaseAfter?: Promise<void> }> {
  const attemptNumber = candidate.attempts;
  const leaseToken = candidate.lease_token;
  const prompt = buildGalleryPrompt(candidate.gallery_type, candidate.product_snapshot);
  const config = {
    quality: candidate.quality,
    size: candidate.output_size,
    outputFormat: candidate.output_format,
  };
  let releaseAfter: Promise<void> | undefined;

  try {
    await db.query(
      `INSERT INTO product_gallery_attempts
         (candidate_id, attempt_number, status, model, prompt, prompt_version, config, lease_token)
      VALUES ($1,$2,'PROCESSING',$3,$4,$5,$6,$7)
      ON CONFLICT (candidate_id, attempt_number) DO NOTHING`,
      [candidate.id, attemptNumber, candidate.model, prompt, candidate.prompt_version, config, leaseToken],
    );
    await audit(
      candidate.workspace_owner_id,
      candidate.product_id,
      candidate.run_id,
      candidate.id,
      attemptNumber > 1 ? "regenerated" : "generation_started",
      null,
      { attemptNumber },
    );

    const source = await objectStorageService.getObjectEntityFile(candidate.source_path);
    const [metadata] = await source.getMetadata();
    const sourceMime = String(metadata.contentType ?? "").split(";")[0].toLowerCase();
    if (!["image/jpeg", "image/png", "image/webp"].includes(sourceMime)) {
      throw new Error("UNSUPPORTED_SOURCE_MEDIA");
    }
    const [bytes] = await source.download();
    if (!bytes.length || bytes.length > MAX_SOURCE_BYTES) throw new Error("INVALID_SOURCE_MEDIA");
    try {
      const imageMetadata = await sharp(bytes).metadata();
      if (
        !imageMetadata.width ||
        !imageMetadata.height ||
        imageMetadata.width > MAX_SOURCE_DIMENSION ||
        imageMetadata.height > MAX_SOURCE_DIMENSION
      ) {
        throw new Error("INVALID_SOURCE_MEDIA");
      }
    } catch {
      throw new Error("INVALID_SOURCE_MEDIA");
    }

    const output = await withProductGalleryDeadline((signal) => callAI<Buffer>({
        actionKey: "product_gallery.image_edit",
        surface: "product_gallery",
        provider: "openai",
        api: "image",
        model: candidate.model,
        sessionId: `workspace:${candidate.workspace_owner_id}`,
        imageSize: candidate.output_size,
        imageQuality: candidate.quality,
        requestOptions: { timeout: PRODUCT_GALLERY_PROVIDER_TIMEOUT_MS, signal },
        call: (requestOptions) => editImageBuffers(
          [{
            bytes,
            mimeType: sourceMime as "image/jpeg" | "image/png" | "image/webp",
            filename: `product-reference.${sourceMime.split("/")[1]}`,
          }],
          prompt,
          candidate.model,
          {
            quality: candidate.quality,
            size: PRODUCT_GALLERY_SIZE,
            outputFormat: PRODUCT_GALLERY_FORMAT,
             inputFidelity: "high",
            timeoutMs: requestOptions?.timeout,
            signal: requestOptions?.signal,
          },
        ),
      }));
    if (!output.length) throw new Error("Image provider returned no bytes");
    let imagePath: string;
    try {
      imagePath = await objectStorageService.savePrivateObject(
        candidate.workspace_owner_id,
        output,
        "image/webp",
      );
    } catch (error) {
      logger.warn({ err: error, candidateId: candidate.id }, "product gallery storage write failed");
      throw new Error("STORAGE_WRITE_FAILED");
    }

    const completed = await db.query(
      `UPDATE product_gallery_candidates
          SET status='DRAFT', image_path=$3, error=NULL, usage=COALESCE(usage,'{}'::jsonb),
              generated_at=now(), lease_token=NULL, lease_until=NULL, updated_at=now()
        WHERE id=$1 AND status='PROCESSING' AND lease_token=$2`,
      [candidate.id, leaseToken, imagePath],
    );
    if ((completed.rowCount ?? 0) === 0) {
      logger.warn({ candidateId: candidate.id }, "ignored late product gallery completion");
      return {};
    }
    // The candidate transition is the source of truth for reviewability.  Do
    // not turn a successfully saved draft back into a failed candidate just
    // because its audit trail is temporarily unavailable.
    try {
      await db.query(
        `UPDATE product_gallery_attempts
            SET status='SUCCEEDED', completed_at=now()
          WHERE candidate_id=$1 AND attempt_number=$2 AND lease_token=$3`,
        [candidate.id, attemptNumber, leaseToken],
      );
    } catch (error) {
      logger.error({ err: error, candidateId: candidate.id }, "product gallery attempt success record failed");
    }
    try {
      await audit(
        candidate.workspace_owner_id,
        candidate.product_id,
        candidate.run_id,
        candidate.id,
        "generated",
        null,
        { attemptNumber, imagePath, model: candidate.model },
      );
    } catch (error) {
      logger.error({ err: error, candidateId: candidate.id }, "product gallery success audit failed");
    }
  } catch (error) {
    if (error instanceof ProductGalleryDeadlineError) {
      releaseAfter = error.providerSettled;
    }
    const disposition = galleryFailureDisposition(error, candidate.retry_count);
    const classified = disposition.error;
    const retryable = disposition.status === "RETRY_WAITING";
    const retryDelaySeconds = Math.min(120, 10 * Math.pow(2, candidate.retry_count - 1));
    let candidateFinalized = false;
    for (let transitionAttempt = 1; transitionAttempt <= 2 && !candidateFinalized; transitionAttempt += 1) {
      try {
        const finalized = await db.query(
          `UPDATE product_gallery_candidates
              SET status=$3,
                  error=$4,
                  next_attempt_at=CASE WHEN $5 THEN now()+($6 || ' seconds')::interval ELSE NULL END,
                  lease_token=NULL, lease_until=NULL, updated_at=now()
            WHERE id=$1 AND status='PROCESSING' AND lease_token=$2`,
          [
            candidate.id,
            leaseToken,
            disposition.status,
            classified,
            retryable,
            retryDelaySeconds,
          ],
        );
        candidateFinalized = (finalized.rowCount ?? 0) > 0;
        break;
      } catch (finalizationError) {
        const log = transitionAttempt === 2 ? logger.error.bind(logger) : logger.warn.bind(logger);
        log(
          { err: finalizationError, candidateId: candidate.id, leaseToken, transitionAttempt },
          "product gallery candidate failure transition failed",
        );
      }
    }

    // Both writes are lease guarded.  A late provider completion or a manual
    // regeneration can therefore never be overwritten by this older attempt.
    try {
      await db.query(
        `UPDATE product_gallery_attempts
            SET status=$4, error=$5, completed_at=now()
          WHERE candidate_id=$1 AND attempt_number=$2 AND lease_token=$3`,
        [candidate.id, attemptNumber, leaseToken, disposition.status, classified],
      );
    } catch (attemptError) {
      logger.error({ err: attemptError, candidateId: candidate.id }, "product gallery attempt failure record failed");
    }
    if (candidateFinalized) {
      try {
        await audit(
          candidate.workspace_owner_id,
          candidate.product_id,
          candidate.run_id,
          candidate.id,
          "failed",
          null,
          { attemptNumber, ...classified },
        );
      } catch (auditError) {
        logger.error({ err: auditError, candidateId: candidate.id }, "product gallery failure audit failed");
      }
    } else {
      logger.warn({ candidateId: candidate.id }, "ignored stale product gallery failure");
    }
  } finally {
    try {
      await reconcileProductGalleryRuns([candidate.run_id]);
    } catch (error) {
      logger.error({ err: error, runId: candidate.run_id }, "product gallery run reconciliation failed");
    }
  }
  return { releaseAfter };
}

async function recoverExpiredCandidates(): Promise<string[]> {
  const result = await db.query<{ run_id: string }>(
    `WITH expired AS (
       SELECT c.id, c.run_id, c.retry_count, c.lease_token
          FROM product_gallery_candidates c
          JOIN product_gallery_runs r ON r.id=c.run_id
         WHERE c.status='PROCESSING' AND c.lease_until < now()
           AND r.status IN ('PENDING','RUNNING','RETRY_WAITING')
        FOR UPDATE SKIP LOCKED
     ), recovered AS (
       UPDATE product_gallery_candidates c
          SET status=CASE WHEN e.retry_count < $1 THEN 'RETRY_WAITING' ELSE 'FAILED' END,
              error=jsonb_build_object(
                'code', 'WORKER_LEASE_EXPIRED',
                'message', CASE WHEN e.retry_count < $1
                  THEN 'Generation was interrupted and will retry automatically.'
                  ELSE 'Generation was interrupted too many times. Retry this image manually.' END,
                'retryable', e.retry_count < $1
              ),
              next_attempt_at=CASE WHEN e.retry_count < $1 THEN now() ELSE NULL END,
              lease_token=NULL, lease_until=NULL, updated_at=now()
         FROM expired e
        WHERE c.id=e.id
        RETURNING c.run_id
     ), attempts AS (
       UPDATE product_gallery_attempts a
          SET status=CASE WHEN e.retry_count < $1 THEN 'RETRY_WAITING' ELSE 'FAILED' END,
              error=jsonb_build_object(
                'code', 'WORKER_LEASE_EXPIRED',
                'message', 'The worker stopped before this attempt completed.',
                'retryable', e.retry_count < $1
              ),
              completed_at=COALESCE(completed_at, now())
         FROM expired e
        WHERE a.candidate_id=e.id AND a.lease_token=e.lease_token AND a.status='PROCESSING'
     )
     SELECT DISTINCT run_id FROM recovered`,
    [PRODUCT_GALLERY_MAX_ATTEMPTS],
  );
  return result.rows.map((row) => row.run_id);
}

export async function recoverProductGalleryRun(
  ownerId: string,
  productId: number,
  runId: number,
): Promise<{ recoveredCount: number }> {
  const result = await db.query<{ found: boolean; recovered_count: number }>(
    `WITH target_run AS (
       SELECT id
         FROM product_gallery_runs
        WHERE id=$1 AND workspace_owner_id=$2 AND product_id=$3
          AND status IN ('PENDING','RUNNING','RETRY_WAITING')
     ), expired AS (
       SELECT c.id, c.retry_count, c.lease_token
         FROM product_gallery_candidates c
         JOIN target_run r ON r.id=c.run_id
        WHERE c.status='PROCESSING' AND c.lease_until < now()
        FOR UPDATE OF c SKIP LOCKED
     ), recovered AS (
       UPDATE product_gallery_candidates c
          SET status=CASE WHEN e.retry_count < $4 THEN 'RETRY_WAITING' ELSE 'FAILED' END,
              error=jsonb_build_object(
                'code', 'WORKER_LEASE_EXPIRED',
                'message', CASE WHEN e.retry_count < $4
                  THEN 'Generation was interrupted and will retry automatically.'
                  ELSE 'Generation was interrupted too many times. Retry this image manually.' END,
                'retryable', e.retry_count < $4
              ),
              next_attempt_at=CASE WHEN e.retry_count < $4 THEN now() ELSE NULL END,
              lease_token=NULL, lease_until=NULL, updated_at=now()
         FROM expired e
        WHERE c.id=e.id
        RETURNING c.id
     ), attempts AS (
       UPDATE product_gallery_attempts a
          SET status=CASE WHEN e.retry_count < $4 THEN 'RETRY_WAITING' ELSE 'FAILED' END,
              error=jsonb_build_object(
                'code', 'WORKER_LEASE_EXPIRED',
                'message', 'The worker stopped before this attempt completed.',
                'retryable', e.retry_count < $4
              ),
              completed_at=COALESCE(completed_at, now())
         FROM expired e
        WHERE a.candidate_id=e.id AND a.lease_token=e.lease_token AND a.status='PROCESSING'
     ), touched AS (
       UPDATE product_gallery_runs r
          SET updated_at=now()
         FROM target_run target
        WHERE r.id=target.id
        RETURNING r.id
     )
     SELECT EXISTS(SELECT 1 FROM target_run) AS found,
            (SELECT count(*)::int FROM recovered) AS recovered_count`,
    [runId, ownerId, productId, PRODUCT_GALLERY_MAX_ATTEMPTS],
  );
  const recovery = result.rows[0];
  if (!recovery?.found) throw new Error("GALLERY_RUN_NOT_RECOVERABLE");
  await reconcileProductGalleryRuns([String(runId)]);
  return { recoveredCount: recovery.recovered_count };
}

export async function processProductGalleryWork(): Promise<void> {
  const recoveredRunIds = await recoverExpiredCandidates();
  await reconcileProductGalleryRuns(recoveredRunIds.length ? recoveredRunIds : undefined);
  const slots = (await Promise.all(
    Array.from({ length: PRODUCT_GALLERY_GLOBAL_CONCURRENCY }, () => acquireWorkerSlot()),
  )).filter((slot): slot is WorkerSlot => slot !== null);
  await Promise.all(slots.map(async (slot) => {
    let releaseAfter: Promise<void> | undefined;
    try {
      const candidate = await claimCandidate(slot);
      if (candidate) {
        ({ releaseAfter } = await processCandidate(candidate));
      }
    } finally {
      if (releaseAfter) {
        await releaseGlobalWorkerSlot(slot);
        void Promise.race([releaseAfter, cancellationGrace()])
          .then(() => releaseCandidateOwnership(slot))
          .catch((error) => {
            logger.error({ err: error }, "product gallery worker lock release failed");
          });
      } else {
        await releaseWorkerSlot(slot);
      }
    }
  }));
}

let productGalleryWorkerStarted = false;

export function startProductGalleryWorker(): void {
  if (productGalleryWorkerStarted) {
    logger.warn("product gallery worker start requested more than once");
    return;
  }
  productGalleryWorkerStarted = true;
  let tickRunning = false;
  const tick = () => {
    if (tickRunning) return;
    tickRunning = true;
    void processProductGalleryWork()
      .catch((error) => {
        logger.error({ err: error }, "product gallery worker tick failed");
      })
      .finally(() => {
        tickRunning = false;
      });
  };
  tick();
  setInterval(tick, 10_000).unref();
  logger.info(
    { concurrency: PRODUCT_GALLERY_GLOBAL_CONCURRENCY, intervalMs: 10_000 },
    "product gallery worker started",
  );
}

export async function createGalleryRun(
  ownerId: string,
  productId: number,
  selectedTypes: GalleryType[],
  idempotencyKey: string,
  actorId: string,
): Promise<Record<string, unknown>> {
  const client = await db.connect();
  try {
    return await withTransaction(client, async () => {
      const productResult = await client.query<{
        main_image_url: string | null;
        name: string;
        description: string | null;
        category: string | null;
      }>(
        `SELECT p.main_image_url, p.name, p.description,
                (SELECT cc.name
                   FROM product_catalog_categories pcc
                   JOIN catalog_categories cc ON cc.id=pcc.attribute_id
                  WHERE pcc.product_id=p.id ORDER BY cc.name LIMIT 1) AS category
           FROM products p
          WHERE p.id=$1 AND p.workspace_owner_id=$2
          FOR UPDATE`,
        [productId, ownerId],
      );
      const product = productResult.rows[0];
      if (!product) throw new Error("PRODUCT_NOT_FOUND");
      if (!product.main_image_url?.startsWith(`/objects/${ownerId}/`)) {
        throw new Error("PRODUCT_SOURCE_IMAGE_REQUIRED");
      }
      const recipe = (
        await client.query<{ name: string; quantity: string | number | null }>(
          `SELECT bi.name, pr.quantity
             FROM product_recipes pr
             JOIN base_items bi ON bi.id=pr.base_item_id
            WHERE pr.product_id=$1 AND pr.workspace_owner_id=$2
            ORDER BY pr.sort_order, pr.created_at`,
          [productId, ownerId],
        )
      ).rows;
      const snapshot: ProductSnapshot = {
        name: product.name,
        category: product.category,
        description: product.description,
        recipe,
      };
      const version = sourceVersion(product.main_image_url);
      const existing = await client.query<Record<string, unknown>>(
        `SELECT * FROM product_gallery_runs
          WHERE workspace_owner_id=$1 AND product_id=$2 AND idempotency_key=$3`,
        [ownerId, productId, idempotencyKey],
      );
      if (existing.rows[0]) return existing.rows[0];
      const active = await client.query<Record<string, unknown>>(
        `SELECT * FROM product_gallery_runs
          WHERE workspace_owner_id=$1 AND product_id=$2 AND source_version=$3
            AND status IN ('PENDING','RUNNING','RETRY_WAITING')
          ORDER BY created_at DESC LIMIT 1`,
        [ownerId, productId, version],
      );
      if (active.rows[0]) {
        await reconcileProductGalleryRuns([String(active.rows[0].id)]);
        const stillActive = await client.query<Record<string, unknown>>(
          `SELECT * FROM product_gallery_runs
            WHERE id=$1 AND status IN ('PENDING','RUNNING','RETRY_WAITING')`,
          [active.rows[0].id],
        );
        if (stillActive.rows[0]) throw new ProductGalleryActiveRunError();
      }

      const created = await client.query<Record<string, unknown>>(
        `INSERT INTO product_gallery_runs
           (workspace_owner_id, product_id, idempotency_key, selected_types,
            source_path, source_version, product_snapshot, model, quality,
            output_size, output_format, prompt_version, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'PENDING',$13)
         RETURNING *`,
        [
          ownerId,
          productId,
          idempotencyKey,
          selectedTypes,
          product.main_image_url,
          version,
          snapshot,
          PRODUCT_GALLERY_MODEL,
          PRODUCT_GALLERY_QUALITY,
          PRODUCT_GALLERY_SIZE,
          PRODUCT_GALLERY_FORMAT,
          PRODUCT_GALLERY_PROMPT_VERSION,
          actorId,
        ],
      );
      const run = created.rows[0]!;
      for (const galleryType of selectedTypes) {
        await client.query(
          `INSERT INTO product_gallery_candidates
             (run_id, gallery_type, status, source_path, source_version)
           VALUES ($1,$2,'PENDING',$3,$4)
           ON CONFLICT (run_id, gallery_type) DO NOTHING`,
          [run.id, galleryType, product.main_image_url, version],
        );
      }
      await client.query(
        `INSERT INTO product_gallery_audit_events
           (workspace_owner_id, product_id, run_id, event_type, actor_id, details)
         VALUES ($1,$2,$3,'run_created',$4,$5)`,
        [ownerId, productId, run.id, actorId, { selectedTypes, sourceVersion: version }],
      );
      await client.query(
        `UPDATE product_gallery_runs SET updated_at=now() WHERE id=$1`,
        [run.id],
      );
      return run;
    });
  } finally {
    client.release();
  }
}

export async function markCandidateForRegeneration(
  ownerId: string,
  productId: number,
  candidateId: number,
  actorId: string,
): Promise<void> {
  const result = await db.query<{ run_id: string }>(
    `UPDATE product_gallery_candidates c
        SET status='PENDING', image_path=NULL, error=NULL, next_attempt_at=NULL,
            retry_count=0, lease_token=NULL, lease_until=NULL, updated_at=now()
       FROM product_gallery_runs r
      WHERE c.id=$1 AND r.id=c.run_id
        AND r.workspace_owner_id=$2 AND r.product_id=$3
        AND c.status IN ('FAILED','DRAFT','REJECTED')
      RETURNING c.run_id`,
    [candidateId, ownerId, productId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("CANDIDATE_NOT_RETRYABLE");
  await db.query(
    `UPDATE product_gallery_runs SET status='PENDING', completed_at=NULL, updated_at=now() WHERE id=$1`,
    [row.run_id],
  );
  await reconcileProductGalleryRuns([row.run_id]);
  await audit(ownerId, productId, row.run_id, String(candidateId), "regenerate_requested", actorId);
}
