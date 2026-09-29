export type AccountingSystem = "odoo" | "wafeq" | "manual" | "none";

export type InvoiceLineItem = {
  description: string;
  quantity: number;
  unit_price: number;
  total: number;
  /** Stable provider account identifier (used by Wafeq; optional for Odoo/manual). */
  external_account_id?: string | null;
  /** Review-only provider mapping; the Wafeq tax mapping is bill-level. */
  wafeq_account_id?: string | null;
  wafeq_tax_id?: string | null;
  tax_rate?: number;
  /** Odoo purchase-tax record resolved from tax_rate before draft-bill sync. */
  odoo_tax_id?: number | null;
  odoo_tax_ids?: number[];
  tax_id?: number | null;
  tax_ids?: number[];
  tax_rate_percent?: number | null;
  odoo_tax_rate?: number | null;
  account_code?: string;
  product_code?: string;
  evidence?: ExtractionEvidence | null;
};
export type ExtractionRegion = { page: number; x: number; y: number; width: number; height: number };
export type ExtractionEvidence = { confidence?: number | null; region?: ExtractionRegion | null };

export type ExtractedInvoiceData = {
  vendor_name: string | null;
  /** Exact approved legal/extracted names retained for immutable bill identity reconciliation. */
  vendor_aliases?: string[];
  /** Existing OS supplier selected during review or extraction. */
  supplier_id?: number | null;
  /** Original source filename persisted with the OS invoice upload. */
  source_filename?: string | null;
  /** MIME type persisted with the OS invoice upload. */
  source_content_type?: string | null;
  /** Existing provider identity to verify before marker/reference recovery. */
  provider_bill_id?: string | null;
  /** Exact Odoo supplier selected by the connector's close-name matcher. */
  partner_id?: number | null;
  odoo_partner_id?: number | null;
  odoo_supplier_match_score?: number | null;
  /** Stable provider supplier identifier (used by Wafeq; optional for Odoo/manual). */
  external_supplier_id?: string | null;
  /** One stable provider tax-rate identifier for the whole bill (used by Wafeq). */
  external_tax_rate_id?: string | null;
  /** Human-entered/manual accounting reference to preserve on provider bills. */
  manual_accounting_reference?: string | null;
  vendor_tax_number: string | null;
  vendor_address: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  currency: string;
  subtotal: number | null;
  discount: number | null;
  tax_amount: number | null;
  total_amount: number | null;
  line_items: InvoiceLineItem[];
  confidence: number;
  raw_ai_json: Record<string, unknown>;
  company_validation_status: "matched" | "mismatch" | "unknown";
  company_validation_notes: string | null;
  /** ISO 3166-1 alpha-2 country code inferred from the invoice (vendor address, tax number, currency, etc.) */
  billing_country: string | null;
  /** Provider evidence, validated before durable persistence. */
  extraction_evidence?: { fields: Record<string, ExtractionEvidence>; lines: Array<ExtractionEvidence | null>; coordinates_available: boolean };
};

export type DraftBillResult = {
  success: boolean;
  provider_bill_id?: string;
  provider_bill_url?: string;
  provider_bill_status?: string;
  provider_supplier_id?: number;
  provider_supplier_name?: string;
  provider_supplier_tax_number?: string | null;
  /** How the authoritative provider reconciliation completed. */
  outcome?: "created" | "recovered" | "verified_existing" | "repaired_existing" | "eligible_create";
  reason_code?: string;
  /** Non-blocking reconciliation facts retained for audit when provider state is authoritative. */
  warnings?: string[];
  supplier_candidates?: Array<{
    id: number;
    name: string;
    display_name?: string | null;
    tax_number?: string | null;
    score: number;
  }>;
  error?: string;
};

export type DraftBillOptions = {
  /** Resolve and verify existing records without calling provider create. */
  readOnly?: boolean;
  /** Workspace scope for the shared OS↔provider supplier resolver. */
  workspaceOwnerId?: string;
  /** Human-approved OS lines are authoritative even when header totals differ. */
  approvedValuesAuthoritative?: boolean;
};

export type SettingsSyncResult = {
  success: boolean;
  error?: string;
};

/** A single bank statement line passed to the Odoo sync method. */
export type BankStatementLine = {
  id: number;
  line_date: string | null;
  value_date: string | null;
  description: string | null;
  reference: string | null;
  debit_amount: string | null;
  credit_amount: string | null;
  balance: string | null;
  currency: string;
  /** Raw metadata stored on the line (may contain statement period, source filename, etc.) */
  metadata: Record<string, unknown>;
  /** Presentail's durable line fingerprint, used as the Odoo idempotency marker. */
  fingerprint?: string | null;
};

/** Per-line result returned from the Odoo bank statement sync. */
export type PerLineSyncResult = {
  lineId: number;
  success: boolean;
  odooRecordId?: string;
  odooRecordUrl?: string;
  odooIsReconciled?: boolean;
  odooMoveLineIds?: number[];
  error?: string;
};

export type OdooReconciliationState = {
  statementLineId: number;
  isReconciled: boolean;
  moveLineIds: number[];
  liquidityMoveLineIds: number[];
  unreconciledLiquidityMoveLineIds: number[];
  statementSideEligibleMoveLineIds: number[];
  unreconciledStatementSideEligibleMoveLineIds: number[];
  moveLineReconciled: boolean;
};

export interface AccountingConnector {
  readonly system: AccountingSystem;

  createDraftVendorBill(
    entityId: number,
    importId: number,
    data: ExtractedInvoiceData,
    pdfStoragePath: string,
    options?: DraftBillOptions,
  ): Promise<DraftBillResult>;

  getInvoiceStatus(
    providerBillId: string,
  ): Promise<{ status: string; url?: string } | null>;

  syncSettings(
    entityId: number,
    settings: Record<string, unknown>,
  ): Promise<SettingsSyncResult>;

  /**
   * Syncs a batch of bank statement lines to the given Odoo journal.
   * Returns a per-line result so partial failures can be surfaced individually.
   */
  syncBankStatementLines(
    entityId: number,
    journalId: number,
    lines: BankStatementLine[],
  ): Promise<PerLineSyncResult[]>;

  /** Read Odoo's authoritative reconciliation state without mutating it. */
  refreshOdooReconciliationState?(
    statementLineIds: number[],
  ): Promise<OdooReconciliationState[]>;

  /** Explicitly reconcile the exact journal items selected by a reviewer. */
  reconcileOdooMoveLines?(moveLineIds: number[]): Promise<unknown>;

  validateOdooMoveLineSelection?(moveLineIds: number[]): Promise<Array<{
    id: number;
    company_id: number | null;
    account_id: number | null;
    reconciled: boolean;
    reconcilable: boolean;
  }>>;
}
