/**
 * Integration tests for the marketplace report routes.
 *
 * Covers:
 *  - POST /webhooks/marketplace-reports/toters  (secret validation, SHA-256 + message-id
 *    duplicate detection, happy-path import creation)
 *  - POST /api/brands/:brandId/marketplace-reports/imports/manual  (manual upload,
 *    duplicate detection)
 *  - GET  /api/brands/:brandId/marketplace-report-imports
 *  - GET  /api/marketplace-report-imports/:importId
 *  - PATCH /api/marketplace-report-imports/:importId  (field updates, approved guard)
 *  - POST /api/marketplace-report-imports/:importId/match-products  (fuzzy matching)
 *  - POST /api/marketplace-report-imports/:importId/approve  (happy path, missing-brand
 *    guard, missing-period guard, already-approved guard, duplicate-period guard)
 *  - GET  /api/marketplace-reports/:reportId  (full detail with metrics/trends/items)
 *
 * Auth and workspace middleware are stubbed so the test does not need real Clerk
 * credentials.  The PDF extractor and object-storage client are also mocked.
 * Everything else — including the PostgreSQL database — is real.
 *
 * The suite is skipped automatically when DATABASE_URL is not set, making it
 * safe to run in CI without a live database.
 *
 * Run via:
 *   pnpm --filter @workspace/api-server run test:integration:local
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import pg from "pg";
import type { WorkspaceRequest } from "../lib/workspace";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const OWNER_ID = "__test_marketplace_reports_integration__";
const OTHER_OWNER_ID = "__test_marketplace_reports_integration_other__";
const TEST_SECRET = "test-marketplace-secret-abc123";

const FAKE_PDF = Buffer.from("%PDF-1.4 fake pdf content for testing purposes");
const FAKE_PDF_2 = Buffer.from("%PDF-1.4 second distinct fake pdf content");

// ─────────────────────────────────────────────────────────────────────────────
// Mocks — auth / workspace / logger / object storage / PDF extractor
// db is NOT mocked; the real pool is used throughout.
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
  authed: (req: express.Request) => req,
}));

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    const wreq = req as unknown as WorkspaceRequest;
    const workspaceOwnerId = req.header("x-test-workspace-owner") ?? OWNER_ID;
    const workspaceRole = req.header("x-test-workspace-role") === "member" ? "member" : "owner";
    wreq.workspaceOwnerId = workspaceOwnerId;
    wreq.workspaceRole = workspaceRole;
    wreq.workspaceActualRole = workspaceRole;
    wreq.userId = "__test_mp_user__";
    wreq.userEmail = "mp-test@example.com";
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

const { mockFileSave, mockGetObjectEntityFile, mockDownloadObject } = vi.hoisted(() => ({
  mockFileSave: vi.fn().mockResolvedValue(undefined),
  mockGetObjectEntityFile: vi.fn(),
  mockDownloadObject: vi.fn(),
}));
vi.mock("../lib/objectStorage", () => ({
  objectStorageClient: {
    bucket: (_name: string) => ({
      file: (_path: string) => ({
        save: mockFileSave,
      }),
    }),
  },
  ObjectStorageService: class MockObjectStorageService {
    getReadStream = vi.fn();
    getObjectEntityFile = mockGetObjectEntityFile;
    downloadObject = mockDownloadObject;
  },
  ObjectNotFoundError: class ObjectNotFoundError extends Error {},
}));

const { mockExtractMarketplaceReportWithAI } = vi.hoisted(() => ({
  mockExtractMarketplaceReportWithAI: vi.fn(),
}));
vi.mock("../lib/aiMarketplaceExtractor", () => ({
  extractMarketplaceReportWithAI: mockExtractMarketplaceReportWithAI,
}));

vi.mock("../lib/totersPdfExtractor", () => ({
  extractTotersPdf: vi.fn().mockResolvedValue({
    merchantName: "Test Restaurant",
    country: "AE",
    address: "123 Test St",
    reportPeriodStart: "2024-01-01",
    reportPeriodEnd: "2024-01-31",
    metrics: [
      { name: "Total Revenue", value: 5000, unit: "AED", category: "revenue" },
      { name: "Total Orders", value: 120, unit: null, category: "orders" },
    ],
    weeklyTrends: [
      { weekLabel: "Week 1", weekStart: "2024-01-01", value: 1200, metricName: "revenue" },
      { weekLabel: "Week 2", weekStart: "2024-01-08", value: 1500, metricName: "revenue" },
    ],
    bestSellingItems: [
      { name: "Chicken Burger", rank: 1, quantity: 50, revenue: 500 },
      { name: "Cheese Pizza", rank: 2, quantity: 40, revenue: 400 },
    ],
  }),
  normalizeMerchantName: (name: string) =>
    name
      .toLowerCase()
      .replace(/\b(restaurant|cafe|kitchen|grill)\b/gi, "")
      .replace(/[^\w\s]/g, "")
      .replace(/\s+/g, " ")
      .trim(),
  levenshteinSimilarity: (a: string, b: string): number => {
    if (a === b) return 1;
    const la = a.length;
    const lb = b.length;
    if (la === 0 || lb === 0) return 0;
    const dp: number[][] = Array.from({ length: la + 1 }, (_, i) =>
      Array.from({ length: lb + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
    );
    for (let i = 1; i <= la; i++) {
      for (let j = 1; j <= lb; j++) {
        dp[i][j] =
          a[i - 1] === b[j - 1]
            ? dp[i - 1][j - 1]
            : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
    return 1 - dp[la][lb] / Math.max(la, lb);
  },
}));

// ─────────────────────────────────────────────────────────────────────────────
// Imports — MUST come after vi.mock declarations (hoisting boundary)
// ─────────────────────────────────────────────────────────────────────────────

import marketplaceWebhookRouter, { runExtractionAndMatching } from "./marketplaceWebhook";
import * as webhookModule from "./marketplaceWebhook";
import marketplaceReportsRouter from "./marketplaceReports";

// ─────────────────────────────────────────────────────────────────────────────
// Test app factory
// ─────────────────────────────────────────────────────────────────────────────

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(marketplaceWebhookRouter);
  app.use(marketplaceReportsRouter);
  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!DATABASE_URL)(
  "Marketplace report routes — integration",
  () => {
    let pool: InstanceType<typeof Pool>;
    let app: express.Express;
    let brandId: number;
    let productId: number;

    // IDs shared across nested describes (set by earlier tests)
    let webhookImportId: number;
    let manualImportId: number;
    let approvableImportId: number;
    let approvedReportId: number;

    beforeAll(async () => {
      process.env.MARKETPLACE_WEBHOOK_SECRET = TEST_SECRET;
      process.env.MARKETPLACE_WEBHOOK_WORKSPACE_OWNER_ID = OWNER_ID;
      process.env.PRIVATE_OBJECT_DIR = "test-bucket/private";

      // Default: AI extractor succeeds with the same shape as the regex mock.
      mockExtractMarketplaceReportWithAI.mockResolvedValue({
        merchantName: "Test Restaurant",
        country: "AE",
        address: "123 Test St",
        reportPeriodStart: "2024-01-01",
        reportPeriodEnd: "2024-01-31",
        metrics: [
          { name: "Total Revenue", value: 5000, unit: "AED", category: "revenue" },
          { name: "Total Orders", value: 120, unit: null, category: "orders" },
        ],
        weeklyTrends: [
          { weekLabel: "Week 1", weekStart: "2024-01-01", value: 1200, metricName: "revenue" },
          { weekLabel: "Week 2", weekStart: "2024-01-08", value: 1500, metricName: "revenue" },
        ],
        bestSellingItems: [
          { name: "Chicken Burger", rank: 1, quantity: 50, revenue: 500 },
          { name: "Cheese Pizza", rank: 2, quantity: 40, revenue: 400 },
        ],
        confidence: 0.92,
      });

      pool = new Pool({ connectionString: DATABASE_URL });
      app = makeApp();

      // ── Cleanup any leftovers from previous failed runs ───────────────────
      await pool.query(
        `DELETE FROM marketplace_report_items
           WHERE report_id IN (
             SELECT id FROM marketplace_reports WHERE workspace_owner_id = $1
           )`,
        [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM marketplace_report_weekly_trends
           WHERE report_id IN (
             SELECT id FROM marketplace_reports WHERE workspace_owner_id = $1
           )`,
        [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM marketplace_report_metrics
           WHERE report_id IN (
             SELECT id FROM marketplace_reports WHERE workspace_owner_id = $1
           )`,
        [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM marketplace_reports WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM marketplace_report_imports WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM marketplace_brand_aliases WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      await pool.query(`DELETE FROM products WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM brands WHERE workspace_owner_id = $1`, [OWNER_ID]);

      // ── Seed a brand ──────────────────────────────────────────────────────
      const brandResult = await pool.query<{ id: number }>(
        `INSERT INTO brands (workspace_owner_id, name)
         VALUES ($1, $2)
         RETURNING id`,
        [OWNER_ID, "Test Restaurant"],
      );
      brandId = brandResult.rows[0].id;

      // ── Seed a product linked to the brand ───────────────────────────────
      const productResult = await pool.query<{ id: number }>(
        `INSERT INTO products (workspace_owner_id, name, brand, is_archived)
         VALUES ($1, $2, $3, false)
         RETURNING id`,
        [OWNER_ID, "Chicken Burger", "Test Restaurant"],
      );
      productId = productResult.rows[0].id;
    });

    afterAll(async () => {
      if (!pool) return;
      await pool.query(
        `DELETE FROM marketplace_report_items
           WHERE report_id IN (
             SELECT id FROM marketplace_reports WHERE workspace_owner_id = $1
           )`,
        [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM marketplace_report_weekly_trends
           WHERE report_id IN (
             SELECT id FROM marketplace_reports WHERE workspace_owner_id = $1
           )`,
        [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM marketplace_report_metrics
           WHERE report_id IN (
             SELECT id FROM marketplace_reports WHERE workspace_owner_id = $1
           )`,
        [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM marketplace_reports WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM marketplace_report_imports WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM marketplace_brand_aliases WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      await pool.query(`DELETE FROM products WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM brands WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.end();
    });

    // ─────────────────────────────────────────────────────────────────────────
    // POST /webhooks/marketplace-reports/toters
    // ─────────────────────────────────────────────────────────────────────────

    describe("POST /webhooks/marketplace-reports/toters", () => {
      it("returns 401 when the secret header is missing", async () => {
        const res = await request(app)
          .post("/webhooks/marketplace-reports/toters")
          .field("workspace_owner_id", OWNER_ID)
          .attach("pdf", FAKE_PDF, { filename: "report.pdf", contentType: "application/pdf" });

        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/invalid or missing webhook secret/i);
      });

      it("returns 401 when the secret is wrong", async () => {
        const res = await request(app)
          .post("/webhooks/marketplace-reports/toters")
          .set("x-marketplace-secret", "wrong-secret")
          .field("workspace_owner_id", OWNER_ID)
          .attach("pdf", FAKE_PDF, { filename: "report.pdf", contentType: "application/pdf" });

        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
      });

      it("returns 400 when workspace_owner_id is missing", async () => {
        const res = await request(app)
          .post("/webhooks/marketplace-reports/toters")
          .set("x-marketplace-secret", TEST_SECRET)
          .attach("pdf", FAKE_PDF, { filename: "report.pdf", contentType: "application/pdf" });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/workspace_owner_id is required/i);
      });

      it("returns 400 when PDF file is missing", async () => {
        const res = await request(app)
          .post("/webhooks/marketplace-reports/toters")
          .set("x-marketplace-secret", TEST_SECRET)
          .field("workspace_owner_id", OWNER_ID);

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/pdf file is required/i);
      });

      it("accepts a valid PDF and returns 202 with an import_id", async () => {
        const res = await request(app)
          .post("/webhooks/marketplace-reports/toters")
          .set("x-marketplace-secret", TEST_SECRET)
          .field("workspace_owner_id", OWNER_ID)
          .field("message_id", "msg-unique-001")
          .attach("pdf", FAKE_PDF, { filename: "report.pdf", contentType: "application/pdf" });

        expect(res.status).toBe(202);
        expect(res.body.success).toBe(true);
        expect(typeof res.body.import_id).toBe("number");
        webhookImportId = res.body.import_id;

        // Verify the row was actually inserted in the DB.
        const row = await pool.query<{ import_status: string; source_type: string }>(
          `SELECT import_status, source_type FROM marketplace_report_imports WHERE id = $1`,
          [webhookImportId],
        );
        expect(row.rows).toHaveLength(1);
        expect(row.rows[0].source_type).toBe("webhook_email");
      });

      it("detects SHA-256 duplicates and returns 200 with duplicate:true", async () => {
        const res = await request(app)
          .post("/webhooks/marketplace-reports/toters")
          .set("x-marketplace-secret", TEST_SECRET)
          .field("workspace_owner_id", OWNER_ID)
          .field("message_id", "msg-unique-002")
          .attach("pdf", FAKE_PDF, { filename: "report.pdf", contentType: "application/pdf" });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.duplicate).toBe(true);
        expect(res.body.existing_import_id).toBe(webhookImportId);
      });

      it("detects email_message_id duplicates even for a different PDF buffer", async () => {
        const res = await request(app)
          .post("/webhooks/marketplace-reports/toters")
          .set("x-marketplace-secret", TEST_SECRET)
          .field("workspace_owner_id", OWNER_ID)
          .field("message_id", "msg-unique-001")
          .attach("pdf", FAKE_PDF_2, { filename: "report2.pdf", contentType: "application/pdf" });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.duplicate).toBe(true);
      });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // POST /brands/:brandId/marketplace-reports/imports/manual
    // ─────────────────────────────────────────────────────────────────────────

    describe("POST /brands/:brandId/marketplace-reports/imports/manual", () => {
      it("returns 404 for an unknown brand", async () => {
        const res = await request(app)
          .post(`/brands/99999999/marketplace-reports/imports/manual`)
          .attach("pdf", FAKE_PDF_2, { filename: "report.pdf", contentType: "application/pdf" });

        expect(res.status).toBe(404);
        expect(res.body.error).toMatch(/brand not found/i);
      });

      it("returns 400 when PDF file is missing", async () => {
        const res = await request(app)
          .post(`/brands/${brandId}/marketplace-reports/imports/manual`)
          .field("marketplace", "toters");

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/pdf file is required/i);
      });

      it("creates a manual import and returns 201 with an import_id", async () => {
        const res = await request(app)
          .post(`/brands/${brandId}/marketplace-reports/imports/manual`)
          .field("marketplace", "toters")
          .field("report_period_start", "2024-02-01")
          .field("report_period_end", "2024-02-29")
          .field("notes", "manual test upload")
          .attach("pdf", FAKE_PDF_2, { filename: "report.pdf", contentType: "application/pdf" });

        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
        expect(typeof res.body.import_id).toBe("number");
        manualImportId = res.body.import_id;

        const row = await pool.query<{ source_type: string; detected_brand_id: number }>(
          `SELECT source_type, detected_brand_id
             FROM marketplace_report_imports
            WHERE id = $1`,
          [manualImportId],
        );
        expect(row.rows[0].source_type).toBe("manual_upload");
        expect(row.rows[0].detected_brand_id).toBe(brandId);
      });

      it("detects SHA-256 duplicates on manual upload and returns 200 with duplicate:true", async () => {
        const res = await request(app)
          .post(`/brands/${brandId}/marketplace-reports/imports/manual`)
          .field("marketplace", "toters")
          .attach("pdf", FAKE_PDF_2, { filename: "report.pdf", contentType: "application/pdf" });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.duplicate).toBe(true);
        expect(res.body.existing_import_id).toBe(manualImportId);
      });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // GET /brands/:brandId/marketplace-report-imports
    // ─────────────────────────────────────────────────────────────────────────

    describe("GET /brands/:brandId/marketplace-report-imports", () => {
      it("returns 404 for an unknown brand", async () => {
        const res = await request(app).get(`/brands/99999999/marketplace-report-imports`);
        expect(res.status).toBe(404);
      });

      it("lists imports for the brand", async () => {
        const res = await request(app).get(`/brands/${brandId}/marketplace-report-imports`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(Array.isArray(res.body.imports)).toBe(true);
        expect(res.body.imports.length).toBeGreaterThanOrEqual(1);
        const ids = res.body.imports.map((i: { id: number }) => i.id);
        expect(ids).toContain(manualImportId);
      });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // GET /marketplace-report-imports/:importId
    // ─────────────────────────────────────────────────────────────────────────

    describe("GET /marketplace-report-imports/:importId", () => {
      it("returns 404 for an unknown import", async () => {
        const res = await request(app).get(`/marketplace-report-imports/99999999`);
        expect(res.status).toBe(404);
      });

      it("returns full import detail", async () => {
        const res = await request(app).get(`/marketplace-report-imports/${manualImportId}`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.import).toMatchObject({
          id: manualImportId,
          source_type: "manual_upload",
          marketplace: "toters",
          detected_brand_id: brandId,
        });
      });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // PATCH /marketplace-report-imports/:importId
    // ─────────────────────────────────────────────────────────────────────────

    describe("PATCH /marketplace-report-imports/:importId", () => {
      it("returns 404 for an unknown import", async () => {
        const res = await request(app)
          .patch(`/marketplace-report-imports/99999999`)
          .send({ notes: "test" });
        expect(res.status).toBe(404);
      });

      it("returns 400 when no fields are supplied", async () => {
        const res = await request(app)
          .patch(`/marketplace-report-imports/${manualImportId}`)
          .send({});
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/no fields to update/i);
      });

      it("updates mutable fields and returns the updated import", async () => {
        const res = await request(app)
          .patch(`/marketplace-report-imports/${manualImportId}`)
          .send({
            detected_merchant_name: "Test Restaurant Updated",
            detected_brand_id: brandId,
            report_period_start: "2024-02-01",
            report_period_end: "2024-02-29",
            import_status: "ready_to_approve",
            notes: "corrected by test",
          });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.import.detected_merchant_name).toBe("Test Restaurant Updated");
        expect(res.body.import.import_status).toBe("ready_to_approve");
        expect(res.body.import.notes).toBe("corrected by test");
      });

      it("returns 409 when trying to edit an already-approved import", async () => {
        const r = await pool.query<{ id: number }>(
          `INSERT INTO marketplace_report_imports
             (workspace_owner_id, import_status, marketplace, detected_brand_id,
              report_period_start, report_period_end, pdf_sha256)
           VALUES ($1, 'approved', 'toters', $2, '2023-06-01', '2023-06-30', 'sha-already-approved')
           RETURNING id`,
          [OWNER_ID, brandId],
        );
        const approvedId = r.rows[0].id;

        const res = await request(app)
          .patch(`/marketplace-report-imports/${approvedId}`)
          .send({ notes: "should not work" });

        expect(res.status).toBe(409);
        expect(res.body.error).toMatch(/cannot edit an approved import/i);

        await pool.query(`DELETE FROM marketplace_report_imports WHERE id = $1`, [approvedId]);
      });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // POST /marketplace-report-imports/:importId/match-products
    // ─────────────────────────────────────────────────────────────────────────

    describe("POST /marketplace-report-imports/:importId/match-products", () => {
      it("returns 404 for an unknown import", async () => {
        const res = await request(app).post(
          `/marketplace-report-imports/99999999/match-products`,
        );
        expect(res.status).toBe(404);
      });

      it("runs product matching and returns updated extracted_data", async () => {
        const extractedWithItems = JSON.stringify({
          merchantName: "Test Restaurant",
          bestSellingItems: [
            { name: "Chicken Burger", rank: 1, quantity: 50, revenue: 500 },
            { name: "No Match Item XYZ", rank: 2, quantity: 10, revenue: 100 },
          ],
        });

        await pool.query(
          `UPDATE marketplace_report_imports
              SET extracted_data = $1, detected_brand_id = $2
            WHERE id = $3`,
          [extractedWithItems, brandId, manualImportId],
        );

        const res = await request(app).post(
          `/marketplace-report-imports/${manualImportId}/match-products`,
        );

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.extracted_data).toBeDefined();

        const items: Array<{
          name: string;
          matchStatus: string;
          matchedProductId: number | null;
        }> = res.body.extracted_data.bestSellingItems;
        expect(items).toHaveLength(2);

        const burgerItem = items.find((i) => i.name === "Chicken Burger");
        expect(burgerItem).toBeDefined();
        expect(burgerItem!.matchStatus).toBe("matched");
        expect(burgerItem!.matchedProductId).toBe(productId);

        const noMatchItem = items.find((i) => i.name === "No Match Item XYZ");
        expect(noMatchItem).toBeDefined();
        expect(noMatchItem!.matchStatus).toBe("unmatched");
        expect(noMatchItem!.matchedProductId).toBeNull();
      });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // POST /marketplace-report-imports/:importId/approve
    // ─────────────────────────────────────────────────────────────────────────

    describe("POST /marketplace-report-imports/:importId/approve", () => {
      beforeAll(async () => {
        // Seed a fresh import with complete extracted data for approve tests.
        const extractedData = JSON.stringify({
          merchantName: "Test Restaurant",
          metrics: [
            { name: "Total Revenue", value: 5000, unit: "AED", category: "revenue" },
            { name: "Total Orders", value: 120, unit: null, category: "orders" },
          ],
          weeklyTrends: [
            { weekLabel: "Week 1", weekStart: "2024-03-01", value: 1200, metricName: "revenue" },
          ],
          bestSellingItems: [
            {
              name: "Chicken Burger",
              rank: 1,
              quantity: 50,
              revenue: 500,
              matchedProductId: productId,
              matchScore: 1,
              matchStatus: "matched",
            },
          ],
        });

        const r = await pool.query<{ id: number }>(
          `INSERT INTO marketplace_report_imports
             (workspace_owner_id, import_status, marketplace, detected_brand_id,
              report_period_start, report_period_end, pdf_sha256, extracted_data)
           VALUES ($1, 'ready_to_approve', 'toters', $2, '2024-03-01', '2024-03-31',
                   'sha-approvable-001', $3)
           RETURNING id`,
          [OWNER_ID, brandId, extractedData],
        );
        approvableImportId = r.rows[0].id;
      });

      it("returns 404 for an unknown import", async () => {
        const res = await request(app).post(
          `/marketplace-report-imports/99999999/approve`,
        );
        expect(res.status).toBe(404);
      });

      it("returns 422 when brand is not set", async () => {
        const r = await pool.query<{ id: number }>(
          `INSERT INTO marketplace_report_imports
             (workspace_owner_id, import_status, marketplace,
              report_period_start, report_period_end, pdf_sha256)
           VALUES ($1, 'needs_review', 'toters', '2024-04-01', '2024-04-30', 'sha-no-brand')
           RETURNING id`,
          [OWNER_ID],
        );
        const noBrandId = r.rows[0].id;

        const res = await request(app).post(
          `/marketplace-report-imports/${noBrandId}/approve`,
        );
        expect(res.status).toBe(422);
        expect(res.body.error).toMatch(/brand must be set/i);

        await pool.query(`DELETE FROM marketplace_report_imports WHERE id = $1`, [noBrandId]);
      });

      it("returns 422 when report period is not set", async () => {
        const r = await pool.query<{ id: number }>(
          `INSERT INTO marketplace_report_imports
             (workspace_owner_id, import_status, marketplace, detected_brand_id, pdf_sha256)
           VALUES ($1, 'needs_review', 'toters', $2, 'sha-no-period')
           RETURNING id`,
          [OWNER_ID, brandId],
        );
        const noPeriodId = r.rows[0].id;

        const res = await request(app).post(
          `/marketplace-report-imports/${noPeriodId}/approve`,
        );
        expect(res.status).toBe(422);
        expect(res.body.error).toMatch(/report period/i);

        await pool.query(`DELETE FROM marketplace_report_imports WHERE id = $1`, [noPeriodId]);
      });

      it("approves successfully: returns 201 and creates report + metrics + trends + items", async () => {
        const res = await request(app).post(
          `/marketplace-report-imports/${approvableImportId}/approve`,
        );

        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
        expect(typeof res.body.report_id).toBe("number");
        approvedReportId = res.body.report_id;

        const [reportRow, metrics, trends, items, importRow] = await Promise.all([
          pool.query<{ brand_id: number; marketplace: string; report_period_start: string }>(
            `SELECT brand_id, marketplace, report_period_start
               FROM marketplace_reports
              WHERE id = $1`,
            [approvedReportId],
          ),
          pool.query<{ metric_name: string }>(
            `SELECT metric_name FROM marketplace_report_metrics WHERE report_id = $1`,
            [approvedReportId],
          ),
          pool.query<{ week_label: string }>(
            `SELECT week_label FROM marketplace_report_weekly_trends WHERE report_id = $1`,
            [approvedReportId],
          ),
          pool.query<{ item_name: string; match_status: string }>(
            `SELECT item_name, match_status
               FROM marketplace_report_items
              WHERE report_id = $1`,
            [approvedReportId],
          ),
          pool.query<{ import_status: string; approved_report_id: number }>(
            `SELECT import_status, approved_report_id
               FROM marketplace_report_imports
              WHERE id = $1`,
            [approvableImportId],
          ),
        ]);

        expect(reportRow.rows[0].brand_id).toBe(brandId);
        expect(reportRow.rows[0].marketplace).toBe("toters");

        expect(metrics.rows.length).toBe(2);
        const metricNames = metrics.rows.map((m) => m.metric_name);
        expect(metricNames).toContain("Total Revenue");

        expect(trends.rows.length).toBe(1);
        expect(trends.rows[0].week_label).toBe("Week 1");

        expect(items.rows.length).toBe(1);
        expect(items.rows[0].item_name).toBe("Chicken Burger");
        expect(items.rows[0].match_status).toBe("matched");

        expect(importRow.rows[0].import_status).toBe("approved");
        expect(importRow.rows[0].approved_report_id).toBe(approvedReportId);
      });

      it("returns 409 when the import has already been approved", async () => {
        const res = await request(app).post(
          `/marketplace-report-imports/${approvableImportId}/approve`,
        );
        expect(res.status).toBe(409);
        expect(res.body.error).toMatch(/already approved/i);
      });

      it("returns 409 when a report already exists for the same marketplace/brand/period", async () => {
        const r = await pool.query<{ id: number }>(
          `INSERT INTO marketplace_report_imports
             (workspace_owner_id, import_status, marketplace, detected_brand_id,
              report_period_start, report_period_end, pdf_sha256, extracted_data)
           VALUES ($1, 'ready_to_approve', 'toters', $2, '2024-03-01', '2024-03-31',
                   'sha-dup-period-002', $3::jsonb)
           RETURNING id`,
          [
            OWNER_ID,
            brandId,
            JSON.stringify({
              metrics: [],
              weeklyTrends: [],
              bestSellingItems: [],
            }),
          ],
        );
        const dupImportId = r.rows[0].id;

        const res = await request(app).post(
          `/marketplace-report-imports/${dupImportId}/approve`,
        );
        expect(res.status).toBe(409);
        expect(res.body.error).toMatch(/already exists/i);
        expect(typeof res.body.existing_report_id).toBe("number");

        await pool.query(`DELETE FROM marketplace_report_imports WHERE id = $1`, [dupImportId]);
      });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // GET /marketplace-reports/:reportId
    // ─────────────────────────────────────────────────────────────────────────

    describe("GET /marketplace-reports/:reportId", () => {
      it("returns 404 for an unknown report", async () => {
        const res = await request(app).get(`/marketplace-reports/99999999`);
        expect(res.status).toBe(404);
      });

      it("returns full report detail with metrics, trends, and items", async () => {
        const res = await request(app).get(`/marketplace-reports/${approvedReportId}`);

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        const report = res.body.report;
        expect(report.id).toBe(approvedReportId);
        expect(report.brand_id).toBe(brandId);
        expect(report.marketplace).toBe("toters");

        expect(Array.isArray(report.metrics)).toBe(true);
        expect(report.metrics.length).toBe(2);

        expect(Array.isArray(report.weekly_trends)).toBe(true);
        expect(report.weekly_trends.length).toBe(1);

        expect(Array.isArray(report.items)).toBe(true);
        expect(report.items.length).toBe(1);
        expect(report.items[0].item_name).toBe("Chicken Burger");
        expect(report.items[0].match_status).toBe("matched");
        expect(report.items[0].matched_product_name).toBe("Chicken Burger");
      });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // GET /brands/:brandId/marketplace-reports
    // ─────────────────────────────────────────────────────────────────────────

    describe("GET /brands/:brandId/marketplace-reports", () => {
      it("lists approved reports for the brand", async () => {
        const res = await request(app).get(`/brands/${brandId}/marketplace-reports`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(Array.isArray(res.body.reports)).toBe(true);
        expect(res.body.reports.some((r: { id: number }) => r.id === approvedReportId)).toBe(true);
      });

      it("returns 404 for unknown brand", async () => {
        const res = await request(app).get(`/brands/99999999/marketplace-reports`);
        expect(res.status).toBe(404);
      });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // POST /marketplace-brand-aliases
    // ─────────────────────────────────────────────────────────────────────────

    describe("POST /marketplace-brand-aliases", () => {
      it("returns 400 when required fields are missing", async () => {
        const res = await request(app)
          .post("/marketplace-brand-aliases")
          .send({ marketplace: "toters" });

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/validation failed/i);
      });

      it("returns 404 when brand_id does not belong to the workspace", async () => {
        const res = await request(app)
          .post("/marketplace-brand-aliases")
          .send({ marketplace: "toters", alias_name: "Unknown Brand", brand_id: 99999999 });

        expect(res.status).toBe(404);
        expect(res.body.error).toMatch(/brand not found/i);
      });

      it("creates a new alias and returns 201 with the alias row", async () => {
        const res = await request(app)
          .post("/marketplace-brand-aliases")
          .send({ marketplace: "toters", alias_name: "Test Restaurant", brand_id: brandId });

        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.alias).toMatchObject({
          marketplace: "toters",
          brand_id: brandId,
        });
        // alias_name is normalized: "restaurant" is stripped, result is "test"
        expect(typeof res.body.alias.alias_name).toBe("string");
        expect(res.body.alias.alias_name.length).toBeGreaterThan(0);

        // Verify persisted in the DB
        const row = await pool.query<{ brand_id: number }>(
          `SELECT brand_id FROM marketplace_brand_aliases WHERE id = $1`,
          [res.body.alias.id],
        );
        expect(row.rows[0].brand_id).toBe(brandId);
      });

      it("upserts on conflict (same alias_name + marketplace): returns 201 with updated brand_id", async () => {
        const r = await pool.query<{ id: number }>(
          `INSERT INTO brands (workspace_owner_id, name) VALUES ($1, $2) RETURNING id`,
          [OWNER_ID, "Second Brand For Alias Upsert Test"],
        );
        const secondBrandId = r.rows[0].id;

        try {
          const res = await request(app)
            .post("/marketplace-brand-aliases")
            .send({ marketplace: "toters", alias_name: "Test Restaurant", brand_id: secondBrandId });

          expect(res.status).toBe(201);
          expect(res.body.success).toBe(true);
          // brand_id must now point to the new brand
          expect(res.body.alias.brand_id).toBe(secondBrandId);

          // Restore the alias back to the original brand for later tests
          await request(app)
            .post("/marketplace-brand-aliases")
            .send({ marketplace: "toters", alias_name: "Test Restaurant", brand_id: brandId });
        } finally {
          await pool.query(`DELETE FROM brands WHERE id = $1`, [secondBrandId]);
        }
      });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // GET /marketplace-brand-aliases
    // ─────────────────────────────────────────────────────────────────────────

    describe("GET /marketplace-brand-aliases", () => {
      it("returns 200 with an array of aliases for the workspace", async () => {
        const res = await request(app).get("/marketplace-brand-aliases");

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(Array.isArray(res.body.aliases)).toBe(true);
        expect(res.body.aliases.length).toBeGreaterThanOrEqual(1);
      });

      it("joins brand_name from the brands table", async () => {
        const res = await request(app).get("/marketplace-brand-aliases");

        expect(res.status).toBe(200);
        const alias = res.body.aliases.find(
          (a: { brand_id: number }) => a.brand_id === brandId,
        );
        expect(alias).toBeDefined();
        expect(alias.brand_name).toBe("Test Restaurant");
      });

      it("scopes results to the authenticated workspace (no cross-tenant leakage)", async () => {
        // Insert an alias for a different workspace owner.
        await pool.query(
          `INSERT INTO marketplace_brand_aliases
             (workspace_owner_id, marketplace, alias_name, brand_id)
           VALUES ($1, 'toters', 'other-workspace-alias', $2)
           ON CONFLICT DO NOTHING`,
          ["__different_workspace_owner__", brandId],
        );

        const res = await request(app).get("/marketplace-brand-aliases");
        expect(res.status).toBe(200);

        const leaked = res.body.aliases.find(
          (a: { alias_name: string }) => a.alias_name === "other-workspace-alias",
        );
        expect(leaked).toBeUndefined();

        await pool.query(
          `DELETE FROM marketplace_brand_aliases
            WHERE workspace_owner_id = '__different_workspace_owner__'`,
        );
      });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // runExtractionAndMatching — brand alias auto-detection
    //
    // The mock normalizeMerchantName strips stop-words like "restaurant" and
    // lowercases, so "Test Restaurant" → "test".  Each test inserts its own
    // import row (with a unique pdf_sha256) and calls runExtractionAndMatching
    // directly so there are no async-timing concerns.
    // ─────────────────────────────────────────────────────────────────────────

    describe("runExtractionAndMatching — brand alias auto-detection", () => {
      // Unique sha counter avoids duplicate-detection collisions across tests.
      let shaCounter = 0;
      const nextSha = () => `sha-alias-autodetect-${++shaCounter}`;

      // Insert a fresh pending import and return its id.
      async function insertImport(
        sourceType: "webhook_email" | "manual_upload",
        existingBrandId: number | null = null,
      ): Promise<number> {
        const r = await pool.query<{ id: number }>(
          `INSERT INTO marketplace_report_imports
             (workspace_owner_id, source_type, marketplace, import_status, pdf_sha256, detected_brand_id)
           VALUES ($1, $2, 'toters', 'pending', $3, $4)
           RETURNING id`,
          [OWNER_ID, sourceType, nextSha(), existingBrandId],
        );
        return r.rows[0].id;
      }

      // Read back the key columns after extraction runs.
      async function readImport(id: number) {
        const r = await pool.query<{
          detected_brand_id: number | null;
          detected_location_id: number | null;
          import_status: string;
          detected_merchant_name: string | null;
        }>(
          `SELECT detected_brand_id, detected_location_id, import_status, detected_merchant_name
             FROM marketplace_report_imports
            WHERE id = $1`,
          [id],
        );
        return r.rows[0];
      }

      it("auto-fills detected_brand_id when alias_name matches normalised merchant name", async () => {
        // alias_name='test' is the normalised form of "Test Restaurant" per the mock.
        // The POST /marketplace-brand-aliases tests above already created this alias;
        // use ON CONFLICT DO NOTHING to ensure it exists regardless of ordering.
        await pool.query(
          `INSERT INTO marketplace_brand_aliases (workspace_owner_id, marketplace, alias_name, brand_id)
           VALUES ($1, 'toters', 'test', $2)
           ON CONFLICT DO NOTHING`,
          [OWNER_ID, brandId],
        );

        const importId = await insertImport("webhook_email");
        await runExtractionAndMatching(importId, FAKE_PDF, OWNER_ID);

        const row = await readImport(importId);
        expect(row.detected_brand_id).toBe(brandId);
        expect(row.detected_location_id).toBeNull();
        // Mock extractor returns period dates, so brand + dates → ready_to_approve
        expect(row.import_status).toBe("ready_to_approve");
        // Merchant name from mock extractor should be persisted
        expect(row.detected_merchant_name).toBe("Test Restaurant");
      });

      it("also sets detected_location_id when the alias row includes a location", async () => {
        const locResult = await pool.query<{ id: number }>(
          `INSERT INTO locations (workspace_owner_id, name) VALUES ($1, 'Alias Test Location') RETURNING id`,
          [OWNER_ID],
        );
        const locationId = locResult.rows[0].id;

        // Update the existing alias to include the location
        await pool.query(
          `UPDATE marketplace_brand_aliases
              SET location_id = $1
            WHERE workspace_owner_id = $2 AND marketplace = 'toters' AND alias_name = 'test'`,
          [locationId, OWNER_ID],
        );

        const importId = await insertImport("webhook_email");
        await runExtractionAndMatching(importId, FAKE_PDF, OWNER_ID);

        const row = await readImport(importId);
        expect(row.detected_brand_id).toBe(brandId);
        expect(row.detected_location_id).toBe(locationId);
        expect(row.import_status).toBe("ready_to_approve");

        // Restore alias to no-location state and remove test location
        await pool.query(
          `UPDATE marketplace_brand_aliases SET location_id = NULL
            WHERE workspace_owner_id = $1 AND marketplace = 'toters' AND alias_name = 'test'`,
          [OWNER_ID],
        );
        await pool.query(`DELETE FROM locations WHERE id = $1`, [locationId]);
      });

      it("leaves detected_brand_id null when no alias matches the normalised merchant name", async () => {
        // Remove any alias so nothing matches "test"
        await pool.query(
          `DELETE FROM marketplace_brand_aliases WHERE workspace_owner_id = $1`,
          [OWNER_ID],
        );

        const importId = await insertImport("webhook_email");
        await runExtractionAndMatching(importId, FAKE_PDF, OWNER_ID);

        const row = await readImport(importId);
        expect(row.detected_brand_id).toBeNull();
        // No brand → cannot reach ready_to_approve
        expect(row.import_status).toBe("needs_review");
      });

      it("preserves a manually-set brand when no alias matches (manual_upload)", async () => {
        // No alias exists at this point (deleted in previous test).
        const importId = await insertImport("manual_upload", brandId);
        await runExtractionAndMatching(importId, FAKE_PDF, OWNER_ID);

        const row = await readImport(importId);
        // Brand was set manually before extraction; it must be preserved.
        expect(row.detected_brand_id).toBe(brandId);
        // Period dates from the mock extractor + existing brand → ready_to_approve
        expect(row.import_status).toBe("ready_to_approve");
      });

      it("alias match overwrites a pre-existing brand (alias is authoritative)", async () => {
        // Seed a different brand to act as the "wrong" pre-set value
        const otherBrand = await pool.query<{ id: number }>(
          `INSERT INTO brands (workspace_owner_id, name) VALUES ($1, 'Other Brand For Alias Test') RETURNING id`,
          [OWNER_ID],
        );
        const otherBrandId = otherBrand.rows[0].id;

        // Alias points to the original brandId
        await pool.query(
          `INSERT INTO marketplace_brand_aliases (workspace_owner_id, marketplace, alias_name, brand_id)
           VALUES ($1, 'toters', 'test', $2)
           ON CONFLICT (workspace_owner_id, marketplace, alias_name)
           DO UPDATE SET brand_id = EXCLUDED.brand_id`,
          [OWNER_ID, brandId],
        );

        // Import pre-set with the wrong brand
        const importId = await insertImport("manual_upload", otherBrandId);
        await runExtractionAndMatching(importId, FAKE_PDF, OWNER_ID);

        const row = await readImport(importId);
        // Alias should win over the pre-set value
        expect(row.detected_brand_id).toBe(brandId);
        expect(row.import_status).toBe("ready_to_approve");

        await pool.query(`DELETE FROM brands WHERE id = $1`, [otherBrandId]);
      });

      it("is case-insensitive for marketplace when looking up the alias", async () => {
        // Alias already seeded for 'toters' (lowercase); send lookup with mixed case
        // by inserting an import with marketplace='Toters' (title-case).
        const r = await pool.query<{ id: number }>(
          `INSERT INTO marketplace_report_imports
             (workspace_owner_id, source_type, marketplace, import_status, pdf_sha256)
           VALUES ($1, 'webhook_email', 'Toters', 'pending', $2)
           RETURNING id`,
          [OWNER_ID, nextSha()],
        );
        const importId = r.rows[0].id;

        await runExtractionAndMatching(importId, FAKE_PDF, OWNER_ID);

        const row = await readImport(importId);
        // The alias lookup uses lower(marketplace) on both sides
        expect(row.detected_brand_id).toBe(brandId);
      });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Brand Aliases: POST / GET / PATCH / DELETE /marketplace-brand-aliases
    // ─────────────────────────────────────────────────────────────────────────

    describe("Brand Aliases — POST / GET / PATCH / DELETE /marketplace-brand-aliases", () => {
      let aliasId: number;

      it("returns 400 when required fields are missing", async () => {
        const res = await request(app)
          .post("/marketplace-brand-aliases")
          .send({ marketplace: "toters" });

        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/validation failed/i);
      });

      it("returns 404 when the brand_id does not belong to the workspace", async () => {
        const res = await request(app)
          .post("/marketplace-brand-aliases")
          .send({ marketplace: "toters", alias_name: "Ghost Brand", brand_id: 99999999 });

        expect(res.status).toBe(404);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/brand not found/i);
      });

      it("creates an alias and returns 201 with the alias row", async () => {
        const res = await request(app)
          .post("/marketplace-brand-aliases")
          .send({
            marketplace: "toters",
            alias_name: "Test Restaurant Alias",
            brand_id: brandId,
          });

        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.alias).toMatchObject({
          marketplace: "toters",
          brand_id: brandId,
          workspace_owner_id: OWNER_ID,
        });
        expect(typeof res.body.alias.id).toBe("number");
        aliasId = res.body.alias.id;

        const row = await pool.query<{ alias_name: string; brand_id: number }>(
          `SELECT alias_name, brand_id FROM marketplace_brand_aliases WHERE id = $1`,
          [aliasId],
        );
        expect(row.rows).toHaveLength(1);
        expect(row.rows[0].brand_id).toBe(brandId);
      });

      it("GET /marketplace-brand-aliases lists the newly created alias", async () => {
        const res = await request(app).get("/marketplace-brand-aliases");

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(Array.isArray(res.body.aliases)).toBe(true);

        const found = res.body.aliases.find((a: { id: number }) => a.id === aliasId);
        expect(found).toBeDefined();
        expect(found.marketplace).toBe("toters");
        expect(found.brand_id).toBe(brandId);
        expect(found.brand_name).toBe("Test Restaurant");
      });

      it("upserts when the same (workspace, marketplace, alias_name) is posted again", async () => {
        const res = await request(app)
          .post("/marketplace-brand-aliases")
          .send({
            marketplace: "toters",
            alias_name: "Test Restaurant Alias",
            brand_id: brandId,
          });

        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.alias.id).toBe(aliasId);

        const count = await pool.query<{ cnt: string }>(
          `SELECT COUNT(*) AS cnt
             FROM marketplace_brand_aliases
            WHERE workspace_owner_id = $1
              AND marketplace = 'toters'
              AND brand_id = $2
              AND alias_name = 'test alias'`,
          [OWNER_ID, brandId],
        );
        expect(Number(count.rows[0].cnt)).toBe(1);
      });

      it("PATCH updates the same alias record and normalizes its edited matching key", async () => {
        const res = await request(app)
          .patch(`/marketplace-brand-aliases/${aliasId}`)
          .send({
            marketplace: "Toters",
            alias_name: "Presentail Flowers & Gifts",
            brand_id: brandId,
            location_id: null,
          });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.alias.id).toBe(aliasId);
        expect(res.body.alias.alias_name).toBe("presentail flowers gifts");

        const row = await pool.query<{ id: number; alias_name: string; brand_id: number }>(
          `SELECT id, alias_name, brand_id FROM marketplace_brand_aliases WHERE id = $1`,
          [aliasId],
        );
        expect(row.rows).toEqual([{
          id: aliasId,
          alias_name: "presentail flowers gifts",
          brand_id: brandId,
        }]);
      });

      it("PATCH rejects an edited key that conflicts with another alias in the workspace", async () => {
        const duplicate = await request(app)
          .post("/marketplace-brand-aliases")
          .send({
            marketplace: "Toters",
            alias_name: "Achrafieh Statement",
            brand_id: brandId,
          });
        expect(duplicate.status).toBe(201);

        const res = await request(app)
          .patch(`/marketplace-brand-aliases/${aliasId}`)
          .send({
            marketplace: "Toters",
            alias_name: "Achrafieh Statement",
            brand_id: brandId,
          });

        expect(res.status).toBe(409);
        expect(res.body.success).toBe(false);

        const untouched = await pool.query<{ alias_name: string }>(
          `SELECT alias_name FROM marketplace_brand_aliases WHERE id = $1`,
          [aliasId],
        );
        expect(untouched.rows[0].alias_name).toBe("presentail flowers gifts");

        await pool.query(`DELETE FROM marketplace_brand_aliases WHERE id = $1`, [duplicate.body.alias.id]);
      });

      it("PATCH rejects a canonical brand from another workspace", async () => {
        const otherBrand = await pool.query<{ id: number }>(
          `INSERT INTO brands (workspace_owner_id, name) VALUES ($1, $2) RETURNING id`,
          ["__marketplace_alias_other_workspace__", "Other Workspace Brand"],
        );

        try {
          const res = await request(app)
            .patch(`/marketplace-brand-aliases/${aliasId}`)
            .send({
              marketplace: "Toters",
              alias_name: "Presentail Flowers & Gifts",
              brand_id: otherBrand.rows[0].id,
            });

          expect(res.status).toBe(404);
          expect(res.body.success).toBe(false);
          expect(res.body.error).toMatch(/brand not found/i);
        } finally {
          await pool.query(`DELETE FROM brands WHERE id = $1`, [otherBrand.rows[0].id]);
        }
      });

      it("PATCH rejects a location from another workspace", async () => {
        const otherLocation = await pool.query<{ id: number }>(
          `INSERT INTO locations (workspace_owner_id, name) VALUES ($1, $2) RETURNING id`,
          [OTHER_OWNER_ID, "Other Workspace Alias Location"],
        );

        try {
          const res = await request(app)
            .patch(`/marketplace-brand-aliases/${aliasId}`)
            .send({
              marketplace: "Toters",
              alias_name: "Presentail Flowers & Gifts",
              brand_id: brandId,
              location_id: otherLocation.rows[0].id,
            });

          expect(res.status).toBe(404);
          expect(res.body.success).toBe(false);
          expect(res.body.error).toMatch(/location not found/i);

          const unchanged = await pool.query<{ location_id: number | null }>(
            `SELECT location_id FROM marketplace_brand_aliases WHERE id = $1`,
            [aliasId],
          );
          expect(unchanged.rows[0].location_id).toBeNull();
        } finally {
          await pool.query(`DELETE FROM locations WHERE id = $1`, [otherLocation.rows[0].id]);
        }
      });

      it("PATCH rejects a non-owner before reading or updating the alias", async () => {
        const res = await request(app)
          .patch(`/marketplace-brand-aliases/${aliasId}`)
          .set("x-test-workspace-role", "member")
          .send({
            marketplace: "Toters",
            alias_name: "Presentail Flowers & Gifts",
            brand_id: brandId,
          });

        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);

        const unchanged = await pool.query<{ alias_name: string }>(
          `SELECT alias_name FROM marketplace_brand_aliases WHERE id = $1`,
          [aliasId],
        );
        expect(unchanged.rows[0].alias_name).toBe("presentail flowers gifts");
      });

      it("PATCH cannot update an alias record owned by another workspace", async () => {
        const otherBrand = await pool.query<{ id: number }>(
          `INSERT INTO brands (workspace_owner_id, name) VALUES ($1, $2) RETURNING id`,
          [OTHER_OWNER_ID, "Other Workspace Alias Brand"],
        );
        const otherAlias = await pool.query<{ id: number; alias_name: string }>(
          `INSERT INTO marketplace_brand_aliases (workspace_owner_id, marketplace, alias_name, brand_id)
           VALUES ($1, $2, $3, $4)
           RETURNING id, alias_name`,
          [OTHER_OWNER_ID, "Toters", "other workspace statement", otherBrand.rows[0].id],
        );

        try {
          const res = await request(app)
            .patch(`/marketplace-brand-aliases/${otherAlias.rows[0].id}`)
            .set("x-test-workspace-owner", OWNER_ID)
            .send({
              marketplace: "Toters",
              alias_name: "Attempted Cross Workspace Update",
              brand_id: brandId,
            });

          expect(res.status).toBe(404);
          expect(res.body.success).toBe(false);

          const unchanged = await pool.query<{ alias_name: string; brand_id: number }>(
            `SELECT alias_name, brand_id FROM marketplace_brand_aliases WHERE id = $1`,
            [otherAlias.rows[0].id],
          );
          expect(unchanged.rows).toEqual([{
            alias_name: "other workspace statement",
            brand_id: otherBrand.rows[0].id,
          }]);
        } finally {
          await pool.query(`DELETE FROM marketplace_brand_aliases WHERE id = $1`, [otherAlias.rows[0].id]);
          await pool.query(`DELETE FROM brands WHERE id = $1`, [otherBrand.rows[0].id]);
        }
      });

      it("DELETE /marketplace-brand-aliases/:id removes the alias", async () => {
        const res = await request(app).delete(`/marketplace-brand-aliases/${aliasId}`);

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        const row = await pool.query(
          `SELECT id FROM marketplace_brand_aliases WHERE id = $1`,
          [aliasId],
        );
        expect(row.rows).toHaveLength(0);
      });

      it("DELETE /marketplace-brand-aliases/:id returns 404 for an already-deleted alias", async () => {
        const res = await request(app).delete(`/marketplace-brand-aliases/${aliasId}`);

        expect(res.status).toBe(404);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/alias not found/i);
      });

      it("GET /marketplace-brand-aliases returns empty list after deletion", async () => {
        const res = await request(app).get("/marketplace-brand-aliases");

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        const found = res.body.aliases.find((a: { id: number }) => a.id === aliasId);
        expect(found).toBeUndefined();
      });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // AI extractor — happy path and fallback
    // ─────────────────────────────────────────────────────────────────────────

    describe("runExtractionAndMatching — AI extractor paths", () => {
      const AI_MERCHANT = "AI Extracted Restaurant";
      const FALLBACK_MERCHANT = "Test Restaurant";

      it("AI happy path: uses AI result and stores confidence in extracted_data", async () => {
        mockExtractMarketplaceReportWithAI.mockResolvedValueOnce({
          merchantName: AI_MERCHANT,
          country: "LB",
          address: "456 AI Ave",
          reportPeriodStart: "2024-05-11",
          reportPeriodEnd: "2024-05-17",
          metrics: [{ name: "total_orders", value: 88, unit: "count", category: "summary" }],
          weeklyTrends: [],
          bestSellingItems: [],
          confidence: 0.97,
        });

        const row = await pool.query<{ id: number }>(
          `INSERT INTO marketplace_report_imports
             (workspace_owner_id, source_type, marketplace, import_status, pdf_sha256)
           VALUES ($1, 'webhook_email', 'toters', 'pending', 'sha-ai-happy-path-001')
           RETURNING id`,
          [OWNER_ID],
        );
        const importId = row.rows[0].id;

        await runExtractionAndMatching(importId, FAKE_PDF, OWNER_ID);

        const result = await pool.query<{
          import_status: string;
          detected_merchant_name: string;
          extracted_data: Record<string, unknown>;
        }>(
          `SELECT import_status, detected_merchant_name, extracted_data
             FROM marketplace_report_imports WHERE id = $1`,
          [importId],
        );
        const record = result.rows[0];
        expect(record.detected_merchant_name).toBe(AI_MERCHANT);
        expect(record.extracted_data).toMatchObject({
          merchantName: AI_MERCHANT,
          confidence: 0.97,
        });

        await pool.query(`DELETE FROM marketplace_report_imports WHERE id = $1`, [importId]);
      });

      it("AI fallback: falls back to regex extractor when AI throws, import is still processed", async () => {
        mockExtractMarketplaceReportWithAI.mockRejectedValueOnce(
          new Error("OpenAI quota exceeded"),
        );

        const row = await pool.query<{ id: number }>(
          `INSERT INTO marketplace_report_imports
             (workspace_owner_id, source_type, marketplace, import_status, pdf_sha256)
           VALUES ($1, 'webhook_email', 'toters', 'pending', 'sha-ai-fallback-001')
           RETURNING id`,
          [OWNER_ID],
        );
        const importId = row.rows[0].id;

        await runExtractionAndMatching(importId, FAKE_PDF, OWNER_ID);

        const result = await pool.query<{
          import_status: string;
          detected_merchant_name: string;
        }>(
          `SELECT import_status, detected_merchant_name
             FROM marketplace_report_imports WHERE id = $1`,
          [importId],
        );
        const record = result.rows[0];
        // Fallback regex extractor returns "Test Restaurant"
        expect(record.detected_merchant_name).toBe(FALLBACK_MERCHANT);
        // Not extraction_failed — regex ran successfully
        expect(record.import_status).not.toBe("extraction_failed");

        await pool.query(`DELETE FROM marketplace_report_imports WHERE id = $1`, [importId]);
      });

      it("promotes import to ready_to_approve when AI extracts brand-matched merchant name + valid period", async () => {
        // normalizeMerchantName mock: lowercase, strip stop-words (restaurant/cafe/kitchen/grill),
        // strip non-word chars, collapse spaces, trim.
        // "Matched Burger Kitchen" → lowercase → "matched burger kitchen"
        //   → strip "kitchen" → "matched burger " → trim → "matched burger"
        const AI_BRAND_MERCHANT = "Matched Burger Kitchen";
        const normalizedAliasName = "matched burger";

        // Seed a brand alias so the normalized name resolves to brandId
        await pool.query(
          `INSERT INTO marketplace_brand_aliases
             (workspace_owner_id, marketplace, alias_name, brand_id)
           VALUES ($1, 'toters', $2, $3)
           ON CONFLICT (workspace_owner_id, marketplace, alias_name)
           DO UPDATE SET brand_id = EXCLUDED.brand_id`,
          [OWNER_ID, normalizedAliasName, brandId],
        );

        // AI returns a recognizable merchant name with a complete period
        mockExtractMarketplaceReportWithAI.mockResolvedValueOnce({
          merchantName: AI_BRAND_MERCHANT,
          country: "AE",
          address: "7 Test Ave",
          reportPeriodStart: "2024-06-01",
          reportPeriodEnd: "2024-06-30",
          metrics: [],
          weeklyTrends: [],
          bestSellingItems: [],
          confidence: 0.95,
        });

        const row = await pool.query<{ id: number }>(
          `INSERT INTO marketplace_report_imports
             (workspace_owner_id, source_type, marketplace, import_status, pdf_sha256)
           VALUES ($1, 'webhook_email', 'toters', 'pending', 'sha-ai-promote-ready-001')
           RETURNING id`,
          [OWNER_ID],
        );
        const importId = row.rows[0].id;

        await runExtractionAndMatching(importId, FAKE_PDF, OWNER_ID);

        const result = await pool.query<{
          import_status: string;
          detected_brand_id: number | null;
          detected_merchant_name: string | null;
          report_period_start: string | null;
          report_period_end: string | null;
        }>(
          `SELECT import_status, detected_brand_id, detected_merchant_name,
                  report_period_start::text AS report_period_start,
                  report_period_end::text   AS report_period_end
             FROM marketplace_report_imports WHERE id = $1`,
          [importId],
        );
        const record = result.rows[0];

        // All three required fields present (brand matched + period start + period end)
        // → import must be promoted to ready_to_approve
        expect(record.import_status).toBe("ready_to_approve");
        expect(record.detected_brand_id).toBe(brandId);
        expect(record.detected_merchant_name).toBe(AI_BRAND_MERCHANT);
        expect(record.report_period_start).toBe("2024-06-01");
        expect(record.report_period_end).toBe("2024-06-30");

        await pool.query(`DELETE FROM marketplace_report_imports WHERE id = $1`, [importId]);
        await pool.query(
          `DELETE FROM marketplace_brand_aliases
            WHERE workspace_owner_id = $1 AND marketplace = 'toters' AND alias_name = $2`,
          [OWNER_ID, normalizedAliasName],
        );
      });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // POST /marketplace-report-imports/:importId/retry
    // ─────────────────────────────────────────────────────────────────────────

    describe("POST /marketplace-report-imports/:importId/retry", () => {
      let retryImportId: number;
      let retryFailedNoPathId: number;

      beforeAll(async () => {
        // extraction_failed import with a stored PDF path (the happy path)
        const r1 = await pool.query<{ id: number }>(
          `INSERT INTO marketplace_report_imports
             (workspace_owner_id, import_status, marketplace,
              pdf_storage_path, pdf_sha256)
           VALUES ($1, 'extraction_failed', 'toters',
                   'test-bucket/private/retry-test.pdf', 'sha-retry-001')
           RETURNING id`,
          [OWNER_ID],
        );
        retryImportId = r1.rows[0].id;

        // extraction_failed import with no pdf_storage_path (triggers 422)
        const r2 = await pool.query<{ id: number }>(
          `INSERT INTO marketplace_report_imports
             (workspace_owner_id, import_status, marketplace, pdf_sha256)
           VALUES ($1, 'extraction_failed', 'toters', 'sha-retry-no-path')
           RETURNING id`,
          [OWNER_ID],
        );
        retryFailedNoPathId = r2.rows[0].id;
      });

      afterAll(async () => {
        await pool.query(
          `DELETE FROM marketplace_report_imports WHERE id = ANY($1::int[])`,
          [[retryImportId, retryFailedNoPathId]],
        );
      });

      it("returns 404 for a non-existent import", async () => {
        const res = await request(app).post(`/marketplace-report-imports/99999999/retry`);

        expect(res.status).toBe(404);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/import not found/i);
      });

      it("returns 409 when import is not in extraction_failed state", async () => {
        // manualImportId was patched to 'ready_to_approve' by the PATCH tests
        const res = await request(app).post(
          `/marketplace-report-imports/${manualImportId}/retry`,
        );

        expect(res.status).toBe(409);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/not in extraction_failed state/i);
      });

      it("returns 422 when no pdf_storage_path is stored for the import", async () => {
        const res = await request(app).post(
          `/marketplace-report-imports/${retryFailedNoPathId}/retry`,
        );

        expect(res.status).toBe(422);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/no pdf stored/i);
      });

      it("returns 202, resets status to pending in DB, and fires runExtractionAndMatching", async () => {
        // Provide a Web ReadableStream response body so the route can read the PDF bytes.
        mockGetObjectEntityFile.mockResolvedValueOnce(
          new File([], "retry-test.pdf", { type: "application/pdf" }),
        );
        const pdfStream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(FAKE_PDF));
            controller.close();
          },
        });
        mockDownloadObject.mockResolvedValueOnce({ body: pdfStream });

        // Spy on runExtractionAndMatching so we can verify it was called and
        // also prevent it from updating the status so we can assert 'pending'.
        const extractionSpy = vi
          .spyOn(webhookModule, "runExtractionAndMatching")
          .mockResolvedValueOnce(undefined);

        const res = await request(app).post(
          `/marketplace-report-imports/${retryImportId}/retry`,
        );

        expect(res.status).toBe(202);
        expect(res.body.success).toBe(true);
        expect(res.body.import_id).toBe(retryImportId);

        // The route resets import_status to 'pending' synchronously before
        // sending the 202 response, so it must be 'pending' right now.
        const row = await pool.query<{ import_status: string }>(
          `SELECT import_status FROM marketplace_report_imports WHERE id = $1`,
          [retryImportId],
        );
        expect(row.rows[0].import_status).toBe("pending");

        // runExtractionAndMatching must have been called with the correct args.
        expect(extractionSpy).toHaveBeenCalledOnce();
        expect(extractionSpy).toHaveBeenCalledWith(
          retryImportId,
          expect.any(Buffer),
          OWNER_ID,
        );

        extractionSpy.mockRestore();
      });
    });
  },
);
