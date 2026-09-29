import type { PoolClient } from "pg";
import { db, withTransaction } from "./db";

export type PaymentSummary = {
  commercial_total: number | null;
  commercial_currency: string | null;
  paid: number;
  pending: number;
  remaining: number | null;
  overpaid: number;
  currency_mismatch: boolean;
  mismatched_link_ids: number[];
  status: "unpaid" | "pending" | "partially_paid" | "paid" | "overpaid" | "mismatch";
};

type MoneyRow = {
  total: unknown;
  currency: string | null;
  paid: unknown;
  pending: unknown;
  mismatched_link_ids: number[] | null;
};

function money(value: unknown): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

export function buildPaymentSummary(row: MoneyRow): PaymentSummary {
  const commercialTotal =
    row.total == null || !Number.isFinite(Number(row.total)) ? null : Number(row.total);
  const commercialCurrency = row.currency?.trim().toUpperCase() || null;
  const paid = money(row.paid);
  const pending = money(row.pending);
  const mismatched = (row.mismatched_link_ids ?? []).filter((id) => Number.isInteger(id));
  const remaining =
    commercialTotal == null ? null : Math.max(commercialTotal - paid, 0);
  const overpaid =
    commercialTotal == null ? 0 : Math.max(paid - commercialTotal, 0);
  let status: PaymentSummary["status"] = "unpaid";
  if (mismatched.length > 0) status = "mismatch";
  else if (overpaid > 0.005) status = "overpaid";
  else if (commercialTotal != null && paid >= commercialTotal - 0.005) status = "paid";
  else if (paid > 0) status = "partially_paid";
  else if (pending > 0) status = "pending";
  return {
    commercial_total: commercialTotal,
    commercial_currency: commercialCurrency,
    paid,
    pending,
    remaining,
    overpaid,
    currency_mismatch: mismatched.length > 0,
    mismatched_link_ids: mismatched,
    status,
  };
}

export async function getOrderPaymentSummary(
  queryer: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
  orderId: string,
): Promise<PaymentSummary> {
  const result = await queryer.query(
    `SELECT
       o.totals->>'total' AS total,
       UPPER(COALESCE(o.totals->>'currency', 'USD')) AS currency,
       COALESCE(SUM(CASE WHEN pl.status = 'paid'
                    AND UPPER(pl.currency) = UPPER(COALESCE(o.totals->>'currency', 'USD'))
                  THEN pl.amount / 100.0 ELSE 0 END), 0) AS paid,
       COALESCE(SUM(CASE WHEN pl.status <> 'paid'
                    AND UPPER(pl.currency) = UPPER(COALESCE(o.totals->>'currency', 'USD'))
                  THEN pl.amount / 100.0 ELSE 0 END), 0) AS pending,
       ARRAY_REMOVE(ARRAY_AGG(
         CASE WHEN UPPER(pl.currency) <> UPPER(COALESCE(o.totals->>'currency', 'USD'))
              THEN pl.id END), NULL) AS mismatched_link_ids
       FROM orders o
       LEFT JOIN payment_links pl ON pl.order_id = o.id
      WHERE o.id = $1
      GROUP BY o.id, o.totals`,
    [orderId],
  );
  const row = (result.rows[0] ?? {}) as MoneyRow;
  return buildPaymentSummary(row);
}

export async function refreshOrderPaymentSummary(
  queryer: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
  orderId: string,
): Promise<PaymentSummary> {
  const summary = await getOrderPaymentSummary(queryer, orderId);
  // Keep the historical totals untouched except for a namespaced derived
  // summary. This makes payment-link changes visible without changing the
  // commercial order total or paid-currency values supplied by the storefront.
  await queryer.query(
    `UPDATE orders
        SET totals = jsonb_set(
          COALESCE(totals, '{}'::jsonb),
          '{payment_summary}',
          $2::jsonb,
          true
        ),
        updated_at = now()
      WHERE id = $1`,
    [orderId, JSON.stringify(summary)],
  );
  return summary;
}

export async function refreshOrderPaymentSummaryForLink(linkId: number): Promise<void> {
  const result = await db.query<{ order_id: string | null }>(
    `SELECT order_id FROM payment_links WHERE id = $1`,
    [linkId],
  );
  const orderId = result.rows[0]?.order_id;
  if (orderId) await refreshOrderPaymentSummary(db, orderId);
}

export class PaymentLinkOrderError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "PaymentLinkOrderError";
  }
}

export type LinkPaymentLinkResult = {
  link_id: number;
  previous_order_id: string | null;
  order_id: string;
  reassigned: boolean;
  mismatch: boolean;
  summary: PaymentSummary;
};

async function lockLinkAndOrders(
  client: PoolClient,
  workspaceOwnerId: string,
  linkId: number,
  orderId: string,
) {
  const linkResult = await client.query<{
    id: number; order_id: string | null; amount: number; currency: string;
    status: string; description: string | null;
  }>(
    `SELECT id, order_id, amount, currency, status, description
       FROM payment_links
      WHERE id = $1 AND workspace_owner_id = $2
      FOR UPDATE`,
    [linkId, workspaceOwnerId],
  );
  const link = linkResult.rows[0];
  if (!link) throw new PaymentLinkOrderError(404, "Payment link not found");

  const orderResult = await client.query<{ id: string; totals: Record<string, unknown> | null }>(
    `SELECT id, totals FROM orders
      WHERE id = $1 AND workspace_owner_id = $2
      FOR UPDATE`,
    [orderId, workspaceOwnerId],
  );
  const order = orderResult.rows[0];
  if (!order) throw new PaymentLinkOrderError(404, "Order not found");
  return { link, order };
}

export type LinkPaymentLinkOptions = {
  workspaceOwnerId: string;
  linkId: number;
  orderId: string;
  actorUserId: string | null;
  confirmReassignment?: boolean;
  confirmMismatch?: boolean;
};

/**
 * Associate a link using an already-open transaction. This is used by manual
 * order creation so a failed validation never leaves an unlinked order behind.
 * The caller owns BEGIN/COMMIT/ROLLBACK and must not use this outside one.
 */
export async function linkPaymentLinkToOrderInTransaction(
  client: PoolClient,
  opts: LinkPaymentLinkOptions,
): Promise<LinkPaymentLinkResult> {
  const { link, order } = await lockLinkAndOrders(
    client, opts.workspaceOwnerId, opts.linkId, opts.orderId,
  );
  const previousOrderId = link.order_id;
  if (previousOrderId === opts.orderId) {
    const summary = await refreshOrderPaymentSummary(client, opts.orderId);
    return {
      link_id: link.id, previous_order_id: previousOrderId,
      order_id: opts.orderId, reassigned: false, mismatch: false, summary,
    };
  }
  if (previousOrderId && !opts.confirmReassignment) {
    throw new PaymentLinkOrderError(409, "Payment link is already linked to another order", {
      requires_confirmation: "reassignment",
      previous_order_id: previousOrderId,
    });
  }
  const totals = order.totals ?? {};
  const orderCurrency = String(totals.currency ?? "USD").toUpperCase();
  const mismatch = orderCurrency !== link.currency.toUpperCase();
  const orderTotal = Number(totals.total ?? totals.subtotal);
  const amountMismatch = Number.isFinite(orderTotal) &&
    Math.abs(orderTotal - Number(link.amount) / 100) > 0.005;
  if ((mismatch || amountMismatch) && !opts.confirmMismatch) {
    throw new PaymentLinkOrderError(409, "Payment and order totals need confirmation", {
      requires_confirmation: "mismatch",
      currency_mismatch: mismatch,
      amount_mismatch: amountMismatch,
      order_currency: orderCurrency,
      link_currency: link.currency.toUpperCase(),
      order_total: Number.isFinite(orderTotal) ? orderTotal : null,
      link_amount: Number(link.amount) / 100,
    });
  }
  await client.query(
    `UPDATE payment_links
        SET order_id = $1, linked_at = now(), linked_by_user_id = $2
      WHERE id = $3`,
    [opts.orderId, opts.actorUserId, opts.linkId],
  );
  if (previousOrderId) await refreshOrderPaymentSummary(client, previousOrderId);
  const summary = await refreshOrderPaymentSummary(client, opts.orderId);
  await client.query(
    `INSERT INTO order_events
      (workspace_owner_id, order_id, event_type, payload, actor_user_id)
     VALUES ($1, $2, 'payment_link_linked', $3::jsonb, $4)`,
    [opts.workspaceOwnerId, opts.orderId, JSON.stringify({
      payment_link_id: opts.linkId,
      previous_order_id: previousOrderId,
      new_order_id: opts.orderId,
      mismatch,
      amount_mismatch: amountMismatch,
    }), opts.actorUserId],
  );
  if (previousOrderId) {
    await client.query(
      `INSERT INTO order_events
        (workspace_owner_id, order_id, event_type, payload, actor_user_id)
       VALUES ($1, $2, 'payment_link_unlinked', $3::jsonb, $4)`,
      [opts.workspaceOwnerId, previousOrderId, JSON.stringify({
        payment_link_id: opts.linkId, new_order_id: opts.orderId,
      }), opts.actorUserId],
    );
  }
  return {
    link_id: link.id, previous_order_id: previousOrderId,
    order_id: opts.orderId, reassigned: Boolean(previousOrderId), mismatch, summary,
  };
}

export async function linkPaymentLinkToOrder(
  opts: LinkPaymentLinkOptions,
): Promise<LinkPaymentLinkResult> {
  const client = await db.connect();
  try {
    return await withTransaction(client, () => linkPaymentLinkToOrderInTransaction(client, opts));
  } finally {
    client.release();
  }
}

export async function unlinkPaymentLinkFromOrder(opts: {
  workspaceOwnerId: string;
  linkId: number;
  actorUserId: string | null;
}): Promise<{ link_id: number; order_id: string | null; summary: PaymentSummary | null }> {
  const client = await db.connect();
  try {
    return await withTransaction(client, async () => {
      const result = await client.query<{ id: number; order_id: string | null }>(
        `SELECT id, order_id FROM payment_links
          WHERE id = $1 AND workspace_owner_id = $2 FOR UPDATE`,
        [opts.linkId, opts.workspaceOwnerId],
      );
      const link = result.rows[0];
      if (!link) throw new PaymentLinkOrderError(404, "Payment link not found");
      if (!link.order_id) return { link_id: link.id, order_id: null, summary: null };
      const oldOrderId = link.order_id;
      await client.query(
        `UPDATE payment_links SET order_id = NULL, linked_at = NULL, linked_by_user_id = $1 WHERE id = $2`,
        [opts.actorUserId, opts.linkId],
      );
      const summary = await refreshOrderPaymentSummary(client, oldOrderId);
      await client.query(
        `INSERT INTO order_events
          (workspace_owner_id, order_id, event_type, payload, actor_user_id)
         VALUES ($1, $2, 'payment_link_unlinked', $3::jsonb, $4)`,
        [opts.workspaceOwnerId, oldOrderId, JSON.stringify({ payment_link_id: opts.linkId }), opts.actorUserId],
      );
      return { link_id: link.id, order_id: oldOrderId, summary };
    });
  } finally {
    client.release();
  }
}