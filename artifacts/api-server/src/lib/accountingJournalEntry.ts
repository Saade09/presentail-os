import { db } from "./db.js";

export type AccountConfig = {
  code: string;
  name: string;
};

export type SourceAccountCodes = {
  sales_revenue: AccountConfig;
  output_vat: AccountConfig;
  refunds: AccountConfig;
  receivable: AccountConfig;
  cash: AccountConfig;
  fees: AccountConfig;
  fx_gains_losses: AccountConfig;
  over_short: AccountConfig;
};

export const DEFAULT_ACCOUNT_CODES: SourceAccountCodes = {
  sales_revenue:   { code: "4000", name: "Sales Revenue" },
  output_vat:      { code: "2200", name: "Output VAT Liability" },
  refunds:         { code: "4010", name: "Sales Refunds" },
  receivable:      { code: "1200", name: "Accounts Receivable" },
  cash:            { code: "1010", name: "Cash & Cash Equivalents" },
  fees:            { code: "6500", name: "Processing Fees" },
  fx_gains_losses: { code: "7100", name: "FX Gains / Losses" },
  over_short:      { code: "6900", name: "Cash Over / Short" },
};

export type SourceConfig = {
  vat_rate?: number;
  vat_inclusive?: boolean;
  accounts?: Partial<SourceAccountCodes>;
  [key: string]: unknown;
};

export type JournalLine = {
  accountCode: string;
  accountName: string;
  description: string;
  lineType: string;
  currency: string;
  exchangeRate: number;
  debitCents: number;
  creditCents: number;
  reportingDebitCents: number;
  reportingCreditCents: number;
  sourceId: number | null;
  sourceName: string | null;
};

export type GenerateJournalEntryResult = {
  journalEntryId: number;
  lines: JournalLine[];
  isBalanced: boolean;
  totalDebitCents: number;
  totalCreditCents: number;
  imbalanceCents: number;
  sourcesProcessed: number;
};

type SourceMonthRow = {
  id: number;
  source_id: number;
  source_name: string;
  source_type: string;
  source_config: unknown;
  sales_amount_cents: number | null;
  refunds_amount_cents: number | null;
  net_activity_cents: number | null;
  status: string;
  sales_status: string;
};

function getAccounts(cfg: SourceConfig): SourceAccountCodes {
  const custom = cfg.accounts ?? {};
  return {
    sales_revenue:   { ...DEFAULT_ACCOUNT_CODES.sales_revenue,   ...(custom.sales_revenue ?? {}) },
    output_vat:      { ...DEFAULT_ACCOUNT_CODES.output_vat,      ...(custom.output_vat ?? {}) },
    refunds:         { ...DEFAULT_ACCOUNT_CODES.refunds,          ...(custom.refunds ?? {}) },
    receivable:      { ...DEFAULT_ACCOUNT_CODES.receivable,       ...(custom.receivable ?? {}) },
    cash:            { ...DEFAULT_ACCOUNT_CODES.cash,             ...(custom.cash ?? {}) },
    fees:            { ...DEFAULT_ACCOUNT_CODES.fees,             ...(custom.fees ?? {}) },
    fx_gains_losses: { ...DEFAULT_ACCOUNT_CODES.fx_gains_losses,  ...(custom.fx_gains_losses ?? {}) },
    over_short:      { ...DEFAULT_ACCOUNT_CODES.over_short,       ...(custom.over_short ?? {}) },
  };
}

function computeVatAmount(grossInclCents: number, vatRate: number): number {
  if (vatRate <= 0 || grossInclCents === 0) return 0;
  return Math.round((grossInclCents * vatRate) / (100 + vatRate));
}

export async function generateJournalEntry(
  entityMonthId: number,
  workspaceOwnerId: string,
  callerUserId: string,
): Promise<GenerateJournalEntryResult> {
  // 1. Verify entity-month belongs to workspace
  const emRes = await db.query<{
    id: number;
    accounting_month_id: number;
    entity_id: number;
    workspace_owner_id: string;
    year: number;
    month: number;
  }>(
    `SELECT aem.id, aem.accounting_month_id, aem.entity_id, am.workspace_owner_id, am.year, am.month
     FROM accounting_entity_months aem
     JOIN accounting_months am ON am.id = aem.accounting_month_id
     WHERE aem.id = $1 AND am.workspace_owner_id = $2`,
    [entityMonthId, workspaceOwnerId],
  );
  if (!emRes.rowCount || emRes.rowCount === 0) {
    throw new Error("Entity month not found");
  }
  const em = emRes.rows[0];

  // 2. Load all source months for this entity month
  const smRes = await db.query<SourceMonthRow>(
    `SELECT asm.id, asm.source_id, asrc.name as source_name, asrc.source_type,
            asrc.config as source_config,
            asm.sales_amount_cents, asm.refunds_amount_cents, asm.net_activity_cents,
            asm.status, asm.sales_status
     FROM accounting_source_months asm
     JOIN accounting_sources asrc ON asrc.id = asm.source_id
     WHERE asm.accounting_entity_month_id = $1
     ORDER BY asrc.sort_order`,
    [entityMonthId],
  );

  const lines: JournalLine[] = [];

  for (const sm of smRes.rows) {
    const cfg = (sm.source_config ?? {}) as SourceConfig;
    const accts = getAccounts(cfg);
    const vatRate = cfg.vat_rate ?? 0;
    const vatInclusive = cfg.vat_inclusive !== false; // default: VAT-inclusive

    const salesCents = sm.sales_amount_cents ?? 0;
    const refundsCents = Math.abs(sm.refunds_amount_cents ?? 0);

    // Fees: sum from source_statement_lines where line_type in ('stripe_fee', 'fee', 'commission')
    const feesRes = await db.query<{ total: string }>(
      `SELECT COALESCE(SUM(ABS(amount_cents)), 0) as total
       FROM source_statement_lines
       WHERE source_month_id = $1 AND line_type IN ('stripe_fee', 'fee', 'commission', 'processing_fee')`,
      [sm.id],
    );
    const feesCents = parseInt(feesRes.rows[0]?.total ?? "0", 10);

    // Over/short from net_activity vs (sales - refunds - fees)
    const computedNet = salesCents - refundsCents - feesCents;
    const actualNet = sm.net_activity_cents ?? computedNet;
    const overShortCents = actualNet - computedNet;

    if (salesCents === 0 && refundsCents === 0 && feesCents === 0) {
      continue;
    }

    // VAT calculations
    const salesVatCents = vatInclusive ? computeVatAmount(salesCents, vatRate) : 0;
    const salesExclVatCents = salesCents - salesVatCents;
    const refundVatCents = vatInclusive ? computeVatAmount(refundsCents, vatRate) : 0;

    const currency = "USD"; // all amounts stored in USD equivalent
    const exchangeRate = 1;
    const sourceName = sm.source_name;
    const sourceId = sm.source_id;

    // Determine whether this source uses cash (retail_cash) or receivable
    const isCash = sm.source_type === "retail_cash" || sm.source_type === "cash";
    const receivableAcct = isCash ? accts.cash : accts.receivable;

    // DR Cash/Receivable: actual net activity
    if (actualNet !== 0) {
      lines.push({
        accountCode: receivableAcct.code,
        accountName: receivableAcct.name,
        description: `${sourceName} — net collections`,
        lineType: isCash ? "cash" : "receivable",
        currency,
        exchangeRate,
        debitCents: Math.max(0, actualNet),
        creditCents: Math.max(0, -actualNet),
        reportingDebitCents: Math.max(0, actualNet),
        reportingCreditCents: Math.max(0, -actualNet),
        sourceId,
        sourceName,
      });
    }

    // DR Refunds expense (excl VAT portion)
    if (refundsCents - refundVatCents > 0) {
      lines.push({
        accountCode: accts.refunds.code,
        accountName: accts.refunds.name,
        description: `${sourceName} — refunds`,
        lineType: "refunds",
        currency,
        exchangeRate,
        debitCents: refundsCents - refundVatCents,
        creditCents: 0,
        reportingDebitCents: refundsCents - refundVatCents,
        reportingCreditCents: 0,
        sourceId,
        sourceName,
      });
    }

    // DR Refund VAT adjustment (reduces output VAT)
    if (refundVatCents > 0) {
      lines.push({
        accountCode: accts.output_vat.code,
        accountName: accts.output_vat.name,
        description: `${sourceName} — VAT on refunds (adj)`,
        lineType: "refund_vat_adj",
        currency,
        exchangeRate,
        debitCents: refundVatCents,
        creditCents: 0,
        reportingDebitCents: refundVatCents,
        reportingCreditCents: 0,
        sourceId,
        sourceName,
      });
    }

    // DR Fees expense
    if (feesCents > 0) {
      lines.push({
        accountCode: accts.fees.code,
        accountName: accts.fees.name,
        description: `${sourceName} — processing fees`,
        lineType: "fees",
        currency,
        exchangeRate,
        debitCents: feesCents,
        creditCents: 0,
        reportingDebitCents: feesCents,
        reportingCreditCents: 0,
        sourceId,
        sourceName,
      });
    }

    // CR Sales Revenue (excl VAT)
    if (salesExclVatCents !== 0) {
      lines.push({
        accountCode: accts.sales_revenue.code,
        accountName: accts.sales_revenue.name,
        description: `${sourceName} — sales revenue`,
        lineType: "sales_revenue",
        currency,
        exchangeRate,
        debitCents: 0,
        creditCents: Math.max(0, salesExclVatCents),
        reportingDebitCents: 0,
        reportingCreditCents: Math.max(0, salesExclVatCents),
        sourceId,
        sourceName,
      });
    }

    // CR Output VAT
    if (salesVatCents > 0) {
      lines.push({
        accountCode: accts.output_vat.code,
        accountName: accts.output_vat.name,
        description: `${sourceName} — output VAT ${vatRate}%`,
        lineType: "output_vat",
        currency,
        exchangeRate,
        debitCents: 0,
        creditCents: salesVatCents,
        reportingDebitCents: 0,
        reportingCreditCents: salesVatCents,
        sourceId,
        sourceName,
      });
    }

    // Over/Short adjustment line
    if (overShortCents !== 0) {
      lines.push({
        accountCode: accts.over_short.code,
        accountName: accts.over_short.name,
        description: `${sourceName} — cash ${overShortCents > 0 ? "over" : "short"}`,
        lineType: "over_short",
        currency,
        exchangeRate,
        debitCents: overShortCents < 0 ? Math.abs(overShortCents) : 0,
        creditCents: overShortCents > 0 ? overShortCents : 0,
        reportingDebitCents: overShortCents < 0 ? Math.abs(overShortCents) : 0,
        reportingCreditCents: overShortCents > 0 ? overShortCents : 0,
        sourceId,
        sourceName,
      });
    }
  }

  // 3. Compute totals and check balance
  const totalDebitCents = lines.reduce((s, l) => s + l.debitCents, 0);
  const totalCreditCents = lines.reduce((s, l) => s + l.creditCents, 0);
  const imbalanceCents = totalDebitCents - totalCreditCents;
  const isBalanced = imbalanceCents === 0;

  const description = `Journal entry for ${em.year}-${String(em.month).padStart(2, "0")}`;

  // 4. Upsert journal_entry_drafts (one per entity month, replace on regenerate)
  // First, find existing draft for this entity month
  const existingRes = await db.query<{ id: number; status: string }>(
    `SELECT id, status FROM journal_entry_drafts WHERE accounting_entity_month_id = $1`,
    [entityMonthId],
  );

  let journalEntryId: number;

  if (existingRes.rowCount && existingRes.rowCount > 0) {
    const existing = existingRes.rows[0];
    if (existing.status === "approved") {
      throw new Error("Cannot regenerate an approved journal entry");
    }
    // Delete lines and update header
    await db.query(`DELETE FROM journal_entry_lines WHERE journal_entry_id = $1`, [existing.id]);
    await db.query(
      `UPDATE journal_entry_drafts
       SET description = $1, status = 'draft', is_balanced = $2, updated_at = now(),
           approved_by = NULL, approved_at = NULL
       WHERE id = $3`,
      [description, isBalanced, existing.id],
    );
    journalEntryId = existing.id;
  } else {
    const insRes = await db.query<{ id: number }>(
      `INSERT INTO journal_entry_drafts
         (workspace_owner_id, accounting_month_id, accounting_entity_month_id,
          description, status, created_by, is_balanced, currency, reporting_currency)
       VALUES ($1, $2, $3, $4, 'draft', $5, $6, 'USD', 'USD')
       RETURNING id`,
      [workspaceOwnerId, em.accounting_month_id, entityMonthId, description, callerUserId, isBalanced],
    );
    journalEntryId = insRes.rows[0].id;
  }

  // 5. Insert lines
  for (const line of lines) {
    await db.query(
      `INSERT INTO journal_entry_lines
         (journal_entry_id, account_code, account_name, description, line_type,
          currency, exchange_rate, debit_cents, credit_cents,
          reporting_debit_cents, reporting_credit_cents, source_id, source_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        journalEntryId,
        line.accountCode,
        line.accountName,
        line.description,
        line.lineType,
        line.currency,
        line.exchangeRate,
        line.debitCents,
        line.creditCents,
        line.reportingDebitCents,
        line.reportingCreditCents,
        line.sourceId,
        line.sourceName,
      ],
    );
  }

  return {
    journalEntryId,
    lines,
    isBalanced,
    totalDebitCents,
    totalCreditCents,
    imbalanceCents,
    sourcesProcessed: smRes.rows.length,
  };
}

export type JournalEntryRow = {
  id: number;
  workspace_owner_id: string;
  accounting_month_id: number | null;
  accounting_entity_month_id: number | null;
  description: string;
  status: string;
  created_by: string;
  approved_by: string | null;
  approved_at: string | null;
  is_balanced: boolean;
  currency: string;
  reporting_currency: string;
  created_at: string;
  updated_at: string;
};

export type JournalLineRow = {
  id: number;
  journal_entry_id: number;
  account_code: string;
  account_name: string;
  description: string | null;
  line_type: string | null;
  currency: string;
  exchange_rate: string;
  debit_cents: number;
  credit_cents: number;
  reporting_debit_cents: number;
  reporting_credit_cents: number;
  source_id: number | null;
  source_name: string | null;
  created_at: string;
};

export async function getJournalEntry(
  entityMonthId: number,
  workspaceOwnerId: string,
): Promise<{ entry: JournalEntryRow; lines: JournalLineRow[] } | null> {
  const entryRes = await db.query<JournalEntryRow>(
    `SELECT jed.*
     FROM journal_entry_drafts jed
     JOIN accounting_entity_months aem ON aem.id = jed.accounting_entity_month_id
     JOIN accounting_months am ON am.id = aem.accounting_month_id
     WHERE jed.accounting_entity_month_id = $1 AND am.workspace_owner_id = $2`,
    [entityMonthId, workspaceOwnerId],
  );
  if (!entryRes.rowCount || entryRes.rowCount === 0) return null;

  const entry = entryRes.rows[0];
  const linesRes = await db.query<JournalLineRow>(
    `SELECT * FROM journal_entry_lines WHERE journal_entry_id = $1 ORDER BY id`,
    [entry.id],
  );
  return { entry, lines: linesRes.rows };
}
