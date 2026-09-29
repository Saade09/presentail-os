import { describe, expect, it, vi } from "vitest";
import type { ExtractedInvoiceData } from "./accountingConnector.js";
import { WafeqAccountingConnector } from "./wafeqConnector.js";
import { deterministicImportUuid } from "./wafeqClient.js";

const baseData: ExtractedInvoiceData = {
  vendor_name: "Supplier",
  external_supplier_id: "supplier-external-1",
  external_tax_rate_id: "tax-external-1",
  manual_accounting_reference: "MANUAL-REF-7",
  vendor_tax_number: null,
  vendor_address: null,
  invoice_number: "INV-7",
  invoice_date: "2026-01-01",
  due_date: "2026-02-01",
  currency: "AED",
  subtotal: 100,
  discount: null,
  tax_amount: 5,
  total_amount: 105,
  line_items: [
    { description: "One", quantity: 1, unit_price: 100, total: 100, external_account_id: "account-external-1", tax_rate: 0.05 },
    { description: "Two", quantity: 2, unit_price: 10, total: 20, external_account_id: "account-external-2", tax_rate: 0.2 },
  ],
  confidence: 1,
  raw_ai_json: {},
  company_validation_status: "matched",
  company_validation_notes: null,
  billing_country: "AE",
};

function fakeClient() {
  return {
    verifyOrganization: vi.fn().mockResolvedValue({ id: "org-1" }),
    createDraftBill: vi.fn().mockResolvedValue({
      id: "bill-1",
      status: "DRAFT",
      url: "https://app.wafeq.com/bills/bill-1",
    }),
    retrieveBill: vi.fn().mockResolvedValue({ id: "bill-1", status: "AUTHORIZED" }),
    searchSuppliers: vi.fn(),
    listEligibleAccounts: vi.fn(),
    listTaxRates: vi.fn(),
  };
}

describe("WafeqAccountingConnector", () => {
  it("maps stable external IDs directly and applies one bill tax ID uniformly", async () => {
    const client = fakeClient();
    const connector = new WafeqAccountingConnector({ client: client as never });

    const result = await connector.createDraftVendorBill(10, 20, baseData, "/private/invoice.pdf");
    expect(result).toEqual({
      success: true,
      provider_bill_id: "bill-1",
      provider_bill_url: "https://app.wafeq.com/bills/bill-1",
      provider_bill_status: "DRAFT",
    });
    expect(client.searchSuppliers).not.toHaveBeenCalled();
    expect(client.listEligibleAccounts).not.toHaveBeenCalled();
    expect(client.listTaxRates).not.toHaveBeenCalled();

    const [payload, key] = client.createDraftBill.mock.calls[0];
    expect(payload).toMatchObject({
      status: "DRAFT",
      contact: "supplier-external-1",
      reference: "MANUAL-REF-7",
      external_id: "presentail-import-10-20",
    });
    expect(payload.line_items).toEqual([
      expect.objectContaining({ account: "account-external-1", tax_rate: "tax-external-1" }),
      expect.objectContaining({ account: "account-external-2", tax_rate: "tax-external-1" }),
    ]);
    expect(key).toBe(deterministicImportUuid(10, 20));
  });

  it("returns no API endpoint as a user-facing URL when Wafeq gives none", async () => {
    const client = fakeClient();
    client.createDraftBill.mockResolvedValue({ id: "bill-1", status: "DRAFT" });
    const connector = new WafeqAccountingConnector({ client: client as never });

    const result = await connector.createDraftVendorBill(1, 2, baseData, "invoice.pdf");
    expect(result).toEqual({
      success: true,
      provider_bill_id: "bill-1",
      provider_bill_url: undefined,
      provider_bill_status: "DRAFT",
    });
  });

  it("fails before creating a bill when any stable mapping is missing", async () => {
    const client = fakeClient();
    const connector = new WafeqAccountingConnector({ client: client as never });

    const missingSupplier = { ...baseData, external_supplier_id: null };
    expect(await connector.createDraftVendorBill(1, 2, missingSupplier, "invoice.pdf"))
      .toMatchObject({ success: false, error: "Wafeq supplier mapping is required" });
    expect(client.createDraftBill).not.toHaveBeenCalled();

    const missingAccount = { ...baseData, line_items: [{ ...baseData.line_items[0], external_account_id: null }] };
    expect(await connector.createDraftVendorBill(1, 2, missingAccount, "invoice.pdf"))
      .toMatchObject({ success: false, error: "Wafeq expense account mapping is required for every line" });
    expect(client.createDraftBill).not.toHaveBeenCalled();

    const missingTax = { ...baseData, external_tax_rate_id: null };
    expect(await connector.createDraftVendorBill(1, 2, missingTax, "invoice.pdf"))
      .toMatchObject({ success: false, error: "Wafeq tax-rate mapping is required" });
  });

  it("uses the same deterministic key for safe idempotent replay", async () => {
    const client = fakeClient();
    const connector = new WafeqAccountingConnector({ client: client as never });

    await connector.createDraftVendorBill(4, 5, baseData, "invoice.pdf");
    await connector.createDraftVendorBill(4, 5, baseData, "invoice.pdf");

    expect(client.createDraftBill).toHaveBeenCalledTimes(2);
    expect(client.createDraftBill.mock.calls[0][1]).toBe(client.createDraftBill.mock.calls[1][1]);
    expect(client.createDraftBill.mock.calls[0][1]).toBe(deterministicImportUuid(4, 5));
  });

  it("retrieves status and only returns an official Wafeq URL", async () => {
    const client = fakeClient();
    const connector = new WafeqAccountingConnector({ client: client as never });

    await expect(connector.getInvoiceStatus("bill-1")).resolves.toEqual({ status: "AUTHORIZED", url: undefined });
    client.retrieveBill.mockResolvedValue({ id: "bill-1", status: "PAID", web_url: "https://app.wafeq.com/bills/bill-1" });
    await expect(connector.getInvoiceStatus("bill-1")).resolves.toEqual({
      status: "PAID",
      url: "https://app.wafeq.com/bills/bill-1",
    });
  });
});