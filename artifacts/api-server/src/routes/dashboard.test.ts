import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

const mockDbQuery = vi.fn();

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
  },
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  authed: (req: express.Request) => req,
}));

let stubWorkspaceOwnerId = "owner_123";
let stubAssignedLocationIds: number[] | null = null;
let stubWorkspaceRole: "owner" | "member" = "owner";
let stubAllowedPages: string[] | null = null;

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = stubWorkspaceOwnerId;
    wreq.workspaceActualRole = stubWorkspaceRole;
    wreq.workspaceRole = stubWorkspaceRole;
    wreq.allowedPages = stubAllowedPages;
    wreq.assignedLocationIds = stubAssignedLocationIds;
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
  hasPageAccess: (wreq: WorkspaceRequest, pageKey: string) =>
    wreq.workspaceRole === "owner" || !!wreq.allowedPages?.includes(pageKey),
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import dashboardRouter from "./dashboard";

// ---------------------------------------------------------------------------
// Test app
// ---------------------------------------------------------------------------

const mockReqLogError = vi.fn();

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: { error: typeof mockReqLogError; warn: typeof mockReqLogError; info: typeof mockReqLogError } }).log = {
      error: mockReqLogError,
      warn: mockReqLogError,
      info: mockReqLogError,
    };
    next();
  });
  app.use(dashboardRouter);
  return app;
}

// ---------------------------------------------------------------------------
// Helper: build a full set of 8 mock resolved values for Promise.all
// The order matches the route's Promise.all array:
//   [0] brands, [1] locations, [2] channels, [3] products (grouped by status)
//   [4] brands_without_products, [5] total_base_items,
//   [6] low_stock_base_items, [7] out_of_stock_base_items
// ---------------------------------------------------------------------------

function mockAllQueries({
  brands = "0",
  locations = "0",
  channels = "0",
  productRows = [] as { status: string; count: string }[],
  brandsWithoutProducts = "0",
  totalBaseItems = "0",
  lowStockBaseItems = "0",
  outOfStockBaseItems = "0",
} = {}) {
  mockDbQuery
    .mockResolvedValueOnce({ rows: [{ count: brands }] })
    .mockResolvedValueOnce({ rows: [{ count: locations }] })
    .mockResolvedValueOnce({ rows: [{ count: channels }] })
    .mockResolvedValueOnce({ rows: productRows })
    .mockResolvedValueOnce({ rows: [{ count: brandsWithoutProducts }] })
    .mockResolvedValueOnce({ rows: [{ count: totalBaseItems }] })
    .mockResolvedValueOnce({ rows: [{ count: lowStockBaseItems }] })
    .mockResolvedValueOnce({ rows: [{ count: outOfStockBaseItems }] });
}

// ---------------------------------------------------------------------------
// GET /dashboard/summary — empty workspace
// ---------------------------------------------------------------------------

describe("GET /dashboard/summary — empty workspace (all zeroes)", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubAssignedLocationIds = null;
  });

  it("returns 200 with all counts as 0 when the workspace has no data", async () => {
    mockAllQueries();

    const res = await request(app).get("/dashboard/summary");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      brands_without_products: 0,
      total_base_items: 0,
      low_stock_base_items: 0,
      out_of_stock_base_items: 0,
    });
  });

  it("returns 200 and includes all four new fields in the response body", async () => {
    mockAllQueries();

    const res = await request(app).get("/dashboard/summary");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("brands_without_products");
    expect(res.body).toHaveProperty("total_base_items");
    expect(res.body).toHaveProperty("low_stock_base_items");
    expect(res.body).toHaveProperty("out_of_stock_base_items");
  });
});

// ---------------------------------------------------------------------------
// GET /dashboard/summary — brands_without_products
// ---------------------------------------------------------------------------

describe("GET /dashboard/summary — brands_without_products", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubAssignedLocationIds = null;
  });

  it("returns the correct count when some brands have no products", async () => {
    mockAllQueries({ brandsWithoutProducts: "3" });

    const res = await request(app).get("/dashboard/summary");

    expect(res.status).toBe(200);
    expect(res.body.brands_without_products).toBe(3);
  });

  it("returns 0 when all brands have at least one product", async () => {
    mockAllQueries({ brands: "5", brandsWithoutProducts: "0" });

    const res = await request(app).get("/dashboard/summary");

    expect(res.status).toBe(200);
    expect(res.body.brands_without_products).toBe(0);
  });

  it("queries with workspace_owner_id for brands_without_products isolation", async () => {
    stubWorkspaceOwnerId = "ws_isolated";
    mockAllQueries({ brandsWithoutProducts: "1" });

    await request(app).get("/dashboard/summary");

    const brandsWithoutProductsCall = mockDbQuery.mock.calls[4];
    const [sql, params] = brandsWithoutProductsCall;
    expect(params).toContain("ws_isolated");
    expect(sql).toMatch(/workspace_owner_id/i);
  });

  it("includes NOT EXISTS guard in brands_without_products SQL", async () => {
    mockAllQueries({ brandsWithoutProducts: "2" });

    await request(app).get("/dashboard/summary");

    const [sql] = mockDbQuery.mock.calls[4];
    expect(sql).toMatch(/NOT EXISTS/i);
  });
});

// ---------------------------------------------------------------------------
// GET /dashboard/summary — total_base_items
// ---------------------------------------------------------------------------

describe("GET /dashboard/summary — total_base_items", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubAssignedLocationIds = null;
  });

  it("returns the correct total_base_items count", async () => {
    mockAllQueries({ totalBaseItems: "42" });

    const res = await request(app).get("/dashboard/summary");

    expect(res.status).toBe(200);
    expect(res.body.total_base_items).toBe(42);
  });

  it("returns 0 for total_base_items when the table is empty", async () => {
    mockAllQueries({ totalBaseItems: "0" });

    const res = await request(app).get("/dashboard/summary");

    expect(res.status).toBe(200);
    expect(res.body.total_base_items).toBe(0);
  });

  it("queries base_items with workspace_owner_id for total_base_items", async () => {
    stubWorkspaceOwnerId = "ws_base_items";
    mockAllQueries({ totalBaseItems: "10" });

    await request(app).get("/dashboard/summary");

    const [sql, params] = mockDbQuery.mock.calls[5];
    expect(sql).toMatch(/base_items/i);
    expect(params).toContain("ws_base_items");
  });
});

// ---------------------------------------------------------------------------
// GET /dashboard/summary — low_stock_base_items
// ---------------------------------------------------------------------------

describe("GET /dashboard/summary — low_stock_base_items", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubAssignedLocationIds = null;
  });

  it("returns the correct low_stock_base_items count", async () => {
    mockAllQueries({ totalBaseItems: "20", lowStockBaseItems: "5" });

    const res = await request(app).get("/dashboard/summary");

    expect(res.status).toBe(200);
    expect(res.body.low_stock_base_items).toBe(5);
  });

  it("returns 0 when no base items are low in stock", async () => {
    mockAllQueries({ totalBaseItems: "10", lowStockBaseItems: "0" });

    const res = await request(app).get("/dashboard/summary");

    expect(res.status).toBe(200);
    expect(res.body.low_stock_base_items).toBe(0);
  });

  it("queries with stock > 0 and stock <= low_stock_threshold conditions", async () => {
    mockAllQueries({ lowStockBaseItems: "3" });

    await request(app).get("/dashboard/summary");

    const [sql] = mockDbQuery.mock.calls[6];
    expect(sql).toMatch(/stock\s*>/i);
    expect(sql).toMatch(/low_stock_threshold/i);
    expect(sql).toMatch(/stock\s*<=/i);
  });

  it("queries low_stock_base_items with workspace_owner_id", async () => {
    stubWorkspaceOwnerId = "ws_lowstock";
    mockAllQueries({ lowStockBaseItems: "7" });

    await request(app).get("/dashboard/summary");

    const [, params] = mockDbQuery.mock.calls[6];
    expect(params).toContain("ws_lowstock");
  });
});

// ---------------------------------------------------------------------------
// GET /dashboard/summary — out_of_stock_base_items
// ---------------------------------------------------------------------------

describe("GET /dashboard/summary — out_of_stock_base_items", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubAssignedLocationIds = null;
  });

  it("returns the correct out_of_stock_base_items count", async () => {
    mockAllQueries({ totalBaseItems: "15", outOfStockBaseItems: "4" });

    const res = await request(app).get("/dashboard/summary");

    expect(res.status).toBe(200);
    expect(res.body.out_of_stock_base_items).toBe(4);
  });

  it("returns 0 when no base items are out of stock", async () => {
    mockAllQueries({ totalBaseItems: "8", outOfStockBaseItems: "0" });

    const res = await request(app).get("/dashboard/summary");

    expect(res.status).toBe(200);
    expect(res.body.out_of_stock_base_items).toBe(0);
  });

  it("queries with stock <= 0 condition for out_of_stock_base_items", async () => {
    mockAllQueries({ outOfStockBaseItems: "2" });

    await request(app).get("/dashboard/summary");

    const [sql] = mockDbQuery.mock.calls[7];
    expect(sql).toMatch(/stock\s*<=/i);
  });

  it("queries out_of_stock_base_items with workspace_owner_id", async () => {
    stubWorkspaceOwnerId = "ws_oos";
    mockAllQueries({ outOfStockBaseItems: "9" });

    await request(app).get("/dashboard/summary");

    const [, params] = mockDbQuery.mock.calls[7];
    expect(params).toContain("ws_oos");
  });
});

// ---------------------------------------------------------------------------
// GET /dashboard/summary — partial data (mixed state)
// ---------------------------------------------------------------------------

describe("GET /dashboard/summary — partial / mixed data", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubAssignedLocationIds = null;
  });

  it("returns correct counts across all four new fields simultaneously", async () => {
    mockAllQueries({
      brands: "10",
      locations: "3",
      channels: "2",
      productRows: [
        { status: "available", count: "8" },
        { status: "out_of_stock", count: "2" },
      ],
      brandsWithoutProducts: "4",
      totalBaseItems: "50",
      lowStockBaseItems: "12",
      outOfStockBaseItems: "6",
    });

    const res = await request(app).get("/dashboard/summary");

    expect(res.status).toBe(200);
    expect(res.body.brands_without_products).toBe(4);
    expect(res.body.total_base_items).toBe(50);
    expect(res.body.low_stock_base_items).toBe(12);
    expect(res.body.out_of_stock_base_items).toBe(6);
  });

  it("brands_without_products can equal total_brands when no brand has products", async () => {
    mockAllQueries({
      brands: "3",
      brandsWithoutProducts: "3",
      totalBaseItems: "0",
      lowStockBaseItems: "0",
      outOfStockBaseItems: "0",
    });

    const res = await request(app).get("/dashboard/summary");

    expect(res.status).toBe(200);
    expect(res.body.total_brands).toBe(3);
    expect(res.body.brands_without_products).toBe(3);
  });

  it("out_of_stock_base_items and low_stock_base_items are independent counts", async () => {
    mockAllQueries({
      totalBaseItems: "30",
      lowStockBaseItems: "8",
      outOfStockBaseItems: "5",
    });

    const res = await request(app).get("/dashboard/summary");

    expect(res.status).toBe(200);
    expect(res.body.low_stock_base_items).toBe(8);
    expect(res.body.out_of_stock_base_items).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// GET /dashboard/summary — location-restricted access
// ---------------------------------------------------------------------------

describe("GET /dashboard/summary — location-restricted access", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubAssignedLocationIds = [1, 2];
  });

  it("returns 200 with correct counts when location-restricted", async () => {
    mockAllQueries({
      brands: "2",
      locations: "2",
      channels: "1",
      brandsWithoutProducts: "1",
      totalBaseItems: "20",
      lowStockBaseItems: "3",
      outOfStockBaseItems: "1",
    });

    const res = await request(app).get("/dashboard/summary");

    expect(res.status).toBe(200);
    expect(res.body.brands_without_products).toBe(1);
    expect(res.body.total_base_items).toBe(20);
    expect(res.body.low_stock_base_items).toBe(3);
    expect(res.body.out_of_stock_base_items).toBe(1);
  });

  it("passes assignedLocationIds to the brands_without_products query when location-restricted", async () => {
    stubAssignedLocationIds = [5, 10];
    mockAllQueries({ brandsWithoutProducts: "2" });

    await request(app).get("/dashboard/summary");

    const [sql, params] = mockDbQuery.mock.calls[4];
    expect(sql).toMatch(/location_brands/i);
    expect(params).toContain("owner_123");
    expect(params).toContainEqual([5, 10]);
  });

  it("base item queries remain workspace-wide even when location-restricted", async () => {
    stubAssignedLocationIds = [3];
    mockAllQueries({ totalBaseItems: "25", lowStockBaseItems: "4", outOfStockBaseItems: "2" });

    await request(app).get("/dashboard/summary");

    const [totalSql] = mockDbQuery.mock.calls[5];
    const [lowSql] = mockDbQuery.mock.calls[6];
    const [oosSql] = mockDbQuery.mock.calls[7];

    expect(totalSql).not.toMatch(/location_brands/i);
    expect(lowSql).not.toMatch(/location_brands/i);
    expect(oosSql).not.toMatch(/location_brands/i);
  });

  it("brands_without_products returns 0 when all location-linked brands have products", async () => {
    stubAssignedLocationIds = [1];
    mockAllQueries({ brands: "3", brandsWithoutProducts: "0" });

    const res = await request(app).get("/dashboard/summary");

    expect(res.status).toBe(200);
    expect(res.body.brands_without_products).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// GET /dashboard/operations-summary
// ---------------------------------------------------------------------------

describe("GET /dashboard/operations-summary", () => {
  const app = makeApp();
  const path = "/dashboard/operations-summary?date=2026-08-19&tz=Asia%2FBeirut";

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_ops";
    stubWorkspaceRole = "member";
    stubAllowedPages = ["ops-dashboard"];
    stubAssignedLocationIds = null;
  });

  function mockOperationsCounts(
    florist = 0,
    cmc = 0,
    processing = 0,
  ) {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ count: florist }] })
      .mockResolvedValueOnce({ rows: [{ count: cmc }] })
      .mockResolvedValueOnce({ rows: [{ count: processing }] });
  }

  it("denies members without the Ops Dashboard permission", async () => {
    stubAllowedPages = ["orders"];

    const res = await request(app).get(path);

    expect(res.status).toBe(403);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("admits owners without changing their allowed-pages model", async () => {
    stubWorkspaceRole = "owner";
    stubAllowedPages = null;
    mockOperationsCounts();

    const res = await request(app).get(path);

    expect(res.status).toBe(200);
  });

  it("returns a clean all-zero response", async () => {
    mockOperationsCounts();

    const res = await request(app).get(path);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      florist_manual_review_count: 0,
      cmc_submitted_request_count: 0,
      processing_orders_today_count: 0,
    });
  });

  it("returns all mixed action counts in one response", async () => {
    mockOperationsCounts(4, 2, 11);

    const res = await request(app).get(path);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      florist_manual_review_count: 4,
      cmc_submitted_request_count: 2,
      processing_orders_today_count: 11,
    });
  });

  it("isolates every count to the resolved workspace", async () => {
    stubWorkspaceOwnerId = "workspace_isolated";
    mockOperationsCounts(1, 2, 3);

    await request(app).get(path);

    expect(mockDbQuery).toHaveBeenCalledTimes(3);
    for (const [sql, params] of mockDbQuery.mock.calls) {
      expect(sql).toMatch(/workspace_owner_id\s*=\s*\$1/i);
      expect(params[0]).toBe("workspace_isolated");
    }
  });

  it("uses the exact florist manual-review eligibility filters", async () => {
    mockOperationsCounts();

    await request(app).get(path);

    const [sql] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/status\s*<>\s*'completed'/i);
    expect(sql).toMatch(/verification_status\s*=\s*'rejected'/i);
    expect(sql).toMatch(/photo_items_path\s+IS NOT NULL/i);
    expect(sql).toMatch(/photo_card_path\s+IS NOT NULL/i);
    expect(sql).toMatch(/JOIN\s+orders\s+o/i);
    expect(sql).toMatch(/btrim\(o\.card_message\)\s+<> ''/i);
  });

  it("counts only submitted CMC requests", async () => {
    mockOperationsCounts();

    await request(app).get(path);

    const [sql] = mockDbQuery.mock.calls[1];
    expect(sql).toMatch(/FROM cmc_requests/i);
    expect(sql).toMatch(/status\s*=\s*'submitted'/i);
  });

  it("matches processing orders by explicit delivery date before zoned window fallback", async () => {
    mockOperationsCounts();

    await request(app).get(path);

    const [sql, params] = mockDbQuery.mock.calls[2];
    expect(sql).toMatch(/o\.status\s*=\s*'processing'/i);
    expect(sql).toMatch(/CASE/i);
    expect(sql).toMatch(/delivery_address->>'date'/i);
    expect(sql).toMatch(/window_start AT TIME ZONE \$2/i);
    expect(sql).not.toMatch(/substring\(/i);
    expect(sql).not.toMatch(/delivery_address->>'date'\s*FROM/i);
    expect(params).toEqual(["owner_ops", "Asia/Beirut", "2026-08-19"]);
  });

  it.each([
    "/dashboard/operations-summary?date=2026-02-30&tz=Asia%2FBeirut",
    "/dashboard/operations-summary?date=2026-08-19&tz=Not%2FAZone",
    "/dashboard/operations-summary?date=19-08-2026&tz=Asia%2FBeirut",
  ])("rejects invalid local calendar inputs: %s", async (invalidPath) => {
    const res = await request(app).get(invalidPath);

    expect(res.status).toBe(400);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });
});
