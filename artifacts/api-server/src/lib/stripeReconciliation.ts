import Stripe from "stripe";
import { db } from "./db";
import { logger } from "./logger";
import { refreshOrderPaymentSummaryForLink } from "./paymentLinkOrder";

/** Minimal shape a payment link row must have to be reconciled. */
export type ReconcilableLink = {
  id: number;
  provider: string;
  status: string;
  provider_link_id: string | null;
};

export type ReconcileResult = {
  paid: boolean;
  /** paid_at timestamp returned by the UPDATE, when the row was flipped. */
  paidAt: string | null;
};

/** Only reconcile the N most recent active links per dashboard request. */
export const RECONCILE_MAX_LINKS = 20;

/** How many Stripe API calls to run in parallel during bulk reconciliation. */
export const RECONCILE_CONCURRENCY = 5;

function getStripeClient(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  return new Stripe(key, { apiVersion: "2026-04-22.dahlia" });
}

/**
 * Returns true when the link is an active Stripe link with a stored checkout
 * session id — i.e. something we can reconcile against Stripe.
 */
export function isReconcilable(link: ReconcilableLink): boolean {
  return (
    link.provider === "stripe" &&
    link.status === "active" &&
    typeof link.provider_link_id === "string" &&
    link.provider_link_id.length > 0
  );
}

/**
 * Checks Stripe directly for an active Stripe payment link and marks it paid
 * in the database when Stripe reports the checkout session as paid.
 *
 * Fail-open by design: any Stripe API error (network, auth, unknown session)
 * is logged and leaves the link status unchanged.
 */
export async function reconcileStripeLink(
  link: ReconcilableLink,
): Promise<ReconcileResult> {
  if (!isReconcilable(link)) return { paid: false, paidAt: null };

  const stripe = getStripeClient();
  if (!stripe) return { paid: false, paidAt: null };

  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.retrieve(link.provider_link_id as string);
  } catch (err) {
    logger.warn(
      { err, linkId: link.id, sessionId: link.provider_link_id },
      "Stripe reconciliation: failed to retrieve checkout session; leaving link unchanged",
    );
    return { paid: false, paidAt: null };
  }

  if (session.payment_status !== "paid") {
    return { paid: false, paidAt: null };
  }

  try {
    const result = await db.query<{ paid_at: string }>(
      `WITH updated AS (
         UPDATE payment_links
            SET status = 'paid', paid_at = now()
          WHERE id = $1 AND status = 'active'
          RETURNING *
       ), queued AS (
         INSERT INTO payment_link_conversions
           (payment_link_id, transaction_id, destination_country, click_id_type,
            click_id, conversion_value, currency, conversion_time)
         SELECT id, 'payment-link:' || id, upper(country), google_click_id_type,
                google_click_id, amount::numeric / 100, currency, paid_at
           FROM updated
          WHERE country IS NOT NULL AND google_click_id IS NOT NULL
         ON CONFLICT (transaction_id) DO NOTHING
       )
       SELECT paid_at FROM updated`,
      [link.id],
    );
    const updated = (result.rowCount ?? 0) > 0;
    if (updated) {
      await refreshOrderPaymentSummaryForLink(link.id);
      logger.info(
        { linkId: link.id, sessionId: link.provider_link_id, rowCount: result.rowCount },
        "Payment link marked as paid via Stripe reconciliation",
      );
      return { paid: true, paidAt: result.rows[0]?.paid_at ?? null };
    }
    return { paid: false, paidAt: null };
  } catch (err) {
    logger.warn(
      { err, linkId: link.id },
      "Stripe reconciliation: DB update failed; leaving link unchanged",
    );
    return { paid: false, paidAt: null };
  }
}

/**
 * Best-effort bulk reconciliation for dashboard views. Filters the given rows
 * to reconcilable Stripe links, caps them at RECONCILE_MAX_LINKS (rows are
 * assumed newest-first), and runs Stripe checks in small parallel batches.
 *
 * Returns a map of link id → paid_at for every link flipped to paid so the
 * caller can patch already-fetched rows in memory without re-querying.
 */
export async function reconcileActiveStripeLinks(
  links: ReconcilableLink[],
): Promise<Map<number, string | null>> {
  const candidates = links.filter(isReconcilable).slice(0, RECONCILE_MAX_LINKS);
  const flipped = new Map<number, string | null>();
  if (candidates.length === 0) return flipped;

  for (let i = 0; i < candidates.length; i += RECONCILE_CONCURRENCY) {
    const batch = candidates.slice(i, i + RECONCILE_CONCURRENCY);
    const results = await Promise.allSettled(batch.map((l) => reconcileStripeLink(l)));
    results.forEach((r, idx) => {
      if (r.status === "fulfilled" && r.value.paid) {
        flipped.set(batch[idx].id, r.value.paidAt);
      }
    });
  }
  return flipped;
}
