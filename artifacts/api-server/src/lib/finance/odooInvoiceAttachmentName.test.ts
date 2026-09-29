import { describe, expect, it } from "vitest";
import { buildOdooInvoiceAttachmentName } from "./odooInvoiceAttachmentName";

describe("buildOdooInvoiceAttachmentName", () => {
  it("uses the supplier and approved invoice reference instead of the source filename", () => {
    expect(buildOdooInvoiceAttachmentName(" Acme / Flowers SAL ", " INV:2026/17 ", "BILL/00899"))
      .toBe("Acme Flowers SAL INV 2026 17.pdf");
  });

  it("falls back to the Odoo move name when the invoice reference is absent", () => {
    expect(buildOdooInvoiceAttachmentName("Acme Flowers SAL", null, "BILL/2026/00899"))
      .toBe("Acme Flowers SAL BILL 2026 00899.pdf");
  });

  it("always returns a bounded PDF filename", () => {
    const filename = buildOdooInvoiceAttachmentName("A".repeat(300), "B".repeat(300), null);
    expect(filename).toMatch(/\.pdf$/);
    expect(filename.length).toBeLessThanOrEqual(255);
  });
});