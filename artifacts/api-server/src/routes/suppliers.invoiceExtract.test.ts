import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

// ---------------------------------------------------------------------------
// Mocks — declared before importing the module under test
// ---------------------------------------------------------------------------

const mockDbQuery = vi.fn();

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
    connect: async () => ({
      query: vi.fn(),
      release: vi.fn(),
    }),
  },
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  authed: (req: express.Request) => req,
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const mockSave = vi.fn();
const mockFile = vi.fn((..._args: unknown[]) => ({ save: mockSave }));
const mockBucket = vi.fn((..._args: unknown[]) => ({ file: mockFile }));

vi.mock("../lib/objectStorage", () => ({
  objectStorageClient: {
    bucket: (...args: unknown[]) => mockBucket(...args),
  },
}));

const mockExtractInvoiceDataFromBuffer = vi.fn();

vi.mock("../lib/finance/aiExtraction", () => ({
  extractInvoiceDataFromBuffer: (...args: unknown[]) =>
    mockExtractInvoiceDataFromBuffer(...args),
}));

vi.mock("@clerk/express", () => ({
  clerkClient: {
    users: { getUserList: vi.fn().mockResolvedValue({ data: [] }) },
  },
}));

let stubWorkspaceOwnerId = "owner_123";
let stubActualRole: "owner" | "member" = "owner";
let stubUserId = "user_abc";

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = stubWorkspaceOwnerId;
    wreq.workspaceActualRole = stubActualRole;
    wreq.workspaceRole = stubActualRole;
    wreq.userId = stubUserId;
    wreq.userEmail = "owner@example.com";
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

import suppliersRouter from "./suppliers";

// ---------------------------------------------------------------------------
// Test app
// ---------------------------------------------------------------------------

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: Record<string, unknown> }).log = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
    };
    next();
  });
  app.use(suppliersRouter);
  return app;
}

// ---------------------------------------------------------------------------
// Sample extracted invoice data
// ---------------------------------------------------------------------------

const SAMPLE_EXTRACTION = {
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
    { description: "Roses", quantity: 2, unit_price: 454.545, total: 909.09, tax_rate: 0.05 },
  ],
  confidence: 0.92,
  company_validation_status: "matched" as const,
  company_validation_notes: "Tax number matched",
  raw_ai_json: {},
};

// ---------------------------------------------------------------------------
// POST /suppliers/:id/invoices/extract
// ---------------------------------------------------------------------------

describe("POST /suppliers/:id/invoices/extract", () => {
  const SUPPLIER_ROW = { rows: [{ id: 7, name: "Acme Flowers LLC", tax_number: "100-123-456" }], rowCount: 1 };

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubUserId = "user_abc";
    process.env.PRIVATE_OBJECT_DIR = "/workspace-private-bucket/owner_123";
    mockSave.mockResolvedValue(undefined);
  });

  it("returns 403 when the user lacks suppliers.edit permission", async () => {
    stubActualRole = "member";

    const res = await request(makeApp())
      .post("/suppliers/7/invoices/extract")
      .attach("file", Buffer.from("%PDF-1.4 fake"), { filename: "invoice.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/permission/i);
  });

  it("returns 404 when supplier does not exist in the workspace", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(makeApp())
      .post("/suppliers/999/invoices/extract")
      .attach("file", Buffer.from("%PDF-1.4 fake"), { filename: "invoice.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("returns 400 when no file is attached", async () => {
    mockDbQuery.mockResolvedValueOnce(SUPPLIER_ROW);

    const res = await request(makeApp())
      .post("/suppliers/7/invoices/extract");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/file is required/i);
  });

  it("returns 400 for an unsupported MIME type", async () => {
    mockDbQuery.mockResolvedValueOnce(SUPPLIER_ROW);

    const res = await request(makeApp())
      .post("/suppliers/7/invoices/extract")
      .attach("file", Buffer.from("data"), { filename: "invoice.xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/PDF, JPG, and PNG/i);
  });

  it("returns 500 when PRIVATE_OBJECT_DIR is not configured", async () => {
    delete process.env.PRIVATE_OBJECT_DIR;
    mockDbQuery.mockResolvedValueOnce(SUPPLIER_ROW);

    const res = await request(makeApp())
      .post("/suppliers/7/invoices/extract")
      .attach("file", Buffer.from("%PDF-1.4 fake"), { filename: "invoice.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/object storage not configured/i);
  });

  it("returns 200 with the expected shape on successful extraction", async () => {
    mockDbQuery.mockResolvedValueOnce(SUPPLIER_ROW);
    mockExtractInvoiceDataFromBuffer.mockResolvedValueOnce(SAMPLE_EXTRACTION);

    const res = await request(makeApp())
      .post("/suppliers/7/invoices/extract")
      .attach("file", Buffer.from("%PDF-1.4 fake"), { filename: "test-invoice.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(200);
    expect(res.body.fileUrl).toMatch(/^\/objects\//);
    expect(res.body.fileName).toBe("test-invoice.pdf");
    expect(res.body.mimeType).toBe("application/pdf");
    expect(res.body.fileSizeBytes).toBeGreaterThan(0);
    expect(res.body.extraction.vendor_name).toBe("Acme Flowers LLC");
    expect(res.body.extraction.invoice_number).toBe("INV-2025-001");
    expect(res.body.extraction.currency).toBe("AED");
    expect(res.body.extraction.total_amount).toBe(1000.0);
    expect(res.body.extraction.confidence).toBe(0.92);
    expect(res.body.extraction.company_validation_status).toBe("matched");
    expect(res.body.extraction.line_items).toHaveLength(1);
    expect(res.body.fieldsDetected).toBeGreaterThan(0);
  });

  it("uploads the file to object storage with the correct path structure", async () => {
    mockDbQuery.mockResolvedValueOnce(SUPPLIER_ROW);
    mockExtractInvoiceDataFromBuffer.mockResolvedValueOnce(SAMPLE_EXTRACTION);

    await request(makeApp())
      .post("/suppliers/7/invoices/extract")
      .attach("file", Buffer.from("%PDF-1.4 fake"), { filename: "test-invoice.pdf", contentType: "application/pdf" });

    expect(mockBucket).toHaveBeenCalledOnce();
    expect(mockFile).toHaveBeenCalledOnce();
    expect(mockSave).toHaveBeenCalledOnce();
    const savedArgs = mockSave.mock.calls[0];
    expect(savedArgs[1]).toMatchObject({ metadata: { contentType: "application/pdf" } });
  });

  it("passes the supplier name and tax number to the AI extractor", async () => {
    mockDbQuery.mockResolvedValueOnce(SUPPLIER_ROW);
    mockExtractInvoiceDataFromBuffer.mockResolvedValueOnce(SAMPLE_EXTRACTION);

    await request(makeApp())
      .post("/suppliers/7/invoices/extract")
      .attach("file", Buffer.from("fake-png"), { filename: "inv.png", contentType: "image/png" });

    expect(mockExtractInvoiceDataFromBuffer).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      "image/png",
      "Acme Flowers LLC",
      "100-123-456",
      { workspaceOwnerId: "owner_123" },
    );
  });

  it("returns 422 and the fileUrl when AI extraction fails", async () => {
    mockDbQuery.mockResolvedValueOnce(SUPPLIER_ROW);
    mockExtractInvoiceDataFromBuffer.mockRejectedValueOnce(new Error("AI extraction timed out after 30 seconds"));

    const res = await request(makeApp())
      .post("/suppliers/7/invoices/extract")
      .attach("file", Buffer.from("%PDF-1.4 fake"), { filename: "invoice.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/timed out/i);
    expect(res.body.fileUrl).toMatch(/^\/objects\//);
  });

  it("counts fieldsDetected correctly for a sparse extraction", async () => {
    const sparseExtraction = {
      ...SAMPLE_EXTRACTION,
      vendor_name: "Acme",
      invoice_number: "INV-001",
      invoice_date: null,
      due_date: null,
      currency: "USD",
      subtotal: null,
      tax_amount: null,
      total_amount: null,
      line_items: [],
      confidence: 0.4,
    };
    mockDbQuery.mockResolvedValueOnce(SUPPLIER_ROW);
    mockExtractInvoiceDataFromBuffer.mockResolvedValueOnce(sparseExtraction);

    const res = await request(makeApp())
      .post("/suppliers/7/invoices/extract")
      .attach("file", Buffer.from("img"), { filename: "inv.jpg", contentType: "image/jpeg" });

    expect(res.status).toBe(200);
    expect(res.body.fieldsDetected).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// GET /suppliers/:id/invoices/duplicate-check
// ---------------------------------------------------------------------------

describe("GET /suppliers/:id/invoices/duplicate-check", () => {
  const SUPPLIER_EXISTS = { rows: [{ id: 7 }], rowCount: 1 };

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubUserId = "user_abc";
  });

  it("returns 404 when the supplier does not exist in the workspace", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(makeApp())
      .get("/suppliers/999/invoices/duplicate-check?invoiceNumber=INV-001");

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("returns empty duplicates when neither invoiceNumber nor total is provided", async () => {
    mockDbQuery.mockResolvedValueOnce(SUPPLIER_EXISTS);

    const res = await request(makeApp())
      .get("/suppliers/7/invoices/duplicate-check");

    expect(res.status).toBe(200);
    expect(res.body.duplicates).toEqual([]);
    expect(res.body.hasDuplicates).toBe(false);
  });

  it("finds a duplicate by invoice number", async () => {
    mockDbQuery
      .mockResolvedValueOnce(SUPPLIER_EXISTS)
      .mockResolvedValueOnce({
        rows: [
          {
            id: 42,
            invoice_number: "INV-2025-001",
            amount: "1000.0000",
            currency: "AED",
            issued_at: "2025-01-15",
            status: "approved",
          },
        ],
        rowCount: 1,
      });

    const res = await request(makeApp())
      .get("/suppliers/7/invoices/duplicate-check?invoiceNumber=INV-2025-001");

    expect(res.status).toBe(200);
    expect(res.body.hasDuplicates).toBe(true);
    expect(res.body.duplicates).toHaveLength(1);
    expect(res.body.duplicates[0].id).toBe(42);
    expect(res.body.duplicates[0].invoiceNumber).toBe("INV-2025-001");
    expect(res.body.duplicates[0].reason).toBe("Same invoice number");
  });

  it("finds a duplicate by amount, currency, and date", async () => {
    mockDbQuery
      .mockResolvedValueOnce(SUPPLIER_EXISTS)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 55,
            invoice_number: "INV-DUP",
            amount: "500.0000",
            currency: "USD",
            issued_at: "2025-03-10",
            status: "pending",
          },
        ],
        rowCount: 1,
      });

    const res = await request(makeApp())
      .get(
        "/suppliers/7/invoices/duplicate-check?invoiceNumber=DIFFERENT&total=500&currency=USD&issuedAt=2025-03-10",
      );

    expect(res.status).toBe(200);
    expect(res.body.hasDuplicates).toBe(true);
    expect(res.body.duplicates[0].id).toBe(55);
    expect(res.body.duplicates[0].reason).toBe("Same amount, currency, and date");
  });

  it("returns no duplicates when no matching rows exist", async () => {
    mockDbQuery
      .mockResolvedValueOnce(SUPPLIER_EXISTS)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(makeApp())
      .get("/suppliers/7/invoices/duplicate-check?invoiceNumber=UNIQUE-99999");

    expect(res.status).toBe(200);
    expect(res.body.hasDuplicates).toBe(false);
    expect(res.body.duplicates).toHaveLength(0);
  });

  it("deduplicates rows that match both invoice number and amount criteria", async () => {
    const duplicateRow = {
      id: 77,
      invoice_number: "INV-MATCH",
      amount: "250.0000",
      currency: "USD",
      issued_at: "2025-05-01",
      status: "draft",
    };
    mockDbQuery
      .mockResolvedValueOnce(SUPPLIER_EXISTS)
      .mockResolvedValueOnce({ rows: [duplicateRow], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [duplicateRow], rowCount: 1 });

    const res = await request(makeApp())
      .get(
        "/suppliers/7/invoices/duplicate-check?invoiceNumber=INV-MATCH&total=250&currency=USD&issuedAt=2025-05-01",
      );

    expect(res.status).toBe(200);
    expect(res.body.duplicates).toHaveLength(1);
  });

  it("excludes the specified invoice ID from duplicate results", async () => {
    mockDbQuery
      .mockResolvedValueOnce(SUPPLIER_EXISTS)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(makeApp())
      .get("/suppliers/7/invoices/duplicate-check?invoiceNumber=INV-001&excludeId=42");

    expect(res.status).toBe(200);
    const queryCall = mockDbQuery.mock.calls[1];
    const sqlText = queryCall[0] as string;
    expect(sqlText).toContain("<>");
    const params = queryCall[1] as unknown[];
    expect(params).toContain(42);
  });
});
