import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDbQuery = vi.fn();

vi.mock("../db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
  },
}));

import { syncImportedSupplierInvoice } from "./syncImportedSupplierInvoice";

describe("syncImportedSupplierInvoice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("upserts by durable import identity and maps all supplier-facing fields", async () => {
    await syncImportedSupplierInvoice(77, "owner_111");

    const [upsertSql, params] = mockDbQuery.mock.calls[0];
    expect(upsertSql).toContain(
      "ON CONFLICT (ai_import_id) WHERE ai_import_id IS NOT NULL DO UPDATE",
    );
    expect(upsertSql).toContain("supplier_id = EXCLUDED.supplier_id");
    expect(upsertSql).toContain("invoice_number = EXCLUDED.invoice_number");
    expect(upsertSql).toContain("due_date = EXCLUDED.due_date");
    expect(upsertSql).toContain("vat_amount = EXCLUDED.vat_amount");
    expect(upsertSql).toContain("line_items = EXCLUDED.line_items");
    expect(upsertSql).toContain("file_urls = EXCLUDED.file_urls");
    expect(upsertSql).toContain("provider_bill_id = EXCLUDED.provider_bill_id");
    expect(upsertSql).toContain("provider_bill_url = EXCLUDED.provider_bill_url");
    expect(upsertSql).toContain("provider_sync_status = EXCLUDED.provider_sync_status");
    expect(upsertSql).toContain("provider_sync_idempotency_key = EXCLUDED.provider_sync_idempotency_key");
    expect(upsertSql).toContain("odoo_sync_status = EXCLUDED.odoo_sync_status");
    expect(params).toEqual([77, "owner_111"]);
  });

  it("removes the mirrored ledger row when the import is unlinked", async () => {
    await syncImportedSupplierInvoice(77, "owner_111");

    const [deleteSql, params] = mockDbQuery.mock.calls[1];
    expect(deleteSql).toContain("DELETE FROM supplier_invoices");
    expect(deleteSql).toContain("i.supplier_id IS NOT NULL");
    expect(params).toEqual([77, "owner_111"]);
  });

  it("is idempotent across repeated synchronization", async () => {
    await syncImportedSupplierInvoice(77, "owner_111");
    await syncImportedSupplierInvoice(77, "owner_111");

    const upserts = mockDbQuery.mock.calls.filter(([sql]) =>
      String(sql).includes(
        "ON CONFLICT (ai_import_id) WHERE ai_import_id IS NOT NULL DO UPDATE",
      ),
    );
    expect(upserts).toHaveLength(2);
  });

  it("repairs a verified provider bill into the Odoo/import ledger without a connector", async () => {
    await syncImportedSupplierInvoice(77, "owner_111");

    const [upsertSql] = mockDbQuery.mock.calls[0];
    expect(upsertSql).toContain("provider_sync_status = 'succeeded'");
    expect(upsertSql).toContain("NULLIF(i.provider_bill_id, '') IS NOT NULL");
    expect(upsertSql).toContain("a.external_reference IN (i.provider_bill_id, i.odoo_bill_id)");
    expect(upsertSql).toContain("UPDATE ai_invoice_imports");
    expect(upsertSql).toContain("SET ai_import_id = $1");
    expect(upsertSql).toContain("si.ai_import_id IS NULL");
    expect(upsertSql).toContain("sync_status = 'succeeded'");
    expect(upsertSql).toContain(
      "odoo_bill_id = COALESCE(NULLIF(i.provider_bill_id, ''), i.odoo_bill_id)",
    );
    expect(mockDbQuery).toHaveBeenCalledTimes(2);
    expect(mockDbQuery.mock.calls.flat().some((value) =>
      typeof value === "string" && /connector|odooConnector|wafeqConnector/i.test(value),
    )).toBe(false);
  });
});
