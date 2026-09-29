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

vi.mock("../lib/objectStorage", () => ({
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

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(productsRouter);
  return app;
}

// ---------------------------------------------------------------------------
// Helpers — `GET /products/:id/cogs` issues exactly two db.query calls in
// order: (1) product existence check, (2) the COGS row select. The helpers
// below let each test stub those two calls clearly.
// ---------------------------------------------------------------------------

function mockProductFound() {
  mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 1, brand: null }], rowCount: 1 });
}

function mockProductMissing() {
  mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
}

type CogsRowFixture = {
  base_item_id: number;
  name: string;
  code: string | null;
  image_url: string | null;
  quantity: string;
  unit_price: string | null;
  currency: string | null;
  pricing_uom: string | null;
};

function mockCogsRows(rows: CogsRowFixture[]) {
  mockDbQuery.mockResolvedValueOnce({ rows, rowCount: rows.length });
}

// ---------------------------------------------------------------------------
// GET /products/:id/cogs
// ---------------------------------------------------------------------------

describe("GET /products/:id/cogs — cost of goods sold breakdown", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
  });

  it("returns 400 when the id path param is not numeric", async () => {
    const res = await request(app).get("/products/not-a-number/cogs");

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 404 when the product does not exist in the workspace", async () => {
    mockProductMissing();

    const res = await request(app).get("/products/999/cogs");

    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("error");
    // Only the existence check should have run.
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
  });

  it("scopes the existence and select queries to the workspace owner id", async () => {
    stubWorkspaceOwnerId = "ws_scoped";
    mockProductFound();
    mockCogsRows([]);

    await request(app).get("/products/1/cogs");

    const checkParams = mockDbQuery.mock.calls[0][1] as unknown[];
    const selectParams = mockDbQuery.mock.calls[1][1] as unknown[];
    expect(checkParams).toContain("ws_scoped");
    expect(selectParams).toContain("ws_scoped");
  });

  it("returns empty items and zeroed totals when the recipe is empty", async () => {
    mockProductFound();
    mockCogsRows([]);

    const res = await request(app).get("/products/1/cogs");

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.totals).toMatchObject({
      total_cogs: null,
      currency: null,
      missing_pricing_count: 0,
      mixed_currencies: false,
      totals_by_currency: [],
      brand_target_cogs: null,
    });
  });

  it("computes line_cost = unit_price × quantity for priced rows and totals them", async () => {
    mockProductFound();
    mockCogsRows([
      {
        base_item_id: 10,
        name: "Paper",
        code: "P01",
        image_url: null,
        quantity: "2",
        unit_price: "1.50",
        currency: "USD",
        pricing_uom: "sheet",
      },
      {
        base_item_id: 11,
        name: "Ink",
        code: "I01",
        image_url: null,
        quantity: "0.5",
        unit_price: "4.00",
        currency: "USD",
        pricing_uom: "ml",
      },
    ]);

    const res = await request(app).get("/products/1/cogs");

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);

    expect(res.body.items[0]).toMatchObject({
      base_item_id: 10,
      name: "Paper",
      code: "P01",
      quantity: 2,
      unit_price: 1.5,
      currency: "USD",
      pricing_uom: "sheet",
      line_cost: 3,
    });
    expect(res.body.items[1]).toMatchObject({
      base_item_id: 11,
      quantity: 0.5,
      unit_price: 4,
      line_cost: 2,
    });

    expect(res.body.totals).toMatchObject({
      total_cogs: 5,
      currency: "USD",
      missing_pricing_count: 0,
      mixed_currencies: false,
      totals_by_currency: [{ currency: "USD", total: 5 }],
      brand_target_cogs: null,
    });
  });

  it("flags rows with no preferred supplier price and excludes them from the total", async () => {
    mockProductFound();
    mockCogsRows([
      {
        base_item_id: 10,
        name: "Paper",
        code: "P01",
        image_url: null,
        quantity: "2",
        unit_price: "1.50",
        currency: "USD",
        pricing_uom: "sheet",
      },
      {
        base_item_id: 11,
        name: "Mystery Ingredient",
        code: "M01",
        image_url: null,
        quantity: "3",
        unit_price: null,
        currency: null,
        pricing_uom: null,
      },
    ]);

    const res = await request(app).get("/products/1/cogs");

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);

    // Priced row.
    expect(res.body.items[0].line_cost).toBe(3);
    expect(res.body.items[0].currency).toBe("USD");

    // Unpriced row — line_cost should be null, currency null.
    expect(res.body.items[1].unit_price).toBeNull();
    expect(res.body.items[1].currency).toBeNull();
    expect(res.body.items[1].line_cost).toBeNull();

    // Totals exclude the unpriced row but flag it.
    expect(res.body.totals.missing_pricing_count).toBe(1);
    expect(res.body.totals.total_cogs).toBe(3);
    expect(res.body.totals.currency).toBe("USD");
    expect(res.body.totals.mixed_currencies).toBe(false);
    expect(res.body.totals.totals_by_currency).toEqual([{ currency: "USD", total: 3 }]);
  });

  it("sets mixed_currencies=true and breaks totals down per currency when prices use different currencies", async () => {
    mockProductFound();
    mockCogsRows([
      {
        base_item_id: 10,
        name: "Paper",
        code: "P01",
        image_url: null,
        quantity: "2",
        unit_price: "1.50",
        currency: "USD",
        pricing_uom: "sheet",
      },
      {
        base_item_id: 11,
        name: "Ink",
        code: "I01",
        image_url: null,
        quantity: "1",
        unit_price: "10.00",
        currency: "AED",
        pricing_uom: "ml",
      },
      {
        base_item_id: 12,
        name: "Glue",
        code: "G01",
        image_url: null,
        quantity: "2",
        unit_price: "0.25",
        currency: "USD",
        pricing_uom: "drop",
      },
    ]);

    const res = await request(app).get("/products/1/cogs");

    expect(res.status).toBe(200);
    expect(res.body.totals.mixed_currencies).toBe(true);
    // When mixed, the single-currency total/currency fields are null.
    expect(res.body.totals.total_cogs).toBeNull();
    expect(res.body.totals.currency).toBeNull();
    expect(res.body.totals.missing_pricing_count).toBe(0);

    const byCurrency = res.body.totals.totals_by_currency as Array<{
      currency: string;
      total: number;
    }>;
    const usd = byCurrency.find((t) => t.currency === "USD");
    const aed = byCurrency.find((t) => t.currency === "AED");
    expect(usd?.total).toBe(3.5); // 1.5*2 + 0.25*2
    expect(aed?.total).toBe(10);
  });
});
