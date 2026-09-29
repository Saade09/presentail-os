import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { db } from "../../lib/db";
import {
  upsertContact,
  refreshPhonePlaceholderContactAfterFirstOrder,
} from "../../lib/contactUpsert";
import { currencyDecimals, computeLineTotal, applyRounding } from "@workspace/money";
import { logger } from "../../lib/logger";
import {
  syncTookanDestinationForOrder,
  tookanDestinationsEqual,
} from "../../lib/tookan";

const router = Router();

const lineItemSchema = z.object({
  product_id: z.number().int().optional().nullable(),
  external_product_id: z.string().optional().nullable(),
  sku: z.string().optional().nullable(),
  name: z.string(),
  quantity: z.number().int().positive().default(1),
  unit_price: z.string().optional().nullable(),
  total: z.string().optional().nullable(),
  // Actual charged per-item price in the customer's paid currency (optional;
  // the paid currency itself comes from payment.currency).
  paid_unit_price: z.number().min(0).optional().nullable(),
  image_url: z.string().optional().nullable(),
  options: z.unknown().optional(),
  metadata: z.unknown().optional(),
});

const contactRefSchema = z.object({
  role: z.string().default("customer"),
  source: z.string().optional().nullable(),
  external_contact_id: z.string().optional().nullable(),
  account_id: z.string().optional().nullable(),
  is_guest: z.boolean().optional(),
  first_name: z.string().optional().nullable(),
  last_name: z.string().optional().nullable(),
  display_name: z.string().optional().nullable(),
  email: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  tags: z.array(z.string()).optional(),
});

const orderBodySchema = z.object({
  workspace_owner_id: z.string().min(1),
  source: z.string().optional().default("native"),
  external_order_id: z.string().optional().nullable(),
  external_order_number: z.string().optional().nullable(),
  idempotency_key: z.string().optional().nullable(),
  order_number: z.string().optional().nullable(),
  display_order_number: z.string().optional().nullable(),
  status: z.string().optional().default("pending"),
  ordered_at: z.string().datetime().optional().nullable(),
  delivery_type: z.string().optional().nullable(),
  delivery_date: z.string().optional().nullable(),
  window_start: z.string().optional().nullable(),
  window_end: z.string().optional().nullable(),
  delivery_address_status: z.string().optional().nullable(),
  delivery_address: z.unknown().optional().nullable(),
  delivery_instructions: z.string().optional().nullable(),
  card_message: z.unknown().optional().nullable(),
  totals: z.unknown().optional().nullable(),
  raw_payload: z.unknown().optional().nullable(),
  contacts: z.array(contactRefSchema).optional(),
  line_items: z.array(lineItemSchema).optional(),
  payment: z
    .object({
      status: z.string().default("pending"),
      method: z.string().optional().nullable(),
      provider: z.string().optional().nullable(),
      reference: z.string().optional().nullable(),
      paid_at: z.string().datetime().optional().nullable(),
      currency: z.string().optional().nullable(),
      // The amount actually charged in `currency` (the paid-currency total).
      paid_total: z.number().min(0).optional().nullable(),
      // Order-level breakdown in the paid currency.
      paid_subtotal: z.number().min(0).optional().nullable(),
      paid_delivery_fee: z.number().min(0).optional().nullable(),
      paid_discount: z.number().min(0).optional().nullable(),
      paid_tax: z.number().min(0).optional().nullable(),
      // The exchange rate applied at checkout (paid / USD). When present and
      // no explicit paid_total is supplied, paid amounts are derived as
      // USD values × exchange_rate.
      exchange_rate: z.number().positive().optional().nullable(),
    })
    .optional()
    .nullable(),
  notes: z
    .object({
      customer_note: z.string().optional().nullable(),
      florist_note: z.string().optional().nullable(),
      driver_note: z.string().optional().nullable(),
      internal_note: z.string().optional().nullable(),
    })
    .optional()
    .nullable(),
});

type OrderRow = {
  id: string;
  was_inserted: boolean;
  previous_delivery_address?: Record<string, unknown> | null;
};

router.post("/orders", async (req: Request, res: Response): Promise<void> => {
  const parsed = orderBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
    return;
  }
  const d = parsed.data;

  // ── Resolve effective currency ──────────────────────────────────────────────
  // Prefer explicit payment.currency, then fall back to totals.currency (e.g.
  // Lebanon storefront sends totals.currency="AED" but omits payment.currency).
  const rawEffectiveCurrency =
    d.payment?.currency ??
    (d.totals != null && typeof (d.totals as Record<string, unknown>).currency === "string"
      ? (d.totals as Record<string, unknown>).currency as string
      : null);
  const effectiveCurrency = rawEffectiveCurrency?.trim().toUpperCase() ?? null;

  // ── Build paid-currency augmented totals JSON ──────────────────────────────
  // When the order is charged in a non-USD currency, merge the paid pair into
  // the stored totals JSON so the dashboard and emails can show the actual
  // amount the customer paid. The USD figures already in totals are preserved.
  let totalsForStorage: Record<string, unknown> | null = null;
  if (d.totals != null && typeof d.totals === "object") {
    totalsForStorage = { ...(d.totals as Record<string, unknown>) };
  } else if (d.totals != null) {
    totalsForStorage = { value: d.totals } as Record<string, unknown>;
  }

  if (effectiveCurrency && effectiveCurrency !== "USD" && d.payment) {
    const p = d.payment;
    // Explicit paid_total takes highest priority.
    let paidTotal: number | null = typeof p.paid_total === "number" && Number.isFinite(p.paid_total)
      ? p.paid_total
      : null;

    // Derive paid_total from breakdown if not explicit.
    if (paidTotal == null && typeof p.paid_subtotal === "number" && Number.isFinite(p.paid_subtotal)) {
      const sub = p.paid_subtotal;
      const fee = typeof p.paid_delivery_fee === "number" ? p.paid_delivery_fee : 0;
      const disc = typeof p.paid_discount === "number" ? p.paid_discount : 0;
      const tax = typeof p.paid_tax === "number" ? p.paid_tax : 0;
      paidTotal = applyRounding(sub + fee - disc + tax, effectiveCurrency);
    }

    // Derive from exchange_rate × USD total as last resort.
    if (paidTotal == null && typeof p.exchange_rate === "number" && Number.isFinite(p.exchange_rate)) {
      const totalsObj = totalsForStorage ?? {};
      const usdTotalRaw = totalsObj.total ?? totalsObj.grand_total;
      const usdTotal = typeof usdTotalRaw === "number" ? usdTotalRaw : null;
      if (usdTotal != null) {
        paidTotal = applyRounding(usdTotal * p.exchange_rate, effectiveCurrency);
      }
    }

    if (paidTotal != null) {
      if (totalsForStorage == null) totalsForStorage = {};
      totalsForStorage.paid_total = paidTotal;
      totalsForStorage.paid_currency = effectiveCurrency;
      if (typeof p.paid_subtotal === "number") totalsForStorage.paid_subtotal = p.paid_subtotal;
      if (typeof p.paid_delivery_fee === "number") totalsForStorage.paid_shipping = p.paid_delivery_fee;
      if (typeof p.paid_discount === "number") totalsForStorage.paid_discount = p.paid_discount;
      if (typeof p.paid_tax === "number") totalsForStorage.paid_tax = p.paid_tax;
      if (typeof p.exchange_rate === "number") totalsForStorage.exchange_rate = p.exchange_rate;
    }
  }

  const inserted = await db.query<OrderRow>(
    `WITH existing AS (
       SELECT id, delivery_address
         FROM orders
        WHERE workspace_owner_id = $1
          AND source = $2
          AND external_order_id = $3
        LIMIT 1
     ), upsert AS (
     INSERT INTO orders
       (workspace_owner_id, source, external_order_id, external_order_number,
        idempotency_key, order_number, display_order_number, status,
        ordered_at, delivery_type, delivery_date, window_start, window_end,
        delivery_address_status, delivery_address, delivery_instructions,
        card_message, totals, raw_payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     ON CONFLICT (workspace_owner_id, source, external_order_id)
       WHERE external_order_id IS NOT NULL
       DO UPDATE SET
         status              = EXCLUDED.status,
         ordered_at          = COALESCE(EXCLUDED.ordered_at, orders.ordered_at),
         delivery_address    = COALESCE(EXCLUDED.delivery_address, orders.delivery_address),
         totals              = COALESCE(EXCLUDED.totals, orders.totals),
         raw_payload         = COALESCE(EXCLUDED.raw_payload, orders.raw_payload),
         updated_at          = now()
       RETURNING id, (xmax = 0) AS was_inserted
     )
     SELECT upsert.id, upsert.was_inserted,
            existing.delivery_address AS previous_delivery_address
       FROM upsert
  LEFT JOIN existing ON existing.id = upsert.id`,
    [
      d.workspace_owner_id,
      d.source ?? "native",
      d.external_order_id ?? null,
      d.external_order_number ?? null,
      d.idempotency_key ?? null,
      d.order_number ?? null,
      d.display_order_number ?? null,
      d.status ?? "pending",
      d.ordered_at ?? null,
      d.delivery_type ?? null,
      d.delivery_date ?? null,
      d.window_start ?? null,
      d.window_end ?? null,
      d.delivery_address_status ?? null,
      d.delivery_address ? JSON.stringify(d.delivery_address) : null,
      d.delivery_instructions ?? null,
      d.card_message ? JSON.stringify(d.card_message) : null,
      totalsForStorage != null ? JSON.stringify(totalsForStorage) : null,
      d.raw_payload ? JSON.stringify(d.raw_payload) : null,
    ],
  );
  const orderId = inserted.rows[0]?.id;
  if (!orderId) {
    res.status(500).json({ error: "Failed to create order" });
    return;
  }
  if (
    !inserted.rows[0]?.was_inserted
    && d.delivery_address != null
    && !tookanDestinationsEqual(
      inserted.rows[0]?.previous_delivery_address ?? null,
      d.delivery_address as Record<string, unknown> | null,
    )
  ) {
    void syncTookanDestinationForOrder(orderId, d.workspace_owner_id).catch((err) => {
      logger.warn(
        { orderId, workspaceOwnerId: d.workspace_owner_id, err },
        "tookan: failed to sync v1 order destination after idempotent ingest",
      );
    });
  }

  let customerContactForRepair: {
    contactId: string;
    firstName: string | null;
    lastName: string | null;
    displayName: string | null;
  } | null = null;
  if (d.contacts && d.contacts.length > 0) {
    for (const c of d.contacts) {
      const contactId = await upsertContact({
        workspaceOwnerId: d.workspace_owner_id,
        source: c.source,
        externalContactId: c.external_contact_id,
        accountId: c.account_id,
        isGuest: c.is_guest,
        firstName: c.first_name,
        lastName: c.last_name,
        displayName: c.display_name,
        email: c.email,
        phone: c.phone,
        tags: c.tags,
      });
      if (contactId) {
        if ((c.role ?? "customer") === "customer" && !customerContactForRepair) {
          customerContactForRepair = {
            contactId,
            firstName: c.first_name ?? null,
            lastName: c.last_name ?? null,
            displayName: c.display_name ?? null,
          };
        }
        await db.query(
          `INSERT INTO order_contacts (order_id, contact_id, role)
           VALUES ($1, $2, $3)
           ON CONFLICT (order_id, contact_id, role) DO NOTHING`,
          [orderId, contactId, c.role ?? "customer"],
        );
      }
    }
  }

  if (d.line_items && d.line_items.length > 0) {
    await db.query(`DELETE FROM order_line_items WHERE order_id = $1`, [orderId]);
    for (const li of d.line_items) {
      const qty = li.quantity ?? 1;
      // Compute paid line total using integer arithmetic to avoid floating-point
      // errors, respecting the currency's decimal rule (0 for JPY, 3 for KWD, 2 for most).
      const paidUnitPriceNum = typeof li.paid_unit_price === "number" ? li.paid_unit_price : null;
      const paidLineTotalStr =
        paidUnitPriceNum != null
          ? computeLineTotal(paidUnitPriceNum, qty, effectiveCurrency ?? "USD")
          : null;
      await db.query(
        `INSERT INTO order_line_items
           (order_id, product_id, external_id, sku, name, quantity,
            unit_price, line_total, image_url, options, metadata,
            paid_unit_price, paid_line_total)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          orderId,
          li.product_id ?? null,
          li.external_product_id ?? null,
          li.sku ?? null,
          li.name,
          qty,
          li.unit_price ?? null,
          li.total ?? null,
          li.image_url ?? null,
          li.options ? JSON.stringify(li.options) : null,
          li.metadata ? JSON.stringify(li.metadata) : null,
          paidUnitPriceNum != null ? String(paidUnitPriceNum) : null,
          paidLineTotalStr,
        ],
      );
    }
  }

  if (d.payment) {
    // Determine the paid-currency amount for order_payment.amount so the
    // (currency, amount) pair is always consistent.
    const paidTotalForPayment =
      effectiveCurrency && effectiveCurrency !== "USD"
        ? (() => {
            // Prefer the explicit paid_total; fall back to what we computed for totals.
            if (typeof d.payment!.paid_total === "number") return d.payment!.paid_total;
            const computed = totalsForStorage?.paid_total;
            return typeof computed === "number" ? computed : null;
          })()
        : null;

    await db.query(
      `INSERT INTO order_payment (order_id, status, method, provider, provider_ref, paid_at, currency, amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (order_id) DO UPDATE SET
         status       = EXCLUDED.status,
         method       = COALESCE(EXCLUDED.method, order_payment.method),
         provider     = COALESCE(EXCLUDED.provider, order_payment.provider),
         provider_ref = COALESCE(EXCLUDED.provider_ref, order_payment.provider_ref),
         paid_at      = COALESCE(EXCLUDED.paid_at, order_payment.paid_at),
         currency     = COALESCE(EXCLUDED.currency, order_payment.currency),
         amount       = COALESCE(EXCLUDED.amount, order_payment.amount)`,
      [
        orderId,
        d.payment.status ?? "pending",
        d.payment.method ?? null,
        d.payment.provider ?? null,
        d.payment.reference ?? null,
        d.payment.paid_at ?? null,
        effectiveCurrency ?? null,
        paidTotalForPayment,
      ],
    );
  }

  if (d.notes) {
    await db.query(
      `INSERT INTO order_notes (order_id, customer_note, florist_note, driver_note, internal_note)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (order_id) DO UPDATE SET
         customer_note = COALESCE(EXCLUDED.customer_note, order_notes.customer_note),
         florist_note  = COALESCE(EXCLUDED.florist_note,  order_notes.florist_note),
         driver_note   = COALESCE(EXCLUDED.driver_note,   order_notes.driver_note),
         internal_note = COALESCE(EXCLUDED.internal_note, order_notes.internal_note)`,
      [
        orderId,
        d.notes.customer_note ?? null,
        d.notes.florist_note ?? null,
        d.notes.driver_note ?? null,
        d.notes.internal_note ?? null,
      ],
    );
  }

  if (inserted.rows[0]?.was_inserted === true && customerContactForRepair) {
    void refreshPhonePlaceholderContactAfterFirstOrder({
      workspaceOwnerId: d.workspace_owner_id,
      contactId: customerContactForRepair.contactId,
      orderId,
      buyer: {
        firstName: customerContactForRepair.firstName,
        lastName: customerContactForRepair.lastName,
        displayName: customerContactForRepair.displayName,
      },
    });
  }

  res.status(201).json({ success: true, id: orderId });
});

router.get("/orders/by-external-id/:source/:externalOrderId", async (req: Request, res: Response): Promise<void> => {
  const { source, externalOrderId } = req.params;
  const workspaceOwnerId = typeof req.query.workspace_owner_id === "string" ? req.query.workspace_owner_id : null;
  if (!workspaceOwnerId) {
    res.status(400).json({ error: "workspace_owner_id query param required" });
    return;
  }
  const r = await db.query(
    `SELECT o.*, n.customer_note, n.florist_note, n.driver_note, n.internal_note,
            p.status AS payment_status, p.method AS payment_method,
            p.provider AS payment_provider, p.provider_ref AS payment_reference, p.paid_at
       FROM orders o
       LEFT JOIN order_notes n ON n.order_id = o.id
       LEFT JOIN order_payment p ON p.order_id = o.id
      WHERE o.workspace_owner_id = $1 AND o.source = $2 AND o.external_order_id = $3
      LIMIT 1`,
    [workspaceOwnerId, source, externalOrderId],
  );
  if (r.rowCount === 0) {
    res.status(404).json({ error: "Order not found" });
    return;
  }
  res.json({ success: true, order: r.rows[0] });
});

router.get("/orders/:id", async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const workspaceOwnerId = typeof req.query.workspace_owner_id === "string" ? req.query.workspace_owner_id : null;
  if (!workspaceOwnerId) {
    res.status(400).json({ error: "workspace_owner_id query param required" });
    return;
  }
  const r = await db.query(
    `SELECT o.*, n.customer_note, n.florist_note, n.driver_note, n.internal_note,
            p.status AS payment_status, p.method AS payment_method,
            p.provider AS payment_provider, p.provider_ref AS payment_reference, p.paid_at
       FROM orders o
       LEFT JOIN order_notes n ON n.order_id = o.id
       LEFT JOIN order_payment p ON p.order_id = o.id
      WHERE o.id = $1 AND o.workspace_owner_id = $2
      LIMIT 1`,
    [id, workspaceOwnerId],
  );
  if (r.rowCount === 0) {
    res.status(404).json({ error: "Order not found" });
    return;
  }
  const lineItems = await db.query(
    `SELECT * FROM order_line_items WHERE order_id = $1 ORDER BY id`,
    [id],
  );
  const contacts = await db.query(
    `SELECT oc.role, c.id AS contact_id, c.first_name, c.last_name,
            c.display_name, c.email, c.phone
       FROM order_contacts oc
       JOIN contacts c ON c.id = oc.contact_id
      WHERE oc.order_id = $1`,
    [id],
  );
  res.json({
    success: true,
    order: r.rows[0],
    line_items: lineItems.rows,
    contacts: contacts.rows,
  });
});

export default router;
