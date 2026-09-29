/**
 * Public (unauthenticated) purchase order acceptance routes.
 * Mounted BEFORE requireAuth in routes/index.ts.
 *
 * GET  /api/po-accept/:token        — Supplier views the PO
 * POST /api/po-accept/:token/respond — Supplier accepts, declines, or requests changes
 */
import { Router } from "express";
import { db } from "../lib/db";
import { logger } from "../lib/logger";

const router = Router();

const TOKEN_EXPIRY_DAYS = 30;

// ── Simple in-memory rate limiter (10 req/min per token) ──────────────────
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60_000;

function checkRateLimit(key: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(key);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (entry.count >= RATE_LIMIT) return false;
  entry.count += 1;
  return true;
}

// Prune stale entries occasionally to avoid memory leak
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap.entries()) {
    if (now > entry.resetAt) rateLimitMap.delete(key);
  }
}, 5 * 60_000);

// ── GET /api/po-accept/:token ─────────────────────────────────────────────
router.get("/po-accept/:token", async (req, res) => {
  const { token } = req.params;
  if (!token || token.length > 200) {
    res.status(400).json({ error: "Invalid token" });
    return;
  }

  if (!checkRateLimit(`get:${token}`)) {
    res.status(429).json({ error: "Too many requests. Please try again later." });
    return;
  }

  const acceptanceResult = await db.query<{
    id: number;
    purchase_order_id: number;
    workspace_owner_id: string;
    status: string;
    responded_at: string | null;
    notes: string | null;
    responder_name: string | null;
    invalidated_at: string | null;
    created_at: string;
    is_expired: boolean;
  }>(
    `SELECT id, purchase_order_id, workspace_owner_id, status, responded_at,
            notes, responder_name, invalidated_at, created_at,
            (created_at < now() - interval '${TOKEN_EXPIRY_DAYS} days') AS is_expired
       FROM purchase_order_acceptances WHERE token = $1`,
    [token],
  );

  if (acceptanceResult.rowCount === 0) {
    res.status(404).json({ error: "Acceptance link not found or expired" });
    return;
  }

  const acceptance = acceptanceResult.rows[0];

  if (acceptance.is_expired) {
    res.status(410).json({ error: "This acceptance link has expired. Please contact the buyer for a new link." });
    return;
  }

  const poResult = await db.query<{
    id: number;
    po_number: string | null;
    status: string;
    currency: string;
    total_amount: string | null;
    grand_total_amount: string | null;
    subtotal_amount: string | null;
    discount_amount: string | null;
    delivery_fee_amount: string | null;
    vat_treatment: string | null;
    vat_rate: string | null;
    vat_amount: string | null;
    expected_delivery_date: string | null;
    notes: string | null;
    payment_terms: string | null;
    supplier_reference: string | null;
    sent_at: string | null;
    supplier_name: string | null;
    location_name: string | null;
  }>(
    `SELECT po.id, po.po_number, po.status, po.currency,
            po.total_amount, po.grand_total_amount, po.subtotal_amount,
            po.discount_amount, po.delivery_fee_amount, po.vat_treatment,
            po.vat_rate, po.vat_amount, po.expected_delivery_date,
            po.notes, po.payment_terms, po.supplier_reference, po.sent_at,
            s.name AS supplier_name,
            loc.name AS location_name
       FROM purchase_orders po
       LEFT JOIN suppliers s ON s.id = po.supplier_id AND s.workspace_owner_id = po.workspace_owner_id
       LEFT JOIN locations loc ON loc.id = po.location_id
      WHERE po.id = $1 AND po.workspace_owner_id = $2`,
    [acceptance.purchase_order_id, acceptance.workspace_owner_id],
  );

  if (poResult.rowCount === 0) {
    res.status(404).json({ error: "Purchase order not found" });
    return;
  }

  const po = poResult.rows[0];

  const lineItemsResult = await db.query<{
    id: number;
    description: string;
    description_ar: string | null;
    quantity: string;
    unit_price: string;
    currency: string;
    supplier_item_code: string | null;
    supplier_item_unit: string | null;
  }>(
    `SELECT li.id, li.description, li.description_ar,
            li.quantity::text, li.unit_price::text, li.currency,
            sci.supplier_item_code, sci.unit AS supplier_item_unit
       FROM purchase_order_line_items li
       LEFT JOIN supplier_catalog_items sci ON sci.id = li.supplier_catalog_item_id
      WHERE li.purchase_order_id = $1
      ORDER BY li.id ASC`,
    [acceptance.purchase_order_id],
  );

  const poNumberLabel = po.po_number ?? `PO-${String(acceptance.purchase_order_id).padStart(5, "0")}`;

  res.json({
    acceptance: {
      id: acceptance.id,
      status: acceptance.status,
      is_invalidated: acceptance.invalidated_at != null,
      responded_at: acceptance.responded_at,
      responder_name: acceptance.responder_name,
      created_at: acceptance.created_at,
    },
    purchase_order: {
      id: po.id,
      po_number_label: poNumberLabel,
      status: po.status,
      currency: po.currency,
      grand_total_amount: po.grand_total_amount,
      subtotal_amount: po.subtotal_amount,
      discount_amount: po.discount_amount,
      delivery_fee_amount: po.delivery_fee_amount,
      vat_treatment: po.vat_treatment,
      vat_rate: po.vat_rate,
      vat_amount: po.vat_amount,
      expected_delivery_date: po.expected_delivery_date,
      notes: po.notes,
      payment_terms: po.payment_terms,
      supplier_reference: po.supplier_reference,
      sent_at: po.sent_at,
      supplier_name: po.supplier_name,
      location_name: po.location_name,
      line_items: lineItemsResult.rows,
    },
  });
});

// ── POST /api/po-accept/:token/respond ────────────────────────────────────
router.post("/po-accept/:token/respond", async (req, res) => {
  const { token } = req.params;
  if (!token || token.length > 200) {
    res.status(400).json({ error: "Invalid token" });
    return;
  }

  if (!checkRateLimit(`post:${token}`)) {
    res.status(429).json({ error: "Too many requests. Please try again later." });
    return;
  }

  // Accept `action` as the primary field; fall back to legacy `decision` for backward compat.
  const { action: actionField, decision: decisionField, responder_name, responder_contact, notes } = req.body ?? {};
  const action = (actionField ?? decisionField) as string | undefined;

  const VALID_ACTIONS = ["accepted", "declined", "changes_requested"] as const;
  type ValidAction = (typeof VALID_ACTIONS)[number];

  if (!action || !(VALID_ACTIONS as readonly string[]).includes(action)) {
    res.status(400).json({ error: "action must be one of: accepted, declined, changes_requested" });
    return;
  }

  const typedAction = action as ValidAction;

  const acceptanceResult = await db.query<{
    id: number;
    purchase_order_id: number;
    workspace_owner_id: string;
    status: string;
    invalidated_at: string | null;
    is_expired: boolean;
  }>(
    `SELECT id, purchase_order_id, workspace_owner_id, status, invalidated_at,
            (created_at < now() - interval '${TOKEN_EXPIRY_DAYS} days') AS is_expired
       FROM purchase_order_acceptances WHERE token = $1`,
    [token],
  );

  if (acceptanceResult.rowCount === 0) {
    res.status(404).json({ error: "Acceptance link not found or expired" });
    return;
  }

  const acceptance = acceptanceResult.rows[0];

  if (acceptance.is_expired) {
    res.status(410).json({ error: "This acceptance link has expired. Please contact the buyer for a new link." });
    return;
  }

  if (acceptance.invalidated_at != null) {
    res.status(409).json({ error: "This acceptance link has been invalidated. Please contact the buyer for a new link." });
    return;
  }

  if (acceptance.status !== "pending") {
    const pastTense = acceptance.status === "changes_requested"
      ? "responded to with a changes request"
      : acceptance.status;
    res.status(409).json({ error: `This order has already been ${pastTense}.` });
    return;
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `UPDATE purchase_order_acceptances
          SET status = $1, responded_at = now(),
              response_method = 'link',
              responder_name = $2, responder_contact = $3, notes = $4
        WHERE id = $5`,
      [
        typedAction,
        responder_name ? String(responder_name).trim() || null : null,
        responder_contact ? String(responder_contact).trim() || null : null,
        notes ? String(notes).trim() || null : null,
        acceptance.id,
      ],
    );

    if (typedAction === "accepted") {
      await client.query(
        `UPDATE purchase_orders
            SET status = 'supplier_accepted', accepted_at = now(), updated_at = now()
          WHERE id = $1 AND workspace_owner_id = $2 AND status IN ('sent', 'pending_approval', 'approved')`,
        [acceptance.purchase_order_id, acceptance.workspace_owner_id],
      );

      await client.query(
        `INSERT INTO purchase_order_activity
           (purchase_order_id, workspace_owner_id, event_type, description, metadata)
         VALUES ($1, $2, 'po_supplier_accepted', $3, $4)`,
        [
          acceptance.purchase_order_id,
          acceptance.workspace_owner_id,
          `Supplier accepted the purchase order via acceptance link.`,
          JSON.stringify({
            acceptance_id: acceptance.id,
            responder_name: responder_name || null,
            method: "link",
          }),
        ],
      );
    } else if (typedAction === "changes_requested") {
      // Supplier requests changes: do NOT advance PO status, but flag acceptance_invalidated_at
      // so the team knows to edit the PO and resend a fresh link.
      await client.query(
        `UPDATE purchase_orders
            SET acceptance_invalidated_at = now(), updated_at = now()
          WHERE id = $1 AND workspace_owner_id = $2`,
        [acceptance.purchase_order_id, acceptance.workspace_owner_id],
      );

      await client.query(
        `INSERT INTO purchase_order_activity
           (purchase_order_id, workspace_owner_id, event_type, description, metadata)
         VALUES ($1, $2, 'po_supplier_changes_requested', $3, $4)`,
        [
          acceptance.purchase_order_id,
          acceptance.workspace_owner_id,
          `Supplier requested changes to the purchase order via acceptance link.`,
          JSON.stringify({
            acceptance_id: acceptance.id,
            responder_name: responder_name || null,
            method: "link",
            notes: notes || null,
          }),
        ],
      );
    } else {
      // declined
      await client.query(
        `INSERT INTO purchase_order_activity
           (purchase_order_id, workspace_owner_id, event_type, description, metadata)
         VALUES ($1, $2, 'po_supplier_declined', $3, $4)`,
        [
          acceptance.purchase_order_id,
          acceptance.workspace_owner_id,
          `Supplier declined the purchase order via acceptance link.`,
          JSON.stringify({
            acceptance_id: acceptance.id,
            responder_name: responder_name || null,
            method: "link",
          }),
        ],
      );
    }

    await client.query("COMMIT");
    res.json({ ok: true, action: typedAction });
  } catch (err) {
    await client.query("ROLLBACK");
    logger.error({ err }, "Failed to record supplier acceptance response");
    throw err;
  } finally {
    client.release();
  }
});

export default router;
