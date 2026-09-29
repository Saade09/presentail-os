import { db } from "./db.js";
import { logger } from "./logger.js";

export type CashSyncResult = {
  syncRunId: number;
  recordsSynced: number;
  sessionsCount: number;
  closedSessionsCount: number;
  osOrdersCount: number;
  osOrdersAmountCents: number;
  cashSessionsTotalCents: number;
  differencesCents: number;
  salesReconciliationStatus: "matched" | "unmatched" | "partial";
};

export async function runCashSync(
  sourceMonthId: number,
  workspaceOwnerId: string,
  year: number,
  month: number,
): Promise<CashSyncResult> {
  const monthStart = new Date(Date.UTC(year, month - 1, 1));
  const monthEnd = new Date(Date.UTC(year, month, 1));

  logger.info(
    { sourceMonthId, year, month },
    "accountingCashSync: starting sync",
  );

  const syncRunResult = await db.query<{ id: number }>(
    `INSERT INTO source_sync_runs (source_month_id, status, started_at)
     VALUES ($1, 'running', now())
     RETURNING id`,
    [sourceMonthId],
  );
  const syncRunId = syncRunResult.rows[0].id;

  try {
    const sessionsResult = await db.query<{
      id: number;
      session_number: string;
      currency: string;
      status: string;
      opening_cash: string;
      cash_in_total: string;
      cash_out_total: string;
      expected_cash: string | null;
      actual_cash: string | null;
      difference: string | null;
      opened_at: string;
      closed_at: string | null;
    }>(
      `SELECT id, session_number, currency, status,
              opening_cash, cash_in_total, cash_out_total,
              expected_cash, actual_cash, difference,
              opened_at, closed_at
         FROM cash_sessions
        WHERE workspace_owner_id = $1
          AND opened_at >= $2
          AND opened_at < $3
        ORDER BY opened_at ASC`,
      [workspaceOwnerId, monthStart.toISOString(), monthEnd.toISOString()],
    );

    const sessions = sessionsResult.rows;

    const osOrdersResult = await db.query<{
      order_id: string;
      amount_cents: number | null;
      amount: string | null;
      currency: string | null;
      paid_at: string;
    }>(
      `SELECT op.order_id, op.amount_cents, op.amount, op.currency, op.paid_at
         FROM order_payment op
         JOIN orders o ON o.id = op.order_id
        WHERE o.workspace_owner_id = $1
          AND op.status = 'paid'
          AND op.provider = 'cash'
          AND op.paid_at >= $2
          AND op.paid_at < $3`,
      [workspaceOwnerId, monthStart.toISOString(), monthEnd.toISOString()],
    );

    const osOrdersCount = osOrdersResult.rowCount ?? 0;
    const osOrdersAmountCents = osOrdersResult.rows.reduce(
      (s, r) => s + (r.amount_cents ?? Math.round(parseFloat(r.amount ?? "0") * 100)),
      0,
    );

    const upsertPromises: Promise<unknown>[] = [];
    let recordsSynced = 0;
    let cashSessionsTotalCents = 0;

    for (const session of sessions) {
      const lineDate = session.opened_at.slice(0, 10);
      const cashTotal =
        session.actual_cash !== null
          ? parseFloat(session.actual_cash)
          : session.expected_cash !== null
            ? parseFloat(session.expected_cash)
            : parseFloat(session.opening_cash) + parseFloat(session.cash_in_total);
      const amountCents = Math.round(cashTotal * 100);
      if (amountCents > 0) cashSessionsTotalCents += amountCents;

      upsertPromises.push(
        db.query(
          `INSERT INTO source_statement_lines
             (source_month_id, external_ref, line_date, description, amount_cents,
              currency, reference, is_matched, matched_order_id, line_type,
              match_confidence, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (source_month_id, external_ref)
             DO UPDATE SET
               description  = EXCLUDED.description,
               amount_cents = EXCLUDED.amount_cents,
               metadata     = EXCLUDED.metadata`,
          [
            sourceMonthId,
            `session-${session.id}`,
            lineDate,
            `Cash Session #${session.session_number} (${session.status})`,
            amountCents,
            session.currency.toUpperCase(),
            `${session.id}`,
            false,
            null,
            "cash_session",
            "none",
            JSON.stringify({
              session_id: session.id,
              status: session.status,
              opening_cash: session.opening_cash,
              cash_in_total: session.cash_in_total,
              cash_out_total: session.cash_out_total,
              actual_cash: session.actual_cash,
              difference: session.difference,
              closed_at: session.closed_at,
            }),
          ],
        ),
      );
      recordsSynced++;
    }

    for (const order of osOrdersResult.rows) {
      const lineDate = order.paid_at.slice(0, 10);
      const amountCents =
        order.amount_cents ?? Math.round(parseFloat(order.amount ?? "0") * 100);

      upsertPromises.push(
        db.query(
          `INSERT INTO source_statement_lines
             (source_month_id, external_ref, line_date, description, amount_cents,
              currency, reference, is_matched, matched_order_id, line_type,
              match_confidence, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (source_month_id, external_ref)
             DO UPDATE SET
               description  = EXCLUDED.description,
               amount_cents = EXCLUDED.amount_cents`,
          [
            sourceMonthId,
            `order-${order.order_id}`,
            lineDate,
            "OS Cash Payment",
            amountCents,
            (order.currency ?? "USD").toUpperCase(),
            order.order_id,
            true,
            order.order_id,
            "cash_payment",
            "high",
            JSON.stringify({}),
          ],
        ),
      );
      recordsSynced++;
    }

    await Promise.all(upsertPromises);

    const differencesCents = Math.abs(cashSessionsTotalCents - osOrdersAmountCents);
    const closedSessionsCount = sessions.filter(
      (s) => s.status === "approved" || s.status === "closed" || s.status === "pending_review",
    ).length;

    const salesReconciliationStatus: CashSyncResult["salesReconciliationStatus"] =
      osOrdersCount === 0 && sessions.length === 0
        ? "unmatched"
        : differencesCents === 0
          ? "matched"
          : differencesCents < 10_00
            ? "partial"
            : "unmatched";

    const cashSummary = {
      sessionsCount: sessions.length,
      closedSessionsCount,
      osOrdersCount,
      osOrdersAmountCents,
      cashSessionsTotalCents,
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
        cashSessionsTotalCents,
        differencesCents,
        salesReconciliationStatus,
        JSON.stringify(cashSummary),
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
      { sourceMonthId, syncRunId, recordsSynced, sessionsCount: sessions.length },
      "accountingCashSync: sync completed",
    );

    return {
      syncRunId,
      recordsSynced,
      sessionsCount: sessions.length,
      closedSessionsCount,
      osOrdersCount,
      osOrdersAmountCents,
      cashSessionsTotalCents,
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
