import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { Request, Response, NextFunction } from "express";
import request from "supertest";

// ---------------------------------------------------------------------------
// Hoisted mock state — must be declared before vi.mock calls
// ---------------------------------------------------------------------------

const { mockDbQuery, mockStorePdf, mockRunExtraction } = vi.hoisted(() => ({
  mockDbQuery: vi.fn(),
  mockStorePdf: vi.fn(),
  mockRunExtraction: vi.fn(),
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

vi.mock("./marketplaceWebhook", () => ({
  storePdfToObjectStorage: (...args: unknown[]) => mockStorePdf(...args),
  runExtractionAndMatching: (...args: unknown[]) => mockRunExtraction(...args),
}));

import marketplaceEmailInboundRouter from "./marketplaceEmailInbound";

// ---------------------------------------------------------------------------
// Test app
// ---------------------------------------------------------------------------

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(marketplaceEmailInboundRouter);
  return app;
}

const app = makeApp();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_SECRET = "test-secret-abc123";
const OWNER_ID = "owner_xyz789";

// Minimal valid PDF buffer (just enough bytes to pass size checks)
const FAKE_PDF = Buffer.from("%PDF-1.4 minimal fake pdf content for testing", "utf8");
const FAKE_PDF_B64 = FAKE_PDF.toString("base64");

// ---------------------------------------------------------------------------
// Helper: build a minimal valid Postmark inbound payload
// ---------------------------------------------------------------------------

function makePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    MessageID: "msg-test-001",
    From: "sender@example.com",
    To: `marketplace-reports+${OWNER_ID}@inbound.presentail.com`,
    Subject: "Weekly Report",
    Attachments: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// POST /webhooks/marketplace-email/inbound — auth
// ---------------------------------------------------------------------------

describe("POST /webhooks/marketplace-email/inbound — secret validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("MARKETPLACE_WEBHOOK_SECRET", VALID_SECRET);
  });

  it("returns 401 when no secret header is provided", async () => {
    const res = await request(app)
      .post("/webhooks/marketplace-email/inbound")
      .send(makePayload());

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ success: false });
  });

  it("returns 401 when wrong secret is provided via x-marketplace-secret", async () => {
    const res = await request(app)
      .post("/webhooks/marketplace-email/inbound")
      .set("x-marketplace-secret", "wrong-secret")
      .send(makePayload());

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ success: false });
  });

  it("returns 401 when wrong secret is provided via x-webhook-secret", async () => {
    const res = await request(app)
      .post("/webhooks/marketplace-email/inbound")
      .set("x-webhook-secret", "wrong-secret")
      .send(makePayload());

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ success: false });
  });

  it("returns 401 when MARKETPLACE_WEBHOOK_SECRET env var is not set", async () => {
    vi.stubEnv("MARKETPLACE_WEBHOOK_SECRET", "");

    const res = await request(app)
      .post("/webhooks/marketplace-email/inbound")
      .set("x-marketplace-secret", VALID_SECRET)
      .send(makePayload());

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ success: false });
  });

  it("accepts valid secret via x-marketplace-secret", async () => {
    const res = await request(app)
      .post("/webhooks/marketplace-email/inbound")
      .set("x-marketplace-secret", VALID_SECRET)
      .send(makePayload({ Attachments: [] }));

    // Any non-401 response means auth passed
    expect(res.status).not.toBe(401);
  });

  it("accepts valid secret via x-webhook-secret", async () => {
    const res = await request(app)
      .post("/webhooks/marketplace-email/inbound")
      .set("x-webhook-secret", VALID_SECRET)
      .send(makePayload({ Attachments: [] }));

    expect(res.status).not.toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST /webhooks/marketplace-email/inbound — workspace resolution
// ---------------------------------------------------------------------------

describe("POST /webhooks/marketplace-email/inbound — workspace ID resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("MARKETPLACE_WEBHOOK_SECRET", VALID_SECRET);
  });

  it("returns 400 when no workspace ID can be determined", async () => {
    const res = await request(app)
      .post("/webhooks/marketplace-email/inbound")
      .set("x-marketplace-secret", VALID_SECRET)
      .send({
        MessageID: "msg-001",
        From: "sender@example.com",
        To: "no-workspace-info@example.com",
        Attachments: [],
      });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false });
    expect(res.body.error).toMatch(/workspace/i);
  });

  it("parses workspace ID from marketplace-reports+ To address", async () => {
    const res = await request(app)
      .post("/webhooks/marketplace-email/inbound")
      .set("x-marketplace-secret", VALID_SECRET)
      .send(makePayload({
        To: `marketplace-reports+${OWNER_ID}@inbound.presentail.com`,
        Attachments: [],
      }));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true });
  });

  it("parses workspace ID from marketplace+ To address (short format)", async () => {
    const res = await request(app)
      .post("/webhooks/marketplace-email/inbound")
      .set("x-marketplace-secret", VALID_SECRET)
      .send(makePayload({
        To: `marketplace+${OWNER_ID}@inbound.presentail.com`,
        Attachments: [],
      }));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true });
  });

  it("parses workspace ID from ToFull array", async () => {
    const res = await request(app)
      .post("/webhooks/marketplace-email/inbound")
      .set("x-marketplace-secret", VALID_SECRET)
      .send({
        MessageID: "msg-001",
        From: "sender@example.com",
        ToFull: [{ Email: `marketplace-reports+${OWNER_ID}@inbound.presentail.com`, Name: "Presentail" }],
        Attachments: [],
      });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true });
  });

  it("uses explicit workspace_owner_id field when provided", async () => {
    const res = await request(app)
      .post("/webhooks/marketplace-email/inbound")
      .set("x-marketplace-secret", VALID_SECRET)
      .send({
        MessageID: "msg-001",
        From: "sender@example.com",
        To: "unrelated-address@example.com",
        workspace_owner_id: OWNER_ID,
        Attachments: [],
      });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true });
  });
});

// ---------------------------------------------------------------------------
// POST /webhooks/marketplace-email/inbound — no PDF attachments
// ---------------------------------------------------------------------------

describe("POST /webhooks/marketplace-email/inbound — no PDF attachments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("MARKETPLACE_WEBHOOK_SECRET", VALID_SECRET);
  });

  it("returns 200 with empty imports when Attachments is absent", async () => {
    const res = await request(app)
      .post("/webhooks/marketplace-email/inbound")
      .set("x-marketplace-secret", VALID_SECRET)
      .send(makePayload({ Attachments: undefined }));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, imports: [] });
  });

  it("returns 200 with empty imports when Attachments array is empty", async () => {
    const res = await request(app)
      .post("/webhooks/marketplace-email/inbound")
      .set("x-marketplace-secret", VALID_SECRET)
      .send(makePayload({ Attachments: [] }));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, imports: [] });
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 200 with empty imports when only non-PDF attachments are present", async () => {
    const res = await request(app)
      .post("/webhooks/marketplace-email/inbound")
      .set("x-marketplace-secret", VALID_SECRET)
      .send(makePayload({
        Attachments: [
          { Name: "report.xlsx", Content: "aGVsbG8=", ContentType: "application/vnd.ms-excel" },
          { Name: "logo.png", Content: "aGVsbG8=", ContentType: "image/png" },
        ],
      }));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, imports: [] });
    expect(mockDbQuery).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /webhooks/marketplace-email/inbound — PDF attachment processing
// ---------------------------------------------------------------------------

describe("POST /webhooks/marketplace-email/inbound — valid PDF attachment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("MARKETPLACE_WEBHOOK_SECRET", VALID_SECRET);
    // No duplicate found
    mockDbQuery.mockResolvedValue({ rows: [] });
    mockStorePdf.mockResolvedValue("gs://bucket/path/to/file.pdf");
    mockRunExtraction.mockResolvedValue(undefined);
  });

  it("returns 202 and starts processing when a PDF attachment is present", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] }); // sha256 dedup check
    mockDbQuery.mockResolvedValueOnce({ rows: [] }); // messageId dedup check
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 42 }] }); // INSERT RETURNING

    const res = await request(app)
      .post("/webhooks/marketplace-email/inbound")
      .set("x-marketplace-secret", VALID_SECRET)
      .send(makePayload({
        Attachments: [
          { Name: "report.pdf", Content: FAKE_PDF_B64, ContentType: "application/pdf" },
        ],
      }));

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      success: true,
      attachment_count: 1,
    });
  });

  it("detects PDF by file extension when ContentType is not pdf", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] }); // sha256 dedup check
    mockDbQuery.mockResolvedValueOnce({ rows: [] }); // messageId dedup check
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 99 }] }); // INSERT RETURNING

    const res = await request(app)
      .post("/webhooks/marketplace-email/inbound")
      .set("x-marketplace-secret", VALID_SECRET)
      .send(makePayload({
        Attachments: [
          { Name: "toters-report.pdf", Content: FAKE_PDF_B64, ContentType: "application/octet-stream" },
        ],
      }));

    expect(res.status).toBe(202);
    expect(res.body.attachment_count).toBe(1);
  });

  it("calls storePdfToObjectStorage and inserts a DB record for a new PDF", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] }); // sha256 dedup check
    mockDbQuery.mockResolvedValueOnce({ rows: [] }); // messageId dedup check
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 55 }] }); // INSERT RETURNING

    await request(app)
      .post("/webhooks/marketplace-email/inbound")
      .set("x-marketplace-secret", VALID_SECRET)
      .send(makePayload({
        Attachments: [
          { Name: "report.pdf", Content: FAKE_PDF_B64, ContentType: "application/pdf" },
        ],
      }));

    // Allow async processing loop to complete
    await vi.waitFor(() => {
      expect(mockStorePdf).toHaveBeenCalledTimes(1);
    });

    expect(mockDbQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO marketplace_report_imports"),
      expect.arrayContaining([OWNER_ID, "gs://bucket/path/to/file.pdf"]),
    );

    expect(mockRunExtraction).toHaveBeenCalledWith(55, expect.any(Buffer), OWNER_ID);
  });
});

// ---------------------------------------------------------------------------
// POST /webhooks/marketplace-email/inbound — SHA-256 deduplication
// ---------------------------------------------------------------------------

describe("POST /webhooks/marketplace-email/inbound — SHA-256 deduplication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("MARKETPLACE_WEBHOOK_SECRET", VALID_SECRET);
  });

  it("returns 202 and skips insert when SHA-256 already exists", async () => {
    // SHA-256 dedup query finds an existing import
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 7 }] });

    await request(app)
      .post("/webhooks/marketplace-email/inbound")
      .set("x-marketplace-secret", VALID_SECRET)
      .send(makePayload({
        Attachments: [
          { Name: "report.pdf", Content: FAKE_PDF_B64, ContentType: "application/pdf" },
        ],
      }));

    // Allow async processing loop to complete
    await vi.waitFor(() => {
      // The SHA-256 dedup query must have been called
      expect(mockDbQuery).toHaveBeenCalledWith(
        expect.stringContaining("pdf_sha256"),
        expect.arrayContaining([OWNER_ID]),
      );
    });

    // storePdfToObjectStorage should NOT be called for duplicates
    expect(mockStorePdf).not.toHaveBeenCalled();
    // INSERT should NOT be called
    expect(mockDbQuery).not.toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO marketplace_report_imports"),
      expect.anything(),
    );
  });

  it("deduplicates by email MessageID when the same message is re-delivered", async () => {
    // SHA-256 not found
    mockDbQuery.mockResolvedValueOnce({ rows: [] });
    // MessageID dedup finds an existing import
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 12 }] });

    await request(app)
      .post("/webhooks/marketplace-email/inbound")
      .set("x-marketplace-secret", VALID_SECRET)
      .send(makePayload({
        MessageID: "unique-message-id-abc",
        Attachments: [
          { Name: "report.pdf", Content: FAKE_PDF_B64, ContentType: "application/pdf" },
        ],
      }));

    await vi.waitFor(() => {
      expect(mockDbQuery).toHaveBeenCalledWith(
        expect.stringContaining("email_message_id"),
        expect.arrayContaining([OWNER_ID, "unique-message-id-abc"]),
      );
    });

    expect(mockStorePdf).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /webhooks/marketplace-email/inbound — multiple attachments
// ---------------------------------------------------------------------------

describe("POST /webhooks/marketplace-email/inbound — multiple attachments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("MARKETPLACE_WEBHOOK_SECRET", VALID_SECRET);
  });

  it("reports attachment_count matching number of PDF attachments found", async () => {
    // Two PDFs; no duplicates for either; both insert successfully
    mockDbQuery.mockResolvedValueOnce({ rows: [] }); // sha256 dedup pdf1
    mockDbQuery.mockResolvedValueOnce({ rows: [] }); // msgId dedup pdf1
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 101 }] }); // INSERT pdf1
    mockDbQuery.mockResolvedValueOnce({ rows: [] }); // sha256 dedup pdf2
    mockDbQuery.mockResolvedValueOnce({ rows: [] }); // msgId dedup pdf2
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 102 }] }); // INSERT pdf2

    mockStorePdf.mockResolvedValue("gs://bucket/file.pdf");
    mockRunExtraction.mockResolvedValue(undefined);

    const res = await request(app)
      .post("/webhooks/marketplace-email/inbound")
      .set("x-marketplace-secret", VALID_SECRET)
      .send(makePayload({
        Attachments: [
          { Name: "report1.pdf", Content: FAKE_PDF_B64, ContentType: "application/pdf" },
          { Name: "report2.pdf", Content: FAKE_PDF_B64, ContentType: "application/pdf" },
          { Name: "image.jpg", Content: "aGVsbG8=", ContentType: "image/jpeg" },
        ],
      }));

    expect(res.status).toBe(202);
    expect(res.body.attachment_count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// POST /webhooks/marketplace-email/inbound — Mailgun multipart format
// ---------------------------------------------------------------------------

const MAILGUN_TO = `marketplace-reports+${OWNER_ID}@inbound.presentail.com`;

describe("POST /webhooks/marketplace-email/inbound — Mailgun 401 secret validation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("MARKETPLACE_WEBHOOK_SECRET", VALID_SECRET);
    mockDbQuery.mockResolvedValue({ rows: [] });
    mockStorePdf.mockResolvedValue("gs://bucket/report.pdf");
    mockRunExtraction.mockResolvedValue(undefined);
  });

  it("returns 401 when no secret header is provided (Mailgun)", async () => {
    const res = await request(app)
      .post("/webhooks/marketplace-email/inbound")
      .field("recipient", MAILGUN_TO)
      .attach("attachment-1", FAKE_PDF, { filename: "report.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ success: false });
  });

  it("returns 401 when wrong secret is provided (Mailgun)", async () => {
    const res = await request(app)
      .post("/webhooks/marketplace-email/inbound")
      .set("x-marketplace-secret", "wrong-secret")
      .field("recipient", MAILGUN_TO)
      .attach("attachment-1", FAKE_PDF, { filename: "report.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ success: false });
  });
});

describe("POST /webhooks/marketplace-email/inbound — Mailgun 400 unresolvable workspace", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("MARKETPLACE_WEBHOOK_SECRET", VALID_SECRET);
    mockDbQuery.mockResolvedValue({ rows: [] });
  });

  it("returns 400 when recipient field is absent (Mailgun)", async () => {
    const res = await request(app)
      .post("/webhooks/marketplace-email/inbound")
      .set("x-marketplace-secret", VALID_SECRET)
      .attach("attachment-1", FAKE_PDF, { filename: "report.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false });
    expect(res.body.error).toMatch(/workspace/i);
  });

  it("returns 400 when recipient has no marketplace+ sub-address (Mailgun)", async () => {
    const res = await request(app)
      .post("/webhooks/marketplace-email/inbound")
      .set("x-marketplace-secret", VALID_SECRET)
      .field("recipient", "unknown@inbound.presentail.com")
      .attach("attachment-1", FAKE_PDF, { filename: "report.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false });
    expect(res.body.error).toMatch(/workspace/i);
  });
});

describe("POST /webhooks/marketplace-email/inbound — Mailgun happy path", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("MARKETPLACE_WEBHOOK_SECRET", VALID_SECRET);
    mockStorePdf.mockResolvedValue("gs://bucket/mailgun-report.pdf");
    mockRunExtraction.mockResolvedValue(undefined);
    mockDbQuery.mockResolvedValue({ rows: [] });
  });

  it("returns 202 for a Mailgun multipart payload with attachment-1 and recipient fields", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] }); // sha256 dedup
    mockDbQuery.mockResolvedValueOnce({ rows: [] }); // message-id dedup
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 200 }] }); // INSERT

    const res = await request(app)
      .post("/webhooks/marketplace-email/inbound")
      .set("x-marketplace-secret", VALID_SECRET)
      .field("recipient", MAILGUN_TO)
      .field("Message-Id", "<mailgun-msg-001@mg.presentail.com>")
      .attach("attachment-1", FAKE_PDF, { filename: "report.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ success: true, attachment_count: 1 });
    // Drain background work so it doesn't bleed into the next test
    await vi.waitFor(() => expect(mockRunExtraction).toHaveBeenCalledTimes(1));
  });

  it("creates an import record for a Mailgun payload with correct workspace_owner_id", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] }); // sha256 dedup
    mockDbQuery.mockResolvedValueOnce({ rows: [] }); // message-id dedup
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 201 }] }); // INSERT

    await request(app)
      .post("/webhooks/marketplace-email/inbound")
      .set("x-marketplace-secret", VALID_SECRET)
      .field("recipient", MAILGUN_TO)
      .field("Message-Id", "<mailgun-msg-002@mg.presentail.com>")
      .attach("attachment-1", FAKE_PDF, { filename: "report.pdf", contentType: "application/pdf" });

    await vi.waitFor(() => {
      expect(mockDbQuery).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO marketplace_report_imports"),
        expect.arrayContaining([OWNER_ID]),
      );
    });
    await vi.waitFor(() => expect(mockRunExtraction).toHaveBeenCalledTimes(1));
  });

  it("calls storePdfToObjectStorage with the correct buffer for a Mailgun payload", async () => {
    // No Message-Id field → no message-id dedup step, only sha256 dedup + INSERT
    mockDbQuery.mockResolvedValueOnce({ rows: [] }); // sha256 dedup
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 202 }] }); // INSERT

    await request(app)
      .post("/webhooks/marketplace-email/inbound")
      .set("x-marketplace-secret", VALID_SECRET)
      .field("recipient", MAILGUN_TO)
      .attach("attachment-1", FAKE_PDF, { filename: "report.pdf", contentType: "application/pdf" });

    await vi.waitFor(() => expect(mockStorePdf).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(mockRunExtraction).toHaveBeenCalledTimes(1));

    const [buf, , ownerId] = mockStorePdf.mock.calls[0] as [Buffer, string, string];
    expect(buf).toEqual(FAKE_PDF);
    expect(ownerId).toBe(OWNER_ID);
  });

  it("detects PDF by .pdf extension when mimetype is octet-stream (Mailgun)", async () => {
    // No Message-Id field → no message-id dedup step, only sha256 dedup + INSERT
    mockDbQuery.mockResolvedValueOnce({ rows: [] }); // sha256 dedup
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 203 }] }); // INSERT

    const res = await request(app)
      .post("/webhooks/marketplace-email/inbound")
      .set("x-marketplace-secret", VALID_SECRET)
      .field("recipient", MAILGUN_TO)
      .attach("attachment-1", FAKE_PDF, { filename: "toters-report.pdf", contentType: "application/octet-stream" });

    expect(res.status).toBe(202);
    expect(res.body.attachment_count).toBe(1);
    await vi.waitFor(() => expect(mockRunExtraction).toHaveBeenCalledTimes(1));
  });

  it("returns 200 with empty imports when Mailgun payload has no PDF file fields", async () => {
    const res = await request(app)
      .post("/webhooks/marketplace-email/inbound")
      .set("x-marketplace-secret", VALID_SECRET)
      .field("recipient", MAILGUN_TO)
      .field("subject", "No PDF here");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, imports: [] });
  });
});

// ---------------------------------------------------------------------------
// POST /webhooks/marketplace-email/inbound — Mailgun duplicate detection
// ---------------------------------------------------------------------------

describe("POST /webhooks/marketplace-email/inbound — Mailgun SHA-256 duplicate detection", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("MARKETPLACE_WEBHOOK_SECRET", VALID_SECRET);
    mockStorePdf.mockResolvedValue("gs://bucket/mailgun-report.pdf");
    mockRunExtraction.mockResolvedValue(undefined);
    mockDbQuery.mockResolvedValue({ rows: [] });
  });

  it("skips storage and INSERT when SHA-256 already exists (Mailgun)", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 55 }] }); // sha256 dup found
    mockDbQuery.mockResolvedValue({ rows: [] });

    await request(app)
      .post("/webhooks/marketplace-email/inbound")
      .set("x-marketplace-secret", VALID_SECRET)
      .field("recipient", MAILGUN_TO)
      .attach("attachment-1", FAKE_PDF, { filename: "report.pdf", contentType: "application/pdf" });

    await vi.waitFor(() => {
      expect(mockDbQuery).toHaveBeenCalledWith(
        expect.stringContaining("pdf_sha256"),
        expect.arrayContaining([OWNER_ID]),
      );
    });

    expect(mockStorePdf).not.toHaveBeenCalled();
    expect(mockDbQuery).not.toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO marketplace_report_imports"),
      expect.anything(),
    );
  });

  it("deduplicates by Message-Id when SHA-256 is new but message-ID matches (Mailgun)", async () => {
    const msgId = "<dup-mailgun-msg@mg.presentail.com>";
    mockDbQuery.mockResolvedValueOnce({ rows: [] }); // sha256 not a dup
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 66 }] }); // message-id dup found
    mockDbQuery.mockResolvedValue({ rows: [] });

    await request(app)
      .post("/webhooks/marketplace-email/inbound")
      .set("x-marketplace-secret", VALID_SECRET)
      .field("recipient", MAILGUN_TO)
      .field("Message-Id", msgId)
      .attach("attachment-1", FAKE_PDF, { filename: "report.pdf", contentType: "application/pdf" });

    await vi.waitFor(() => {
      expect(mockDbQuery).toHaveBeenCalledWith(
        expect.stringContaining("email_message_id"),
        expect.arrayContaining([OWNER_ID, msgId]),
      );
    });

    expect(mockStorePdf).not.toHaveBeenCalled();
    expect(mockDbQuery).not.toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO marketplace_report_imports"),
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// POST /webhooks/marketplace-email/inbound — SendGrid multipart format
// ---------------------------------------------------------------------------

const SENDGRID_ENVELOPE = JSON.stringify({
  to: [`marketplace-reports+${OWNER_ID}@inbound.presentail.com`],
  from: "sender@toters.com",
});

describe("POST /webhooks/marketplace-email/inbound — SendGrid 401 secret validation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("MARKETPLACE_WEBHOOK_SECRET", VALID_SECRET);
    mockDbQuery.mockResolvedValue({ rows: [] });
  });

  it("returns 401 when no secret header is provided (SendGrid)", async () => {
    const res = await request(app)
      .post("/webhooks/marketplace-email/inbound")
      .field("envelope", SENDGRID_ENVELOPE)
      .attach("attachment1", FAKE_PDF, { filename: "report.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ success: false });
  });

  it("returns 401 when wrong secret is provided (SendGrid)", async () => {
    const res = await request(app)
      .post("/webhooks/marketplace-email/inbound")
      .set("x-marketplace-secret", "bad-secret")
      .field("envelope", SENDGRID_ENVELOPE)
      .attach("attachment1", FAKE_PDF, { filename: "report.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ success: false });
  });
});

describe("POST /webhooks/marketplace-email/inbound — SendGrid 400 unresolvable workspace", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("MARKETPLACE_WEBHOOK_SECRET", VALID_SECRET);
    mockDbQuery.mockResolvedValue({ rows: [] });
  });

  it("returns 400 when envelope field is absent (SendGrid)", async () => {
    const res = await request(app)
      .post("/webhooks/marketplace-email/inbound")
      .set("x-marketplace-secret", VALID_SECRET)
      .field("subject", "Report")
      .attach("attachment1", FAKE_PDF, { filename: "report.pdf", contentType: "application/pdf" });

    // Without an envelope field, the route falls through to Mailgun parser;
    // no recipient field → workspace ID unresolvable → 400
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false });
    expect(res.body.error).toMatch(/workspace/i);
  });

  it("returns 400 when envelope.to has no marketplace+ sub-address (SendGrid)", async () => {
    const badEnvelope = JSON.stringify({ to: ["unknown@inbound.presentail.com"], from: "sender@toters.com" });

    const res = await request(app)
      .post("/webhooks/marketplace-email/inbound")
      .set("x-marketplace-secret", VALID_SECRET)
      .field("envelope", badEnvelope)
      .attach("attachment1", FAKE_PDF, { filename: "report.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false });
    expect(res.body.error).toMatch(/workspace/i);
  });
});

describe("POST /webhooks/marketplace-email/inbound — SendGrid happy path", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("MARKETPLACE_WEBHOOK_SECRET", VALID_SECRET);
    mockStorePdf.mockResolvedValue("gs://bucket/sendgrid-report.pdf");
    mockRunExtraction.mockResolvedValue(undefined);
    mockDbQuery.mockResolvedValue({ rows: [] });
  });

  it("returns 202 for a SendGrid multipart payload with attachment1 and envelope fields", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] }); // sha256 dedup
    mockDbQuery.mockResolvedValueOnce({ rows: [] }); // message-id dedup
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 300 }] }); // INSERT

    const res = await request(app)
      .post("/webhooks/marketplace-email/inbound")
      .set("x-marketplace-secret", VALID_SECRET)
      .field("envelope", SENDGRID_ENVELOPE)
      .field("headers", "Message-ID: <sendgrid-msg-001@sendgrid.net>\nSubject: Report")
      .attach("attachment1", FAKE_PDF, { filename: "report.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ success: true, attachment_count: 1 });
    await vi.waitFor(() => expect(mockRunExtraction).toHaveBeenCalledTimes(1));
  });

  it("creates an import record for a SendGrid payload with correct workspace_owner_id", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] }); // sha256 dedup
    mockDbQuery.mockResolvedValueOnce({ rows: [] }); // message-id dedup
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 301 }] }); // INSERT

    await request(app)
      .post("/webhooks/marketplace-email/inbound")
      .set("x-marketplace-secret", VALID_SECRET)
      .field("envelope", SENDGRID_ENVELOPE)
      .field("headers", "Message-ID: <sendgrid-msg-002@sendgrid.net>\nSubject: Report")
      .attach("attachment1", FAKE_PDF, { filename: "report.pdf", contentType: "application/pdf" });

    await vi.waitFor(() => {
      expect(mockDbQuery).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO marketplace_report_imports"),
        expect.arrayContaining([OWNER_ID]),
      );
    });
    await vi.waitFor(() => expect(mockRunExtraction).toHaveBeenCalledTimes(1));
  });

  it("parses Message-ID from the SendGrid headers field and stores it on the import", async () => {
    const msgId = "<sendgrid-msg-003@sendgrid.net>";
    mockDbQuery.mockResolvedValueOnce({ rows: [] }); // sha256 dedup
    mockDbQuery.mockResolvedValueOnce({ rows: [] }); // message-id dedup
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 302 }] }); // INSERT

    await request(app)
      .post("/webhooks/marketplace-email/inbound")
      .set("x-marketplace-secret", VALID_SECRET)
      .field("envelope", SENDGRID_ENVELOPE)
      .field("headers", `Message-ID: ${msgId}\nSubject: Report`)
      .attach("attachment1", FAKE_PDF, { filename: "report.pdf", contentType: "application/pdf" });

    await vi.waitFor(() => {
      expect(mockDbQuery).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO marketplace_report_imports"),
        expect.arrayContaining([msgId]),
      );
    });
    await vi.waitFor(() => expect(mockRunExtraction).toHaveBeenCalledTimes(1));
  });

  it("detects SendGrid vs Mailgun by the presence of the envelope field", async () => {
    // If envelope is present, parseSendGrid is called (not parseMailgun);
    // without headers field, there's no message-id dedup — only sha256 check + INSERT
    mockDbQuery.mockResolvedValueOnce({ rows: [] }); // sha256 dedup
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 303 }] }); // INSERT

    const res = await request(app)
      .post("/webhooks/marketplace-email/inbound")
      .set("x-marketplace-secret", VALID_SECRET)
      .field("envelope", SENDGRID_ENVELOPE)
      .attach("attachment1", FAKE_PDF, { filename: "report.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(mockRunExtraction).toHaveBeenCalledTimes(1));
  });

  it("returns 200 with empty imports when SendGrid payload has no PDF file fields", async () => {
    const res = await request(app)
      .post("/webhooks/marketplace-email/inbound")
      .set("x-marketplace-secret", VALID_SECRET)
      .field("envelope", SENDGRID_ENVELOPE)
      .field("subject", "No PDF here");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, imports: [] });
  });
});

// ---------------------------------------------------------------------------
// POST /webhooks/marketplace-email/inbound — SendGrid duplicate detection
// ---------------------------------------------------------------------------

describe("POST /webhooks/marketplace-email/inbound — SendGrid SHA-256 duplicate detection", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("MARKETPLACE_WEBHOOK_SECRET", VALID_SECRET);
    mockStorePdf.mockResolvedValue("gs://bucket/sendgrid-report.pdf");
    mockRunExtraction.mockResolvedValue(undefined);
    mockDbQuery.mockResolvedValue({ rows: [] });
  });

  it("skips storage and INSERT when SHA-256 already exists (SendGrid)", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 77 }] }); // sha256 dup found
    mockDbQuery.mockResolvedValue({ rows: [] });

    await request(app)
      .post("/webhooks/marketplace-email/inbound")
      .set("x-marketplace-secret", VALID_SECRET)
      .field("envelope", SENDGRID_ENVELOPE)
      .attach("attachment1", FAKE_PDF, { filename: "report.pdf", contentType: "application/pdf" });

    await vi.waitFor(() => {
      expect(mockDbQuery).toHaveBeenCalledWith(
        expect.stringContaining("pdf_sha256"),
        expect.arrayContaining([OWNER_ID]),
      );
    });

    expect(mockStorePdf).not.toHaveBeenCalled();
    expect(mockDbQuery).not.toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO marketplace_report_imports"),
      expect.anything(),
    );
  });

  it("deduplicates by Message-ID header when SHA-256 is new but message-ID matches (SendGrid)", async () => {
    const msgId = "<dup-sendgrid-msg@sendgrid.net>";
    mockDbQuery.mockResolvedValueOnce({ rows: [] }); // sha256 not a dup
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 88 }] }); // message-id dup found
    mockDbQuery.mockResolvedValue({ rows: [] });

    await request(app)
      .post("/webhooks/marketplace-email/inbound")
      .set("x-marketplace-secret", VALID_SECRET)
      .field("envelope", SENDGRID_ENVELOPE)
      .field("headers", `Message-ID: ${msgId}\nSubject: Report`)
      .attach("attachment1", FAKE_PDF, { filename: "report.pdf", contentType: "application/pdf" });

    await vi.waitFor(() => {
      expect(mockDbQuery).toHaveBeenCalledWith(
        expect.stringContaining("email_message_id"),
        expect.arrayContaining([OWNER_ID, msgId]),
      );
    });

    expect(mockStorePdf).not.toHaveBeenCalled();
    expect(mockDbQuery).not.toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO marketplace_report_imports"),
      expect.anything(),
    );
  });
});
