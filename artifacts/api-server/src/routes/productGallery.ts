import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { Product } from "@workspace/db/schema";
import { requireAuth } from "../lib/auth";
import { db, withTransaction } from "../lib/db";
import { fireCatalogDataWebhook } from "../lib/catalogWebhook";
import { enqueueProductCreateOrUpdateSync } from "../lib/merchantSyncQueue";
import {
  createGalleryRun,
  GALLERY_TYPES,
  markCandidateForRegeneration,
  processProductGalleryWork,
  ProductGalleryActiveRunError,
  recoverProductGalleryRun,
} from "../lib/productGallery";
import { syncProductPublicImages } from "../lib/productPublicImages";
import { notifyProductChanged } from "../lib/productPublishing";
import { resolveWorkspace, workspace } from "../lib/workspace";

const router = Router();
router.use("/products", requireAuth, resolveWorkspace);

const runInput = z.object({
  selectedTypes: z.array(z.enum(GALLERY_TYPES)).min(1).max(4).transform((types) => [...new Set(types)]),
  idempotencyKey: z.string().trim().min(1).max(200),
});

function positiveId(value: string | string[] | undefined): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function requireProductManager(req: Request, res: Response, next: NextFunction): void {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner" && !wreq.allowedPages?.includes("products.manage")) {
    res.status(403).json({
      error: "Managing products requires owner access or the Manage products permission",
      code: "FORBIDDEN",
    });
    return;
  }
  next();
}

router.use("/products", requireProductManager);

const runWithCandidatesSql = `
  SELECT r.*,
         COALESCE(
           json_agg(c ORDER BY c.id) FILTER (WHERE c.id IS NOT NULL),
           '[]'::json
         ) AS candidates
    FROM product_gallery_runs r
    LEFT JOIN product_gallery_candidates c ON c.run_id=r.id
`;

router.post("/products/:id/gallery/runs", async (req, res): Promise<void> => {
  const productId = positiveId(req.params.id);
  const parsed = runInput.safeParse(req.body);
  if (!productId || !parsed.success) {
    res.status(400).json({ error: "Invalid gallery run request", code: "VALIDATION_ERROR" });
    return;
  }
  const wreq = workspace(req);
  try {
    const run = await createGalleryRun(
      wreq.workspaceOwnerId,
      productId,
      parsed.data.selectedTypes,
      parsed.data.idempotencyKey,
      wreq.userId,
    );
    res.status(201).json({ run });
  } catch (error) {
    const code = error instanceof ProductGalleryActiveRunError
      ? error.code
      : error instanceof Error
        ? error.message
        : "GALLERY_RUN_CREATE_FAILED";
    if (code === "PRODUCT_NOT_FOUND") {
      req.log.warn({ err: error, productId }, "product gallery run rejected");
      res.status(404).json({ error: "Product not found", code });
      return;
    }
    if (code === "PRODUCT_SOURCE_IMAGE_REQUIRED") {
      req.log.warn({ err: error, productId }, "product gallery run rejected");
      res.status(409).json({ error: "Add a primary product image first.", code });
      return;
    }
    if (code === "ACTIVE_RUN_EXISTS") {
      req.log.warn({ err: error, productId }, "product gallery run already active");
      res.status(409).json({
        error: "A gallery run is already active for this source image.",
        code,
      });
      return;
    }
    req.log.error({ err: error, productId }, "product gallery run creation failed");
    res.status(500).json({
      error: "Gallery generation could not be started. Refresh and try again.",
      code: "GALLERY_RUN_CREATE_FAILED",
    });
  }
});

router.get("/products/:id/gallery/runs", async (req, res): Promise<void> => {
  const productId = positiveId(req.params.id);
  if (!productId) {
    res.status(400).json({ error: "Invalid product id" });
    return;
  }
  const wreq = workspace(req);
  const runs = await db.query(
    `${runWithCandidatesSql}
      WHERE r.workspace_owner_id=$1 AND r.product_id=$2
      GROUP BY r.id
      ORDER BY r.created_at DESC
      LIMIT 20`,
    [wreq.workspaceOwnerId, productId],
  );
  res.json({ runs: runs.rows });
});

router.get("/products/:id/gallery/runs/:runId", async (req, res): Promise<void> => {
  const productId = positiveId(req.params.id);
  const runId = positiveId(req.params.runId);
  if (!productId || !runId) {
    res.status(400).json({ error: "Invalid gallery run id" });
    return;
  }
  const wreq = workspace(req);
  const result = await db.query(
    `${runWithCandidatesSql}
      WHERE r.workspace_owner_id=$1 AND r.product_id=$2 AND r.id=$3
      GROUP BY r.id`,
    [wreq.workspaceOwnerId, productId, runId],
  );
  if (!result.rows[0]) {
    res.status(404).json({ error: "Gallery run not found" });
    return;
  }
  res.json({ run: result.rows[0] });
});

router.post("/products/:id/gallery/runs/:runId/recover", async (req, res): Promise<void> => {
  const productId = positiveId(req.params.id);
  const runId = positiveId(req.params.runId);
  if (!productId || !runId) {
    res.status(400).json({ error: "Invalid gallery run id", code: "VALIDATION_ERROR" });
    return;
  }
  const wreq = workspace(req);
  try {
    const recovery = await recoverProductGalleryRun(
      wreq.workspaceOwnerId,
      productId,
      runId,
    );
    // Wake the same supervised worker path immediately instead of waiting for
    // the next interval. Advisory locks keep concurrent API/interval ticks safe.
    void processProductGalleryWork().catch((error) => {
      req.log.error({ err: error, productId, runId }, "product gallery recovery wake failed");
    });
    res.json({ runId, status: "RECOVERY_REQUESTED", ...recovery });
  } catch (error) {
    const code = error instanceof Error ? error.message : "GALLERY_RECOVERY_FAILED";
    if (code === "GALLERY_RUN_NOT_RECOVERABLE") {
      res.status(409).json({
        error: "This gallery run is no longer active or could not be found.",
        code,
      });
      return;
    }
    req.log.error({ err: error, productId, runId }, "product gallery recovery failed");
    res.status(500).json({
      error: "Gallery recovery is temporarily unavailable. Refresh and try again.",
      code: "GALLERY_RECOVERY_FAILED",
    });
  }
});

router.post("/products/:id/gallery/candidates/:candidateId/retry", async (req, res): Promise<void> => {
  const productId = positiveId(req.params.id);
  const candidateId = positiveId(req.params.candidateId);
  if (!productId || !candidateId) {
    res.status(400).json({ error: "Invalid gallery candidate id" });
    return;
  }
  const wreq = workspace(req);
  try {
    await markCandidateForRegeneration(
      wreq.workspaceOwnerId,
      productId,
      candidateId,
      wreq.userId,
    );
    res.json({ candidateId, status: "PENDING" });
  } catch {
    res.status(409).json({
      error: "This draft cannot be regenerated in its current state.",
      code: "CANDIDATE_NOT_RETRYABLE",
    });
  }
});

router.post("/products/:id/gallery/candidates/:candidateId/approve", async (req, res): Promise<void> => {
  const productId = positiveId(req.params.id);
  const candidateId = positiveId(req.params.candidateId);
  if (!productId || !candidateId) {
    res.status(400).json({ error: "Invalid gallery candidate id" });
    return;
  }
  const wreq = workspace(req);
  const client = await db.connect();
  let product: Product | null = null;
  let sourcePath: string | null = null;
  let additionalImages: string[] = [];
  try {
    product = await withTransaction(client, async () => {
      const result = await client.query<{
        run_id: string;
        status: string;
        image_path: string | null;
        source_path: string;
        main_image_url: string | null;
        additional_image_urls: string[];
      }>(
        `SELECT c.run_id, c.status, c.image_path, r.source_path,
                p.main_image_url, p.additional_image_urls
           FROM product_gallery_candidates c
           JOIN product_gallery_runs r ON r.id=c.run_id
           JOIN products p ON p.id=r.product_id
          WHERE c.id=$1 AND r.product_id=$2 AND r.workspace_owner_id=$3
          FOR UPDATE OF c, p`,
        [candidateId, productId, wreq.workspaceOwnerId],
      );
      const candidate = result.rows[0];
      if (!candidate) throw new Error("CANDIDATE_NOT_FOUND");
      if (candidate.status === "APPROVED") {
        const existing = await client.query<Product>(
          `SELECT * FROM products WHERE id=$1 AND workspace_owner_id=$2`,
          [productId, wreq.workspaceOwnerId],
        );
        return existing.rows[0]!;
      }
      if (candidate.status !== "DRAFT" || !candidate.image_path) {
        throw new Error("CANDIDATE_NOT_READY");
      }
      if (candidate.main_image_url !== candidate.source_path) {
        await client.query(
          `UPDATE product_gallery_candidates SET status='STALE', updated_at=now() WHERE id=$1`,
          [candidateId],
        );
        throw new Error("STALE_SOURCE");
      }
      if (candidate.additional_image_urls.length >= 5) {
        throw new Error("GALLERY_CAPACITY_REACHED");
      }
      if (!candidate.additional_image_urls.includes(candidate.image_path)) {
        candidate.additional_image_urls.push(candidate.image_path);
      }
      additionalImages = candidate.additional_image_urls;
      sourcePath = candidate.main_image_url;
      const updated = await client.query<Product>(
        `UPDATE products
            SET additional_image_urls=$3, updated_at=now()
          WHERE id=$1 AND workspace_owner_id=$2
          RETURNING *`,
        [productId, wreq.workspaceOwnerId, additionalImages],
      );
      await client.query(
        `UPDATE product_gallery_candidates
            SET status='APPROVED', reviewed_at=now(), reviewed_by=$2, updated_at=now()
          WHERE id=$1`,
        [candidateId, wreq.userId],
      );
      await client.query(
        `INSERT INTO product_gallery_audit_events
           (workspace_owner_id, product_id, run_id, candidate_id, event_type, actor_id, details)
         VALUES ($1,$2,$3,$4,'approved',$5,$6)`,
        [
          wreq.workspaceOwnerId,
          productId,
          candidate.run_id,
          candidateId,
          wreq.userId,
          { imagePath: candidate.image_path },
        ],
      );
      return updated.rows[0]!;
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : "APPROVAL_FAILED";
    const status = code === "CANDIDATE_NOT_FOUND" ? 404 : 409;
    const messages: Record<string, string> = {
      CANDIDATE_NOT_FOUND: "Gallery candidate not found.",
      CANDIDATE_NOT_READY: "This candidate is not ready for approval.",
      STALE_SOURCE: "This draft was generated from a previous primary image and cannot be added to the current gallery.",
      GALLERY_CAPACITY_REACHED: "This product already has five additional images.",
    };
    res.status(status).json({ error: messages[code] ?? "The draft could not be approved.", code });
    return;
  } finally {
    client.release();
  }

  if (product && sourcePath) {
    await syncProductPublicImages(
      productId,
      sourcePath,
      additionalImages,
      wreq.workspaceOwnerId,
    );
    void enqueueProductCreateOrUpdateSync(product);
    void notifyProductChanged(
      productId,
      wreq.workspaceOwnerId,
      ["images"],
      ["product.images_updated", "product.updated"],
    );
    void fireCatalogDataWebhook("catalog.products.changed", wreq.workspaceOwnerId, {
      action: "updated",
      product_id: productId,
    });
    void fireCatalogDataWebhook("product.updated", wreq.workspaceOwnerId, {
      product: product as unknown as Record<string, unknown>,
    });
  }
  res.json({ candidateId, status: "APPROVED", product });
});

async function reviewCandidate(
  req: Request,
  res: Response,
  status: "REJECTED" | "DELETED",
): Promise<void> {
  const productId = positiveId(req.params.id);
  const candidateId = positiveId(req.params.candidateId);
  if (!productId || !candidateId) {
    res.status(400).json({ error: "Invalid gallery candidate id" });
    return;
  }
  const wreq = workspace(req);
  const result = await db.query<{ run_id: string }>(
    `UPDATE product_gallery_candidates c
        SET status=$4, reviewed_at=now(), reviewed_by=$5, updated_at=now()
       FROM product_gallery_runs r
      WHERE c.id=$1 AND r.id=c.run_id
        AND r.product_id=$2 AND r.workspace_owner_id=$3
        AND c.status IN ('DRAFT','FAILED','REJECTED','STALE')
      RETURNING c.run_id`,
    [candidateId, productId, wreq.workspaceOwnerId, status, wreq.userId],
  );
  const row = result.rows[0];
  if (!row) {
    res.status(409).json({ error: "This draft cannot be changed in its current state." });
    return;
  }
  await db.query(
    `INSERT INTO product_gallery_audit_events
       (workspace_owner_id, product_id, run_id, candidate_id, event_type, actor_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      wreq.workspaceOwnerId,
      productId,
      row.run_id,
      candidateId,
      status === "DELETED" ? "deleted" : "rejected",
      wreq.userId,
    ],
  );
  res.json({ candidateId, status });
}

router.post("/products/:id/gallery/candidates/:candidateId/reject", async (req, res) => {
  await reviewCandidate(req, res, "REJECTED");
});

router.delete("/products/:id/gallery/candidates/:candidateId", async (req, res) => {
  await reviewCandidate(req, res, "DELETED");
});

export default router;