import { db } from "./db";
import { logger } from "./logger";

/**
 * Idempotent startup backfill (Aug 2026): link CMC-originated orders to
 * CMC Sales.
 *
 * Orders created from the CMC "New Order" page (source = 'cmc-pos') get a
 * matching `cmc_sales` row (workflow_type = 'order') written inside the same
 * transaction as the order itself (see orderCreate.ts). That linking is
 * atomic for NEW orders, but it is hook-only — any cmc-pos order created
 * before the linking existed (or created while the deployed frontend was not
 * yet sending `source: "cmc-pos"`) has no sale row and is silently missing
 * from the CMC daily sales totals.
 *
 * This backfill runs on every startup and:
 *   1. Repairs the one known mis-sourced order (M-1063, Aug 13 2026): it was
 *      created from the CMC New Order flow while the deployed frontend build
 *      predated the `source: "cmc-pos"` tagging, so the server recorded it as
 *      a plain `manual` wizard order. The repair is keyed on the exact
 *      workspace + order number + creation date + current source, so it can
 *      only ever touch that one row and re-running is a no-op.
 *   2. Inserts the missing `cmc_sales` row for EVERY cmc-pos order that lacks
 *      one — copying line items / totals / payment from the order, dating the
 *      sale by the order's CREATION day (fulfilment_date = created_at::date,
 *      matching the create path), and mirroring the payment status.
 *
 * Duplicate safety: the NOT EXISTS guard plus the partial unique index
 * `cmc_sales_order_unique (order_id) WHERE order_id IS NOT NULL` (created in
 * initDb before this runs) make the insert idempotent; ON CONFLICT DO NOTHING
 * is the backstop against a concurrent create during a rolling deploy.
 */
export async function backfillCmcOrderSales(): Promise<void> {
  // ── Step 1: targeted source repair for M-1063 ─────────────────────────────
  const repaired = await db.query(
    `UPDATE orders
        SET source = 'cmc-pos',
            raw_payload = jsonb_set(COALESCE(raw_payload, '{}'::jsonb),
                                    '{created_via}', '"cmc_new_order"'),
            updated_at = now()
      WHERE workspace_owner_id = 'user_3DCcbYtdoRYrTOqHwKxb1gwXxJR'
        AND display_order_number = 'M-1063'
        AND source = 'manual'
        AND created_at::date = DATE '2026-08-13'`,
  );
  if (repaired.rowCount && repaired.rowCount > 0) {
    logger.info(
      { repaired: repaired.rowCount },
      "cmc order sales backfill: relabelled M-1063 as cmc-pos sourced",
    );
  }

  // ── Step 2: insert missing cmc_sales rows for cmc-pos orders ──────────────
  // Column mapping mirrors the create-path insert in orderCreate.ts:
  //   line_items  → same shape ({product_id,name,qty,unit_price,image_url,item_type})
  //   subtotal / discount / total → stored CMC order breakdown (gross, negative
  //   discount, net); old rows without a structured discount remain unchanged.
  //   status      → 'paid' only when the payment record says paid
  //   fulfilment_date / created_at → the order's creation moment, so the sale
  //   lands in the day the order was taken (never the delivery date).
  const inserted = await db.query(
    `INSERT INTO cmc_sales
       (workspace_owner_id, created_by_user_id, workflow_type, source_channel,
         status, order_id, line_items, subtotal, discount_amount, total,
         discount_type, discount_value, discount_description, payment_method,
        fulfilment_date, created_at)
     SELECT o.workspace_owner_id,
            'system',
            'order',
            'cmc-pos',
            CASE WHEN LOWER(TRIM(COALESCE(op.status, ''))) = 'paid'
                 THEN 'paid' ELSE 'pending' END,
            o.id,
            COALESCE(li.items, '[]'::jsonb),
             COALESCE(t.subtotal, t.total, 0),
             COALESCE(t.discount, 0),
             COALESCE(t.total, 0),
             t.discount_type,
             t.discount_value,
             t.discount_description,
            op.method,
            (o.created_at)::date,
            o.created_at
       FROM orders o
       LEFT JOIN order_payment op ON op.order_id = o.id
       LEFT JOIN LATERAL (
         SELECT CASE
                   WHEN (o.totals->>'total') ~ '^-?[0-9]+(\\.[0-9]+)?$'
                    THEN (o.totals->>'total')::numeric
                  WHEN (o.totals->>'subtotal') ~ '^-?[0-9]+(\\.[0-9]+)?$'
                    THEN (o.totals->>'subtotal')::numeric
                  ELSE NULL
                 END AS total,
                 CASE WHEN (o.totals->>'subtotal') ~ '^-?[0-9]+(\\.[0-9]+)?$'
                      THEN (o.totals->>'subtotal')::numeric ELSE NULL END AS subtotal,
                 CASE WHEN (o.totals->>'discount') ~ '^-?[0-9]+(\\.[0-9]+)?$'
                      THEN (o.totals->>'discount')::numeric ELSE 0 END AS discount,
                 NULLIF(o.totals->'cmc_discount'->>'type', '') AS discount_type,
                 CASE WHEN (o.totals->'cmc_discount'->>'value') ~ '^-?[0-9]+(\\.[0-9]+)?$'
                      THEN (o.totals->'cmc_discount'->>'value')::numeric ELSE NULL END AS discount_value,
                 NULLIF(CONCAT_WS(': ',
                   o.totals->'cmc_discount'->>'reason',
                   NULLIF(o.totals->'cmc_discount'->>'explanation', '')
                 ), '') AS discount_description
       ) t ON true
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(jsonb_build_object(
                  'product_id', CASE WHEN COALESCE(l.is_custom_item, false)
                                     THEN NULL ELSE l.product_id END,
                  'name', l.name,
                  'qty', CASE WHEN l.quantity > 0 THEN l.quantity ELSE 1 END,
                  'unit_price', COALESCE(l.unit_price, 0),
                  'image_url', l.image_url,
                  'item_type', CASE WHEN COALESCE(l.is_custom_item, false)
                                    THEN 'custom' ELSE 'shelf' END)
                ORDER BY l.created_at, l.id) AS items
           FROM order_line_items l
          WHERE l.order_id = o.id
       ) li ON true
      WHERE o.source = 'cmc-pos'
        AND NOT EXISTS (SELECT 1 FROM cmc_sales s WHERE s.order_id = o.id)
     ON CONFLICT (order_id) WHERE order_id IS NOT NULL DO NOTHING`,
  );
  if (inserted.rowCount && inserted.rowCount > 0) {
    logger.info(
      { inserted: inserted.rowCount },
      "cmc order sales backfill: created missing cmc_sales rows for cmc-pos orders",
    );
  }
}
