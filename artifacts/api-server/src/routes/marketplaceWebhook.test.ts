import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { Request, Response, NextFunction } from "express";
import request from "supertest";

// ---------------------------------------------------------------------------
// Hoisted mock state — must be declared before vi.mock calls
// ---------------------------------------------------------------------------

const { mockDbQuery, mockFileSave, mockExtractTotersPdf } = vi.hoisted(() => ({
  mockDbQuery: vi.fn(),
  mockFileSave: vi.fn(),
  mockExtractTotersPdf: vi.fn(),
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
    bucket: (_name: string) => ({
      file: (_path: string) => ({
        save: (...args: unknown[]) => mockFileSave(...args),
      }),
    }),
  },
}));

vi.mock("../lib/totersPdfExtractor", () => ({
  extractTotersPdf: (...args: unknown[]) => mockExtractTotersPdf(...args),
  normalizeMerchantName: (name: string) => name.toLowerCase().trim(),
}));

vi.mock("../lib/aiMarketplaceExtractor", () => ({
  extractMarketplaceReportWithAI: vi.fn().mockResolvedValue({
    merchantName: null,
    country: null,
    address: null,
    reportPeriodStart: null,
    reportPeriodEnd: null,
    metrics: [],
    weeklyTrends: [],
    bestSellingItems: [],
    confidence: 0.5,
  }),
}));

import marketplaceWebhookRouter from "./marketplaceWebhook";

// ---------------------------------------------------------------------------
// Test app
// ---------------------------------------------------------------------------

function makeApp() {
  const app = express();
  app.use(marketplaceWebhookRouter);
  // Translate multer LIMIT_FILE_SIZE errors to 400
  app.use((err: Error & { code?: string }, _req: Request, res: Response, _next: NextFunction) => {
    if (err && (err as { code?: string }).code === "LIMIT_FILE_SIZE") {
      res.status(400).json({ success: false, error: "PDF exceeds maximum allowed size" });
      return;
    }
    res.status(500).json({ success: false, error: "Internal server error" });
  });
  return app;
}

const app = makeApp();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_SECRET = "test-secret-xyz";
const OWNER_ID = "owner_abc123";
const CONFIGURED_OWNER_ID = OWNER_ID;
const FAKE_PDF = Buffer.from("%PDF-1.4 fake pdf content for testing purposes", "utf8");

// Default extracted data returned by the mock extractor
const EMPTY_EXTRACTION = {
  merchantName: null,
  country: null,
  address: null,
  reportPeriodStart: null,
  reportPeriodEnd: null,
  metrics: [],
  weeklyTrends: [],
  bestSellingItems: [],
};

// ---------------------------------------------------------------------------
// POST /webhooks/marketplace-reports/toters — secret validation
// ---------------------------------------------------------------------------

describe("POST /webhooks/marketplace-reports/toters — secret validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("MARKETPLACE_WEBHOOK_SECRET", VALID_SECRET);
    vi.stubEnv("MARKETPLACE_WEBHOOK_WORKSPACE_OWNER_ID", CONFIGURED_OWNER_ID);
    vi.stubEnv("PRIVATE_OBJECT_DIR", "test-bucket/private");
    mockFileSave.mockResolvedValue(undefined);
    mockExtractTotersPdf.mockResolvedValue(EMPTY_EXTRACTION);
    mockDbQuery.mockResolvedValue({ rows: [] });
  });

  it("returns 401 when no secret header is provided", async () => {
    const res = await request(app)
      .post("/webhooks/marketplace-reports/toters")
      .attach("pdf", FAKE_PDF, { filename: "report.pdf", contentType: "application/pdf" })
      .field("workspace_owner_id", OWNER_ID);

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ success: false });
  });

  it("returns 401 when wrong secret is provided via x-marketplace-secret", async () => {
    const res = await request(app)
      .post("/webhooks/marketplace-reports/toters")
      .set("x-marketplace-secret", "wrong-secret")
      .attach("pdf", FAKE_PDF, { filename: "report.pdf", contentType: "application/pdf" })
      .field("workspace_owner_id", OWNER_ID);

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ success: false });
  });

  it("returns 401 when wrong secret is provided via x-webhook-secret", async () => {
    const res = await request(app)
      .post("/webhooks/marketplace-reports/toters")
      .set("x-webhook-secret", "totally-wrong")
      .attach("pdf", FAKE_PDF, { filename: "report.pdf", contentType: "application/pdf" })
      .field("workspace_owner_id", OWNER_ID);

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ success: false });
  });

  it("rejects an invalid secret before Multer validates the uploaded file", async () => {
    const res = await request(app)
      .post("/webhooks/marketplace-reports/toters")
      .set("x-marketplace-secret", "wrong-secret")
      .attach("pdf", FAKE_PDF, { filename: "report.txt", contentType: "text/plain" })
      .field("workspace_owner_id", OWNER_ID);

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ success: false });
  });

  it("returns 401 when MARKETPLACE_WEBHOOK_SECRET env var is not set", async () => {
    vi.stubEnv("MARKETPLACE_WEBHOOK_SECRET", "");

    const res = await request(app)
      .post("/webhooks/marketplace-reports/toters")
      .set("x-marketplace-secret", VALID_SECRET)
      .attach("pdf", FAKE_PDF, { filename: "report.pdf", contentType: "application/pdf" })
      .field("workspace_owner_id", OWNER_ID);

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ success: false });
  });

  it("accepts a valid secret via x-marketplace-secret (any non-401 response)", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] }); // sha256 dedup
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 1 }] }); // INSERT

    const res = await request(app)
      .post("/webhooks/marketplace-reports/toters")
      .set("x-marketplace-secret", VALID_SECRET)
      .attach("pdf", FAKE_PDF, { filename: "report.pdf", contentType: "application/pdf" })
      .field("workspace_owner_id", OWNER_ID);

    expect(res.status).not.toBe(401);
  });

  it("accepts a valid secret via x-webhook-secret (any non-401 response)", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] }); // sha256 dedup
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 1 }] }); // INSERT

    const res = await request(app)
      .post("/webhooks/marketplace-reports/toters")
      .set("x-webhook-secret", VALID_SECRET)
      .attach("pdf", FAKE_PDF, { filename: "report.pdf", contentType: "application/pdf" })
      .field("workspace_owner_id", OWNER_ID);

    expect(res.status).not.toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST /webhooks/marketplace-reports/toters — missing file
// ---------------------------------------------------------------------------

describe("POST /webhooks/marketplace-reports/toters — missing file", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("MARKETPLACE_WEBHOOK_SECRET", VALID_SECRET);
    vi.stubEnv("MARKETPLACE_WEBHOOK_WORKSPACE_OWNER_ID", CONFIGURED_OWNER_ID);
    vi.stubEnv("PRIVATE_OBJECT_DIR", "test-bucket/private");
  });

  it("returns 400 when no pdf file is attached", async () => {
    const res = await request(app)
      .post("/webhooks/marketplace-reports/toters")
      .set("x-marketplace-secret", VALID_SECRET)
      .field("workspace_owner_id", OWNER_ID);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false });
    expect(res.body.error).toMatch(/pdf/i);
  });
});

// ---------------------------------------------------------------------------
// POST /webhooks/marketplace-reports/toters — missing workspace_owner_id
// ---------------------------------------------------------------------------

describe("POST /webhooks/marketplace-reports/toters — missing workspace_owner_id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("MARKETPLACE_WEBHOOK_SECRET", VALID_SECRET);
    vi.stubEnv("MARKETPLACE_WEBHOOK_WORKSPACE_OWNER_ID", CONFIGURED_OWNER_ID);
    vi.stubEnv("PRIVATE_OBJECT_DIR", "test-bucket/private");
  });

  it("returns 400 when workspace_owner_id field is absent", async () => {
    const res = await request(app)
      .post("/webhooks/marketplace-reports/toters")
      .set("x-marketplace-secret", VALID_SECRET)
      .attach("pdf", FAKE_PDF, { filename: "report.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false });
    expect(res.body.error).toMatch(/workspace_owner_id/i);
  });

  it("returns 400 when workspace_owner_id field is an empty string", async () => {
    const res = await request(app)
      .post("/webhooks/marketplace-reports/toters")
      .set("x-marketplace-secret", VALID_SECRET)
      .attach("pdf", FAKE_PDF, { filename: "report.pdf", contentType: "application/pdf" })
      .field("workspace_owner_id", "");

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false });
    expect(res.body.error).toMatch(/workspace_owner_id/i);
  });

  it("returns 403 when workspace_owner_id does not match the configured workspace", async () => {
    const res = await request(app)
      .post("/webhooks/marketplace-reports/toters")
      .set("x-marketplace-secret", VALID_SECRET)
      .attach("pdf", FAKE_PDF, { filename: "report.pdf", contentType: "application/pdf" })
      .field("workspace_owner_id", "another-workspace");

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ success: false, error: "Invalid workspace_owner_id" });
    expect(mockDbQuery).not.toHaveBeenCalled();
    expect(mockFileSave).not.toHaveBeenCalled();
  });

  it("returns 503 when no workspace is configured for the webhook", async () => {
    vi.stubEnv("MARKETPLACE_WEBHOOK_WORKSPACE_OWNER_ID", "");

    const res = await request(app)
      .post("/webhooks/marketplace-reports/toters")
      .set("x-marketplace-secret", VALID_SECRET)
      .attach("pdf", FAKE_PDF, { filename: "report.pdf", contentType: "application/pdf" })
      .field("workspace_owner_id", OWNER_ID);

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      success: false,
      error: "Marketplace webhook workspace is not configured",
    });
    expect(mockDbQuery).not.toHaveBeenCalled();
    expect(mockFileSave).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /webhooks/marketplace-reports/toters — oversized PDF
// ---------------------------------------------------------------------------

describe("POST /webhooks/marketplace-reports/toters — oversized PDF", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("MARKETPLACE_WEBHOOK_SECRET", VALID_SECRET);
    vi.stubEnv("MARKETPLACE_WEBHOOK_WORKSPACE_OWNER_ID", CONFIGURED_OWNER_ID);
    vi.stubEnv("PRIVATE_OBJECT_DIR", "test-bucket/private");
  });

  it("returns 400 when uploaded PDF exceeds the 20 MB limit", async () => {
    // Create a buffer slightly larger than 20 MB to trigger multer's size limit
    const oversizedPdf = Buffer.alloc(21 * 1024 * 1024, 0x25); // 0x25 = '%'

    const res = await request(app)
      .post("/webhooks/marketplace-reports/toters")
      .set("x-marketplace-secret", VALID_SECRET)
      .attach("pdf", oversizedPdf, { filename: "huge.pdf", contentType: "application/pdf" })
      .field("workspace_owner_id", OWNER_ID);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false });
  });
});

// ---------------------------------------------------------------------------
// POST /webhooks/marketplace-reports/toters — valid PDF upload (happy path)
// ---------------------------------------------------------------------------

describe("POST /webhooks/marketplace-reports/toters — valid PDF upload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("MARKETPLACE_WEBHOOK_SECRET", VALID_SECRET);
    vi.stubEnv("MARKETPLACE_WEBHOOK_WORKSPACE_OWNER_ID", CONFIGURED_OWNER_ID);
    vi.stubEnv("PRIVATE_OBJECT_DIR", "test-bucket/private");
    mockFileSave.mockResolvedValue(undefined);
    mockExtractTotersPdf.mockResolvedValue(EMPTY_EXTRACTION);
  });

  it("returns 202 and import_id when a new PDF is uploaded successfully", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] }); // sha256 dedup check
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 77 }] }); // INSERT RETURNING
    // runExtractionAndMatching DB queries (background)
    mockDbQuery.mockResolvedValue({ rows: [] });

    const res = await request(app)
      .post("/webhooks/marketplace-reports/toters")
      .set("x-marketplace-secret", VALID_SECRET)
      .attach("pdf", FAKE_PDF, { filename: "report.pdf", contentType: "application/pdf" })
      .field("workspace_owner_id", OWNER_ID);

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ success: true, import_id: 77 });
  });

  it("writes PDF to object storage before inserting the DB record", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] }); // sha256 dedup check
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 88 }] }); // INSERT RETURNING
    mockDbQuery.mockResolvedValue({ rows: [] }); // background queries

    await request(app)
      .post("/webhooks/marketplace-reports/toters")
      .set("x-marketplace-secret", VALID_SECRET)
      .attach("pdf", FAKE_PDF, { filename: "report.pdf", contentType: "application/pdf" })
      .field("workspace_owner_id", OWNER_ID);

    expect(mockFileSave).toHaveBeenCalledTimes(1);
    const [savedBuffer, saveOpts] = mockFileSave.mock.calls[0] as [Buffer, { contentType: string }];
    expect(savedBuffer).toEqual(FAKE_PDF);
    expect(saveOpts).toMatchObject({ contentType: "application/pdf" });
  });

  it("inserts a DB record for a new import with the correct workspace_owner_id", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] }); // sha256 dedup check
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 88 }] }); // INSERT RETURNING
    mockDbQuery.mockResolvedValue({ rows: [] }); // background queries

    await request(app)
      .post("/webhooks/marketplace-reports/toters")
      .set("x-marketplace-secret", VALID_SECRET)
      .attach("pdf", FAKE_PDF, { filename: "report.pdf", contentType: "application/pdf" })
      .field("workspace_owner_id", OWNER_ID);

    expect(mockDbQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO marketplace_report_imports"),
      expect.arrayContaining([OWNER_ID]),
    );
  });

  it("passes the optional message_id field to the DB insert", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] }); // sha256 dedup check
    mockDbQuery.mockResolvedValueOnce({ rows: [] }); // message_id dedup check
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 99 }] }); // INSERT RETURNING
    mockDbQuery.mockResolvedValue({ rows: [] }); // background queries

    const res = await request(app)
      .post("/webhooks/marketplace-reports/toters")
      .set("x-marketplace-secret", VALID_SECRET)
      .attach("pdf", FAKE_PDF, { filename: "report.pdf", contentType: "application/pdf" })
      .field("workspace_owner_id", OWNER_ID)
      .field("message_id", "test-email-msg-id-001");

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ success: true });

    expect(mockDbQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO marketplace_report_imports"),
      expect.arrayContaining([OWNER_ID, "test-email-msg-id-001"]),
    );
  });
});

// ---------------------------------------------------------------------------
// POST /webhooks/marketplace-reports/toters — SHA-256 deduplication
// ---------------------------------------------------------------------------

describe("POST /webhooks/marketplace-reports/toters — SHA-256 deduplication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("MARKETPLACE_WEBHOOK_SECRET", VALID_SECRET);
    vi.stubEnv("MARKETPLACE_WEBHOOK_WORKSPACE_OWNER_ID", CONFIGURED_OWNER_ID);
    vi.stubEnv("PRIVATE_OBJECT_DIR", "test-bucket/private");
    mockFileSave.mockResolvedValue(undefined);
    mockExtractTotersPdf.mockResolvedValue(EMPTY_EXTRACTION);
  });

  it("returns 200 with duplicate:true when the same PDF SHA-256 already exists", async () => {
    // SHA-256 dedup query finds an existing import
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 55 }] });

    const res = await request(app)
      .post("/webhooks/marketplace-reports/toters")
      .set("x-marketplace-secret", VALID_SECRET)
      .attach("pdf", FAKE_PDF, { filename: "report.pdf", contentType: "application/pdf" })
      .field("workspace_owner_id", OWNER_ID);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, duplicate: true, existing_import_id: 55 });
  });

  it("does not write to object storage or insert a DB row for a SHA-256 duplicate", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 55 }] });

    await request(app)
      .post("/webhooks/marketplace-reports/toters")
      .set("x-marketplace-secret", VALID_SECRET)
      .attach("pdf", FAKE_PDF, { filename: "report.pdf", contentType: "application/pdf" })
      .field("workspace_owner_id", OWNER_ID);

    expect(mockFileSave).not.toHaveBeenCalled();
    expect(mockDbQuery).not.toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO marketplace_report_imports"),
      expect.anything(),
    );
  });

  it("queries dedup with the correct workspace_owner_id and sha256 column", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 11 }] });

    await request(app)
      .post("/webhooks/marketplace-reports/toters")
      .set("x-marketplace-secret", VALID_SECRET)
      .attach("pdf", FAKE_PDF, { filename: "report.pdf", contentType: "application/pdf" })
      .field("workspace_owner_id", OWNER_ID);

    expect(mockDbQuery).toHaveBeenCalledWith(
      expect.stringContaining("pdf_sha256"),
      expect.arrayContaining([OWNER_ID]),
    );
  });

  it("deduplicates by message_id when SHA-256 is unique but message_id matches", async () => {
    // SHA-256 not found
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    // message_id dedup finds an existing import
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 33 }] });

    const res = await request(app)
      .post("/webhooks/marketplace-reports/toters")
      .set("x-marketplace-secret", VALID_SECRET)
      .attach("pdf", FAKE_PDF, { filename: "report.pdf", contentType: "application/pdf" })
      .field("workspace_owner_id", OWNER_ID)
      .field("message_id", "dup-email-msg-xyz");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, duplicate: true, existing_import_id: 33 });
    expect(mockFileSave).not.toHaveBeenCalled();
  });

  it("checks message_id dedup with the correct workspace_owner_id and message_id", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] }); // sha256 not a dup
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 44 }] }); // message_id dup found

    await request(app)
      .post("/webhooks/marketplace-reports/toters")
      .set("x-marketplace-secret", VALID_SECRET)
      .attach("pdf", FAKE_PDF, { filename: "report.pdf", contentType: "application/pdf" })
      .field("workspace_owner_id", OWNER_ID)
      .field("message_id", "unique-msg-id-123");

    expect(mockDbQuery).toHaveBeenCalledWith(
      expect.stringContaining("email_message_id"),
      expect.arrayContaining([OWNER_ID, "unique-msg-id-123"]),
    );
  });
});
