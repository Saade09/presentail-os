/**
 * Unit tests for the bilingual (English / Arabic) PO PDF rendering.
 * HTML output assertions run without a browser.
 * Chromium smoke tests are skipped automatically when no browser is available.
 */
import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import { chromium } from "playwright-core";
import {
  buildPoPdfHtml,
  buildPurchaseOrderPdf,
  closePoPdfBrowser,
  type PoPdfData,
  type PoPdfLineItem,
} from "./poPdf";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    poNumberLabel: "PO-0042",
    status: "sent",
    supplierName: "Test Supplier",
    locationName: "Dubai HQ",
    totalLabel: "AED 500.00",
    calculatedTotal: 500,
    currency: "AED",
    effectiveTotal: "500.00",
    expectedDeliveryLabel: "August 20, 2026",
    createdLabel: "August 1, 2026",
    createdByName: "Admin User",
    paymentTerms: "Net 30",
    supplierReference: "SUP-REF-001",
    notes: "Test notes",
    costSummary: {
      subtotalAmount: "500.00",
      discountAmount: null,
      deliveryFeeAmount: null,
      vatTreatment: "vat_exclusive",
      vatRate: "5",
      vatAmount: "25.00",
      vatManualOverride: false,
      grandTotalAmount: "525.00",
    },
    lineItems: [
      {
        description: "Red Roses",
        descriptionAr: "ورد أحمر",
        baseItemName: null,
        supplierItemCode: "ROSE-001",
        quantity: "10",
        unitPrice: "50.00",
        currency: "AED",
        taxCategory: null,
        appliedTaxRate: null,
        taxAmount: null,
        imageUrl: null,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// HTML-level unit tests (no browser required)
// ---------------------------------------------------------------------------

describe("buildPoPdfHtml — English (default)", () => {
  it("does not include dir=rtl on the <html> element", () => {
    const html = buildPoPdfHtml(baseData(), "en");
    // The <html> element must not be RTL; secondary Arabic sub-lines may still
    // carry dir="rtl" on their own div, so we check the <html> tag specifically.
    expect(html).not.toContain('<html dir="rtl"');
  });

  it("contains the English label 'Purchase Order'", () => {
    const html = buildPoPdfHtml(baseData(), "en");
    expect(html).toContain("Purchase Order");
  });

  it("does not contain Arabic 'أمر شراء' label in the English branch", () => {
    const html = buildPoPdfHtml(baseData(), "en");
    // The Arabic item description may be present as a secondary line; the
    // Arabic *label* (used as the document/subtitle) must not appear.
    // We check that the brand-subtitle div contains "Purchase Order", not the Arabic label.
    expect(html).toContain('<div class="brand-subtitle">Purchase Order</div>');
    expect(html).not.toContain('<div class="brand-subtitle">أمر شراء</div>');
  });

  it("omitting language param defaults to English", () => {
    const htmlDefault = buildPoPdfHtml(baseData());
    const htmlEn = buildPoPdfHtml(baseData(), "en");
    expect(htmlDefault).toBe(htmlEn);
  });

  it("contains description column header 'Description'", () => {
    const html = buildPoPdfHtml(baseData(), "en");
    expect(html).toContain("Description");
  });
});

describe("buildPoPdfHtml — Arabic RTL", () => {
  it("includes dir=rtl on <html>", () => {
    const html = buildPoPdfHtml(baseData(), "ar");
    expect(html).toMatch(/dir="rtl"/);
  });

  it("includes lang=ar on <html>", () => {
    const html = buildPoPdfHtml(baseData(), "ar");
    expect(html).toMatch(/lang="ar"/);
  });

  it("contains the Arabic 'أمر شراء' subtitle", () => {
    const html = buildPoPdfHtml(baseData(), "ar");
    expect(html).toContain("أمر شراء");
  });

  it("does not contain the English brand subtitle 'Purchase Order' as a bare label", () => {
    const html = buildPoPdfHtml(baseData(), "ar");
    // Bare 'Purchase Order' as brand subtitle must not appear
    expect(html).not.toContain('<div class="brand-subtitle">Purchase Order</div>');
  });

  it("uses the Arabic item name (descriptionAr) for the line item", () => {
    const html = buildPoPdfHtml(baseData(), "ar");
    expect(html).toContain("ورد أحمر");
  });

  it("applies dir=rtl to body styles", () => {
    const html = buildPoPdfHtml(baseData(), "ar");
    expect(html).toContain("direction: rtl");
  });

  it("prioritises NotoSansArabic font on body", () => {
    const html = buildPoPdfHtml(baseData(), "ar");
    // In Arabic mode the font stack starts with NotoSansArabic
    expect(html).toMatch(/font-family:\s*'Noto Sans Arabic'/);
  });

  it("wraps the supplier code in a dir=ltr span", () => {
    const html = buildPoPdfHtml(baseData(), "ar");
    expect(html).toContain('dir="ltr"');
    // The code ROSE-001 must appear inside an ltr span
    expect(html).toMatch(/<span dir="ltr">.*?ROSE-001.*?<\/span>/s);
  });

  it("Arabic item name is NOT directly wrapped in a dir=ltr span", () => {
    const html = buildPoPdfHtml(baseData(), "ar");
    // Check that the Arabic name isn't the direct content of an ltr span.
    // We don't use dotall here to avoid false positives from unrelated ltr spans
    // elsewhere in the same row (prices, codes etc.) that appear before the name.
    expect(html).not.toContain('<span dir="ltr">ورد أحمر');
    expect(html).not.toContain('ورد أحمر</span>');
  });

  it("contains Arabic label for Grand Total column header area", () => {
    const html = buildPoPdfHtml(baseData(), "ar");
    // الإجمالي الكلي is the grand total label
    expect(html).toContain("الإجمالي الكلي");
  });

  it("contains Arabic quantity column header", () => {
    const html = buildPoPdfHtml(baseData(), "ar");
    expect(html).toContain("الكمية");
  });
});

describe("buildPoPdfHtml — Arabic: fallback when descriptionAr is null", () => {
  it("renders the English description without throwing when descriptionAr is null", () => {
    const data = baseData();
    data.lineItems[0].descriptionAr = null;
    let html: string;
    expect(() => { html = buildPoPdfHtml(data, "ar"); }).not.toThrow();
    // Should fall back to English description
    expect(html!).toContain("Red Roses");
  });

  it("does not crash when all optional fields are null", () => {
    const data = baseData();
    data.lineItems[0].descriptionAr = null;
    data.locationName = null;
    data.createdByName = null;
    data.paymentTerms = null;
    data.supplierReference = null;
    data.notes = null;
    expect(() => buildPoPdfHtml(data, "ar")).not.toThrow();
  });
});

describe("buildPoPdfHtml — invalid/missing language defaults to English", () => {
  it("treats an invalid language value as English", () => {
    // The route coerces unknown values to 'en', but buildPoPdfHtml also defaults to 'en'
    // @ts-expect-error — deliberately passing invalid value
    const html = buildPoPdfHtml(baseData(), "fr");
    // Default branch produces English output
    expect(html).toContain("Purchase Order");
    // The <html> element must not carry RTL direction
    expect(html).not.toContain('<html dir="rtl"');
  });
});

describe("buildPoPdfHtml — mixed Arabic + English line item", () => {
  it("supplier code is inside dir=ltr span and Arabic name is outside it", () => {
    const data = baseData();
    data.lineItems[0].descriptionAr = "ورد أحمر";
    data.lineItems[0].supplierItemCode = "ROSE-XYZ-99";
    const html = buildPoPdfHtml(data, "ar");

    // Supplier code must be LTR-isolated
    expect(html).toMatch(/<span dir="ltr">.*?ROSE-XYZ-99.*?<\/span>/s);

    // Arabic name must NOT be directly wrapped in an LTR span
    expect(html).not.toContain('<span dir="ltr">ورد أحمر');
    expect(html).not.toContain('ورد أحمر</span>');
  });
});

// ---------------------------------------------------------------------------
// English PDF regression — content-type + filename suffix
// ---------------------------------------------------------------------------

describe("buildPurchaseOrderPdf — English regression (no browser required for HTML)", () => {
  it("buildPoPdfHtml English output is identical whether language is omitted or 'en'", () => {
    const a = buildPoPdfHtml(baseData());
    const b = buildPoPdfHtml(baseData(), "en");
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Chromium smoke tests (skipped when no browser available)
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_CHROMIUM)("buildPurchaseOrderPdf — Arabic PDF smoke test", () => {
  afterAll(async () => {
    await closePoPdfBrowser();
  });

  it("produces a non-empty PDF buffer for language=ar", async () => {
    const buf = await buildPurchaseOrderPdf(baseData(), "ar");
    expect(buf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(buf.length).toBeGreaterThan(1000);
  }, 40000);

  it("produces a non-empty PDF buffer for language=en (regression)", async () => {
    const buf = await buildPurchaseOrderPdf(baseData(), "en");
    expect(buf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(buf.length).toBeGreaterThan(1000);
  }, 40000);

  it("Arabic PDF: descriptionAr null falls back without crashing", async () => {
    const data = baseData();
    data.lineItems[0].descriptionAr = null;
    const buf = await buildPurchaseOrderPdf(data, "ar");
    expect(buf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  }, 40000);
});
