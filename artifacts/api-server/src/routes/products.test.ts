import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

const mockDbQuery = vi.fn();
const mockClientRelease = vi.fn();
const mockClientQuery = vi.fn((statement: unknown, ...params: unknown[]) => {
  const sql = String(statement);
  // Transaction control and the row lock are infrastructure for the recipe
  // write; keep the existing query-result fixtures focused on mutations.
  if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
    return Promise.resolve({ rows: [], rowCount: 0 });
  }
  if (/FROM products[\s\S]*FOR UPDATE/i.test(sql)) {
    return Promise.resolve({ rows: [{ id: 1 }], rowCount: 1 });
  }
  return mockDbQuery(statement, ...params);
});

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
    connect: () => Promise.resolve({
      query: mockClientQuery,
      release: mockClientRelease,
    }),
  },
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  authed: (req: express.Request) => req,
}));

let stubWorkspaceOwnerId = "owner_123";
let stubActualRole = "owner";

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = stubWorkspaceOwnerId;
    wreq.workspaceActualRole = stubActualRole;
    wreq.workspaceRole = stubActualRole === "owner" ? "owner" : "member";
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
  hasPageAccess: () => true,
}));

vi.mock("../lib/catalogWebhook", () => ({
  fireCatalogDataWebhook: vi.fn().mockResolvedValue(undefined),
}));

// Product route tests own database sequencing for the route itself. Keep
// post-commit integrations isolated so their asynchronous queries cannot
// consume fixtures belonging to the next request/test.
vi.mock("../lib/merchantSyncQueue", () => ({
  enqueueProductCreateOrUpdateSync: vi.fn().mockResolvedValue(undefined),
  enqueueProductDeleteSync: vi.fn().mockResolvedValue(undefined),
  enqueueMerchantSyncBackfill: vi.fn(),
  enqueueSelectedMerchantSync: vi.fn(),
  enqueueSelectedMerchantUnsync: vi.fn(),
}));

vi.mock("../lib/productPublicImages", () => ({
  syncProductPublicImages: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/productPublishing", () => ({
  autoPublishToChannels: vi.fn().mockResolvedValue(undefined),
  notifyProductChanged: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/objectStorage", () => ({
  buildPublicObjectUrl: (path: string | null | undefined) =>
    path
      ? `https://os.presentail.com/api/storage/public-objects/${path}`
      : null,
  objectStorageClient: {
    bucket: () => ({
      file: () => ({
        save: vi.fn().mockResolvedValue(undefined),
      }),
    }),
  },
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import productsRouter from "./products";

// ---------------------------------------------------------------------------
// Test app
// ---------------------------------------------------------------------------

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(productsRouter);
  return app;
}

// ---------------------------------------------------------------------------
// Test app — variant that attaches a silent req.log stub
// ---------------------------------------------------------------------------

const mockReqLogError = vi.fn();

function makeAppWithLog() {
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
  app.use(productsRouter);
  return app;
}

// ---------------------------------------------------------------------------
// Sample product row fixture
// ---------------------------------------------------------------------------

function makeProductRow(overrides: Partial<{
  id: number;
  workspace_owner_id: string;
  name: string;
  price_usd: string;
  price_aed: string;
  main_image_url: string | null;
  additional_image_urls: string[];
  image_display_public_path: string | null;
  image_thumbnail_public_path: string | null;
  description: string | null;
  status: string;
  brand: string | null;
  tags: string[];
  category: string | null;
  sku: string | null;
  created_at: string;
  is_archived: boolean;
  delivery_disabled_count: number;
}> = {}) {
  return {
    id: 1,
    workspace_owner_id: "owner_123",
    name: "Widget Pro",
    price_usd: "9.99",
    price_aed: "36.70",
    main_image_url: null,
    additional_image_urls: [],
    description: null,
    status: "available",
    brand: "Acme",
    tags: [],
    category: "Gadgets",
    sku: null,
    created_at: "2024-01-01T00:00:00Z",
    is_archived: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// GET /products — list / search / filter
// ---------------------------------------------------------------------------

describe("GET /products — response validation", () => {
  const app = makeAppWithLog();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [{ count: "0" }], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
  });

  it("returns 500 and logs when a row fails response validation", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "0" }] });
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ ...makeProductRow(), id: "not-a-number" }],
    });

    const res = await request(app).get("/products");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal server error" });
    expect(mockReqLogError).toHaveBeenCalledWith(
      expect.objectContaining({ route: "GET /products", err: expect.any(Array) }),
      "Response validation failed",
    );
  });
});

describe("GET /products/merchant-database-diagnostic", () => {
  const app = makeAppWithLog();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
  });

  it("returns only non-secret database identity and Merchant table presence", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{
        database_name: "neondb",
        product_count: "1006",
        merchant_offer_states_exists: false,
        merchant_reconciliation_runs_exists: false,
        merchant_reconciliation_items_exists: false,
      }],
    });

    const res = await request(app).get("/products/merchant-database-diagnostic");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      database: "neondb",
      productCount: 1006,
      tables: {
        merchantOfferStates: false,
        merchantReconciliationRuns: false,
        merchantReconciliationItems: false,
      },
    });
    expect(mockDbQuery).toHaveBeenCalledOnce();
    expect(String(mockDbQuery.mock.calls[0][0])).toContain("current_database()");
  });

  it("rejects non-owners without querying the database", async () => {
    stubActualRole = "member";

    const res = await request(app).get("/products/merchant-database-diagnostic");

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Owner access required" });
    expect(mockDbQuery).not.toHaveBeenCalled();
  });
});

describe("GET /products — list products", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [{ count: "0" }], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
  });

  it("returns 200 with a products array when no filters are applied", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "0" }] });
    mockDbQuery.mockResolvedValueOnce({ rows: [makeProductRow()] });

    const res = await request(app).get("/products");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("products");
    expect(res.body.products).toHaveLength(1);
    expect(res.body.products[0].name).toBe("Widget Pro");
  });

  it("exposes optimized product URLs while preserving the original source", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "1" }] });
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        makeProductRow({
          main_image_url: "/objects/owner_123/products/original",
          image_display_public_path: "products/1/main-display-1234567890abcdef.webp",
          image_thumbnail_public_path: "products/1/main-thumbnail-1234567890abcdef.webp",
        }),
      ],
    });

    const res = await request(app).get("/products");

    expect(res.status).toBe(200);
    expect(res.body.products[0].main_image_url).toBe(
      "/objects/owner_123/products/original",
    );
    expect(res.body.products[0].main_image_thumbnail_url).toContain(
      "main-thumbnail-1234567890abcdef.webp",
    );
    expect(res.body.products[0]).not.toHaveProperty(
      "image_thumbnail_public_path",
    );
  });

  it("returns 200 with an empty products array when no products exist", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "0" }] });
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get("/products");

    expect(res.status).toBe(200);
    expect(res.body.products).toEqual([]);
  });

  it("scopes the query to the workspace owner id from context", async () => {
    stubWorkspaceOwnerId = "ws_scoped";
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products");

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(params).toContain("ws_scoped");
    expect(sql).toMatch(/workspace_owner_id/i);
  });

  // -------------------------------------------------------------------------
  // Search by name (?q=)
  // -------------------------------------------------------------------------

  it("adds an ILIKE filter on name when ?q= is provided", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?q=badge");

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/name\s+ILIKE/i);
    expect(params).toContain("%badge%");
  });

  it("returns only products matching the search term", async () => {
    const matching = makeProductRow({ name: "Badge Holder" });
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "0" }] });
    mockDbQuery.mockResolvedValueOnce({ rows: [matching] });

    const res = await request(app).get("/products?q=badge");

    expect(res.status).toBe(200);
    expect(res.body.products).toHaveLength(1);
    expect(res.body.products[0].name).toBe("Badge Holder");
  });

  it("returns an empty array when no product name matches the search term", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "0" }] });
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get("/products?q=nonexistent");

    expect(res.status).toBe(200);
    expect(res.body.products).toEqual([]);
  });

  it("uses ILIKE so case-insensitive matching is handled by the database", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?q=WIDGET");

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/name\s+ILIKE/i);
    const likeParam = params.find((p: unknown) => typeof p === "string" && (p as string).startsWith("%"));
    expect(likeParam).toBe("%WIDGET%");
  });

  it("ignores a whitespace-only ?q= value (no ILIKE condition added)", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?q=   ");

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).not.toMatch(/name\s+ILIKE/i);
    const likeParam = params.find((p: unknown) => typeof p === "string" && (p as string).startsWith("%"));
    expect(likeParam).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Search by SKU (?q= with a numeric SKU value)
  // -------------------------------------------------------------------------

  it("includes a sku ILIKE condition in the WHERE clause when ?q= is provided", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?q=042711");

    const [sql] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/sku\s+ILIKE/i);
  });

  it("matches a product by its exact 6-digit SKU", async () => {
    const product = makeProductRow({ name: "Badge Holder", sku: "042711" });
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "0" }] });
    mockDbQuery.mockResolvedValueOnce({ rows: [product] });

    const res = await request(app).get("/products?q=042711");

    expect(res.status).toBe(200);
    expect(res.body.products).toHaveLength(1);
    expect(res.body.products[0].name).toBe("Badge Holder");
  });

  it("matches a product by a partial SKU prefix", async () => {
    const product = makeProductRow({ name: "Tag Reel", sku: "042711" });
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "0" }] });
    mockDbQuery.mockResolvedValueOnce({ rows: [product] });

    const res = await request(app).get("/products?q=0427");

    expect(res.status).toBe(200);
    expect(res.body.products).toHaveLength(1);
  });

  it("passes the same ILIKE parameter for both name and sku conditions", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?q=042711");

    const [sql, params] = mockDbQuery.mock.calls[0];
    const likeParam = params.find((p: unknown) => typeof p === "string" && (p as string).includes("042711"));
    expect(likeParam).toBe("%042711%");
    expect(sql).toMatch(/name\s+ILIKE\s+\$\d+\s+ESCAPE\s+'\\'\s+OR\s+(?:p\.)?sku\s+ILIKE\s+\$\d+/i);
  });

  it("returns an empty array when the SKU does not match any product", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "0" }] });
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get("/products?q=999999");

    expect(res.status).toBe(200);
    expect(res.body.products).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Filter by status (?status=)
  // -------------------------------------------------------------------------

  it("adds a status IN filter when ?status= is provided", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?status=available");

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/status\s+IN\s*\(\$\d+\)/i);
    expect(params).toContain("available");
  });

  it("returns only products with the requested status", async () => {
    const product = makeProductRow({ status: "out_of_stock" });
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "0" }] });
    mockDbQuery.mockResolvedValueOnce({ rows: [product] });

    const res = await request(app).get("/products?status=out_of_stock");

    expect(res.status).toBe(200);
    expect(res.body.products[0].status).toBe("out_of_stock");
  });

  it("returns an empty array when no products have the requested status", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "0" }] });
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get("/products?status=not_available");

    expect(res.status).toBe(200);
    expect(res.body.products).toEqual([]);
  });

  it("returns total_delivery_cities and a per-product delivery_disabled_count", async () => {
    const product = makeProductRow({ delivery_disabled_count: 2 });
    // count, select (with the disabled-count subquery), then workspace city count
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "1" }] });
    mockDbQuery.mockResolvedValueOnce({ rows: [product] });
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "8" }] });

    const res = await request(app).get("/products");

    expect(res.status).toBe(200);
    expect(res.body.total_delivery_cities).toBe(8);
    expect(res.body.products[0].delivery_disabled_count).toBe(2);
    // The select query carries the disabled-count subquery against
    // product_city_availability.
    const [selectSql] = mockDbQuery.mock.calls[1];
    expect(selectSql).toMatch(/product_city_availability/i);
    expect(selectSql).toMatch(/delivery_disabled_count/i);
  });

  it("omits the status filter clause when ?status= is empty", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?status=");

    const [sql] = mockDbQuery.mock.calls[0];
    expect(sql).not.toMatch(/status\s+IN/i);
  });

  // -------------------------------------------------------------------------
  // Multi-status filter (?status=x&status=y)
  // -------------------------------------------------------------------------

  it("builds a multi-value IN clause when two status params are provided", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?status=available&status=out_of_stock");

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/status\s+IN\s*\(\$\d+,\s*\$\d+\)/i);
    expect(params).toContain("available");
    expect(params).toContain("out_of_stock");
  });

  it("returns products matching any of the requested statuses", async () => {
    const p1 = makeProductRow({ id: 1, status: "available" });
    const p2 = makeProductRow({ id: 2, status: "out_of_stock" });
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "0" }] });
    mockDbQuery.mockResolvedValueOnce({ rows: [p1, p2] });

    const res = await request(app).get("/products?status=available&status=out_of_stock");

    expect(res.status).toBe(200);
    expect(res.body.products).toHaveLength(2);
    const statuses = res.body.products.map((p: { status: string }) => p.status);
    expect(statuses).toContain("available");
    expect(statuses).toContain("out_of_stock");
  });

  it("returns an empty array when no products match any of the requested statuses", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "0" }] });
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get("/products?status=available&status=out_of_stock");

    expect(res.status).toBe(200);
    expect(res.body.products).toEqual([]);
  });

  it("supports all three valid statuses in a single multi-status request", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?status=available&status=out_of_stock&status=not_available");

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/status\s+IN\s*\(\$\d+,\s*\$\d+,\s*\$\d+\)/i);
    expect(params).toContain("available");
    expect(params).toContain("out_of_stock");
    expect(params).toContain("not_available");
  });

  it("ignores invalid status values and omits the filter entirely when all values are invalid", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?status=discontinued&status=archived");

    const [sql] = mockDbQuery.mock.calls[0];
    expect(sql).not.toMatch(/status\s+IN/i);
  });

  it("ignores invalid status values mixed with valid ones and only passes valid values to the query", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?status=available&status=discontinued");

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/status\s+IN\s*\(\$\d+\)/i);
    expect(params).toContain("available");
    expect(params).not.toContain("discontinued");
  });

  it("single ?status=available still works (backward compatibility)", async () => {
    const product = makeProductRow({ status: "available" });
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "0" }] });
    mockDbQuery.mockResolvedValueOnce({ rows: [product] });

    const res = await request(app).get("/products?status=available");

    expect(res.status).toBe(200);
    expect(res.body.products).toHaveLength(1);
    expect(res.body.products[0].status).toBe("available");

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/status\s+IN\s*\(\$\d+\)/i);
    expect(params).toContain("available");
  });

  // -------------------------------------------------------------------------
  // Filter by brand (?brand=) — partial ILIKE matching
  // -------------------------------------------------------------------------

  it("uses ILIKE with a %wrapped% pattern for brand matching", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?brand=Acme");

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/lower\((?:p\.)?brand\)\s+ILIKE\s+lower\(\$\d+\)/i);
    expect(params).toContain("%Acme%");
  });

  it("returns only products matching the requested brand (exact value)", async () => {
    const product = makeProductRow({ brand: "Globex" });
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "0" }] });
    mockDbQuery.mockResolvedValueOnce({ rows: [product] });

    const res = await request(app).get("/products?brand=Globex");

    expect(res.status).toBe(200);
    expect(res.body.products[0].brand).toBe("Globex");
  });

  it("returns products matching a partial brand search term (e.g. 'nik' matches 'Nike')", async () => {
    const product = makeProductRow({ brand: "Nike" });
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "0" }] });
    mockDbQuery.mockResolvedValueOnce({ rows: [product] });

    const res = await request(app).get("/products?brand=nik");

    expect(res.status).toBe(200);
    expect(res.body.products[0].brand).toBe("Nike");
  });

  it("passes %wrapped% ILIKE pattern for a partial brand term", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?brand=nik");

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/lower\((?:p\.)?brand\)\s+ILIKE/i);
    expect(params).toContain("%nik%");
  });

  it("returns an empty array when no products belong to the requested brand", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "0" }] });
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get("/products?brand=Unknown");

    expect(res.status).toBe(200);
    expect(res.body.products).toEqual([]);
  });

  it("omits the brand filter clause when ?brand= is empty", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?brand=");

    const [sql] = mockDbQuery.mock.calls[0];
    expect(sql).not.toMatch(/brand\s+ILIKE/i);
  });

  it("includes an ESCAPE clause in the brand ILIKE condition", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?brand=Acme");

    const [sql] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/ESCAPE/i);
  });

  it("escapes a % character in the brand search term so it is treated as a literal", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?brand=50%25off");

    const [, params] = mockDbQuery.mock.calls[0];
    expect(params).toContain("%50\\%off%");
  });

  it("escapes an _ character in the brand search term so it is treated as a literal", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?brand=my_brand");

    const [, params] = mockDbQuery.mock.calls[0];
    expect(params).toContain("%my\\_brand%");
  });

  it("escapes a backslash in the brand search term", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?brand=a%5Cb");

    const [, params] = mockDbQuery.mock.calls[0];
    expect(params).toContain("%a\\\\b%");
  });

  it("creates an OR condition across multiple brand ILIKE clauses", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?brand=Acme&brand=Globex");

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/lower\((?:p\.)?brand\)\s+ILIKE\s+lower\(\$\d+\).*OR.*lower\((?:p\.)?brand\)\s+ILIKE\s+lower\(\$\d+\)/is);
    expect(params).toContain("%Acme%");
    expect(params).toContain("%Globex%");
  });

  it("returns products matching any of the selected brands (multi-brand filter)", async () => {
    const acmeProduct = makeProductRow({ id: 1, name: "Acme Widget", brand: "Acme" });
    const globexProduct = makeProductRow({ id: 2, name: "Globex Bag", brand: "Globex" });
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "0" }] });
    mockDbQuery.mockResolvedValueOnce({ rows: [acmeProduct, globexProduct] });

    const res = await request(app).get("/products?brand=Acme&brand=Globex");

    expect(res.status).toBe(200);
    expect(res.body.products).toHaveLength(2);
    expect(res.body.products.map((p: { brand: string }) => p.brand)).toEqual(
      expect.arrayContaining(["Acme", "Globex"]),
    );
  });

  it("returns an empty array when no products match any of the selected brands", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "0" }] });
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get("/products?brand=BrandX&brand=BrandY");

    expect(res.status).toBe(200);
    expect(res.body.products).toEqual([]);
  });

  it("handles three or more brands in the multi-select filter", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?brand=Alpha&brand=Beta&brand=Gamma");

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/lower\((?:p\.)?brand\)\s+ILIKE\s+lower\(\$\d+\).*OR.*lower\((?:p\.)?brand\)\s+ILIKE\s+lower\(\$\d+\).*OR.*lower\((?:p\.)?brand\)\s+ILIKE\s+lower\(\$\d+\)/is);
    expect(params).toContain("%Alpha%");
    expect(params).toContain("%Beta%");
    expect(params).toContain("%Gamma%");
  });

  it("generates lower(brand) ILIKE lower($n) SQL when brand query is all uppercase", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?brand=ACME");

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/lower\((?:p\.)?brand\)\s+ILIKE\s+lower\(\$\d+\)/i);
    expect(params).toContain("%ACME%");
  });

  it("matches a mixed-case stored brand when the query uses uppercase (ACME matches Acme)", async () => {
    const product = makeProductRow({ brand: "Acme" });
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "0" }] });
    mockDbQuery.mockResolvedValueOnce({ rows: [product] });

    const res = await request(app).get("/products?brand=ACME");

    expect(res.status).toBe(200);
    expect(res.body.products).toHaveLength(1);
    expect(res.body.products[0].brand).toBe("Acme");
  });

  it("generates lower(brand) ILIKE lower($n) SQL when brand query is mixed case (e.g. AcMe)", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?brand=AcMe");

    const [sql] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/lower\((?:p\.)?brand\)\s+ILIKE\s+lower\(\$\d+\)/i);
  });

  // -------------------------------------------------------------------------
  // Multi-brand filter (?brand=x&brand=y)
  // -------------------------------------------------------------------------

  it("builds ILIKE OR clauses with correct positional params when two brands are provided", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?brand=Acme&brand=Globex");

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/lower\((?:p\.)?brand\)\s+ILIKE\s+lower\(\$2\).*OR.*lower\((?:p\.)?brand\)\s+ILIKE\s+lower\(\$3\)/is);
    expect(params[1]).toBe("%Acme%");
    expect(params[2]).toBe("%Globex%");
  });

  it("wraps brand values in wildcards for partial substring matching", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?brand=Acme&brand=Globex");

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/lower\((?:p\.)?brand\)\s+ILIKE/i);
    expect(params).toContain("%Acme%");
    expect(params).toContain("%Globex%");
  });

  it("returns products matching any of the requested brands", async () => {
    const p1 = makeProductRow({ id: 1, brand: "Acme" });
    const p2 = makeProductRow({ id: 2, brand: "Globex" });
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "0" }] });
    mockDbQuery.mockResolvedValueOnce({ rows: [p1, p2] });

    const res = await request(app).get("/products?brand=Acme&brand=Globex");

    expect(res.status).toBe(200);
    expect(res.body.products).toHaveLength(2);
    const brands = res.body.products.map((p: { brand: string }) => p.brand);
    expect(brands).toContain("Acme");
    expect(brands).toContain("Globex");
  });

  it("returns an empty array when no products match any of the requested brands", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "0" }] });
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get("/products?brand=Acme&brand=Globex");

    expect(res.status).toBe(200);
    expect(res.body.products).toEqual([]);
  });

  it("strips empty brand values from a multi-brand request", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?brand=Acme&brand=");

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/lower\((?:p\.)?brand\)\s+ILIKE\s+lower\(\$\d+\)/i);
    expect(params).toContain("%Acme%");
    expect(params).not.toContain("");
  });

  it("omits the brand filter entirely when all brand values are empty strings", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?brand=&brand=");

    const [sql] = mockDbQuery.mock.calls[0];
    expect(sql).not.toMatch(/brand\s+ILIKE/i);
  });

  // -------------------------------------------------------------------------
  // Filter by category (?category=) — partial ILIKE matching
  // -------------------------------------------------------------------------

  it("uses ILIKE with a %wrapped% pattern for category matching", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?category=Packaging");

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/lower\(cc\.name\)\s+ILIKE\s+\$\d+/i);
    expect(params).toContain("%packaging%");
  });

  it("returns only products matching the requested category (exact value)", async () => {
    const product = makeProductRow({ category: "Packaging" });
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "0" }] });
    mockDbQuery.mockResolvedValueOnce({ rows: [product] });

    const res = await request(app).get("/products?category=Packaging");

    expect(res.status).toBe(200);
    expect(res.body.products[0].category).toBe("Packaging");
  });

  it("returns products matching a partial category search term (e.g. 'foot' matches 'Footwear')", async () => {
    const product = makeProductRow({ category: "Footwear" });
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "0" }] });
    mockDbQuery.mockResolvedValueOnce({ rows: [product] });

    const res = await request(app).get("/products?category=foot");

    expect(res.status).toBe(200);
    expect(res.body.products[0].category).toBe("Footwear");
  });

  it("passes %wrapped% ILIKE pattern for a partial category term", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?category=foot");

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/lower\(cc\.name\)\s+ILIKE/i);
    expect(params).toContain("%foot%");
  });

  it("returns an empty array when no products belong to the requested category", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "0" }] });
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get("/products?category=Nonexistent");

    expect(res.status).toBe(200);
    expect(res.body.products).toEqual([]);
  });

  it("omits the category filter clause when ?category= is empty", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?category=");

    const [sql] = mockDbQuery.mock.calls[0];
    expect(sql).not.toMatch(/lower\(cc\.name\)\s+ILIKE/i);
  });

  it("includes an ESCAPE clause in the category ILIKE condition", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?category=Packaging");

    const [sql] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/ESCAPE/i);
  });

  it("escapes a % character in the category search term so it is treated as a literal", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?category=100%25cotton");

    const [, params] = mockDbQuery.mock.calls[0];
    expect(params).toContain("%100\\%cotton%");
  });

  it("escapes an _ character in the category search term so it is treated as a literal", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?category=t_shirts");

    const [, params] = mockDbQuery.mock.calls[0];
    expect(params).toContain("%t\\_shirts%");
  });

  it("escapes a backslash in the category search term", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?category=a%5Cb");

    const [, params] = mockDbQuery.mock.calls[0];
    expect(params).toContain("%a\\\\b%");
  });

  it("creates an OR condition across multiple category ILIKE clauses", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?category=Packaging&category=Bags");

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/lower\(cc\.name\)\s+ILIKE\s+\$\d+.*OR.*lower\(cc\.name\)\s+ILIKE\s+\$\d+/is);
    expect(params).toContain("%packaging%");
    expect(params).toContain("%bags%");
  });

  it("returns products matching any of the selected categories (multi-category filter)", async () => {
    const packProduct = makeProductRow({ id: 1, name: "Box", category: "Packaging" });
    const bagProduct = makeProductRow({ id: 2, name: "Tote", category: "Bags" });
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "0" }] });
    mockDbQuery.mockResolvedValueOnce({ rows: [packProduct, bagProduct] });

    const res = await request(app).get("/products?category=Packaging&category=Bags");

    expect(res.status).toBe(200);
    expect(res.body.products).toHaveLength(2);
    expect(res.body.products.map((p: { category: string }) => p.category)).toEqual(
      expect.arrayContaining(["Packaging", "Bags"]),
    );
  });

  it("returns an empty array when no products belong to any of the selected categories", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "0" }] });
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get("/products?category=CatX&category=CatY");

    expect(res.status).toBe(200);
    expect(res.body.products).toEqual([]);
  });

  it("lowercases all category values for case-insensitive matching", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?category=BAGS&category=Packaging");

    const [, params] = mockDbQuery.mock.calls[0];
    expect(params).toContain("%bags%");
    expect(params).toContain("%packaging%");
    expect(params).not.toContain("%BAGS%");
    expect(params).not.toContain("%Packaging%");
  });
  it("handles three or more categories in the multi-select filter", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?category=Bags&category=Boxes&category=Tags");

    const [, params] = mockDbQuery.mock.calls[0];
    expect(params).toContain("%bags%");
    expect(params).toContain("%boxes%");
    expect(params).toContain("%tags%");
  });

  it("strips empty category values from a multi-category request", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?category=Bags&category=");

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/lower\(cc\.name\)\s+ILIKE\s+\$\d+/i);
    expect(params).toContain("%bags%");
    expect(params).not.toContain("");
  });

  it("generates lower(category) ILIKE SQL and lowercases the param when category query is all uppercase", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?category=BAGS");

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/lower\(cc\.name\)\s+ILIKE\s+\$\d+/i);
    expect(params).toContain("%bags%");
    expect(params).not.toContain("%BAGS%");
  });

  it("matches a mixed-case stored category when the query uses uppercase (BAGS matches Bags)", async () => {
    const product = makeProductRow({ category: "Bags" });
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "0" }] });
    mockDbQuery.mockResolvedValueOnce({ rows: [product] });

    const res = await request(app).get("/products?category=BAGS");

    expect(res.status).toBe(200);
    expect(res.body.products).toHaveLength(1);
    expect(res.body.products[0].category).toBe("Bags");
  });

  it("generates lower(category) ILIKE SQL and lowercases the param when category query is mixed case (e.g. BaGs)", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?category=BaGs");

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/lower\(cc\.name\)\s+ILIKE\s+\$\d+/i);
    expect(params).toContain("%bags%");
    expect(params).not.toContain("%BaGs%");
  });

  // -------------------------------------------------------------------------
  // Multi-select combined: brand + category together
  // -------------------------------------------------------------------------

  it("applies multi-brand and multi-category ILIKE filters together", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?brand=Acme&brand=Nike&category=Bags&category=Boxes");

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/lower\((?:p\.)?brand\)\s+ILIKE\s+lower\(\$\d+\).*OR.*lower\((?:p\.)?brand\)\s+ILIKE\s+lower\(\$\d+\)/is);
    expect(sql).toMatch(/lower\(cc\.name\)\s+ILIKE\s+\$\d+.*OR.*lower\(cc\.name\)\s+ILIKE\s+\$\d+/is);
    expect(params).toContain("%Acme%");
    expect(params).toContain("%Nike%");
    expect(params).toContain("%bags%");
    expect(params).toContain("%boxes%");
  });

  it("multi-status filter uses IN clause with multiple statuses", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?status=available&status=out_of_stock");

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/status\s+IN\s+\(\$\d,\s*\$\d\)/i);
    expect(params).toContain("available");
    expect(params).toContain("out_of_stock");
  });

  it("returns products matching any of the selected statuses (multi-status filter)", async () => {
    const availProduct = makeProductRow({ id: 1, status: "available" });
    const oosProduct = makeProductRow({ id: 2, status: "out_of_stock" });
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "0" }] });
    mockDbQuery.mockResolvedValueOnce({ rows: [availProduct, oosProduct] });

    const res = await request(app).get("/products?status=available&status=out_of_stock");

    expect(res.status).toBe(200);
    expect(res.body.products).toHaveLength(2);
    expect(res.body.products.map((p: { status: string }) => p.status)).toEqual(
      expect.arrayContaining(["available", "out_of_stock"]),
    );
  });

  // -------------------------------------------------------------------------
  // Multi-category filter (?category=x&category=y)
  // -------------------------------------------------------------------------

  it("builds ILIKE OR clauses with correct positional params when two categories are provided", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?category=Bags&category=Boxes");

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/lower\(cc\.name\)\s+ILIKE\s+\$2.*OR.*lower\(cc\.name\)\s+ILIKE\s+\$3/is);
    expect(params[1]).toBe("%bags%");
    expect(params[2]).toBe("%boxes%");
  });

  it("lowercases and wraps all category values in wildcards for partial matching", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?category=Bags&category=Boxes");

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/lower\(cc\.name\)\s+ILIKE/i);
    expect(params).not.toContain("Bags");
    expect(params).not.toContain("Boxes");
    expect(params).toContain("%bags%");
    expect(params).toContain("%boxes%");
  });

  it("returns products matching any of the requested categories", async () => {
    const p1 = makeProductRow({ id: 1, category: "Bags" });
    const p2 = makeProductRow({ id: 2, category: "Boxes" });
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "0" }] });
    mockDbQuery.mockResolvedValueOnce({ rows: [p1, p2] });

    const res = await request(app).get("/products?category=Bags&category=Boxes");

    expect(res.status).toBe(200);
    expect(res.body.products).toHaveLength(2);
    const categories = res.body.products.map((p: { category: string }) => p.category);
    expect(categories).toContain("Bags");
    expect(categories).toContain("Boxes");
  });

  it("returns an empty array when no products match any of the requested categories", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "0" }] });
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get("/products?category=Bags&category=Boxes");

    expect(res.status).toBe(200);
    expect(res.body.products).toEqual([]);
  });

  it("strips empty category values from a multi-category request", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?category=Bags&category=");

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/lower\(cc\.name\)\s+ILIKE\s+\$\d+/i);
    expect(params).toContain("%bags%");
    expect(params).not.toContain("");
  });

  it("omits the category filter entirely when all category values are empty strings", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?category=&category=");

    const [sql] = mockDbQuery.mock.calls[0];
    expect(sql).not.toMatch(/lower\(cc\.name\)/i);
  });

  // -------------------------------------------------------------------------
  // Positional parameter indices — combined filters
  // Regression guard: a change in param push order would shift $N indices and
  // silently break filtered queries. These tests lock in the exact indices.
  // Push order in products.ts: $1=workspaceOwnerId, brand*, status*, category*, q?
  // -------------------------------------------------------------------------

  it("uses $2 for the brand param and $3 for the category param when category + brand are combined", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?brand=Acme&category=Bags");

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/lower\((?:p\.)?brand\)\s+ILIKE\s+lower\(\$2\)/i);
    expect(sql).toMatch(/lower\(cc\.name\)\s+ILIKE\s+\$3/i);
    expect(params[1]).toBe("%Acme%");
    expect(params[2]).toBe("%bags%");
  });

  it("uses $2 for the status param and $3 for the category param when category + status are combined", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?status=available&category=Bags");

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/status\s+IN\s*\(\$2\)/i);
    expect(sql).toMatch(/lower\(cc\.name\)\s+ILIKE\s+\$3/i);
    expect(params[1]).toBe("available");
    expect(params[2]).toBe("%bags%");
  });

  it("uses $2 for the category param and $3 for the q param when category + q are combined", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?category=Bags&q=mug");

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/lower\(cc\.name\)\s+ILIKE\s+\$2/i);
    expect(sql).toMatch(/name\s+ILIKE\s+\$3/i);
    expect(params[1]).toBe("%bags%");
    expect(params[2]).toBe("%mug%");
  });

  // Combined filters
  // -------------------------------------------------------------------------

  it("applies all four filters simultaneously when all are provided", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?q=box&status=available&brand=Acme&category=Packaging");

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/name\s+ILIKE/i);
    expect(sql).toMatch(/status\s+IN\s*\(\$\d+\)/i);
    expect(sql).toMatch(/lower\((?:p\.)?brand\)\s+ILIKE\s+lower\(\$\d+\)/i);
    expect(sql).toMatch(/lower\(cc\.name\)\s+ILIKE\s+\$\d+/i);
    expect(params).toContain("%box%");
    expect(params).toContain("available");
    expect(params).toContain("%Acme%");
    expect(params).toContain("%packaging%");
  });

  it("applies only the provided filters (no spurious conditions for absent params)", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?q=mug");

    const [sql] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/name\s+ILIKE/i);
    expect(sql).not.toMatch(/brand\s+ILIKE/i);
    expect(sql).not.toMatch(/category\s+ILIKE/i);
    expect(sql).not.toMatch(/status\s+IN/i);
  });

  it("always includes the workspace_owner_id condition even when all other filters are set", async () => {
    stubWorkspaceOwnerId = "ws_combined";
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?q=item&status=available&brand=Acme&category=Bags");

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/workspace_owner_id\s*=\s*\$1/i);
    expect(params[0]).toBe("ws_combined");
  });

  // -------------------------------------------------------------------------
  // q filter — ILIKE special-character escaping
  // -------------------------------------------------------------------------

  it("escapes % in the q filter so it is treated as a literal percent sign", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?q=50%25off");

    const [, params] = mockDbQuery.mock.calls[0];
    const qParam = params.find((p: unknown) => typeof p === "string" && (p as string).includes("50"));
    expect(qParam).toBe("%50\\%off%");
  });

  it("escapes _ in the q filter so it is treated as a literal underscore", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?q=item_code");

    const [, params] = mockDbQuery.mock.calls[0];
    const qParam = params.find((p: unknown) => typeof p === "string" && (p as string).includes("item"));
    expect(qParam).toBe("%item\\_code%");
  });

  it("escapes \\ in the q filter so it is treated as a literal backslash", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?q=path\\folder");

    const [, params] = mockDbQuery.mock.calls[0];
    const qParam = params.find((p: unknown) => typeof p === "string" && (p as string).includes("path"));
    expect(qParam).toBe("%path\\\\folder%");
  });

  it("adds an ESCAPE clause to the name and sku ILIKE conditions for the q filter", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?q=test");

    const [sql] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/name\s+ILIKE\s+\$\d+\s+ESCAPE\s+'\\'/i);
    expect(sql).toMatch(/sku\s+ILIKE\s+\$\d+\s+ESCAPE\s+'\\'/i);
  });

  it("escapes % in q when combined with a category filter", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?q=100%25&category=Bags");

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/lower\(cc\.name\)\s+ILIKE/i);
    expect(sql).toMatch(/name\s+ILIKE/i);
    const qParam = params.find((p: unknown) => typeof p === "string" && (p as string).includes("100"));
    expect(qParam).toBe("%100\\%%");
  });

  it("escapes _ in q when combined with a category filter", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?q=ref_42&category=Electronics");

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/lower\(cc\.name\)\s+ILIKE/i);
    expect(sql).toMatch(/name\s+ILIKE/i);
    const qParam = params.find((p: unknown) => typeof p === "string" && (p as string).includes("ref"));
    expect(qParam).toBe("%ref\\_42%");
  });

  it("allows members (non-owners) to list products", async () => {
    stubActualRole = "customer_service_agent";
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "0" }] });
    mockDbQuery.mockResolvedValueOnce({ rows: [makeProductRow()] });

    const res = await request(app).get("/products");

    expect(res.status).toBe(200);
    expect(res.body.products).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Brand filter — trigram index compatibility (brand ILIKE + ESCAPE)
  // -------------------------------------------------------------------------

  it("uses lower(brand) ILIKE lower($n) with an ESCAPE clause for brand filtering so the trigram index is used", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?brand=Acme");

    const [sql] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/lower\((?:p\.)?brand\)\s+ILIKE\s+lower\(\$\d+\)\s+ESCAPE/i);
  });

  it("returns products whose brand matches exactly (case-insensitive) when ?brand= is given", async () => {
    const product = makeProductRow({ brand: "Acme Corp" });
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "0" }] });
    mockDbQuery.mockResolvedValueOnce({ rows: [product] });

    const res = await request(app).get("/products?brand=Acme Corp");

    expect(res.status).toBe(200);
    expect(res.body.products).toHaveLength(1);
    expect(res.body.products[0].brand).toBe("Acme Corp");
  });

  it("returns products when the brand filter case differs from the stored value (ILIKE is case-insensitive)", async () => {
    const product = makeProductRow({ brand: "Acme" });
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "0" }] });
    mockDbQuery.mockResolvedValueOnce({ rows: [product] });

    const res = await request(app).get("/products?brand=acme");

    expect(res.status).toBe(200);
    expect(res.body.products).toHaveLength(1);
    expect(res.body.products[0].brand).toBe("Acme");
  });

  it("returns products whose brand partially matches the filter term (partial/substring match)", async () => {
    const product = makeProductRow({ brand: "Acme Corporation" });
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "0" }] });
    mockDbQuery.mockResolvedValueOnce({ rows: [product] });

    const res = await request(app).get("/products?brand=Acm");

    expect(res.status).toBe(200);
    expect(res.body.products).toHaveLength(1);
    expect(res.body.products[0].brand).toBe("Acme Corporation");

    const [, params] = mockDbQuery.mock.calls[0];
    expect(params).toContain("%Acm%");
  });

  it("returns products matching any of multiple partial brand terms (multi-value partial match)", async () => {
    const p1 = makeProductRow({ id: 1, brand: "Nike Sports" });
    const p2 = makeProductRow({ id: 2, brand: "Acme Corp" });
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "0" }] });
    mockDbQuery.mockResolvedValueOnce({ rows: [p1, p2] });

    const res = await request(app).get("/products?brand=Nik&brand=Acm");

    expect(res.status).toBe(200);
    expect(res.body.products).toHaveLength(2);

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/lower\((?:p\.)?brand\)\s+ILIKE\s+lower\(\$\d+\).*OR.*lower\((?:p\.)?brand\)\s+ILIKE\s+lower\(\$\d+\)/is);
    expect(params).toContain("%Nik%");
    expect(params).toContain("%Acm%");
  });

  it("escapes ILIKE special characters in brand values to prevent unintended wildcard matches", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?brand=50%25Off");

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/lower\((?:p\.)?brand\)\s+ILIKE\s+lower\(\$\d+\)\s+ESCAPE/i);
    const brandParam = params.find((p: unknown) => typeof p === "string" && (p as string).includes("Off"));
    expect(brandParam).toBeDefined();
    expect(brandParam).toContain("\\%");
  });

  it("returns an empty array when the brand filter matches no stored brands (exact ILIKE check)", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "0" }] });
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get("/products?brand=NonExistentBrand");

    expect(res.status).toBe(200);
    expect(res.body.products).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Free-text brand search (?brandSearch=) — partial ILIKE matching
  // -------------------------------------------------------------------------

  it("adds a lower(brand) ILIKE lower($n) filter when ?brandSearch= is provided", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?brandSearch=acm");

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/lower\((?:p\.)?brand\)\s+ILIKE\s+lower\(\$\d+\)\s+ESCAPE/i);
    expect(params).toContain("%acm%");
  });

  it("wraps the brandSearch value in %..% wildcards for partial substring matching", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?brandSearch=Nike");

    const [, params] = mockDbQuery.mock.calls[0];
    expect(params).toContain("%nike%");
  });

  it("returns products whose brand partially matches the brandSearch term", async () => {
    const product = makeProductRow({ brand: "Nike Corporation" });
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "0" }] });
    mockDbQuery.mockResolvedValueOnce({ rows: [product] });

    const res = await request(app).get("/products?brandSearch=nik");

    expect(res.status).toBe(200);
    expect(res.body.products).toHaveLength(1);
    expect(res.body.products[0].brand).toBe("Nike Corporation");
  });

  it("returns an empty array when no products have a brand matching the brandSearch term", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "0" }] });
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get("/products?brandSearch=zzznomatch");

    expect(res.status).toBe(200);
    expect(res.body.products).toEqual([]);
  });

  it("omits the brandSearch filter when ?brandSearch= is an empty string", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?brandSearch=");

    const [sql] = mockDbQuery.mock.calls[0];
    expect(sql).not.toMatch(/lower\((?:p\.)?brand\)\s+ILIKE\s+lower\(\$\d+\)\s+ESCAPE/i);
  });

  it("omits the brandSearch filter when ?brandSearch= is whitespace only", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?brandSearch=   ");

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).not.toMatch(/lower\((?:p\.)?brand\)\s+ILIKE\s+lower\(\$\d+\)\s+ESCAPE/i);
    expect(params).not.toContain("%   %");
  });

  it("escapes a % character in the brandSearch term so it is treated literally", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?brandSearch=50%25off");

    const [, params] = mockDbQuery.mock.calls[0];
    expect(params).toContain("%50\\%off%");
  });

  it("escapes an _ character in the brandSearch term so it is treated literally", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?brandSearch=my_brand");

    const [, params] = mockDbQuery.mock.calls[0];
    expect(params).toContain("%my\\_brand%");
  });

  it("includes an ESCAPE clause in the brandSearch ILIKE condition", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?brandSearch=Acme");

    const [sql] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/ESCAPE/i);
  });

  it("can combine ?brandSearch= with ?status= to further narrow results", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?brandSearch=acme&status=available");

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/lower\((?:p\.)?brand\)\s+ILIKE/i);
    expect(sql).toMatch(/status\s+IN/i);
    expect(params).toContain("%acme%");
    expect(params).toContain("available");
  });

  // -------------------------------------------------------------------------
  // Category filter — trigram index compatibility (lower(category) ILIKE)
  // -------------------------------------------------------------------------

  it("uses lower(category) ILIKE with wildcards for category filtering so the trigram index is used", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?category=Packaging");

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/lower\(cc\.name\)\s+ILIKE\s+\$\d+\s+ESCAPE/i);
    expect(params).toContain("%packaging%");
  });

  it("returns products whose category matches exactly (case-insensitive) when ?category= is given", async () => {
    const product = makeProductRow({ category: "Packaging" });
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "0" }] });
    mockDbQuery.mockResolvedValueOnce({ rows: [product] });

    const res = await request(app).get("/products?category=PACKAGING");

    expect(res.status).toBe(200);
    expect(res.body.products).toHaveLength(1);
    expect(res.body.products[0].category).toBe("Packaging");
  });

  it("returns products whose category partially matches the filter term (partial/substring match)", async () => {
    const product = makeProductRow({ category: "Packaging Supplies" });
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "0" }] });
    mockDbQuery.mockResolvedValueOnce({ rows: [product] });

    const res = await request(app).get("/products?category=Pack");

    expect(res.status).toBe(200);
    expect(res.body.products).toHaveLength(1);
    expect(res.body.products[0].category).toBe("Packaging Supplies");

    const [, params] = mockDbQuery.mock.calls[0];
    expect(params).toContain("%pack%");
  });

  it("lowercases category values and wraps them in wildcards for partial matching", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?category=BAGS&category=Packaging");

    const [, params] = mockDbQuery.mock.calls[0];
    expect(params).toContain("%bags%");
    expect(params).toContain("%packaging%");
    expect(params).not.toContain("%BAGS%");
    expect(params).not.toContain("%Packaging%");
  });

  it("returns an empty array when the category filter matches no stored categories", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "0" }] });
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get("/products?category=NonExistentCategory");

    expect(res.status).toBe(200);
    expect(res.body.products).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// GET /products/categories — distinct categories
// ---------------------------------------------------------------------------

describe("GET /products/categories — list distinct categories", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
  });

  it("returns 200 with a categories array", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ category: "Bags" }, { category: "Boxes" }] });

    const res = await request(app).get("/products/categories");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("categories");
    expect(res.body.categories).toEqual(["Bags", "Boxes"]);
  });

  it("returns 200 with an empty array when no categories exist", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get("/products/categories");

    expect(res.status).toBe(200);
    expect(res.body.categories).toEqual([]);
  });

  it("scopes the query to the workspace owner id", async () => {
    stubWorkspaceOwnerId = "ws_cat";
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products/categories");

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(params).toContain("ws_cat");
    expect(sql).toMatch(/workspace_owner_id/i);
  });
});

// ---------------------------------------------------------------------------
// POST /products — create
// ---------------------------------------------------------------------------

// SENTINEL PATTERN
// POST /products issues exactly 3 route-owned db.query() calls on the happy path:
//   1. SELECT id FROM products WHERE sku = $1 ... (SKU uniqueness check)
//   2. INSERT INTO products ... RETURNING *
//   3. SELECT the derived primary catalog category
// Post-commit integrations are mocked separately; their database work is not
// part of this route unit's query sequence.
//
// Every success-path test below asserts toHaveBeenCalledTimes(N) so that
// adding a new db.query() call to the route fails the test immediately
// rather than silently consuming the default fallback mock.  Always:
//   a) Add an explicit mockResolvedValueOnce for each db.query() call.
//   b) Assert the exact call count at the end of the test.

describe("GET /products/category-options — combined picker options", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
  });

  it("returns combined catalog-category and occasion options scoped to the workspace", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        { kind: "catalog_category", id: 1, name: "Flowers", slug: "flowers" },
        { kind: "occasion", id: 5, name: "Birthday", slug: "birthday" },
      ],
    });

    const res = await request(app).get("/products/category-options");

    expect(res.status).toBe(200);
    expect(res.body.options).toHaveLength(2);
    expect(res.body.options[0]).toMatchObject({ kind: "catalog_category", id: 1 });
    expect(res.body.options[1]).toMatchObject({ kind: "occasion", id: 5 });

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/UNION ALL/i);
    expect(params[0]).toBe("owner_123");
  });

  it("adds an ILIKE name filter when ?q= is provided", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products/category-options?q=birth");

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/ILIKE/i);
    expect(params).toContain("%birth%");
  });

  it("omits the ILIKE filter for a whitespace-only ?q=", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products/category-options?q=%20%20");

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).not.toMatch(/ILIKE/i);
    expect(params).toHaveLength(1);
  });
});

describe("POST /products — catalog-category + occasion links", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
  });

  it("writes join rows and echoes linked arrays when ids are provided", async () => {
    const created = makeProductRow({ id: 50, name: "Linked Product", brand: null });
    mockDbQuery.mockImplementation((sql: string) => {
      if (/INSERT INTO products\s*\(/i.test(sql)) return Promise.resolve({ rows: [created], rowCount: 1 });
      if (/FROM catalog_categories/i.test(sql)) return Promise.resolve({ rows: [{ id: 10, name: "Flowers", slug: "flowers" }] });
      if (/FROM occasions/i.test(sql)) return Promise.resolve({ rows: [{ id: 30, name: "Birthday", slug: "birthday" }] });
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const res = await request(app).post("/products").send({
      name: "Linked Product",
      price_usd: 9.99,
      price_aed: 36.7,
      catalog_category_ids: [10],
      occasion_ids: [30],
    });

    expect(res.status).toBe(201);
    expect(res.body.product.catalog_categories).toEqual([{ id: 10, name: "Flowers", slug: "flowers" }]);
    expect(res.body.product.occasions).toEqual([{ id: 30, name: "Birthday", slug: "birthday" }]);

    const joinInserts = mockDbQuery.mock.calls.filter(
      ([s]: [string]) => /INSERT INTO product_(catalog_categories|occasions)/i.test(s),
    );
    expect(joinInserts).toHaveLength(2);
  });

  it("does not touch the join tables when the link arrays are absent", async () => {
    const created = makeProductRow({ id: 51, brand: null });
    mockDbQuery.mockImplementation((sql: string) => {
      if (/INSERT INTO products\s*\(/i.test(sql)) return Promise.resolve({ rows: [created], rowCount: 1 });
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const res = await request(app).post("/products").send({
      name: "No Links",
      price_usd: 1,
      price_aed: 2,
    });

    expect(res.status).toBe(201);
    const joinTouches = mockDbQuery.mock.calls.filter(
      ([s]: [string]) => /(?:INSERT INTO|DELETE FROM) product_(?:catalog_categories|occasions)/i.test(s),
    );
    expect(joinTouches).toHaveLength(0);
    expect(res.body.product.catalog_categories).toBeUndefined();
    expect(res.body.product.occasions).toBeUndefined();
  });

  it("clears all links of a kind when an empty array is provided", async () => {
    const created = makeProductRow({ id: 52, brand: null });
    mockDbQuery.mockImplementation((sql: string) => {
      if (/INSERT INTO products\s*\(/i.test(sql)) return Promise.resolve({ rows: [created], rowCount: 1 });
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const res = await request(app).post("/products").send({
      name: "Empty Links",
      price_usd: 1,
      price_aed: 2,
      catalog_category_ids: [],
    });

    expect(res.status).toBe(201);
    expect(res.body.product.catalog_categories).toEqual([]);
    const deletes = mockDbQuery.mock.calls.filter(
      ([s]: [string]) => /DELETE FROM product_catalog_categories/i.test(s),
    );
    expect(deletes).toHaveLength(1);
  });
});

describe("POST /products — create a product", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
  });

  it("returns 403 when caller lacks the Manage products permission", async () => {
    stubActualRole = "customer_service_agent";

    const res = await request(app).post("/products").send({
      name: "New Product",
      price_usd: 9.99,
      price_aed: 36.70,
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/manage products/i);
  });

  it("returns 400 when name is missing", async () => {
    const res = await request(app).post("/products").send({
      price_usd: 9.99,
      price_aed: 36.70,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name is required/i);
  });

  it("returns 400 when name is blank whitespace", async () => {
    const res = await request(app).post("/products").send({
      name: "   ",
      price_usd: 9.99,
      price_aed: 36.70,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name is required/i);
  });

  it("returns 400 when price_usd is not a number", async () => {
    const res = await request(app).post("/products").send({
      name: "Widget",
      price_usd: "abc",
      price_aed: 36.70,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/price_usd/i);
  });

  it("returns 400 when price_aed is negative", async () => {
    const res = await request(app).post("/products").send({
      name: "Widget",
      price_usd: 9.99,
      price_aed: -1,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/price_aed/i);
  });

  it("returns 201 with created product on success", async () => {
    const created = makeProductRow({ id: 99, name: "New Widget" });
    mockDbQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // SKU uniqueness check
      .mockResolvedValueOnce({ rows: [created] })        // INSERT products
      .mockResolvedValueOnce({ rows: [] });              // derived primary category

    const res = await request(app).post("/products").send({
      name: "New Widget",
      price_usd: 9.99,
      price_aed: 36.70,
      status: "available",
    });

    expect(res.status).toBe(201);
    expect(res.body.product.name).toBe("New Widget");
    expect(mockDbQuery).toHaveBeenCalledTimes(3);
  });

  it("defaults status to 'available' when an invalid value is supplied", async () => {
    const created = makeProductRow({ status: "available" });
    mockDbQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // SKU uniqueness check
      .mockResolvedValueOnce({ rows: [created] })        // INSERT products
      .mockResolvedValueOnce({ rows: [] });              // derived primary category

    await request(app).post("/products").send({
      name: "Thing",
      price_usd: 5,
      price_aed: 18,
      status: "discontinued",
    });

    const insertCall = mockDbQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === "string" && sql.includes("INSERT"),
    );
    expect(insertCall).toBeDefined();
    const [, params] = insertCall!;
    expect(params).toContain("available");
    expect(params).not.toContain("discontinued");
    expect(mockDbQuery).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// POST /products — SKU auto-assignment
// ---------------------------------------------------------------------------

// SENTINEL PATTERN (continued)
// The SKU auto-assignment describe shares the same 4-call happy path as the
// create describe above.  Each SKU collision adds one extra SELECT call.
// See the comment above the "POST /products — create a product" describe.

describe("POST /products — SKU auto-assignment", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    vi.restoreAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
  });

  it("returns a product with a sku field that is exactly 7 numeric digits", async () => {
    const created = { ...makeProductRow({ id: 10, name: "SKU Test" }), sku: "0428570" };
    mockDbQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // SKU uniqueness check
      .mockResolvedValueOnce({ rows: [created] })        // INSERT products
      .mockResolvedValueOnce({ rows: [] });              // derived primary category

    const res = await request(app).post("/products").send({
      name: "SKU Test",
      price_usd: 5,
      price_aed: 18,
    });

    expect(res.status).toBe(201);
    expect(res.body.product).toHaveProperty("sku");
    expect(res.body.product.sku).toMatch(/^\d{7}$/);
    expect(mockDbQuery).toHaveBeenCalledTimes(3);
  });

  it("two products created in sequence receive distinct SKUs", async () => {
    const product1 = { ...makeProductRow({ id: 11, name: "First" }), sku: "111111" };
    const product2 = { ...makeProductRow({ id: 12, name: "Second" }), sku: "222222" };

    mockDbQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // p1 SKU SELECT
      .mockResolvedValueOnce({ rows: [product1] })       // p1 INSERT products
      .mockResolvedValueOnce({ rows: [] })               // p1 derived primary category
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // p2 SKU SELECT
      .mockResolvedValueOnce({ rows: [product2] })       // p2 INSERT products
      .mockResolvedValueOnce({ rows: [] });              // p2 derived primary category

    const res1 = await request(app).post("/products").send({ name: "First", price_usd: 1, price_aed: 3 });
    const res2 = await request(app).post("/products").send({ name: "Second", price_usd: 2, price_aed: 7 });

    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);
    expect(res1.body.product.sku).not.toBe(res2.body.product.sku);
    expect(mockDbQuery).toHaveBeenCalledTimes(6);
  });

  it("retries SKU generation when the first candidate already exists in the database", async () => {
    const firstCandidate = String(Math.floor(0 * 10_000_000)).padStart(7, "0");
    const secondCandidate = String(Math.floor(0.5 * 10_000_000)).padStart(7, "0");

    vi.spyOn(Math, "random")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.5);

    const created = { ...makeProductRow({ id: 13, name: "Retry Product" }), sku: secondCandidate };
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 99 }], rowCount: 1 }) // SKU check — collision
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })             // SKU check — free
      .mockResolvedValueOnce({ rows: [created] })                   // INSERT products
      .mockResolvedValueOnce({ rows: [] });                         // derived primary category

    const res = await request(app).post("/products").send({
      name: "Retry Product",
      price_usd: 10,
      price_aed: 37,
    });

    expect(res.status).toBe(201);
    expect(res.body.product.sku).toBe(secondCandidate);

    const selectCalls = mockDbQuery.mock.calls.filter(
      ([sql]: [string]) => typeof sql === "string" && sql.includes("WHERE sku ="),
    );
    expect(selectCalls).toHaveLength(2);
    expect(selectCalls[0][1]).toContain(firstCandidate);
    expect(selectCalls[1][1]).toContain(secondCandidate);
    expect(mockDbQuery).toHaveBeenCalledTimes(4);
  });

  it("responds with HTTP 500 when all 20 SKU generation attempts are exhausted", async () => {
    for (let i = 0; i < 20; i++) {
      mockDbQuery.mockResolvedValueOnce({ rows: [{ id: i + 1 }], rowCount: 1 });
    }

    const res = await request(app).post("/products").send({
      name: "Exhaustion Product",
      price_usd: 5,
      price_aed: 18,
    });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/SKU space is near full/i);

    const selectCalls = mockDbQuery.mock.calls.filter(
      ([sql]: [string]) => typeof sql === "string" && sql.includes("WHERE sku ="),
    );
    expect(selectCalls).toHaveLength(20);
  });
});

// ---------------------------------------------------------------------------
// PATCH /products/:id — update
// ---------------------------------------------------------------------------

describe("PATCH /products/:id — update a product", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
  });

  it("returns 403 when caller lacks the Manage products permission", async () => {
    stubActualRole = "customer_service_agent";

    const res = await request(app).patch("/products/1").send({ name: "Renamed" });

    expect(res.status).toBe(403);
  });

  it("returns 400 for a non-numeric product id", async () => {
    const res = await request(app).patch("/products/abc").send({ name: "Renamed" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid product id/i);
  });

  it("returns 404 when the product does not exist", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).patch("/products/999").send({ name: "Ghost" });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/product not found/i);
  });

  it("returns 200 with the updated product on success", async () => {
    const existing = makeProductRow({ id: 5 });
    const updated = makeProductRow({ id: 5, name: "Updated Widget" });
    mockDbQuery
      .mockResolvedValueOnce({ rows: [existing], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [updated], rowCount: 1 });

    const res = await request(app).patch("/products/5").send({ name: "Updated Widget" });

    expect(res.status).toBe(200);
    expect(res.body.product.name).toBe("Updated Widget");
  });

  it("returns 500 when the core product update fails before changes are persisted", async () => {
    const existing = makeProductRow({ id: 9 });
    mockDbQuery
      .mockResolvedValueOnce({ rows: [existing], rowCount: 1 })
      .mockRejectedValueOnce(new Error("update failed"));

    const res = await request(app)
      .patch("/products/9")
      .send({ name: "Renamed Widget" });

    expect(res.status).toBe(500);
  });

  it("returns 200 with a warning when location activation fails after the product is updated", async () => {
    const appWithLog = makeAppWithLog();
    const existing = makeProductRow({ id: 10, name: "Widget Pro", brand: "Acme" });
    const updated = makeProductRow({ id: 10, name: "Renamed Widget", brand: "Acme" });
    mockDbQuery.mockImplementation((sql: string) => {
      if (/UPDATE products/i.test(sql)) {
        return Promise.resolve({ rows: [updated], rowCount: 1 });
      }
      if (/FROM products/i.test(sql)) {
        return Promise.resolve({ rows: [existing], rowCount: 1 });
      }
      if (/FROM location_brands/i.test(sql)) {
        return Promise.reject(new Error("location lookup failed"));
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const res = await request(appWithLog)
      .patch("/products/10")
      .send({ name: "Renamed Widget" });

    expect(res.status).toBe(200);
    expect(res.body.product.name).toBe("Renamed Widget");
    expect(res.body.warnings).toContainEqual({
      area: "location activation",
      message: "Location activation could not be refreshed.",
    });
    expect(mockReqLogError).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        productId: 10,
        area: "location activation",
      }),
      "Product update post-save operation failed",
    );
  });

  it("rejects additional images owned by another workspace", async () => {
    const existing = makeProductRow({ id: 6 });
    mockDbQuery.mockResolvedValueOnce({ rows: [existing], rowCount: 1 });

    const res = await request(app).patch("/products/6").send({
      additional_image_urls: ["/objects/another_owner/products/private.png"],
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/additional_image_urls.*within your workspace/i);
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: "null member", value: [null] },
    { label: "false member", value: [false] },
    { label: "non-array value", value: "/objects/owner_123/products/image.png" },
  ])("rejects malformed additional image input: $label", async ({ value }) => {
    const existing = makeProductRow({ id: 6, additional_image_urls: ["/objects/owner_123/products/existing.png"] });
    mockDbQuery.mockResolvedValueOnce({ rows: [existing], rowCount: 1 });

    const res = await request(app).patch("/products/6").send({ additional_image_urls: value });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/additional_image_urls.*array/i);
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
  });

  it("archives a product when is_archived: true is sent", async () => {
    const existing = makeProductRow({ id: 7, is_archived: false });
    const archived = makeProductRow({ id: 7, is_archived: true });
    mockDbQuery
      .mockResolvedValueOnce({ rows: [existing], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [archived], rowCount: 1 });

    const res = await request(app).patch("/products/7").send({ is_archived: true });

    expect(res.status).toBe(200);
    expect(res.body.product.is_archived).toBe(true);

    const updateCall = mockDbQuery.mock.calls[1];
    const [sql, params] = updateCall;
    expect(sql).toMatch(/is_archived\s*=\s*\$\d+/i);
    expect(params).toContain(true);
  });

  it("restores a product when is_archived: false is sent", async () => {
    const existing = makeProductRow({ id: 8, is_archived: true });
    const restored = makeProductRow({ id: 8, is_archived: false });
    mockDbQuery
      .mockResolvedValueOnce({ rows: [existing], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [restored], rowCount: 1 });

    const res = await request(app).patch("/products/8").send({ is_archived: false });

    expect(res.status).toBe(200);
    expect(res.body.product.is_archived).toBe(false);
  });
});

describe("PATCH /products/:id — catalog-category + occasion links", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
  });

  it("replaces join rows and echoes linked arrays when ids are provided", async () => {
    const existing = makeProductRow({ id: 60 });
    const updated = makeProductRow({ id: 60, name: "Updated" });
    mockDbQuery.mockImplementation((sql: string) => {
      if (/UPDATE products/i.test(sql)) return Promise.resolve({ rows: [updated], rowCount: 1 });
      if (/FROM products/i.test(sql)) return Promise.resolve({ rows: [existing], rowCount: 1 });
      if (/FROM catalog_categories/i.test(sql)) return Promise.resolve({ rows: [{ id: 10, name: "Flowers", slug: "flowers" }] });
      if (/FROM occasions/i.test(sql)) return Promise.resolve({ rows: [{ id: 30, name: "Birthday", slug: "birthday" }] });
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const res = await request(app).patch("/products/60").send({
      name: "Updated",
      catalog_category_ids: [10],
      occasion_ids: [30],
    });

    expect(res.status).toBe(200);
    expect(res.body.product.catalog_categories).toEqual([{ id: 10, name: "Flowers", slug: "flowers" }]);
    expect(res.body.product.occasions).toEqual([{ id: 30, name: "Birthday", slug: "birthday" }]);

    const joinInserts = mockDbQuery.mock.calls.filter(
      ([s]: [string]) => /INSERT INTO product_(catalog_categories|occasions)/i.test(s),
    );
    expect(joinInserts).toHaveLength(2);
  });

  it("does not touch the join tables when the link arrays are absent", async () => {
    const existing = makeProductRow({ id: 61 });
    const updated = makeProductRow({ id: 61, name: "Renamed" });
    mockDbQuery.mockImplementation((sql: string) => {
      if (/UPDATE products/i.test(sql)) return Promise.resolve({ rows: [updated], rowCount: 1 });
      if (/FROM products/i.test(sql)) return Promise.resolve({ rows: [existing], rowCount: 1 });
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const res = await request(app).patch("/products/61").send({ name: "Renamed" });

    expect(res.status).toBe(200);
    const joinTouches = mockDbQuery.mock.calls.filter(
      ([s]: [string]) => /(?:INSERT INTO|DELETE FROM) product_(?:catalog_categories|occasions)/i.test(s),
    );
    expect(joinTouches).toHaveLength(0);
    expect(res.body.product.catalog_categories).toBeUndefined();
  });

  it("clears all links of a kind when an empty array is provided", async () => {
    const existing = makeProductRow({ id: 62 });
    const updated = makeProductRow({ id: 62 });
    mockDbQuery.mockImplementation((sql: string) => {
      if (/UPDATE products/i.test(sql)) return Promise.resolve({ rows: [updated], rowCount: 1 });
      if (/FROM products/i.test(sql)) return Promise.resolve({ rows: [existing], rowCount: 1 });
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const res = await request(app).patch("/products/62").send({ occasion_ids: [] });

    expect(res.status).toBe(200);
    expect(res.body.product.occasions).toEqual([]);
    const deletes = mockDbQuery.mock.calls.filter(
      ([s]: [string]) => /DELETE FROM product_occasions/i.test(s),
    );
    expect(deletes).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// GET /products — archive filtering
// ---------------------------------------------------------------------------

describe("GET /products — archive filtering", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [{ count: "0" }], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
  });

  it("adds is_archived = false condition by default", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products");

    const [sql] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/is_archived\s*=\s*false/i);
  });

  it("omits the is_archived filter when include_archived=true", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?include_archived=true");

    const [sql] = mockDbQuery.mock.calls[0];
    expect(sql).not.toMatch(/is_archived\s*=\s*false/i);
    expect(sql).not.toMatch(/is_archived\s*=\s*true/i);
  });

  it("adds is_archived = true condition when archived_only=true", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?archived_only=true");

    const [sql] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/is_archived\s*=\s*true/i);
    expect(sql).not.toMatch(/is_archived\s*=\s*false/i);
  });
});

// ---------------------------------------------------------------------------
// DELETE /products/:id — delete
// ---------------------------------------------------------------------------

describe("DELETE /products/:id — delete a product", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
  });

  it("returns 403 when caller lacks the Manage products permission", async () => {
    stubActualRole = "customer_service_agent";

    const res = await request(app).delete("/products/1");

    expect(res.status).toBe(403);
  });

  it("returns 400 for a non-numeric product id", async () => {
    const res = await request(app).delete("/products/bad-id");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid product id/i);
  });

  it("returns 200 ok on successful deletion", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).delete("/products/1");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("scopes the DELETE statement to the workspace owner id", async () => {
    stubWorkspaceOwnerId = "ws_del";
    mockDbQuery.mockResolvedValueOnce({ rows: [] }); // pre-delete SELECT
    mockDbQuery.mockResolvedValueOnce({ rows: [] }); // DELETE

    await request(app).delete("/products/7");

    // A pre-delete SELECT was added before the DELETE for merchant-sync snapshot;
    // find the DELETE call rather than assuming it is call[0].
    const deleteCall = mockDbQuery.mock.calls.find(
      ([sql]: [string]) => sql.toUpperCase().includes("DELETE"),
    );
    expect(deleteCall).toBeDefined();
    const [, params] = deleteCall!;
    expect(params).toContain("ws_del");
  });
});

// ---------------------------------------------------------------------------
// Regression: category ILIKE and brand ILIKE filter paths
//
// The category filter was changed from `lower(category) IN (...)` to
// `category ILIKE $n` (later refined to `lower(category) ILIKE $n`).
// Brand is filtered with `lower(brand) ILIKE lower($n)`.
// These tests pin the exact SQL shape and param values for each filter path
// so regressions are caught immediately.
// ---------------------------------------------------------------------------

describe("GET /products — category and brand filter regression tests", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
  });

  // ---- unfiltered ----

  it("returns all products when no category or brand filter is supplied", async () => {
    const products = [
      makeProductRow({ id: 1, name: "Alpha", category: "Bags", brand: "Acme" }),
      makeProductRow({ id: 2, name: "Beta", category: "Boxes", brand: "Globex" }),
    ];
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: String(products.length) }] });
    mockDbQuery.mockResolvedValueOnce({ rows: products });

    const res = await request(app).get("/products");

    expect(res.status).toBe(200);
    expect(res.body.products).toHaveLength(2);
    const [sql] = mockDbQuery.mock.calls[0];
    expect(sql).not.toMatch(/lower\(cc\.name\)/i);
    expect(sql).not.toMatch(/lower\((?:p\.)?brand\)/i);
  });

  // ---- single category ----

  it("single ?category= emits lower(category) ILIKE $n with a lowercased %wrapped% param", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?category=Bags");

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/lower\(cc\.name\)\s+ILIKE\s+\$\d+/i);
    expect(params).toContain("%bags%");
    expect(params).not.toContain("%Bags%");
  });

  it("single category filter — mixed-case input is lowercased before matching", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?category=PaCkAgInG");

    const [, params] = mockDbQuery.mock.calls[0];
    expect(params).toContain("%packaging%");
    expect(params).not.toContain("%PaCkAgInG%");
  });

  it("single category filter returns matching products", async () => {
    const product = makeProductRow({ category: "Packaging" });
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "1" }] });
    mockDbQuery.mockResolvedValueOnce({ rows: [product] });

    const res = await request(app).get("/products?category=packaging");

    expect(res.status).toBe(200);
    expect(res.body.products).toHaveLength(1);
    expect(res.body.products[0].category).toBe("Packaging");
  });

  // ---- multiple categories ----

  it("multiple ?category= values emit OR-joined ILIKE clauses with lowercased params", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?category=Bags&category=BOXES");

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/lower\(cc\.name\)\s+ILIKE\s+\$\d+.*OR.*lower\(cc\.name\)\s+ILIKE\s+\$\d+/is);
    expect(params).toContain("%bags%");
    expect(params).toContain("%boxes%");
    expect(params).not.toContain("%BOXES%");
  });

  it("multiple category filter returns products matching any category", async () => {
    const p1 = makeProductRow({ id: 1, category: "Bags" });
    const p2 = makeProductRow({ id: 2, category: "Boxes" });
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "2" }] });
    mockDbQuery.mockResolvedValueOnce({ rows: [p1, p2] });

    const res = await request(app).get("/products?category=Bags&category=Boxes");

    expect(res.status).toBe(200);
    expect(res.body.products).toHaveLength(2);
    const cats = res.body.products.map((p: { category: string }) => p.category);
    expect(cats).toContain("Bags");
    expect(cats).toContain("Boxes");
  });

  it("three category values produce three OR-joined ILIKE clauses", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?category=Bags&category=Boxes&category=Tags");

    const [, params] = mockDbQuery.mock.calls[0];
    expect(params).toContain("%bags%");
    expect(params).toContain("%boxes%");
    expect(params).toContain("%tags%");
  });

  // ---- single brand ----

  it("single ?brand= emits lower(brand) ILIKE lower($n) with a %wrapped% param", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?brand=Nike");

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/lower\((?:p\.)?brand\)\s+ILIKE\s+lower\(\$\d+\)/i);
    expect(params).toContain("%Nike%");
  });

  it("single brand filter — uppercase input generates lower(brand) ILIKE lower($n) and preserves the original case in the param", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?brand=NIKE");

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/lower\((?:p\.)?brand\)\s+ILIKE\s+lower\(\$\d+\)/i);
    expect(params).toContain("%NIKE%");
  });

  it("single brand filter returns matching products (case-insensitive)", async () => {
    const product = makeProductRow({ brand: "Nike" });
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "1" }] });
    mockDbQuery.mockResolvedValueOnce({ rows: [product] });

    const res = await request(app).get("/products?brand=NIKE");

    expect(res.status).toBe(200);
    expect(res.body.products).toHaveLength(1);
    expect(res.body.products[0].brand).toBe("Nike");
  });

  // ---- multiple brands ----

  it("multiple ?brand= values emit OR-joined lower(brand) ILIKE lower($n) clauses", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?brand=Acme&brand=Globex");

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/lower\((?:p\.)?brand\)\s+ILIKE\s+lower\(\$\d+\).*OR.*lower\((?:p\.)?brand\)\s+ILIKE\s+lower\(\$\d+\)/is);
    expect(params).toContain("%Acme%");
    expect(params).toContain("%Globex%");
  });

  it("multiple brand filter returns products matching any brand", async () => {
    const p1 = makeProductRow({ id: 1, brand: "Acme" });
    const p2 = makeProductRow({ id: 2, brand: "Globex" });
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "2" }] });
    mockDbQuery.mockResolvedValueOnce({ rows: [p1, p2] });

    const res = await request(app).get("/products?brand=Acme&brand=Globex");

    expect(res.status).toBe(200);
    expect(res.body.products).toHaveLength(2);
    const brands = res.body.products.map((p: { brand: string }) => p.brand);
    expect(brands).toContain("Acme");
    expect(brands).toContain("Globex");
  });

  it("three brand values produce three OR-joined lower(brand) ILIKE lower($n) clauses", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?brand=Alpha&brand=Beta&brand=Gamma");

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/lower\((?:p\.)?brand\)\s+ILIKE\s+lower\(\$\d+\).*OR.*lower\((?:p\.)?brand\)\s+ILIKE\s+lower\(\$\d+\).*OR.*lower\((?:p\.)?brand\)\s+ILIKE\s+lower\(\$\d+\)/is);
    expect(params).toContain("%Alpha%");
    expect(params).toContain("%Beta%");
    expect(params).toContain("%Gamma%");
  });

  // ---- catalog Brand attribute (structured) ----

  it("no catalog-brand filter does not emit a product_catalog_brands EXISTS clause", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products");

    const [sql] = mockDbQuery.mock.calls[0];
    expect(sql).not.toMatch(/product_catalog_brands/i);
  });

  it("single ?catalog_brand= slug emits an EXISTS clause joining catalog_brands on slug", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?catalog_brand=Acme%20Co");

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/EXISTS\s*\(SELECT 1 FROM product_catalog_brands pcb JOIN catalog_brands cb ON cb\.id = pcb\.attribute_id/i);
    expect(sql).toMatch(/cb\.workspace_owner_id = \$1/i);
    expect(params).toContain("acme-co");
  });

  it("single ?catalog_brand_id= emits an EXISTS clause on the join-table attribute_id", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?catalog_brand_id=42");

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/EXISTS\s*\(SELECT 1 FROM product_catalog_brands pcb WHERE pcb\.product_id = p\.id AND pcb\.attribute_id = \$\d+\)/i);
    expect(params).toContain(42);
  });

  it("multiple ?catalog_brand= slugs emit OR-joined EXISTS clauses with slugified params", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/products?catalog_brand=Acme&catalog_brand=Globex");

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/product_catalog_brands.*OR.*product_catalog_brands/is);
    expect(params).toContain("acme");
    expect(params).toContain("globex");
  });

  it("catalog brand filter returns matching products", async () => {
    const p1 = makeProductRow({ id: 1, name: "Alpha" });
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "1" }] });
    mockDbQuery.mockResolvedValueOnce({ rows: [p1] });

    const res = await request(app).get("/products?catalog_brand=acme");

    expect(res.status).toBe(200);
    expect(res.body.products).toHaveLength(1);
    expect(res.body.products[0].name).toBe("Alpha");
  });
});

// ---------------------------------------------------------------------------
// GET /products/summary — KPI counts respect catalog/content filters
// ---------------------------------------------------------------------------

describe("GET /products/summary — filtered KPI counts", () => {
  const app = makeApp();

  const summaryRow = {
    total: "5",
    available_count: "3",
    hidden_count: "2",
    missing_info_count: "1",
    missing_images_count: "1",
    avg_cogs_pct: "42.5",
    archived_count: "4",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
  });

  it("with no filters queries only by workspace and returns parsed counts", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [summaryRow] });

    const res = await request(app).get("/products/summary");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      total: 5,
      available_count: 3,
      hidden_count: 2,
      missing_info_count: 1,
      missing_images_count: 1,
      avg_cogs_pct: 42.5,
      archived_count: 4,
    });
    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).not.toMatch(/product_occasions/i);
    expect(sql).not.toMatch(/product_catalog_brands/i);
    expect(params).toEqual(["owner_123"]);
  });

  it("applies an ?occasion= slug filter to the summary counts", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [summaryRow] });

    await request(app).get("/products/summary?occasion=Birthday");

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/EXISTS\s*\(SELECT 1 FROM product_occasions po JOIN occasions o ON o\.id = po\.attribute_id/i);
    expect(sql).toMatch(/o\.workspace_owner_id = \$1/i);
    expect(params).toContain("birthday");
  });

  it("applies a ?catalog_brand= slug filter to the summary counts", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [summaryRow] });

    await request(app).get("/products/summary?catalog_brand=Acme%20Co");

    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/EXISTS\s*\(SELECT 1 FROM product_catalog_brands pcb JOIN catalog_brands cb ON cb\.id = pcb\.attribute_id/i);
    expect(sql).toMatch(/cb\.workspace_owner_id = \$1/i);
    expect(params).toContain("acme-co");
  });

  it("applies combined Occasion + Catalog Brand filters to both the active and archived counts", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [summaryRow] });

    await request(app).get("/products/summary?occasion=birthday&catalog_brand=acme");

    const [sql, params] = mockDbQuery.mock.calls[0];
    // Both clauses present and AND-combined.
    expect(sql).toMatch(/product_occasions/i);
    expect(sql).toMatch(/product_catalog_brands/i);
    // The same content filter is applied to the active CTE and the archived
    // sub-select, so each EXISTS clause appears at least twice.
    expect((sql.match(/product_occasions/gi) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((sql.match(/product_catalog_brands/gi) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(params).toContain("birthday");
    expect(params).toContain("acme");
  });

  it("ignores the ?status= (tab) filter so the status counts are not zeroed out", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [summaryRow] });

    await request(app).get("/products/summary?status=available");

    const [sql] = mockDbQuery.mock.calls[0];
    expect(sql).not.toMatch(/p\.status IN/i);
  });
});

// ---------------------------------------------------------------------------
// PUT /products/:id/recipe — quantity validation
// ---------------------------------------------------------------------------

describe("PUT /products/:id/recipe — quantity validation", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
  });

  function mockProductFound() {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 });
  }

  it("returns 400 when a quantity is an empty string (blank field)", async () => {
    mockProductFound();

    const res = await request(app)
      .put("/products/1/recipe")
      .send({ items: [{ base_item_id: 10, quantity: "" }] });

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
    expect(res.body.error).toMatch(/positive quantity/i);
  });

  it("returns 400 when a quantity is zero", async () => {
    mockProductFound();

    const res = await request(app)
      .put("/products/1/recipe")
      .send({ items: [{ base_item_id: 10, quantity: 0 }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/positive quantity/i);
  });

  it("returns 400 when a quantity is negative", async () => {
    mockProductFound();

    const res = await request(app)
      .put("/products/1/recipe")
      .send({ items: [{ base_item_id: 10, quantity: -5 }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/positive quantity/i);
  });

  it("returns 400 when a quantity is a non-numeric string", async () => {
    mockProductFound();

    const res = await request(app)
      .put("/products/1/recipe")
      .send({ items: [{ base_item_id: 10, quantity: "abc" }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/positive quantity/i);
  });

  it("returns 400 when one item in a multi-item recipe has an invalid quantity", async () => {
    mockProductFound();

    const res = await request(app)
      .put("/products/1/recipe")
      .send({
        items: [
          { base_item_id: 10, quantity: 2 },
          { base_item_id: 11, quantity: "" },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/positive quantity/i);
  });

  it("returns 200 and the saved recipe when all quantities are valid positive numbers", async () => {
    mockProductFound();
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 10 }], rowCount: 1 });
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    mockDbQuery.mockResolvedValueOnce({ rows: [{ recipe_version: 2 }], rowCount: 1 });
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ base_item_id: 10, name: "Paper", code: "P01", image_url: null, quantity: "2.5" }],
      rowCount: 1,
    });

    const res = await request(app)
      .put("/products/1/recipe")
      .send({ items: [{ base_item_id: 10, quantity: 2.5 }] });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("recipe");
    expect(res.body.recipe).toHaveLength(1);
    expect(res.body.recipe[0].quantity).toBe("2.5");
  });

  it("accepts an empty items array (clears the recipe) without returning 400", async () => {
    mockProductFound();
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .put("/products/1/recipe")
      .send({ items: [] });

    expect(res.status).toBe(200);
    expect(res.body.recipe).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PUT /products/:id/recipe — sort_order persistence
// ---------------------------------------------------------------------------

describe("PUT /products/:id/recipe — sort_order persistence", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
  });

  function mockProductFound() {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 });
  }

  it("passes explicit sort_order values to the INSERT query for each item", async () => {
    mockProductFound();
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 10 }, { id: 20 }], rowCount: 2 });
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        { base_item_id: 20, name: "Item B", code: "B01", image_url: null, quantity: "1" },
        { base_item_id: 10, name: "Item A", code: "A01", image_url: null, quantity: "2" },
      ],
      rowCount: 2,
    });

    const res = await request(app)
      .put("/products/1/recipe")
      .send({
        items: [
          { base_item_id: 10, quantity: 2, sort_order: 1 },
          { base_item_id: 20, quantity: 1, sort_order: 0 },
        ],
      });

    expect(res.status).toBe(200);

    const insertCalls = mockDbQuery.mock.calls.filter((args) =>
      typeof args[0] === "string" && args[0].includes("INSERT INTO product_recipes"),
    );
    expect(insertCalls).toHaveLength(2);

    const firstInsertArgs = insertCalls[0][1] as unknown[];
    const secondInsertArgs = insertCalls[1][1] as unknown[];

    expect(firstInsertArgs[4]).toBe(1);
    expect(secondInsertArgs[4]).toBe(0);
  });

  it("uses array index as sort_order fallback when sort_order is omitted", async () => {
    mockProductFound();
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 10 }, { id: 20 }], rowCount: 2 });
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        { base_item_id: 10, name: "Item A", code: "A01", image_url: null, quantity: "1" },
        { base_item_id: 20, name: "Item B", code: "B01", image_url: null, quantity: "1" },
      ],
      rowCount: 2,
    });

    const res = await request(app)
      .put("/products/1/recipe")
      .send({
        items: [
          { base_item_id: 10, quantity: 1 },
          { base_item_id: 20, quantity: 1 },
        ],
      });

    expect(res.status).toBe(200);

    const insertCalls = mockDbQuery.mock.calls.filter((args) =>
      typeof args[0] === "string" && args[0].includes("INSERT INTO product_recipes"),
    );
    expect(insertCalls).toHaveLength(2);

    const firstInsertArgs = insertCalls[0][1] as unknown[];
    const secondInsertArgs = insertCalls[1][1] as unknown[];

    expect(firstInsertArgs[4]).toBe(0);
    expect(secondInsertArgs[4]).toBe(1);
  });

  it("returns items in the sort_order provided by the database", async () => {
    mockProductFound();
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 10 }, { id: 20 }, { id: 30 }], rowCount: 3 });
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    mockDbQuery.mockResolvedValueOnce({ rows: [{ recipe_version: 2 }], rowCount: 1 });
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        { base_item_id: 30, name: "Item C", code: "C01", image_url: null, quantity: "3" },
        { base_item_id: 10, name: "Item A", code: "A01", image_url: null, quantity: "1" },
        { base_item_id: 20, name: "Item B", code: "B01", image_url: null, quantity: "2" },
      ],
      rowCount: 3,
    });

    const res = await request(app)
      .put("/products/1/recipe")
      .send({
        items: [
          { base_item_id: 10, quantity: 1, sort_order: 1 },
          { base_item_id: 20, quantity: 2, sort_order: 2 },
          { base_item_id: 30, quantity: 3, sort_order: 0 },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.recipe).toHaveLength(3);
    expect(res.body.recipe[0].base_item_id).toBe(30);
    expect(res.body.recipe[1].base_item_id).toBe(10);
    expect(res.body.recipe[2].base_item_id).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// Product city-availability (default-on, toggle-off)
// ---------------------------------------------------------------------------

describe("GET /products/:id/city-availability", () => {
  const app = makeApp();

  beforeEach(() => {
    mockDbQuery.mockReset();
    stubActualRole = "owner";
  });

  it("returns cities with default-on availability and summary counts", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 }); // existence check
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        { city_id: 10, city_name: "Dubai", country_code: "AE", city_slug: "dubai", city_is_active: true, is_available: true, updated_at: null },
        { city_id: 11, city_name: "Abu Dhabi", country_code: "AE", city_slug: "abu-dhabi", city_is_active: true, is_available: false, updated_at: null },
      ],
      rowCount: 2,
    });

    const res = await request(app).get("/products/1/city-availability");

    expect(res.status).toBe(200);
    expect(res.body.cities).toHaveLength(2);
    expect(res.body.total_cities).toBe(2);
    expect(res.body.enabled_count).toBe(1);
  });

  it("returns 404 when product not found", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // existence check → empty

    const res = await request(app).get("/products/999/city-availability");

    expect(res.status).toBe(404);
  });
});

describe("PUT /products/:id/city-availability", () => {
  const app = makeApp();

  beforeEach(() => {
    mockDbQuery.mockReset();
    stubActualRole = "owner";
  });

  it("upserts availability for valid cities", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 }); // existence check
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 10 }], rowCount: 1 }); // valid cities
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // upsert

    const res = await request(app)
      .put("/products/1/city-availability")
      .send([{ city_id: 10, is_available: false }]);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("returns 403 for non-owner", async () => {
    stubActualRole = "member";
    const res = await request(app)
      .put("/products/1/city-availability")
      .send([{ city_id: 10, is_available: false }]);
    expect(res.status).toBe(403);
  });
});

describe("PATCH /products/:id/city-availability/bulk", () => {
  const app = makeApp();

  beforeEach(() => {
    mockDbQuery.mockReset();
    stubActualRole = "owner";
  });

  it("disables all cities for the product", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 }); // existence check
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 10 }, { id: 11 }], rowCount: 2 }); // all cities
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 1 }); // upserts

    const res = await request(app)
      .patch("/products/1/city-availability/bulk")
      .send({ enable_all: false });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("returns 400 when enable_all missing", async () => {
    const res = await request(app)
      .patch("/products/1/city-availability/bulk")
      .send({});
    expect(res.status).toBe(400);
  });

  it("returns 403 for non-owner", async () => {
    stubActualRole = "member";
    const res = await request(app)
      .patch("/products/1/city-availability/bulk")
      .send({ enable_all: true });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Product country-availability (default-on, toggle-off)
// ---------------------------------------------------------------------------

describe("GET /products/:id/country-availability", () => {
  const app = makeApp();

  beforeEach(() => {
    mockDbQuery.mockReset();
    stubActualRole = "owner";
  });

  it("returns the workspace country universe with default-on availability", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 }); // existence check
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ available_countries: ["Lebanon", "United Arab Emirates"] }],
      rowCount: 1,
    }); // workspace_settings
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ country_code: "LB", is_available: false, updated_at: null }],
      rowCount: 1,
    }); // product_country_availability rows

    const res = await request(app).get("/products/1/country-availability");

    expect(res.status).toBe(200);
    expect(res.body.countries).toHaveLength(2);
    expect(res.body.total_countries).toBe(2);
    expect(res.body.enabled_count).toBe(1);
    const lb = res.body.countries.find((c: { country_code: string }) => c.country_code === "LB");
    const ae = res.body.countries.find((c: { country_code: string }) => c.country_code === "AE");
    expect(lb.is_available).toBe(false);
    expect(ae.is_available).toBe(true);
  });

  it("returns 404 when product not found", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // existence check → empty

    const res = await request(app).get("/products/999/country-availability");

    expect(res.status).toBe(404);
  });
});

describe("PUT /products/:id/country-availability", () => {
  const app = makeApp();

  beforeEach(() => {
    mockDbQuery.mockReset();
    stubActualRole = "owner";
  });

  it("upserts availability only for codes within the workspace universe", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 }); // existence check
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ available_countries: ["Lebanon", "United Arab Emirates"] }],
      rowCount: 1,
    }); // workspace_settings (universe)
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 1 }); // upserts

    const res = await request(app)
      .put("/products/1/country-availability")
      .send([
        { country_code: "AE", is_available: false },
        { country_code: "ZZ", is_available: false },
      ]);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("returns 403 for non-owner", async () => {
    stubActualRole = "member";
    const res = await request(app)
      .put("/products/1/country-availability")
      .send([{ country_code: "AE", is_available: false }]);
    expect(res.status).toBe(403);
  });
});

describe("PATCH /products/:id/country-availability/bulk", () => {
  const app = makeApp();

  beforeEach(() => {
    mockDbQuery.mockReset();
    stubActualRole = "owner";
  });

  it("disables all countries for the product", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 }); // existence check
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ available_countries: ["Lebanon", "United Arab Emirates"] }],
      rowCount: 1,
    }); // workspace_settings (universe)
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 1 }); // upserts

    const res = await request(app)
      .patch("/products/1/country-availability/bulk")
      .send({ enable_all: false });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("returns 400 when enable_all missing", async () => {
    const res = await request(app)
      .patch("/products/1/country-availability/bulk")
      .send({});
    expect(res.status).toBe(400);
  });

  it("returns 403 for non-owner", async () => {
    stubActualRole = "member";
    const res = await request(app)
      .patch("/products/1/country-availability/bulk")
      .send({ enable_all: true });
    expect(res.status).toBe(403);
  });
});
