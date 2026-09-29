import type { AccountingConnector, AccountingSystem, BankStatementLine, DraftBillResult, ExtractedInvoiceData, PerLineSyncResult, SettingsSyncResult } from "./accountingConnector.js";

export class ManualAccountingConnector implements AccountingConnector {
  readonly system: AccountingSystem = "manual";

  async createDraftVendorBill(
    _entityId: number,
    _importId: number,
    _data: ExtractedInvoiceData,
    _pdfStoragePath: string,
  ): Promise<DraftBillResult> {
    return { success: true };
  }

  async getInvoiceStatus(_providerBillId: string): Promise<{ status: string; url?: string } | null> {
    return null;
  }

  async syncSettings(_entityId: number, _settings: Record<string, unknown>): Promise<SettingsSyncResult> {
    return { success: true };
  }

  async syncBankStatementLines(
    _entityId: number,
    _journalId: number,
    lines: BankStatementLine[],
  ): Promise<PerLineSyncResult[]> {
    // Manual connector: always succeeds with a stub record ID
    return lines.map((l) => ({
      lineId: l.id,
      success: true,
      odooRecordId: `manual-${l.id}`,
    }));
  }
}

export class NoopAccountingConnector implements AccountingConnector {
  readonly system: AccountingSystem = "none";

  async createDraftVendorBill(): Promise<DraftBillResult> {
    return { success: true };
  }

  async getInvoiceStatus(): Promise<null> {
    return null;
  }

  async syncSettings(): Promise<SettingsSyncResult> {
    return { success: true };
  }

  async syncBankStatementLines(
    _entityId: number,
    _journalId: number,
    lines: BankStatementLine[],
  ): Promise<PerLineSyncResult[]> {
    // Noop connector: always succeeds with a stub record ID
    return lines.map((l) => ({
      lineId: l.id,
      success: true,
      odooRecordId: `noop-${l.id}`,
    }));
  }
}
