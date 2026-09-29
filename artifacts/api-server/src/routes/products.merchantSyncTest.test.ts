/**
 * Route-level tests for POST /products/:id/merchant-sync-test
 *
 * Verifies that:
 *  1. The route converts the productInputs resource name to the Products
 *     resource name before calling fetchProductStatus (the core bug this
 *     task fixes — passing /productInputs/... caused a permanent 404).
 *  2. Item-level issues from the status poll are surfaced in the response.
 *  3. A 404 from fetchProductStatus is handled gracefully (non-fatal).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

// ── Mocks (must precede all imports of the module under test) ─────────────────

const mockDbQuery = vi.fn();
let mockWorkspaceRole: WorkspaceRequest["workspaceRole"] = "owner";

vi.mock("../lib/db", () => ({
  db: { query: (...args: unknown[]) => mockDbQuery(...args) },
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  authed: (req: express.Request) => req,
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../lib/objectStorage", () => ({
  objectStorageClient: {
    bucket: () => ({ file: () => ({ save: vi.fn().mockResolvedValue(undefined) }) }),
  },
}));

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = "owner_1";
    wreq.workspaceActualRole = mockWorkspaceRole;
    wreq.workspaceRole = mockWorkspaceRole;
    wreq.allowedPages = null;
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
  hasPageAccess: () => true,
}));

const mockInsertProductInput = vi.fn();
const mockFetchProductStatus = vi.fn();
const mockVerifyMerchantAccountAccess = vi.fn().mockResolvedValue(undefined);
const mockBuildInsertBody = vi.fn();
const mockGetMerchantConfigStatus = vi.fn().mockReturnValue({ ok: true, problems: [] });
const mockCreateMarketReconciliationDryRuns = vi.fn();
const mockApproveDeletionItems = vi.fn();

vi.mock("../lib/merchantCenterClient", () => ({
  insertProductInput: (...args: unknown[]) => mockInsertProductInput(...args),
  fetchProductStatus: (...args: unknown[]) => mockFetchProductStatus(...args),
  verifyMerchantAccountAccess: (...args: unknown[]) => mockVerifyMerchantAccountAccess(...args),
  buildInsertBody: (...args: unknown[]) => mockBuildInsertBody(...args),
  validateMerchantConfig: vi.fn(),
  getMerchantConfigStatus: (...args: unknown[]) => mockGetMerchantConfigStatus(...args),
}));

vi.mock("../lib/googleMerchant", () => ({
  buildMerchantProductInput: vi.fn().mockReturnValue({
    offerId: "SKU1-LB",
    contentLanguage: "en",
    feedLabel: "LB",
    productAttributes: {
      title: "Test Product",
      description: "A product",
      link: "https://presentail.com/en-lb/beirut/product/test",
      imageLink: "https://example.com/img.jpg",
      availability: "IN_STOCK",
      price: { amountMicros: "10000000", currencyCode: "USD" },
      identifierExists: false,
      condition: "NEW",
    },
  }),
}));

vi.mock("../lib/merchantReconciliation", () => ({
  approveDeletionItems: (...args: unknown[]) => mockApproveDeletionItems(...args),
  approveReconciliationRun: vi.fn(),
  applyApprovedDeleteBatch: vi.fn(),
  applyApprovedRun: vi.fn(),
  createMarketReconciliationDryRuns: (...args: unknown[]) => mockCreateMarketReconciliationDryRuns(...args),
  merchantReconciliationExecutionEnabled: vi.fn().mockReturnValue(false),
}));

const mockEnqueueMerchantSyncBackfill = vi.fn();
const mockEnqueueSelectedMerchantSync = vi.fn();
const mockEnqueueSelectedMerchantUnsync = vi.fn();

vi.mock("../lib/merchantSyncQueue", () => ({
  enqueueProductCreateOrUpdateSync: vi.fn(),
  enqueueProductDeleteSync: vi.fn(),
  enqueueMerchantSyncBackfill: (...args: unknown[]) => mockEnqueueMerchantSyncBackfill(...args),
  enqueueSelectedMerchantSync: (...args: unknown[]) => mockEnqueueSelectedMerchantSync(...args),
  enqueueSelectedMerchantUnsync: (...args: unknown[]) => mockEnqueueSelectedMerchantUnsync(...args),
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import productsRouter from "./products";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(productsRouter);
  return app;
}

const PRODUCT_INPUT_NAME = "accounts/5689332635/productInputs/online~en~LB~SKU1-LB";
const PRODUCTS_RESOURCE_NAME = "accounts/5689332635/products/online~en~LB~SKU1-LB";

/** Set up db.query to return a product row for the sync-test route. */
function setupProductRow() {
  mockDbQuery.mockResolvedValue({
    rows: [{
      id: 1,
      name: "Test Product",
      main_image_url: "https://example.com/img.jpg",
      price_usd: "10.00",
      price_aed: "36.70",
      discount_price_usd: null,
      discount_price_aed: null,
      status: "available",
      sku: "SKU1",
      is_archived: false,
      description: "A product",
      description_ar: null,
      google_product_category: null,
      target_country: "LB",
      content_language: "en",
      workspace_owner_id: "owner_1",
    }],
    rowCount: 1,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /products/:id/merchant-sync-test — resource name conversion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GOOGLE_MERCHANT_ACCOUNT_ID = "5689332635";
    process.env.GOOGLE_MERCHANT_DATA_SOURCE_ID = "123456";
    setupProductRow();
    // buildInsertBody must return all required fields or the route returns 400
    mockBuildInsertBody.mockReturnValue({
      offerId: "SKU1-LB",
      contentLanguage: "en",
      feedLabel: "LB",
      productAttributes: {
        title: "Test Product",
        description: "A product",
        link: "https://presentail.com/en-lb/beirut/product/test",
        imageLink: "https://example.com/img.jpg",
        availability: "IN_STOCK",
        condition: "new",
        price: { amountMicros: "10000000", currencyCode: "USD" },
      },
    });
  });

  it("refuses the retired direct-write diagnostic endpoint", async () => {
    mockInsertProductInput.mockResolvedValue({ name: PRODUCT_INPUT_NAME });
    mockFetchProductStatus.mockResolvedValue({
      productStatus: { itemLevelIssues: [] },
    });

    const app = makeApp();
    const res = await request(app)
      .post("/products/1/merchant-sync-test")
      .set("x-workspace-owner-id", "owner_1")
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("reviewed reconciliation run");
    expect(mockInsertProductInput).not.toHaveBeenCalled();
    expect(mockFetchProductStatus).not.toHaveBeenCalled();
  });

  it("never reaches Google even when a diagnostic status response is mocked", async () => {
    mockInsertProductInput.mockResolvedValue({ name: PRODUCT_INPUT_NAME });
    mockFetchProductStatus.mockResolvedValue({
      productStatus: {
        itemLevelIssues: [
          { title: "Image too small", servability: "disapproved" },
        ],
      },
    });

    const app = makeApp();
    const res = await request(app)
      .post("/products/1/merchant-sync-test")
      .set("x-workspace-owner-id", "owner_1")
      .send({});

    expect(res.status).toBe(409);
    expect(mockInsertProductInput).not.toHaveBeenCalled();
    expect(mockFetchProductStatus).not.toHaveBeenCalled();
  });

  it("does not attempt a status poll from the retired endpoint", async () => {
    mockInsertProductInput.mockResolvedValue({ name: PRODUCT_INPUT_NAME });
    mockFetchProductStatus.mockRejectedValue(new Error("fetchProductStatus HTTP 404: Not Found"));

    const app = makeApp();
    const res = await request(app)
      .post("/products/1/merchant-sync-test")
      .set("x-workspace-owner-id", "owner_1")
      .send({});

    expect(res.status).toBe(409);
    expect(mockInsertProductInput).not.toHaveBeenCalled();
    expect(mockFetchProductStatus).not.toHaveBeenCalled();
  });
});

// ── GET /products/merchant-sync-status — configuration health ─────────────────

describe("GET /products/merchant-sync-status — config problems field", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // counts query + issues query both return empty
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("exposes configuration problems explicitly instead of leaving jobs queued silently", async () => {
    mockGetMerchantConfigStatus.mockReturnValue({
      ok: false,
      problems: ["GOOGLE_MERCHANT_ACCOUNT_ID is not set — products cannot be sent to Google Merchant Center."],
    });

    const app = makeApp();
    const res = await request(app).get("/products/merchant-sync-status");

    expect(res.status).toBe(200);
    expect(res.body.config.ok).toBe(false);
    expect(res.body.config.problems).toHaveLength(1);
    expect(res.body.config.problems[0]).toContain("GOOGLE_MERCHANT_ACCOUNT_ID");
  });

  it("reports config.ok = true when the Merchant Center configuration is valid", async () => {
    mockGetMerchantConfigStatus.mockReturnValue({ ok: true, problems: [] });

    const app = makeApp();
    const res = await request(app).get("/products/merchant-sync-status");

    expect(res.status).toBe(200);
    expect(res.body.config).toEqual({ ok: true, problems: [] });
  });
});

// ── POST /products/merchant-sync-backfill — full-catalog result shape ─────────

describe("POST /products/merchant-sync-backfill", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWorkspaceRole = "owner";
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("refuses the retired country-ambiguous backfill", async () => {
    mockEnqueueMerchantSyncBackfill.mockResolvedValue({ enqueued: 912, inserted: 900, reset: 12 });

    const app = makeApp();
    const res = await request(app).post("/products/merchant-sync-backfill").send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("country-scoped");
    expect(mockEnqueueMerchantSyncBackfill).not.toHaveBeenCalled();
  });
});

describe("POST /products/merchant-reconciliation/dry-run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWorkspaceRole = "owner";
  });

  it("creates independent work for both selected markets", async () => {
    mockCreateMarketReconciliationDryRuns.mockResolvedValue([
      { country: "AE", ok: true, runId: 11, summary: { CREATE: 3 }, blocked: null },
      { country: "LB", ok: false, error: "LB account access is missing" },
    ]);

    const res = await request(makeApp())
      .post("/products/merchant-reconciliation/dry-run")
      .send({ countries: ["AE", "LB"], contentLanguage: "en", includeGoogle: true });

    expect(res.status).toBe(201);
    expect(res.body.results).toHaveLength(2);
    expect(res.body.results[1]).toEqual({
      country: "LB",
      ok: false,
      error: "LB account access is missing",
    });
    expect(mockCreateMarketReconciliationDryRuns).toHaveBeenCalledWith(
      "owner_1",
      "owner_1",
      ["AE", "LB"],
      "en",
      true,
    );
  });

  it.each(["AE", "LB"] as const)("accepts the single-market choice %s", async (country) => {
    const countries = [country];
    mockCreateMarketReconciliationDryRuns.mockResolvedValue([
      { country: countries[0], ok: true, runId: 12, summary: {}, blocked: null },
    ]);
    const res = await request(makeApp())
      .post("/products/merchant-reconciliation/dry-run")
      .send({ countries, contentLanguage: "en", includeGoogle: false });
    expect(res.status).toBe(201);
    expect(mockCreateMarketReconciliationDryRuns.mock.calls.at(-1)?.[2]).toEqual(countries);
  });
});

describe("POST /products/merchant-reconciliation/:runId/approve-deletions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWorkspaceRole = "owner";
    mockApproveDeletionItems.mockResolvedValue(2);
  });

  it("accepts PostgreSQL bigint item IDs serialized as strings", async () => {
    const res = await request(makeApp())
      .post("/products/merchant-reconciliation/10/approve-deletions")
      .send({
        itemIds: ["3389", "3390"],
        approveLastOffer: true,
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ approved: 2 });
    expect(mockApproveDeletionItems).toHaveBeenCalledWith(
      "owner_1",
      10,
      [3389, 3390],
      true,
    );
  });
});

describe("POST /products/merchant-sync-selected", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWorkspaceRole = "owner";
  });

  it("refuses selected direct sync in favor of reviewed reconciliation", async () => {
    mockEnqueueSelectedMerchantSync.mockResolvedValue({ queued: 2, skipped: 1 });

    const app = makeApp();
    const res = await request(app)
      .post("/products/merchant-sync-selected")
      .send({ ids: [4, 7, 99] });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("country reconciliation");
    expect(mockEnqueueSelectedMerchantSync).not.toHaveBeenCalled();
    expect(mockEnqueueMerchantSyncBackfill).not.toHaveBeenCalled();
  });

  it("does not inspect selection payloads because direct sync is retired", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/products/merchant-sync-selected")
      .send({ ids: [1, "2"] });

    expect(res.status).toBe(409);
    expect(mockEnqueueSelectedMerchantSync).not.toHaveBeenCalled();
  });

  it("does not allow oversized IDs to bypass the direct-sync retirement", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/products/merchant-sync-selected")
      .send({ ids: [2_147_483_648] });

    expect(res.status).toBe(409);
    expect(mockEnqueueSelectedMerchantSync).not.toHaveBeenCalled();
  });

  it("requires the workspace owner even when a member has another product permission", async () => {
    mockWorkspaceRole = "member";
    const app = makeApp();
    const res = await request(app)
      .post("/products/merchant-sync-selected")
      .send({ ids: [1] });

    expect(res.status).toBe(403);
    expect(mockEnqueueSelectedMerchantSync).not.toHaveBeenCalled();
  });
});

describe("POST /products/merchant-unsync-selected", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWorkspaceRole = "owner";
  });

  it("refuses direct unsync until country reconciliation is reviewed", async () => {
    mockEnqueueSelectedMerchantUnsync.mockResolvedValue({ excluded: 2, queued: 1, skipped: 1 });

    const res = await request(makeApp())
      .post("/products/merchant-unsync-selected")
      .send({ ids: [4, 7, 99] });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("reviewed country reconciliation");
    expect(mockEnqueueSelectedMerchantUnsync).not.toHaveBeenCalled();
  });

  it("leaves products unchanged for invalid or oversized retired requests", async () => {
    const invalid = await request(makeApp())
      .post("/products/merchant-unsync-selected")
      .send({ ids: [1, "2"] });
    const oversized = await request(makeApp())
      .post("/products/merchant-unsync-selected")
      .send({ ids: Array.from({ length: 501 }, (_, index) => index + 1) });

    expect(invalid.status).toBe(409);
    expect(oversized.status).toBe(409);
    expect(mockEnqueueSelectedMerchantUnsync).not.toHaveBeenCalled();
  });

  it("requires the workspace owner", async () => {
    mockWorkspaceRole = "member";

    const res = await request(makeApp())
      .post("/products/merchant-unsync-selected")
      .send({ ids: [1] });

    expect(res.status).toBe(403);
    expect(mockEnqueueSelectedMerchantUnsync).not.toHaveBeenCalled();
  });
});
