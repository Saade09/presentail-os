import { db } from "./db";
import { logger } from "./logger";
import {
  isStripePaymentIntentRef,
  verifyStripePaymentIntentAmount,
} from "./stripeAmountVerification";
import { checkPaidPairPlausibility } from "./paidPairPlausibility";

/**
 * Idempotent startup backfill: fix existing orders that were paid in a
 * non-USD currency before the ingest captured `payment.totalAmount`.
 *
 * Historically the ingest stored the USD amount next to the foreign currency
 * code on `order_payment` and left the totals JSON USD-only, so the dashboard
 * and emails showed USD for orders actually paid in GBP/EUR/CHF/CAD. The raw
 * payload still contains the true paid amount, so this backfill:
 *
 *   - reads `raw_payload.payment.totalAmount` / `currencyCode` for orders whose
 *     payment currency differs from USD and that are missing either the
 *     `paid_total`/`paid_currency` pair in the totals JSON or the
 *     `order_payment.amount` (paid-currency amount) column
 *   - writes `paid_total` + `paid_currency` into the orders.totals JSON
 *     (keeping the existing USD figures untouched)
 *   - sets `order_payment.amount` so (currency, amount) is a consistent pair
 *
 * Safe to run on every startup — already-fixed rows are excluded by the WHERE
 * clause, and individual row failures are logged without aborting the batch.
 */
export async function backfillPaidCurrencyAmounts(): Promise<void> {
  let rows: {
    id: string;
    payment_currency: string;
    raw_payment: { totalAmount?: unknown; currencyCode?: unknown } | null;
  }[];
  try {
    const res = await db.query<{
      id: string;
      payment_currency: string;
      raw_payment: { totalAmount?: unknown; currencyCode?: unknown } | null;
    }>(
      `SELECT o.id,
              p.currency AS payment_currency,
              o.raw_payload->'payment' AS raw_payment
         FROM orders o
         JOIN order_payment p ON p.order_id = o.id
        WHERE p.currency IS NOT NULL
          AND upper(trim(p.currency)) <> 'USD'
          AND jsonb_typeof(o.raw_payload->'payment'->'totalAmount') = 'number'
          AND (p.amount IS NULL OR o.totals->>'paid_currency' IS NULL)`,
    );
    rows = res.rows;
  } catch (err) {
    logger.error({ err }, "Paid-currency backfill: query failed");
    return;
  }

  if (rows.length === 0) return;
  logger.info({ count: rows.length }, "Paid-currency backfill: starting");

  let succeeded = 0;
  for (const row of rows) {
    try {
      const rawAmount = row.raw_payment?.totalAmount;
      const paidAmount = typeof rawAmount === "number" ? rawAmount : Number(rawAmount);
      if (!Number.isFinite(paidAmount) || paidAmount < 0) continue;
      const rawCurrency = row.raw_payment?.currencyCode;
      const paidCurrency =
        (typeof rawCurrency === "string" && rawCurrency.trim() !== ""
          ? rawCurrency.trim()
          : row.payment_currency.trim()
        ).toUpperCase();
      if (paidCurrency === "USD") continue;

      // Merge the paid pair into the totals JSON without touching the USD
      // figures already stored there.
      await db.query(
        `UPDATE orders
            SET totals = COALESCE(totals, '{}'::jsonb)
                         || jsonb_build_object('paid_total', $2::numeric, 'paid_currency', $3::text)
          WHERE id = $1`,
        [row.id, paidAmount, paidCurrency],
      );
      // Pair the paid-currency amount with the stored currency code.
      await db.query(
        `UPDATE order_payment SET amount = $2 WHERE order_id = $1`,
        [row.id, paidAmount],
      );
      succeeded += 1;
    } catch (err) {
      logger.error({ err, orderId: row.id }, "Paid-currency backfill: row failed");
    }
  }

  logger.info({ succeeded, total: rows.length }, "Paid-currency backfill: complete");
}

/** How many candidate orders one repair run may check against Stripe. */
export const STRIPE_REPAIR_BATCH_LIMIT = 100;

/** Only look at reasonably recent orders — old ones are settled history. */
export const STRIPE_REPAIR_LOOKBACK_DAYS = 180;

/**
 * Idempotent startup repair: verify the paid amount of non-USD Stripe orders
 * against Stripe itself.
 *
 * The storefront has sent wrong `payment.totalAmount` values (the USD figure
 * paired with a foreign currency code, e.g. "SAR 210.00" when Stripe actually
 * charged 785.00 SAR). Any order whose payment record carries a Stripe
 * payment intent ref (`pi_...`) and a non-USD currency — and that hasn't been
 * verified yet (`totals.stripe_verified` marker) — is checked against Stripe
 * and corrected when the stored `paid_total` disagrees.
 *
 * Bounded and best-effort: recent orders only, small batch, sequential Stripe
 * calls; a Stripe outage skips rows without marking them so they retry on the
 * next startup. Definitive "payment intent not found" answers are marked so
 * they are never re-queried.
 */
export async function repairStripePaidAmounts(): Promise<void> {
  if (!process.env.STRIPE_SECRET_KEY && !process.env.STRIPE_SECRET_KEY_UAE) return;

  let rows: {
    id: string;
    provider_ref: string;
    paid_total: string | null;
    paid_currency: string | null;
  }[];
  try {
    const res = await db.query<{
      id: string;
      provider_ref: string;
      paid_total: string | null;
      paid_currency: string | null;
    }>(
      `SELECT o.id,
              p.provider_ref,
              o.totals->>'paid_total' AS paid_total,
              o.totals->>'paid_currency' AS paid_currency
         FROM orders o
         JOIN order_payment p ON p.order_id = o.id
        WHERE p.provider_ref LIKE 'pi\\_%'
          AND p.currency IS NOT NULL
          AND upper(trim(p.currency)) <> 'USD'
          AND o.totals->>'stripe_verified' IS NULL
          AND o.created_at > now() - ($1 || ' days')::interval
        ORDER BY o.created_at DESC
        LIMIT $2`,
      [String(STRIPE_REPAIR_LOOKBACK_DAYS), STRIPE_REPAIR_BATCH_LIMIT],
    );
    rows = res.rows;
  } catch (err) {
    logger.error({ err }, "Stripe paid-amount repair: query failed");
    return;
  }

  if (rows.length === 0) return;
  logger.info({ count: rows.length }, "Stripe paid-amount repair: starting");

  let corrected = 0;
  let verified = 0;
  for (const row of rows) {
    try {
      if (!isStripePaymentIntentRef(row.provider_ref)) continue;
      const result = await verifyStripePaymentIntentAmount(row.provider_ref);
      if (result.status === "error") continue; // retry next startup
      if (result.status === "not_found") {
        // Definitive answer — mark so we never re-query this order.
        await db.query(
          `UPDATE orders
              SET totals = COALESCE(totals, '{}'::jsonb)
                           || jsonb_build_object('stripe_verified', 'not_found')
            WHERE id = $1`,
          [row.id],
        );
        continue;
      }

      const storedTotal = row.paid_total != null ? Number(row.paid_total) : null;
      const storedCurrency = row.paid_currency?.trim().toUpperCase() ?? null;
      const matches =
        storedTotal != null &&
        Number.isFinite(storedTotal) &&
        storedTotal === result.amount &&
        storedCurrency === result.currency;

      if (matches) {
        await db.query(
          `UPDATE orders
              SET totals = COALESCE(totals, '{}'::jsonb)
                           || jsonb_build_object('stripe_verified', true)
            WHERE id = $1`,
          [row.id],
        );
        verified += 1;
        continue;
      }

      logger.warn(
        {
          orderId: row.id,
          paymentRef: row.provider_ref,
          storedTotal,
          storedCurrency,
          stripeAmount: result.amount,
          stripeCurrency: result.currency,
        },
        "Stripe paid-amount repair: stored paid total disagrees with Stripe; correcting",
      );
      await db.query(
        `UPDATE orders
            SET totals = COALESCE(totals, '{}'::jsonb)
                         || jsonb_build_object(
                              'paid_total', $2::numeric,
                              'paid_currency', $3::text,
                              'stripe_verified', true)
          WHERE id = $1`,
        [row.id, result.amount, result.currency],
      );
      await db.query(
        `UPDATE order_payment SET amount = $2, currency = $3 WHERE order_id = $1`,
        [row.id, result.amount, result.currency],
      );
      corrected += 1;
      verified += 1;
    } catch (err) {
      logger.error({ err, orderId: row.id }, "Stripe paid-amount repair: row failed");
    }
  }

  logger.info(
    { verified, corrected, total: rows.length },
    "Stripe paid-amount repair: complete",
  );
}

/** How many candidate orders one mislabeled-pair repair run may process. */
export const MISLABELED_REPAIR_BATCH_LIMIT = 500;

/**
 * Idempotent startup repair: fix stored paid pairs that carry the USD figure
 * mislabeled with a foreign currency code.
 *
 * The storefront failure mode is `payment.totalAmount` = the USD figure with a
 * foreign `currencyCode` (e.g. QAR label on the USD 168 number for an order
 * actually charged QAR ~630). Orders ingested before the plausibility guard —
 * or whose Stripe verification failed open — still carry that mislabeled pair
 * in `totals.paid_total`/`paid_currency`, `order_payment`, and the line-item
 * paid prices, so re-sent emails and the dashboard show the wrong amount.
 *
 * For every non-USD, not-yet-Stripe-verified paid pair, this pass re-runs the
 * same plausibility check used at ingest against the USD figure of the SAME
 * charge (`raw_payload.payment.totalUsd`, falling back to `totals.total`):
 *
 *   - plausible          → marked `paid_pair_checked: true` (never re-scanned)
 *   - implausible + Stripe payment-intent ref → ask Stripe and store the
 *     verified pair everywhere (totals, order_payment; stale line-item paid
 *     prices are cleared since they came from the same untrustworthy payload)
 *   - implausible, no usable Stripe answer → clear the mislabeled pair so all
 *     records fall back to USD-labeled USD amounts, marked
 *     `paid_pair_checked: "cleared"`
 *
 * Transient Stripe errors leave the row unmarked so it retries next startup.
 */
export async function repairMislabeledPaidPairs(): Promise<void> {
  let rows: {
    id: string;
    paid_total: string | null;
    paid_currency: string | null;
    usd_total: string | null;
    paid_subtotal: string | null;
    paid_shipping: string | null;
    raw_payment: {
      totalUsd?: unknown;
      subtotalAmount?: unknown;
      deliveryFeeAmount?: unknown;
    } | null;
    has_paid_line_prices: boolean;
    provider_ref: string | null;
    amount_usd: string | null;
  }[];
  try {
    const res = await db.query<(typeof rows)[number]>(
      `SELECT o.id,
              o.totals->>'paid_total' AS paid_total,
              o.totals->>'paid_currency' AS paid_currency,
              o.totals->>'total' AS usd_total,
              o.totals->>'paid_subtotal' AS paid_subtotal,
              o.totals->>'paid_shipping' AS paid_shipping,
              o.raw_payload->'payment' AS raw_payment,
              EXISTS (
                SELECT 1 FROM order_line_items li
                 WHERE li.order_id = o.id AND li.paid_unit_price IS NOT NULL
              ) AS has_paid_line_prices,
              p.provider_ref,
              p.amount_usd::text AS amount_usd
         FROM orders o
         LEFT JOIN order_payment p ON p.order_id = o.id
        WHERE o.totals->>'paid_currency' IS NOT NULL
          AND upper(trim(o.totals->>'paid_currency')) <> 'USD'
          AND o.totals->>'paid_total' IS NOT NULL
          AND (o.totals->>'stripe_verified') IS DISTINCT FROM 'true'
          AND o.totals->>'paid_pair_checked' IS NULL
        ORDER BY o.created_at DESC
        LIMIT $1`,
      [MISLABELED_REPAIR_BATCH_LIMIT],
    );
    rows = res.rows;
  } catch (err) {
    logger.error({ err }, "Mislabeled paid-pair repair: query failed");
    return;
  }

  if (rows.length === 0) return;
  logger.info({ count: rows.length }, "Mislabeled paid-pair repair: starting");

  let cleared = 0;
  let stripeCorrected = 0;
  let plausible = 0;
  for (const row of rows) {
    try {
      const paidTotal = row.paid_total != null ? Number(row.paid_total) : null;
      const paidCurrency = row.paid_currency?.trim().toUpperCase() ?? null;
      // USD figure of the SAME charge: raw payment.totalUsd first, then the
      // stored USD order total. (paid_total can be a deposit, but so is its
      // own totalUsd — comparing same-charge figures keeps the check valid.)
      const rawTotalUsd = row.raw_payment?.totalUsd;
      const usdReference =
        typeof rawTotalUsd === "number" && Number.isFinite(rawTotalUsd)
          ? rawTotalUsd
          : row.usd_total != null && Number.isFinite(Number(row.usd_total))
            ? Number(row.usd_total)
            : null;

      // Corroboration exemption — same rule as ingest: a pair accompanied by
      // a paid-currency breakdown (payment.subtotalAmount/deliveryFeeAmount,
      // totals.paid_subtotal/paid_shipping, or per-line paid prices) reflects
      // a deliberate storefront conversion and is trusted verbatim; only the
      // bare, uncorroborated totalAmount echo is rate-checked.
      const finiteNum = (v: unknown): boolean =>
        v != null && Number.isFinite(Number(v)) && String(v).trim() !== "";
      const hasCorroboration =
        finiteNum(row.paid_subtotal) ||
        finiteNum(row.paid_shipping) ||
        (typeof row.raw_payment?.subtotalAmount === "number" &&
          Number.isFinite(row.raw_payment.subtotalAmount)) ||
        (typeof row.raw_payment?.deliveryFeeAmount === "number" &&
          Number.isFinite(row.raw_payment.deliveryFeeAmount)) ||
        row.has_paid_line_prices === true;

      const check = hasCorroboration
        ? { plausible: true as const, impliedRate: null, referenceRate: null }
        : checkPaidPairPlausibility(paidTotal, paidCurrency, usdReference);
      if (check.plausible) {
        await db.query(
          `UPDATE orders
              SET totals = COALESCE(totals, '{}'::jsonb)
                           || jsonb_build_object('paid_pair_checked', true)
            WHERE id = $1`,
          [row.id],
        );
        plausible += 1;
        continue;
      }

      // Implausible pair. Prefer the authoritative Stripe answer when a
      // payment-intent ref exists and keys are configured.
      if (
        isStripePaymentIntentRef(row.provider_ref) &&
        (process.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY_UAE)
      ) {
        const result = await verifyStripePaymentIntentAmount(row.provider_ref);
        if (result.status === "error") continue; // transient — retry next startup
        if (result.status === "ok") {
          logger.warn(
            {
              orderId: row.id,
              storedTotal: paidTotal,
              storedCurrency: paidCurrency,
              stripeAmount: result.amount,
              stripeCurrency: result.currency,
            },
            "Mislabeled paid-pair repair: correcting with the Stripe-verified amount",
          );
          // Order of writes: payment row and line items first; the totals
          // update carrying the idempotency marker runs LAST so a partial
          // failure leaves the row unmarked and it retries next startup.
          await db.query(
            `UPDATE order_payment SET amount = $2, currency = $3 WHERE order_id = $1`,
            [row.id, result.amount, result.currency],
          );
          // Line-item paid prices came from the same mislabeled payload —
          // clear them; display falls back to the implied-rate conversion.
          await db.query(
            `UPDATE order_line_items
                SET paid_unit_price = NULL, paid_line_total = NULL
              WHERE order_id = $1`,
            [row.id],
          );
          await db.query(
            `UPDATE orders
                SET totals = COALESCE(totals, '{}'::jsonb)
                             || jsonb_build_object(
                                  'paid_total', $2::numeric,
                                  'paid_currency', $3::text,
                                  'stripe_verified', true,
                                  'paid_pair_checked', true)
              WHERE id = $1`,
            [row.id, result.amount, result.currency],
          );
          stripeCorrected += 1;
          continue;
        }
        // not_found → fall through to clearing the pair below.
      }

      logger.warn(
        {
          orderId: row.id,
          storedTotal: paidTotal,
          storedCurrency: paidCurrency,
          usdReference,
          impliedRate: check.impliedRate,
          referenceRate: check.referenceRate,
        },
        "Mislabeled paid-pair repair: clearing implausible paid pair (USD figure with a foreign currency label)",
      );
      // Re-pair the payment record with the trustworthy USD figure. The
      // totals update carrying the idempotency marker runs LAST so a partial
      // failure leaves the row unmarked and it retries next startup.
      await db.query(
        `UPDATE order_payment SET currency = 'USD', amount = amount_usd WHERE order_id = $1`,
        [row.id],
      );
      await db.query(
        `UPDATE order_line_items
            SET paid_unit_price = NULL, paid_line_total = NULL
          WHERE order_id = $1`,
        [row.id],
      );
      await db.query(
        `UPDATE orders
            SET totals = (COALESCE(totals, '{}'::jsonb)
                          - 'paid_total' - 'paid_currency' - 'paid_subtotal' - 'paid_shipping')
                         || jsonb_build_object('paid_pair_checked', 'cleared')
          WHERE id = $1`,
        [row.id],
      );
      cleared += 1;
    } catch (err) {
      logger.error({ err, orderId: row.id }, "Mislabeled paid-pair repair: row failed");
    }
  }

  logger.info(
    { plausible, stripeCorrected, cleared, total: rows.length },
    "Mislabeled paid-pair repair: complete",
  );
}
