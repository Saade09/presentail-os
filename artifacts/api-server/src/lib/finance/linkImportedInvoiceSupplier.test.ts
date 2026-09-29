import { beforeEach, describe, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../db.js", () => ({ db: { query } }));

import { linkImportedInvoiceToVerifiedOdooSupplier } from "./linkImportedInvoiceSupplier.js";

describe("linkImportedInvoiceToVerifiedOdooSupplier", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    query.mockResolvedValue({ rowCount: 1, rows: [{ supplier_id: 17 }] });
  });

  it("atomically adopts or creates one Odoo supplier and links the import", async () => {
    await expect(linkImportedInvoiceToVerifiedOdooSupplier(41, "owner-1", {
      id: 301,
      name: "Acme Flowers S.A.R.L.",
      taxNumber: "LB 123-456",
    })).resolves.toBe(17);

    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("pg_advisory_xact_lock");
    expect(sql).toContain("odoo_partner_id=$3");
    expect(sql).toContain("HAVING count(*)=1");
    expect(sql).toContain("WHERE NOT EXISTS (SELECT 1 FROM adopted)");
    expect(sql).toContain("ON CONFLICT (workspace_owner_id,odoo_partner_id)");
    expect(sql).toContain("UPDATE ai_invoice_imports");
    expect(params).toEqual([41, "owner-1", 301, "LB123456", "ACMEFLOWERSSARL", "LB 123-456", "Acme Flowers S.A.R.L."]);
  });

  it("surfaces a provider/local persistence failure when no supplier can be linked", async () => {
    query.mockResolvedValue({ rowCount: 0, rows: [] });
    await expect(linkImportedInvoiceToVerifiedOdooSupplier(41, "owner-1", {
      id: 301,
      name: "Ambiguous Supplier",
      taxNumber: null,
    })).rejects.toThrow("could not be linked unambiguously");
  });
});