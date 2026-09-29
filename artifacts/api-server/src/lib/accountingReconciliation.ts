import { db } from "./db.js";

export type ReconcileResult = {
  linesMatched: number;
  linesPartial: number;
  linesUnmatched: number;
  exceptionsRaised: number;
  salesStatus: string;
  payoutStatus: string | null;
};

type SourceMonthInfo = {
  id: number;
  source_type: string;
  workspace_owner_id: string;
  year: number;
  month: number;
  accounting_month_id: number;
  entity_id: number | null;
};

type StatementLine = {
  id: number;
  external_ref: string | null;
  line_date: string | null;
  amount_cents: number;
  currency: string;
  matched_order_id: string | null;
  match_status: string;
  is_matched: boolean;
};

async function insertExceptionIfNew(opts: {
  accountingMonthId: number;
  entityId: number | null;
  sourceMonthId: number;
  exceptionType: string;
  description: string;
  amountCents: number | null;
  currency: string | null;
  externalRef: string | null;
  relatedOrderId: string | null;
}): Promise<boolean> {
  if (opts.externalRef) {
    const exists = await db.query<{ id: number }>(
      `SELECT id FROM accounting_exceptions
       WHERE accounting_month_id = $1
         AND source_month_id = $2
         AND external_ref = $3
         AND exception_type = $4
       LIMIT 1`,
      [opts.accountingMonthId, opts.sourceMonthId, opts.externalRef, opts.exceptionType],
    );
    if ((exists.rowCount ?? 0) > 0) return false;
  }

  await db.query(
    `INSERT INTO accounting_exceptions
       (accounting_month_id, entity_id, source_month_id, exception_type, description,
        amount_cents, currency, external_ref, related_order_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      opts.accountingMonthId,
      opts.entityId,
      opts.sourceMonthId,
      opts.exceptionType,
      opts.description,
      opts.amountCents,
      opts.currency,
      opts.externalRef,
      opts.relatedOrderId,
    ],
  );
  return true;
}

export async function reconcileSourceMonth(sourceMonthId: number): Promise<ReconcileResult> {
  const smResult = await db.query<SourceMonthInfo>(
    `SELECT asm.id, asrc.source_type,
       aem.workspace_owner_id, am.year, am.month,
       aem.accounting_month_id, aem.entity_id
     FROM accounting_source_months asm
     JOIN accounting_sources asrc ON asrc.id = asm.source_id
     JOIN accounting_entity_months aem ON aem.id = asm.accounting_entity_month_id
     JOIN accounting_months am ON am.id = aem.accounting_month_id
     WHERE asm.id = $1`,
    [sourceMonthId],
  );
  if ((smResult.rowCount ?? 0) === 0) throw new Error("Source month not found");
  const sm = smResult.rows[0];

  const linesResult = await db.query<StatementLine>(
    `SELECT id, external_ref, line_date, amount_cents, currency,
            matched_order_id, match_status, is_matched
     FROM source_statement_lines
     WHERE source_month_id = $1
     ORDER BY id`,
    [sourceMonthId],
  );

  let linesMatched = 0;
  let linesPartial = 0;
  let linesUnmatched = 0;
  let exceptionsRaised = 0;

  const alreadyMatchedOrderIds = new Set<string>(
    linesResult.rows
      .filter((l) => l.matched_order_id && l.match_status === "matched")
      .map((l) => l.matched_order_id as string),
  );

  for (const line of linesResult.rows) {
    if (line.match_status === "matched" && line.matched_order_id) {
      linesMatched++;
      continue;
    }

    if (!line.line_date) {
      linesUnmatched++;
      continue;
    }

    const matchResult = await db.query<{
      payment_id: string;
      order_id: string;
      amount_cents: number;
    }>(
      `SELECT op.id as payment_id, op.order_id::text,
              ROUND(op.amount::numeric * 100)::integer as amount_cents
       FROM order_payment op
       JOIN orders o ON o.id = op.order_id
       WHERE o.workspace_owner_id = $1
         AND upper(op.currency) = upper($2)
         AND ROUND(op.amount::numeric * 100) BETWEEN $3 AND $4
         AND op.paid_at >= ($5::date - interval '3 days')
         AND op.paid_at <  ($5::date + interval '4 days')
         AND op.status = 'paid'
       ORDER BY ABS(ROUND(op.amount::numeric * 100) - $6) ASC
       LIMIT 1`,
      [
        sm.workspace_owner_id,
        line.currency,
        line.amount_cents - 1,
        line.amount_cents + 1,
        line.line_date,
        line.amount_cents,
      ],
    );

    if ((matchResult.rowCount ?? 0) > 0 && !alreadyMatchedOrderIds.has(matchResult.rows[0].order_id)) {
      const match = matchResult.rows[0];
      const diff = Math.abs(match.amount_cents - line.amount_cents);
      const newStatus = diff === 0 ? "matched" : "partial";

      await db.query(
        `UPDATE source_statement_lines
         SET match_status = $1, matched_order_id = $2::uuid, is_matched = $3, updated_at = now()
         WHERE id = $4`,
        [newStatus, match.order_id, newStatus === "matched", line.id],
      );

      alreadyMatchedOrderIds.add(match.order_id);

      if (newStatus === "matched") {
        linesMatched++;
      } else {
        linesPartial++;
        const raised = await insertExceptionIfNew({
          accountingMonthId: sm.accounting_month_id,
          entityId: sm.entity_id,
          sourceMonthId,
          exceptionType: "amount_mismatch",
          description: `Amount mismatch: statement ${line.currency} ${(line.amount_cents / 100).toFixed(2)}, OS order ${line.currency} ${(match.amount_cents / 100).toFixed(2)}`,
          amountCents: diff,
          currency: line.currency,
          externalRef: line.external_ref,
          relatedOrderId: match.order_id,
        });
        if (raised) exceptionsRaised++;
      }
    } else {
      linesUnmatched++;
      await db.query(
        `UPDATE source_statement_lines
         SET match_status = 'unmatched', updated_at = now()
         WHERE id = $1 AND match_status != 'matched'`,
        [line.id],
      );

      if (line.amount_cents > 0) {
        const raised = await insertExceptionIfNew({
          accountingMonthId: sm.accounting_month_id,
          entityId: sm.entity_id,
          sourceMonthId,
          exceptionType: "external_payment_without_os_order",
          description: `Unmatched external payment: ${line.currency} ${(line.amount_cents / 100).toFixed(2)} on ${line.line_date}`,
          amountCents: line.amount_cents,
          currency: line.currency,
          externalRef: line.external_ref,
          relatedOrderId: null,
        });
        if (raised) exceptionsRaised++;
      }
    }
  }

  const total = linesResult.rows.length;
  let salesStatus: string;
  let payoutStatus: string | null;

  if (total === 0) {
    salesStatus = "pending";
    payoutStatus = null;
  } else if (linesUnmatched === 0 && linesPartial === 0) {
    salesStatus = "reconciled";
    payoutStatus = "paid";
  } else if (linesMatched > 0 && linesUnmatched > 0) {
    salesStatus = "review_required";
    payoutStatus = "partial";
  } else if (linesUnmatched > 0) {
    salesStatus = "exception";
    payoutStatus = "pending";
  } else {
    salesStatus = "in_review";
    payoutStatus = "pending";
  }

  await db.query(
    `UPDATE accounting_source_months
     SET sales_status = $1, payout_status = $2, updated_at = now()
     WHERE id = $3`,
    [salesStatus, payoutStatus, sourceMonthId],
  );

  return { linesMatched, linesPartial, linesUnmatched, exceptionsRaised, salesStatus, payoutStatus };
}
