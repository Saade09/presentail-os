import { describe, it, expect } from "vitest";
import {
  resolveInvoiceSenderLines,
  buildOrderInvoicePdf,
  isWhishPayment,
  includedVatAmount,
  SAL_SENDER_LINES,
  LTD_SENDER_LINES,
  SAL_MOF_NUMBER,
  WHISH_VAT_RATE,
  type OrderInvoiceData,
} from "./orderInvoicePdf";

describe("resolveInvoiceSenderLines", () => {
  it("returns the Presentail LTD sender for Stripe payments (any casing)", () => {
    expect(resolveInvoiceSenderLines("stripe", null)).toEqual(LTD_SENDER_LINES);
    expect(resolveInvoiceSenderLines("Stripe", null)).toEqual(LTD_SENDER_LINES);
    expect(resolveInvoiceSenderLines("STRIPE", null)).toEqual(LTD_SENDER_LINES);
    expect(resolveInvoiceSenderLines(null, "stripe")).toEqual(LTD_SENDER_LINES);
    expect(resolveInvoiceSenderLines("card", "Stripe")).toEqual(LTD_SENDER_LINES);
    expect(resolveInvoiceSenderLines("  stripe  ", null)).toEqual(LTD_SENDER_LINES);
  });

  it("returns the Presentail LTD sender for PayPal payments (any casing)", () => {
    expect(resolveInvoiceSenderLines("paypal", null)).toEqual(LTD_SENDER_LINES);
    expect(resolveInvoiceSenderLines("PayPal", null)).toEqual(LTD_SENDER_LINES);
    expect(resolveInvoiceSenderLines(null, "PAYPAL")).toEqual(LTD_SENDER_LINES);
    expect(resolveInvoiceSenderLines("wallet", "paypal")).toEqual(LTD_SENDER_LINES);
  });

  it("keeps the Presentail SAL sender for Whish payments (any casing)", () => {
    expect(resolveInvoiceSenderLines("whish", null)).toEqual(SAL_SENDER_LINES);
    expect(resolveInvoiceSenderLines("Whish", null)).toEqual(SAL_SENDER_LINES);
    expect(resolveInvoiceSenderLines(null, "WHISH")).toEqual(SAL_SENDER_LINES);
    expect(resolveInvoiceSenderLines("wallet", "whish")).toEqual(SAL_SENDER_LINES);
  });

  it("keeps the Presentail SAL sender for cash/COD/other/no payment", () => {
    expect(resolveInvoiceSenderLines("cash", null)).toEqual(SAL_SENDER_LINES);
    expect(resolveInvoiceSenderLines("cod", "manual")).toEqual(SAL_SENDER_LINES);
    expect(resolveInvoiceSenderLines(null, null)).toEqual(SAL_SENDER_LINES);
    expect(resolveInvoiceSenderLines(undefined, undefined)).toEqual(SAL_SENDER_LINES);
    expect(resolveInvoiceSenderLines("", "")).toEqual(SAL_SENDER_LINES);
    // Substrings must not match — only exact stripe/paypal values.
    expect(resolveInvoiceSenderLines("stripe_terminal_x", null)).toEqual(SAL_SENDER_LINES);
  });

  it("LTD sender includes the company name and Cyprus address lines", () => {
    expect(LTD_SENDER_LINES[0]).toBe("Presentail LTD");
    expect(LTD_SENDER_LINES.join(" ")).toContain("Nicosia, Cyprus");
    expect(LTD_SENDER_LINES.join(" ")).toContain("IRIS TOWER");
  });

  it("SAL sender includes the MOF number; LTD sender does not", () => {
    expect(SAL_SENDER_LINES[0]).toBe("Presentail SAL");
    expect(SAL_SENDER_LINES).toContain(`MOF: ${SAL_MOF_NUMBER}`);
    expect(SAL_MOF_NUMBER).toBe("3616289-601");
    expect(LTD_SENDER_LINES.join(" ")).not.toContain("MOF");
  });
});

describe("isWhishPayment", () => {
  it("matches Whish on method or provider, any casing", () => {
    expect(isWhishPayment("whish", null)).toBe(true);
    expect(isWhishPayment("Whish", null)).toBe(true);
    expect(isWhishPayment(null, "WHISH")).toBe(true);
    expect(isWhishPayment("wallet", "whish")).toBe(true);
    expect(isWhishPayment("  whish  ", null)).toBe(true);
  });

  it("does not match other methods, substrings, or missing payments", () => {
    expect(isWhishPayment("stripe", null)).toBe(false);
    expect(isWhishPayment("cash", null)).toBe(false);
    expect(isWhishPayment("whish_money", null)).toBe(false);
    expect(isWhishPayment(null, null)).toBe(false);
    expect(isWhishPayment(undefined, undefined)).toBe(false);
    expect(isWhishPayment("", "")).toBe(false);
  });
});

describe("includedVatAmount", () => {
  it("computes the included 11% VAT rounded to 2 decimals", () => {
    // 111 total → 100 net + 11 VAT
    expect(includedVatAmount(111, WHISH_VAT_RATE)).toBe(11);
    // 45 total → 45 - 45/1.11 = 4.459... → 4.46
    expect(includedVatAmount(45, WHISH_VAT_RATE)).toBe(4.46);
    expect(includedVatAmount(100, WHISH_VAT_RATE)).toBe(9.91);
  });

  it("returns 0 for zero/negative/invalid totals or rates", () => {
    expect(includedVatAmount(0, WHISH_VAT_RATE)).toBe(0);
    expect(includedVatAmount(-10, WHISH_VAT_RATE)).toBe(0);
    expect(includedVatAmount(NaN, WHISH_VAT_RATE)).toBe(0);
    expect(includedVatAmount(100, 0)).toBe(0);
  });
});

describe("buildOrderInvoicePdf senderLines", () => {
  const baseData: OrderInvoiceData = {
    invoiceNumber: "INV-1",
    currency: "USD",
    dateOfIssue: new Date("2026-07-02T00:00:00Z"),
    dateDue: new Date("2026-07-01T00:00:00Z"),
    billToName: "Jane Doe",
    billToCountry: "Cyprus",
    billToEmail: "jane@example.com",
    items: [{ name: "Rose Bouquet", quantity: 1, unitPrice: 30, amount: 30 }],
    subtotal: 30,
    total: 30,
    amountDue: 30,
  };

  function isPdf(buf: Buffer): boolean {
    return buf.length > 4 && buf.subarray(0, 5).toString("latin1") === "%PDF-";
  }

  it("renders a valid PDF with the multi-line LTD sender", async () => {
    const pdf = await buildOrderInvoicePdf({ ...baseData, senderLines: LTD_SENDER_LINES });
    expect(isPdf(pdf)).toBe(true);
    expect(pdf.length).toBeGreaterThan(1000);
  });

  it("renders a valid PDF with the default SAL sender when senderLines is omitted", async () => {
    const pdf = await buildOrderInvoicePdf(baseData);
    expect(isPdf(pdf)).toBe(true);
    expect(pdf.length).toBeGreaterThan(1000);
  });

  it("renders a valid PDF with a VAT row (Whish-style data)", async () => {
    const pdf = await buildOrderInvoicePdf({
      ...baseData,
      senderLines: SAL_SENDER_LINES,
      vatRate: WHISH_VAT_RATE,
      vatAmount: includedVatAmount(30, WHISH_VAT_RATE),
    });
    expect(isPdf(pdf)).toBe(true);
    expect(pdf.length).toBeGreaterThan(1000);
  });

  it("renders a valid PDF when vatAmount is 0/absent (no VAT row)", async () => {
    const pdf = await buildOrderInvoicePdf({ ...baseData, vatAmount: 0 });
    expect(isPdf(pdf)).toBe(true);
  });
});
