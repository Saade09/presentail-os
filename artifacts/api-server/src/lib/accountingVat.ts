import { db } from "./db.js";
import type { SourceConfig } from "./accountingJournalEntry.js";

export type VatSummaryRow = {
  id: number;
  accounting_entity_month_id: number;
  source_id: number | null;
  source_name: string | null;
  currency: string;
  vat_rate: number;
  gross_incl_vat_cents: number;
  gross_excl_vat_cents: number;
  taxable_amount_cents: number;
  vat_amount_cents: number;
  refund_vat_cents: number;
  fees_cents: number;
  vat_on_fees_cents: number;
  reporting_currency: string;
  reporting_gross_incl_vat_cents: number;
  reporting_gross_excl_vat_cents: number;
  reporting_vat_amount_cents: number;
  reporting_refund_vat_cents: number;
  created_at: string;
  updated_at: string;
};

export type GenerateVatSummaryResult = {
  rows: Array<{
    sourceId: number;
    sourceName: string;
    currency: string;
    vatRate: number;
    grossInclVatCents: number;
    grossExclVatCents: number;
    vatAmountCents: number;
    refundVatCents: number;
    feesCents: number;
    vatOnFeesCents: number;
  }>;
  totalVatCents: number;
  totalGrossInclCents: number;
};

function extractVatAmount(grossIncl: number, vatRate: number): number {
  if (vatRate <= 0 || grossIncl <= 0) return 0;
  return Math.round((grossIncl * vatRate) / (100 + vatRate));
}

function addVatOnTop(net: number, vatRate: number): number {
  if (vatRate <= 0 || net <= 0) return 0;
  return Math.round((net * vatRate) / 100);
}

export async function generateVatSummary(
  entityMonthId: number,
  workspaceOwnerId: string,
): Promise<GenerateVatSummaryResult> {
  // Verify entity month belongs to workspace
  const emRes = await db.query<{ id: number }>(
    `SELECT aem.id
     FROM accounting_entity_months aem
     JOIN accounting_months am ON am.id = aem.accounting_month_id
     WHERE aem.id = $1 AND am.workspace_owner_id = $2`,
    [entityMonthId, workspaceOwnerId],
  );
  if (!emRes.rowCount || emRes.rowCount === 0) {
    throw new Error("Entity month not found");
  }

  // Load all source months
  type SmRow = {
    id: number;
    source_id: number;
    source_name: string;
    source_type: string;
    source_config: unknown;
    sales_amount_cents: number | null;
    refunds_amount_cents: number | null;
  };

  const smRes = await db.query<SmRow>(
    `SELECT asm.id, asm.source_id, asrc.name as source_name, asrc.source_type,
            asrc.config as source_config,
            asm.sales_amount_cents, asm.refunds_amount_cents
     FROM accounting_source_months asm
     JOIN accounting_sources asrc ON asrc.id = asm.source_id
     WHERE asm.accounting_entity_month_id = $1
     ORDER BY asrc.sort_order`,
    [entityMonthId],
  );

  // Delete existing VAT summaries for this entity month (full regeneration)
  await db.query(
    `DELETE FROM vat_summaries WHERE accounting_entity_month_id = $1`,
    [entityMonthId],
  );

  const rows: GenerateVatSummaryResult["rows"] = [];
  let totalVatCents = 0;
  let totalGrossInclCents = 0;

  for (const sm of smRes.rows) {
    const cfg = (sm.source_config ?? {}) as SourceConfig;
    const vatRate = cfg.vat_rate ?? 0;
    const vatInclusive = cfg.vat_inclusive !== false;

    const salesCents = sm.sales_amount_cents ?? 0;
    const refundsCents = Math.abs(sm.refunds_amount_cents ?? 0);

    // Fees
    const feesRes = await db.query<{ total: string }>(
      `SELECT COALESCE(SUM(ABS(amount_cents)), 0) as total
       FROM source_statement_lines
       WHERE source_month_id = $1 AND line_type IN ('stripe_fee', 'fee', 'commission', 'processing_fee')`,
      [sm.id],
    );
    const feesCents = parseInt(feesRes.rows[0]?.total ?? "0", 10);

    let grossInclVatCents: number;
    let vatAmountCents: number;
    let grossExclVatCents: number;

    if (vatInclusive) {
      grossInclVatCents = salesCents;
      vatAmountCents = extractVatAmount(salesCents, vatRate);
      grossExclVatCents = salesCents - vatAmountCents;
    } else {
      grossExclVatCents = salesCents;
      vatAmountCents = addVatOnTop(salesCents, vatRate);
      grossInclVatCents = salesCents + vatAmountCents;
    }

    const refundVatCents = vatInclusive
      ? extractVatAmount(refundsCents, vatRate)
      : addVatOnTop(refundsCents, vatRate);

    const vatOnFeesCents = 0; // fees typically zero-rated but configurable in future

    if (salesCents === 0 && refundsCents === 0 && feesCents === 0) {
      continue;
    }

    const row = {
      sourceId: sm.source_id,
      sourceName: sm.source_name,
      currency: "USD",
      vatRate,
      grossInclVatCents,
      grossExclVatCents,
      vatAmountCents,
      refundVatCents,
      feesCents,
      vatOnFeesCents,
    };
    rows.push(row);
    totalVatCents += vatAmountCents - refundVatCents;
    totalGrossInclCents += grossInclVatCents;

    // Persist row
    await db.query(
      `INSERT INTO vat_summaries
         (accounting_entity_month_id, source_id, source_name, currency, vat_rate,
          gross_incl_vat_cents, gross_excl_vat_cents, taxable_amount_cents, vat_amount_cents,
          refund_vat_cents, fees_cents, vat_on_fees_cents,
          reporting_currency, reporting_gross_incl_vat_cents, reporting_gross_excl_vat_cents,
          reporting_vat_amount_cents, reporting_refund_vat_cents)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
      [
        entityMonthId,
        sm.source_id,
        sm.source_name,
        "USD",
        vatRate,
        grossInclVatCents,
        grossExclVatCents,
        grossExclVatCents, // taxable = excl VAT
        vatAmountCents,
        refundVatCents,
        feesCents,
        vatOnFeesCents,
        "USD",
        grossInclVatCents, // reporting = same as original (all USD)
        grossExclVatCents,
        vatAmountCents,
        refundVatCents,
      ],
    );
  }

  return { rows, totalVatCents, totalGrossInclCents };
}

export async function getVatSummary(
  entityMonthId: number,
  workspaceOwnerId: string,
): Promise<VatSummaryRow[]> {
  const res = await db.query<VatSummaryRow>(
    `SELECT vs.*
     FROM vat_summaries vs
     JOIN accounting_entity_months aem ON aem.id = vs.accounting_entity_month_id
     JOIN accounting_months am ON am.id = aem.accounting_month_id
     WHERE vs.accounting_entity_month_id = $1 AND am.workspace_owner_id = $2
     ORDER BY vs.source_name`,
    [entityMonthId, workspaceOwnerId],
  );
  return res.rows;
}
