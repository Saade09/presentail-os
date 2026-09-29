import { Router, type Request, type Response } from "express";
import multer from "multer";
import { randomUUID } from "crypto";
import { db } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace, type WorkspaceRequest } from "../lib/workspace";
import { logger } from "../lib/logger";
import { objectStorageClient } from "../lib/objectStorage";
import { generateWorkshopSaleOrderNumber } from "../lib/workshopSaleOrderNumber";
import {
  buildWorkshopSaleReceiptPdf,
  type WorkshopSaleReceiptData,
} from "../lib/workshopSaleReceipt";
import { sendWorkshopSaleReceiptEmail } from "../lib/email";
import { recordCashTransaction } from "../lib/cashDesk";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

router.use(requireAuth, resolveWorkspace);

// ---------------------------------------------------------------------------
// Permission helpers
// ---------------------------------------------------------------------------

function can(wreq: WorkspaceRequest, key: string): boolean {
  return wreq.workspaceRole === "owner" || !!wreq.allowedPages?.includes(key);
}

function requirePerm(
  req: Request,
  res: Response,
  key: string,
): WorkspaceRequest | null {
  const wreq = workspace(req);
  if (!can(wreq, key)) {
    res.status(403).json({ error: `Requires owner or ${key} permission` });
    return null;
  }
  return wreq;
}

function actorOf(req: Request): { id: string | null; name: string | null } {
  const wreq = workspace(req);
  return {
    id: (req as Request & { userId?: string }).userId ?? null,
    name: wreq.userEmail ?? null,
  };
}

// ---------------------------------------------------------------------------
// Number coercion helpers
// ---------------------------------------------------------------------------

function num(v: unknown, fallback = 0): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Activity logging
// ---------------------------------------------------------------------------

async function logActivity(opts: {
  saleId: number;
  ownerId: string;
  action: string;
  description?: string | null;
  actorId?: string | null;
  actorName?: string | null;
  metadata?: unknown;
}): Promise<void> {
  try {
    await db.query(
      `INSERT INTO workshop_sale_activity_logs
        (workshop_sale_id, workspace_owner_id, action, description, actor_id, actor_name, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        opts.saleId,
        opts.ownerId,
        opts.action,
        opts.description ?? null,
        opts.actorId ?? null,
        opts.actorName ?? null,
        opts.metadata != null ? JSON.stringify(opts.metadata) : null,
      ],
    );
  } catch (err) {
    logger.warn({ err, saleId: opts.saleId }, "Failed to write workshop sale activity log");
  }
}

// ---------------------------------------------------------------------------
// Totals recomputation — derives subtotal/discount/tax/total/balance/payment_status
// ---------------------------------------------------------------------------

async function recomputeTotals(saleId: number, ownerId: string): Promise<void> {
  const itemsRes = await db.query<{
    quantity: string;
    unit_price: string;
    discount: string;
    discount_type: string;
    tax_rate: string;
  }>(
    `SELECT quantity, unit_price, discount, discount_type, tax_rate
       FROM workshop_sale_items
      WHERE workshop_sale_id = $1 AND workspace_owner_id = $2`,
    [saleId, ownerId],
  );

  let subtotal = 0;
  let discountTotal = 0;
  let taxTotal = 0;

  for (const it of itemsRes.rows) {
    const qty = num(it.quantity, 0);
    const unit = num(it.unit_price, 0);
    const line = qty * unit;
    const discRaw = num(it.discount, 0);
    const discAmount =
      it.discount_type === "percentage" ? (line * discRaw) / 100 : discRaw;
    const taxable = Math.max(0, line - discAmount);
    const tax = (taxable * num(it.tax_rate, 0)) / 100;
    subtotal += line;
    discountTotal += discAmount;
    taxTotal += tax;
  }

  const total = round2(subtotal - discountTotal + taxTotal);

  const paidRes = await db.query<{ paid: string | null }>(
    `SELECT COALESCE(SUM(amount), 0) AS paid
       FROM workshop_sale_payments
      WHERE workshop_sale_id = $1 AND workspace_owner_id = $2`,
    [saleId, ownerId],
  );
  const amountPaid = round2(num(paidRes.rows[0]?.paid, 0));
  const balanceDue = round2(total - amountPaid);

  let paymentStatus = "unpaid";
  if (amountPaid <= 0) paymentStatus = "unpaid";
  else if (amountPaid >= total) paymentStatus = "paid";
  else paymentStatus = "partially_paid";

  await db.query(
    `UPDATE workshop_sales
        SET subtotal = $1, discount_total = $2, tax_total = $3, total = $4,
            amount_paid = $5, balance_due = $6, payment_status = $7, updated_at = now()
      WHERE id = $8 AND workspace_owner_id = $9`,
    [
      round2(subtotal),
      round2(discountTotal),
      round2(taxTotal),
      total,
      amountPaid,
      balanceDue,
      paymentStatus,
      saleId,
      ownerId,
    ],
  );
}

// ---------------------------------------------------------------------------
// Fetch a single sale (ownership-scoped) or null
// ---------------------------------------------------------------------------

async function fetchSale(
  saleId: number,
  ownerId: string,
): Promise<Record<string, unknown> | null> {
  const r = await db.query(
    `SELECT * FROM workshop_sales WHERE id = $1 AND workspace_owner_id = $2`,
    [saleId, ownerId],
  );
  return r.rows[0] ?? null;
}

const VALID_STATUSES = new Set([
  "draft",
  "in_preparation",
  "ready",
  "completed",
  "cancelled",
]);

// ===========================================================================
// LIST — GET /workshop-sales
// ===========================================================================

router.get("/workshop-sales", async (req, res) => {
  const wreq = requirePerm(req, res, "workshop_sales.view");
  if (!wreq) return;

  const ownerId = wreq.workspaceOwnerId;
  const q = req.query;

  const conditions: string[] = ["workspace_owner_id = $1"];
  const params: unknown[] = [ownerId];

  const status = str(q.status);
  if (status) {
    params.push(status);
    conditions.push(`status = $${params.length}`);
  }
  const paymentStatus = str(q.payment_status);
  if (paymentStatus) {
    params.push(paymentStatus);
    conditions.push(`payment_status = $${params.length}`);
  }
  const brandId = q.brand_id != null ? num(q.brand_id, NaN) : NaN;
  if (Number.isInteger(brandId)) {
    params.push(brandId);
    conditions.push(`brand_id = $${params.length}`);
  }
  const locationId = q.location_id != null ? num(q.location_id, NaN) : NaN;
  if (Number.isInteger(locationId)) {
    params.push(locationId);
    conditions.push(`location_id = $${params.length}`);
  }
  const floristId =
    q.assigned_florist_member_id != null
      ? num(q.assigned_florist_member_id, NaN)
      : NaN;
  if (Number.isInteger(floristId)) {
    params.push(floristId);
    conditions.push(`assigned_florist_member_id = $${params.length}`);
  }
  const search = str(q.q);
  if (search) {
    params.push(`%${search.toLowerCase()}%`);
    const idx = params.length;
    conditions.push(
      `(LOWER(order_number) LIKE $${idx} OR LOWER(COALESCE(customer_name,'')) LIKE $${idx} OR LOWER(COALESCE(customer_phone,'')) LIKE $${idx})`,
    );
  }

  const page = Math.max(1, Math.trunc(num(q.page, 1)));
  const pageSize = Math.min(100, Math.max(1, Math.trunc(num(q.page_size, 25))));
  const offset = (page - 1) * pageSize;

  const where = conditions.join(" AND ");

  try {
    const countRes = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM workshop_sales WHERE ${where}`,
      params,
    );
    const total = Number(countRes.rows[0]?.count ?? 0);

    const listParams = [...params, pageSize, offset];
    const rowsRes = await db.query(
      `SELECT * FROM workshop_sales WHERE ${where}
        ORDER BY created_at DESC
        LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams,
    );

    res.json({ items: rowsRes.rows, total, page, pageSize });
  } catch (err) {
    req.log.error({ err }, "Failed to list workshop sales");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ===========================================================================
// DETAIL — GET /workshop-sales/:id
// ===========================================================================

router.get("/workshop-sales/:id", async (req, res) => {
  const wreq = requirePerm(req, res, "workshop_sales.view");
  if (!wreq) return;
  const ownerId = wreq.workspaceOwnerId;
  const id = num(req.params.id, NaN);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  try {
    const sale = await fetchSale(id, ownerId);
    if (!sale) {
      res.status(404).json({ error: "Workshop sale not found" });
      return;
    }

    const [items, payments, photos, activity, inventory] = await Promise.all([
      db.query(
        `SELECT * FROM workshop_sale_items WHERE workshop_sale_id = $1 AND workspace_owner_id = $2 ORDER BY sort_order ASC, id ASC`,
        [id, ownerId],
      ),
      db.query(
        `SELECT * FROM workshop_sale_payments WHERE workshop_sale_id = $1 AND workspace_owner_id = $2 ORDER BY paid_at DESC, id DESC`,
        [id, ownerId],
      ),
      db.query(
        `SELECT * FROM workshop_sale_photos WHERE workshop_sale_id = $1 AND workspace_owner_id = $2 ORDER BY is_cover DESC, id ASC`,
        [id, ownerId],
      ),
      db.query(
        `SELECT * FROM workshop_sale_activity_logs WHERE workshop_sale_id = $1 AND workspace_owner_id = $2 ORDER BY created_at DESC, id DESC`,
        [id, ownerId],
      ),
      db.query(
        `SELECT * FROM workshop_sale_inventory_usage WHERE workshop_sale_id = $1 AND workspace_owner_id = $2 ORDER BY id ASC`,
        [id, ownerId],
      ),
    ]);

    const canCogs = can(wreq, "workshop_sales.view_cogs");
    const saleOut = { ...sale };
    if (!canCogs) {
      delete (saleOut as Record<string, unknown>).cogs_amount;
      delete (saleOut as Record<string, unknown>).cogs_percentage;
    }

    res.json({
      sale: saleOut,
      items: items.rows,
      payments: payments.rows,
      photos: photos.rows,
      activity: activity.rows,
      inventory_usage: inventory.rows,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to fetch workshop sale detail");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ===========================================================================
// CREATE — POST /workshop-sales
// ===========================================================================

router.post("/workshop-sales", async (req, res) => {
  const wreq = requirePerm(req, res, "workshop_sales.create");
  if (!wreq) return;
  const ownerId = wreq.workspaceOwnerId;
  const body = req.body as Record<string, unknown>;
  const actor = actorOf(req);

  const locationId = body.location_id != null ? num(body.location_id, NaN) : NaN;

  try {
    // Resolve location name for the order-number location code.
    let locationName: string | null = null;
    if (Number.isInteger(locationId)) {
      const locRes = await db.query<{ name: string }>(
        `SELECT name FROM locations WHERE id = $1 AND workspace_owner_id = $2`,
        [locationId, ownerId],
      );
      locationName = locRes.rows[0]?.name ?? null;
    }

    const orderNumber = await generateWorkshopSaleOrderNumber({
      workspaceOwnerId: ownerId,
      locationName,
    });

    const colors = Array.isArray(body.colors) ? JSON.stringify(body.colors) : null;

    const insertRes = await db.query<{ id: number }>(
      `INSERT INTO workshop_sales
        (workspace_owner_id, order_number, brand_id, location_id, country_id,
         sale_type, assigned_florist_member_id, status, currency,
         customer_type, customer_id, customer_name, customer_phone, customer_email,
         request_description, occasion, colors, style, budget, internal_notes,
         created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$21)
       RETURNING id`,
      [
        ownerId,
        orderNumber,
        Number.isInteger(num(body.brand_id, NaN)) ? num(body.brand_id) : null,
        Number.isInteger(locationId) ? locationId : null,
        Number.isInteger(num(body.country_id, NaN)) ? num(body.country_id) : null,
        str(body.sale_type) ?? "custom",
        Number.isInteger(num(body.assigned_florist_member_id, NaN))
          ? num(body.assigned_florist_member_id)
          : null,
        VALID_STATUSES.has(str(body.status) ?? "") ? str(body.status) : "draft",
        str(body.currency) ?? "USD",
        str(body.customer_type) ?? "guest",
        Number.isInteger(num(body.customer_id, NaN)) ? num(body.customer_id) : null,
        str(body.customer_name),
        str(body.customer_phone),
        str(body.customer_email),
        str(body.request_description),
        str(body.occasion),
        colors,
        str(body.style),
        body.budget != null ? num(body.budget) : null,
        str(body.internal_notes),
        actor.id,
      ],
    );

    const saleId = insertRes.rows[0]!.id;

    // Optional inline items on create.
    if (Array.isArray(body.items)) {
      let sort = 0;
      for (const raw of body.items as Record<string, unknown>[]) {
        const name = str(raw.name);
        if (!name) continue;
        await db.query(
          `INSERT INTO workshop_sale_items
            (workshop_sale_id, workspace_owner_id, name, description, quantity, unit_price, discount, discount_type, tax_rate, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            saleId,
            ownerId,
            name,
            str(raw.description),
            num(raw.quantity, 1),
            num(raw.unit_price, 0),
            num(raw.discount, 0),
            raw.discount_type === "percentage" ? "percentage" : "amount",
            num(raw.tax_rate, 0),
            sort++,
          ],
        );
      }
    }

    await recomputeTotals(saleId, ownerId);
    await logActivity({
      saleId,
      ownerId,
      action: "created",
      description: `Workshop sale ${orderNumber} created`,
      actorId: actor.id,
      actorName: actor.name,
    });

    const sale = await fetchSale(saleId, ownerId);
    res.status(201).json({ sale });
  } catch (err) {
    req.log.error({ err }, "Failed to create workshop sale");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ===========================================================================
// UPDATE — PATCH /workshop-sales/:id
// ===========================================================================

const UPDATABLE_FIELDS: Record<string, string> = {
  brand_id: "brand_id",
  location_id: "location_id",
  country_id: "country_id",
  sale_type: "sale_type",
  assigned_florist_member_id: "assigned_florist_member_id",
  currency: "currency",
  customer_type: "customer_type",
  customer_id: "customer_id",
  customer_name: "customer_name",
  customer_phone: "customer_phone",
  customer_email: "customer_email",
  request_description: "request_description",
  occasion: "occasion",
  style: "style",
  budget: "budget",
  internal_notes: "internal_notes",
};

const INT_FIELDS = new Set([
  "brand_id",
  "location_id",
  "country_id",
  "assigned_florist_member_id",
  "customer_id",
]);
const NUMERIC_FIELDS = new Set(["budget"]);

router.patch("/workshop-sales/:id", async (req, res) => {
  const wreq = workspace(req);
  const ownerId = wreq.workspaceOwnerId;
  const id = num(req.params.id, NaN);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  try {
    const existing = await fetchSale(id, ownerId);
    if (!existing) {
      res.status(404).json({ error: "Workshop sale not found" });
      return;
    }

    const isCompleted = existing.status === "completed";
    const neededPerm = isCompleted
      ? "workshop_sales.edit_completed"
      : "workshop_sales.edit";
    if (!can(wreq, neededPerm)) {
      res.status(403).json({ error: `Requires owner or ${neededPerm} permission` });
      return;
    }
    if (existing.status === "cancelled") {
      res.status(409).json({ error: "Cannot edit a cancelled workshop sale" });
      return;
    }

    const body = req.body as Record<string, unknown>;
    const sets: string[] = [];
    const params: unknown[] = [];

    for (const [key, col] of Object.entries(UPDATABLE_FIELDS)) {
      if (!(key in body)) continue;
      let value: unknown = body[key];
      if (INT_FIELDS.has(key)) {
        value = value != null && Number.isInteger(num(value, NaN)) ? num(value) : null;
      } else if (NUMERIC_FIELDS.has(key)) {
        value = value != null ? num(value) : null;
      } else {
        value = str(value);
      }
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    }

    if ("colors" in body) {
      params.push(Array.isArray(body.colors) ? JSON.stringify(body.colors) : null);
      sets.push(`colors = $${params.length}`);
    }

    const actor = actorOf(req);
    params.push(actor.id);
    sets.push(`updated_by = $${params.length}`);
    sets.push(`updated_at = now()`);

    if (sets.length === 0) {
      res.status(400).json({ error: "No updatable fields provided" });
      return;
    }

    params.push(id);
    params.push(ownerId);
    await db.query(
      `UPDATE workshop_sales SET ${sets.join(", ")} WHERE id = $${params.length - 1} AND workspace_owner_id = $${params.length}`,
      params,
    );

    await recomputeTotals(id, ownerId);
    await logActivity({
      saleId: id,
      ownerId,
      action: "updated",
      description: "Workshop sale details updated",
      actorId: actor.id,
      actorName: actor.name,
    });

    const sale = await fetchSale(id, ownerId);
    res.json({ sale });
  } catch (err) {
    req.log.error({ err }, "Failed to update workshop sale");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ===========================================================================
// STATUS CHANGE — PATCH /workshop-sales/:id/status
// ===========================================================================

router.patch("/workshop-sales/:id/status", async (req, res) => {
  const wreq = requirePerm(req, res, "workshop_sales.edit");
  if (!wreq) return;
  const ownerId = wreq.workspaceOwnerId;
  const id = num(req.params.id, NaN);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const body = req.body as Record<string, unknown>;
  const status = str(body.status);
  if (!status || !VALID_STATUSES.has(status)) {
    res.status(400).json({ error: "Invalid status" });
    return;
  }
  if (status === "cancelled") {
    res.status(400).json({ error: "Use the cancel endpoint to cancel a sale" });
    return;
  }

  try {
    const existing = await fetchSale(id, ownerId);
    if (!existing) {
      res.status(404).json({ error: "Workshop sale not found" });
      return;
    }
    if (existing.status === "cancelled") {
      res.status(409).json({ error: "Cannot change status of a cancelled sale" });
      return;
    }

    const actor = actorOf(req);
    const completedAtClause = status === "completed" ? ", completed_at = now()" : "";
    await db.query(
      `UPDATE workshop_sales SET status = $1, updated_by = $2, updated_at = now()${completedAtClause}
        WHERE id = $3 AND workspace_owner_id = $4`,
      [status, actor.id, id, ownerId],
    );
    await logActivity({
      saleId: id,
      ownerId,
      action: "status_changed",
      description: `Status changed from ${existing.status} to ${status}`,
      actorId: actor.id,
      actorName: actor.name,
      metadata: { from: existing.status, to: status },
    });
    const sale = await fetchSale(id, ownerId);
    res.json({ sale });
  } catch (err) {
    req.log.error({ err }, "Failed to change workshop sale status");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ===========================================================================
// CANCEL — POST /workshop-sales/:id/cancel
// ===========================================================================

router.post("/workshop-sales/:id/cancel", async (req, res) => {
  const wreq = requirePerm(req, res, "workshop_sales.cancel");
  if (!wreq) return;
  const ownerId = wreq.workspaceOwnerId;
  const id = num(req.params.id, NaN);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const body = req.body as Record<string, unknown>;
  const reason = str(body.reason);

  try {
    const existing = await fetchSale(id, ownerId);
    if (!existing) {
      res.status(404).json({ error: "Workshop sale not found" });
      return;
    }
    if (existing.status === "cancelled") {
      res.status(409).json({ error: "Workshop sale is already cancelled" });
      return;
    }

    const actor = actorOf(req);
    await db.query(
      `UPDATE workshop_sales
          SET status = 'cancelled', cancellation_reason = $1, cancelled_at = now(),
              cancelled_by = $2, updated_by = $2, updated_at = now()
        WHERE id = $3 AND workspace_owner_id = $4`,
      [reason, actor.id, id, ownerId],
    );
    await logActivity({
      saleId: id,
      ownerId,
      action: "cancelled",
      description: reason ? `Cancelled: ${reason}` : "Workshop sale cancelled",
      actorId: actor.id,
      actorName: actor.name,
    });
    const sale = await fetchSale(id, ownerId);
    res.json({ sale });
  } catch (err) {
    req.log.error({ err }, "Failed to cancel workshop sale");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ===========================================================================
// DELETE — DELETE /workshop-sales/:id
// ===========================================================================

router.delete("/workshop-sales/:id", async (req, res) => {
  const wreq = requirePerm(req, res, "workshop_sales.delete");
  if (!wreq) return;
  const ownerId = wreq.workspaceOwnerId;
  const id = num(req.params.id, NaN);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  try {
    const result = await db.query(
      `DELETE FROM workshop_sales WHERE id = $1 AND workspace_owner_id = $2`,
      [id, ownerId],
    );
    if (result.rowCount === 0) {
      res.status(404).json({ error: "Workshop sale not found" });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Failed to delete workshop sale");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ===========================================================================
// ITEMS — sub-resource
// ===========================================================================

async function ensureSale(
  req: Request,
  res: Response,
  ownerId: string,
): Promise<number | null> {
  const id = num(req.params.id, NaN);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid id" });
    return null;
  }
  const sale = await fetchSale(id, ownerId);
  if (!sale) {
    res.status(404).json({ error: "Workshop sale not found" });
    return null;
  }
  return id;
}

router.post("/workshop-sales/:id/items", async (req, res) => {
  const wreq = requirePerm(req, res, "workshop_sales.edit");
  if (!wreq) return;
  const ownerId = wreq.workspaceOwnerId;
  const saleId = await ensureSale(req, res, ownerId);
  if (saleId == null) return;

  const body = req.body as Record<string, unknown>;
  const name = str(body.name);
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  try {
    const sortRes = await db.query<{ max: number | null }>(
      `SELECT MAX(sort_order) AS max FROM workshop_sale_items WHERE workshop_sale_id = $1 AND workspace_owner_id = $2`,
      [saleId, ownerId],
    );
    const nextSort = (sortRes.rows[0]?.max ?? -1) + 1;
    const ins = await db.query<{ id: number }>(
      `INSERT INTO workshop_sale_items
        (workshop_sale_id, workspace_owner_id, name, description, quantity, unit_price, discount, discount_type, tax_rate, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [
        saleId,
        ownerId,
        name,
        str(body.description),
        num(body.quantity, 1),
        num(body.unit_price, 0),
        num(body.discount, 0),
        body.discount_type === "percentage" ? "percentage" : "amount",
        num(body.tax_rate, 0),
        nextSort,
      ],
    );
    await recomputeTotals(saleId, ownerId);
    res.status(201).json({ id: ins.rows[0]!.id });
  } catch (err) {
    req.log.error({ err }, "Failed to add workshop sale item");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.patch("/workshop-sales/:id/items/:itemId", async (req, res) => {
  const wreq = requirePerm(req, res, "workshop_sales.edit");
  if (!wreq) return;
  const ownerId = wreq.workspaceOwnerId;
  const saleId = await ensureSale(req, res, ownerId);
  if (saleId == null) return;
  const itemId = num(req.params.itemId, NaN);
  if (!Number.isInteger(itemId)) {
    res.status(400).json({ error: "Invalid itemId" });
    return;
  }

  const body = req.body as Record<string, unknown>;
  const sets: string[] = [];
  const params: unknown[] = [];
  const textCols: Record<string, string> = {
    name: "name",
    description: "description",
  };
  for (const [k, col] of Object.entries(textCols)) {
    if (k in body) {
      params.push(str(body[k]));
      sets.push(`${col} = $${params.length}`);
    }
  }
  const numCols: Record<string, string> = {
    quantity: "quantity",
    unit_price: "unit_price",
    discount: "discount",
    tax_rate: "tax_rate",
    sort_order: "sort_order",
  };
  for (const [k, col] of Object.entries(numCols)) {
    if (k in body) {
      params.push(num(body[k], 0));
      sets.push(`${col} = $${params.length}`);
    }
  }
  if ("discount_type" in body) {
    params.push(body.discount_type === "percentage" ? "percentage" : "amount");
    sets.push(`discount_type = $${params.length}`);
  }
  if (sets.length === 0) {
    res.status(400).json({ error: "No updatable fields provided" });
    return;
  }
  params.push(itemId, saleId, ownerId);
  try {
    const r = await db.query(
      `UPDATE workshop_sale_items SET ${sets.join(", ")}
        WHERE id = $${params.length - 2} AND workshop_sale_id = $${params.length - 1} AND workspace_owner_id = $${params.length}`,
      params,
    );
    if (r.rowCount === 0) {
      res.status(404).json({ error: "Item not found" });
      return;
    }
    await recomputeTotals(saleId, ownerId);
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Failed to update workshop sale item");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/workshop-sales/:id/items/:itemId", async (req, res) => {
  const wreq = requirePerm(req, res, "workshop_sales.edit");
  if (!wreq) return;
  const ownerId = wreq.workspaceOwnerId;
  const saleId = await ensureSale(req, res, ownerId);
  if (saleId == null) return;
  const itemId = num(req.params.itemId, NaN);
  if (!Number.isInteger(itemId)) {
    res.status(400).json({ error: "Invalid itemId" });
    return;
  }
  try {
    const r = await db.query(
      `DELETE FROM workshop_sale_items WHERE id = $1 AND workshop_sale_id = $2 AND workspace_owner_id = $3`,
      [itemId, saleId, ownerId],
    );
    if (r.rowCount === 0) {
      res.status(404).json({ error: "Item not found" });
      return;
    }
    await recomputeTotals(saleId, ownerId);
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Failed to delete workshop sale item");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ===========================================================================
// PAYMENTS — sub-resource
// ===========================================================================

router.post("/workshop-sales/:id/payments", async (req, res) => {
  const wreq = requirePerm(req, res, "workshop_sales.manage_payments");
  if (!wreq) return;
  const ownerId = wreq.workspaceOwnerId;
  const saleId = await ensureSale(req, res, ownerId);
  if (saleId == null) return;

  const body = req.body as Record<string, unknown>;
  const amount = num(body.amount, NaN);
  if (!Number.isFinite(amount) || amount <= 0) {
    res.status(400).json({ error: "amount must be a positive number" });
    return;
  }
  try {
    const actor = actorOf(req);
    const method = str(body.method) ?? "cash";
    const currency = str(body.currency) ?? "USD";
    const ins = await db.query<{ id: number }>(
      `INSERT INTO workshop_sale_payments
        (workshop_sale_id, workspace_owner_id, method, amount, currency, reference, collected_by, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [
        saleId,
        ownerId,
        method,
        amount,
        currency,
        str(body.reference),
        str(body.collected_by) ?? actor.name,
        str(body.notes),
      ],
    );
    const paymentId = ins.rows[0]!.id;
    await recomputeTotals(saleId, ownerId);
    await logActivity({
      saleId,
      ownerId,
      action: "payment_added",
      description: `Payment of ${amount} recorded`,
      actorId: actor.id,
      actorName: actor.name,
      metadata: { amount, method },
    });

    // Auto-link cash payments to the location's currently open cash session so
    // the shift's expected-vs-counted reconciliation stays accurate without
    // manual entry. Non-cash payments (card / bank transfer) never touch the
    // drawer, so they are left out. Linking is best-effort: a missing open
    // session or any failure must never break payment recording.
    if (method === "cash") {
      try {
        const saleRow = await db.query<{
          location_id: number | null;
          order_number: string | null;
        }>(
          `SELECT location_id, order_number FROM workshop_sales
            WHERE id = $1 AND workspace_owner_id = $2`,
          [saleId, ownerId],
        );
        const locationId = saleRow.rows[0]?.location_id ?? null;
        const orderNumber = saleRow.rows[0]?.order_number ?? null;
        const link = await recordCashTransaction({
          workspaceOwnerId: ownerId,
          amount,
          type: "sale",
          direction: "in",
          currency,
          locationId,
          description: orderNumber
            ? `Workshop sale ${orderNumber}`
            : `Workshop sale #${saleId}`,
          referenceType: "workshop_sale_payment",
          referenceId: String(paymentId),
          createdByClerkId: actor.id,
        });
        if (!link.linked) {
          req.log.info(
            { saleId, paymentId },
            "Cash workshop-sale payment recorded but no open cash session to link",
          );
        }
      } catch (linkErr) {
        req.log.error(
          { err: linkErr, saleId, paymentId },
          "Failed to auto-link workshop-sale cash payment to cash session",
        );
      }
    }

    res.status(201).json({ id: paymentId });
  } catch (err) {
    req.log.error({ err }, "Failed to record workshop sale payment");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/workshop-sales/:id/payments/:paymentId", async (req, res) => {
  const wreq = requirePerm(req, res, "workshop_sales.refund");
  if (!wreq) return;
  const ownerId = wreq.workspaceOwnerId;
  const saleId = await ensureSale(req, res, ownerId);
  if (saleId == null) return;
  const paymentId = num(req.params.paymentId, NaN);
  if (!Number.isInteger(paymentId)) {
    res.status(400).json({ error: "Invalid paymentId" });
    return;
  }
  try {
    const r = await db.query<{
      amount: string;
      method: string | null;
      currency: string | null;
    }>(
      `DELETE FROM workshop_sale_payments WHERE id = $1 AND workshop_sale_id = $2 AND workspace_owner_id = $3 RETURNING amount, method, currency`,
      [paymentId, saleId, ownerId],
    );
    if (r.rowCount === 0) {
      res.status(404).json({ error: "Payment not found" });
      return;
    }
    await recomputeTotals(saleId, ownerId);
    const actor = actorOf(req);
    await logActivity({
      saleId,
      ownerId,
      action: "payment_refunded",
      description: `Payment of ${r.rows[0]!.amount} refunded/removed`,
      actorId: actor.id,
      actorName: actor.name,
    });

    // Mirror the auto-link done when a cash payment is recorded: refunding a
    // cash payment must take the cash back out of the location's open cash
    // session so the shift's expected cash drops back down. Non-cash payments
    // never touched the drawer, so they need no reversal. Best-effort: a
    // missing open session or any failure must never break the refund.
    const refundedMethod = r.rows[0]!.method ?? "cash";
    if (refundedMethod === "cash") {
      try {
        const refundAmount = Number(r.rows[0]!.amount);
        const currency = r.rows[0]!.currency ?? "USD";
        const saleRow = await db.query<{
          location_id: number | null;
          order_number: string | null;
        }>(
          `SELECT location_id, order_number FROM workshop_sales
            WHERE id = $1 AND workspace_owner_id = $2`,
          [saleId, ownerId],
        );
        const locationId = saleRow.rows[0]?.location_id ?? null;
        const orderNumber = saleRow.rows[0]?.order_number ?? null;
        const link = await recordCashTransaction({
          workspaceOwnerId: ownerId,
          amount: refundAmount,
          type: "refund",
          direction: "out",
          currency,
          locationId,
          description: orderNumber
            ? `Workshop sale ${orderNumber} refund`
            : `Workshop sale #${saleId} refund`,
          referenceType: "workshop_sale_payment_refund",
          referenceId: String(paymentId),
          createdByClerkId: actor.id,
        });
        if (!link.linked) {
          req.log.info(
            { saleId, paymentId },
            "Cash workshop-sale payment refunded but no open cash session to reverse",
          );
        }
      } catch (linkErr) {
        req.log.error(
          { err: linkErr, saleId, paymentId },
          "Failed to reverse workshop-sale cash payment from cash session",
        );
      }
    }

    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Failed to refund workshop sale payment");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ===========================================================================
// PHOTOS — sub-resource
// ===========================================================================

async function uploadPhotoToStorage(
  buffer: Buffer,
  mime: string,
  ownerId: string,
): Promise<string> {
  const privateObjectDir = process.env.PRIVATE_OBJECT_DIR;
  if (!privateObjectDir) {
    throw new Error("PRIVATE_OBJECT_DIR not set");
  }
  const objectId = randomUUID();
  const fullPath = `${privateObjectDir}/${ownerId}/workshop-sales/${objectId}`;
  const parts = fullPath.startsWith("/")
    ? fullPath.slice(1).split("/")
    : fullPath.split("/");
  if (parts.length < 2) throw new Error("Invalid PRIVATE_OBJECT_DIR path");
  const bucketName = parts[0]!;
  const objectName = parts.slice(1).join("/");
  const bucket = objectStorageClient.bucket(bucketName);
  const file = bucket.file(objectName);
  await file.save(buffer, { contentType: mime, resumable: false });
  return `/objects/${ownerId}/workshop-sales/${objectId}`;
}

router.post(
  "/workshop-sales/:id/photos",
  upload.single("photo"),
  async (req, res) => {
    const wreq = requirePerm(req, res, "workshop_sales.manage_photos");
    if (!wreq) return;
    const ownerId = wreq.workspaceOwnerId;
    const saleId = await ensureSale(req, res, ownerId);
    if (saleId == null) return;

    const file = req.file;
    const bodyUrl = str((req.body as Record<string, unknown>)?.url);
    let url: string | null = bodyUrl;
    try {
      if (file) {
        const mime = file.mimetype || "image/jpeg";
        if (!mime.startsWith("image/")) {
          res.status(400).json({ error: "File must be an image" });
          return;
        }
        url = await uploadPhotoToStorage(file.buffer, mime, ownerId);
      }
      if (!url) {
        res.status(400).json({ error: "A photo file or url is required" });
        return;
      }
      const caption = str((req.body as Record<string, unknown>)?.caption);
      const actor = actorOf(req);
      const ins = await db.query<{ id: number }>(
        `INSERT INTO workshop_sale_photos
          (workshop_sale_id, workspace_owner_id, url, caption, uploaded_by)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [saleId, ownerId, url, caption, actor.id],
      );
      res.status(201).json({ id: ins.rows[0]!.id, url });
    } catch (err) {
      req.log.error({ err }, "Failed to add workshop sale photo");
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

router.patch("/workshop-sales/:id/photos/:photoId/cover", async (req, res) => {
  const wreq = requirePerm(req, res, "workshop_sales.manage_photos");
  if (!wreq) return;
  const ownerId = wreq.workspaceOwnerId;
  const saleId = await ensureSale(req, res, ownerId);
  if (saleId == null) return;
  const photoId = num(req.params.photoId, NaN);
  if (!Number.isInteger(photoId)) {
    res.status(400).json({ error: "Invalid photoId" });
    return;
  }
  try {
    const check = await db.query(
      `SELECT id FROM workshop_sale_photos WHERE id = $1 AND workshop_sale_id = $2 AND workspace_owner_id = $3`,
      [photoId, saleId, ownerId],
    );
    if (check.rowCount === 0) {
      res.status(404).json({ error: "Photo not found" });
      return;
    }
    await db.query(
      `UPDATE workshop_sale_photos SET is_cover = (id = $1) WHERE workshop_sale_id = $2 AND workspace_owner_id = $3`,
      [photoId, saleId, ownerId],
    );
    await db.query(
      `UPDATE workshop_sales SET cover_photo_id = $1, updated_at = now() WHERE id = $2 AND workspace_owner_id = $3`,
      [photoId, saleId, ownerId],
    );
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Failed to set cover photo");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.patch("/workshop-sales/:id/photos/:photoId", async (req, res) => {
  const wreq = requirePerm(req, res, "workshop_sales.manage_photos");
  if (!wreq) return;
  const ownerId = wreq.workspaceOwnerId;
  const saleId = await ensureSale(req, res, ownerId);
  if (saleId == null) return;
  const photoId = num(req.params.photoId, NaN);
  if (!Number.isInteger(photoId)) {
    res.status(400).json({ error: "Invalid photoId" });
    return;
  }
  try {
    const caption = str((req.body as Record<string, unknown>)?.caption);
    const upd = await db.query(
      `UPDATE workshop_sale_photos SET caption = $1
       WHERE id = $2 AND workshop_sale_id = $3 AND workspace_owner_id = $4
       RETURNING *`,
      [caption, photoId, saleId, ownerId],
    );
    if (upd.rowCount === 0) {
      res.status(404).json({ error: "Photo not found" });
      return;
    }
    res.json({ photo: upd.rows[0] });
  } catch (err) {
    req.log.error({ err }, "Failed to update workshop sale photo caption");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/workshop-sales/:id/photos/:photoId", async (req, res) => {
  const wreq = requirePerm(req, res, "workshop_sales.manage_photos");
  if (!wreq) return;
  const ownerId = wreq.workspaceOwnerId;
  const saleId = await ensureSale(req, res, ownerId);
  if (saleId == null) return;
  const photoId = num(req.params.photoId, NaN);
  if (!Number.isInteger(photoId)) {
    res.status(400).json({ error: "Invalid photoId" });
    return;
  }
  try {
    const r = await db.query<{ is_cover: boolean }>(
      `DELETE FROM workshop_sale_photos WHERE id = $1 AND workshop_sale_id = $2 AND workspace_owner_id = $3 RETURNING is_cover`,
      [photoId, saleId, ownerId],
    );
    if (r.rowCount === 0) {
      res.status(404).json({ error: "Photo not found" });
      return;
    }
    if (r.rows[0]!.is_cover) {
      await db.query(
        `UPDATE workshop_sales SET cover_photo_id = NULL, updated_at = now() WHERE id = $1 AND workspace_owner_id = $2`,
        [saleId, ownerId],
      );
    }
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Failed to delete workshop sale photo");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ===========================================================================
// COGS — PATCH /workshop-sales/:id/cogs
// ===========================================================================

router.patch("/workshop-sales/:id/cogs", async (req, res) => {
  const wreq = requirePerm(req, res, "workshop_sales.manage_cogs");
  if (!wreq) return;
  const ownerId = wreq.workspaceOwnerId;
  const saleId = await ensureSale(req, res, ownerId);
  if (saleId == null) return;

  const body = req.body as Record<string, unknown>;
  const cogsAmount = body.cogs_amount != null ? num(body.cogs_amount) : null;

  try {
    const sale = await fetchSale(saleId, ownerId);
    const total = num(sale?.total, 0);
    let cogsPct = body.cogs_percentage != null ? num(body.cogs_percentage) : null;
    if (cogsPct == null && cogsAmount != null && total > 0) {
      cogsPct = round2((cogsAmount / total) * 100);
    }
    const actor = actorOf(req);
    await db.query(
      `UPDATE workshop_sales SET cogs_amount = $1, cogs_percentage = $2, updated_by = $3, updated_at = now()
        WHERE id = $4 AND workspace_owner_id = $5`,
      [cogsAmount, cogsPct, actor.id, saleId, ownerId],
    );
    await logActivity({
      saleId,
      ownerId,
      action: "cogs_updated",
      description: `COGS set to ${cogsAmount ?? "null"}`,
      actorId: actor.id,
      actorName: actor.name,
    });
    const updated = await fetchSale(saleId, ownerId);
    res.json({ sale: updated });
  } catch (err) {
    req.log.error({ err }, "Failed to update workshop sale COGS");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ===========================================================================
// INVENTORY USAGE — sub-resource (MVP stub: tracking only, no stock deduction)
// ===========================================================================

router.post("/workshop-sales/:id/inventory-usage", async (req, res) => {
  const wreq = requirePerm(req, res, "workshop_sales.edit");
  if (!wreq) return;
  const ownerId = wreq.workspaceOwnerId;
  const saleId = await ensureSale(req, res, ownerId);
  if (saleId == null) return;

  const body = req.body as Record<string, unknown>;
  const baseItemId = body.base_item_id != null ? num(body.base_item_id, NaN) : NaN;
  const itemName = str(body.item_name);
  if (!Number.isInteger(baseItemId) && !itemName) {
    res.status(400).json({ error: "base_item_id or item_name is required" });
    return;
  }
  try {
    const ins = await db.query<{ id: number }>(
      `INSERT INTO workshop_sale_inventory_usage
        (workshop_sale_id, workspace_owner_id, base_item_id, item_name, quantity, unit, country_id, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [
        saleId,
        ownerId,
        Number.isInteger(baseItemId) ? baseItemId : null,
        itemName,
        num(body.quantity, 0),
        str(body.unit),
        Number.isInteger(num(body.country_id, NaN)) ? num(body.country_id) : null,
        str(body.notes),
      ],
    );
    res.status(201).json({ id: ins.rows[0]!.id });
  } catch (err) {
    req.log.error({ err }, "Failed to add workshop sale inventory usage");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete(
  "/workshop-sales/:id/inventory-usage/:usageId",
  async (req, res) => {
    const wreq = requirePerm(req, res, "workshop_sales.edit");
    if (!wreq) return;
    const ownerId = wreq.workspaceOwnerId;
    const saleId = await ensureSale(req, res, ownerId);
    if (saleId == null) return;
    const usageId = num(req.params.usageId, NaN);
    if (!Number.isInteger(usageId)) {
      res.status(400).json({ error: "Invalid usageId" });
      return;
    }
    try {
      const r = await db.query(
        `DELETE FROM workshop_sale_inventory_usage WHERE id = $1 AND workshop_sale_id = $2 AND workspace_owner_id = $3`,
        [usageId, saleId, ownerId],
      );
      if (r.rowCount === 0) {
        res.status(404).json({ error: "Inventory usage not found" });
        return;
      }
      res.json({ success: true });
    } catch (err) {
      req.log.error({ err }, "Failed to delete workshop sale inventory usage");
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

// ===========================================================================
// RECEIPT — PDF download + email
// ===========================================================================

async function buildReceiptData(
  saleId: number,
  ownerId: string,
): Promise<WorkshopSaleReceiptData | null> {
  const sale = await fetchSale(saleId, ownerId);
  if (!sale) return null;

  const [itemsRes, paymentsRes] = await Promise.all([
    db.query(
      `SELECT * FROM workshop_sale_items WHERE workshop_sale_id = $1 AND workspace_owner_id = $2 ORDER BY sort_order ASC, id ASC`,
      [saleId, ownerId],
    ),
    db.query(
      `SELECT * FROM workshop_sale_payments WHERE workshop_sale_id = $1 AND workspace_owner_id = $2 ORDER BY paid_at ASC, id ASC`,
      [saleId, ownerId],
    ),
  ]);

  let locationName: string | null = null;
  if (sale.location_id != null) {
    const r = await db.query<{ name: string }>(
      `SELECT name FROM locations WHERE id = $1 AND workspace_owner_id = $2`,
      [sale.location_id, ownerId],
    );
    locationName = r.rows[0]?.name ?? null;
  }
  let brandName: string | null = null;
  if (sale.brand_id != null) {
    const r = await db.query<{ name: string }>(
      `SELECT name FROM brands WHERE id = $1 AND workspace_owner_id = $2`,
      [sale.brand_id, ownerId],
    );
    brandName = r.rows[0]?.name ?? null;
  }

  return {
    orderNumber: String(sale.order_number ?? ""),
    status: String(sale.status ?? "draft"),
    currency: String(sale.currency ?? "USD"),
    createdAt: (sale.created_at as string | Date | null) ?? null,
    customerName: (sale.customer_name as string | null) ?? null,
    customerPhone: (sale.customer_phone as string | null) ?? null,
    customerEmail: (sale.customer_email as string | null) ?? null,
    occasion: (sale.occasion as string | null) ?? null,
    locationName,
    brandName,
    subtotal: (sale.subtotal as string) ?? "0",
    discountTotal: (sale.discount_total as string) ?? "0",
    taxTotal: (sale.tax_total as string) ?? "0",
    total: (sale.total as string) ?? "0",
    amountPaid: (sale.amount_paid as string) ?? "0",
    balanceDue: (sale.balance_due as string) ?? "0",
    items: itemsRes.rows.map((it) => ({
      name: String((it as Record<string, unknown>).name ?? ""),
      description: ((it as Record<string, unknown>).description as string | null) ?? null,
      quantity: ((it as Record<string, unknown>).quantity as string) ?? "0",
      unit_price: ((it as Record<string, unknown>).unit_price as string) ?? "0",
      discount: ((it as Record<string, unknown>).discount as string) ?? "0",
      discount_type: ((it as Record<string, unknown>).discount_type as string | null) ?? "amount",
      tax_rate: ((it as Record<string, unknown>).tax_rate as string) ?? "0",
    })),
    payments: paymentsRes.rows.map((p) => ({
      method: String((p as Record<string, unknown>).method ?? "cash"),
      amount: ((p as Record<string, unknown>).amount as string) ?? "0",
      currency: String((p as Record<string, unknown>).currency ?? sale.currency ?? "USD"),
      paid_at: ((p as Record<string, unknown>).paid_at as string | Date | null) ?? null,
      reference: ((p as Record<string, unknown>).reference as string | null) ?? null,
    })),
  };
}

router.get("/workshop-sales/:id/receipt", async (req, res) => {
  const wreq = requirePerm(req, res, "workshop_sales.generate_receipt");
  if (!wreq) return;
  const ownerId = wreq.workspaceOwnerId;
  const id = num(req.params.id, NaN);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  try {
    const data = await buildReceiptData(id, ownerId);
    if (!data) {
      res.status(404).json({ error: "Workshop sale not found" });
      return;
    }
    const pdf = await buildWorkshopSaleReceiptPdf(data);
    const safeName = `Receipt-${data.orderNumber.replace(/[^a-zA-Z0-9_-]/g, "_")}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
    res.send(pdf);
  } catch (err) {
    req.log.error({ err }, "Failed to generate workshop sale receipt");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/workshop-sales/:id/receipt/email", async (req, res) => {
  const wreq = requirePerm(req, res, "workshop_sales.generate_receipt");
  if (!wreq) return;
  const ownerId = wreq.workspaceOwnerId;
  const actor = actorOf(req);
  const id = num(req.params.id, NaN);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  try {
    const data = await buildReceiptData(id, ownerId);
    if (!data) {
      res.status(404).json({ error: "Workshop sale not found" });
      return;
    }
    const toEmail = str((req.body as Record<string, unknown>)?.email) ?? data.customerEmail;
    if (!toEmail) {
      res.status(400).json({ error: "No recipient email provided or on file" });
      return;
    }

    const pdf = await buildWorkshopSaleReceiptPdf(data);
    await sendWorkshopSaleReceiptEmail({
      toEmail,
      orderNumber: data.orderNumber,
      currency: data.currency,
      total: String(data.total),
      amountPaid: String(data.amountPaid),
      balanceDue: String(data.balanceDue),
      customerName: data.customerName,
      pdfBuffer: pdf,
    });

    await logActivity({
      saleId: id,
      ownerId,
      action: "receipt_emailed",
      description: `Receipt emailed to ${toEmail}`,
      actorId: actor.id,
      actorName: actor.name,
    });

    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Failed to email workshop sale receipt");
    const msg = err instanceof Error ? err.message : "Internal server error";
    const code = msg.includes("not configured") ? 503 : 500;
    res.status(code).json({ error: msg });
  }
});

export default router;
