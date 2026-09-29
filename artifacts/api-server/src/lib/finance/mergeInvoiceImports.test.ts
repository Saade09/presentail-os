import { describe, expect, it } from "vitest";
import { evaluateMultiPageMerge, type MergeInvoiceRow } from "./mergeInvoiceImports.js";

const page = (id: number, overrides: Partial<MergeInvoiceRow> = {}): MergeInvoiceRow => ({
  id,
  workspace_owner_id: "w",
  entity_id: 1,
  supplier_id: 7,
  vendor_name: "Flowers SAL",
  vendor_tax_number: "123-456",
  invoice_number: "INV-9",
  invoice_date: "2026-09-18",
  currency: "USD",
  subtotal: "10",
  tax_amount: "0",
  total_amount: "10",
  line_items: [{ description: `Item ${id}`, quantity: 1, unit_price: 10, total: 10 }],
  pdf_storage_path: `/objects/invoice-${id}.pdf`,
  source_batch_id: "scan-batch-1",
  source_page_number: id,
  source_page_count: 2,
  ...overrides,
});

describe("evaluateMultiPageMerge", () => {
  it("requires review when distinct pages repeat an identical line without overlap provenance", () => {
    const result = evaluateMultiPageMerge([
      page(1, { line_items: [{ description: "Header", quantity: 1, unit_price: 2, total: 2 }] }),
      page(2, {
        raw_ai_json: { total_label: "GRAND TOTAL" },
        line_items: [
          { description: "Header", quantity: 1, unit_price: 2, total: 2 },
          { description: "Final", quantity: 1, unit_price: 8, total: 8 },
        ],
      }),
    ]);
    expect(result).toEqual({ status: "review_required", reason: "Needs multi-page invoice review" });
  });

  it("does not use a page subtotal as the invoice total", () => {
    const result = evaluateMultiPageMerge([
      page(1, { total_amount: 2, line_items: [{ description: "First", quantity: 1, unit_price: 2, total: 2 }] }),
      page(2, { total_amount: 10, raw_ai_json: { total_label: "AMOUNT DUE" }, line_items: [{ description: "Second", quantity: 1, unit_price: 8, total: 8 }] }),
    ]);
    expect(result).toMatchObject({ status: "merged", canonicalId: 2, supersededIds: [1], totalAmount: 10, subtotal: 10 });
  });

  it("requires review for conflicting totals without an explicit final total", () => {
    const result = evaluateMultiPageMerge([
      page(1, { total_amount: 10 }),
      page(2, { total_amount: 20, line_items: [{ description: "Printed total", total: 20 }] }),
    ]);
    expect(result).toEqual({ status: "review_required", reason: "Needs multi-page invoice review" });
  });

  it("only accepts an exact dedicated total label, not a generic line-item total key", () => {
    const generic = evaluateMultiPageMerge([
      page(1, { total_amount: 2 }),
      page(2, { total_amount: 10, line_items: [{ description: "Line", total: 10 }] }),
    ]);
    expect(generic.status).toBe("review_required");
    const labeled = evaluateMultiPageMerge([
      page(1, { total_amount: 2, line_items: [{ description: "Line", total: 2 }] }),
      page(2, { total_amount: 10, raw_ai_json: { total_label: " GRAND   TOTAL: " }, line_items: [{ description: "Line", total: 8 }] }),
    ]);
    expect(labeled).toMatchObject({ status: "merged", totalAmount: 10 });
  });

  it("fails closed when a final total is null or blank", () => {
    for (const missingTotal of [null, ""]) {
      const result = evaluateMultiPageMerge([
        page(1, {
          total_amount: 10,
          line_items: [{ description: "First", quantity: 1, unit_price: 10, total: 10 }],
        }),
        page(2, {
          subtotal: null,
          tax_amount: null,
          total_amount: missingTotal,
          raw_ai_json: { total_label: "GRAND TOTAL" },
          line_items: [{ description: "Second", quantity: 1, unit_price: 20, total: null }],
        }),
      ]);
      expect(result).toEqual({ status: "review_required", reason: "Needs multi-page invoice review" });
    }
  });

  it("uses quantity times unit price when a line total is null", () => {
    const result = evaluateMultiPageMerge([
      page(1, {
        total_amount: 10,
        line_items: [{ description: "First", quantity: 1, unit_price: 10, total: 10 }],
      }),
      page(2, {
        subtotal: 30,
        tax_amount: 0,
        total_amount: 30,
        raw_ai_json: { total_label: "GRAND TOTAL" },
        line_items: [{ description: "Second", quantity: 2, unit_price: 10, total: null }],
      }),
    ]);
    expect(result).toMatchObject({ status: "merged", canonicalId: 2, subtotal: 30, totalAmount: 30 });
  });

  it("does not merge when a three-page batch is missing page two", () => {
    const result = evaluateMultiPageMerge([
      page(1, { source_page_count: 3 }),
      page(3, { source_page_number: 3, source_page_count: 3 }),
    ]);
    expect(result).toEqual({ status: "review_required", reason: "Needs multi-page invoice review" });
  });

  it("does not merge same-number records with conflicting provenance or identity", () => {
    expect(evaluateMultiPageMerge([page(1), page(2, { source_batch_id: "other" })]).status).toBe("not_eligible");
    expect(evaluateMultiPageMerge([page(1), page(2, { vendor_tax_number: "different" })]).status).toBe("not_eligible");
    expect(evaluateMultiPageMerge([page(1), page(2, { supplier_id: null, vendor_name: "Different Supplier" })]).status).toBe("not_eligible");
    expect(evaluateMultiPageMerge([page(1), page(2, { entity_id: 2 })]).status).toBe("not_eligible");
  });

  it("merges split records without a shared batch when the larger row has final-total evidence", () => {
    const result = evaluateMultiPageMerge([
      page(41, {
        source_batch_id: null,
        source_page_number: null,
        source_page_count: null,
        total_amount: 71.99,
        line_items: [{ description: "Flowers", quantity: 1, unit_price: 71.99, total: 71.99 }],
      }),
      page(42, {
        source_batch_id: null,
        source_page_number: null,
        source_page_count: null,
        total_amount: 563.50,
        subtotal: 500,
        tax_amount: 63.50,
        raw_ai_json: { total_label: "GRAND TOTAL" },
        line_items: [{ description: "Vase", quantity: 1, unit_price: 428.01, total: 428.01 }],
      }),
    ]);
    expect(result).toMatchObject({
      status: "merged",
      canonicalId: 42,
      supersededIds: [41],
      totalAmount: 563.5,
      subtotal: 500,
      taxAmount: 63.5,
    });
    expect(result.status === "merged" && result.lineItems).toHaveLength(2);
  });

  it("merges production-style partial and final rows without page metadata using reconciled final totals", () => {
    const result = evaluateMultiPageMerge([
      page(187, {
        supplier_id: 7,
        vendor_name: "Raidan Flowers and Plants Wholesaler",
        source_batch_id: null,
        source_page_number: null,
        source_page_count: null,
        total_amount: 638,
        subtotal: 638,
        tax_amount: 0,
        line_items: [{ description: "Page one flowers", quantity: 1, unit_price: 638, total: 638 }],
      }),
      page(188, {
        supplier_id: 7,
        vendor_name: "Raidan Floriculture S.A.R.L.",
        source_batch_id: null,
        source_page_number: null,
        source_page_count: null,
        total_amount: 719.28,
        subtotal: 648,
        tax_amount: 71.28,
        line_items: [{ description: "Page two flowers", quantity: 1, unit_price: 10, total: 10 }],
      }),
    ]);
    expect(result).toMatchObject({
      status: "merged",
      canonicalId: 188,
      supersededIds: [187],
      totalAmount: 719.28,
      subtotal: 648,
      taxAmount: 71.28,
      supplierId: 7,
    });
  });

  it("fails closed on metadata-free rows with conflicting invoice dates", () => {
    const result = evaluateMultiPageMerge([
      page(189, {
        supplier_id: 7,
        vendor_name: "Flowers SAL",
        source_batch_id: null,
        source_page_number: null,
        source_page_count: null,
        invoice_date: "2026-09-18",
        total_amount: 71.99,
        subtotal: 71.99,
        tax_amount: 0,
        line_items: [{ description: "Partial flowers", quantity: 1, unit_price: 71.99, total: 71.99 }],
      }),
      page(190, {
        supplier_id: 7,
        vendor_name: "Flowers S.A.L.",
        source_batch_id: null,
        source_page_number: null,
        source_page_count: null,
        invoice_date: "2026-09-19",
        total_amount: 120,
        subtotal: 120,
        tax_amount: 0,
        raw_ai_json: { total_label: "GRAND TOTAL" },
        line_items: [{ description: "Final flowers", quantity: 1, unit_price: 48.01, total: 48.01 }],
      }),
    ]);
    expect(result).toEqual({ status: "not_eligible", reason: "Invoice date differs" });
  });

  it("refuses same-number rows that reuse the same source document", () => {
    expect(evaluateMultiPageMerge([
      page(71, { pdf_storage_path: "/objects/same.pdf" }),
      page(72, { pdf_storage_path: "/objects/same.pdf", raw_ai_json: { total_label: "TOTAL" } }),
    ]).status).toBe("not_eligible");
  });

  it("does not treat a generic supplier word as equivalent identity", () => {
    const result = evaluateMultiPageMerge([
      page(73, {
        supplier_id: null,
        vendor_name: "Acme Flowers SAL",
        source_batch_id: null,
        source_page_number: null,
        source_page_count: null,
      }),
      page(74, {
        supplier_id: null,
        vendor_name: "Bloom Flowers SAL",
        source_batch_id: null,
        source_page_number: null,
        source_page_count: null,
        total_amount: 20,
        subtotal: 20,
        raw_ai_json: { total_label: "TOTAL" },
      }),
    ]);
    expect(result).toEqual({ status: "not_eligible", reason: "Supplier identity differs" });
  });

  it("requires metadata-free merged lines to reconcile to the final totals", () => {
    const result = evaluateMultiPageMerge([
      page(75, {
        supplier_id: 7,
        vendor_name: "Raidan Flowers",
        source_batch_id: null,
        source_page_number: null,
        source_page_count: null,
        subtotal: 100,
        total_amount: 100,
        line_items: [{ description: "Page one", quantity: 1, unit_price: 100, total: 100 }],
      }),
      page(76, {
        supplier_id: 7,
        vendor_name: "Raidan Floriculture",
        source_batch_id: null,
        source_page_number: null,
        source_page_count: null,
        subtotal: 120,
        tax_amount: 12,
        total_amount: 132,
        line_items: [{ description: "Unrelated full invoice", quantity: 1, unit_price: 120, total: 120 }],
      }),
    ]);
    expect(result).toEqual({ status: "review_required", reason: "Needs multi-page invoice review" });
  });

  it("fails closed when same-number records have conflicting date or currency evidence", () => {
    expect(evaluateMultiPageMerge([
      page(51, { source_batch_id: null, source_page_number: null, source_page_count: null }),
      page(52, { source_batch_id: null, source_page_number: null, source_page_count: null, invoice_date: "2026-09-19", raw_ai_json: { total_label: "TOTAL" } }),
    ]).status).toBe("not_eligible");
    expect(evaluateMultiPageMerge([
      page(53, { source_batch_id: null, source_page_number: null, source_page_count: null }),
      page(54, { source_batch_id: null, source_page_number: null, source_page_count: null, currency: "EUR", raw_ai_json: { total_label: "TOTAL" } }),
    ]).status).toBe("not_eligible");
  });

  it("accepts extracted supplier-name variation when both rows use the same supplier ID", () => {
    const result = evaluateMultiPageMerge([
      page(61, {
        source_batch_id: null,
        source_page_number: null,
        source_page_count: null,
        vendor_name: "Flowers S.A.L.",
        total_amount: 71.99,
        line_items: [{ description: "Page one", quantity: 1, unit_price: 71.99, total: 71.99 }],
      }),
      page(62, {
        source_batch_id: null,
        source_page_number: null,
        source_page_count: null,
        vendor_name: "Flowers Trading",
        total_amount: 563.5,
        subtotal: 500,
        tax_amount: 63.5,
        raw_ai_json: { total_label: "AMOUNT DUE" },
        line_items: [{ description: "Page two", quantity: 1, unit_price: 428.01, total: 428.01 }],
      }),
    ]);

    expect(result).toMatchObject({ status: "merged", canonicalId: 62, supersededIds: [61], totalAmount: 563.5 });
  });

  it("does not collapse accounting-distinct lines that differ in tax or discount fields", () => {
    const first = { description: "Rose", quantity: 1, unit_price: 10, total: 10, tax_rate: 0 };
    const second = { ...first, tax_rate: 0.11, discount: 2 };
    const result = evaluateMultiPageMerge([
      page(63, { source_page_number: 1, line_items: [first] }),
      page(64, {
        source_page_number: 2,
        subtotal: 20,
        total_amount: 20,
        line_items: [second],
        raw_ai_json: { total_label: "GRAND TOTAL" },
      }),
    ]);
    expect(result.status === "merged" && result.lineItems).toHaveLength(2);
  });

  it.each([
    ["SF2602447", 491, 572.76, 7, 7, null],
    ["SF2602426", 481, 533.91, 7, 7, null],
    ["SF2602411", 538, 828.06, 7, 8, 301],
  ])("merges historical Raidan partial/final evidence for %s and keeps the larger final row", (
    invoiceNumber,
    partialTotal,
    finalTotal,
    partialSupplierId,
    finalSupplierId,
    sharedOdooPartnerId,
  ) => {
    const result = evaluateMultiPageMerge([
      page(81, {
        invoice_number: invoiceNumber,
        supplier_id: partialSupplierId,
        supplier_odoo_partner_id: sharedOdooPartnerId,
        vendor_name: "Raidan Flowers and Plants Wholesaler",
        source_batch_id: null,
        source_page_number: null,
        source_page_count: null,
        subtotal: partialTotal,
        tax_amount: 0,
        total_amount: partialTotal,
        line_items: [{ description: "Partial page flowers", quantity: 1, unit_price: partialTotal, total: partialTotal }],
      }),
      page(82, {
        invoice_number: invoiceNumber,
        supplier_id: finalSupplierId,
        supplier_odoo_partner_id: sharedOdooPartnerId,
        vendor_name: "Raidan Floriculture S.A.R.L.",
        source_batch_id: null,
        source_page_number: null,
        source_page_count: null,
        subtotal: finalTotal,
        tax_amount: 0,
        total_amount: finalTotal,
        raw_ai_json: { total_label: "GRAND TOTAL" },
        line_items: [{
          description: "Final page flowers",
          quantity: 1,
          unit_price: Number((finalTotal - partialTotal).toFixed(2)),
          total: Number((finalTotal - partialTotal).toFixed(2)),
        }],
      }),
    ]);

    expect(result).toMatchObject({
      status: "merged",
      canonicalId: 82,
      supersededIds: [81],
      totalAmount: finalTotal,
    });
  });

  it("merges the live SF2602426 split despite the historical no-destination sentinel", () => {
    const detailedLines = [
      { description: "Flowers", quantity: 1, unit_price: 481, total: 481 },
    ];
    const result = evaluateMultiPageMerge([
      page(300, {
        invoice_number: "SF2602426",
        supplier_id: null,
        supplier_odoo_partner_id: null,
        trusted_supplier_matches: [{ supplier_id: 25, odoo_partner_id: 56 }],
        vendor_name: "Raidan Flowers and Plants Wholesaler - SALES SARL",
        provider_bill_id: "no-accounting-destination",
        odoo_bill_id: "no-accounting-destination",
        provider_sync_status: "failed",
        sync_status: "blocked",
        source_batch_id: null,
        source_page_number: null,
        source_page_count: null,
        subtotal: 481,
        tax_amount: null,
        total_amount: 481,
        line_items: detailedLines,
      }),
      page(301, {
        invoice_number: "SF2602426",
        supplier_id: null,
        supplier_odoo_partner_id: null,
        trusted_supplier_matches: [
          { supplier_id: 25, odoo_partner_id: 56 },
          { supplier_id: 35, odoo_partner_id: 354 },
        ],
        vendor_name: "Raidan Floriculture S.A.R.L.",
        provider_bill_id: "no-accounting-destination",
        odoo_bill_id: "no-accounting-destination",
        provider_sync_status: "failed",
        sync_status: "blocked",
        source_batch_id: null,
        source_page_number: null,
        source_page_count: null,
        subtotal: 481,
        tax_amount: 52.91,
        total_amount: 533.91,
        line_items: [{ description: "Net total", quantity: 1, unit_price: 5, total: 5 }],
      }),
    ]);

    expect(result).toMatchObject({
      status: "merged",
      canonicalId: 301,
      supersededIds: [300],
      lineItems: detailedLines,
      subtotal: 481,
      taxAmount: 52.91,
      totalAmount: 533.91,
    });
  });

  it("merges the live SF2602447 mapped/unmapped split and preserves the mapped supplier", () => {
    const result = evaluateMultiPageMerge([
      page(308, {
        invoice_number: "SF2602447",
        supplier_id: 25,
        supplier_odoo_partner_id: 56,
        vendor_name: "Raidan SALES SARL",
        provider_bill_id: "no-accounting-destination",
        provider_sync_status: "failed",
        sync_status: "blocked",
        source_batch_id: null,
        source_page_number: null,
        source_page_count: null,
        subtotal: 491,
        tax_amount: null,
        total_amount: 491,
        line_items: [{ description: "Detailed flowers", quantity: 1, unit_price: 491, total: 491 }],
      }),
      page(309, {
        invoice_number: "SF2602447",
        supplier_id: null,
        supplier_odoo_partner_id: null,
        trusted_supplier_matches: [
          { supplier_id: 25, odoo_partner_id: 56 },
          { supplier_id: 35, odoo_partner_id: 354 },
        ],
        vendor_name: "Raidan Floriculture S.A.R.L.",
        provider_bill_id: "no-accounting-destination",
        provider_sync_status: "failed",
        sync_status: "blocked",
        source_batch_id: null,
        source_page_number: null,
        source_page_count: null,
        subtotal: 516,
        tax_amount: 56.76,
        total_amount: 572.76,
        line_items: [{ description: "Final-page plants", quantity: 1, unit_price: 25, total: 25 }],
      }),
    ]);

    expect(result).toMatchObject({
      status: "merged",
      canonicalId: 309,
      supersededIds: [308],
      supplierId: 25,
      subtotal: 516,
      taxAmount: 56.76,
      totalAmount: 572.76,
    });
  });

  it("merges the live SF2602339 split to the higher supported final total", () => {
    const result = evaluateMultiPageMerge([
      page(247, {
        invoice_number: "SF2602339",
        supplier_id: null,
        supplier_odoo_partner_id: null,
        trusted_supplier_matches: [{ supplier_id: 25, odoo_partner_id: 56 }],
        vendor_name: "Raidan Floriculture S.A.R.L.",
        provider_bill_id: "no-accounting-destination",
        odoo_bill_id: "no-accounting-destination",
        provider_sync_status: "blocked",
        sync_status: "blocked",
        source_batch_id: null,
        source_page_number: null,
        source_page_count: null,
        subtotal: 503,
        tax_amount: null,
        total_amount: 503,
        line_items: [{ description: "Detailed flowers", quantity: 1, unit_price: 503, total: 503 }],
      }),
      page(248, {
        invoice_number: "SF2602339",
        supplier_id: 25,
        supplier_odoo_partner_id: 56,
        vendor_name: "Raidan - Flowers and Plants Wholesaler",
        provider_bill_id: "no-accounting-destination",
        odoo_bill_id: "no-accounting-destination",
        provider_sync_status: "blocked",
        sync_status: "blocked",
        source_batch_id: null,
        source_page_number: null,
        source_page_count: null,
        subtotal: 557,
        tax_amount: 61.27,
        total_amount: 618.27,
        line_items: [{ description: "Final page items", quantity: 1, unit_price: 54, total: 54 }],
      }),
    ]);

    expect(result).toMatchObject({
      status: "merged",
      canonicalId: 248,
      supersededIds: [247],
      supplierId: 25,
      subtotal: 557,
      taxAmount: 61.27,
      totalAmount: 618.27,
    });
  });

  it("canonicalizes an unmapped local supplier only through one verified historical provider identity", () => {
    const result = evaluateMultiPageMerge([
      page(401, {
        supplier_id: 25,
        supplier_odoo_partner_id: 56,
        vendor_name: "Raidan SALES SARL",
        source_page_number: 1,
      }),
      page(402, {
        supplier_id: 99,
        supplier_odoo_partner_id: null,
        trusted_supplier_matches: [{ supplier_id: 25, odoo_partner_id: 56 }],
        vendor_name: "Raidan Floriculture S.A.R.L.",
        source_page_number: 2,
        subtotal: 20,
        total_amount: 20,
      }),
    ]);
    expect(result.status === "merged" && result.supplierId).toBe(25);
  });

  it("fails closed when trusted provider identity does not resolve one local supplier", () => {
    const result = evaluateMultiPageMerge([
      page(403, {
        supplier_id: null,
        supplier_odoo_partner_id: null,
        trusted_supplier_matches: [
          { supplier_id: 25, odoo_partner_id: 56 },
          { supplier_id: 26, odoo_partner_id: 56 },
        ],
      }),
      page(404, {
        supplier_id: null,
        supplier_odoo_partner_id: null,
        trusted_supplier_matches: [
          { supplier_id: 25, odoo_partner_id: 56 },
          { supplier_id: 26, odoo_partner_id: 56 },
        ],
      }),
    ]);
    expect(result).toEqual({ status: "not_eligible", reason: "Supplier identity differs" });
  });

  it("keeps an authoritative bill immutable and rejects incomplete page provenance", () => {
    expect(evaluateMultiPageMerge([
      page(1, { provider_bill_id: "odoo-1" }),
      page(2),
    ]).status).toBe("not_eligible");
    expect(evaluateMultiPageMerge([
      page(1),
      page(2, { source_page_number: null }),
    ]).status).toBe("review_required");
  });
});