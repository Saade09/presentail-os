import type {
  AccountingConnector,
  AccountingSystem,
  BankStatementLine,
  DraftBillResult,
  ExtractedInvoiceData,
  PerLineSyncResult,
  SettingsSyncResult,
} from "./accountingConnector.js";
import { logger } from "../logger.js";
import { deterministicImportUuid, WafeqApiError, WafeqClient } from "./wafeqClient.js";

type WafeqConfig = {
  apiKey?: string | null;
  organizationId?: string | null;
  baseUrl?: string;
  timeoutMs?: number;
  client?: WafeqClient;
};

function cleanError(error: unknown): string {
  if (error instanceof WafeqApiError) return error.message;
  return "Wafeq request failed";
}

export class WafeqAccountingConnector implements AccountingConnector {
  readonly system: AccountingSystem = "wafeq";
  private readonly config: WafeqConfig;
  private readonly client: WafeqClient | null;

  constructor(config: WafeqConfig = {}) {
    this.config = { ...config, apiKey: config.apiKey };
    this.client = config.client ?? (this.config.apiKey ? new WafeqClient({
      apiKey: this.config.apiKey,
      baseUrl: config.baseUrl,
      timeoutMs: config.timeoutMs,
    }) : null);
  }

  async createDraftVendorBill(
    entityId: number,
    importId: number,
    data: ExtractedInvoiceData,
    _pdfStoragePath: string,
  ): Promise<DraftBillResult> {
    if (!this.client) return { success: false, error: "Wafeq integration is not configured" };
    try {
      if (this.config.organizationId) {
        const organization = await this.client.verifyOrganization();
        if (organization.id !== this.config.organizationId) return { success: false, error: "Wafeq organization does not match" };
      }

      if (!data.external_supplier_id) return { success: false, error: "Wafeq supplier mapping is required" };
      if (!data.external_tax_rate_id) return { success: false, error: "Wafeq tax-rate mapping is required" };
      if (data.line_items.some((line) => !line.external_account_id)) {
        return { success: false, error: "Wafeq expense account mapping is required for every line" };
      }

      const payload = {
        external_id: `presentail-import-${entityId}-${importId}`,
        status: "DRAFT",
        contact: data.external_supplier_id,
        bill_number: data.invoice_number ?? `PRESENTAIL-${importId}`,
        bill_date: data.invoice_date ?? new Date().toISOString().slice(0, 10),
        bill_due_date: data.due_date ?? data.invoice_date ?? new Date().toISOString().slice(0, 10),
        currency: data.currency,
        reference: data.manual_accounting_reference ?? "",
        line_items: data.line_items.map((line) => ({
          description: line.description,
          quantity: line.quantity,
          unit_amount: line.unit_price,
          account: line.external_account_id,
          // The review stores No VAT as a provider-neutral sentinel. Wafeq
          // expects an omitted/null tax relation for that treatment.
          tax_rate: data.external_tax_rate_id === "no_vat" ? null : data.external_tax_rate_id,
        })),
      };
      const bill = await this.client.createDraftBill(payload, deterministicImportUuid(entityId, importId));
      const providerUrl = [bill.url, bill.web_url, bill.bill_url].find((value): value is string =>
        typeof value === "string" && /^https:\/\/app\.wafeq\.com\//.test(value),
      );
      return {
        success: true,
        provider_bill_id: bill.id,
        provider_bill_url: providerUrl,
        provider_bill_status: bill.status,
      };
    } catch (error) {
      logger.warn({ entityId, importId, status: error instanceof WafeqApiError ? error.status : undefined }, "Wafeq bill creation failed");
      return { success: false, error: cleanError(error) };
    }
  }

  async getInvoiceStatus(providerBillId: string): Promise<{ status: string; url?: string } | null> {
    if (!this.client) return null;
    try {
      const bill = await this.client.retrieveBill(providerBillId);
      const providerUrl = [bill.url, bill.web_url, bill.bill_url].find((value): value is string =>
        typeof value === "string" && /^https:\/\/app\.wafeq\.com\//.test(value),
      );
      return { status: bill.status ?? "unknown", url: providerUrl };
    } catch {
      return null;
    }
  }

  async syncSettings(_entityId: number, _settings: Record<string, unknown>): Promise<SettingsSyncResult> {
    if (!this.client) return { success: false, error: "Wafeq integration is not configured" };
    try {
      await this.client.verifyOrganization();
      return { success: true };
    } catch (error) {
      return { success: false, error: cleanError(error) };
    }
  }

  async syncBankStatementLines(
    _entityId: number,
    _journalId: number,
    lines: BankStatementLine[],
  ): Promise<PerLineSyncResult[]> {
    return lines.map((line) => ({ lineId: line.id, success: false, error: "Wafeq bank statement sync is not supported" }));
  }
}

/** Short alias retained for callers that do not use the accounting prefix. */
export const WafeqConnector = WafeqAccountingConnector;