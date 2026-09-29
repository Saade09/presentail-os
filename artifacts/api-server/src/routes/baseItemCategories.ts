import { Router } from "express";
import { db } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";

const router = Router();

const MAX_CATEGORY_NAME_LENGTH = 100;

router.use(requireAuth, resolveWorkspace);

function hasPermission(wreq: ReturnType<typeof workspace>, perm: string): boolean {
  return wreq.workspaceActualRole === "owner" || (wreq.allowedPages?.includes(perm) ?? false);
}

type CategoryRow = {
  id: number;
  workspace_owner_id: string;
  name: string;
  parent_id: number | null;
  description: string | null;
  category_type: string | null;
  status: string;
  created_at: string;
  updated_at: string | null;
  created_by: string | null;
  updated_by: string | null;
  sort_order: number;
  base_item_count?: number;
  child_count?: number;
};

/**
 * GET /api/base-item-categories/stats
 * Returns aggregate stats for the workspace's category management.
 */
router.get("/base-item-categories/stats", async (req, res) => {
  const wreq = workspace(req);
  const statsResult = await db.query<{
    total_categories: string;
    total_assigned: string;
    uncategorized: string;
    need_review: string;
  }>(
    `SELECT
       (SELECT COUNT(*) FROM base_item_categories WHERE workspace_owner_id = $1 AND status = 'active') AS total_categories,
       (SELECT COUNT(*) FROM base_items WHERE workspace_owner_id = $1 AND category_id IS NOT NULL AND status != 'merged') AS total_assigned,
       (SELECT COUNT(*) FROM base_items WHERE workspace_owner_id = $1 AND category_id IS NULL AND status != 'merged') AS uncategorized,
       0::bigint AS need_review`,
    [wreq.workspaceOwnerId],
  );
  const row = statsResult.rows[0];
  res.json({
    total_categories: parseInt(row.total_categories, 10),
    total_assigned: parseInt(row.total_assigned, 10),
    uncategorized: parseInt(row.uncategorized, 10),
    need_review: parseInt(row.need_review, 10),
  });
});

/**
 * GET /api/base-item-categories
 * Returns nested list: main categories each with their subcategories array.
 * Supports ?search=, ?status= query params.
 */
router.get("/base-item-categories", async (req, res) => {
  const wreq = workspace(req);
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const statusFilter = typeof req.query.status === "string" ? req.query.status.trim() : "";

  const params: unknown[] = [wreq.workspaceOwnerId];
  let whereExtra = "";
  if (search) {
    params.push(`%${search}%`);
    whereExtra += ` AND LOWER(bic.name) LIKE LOWER($${params.length})`;
  }
  if (statusFilter && statusFilter !== "all") {
    if (statusFilter === "archived") {
      whereExtra += ` AND bic.status = 'archived'`;
    } else {
      whereExtra += ` AND bic.status != 'archived'`;
    }
  }

  const result = await db.query<CategoryRow & { base_item_count: string; child_count: string }>(
    `SELECT bic.id, bic.name, bic.parent_id, bic.description, bic.category_type,
            bic.status, bic.created_at, bic.updated_at, bic.created_by, bic.updated_by,
            bic.sort_order,
            COALESCE((SELECT COUNT(*) FROM base_items bi WHERE bi.category_id = bic.id AND bi.workspace_owner_id = $1 AND bi.status != 'merged'), 0) AS base_item_count,
            COALESCE((SELECT COUNT(*) FROM base_item_categories c2 WHERE c2.parent_id = bic.id AND c2.workspace_owner_id = $1), 0) AS child_count
       FROM base_item_categories bic
      WHERE bic.workspace_owner_id = $1${whereExtra}
      ORDER BY bic.sort_order ASC, bic.created_at ASC`,
    params,
  );
  const rows = result.rows.map((r) => ({
    ...r,
    base_item_count: parseInt(String(r.base_item_count), 10),
    child_count: parseInt(String(r.child_count), 10),
  }));
  const mains = rows.filter((r) => r.parent_id === null);
  const nested = mains.map((m) => ({
    ...m,
    subcategories: rows.filter((r) => r.parent_id === m.id),
  }));
  res.json({ categories: nested });
});

/**
 * POST /api/base-item-categories
 * Create a main or sub category. Owner-only.
 */
router.post("/base-item-categories", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "base-item-categories.create")) {
    res.status(403).json({ error: "Insufficient permissions to create categories" });
    return;
  }

  const { name, parent_id, description, category_type, status } = req.body ?? {};
  const trimmedName = String(name ?? "").trim();
  if (!trimmedName) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  if (trimmedName.length > MAX_CATEGORY_NAME_LENGTH) {
    res.status(400).json({ error: `name must be ${MAX_CATEGORY_NAME_LENGTH} characters or fewer` });
    return;
  }

  let parentId: number | null = null;
  if (parent_id != null) {
    parentId = parseInt(String(parent_id), 10);
    if (isNaN(parentId) || parentId <= 0) {
      res.status(400).json({ error: "Invalid parent_id" });
      return;
    }
    const parentCheck = await db.query<CategoryRow>(
      `SELECT id, parent_id FROM base_item_categories WHERE id = $1 AND workspace_owner_id = $2`,
      [parentId, wreq.workspaceOwnerId],
    );
    if (parentCheck.rowCount === 0) {
      res.status(404).json({ error: "Parent category not found" });
      return;
    }
    if (parentCheck.rows[0].parent_id !== null) {
      res.status(400).json({ error: "Cannot create a sub-subcategory (max 2 levels)" });
      return;
    }
  }

  const desc = description ? String(description).trim() || null : null;
  const catType = category_type ? String(category_type).trim() || null : null;
  const catStatus = (status === "archived" ? "archived" : "active") as string;
  const createdBy = wreq.userId ?? null;

  let result;
  try {
    result = await db.query<CategoryRow>(
      `INSERT INTO base_item_categories (workspace_owner_id, name, parent_id, description, category_type, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, name, parent_id, description, category_type, status, created_at, updated_at, created_by, updated_by, sort_order`,
      [wreq.workspaceOwnerId, trimmedName, parentId, desc, catType, catStatus, createdBy],
    );
  } catch (err: unknown) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code: string }).code === "23505"
    ) {
      res.status(409).json({ error: "A category with that name already exists in this workspace" });
      return;
    }
    throw err;
  }
  res.status(201).json({ category: result.rows[0] });
});

/**
 * POST /api/base-item-categories/merge
 * Merge source category into target: moves all base items and child categories, then archives source.
 */
router.post("/base-item-categories/merge", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "base-item-categories.edit")) {
    res.status(403).json({ error: "Insufficient permissions to merge categories" });
    return;
  }

  const { source_id, target_id } = req.body ?? {};
  const sourceId = parseInt(String(source_id ?? ""), 10);
  const targetId = parseInt(String(target_id ?? ""), 10);

  if (isNaN(sourceId) || sourceId <= 0) {
    res.status(400).json({ error: "Invalid source_id" });
    return;
  }
  if (isNaN(targetId) || targetId <= 0) {
    res.status(400).json({ error: "Invalid target_id" });
    return;
  }
  if (sourceId === targetId) {
    res.status(400).json({ error: "source_id and target_id must be different" });
    return;
  }

  const sourceCheck = await db.query<CategoryRow>(
    `SELECT id, parent_id FROM base_item_categories WHERE id = $1 AND workspace_owner_id = $2`,
    [sourceId, wreq.workspaceOwnerId],
  );
  if (sourceCheck.rowCount === 0) {
    res.status(404).json({ error: "Source category not found" });
    return;
  }
  const targetCheck = await db.query<CategoryRow>(
    `SELECT id, parent_id FROM base_item_categories WHERE id = $1 AND workspace_owner_id = $2`,
    [targetId, wreq.workspaceOwnerId],
  );
  if (targetCheck.rowCount === 0) {
    res.status(404).json({ error: "Target category not found" });
    return;
  }

  const countResult = await db.query<{ item_count: string; child_count: string }>(
    `SELECT
       (SELECT COUNT(*) FROM base_items WHERE category_id = $1 AND workspace_owner_id = $2) AS item_count,
       (SELECT COUNT(*) FROM base_item_categories WHERE parent_id = $1 AND workspace_owner_id = $2) AS child_count`,
    [sourceId, wreq.workspaceOwnerId],
  );
  const { item_count, child_count } = countResult.rows[0];

  await db.query(
    `UPDATE base_items SET category_id = $1 WHERE category_id = $2 AND workspace_owner_id = $3`,
    [targetId, sourceId, wreq.workspaceOwnerId],
  );
  await db.query(
    `UPDATE base_item_categories SET parent_id = $1 WHERE parent_id = $2 AND workspace_owner_id = $3`,
    [targetId, sourceId, wreq.workspaceOwnerId],
  );
  await db.query(
    `UPDATE base_item_categories SET status = 'archived', updated_at = now(), updated_by = $1
      WHERE id = $2 AND workspace_owner_id = $3`,
    [wreq.userId ?? null, sourceId, wreq.workspaceOwnerId],
  );

  res.json({
    ok: true,
    moved_items: parseInt(item_count, 10),
    moved_children: parseInt(child_count, 10),
  });
});

/**
 * GET /api/base-item-categories/:id/base-items
 * List base items linked to a category.
 */
router.get("/base-item-categories/:id/base-items", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid category id" });
    return;
  }

  const catCheck = await db.query<{ id: number }>(
    `SELECT id FROM base_item_categories WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (catCheck.rowCount === 0) {
    res.status(404).json({ error: "Category not found" });
    return;
  }

  const result = await db.query<{
    id: number;
    name: string;
    code: string;
    image_url: string | null;
    created_at: string;
    supplier_name: string | null;
    supplier_item_code: string | null;
  }>(
    `SELECT bi.id, bi.name, bi.code, bi.image_url, bi.created_at,
            s.name AS supplier_name,
            bis.supplier_item_code
       FROM base_items bi
       LEFT JOIN base_item_suppliers bis ON bis.base_item_id = bi.id AND bis.is_preferred = true
       LEFT JOIN suppliers s ON s.id = bis.supplier_id
      WHERE bi.category_id = $1 AND bi.workspace_owner_id = $2 AND bi.status != 'merged'
      ORDER BY bi.name ASC`,
    [id, wreq.workspaceOwnerId],
  );
  res.json({ items: result.rows });
});

/**
 * PATCH /api/base-item-categories/:id
 * Update a category (name, description, category_type, status, parent_id). Owner-only.
 */
router.patch("/base-item-categories/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "base-item-categories.edit")) {
    res.status(403).json({ error: "Insufficient permissions to edit categories" });
    return;
  }

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid category id" });
    return;
  }

  const body = req.body ?? {};
  const hasName = "name" in body;
  if (!hasName) {
    const otherFields = ["description", "category_type", "status", "parent_id", "sort_order"];
    if (!otherFields.some((f) => f in body)) {
      res.status(400).json({ error: "name is required" });
      return;
    }
  }

  let trimmedName: string | undefined;
  if (hasName) {
    trimmedName = String(body.name ?? "").trim();
    if (!trimmedName) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    if (trimmedName.length > MAX_CATEGORY_NAME_LENGTH) {
      res.status(400).json({ error: `name must be ${MAX_CATEGORY_NAME_LENGTH} characters or fewer` });
      return;
    }
  }

  const setClauses: string[] = [];
  const params: unknown[] = [];

  if (trimmedName !== undefined) {
    params.push(trimmedName);
    setClauses.push(`name = $${params.length}`);
  }
  if ("description" in body) {
    params.push(body.description ? String(body.description).trim() || null : null);
    setClauses.push(`description = $${params.length}`);
  }
  if ("category_type" in body) {
    params.push(body.category_type ? String(body.category_type).trim() || null : null);
    setClauses.push(`category_type = $${params.length}`);
  }
  if ("status" in body) {
    const newStatus = body.status === "archived" ? "archived" : "active";
    params.push(newStatus);
    setClauses.push(`status = $${params.length}`);
  }
  if ("sort_order" in body) {
    const so = parseInt(String(body.sort_order ?? ""), 10);
    if (!isNaN(so)) {
      params.push(so);
      setClauses.push(`sort_order = $${params.length}`);
    }
  }

  setClauses.push(`updated_at = now()`);
  params.push(wreq.userId ?? null);
  setClauses.push(`updated_by = $${params.length}`);

  params.push(id);
  const idParam = params.length;
  params.push(wreq.workspaceOwnerId);
  const ownerParam = params.length;

  let result;
  try {
    result = await db.query<CategoryRow>(
      `UPDATE base_item_categories SET ${setClauses.join(", ")}
        WHERE id = $${idParam} AND workspace_owner_id = $${ownerParam}
       RETURNING id, name, parent_id, description, category_type, status, created_at, updated_at, created_by, updated_by, sort_order`,
      params,
    );
  } catch (err: unknown) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code: string }).code === "23505"
    ) {
      res.status(409).json({ error: "A category with that name already exists in this workspace" });
      return;
    }
    throw err;
  }
  if (result.rowCount === 0) {
    res.status(404).json({ error: "Category not found" });
    return;
  }
  res.json({ category: result.rows[0] });
});

/**
 * POST /api/base-item-categories/:id/archive
 * Archive a category. Owner-only.
 */
router.post("/base-item-categories/:id/archive", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "base-item-categories.edit")) {
    res.status(403).json({ error: "Insufficient permissions to archive categories" });
    return;
  }

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid category id" });
    return;
  }

  const catCheck = await db.query<{ id: number }>(
    `SELECT id FROM base_item_categories WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (catCheck.rowCount === 0) {
    res.status(404).json({ error: "Category not found" });
    return;
  }

  await db.query(
    `UPDATE base_item_categories SET status = 'archived', updated_at = now(), updated_by = $1
      WHERE id = $2 AND workspace_owner_id = $3`,
    [wreq.userId ?? null, id, wreq.workspaceOwnerId],
  );
  res.json({ ok: true });
});

/**
 * POST /api/base-item-categories/:id/reorder
 * Move a category up or down, or reassign parent.
 */
router.post("/base-item-categories/:id/reorder", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "base-item-categories.edit")) {
    res.status(403).json({ error: "Insufficient permissions to reorder categories" });
    return;
  }

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid category id" });
    return;
  }

  const { direction, new_parent_id } = req.body ?? {};

  const catCheck = await db.query<{ id: number; parent_id: number | null; sort_order: number }>(
    `SELECT id, parent_id, sort_order FROM base_item_categories WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (catCheck.rowCount === 0) {
    res.status(404).json({ error: "Category not found" });
    return;
  }

  const cat = catCheck.rows[0];

  if (new_parent_id !== undefined) {
    const newParentId = new_parent_id === null ? null : parseInt(String(new_parent_id), 10);
    if (newParentId !== null && (isNaN(newParentId) || newParentId <= 0)) {
      res.status(400).json({ error: "Invalid new_parent_id" });
      return;
    }
    if (newParentId !== null) {
      const parentCheck = await db.query<{ id: number; parent_id: number | null }>(
        `SELECT id, parent_id FROM base_item_categories WHERE id = $1 AND workspace_owner_id = $2`,
        [newParentId, wreq.workspaceOwnerId],
      );
      if (parentCheck.rowCount === 0) {
        res.status(404).json({ error: "Parent category not found" });
        return;
      }
      if (parentCheck.rows[0].parent_id !== null) {
        res.status(400).json({ error: "Cannot create a sub-subcategory (max 2 levels)" });
        return;
      }
    }
    await db.query(
      `UPDATE base_item_categories SET parent_id = $1, updated_at = now() WHERE id = $2 AND workspace_owner_id = $3`,
      [newParentId, id, wreq.workspaceOwnerId],
    );
  }

  if (direction === "up" || direction === "down") {
    const parentId = new_parent_id !== undefined ? (new_parent_id ?? null) : cat.parent_id;
    const siblings = await db.query<{ id: number; sort_order: number }>(
      `SELECT id, sort_order FROM base_item_categories
        WHERE workspace_owner_id = $1 AND parent_id IS NOT DISTINCT FROM $2
        ORDER BY sort_order ASC, created_at ASC`,
      [wreq.workspaceOwnerId, parentId],
    );
    const idx = siblings.rows.findIndex((s) => s.id === id);
    if (idx >= 0) {
      const swapIdx = direction === "up" ? idx - 1 : idx + 1;
      if (swapIdx >= 0 && swapIdx < siblings.rows.length) {
        const swapId = siblings.rows[swapIdx].id;
        const newSortA = siblings.rows[swapIdx].sort_order;
        const newSortB = siblings.rows[idx].sort_order;
        await db.query(
          `UPDATE base_item_categories SET sort_order = $1 WHERE id = $2 AND workspace_owner_id = $3`,
          [newSortA, id, wreq.workspaceOwnerId],
        );
        await db.query(
          `UPDATE base_item_categories SET sort_order = $1 WHERE id = $2 AND workspace_owner_id = $3`,
          [newSortB, swapId, wreq.workspaceOwnerId],
        );
      }
    }
  }

  res.json({ ok: true });
});

/**
 * DELETE /api/base-item-categories/:id
 * Delete a category. Rejects if any base items use it or it has children. Owner-only.
 */
router.delete("/base-item-categories/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "base-item-categories.delete")) {
    res.status(403).json({ error: "Insufficient permissions to delete categories" });
    return;
  }

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid category id" });
    return;
  }

  const catCheck = await db.query<{ id: number; parent_id: number | null }>(
    `SELECT id, parent_id FROM base_item_categories WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (catCheck.rowCount === 0) {
    res.status(404).json({ error: "Category not found" });
    return;
  }

  const usageCheck = await db.query<{ count: string }>(
    `SELECT COUNT(*) as count FROM base_items WHERE category_id = $1 AND workspace_owner_id = $2 AND status != 'merged'`,
    [id, wreq.workspaceOwnerId],
  );
  if (parseInt(usageCheck.rows[0].count, 10) > 0) {
    res.status(409).json({ error: "Cannot delete: base items are assigned to this category" });
    return;
  }

  if (catCheck.rows[0].parent_id === null) {
    const subUsageCheck = await db.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM base_items bi
        JOIN base_item_categories bic ON bic.id = bi.category_id
       WHERE bic.parent_id = $1 AND bi.workspace_owner_id = $2 AND bi.status != 'merged'`,
      [id, wreq.workspaceOwnerId],
    );
    if (parseInt(subUsageCheck.rows[0].count, 10) > 0) {
      res.status(409).json({ error: "Cannot delete: base items are assigned to a subcategory of this category" });
      return;
    }
    await db.query(
      `DELETE FROM base_item_categories WHERE parent_id = $1 AND workspace_owner_id = $2`,
      [id, wreq.workspaceOwnerId],
    );
  }

  await db.query(
    `DELETE FROM base_item_categories WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  res.json({ ok: true });
});

export default router;
