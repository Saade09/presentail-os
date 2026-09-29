import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createHmac } from "node:crypto";

const { query, extractInvoiceDataFromBuffer, getObjectEntityUploadURL, normalizeObjectEntityPath, getObjectEntityFile, syncImportedSupplierInvoice, linkImportedInvoiceToVerifiedOdooSupplier, createConnector, access, encryptCredential, decryptCredential, verifyOrganization, listSuppliers, listAccounts, listTaxRates } = vi.hoisted(() => ({
  query: vi.fn(),
  extractInvoiceDataFromBuffer: vi.fn(),
  getObjectEntityUploadURL: vi.fn(),
  normalizeObjectEntityPath: vi.fn(),
  getObjectEntityFile: vi.fn(),
  syncImportedSupplierInvoice: vi.fn(),
  linkImportedInvoiceToVerifiedOdooSupplier: vi.fn().mockResolvedValue(1),
  createConnector: vi.fn(),
  encryptCredential: vi.fn((value: string) => `enc:${value}`),
  decryptCredential: vi.fn(async (value: string) => value === "enc:stored-key" ? "stored-key" : value),
  verifyOrganization: vi.fn(),
  listSuppliers: vi.fn(),
  listAccounts: vi.fn(),
  listTaxRates: vi.fn(),
  access: { role: "owner", allowedPages: [] as string[] },
}));
vi.mock("../lib/db.js", () => ({
  db: {
    query,
    connect: async () => ({ query, release: vi.fn() }),
  },
  withTransaction: async (_client: unknown, fn: () => Promise<unknown>) => fn(),
}));
vi.mock("../lib/auth.js", () => ({ requireAuth: (_q: express.Request, _s: express.Response, n: express.NextFunction) => n() }));
vi.mock("../lib/workspace.js", () => ({
  resolveWorkspace: (q: express.Request, _s: express.Response, n: express.NextFunction) => { Object.assign(q, { workspaceOwnerId: "w", workspaceActualRole: access.role, workspaceRole: access.role, userId: "u", allowedPages: access.allowedPages }); n(); },
  workspace: (q: express.Request) => q,
  hasPageAccess: (q: express.Request & { workspaceRole?: string; allowedPages?: string[] }, page: string) =>
    q.workspaceRole === "owner" || q.allowedPages?.includes(page) === true,
}));
vi.mock("../lib/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../lib/finance/aiExtraction.js", () => ({ extractInvoiceDataFromBuffer }));
vi.mock("../lib/supplierMatcher.js", () => ({
  matchSupplierByName: vi.fn(),
  rankSupplierCandidates: vi.fn(),
  normalizeSupplierName: (value: string) => value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .replace(/[^\w\s]/g, " ")
    .replace(/\b(s a l|s a r l|sal|sarl|ltd|llc|inc)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim(),
}));
vi.mock("../lib/finance/connectorFactory.js", () => ({ createConnector }));
vi.mock("../lib/finance/syncImportedSupplierInvoice.js", () => ({ syncImportedSupplierInvoice }));
vi.mock("../lib/finance/linkImportedInvoiceSupplier.js", () => ({ linkImportedInvoiceToVerifiedOdooSupplier }));
vi.mock("../lib/finance/odooUrl.js", () => ({ normaliseOdooBaseUrl: () => ({ ok: true, url: "https://x" }), sanitiseOdooBaseUrlForResponse: (x: string) => x }));
vi.mock("../lib/credentialEncryption.js", () => ({
  encrypt: encryptCredential,
  decryptCredential,
}));
vi.mock("../lib/finance/wafeqClient.js", () => ({
  WafeqApiError: class WafeqApiError extends Error {
    status: number;
    rateLimited: boolean;
    constructor(status: number, message = "Wafeq request failed") {
      super(message);
      this.status = status;
      this.rateLimited = status === 429;
    }
  },
  WafeqClient: class {
    verifyOrganization = verifyOrganization;
    listSuppliers = listSuppliers;
    listAccounts = listAccounts;
    listTaxRates = listTaxRates;
  },
  deterministicImportUuid: (entityId: number | string, importId: number | string) => `deterministic-${entityId}-${importId}`,
}));
vi.mock("../lib/objectStorage.js", () => ({
  ObjectStorageService: class {
    getObjectEntityUploadURL = getObjectEntityUploadURL;
    normalizeObjectEntityPath = normalizeObjectEntityPath;
    getObjectEntityFile = getObjectEntityFile;
  },
}));

import router, { resolvedInvoiceDestination, withInvoiceSyncLeaseHeartbeat } from "./finance.js";
const app = express(); app.use(express.json()); app.use(router);
describe("invoice review API boundaries", () => {
  beforeEach(() => {
    vi.stubEnv("ODOO_API_KEY", "test-odoo-api-key");
    query.mockReset();
    getObjectEntityFile.mockReset();
    syncImportedSupplierInvoice.mockReset();
    createConnector.mockReset();
    encryptCredential.mockClear();
    decryptCredential.mockClear();
    verifyOrganization.mockReset();
    listSuppliers.mockReset();
    listAccounts.mockReset();
    listTaxRates.mockReset();
    access.role = "owner";
    access.allowedPages = [];
  });

  it("routes a Lebanese entity to Odoo without using USD or supplier country as a forcing signal", () => {
    expect(resolvedInvoiceDestination(
      { accounting_destination: null, billing_country: "AE" },
      { accounting_system: "wafeq", country: "LB", legal_name: "Raidan Lebanon", display_name: "Raidan" },
    )).toBe("odoo");
    expect(resolvedInvoiceDestination(
      { accounting_destination: null, billing_country: "US" },
      { accounting_system: "wafeq", country: "AE", legal_name: "International Entity", display_name: null },
    )).toBe("wafeq");
  });

  it("renews a live sync lease while a long Odoo operation is still running", async () => {
    vi.useFakeTimers();
    try {
      query.mockResolvedValue({ rowCount: 1, rows: [] });
      let finishProvider!: (value: string) => void;
      const providerOperation = vi.fn(() => new Promise<string>((resolve) => {
        finishProvider = resolve;
      }));

      const running = withInvoiceSyncLeaseHeartbeat(701, "lease-owner-701", providerOperation);
      await vi.advanceTimersByTimeAsync(60_001);

      const renewals = query.mock.calls.filter(([sql]) =>
        String(sql).includes("SET lease_until=now()+interval '5 minutes'"));
      expect(renewals).toHaveLength(1);
      expect(renewals.every(([, params]) =>
        Array.isArray(params) && params[0] === 701 && params[1] === "lease-owner-701")).toBe(true);
      expect(providerOperation).toHaveBeenCalledTimes(1);

      finishProvider("provider-result");
      await expect(running).resolves.toBe("provider-result");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the machine Odoo audit fail-closed and read-only", async () => {
    vi.stubEnv("ODOO_API_KEY", "audit-secret");
    const unauthorized = await request(app)
      .get("/internal/finance/audit-approved-odoo")
      .query({ entity_id: 9 });
    expect(unauthorized.status).toBe(401);
    expect(query).not.toHaveBeenCalled();

    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT workspace_owner_id FROM finance_entities")) {
        return { rowCount: 1, rows: [{ workspace_owner_id: "w" }] };
      }
      if (sql.includes("SELECT * FROM finance_entities")) {
        return {
          rowCount: 1,
          rows: [{
            id: 9,
            workspace_owner_id: "w",
            accounting_system: "odoo",
            odoo_base_url: "https://odoo.example",
            odoo_database: "presentail_prod",
            odoo_company_id: 2,
          }],
        };
      }
      if (sql.includes("FROM ai_invoice_imports") && sql.includes("ORDER BY id ASC")) {
        return {
          rowCount: 1,
          rows: [{
            id: 11,
            entity_id: 9,
            workspace_owner_id: "w",
            review_status: "needs_review",
          }],
        };
      }
      return { rowCount: 0, rows: [] };
    });

    const authorized = await request(app)
      .get("/internal/finance/audit-approved-odoo")
      .set(
        "Authorization",
        `Bearer ${createHmac("sha256", "audit-secret").update("production-odoo-read-only-audit-v1").digest("hex")}`,
      )
      .query({ entity_id: 9 });
    expect(authorized.status).toBe(200);
    expect(authorized.body).toMatchObject({
      read_only: true,
      audited: 1,
      counts: { unapproved_or_rejected: 1 },
    });
    expect(createConnector).not.toHaveBeenCalled();
  });

  it("lets a reviewer override automatic routing or explicitly defer it", () => {
    const entity = { accounting_system: "wafeq", country: "LB", legal_name: "Raidan", display_name: null };
    expect(resolvedInvoiceDestination({ accounting_destination: "wafeq", billing_country: "LB" }, entity)).toBe("wafeq");
    expect(resolvedInvoiceDestination({ accounting_destination: "undecided", billing_country: "LB" }, entity)).toBe("undecided");
  });

  it("returns one entity-level setup requirement before Sync All can mutate invoices or attempts", async () => {
    query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{
        id: 9,
        workspace_owner_id: "w",
        accounting_system: "odoo",
        odoo_base_url: "https://odoo.example",
        odoo_database: "presentail_prod",
        odoo_company_id: 2,
        odoo_default_expense_account_id: null,
      }],
    });

    const response = await request(app)
      .post("/finance/invoice-review/sync-approved-to-odoo")
      .send({ entity_id: 9 });

    expect(response.status).toBe(422);
    expect(response.body).toEqual({
      success: false,
      entity_setup_required: true,
      reason_code: "entity_setup_required",
      error: "Configure a default Odoo expense account in Entity Settings before syncing invoices",
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(String(query.mock.calls[0]?.[0])).toContain("SELECT * FROM finance_entities");
    expect(createConnector).not.toHaveBeenCalled();
  });

  it("returns the entity setup requirement before an individual retry resets or leases the invoice", async () => {
    const invoice = {
      id: 37,
      entity_id: 9,
      workspace_owner_id: "w",
      review_version: 4,
      review_status: "approved",
      sync_status: "blocked",
      provider_sync_status: "failed",
      accounting_destination: "odoo",
    };
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT i.* FROM ai_invoice_imports")) return { rowCount: 1, rows: [invoice] };
      if (sql.includes("SELECT * FROM finance_entities")) {
        return {
          rowCount: 1,
          rows: [{
            id: 9,
            workspace_owner_id: "w",
            accounting_system: "odoo",
            odoo_default_expense_account_id: null,
          }],
        };
      }
      throw new Error(`Unexpected query after entity setup gate: ${sql}`);
    });

    const response = await request(app)
      .post("/finance/invoice-review/37/retry-sync")
      .send({ version: 4, idempotency_key: "retry:37:setup-required" });

    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      entity_setup_required: true,
      reason_code: "entity_setup_required",
    });
    expect(query.mock.calls.some(([sql]) => /UPDATE|INSERT/i.test(String(sql)))).toBe(false);
    expect(createConnector).not.toHaveBeenCalled();
  });

  it("retries approved historical invoices that previously failed", async () => {
    const connector = {
      createDraftVendorBill: vi.fn().mockResolvedValue({
        success: true,
        provider_bill_id: "odoo-historical-1",
        provider_bill_url: "https://odoo.example/bills/1",
        provider_supplier_id: 301,
        provider_supplier_name: "Historical Supplier",
        provider_supplier_tax_number: "LB123",
      }),
    };
    createConnector.mockReturnValueOnce(connector);
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM finance_entities")) {
        return {
          rowCount: 1,
          rows: [{
          id: 9,
          accounting_system: "odoo",
          odoo_base_url: "https://odoo.example",
          odoo_database: "presentail_prod",
          odoo_company_id: 2,
          odoo_integration_token: "entity-token",
          country: "LB",
          legal_name: "Presentail SAL",
          display_name: "Presentail Lebanon",
          }],
        };
      }
      if (sql.includes("FROM ai_invoice_imports") && sql.includes("ORDER BY id ASC")) {
        return {
          rowCount: 1,
          rows: [{
          id: 41,
          entity_id: 9,
          review_status: "approved",
          sync_status: "failed",
          review_version: 2,
          pdf_storage_path: "/objects/invoice-41.pdf",
          accounting_destination: null,
          billing_country: "LB",
          vendor_name: "Historical Supplier",
          supplier_id: 5,
          invoice_number: "HIST-41",
          invoice_date: "2026-09-16",
          line_items: [{ description: "Flowers", quantity: 1, unit_price: 10, total: 10, account_code: "601101" }],
          currency: "USD",
          subtotal: "10",
          tax_amount: "0",
          total_amount: "10",
          }],
        };
      }
      if (sql.includes("INSERT INTO ai_invoice_import_sync_attempts")) return { rowCount: 1, rows: [{ id: 77 }] };
      if (sql.includes("SELECT settings_json") || sql.includes("SELECT 1 FROM ai_invoice_imports")) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [] };
    });

    const response = await request(app)
      .post("/finance/invoice-review/sync-approved-to-odoo")
      .send({ entity_id: 9 });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({ success: true, selected: 1, synced: 1, failed: 0, skipped: 0 }));
    expect(response.body.next_after_id).toBe(41);
    const candidateSelect = query.mock.calls.find(([sql]) =>
      String(sql).includes("FROM ai_invoice_imports") && String(sql).includes("ORDER BY id ASC"));
    expect(String(candidateSelect?.[0])).toContain("verified_attempt.destination='odoo'");
    expect(String(candidateSelect?.[0])).toContain("verified_attempt.external_reference=ai_invoice_imports.odoo_bill_id");
    expect(String(candidateSelect?.[0])).toContain("sync_status <> 'needs_supplier_confirmation'");
    expect(String(candidateSelect?.[0])).toContain("authoritative_attempt.status='succeeded'");
    expect(String(candidateSelect?.[0])).toContain("authoritative_attempt.verified_at IS NOT NULL");
    expect(String(candidateSelect?.[0])).toContain("id>$3");
    expect(candidateSelect?.[1]).toEqual(["w", 9, 0]);
    const attemptInsert = query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO ai_invoice_import_sync_attempts"));
    expect(String(attemptInsert?.[1]?.[1])).toMatch(/^historical-odoo:41:2:retry:/);
    expect(connector.createDraftVendorBill).toHaveBeenCalledWith(
      9,
      41,
      expect.objectContaining({ vendor_name: "Historical Supplier" }),
      "/objects/invoice-41.pdf",
      { workspaceOwnerId: "w", approvedValuesAuthoritative: true },
    );
    expect(linkImportedInvoiceToVerifiedOdooSupplier).toHaveBeenCalledWith(
      41,
      "w",
      { id: 301, name: "Historical Supplier", taxNumber: "LB123" },
      expect.anything(),
    );
    expect(linkImportedInvoiceToVerifiedOdooSupplier.mock.invocationCallOrder[0])
      .toBeLessThan(syncImportedSupplierInvoice.mock.invocationCallOrder[0]);
  });

  it("re-evaluates a blocked invoice and recovers its proven local supplier during Sync All", async () => {
    const invoice = {
      id: 91,
      entity_id: 9,
      workspace_owner_id: "w",
      review_status: "approved",
      sync_status: "blocked",
      provider_sync_status: "failed",
      review_version: 3,
      pdf_storage_path: "/objects/invoice-91.pdf",
      accounting_destination: "odoo",
      billing_country: "LB",
      vendor_name: "Acme Flowers S.A.L.",
      supplier_id: null,
      invoice_number: "ACME-91",
      invoice_date: "2026-09-18",
      currency: "USD",
      subtotal: 100,
      tax_amount: 0,
      total_amount: 100,
      line_items: [{ description: "Flowers", quantity: 1, unit_price: 100, account_code: "601101", tax_rate: 0 }],
    };
    const entity = {
      id: 9,
      workspace_owner_id: "w",
      accounting_system: "odoo",
      default_currency: "USD",
      odoo_base_url: "https://odoo.example",
      odoo_database: "presentail",
      odoo_company_id: 2,
      odoo_default_expense_account_id: 383,
    };
    const createDraftVendorBill = vi.fn().mockResolvedValue({
      success: true,
      provider_bill_id: "odoo-91",
      provider_supplier_id: 301,
      provider_supplier_name: "Acme Flowers SAL",
      provider_supplier_tax_number: "LB123",
      outcome: "created",
    });
    createConnector.mockReturnValue({ createDraftVendorBill });
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("historical_merge_discovery")) return { rowCount: 0, rows: [] };
      if (sql.includes("SELECT * FROM finance_entities")) return { rowCount: 1, rows: [entity] };
      if (sql.includes("FROM ai_invoice_imports i")) return { rowCount: 1, rows: [{ supplier_id: 77, vendor_name: "Acme Flowers SAL" }] };
      if (sql.includes("FROM ai_invoice_imports")) return { rowCount: 1, rows: [invoice] };
      if (sql.includes("ORDER BY id ASC")) return { rowCount: 1, rows: [invoice] };
      if (sql.includes("provider_sync_status")) return { rowCount: 1, rows: [invoice] };
      if (sql.includes("SELECT i.* FROM ai_invoice_imports i")) return { rowCount: 1, rows: [invoice] };
      if (sql.includes("FROM ai_invoice_imports i")) {
        return { rowCount: 1, rows: [{ supplier_id: 77, vendor_name: "Acme Flowers SAL" }] };
      }
      if (sql.includes("SET supplier_id=$1")) return { rowCount: 1, rows: [{ supplier_id: 77 }] };
      if (sql.includes("SELECT settings_json") || sql.includes("SELECT 1 FROM ai_invoice_imports")) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes("INSERT INTO ai_invoice_import_sync_attempts")) return { rowCount: 1, rows: [{ id: 991 }] };
      return { rowCount: 1, rows: [] };
    });

    const response = await request(app)
      .post("/finance/invoice-review/sync-approved-to-odoo")
      .send({ entity_id: 9 });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({ success: true, synced: 1, blocked: 0 }));
    expect(createConnector).toHaveBeenCalledWith(expect.objectContaining({
      id: 9,
      odoo_default_expense_account_id: 383,
    }));
    expect(createDraftVendorBill).toHaveBeenCalledWith(
      9,
      91,
      expect.objectContaining({ invoice_number: "ACME-91" }),
      "/objects/invoice-91.pdf",
      { workspaceOwnerId: "w", approvedValuesAuthoritative: true },
    );
    expect(query.mock.calls.some(([sql, params]) =>
      String(sql).includes("SET supplier_id=$1") && JSON.stringify(params) === JSON.stringify([77, 91, "w", 9]),
    )).toBe(true);
  });

  it.each([
    {
      label: "subtotal plus tax differs from total",
      subtotal: 100,
      tax_amount: 11,
      total_amount: 999,
      line_items: [{ description: "Flowers", quantity: 1, unit_price: 100, total: 100, account_code: "601101", tax_rate: .11 }],
    },
    {
      label: "line sum differs from subtotal",
      subtotal: 175,
      tax_amount: 0,
      total_amount: 175,
      line_items: [{ description: "Flowers", quantity: 1, unit_price: 100, total: 100, account_code: "601101", tax_rate: 0 }],
    },
  ])("lets an approved invoice reach Odoo when $label", async ({ subtotal, tax_amount, total_amount, line_items }) => {
    const invoice = {
      id: 92,
      entity_id: 9,
      workspace_owner_id: "w",
      review_status: "approved",
      sync_status: "failed",
      provider_sync_status: "failed",
      review_version: 3,
      pdf_storage_path: "/objects/invoice-92.pdf",
      accounting_destination: "odoo",
      billing_country: "LB",
      vendor_name: "Raidan OCR Trading",
      vendor_tax_number: "STALE-OCR-VAT",
      supplier_id: 77,
      invoice_number: "APPROVED-92",
      invoice_date: "2026-09-18",
      currency: "USD",
      subtotal,
      tax_amount,
      total_amount,
      line_items,
    };
    const createDraftVendorBill = vi.fn().mockResolvedValue({
      success: true,
      provider_bill_id: "odoo-92",
      provider_supplier_id: 301,
      provider_supplier_name: "Approved Supplier",
      outcome: "created",
    });
    createConnector.mockReturnValue({ createDraftVendorBill });
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM finance_entities")) return { rowCount: 1, rows: [{
        id: 9, workspace_owner_id: "w", accounting_system: "odoo", default_currency: "USD",
        country: "LB", legal_name: "Presentail SAL", odoo_base_url: "https://odoo.example",
        odoo_database: "presentail", odoo_company_id: 2, odoo_integration_token: "entity-token",
      }] };
      if (sql.includes("ORDER BY id ASC")) return { rowCount: 1, rows: [invoice] };
      if (sql.includes("FROM suppliers") && sql.includes("odoo_partner_id")) {
        return { rowCount: 1, rows: [{ odoo_partner_id: "302", name: "Raidan Floriculture SARL", tax_number: "2035191" }] };
      }
      if (sql.includes("INSERT INTO ai_invoice_import_sync_attempts")) return { rowCount: 1, rows: [{ id: 992 }] };
      if (sql.includes("SELECT settings_json") || sql.includes("SELECT 1 FROM ai_invoice_imports")) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [] };
    });

    const response = await request(app)
      .post("/finance/invoice-review/sync-approved-to-odoo")
      .send({ entity_id: 9 });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({ synced: 1, blocked: 0 }));
    expect(createDraftVendorBill).toHaveBeenCalledTimes(1);
    expect(createDraftVendorBill.mock.calls[0]?.[2]).toEqual(expect.objectContaining({
      vendor_name: "Raidan Floriculture SARL",
      vendor_tax_number: "2035191",
      odoo_partner_id: "302",
      partner_id: "302",
    }));
  });

  it("continues the historical batch after one invoice fails", async () => {
    const createDraftVendorBill = vi.fn()
      .mockResolvedValueOnce({ success: false, error: "Supplier mapping is ambiguous" })
      .mockResolvedValueOnce({ success: true, provider_bill_id: "odoo-52", provider_bill_status: "posted" });
    createConnector.mockReturnValue({ createDraftVendorBill });
    const invoices = [51, 52].map((id) => ({
      id,
      entity_id: 9,
      review_status: "approved",
      sync_status: "failed",
      review_version: 2,
      pdf_storage_path: `/objects/invoice-${id}.pdf`,
      accounting_destination: "odoo",
      billing_country: "LB",
      vendor_name: `Supplier ${id}`,
      supplier_id: id,
      invoice_number: `INV-${id}`,
      invoice_date: "2026-09-16",
      line_items: [{ description: "Flowers", quantity: 1, unit_price: 10, total: 10, account_code: "601101" }],
      currency: "USD",
      subtotal: "10",
      total_amount: "10",
    }));
    let attemptId = 80;
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM finance_entities")) {
        return {
          rowCount: 1,
          rows: [{
            id: 9,
            accounting_system: "odoo",
            odoo_base_url: "https://odoo.example",
            odoo_database: "presentail_prod",
            odoo_company_id: 2,
            country: "LB",
            legal_name: "Presentail SAL",
          }],
        };
      }
      if (sql.includes("FROM ai_invoice_imports") && sql.includes("ORDER BY id ASC")) {
        return { rowCount: 2, rows: invoices };
      }
      if (sql.includes("INSERT INTO ai_invoice_import_sync_attempts")) {
        attemptId++;
        return { rowCount: 1, rows: [{ id: attemptId }] };
      }
      if (sql.includes("SELECT settings_json") || sql.includes("SELECT 1 FROM ai_invoice_imports")) {
        return { rowCount: 0, rows: [] };
      }
      return { rowCount: 1, rows: [] };
    });

    const response = await request(app)
      .post("/finance/invoice-review/sync-approved-to-odoo")
      .send({ entity_id: 9 });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      success: false,
      selected: 2,
      synced: 1,
      failed: 1,
      skipped: 0,
      next_after_id: 52,
    }));
    expect(createDraftVendorBill).toHaveBeenCalledTimes(2);
  });

  it("Sync All retries failed, re-evaluates blocked, includes approved unsynced, and isolates failures", async () => {
    const invoices = [61, 62, 63].map((id, index) => ({
      id,
      entity_id: 9,
      review_status: "approved",
      sync_status: index === 0 ? "failed" : index === 1 ? "blocked" : "not_requested",
      provider_sync_status: index === 2 ? null : "failed",
      review_version: 4,
      pdf_storage_path: `/objects/invoice-${id}.pdf`,
      accounting_destination: "odoo",
      billing_country: "LB",
      vendor_name: `Supplier ${id}`,
      supplier_id: id,
      invoice_number: `BULK-${id}`,
      invoice_date: "2026-09-16",
      line_items: [{ description: "Flowers", quantity: 1, unit_price: 10, total: 10 }],
      currency: "USD",
      subtotal: "10",
      tax_amount: "0",
      total_amount: "10",
    }));
    const createDraftVendorBill = vi.fn()
      .mockResolvedValueOnce({ success: false, error: "VAT warning requires review" })
      .mockResolvedValueOnce({ success: true, provider_bill_id: "odoo-62", provider_bill_status: "posted" })
      .mockResolvedValueOnce({ success: true, provider_bill_id: "odoo-63", provider_bill_status: "posted" });
    createConnector.mockReturnValue({ createDraftVendorBill });
    let attemptId = 120;
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM finance_entities")) {
        return { rowCount: 1, rows: [{
          id: 9, workspace_owner_id: "w", accounting_system: "odoo",
          odoo_base_url: "https://odoo.example", odoo_database: "presentail_prod",
          odoo_company_id: 2, country: "LB", legal_name: "Presentail SAL",
        }] };
      }
      if (sql.includes("FROM ai_invoice_imports") && sql.includes("ORDER BY id ASC")) {
        return { rowCount: invoices.length, rows: invoices };
      }
      if (sql.includes("INSERT INTO ai_invoice_import_sync_attempts")) {
        attemptId += 1;
        return { rowCount: 1, rows: [{ id: attemptId }] };
      }
      if (sql.includes("SELECT settings_json") || sql.includes("SELECT 1 FROM ai_invoice_imports")) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [] };
    });

    const response = await request(app)
      .post("/finance/invoice-review/sync-approved-to-odoo")
      .send({ entity_id: 9 });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      success: false,
      selected: 3,
      synced: 2,
      failed: 1,
      skipped: 0,
    }));
    expect(createDraftVendorBill).toHaveBeenCalledTimes(3);
    expect(createDraftVendorBill.mock.calls.map((call) => call[1])).toEqual([61, 62, 63]);
  });

  it("bulk-sync resolves a superseded queue ID, uses the canonical service, and returns 200", async () => {
    const entity = {
      id: 9, workspace_owner_id: "w", accounting_system: "odoo",
      odoo_base_url: "https://odoo.example", odoo_database: "presentail",
      odoo_company_id: 2, country: "LB", legal_name: "Presentail SAL",
    };
    const superseded = {
      id: 901, entity_id: 9, workspace_owner_id: "w", review_status: "superseded",
      sync_status: "superseded", superseded_by_import_id: 902, review_version: 2,
      invoice_number: "BULK-CANONICAL", currency: "USD", pdf_storage_path: "/objects/901.pdf",
    };
    const canonical = {
      id: 902, entity_id: 9, workspace_owner_id: "w", review_status: "approved",
      sync_status: "not_requested", provider_sync_status: "pending", review_version: 5,
      superseded_by_import_id: null, invoice_number: "BULK-CANONICAL", invoice_date: "2026-09-18",
      currency: "USD", pdf_storage_path: "/objects/902.pdf", accounting_destination: "odoo",
      billing_country: "LB", vendor_name: "Supplier 902", supplier_id: null,
      subtotal: 10, tax_amount: 0, total_amount: 10,
      line_items: [{ description: "Flowers", quantity: 1, unit_price: 10, total: 10 }],
      reviewed_snapshot: { invoice_number: "BULK-CANONICAL", currency: "USD", line_items: [{ description: "Flowers", quantity: 1, unit_price: 10, total: 10 }] },
    };
    const createDraftVendorBill = vi.fn().mockResolvedValue({
      success: true, outcome: "created", provider_bill_id: "odoo-902",
      provider_supplier_id: 301, provider_supplier_name: "Supplier 902",
    });
    createConnector.mockReturnValue({ createDraftVendorBill });
    let canonicalLookup = 0;
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM ai_invoice_imports WHERE id=$1")) {
        canonicalLookup += 1;
        return { rowCount: 1, rows: [canonicalLookup === 1 ? superseded : canonical] };
      }
      if (sql.includes("SELECT * FROM finance_entities")) return { rowCount: 1, rows: [entity] };
      if (sql.includes("upper(trim(invoice_number))")) return { rowCount: 1, rows: [canonical] };
      if (sql.includes("INSERT INTO ai_invoice_import_sync_attempts")) return { rowCount: 1, rows: [{ id: 1902 }] };
      return { rowCount: 1, rows: [] };
    });

    const response = await request(app)
      .post("/finance/invoice-review/bulk-sync")
      .send({
        action: "sync",
        invoice_ids: [901, 902],
        versions: { "901": 2, "902": 5 },
        idempotency_keys: { "901": "queue:901:2:test", "902": "queue:902:5:test" },
      });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      results: [
        { invoice_id: 901, status: "succeeded", canonical_invoice_id: 902 },
        { invoice_id: 902, status: "skipped", canonical_invoice_id: 902 },
      ],
    });
    expect(createDraftVendorBill).toHaveBeenCalledTimes(1);
    expect(createDraftVendorBill.mock.calls[0]?.[1]).toBe(902);
  });

  it("merges an approved blocked split canonical and retries it once in the same Sync All run", async () => {
    const entity = {
      id: 9, workspace_owner_id: "w", accounting_system: "odoo",
      odoo_base_url: "https://odoo.example", odoo_database: "presentail",
      odoo_company_id: 2, country: "LB", legal_name: "Presentail SAL",
    };
    const smaller = {
      id: 201, entity_id: 9, workspace_owner_id: "w", review_status: "approved",
      sync_status: "failed", provider_sync_status: "failed", review_version: 2,
      pdf_storage_path: "/objects/split-201.pdf", accounting_destination: "odoo",
      billing_country: "LB", vendor_name: "Raidan Flowers and Plants Wholesaler", supplier_id: 88,
      invoice_number: "SF2602254", invoice_date: "2026-09-08", currency: "USD",
      subtotal: 71.99, tax_amount: 0, total_amount: 71.99,
      line_items: [{ description: "Page one", quantity: 1, unit_price: 71.99, total: 71.99 }],
    };
    const blockedFinal = {
      ...smaller, id: 202, sync_status: "blocked", review_version: 4,
      vendor_name: "Raidan Floriculture S.A.R.L.", supplier_id: 88,
      pdf_storage_path: "/objects/split-202.pdf", subtotal: 500, tax_amount: 63.5,
      total_amount: 563.5, raw_ai_json: { total_label: "GRAND TOTAL" },
      line_items: [{ description: "Page two", quantity: 1, unit_price: 428.01, total: 428.01 }],
    };
    const canonical = {
      ...blockedFinal,
      supplier_id: 88,
      line_items: [...smaller.line_items, ...blockedFinal.line_items],
      sync_status: "not_requested",
      provider_sync_status: "pending",
      review_version: 5,
    };
    const createDraftVendorBill = vi.fn().mockResolvedValue({
      success: true, outcome: "created", provider_bill_id: "odoo-202",
    });
    syncImportedSupplierInvoice.mockResolvedValue(undefined);
    createConnector.mockReturnValue({ createDraftVendorBill });
    let merged = false;
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM finance_entities")) return { rowCount: 1, rows: [entity] };
      if (sql.includes("historical_merge_discovery")) return { rowCount: 2, rows: [smaller, blockedFinal] };
      if (sql.includes("FROM ai_invoice_imports") && sql.includes("ORDER BY id ASC")) {
        return merged ? { rowCount: 1, rows: [canonical] } : { rowCount: 2, rows: [smaller, blockedFinal] };
      }
      if (sql.includes("FOR UPDATE")) return merged ? { rowCount: 1, rows: [canonical] } : { rowCount: 2, rows: [smaller, blockedFinal] };
      if (sql.includes("SET line_items=$1")) {
        merged = true;
        return { rowCount: 1, rows: [canonical] };
      }
      if (sql.includes("SELECT * FROM ai_invoice_imports WHERE id=$1")) return { rowCount: 1, rows: [canonical] };
      if (sql.includes("SELECT settings_json") || sql.includes("SELECT 1 FROM ai_invoice_imports")) return { rowCount: 0, rows: [] };
      if (sql.includes("INSERT INTO ai_invoice_import_sync_attempts")) return { rowCount: 1, rows: [{ id: 1202 }] };
      return { rowCount: 1, rows: [] };
    });

    const response = await request(app)
      .post("/finance/invoice-review/sync-approved-to-odoo")
      .send({ entity_id: 9 });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({ selected: 1, synced: 1, skipped: 0 }));
    expect(createDraftVendorBill).toHaveBeenCalledTimes(1);
    expect(createDraftVendorBill).toHaveBeenCalledWith(9, 202, expect.objectContaining({
      supplier_id: 88,
      total_amount: 563.5,
      line_items: expect.arrayContaining([
        expect.objectContaining({ description: "Page one" }),
        expect.objectContaining({ description: "Page two" }),
      ]),
    }), expect.any(String), expect.anything());
  });

  it("keeps unresolved same-number siblings out of Sync All provider work", async () => {
    const entity = {
      id: 9,
      workspace_owner_id: "w",
      accounting_system: "odoo",
      odoo_base_url: "https://odoo.example",
      odoo_database: "presentail",
      odoo_company_id: 2,
      odoo_default_expense_account_id: 601101,
    };
    let candidateSql = "";
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM finance_entities")) return { rowCount: 1, rows: [entity] };
      if (sql.includes("historical_merge_discovery")) return { rowCount: 0, rows: [] };
      if (sql.includes("ORDER BY id ASC") && sql.includes("FROM ai_invoice_imports")) {
        candidateSql = sql;
        return { rowCount: 0, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    });

    const response = await request(app)
      .post("/finance/invoice-review/sync-approved-to-odoo")
      .send({ entity_id: 9 });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({ selected: 0, synced: 0 });
    expect(candidateSql).toContain("FROM ai_invoice_imports sibling");
    expect(candidateSql).toContain("sibling.superseded_by_import_id IS NULL");
    expect(createConnector).not.toHaveBeenCalled();
  });

  it("classifies read-only Odoo audit outcomes, blocked reasons, and missing provider IDs without creating", async () => {
    const entity = {
      id: 9,
      workspace_owner_id: "w",
      accounting_system: "odoo",
      odoo_base_url: "https://odoo.example",
      odoo_database: "presentail_prod",
      odoo_company_id: 2,
      odoo_integration_token: "entity-token",
      country: "US",
      legal_name: "Presentail USA",
      display_name: "Presentail USA",
      default_currency: "USD",
    };
    const baseInvoice = (id: number) => ({
      id,
      entity_id: 9,
      workspace_owner_id: "w",
      review_version: 1,
      review_status: "approved",
      sync_status: "not_requested",
      accounting_destination: "odoo",
      billing_country: "US",
      pdf_storage_path: `/objects/invoice-${id}.pdf`,
      vendor_name: "Supplier",
      supplier_id: 1,
      invoice_number: `INV-${id}`,
      invoice_date: "2026-09-16",
      currency: "USD",
      subtotal: 100,
      tax_amount: 5,
      total_amount: 105,
      line_items: [{ description: "Flowers", quantity: 1, unit_price: 100, total: 100, account_code: "6000", tax_rate: 0.05 }],
    });
    const invoices = [
      { ...baseInvoice(11), provider_bill_id: null, odoo_bill_id: null },
      { ...baseInvoice(12), provider_bill_id: "odoo-12", odoo_bill_id: "odoo-12" },
      { ...baseInvoice(13), provider_bill_id: null, odoo_bill_id: null },
      { ...baseInvoice(14), review_status: "needs_review" },
      { ...baseInvoice(15), accounting_destination: "wafeq" },
      { ...baseInvoice(16), pdf_storage_path: null },
      { ...baseInvoice(17), supplier_id: 1 },
      { ...baseInvoice(18), provider_bill_id: "odoo-18", odoo_bill_id: "odoo-18" },
    ];
    const createDraftVendorBill = vi.fn()
      .mockResolvedValueOnce({ success: true, outcome: "recovered", provider_bill_id: "odoo-11" })
      .mockResolvedValueOnce({ success: true, outcome: "verified_existing", provider_bill_id: "odoo-12" })
      .mockResolvedValueOnce({ success: true, outcome: "eligible_create" })
      .mockResolvedValueOnce({ success: true, outcome: "eligible_create" })
      .mockResolvedValueOnce({ success: false, provider_bill_id: "odoo-18", error: "Odoo vendor bill is missing its original supporting attachment" });
    createConnector.mockReturnValue({ createDraftVendorBill });
    query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("SELECT * FROM finance_entities")) return { rowCount: 1, rows: [entity] };
      if (sql.includes("FROM ai_invoice_imports") && sql.includes("ORDER BY id ASC")) return { rowCount: invoices.length, rows: invoices };
      if (sql.includes("SELECT settings_json")) return { rowCount: 0, rows: [] };
      if (sql.includes("upper(trim(invoice_number))")) return { rowCount: 0, rows: [] };
      if (sql.includes("supplier_id=$3")) return params.includes(17) ? { rowCount: 1, rows: [{}] } : { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [] };
    });

    const response = await request(app)
      .get("/finance/invoice-review/audit-approved-to-odoo")
      .query({ entity_id: 9, after_id: 0 });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      read_only: true,
      entity_id: 9,
      audited: 8,
      audit_complete: true,
      next_after_id: 18,
      counts: {
        recovered_bill: 1,
        verified_existing_bill: 1,
        eligible_create: 2,
        unapproved_or_rejected: 1,
        alternate_destination: 1,
        source_unavailable: 1,
        recoverable_bill: 1,
      },
    });
    expect(response.body.results).toEqual(expect.arrayContaining([
      { invoice_id: 11, reason_code: "recovered_bill", external_reference: "odoo-11" },
      { invoice_id: 17, reason_code: "eligible_create" },
      { invoice_id: 12, reason_code: "verified_existing_bill", external_reference: "odoo-12" },
      { invoice_id: 13, reason_code: "eligible_create" },
      { invoice_id: 14, reason_code: "unapproved_or_rejected", status: "needs_review" },
      { invoice_id: 15, reason_code: "alternate_destination", destination: "wafeq" },
      { invoice_id: 16, reason_code: "source_unavailable", error: "Source document is unavailable" },
      expect.objectContaining({ invoice_id: 18, reason_code: "recoverable_bill", external_reference: "odoo-18" }),
    ]));
    expect(createDraftVendorBill).toHaveBeenCalledTimes(5);
    for (const call of createDraftVendorBill.mock.calls) {
      expect(call[4]).toEqual({
        readOnly: true,
        workspaceOwnerId: "w",
        approvedValuesAuthoritative: true,
      });
    }
    expect(createDraftVendorBill.mock.calls[2][2]).toEqual(expect.objectContaining({ provider_bill_id: null }));
  });

  it("advances the read-only audit cursor across pages of 100 invoices without invoking a provider create", async () => {
    const entity = {
      id: 9,
      workspace_owner_id: "w",
      accounting_system: "odoo",
      odoo_base_url: "https://odoo.example",
      odoo_database: "presentail_prod",
      odoo_company_id: 2,
      country: "US",
      legal_name: "Presentail USA",
    };
    const makeUnapproved = (id: number) => ({
      id,
      entity_id: 9,
      workspace_owner_id: "w",
      review_status: "needs_review",
      sync_status: "not_requested",
    });
    query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("SELECT * FROM finance_entities")) return { rowCount: 1, rows: [entity] };
      if (sql.includes("FROM ai_invoice_imports") && sql.includes("ORDER BY id ASC")) {
        const afterId = Number(params[2] ?? 0);
        const rows = afterId === 0
          ? Array.from({ length: 100 }, (_, index) => makeUnapproved(index + 1))
          : [makeUnapproved(101)];
        return { rowCount: rows.length, rows };
      }
      return { rowCount: 0, rows: [] };
    });

    const first = await request(app)
      .get("/finance/invoice-review/audit-approved-to-odoo")
      .query({ entity_id: 9, after_id: 0 });
    const second = await request(app)
      .get("/finance/invoice-review/audit-approved-to-odoo")
      .query({ entity_id: 9, after_id: first.body.next_after_id });

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ audited: 100, audit_complete: false, next_after_id: 100 });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ audited: 1, audit_complete: true, next_after_id: 101 });
    expect(createConnector).not.toHaveBeenCalled();
    const candidateCalls = query.mock.calls.filter(([sql]) => String(sql).includes("FROM ai_invoice_imports") && String(sql).includes("ORDER BY id ASC"));
    expect(candidateCalls.map(([, params]) => params)).toEqual([["w", 9, 0], ["w", 9, 100]]);
  });

  it("repairs stale local success on the first bulk run and verifies it without creating on the second", async () => {
    const entity = {
      id: 9,
      workspace_owner_id: "w",
      accounting_system: "odoo",
      odoo_base_url: "https://odoo.example",
      odoo_database: "presentail_prod",
      odoo_company_id: 2,
      country: "US",
      legal_name: "Presentail USA",
    };
    const invoice = {
      id: 18,
      entity_id: 9,
      workspace_owner_id: "w",
      review_version: 3,
      review_status: "approved",
      sync_status: "succeeded",
      provider_sync_status: "succeeded",
      provider_bill_id: "stale-provider-id",
      odoo_bill_id: "stale-provider-id",
      accounting_destination: "odoo",
      billing_country: "US",
      pdf_storage_path: "/objects/invoice-18.pdf",
      vendor_name: "Supplier",
      supplier_id: 1,
      invoice_number: "INV-18",
      invoice_date: "2026-09-16",
      currency: "USD",
      subtotal: 100,
      tax_amount: 5,
      total_amount: 105,
      line_items: [{ description: "Flowers", quantity: 1, unit_price: 100, total: 100, account_code: "6000", tax_rate: 0.05 }],
    };
    const createDraftVendorBill = vi.fn()
      .mockResolvedValueOnce({ success: true, outcome: "recovered", provider_bill_id: "odoo-18" })
      .mockResolvedValueOnce({ success: true, outcome: "verified_existing", provider_bill_id: "odoo-18" });
    createConnector.mockReturnValue({ createDraftVendorBill });
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("historical_merge_discovery")) return { rowCount: 0, rows: [] };
      if (sql.includes("SELECT * FROM finance_entities")) return { rowCount: 1, rows: [entity] };
      if (sql.includes("FROM ai_invoice_imports") && sql.includes("ORDER BY id ASC")) return { rowCount: 1, rows: [invoice] };
      if (sql.includes("INSERT INTO ai_invoice_import_sync_attempts")) return { rowCount: 1, rows: [{ id: 118 }] };
      if (sql.includes("SELECT settings_json") || sql.includes("SELECT 1 FROM ai_invoice_imports")) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [] };
    });

    const first = await request(app)
      .post("/finance/invoice-review/sync-approved-to-odoo")
      .send({ entity_id: 9 });
    const second = await request(app)
      .post("/finance/invoice-review/sync-approved-to-odoo")
      .send({ entity_id: 9 });

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      success: true,
      recovered: 1,
      verified_existing: 0,
      stale_repaired: 1,
      reason_breakdown: { stale_local_success_repaired: 1 },
      results: [{
        invoice_id: 18,
        status: "succeeded",
        outcome: "recovered",
        stale_local_state: true,
      }],
    });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({
      success: true,
      created: 0,
      recovered: 0,
      verified_existing: 1,
      stale_repaired: 0,
      reason_breakdown: { verified_existing_bill: 1 },
    });
    expect(createDraftVendorBill).toHaveBeenCalledTimes(2);
  });

  it("keeps Wafeq connection status owner-only and tenant-scoped", async () => {
    access.role = "member";
    expect((await request(app).get("/finance/wafeq/connection")).status).toBe(403);
    expect(query).not.toHaveBeenCalled();

    access.role = "owner";
    query.mockResolvedValueOnce({ rowCount: 1, rows: [{
      encrypted_api_key: "enc:never-return-this",
      organization_id: "org-1",
      organization_name: "Org",
      status: "configured",
      last_verified_at: "2026-01-01",
      last_error: null,
      last_error_at: null,
    }] });
    const response = await request(app).get("/finance/wafeq/connection");
    expect(response.status).toBe(200);
    expect(response.body.connection).toEqual(expect.objectContaining({ configured: true, organization_id: "org-1" }));
    expect(JSON.stringify(response.body)).not.toContain("never-return-this");
    expect(query).toHaveBeenCalledWith(expect.stringContaining("workspace_owner_id=$1"), ["w"]);
  });

  it("encrypts a Wafeq key, stores bilingual organization names safely, and never echoes it", async () => {
    verifyOrganization.mockResolvedValueOnce({ id: "org-2", name: { en: "Acme", ar: "أكمي" } });
    query.mockResolvedValueOnce({ rowCount: 1, rows: [{
      encrypted_api_key: "enc:new-key", organization_id: "org-2", organization_name: "Acme",
      status: "configured", last_verified_at: null, last_error: null, last_error_at: null,
    }] });
    const response = await request(app).post("/finance/wafeq/connection").send({ api_key: "plain-secret" });
    expect(response.status).toBe(200);
    expect(encryptCredential).toHaveBeenCalledWith("plain-secret");
    expect(response.body.connection.organization_name).toBe("Acme");
    expect(JSON.stringify(response.body)).not.toContain("plain-secret");
    expect(query.mock.calls[0][1]).toContain("enc:plain-secret");
  });

  it("rejects failed Wafeq verification without storing or exposing the candidate key", async () => {
    const WafeqError = (await import("../lib/finance/wafeqClient.js")).WafeqApiError;
    verifyOrganization.mockRejectedValueOnce(new WafeqError(401));
    const response = await request(app).post("/finance/wafeq/connection").send({ api_key: "failed-secret" });
    expect(response.status).toBe(422);
    expect(response.text).not.toContain("failed-secret");
    expect(query).not.toHaveBeenCalled();
  });

  it("persists a failed saved-connection test so status does not revert to connected", async () => {
    const WafeqError = (await import("../lib/finance/wafeqClient.js")).WafeqApiError;
    query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ encrypted_api_key: "enc:stored-key", status: "configured" }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    verifyOrganization.mockRejectedValueOnce(new WafeqError(401));

    const response = await request(app).post("/finance/wafeq/connection/test");

    expect(response.status).toBe(422);
    expect(query.mock.calls[1][0]).toContain("UPDATE wafeq_connections");
    expect(query.mock.calls[1][1]).toEqual(["invalid", "Wafeq credentials could not be verified", "w"]);
  });

  it("keeps provider outages retryable instead of invalidating saved credentials", async () => {
    const WafeqError = (await import("../lib/finance/wafeqClient.js")).WafeqApiError;
    query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ encrypted_api_key: "enc:stored-key", status: "configured" }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });
    verifyOrganization.mockRejectedValueOnce(new WafeqError(500));

    const response = await request(app).post("/finance/wafeq/connection/test");

    expect(response.status).toBe(503);
    expect(response.body.connection.status).toBe("unavailable");
    expect(query.mock.calls[1][1]).toEqual(["unavailable", "Wafeq is temporarily unavailable", "w"]);
  });

  it("disconnects only the active workspace and rejects member lookups", async () => {
    access.role = "member";
    expect((await request(app).get("/finance/invoice-review/wafeq/suppliers")).status).toBe(403);
    access.role = "owner";
    query.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const response = await request(app).delete("/finance/wafeq/connection");
    expect(response.status).toBe(200);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("DELETE FROM wafeq_connections"), ["w"]);
  });

  it.each([
    ["missing", { rowCount: 0, rows: [] }, 503, "not_configured"],
    ["invalid", { rowCount: 1, rows: [{ encrypted_api_key: "enc:key", status: "invalid" }] }, 422, "invalid"],
  ])("reports Wafeq lookup %s state", async (_name, connection, status, state) => {
    query.mockResolvedValueOnce(connection);
    const response = await request(app).get("/finance/invoice-review/wafeq/accounts");
    expect(response.status).toBe(status);
    expect(response.body.state).toBe(state);
  });

  it("retries a rate-limited Wafeq lookup and restores configured status after recovery", async () => {
    query.mockResolvedValueOnce({ rowCount: 1, rows: [{ encrypted_api_key: "enc:key", status: "rate_limit" }] });
    listAccounts.mockResolvedValueOnce([{ id: "a1", name_en: "Recovered account" }]);
    const response = await request(app).get("/finance/invoice-review/wafeq/accounts");
    expect(response.status).toBe(200);
    expect(response.body.state).toBe("configured");
    expect(response.body.accounts).toEqual([{ id: "a1", name_en: "Recovered account" }]);
    expect(listAccounts).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("SET status='configured'"), ["w"]);
  });

  it("paginates workspace-scoped Wafeq supplier lookups without creating suppliers", async () => {
    query.mockResolvedValueOnce({ rowCount: 1, rows: [{ encrypted_api_key: "enc:key", status: "configured" }] });
    listSuppliers.mockResolvedValueOnce([{ id: "s1", name: "One" }, { id: "s2", name: "Two" }]);
    const response = await request(app).get("/finance/invoice-review/wafeq/suppliers?q=one&limit=1&offset=1");
    expect(response.status).toBe(200);
    expect(response.body.suppliers).toEqual([{ id: "s2", name: "Two" }]);
    expect(response.body).toMatchObject({ total: 2, limit: 1, offset: 1, has_more: false });
    expect(listSuppliers).toHaveBeenCalledWith({ keyword: "one" });
    expect(query.mock.calls[0][1]).toEqual(["w"]);
  });

  it("filters Wafeq accounts by code or name before applying pagination", async () => {
    query.mockResolvedValueOnce({ rowCount: 1, rows: [{ encrypted_api_key: "enc:key", status: "configured" }] });
    listAccounts.mockResolvedValueOnce([
      { id: "a1", account_code: "6100", name_en: "Office supplies" },
      { id: "a2", account_code: "6200", name_en: "Travel" },
      { id: "a3", account_code: "7610", name_en: "Office equipment" },
    ]);

    const response = await request(app).get("/finance/invoice-review/wafeq/accounts?q=office&limit=1&offset=1");

    expect(response.status).toBe(200);
    expect(response.body.accounts).toEqual([{ id: "a3", account_code: "7610", name_en: "Office equipment" }]);
    expect(response.body).toMatchObject({ total: 2, limit: 1, offset: 1, has_more: false });
    expect(listAccounts).toHaveBeenCalledWith();
  });

  it("detects Wafeq supplier duplicates even when a local supplier is also selected", async () => {
    const invoice = {
      id: 63, entity_id: 7, workspace_owner_id: "w", review_version: 1,
      review_status: "needs_review", sync_status: "not_requested",
      pdf_storage_path: "/objects/invoice-63", vendor_name: "Supplier", supplier_id: 91,
      wafeq_supplier_id: "wafeq-supplier-1", invoice_number: "W-63",
      invoice_date: "2026-01-01", currency: "USD", subtotal: 100, tax_amount: 5, total_amount: 105,
      line_items: [{ description: "Service", quantity: 1, unit_price: 100, tax_rate: .05 }],
    };
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT i.* FROM ai_invoice_imports")) return { rowCount: 1, rows: [invoice] };
      if (sql.includes("SELECT accounting_system FROM finance_entities")) return { rowCount: 1, rows: [{ accounting_system: "wafeq" }] };
      if (sql.includes("SELECT settings_json")) return { rowCount: 0, rows: [] };
      if (sql.includes("SELECT 1 FROM ai_invoice_imports")) return { rowCount: 1, rows: [{ "?column?": 1 }] };
      return { rowCount: 1, rows: [] };
    });

    const response = await request(app).post("/finance/invoice-review/63/validate");

    expect(response.status).toBe(200);
    expect(response.body.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ issue_key: "duplicate.risk", blocking: true }),
    ]));
    const duplicateCalls = query.mock.calls.filter(([sql]) => String(sql).includes("SELECT 1 FROM ai_invoice_imports"));
    expect(duplicateCalls).toHaveLength(2);
    const wafeqDuplicateCall = duplicateCalls.find(([, params]) => Array.isArray(params) && params[2] === "wafeq-supplier-1");
    expect(String(wafeqDuplicateCall?.[0])).toContain("wafeq_supplier_id=$3");
    expect(wafeqDuplicateCall?.[1]).toEqual(["w", 7, "wafeq-supplier-1", "W-63", 63]);
  });

  it("rejects Wafeq approval when the selected bill tax does not reconcile", async () => {
    const invoice = {
      id: 67, entity_id: 7, workspace_owner_id: "w", review_version: 1,
      review_status: "needs_review", sync_status: "not_requested",
      pdf_storage_path: "/objects/invoice-67", vendor_name: "Supplier", supplier_id: 9,
      invoice_number: "W-67", invoice_date: "2026-01-01", currency: "USD",
      subtotal: 100, tax_amount: 6, total_amount: 106,
      wafeq_supplier_id: "wafeq-supplier-67", wafeq_account_id: "account-67", wafeq_tax_id: "tax-5",
      line_items: [{ description: "Service", quantity: 1, unit_price: 100, account_code: "6000", tax_rate: .06 }],
    };
    access.role = "member";
    access.allowedPages = ["ai-invoice-import"];
    listTaxRates.mockResolvedValueOnce([{ id: "tax-5", rate: 5 }]);
    getObjectEntityFile.mockResolvedValueOnce({ exists: vi.fn().mockResolvedValue([true]) });
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT i.* FROM ai_invoice_imports")) return { rowCount: 1, rows: [invoice] };
      if (sql.includes("SELECT encrypted_api_key")) return { rowCount: 1, rows: [{ encrypted_api_key: "enc:key", organization_id: "org-1", status: "configured" }] };
      if (sql.includes("SELECT accounting_system FROM finance_entities")) return { rowCount: 1, rows: [{ accounting_system: "wafeq" }] };
      if (sql.includes("SELECT settings_json")) return { rowCount: 0, rows: [] };
      if (sql.includes("SELECT 1 FROM ai_invoice_imports")) return { rowCount: 0, rows: [] };
      if (sql.includes("WITH approved AS")) return { rowCount: 1, rows: [{ ...invoice, review_status: "approved", sync_status: "pending", review_version: 2, attempt_id: 968 }] };
      return { rowCount: 1, rows: [] };
    });

    const response = await request(app).post("/finance/invoice-review/67/approve").send({ version: 1 });

    expect(response.status).toBe(422);
    expect(response.body.validation.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ issue_key: "wafeq.tax.amount_mismatch", blocking: true }),
      expect.objectContaining({ issue_key: "wafeq.total.amount_mismatch", blocking: true }),
    ]));
    expect(query.mock.calls.some(([sql]) => String(sql).includes("WITH approved AS"))).toBe(false);
  });

  it.each([
    ["missing", undefined],
    ["non-numeric", "not-a-rate"],
    ["negative", -5],
    ["out of range", 101],
  ])("rejects Wafeq approval when the selected tax rate is %s", async (_name, rate) => {
    const invoice = {
      id: 68, entity_id: 7, workspace_owner_id: "w", review_version: 1,
      review_status: "needs_review", sync_status: "not_requested",
      pdf_storage_path: "/objects/invoice-68", vendor_name: "Supplier", supplier_id: null,
      invoice_number: "W-68", invoice_date: "2026-01-01", currency: "USD",
      subtotal: 100, tax_amount: 5, total_amount: 105,
      wafeq_supplier_id: "wafeq-supplier-68", wafeq_account_id: "account-68", wafeq_tax_id: "tax-invalid",
      line_items: [{ description: "Service", quantity: 1, unit_price: 100, account_code: "6000", tax_rate: .05 }],
    };
    access.role = "member";
    access.allowedPages = ["ai-invoice-import"];
    listTaxRates.mockResolvedValueOnce([rate === undefined ? { id: "tax-invalid" } : { id: "tax-invalid", rate }]);
    getObjectEntityFile.mockResolvedValueOnce({ exists: vi.fn().mockResolvedValue([true]) });
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT i.* FROM ai_invoice_imports")) return { rowCount: 1, rows: [invoice] };
      if (sql.includes("SELECT encrypted_api_key")) return { rowCount: 1, rows: [{ encrypted_api_key: "enc:key", organization_id: "org-1", status: "configured" }] };
      if (sql.includes("SELECT accounting_system FROM finance_entities")) return { rowCount: 1, rows: [{ accounting_system: "wafeq" }] };
      if (sql.includes("SELECT settings_json")) return { rowCount: 0, rows: [] };
      if (sql.includes("SELECT 1 FROM ai_invoice_imports")) return { rowCount: 0, rows: [] };
      if (sql.includes("WITH approved AS")) return { rowCount: 1, rows: [{ ...invoice, review_status: "approved", sync_status: "pending", review_version: 2, attempt_id: 969 }] };
      return { rowCount: 1, rows: [] };
    });

    const response = await request(app).post("/finance/invoice-review/68/approve").send({ version: 1 });

    expect(response.status).toBe(422);
    expect(response.body.validation.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ issue_key: "wafeq.tax.rate_invalid", blocking: true }),
    ]));
    expect(query.mock.calls.some(([sql]) => String(sql).includes("WITH approved AS"))).toBe(false);
  });

  it("approves a Wafeq review with a valid zero tax rate", async () => {
    const invoice = {
      id: 69, entity_id: 7, workspace_owner_id: "w", review_version: 1,
      review_status: "needs_review", sync_status: "not_requested",
      pdf_storage_path: "/objects/invoice-69", vendor_name: "Supplier", supplier_id: null,
      invoice_number: "W-69", invoice_date: "2026-01-01", currency: "USD",
      subtotal: 100, tax_amount: 0, total_amount: 100,
      wafeq_supplier_id: "wafeq-supplier-69", wafeq_account_id: "account-69", wafeq_tax_id: "tax-zero",
      line_items: [{ description: "Service", quantity: 1, unit_price: 100, account_code: "6000", tax_rate: .05 }],
    };
    access.role = "member";
    access.allowedPages = ["ai-invoice-import"];
    listTaxRates.mockResolvedValueOnce([{ id: "tax-zero", rate: 0 }]);
    getObjectEntityFile.mockResolvedValueOnce({ exists: vi.fn().mockResolvedValue([true]) });
    createConnector.mockReturnValueOnce({ createDraftVendorBill: vi.fn().mockResolvedValue({ success: true, provider_bill_id: "wb-69", provider_bill_url: "https://wafeq/bills/wb-69" }) });
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT i.* FROM ai_invoice_imports")) return { rowCount: 1, rows: [invoice] };
      if (sql.includes("SELECT encrypted_api_key")) return { rowCount: 1, rows: [{ encrypted_api_key: "enc:key", organization_id: "org-1", status: "configured" }] };
      if (sql.includes("SELECT settings_json")) return { rowCount: 0, rows: [] };
      if (sql.includes("SELECT 1 FROM ai_invoice_imports")) return { rowCount: 0, rows: [] };
      if (sql.includes("WITH approved AS")) return { rowCount: 1, rows: [{ ...invoice, review_status: "approved", sync_status: "pending", review_version: 2, reviewed_snapshot: { ...invoice, line_items: invoice.line_items }, attempt_id: 970 }] };
      if (sql.includes("SELECT accounting_system FROM finance_entities")) return { rowCount: 1, rows: [{ accounting_system: "wafeq" }] };
      if (sql.includes("SELECT * FROM finance_entities")) return { rowCount: 1, rows: [{ id: 7, workspace_owner_id: "w", accounting_system: "wafeq", default_currency: "USD" }] };
      return { rowCount: 1, rows: [] };
    });

    const response = await request(app).post("/finance/invoice-review/69/approve").send({ version: 1 });

    expect(response.status).toBe(200);
  });

  it("approves a Wafeq review with decrypted credentials and explicit external mappings", async () => {
    const invoice = {
      id: 61, entity_id: 7, workspace_owner_id: "w", review_version: 1,
      review_status: "needs_review", sync_status: "not_requested",
       pdf_storage_path: "/objects/invoice-61", vendor_name: "Supplier", supplier_id: null,
      invoice_number: "W-61", invoice_date: "2026-01-01", currency: "USD",
      subtotal: 100, tax_amount: 5, total_amount: 105,
      wafeq_supplier_id: 123, wafeq_account_id: 456, wafeq_tax_id: 789,
      line_items: [{ description: "Service", quantity: 1, unit_price: 100, total: 100, account_code: "6000", tax_rate: .05 }],
    };
    access.role = "member";
    access.allowedPages = ["ai-invoice-import"];
    decryptCredential.mockImplementation(async (value: string) => value === "enc:key" ? "server-only-key" : value);
    listTaxRates.mockResolvedValueOnce([{ id: "789", rate: 5 }]);
    getObjectEntityFile.mockResolvedValueOnce({ exists: vi.fn().mockResolvedValue([true]) });
    createConnector.mockReturnValueOnce({ createDraftVendorBill: vi.fn().mockResolvedValue({ success: true, provider_bill_id: "wb-61", provider_bill_url: "https://wafeq/bills/wb-61" }) });
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT i.* FROM ai_invoice_imports")) return { rowCount: 1, rows: [invoice] };
      if (sql.includes("SELECT encrypted_api_key")) return { rowCount: 1, rows: [{ encrypted_api_key: "enc:key", organization_id: "org-1", status: "configured" }] };
      if (sql.includes("SELECT settings_json")) return { rowCount: 0, rows: [] };
      if (sql.includes("SELECT 1 FROM ai_invoice_imports")) return { rowCount: 0, rows: [] };
      if (sql.includes("WITH approved AS")) return { rowCount: 1, rows: [{ ...invoice, review_status: "approved", sync_status: "pending", review_version: 2, reviewed_snapshot: { ...invoice, line_items: invoice.line_items }, attempt_id: 961 }] };
      if (sql.includes("SELECT accounting_system FROM finance_entities")) return { rowCount: 1, rows: [{ accounting_system: "wafeq" }] };
      if (sql.includes("SELECT * FROM finance_entities")) return { rowCount: 1, rows: [{ id: 7, workspace_owner_id: "w", accounting_system: "wafeq", default_currency: "USD" }] };
      return { rowCount: 1, rows: [] };
    });

    const response = await request(app).post("/finance/invoice-review/61/approve").send({ version: 1 });
    expect(response.status).toBe(200);
    expect(decryptCredential).toHaveBeenCalledWith("enc:key", expect.any(Function));
    const connectorEntity = createConnector.mock.calls[0][0];
    expect(connectorEntity).toEqual(expect.objectContaining({ wafeq_api_key: "server-only-key", wafeq_organization_id: "org-1", wafeq_supplier_id: "123", wafeq_tax_id: "789" }));
    const billData = createConnector.mock.results[0].value.createDraftVendorBill.mock.calls[0][2];
    expect(billData).toEqual(expect.objectContaining({ external_supplier_id: "123", external_tax_rate_id: "789", manual_accounting_reference: null }));
    expect(billData.line_items[0]).toEqual(expect.objectContaining({ external_account_id: "456" }));
    expect(billData.line_items[0].account_code).toBe("6000");
    expect(billData.line_items[0].tax_rate).toBeUndefined();
  });

  it("rejects non-numeric review ids before querying", async () => {
    const response = await request(app).get("/finance/invoice-review/queue/source");
    // queue is declared before :id and requires its entity selector.
    expect(response.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
  it("rejects invalid detail ids", async () => {
    const response = await request(app).get("/finance/invoice-review/not-an-id");
    expect(response.status).toBe(400);
  });
  it("serves a stored historical source without requiring invoice review to be enabled", async () => {
    query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{
        id: 41,
        workspace_owner_id: "w",
        pdf_storage_path: "/objects/private/historical-scan",
        original_filename: "fallback.pdf",
        source_metadata: { mime_type: "image/png", filename: "historical-scan.png" },
      }],
    });
    getObjectEntityFile.mockResolvedValueOnce({
      download: vi.fn().mockResolvedValue([Buffer.from("historical invoice")]),
    });

    const response = await request(app).get("/finance/invoice-review/41/source");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(/^image\/png/);
    expect(response.headers["content-disposition"]).toBe('inline; filename="historical-scan.png"');
    expect(response.body).toEqual(Buffer.from("historical invoice"));
    expect(query).toHaveBeenCalledWith(
      expect.not.stringContaining("invoice_review_enabled"),
      [41, "w"],
    );
    expect(getObjectEntityFile).toHaveBeenCalledWith("/objects/private/historical-scan");
  });

  it("keeps download disposition and sanitizes source filenames", async () => {
    query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{
        id: 42,
        workspace_owner_id: "w",
        pdf_storage_path: "/objects/private/reviewed-scan",
        original_filename: "invoice.pdf",
        source_metadata: { mime_type: "application/pdf", filename: 'invoice"\r\n.pdf' },
      }],
    });
    getObjectEntityFile.mockResolvedValueOnce({
      download: vi.fn().mockResolvedValue([Buffer.from("%PDF")]),
    });

    const response = await request(app).get("/finance/invoice-review/42/source?download=true");

    expect(response.status).toBe(200);
    expect(response.headers["content-disposition"]).toBe('attachment; filename="invoice.pdf"');
  });

  it("rejects sources outside the active workspace without reading storage", async () => {
    query.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const response = await request(app).get("/finance/invoice-review/43/source");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Source document is unavailable" });
    expect(query).toHaveBeenCalledWith(expect.any(String), [43, "w"]);
    expect(getObjectEntityFile).not.toHaveBeenCalled();
  });

  it("rejects imports that have no stored source", async () => {
    query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: 44, workspace_owner_id: "w", pdf_storage_path: null }],
    });

    const response = await request(app).get("/finance/invoice-review/44/source");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Source document is unavailable" });
    expect(getObjectEntityFile).not.toHaveBeenCalled();
  });

  it("redacts storage failures as unavailable documents", async () => {
    query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: 45, workspace_owner_id: "w", pdf_storage_path: "/objects/private/missing" }],
    });
    getObjectEntityFile.mockRejectedValueOnce(new Error("provider path and credentials"));

    const response = await request(app).get("/finance/invoice-review/45/source");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Source document is unavailable" });
    expect(response.text).not.toContain("provider path");
  });

  it("requires finance access before looking up a source", async () => {
    access.role = "member";

    const response = await request(app).get("/finance/invoice-review/46/source");

    expect(response.status).toBe(403);
    expect(query).not.toHaveBeenCalled();
    expect(getObjectEntityFile).not.toHaveBeenCalled();
  });

  it("returns a generic not-found without applying the retired entity flag", async () => {
    query.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const response = await request(app).get("/finance/invoice-review/47");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Review invoice not found" });
    expect(query).toHaveBeenCalledWith(
      expect.not.stringContaining("invoice_review_enabled"),
      [47, "w"],
    );
  });
  it("returns the active workspace supplier linked to the review", async () => {
    query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 48, entity_id: 7, workspace_owner_id: "w", supplier_id: 91, vendor_name: "Paper Co" }] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ legal_name: "Entity" }] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 91, name: "Paper Company LLC", display_name: "Paper Co" }] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValue({ rowCount: 0, rows: [] });

    const response = await request(app).get("/finance/invoice-review/48");

    expect(response.status).toBe(200);
    expect(response.body.resolved_supplier).toEqual({ id: 91, name: "Paper Company LLC", display_name: "Paper Co" });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("is_archived=false"),
      [91, "w"],
    );
  });

  it("requires authoritative Odoo evidence instead of a linked supplier ledger row for synced status", async () => {
    query
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ count: "1" }] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{
          id: 32,
          workspace_owner_id: "w",
          review_status: "approved",
          sync_status: "succeeded",
          pdf_storage_path: null,
        }],
      });

    const response = await request(app).get("/finance/invoice-review/queue?sync_status=succeeded");

    expect(response.status).toBe(200);
    expect(response.body.imports[0].sync_status).toBe("succeeded");
    expect(response.body.total).toBe(1);
    const [, countSql, rowSql] = query.mock.calls.map(([sql]) => String(sql));
    for (const sql of [countSql, rowSql]) {
      expect(sql).toContain("i.provider_sync_status='succeeded'");
      expect(sql).toContain("nullif(i.odoo_bill_id,'') IS NOT NULL");
      expect(sql).toContain("osa.destination='odoo'");
      expect(sql).toContain("osa.status='succeeded'");
      expect(sql).not.toContain("FROM supplier_invoices linked_invoice");
    }
    expect(countSql).toContain("THEN 'succeeded'");
    expect(rowSql).toContain("sync_status");
  });

  it("searches the full queue by vendor, linked supplier, invoice number, and exact total with accurate filtered counts", async () => {
    access.role = "member";
    access.allowedPages = ["ai-invoice-import"];
    query
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ count: "2" }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 81, workspace_owner_id: "w", pdf_storage_path: null }] });

    const response = await request(app).get("/finance/invoice-review/queue")
      .query({
        search: "105.50",
        entity_id: 7,
        review_status: "needs_review",
        sync_status: "not_requested",
        date_from: "2026-01-01",
        date_to: "2026-12-31",
        limit: 50,
        offset: 50,
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ total: 2, limit: 50, offset: 50 });
    const [, countSql, rowSql] = query.mock.calls.map(([sql]) => String(sql));
    for (const sql of [countSql, rowSql]) {
      expect(sql).toContain("i.workspace_owner_id=$1");
      expect(sql).toContain("i.entity_id=$2");
      expect(sql).toContain("i.review_status=$3");
      expect(sql).toContain("i.vendor_name ILIKE $5");
      expect(sql).toContain("i.invoice_number ILIKE $5");
      expect(sql).toContain("sf.name ILIKE $5");
      expect(sql).toContain("sf.display_name ILIKE $5");
      expect(sql).toContain("sf.workspace_owner_id=i.workspace_owner_id");
      expect(sql).toContain("i.total_amount=$6::numeric");
      expect(sql).toContain("i.invoice_date >= $7");
      expect(sql).toContain("i.invoice_date <= $8");
    }
    expect(query.mock.calls[1][1]).toEqual(["w", 7, "needs_review", "not_requested", "%105.50%", "105.50", "2026-01-01", "2026-12-31", 50, 50]);
    expect(query.mock.calls[2][1]).toEqual(["w", 7, "needs_review", "not_requested", "%105.50%", "105.50", "2026-01-01", "2026-12-31", 50, 50]);
  });

  it("uses case-insensitive text search without treating invoice-number text as an amount", async () => {
    query
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ count: "1" }] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const response = await request(app).get("/finance/invoice-review/queue?search=AcMe-INV");

    expect(response.status).toBe(200);
    const [countSql] = query.mock.calls[1];
    expect(String(countSql)).toContain("i.vendor_name ILIKE $2");
    expect(String(countSql)).toContain("i.invoice_number ILIKE $2");
    expect(String(countSql)).not.toContain("i.total_amount=");
    expect(query.mock.calls[1][1]).toEqual(["w", "%AcMe-INV%", 50, 0]);
  });

  it("validates invoice queue search input", async () => {
    const response = await request(app).get(`/finance/invoice-review/queue?search=${"x".repeat(201)}`);
    expect(response.status).toBe(400);
    expect(response.body.error).toContain("200 characters");
    expect(query).not.toHaveBeenCalled();
  });

  it("returns deterministic navigation from the exact filtered queue across pagination", async () => {
    const invoice = {
      id: 63,
      entity_id: 7,
      workspace_owner_id: "w",
      created_at: "2026-06-01T00:00:00.000Z",
      review_status: "needs_review",
      sync_status: "not_requested",
    };
    query
      .mockResolvedValueOnce({ rowCount: 1, rows: [invoice] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ previous_id: 62, next_id: 64, position: "51", total: "73" }] });

    const response = await request(app).get("/finance/invoice-review/63/neighbors")
      .query({
        entity_id: 7,
        review_status: "needs_review",
        sync_status: "not_requested",
        search: "Acme",
        date_from: "2026-01-01",
        date_to: "2026-12-31",
        limit: 50,
        offset: 50,
        order: "created_at_desc",
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ previous_id: 62, next_id: 64, position: 51, total: 73 });
    const [sql, params] = query.mock.calls[1];
    expect(sql).toContain("row_number() OVER (ORDER BY i.created_at DESC,i.id DESC)");
    expect(sql).toContain("i.review_status=$3");
    expect(sql).toContain("i.invoice_date >= $6");
    expect(params).toEqual(["w", 7, "needs_review", "not_requested", "%Acme%", "2026-01-01", "2026-12-31", 63]);
  });

  it("reports a stale failed sync on an unapproved invoice as awaiting sync", async () => {
    query
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ count: "1" }] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{
          id: 42,
          workspace_owner_id: "w",
          review_status: "needs_review",
          sync_status: "not_requested",
          pdf_storage_path: "/objects/private/invoice-42",
        }],
      });

    const response = await request(app).get("/finance/invoice-review/queue?sync_status=not_requested");

    expect(response.status).toBe(200);
    expect(response.body.imports[0].sync_status).toBe("not_requested");
    const [, countSql, rowSql] = query.mock.calls.map(([sql]) => String(sql));
    for (const sql of [countSql, rowSql]) {
      expect(sql).toContain("i.review_status <> 'approved'");
      expect(sql).toContain("i.sync_status='failed'");
      expect(sql).toContain("THEN 'not_requested'");
    }
  });

  it("clears a stale failed sync when saving an unapproved review draft", async () => {
    const invoice = {
      id: 43,
      entity_id: 7,
      workspace_owner_id: "w",
      review_version: 2,
      review_status: "needs_review",
      sync_status: "failed",
      vendor_name: "Raidan Floriculture S.A.R.L.",
      invoice_number: "SF2602534",
      invoice_date: "2026-09-08",
      currency: "USD",
      total_amount: 465.645,
      line_items: [],
    };
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT i.* FROM ai_invoice_imports")) return { rowCount: 1, rows: [invoice] };
      if (sql.includes("WITH changed AS")) return { rowCount: 1, rows: [{ ...invoice, sync_status: "not_requested", review_version: 3 }] };
      if (sql.includes("SELECT settings_json")) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [] };
    });

    const response = await request(app)
      .patch("/finance/invoice-review/43/draft")
      .send({ version: 2, supplier_id: 3 });

    expect(response.status).toBe(200);
    expect(response.body.invoice.sync_status).toBe("not_requested");
    const saveSql = query.mock.calls.find(([sql]) => String(sql).includes("WITH changed AS"))?.[0];
    expect(String(saveSql)).toContain("sync_status='not_requested'");
    expect(String(saveSql)).toContain("error_message=NULL");
  });

  it("requires an external destination before syncing an already-approved invoice", async () => {
    access.role = "member";
    access.allowedPages = ["ai-invoice-import"];
    const invoice = {
          id: 36,
          entity_id: 7,
          workspace_owner_id: "w",
          review_version: 1,
          review_status: "approved",
          sync_status: "not_requested",
          reviewed_snapshot: { invoice_number: "SF2602521", line_items: [] },
    };
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT i.* FROM ai_invoice_imports")) return { rowCount: 1, rows: [invoice] };
      if (sql.includes("SELECT * FROM finance_entities")) {
        return { rowCount: 1, rows: [{ id: 7, workspace_owner_id: "w", accounting_system: "none", default_currency: "USD" }] };
      }
      return { rowCount: 0, rows: [] };
    });

    const response = await request(app)
      .post("/finance/invoice-review/36/sync")
      .send({ version: 1, idempotency_key: "approved-sync:36:1" });

    expect(response.status).toBe(422);
    expect(response.body.error).toMatch(/destination/i);
    expect(syncImportedSupplierInvoice).not.toHaveBeenCalled();
  });

  it("reconciles Odoo again before repairing a succeeded provider idempotency key", async () => {
    access.role = "member";
    access.allowedPages = ["ai-invoice-import"];
    const invoice = {
      id: 62, entity_id: 7, workspace_owner_id: "w", review_version: 4,
      review_status: "approved", sync_status: "failed", provider_sync_status: "failed",
      provider_bill_id: "provider-62", odoo_bill_id: "provider-62",
      accounting_destination: "odoo", pdf_storage_path: "/objects/62.pdf",
      vendor_name: "Repair Supplier", invoice_number: "INV-62", invoice_date: "2026-09-17",
      currency: "USD", subtotal: 10, tax_amount: 0, total_amount: 10,
      line_items: [{ description: "Flowers", quantity: 1, unit_price: 10, total: 10, account_code: "601101" }],
    };
    const entity = { id: 7, workspace_owner_id: "w", accounting_system: "odoo", default_currency: "USD" };
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT i.* FROM ai_invoice_imports")) return { rowCount: 1, rows: [invoice] };
      if (sql.includes("SELECT * FROM finance_entities")) return { rowCount: 1, rows: [entity] };
      if (sql.includes("INSERT INTO ai_invoice_import_sync_attempts")) return { rowCount: 0, rows: [] };
      if (sql.includes("SELECT status,destination,external_reference,error")) {
        return { rowCount: 1, rows: [{ status: "succeeded", destination: "odoo", external_reference: "provider-62", error: null }] };
      }
      if (sql.includes("SELECT settings_json") || sql.includes("SELECT 1 FROM ai_invoice_imports")) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [] };
    });
    createConnector.mockReturnValueOnce({ createDraftVendorBill: vi.fn().mockResolvedValue({
      success: true, provider_bill_id: "provider-62", outcome: "verified_existing",
      provider_supplier_id: 301, provider_supplier_name: "Repair Supplier", provider_supplier_tax_number: "LB123",
    }) });
    getObjectEntityFile.mockResolvedValueOnce({ exists: vi.fn().mockResolvedValue([true]) });

    const response = await request(app)
      .post("/finance/invoice-review/62/retry-sync")
      .send({ version: 4, idempotency_key: "retry:62:4" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({ success: true, idempotent: true, external_reference: "provider-62" }));
    expect(createConnector).toHaveBeenCalledTimes(1);
    expect(linkImportedInvoiceToVerifiedOdooSupplier).toHaveBeenCalledWith(
      62, "w", { id: 301, name: "Repair Supplier", taxNumber: "LB123" }, expect.anything(),
    );
    expect(syncImportedSupplierInvoice).toHaveBeenCalledWith(62, "w", expect.anything());
  });

  it("passes the confirmed Odoo partner authoritatively through the immediate retry", async () => {
    const invoice = {
      id: 81, entity_id: 7, workspace_owner_id: "w", review_version: 2,
      review_status: "approved", sync_status: "needs_supplier_confirmation",
      provider_sync_status: "needs_supplier_confirmation", supplier_id: 12,
      vendor_name: "Descriptive imported name", invoice_number: "INV-81",
      invoice_date: "2026-09-17", currency: "USD", subtotal: 10, tax_amount: 0, total_amount: 10,
      pdf_storage_path: "/objects/81.pdf", line_items: [{ description: "Flowers", quantity: 1, unit_price: 10, total: 10, account_code: "601101" }],
      supplier_confirmation: { candidates: [{ id: 301, name: "Canonical Supplier", tax_number: "LB123", score: 94 }] },
      reviewed_snapshot: { vendor_name: "Descriptive imported name", invoice_number: "INV-81", invoice_date: "2026-09-17", currency: "USD", subtotal: 10, tax_amount: 0, total_amount: 10, line_items: [{ description: "Flowers", quantity: 1, unit_price: 10, total: 10, account_code: "601101" }] },
    };
    const createDraftVendorBill = vi.fn().mockResolvedValue({ success: true, provider_bill_id: "odoo-81", provider_supplier_id: 301 });
    createConnector.mockReturnValue({ createDraftVendorBill });
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT i.* FROM ai_invoice_imports")) return { rowCount: 1, rows: [invoice] };
      if (sql.includes("duplicate") || sql.includes("upper(trim(invoice_number))")) return { rowCount: 0, rows: [] };
      if (sql.startsWith("SELECT 1 FROM ai_invoice_imports")) return { rowCount: 0, rows: [] };
      if (sql.includes("SELECT * FROM finance_entities")) return { rowCount: 1, rows: [{ id: 7, workspace_owner_id: "w", accounting_system: "odoo", default_currency: "USD" }] };
      if (sql.includes("INSERT INTO ai_invoice_import_sync_attempts")) return { rowCount: 1, rows: [{ id: 981, status: "pending" }] };
      return { rowCount: 1, rows: [] };
    });
    const response = await request(app)
      .post("/finance/invoice-review/81/confirm-supplier")
      .send({ provider_supplier_id: 301 });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ success: true, bill_id: "odoo-81" });
    expect(linkImportedInvoiceToVerifiedOdooSupplier).toHaveBeenCalled();
    const data = createDraftVendorBill.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(data).toEqual(expect.objectContaining({ supplier_id: 12, odoo_partner_id: 301, partner_id: 301 }));
  });

  it.each([
    ["automatic Lebanese routing", null, "odoo"],
    ["an explicit reviewer override", "wafeq", "wafeq"],
  ])("uses %s when retrying a failed invoice", async (_case, accountingDestination, expectedDestination) => {
    access.role = "member";
    access.allowedPages = ["ai-invoice-import"];
    const invoice = {
      id: 73,
      entity_id: 7,
      workspace_owner_id: "w",
      review_version: 4,
      review_status: "approved",
      sync_status: "failed",
      provider_sync_status: "failed",
      provider_bill_id: "old-wafeq-bill",
      provider_bill_url: "https://wafeq.example/old-wafeq-bill",
      accounting_destination: accountingDestination,
      billing_country: "LB",
      pdf_storage_path: "/objects/invoice-73",
      vendor_name: "Lebanese Supplier",
      invoice_number: "LB-73",
      invoice_date: "2026-09-16",
      currency: "USD",
      subtotal: 10,
      tax_amount: 1.1,
      total_amount: 11.1,
      line_items: [{ description: "Flowers", quantity: 1, unit_price: 10, total: 10, tax_rate: .11 }],
      reviewed_snapshot: {
        vendor_name: "Lebanese Supplier",
        invoice_number: "LB-73",
        invoice_date: "2026-09-16",
        currency: "USD",
        subtotal: 10,
        tax_amount: 1.1,
        total_amount: 11.1,
        billing_country: "LB",
        line_items: [{ description: "Flowers", quantity: 1, unit_price: 10, total: 10, tax_rate: .11 }],
      },
    };
    const createDraftVendorBill = vi.fn().mockResolvedValue({
      success: true,
      provider_bill_id: `${expectedDestination}-retry-73`,
      provider_bill_url: `https://${expectedDestination}.example/retry-73`,
      ...(expectedDestination === "odoo" ? {
        provider_supplier_id: 301,
        provider_supplier_name: "Lebanese Supplier",
        provider_supplier_tax_number: "LB123",
      } : {}),
    });
    createConnector.mockReturnValueOnce({ createDraftVendorBill });
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT i.* FROM ai_invoice_imports")) return { rowCount: 1, rows: [invoice] };
      if (sql.includes("provider_sync_status='pending'") && sql.includes("RETURNING *")) {
        return {
          rowCount: 1,
          rows: [{
            ...invoice,
            sync_status: "not_requested",
            provider_sync_status: "pending",
            provider_sync_error: null,
            error_message: null,
          }],
        };
      }
      if (sql.includes("SELECT * FROM finance_entities")) {
        return {
          rowCount: 1,
          rows: [{
            id: 7,
            workspace_owner_id: "w",
            accounting_system: "wafeq",
            country: "AE",
            legal_name: "Wafeq-default entity",
            default_currency: "USD",
          }],
        };
      }
      if (sql.includes("SELECT encrypted_api_key")) {
        return { rowCount: 1, rows: [{ encrypted_api_key: "enc:stored-key", organization_id: "org-1", status: "configured" }] };
      }
      if (sql.includes("INSERT INTO ai_invoice_import_sync_attempts")) return { rowCount: 1, rows: [{ id: 973, status: "pending" }] };
      if (sql.includes("SELECT settings_json") || sql.includes("SELECT 1 FROM ai_invoice_imports")) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [] };
    });

    const response = await request(app)
      .post("/finance/invoice-review/73/retry-sync")
      .send({ version: 4, idempotency_key: `retry:73:${expectedDestination}` });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      destination: expectedDestination,
      external_reference: `${expectedDestination}-retry-73`,
      sync: { status: "succeeded", destination: expectedDestination },
    });
    const attemptInsert = query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO ai_invoice_import_sync_attempts"));
    expect(attemptInsert?.[1]?.[3]).toBe(expectedDestination);
    const importUpdate = query.mock.calls.find(([sql]) => String(sql).includes("UPDATE ai_invoice_imports SET sync_status=$1"));
    expect(importUpdate?.[1]).toEqual(expect.arrayContaining([
      expectedDestination === "odoo" ? "in_progress" : "succeeded",
      `${expectedDestination}-retry-73`,
      expectedDestination,
    ]));
    expect(createDraftVendorBill).toHaveBeenCalledTimes(1);
    expect(createConnector).toHaveBeenCalledWith(expect.objectContaining({ accounting_system: expectedDestination }));
    expect(syncImportedSupplierInvoice).toHaveBeenCalledWith(
      73,
      "w",
      ...(expectedDestination === "odoo" ? [expect.anything()] : []),
    );
  });

  it("returns a feature-level failure when the accounting provider is unavailable", async () => {
    const invoice = {
      id: 37, entity_id: 7, workspace_owner_id: "w", review_version: 1,
      review_status: "approved", sync_status: "not_requested",
      pdf_storage_path: "/objects/invoice-37",
      vendor_name: "Supplier 37", invoice_number: "INV-37", invoice_date: "2026-09-16",
      currency: "USD", subtotal: 10, tax_amount: 0, total_amount: 10,
      line_items: [{ description: "Flowers", quantity: 1, unit_price: 10, total: 10 }],
      reviewed_snapshot: {
        vendor_name: "Supplier 37", invoice_number: "INV-37", invoice_date: "2026-09-16",
        currency: "USD", subtotal: 10, tax_amount: 0, total_amount: 10,
        line_items: [{ description: "Flowers", quantity: 1, unit_price: 10, total: 10 }],
      },
    };
    createConnector.mockReturnValueOnce({
      createDraftVendorBill: vi.fn().mockRejectedValue(new Error("provider network unavailable")),
    });
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT i.* FROM ai_invoice_imports")) return { rowCount: 1, rows: [invoice] };
      if (sql.includes("INSERT INTO ai_invoice_import_sync_attempts")) return { rowCount: 1, rows: [{ id: 902, status: "pending" }] };
      if (sql.includes("SELECT * FROM finance_entities")) return {
        rowCount: 1,
        rows: [{ id: 7, workspace_owner_id: "w", accounting_system: "odoo", default_currency: "USD" }],
      };
      if (sql.includes("SELECT settings_json") || sql.includes("SELECT 1 FROM ai_invoice_imports")) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [] };
    });

    const response = await request(app)
      .post("/finance/invoice-review/37/sync")
      .send({ version: 1, idempotency_key: "provider-outage:37:1" });

    expect(response.status).toBe(502);
    expect(response.body).toEqual(expect.objectContaining({
      success: false,
      error: expect.stringContaining("provider network unavailable"),
    }));
    expect(query.mock.calls.some(([sql]) => String(sql).includes("UPDATE ai_invoice_import_sync_attempts SET status=$1"))).toBe(true);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("SET sync_status=$1"))).toBe(true);
  });

  it("does not mutate recovery state for a stale manual retry version", async () => {
    const invoice = {
      id: 137, entity_id: 7, workspace_owner_id: "w", review_version: 3,
      review_status: "approved", sync_status: "failed", provider_sync_status: "failed",
    };
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT i.* FROM ai_invoice_imports")) return { rowCount: 1, rows: [invoice] };
      return { rowCount: 0, rows: [] };
    });

    const response = await request(app)
      .post("/finance/invoice-review/137/retry-sync")
      .send({ version: 2, idempotency_key: "retry:137:stale-version" });

    expect(response.status).toBe(400);
    expect(query.mock.calls.some(([sql]) =>
      String(sql).includes("UPDATE ai_invoice_imports")
      && String(sql).includes("provider_sync_status='pending'"))).toBe(false);
    expect(query.mock.calls.some(([sql, params]) =>
      String(sql).includes("ai_invoice_import_audit_events")
      && Array.isArray(params)
      && params[2] === "automatic_sync_recovery_reset")).toBe(false);
    expect(createConnector).not.toHaveBeenCalled();
  });

  it("continues a manual retry through canonical Odoo recovery after ledger-only repair fails", async () => {
    const invoice = {
      id: 138, entity_id: 7, workspace_owner_id: "w", review_version: 4,
      review_status: "approved", sync_status: "failed", provider_sync_status: "succeeded",
      provider_bill_id: "odoo-138", odoo_bill_id: "odoo-138", supplier_id: 77,
      accounting_destination: "odoo", billing_country: "LB", pdf_storage_path: "/objects/invoice-138.pdf",
      vendor_name: "Supplier 138", invoice_number: "INV-138", invoice_date: "2026-09-16",
      currency: "USD", subtotal: 10, tax_amount: 0, total_amount: 10,
      line_items: [{ description: "Flowers", quantity: 1, unit_price: 10, total: 10, account_code: "601101", tax_rate: 0 }],
      reviewed_snapshot: {
        vendor_name: "Supplier 138", invoice_number: "INV-138", invoice_date: "2026-09-16",
        currency: "USD", subtotal: 10, tax_amount: 0, total_amount: 10,
        line_items: [{ description: "Flowers", quantity: 1, unit_price: 10, total: 10, account_code: "601101", tax_rate: 0 }],
      },
    };
    const refreshed = { ...invoice, sync_status: "not_requested", provider_sync_status: "pending", provider_sync_error: null, error_message: null };
    const createDraftVendorBill = vi.fn().mockResolvedValue({
      success: true, outcome: "verified_existing", provider_bill_id: "odoo-138",
      provider_supplier_id: 301, provider_supplier_name: "Supplier 138",
    });
    createConnector.mockReturnValue({ createDraftVendorBill });
    syncImportedSupplierInvoice
      .mockRejectedValueOnce(new Error("stale local ledger"))
      .mockResolvedValueOnce(undefined);
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT i.* FROM ai_invoice_imports")) return { rowCount: 1, rows: [invoice] };
      if (sql.includes("SELECT status") && sql.includes("lease_until")) return { rowCount: 0, rows: [] };
      if (sql.includes("provider_sync_status='pending'") && sql.includes("RETURNING *")) return { rowCount: 1, rows: [refreshed] };
      if (sql.includes("SELECT * FROM finance_entities")) {
        return { rowCount: 1, rows: [{ id: 7, workspace_owner_id: "w", accounting_system: "odoo", default_currency: "USD" }] };
      }
      if (sql.includes("SELECT external_reference FROM ai_invoice_import_sync_attempts")) {
        return { rowCount: 1, rows: [{ external_reference: "odoo-138" }] };
      }
      if (sql.includes("SELECT 1 FROM ai_invoice_imports")) return { rowCount: 0, rows: [] };
      if (sql.includes("INSERT INTO ai_invoice_import_sync_attempts")) return { rowCount: 1, rows: [{ id: 1138, status: "pending" }] };
      return { rowCount: 1, rows: [] };
    });

    const response = await request(app)
      .post("/finance/invoice-review/138/retry-sync")
      .send({ version: 4, idempotency_key: "retry:138:one-pass" });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ success: true, external_reference: "odoo-138" });
    expect(createDraftVendorBill).toHaveBeenCalledTimes(1);
    expect(createDraftVendorBill.mock.calls[0]?.[2]).toEqual(expect.objectContaining({ provider_bill_id: "odoo-138" }));
    expect(syncImportedSupplierInvoice).toHaveBeenCalledTimes(2);
    const resetSql = String(query.mock.calls.find(([sql]) =>
      String(sql).includes("provider_sync_status='pending'") && String(sql).includes("RETURNING *"))?.[0]);
    expect(resetSql).toContain("review_version=$3");
    expect(resetSql).toContain("review_status='approved'");
    expect(resetSql).toContain("superseded_by_import_id IS NULL");
    expect(resetSql).toContain("NOT EXISTS");
    expect(refreshed).toMatchObject({
      provider_bill_id: "odoo-138",
      odoo_bill_id: "odoo-138",
      supplier_id: 77,
      pdf_storage_path: "/objects/invoice-138.pdf",
      reviewed_snapshot: invoice.reviewed_snapshot,
    });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("DELETE FROM ai_invoice_import_sync_attempts"))).toBe(false);
  });

  it("releases the claimed attempt when the approved lifecycle changes before the final lock", async () => {
    const invoice = {
      id: 139, entity_id: 7, workspace_owner_id: "w", review_version: 1,
      review_status: "approved", sync_status: "not_requested", provider_sync_status: "pending",
      accounting_destination: "odoo", pdf_storage_path: "/objects/invoice-139.pdf",
      vendor_name: "Supplier 139", invoice_number: "INV-139", invoice_date: "2026-09-16",
      currency: "USD", subtotal: 10, tax_amount: 0, total_amount: 10,
      line_items: [{ description: "Flowers", quantity: 1, unit_price: 10, total: 10 }],
    };
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT i.* FROM ai_invoice_imports")) return { rowCount: 1, rows: [invoice] };
      if (sql.includes("SELECT status") && sql.includes("lease_until")) return { rowCount: 0, rows: [] };
      if (sql.includes("SELECT * FROM finance_entities")) {
        return { rowCount: 1, rows: [{ id: 7, workspace_owner_id: "w", accounting_system: "odoo", default_currency: "USD" }] };
      }
      if (sql.includes("SELECT 1 FROM ai_invoice_imports")) return { rowCount: 0, rows: [] };
      if (sql.includes("INSERT INTO ai_invoice_import_sync_attempts")) return { rowCount: 1, rows: [{ id: 1139, status: "pending" }] };
      if (sql.includes("SET status='in_progress',lease_token")) return { rowCount: 1, rows: [] };
      if (sql.includes("SET sync_status='in_progress'")) return { rowCount: 0, rows: [] };
      if (sql.includes("Invoice lifecycle or claim was lost")) return { rowCount: 1, rows: [] };
      return { rowCount: 1, rows: [] };
    });

    const response = await request(app)
      .post("/finance/invoice-review/139/sync")
      .send({ version: 1, idempotency_key: "sync:139:lifecycle-race" });

    expect(response.status).toBe(409);
    const cleanup = query.mock.calls.find(([sql]) => String(sql).includes("Invoice lifecycle or claim was lost"));
    expect(String(cleanup?.[0])).toContain("lease_until=NULL");
    expect(cleanup?.[1]).toEqual([1139, expect.any(String)]);
    expect(createConnector).not.toHaveBeenCalled();
  });

  it("skips a bulk recovery reset that loses a live-lease or lifecycle race", async () => {
    const invoice = {
      id: 140, entity_id: 9, workspace_owner_id: "w", review_version: 2,
      review_status: "approved", sync_status: "blocked", provider_sync_status: "failed",
      accounting_destination: "odoo", pdf_storage_path: "/objects/invoice-140.pdf",
    };
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM finance_entities")) {
        return { rowCount: 1, rows: [{
          id: 9, workspace_owner_id: "w", accounting_system: "odoo",
          odoo_base_url: "https://odoo.example", odoo_database: "presentail_prod", odoo_company_id: 2,
        }] };
      }
      if (sql.includes("FROM ai_invoice_imports") && sql.includes("ORDER BY id ASC")) return { rowCount: 1, rows: [invoice] };
      if (sql.includes("provider_sync_status='pending'") && sql.includes("RETURNING *")) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [] };
    });

    const response = await request(app)
      .post("/finance/invoice-review/sync-approved-to-odoo")
      .send({ entity_id: 9 });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      synced: 0,
      skipped: 1,
      results: [{ invoice_id: 140, status: "skipped", reason_code: "active_sync" }],
    });
    const bulkReclaimSql = String(query.mock.calls.find(([sql]) =>
      String(sql).includes("Stale sync ownership reclaimed by Sync All"))?.[0]);
    expect(bulkReclaimSql).toContain("status IN ('pending','in_progress')");
    expect(bulkReclaimSql).toContain("lease_token IS NOT NULL");
    expect(bulkReclaimSql).toContain("lease_until IS NOT NULL");
    expect(bulkReclaimSql).toContain("lease_until-interval '5 minutes' > now()-interval '2 minutes'");
    expect(query.mock.calls.some(([sql, params]) =>
      String(sql).includes("ai_invoice_import_audit_events")
      && Array.isArray(params)
      && params[2] === "automatic_sync_recovery_reset")).toBe(false);
    expect(createConnector).not.toHaveBeenCalled();
  });

  it("allocates a fresh retry attempt when a failed local key is replayed", async () => {
    const invoice = {
      id: 38, entity_id: 7, workspace_owner_id: "w", review_version: 2,
      review_status: "approved", sync_status: "failed", provider_sync_status: "failed",
      pdf_storage_path: "/objects/invoice-38",
      vendor_name: "Supplier 38", invoice_number: "INV-38", invoice_date: "2026-09-16",
      currency: "USD", subtotal: 10, tax_amount: 0, total_amount: 10,
      line_items: [{ description: "Flowers", quantity: 1, unit_price: 10, total: 10, account_code: "601101" }],
      reviewed_snapshot: {
        vendor_name: "Supplier 38", invoice_number: "INV-38", invoice_date: "2026-09-16",
        currency: "USD", subtotal: 10, tax_amount: 0, total_amount: 10,
        line_items: [{ description: "Flowers", quantity: 1, unit_price: 10, total: 10, account_code: "601101" }],
      },
    };
    createConnector.mockReturnValueOnce({
      createDraftVendorBill: vi.fn().mockResolvedValue({
        success: true,
        provider_bill_id: "odoo-38",
        provider_supplier_id: 301,
        provider_supplier_name: "Supplier 38",
      }),
    });
    let attemptInsertCount = 0;
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("SELECT i.* FROM ai_invoice_imports")) return { rowCount: 1, rows: [invoice] };
      if (sql.includes("SELECT * FROM finance_entities")) {
        return { rowCount: 1, rows: [{ id: 7, workspace_owner_id: "w", accounting_system: "odoo", default_currency: "USD" }] };
      }
      if (sql.includes("INSERT INTO ai_invoice_import_sync_attempts")) {
        attemptInsertCount++;
        return attemptInsertCount === 1
          ? { rowCount: 0, rows: [] }
          : { rowCount: 1, rows: [{ id: 904, status: "pending" }] };
      }
      if (sql.includes("SELECT status,destination,external_reference,error")) {
        return { rowCount: 1, rows: [{ id: 903, status: "failed", destination: "odoo", external_reference: null, error: "old failure", active: false }] };
      }
      if (sql.includes("SELECT settings_json") || sql.includes("SELECT 1 FROM ai_invoice_imports")) return { rowCount: 0, rows: [] };
      if (sql.includes("UPDATE ai_invoice_import_sync_attempts SET status='in_progress'")) return { rowCount: 1, rows: [] };
      if (sql.includes("UPDATE ai_invoice_imports SET sync_status='in_progress'")) return { rowCount: 1, rows: [] };
      void params;
      return { rowCount: 1, rows: [] };
    });

    const response = await request(app)
      .post("/finance/invoice-review/38/retry-sync")
      .send({ version: 2, idempotency_key: "retry:38:stale" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({ success: true, external_reference: "odoo-38" }));
    expect(attemptInsertCount).toBe(2);
    const retryInsert = query.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO ai_invoice_import_sync_attempts"))[1];
    expect(retryInsert?.[1]?.[1]).toMatch(/^retry:38:2:/);
    expect(retryInsert?.[1]?.[1]).not.toBe("retry:38:stale");
  });

  it("returns an active-sync conflict for a normal sync key held by a live lease", async () => {
    const invoice = {
      id: 39, entity_id: 7, workspace_owner_id: "w", review_version: 1,
      review_status: "approved", sync_status: "failed",
      vendor_name: "Supplier 39", invoice_number: "INV-39", invoice_date: "2026-09-16",
      currency: "USD", subtotal: 10, tax_amount: 0, total_amount: 10,
      line_items: [{ description: "Flowers", quantity: 1, unit_price: 10, total: 10 }],
    };
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT i.* FROM ai_invoice_imports")) return { rowCount: 1, rows: [invoice] };
      if (sql.includes("SELECT * FROM finance_entities")) {
        return { rowCount: 1, rows: [{ id: 7, workspace_owner_id: "w", accounting_system: "odoo", odoo_default_expense_account_id: 383 }] };
      }
      if (sql.includes("FROM ai_invoice_import_sync_attempts") && sql.includes("lease_until")) {
        return { rowCount: 1, rows: [{ status: "in_progress" }] };
      }
      if (sql.includes("INSERT INTO ai_invoice_import_sync_attempts")) return { rowCount: 0, rows: [] };
      if (sql.includes("SELECT status,destination,external_reference,error")) {
        return { rowCount: 1, rows: [{ id: 991, status: "in_progress", destination: "odoo", active: true }] };
      }
      return { rowCount: 0, rows: [] };
    });

    const response = await request(app)
      .post("/finance/invoice-review/39/sync")
      .send({ version: 1, idempotency_key: "fresh-key:39:1" });

    expect(response.status).toBe(409);
    expect(response.body).toEqual(expect.objectContaining({ error: "Sync attempt is already active", sync_status: "in_progress" }));
    expect(query.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO ai_invoice_import_sync_attempts"))).toHaveLength(0);
    expect(createConnector).not.toHaveBeenCalled();
    expect(syncImportedSupplierInvoice).not.toHaveBeenCalled();
  });

  it("reclaims an expired lease and stale local in-progress state, then syncs in the same request", async () => {
    const invoice = {
      id: 141, entity_id: 7, workspace_owner_id: "w", review_version: 2,
      review_status: "approved", sync_status: "in_progress", provider_sync_status: "in_progress",
      accounting_destination: "odoo", pdf_storage_path: "/objects/invoice-141.pdf",
      vendor_name: "Supplier 141", invoice_number: "INV-141", invoice_date: "2026-09-18",
      currency: "USD", subtotal: 25, tax_amount: 0, total_amount: 25,
      line_items: [{ description: "Flowers", quantity: 1, unit_price: 25, total: 25 }],
      reviewed_snapshot: {
        vendor_name: "Supplier 141", invoice_number: "INV-141", invoice_date: "2026-09-18",
        currency: "USD", subtotal: 25, tax_amount: 0, total_amount: 25,
        line_items: [{ description: "Flowers", quantity: 1, unit_price: 25, total: 25 }],
      },
    };
    const recovered = { ...invoice, sync_status: "not_requested", provider_sync_status: "pending" };
    const createDraftVendorBill = vi.fn().mockResolvedValue({
      success: true,
      provider_bill_id: "odoo-141",
      provider_supplier_id: 301,
      provider_supplier_name: "Supplier 141",
    });
    createConnector.mockReturnValue({ createDraftVendorBill });
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT i.* FROM ai_invoice_imports")) return { rowCount: 1, rows: [invoice] };
      if (sql.includes("Stale sync ownership reclaimed at")) return { rowCount: 1, rows: [{ id: 1140 }] };
      if (sql.includes("id AS attempt_id")) return { rowCount: 0, rows: [] };
      if (sql.includes("sync_status='not_requested'") && sql.includes("RETURNING *")) return { rowCount: 1, rows: [recovered] };
      if (sql.includes("SELECT * FROM finance_entities")) {
        return { rowCount: 1, rows: [{ id: 7, workspace_owner_id: "w", accounting_system: "odoo", default_currency: "USD" }] };
      }
      if (sql.includes("INSERT INTO ai_invoice_import_sync_attempts")) return { rowCount: 1, rows: [{ id: 1141, status: "pending" }] };
      if (sql.includes("SELECT settings_json") || sql.includes("SELECT 1 FROM ai_invoice_imports")) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [] };
    });

    const response = await request(app)
      .post("/finance/invoice-review/141/sync")
      .send({ version: 2, idempotency_key: "sync:141:reclaimed" });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({ success: true, external_reference: "odoo-141" });
    expect(createDraftVendorBill).toHaveBeenCalledTimes(1);
    const reclaimSql = String(query.mock.calls.find(([sql]) => String(sql).includes("Stale sync ownership reclaimed at"))?.[0]);
    expect(reclaimSql).toContain("status IN ('pending','in_progress')");
    expect(reclaimSql).toContain("lease_token IS NOT NULL");
    expect(reclaimSql).toContain("lease_until IS NOT NULL");
    expect(reclaimSql).toContain("lease_until-interval '5 minutes' > now()-interval '2 minutes'");
    expect(reclaimSql).toContain("lease_token=NULL");
    expect(query.mock.calls.some(([sql, params]) =>
      String(sql).includes("ai_invoice_import_audit_events")
      && Array.isArray(params)
      && params[2] === "stale_sync_ownership_reclaimed")).toBe(true);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("DELETE FROM ai_invoice_import_sync_attempts"))).toBe(false);
  });

  it("clears an orphaned in-progress invoice with no attempt and continues in the same request", async () => {
    const invoice = {
      id: 143, entity_id: 7, workspace_owner_id: "w", review_version: 1,
      review_status: "approved", sync_status: "in_progress", provider_sync_status: "in_progress",
      accounting_destination: "odoo", pdf_storage_path: "/objects/invoice-143.pdf",
      vendor_name: "Supplier 143", invoice_number: "INV-143", invoice_date: "2026-09-18",
      currency: "USD", subtotal: 15, tax_amount: 0, total_amount: 15,
      line_items: [{ description: "Flowers", quantity: 1, unit_price: 15, total: 15 }],
      reviewed_snapshot: {
        vendor_name: "Supplier 143", invoice_number: "INV-143", invoice_date: "2026-09-18",
        currency: "USD", subtotal: 15, tax_amount: 0, total_amount: 15,
        line_items: [{ description: "Flowers", quantity: 1, unit_price: 15, total: 15 }],
      },
    };
    const recovered = { ...invoice, sync_status: "not_requested", provider_sync_status: "pending" };
    const createDraftVendorBill = vi.fn().mockResolvedValue({
      success: true,
      provider_bill_id: "odoo-143",
      provider_bill_status: "posted",
      provider_supplier_id: 301,
      provider_supplier_name: "Supplier 143",
      outcome: "recovered",
      warnings: ["posted_bill_recovered_by_supplier_reference", "posted_provider_representation_preserved"],
    });
    createConnector.mockReturnValue({ createDraftVendorBill });
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT i.* FROM ai_invoice_imports")) return { rowCount: 1, rows: [invoice] };
      if (sql.includes("Stale sync ownership reclaimed at")) return { rowCount: 0, rows: [] };
      if (sql.includes("id AS attempt_id")) return { rowCount: 0, rows: [] };
      if (sql.includes("sync_status='not_requested'") && sql.includes("RETURNING *")) return { rowCount: 1, rows: [recovered] };
      if (sql.includes("SELECT * FROM finance_entities")) {
        return { rowCount: 1, rows: [{ id: 7, workspace_owner_id: "w", accounting_system: "odoo", default_currency: "USD" }] };
      }
      if (sql.includes("INSERT INTO ai_invoice_import_sync_attempts")) return { rowCount: 1, rows: [{ id: 1143, status: "pending" }] };
      if (sql.includes("SELECT settings_json") || sql.includes("SELECT 1 FROM ai_invoice_imports")) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [] };
    });

    const response = await request(app)
      .post("/finance/invoice-review/143/retry-sync")
      .send({ version: 1, idempotency_key: "retry:143:orphaned" });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({ success: true, external_reference: "odoo-143" });
    expect(createDraftVendorBill).toHaveBeenCalledTimes(1);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("sync_status='not_requested'"))).toBe(true);
    const recoveryAudit = query.mock.calls.find(([sql, params]) =>
      String(sql).includes("ai_invoice_import_audit_events")
      && Array.isArray(params)
      && params[2] === "sync_recovered");
    expect(recoveryAudit?.[1]?.[3]).toContain("posted_bill_recovered_by_supplier_reference");
  });

  it("returns live lease owner and timestamps without calling Odoo", async () => {
    const invoice = {
      id: 142, entity_id: 7, workspace_owner_id: "w", review_version: 1,
      review_status: "approved", sync_status: "in_progress",
    };
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT i.* FROM ai_invoice_imports")) return { rowCount: 1, rows: [invoice] };
      if (sql.includes("SELECT * FROM finance_entities")) {
        return { rowCount: 1, rows: [{ id: 7, workspace_owner_id: "w", accounting_system: "odoo", odoo_default_expense_account_id: 383 }] };
      }
      if (sql.includes("Stale sync ownership reclaimed at")) return { rowCount: 0, rows: [] };
      if (sql.includes("id AS attempt_id")) {
        return {
          rowCount: 1,
          rows: [{
            attempt_id: 1142,
            status: "in_progress",
            destination: "odoo",
            idempotency_key: "sync:142:active",
            started_at: "2026-09-22T06:00:00.000Z",
            lease_until: "2026-09-22T06:05:00.000Z",
            heartbeat_age_seconds: 42,
          }],
        };
      }
      return { rowCount: 0, rows: [] };
    });

    const response = await request(app)
      .post("/finance/invoice-review/142/sync")
      .send({ version: 1, idempotency_key: "sync:142:other" });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      error: "Sync attempt is already active",
      active_attempt: {
        attempt_id: 1142,
        destination: "odoo",
        idempotency_key: "sync:142:active",
        started_at: "2026-09-22T06:00:00.000Z",
        lease_until: "2026-09-22T06:05:00.000Z",
        heartbeat_age_seconds: 42,
      },
    });
    expect(createConnector).not.toHaveBeenCalled();
  });

  it("retries a failed historical key on the normal sync endpoint with a fresh local key", async () => {
    const invoice = {
      id: 40, entity_id: 7, workspace_owner_id: "w", review_version: 1,
      review_status: "approved", sync_status: "failed", provider_sync_status: "failed",
      vendor_name: "Supplier 40", invoice_number: "INV-40", invoice_date: "2026-09-16",
      currency: "USD", subtotal: 10, tax_amount: 0, total_amount: 10,
      accounting_destination: "odoo", billing_country: "LB", pdf_storage_path: "/objects/invoice-40.pdf",
      line_items: [{ description: "Flowers", quantity: 1, unit_price: 10, total: 10, account_code: "601101", tax_rate: 0 }],
      reviewed_snapshot: {
        vendor_name: "Supplier 40", invoice_number: "INV-40", invoice_date: "2026-09-16",
        currency: "USD", subtotal: 10, tax_amount: 0, total_amount: 10, billing_country: "LB",
        line_items: [{ description: "Flowers", quantity: 1, unit_price: 10, total: 10, account_code: "601101", tax_rate: 0 }],
      },
    };
    const createDraftVendorBill = vi.fn().mockResolvedValue({
      success: true, provider_bill_id: "odoo-40", outcome: "verified_existing",
      provider_supplier_id: 301, provider_supplier_name: "Supplier 40", provider_supplier_tax_number: "LB123",
    });
    createConnector.mockReturnValue({ createDraftVendorBill });
    let insertCount = 0;
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT i.* FROM ai_invoice_imports")) return { rowCount: 1, rows: [invoice] };
      if (sql.includes("SELECT * FROM finance_entities")) return { rowCount: 1, rows: [{ id: 7, workspace_owner_id: "w", accounting_system: "odoo", default_currency: "USD" }] };
      if (sql.includes("INSERT INTO ai_invoice_import_sync_attempts")) {
        insertCount += 1;
        return insertCount === 1 ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [{ id: 994, status: "pending" }] };
      }
      if (sql.includes("SELECT status,destination,external_reference,error")) {
        return { rowCount: 1, rows: [{ id: 993, status: "failed", destination: "odoo", active: false }] };
      }
      if (sql.includes("SELECT 1 FROM ai_invoice_imports")) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [] };
    });

    const response = await request(app)
      .post("/finance/invoice-review/40/sync")
      .send({ version: 1, idempotency_key: "approved-sync:40:1" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({ success: true, external_reference: "odoo-40" }));
    expect(insertCount).toBe(2);
    const inserts = query.mock.calls.filter(([sql]) => String(sql).includes("INSERT INTO ai_invoice_import_sync_attempts"));
    expect(inserts[1]?.[1]?.[1]).toMatch(/^retry:40:1:/);
    expect(createDraftVendorBill).toHaveBeenCalledTimes(1);
    expect(syncImportedSupplierInvoice).toHaveBeenCalledTimes(1);
  });

  it("persists the existing Odoo bill identity when supporting PDF attachment fails", async () => {
    const invoice = {
      id: 74,
      entity_id: 7,
      workspace_owner_id: "w",
      review_version: 2,
      review_status: "approved",
      sync_status: "failed",
      provider_sync_status: "failed",
      pdf_storage_path: "/objects/invoice-74",
      vendor_name: "Raidan Floriculture S.A.R.L.", invoice_number: "SF2602616", invoice_date: "2026-09-15",
      currency: "USD", subtotal: 224, tax_amount: 24.64, total_amount: 248.64,
      line_items: [{ description: "Flowers", quantity: 1, unit_price: 224, total: 224, tax_rate: .11 }],
      reviewed_snapshot: {
        vendor_name: "Raidan Floriculture S.A.R.L.", invoice_number: "SF2602616", invoice_date: "2026-09-15",
        currency: "USD", subtotal: 224, tax_amount: 24.64, total_amount: 248.64,
        line_items: [{ description: "Flowers", quantity: 1, unit_price: 224, total: 224, tax_rate: .11 }],
      },
    };
    createConnector.mockReturnValueOnce({
      createDraftVendorBill: vi.fn().mockResolvedValue({
        success: false,
        provider_bill_id: "55768",
        provider_bill_url: "https://odoo.example/web#id=55768&model=account.move&view_type=form",
        provider_bill_status: "draft",
        error: "Odoo supporting attachment upload failed",
      }),
    });
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT i.* FROM ai_invoice_imports")) return { rowCount: 1, rows: [invoice] };
      if (sql.includes("SELECT * FROM finance_entities")) {
        return {
          rowCount: 1,
          rows: [{
            id: 7,
            workspace_owner_id: "w",
            accounting_system: "odoo",
            default_currency: "USD",
          }],
        };
      }
      if (sql.includes("INSERT INTO ai_invoice_import_sync_attempts")) {
        return { rowCount: 1, rows: [{ id: 974, status: "pending" }] };
      }
      if (sql.includes("SELECT settings_json") || sql.includes("SELECT 1 FROM ai_invoice_imports")) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [] };
    });

    const response = await request(app)
      .post("/finance/invoice-review/74/retry-sync")
      .send({ version: 2, idempotency_key: "retry:74:attachment" });

    expect(response.status).toBe(502);
    expect(response.body).toMatchObject({
      success: false,
      external_reference: "55768",
      error: "Odoo supporting attachment upload failed",
    });
    const attemptUpdate = query.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE ai_invoice_import_sync_attempts SET status=$1"));
    expect(attemptUpdate?.[1]).toEqual(expect.arrayContaining(["failed", "55768"]));
    const importUpdate = query.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE ai_invoice_imports SET sync_status=$1"));
    expect(importUpdate?.[1]).toEqual(expect.arrayContaining([
      "failed",
      "55768",
      "draft",
      "Odoo supporting attachment upload failed",
      "odoo",
    ]));
  });

  it("preserves a known Odoo bill identity when the sync attempt lease is lost", async () => {
    const invoice = {
      id: 75,
      entity_id: 7,
      workspace_owner_id: "w",
      review_version: 3,
      review_status: "approved",
      sync_status: "failed",
      provider_sync_status: "failed",
      pdf_storage_path: "/objects/invoice-75",
      vendor_name: "Raidan Floriculture S.A.R.L.", invoice_number: "SF2602616", invoice_date: "2026-09-15",
      currency: "USD", subtotal: 224, tax_amount: 24.64, total_amount: 248.64,
      line_items: [{ description: "Flowers", quantity: 1, unit_price: 224, total: 224, tax_rate: .11 }],
      reviewed_snapshot: {
        vendor_name: "Raidan Floriculture S.A.R.L.", invoice_number: "SF2602616", invoice_date: "2026-09-15",
        currency: "USD", subtotal: 224, tax_amount: 24.64, total_amount: 248.64,
        line_items: [{ description: "Flowers", quantity: 1, unit_price: 224, total: 224, tax_rate: .11 }],
      },
    };
    createConnector.mockReturnValueOnce({
      createDraftVendorBill: vi.fn().mockResolvedValue({
        success: false,
        provider_bill_id: "55768",
        provider_bill_url: "https://odoo.example/web#id=55768&model=account.move&view_type=form",
        provider_bill_status: "draft",
        error: "Odoo supporting attachment upload failed",
      }),
    });
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT i.* FROM ai_invoice_imports")) return { rowCount: 1, rows: [invoice] };
      if (sql.includes("SELECT * FROM finance_entities")) {
        return {
          rowCount: 1,
          rows: [{
            id: 7,
            workspace_owner_id: "w",
            accounting_system: "odoo",
            default_currency: "USD",
          }],
        };
      }
      if (sql.includes("INSERT INTO ai_invoice_import_sync_attempts")) {
        return { rowCount: 1, rows: [{ id: 975, status: "pending" }] };
      }
      if (sql.includes("UPDATE ai_invoice_import_sync_attempts SET status=$1")) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes("SELECT settings_json") || sql.includes("SELECT 1 FROM ai_invoice_imports")) return { rowCount: 0, rows: [] };
      if (sql.includes("RETURNING provider_bill_id")) {
        return { rowCount: 1, rows: [{ provider_bill_id: "55768" }] };
      }
      return { rowCount: 1, rows: [] };
    });

    const response = await request(app)
      .post("/finance/invoice-review/75/retry-sync")
      .send({ version: 3, idempotency_key: "retry:75:lease-loss" });

    expect(response.status).toBe(502);
    expect(response.body).toMatchObject({
      success: false,
      external_reference: "55768",
      error: expect.stringContaining("retry will reconcile the existing bill"),
    });
    const identityFallback = query.mock.calls.find(([sql]) =>
      String(sql).includes("RETURNING provider_bill_id"));
    expect(identityFallback?.[0]).toContain("(provider_bill_id IS NULL OR provider_bill_id=$1)");
    expect(identityFallback?.[1]).toEqual([
      "55768",
      "https://odoo.example/web#id=55768&model=account.move&view_type=form",
      "draft",
      expect.stringContaining("retry will reconcile the existing bill"),
      "odoo",
      75,
      "w",
    ]);
    expect(query.mock.calls.some(([sql]) =>
      String(sql).includes("provider_sync_status=CASE WHEN provider_sync_status='succeeded'"))).toBe(true);
  });

  it("approves non-Wafeq invoices while retaining missing-field issues as warnings", async () => {
    access.role = "member";
    access.allowedPages = ["ai-invoice-import"];
    const invoice = {
      id: 48, entity_id: 7, workspace_owner_id: "w", review_version: 3,
      review_status: "needs_review", sync_status: "not_requested",
      pdf_storage_path: "/objects/private/invoice-48", vendor_name: "Supplier",
      invoice_number: "INV-48", invoice_date: "2026-09-08", currency: "USD",
      subtotal: 100, tax_amount: 5, total_amount: 105,
      line_items: [{ description: "Paper", quantity: 1, unit_price: 100, account_code: "6000", tax_rate: .05 }],
      supplier_id: null,
    };
    getObjectEntityFile.mockResolvedValueOnce({ exists: vi.fn().mockResolvedValue([true]) });
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT i.* FROM ai_invoice_imports")) return { rowCount: 1, rows: [invoice] };
      if (sql.includes("SELECT settings_json")) return { rowCount: 0, rows: [] };
      if (sql.includes("WITH approved AS")) return { rowCount: 1, rows: [{ ...invoice, review_status: "approved", sync_status: "pending", review_version: 4, attempt_id: 904 }] };
      if (sql.includes("SELECT * FROM finance_entities")) return { rowCount: 1, rows: [{ id: 7, workspace_owner_id: "w", accounting_system: "none", default_currency: "USD" }] };
      if (sql.includes("SET status='in_progress'")) return { rowCount: 1, rows: [] };
      return { rowCount: 1, rows: [] };
    });

    const response = await request(app).post("/finance/invoice-review/48/approve").send({ version: 3 });

    expect(response.status).toBe(200);
    expect(response.body.sync).toEqual(expect.objectContaining({ status: "not_requested", deferred: true }));
    expect(response.body.validation.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ issue_key: "supplier.unresolved", blocking: false, severity: "warning" }),
    ]));
    expect(query.mock.calls.some(([sql]) => String(sql).includes("WITH approved AS"))).toBe(false);
  });

  it("merges the current canonical invoice before approval and preserves every source in metadata/audit", async () => {
    access.role = "member";
    access.allowedPages = ["ai-invoice-import"];
    const smaller = {
      id: 101, entity_id: 7, workspace_owner_id: "w", review_version: 1,
      review_status: "needs_review", sync_status: "not_requested", provider_sync_status: "pending",
      pdf_storage_path: "/objects/split-small.pdf", original_filename: "split-small.pdf",
      source_metadata: { filename: "split-small.pdf" }, source_batch_id: null,
      vendor_name: "Supplier SAL", supplier_id: 55, invoice_number: "SF2602254",
      invoice_date: "2026-09-08", currency: "USD", subtotal: 71.99, tax_amount: 0, total_amount: 71.99,
      line_items: [{ description: "Page one", quantity: 1, unit_price: 71.99, total: 71.99 }],
    };
    const canonical = {
      ...smaller, id: 102, review_version: 4, sync_status: "not_requested",
      pdf_storage_path: "/objects/split-final.pdf", original_filename: "split-final.pdf",
      source_metadata: { filename: "split-final.pdf" }, subtotal: 500, tax_amount: 63.5, total_amount: 563.5,
      raw_ai_json: { total_label: "GRAND TOTAL" },
      line_items: [{ description: "Page two", quantity: 1, unit_price: 428.01, total: 428.01 }],
    };
    let merged = false;
    query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("SELECT i.* FROM ai_invoice_imports")) return { rowCount: 1, rows: [smaller] };
      if (sql.includes("FOR UPDATE")) return merged ? { rowCount: 1, rows: [canonical] } : { rowCount: 2, rows: [smaller, canonical] };
      if (sql.includes("SET line_items=$1")) {
        merged = true;
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("ai_invoice_import_issues")) return { rowCount: 1, rows: [] };
      if (sql.includes("superseded_by_import_id=$1")) return { rowCount: 1, rows: [] };
      if (sql.includes("SELECT * FROM ai_invoice_imports WHERE id=$1")) return { rowCount: 1, rows: [canonical] };
      if (sql.includes("SELECT settings_json")) return { rowCount: 0, rows: [] };
      if (sql.includes("SELECT accounting_system,country")) return { rowCount: 1, rows: [{ accounting_system: "none", country: "US", legal_name: "Company", display_name: "Company" }] };
      if (sql.includes("SET review_status='approved'")) return { rowCount: 1, rows: [{ ...canonical, review_status: "approved", review_version: 6, sync_status: "not_requested" }] };
      if (sql.includes("SELECT * FROM finance_entities")) return { rowCount: 1, rows: [{ id: 7, workspace_owner_id: "w", accounting_system: "none", default_currency: "USD" }] };
      return { rowCount: 1, rows: [] };
    });
    getObjectEntityFile.mockResolvedValue({ exists: vi.fn().mockResolvedValue([true]) });

    const response = await request(app)
      .post("/finance/invoice-review/101/approve")
      .send({ version: 1, sync: false });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.invoice.id).toBe(102);
    const canonicalUpdate = query.mock.calls.find(([sql]) => String(sql).includes("SET line_items=$1"));
    expect(canonicalUpdate?.[0]).toContain("source_metadata=coalesce(source_metadata");
    const sourceArchive = JSON.parse(String(canonicalUpdate?.[1]?.[5]));
    expect(sourceArchive.merged_source_ids).toEqual([101, 102]);
    expect(sourceArchive.merged_source_documents).toEqual(expect.arrayContaining([
      expect.objectContaining({ import_id: 101, path: "/objects/split-small.pdf" }),
      expect.objectContaining({ import_id: 102, path: "/objects/split-final.pdf" }),
    ]));
    const auditCalls = query.mock.calls.filter(([sql, params]) =>
      String(sql).includes("INSERT INTO ai_invoice_import_audit_events")
      && ["multi_page_merged", "multi_page_superseded"].includes(String((params as unknown[])[1])),
    );
    expect(auditCalls).toHaveLength(2);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("issue_key IN ('duplicate.risk','multi_page_review_required')"))).toBe(true);
  });

  it("never approves or syncs a superseded split source separately", async () => {
    access.role = "member";
    access.allowedPages = ["ai-invoice-import"];
    const superseded = {
      id: 111, entity_id: 7, workspace_owner_id: "w", review_version: 2,
      review_status: "needs_review", sync_status: "superseded",
      superseded_by_import_id: 112, supersede_reason: "multi_page_invoice_merge",
      invoice_number: "SF2602254", supplier_id: 55,
    };
    const canonical = {
      ...superseded,
      id: 112,
      review_status: "approved",
      sync_status: "succeeded",
      superseded_by_import_id: null,
      supersede_reason: null,
    };
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("SELECT i.* FROM ai_invoice_imports")) {
        return { rowCount: 1, rows: [Number(params?.[0]) === 111 ? superseded : canonical] };
      }
      if (sql.includes("SELECT * FROM ai_invoice_imports WHERE id=$1")) return { rowCount: 1, rows: [superseded] };
      return { rowCount: 0, rows: [] };
    });

    const response = await request(app)
      .post("/finance/invoice-review/111/approve")
      .send({ version: 2, sync: false });

    expect(response.status).toBe(409);
    expect(response.body.error).toContain("unsynced");
    expect(query.mock.calls.some(([sql]) => String(sql).includes("SET review_status='approved'"))).toBe(false);
    expect(createConnector).not.toHaveBeenCalled();
  });

  it("supports queue approval with sync explicitly deferred", async () => {
    access.role = "member";
    access.allowedPages = ["ai-invoice-import"];
    const invoice = {
      id: 70, entity_id: 7, workspace_owner_id: "w", review_version: 5,
      review_status: "needs_review", sync_status: "not_requested",
      pdf_storage_path: "/objects/private/invoice-70", vendor_name: "Supplier",
      invoice_number: "INV-70", invoice_date: "2026-09-08", currency: "USD",
      subtotal: 100, tax_amount: 5, total_amount: 105,
      line_items: [{ description: "Paper", quantity: 1, unit_price: 100, account_code: "6000", tax_rate: .05 }],
      supplier_id: null,
    };
    getObjectEntityFile.mockResolvedValueOnce({ exists: vi.fn().mockResolvedValue([true]) });
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT i.* FROM ai_invoice_imports")) return { rowCount: 1, rows: [invoice] };
      if (sql.includes("SELECT settings_json")) return { rowCount: 0, rows: [] };
      if (sql.includes("SELECT accounting_system,country")) return { rowCount: 1, rows: [{ accounting_system: "none", country: "US", legal_name: "Company", display_name: "Company" }] };
      if (sql.startsWith("UPDATE ai_invoice_imports")) return { rowCount: 1, rows: [{ ...invoice, review_status: "approved", review_version: 6, sync_status: "not_requested" }] };
      if (sql.includes("SELECT * FROM finance_entities")) return { rowCount: 1, rows: [{ id: 7, workspace_owner_id: "w", accounting_system: "none", default_currency: "USD" }] };
      return { rowCount: 1, rows: [] };
    });

    const response = await request(app).post("/finance/invoice-review/70/approve").send({ version: 5, sync: false });

    expect(response.status).toBe(200);
    expect(response.body.sync).toEqual({ status: "not_requested", destination: "none", deferred: true });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("WITH approved AS"))).toBe(false);
    expect(createConnector).not.toHaveBeenCalled();
  });

  it("isolates mixed bulk approval results and keeps blockers unapproved", async () => {
    access.role = "member";
    access.allowedPages = ["ai-invoice-import"];
    const validInvoice = {
      id: 71, entity_id: 7, workspace_owner_id: "w", review_version: 1,
      review_status: "needs_review", sync_status: "not_requested",
      pdf_storage_path: "/objects/private/invoice-71", vendor_name: "Supplier",
      invoice_number: "INV-71", invoice_date: "2026-09-08", currency: "USD",
      subtotal: 100, tax_amount: 5, total_amount: 105,
      line_items: [{ description: "Paper", quantity: 1, unit_price: 100, account_code: "6000", tax_rate: .05 }],
      supplier_id: null,
    };
    const blockedInvoice = {
      ...validInvoice,
      id: 72,
      review_version: 2,
      invoice_number: "INV-72",
      pdf_storage_path: null,
    };
    getObjectEntityFile
      .mockResolvedValueOnce({ exists: vi.fn().mockResolvedValue([true]) });
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("historical_merge_discovery")) return { rowCount: 0, rows: [] };
      if (sql.includes("SELECT id,review_version,superseded_by_import_id FROM ai_invoice_imports")) {
        return { rowCount: 2, rows: [{ id: 71, review_version: 1, superseded_by_import_id: null }, { id: 72, review_version: 2, superseded_by_import_id: null }] };
      }
      if (sql.includes("WITH RECURSIVE chain")) return { rowCount: 2, rows: [validInvoice, blockedInvoice] };
      if (sql.includes("SELECT settings_json")) return { rowCount: 0, rows: [] };
      if (sql.includes("SELECT accounting_system,country")) return { rowCount: 1, rows: [{ accounting_system: "none", country: "US", legal_name: "Company", display_name: "Company" }] };
      if (sql.includes("WITH input AS")) return { rowCount: 1, rows: [{ id: 71, review_version: 2 }] };
      if (sql.startsWith("UPDATE ai_invoice_imports")) return { rowCount: 1, rows: [{ ...validInvoice, review_status: "approved", review_version: 2, sync_status: "not_requested" }] };
      if (sql.includes("SELECT * FROM finance_entities")) return { rowCount: 1, rows: [{ id: 7, workspace_owner_id: "w", accounting_system: "none", default_currency: "USD" }] };
      return { rowCount: 1, rows: [] };
    });

    const response = await request(app)
      .post("/finance/invoice-review/approve-selected")
      .send({ invoice_ids: [71, 72], versions: { "71": 1, "72": 2 } });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ approved: 1, blocked: 1, skipped: 0 });
    expect(response.body.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ invoice_id: 71, status: "approved" }),
      expect.objectContaining({ invoice_id: 72, status: "blocked", reason: "The authenticated source document is unavailable. Restore it before approval." }),
    ]));
    expect(query.mock.calls.filter(([sql]) => String(sql).includes("UPDATE ai_invoice_imports"))).toHaveLength(1);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("ai_invoice_import_sync_attempts"))).toBe(false);
  });

  it("approves 50 eligible invoices with bounded batched database work and no provider calls", async () => {
    access.role = "member";
    access.allowedPages = ["ai-invoice-import"];
    const invoices = Array.from({ length: 50 }, (_, index) => ({
      id: 1000 + index,
      entity_id: 7,
      workspace_owner_id: "w",
      review_version: 1,
      review_status: "needs_review",
      sync_status: "not_requested",
      pdf_storage_path: `/objects/private/invoice-${1000 + index}`,
      vendor_name: "Raidan Floriculture S.A.R.L.",
      invoice_number: `BATCH-${1000 + index}`,
      invoice_date: "2026-09-08",
      currency: "USD",
      subtotal: 100,
      tax_amount: 0,
      total_amount: 100,
      line_items: [{ description: "Flowers", quantity: 1, unit_price: 100, total: 100 }],
      supplier_id: 77,
    }));
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT id,review_version,superseded_by_import_id FROM ai_invoice_imports")) {
        return { rowCount: invoices.length, rows: invoices.map((invoice) => ({ id: invoice.id, review_version: 1, superseded_by_import_id: null })) };
      }
      if (sql.includes("historical_merge_discovery")) return { rowCount: invoices.length, rows: invoices };
      if (sql.includes("WITH RECURSIVE chain")) return { rowCount: invoices.length, rows: invoices };
      if (sql.includes("FROM finance_entities")) {
        return { rowCount: 1, rows: [{ id: 7, workspace_owner_id: "w", accounting_system: "odoo" }] };
      }
      if (sql.includes("FROM ai_invoice_import_settings")) return { rowCount: 0, rows: [] };
      if (sql.includes("FROM ai_invoice_import_issues")) return { rowCount: 0, rows: [] };
      if (sql.includes("FROM ai_invoice_import_acknowledgements")) return { rowCount: 0, rows: [] };
      if (sql.includes("WITH input AS")) {
        return {
          rowCount: invoices.length,
          rows: invoices.map((invoice) => ({ id: invoice.id, review_version: 2 })),
        };
      }
      if (sql.includes("INSERT INTO ai_invoice_import_audit_events")) return { rowCount: invoices.length, rows: [] };
      throw new Error(`Unexpected bulk approval query: ${sql}`);
    });

    const response = await request(app)
      .post("/finance/invoice-review/approve-selected")
      .send({
        invoice_ids: invoices.map((invoice) => invoice.id),
        versions: Object.fromEntries(invoices.map((invoice) => [String(invoice.id), 1])),
      });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({ success: true, approved: 50, blocked: 0, skipped: 0 });
    expect(response.body.results).toHaveLength(50);
    expect(query).toHaveBeenCalledTimes(8);
    expect(query.mock.calls.filter(([sql]) => String(sql).includes("UPDATE ai_invoice_imports"))).toHaveLength(1);
    expect(getObjectEntityFile).not.toHaveBeenCalled();
    expect(createConnector).not.toHaveBeenCalled();
  });

  it("allows Odoo sync when canonical resolution can replace a missing local account code", async () => {
    const invoice = {
      id: 65, entity_id: 7, workspace_owner_id: "w", review_version: 1,
      review_status: "needs_review", sync_status: "not_requested",
      pdf_storage_path: "/objects/private/invoice-65", vendor_name: "Supplier",
      invoice_number: "INV-65", invoice_date: "2026-09-08", currency: "USD",
      subtotal: 100, tax_amount: 5, total_amount: 105,
      line_items: [{ description: "Paper", quantity: 1, unit_price: 100, tax_rate: .05 }],
      supplier_id: 9,
    };
    getObjectEntityFile.mockResolvedValueOnce({ exists: vi.fn().mockResolvedValue([true]) });
    createConnector.mockReturnValueOnce({
      createDraftVendorBill: vi.fn().mockResolvedValue({ success: true, provider_bill_id: "odoo-65" }),
    });
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT i.* FROM ai_invoice_imports")) return { rowCount: 1, rows: [invoice] };
      if (sql.includes("SELECT accounting_system FROM finance_entities")) return { rowCount: 1, rows: [{ accounting_system: "odoo" }] };
      if (sql.includes("SELECT settings_json")) return { rowCount: 0, rows: [] };
      if (sql.includes("SELECT 1 FROM ai_invoice_imports")) return { rowCount: 0, rows: [] };
      if (sql.includes("WITH approved AS")) return { rowCount: 1, rows: [{ ...invoice, review_status: "approved", sync_status: "pending", review_version: 2, attempt_id: 906 }] };
      if (sql.includes("SELECT * FROM finance_entities")) return { rowCount: 1, rows: [{ id: 7, workspace_owner_id: "w", accounting_system: "odoo", default_currency: "USD" }] };
      return { rowCount: 1, rows: [] };
    });

    const response = await request(app).post("/finance/invoice-review/65/approve").send({ version: 1 });

    expect(response.status).toBe(200);
    expect(response.body.validation.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ issue_key: "account.unmapped.0", field: "line_items.0.account_code", blocking: false, severity: "warning" }),
    ]));
    expect(query.mock.calls.some(([sql]) => String(sql).includes("WITH approved AS"))).toBe(true);
    expect(createConnector).toHaveBeenCalled();
  });

  it("approves an Odoo review when every line has an account code", async () => {
    const invoice = {
      id: 66, entity_id: 7, workspace_owner_id: "w", review_version: 1,
      review_status: "needs_review", sync_status: "not_requested",
      pdf_storage_path: "/objects/private/invoice-66", vendor_name: "Supplier",
      invoice_number: "INV-66", invoice_date: "2026-09-08", currency: "USD",
      subtotal: 100, tax_amount: 5, total_amount: 105,
      line_items: [{ description: "Paper", quantity: 1, unit_price: 100, account_code: "6000", tax_rate: .05 }],
      supplier_id: 9,
    };
    getObjectEntityFile.mockResolvedValueOnce({ exists: vi.fn().mockResolvedValue([true]) });
    createConnector.mockReturnValueOnce({
      createDraftVendorBill: vi.fn().mockResolvedValue({ success: true, provider_bill_id: "odoo-66" }),
    });
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT i.* FROM ai_invoice_imports")) return { rowCount: 1, rows: [invoice] };
      if (sql.includes("SELECT accounting_system FROM finance_entities")) return { rowCount: 1, rows: [{ accounting_system: "odoo" }] };
      if (sql.includes("SELECT settings_json")) return { rowCount: 0, rows: [] };
      if (sql.includes("SELECT 1 FROM ai_invoice_imports")) return { rowCount: 0, rows: [] };
      if (sql.includes("WITH approved AS")) return { rowCount: 1, rows: [{ ...invoice, review_status: "approved", sync_status: "pending", review_version: 2, attempt_id: 907 }] };
      if (sql.includes("SELECT * FROM finance_entities")) return { rowCount: 1, rows: [{ id: 7, workspace_owner_id: "w", accounting_system: "odoo", default_currency: "USD" }] };
      if (sql.includes("UPDATE ai_invoice_import_sync_attempts SET status='in_progress'")) return { rowCount: 1, rows: [] };
      return { rowCount: 1, rows: [] };
    });

    const response = await request(app).post("/finance/invoice-review/66/approve").send({ version: 1 });

    expect(response.status).toBe(200);
    expect(response.body.sync).toEqual(expect.objectContaining({ status: "succeeded", external_reference: "odoo-66" }));
    expect(createConnector).toHaveBeenCalled();
  });

  it("recovers an unapproved invoice carrying a stale failed sync during approval", async () => {
    const invoice = {
      id: 49, entity_id: 7, workspace_owner_id: "w", review_version: 2,
      review_status: "needs_review", sync_status: "failed",
      pdf_storage_path: "/objects/private/invoice-49", vendor_name: "Supplier",
      invoice_number: "INV-49", invoice_date: "2026-09-08", currency: "USD",
      subtotal: 100, tax_amount: 0, total_amount: 100,
      line_items: [{ description: "Paper", quantity: 1, unit_price: 100, account_code: "6000", tax_rate: 0 }],
      supplier_id: 9,
    };
    getObjectEntityFile.mockResolvedValueOnce({ exists: vi.fn().mockResolvedValue([true]) });
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT i.* FROM ai_invoice_imports")) return { rowCount: 1, rows: [invoice] };
      if (sql.includes("SELECT settings_json")) return { rowCount: 0, rows: [] };
      if (sql.includes("SELECT 1 FROM ai_invoice_imports")) return { rowCount: 0, rows: [] };
      if (sql.includes("WITH approved AS")) return { rowCount: 1, rows: [{ ...invoice, review_status: "approved", sync_status: "pending", review_version: 3, attempt_id: 905 }] };
      if (sql.includes("SET review_status='approved'")) return { rowCount: 1, rows: [{ ...invoice, review_status: "approved", sync_status: "not_requested", review_version: 3, attempt_id: null }] };
      if (sql.includes("SELECT * FROM finance_entities")) return { rowCount: 1, rows: [{ id: 7, workspace_owner_id: "w", accounting_system: "none", default_currency: "USD" }] };
      if (sql.includes("SET status='in_progress'")) return { rowCount: 1, rows: [] };
      return { rowCount: 1, rows: [] };
    });

    const response = await request(app).post("/finance/invoice-review/49/approve").send({ version: 2 });

    expect(response.status).toBe(200);
    const approvalSql = query.mock.calls.find(([sql]) => String(sql).includes("SET review_status='approved'"))?.[0];
    expect(String(approvalSql)).toContain("sync_status IN ('not_requested','failed')");
  });

  it("permanently deletes an owned invoice review and its cascaded records", async () => {
    query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 52 }] });

    const response = await request(app).delete("/finance/ai-invoice-import/imports/52");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM ai_invoice_imports"),
      [52, "w"],
    );
  });

  it("blocks review, approval, and sync without invoice review access", async () => {
    access.role = "member";
    expect((await request(app).get("/finance/invoice-review/48")).status).toBe(403);
    expect((await request(app).post("/finance/invoice-review/48/approve").send({ version: 3 })).status).toBe(403);
    expect((await request(app).post("/finance/invoice-review/48/sync").send({ version: 3, idempotency_key: "blocked" })).status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });

  it("lets any member with invoice review access edit a draft", async () => {
    access.role = "member";
    access.allowedPages = ["ai-invoice-import"];
    const invoice = {
      id: 48,
      workspace_owner_id: "w",
      review_version: 3,
      review_status: "needs_review",
      sync_status: "not_requested",
      vendor_name: "Old supplier",
      line_items: [],
    };
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT i.* FROM ai_invoice_imports")) {
        return { rowCount: 1, rows: [invoice] };
      }
      if (sql.includes("WITH changed AS")) {
        return {
          rowCount: 1,
          rows: [{ ...invoice, vendor_name: "Correct supplier", review_version: 4 }],
        };
      }
      return { rowCount: 1, rows: [] };
    });

    const response = await request(app)
      .patch("/finance/invoice-review/48/draft")
      .send({ version: 3, vendor_name: "Correct supplier" });

    expect(response.status).toBe(200);
    expect(response.body.invoice).toEqual(expect.objectContaining({
      vendor_name: "Correct supplier",
      review_version: 4,
    }));
  });

  it("normalizes legacy Wafeq line tax fields without dropping other line data", async () => {
    const invoice = {
      id: 64,
      entity_id: 7,
      workspace_owner_id: "w",
      review_version: 3,
      review_status: "needs_review",
      sync_status: "not_requested",
      invoice_number: "W-64",
      supplier_id: null,
      wafeq_supplier_id: "wafeq-supplier-64",
    };
    const lines = [{
      description: "Consulting",
      quantity: 2,
      unit_price: 50,
      account_code: "6000",
      wafeq_account_id: "account-6000",
      wafeq_tax_id: "legacy-tax",
      tax_rate: .2,
      evidence: { confidence: .9 },
    }];
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("SELECT i.* FROM ai_invoice_imports")) return { rowCount: 1, rows: [invoice] };
      if (sql.includes("SELECT accounting_system FROM finance_entities")) return { rowCount: 1, rows: [{ accounting_system: "wafeq" }] };
      if (sql.includes("WITH changed AS")) {
        return { rowCount: 1, rows: [{ ...invoice, line_items: JSON.parse(String(params?.[0])), review_version: 4 }] };
      }
      if (sql.includes("SELECT settings_json")) return { rowCount: 0, rows: [] };
      if (sql.includes("SELECT 1 FROM ai_invoice_imports")) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [] };
    });

    const response = await request(app)
      .patch("/finance/invoice-review/64/draft")
      .send({ version: 3, line_items: lines });

    expect(response.status).toBe(200);
    const changedCall = query.mock.calls.find(([sql]) => String(sql).includes("WITH changed AS"));
    const persistedLines = JSON.parse(String(changedCall?.[1]?.[0]));
    expect(persistedLines[0]).toEqual({
      description: "Consulting",
      quantity: 2,
      unit_price: 50,
      account_code: "6000",
      wafeq_account_id: "account-6000",
      evidence: { confidence: .9 },
    });
  });

  it("keeps version, lifecycle, and source safeguards on approval", async () => {
    query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 48, review_version: 4, review_status: "needs_review", sync_status: "not_requested" }] });
    expect((await request(app).post("/finance/invoice-review/48/approve").send({ version: 3 })).status).toBe(409);

    query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 48, review_version: 3, review_status: "approved", sync_status: "succeeded" }] });
    expect((await request(app).post("/finance/invoice-review/48/approve").send({ version: 3 })).status).toBe(409);

    query.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 48, review_version: 3, review_status: "needs_review", sync_status: "not_requested", pdf_storage_path: null }] });
    expect((await request(app).post("/finance/invoice-review/48/approve").send({ version: 3 })).status).toBe(422);
  });
});

describe("invoice review source durability", () => {
  it.each([
    ["invoice.pdf", "application/pdf", Buffer.from("%PDF-1.4")],
    ["invoice.jpg", "image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xdb])],
    ["invoice.png", "image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ["invoice.webp", "image/webp", Buffer.from("RIFF0000WEBP")],
  ])("stores %s before accepting the review upload", async (filename, mimeType, sourceBytes) => {
    query.mockReset();
    getObjectEntityUploadURL.mockReset();
    normalizeObjectEntityPath.mockReset();
    extractInvoiceDataFromBuffer.mockResolvedValue({
      vendor_name: null,
      vendor_tax_number: null,
      vendor_address: null,
      invoice_number: null,
      invoice_date: null,
      due_date: null,
      currency: null,
      subtotal: null,
      tax_amount: null,
      total_amount: null,
      line_items: [],
      confidence: 0,
      company_validation_status: "unknown",
      company_validation_notes: null,
      raw_ai_json: {},
      extraction_evidence: { coordinates_available: false, fields: {}, lines: [] },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    getObjectEntityUploadURL.mockResolvedValue({
      signedUrl: "https://storage.example/upload",
      requiredHeaders: { "Content-Type": mimeType, "Content-Length": String(sourceBytes.length) },
    });
    normalizeObjectEntityPath.mockReturnValue("/objects/private/invoice");
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM finance_entities")) return {
        rowCount: 1,
        rows: [{ id: 7, workspace_owner_id: "w", legal_name: "Entity", invoice_review_enabled: true, accounting_system: "none" }],
      };
      if (sql.includes("INSERT INTO ai_invoice_imports")) return { rowCount: 1, rows: [{ id: 42 }] };
      if (sql.includes("SELECT pdf_storage_path")) return { rowCount: 1, rows: [{ pdf_storage_path: "/objects/private/invoice" }] };
      return { rowCount: 1, rows: [] };
    });

    const response = await request(app)
      .post("/finance/ai-invoice-import/upload")
      .field("entity_id", "7")
      .attach("files", sourceBytes, { filename, contentType: mimeType });

    expect(response.status).toBe(202);
    expect(response.body.import_ids).toEqual([42]);
    expect(response.body.failures).toEqual([]);
    expect(getObjectEntityUploadURL).toHaveBeenCalledWith("w", mimeType, sourceBytes.length);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("SET pdf_storage_path"))).toBe(true);
  });

  it("rejects a spoofed PDF whose bytes are not a supported document", async () => {
    query.mockReset();
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM finance_entities")) return {
        rowCount: 1,
        rows: [{ id: 7, workspace_owner_id: "w", legal_name: "Entity", invoice_review_enabled: true, accounting_system: "none" }],
      };
      if (sql.includes("INSERT INTO ai_invoice_imports")) return { rowCount: 1, rows: [{ id: 43 }] };
      return { rowCount: 1, rows: [] };
    });
    const response = await request(app)
      .post("/finance/ai-invoice-import/upload")
      .field("entity_id", "7")
      .attach("files", Buffer.from("not really a pdf"), { filename: "spoofed.pdf", contentType: "application/pdf" });
    expect(response.status).toBe(202);
    expect(response.body.import_ids).toEqual([]);
    expect(response.body.failures[0].error).toMatch(/PDF|JPG|PNG|WEBP/);
  });

  it("keeps a retryable invoice record when storage fails", async () => {
    query.mockReset();
    getObjectEntityUploadURL.mockRejectedValueOnce(new Error("storage unavailable"));
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT * FROM finance_entities")) return {
        rowCount: 1,
        rows: [{ id: 7, workspace_owner_id: "w", legal_name: "Entity", invoice_review_enabled: true, accounting_system: "none" }],
      };
      if (sql.includes("INSERT INTO ai_invoice_imports")) return { rowCount: 1, rows: [{ id: 77 }] };
      return { rowCount: 1, rows: [] };
    });

    const response = await request(app)
      .post("/finance/ai-invoice-import/upload")
      .field("entity_id", "7")
      .attach("files", Buffer.from("%PDF-1.4"), { filename: "invoice.pdf", contentType: "application/pdf" });

    expect(response.status).toBe(202);
    expect(response.body.import_ids).toEqual([]);
    expect(response.body.failures).toEqual([
      expect.objectContaining({ filename: "invoice.pdf", import_id: 77, retryable: true }),
    ]);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("source_storage_failed"))).toBe(true);
  });

  it("replaces a missing source through the authenticated review boundary", async () => {
    query.mockReset();
    getObjectEntityUploadURL.mockResolvedValue({
      signedUrl: "https://storage.example/replacement",
      requiredHeaders: { "Content-Type": "image/png", "Content-Length": "4" },
    });
    normalizeObjectEntityPath.mockReturnValue("/objects/private/replacement");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    const sourceBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    let persistedSource: { path: string; metadata: Record<string, unknown> } | undefined;
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("SELECT i.* FROM ai_invoice_imports") || sql.includes("SELECT * FROM ai_invoice_imports")) return {
        rowCount: 1,
        rows: [{ id: 88, entity_id: 7, workspace_owner_id: "w", pdf_storage_path: persistedSource?.path ?? null, source_metadata: persistedSource?.metadata ?? {}, review_version: persistedSource ? 4 : 3, review_status: "needs_review", sync_status: "not_requested" }],
      };
      if (sql.includes("UPDATE ai_invoice_imports SET pdf_storage_path")) {
        expect(sql).toContain("$2::text");
        expect(sql).toContain("$3::text");
        expect(sql).toContain("$4::bigint");
        persistedSource = {
          path: String(params?.[0]),
          metadata: { filename: params?.[1], mime_type: params?.[2], byte_size: params?.[3], coordinates_available: false },
        };
      }
      return { rowCount: 1, rows: [] };
    });

    const response = await request(app)
      .put("/finance/invoice-review/88/source")
      .field("version", "3")
      .attach("file", sourceBytes, { filename: "replacement.png", contentType: "image/png" });

    expect(response.status).toBe(200);
    expect(response.body.source_document).toMatchObject({
      available: true,
      content_type: "image/png",
      filename: "replacement.png",
      byte_size: sourceBytes.length,
    });
    expect(persistedSource).toEqual({
      path: "/objects/private/replacement",
      metadata: {
        filename: "replacement.png",
        mime_type: "image/png",
        byte_size: sourceBytes.length,
        coordinates_available: false,
      },
    });

    getObjectEntityFile.mockResolvedValueOnce({
      download: vi.fn().mockResolvedValue([sourceBytes]),
    });
    const retrieved = await request(app).get("/finance/invoice-review/88/source");
    expect(retrieved.status).toBe(200);
    expect(retrieved.headers["content-type"]).toMatch(/^image\/png/);
    expect(retrieved.body).toEqual(sourceBytes);
    expect(getObjectEntityFile).toHaveBeenCalledWith("/objects/private/replacement");
  });

  it.each([
    ["owner", []],
    ["member", ["finance_manager"]],
    ["member", ["ai-invoice-import"]],
  ])("allows %s with %j pages to restore a review source", async (role, allowedPages) => {
    access.role = role;
    access.allowedPages = allowedPages;
    getObjectEntityUploadURL.mockResolvedValue({
      signedUrl: "https://storage.example/role-replacement",
      requiredHeaders: {},
    });
    normalizeObjectEntityPath.mockReturnValue("/objects/private/role-replacement");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT i.* FROM ai_invoice_imports")) return {
        rowCount: 1,
        rows: [{ id: 93, entity_id: 7, workspace_owner_id: "w", review_version: 3, review_status: "needs_review", sync_status: "not_requested" }],
      };
      return { rowCount: 1, rows: [] };
    });

    const response = await request(app)
      .put("/finance/invoice-review/93/source")
      .field("version", "3")
      .attach("file", Buffer.from("%PDF-1.4 source"), { filename: "replacement.pdf", contentType: "application/pdf" });

    expect(response.status).toBe(200);
  });

  it("returns edit, approval, rejection, sync, and source capabilities with invoice review access", async () => {
    access.role = "member";
    access.allowedPages = ["ai-invoice-import"];
    query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 94, entity_id: 7, workspace_owner_id: "w", review_version: 3, review_status: "needs_review", sync_status: "not_requested" }] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ legal_name: "Entity" }] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValue({ rowCount: 0, rows: [] });

    const response = await request(app).get("/finance/invoice-review/94");

    expect(response.status).toBe(200);
    expect(response.body.permissions).toMatchObject({
      can_edit: true,
      can_approve: true,
      can_sync: true,
      can_reject: true,
      can_upload_source: true,
    });
  });

  it("keeps a missing source retryable when replacement storage fails", async () => {
    query.mockReset();
    getObjectEntityUploadURL.mockRejectedValueOnce(new Error("storage unavailable"));
    query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: 91, entity_id: 7, workspace_owner_id: "w", pdf_storage_path: null, source_metadata: {}, review_version: 3, review_status: "needs_review", sync_status: "not_requested" }],
    });

    const response = await request(app)
      .put("/finance/invoice-review/91/source")
      .field("version", "3")
      .attach("file", Buffer.from("%PDF-1.4 source"), { filename: "replacement.pdf", contentType: "application/pdf" });

    expect(response.status).toBe(503);
    expect(response.body.error).toMatch(/retry/i);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("UPDATE ai_invoice_imports SET pdf_storage_path"))).toBe(false);
  });

  it("rejects a stale source replacement version before storage", async () => {
    getObjectEntityUploadURL.mockClear();
    query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: 92, entity_id: 7, workspace_owner_id: "w", review_version: 5, review_status: "needs_review", sync_status: "not_requested" }],
    });

    const response = await request(app)
      .put("/finance/invoice-review/92/source")
      .field("version", "4")
      .attach("file", Buffer.from("%PDF-1.4 source"), { filename: "replacement.pdf", contentType: "application/pdf" });

    expect(response.status).toBe(409);
    expect(response.body.version).toBe(5);
    expect(getObjectEntityUploadURL).not.toHaveBeenCalled();
  });

  it("allows a missing source to be restored after approval but before sync", async () => {
    query.mockReset();
    getObjectEntityUploadURL.mockResolvedValue({
      signedUrl: "https://storage.example/approved-replacement",
      requiredHeaders: { "Content-Type": "image/png", "Content-Length": "8" },
    });
    normalizeObjectEntityPath.mockReturnValue("/objects/private/approved-replacement");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT i.* FROM ai_invoice_imports")) return {
        rowCount: 1,
       rows: [{ id: 89, entity_id: 7, workspace_owner_id: "w", review_version: 4, review_status: "approved", sync_status: "not_requested", reviewed_snapshot: { invoice_number: "STALE" } }],
      };
      return { rowCount: 1, rows: [] };
    });
    const response = await request(app)
      .put("/finance/invoice-review/89/source")
      .field("version", "4")
      .attach("file", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), { filename: "replacement.png", contentType: "image/png" });
    expect(response.status).toBe(200);
    expect(response.body.review_version).toBe(5);
    const updateSql = query.mock.calls.map(([sql]) => String(sql)).find((sql) => sql.includes("UPDATE ai_invoice_imports SET pdf_storage_path"));
    expect(updateSql).toContain("review_status='needs_review'");
    expect(updateSql).toContain("reviewed_snapshot=NULL");
  });

  it("invalidates an approved review when replacing an existing source", async () => {
    query.mockReset();
    getObjectEntityUploadURL.mockResolvedValue({
      signedUrl: "https://storage.example/approved-existing-replacement",
      requiredHeaders: { "Content-Type": "application/pdf", "Content-Length": "12" },
    });
    normalizeObjectEntityPath.mockReturnValue("/objects/private/approved-existing-replacement");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT i.* FROM ai_invoice_imports")) return {
        rowCount: 1,
        rows: [{ id: 95, entity_id: 7, workspace_owner_id: "w", review_version: 6, review_status: "approved", sync_status: "not_requested", pdf_storage_path: "/objects/private/original", reviewed_snapshot: { invoice_number: "APPROVED" } }],
      };
      return { rowCount: 1, rows: [] };
    });

    const response = await request(app)
      .put("/finance/invoice-review/95/source")
      .field("version", "6")
      .attach("file", Buffer.from("%PDF-1.4 new"), { filename: "replacement.pdf", contentType: "application/pdf" });

    expect(response.status).toBe(200);
    expect(response.body.review_version).toBe(7);
    const updateSql = query.mock.calls.map(([sql]) => String(sql)).find((sql) => sql.includes("UPDATE ai_invoice_imports SET pdf_storage_path"));
    expect(updateSql).toContain("review_status='needs_review'");
    expect(updateSql).toContain("reviewed_snapshot=NULL");
  });

  it("blocks source replacement after accounting sync has started", async () => {
    getObjectEntityUploadURL.mockClear();
    query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: 90, entity_id: 7, workspace_owner_id: "w", review_version: 4, review_status: "approved", sync_status: "succeeded" }],
    });

    const response = await request(app)
      .put("/finance/invoice-review/90/source")
      .field("version", "4")
      .attach("file", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), { filename: "replacement.png", contentType: "image/png" });

    expect(response.status).toBe(409);
    expect(getObjectEntityUploadURL).not.toHaveBeenCalled();
  });
});