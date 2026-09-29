import { randomBytes } from "node:crypto";
import {
  buildOrderInvoicePdf,
  includedVatAmount,
  numberToWords,
  SAL_SENDER_LINES,
  WHISH_VAT_RATE,
  type InvoiceLineItem,
  type OrderInvoiceData,
} from "./orderInvoicePdf";

/**
 * Input for a standalone (ad-hoc) invoice generated from the Generate Invoice
 * dashboard page. Every field is optional — blank fields simply render empty
 * on the PDF. The issuer is always Presentail SAL.
 */
export interface AdhocInvoiceInput {
  name?: string | null;
  email?: string | null;
  address?: string | null;
  item?: string | null;
  amount?: number | null;
  currency?: string | null;
}

/** Fixed LBP per 1 USD anchor rate used for parallel LBP column. */
const USD_TO_LBP = 89_500;

/**
 * Multipliers to convert 1 unit of a given currency into USD before applying
 * USD_TO_LBP. Only currencies supported by the Generate Invoice page are listed.
 */
const CURRENCY_TO_USD: Record<string, number> = {
  USD: 1,
  AED: 0.2723,
  EUR: 1.08,
  GBP: 1.27,
  SAR: 0.2667,
};

/**
 * Convert an amount in the invoice currency to LBP using the fixed rate.
 * Returns an integer (LBP has no decimals).
 */
function toLbp(amount: number, lbpRate: number): number {
  return Math.round(amount * lbpRate);
}

function cleanText(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Generate a human-friendly invoice number for an ad-hoc invoice, e.g.
 * "INV-20260703-4F2A91BC". The cryptographically random 32-bit suffix keeps
 * persisted invoice numbers collision-resistant without relying on Math.random.
 */
export function generateAdhocInvoiceNumber(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const rand = randomBytes(4).toString("hex").toUpperCase();
  return `INV-${y}${m}${d}-${rand}`;
}

/**
 * Map the optional ad-hoc form fields onto the shared order-invoice renderer's
 * data shape. The sender is always Presentail SAL (MOF 3616289-601) — never
 * Presentail LTD — regardless of any other input.
 */
export function buildAdhocInvoiceData(input: AdhocInvoiceInput): OrderInvoiceData {
  const name = cleanText(input.name);
  const email = cleanText(input.email);
  const address = cleanText(input.address);
  const item = cleanText(input.item);

  const amount =
    typeof input.amount === "number" && Number.isFinite(input.amount) && input.amount >= 0
      ? input.amount
      : null;

  const currencyRaw = cleanText(input.currency);
  const currency = currencyRaw ? currencyRaw.toUpperCase() : "USD";

  const items: InvoiceLineItem[] =
    item !== null || amount !== null
      ? [
          {
            name: item ?? "",
            quantity: 1,
            unitPrice: amount,
            amount,
          },
        ]
      : [];

  const total = amount ?? 0;

  // The entered amount is VAT-inclusive: break out the included 11% VAT so the
  // PDF shows Subtotal / VAT (11%) / Total. When the amount is blank/zero the
  // helper returns 0 and no VAT line is forced.
  const vatAmount = includedVatAmount(total, WHISH_VAT_RATE);
  const subtotal = Math.round((total - vatAmount) * 100) / 100;

  // LBP parallel column: supported for all currencies except LBP itself.
  const usdMultiplier = CURRENCY_TO_USD[currency] ?? null;
  const lbpRate = currency === "LBP" || usdMultiplier === null
    ? null
    : usdMultiplier * USD_TO_LBP;

  const vatLbpAmount =
    lbpRate !== null && vatAmount > 0 ? toLbp(vatAmount, lbpRate) : null;

  // Amount in words — uses the full amount due (= total).
  const amountDueWords =
    total > 0 ? numberToWords(total, currency) : null;

  return {
    invoiceNumber: generateAdhocInvoiceNumber(),
    currency,
    dateOfIssue: new Date(),
    dateDue: new Date(),
    billToName: name,
    billToCountry: address,
    billToEmail: email,
    items,
    subtotal,
    total,
    amountDue: total,
    vatRate: WHISH_VAT_RATE,
    vatAmount: vatAmount > 0 ? vatAmount : null,
    senderLines: SAL_SENDER_LINES,
    lbpRate,
    vatLbpAmount,
    amountDueWords,
  };
}

/** Render an ad-hoc invoice PDF. Always issued by Presentail SAL. */
export function buildAdhocInvoicePdf(input: AdhocInvoiceInput): Promise<Buffer> {
  return buildOrderInvoicePdf(buildAdhocInvoiceData(input));
}
