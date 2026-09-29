import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";

export interface InvoiceLineItem {
  name: string;
  quantity: string | number;
  unitPrice: string | number | null;
  amount: string | number | null;
}

export interface OrderInvoiceData {
  invoiceNumber: string;
  currency: string;
  /** Date the invoice is generated (today, at click time). */
  dateOfIssue: string | Date;
  /** Date the invoice is due — the order's creation date. */
  dateDue: string | Date | null;
  billToName: string | null;
  billToCountry: string | null;
  billToEmail: string | null;
  items: InvoiceLineItem[];
  subtotal: string | number;
  /** A positive value rendered as a separate negative discount line. */
  discountAmount?: number | null;
  /** Optional meaningful discount reason, e.g. "Discount — Service recovery". */
  discountLabel?: string | null;
  total: string | number;
  amountDue: string | number;
  /**
   * Sender block lines (company name first, then address/email lines). When
   * omitted, the default Presentail SAL sender is used.
   */
  senderLines?: string[];
  /**
   * Included VAT percentage (e.g. 11 for 11%). Rendered only when
   * `vatAmount` is also provided.
   */
  vatRate?: number;
  /**
   * Included VAT amount broken out of the total. When present (> 0), a
   * "VAT (<rate>%)" row is rendered between Subtotal and Total, and the
   * Subtotal row shows the VAT-exclusive amount (total − VAT) so that
   * Subtotal + VAT = Total. The total itself is unchanged.
   */
  vatAmount?: number | null;
  /**
   * LBP exchange rate: how many LBP equal 1 unit of `currency`. When set,
   * a parallel "Amount (LBP)" column is rendered beside the primary amount
   * column on the items table and totals block. When null/undefined the LBP
   * column is omitted. Only populated by the ad-hoc invoice flow.
   */
  lbpRate?: number | null;
  /**
   * Pre-computed LBP equivalent of the VAT amount. Rendered in the LBP
   * column of the VAT totals row. Only populated by the ad-hoc invoice flow.
   */
  vatLbpAmount?: number | null;
  /**
   * Amount due spelled out in English words, e.g.
   * "One Thousand Two Hundred and 50/100 USD". Rendered as a small italic
   * line below the Amount due row. Only populated by the ad-hoc invoice flow.
   */
  amountDueWords?: string | null;
}

/** MOF (Ministry of Finance) registration number for Presentail SAL. */
export const SAL_MOF_NUMBER = "3616289-601";

/** Default invoice sender — used for cash/COD/Whish/unknown payment methods. */
export const SAL_SENDER_LINES = [
  "Presentail SAL",
  `MOF: ${SAL_MOF_NUMBER}`,
  "3rd Floor, Karam w Mwannes, Abdel Wahab El Inglizi St, Achrafieh, Beirut, Lebanon",
  "+961 3 136 532",
  "hello@presentail.com",
];

/** Sender for orders paid via Stripe or PayPal — Presentail LTD (Cyprus). */
export const LTD_SENDER_LINES = [
  "Presentail LTD",
  "Agapinoros & Arch. Makariou III, 2",
  "IRIS TOWER, 4th Floor, Flat.Office 1076",
  "Nicosia, Cyprus",
  "hello@presentail.com",
];

/**
 * Pick the invoice sender based on the order's recorded payment. Orders paid
 * via Stripe or PayPal (matched case-insensitively on either the payment
 * method or provider) are issued from Presentail LTD with the Cyprus address;
 * everything else (cash, COD, no payment recorded) keeps Presentail SAL.
 */
export function resolveInvoiceSenderLines(
  method: string | null | undefined,
  provider: string | null | undefined,
): string[] {
  const values = [method, provider].map((v) =>
    typeof v === "string" ? v.trim().toLowerCase() : "",
  );
  const isLtd = values.some((v) => v === "stripe" || v === "paypal");
  return isLtd ? LTD_SENDER_LINES : SAL_SENDER_LINES;
}

/**
 * Whether the order's recorded payment is Whish (matched case-insensitively
 * on either the payment method or provider, exact value only — same style as
 * the Stripe/PayPal sender check). Whish-paid orders show an included 11% VAT
 * line on the invoice.
 */
export function isWhishPayment(
  method: string | null | undefined,
  provider: string | null | undefined,
): boolean {
  return [method, provider].some(
    (v) => typeof v === "string" && v.trim().toLowerCase() === "whish",
  );
}

/** VAT rate (percent) applied to Whish-paid order invoices. */
export const WHISH_VAT_RATE = 11;

/**
 * Compute the included VAT portion of a VAT-inclusive total, rounded to two
 * decimals: VAT = total − total / (1 + rate/100).
 */
export function includedVatAmount(total: number, ratePercent: number): number {
  if (!Number.isFinite(total) || total <= 0 || ratePercent <= 0) return 0;
  const vat = total - total / (1 + ratePercent / 100);
  return Math.round(vat * 100) / 100;
}

const ONES = [
  "",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
  "Eleven",
  "Twelve",
  "Thirteen",
  "Fourteen",
  "Fifteen",
  "Sixteen",
  "Seventeen",
  "Eighteen",
  "Nineteen",
];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function threeDigitWords(n: number): string {
  if (n === 0) return "";
  const hundreds = Math.floor(n / 100);
  const remainder = n % 100;
  const parts: string[] = [];
  if (hundreds > 0) parts.push(`${ONES[hundreds]} Hundred`);
  if (remainder > 0) {
    if (remainder < 20) {
      parts.push(ONES[remainder]);
    } else {
      const t = Math.floor(remainder / 10);
      const o = remainder % 10;
      parts.push(o > 0 ? `${TENS[t]}-${ONES[o]}` : TENS[t]);
    }
  }
  return parts.join(" ");
}

/**
 * Convert a non-negative number to English words suitable for invoice use.
 * Integer part is written out in words; fractional cents are appended as
 * "and XX/100 <CURRENCY>". Handles amounts up to 999,999,999.
 * Example: numberToWords(1200.50, "USD") → "One Thousand Two Hundred and 50/100 USD"
 */
export function numberToWords(amount: number, currency: string): string {
  if (!Number.isFinite(amount) || amount < 0) return "";
  const rounded = Math.round(amount * 100) / 100;
  const intPart = Math.floor(rounded);
  const cents = Math.round((rounded - intPart) * 100);

  const GROUPS = ["", " Thousand", " Million", " Billion"];
  let remaining = intPart;
  const groupParts: string[] = [];
  for (let i = 0; remaining > 0; i++) {
    const chunk = remaining % 1000;
    if (chunk !== 0) {
      const words = threeDigitWords(chunk);
      groupParts.unshift(`${words}${GROUPS[i]}`);
    }
    remaining = Math.floor(remaining / 1000);
  }

  const intWords = intPart === 0 ? "Zero" : groupParts.join(" ");
  const centsStr = String(cents).padStart(2, "0");
  return `${intWords} and ${centsStr}/100 ${(currency || "USD").toUpperCase()}`;
}

/**
 * Resolve the bundled Presentail logo. At runtime the server executes from the
 * esbuild bundle in `dist/` where `build.mjs` mirrors `assets/` to `dist/assets`;
 * in tests/tsx the module runs from `src/lib`, so the source asset dir applies.
 */
function findLogoPath(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "assets", "presentail-logo.png"), // dist/assets (bundled)
    path.resolve(here, "../assets/presentail-logo.png"), // dist/../assets
    path.resolve(here, "../../assets/presentail-logo.png"), // src/lib -> artifacts/api-server/assets
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

const LOGO_PATH = findLogoPath();

function n(v: string | number | null | undefined): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string" && v.trim() !== "") {
    const x = Number(v);
    return Number.isFinite(x) ? x : 0;
  }
  return 0;
}

/**
 * Format an amount using the order's currency symbol, e.g. `$30.00`. Falls back
 * to `<CODE> 30.00` when the currency code is not recognized by Intl.
 */
function money(v: string | number | null | undefined, currency: string): string {
  const num = n(v);
  const code = (currency || "USD").toUpperCase();
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: code,
      currencyDisplay: "narrowSymbol",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(num);
  } catch {
    return `${code} ${num.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }
}

/** Format an amount followed by its currency code, e.g. `$30.00 USD`. */
function moneyWithCode(v: string | number | null | undefined, currency: string): string {
  return `${money(v, currency)} ${(currency || "USD").toUpperCase()}`;
}

/** Format an LBP amount as "LBP X,XXX" (no decimals). */
function lbpLabel(lbpAmount: number): string {
  return `LBP ${Math.round(lbpAmount).toLocaleString("en-US")}`;
}

function dateLabel(v: string | Date | null | undefined): string {
  if (!v) return "—";
  const d = typeof v === "string" ? new Date(v) : v;
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

function qtyLabel(v: string | number): string {
  const num = n(v);
  if (Number.isInteger(num)) return String(num);
  return num.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

/**
 * Build a branded order-invoice PDF matching the Presentail invoice layout and
 * resolve with the rendered Buffer.
 */
export function buildOrderInvoicePdf(data: OrderInvoiceData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 50, size: "A4", bufferPages: true });
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const GRAY = "#64748b";
      const LIGHT_GRAY = "#94a3b8";
      const BLACK = "#0f172a";
      const LEFT = 50;
      const pageWidth = doc.page.width - 100;
      const RIGHT = LEFT + pageWidth;
      const currency = data.currency || "USD";

      const lbpRate =
        typeof data.lbpRate === "number" && Number.isFinite(data.lbpRate) && data.lbpRate > 0
          ? data.lbpRate
          : null;

      // Logo (top-right), title (top-left).
      if (LOGO_PATH) {
        try {
          const logoSize = 56;
          doc.image(LOGO_PATH, RIGHT - logoSize, 50, {
            width: logoSize,
            height: logoSize,
          });
        } catch {
          // Non-fatal: render without the logo.
        }
      }

      doc.fontSize(26).fillColor(BLACK).font("Helvetica-Bold").text("Invoice", LEFT, 54);

      // Invoice meta (number / issue / due).
      let y = 96;
      function metaRow(label: string, value: string) {
        doc.fontSize(9).fillColor(GRAY).font("Helvetica-Bold").text(label, LEFT, y, {
          width: 110,
        });
        doc.fontSize(9).fillColor(BLACK).font("Helvetica").text(value, LEFT + 115, y, {
          width: pageWidth - 115,
        });
        y += 15;
      }
      metaRow("Invoice number", data.invoiceNumber);
      metaRow("Date of issue", dateLabel(data.dateOfIssue));
      metaRow("Date due", dateLabel(data.dateDue));

      y += 18;
      doc.moveTo(LEFT, y).lineTo(RIGHT, y).strokeColor("#e2e8f0").stroke();
      y += 16;

      // Sender (left) / Bill to (right).
      const col2X = LEFT + pageWidth / 2;
      const senderLines =
        data.senderLines && data.senderLines.length > 0 ? data.senderLines : SAL_SENDER_LINES;
      const billToLines = [
        data.billToName,
        data.billToCountry,
        data.billToEmail,
      ].filter((v): v is string => typeof v === "string" && v.trim() !== "");

      // Render each sender line, measuring wrapped height so long address
      // lines stay inside the left column and never overlap "Bill to".
      const senderWidth = pageWidth / 2 - 10;
      let leftY = y;
      senderLines.forEach((line, idx) => {
        doc
          .fontSize(idx === 0 ? 11 : 9)
          .fillColor(idx === 0 ? BLACK : GRAY)
          .font(idx === 0 ? "Helvetica-Bold" : "Helvetica");
        doc.text(line, LEFT, leftY, { width: senderWidth });
        leftY += doc.heightOfString(line, { width: senderWidth }) + (idx === 0 ? 4 : 2);
      });

      let rightY = y;
      doc.fontSize(8).fillColor(LIGHT_GRAY).font("Helvetica-Bold").text("BILL TO", col2X, rightY);
      rightY += 13;
      if (billToLines.length === 0) {
        doc.fontSize(9).fillColor(LIGHT_GRAY).font("Helvetica").text("—", col2X, rightY);
        rightY += 14;
      } else {
        billToLines.forEach((line, idx) => {
          doc
            .fontSize(idx === 0 ? 11 : 9)
            .fillColor(idx === 0 ? BLACK : GRAY)
            .font(idx === 0 ? "Helvetica-Bold" : "Helvetica")
            .text(line, col2X, rightY, { width: pageWidth / 2 });
          rightY += idx === 0 ? 16 : 14;
        });
      }

      y = Math.max(leftY + 4, rightY) + 20;

      // Summary line: "$X.XX <CURRENCY> due <date due>".
      const dueSuffix = data.dateDue ? ` due ${dateLabel(data.dateDue)}` : "";
      doc
        .fontSize(15)
        .fillColor(BLACK)
        .font("Helvetica-Bold")
        .text(`${moneyWithCode(data.amountDue, currency)}${dueSuffix}`, LEFT, y, {
          width: pageWidth,
        });
      y += 30;

      // Items table — column layout depends on whether LBP column is active.
      // With LBP: shrink desc + qty + price slightly to fit the extra column.
      const descW = lbpRate ? pageWidth * 0.38 : pageWidth * 0.5;
      const qtyW = lbpRate ? pageWidth * 0.1 : pageWidth * 0.13;
      const priceW = lbpRate ? pageWidth * 0.15 : pageWidth * 0.18;
      const amountW = lbpRate ? pageWidth * 0.15 : pageWidth * 0.19;
      const lbpW = lbpRate ? pageWidth * 0.22 : 0;

      const colDesc = LEFT;
      const colQty = colDesc + descW;
      const colPrice = colQty + qtyW;
      const colAmount = colPrice + priceW;
      const colLbp = colAmount + amountW;

      doc.fontSize(8).fillColor(GRAY).font("Helvetica-Bold");
      doc.text("Description", colDesc, y, { width: descW });
      doc.text("Qty", colQty, y, { width: qtyW, align: "right" });
      doc.text("Unit price", colPrice, y, { width: priceW, align: "right" });
      doc.text("Amount", colAmount, y, { width: amountW, align: "right" });
      if (lbpRate) {
        doc.text("Amount (LBP)", colLbp, y, { width: lbpW, align: "right" });
      }
      y += 14;
      doc.moveTo(LEFT, y).lineTo(RIGHT, y).strokeColor("#e2e8f0").stroke();
      y += 8;

      if (data.items.length === 0) {
        doc.fontSize(10).fillColor(LIGHT_GRAY).font("Helvetica").text("No items.", colDesc, y);
        y += 18;
      }

      for (const it of data.items) {
        const unitPriceNum = n(it.unitPrice);
        const lbpUnitPrice = lbpRate ? Math.round(unitPriceNum * lbpRate) : null;
        const amountNum = n(it.amount);
        const lbpAmount = lbpRate ? Math.round(amountNum * lbpRate) : null;

        // Row height: account for potential sub-line showing LBP unit price.
        const nameH = doc.heightOfString(it.name, { width: descW - 8 });
        const rowH = lbpRate
          ? Math.max(28, nameH + 8 + 10)
          : Math.max(16, nameH + 8);

        if (y + rowH > doc.page.height - 90) {
          doc.addPage();
          y = 50;
        }
        doc.fontSize(9).fillColor(BLACK).font("Helvetica");
        doc.text(it.name, colDesc, y, { width: descW - 8 });
        doc.text(qtyLabel(it.quantity), colQty, y, { width: qtyW, align: "right" });

        // Unit price: primary value, then LBP sub-line below.
        doc.text(money(it.unitPrice, currency), colPrice, y, { width: priceW, align: "right" });
        if (lbpRate && lbpUnitPrice !== null) {
          doc
            .fontSize(7)
            .fillColor(LIGHT_GRAY)
            .font("Helvetica")
            .text(`/ ${lbpLabel(lbpUnitPrice)}`, colPrice, y + 11, { width: priceW, align: "right" });
          doc.fontSize(9).fillColor(BLACK).font("Helvetica");
        }

        doc.text(money(it.amount, currency), colAmount, y, { width: amountW, align: "right" });
        if (lbpRate && lbpAmount !== null) {
          doc.text(lbpLabel(lbpAmount), colLbp, y, { width: lbpW, align: "right" });
        }

        y += rowH;
        doc.moveTo(LEFT, y).lineTo(RIGHT, y).strokeColor("#f1f5f9").stroke();
        y += 6;
      }

      y += 8;

      // Totals (right-aligned block).
      // totalsLabelX is the start of the label column; value goes at colAmount.
      // When LBP column is active, the LBP value is rendered at colLbp.
      const totalsLabelX = lbpRate
        ? colPrice - pageWidth * 0.02
        : colPrice - pageWidth * 0.05;
      const totalsLabelW = priceW;

      function totalRow(
        label: string,
        value: string,
        bold = false,
        lbpValue?: string | null,
      ) {
        doc
          .fontSize(bold ? 10 : 9)
          .fillColor(bold ? BLACK : GRAY)
          .font(bold ? "Helvetica-Bold" : "Helvetica")
          .text(label, totalsLabelX, y, { width: totalsLabelW, align: "right" });
        doc
          .fontSize(bold ? 10 : 9)
          .fillColor(BLACK)
          .font(bold ? "Helvetica-Bold" : "Helvetica")
          .text(value, colAmount, y, { width: amountW, align: "right" });
        if (lbpRate && lbpValue) {
          doc
            .fontSize(bold ? 9 : 8)
            .fillColor(GRAY)
            .font("Helvetica")
            .text(`≈ ${lbpValue}`, colLbp, y, { width: lbpW, align: "right" });
        }
        y += bold ? 18 : 15;
      }

      const vatAmount =
        typeof data.vatAmount === "number" && data.vatAmount > 0 ? data.vatAmount : null;
      const vatLbpAmount =
        typeof data.vatLbpAmount === "number" && data.vatLbpAmount > 0
          ? data.vatLbpAmount
          : null;
      const discountAmount =
        typeof data.discountAmount === "number" && data.discountAmount > 0
          ? data.discountAmount
          : null;

      if (discountAmount != null) {
        const lbpDiscount = lbpRate ? Math.round(discountAmount * lbpRate) : null;
        totalRow(data.discountLabel || "Discount", `−${money(discountAmount, currency)}`, false,
          lbpDiscount != null ? `−${lbpLabel(lbpDiscount)}` : null);
      }
      if (vatAmount != null) {
        const vatExclusive = Math.round((n(data.total) - vatAmount) * 100) / 100;
        const lbpSubtotal = lbpRate ? Math.round(vatExclusive * lbpRate) : null;
        const rateLabel =
          typeof data.vatRate === "number" && Number.isFinite(data.vatRate)
            ? `VAT (${data.vatRate}%)`
            : "VAT";
        totalRow(
          "Subtotal",
          money(vatExclusive, currency),
          false,
          lbpSubtotal != null ? lbpLabel(lbpSubtotal) : null,
        );
        totalRow(
          rateLabel,
          money(vatAmount, currency),
          false,
          vatLbpAmount != null ? lbpLabel(vatLbpAmount) : null,
        );
      } else {
        const lbpSubtotal = lbpRate ? Math.round(n(data.subtotal) * lbpRate) : null;
        totalRow(
          "Subtotal",
          money(data.subtotal, currency),
          false,
          lbpSubtotal != null ? lbpLabel(lbpSubtotal) : null,
        );
      }

      const lbpTotal = lbpRate ? Math.round(n(data.total) * lbpRate) : null;
      totalRow(
        "Total",
        money(data.total, currency),
        false,
        lbpTotal != null ? lbpLabel(lbpTotal) : null,
      );
      doc.moveTo(totalsLabelX, y - 2).lineTo(RIGHT, y - 2).strokeColor("#e2e8f0").stroke();
      y += 4;

      const lbpAmountDue = lbpRate ? Math.round(n(data.amountDue) * lbpRate) : null;
      totalRow(
        "Amount due",
        moneyWithCode(data.amountDue, currency),
        true,
        lbpAmountDue != null ? lbpLabel(lbpAmountDue) : null,
      );

      // Amount in words line (italic, gray, right-aligned).
      if (data.amountDueWords) {
        doc
          .fontSize(8)
          .fillColor(LIGHT_GRAY)
          .font("Helvetica-Oblique")
          .text(data.amountDueWords, totalsLabelX, y, {
            width: RIGHT - totalsLabelX,
            align: "right",
          });
        y += 14;
      }

      // Footer: page numbers ("Page X of Y").
      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        // Zero the bottom margin so writing near the page bottom does not
        // trigger pdfkit to auto-add a blank page.
        const prevBottom = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;
        doc
          .fontSize(8)
          .fillColor(LIGHT_GRAY)
          .font("Helvetica")
          .text(
            `Page ${i - range.start + 1} of ${range.count}`,
            LEFT,
            doc.page.height - 50,
            { align: "right", width: pageWidth, lineBreak: false },
          );
        doc.page.margins.bottom = prevBottom;
      }

      doc.end();
    } catch (err) {
      reject(err as Error);
    }
  });
}
