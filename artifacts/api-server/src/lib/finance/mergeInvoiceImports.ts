export type MergeInvoiceRow = {
  id: number;
  workspace_owner_id: string;
  entity_id: number;
  supplier_id?: number | null;
  supplier_odoo_partner_id?: number | string | null;
  vendor_name?: string | null;
  vendor_tax_number?: string | null;
  invoice_number?: string | null;
  invoice_date?: string | null;
  currency?: string | null;
  subtotal?: string | number | null;
  tax_amount?: string | number | null;
  total_amount?: string | number | null;
  line_items?: unknown;
  raw_ai_json?: unknown;
  extraction_evidence?: unknown;
  source_batch_id?: string | null;
  source_page_number?: number | null;
  source_page_count?: number | null;
  pdf_storage_path?: string | null;
  original_filename?: string | null;
  source_metadata?: Record<string, unknown> | null;
  superseded_by_import_id?: number | null;
  provider_bill_id?: string | null;
  odoo_bill_id?: string | null;
  provider_sync_status?: string | null;
  sync_status?: string | null;
  trusted_supplier_matches?: Array<{
    supplier_id: number | string;
    odoo_partner_id: number | string;
  }> | null;
};

export type MergeDecision =
  | { status: "not_eligible"; reason: string }
  | { status: "review_required"; reason: "Needs multi-page invoice review" }
  | {
      status: "merged";
      canonicalId: number;
      supersededIds: number[];
      lineItems: unknown[];
      subtotal: number;
      taxAmount: number;
      totalAmount: number;
      finalPageId: number;
      supplierId: number | null;
    };

const money = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const normalized = (value: unknown) => String(value ?? "").trim().toUpperCase().replace(/\s+/g, " ");
const normalizedTax = (value: unknown) => String(value ?? "").replace(/[^A-Z0-9]/gi, "").toUpperCase();
const rounded = (value: number) => Math.round((value + Number.EPSILON) * 10000) / 10000;
const normalizedDate = (value: unknown) => {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const match = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  return match ? `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}` : normalized(raw);
};

function hasExplicitFinalTotal(row: MergeInvoiceRow): boolean {
  const raw = row.raw_ai_json;
  const evidence = row.extraction_evidence;
  const rawLabel = raw && typeof raw === "object"
    ? (raw as Record<string, unknown>).total_label
    : undefined;
  const evidenceLabel = evidence && typeof evidence === "object"
    ? (evidence as Record<string, unknown>).total_label
    : undefined;
  const label = rawLabel ?? evidenceLabel;
  if (typeof label !== "string") return false;
  const normalizedLabel = label.trim().replace(/\s*:\s*$/, "").replace(/\s+/g, " ").toUpperCase();
  return normalizedLabel === "TOTAL" || normalizedLabel === "GRAND TOTAL" || normalizedLabel === "AMOUNT DUE";
}

function hasReconciledFinalTotal(row: MergeInvoiceRow): boolean {
  const total = money(row.total_amount);
  const subtotal = money(row.subtotal);
  const tax = money(row.tax_amount);
  if (total !== null && subtotal !== null && tax !== null && tax >= 0 && Math.abs(rounded(subtotal + tax) - rounded(total)) <= 0.02) return true;
  if (total === null) return false;
  const lineSubtotal = rounded((Array.isArray(row.line_items) ? row.line_items : []).reduce<number>((sum, raw) => {
    const line = raw as Record<string, unknown>;
    return sum + (money(line.total) ?? ((money(line.quantity) ?? 0) * (money(line.unit_price) ?? 0)));
  }, 0));
  return tax !== null && tax >= 0 && Math.abs(rounded(lineSubtotal + tax) - rounded(total)) <= 0.02;
}

function isFinalPage(row: MergeInvoiceRow): boolean {
  return row.source_page_number != null
    && row.source_page_count != null
    && row.source_page_number === row.source_page_count;
}

function hasProviderBill(row: MergeInvoiceRow): boolean {
  const hasRealReference = [row.provider_bill_id, row.odoo_bill_id]
    .map((value) => String(value ?? "").trim())
    .some((reference) => !!reference && reference !== "no-accounting-destination");
  return hasRealReference
    || row.provider_sync_status === "succeeded"
    || row.sync_status === "succeeded";
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function reconcileTrustedSupplierIdentity(rows: MergeInvoiceRow[]): MergeInvoiceRow[] {
  const evidence = rows.map((row) => {
    const direct = positiveInteger(row.supplier_odoo_partner_id);
    if (direct) return new Set([direct]);
    return new Set((row.trusted_supplier_matches ?? [])
      .map((match) => positiveInteger(match.odoo_partner_id))
      .filter((id): id is number => id !== null));
  });
  if (evidence.some((ids) => ids.size === 0)) return rows;
  const intersection = [...evidence[0]].filter((id) => evidence.every((ids) => ids.has(id)));
  if (intersection.length !== 1) return rows;
  const canonicalPartnerId = intersection[0];
  const supplierIds = new Set(rows.flatMap((row) => {
    const direct = positiveInteger(row.supplier_odoo_partner_id);
    if (direct === canonicalPartnerId) {
      const supplierId = positiveInteger(row.supplier_id);
      return supplierId ? [supplierId] : [];
    }
    return (row.trusted_supplier_matches ?? [])
      .filter((match) => positiveInteger(match.odoo_partner_id) === canonicalPartnerId)
      .map((match) => positiveInteger(match.supplier_id))
      .filter((id): id is number => id !== null);
  }));
  const canonicalSupplierId = supplierIds.size === 1 ? [...supplierIds][0] : null;
  const hasIndirectIdentity = rows.some((row) => positiveInteger(row.supplier_odoo_partner_id) === null);
  if (hasIndirectIdentity && canonicalSupplierId === null) return rows;
  return rows.map((row) => ({
    ...row,
    supplier_odoo_partner_id: canonicalPartnerId,
    supplier_id: hasIndirectIdentity ? canonicalSupplierId : row.supplier_id,
  }));
}

function isSummaryLine(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const description = normalized((value as Record<string, unknown>).description)
    .replace(/\s*:\s*$/, "");
  return [
    "NET TOTAL",
    "SUBTOTAL",
    "TAX",
    "TAX TOTAL",
    "VAT",
    "GRAND TOTAL",
    "AMOUNT DUE",
  ].includes(description);
}

/**
 * Pure, fail-closed decision logic for split invoice pages. Persistence is
 * intentionally kept in the route so the existing DB transaction/audit path
 * remains the source of truth.
 */
export function evaluateMultiPageMerge(rows: MergeInvoiceRow[]): MergeDecision {
  const activeCandidates = rows
    .filter((row) => !row.superseded_by_import_id)
    .sort((a, b) => (a.source_page_number ?? Number.MAX_SAFE_INTEGER) - (b.source_page_number ?? Number.MAX_SAFE_INTEGER) || a.id - b.id);
  const candidates = reconcileTrustedSupplierIdentity(activeCandidates);
  if (candidates.length < 2) return { status: "not_eligible", reason: "At least two source pages are required" };
  if (candidates.some((row) => hasProviderBill(row))) return { status: "not_eligible", reason: "Authoritative synced invoices are immutable" };
  const first = candidates[0];
  if (candidates.some((row) => row.workspace_owner_id !== first.workspace_owner_id || row.entity_id !== first.entity_id)) {
    return { status: "not_eligible", reason: "Workspace/entity differs" };
  }
  const number = normalized(first.invoice_number);
  const currency = normalized(first.currency);
  if (!number || !currency || candidates.some((row) => normalized(row.invoice_number) !== number || normalized(row.currency) !== currency)) {
    return { status: "not_eligible", reason: "Invoice number or currency differs" };
  }
  const dates = new Set(candidates.map((row) => normalizedDate(row.invoice_date)).filter(Boolean));
  const supplierIds = new Set(candidates.map((row) => row.supplier_id).filter((id): id is number => Number.isInteger(id)));
  const supplierOdooPartnerIds = new Set(candidates
    .map((row) => Number(row.supplier_odoo_partner_id))
    .filter((id) => Number.isInteger(id) && id > 0));
  const sameSupplierId = supplierIds.size === 1
    && candidates.every((row) => Number.isInteger(row.supplier_id) && supplierIds.has(row.supplier_id as number));
  const sameSupplierOdooPartner = supplierOdooPartnerIds.size === 1
    && candidates.every((row) => Number.isInteger(Number(row.supplier_odoo_partner_id))
      && Number(row.supplier_odoo_partner_id) > 0
      && supplierOdooPartnerIds.has(Number(row.supplier_odoo_partner_id)));
  if (!sameSupplierId && !sameSupplierOdooPartner) {
    return { status: "not_eligible", reason: "Supplier identity differs" };
  }
  const taxes = new Set(candidates.map((row) => normalizedTax(row.vendor_tax_number)).filter(Boolean));
  if (taxes.size > 1) return { status: "not_eligible", reason: "Supplier tax identity differs" };
  const batchIds = new Set(candidates.map((row) => String(row.source_batch_id ?? "").trim()).filter(Boolean));
  if (batchIds.size > 1) {
    return { status: "not_eligible", reason: "Source page provenance differs" };
  }
  const sourceKeys = candidates.map((row) => String(row.pdf_storage_path ?? row.original_filename ?? "").trim()).filter(Boolean);
  if (sourceKeys.length !== candidates.length || new Set(sourceKeys).size !== sourceKeys.length) {
    return { status: "not_eligible", reason: "Distinct source documents are required" };
  }
  const pageCounts = new Set(candidates.map((row) => row.source_page_count));
  const pageCount = first.source_page_count;
  const pageNumbers = candidates.map((row) => row.source_page_number);
  const completePages = batchIds.size === 1
    && Number.isInteger(pageCount)
    && (pageCount as number) > 0
    && pageCounts.size === 1
    && candidates.length === pageCount
    && pageNumbers.every((page) => Number.isInteger(page) && (page as number) >= 1 && (page as number) <= (pageCount as number))
    && new Set(pageNumbers).size === pageCount
    && Array.from({ length: pageCount as number }, (_, index) => index + 1).every((page) => pageNumbers.includes(page));
  const allPageMetadataMissing = candidates.every((row) =>
    !String(row.source_batch_id ?? "").trim()
    && row.source_page_number == null
    && row.source_page_count == null,
  );
  if (dates.size > 1) {
    return { status: "not_eligible", reason: "Invoice date differs" };
  }
  if (!completePages && !allPageMetadataMissing) {
    const hasPartialPageMetadata = candidates.some((row) =>
      String(row.source_batch_id ?? "").trim()
      || row.source_page_number != null
      || row.source_page_count != null,
    );
    if (hasPartialPageMetadata) return { status: "review_required", reason: "Needs multi-page invoice review" };
  }
  const finalPages = candidates.filter(isFinalPage);
  if (completePages && finalPages.length !== 1) return { status: "review_required", reason: "Needs multi-page invoice review" };
  const totals = candidates.map((row) => money(row.total_amount)).filter((value): value is number => value !== null);
  const distinctTotals = new Set(totals.map((value) => rounded(value)));
  const largest = candidates.reduce((best, row) => (money(row.total_amount) ?? -Infinity) > (money(best.total_amount) ?? -Infinity) ? row : best, first);
  const supportedFinalRows = candidates.filter((row) => isFinalPage(row) || hasExplicitFinalTotal(row) || hasReconciledFinalTotal(row));
  const finalPage = finalPages[0] ?? supportedFinalRows.sort((a, b) => (money(b.total_amount) ?? -Infinity) - (money(a.total_amount) ?? -Infinity))[0];
  // Outside a complete source batch, matching identifiers alone are not
  // sufficient: require explicit final-total evidence on the larger record.
  if (!completePages && (!finalPage || finalPage.id !== largest.id || !hasExplicitFinalTotal(finalPage) && !hasReconciledFinalTotal(finalPage) && !isFinalPage(finalPage))) {
    return { status: "review_required", reason: "Needs multi-page invoice review" };
  }
  if (!finalPage) return { status: "review_required", reason: "Needs multi-page invoice review" };
  if (distinctTotals.size > 1 && !hasExplicitFinalTotal(finalPage) && !hasReconciledFinalTotal(finalPage) && !isFinalPage(finalPage)) {
    return { status: "review_required", reason: "Needs multi-page invoice review" };
  }
  const total = money(finalPage.total_amount);
  if (total === null) return { status: "review_required", reason: "Needs multi-page invoice review" };
  if (completePages && totals.some((candidateTotal) => candidateTotal > total + 0.02)) {
    return { status: "review_required", reason: "Needs multi-page invoice review" };
  }

  let lines: unknown[] = [];
  for (const row of candidates) {
    for (const line of Array.isArray(row.line_items) ? row.line_items : []) {
      lines.push(line);
    }
  }
  const lineSubtotal = (candidateLines: unknown[]) => rounded(candidateLines.reduce<number>((sum, line) => {
    const item = line as Record<string, unknown>;
    const explicit = money(item.total);
    return sum + (explicit ?? ((money(item.quantity) ?? 0) * (money(item.unit_price) ?? 0)));
  }, 0));
  let calculatedSubtotal = lineSubtotal(lines);
  const tax = money(finalPage.tax_amount) ?? rounded(total - calculatedSubtotal);
  // In a complete page batch, an extracted page subtotal can describe only
  // that page. The de-duplicated combined lines are the invoice subtotal.
  const declaredSubtotal = completePages
    ? calculatedSubtotal
    : money(finalPage.subtotal) ?? rounded(total - tax);
  // Historical scans can extract a printed final-page summary as a line. Drop
  // only explicit summary labels, and only when that exact removal reconciles
  // all remaining source lines to the authoritative final subtotal.
  if (!completePages && Math.abs(calculatedSubtotal - declaredSubtotal) > 0.02) {
    const withoutExplicitSummaries = candidates.flatMap((row) =>
      (Array.isArray(row.line_items) ? row.line_items : [])
        .filter((line) => row.id !== finalPage.id || !isSummaryLine(line)));
    if (withoutExplicitSummaries.length < lines.length
      && Math.abs(lineSubtotal(withoutExplicitSummaries) - declaredSubtotal) <= 0.02) {
      lines = withoutExplicitSummaries;
      calculatedSubtotal = lineSubtotal(lines);
    }
  }
  if (
    Math.abs(calculatedSubtotal - declaredSubtotal) > 0.02
    || Math.abs(rounded(declaredSubtotal + tax) - rounded(total)) > 0.02
  ) {
    return { status: "review_required", reason: "Needs multi-page invoice review" };
  }
  const subtotal = calculatedSubtotal;
  if (tax < 0 || (completePages && Math.abs(rounded(subtotal + tax) - rounded(total)) > 0.02)) {
    return { status: "review_required", reason: "Needs multi-page invoice review" };
  }
  return {
    status: "merged",
    canonicalId: finalPage.id,
    supersededIds: candidates.filter((row) => row.id !== finalPage.id).map((row) => row.id),
    lineItems: lines,
    subtotal,
    taxAmount: tax,
    totalAmount: total,
    finalPageId: finalPage.id,
    supplierId: finalPage.supplier_id
      ?? candidates.find((row) => Number.isInteger(Number(row.supplier_odoo_partner_id))
        && Number(row.supplier_odoo_partner_id) > 0)?.supplier_id
      ?? candidates.find((row) => Number.isInteger(row.supplier_id))?.supplier_id
      ?? null,
  };
}
