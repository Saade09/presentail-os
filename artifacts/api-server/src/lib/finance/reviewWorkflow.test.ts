import { describe, expect, it } from "vitest";
import { validateInvoice } from "./reviewWorkflow.js";

describe("invoice review validation", () => {
  const base = { vendor_name: "Supplier", invoice_number: "INV-1", invoice_date: "2026-01-01", currency: "USD", supplier_id: 1, pdf_storage_path: "/objects/a", subtotal: 100, tax_amount: 5, total_amount: 105, line_items: [{ description: "Consulting", quantity: 1, unit_price: 100, total: 100, account_code: "6000", tax_rate: .05 }] };
  it("uses stable per-line issue keys and reconciles totals", () => {
    expect(validateInvoice(base).issues).toEqual([]);
    const result = validateInvoice({ ...base, line_items: [{ ...base.line_items[0], account_code: undefined, tax_rate: .07 }] });
    expect(result.issues.map(x => x.issue_key)).toEqual(["tax.unsupported.0"]);
    expect(result.issues.every(x => x.blocking)).toBe(true);
  });
  it("recalculates lines instead of trusting extracted line totals", () => {
    const result = validateInvoice({ ...base, line_items: [{ ...base.line_items[0], quantity: 2, unit_price: 50, total: 999 }] });
    expect(result.issues).toEqual([]);
  });

  it("does not treat a derived sync flag as a review validation blocker", () => {
    expect(validateInvoice({ ...base, sync_status: "in_progress" }).issues).toEqual([]);
  });
  it("blocks duplicate and supplier identity risks", () => {
    const result = validateInvoice({ ...base, company_validation_status: "mismatch" }, 0.01, { duplicate: true });
    expect(result.issues.filter(x => x.blocking).map(x => x.issue_key)).toEqual(expect.arrayContaining(["duplicate.risk", "supplier.trn_mismatch"]));
  });
  it("blocks unreadable attachments and total reconciliation", () => {
    const result = validateInvoice({ ...base, pdf_storage_path: null, total_amount: 50 });
    expect(result.issues.filter(x => x.blocking).map(x => x.issue_key)).toContain("attachment.unavailable");
    expect(result.issues.filter(x => x.blocking).map(x => x.issue_key)).toContain("totals.invoice");
  });

  it("accepts a bill-level Wafeq account mapping for every line", () => {
    const result = validateInvoice({
      ...base,
      subtotal: 200,
      tax_amount: 10,
      total_amount: 210,
      wafeq_supplier_id: "supplier-1",
      wafeq_tax_id: "tax-5",
      wafeq_account_id: "account-6000",
      line_items: [
        { ...base.line_items[0], account_code: undefined, wafeq_tax_id: "legacy-different-tax", tax_rate: .07 },
        { ...base.line_items[0], description: "Second line", account_code: undefined, tax_rate: 0.1234 },
      ],
    }, .01, { provider: "wafeq" });
    expect(result.issues).toEqual([]);
  });

  it("accepts a Wafeq supplier mapping without requiring a local supplier", () => {
    const result = validateInvoice({
      ...base,
      supplier_id: null,
      wafeq_supplier_id: "wafeq-supplier-1",
      wafeq_account_id: "account-6000",
      wafeq_tax_id: "tax-5",
    }, .01, { provider: "wafeq" });
    expect(result.issues.map((issue) => issue.issue_key)).not.toContain("supplier.unresolved");
    expect(result.issues).toEqual([]);
  });

  it("treats Odoo-resolvable local mappings as warnings and accepts Lebanon 11% tax", () => {
    const missing = validateInvoice({
      ...base,
      supplier_id: null,
      company_validation_status: "mismatch",
      tax_amount: 11,
      total_amount: 111,
      line_items: [{ ...base.line_items[0], account_code: undefined, tax_rate: .11 }],
    }, .01, { provider: "odoo" });
    expect(missing.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ issue_key: "supplier.trn_mismatch", blocking: false, severity: "warning" }),
       expect.objectContaining({ issue_key: "supplier.unresolved", blocking: false, severity: "warning" }),
      expect.objectContaining({ issue_key: "account.unmapped.0", blocking: false, severity: "warning" }),
    ]));
    expect(missing.issues.map((issue) => issue.issue_key)).not.toContain("tax.unsupported.0");
     expect(missing.issues.some((issue) => issue.blocking)).toBe(false);

    const valid = validateInvoice(base, .01, { provider: "odoo" });
    expect(valid.issues).toEqual([]);
    expect(validateInvoice({
      ...base,
      line_items: [{ ...base.line_items[0], account_code: undefined }],
    }, .01, { provider: "manual" }).issues).toEqual([]);
    expect(validateInvoice({
      ...base,
      line_items: [{ ...base.line_items[0], account_code: undefined }],
    }, .01, { provider: "none" }).issues).toEqual([]);
  });

  it("does not block Odoo approval when a matched supplier replaces missing OCR vendor text", () => {
    const result = validateInvoice({
      ...base,
      vendor_name: null,
    }, .01, { provider: "odoo" });

    expect(result.issues).toEqual([]);
  });

  it("keeps Odoo duplicates blocking while arithmetic mismatches are warnings", () => {
    const result = validateInvoice({
      ...base,
      supplier_id: null,
      company_validation_status: "mismatch",
      total_amount: 50,
      line_items: [{ ...base.line_items[0], account_code: undefined, tax_rate: .11 }],
    }, .01, { provider: "odoo", duplicate: true });
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ issue_key: "duplicate.risk", blocking: true }),
       expect.objectContaining({ issue_key: "totals.invoice", blocking: false, severity: "warning" }),
       expect.objectContaining({ issue_key: "supplier.unresolved", blocking: false }),
      expect.objectContaining({ issue_key: "account.unmapped.0", blocking: false }),
    ]));
  });

  it("treats Odoo arithmetic reconciliation mismatches as review warnings", () => {
    const result = validateInvoice({
      ...base,
      subtotal: 100,
      tax_amount: 5,
      total_amount: 50,
      line_items: [{ ...base.line_items[0], account_code: undefined }],
    }, .01, { provider: "odoo" });
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ issue_key: "totals.invoice", blocking: false, severity: "warning" }),
      expect.objectContaining({ issue_key: "account.unmapped.0", blocking: false, severity: "warning" }),
    ]));
    expect(result.issues.some((issue) => issue.blocking)).toBe(false);
  });

  it("rejects Wafeq tax and total mismatches against the selected bill tax rate", () => {
    const invoice = {
      ...base,
      wafeq_supplier_id: "wafeq-supplier-1",
      wafeq_account_id: "account-6000",
      wafeq_tax_id: "tax-5",
      tax_amount: 6,
      total_amount: 106,
    };
    const result = validateInvoice(invoice, .01, {
      provider: "wafeq",
      wafeqTaxRates: [{ id: "tax-5", rate: 5 }],
    });
    expect(result.issues.map((issue) => issue.issue_key)).toEqual(expect.arrayContaining([
      "wafeq.tax.amount_mismatch",
      "wafeq.total.amount_mismatch",
    ]));
    expect(result.issues.every((issue) => issue.blocking)).toBe(true);
  });

  it("accepts Wafeq tax and total values after currency-safe rounding", () => {
    const result = validateInvoice({
      ...base,
      subtotal: 100.01,
      tax_amount: 5,
      total_amount: 105.01,
      wafeq_supplier_id: "wafeq-supplier-1",
      wafeq_account_id: "account-6000",
      wafeq_tax_id: "tax-5",
      line_items: [{ ...base.line_items[0], unit_price: 100.01 }],
    }, .01, {
      provider: "wafeq",
      wafeqTaxRates: [{ id: "tax-5", rate: 5 }],
    });
    expect(result.issues).toEqual([]);
  });

  it.each([
    ["missing", {}],
    ["non-numeric", { rate: "not-a-rate" }],
    ["non-finite", { rate: Number.POSITIVE_INFINITY }],
    ["negative", { rate: -5 }],
    ["out of range", { rate: 101 }],
  ])("blocks Wafeq taxes with a %s rate instead of skipping reconciliation", (_name, tax) => {
    const result = validateInvoice({
      ...base,
      wafeq_supplier_id: "wafeq-supplier-1",
      wafeq_account_id: "account-6000",
      wafeq_tax_id: "tax-malformed",
    }, .01, {
      provider: "wafeq",
      wafeqTaxRates: [{ id: "tax-malformed", ...tax }],
    });
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ issue_key: "wafeq.tax.rate_invalid", blocking: true }),
    ]));
  });

  it("accepts a valid zero Wafeq tax rate", () => {
    const result = validateInvoice({
      ...base,
      tax_amount: 0,
      total_amount: 100,
      wafeq_supplier_id: "wafeq-supplier-1",
      wafeq_account_id: "account-6000",
      wafeq_tax_id: "tax-zero",
    }, .01, {
      provider: "wafeq",
      wafeqTaxRates: [{ id: "tax-zero", rate: 0 }],
    });
    expect(result.issues).toEqual([]);
  });
});