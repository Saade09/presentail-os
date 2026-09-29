import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

// ---------------------------------------------------------------------------
// Mocks — declared before importing the module under test
// ---------------------------------------------------------------------------

const mockDbQuery = vi.fn();
const mockDbClientQuery = vi.fn();
const mockDbConnect = vi.fn(async () => ({
  query: (...args: unknown[]) => mockDbClientQuery(...args),
  release: vi.fn(),
}));

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
    connect: () => mockDbConnect(),
  },
  withTransaction: async (
    client: { query: (...args: unknown[]) => Promise<unknown> },
    fn: () => Promise<unknown>,
  ) => {
    await client.query("BEGIN");
    try {
      const result = await fn();
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  },
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  authed: (req: express.Request) => req,
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("../lib/objectStorage", () => ({
  objectStorageClient: {
    uploadObject: vi.fn(),
    deleteObject: vi.fn(),
  },
}));

const mockGetUserList = vi.fn();

vi.mock("@clerk/express", () => ({
  clerkClient: {
    users: {
      getUserList: (...args: unknown[]) => mockGetUserList(...args),
    },
  },
}));

let stubWorkspaceOwnerId = "owner_123";
let stubActualRole: "owner" | "member" = "owner";
let stubUserId = "user_abc";
let stubAllowedPages: string[] = [];

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = stubWorkspaceOwnerId;
    wreq.workspaceActualRole = stubActualRole;
    wreq.workspaceRole = stubActualRole;
    wreq.userId = stubUserId;
    wreq.userEmail = "owner@example.com";
    wreq.allowedPages = stubAllowedPages;
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

import suppliersRouter from "./suppliers";

// ---------------------------------------------------------------------------
// Test app
// ---------------------------------------------------------------------------

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: Record<string, unknown> }).log = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
    };
    next();
  });
  app.use(suppliersRouter);
  return app;
}

describe("supplier read access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubActualRole = "member";
    stubAllowedPages = [];
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  afterEach(() => {
    stubActualRole = "owner";
    stubAllowedPages = [];
  });

  it("rejects members without the suppliers page before querying", async () => {
    const res = await request(makeApp()).get("/suppliers");

    expect(res.status).toBe(403);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("allows members with the suppliers page", async () => {
    stubAllowedPages = ["suppliers"];

    const res = await request(makeApp()).get("/suppliers");

    expect(res.status).toBe(200);
    expect(mockDbQuery).toHaveBeenCalled();
  });

  it("does not intercept unrelated GET routes mounted after the suppliers router", async () => {
    const app = makeApp();
    app.get("/cities", (_req, res) => res.json({ reached: "cities" }));
    app.get("/cash-sessions", (_req, res) => res.json({ reached: "cash-sessions" }));
    app.get("/cmc-pos/locations", (_req, res) => res.json({ reached: "cmc-pos" }));

    for (const [path, reached] of [
      ["/cities", "cities"],
      ["/cash-sessions", "cash-sessions"],
      ["/cmc-pos/locations", "cmc-pos"],
    ] as const) {
      const res = await request(app).get(path);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ reached });
    }

    expect(mockDbQuery).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Route ordering guard: GET /suppliers/reorder-needed
// ---------------------------------------------------------------------------

describe("GET /suppliers/reorder-needed — route ordering guard", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubUserId = "user_abc";
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("returns 200 with { items: [] } when no items are below par level", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/suppliers/reorder-needed");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("items");
    expect(Array.isArray(res.body.items)).toBe(true);
  });

  it("returns 200 with items when catalog items are below par level", async () => {
    const item = {
      id: 1,
      supplier_id: 10,
      workspace_owner_id: "owner_123",
      name: "Widget A",
      current_stock: 2,
      par_level: 10,
      is_active: true,
      supplier_name: "Acme Corp",
      supplier_display_name: null,
    };
    mockDbQuery.mockResolvedValueOnce({ rows: [item], rowCount: 1 });

    const res = await request(app).get("/suppliers/reorder-needed");

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ name: "Widget A", supplier_name: "Acme Corp" });
  });

  it("does NOT match the parameterised /suppliers/:id route — the static segment wins", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/suppliers/reorder-needed");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("items");
    expect(res.body).not.toHaveProperty("supplier");
  });
});

// ---------------------------------------------------------------------------
// GET /suppliers/:id — parameterised route still works with a numeric id
// ---------------------------------------------------------------------------

describe("GET /suppliers/:id", () => {
  const app = makeApp();

  const SUPPLIER_ROW = {
    id: 42,
    workspace_owner_id: "owner_123",
    name: "Acme Corp",
    display_name: "Acme",
    contact_name: "Bob",
    contact_email: "bob@acme.com",
    contact_phone: "+1-555-0100",
    country: "US",
    tax_number: null,
    supplier_code: "ACM-001",
    payment_terms: "net_30",
    currency_pref: "USD",
    lead_time_days: 5,
    min_order_value: null,
    notes: null,
    updated_at: null,
    updated_by_clerk_id: null,
    created_by_clerk_id: null,
    is_archived: false,
    created_at: "2024-01-01T00:00:00Z",
    item_count: 3,
    invoice_count: 1,
    spend_ytd: "500.00",
    spend_ytd_currency: "USD",
    paid_count: 1,
    outstanding_count: 0,
    category: "Packaging Materials",
    vat_registered: false,
    billing_address: null,
    website: null,
    tags: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubUserId = "user_abc";
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockGetUserList.mockResolvedValue({ data: [] });
  });

  it("returns 200 with supplier data for a valid numeric id", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [SUPPLIER_ROW], rowCount: 1 });

    const res = await request(app).get("/suppliers/42");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("supplier");
    expect(res.body.supplier).toMatchObject({ id: 42, name: "Acme Corp" });
  });

  it("returns 404 when the supplier does not exist", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/suppliers/9999");

    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("error");
  });

  it("returns 400 for a non-numeric id", async () => {
    const res = await request(app).get("/suppliers/not-a-number");

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });
});

// ---------------------------------------------------------------------------
// Route ordering guard: GET /suppliers/:id/invoices
// This sub-route must resolve before the parameterised /suppliers/:id route
// and must return { invoices: [] } rather than the single-supplier shape.
// ---------------------------------------------------------------------------

describe("GET /suppliers/:id/invoices — route ordering guard", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubUserId = "user_abc";
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("returns 200 with { invoices: [] } when the supplier has no invoices", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 }) // supplier exists
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // invoices list
      .mockResolvedValueOnce({
        rows: [{ spend_ytd: "0", spend_ytd_currency: null }],
        rowCount: 1,
      }); // YTD spend

    const res = await request(app).get("/suppliers/42/invoices");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("invoices");
    expect(Array.isArray(res.body.invoices)).toBe(true);
    expect(res.body.invoices).toHaveLength(0);
  });

  it("returns 200 with invoice rows when invoices exist", async () => {
    const invoiceRow = {
      id: 5,
      ai_import_id: 77,
      supplier_id: 42,
      workspace_owner_id: "owner_123",
      amount: "250.00",
      currency: "USD",
      status: "outstanding",
      invoice_number: "INV-0005",
      issued_at: "2024-06-01T00:00:00Z",
      paid_at: null,
      notes: null,
      reference_type: null,
      reference_id: null,
      reference_name: null,
      created_at: "2024-06-01T00:00:00Z",
    };
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 }) // supplier exists
      .mockResolvedValueOnce({ rows: [invoiceRow], rowCount: 1 }) // invoices list
      .mockResolvedValueOnce({
        rows: [{ spend_ytd: "250.00", spend_ytd_currency: "USD" }],
        rowCount: 1,
      }); // YTD spend

    const res = await request(app).get("/suppliers/42/invoices");

    expect(res.status).toBe(200);
    expect(res.body.invoices).toHaveLength(1);
    expect(res.body.invoices[0]).toMatchObject({
      id: 5,
      ai_import_id: 77,
      invoice_number: "INV-0005",
    });
    expect(res.body).toHaveProperty("spend_ytd", "250.00");
  });

  it("does NOT match the parameterised /suppliers/:id route — the sub-route wins", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 }) // supplier exists
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // invoices list
      .mockResolvedValueOnce({
        rows: [{ spend_ytd: "0", spend_ytd_currency: null }],
        rowCount: 1,
      }); // YTD spend

    const res = await request(app).get("/suppliers/42/invoices");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("invoices");
    expect(res.body).not.toHaveProperty("supplier");
  });

  it("returns 404 when the supplier does not exist", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // supplier not found

    const res = await request(app).get("/suppliers/9999/invoices");

    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("error");
  });
});

// ---------------------------------------------------------------------------
// Route ordering guard: GET /suppliers/:id/invoices/export
// The static "export" segment must resolve before any future
// GET /suppliers/:id/invoices/:invoiceId parameterised route.
// ---------------------------------------------------------------------------

describe("GET /suppliers/:id/invoices/export — route ordering guard", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubUserId = "user_abc";
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("returns a CSV file (Content-Type: text/csv) for a valid supplier id", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ name: "Acme Corp" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/suppliers/42/invoices/export");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["content-disposition"]).toMatch(/attachment/);
  });

  it("returns CSV with invoice rows when invoices exist", async () => {
    const invoiceRow = {
      id: 1,
      supplier_id: 42,
      workspace_owner_id: "owner_123",
      amount: "150.00",
      currency: "USD",
      status: "paid",
      invoice_number: "INV-0001",
      issued_at: "2024-03-15T00:00:00Z",
      paid_at: "2024-03-20T00:00:00Z",
      notes: null,
      reference_type: null,
      reference_id: null,
      created_at: "2024-03-15T00:00:00Z",
    };
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ name: "Acme Corp" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [invoiceRow], rowCount: 1 });

    const res = await request(app).get("/suppliers/42/invoices/export");

    expect(res.status).toBe(200);
    expect(res.text).toContain("Invoice #");
    expect(res.text).toContain("INV-0001");
  });

  it("does NOT match the parameterised /suppliers/:id/invoices/:invoiceId route — static segment wins", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ name: "Acme Corp" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/suppliers/42/invoices/export");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.body).not.toHaveProperty("invoice");
  });

  it("returns 404 when the supplier does not exist", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/suppliers/9999/invoices/export");

    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("error");
  });
});

// ---------------------------------------------------------------------------
// Companion: PATCH /suppliers/:id/invoices/:invoiceId still responds normally
// ---------------------------------------------------------------------------

describe("PATCH /suppliers/:id/invoices/:invoiceId — parameterised invoice route still works", () => {
  const app = makeApp();

  const UPDATED_INVOICE = {
    id: 7,
    supplier_id: 42,
    workspace_owner_id: "owner_123",
    amount: "200.00",
    currency: "USD",
    status: "paid",
    invoice_number: "INV-0007",
    issued_at: "2024-04-01T00:00:00Z",
    paid_at: "2024-04-10T00:00:00Z",
    notes: null,
    reference_type: null,
    reference_id: null,
    created_at: "2024-04-01T00:00:00Z",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubUserId = "user_abc";
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("returns 200 with updated invoice when given a valid numeric invoiceId", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [UPDATED_INVOICE], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [UPDATED_INVOICE], rowCount: 1 });

    const res = await request(app)
      .patch("/suppliers/42/invoices/7")
      .send({ amount: "200.00", currency: "USD", status: "paid" });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("invoice");
    expect(res.body.invoice).toMatchObject({ id: 7, status: "paid" });
  });

  it("returns 404 when invoice does not exist", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .patch("/suppliers/42/invoices/9999")
      .send({ amount: "100.00" });

    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("error");
  });

  it("rejects edits to AI-imported ledger rows", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ ...UPDATED_INVOICE, ai_import_id: 77 }],
      rowCount: 1,
    });

    const res = await request(app)
      .patch("/suppliers/42/invoices/7")
      .send({ amount: "999.00" });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ ai_import_id: 77 });
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Route ordering guard: GET /suppliers/:supplierId/catalog-items/:itemId/stock-log
// The static "stock-log" segment must resolve before any future
// GET /suppliers/:supplierId/catalog-items/:itemId/:segment parameterised route.
// ---------------------------------------------------------------------------

describe("GET /suppliers/:supplierId/catalog-items/:itemId/stock-log — route ordering guard", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubUserId = "user_abc";
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockGetUserList.mockResolvedValue({ data: [] });
  });

  it("returns 200 with { entries: [] } when no stock-log entries exist", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/suppliers/10/catalog-items/5/stock-log");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("entries");
    expect(Array.isArray(res.body.entries)).toBe(true);
  });

  it("returns 200 with log entries when history exists", async () => {
    const logEntry = {
      id: 1,
      field: "current_stock",
      old_value: "5",
      new_value: "10",
      changed_by_clerk_id: null,
      created_at: "2024-05-01T00:00:00Z",
    };
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [logEntry], rowCount: 1 });

    const res = await request(app).get("/suppliers/10/catalog-items/5/stock-log");

    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0]).toMatchObject({ field: "current_stock", new_value: "10" });
  });

  it("does NOT match the parameterised /catalog-items/:itemId route — the static segment wins", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/suppliers/10/catalog-items/5/stock-log");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("entries");
    expect(res.body).not.toHaveProperty("catalog_item");
  });

  it("returns 404 when catalog item does not belong to supplier", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/suppliers/10/catalog-items/9999/stock-log");

    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("error");
  });
});

// ---------------------------------------------------------------------------
// Companion: GET /suppliers/:supplierId/catalog-items/:itemId still works
// ---------------------------------------------------------------------------

describe("GET /suppliers/:supplierId/catalog-items/:itemId — parameterised catalog-item route still works", () => {
  const app = makeApp();

  const CATALOG_ITEM_ROW = {
    id: 5,
    supplier_id: 10,
    workspace_owner_id: "owner_123",
    name: "Cardboard Box A4",
    sku: "BOX-A4",
    unit: "pcs",
    current_stock: 50,
    par_level: 20,
    cost_price: "1.50",
    currency: "USD",
    is_active: true,
    notes: null,
    base_item_id: null,
    base_item_name: null,
    created_at: "2024-01-01T00:00:00Z",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubUserId = "user_abc";
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("returns 200 with catalog_item for a valid numeric itemId", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [CATALOG_ITEM_ROW], rowCount: 1 });

    const res = await request(app).get("/suppliers/10/catalog-items/5");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("catalog_item");
    expect(res.body.catalog_item).toMatchObject({ id: 5, name: "Cardboard Box A4" });
  });

  it("returns 404 when catalog item does not exist", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/suppliers/10/catalog-items/9999");

    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("error");
  });

  it("returns 400 for non-numeric itemId", async () => {
    const res = await request(app).get("/suppliers/10/catalog-items/not-a-number");

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });
});

// ---------------------------------------------------------------------------
// Route ordering guard: GET /suppliers/:id/spend-trend
// The static "spend-trend" segment must resolve before the
// GET /suppliers/:id parameterised route could swallow it.
// ---------------------------------------------------------------------------

describe("GET /suppliers/:id/spend-trend — route ordering guard", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubUserId = "user_abc";
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("returns 200 with { months: [...] } shape when no invoices exist for the year", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/suppliers/42/spend-trend");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("months");
    expect(Array.isArray(res.body.months)).toBe(true);
    expect(res.body.months).toHaveLength(12);
  });

  it("returns months with correct totals when invoice rows exist", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [
          { month: 3, total: "450.00", currency: "USD" },
          { month: 7, total: "200.00", currency: "USD" },
        ],
        rowCount: 2,
      });

    const res = await request(app).get("/suppliers/42/spend-trend");

    expect(res.status).toBe(200);
    expect(res.body.currency).toBe("USD");
    const march = res.body.months.find((m: { month: number }) => m.month === 3);
    expect(march).toMatchObject({ month: 3, total: 450 });
    const july = res.body.months.find((m: { month: number }) => m.month === 7);
    expect(july).toMatchObject({ month: 7, total: 200 });
  });

  it("does NOT match the parameterised /suppliers/:id route — static segment wins", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/suppliers/42/spend-trend");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("months");
    expect(res.body).not.toHaveProperty("supplier");
  });

  it("returns 404 when the supplier does not exist", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/suppliers/9999/spend-trend");

    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("error");
  });
});

// ---------------------------------------------------------------------------
// Companion: GET /suppliers/:id/items still responds with { items: [] }
// ---------------------------------------------------------------------------

describe("GET /suppliers/:id/items — parameterised items route still works", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubUserId = "user_abc";
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("returns 200 with { items: [] } when no base items are linked", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/suppliers/42/items");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("items");
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items).toHaveLength(0);
  });

  it("returns 200 with linked base items when they exist", async () => {
    const itemRow = {
      link_id: 1,
      base_item_id: 10,
      code: "BI-001",
      name: "Box Small",
      image_url: null,
      main_category_name: "Packaging",
      sub_category_name: null,
      supplier_item_name: "Small Box",
      supplier_item_code: "SB-01",
      pricing_uom: "pcs",
      price: "0.50",
      currency: "USD",
      is_preferred: true,
      is_default_order_unit: false,
      package_name: null,
    };
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [itemRow], rowCount: 1 });

    const res = await request(app).get("/suppliers/42/items");

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ name: "Box Small", code: "BI-001" });
  });

  it("returns 404 when the supplier does not exist", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/suppliers/9999/items");

    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("error");
  });
});

// ---------------------------------------------------------------------------
// Route-ordering guard: GET /suppliers/:id/documents
// ---------------------------------------------------------------------------

describe("GET /suppliers/:id/documents — static sub-route takes priority over /:id", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubUserId = "user_abc";
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("returns 200 with { documents: [] } when supplier exists but has no documents", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/suppliers/7/documents");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("documents");
    expect(res.body.documents).toEqual([]);
  });

  it("does NOT return the single-supplier shape — the /documents segment wins", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/suppliers/7/documents");

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("supplier");
  });

  it("returns 404 when supplier does not exist", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/suppliers/9999/documents");

    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("error");
  });
});

// ---------------------------------------------------------------------------
// Route-ordering guard: DELETE /suppliers/:id/documents/:docId
// ---------------------------------------------------------------------------

describe("DELETE /suppliers/:id/documents/:docId — numeric docId is handled correctly", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubUserId = "user_abc";
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("returns 204 with no body when document exists and is deleted", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 3, supplier_id: 7 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).delete("/suppliers/7/documents/3");

    expect(res.status).toBe(204);
    expect(res.body).toEqual({});
  });

  it("returns 404 when document does not exist for this supplier", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).delete("/suppliers/7/documents/9999");

    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("error");
  });

  it("returns 400 for a non-numeric docId", async () => {
    const res = await request(app).delete("/suppliers/7/documents/not-a-number");

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });
});

// ---------------------------------------------------------------------------
// Route-ordering guard: GET /suppliers/:id/statements
// ---------------------------------------------------------------------------

describe("GET /suppliers/:id/statements — static sub-route takes priority over /:id", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubUserId = "user_abc";
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("returns 200 with { statements: [] } when supplier exists but has no statements", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/suppliers/7/statements");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("statements");
    expect(res.body.statements).toEqual([]);
    expect(res.body).not.toHaveProperty("supplier");
  });

  it("returns 404 when supplier does not exist", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/suppliers/9999/statements");

    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("error");
  });
});

// ---------------------------------------------------------------------------
// Route-ordering guard: DELETE /suppliers/:id/statements/:statementId
// ---------------------------------------------------------------------------

describe("DELETE /suppliers/:id/statements/:statementId — uuid statementId is handled correctly", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubUserId = "user_abc";
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("returns 204 with no body when statement exists and is deleted", async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{ id: "stmt-1", supplier_id: 7, file_url: null }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).delete("/suppliers/7/statements/stmt-1");

    expect(res.status).toBe(204);
    expect(res.body).toEqual({});
  });

  it("returns 404 when statement does not exist for this supplier", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).delete("/suppliers/7/statements/missing");

    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("error");
  });
});

// ---------------------------------------------------------------------------
// Route-ordering guard: GET /suppliers/:id/invoices
// ---------------------------------------------------------------------------

describe("GET /suppliers/:id/invoices — static sub-route takes priority over /:id", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubUserId = "user_abc";
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("returns 200 with { invoices: [] } when supplier exists but has no invoices", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ spend_ytd: "0", spend_ytd_currency: null }], rowCount: 1 });

    const res = await request(app).get("/suppliers/7/invoices");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("invoices");
    expect(res.body.invoices).toEqual([]);
  });

  it("does NOT return the single-supplier shape — the /invoices segment wins", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ spend_ytd: "0", spend_ytd_currency: null }], rowCount: 1 });

    const res = await request(app).get("/suppliers/7/invoices");

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("supplier");
  });

  it("returns 404 when supplier does not exist", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/suppliers/9999/invoices");

    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("error");
  });
});

// ---------------------------------------------------------------------------
// Unit tests: normalizeSupplierName
// ---------------------------------------------------------------------------

import { normalizeSupplierName } from "./suppliers";

describe("normalizeSupplierName — pure unit", () => {
  it("lowercases the input", () => {
    expect(normalizeSupplierName("ACME")).toBe("acme");
  });

  it("trims leading and trailing whitespace", () => {
    expect(normalizeSupplierName("  acme  ")).toBe("acme");
  });

  it("collapses internal whitespace to a single space", () => {
    expect(normalizeSupplierName("hello   world")).toBe("hello world");
  });

  it("replaces punctuation with spaces (apostrophe becomes a space, not removed)", () => {
    expect(normalizeSupplierName("Bob's Supplies!")).toBe("bob s supplies");
  });

  it("strips the 'LLC' suffix", () => {
    expect(normalizeSupplierName("Acme LLC")).toBe("acme");
  });

  it("strips the 'Ltd' suffix", () => {
    expect(normalizeSupplierName("Global Traders Ltd")).toBe("global traders");
  });

  it("strips the 'SAL' suffix", () => {
    expect(normalizeSupplierName("Beirut Goods SAL")).toBe("beirut goods");
  });

  it("strips a punctuated 'S.A.R.L.' suffix", () => {
    expect(normalizeSupplierName("Raidan Floriculture S.A.R.L.")).toBe("raidan floriculture");
  });

  it("strips the 'Trading' suffix", () => {
    expect(normalizeSupplierName("Al Noor Trading")).toBe("al noor");
  });

  it("strips the 'Est' suffix", () => {
    expect(normalizeSupplierName("Mohammed Ali Est")).toBe("mohammed ali");
  });

  it("strips the 'Establishment' suffix", () => {
    expect(normalizeSupplierName("Al Faris Establishment")).toBe("al faris");
  });

  it("strips 'Inc' suffix", () => {
    expect(normalizeSupplierName("Widgets Inc")).toBe("widgets");
  });

  it("strips 'Company' suffix", () => {
    expect(normalizeSupplierName("Tech Company")).toBe("tech");
  });

  it("strips multiple suffixes in one name", () => {
    expect(normalizeSupplierName("Acme Trading LLC")).toBe("acme");
  });

  it("handles suffix preceded by punctuation (e.g. period)", () => {
    expect(normalizeSupplierName("Est. Suppliers Ltd.")).toBe("suppliers");
  });

  it("returns empty string for all-suffix input", () => {
    expect(normalizeSupplierName("LLC")).toBe("");
  });

  it("preserves digits in the name", () => {
    expect(normalizeSupplierName("Supplier 2000 Ltd")).toBe("supplier 2000");
  });
});

// ---------------------------------------------------------------------------
// Unit tests: GET /suppliers/check-duplicate
// ---------------------------------------------------------------------------

describe("GET /suppliers/check-duplicate", () => {
  const app = makeApp();

  const SUPPLIER_ROW = {
    id: 1,
    workspace_owner_id: "owner_123",
    name: "Acme Corp",
    display_name: null,
    contact_name: null,
    contact_email: null,
    contact_phone: null,
    country: null,
    tax_number: null,
    supplier_code: null,
    payment_terms: null,
    currency_pref: null,
    lead_time_days: null,
    min_order_value: null,
    notes: null,
    updated_at: null,
    updated_by_clerk_id: null,
    created_by_clerk_id: null,
    is_archived: false,
    created_at: "2024-01-01T00:00:00Z",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubUserId = "user_abc";
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("returns 400 when name query param is missing", async () => {
    const res = await request(app).get("/suppliers/check-duplicate");

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  it("returns 400 when name query param is an empty string", async () => {
    const res = await request(app).get("/suppliers/check-duplicate?name=");

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  it("returns 200 with exactMatch: false and empty similarMatches when no suppliers exist", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/suppliers/check-duplicate?name=NewSupplier");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ exactMatch: false, similarMatches: [] });
  });

  it("returns exactMatch: true when name normalizes to an identical existing supplier", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [SUPPLIER_ROW], rowCount: 1 });

    const res = await request(app).get("/suppliers/check-duplicate?name=Acme+Corp");

    expect(res.status).toBe(200);
    expect(res.body.exactMatch).toBe(true);
    expect(res.body.similarMatches).toHaveLength(1);
    expect(res.body.similarMatches[0]).toMatchObject({ id: 1, name: "Acme Corp", score: 100 });
  });

  it("returns exactMatch: true when name with suffix strips to the same normalized form", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [SUPPLIER_ROW], rowCount: 1 });

    const res = await request(app).get("/suppliers/check-duplicate?name=Acme+Corp+LLC");

    expect(res.status).toBe(200);
    expect(res.body.exactMatch).toBe(true);
  });

  it("returns exactMatch: false with a similar match when one character differs", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [SUPPLIER_ROW], rowCount: 1 });

    // "Akme Corp" vs "Acme Corp" — 1 edit distance out of 9 chars → score 89
    const res = await request(app).get("/suppliers/check-duplicate?name=Akme+Corp");

    expect(res.status).toBe(200);
    expect(res.body.exactMatch).toBe(false);
    expect(res.body.similarMatches).toHaveLength(1);
    expect(res.body.similarMatches[0].score).toBeGreaterThanOrEqual(85);
    expect(res.body.similarMatches[0].score).toBeLessThan(100);
  });

  it("returns exactMatch: false with no similar matches when the name is completely different", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [SUPPLIER_ROW], rowCount: 1 });

    const res = await request(app).get("/suppliers/check-duplicate?name=Totally+Different+Zzzz");

    expect(res.status).toBe(200);
    expect(res.body.exactMatch).toBe(false);
    expect(res.body.similarMatches).toHaveLength(0);
  });

  it("returns similar matches sorted by score descending when multiple candidates exist", async () => {
    const rows = [
      { ...SUPPLIER_ROW, id: 1, name: "Acme Corp" },
      { ...SUPPLIER_ROW, id: 2, name: "Akme Corp" },
    ];
    mockDbQuery.mockResolvedValueOnce({ rows, rowCount: 2 });

    // Query exact "Acme Corp" → id:1 score 100, id:2 score ~89
    const res = await request(app).get("/suppliers/check-duplicate?name=Acme+Corp");

    expect(res.status).toBe(200);
    expect(res.body.exactMatch).toBe(true);
    const scores: number[] = res.body.similarMatches.map((m: { score: number }) => m.score);
    expect(scores[0]).toBeGreaterThanOrEqual(scores[1] ?? 0);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: POST /suppliers — 409 duplicate guard
// ---------------------------------------------------------------------------

describe("POST /suppliers — 409 exact-duplicate guard", () => {
  const app = makeApp();

  const EXISTING_ROW = {
    id: 5,
    workspace_owner_id: "owner_123",
    name: "Acme Corp",
    display_name: null,
    is_archived: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubUserId = "user_abc";
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("returns 409 when an exact-match supplier already exists", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [EXISTING_ROW], rowCount: 1 });

    const res = await request(app)
      .post("/suppliers")
      .send({ name: "Acme Corp" });

    expect(res.status).toBe(409);
    expect(res.body).toHaveProperty("error");
    expect(res.body.existingId).toBe(5);
  });

  it("returns 409 when the name normalizes to the same form as an existing supplier (suffix variant)", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [EXISTING_ROW], rowCount: 1 });

    const res = await request(app)
      .post("/suppliers")
      .send({ name: "Acme Corp LLC" });

    expect(res.status).toBe(409);
    expect(res.body.existingId).toBe(5);
  });

  it("returns 409 with existingId when the normalized tax number already exists", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ ...EXISTING_ROW, id: 8, name: "Different Supplier", tax_number: "AE-123 456" }],
      rowCount: 1,
    });

    const res = await request(app)
      .post("/suppliers")
      .send({ name: "Another Supplier", tax_number: "ae123456" });

    expect(res.status).toBe(409);
    expect(res.body.existingId).toBe(8);
  });

  it("returns 201 and creates the supplier when no duplicate exists", async () => {
    const createdRow = {
      id: 99,
      workspace_owner_id: "owner_123",
      name: "Brand New Supplier",
      display_name: "Brand New Supplier",
      contact_name: null,
      contact_email: null,
      contact_phone: null,
      country: null,
      tax_number: null,
      supplier_code: null,
      payment_terms: null,
      currency_pref: null,
      lead_time_days: null,
      min_order_value: null,
      notes: null,
      is_archived: false,
      created_at: "2024-06-01T00:00:00Z",
      updated_at: "2024-06-01T00:00:00Z",
      updated_by_clerk_id: null,
      created_by_clerk_id: null,
    };
    mockDbQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [createdRow], rowCount: 1 });

    const res = await request(app)
      .post("/suppliers")
      .send({ name: "Brand New Supplier" });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("supplier");
    expect(res.body.supplier.name).toBe("Brand New Supplier");
  });

  it("returns 400 when name is missing", async () => {
    const res = await request(app)
      .post("/suppliers")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  it("returns 403 when the user does not have create permission", async () => {
    stubActualRole = "member";

    const res = await request(app)
      .post("/suppliers")
      .send({ name: "New Supplier" });

    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty("error");
  });
});

// ---------------------------------------------------------------------------
// Route-ordering guard: DELETE /suppliers/:id/invoices/:invoiceId
// ---------------------------------------------------------------------------

describe("DELETE /suppliers/:id/invoices/:invoiceId — numeric invoiceId is handled correctly", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubUserId = "user_abc";
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("returns 200 with { ok: true } when invoice exists and is deleted", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 3 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app).delete("/suppliers/7/invoices/3");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("returns 404 when invoice does not exist for this supplier", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).delete("/suppliers/7/invoices/9999");

    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty("error");
  });

  it("returns 400 for a non-numeric invoiceId", async () => {
    const res = await request(app).delete("/suppliers/7/invoices/not-a-number");

    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });
});

// ---------------------------------------------------------------------------
// POST /suppliers — default_vat_treatment and default_vat_rate fields
// ---------------------------------------------------------------------------

describe("POST /suppliers — VAT fields (default_vat_treatment, default_vat_rate)", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubUserId = "user_abc";
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("includes default_vat_treatment and default_vat_rate in the INSERT query when provided", async () => {
    const createdRow = {
      id: 10,
      workspace_owner_id: "owner_123",
      name: "VAT Supplier",
      display_name: "VAT Supplier",
      contact_name: null,
      contact_email: null,
      contact_phone: null,
      country: null,
      tax_number: null,
      supplier_code: null,
      payment_terms: null,
      currency_pref: null,
      lead_time_days: null,
      min_order_value: null,
      notes: null,
      category: null,
      vat_registered: true,
      default_vat_treatment: "standard",
      default_vat_rate: "5.00",
      billing_address: null,
      website: null,
      tags: null,
      is_archived: false,
      created_at: "2024-06-01T00:00:00Z",
      updated_at: "2024-06-01T00:00:00Z",
      updated_by_clerk_id: null,
      created_by_clerk_id: null,
    };

    mockDbQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })   // duplicate check
      .mockResolvedValueOnce({ rows: [createdRow], rowCount: 1 }); // INSERT

    const res = await request(app)
      .post("/suppliers")
      .send({
        name: "VAT Supplier",
        vat_registered: true,
        default_vat_treatment: "standard",
        default_vat_rate: "5.00",
      });

    expect(res.status).toBe(201);
    expect(res.body.supplier).toMatchObject({
      default_vat_treatment: "standard",
      default_vat_rate: "5.00",
      vat_registered: true,
    });

    // Verify the INSERT SQL params include the VAT fields
    const [insertSql, insertParams] = mockDbQuery.mock.calls[1];
    expect(insertSql).toMatch(/INSERT INTO suppliers/i);
    expect(insertSql).toMatch(/default_vat_treatment/i);
    expect(insertSql).toMatch(/default_vat_rate/i);
    expect(insertParams).toContain("standard");
    expect(insertParams).toContain("5.00");
  });

  it("passes null for default_vat_treatment when not provided", async () => {
    const createdRow = {
      id: 11,
      workspace_owner_id: "owner_123",
      name: "Simple Supplier",
      display_name: "Simple Supplier",
      contact_name: null, contact_email: null, contact_phone: null, country: null,
      tax_number: null, supplier_code: null, payment_terms: null, currency_pref: null,
      lead_time_days: null, min_order_value: null, notes: null, category: null,
      vat_registered: false, default_vat_treatment: null, default_vat_rate: null,
      billing_address: null, website: null, tags: null, is_archived: false,
      created_at: "2024-06-01T00:00:00Z", updated_at: "2024-06-01T00:00:00Z",
      updated_by_clerk_id: null, created_by_clerk_id: null,
    };

    mockDbQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })   // duplicate check
      .mockResolvedValueOnce({ rows: [createdRow], rowCount: 1 }); // INSERT

    await request(app).post("/suppliers").send({ name: "Simple Supplier" });

    const [, insertParams] = mockDbQuery.mock.calls[1];
    // $19 (index 18) = default_vat_treatment, $20 (index 19) = default_vat_rate
    expect(insertParams[18]).toBeNull(); // default_vat_treatment
    expect(insertParams[19]).toBeNull(); // default_vat_rate
  });

  it("skips duplicate check and goes directly to INSERT when ?force=true", async () => {
    const createdRow = {
      id: 12, workspace_owner_id: "owner_123", name: "Force Supplier",
      display_name: "Force Supplier", contact_name: null, contact_email: null,
      contact_phone: null, country: null, tax_number: null, supplier_code: null,
      payment_terms: null, currency_pref: null, lead_time_days: null,
      min_order_value: null, notes: null, category: null, vat_registered: false,
      default_vat_treatment: "exempt", default_vat_rate: "0",
      billing_address: null, website: null, tags: null, is_archived: false,
      created_at: "2024-06-01T00:00:00Z", updated_at: null,
      updated_by_clerk_id: null, created_by_clerk_id: null,
    };

    mockDbQuery.mockResolvedValueOnce({ rows: [createdRow], rowCount: 1 });

    const res = await request(app)
      .post("/suppliers?force=true")
      .send({ name: "Force Supplier", default_vat_treatment: "exempt", default_vat_rate: "0" });

    expect(res.status).toBe(201);
    expect(mockDbQuery).toHaveBeenCalledTimes(1); // INSERT only, no duplicate check
    const [, insertParams] = mockDbQuery.mock.calls[0];
    expect(insertParams).toContain("exempt");
  });
});

// ---------------------------------------------------------------------------
// PATCH /suppliers/:id — default_vat_treatment and default_vat_rate fields
// ---------------------------------------------------------------------------

describe("PATCH /suppliers/:id — VAT fields (default_vat_treatment, default_vat_rate)", () => {
  const app = makeApp();

  const EXISTING_SUPPLIER = {
    id: 20,
    workspace_owner_id: "owner_123",
    name: "Existing Supplier",
    display_name: "Existing Supplier",
    contact_name: null,
    contact_email: null,
    contact_phone: null,
    country: null,
    tax_number: null,
    supplier_code: null,
    payment_terms: null,
    currency_pref: null,
    lead_time_days: null,
    min_order_value: null,
    notes: null,
    category: null,
    vat_registered: false,
    default_vat_treatment: null,
    default_vat_rate: null,
    billing_address: null,
    website: null,
    tags: null,
    is_archived: false,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: null,
    updated_by_clerk_id: null,
    created_by_clerk_id: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubUserId = "user_abc";
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("includes default_vat_treatment and default_vat_rate in the UPDATE query", async () => {
    const updatedSupplier = {
      ...EXISTING_SUPPLIER,
      vat_registered: true,
      default_vat_treatment: "zero_rated",
      default_vat_rate: "0",
    };

    mockDbQuery
      .mockResolvedValueOnce({ rows: [EXISTING_SUPPLIER], rowCount: 1 }) // SELECT existing
      .mockResolvedValueOnce({ rows: [updatedSupplier], rowCount: 1 });  // UPDATE

    const res = await request(app)
      .patch("/suppliers/20?force=true")
      .send({ vat_registered: true, default_vat_treatment: "zero_rated", default_vat_rate: "0" });

    expect(res.status).toBe(200);
    expect(res.body.supplier).toMatchObject({
      default_vat_treatment: "zero_rated",
      default_vat_rate: "0",
    });

    const [updateSql, updateParams] = mockDbQuery.mock.calls[1];
    expect(updateSql).toMatch(/UPDATE suppliers/i);
    expect(updateSql).toMatch(/default_vat_treatment\s*=\s*\$19/i);
    expect(updateSql).toMatch(/default_vat_rate\s*=\s*\$20/i);
    expect(updateParams[18]).toBe("zero_rated"); // $19 is index 18
    expect(updateParams[19]).toBe("0");           // $20 is index 19
  });

  it("preserves existing VAT fields when they are not included in the PATCH body", async () => {
    const existingWithVat = {
      ...EXISTING_SUPPLIER,
      default_vat_treatment: "standard",
      default_vat_rate: "5",
    };

    mockDbQuery
      .mockResolvedValueOnce({ rows: [existingWithVat], rowCount: 1 }) // SELECT existing
      .mockResolvedValueOnce({ rows: [existingWithVat], rowCount: 1 }); // UPDATE

    await request(app)
      .patch("/suppliers/20?force=true")
      .send({ notes: "Updated notes only" });

    const [, updateParams] = mockDbQuery.mock.calls[1];
    expect(updateParams[18]).toBe("standard"); // $19 preserved
    expect(updateParams[19]).toBe("5");         // $20 preserved
  });

  it("clears default_vat_treatment when set to null in the PATCH body", async () => {
    const existingWithVat = {
      ...EXISTING_SUPPLIER,
      default_vat_treatment: "standard",
      default_vat_rate: "5",
    };

    mockDbQuery
      .mockResolvedValueOnce({ rows: [existingWithVat], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ ...existingWithVat, default_vat_treatment: null }], rowCount: 1 });

    await request(app)
      .patch("/suppliers/20?force=true")
      .send({ default_vat_treatment: null });

    const [, updateParams] = mockDbQuery.mock.calls[1];
    expect(updateParams[18]).toBeNull(); // $19 cleared
  });

  it("returns 404 when supplier does not exist", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .patch("/suppliers/9999?force=true")
      .send({ default_vat_treatment: "standard" });

    expect(res.status).toBe(404);
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
  });

  it("makes exactly 2 DB calls when ?force=true skips the duplicate name check", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [EXISTING_SUPPLIER], rowCount: 1 }) // SELECT existing
      .mockResolvedValueOnce({ rows: [EXISTING_SUPPLIER], rowCount: 1 }); // UPDATE

    await request(app)
      .patch("/suppliers/20?force=true")
      .send({ default_vat_treatment: "exempt" });

    expect(mockDbQuery).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// PUT /suppliers/:id/assignments
// ---------------------------------------------------------------------------

describe("PUT /suppliers/:id/assignments", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubUserId = "user_abc";
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("returns 403 when workspace role is member and missing permission", async () => {
    stubActualRole = "member";
    const res = await request(app)
      .put("/suppliers/5/assignments")
      .send({ member_ids: [] });
    expect(res.status).toBe(403);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 404 when supplier does not exist in this workspace", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await request(app)
      .put("/suppliers/999/assignments")
      .send({ member_ids: [] });
    expect(res.status).toBe(404);
  });

  it("returns 400 when member_ids is not an array", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 });
    const res = await request(app)
      .put("/suppliers/5/assignments")
      .send({ member_ids: "invalid" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when a member_id is not in this workspace", async () => {
    // supplier check OK, member check returns fewer rows than requested
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 })  // supplier check
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });            // member check
    const res = await request(app)
      .put("/suppliers/5/assignments")
      .send({ member_ids: [99] });
    expect(res.status).toBe(400);
  });

  it("returns 200 and assignments: [] when clearing all assignments", async () => {
    // supplier check, BEGIN, DELETE, activity INSERT, COMMIT, fetchSupplierAssignments
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 })  // supplier check
      .mockResolvedValue({ rows: [], rowCount: 0 });               // all subsequent calls
    const res = await request(app)
      .put("/suppliers/5/assignments")
      .send({ member_ids: [] });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("assignments");
    expect(Array.isArray(res.body.assignments)).toBe(true);
  });

  it("returns 200 with assignments when assigning a member with lead flag", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 })  // supplier check
      .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 })  // member check
      .mockResolvedValue({ rows: [], rowCount: 0 });               // BEGIN, DELETE, INSERT x2, COMMIT, fetchSupplierAssignments
    const res = await request(app)
      .put("/suppliers/5/assignments")
      .send({ member_ids: [1], lead_member_id: 1 });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("assignments");
    // Verify that the INSERT to supplier_activities was called with 'assignments_updated'
    const activityCall = mockDbQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === "string" && sql.includes("assignments_updated"),
    );
    expect(activityCall).toBeDefined();
  });

  it("logs activity with the actor userId", async () => {
    stubUserId = "clerk_xyz";
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 })
      .mockResolvedValue({ rows: [], rowCount: 0 });
    await request(app)
      .put("/suppliers/5/assignments")
      .send({ member_ids: [1] });
    const activityCall = mockDbQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === "string" && sql.includes("assignments_updated"),
    );
    expect(activityCall).toBeDefined();
    expect(activityCall![1]).toContain("clerk_xyz");
  });
});

// ---------------------------------------------------------------------------
// POST /suppliers/bulk-assign
// ---------------------------------------------------------------------------

describe("POST /suppliers/bulk-assign", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubUserId = "user_abc";
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("returns 403 when workspace role is member and missing permission", async () => {
    stubActualRole = "member";
    const res = await request(app)
      .post("/suppliers/bulk-assign")
      .send({ supplier_ids: [1], member_ids: [2] });
    expect(res.status).toBe(403);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 400 when supplier_ids is empty", async () => {
    const res = await request(app)
      .post("/suppliers/bulk-assign")
      .send({ supplier_ids: [], member_ids: [2] });
    expect(res.status).toBe(400);
  });

  it("returns 400 when supplier_ids is missing", async () => {
    const res = await request(app)
      .post("/suppliers/bulk-assign")
      .send({ member_ids: [2] });
    expect(res.status).toBe(400);
  });

  it("returns 403 when supplier is not in this workspace", async () => {
    // supplierCheck returns fewer rows than requested
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await request(app)
      .post("/suppliers/bulk-assign")
      .send({ supplier_ids: [1], member_ids: [] });
    expect(res.status).toBe(403);
  });

  it("returns 200 with ok:true when bulk-assigning members", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 })  // supplier check
      .mockResolvedValueOnce({ rows: [{ id: 2 }], rowCount: 1 })  // member check
      .mockResolvedValue({ rows: [], rowCount: 0 });               // BEGIN, DELETE, INSERT x2, COMMIT
    const res = await request(app)
      .post("/suppliers/bulk-assign")
      .send({ supplier_ids: [1], member_ids: [2], lead_member_id: 2 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, updated_count: 1 });
  });

  it("returns 200 when clearing all assignments with empty member_ids", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 })  // supplier check
      .mockResolvedValue({ rows: [], rowCount: 0 });               // BEGIN, DELETE, activity, COMMIT
    const res = await request(app)
      .post("/suppliers/bulk-assign")
      .send({ supplier_ids: [1], member_ids: [] });
    expect(res.status).toBe(200);
    expect(res.body.updated_count).toBe(1);
  });

  it("logs a bulk_assigned activity for each supplier", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 3 }, { id: 4 }], rowCount: 2 })  // supplier check
      .mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 })             // member check
      .mockResolvedValue({ rows: [], rowCount: 0 });
    await request(app)
      .post("/suppliers/bulk-assign")
      .send({ supplier_ids: [3, 4], member_ids: [7] });
    const activityCalls = mockDbQuery.mock.calls.filter(
      ([sql]: [string]) => typeof sql === "string" && sql.includes("bulk_assigned"),
    );
    expect(activityCalls.length).toBe(2);
  });
});

describe("POST /suppliers/merge", () => {
  const app = makeApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubActualRole = "owner";
    stubUserId = "user_abc";
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("requires both edit and archive permissions", async () => {
    stubActualRole = "member";
    stubAllowedPages = ["suppliers.edit"];

    const res = await request(app)
      .post("/suppliers/merge")
      .send({
        target_supplier_id: 25,
        source_supplier_ids: [35],
        confirmation_text: "MERGE",
      });

    expect(res.status).toBe(403);
    expect(mockDbConnect).not.toHaveBeenCalled();
  });

  it("returns conflicts without mutating when duplicate Odoo identities need explicit confirmation", async () => {
    mockDbClientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // BEGIN
      .mockResolvedValueOnce({
        rows: [
          {
            id: 25,
            workspace_owner_id: "owner_123",
            name: "Retained Supplier",
            display_name: "Retained Supplier",
            tax_number: "2035191",
            country: null,
            odoo_partner_id: 56,
            is_archived: false,
          },
          {
            id: 35,
            workspace_owner_id: "owner_123",
            name: "Duplicate Supplier",
            display_name: "Duplicate Supplier",
            tax_number: "2724085-601",
            country: null,
            odoo_partner_id: 354,
            is_archived: false,
          },
        ],
        rowCount: 2,
      }) // locked suppliers
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // base-item conflicts
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // reconciliation conflicts
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // invoice conflicts
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // COMMIT

    const res = await request(app)
      .post("/suppliers/merge")
      .send({
        target_supplier_id: 25,
        source_supplier_ids: [35],
        confirmation_text: "MERGE",
      });

    expect(res.status).toBe(409);
    expect(res.body.requires_confirmation).toBe(true);
    expect(res.body.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "conflicting_tax_number" }),
        expect.objectContaining({ type: "conflicting_odoo_partner" }),
      ]),
    );
    expect(mockDbClientQuery.mock.calls.some(([sql]) => typeof sql === "string" && sql.includes("UPDATE suppliers"))).toBe(false);
  });
});
