import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, type Browser } from "playwright-core";
import { logger } from "./logger";
import { objectStorageService, ObjectNotFoundError } from "./objectStorage";

export interface PoPdfLineItem {
  description: string;
  descriptionAr: string | null;
  baseItemName: string | null;
  supplierItemCode: string | null;
  quantity: string;
  unitPrice: string;
  currency: string;
  taxCategory: string | null;
  appliedTaxRate: string | null;
  taxAmount: string | null;
  imageUrl: string | null;
}

export interface PoPdfCostSummary {
  subtotalAmount: string | null;
  discountAmount: string | null;
  deliveryFeeAmount: string | null;
  vatTreatment: string | null;
  vatRate: string | null;
  vatAmount: string | null;
  vatManualOverride: boolean;
  grandTotalAmount: string | null;
}

export interface PoPdfData {
  poNumberLabel: string;
  status: string;
  supplierName: string;
  locationName: string | null;
  totalLabel: string;
  calculatedTotal: number | null;
  currency: string;
  effectiveTotal: string | null;
  expectedDeliveryLabel: string;
  createdLabel: string;
  createdByName: string | null;
  paymentTerms: string | null;
  supplierReference: string | null;
  notes: string | null;
  costSummary: PoPdfCostSummary;
  lineItems: PoPdfLineItem[];
}

const TAX_CATEGORY_LABELS: Record<string, string> = {
  standard_taxable: "Standard",
  zero_rated: "Zero-rated",
  exempt: "Exempt",
  non_taxable: "Non-taxable",
  food_grocery: "Food/Grocery",
  packaging: "Packaging",
  service: "Service",
  import_related: "Import",
};

/** Arabic static label translations for the bilingual PDF. */
const AR_LABELS = {
  purchaseOrder: "أمر شراء",
  poNumber: "رقم أمر الشراء",
  supplier: "المورد",
  location: "الموقع",
  createdDate: "تاريخ الإنشاء",
  expectedDelivery: "تاريخ التسليم المتوقع",
  createdBy: "أنشئ بواسطة",
  status: "الحالة",
  totalAmount: "إجمالي المبلغ",
  paymentTerms: "شروط الدفع",
  supplierReference: "مرجع المورد",
  notes: "ملاحظات",
  item: "الصنف",
  supplierItemCode: "كود المورد",
  quantity: "الكمية",
  unitPrice: "سعر الوحدة",
  lineTotal: "الإجمالي",
  costSummary: "ملخص التكلفة",
  subtotal: "المجموع الفرعي",
  discount: "خصم",
  deliveryFee: "رسوم التوصيل",
  vat: "ضريبة القيمة المضافة",
  tax: "الضريبة",
  grandTotal: "الإجمالي الكلي",
  netSubtotal: "صافي المجموع الفرعي",
  grossTotal: "الإجمالي الشامل",
  noLineItems: "لا توجد بنود.",
  footer: "تم إنشاء أمر الشراء هذا بواسطة Presentail OS · os.presentail.com",
  noVat: "لا توجد ضريبة",
  incl: "شامل",
  excl: "غير شامل",
  manualOverride: "[تجاوز يدوي]",
} as const;

/**
 * Resolve the bundled PO PDF asset directory (fonts). Fonts are shared with
 * the gift-card PDF renderer to avoid duplicating font files in the bundle.
 */
function findAssetDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "assets", "giftcard"),
    path.resolve(here, "../assets/giftcard"),
    path.resolve(here, "../../assets/giftcard"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
}

const ASSET_DIR = findAssetDir();
const FONTS_DIR = path.join(ASSET_DIR, "fonts");
const FONT_LATIN = path.join(FONTS_DIR, "NotoSans.ttf");
const FONT_ARABIC = path.join(FONTS_DIR, "NotoSansArabic.ttf");

const fileUrl = (p: string): string => pathToFileURL(p).href;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Wrap a value that must not be bidi-reordered in an LTR isolation span. */
function ltr(val: string): string {
  return `<span dir="ltr">${val}</span>`;
}

const IMAGE_FETCH_TIMEOUT_MS = 5_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out after ${ms}ms: ${label}`)), ms),
    ),
  ]);
}

/**
 * Best-effort fetch of an item photo as a base64 data URL, so the PDF never
 * depends on a live network/auth round-trip at render time (mirrors the
 * gift-card stationery approach). Supports both our internal `/objects/...`
 * private-bucket paths and plain `https://` URLs. Returns null on any failure
 * — a missing photo should never break PDF generation.
 */
async function fetchImageAsDataUrl(imageUrl: string): Promise<string | null> {
  try {
    if (imageUrl.startsWith("/objects/")) {
      const file = await objectStorageService.getObjectEntityFile(imageUrl);
      const [buf, metadata] = await withTimeout(
        Promise.all([file.download().then((r) => r[0]), file.getMetadata().then((r) => r[0])]),
        IMAGE_FETCH_TIMEOUT_MS,
        "object-storage download",
      );
      const contentType = (metadata.contentType as string | undefined) ?? "image/jpeg";
      return `data:${contentType};base64,${buf.toString("base64")}`;
    }
    if (/^https?:\/\//i.test(imageUrl)) {
      // Use AbortSignal.timeout so the TCP connection is actually cancelled when
      // the deadline fires — Promise.race alone abandons the promise without
      // aborting the underlying socket, causing the event loop to stall.
      const signal = AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS);
      const resp = await fetch(imageUrl, { signal });
      if (!resp.ok) return null;
      const contentType = resp.headers.get("content-type") ?? "image/jpeg";
      const buf = Buffer.from(await resp.arrayBuffer());
      return `data:${contentType};base64,${buf.toString("base64")}`;
    }
    return null;
  } catch (err) {
    if (!(err instanceof ObjectNotFoundError)) {
      logger.warn({ err: err instanceof Error ? err.message : String(err), imageUrl }, "Failed to embed purchase order line item image in PDF");
    }
    return null;
  }
}

function fmtNum(val: string | null, decimals = 2): string {
  if (val == null) return "—";
  const n = parseFloat(val);
  if (isNaN(n)) return val;
  return n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtMoney(currency: string, val: string | null, decimals = 2): string {
  if (val == null) return "—";
  return `${currency} ${fmtNum(val, decimals)}`;
}

function buildLineItemRowHtml(li: PoPdfLineItem, language: "en" | "ar" = "en"): string {
  const lineTotal = parseFloat(li.quantity) * parseFloat(li.unitPrice);
  const lineTotalStr = isNaN(lineTotal) ? "—" : fmtMoney(li.currency, lineTotal.toFixed(4));
  const qtyStr = fmtNum(li.quantity, 4).replace(/\.?0+$/, "");
  const priceStr = fmtMoney(li.currency, li.unitPrice);

  const hasMeaningfulCategory = li.taxCategory != null && li.taxCategory !== "not_classified";
  const taxCatLabel = hasMeaningfulCategory ? (TAX_CATEGORY_LABELS[li.taxCategory!] ?? li.taxCategory) : null;
  const taxRateLabel = li.appliedTaxRate != null ? `${parseFloat(li.appliedTaxRate).toFixed(2)}%` : null;
  const taxAmtLabel = li.taxAmount != null ? `+tax ${fmtMoney(li.currency, li.taxAmount)}` : null;
  const taxSubLine = [taxCatLabel, taxRateLabel].filter(Boolean).join(" · ");

  const photoCell = li.imageUrl
    ? `<img class="item-photo" src="${li.imageUrl}" alt="" />`
    : `<div class="item-photo item-photo-empty"></div>`;

  if (language === "ar") {
    // Arabic row: reversed column order [Line Total | Unit Price | Qty | Description | Photo]
    // Mixed content (codes, prices, quantities) wrapped in dir="ltr"
    const itemName = escapeHtml(li.descriptionAr ?? li.description);
    const codeCell = li.supplierItemCode ? ltr(escapeHtml(li.supplierItemCode)) : "—";
    const baseItemLabel = li.baseItemName ? ` (${escapeHtml(li.baseItemName)})` : "";

    return `
  <tr class="item-row">
    <td class="cell num-cell total-cell">${ltr(escapeHtml(lineTotalStr))}</td>
    <td class="cell num-cell">${ltr(escapeHtml(priceStr))}</td>
    <td class="cell num-cell">${ltr(escapeHtml(qtyStr))}</td>
    <td class="cell num-cell">${codeCell}</td>
    <td class="cell desc-cell">
      <div class="desc-ar-main">${itemName}${baseItemLabel}</div>
      ${taxSubLine || taxAmtLabel ? `<div class="tax-subline">${escapeHtml(taxSubLine)}${taxAmtLabel ? ` &nbsp;${escapeHtml(taxAmtLabel)}` : ""}</div>` : ""}
    </td>
    <td class="cell photo-cell">${photoCell}</td>
  </tr>`;
  }

  // English row (original layout)
  const codeLabel = li.supplierItemCode ? ` [${escapeHtml(li.supplierItemCode)}]` : "";
  const baseItemLabel = li.baseItemName ? ` (${escapeHtml(li.baseItemName)})` : "";

  return `
  <tr class="item-row">
    <td class="cell photo-cell">${photoCell}</td>
    <td class="cell desc-cell">
      <div class="desc-en">${escapeHtml(li.description)}${codeLabel}${baseItemLabel}</div>
      ${li.descriptionAr ? `<div class="desc-ar" dir="rtl">${escapeHtml(li.descriptionAr)}</div>` : ""}
      ${taxSubLine || taxAmtLabel ? `<div class="tax-subline">${escapeHtml(taxSubLine)}${taxAmtLabel ? ` &nbsp;${escapeHtml(taxAmtLabel)}` : ""}</div>` : ""}
    </td>
    <td class="cell num-cell">${escapeHtml(qtyStr)}</td>
    <td class="cell num-cell">${escapeHtml(priceStr)}</td>
    <td class="cell num-cell total-cell">${escapeHtml(lineTotalStr)}</td>
  </tr>`;
}

function buildCostSummaryHtml(data: PoPdfData, language: "en" | "ar" = "en"): string {
  const cs = data.costSummary;
  const isAr = language === "ar";
  const lineItemTaxTotal = data.lineItems.reduce((sum, li) => {
    const t = li.taxAmount != null ? parseFloat(li.taxAmount) : 0;
    return sum + (isNaN(t) ? 0 : t);
  }, 0);
  const hasLineItemTax = data.lineItems.some((li) => li.taxAmount != null);

  const hasCostSummary =
    cs.subtotalAmount != null ||
    cs.vatAmount != null ||
    cs.grandTotalAmount != null ||
    cs.discountAmount != null ||
    cs.deliveryFeeAmount != null ||
    cs.vatTreatment != null ||
    hasLineItemTax;

  if (!hasCostSummary) return "";

  const rows: string[] = [];

  function csRow(label: string, value: string): string {
    if (isAr) {
      return `<div class="cs-row"><span>${ltr(value)}</span><span>${label}</span></div>`;
    }
    return `<div class="cs-row"><span>${label}</span><span>${value}</span></div>`;
  }

  if (cs.subtotalAmount != null) {
    rows.push(csRow(isAr ? AR_LABELS.subtotal : "Subtotal", escapeHtml(fmtMoney(data.currency, cs.subtotalAmount))));
  }
  if (cs.discountAmount != null && parseFloat(cs.discountAmount) !== 0) {
    rows.push(csRow(isAr ? AR_LABELS.discount : "Discount", `&minus; ${escapeHtml(fmtMoney(data.currency, cs.discountAmount))}`));
  }
  if (cs.deliveryFeeAmount != null && parseFloat(cs.deliveryFeeAmount) !== 0) {
    rows.push(csRow(isAr ? AR_LABELS.deliveryFee : "Delivery Fee", `+ ${escapeHtml(fmtMoney(data.currency, cs.deliveryFeeAmount))}`));
  }
  if (cs.vatAmount != null || cs.vatTreatment != null) {
    let vatLabel = isAr ? AR_LABELS.vat : "VAT";
    if (cs.vatRate != null && cs.vatTreatment !== "no_vat") {
      const inclExcl = isAr
        ? (cs.vatTreatment === "vat_inclusive" ? AR_LABELS.incl : AR_LABELS.excl)
        : (cs.vatTreatment === "vat_inclusive" ? "incl." : "excl.");
      vatLabel += ` (${cs.vatRate}% ${inclExcl})`;
    }
    if (cs.vatManualOverride && cs.vatTreatment !== "no_vat") {
      vatLabel += ` ${isAr ? AR_LABELS.manualOverride : "[manual override]"}`;
    }
    const vatValue = cs.vatTreatment === "no_vat"
      ? (isAr ? AR_LABELS.noVat : "No VAT")
      : cs.vatAmount != null ? fmtMoney(data.currency, cs.vatAmount) : "—";
    rows.push(csRow(vatLabel, escapeHtml(vatValue)));
  }
  if (hasLineItemTax) {
    rows.push(csRow(isAr ? AR_LABELS.tax : "Tax", escapeHtml(fmtMoney(data.currency, lineItemTaxTotal.toFixed(2)))));
  }

  const grandTotalValue =
    cs.grandTotalAmount != null
      ? fmtMoney(data.currency, cs.grandTotalAmount)
      : data.effectiveTotal != null
        ? fmtMoney(data.currency, data.effectiveTotal)
        : "—";

  const grandTotalLabel = isAr ? AR_LABELS.grandTotal : "Grand Total";

  const summaryStyle = isAr
    ? `margin-top: 18px; margin-right: auto; width: 55%;`
    : `margin-top: 18px; margin-left: auto; width: 55%;`;

  return `
  <div class="cost-summary" style="${summaryStyle}">
    <div class="cost-summary-title">${isAr ? AR_LABELS.costSummary : "Cost Summary"}</div>
    ${rows.join("\n    ")}
    <div class="cs-row cs-grand-total">${isAr ? `<span>${ltr(escapeHtml(grandTotalValue))}</span><span>${grandTotalLabel}</span>` : `<span>${grandTotalLabel}</span><span>${escapeHtml(grandTotalValue)}</span>`}</div>
  </div>`;
}

function buildHtml(data: PoPdfData, language: "en" | "ar" = "en"): string {
  const isAr = language === "ar";
  const statusLabel = data.status.charAt(0).toUpperCase() + data.status.slice(1).replace(/_/g, " ");

  if (isAr) {
    // ── Arabic RTL rendering ──────────────────────────────────────────────────
    const rowsHtml = data.lineItems.length
      ? data.lineItems.map((li) => buildLineItemRowHtml(li, "ar")).join("\n")
      : `<tr><td class="cell" colspan="6" style="color:#94a3b8;">${AR_LABELS.noLineItems}</td></tr>`;

    const totalTaxAmount = data.lineItems.reduce((sum, li) => {
      const t = li.taxAmount != null ? parseFloat(li.taxAmount) : 0;
      return sum + (isNaN(t) ? 0 : t);
    }, 0);
    const hasTax = data.lineItems.some((li) => li.taxAmount != null || (li.taxCategory != null && li.taxCategory !== "not_classified"));
    const netTaxGrossHtml = hasTax && data.calculatedTotal != null ? (() => {
      const grossAmt = data.calculatedTotal + totalTaxAmount;
      return `
    <tr class="totals-row"><td class="num-cell total-cell" colspan="1">${ltr(escapeHtml(fmtMoney(data.currency, data.calculatedTotal.toFixed(2))))}</td><td colspan="5" class="totals-label">${AR_LABELS.netSubtotal}</td></tr>
    <tr class="totals-row"><td class="num-cell total-cell" colspan="1">${ltr(escapeHtml(`+${fmtMoney(data.currency, totalTaxAmount.toFixed(2))}`))}</td><td colspan="5" class="totals-label">${AR_LABELS.tax}</td></tr>
    <tr class="totals-row totals-row-final"><td class="num-cell total-cell" colspan="1">${ltr(escapeHtml(fmtMoney(data.currency, grossAmt.toFixed(2))))}</td><td colspan="5" class="totals-label">${AR_LABELS.grossTotal}</td></tr>`;
    })() : `
    <tr class="totals-row totals-row-final"><td class="num-cell total-cell" colspan="1">${ltr(escapeHtml(data.totalLabel))}</td><td colspan="5" class="totals-label">${AR_LABELS.lineTotal}</td></tr>`;

    return `<!doctype html>
<html dir="rtl" lang="ar">
<head>
<meta charset="utf-8" />
<style>
  @font-face {
    font-family: 'Noto Sans';
    src: url('${fileUrl(FONT_LATIN)}') format('truetype');
    font-weight: 100 900;
    font-display: block;
  }
  @font-face {
    font-family: 'Noto Sans Arabic';
    src: url('${fileUrl(FONT_ARABIC)}') format('truetype');
    font-weight: 100 900;
    font-display: block;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'Noto Sans Arabic', 'Noto Sans', sans-serif;
    direction: rtl;
    text-align: right;
    color: #0f172a;
    font-size: 11px;
    padding: 36px 40px;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .header-bar { height: 4px; background: #4f46e5; margin-bottom: 18px; }
  .header-row { display: flex; justify-content: space-between; align-items: flex-start; }
  .brand-title { font-size: 20px; font-weight: 700; }
  .brand-subtitle { font-size: 9px; color: #64748b; margin-top: 4px; }
  .po-number { font-size: 16px; font-weight: 700; text-align: left; }
  .separator { border-top: 1px solid #e2e8f0; margin: 14px 0; }
  .details-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    row-gap: 14px;
    column-gap: 20px;
  }
  .field-label { font-size: 7.5px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; color: #94a3b8; margin-bottom: 3px; }
  .field-value { font-size: 11px; color: #0f172a; }
  .notes-block { margin-top: 14px; }
  .notes-value { font-size: 10px; color: #64748b; white-space: pre-wrap; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  thead th {
    background: #f8fafc;
    font-size: 8px;
    text-transform: uppercase;
    color: #64748b;
    font-weight: 700;
    text-align: right;
    padding: 6px 4px;
  }
  thead th.num-cell { text-align: left; }
  td.cell { padding: 6px 4px; border-bottom: 1px solid #f1f5f9; vertical-align: top; font-size: 9.5px; }
  .item-row:nth-child(even) { background: #fbfcfe; }
  .photo-cell { width: 46px; }
  .item-photo { width: 40px; height: 40px; object-fit: cover; border-radius: 4px; border: 1px solid #e2e8f0; }
  .item-photo-empty { background: #f1f5f9; }
  .desc-cell { text-align: right; }
  .desc-ar-main { font-weight: 500; }
  .tax-subline { color: #94a3b8; font-size: 8px; margin-top: 2px; }
  .num-cell { text-align: left; white-space: nowrap; }
  .total-cell { font-weight: 700; }
  .totals-row td { padding: 6px 4px; background: #f8fafc; border-bottom: none; }
  .totals-row-final td { background: #f1f5f9; font-size: 11px; }
  .totals-label { text-align: right; font-weight: 700; color: #64748b; padding-left: 10px; }
  .cost-summary-title { font-size: 9px; font-weight: 700; text-transform: uppercase; color: #64748b; margin-bottom: 8px; }
  .cs-row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 10px; color: #334155; border-bottom: 1px solid #f1f5f9; }
  .cs-grand-total { font-weight: 700; font-size: 12px; color: #0f172a; border-top: 1px solid #e2e8f0; border-bottom: none; margin-top: 4px; padding-top: 8px; }
  .footer { margin-top: 28px; border-top: 1px solid #e2e8f0; padding-top: 10px; text-align: center; font-size: 8px; color: #94a3b8; }
</style>
</head>
<body>
  <div class="header-bar"></div>
  <div class="header-row">
    <div>
      <div class="brand-title">Presentail OS</div>
      <div class="brand-subtitle">${AR_LABELS.purchaseOrder}</div>
    </div>
    <div class="po-number">${ltr(escapeHtml(data.poNumberLabel))}</div>
  </div>

  <div class="separator"></div>

  <div class="details-grid">
    <div><div class="field-label">${AR_LABELS.supplier}</div><div class="field-value">${escapeHtml(data.supplierName)}</div></div>
    <div><div class="field-label">${AR_LABELS.status}</div><div class="field-value">${escapeHtml(statusLabel)}</div></div>
    <div><div class="field-label">${AR_LABELS.totalAmount}</div><div class="field-value">${ltr(escapeHtml(data.totalLabel))}</div></div>
    <div><div class="field-label">${AR_LABELS.expectedDelivery}</div><div class="field-value">${ltr(escapeHtml(data.expectedDeliveryLabel))}</div></div>
    <div><div class="field-label">${AR_LABELS.createdDate}</div><div class="field-value">${ltr(escapeHtml(data.createdLabel))}</div></div>
    ${data.locationName ? `<div><div class="field-label">${AR_LABELS.location}</div><div class="field-value">${escapeHtml(data.locationName)}</div></div>` : "<div></div>"}
    ${data.createdByName ? `<div><div class="field-label">${AR_LABELS.createdBy}</div><div class="field-value">${escapeHtml(data.createdByName)}</div></div>` : "<div></div>"}
    ${data.paymentTerms ? `<div><div class="field-label">${AR_LABELS.paymentTerms}</div><div class="field-value">${escapeHtml(data.paymentTerms)}</div></div>` : "<div></div>"}
    ${data.supplierReference ? `<div><div class="field-label">${AR_LABELS.supplierReference}</div><div class="field-value">${ltr(escapeHtml(data.supplierReference))}</div></div>` : ""}
  </div>

  ${data.notes ? `<div class="notes-block"><div class="field-label">${AR_LABELS.notes}</div><div class="notes-value">${escapeHtml(data.notes)}</div></div>` : ""}

  <div class="separator"></div>

  <table>
    <thead>
      <tr>
        <th class="num-cell">${AR_LABELS.lineTotal}</th>
        <th class="num-cell">${AR_LABELS.unitPrice}</th>
        <th class="num-cell">${AR_LABELS.quantity}</th>
        <th class="num-cell">${AR_LABELS.supplierItemCode}</th>
        <th>${AR_LABELS.item}</th>
        <th></th>
      </tr>
    </thead>
    <tbody>
      ${rowsHtml}
      ${netTaxGrossHtml}
    </tbody>
  </table>

  ${buildCostSummaryHtml(data, "ar")}

  <div class="footer">${AR_LABELS.footer}</div>
</body>
</html>`;
  }

  // ── English LTR rendering (unchanged) ────────────────────────────────────
  const rowsHtml = data.lineItems.length
    ? data.lineItems.map((li) => buildLineItemRowHtml(li, "en")).join("\n")
    : `<tr><td class="cell" colspan="5" style="color:#94a3b8;">No line items.</td></tr>`;

  const netTaxGrossHtml = (() => {
    const totalTaxAmount = data.lineItems.reduce((sum, li) => {
      const t = li.taxAmount != null ? parseFloat(li.taxAmount) : 0;
      return sum + (isNaN(t) ? 0 : t);
    }, 0);
    const hasTax = data.lineItems.some((li) => li.taxAmount != null || (li.taxCategory != null && li.taxCategory !== "not_classified"));
    if (hasTax && data.calculatedTotal != null) {
      const grossAmt = data.calculatedTotal + totalTaxAmount;
      return `
    <tr class="totals-row"><td colspan="4" class="totals-label">Net Subtotal</td><td class="num-cell total-cell">${escapeHtml(fmtMoney(data.currency, data.calculatedTotal.toFixed(2)))}</td></tr>
    <tr class="totals-row"><td colspan="4" class="totals-label">Tax</td><td class="num-cell total-cell">+${escapeHtml(fmtMoney(data.currency, totalTaxAmount.toFixed(2)))}</td></tr>
    <tr class="totals-row totals-row-final"><td colspan="4" class="totals-label">Gross Total (incl. tax)</td><td class="num-cell total-cell">${escapeHtml(fmtMoney(data.currency, grossAmt.toFixed(2)))}</td></tr>`;
    }
    return `
    <tr class="totals-row totals-row-final"><td colspan="4" class="totals-label">Total</td><td class="num-cell total-cell">${escapeHtml(data.totalLabel)}</td></tr>`;
  })();

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  @font-face {
    font-family: 'Noto Sans';
    src: url('${fileUrl(FONT_LATIN)}') format('truetype');
    font-weight: 100 900;
    font-display: block;
  }
  @font-face {
    font-family: 'Noto Sans Arabic';
    src: url('${fileUrl(FONT_ARABIC)}') format('truetype');
    font-weight: 100 900;
    font-display: block;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'Noto Sans', 'Noto Sans Arabic', sans-serif;
    color: #0f172a;
    font-size: 11px;
    padding: 36px 40px;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .header-bar { height: 4px; background: #4f46e5; margin-bottom: 18px; }
  .header-row { display: flex; justify-content: space-between; align-items: flex-start; }
  .brand-title { font-size: 20px; font-weight: 700; }
  .brand-subtitle { font-size: 9px; color: #64748b; margin-top: 4px; }
  .po-number { font-size: 16px; font-weight: 700; text-align: right; }
  .separator { border-top: 1px solid #e2e8f0; margin: 14px 0; }
  .details-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    row-gap: 14px;
    column-gap: 20px;
  }
  .field-label { font-size: 7.5px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; color: #94a3b8; margin-bottom: 3px; }
  .field-value { font-size: 11px; color: #0f172a; }
  .notes-block { margin-top: 14px; }
  .notes-value { font-size: 10px; color: #64748b; white-space: pre-wrap; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  thead th {
    background: #f8fafc;
    font-size: 8px;
    text-transform: uppercase;
    color: #64748b;
    font-weight: 700;
    text-align: left;
    padding: 6px 4px;
  }
  thead th.num-cell { text-align: right; }
  td.cell { padding: 6px 4px; border-bottom: 1px solid #f1f5f9; vertical-align: top; font-size: 9.5px; }
  .item-row:nth-child(even) { background: #fbfcfe; }
  .photo-cell { width: 46px; }
  .item-photo { width: 40px; height: 40px; object-fit: cover; border-radius: 4px; border: 1px solid #e2e8f0; }
  .item-photo-empty { background: #f1f5f9; }
  .desc-cell { }
  .desc-en { font-weight: 500; }
  .desc-ar { direction: rtl; text-align: right; color: #334155; margin-top: 2px; font-size: 10px; }
  .tax-subline { color: #94a3b8; font-size: 8px; margin-top: 2px; }
  .num-cell { text-align: right; white-space: nowrap; }
  .total-cell { font-weight: 700; }
  .totals-row td { padding: 6px 4px; background: #f8fafc; border-bottom: none; }
  .totals-row-final td { background: #f1f5f9; font-size: 11px; }
  .totals-label { text-align: right; font-weight: 700; color: #64748b; padding-right: 10px; }
  .cost-summary { margin-top: 18px; margin-left: auto; width: 55%; }
  .cost-summary-title { font-size: 9px; font-weight: 700; text-transform: uppercase; color: #64748b; margin-bottom: 8px; }
  .cs-row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 10px; color: #334155; border-bottom: 1px solid #f1f5f9; }
  .cs-grand-total { font-weight: 700; font-size: 12px; color: #0f172a; border-top: 1px solid #e2e8f0; border-bottom: none; margin-top: 4px; padding-top: 8px; }
  .footer { margin-top: 28px; border-top: 1px solid #e2e8f0; padding-top: 10px; text-align: center; font-size: 8px; color: #94a3b8; }
</style>
</head>
<body>
  <div class="header-bar"></div>
  <div class="header-row">
    <div>
      <div class="brand-title">Presentail OS</div>
      <div class="brand-subtitle">Purchase Order</div>
    </div>
    <div class="po-number">${escapeHtml(data.poNumberLabel)}</div>
  </div>

  <div class="separator"></div>

  <div class="details-grid">
    <div><div class="field-label">Supplier</div><div class="field-value">${escapeHtml(data.supplierName)}</div></div>
    <div><div class="field-label">Status</div><div class="field-value">${escapeHtml(statusLabel)}</div></div>
    <div><div class="field-label">Total Amount</div><div class="field-value">${escapeHtml(data.totalLabel)}</div></div>
    <div><div class="field-label">Expected Delivery</div><div class="field-value">${escapeHtml(data.expectedDeliveryLabel)}</div></div>
    <div><div class="field-label">Created</div><div class="field-value">${escapeHtml(data.createdLabel)}</div></div>
    ${data.locationName ? `<div><div class="field-label">Location</div><div class="field-value">${escapeHtml(data.locationName)}</div></div>` : "<div></div>"}
    ${data.createdByName ? `<div><div class="field-label">Created By</div><div class="field-value">${escapeHtml(data.createdByName)}</div></div>` : "<div></div>"}
    ${data.paymentTerms ? `<div><div class="field-label">Payment Terms</div><div class="field-value">${escapeHtml(data.paymentTerms)}</div></div>` : "<div></div>"}
    ${data.supplierReference ? `<div><div class="field-label">Supplier Reference</div><div class="field-value">${escapeHtml(data.supplierReference)}</div></div>` : ""}
  </div>

  ${data.notes ? `<div class="notes-block"><div class="field-label">Notes</div><div class="notes-value">${escapeHtml(data.notes)}</div></div>` : ""}

  <div class="separator"></div>

  <table>
    <thead>
      <tr>
        <th></th>
        <th>Description</th>
        <th class="num-cell">Qty</th>
        <th class="num-cell">Unit Price</th>
        <th class="num-cell">Line Total</th>
      </tr>
    </thead>
    <tbody>
      ${rowsHtml}
      ${netTaxGrossHtml}
    </tbody>
  </table>

  ${buildCostSummaryHtml(data, "en")}

  <div class="footer">This purchase order was generated by Presentail OS &middot; os.presentail.com</div>
</body>
</html>`;
}

// --- Chromium lifecycle (mirrors giftCardPdf.ts) ---

function findFullChromiumInCache(cacheDir: string): string | undefined {
  let entries: string[];
  try {
    entries = fs.readdirSync(cacheDir);
  } catch {
    return undefined;
  }
  const chromiumDirs = entries.filter((e) => e.startsWith("chromium-")).sort().reverse();
  const subdirs = ["chrome-linux64", "chrome-linux"];
  for (const dir of chromiumDirs) {
    for (const sub of subdirs) {
      const candidate = path.join(cacheDir, dir, sub, "chrome");
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

export function findChromiumOnPath(): string | undefined {
  const names = ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"];
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        // Unreadable PATH entry; skip it.
      }
    }
  }
  return undefined;
}

export function resolveChromiumPath(): string | undefined {
  const envCandidates = [
    process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
  ];
  for (const c of envCandidates) {
    if (c && fs.existsSync(c)) return c;
  }
  const cacheDirs = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(process.cwd(), ".cache", "ms-playwright"),
    "/home/runner/workspace/.cache/ms-playwright",
    path.join(os.homedir(), ".cache", "ms-playwright"),
  ];
  const seen = new Set<string>();
  for (const dir of cacheDirs) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    const found = findFullChromiumInCache(dir);
    if (found) return found;
  }
  const onPath = findChromiumOnPath();
  if (onPath) return onPath;
  try {
    const p = chromium.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch {
    // playwright-core throws when no browser is registered; ignore and continue.
  }
  const systemCandidates = [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ];
  for (const c of systemCandidates) {
    if (fs.existsSync(c)) return c;
  }
  return undefined;
}

let browserPromise: Promise<Browser> | null = null;

const BROWSER_LAUNCH_TIMEOUT_MS = 15_000;
const PAGE_SET_CONTENT_TIMEOUT_MS = 30_000;
const PAGE_PDF_TIMEOUT_MS = 30_000;

async function launchBrowser(): Promise<Browser> {
  const executablePath = resolveChromiumPath();
  if (!executablePath && process.env.NODE_ENV === "production") {
    throw new Error(
      "No Chromium executable found. Production expects a full chromium-* " +
        "Playwright build installed by scripts/deploy-build-api-server.sh under " +
        `PLAYWRIGHT_BROWSERS_PATH (${process.env.PLAYWRIGHT_BROWSERS_PATH ?? "unset"}). ` +
        "Verify that the build and runtime use the same explicit cache path.",
    );
  }
  logger.info(
    { executablePath: executablePath ?? "(playwright default)" },
    "Launching Chromium for purchase order PDF rendering",
  );
  let browser: Browser;
  try {
    browser = await withTimeout(
      chromium.launch({
        executablePath,
        args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
      }),
      BROWSER_LAUNCH_TIMEOUT_MS,
      "chromium.launch",
    );
  } catch (err) {
    browserPromise = null;
    throw err;
  }
  browser.on("disconnected", () => {
    browserPromise = null;
  });
  return browser;
}

async function getBrowser(): Promise<Browser> {
  if (browserPromise) {
    const existing = await browserPromise.catch(() => null);
    if (existing && existing.isConnected()) return existing;
    browserPromise = null;
  }
  browserPromise = launchBrowser();
  return browserPromise;
}

async function renderPdf(html: string, attempt = 0): Promise<Buffer> {
  let browser: Browser;
  try {
    browser = await getBrowser();
  } catch (err) {
    browserPromise = null;
    throw err;
  }

  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await withTimeout(
      page.setContent(html, { waitUntil: "load" }),
      PAGE_SET_CONTENT_TIMEOUT_MS,
      "page.setContent",
    );
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const pdf = await withTimeout(
      page.pdf({
        format: "A4",
        printBackground: true,
        margin: { top: "0", bottom: "0", left: "0", right: "0" },
      }),
      PAGE_PDF_TIMEOUT_MS,
      "page.pdf",
    );
    return pdf;
  } catch (err) {
    if (attempt === 0) {
      browserPromise = null;
      await context.close().catch(() => {});
      return renderPdf(html, attempt + 1);
    }
    throw err;
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * Build the purchase order PDF as a Buffer. Item photos (when present) are
 * pre-resolved to base64 data URLs by the caller via `resolvePoPdfLineItemImages`
 * before calling this function, so `PoPdfData.lineItems[].imageUrl` must
 * already be a data URL (or null) — never a live network/auth-gated path.
 *
 * @param language - 'en' (default) for English LTR; 'ar' for Arabic RTL.
 */
export async function buildPurchaseOrderPdf(data: PoPdfData, language: "en" | "ar" = "en"): Promise<Buffer> {
  const html = buildHtml(data, language);
  return renderPdf(html);
}

/** Resolve raw base_items.image_url values to embeddable base64 data URLs. */
export async function resolvePoPdfLineItemImages(
  lineItems: Array<{ imageUrl: string | null }>,
): Promise<(string | null)[]> {
  return Promise.all(
    lineItems.map((li) => (li.imageUrl ? fetchImageAsDataUrl(li.imageUrl) : Promise.resolve(null))),
  );
}

/** Close the shared browser (best-effort) — useful for tests and shutdown. */
export async function closePoPdfBrowser(): Promise<void> {
  const current = browserPromise;
  browserPromise = null;
  if (!current) return;
  try {
    const browser = await current;
    await browser.close();
  } catch {
    // ignore
  }
}

/**
 * Exported for unit testing only. Build the HTML string for a PO PDF without
 * rendering it through Chromium.
 */
export { buildHtml as buildPoPdfHtml };
