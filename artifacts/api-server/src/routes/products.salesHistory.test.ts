import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

const mockDbQuery = vi.fn();

vi.mock("../lib/db", () => ({
  db: { query: (...args: unknown[]) => mockDbQuery(...args) },
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  authed: (req: express.Request) => req,
}));

let stubWorkspaceOwnerId = "owner_abc";

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = stubWorkspaceOwnerId;
    wreq.workspaceActualRole = "owner";
    wreq.workspaceRole = "owner";
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
  hasPageAccess: () => true,
}));

vi.mock("../lib/objectStorage", () => ({
  objectStorageClient: { bucket: () => ({ file: () => ({ save: vi.fn() }) }) },
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

function mockProduct(opts: {
  found?: boolean;
  name?: string;
} = {}) {
  if (opts.found === false) {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    return;
  }
  mockDbQuery.mockResolvedValueOnce({
    rows: [{ id: 1, name: opts.name ?? "Test Product" }],
    rowCount: 1,
  });
}

function mockHistoryQueries(opts: {
  rows?: Array<Partial<{
    order_id: string;
    display_order_number: string | null;
    status: string;
    ordered_at: string | null;
    currency: string | null;
    quantity: string | null;
    unit_price: string | null;
    line_total: string | null;
  }>>;
  total?: number;
  totals?: Array<{ currency: string | null; quantity_sum: string | null; revenue_sum: string | null }>;
}) {
  const rows = (opts.rows ?? []).map((r) => ({
    order_id: "uuid-1001",
    display_order_number: "ORD-1",
    status: "completed",
    ordered_at: "2026-01-01T00:00:00Z",
    currency: "USD",
    quantity: "1",
    unit_price: "10",
    line_total: "10",
    ...r,
  }));
  mockDbQuery.mockResolvedValueOnce({ rows, rowCount: rows.length });
  mockDbQuery.mockResolvedValueOnce({ rows: [{ total: String(opts.total ?? rows.length) }], rowCount: 1 });
  mockDbQuery.mockResolvedValueOnce({
    rows: opts.totals ?? [{ currency: "USD", quantity_sum: "1", revenue_sum: "10" }],
    rowCount: 1,
  });
}

describe("GET /products/:id/sales-history", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_abc";
  });

  it("returns 404 when the product is not in the workspace (workspace scoping)", async () => {
    mockProduct({ found: false });
    const res = await request(app).get("/products/1/sales-history");
    expect(res.status).toBe(404);
    // First (and only) DB call must filter by workspace_owner_id
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
    expect(mockDbQuery.mock.calls[0][0]).toMatch(/workspace_owner_id = \$2/);
    expect(mockDbQuery.mock.calls[0][1]).toEqual([1, "owner_abc"]);
  });

  it("always uses product_id AND name match predicate (matchKey is always 'both')", async () => {
    mockProduct({ name: "Cool Cake" });
    mockHistoryQueries({});
    const res = await request(app).get("/products/1/sales-history");
    expect(res.status).toBe(200);
    expect(res.body.matchKey).toBe("both");

    const historyCall = mockDbQuery.mock.calls[1];
    expect(historyCall[0]).toContain("li.product_id = $2");
    expect(historyCall[0]).toContain("lower(li.name) = lower($3)");
    // Workspace owner is the first SQL parameter for the matched CTE
    expect(historyCall[1][0]).toBe("owner_abc");
    expect(historyCall[1][1]).toBe(1);
    expect(historyCall[1][2]).toBe("Cool Cake");
  });

  it("applies date filters using ordered_at when from/to provided", async () => {
    mockProduct({});
    mockHistoryQueries({});
    const res = await request(app)
      .get("/products/1/sales-history")
      .query({ from: "2026-01-01T00:00:00Z", to: "2026-01-31T23:59:59Z" });
    expect(res.status).toBe(200);
    const historyCall = mockDbQuery.mock.calls[1];
    expect(historyCall[0]).toContain("o.ordered_at >= $");
    expect(historyCall[0]).toContain("o.ordered_at <= $");
    expect(historyCall[1]).toContain("2026-01-01T00:00:00Z");
    expect(historyCall[1]).toContain("2026-01-31T23:59:59Z");
  });

  it("rejects malformed date params with 400", async () => {
    const res = await request(app)
      .get("/products/1/sales-history")
      .query({ from: "not-a-date" });
    expect(res.status).toBe(400);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns aggregate totals grouped by currency", async () => {
    mockProduct({});
    mockHistoryQueries({
      rows: [
        { order_id: "uuid-1", currency: "USD", quantity: "2", unit_price: "10", line_total: "20" },
        { order_id: "uuid-2", currency: "AED", quantity: "1", unit_price: "30", line_total: "30" },
      ],
      total: 2,
      totals: [
        { currency: "USD", quantity_sum: "2", revenue_sum: "20" },
        { currency: "AED", quantity_sum: "1", revenue_sum: "30" },
      ],
    });

    const res = await request(app).get("/products/1/sales-history");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.totals.total_quantity).toBe(3);
    expect(res.body.totals.revenue_by_currency).toEqual(
      expect.arrayContaining([
        { currency: "USD", total: 20 },
        { currency: "AED", total: 30 },
      ]),
    );
    expect(res.body.total).toBe(2);
    expect(res.body.totalPages).toBe(1);
  });

  it("serializes a Date ordered_at into an ISO string (pg driver returns Date)", async () => {
    mockProduct({});
    mockHistoryQueries({
      rows: [
        {
          order_id: "uuid-1",
          ordered_at: new Date("2026-01-01T00:00:00Z") as unknown as string,
        },
      ],
      total: 1,
    });

    const res = await request(app).get("/products/1/sales-history");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].date).toBe("2026-01-01T00:00:00.000Z");
  });

  it("returns null date when ordered_at is null", async () => {
    mockProduct({});
    mockHistoryQueries({
      rows: [{ order_id: "uuid-1", ordered_at: null }],
      total: 1,
    });

    const res = await request(app).get("/products/1/sales-history");
    expect(res.status).toBe(200);
    expect(res.body.items[0].date).toBeNull();
  });
});
