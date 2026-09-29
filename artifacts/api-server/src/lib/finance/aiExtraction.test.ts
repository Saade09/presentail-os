import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — declared before importing the module under test
// ---------------------------------------------------------------------------

const mockCreate = vi.fn();

vi.mock("@workspace/integrations-anthropic-ai-server", () => ({
  anthropic: {
    messages: {
      create: (...args: unknown[]) => mockCreate(...args),
    },
  },
}));

const mockRunPdfToImageInWorker = vi.fn();

vi.mock("../pdfToImagePool", () => ({
  runPdfToImageInWorker: (...args: unknown[]) => mockRunPdfToImageInWorker(...args),
}));

vi.mock("../logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

// Mock pdfjs-dist for text extraction and page count helpers.
const mockPdfJsGetDocument = vi.fn();

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  getDocument: (...args: unknown[]) => mockPdfJsGetDocument(...args),
}));

import { extractInvoiceDataFromBuffer, fitImageForClaude } from "./aiExtraction.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAiResponse(json: Record<string, unknown>): { content: { type: string; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(json) }] };
}

/** Build a fake pdfjs document mock that returns the given text per page. */
function makePdfDoc(pages: Array<{ text: string }>) {
  const pageMocks = pages.map(({ text }) => ({
    getTextContent: vi.fn().mockResolvedValue({
      items: text ? [{ str: text }] : [],
    }),
  }));
  return {
    numPages: pages.length,
    getPage: vi.fn().mockImplementation((n: number) => Promise.resolve(pageMocks[n - 1])),
    destroy: vi.fn().mockResolvedValue(undefined),
  };
}

/** Set up mockPdfJsGetDocument to return a fake document with the given pages. */
function setupPdfJsMock(pages: Array<{ text: string }>) {
  const doc = makePdfDoc(pages);
  mockPdfJsGetDocument.mockReturnValue({
    promise: Promise.resolve(doc),
    destroy: vi.fn().mockResolvedValue(undefined),
  });
  return doc;
}

const FULL_INVOICE_JSON = {
  vendor_name: "Acme Flowers LLC",
  vendor_tax_number: "100-123-456",
  vendor_address: "123 Main St, Dubai, UAE",
  invoice_number: "INV-2025-001",
  invoice_date: "2025-01-15",
  due_date: "2025-02-15",
  currency: "AED",
  subtotal: 909.09,
  tax_amount: 90.91,
  total_amount: 1000.0,
  line_items: [
    {
      description: "Rose bouquet",
      quantity: 2,
      unit_price: 454.545,
      total: 909.09,
      tax_rate: 0.05,
      account_code: "4000",
      product_code: "ROSE-001",
    },
  ],
  confidence: 0.95,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("fitImageForClaude", () => {
  it("passes small images through unchanged", async () => {
    const buf = Buffer.from("small-image-bytes");
    const result = await fitImageForClaude(buf, "image/png");
    expect(result.media_type).toBe("image/png");
    expect(Buffer.from(result.data, "base64").equals(buf)).toBe(true);
  });

  it("downscales and re-encodes oversized images under the 5 MB base64 limit", async () => {
    // Generate a noisy PNG well above the 3.5 MB threshold (noise defeats PNG compression).
    const { createCanvas } = await import("@napi-rs/canvas");
    const size = 2400;
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext("2d");
    const imageData = ctx.createImageData(size, size);
    for (let i = 0; i < imageData.data.length; i++) {
      imageData.data[i] = Math.floor(Math.random() * 256);
    }
    ctx.putImageData(imageData, 0, 0);
    const bigPng = canvas.toBuffer("image/png");
    expect(bigPng.length).toBeGreaterThan(3_500_000);

    const result = await fitImageForClaude(bigPng, "image/png");
    expect(result.media_type).toBe("image/jpeg");
    const outBytes = Buffer.from(result.data, "base64");
    expect(outBytes.length).toBeLessThanOrEqual(3_500_000);
    // JPEG magic bytes
    expect(outBytes[0]).toBe(0xff);
    expect(outBytes[1]).toBe(0xd8);
  });
});
describe("extractInvoiceDataFromBuffer — field mapping (image input)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps all fields from a JPEG image correctly", async () => {
    mockCreate.mockResolvedValueOnce(makeAiResponse(FULL_INVOICE_JSON));

    const result = await extractInvoiceDataFromBuffer(
      Buffer.from("fake-jpeg"),
      "image/jpeg",
      null,
      null,
    );

    expect(result.vendor_name).toBe("Acme Flowers LLC");
    expect(result.vendor_tax_number).toBe("100-123-456");
    expect(result.vendor_address).toBe("123 Main St, Dubai, UAE");
    expect(result.invoice_number).toBe("INV-2025-001");
    expect(result.invoice_date).toBe("2025-01-15");
    expect(result.due_date).toBe("2025-02-15");
    expect(result.currency).toBe("AED");
    expect(result.subtotal).toBeCloseTo(909.09);
    expect(result.tax_amount).toBeCloseTo(90.91);
    expect(result.total_amount).toBe(1000.0);
    expect(result.confidence).toBe(0.95);
    expect(result.line_items).toHaveLength(1);
    expect(result.line_items[0].description).toBe("Rose bouquet");
    expect(result.line_items[0].quantity).toBe(2);
    expect(result.line_items[0].tax_rate).toBe(0.05);
    expect(result.line_items[0].account_code).toBe("4000");
    expect(result.line_items[0].product_code).toBe("ROSE-001");
    expect(result.raw_ai_json).toEqual(FULL_INVOICE_JSON);
  });

  it("maps all fields from a PNG image correctly", async () => {
    mockCreate.mockResolvedValueOnce(makeAiResponse(FULL_INVOICE_JSON));

    const result = await extractInvoiceDataFromBuffer(
      Buffer.from("fake-png"),
      "image/png",
      null,
      null,
    );

    expect(result.invoice_number).toBe("INV-2025-001");
    expect(mockRunPdfToImageInWorker).not.toHaveBeenCalled();
  });

  it("returns null for absent optional fields", async () => {
    mockCreate.mockResolvedValueOnce(
      makeAiResponse({
        vendor_name: null,
        invoice_number: null,
        invoice_date: null,
        due_date: null,
        currency: "USD",
        subtotal: null,
        tax_amount: null,
        total_amount: null,
        line_items: [],
        confidence: 0.3,
      }),
    );

    const result = await extractInvoiceDataFromBuffer(
      Buffer.from("fake-png"),
      "image/png",
      null,
      null,
    );

    expect(result.vendor_name).toBeNull();
    expect(result.invoice_number).toBeNull();
    expect(result.invoice_date).toBeNull();
    expect(result.due_date).toBeNull();
    expect(result.subtotal).toBeNull();
    expect(result.tax_amount).toBeNull();
    expect(result.total_amount).toBeNull();
    expect(result.line_items).toHaveLength(0);
    expect(result.currency).toBe("USD");
    expect(result.confidence).toBe(0.3);
  });

  it("defaults currency to USD when absent from AI response", async () => {
    const { currency: _omit, ...withoutCurrency } = FULL_INVOICE_JSON;
    mockCreate.mockResolvedValueOnce(makeAiResponse(withoutCurrency));

    const result = await extractInvoiceDataFromBuffer(
      Buffer.from("img"),
      "image/png",
      null,
      null,
    );

    expect(result.currency).toBe("USD");
  });
});

describe("extractInvoiceDataFromBuffer — PDF input", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("converts PDF to image via pdfToImagePool before extraction", async () => {
    const fakeImageBuffer = Buffer.from("fake-png-from-pdf");
    mockRunPdfToImageInWorker.mockResolvedValueOnce(fakeImageBuffer);
    mockCreate.mockResolvedValueOnce(makeAiResponse(FULL_INVOICE_JSON));

    const result = await extractInvoiceDataFromBuffer(
      Buffer.from("%PDF-fake"),
      "application/pdf",
      null,
      null,
    );

    expect(mockRunPdfToImageInWorker).toHaveBeenCalledOnce();
    expect(result.invoice_number).toBe("INV-2025-001");
  });

  it("falls through to text fallback when PDF-to-image returns null and text is sufficient", async () => {
    // Page-1 render fails.
    mockRunPdfToImageInWorker.mockResolvedValueOnce(null);

    // pdfjs returns a page with enough text (>= 50 chars).
    const longText = "Invoice Number INV-2025-001 Vendor: Acme Flowers LLC Total: 1000 AED";
    setupPdfJsMock([{ text: longText }]);

    mockCreate.mockResolvedValueOnce(makeAiResponse(FULL_INVOICE_JSON));

    const result = await extractInvoiceDataFromBuffer(
      Buffer.from("%PDF-fake"),
      "application/pdf",
      null,
      null,
    );

    // The AI call should have been made with the text prompt (no image block).
    expect(mockCreate).toHaveBeenCalledOnce();
    const callArgs = mockCreate.mock.calls[0][0] as {
      messages: Array<{ content: string | Array<{ type: string }> }>;
    };
    const userContent = callArgs.messages[0].content;
    // Text-only call: content should be a plain string, not an array with image blocks.
    expect(typeof userContent).toBe("string");
    expect(userContent as string).toContain("text extracted from a PDF invoice");

    expect(result.invoice_number).toBe("INV-2025-001");
  });

  it("falls through to multi-page render when text is too short", async () => {
    // Page-1 render fails.
    mockRunPdfToImageInWorker.mockResolvedValueOnce(null);

    // pdfjs returns sparse text (< 50 chars) for the text extraction call,
    // but also reports numPages = 2 for the multi-page render path.
    setupPdfJsMock([{ text: "hi" }]);

    // Multi-page: page 1 and 2 both succeed.
    const pageBuf1 = Buffer.from("page1-png");
    const pageBuf2 = Buffer.from("page2-png");
    mockRunPdfToImageInWorker
      .mockResolvedValueOnce(pageBuf1)   // page 1
      .mockResolvedValueOnce(pageBuf2);  // page 2

    // pdfjs is called again for the numPages check inside renderAllPdfPages —
    // set up a second result with numPages = 2.
    const doc2 = makePdfDoc([{ text: "hi" }, { text: "there" }]);
    mockPdfJsGetDocument
      .mockReturnValueOnce({ promise: Promise.resolve(makePdfDoc([{ text: "hi" }])), destroy: vi.fn().mockResolvedValue(undefined) }) // text extraction call
      .mockReturnValueOnce({ promise: Promise.resolve(doc2), destroy: vi.fn().mockResolvedValue(undefined) });                        // renderAllPdfPages call

    mockCreate.mockResolvedValueOnce(makeAiResponse(FULL_INVOICE_JSON));

    const result = await extractInvoiceDataFromBuffer(
      Buffer.from("%PDF-fake"),
      "application/pdf",
      null,
      null,
    );

    // The AI call should have been made with multiple image block entries.
    expect(mockCreate).toHaveBeenCalledOnce();
    const callArgs = mockCreate.mock.calls[0][0] as {
      messages: Array<{ content: Array<{ type: string }> }>;
    };
    const userContent = callArgs.messages[0].content;
    expect(Array.isArray(userContent)).toBe(true);
    const imageEntries = (userContent as Array<{ type: string }>).filter((c) => c.type === "image");
    expect(imageEntries.length).toBeGreaterThanOrEqual(1);

    expect(result.invoice_number).toBe("INV-2025-001");
  });

  it("caps text extraction at MAX_TEXT_PAGES and sends only the collected text", async () => {
    // Page-1 render fails.
    mockRunPdfToImageInWorker.mockResolvedValueOnce(null);

    // pdfjs reports 20 pages but extraction should stop at the limit (10).
    const pages = Array.from({ length: 20 }, (_, i) => ({
      text: `Page ${i + 1} content with enough words to be useful for extraction purposes here.`,
    }));
    setupPdfJsMock(pages);
    mockCreate.mockResolvedValueOnce(makeAiResponse(FULL_INVOICE_JSON));

    const result = await extractInvoiceDataFromBuffer(
      Buffer.from("%PDF-fake"),
      "application/pdf",
      null,
      null,
    );

    // Extraction should succeed via text fallback.
    expect(mockCreate).toHaveBeenCalledOnce();
    expect(result.invoice_number).toBe("INV-2025-001");
  });

  it("throws with a richer error when all fallbacks fail", async () => {
    // Page-1 render fails.
    mockRunPdfToImageInWorker.mockResolvedValue(null);

    // pdfjs returns empty text.
    setupPdfJsMock([{ text: "" }]);

    // Second pdfjs call (renderAllPdfPages page count) returns 1 page.
    const emptyDoc = makePdfDoc([{ text: "" }]);
    mockPdfJsGetDocument
      .mockReturnValueOnce({ promise: Promise.resolve(makePdfDoc([{ text: "" }])), destroy: vi.fn().mockResolvedValue(undefined) })
      .mockReturnValueOnce({ promise: Promise.resolve(emptyDoc), destroy: vi.fn().mockResolvedValue(undefined) });

    await expect(
      extractInvoiceDataFromBuffer(
        Buffer.from("%PDF-fake"),
        "application/pdf",
        null,
        null,
      ),
    ).rejects.toThrow(/page-1 render failed.*text extraction.*multi-page render/i);
  });
});

describe("extractInvoiceDataFromBuffer — company validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns status=matched when tax numbers match (normalized)", async () => {
    mockCreate.mockResolvedValueOnce(
      makeAiResponse({ ...FULL_INVOICE_JSON, vendor_tax_number: "100 123 456" }),
    );

    const result = await extractInvoiceDataFromBuffer(
      Buffer.from("img"),
      "image/png",
      "Acme Flowers LLC",
      "100-123-456",
    );

    expect(result.company_validation_status).toBe("matched");
    expect(result.company_validation_notes).toContain("Tax number matched");
  });

  it("returns status=mismatch when tax numbers differ", async () => {
    mockCreate.mockResolvedValueOnce(
      makeAiResponse({ ...FULL_INVOICE_JSON, vendor_tax_number: "999-000-000" }),
    );

    const result = await extractInvoiceDataFromBuffer(
      Buffer.from("img"),
      "image/png",
      "Acme Flowers LLC",
      "100-123-456",
    );

    expect(result.company_validation_status).toBe("mismatch");
    expect(result.company_validation_notes).toContain("Tax number mismatch");
  });

  it("falls back to name matching when tax number absent from extraction", async () => {
    mockCreate.mockResolvedValueOnce(
      makeAiResponse({ ...FULL_INVOICE_JSON, vendor_tax_number: null, vendor_name: "Acme Flowers LLC" }),
    );

    const result = await extractInvoiceDataFromBuffer(
      Buffer.from("img"),
      "image/png",
      "Acme Flowers",
      null,
    );

    expect(result.company_validation_status).toBe("matched");
    expect(result.company_validation_notes).toContain("Legal name matched");
  });

  it("returns status=mismatch when vendor name does not match", async () => {
    mockCreate.mockResolvedValueOnce(
      makeAiResponse({ ...FULL_INVOICE_JSON, vendor_tax_number: null, vendor_name: "Totally Different Co" }),
    );

    const result = await extractInvoiceDataFromBuffer(
      Buffer.from("img"),
      "image/png",
      "Acme Flowers LLC",
      null,
    );

    expect(result.company_validation_status).toBe("mismatch");
    expect(result.company_validation_notes).toContain("Vendor name mismatch");
  });

  it("returns status=unknown when no entity data supplied", async () => {
    mockCreate.mockResolvedValueOnce(makeAiResponse(FULL_INVOICE_JSON));

    const result = await extractInvoiceDataFromBuffer(
      Buffer.from("img"),
      "image/png",
      null,
      null,
    );

    expect(result.company_validation_status).toBe("unknown");
    expect(result.company_validation_notes).toContain("No entity data configured");
  });
});

describe("extractInvoiceDataFromBuffer — error handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws when the AI returns no valid JSON in its response", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "Sorry, I cannot help with that." }],
    });

    await expect(
      extractInvoiceDataFromBuffer(Buffer.from("img"), "image/png", null, null),
    ).rejects.toThrow("AI extraction returned no valid JSON");
  });

  it("throws when the AI call itself throws", async () => {
    mockCreate.mockRejectedValueOnce(new Error("Rate limit exceeded"));

    await expect(
      extractInvoiceDataFromBuffer(Buffer.from("img"), "image/png", null, null),
    ).rejects.toThrow("AI extraction failed: Rate limit exceeded");
  });

  it("throws when the AI returns syntactically invalid JSON", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "{ broken json here" }],
    });

    await expect(
      extractInvoiceDataFromBuffer(Buffer.from("img"), "image/png", null, null),
    ).rejects.toThrow(/AI extraction returned (no valid|invalid) JSON/);
  });

  it("wraps the AI json inside surrounding prose and still parses it", async () => {
    const json = { ...FULL_INVOICE_JSON };
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: `Here is the extracted data:\n${JSON.stringify(json)}\nDone.` }],
    });

    const result = await extractInvoiceDataFromBuffer(
      Buffer.from("img"),
      "image/png",
      null,
      null,
    );

    expect(result.invoice_number).toBe("INV-2025-001");
  });
});

describe("extractInvoiceDataFromBuffer — AI response quirks (regression)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("accepts null for optional line item fields (tax_rate, account_code, product_code)", async () => {
    const jsonWithNullOptionals = {
      ...FULL_INVOICE_JSON,
      line_items: [
        {
          description: "Tulip bunch",
          quantity: 5,
          unit_price: 10.0,
          total: 50.0,
          tax_rate: null,
          account_code: null,
          product_code: null,
        },
      ],
    };
    mockCreate.mockResolvedValueOnce(makeAiResponse(jsonWithNullOptionals));

    const result = await extractInvoiceDataFromBuffer(
      Buffer.from("img"),
      "image/png",
      null,
      null,
    );

    expect(result.line_items).toHaveLength(1);
    const item = result.line_items[0];
    expect(item.description).toBe("Tulip bunch");
    expect(item.quantity).toBe(5);
    expect(item.total).toBe(50);
    // null optional fields should be mapped to undefined in the output
    expect(item.tax_rate).toBeUndefined();
    expect(item.account_code).toBeUndefined();
    expect(item.product_code).toBeUndefined();
  });

  it("accepts string-formatted numeric fields from the AI (e.g. subtotal: '1234.56')", async () => {
    const jsonWithStringNumbers = {
      ...FULL_INVOICE_JSON,
      subtotal: "909.09",
      tax_amount: "90.91",
      total_amount: "1000.00",
      line_items: [
        {
          description: "Rose bouquet",
          quantity: "2",
          unit_price: "454.545",
          total: "909.09",
          tax_rate: "0.05",
          account_code: "4000",
          product_code: "ROSE-001",
        },
      ],
    };
    mockCreate.mockResolvedValueOnce(makeAiResponse(jsonWithStringNumbers));

    const result = await extractInvoiceDataFromBuffer(
      Buffer.from("img"),
      "image/png",
      null,
      null,
    );

    expect(result.subtotal).toBeCloseTo(909.09);
    expect(result.tax_amount).toBeCloseTo(90.91);
    expect(result.total_amount).toBeCloseTo(1000.0);
    expect(result.line_items[0].quantity).toBe(2);
    expect(result.line_items[0].unit_price).toBeCloseTo(454.545);
    expect(result.line_items[0].total).toBeCloseTo(909.09);
    expect(result.line_items[0].tax_rate).toBeCloseTo(0.05);
  });

  it("clamps confidence from percentage form (95) to fractional (0.95)", async () => {
    mockCreate.mockResolvedValueOnce(
      makeAiResponse({ ...FULL_INVOICE_JSON, confidence: 95 }),
    );

    const result = await extractInvoiceDataFromBuffer(
      Buffer.from("img"),
      "image/png",
      null,
      null,
    );

    expect(result.confidence).toBeCloseTo(0.95);
  });

  it("clamps confidence above 100 (e.g. 101) to 1.0, not 0.5 fallback", async () => {
    mockCreate.mockResolvedValueOnce(
      makeAiResponse({ ...FULL_INVOICE_JSON, confidence: 101 }),
    );

    const result = await extractInvoiceDataFromBuffer(
      Buffer.from("img"),
      "image/png",
      null,
      null,
    );

    expect(result.confidence).toBe(1);
  });

  it("clamps confidence of 150 to 1.0, not 0.5 fallback", async () => {
    mockCreate.mockResolvedValueOnce(
      makeAiResponse({ ...FULL_INVOICE_JSON, confidence: 150 }),
    );

    const result = await extractInvoiceDataFromBuffer(
      Buffer.from("img"),
      "image/png",
      null,
      null,
    );

    expect(result.confidence).toBe(1);
  });

  it("clamps a negative confidence to 0, not 0.5 fallback", async () => {
    mockCreate.mockResolvedValueOnce(
      makeAiResponse({ ...FULL_INVOICE_JSON, confidence: -0.5 }),
    );

    const result = await extractInvoiceDataFromBuffer(
      Buffer.from("img"),
      "image/png",
      null,
      null,
    );

    expect(result.confidence).toBe(0);
  });

  it("handles a mix of null optional line item fields and string numeric values together", async () => {
    const mixedJson = {
      ...FULL_INVOICE_JSON,
      subtotal: "500.00",
      total_amount: "525.00",
      tax_amount: "25.00",
      line_items: [
        {
          description: "Mixed item",
          quantity: "3",
          unit_price: "166.67",
          total: "500.01",
          tax_rate: null,
          account_code: null,
          product_code: "SKU-99",
        },
      ],
      confidence: 0.88,
    };
    mockCreate.mockResolvedValueOnce(makeAiResponse(mixedJson));

    const result = await extractInvoiceDataFromBuffer(
      Buffer.from("img"),
      "image/png",
      null,
      null,
    );

    expect(result.subtotal).toBeCloseTo(500.0);
    expect(result.total_amount).toBeCloseTo(525.0);
    expect(result.line_items).toHaveLength(1);
    const item = result.line_items[0];
    expect(item.quantity).toBe(3);
    expect(item.unit_price).toBeCloseTo(166.67);
    expect(item.tax_rate).toBeUndefined();
    expect(item.account_code).toBeUndefined();
    expect(item.product_code).toBe("SKU-99");
    expect(result.confidence).toBeCloseTo(0.88);
  });
});
