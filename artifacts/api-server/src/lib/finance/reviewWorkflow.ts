/** Server-authoritative, content-local invoice review calculations. */
export type ReviewIssue = {
  issue_key: string; severity: "warning" | "error"; message: string;
  field?: string; blocking: boolean;
};

const NON_FIELD_BLOCKERS = new Set(["attachment.unavailable", "extraction.failed"]);
const ODOO_CANONICALLY_RESOLVABLE_ISSUES = new Set([
  "supplier.trn_mismatch",
  "supplier.unresolved",
  "extraction.failed",
]);

function isOdooResolvableIssue(issueKey: string): boolean {
  return ODOO_CANONICALLY_RESOLVABLE_ISSUES.has(issueKey)
    || issueKey.startsWith("account.unmapped.")
    || issueKey.startsWith("tax.unsupported.")
    || issueKey.startsWith("totals.")
    || issueKey === "source.total_mismatch";
}

type ReviewableInvoice = {
  vendor_name?: string | null; invoice_number?: string | null; invoice_date?: string | null;
  vendor_tax_number?: string | null; vendor_address?: string | null; due_date?: string | null;
  manual_accounting_reference?: string | null; billing_country?: string | null;
  currency?: string | null; subtotal?: string | number | null; tax_amount?: string | number | null;
  total_amount?: string | number | null; supplier_id?: number | null; line_items?: unknown;
  wafeq_supplier_id?: string | null; wafeq_account_id?: string | null; wafeq_tax_id?: string | null;
};
type WafeqTaxRate = { id?: string | number; external_id?: string | number; rate?: string | number | null };

const money = (value: unknown): number | null => {
  const numberValue = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
};

export function recalculateInvoice(invoice: ReviewableInvoice) {
  const lines = Array.isArray(invoice.line_items) ? invoice.line_items : [];
  let calculatedTax = 0;
  const recalculatedLines = lines.map((raw) => {
    const line = raw as Record<string, unknown>;
    const quantity = money(line.quantity) ?? 0;
    const unitPrice = money(line.unit_price) ?? 0;
    const total = Math.round(quantity * unitPrice * 10000) / 10000;
    const taxRate = money(line.tax_rate) ?? 0;
    calculatedTax += total * taxRate;
    return { ...line, quantity, unit_price: unitPrice, total };
  });
  const lineSubtotal = recalculatedLines.reduce((sum, line) => sum + Number(line.total), 0);
  const subtotal = money(invoice.subtotal);
  const taxAmount = money(invoice.tax_amount);
  const totalAmount = money(invoice.total_amount);
  return {
    line_subtotal: Math.round(lineSubtotal * 10000) / 10000,
    calculated_tax: Math.round(calculatedTax * 10000) / 10000,
    calculated_total: Math.round((lineSubtotal + calculatedTax) * 10000) / 10000,
    recalculated_lines: recalculatedLines,
    subtotal,
    tax_amount: taxAmount,
    total_amount: totalAmount,
  };
}

/** Never includes invoice content in logs or audit metadata. */
export function validateInvoice(invoice: ReviewableInvoice & { pdf_storage_path?: string | null; status?: string; processing_step?: string; sync_status?: string; vendor_tax_number?: string | null; company_validation_status?: string | null }, tolerance = 0.01, options?: { duplicate?: boolean; supportedTaxRates?: number[]; provider?: string; wafeqTaxRates?: WafeqTaxRate[] }): { totals: ReturnType<typeof recalculateInvoice>; issues: ReviewIssue[] } {
  const totals = recalculateInvoice(invoice);
  const issues: ReviewIssue[] = [];
  const lines = Array.isArray(invoice.line_items) ? invoice.line_items : [];
  const required: Array<[keyof ReviewableInvoice, string]> = [
    ["vendor_name", "Vendor is required"], ["invoice_number", "Invoice number is required"],
    ["invoice_date", "Invoice date is required"], ["currency", "Currency is required"],
    ["total_amount", "Total amount is required"],
  ];
  for (const [field, message] of required) {
    // For Odoo, an explicitly matched local supplier is the authoritative
    // vendor identity. OCR can leave vendor_name blank even though the
    // supplier has been resolved in the review workspace.
    const matchedOdooSupplier = field === "vendor_name"
      && options?.provider === "odoo"
      && invoice.supplier_id != null;
    if (!invoice[field] && !matchedOdooSupplier) {
      issues.push({ issue_key: `required.${field}`, severity: "error", message, field, blocking: true });
    }
  }
  if (!invoice.pdf_storage_path) issues.push({ issue_key: "attachment.unavailable", severity: "error", message: "Source attachment is unavailable", field: "source_document", blocking: true });
  if (lines.length === 0) issues.push({ issue_key: "line_items.required", severity: "error", message: "At least one invoice line is required", field: "line_items", blocking: true });
  if (invoice.status === "failed") issues.push({ issue_key: "extraction.failed", severity: "error", message: "Invoice extraction failed; upload a readable source document", field: "source_document", blocking: true });
  if (options?.duplicate) issues.push({ issue_key: "duplicate.risk", severity: "error", message: "A matching supplier invoice may already exist", blocking: true });
  if (invoice.company_validation_status === "mismatch") issues.push({ issue_key: "supplier.trn_mismatch", severity: "error", message: "Supplier tax registration does not match", field: "vendor_tax_number", blocking: true });
  const hasWafeqSupplierMapping = options?.provider === "wafeq" && String(invoice.wafeq_supplier_id ?? "").trim() !== "";
  if (!invoice.supplier_id && !hasWafeqSupplierMapping) {
    issues.push({ issue_key: "supplier.unresolved", severity: "error", message: "Supplier must be resolved before approval", field: "supplier_id", blocking: true });
  }
  if (options?.provider === "wafeq") {
    if (!String(invoice.wafeq_supplier_id ?? "").trim()) {
      issues.push({ issue_key: "wafeq.supplier.unmapped", severity: "error", message: "A Wafeq supplier mapping is required before approval", field: "wafeq_supplier_id", blocking: true });
    }
    const billTaxId = String(invoice.wafeq_tax_id ?? "").trim();
    if (!billTaxId) {
      issues.push({ issue_key: "wafeq.tax.unmapped", severity: "error", message: "A bill-level Wafeq tax mapping is required before approval", field: "wafeq_tax_id", blocking: true });
    }
    const isNoVat = billTaxId === "no_vat";
    const selectedTax = options?.wafeqTaxRates?.find((tax) =>
      String(tax.id ?? "").trim() === billTaxId || String(tax.external_id ?? "").trim() === billTaxId,
    );
    if (billTaxId && !isNoVat && options?.wafeqTaxRates && !selectedTax) {
      issues.push({ issue_key: "wafeq.tax.unmapped", severity: "error", message: "The selected Wafeq tax mapping is not available for this workspace", field: "wafeq_tax_id", blocking: true });
    }
    const rawRate = isNoVat ? 0 : selectedTax?.rate;
    const selectedRate = typeof rawRate === "number"
      ? rawRate
      : typeof rawRate === "string" && rawRate.trim() !== ""
        ? Number(rawRate)
        : null;
    const normalizedRate = selectedRate !== null && Number.isFinite(selectedRate) && selectedRate >= 0
      ? selectedRate > 1 ? selectedRate / 100 : selectedRate
      : null;
    if (selectedTax && (normalizedRate === null || !Number.isFinite(normalizedRate) || normalizedRate < 0 || normalizedRate > 1)) {
      issues.push({ issue_key: "wafeq.tax.rate_invalid", severity: "error", message: "The selected Wafeq tax mapping has an invalid rate", field: "wafeq_tax_id", blocking: true });
    }
    const roundedCurrency = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
    if (normalizedRate !== null && invoice.subtotal !== null && invoice.tax_amount !== null && invoice.total_amount !== null) {
      const subtotal = money(invoice.subtotal);
      const taxAmount = money(invoice.tax_amount);
      const totalAmount = money(invoice.total_amount);
      if (subtotal !== null && taxAmount !== null && totalAmount !== null) {
        const expectedTax = roundedCurrency(subtotal * normalizedRate);
        const expectedTotal = roundedCurrency(subtotal + expectedTax);
        if (Math.abs(roundedCurrency(taxAmount) - expectedTax) > tolerance) {
          issues.push({ issue_key: "wafeq.tax.amount_mismatch", severity: "error", message: "Tax amount does not match the selected Wafeq tax rate", field: "tax_amount", blocking: true });
        }
        if (Math.abs(roundedCurrency(totalAmount) - expectedTotal) > tolerance) {
          issues.push({ issue_key: "wafeq.total.amount_mismatch", severity: "error", message: "Invoice total does not match the selected Wafeq tax rate", field: "total_amount", blocking: true });
        }
      }
    }
    const billAccountId = String(invoice.wafeq_account_id ?? "").trim();
    for (const [index, raw] of (Array.isArray(invoice.line_items) ? invoice.line_items : []).entries()) {
      const line = raw as Record<string, unknown>;
      const accountId = String(line.wafeq_account_id ?? billAccountId).trim();
      if (!accountId) issues.push({ issue_key: `wafeq.account.unmapped.${index}`, severity: "error", message: `Line ${index + 1} needs a Wafeq account mapping`, field: `line_items.${index}.wafeq_account_id`, blocking: true });
    }
  }
  const requiresAccountCode = options?.provider === "odoo";
  if (totals.subtotal !== null && Math.abs(totals.subtotal - totals.line_subtotal) > tolerance) issues.push({ issue_key: "totals.lines", severity: "error", message: "Line items do not reconcile to subtotal", field: "line_items", blocking: true });
  if (totals.total_amount !== null && totals.subtotal !== null && totals.tax_amount !== null && Math.abs(totals.total_amount - totals.subtotal - totals.tax_amount) > tolerance) issues.push({ issue_key: "totals.invoice", severity: "error", message: "Subtotal and tax do not reconcile to total", field: "total_amount", blocking: true });
  if (totals.total_amount !== null && totals.subtotal === null && Math.abs(totals.total_amount - totals.calculated_total) > tolerance) issues.push({ issue_key: "totals.lines_to_total", severity: "error", message: "Line items and tax do not reconcile to invoice total", field: "line_items", blocking: true });
  for (const [index, raw] of lines.entries()) {
    const line = raw as Record<string, unknown>;
    const taxRate = money(line.tax_rate);
    if (!String(line.description ?? "").trim()) issues.push({ issue_key: `line.description.${index}`, severity: "error", message: `Line ${index + 1} needs a description`, field: `line_items.${index}`, blocking: true });
    if ((money(line.quantity) ?? 0) <= 0) issues.push({ issue_key: `line.quantity.${index}`, severity: "error", message: `Line ${index + 1} needs a valid quantity`, field: `line_items.${index}`, blocking: true });
    if ((money(line.unit_price) ?? -1) < 0) issues.push({ issue_key: `line.price.${index}`, severity: "error", message: `Line ${index + 1} needs a valid unit price`, field: `line_items.${index}`, blocking: true });
    if (requiresAccountCode && !String(line.account_code ?? "").trim()) {
      issues.push({ issue_key: `account.unmapped.${index}`, severity: "error", message: `Line ${index + 1} needs an account code`, field: `line_items.${index}.account_code`, blocking: true });
    }
    // Wafeq uses one bill-level tax mapping. Older imports can still carry
    // extracted line tax rates, but those hidden legacy values must not block
    // a review when the authoritative bill mapping is present.
    const usesAuthoritativeBillTax = options?.provider === "wafeq" && String(invoice.wafeq_tax_id ?? "").trim() !== "";
    if (!usesAuthoritativeBillTax && taxRate !== null && (!(options?.supportedTaxRates ?? [0, .05, .1, .11, .15, .2, 5, 10, 11, 15, 20]).some((rate) => Math.abs(rate - taxRate) < 0.0001))) issues.push({ issue_key: `tax.unsupported.${index}`, severity: "error", message: `Line ${index + 1} has an unsupported tax rate`, field: `line_items.${index}`, blocking: true });
  }
  // Odoo's canonical connector resolves suppliers, expense accounts, products,
  // and purchase taxes from live company data and accounting history. Local
  // review mappings are useful warnings, but must not reject an invoice before
  // that authoritative resolution has run.
  if (options?.provider === "odoo") {
    for (const issue of issues) {
      if (!isOdooResolvableIssue(issue.issue_key)) continue;
      issue.blocking = false;
      issue.severity = "warning";
    }
  }
  // Remote providers require complete, reconciled data before bill creation.
  // Manual/no-destination reviews may still be approved with warnings.
  if (options?.provider && options.provider !== "wafeq" && options.provider !== "odoo") {
    for (const issue of issues) {
      if (NON_FIELD_BLOCKERS.has(issue.issue_key)) continue;
      issue.blocking = false;
      issue.severity = "warning";
    }
  }
  return { totals, issues };
}

export function reviewSnapshot(invoice: ReviewableInvoice): Record<string, unknown> {
  const { vendor_name, vendor_tax_number, vendor_address, invoice_number, invoice_date, due_date, currency, manual_accounting_reference, billing_country, subtotal, tax_amount, total_amount, supplier_id, wafeq_supplier_id, wafeq_account_id, wafeq_tax_id, line_items } = invoice;
  return { vendor_name, vendor_tax_number, vendor_address, invoice_number, invoice_date, due_date, currency, manual_accounting_reference, billing_country, subtotal, tax_amount, total_amount, supplier_id, wafeq_supplier_id, wafeq_account_id, wafeq_tax_id, line_items };
}