import { Router } from "express";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";
import { publishAllSnapshot, publishProducts } from "../lib/publishSnapshot";

const router = Router();

router.use(requireAuth, resolveWorkspace);

/**
 * POST /api/publish
 * Available to any authenticated workspace member. Pushes a full current
 * snapshot of all workspace data (delivery config, all catalog attributes, and
 * all products) to the connected website via the existing webhook dispatch
 * system. Returns per-area success/failure results so the UI can show a summary
 * and offer retry.
 */
router.post("/publish", async (req, res) => {
  const wreq = workspace(req);
  const result = await publishAllSnapshot(wreq.workspaceOwnerId);
  res.json(result);
});

/**
 * POST /api/publish/products
 * Owner-only (or members with the `products.manage` permission). Pushes a full
 * snapshot of all current products to the connected website via the existing
 * webhook dispatch system (a `product.updated` per product plus a final
 * `catalog.products.changed` summary). Returns the same per-area result shape
 * as the full snapshot so the Products page can summarize count + success.
 */
router.post("/publish/products", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner" && !wreq.allowedPages?.includes("products.manage")) {
    res.status(403).json({ error: "Syncing products requires owner access or the Manage products permission" });
    return;
  }
  const result = await publishProducts(wreq.workspaceOwnerId);
  res.json(result);
});

export default router;
