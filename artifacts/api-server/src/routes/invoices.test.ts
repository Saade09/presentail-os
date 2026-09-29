import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
  authed: (req: express.Request) => req,
}));

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = "user_owner_1";
    wreq.workspaceActualRole = "owner";
    wreq.workspaceRole = "owner";
    wreq.userId = "user_owner_1";
    wreq.userEmail = "owner@example.com";
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

// Mock DB
const mockDbQuery = vi.fn();
vi.mock("../lib/db", () => ({
  db: { query: (...args: unknown[]) => mockDbQuery(...args) },
}));

// Mock object storage
const mockUploadInvoicePdf = vi.fn();
const mockGetObjectEntityFile = vi.fn();
vi.mock("../lib/objectStorage", () => ({
  objectStorageClient: {
    bucket: () => ({
      file: () => ({
        save: mockUploadInvoicePdf,
        createReadStream: () => {
          const { Readable } = require("stream");
          const readable = new Readable();
          readable.push(Buffer.from("%PDF-mock"));
          readable.push(null);
          return readable;
        },
      }),
    }),
  },
  objectStorageService: {
    getObjectEntityFile: (...args: unknown[]) => mockGetObjectEntityFile(...args),
  },
}));

import invoicesRouter from "./invoices";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: unknown }).log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    next();
  });
  app.use("/api", invoicesRouter);
  app.use((_req, res) => { res.status(404).json({ error: "Not found" }); });
  return app;
}

// Helper: flush all microtasks/promises (for non-blocking async persistence)
const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 50));

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PRIVATE_OBJECT_DIR = "/test-bucket/private";
  mockUploadInvoicePdf.mockResolvedValue(undefined);
  mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

// ---------------------------------------------------------------------------
// POST /api/invoices/generate
// ---------------------------------------------------------------------------

describe("POST /api/invoices/generate (route)", () => {
  it("returns a PDF for an empty payload", async () => {
    const res = await request(makeApp())
      .post("/api/invoices/generate")
      .send({})
      .expect(200)
      .expect("Content-Type", /application\/pdf/);

    expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="Invoice-INV-/);
    expect(res.body.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("returns a PDF for a fully-filled payload", async () => {
    const res = await request(makeApp())
      .post("/api/invoices/generate")
      .send({
        name: "Jane Doe",
        email: "jane@example.com",
        address: "Beirut, Lebanon",
        item: "Flower bouquet",
        amount: 49.99,
        currency: "usd",
      })
      .expect(200)
      .expect("Content-Type", /application\/pdf/);

    expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="Invoice-INV-/);
    expect(res.body.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("returns 400 for an invalid payload", async () => {
    const res = await request(makeApp())
      .post("/api/invoices/generate")
      .send({ amount: -5, currency: "DOLLARS" })
      .expect(400);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe("Invalid input");
  });

  it("is NOT registered under a double /api prefix", async () => {
    await request(makeApp()).post("/api/api/invoices/generate").send({}).expect(404);
  });

  it("uploads PDF to storage and upserts a DB row on successful generation", async () => {
    await request(makeApp())
      .post("/api/invoices/generate")
      .send({ name: "Test Customer", amount: 100, currency: "USD" })
      .expect(200);

    // Wait for the non-blocking persistence to run
    await flushPromises();

    // Storage upload was called once
    expect(mockUploadInvoicePdf).toHaveBeenCalledTimes(1);
    // DB upsert was called
    expect(mockDbQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO generated_invoices"),
      expect.arrayContaining(["user_owner_1", expect.stringMatching(/^INV-/), "Test Customer"]),
    );
    // Uses ON CONFLICT DO UPDATE (not DO NOTHING) so conflicts update the row
    const [[sql]] = mockDbQuery.mock.calls;
    expect(sql).toContain("DO UPDATE SET pdf_object_key");
  });

  it("invoice number uses 8 hex chars for collision resistance", async () => {
    // generateAdhocInvoiceNumber should produce INV-YYYYMMDD-XXXXXXXX (8 hex chars)
    const { generateAdhocInvoiceNumber } = await import("../lib/adhocInvoicePdf");
    const num = generateAdhocInvoiceNumber(new Date("2026-08-11T00:00:00Z"));
    expect(num).toMatch(/^INV-20260811-[0-9A-F]{8}$/);
  });

  it("does NOT insert a DB row when PDF build fails", async () => {
    // Confirm that on 400 (validation) errors no DB write happens.
    await request(makeApp())
      .post("/api/invoices/generate")
      .send({ amount: -1 })
      .expect(400);

    await flushPromises();
    // No DB call on validation failure
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("still returns PDF even when storage upload fails (non-blocking)", async () => {
    mockUploadInvoicePdf.mockRejectedValueOnce(new Error("Storage unavailable"));

    const res = await request(makeApp())
      .post("/api/invoices/generate")
      .send({ name: "Test", amount: 50, currency: "USD" })
      .expect(200);

    expect(res.body.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});

// ---------------------------------------------------------------------------
// GET /api/invoices
// ---------------------------------------------------------------------------

describe("GET /api/invoices", () => {
  it("returns paginated rows and a summary object", async () => {
    // First call: summary aggregation, second: paginated rows
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{ total: "3", this_month: "1", total_value: "249.99", last_created_at: "2026-08-11T10:00:00Z" }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            invoice_number: "INV-20260811-AAAA",
            created_at: "2026-08-11T10:00:00Z",
            customer_name: "Alice",
            customer_email: "alice@example.com",
            customer_address: "Beirut",
            item_description: "Bouquet",
            amount: "99.99",
            currency: "USD",
            created_by_user_id: "user_owner_1",
            created_by_name: "owner@example.com",
            pdf_object_key: "/objects/user_owner_1/invoices/uuid1",
          },
        ],
      });

    const res = await request(makeApp())
      .get("/api/invoices")
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].invoice_number).toBe("INV-20260811-AAAA");
    expect(res.body.total).toBe(3);
    expect(res.body.total_pages).toBe(1);
    expect(res.body.summary).toMatchObject({
      total: 3,
      this_month: 1,
      total_value: 249.99,
      last_created_at: "2026-08-11T10:00:00Z",
    });
  });

  it("applies search filter to DB query", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ total: "0", this_month: "0", total_value: null, last_created_at: null }] })
      .mockResolvedValueOnce({ rows: [] });

    await request(makeApp())
      .get("/api/invoices?search=alice&dateFrom=2026-01-01&currency=USD")
      .expect(200);

    // Both queries should include the search/filter params
    const firstCall = mockDbQuery.mock.calls[0];
    expect(firstCall[1]).toContain("%alice%");
    expect(firstCall[1]).toContain("2026-01-01");
    expect(firstCall[1]).toContain("USD");
  });

  it("returns empty summary when no rows match", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ total: "0", this_month: "0", total_value: null, last_created_at: null }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(makeApp()).get("/api/invoices").expect(200);
    expect(res.body.summary.total).toBe(0);
    expect(res.body.summary.total_value).toBeNull();
    expect(res.body.summary.last_created_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GET /api/invoices/export-csv
// ---------------------------------------------------------------------------

describe("GET /api/invoices/export-csv", () => {
  it("returns CSV with correct headers and data rows", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          invoice_number: "INV-20260811-AAAA",
          created_at: "2026-08-11T10:00:00Z",
          customer_name: "Alice",
          customer_email: "alice@example.com",
          customer_address: "Beirut",
          item_description: "Bouquet",
          amount: "99.99",
          currency: "USD",
          created_by_name: "owner@example.com",
        },
      ],
    });

    const res = await request(makeApp())
      .get("/api/invoices/export-csv")
      .expect(200)
      .expect("Content-Type", /text\/csv/);

    expect(res.headers["content-disposition"]).toBe('attachment; filename="invoices.csv"');

    const lines = res.text.split("\n");
    expect(lines[0]).toBe(
      "Invoice #,Created,Customer Name,Customer Email,Customer Address,Item Description,Amount,Currency,Created By",
    );
    expect(lines[1]).toContain("INV-20260811-AAAA");
    expect(lines[1]).toContain("Alice");
    expect(lines[1]).toContain("99.99");
    expect(lines[1]).toContain("USD");
  });

  it("returns a CSV with only the header when no rows match", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(makeApp())
      .get("/api/invoices/export-csv")
      .expect(200);

    const lines = res.text.split("\n");
    expect(lines).toHaveLength(1); // header only
    expect(lines[0]).toContain("Invoice #");
  });

  it("escapes CSV values that contain commas", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          invoice_number: "INV-X",
          created_at: "2026-08-11T10:00:00Z",
          customer_name: "Smith, John",
          customer_email: null,
          customer_address: null,
          item_description: null,
          amount: null,
          currency: null,
          created_by_name: null,
        },
      ],
    });

    const res = await request(makeApp())
      .get("/api/invoices/export-csv")
      .expect(200);

    expect(res.text).toContain('"Smith, John"');
  });

  it("neutralizes formula-injection in user-controlled CSV fields", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          invoice_number: "INV-X",
          created_at: "2026-08-11T10:00:00Z",
          customer_name: "=HYPERLINK(\"evil.com\")",
          customer_email: "+cmd|' /C calc'!A1",
          customer_address: "-2+3",
          item_description: "@SUM(A1:B1)",
          amount: "99",
          currency: "USD",
          created_by_name: "|malicious",
        },
      ],
    });

    const res = await request(makeApp())
      .get("/api/invoices/export-csv")
      .expect(200);

    expect(res.text).toContain("'=HYPERLINK");
    expect(res.text).toContain("'+cmd");
    expect(res.text).toContain("'-2+3");
    expect(res.text).toContain("'@SUM");
    expect(res.text).toContain("'|malicious");
  });
});

// ---------------------------------------------------------------------------
// GET /api/invoices/:id/download
// ---------------------------------------------------------------------------

describe("GET /api/invoices/:id/download", () => {
  it("streams the stored PDF for a valid invoice", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ invoice_number: "INV-20260811-AAAA", pdf_object_key: "/objects/user_owner_1/invoices/uuid1" }],
    });

    const { Readable } = await import("stream");
    const mockStream = new Readable();
    mockStream.push(Buffer.from("%PDF-mock"));
    mockStream.push(null);

    mockGetObjectEntityFile.mockResolvedValueOnce({
      createReadStream: () => mockStream,
    });

    const res = await request(makeApp())
      .get("/api/invoices/1/download")
      .expect(200)
      .expect("Content-Type", /application\/pdf/);

    expect(res.headers["content-disposition"]).toMatch(/filename="Invoice-INV-/);
    expect(mockGetObjectEntityFile).toHaveBeenCalledWith("/objects/user_owner_1/invoices/uuid1");
  });

  it("returns 404 for an unknown invoice ID", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(makeApp())
      .get("/api/invoices/9999/download")
      .expect(404);

    expect(res.body.success).toBe(false);
  });

  it("returns 404 when pdf_object_key is null", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ invoice_number: "INV-X", pdf_object_key: null }],
    });

    const res = await request(makeApp())
      .get("/api/invoices/1/download")
      .expect(404);

    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain("PDF not available");
  });

  it("returns 400 for a non-numeric invoice ID", async () => {
    const res = await request(makeApp())
      .get("/api/invoices/not-a-number/download")
      .expect(400);

    expect(res.body.success).toBe(false);
  });

  it("returns 404 when object storage reports file not found", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ invoice_number: "INV-X", pdf_object_key: "/objects/user_owner_1/invoices/gone" }],
    });

    const err = new Error("Object not found");
    err.name = "ObjectNotFoundError";
    mockGetObjectEntityFile.mockRejectedValueOnce(err);

    const res = await request(makeApp())
      .get("/api/invoices/1/download")
      .expect(404);

    expect(res.body.success).toBe(false);
  });
});
