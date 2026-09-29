import { Router } from "express";
import { createHash, randomUUID } from "crypto";
import { createConnector } from "../lib/finance/connectorFactory.js";
import multer from "multer";
import { parseSpreadsheetToJson, writeXlsx } from "../lib/xlsxHelper.js";
import { db } from "../lib/db.js";
import { requireAuth, authed } from "../lib/auth.js";
import { resolveWorkspace, workspace } from "../lib/workspace.js";
import { objectStorageService, objectStorageClient } from "../lib/objectStorage.js";
import { logger } from "../lib/logger.js";
import { runStripeSync } from "../lib/accountingStripeSync.js";
import { runPaypalSync } from "../lib/accountingPaypalSync.js";
import { runCashSync } from "../lib/accountingCashSync.js";
import { reconcileSourceMonth } from "../lib/accountingReconciliation.js";
import { generateJournalEntry, getJournalEntry, DEFAULT_ACCOUNT_CODES } from "../lib/accountingJournalEntry.js";
import { generateVatSummary, getVatSummary } from "../lib/accountingVat.js";
import { callAI } from "../lib/ai/callAI.js";

const router = Router();
router.use(requireAuth, resolveWorkspace);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

function hasFinanceAccounting(wreq: ReturnType<typeof workspace>): boolean {
  return wreq.workspaceActualRole === "owner" || (wreq.allowedPages?.includes("finance_accounting") ?? false);
}

function hasFinanceManager(wreq: ReturnType<typeof workspace>): boolean {
  return wreq.workspaceActualRole === "owner" || (wreq.allowedPages?.includes("finance_manager") ?? false);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseDec(val: string | null | undefined): number {
  if (!val) return 0;
  return parseFloat(val) || 0;
}

function toCents(val: string | null | undefined): number {
  return Math.round(parseDec(val) * 100);
}

function getMonthRange(year: number, month: number): { monthStart: Date; monthEnd: Date } {
  return {
    monthStart: new Date(Date.UTC(year, month - 1, 1)),
    monthEnd: new Date(Date.UTC(year, month, 1)),
  };
}

// ── Types ─────────────────────────────────────────────────────────────────────

type AccountingMonthRow = {
  id: number;
  workspace_owner_id: string;
  year: number;
  month: number;
  status: string;
  notes: string | null;
  locked_at: string | null;
  locked_by: string | null;
  created_at: string;
  updated_at: string;
};

const CHECKLIST_LABELS = [
  "All sources synced and up-to-date",
  "OS sales figures verified",
  "External source statements imported",
  "Differences reviewed and explained",
  "All open exceptions resolved",
  "Refunds posted and reconciled",
  "Fees and commissions accounted for",
  "Net activity reconciles to bank statement",
  "Inter-entity transfers matched",
  "VAT liability calculated and recorded",
  "Journal entries drafted and reviewed",
  "Journal entries posted",
  "Supporting documents uploaded",
  "Finance manager sign-off",
];

type AccountingSourceMonthRow = {
  id: number;
  accounting_entity_month_id: number;
  source_id: number;
  source_name: string;
  source_type: string;
  status: string;
  total_amount_cents: number | null;
  variance_cents: number | null;
  sales_reconciliation_status: string | null;
  payout_reconciliation_status: string | null;
  stripe_summary: unknown;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

type AccountingSourceRow = {
  id: number;
  workspace_owner_id: string;
  entity_id: number;
  name: string;
  source_type: string;
  is_active: boolean;
  is_auto_sync: boolean;
  is_intercompany: boolean;
  sort_order: number;
  config: Record<string, unknown>;
  source_month_id: number | null;
  sales_status: string | null;
  last_synced_at: string | null;
  rows_count: number | null;
  last_run_status: string | null;
  last_run_filename: string | null;
  last_run_rows_accepted: number | null;
  last_run_rows_rejected: number | null;
};

type SourceMonthRow = {
  id: number;
  accounting_entity_month_id: number;
  source_id: number;
  status: string;
  sales_status: string;
  last_synced_at: string | null;
  rows_count: number;
  total_amount_cents: number | null;
  variance_cents: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

type SourceSyncRunRow = {
  id: number;
  source_month_id: number;
  status: string;
  started_at: string;
  completed_at: string | null;
  error_message: string | null;
  records_synced: number;
  created_at: string;
};

type SourceStatementLineRow = {
  id: number;
  source_month_id: number;
  external_ref: string | null;
  line_date: string | null;
  description: string | null;
  amount_cents: number;
  currency: string;
  reference: string | null;
  is_matched: boolean;
  matched_order_id: string | null;
  line_type: string | null;
  match_confidence: string | null;
  metadata: unknown;
  created_at: string;
};

type SourceMonthDetailRow = {
  id: number;
  source_id: number;
  source_name: string;
  source_type: string;
  source_config: Record<string, unknown>;
  status: string;
  last_synced_at: string | null;
  sales_amount_cents: number | null;
  refunds_amount_cents: number | null;
  net_activity_cents: number | null;
  sync_type: string | null;
  total_amount_cents: number | null;
  variance_cents: number | null;
  accounting_entity_month_id: number;
  entity_id: number;
  accounting_month_id: number;
  workspace_owner_id: string;
  year: number;
  month: number;
};

type CashSessionRow = {
  id: number;
  session_number: string;
  status: string;
  currency: string;
  secondary_currency: string | null;
  opening_cash: string;
  opening_cash_secondary: string | null;
  cash_in_total: string;
  cash_out_total: string;
  adjustments_total: string;
  cash_in_total_secondary: string | null;
  cash_out_total_secondary: string | null;
  expected_cash: string | null;
  expected_cash_secondary: string | null;
  actual_cash: string | null;
  actual_cash_secondary: string | null;
  difference: string | null;
  difference_secondary: string | null;
  opened_at: string | null;
  closed_at: string | null;
  drawer_name: string | null;
  drawer_code: string | null;
  location_id: number | null;
  location_name: string | null;
};

type CardPaymentRow = {
  payment_id: string;
  order_id: string;
  display_order_number: string | null;
  status: string;
  method: string | null;
  provider: string | null;
  amount: string | null;
  currency: string | null;
  amount_usd: string | null;
  refunded_amount: string | null;
  refunded_amount_usd: string | null;
  paid_at: string | null;
  location_id: number | null;
  location_name: string | null;
};

// Over/short threshold in cents (default $50 / 50 AED)
const DEFAULT_VARIANCE_THRESHOLD_CENTS = 5000;

// ── Auto-init helpers ─────────────────────────────────────────────────────────

/**
 * Find or create accounting_months + entity_months + source_months for
 * the given workspace/year/month across ALL active finance entities.
 * Returns the list of source months with embedded source info, or null
 * if no finance entity exists.
 */
async function autoInitSourceMonths(
  workspaceOwnerId: string,
  year: number,
  month: number,
): Promise<SourceMonthDetailRow[] | null> {
  // 1. Find or create accounting_months row
  const ins = await db.query<{ id: number }>(
    `INSERT INTO accounting_months (workspace_owner_id, year, month)
     VALUES ($1, $2, $3)
     ON CONFLICT (workspace_owner_id, year, month) DO UPDATE SET updated_at = now()
     RETURNING id`,
    [workspaceOwnerId, year, month],
  );
  const accountingMonthId = ins.rows[0].id;

  // 2. Find ALL active finance entities for workspace
  const entityResult = await db.query<{ id: number }>(
    `SELECT id FROM finance_entities WHERE workspace_owner_id = $1 AND is_active = true ORDER BY id`,
    [workspaceOwnerId],
  );
  if (!entityResult.rowCount || entityResult.rowCount === 0) {
    return null;
  }

  // 3. For each entity: find-or-create entity_month, then source_months
  for (const entity of entityResult.rows) {
    // Find or create accounting_entity_months
    const aemIns = await db.query<{ id: number }>(
      `INSERT INTO accounting_entity_months (accounting_month_id, workspace_owner_id, entity_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (accounting_month_id, entity_id) DO UPDATE SET updated_at = now()
       RETURNING id`,
      [accountingMonthId, workspaceOwnerId, entity.id],
    );
    const entityMonthId = aemIns.rows[0].id;

    // Find all active accounting sources for this entity
    const sourcesResult = await db.query<{ id: number }>(
      `SELECT id FROM accounting_sources
       WHERE workspace_owner_id = $1 AND entity_id = $2 AND is_active = true
       ORDER BY sort_order`,
      [workspaceOwnerId, entity.id],
    );

    // Find or create source_months for each source
    for (const src of sourcesResult.rows) {
      await db.query(
        `INSERT INTO accounting_source_months (accounting_entity_month_id, source_id)
         VALUES ($1, $2)
         ON CONFLICT (accounting_entity_month_id, source_id) DO NOTHING`,
        [entityMonthId, src.id],
      );
    }
  }

  // 4. Return enriched list across all entities for this month
  const result = await db.query<SourceMonthDetailRow>(
    `SELECT
       asm.id, asm.status, asm.last_synced_at, asm.sales_amount_cents,
       asm.refunds_amount_cents, asm.net_activity_cents, asm.sync_type,
       asm.total_amount_cents, asm.variance_cents,
       asm.accounting_entity_month_id, asm.source_id,
       asrc.name as source_name, asrc.source_type, asrc.config as source_config,
       aem.entity_id, aem.accounting_month_id,
       am.workspace_owner_id, am.year, am.month
     FROM accounting_source_months asm
     JOIN accounting_sources asrc ON asrc.id = asm.source_id
     JOIN accounting_entity_months aem ON aem.id = asm.accounting_entity_month_id
     JOIN accounting_months am ON am.id = aem.accounting_month_id
     WHERE am.id = $1 AND am.workspace_owner_id = $2
     ORDER BY aem.entity_id, asrc.sort_order`,
    [accountingMonthId, workspaceOwnerId],
  );
  return result.rows;
}

/** Resolve source month with workspace check, returning full detail. */
async function resolveSourceMonth(
  sourceMonthId: number,
  workspaceOwnerId: string,
): Promise<SourceMonthDetailRow | null> {
  const result = await db.query<SourceMonthDetailRow>(
    `SELECT
       asm.id, asm.status, asm.last_synced_at, asm.sales_amount_cents,
       asm.refunds_amount_cents, asm.net_activity_cents, asm.sync_type,
       asm.total_amount_cents, asm.variance_cents,
       asm.accounting_entity_month_id, asm.source_id,
       asrc.name as source_name, asrc.source_type, asrc.config as source_config,
       aem.entity_id, aem.accounting_month_id,
       am.workspace_owner_id, am.year, am.month
     FROM accounting_source_months asm
     JOIN accounting_sources asrc ON asrc.id = asm.source_id
     JOIN accounting_entity_months aem ON aem.id = asm.accounting_entity_month_id
     JOIN accounting_months am ON am.id = aem.accounting_month_id
     WHERE asm.id = $1 AND am.workspace_owner_id = $2`,
    [sourceMonthId, workspaceOwnerId],
  );
  return result.rowCount && result.rowCount > 0 ? result.rows[0] : null;
}

// ── Retail Cash Sync ──────────────────────────────────────────────────────────

async function syncRetailCash(
  sourceMonthId: number,
  sm: SourceMonthDetailRow,
): Promise<{ recordsSynced: number; exceptionsRaised: number }> {
  const { monthStart, monthEnd } = getMonthRange(sm.year, sm.month);
  const config = sm.source_config as Record<string, number> | null;
  const varianceThreshold = (config?.variance_threshold_cents as number | undefined) ?? DEFAULT_VARIANCE_THRESHOLD_CENTS;

  // Query sessions
  const sessionsResult = await db.query<CashSessionRow>(
    `SELECT
       cs.id, cs.session_number, cs.status, cs.currency, cs.secondary_currency,
       cs.opening_cash, cs.opening_cash_secondary,
       cs.cash_in_total, cs.cash_out_total, cs.adjustments_total,
       cs.cash_in_total_secondary, cs.cash_out_total_secondary,
       cs.expected_cash, cs.expected_cash_secondary,
       cs.actual_cash, cs.actual_cash_secondary,
       cs.difference, cs.difference_secondary,
       cs.opened_at, cs.closed_at,
       cd.name as drawer_name, cd.code as drawer_code,
       l.id as location_id, l.name as location_name
     FROM cash_sessions cs
     LEFT JOIN cash_drawers cd ON cd.id = cs.drawer_id
     LEFT JOIN locations l ON l.id = cs.location_id
     WHERE cs.workspace_owner_id = $1
       AND cs.opened_at >= $2
       AND cs.opened_at < $3
     ORDER BY cs.opened_at`,
    [sm.workspace_owner_id, monthStart.toISOString(), monthEnd.toISOString()],
  );

  const sessions = sessionsResult.rows;

  // Delete old lines and exceptions for this source month
  await db.query(`DELETE FROM source_statement_lines WHERE source_month_id = $1`, [sourceMonthId]);
  await db.query(
    `DELETE FROM accounting_exceptions WHERE source_month_id = $1 AND status = 'open'`,
    [sourceMonthId],
  );

  // Check if entity month is already closed (for is_post_close flagging on new exceptions)
  const emStatusRes = await db.query<{ status: string }>(
    `SELECT status FROM accounting_entity_months WHERE id = $1`,
    [sm.accounting_entity_month_id],
  );
  const isPostClose = emStatusRes.rows[0]?.status === "closed";

  // Aggregate totals (primary currency, no FX conversion)
  let totalSalesCents = 0;
  let totalRefundsCents = 0;
  let exceptionsRaised = 0;
  const lines: Array<[string, number, string, string, Record<string, unknown>]> = [];

  for (const s of sessions) {
    const salesCents = toCents(s.cash_in_total);
    const refundsCents = toCents(s.cash_out_total);
    const differenceCents = toCents(s.difference);

    // Primary currency line
    const lineDate = s.opened_at ? s.opened_at.substring(0, 10) : null;
    const description = [
      s.session_number,
      s.drawer_name,
      s.location_name,
    ]
      .filter(Boolean)
      .join(" — ");
    const metadata: Record<string, unknown> = {
      session_id: s.id,
      session_number: s.session_number,
      drawer_name: s.drawer_name,
      drawer_code: s.drawer_code,
      location_id: s.location_id,
      location_name: s.location_name,
      status: s.status,
      opened_at: s.opened_at,
      closed_at: s.closed_at,
      opening_cash: s.opening_cash,
      cash_in_total: s.cash_in_total,
      cash_out_total: s.cash_out_total,
      adjustments_total: s.adjustments_total,
      expected_cash: s.expected_cash,
      actual_cash: s.actual_cash,
      difference: s.difference,
      is_primary: true,
    };
    lines.push([lineDate ?? "", salesCents, s.currency, s.session_number ?? "", metadata]);

    // Secondary currency line (if present)
    if (s.secondary_currency && parseDec(s.cash_in_total_secondary) !== 0) {
      const secCents = toCents(s.cash_in_total_secondary);
      const secMeta: Record<string, unknown> = {
        ...metadata,
        currency: s.secondary_currency,
        cash_in_total: s.cash_in_total_secondary,
        cash_out_total: s.cash_out_total_secondary,
        expected_cash: s.expected_cash_secondary,
        actual_cash: s.actual_cash_secondary,
        difference: s.difference_secondary,
        is_primary: false,
      };
      lines.push([lineDate ?? "", secCents, s.secondary_currency, s.session_number ?? "", secMeta]);
    }

    totalSalesCents += salesCents;
    totalRefundsCents += refundsCents;

    // Exception: unclosed session
    const isClosed = s.status === "approved" || s.status === "closed" || s.closed_at != null;
    if (!isClosed) {
      await db.query(
        `INSERT INTO accounting_exceptions
           (accounting_month_id, entity_id, exception_type, description, amount_cents, source_month_id, is_post_close)
         VALUES ($1, $2, 'unclosed_cash_session', $3, $4, $5, $6)`,
        [
          sm.accounting_month_id,
          sm.entity_id,
          `Unclosed cash session: ${s.session_number}${s.location_name ? ` (${s.location_name})` : ""}`,
          salesCents,
          sourceMonthId,
          isPostClose,
        ],
      );
      exceptionsRaised++;
    }

    // Exception: cash over/short beyond threshold
    const absDifferenceCents = Math.abs(differenceCents);
    if (s.difference != null && absDifferenceCents > varianceThreshold) {
      await db.query(
        `INSERT INTO accounting_exceptions
           (accounting_month_id, entity_id, exception_type, description, amount_cents, source_month_id, is_post_close)
         VALUES ($1, $2, 'cash_over_short', $3, $4, $5, $6)`,
        [
          sm.accounting_month_id,
          sm.entity_id,
          `Cash over/short ${differenceCents > 0 ? "over" : "short"} by ${s.currency} ${Math.abs(parseDec(s.difference)).toFixed(2)}: ${s.session_number}`,
          differenceCents,
          sourceMonthId,
          isPostClose,
        ],
      );
      exceptionsRaised++;
    }
  }

  // Insert statement lines
  for (const [lineDate, amountCents, currency, reference, metadata] of lines) {
    await db.query(
      `INSERT INTO source_statement_lines
         (source_month_id, line_date, description, amount_cents, currency, reference, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        sourceMonthId,
        lineDate || null,
        [metadata.session_number, metadata.drawer_name, metadata.location_name].filter(Boolean).join(" — "),
        amountCents,
        currency,
        reference,
        JSON.stringify(metadata),
      ],
    );
  }

  const netActivityCents = totalSalesCents - totalRefundsCents;

  // Update source_month totals
  await db.query(
    `UPDATE accounting_source_months
     SET sales_amount_cents = $1,
         refunds_amount_cents = $2,
         net_activity_cents = $3,
         total_amount_cents = $3,
         last_synced_at = now(),
         sync_type = 'automatic',
         status = 'synced',
         updated_at = now()
     WHERE id = $4`,
    [totalSalesCents, totalRefundsCents, netActivityCents, sourceMonthId],
  );

  return { recordsSynced: sessions.length, exceptionsRaised };
}

// ── Retail Card Sync ──────────────────────────────────────────────────────────

async function syncRetailCard(
  sourceMonthId: number,
  sm: SourceMonthDetailRow,
): Promise<{ recordsSynced: number; exceptionsRaised: number }> {
  const { monthStart, monthEnd } = getMonthRange(sm.year, sm.month);

  // Query card payments
  const paymentsResult = await db.query<CardPaymentRow>(
    `SELECT
       op.id as payment_id, o.id as order_id, o.display_order_number,
       op.status, op.method, op.provider,
       op.amount, op.currency, op.amount_usd,
       op.refunded_amount, op.refunded_amount_usd,
       op.paid_at,
       o.location_id,
       l.name as location_name
     FROM order_payment op
     JOIN orders o ON o.id = op.order_id
     LEFT JOIN locations l ON l.id = o.location_id
     WHERE o.workspace_owner_id = $1
       AND op.method = 'card'
       AND op.paid_at >= $2
       AND op.paid_at < $3
       AND op.status = 'paid'
     ORDER BY op.paid_at`,
    [sm.workspace_owner_id, monthStart.toISOString(), monthEnd.toISOString()],
  );

  const payments = paymentsResult.rows;

  // Delete old lines for this source month
  await db.query(`DELETE FROM source_statement_lines WHERE source_month_id = $1`, [sourceMonthId]);

  let totalSalesCents = 0;
  let totalRefundsCents = 0;

  for (const p of payments) {
    const amountUsdCents = toCents(p.amount_usd);
    const refundedUsdCents = toCents(p.refunded_amount_usd);
    const lineDate = p.paid_at ? p.paid_at.substring(0, 10) : null;
    const description = [
      p.display_order_number ? `Order ${p.display_order_number}` : "Card payment",
      p.provider,
      p.location_name,
    ]
      .filter(Boolean)
      .join(" — ");
    const metadata: Record<string, unknown> = {
      order_id: p.order_id,
      display_order_number: p.display_order_number,
      payment_id: p.payment_id,
      method: p.method,
      provider: p.provider,
      amount: p.amount,
      currency: p.currency,
      amount_usd: p.amount_usd,
      refunded_amount: p.refunded_amount,
      refunded_amount_usd: p.refunded_amount_usd,
      location_id: p.location_id,
      location_name: p.location_name,
    };

    await db.query(
      `INSERT INTO source_statement_lines
         (source_month_id, line_date, description, amount_cents, currency, reference, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        sourceMonthId,
        lineDate,
        description,
        amountUsdCents,
        "USD",
        p.display_order_number ?? p.order_id,
        JSON.stringify(metadata),
      ],
    );

    totalSalesCents += amountUsdCents;
    totalRefundsCents += refundedUsdCents;
  }

  const netActivityCents = totalSalesCents - totalRefundsCents;

  await db.query(
    `UPDATE accounting_source_months
     SET sales_amount_cents = $1,
         refunds_amount_cents = $2,
         net_activity_cents = $3,
         total_amount_cents = $3,
         last_synced_at = now(),
         sync_type = 'automatic',
         status = 'synced',
         updated_at = now()
     WHERE id = $4`,
    [totalSalesCents, totalRefundsCents, netActivityCents, sourceMonthId],
  );

  return { recordsSynced: payments.length, exceptionsRaised: 0 };
}

// ── Routes ────────────────────────────────────────────────────────────────────

type SyncRunRow = {
  id: number;
  source_month_id: number;
  status: string;
  started_at: string;
  completed_at: string | null;
  error_message: string | null;
  records_synced: number;
  filename: string | null;
  template_id: number | null;
  uploaded_by: string | null;
  rows_accepted: number;
  rows_rejected: number;
  total_gross_cents: number | null;
  total_refunds_cents: number | null;
  total_fees_cents: number | null;
  storage_path: string | null;
  created_at: string;
};

type ImportTemplateRow = {
  id: number;
  workspace_owner_id: string;
  name: string;
  source_type: string;
  column_mappings: Record<string, string>;
  created_at: string;
  updated_at: string;
};

router.get("/accounting/months", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccounting(wreq)) {
    res.status(403).json({ error: "Finance & Accounting access required" });
    return;
  }

  const year = req.query.year ? parseInt(req.query.year as string, 10) : undefined;

  let queryText = `SELECT * FROM accounting_months WHERE workspace_owner_id = $1`;
  const params: unknown[] = [wreq.workspaceOwnerId];

  if (year !== undefined && !isNaN(year)) {
    queryText += ` AND year = $2`;
    params.push(year);
  }

  queryText += ` ORDER BY year DESC, month DESC`;

  const result = await db.query<AccountingMonthRow>(queryText, params);
  res.json({ months: result.rows });
});

// ── POST /accounting/months ───────────────────────────────────────────────────

router.post("/accounting/months", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccounting(wreq)) {
    res.status(403).json({ error: "Finance & Accounting access required" });
    return;
  }

  const { year, month, notes } = req.body as Record<string, unknown>;

  if (!year || !month) {
    res.status(400).json({ error: "year and month are required" });
    return;
  }

  const y = Number(year);
  const m = Number(month);

  if (isNaN(y) || isNaN(m) || m < 1 || m > 12) {
    res.status(400).json({ error: "Invalid year or month" });
    return;
  }

  try {
    const result = await db.query<AccountingMonthRow>(
      `INSERT INTO accounting_months (workspace_owner_id, year, month, notes)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [wreq.workspaceOwnerId, y, m, notes ?? null],
    );
    res.status(201).json({ month: result.rows[0] });
  } catch (err: unknown) {
    const pgErr = err as { code?: string };
    if (pgErr?.code === "23505") {
      const existing = await db.query<AccountingMonthRow>(
        `SELECT * FROM accounting_months WHERE workspace_owner_id = $1 AND year = $2 AND month = $3`,
        [wreq.workspaceOwnerId, y, m],
      );
      res.status(409).json({ error: "Record already exists", month: existing.rows[0] });
      return;
    }
    throw err;
  }
});

// ── GET /accounting/months/:id ────────────────────────────────────────────────

router.get("/accounting/months/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccounting(wreq)) {
    res.status(403).json({ error: "Finance & Accounting access required" });
    return;
  }

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid month id" });
    return;
  }

  const result = await db.query<AccountingMonthRow>(
    `SELECT * FROM accounting_months WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );

  if (result.rowCount === 0) {
    res.status(404).json({ error: "Accounting month not found" });
    return;
  }

  res.json({ month: result.rows[0] });
});

// ── GET /accounting/months/:id/overview ──────────────────────────────────────

router.get("/accounting/months/:id/overview", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccounting(wreq)) {
    res.status(403).json({ error: "Finance & Accounting access required" });
    return;
  }

  const monthId = parseInt(req.params.id, 10);
  if (isNaN(monthId)) {
    res.status(400).json({ error: "Invalid month id" });
    return;
  }

  const monthResult = await db.query<AccountingMonthRow>(
    `SELECT * FROM accounting_months WHERE id = $1 AND workspace_owner_id = $2`,
    [monthId, wreq.workspaceOwnerId],
  );

  if (monthResult.rowCount === 0) {
    res.status(404).json({ error: "Accounting month not found" });
    return;
  }

  const month = monthResult.rows[0];

  // Load entities
  type EntityRow = { id: number; legal_name: string; display_name: string | null };
  const entitiesResult = await db.query<EntityRow>(
    `SELECT id, legal_name, display_name FROM finance_entities
     WHERE workspace_owner_id = $1 AND is_active = true
     ORDER BY id`,
    [wreq.workspaceOwnerId],
  );
  const entities = entitiesResult.rows;

  // Load entity months for this accounting month
  type EntityMonthRow = { id: number; entity_id: number; status: string };
  const entityMonthsResult = await db.query<EntityMonthRow>(
    `SELECT id, entity_id, status FROM accounting_entity_months
     WHERE accounting_month_id = $1 AND workspace_owner_id = $2`,
    [monthId, wreq.workspaceOwnerId],
  );
  const entityMonthMap = new Map(entityMonthsResult.rows.map((r) => [r.entity_id, r]));

  // Load sources + source_months for this accounting month
  type SourceMonthJoinRow = {
    source_id: number;
    source_name: string;
    entity_id: number;
    sort_order: number;
    is_intercompany: boolean;
    source_month_id: number | null;
    status: string | null;
    os_sales_cents: number | null;
    external_source_cents: number | null;
    total_amount_cents: number | null;
    variance_cents: number | null;
    refunds_cents: number | null;
    fees_cents: number | null;
    net_activity_cents: number | null;
    payout_status: string | null;
    last_synced_at: string | null;
  };

  const sourcesResult = await db.query<SourceMonthJoinRow>(
    `SELECT
       asrc.id             AS source_id,
       asrc.name           AS source_name,
       asrc.entity_id,
       asrc.sort_order,
       asrc.is_intercompany,
       asm.id              AS source_month_id,
       asm.status,
       asm.os_sales_cents,
       asm.external_source_cents,
       asm.total_amount_cents,
       asm.variance_cents,
       asm.refunds_cents,
       asm.fees_cents,
       asm.net_activity_cents,
       asm.payout_status,
       asm.last_synced_at
     FROM accounting_sources asrc
     LEFT JOIN accounting_entity_months aem
       ON aem.accounting_month_id = $1 AND aem.entity_id = asrc.entity_id
     LEFT JOIN accounting_source_months asm
       ON asm.accounting_entity_month_id = aem.id AND asm.source_id = asrc.id
     WHERE asrc.workspace_owner_id = $2
       AND (
         asrc.is_active = true
         OR (asm.id IS NOT NULL AND aem.status = 'closed')
       )
     ORDER BY asrc.entity_id, asrc.sort_order`,
    [monthId, wreq.workspaceOwnerId],
  );

  // Group sources by entity
  const sourcesByEntity = new Map<number, typeof sourcesResult.rows>();
  for (const row of sourcesResult.rows) {
    if (!sourcesByEntity.has(row.entity_id)) sourcesByEntity.set(row.entity_id, []);
    sourcesByEntity.get(row.entity_id)!.push(row);
  }

  // Count open exceptions
  type ExcRow = { cnt: string };
  const excResult = await db.query<ExcRow>(
    `SELECT COUNT(*) AS cnt FROM accounting_exceptions
     WHERE accounting_month_id = $1 AND status = 'open'`,
    [monthId],
  );
  const openExceptionsCount = parseInt(excResult.rows[0]?.cnt ?? "0", 10);

  // Assemble entity overviews
  const entityOverviews = entities.map((e) => {
    const em = entityMonthMap.get(e.id);
    const sources = sourcesByEntity.get(e.id) ?? [];
    return {
      entityId: e.id,
      entityName: e.display_name ?? e.legal_name,
      status: em?.status ?? "not_started",
      entityMonthId: em?.id ?? null,
      sources: sources.map((s) => {
        const differenceCents =
          s.os_sales_cents !== null && s.external_source_cents !== null
            ? s.os_sales_cents - s.external_source_cents
            : null;
        return {
          sourceId: s.source_id,
          sourceMonthId: s.source_month_id,
          sourceName: s.source_name,
          isIntercompany: s.is_intercompany,
          osSalesCents: s.os_sales_cents,
          externalSourceCents: s.external_source_cents,
          totalAmountCents: s.total_amount_cents,
          varianceCents: s.variance_cents,
          differenceCents,
          refundsCents: s.refunds_cents,
          feesCents: s.fees_cents,
          netActivityCents: s.net_activity_cents,
          salesStatus: s.status ?? "not_started",
          payoutStatus: s.payout_status,
          lastSyncedAt: s.last_synced_at,
        };
      }),
    };
  });

  // Exclude intercompany sources from aggregate metrics
  const nonIntercompanyRows = sourcesResult.rows.filter((r) => !r.is_intercompany);

  // Combined sales (non-intercompany only)
  const combinedSalesCents = nonIntercompanyRows.reduce(
    (sum, r) => (r.os_sales_cents !== null ? sum + r.os_sales_cents : sum),
    0,
  );

  const sourcesCount = nonIntercompanyRows.length;
  const sourcesSyncedCount = nonIntercompanyRows.filter(
    (r) => r.status === "synced" || r.status === "reconciled",
  ).length;
  const entitiesReadyCount = entityOverviews.filter((e) => e.status === "closed").length;

  // openExceptionsEvaluated: true only when at least one non-intercompany source has been synced
  const openExceptionsEvaluated = sourcesSyncedCount > 0;

  const insights: string[] = [];
  if (sourcesSyncedCount < sourcesCount) {
    insights.push(`Sources have not yet been synced for this period.`);
  }
  if (openExceptionsCount > 0) {
    insights.push(`${openExceptionsCount} open exception(s) require attention before closing.`);
  }

  res.json({
    overview: {
      monthId: month.id,
      year: month.year,
      month: month.month,
      status: month.status,
      combinedSalesCents,
      sourcesCount,
      sourcesSyncedCount,
      openExceptionsCount,
      openExceptionsEvaluated,
      entitiesReadyCount,
      entities: entityOverviews,
      insights,
    },
  });
});

// ── GET /accounting/months/:monthId/source-months ─────────────────────────────
// List all source-month records for a given accounting_month (via entity_month join).

router.get("/accounting/months/:monthId/source-months", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccounting(wreq)) {
    res.status(403).json({ error: "Finance & Accounting access required" });
    return;
  }

  const monthId = parseInt(req.params.monthId, 10);
  if (isNaN(monthId)) {
    res.status(400).json({ error: "Invalid month id" });
    return;
  }

  const month = await db.query<{ id: number; workspace_owner_id: string }>(
    `SELECT id, workspace_owner_id FROM accounting_months WHERE id = $1`,
    [monthId],
  );
  if ((month.rowCount ?? 0) === 0 || month.rows[0].workspace_owner_id !== wreq.workspaceOwnerId) {
    res.status(404).json({ error: "Accounting month not found" });
    return;
  }

  const result = await db.query<AccountingSourceMonthRow>(
    `SELECT asm.*, s.name AS source_name, s.source_type
       FROM accounting_source_months asm
       JOIN accounting_entity_months aem ON aem.id = asm.accounting_entity_month_id
       JOIN accounting_sources s ON s.id = asm.source_id
      WHERE aem.accounting_month_id = $1
        AND aem.workspace_owner_id = $2
      ORDER BY s.sort_order ASC, s.name ASC`,
    [monthId, wreq.workspaceOwnerId],
  );

  res.json({ sourceMonths: result.rows });
});

// ── GET /accounting/entity-months/:id/checklist ───────────────────────────────

router.get("/accounting/entity-months/:id/checklist", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccounting(wreq)) {
    res.status(403).json({ error: "Finance & Accounting access required" });
    return;
  }

  const entityMonthId = parseInt(req.params.id, 10);
  if (isNaN(entityMonthId)) {
    res.status(400).json({ error: "Invalid entity-month id" });
    return;
  }

  // Verify entity-month belongs to workspace
  type EntityMonthDetail = { id: number; accounting_month_id: number; entity_id: number; status: string };
  const emResult = await db.query<EntityMonthDetail>(
    `SELECT id, accounting_month_id, entity_id, status FROM accounting_entity_months
     WHERE id = $1 AND workspace_owner_id = $2`,
    [entityMonthId, wreq.workspaceOwnerId],
  );
  if (emResult.rowCount === 0) {
    res.status(404).json({ error: "Entity month not found" });
    return;
  }
  const em = emResult.rows[0];

  // Load existing checklist items for this month + entity
  type ChecklistRow = {
    id: number;
    label: string;
    is_checked: boolean;
    checked_by: string | null;
    checked_at: string | null;
    sort_order: number;
  };

  let itemsResult = await db.query<ChecklistRow>(
    `SELECT id, label, is_checked, checked_by, checked_at, sort_order
     FROM close_checklist_items
     WHERE accounting_month_id = $1
       AND (entity_id = $2 OR entity_id IS NULL)
     ORDER BY sort_order`,
    [em.accounting_month_id, em.entity_id],
  );

  // Auto-seed default items if none exist for this entity
  if (!itemsResult.rowCount || itemsResult.rowCount === 0) {
    const rowPlaceholders = CHECKLIST_LABELS.map(
      (_, i) => `($1, $2, false, $${i + 3}, ${i})`,
    ).join(", ");
    await db.query(
      `INSERT INTO close_checklist_items (accounting_month_id, entity_id, is_checked, label, sort_order)
       VALUES ${rowPlaceholders}`,
      [em.accounting_month_id, em.entity_id, ...CHECKLIST_LABELS],
    );

    itemsResult = await db.query<ChecklistRow>(
      `SELECT id, label, is_checked, checked_by, checked_at, sort_order
       FROM close_checklist_items
       WHERE accounting_month_id = $1
         AND (entity_id = $2 OR entity_id IS NULL)
       ORDER BY sort_order`,
      [em.accounting_month_id, em.entity_id],
    );
  }

  const autoCompleted = await computeAutoCompletedItems(entityMonthId, em.accounting_month_id, em.entity_id);

  const items = itemsResult.rows.map((r) => ({
    id: r.id,
    label: r.label,
    isChecked: r.is_checked || autoCompleted.has(r.sort_order),
    isAutoCompleted: autoCompleted.has(r.sort_order),
    checkedBy: r.checked_by,
    checkedAt: r.checked_at,
    sortOrder: r.sort_order,
  }));

  const completedCount = items.filter((i) => i.isChecked).length;

  res.json({
    checklist: {
      entityMonthId,
      entityId: em.entity_id,
      items,
      completedCount,
      totalCount: items.length,
    },
  });
});

/**
 * GET /accounting/source-months?year=X&month=Y
 * List accounting source months for the given year/month, auto-initializing
 * the month/entity/source hierarchy on first access.
 */
router.get("/accounting/source-months", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccounting(wreq)) {
    res.status(403).json({ error: "Finance & Accounting access required" });
    return;
  }

  const year = parseInt(String(req.query.year ?? ""), 10);
  const month = parseInt(String(req.query.month ?? ""), 10);

  if (isNaN(year) || isNaN(month) || month < 1 || month > 12) {
    res.status(400).json({ error: "year and month query parameters are required" });
    return;
  }

  const sources = await autoInitSourceMonths(wreq.workspaceOwnerId, year, month);

  if (sources === null) {
    res.json({ sources: [] });
    return;
  }

  res.json({
    sources: sources.map((s) => ({
      id: s.id,
      source_id: s.source_id,
      source_name: s.source_name,
      source_type: s.source_type,
      status: s.status,
      last_synced_at: s.last_synced_at,
      sales_amount_cents: s.sales_amount_cents,
      refunds_amount_cents: s.refunds_amount_cents,
      net_activity_cents: s.net_activity_cents,
      sync_type: s.sync_type,
      total_amount_cents: s.total_amount_cents,
      variance_cents: s.variance_cents,
      accounting_month_id: s.accounting_month_id,
      entity_id: s.entity_id,
    })),
  });
});

// ── GET /accounting/source-months/:id ────────────────────────────────────────
// Get a single source-month with its recent sync runs and statement lines.

router.get("/accounting/source-months/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccounting(wreq)) {
    res.status(403).json({ error: "Finance & Accounting access required" });
    return;
  }

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid source month id" });
    return;
  }

  const smResult = await db.query<AccountingSourceMonthRow & { workspace_owner_id: string }>(
    `SELECT asm.*, s.name AS source_name, s.source_type, aem.workspace_owner_id
       FROM accounting_source_months asm
       JOIN accounting_entity_months aem ON aem.id = asm.accounting_entity_month_id
       JOIN accounting_sources s ON s.id = asm.source_id
      WHERE asm.id = $1`,
    [id],
  );

  if ((smResult.rowCount ?? 0) === 0) {
    res.status(404).json({ error: "Source month not found" });
    return;
  }

  const sm = smResult.rows[0];
  if (sm.workspace_owner_id !== wreq.workspaceOwnerId) {
    res.status(404).json({ error: "Source month not found" });
    return;
  }

  const runsResult = await db.query<SourceSyncRunRow>(
    `SELECT * FROM source_sync_runs WHERE source_month_id = $1 ORDER BY started_at DESC LIMIT 10`,
    [id],
  );

  const linesResult = await db.query<SourceStatementLineRow>(
    `SELECT * FROM source_statement_lines WHERE source_month_id = $1 ORDER BY line_date DESC, id DESC LIMIT 500`,
    [id],
  );

  res.json({
    sourceMonth: sm,
    syncRuns: runsResult.rows,
    lines: linesResult.rows,
  });
});

// ── POST /accounting/source-months/ensure ────────────────────────────────────
// Get or create a source-month record for a given accounting_month + source_type.
// Creates the entity_month and source records as needed.

/**
 * GET /accounting/sources?year=&month=
 * Returns all accounting sources for the workspace with optional month status.
 */
router.get("/accounting/sources", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccounting(wreq)) {
    res.status(403).json({ error: "Finance & Accounting access required" });
    return;
  }

  const year = req.query.year ? parseInt(String(req.query.year), 10) : undefined;
  const month = req.query.month ? parseInt(String(req.query.month), 10) : undefined;

  if (year && month) {
    const result = await db.query<AccountingSourceRow>(
      `SELECT
        s.id, s.workspace_owner_id, s.entity_id, s.name, s.source_type,
        s.is_active, s.is_auto_sync, s.is_intercompany, s.sort_order, s.config,
        sm.id AS source_month_id,
        sm.sales_status,
        sm.last_synced_at,
        sm.rows_count,
        sr.status AS last_run_status,
        sr.filename AS last_run_filename,
        sr.rows_accepted AS last_run_rows_accepted,
        sr.rows_rejected AS last_run_rows_rejected
      FROM accounting_sources s
      LEFT JOIN accounting_entity_months em
        ON em.entity_id = s.entity_id
        AND em.workspace_owner_id = s.workspace_owner_id
      LEFT JOIN accounting_months am
        ON am.id = em.accounting_month_id
        AND am.year = $2 AND am.month = $3
      LEFT JOIN accounting_source_months sm
        ON sm.source_id = s.id
        AND sm.accounting_entity_month_id = em.id
        AND am.id IS NOT NULL
      LEFT JOIN LATERAL (
        SELECT status, filename, rows_accepted, rows_rejected
        FROM source_sync_runs
        WHERE source_month_id = sm.id
        ORDER BY started_at DESC
        LIMIT 1
      ) sr ON true
      WHERE s.workspace_owner_id = $1 AND s.is_active = true
      ORDER BY s.entity_id, s.sort_order, s.id`,
      [wreq.workspaceOwnerId, year, month],
    );
    res.json({ sources: result.rows });
  } else {
    const result = await db.query<AccountingSourceRow>(
      `SELECT
        s.id, s.workspace_owner_id, s.entity_id, s.name, s.source_type,
        s.is_active, s.is_auto_sync, s.is_intercompany, s.sort_order, s.config,
        NULL AS source_month_id,
        NULL AS sales_status,
        NULL AS last_synced_at,
        NULL AS rows_count,
        NULL AS last_run_status,
        NULL AS last_run_filename,
        NULL AS last_run_rows_accepted,
        NULL AS last_run_rows_rejected
      FROM accounting_sources s
      WHERE s.workspace_owner_id = $1 AND s.is_active = true
      ORDER BY s.entity_id, s.sort_order, s.id`,
      [wreq.workspaceOwnerId],
    );
    res.json({ sources: result.rows });
  }
});

/**
 * POST /accounting/source-months/ensure
 * Ensures accounting_months → entity_months → source_months chain exists.
 * Returns the source_month id.
 */
router.post("/accounting/source-months/ensure", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccounting(wreq)) {
    res.status(403).json({ error: "Finance & Accounting access required" });
    return;
  }

  const { source_id, year, month } = req.body as Record<string, unknown>;
  if (!source_id || !year || !month) {
    res.status(400).json({ error: "source_id, year, and month are required" });
    return;
  }

  const sid = parseInt(String(source_id), 10);
  const y = parseInt(String(year), 10);
  const m = parseInt(String(month), 10);
  if (isNaN(sid) || isNaN(y) || isNaN(m) || m < 1 || m > 12) {
    res.status(400).json({ error: "Invalid source_id, year, or month" });
    return;
  }

  const srcResult = await db.query<{ id: number; entity_id: number }>(
    `SELECT id, entity_id FROM accounting_sources WHERE id = $1 AND workspace_owner_id = $2`,
    [sid, wreq.workspaceOwnerId],
  );
  if (srcResult.rowCount === 0) {
    res.status(404).json({ error: "Source not found" });
    return;
  }
  const { entity_id } = srcResult.rows[0];

  const amResult = await db.query<{ id: number }>(
    `INSERT INTO accounting_months (workspace_owner_id, year, month)
     VALUES ($1, $2, $3)
     ON CONFLICT (workspace_owner_id, year, month) DO UPDATE SET updated_at = now()
     RETURNING id`,
    [wreq.workspaceOwnerId, y, m],
  );
  const accountingMonthId = amResult.rows[0].id;

  const emResult = await db.query<{ id: number }>(
    `INSERT INTO accounting_entity_months (accounting_month_id, workspace_owner_id, entity_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (accounting_month_id, entity_id) DO UPDATE SET updated_at = now()
     RETURNING id`,
    [accountingMonthId, wreq.workspaceOwnerId, entity_id],
  );
  const entityMonthId = emResult.rows[0].id;

  const smResult = await db.query<SourceMonthRow>(
    `INSERT INTO accounting_source_months (accounting_entity_month_id, source_id)
     VALUES ($1, $2)
     ON CONFLICT (accounting_entity_month_id, source_id) DO UPDATE SET updated_at = now()
     RETURNING *`,
    [entityMonthId, sid],
  );

  res.json({ sourceMonth: smResult.rows[0] });
});

/**
 * POST /accounting/source-months/:id/import/preview
 * Accepts a CSV or Excel file upload, parses it, returns headers + first 20 rows.
 */
router.post(
  "/accounting/source-months/:id/import/preview",
  upload.single("file"),
  async (req, res) => {
    const wreq = workspace(req);
    if (!hasFinanceAccounting(wreq)) {
      res.status(403).json({ error: "Finance & Accounting access required" });
      return;
    }

    const sourceMonthId = parseInt(String(req.params["id"]), 10);
    if (isNaN(sourceMonthId)) {
      res.status(400).json({ error: "Invalid source month id" });
      return;
    }

    const smResult = await db.query<{ id: number; source_id: number; sales_status: string }>(
      `SELECT sm.id, sm.source_id, sm.sales_status
       FROM accounting_source_months sm
       JOIN accounting_entity_months em ON em.id = sm.accounting_entity_month_id
       WHERE sm.id = $1 AND em.workspace_owner_id = $2`,
      [sourceMonthId, wreq.workspaceOwnerId],
    );
    if (smResult.rowCount === 0) {
      res.status(404).json({ error: "Source month not found" });
      return;
    }

    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }

    const filename = file.originalname ?? "upload";
    const isExcel =
      filename.endsWith(".xlsx") ||
      filename.endsWith(".xls") ||
      filename.endsWith(".ods") ||
      file.mimetype?.includes("spreadsheet") ||
      file.mimetype?.includes("excel");

    let headers: string[] = [];
    let rows: Record<string, unknown>[] = [];

    try {
      const data = await parseSpreadsheetToJson(file.buffer, { defval: null });

      if (data.length === 0) {
        res.status(422).json({ error: "File is empty" });
        return;
      }

      headers = Object.keys(data[0]);
      rows = data.slice(0, 20);
    } catch (err) {
      req.log?.error({ err }, "Failed to parse uploaded file");
      res.status(422).json({ error: "Could not parse file. Make sure it is a valid CSV or Excel file." });
      return;
    }

    res.json({
      filename,
      fileType: isExcel ? "excel" : "csv",
      headers,
      previewRows: rows,
      totalRows: undefined,
    });
  },
);

/**
 * GET /accounting/import-templates
 * List saved import column-mapping templates, optionally filtered by sourceType.
 */
router.get("/accounting/import-templates", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccounting(wreq)) {
    res.status(403).json({ error: "Finance & Accounting access required" });
    return;
  }

  const sourceType = req.query.sourceType ? String(req.query.sourceType) : undefined;
  const params: unknown[] = [wreq.workspaceOwnerId];
  const conditions = ["workspace_owner_id = $1"];

  if (sourceType) {
    params.push(sourceType);
    conditions.push(`source_type = $${params.length}`);
  }

  const result = await db.query<ImportTemplateRow>(
    `SELECT * FROM import_templates WHERE ${conditions.join(" AND ")} ORDER BY updated_at DESC`,
    params,
  );

  res.json({ templates: result.rows });
});

/**
 * POST /accounting/import-templates
 * Save a new column-mapping template.
 */
router.post("/accounting/import-templates", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccounting(wreq)) {
    res.status(403).json({ error: "Finance & Accounting access required" });
    return;
  }

  const { name, source_type, column_mappings } = req.body as Record<string, unknown>;
  if (!name || !source_type || !column_mappings || typeof column_mappings !== "object") {
    res.status(400).json({ error: "name, source_type, and column_mappings are required" });
    return;
  }

  const result = await db.query<ImportTemplateRow>(
    `INSERT INTO import_templates (workspace_owner_id, name, source_type, column_mappings)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [wreq.workspaceOwnerId, String(name), String(source_type), JSON.stringify(column_mappings)],
  );

  res.status(201).json({ template: result.rows[0] });
});

/**
 * PATCH /accounting/import-templates/:id
 * Update an existing column-mapping template.
 */
router.patch("/accounting/import-templates/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccounting(wreq)) {
    res.status(403).json({ error: "Finance & Accounting access required" });
    return;
  }

  const templateId = parseInt(req.params.id, 10);
  if (isNaN(templateId)) {
    res.status(400).json({ error: "Invalid template id" });
    return;
  }

  const existing = await db.query<{ id: number }>(
    `SELECT id FROM import_templates WHERE id = $1 AND workspace_owner_id = $2`,
    [templateId, wreq.workspaceOwnerId],
  );
  if (existing.rowCount === 0) {
    res.status(404).json({ error: "Template not found" });
    return;
  }

  const { name, column_mappings } = req.body as Record<string, unknown>;
  const sets: string[] = [];
  const params: unknown[] = [];

  if (name !== undefined) {
    params.push(String(name));
    sets.push(`name = $${params.length}`);
  }
  if (column_mappings !== undefined && typeof column_mappings === "object") {
    params.push(JSON.stringify(column_mappings));
    sets.push(`column_mappings = $${params.length}`);
  }

  if (sets.length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }

  sets.push(`updated_at = now()`);
  params.push(templateId);

  const result = await db.query<ImportTemplateRow>(
    `UPDATE import_templates SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING *`,
    params,
  );

  res.json({ template: result.rows[0] });
});

type ConfirmBody = {
  column_mappings: Record<string, string>;
  save_template?: boolean;
  template_name?: string;
  template_id?: number;
  source_type?: string;
};

type ParsedRow = {
  external_ref: string;
  line_date: string | null;
  description: string | null;
  amount_cents: number;
  currency: string;
  reference: string | null;
  metadata: Record<string, unknown>;
};

type RejectedRow = {
  row_index: number;
  raw: Record<string, unknown>;
  reason: string;
};

function deriveExternalRef(raw: Record<string, unknown>, txIdColumn: string | undefined, rowIndex: number): string {
  if (txIdColumn && raw[txIdColumn] != null && String(raw[txIdColumn]).trim() !== "") {
    return String(raw[txIdColumn]).trim();
  }
  const hash = createHash("sha256").update(JSON.stringify(raw)).digest("hex").slice(0, 16);
  return `row-${rowIndex}-${hash}`;
}

function parseAmountCents(val: unknown): number | null {
  if (val == null || val === "") return null;
  const str = String(val).replace(/,/g, "").trim();
  const n = parseFloat(str);
  if (!isFinite(n)) return null;
  return Math.round(n * 100);
}

function parseDate(val: unknown): string | null {
  if (val == null || val === "") return null;
  const s = String(val).trim();
  if (!s) return null;
  const d = new Date(s);
  if (!isNaN(d.getTime())) return s;
  return s;
}

function mapRows(
  data: Record<string, unknown>[],
  mappings: Record<string, string>,
): { accepted: ParsedRow[]; rejected: RejectedRow[] } {
  const accepted: ParsedRow[] = [];
  const rejected: RejectedRow[] = [];

  const reverseMappings: Record<string, string> = {};
  for (const [osField, csvCol] of Object.entries(mappings)) {
    if (csvCol) reverseMappings[osField] = csvCol;
  }

  for (let i = 0; i < data.length; i++) {
    const raw = data[i];

    const amountCol = reverseMappings["amount"];
    const rawAmount = amountCol ? raw[amountCol] : null;
    const amountCents = parseAmountCents(rawAmount);

    if (amountCents === null && amountCol) {
      rejected.push({ row_index: i, raw, reason: `Cannot parse amount: "${rawAmount}"` });
      continue;
    }

    const txIdCol = reverseMappings["transaction_id"];
    const externalRef = deriveExternalRef(raw, txIdCol, i);

    const metadata: Record<string, unknown> = {};
    for (const [osField, csvCol] of Object.entries(reverseMappings)) {
      if (["amount", "date", "description", "currency", "reference", "transaction_id"].includes(osField)) continue;
      if (csvCol && raw[csvCol] != null) {
        metadata[osField] = raw[csvCol];
      }
    }

    accepted.push({
      external_ref: externalRef,
      line_date: reverseMappings["date"] ? parseDate(raw[reverseMappings["date"]]) : null,
      description: reverseMappings["description"] ? String(raw[reverseMappings["description"]] ?? "").trim() || null : null,
      amount_cents: amountCents ?? 0,
      currency: reverseMappings["currency"] ? String(raw[reverseMappings["currency"]] ?? "USD").trim() || "USD" : "USD",
      reference: reverseMappings["reference"] ? String(raw[reverseMappings["reference"]] ?? "").trim() || null : null,
      metadata,
    });
  }

  return { accepted, rejected };
}

/**
 * POST /accounting/source-months/:id/import/confirm
 * Re-parses file, validates rows, inserts accepted rows (dedup), stores file to GCS, writes sync run.
 */
router.post(
  "/accounting/source-months/:id/import/confirm",
  upload.single("file"),
  async (req, res) => {
    const wreq = workspace(req);
    if (!hasFinanceAccounting(wreq)) {
      res.status(403).json({ error: "Finance & Accounting access required" });
      return;
    }

    const sourceMonthId = parseInt(String(req.params["id"]), 10);
    if (isNaN(sourceMonthId)) {
      res.status(400).json({ error: "Invalid source month id" });
      return;
    }

    const smResult = await db.query<{ id: number; source_id: number; sales_status: string }>(
      `SELECT sm.id, sm.source_id, sm.sales_status
       FROM accounting_source_months sm
       JOIN accounting_entity_months em ON em.id = sm.accounting_entity_month_id
       JOIN accounting_months am ON am.id = em.accounting_month_id
       WHERE sm.id = $1 AND em.workspace_owner_id = $2`,
      [sourceMonthId, wreq.workspaceOwnerId],
    );
    if (smResult.rowCount === 0) {
      res.status(404).json({ error: "Source month not found" });
      return;
    }

    const closedCheck = await db.query<{ status: string }>(
      `SELECT am.status
       FROM accounting_source_months sm
       JOIN accounting_entity_months em ON em.id = sm.accounting_entity_month_id
       JOIN accounting_months am ON am.id = em.accounting_month_id
       WHERE sm.id = $1`,
      [sourceMonthId],
    );
    if (closedCheck.rows[0]?.status === "closed") {
      res.status(409).json({ error: "Cannot import into a closed month" });
      return;
    }

    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }

    let bodyData: ConfirmBody;
    try {
      const rawMapping = Array.isArray(req.body.mapping) ? req.body.mapping[0] : req.body.mapping;
      bodyData = JSON.parse(rawMapping ?? "{}") as ConfirmBody;
    } catch {
      res.status(400).json({ error: "Invalid mapping JSON" });
      return;
    }

    const { column_mappings, save_template, template_name, template_id, source_type } = bodyData;
    if (!column_mappings || typeof column_mappings !== "object") {
      res.status(400).json({ error: "column_mappings is required" });
      return;
    }

    let allData: Record<string, unknown>[] = [];
    try {
      allData = await parseSpreadsheetToJson(file.buffer, { defval: null });
    } catch (err) {
      logger.error({ err }, "Failed to parse file in confirm");
      res.status(422).json({ error: "Could not parse file" });
      return;
    }

    const { accepted, rejected } = mapRows(allData, column_mappings);

    let storedTemplateId: number | null = template_id ?? null;
    if (save_template && template_name && source_type) {
      const tplResult = await db.query<{ id: number }>(
        `INSERT INTO import_templates (workspace_owner_id, name, source_type, column_mappings)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [wreq.workspaceOwnerId, template_name, source_type, JSON.stringify(column_mappings)],
      );
      if (tplResult.rowCount && tplResult.rowCount > 0) {
        storedTemplateId = tplResult.rows[0].id;
      }
    }

    let storagePath: string | null = null;
    try {
      const objectPath = `accounting-imports/${wreq.workspaceOwnerId}/${sourceMonthId}/${Date.now()}-${file.originalname}`;
      const privateDir = objectStorageService.getPrivateObjectDir();
      const fullPath = `${privateDir}/${objectPath}`;
      const pathParts = fullPath.replace(/^\//, "").split("/");
      const bucketName = pathParts[0];
      const objectName = pathParts.slice(1).join("/");

      const bucket = objectStorageClient.bucket(bucketName);
      const gcsFile = bucket.file(objectName);
      await gcsFile.save(file.buffer, { contentType: file.mimetype ?? "application/octet-stream" });
      storagePath = `/objects/${objectPath}`;
    } catch (err) {
      logger.warn({ err }, "Failed to upload import file to GCS — continuing without storage");
    }

    const totalGrossCents = accepted.reduce((s, r) => s + (r.amount_cents > 0 ? r.amount_cents : 0), 0);
    const totalRefundsCents = accepted.reduce((s, r) => s + (r.amount_cents < 0 ? Math.abs(r.amount_cents) : 0), 0);

    const syncRunResult = await db.query<{ id: number }>(
      `INSERT INTO source_sync_runs
         (source_month_id, status, completed_at, records_synced,
          filename, template_id, uploaded_by, rows_accepted, rows_rejected,
          total_gross_cents, total_refunds_cents, storage_path)
       VALUES ($1, 'completed', now(), $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        sourceMonthId,
        accepted.length,
        file.originalname,
        storedTemplateId,
        authed(req).userId,
        accepted.length,
        rejected.length,
        totalGrossCents,
        totalRefundsCents,
        storagePath,
      ],
    );
    const syncRunId = syncRunResult.rows[0].id;

    let insertedCount = 0;
    let skippedCount = 0;
    for (const row of accepted) {
      const insertResult = await db.query<{ id: number }>(
        `INSERT INTO source_statement_lines
           (source_month_id, sync_run_id, external_ref, line_date, description,
            amount_cents, currency, reference, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (source_month_id, external_ref) WHERE external_ref IS NOT NULL
         DO NOTHING
         RETURNING id`,
        [
          sourceMonthId,
          syncRunId,
          row.external_ref,
          row.line_date,
          row.description,
          row.amount_cents,
          row.currency,
          row.reference,
          JSON.stringify(row.metadata),
        ],
      );
      if (insertResult.rowCount && insertResult.rowCount > 0) {
        insertedCount++;
      } else {
        skippedCount++;
      }
    }

    await db.query(
      `UPDATE accounting_source_months
       SET sales_status = 'synced', last_synced_at = now(), rows_count = $2, updated_at = now()
       WHERE id = $1`,
      [sourceMonthId, insertedCount],
    );

    res.json({
      syncRunId,
      rowsAccepted: accepted.length,
      rowsInserted: insertedCount,
      rowsSkipped: skippedCount,
      rowsRejected: rejected.length,
      rejectedRows: rejected,
      totalGross: totalGrossCents / 100,
      totalRefunds: totalRefundsCents / 100,
    });
  },
);

/**
 * GET /accounting/source-months/:id/sync-runs
 * List sync runs for a source month.
 */

/**
 * POST /accounting/source-months/:id/sync
 * Trigger an auto-sync for a retail_cash or card_terminal source month.
 */
router.post("/accounting/source-months/:id/sync", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccounting(wreq)) {
    res.status(403).json({ error: "Finance & Accounting access required" });
    return;
  }

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid source month id" });
    return;
  }

  // First check if it's a Stripe source (HEAD logic)
  const sm_check = await db.query<{
    id: number;
    source_type: string;
    workspace_owner_id: string;
    year: number;
    month: number;
  }>(
    `SELECT asm.id, s.source_type, aem.workspace_owner_id, am.year, am.month
       FROM accounting_source_months asm
       JOIN accounting_entity_months aem ON aem.id = asm.accounting_entity_month_id
       JOIN accounting_months am ON am.id = aem.accounting_month_id
       JOIN accounting_sources s ON s.id = asm.source_id
      WHERE asm.id = $1`,
    [id],
  );

  if (sm_check.rowCount === 0 || sm_check.rows[0].workspace_owner_id !== wreq.workspaceOwnerId) {
    res.status(404).json({ error: "Source month not found" });
    return;
  }

  const head_row = sm_check.rows[0];

  if (["stripe", "paypal", "cash"].includes(head_row.source_type)) {
    const inFlight = await db.query<{ id: number }>(
      `SELECT id FROM source_sync_runs
        WHERE source_month_id = $1 AND status = 'running'
        LIMIT 1`,
      [id],
    );
    if ((inFlight.rowCount ?? 0) > 0) {
      res.status(409).json({ error: "A sync is already in progress for this source month" });
      return;
    }

    try {
      await db.query(
        `UPDATE accounting_source_months SET status = 'syncing', updated_at = now() WHERE id = $1`,
        [id],
      );

      let result: unknown;
      if (head_row.source_type === "stripe") {
        result = await runStripeSync(id, head_row.workspace_owner_id, head_row.year, head_row.month);
      } else if (head_row.source_type === "paypal") {
        result = await runPaypalSync(id, head_row.workspace_owner_id, head_row.year, head_row.month);
      } else {
        result = await runCashSync(id, head_row.workspace_owner_id, head_row.year, head_row.month);
      }

      res.json({ ok: true, sync: result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      req.log.error({ err, sourceMonthId: id, sourceType: head_row.source_type }, "accounting/sync: sync failed");
      res.status(500).json({ error: `${head_row.source_type} sync failed`, message });
    }
    return;
  }

  // Retail Cash / Card logic (Our task)
  const sm = await resolveSourceMonth(id, wreq.workspaceOwnerId);
  if (!sm) {
    res.status(404).json({ error: "Source month not found" });
    return;
  }

  const autoSyncTypes = ["retail_cash", "card_terminal"];
  if (!autoSyncTypes.includes(sm.source_type)) {
    res.status(422).json({
      error: `Auto-sync is not available for source type '${sm.source_type}'. Only stripe, retail_cash and card_terminal support auto-sync.`,
    });
    return;
  }

  // Create sync run record
  const runResult = await db.query<{ id: number }>(
    `INSERT INTO source_sync_runs (source_month_id, status) VALUES ($1, 'running') RETURNING id`,
    [id],
  );
  const runId = runResult.rows[0].id;
  const startedAt = Date.now();

  let recordsSynced = 0;
  let exceptionsRaised = 0;
  let errorMessage: string | null = null;

  try {
    if (sm.source_type === "retail_cash") {
      const result = await syncRetailCash(id, sm);
      recordsSynced = result.recordsSynced;
      exceptionsRaised = result.exceptionsRaised;
    } else if (sm.source_type === "card_terminal") {
      const result = await syncRetailCard(id, sm);
      recordsSynced = result.recordsSynced;
      exceptionsRaised = result.exceptionsRaised;
    }

    // Update sync run as completed
    await db.query(
      `UPDATE source_sync_runs
       SET status = 'completed', completed_at = now(), records_synced = $1
       WHERE id = $2`,
      [recordsSynced, runId],
    );
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : "Unknown error";
    await db.query(
      `UPDATE source_sync_runs
       SET status = 'failed', completed_at = now(), error_message = $1
       WHERE id = $2`,
      [errorMessage, runId],
    );
    res.status(500).json({ error: errorMessage });
    return;
  }

  // Fetch updated source month
  const updated = await resolveSourceMonth(id, wreq.workspaceOwnerId);
  const durationMs = Date.now() - startedAt;

  res.json({
    run: {
      id: runId,
      status: "completed",
      records_synced: recordsSynced,
      exceptions_raised: exceptionsRaised,
      duration_ms: durationMs,
    },
    source_month: updated
      ? {
          id: updated.id,
          source_id: updated.source_id,
          source_name: updated.source_name,
          source_type: updated.source_type,
          status: updated.status,
          last_synced_at: updated.last_synced_at,
          sales_amount_cents: updated.sales_amount_cents,
          refunds_amount_cents: updated.refunds_amount_cents,
          net_activity_cents: updated.net_activity_cents,
          sync_type: updated.sync_type,
          total_amount_cents: updated.total_amount_cents,
          variance_cents: updated.variance_cents,
          accounting_month_id: updated.accounting_month_id,
          entity_id: updated.entity_id,
        }
      : null,
  });
});

router.get("/accounting/source-months/:id/sync-runs", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccounting(wreq)) {
    res.status(403).json({ error: "Finance & Accounting access required" });
    return;
  }

  const sourceMonthId = parseInt(req.params.id, 10);
  if (isNaN(sourceMonthId)) {
    res.status(400).json({ error: "Invalid source month id" });
    return;
  }

  const ownerCheck = await db.query<{ id: number }>(
    `SELECT sm.id
     FROM accounting_source_months sm
     JOIN accounting_entity_months em ON em.id = sm.accounting_entity_month_id
     WHERE sm.id = $1 AND em.workspace_owner_id = $2`,
    [sourceMonthId, wreq.workspaceOwnerId],
  );
  if (ownerCheck.rowCount === 0) {
    res.status(404).json({ error: "Source month not found" });
    return;
  }

  const result = await db.query<SyncRunRow>(
    `SELECT * FROM source_sync_runs WHERE source_month_id = $1 ORDER BY started_at DESC`,
    [sourceMonthId],
  );

  res.json({ syncRuns: result.rows });
});

/**
 * DELETE /accounting/source-months/:id/import/:syncRunId
 * Rollback: delete all statement lines for a sync run (only if month is not closed).
 */
router.delete("/accounting/source-months/:id/import/:syncRunId", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccounting(wreq)) {
    res.status(403).json({ error: "Finance & Accounting access required" });
    return;
  }

  const sourceMonthId = parseInt(req.params.id, 10);
  const syncRunId = parseInt(req.params.syncRunId, 10);
  if (isNaN(sourceMonthId) || isNaN(syncRunId)) {
    res.status(400).json({ error: "Invalid ids" });
    return;
  }

  const ownerCheck = await db.query<{ month_status: string }>(
    `SELECT am.status AS month_status
     FROM accounting_source_months sm
     JOIN accounting_entity_months em ON em.id = sm.accounting_entity_month_id
     JOIN accounting_months am ON am.id = em.accounting_month_id
     WHERE sm.id = $1 AND em.workspace_owner_id = $2`,
    [sourceMonthId, wreq.workspaceOwnerId],
  );
  if (ownerCheck.rowCount === 0) {
    res.status(404).json({ error: "Source month not found" });
    return;
  }
  if (ownerCheck.rows[0].month_status === "closed") {
    res.status(409).json({ error: "Cannot roll back an import in a closed month" });
    return;
  }

  const runCheck = await db.query<{ id: number }>(
    `SELECT id FROM source_sync_runs WHERE id = $1 AND source_month_id = $2`,
    [syncRunId, sourceMonthId],
  );
  if (runCheck.rowCount === 0) {
    res.status(404).json({ error: "Sync run not found" });
    return;
  }

  const deleteResult = await db.query<{ id: number }>(
    `DELETE FROM source_statement_lines WHERE sync_run_id = $1 RETURNING id`,
    [syncRunId],
  );
  const deletedCount = deleteResult.rowCount ?? 0;

  await db.query(
    `DELETE FROM source_sync_runs WHERE id = $1`,
    [syncRunId],
  );

  const remaining = await db.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM source_statement_lines WHERE source_month_id = $1`,
    [sourceMonthId],
  );
  const remainingCount = parseInt(remaining.rows[0]?.count ?? "0", 10);

  const newStatus = remainingCount > 0 ? "synced" : "pending";
  await db.query(
    `UPDATE accounting_source_months
     SET sales_status = $2, rows_count = $3, updated_at = now()
     WHERE id = $1`,
    [sourceMonthId, newStatus, remainingCount],
  );

  res.json({ deleted: deletedCount, remaining: remainingCount });
});

/**
 * GET /accounting/source-months/:id/lines
 * Return statement lines for a source month (used by detail drawer).
 */
router.get("/accounting/source-months/:id/lines", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccounting(wreq)) {
    res.status(403).json({ error: "Finance & Accounting access required" });
    return;
  }

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid source month id" });
    return;
  }

  const sm = await resolveSourceMonth(id, wreq.workspaceOwnerId);
  if (!sm) {
    res.status(404).json({ error: "Source month not found" });
    return;
  }

  const linesResult = await db.query<{
    id: number;
    line_date: string | null;
    description: string | null;
    amount_cents: number;
    currency: string;
    reference: string | null;
    is_matched: boolean;
    metadata: Record<string, unknown>;
    created_at: string;
  }>(
    `SELECT id, line_date, description, amount_cents, currency, reference, is_matched, metadata, created_at
     FROM source_statement_lines
     WHERE source_month_id = $1
     ORDER BY line_date ASC, id ASC`,
    [id],
  );

  // Compute per-currency totals
  const byCurrency: Record<string, number> = {};
  for (const line of linesResult.rows) {
    byCurrency[line.currency] = (byCurrency[line.currency] ?? 0) + line.amount_cents;
  }

  res.json({
    source_month: {
      id: sm.id,
      source_name: sm.source_name,
      source_type: sm.source_type,
      status: sm.status,
      last_synced_at: sm.last_synced_at,
    },
    lines: linesResult.rows,
    summary: {
      total_lines: linesResult.rows.length,
      by_currency: Object.entries(byCurrency).map(([currency, total_cents]) => ({
        currency,
        total_cents,
      })),
    },
  });
});

// ── POST /accounting/source-months/:id/reconcile ─────────────────────────────

router.post("/accounting/source-months/:id/reconcile", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccounting(wreq)) {
    res.status(403).json({ error: "Finance & Accounting access required" });
    return;
  }

  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid source month id" });
    return;
  }

  const ownerCheck = await db.query<{ id: number }>(
    `SELECT asm.id
     FROM accounting_source_months asm
     JOIN accounting_entity_months aem ON aem.id = asm.accounting_entity_month_id
     WHERE asm.id = $1 AND aem.workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  if ((ownerCheck.rowCount ?? 0) === 0) {
    res.status(404).json({ error: "Source month not found" });
    return;
  }

  try {
    const result = await reconcileSourceMonth(id);
    res.json({ ok: true, reconciliation: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    req.log.error({ err, sourceMonthId: id }, "accounting/reconcile: failed");
    res.status(500).json({ error: "Reconciliation failed", message });
  }
});

// ── GET /accounting/months/:id/exceptions ─────────────────────────────────────

type AccountingExceptionRow = {
  id: number;
  accounting_month_id: number;
  entity_id: number | null;
  source_month_id: number | null;
  exception_type: string;
  description: string;
  amount_cents: number | null;
  currency: string | null;
  status: string;
  assigned_to: string | null;
  assigned_name: string | null;
  notes: string | null;
  resolution: string | null;
  accepted_difference_reason: string | null;
  external_ref: string | null;
  related_order_id: string | null;
  audit_trail: unknown[];
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
  source_name: string | null;
  entity_name: string | null;
};

router.get("/accounting/months/:id/exceptions", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccounting(wreq)) {
    res.status(403).json({ error: "Finance & Accounting access required" });
    return;
  }

  const monthId = parseInt(req.params.id, 10);
  if (isNaN(monthId)) {
    res.status(400).json({ error: "Invalid month id" });
    return;
  }

  const monthCheck = await db.query<{ id: number }>(
    `SELECT id FROM accounting_months WHERE id = $1 AND workspace_owner_id = $2`,
    [monthId, wreq.workspaceOwnerId],
  );
  if ((monthCheck.rowCount ?? 0) === 0) {
    res.status(404).json({ error: "Accounting month not found" });
    return;
  }

  const {
    type: typeFilter,
    status: statusFilter,
    source: sourceFilter,
    assignee: assigneeFilter,
    page: pageStr,
    pageSize: pageSizeStr,
  } = req.query as Record<string, string | undefined>;

  const page = Math.max(1, parseInt(pageStr ?? "1", 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(pageSizeStr ?? "50", 10) || 50));
  const offset = (page - 1) * pageSize;

  const conditions: string[] = ["ae.accounting_month_id = $1"];
  const params: unknown[] = [monthId];

  if (typeFilter) {
    const types = typeFilter.split(",").map((t) => t.trim()).filter(Boolean);
    if (types.length > 0) {
      params.push(types);
      conditions.push(`ae.exception_type = ANY($${params.length})`);
    }
  }
  if (statusFilter) {
    const statuses = statusFilter.split(",").map((s) => s.trim()).filter(Boolean);
    if (statuses.length > 0) {
      params.push(statuses);
      conditions.push(`ae.status = ANY($${params.length})`);
    }
  }
  if (sourceFilter) {
    params.push(parseInt(sourceFilter, 10));
    conditions.push(`ae.source_month_id = $${params.length}`);
  }
  if (assigneeFilter) {
    if (assigneeFilter === "unassigned") {
      conditions.push(`ae.assigned_to IS NULL`);
    } else {
      params.push(assigneeFilter);
      conditions.push(`ae.assigned_to = $${params.length}`);
    }
  }

  const whereClause = conditions.join(" AND ");

  const countResult = await db.query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt FROM accounting_exceptions ae WHERE ${whereClause}`,
    params,
  );
  const total = parseInt(countResult.rows[0]?.cnt ?? "0", 10);

  params.push(pageSize, offset);
  const dataResult = await db.query<AccountingExceptionRow>(
    `SELECT ae.*,
       asrc.name AS source_name,
       fe.display_name AS entity_name,
       wm.full_name AS assigned_name
     FROM accounting_exceptions ae
     LEFT JOIN accounting_source_months asm ON asm.id = ae.source_month_id
     LEFT JOIN accounting_sources asrc ON asrc.id = asm.source_id
     LEFT JOIN finance_entities fe ON fe.id = ae.entity_id
     LEFT JOIN workspace_members wm ON wm.clerk_user_id = ae.assigned_to
     WHERE ${whereClause}
     ORDER BY
       CASE ae.status WHEN 'open' THEN 1 WHEN 'assigned' THEN 2 WHEN 'investigating' THEN 3 ELSE 4 END,
       ae.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  res.json({
    exceptions: dataResult.rows.map((r) => ({
      id: r.id,
      accountingMonthId: r.accounting_month_id,
      entityId: r.entity_id,
      entityName: r.entity_name,
      sourceMonthId: r.source_month_id,
      sourceName: r.source_name,
      exceptionType: r.exception_type,
      description: r.description,
      amountCents: r.amount_cents,
      currency: r.currency,
      status: r.status,
      assignedTo: r.assigned_to,
      assignedName: r.assigned_name,
      notes: r.notes,
      resolution: r.resolution,
      acceptedDifferenceReason: r.accepted_difference_reason,
      externalRef: r.external_ref,
      relatedOrderId: r.related_order_id,
      auditTrail: r.audit_trail ?? [],
      resolvedBy: r.resolved_by,
      resolvedAt: r.resolved_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
    pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  });
});

// ── PATCH /accounting/exceptions/:id ─────────────────────────────────────────

const VALID_EXCEPTION_STATUSES = ["open", "assigned", "investigating", "resolved", "accepted_difference", "deferred"];

router.patch("/accounting/exceptions/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccounting(wreq)) {
    res.status(403).json({ error: "Finance & Accounting access required" });
    return;
  }

  const exceptionId = parseInt(req.params.id, 10);
  if (isNaN(exceptionId)) {
    res.status(400).json({ error: "Invalid exception id" });
    return;
  }

  const exCheck = await db.query<{ id: number; status: string; accounting_month_id: number; audit_trail: unknown[] }>(
    `SELECT ae.id, ae.status, ae.accounting_month_id, ae.audit_trail
     FROM accounting_exceptions ae
     JOIN accounting_months am ON am.id = ae.accounting_month_id
     WHERE ae.id = $1 AND am.workspace_owner_id = $2`,
    [exceptionId, wreq.workspaceOwnerId],
  );
  if ((exCheck.rowCount ?? 0) === 0) {
    res.status(404).json({ error: "Exception not found" });
    return;
  }
  const existing = exCheck.rows[0];

  const { status, assigned_to, notes, resolution, accepted_difference_reason } =
    req.body as Record<string, unknown>;

  if (status !== undefined && !VALID_EXCEPTION_STATUSES.includes(String(status))) {
    res.status(400).json({ error: `Invalid status. Must be one of: ${VALID_EXCEPTION_STATUSES.join(", ")}` });
    return;
  }

  if (status === "accepted_difference" && !accepted_difference_reason) {
    res.status(400).json({ error: "accepted_difference_reason is required when accepting a difference" });
    return;
  }

  const sets: string[] = [];
  const params: unknown[] = [];

  const newStatus = status !== undefined ? String(status) : null;

  if (newStatus !== null) {
    params.push(newStatus);
    sets.push(`status = $${params.length}`);
    if (["resolved", "accepted_difference"].includes(newStatus)) {
      params.push(authed(req).userId);
      sets.push(`resolved_by = $${params.length}`);
      params.push(new Date().toISOString());
      sets.push(`resolved_at = $${params.length}`);
    }
  }
  if (assigned_to !== undefined) {
    params.push(assigned_to === null ? null : String(assigned_to));
    sets.push(`assigned_to = $${params.length}`);
    if (newStatus === null && assigned_to !== null) {
      sets.push(`status = 'assigned'`);
    }
  }
  if (notes !== undefined) {
    params.push(notes === null ? null : String(notes));
    sets.push(`notes = $${params.length}`);
  }
  if (resolution !== undefined) {
    params.push(resolution === null ? null : String(resolution));
    sets.push(`resolution = $${params.length}`);
  }
  if (accepted_difference_reason !== undefined) {
    params.push(accepted_difference_reason === null ? null : String(accepted_difference_reason));
    sets.push(`accepted_difference_reason = $${params.length}`);
  }

  if (sets.length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }

  // Append audit trail entry
  const auditEntry = {
    changed_by: authed(req).userId,
    from_status: existing.status,
    to_status: newStatus ?? existing.status,
    assigned_to: assigned_to !== undefined ? assigned_to : undefined,
    note: notes !== undefined ? notes : undefined,
    at: new Date().toISOString(),
  };
  const currentTrail = Array.isArray(existing.audit_trail) ? existing.audit_trail : [];
  const newTrail = [...currentTrail, auditEntry];
  params.push(JSON.stringify(newTrail));
  sets.push(`audit_trail = $${params.length}`);
  sets.push(`updated_at = now()`);

  params.push(exceptionId);
  const result = await db.query<AccountingExceptionRow>(
    `UPDATE accounting_exceptions
     SET ${sets.join(", ")}
     WHERE id = $${params.length}
     RETURNING *`,
    params,
  );

  res.json({ exception: result.rows[0] });
});

// ── POST /accounting/exceptions/bulk-assign ───────────────────────────────────

router.post("/accounting/exceptions/bulk-assign", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccounting(wreq)) {
    res.status(403).json({ error: "Finance & Accounting access required" });
    return;
  }

  const { exception_ids, assigned_to } = req.body as {
    exception_ids?: unknown;
    assigned_to?: unknown;
  };

  if (!Array.isArray(exception_ids) || exception_ids.length === 0) {
    res.status(400).json({ error: "exception_ids must be a non-empty array" });
    return;
  }

  const ids = exception_ids.map((id) => parseInt(String(id), 10)).filter((n) => !isNaN(n));
  if (ids.length === 0) {
    res.status(400).json({ error: "No valid exception ids provided" });
    return;
  }

  if (assigned_to === undefined || assigned_to === null || String(assigned_to).trim() === "") {
    res.status(400).json({ error: "assigned_to is required" });
    return;
  }

  // Verify all exceptions belong to this workspace
  const ownerCheck = await db.query<{ id: number }>(
    `SELECT ae.id
     FROM accounting_exceptions ae
     JOIN accounting_months am ON am.id = ae.accounting_month_id
     WHERE ae.id = ANY($1) AND am.workspace_owner_id = $2`,
    [ids, wreq.workspaceOwnerId],
  );
  if ((ownerCheck.rowCount ?? 0) !== ids.length) {
    res.status(403).json({ error: "One or more exceptions not found or access denied" });
    return;
  }

  const assignedToStr = String(assigned_to);
  const callerUserId = authed(req).userId;

  await db.query(
    `UPDATE accounting_exceptions
     SET assigned_to = $1,
         status = CASE WHEN status = 'open' THEN 'assigned' ELSE status END,
         audit_trail = audit_trail || jsonb_build_object(
           'changed_by', $2::text,
           'action', 'bulk_assign',
           'assigned_to', $1::text,
           'at', now()::text
         )::jsonb,
         updated_at = now()
     WHERE id = ANY($3)`,
    [assignedToStr, callerUserId, ids],
  );

  res.json({ ok: true, updated: ids.length, assigned_to: assignedToStr });
});

// ── GET /accounting/sources/:id/config ───────────────────────────────────────

router.get("/accounting/sources/:id/config", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccounting(wreq)) {
    res.status(403).json({ error: "Finance & Accounting access required" });
    return;
  }
  const sourceId = parseInt(req.params.id, 10);
  if (isNaN(sourceId)) { res.status(400).json({ error: "Invalid source id" }); return; }

  const result = await db.query<{ id: number; name: string; source_type: string; config: unknown }>(
    `SELECT id, name, source_type, config FROM accounting_sources WHERE id = $1 AND workspace_owner_id = $2`,
    [sourceId, wreq.workspaceOwnerId],
  );
  if (!result.rowCount || result.rowCount === 0) {
    res.status(404).json({ error: "Source not found" });
    return;
  }
  const src = result.rows[0];
  const cfg = (src.config ?? {}) as Record<string, unknown>;

  res.json({
    sourceId: src.id,
    sourceName: src.name,
    sourceType: src.source_type,
    vatRate: (cfg.vat_rate as number | undefined) ?? 0,
    vatInclusive: (cfg.vat_inclusive as boolean | undefined) ?? true,
    accounts: {
      ...DEFAULT_ACCOUNT_CODES,
      ...((cfg.accounts ?? {}) as Record<string, unknown>),
    },
  });
});

// ── PATCH /accounting/sources/:id/config ─────────────────────────────────────

router.patch("/accounting/sources/:id/config", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceActualRole !== "owner") {
    res.status(403).json({ error: "Owner access required" });
    return;
  }
  const sourceId = parseInt(req.params.id, 10);
  if (isNaN(sourceId)) { res.status(400).json({ error: "Invalid source id" }); return; }

  const existing = await db.query<{ id: number; config: unknown }>(
    `SELECT id, config FROM accounting_sources WHERE id = $1 AND workspace_owner_id = $2`,
    [sourceId, wreq.workspaceOwnerId],
  );
  if (!existing.rowCount || existing.rowCount === 0) {
    res.status(404).json({ error: "Source not found" });
    return;
  }

  const body = req.body as Record<string, unknown>;
  const currentConfig = (existing.rows[0].config ?? {}) as Record<string, unknown>;

  const updatedConfig: Record<string, unknown> = { ...currentConfig };
  if (body.vat_rate !== undefined) updatedConfig.vat_rate = Number(body.vat_rate) || 0;
  if (body.vat_inclusive !== undefined) updatedConfig.vat_inclusive = Boolean(body.vat_inclusive);
  if (body.accounts && typeof body.accounts === "object") {
    updatedConfig.accounts = { ...(currentConfig.accounts as Record<string, unknown> ?? {}), ...(body.accounts as Record<string, unknown>) };
  }

  await db.query(
    `UPDATE accounting_sources SET config = $1, updated_at = now() WHERE id = $2`,
    [JSON.stringify(updatedConfig), sourceId],
  );

  res.json({ ok: true, sourceId, config: updatedConfig });
});

// ── POST /accounting/entity-months/:id/journal-entry/generate ────────────────

router.post("/accounting/entity-months/:id/journal-entry/generate", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccounting(wreq)) {
    res.status(403).json({ error: "Finance & Accounting access required" });
    return;
  }
  const entityMonthId = parseInt(req.params.id, 10);
  if (isNaN(entityMonthId)) { res.status(400).json({ error: "Invalid entity-month id" }); return; }

  try {
    const result = await generateJournalEntry(entityMonthId, wreq.workspaceOwnerId, authed(req).userId);
    res.json({
      ok: true,
      journalEntryId: result.journalEntryId,
      isBalanced: result.isBalanced,
      totalDebitCents: result.totalDebitCents,
      totalCreditCents: result.totalCreditCents,
      imbalanceCents: result.imbalanceCents,
      linesCount: result.lines.length,
      sourcesProcessed: result.sourcesProcessed,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Generation failed";
    if (msg === "Cannot regenerate an approved journal entry") {
      res.status(409).json({ error: msg });
    } else if (msg === "Entity month not found") {
      res.status(404).json({ error: msg });
    } else {
      req.log.error({ err }, "journal entry generation failed");
      res.status(500).json({ error: "Journal entry generation failed" });
    }
  }
});

// ── GET /accounting/entity-months/:id/journal-entry ──────────────────────────

router.get("/accounting/entity-months/:id/journal-entry", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccounting(wreq)) {
    res.status(403).json({ error: "Finance & Accounting access required" });
    return;
  }
  const entityMonthId = parseInt(req.params.id, 10);
  if (isNaN(entityMonthId)) { res.status(400).json({ error: "Invalid entity-month id" }); return; }

  const result = await getJournalEntry(entityMonthId, wreq.workspaceOwnerId);
  if (!result) {
    res.json({ journalEntry: null, lines: [] });
    return;
  }

  const { entry, lines } = result;
  const totalDebitCents = lines.reduce((s, l) => s + (l.debit_cents ?? 0), 0);
  const totalCreditCents = lines.reduce((s, l) => s + (l.credit_cents ?? 0), 0);

  res.json({
    journalEntry: {
      id: entry.id,
      status: entry.status,
      description: entry.description,
      isBalanced: entry.is_balanced,
      currency: entry.currency,
      reportingCurrency: entry.reporting_currency,
      createdBy: entry.created_by,
      approvedBy: entry.approved_by,
      approvedAt: entry.approved_at,
      createdAt: entry.created_at,
      updatedAt: entry.updated_at,
      totalDebitCents,
      totalCreditCents,
    },
    lines: lines.map((l) => ({
      id: l.id,
      accountCode: l.account_code,
      accountName: l.account_name,
      description: l.description,
      lineType: l.line_type,
      currency: l.currency,
      exchangeRate: parseFloat(l.exchange_rate as unknown as string),
      debitCents: l.debit_cents,
      creditCents: l.credit_cents,
      reportingDebitCents: l.reporting_debit_cents,
      reportingCreditCents: l.reporting_credit_cents,
      sourceId: l.source_id,
      sourceName: l.source_name,
    })),
  });
});

// ── PATCH /accounting/journal-entries/:id/approve ────────────────────────────

router.patch("/accounting/journal-entries/:id/approve", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceActualRole !== "owner") {
    res.status(403).json({ error: "Owner access required to approve journal entries" });
    return;
  }
  const entryId = parseInt(req.params.id, 10);
  if (isNaN(entryId)) { res.status(400).json({ error: "Invalid journal entry id" }); return; }

  const existing = await db.query<{ id: number; status: string; workspace_owner_id: string; is_balanced: boolean }>(
    `SELECT id, status, workspace_owner_id, is_balanced FROM journal_entry_drafts WHERE id = $1`,
    [entryId],
  );
  if (!existing.rowCount || existing.rowCount === 0 || existing.rows[0].workspace_owner_id !== wreq.workspaceOwnerId) {
    res.status(404).json({ error: "Journal entry not found" });
    return;
  }
  const entry = existing.rows[0];
  if (entry.status === "approved") {
    res.status(409).json({ error: "Journal entry is already approved" });
    return;
  }
  if (!entry.is_balanced) {
    res.status(422).json({ error: "Cannot approve an unbalanced journal entry" });
    return;
  }

  const callerUserId = authed(req).userId;
  await db.query(
    `UPDATE journal_entry_drafts SET status = 'approved', approved_by = $1, approved_at = now(), updated_at = now() WHERE id = $2`,
    [callerUserId, entryId],
  );
  res.json({ ok: true, entryId, status: "approved" });
});

// ── GET /accounting/journal-entries/:id/export ───────────────────────────────

router.get("/accounting/journal-entries/:id/export", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccounting(wreq)) {
    res.status(403).json({ error: "Finance & Accounting access required" });
    return;
  }
  const entryId = parseInt(req.params.id, 10);
  if (isNaN(entryId)) { res.status(400).json({ error: "Invalid journal entry id" }); return; }

  const format = String(req.query.format ?? "xlsx").toLowerCase();

  const entryRes = await db.query<{
    id: number; description: string; status: string; currency: string;
    reporting_currency: string; created_by: string; approved_by: string | null;
    approved_at: string | null; created_at: string; workspace_owner_id: string;
    is_balanced: boolean; accounting_entity_month_id: number | null;
  }>(
    `SELECT id, description, status, currency, reporting_currency, created_by,
            approved_by, approved_at, created_at, workspace_owner_id, is_balanced,
            accounting_entity_month_id
     FROM journal_entry_drafts
     WHERE id = $1 AND workspace_owner_id = $2`,
    [entryId, wreq.workspaceOwnerId],
  );
  if (!entryRes.rowCount || entryRes.rowCount === 0) {
    res.status(404).json({ error: "Journal entry not found" });
    return;
  }
  const entry = entryRes.rows[0];

  const linesRes = await db.query<{
    account_code: string; account_name: string; description: string | null;
    line_type: string | null; currency: string; exchange_rate: string;
    debit_cents: number; credit_cents: number;
    reporting_debit_cents: number; reporting_credit_cents: number;
    source_name: string | null;
  }>(
    `SELECT account_code, account_name, description, line_type, currency, exchange_rate,
            debit_cents, credit_cents, reporting_debit_cents, reporting_credit_cents, source_name
     FROM journal_entry_lines WHERE journal_entry_id = $1 ORDER BY id`,
    [entryId],
  );
  const lines = linesRes.rows;

  const totalDebitCents = lines.reduce((s, l) => s + l.debit_cents, 0);
  const totalCreditCents = lines.reduce((s, l) => s + l.credit_cents, 0);

  const mainRows = lines.map((l) => ({
    "Account Code": l.account_code,
    "Account Name": l.account_name,
    "Description": l.description ?? "",
    "Type": l.line_type ?? "",
    "Source": l.source_name ?? "",
    "Currency": l.currency,
    "Exchange Rate": parseFloat(l.exchange_rate as unknown as string),
    "Debit": (l.debit_cents / 100).toFixed(2),
    "Credit": (l.credit_cents / 100).toFixed(2),
    "Reporting Debit": (l.reporting_debit_cents / 100).toFixed(2),
    "Reporting Credit": (l.reporting_credit_cents / 100).toFixed(2),
  }));

  const filename = `journal-entry-${entryId}`;

  if (format === "csv") {
    if (mainRows.length === 0) {
      res.status(400).json({ error: "No lines to export" });
      return;
    }
    const headers = Object.keys(mainRows[0]);
    const csvLines = [
      headers.join(","),
      ...mainRows.map((r) => headers.map((h) => `"${String((r as Record<string, unknown>)[h]).replace(/"/g, '""')}"`).join(",")),
    ];
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}.csv"`);
    res.send(csvLines.join("\n"));
    return;
  }

  // Excel
  const summaryData = [
    { Item: "Entry ID", Value: entry.id },
    { Item: "Description", Value: entry.description },
    { Item: "Status", Value: entry.status },
    { Item: "Currency", Value: entry.currency },
    { Item: "Is Balanced", Value: entry.is_balanced ? "Yes" : "No" },
    { Item: "Total Debits", Value: (totalDebitCents / 100).toFixed(2) },
    { Item: "Total Credits", Value: (totalCreditCents / 100).toFixed(2) },
    { Item: "Created By", Value: entry.created_by },
    { Item: "Approved By", Value: entry.approved_by ?? "" },
    { Item: "Approved At", Value: entry.approved_at ?? "" },
    { Item: "Created At", Value: entry.created_at },
  ];
  const buf = await writeXlsx([
    { name: "Journal Entry", data: mainRows },
    { name: "Summary", data: summaryData },
  ]);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}.xlsx"`);
  res.send(buf);
});

// ── POST /accounting/entity-months/:id/vat-summary/generate ──────────────────

router.post("/accounting/entity-months/:id/vat-summary/generate", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccounting(wreq)) {
    res.status(403).json({ error: "Finance & Accounting access required" });
    return;
  }
  const entityMonthId = parseInt(req.params.id, 10);
  if (isNaN(entityMonthId)) { res.status(400).json({ error: "Invalid entity-month id" }); return; }

  try {
    const result = await generateVatSummary(entityMonthId, wreq.workspaceOwnerId);
    res.json({
      ok: true,
      rowsGenerated: result.rows.length,
      totalVatCents: result.totalVatCents,
      totalGrossInclCents: result.totalGrossInclCents,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "VAT summary generation failed";
    if (msg === "Entity month not found") {
      res.status(404).json({ error: msg });
    } else {
      req.log.error({ err }, "VAT summary generation failed");
      res.status(500).json({ error: "VAT summary generation failed" });
    }
  }
});

// ── GET /accounting/entity-months/:id/vat-summary ────────────────────────────

router.get("/accounting/entity-months/:id/vat-summary", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccounting(wreq)) {
    res.status(403).json({ error: "Finance & Accounting access required" });
    return;
  }
  const entityMonthId = parseInt(req.params.id, 10);
  if (isNaN(entityMonthId)) { res.status(400).json({ error: "Invalid entity-month id" }); return; }

  const rows = await getVatSummary(entityMonthId, wreq.workspaceOwnerId);

  const totalVatCents = rows.reduce((s, r) => s + r.vat_amount_cents - r.refund_vat_cents, 0);
  const totalGrossInclCents = rows.reduce((s, r) => s + r.gross_incl_vat_cents, 0);

  res.json({
    vatSummary: rows.map((r) => ({
      id: r.id,
      sourceId: r.source_id,
      sourceName: r.source_name,
      currency: r.currency,
      vatRate: r.vat_rate,
      grossInclVatCents: r.gross_incl_vat_cents,
      grossExclVatCents: r.gross_excl_vat_cents,
      vatAmountCents: r.vat_amount_cents,
      refundVatCents: r.refund_vat_cents,
      feesCents: r.fees_cents,
      vatOnFeesCents: r.vat_on_fees_cents,
      reportingCurrency: r.reporting_currency,
      reportingGrossInclVatCents: r.reporting_gross_incl_vat_cents,
      reportingGrossExclVatCents: r.reporting_gross_excl_vat_cents,
      reportingVatAmountCents: r.reporting_vat_amount_cents,
      reportingRefundVatCents: r.reporting_refund_vat_cents,
    })),
    totals: {
      totalVatCents,
      totalGrossInclCents,
      totalRefundVatCents: rows.reduce((s, r) => s + r.refund_vat_cents, 0),
      totalNetVatCents: totalVatCents,
    },
  });
});

// ── PATCH /accounting/entity-months/:id/checklist/:itemId ────────────────────

router.patch("/accounting/entity-months/:id/checklist/:itemId", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccounting(wreq)) {
    res.status(403).json({ error: "Finance & Accounting access required" });
    return;
  }

  const entityMonthId = parseInt(req.params.id, 10);
  const itemId = parseInt(req.params.itemId, 10);
  if (isNaN(entityMonthId) || isNaN(itemId)) {
    res.status(400).json({ error: "Invalid ids" });
    return;
  }

  const emRes = await db.query<{ id: number; accounting_month_id: number }>(
    `SELECT id, accounting_month_id FROM accounting_entity_months WHERE id = $1 AND workspace_owner_id = $2`,
    [entityMonthId, wreq.workspaceOwnerId],
  );
  if (!emRes.rowCount) {
    res.status(404).json({ error: "Entity month not found" });
    return;
  }
  const em = emRes.rows[0];

  const itemRes = await db.query<{ id: number; is_checked: boolean }>(
    `SELECT id, is_checked FROM close_checklist_items WHERE id = $1 AND accounting_month_id = $2`,
    [itemId, em.accounting_month_id],
  );
  if (!itemRes.rowCount) {
    res.status(404).json({ error: "Checklist item not found" });
    return;
  }

  const { is_checked } = req.body as { is_checked?: boolean };
  const newChecked = typeof is_checked === "boolean" ? is_checked : !itemRes.rows[0].is_checked;
  const callerUserId = authed(req).userId;

  await db.query(
    `UPDATE close_checklist_items
     SET is_checked = $1,
         checked_by = CASE WHEN $1 THEN $2::text ELSE NULL END,
         checked_at = CASE WHEN $1 THEN now() ELSE NULL END,
         updated_at = now()
     WHERE id = $3`,
    [newChecked, callerUserId, itemId],
  );

  // Audit event (best-effort, non-fatal)
  try {
    await db.query(
      `INSERT INTO close_audit_events (accounting_month_id, event_type, actor_user_id, description, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        em.accounting_month_id,
        newChecked ? "checklist_checked" : "checklist_unchecked",
        callerUserId,
        `Checklist item ${newChecked ? "checked" : "unchecked"}: item ${itemId}`,
        JSON.stringify({ itemId, entityMonthId }),
      ],
    );
  } catch {
    // Non-fatal
  }

  res.json({ ok: true, itemId, isChecked: newChecked });
});

// ── Checklist auto-completion helper ─────────────────────────────────────────

async function computeAutoCompletedItems(
  entityMonthId: number,
  accountingMonthId: number,
  entityId: number,
): Promise<Set<number>> {
  const completed = new Set<number>();

  // sort_order 0: all sources synced (no source with status = 'pending')
  const sourcesRes = await db.query<{ total: string; pending: string }>(
    `SELECT COUNT(*) AS total,
            COUNT(*) FILTER (WHERE status = 'pending') AS pending
     FROM accounting_source_months WHERE accounting_entity_month_id = $1`,
    [entityMonthId],
  );
  const srcRow = sourcesRes.rows[0];
  if (srcRow && parseInt(srcRow.total, 10) > 0 && parseInt(srcRow.pending, 10) === 0) {
    completed.add(0);
  }

  // sort_order 4: no open exceptions for this entity-month
  const exceptRes = await db.query<{ open_count: string }>(
    `SELECT COUNT(*) AS open_count FROM accounting_exceptions
     WHERE accounting_month_id = $1 AND entity_id = $2 AND status = 'open'`,
    [accountingMonthId, entityId],
  );
  if (parseInt(exceptRes.rows[0]?.open_count ?? "0", 10) === 0) {
    completed.add(4);
  }

  // sort_order 10: journal entry exists (drafted)
  const jeDraftRes = await db.query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt FROM journal_entry_drafts WHERE accounting_entity_month_id = $1`,
    [entityMonthId],
  );
  if (parseInt(jeDraftRes.rows[0]?.cnt ?? "0", 10) > 0) {
    completed.add(10);
  }

  // sort_order 11: journal entry approved
  const jeApprRes = await db.query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt FROM journal_entry_drafts
     WHERE accounting_entity_month_id = $1 AND status = 'approved'`,
    [entityMonthId],
  );
  if (parseInt(jeApprRes.rows[0]?.cnt ?? "0", 10) > 0) {
    completed.add(11);
  }

  // sort_order 12: at least one supporting document uploaded
  const docsRes = await db.query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt FROM accounting_documents WHERE entity_month_id = $1`,
    [entityMonthId],
  );
  if (parseInt(docsRes.rows[0]?.cnt ?? "0", 10) > 0) {
    completed.add(12);
  }

  return completed;
}

// ── POST /accounting/entity-months/:id/close ─────────────────────────────────

// Mandatory checklist sort_orders that must be completed before close
const MANDATORY_CHECKLIST_ORDERS = new Set([0, 4, 11, 12, 13]);

router.post("/accounting/entity-months/:id/close", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccounting(wreq)) {
    res.status(403).json({ error: "Finance & Accounting access required" });
    return;
  }

  const entityMonthId = parseInt(req.params.id, 10);
  if (isNaN(entityMonthId)) {
    res.status(400).json({ error: "Invalid entity-month id" });
    return;
  }

  const emRes = await db.query<{
    id: number; accounting_month_id: number; entity_id: number; status: string;
  }>(
    `SELECT id, accounting_month_id, entity_id, status
     FROM accounting_entity_months WHERE id = $1 AND workspace_owner_id = $2`,
    [entityMonthId, wreq.workspaceOwnerId],
  );
  if (!emRes.rowCount) {
    res.status(404).json({ error: "Entity month not found" });
    return;
  }
  const em = emRes.rows[0];

  if (em.status === "closed") {
    res.status(409).json({ error: "Entity month is already closed" });
    return;
  }

  // Load checklist items and compute auto-completed set
  const itemsRes = await db.query<{ id: number; label: string; is_checked: boolean; sort_order: number }>(
    `SELECT id, label, is_checked, sort_order FROM close_checklist_items
     WHERE accounting_month_id = $1 AND (entity_id = $2 OR entity_id IS NULL)
     ORDER BY sort_order`,
    [em.accounting_month_id, em.entity_id],
  );

  const autoCompleted = await computeAutoCompletedItems(entityMonthId, em.accounting_month_id, em.entity_id);

  const blockers: string[] = [];
  for (const item of itemsRes.rows) {
    const done = item.is_checked || autoCompleted.has(item.sort_order);
    if (MANDATORY_CHECKLIST_ORDERS.has(item.sort_order) && !done) {
      blockers.push(item.label);
    }
  }

  // ── Lebanon-specific bank reconciliation gate ─────────────────────────────
  // Only applies when the entity belongs to the Presentail Lebanon legal entity
  // (finance_entity.country = 'LB'). Cyprus and UAE entity-months are unaffected.
  const entityCountryRes = await db.query<{ country: string | null }>(
    `SELECT country FROM finance_entities WHERE id = $1 AND is_active = true LIMIT 1`,
    [em.entity_id],
  );
  const isLebanonEntity = entityCountryRes.rows[0]?.country === "LB";

  // Track whether the caller provided a valid finance-manager override
  let lbOverrideApplied = false;

  if (isLebanonEntity) {
    const { overrideReason } = req.body as { overrideReason?: unknown };
    const isManager = hasFinanceManager(wreq);
    const hasValidOverride =
      isManager &&
      overrideReason &&
      typeof overrideReason === "string" &&
      overrideReason.trim().length >= 10;

    if (hasValidOverride) {
      // Finance-manager override: Lebanon bank-recon check is waived for this close.
      // The override reason is written to lb_bank_audit_log after the close succeeds.
      lbOverrideApplied = true;
    } else {
      // Standard path: ensure all required accounts are reconciled for this period.
      const amPeriod = await db.query<{ year: number; month: number }>(
        `SELECT am.year, am.month
           FROM accounting_months am
           JOIN accounting_entity_months aem ON aem.accounting_month_id = am.id
          WHERE aem.id = $1`,
        [entityMonthId],
      );
      const period = amPeriod.rows[0];
      if (period) {
        const unreconciledRes = await db.query<{ cnt: string }>(
          `SELECT COUNT(*) AS cnt
             FROM lb_bank_accounts a
            WHERE a.workspace_owner_id = $1
              AND a.is_required_for_close = true
              AND a.is_active = true
              AND NOT EXISTS (
                SELECT 1 FROM lb_bank_statements s
                 WHERE s.account_id = a.id
                   AND s.workspace_owner_id = $1
                   AND s.period_start ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}$'
                   AND s.period_end   ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}$'
                   AND CASE WHEN s.period_start ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}$'
                            THEN substring(s.period_start from 7 for 4)::int END = $2
                   AND CASE WHEN s.period_start ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}$'
                            THEN substring(s.period_start from 4 for 2)::int END = $3
                   AND CASE WHEN s.period_end ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}$'
                            THEN substring(s.period_end from 7 for 4)::int END = $2
                   AND CASE WHEN s.period_end ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}$'
                            THEN substring(s.period_end from 4 for 2)::int END = $3
                   AND s.reconciliation_status = 'reconciled'
              )`,
          [wreq.workspaceOwnerId, period.year, period.month],
        );
        const unreconciled = parseInt(unreconciledRes.rows[0]?.cnt ?? "0", 10);
        if (unreconciled > 0) {
          blockers.push("Lebanon bank reconciliation incomplete");
        } else {
          const requiredStatements = await db.query<{
            account_id: number;
            statement_count: string;
            posted_count: string;
            odoo_id_count: string;
          }>(
            `SELECT a.id AS account_id,
                    COUNT(DISTINCT s.id) AS statement_count,
                    COUNT(l.id) FILTER (WHERE l.line_type = 'posted') AS posted_count,
                    COUNT(DISTINCT os.odoo_record_id) FILTER (
                      WHERE l.line_type = 'posted'
                        AND os.status = 'success'
                        AND os.odoo_record_id IS NOT NULL
                    ) AS odoo_id_count
               FROM lb_bank_accounts a
               LEFT JOIN lb_bank_statements s
                 ON s.account_id = a.id
                AND s.workspace_owner_id = $1
                AND s.period_start ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}$'
                AND s.period_end   ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}$'
                AND CASE WHEN s.period_start ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}$'
                         THEN substring(s.period_start from 7 for 4)::int END = $2
                AND CASE WHEN s.period_start ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}$'
                         THEN substring(s.period_start from 4 for 2)::int END = $3
                AND CASE WHEN s.period_end ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}$'
                         THEN substring(s.period_end from 7 for 4)::int END = $2
                AND CASE WHEN s.period_end ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}$'
                         THEN substring(s.period_end from 4 for 2)::int END = $3
                AND s.reconciliation_status = 'reconciled'
               LEFT JOIN lb_bank_statement_lines l ON l.statement_id = s.id
               LEFT JOIN lb_bank_statement_odoo_syncs os ON os.line_id = l.id
              WHERE a.workspace_owner_id = $1
                AND a.is_required_for_close = true
                AND a.is_active = true
              GROUP BY a.id`,
            [wreq.workspaceOwnerId, period.year, period.month],
          );
          const invalidRequiredStatement = requiredStatements.rows.find((row) =>
            Number(row.statement_count) !== 1 ||
            Number(row.posted_count) <= 0 ||
            Number(row.odoo_id_count) !== Number(row.posted_count),
          );
          if (invalidRequiredStatement) {
            blockers.push("Each required Lebanon bank account must have exactly one reconciled statement for the closing month with one unique Odoo ID per posted line");
          }
          // A local reconciled flag is not sufficient for close: refresh the
          // authoritative Odoo state for every required statement first.
          const odooEntity = await db.query<Record<string, unknown>>(
            `SELECT * FROM finance_entities WHERE id = $1 AND is_active = true LIMIT 1`,
            [em.entity_id],
          );
          const syncedLines = await db.query<{ odoo_record_id: string | null }>(
            `SELECT DISTINCT os.odoo_record_id
               FROM lb_bank_statement_odoo_syncs os
               JOIN lb_bank_statement_lines l ON l.id = os.line_id
               JOIN lb_bank_statements s ON s.id = l.statement_id
               JOIN lb_bank_accounts a ON a.id = s.account_id
              WHERE s.workspace_owner_id = $1
                AND a.is_required_for_close = true
                AND a.is_active = true
                AND s.period_start ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}$'
                AND s.period_end   ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}$'
                AND CASE WHEN s.period_start ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}$'
                         THEN substring(s.period_start from 7 for 4)::int END = $2
                AND CASE WHEN s.period_start ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}$'
                         THEN substring(s.period_start from 4 for 2)::int END = $3
                AND CASE WHEN s.period_end ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}$'
                         THEN substring(s.period_end from 7 for 4)::int END = $2
                AND CASE WHEN s.period_end ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}$'
                         THEN substring(s.period_end from 4 for 2)::int END = $3
                AND s.reconciliation_status = 'reconciled'
                AND l.line_type = 'posted'
                AND os.status = 'success'
                AND os.odoo_record_id IS NOT NULL`,
            [wreq.workspaceOwnerId, period.year, period.month],
          );
          const odooIds = syncedLines.rows
            .map((row) => Number(row.odoo_record_id))
            .filter((id) => Number.isInteger(id) && id > 0);
          const connector = odooEntity.rows[0]
            ? createConnector(odooEntity.rows[0] as Parameters<typeof createConnector>[0])
            : null;
          if (odooIds.length === 0) {
            blockers.push("Lebanon bank reconciliation has no confirmed Odoo statement-line IDs");
          } else if (!connector?.refreshOdooReconciliationState) {
            blockers.push("Lebanon bank reconciliation could not be refreshed from Odoo");
          } else {
            try {
              const states = await connector.refreshOdooReconciliationState(odooIds);
              const stateById = new Map(states.map((state) => [state.statementLineId, state]));
              if (odooIds.some((id) => !stateById.get(id)?.isReconciled) || states.length !== odooIds.length) {
                blockers.push("Lebanon bank reconciliation is incomplete in Odoo");
              }
            } catch (error) {
              blockers.push(
                `Lebanon bank reconciliation refresh failed: ${error instanceof Error ? error.message : "unknown error"}`,
              );
            }
          }
        }
      }
    }
  }

  if (blockers.length > 0) {
    res.status(409).json({ error: "Close blocked by incomplete checklist items", blockers });
    return;
  }

  // Build closing snapshot
  const sourcesSnap = await db.query<{
    source_name: string; status: string; net_activity_cents: number | null; sales_amount_cents: number | null;
  }>(
    `SELECT asrc.name AS source_name, asm.status, asm.net_activity_cents, asm.sales_amount_cents
     FROM accounting_source_months asm
     JOIN accounting_sources asrc ON asrc.id = asm.source_id
     WHERE asm.accounting_entity_month_id = $1`,
    [entityMonthId],
  );

  const exceptSnap = await db.query<{ status: string; cnt: string }>(
    `SELECT status, COUNT(*) AS cnt FROM accounting_exceptions
     WHERE accounting_month_id = $1 AND entity_id = $2
     GROUP BY status`,
    [em.accounting_month_id, em.entity_id],
  );

  const jeSnap = await db.query<{ id: number; status: string; is_balanced: boolean }>(
    `SELECT id, status, is_balanced FROM journal_entry_drafts WHERE accounting_entity_month_id = $1`,
    [entityMonthId],
  );

  const callerUserId = authed(req).userId;
  const snapshot = {
    closedAt: new Date().toISOString(),
    closedBy: callerUserId,
    sources: sourcesSnap.rows,
    exceptionsByStatus: exceptSnap.rows.map((r) => ({ status: r.status, count: parseInt(r.cnt, 10) })),
    journalEntries: jeSnap.rows,
  };

  await db.query(
    `UPDATE accounting_entity_months
     SET status = 'closed', closed_at = now(), closed_by = $1, snapshot = $2, updated_at = now()
     WHERE id = $3`,
    [callerUserId, JSON.stringify(snapshot), entityMonthId],
  );

  await db.query(
    `INSERT INTO close_audit_events (accounting_month_id, event_type, actor_user_id, description, metadata)
     VALUES ($1, 'closed', $2, 'Entity month closed', $3)`,
    [em.accounting_month_id, callerUserId, JSON.stringify({ entityMonthId, snapshot })],
  );

  // If a Lebanon finance-manager override was applied, write it to lb_bank_audit_log.
  if (lbOverrideApplied) {
    const { overrideReason } = req.body as { overrideReason?: string };
    await db.query(
      `INSERT INTO lb_bank_audit_log
         (workspace_owner_id, actor_id, account_id, action, before, after, metadata)
       VALUES ($1, $2, NULL, 'close_override', NULL, NULL, $3)`,
      [
        wreq.workspaceOwnerId,
        callerUserId,
        JSON.stringify({
          reason: overrideReason?.trim(),
          entityMonthId,
          description: "Lebanon bank reconciliation check bypassed by finance manager override",
        }),
      ],
    );
  }

  res.json({ ok: true, entityMonthId, status: "closed", snapshot });
});

// ── POST /accounting/entity-months/:id/reopen ────────────────────────────────

router.post("/accounting/entity-months/:id/reopen", async (req, res) => {
  const wreq = workspace(req);
  const canReopen = wreq.workspaceActualRole === "owner" || (wreq.allowedPages?.includes("reopen_month") ?? false);
  if (!canReopen) {
    res.status(403).json({ error: "Owner access or reopen_month permission required" });
    return;
  }

  const entityMonthId = parseInt(req.params.id, 10);
  if (isNaN(entityMonthId)) {
    res.status(400).json({ error: "Invalid entity-month id" });
    return;
  }

  const { reason } = req.body as { reason?: unknown };
  if (!reason || typeof reason !== "string" || reason.trim().length < 10) {
    res.status(400).json({ error: "A reason of at least 10 characters is required to reopen a month" });
    return;
  }

  const emRes = await db.query<{ id: number; accounting_month_id: number; status: string }>(
    `SELECT id, accounting_month_id, status FROM accounting_entity_months
     WHERE id = $1 AND workspace_owner_id = $2`,
    [entityMonthId, wreq.workspaceOwnerId],
  );
  if (!emRes.rowCount) {
    res.status(404).json({ error: "Entity month not found" });
    return;
  }
  const em = emRes.rows[0];

  if (em.status !== "closed") {
    res.status(409).json({ error: "Entity month is not closed" });
    return;
  }

  const callerUserId = authed(req).userId;

  await db.query(
    `UPDATE accounting_entity_months
     SET status = 'review_required', reopened_at = now(), reopened_by = $1, updated_at = now()
     WHERE id = $2`,
    [callerUserId, entityMonthId],
  );

  await db.query(
    `INSERT INTO close_audit_events (accounting_month_id, event_type, actor_user_id, description, metadata)
     VALUES ($1, 'reopened', $2, 'Entity month reopened', $3)`,
    [em.accounting_month_id, callerUserId, JSON.stringify({ entityMonthId, reason: reason.trim() })],
  );

  res.json({ ok: true, entityMonthId, status: "review_required" });
});

// ── GET /accounting/entity-months/:id/audit ──────────────────────────────────

router.get("/accounting/entity-months/:id/audit", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccounting(wreq)) {
    res.status(403).json({ error: "Finance & Accounting access required" });
    return;
  }

  const entityMonthId = parseInt(req.params.id, 10);
  if (isNaN(entityMonthId)) {
    res.status(400).json({ error: "Invalid entity-month id" });
    return;
  }

  const emRes = await db.query<{ id: number; accounting_month_id: number }>(
    `SELECT id, accounting_month_id FROM accounting_entity_months WHERE id = $1 AND workspace_owner_id = $2`,
    [entityMonthId, wreq.workspaceOwnerId],
  );
  if (!emRes.rowCount) {
    res.status(404).json({ error: "Entity month not found" });
    return;
  }
  const em = emRes.rows[0];

  const eventsRes = await db.query<{
    id: number; event_type: string; actor_user_id: string | null;
    description: string; metadata: unknown; created_at: string; actor_name: string | null;
  }>(
    `SELECT cae.id, cae.event_type, cae.actor_user_id, cae.description, cae.metadata, cae.created_at,
            wm.full_name AS actor_name
     FROM close_audit_events cae
     LEFT JOIN workspace_members wm ON wm.clerk_user_id = cae.actor_user_id
     WHERE cae.accounting_month_id = $1
     ORDER BY cae.created_at DESC`,
    [em.accounting_month_id],
  );

  res.json({
    events: eventsRes.rows.map((r) => ({
      id: r.id,
      eventType: r.event_type,
      actorUserId: r.actor_user_id,
      actorName: r.actor_name,
      description: r.description,
      metadata: r.metadata,
      createdAt: r.created_at,
    })),
  });
});

// ── GET /accounting/entity-months/:id/documents ──────────────────────────────

router.get("/accounting/entity-months/:id/documents", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccounting(wreq)) {
    res.status(403).json({ error: "Finance & Accounting access required" });
    return;
  }

  const entityMonthId = parseInt(req.params.id, 10);
  if (isNaN(entityMonthId)) {
    res.status(400).json({ error: "Invalid entity-month id" });
    return;
  }

  const emRes = await db.query<{ id: number; accounting_month_id: number }>(
    `SELECT id, accounting_month_id FROM accounting_entity_months WHERE id = $1 AND workspace_owner_id = $2`,
    [entityMonthId, wreq.workspaceOwnerId],
  );
  if (!emRes.rowCount) {
    res.status(404).json({ error: "Entity month not found" });
    return;
  }
  const em = emRes.rows[0];

  const docsRes = await db.query<{
    id: number; name: string; storage_path: string; mime_type: string | null;
    document_type: string | null; entity_month_id: number | null;
    uploaded_by: string | null; created_at: string; uploader_name: string | null;
  }>(
    `SELECT d.id, d.name, d.storage_path, d.mime_type, d.document_type, d.entity_month_id,
            d.uploaded_by, d.created_at, wm.full_name AS uploader_name
     FROM accounting_documents d
     LEFT JOIN workspace_members wm ON wm.clerk_user_id = d.uploaded_by
     WHERE d.accounting_month_id = $1
       AND (d.entity_month_id = $2 OR d.entity_month_id IS NULL)
     ORDER BY d.created_at DESC`,
    [em.accounting_month_id, entityMonthId],
  );

  const objectBucket = process.env.GCS_BUCKET_NAME ?? "";

  res.json({
    documents: docsRes.rows.map((d) => {
      const objectKey = d.storage_path.replace(/^\/objects\//, "");
      return {
        id: d.id,
        name: d.name,
        storagePath: d.storage_path,
        mimeType: d.mime_type,
        documentType: d.document_type ?? "other",
        entityMonthId: d.entity_month_id,
        uploadedBy: d.uploaded_by,
        uploaderName: d.uploader_name,
        createdAt: d.created_at,
        viewUrl: `/api/storage/objects/${encodeURIComponent(objectKey)}`,
      };
    }),
  });
});

// ── POST /accounting/entity-months/:id/documents ─────────────────────────────

router.post(
  "/accounting/entity-months/:id/documents",
  upload.single("file"),
  async (req, res) => {
    const wreq = workspace(req);
    if (!hasFinanceAccounting(wreq)) {
      res.status(403).json({ error: "Finance & Accounting access required" });
      return;
    }

    const entityMonthId = parseInt(String(req.params.id), 10);
    if (isNaN(entityMonthId)) {
      res.status(400).json({ error: "Invalid entity-month id" });
      return;
    }

    const emRes = await db.query<{ id: number; accounting_month_id: number }>(
      `SELECT id, accounting_month_id FROM accounting_entity_months WHERE id = $1 AND workspace_owner_id = $2`,
      [entityMonthId, wreq.workspaceOwnerId],
    );
    if (!emRes.rowCount) {
      res.status(404).json({ error: "Entity month not found" });
      return;
    }
    const em = emRes.rows[0];

    if (!req.file) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }

    const documentType = typeof req.body.document_type === "string" && req.body.document_type
      ? req.body.document_type
      : "other";
    const callerUserId = authed(req).userId;
    const fileName = req.file.originalname;
    const mimeType = req.file.mimetype;
    const objectKey = `accounting/${wreq.workspaceOwnerId}/${em.accounting_month_id}/${entityMonthId}/${Date.now()}-${fileName}`;

    let storagePath: string;
    try {
      const privateDir = objectStorageService.getPrivateObjectDir();
      const fullPath = `${privateDir}/${objectKey}`;
      const pathParts = fullPath.replace(/^\//, "").split("/");
      const bucketName = pathParts[0];
      const objectName = pathParts.slice(1).join("/");
      const bucket = objectStorageClient.bucket(bucketName);
      const gcsFile = bucket.file(objectName);
      await gcsFile.save(req.file.buffer, { contentType: mimeType ?? "application/octet-stream" });
      storagePath = `/objects/${objectKey}`;
    } catch (err) {
      req.log.error({ err }, "Failed to upload accounting document");
      res.status(500).json({ error: "Failed to upload document" });
      return;
    }

    const insertRes = await db.query<{ id: number; created_at: string }>(
      `INSERT INTO accounting_documents
         (accounting_month_id, entity_month_id, name, storage_path, mime_type, document_type, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, created_at`,
      [em.accounting_month_id, entityMonthId, fileName, storagePath, mimeType, documentType, callerUserId],
    );

    const doc = insertRes.rows[0];

    // Audit event (best-effort, non-fatal)
    try {
      await db.query(
        `INSERT INTO close_audit_events (accounting_month_id, event_type, actor_user_id, description, metadata)
         VALUES ($1, 'document_uploaded', $2, $3, $4)`,
        [
          em.accounting_month_id,
          callerUserId,
          `Document uploaded: ${fileName}`,
          JSON.stringify({ documentId: doc.id, documentType, entityMonthId }),
        ],
      );
    } catch {
      // Non-fatal
    }

    res.json({
      ok: true,
      document: {
        id: doc.id,
        name: fileName,
        storagePath,
        mimeType,
        documentType,
        entityMonthId,
        uploadedBy: callerUserId,
        createdAt: doc.created_at,
        viewUrl: `/api/storage/objects/${encodeURIComponent(objectKey)}`,
      },
    });
  },
);

// ── DELETE /accounting/documents/:id ─────────────────────────────────────────

router.delete("/accounting/documents/:id", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccounting(wreq)) {
    res.status(403).json({ error: "Finance & Accounting access required" });
    return;
  }

  const docId = parseInt(req.params.id, 10);
  if (isNaN(docId)) {
    res.status(400).json({ error: "Invalid document id" });
    return;
  }

  const docRes = await db.query<{ id: number; storage_path: string; uploaded_by: string | null; accounting_month_id: number }>(
    `SELECT d.id, d.storage_path, d.uploaded_by, d.accounting_month_id
     FROM accounting_documents d
     JOIN accounting_months am ON am.id = d.accounting_month_id
     WHERE d.id = $1 AND am.workspace_owner_id = $2`,
    [docId, wreq.workspaceOwnerId],
  );
  if (!docRes.rowCount) {
    res.status(404).json({ error: "Document not found" });
    return;
  }
  const doc = docRes.rows[0];
  const callerUserId = authed(req).userId;

  if (wreq.workspaceActualRole !== "owner" && doc.uploaded_by !== callerUserId) {
    res.status(403).json({ error: "You can only delete documents you uploaded" });
    return;
  }

  await db.query(`DELETE FROM accounting_documents WHERE id = $1`, [docId]);

  try {
    const objectKey = doc.storage_path.replace(/^\/objects\//, "");
    await objectStorageClient.bucket(process.env.GCS_BUCKET_NAME ?? "").file(objectKey).delete();
  } catch {
    // Best-effort GCS deletion; non-fatal
  }

  // Audit event (best-effort, non-fatal)
  try {
    await db.query(
      `INSERT INTO close_audit_events (accounting_month_id, event_type, actor_user_id, description, metadata)
       VALUES ($1, 'document_deleted', $2, $3, $4)`,
      [
        doc.accounting_month_id,
        callerUserId,
        `Document deleted: id=${docId}`,
        JSON.stringify({ documentId: docId }),
      ],
    );
  } catch {
    // Non-fatal
  }

  res.json({ ok: true });
});

// ── Supplier Reconciliation ───────────────────────────────────────────────────

const statementUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

/** Normalize a reference string for matching: lowercase, strip separators, remove leading zeros. */
function normalizeRef(ref: string | null | undefined): string | null {
  if (!ref || !ref.trim()) return null;
  return ref
    .toLowerCase()
    .replace(/[\s\-\/\.#]/g, "")
    .replace(/^0+(?=[1-9])/, "");
}

/** Strip currency symbols and whitespace from a numeric string, return number or null. */
function parseAmount(val: unknown): number | null {
  if (val === null || val === undefined || val === "") return null;
  const str = String(val).replace(/[^0-9.\-]/g, "");
  const n = parseFloat(str);
  return isNaN(n) ? null : n;
}

/** Parse a date string to YYYY-MM-DD, return null if unparseable. */
function normalizeDate(val: unknown): string | null {
  if (!val) return null;
  const s = String(val).trim();
  if (!s) return null;
  // Already ISO YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // DD/MM/YYYY or DD-MM-YYYY
  const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  // MM/DD/YYYY
  const mdy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (mdy) return `${mdy[3]}-${mdy[1].padStart(2, "0")}-${mdy[2].padStart(2, "0")}`;
  // Try native Date parse as fallback
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    return d.toISOString().substring(0, 10);
  }
  return null;
}

/** Simple CSV buffer parser handling quoted fields. */
function parseCsvBuffer(buffer: Buffer): string[][] {
  const text = buffer.toString("utf-8");
  const lines = text.split(/\r?\n/);
  const result: string[][] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const cols: string[] = [];
    let col = "";
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuote && line[i + 1] === '"') { col += '"'; i++; }
        else { inQuote = !inQuote; }
      } else if (ch === "," && !inQuote) {
        cols.push(col.trim());
        col = "";
      } else {
        col += ch;
      }
    }
    cols.push(col.trim());
    result.push(cols);
  }
  return result;
}

type RawStatementRow = {
  reference_number: string | null;
  entry_date: string | null;
  description: string | null;
  amount: number;
  vat_amount: number | null;
  currency: string;
  entry_type: string;
  raw_text: string;
};

const STATEMENT_AI_PROMPT = `You are an expert accounting assistant. Extract all transaction rows from this supplier statement document.

Return ONLY a valid JSON array (no other text, no markdown code fences) where each element has:
- "reference_number": invoice/credit note/payment reference or document number (string or null)
- "entry_date": transaction date in YYYY-MM-DD format (string or null)
- "description": description/narration text (string or null)
- "amount": numeric amount — POSITIVE for invoices/charges owed to the supplier, NEGATIVE for credits/payments made (number)
- "vat_amount": VAT/tax amount if shown separately (number or null)
- "currency": 3-letter ISO currency code e.g. "USD", "AED", "GBP" (string)
- "entry_type": one of "invoice", "credit_note", "payment", "other"

Rules:
1. Scan ALL pages before responding.
2. Include EVERY transaction row even across pages.
3. Debit column = positive amount; Credit column = negative amount.
4. Strip all currency symbols — numbers only.
5. Return ONLY a JSON array with no other text.`;

async function extractStatementRowsFromPdf(
  buffer: Buffer,
  workspaceOwnerId: string,
): Promise<RawStatementRow[]> {
  const model = process.env.AI_INVOICE_MODEL ?? "claude-opus-5";
  let rawText: string;
  try {
    const response = await callAI({
      actionKey: "finance.statement_extraction",
      surface: "accounting",
      provider: "anthropic",
      model,
      maxTokens: 8192,
      sessionId: `workspace:${workspaceOwnerId}`,
      messages: [{
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: buffer.toString("base64"),
            },
          } as unknown as { type: "text"; text: string },
          { type: "text", text: STATEMENT_AI_PROMPT },
        ],
      }],
    });
    rawText = (response.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text as string)
      .join("");
  } catch (err) {
    logger.error({ err }, "supplier-recon: AI PDF statement extraction failed");
    throw new Error("AI statement extraction failed: " + (err instanceof Error ? err.message : "Unknown"));
  }

  // Strip markdown fences if present
  const cleaned = rawText.trim().replace(/^```json?\s*/i, "").replace(/```\s*$/, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    logger.warn({ rawText: rawText.substring(0, 500) }, "supplier-recon: AI returned non-JSON for PDF extraction");
    throw new Error("AI returned non-JSON response for statement extraction");
  }

  if (!Array.isArray(parsed)) {
    throw new Error("AI response was not an array of rows");
  }

  return parsed.map((row: Record<string, unknown>) => ({
    reference_number: row.reference_number ? String(row.reference_number) : null,
    entry_date: normalizeDate(row.entry_date),
    description: row.description ? String(row.description) : null,
    amount: typeof row.amount === "number" ? row.amount : (parseAmount(row.amount) ?? 0),
    vat_amount: row.vat_amount != null ? (typeof row.vat_amount === "number" ? row.vat_amount : parseAmount(row.vat_amount)) : null,
    currency: row.currency ? String(row.currency).toUpperCase().slice(0, 3) : "USD",
    entry_type: ["invoice", "credit_note", "payment", "other"].includes(String(row.entry_type)) ? String(row.entry_type) : "other",
    raw_text: JSON.stringify(row),
  }));
}

function extractStatementRowsFromSpreadsheet(rows: Record<string, unknown>[]): RawStatementRow[] {
  if (rows.length === 0) return [];
  const headers = Object.keys(rows[0]).map((h) => h.toLowerCase().trim());

  const find = (...patterns: string[]): string | null => {
    for (const pat of patterns) {
      const h = headers.find((h) => h.includes(pat));
      if (h) return Object.keys(rows[0])[headers.indexOf(h)];
    }
    return null;
  };

  const refCol = find("reference", "ref no", "inv no", "invoice no", "invoice number", "doc no", "document no", "voucher");
  const dateCol = find("date", "invoice date", "doc date", "issued");
  const descCol = find("description", "desc", "particulars", "narration", "details", "item");
  const amountCol = find("amount", "total", "net amount", "gross", "value", "net");
  const debitCol = find("debit", "charges", "invoice amount", "dr");
  const creditCol = find("credit", "credit note", "payment", "cr");
  const vatCol = find("vat", "tax", "gst");
  const currencyCol = find("currency", "curr");

  return rows
    .map((row) => {
      let amount = 0;
      if (debitCol && creditCol) {
        const debit = parseAmount(row[debitCol]) ?? 0;
        const credit = parseAmount(row[creditCol]) ?? 0;
        amount = debit - credit;
      } else if (amountCol) {
        amount = parseAmount(row[amountCol]) ?? 0;
      }

      const ref = refCol ? String(row[refCol] ?? "").trim() || null : null;
      const desc = descCol ? String(row[descCol] ?? "").trim() || null : null;

      // Detect entry type by sign and description heuristics
      let entry_type = "other";
      if (amount > 0) entry_type = "invoice";
      else if (amount < 0) {
        const lowerDesc = desc?.toLowerCase() ?? "";
        entry_type = (lowerDesc.includes("credit") || lowerDesc.includes("cn-")) ? "credit_note" : "payment";
      }

      return {
        reference_number: ref,
        entry_date: normalizeDate(dateCol ? row[dateCol] : null),
        description: desc,
        amount,
        vat_amount: vatCol ? (parseAmount(row[vatCol]) ?? null) : null,
        currency: currencyCol ? String(row[currencyCol] ?? "USD").toUpperCase().slice(0, 3) : "USD",
        entry_type,
        raw_text: JSON.stringify(row),
      };
    })
    .filter((r) => r.amount !== 0 || r.reference_number);
}

function extractStatementRowsFromCsv(rows: string[][]): RawStatementRow[] {
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => h.toLowerCase().trim());

  const findIdx = (...patterns: string[]): number => {
    for (const pat of patterns) {
      const idx = headers.findIndex((h) => h.includes(pat));
      if (idx >= 0) return idx;
    }
    return -1;
  };

  const refIdx = findIdx("reference", "ref", "inv no", "invoice no", "invoice number", "doc no", "document");
  const dateIdx = findIdx("date", "invoice date", "doc date");
  const descIdx = findIdx("description", "desc", "particulars", "narration", "details");
  const amountIdx = findIdx("amount", "total", "net", "gross", "value");
  const debitIdx = findIdx("debit", "charges", "dr");
  const creditIdx = findIdx("credit", "payment", "cr");
  const vatIdx = findIdx("vat", "tax", "gst");
  const currencyIdx = findIdx("currency", "curr");

  const result: RawStatementRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const cols = rows[i];
    const get = (idx: number): string => (idx >= 0 && idx < cols.length ? cols[idx].trim() : "");

    let amount = 0;
    if (debitIdx >= 0 && creditIdx >= 0) {
      const debit = parseAmount(get(debitIdx)) ?? 0;
      const credit = parseAmount(get(creditIdx)) ?? 0;
      amount = debit - credit;
    } else if (amountIdx >= 0) {
      amount = parseAmount(get(amountIdx)) ?? 0;
    }

    const ref = refIdx >= 0 ? get(refIdx) || null : null;
    if (!ref && amount === 0) continue;

    const desc = descIdx >= 0 ? get(descIdx) || null : null;
    let entry_type = "other";
    if (amount > 0) entry_type = "invoice";
    else if (amount < 0) {
      const lowerDesc = desc?.toLowerCase() ?? "";
      entry_type = lowerDesc.includes("credit") ? "credit_note" : "payment";
    }

    result.push({
      reference_number: ref,
      entry_date: normalizeDate(dateIdx >= 0 ? get(dateIdx) : null),
      description: desc,
      amount,
      vat_amount: vatIdx >= 0 ? (parseAmount(get(vatIdx)) ?? null) : null,
      currency: currencyIdx >= 0 ? (get(currencyIdx).toUpperCase().slice(0, 3) || "USD") : "USD",
      entry_type,
      raw_text: JSON.stringify(cols),
    });
  }
  return result;
}

// ── POST /accounting/entity-months/:entityMonthId/supplier-reconciliation/:supplierId/statement ──

router.post(
  "/accounting/entity-months/:entityMonthId/supplier-reconciliation/:supplierId/statement",
  statementUpload.single("file"),
  async (req, res) => {
    const wreq = workspace(req);
    if (!hasFinanceAccounting(wreq)) {
      res.status(403).json({ error: "Finance & Accounting access required" });
      return;
    }

    const entityMonthId = parseInt(String(req.params.entityMonthId), 10);
    const supplierId = parseInt(String(req.params.supplierId), 10);
    if (isNaN(entityMonthId) || isNaN(supplierId)) {
      res.status(400).json({ error: "Invalid entityMonthId or supplierId" });
      return;
    }

    // Resolve entity month (workspace check)
    const emRes = await db.query<{ id: number; accounting_month_id: number; entity_id: number; year: number; month: number }>(
      `SELECT aem.id, aem.accounting_month_id, aem.entity_id, am.year, am.month
       FROM accounting_entity_months aem
       JOIN accounting_months am ON am.id = aem.accounting_month_id
       WHERE aem.id = $1 AND aem.workspace_owner_id = $2`,
      [entityMonthId, wreq.workspaceOwnerId],
    );
    if (!emRes.rowCount) {
      res.status(404).json({ error: "Entity month not found" });
      return;
    }
    const em = emRes.rows[0];

    // Verify supplier belongs to workspace
    const supplierRes = await db.query<{ id: number }>(
      `SELECT id FROM suppliers WHERE id = $1 AND workspace_owner_id = $2 AND is_archived = false`,
      [supplierId, wreq.workspaceOwnerId],
    );
    if (!supplierRes.rowCount) {
      res.status(404).json({ error: "Supplier not found" });
      return;
    }

    const file = (req as unknown as { file?: Express.Multer.File }).file;
    if (!file) {
      res.status(400).json({ error: "A file is required" });
      return;
    }

    const allowedMimes = [
      "application/pdf",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "text/csv",
      "text/plain",
      "application/octet-stream",
    ];
    const lowerName = file.originalname.toLowerCase();
    const isAllowed =
      allowedMimes.includes(file.mimetype) ||
      lowerName.endsWith(".pdf") ||
      lowerName.endsWith(".xls") ||
      lowerName.endsWith(".xlsx") ||
      lowerName.endsWith(".csv");
    if (!isAllowed) {
      res.status(400).json({ error: "Only PDF, XLS, XLSX, and CSV files are supported" });
      return;
    }

    // Upload to private object storage
    const newStatementId = randomUUID();
    const timestamp = Date.now();
    const safeFileName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    const objectKey = `${wreq.workspaceOwnerId}/supplier-statements/${supplierId}/${entityMonthId}/${timestamp}-${safeFileName}`;

    let fileUrl: string;
    try {
      const privateDir = objectStorageService.getPrivateObjectDir();
      const fullPath = `${privateDir}/${objectKey}`;
      const pathParts = fullPath.replace(/^\//, "").split("/");
      const bucketName = pathParts[0];
      const objectName = pathParts.slice(1).join("/");
      const bucket = objectStorageClient.bucket(bucketName);
      const gcsFile = bucket.file(objectName);
      await gcsFile.save(file.buffer, {
        metadata: { contentType: file.mimetype },
        resumable: false,
      });
      fileUrl = `/objects/${objectKey}`;
    } catch (err) {
      logger.error({ err }, "supplier-recon: failed to upload statement file");
      res.status(500).json({ error: "Failed to store uploaded file" });
      return;
    }

    const callerUserId = authed(req).userId;
    const replacementReason = typeof req.body?.replacement_reason === "string" ? req.body.replacement_reason.trim() || null : null;

    // Check for existing statement for this supplier + entity-month
    const prevRes = await db.query<{ id: string }>(
      `SELECT id FROM supplier_statements
       WHERE supplier_id = $1 AND accounting_entity_month_id = $2 AND workspace_owner_id = $3
         AND replaced_by IS NULL
       ORDER BY created_at DESC
       LIMIT 1`,
      [supplierId, entityMonthId, wreq.workspaceOwnerId],
    );
    const isReplacement = (prevRes.rowCount ?? 0) > 0;
    const prevStatementId = isReplacement ? prevRes.rows[0].id : null;

    // If replacing, link old → new
    if (prevStatementId) {
      await db.query(
        `UPDATE supplier_statements SET replaced_by = $1, replacement_reason = $2, updated_at = now()
         WHERE id = $3`,
        [newStatementId, replacementReason, prevStatementId],
      );
    }

    // Insert new statement row
    await db.query(
      `INSERT INTO supplier_statements
         (id, supplier_id, workspace_owner_id, accounting_entity_month_id,
          statement_month, statement_year,
          file_url, original_file_name, mime_type, file_size_bytes,
          extraction_status, status, uploaded_by_member_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', 'uploaded', $11)`,
      [
        newStatementId,
        supplierId,
        wreq.workspaceOwnerId,
        entityMonthId,
        em.month,
        em.year,
        fileUrl,
        file.originalname,
        file.mimetype,
        file.size,
        wreq.memberDbId ?? null,
      ],
    );

    // Upsert reconciliation session
    const sessionRes = await db.query<{
      id: number; supplier_id: number; accounting_entity_month_id: number;
      workspace_owner_id: string; status: string; statement_balance: string | null;
      os_balance: string | null; balance_difference: string | null; open_exceptions_count: number;
      created_at: string; updated_at: string;
    }>(
      `INSERT INTO supplier_reconciliation_sessions
         (supplier_id, accounting_entity_month_id, workspace_owner_id, status)
       VALUES ($1, $2, $3, 'processing')
       ON CONFLICT (supplier_id, accounting_entity_month_id)
       DO UPDATE SET status = 'processing', updated_at = now()
       RETURNING *`,
      [supplierId, entityMonthId, wreq.workspaceOwnerId],
    );
    const session = sessionRes.rows[0];

    // Insert audit event
    try {
      await db.query(
        `INSERT INTO supplier_reconciliation_audit
           (session_id, workspace_owner_id, actor, action, detail)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          session.id,
          wreq.workspaceOwnerId,
          callerUserId,
          isReplacement ? "statement_replaced" : "statement_uploaded",
          JSON.stringify({
            statement_id: newStatementId,
            file_name: file.originalname,
            file_size: file.size,
            replaced_statement_id: prevStatementId ?? null,
            replacement_reason: replacementReason,
          }),
        ],
      );
    } catch { /* non-fatal */ }

    res.status(201).json({
      ok: true,
      session,
      statement: {
        id: newStatementId,
        supplier_id: supplierId,
        accounting_entity_month_id: entityMonthId,
        original_file_name: file.originalname,
        mime_type: file.mimetype,
        file_size_bytes: file.size,
        extraction_status: "pending",
        replaced_statement_id: prevStatementId,
      },
    });
  },
);

// ── POST /accounting/supplier-reconciliation/sessions/:sessionId/extract ──────

router.post("/accounting/supplier-reconciliation/sessions/:sessionId/extract", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccounting(wreq)) {
    res.status(403).json({ error: "Finance & Accounting access required" });
    return;
  }

  const sessionId = parseInt(req.params.sessionId, 10);
  if (isNaN(sessionId)) {
    res.status(400).json({ error: "Invalid sessionId" });
    return;
  }

  const sessionRes = await db.query<{
    id: number; supplier_id: number; accounting_entity_month_id: number; workspace_owner_id: string;
  }>(
    `SELECT id, supplier_id, accounting_entity_month_id, workspace_owner_id
     FROM supplier_reconciliation_sessions WHERE id = $1 AND workspace_owner_id = $2`,
    [sessionId, wreq.workspaceOwnerId],
  );
  if (!sessionRes.rowCount) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  const sess = sessionRes.rows[0];

  // Find latest active statement
  const stmtRes = await db.query<{
    id: string; file_url: string; original_file_name: string; mime_type: string | null;
  }>(
    `SELECT id, file_url, original_file_name, mime_type
     FROM supplier_statements
     WHERE supplier_id = $1 AND accounting_entity_month_id = $2 AND workspace_owner_id = $3
       AND replaced_by IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    [sess.supplier_id, sess.accounting_entity_month_id, wreq.workspaceOwnerId],
  );
  if (!stmtRes.rowCount) {
    res.status(404).json({ error: "No active statement found for this session" });
    return;
  }
  const stmt = stmtRes.rows[0];

  // Download file buffer from storage
  let fileBuffer: Buffer;
  try {
    const objFile = await objectStorageService.getObjectEntityFile(stmt.file_url);
    const [bytes] = await objFile.download();
    fileBuffer = bytes as Buffer;
  } catch (err) {
    logger.error({ err, fileUrl: stmt.file_url }, "supplier-recon: failed to download statement file");
    await db.query(
      `UPDATE supplier_statements SET extraction_status = 'failed', updated_at = now() WHERE id = $1`,
      [stmt.id],
    );
    res.status(500).json({ error: "Failed to retrieve statement file from storage" });
    return;
  }

  const mimeType = stmt.mime_type ?? "";
  const fileName = (stmt.original_file_name ?? "").toLowerCase();
  let rows: RawStatementRow[];

  try {
    if (mimeType === "application/pdf" || fileName.endsWith(".pdf")) {
      rows = await extractStatementRowsFromPdf(fileBuffer, wreq.workspaceOwnerId);
    } else if (fileName.endsWith(".csv") || mimeType === "text/csv" || mimeType === "text/plain") {
      const csvRows = parseCsvBuffer(fileBuffer);
      rows = extractStatementRowsFromCsv(csvRows);
    } else {
      // XLS / XLSX
      const jsonRows = await parseSpreadsheetToJson(fileBuffer);
      rows = extractStatementRowsFromSpreadsheet(jsonRows);
    }
  } catch (err) {
    logger.error({ err }, "supplier-recon: extraction failed");
    await db.query(
      `UPDATE supplier_statements SET extraction_status = 'failed', updated_at = now() WHERE id = $1`,
      [stmt.id],
    );
    res.status(422).json({ error: "Statement extraction failed: " + (err instanceof Error ? err.message : "Unknown error") });
    return;
  }

  // Clear old entries for this statement
  await db.query(
    `DELETE FROM supplier_statement_entries WHERE supplier_statement_id = $1`,
    [stmt.id],
  );

  // Insert extracted entries
  let statementBalance = 0;
  let insertedCount = 0;
  for (const row of rows) {
    const normalizedRef = normalizeRef(row.reference_number);
    await db.query(
      `INSERT INTO supplier_statement_entries
         (supplier_statement_id, workspace_owner_id, entry_type, reference_number,
          entry_date, amount, currency, vat_amount, description, raw_text, normalized_reference)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        stmt.id,
        wreq.workspaceOwnerId,
        row.entry_type,
        row.reference_number,
        row.entry_date,
        row.amount,
        row.currency,
        row.vat_amount,
        row.description,
        row.raw_text,
        normalizedRef,
      ],
    );
    statementBalance += row.amount;
    insertedCount++;
  }

  // Update statement extraction status
  await db.query(
    `UPDATE supplier_statements
     SET extraction_status = 'extracted', extracted_at = now(), updated_at = now()
     WHERE id = $1`,
    [stmt.id],
  );

  // Update session with statement balance
  await db.query(
    `UPDATE supplier_reconciliation_sessions
     SET statement_balance = $1, updated_at = now()
     WHERE id = $2`,
    [statementBalance, sessionId],
  );

  const callerUserId = authed(req).userId;
  try {
    await db.query(
      `INSERT INTO supplier_reconciliation_audit (session_id, workspace_owner_id, actor, action, detail)
       VALUES ($1, $2, $3, 'statement_extracted', $4)`,
      [sessionId, wreq.workspaceOwnerId, callerUserId, JSON.stringify({ rows_extracted: insertedCount, statement_balance: statementBalance })],
    );
  } catch { /* non-fatal */ }

  res.json({
    ok: true,
    rows_extracted: insertedCount,
    statement_balance: statementBalance,
    statement_id: stmt.id,
  });
});

// ── POST /accounting/supplier-reconciliation/sessions/:sessionId/match ────────

router.post("/accounting/supplier-reconciliation/sessions/:sessionId/match", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccounting(wreq)) {
    res.status(403).json({ error: "Finance & Accounting access required" });
    return;
  }

  const sessionId = parseInt(req.params.sessionId, 10);
  if (isNaN(sessionId)) {
    res.status(400).json({ error: "Invalid sessionId" });
    return;
  }

  const sessionRes = await db.query<{
    id: number; supplier_id: number; accounting_entity_month_id: number; workspace_owner_id: string;
  }>(
    `SELECT id, supplier_id, accounting_entity_month_id, workspace_owner_id
     FROM supplier_reconciliation_sessions WHERE id = $1 AND workspace_owner_id = $2`,
    [sessionId, wreq.workspaceOwnerId],
  );
  if (!sessionRes.rowCount) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  const sess = sessionRes.rows[0];

  // Get all extracted statement entries for this session's statement
  const stmtRes = await db.query<{ id: string }>(
    `SELECT id FROM supplier_statements
     WHERE supplier_id = $1 AND accounting_entity_month_id = $2 AND workspace_owner_id = $3
       AND replaced_by IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    [sess.supplier_id, sess.accounting_entity_month_id, wreq.workspaceOwnerId],
  );
  if (!stmtRes.rowCount) {
    res.status(404).json({ error: "No active statement found for this session" });
    return;
  }
  const statementId = stmtRes.rows[0].id;

  const entriesRes = await db.query<{
    id: number; reference_number: string | null; normalized_reference: string | null;
    entry_date: string | null; amount: string; currency: string; entry_type: string; vat_amount: string | null;
  }>(
    `SELECT id, reference_number, normalized_reference, entry_date, amount, currency, entry_type, vat_amount
     FROM supplier_statement_entries
     WHERE supplier_statement_id = $1 AND workspace_owner_id = $2
     ORDER BY id`,
    [statementId, wreq.workspaceOwnerId],
  );
  const entries = entriesRes.rows;

  // Load OS invoices for this supplier (include credit notes as negative amounts)
  const osInvoicesRes = await db.query<{
    id: number; invoice_number: string | null; issued_at: string | null;
    amount: string; currency: string; status: string; vat_amount: string | null; grand_total: string | null;
  }>(
    `SELECT id, invoice_number, issued_at, amount, currency, status, vat_amount, grand_total
     FROM supplier_invoices
     WHERE supplier_id = $1 AND workspace_owner_id = $2
     ORDER BY issued_at DESC`,
    [sess.supplier_id, wreq.workspaceOwnerId],
  );
  const osInvoices = osInvoicesRes.rows;

  // Load OS payments for this supplier
  const osPaymentsRes = await db.query<{
    id: number; supplier_invoice_id: number; amount: string; currency: string;
    paid_at: string; is_reversed: boolean;
  }>(
    `SELECT sip.id, sip.supplier_invoice_id, sip.amount, sip.currency, sip.paid_at, sip.is_reversed
     FROM supplier_invoice_payments sip
     JOIN supplier_invoices si ON si.id = sip.supplier_invoice_id
     WHERE si.supplier_id = $1 AND sip.workspace_owner_id = $2 AND sip.is_reversed = false`,
    [sess.supplier_id, wreq.workspaceOwnerId],
  );
  const osPayments = osPaymentsRes.rows;

  // Clear existing matches and exceptions for this session
  await db.query(`DELETE FROM supplier_reconciliation_exceptions WHERE session_id = $1`, [sessionId]);
  await db.query(`DELETE FROM supplier_reconciliation_matches WHERE session_id = $1`, [sessionId]);

  // Build normalized OS invoice map
  const osInvoiceMap = new Map(
    osInvoices.map((inv) => [inv.id, { ...inv, normalized: normalizeRef(inv.invoice_number) }]),
  );

  // Track which OS invoices were matched
  const matchedOsInvoiceIds = new Set<number>();
  const matchedOsPaymentIds = new Set<number>();

  // Detect duplicate statement entries (same ref appears twice)
  const refCounts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.normalized_reference) {
      refCounts.set(entry.normalized_reference, (refCounts.get(entry.normalized_reference) ?? 0) + 1);
    }
  }

  let openExceptionsCount = 0;

  for (const entry of entries) {
    const entryAmount = parseFloat(entry.amount);
    const entryDate = entry.entry_date ? new Date(entry.entry_date) : null;
    const entryNorm = entry.normalized_reference;

    // Detect duplicate_statement exception
    if (entryNorm && (refCounts.get(entryNorm) ?? 0) > 1) {
      const matchRow = await db.query<{ id: number }>(
        `INSERT INTO supplier_reconciliation_matches
           (session_id, statement_entry_id, os_record_type, os_record_id, match_type, match_confidence, match_signals)
         VALUES ($1, $2, NULL, NULL, 'unmatched', 0, $3)
         RETURNING id`,
        [sessionId, entry.id, JSON.stringify({ duplicate_statement: true })],
      );
      await db.query(
        `INSERT INTO supplier_reconciliation_exceptions
           (session_id, workspace_owner_id, match_id, exception_type, status, statement_data)
         VALUES ($1, $2, $3, 'duplicate_statement', 'open', $4)`,
        [
          sessionId,
          wreq.workspaceOwnerId,
          matchRow.rows[0].id,
          JSON.stringify({ entry_id: entry.id, reference_number: entry.reference_number, amount: entryAmount }),
        ],
      );
      openExceptionsCount++;
      continue;
    }

    // Score OS invoices against this entry
    let bestScore = 0;
    let bestOsInvoice: (typeof osInvoices)[0] | null = null;

    for (const inv of osInvoices) {
      let score = 0;
      const signals: Record<string, unknown> = {};
      const invNorm = osInvoiceMap.get(inv.id)?.normalized ?? null;

      // Reference match (high weight: 60)
      if (entryNorm && invNorm && entryNorm === invNorm) {
        score += 60;
        signals.reference_match = true;
      }

      // Amount match (medium weight: 30)
      const osAmount = parseFloat(inv.grand_total ?? inv.amount);
      const amountDiff = Math.abs(Math.abs(entryAmount) - Math.abs(osAmount));
      const amountPct = osAmount !== 0 ? amountDiff / Math.abs(osAmount) : 1;
      if (amountPct <= 0.01) {
        score += 30;
        signals.amount_match = "exact";
      } else if (amountPct <= 0.05) {
        score += 15;
        signals.amount_match = "approximate";
      }

      // Date match (low weight: 10)
      if (entryDate && inv.issued_at) {
        const osDate = new Date(inv.issued_at);
        const daysDiff = Math.abs((entryDate.getTime() - osDate.getTime()) / 86400000);
        if (daysDiff <= 3) {
          score += 10;
          signals.date_match = "exact";
        } else if (daysDiff <= 7) {
          score += 7;
          signals.date_match = "close";
        } else if (daysDiff <= 30) {
          score += 3;
          signals.date_match = "approximate";
        }
      }

      // Currency match (low weight: 5)
      if (entry.currency.toUpperCase() === inv.currency.toUpperCase()) {
        score += 5;
        signals.currency_match = true;
      }

      if (score > bestScore) {
        bestScore = score;
        bestOsInvoice = inv;
      }
    }

    // Also check OS payments for payment-type entries
    let bestOsPayment: (typeof osPayments)[0] | null = null;
    if (entry.entry_type === "payment") {
      for (const pmt of osPayments) {
        let score = 0;
        const pmtAmount = parseFloat(pmt.amount);
        const amountDiff = Math.abs(Math.abs(entryAmount) - Math.abs(pmtAmount));
        const amountPct = pmtAmount !== 0 ? amountDiff / Math.abs(pmtAmount) : 1;
        if (amountPct <= 0.01) score += 30;
        else if (amountPct <= 0.05) score += 15;
        if (entryDate && pmt.paid_at) {
          const pmtDate = new Date(pmt.paid_at);
          const daysDiff = Math.abs((entryDate.getTime() - pmtDate.getTime()) / 86400000);
          if (daysDiff <= 3) score += 10;
          else if (daysDiff <= 7) score += 7;
        }
        if (entry.currency.toUpperCase() === pmt.currency.toUpperCase()) score += 5;
        if (score > bestScore) {
          bestScore = score;
          bestOsPayment = pmt;
          bestOsInvoice = null;
        }
      }
    }

    // Classify match
    let matchType: string;
    if (bestScore >= 70) matchType = "matched";
    else if (bestScore >= 35) matchType = "possible";
    else matchType = "unmatched";

    const matchedOsType = bestOsPayment ? "payment" : (bestOsInvoice ? "invoice" : null);
    const matchedOsId = bestOsPayment?.id ?? bestOsInvoice?.id ?? null;

    const matchRow = await db.query<{ id: number }>(
      `INSERT INTO supplier_reconciliation_matches
         (session_id, statement_entry_id, os_record_type, os_record_id, match_type, match_confidence, match_signals)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        sessionId,
        entry.id,
        matchedOsType,
        matchedOsId,
        matchType,
        bestScore / 100,
        JSON.stringify({ score: bestScore }),
      ],
    );
    const matchId = matchRow.rows[0].id;

    if (matchType === "unmatched") {
      await db.query(
        `INSERT INTO supplier_reconciliation_exceptions
           (session_id, workspace_owner_id, match_id, exception_type, status, statement_data)
         VALUES ($1, $2, $3, 'missing_in_os', 'open', $4)`,
        [
          sessionId,
          wreq.workspaceOwnerId,
          matchId,
          JSON.stringify({ entry_id: entry.id, reference: entry.reference_number, amount: entryAmount, date: entry.entry_date }),
        ],
      );
      openExceptionsCount++;
    } else if (matchType === "possible") {
      await db.query(
        `INSERT INTO supplier_reconciliation_exceptions
           (session_id, workspace_owner_id, match_id, exception_type, status, statement_data, os_data,
            linked_os_record_type, linked_os_record_id)
         VALUES ($1, $2, $3, 'possible_match', 'open', $4, $5, $6, $7)`,
        [
          sessionId,
          wreq.workspaceOwnerId,
          matchId,
          JSON.stringify({ entry_id: entry.id, reference: entry.reference_number, amount: entryAmount }),
          JSON.stringify({ os_id: matchedOsId, os_type: matchedOsType, score: bestScore }),
          matchedOsType,
          matchedOsId,
        ],
      );
      openExceptionsCount++;
    } else {
      // matched — check for amount/vat/currency/date mismatches
      if (bestOsInvoice) {
        matchedOsInvoiceIds.add(bestOsInvoice.id);
        const osAmount = parseFloat(bestOsInvoice.grand_total ?? bestOsInvoice.amount);
        const amountDiff = Math.abs(Math.abs(entryAmount) - Math.abs(osAmount));
        if (amountDiff > 0.01) {
          await db.query(
            `INSERT INTO supplier_reconciliation_exceptions
               (session_id, workspace_owner_id, match_id, exception_type, status, statement_data, os_data,
                linked_os_record_type, linked_os_record_id)
             VALUES ($1, $2, $3, 'amount_mismatch', 'open', $4, $5, $6, $7)`,
            [
              sessionId,
              wreq.workspaceOwnerId,
              matchId,
              JSON.stringify({ amount: entryAmount, reference: entry.reference_number }),
              JSON.stringify({ os_id: bestOsInvoice.id, os_amount: osAmount }),
              "invoice",
              bestOsInvoice.id,
            ],
          );
          openExceptionsCount++;
        }
        // VAT mismatch
        if (entry.vat_amount != null && bestOsInvoice.vat_amount != null) {
          const entryVat = parseFloat(entry.vat_amount);
          const osVat = parseFloat(bestOsInvoice.vat_amount);
          if (Math.abs(entryVat - osVat) > 0.01) {
            await db.query(
              `INSERT INTO supplier_reconciliation_exceptions
                 (session_id, workspace_owner_id, match_id, exception_type, status, statement_data, os_data,
                  linked_os_record_type, linked_os_record_id)
               VALUES ($1, $2, $3, 'vat_mismatch', 'open', $4, $5, $6, $7)`,
              [
                sessionId,
                wreq.workspaceOwnerId,
                matchId,
                JSON.stringify({ vat_amount: entryVat }),
                JSON.stringify({ os_id: bestOsInvoice.id, os_vat: osVat }),
                "invoice",
                bestOsInvoice.id,
              ],
            );
            openExceptionsCount++;
          }
        }
        // Currency mismatch
        if (entry.currency.toUpperCase() !== bestOsInvoice.currency.toUpperCase()) {
          await db.query(
            `INSERT INTO supplier_reconciliation_exceptions
               (session_id, workspace_owner_id, match_id, exception_type, status, statement_data, os_data,
                linked_os_record_type, linked_os_record_id)
             VALUES ($1, $2, $3, 'currency_mismatch', 'open', $4, $5, $6, $7)`,
            [
              sessionId,
              wreq.workspaceOwnerId,
              matchId,
              JSON.stringify({ currency: entry.currency }),
              JSON.stringify({ os_id: bestOsInvoice.id, os_currency: bestOsInvoice.currency }),
              "invoice",
              bestOsInvoice.id,
            ],
          );
          openExceptionsCount++;
        }
      } else if (bestOsPayment) {
        matchedOsPaymentIds.add(bestOsPayment.id);
      }

      // Check duplicate_os: same OS bill matched by multiple entries
      // (We'll detect this after all entries are processed)
    }
  }

  // Detect OS invoices not referenced by any statement entry → missing_in_statement
  for (const inv of osInvoices) {
    if (!matchedOsInvoiceIds.has(inv.id) && inv.status !== "cancelled" && inv.status !== "paid") {
      // Check if any entry normalized_reference matches this invoice
      const invNorm = normalizeRef(inv.invoice_number);
      const anyMatch = entries.some((e) => e.normalized_reference && invNorm && e.normalized_reference === invNorm);
      if (!anyMatch) {
        await db.query(
          `INSERT INTO supplier_reconciliation_exceptions
             (session_id, workspace_owner_id, match_id, exception_type, status, os_data,
              linked_os_record_type, linked_os_record_id)
           VALUES ($1, $2, NULL, 'missing_in_statement', 'open', $3, 'invoice', $4)`,
          [
            sessionId,
            wreq.workspaceOwnerId,
            JSON.stringify({ os_id: inv.id, invoice_number: inv.invoice_number, amount: inv.amount, currency: inv.currency }),
            inv.id,
          ],
        );
        openExceptionsCount++;
      }
    }
  }

  // Compute OS balance from matched invoice amounts
  let osBalance = 0;
  for (const invId of matchedOsInvoiceIds) {
    const inv = osInvoiceMap.get(invId);
    if (inv) osBalance += parseFloat(inv.grand_total ?? inv.amount);
  }
  for (const pmtId of matchedOsPaymentIds) {
    const pmt = osPayments.find((p) => p.id === pmtId);
    if (pmt) osBalance -= parseFloat(pmt.amount);
  }

  const statementBalanceRes = await db.query<{ statement_balance: string | null }>(
    `SELECT statement_balance FROM supplier_reconciliation_sessions WHERE id = $1`,
    [sessionId],
  );
  const statementBalance = parseFloat(statementBalanceRes.rows[0]?.statement_balance ?? "0");
  const balanceDifference = statementBalance - osBalance;
  const newStatus = openExceptionsCount > 0 ? "needs_review" : "reconciled";

  await db.query(
    `UPDATE supplier_reconciliation_sessions
     SET os_balance = $1, balance_difference = $2, open_exceptions_count = $3, status = $4, updated_at = now()
     WHERE id = $5`,
    [osBalance, balanceDifference, openExceptionsCount, newStatus, sessionId],
  );

  const callerUserId = authed(req).userId;
  try {
    await db.query(
      `INSERT INTO supplier_reconciliation_audit (session_id, workspace_owner_id, actor, action, detail)
       VALUES ($1, $2, $3, 'match_run', $4)`,
      [
        sessionId,
        wreq.workspaceOwnerId,
        callerUserId,
        JSON.stringify({
          entries_processed: entries.length,
          open_exceptions: openExceptionsCount,
          os_balance: osBalance,
          statement_balance: statementBalance,
          balance_difference: balanceDifference,
          status: newStatus,
        }),
      ],
    );
  } catch { /* non-fatal */ }

  res.json({
    ok: true,
    status: newStatus,
    entries_processed: entries.length,
    open_exceptions_count: openExceptionsCount,
    statement_balance: statementBalance,
    os_balance: osBalance,
    balance_difference: balanceDifference,
  });
});

// ── GET /accounting/supplier-reconciliation/sessions/:sessionId ───────────────

router.get("/accounting/supplier-reconciliation/sessions/:sessionId", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccounting(wreq)) {
    res.status(403).json({ error: "Finance & Accounting access required" });
    return;
  }

  const sessionId = parseInt(req.params.sessionId, 10);
  if (isNaN(sessionId)) {
    res.status(400).json({ error: "Invalid sessionId" });
    return;
  }

  const view = typeof req.query.view === "string" ? req.query.view : "all";

  const sessionRes = await db.query<{
    id: number; supplier_id: number; accounting_entity_month_id: number; workspace_owner_id: string;
    status: string; statement_balance: string | null; os_balance: string | null;
    balance_difference: string | null; open_exceptions_count: number;
    prepared_by: string | null; prepared_at: string | null; notes: string | null;
    created_at: string; updated_at: string;
  }>(
    `SELECT * FROM supplier_reconciliation_sessions WHERE id = $1 AND workspace_owner_id = $2`,
    [sessionId, wreq.workspaceOwnerId],
  );
  if (!sessionRes.rowCount) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  const session = sessionRes.rows[0];

  // Get current statement metadata + replacement chain
  const stmtsRes = await db.query<{
    id: string; original_file_name: string; mime_type: string | null; file_size_bytes: number | null;
    extraction_status: string; uploaded_by_member_id: number | null; created_at: string;
    replaced_by: string | null; replacement_reason: string | null;
    uploader_email: string | null;
  }>(
    `SELECT ss.id, ss.original_file_name, ss.mime_type, ss.file_size_bytes, ss.extraction_status,
            ss.uploaded_by_member_id, ss.created_at, ss.replaced_by, ss.replacement_reason,
            wm.member_email AS uploader_email
     FROM supplier_statements ss
     LEFT JOIN workspace_members wm ON wm.id = ss.uploaded_by_member_id
     WHERE ss.supplier_id = $1 AND ss.accounting_entity_month_id = $2 AND ss.workspace_owner_id = $3
     ORDER BY ss.created_at DESC`,
    [session.supplier_id, session.accounting_entity_month_id, wreq.workspaceOwnerId],
  );
  const statements = stmtsRes.rows;
  const currentStatement = statements.find((s) => !s.replaced_by) ?? statements[0] ?? null;

  const payload: Record<string, unknown> = {
    session,
    statement: currentStatement,
    statement_history: statements,
    balance_summary: {
      statement_balance: session.statement_balance ? parseFloat(session.statement_balance) : null,
      os_balance: session.os_balance ? parseFloat(session.os_balance) : null,
      balance_difference: session.balance_difference ? parseFloat(session.balance_difference) : null,
      open_exceptions_count: session.open_exceptions_count,
    },
  };

  if (view === "exceptions" || view === "all") {
    const exceptRes = await db.query(
      `SELECT sre.*, srm.match_type, srm.match_confidence,
              sse.reference_number AS entry_reference, sse.amount AS entry_amount, sse.entry_date
       FROM supplier_reconciliation_exceptions sre
       LEFT JOIN supplier_reconciliation_matches srm ON srm.id = sre.match_id
       LEFT JOIN supplier_statement_entries sse ON sse.id = srm.statement_entry_id
       WHERE sre.session_id = $1
       ORDER BY sre.created_at`,
      [sessionId],
    );
    payload.exceptions = exceptRes.rows;
  }

  if (view === "matched" || view === "all") {
    const matchRes = await db.query(
      `SELECT srm.*,
              sse.reference_number AS entry_reference, sse.amount AS entry_amount,
              sse.entry_date, sse.entry_type, sse.currency AS entry_currency, sse.description
       FROM supplier_reconciliation_matches srm
       LEFT JOIN supplier_statement_entries sse ON sse.id = srm.statement_entry_id
       WHERE srm.session_id = $1
       ORDER BY srm.id`,
      [sessionId],
    );
    payload.matches = matchRes.rows;
  }

  res.json(payload);
});

// ── GET /accounting/entity-months/:entityMonthId/supplier-reconciliation ───────

router.get("/accounting/entity-months/:entityMonthId/supplier-reconciliation", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccounting(wreq)) {
    res.status(403).json({ error: "Finance & Accounting access required" });
    return;
  }

  const entityMonthId = parseInt(req.params.entityMonthId, 10);
  if (isNaN(entityMonthId)) {
    res.status(400).json({ error: "Invalid entityMonthId" });
    return;
  }

  const emRes = await db.query<{ id: number; accounting_month_id: number; entity_id: number; year: number; month: number }>(
    `SELECT aem.id, aem.accounting_month_id, aem.entity_id, am.year, am.month
     FROM accounting_entity_months aem
     JOIN accounting_months am ON am.id = aem.accounting_month_id
     WHERE aem.id = $1 AND aem.workspace_owner_id = $2`,
    [entityMonthId, wreq.workspaceOwnerId],
  );
  if (!emRes.rowCount) {
    res.status(404).json({ error: "Entity month not found" });
    return;
  }

  // Suppliers with their reconciliation session (if any) and latest statement
  const overviewRes = await db.query<{
    supplier_id: number; supplier_name: string; display_name: string | null;
    session_id: number | null; session_status: string | null;
    statement_balance: string | null; os_balance: string | null;
    balance_difference: string | null; open_exceptions_count: number | null;
    latest_statement_id: string | null; latest_file_name: string | null;
    latest_uploaded_at: string | null; uploader_email: string | null;
    extraction_status: string | null;
  }>(
    `SELECT
       s.id AS supplier_id, s.name AS supplier_name, s.display_name,
       srs.id AS session_id, srs.status AS session_status,
       srs.statement_balance, srs.os_balance, srs.balance_difference, srs.open_exceptions_count,
       latest_stmt.id AS latest_statement_id,
       latest_stmt.original_file_name AS latest_file_name,
       latest_stmt.created_at AS latest_uploaded_at,
       wm.member_email AS uploader_email,
       latest_stmt.extraction_status
     FROM suppliers s
     LEFT JOIN supplier_reconciliation_sessions srs
       ON srs.supplier_id = s.id AND srs.accounting_entity_month_id = $1 AND srs.workspace_owner_id = s.workspace_owner_id
     LEFT JOIN LATERAL (
       SELECT ss.id, ss.original_file_name, ss.created_at, ss.uploaded_by_member_id, ss.extraction_status
       FROM supplier_statements ss
       WHERE ss.supplier_id = s.id AND ss.accounting_entity_month_id = $1 AND ss.workspace_owner_id = s.workspace_owner_id
         AND ss.replaced_by IS NULL
       ORDER BY ss.created_at DESC LIMIT 1
     ) latest_stmt ON true
     LEFT JOIN workspace_members wm ON wm.id = latest_stmt.uploaded_by_member_id
     WHERE s.workspace_owner_id = $2 AND s.is_archived = false
     ORDER BY COALESCE(s.display_name, s.name) ASC`,
    [entityMonthId, wreq.workspaceOwnerId],
  );

  const suppliers = overviewRes.rows;

  // Aggregate summary
  const suppliersTotal = suppliers.length;
  const suppliersWithStatements = suppliers.filter((s) => s.latest_statement_id).length;
  const suppliersReconciled = suppliers.filter((s) => s.session_status === "reconciled").length;
  const totalOpenExceptions = suppliers.reduce((sum, s) => sum + (s.open_exceptions_count ?? 0), 0);
  const totalBalanceDiff = suppliers.reduce(
    (sum, s) => sum + (s.balance_difference ? parseFloat(s.balance_difference) : 0),
    0,
  );

  res.json({
    suppliers: suppliers.map((s) => ({
      supplierId: s.supplier_id,
      supplierName: s.display_name ?? s.supplier_name,
      sessionId: s.session_id,
      sessionStatus: s.session_status ?? "statement_needed",
      statementBalance: s.statement_balance ? parseFloat(s.statement_balance) : null,
      osBalance: s.os_balance ? parseFloat(s.os_balance) : null,
      balanceDifference: s.balance_difference ? parseFloat(s.balance_difference) : null,
      openExceptionsCount: s.open_exceptions_count ?? 0,
      latestStatementId: s.latest_statement_id,
      latestFileName: s.latest_file_name,
      latestUploadedAt: s.latest_uploaded_at,
      uploaderEmail: s.uploader_email,
      extractionStatus: s.extraction_status,
    })),
    summary: {
      suppliers_total: suppliersTotal,
      suppliers_with_statements: suppliersWithStatements,
      suppliers_reconciled: suppliersReconciled,
      total_open_exceptions: totalOpenExceptions,
      total_balance_difference: totalBalanceDiff,
    },
  });
});

// ── Helper: recompute open_exceptions_count on a session ─────────────────────

async function recomputeOpenExceptions(sessionId: number): Promise<number> {
  const res = await db.query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt FROM supplier_reconciliation_exceptions
     WHERE session_id = $1 AND status = 'open'`,
    [sessionId],
  );
  const cnt = parseInt(res.rows[0]?.cnt ?? "0", 10);
  await db.query(
    `UPDATE supplier_reconciliation_sessions SET open_exceptions_count = $1, updated_at = now() WHERE id = $2`,
    [cnt, sessionId],
  );
  return cnt;
}

// ── Helper: append an audit event (non-fatal) ─────────────────────────────────

async function appendAudit(
  sessionId: number,
  workspaceOwnerId: string,
  actor: string,
  action: string,
  detail: Record<string, unknown>,
): Promise<void> {
  try {
    await db.query(
      `INSERT INTO supplier_reconciliation_audit (session_id, workspace_owner_id, actor, action, detail)
       VALUES ($1, $2, $3, $4, $5)`,
      [sessionId, workspaceOwnerId, actor, action, JSON.stringify(detail)],
    );
  } catch { /* non-fatal */ }
}

// ── PATCH /accounting/supplier-reconciliation/exceptions/:exceptionId/resolve ─

router.patch("/accounting/supplier-reconciliation/exceptions/:exceptionId/resolve", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccounting(wreq)) {
    res.status(403).json({ error: "Finance & Accounting access required" });
    return;
  }

  const exceptionId = parseInt(req.params.exceptionId, 10);
  if (isNaN(exceptionId)) {
    res.status(400).json({ error: "Invalid exceptionId" });
    return;
  }

  const {
    resolution_action,
    resolution_note,
    linked_os_record_type,
    linked_os_record_id,
    bill_fields,
  } = req.body as {
    resolution_action?: string;
    resolution_note?: string;
    linked_os_record_type?: string;
    linked_os_record_id?: number;
    bill_fields?: Record<string, unknown>;
  };

  const validActions = [
    "create_bill", "link_bill", "edit_bill", "create_credit_note",
    "link_payment", "timing_difference", "supplier_error", "excluded",
  ];
  if (!resolution_action || !validActions.includes(resolution_action)) {
    res.status(400).json({ error: `resolution_action must be one of: ${validActions.join(", ")}` });
    return;
  }

  if (resolution_action === "excluded" && (!resolution_note || !resolution_note.trim())) {
    res.status(400).json({ error: "resolution_note is required when resolution_action is 'excluded'" });
    return;
  }

  // Load exception (workspace check via session)
  const excRes = await db.query<{
    id: number; session_id: number; workspace_owner_id: string; match_id: number | null;
    exception_type: string; status: string; statement_data: unknown; os_data: unknown;
  }>(
    `SELECT sre.id, sre.session_id, sre.workspace_owner_id, sre.match_id,
            sre.exception_type, sre.status, sre.statement_data, sre.os_data
     FROM supplier_reconciliation_exceptions sre
     JOIN supplier_reconciliation_sessions srs ON srs.id = sre.session_id
     WHERE sre.id = $1 AND srs.workspace_owner_id = $2`,
    [exceptionId, wreq.workspaceOwnerId],
  );
  if (!excRes.rowCount) {
    res.status(404).json({ error: "Exception not found" });
    return;
  }
  const exc = excRes.rows[0];

  if (exc.status === "resolved") {
    res.status(409).json({ error: "Exception is already resolved" });
    return;
  }

  // Load session for supplier/entity context
  const sessRes = await db.query<{
    id: number; supplier_id: number; accounting_entity_month_id: number;
    workspace_owner_id: string; status: string;
  }>(
    `SELECT id, supplier_id, accounting_entity_month_id, workspace_owner_id, status
     FROM supplier_reconciliation_sessions WHERE id = $1`,
    [exc.session_id],
  );
  const sess = sessRes.rows[0];

  const callerUserId = authed(req).userId;
  let newBillId: number | null = null;

  // Action-specific processing
  if (resolution_action === "create_bill") {
    // Insert a new supplier_invoices row using statement entry data
    const stmtData = (exc.statement_data ?? {}) as Record<string, unknown>;
    const entryAmount = typeof stmtData.amount === "number" ? stmtData.amount : parseFloat(String(stmtData.amount ?? "0"));
    const entryCurrency = typeof stmtData.currency === "string" ? stmtData.currency : "USD";
    const entryDate = typeof stmtData.date === "string" ? stmtData.date : null;
    const entryRef = typeof stmtData.reference === "string" ? stmtData.reference : null;

    const billRes = await db.query<{ id: number }>(
      `INSERT INTO supplier_invoices
         (supplier_id, workspace_owner_id, amount, currency, status, invoice_number,
          issued_at, reconciliation_session_id, odoo_sync_status)
       VALUES ($1, $2, $3, $4, 'issued', $5, $6, $7, 'pending')
       RETURNING id`,
      [
        sess.supplier_id,
        wreq.workspaceOwnerId,
        Math.abs(entryAmount),
        entryCurrency,
        entryRef,
        entryDate ?? new Date().toISOString(),
        exc.session_id,
      ],
    );
    newBillId = billRes.rows[0].id;

  } else if (resolution_action === "link_bill" || resolution_action === "create_credit_note" || resolution_action === "link_payment") {
    // Validate the referenced OS record belongs to same supplier + workspace
    if (!linked_os_record_id) {
      res.status(400).json({ error: "linked_os_record_id is required for this resolution_action" });
      return;
    }
    if (resolution_action === "link_payment") {
      const pmtCheck = await db.query<{ id: number }>(
        `SELECT sip.id FROM supplier_invoice_payments sip
         JOIN supplier_invoices si ON si.id = sip.supplier_invoice_id
         WHERE sip.id = $1 AND si.supplier_id = $2 AND sip.workspace_owner_id = $3`,
        [linked_os_record_id, sess.supplier_id, wreq.workspaceOwnerId],
      );
      if (!pmtCheck.rowCount) {
        res.status(422).json({ error: "Payment not found or does not belong to this supplier" });
        return;
      }
    } else {
      // link_bill or create_credit_note — reference a supplier_invoices row
      const billCheck = await db.query<{ id: number }>(
        `SELECT id FROM supplier_invoices
         WHERE id = $1 AND supplier_id = $2 AND workspace_owner_id = $3`,
        [linked_os_record_id, sess.supplier_id, wreq.workspaceOwnerId],
      );
      if (!billCheck.rowCount) {
        res.status(422).json({ error: "Bill not found or does not belong to this supplier" });
        return;
      }
    }

  } else if (resolution_action === "edit_bill") {
    if (!linked_os_record_id) {
      res.status(400).json({ error: "linked_os_record_id is required for edit_bill" });
      return;
    }
    if (!hasFinanceAccounting(wreq)) {
      res.status(403).json({ error: "Supplier invoice edit permission required" });
      return;
    }
    // Validate the bill belongs to this supplier/workspace and apply field changes
    const billCheck = await db.query<{ id: number }>(
      `SELECT id FROM supplier_invoices WHERE id = $1 AND supplier_id = $2 AND workspace_owner_id = $3`,
      [linked_os_record_id, sess.supplier_id, wreq.workspaceOwnerId],
    );
    if (!billCheck.rowCount) {
      res.status(422).json({ error: "Bill not found or does not belong to this supplier" });
      return;
    }
    if (bill_fields && Object.keys(bill_fields).length > 0) {
      // Apply only safe editable fields
      const allowed = ["amount", "currency", "invoice_number", "issued_at", "due_date", "notes", "vat_amount", "grand_total"];
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [key, val] of Object.entries(bill_fields)) {
        if (allowed.includes(key)) {
          vals.push(val);
          sets.push(`${key} = $${vals.length}`);
        }
      }
      if (sets.length > 0) {
        vals.push(linked_os_record_id);
        await db.query(
          `UPDATE supplier_invoices SET ${sets.join(", ")}, updated_at = now() WHERE id = $${vals.length}`,
          vals,
        );
      }
    }
  }

  // Mark exception resolved
  await db.query(
    `UPDATE supplier_reconciliation_exceptions
     SET status = 'resolved', resolution_action = $1, resolution_note = $2,
         resolved_by = $3, resolved_at = now(),
         linked_os_record_type = COALESCE($4, linked_os_record_type),
         linked_os_record_id = COALESCE($5, linked_os_record_id),
         updated_at = now()
     WHERE id = $6`,
    [
      resolution_action,
      resolution_note ?? null,
      callerUserId,
      linked_os_record_type ?? null,
      linked_os_record_id ?? newBillId ?? null,
      exceptionId,
    ],
  );

  // Update parent match row to manually_resolved if it exists
  if (exc.match_id) {
    await db.query(
      `UPDATE supplier_reconciliation_matches
       SET match_type = 'manually_resolved', resolved_by = $1, resolved_at = now(), updated_at = now()
       WHERE id = $2`,
      [callerUserId, exc.match_id],
    );
  }

  // Recompute open_exceptions_count
  const openCount = await recomputeOpenExceptions(exc.session_id);

  await appendAudit(exc.session_id, wreq.workspaceOwnerId, callerUserId, "exception_resolved", {
    exception_id: exceptionId,
    exception_type: exc.exception_type,
    resolution_action,
    resolution_note: resolution_note ?? null,
    linked_os_record_type: linked_os_record_type ?? null,
    linked_os_record_id: linked_os_record_id ?? newBillId ?? null,
    new_bill_id: newBillId,
    open_exceptions_remaining: openCount,
  });

  res.json({
    ok: true,
    exception_id: exceptionId,
    status: "resolved",
    new_bill_id: newBillId,
    open_exceptions_count: openCount,
  });
});

// ── PATCH /accounting/supplier-reconciliation/matches/:matchId/confirm ─────────

router.patch("/accounting/supplier-reconciliation/matches/:matchId/confirm", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccounting(wreq)) {
    res.status(403).json({ error: "Finance & Accounting access required" });
    return;
  }

  const matchId = parseInt(req.params.matchId, 10);
  if (isNaN(matchId)) {
    res.status(400).json({ error: "Invalid matchId" });
    return;
  }

  const { confirmed } = req.body as { confirmed?: boolean };
  if (typeof confirmed !== "boolean") {
    res.status(400).json({ error: "confirmed (boolean) is required" });
    return;
  }

  // Load match (workspace check via session)
  const matchRes = await db.query<{
    id: number; session_id: number; match_type: string;
    statement_entry_id: number | null; os_record_type: string | null; os_record_id: number | null;
  }>(
    `SELECT srm.id, srm.session_id, srm.match_type, srm.statement_entry_id,
            srm.os_record_type, srm.os_record_id
     FROM supplier_reconciliation_matches srm
     JOIN supplier_reconciliation_sessions srs ON srs.id = srm.session_id
     WHERE srm.id = $1 AND srs.workspace_owner_id = $2`,
    [matchId, wreq.workspaceOwnerId],
  );
  if (!matchRes.rowCount) {
    res.status(404).json({ error: "Match not found" });
    return;
  }
  const match = matchRes.rows[0];

  if (match.match_type !== "possible") {
    res.status(409).json({ error: "Only possible matches can be confirmed or rejected" });
    return;
  }

  // Load session for workspace_owner_id
  const sessRes = await db.query<{ id: number; workspace_owner_id: string }>(
    `SELECT id, workspace_owner_id FROM supplier_reconciliation_sessions WHERE id = $1`,
    [match.session_id],
  );
  const sess = sessRes.rows[0];

  const callerUserId = authed(req).userId;

  if (confirmed) {
    // Promote to matched
    await db.query(
      `UPDATE supplier_reconciliation_matches
       SET match_type = 'matched', resolved_by = $1, resolved_at = now(), updated_at = now()
       WHERE id = $2`,
      [callerUserId, matchId],
    );
    // Close related possible_match exception
    await db.query(
      `UPDATE supplier_reconciliation_exceptions
       SET status = 'resolved', resolution_action = 'confirmed', resolved_by = $1, resolved_at = now(), updated_at = now()
       WHERE match_id = $2 AND exception_type = 'possible_match' AND status = 'open'`,
      [callerUserId, matchId],
    );
    await appendAudit(match.session_id, sess.workspace_owner_id, callerUserId, "match_confirmed", {
      match_id: matchId,
      os_record_type: match.os_record_type,
      os_record_id: match.os_record_id,
    });
  } else {
    // Reject: set unmatched, create missing_in_os exception
    await db.query(
      `UPDATE supplier_reconciliation_matches
       SET match_type = 'unmatched', updated_at = now()
       WHERE id = $2`,
      [matchId],
    );
    // Close possible_match exception
    await db.query(
      `UPDATE supplier_reconciliation_exceptions
       SET status = 'resolved', resolution_action = 'rejected', resolved_by = $1, resolved_at = now(), updated_at = now()
       WHERE match_id = $2 AND exception_type = 'possible_match' AND status = 'open'`,
      [callerUserId, matchId],
    );
    // Get statement entry data for the missing_in_os exception
    let stmtData: Record<string, unknown> = {};
    if (match.statement_entry_id) {
      const entryRes = await db.query<{
        reference_number: string | null; amount: string; entry_date: string | null;
      }>(
        `SELECT reference_number, amount, entry_date FROM supplier_statement_entries WHERE id = $1`,
        [match.statement_entry_id],
      );
      if (entryRes.rowCount) {
        const e = entryRes.rows[0];
        stmtData = { entry_id: match.statement_entry_id, reference: e.reference_number, amount: parseFloat(e.amount), date: e.entry_date };
      }
    }
    await db.query(
      `INSERT INTO supplier_reconciliation_exceptions
         (session_id, workspace_owner_id, match_id, exception_type, status, statement_data)
       VALUES ($1, $2, $3, 'missing_in_os', 'open', $4)`,
      [match.session_id, sess.workspace_owner_id, matchId, JSON.stringify(stmtData)],
    );
    await appendAudit(match.session_id, sess.workspace_owner_id, callerUserId, "match_rejected", {
      match_id: matchId,
      os_record_type: match.os_record_type,
      os_record_id: match.os_record_id,
    });
  }

  const openCount = await recomputeOpenExceptions(match.session_id);

  res.json({ ok: true, match_id: matchId, confirmed, open_exceptions_count: openCount });
});

// ── POST /accounting/supplier-reconciliation/sessions/:sessionId/accept-difference ─

router.post("/accounting/supplier-reconciliation/sessions/:sessionId/accept-difference", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceManager(wreq)) {
    res.status(403).json({ error: "Finance Manager permission required" });
    return;
  }

  const sessionId = parseInt(req.params.sessionId, 10);
  if (isNaN(sessionId)) {
    res.status(400).json({ error: "Invalid sessionId" });
    return;
  }

  const { reason } = req.body as { reason?: string };
  if (!reason || !reason.trim()) {
    res.status(400).json({ error: "reason is required" });
    return;
  }

  const sessRes = await db.query<{ id: number; workspace_owner_id: string; balance_difference: string | null }>(
    `SELECT id, workspace_owner_id, balance_difference
     FROM supplier_reconciliation_sessions WHERE id = $1 AND workspace_owner_id = $2`,
    [sessionId, wreq.workspaceOwnerId],
  );
  if (!sessRes.rowCount) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  await db.query(
    `UPDATE supplier_reconciliation_sessions
     SET difference_accepted_reason = $1, updated_at = now()
     WHERE id = $2`,
    [reason.trim(), sessionId],
  );

  const callerUserId = authed(req).userId;
  await appendAudit(sessionId, wreq.workspaceOwnerId, callerUserId, "difference_accepted", {
    reason: reason.trim(),
    balance_difference: sessRes.rows[0].balance_difference,
  });

  res.json({ ok: true, session_id: sessionId, difference_accepted_reason: reason.trim() });
});

// ── POST /accounting/supplier-reconciliation/sessions/:sessionId/complete ──────

router.post("/accounting/supplier-reconciliation/sessions/:sessionId/complete", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccounting(wreq)) {
    res.status(403).json({ error: "Finance & Accounting access required" });
    return;
  }

  const sessionId = parseInt(req.params.sessionId, 10);
  if (isNaN(sessionId)) {
    res.status(400).json({ error: "Invalid sessionId" });
    return;
  }

  const sessRes = await db.query<{
    id: number; supplier_id: number; accounting_entity_month_id: number;
    workspace_owner_id: string; status: string;
    balance_difference: string | null; difference_accepted_reason: string | null;
    open_exceptions_count: number;
    statement_balance: string | null; os_balance: string | null;
  }>(
    `SELECT id, supplier_id, accounting_entity_month_id, workspace_owner_id, status,
            balance_difference, difference_accepted_reason, open_exceptions_count,
            statement_balance, os_balance
     FROM supplier_reconciliation_sessions WHERE id = $1 AND workspace_owner_id = $2`,
    [sessionId, wreq.workspaceOwnerId],
  );
  if (!sessRes.rowCount) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  const sess = sessRes.rows[0];

  // Gate: statement must be present
  const stmtCheck = await db.query<{ id: string }>(
    `SELECT id FROM supplier_statements
     WHERE supplier_id = $1 AND accounting_entity_month_id = $2 AND workspace_owner_id = $3
       AND replaced_by IS NULL
     LIMIT 1`,
    [sess.supplier_id, sess.accounting_entity_month_id, wreq.workspaceOwnerId],
  );
  if (!stmtCheck.rowCount) {
    res.status(422).json({ error: "A statement must be uploaded and extracted before completing the reconciliation" });
    return;
  }

  // Gate: all exceptions must be resolved or accepted
  const openExc = await db.query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt FROM supplier_reconciliation_exceptions
     WHERE session_id = $1 AND status = 'open'`,
    [sessionId],
  );
  const openCount = parseInt(openExc.rows[0]?.cnt ?? "0", 10);
  if (openCount > 0) {
    res.status(422).json({ error: `All exceptions must be resolved before completing. ${openCount} open exception(s) remain.` });
    return;
  }

  // Gate: balance difference must be zero or accepted
  const balDiff = parseFloat(sess.balance_difference ?? "0");
  if (Math.abs(balDiff) > 0.001 && !sess.difference_accepted_reason) {
    res.status(422).json({
      error: "Balance difference must be zero or accepted (POST .../accept-difference) before completing",
      balance_difference: balDiff,
    });
    return;
  }

  const callerUserId = authed(req).userId;
  const now = new Date().toISOString();

  // Set status = reconciled, prepared_by, prepared_at
  await db.query(
    `UPDATE supplier_reconciliation_sessions
     SET status = 'reconciled', prepared_by = $1, prepared_at = $2, updated_at = now()
     WHERE id = $3`,
    [callerUserId, now, sessionId],
  );

  await appendAudit(sessionId, wreq.workspaceOwnerId, callerUserId, "session_completed", {
    prepared_by: callerUserId,
    prepared_at: now,
    open_exceptions: 0,
    balance_difference: balDiff,
    difference_accepted: !!sess.difference_accepted_reason,
  });

  // Check workspace separation-of-duties setting
  const wsSettings = await db.query<{ require_approval_separation: boolean | null }>(
    `SELECT require_approval_separation FROM workspace_settings WHERE workspace_owner_id = $1`,
    [wreq.workspaceOwnerId],
  );
  const separationRequired = wsSettings.rows[0]?.require_approval_separation ?? false;

  let finalStatus = "reconciled";

  if (!separationRequired) {
    // No separation of duties: also advance to ready_to_sync inline
    const approvedAt = new Date().toISOString();
    await db.query(
      `UPDATE supplier_reconciliation_sessions
       SET status = 'ready_to_sync', approved_by = $1, approved_at = $2, updated_at = now()
       WHERE id = $3`,
      [callerUserId, approvedAt, sessionId],
    );

    // Queue OS bills for Odoo sync
    const billsRes = await db.query<{
      id: number; supplier_id: number; currency: string; amount: string;
      invoice_number: string | null; issued_at: string | null;
    }>(
      `SELECT si.id, si.supplier_id, si.currency, si.amount, si.invoice_number, si.issued_at
       FROM supplier_invoices si
       WHERE si.reconciliation_session_id = $1
         AND si.status IN ('issued', 'approved', 'open')
         AND (si.odoo_sync_idempotency_key IS NULL)
         AND si.odoo_sync_status = 'pending'`,
      [sessionId],
    );

    for (const bill of billsRes.rows) {
      const idemKey = `${wreq.workspaceOwnerId}-${bill.supplier_id}-${bill.id}-${sess.accounting_entity_month_id}`;
      await db.query(
        `UPDATE supplier_invoices SET odoo_sync_idempotency_key = $1, odoo_sync_status = 'queued', updated_at = now()
         WHERE id = $2 AND odoo_sync_idempotency_key IS NULL`,
        [idemKey, bill.id],
      );
    }

    await appendAudit(sessionId, wreq.workspaceOwnerId, callerUserId, "session_approved", {
      approved_by: callerUserId,
      approved_at: approvedAt,
      bills_queued: billsRes.rows.length,
      auto_approved: true,
    });

    finalStatus = "ready_to_sync";
  }

  res.json({
    ok: true,
    session_id: sessionId,
    status: finalStatus,
    prepared_by: callerUserId,
    prepared_at: now,
    auto_approved: !separationRequired,
  });
});

// ── POST /accounting/supplier-reconciliation/sessions/:sessionId/approve ───────

router.post("/accounting/supplier-reconciliation/sessions/:sessionId/approve", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceManager(wreq)) {
    res.status(403).json({ error: "Finance Manager permission required" });
    return;
  }

  const sessionId = parseInt(req.params.sessionId, 10);
  if (isNaN(sessionId)) {
    res.status(400).json({ error: "Invalid sessionId" });
    return;
  }

  const sessRes = await db.query<{
    id: number; supplier_id: number; accounting_entity_month_id: number;
    workspace_owner_id: string; status: string;
  }>(
    `SELECT id, supplier_id, accounting_entity_month_id, workspace_owner_id, status
     FROM supplier_reconciliation_sessions WHERE id = $1 AND workspace_owner_id = $2`,
    [sessionId, wreq.workspaceOwnerId],
  );
  if (!sessRes.rowCount) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  const sess = sessRes.rows[0];

  if (sess.status !== "reconciled" && sess.status !== "ready_to_sync") {
    res.status(422).json({ error: "Session must be in 'reconciled' status before approving" });
    return;
  }

  const callerUserId = authed(req).userId;
  const approvedAt = new Date().toISOString();

  await db.query(
    `UPDATE supplier_reconciliation_sessions
     SET status = 'ready_to_sync', approved_by = $1, approved_at = $2, updated_at = now()
     WHERE id = $3`,
    [callerUserId, approvedAt, sessionId],
  );

  // Collect OS bills linked to this session (matched/resolved) in approved state without idempotency key
  const billsRes = await db.query<{
    id: number; supplier_id: number; currency: string; amount: string;
    invoice_number: string | null; issued_at: string | null;
  }>(
    `SELECT si.id, si.supplier_id, si.currency, si.amount, si.invoice_number, si.issued_at
     FROM supplier_invoices si
     WHERE si.reconciliation_session_id = $1
       AND si.status IN ('issued', 'approved', 'open')
       AND (si.odoo_sync_idempotency_key IS NULL)
       AND si.odoo_sync_status = 'pending'`,
    [sessionId],
  );

  let billsQueued = 0;
  for (const bill of billsRes.rows) {
    const idemKey = `${wreq.workspaceOwnerId}-${bill.supplier_id}-${bill.id}-${sess.accounting_entity_month_id}`;
    const updated = await db.query(
      `UPDATE supplier_invoices SET odoo_sync_idempotency_key = $1, odoo_sync_status = 'queued', updated_at = now()
       WHERE id = $2 AND odoo_sync_idempotency_key IS NULL`,
      [idemKey, bill.id],
    );
    if ((updated.rowCount ?? 0) > 0) billsQueued++;
  }

  await appendAudit(sessionId, wreq.workspaceOwnerId, callerUserId, "session_approved", {
    approved_by: callerUserId,
    approved_at: approvedAt,
    bills_queued: billsQueued,
  });

  res.json({
    ok: true,
    session_id: sessionId,
    status: "ready_to_sync",
    approved_by: callerUserId,
    approved_at: approvedAt,
    bills_queued: billsQueued,
  });
});

// ── POST /accounting/supplier-reconciliation/sessions/:sessionId/sync-to-odoo ──

router.post("/accounting/supplier-reconciliation/sessions/:sessionId/sync-to-odoo", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceManager(wreq)) {
    res.status(403).json({ error: "Finance Manager permission required" });
    return;
  }

  const sessionId = parseInt(req.params.sessionId, 10);
  if (isNaN(sessionId)) {
    res.status(400).json({ error: "Invalid sessionId" });
    return;
  }

  const sessRes = await db.query<{
    id: number; supplier_id: number; accounting_entity_month_id: number;
    workspace_owner_id: string; status: string;
  }>(
    `SELECT id, supplier_id, accounting_entity_month_id, workspace_owner_id, status
     FROM supplier_reconciliation_sessions WHERE id = $1 AND workspace_owner_id = $2`,
    [sessionId, wreq.workspaceOwnerId],
  );
  if (!sessRes.rowCount) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  const sess = sessRes.rows[0];

  if (sess.status !== "ready_to_sync" && sess.status !== "sync_failed") {
    res.status(422).json({ error: "Session must be in 'ready_to_sync' or 'sync_failed' status to sync" });
    return;
  }

  // Load entity for connector config
  const entityRes = await db.query<{
    id: number; accounting_system: string;
    odoo_base_url: string | null; odoo_database: string | null; odoo_integration_token: string | null;
    odoo_company_id: number | null; odoo_company_name: string | null;
  }>(
    `SELECT fe.id, fe.accounting_system, fe.odoo_base_url, fe.odoo_database,
            fe.odoo_integration_token, fe.odoo_company_id, fe.odoo_company_name
     FROM finance_entities fe
     JOIN accounting_entity_months aem ON aem.entity_id = fe.id
     WHERE aem.id = $1 AND fe.workspace_owner_id = $2
     LIMIT 1`,
    [sess.accounting_entity_month_id, wreq.workspaceOwnerId],
  );
  if (!entityRes.rowCount) {
    res.status(404).json({ error: "Finance entity not found for this session" });
    return;
  }
  const entity = entityRes.rows[0];
  const connector = createConnector(entity);

  // Load supplier info
  const supplierRes = await db.query<{
    id: number; name: string; display_name: string | null;
    tax_number: string | null; billing_address: string | null;
  }>(
    `SELECT id, name, display_name, tax_number, billing_address
     FROM suppliers WHERE id = $1 AND workspace_owner_id = $2`,
    [sess.supplier_id, wreq.workspaceOwnerId],
  );
  const supplier = supplierRes.rows[0];

  // Find all queued bills for this session
  const billsRes = await db.query<{
    id: number; amount: string; currency: string;
    invoice_number: string | null; issued_at: string | null; due_date: string | null;
    vat_amount: string | null; grand_total: string | null; subtotal: string | null;
    line_items: unknown; odoo_sync_idempotency_key: string; supplier_id: number;
  }>(
    `SELECT id, supplier_id, amount, currency, invoice_number, issued_at, due_date,
            vat_amount, grand_total, subtotal, line_items, odoo_sync_idempotency_key
     FROM supplier_invoices
     WHERE reconciliation_session_id = $1 AND odoo_sync_status = 'queued'`,
    [sessionId],
  );

  const callerUserId = authed(req).userId;
  let syncedCount = 0;
  let failedCount = 0;

  for (const bill of billsRes.rows) {
    const totalAmount = bill.grand_total ? parseFloat(bill.grand_total) : parseFloat(bill.amount);
    const data = {
      supplier_id: bill.supplier_id,
      vendor_name: supplier?.display_name ?? supplier?.name ?? null,
      vendor_tax_number: supplier?.tax_number ?? null,
      vendor_address: supplier?.billing_address ?? null,
      invoice_number: bill.invoice_number,
      invoice_date: bill.issued_at ? bill.issued_at.substring(0, 10) : null,
      due_date: bill.due_date ? String(bill.due_date).substring(0, 10) : null,
      currency: bill.currency,
      subtotal: bill.subtotal ? parseFloat(bill.subtotal) : totalAmount,
      discount: null,
      tax_amount: bill.vat_amount ? parseFloat(bill.vat_amount) : null,
      total_amount: totalAmount,
      line_items: Array.isArray(bill.line_items) ? (bill.line_items as import("../lib/finance/accountingConnector.js").InvoiceLineItem[]) : [],
      confidence: 1,
      raw_ai_json: {},
      company_validation_status: "unknown" as const,
      company_validation_notes: null,
      billing_country: null,
    };

    try {
      const result = await connector.createDraftVendorBill(entity.id, bill.id, data, "", {
        workspaceOwnerId: wreq.workspaceOwnerId,
      });
      if (result.success) {
        if (result.provider_supplier_id) {
          await db.query(
            `UPDATE suppliers s
                SET odoo_partner_id=$1, updated_at=now()
              WHERE s.id=$2
                AND s.workspace_owner_id=$3
                AND (s.odoo_partner_id IS NULL OR s.odoo_partner_id=$1)
                AND NOT EXISTS (
                  SELECT 1 FROM suppliers other
                   WHERE other.workspace_owner_id=s.workspace_owner_id
                     AND other.odoo_partner_id=$1
                     AND other.id<>s.id
                )`,
            [result.provider_supplier_id, bill.supplier_id, wreq.workspaceOwnerId],
          );
        }
        await db.query(
          `UPDATE supplier_invoices
           SET odoo_sync_status = 'synced', odoo_bill_id = $1, odoo_bill_url = $2,
               odoo_synced_at = now(), odoo_sync_error = NULL, updated_at = now()
           WHERE id = $3`,
          [result.provider_bill_id ?? null, result.provider_bill_url ?? null, bill.id],
        );
        syncedCount++;
        await appendAudit(sessionId, wreq.workspaceOwnerId, callerUserId, "bill_synced_to_odoo", {
          bill_id: bill.id,
          invoice_number: bill.invoice_number,
          odoo_bill_id: result.provider_bill_id,
          idempotency_key: bill.odoo_sync_idempotency_key,
        });
      } else {
        await db.query(
          `UPDATE supplier_invoices
           SET odoo_sync_status = 'sync_failed', odoo_sync_error = $1, updated_at = now()
           WHERE id = $2`,
          [result.error ?? "Unknown Odoo error", bill.id],
        );
        failedCount++;
        await appendAudit(sessionId, wreq.workspaceOwnerId, callerUserId, "bill_sync_failed", {
          bill_id: bill.id,
          invoice_number: bill.invoice_number,
          error: result.error,
        });
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Network error";
      await db.query(
        `UPDATE supplier_invoices
         SET odoo_sync_status = 'sync_failed', odoo_sync_error = $1, updated_at = now()
         WHERE id = $2`,
        [errMsg, bill.id],
      );
      failedCount++;
      await appendAudit(sessionId, wreq.workspaceOwnerId, callerUserId, "bill_sync_failed", {
        bill_id: bill.id,
        invoice_number: bill.invoice_number,
        error: errMsg,
      });
    }
  }

  // Update session status
  const finalStatus = failedCount === 0 && billsRes.rows.length > 0 ? "synced"
    : failedCount > 0 ? "sync_failed"
    : "synced"; // no bills to sync = synced
  await db.query(
    `UPDATE supplier_reconciliation_sessions SET status = $1, updated_at = now() WHERE id = $2`,
    [finalStatus, sessionId],
  );

  await appendAudit(sessionId, wreq.workspaceOwnerId, callerUserId, "sync_completed", {
    total_bills: billsRes.rows.length,
    synced: syncedCount,
    failed: failedCount,
    final_status: finalStatus,
  });

  res.json({
    ok: true,
    session_id: sessionId,
    status: finalStatus,
    total_bills: billsRes.rows.length,
    synced: syncedCount,
    failed: failedCount,
  });
});

// ── POST /accounting/supplier-reconciliation/sessions/:sessionId/reopen ────────

router.post("/accounting/supplier-reconciliation/sessions/:sessionId/reopen", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceManager(wreq)) {
    res.status(403).json({ error: "Finance Manager permission required" });
    return;
  }

  const sessionId = parseInt(req.params.sessionId, 10);
  if (isNaN(sessionId)) {
    res.status(400).json({ error: "Invalid sessionId" });
    return;
  }

  const { reason, force } = req.body as { reason?: string; force?: boolean };
  if (!reason || !reason.trim()) {
    res.status(400).json({ error: "reason is required to reopen a session" });
    return;
  }

  const sessRes = await db.query<{
    id: number; workspace_owner_id: string; status: string;
  }>(
    `SELECT id, workspace_owner_id, status
     FROM supplier_reconciliation_sessions WHERE id = $1 AND workspace_owner_id = $2`,
    [sessionId, wreq.workspaceOwnerId],
  );
  if (!sessRes.rowCount) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  const sess = sessRes.rows[0];

  // If session is synced, require force: true
  if (sess.status === "synced" && !force) {
    res.status(409).json({
      error: "Session has already been synced to Odoo. To reopen, pass force: true. Note: existing Odoo bills must be manually reversed outside OS.",
      requires_force: true,
    });
    return;
  }

  const callerUserId = authed(req).userId;
  const reopenedAt = new Date().toISOString();

  await db.query(
    `UPDATE supplier_reconciliation_sessions
     SET status = 'needs_review',
         reopen_reason = $1,
         last_reopened_at = $2,
         last_reopened_by = $3,
         prepared_at = NULL,
         approved_at = NULL,
         approved_by = NULL,
         updated_at = now()
     WHERE id = $4`,
    [reason.trim(), reopenedAt, callerUserId, sessionId],
  );

  // Reset queued (not yet synced) bills back to pending
  const resetRes = await db.query(
    `UPDATE supplier_invoices
     SET odoo_sync_status = 'pending', odoo_sync_idempotency_key = NULL, updated_at = now()
     WHERE reconciliation_session_id = $1 AND odoo_sync_status = 'queued'`,
    [sessionId],
  );

  await appendAudit(sessionId, wreq.workspaceOwnerId, callerUserId, "session_reopened", {
    reason: reason.trim(),
    previous_status: sess.status,
    forced: force === true,
    queued_bills_reset: resetRes.rowCount ?? 0,
  });

  res.json({
    ok: true,
    session_id: sessionId,
    status: "needs_review",
    reopen_reason: reason.trim(),
    last_reopened_at: reopenedAt,
    queued_bills_reset: resetRes.rowCount ?? 0,
    warning: sess.status === "synced"
      ? "Session was previously synced. Existing Odoo bills must be manually reversed outside OS."
      : undefined,
  });
});

// ── GET /accounting/supplier-reconciliation/sessions/:sessionId/audit ──────────

router.get("/accounting/supplier-reconciliation/sessions/:sessionId/audit", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccounting(wreq)) {
    res.status(403).json({ error: "Finance & Accounting access required" });
    return;
  }

  const sessionId = parseInt(req.params.sessionId, 10);
  if (isNaN(sessionId)) {
    res.status(400).json({ error: "Invalid sessionId" });
    return;
  }

  // Verify session belongs to workspace
  const sessCheck = await db.query<{ id: number }>(
    `SELECT id FROM supplier_reconciliation_sessions WHERE id = $1 AND workspace_owner_id = $2`,
    [sessionId, wreq.workspaceOwnerId],
  );
  if (!sessCheck.rowCount) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const auditRes = await db.query(
    `SELECT id, session_id, actor, action, detail, created_at
     FROM supplier_reconciliation_audit
     WHERE session_id = $1
     ORDER BY created_at DESC`,
    [sessionId],
  );

  res.json({ session_id: sessionId, audit: auditRes.rows });
});

// ── GET /accounting/supplier-reconciliation/statements/:statementId/download ──

router.get("/accounting/supplier-reconciliation/statements/:statementId/download", async (req, res) => {
  const wreq = workspace(req);
  if (!hasFinanceAccounting(wreq)) {
    res.status(403).json({ error: "Finance & Accounting access required" });
    return;
  }

  const statementId = req.params.statementId;
  if (!statementId || !/^[0-9a-f-]{36}$/.test(statementId)) {
    res.status(400).json({ error: "Invalid statementId" });
    return;
  }

  const stmtRes = await db.query<{
    id: string; workspace_owner_id: string; file_url: string;
    original_file_name: string; mime_type: string | null;
  }>(
    `SELECT id, workspace_owner_id, file_url, original_file_name, mime_type
     FROM supplier_statements WHERE id = $1 AND workspace_owner_id = $2`,
    [statementId, wreq.workspaceOwnerId],
  );
  if (!stmtRes.rowCount) {
    res.status(404).json({ error: "Statement not found" });
    return;
  }
  const stmt = stmtRes.rows[0];

  try {
    const objFile = await objectStorageService.getObjectEntityFile(stmt.file_url);
    const [fileBuffer, metadata] = await Promise.all([objFile.download(), objFile.getMetadata()]);
    const contentType = (metadata[0]?.contentType as string | undefined) ?? stmt.mime_type ?? "application/octet-stream";
    const safeFileName = encodeURIComponent(stmt.original_file_name);
    res.set("Content-Type", contentType);
    res.set("Content-Disposition", `attachment; filename="${safeFileName}"`);
    if (fileBuffer[0]) {
      res.set("Content-Length", String((fileBuffer[0] as Buffer).length));
    }
    res.send(fileBuffer[0]);
  } catch (err) {
    logger.error({ err, fileUrl: stmt.file_url }, "supplier-recon: failed to stream statement file");
    res.status(404).json({ error: "Statement file not found in storage" });
  }
});

export default router;
