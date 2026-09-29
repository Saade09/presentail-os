import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ---------------------------------------------------------------------------
// Hoisted mock state — must be declared before vi.mock calls
// ---------------------------------------------------------------------------

const { mockDbQuery, mockFileExists, mockFileSave } = vi.hoisted(() => ({
  mockDbQuery: vi.fn(),
  mockFileExists: vi.fn(),
  mockFileSave: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
  },
}));

vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../lib/objectStorage", () => ({
  objectStorageClient: {
    bucket: () => ({
      file: () => ({
        exists: (...args: unknown[]) => mockFileExists(...args),
        save: (...args: unknown[]) => mockFileSave(...args),
      }),
    }),
  },
}));

import supplierEmailInboundRouter from "./supplierEmailInbound";

// ---------------------------------------------------------------------------
// Test app
// ---------------------------------------------------------------------------

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(supplierEmailInboundRouter);
  return app;
}

const app = makeApp();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_SECRET = "test-secret-abc123";
const OWNER_ID = "owner_xyz789";
const SUPPLIER_EMAIL = "supplier@acme.example.com";

const FAKE_PDF = Buffer.from("%PDF-1.4 minimal fake pdf content for testing", "utf8");
const FAKE_PDF_B64 = FAKE_PDF.toString("base64");

// ---------------------------------------------------------------------------
// Helper: build a minimal valid Postmark inbound payload
// ---------------------------------------------------------------------------

function makePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    MessageID: "msg-test-001",
    From: `Acme Supplier <${SUPPLIER_EMAIL}>`,
    To: `po-reply+${OWNER_ID}@inbound.presentail.com`,
    Subject: "Re: PO-0042 order confirmation",
    Attachments: [
      { Name: "invoice.pdf", Content: FAKE_PDF_B64, ContentType: "application/pdf" },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// POST /webhooks/supplier-email/inbound — secret validation
// ---------------------------------------------------------------------------

describe("POST /webhooks/supplier-email/inbound — secret validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("SUPPLIER_WEBHOOK_SECRET", VALID_SECRET);
    vi.stubEnv("PRIVATE_OBJECT_DIR", "/test-bucket/private");
  });

  it("returns 401 when no secret header is provided", async () => {
    const res = await request(app)
      .post("/webhooks/supplier-email/inbound")
      .send(makePayload());

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ success: false });
  });

  it("returns 401 when wrong secret is provided", async () => {
    const res = await request(app)
      .post("/webhooks/supplier-email/inbound")
      .set("x-supplier-webhook-secret", "wrong-secret")
      .send(makePayload());

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ success: false });
  });

  it("returns 401 when SUPPLIER_WEBHOOK_SECRET env var is not set", async () => {
    vi.stubEnv("SUPPLIER_WEBHOOK_SECRET", "");

    const res = await request(app)
      .post("/webhooks/supplier-email/inbound")
      .set("x-supplier-webhook-secret", VALID_SECRET)
      .send(makePayload());

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ success: false });
  });

  it("accepts a valid secret via x-supplier-webhook-secret", async () => {
    mockDbQuery.mockResolvedValue({ rows: [] });
    const res = await request(app)
      .post("/webhooks/supplier-email/inbound")
      .set("x-supplier-webhook-secret", VALID_SECRET)
      .send(makePayload());

    expect(res.status).not.toBe(401);
  });

  it("accepts a valid secret via x-webhook-secret", async () => {
    mockDbQuery.mockResolvedValue({ rows: [] });
    const res = await request(app)
      .post("/webhooks/supplier-email/inbound")
      .set("x-webhook-secret", VALID_SECRET)
      .send(makePayload());

    expect(res.status).not.toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST /webhooks/supplier-email/inbound — workspace / attachment guards
// ---------------------------------------------------------------------------

describe("POST /webhooks/supplier-email/inbound — request guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("SUPPLIER_WEBHOOK_SECRET", VALID_SECRET);
    vi.stubEnv("PRIVATE_OBJECT_DIR", "/test-bucket/private");
  });

  it("returns 400 when no workspace ID can be determined", async () => {
    const res = await request(app)
      .post("/webhooks/supplier-email/inbound")
      .set("x-supplier-webhook-secret", VALID_SECRET)
      .send(makePayload({ To: "no-workspace-info@example.com" }));

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false });
    expect(res.body.error).toMatch(/workspace/i);
  });

  it("returns 200 with a no-attachments message when no PDF attachments are present", async () => {
    const res = await request(app)
      .post("/webhooks/supplier-email/inbound")
      .set("x-supplier-webhook-secret", VALID_SECRET)
      .send(makePayload({ Attachments: [] }));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true });
    expect(mockDbQuery).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /webhooks/supplier-email/inbound — supplier_document_attached activity
// ---------------------------------------------------------------------------

describe("POST /webhooks/supplier-email/inbound — supplier_document_attached activity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("SUPPLIER_WEBHOOK_SECRET", VALID_SECRET);
    vi.stubEnv("PRIVATE_OBJECT_DIR", "/test-bucket/private");
    mockFileExists.mockResolvedValue([false]);
    mockFileSave.mockResolvedValue(undefined);
  });

  it("writes a supplier_document_attached activity row when a supplier PDF is attached to a matching PO", async () => {
    // 1) supplier lookup, 2) PO lookup, 3) UPDATE attachment_urls, 4) INSERT activity
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 7, name: "Acme Supplier" }] });
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ id: 42, po_number: "PO-0042", attachment_urls: null }],
    });
    mockDbQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE purchase_orders
    mockDbQuery.mockResolvedValueOnce({ rows: [] }); // INSERT purchase_order_activity

    const res = await request(app)
      .post("/webhooks/supplier-email/inbound")
      .set("x-supplier-webhook-secret", VALID_SECRET)
      .send(makePayload());

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ success: true, attachment_count: 1 });

    await vi.waitFor(() => {
      expect(mockDbQuery).toHaveBeenCalledWith(
        expect.stringContaining("supplier_document_attached"),
        expect.arrayContaining([42, OWNER_ID]),
      );
    });

    const activityCall = mockDbQuery.mock.calls.find(
      ([sql]) => typeof sql === "string" && sql.includes("supplier_document_attached"),
    );
    expect(activityCall).toBeDefined();

    const sql = activityCall![0] as string;
    expect(sql).toContain("INSERT INTO purchase_order_activity");

    const params = activityCall![1] as unknown[];
    // params: [poId, workspaceOwnerId, description, metadata-json]
    expect(params[0]).toBe(42);
    expect(params[1]).toBe(OWNER_ID);
    expect(params[2]).toContain("invoice.pdf");

    const metadata = JSON.parse(params[3] as string) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      file_name: "invoice.pdf",
      sender_email: SUPPLIER_EMAIL,
      supplier_id: 7,
      supplier_name: "Acme Supplier",
    });
    expect(typeof metadata.storage_path).toBe("string");
  });

  it("does not write any activity row when the sender does not match an active supplier", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] }); // supplier lookup: no match

    const res = await request(app)
      .post("/webhooks/supplier-email/inbound")
      .set("x-supplier-webhook-secret", VALID_SECRET)
      .send(makePayload());

    expect(res.status).toBe(202);

    await vi.waitFor(() => {
      expect(mockDbQuery).toHaveBeenCalledTimes(1);
    });

    expect(mockDbQuery).not.toHaveBeenCalledWith(
      expect.stringContaining("supplier_document_attached"),
      expect.anything(),
    );
    expect(mockFileSave).not.toHaveBeenCalled();
  });

  it("does not write any activity row when no matching open PO is found", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 7, name: "Acme Supplier" }] });
    mockDbQuery.mockResolvedValueOnce({ rows: [] }); // PO lookup: no match

    const res = await request(app)
      .post("/webhooks/supplier-email/inbound")
      .set("x-supplier-webhook-secret", VALID_SECRET)
      .send(makePayload());

    expect(res.status).toBe(202);

    await vi.waitFor(() => {
      expect(mockDbQuery).toHaveBeenCalledTimes(2);
    });

    expect(mockDbQuery).not.toHaveBeenCalledWith(
      expect.stringContaining("supplier_document_attached"),
      expect.anything(),
    );
    expect(mockFileSave).not.toHaveBeenCalled();
  });
});
