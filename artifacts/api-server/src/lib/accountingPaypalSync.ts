import { db } from "./db.js";
import { logger } from "./logger.js";

async function getPaypalAccessToken(): Promise<string | null> {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  const base =
    process.env.PAYPAL_ENV === "live"
      ? "https://api-m.paypal.com"
      : "https://api-m.sandbox.paypal.com";

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const resp = await fetch(`${base}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!resp.ok) return null;
  const data = (await resp.json()) as { access_token?: string };
  return data.access_token ?? null;
}

function getPaypalBase(): string {
  return process.env.PAYPAL_ENV === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";
}

type PaypalTransactionInfo = {
  transaction_id: string;
  transaction_amount: { currency_code: string; value: string };
  transaction_status: string;
  transaction_initiation_date: string;
  fee_amount?: { currency_code: string; value: string };
  invoice_id?: string | null;
  custom_field?: string | null;
};

type PaypalTransaction = {
  transaction_info: PaypalTransactionInfo;
  payer_info?: {
    email_address?: string;
    payer_name?: { given_name?: string; surname?: string };
  };
};

async function fetchPaypalTransactions(
  accessToken: string,
  startDate: string,
  endDate: string,
): Promise<PaypalTransaction[]> {
  const base = getPaypalBase();
  const all: PaypalTransaction[] = [];
  let page = 1;

  for (;;) {
    const url = new URL(`${base}/v1/reporting/transactions`);
    url.searchParams.set("start_date", startDate);
    url.searchParams.set("end_date", endDate);
    url.searchParams.set("fields", "all");
    url.searchParams.set("page_size", "500");
    url.searchParams.set("page", String(page));

    const resp = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`PayPal API error ${resp.status}: ${text.slice(0, 300)}`);
    }

    const data = (await resp.json()) as {
      transaction_details?: PaypalTransaction[];
      total_pages?: number;
    };

    all.push(...(data.transaction_details ?? []));
    if (!data.total_pages || page >= data.total_pages) break;
    page++;
  }

  return all;
}

export type PaypalSyncResult = {
  syncRunId: number;
  recordsSynced: number;
  paypalTransactionsCount: number;
  paypalTotalCents: number;
  osOrdersCount: number;
  osOrdersAmountCents: number;
  matchedCount: number;
  unmatchedPaypalCount: number;
  unmatchedOsCount: number;
  differencesCents: number;
  salesReconciliationStatus: "matched" | "unmatched" | "partial";
};

export async function runPaypalSync(
  sourceMonthId: number,
  workspaceOwnerId: string,
  year: number,
  month: number,
): Promise<PaypalSyncResult> {
  const accessToken = await getPaypalAccessToken();
  if (!accessToken) {
    throw new Error(
      "PayPal credentials are not configured. Add PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET to your environment.",
    );
  }

  const monthStart = new Date(Date.UTC(year, month - 1, 1));
  const monthEnd = new Date(Date.UTC(year, month, 1));

  const toPaypalDate = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "+0000");
  const startDate = toPaypalDate(monthStart);
  const endDate = toPaypalDate(monthEnd);

  logger.info(
    { sourceMonthId, year, month, startDate, endDate },
    "accountingPaypalSync: starting sync",
  );

  const syncRunResult = await db.query<{ id: number }>(
    `INSERT INTO source_sync_runs (source_month_id, status, started_at)
     VALUES ($1, 'running', now())
     RETURNING id`,
    [sourceMonthId],
  );
  const syncRunId = syncRunResult.rows[0].id;

  try {
    const transactions = await fetchPaypalTransactions(accessToken, startDate, endDate);

    const paymentTxns = transactions.filter((txn) => {
      const status = txn.transaction_info.transaction_status;
      const amount = parseFloat(txn.transaction_info.transaction_amount.value);
      return (status === "S" || status === "P") && amount > 0;
    });

    const osOrdersResult = await db.query<{
      order_id: string;
      amount_cents: number | null;
      amount: string | null;
      currency: string | null;
      provider_ref: string | null;
      paid_at: string;
    }>(
      `SELECT op.order_id, op.amount_cents, op.amount, op.currency, op.provider_ref, op.paid_at
         FROM order_payment op
         JOIN orders o ON o.id = op.order_id
        WHERE o.workspace_owner_id = $1
          AND op.status = 'paid'
          AND op.provider = 'paypal'
          AND op.paid_at >= $2
          AND op.paid_at < $3`,
      [workspaceOwnerId, monthStart.toISOString(), monthEnd.toISOString()],
    );

    const providerRefMap = new Map(
      osOrdersResult.rows
        .filter((r) => r.provider_ref)
        .map((r) => [r.provider_ref!, r.order_id]),
    );

    const osOrdersCount = osOrdersResult.rowCount ?? 0;
    const osOrdersAmountCents = osOrdersResult.rows.reduce(
      (s, r) => s + (r.amount_cents ?? Math.round(parseFloat(r.amount ?? "0") * 100)),
      0,
    );
    const osOrderIdSet = new Set(osOrdersResult.rows.map((r) => r.order_id));

    const upsertPromises: Promise<unknown>[] = [];
    let recordsSynced = 0;
    let paypalTotalCents = 0;
    let matchedCount = 0;
    let unmatchedPaypalCount = 0;
    const matchedOrderIds = new Set<string>();

    for (const txn of paymentTxns) {
      const info = txn.transaction_info;
      const currency = info.transaction_amount.currency_code;
      const amountCents = Math.round(parseFloat(info.transaction_amount.value) * 100);
      const lineDate = info.transaction_initiation_date.slice(0, 10);
      paypalTotalCents += amountCents;

      const matchedOrderId = providerRefMap.get(info.transaction_id) ?? null;
      const isMatched = matchedOrderId !== null;

      if (isMatched && matchedOrderId) {
        matchedCount++;
        matchedOrderIds.add(matchedOrderId);
      } else {
        unmatchedPaypalCount++;
      }

      const payerName = txn.payer_info?.payer_name
        ? `${txn.payer_info.payer_name.given_name ?? ""} ${txn.payer_info.payer_name.surname ?? ""}`.trim()
        : null;
      const description = payerName
        ? `PayPal payment from ${payerName}`
        : `PayPal ${info.transaction_id}`;

      upsertPromises.push(
        db.query(
          `INSERT INTO source_statement_lines
             (source_month_id, external_ref, line_date, description, amount_cents,
              currency, reference, is_matched, matched_order_id, line_type,
              match_confidence, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (source_month_id, external_ref)
             DO UPDATE SET
               is_matched       = EXCLUDED.is_matched,
               matched_order_id = EXCLUDED.matched_order_id,
               description      = EXCLUDED.description,
               amount_cents     = EXCLUDED.amount_cents`,
          [
            sourceMonthId,
            info.transaction_id,
            lineDate,
            description,
            amountCents,
            currency.toUpperCase(),
            info.transaction_id,
            isMatched,
            matchedOrderId,
            "paypal_payment",
            isMatched ? "high" : "none",
            JSON.stringify({
              status: info.transaction_status,
              invoice_id: info.invoice_id ?? null,
              fee_amount: info.fee_amount ?? null,
              payer_email: txn.payer_info?.email_address ?? null,
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

    const differencesCents = Math.abs(paypalTotalCents - osOrdersAmountCents);

    const salesReconciliationStatus: PaypalSyncResult["salesReconciliationStatus"] =
      unmatchedPaypalCount === 0 && unmatchedOsCount === 0
        ? paymentTxns.length === 0 && osOrdersCount === 0
          ? "unmatched"
          : "matched"
        : matchedCount > 0
          ? "partial"
          : "unmatched";

    const paypalSummary = {
      paypalTransactionsCount: paymentTxns.length,
      paypalTotalCents,
      osOrdersCount,
      osOrdersAmountCents,
      matchedCount,
      unmatchedPaypalCount,
      unmatchedOsCount,
    };

    await db.query(
      `UPDATE accounting_source_months
          SET status                       = 'synced',
              total_amount_cents           = $2,
              variance_cents               = $3,
              sales_reconciliation_status  = $4,
              stripe_summary               = $5,
              updated_at                   = now()
        WHERE id = $1`,
      [
        sourceMonthId,
        paypalTotalCents,
        differencesCents,
        salesReconciliationStatus,
        JSON.stringify(paypalSummary),
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
      { sourceMonthId, syncRunId, recordsSynced, matchedCount },
      "accountingPaypalSync: sync completed",
    );

    return {
      syncRunId,
      recordsSynced,
      paypalTransactionsCount: paymentTxns.length,
      paypalTotalCents,
      osOrdersCount,
      osOrdersAmountCents,
      matchedCount,
      unmatchedPaypalCount,
      unmatchedOsCount,
      differencesCents,
      salesReconciliationStatus,
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
