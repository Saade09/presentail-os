import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { db } from "../lib/db";
import { requireApiKey, type ApiKeyAuthedRequest } from "../lib/apiKeyAuth";
import {
  upsertContact,
  refreshPhonePlaceholderContactAfterFirstOrder,
} from "../lib/contactUpsert";
import { broadcastEvent } from "../lib/eventsSse";
import { notifyNewOrderAlerts } from "../lib/orderAlerts";
import { fireWebhookEvent } from "../lib/catalogWebhook";
import { logger } from "../lib/logger";

const router = Router();

// ── Zod schema for Toters extension payload ────────────────────────────────

const totersLineItemSchema = z.object({
  qty: z.string().nullable().optional(),
  name: z.string().min(1),
  options: z.string().nullable().optional(),
  price: z.string().nullable().optional(),
  total: z.string().nullable().optional(),
});

const totersBodySchema = z.object({
  platform: z.string().nullable().optional(),
  capturedAt: z.string().nullable().optional(),
  pageUrl: z.string().nullable().optional(),
  order: z.object({
    orderNumber: z.string().nullable().optional(),
    orderStatus: z.string().nullable().optional(),
    placedAt: z.string().nullable().optional(),
    prepareBy: z.string().nullable().optional(),
    shopperStatus: z.string().nullable().optional(),
  }).nullable().optional(),
  customer: z.object({
    customerName: z.string().nullable().optional(),
    customerPhone: z.string().nullable().optional(),
    customerUniqueId: z.string().nullable().optional(),
  }).nullable().optional(),
  storeAndDelivery: z.object({
    storeName: z.string().nullable().optional(),
    deliveryAddress: z.string().nullable().optional(),
  }).nullable().optional(),
  totals: z.object({
    currency: z.string().nullable().optional(),
    itemsTotal: z.string().nullable().optional(),
    discount: z.string().nullable().optional(),
    finalTotal: z.string().nullable().optional(),
  }).nullable().optional(),
  lineItems: z.array(totersLineItemSchema).min(1, "lineItems must have at least one item"),
  notes: z.string().nullable().optional(),
});

type OrderRow = { id: string; was_inserted: boolean };

function parseName(name: string | null | undefined): { firstName: string | null; lastName: string | null } {
  if (!name) return { firstName: null, lastName: null };
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0] ?? null, lastName: null };
  return {
    firstName: parts.slice(0, -1).join(" "),
    lastName: parts.at(-1) ?? null,
  };
}

function parseAmount(str: string | null | undefined): number | null {
  if (!str) return null;
  const n = parseFloat(str.replace(/[^0-9.\-]/g, ""));
  return isNaN(n) ? null : n;
}

/**
 * POST /api/orders/import-toters
 *
 * Ingests a structured order payload captured by the Presentail Order Capture
 * Chrome extension from the Toters Merchant Admin portal. Authenticated via
 * workspace API key (Bearer pk_live_*).
 *
 * Idempotent on orderNumber: re-submitting the same Toters order number
 * returns the existing order_id without duplicating data.
 *
 * Success: HTTP 201 { success: true, order_id: "<uuid>" }   (new order)
 *          HTTP 200 { success: true, order_id: "<uuid>" }   (duplicate)
 * Failure: HTTP 400 { success: false, error: "<message>" }
 *          HTTP 401 { error: "<message>" }
 *          HTTP 500 { success: false, error: "<message>" }
 */
router.post(
  "/orders/import-toters",
  requireApiKey,
  async (req: Request, res: Response): Promise<void> => {
    const parsed = totersBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: parsed.error.issues[0]?.message ?? "Invalid input",
      });
      return;
    }

    const d = parsed.data;
    const ownerId = (req as ApiKeyAuthedRequest).userId;

    const externalOrderId = d.order?.orderNumber ?? null;

    // ── Contact upsert ───────────────────────────────────────────────────────
    let billingContactId: string | null = null;
    if (d.customer?.customerName || d.customer?.customerPhone) {
      const { firstName, lastName } = parseName(d.customer.customerName);
      billingContactId = await upsertContact({
        workspaceOwnerId: ownerId,
        source: "toters",
        firstName,
        lastName,
        displayName: d.customer.customerName ?? null,
        email: null,
        phone: d.customer.customerPhone ?? null,
      });
    }

    // ── Totals ───────────────────────────────────────────────────────────────
    const currency = d.totals?.currency ?? "USD";
    const finalTotal = parseAmount(d.totals?.finalTotal);
    const itemsTotal = parseAmount(d.totals?.itemsTotal);
    const discount = parseAmount(d.totals?.discount);
    const totalsJson: Record<string, unknown> = {
      subtotal: itemsTotal,
      discount,
      total: finalTotal,
      currency,
    };

    // ── Delivery address JSON ────────────────────────────────────────────────
    const deliveryAddressJson: Record<string, unknown> = {
      address: d.storeAndDelivery?.deliveryAddress ?? null,
      storeName: d.storeAndDelivery?.storeName ?? null,
    };

    // ── Atomic order creation ────────────────────────────────────────────────
    const client = await db.connect();
    let orderId = "";
    let wasInserted = false;
    try {
      await client.query("BEGIN");

      const insertResult = await client.query<OrderRow>(
        `INSERT INTO orders
           (workspace_owner_id, source, external_order_id, status,
            ordered_at, delivery_address, delivery_type, delivery_instructions,
            totals, raw_payload)
         VALUES ($1, 'toters', $2, 'pending', $3, $4, $5, $6, $7, $8)
         ON CONFLICT (workspace_owner_id, source, external_order_id)
           WHERE external_order_id IS NOT NULL
           DO UPDATE SET
             ordered_at            = COALESCE(EXCLUDED.ordered_at, orders.ordered_at),
             delivery_address      = COALESCE(EXCLUDED.delivery_address, orders.delivery_address),
             totals                = EXCLUDED.totals,
             raw_payload           = EXCLUDED.raw_payload,
             updated_at            = now()
         RETURNING id, (xmax = 0) AS was_inserted`,
        [
          ownerId,
          externalOrderId,
          d.capturedAt ? new Date(d.capturedAt).toISOString() : new Date().toISOString(),
          JSON.stringify(deliveryAddressJson),
          "standard",
          d.notes ?? null,
          JSON.stringify(totalsJson),
          JSON.stringify({ ...req.body, _platform: "toters" }),
        ],
      );

      const orderRow = insertResult.rows[0];
      if (!orderRow) {
        await client.query("ROLLBACK");
        res.status(500).json({ success: false, error: "Failed to create order" });
        return;
      }
      orderId = orderRow.id;
      wasInserted = orderRow.was_inserted;

      if (wasInserted) {
        // Line items
        for (const item of d.lineItems) {
          const unitPrice = parseAmount(item.price);
          const totalPrice = parseAmount(item.total);
          const qty = item.qty ? parseInt(item.qty, 10) : 1;
          const name = item.options
            ? `${item.name} (${item.options})`
            : item.name;

          await client.query(
            `INSERT INTO order_line_items (order_id, sku, name, quantity, unit_price, line_total)
             VALUES ($1, NULL, $2, $3, $4, $5)`,
            [
              orderId,
              name,
              isNaN(qty) ? 1 : qty,
              unitPrice != null ? String(unitPrice) : null,
              totalPrice != null ? String(totalPrice) : (unitPrice != null ? String(unitPrice * (isNaN(qty) ? 1 : qty)) : null),
            ],
          );
        }

        // Billing contact
        if (billingContactId) {
          await client.query(
            `INSERT INTO order_contacts (order_id, contact_id, role)
             VALUES ($1, $2, 'customer')
             ON CONFLICT DO NOTHING`,
            [orderId, billingContactId],
          );
        }

        // Payment record (COD assumed for Toters unless totals say otherwise)
        await client.query(
          `INSERT INTO order_payment (order_id, method, provider, provider_ref, status)
           VALUES ($1, $2, NULL, NULL, 'pending')
           ON CONFLICT (order_id) DO NOTHING`,
          [orderId, "cash"],
        );

        // Order notes
        if (d.notes) {
          await client.query(
            `INSERT INTO order_notes (order_id, customer_note)
             VALUES ($1, $2)
             ON CONFLICT (order_id) DO UPDATE SET customer_note = EXCLUDED.customer_note`,
            [orderId, d.notes],
          );
        }
      }

      await client.query("COMMIT");
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch { /* swallow */ }
      logger.error({ err }, "importToters: failed to create order");
      res.status(500).json({ success: false, error: "Failed to create order" });
      return;
    } finally {
      client.release();
    }

    if (wasInserted) {
      if (billingContactId) {
        const { firstName, lastName } = parseName(d.customer?.customerName);
        void refreshPhonePlaceholderContactAfterFirstOrder({
          workspaceOwnerId: ownerId,
          contactId: billingContactId,
          orderId,
          buyer: {
            firstName,
            lastName,
            displayName: d.customer?.customerName ?? null,
          },
        });
      }
      broadcastEvent(ownerId, {
        event: "order.created",
        workspaceId: ownerId,
        data: { id: orderId, source: "toters" },
      });
      void notifyNewOrderAlerts(ownerId, orderId);
    }

    void fireWebhookEvent(wasInserted ? "order.created" : "order.updated", ownerId, {
      order_id: orderId,
      external_order_id: externalOrderId,
      source: "toters",
    });

    res.status(wasInserted ? 201 : 200).json({ success: true, order_id: orderId });
  },
);

export default router;
