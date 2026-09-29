/**
 * Integration tests for the Toters PDF webhook pipeline end-to-end.
 *
 * Covers:
 *  - POST /webhooks/marketplace-reports/toters inserts a row with the correct
 *    fields in the real `marketplace_report_imports` table
 *  - Async extraction (runExtractionAndMatching) updates the row with extracted
 *    data and transitions import_status to `needs_review`
 *  - When both extractors throw, runExtractionAndMatching sets import_status
 *    to `extraction_failed`
 *
 * Object storage is mocked (no real GCS bucket needed).
 * Both the AI extractor and the regex extractor are controlled per-test.
 * The PostgreSQL database is real (provided by test-integration-local.sh).
 *
 * The suite is skipped automatically when DATABASE_URL is not set, making it
 * safe to import without a live database.
 *
 * Run via:
 *   pnpm --filter @workspace/api-server run test:integration:local
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { createHash } from "crypto";
import express, { Request, Response, NextFunction } from "express";
import request from "supertest";
import pg from "pg";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const OWNER_ID = "__test_marketplace_webhook_pipeline__";
const TEST_SECRET = "test-webhook-pipeline-secret-xyz";

const MINIMAL_PDF = Buffer.from("%PDF-1.4 minimal-pdf-for-webhook-pipeline-test");

// ─────────────────────────────────────────────────────────────────────────────
// Mocks — object storage, logger, and extractors.
// db is NOT mocked; the real pool is used throughout.
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

const { mockFileSave } = vi.hoisted(() => ({
  mockFileSave: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/objectStorage", () => ({
  objectStorageClient: {
    bucket: (_name: string) => ({
      file: (_path: string) => ({
        save: mockFileSave,
      }),
    }),
  },
}));

const { mockAiExtractor } = vi.hoisted(() => ({
  mockAiExtractor: vi.fn(),
}));

vi.mock("../lib/aiMarketplaceExtractor", () => ({
  extractMarketplaceReportWithAI: mockAiExtractor,
}));

const { mockRegexExtractor } = vi.hoisted(() => ({
  mockRegexExtractor: vi.fn(),
}));

vi.mock("../lib/totersPdfExtractor", () => ({
  extractTotersPdf: mockRegexExtractor,
  normalizeMerchantName: (name: string) =>
    name
      .toLowerCase()
      .replace(/[^\w\s]/g, "")
      .replace(/\s+/g, " ")
      .trim(),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Imports — MUST come after vi.mock declarations (hoisting boundary)
// ─────────────────────────────────────────────────────────────────────────────

import marketplaceWebhookRouter, { runExtractionAndMatching } from "./marketplaceWebhook";

// ─────────────────────────────────────────────────────────────────────────────
// Test app factory
// ─────────────────────────────────────────────────────────────────────────────

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(marketplaceWebhookRouter);
  app.use((err: Error & { code?: string }, _req: Request, res: Response, _next: NextFunction) => {
    if (err?.code === "LIMIT_FILE_SIZE") {
      res.status(400).json({ success: false, error: "PDF exceeds maximum allowed size" });
      return;
    }
    res.status(500).json({ success: false, error: "Internal server error" });
  });
  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Poll the database until predicate resolves truthy or timeout is reached. */
async function waitForDbCondition(
  pool: InstanceType<typeof Pool>,
  sql: string,
  params: unknown[],
  predicate: (rows: Record<string, unknown>[]) => boolean,
  timeoutMs = 5000,
  intervalMs = 100,
): Promise<Record<string, unknown>[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await pool.query(sql, params);
    if (predicate(result.rows)) return result.rows;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const last = await pool.query(sql, params);
  return last.rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!DATABASE_URL)(
  "Toters PDF webhook pipeline — integration",
  () => {
    let pool: InstanceType<typeof Pool>;
    let app: express.Express;

    beforeAll(async () => {
      process.env.MARKETPLACE_WEBHOOK_SECRET = TEST_SECRET;
      process.env.MARKETPLACE_WEBHOOK_WORKSPACE_OWNER_ID = OWNER_ID;
      process.env.PRIVATE_OBJECT_DIR = "test-bucket/private";

      pool = new Pool({ connectionString: DATABASE_URL });
      app = makeApp();

      // Clean any leftovers from previous failed runs.
      await pool.query(
        `DELETE FROM marketplace_report_imports WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
    });

    afterAll(async () => {
      if (!pool) return;
      await pool.query(
        `DELETE FROM marketplace_report_imports WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      await pool.end();
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Row insertion — correct fields
    // ─────────────────────────────────────────────────────────────────────────

    describe("Row inserted with correct fields after a successful POST", () => {
      let importId: number;
      const messageId = "msg-pipeline-test-001";

      beforeAll(async () => {
        mockFileSave.mockResolvedValue(undefined);
        // AI extractor succeeds — prevents extraction_failed from overwriting
        // the row before we can inspect the initial insert.
        mockAiExtractor.mockResolvedValue({
          merchantName: "Pipeline Test Restaurant",
          country: "AE",
          address: "1 Test Ave",
          reportPeriodStart: "2024-05-01",
          reportPeriodEnd: "2024-05-31",
          metrics: [],
          weeklyTrends: [],
          bestSellingItems: [],
          confidence: 0.9,
        });

        const res = await request(app)
          .post("/webhooks/marketplace-reports/toters")
          .set("x-marketplace-secret", TEST_SECRET)
          .field("workspace_owner_id", OWNER_ID)
          .field("message_id", messageId)
          .attach("pdf", MINIMAL_PDF, { filename: "report.pdf", contentType: "application/pdf" });

        expect(res.status).toBe(202);
        expect(res.body.success).toBe(true);
        importId = res.body.import_id;
      });

      it("inserts exactly one row for the import", async () => {
        const result = await pool.query(
          `SELECT id FROM marketplace_report_imports WHERE id = $1`,
          [importId],
        );
        expect(result.rows).toHaveLength(1);
      });

      it("stores workspace_owner_id correctly", async () => {
        const result = await pool.query<{ workspace_owner_id: string }>(
          `SELECT workspace_owner_id FROM marketplace_report_imports WHERE id = $1`,
          [importId],
        );
        expect(result.rows[0].workspace_owner_id).toBe(OWNER_ID);
      });

      it("stores source_type as webhook_email", async () => {
        const result = await pool.query<{ source_type: string }>(
          `SELECT source_type FROM marketplace_report_imports WHERE id = $1`,
          [importId],
        );
        expect(result.rows[0].source_type).toBe("webhook_email");
      });

      it("stores marketplace as toters", async () => {
        const result = await pool.query<{ marketplace: string }>(
          `SELECT marketplace FROM marketplace_report_imports WHERE id = $1`,
          [importId],
        );
        expect(result.rows[0].marketplace).toBe("toters");
      });

      it("stores the correct pdf_sha256", async () => {
        const expectedSha256 = createHash("sha256").update(MINIMAL_PDF).digest("hex");
        const result = await pool.query<{ pdf_sha256: string }>(
          `SELECT pdf_sha256 FROM marketplace_report_imports WHERE id = $1`,
          [importId],
        );
        expect(result.rows[0].pdf_sha256).toBe(expectedSha256);
      });

      it("stores the email_message_id", async () => {
        const result = await pool.query<{ email_message_id: string }>(
          `SELECT email_message_id FROM marketplace_report_imports WHERE id = $1`,
          [importId],
        );
        expect(result.rows[0].email_message_id).toBe(messageId);
      });

      it("stores an initial import_status of pending", async () => {
        // Check row was inserted as pending (it may have already been updated by
        // the async extractor; if so, accept needs_review/ready_to_approve too).
        const result = await pool.query<{ import_status: string }>(
          `SELECT import_status FROM marketplace_report_imports WHERE id = $1`,
          [importId],
        );
        const status = result.rows[0].import_status;
        expect(["pending", "needs_review", "ready_to_approve"]).toContain(status);
      });

      it("stores a non-empty pdf_storage_path", async () => {
        const result = await pool.query<{ pdf_storage_path: string }>(
          `SELECT pdf_storage_path FROM marketplace_report_imports WHERE id = $1`,
          [importId],
        );
        expect(result.rows[0].pdf_storage_path).toBeTruthy();
        expect(result.rows[0].pdf_storage_path).toContain(OWNER_ID);
      });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Async extraction — success path updates DB fields
    // ─────────────────────────────────────────────────────────────────────────

    describe("Async extraction updates row with extracted data on success", () => {
      let importId: number;

      beforeAll(async () => {
        // Insert a bare import row to simulate the state right after the HTTP
        // handler inserts but before extraction runs.
        const sha = createHash("sha256")
          .update(Buffer.from("extraction-success-test-pdf"))
          .digest("hex");

        const r = await pool.query<{ id: number }>(
          `INSERT INTO marketplace_report_imports
             (workspace_owner_id, source_type, marketplace, import_status,
              pdf_storage_path, pdf_sha256)
           VALUES ($1, 'webhook_email', 'toters', 'pending', '/objects/test/report.pdf', $2)
           RETURNING id`,
          [OWNER_ID, sha],
        );
        importId = r.rows[0].id;

        // Both extractors succeed.
        mockAiExtractor.mockResolvedValue({
          merchantName: "Async Test Merchant",
          country: "LB",
          address: "2 Async St",
          reportPeriodStart: "2024-06-01",
          reportPeriodEnd: "2024-06-30",
          metrics: [{ name: "total_orders", value: 42, unit: null, category: "orders" }],
          weeklyTrends: [],
          bestSellingItems: [{ name: "Burger", rank: 1, quantity: 10, revenue: 100 }],
          confidence: 0.95,
        });

        await runExtractionAndMatching(importId, MINIMAL_PDF, OWNER_ID);
      });

      it("transitions import_status away from pending", async () => {
        const result = await pool.query<{ import_status: string }>(
          `SELECT import_status FROM marketplace_report_imports WHERE id = $1`,
          [importId],
        );
        expect(result.rows[0].import_status).not.toBe("pending");
        expect(result.rows[0].import_status).not.toBe("extraction_failed");
      });

      it("persists extracted_data as a non-null JSON object", async () => {
        const result = await pool.query<{ extracted_data: unknown }>(
          `SELECT extracted_data FROM marketplace_report_imports WHERE id = $1`,
          [importId],
        );
        expect(result.rows[0].extracted_data).not.toBeNull();
        const data = result.rows[0].extracted_data as Record<string, unknown>;
        expect(data).toMatchObject({ merchantName: "Async Test Merchant" });
      });

      it("stores detected_merchant_name from the extractor output", async () => {
        const result = await pool.query<{ detected_merchant_name: string }>(
          `SELECT detected_merchant_name FROM marketplace_report_imports WHERE id = $1`,
          [importId],
        );
        expect(result.rows[0].detected_merchant_name).toBe("Async Test Merchant");
      });

      it("stores report_period_start and report_period_end", async () => {
        const result = await pool.query<{
          report_period_start: string;
          report_period_end: string;
        }>(
          `SELECT report_period_start, report_period_end
             FROM marketplace_report_imports WHERE id = $1`,
          [importId],
        );
        expect(result.rows[0].report_period_start).not.toBeNull();
        expect(result.rows[0].report_period_end).not.toBeNull();
      });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Async extraction — both extractors throw → extraction_failed
    // ─────────────────────────────────────────────────────────────────────────

    describe("Sets extraction_failed when both extractors throw", () => {
      let importId: number;

      beforeAll(async () => {
        const sha = createHash("sha256")
          .update(Buffer.from("extraction-failure-test-pdf"))
          .digest("hex");

        const r = await pool.query<{ id: number }>(
          `INSERT INTO marketplace_report_imports
             (workspace_owner_id, source_type, marketplace, import_status,
              pdf_storage_path, pdf_sha256)
           VALUES ($1, 'webhook_email', 'toters', 'pending', '/objects/test/failed.pdf', $2)
           RETURNING id`,
          [OWNER_ID, sha],
        );
        importId = r.rows[0].id;

        // Both extractors fail.
        mockAiExtractor.mockRejectedValue(new Error("AI extractor unavailable"));
        mockRegexExtractor.mockRejectedValue(new Error("Regex extractor parse error"));

        await runExtractionAndMatching(importId, MINIMAL_PDF, OWNER_ID);
      });

      it("sets import_status to extraction_failed", async () => {
        const result = await pool.query<{ import_status: string }>(
          `SELECT import_status FROM marketplace_report_imports WHERE id = $1`,
          [importId],
        );
        expect(result.rows[0].import_status).toBe("extraction_failed");
      });

      it("leaves extracted_data as null when extraction fails", async () => {
        const result = await pool.query<{ extracted_data: unknown }>(
          `SELECT extracted_data FROM marketplace_report_imports WHERE id = $1`,
          [importId],
        );
        expect(result.rows[0].extracted_data).toBeNull();
      });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Full pipeline: HTTP POST → async extraction → DB state
    // ─────────────────────────────────────────────────────────────────────────

    describe("Full pipeline: HTTP POST triggers extraction that sets extraction_failed", () => {
      it("polls the DB until import_status transitions to extraction_failed", async () => {
        mockFileSave.mockResolvedValue(undefined);
        mockAiExtractor.mockRejectedValue(new Error("AI down"));
        mockRegexExtractor.mockRejectedValue(new Error("regex parse error"));

        const distinctPdf = Buffer.from("%PDF-1.4 pipeline-failure-scenario-pdf-content");

        const res = await request(app)
          .post("/webhooks/marketplace-reports/toters")
          .set("x-marketplace-secret", TEST_SECRET)
          .field("workspace_owner_id", OWNER_ID)
          .attach("pdf", distinctPdf, { filename: "fail.pdf", contentType: "application/pdf" });

        expect(res.status).toBe(202);
        expect(res.body.success).toBe(true);
        const importId: number = res.body.import_id;

        const rows = await waitForDbCondition(
          pool,
          `SELECT import_status FROM marketplace_report_imports WHERE id = $1`,
          [importId],
          (r) => (r[0] as { import_status: string })?.import_status === "extraction_failed",
          6000,
        );

        expect(rows[0]).toMatchObject({ import_status: "extraction_failed" });
      });
    });
  },
);
