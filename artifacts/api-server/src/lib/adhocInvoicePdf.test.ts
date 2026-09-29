import { describe, it, expect } from "vitest";
import {
  buildAdhocInvoiceData,
  buildAdhocInvoicePdf,
  generateAdhocInvoiceNumber,
} from "./adhocInvoicePdf";
import { SAL_SENDER_LINES, SAL_MOF_NUMBER } from "./orderInvoicePdf";

function isPdf(buf: Buffer): boolean {
  return buf.length > 4 && buf.subarray(0, 5).toString("latin1") === "%PDF-";
}

describe("generateAdhocInvoiceNumber", () => {
  it("produces an INV-YYYYMMDD-XXXXXXXX label", () => {
    const num = generateAdhocInvoiceNumber(new Date("2026-07-03T12:00:00Z"));
    expect(num).toMatch(/^INV-20260703-[0-9A-F]{8}$/);
  });
});

describe("buildAdhocInvoiceData", () => {
  it("always uses the Presentail SAL sender (MOF number present)", () => {
    const empty = buildAdhocInvoiceData({});
    expect(empty.senderLines).toEqual(SAL_SENDER_LINES);
    expect(empty.senderLines).toContain(`MOF: ${SAL_MOF_NUMBER}`);

    const filled = buildAdhocInvoiceData({
      name: "Jane",
      email: "jane@example.com",
      address: "Beirut, Lebanon",
      item: "Bouquet",
      amount: 50,
      currency: "aed",
    });
    expect(filled.senderLines).toEqual(SAL_SENDER_LINES);
  });

  it("maps blank/omitted fields to nulls and defaults", () => {
    const data = buildAdhocInvoiceData({ name: "  ", email: "", address: null });
    expect(data.billToName).toBeNull();
    expect(data.billToEmail).toBeNull();
    expect(data.billToCountry).toBeNull();
    expect(data.items).toEqual([]);
    expect(data.subtotal).toBe(0);
    expect(data.total).toBe(0);
    expect(data.amountDue).toBe(0);
    expect(data.currency).toBe("USD");
    expect(data.dateDue).toBeInstanceOf(Date);
    expect(new Date(data.dateDue!).toDateString()).toBe(new Date(data.dateOfIssue).toDateString());
  });

  it("does not force a VAT line when the amount is blank/zero", () => {
    const data = buildAdhocInvoiceData({ name: "Jane" });
    expect(data.vatRate).toBe(11);
    expect(data.vatAmount).toBeNull();
    expect(data.subtotal).toBe(0);
    expect(data.total).toBe(0);
  });

  it("breaks out an included 11% VAT line from the entered amount", () => {
    const data = buildAdhocInvoiceData({ amount: 111, currency: "usd" });
    expect(data.vatRate).toBe(11);
    // 111 is VAT-inclusive: subtotal = 111 / 1.11 = 100, VAT = 11.
    expect(data.vatAmount).toBe(11);
    expect(data.subtotal).toBe(100);
    expect(data.total).toBe(111);
    expect(data.amountDue).toBe(111);
    // Subtotal + VAT equals Total exactly to two decimals.
    expect(Math.round((Number(data.subtotal) + (data.vatAmount ?? 0)) * 100) / 100).toBe(data.total);
  });

  it("keeps subtotal + VAT equal to total for non-round amounts", () => {
    const data = buildAdhocInvoiceData({ amount: 75.5, currency: "eur" });
    expect(data.vatRate).toBe(11);
    expect(data.total).toBe(75.5);
    expect(Math.round((Number(data.subtotal) + (data.vatAmount ?? 0)) * 100) / 100).toBe(75.5);
    expect(data.vatAmount).toBeGreaterThan(0);
  });

  it("maps filled fields onto the invoice data shape", () => {
    const data = buildAdhocInvoiceData({
      name: " Jane Doe ",
      email: "jane@example.com",
      address: "Hamra St, Beirut",
      item: "Rose Bouquet",
      amount: 75.5,
      currency: "eur",
    });
    expect(data.billToName).toBe("Jane Doe");
    expect(data.billToEmail).toBe("jane@example.com");
    expect(data.billToCountry).toBe("Hamra St, Beirut");
    expect(data.currency).toBe("EUR");
    expect(data.items).toEqual([
      { name: "Rose Bouquet", quantity: 1, unitPrice: 75.5, amount: 75.5 },
    ]);
    // The amount is VAT-inclusive: subtotal is the VAT-exclusive figure.
    expect(data.total).toBe(75.5);
    expect(data.amountDue).toBe(75.5);
    expect(Math.round((Number(data.subtotal) + (data.vatAmount ?? 0)) * 100) / 100).toBe(75.5);
  });

  it("renders a line item when only the amount is provided", () => {
    const data = buildAdhocInvoiceData({ amount: 20 });
    expect(data.items).toEqual([{ name: "", quantity: 1, unitPrice: 20, amount: 20 }]);
    expect(data.total).toBe(20);
  });

  it("renders a line item with null amount when only the item is provided", () => {
    const data = buildAdhocInvoiceData({ item: "Consulting" });
    expect(data.items).toEqual([
      { name: "Consulting", quantity: 1, unitPrice: null, amount: null },
    ]);
    expect(data.total).toBe(0);
  });

  it("ignores negative or non-finite amounts", () => {
    expect(buildAdhocInvoiceData({ amount: -5 }).items).toEqual([]);
    expect(buildAdhocInvoiceData({ amount: Number.NaN }).items).toEqual([]);
  });
});

describe("buildAdhocInvoicePdf", () => {
  it("renders a valid PDF with all fields empty", async () => {
    const pdf = await buildAdhocInvoicePdf({});
    expect(isPdf(pdf)).toBe(true);
    expect(pdf.length).toBeGreaterThan(1000);
  });

  it("renders a valid PDF with all fields filled", async () => {
    const pdf = await buildAdhocInvoicePdf({
      name: "Jane Doe",
      email: "jane@example.com",
      address: "Hamra St, Beirut, Lebanon",
      item: "Rose Bouquet (Large)",
      amount: 120,
      currency: "USD",
    });
    expect(isPdf(pdf)).toBe(true);
    expect(pdf.length).toBeGreaterThan(1000);
  });
});
