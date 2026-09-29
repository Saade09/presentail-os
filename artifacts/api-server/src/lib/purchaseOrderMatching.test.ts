import { describe, it, expect } from "vitest";
import { computeThreeWayMatch } from "./purchaseOrderMatching";

const defaultPo = { currency: "AED", grand_total_amount: "1000.00", effective_total: "1000.00" };

const defaultLineItems = [
  { quantity: "10", unit_price: "80.00", received_quantity: "10" },
  { quantity: "5", unit_price: "40.00", received_quantity: "5" },
];

const matchedInvoice = [
  { grand_total: "1000.00", amount: "1000.00", currency: "AED" },
];

describe("computeThreeWayMatch", () => {
  it("returns awaiting_invoice when no invoices are linked", () => {
    const result = computeThreeWayMatch(defaultPo, defaultLineItems, []);
    expect(result.overallStatus).toBe("awaiting_invoice");
    expect(result.readyForApproval).toBe(false);
    expect(result.summary.totalLinkedInvoices).toBe(0);
    expect(result.summary.invoicedAmount).toBeNull();
  });

  it("returns matched when all quantities received and invoice total matches PO", () => {
    const result = computeThreeWayMatch(defaultPo, defaultLineItems, matchedInvoice);
    expect(result.overallStatus).toBe("matched");
    expect(result.readyForApproval).toBe(true);
    expect(result.checks.currency).toBe("ok");
    expect(result.checks.totalInvoiced).toBe("ok");
    expect(result.checks.quantitiesReceived).toBe("ok");
    expect(result.discrepancies).toHaveLength(0);
  });

  it("returns partially_invoiced when invoiced amount is less than PO amount", () => {
    const result = computeThreeWayMatch(
      defaultPo,
      defaultLineItems,
      [{ grand_total: "500.00", amount: "500.00", currency: "AED" }],
    );
    expect(result.overallStatus).toBe("partially_invoiced");
    expect(result.readyForApproval).toBe(false);
    expect(result.summary.invoicedAmount).toBeCloseTo(500, 1);
  });

  it("returns difference_found when invoice amount exceeds PO amount", () => {
    const result = computeThreeWayMatch(
      defaultPo,
      defaultLineItems,
      [{ grand_total: "1200.00", amount: "1200.00", currency: "AED" }],
    );
    expect(result.overallStatus).toBe("difference_found");
    expect(result.readyForApproval).toBe(false);
    expect(result.checks.totalInvoiced).toBe("error");
  });

  it("returns difference_found on currency mismatch", () => {
    const result = computeThreeWayMatch(
      defaultPo,
      defaultLineItems,
      [{ grand_total: "1000.00", amount: "1000.00", currency: "USD" }],
    );
    expect(result.overallStatus).toBe("difference_found");
    expect(result.checks.currency).toBe("warning");
    expect(result.discrepancies.some((d) => d.field === "currency")).toBe(true);
  });

  it("returns fully_invoiced when amount matches but not all items received", () => {
    const partialReceipt = [
      { quantity: "10", unit_price: "80.00", received_quantity: "5" },
      { quantity: "5", unit_price: "40.00", received_quantity: "5" },
    ];
    const result = computeThreeWayMatch(defaultPo, partialReceipt, matchedInvoice);
    expect(result.overallStatus).toBe("fully_invoiced");
    expect(result.readyForApproval).toBe(false);
    expect(result.checks.quantitiesReceived).toBe("warning");
    expect(result.summary.fullyReceivedItems).toBe(1);
    expect(result.summary.totalLineItems).toBe(2);
  });

  it("handles multiple invoices consolidated for one PO", () => {
    const multiInvoice = [
      { grand_total: "600.00", amount: "600.00", currency: "AED" },
      { grand_total: "400.00", amount: "400.00", currency: "AED" },
    ];
    const result = computeThreeWayMatch(defaultPo, defaultLineItems, multiInvoice);
    expect(result.overallStatus).toBe("matched");
    expect(result.summary.invoicedAmount).toBeCloseTo(1000, 1);
    expect(result.summary.totalLinkedInvoices).toBe(2);
  });

  it("handles invoice before receipt — fully_invoiced when no receipts yet", () => {
    const noReceiptsItems = [
      { quantity: "10", unit_price: "80.00", received_quantity: null },
      { quantity: "5", unit_price: "40.00", received_quantity: null },
    ];
    const result = computeThreeWayMatch(defaultPo, noReceiptsItems, matchedInvoice);
    expect(result.overallStatus).toBe("fully_invoiced");
    expect(result.checks.quantitiesReceived).toBe("warning");
  });

  it("handles receipt before invoice — awaiting_invoice", () => {
    const result = computeThreeWayMatch(defaultPo, defaultLineItems, []);
    expect(result.overallStatus).toBe("awaiting_invoice");
    expect(result.summary.fullyReceivedItems).toBe(2);
    expect(result.summary.receivedAmount).toBeCloseTo(1000, 1);
  });

  it("handles partial receipt with partial invoice", () => {
    const partialItems = [
      { quantity: "10", unit_price: "80.00", received_quantity: "6" },
      { quantity: "5", unit_price: "40.00", received_quantity: "3" },
    ];
    const result = computeThreeWayMatch(
      defaultPo,
      partialItems,
      [{ grand_total: "600.00", amount: "600.00", currency: "AED" }],
    );
    expect(result.overallStatus).toBe("partially_invoiced");
    expect(result.readyForApproval).toBe(false);
  });

  it("tolerates tiny rounding differences in amounts (within 1%)", () => {
    const result = computeThreeWayMatch(
      { currency: "AED", grand_total_amount: "1000.00" },
      defaultLineItems,
      [{ grand_total: "1001.00", amount: "1001.00", currency: "AED" }],
    );
    expect(result.overallStatus).toBe("matched");
  });

  it("handles empty line items gracefully", () => {
    const result = computeThreeWayMatch(defaultPo, [], matchedInvoice);
    expect(result.summary.totalLineItems).toBe(0);
    expect(result.checks.quantitiesOrdered).toBe("missing");
  });
});
