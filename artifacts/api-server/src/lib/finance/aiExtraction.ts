import { z } from "zod";
import type { ExtractedInvoiceData, InvoiceLineItem } from "./accountingConnector.js";
import { logger } from "../logger.js";
import { aiUsageAttribution, type AiUsageAttribution } from "../aiUsageRecorder.js";
import { callAI } from "../ai/callAI.js";

const lineItemSchema = z.object({
  description: z.string().nullable().default(""),
  quantity: z.coerce.number().nullable().default(1),
  unit_price: z.coerce.number().nullable().default(0),
  total: z.coerce.number().nullable().default(0),
  tax_rate: z.coerce.number().nullable().optional().catch(null),
  account_code: z.string().nullable().optional().catch(null),
  product_code: z.string().nullable().optional().catch(null),
  evidence: z.object({
    confidence: z.coerce.number().min(0).max(1).nullable().optional(),
    region: z.object({ page: z.coerce.number().int().positive(), x: z.coerce.number().min(0), y: z.coerce.number().min(0), width: z.coerce.number().positive(), height: z.coerce.number().positive() }).nullable().optional(),
  }).nullable().optional().catch(null),
});

const extractionSchema = z.object({
  vendor_name: z.string().nullable().default(null),
  vendor_tax_number: z.string().nullable().default(null),
  vendor_address: z.string().nullable().default(null),
  invoice_number: z.string().nullable().default(null),
  invoice_date: z.string().nullable().default(null),
  due_date: z.string().nullable().default(null),
  currency: z.string().default("USD"),
  subtotal: z.coerce.number().nullable().default(null),
  discount: z.coerce.number().nullable().default(null),
  tax_amount: z.coerce.number().nullable().default(null),
  total_amount: z.coerce.number().nullable().default(null),
  total_label: z.string().nullable().optional().catch(null),
  page_role: z.enum(["first", "continuation", "final", "single"]).nullable().optional().catch(null),
  line_items: z.array(lineItemSchema).default([]),
  billing_country: z.string().nullable().catch(null).default(null),
  confidence: z.coerce
    .number()
    .transform((v) => {
      // Normalize percentage form (e.g. 95 → 0.95), then clamp to [0, 1]
      const normalized = v > 1 ? v / 100 : v;
      return Math.min(1, Math.max(0, normalized));
    })
    .catch(0.5)
    .default(0.5),
  extraction_evidence: z.object({
    fields: z.record(z.string(), z.object({
      confidence: z.coerce.number().min(0).max(1).nullable().optional(),
      region: z.object({ page: z.coerce.number().int().positive(), x: z.coerce.number().min(0), y: z.coerce.number().min(0), width: z.coerce.number().positive(), height: z.coerce.number().positive() }).nullable().optional(),
    })).default({}),
  }).optional().catch(undefined),
});

const EXTRACTION_PROMPT = `You are an expert accounting assistant. Extract all invoice data from this document.

IMPORTANT READING RULES — follow these before writing any field:
1. Scan ALL pages of the document before responding. Do not stop at the first page.
2. On printed invoices, prefer printed or typeset values over handwritten corrections or annotations. Fully handwritten invoices are valid source documents — read the handwriting carefully and extract every legible field.
3. Emit null (never 0) when a field is genuinely absent from the invoice.
4. For each line item, total must equal quantity × unit_price (recalculate if the printed total differs).
4a. When coordinates can be reliably determined, return normalized evidence: page (one based) and region x/y/width/height in 0–1 coordinates plus confidence for every field and line. Omit evidence rather than guessing.
5. All dates must be in ISO format YYYY-MM-DD; convert any other format (DD/MM/YYYY, Month D YYYY, etc.).
6. For split-page imports, identify the printed label attached to the amount used for total_amount (for example TOTAL, GRAND TOTAL, or AMOUNT DUE) as total_label, and identify whether this page is first, continuation, final, or single as page_role. Use null when not visible.
7. Confidence must be ≥0.90 for clean, machine-printed invoices with all key fields clearly visible.

LANGUAGE & SCRIPT RULES — invoices may be in any language, including Arabic:
- Read Arabic (and other right-to-left) text carefully; handwritten Arabic invoices are common and must be extracted, not rejected.
- Convert Arabic-Indic numerals (٠١٢٣٤٥٦٧٨٩) and Eastern Arabic-Indic numerals (۰۱۲۳۴۵۶۷۸۹) to Western digits in ALL numeric fields (amounts, quantities, dates, invoice numbers).
- Keep vendor_name, vendor_address, and line item descriptions in their original script exactly as written (do NOT transliterate or translate).
- Map Arabic currency indicators to ISO codes: د.إ / درهم → AED, ل.ل / ليرة → LBP, ر.س / ريال سعودي → SAR, ج.م / جنيه → EGP, د.ك → KWD, ر.ق → QAR, دولار / $ → USD.
- Arabic date formats (e.g. ١٥/٨/٢٠٢٦ meaning DD/MM/YYYY) must still be converted to ISO YYYY-MM-DD.

BILLING COUNTRY DETECTION — for the billing_country field:
- Identify the country where this invoice transaction takes place (i.e. where the vendor/supplier is located and from which the invoice is issued).
- Use ALL available signals in priority order:
  a. Explicit country name in the vendor address (highest confidence)
  b. Tax/VAT number format: TRN → AE, TVA/BTW → BE/FR/NL, MwSt → DE/AT/CH, IVA → IT/ES, CNPJ/CPF → BR, GST → AU/CA/IN/NZ, GSTIN → IN, RFC → MX, etc.
  c. Currency: AED → AE, LBP → LB, SAR → SA, QAR → QA, KWD → KW, BHD → BH, OMR → OM, EGP → EG, GBP → GB, CHF → CH
  d. Phone number country code (+961 → LB, +971 → AE, +966 → SA, etc.)
  e. Language and formatting conventions
- Emit a 2-letter ISO 3166-1 alpha-2 country code (e.g. "AE", "LB", "US", "FR") or null if country cannot be determined.

Return ONLY a valid JSON object with exactly these fields (no extra text, no markdown):
{
  "vendor_name": "Full legal name of the vendor/supplier",
  "vendor_tax_number": "VAT/TRN/tax registration number of vendor, or null if not present",
  "vendor_address": "Full vendor address, or null if not present",
  "invoice_number": "Invoice reference number, or null if not present",
  "invoice_date": "Issue date in ISO format YYYY-MM-DD, or null if not present",
  "due_date": "Payment due date in ISO format YYYY-MM-DD, or null if not present",
  "currency": "3-letter ISO currency code (e.g. USD, AED, EUR, GBP)",
  "subtotal": 1234.56,
  "discount": null,
  "tax_amount": 61.73,
  "total_amount": 1296.29,
  "total_label": "GRAND TOTAL",
  "page_role": "final",
  "billing_country": "AE",
  "line_items": [
    {
      "description": "Line item description",
      "quantity": 1,
      "unit_price": 0.00,
      "total": 0.00,
      "tax_rate": 0.05,
      "account_code": "account code if shown, or null",
      "product_code": "product/SKU code if shown, or null"
    }
  ],
  "confidence": 0.95
   ,"extraction_evidence":{"fields":{"invoice_number":{"confidence":0.95,"region":{"page":1,"x":0.1,"y":0.1,"width":0.2,"height":0.03}}}}
}

Confidence score (0.0–1.0) guidance:
- 0.90–1.0: clean machine-printed invoice, all key fields clearly visible
- 0.60–0.89: legible handwritten invoice, or partially readable with some fields missing or ambiguous
- 0.00–0.59: illegible, very poor quality, or very incomplete

Return ONLY the JSON object, no explanation, no markdown.`;

/**
 * Extract plain text from a PDF buffer using pdfjs-dist.
 * Bounded by MAX_TEXT_PAGES and MAX_TEXT_CHARS to prevent resource exhaustion
 * from large or highly-paginated untrusted PDFs.
 * Returns an empty string on any error so callers can test text.length.
 */
type PdfDocLike = { numPages: number; getPage(n: number): Promise<unknown> };
type LoadingTaskLike = { promise: Promise<PdfDocLike>; destroy(): Promise<void> };

async function extractTextFromPdf(buffer: Buffer): Promise<string> {
  let loadingTask: LoadingTaskLike | null = null;
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    loadingTask = pdfjs.getDocument({ data: new Uint8Array(buffer) }) as unknown as LoadingTaskLike;
    const pdfDoc = await loadingTask.promise;
    const numPages = pdfDoc.numPages;
    const pagesToRead = Math.min(numPages, MAX_TEXT_PAGES);

    if (numPages > MAX_TEXT_PAGES) {
      logger.warn({ numPages, limit: MAX_TEXT_PAGES }, "aiExtraction: PDF has many pages; capping text extraction");
    }

    const pageTexts: string[] = [];
    let totalChars = 0;

    for (let i = 1; i <= pagesToRead; i++) {
      const page = await pdfDoc.getPage(i);
      const textContent = await (page as { getTextContent(): Promise<{ items: Array<{ str?: string }> }> }).getTextContent();
      const pageText = textContent.items
        .map((item) => item.str ?? "")
        .join(" ")
        .trim();

      if (pageText) {
        const remaining = MAX_TEXT_CHARS - totalChars;
        if (remaining <= 0) break;
        const chunk = pageText.slice(0, remaining);
        pageTexts.push(chunk);
        totalChars += chunk.length;
        if (totalChars >= MAX_TEXT_CHARS) {
          logger.warn({ totalChars, limit: MAX_TEXT_CHARS, page: i }, "aiExtraction: text char limit reached, stopping early");
          break;
        }
      }
    }

    return pageTexts.join("\n\n--- Page Break ---\n\n");
  } catch (err) {
    logger.warn({ err }, "aiExtraction: PDF text extraction failed");
    return "";
  } finally {
    // Use loadingTask.destroy() — pdfjs 6 removed pdfDoc.destroy().
    if (loadingTask) {
      await loadingTask.destroy().catch(() => {});
    }
  }
}

/** Maximum pages to read in the text-extraction fallback. */
const MAX_TEXT_PAGES = 10;
/** Maximum characters accumulated from text extraction before truncating. */
const MAX_TEXT_CHARS = 50_000;
/** Maximum pages to attempt in the multi-page render fallback. */
const MAX_MULTIPAGE_PAGES = 10;
/** Maximum total bytes retained across all rendered page buffers (20 MB). */
const MAX_MULTIPAGE_BYTES = 20 * 1024 * 1024;

/**
 * Render up to MAX_MULTIPAGE_PAGES pages of a PDF buffer using the worker pool.
 * Stops early when the cumulative rendered size exceeds MAX_MULTIPAGE_BYTES.
 * Returns an array of successfully-rendered page buffers (empty array if none succeed).
 */
async function renderAllPdfPages(buffer: Buffer): Promise<Buffer[]> {
  let numPages = 1;
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loadingTask = pdfjs.getDocument({ data: new Uint8Array(buffer) });
    const pdfDoc = await loadingTask.promise;
    numPages = (pdfDoc as { numPages: number }).numPages;
    // Use loadingTask.destroy() — pdfjs 6 removed pdfDoc.destroy().
    await loadingTask.destroy();
  } catch (err) {
    logger.warn({ err }, "aiExtraction: failed to read PDF page count for multi-page render");
    return [];
  }

  const pagesToRender = Math.min(numPages, MAX_MULTIPAGE_PAGES);
  if (numPages > MAX_MULTIPAGE_PAGES) {
    logger.warn({ numPages, limit: MAX_MULTIPAGE_PAGES }, "aiExtraction: PDF has many pages; capping multi-page render");
  }

  const { runPdfToImageInWorker } = await import("../pdfToImagePool.js");
  const results: Buffer[] = [];
  let totalBytes = 0;

  for (let i = 1; i <= pagesToRender; i++) {
    const pageBuffer = await runPdfToImageInWorker(buffer, i);
    if (pageBuffer) {
      totalBytes += pageBuffer.length;
      if (totalBytes > MAX_MULTIPAGE_BYTES) {
        logger.warn({ totalBytes, limit: MAX_MULTIPAGE_BYTES, page: i }, "aiExtraction: multi-page render byte limit reached, stopping early");
        break;
      }
      results.push(pageBuffer);
    }
  }

  return results;
}

/**
 * Shared parse-and-normalise logic for both extraction entry points.
 * Accepts the raw JSON text returned by the AI, validates it against
 * extractionSchema, and maps it to ExtractedInvoiceData.
 */
function parseAndNormalizeAiResponse(
  rawJsonText: string,
  entityLegalName: string | null,
  entityTaxNumber: string | null,
): ExtractedInvoiceData {
  const jsonMatch = rawJsonText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("AI extraction returned no valid JSON");

  let rawJson: Record<string, unknown>;
  try {
    rawJson = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
  } catch {
    throw new Error("AI extraction returned invalid JSON");
  }

  const parsed = extractionSchema.safeParse(rawJson);
  let data: z.infer<typeof extractionSchema> | z.infer<ReturnType<typeof extractionSchema.partial>>;

  if (parsed.success) {
    data = parsed.data;
  } else {
    logger.warn({ issues: parsed.error.issues }, "aiExtraction: validation warnings, using partial data");

    const partial = extractionSchema.partial().safeParse(rawJson);
    if (partial.success) {
      data = partial.data;
    } else {
      // Best-effort field-by-field extraction: use .catch() so individual bad
      // fields are silently defaulted rather than causing the whole parse to fail.
      // NOTE: do NOT log the raw AI text here — it may contain vendor PII
      // (names, addresses, tax IDs). Log only structured validation metadata.
      logger.error(
        {
          partialIssues: partial.error.issues,
          responseByteLength: rawJsonText.length,
        },
        "aiExtraction: partial parse also failed, attempting catch-all extraction",
      );

      const catchAllSchema = extractionSchema.extend({
        vendor_name: z.string().nullable().catch(null).default(null),
        vendor_tax_number: z.string().nullable().catch(null).default(null),
        vendor_address: z.string().nullable().catch(null).default(null),
        invoice_number: z.string().nullable().catch(null).default(null),
        invoice_date: z.string().nullable().catch(null).default(null),
        due_date: z.string().nullable().catch(null).default(null),
        currency: z.string().catch("USD").default("USD"),
        subtotal: z.coerce.number().nullable().catch(null).default(null),
        discount: z.coerce.number().nullable().catch(null).default(null),
        tax_amount: z.coerce.number().nullable().catch(null).default(null),
        total_amount: z.coerce.number().nullable().catch(null).default(null),
        billing_country: z.string().nullable().catch(null).default(null),
        line_items: z.array(lineItemSchema).catch([]).default([]),
      });

      const catchAll = catchAllSchema.safeParse(rawJson);
      if (!catchAll.success) {
        // Do NOT log raw AI text — it may contain vendor PII.
        logger.error(
          { catchAllIssues: catchAll.error.issues, responseByteLength: rawJsonText.length },
          "aiExtraction: catch-all parse failed — data cannot be parsed",
        );
        throw new Error("AI extraction returned data that could not be parsed");
      }

      data = catchAll.data;
    }
  }

  const lineItems: InvoiceLineItem[] = (data.line_items ?? []).map((li) => ({
    description: li.description ?? "",
    quantity: li.quantity ?? 1,
    unit_price: li.unit_price ?? 0,
    total: li.total ?? 0,
    tax_rate: li.tax_rate ?? undefined,
    account_code: li.account_code ?? undefined,
    product_code: li.product_code ?? undefined,
    evidence: li.evidence ?? null,
  }));

  const companyValidation = validateCompanyMatch(
    data.vendor_name ?? null,
    data.vendor_tax_number ?? null,
    entityLegalName,
    entityTaxNumber,
  );

  // Normalise billing_country: keep only valid-looking 2-letter ISO codes.
  const rawCountry = (data as Record<string, unknown>).billing_country;
  const billingCountry =
    typeof rawCountry === "string" && /^[A-Z]{2}$/.test(rawCountry.trim().toUpperCase())
      ? rawCountry.trim().toUpperCase()
      : null;

  return {
    vendor_name: data.vendor_name ?? null,
    vendor_tax_number: data.vendor_tax_number ?? null,
    vendor_address: data.vendor_address ?? null,
    invoice_number: data.invoice_number ?? null,
    invoice_date: data.invoice_date ?? null,
    due_date: data.due_date ?? null,
    currency: data.currency ?? "USD",
    subtotal: data.subtotal ?? null,
    discount: data.discount ?? null,
    tax_amount: data.tax_amount ?? null,
    total_amount: data.total_amount ?? null,
    line_items: lineItems,
    confidence: data.confidence ?? 0.5,
    raw_ai_json: rawJson,
    company_validation_status: companyValidation.status,
    company_validation_notes: companyValidation.notes,
    billing_country: billingCountry,
    extraction_evidence: {
      fields: data.extraction_evidence?.fields ?? {},
      lines: (data.line_items ?? []).map((line) => line.evidence ?? null),
      coordinates_available: Object.values(data.extraction_evidence?.fields ?? {}).some((e) => !!e.region) || (data.line_items ?? []).some((line) => !!line.evidence?.region),
    },
  };
}

/** Concatenate all text blocks from an Anthropic messages response. */
function extractResponseText(response: { content: Array<{ type: string; text?: string }> }): string {
  return response.content
    .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
    .join("");
}

/**
 * Anthropic rejects images whose base64 payload exceeds 5 MB, which raw
 * bytes hit at ~3.75 MB. Keep a safety margin below that.
 */
const MAX_ANTHROPIC_IMAGE_BYTES = 3_500_000;
/** Anthropic's vision sweet spot — larger images are downscaled server-side anyway. */
const MAX_ANTHROPIC_IMAGE_EDGE = 1568;

type ClaudeImagePayload = { data: string; media_type: "image/jpeg" | "image/png" };

/**
 * Ensure an image fits Anthropic's 5 MB base64 limit. Oversized images
 * (e.g. full-resolution scanned-PDF renders) are downscaled to the vision
 * sweet spot and re-encoded as JPEG, stepping quality down if needed.
 */
export async function fitImageForClaude(
  buffer: Buffer,
  mime: "image/jpeg" | "image/png",
): Promise<ClaudeImagePayload> {
  if (buffer.length <= MAX_ANTHROPIC_IMAGE_BYTES) {
    return { data: buffer.toString("base64"), media_type: mime };
  }

  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  const img = await loadImage(buffer);
  let scale = Math.min(1, MAX_ANTHROPIC_IMAGE_EDGE / Math.max(img.width, img.height));

  for (let attempt = 0; attempt < 4; attempt++) {
    const width = Math.max(1, Math.round(img.width * scale));
    const height = Math.max(1, Math.round(img.height * scale));
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff"; // flatten transparency for JPEG
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    const quality = attempt === 0 ? 85 : attempt === 1 ? 70 : 55;
    const jpeg = canvas.toBuffer("image/jpeg", quality);
    if (jpeg.length <= MAX_ANTHROPIC_IMAGE_BYTES) {
      return { data: jpeg.toString("base64"), media_type: "image/jpeg" };
    }
    if (attempt >= 2) scale *= 0.7; // shrink further as a last resort
  }

  throw new Error("Image could not be compressed under the AI provider's 5 MB limit");
}

/**
 * Extract invoice data using pure text extracted from the PDF.
 * Used as a fallback when image rendering fails.
 */
async function extractWithText(
  pdfText: string,
  entityLegalName: string | null,
  entityTaxNumber: string | null,
  attribution?: AiUsageAttribution,
): Promise<ExtractedInvoiceData> {
  const model = process.env.AI_INVOICE_MODEL ?? "claude-opus-5";

  const textPrompt = `${EXTRACTION_PROMPT}\n\nNote: The following content is text extracted from a PDF invoice. Parse it carefully:\n\n${pdfText}`;

  let rawJsonText: string;
  try {
    const response = await callAI({
      actionKey: "finance.invoice_extraction.text",
      surface: "finance",
      provider: "anthropic",
      model,
      maxTokens: 8192,
      wasFallback: true,
      ...aiUsageAttribution(attribution),
      messages: [
        {
          role: "user",
          content: textPrompt,
        },
      ],
    });
    rawJsonText = extractResponseText(
      response as unknown as { content: Array<{ type: string; text?: string }> },
    );
  } catch (err) {
    logger.error({ err }, "aiExtraction: Anthropic text-based API call failed");
    throw new Error("AI extraction failed: " + (err instanceof Error ? err.message : "Unknown error"));
  }

  return parseAndNormalizeAiResponse(rawJsonText, entityLegalName, entityTaxNumber);
}

/**
 * Extract invoice data from any buffer (PDF or image).
 * For PDFs the buffer is converted to image first; for images it is used directly.
 *
 * Fallback chain for PDFs when page-1 render returns null:
 *   1. Text extraction via pdfjs-dist getTextContent() (works for digital PDFs)
 *   2. Multi-page image render — renders every page and sends all images to the AI model
 * Only throws if all paths fail.
 */
export async function extractInvoiceDataFromBuffer(
  buffer: Buffer,
  mimeType: string,
  entityLegalName: string | null,
  entityTaxNumber: string | null,
  attribution?: AiUsageAttribution,
): Promise<ExtractedInvoiceData> {
  if (mimeType !== "application/pdf") {
    // Image path: no fallback needed, send directly.
    let base64Image: string;
    let imageMime: string;
    if (mimeType === "image/jpeg" || mimeType === "image/jpg") {
      base64Image = buffer.toString("base64");
      imageMime = "image/jpeg";
    } else {
      base64Image = buffer.toString("base64");
      imageMime = "image/png";
    }
    return extractWithBase64(base64Image, imageMime, entityLegalName, entityTaxNumber, attribution);
  }

  // --- PDF path with ordered fallback chain ---
  const { runPdfToImageInWorker } = await import("../pdfToImagePool.js");

  // Attempt 1: single-page render (fast path, page 1 only).
  const imageBuffer = await runPdfToImageInWorker(buffer);
  if (imageBuffer) {
    return extractWithBase64(
      imageBuffer.toString("base64"),
      "image/png",
      entityLegalName,
      entityTaxNumber,
      attribution,
    );
  }

  logger.warn("aiExtraction: page-1 render returned null, trying text fallback");

  // Attempt 2: text extraction (works for digitally-created PDFs).
  const pdfText = await extractTextFromPdf(buffer);
  if (pdfText.length >= 50) {
    logger.info({ textLength: pdfText.length }, "aiExtraction: using text fallback for PDF extraction");
    return extractWithText(pdfText, entityLegalName, entityTaxNumber, attribution);
  }

  logger.warn(
    { textLength: pdfText.length },
    "aiExtraction: text fallback yielded too little content, trying multi-page render",
  );

  // Attempt 3: multi-page image render (covers scanned PDFs with multiple pages).
  const pageBuffers = await renderAllPdfPages(buffer);
  if (pageBuffers.length > 0) {
    logger.info({ pageCount: pageBuffers.length }, "aiExtraction: using multi-page image fallback");
    return extractWithMultipleImages(pageBuffers, entityLegalName, entityTaxNumber, attribution);
  }

  throw new Error(
    "Failed to extract invoice data: page-1 render failed, text extraction yielded no content, and multi-page render produced no images",
  );
}

/**
 * Extract invoice data from multiple page images (multi-page PDF fallback).
 * Sends all page images as separate image blocks in one Anthropic message.
 */
async function extractWithMultipleImages(
  pageBuffers: Buffer[],
  entityLegalName: string | null,
  entityTaxNumber: string | null,
  attribution?: AiUsageAttribution,
): Promise<ExtractedInvoiceData> {
  const model = process.env.AI_INVOICE_MODEL ?? "claude-opus-5";

  const fittedImages = await Promise.all(pageBuffers.map((buf) => fitImageForClaude(buf, "image/png")));
  const imageContents = fittedImages.map((img) => ({
    type: "image" as const,
    source: {
      type: "base64" as const,
      media_type: img.media_type,
      data: img.data,
    },
  }));

  let rawJsonText: string;
  try {
    const response = await callAI({
      actionKey: "finance.invoice_extraction.multi_page",
      surface: "finance",
      provider: "anthropic",
      model,
      maxTokens: 8192,
      wasFallback: true,
      ...aiUsageAttribution(attribution),
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: EXTRACTION_PROMPT },
            ...imageContents,
          ],
        },
      ],
    });
    rawJsonText = extractResponseText(
      response as unknown as { content: Array<{ type: string; text?: string }> },
    );
  } catch (err) {
    logger.error({ err }, "aiExtraction: Anthropic multi-page image API call failed");
    throw new Error("AI extraction failed: " + (err instanceof Error ? err.message : "Unknown error"));
  }

  return parseAndNormalizeAiResponse(rawJsonText, entityLegalName, entityTaxNumber);
}

async function extractWithBase64(
  base64Image: string,
  imageMime: string,
  entityLegalName: string | null,
  entityTaxNumber: string | null,
  attribution?: AiUsageAttribution,
): Promise<ExtractedInvoiceData> {
  const model = process.env.AI_INVOICE_MODEL ?? "claude-opus-5";

  const fitted = await fitImageForClaude(
    Buffer.from(base64Image, "base64"),
    imageMime === "image/jpeg" ? "image/jpeg" : "image/png",
  );

  let rawJsonText: string;
  try {
    const response = await callAI({
      actionKey: "finance.invoice_extraction.image",
      surface: "finance",
      provider: "anthropic",
      model,
      maxTokens: 8192,
      ...aiUsageAttribution(attribution),
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: EXTRACTION_PROMPT },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: fitted.media_type,
                data: fitted.data,
              },
            },
          ],
        },
      ],
    });
    rawJsonText = extractResponseText(
      response as unknown as { content: Array<{ type: string; text?: string }> },
    );
  } catch (err) {
    logger.error({ err }, "aiExtraction: Anthropic API call failed");
    throw new Error("AI extraction failed: " + (err instanceof Error ? err.message : "Unknown error"));
  }

  return parseAndNormalizeAiResponse(rawJsonText, entityLegalName, entityTaxNumber);
}

function validateCompanyMatch(
  extractedVendorName: string | null,
  extractedTaxNumber: string | null,
  entityLegalName: string | null,
  entityTaxNumber: string | null,
): { status: "matched" | "mismatch" | "unknown"; notes: string | null } {
  if (!entityLegalName && !entityTaxNumber) {
    return { status: "unknown", notes: "No entity data configured for comparison" };
  }

  if (entityTaxNumber && extractedTaxNumber) {
    const normalised = (s: string) => s.replace(/[\s\-]/g, "").toUpperCase();
    if (normalised(entityTaxNumber) === normalised(extractedTaxNumber)) {
      return { status: "matched", notes: "Tax number matched" };
    }
    return { status: "mismatch", notes: `Tax number mismatch: expected ${entityTaxNumber}, got ${extractedTaxNumber}` };
  }

  if (entityLegalName && extractedVendorName) {
    const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const similarity = normalise(extractedVendorName).includes(normalise(entityLegalName)) ||
      normalise(entityLegalName).includes(normalise(extractedVendorName));

    if (similarity) {
      return { status: "matched", notes: "Legal name matched" };
    }
    return { status: "mismatch", notes: `Vendor name mismatch: expected "${entityLegalName}", got "${extractedVendorName}"` };
  }

  return { status: "unknown", notes: "Insufficient data for company validation" };
}
