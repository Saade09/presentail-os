import { Router } from "express";
import multer from "multer";
import { randomUUID } from "crypto";
import { clerkClient } from "@clerk/express";
import { db, withTransaction } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";
import { logger } from "../lib/logger";
import { authed } from "../lib/auth";
import { objectStorageClient } from "../lib/objectStorage";
import { extractInvoiceDataFromBuffer } from "../lib/finance/aiExtraction.js";
const router = Router();
// Scope router-level middleware to supplier URLs. An unscoped `router.use`
// runs for every request that reaches this router in the aggregate API router,
// including unrelated routes mounted after suppliers.ts.
router.use("/suppliers", requireAuth, resolveWorkspace);

router.use("/suppliers", (req, res, next) => {
  if (req.method !== "GET" || hasPermission(workspace(req), "suppliers")) {
    next();
    return;
  }
  res.status(403).json({ error: "You do not have access to suppliers" });
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

type SupplierDocumentRow = {
  id: number;
  supplier_id: number;
  workspace_owner_id: string;
  file_name: string;
  file_url: string;
  uploaded_by_clerk_id: string | null;
  created_at: string;
};

type SupplierRow = {
  id: number;
  workspace_owner_id: string;
  name: string;
  display_name: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  country: string | null;
  tax_number: string | null;
  supplier_code: string | null;
  payment_terms: string | null;
  currency_pref: string | null;
  lead_time_days: number | null;
  min_order_value: string | null;
  notes: string | null;
  category: string | null;
  vat_registered: boolean | null;
  vat_status: string | null;
  vat_not_registered_reason: string | null;
  default_vat_treatment: string | null;
  default_vat_rate: string | null;
  default_tax_category: string | null;
  billing_address: string | null;
  website: string | null;
  tags: string | null;
  updated_at: string | null;
  updated_by_clerk_id: string | null;
  created_by_clerk_id: string | null;
  is_archived: boolean;
  created_at: string;
};

function parseSupplierTags(tags: string | null): string[] | null {
  if (!tags) return null;
  try { return JSON.parse(tags) as string[]; } catch { return null; }
}

async function fetchClerkNames(
  userIds: string[],
): Promise<Map<string, { firstName: string | null; lastName: string | null }>> {
  const map = new Map<string, { firstName: string | null; lastName: string | null }>();
  const filtered = userIds.filter(Boolean);
  if (filtered.length === 0) return map;
  try {
    const clerkUsers = await clerkClient.users.getUserList({ userId: filtered, limit: 100 });
    for (const u of clerkUsers.data) {
      map.set(u.id, { firstName: u.firstName ?? null, lastName: u.lastName ?? null });
    }
  } catch (err) {
    logger.warn({ err }, "Failed to batch-fetch Clerk profile names for suppliers");
  }
  return map;
}

function formatName(info: { firstName: string | null; lastName: string | null } | undefined): string | null {
  if (!info) return null;
  const parts = [info.firstName, info.lastName].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : null;
}

function hasPermission(wreq: ReturnType<typeof workspace>, perm: string): boolean {
  return wreq.workspaceActualRole === "owner" || (wreq.allowedPages?.includes(perm) ?? false);
}

// ─── Assignment types & helpers ───────────────────────────────────────────────

type AssignmentMemberRow = {
  supplier_id: number;
  member_id: number;
  member_user_id: string | null;
  member_email: string;
  is_lead: boolean;
};

type SupplierAssignmentResult = {
  memberId: number;
  memberUserId: string | null;
  memberEmail: string;
  name: string | null;
  imageUrl: string | null;
  isLead: boolean;
};

async function fetchSupplierAssignments(
  supplierIds: number[],
  workspaceOwnerId: string,
): Promise<Map<number, SupplierAssignmentResult[]>> {
  const map = new Map<number, SupplierAssignmentResult[]>();
  if (supplierIds.length === 0) return map;

  const rows = await db.query<AssignmentMemberRow>(
    `SELECT sa.supplier_id, sa.member_id, sa.is_lead,
            wm.member_user_id, wm.member_email
       FROM supplier_assignments sa
       JOIN workspace_members wm ON wm.id = sa.member_id
      WHERE sa.supplier_id = ANY($1) AND sa.workspace_owner_id = $2
      ORDER BY sa.supplier_id, sa.is_lead DESC, sa.created_at ASC`,
    [supplierIds, workspaceOwnerId],
  );

  const clerkIds = [...new Set(rows.rows.map((r) => r.member_user_id).filter(Boolean) as string[])];
  const clerkMap = new Map<string, { firstName: string | null; lastName: string | null; imageUrl: string | null }>();
  if (clerkIds.length > 0) {
    try {
      const users = await clerkClient.users.getUserList({ userId: clerkIds, limit: 100 });
      for (const u of users.data) {
        clerkMap.set(u.id, { firstName: u.firstName ?? null, lastName: u.lastName ?? null, imageUrl: u.imageUrl ?? null });
      }
    } catch (err) {
      logger.warn({ err }, "Failed to batch-fetch Clerk profiles for supplier assignments");
    }
  }

  for (const row of rows.rows) {
    const info = row.member_user_id ? clerkMap.get(row.member_user_id) : undefined;
    const nameParts = [info?.firstName, info?.lastName].filter(Boolean);
    const name = nameParts.length > 0 ? nameParts.join(" ") : row.member_email;
    const entry: SupplierAssignmentResult = {
      memberId: row.member_id,
      memberUserId: row.member_user_id,
      memberEmail: row.member_email,
      name,
      imageUrl: info?.imageUrl ?? null,
      isLead: row.is_lead,
    };
    const existing = map.get(row.supplier_id) ?? [];
    existing.push(entry);
    map.set(row.supplier_id, existing);
  }

  return map;
}

function supplierIdLabel(id: number): string {
  return `SUP-${String(id).padStart(4, "0")}`;
}

/**
 * GET /api/suppliers
 * List workspace suppliers. include_archived=true to include archived.
 */
router.get("/suppliers", async (req, res) => {
  const wreq = workspace(req);
  const includeArchived = req.query.include_archived === "true";
  const q = typeof req.query.q === "string" && req.query.q.trim() ? req.query.q.trim() : null;
  const hasOutstanding = req.query.has_outstanding === "true";
  const categoryFilter = typeof req.query.category === "string" && req.query.category.trim() ? req.query.category.trim() : null;
  const paymentTermsFilter = typeof req.query.payment_terms === "string" && req.query.payment_terms.trim() ? req.query.payment_terms.trim() : null;

  // assigned_employee filter: "me" | "unassigned" | member_id(s)
  const assignedEmployeeRaw = req.query.assigned_employee;
  const assignedEmployeeValues: string[] = [];
  if (Array.isArray(assignedEmployeeRaw)) {
    for (const v of assignedEmployeeRaw) {
      if (typeof v === "string" && v.trim()) assignedEmployeeValues.push(v.trim());
    }
  } else if (typeof assignedEmployeeRaw === "string" && assignedEmployeeRaw.trim()) {
    for (const v of assignedEmployeeRaw.split(",")) {
      if (v.trim()) assignedEmployeeValues.push(v.trim());
    }
  }

  const conditions: string[] = ["workspace_owner_id = $1"];
  const params: unknown[] = [wreq.workspaceOwnerId];

  if (!includeArchived) {
    conditions.push("is_archived = false");
  }

  if (q) {
    params.push(`%${q.replace(/([%_\\])/g, "\\$1")}%`);
    conditions.push(
      `(name ILIKE $${params.length} ESCAPE '\\' OR display_name ILIKE $${params.length} ESCAPE '\\')`,
    );
  }

  if (hasOutstanding) {
    conditions.push(
      `EXISTS (SELECT 1 FROM supplier_invoices si WHERE si.supplier_id = s.id AND si.workspace_owner_id = s.workspace_owner_id AND si.status NOT IN ('paid', 'cancelled'))`,
    );
  }

  if (categoryFilter) {
    params.push(categoryFilter);
    conditions.push(`category = $${params.length}`);
  }

  if (paymentTermsFilter) {
    params.push(paymentTermsFilter);
    conditions.push(`payment_terms = $${params.length}`);
  }

  if (assignedEmployeeValues.length > 0) {
    if (assignedEmployeeValues.includes("unassigned")) {
      conditions.push(
        `NOT EXISTS (SELECT 1 FROM supplier_assignments sa WHERE sa.supplier_id = s.id AND sa.workspace_owner_id = s.workspace_owner_id)`,
      );
    } else {
      const resolvedIds: number[] = [];
      for (const v of assignedEmployeeValues) {
        if (v === "me") {
          if (wreq.memberDbId != null) resolvedIds.push(wreq.memberDbId);
        } else {
          const parsed = parseInt(v, 10);
          if (!isNaN(parsed)) resolvedIds.push(parsed);
        }
      }
      if (resolvedIds.length > 0) {
        params.push(resolvedIds);
        conditions.push(
          `EXISTS (SELECT 1 FROM supplier_assignments sa WHERE sa.supplier_id = s.id AND sa.workspace_owner_id = s.workspace_owner_id AND sa.member_id = ANY($${params.length}))`,
        );
      }
    }
  }

  const result = await db.query<SupplierRow & { item_count: number; invoice_count: number; spend_ytd: string | null; spend_ytd_currency: string | null; paid_count: number; outstanding_count: number }>(
    `SELECT s.*,
       (SELECT COUNT(*)::int FROM base_item_suppliers bis WHERE bis.supplier_id = s.id AND bis.workspace_owner_id = s.workspace_owner_id) AS item_count,
       (SELECT COUNT(*)::int FROM supplier_invoices si WHERE si.supplier_id = s.id AND si.workspace_owner_id = s.workspace_owner_id) AS invoice_count,
       (SELECT COALESCE(SUM(si.amount), 0)::text FROM supplier_invoices si WHERE si.supplier_id = s.id AND si.workspace_owner_id = s.workspace_owner_id AND si.status <> 'cancelled' AND si.issued_at >= date_trunc('year', NOW())) AS spend_ytd,
       s.currency_pref AS spend_ytd_currency,
       (SELECT COUNT(*)::int FROM supplier_invoices si WHERE si.supplier_id = s.id AND si.workspace_owner_id = s.workspace_owner_id AND si.status = 'paid') AS paid_count,
       (SELECT COUNT(*)::int FROM supplier_invoices si WHERE si.supplier_id = s.id AND si.workspace_owner_id = s.workspace_owner_id AND si.status NOT IN ('paid', 'cancelled')) AS outstanding_count
     FROM suppliers s
     WHERE ${conditions.map((c) => c.replace(/\bsuppliers\b/g, "s")).join(" AND ")}
     ORDER BY COALESCE(s.display_name, s.name) ASC`,
    params,
  );

  const supplierIds = result.rows.map((r) => r.id);
  const assignmentsMap = await fetchSupplierAssignments(supplierIds, wreq.workspaceOwnerId);

  res.json({
    suppliers: result.rows.map((r) => ({
      ...r,
      tags: parseSupplierTags(r.tags),
      assignments: assignmentsMap.get(r.id) ?? [],
    })),
  });
});

// ─── Name normalization & similarity (re-exported from shared lib) ────────────

import { normalizeSupplierName, similarityScore } from "../lib/supplierMatcher.js";
export { normalizeSupplierName };

type SupplierMatchResult = {
  id: number;
  display_name: string | null;
  name: string;
  category: string | null;
  country: string | null;
  status: "active" | "archived";
  last_activity_date: string | null;
  score: number;
};

function computeDuplicates(
  normalized: string,
  rows: SupplierRow[],
): { exactMatch: boolean; similarMatches: SupplierMatchResult[] } {
  let exactMatch = false;
  const matches: SupplierMatchResult[] = [];

  for (const row of rows) {
    const normName = normalizeSupplierName(row.name);
    const normDisplay = row.display_name ? normalizeSupplierName(row.display_name) : null;
    const score = Math.max(
      similarityScore(normalized, normName),
      normDisplay ? similarityScore(normalized, normDisplay) : 0,
    );
    const entry: SupplierMatchResult = {
      id: row.id,
      display_name: row.display_name,
      name: row.name,
      category: row.supplier_code ?? null,
      country: row.country,
      status: row.is_archived ? "archived" : "active",
      last_activity_date: row.updated_at,
      score,
    };
    if (score === 100) {
      exactMatch = true;
      matches.push(entry);
    } else if (score >= 85) {
      matches.push(entry);
    }
  }

  matches.sort((a, b) => b.score - a.score);
  return { exactMatch, similarMatches: matches };
}

/**
 * GET /api/suppliers/check-duplicate
 * Check if a supplier name is a duplicate or similar to existing ones.
 * NOTE: must be registered before /suppliers/:id.
 */
router.get("/suppliers/check-duplicate", async (req, res) => {
  const wreq = workspace(req);
  const name = typeof req.query.name === "string" ? req.query.name.trim() : "";
  if (!name) {
    res.status(400).json({ error: "name query param is required" });
    return;
  }

  const excludeId = typeof req.query.exclude_id === "string" && req.query.exclude_id.trim()
    ? parseInt(req.query.exclude_id.trim(), 10)
    : null;

  const normalized = normalizeSupplierName(name);

  const params: unknown[] = [wreq.workspaceOwnerId];
  let sql = `SELECT * FROM suppliers WHERE workspace_owner_id = $1 AND is_archived = false`;
  if (excludeId !== null && !isNaN(excludeId)) {
    params.push(excludeId);
    sql += ` AND id <> $${params.length}`;
  }

  const result = await db.query<SupplierRow>(sql, params);

  res.json(computeDuplicates(normalized, result.rows));
});

/**
 * GET /api/suppliers/reorder-needed
 * List all catalog items across all workspace suppliers that are below par level.
 * NOTE: must be registered before /suppliers/:id so Express matches the static
 * segment "reorder-needed" before the wildcard :id parameter.
 */
router.get("/suppliers/reorder-needed", async (req, res) => {
  const wreq = workspace(req);

  const rows = await db.query<SupplierCatalogItemRow & { supplier_name: string; supplier_display_name: string | null }>(
    `SELECT sci.*,
            s.name AS supplier_name,
            s.display_name AS supplier_display_name
     FROM supplier_catalog_items sci
     JOIN suppliers s ON s.id = sci.supplier_id
     WHERE sci.workspace_owner_id = $1
       AND s.is_archived = FALSE
       AND sci.is_active = TRUE
       AND sci.current_stock IS NOT NULL
       AND sci.par_level IS NOT NULL
       AND sci.current_stock < sci.par_level
     ORDER BY s.name ASC, sci.name ASC`,
    [wreq.workspaceOwnerId],
  );

  res.json({ items: rows.rows });
});

/**
 * POST /api/suppliers/bulk-assign
 * Assign one or more employees to multiple suppliers.
 * Replaces existing assignments for the given supplier IDs.
 * body: { supplier_ids: number[], member_ids: number[], lead_member_id?: number | null }
 */
router.post("/suppliers/bulk-assign", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "suppliers.edit")) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const { supplier_ids, member_ids, lead_member_id } = req.body as {
    supplier_ids?: unknown;
    member_ids?: unknown;
    lead_member_id?: unknown;
  };

  if (
    !Array.isArray(supplier_ids) ||
    supplier_ids.length === 0 ||
    !Array.isArray(member_ids)
  ) {
    res.status(400).json({ error: "supplier_ids (non-empty array) and member_ids (array) are required" });
    return;
  }

  const supplierIdsArr = supplier_ids.map(Number).filter((n) => !isNaN(n));
  const memberIdsArr = member_ids.map(Number).filter((n) => !isNaN(n));
  const leadId = lead_member_id != null ? Number(lead_member_id) : null;

  if (supplierIdsArr.length === 0) {
    res.status(400).json({ error: "No valid supplier_ids provided" });
    return;
  }

  // Verify all suppliers belong to this workspace
  const supplierCheck = await db.query<{ id: number }>(
    `SELECT id FROM suppliers WHERE id = ANY($1) AND workspace_owner_id = $2`,
    [supplierIdsArr, wreq.workspaceOwnerId],
  );
  if (supplierCheck.rows.length !== supplierIdsArr.length) {
    res.status(403).json({ error: "One or more suppliers not found in this workspace" });
    return;
  }

  // Verify all members belong to this workspace
  if (memberIdsArr.length > 0) {
    const memberCheck = await db.query<{ id: number }>(
      `SELECT id FROM workspace_members WHERE id = ANY($1) AND workspace_owner_id = $2`,
      [memberIdsArr, wreq.workspaceOwnerId],
    );
    if (memberCheck.rows.length !== memberIdsArr.length) {
      res.status(400).json({ error: "One or more member_ids not found in this workspace" });
      return;
    }
  }

  // Replace assignments atomically: delete then insert
  await db.query(`BEGIN`);
  try {
    await db.query(
      `DELETE FROM supplier_assignments WHERE supplier_id = ANY($1) AND workspace_owner_id = $2`,
      [supplierIdsArr, wreq.workspaceOwnerId],
    );
    if (memberIdsArr.length > 0) {
      for (const supplierId of supplierIdsArr) {
        for (const memberId of memberIdsArr) {
          await db.query(
            `INSERT INTO supplier_assignments (supplier_id, member_id, workspace_owner_id, is_lead, created_by_clerk_id)
               VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (supplier_id, member_id) DO UPDATE SET is_lead = EXCLUDED.is_lead`,
            [supplierId, memberId, wreq.workspaceOwnerId, memberId === leadId, wreq.userId ?? null],
          );
        }
      }
    }
    // Log activity for each supplier
    for (const supplierId of supplierIdsArr) {
      await db.query(
        `INSERT INTO supplier_activities (supplier_id, workspace_owner_id, actor_clerk_id, action, payload)
           VALUES ($1, $2, $3, 'bulk_assigned', $4)`,
        [
          supplierId,
          wreq.workspaceOwnerId,
          wreq.userId ?? null,
          JSON.stringify({ member_ids: memberIdsArr, lead_member_id: leadId }),
        ],
      );
    }
    await db.query(`COMMIT`);
  } catch (err) {
    await db.query(`ROLLBACK`);
    throw err;
  }

  res.json({ ok: true, updated_count: supplierIdsArr.length });
});

/**
 * POST /api/suppliers/merge
 * Move all supplier-linked records from one or more duplicate suppliers into
 * a retained supplier, then archive the duplicates. This is deliberately
 * explicit because the source Odoo partner/tax identity is not preserved on
 * the archived supplier after the merge.
 *
 * body:
 *   {
 *     target_supplier_id: number,
 *     source_supplier_ids: number[],
 *     confirmation_text: "MERGE",
 *     confirm_conflicts?: boolean
 *   }
 */
router.post("/suppliers/merge", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "suppliers.edit") || !hasPermission(wreq, "suppliers.delete")) {
    res.status(403).json({ error: "Merging suppliers requires edit and archive permissions" });
    return;
  }

  const body = (req.body ?? {}) as {
    target_supplier_id?: unknown;
    source_supplier_ids?: unknown;
    confirmation_text?: unknown;
    confirm_conflicts?: unknown;
  };
  const targetId = Number(body.target_supplier_id);
  const sourceIds = Array.isArray(body.source_supplier_ids)
    ? body.source_supplier_ids.map(Number)
    : [];
  const uniqueSourceIds = [...new Set(sourceIds)];

  if (!Number.isInteger(targetId) || targetId <= 0) {
    res.status(400).json({ error: "target_supplier_id must be a positive integer" });
    return;
  }
  if (
    uniqueSourceIds.length === 0 ||
    uniqueSourceIds.some((id) => !Number.isInteger(id) || id <= 0) ||
    uniqueSourceIds.includes(targetId)
  ) {
    res.status(400).json({
      error: "source_supplier_ids must contain positive supplier IDs and cannot include the target",
    });
    return;
  }
  if (body.confirmation_text !== "MERGE") {
    res.status(400).json({ error: 'confirmation_text must be exactly "MERGE"' });
    return;
  }

  const allIds = [...new Set([targetId, ...uniqueSourceIds])].sort((a, b) => a - b);
  const client = await db.connect();

  type MergeSupplierRow = {
    id: number;
    workspace_owner_id: string;
    name: string;
    display_name: string | null;
    tax_number: string | null;
    country: string | null;
    odoo_partner_id: number | null;
    is_archived: boolean;
  };
  type MergeConflict = {
    type: string;
    source_supplier_id?: number;
    source_value?: string | number | null;
    target_value?: string | number | null;
    detail: string;
  };
  type MergeResult =
    | { kind: "not_found"; missing_ids: number[] }
    | {
        kind: "conflict";
        target: MergeSupplierRow;
        sources: MergeSupplierRow[];
        conflicts: MergeConflict[];
        blocking_conflicts: MergeConflict[];
      }
    | { kind: "merged"; moved: Record<string, number>; archived_supplier_ids: number[] };

  try {
    const result = await withTransaction<MergeResult>(client, async () => {
      const locked = await client.query<MergeSupplierRow>(
        `SELECT id, workspace_owner_id, name, display_name, tax_number, country,
                odoo_partner_id, is_archived
           FROM suppliers
          WHERE id = ANY($1) AND workspace_owner_id = $2
          ORDER BY id
          FOR UPDATE`,
        [allIds, wreq.workspaceOwnerId],
      );
      const rowsById = new Map(locked.rows.map((row) => [row.id, row]));
      const missingIds = allIds.filter((id) => !rowsById.has(id));
      if (missingIds.length > 0) {
        return { kind: "not_found", missing_ids: missingIds };
      }

      const target = rowsById.get(targetId)!;
      const sources = uniqueSourceIds.map((id) => rowsById.get(id)!);
      const conflicts: MergeConflict[] = [];

      if (target.is_archived) {
        conflicts.push({
          type: "archived_target",
          target_value: target.id,
          detail: "The retained supplier is archived and must be restored before merging.",
        });
      }
      for (const source of sources) {
        if (source.is_archived) {
          conflicts.push({
            type: "archived_source",
            source_supplier_id: source.id,
            source_value: source.id,
            detail: "An archived supplier cannot be merged as a duplicate.",
          });
        }
        for (const field of ["country", "tax_number"] as const) {
          const sourceValue = source[field];
          const targetValue = target[field];
          if (sourceValue && targetValue && sourceValue !== targetValue) {
            conflicts.push({
              type: `conflicting_${field}`,
              source_supplier_id: source.id,
              source_value: sourceValue,
              target_value: targetValue,
              detail: `${field} differs between the retained supplier and a duplicate.`,
            });
          }
        }
        if (
          source.odoo_partner_id !== null &&
          source.odoo_partner_id !== target.odoo_partner_id
        ) {
          conflicts.push({
            type: "conflicting_odoo_partner",
            source_supplier_id: source.id,
            source_value: source.odoo_partner_id,
            target_value: target.odoo_partner_id,
            detail: "The duplicate is linked to a different Odoo partner.",
          });
        }
      }

      const duplicateBaseItems = await client.query<{ source_supplier_id: number; base_item_id: number }>(
        `SELECT DISTINCT bis.supplier_id AS source_supplier_id, bis.base_item_id
           FROM base_item_suppliers bis
           JOIN base_item_suppliers retained
             ON retained.workspace_owner_id = bis.workspace_owner_id
            AND retained.base_item_id = bis.base_item_id
            AND retained.supplier_id = $1
          WHERE bis.workspace_owner_id = $2
            AND bis.supplier_id = ANY($3)`,
        [targetId, wreq.workspaceOwnerId, uniqueSourceIds],
      );
      for (const row of duplicateBaseItems.rows) {
        conflicts.push({
          type: "duplicate_base_item_link",
          source_supplier_id: row.source_supplier_id,
          source_value: row.base_item_id,
          detail: "Both suppliers are linked to the same base item; resolve that link before merging.",
        });
      }

      const duplicateReconciliations = await client.query<{ source_supplier_id: number; accounting_entity_month_id: number }>(
        `SELECT DISTINCT src.supplier_id AS source_supplier_id, src.accounting_entity_month_id
           FROM supplier_reconciliation_sessions src
           JOIN supplier_reconciliation_sessions retained
             ON retained.accounting_entity_month_id = src.accounting_entity_month_id
            AND retained.supplier_id = $1
          WHERE src.workspace_owner_id = $2
            AND src.supplier_id = ANY($3)`,
        [targetId, wreq.workspaceOwnerId, uniqueSourceIds],
      );
      for (const row of duplicateReconciliations.rows) {
        conflicts.push({
          type: "duplicate_reconciliation_period",
          source_supplier_id: row.source_supplier_id,
          source_value: row.accounting_entity_month_id,
          detail: "Both suppliers have a reconciliation session for the same accounting period.",
        });
      }

      const duplicateInvoices = await client.query<{ conflict_key: string; source_supplier_id: number }>(
        `SELECT DISTINCT key_value AS conflict_key, source_supplier_id
           FROM (
             SELECT si.supplier_id AS source_supplier_id,
                    'ai_import:' || si.ai_import_id::text AS key_value
               FROM supplier_invoices si
               JOIN supplier_invoices retained
                 ON retained.workspace_owner_id = si.workspace_owner_id
                AND retained.ai_import_id = si.ai_import_id
                AND retained.supplier_id = $1
              WHERE si.workspace_owner_id = $2
                AND si.supplier_id = ANY($3)
                AND si.ai_import_id IS NOT NULL
             UNION ALL
             SELECT si.supplier_id,
                    'odoo:' || si.odoo_sync_idempotency_key
               FROM supplier_invoices si
               JOIN supplier_invoices retained
                 ON retained.workspace_owner_id = si.workspace_owner_id
                AND retained.odoo_sync_idempotency_key = si.odoo_sync_idempotency_key
                AND retained.supplier_id = $1
              WHERE si.workspace_owner_id = $2
                AND si.supplier_id = ANY($3)
                AND si.odoo_sync_idempotency_key IS NOT NULL
             UNION ALL
             SELECT si.supplier_id,
                    'provider:' || si.provider_sync_idempotency_key
               FROM supplier_invoices si
               JOIN supplier_invoices retained
                 ON retained.workspace_owner_id = si.workspace_owner_id
                AND retained.provider_sync_idempotency_key = si.provider_sync_idempotency_key
                AND retained.supplier_id = $1
              WHERE si.workspace_owner_id = $2
                AND si.supplier_id = ANY($3)
                AND si.provider_sync_idempotency_key IS NOT NULL
           ) conflicts`,
        [targetId, wreq.workspaceOwnerId, uniqueSourceIds],
      );
      for (const row of duplicateInvoices.rows) {
        conflicts.push({
          type: "duplicate_invoice_idempotency_key",
          source_supplier_id: row.source_supplier_id,
          source_value: row.conflict_key,
          detail: "An invoice identity already exists on the retained supplier.",
        });
      }

      const blockingConflictTypes = new Set([
        "archived_target",
        "archived_source",
        "duplicate_base_item_link",
        "duplicate_reconciliation_period",
        "duplicate_invoice_idempotency_key",
      ]);
      const blockingConflicts = conflicts.filter((conflict) =>
        blockingConflictTypes.has(conflict.type),
      );
      if (
        blockingConflicts.length > 0 ||
        (conflicts.length > 0 && body.confirm_conflicts !== true)
      ) {
        return {
          kind: "conflict",
          target,
          sources,
          conflicts,
          blocking_conflicts: blockingConflicts,
        };
      }

      const moved: Record<string, number> = {};
      const updates: Array<[string, string]> = [
        ["ai_invoice_imports", "supplier_id"],
        ["supplier_invoices", "supplier_id"],
        ["purchase_orders", "supplier_id"],
        ["supplier_activities", "supplier_id"],
        ["supplier_documents", "supplier_id"],
        ["supplier_statements", "supplier_id"],
        ["supplier_catalog_items", "supplier_id"],
        ["base_item_suppliers", "supplier_id"],
        ["supplier_reconciliation_sessions", "supplier_id"],
      ];
      for (const [table, column] of updates) {
        const updated = await client.query(
          `UPDATE ${table}
              SET ${column} = $1
            WHERE ${column} = ANY($2)
              AND workspace_owner_id = $3`,
          [targetId, uniqueSourceIds, wreq.workspaceOwnerId],
        );
        moved[table] = updated.rowCount ?? 0;
      }

      // Assignment tables are many-to-many relations. Collapse exact duplicates
      // before moving the remaining rows, preserving the retained supplier's row.
      const deletedAssignments = await client.query(
        `DELETE FROM supplier_assignments source
          USING supplier_assignments retained
         WHERE source.supplier_id = ANY($1)
           AND source.workspace_owner_id = $2
           AND retained.supplier_id = $3
           AND retained.member_id = source.member_id`,
        [uniqueSourceIds, wreq.workspaceOwnerId, targetId],
      );
      const movedAssignments = await client.query(
        `UPDATE supplier_assignments
            SET supplier_id = $1
          WHERE supplier_id = ANY($2) AND workspace_owner_id = $3`,
        [targetId, uniqueSourceIds, wreq.workspaceOwnerId],
      );
      moved.supplier_assignments =
        (deletedAssignments.rowCount ?? 0) + (movedAssignments.rowCount ?? 0);

      const deletedDefaults = await client.query(
        `DELETE FROM supplier_default_assignees source
          USING supplier_default_assignees retained
         WHERE source.supplier_id = ANY($1)
           AND source.workspace_owner_id = $2
           AND retained.supplier_id = $3
           AND retained.member_user_id = source.member_user_id`,
        [uniqueSourceIds, wreq.workspaceOwnerId, targetId],
      );
      const movedDefaults = await client.query(
        `UPDATE supplier_default_assignees
            SET supplier_id = $1
          WHERE supplier_id = ANY($2) AND workspace_owner_id = $3`,
        [targetId, uniqueSourceIds, wreq.workspaceOwnerId],
      );
      moved.supplier_default_assignees =
        (deletedDefaults.rowCount ?? 0) + (movedDefaults.rowCount ?? 0);

      await client.query(
        `UPDATE suppliers
            SET is_archived = true, updated_by_clerk_id = $1, updated_at = now()
          WHERE id = ANY($2) AND workspace_owner_id = $3`,
        [wreq.userId ?? null, uniqueSourceIds, wreq.workspaceOwnerId],
      );
      await client.query(
        `UPDATE suppliers
            SET updated_by_clerk_id = $1, updated_at = now()
          WHERE id = $2 AND workspace_owner_id = $3`,
        [wreq.userId ?? null, targetId, wreq.workspaceOwnerId],
      );
      await client.query(
        `INSERT INTO supplier_activities
          (supplier_id, workspace_owner_id, actor_clerk_id, action, payload)
         VALUES ($1, $2, $3, 'merged', $4)`,
        [
          targetId,
          wreq.workspaceOwnerId,
          wreq.userId ?? null,
          JSON.stringify({
            source_supplier_ids: uniqueSourceIds,
            archived_supplier_ids: uniqueSourceIds,
            conflicts_confirmed: conflicts.length > 0,
          }),
        ],
      );

      return {
        kind: "merged",
        moved,
        archived_supplier_ids: uniqueSourceIds,
      };
    });

    if (result.kind === "not_found") {
      res.status(404).json({ error: "One or more suppliers were not found in this workspace", missing_ids: result.missing_ids });
      return;
    }
    if (result.kind === "conflict") {
      res.status(409).json({
        error: "Supplier merge needs explicit conflict confirmation",
        requires_confirmation: true,
        target_supplier: result.target,
        source_suppliers: result.sources,
        conflicts: result.conflicts,
        blocking_conflicts: result.blocking_conflicts,
      });
      return;
    }
    res.json({
      ok: true,
      target_supplier_id: targetId,
      archived_supplier_ids: result.archived_supplier_ids,
      moved: result.moved,
    });
  } catch (err) {
    logger.error({ err, targetId, sourceIds: uniqueSourceIds }, "Supplier merge failed");
    res.status(500).json({ error: "Supplier merge failed; no changes were committed" });
  } finally {
    client.release();
  }
});

/**
 * GET /api/suppliers/:id
 * Get a single workspace supplier with item_count, supplier_id_label, and Clerk names.
 */
router.get("/suppliers/:id", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid supplier id" });
    return;
  }

  const result = await db.query<SupplierRow & { item_count: number; invoice_count: number; spend_ytd: string | null; spend_ytd_currency: string | null; paid_count: number; outstanding_count: number }>(
    `SELECT s.*,
       (SELECT COUNT(*)::int FROM base_item_suppliers bis WHERE bis.supplier_id = s.id AND bis.workspace_owner_id = s.workspace_owner_id) AS item_count,
       (SELECT COUNT(*)::int FROM supplier_invoices si WHERE si.supplier_id = s.id AND si.workspace_owner_id = s.workspace_owner_id) AS invoice_count,
       (SELECT COALESCE(SUM(si.amount), 0)::text FROM supplier_invoices si WHERE si.supplier_id = s.id AND si.workspace_owner_id = s.workspace_owner_id AND si.status <> 'cancelled' AND si.issued_at >= date_trunc('year', NOW())) AS spend_ytd,
       s.currency_pref AS spend_ytd_currency,
       (SELECT COUNT(*)::int FROM supplier_invoices si WHERE si.supplier_id = s.id AND si.workspace_owner_id = s.workspace_owner_id AND si.status = 'paid') AS paid_count,
       (SELECT COUNT(*)::int FROM supplier_invoices si WHERE si.supplier_id = s.id AND si.workspace_owner_id = s.workspace_owner_id AND si.status NOT IN ('paid', 'cancelled')) AS outstanding_count
     FROM suppliers s
     WHERE s.id = $1 AND s.workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (result.rowCount === 0) {
    res.status(404).json({ error: "Supplier not found" });
    return;
  }

  const row = result.rows[0];

  const userIdSet = new Set<string>();
  if (row.created_by_clerk_id) userIdSet.add(row.created_by_clerk_id);
  if (row.updated_by_clerk_id) userIdSet.add(row.updated_by_clerk_id);
  const nameMap = await fetchClerkNames([...userIdSet]);

  const [assignmentsMap] = await Promise.all([
    fetchSupplierAssignments([row.id], wreq.workspaceOwnerId),
  ]);

  const supplier = {
    ...row,
    tags: parseSupplierTags(row.tags),
    supplier_id_label: supplierIdLabel(row.id),
    created_by_name: formatName(nameMap.get(row.created_by_clerk_id ?? "")),
    updated_by_name: formatName(nameMap.get(row.updated_by_clerk_id ?? "")),
    assignments: assignmentsMap.get(row.id) ?? [],
  };

  res.json({ supplier });
});

/**
 * PUT /api/suppliers/:id/assignments
 * Replace all assignments for a single supplier.
 * body: { member_ids: number[], lead_member_id?: number | null }
 */
router.put("/suppliers/:id/assignments", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "suppliers.edit")) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid supplier id" });
    return;
  }

  const supplierCheck = await db.query<{ id: number }>(
    `SELECT id FROM suppliers WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (supplierCheck.rows.length === 0) {
    res.status(404).json({ error: "Supplier not found" });
    return;
  }

  const { member_ids, lead_member_id } = req.body as {
    member_ids?: unknown;
    lead_member_id?: unknown;
  };

  if (!Array.isArray(member_ids)) {
    res.status(400).json({ error: "member_ids must be an array" });
    return;
  }

  const memberIdsArr = member_ids.map(Number).filter((n) => !isNaN(n));
  const leadId = lead_member_id != null ? Number(lead_member_id) : null;

  if (memberIdsArr.length > 0) {
    const memberCheck = await db.query<{ id: number }>(
      `SELECT id FROM workspace_members WHERE id = ANY($1) AND workspace_owner_id = $2`,
      [memberIdsArr, wreq.workspaceOwnerId],
    );
    if (memberCheck.rows.length !== memberIdsArr.length) {
      res.status(400).json({ error: "One or more member_ids not found in this workspace" });
      return;
    }
  }

  await db.query(`BEGIN`);
  try {
    await db.query(
      `DELETE FROM supplier_assignments WHERE supplier_id = $1 AND workspace_owner_id = $2`,
      [id, wreq.workspaceOwnerId],
    );
    if (memberIdsArr.length > 0) {
      for (const memberId of memberIdsArr) {
        await db.query(
          `INSERT INTO supplier_assignments (supplier_id, member_id, workspace_owner_id, is_lead, created_by_clerk_id)
             VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (supplier_id, member_id) DO UPDATE SET is_lead = EXCLUDED.is_lead`,
          [id, memberId, wreq.workspaceOwnerId, memberId === leadId, wreq.userId ?? null],
        );
      }
    }
    await db.query(
      `INSERT INTO supplier_activities (supplier_id, workspace_owner_id, actor_clerk_id, action, payload)
         VALUES ($1, $2, $3, 'assignments_updated', $4)`,
      [
        id,
        wreq.workspaceOwnerId,
        wreq.userId ?? null,
        JSON.stringify({ member_ids: memberIdsArr, lead_member_id: leadId }),
      ],
    );
    await db.query(`COMMIT`);
  } catch (err) {
    await db.query(`ROLLBACK`);
    throw err;
  }

  const assignmentsMap = await fetchSupplierAssignments([id], wreq.workspaceOwnerId);
  res.json({ assignments: assignmentsMap.get(id) ?? [] });
});

/**
 * GET /api/suppliers/:id/items
 * List base items linked to this supplier.
 */
router.get("/suppliers/:id/items", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid supplier id" });
    return;
  }

  const check = await db.query(
    `SELECT id FROM suppliers WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (check.rowCount === 0) {
    res.status(404).json({ error: "Supplier not found" });
    return;
  }

  const result = await db.query<{
    link_id: number;
    base_item_id: number;
    code: string;
    name: string;
    image_url: string | null;
    main_category_name: string | null;
    sub_category_name: string | null;
    supplier_item_name: string | null;
    supplier_item_code: string | null;
    pricing_uom: string | null;
    price: string | null;
    currency: string;
    is_preferred: boolean;
    is_default_order_unit: boolean;
    package_name: string | null;
  }>(
    `SELECT
        bis.id          AS link_id,
        bi.id           AS base_item_id,
        bi.code,
        bi.name,
        bi.image_url,
        main_cat.name   AS main_category_name,
        sub_cat.name    AS sub_category_name,
        bis.supplier_item_name,
        bis.supplier_item_code,
        COALESCE(uc.display_name, bis.pricing_uom) AS pricing_uom,
        bis.price,
        bis.currency,
        bis.is_preferred,
        bis.is_default_order_unit,
        bip.name        AS package_name
      FROM base_item_suppliers bis
      JOIN base_items bi ON bi.id = bis.base_item_id
      LEFT JOIN uom_catalog uc ON uc.code = bis.pricing_uom_code
      LEFT JOIN base_item_packages bip ON bip.id = bis.package_id
      LEFT JOIN base_item_categories sub_cat  ON sub_cat.id  = bi.category_id
      LEFT JOIN base_item_categories main_cat ON main_cat.id = sub_cat.parent_id
                                             OR (sub_cat.parent_id IS NULL AND main_cat.id = bi.category_id)
      WHERE bis.supplier_id = $1
        AND bis.workspace_owner_id = $2
      ORDER BY bi.name ASC`,
    [id, wreq.workspaceOwnerId],
  );

  res.json({ items: result.rows });
});

/**
 * POST /api/suppliers
 * Create a workspace supplier. Owner only.
 */
router.post("/suppliers", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "suppliers.create")) {
    res.status(403).json({ error: "Insufficient permissions to create suppliers" });
    return;
  }

  const {
    name, display_name, contact_name, contact_email, contact_phone, country, tax_number,
    supplier_code, payment_terms, currency_pref, lead_time_days, min_order_value, notes,
    category, vat_registered, vat_status, vat_not_registered_reason, billing_address, website, tags,
    default_tax_category,
  } = req.body ?? {};
  const trimmedName = String(name ?? "").trim();
  if (!trimmedName) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  const trimmedDisplayName = display_name ? String(display_name).trim() : null;
  const effectiveDisplayName = trimmedDisplayName || trimmedName;
  const userId = authed(req).userId;
  const force = req.query.force === "true";

  // Exact + similar-name duplicate guard (skipped when ?force=true is explicitly passed)
  if (!force) {
    const normalizedInput = normalizeSupplierName(trimmedName);
    const existing = await db.query<SupplierRow>(
      `SELECT * FROM suppliers WHERE workspace_owner_id = $1 AND is_archived = false`,
      [wreq.workspaceOwnerId],
    );

    const nameResult = computeDuplicates(normalizedInput, existing.rows);
    const normalizedTaxInput = tax_number
      ? String(tax_number).replace(/[^\p{L}\p{N}]/gu, "").toLowerCase()
      : "";
    const exactTaxMatch = normalizedTaxInput
      ? existing.rows.find((supplier) => {
          const normalizedTax = String(supplier.tax_number ?? "")
            .replace(/[^\p{L}\p{N}]/gu, "")
            .toLowerCase();
          return normalizedTax.length > 0 && normalizedTax === normalizedTaxInput;
        })
      : undefined;

    // Optionally check display name when it differs from the primary name
    let displayResult: ReturnType<typeof computeDuplicates> | null = null;
    if (trimmedDisplayName) {
      const normalizedDisplay = normalizeSupplierName(trimmedDisplayName);
      if (normalizedDisplay !== normalizedInput) {
        displayResult = computeDuplicates(normalizedDisplay, existing.rows);
      }
    }

    const isExactMatch = nameResult.exactMatch || (displayResult?.exactMatch ?? false) || Boolean(exactTaxMatch);
    if (isExactMatch) {
      const allMatches = [...nameResult.similarMatches, ...(displayResult?.similarMatches ?? [])];
      const exactEntry = exactTaxMatch
        ? { id: exactTaxMatch.id }
        : allMatches.find((m) => m.score === 100);
      res.status(409).json({ error: "A supplier with this name or tax number already exists.", existingId: exactEntry?.id });
      return;
    }

    // Merge similar matches (deduplicated by id, highest score wins)
    const seenIds = new Set<number>();
    const allSimilar: SupplierMatchResult[] = [];
    for (const m of [...nameResult.similarMatches, ...(displayResult?.similarMatches ?? [])]) {
      if (!seenIds.has(m.id)) {
        seenIds.add(m.id);
        allSimilar.push(m);
      }
    }
    allSimilar.sort((a, b) => b.score - a.score);

    if (allSimilar.length > 0) {
      res.status(422).json({ warning: true, similarMatches: allSimilar });
      return;
    }
  }

  const tagsJson = Array.isArray(tags) ? JSON.stringify(tags) : (tags ? String(tags) : null);
  const { default_vat_treatment, default_vat_rate } = req.body ?? {};

  // Resolve vat_status (3-state) and derive legacy vat_registered boolean.
  const VALID_VAT_STATUSES = ["registered", "not_registered", "unknown"] as const;
  type VatStatus = typeof VALID_VAT_STATUSES[number];
  const resolvedVatStatus: VatStatus =
    vat_status && VALID_VAT_STATUSES.includes(vat_status as VatStatus)
      ? (vat_status as VatStatus)
      : (vat_registered != null ? (Boolean(vat_registered) ? "registered" : "not_registered") : "unknown");
  const resolvedVatRegistered = resolvedVatStatus === "registered";
  const resolvedVatReason = resolvedVatStatus === "not_registered"
    ? (vat_not_registered_reason ? String(vat_not_registered_reason).trim() || null : null)
    : null;

  const result = await db.query<SupplierRow>(
    `INSERT INTO suppliers (
       workspace_owner_id, name, display_name, contact_name, contact_email, contact_phone, country, tax_number,
       supplier_code, payment_terms, currency_pref, lead_time_days, min_order_value, notes,
       category, vat_registered, vat_status, vat_not_registered_reason,
       default_vat_treatment, default_vat_rate, default_tax_category, billing_address, website, tags,
       created_by_clerk_id, updated_by_clerk_id, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $25, now())
     RETURNING *`,
    [
      wreq.workspaceOwnerId,
      trimmedName,
      effectiveDisplayName,
      contact_name ? String(contact_name).trim() || null : null,
      contact_email ? String(contact_email).trim() || null : null,
      contact_phone ? String(contact_phone).trim() || null : null,
      country ? String(country).trim() || null : null,
      tax_number ? String(tax_number).trim() || null : null,
      supplier_code ? String(supplier_code).trim() || null : null,
      payment_terms ? String(payment_terms).trim() || null : null,
      currency_pref ? String(currency_pref).trim() || null : null,
      lead_time_days != null ? (Number.isFinite(Number(lead_time_days)) ? Number(lead_time_days) : null) : null,
      min_order_value != null ? String(min_order_value).trim() || null : null,
      notes ? String(notes).trim() || null : null,
      category ? String(category).trim() || null : null,
      resolvedVatRegistered,
      resolvedVatStatus,
      resolvedVatReason,
      default_vat_treatment ? String(default_vat_treatment).trim() || null : null,
      default_vat_rate != null ? String(default_vat_rate) : null,
      default_tax_category ? String(default_tax_category).trim() || null : null,
      billing_address ? String(billing_address).trim() || null : null,
      website ? String(website).trim() || null : null,
      tagsJson,
      userId,
    ],
  );
  const row = result.rows[0];
  res.status(201).json({ supplier: { ...row, tags: parseSupplierTags(row.tags) } });
});

/**
 * PATCH /api/suppliers/:id
 * Update a workspace supplier. Owner only.
 */
router.patch("/suppliers/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "suppliers.edit")) {
    res.status(403).json({ error: "Insufficient permissions to edit suppliers" });
    return;
  }

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid supplier id" });
    return;
  }

  const existing = await db.query<SupplierRow>(
    `SELECT * FROM suppliers WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (existing.rowCount === 0) {
    res.status(404).json({ error: "Supplier not found" });
    return;
  }

  const prev = existing.rows[0];
  const body = req.body ?? {};
  const userId = authed(req).userId;

  const name = "name" in body ? String(body.name ?? "").trim() : prev.name;
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  const force = req.query.force === "true";

  // Exact + similar-name duplicate guard when name or display_name is being changed (skipped when ?force=true)
  if (!force && ("name" in body || "display_name" in body)) {
    const trimmedDisplayName = "display_name" in body
      ? (body.display_name ? String(body.display_name).trim() : null)
      : prev.display_name;
    const normalizedInput = normalizeSupplierName(name);

    const otherSuppliers = await db.query<SupplierRow>(
      `SELECT * FROM suppliers WHERE workspace_owner_id = $1 AND is_archived = false AND id != $2`,
      [wreq.workspaceOwnerId, id],
    );

    const nameResult = computeDuplicates(normalizedInput, otherSuppliers.rows);

    let displayResult: ReturnType<typeof computeDuplicates> | null = null;
    if (trimmedDisplayName) {
      const normalizedDisplay = normalizeSupplierName(trimmedDisplayName);
      if (normalizedDisplay !== normalizedInput) {
        displayResult = computeDuplicates(normalizedDisplay, otherSuppliers.rows);
      }
    }

    const isExactMatch = nameResult.exactMatch || (displayResult?.exactMatch ?? false);
    if (isExactMatch) {
      const allMatches = [...nameResult.similarMatches, ...(displayResult?.similarMatches ?? [])];
      const exactEntry = allMatches.find((m) => m.score === 100);
      res.status(409).json({ error: "A supplier with this name already exists.", existingId: exactEntry?.id });
      return;
    }

    const seenIds = new Set<number>();
    const allSimilar: SupplierMatchResult[] = [];
    for (const m of [...nameResult.similarMatches, ...(displayResult?.similarMatches ?? [])]) {
      if (!seenIds.has(m.id)) {
        seenIds.add(m.id);
        allSimilar.push(m);
      }
    }
    allSimilar.sort((a, b) => b.score - a.score);

    if (allSimilar.length > 0) {
      res.status(422).json({ warning: true, similarMatches: allSimilar });
      return;
    }
  }

  const displayName = "display_name" in body
    ? (body.display_name ? String(body.display_name).trim() || null : null)
    : prev.display_name;

  // Exact-match duplicate guard (excluding this supplier)
  if ("name" in body || "display_name" in body) {
    const normalizedInput = normalizeSupplierName(name);
    const normalizedDisplay = displayName ? normalizeSupplierName(displayName) : null;
    const others = await db.query<{ id: number; name: string; display_name: string | null }>(
      `SELECT id, name, display_name FROM suppliers WHERE workspace_owner_id = $1 AND is_archived = false AND id <> $2`,
      [wreq.workspaceOwnerId, id],
    );
    for (const row of others.rows) {
      const normName = normalizeSupplierName(row.name);
      const normDisplay = row.display_name ? normalizeSupplierName(row.display_name) : null;
      if (
        normalizedInput === normName ||
        normalizedInput === normDisplay ||
        (normalizedDisplay && (normalizedDisplay === normName || normalizedDisplay === normDisplay))
      ) {
        res.status(409).json({ error: "A supplier with this name already exists.", existingId: row.id });
        return;
      }
    }
  }

  const contactName = "contact_name" in body
    ? (body.contact_name ? String(body.contact_name).trim() || null : null)
    : prev.contact_name;
  const contactEmail = "contact_email" in body
    ? (body.contact_email ? String(body.contact_email).trim() || null : null)
    : prev.contact_email;
  const contactPhone = "contact_phone" in body
    ? (body.contact_phone ? String(body.contact_phone).trim() || null : null)
    : prev.contact_phone;
  const country = "country" in body
    ? (body.country ? String(body.country).trim() || null : null)
    : prev.country;
  const taxNumber = "tax_number" in body
    ? (body.tax_number ? String(body.tax_number).trim() || null : null)
    : prev.tax_number;
  const isArchived = "is_archived" in body ? body.is_archived === true : prev.is_archived;

  const supplierCode = "supplier_code" in body
    ? (body.supplier_code ? String(body.supplier_code).trim() || null : null)
    : prev.supplier_code;
  const paymentTerms = "payment_terms" in body
    ? (body.payment_terms ? String(body.payment_terms).trim() || null : null)
    : prev.payment_terms;
  const currencyPref = "currency_pref" in body
    ? (body.currency_pref ? String(body.currency_pref).trim() || null : null)
    : prev.currency_pref;
  const leadTimeDays = "lead_time_days" in body
    ? (body.lead_time_days != null ? (Number.isFinite(Number(body.lead_time_days)) ? Number(body.lead_time_days) : null) : null)
    : prev.lead_time_days;
  const minOrderValue = "min_order_value" in body
    ? (body.min_order_value != null ? String(body.min_order_value).trim() || null : null)
    : prev.min_order_value;
  const notes = "notes" in body
    ? (body.notes ? String(body.notes).trim() || null : null)
    : prev.notes;

  const category = "category" in body
    ? (body.category ? String(body.category).trim() || null : null)
    : prev.category;

  // Resolve vat_status (3-state) — prefer explicit vat_status, fall back to legacy vat_registered.
  const VALID_PATCH_VAT_STATUSES = ["registered", "not_registered", "unknown"] as const;
  type PatchVatStatus = typeof VALID_PATCH_VAT_STATUSES[number];
  const prevVatStatus: PatchVatStatus = (prev.vat_status as PatchVatStatus | null) ?? "unknown";
  let vatStatus: PatchVatStatus;
  if ("vat_status" in body && body.vat_status && VALID_PATCH_VAT_STATUSES.includes(body.vat_status as PatchVatStatus)) {
    vatStatus = body.vat_status as PatchVatStatus;
  } else if ("vat_registered" in body) {
    vatStatus = body.vat_registered ? "registered" : "not_registered";
  } else {
    vatStatus = prevVatStatus;
  }
  const vatRegistered = vatStatus === "registered";
  const vatNotRegisteredReason = "vat_not_registered_reason" in body
    ? (vatStatus === "not_registered" ? (body.vat_not_registered_reason ? String(body.vat_not_registered_reason).trim() || null : null) : null)
    : (vatStatus === "not_registered" ? (prev.vat_not_registered_reason ?? null) : null);

  const billingAddress = "billing_address" in body
    ? (body.billing_address ? String(body.billing_address).trim() || null : null)
    : prev.billing_address;
  const website = "website" in body
    ? (body.website ? String(body.website).trim() || null : null)
    : prev.website;
  const tagsJson = "tags" in body
    ? (Array.isArray(body.tags) ? JSON.stringify(body.tags) : (body.tags ? String(body.tags) : null))
    : prev.tags;
  const defaultVatTreatment = "default_vat_treatment" in body
    ? (body.default_vat_treatment ? String(body.default_vat_treatment).trim() || null : null)
    : prev.default_vat_treatment;
  const defaultVatRate = "default_vat_rate" in body
    ? (body.default_vat_rate != null ? String(body.default_vat_rate) : null)
    : prev.default_vat_rate;
  const defaultTaxCategory = "default_tax_category" in body
    ? (body.default_tax_category ? String(body.default_tax_category).trim() || null : null)
    : prev.default_tax_category;

  const result = await db.query<SupplierRow>(
    `UPDATE suppliers
        SET name = $1, display_name = $2, contact_name = $3, contact_email = $4, contact_phone = $5,
            country = $6, is_archived = $7, tax_number = $8,
            supplier_code = $9, payment_terms = $10, currency_pref = $11,
            lead_time_days = $12, min_order_value = $13, notes = $14,
            category = $15, vat_registered = $16, vat_status = $17, vat_not_registered_reason = $18,
            default_vat_treatment = $19, default_vat_rate = $20,
            default_tax_category = $21,
            billing_address = $22, website = $23, tags = $24,
            updated_by_clerk_id = $25, updated_at = now()
      WHERE id = $26 AND workspace_owner_id = $27
     RETURNING *`,
    [
      name, displayName, contactName, contactEmail, contactPhone,
      country, isArchived, taxNumber,
      supplierCode, paymentTerms, currencyPref,
      leadTimeDays, minOrderValue, notes,
      category, vatRegistered, vatStatus, vatNotRegisteredReason,
      defaultVatTreatment, defaultVatRate, defaultTaxCategory,
      billingAddress, website, tagsJson,
      userId, id, wreq.workspaceOwnerId,
    ],
  );

  // Audit log: record VAT status changes.
  if (vatStatus !== prevVatStatus) {
    await db.query(
      `INSERT INTO supplier_activities (supplier_id, workspace_owner_id, actor_clerk_id, action, payload)
         VALUES ($1, $2, $3, 'vat_status_changed', $4)`,
      [
        id,
        wreq.workspaceOwnerId,
        userId ?? null,
        JSON.stringify({ from: prevVatStatus, to: vatStatus }),
      ],
    ).catch((err) => logger.warn({ err }, "Failed to write vat_status_changed activity"));
  }

  const updated = result.rows[0];
  res.json({ supplier: { ...updated, tags: parseSupplierTags(updated.tags) } });
});

/**
 * DELETE /api/suppliers/:id
 * Soft-delete (archive) a supplier. Owner only.
 * Returns 409 with { open_po_count, open_invoice_count, requires_confirmation: true }
 * if the supplier has open purchase orders or unpaid invoices.
 * Pass ?force=true to bypass the guard and archive anyway.
 */
router.delete("/suppliers/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "suppliers.delete")) {
    res.status(403).json({ error: "Insufficient permissions to archive suppliers" });
    return;
  }

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid supplier id" });
    return;
  }

  const existing = await db.query(
    `SELECT id FROM suppliers WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (existing.rowCount === 0) {
    res.status(404).json({ error: "Supplier not found" });
    return;
  }

  const force = req.query.force === "true";

  if (!force) {
    const checkResult = await db.query<{ open_po_count: number; open_invoice_count: number }>(
      `SELECT
         (SELECT COUNT(*)::int FROM purchase_orders
          WHERE supplier_id = $1 AND workspace_owner_id = $2
            AND status NOT IN ('cancelled', 'received')) AS open_po_count,
         (SELECT COUNT(*)::int FROM supplier_invoices
          WHERE supplier_id = $1 AND workspace_owner_id = $2
            AND status NOT IN ('paid', 'cancelled')) AS open_invoice_count`,
      [id, wreq.workspaceOwnerId],
    );

    const { open_po_count, open_invoice_count } = checkResult.rows[0];

    if (open_po_count > 0 || open_invoice_count > 0) {
      res.status(409).json({
        error: "Supplier has open purchase orders or outstanding invoices",
        open_po_count,
        open_invoice_count,
        requires_confirmation: true,
      });
      return;
    }
  }

  await db.query(
    `UPDATE suppliers SET is_archived = true WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Supplier invoices
// ---------------------------------------------------------------------------

type InvoiceLineItemRow = {
  description: string;
  quantity: number;
  unit_price: number;
  total: number;
  tax_rate?: number;
  account_code?: string;
  product_code?: string;
};

type SupplierInvoiceRow = {
  id: number;
  ai_import_id: number | null;
  supplier_id: number;
  workspace_owner_id: string;
  amount: string;
  currency: string;
  status: string;
  invoice_number: string | null;
  issued_at: string;
  paid_at: string | null;
  notes: string | null;
  reference_type: string | null;
  reference_id: number | null;
  reference_name: string | null;
  created_at: string;
  due_date: string | null;
  vat_amount: string | null;
  delivery_charge: string | null;
  subtotal: string | null;
  discount: string | null;
  grand_total: string | null;
  payment_status: string;
  payment_terms: string | null;
  file_urls: string[] | null;
  line_items: InvoiceLineItemRow[] | null;
};

/**
 * GET /api/suppliers/:id/spend-trend
 * Return month-by-month spend totals for the current calendar year.
 */
router.get("/suppliers/:id/spend-trend", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid supplier id" });
    return;
  }

  const check = await db.query(
    `SELECT id FROM suppliers WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (check.rowCount === 0) {
    res.status(404).json({ error: "Supplier not found" });
    return;
  }

  const requestedYear = req.query.year ? parseInt(req.query.year as string, 10) : NaN;
  const year = !isNaN(requestedYear) && requestedYear > 1900 && requestedYear < 3000
    ? requestedYear
    : new Date().getFullYear();

  const result = await db.query<{ month: number; total: string; currency: string | null }>(
    `SELECT
       EXTRACT(MONTH FROM issued_at)::int AS month,
       COALESCE(SUM(CASE WHEN status <> 'cancelled' THEN amount ELSE 0 END), 0)::text AS total,
       (SELECT currency_pref FROM suppliers WHERE id = $1) AS currency
     FROM supplier_invoices
     WHERE supplier_id = $1
       AND workspace_owner_id = $2
       AND EXTRACT(YEAR FROM issued_at) = $3
     GROUP BY month
     ORDER BY month`,
    [id, wreq.workspaceOwnerId, year],
  );

  const monthMap = new Map(result.rows.map((r) => [r.month, parseFloat(r.total)]));
  const currency = result.rows[0]?.currency ?? null;

  const months = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    total: monthMap.get(i + 1) ?? 0,
  }));

  res.json({ year, currency, months });
});

/**
 * GET /api/suppliers/:id/invoices
 * List invoices for a supplier, with YTD spend total.
 */
router.get("/suppliers/:id/invoices", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid supplier id" });
    return;
  }

  const check = await db.query(
    `SELECT id FROM suppliers WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (check.rowCount === 0) {
    res.status(404).json({ error: "Supplier not found" });
    return;
  }

  const result = await db.query<SupplierInvoiceRow>(
    `SELECT si.*,
            CASE
              WHEN si.reference_type = 'base_item' THEN bi.name
              WHEN si.reference_type = 'purchase_order' THEN COALESCE(po.po_number, 'PO-' || LPAD(po.id::text, 4, '0'))
              ELSE NULL
            END AS reference_name,
            CASE
              WHEN si.ai_import_id IS NOT NULL AND aii.pdf_storage_path IS NOT NULL THEN true
              ELSE false
            END AS ai_import_source_available
       FROM supplier_invoices si
       LEFT JOIN base_items bi ON si.reference_type = 'base_item' AND bi.id = si.reference_id
       LEFT JOIN purchase_orders po ON si.reference_type = 'purchase_order' AND po.id = si.reference_id AND po.workspace_owner_id = si.workspace_owner_id
       LEFT JOIN ai_invoice_imports aii ON aii.id = si.ai_import_id AND aii.workspace_owner_id = si.workspace_owner_id
      WHERE si.supplier_id = $1 AND si.workspace_owner_id = $2
      ORDER BY si.issued_at DESC`,
    [id, wreq.workspaceOwnerId],
  );

  const ytdResult = await db.query<{ spend_ytd: string; spend_ytd_currency: string | null }>(
    `SELECT
       COALESCE(SUM(CASE WHEN status <> 'cancelled' THEN amount ELSE 0 END)::text, '0') AS spend_ytd,
       (SELECT currency_pref FROM suppliers WHERE id = $1) AS spend_ytd_currency
     FROM supplier_invoices
     WHERE supplier_id = $1 AND workspace_owner_id = $2
       AND issued_at >= date_trunc('year', NOW())`,
    [id, wreq.workspaceOwnerId],
  );

  const agg = ytdResult.rows[0];

  res.json({
    invoices: result.rows.map((r) => ({ ...r, line_items: r.line_items ?? [] })),
    invoice_count: result.rowCount ?? 0,
    spend_ytd: agg?.spend_ytd ?? "0",
    spend_ytd_currency: agg?.spend_ytd_currency ?? null,
  });
});

/**
 * POST /api/suppliers/:id/invoices
 * Create an invoice for a supplier. Owner only.
 */
router.post("/suppliers/:id/invoices", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "suppliers.edit")) {
    res.status(403).json({ error: "Insufficient permissions to create invoices" });
    return;
  }

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid supplier id" });
    return;
  }

  const check = await db.query(
    `SELECT id FROM suppliers WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (check.rowCount === 0) {
    res.status(404).json({ error: "Supplier not found" });
    return;
  }

  const {
    amount,
    currency,
    status,
    invoice_number,
    issued_at,
    paid_at,
    notes,
    reference_type,
    reference_id,
    line_items,
    file_urls,
    override_duplicates,
    due_date,
    vat_amount,
    subtotal,
    discount,
    payment_terms,
  } = req.body ?? {};

  if (!amount || !currency || !issued_at) {
    res.status(400).json({ error: "amount, currency, and issued_at are required" });
    return;
  }

  // Duplicate enforcement: run a quick check unless the caller has explicitly overridden.
  // Members can never override — they receive a 409 and must contact an owner.
  if (!override_duplicates) {
    const isOwner = wreq.workspaceRole === "owner";
    const invoiceNum = invoice_number ? String(invoice_number).trim() : null;
    const amountNum = parseFloat(String(amount));

    type DupRow = { id: number; invoice_number: string | null; amount: string; currency: string; issued_at: string; status: string };
    const dupMatches: (DupRow & { reason: string })[] = [];

    if (invoiceNum) {
      const r = await db.query<DupRow>(
        `SELECT id, invoice_number, amount, currency, issued_at, status
           FROM supplier_invoices
          WHERE supplier_id = $1 AND workspace_owner_id = $2 AND invoice_number = $3
          LIMIT 5`,
        [id, wreq.workspaceOwnerId, invoiceNum],
      );
      dupMatches.push(...r.rows.map((row) => ({ ...row, reason: "Same invoice number" })));
    }

    if (!isNaN(amountNum) && issued_at && currency) {
      const r = await db.query<DupRow>(
        `SELECT id, invoice_number, amount, currency, issued_at, status
           FROM supplier_invoices
          WHERE supplier_id = $1 AND workspace_owner_id = $2
            AND ABS(amount::numeric - $3::numeric) < 0.01
            AND currency = $4
            AND issued_at::date BETWEEN ($5)::date - INTERVAL '1 day' AND ($5)::date + INTERVAL '1 day'
          LIMIT 5`,
        [id, wreq.workspaceOwnerId, amountNum.toFixed(4), String(currency), issued_at],
      );
      for (const row of r.rows) {
        if (!dupMatches.find((x) => x.id === row.id)) {
          dupMatches.push({ ...row, reason: "Same amount, currency, and date" });
        }
      }
    }

    if (dupMatches.length > 0) {
      const duplicates = dupMatches.map((row) => ({
        id: row.id,
        invoiceNumber: row.invoice_number,
        amount: row.amount,
        currency: row.currency,
        issuedAt: row.issued_at,
        status: row.status,
        reason: row.reason,
      }));
      res.status(409).json({
        error: "Potential duplicate invoices found",
        code: "DUPLICATE_INVOICES",
        duplicates,
        canOverride: isOwner,
      });
      return;
    }
  }

  const refType = reference_type ? String(reference_type) : null;
  const refId = reference_id != null ? parseInt(String(reference_id), 10) : null;
  const lineItemsJson = Array.isArray(line_items) ? JSON.stringify(line_items) : null;
  const fileUrlsJson = Array.isArray(file_urls) && file_urls.length > 0 ? JSON.stringify(file_urls) : null;

  const result = await db.query<SupplierInvoiceRow>(
    `INSERT INTO supplier_invoices (supplier_id, workspace_owner_id, amount, currency, status, invoice_number, issued_at, paid_at, notes, reference_type, reference_id, line_items, file_urls, due_date, vat_amount, subtotal, discount, payment_terms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
     RETURNING *,
       CASE
         WHEN reference_type = 'base_item' THEN (SELECT name FROM base_items WHERE id = reference_id)
         WHEN reference_type = 'purchase_order' THEN (SELECT COALESCE(po_number, 'PO-' || LPAD(id::text, 4, '0')) FROM purchase_orders WHERE id = reference_id AND workspace_owner_id = $2)
         ELSE NULL
       END AS reference_name`,
    [
      id,
      wreq.workspaceOwnerId,
      String(amount),
      String(currency),
      status ? String(status) : "issued",
      invoice_number ? String(invoice_number).trim() || null : null,
      issued_at,
      paid_at || null,
      notes ? String(notes).trim() || null : null,
      refType,
      refId,
      lineItemsJson,
      fileUrlsJson,
      due_date || null,
      vat_amount != null ? String(vat_amount) : null,
      subtotal != null ? String(subtotal) : null,
      discount != null ? String(discount) : null,
      payment_terms ? String(payment_terms).trim() || null : null,
    ],
  );
  res.status(201).json({ invoice: { ...result.rows[0], line_items: result.rows[0].line_items ?? [] } });
});

/**
 * POST /api/suppliers/:id/invoices/extract
 * Upload a file (PDF/JPG/PNG ≤ 20 MB), store it, and extract invoice data via AI.
 */
router.post(
  "/suppliers/:id/invoices/extract",
  upload.single("file"),
  async (req, res) => {
    const wreq = workspace(req);
    if (!hasPermission(wreq, "suppliers.edit")) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid supplier id" });
      return;
    }

    const supplierRow = await db.query<{ id: number; name: string; tax_number: string | null }>(
      `SELECT id, name, tax_number FROM suppliers WHERE id = $1 AND workspace_owner_id = $2`,
      [id, wreq.workspaceOwnerId],
    );
    if (supplierRow.rowCount === 0) {
      res.status(404).json({ error: "Supplier not found" });
      return;
    }
    const supplier = supplierRow.rows[0];

    const file = (req as unknown as { file?: Express.Multer.File }).file;
    if (!file) {
      res.status(400).json({ error: "A file is required" });
      return;
    }

    const allowedMimeTypes = ["application/pdf", "image/jpeg", "image/jpg", "image/png"];
    if (!allowedMimeTypes.includes(file.mimetype)) {
      res.status(400).json({ error: "Only PDF, JPG, and PNG files are supported" });
      return;
    }

    if (file.size > 20 * 1024 * 1024) {
      res.status(400).json({ error: "File size must be 20 MB or less" });
      return;
    }

    const privateObjectDir = process.env.PRIVATE_OBJECT_DIR;
    if (!privateObjectDir) {
      res.status(500).json({ error: "Object storage not configured" });
      return;
    }

    let fileUrl: string;
    try {
      const objectId = randomUUID();
      const ext = file.mimetype === "application/pdf" ? "pdf"
        : file.mimetype === "image/png" ? "png" : "jpg";
      const fullPath = `${privateObjectDir}/${wreq.workspaceOwnerId}/supplier-invoices/${objectId}.${ext}`;
      const parts = fullPath.startsWith("/") ? fullPath.slice(1).split("/") : fullPath.split("/");
      const bucketName = parts[0];
      const objectName = parts.slice(1).join("/");

      const bucket = objectStorageClient.bucket(bucketName);
      const gcsFile = bucket.file(objectName);
      await gcsFile.save(file.buffer, {
        metadata: { contentType: file.mimetype },
        resumable: false,
      });
      fileUrl = `/objects/${wreq.workspaceOwnerId}/supplier-invoices/${objectId}.${ext}`;
    } catch (err) {
      logger.error({ err }, "suppliers extract: failed to upload file to storage");
      res.status(500).json({ error: "Failed to store uploaded file" });
      return;
    }

    const EXTRACT_TIMEOUT_MS = 30_000;
    try {
      const extracted = await Promise.race([
        extractInvoiceDataFromBuffer(
          file.buffer,
          file.mimetype,
          supplier.name,
          supplier.tax_number,
          { workspaceOwnerId: wreq.workspaceOwnerId },
        ),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Extraction timed out after 30 seconds")), EXTRACT_TIMEOUT_MS),
        ),
      ]);

      const fieldsDetected = [
        extracted.vendor_name,
        extracted.invoice_number,
        extracted.invoice_date,
        extracted.due_date,
        extracted.currency,
        extracted.total_amount,
        extracted.subtotal,
        extracted.discount,
        extracted.tax_amount,
      ].filter(Boolean).length + (extracted.line_items?.length ?? 0);

      res.json({
        fileUrl,
        fileName: file.originalname,
        fileSizeBytes: file.size,
        mimeType: file.mimetype,
        extraction: {
          vendor_name: extracted.vendor_name,
          vendor_tax_number: extracted.vendor_tax_number,
          vendor_address: extracted.vendor_address,
          invoice_number: extracted.invoice_number,
          invoice_date: extracted.invoice_date,
          due_date: extracted.due_date,
          currency: extracted.currency,
          subtotal: extracted.subtotal,
          discount: extracted.discount,
          tax_amount: extracted.tax_amount,
          total_amount: extracted.total_amount,
          line_items: extracted.line_items ?? [],
          confidence: extracted.confidence,
          company_validation_status: extracted.company_validation_status,
          company_validation_notes: extracted.company_validation_notes,
        },
        fieldsDetected,
      });
    } catch (err) {
      logger.error({ err }, "suppliers extract: AI extraction failed");
      const message = err instanceof Error ? err.message : "AI extraction failed";
      res.status(422).json({ error: message, fileUrl });
    }
  },
);

/**
 * GET /api/suppliers/:id/invoices/duplicate-check
 * Check for likely duplicate invoices before saving.
 * Query params: invoiceNumber, total, issuedAt, currency
 */
router.get("/suppliers/:id/invoices/duplicate-check", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid supplier id" });
    return;
  }

  const supplierCheck = await db.query<{ id: number }>(
    `SELECT id FROM suppliers WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (supplierCheck.rowCount === 0) {
    res.status(404).json({ error: "Supplier not found" });
    return;
  }

  const invoiceNumber = typeof req.query.invoiceNumber === "string" ? req.query.invoiceNumber.trim() : null;
  const total = typeof req.query.total === "string" ? parseFloat(req.query.total) : null;
  const issuedAt = typeof req.query.issuedAt === "string" ? req.query.issuedAt.trim() : null;
  const currency = typeof req.query.currency === "string" ? req.query.currency.trim() : null;
  const excludeId = typeof req.query.excludeId === "string" ? parseInt(req.query.excludeId, 10) : null;

  const conditions: string[] = ["supplier_id = $1", "workspace_owner_id = $2"];
  const params: unknown[] = [id, wreq.workspaceOwnerId];

  if (excludeId != null && !isNaN(excludeId)) {
    params.push(excludeId);
    conditions.push(`id <> $${params.length}`);
  }

  if (!invoiceNumber && (total == null || isNaN(total))) {
    res.json({ duplicates: [], hasDuplicates: false });
    return;
  }

  type DuplicateRow = { id: number; invoice_number: string | null; amount: string; currency: string; issued_at: string; status: string };
  const results: DuplicateRow[] = [];

  if (invoiceNumber) {
    params.push(invoiceNumber);
    const r = await db.query<DuplicateRow>(
      `SELECT id, invoice_number, amount, currency, issued_at, status
         FROM supplier_invoices
        WHERE ${[...conditions, `invoice_number = $${params.length}`].join(" AND ")}
        LIMIT 5`,
      params,
    );
    for (const row of r.rows) {
      if (!results.find((x) => x.id === row.id)) {
        results.push(row);
      }
    }
    params.pop();
  }

  if (total != null && !isNaN(total) && issuedAt && currency) {
    const amountStr = total.toFixed(4);
    params.push(amountStr, currency, issuedAt);
    const r = await db.query<DuplicateRow>(
      `SELECT id, invoice_number, amount, currency, issued_at, status
         FROM supplier_invoices
        WHERE ${[...conditions, `currency = $${params.length - 1}`, `issued_at::date BETWEEN ($${params.length})::date - INTERVAL '1 day' AND ($${params.length})::date + INTERVAL '1 day'`, `ABS(amount::numeric - $${params.length - 2}::numeric) < 0.01`].join(" AND ")}
        LIMIT 5`,
      params,
    );
    for (const row of r.rows) {
      if (!results.find((x) => x.id === row.id)) {
        results.push(row);
      }
    }
  }

  const duplicates = results.map((row) => ({
    id: row.id,
    invoiceNumber: row.invoice_number,
    amount: row.amount,
    currency: row.currency,
    issuedAt: row.issued_at,
    status: row.status,
    reason: row.invoice_number && invoiceNumber && row.invoice_number === invoiceNumber
      ? "Same invoice number"
      : "Same amount, currency, and date",
  }));

  res.json({ duplicates, hasDuplicates: duplicates.length > 0 });
});

/**
 * GET /api/suppliers/:id/invoices/export
 * Download all invoices for a supplier as a CSV file. Owner only.
 * Optional query params: from (ISO date), to (ISO date)
 */
router.get("/suppliers/:id/invoices/export", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "suppliers.edit")) {
    res.status(403).json({ error: "Insufficient permissions to export invoices" });
    return;
  }

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid supplier id" });
    return;
  }

  const supplierCheck = await db.query<{ name: string }>(
    `SELECT name FROM suppliers WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (supplierCheck.rowCount === 0) {
    res.status(404).json({ error: "Supplier not found" });
    return;
  }

  const supplierName = supplierCheck.rows[0].name;

  const params: unknown[] = [id, wreq.workspaceOwnerId];
  const conditions: string[] = ["supplier_id = $1", "workspace_owner_id = $2"];

  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;

  if (from) {
    params.push(from);
    conditions.push(`issued_at >= $${params.length}`);
  }
  if (to) {
    params.push(to);
    conditions.push(`issued_at <= $${params.length}`);
  }

  const result = await db.query<SupplierInvoiceRow>(
    `SELECT * FROM supplier_invoices WHERE ${conditions.join(" AND ")} ORDER BY issued_at DESC`,
    params,
  );

  function csvEscape(value: string | null | undefined): string {
    if (value == null || value === "") return "";
    const str = String(value);
    if (str.includes(",") || str.includes('"') || str.includes("\n")) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  const header = ["Invoice #", "Date", "Amount", "Currency", "Status", "Paid On", "Notes"].join(",");
  const rows = result.rows.map((inv) => {
    const invoiceNum = inv.invoice_number ?? `INV-${String(inv.id).padStart(4, "0")}`;
    const date = inv.issued_at ? inv.issued_at.slice(0, 10) : "";
    const paidOn = inv.paid_at ? inv.paid_at.slice(0, 10) : "";
    return [
      csvEscape(invoiceNum),
      csvEscape(date),
      csvEscape(inv.amount),
      csvEscape(inv.currency),
      csvEscape(inv.status),
      csvEscape(paidOn),
      csvEscape(inv.notes),
    ].join(",");
  });

  const csv = [header, ...rows].join("\r\n");
  const safeName = supplierName.replace(/[^a-zA-Z0-9_\-]/g, "-").toLowerCase();
  const filename = `invoices-${safeName}.csv`;

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(csv);
});

/**
 * PATCH /api/suppliers/:id/invoices/:invoiceId
 * Update a supplier invoice. Owner only.
 */
router.patch("/suppliers/:id/invoices/:invoiceId", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "suppliers.edit")) {
    res.status(403).json({ error: "Insufficient permissions to update invoices" });
    return;
  }

  const id = parseInt(req.params.id, 10);
  const invoiceId = parseInt(req.params.invoiceId, 10);
  if (isNaN(id) || isNaN(invoiceId)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const existing = await db.query<SupplierInvoiceRow>(
    `SELECT * FROM supplier_invoices WHERE id = $1 AND supplier_id = $2 AND workspace_owner_id = $3`,
    [invoiceId, id, wreq.workspaceOwnerId],
  );
  if (existing.rowCount === 0) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }

  const prev = existing.rows[0];
  if (prev.ai_import_id != null) {
    res.status(409).json({
      error: "Imported invoices must be edited from the AI Invoice Import page",
      ai_import_id: prev.ai_import_id,
    });
    return;
  }
  const body = req.body ?? {};
  const amount = "amount" in body ? String(body.amount) : prev.amount;
  const currency = "currency" in body ? String(body.currency) : prev.currency;
  const status = "status" in body ? String(body.status) : prev.status;
  const invoice_number = "invoice_number" in body ? (body.invoice_number ? String(body.invoice_number).trim() || null : null) : prev.invoice_number;
  const issued_at = "issued_at" in body ? body.issued_at : prev.issued_at;
  const paid_at = "paid_at" in body ? (body.paid_at || null) : prev.paid_at;
  const notes = "notes" in body ? (body.notes ? String(body.notes).trim() || null : null) : prev.notes;
  const reference_type = "reference_type" in body ? (body.reference_type ? String(body.reference_type) : null) : prev.reference_type;
  const reference_id = "reference_id" in body ? (body.reference_id != null ? parseInt(String(body.reference_id), 10) : null) : prev.reference_id;
  const lineItems = "line_items" in body
    ? (Array.isArray(body.line_items) ? JSON.stringify(body.line_items) : null)
    : (prev.line_items ? JSON.stringify(prev.line_items) : null);
  const fileUrls = "file_urls" in body
    ? (Array.isArray(body.file_urls) && body.file_urls.length > 0 ? JSON.stringify(body.file_urls) : null)
    : (prev.file_urls ? JSON.stringify(prev.file_urls) : null);
  const due_date = "due_date" in body ? (body.due_date || null) : prev.due_date;
  const vat_amount = "vat_amount" in body ? (body.vat_amount != null ? String(body.vat_amount) : null) : prev.vat_amount;
  const subtotal = "subtotal" in body ? (body.subtotal != null ? String(body.subtotal) : null) : prev.subtotal;
  const discount = "discount" in body ? (body.discount != null ? String(body.discount) : null) : prev.discount;
  const payment_terms = "payment_terms" in body ? (body.payment_terms ? String(body.payment_terms).trim() || null : null) : prev.payment_terms;

  const result = await db.query<SupplierInvoiceRow>(
    `UPDATE supplier_invoices
        SET amount = $1, currency = $2, status = $3, invoice_number = $4,
            issued_at = $5, paid_at = $6, notes = $7, reference_type = $8, reference_id = $9,
            line_items = $10, file_urls = $11, due_date = $12, vat_amount = $13,
            subtotal = $14, discount = $15, payment_terms = $16
      WHERE id = $17 AND supplier_id = $18 AND workspace_owner_id = $19
     RETURNING *,
       CASE
         WHEN reference_type = 'base_item' THEN (SELECT name FROM base_items WHERE id = reference_id)
         WHEN reference_type = 'purchase_order' THEN (SELECT COALESCE(po_number, 'PO-' || LPAD(id::text, 4, '0')) FROM purchase_orders WHERE id = reference_id AND workspace_owner_id = $19)
         ELSE NULL
       END AS reference_name`,
    [amount, currency, status, invoice_number, issued_at, paid_at, notes, reference_type, reference_id, lineItems, fileUrls, due_date, vat_amount, subtotal, discount, payment_terms, invoiceId, id, wreq.workspaceOwnerId],
  );
  res.json({ invoice: { ...result.rows[0], line_items: result.rows[0].line_items ?? [] } });
});

/**
 * DELETE /api/suppliers/:id/invoices/:invoiceId
 * Delete a supplier invoice. Owner only.
 */
router.delete("/suppliers/:id/invoices/:invoiceId", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "suppliers.edit")) {
    res.status(403).json({ error: "Insufficient permissions to delete invoices" });
    return;
  }

  const id = parseInt(req.params.id, 10);
  const invoiceId = parseInt(req.params.invoiceId, 10);
  if (isNaN(id) || isNaN(invoiceId)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const existing = await db.query<{ id: number; ai_import_id: number | null }>(
    `SELECT id, ai_import_id FROM supplier_invoices WHERE id = $1 AND supplier_id = $2 AND workspace_owner_id = $3`,
    [invoiceId, id, wreq.workspaceOwnerId],
  );
  if (existing.rowCount === 0) {
    res.status(404).json({ error: "Invoice not found" });
    return;
  }
  if (existing.rows[0].ai_import_id != null) {
    res.status(409).json({
      error: "Imported invoices must be unlinked from the AI Invoice Import page",
      ai_import_id: existing.rows[0].ai_import_id,
    });
    return;
  }

  await db.query(
    `DELETE FROM supplier_invoices WHERE id = $1 AND supplier_id = $2 AND workspace_owner_id = $3`,
    [invoiceId, id, wreq.workspaceOwnerId],
  );
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Supplier documents
// ---------------------------------------------------------------------------

/**
 * GET /api/suppliers/:id/documents
 * List documents attached to a supplier.
 */
router.get("/suppliers/:id/documents", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid supplier id" });
    return;
  }

  const check = await db.query(
    `SELECT id FROM suppliers WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (check.rowCount === 0) {
    res.status(404).json({ error: "Supplier not found" });
    return;
  }

  const result = await db.query<SupplierDocumentRow>(
    `SELECT * FROM supplier_documents WHERE supplier_id = $1 AND workspace_owner_id = $2 ORDER BY created_at DESC`,
    [id, wreq.workspaceOwnerId],
  );
  res.json({ documents: result.rows });
});

/**
 * POST /api/suppliers/:id/documents
 * Upload a document and attach it to a supplier. Owner only.
 */
router.post(
  "/suppliers/:id/documents",
  upload.single("file"),
  async (req, res) => {
    const wreq = workspace(req);
    if (!hasPermission(wreq, "suppliers.edit")) {
      res.status(403).json({ error: "Insufficient permissions to upload documents" });
      return;
    }

    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid supplier id" });
      return;
    }

    const check = await db.query(
      `SELECT id FROM suppliers WHERE id = $1 AND workspace_owner_id = $2`,
      [id, wreq.workspaceOwnerId],
    );
    if (check.rowCount === 0) {
      res.status(404).json({ error: "Supplier not found" });
      return;
    }

    const file = (req as unknown as { file?: Express.Multer.File }).file;
    if (!file) {
      res.status(400).json({ error: "A file is required" });
      return;
    }

    const privateObjectDir = process.env.PRIVATE_OBJECT_DIR;
    if (!privateObjectDir) {
      res.status(500).json({ error: "Object storage not configured" });
      return;
    }

    try {
      const objectId = randomUUID();
      const fullPath = `${privateObjectDir}/${wreq.workspaceOwnerId}/supplier-documents/${objectId}`;
      const parts = fullPath.startsWith("/") ? fullPath.slice(1).split("/") : fullPath.split("/");
      const bucketName = parts[0];
      const objectName = parts.slice(1).join("/");

      const bucket = objectStorageClient.bucket(bucketName);
      const gcsFile = bucket.file(objectName);
      await gcsFile.save(file.buffer, {
        contentType: file.mimetype,
        resumable: false,
      });

      const fileUrl = `/objects/${wreq.workspaceOwnerId}/supplier-documents/${objectId}`;
      const userId = authed(req).userId;

      const result = await db.query<SupplierDocumentRow>(
        `INSERT INTO supplier_documents (supplier_id, workspace_owner_id, file_name, file_url, uploaded_by_clerk_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [id, wreq.workspaceOwnerId, file.originalname, fileUrl, userId],
      );

      res.status(201).json({ document: result.rows[0] });
    } catch (err) {
      logger.error({ err }, "Failed to upload supplier document");
      res.status(500).json({ error: "Failed to upload document" });
    }
  },
);

/**
 * DELETE /api/suppliers/:id/documents/:docId
 * Delete a supplier document. Owner only.
 */
router.delete("/suppliers/:id/documents/:docId", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "suppliers.edit")) {
    res.status(403).json({ error: "Insufficient permissions to delete documents" });
    return;
  }

  const id = parseInt(req.params.id, 10);
  const docId = parseInt(req.params.docId, 10);
  if (isNaN(id) || isNaN(docId)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const existing = await db.query<SupplierDocumentRow>(
    `SELECT * FROM supplier_documents WHERE id = $1 AND supplier_id = $2 AND workspace_owner_id = $3`,
    [docId, id, wreq.workspaceOwnerId],
  );
  if (existing.rowCount === 0) {
    res.status(404).json({ error: "Document not found" });
    return;
  }

  await db.query(
    `DELETE FROM supplier_documents WHERE id = $1`,
    [docId],
  );

  res.status(204).end();
});

// ---------------------------------------------------------------------------
// Supplier statements (statement-of-account files)
// ---------------------------------------------------------------------------

type SupplierStatementRow = {
  id: string;
  supplier_id: number;
  workspace_owner_id: string;
  statement_month: number;
  statement_year: number;
  statement_date: string | null;
  currency: string | null;
  opening_balance: string | null;
  closing_balance: string | null;
  file_url: string;
  original_file_name: string;
  mime_type: string | null;
  file_size_bytes: number | null;
  notes: string | null;
  status: string;
  uploaded_by_member_id: number | null;
  finance_entity_id: number | null;
  period_start: string | null;
  period_end: string | null;
  period_label: string | null;
  source_channel: string;
  collection_request_id: string | null;
  received_at: string | null;
  reconciliation_status: string;
  created_at: string;
  updated_at: string;
};

/**
 * GET /api/suppliers/:id/statements
 * List statement-of-account files for a supplier.
 */
router.get("/suppliers/:id/statements", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid supplier id" });
    return;
  }

  const check = await db.query(
    `SELECT id FROM suppliers WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (check.rowCount === 0) {
    res.status(404).json({ error: "Supplier not found" });
    return;
  }

  const result = await db.query<SupplierStatementRow & { uploaded_by_email: string | null }>(
    `SELECT ss.*, wm.member_email AS uploaded_by_email
       FROM supplier_statements ss
       LEFT JOIN workspace_members wm ON wm.id = ss.uploaded_by_member_id
      WHERE ss.supplier_id = $1 AND ss.workspace_owner_id = $2
      ORDER BY ss.statement_year DESC, ss.statement_month DESC, ss.created_at DESC`,
    [id, wreq.workspaceOwnerId],
  );
  res.json({ statements: result.rows });
});

/**
 * POST /api/suppliers/:id/statements
 * Upload a statement-of-account file and attach it to a supplier.
 * Pass ?force=true to allow a duplicate for the same supplier + month + year.
 */
router.post(
  "/suppliers/:id/statements",
  upload.single("file"),
  async (req, res) => {
    const wreq = workspace(req);
    if (!hasPermission(wreq, "suppliers.edit")) {
      res.status(403).json({ error: "Insufficient permissions to upload statements" });
      return;
    }

    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid supplier id" });
      return;
    }

    const check = await db.query(
      `SELECT id FROM suppliers WHERE id = $1 AND workspace_owner_id = $2`,
      [id, wreq.workspaceOwnerId],
    );
    if (check.rowCount === 0) {
      res.status(404).json({ error: "Supplier not found" });
      return;
    }

    const month = parseInt(String(req.body?.statement_month ?? ""), 10);
    const year = parseInt(String(req.body?.statement_year ?? ""), 10);
    if (isNaN(month) || month < 1 || month > 12) {
      res.status(400).json({ error: "statement_month must be between 1 and 12" });
      return;
    }
    if (isNaN(year) || year < 1900 || year > 9999) {
      res.status(400).json({ error: "statement_year is required" });
      return;
    }

    const file = (req as unknown as { file?: Express.Multer.File }).file;
    if (!file) {
      res.status(400).json({ error: "A file is required" });
      return;
    }

    const force = req.query.force === "true";
    if (!force) {
      const dup = await db.query(
        `SELECT id FROM supplier_statements
          WHERE supplier_id = $1 AND workspace_owner_id = $2
            AND statement_month = $3 AND statement_year = $4
          LIMIT 1`,
        [id, wreq.workspaceOwnerId, month, year],
      );
      if ((dup.rowCount ?? 0) > 0) {
        res.status(409).json({
          error: "A statement already exists for this supplier, month and year.",
          duplicate: true,
        });
        return;
      }
    }

    const privateObjectDir = process.env.PRIVATE_OBJECT_DIR;
    if (!privateObjectDir) {
      res.status(500).json({ error: "Object storage not configured" });
      return;
    }

    const statementDateRaw = typeof req.body?.statement_date === "string" && req.body.statement_date.trim()
      ? req.body.statement_date.trim()
      : null;
    const currency = typeof req.body?.currency === "string" && req.body.currency.trim()
      ? req.body.currency.trim()
      : null;
    const openingBalance = req.body?.opening_balance !== undefined && String(req.body.opening_balance).trim() !== ""
      ? String(req.body.opening_balance).trim()
      : null;
    const closingBalance = req.body?.closing_balance !== undefined && String(req.body.closing_balance).trim() !== ""
      ? String(req.body.closing_balance).trim()
      : null;
    const notes = typeof req.body?.notes === "string" && req.body.notes.trim()
      ? req.body.notes.trim()
      : null;
    const financeEntityId = req.body?.finance_entity_id !== undefined && String(req.body.finance_entity_id).trim() !== ""
      ? Number(req.body.finance_entity_id)
      : null;
    if (financeEntityId !== null && (!Number.isInteger(financeEntityId) || financeEntityId < 1)) {
      res.status(400).json({ error: "finance_entity_id must be a positive integer" });
      return;
    }
    if (financeEntityId !== null) {
      const entity = await db.query(
        `SELECT id FROM finance_entities WHERE id = $1 AND workspace_owner_id = $2 AND is_active = true`,
        [financeEntityId, wreq.workspaceOwnerId],
      );
      if (entity.rowCount === 0) {
        res.status(404).json({ error: "Finance entity not found" });
        return;
      }
    }
    const defaultPeriodStart = `${year}-${String(month).padStart(2, "0")}-01`;
    const defaultPeriodEnd = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
    const periodStart = typeof req.body?.period_start === "string" && req.body.period_start.trim()
      ? req.body.period_start.trim()
      : defaultPeriodStart;
    const periodEnd = typeof req.body?.period_end === "string" && req.body.period_end.trim()
      ? req.body.period_end.trim()
      : defaultPeriodEnd;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(periodStart) || !/^\d{4}-\d{2}-\d{2}$/.test(periodEnd) || periodEnd < periodStart) {
      res.status(400).json({ error: "period_start and period_end must be valid dates" });
      return;
    }
    const periodLabel = typeof req.body?.period_label === "string" && req.body.period_label.trim()
      ? req.body.period_label.trim()
      : new Date(`${periodStart}T00:00:00Z`).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
    const sourceChannel = typeof req.body?.source_channel === "string" && req.body.source_channel.trim()
      ? req.body.source_channel.trim()
      : "manual_upload";

    try {
      const objectId = randomUUID();
      const fullPath = `${privateObjectDir}/${wreq.workspaceOwnerId}/supplier-statements/${objectId}`;
      const parts = fullPath.startsWith("/") ? fullPath.slice(1).split("/") : fullPath.split("/");
      const bucketName = parts[0];
      const objectName = parts.slice(1).join("/");

      const bucket = objectStorageClient.bucket(bucketName);
      const gcsFile = bucket.file(objectName);
      await gcsFile.save(file.buffer, {
        contentType: file.mimetype,
        resumable: false,
      });

      const fileUrl = `/objects/${wreq.workspaceOwnerId}/supplier-statements/${objectId}`;

      const result = await db.query<SupplierStatementRow>(
        `INSERT INTO supplier_statements (
           supplier_id, workspace_owner_id, statement_month, statement_year, statement_date,
           currency, opening_balance, closing_balance, file_url, original_file_name,
           mime_type, file_size_bytes, notes, uploaded_by_member_id,
           finance_entity_id, period_start, period_end, period_label, source_channel
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
         RETURNING *`,
        [
          id,
          wreq.workspaceOwnerId,
          month,
          year,
          statementDateRaw,
          currency,
          openingBalance,
          closingBalance,
          fileUrl,
          file.originalname,
          file.mimetype,
          file.size,
          notes,
          wreq.memberDbId,
          financeEntityId,
          periodStart,
          periodEnd,
          periodLabel,
          sourceChannel,
        ],
      );

      let statement = result.rows[0];
      // A uniquely matching upload closes the open collection request. Files
      // without an explicit entity remain manually uploaded for review rather
      // than being guessed into a request from invoice/contact fields.
      if (financeEntityId !== null) {
        const matching = await db.query<{ id: string }>(
          `SELECT id FROM supplier_statement_requests
            WHERE workspace_owner_id = $1 AND supplier_id = $2 AND finance_entity_id = $3
              AND period_start = $4 AND period_end = $5
              AND status NOT IN ('received','reconciled','cancelled')
            LIMIT 2`,
          [wreq.workspaceOwnerId, id, financeEntityId, periodStart, periodEnd],
        );
        if (matching.rowCount === 1) {
          const requestId = matching.rows[0].id;
          const linked = await db.query<SupplierStatementRow>(
            `UPDATE supplier_statements
                SET collection_request_id = $1, received_at = now(),
                    reconciliation_status = 'pending', updated_at = now()
              WHERE id = $2
              RETURNING *`,
            [requestId, statement.id],
          );
          statement = linked.rows[0];
          await db.query(
            `UPDATE supplier_statement_requests
                SET status = 'received', next_action = 'reconcile',
                    next_action_at = NULL, received_at = now(), updated_at = now()
              WHERE id = $1 AND workspace_owner_id = $2`,
            [requestId, wreq.workspaceOwnerId],
          );
        } else if ((matching.rowCount ?? 0) > 1) {
          await db.query(
            `UPDATE supplier_statements SET reconciliation_status = 'review_required', updated_at = now() WHERE id = $1`,
            [statement.id],
          );
          statement = { ...statement, reconciliation_status: "review_required" };
        }
      }

      res.status(201).json({ statement });
    } catch (err) {
      logger.error({ err }, "Failed to upload supplier statement");
      res.status(500).json({ error: "Failed to upload statement" });
    }
  },
);

/**
 * DELETE /api/suppliers/:id/statements/:statementId
 * Delete a supplier statement and remove its stored file. Owner/admin only.
 */
router.delete("/suppliers/:id/statements/:statementId", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "suppliers.edit")) {
    res.status(403).json({ error: "Insufficient permissions to delete statements" });
    return;
  }

  const id = parseInt(req.params.id, 10);
  const statementId = String(req.params.statementId);
  if (isNaN(id) || !statementId) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const existing = await db.query<SupplierStatementRow>(
    `SELECT * FROM supplier_statements WHERE id = $1 AND supplier_id = $2 AND workspace_owner_id = $3`,
    [statementId, id, wreq.workspaceOwnerId],
  );
  if (existing.rowCount === 0) {
    res.status(404).json({ error: "Statement not found" });
    return;
  }

  const statement = existing.rows[0];

  // Best-effort removal of the stored object; never block the DB delete on it.
  const privateObjectDir = process.env.PRIVATE_OBJECT_DIR;
  if (privateObjectDir && statement.file_url) {
    try {
      const relative = statement.file_url.replace(/^\/objects\//, "");
      const fullPath = `${privateObjectDir}/${relative}`;
      const parts = fullPath.startsWith("/") ? fullPath.slice(1).split("/") : fullPath.split("/");
      const bucketName = parts[0];
      const objectName = parts.slice(1).join("/");
      await objectStorageClient.bucket(bucketName).file(objectName).delete({ ignoreNotFound: true });
    } catch (err) {
      logger.warn({ err }, "Failed to remove supplier statement object from storage");
    }
  }

  await db.query(`DELETE FROM supplier_statements WHERE id = $1`, [statementId]);

  res.status(204).end();
});

// ---------------------------------------------------------------------------
// Supplier Catalog Items CRUD
// ---------------------------------------------------------------------------

type SupplierCatalogItemRow = {
  id: number;
  workspace_owner_id: string;
  supplier_id: number;
  base_item_id: number | null;
  supplier_item_code: string | null;
  name: string;
  category: string | null;
  unit: string | null;
  package_size: string | null;
  price: string | null;
  currency: string;
  min_order_quantity: string;
  par_level: string | null;
  current_stock: string | null;
  lead_time_days: number | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  base_item_name?: string | null;
};


/**
 * GET /api/suppliers/:supplierId/linked-base-items
 * PO item selector endpoint — returns only Base Items that have a base_item_suppliers
 * row for the given supplier. Supports ?q= search across 4 fields.
 */
router.get("/suppliers/:supplierId/linked-base-items", async (req, res) => {
  const wreq = workspace(req);
  const supplierId = parseInt(req.params.supplierId, 10);
  if (isNaN(supplierId)) {
    res.status(400).json({ error: "Invalid supplierId" });
    return;
  }

  const q = (req.query.q as string | undefined)?.trim();
  const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10) || 50, 200);

  const sup = await db.query<{ id: number }>(
    `SELECT id FROM suppliers WHERE id = $1 AND workspace_owner_id = $2 AND is_archived = FALSE`,
    [supplierId, wreq.workspaceOwnerId],
  );
  if (sup.rowCount === 0) {
    res.status(404).json({ error: "Supplier not found" });
    return;
  }

  type LinkedBaseItemRow = {
    base_item_supplier_id: number;
    base_item_id: number;
    base_item_name: string;
    base_item_code: string | null;
    image_url: string | null;
    supplier_item_name: string | null;
    supplier_item_code: string | null;
    price: string | null;
    currency: string;
    pricing_uom: string | null;
    is_preferred: boolean;
    name_ar: string | null;
  };

  const params: unknown[] = [supplierId, wreq.workspaceOwnerId];
  let whereClause = `bis.supplier_id = $1 AND bis.workspace_owner_id = $2`;
  if (q) {
    params.push(`%${q}%`);
    whereClause += ` AND (
      bi.name              ILIKE $3
      OR bi.code           ILIKE $3
      OR bis.supplier_item_name ILIKE $3
      OR bis.supplier_item_code ILIKE $3
    )`;
  }
  params.push(limit);
  const limitIdx = params.length;

  const result = await db.query<LinkedBaseItemRow>(
    `SELECT
       bis.id            AS base_item_supplier_id,
       bi.id             AS base_item_id,
       bi.name           AS base_item_name,
       bi.code           AS base_item_code,
       bi.image_url,
       bis.supplier_item_name,
       bis.supplier_item_code,
       bis.price::text   AS price,
       bis.currency,
       COALESCE(uc.display_name, bis.pricing_uom) AS pricing_uom,
       bis.is_preferred,
       bis.name_ar
     FROM base_item_suppliers bis
     JOIN base_items bi ON bi.id = bis.base_item_id
     LEFT JOIN uom_catalog uc ON uc.code = bis.pricing_uom_code
    WHERE ${whereClause}
      AND bi.status = 'active'
    ORDER BY bis.is_preferred DESC, COALESCE(bis.supplier_item_name, bi.name) ASC
    LIMIT $${limitIdx}`,
    params,
  );

  res.json({ items: result.rows });
});

/**
 * GET /api/suppliers/:supplierId/catalog-items
 * List catalog items for a supplier.
 * Returns a merged list: linked base items (source="linked_base_item") first,
 * then standalone supplier_catalog_items (source="standalone").
 */
router.get("/suppliers/:supplierId/catalog-items", async (req, res) => {
  const wreq = workspace(req);
  const supplierId = parseInt(req.params.supplierId, 10);
  if (isNaN(supplierId)) {
    res.status(400).json({ error: "Invalid supplierId" });
    return;
  }

  const q = (req.query.q as string | undefined)?.trim();
  const category = (req.query.category as string | undefined)?.trim();
  const activeOnly = req.query.active_only === "true";
  const lowStockOnly = req.query.low_stock_only === "true";

  // Verify supplier belongs to workspace
  const sup = await db.query<{ id: number }>(
    `SELECT id FROM suppliers WHERE id = $1 AND workspace_owner_id = $2 AND is_archived = FALSE`,
    [supplierId, wreq.workspaceOwnerId],
  );
  if (sup.rowCount === 0) {
    res.status(404).json({ error: "Supplier not found" });
    return;
  }

  type MergedCatalogItemRow = SupplierCatalogItemRow & {
    source: "linked_base_item" | "standalone";
    internal_item_code: string | null;
    internal_item_name: string | null;
    is_preferred: boolean;
  };

  // 1. Linked base items — always included unless low_stock_only (linked items have no stock data)
  let linkedRows: MergedCatalogItemRow[] = [];
  if (!lowStockOnly) {
    const linkedParams: unknown[] = [supplierId, wreq.workspaceOwnerId];
    let linkedWhere = `bis.supplier_id = $1 AND bis.workspace_owner_id = $2`;
    if (q) {
      linkedParams.push(`%${q}%`);
      linkedWhere += ` AND (COALESCE(bis.supplier_item_name, bi.name) ILIKE $3 OR bis.supplier_item_code ILIKE $3 OR bi.code ILIKE $3)`;
    }
    const linked = await db.query<MergedCatalogItemRow>(
      `SELECT
          bis.id,
          bis.supplier_id,
          bis.workspace_owner_id,
          bi.id           AS base_item_id,
          bi.code         AS internal_item_code,
          bi.name         AS internal_item_name,
          bi.name         AS base_item_name,
          bis.supplier_item_code,
          COALESCE(bis.supplier_item_name, bi.name) AS name,
          NULL::text      AS category,
          COALESCE(uc.display_name, bis.pricing_uom) AS unit,
          NULL::text      AS package_size,
          bis.price::text AS price,
          bis.currency,
          '1'::text       AS min_order_quantity,
          NULL::text      AS par_level,
          NULL::text      AS current_stock,
          NULL::int       AS lead_time_days,
          TRUE            AS is_active,
          bis.is_preferred,
          'linked_base_item'::text AS source,
          bis.created_at,
          bis.created_at  AS updated_at
       FROM base_item_suppliers bis
       JOIN base_items bi ON bi.id = bis.base_item_id
       LEFT JOIN uom_catalog uc ON uc.code = bis.pricing_uom_code
       WHERE ${linkedWhere}
       ORDER BY name ASC`,
      linkedParams,
    );
    linkedRows = linked.rows;
  }

  // 2. Standalone catalog items (existing logic)
  const conditions: string[] = [
    `sci.supplier_id = $1`,
    `sci.workspace_owner_id = $2`,
  ];
  const params: unknown[] = [supplierId, wreq.workspaceOwnerId];
  let idx = 3;

  if (q) {
    conditions.push(`(sci.name ILIKE $${idx} OR sci.supplier_item_code ILIKE $${idx} OR sci.category ILIKE $${idx})`);
    params.push(`%${q}%`);
    idx++;
  }
  if (category) {
    conditions.push(`sci.category = $${idx}`);
    params.push(category);
    idx++;
  }
  if (activeOnly) {
    conditions.push(`sci.is_active = TRUE`);
  }
  if (lowStockOnly) {
    conditions.push(`sci.current_stock IS NOT NULL AND sci.par_level IS NOT NULL AND sci.current_stock < sci.par_level`);
  }

  const standaloneRows = await db.query<MergedCatalogItemRow>(
    `SELECT sci.*,
            bi.name AS base_item_name,
            FALSE   AS is_preferred,
            'standalone'::text AS source,
            NULL::text AS internal_item_code,
            bi.name    AS internal_item_name
     FROM supplier_catalog_items sci
     LEFT JOIN base_items bi ON bi.id = sci.base_item_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY sci.name ASC`,
    params,
  );

  res.json({ catalog_items: [...linkedRows, ...standaloneRows.rows] });
});

/**
 * POST /api/suppliers/:supplierId/catalog-items
 * Create a new catalog item for a supplier. Owner only.
 */
router.post("/suppliers/:supplierId/catalog-items", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "suppliers.edit")) {
    res.status(403).json({ error: "Insufficient permissions" });
    return;
  }

  const supplierId = parseInt(req.params.supplierId, 10);
  if (isNaN(supplierId)) {
    res.status(400).json({ error: "Invalid supplierId" });
    return;
  }

  const sup = await db.query<{ id: number }>(
    `SELECT id FROM suppliers WHERE id = $1 AND workspace_owner_id = $2 AND is_archived = FALSE`,
    [supplierId, wreq.workspaceOwnerId],
  );
  if (sup.rowCount === 0) {
    res.status(404).json({ error: "Supplier not found" });
    return;
  }

  const {
    name,
    supplier_item_code,
    category,
    unit,
    package_size,
    price,
    currency = "AED",
    min_order_quantity = "1",
    par_level,
    current_stock,
    lead_time_days,
    is_active = true,
    base_item_id,
    name_ar,
  } = req.body as Record<string, unknown>;

  if (!name || typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }

  const trimmedNameAr = name_ar != null && String(name_ar).trim() !== "" ? String(name_ar).trim() : null;
  const nameArSource = trimmedNameAr ? "manual" : null;

  const resolvedBaseItemId = base_item_id != null ? parseInt(String(base_item_id), 10) : null;
  if (resolvedBaseItemId != null) {
    if (isNaN(resolvedBaseItemId)) {
      res.status(400).json({ error: "base_item_id must be a valid number" });
      return;
    }
    const biCheck = await db.query<{ id: number }>(
      `SELECT id FROM base_items WHERE id = $1 AND workspace_owner_id = $2`,
      [resolvedBaseItemId, wreq.workspaceOwnerId],
    );
    if (biCheck.rowCount === 0) {
      res.status(404).json({ error: "base_item_id not found" });
      return;
    }
  }

  // Deduplication guard: check if a base_item_suppliers row already exists with the same supplier_item_code
  const trimmedCode = supplier_item_code ? String(supplier_item_code).trim() : null;
  if (trimmedCode) {
    const dupCheck = await db.query<{ id: number }>(
      `SELECT id FROM base_item_suppliers WHERE supplier_id = $1 AND workspace_owner_id = $2 AND supplier_item_code = $3`,
      [supplierId, wreq.workspaceOwnerId, trimmedCode],
    );
    if ((dupCheck.rowCount ?? 0) > 0) {
      res.status(409).json({
        error: "This item code is already linked to this supplier via a base item. Edit the existing linked item instead.",
      });
      return;
    }
  }

  const result = await db.query<SupplierCatalogItemRow>(
    `INSERT INTO supplier_catalog_items
      (workspace_owner_id, supplier_id, base_item_id, supplier_item_code, name, category, unit, package_size, price, currency, min_order_quantity, par_level, current_stock, lead_time_days, is_active, name_ar, name_ar_source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     RETURNING *`,
    [
      wreq.workspaceOwnerId,
      supplierId,
      resolvedBaseItemId,
      supplier_item_code ?? null,
      name.trim(),
      category ?? null,
      unit ?? null,
      package_size ?? null,
      price ?? null,
      currency,
      min_order_quantity,
      par_level ?? null,
      current_stock ?? null,
      lead_time_days ?? null,
      is_active,
      trimmedNameAr,
      nameArSource,
    ],
  );

  res.status(201).json({ catalog_item: result.rows[0] });
});

/**
 * GET /api/suppliers/:supplierId/catalog-items/:itemId
 * Get a single catalog item.
 */
router.get("/suppliers/:supplierId/catalog-items/:itemId", async (req, res) => {
  const wreq = workspace(req);
  const supplierId = parseInt(req.params.supplierId, 10);
  const itemId = parseInt(req.params.itemId, 10);
  if (isNaN(supplierId) || isNaN(itemId)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const result = await db.query<SupplierCatalogItemRow>(
    `SELECT sci.*, bi.name AS base_item_name
     FROM supplier_catalog_items sci
     LEFT JOIN base_items bi ON bi.id = sci.base_item_id
     WHERE sci.id = $1 AND sci.supplier_id = $2 AND sci.workspace_owner_id = $3`,
    [itemId, supplierId, wreq.workspaceOwnerId],
  );

  if (result.rowCount === 0) {
    res.status(404).json({ error: "Catalog item not found" });
    return;
  }

  res.json({ catalog_item: result.rows[0] });
});

/**
 * PATCH /api/suppliers/:supplierId/catalog-items/:itemId
 * Update a catalog item. Owner only.
 */
router.patch("/suppliers/:supplierId/catalog-items/:itemId", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "suppliers.edit")) {
    res.status(403).json({ error: "Insufficient permissions" });
    return;
  }

  const supplierId = parseInt(req.params.supplierId, 10);
  const itemId = parseInt(req.params.itemId, 10);
  if (isNaN(supplierId) || isNaN(itemId)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const existing = await db.query<SupplierCatalogItemRow>(
    `SELECT * FROM supplier_catalog_items WHERE id = $1 AND supplier_id = $2 AND workspace_owner_id = $3`,
    [itemId, supplierId, wreq.workspaceOwnerId],
  );
  if (existing.rowCount === 0) {
    res.status(404).json({ error: "Catalog item not found" });
    return;
  }

  const ALLOWED = [
    "name", "supplier_item_code", "category", "unit", "package_size",
    "price", "currency", "min_order_quantity", "par_level", "current_stock",
    "lead_time_days", "is_active", "base_item_id", "name_ar", "name_ar_source",
  ];

  const body = req.body as Record<string, unknown>;

  // Any client-supplied name_ar is a manual edit — mark the source accordingly
  // and never let a downstream auto-translate job silently overwrite it.
  if ("name_ar" in body) {
    const trimmed = body.name_ar != null && String(body.name_ar).trim() !== "" ? String(body.name_ar).trim() : null;
    body.name_ar = trimmed;
    body.name_ar_source = trimmed ? "manual" : null;
  }

  if ("base_item_id" in body && body.base_item_id != null) {
    const rawBid = parseInt(String(body.base_item_id), 10);
    if (isNaN(rawBid)) {
      res.status(400).json({ error: "base_item_id must be a valid number" });
      return;
    }
    const biCheck = await db.query<{ id: number }>(
      `SELECT id FROM base_items WHERE id = $1 AND workspace_owner_id = $2`,
      [rawBid, wreq.workspaceOwnerId],
    );
    if (biCheck.rowCount === 0) {
      res.status(404).json({ error: "base_item_id not found" });
      return;
    }
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  let pidx = 1;

  for (const key of ALLOWED) {
    if (key in body) {
      sets.push(`${key} = $${pidx}`);
      params.push(body[key] ?? null);
      pidx++;
    }
  }

  if (sets.length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }

  sets.push(`updated_at = NOW()`);
  params.push(itemId, supplierId, wreq.workspaceOwnerId);

  const result = await db.query<SupplierCatalogItemRow>(
    `UPDATE supplier_catalog_items SET ${sets.join(", ")}
     WHERE id = $${pidx} AND supplier_id = $${pidx + 1} AND workspace_owner_id = $${pidx + 2}
     RETURNING *`,
    params,
  );

  const updated = result.rows[0];
  const prev = existing.rows[0];
  const userId = authed(req).userId;

  // Insert stock log entries for changed stock fields
  const stockFields = ["current_stock", "par_level"] as const;
  for (const field of stockFields) {
    if (!(field in body)) continue;
    const oldRaw = prev[field];
    const newRaw = updated[field];
    const oldNum = oldRaw != null ? parseFloat(oldRaw) : null;
    const newNum = newRaw != null ? parseFloat(newRaw) : null;
    if (oldNum !== newNum) {
      await db.query(
        `INSERT INTO supplier_catalog_item_stock_log
           (catalog_item_id, workspace_owner_id, field, old_value, new_value, changed_by_clerk_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [itemId, wreq.workspaceOwnerId, field, oldRaw ?? null, newRaw ?? null, userId],
      );
    }
  }

  res.json({ catalog_item: updated });
});

/**
 * GET /api/suppliers/:supplierId/catalog-items/:itemId/stock-log
 * Return adjustment history for current_stock and par_level.
 */
router.get("/suppliers/:supplierId/catalog-items/:itemId/stock-log", async (req, res) => {
  const wreq = workspace(req);
  const supplierId = parseInt(req.params.supplierId, 10);
  const itemId = parseInt(req.params.itemId, 10);
  if (isNaN(supplierId) || isNaN(itemId)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const check = await db.query<{ id: number }>(
    `SELECT id FROM supplier_catalog_items WHERE id = $1 AND supplier_id = $2 AND workspace_owner_id = $3`,
    [itemId, supplierId, wreq.workspaceOwnerId],
  );
  if (check.rowCount === 0) {
    res.status(404).json({ error: "Catalog item not found" });
    return;
  }

  const rows = await db.query<{
    id: number;
    field: string;
    old_value: string | null;
    new_value: string | null;
    changed_by_clerk_id: string | null;
    created_at: string;
  }>(
    `SELECT id, field, old_value, new_value, changed_by_clerk_id, created_at
       FROM supplier_catalog_item_stock_log
      WHERE catalog_item_id = $1
      ORDER BY created_at DESC
      LIMIT 50`,
    [itemId],
  );

  const userIds = [...new Set(rows.rows.map((r) => r.changed_by_clerk_id).filter(Boolean) as string[])];
  const nameMap = await fetchClerkNames(userIds);

  const entries = rows.rows.map((r) => ({
    ...r,
    changed_by_name: formatName(nameMap.get(r.changed_by_clerk_id ?? "")) ?? null,
  }));

  res.json({ entries });
});

/**
 * DELETE /api/suppliers/:supplierId/catalog-items/:itemId
 * Delete a catalog item. Owner only.
 */
router.delete("/suppliers/:supplierId/catalog-items/:itemId", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "suppliers.edit")) {
    res.status(403).json({ error: "Insufficient permissions" });
    return;
  }

  const supplierId = parseInt(req.params.supplierId, 10);
  const itemId = parseInt(req.params.itemId, 10);
  if (isNaN(supplierId) || isNaN(itemId)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const existing = await db.query<SupplierCatalogItemRow>(
    `SELECT id FROM supplier_catalog_items WHERE id = $1 AND supplier_id = $2 AND workspace_owner_id = $3`,
    [itemId, supplierId, wreq.workspaceOwnerId],
  );
  if (existing.rowCount === 0) {
    res.status(404).json({ error: "Catalog item not found" });
    return;
  }

  await db.query(`DELETE FROM supplier_catalog_items WHERE id = $1`, [itemId]);

  res.json({ ok: true });
});

export default router;
