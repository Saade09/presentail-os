/**
 * Smoke tests for buildPurchaseOrderPdf edge cases.
 * Exercises: missing images, missing Arabic names, missing createdByName,
 * nullable numeric fields, cost summary with nulls, empty line items.
 * Skips automatically when no Chromium is resolvable.
 */
import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import { chromium } from "playwright-core";
import { buildPurchaseOrderPdf, closePoPdfBrowser, type PoPdfData, type PoPdfLineItem } from "./poPdf";

function chromiumAvailable(): boolean {
  const envCandidates = [
    process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
  ];
  for (const c of envCandidates) {
    if (c && fs.existsSync(c)) return true;
  }
  try {
    const p = chromium.executablePath();
    if (p && fs.existsSync(p)) return true;
  } catch { /* ignore */ }
  for (const c of ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"]) {
    if (fs.existsSync(c)) return true;
  }
  const names = ["chromium", "chromium-browser", "google-chrome"];
  const dirs = (process.env.PATH ?? "").split(":").filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      try { if (fs.existsSync(`${dir}/${name}`)) return true; } catch { /* ignore */ }
    }
  }
  return false;
}

const HAS_CHROMIUM = chromiumAvailable();

function baseData(): PoPdfData {
  return {
    poNumberLabel: "PO-SMOKE-001",
    status: "confirmed",
    supplierName: "Smoke Supplier",
    locationName: "Smoke Location",
    totalLabel: "USD 100.00",
    calculatedTotal: 100,
    currency: "USD",
    effectiveTotal: "100.00",
    expectedDeliveryLabel: "July 17, 2026",
    createdLabel: "July 1, 2026",
    createdByName: "Test User",
    paymentTerms: "Net 30",
    supplierReference: "REF-001",
    notes: "Test notes",
    costSummary: {
      subtotalAmount: "90.00",
      discountAmount: null,
      deliveryFeeAmount: null,
      vatTreatment: "vat_exclusive",
      vatRate: "11",
      vatAmount: "9.90",
      vatManualOverride: false,
      grandTotalAmount: "99.90",
    },
    lineItems: [
      {
        description: "Red Roses",
        descriptionAr: "ورد أحمر",
        baseItemName: "Rose Bundle",
        supplierItemCode: "ROSE-001",
        quantity: "10",
        unitPrice: "10.00",
        currency: "USD",
        taxCategory: "standard_taxable",
        appliedTaxRate: "11",
        taxAmount: null,
        imageUrl: null,
      },
    ],
  };
}

describe.skipIf(!HAS_CHROMIUM)("poPdf smoke tests", () => {
  afterAll(async () => {
    await closePoPdfBrowser();
  });

  it("generates a valid PDF for a fully populated PO", async () => {
    const buf = await buildPurchaseOrderPdf(baseData());
    expect(buf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(buf.length).toBeGreaterThan(1000);
  }, 40000);

  it("generates a valid PDF when all line-item image URLs are null (no image)", async () => {
    const data = baseData();
    data.lineItems[0].imageUrl = null;
    const buf = await buildPurchaseOrderPdf(data);
    expect(buf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  }, 40000);

  it("generates a valid PDF when descriptionAr is null (no Arabic text)", async () => {
    const data = baseData();
    data.lineItems[0].descriptionAr = null;
    const buf = await buildPurchaseOrderPdf(data);
    expect(buf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  }, 40000);

  it("generates a valid PDF when createdByName is null", async () => {
    const data = baseData();
    data.createdByName = null;
    const buf = await buildPurchaseOrderPdf(data);
    expect(buf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  }, 40000);

  it("generates a valid PDF when locationName is null", async () => {
    const data = baseData();
    data.locationName = null;
    const buf = await buildPurchaseOrderPdf(data);
    expect(buf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  }, 40000);

  it("generates a valid PDF when cost summary fields are all null", async () => {
    const data = baseData();
    data.costSummary = {
      subtotalAmount: null,
      discountAmount: null,
      deliveryFeeAmount: null,
      vatTreatment: null,
      vatRate: null,
      vatAmount: null,
      vatManualOverride: false,
      grandTotalAmount: null,
    };
    const buf = await buildPurchaseOrderPdf(data);
    expect(buf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  }, 40000);

  it("generates a valid PDF when calculatedTotal is null and effectiveTotal is null", async () => {
    const data = baseData();
    data.calculatedTotal = null;
    data.effectiveTotal = null;
    data.totalLabel = "—";
    const buf = await buildPurchaseOrderPdf(data);
    expect(buf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  }, 40000);

  it("generates a valid PDF with no line items at all", async () => {
    const data = baseData();
    data.lineItems = [];
    data.calculatedTotal = null;
    data.effectiveTotal = null;
    const buf = await buildPurchaseOrderPdf(data);
    expect(buf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  }, 40000);

  it("generates a valid PDF with multiple line items, mixed Arabic and null", async () => {
    const data = baseData();
    const li = (n: number, ar: string | null): PoPdfLineItem => ({
      description: `Item ${n}`,
      descriptionAr: ar,
      baseItemName: null,
      supplierItemCode: null,
      quantity: "5",
      unitPrice: "20.00",
      currency: "USD",
      taxCategory: null,
      appliedTaxRate: null,
      taxAmount: null,
      imageUrl: null,
    });
    data.lineItems = [li(1, "صنف واحد"), li(2, null), li(3, "ثلاثة")];
    data.calculatedTotal = 300;
    data.effectiveTotal = "300.00";
    data.totalLabel = "USD 300.00";
    const buf = await buildPurchaseOrderPdf(data);
    expect(buf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  }, 40000);

  it("generates a valid PDF when an image URL returns a connection-refused error", async () => {
    // Use a port on localhost that has no listener → ECONNREFUSED → instant failure.
    // (We can't use a TCP black-hole in the sandbox because the OS timeout
    // exceeds any reasonable test deadline even with AbortSignal.timeout.)
    const data = baseData();
    data.lineItems[0].imageUrl = "http://localhost:19999/nonexistent.jpg";
    const buf = await buildPurchaseOrderPdf(data);
    expect(buf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  }, 40000);

  it("handles special characters in PO number for filename safety", () => {
    const poNumber = "PO/2026-003 (Draft)";
    const safe = `PO-${poNumber.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    expect(safe).toBe("PO-PO_2026-003__Draft_");
    expect(/[^a-zA-Z0-9_\-.]/.test(safe)).toBe(false);
  });
});
