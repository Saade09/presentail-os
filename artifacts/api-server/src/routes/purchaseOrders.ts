import { Router } from "express";
import pg from "pg";
import { createHash, randomBytes } from "crypto";
import { clerkClient } from "@clerk/express";
import { db } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";
import { authed } from "../lib/auth";
import { sendPurchaseOrderEmail } from "../lib/email";
import { logger } from "../lib/logger";
import { translateToArabic } from "../lib/translation";
import { buildPurchaseOrderPdf, resolvePoPdfLineItemImages, resolveChromiumPath, type PoPdfLineItem } from "../lib/poPdf";
import { computeThreeWayMatch } from "../lib/purchaseOrderMatching";
import { postMovement } from "../lib/inventoryService";

async function fetchClerkNames(
  userIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (userIds.length === 0) return map;
  try {
    const clerkUsers = await clerkClient.users.getUserList({ userId: userIds, limit: 100 });
    for (const u of clerkUsers.data) {
      const name = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
      if (name) map.set(u.id, name);
    }
  } catch (err) {
    logger.warn({ err }, "Failed to batch-fetch Clerk profile names for PO activity");
  }
  return map;
}

const router = Router();
router.use("/purchase-orders", requireAuth, resolveWorkspace);

router.use("/purchase-orders", (req, res, next) => {
  if (req.method !== "GET" || hasPermission(workspace(req), "purchase-orders")) {
    next();
    return;
  }
  res.status(403).json({ error: "You do not have access to purchase orders" });
});

type PurchaseOrderRow = {
  id: number;
  workspace_owner_id: string;
  supplier_id: number;
  location_id: number | null;
  po_number: string | null;
  status: string;
  currency: string;
  total_amount: string | null;
  total_amount_manual_override: boolean;
  effective_total: string | null;
  calculated_total: string | null;
  expected_delivery_date: string | null;
  notes: string | null;
  created_by_clerk_id: string | null;
  updated_by_clerk_id: string | null;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
  supplier_name: string | null;
  supplier_is_archived: boolean | null;
  location_name: string | null;
  line_items_count: string;
  received_items_count: string;
  outstanding_units: string;
  // Cost summary fields
  subtotal_amount: string | null;
  discount_amount: string | null;
  delivery_fee_amount: string | null;
  vat_treatment: string | null;
  vat_rate: string | null;
  vat_amount: string | null;
  vat_manual_override: boolean;
  vat_override_reason: string | null;
  grand_total_amount: string | null;
  payment_terms: string | null;
  supplier_reference: string | null;
  attachment_urls: string | null;
  invoice_coverage_status: string | null;
  // Assignee & invoice tracking
  invoice_status: string;
  received_at: string | null;
  accepted_at: string | null;
  acceptance_invalidated_at: string | null;
};

/** Best-effort resolve a Clerk user's display name for "Created by" attribution. */
async function resolveClerkName(userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const names = await fetchClerkNames([userId]);
  return names.get(userId) ?? null;
}

function hasPermission(wreq: ReturnType<typeof workspace>, perm: string): boolean {
  return wreq.workspaceActualRole === "owner" || (wreq.allowedPages?.includes(perm) ?? false);
}

function poLabel(id: number): string {
  return `PO-${String(id).padStart(4, "0")}`;
}

/**
 * Map legacy DB status values to the new UI-facing status vocabulary.
 * Legacy `pending_approval`/`approved` are collapsed into `created`/`sent`.
 */
function mapPoStatus(dbStatus: string, sentAt: string | null): string {
  if (dbStatus === "pending_approval") return "created";
  if (dbStatus === "approved") return sentAt ? "sent" : "created";
  return dbStatus;
}

/** Compute a hash of the PO line items + grand total for acceptance invalidation detection. */
async function computePoVersionHash(poId: number, grandTotal: string | null): Promise<string> {
  const liResult = await db.query<{ id: number; quantity: string; unit_price: string }>(
    `SELECT id, quantity::text, unit_price::text FROM purchase_order_line_items WHERE purchase_order_id = $1 ORDER BY id ASC`,
    [poId],
  );
  const payload = JSON.stringify({ items: liResult.rows, grand_total: grandTotal ?? "" });
  return createHash("sha256").update(payload).digest("hex");
}

/** Invalidate all pending acceptance tokens for a PO when it changes materially. */
async function invalidatePendingAcceptances(poId: number, ownerId: string): Promise<void> {
  await db.query(
    `UPDATE purchase_order_acceptances
        SET invalidated_at = now()
      WHERE purchase_order_id = $1 AND workspace_owner_id = $2 AND status = 'pending' AND invalidated_at IS NULL`,
    [poId, ownerId],
  );
}

function calcTotalFromLineItems(totalAmount: string | null, lineItemsSum: number | null): string | null {
  if (totalAmount != null) return totalAmount;
  if (lineItemsSum != null && lineItemsSum > 0) return lineItemsSum.toFixed(4);
  return null;
}

/** Round to 2 decimal places (safe for monetary display). */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Compute VAT amount from subtotal, treatment, and rate.
 * - vat_exclusive: VAT = subtotal * rate/100 (added on top)
 * - vat_inclusive: VAT = subtotal - subtotal / (1 + rate/100) (already included)
 * - no_vat: VAT = 0
 */
export function computeVatAmount(subtotal: number, treatment: string, ratePct: number): number {
  if (treatment === "vat_exclusive") {
    return round2(subtotal * (ratePct / 100));
  }
  if (treatment === "vat_inclusive") {
    return round2(subtotal - subtotal / (1 + ratePct / 100));
  }
  return 0;
}

/**
 * Compute all cost summary fields from line items sum + inputs.
 * Returns { subtotal, vatAmount, grandTotal } all rounded to 2 dp.
 */
export function computeCostSummary(opts: {
  lineItemsSubtotal: number;
  discount: number;
  deliveryFee: number;
  vatTreatment: string;
  vatRate: number;
  vatManualOverride: boolean;
  vatAmountOverride: number | null;
}): { subtotal: number; vatAmount: number; grandTotal: number } {
  const subtotal = round2(opts.lineItemsSubtotal);
  const discount = round2(opts.discount);
  const deliveryFee = round2(opts.deliveryFee);

  const vatAmount = opts.vatManualOverride && opts.vatAmountOverride != null
    ? round2(opts.vatAmountOverride)
    : computeVatAmount(subtotal, opts.vatTreatment, opts.vatRate);

  const grandTotal = round2(subtotal - discount + deliveryFee + vatAmount);
  return { subtotal, vatAmount, grandTotal: Math.max(0, grandTotal) };
}

/**
 * GET /api/purchase-orders
 * List all purchase orders for the workspace.
 * Optional filters: supplier_id, location_id, search, status (comma-sep),
 *   assigned_user_id, delivery_from, delivery_to, sort, dir, summary, page, limit
 * When summary=1: returns counts only (no rows).
 */
router.get("/purchase-orders", async (req, res) => {
  const wreq = workspace(req);
  const supplierId = req.query.supplier_id ? parseInt(String(req.query.supplier_id), 10) : null;
  const locationId = req.query.location_id ? parseInt(String(req.query.location_id), 10) : null;
  const invoiceStatusFilter = req.query.invoice_status ? String(req.query.invoice_status) : null;
  const searchQ = req.query.search ? String(req.query.search).trim() : null;
  const statusFilter = req.query.status
    ? String(req.query.status).split(",").map((s) => s.trim()).filter(Boolean)
    : null;
  const assignedUserId = req.query.assigned_user_id ? String(req.query.assigned_user_id) : null;
  const deliveryFrom = req.query.delivery_from ? String(req.query.delivery_from) : null;
  const deliveryTo = req.query.delivery_to ? String(req.query.delivery_to) : null;
  const summaryMode = req.query.summary === "1" || req.query.summary === "true";
  const sortRaw = req.query.sort ? String(req.query.sort) : "created_at";
  const dirRaw = req.query.dir === "asc" ? "ASC" : "DESC";

  const PAGE_SIZE_DEFAULT = 20;
  const PAGE_SIZE_MAX = 100;
  const limit = Math.min(
    Math.max(1, req.query.limit ? parseInt(String(req.query.limit), 10) || PAGE_SIZE_DEFAULT : PAGE_SIZE_DEFAULT),
    PAGE_SIZE_MAX,
  );
  const page = req.query.page ? Math.max(1, parseInt(String(req.query.page), 10) || 1) : 1;
  const offset = (page - 1) * limit;

  const conditions: string[] = ["po.workspace_owner_id = $1"];
  const params: unknown[] = [wreq.workspaceOwnerId];

  if (supplierId != null && !isNaN(supplierId)) {
    params.push(supplierId);
    conditions.push(`po.supplier_id = $${params.length}`);
  }

  if (locationId != null && !isNaN(locationId)) {
    params.push(locationId);
    conditions.push(`po.location_id = $${params.length}`);
  }

  const VALID_INVOICE_STATUSES = ["awaiting_invoice", "partially_invoiced", "fully_invoiced", "matched", "difference_found"];
  if (invoiceStatusFilter && VALID_INVOICE_STATUSES.includes(invoiceStatusFilter)) {
    params.push(invoiceStatusFilter);
    conditions.push(`po.invoice_coverage_status = $${params.length}`);
  }

  if (searchQ) {
    params.push(`%${searchQ}%`);
    const pn = params.length;
    conditions.push(`(po.po_number ILIKE $${pn} OR s.name ILIKE $${pn})`);
  }

  if (statusFilter && statusFilter.length > 0) {
    params.push(statusFilter);
    conditions.push(`po.status = ANY($${params.length}::text[])`);
  }

  if (assignedUserId) {
    params.push(assignedUserId);
    conditions.push(
      `EXISTS (SELECT 1 FROM purchase_order_assignees poa2 WHERE poa2.purchase_order_id = po.id AND poa2.member_user_id = $${params.length})`,
    );
  }

  if (deliveryFrom) {
    params.push(deliveryFrom);
    conditions.push(`po.expected_delivery_date >= $${params.length}`);
  }

  if (deliveryTo) {
    params.push(deliveryTo);
    conditions.push(`po.expected_delivery_date <= $${params.length}`);
  }

  const whereClause = conditions.join(" AND ");
  const baseFrom = `
    FROM purchase_orders po
    LEFT JOIN suppliers s ON s.id = po.supplier_id AND s.workspace_owner_id = po.workspace_owner_id
    LEFT JOIN locations loc ON loc.id = po.location_id`;

  // ── Summary mode ──────────────────────────────────────────────────────────
  if (summaryMode) {
    const todayStr = new Date().toISOString().slice(0, 10);
    const weekLaterStr = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const summaryParams = [...params, todayStr, weekLaterStr];
    const tp = params.length;

    const [tabResult, summaryResult] = await Promise.all([
      db.query<{ status: string; sent_at: string | null; count: string }>(
        `SELECT po.status, (po.sent_at IS NOT NULL) AS sent_at, COUNT(*)::text AS count ${baseFrom} WHERE ${whereClause} GROUP BY po.status, (po.sent_at IS NOT NULL)`,
        params,
      ),
      db.query<{
        awaiting_approval: string;
        due_this_week: string;
        overdue: string;
        missing_invoices: string;
      }>(
        `SELECT
           COUNT(*) FILTER (WHERE po.status = 'sent' OR (po.status = 'approved' AND po.sent_at IS NOT NULL))::text AS awaiting_approval,
           COUNT(*) FILTER (
             WHERE po.expected_delivery_date IS NOT NULL
               AND po.expected_delivery_date::date >= $${tp + 1}::date
               AND po.expected_delivery_date::date <= $${tp + 2}::date
               AND po.status IN ('supplier_accepted','partial')
           )::text AS due_this_week,
           COUNT(*) FILTER (
             WHERE po.expected_delivery_date IS NOT NULL
               AND po.expected_delivery_date::date < $${tp + 1}::date
               AND po.status IN ('supplier_accepted','partial')
           )::text AS overdue,
           COUNT(*) FILTER (WHERE po.invoice_status = 'missing')::text AS missing_invoices
           ${baseFrom}
          WHERE ${whereClause}`,
        summaryParams,
      ),
    ]);

    const tabCounts: Record<string, number> = {
      all: 0, created: 0, sent: 0, supplier_accepted: 0, partial: 0, received: 0, completed: 0, cancelled: 0,
    };
    for (const row of tabResult.rows) {
      const count = parseInt(row.count, 10);
      // Map legacy DB statuses to current lifecycle vocabulary via mapPoStatus semantics
      let key = row.status;
      if (row.status === "pending_approval") key = "created";
      else if (row.status === "approved") key = row.sent_at ? "sent" : "created";
      if (key in tabCounts) tabCounts[key] = (tabCounts[key] ?? 0) + count;
      tabCounts.all += count;
    }
    const sr = summaryResult.rows[0] ?? {};
    res.json({
      summary: {
        awaiting_approval: parseInt(sr.awaiting_approval ?? "0", 10),
        due_this_week: parseInt(sr.due_this_week ?? "0", 10),
        overdue: parseInt(sr.overdue ?? "0", 10),
        missing_invoices: parseInt(sr.missing_invoices ?? "0", 10),
      },
      tab_counts: tabCounts,
    });
    return;
  }

  // ── Sort clause ───────────────────────────────────────────────────────────
  const ALLOWED_SORTS: Record<string, string> = {
    po_number: "po.id",
    created_at: "po.created_at",
    updated_at: "po.updated_at",
    expected_delivery: "po.expected_delivery_date",
    amount: "COALESCE(po.grand_total_amount, po.total_amount)::numeric",
    status: "po.status",
  };
  const sortCol = ALLOWED_SORTS[sortRaw] ?? "po.created_at";
  const orderClause = `${sortCol} ${dirRaw} NULLS LAST`;

  // Count total matching rows (ignoring pagination)
  const countResult = await db.query<{ count: string }>(
    `SELECT COUNT(*) AS count ${baseFrom} WHERE ${whereClause}`,
    params,
  );
  const total = parseInt(countResult.rows[0]?.count ?? "0", 10);

  // Paginated fetch with assignees subquery
  type ListRow = PurchaseOrderRow & { assignees_json: unknown };
  const result = await db.query<ListRow>(
    `SELECT po.*,
            s.name AS supplier_name,
            s.is_archived AS supplier_is_archived,
            loc.name AS location_name,
            COALESCE(po.total_amount::text, (SELECT SUM(l.quantity::numeric * l.unit_price::numeric) FROM purchase_order_line_items l WHERE l.purchase_order_id = po.id)::text) AS effective_total,
            (SELECT SUM(l.quantity::numeric * l.unit_price::numeric) FROM purchase_order_line_items l WHERE l.purchase_order_id = po.id)::text AS calculated_total,
            (SELECT COUNT(*) FROM purchase_order_line_items l WHERE l.purchase_order_id = po.id)::text AS line_items_count,
            (SELECT COUNT(*) FROM purchase_order_line_items l WHERE l.purchase_order_id = po.id AND l.received_quantity IS NOT NULL AND l.received_quantity::numeric >= l.quantity::numeric)::text AS received_items_count,
            (SELECT COALESCE(SUM(GREATEST(0, l.quantity::numeric - COALESCE(l.received_quantity::numeric, 0))), 0) FROM purchase_order_line_items l WHERE l.purchase_order_id = po.id)::text AS outstanding_units,
            COALESCE(
              (SELECT json_agg(json_build_object(
                'member_user_id', poa.member_user_id,
                'email', wm.member_email
              ) ORDER BY poa.assigned_at)
               FROM purchase_order_assignees poa
               LEFT JOIN workspace_members wm
                 ON wm.member_user_id = poa.member_user_id
                AND wm.workspace_owner_id = po.workspace_owner_id
               WHERE poa.purchase_order_id = po.id),
              '[]'::json
            ) AS assignees_json
       ${baseFrom}
      WHERE ${whereClause}
      ORDER BY ${orderClause}
      LIMIT ${limit} OFFSET ${offset}`,
    params,
  );

  // Batch-fetch Clerk names for all unique assignee user IDs across result rows
  const allMemberIds = new Set<string>();
  for (const r of result.rows) {
    const raw = r.assignees_json;
    const arr: { member_user_id?: string }[] = Array.isArray(raw) ? raw : [];
    for (const a of arr) {
      if (a.member_user_id) allMemberIds.add(a.member_user_id);
    }
  }
  const nameMap = allMemberIds.size > 0 ? await fetchClerkNames([...allMemberIds]) : new Map<string, string>();

  const rows = result.rows.map((r) => {
    const raw = r.assignees_json;
    const assigneesRaw: { member_user_id: string; email: string | null }[] = Array.isArray(raw) ? raw : [];
    const assignees = assigneesRaw.map((a) => ({
      member_user_id: a.member_user_id,
      name: nameMap.get(a.member_user_id) ?? a.email ?? a.member_user_id,
      email: a.email ?? null,
    }));
    return {
      ...r,
      po_number_label: r.po_number ?? poLabel(r.id),
      status: mapPoStatus(r.status, r.sent_at),
      line_items_count: parseInt(r.line_items_count, 10),
      received_items_count: parseInt(r.received_items_count, 10),
      outstanding_units: parseFloat(r.outstanding_units),
      assignees,
    };
  });

  res.json({ purchase_orders: rows, total, page, limit });
});

/**
 * POST /api/purchase-orders
 * Create a purchase order. Owner only.
 * Optionally accepts `line_items` array to create line items atomically.
 */
router.post("/purchase-orders", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "suppliers.edit")) {
    res.status(403).json({ error: "Insufficient permissions to create purchase orders" });
    return;
  }

  const {
    supplier_id,
    location_id: location_id_raw,
    po_number,
    status,
    currency,
    total_amount,
    total_amount_manual_override,
    expected_delivery_date,
    notes,
    line_items,
    discount_amount: discount_amount_raw,
    delivery_fee_amount: delivery_fee_amount_raw,
    vat_treatment: vat_treatment_raw,
    vat_rate: vat_rate_raw,
    vat_amount: vat_amount_raw,
    vat_manual_override: vat_manual_override_raw,
    vat_override_reason: vat_override_reason_raw,
    payment_terms: payment_terms_raw,
    supplier_reference: supplier_reference_raw,
    attachment_urls: attachment_urls_raw,
  } = req.body ?? {};

  const supplierId = parseInt(String(supplier_id ?? ""), 10);
  if (isNaN(supplierId)) {
    res.status(400).json({ error: "supplier_id is required" });
    return;
  }

  if (location_id_raw == null) {
    res.status(400).json({ error: "location_id is required" });
    return;
  }
  const locationIdCreate = parseInt(String(location_id_raw), 10);
  if (isNaN(locationIdCreate)) {
    res.status(400).json({ error: "location_id must be a valid integer" });
    return;
  }

  const check = await db.query(
    `SELECT id FROM suppliers WHERE id = $1 AND workspace_owner_id = $2`,
    [supplierId, wreq.workspaceOwnerId],
  );
  if (check.rowCount === 0) {
    res.status(404).json({ error: "Supplier not found" });
    return;
  }

  const locationCheck = await db.query(
    `SELECT id FROM locations WHERE id = $1 AND workspace_owner_id = $2`,
    [locationIdCreate, wreq.workspaceOwnerId],
  );
  if (locationCheck.rowCount === 0) {
    res.status(404).json({ error: "Location not found" });
    return;
  }

  type LineItemInput = {
    description?: string;
    description_ar?: string | null;
    quantity: string;
    unit_price: string;
    currency?: string;
    base_item_id?: number | null;
    supplier_catalog_item_id?: number | null;
    base_item_supplier_id?: number | null;
  };

  const rawItems: LineItemInput[] = Array.isArray(line_items) ? line_items : [];

  for (let i = 0; i < rawItems.length; i++) {
    const item = rawItems[i];
    // Description is required unless a base_item_supplier_id is supplied — in that
    // case the BIS lookup below will derive the description from the supplier link.
    if ((!item.description || String(item.description).trim() === "") && item.base_item_supplier_id == null) {
      res.status(400).json({ error: `line_items[${i}].description is required` });
      return;
    }
    const qtyCheck = validatePositiveNumber(item.quantity, `line_items[${i}].quantity`);
    if (!qtyCheck.valid) { res.status(400).json({ error: qtyCheck.error }); return; }
    // unit_price is required unless base_item_supplier_id is supplied — in that
    // case the BIS lookup below will source the price from the supplier link.
    if (item.base_item_supplier_id == null) {
      const priceCheck = validatePositiveNumber(item.unit_price, `line_items[${i}].unit_price`);
      if (!priceCheck.valid) { res.status(400).json({ error: priceCheck.error }); return; }
    }
    if (item.base_item_supplier_id != null) {
      const bisId = parseInt(String(item.base_item_supplier_id), 10);
      if (isNaN(bisId)) {
        res.status(400).json({ error: `line_items[${i}].base_item_supplier_id must be a valid number` });
        return;
      }
      const bisPreCheck = await db.query(
        `SELECT id FROM base_item_suppliers WHERE id = $1 AND supplier_id = $2 AND workspace_owner_id = $3`,
        [bisId, supplierId, wreq.workspaceOwnerId],
      );
      if (bisPreCheck.rowCount === 0) {
        res.status(404).json({ error: `line_items[${i}].base_item_supplier_id not found for this supplier` });
        return;
      }
    }
    if (item.supplier_catalog_item_id != null) {
      const scid = parseInt(String(item.supplier_catalog_item_id), 10);
      if (isNaN(scid)) {
        res.status(400).json({ error: `line_items[${i}].supplier_catalog_item_id must be a valid number` });
        return;
      }
      const scidCheck = await db.query(
        `SELECT id FROM supplier_catalog_items WHERE id = $1 AND supplier_id = $2 AND workspace_owner_id = $3`,
        [scid, supplierId, wreq.workspaceOwnerId],
      );
      if (scidCheck.rowCount === 0) {
        res.status(404).json({ error: `line_items[${i}].supplier_catalog_item_id not found for this supplier` });
        return;
      }
    }
  }

  // Parse and validate cost summary fields
  const vatTreatmentCreate = vat_treatment_raw ? String(vat_treatment_raw) : "no_vat";
  if (!["no_vat", "vat_exclusive", "vat_inclusive"].includes(vatTreatmentCreate)) {
    res.status(400).json({ error: "vat_treatment must be one of: no_vat, vat_exclusive, vat_inclusive" });
    return;
  }
  const vatRateCreate = vat_rate_raw != null ? parseFloat(String(vat_rate_raw)) : 0;
  if (vatTreatmentCreate !== "no_vat" && (isNaN(vatRateCreate) || vatRateCreate < 0 || vatRateCreate > 100)) {
    res.status(400).json({ error: "vat_rate is required and must be between 0 and 100 when VAT treatment is not no_vat" });
    return;
  }
  const vatManualOverrideCreate = vat_manual_override_raw === true || vat_manual_override_raw === "true";
  if (vatManualOverrideCreate && !vat_override_reason_raw) {
    res.status(400).json({ error: "vat_override_reason is required when vat_manual_override is true" });
    return;
  }
  const vatAmountOverrideCreate = vatManualOverrideCreate && vat_amount_raw != null ? parseFloat(String(vat_amount_raw)) : null;

  const discountRawNum = discount_amount_raw != null ? parseFloat(String(discount_amount_raw)) : 0;
  if (discount_amount_raw != null && isNaN(discountRawNum)) {
    res.status(400).json({ error: "discount_amount must be a valid non-negative number" });
    return;
  }
  const discountCreate = Math.max(0, discountRawNum);

  const deliveryFeeRawNum = delivery_fee_amount_raw != null ? parseFloat(String(delivery_fee_amount_raw)) : 0;
  if (delivery_fee_amount_raw != null && isNaN(deliveryFeeRawNum)) {
    res.status(400).json({ error: "delivery_fee_amount must be a valid non-negative number" });
    return;
  }
  const deliveryFeeCreate = Math.max(0, deliveryFeeRawNum);

  const userId = authed(req).userId;
  const client = await db.connect();

  try {
    await client.query("BEGIN");

    const manualOverride = total_amount_manual_override === true || total_amount_manual_override === "true";

    const insertResult = await client.query<PurchaseOrderRow>(
      `INSERT INTO purchase_orders (
         workspace_owner_id, supplier_id, location_id, po_number, status, currency,
         total_amount, total_amount_manual_override, expected_delivery_date, notes,
         discount_amount, delivery_fee_amount, vat_treatment, vat_rate,
         vat_manual_override, vat_override_reason,
         payment_terms, supplier_reference, attachment_urls,
         created_by_clerk_id, updated_by_clerk_id, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $20, now())
       RETURNING *,
         (SELECT name FROM suppliers WHERE id = $2 AND workspace_owner_id = $1) AS supplier_name,
         (SELECT name FROM locations WHERE id = $3) AS location_name,
         NULL::text AS effective_total,
         NULL::text AS calculated_total`,
      [
        wreq.workspaceOwnerId,
        supplierId,
        locationIdCreate ?? null,
        po_number ? String(po_number).trim() || null : null,
        // New POs start in "created" status. They can be sent to the supplier
        // directly from this state. The old "pending_approval"/"approved"
        // workflow is removed. Client-provided status is intentionally
        // ignored here to keep the state machine enforced server-side.
        "created",
        currency ? String(currency) : "AED",
        total_amount != null ? String(total_amount) : null,
        manualOverride,
        expected_delivery_date || null,
        notes ? String(notes).trim() || null : null,
        discountCreate > 0 ? String(discountCreate) : null,
        deliveryFeeCreate > 0 ? String(deliveryFeeCreate) : null,
        vatTreatmentCreate,
        vatRateCreate > 0 ? String(vatRateCreate) : null,
        vatManualOverrideCreate,
        vat_override_reason_raw ? String(vat_override_reason_raw).trim() || null : null,
        payment_terms_raw ? String(payment_terms_raw).trim() || null : null,
        supplier_reference_raw ? String(supplier_reference_raw).trim() || null : null,
        attachment_urls_raw != null ? (Array.isArray(attachment_urls_raw) ? JSON.stringify(attachment_urls_raw) : String(attachment_urls_raw)) : null,
        userId,
      ],
    );

    const row = insertResult.rows[0];
    const poId = row.id;
    const poCurrency = row.currency;

    for (const item of rawItems) {
      const baseItemId = item.base_item_id != null ? parseInt(String(item.base_item_id), 10) : null;
      const supplierCatalogItemId = item.supplier_catalog_item_id != null ? parseInt(String(item.supplier_catalog_item_id), 10) : null;
      const baseItemSupplierId = item.base_item_supplier_id != null ? parseInt(String(item.base_item_supplier_id), 10) : null;

      let resolvedDescription = String(item.description ?? "").trim() || "Item";
      let resolvedDescriptionAr: string | null = item.description_ar ? String(item.description_ar).trim() || null : null;
      let resolvedUnitPrice = String(item.unit_price);
      let resolvedCurrency = item.currency ? String(item.currency) : poCurrency;
      let resolvedBaseItemId = baseItemId ?? null;
      let resolvedBaseItemSupplierId: number | null = baseItemSupplierId;

      // BIS source path — takes priority over supplier_catalog_item_id
      let resolvedPackageQuantity: string | null = null;
      if (baseItemSupplierId != null) {
        // Scope lookup to this PO's supplier and workspace to prevent cross-workspace data access
        const bis = await client.query<{ base_item_id: number; supplier_item_name: string | null; name_ar: string | null; price: string | null; currency: string; package_quantity: string | null }>(
          `SELECT bis.base_item_id, bis.supplier_item_name, bis.name_ar, bis.price, bis.currency,
                  bip.quantity::text AS package_quantity
             FROM base_item_suppliers bis
             LEFT JOIN base_item_packages bip ON bip.id = bis.package_id
            WHERE bis.id = $1 AND bis.workspace_owner_id = $2 AND bis.supplier_id = $3`,
          [baseItemSupplierId, row.workspace_owner_id, row.supplier_id],
        );
        if (bis.rowCount! > 0) {
          const bisRow = bis.rows[0];
          if (bisRow.supplier_item_name) resolvedDescription = bisRow.supplier_item_name;
          if (!resolvedDescriptionAr && bisRow.name_ar) resolvedDescriptionAr = bisRow.name_ar;
          if (bisRow.price != null) resolvedUnitPrice = bisRow.price;
          resolvedCurrency = bisRow.currency || poCurrency;
          if (resolvedBaseItemId == null) resolvedBaseItemId = bisRow.base_item_id;
          // Snapshot the package conversion factor so receiving is unaffected by
          // later BIS/package edits or link removals.
          if (bisRow.package_quantity != null) resolvedPackageQuantity = bisRow.package_quantity;
        }
        resolvedBaseItemSupplierId = baseItemSupplierId;
      } else if (supplierCatalogItemId != null) {
        const sci = await client.query<{ name: string; name_ar: string | null; price: string | null; currency: string; base_item_id: number | null }>(
          `SELECT name, name_ar, price, currency, base_item_id FROM supplier_catalog_items WHERE id = $1`,
          [supplierCatalogItemId],
        );
        if (sci.rowCount! > 0) {
          const sciRow = sci.rows[0];
          resolvedDescription = sciRow.name;
          if (!resolvedDescriptionAr && sciRow.name_ar) resolvedDescriptionAr = sciRow.name_ar;
          if (sciRow.price != null) resolvedUnitPrice = sciRow.price;
          resolvedCurrency = sciRow.currency || poCurrency;
          if (resolvedBaseItemId == null && sciRow.base_item_id != null) resolvedBaseItemId = sciRow.base_item_id;
        }
      }

      // Fetch base_item name for description fallback if still empty
      if (resolvedDescription === "Item" && resolvedBaseItemId != null) {
        const bi = await client.query<{ name: string }>(
          `SELECT name FROM base_items WHERE id = $1`,
          [resolvedBaseItemId],
        );
        if ((bi.rowCount ?? 0) > 0) resolvedDescription = bi.rows[0].name;
      }

      await client.query(
        `INSERT INTO purchase_order_line_items
           (purchase_order_id, base_item_id, supplier_catalog_item_id, base_item_supplier_id,
            description, description_ar, quantity, unit_price, currency, package_quantity)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          poId,
          resolvedBaseItemId,
          baseItemSupplierId != null ? null : (supplierCatalogItemId ?? null),
          resolvedBaseItemSupplierId,
          resolvedDescription,
          resolvedDescriptionAr,
          String(item.quantity),
          resolvedUnitPrice,
          resolvedCurrency,
          resolvedPackageQuantity,
        ],
      );
    }

    // Compute cost summary from resolved line items
    const lineItemsSubtotalResult = await client.query<{ subtotal: string }>(
      `SELECT COALESCE(SUM(quantity::numeric * unit_price::numeric), 0)::text AS subtotal
         FROM purchase_order_line_items WHERE purchase_order_id = $1`,
      [poId],
    );
    const lineItemsSubtotal = parseFloat(lineItemsSubtotalResult.rows[0]?.subtotal ?? "0") || 0;

    const { subtotal: computedSubtotal, vatAmount: computedVatAmount, grandTotal: computedGrandTotal } = computeCostSummary({
      lineItemsSubtotal,
      discount: discountCreate,
      deliveryFee: deliveryFeeCreate,
      vatTreatment: vatTreatmentCreate,
      vatRate: vatRateCreate,
      vatManualOverride: vatManualOverrideCreate,
      vatAmountOverride: vatAmountOverrideCreate,
    });

    await client.query(
      `UPDATE purchase_orders
         SET subtotal_amount = $1, vat_amount = $2, grand_total_amount = $3
       WHERE id = $4`,
      [computedSubtotal.toFixed(2), computedVatAmount.toFixed(2), computedGrandTotal.toFixed(2), poId],
    );

    await client.query(
      `INSERT INTO purchase_order_activity
         (purchase_order_id, workspace_owner_id, event_type, description, metadata)
       VALUES ($1, $2, 'po_created', $3, $4)`,
      [
        poId,
        wreq.workspaceOwnerId,
        `Purchase order created with ${rawItems.length} line item${rawItems.length === 1 ? "" : "s"}.`,
        JSON.stringify({
          created_by: userId,
          supplier_id: supplierId,
          location_id: locationIdCreate,
          status: row.status,
          currency: poCurrency,
          line_items_count: rawItems.length,
        }),
      ],
    );

    await client.query("COMMIT");

    // Auto-populate assignees from supplier defaults (best-effort, outside tx)
    try {
      const defaultAssigneesResult = await db.query<{ member_user_id: string }>(
        `SELECT member_user_id FROM supplier_default_assignees WHERE supplier_id = $1 AND workspace_owner_id = $2`,
        [supplierId, wreq.workspaceOwnerId],
      );
      if ((defaultAssigneesResult.rowCount ?? 0) > 0) {
        for (const da of defaultAssigneesResult.rows) {
          await db.query(
            `INSERT INTO purchase_order_assignees (purchase_order_id, member_user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [poId, da.member_user_id],
          );
        }
      }
    } catch (err) {
      logger.warn({ err, poId }, "Failed to auto-populate assignees from supplier defaults");
    }

    res.status(201).json({
      purchase_order: {
        ...row,
        subtotal_amount: computedSubtotal.toFixed(2),
        vat_amount: computedVatAmount.toFixed(2),
        grand_total_amount: computedGrandTotal.toFixed(2),
        po_number_label: row.po_number ?? poLabel(row.id),
        line_items_count: rawItems.length,
        received_items_count: 0,
        outstanding_units: rawItems.reduce((sum, item) => sum + parseFloat(String(item.quantity) || "0"), 0),
      },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

/**
 * GET /api/purchase-orders/:id
 * Get a single purchase order.
 */
router.get("/purchase-orders/:id", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid purchase order id" });
    return;
  }

  const result = await db.query<PurchaseOrderRow>(
    `SELECT po.*,
            s.name AS supplier_name,
            s.is_archived AS supplier_is_archived,
            loc.name AS location_name,
            COALESCE(po.total_amount::text, (SELECT SUM(l.quantity::numeric * l.unit_price::numeric) FROM purchase_order_line_items l WHERE l.purchase_order_id = po.id)::text) AS effective_total,
            (SELECT SUM(l.quantity::numeric * l.unit_price::numeric) FROM purchase_order_line_items l WHERE l.purchase_order_id = po.id)::text AS calculated_total,
            (SELECT COUNT(*) FROM purchase_order_line_items l WHERE l.purchase_order_id = po.id)::text AS line_items_count,
            (SELECT COUNT(*) FROM purchase_order_line_items l WHERE l.purchase_order_id = po.id AND l.received_quantity IS NOT NULL AND l.received_quantity::numeric >= l.quantity::numeric)::text AS received_items_count,
            (SELECT COALESCE(SUM(GREATEST(0, l.quantity::numeric - COALESCE(l.received_quantity::numeric, 0))), 0) FROM purchase_order_line_items l WHERE l.purchase_order_id = po.id)::text AS outstanding_units
       FROM purchase_orders po
       LEFT JOIN suppliers s ON s.id = po.supplier_id AND s.workspace_owner_id = po.workspace_owner_id
       LEFT JOIN locations loc ON loc.id = po.location_id
      WHERE po.id = $1 AND po.workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );

  if (result.rowCount === 0) {
    res.status(404).json({ error: "Purchase order not found" });
    return;
  }

  const row = result.rows[0];
  const [createdByName, acceptanceResult] = await Promise.all([
    resolveClerkName(row.created_by_clerk_id),
    db.query<{ token: string; status: string; responded_at: string | null; invalidated_at: string | null }>(
      `SELECT token, status, responded_at, invalidated_at
         FROM purchase_order_acceptances
        WHERE purchase_order_id = $1 AND workspace_owner_id = $2
        ORDER BY created_at DESC LIMIT 1`,
      [row.id, wreq.workspaceOwnerId],
    ),
  ]);

  const latestAcceptance = acceptanceResult.rows[0] ?? null;

  const outstandingUnits = parseFloat(row.outstanding_units);
  const mappedStatus = mapPoStatus(row.status, row.sent_at);
  const isOverdue =
    (mappedStatus === "supplier_accepted" || mappedStatus === "partial") &&
    !!row.expected_delivery_date &&
    new Date(row.expected_delivery_date) < new Date() &&
    outstandingUnits > 0;

  res.json({
    purchase_order: {
      ...row,
      status: mappedStatus,
      po_number_label: row.po_number ?? poLabel(row.id),
      supplier_is_archived: row.supplier_is_archived ?? null,
      line_items_count: parseInt(row.line_items_count, 10),
      received_items_count: parseInt(row.received_items_count, 10),
      outstanding_units: outstandingUnits,
      created_by_name: createdByName,
      is_overdue: isOverdue,
      acceptance_token: latestAcceptance?.invalidated_at == null && latestAcceptance?.status === "pending"
        ? latestAcceptance.token
        : null,
      acceptance_status: latestAcceptance?.status ?? null,
      acceptance_responded_at: latestAcceptance?.responded_at ?? null,
    },
  });
});

/**
 * PATCH /api/purchase-orders/:id
 * Update a purchase order. Owner only.
 */
router.patch("/purchase-orders/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "suppliers.edit")) {
    res.status(403).json({ error: "Insufficient permissions to update purchase orders" });
    return;
  }

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid purchase order id" });
    return;
  }

  const existing = await db.query<PurchaseOrderRow>(
    `SELECT * FROM purchase_orders WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (existing.rowCount === 0) {
    res.status(404).json({ error: "Purchase order not found" });
    return;
  }

  const prev = existing.rows[0];
  const body = req.body ?? {};
  const userId = authed(req).userId;

  const poNumber = "po_number" in body
    ? (body.po_number ? String(body.po_number).trim() || null : null)
    : prev.po_number;
  const status = "status" in body ? String(body.status) : prev.status;

  // Block setting obsolete status values that no longer exist in the new workflow.
  if ("status" in body && (status === "pending_approval" || status === "approved")) {
    res.status(409).json({ error: "Status values 'pending_approval' and 'approved' are no longer used. Use 'created' or 'sent' instead." });
    return;
  }

  // supplier_accepted can only be set via the acceptance endpoint or manually via
  // POST /purchase-orders/:id/acceptance/manual; direct status PATCH is blocked.
  if ("status" in body && status === "supplier_accepted" && prev.status !== "supplier_accepted") {
    res.status(409).json({ error: "Use the acceptance endpoint to mark a PO as supplier-accepted." });
    return;
  }

  const currency = "currency" in body ? String(body.currency) : prev.currency;
  const totalAmount = "total_amount" in body
    ? (body.total_amount != null ? String(body.total_amount) : null)
    : prev.total_amount;
  const manualOverride = "total_amount_manual_override" in body
    ? (body.total_amount_manual_override === true || body.total_amount_manual_override === "true")
    : prev.total_amount_manual_override;
  const expectedDeliveryDate = "expected_delivery_date" in body
    ? (body.expected_delivery_date || null)
    : prev.expected_delivery_date;
  const notes = "notes" in body
    ? (body.notes ? String(body.notes).trim() || null : null)
    : prev.notes;

  // Cost summary fields
  const vatTreatmentUpdate = "vat_treatment" in body ? String(body.vat_treatment || "no_vat") : (prev.vat_treatment ?? "no_vat");
  if (!["no_vat", "vat_exclusive", "vat_inclusive"].includes(vatTreatmentUpdate)) {
    res.status(400).json({ error: "vat_treatment must be one of: no_vat, vat_exclusive, vat_inclusive" });
    return;
  }
  const vatRateUpdate = "vat_rate" in body
    ? (body.vat_rate != null ? parseFloat(String(body.vat_rate)) : 0)
    : parseFloat(prev.vat_rate ?? "0") || 0;
  if (vatTreatmentUpdate !== "no_vat" && (isNaN(vatRateUpdate) || vatRateUpdate < 0 || vatRateUpdate > 100)) {
    res.status(400).json({ error: "vat_rate must be between 0 and 100 when VAT treatment is not no_vat" });
    return;
  }
  const vatManualOverrideUpdate = "vat_manual_override" in body
    ? (body.vat_manual_override === true || body.vat_manual_override === "true")
    : prev.vat_manual_override;
  const vatOverrideReasonUpdate = "vat_override_reason" in body
    ? (body.vat_override_reason ? String(body.vat_override_reason).trim() || null : null)
    : prev.vat_override_reason;
  if (vatManualOverrideUpdate && !vatOverrideReasonUpdate) {
    res.status(400).json({ error: "vat_override_reason is required when vat_manual_override is true" });
    return;
  }
  const vatAmountOverrideUpdate = vatManualOverrideUpdate && "vat_amount" in body && body.vat_amount != null
    ? parseFloat(String(body.vat_amount))
    : (vatManualOverrideUpdate && prev.vat_amount != null ? parseFloat(prev.vat_amount) : null);

  const discountUpdateRaw = "discount_amount" in body && body.discount_amount != null
    ? parseFloat(String(body.discount_amount))
    : parseFloat(prev.discount_amount ?? "0");
  if ("discount_amount" in body && body.discount_amount != null && isNaN(discountUpdateRaw)) {
    res.status(400).json({ error: "discount_amount must be a valid non-negative number" });
    return;
  }
  const discountUpdate = Math.max(0, isNaN(discountUpdateRaw) ? 0 : discountUpdateRaw);

  const deliveryFeeUpdateRaw = "delivery_fee_amount" in body && body.delivery_fee_amount != null
    ? parseFloat(String(body.delivery_fee_amount))
    : parseFloat(prev.delivery_fee_amount ?? "0");
  if ("delivery_fee_amount" in body && body.delivery_fee_amount != null && isNaN(deliveryFeeUpdateRaw)) {
    res.status(400).json({ error: "delivery_fee_amount must be a valid non-negative number" });
    return;
  }
  const deliveryFeeUpdate = Math.max(0, isNaN(deliveryFeeUpdateRaw) ? 0 : deliveryFeeUpdateRaw);

  const paymentTermsUpdate = "payment_terms" in body
    ? (body.payment_terms ? String(body.payment_terms).trim() || null : null)
    : prev.payment_terms;
  const supplierReferenceUpdate = "supplier_reference" in body
    ? (body.supplier_reference ? String(body.supplier_reference).trim() || null : null)
    : prev.supplier_reference;
  const attachmentUrlsUpdate = "attachment_urls" in body
    ? (body.attachment_urls != null ? (Array.isArray(body.attachment_urls) ? JSON.stringify(body.attachment_urls) : String(body.attachment_urls)) : null)
    : prev.attachment_urls;

  let locationIdUpdate: number | null = prev.location_id;
  if ("location_id" in body) {
    if (body.location_id == null) {
      locationIdUpdate = null;
    } else {
      const parsed = parseInt(String(body.location_id), 10);
      if (isNaN(parsed)) {
        res.status(400).json({ error: "location_id must be a valid integer" });
        return;
      }
      const locationCheck = await db.query(
        `SELECT id FROM locations WHERE id = $1 AND workspace_owner_id = $2`,
        [parsed, wreq.workspaceOwnerId],
      );
      if (locationCheck.rowCount === 0) {
        res.status(404).json({ error: "Location not found" });
        return;
      }
      locationIdUpdate = parsed;
    }
  }

  // When location_id changed, re-resolve tax for every line item that has a
  // meaningful tax_category (i.e. base_item_id set and tax_category not null /
  // not "not_classified").  Items without a base_item_id or with
  // tax_category = "not_classified" are left untouched.
  const locationChanged = "location_id" in body && locationIdUpdate !== prev.location_id;
  if (locationChanged) {
    const itemsToRetax = await db.query<{
      id: number;
      quantity: string;
      unit_price: string;
      tax_category: string;
    }>(
      `SELECT id, quantity, unit_price, tax_category
         FROM purchase_order_line_items
        WHERE purchase_order_id = $1
          AND base_item_id IS NOT NULL
          AND tax_category IS NOT NULL
          AND tax_category != 'not_classified'
          AND tax_override = false`,
      [id],
    );

    for (const li of itemsToRetax.rows) {
      let newAppliedTaxRate: string | null = null;
      let newTaxableAmount: string | null = null;
      let newTaxAmount: string | null = null;

      if (locationIdUpdate != null) {
        const taxResult = await db.query<{ rate_percent: string }>(
          `SELECT rate_percent FROM tax_rules
           WHERE workspace_owner_id = $1
             AND tax_category = $2
             AND is_active = true
             AND effective_from <= CURRENT_DATE
             AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
             AND (
               location_id = $3
               OR (location_id IS NULL AND country_code = (
                 SELECT country FROM locations WHERE id = $3
               ))
             )
           ORDER BY location_id NULLS LAST, effective_from DESC
           LIMIT 1`,
          [wreq.workspaceOwnerId, li.tax_category, locationIdUpdate],
        );

        if ((taxResult.rowCount ?? 0) > 0) {
          const rate = parseFloat(taxResult.rows[0].rate_percent);
          const netAmt = parseFloat(li.quantity) * parseFloat(li.unit_price);
          newAppliedTaxRate = taxResult.rows[0].rate_percent;
          newTaxableAmount = netAmt.toFixed(2);
          newTaxAmount = (netAmt * rate / 100).toFixed(2);
        }
      }

      await db.query(
        `UPDATE purchase_order_line_items
            SET applied_tax_rate = $1, taxable_amount = $2, tax_amount = $3
          WHERE id = $4`,
        [newAppliedTaxRate, newTaxableAmount, newTaxAmount, li.id],
      );
    }
  }

  // Re-compute cost summary from current DB line items
  const lineItemsSubtotalResult = await db.query<{ subtotal: string }>(
    `SELECT COALESCE(SUM(quantity::numeric * unit_price::numeric), 0)::text AS subtotal
       FROM purchase_order_line_items WHERE purchase_order_id = $1`,
    [id],
  );
  const lineItemsSubtotal = parseFloat(lineItemsSubtotalResult.rows[0]?.subtotal ?? "0") || 0;
  const { subtotal: computedSubtotal, vatAmount: computedVatAmount, grandTotal: computedGrandTotal } = computeCostSummary({
    lineItemsSubtotal,
    discount: discountUpdate,
    deliveryFee: deliveryFeeUpdate,
    vatTreatment: vatTreatmentUpdate,
    vatRate: vatRateUpdate,
    vatManualOverride: vatManualOverrideUpdate,
    vatAmountOverride: vatAmountOverrideUpdate,
  });

  const result = await db.query<PurchaseOrderRow>(
    `UPDATE purchase_orders
        SET po_number = $1, status = $2, currency = $3, total_amount = $4,
            total_amount_manual_override = $5,
            expected_delivery_date = $6, notes = $7, location_id = $8,
            discount_amount = $9, delivery_fee_amount = $10,
            vat_treatment = $11, vat_rate = $12,
            vat_manual_override = $13, vat_override_reason = $14,
            subtotal_amount = $15, vat_amount = $16, grand_total_amount = $17,
            payment_terms = $18, supplier_reference = $19, attachment_urls = $20,
            updated_by_clerk_id = $21, updated_at = now()
      WHERE id = $22 AND workspace_owner_id = $23
     RETURNING *,
       (SELECT name FROM suppliers WHERE id = supplier_id AND workspace_owner_id = $23) AS supplier_name,
       (SELECT name FROM locations WHERE id = $8) AS location_name,
       COALESCE(total_amount::text, (SELECT SUM(l.quantity::numeric * l.unit_price::numeric) FROM purchase_order_line_items l WHERE l.purchase_order_id = id)::text) AS effective_total,
       (SELECT SUM(l.quantity::numeric * l.unit_price::numeric) FROM purchase_order_line_items l WHERE l.purchase_order_id = id)::text AS calculated_total,
       (SELECT COUNT(*) FROM purchase_order_line_items l WHERE l.purchase_order_id = id)::text AS line_items_count,
       (SELECT COUNT(*) FROM purchase_order_line_items l WHERE l.purchase_order_id = id AND l.received_quantity IS NOT NULL AND l.received_quantity::numeric >= l.quantity::numeric)::text AS received_items_count,
       (SELECT COALESCE(SUM(GREATEST(0, l.quantity::numeric - COALESCE(l.received_quantity::numeric, 0))), 0) FROM purchase_order_line_items l WHERE l.purchase_order_id = id)::text AS outstanding_units`,
    [
      poNumber, status, currency, totalAmount, manualOverride, expectedDeliveryDate, notes, locationIdUpdate,
      discountUpdate > 0 ? String(discountUpdate) : null,
      deliveryFeeUpdate > 0 ? String(deliveryFeeUpdate) : null,
      vatTreatmentUpdate,
      vatRateUpdate > 0 ? String(vatRateUpdate) : null,
      vatManualOverrideUpdate,
      vatOverrideReasonUpdate,
      computedSubtotal.toFixed(2),
      computedVatAmount.toFixed(2),
      computedGrandTotal.toFixed(2),
      paymentTermsUpdate,
      supplierReferenceUpdate,
      attachmentUrlsUpdate,
      userId, id, wreq.workspaceOwnerId,
    ],
  );

  const row = result.rows[0];

  if (status !== prev.status) {
    await db.query(
      `INSERT INTO purchase_order_activity
         (purchase_order_id, workspace_owner_id, event_type, description, metadata)
       VALUES ($1, $2, 'po_status_changed', $3, $4)`,
      [
        id,
        wreq.workspaceOwnerId,
        `Status changed from "${prev.status}" to "${status}".`,
        JSON.stringify({ from: prev.status, to: status, changed_by: userId }),
      ],
    );
  }

  // After the update, check if any pending acceptance token is now stale by
  // comparing the current version hash (which includes line items + totals) to the
  // hash that was stored when the token was generated. This catches all material
  // edits — header pricing AND line item changes — reliably.
  const ACCEPTANCE_RELEVANT_STATUSES = ["sent", "supplier_accepted", "pending_approval", "approved"];
  if (ACCEPTANCE_RELEVANT_STATUSES.includes(prev.status)) {
    const currentHash = await computePoVersionHash(id, row.grand_total_amount);
    const pendingAcceptance = await db.query<{ po_version_hash: string | null }>(
      `SELECT po_version_hash FROM purchase_order_acceptances
       WHERE purchase_order_id = $1 AND status = 'pending' AND invalidated_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [id],
    );
    if ((pendingAcceptance.rowCount ?? 0) > 0) {
      const storedHash = pendingAcceptance.rows[0].po_version_hash;
      if (storedHash !== currentHash) {
        await invalidatePendingAcceptances(id, wreq.workspaceOwnerId);
        await db.query(
          `UPDATE purchase_orders SET acceptance_invalidated_at = now(), updated_at = now() WHERE id = $1`,
          [id],
        );
      }
    }
  }

  res.json({
    purchase_order: {
      ...row,
      status: mapPoStatus(row.status, row.sent_at),
      po_number_label: row.po_number ?? poLabel(row.id),
      line_items_count: parseInt(row.line_items_count, 10),
      received_items_count: parseInt(row.received_items_count, 10),
      outstanding_units: parseFloat(row.outstanding_units),
    },
  });
});

/**
 * POST /api/purchase-orders/:id/send
 * Send the purchase order to the supplier's contact email. Owner only.
 * Advances status to "sent", generates an acceptance token, and records sent_at.
 */
router.post("/purchase-orders/:id/send", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "suppliers.edit")) {
    res.status(403).json({ error: "Insufficient permissions to send purchase orders" });
    return;
  }

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid purchase order id" });
    return;
  }

  const existing = await db.query<PurchaseOrderRow & { contact_email: string | null }>(
    `SELECT po.*,
            s.name AS supplier_name,
            s.contact_email,
            loc.name AS location_name
       FROM purchase_orders po
       LEFT JOIN suppliers s ON s.id = po.supplier_id AND s.workspace_owner_id = po.workspace_owner_id
       LEFT JOIN locations loc ON loc.id = po.location_id
      WHERE po.id = $1 AND po.workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );

  if (existing.rowCount === 0) {
    res.status(404).json({ error: "Purchase order not found" });
    return;
  }

  const po = existing.rows[0];

  const SENDABLE_STATUSES = ["created", "sent", "pending_approval", "approved"];
  if (!SENDABLE_STATUSES.includes(po.status)) {
    res.status(409).json({ error: `Cannot send a purchase order with status "${po.status}"` });
    return;
  }

  if (!po.contact_email) {
    res.status(400).json({ error: "Supplier has no contact email address on file" });
    return;
  }

  const lineItemsResult = await db.query<{
    description: string;
    quantity: string;
    unit_price: string;
    currency: string;
    supplier_item_code: string | null;
    tax_category: string | null;
    applied_tax_rate: string | null;
    tax_amount: string | null;
  }>(
    `SELECT li.description, li.quantity::text, li.unit_price::text, li.currency,
            sci.supplier_item_code,
            li.tax_category, li.applied_tax_rate::text, li.tax_amount::text
       FROM purchase_order_line_items li
       LEFT JOIN supplier_catalog_items sci ON sci.id = li.supplier_catalog_item_id
      WHERE li.purchase_order_id = $1
      ORDER BY li.id ASC`,
    [id],
  );

  const calculatedTotal = lineItemsResult.rows.length > 0
    ? lineItemsResult.rows.reduce((sum, li) => sum + parseFloat(li.quantity) * parseFloat(li.unit_price), 0).toFixed(4)
    : null;

  const effectiveTotal = calculatedTotal ?? po.total_amount;

  const userId = authed(req).userId;

  // Generate or reuse the acceptance token BEFORE sending the email so the link
  // can be embedded in the email body.
  // Same-version idempotency: if a pending token already exists for this exact PO
  // version hash, reuse it (avoids invalidating a token the supplier may have open).
  const versionHash = await computePoVersionHash(id, po.grand_total_amount);

  const existingAcceptance = await db.query<{ token: string }>(
    `SELECT token FROM purchase_order_acceptances
     WHERE purchase_order_id = $1 AND workspace_owner_id = $2
       AND status = 'pending' AND invalidated_at IS NULL AND po_version_hash = $3
     LIMIT 1`,
    [id, wreq.workspaceOwnerId, versionHash],
  );

  const isNewToken = (existingAcceptance.rowCount ?? 0) === 0;
  const acceptanceToken = isNewToken
    ? randomBytes(32).toString("hex")
    : existingAcceptance.rows[0].token;

  if (isNewToken) {
    await invalidatePendingAcceptances(id, wreq.workspaceOwnerId);
  }

  const updated = await db.query<PurchaseOrderRow>(
    `UPDATE purchase_orders
        SET status = 'sent', sent_at = now(),
            acceptance_invalidated_at = NULL,
            updated_by_clerk_id = $1, updated_at = now()
      WHERE id = $2 AND workspace_owner_id = $3
     RETURNING *,
       (SELECT name FROM suppliers WHERE id = supplier_id AND workspace_owner_id = $3) AS supplier_name,
       (SELECT COUNT(*) FROM purchase_order_line_items l WHERE l.purchase_order_id = id)::text AS line_items_count,
       (SELECT COUNT(*) FROM purchase_order_line_items l WHERE l.purchase_order_id = id AND l.received_quantity IS NOT NULL AND l.received_quantity::numeric >= l.quantity::numeric)::text AS received_items_count,
       (SELECT COALESCE(SUM(GREATEST(0, l.quantity::numeric - COALESCE(l.received_quantity::numeric, 0))), 0) FROM purchase_order_line_items l WHERE l.purchase_order_id = id)::text AS outstanding_units`,
    [userId, id, wreq.workspaceOwnerId],
  );

  const row = updated.rows[0];

  if (isNewToken) {
    await db.query(
      `INSERT INTO purchase_order_acceptances
         (purchase_order_id, workspace_owner_id, token, status, po_version_hash)
       VALUES ($1, $2, $3, 'pending', $4)`,
      [id, wreq.workspaceOwnerId, acceptanceToken, versionHash],
    );
  }

  const PUBLIC_APP_URL = process.env.PUBLIC_APP_URL ?? "https://os.presentail.com";
  const acceptanceLink = `${PUBLIC_APP_URL}/po-accept/${acceptanceToken}`;

  await sendPurchaseOrderEmail({
    toEmail: po.contact_email,
    poNumberLabel: po.po_number ?? poLabel(po.id),
    status: po.status,
    currency: po.currency,
    totalAmount: po.total_amount,
    effectiveTotal,
    expectedDeliveryDate: po.expected_delivery_date,
    notes: po.notes,
    supplierName: po.supplier_name ?? `Supplier #${po.supplier_id}`,
    locationName: po.location_name,
    lineItems: lineItemsResult.rows,
    acceptanceLink,
  });

  const isResend = !!po.sent_at;
  await db.query(
    `INSERT INTO purchase_order_activity
       (purchase_order_id, workspace_owner_id, event_type, description, metadata)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      id,
      wreq.workspaceOwnerId,
      isResend ? "po_resent" : "po_sent",
      `PO ${isResend ? "resent" : "sent"} to ${po.supplier_name ?? `Supplier #${po.supplier_id}`} at ${po.contact_email}.`,
      JSON.stringify({ to_email: po.contact_email, sent_by: userId, is_resend: isResend }),
    ],
  );

  res.json({
    purchase_order: {
      ...row,
      status: mapPoStatus(row.status, row.sent_at),
      po_number_label: row.po_number ?? poLabel(row.id),
      line_items_count: parseInt(row.line_items_count, 10),
      received_items_count: parseInt(row.received_items_count, 10),
      outstanding_units: parseFloat(row.outstanding_units),
      acceptance_token: acceptanceToken,
    },
  });
});

/**
 * POST /api/purchase-orders/:id/accept
 * Manual acceptance — owner or member with suppliers.approve marks a sent PO as
 * supplier_accepted without going through the tokenized supplier link.
 * Also aliased at POST /api/purchase-orders/:id/acceptance/manual.
 */
async function handleManualAcceptance(
  req: Parameters<Parameters<typeof router.post>[1]>[0],
  res: Parameters<Parameters<typeof router.post>[1]>[1],
): Promise<void> {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "suppliers.approve")) {
    res.status(403).json({ error: "Insufficient permissions to manually accept purchase orders" });
    return;
  }

  const id = parseInt(req.params["id"] as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid purchase order id" });
    return;
  }

  const existing = await db.query<PurchaseOrderRow>(
    `SELECT * FROM purchase_orders WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (existing.rowCount === 0) {
    res.status(404).json({ error: "Purchase order not found" });
    return;
  }

  const prev = existing.rows[0];
  const ACCEPTABLE_STATUSES = ["sent", "pending_approval", "approved"];
  if (!ACCEPTABLE_STATUSES.includes(prev.status)) {
    res.status(409).json({
      error: `Only a sent purchase order can be manually accepted (current status: ${mapPoStatus(prev.status, prev.sent_at)})`,
    });
    return;
  }

  const userId = authed(req).userId;
  const { responder_name, notes } = req.body ?? {};

  const updated = await db.query<PurchaseOrderRow>(
    `UPDATE purchase_orders
        SET status = 'supplier_accepted', accepted_at = now(),
            updated_by_clerk_id = $1, updated_at = now()
      WHERE id = $2 AND workspace_owner_id = $3
     RETURNING *,
       (SELECT name FROM suppliers WHERE id = supplier_id AND workspace_owner_id = $3) AS supplier_name,
       (SELECT COUNT(*) FROM purchase_order_line_items l WHERE l.purchase_order_id = id)::text AS line_items_count,
       (SELECT COUNT(*) FROM purchase_order_line_items l WHERE l.purchase_order_id = id AND l.received_quantity IS NOT NULL AND l.received_quantity::numeric >= l.quantity::numeric)::text AS received_items_count,
       (SELECT COALESCE(SUM(GREATEST(0, l.quantity::numeric - COALESCE(l.received_quantity::numeric, 0))), 0) FROM purchase_order_line_items l WHERE l.purchase_order_id = id)::text AS outstanding_units`,
    [userId, id, wreq.workspaceOwnerId],
  );

  const row = updated.rows[0];

  await db.query(
    `UPDATE purchase_order_acceptances
        SET status = 'accepted', responded_at = now(), response_method = 'manual',
            responder_name = $1, notes = $2
      WHERE purchase_order_id = $3 AND workspace_owner_id = $4 AND status = 'pending' AND invalidated_at IS NULL`,
    [
      responder_name ? String(responder_name).trim() || null : null,
      notes ? String(notes).trim() || null : null,
      id,
      wreq.workspaceOwnerId,
    ],
  );

  await db.query(
    `INSERT INTO purchase_order_activity
       (purchase_order_id, workspace_owner_id, event_type, description, metadata)
     VALUES ($1, $2, 'po_manually_accepted', $3, $4)`,
    [
      id,
      wreq.workspaceOwnerId,
      "Supplier acceptance recorded manually by team member.",
      JSON.stringify({ recorded_by: userId, method: "manual", responder_name: responder_name || null }),
    ],
  );

  res.json({
    purchase_order: {
      ...row,
      status: mapPoStatus(row.status, row.sent_at),
      po_number_label: row.po_number ?? poLabel(row.id),
      line_items_count: parseInt(row.line_items_count, 10),
      received_items_count: parseInt(row.received_items_count, 10),
      outstanding_units: parseFloat(row.outstanding_units),
    },
  });
}

router.post("/purchase-orders/:id/accept", handleManualAcceptance);

/**
 * POST /api/purchase-orders/:id/acceptance/manual
 * Explicit alias for the manual acceptance handler above.
 */
router.post("/purchase-orders/:id/acceptance/manual", handleManualAcceptance);

/**
 * POST /api/purchase-orders/:id/duplicate
 * Create a copy of a PO with status=created, clearing received/sent state.
 */
router.post("/purchase-orders/:id/duplicate", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "suppliers.edit")) {
    res.status(403).json({ error: "Insufficient permissions to duplicate purchase orders" });
    return;
  }
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid purchase order id" });
    return;
  }
  const existing = await db.query<PurchaseOrderRow>(
    `SELECT * FROM purchase_orders WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (existing.rowCount === 0) {
    res.status(404).json({ error: "Purchase order not found" });
    return;
  }
  const src = existing.rows[0];
  const userId = wreq.userId;
  // Insert new PO (status=created, no sent_at/accepted_at)
  const newPo = await db.query<{ id: number }>(
    `INSERT INTO purchase_orders
       (workspace_owner_id, supplier_id, location_id, status, currency, total_amount,
        total_amount_manual_override, discount_amount, delivery_fee_amount,
        vat_treatment, vat_rate, vat_amount, vat_manual_override,
        subtotal_amount, grand_total_amount, expected_delivery_date,
        payment_terms, supplier_reference, notes, po_number, created_by)
     VALUES ($1,$2,$3,'created',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,NULL,$19)
     RETURNING id`,
    [
      wreq.workspaceOwnerId, src.supplier_id, src.location_id, src.currency, src.total_amount,
      src.total_amount_manual_override, src.discount_amount, src.delivery_fee_amount,
      src.vat_treatment, src.vat_rate, src.vat_amount, src.vat_manual_override,
      src.subtotal_amount, src.grand_total_amount, src.expected_delivery_date,
      src.payment_terms, src.supplier_reference, src.notes, userId,
    ],
  );
  const newId = newPo.rows[0].id;
  // Copy line items
  const lineItems = await db.query(
    `SELECT * FROM purchase_order_line_items WHERE purchase_order_id = $1 ORDER BY id`,
    [id],
  );
  for (const li of lineItems.rows) {
    await db.query(
      `INSERT INTO purchase_order_line_items
         (purchase_order_id, workspace_owner_id, base_item_id, description, quantity, unit_price, currency, tax_amount, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [newId, wreq.workspaceOwnerId, li.base_item_id, li.description, li.quantity, li.unit_price, li.currency ?? src.currency, li.tax_amount, li.notes],
    );
  }
  await db.query(
    `INSERT INTO purchase_order_activity (purchase_order_id, workspace_owner_id, event_type, description, metadata)
     VALUES ($1, $2, 'po_created', $3, $4)`,
    [newId, wreq.workspaceOwnerId, `PO duplicated from #${id}.`, JSON.stringify({ duplicated_from: id, created_by: userId })],
  );
  await db.query(
    `INSERT INTO purchase_order_activity (purchase_order_id, workspace_owner_id, event_type, description, metadata)
     VALUES ($1, $2, 'po_duplicated', $3, $4)`,
    [id, wreq.workspaceOwnerId, `PO duplicated — new PO #${newId} created.`, JSON.stringify({ duplicated_to: newId, created_by: userId })],
  );
  res.json({ id: newId });
});

/**
 * DELETE /api/purchase-orders/:id
 * Delete a purchase order. Owner only.
 */
router.delete("/purchase-orders/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "suppliers.edit")) {
    res.status(403).json({ error: "Insufficient permissions to delete purchase orders" });
    return;
  }

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid purchase order id" });
    return;
  }

  const existing = await db.query(
    `SELECT id FROM purchase_orders WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (existing.rowCount === 0) {
    res.status(404).json({ error: "Purchase order not found" });
    return;
  }

  await db.query(`DELETE FROM purchase_order_line_items WHERE purchase_order_id = $1`, [id]);
  await db.query(`DELETE FROM purchase_orders WHERE id = $1`, [id]);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Line Items
// ---------------------------------------------------------------------------

/**
 * Inspect all line items for a PO and auto-advance the PO status:
 *   - All items fully received → "received"
 *   - Some items have any received quantity → "partial"
 *   - No items have any received quantity → leave status unchanged
 */
async function syncPoStatus(poId: number): Promise<void> {
  const result = await db.query<{
    total: string;
    fully_received: string;
    any_received: string;
  }>(
    `SELECT
       COUNT(*)::text AS total,
       COUNT(*) FILTER (
         WHERE received_quantity IS NOT NULL
           AND received_quantity::numeric >= quantity::numeric
       )::text AS fully_received,
       COUNT(*) FILTER (
         WHERE received_quantity IS NOT NULL
           AND received_quantity::numeric > 0
       )::text AS any_received
     FROM purchase_order_line_items
    WHERE purchase_order_id = $1`,
    [poId],
  );

  const row = result.rows[0];
  // A concurrent schema rollout or a defensive/mock query result may return
  // no aggregate row. There is nothing to advance in that case; importantly,
  // do not turn an otherwise successful line-item mutation into a 500.
  if (!row) return;
  const total = parseInt(row.total, 10);
  const fullyReceived = parseInt(row.fully_received, 10);
  const anyReceived = parseInt(row.any_received, 10);

  if (total === 0 || anyReceived === 0) return;

  const newStatus = fullyReceived === total ? "received" : "partial";

  if (newStatus === "received") {
    await db.query(
      `UPDATE purchase_orders
         SET status = $1, updated_at = now(),
             received_at = COALESCE(received_at, now()),
             invoice_status = CASE WHEN invoice_status = 'not_attached' THEN 'missing' ELSE invoice_status END
       WHERE id = $2`,
      [newStatus, poId],
    );
  } else {
    await db.query(
      `UPDATE purchase_orders SET status = $1, updated_at = now() WHERE id = $2`,
      [newStatus, poId],
    );
  }
}

type LineItemRow = {
  id: number;
  purchase_order_id: number;
  base_item_id: number | null;
  supplier_catalog_item_id: number | null;
  base_item_supplier_id: number | null;
  base_item_name: string | null;
  supplier_item_code: string | null;
  supplier_item_unit: string | null;
  description: string;
  description_ar: string | null;
  quantity: string;
  unit_price: string;
  currency: string;
  received_quantity: string | null;
  tax_category: string | null;
  applied_tax_rate: string | null;
  taxable_amount: string | null;
  tax_amount: string | null;
  tax_override: boolean;
  vat_treatment: string | null;
  package_quantity: string | null;
  created_at: string;
  updated_at: string;
};

function resolvePoOwner(wreq: ReturnType<typeof workspace>, poId: number) {
  return db.query<{ id: number }>(
    `SELECT id FROM purchase_orders WHERE id = $1 AND workspace_owner_id = $2`,
    [poId, wreq.workspaceOwnerId],
  );
}

function validatePositiveNumber(value: unknown, field: string): { valid: false; error: string } | { valid: true; value: string } {
  const str = String(value ?? "").trim();
  if (str === "" || str === "null" || str === "undefined") {
    return { valid: false, error: `${field} is required` };
  }
  const num = parseFloat(str);
  if (isNaN(num) || !isFinite(num)) {
    return { valid: false, error: `${field} must be a valid number` };
  }
  if (num < 0) {
    return { valid: false, error: `${field} must be a non-negative number` };
  }
  return { valid: true, value: str };
}

function validateOptionalNumber(value: unknown, field: string): { valid: false; error: string } | { valid: true; value: string | null } {
  if (value == null) return { valid: true, value: null };
  const str = String(value).trim();
  if (str === "" || str === "null" || str === "undefined") return { valid: true, value: null };
  const num = parseFloat(str);
  if (isNaN(num) || !isFinite(num)) {
    return { valid: false, error: `${field} must be a valid number` };
  }
  if (num < 0) {
    return { valid: false, error: `${field} must be a non-negative number` };
  }
  return { valid: true, value: str };
}

function resolveBaseItemName(wreq: ReturnType<typeof workspace>, baseItemId: number | null) {
  if (baseItemId == null) {
    const empty: pg.QueryResult<{ name: string }> = {
      rows: [],
      rowCount: 0,
      command: "SELECT",
      fields: [],
      oid: 0,
    } as unknown as pg.QueryResult<{ name: string }>;
    return Promise.resolve(empty);
  }
  return db.query<{ name: string }>(
    `SELECT name FROM base_items WHERE id = $1 AND workspace_owner_id = $2`,
    [baseItemId, wreq.workspaceOwnerId],
  );
}

/** Minimal interface shared by pg.Pool and pg.PoolClient, used by recomputePoTotals. */
interface QueryRunner {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
}

/**
 * After any line-item INSERT, UPDATE, or DELETE, re-derive the parent PO's
 * subtotal_amount, vat_amount, and grand_total_amount using the same
 * computeCostSummary logic that the PATCH /purchase-orders/:id handler uses.
 * total_amount is also kept in sync when total_amount_manual_override is false.
 *
 * Pass the active transaction client so that this recompute runs atomically
 * alongside the triggering line-item mutation.
 */
async function recomputePoTotals(runner: QueryRunner, poId: number): Promise<void> {
  const poResult = await runner.query<{
    discount_amount: string | null;
    delivery_fee_amount: string | null;
    vat_treatment: string | null;
    vat_rate: string | null;
    vat_manual_override: boolean;
    vat_amount: string | null;
    total_amount_manual_override: boolean;
  }>(
    `SELECT discount_amount, delivery_fee_amount, vat_treatment, vat_rate,
            vat_manual_override, vat_amount, total_amount_manual_override
       FROM purchase_orders WHERE id = $1`,
    [poId],
  );
  if ((poResult.rowCount ?? 0) === 0) return;
  const po = poResult.rows[0];

  const lineItemsSubtotalResult = await runner.query<{ subtotal: string }>(
    `SELECT COALESCE(SUM(quantity::numeric * unit_price::numeric), 0)::text AS subtotal
       FROM purchase_order_line_items WHERE purchase_order_id = $1`,
    [poId],
  );
  const lineItemsSubtotal = parseFloat(lineItemsSubtotalResult.rows[0]?.subtotal ?? "0") || 0;

  const { subtotal: computedSubtotal, vatAmount: computedVatAmount, grandTotal: computedGrandTotal } = computeCostSummary({
    lineItemsSubtotal,
    discount: parseFloat(po.discount_amount ?? "0") || 0,
    deliveryFee: parseFloat(po.delivery_fee_amount ?? "0") || 0,
    vatTreatment: po.vat_treatment ?? "no_vat",
    vatRate: parseFloat(po.vat_rate ?? "0") || 0,
    vatManualOverride: po.vat_manual_override ?? false,
    vatAmountOverride: po.vat_amount != null ? parseFloat(po.vat_amount) : null,
  });

  await runner.query(
    `UPDATE purchase_orders
        SET subtotal_amount = $1,
            vat_amount = $2,
            grand_total_amount = $3,
            total_amount = CASE WHEN total_amount_manual_override = false THEN $4 ELSE total_amount END,
            updated_at = now()
      WHERE id = $5`,
    [
      computedSubtotal.toFixed(2),
      computedVatAmount.toFixed(2),
      computedGrandTotal.toFixed(2),
      lineItemsSubtotal.toFixed(4),
      poId,
    ],
  );
}

/**
 * GET /api/purchase-orders/:id/line-items
 * List line items for a purchase order.
 */
router.get("/purchase-orders/:id/line-items", async (req, res) => {
  const wreq = workspace(req);
  const poId = parseInt(req.params.id, 10);
  if (isNaN(poId)) {
    res.status(400).json({ error: "Invalid purchase order id" });
    return;
  }

  const poCheck = await resolvePoOwner(wreq, poId);
  if (poCheck.rowCount === 0) {
    res.status(404).json({ error: "Purchase order not found" });
    return;
  }

  const result = await db.query<LineItemRow>(
    `SELECT li.*,
            bi.name AS base_item_name,
            sci.supplier_item_code AS supplier_item_code,
            sci.unit AS supplier_item_unit
       FROM purchase_order_line_items li
       LEFT JOIN base_items bi ON bi.id = li.base_item_id AND bi.workspace_owner_id = $2
       LEFT JOIN supplier_catalog_items sci ON sci.id = li.supplier_catalog_item_id
      WHERE li.purchase_order_id = $1
      ORDER BY li.id ASC`,
    [poId, wreq.workspaceOwnerId],
  );

  const lineItems = result.rows;
  const calculatedTotal = lineItems.length > 0
    ? lineItems.reduce((sum, li) => sum + parseFloat(li.quantity) * parseFloat(li.unit_price), 0).toFixed(4)
    : null;

  res.json({ line_items: lineItems, calculated_total: calculatedTotal });
});

/**
 * POST /api/purchase-orders/:id/line-items
 * Add a line item to a purchase order.
 */
router.post("/purchase-orders/:id/line-items", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "suppliers.edit")) {
    res.status(403).json({ error: "Insufficient permissions to manage purchase order line items" });
    return;
  }

  const poId = parseInt(req.params.id, 10);
  if (isNaN(poId)) {
    res.status(400).json({ error: "Invalid purchase order id" });
    return;
  }

  const poCheck = await db.query<{ id: number; supplier_id: number; location_id: number | null }>(
    `SELECT id, supplier_id, location_id FROM purchase_orders WHERE id = $1 AND workspace_owner_id = $2`,
    [poId, wreq.workspaceOwnerId],
  );
  if (poCheck.rowCount === 0) {
    res.status(404).json({ error: "Purchase order not found" });
    return;
  }
  const poSupplierId = poCheck.rows[0].supplier_id;
  const poLocationId = poCheck.rows[0].location_id;

  const { base_item_id, supplier_catalog_item_id: rawScid, base_item_supplier_id: rawBisId, description, description_ar: rawDescriptionAr, quantity, unit_price, currency, received_quantity, vat_treatment: rawVatTreatment } = req.body ?? {};

  // Description is required unless a base_item_supplier_id is supplied — the BIS
  // lookup below will derive description from the supplier link name.
  if ((!description || String(description).trim() === "") && rawBisId == null) {
    res.status(400).json({ error: "description is required" });
    return;
  }

  const qtyCheck = validatePositiveNumber(quantity, "quantity");
  if (!qtyCheck.valid) { res.status(400).json({ error: qtyCheck.error }); return; }

  // unit_price is required unless base_item_supplier_id is provided (BIS supplies it)
  if ((unit_price == null || String(unit_price).trim() === "") && rawBisId == null) {
    res.status(400).json({ error: "unit_price is required" });
    return;
  }
  const rawUnitPrice = unit_price ?? "0"; // placeholder; overridden by BIS lookup when rawBisId set
  const priceCheck = validatePositiveNumber(rawUnitPrice, "unit_price");
  if (!priceCheck.valid && rawBisId == null) { res.status(400).json({ error: priceCheck.error }); return; }

  const rcvCheck = validateOptionalNumber(received_quantity, "received_quantity");
  if (!rcvCheck.valid) { res.status(400).json({ error: rcvCheck.error }); return; }

  const baseItemId = base_item_id != null ? parseInt(String(base_item_id), 10) : null;
  if (baseItemId != null && isNaN(baseItemId)) {
    res.status(400).json({ error: "base_item_id must be a valid number" });
    return;
  }

  const supplierCatalogItemId = rawScid != null ? parseInt(String(rawScid), 10) : null;
  if (supplierCatalogItemId != null && isNaN(supplierCatalogItemId)) {
    res.status(400).json({ error: "supplier_catalog_item_id must be a valid number" });
    return;
  }

  const baseItemSupplierId = rawBisId != null ? parseInt(String(rawBisId), 10) : null;
  if (baseItemSupplierId != null && isNaN(baseItemSupplierId)) {
    res.status(400).json({ error: "base_item_supplier_id must be a valid number" });
    return;
  }

  // description / unit_price may be undefined when BIS is being used — initialise
  // to safe placeholders and let the BIS lookup below overwrite them.
  let resolvedDescription = description != null ? String(description).trim() : "";
  let resolvedUnitPrice = priceCheck.valid ? priceCheck.value : "0"; // BIS overrides when supplied
  let resolvedCurrency = currency ? String(currency) : "AED";
  let resolvedBaseItemId = baseItemId;
  let resolvedBaseItemSupplierId: number | null = baseItemSupplierId;
  let resolvedDescriptionAr: string | null =
    rawDescriptionAr != null && String(rawDescriptionAr).trim() !== "" ? String(rawDescriptionAr).trim() : null;

  // BIS source path — takes priority over supplier_catalog_item_id
  let resolvedPackageQuantity: string | null = null;
  if (baseItemSupplierId != null) {
    const bisCheck = await db.query<{ base_item_id: number; supplier_item_name: string | null; name_ar: string | null; price: string | null; currency: string; package_quantity: string | null }>(
      `SELECT bis.base_item_id, bis.supplier_item_name, bis.name_ar, bis.price, bis.currency,
              bip.quantity::text AS package_quantity
         FROM base_item_suppliers bis
         LEFT JOIN base_item_packages bip ON bip.id = bis.package_id
        WHERE bis.id = $1 AND bis.supplier_id = $2 AND bis.workspace_owner_id = $3`,
      [baseItemSupplierId, poSupplierId, wreq.workspaceOwnerId],
    );
    if (bisCheck.rowCount === 0) {
      res.status(404).json({ error: "base_item_supplier_id not found for this supplier" });
      return;
    }
    const bisRow = bisCheck.rows[0];
    if (bisRow.supplier_item_name) resolvedDescription = bisRow.supplier_item_name;
    if (bisRow.price != null) resolvedUnitPrice = bisRow.price;
    resolvedCurrency = bisRow.currency || resolvedCurrency;
    if (resolvedBaseItemId == null) resolvedBaseItemId = bisRow.base_item_id;
    if (resolvedDescriptionAr == null && bisRow.name_ar) resolvedDescriptionAr = bisRow.name_ar;
    // Snapshot package conversion factor so receiving is unaffected by later BIS/package edits.
    if (bisRow.package_quantity != null) resolvedPackageQuantity = bisRow.package_quantity;

    // Fallback: if BIS has no supplier_item_name and description is still empty,
    // use the base item name (mirrors the create-PO path behaviour).
    if (!resolvedDescription && resolvedBaseItemId != null) {
      const biResult = await db.query<{ name: string }>(
        `SELECT name FROM base_items WHERE id = $1 AND workspace_owner_id = $2`,
        [resolvedBaseItemId, wreq.workspaceOwnerId],
      );
      if ((biResult.rowCount ?? 0) > 0) resolvedDescription = biResult.rows[0].name;
    }
  } else if (supplierCatalogItemId != null) {
    const scidCheck = await db.query<{ id: number; name: string; price: string | null; currency: string; base_item_id: number | null; supplier_item_code: string | null; unit: string | null; name_ar: string | null }>(
      `SELECT id, name, price, currency, base_item_id, supplier_item_code, unit, name_ar
         FROM supplier_catalog_items WHERE id = $1 AND supplier_id = $2 AND workspace_owner_id = $3`,
      [supplierCatalogItemId, poSupplierId, wreq.workspaceOwnerId],
    );
    if (scidCheck.rowCount === 0) {
      res.status(404).json({ error: "supplier_catalog_item_id not found for this supplier" });
      return;
    }
    const sciRow = scidCheck.rows[0];
    resolvedDescription = sciRow.name;
    if (sciRow.price != null) resolvedUnitPrice = sciRow.price;
    resolvedCurrency = sciRow.currency || resolvedCurrency;
    if (resolvedBaseItemId == null && sciRow.base_item_id != null) resolvedBaseItemId = sciRow.base_item_id;
    if (resolvedDescriptionAr == null && sciRow.name_ar) resolvedDescriptionAr = sciRow.name_ar;
    resolvedBaseItemSupplierId = null;
  }

  // Auto-translate to Arabic only when no manual/cached value is available yet.
  if (resolvedDescriptionAr == null) {
    const translated = await translateToArabic(resolvedDescription, {
      workspaceOwnerId: wreq.workspaceOwnerId,
    });
    if (translated) {
      resolvedDescriptionAr = translated;
      if (supplierCatalogItemId != null) {
        // Cache on the catalog item for future line items, but never clobber
        // a value that was set (manually or by another translation) meanwhile.
        await db.query(
          `UPDATE supplier_catalog_items SET name_ar = $1, name_ar_source = 'auto'
             WHERE id = $2 AND name_ar IS NULL`,
          [translated, supplierCatalogItemId],
        );
      }
    }
  }

  // Validate base item (if explicitly provided) and fetch its tax_category.
  // Also handles the case where resolvedBaseItemId came from a supplier catalog item.
  let resolvedTaxCategory: string | null = null;

  if (resolvedBaseItemId != null) {
    const biResult = await db.query<{ tax_category: string }>(
      `SELECT tax_category FROM base_items WHERE id = $1 AND workspace_owner_id = $2`,
      [resolvedBaseItemId, wreq.workspaceOwnerId],
    );
    if (biResult.rowCount === 0 && baseItemId != null) {
      // Only hard-error when base_item_id was explicitly provided by the caller.
      // When it came from a supplier catalog lookup, trust it silently.
      res.status(404).json({ error: "Base item not found" });
      return;
    }
    if ((biResult.rowCount ?? 0) > 0) {
      resolvedTaxCategory = biResult.rows[0].tax_category;
    }
  }

  // If no tax category was resolved from the base item, fall back to the
  // supplier's default_tax_category for pre-filling new PO lines.
  if (resolvedTaxCategory == null || resolvedTaxCategory === "not_classified") {
    const supplierResult = await db.query<{ default_tax_category: string | null }>(
      `SELECT default_tax_category FROM suppliers WHERE id = $1 AND workspace_owner_id = $2`,
      [poSupplierId, wreq.workspaceOwnerId],
    );
    const supplierTaxCat = supplierResult.rows[0]?.default_tax_category ?? null;
    if (supplierTaxCat && supplierTaxCat !== "not_classified") {
      resolvedTaxCategory = supplierTaxCat;
    }
  }

  // Auto-resolve tax rate from tax_rules when the PO has a location and the
  // base item carries a meaningful tax category.
  let appliedTaxRate: string | null = null;
  let taxableAmountVal: string | null = null;
  let taxAmountVal: string | null = null;

  if (resolvedTaxCategory && resolvedTaxCategory !== "not_classified" && poLocationId != null) {
    const taxResult = await db.query<{ rate_percent: string }>(
      `SELECT rate_percent FROM tax_rules
       WHERE workspace_owner_id = $1
         AND tax_category = $2
         AND is_active = true
         AND effective_from <= CURRENT_DATE
         AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
         AND (
           location_id = $3
           OR (location_id IS NULL AND country_code = (
             SELECT country FROM locations WHERE id = $3
           ))
         )
       ORDER BY location_id NULLS LAST, effective_from DESC
       LIMIT 1`,
      [wreq.workspaceOwnerId, resolvedTaxCategory, poLocationId],
    );
    if ((taxResult.rowCount ?? 0) > 0) {
      const rate = parseFloat(taxResult.rows[0].rate_percent);
      const netAmt = parseFloat(qtyCheck.value) * parseFloat(resolvedUnitPrice);
      appliedTaxRate = taxResult.rows[0].rate_percent;
      taxableAmountVal = netAmt.toFixed(2);
      taxAmountVal = (netAmt * rate / 100).toFixed(2);
    }
  }

  const VALID_VAT_TREATMENTS = ["exclusive", "inclusive", "no_vat"];
  const vatTreatment = rawVatTreatment != null && String(rawVatTreatment).trim() !== ""
    ? String(rawVatTreatment).trim()
    : null;
  if (vatTreatment != null && !VALID_VAT_TREATMENTS.includes(vatTreatment)) {
    res.status(400).json({ error: "vat_treatment must be one of: exclusive, inclusive, no_vat" });
    return;
  }

  const txClient = await db.connect();
  let insertedRow: LineItemRow;
  try {
    await txClient.query("BEGIN");

    const result = await txClient.query<LineItemRow>(
      `INSERT INTO purchase_order_line_items
         (purchase_order_id, base_item_id, supplier_catalog_item_id, base_item_supplier_id, description, description_ar, quantity, unit_price, currency, received_quantity,
          tax_category, applied_tax_rate, taxable_amount, tax_amount, vat_treatment, package_quantity)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $17)
       RETURNING *,
         (SELECT name FROM base_items WHERE id = $2 AND workspace_owner_id = $16) AS base_item_name,
         (SELECT supplier_item_code FROM supplier_catalog_items WHERE id = $3) AS supplier_item_code,
         (SELECT unit FROM supplier_catalog_items WHERE id = $3) AS supplier_item_unit`,
      [
        poId,
        resolvedBaseItemId,
        resolvedBaseItemSupplierId != null ? null : supplierCatalogItemId,
        resolvedBaseItemSupplierId,
        resolvedDescription,
        resolvedDescriptionAr,
        qtyCheck.value,
        resolvedUnitPrice,
        resolvedCurrency,
        rcvCheck.value,
        resolvedTaxCategory,
        appliedTaxRate,
        taxableAmountVal,
        taxAmountVal,
        vatTreatment,
        wreq.workspaceOwnerId,
        resolvedPackageQuantity,
      ],
    );

    await recomputePoTotals(txClient, poId);

    await txClient.query("COMMIT");
    insertedRow = result.rows[0];
  } catch (err) {
    await txClient.query("ROLLBACK");
    throw err;
  } finally {
    txClient.release();
  }

  await syncPoStatus(poId);

  const userId = authed(req).userId;
  await db.query(
    `INSERT INTO purchase_order_activity
       (purchase_order_id, workspace_owner_id, event_type, description, metadata)
     VALUES ($1, $2, 'po_line_item_added', $3, $4)`,
    [
      poId,
      wreq.workspaceOwnerId,
      `Line item "${insertedRow.description}" added (qty: ${insertedRow.quantity}, unit price: ${insertedRow.unit_price} ${insertedRow.currency}).`,
      JSON.stringify({
        line_item_id: insertedRow.id,
        description: insertedRow.description,
        quantity: insertedRow.quantity,
        unit_price: insertedRow.unit_price,
        currency: insertedRow.currency,
        added_by: userId,
      }),
    ],
  );

  res.status(201).json({ line_item: insertedRow });
});

/**
 * PATCH /api/purchase-orders/:id/line-items/:lineItemId
 * Update a purchase order line item.
 */
router.patch("/purchase-orders/:id/line-items/:lineItemId", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "suppliers.edit")) {
    res.status(403).json({ error: "Insufficient permissions to manage purchase order line items" });
    return;
  }

  const poId = parseInt(req.params.id, 10);
  const lineItemId = parseInt(req.params.lineItemId, 10);
  if (isNaN(poId) || isNaN(lineItemId)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const poCheck = await db.query<{ id: number; location_id: number | null; supplier_id: number }>(
    `SELECT id, location_id, supplier_id FROM purchase_orders WHERE id = $1 AND workspace_owner_id = $2`,
    [poId, wreq.workspaceOwnerId],
  );
  if (poCheck.rowCount === 0) {
    res.status(404).json({ error: "Purchase order not found" });
    return;
  }
  const poLocationId = poCheck.rows[0].location_id;
  const poSupplierId = poCheck.rows[0].supplier_id;

  const existing = await db.query<LineItemRow>(
    `SELECT * FROM purchase_order_line_items WHERE id = $1 AND purchase_order_id = $2`,
    [lineItemId, poId],
  );
  if (existing.rowCount === 0) {
    res.status(404).json({ error: "Line item not found" });
    return;
  }

  const prev = existing.rows[0];
  const body = req.body ?? {};

  // ── BIS source resolution ──────────────────────────────────────────────────
  // If base_item_supplier_id is supplied, validate it against this PO's supplier
  // and workspace, then use it to populate snapshot fields.
  const bisIdChanged = "base_item_supplier_id" in body;
  const newBisIdRaw = bisIdChanged
    ? (body.base_item_supplier_id != null ? parseInt(String(body.base_item_supplier_id), 10) : null)
    : prev.base_item_supplier_id;

  if (bisIdChanged && newBisIdRaw != null && isNaN(newBisIdRaw)) {
    res.status(400).json({ error: "base_item_supplier_id must be a valid number" });
    return;
  }

  let resolvedBisId: number | null = newBisIdRaw ?? prev.base_item_supplier_id;
  let bisSnapshotBaseItemId: number | null = null;
  let bisSnapshotDescription: string | null = null;
  let bisSnapshotDescriptionAr: string | null = null;
  let bisSnapshotPrice: string | null = null;
  let bisSnapshotCurrency: string | null = null;

  let bisSnapshotPackageQuantity: string | null = null;
  if (bisIdChanged && newBisIdRaw != null) {
    // Scope the lookup to this workspace AND the PO's supplier
    const bisLookup = await db.query<{
      base_item_id: number;
      supplier_item_name: string | null;
      name_ar: string | null;
      price: string | null;
      currency: string;
      package_quantity: string | null;
    }>(
      `SELECT bis.base_item_id, bis.supplier_item_name, bis.name_ar, bis.price, bis.currency,
              bip.quantity::text AS package_quantity
         FROM base_item_suppliers bis
         LEFT JOIN base_item_packages bip ON bip.id = bis.package_id
        WHERE bis.id = $1 AND bis.workspace_owner_id = $2 AND bis.supplier_id = $3`,
      [newBisIdRaw, wreq.workspaceOwnerId, poSupplierId],
    );
    if ((bisLookup.rowCount ?? 0) === 0) {
      res.status(404).json({ error: "base_item_supplier_id not found for this supplier" });
      return;
    }
    const bisRow = bisLookup.rows[0];
    resolvedBisId = newBisIdRaw;
    bisSnapshotBaseItemId = bisRow.base_item_id;
    bisSnapshotDescription = bisRow.supplier_item_name;
    bisSnapshotDescriptionAr = bisRow.name_ar;
    bisSnapshotPrice = bisRow.price;
    bisSnapshotCurrency = bisRow.currency;
    // Snapshot the package conversion factor so receiving is unaffected by
    // later BIS/package edits or link removals.
    bisSnapshotPackageQuantity = bisRow.package_quantity;
  } else if (bisIdChanged && newBisIdRaw == null) {
    // Explicitly clearing the BIS link
    resolvedBisId = null;
  }

  // Derived supplier_catalog_item_id: cleared when BIS is being set
  const resolvedScid = bisIdChanged && newBisIdRaw != null
    ? null
    : prev.supplier_catalog_item_id;

  const baseItemIdChanged = "base_item_id" in body;
  // base_item_id auto-derived from BIS when not explicitly supplied
  const baseItemId = baseItemIdChanged
    ? (body.base_item_id != null ? parseInt(String(body.base_item_id), 10) : null)
    : (bisSnapshotBaseItemId ?? prev.base_item_id);
  if (baseItemId != null && isNaN(baseItemId)) {
    res.status(400).json({ error: "base_item_id must be a valid number" });
    return;
  }

  // Fetch tax_category for the (possibly updated) base item.
  // Also re-fetches when base_item_id is unchanged but tax_category is null on
  // the existing row (legacy items created before auto-calc was added).
  let resolvedTaxCategory: string | null = prev.tax_category;
  if (baseItemId != null) {
    if (baseItemId !== prev.base_item_id || prev.tax_category == null) {
      // base_item_id changed, OR the stored tax_category is stale/missing —
      // fetch it from base_items to (re-)populate the tax fields.
      const biCheck = await db.query<{ name: string; tax_category: string }>(
        `SELECT name, tax_category FROM base_items WHERE id = $1 AND workspace_owner_id = $2`,
        [baseItemId, wreq.workspaceOwnerId],
      );
      if (biCheck.rowCount === 0) {
        if (baseItemId !== prev.base_item_id) {
          // Hard-error only when the caller explicitly changed base_item_id.
          res.status(404).json({ error: "Base item not found" });
          return;
        }
        // Legacy row with a now-deleted base item — leave tax fields null.
      } else {
        resolvedTaxCategory = biCheck.rows[0].tax_category;
      }
    }
    // If base_item_id is unchanged and tax_category is already populated, keep it.
  } else {
    // base_item_id cleared (set to null).
    resolvedTaxCategory = null;
  }

  // Description: explicit body value > BIS snapshot > prev
  const description = "description" in body
    ? String(body.description).trim()
    : (bisSnapshotDescription ?? prev.description);
  if (description === "") {
    res.status(400).json({ error: "description is required" });
    return;
  }

  // unit_price / currency: explicit body value > BIS snapshot > prev
  // (these are read below via body access; inject BIS values into body-like fallback)
  const resolvedUnitPriceFromBis = bisSnapshotPrice;
  const resolvedCurrencyFromBis = bisSnapshotCurrency;

  // Arabic name: an explicit value in the body is always treated as a manual
  // edit (including clearing it to null). When not sent, use BIS snapshot then keep current
  // value; if it was never set, best-effort auto-translate once.
  let descriptionAr: string | null;
  if ("description_ar" in body) {
    descriptionAr = body.description_ar != null && String(body.description_ar).trim() !== ""
      ? String(body.description_ar).trim()
      : null;
  } else if (bisSnapshotDescriptionAr != null) {
    // BIS snapshot provides an Arabic name; use it (only when description_ar was not explicitly sent)
    descriptionAr = bisSnapshotDescriptionAr;
  } else if (prev.description_ar != null) {
    descriptionAr = prev.description_ar;
  } else {
    const translated = await translateToArabic(description, {
      workspaceOwnerId: wreq.workspaceOwnerId,
    });
    descriptionAr = translated;
    if (translated && prev.supplier_catalog_item_id != null) {
      await db.query(
        `UPDATE supplier_catalog_items SET name_ar = $1, name_ar_source = 'auto'
           WHERE id = $2 AND name_ar IS NULL`,
        [translated, prev.supplier_catalog_item_id],
      );
    }
  }

  const quantity = "quantity" in body ? String(body.quantity) : prev.quantity;
  const qtyCheck = validatePositiveNumber(quantity, "quantity");
  if (!qtyCheck.valid) { res.status(400).json({ error: qtyCheck.error }); return; }

  // unit_price / currency: explicit body > BIS snapshot > prev
  const unitPrice = "unit_price" in body
    ? String(body.unit_price)
    : (resolvedUnitPriceFromBis ?? prev.unit_price);
  const priceCheck = validatePositiveNumber(unitPrice, "unit_price");
  if (!priceCheck.valid) { res.status(400).json({ error: priceCheck.error }); return; }

  const currency = "currency" in body
    ? String(body.currency)
    : (resolvedCurrencyFromBis ?? prev.currency);

  const receivedQuantity = "received_quantity" in body
    ? (body.received_quantity != null ? String(body.received_quantity) : null)
    : prev.received_quantity;
  const rcvCheck = validateOptionalNumber(receivedQuantity, "received_quantity");
  if (!rcvCheck.valid) { res.status(400).json({ error: rcvCheck.error }); return; }

  const VALID_VAT_TREATMENTS_PATCH = ["exclusive", "inclusive", "no_vat"];
  const vatTreatmentPatch = "vat_treatment" in body
    ? (body.vat_treatment != null && String(body.vat_treatment).trim() !== "" ? String(body.vat_treatment).trim() : null)
    : prev.vat_treatment;
  if (vatTreatmentPatch != null && !VALID_VAT_TREATMENTS_PATCH.includes(vatTreatmentPatch)) {
    res.status(400).json({ error: "vat_treatment must be one of: exclusive, inclusive, no_vat" });
    return;
  }

  // --- Tax override / re-resolve logic ---
  // re_resolve_tax: true → always re-run lookup, clear override flag.
  // applied_tax_rate / tax_amount in body → use manual values, set override flag.
  // Otherwise: if previously overridden, keep override and only recalculate tax_amount
  //            from the stored rate if qty/price changed; if not overridden, auto-resolve
  //            on relevant field changes.
  const reResolveTax = body.re_resolve_tax === true;
  const manualRateProvided = "applied_tax_rate" in body;
  const manualAmountProvided = "tax_amount" in body;

  let appliedTaxRatePatch: string | null;
  let taxableAmountPatch: string | null;
  let taxAmountPatch: string | null;
  let taxOverridePatch: boolean;

  const netAmt = parseFloat(qtyCheck.value) * parseFloat(priceCheck.value);
  const taxRelevantChange = baseItemIdChanged || "quantity" in body || "unit_price" in body;

  if (manualRateProvided || manualAmountProvided) {
    // Manual override path — owner is explicitly setting rate / amount.
    const rawRate = manualRateProvided ? body.applied_tax_rate : prev.applied_tax_rate;
    const rawAmount = manualAmountProvided ? body.tax_amount : prev.tax_amount;
    appliedTaxRatePatch = rawRate != null && String(rawRate).trim() !== "" ? String(rawRate).trim() : null;
    taxableAmountPatch = netAmt.toFixed(2);
    if (appliedTaxRatePatch != null && !manualAmountProvided) {
      // Recalculate tax_amount from the supplied rate and current qty×price.
      taxAmountPatch = (netAmt * parseFloat(appliedTaxRatePatch) / 100).toFixed(2);
    } else {
      taxAmountPatch = rawAmount != null && String(rawAmount).trim() !== "" ? String(rawAmount).trim() : null;
    }
    taxOverridePatch = appliedTaxRatePatch != null;
  } else if (reResolveTax || (!prev.tax_override && taxRelevantChange)) {
    // Auto-resolve path — either explicit re-resolve request, or relevant fields
    // changed and this item was not already under a manual override.
    appliedTaxRatePatch = null;
    taxableAmountPatch = null;
    taxAmountPatch = null;
    taxOverridePatch = false;

    // When no tax category came from a base item, fall back to the supplier's default.
    if (resolvedTaxCategory == null || resolvedTaxCategory === "not_classified") {
      const supplierResult = await db.query<{ default_tax_category: string | null }>(
        `SELECT default_tax_category FROM suppliers WHERE id = $1 AND workspace_owner_id = $2`,
        [poSupplierId, wreq.workspaceOwnerId],
      );
      const supplierTaxCat = supplierResult.rows[0]?.default_tax_category ?? null;
      if (supplierTaxCat && supplierTaxCat !== "not_classified") {
        resolvedTaxCategory = supplierTaxCat;
      }
    }

    if (resolvedTaxCategory && resolvedTaxCategory !== "not_classified" && poLocationId != null) {
      const taxResult = await db.query<{ rate_percent: string }>(
        `SELECT rate_percent FROM tax_rules
         WHERE workspace_owner_id = $1
           AND tax_category = $2
           AND is_active = true
           AND effective_from <= CURRENT_DATE
           AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
           AND (
             location_id = $3
             OR (location_id IS NULL AND country_code = (
               SELECT country FROM locations WHERE id = $3
             ))
           )
         ORDER BY location_id NULLS LAST, effective_from DESC
         LIMIT 1`,
        [wreq.workspaceOwnerId, resolvedTaxCategory, poLocationId],
      );
      if ((taxResult.rowCount ?? 0) > 0) {
        const rate = parseFloat(taxResult.rows[0].rate_percent);
        appliedTaxRatePatch = taxResult.rows[0].rate_percent;
        taxableAmountPatch = netAmt.toFixed(2);
        taxAmountPatch = (netAmt * rate / 100).toFixed(2);
      }
    }
  } else if (prev.tax_override && taxRelevantChange) {
    // Qty/price changed but item has a manual override — keep the override rate,
    // recalculate tax_amount from it and the new net amount.
    appliedTaxRatePatch = prev.applied_tax_rate;
    taxableAmountPatch = netAmt.toFixed(2);
    taxAmountPatch = prev.applied_tax_rate != null
      ? (netAmt * parseFloat(prev.applied_tax_rate) / 100).toFixed(2)
      : prev.tax_amount;
    taxOverridePatch = true;
  } else {
    // Nothing tax-relevant changed and no manual values — preserve existing.
    appliedTaxRatePatch = prev.applied_tax_rate;
    taxableAmountPatch = prev.taxable_amount;
    taxAmountPatch = prev.tax_amount;
    taxOverridePatch = prev.tax_override;
  }

  const txClient = await db.connect();
  let updatedRow: LineItemRow;
  try {
    await txClient.query("BEGIN");

    // package_quantity: use the new BIS snapshot when BIS changed; if BIS is
    // explicitly cleared (null), clear package_quantity too; otherwise keep prev.
    const packageQuantityPatch = bisIdChanged
      ? (newBisIdRaw != null ? bisSnapshotPackageQuantity : null)
      : prev.package_quantity ?? null;

    const result = await txClient.query<LineItemRow>(
      `UPDATE purchase_order_line_items
          SET base_item_id = $1, description = $2, description_ar = $3, quantity = $4, unit_price = $5,
              currency = $6, received_quantity = $7, vat_treatment = $8,
              tax_category = $9, applied_tax_rate = $10, taxable_amount = $11, tax_amount = $12,
              tax_override = $13,
              base_item_supplier_id = $17,
              supplier_catalog_item_id = $18,
              package_quantity = $19,
              updated_at = now()
        WHERE id = $14 AND purchase_order_id = $15
       RETURNING *,
         (SELECT name FROM base_items WHERE id = $1 AND workspace_owner_id = $16) AS base_item_name,
         (SELECT supplier_item_code FROM supplier_catalog_items WHERE id = supplier_catalog_item_id) AS supplier_item_code,
         (SELECT unit FROM supplier_catalog_items WHERE id = supplier_catalog_item_id) AS supplier_item_unit`,
      [baseItemId, description, descriptionAr, qtyCheck.value, priceCheck.value, currency, rcvCheck.value, vatTreatmentPatch,
       resolvedTaxCategory, appliedTaxRatePatch, taxableAmountPatch, taxAmountPatch, taxOverridePatch,
       lineItemId, poId, wreq.workspaceOwnerId,
       resolvedBisId,
       resolvedScid,
       packageQuantityPatch],
    );

    await recomputePoTotals(txClient, poId);

    await txClient.query("COMMIT");
    updatedRow = result.rows[0];
  } catch (err) {
    await txClient.query("ROLLBACK");
    throw err;
  } finally {
    txClient.release();
  }

  await syncPoStatus(poId);

  const userId = authed(req).userId;
  await db.query(
    `INSERT INTO purchase_order_activity
       (purchase_order_id, workspace_owner_id, event_type, description, metadata)
     VALUES ($1, $2, 'po_line_item_updated', $3, $4)`,
    [
      poId,
      wreq.workspaceOwnerId,
      `Line item "${updatedRow.description}" updated.`,
      JSON.stringify({
        line_item_id: lineItemId,
        description: updatedRow.description,
        before: { quantity: prev.quantity, unit_price: prev.unit_price, currency: prev.currency },
        after: { quantity: updatedRow.quantity, unit_price: updatedRow.unit_price, currency: updatedRow.currency },
        updated_by: userId,
      }),
    ],
  );

  res.json({ line_item: updatedRow });
});

/**
 * DELETE /api/purchase-orders/:id/line-items/:lineItemId
 * Delete a purchase order line item.
 */
router.delete("/purchase-orders/:id/line-items/:lineItemId", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "suppliers.edit")) {
    res.status(403).json({ error: "Insufficient permissions to manage purchase order line items" });
    return;
  }

  const poId = parseInt(req.params.id, 10);
  const lineItemId = parseInt(req.params.lineItemId, 10);
  if (isNaN(poId) || isNaN(lineItemId)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const poCheck = await resolvePoOwner(wreq, poId);
  if (poCheck.rowCount === 0) {
    res.status(404).json({ error: "Purchase order not found" });
    return;
  }

  const existing = await db.query<{ id: number; description: string; quantity: string; unit_price: string; currency: string }>(
    `SELECT id, description, quantity::text, unit_price::text, currency FROM purchase_order_line_items WHERE id = $1 AND purchase_order_id = $2`,
    [lineItemId, poId],
  );
  if (existing.rowCount === 0) {
    res.status(404).json({ error: "Line item not found" });
    return;
  }

  const deletedItem = existing.rows[0];

  const txClient = await db.connect();
  try {
    await txClient.query("BEGIN");
    await txClient.query(`DELETE FROM purchase_order_line_items WHERE id = $1`, [lineItemId]);
    await recomputePoTotals(txClient, poId);
    await txClient.query("COMMIT");
  } catch (err) {
    await txClient.query("ROLLBACK");
    throw err;
  } finally {
    txClient.release();
  }

  const userId = authed(req).userId;
  await db.query(
    `INSERT INTO purchase_order_activity
       (purchase_order_id, workspace_owner_id, event_type, description, metadata)
     VALUES ($1, $2, 'po_line_item_removed', $3, $4)`,
    [
      poId,
      wreq.workspaceOwnerId,
      `Line item "${deletedItem.description}" removed (qty: ${deletedItem.quantity}, unit price: ${deletedItem.unit_price} ${deletedItem.currency}).`,
      JSON.stringify({
        line_item_id: lineItemId,
        description: deletedItem.description,
        quantity: deletedItem.quantity,
        unit_price: deletedItem.unit_price,
        currency: deletedItem.currency,
        removed_by: userId,
      }),
    ],
  );

  res.json({ ok: true });
});

/**
 * POST /api/purchase-orders/:id/receive
 * Receive stock for line items linked to base items.
 * For each receipt entry, adds to base item stock (per location) and records an
 * adjustment with reason="received". Also increments the line item received_quantity.
 */
router.post("/purchase-orders/:id/receive", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "suppliers.edit")) {
    res.status(403).json({ error: "Insufficient permissions to receive purchase orders" });
    return;
  }

  const poId = parseInt(req.params.id, 10);
  if (isNaN(poId)) {
    res.status(400).json({ error: "Invalid purchase order id" });
    return;
  }

  const poCheck = await resolvePoOwner(wreq, poId);
  if (poCheck.rowCount === 0) {
    res.status(404).json({ error: "Purchase order not found" });
    return;
  }

  // Guard: receiving is only allowed after the supplier has accepted the PO.
  const poStatusRow = await db.query<{
    status: string;
    inventory_allow_negative_stock: boolean;
  }>(
    `SELECT po.status,
            COALESCE(ws.inventory_allow_negative_stock, false) AS inventory_allow_negative_stock
       FROM purchase_orders po
       LEFT JOIN workspace_settings ws ON ws.workspace_owner_id = po.workspace_owner_id
      WHERE po.id = $1 AND po.workspace_owner_id = $2`,
    [poId, wreq.workspaceOwnerId],
  );
  const currentPoStatus = poStatusRow.rows[0]?.status ?? "";
  const allowNegativeStock =
    poStatusRow.rows[0]?.inventory_allow_negative_stock === true;
  const RECEIVABLE_STATUSES = ["supplier_accepted", "partial", "received", "completed"];
  if (!RECEIVABLE_STATUSES.includes(currentPoStatus)) {
    res.status(409).json({
      code: "acceptance_required",
      error: `Stock can only be received after the supplier has accepted the purchase order (current status: "${currentPoStatus}")`,
    });
    return;
  }

  const { location_id, receipts, allow_over_receipt, receive_action_id } = req.body ?? {};
  const receiveActionId =
    typeof receive_action_id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(receive_action_id)
      ? receive_action_id
      : null;
  if (!receiveActionId) {
    res.status(400).json({ error: "receive_action_id is required and must be a UUID" });
    return;
  }
  const locationId = parseInt(String(location_id ?? ""), 10);
  if (isNaN(locationId)) {
    res.status(400).json({ error: "location_id is required and must be an integer" });
    return;
  }

  const locationCheck = await db.query<{ id: number; name: string }>(
    `SELECT id, name FROM locations WHERE id = $1 AND workspace_owner_id = $2`,
    [locationId, wreq.workspaceOwnerId],
  );
  if (locationCheck.rowCount === 0) {
    res.status(404).json({ error: "Location not found" });
    return;
  }
  const locationName = locationCheck.rows[0].name;

  if (!Array.isArray(receipts) || receipts.length === 0) {
    res.status(400).json({ error: "receipts must be a non-empty array" });
    return;
  }

  type ReceiptInput = { line_item_id: number; quantity: number };
  const validated: ReceiptInput[] = [];
  const seenLineItemIds = new Set<number>();
  for (let i = 0; i < receipts.length; i++) {
    const r = receipts[i];
    const lineItemId = parseInt(String(r.line_item_id ?? ""), 10);
    if (isNaN(lineItemId)) {
      res.status(400).json({ error: `receipts[${i}].line_item_id must be a valid integer` });
      return;
    }
    if (seenLineItemIds.has(lineItemId)) {
      res.status(400).json({ error: `receipts contains duplicate line_item_id ${lineItemId} — each line item may appear at most once` });
      return;
    }
    seenLineItemIds.add(lineItemId);
    const qty = parseFloat(String(r.quantity ?? ""));
    if (isNaN(qty) || qty <= 0) {
      res.status(400).json({ error: `receipts[${i}].quantity must be a positive number` });
      return;
    }
    validated.push({ line_item_id: lineItemId, quantity: qty });
  }

  const lineItemIds = validated.map((r) => r.line_item_id);
  // Use the snapshotted package_quantity column (stored at line-creation time)
  // so that later BIS edits, package changes, or link removals do not alter the
  // conversion factor applied to historical PO lines.
  const liResult = await db.query<LineItemRow>(
    `SELECT li.*, bi.name AS base_item_name,
            sci.supplier_item_code AS supplier_item_code,
            sci.unit AS supplier_item_unit
       FROM purchase_order_line_items li
       LEFT JOIN base_items bi ON bi.id = li.base_item_id AND bi.workspace_owner_id = $2
       LEFT JOIN supplier_catalog_items sci ON sci.id = li.supplier_catalog_item_id
      WHERE li.id = ANY($1::int[]) AND li.purchase_order_id = $3`,
    [lineItemIds, wreq.workspaceOwnerId, poId],
  );
  const liMap = new Map(liResult.rows.map((li) => [li.id, li]));

  for (const r of validated) {
    const li = liMap.get(r.line_item_id);
    if (!li) {
      res.status(404).json({ error: `Line item ${r.line_item_id} not found in this purchase order` });
      return;
    }
    if (!li.base_item_id) {
      res.status(400).json({ error: `Line item ${r.line_item_id} is not linked to a base item` });
      return;
    }
    if (
      li.package_quantity != null &&
      (!Number.isFinite(Number(li.package_quantity)) || Number(li.package_quantity) <= 0)
    ) {
      res.status(422).json({
        error: `Line item ${r.line_item_id} has an invalid package conversion`,
        code: "INVALID_PACKAGE_CONVERSION",
      });
      return;
    }
  }

  type OverReceiptWarning = {
    line_item_id: number;
    description: string;
    ordered: number;
    already_received: number;
    will_receive: number;
    total_after: number;
  };
  const overReceiptWarnings: OverReceiptWarning[] = [];
  for (const r of validated) {
    const li = liMap.get(r.line_item_id)!;
    const ordered = parseFloat(String(li.quantity)) || 0;
    const alreadyReceived = parseFloat(String(li.received_quantity ?? "0")) || 0;
    const totalAfter = alreadyReceived + r.quantity;
    if (totalAfter > ordered) {
      overReceiptWarnings.push({
        line_item_id: r.line_item_id,
        description: li.description,
        ordered,
        already_received: alreadyReceived,
        will_receive: r.quantity,
        total_after: totalAfter,
      });
    }
  }

  const allowOverReceipt = allow_over_receipt === true || allow_over_receipt === "true";
  // ── Idempotency ──────────────────────────────────────────────────────────
  // receive_action_id: required client-generated UUID per physical receipt
  // payload_hash: SHA-256 of sorted line items (guards against same UUID / different payload)
  const payloadHash = createHash("sha256")
    .update(JSON.stringify({
      purchaseOrderId: poId,
      locationId,
      allowOverReceipt,
      receipts: validated
        .slice()
        .sort((a, b) => a.line_item_id - b.line_item_id)
        .map((r) => ({ lineItemId: r.line_item_id, quantity: r.quantity })),
    }))
    .digest("hex");

  const userId = authed(req).userId;
  const client = await db.connect();

  type ReceiveResult = {
    line_item_id: number;
    base_item_id: number;
    base_item_name: string | null;
    quantity_received: number;
    stock_after: number;
  };
  const results: ReceiveResult[] = [];
  let committedWarnings = overReceiptWarnings;
  let receiptEventId: string | null = null;

  try {
    await client.query("BEGIN");

    const lockedPo = await client.query<{ status: string }>(
      `SELECT status
         FROM purchase_orders
        WHERE id = $1
          AND workspace_owner_id = $2
        FOR UPDATE`,
      [poId, wreq.workspaceOwnerId],
    );
    if (
      lockedPo.rowCount === 0 ||
      !RECEIVABLE_STATUSES.includes(lockedPo.rows[0].status)
    ) {
      await client.query("ROLLBACK");
      res.status(409).json({
        code: "acceptance_required",
        error:
          lockedPo.rowCount === 0
            ? "Purchase order no longer exists"
            : `Stock can only be received after the supplier has accepted the purchase order (current status: "${lockedPo.rows[0].status}")`,
      });
      return;
    }

    // Claim the physical receipt before any stock/quantity changes. Concurrent
    // retries block on the unique action key and then return the committed event.
    const claimedEvent = await client.query<{ id: string }>(
      `INSERT INTO purchase_order_receipt_events
         (workspace_owner_id, purchase_order_id, location_id, receive_action_id,
          payload_hash, received_by_user_id, received_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (workspace_owner_id, receive_action_id)
         WHERE receive_action_id IS NOT NULL DO NOTHING
       RETURNING id::text`,
      [wreq.workspaceOwnerId, poId, locationId, receiveActionId, payloadHash, userId],
    );
    if (claimedEvent.rowCount === 0) {
      const existingEvent = await client.query<{ id: string; payload_hash: string }>(
        `SELECT id::text, payload_hash
           FROM purchase_order_receipt_events
          WHERE workspace_owner_id = $1 AND receive_action_id = $2`,
        [wreq.workspaceOwnerId, receiveActionId],
      );
      const ev = existingEvent.rows[0];
      await client.query("ROLLBACK");
      if (!ev || ev.payload_hash !== payloadHash) {
        res.status(409).json({
          error: "receive_action_id already used with a different payload",
          event_id: ev?.id,
        });
        return;
      }
      res.json({
        received: [],
        location_name: locationName,
        idempotent: true,
        event_id: ev.id,
      });
      return;
    }
    receiptEventId = claimedEvent.rows[0].id;

    // Re-read and lock receipt counters in the transaction. Preflight values
    // may have changed since request validation.
    const lockedLines = await client.query<{
      id: number;
      quantity: string;
      received_quantity: string | null;
    }>(
      `SELECT id, quantity::text, received_quantity::text
         FROM purchase_order_line_items
        WHERE purchase_order_id = $1 AND id = ANY($2::int[])
        ORDER BY id
        FOR UPDATE`,
      [poId, lineItemIds],
    );
    if (lockedLines.rowCount !== validated.length) {
      await client.query("ROLLBACK");
      res.status(409).json({ error: "One or more purchase order lines changed while receiving" });
      return;
    }
    const lockedLineMap = new Map(lockedLines.rows.map((line) => [line.id, line]));
    committedWarnings = [];
    for (const r of validated) {
      const li = liMap.get(r.line_item_id)!;
      const locked = lockedLineMap.get(r.line_item_id)!;
      const ordered = parseFloat(locked.quantity) || 0;
      const alreadyReceived = parseFloat(locked.received_quantity ?? "0") || 0;
      const totalAfter = alreadyReceived + r.quantity;
      if (totalAfter > ordered) {
        committedWarnings.push({
          line_item_id: r.line_item_id,
          description: li.description,
          ordered,
          already_received: alreadyReceived,
          will_receive: r.quantity,
          total_after: totalAfter,
        });
      }
    }
    if (committedWarnings.length > 0 && !allowOverReceipt) {
      await client.query("ROLLBACK");
      res.status(422).json({
        error: "Receiving this quantity would exceed the ordered amount for one or more line items",
        over_receipt_warnings: committedWarnings,
      });
      return;
    }

    for (const r of validated) {
      const li = liMap.get(r.line_item_id)!;
      const baseItemId = li.base_item_id!;

      // UOM/package conversion: when the line item is sourced from a base_item_suppliers
      // row that has a package (e.g. "box of 20"), the received quantity (in boxes) is
      // multiplied by the package quantity (20) to get the inventory delta (in base units).
      const packageQty = li.package_quantity != null ? parseFloat(String(li.package_quantity)) : null;
      const inventoryDelta = r.quantity * (packageQty != null && !isNaN(packageQty) ? packageQty : 1);

      const idempotencyKey = `po-receive:${receiveActionId}:li:${r.line_item_id}`;

      await postMovement(client, {
        workspaceOwnerId: wreq.workspaceOwnerId,
        baseItemId,
        locationId,
        quantityChange: inventoryDelta,
        reason: `PO ${poLabel(poId)}`,
        movementType: "purchase_order_receipt",
        createdByUserId: userId,
        purchaseOrderId: poId,
        idempotencyKey,
        inventoryAllowNegativeStock: allowNegativeStock,
        actorType: "user",
        actorId: userId,
        sourceType: "purchase_order_receipt",
        sourceId: receiptEventId,
        sourceLabelSnapshot: `${poLabel(poId)} receipt at ${locationName}`,
        referenceType: "purchase_order",
        referenceId: String(poId),
        referenceLabelSnapshot: poLabel(poId),
        metadataSnapshot: {
          receiptEventId,
          receiveActionId,
          purchaseOrderLineItemId: r.line_item_id,
          supplierQuantity: r.quantity,
          packageQuantity: packageQty,
          canonicalQuantity: inventoryDelta,
        },
      });

      const stockRow = await client.query<{ stock: string }>(
        `SELECT COALESCE(stock, 0)::text AS stock
           FROM base_item_location_statuses
          WHERE base_item_id = $1 AND location_id = $2`,
        [baseItemId, locationId],
      );
      const locationStockAfter = stockRow.rowCount! > 0 ? parseFloat(stockRow.rows[0].stock) : 0;

      const totalResult = await client.query<{ total: string }>(
        `SELECT COALESCE(SUM(stock), 0)::text AS total
           FROM base_item_location_statuses
          WHERE base_item_id = $1 AND is_active = true`,
        [baseItemId],
      );
      const totalStock = parseFloat(totalResult.rows[0].total);

      await client.query(
        `UPDATE purchase_order_line_items
            SET received_quantity = COALESCE(received_quantity, 0) + $1, updated_at = now()
          WHERE id = $2`,
        [r.quantity, r.line_item_id],
      );

      if (li.supplier_catalog_item_id != null) {
        await client.query(
          `UPDATE supplier_catalog_items
              SET current_stock = COALESCE(current_stock, 0) + $1
            WHERE id = $2 AND workspace_owner_id = $3`,
          [r.quantity, li.supplier_catalog_item_id, wreq.workspaceOwnerId],
        );
      }

      results.push({
        line_item_id: r.line_item_id,
        base_item_id: baseItemId,
        base_item_name: li.base_item_name,
        quantity_received: r.quantity,
        stock_after: totalStock,
      });
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  await syncPoStatus(poId);

  const totalQtyReceived = results.reduce((sum, r) => sum + r.quantity_received, 0);
  const itemSummary = results
    .map((r) => `${r.quantity_received}× ${r.base_item_name ?? `item #${r.base_item_id}`}`)
    .join(", ");
  await db.query(
    `INSERT INTO purchase_order_activity
       (purchase_order_id, workspace_owner_id, event_type, description, metadata)
     VALUES ($1, $2, 'po_received', $3, $4)`,
    [
      poId,
      wreq.workspaceOwnerId,
      `Stock received at ${locationName}: ${itemSummary} (total ${totalQtyReceived} units).`,
      JSON.stringify({
        location_id: locationId,
        location_name: locationName,
        received_by: userId,
        items: results.map((r) => ({
          line_item_id: r.line_item_id,
          base_item_id: r.base_item_id,
          base_item_name: r.base_item_name,
          quantity_received: r.quantity_received,
          stock_after: r.stock_after,
        })),
      }),
    ],
  );

  res.json({
    received: results,
    location_name: locationName,
    event_id: receiptEventId,
    ...(committedWarnings.length > 0 ? { warnings: committedWarnings } : {}),
  });
});

// ---------------------------------------------------------------------------
// Receive History
// ---------------------------------------------------------------------------

/**
 * GET /api/purchase-orders/:id/receive-history
 * List all stock adjustments recorded against this purchase order.
 */
router.get("/purchase-orders/:id/receive-history", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid purchase order id" });
    return;
  }

  const poCheck = await db.query<{ id: number }>(
    `SELECT id FROM purchase_orders WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (poCheck.rowCount === 0) {
    res.status(404).json({ error: "Purchase order not found" });
    return;
  }

  const result = await db.query<{
    id: number;
    base_item_id: number;
    base_item_name: string | null;
    quantity_change: string;
    stock_after: string;
    location_id: number | null;
    location_name: string | null;
    note: string | null;
    created_at: string;
  }>(
    `SELECT a.id,
            a.base_item_id,
            bi.name AS base_item_name,
            a.quantity_change::text,
            a.stock_after::text,
            a.location_id,
            l.name AS location_name,
            a.note,
            a.created_at
       FROM base_item_stock_adjustments a
       LEFT JOIN base_items bi ON bi.id = a.base_item_id AND bi.workspace_owner_id = a.workspace_owner_id
       LEFT JOIN locations l ON l.id = a.location_id
      WHERE a.purchase_order_id = $1 AND a.workspace_owner_id = $2
      ORDER BY a.created_at ASC`,
    [id, wreq.workspaceOwnerId],
  );

  const history = result.rows.map((r) => ({
    ...r,
    quantity_change: parseFloat(r.quantity_change),
    stock_after: parseFloat(r.stock_after),
  }));

  res.json({ history });
});

// ---------------------------------------------------------------------------
// Line-item stock preview (for Receive Stock dialog)
// ---------------------------------------------------------------------------

/**
 * GET /api/purchase-orders/:id/line-item-stocks?location_id=N
 * Returns current stock + low_stock_threshold for each base-item-linked line
 * item at the given location. Used by the Receive Stock dialog to show the
 * projected stock impact before confirming.
 */
router.get("/purchase-orders/:id/line-item-stocks", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid purchase order id" });
    return;
  }

  const locationId = req.query.location_id ? parseInt(String(req.query.location_id), 10) : null;
  if (locationId == null || isNaN(locationId)) {
    res.status(400).json({ error: "location_id query parameter is required" });
    return;
  }

  const poCheck = await db.query<{ id: number }>(
    `SELECT id FROM purchase_orders WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (poCheck.rowCount === 0) {
    res.status(404).json({ error: "Purchase order not found" });
    return;
  }

  const result = await db.query<{
    line_item_id: number;
    base_item_id: number;
    base_item_name: string | null;
    current_stock: string;
    low_stock_threshold: string;
  }>(
    `SELECT poli.id AS line_item_id,
            poli.base_item_id,
            bi.name AS base_item_name,
            COALESCE(bils.stock, 0)::text AS current_stock,
            COALESCE(bils.low_stock_threshold, 0)::text AS low_stock_threshold
       FROM purchase_order_line_items poli
       JOIN base_items bi ON bi.id = poli.base_item_id AND bi.workspace_owner_id = $3
       LEFT JOIN base_item_location_statuses bils
         ON bils.base_item_id = poli.base_item_id AND bils.location_id = $2
      WHERE poli.purchase_order_id = $1 AND poli.base_item_id IS NOT NULL`,
    [id, locationId, wreq.workspaceOwnerId],
  );

  const stocks = result.rows.map((r) => ({
    line_item_id: r.line_item_id,
    base_item_id: r.base_item_id,
    base_item_name: r.base_item_name,
    current_stock: parseFloat(r.current_stock),
    low_stock_threshold: parseFloat(r.low_stock_threshold),
  }));

  res.json({ stocks });
});

// ---------------------------------------------------------------------------
// PDF Export
// ---------------------------------------------------------------------------

/**
 * GET /api/purchase-orders/:id/pdf
 * Download a formatted PDF copy of the purchase order.
 */
router.get("/purchase-orders/:id/pdf", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid purchase order id" });
    return;
  }

  const languageRaw = req.query.language ? String(req.query.language) : "en";
  const language: "en" | "ar" = languageRaw === "ar" ? "ar" : "en";

  const chromiumPath = resolveChromiumPath();
  (req.log ?? logger).info({ chromiumPath: chromiumPath ?? "(none — will use playwright default or fail)" }, "PO PDF: resolved Chromium path");

  try {
    const poResult = await db.query<PurchaseOrderRow>(
      `SELECT po.*,
              s.name AS supplier_name,
              loc.name AS location_name,
              COALESCE(po.total_amount::text, (SELECT SUM(l.quantity::numeric * l.unit_price::numeric) FROM purchase_order_line_items l WHERE l.purchase_order_id = po.id)::text) AS effective_total,
              (SELECT SUM(l.quantity::numeric * l.unit_price::numeric) FROM purchase_order_line_items l WHERE l.purchase_order_id = po.id)::text AS calculated_total
         FROM purchase_orders po
         LEFT JOIN suppliers s ON s.id = po.supplier_id AND s.workspace_owner_id = po.workspace_owner_id
         LEFT JOIN locations loc ON loc.id = po.location_id
        WHERE po.id = $1 AND po.workspace_owner_id = $2`,
      [id, wreq.workspaceOwnerId],
    );

    if (poResult.rowCount === 0) {
      res.status(404).json({ error: "Purchase order not found" });
      return;
    }

    const po = poResult.rows[0];
    const poNumberLabel = po.po_number ?? poLabel(po.id);

    const lineItemsResult = await db.query<LineItemRow & { base_item_image_url: string | null }>(
      `SELECT li.*, bi.name AS base_item_name,
              bi.image_url AS base_item_image_url,
              sci.supplier_item_code AS supplier_item_code,
              sci.unit AS supplier_item_unit
         FROM purchase_order_line_items li
         LEFT JOIN base_items bi ON bi.id = li.base_item_id AND bi.workspace_owner_id = $2
         LEFT JOIN supplier_catalog_items sci ON sci.id = li.supplier_catalog_item_id
        WHERE li.purchase_order_id = $1
        ORDER BY li.id ASC`,
      [id, wreq.workspaceOwnerId],
    );

    const lineItems = lineItemsResult.rows;

    const displayTotal = po.effective_total ?? po.total_amount;
    const totalLabel = displayTotal
      ? `${po.currency} ${parseFloat(displayTotal).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : "—";
    const deliveryLabel = po.expected_delivery_date
      ? new Date(po.expected_delivery_date).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
      : "Not specified";
    const supplierName = po.supplier_name ?? `Supplier #${po.supplier_id}`;
    const createdLabel = new Date(po.created_at).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    const createdByName = await resolveClerkName(po.created_by_clerk_id);

    const resolvedImages = await resolvePoPdfLineItemImages(
      lineItems.map((li) => ({ imageUrl: li.base_item_image_url })),
    );

    const pdfLineItems: PoPdfLineItem[] = lineItems.map((li, idx) => ({
      description: li.description,
      descriptionAr: li.description_ar,
      baseItemName: li.base_item_name,
      supplierItemCode: li.supplier_item_code,
      quantity: li.quantity,
      unitPrice: li.unit_price,
      currency: li.currency,
      taxCategory: li.tax_category,
      appliedTaxRate: li.applied_tax_rate,
      taxAmount: li.tax_amount,
      imageUrl: resolvedImages[idx],
    }));

    const calculatedTotal = po.calculated_total != null ? parseFloat(po.calculated_total) : null;

    const pdfBuffer = await buildPurchaseOrderPdf({
      poNumberLabel,
      status: po.status,
      supplierName,
      locationName: po.location_name,
      totalLabel,
      calculatedTotal,
      currency: po.currency,
      effectiveTotal: po.effective_total,
      expectedDeliveryLabel: deliveryLabel,
      createdLabel,
      createdByName,
      paymentTerms: po.payment_terms,
      supplierReference: po.supplier_reference,
      notes: po.notes,
      costSummary: {
        subtotalAmount: po.subtotal_amount,
        discountAmount: po.discount_amount,
        deliveryFeeAmount: po.delivery_fee_amount,
        vatTreatment: po.vat_treatment,
        vatRate: po.vat_rate,
        vatAmount: po.vat_amount,
        vatManualOverride: po.vat_manual_override,
        grandTotalAmount: po.grand_total_amount,
      },
      lineItems: pdfLineItems,
    }, language);

    const langSuffix = language === "ar" ? "AR" : "EN";
    const safeFilename = `PO-${poNumberLabel.replace(/[^a-zA-Z0-9_-]/g, "_")}-${langSuffix}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${safeFilename}"`);
    res.send(pdfBuffer);
  } catch (err) {
    const ref = `PO_PDF_${id}_${Date.now()}`;
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    (req.log ?? logger).error({ ref, poId: id, message, stack }, "PO PDF generation failed");
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to generate PDF", ref });
    } else {
      res.destroy();
    }
  }
});

/**
 * GET /api/purchase-orders/:id/activity
 * List activity log entries for a purchase order.
 */
router.get("/purchase-orders/:id/activity", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid purchase order id" });
    return;
  }

  const poCheck = await db.query(
    `SELECT id FROM purchase_orders WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (poCheck.rowCount === 0) {
    res.status(404).json({ error: "Purchase order not found" });
    return;
  }

  type ActivityRow = {
    id: number;
    purchase_order_id: number;
    event_type: string;
    description: string | null;
    metadata: unknown;
    created_at: string;
  };

  const result = await db.query<ActivityRow>(
    `SELECT id, purchase_order_id, event_type, description, metadata, created_at
       FROM purchase_order_activity
      WHERE purchase_order_id = $1
      ORDER BY created_at DESC`,
    [id],
  );

  const ACTOR_FIELDS = ["sent_by", "received_by", "changed_by", "updated_by", "added_by", "removed_by", "deleted_by", "created_by"] as const;

  const userIdSet = new Set<string>();
  for (const row of result.rows) {
    const meta = row.metadata as Record<string, unknown> | null | undefined;
    if (meta && typeof meta === "object") {
      for (const field of ACTOR_FIELDS) {
        const val = meta[field];
        if (typeof val === "string" && val.startsWith("user_")) {
          userIdSet.add(val);
        }
      }
    }
  }

  const nameMap = await fetchClerkNames([...userIdSet]);

  const activity = result.rows.map((row) => {
    const meta = row.metadata as Record<string, unknown> | null | undefined;
    let actorId: string | null = null;
    if (meta && typeof meta === "object") {
      for (const field of ACTOR_FIELDS) {
        const val = meta[field];
        if (typeof val === "string" && val.startsWith("user_")) {
          actorId = val;
          break;
        }
      }
    }
    return {
      ...row,
      actor_name: actorId ? (nameMap.get(actorId) ?? null) : null,
    };
  });

  res.json({ activity });
});

/**
 * Helper: recompute and persist invoice_coverage_status for a purchase order.
 */
async function recomputeInvoiceCoverageStatus(
  purchaseOrderId: number,
  workspaceOwnerId: string,
): Promise<string> {
  const poResult = await db.query<{
    grand_total_amount: string | null;
    currency: string;
    effective_total: string | null;
  }>(
    `SELECT po.grand_total_amount, po.currency,
            COALESCE(po.total_amount::text, (SELECT SUM(l.quantity::numeric * l.unit_price::numeric) FROM purchase_order_line_items l WHERE l.purchase_order_id = po.id)::text) AS effective_total
     FROM purchase_orders po WHERE po.id = $1 AND po.workspace_owner_id = $2`,
    [purchaseOrderId, workspaceOwnerId],
  );
  if (poResult.rowCount === 0) return "awaiting_invoice";
  const po = poResult.rows[0];

  const liResult = await db.query<{
    quantity: string;
    unit_price: string;
    received_quantity: string | null;
  }>(
    `SELECT quantity, unit_price, received_quantity FROM purchase_order_line_items WHERE purchase_order_id = $1`,
    [purchaseOrderId],
  );

  const invResult = await db.query<{
    grand_total: string | null;
    amount: string;
    currency: string;
    payment_status: string;
  }>(
    `SELECT si.grand_total, si.amount, si.currency, si.payment_status
     FROM purchase_order_invoices poi
     JOIN supplier_invoices si ON si.id = poi.supplier_invoice_id
     WHERE poi.purchase_order_id = $1`,
    [purchaseOrderId],
  );

  const matchResult = computeThreeWayMatch(po, liResult.rows, invResult.rows);

  await db.query(
    `UPDATE purchase_orders SET invoice_coverage_status = $1, updated_at = now() WHERE id = $2 AND workspace_owner_id = $3`,
    [matchResult.overallStatus, purchaseOrderId, workspaceOwnerId],
  );

  return matchResult.overallStatus;
}

/**
 * GET /api/purchase-orders/:id/invoices
 * List supplier invoices linked to this purchase order.
 */
router.get("/purchase-orders/:id/invoices", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid purchase order id" });
    return;
  }

  const poCheck = await db.query(
    `SELECT id FROM purchase_orders WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (poCheck.rowCount === 0) {
    res.status(404).json({ error: "Purchase order not found" });
    return;
  }

  type LinkedInvoiceRow = {
    poi_id: number;
    supplier_invoice_id: number;
    linked_at: string;
    linked_by: string | null;
    link_notes: string | null;
    invoice_number: string | null;
    issued_at: string;
    due_date: string | null;
    amount: string;
    currency: string;
    status: string;
    payment_status: string;
    grand_total: string | null;
    vat_amount: string | null;
    delivery_charge: string | null;
    discount: string | null;
    notes: string | null;
    supplier_id: number;
    supplier_name: string | null;
  };

  const result = await db.query<LinkedInvoiceRow>(
    `SELECT poi.id AS poi_id, poi.supplier_invoice_id, poi.linked_at, poi.linked_by, poi.notes AS link_notes,
            si.invoice_number, si.issued_at, si.due_date,
            si.amount, si.currency, si.status, si.payment_status,
            si.grand_total, si.vat_amount, si.delivery_charge, si.discount, si.notes,
            si.supplier_id, s.name AS supplier_name
     FROM purchase_order_invoices poi
     JOIN supplier_invoices si ON si.id = poi.supplier_invoice_id
     LEFT JOIN suppliers s ON s.id = si.supplier_id
     WHERE poi.purchase_order_id = $1
     ORDER BY poi.linked_at DESC`,
    [id],
  );

  res.json({ linked_invoices: result.rows });
});

/**
 * POST /api/purchase-orders/:id/invoices
 * Link an existing supplier invoice to this purchase order.
 */
router.post("/purchase-orders/:id/invoices", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "suppliers.edit")) {
    res.status(403).json({ error: "Insufficient permissions to link invoices" });
    return;
  }

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid purchase order id" });
    return;
  }

  const poCheck = await db.query(
    `SELECT id FROM purchase_orders WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (poCheck.rowCount === 0) {
    res.status(404).json({ error: "Purchase order not found" });
    return;
  }

  const body = req.body ?? {};
  const supplierInvoiceId = typeof body.supplier_invoice_id === "number"
    ? body.supplier_invoice_id
    : (body.supplier_invoice_id ? parseInt(String(body.supplier_invoice_id), 10) : NaN);

  if (!supplierInvoiceId || isNaN(supplierInvoiceId)) {
    res.status(400).json({ error: "supplier_invoice_id is required and must be a number" });
    return;
  }

  const invCheck = await db.query(
    `SELECT id FROM supplier_invoices WHERE id = $1 AND workspace_owner_id = $2`,
    [supplierInvoiceId, wreq.workspaceOwnerId],
  );
  if (invCheck.rowCount === 0) {
    res.status(404).json({ error: "Supplier invoice not found" });
    return;
  }

  const userId = authed(req).userId;
  const linkNotes = body.notes ? String(body.notes).trim() || null : null;

  try {
    await db.query(
      `INSERT INTO purchase_order_invoices (purchase_order_id, supplier_invoice_id, linked_by, notes)
       VALUES ($1, $2, $3, $4)`,
      [id, supplierInvoiceId, userId, linkNotes],
    );
  } catch (err: unknown) {
    const pgErr = err as { code?: string };
    if (pgErr?.code === "23505") {
      res.status(409).json({ error: "Invoice is already linked to this purchase order" });
      return;
    }
    throw err;
  }

  await db.query(
    `INSERT INTO purchase_order_activity (purchase_order_id, workspace_owner_id, event_type, description, metadata)
     VALUES ($1, $2, 'po_invoice_linked', 'Invoice linked', $3)`,
    [id, wreq.workspaceOwnerId, JSON.stringify({ linked_by: userId, supplier_invoice_id: supplierInvoiceId })],
  );

  await recomputeInvoiceCoverageStatus(id, wreq.workspaceOwnerId);

  res.status(201).json({ ok: true });
});

/**
 * DELETE /api/purchase-orders/:id/invoices/:invoiceId
 * Unlink a supplier invoice from this purchase order.
 */
router.delete("/purchase-orders/:id/invoices/:invoiceId", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "suppliers.edit")) {
    res.status(403).json({ error: "Insufficient permissions to unlink invoices" });
    return;
  }

  const id = parseInt(req.params.id, 10);
  const invoiceId = parseInt(req.params.invoiceId, 10);
  if (isNaN(id) || isNaN(invoiceId)) {
    res.status(400).json({ error: "Invalid purchase order or invoice id" });
    return;
  }

  const poCheck = await db.query(
    `SELECT id FROM purchase_orders WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if (poCheck.rowCount === 0) {
    res.status(404).json({ error: "Purchase order not found" });
    return;
  }

  const deleteResult = await db.query(
    `DELETE FROM purchase_order_invoices WHERE purchase_order_id = $1 AND supplier_invoice_id = $2`,
    [id, invoiceId],
  );

  if (deleteResult.rowCount === 0) {
    res.status(404).json({ error: "Invoice link not found" });
    return;
  }

  const userId = authed(req).userId;

  await db.query(
    `INSERT INTO purchase_order_activity (purchase_order_id, workspace_owner_id, event_type, description, metadata)
     VALUES ($1, $2, 'po_invoice_unlinked', 'Invoice unlinked', $3)`,
    [id, wreq.workspaceOwnerId, JSON.stringify({ unlinked_by: userId, supplier_invoice_id: invoiceId })],
  );

  await recomputeInvoiceCoverageStatus(id, wreq.workspaceOwnerId);

  res.json({ ok: true });
});

/**
 * GET /api/purchase-orders/:id/match
 * Compute three-way match result for a purchase order (and persist status).
 */
router.get("/purchase-orders/:id/match", async (req, res) => {
  const wreq = workspace(req);
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid purchase order id" });
    return;
  }

  const poResult = await db.query<{
    grand_total_amount: string | null;
    currency: string;
    effective_total: string | null;
  }>(
    `SELECT po.grand_total_amount, po.currency,
            COALESCE(po.total_amount::text, (SELECT SUM(l.quantity::numeric * l.unit_price::numeric) FROM purchase_order_line_items l WHERE l.purchase_order_id = po.id)::text) AS effective_total
     FROM purchase_orders po WHERE po.id = $1 AND po.workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );

  if (poResult.rowCount === 0) {
    res.status(404).json({ error: "Purchase order not found" });
    return;
  }

  const po = poResult.rows[0];

  const liResult = await db.query<{
    quantity: string;
    unit_price: string;
    received_quantity: string | null;
  }>(
    `SELECT quantity, unit_price, received_quantity FROM purchase_order_line_items WHERE purchase_order_id = $1`,
    [id],
  );

  const invResult = await db.query<{
    grand_total: string | null;
    amount: string;
    currency: string;
    payment_status: string;
  }>(
    `SELECT si.grand_total, si.amount, si.currency, si.payment_status
     FROM purchase_order_invoices poi
     JOIN supplier_invoices si ON si.id = poi.supplier_invoice_id
     WHERE poi.purchase_order_id = $1`,
    [id],
  );

  const matchResult = computeThreeWayMatch(po, liResult.rows, invResult.rows);

  await db.query(
    `UPDATE purchase_orders SET invoice_coverage_status = $1, updated_at = now() WHERE id = $2 AND workspace_owner_id = $3`,
    [matchResult.overallStatus, id, wreq.workspaceOwnerId],
  );

  res.json(matchResult);
});

// ---------------------------------------------------------------------------
// Assignee management
// ---------------------------------------------------------------------------

/**
 * PUT /api/purchase-orders/:id/assignees
 * Replace the full set of assignees for a purchase order.
 */
router.put("/purchase-orders/:id/assignees", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "suppliers.edit")) {
    res.status(403).json({ error: "Insufficient permissions" });
    return;
  }

  const poId = parseInt(req.params.id, 10);
  if (isNaN(poId)) {
    res.status(400).json({ error: "Invalid purchase order id" });
    return;
  }

  const poCheck = await resolvePoOwner(wreq, poId);
  if (poCheck.rowCount === 0) {
    res.status(404).json({ error: "Purchase order not found" });
    return;
  }

  const { member_user_ids } = req.body ?? {};
  if (!Array.isArray(member_user_ids)) {
    res.status(400).json({ error: "member_user_ids must be an array" });
    return;
  }

  const userIds: string[] = (member_user_ids as unknown[])
    .filter((id): id is string => typeof id === "string" && id.trim().length > 0);

  if (userIds.length > 0) {
    const memberCheck = await db.query<{ member_user_id: string }>(
      `SELECT member_user_id FROM workspace_members WHERE workspace_owner_id = $1 AND member_user_id = ANY($2::text[])`,
      [wreq.workspaceOwnerId, userIds],
    );
    if ((memberCheck.rowCount ?? 0) < userIds.length) {
      res.status(400).json({ error: "One or more user IDs are not valid workspace members" });
      return;
    }
  }

  await db.query(`DELETE FROM purchase_order_assignees WHERE purchase_order_id = $1`, [poId]);
  for (const uid of userIds) {
    await db.query(
      `INSERT INTO purchase_order_assignees (purchase_order_id, member_user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [poId, uid],
    );
  }

  const updatedResult = await db.query<{ member_user_id: string; email: string | null }>(
    `SELECT poa.member_user_id, wm.member_email AS email
       FROM purchase_order_assignees poa
       LEFT JOIN workspace_members wm ON wm.member_user_id = poa.member_user_id AND wm.workspace_owner_id = $2
      WHERE poa.purchase_order_id = $1
      ORDER BY poa.assigned_at`,
    [poId, wreq.workspaceOwnerId],
  );

  const nameMap = userIds.length > 0 ? await fetchClerkNames(userIds) : new Map<string, string>();
  const assignees = updatedResult.rows.map((r) => ({
    member_user_id: r.member_user_id,
    name: nameMap.get(r.member_user_id) ?? r.email ?? r.member_user_id,
    email: r.email ?? null,
  }));

  res.json({ assignees });
});

/**
 * PATCH /api/purchase-orders/:id/invoice-status
 * Update the invoice status of a purchase order.
 */
router.patch("/purchase-orders/:id/invoice-status", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "suppliers.edit")) {
    res.status(403).json({ error: "Insufficient permissions" });
    return;
  }

  const poId = parseInt(req.params.id, 10);
  if (isNaN(poId)) {
    res.status(400).json({ error: "Invalid purchase order id" });
    return;
  }

  const poCheck = await resolvePoOwner(wreq, poId);
  if (poCheck.rowCount === 0) {
    res.status(404).json({ error: "Purchase order not found" });
    return;
  }

  const { status } = req.body ?? {};
  const ALLOWED_INVOICE_STATUSES = ["not_attached", "attached", "missing", "matched"];
  if (!status || !ALLOWED_INVOICE_STATUSES.includes(String(status))) {
    res.status(400).json({ error: `status must be one of: ${ALLOWED_INVOICE_STATUSES.join(", ")}` });
    return;
  }

  await db.query(
    `UPDATE purchase_orders SET invoice_status = $1, updated_at = now() WHERE id = $2`,
    [String(status), poId],
  );

  res.json({ ok: true, invoice_status: String(status) });
});

// ---------------------------------------------------------------------------
// Supplier default assignees
// ---------------------------------------------------------------------------

/**
 * GET /api/suppliers/:id/default-assignees
 * Get the default assignees configured for a supplier.
 */
router.get("/suppliers/:id/default-assignees", async (req, res) => {
  const wreq = workspace(req);
  const supplierId = parseInt(req.params.id, 10);
  if (isNaN(supplierId)) {
    res.status(400).json({ error: "Invalid supplier id" });
    return;
  }

  const supplierCheck = await db.query(
    `SELECT id FROM suppliers WHERE id = $1 AND workspace_owner_id = $2`,
    [supplierId, wreq.workspaceOwnerId],
  );
  if (supplierCheck.rowCount === 0) {
    res.status(404).json({ error: "Supplier not found" });
    return;
  }

  const result = await db.query<{ member_user_id: string; email: string | null }>(
    `SELECT sda.member_user_id, wm.member_email AS email
       FROM supplier_default_assignees sda
       LEFT JOIN workspace_members wm ON wm.member_user_id = sda.member_user_id AND wm.workspace_owner_id = $2
      WHERE sda.supplier_id = $1
      ORDER BY sda.created_at`,
    [supplierId, wreq.workspaceOwnerId],
  );

  const userIds = result.rows.map((r) => r.member_user_id);
  const nameMap = userIds.length > 0 ? await fetchClerkNames(userIds) : new Map<string, string>();
  const assignees = result.rows.map((r) => ({
    member_user_id: r.member_user_id,
    name: nameMap.get(r.member_user_id) ?? r.email ?? r.member_user_id,
    email: r.email ?? null,
  }));

  res.json({ assignees });
});

/**
 * PUT /api/suppliers/:id/default-assignees
 * Replace the default assignees for a supplier.
 */
router.put("/suppliers/:id/default-assignees", async (req, res) => {
  const wreq = workspace(req);
  if (!hasPermission(wreq, "suppliers.edit")) {
    res.status(403).json({ error: "Insufficient permissions" });
    return;
  }

  const supplierId = parseInt(req.params.id, 10);
  if (isNaN(supplierId)) {
    res.status(400).json({ error: "Invalid supplier id" });
    return;
  }

  const supplierCheck = await db.query(
    `SELECT id FROM suppliers WHERE id = $1 AND workspace_owner_id = $2`,
    [supplierId, wreq.workspaceOwnerId],
  );
  if (supplierCheck.rowCount === 0) {
    res.status(404).json({ error: "Supplier not found" });
    return;
  }

  const { member_user_ids } = req.body ?? {};
  if (!Array.isArray(member_user_ids)) {
    res.status(400).json({ error: "member_user_ids must be an array" });
    return;
  }

  const userIds: string[] = (member_user_ids as unknown[])
    .filter((id): id is string => typeof id === "string" && id.trim().length > 0);

  if (userIds.length > 0) {
    const memberCheck = await db.query<{ member_user_id: string }>(
      `SELECT member_user_id FROM workspace_members WHERE workspace_owner_id = $1 AND member_user_id = ANY($2::text[])`,
      [wreq.workspaceOwnerId, userIds],
    );
    if ((memberCheck.rowCount ?? 0) < userIds.length) {
      res.status(400).json({ error: "One or more user IDs are not valid workspace members" });
      return;
    }
  }

  await db.query(
    `DELETE FROM supplier_default_assignees WHERE supplier_id = $1 AND workspace_owner_id = $2`,
    [supplierId, wreq.workspaceOwnerId],
  );
  for (const uid of userIds) {
    await db.query(
      `INSERT INTO supplier_default_assignees (supplier_id, workspace_owner_id, member_user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [supplierId, wreq.workspaceOwnerId, uid],
    );
  }

  const updatedResult = await db.query<{ member_user_id: string; email: string | null }>(
    `SELECT sda.member_user_id, wm.member_email AS email
       FROM supplier_default_assignees sda
       LEFT JOIN workspace_members wm ON wm.member_user_id = sda.member_user_id AND wm.workspace_owner_id = $2
      WHERE sda.supplier_id = $1
      ORDER BY sda.created_at`,
    [supplierId, wreq.workspaceOwnerId],
  );

  const nameMap2 = userIds.length > 0 ? await fetchClerkNames(userIds) : new Map<string, string>();
  const assignees = updatedResult.rows.map((r) => ({
    member_user_id: r.member_user_id,
    name: nameMap2.get(r.member_user_id) ?? r.email ?? r.member_user_id,
    email: r.email ?? null,
  }));

  res.json({ assignees });
});

export default router;
