import Stripe from "stripe";
import { db } from "./db.js";
import { logger } from "./logger.js";

type BalanceTransactionWithEndingBalance = Stripe.BalanceTransaction & {
  ending_balance: number | null;
};

const STRIPE_API_VERSION = "2026-04-22.dahlia" as const;

function getStripeClient(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  return new Stripe(key, { apiVersion: STRIPE_API_VERSION });
}

export type StripeSyncResult = {
  syncRunId: number;
  recordsSynced: number;
  osOrdersCount: number;
  osOrdersAmountCents: number;
  stripeChargesCount: number;
  stripeChargesAmountCents: number;
  matchedCount: number;
  unmatchedStripeCount: number;
  unmatchedOsCount: number;
  osGrossSalesCents: number;
  stripeGrossChargesCents: number;
  differencesCents: number;
  refundsCents: number;
  feesCents: number;
  disputesCents: number;
  adjustmentsCents: number;
  payoutsCents: number;
  openingBalanceCents: number;
  closingBalanceCents: number;
  salesReconciliationStatus: "matched" | "unmatched" | "partial";
  payoutReconciliationStatus: "matched" | "unmatched" | "unknown";
};

type CategorizeTxn = {
  charges: Stripe.BalanceTransaction[];
  refunds: Stripe.BalanceTransaction[];
  fees: Stripe.BalanceTransaction[];
  disputes: Stripe.BalanceTransaction[];
  payouts: Stripe.BalanceTransaction[];
  adjustments: Stripe.BalanceTransaction[];
};

const CHARGE_TYPES = new Set(["charge"]);
const REFUND_TYPES = new Set(["refund", "partial_capture_reversal"]);
const FEE_TYPES = new Set(["application_fee", "stripe_fee"]);
const DISPUTE_TYPES = new Set(["dispute", "dispute_reversal"]);
const PAYOUT_TYPES = new Set(["payout", "payout_failure", "payout_cancel"]);

export function categorize(txns: Stripe.BalanceTransaction[]): CategorizeTxn {
  const result: CategorizeTxn = {
    charges: [],
    refunds: [],
    fees: [],
    disputes: [],
    payouts: [],
    adjustments: [],
  };
  for (const txn of txns) {
    if (CHARGE_TYPES.has(txn.type)) result.charges.push(txn);
    else if (REFUND_TYPES.has(txn.type)) result.refunds.push(txn);
    else if (FEE_TYPES.has(txn.type)) result.fees.push(txn);
    else if (DISPUTE_TYPES.has(txn.type)) result.disputes.push(txn);
    else if (PAYOUT_TYPES.has(txn.type)) result.payouts.push(txn);
    else result.adjustments.push(txn);
  }
  return result;
}

async function fetchAllBalanceTransactions(
  stripe: Stripe,
  gteTs: number,
  ltTs: number,
): Promise<Stripe.BalanceTransaction[]> {
  const all: Stripe.BalanceTransaction[] = [];
  let startingAfter: string | undefined;

  for (;;) {
    const page = await stripe.balanceTransactions.list({
      created: { gte: gteTs, lt: ltTs },
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    all.push(...page.data);
    if (!page.has_more || page.data.length === 0) break;
    startingAfter = page.data[page.data.length - 1].id;
  }
  return all;
}

type MatchResult = {
  orderId: string | null;
  confidence: "high" | "medium" | "low" | "none";
};

export async function matchChargeToOrder(
  stripe: Stripe,
  txn: Stripe.BalanceTransaction,
  workspaceOwnerId: string,
): Promise<MatchResult> {
  const source = txn.source;
  if (!source || typeof source !== "string") {
    return { orderId: null, confidence: "none" };
  }

  const chargeId = source.startsWith("ch_") ? source : null;
  let paymentIntentId: string | null = null;

  if (source.startsWith("py_") || source.startsWith("ch_")) {
    try {
      const charge = await stripe.charges.retrieve(
        source.startsWith("py_") ? source : chargeId!,
        { expand: ["payment_intent"] },
      );
      if (typeof charge.payment_intent === "string") {
        paymentIntentId = charge.payment_intent;
      } else if (charge.payment_intent?.id) {
        paymentIntentId = charge.payment_intent.id;
      }

      if (paymentIntentId) {
        const byPi = await db.query<{ order_id: string }>(
          `SELECT o.id AS order_id
             FROM order_payment op
             JOIN orders o ON o.id = op.order_id
            WHERE op.provider_ref = $1
              AND o.workspace_owner_id = $2
            LIMIT 1`,
          [paymentIntentId, workspaceOwnerId],
        );
        if ((byPi.rowCount ?? 0) > 0) {
          return { orderId: byPi.rows[0].order_id, confidence: "high" };
        }
      }

      if (chargeId) {
        const byCharge = await db.query<{ order_id: string }>(
          `SELECT o.id AS order_id
             FROM order_payment op
             JOIN orders o ON o.id = op.order_id
            WHERE op.provider_ref = $1
              AND o.workspace_owner_id = $2
            LIMIT 1`,
          [chargeId, workspaceOwnerId],
        );
        if ((byCharge.rowCount ?? 0) > 0) {
          return { orderId: byCharge.rows[0].order_id, confidence: "medium" };
        }
      }

      const metaOrderId =
        charge.metadata?.order_id ??
        charge.metadata?.os_order_id ??
        null;
      if (metaOrderId) {
        const byMeta = await db.query<{ id: string }>(
          `SELECT id FROM orders WHERE id = $1 AND workspace_owner_id = $2 LIMIT 1`,
          [metaOrderId, workspaceOwnerId],
        );
        if ((byMeta.rowCount ?? 0) > 0) {
          return { orderId: byMeta.rows[0].id, confidence: "low" };
        }
      }
    } catch (err) {
      logger.warn({ err, txnId: txn.id }, "accountingStripeSync: charge lookup error");
    }
  }

  return { orderId: null, confidence: "none" };
}

export async function getOpeningBalance(stripe: Stripe, monthStartTs: number): Promise<number> {
  try {
    const prev = await stripe.balanceTransactions.list({
      created: { lt: monthStartTs },
      limit: 1,
    });
    if (prev.data.length > 0) {
      const txn = prev.data[0] as BalanceTransactionWithEndingBalance;
      if (txn.ending_balance !== null) {
        return txn.ending_balance ?? 0;
      }
    }
  } catch (err) {
    logger.warn({ err }, "accountingStripeSync: could not fetch opening balance");
  }
  return 0;
}

export async function runStripeSync(
  sourceMonthId: number,
  workspaceOwnerId: string,
  year: number,
  month: number,
): Promise<StripeSyncResult> {
  const stripe = getStripeClient();
  if (!stripe) {
    throw new Error("STRIPE_SECRET_KEY is not configured");
  }

  const monthStart = new Date(Date.UTC(year, month - 1, 1));
  const monthEnd = new Date(Date.UTC(year, month, 1));
  const gteTs = Math.floor(monthStart.getTime() / 1000);
  const ltTs = Math.floor(monthEnd.getTime() / 1000);

  logger.info(
    { sourceMonthId, year, month, gteTs, ltTs },
    "accountingStripeSync: starting sync",
  );

  const syncRunResult = await db.query<{ id: number }>(
    `INSERT INTO source_sync_runs (source_month_id, status, started_at)
     VALUES ($1, 'running', now())
     RETURNING id`,
    [sourceMonthId],
  );
  const syncRunId = syncRunResult.rows[0].id;

  try {
    const allTxns = await fetchAllBalanceTransactions(stripe, gteTs, ltTs);
    const cat = categorize(allTxns);

    const openingBalanceCents = await getOpeningBalance(stripe, gteTs);

    let lastEndingBalance: number | null | undefined = null;
    if (allTxns.length > 0) {
      const sorted = [...allTxns].sort((a, b) => b.created - a.created);
      lastEndingBalance = (sorted[0] as BalanceTransactionWithEndingBalance).ending_balance;
    }
    const closingBalanceCents =
      lastEndingBalance != null ? lastEndingBalance : openingBalanceCents;

    const stripeChargesAmountCents = cat.charges.reduce((s, t) => s + t.amount, 0);
    const refundsCents = cat.refunds.reduce((s, t) => s + Math.abs(t.amount), 0);
    const feesCents = allTxns.reduce((s, t) => s + t.fee, 0);
    const disputesCents = cat.disputes.reduce((s, t) => s + Math.abs(t.amount), 0);
    const payoutsCents = cat.payouts.reduce((s, t) => s + Math.abs(t.amount), 0);
    const adjustmentsCents = cat.adjustments.reduce((s, t) => s + t.amount, 0);

    const osOrders = await db.query<{
      order_id: string;
      amount_cents: number | null;
      amount: string | null;
      currency: string | null;
    }>(
      `SELECT op.order_id, op.amount_cents, op.amount, op.currency
         FROM order_payment op
         JOIN orders o ON o.id = op.order_id
        WHERE o.workspace_owner_id = $1
          AND op.status = 'paid'
          AND op.provider = 'stripe'
          AND op.paid_at >= $2
          AND op.paid_at < $3`,
      [workspaceOwnerId, monthStart.toISOString(), monthEnd.toISOString()],
    );

    const osOrdersCount = osOrders.rowCount ?? 0;
    const osGrossSalesCents = osOrders.rows.reduce(
      (s, r) => s + (r.amount_cents ?? Math.round(parseFloat(r.amount ?? "0") * 100)),
      0,
    );
    const osOrderIdSet = new Set(osOrders.rows.map((r) => r.order_id));

    let matchedCount = 0;
    let unmatchedStripeCount = 0;
    const matchedOrderIds = new Set<string>();
    let recordsSynced = 0;

    const upsertPromises: Promise<unknown>[] = [];

    for (const txn of allTxns) {
      const lineDate = new Date(txn.created * 1000).toISOString().slice(0, 10);
      const lineType = CHARGE_TYPES.has(txn.type)
        ? "charge"
        : REFUND_TYPES.has(txn.type)
          ? "refund"
          : FEE_TYPES.has(txn.type)
            ? "stripe_fee"
            : DISPUTE_TYPES.has(txn.type)
              ? "dispute"
              : PAYOUT_TYPES.has(txn.type)
                ? "payout"
                : "adjustment";

      let matchedOrderId: string | null = null;
      let matchConfidence: "high" | "medium" | "low" | "none" = "none";

      if (CHARGE_TYPES.has(txn.type)) {
        const match = await matchChargeToOrder(stripe, txn, workspaceOwnerId);
        matchedOrderId = match.orderId;
        matchConfidence = match.confidence;
        if (matchedOrderId) {
          matchedCount++;
          matchedOrderIds.add(matchedOrderId);
        } else {
          unmatchedStripeCount++;
        }
      }

      const isMatched = matchedOrderId !== null;

      upsertPromises.push(
        db.query(
          `INSERT INTO source_statement_lines
             (source_month_id, external_ref, line_date, description, amount_cents,
              currency, reference, is_matched, matched_order_id, line_type,
              match_confidence, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (source_month_id, external_ref)
             DO UPDATE SET
               is_matched      = EXCLUDED.is_matched,
               matched_order_id = EXCLUDED.matched_order_id,
               match_confidence = EXCLUDED.match_confidence,
               description     = EXCLUDED.description,
               amount_cents    = EXCLUDED.amount_cents`,
          [
            sourceMonthId,
            txn.id,
            lineDate,
            txn.description ?? txn.type,
            txn.amount,
            (txn.currency ?? "usd").toUpperCase(),
            typeof txn.source === "string" ? txn.source : null,
            isMatched,
            matchedOrderId,
            lineType,
            matchConfidence,
            JSON.stringify({
              stripe_type: txn.type,
              fee: txn.fee,
              net: txn.net,
              ending_balance: (txn as BalanceTransactionWithEndingBalance).ending_balance,
            }),
          ],
        ),
      );
      recordsSynced++;
    }

    await Promise.all(upsertPromises);

    const unmatchedOsCount = [...osOrderIdSet].filter(
      (id) => !matchedOrderIds.has(id),
    ).length;

    const osOrdersAmountCents = osGrossSalesCents;
    const differencesCents = Math.abs(stripeChargesAmountCents - osGrossSalesCents);

    const salesReconciliationStatus: StripeSyncResult["salesReconciliationStatus"] =
      unmatchedStripeCount === 0 && unmatchedOsCount === 0
        ? "matched"
        : unmatchedStripeCount > 0 || unmatchedOsCount > 0
          ? matchedCount > 0
            ? "partial"
            : "unmatched"
          : "matched";

    const computedClosing =
      openingBalanceCents +
      stripeChargesAmountCents -
      refundsCents -
      feesCents -
      disputesCents +
      adjustmentsCents -
      payoutsCents;
    const balanceDiffCents = Math.abs(computedClosing - closingBalanceCents);
    const payoutReconciliationStatus: StripeSyncResult["payoutReconciliationStatus"] =
      allTxns.length === 0
        ? "unknown"
        : balanceDiffCents <= 1
          ? "matched"
          : "unmatched";

    const stripeSummary = {
      stripeChargesCount: cat.charges.length,
      stripeChargesAmountCents,
      refundsCents,
      feesCents,
      disputesCents,
      adjustmentsCents,
      payoutsCents,
      openingBalanceCents,
      closingBalanceCents,
      osOrdersCount,
      osGrossSalesCents,
      matchedCount,
      unmatchedStripeCount,
      unmatchedOsCount,
    };

    await db.query(
      `UPDATE accounting_source_months
          SET status                       = 'synced',
              total_amount_cents           = $2,
              variance_cents               = $3,
              sales_reconciliation_status  = $4,
              payout_reconciliation_status = $5,
              stripe_summary               = $6,
              updated_at                   = now()
        WHERE id = $1`,
      [
        sourceMonthId,
        stripeChargesAmountCents,
        differencesCents,
        salesReconciliationStatus,
        payoutReconciliationStatus,
        JSON.stringify(stripeSummary),
      ],
    );

    await db.query(
      `UPDATE source_sync_runs
          SET status         = 'completed',
              completed_at   = now(),
              records_synced = $2
        WHERE id = $1`,
      [syncRunId, recordsSynced],
    );

    logger.info(
      { sourceMonthId, syncRunId, recordsSynced, matchedCount, unmatchedStripeCount },
      "accountingStripeSync: sync completed",
    );

    return {
      syncRunId,
      recordsSynced,
      osOrdersCount,
      osOrdersAmountCents,
      stripeChargesCount: cat.charges.length,
      stripeChargesAmountCents,
      matchedCount,
      unmatchedStripeCount,
      unmatchedOsCount,
      osGrossSalesCents,
      stripeGrossChargesCents: stripeChargesAmountCents,
      differencesCents,
      refundsCents,
      feesCents,
      disputesCents,
      adjustmentsCents,
      payoutsCents,
      openingBalanceCents,
      closingBalanceCents,
      salesReconciliationStatus,
      payoutReconciliationStatus,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.query(
      `UPDATE source_sync_runs
          SET status        = 'failed',
              completed_at  = now(),
              error_message = $2
        WHERE id = $1`,
      [syncRunId, message],
    );
    await db.query(
      `UPDATE accounting_source_months SET status = 'error', updated_at = now() WHERE id = $1`,
      [sourceMonthId],
    );
    throw err;
  }
}
