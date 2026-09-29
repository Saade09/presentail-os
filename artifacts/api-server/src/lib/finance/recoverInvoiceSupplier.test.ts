import { beforeEach, describe, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("../db.js", () => ({ db: { query } }));
vi.mock("../logger.js", () => ({ logger: { warn: vi.fn() } }));
vi.mock("../supplierMatcher.js", () => ({
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

import { recoverMissingInvoiceSupplier } from "./recoverInvoiceSupplier.js";

const invoice = {
  id: 100,
  entity_id: 9,
  workspace_owner_id: "workspace-1",
  supplier_id: null,
  vendor_name: "Acme Flowers S.A.L.",
};

describe("recoverMissingInvoiceSupplier", () => {
  beforeEach(() => query.mockReset());

  it("recovers one proven same-entity normalized historical mapping", async () => {
    query
      .mockResolvedValueOnce({
        rows: [{ supplier_id: 77, vendor_name: "Acme Flowers SAL" }],
      })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ supplier_id: 77 }],
      });

    const result = await recoverMissingInvoiceSupplier(invoice, "workspace-1");

    expect(result).toMatchObject({
      status: "recovered",
      supplier_id: 77,
      invoice: { supplier_id: 77 },
    });
    expect(query.mock.calls[0]?.[1]).toEqual(["workspace-1", 9, 100]);
    expect(query.mock.calls[1]?.[1]).toEqual([77, 100, "workspace-1", 9]);
  });

  it("requires confirmation when normalized history has conflicting supplier IDs", async () => {
    query.mockResolvedValueOnce({
      rows: [
        { supplier_id: 77, vendor_name: "Acme Flowers SAL" },
        { supplier_id: 78, vendor_name: "Acme Flowers S.A.L." },
      ],
    });

    const result = await recoverMissingInvoiceSupplier(invoice, "workspace-1");

    expect(result).toMatchObject({ status: "ambiguous", invoice: { supplier_id: null } });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("does not reuse a mapping from another accounting entity", async () => {
    query.mockResolvedValueOnce({ rows: [] });

    const result = await recoverMissingInvoiceSupplier({ ...invoice, entity_id: 10 }, "workspace-1");

    expect(result.status).toBe("unresolved");
    expect(query.mock.calls[0]?.[0]).toContain("i.entity_id=$2");
    expect(query.mock.calls[0]?.[1]).toEqual(["workspace-1", 10, 100]);
  });

  it("does not write a second supplier link when the invoice is already recovered", async () => {
    const recovered = { ...invoice, supplier_id: 77 };
    query.mockResolvedValueOnce({ rows: [{ id: 77, supplier_name: "Acme Flowers SAL", tax_number: null, odoo_partner_id: "partner-77" }] });

    const result = await recoverMissingInvoiceSupplier(recovered, "workspace-1");

    expect(result).toMatchObject({ status: "not_needed", invoice: recovered });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("recovers an explicitly linked unmapped duplicate to one verified canonical supplier", async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 55, supplier_name: "Acme Flowers S.A.L.", tax_number: "VAT-1", odoo_partner_id: null }] })
      .mockResolvedValueOnce({
        rows: [{ supplier_id: 77, vendor_name: "Acme Flowers SAL", canonical_supplier_name: "Acme Flowers SAL", canonical_tax_number: "VAT-1", canonical_odoo_partner_id: "partner-77" }],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ supplier_id: 77 }] });
    const result = await recoverMissingInvoiceSupplier({
      ...invoice,
      supplier_id: 55,
      odoo_partner_id: null,
      supplier_name: "Acme Flowers S.A.L.",
      supplier_tax_number: "VAT-1",
    }, "workspace-1");
    expect(result).toMatchObject({ status: "recovered", supplier_id: 77, invoice: { supplier_id: 77 } });
    expect(query.mock.calls[2]?.[1]).toEqual([77, 100, "workspace-1", 9, 55]);
  });

  it("does not recover when current and canonical tax identities contradict", async () => {
    query.mockResolvedValueOnce({
      rows: [{ id: 55, supplier_name: "Acme Flowers SAL", tax_number: "VAT-1", odoo_partner_id: null }],
    }).mockResolvedValueOnce({
      rows: [{ supplier_id: 77, vendor_name: "Acme Flowers SAL", canonical_supplier_name: "Acme Flowers SAL", canonical_tax_number: "VAT-2", canonical_odoo_partner_id: "partner-77" }],
    });
    const result = await recoverMissingInvoiceSupplier({
      ...invoice, supplier_id: 55, odoo_partner_id: null, supplier_name: "Acme Flowers SAL", supplier_tax_number: "VAT-1",
    }, "workspace-1");
    expect(result.status).toBe("ambiguous");
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("does not choose between multiple canonical supplier or partner mappings", async () => {
    query.mockResolvedValueOnce({
      rows: [{ id: 55, supplier_name: "Acme Flowers SAL", tax_number: null, odoo_partner_id: null }],
    }).mockResolvedValueOnce({
      rows: [
        { supplier_id: 77, vendor_name: "Acme Flowers SAL", canonical_supplier_name: "Acme Flowers SAL", canonical_odoo_partner_id: "partner-77" },
        { supplier_id: 78, vendor_name: "Acme Flowers SAL", canonical_supplier_name: "Acme Flowers SAL", canonical_odoo_partner_id: "partner-78" },
      ],
    });
    const result = await recoverMissingInvoiceSupplier({ ...invoice, supplier_id: 55, odoo_partner_id: null }, "workspace-1");
    expect(result.status).toBe("ambiguous");
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("leaves an explicitly mapped supplier unchanged", async () => {
    const mapped = { ...invoice, supplier_id: 55, odoo_partner_id: "partner-55" };
    query.mockResolvedValueOnce({ rows: [{ id: 55, supplier_name: "Acme Flowers SAL", tax_number: null, odoo_partner_id: "partner-55" }] });
    const result = await recoverMissingInvoiceSupplier(mapped, "workspace-1");
    expect(result).toMatchObject({ status: "not_needed", invoice: mapped });
    expect(query).toHaveBeenCalledTimes(1);
  });
});