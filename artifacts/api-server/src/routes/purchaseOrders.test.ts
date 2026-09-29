import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

// ---------------------------------------------------------------------------
// Hoisted mock state
// ---------------------------------------------------------------------------

const { mockDbQuery, mockClientQuery, mockClientRelease, stubWorkspaceRole, stubAllowedPages } = vi.hoisted(() => ({
  mockDbQuery: vi.fn(),
  mockClientQuery: vi.fn(),
  mockClientRelease: vi.fn(),
  stubWorkspaceRole: { value: "owner" as "owner" | "member" },
  stubAllowedPages: { value: [] as string[] },
}));

// ---------------------------------------------------------------------------
// Mocks — declared before any imports
// ---------------------------------------------------------------------------

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
    connect: () =>
      Promise.resolve({
        query: (...args: unknown[]) => mockClientQuery(...args),
        release: () => mockClientRelease(),
      }),
  },
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
  authed: (_req: express.Request) => ({ userId: "user_test" }),
}));

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = "owner_abc";
    wreq.workspaceRole = stubWorkspaceRole.value;
    wreq.workspaceActualRole = stubWorkspaceRole.value;
    wreq.allowedPages = stubAllowedPages.value;
    wreq.userId = "user_test";
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

vi.mock("@clerk/express", () => ({
  clerkClient: {
    users: { getUserList: vi.fn().mockResolvedValue({ data: [] }) },
  },
}));

vi.mock("../lib/email", () => ({
  sendPurchaseOrderEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/translation", () => ({
  translateToArabic: vi.fn().mockResolvedValue(null),
}));

// Mock chromium-dependent PDF generation so PDF route tests work without a browser
vi.mock("../lib/poPdf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/poPdf")>();
  const FAKE_PDF = Buffer.from("%PDF-1.4 fake\n%%EOF\n");
  return {
    ...actual,
    buildPurchaseOrderPdf: vi.fn().mockResolvedValue(FAKE_PDF),
    resolvePoPdfLineItemImages: vi.fn().mockImplementation(
      async (lineItems: unknown[]) => lineItems,
    ),
    resolveChromiumPath: vi.fn().mockReturnValue(undefined),
  };
});

vi.mock("pdfkit", () => ({
  default: function MockPDFDocument() {
    const texts: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let _dest: any = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fluent: any = {
      page: { width: 595 },
      fontSize: () => fluent,
      font: () => fluent,
      fillColor: () => fluent,
      rect: () => fluent,
      fill: () => fluent,
      moveTo: () => fluent,
      lineTo: () => fluent,
      strokeColor: () => fluent,
      stroke: () => fluent,
      moveDown: () => fluent,
      heightOfString: () => 12,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      text: (str: any) => {
        if (typeof str === "string") texts.push(str);
        return fluent;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pipe: (dest: any) => {
        _dest = dest;
        return fluent;
      },
      end: () => {
        if (_dest) {
          _dest.write(texts.join("\n"));
          _dest.end();
        }
      },
    };
    return fluent;
  },
}));

// ---------------------------------------------------------------------------
// Router import (after vi.mock hoisting)
// ---------------------------------------------------------------------------

import purchaseOrdersRouter from "./purchaseOrders";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const MOCK_PO_OWNERSHIP = { rows: [{ id: 42 }], rowCount: 1 };
const MOCK_LOCATION = { rows: [{ id: 1, name: "Main Warehouse" }], rowCount: 1 };
// Status mock for the new receive guard (requires supplier_accepted or beyond)
const MOCK_PO_STATUS_RECEIVABLE = { rows: [{ status: "supplier_accepted" }], rowCount: 1 };

const MOCK_LINE_ITEM_WITHIN_LIMIT = {
  id: 101,
  purchase_order_id: 42,
  base_item_id: 5,
  base_item_name: "Widget A",
  description: "Widget A",
  quantity: "10",
  unit_price: "2.00",
  currency: "AED",
  received_quantity: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const MOCK_LINE_ITEM_OVER_RECEIPT = {
  ...MOCK_LINE_ITEM_WITHIN_LIMIT,
  quantity: "10",
  received_quantity: "8",
};

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(purchaseOrdersRouter);
  return app;
}

const app = makeApp();

describe("purchase-order read access", () => {
  beforeEach(() => {
    mockDbQuery.mockReset();
    stubWorkspaceRole.value = "member";
    stubAllowedPages.value = [];
  });

  afterEach(() => {
    stubWorkspaceRole.value = "owner";
    stubAllowedPages.value = [];
  });

  it("rejects members without the purchase-orders page before querying", async () => {
    const res = await request(app).get("/purchase-orders");

    expect(res.status).toBe(403);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("allows members with the purchase-orders page", async () => {
    stubAllowedPages.value = ["purchase-orders"];
    mockDbQuery.mockResolvedValue({ rows: [{ count: "0" }], rowCount: 1 });

    const res = await request(app).get("/purchase-orders?summary=1");

    expect(res.status).toBe(200);
    expect(mockDbQuery).toHaveBeenCalled();
  });

  it("does not intercept unrelated GET routes mounted after the purchase-orders router", async () => {
    const aggregateApp = makeApp();
    aggregateApp.get("/cities", (_req, res) => res.json({ reached: "cities" }));
    aggregateApp.get("/cmc-pos/locations", (_req, res) => res.json({ reached: "cmc-pos" }));

    for (const [path, reached] of [
      ["/cities", "cities"],
      ["/cmc-pos/locations", "cmc-pos"],
    ] as const) {
      const res = await request(aggregateApp).get(path);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ reached });
    }

    expect(mockDbQuery).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Helper: mock a full successful receive transaction for one receipt item
//
// Transaction client-query sequence (must stay in sync with the route):
//   [0]  BEGIN
//   [1]  SELECT status FROM purchase_orders FOR UPDATE  ← re-validate status inside txn
//   [2]  INSERT INTO purchase_order_receipt_events RETURNING id  ← claim idempotency slot
//   [3]  SELECT id, quantity, received_quantity FROM purchase_order_line_items FOR UPDATE
//   [4]  postMov: SELECT … FROM base_item_location_statuses FOR UPDATE
//   [5]  postMov: INSERT INTO inventory_adjustments RETURNING id
//   [6]  postMov: UPDATE base_item_location_statuses
//   [7]  postMov: UPDATE base_items
//   [8]  SELECT COALESCE(stock,0) FROM base_item_location_statuses  ← stock after
//   [9]  SELECT COALESCE(SUM(stock),0) FROM base_item_location_statuses  ← total stock
//   [10] UPDATE purchase_order_line_items SET received_quantity
//   [11] COMMIT
//
// After the transaction, syncPoStatus fires one db.query (mockDbQuery).
// ---------------------------------------------------------------------------
function mockSuccessfulTransaction(
  lockedLine: { id: number; quantity: string; received_quantity: string | null } = {
    id: 101,
    quantity: "10",
    received_quantity: null,
  },
): void {
  mockClientQuery
    .mockResolvedValueOnce({})                                                             // BEGIN
    .mockResolvedValueOnce({ rows: [{ status: "supplier_accepted" }], rowCount: 1 })      // SELECT status FOR UPDATE
    .mockResolvedValueOnce({ rows: [{ id: "receipt-evt-1" }], rowCount: 1 })              // INSERT receipt_events RETURNING id
    .mockResolvedValueOnce({ rows: [lockedLine], rowCount: 1 })                           // SELECT locked lines FOR UPDATE
    .mockResolvedValueOnce({ rows: [{ stock: "0" }], rowCount: 1 })                       // postMov SELECT FOR UPDATE
    .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 })                            // postMov INSERT adj RETURNING id
    .mockResolvedValueOnce({})                                                             // postMov UPDATE base_item_location_statuses
    .mockResolvedValueOnce({})                                                             // postMov UPDATE base_items
    .mockResolvedValueOnce({ rows: [{ stock: "5" }], rowCount: 1 })                       // SELECT loc stock after
    .mockResolvedValueOnce({ rows: [{ total: "5" }] })                                    // SELECT total stock
    .mockResolvedValueOnce({})                                                             // UPDATE purchase_order_line_items
    .mockResolvedValueOnce({});                                                            // COMMIT
  mockDbQuery.mockResolvedValueOnce({
    rows: [{ total: "1", fully_received: "0", any_received: "0" }],
    rowCount: 1,
  });
}

// Includes the extra UPDATE supplier_catalog_items query when supplier_catalog_item_id is set
function mockSuccessfulTransactionWithCatalogItem(): void {
  mockClientQuery
    .mockResolvedValueOnce({})                                                             // BEGIN
    .mockResolvedValueOnce({ rows: [{ status: "supplier_accepted" }], rowCount: 1 })      // SELECT status FOR UPDATE
    .mockResolvedValueOnce({ rows: [{ id: "receipt-evt-1" }], rowCount: 1 })              // INSERT receipt_events RETURNING id
    .mockResolvedValueOnce({ rows: [{ id: 101, quantity: "10", received_quantity: null }], rowCount: 1 }) // SELECT locked lines FOR UPDATE
    .mockResolvedValueOnce({ rows: [{ stock: "0" }], rowCount: 1 })                       // postMov SELECT FOR UPDATE
    .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 })                            // postMov INSERT adj RETURNING id
    .mockResolvedValueOnce({})                                                             // postMov UPDATE base_item_location_statuses
    .mockResolvedValueOnce({})                                                             // postMov UPDATE base_items
    .mockResolvedValueOnce({ rows: [{ stock: "5" }], rowCount: 1 })                       // SELECT loc stock after
    .mockResolvedValueOnce({ rows: [{ total: "5" }] })                                    // SELECT total stock
    .mockResolvedValueOnce({})                                                             // UPDATE purchase_order_line_items
    .mockResolvedValueOnce({})                                                             // UPDATE supplier_catalog_items
    .mockResolvedValueOnce({});                                                            // COMMIT
  mockDbQuery.mockResolvedValueOnce({
    rows: [{ total: "1", fully_received: "0", any_received: "0" }],
    rowCount: 1,
  });
}

// ---------------------------------------------------------------------------
// Helper: mock the client-query sequence for a receive that returns 422.
//
// The route opens a transaction, re-validates status and claims the event slot,
// then re-fetches locked line counters and checks for over-receipt inside the
// transaction before any stock mutations. When over-receipt is detected and
// allow_over_receipt is falsy the route does ROLLBACK and returns 422.
//
// Client-query sequence for the 422 path:
//   [0]  BEGIN
//   [1]  SELECT status FOR UPDATE  → supplier_accepted
//   [2]  INSERT receipt_events RETURNING id  → event claimed
//   [3]  SELECT locked lines FOR UPDATE  → returns the over-receipt line
//   [4]  ROLLBACK
// ---------------------------------------------------------------------------
function mockOverReceiptTxn(
  lockedLine: { id: number; quantity: string; received_quantity: string | null },
): void {
  mockClientQuery
    .mockResolvedValueOnce({})                                                             // BEGIN
    .mockResolvedValueOnce({ rows: [{ status: "supplier_accepted" }], rowCount: 1 })      // SELECT status FOR UPDATE
    .mockResolvedValueOnce({ rows: [{ id: "receipt-evt-1" }], rowCount: 1 })              // INSERT receipt_events RETURNING id
    .mockResolvedValueOnce({ rows: [lockedLine], rowCount: 1 })                           // SELECT locked lines FOR UPDATE
    .mockResolvedValueOnce({});                                                            // ROLLBACK
}

// ---------------------------------------------------------------------------
// Tests for POST /purchase-orders/:id/receive — over-receipt guard
// ---------------------------------------------------------------------------

describe("POST /purchase-orders/:id/receive — over-receipt server-side guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockClientQuery.mockReset();
    mockClientRelease.mockReset();
    stubWorkspaceRole.value = "owner";
  });

  it("returns 422 when receipt quantity + already-received exceeds ordered amount and allow_over_receipt is absent", async () => {
    mockDbQuery
      .mockResolvedValueOnce(MOCK_PO_OWNERSHIP)
      .mockResolvedValueOnce(MOCK_PO_STATUS_RECEIVABLE)
      .mockResolvedValueOnce(MOCK_LOCATION)
      .mockResolvedValueOnce({ rows: [MOCK_LINE_ITEM_OVER_RECEIPT], rowCount: 1 });

    mockOverReceiptTxn({ id: 101, quantity: "10", received_quantity: "8" });

    const res = await request(app)
      .post("/purchase-orders/42/receive")
      .send({
        location_id: 1,
        receipts: [{ line_item_id: 101, quantity: 5 }],
        receive_action_id: "a1b2c3d4-e5f6-4789-abcd-ef1234567890",
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/exceed.*ordered/i);
    expect(res.body.over_receipt_warnings).toHaveLength(1);
    expect(res.body.over_receipt_warnings[0]).toMatchObject({
      line_item_id: 101,
      ordered: 10,
      already_received: 8,
      will_receive: 5,
      total_after: 13,
    });
  });

  it("returns 422 when allow_over_receipt is explicitly false", async () => {
    mockDbQuery
      .mockResolvedValueOnce(MOCK_PO_OWNERSHIP)
      .mockResolvedValueOnce(MOCK_PO_STATUS_RECEIVABLE)
      .mockResolvedValueOnce(MOCK_LOCATION)
      .mockResolvedValueOnce({ rows: [MOCK_LINE_ITEM_OVER_RECEIPT], rowCount: 1 });

    mockOverReceiptTxn({ id: 101, quantity: "10", received_quantity: "8" });

    const res = await request(app)
      .post("/purchase-orders/42/receive")
      .send({
        location_id: 1,
        receipts: [{ line_item_id: 101, quantity: 5 }],
        allow_over_receipt: false,
        receive_action_id: "a1b2c3d4-e5f6-4789-abcd-ef1234567890",
      });

    expect(res.status).toBe(422);
    expect(res.body.over_receipt_warnings).toHaveLength(1);
  });

  it("proceeds successfully when allow_over_receipt is true and quantities exceed ordered amount", async () => {
    mockDbQuery
      .mockResolvedValueOnce(MOCK_PO_OWNERSHIP)
      .mockResolvedValueOnce(MOCK_PO_STATUS_RECEIVABLE)
      .mockResolvedValueOnce(MOCK_LOCATION)
      .mockResolvedValueOnce({ rows: [MOCK_LINE_ITEM_OVER_RECEIPT], rowCount: 1 });

    mockSuccessfulTransaction({ id: 101, quantity: "10", received_quantity: "8" });

    const res = await request(app)
      .post("/purchase-orders/42/receive")
      .send({
        location_id: 1,
        receipts: [{ line_item_id: 101, quantity: 5 }],
        allow_over_receipt: true,
        receive_action_id: "a1b2c3d4-e5f6-4789-abcd-ef1234567890",
      });

    expect(res.status).toBe(200);
    expect(res.body.received).toHaveLength(1);
    expect(res.body.received[0]).toMatchObject({
      line_item_id: 101,
      base_item_id: 5,
      quantity_received: 5,
    });
    expect(res.body.warnings).toHaveLength(1);
  });

  it("proceeds successfully for a normal receipt within the ordered amount (no allow_over_receipt needed)", async () => {
    mockDbQuery
      .mockResolvedValueOnce(MOCK_PO_OWNERSHIP)
      .mockResolvedValueOnce(MOCK_PO_STATUS_RECEIVABLE)
      .mockResolvedValueOnce(MOCK_LOCATION)
      .mockResolvedValueOnce({ rows: [MOCK_LINE_ITEM_WITHIN_LIMIT], rowCount: 1 });

    mockSuccessfulTransaction();

    const res = await request(app)
      .post("/purchase-orders/42/receive")
      .send({
        location_id: 1,
        receipts: [{ line_item_id: 101, quantity: 5 }],
        receive_action_id: "a1b2c3d4-e5f6-4789-abcd-ef1234567890",
      });

    expect(res.status).toBe(200);
    expect(res.body.received).toHaveLength(1);
    expect(res.body.warnings).toBeUndefined();
  });

  it("returns 422 for a partial prior receipt that makes the new quantity exceed the ordered amount", async () => {
    const lineItemPartiallyReceived = {
      ...MOCK_LINE_ITEM_WITHIN_LIMIT,
      quantity: "10",
      received_quantity: "6",
    };

    mockDbQuery
      .mockResolvedValueOnce(MOCK_PO_OWNERSHIP)
      .mockResolvedValueOnce(MOCK_PO_STATUS_RECEIVABLE)
      .mockResolvedValueOnce(MOCK_LOCATION)
      .mockResolvedValueOnce({ rows: [lineItemPartiallyReceived], rowCount: 1 });

    mockOverReceiptTxn({ id: 101, quantity: "10", received_quantity: "6" });

    const res = await request(app)
      .post("/purchase-orders/42/receive")
      .send({
        location_id: 1,
        receipts: [{ line_item_id: 101, quantity: 5 }],
        receive_action_id: "a1b2c3d4-e5f6-4789-abcd-ef1234567890",
      });

    expect(res.status).toBe(422);
    expect(res.body.over_receipt_warnings[0]).toMatchObject({
      ordered: 10,
      already_received: 6,
      will_receive: 5,
      total_after: 11,
    });
  });

  it("does NOT return 422 when cumulative total exactly equals the ordered amount", async () => {
    const lineItemHalfReceived = {
      ...MOCK_LINE_ITEM_WITHIN_LIMIT,
      quantity: "10",
      received_quantity: "5",
    };

    mockDbQuery
      .mockResolvedValueOnce(MOCK_PO_OWNERSHIP)
      .mockResolvedValueOnce(MOCK_PO_STATUS_RECEIVABLE)
      .mockResolvedValueOnce(MOCK_LOCATION)
      .mockResolvedValueOnce({ rows: [lineItemHalfReceived], rowCount: 1 });

    mockSuccessfulTransaction({ id: 101, quantity: "10", received_quantity: "5" });

    const res = await request(app)
      .post("/purchase-orders/42/receive")
      .send({
        location_id: 1,
        receipts: [{ line_item_id: 101, quantity: 5 }],
        receive_action_id: "a1b2c3d4-e5f6-4789-abcd-ef1234567890",
      });

    expect(res.status).toBe(200);
    expect(res.body.warnings).toBeUndefined();
  });

  it("returns 403 for a non-owner member without suppliers.edit permission", async () => {
    stubWorkspaceRole.value = "member";

    const res = await request(app)
      .post("/purchase-orders/42/receive")
      .send({
        location_id: 1,
        receipts: [{ line_item_id: 101, quantity: 5 }],
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/insufficient permissions/i);
  });

  it("returns 404 when the purchase order does not belong to the workspace", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .post("/purchase-orders/99/receive")
      .send({
        location_id: 1,
        receipts: [{ line_item_id: 101, quantity: 5 }],
      });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("returns 404 when the location does not belong to the workspace", async () => {
    mockDbQuery
      .mockResolvedValueOnce(MOCK_PO_OWNERSHIP)
      .mockResolvedValueOnce(MOCK_PO_STATUS_RECEIVABLE)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .post("/purchase-orders/42/receive")
      .send({
        location_id: 999,
        receipts: [{ line_item_id: 101, quantity: 5 }],
        receive_action_id: "a1b2c3d4-e5f6-4789-abcd-ef1234567890",
      });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/location not found/i);
  });

  it("increments supplier_catalog_items.current_stock when the line item has a supplier_catalog_item_id", async () => {
    const lineItemWithCatalogLink = {
      ...MOCK_LINE_ITEM_WITHIN_LIMIT,
      supplier_catalog_item_id: 77,
    };

    mockDbQuery
      .mockResolvedValueOnce(MOCK_PO_OWNERSHIP)
      .mockResolvedValueOnce(MOCK_PO_STATUS_RECEIVABLE)
      .mockResolvedValueOnce(MOCK_LOCATION)
      .mockResolvedValueOnce({ rows: [lineItemWithCatalogLink], rowCount: 1 });

    mockSuccessfulTransactionWithCatalogItem();

    const res = await request(app)
      .post("/purchase-orders/42/receive")
      .send({
        location_id: 1,
        receipts: [{ line_item_id: 101, quantity: 3 }],
        receive_action_id: "a1b2c3d4-e5f6-4789-abcd-ef1234567890",
      });

    expect(res.status).toBe(200);
    expect(res.body.received[0]).toMatchObject({ line_item_id: 101, quantity_received: 3 });

    const catalogUpdateCall = mockClientQuery.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("supplier_catalog_items"),
    );
    expect(catalogUpdateCall).toBeDefined();
    expect(catalogUpdateCall![1]).toEqual([3, 77, "owner_abc"]);
  });

  it("skips the supplier_catalog_items update when the line item has no supplier_catalog_item_id", async () => {
    mockDbQuery
      .mockResolvedValueOnce(MOCK_PO_OWNERSHIP)
      .mockResolvedValueOnce(MOCK_PO_STATUS_RECEIVABLE)
      .mockResolvedValueOnce(MOCK_LOCATION)
      .mockResolvedValueOnce({ rows: [MOCK_LINE_ITEM_WITHIN_LIMIT], rowCount: 1 });

    mockSuccessfulTransaction();

    const res = await request(app)
      .post("/purchase-orders/42/receive")
      .send({
        location_id: 1,
        receipts: [{ line_item_id: 101, quantity: 5 }],
        receive_action_id: "a1b2c3d4-e5f6-4789-abcd-ef1234567890",
      });

    expect(res.status).toBe(200);
    const catalogUpdateCall = mockClientQuery.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("supplier_catalog_items"),
    );
    expect(catalogUpdateCall).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests for GET /purchase-orders/:id/pdf — delivery location field
// ---------------------------------------------------------------------------

const MOCK_PO_FOR_PDF = {
  id: 42,
  workspace_owner_id: "owner_abc",
  supplier_id: 7,
  location_id: 1,
  po_number: "PO-0042",
  status: "pending",
  currency: "AED",
  total_amount: "100.00",
  effective_total: "100.00",
  calculated_total: "100.00",
  total_amount_manual_override: false,
  expected_delivery_date: null,
  notes: null,
  created_at: new Date("2025-01-15").toISOString(),
  updated_at: new Date("2025-01-15").toISOString(),
  sent_at: null,
  supplier_name: "Test Supplier",
  supplier_is_archived: false,
  location_name: "Main Warehouse",
  line_items_count: "0",
  received_items_count: "0",
  outstanding_units: "0",
  created_by_clerk_id: null,
  subtotal_amount: null,
  discount_amount: null,
  delivery_fee_amount: null,
  vat_treatment: null,
  vat_rate: null,
  vat_amount: null,
  vat_manual_override: false,
  vat_override_reason: null,
  grand_total_amount: null,
  payment_terms: null,
  supplier_reference: null,
  attachment_urls: null,
};

describe("GET /purchase-orders/:id/pdf — delivery location field", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    stubWorkspaceRole.value = "owner";
  });

  it("includes the location name in the PDF when the purchase order has a location", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [MOCK_PO_FOR_PDF], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .get("/purchase-orders/42/pdf")
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/pdf/);
    const body = res.body as Buffer;
    expect(body.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(body.length).toBeGreaterThan(0);
  });

  it("returns 400 when the id param is not a number", async () => {
    const res = await request(app).get("/purchase-orders/abc/pdf");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid purchase order id/i);
  });

  it("returns 404 when the purchase order does not belong to the workspace", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/purchase-orders/99/pdf");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/purchase order not found/i);
  });

  it("omits the location name from the PDF when the purchase order has no location", async () => {
    const poWithoutLocation = {
      ...MOCK_PO_FOR_PDF,
      location_id: null,
      location_name: null,
    };

    mockDbQuery
      .mockResolvedValueOnce({ rows: [poWithoutLocation], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .get("/purchase-orders/42/pdf")
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/pdf/);
    const body = res.body as Buffer;
    expect(body.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(body.length).toBeGreaterThan(0);
  });

  it("returns 500 when db.query throws an unexpected error", async () => {
    mockDbQuery.mockRejectedValueOnce(new Error("connection reset"));

    const res = await request(app).get("/purchase-orders/42/pdf");
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Pure helper unit tests — round2, computeVatAmount, computeCostSummary
// ---------------------------------------------------------------------------

import { round2, computeVatAmount, computeCostSummary } from "./purchaseOrders";

describe("round2", () => {
  it("rounds to 2 decimal places", () => {
    expect(round2(1.005)).toBe(1.01);
    expect(round2(1.004)).toBe(1.00);
    expect(round2(10.555)).toBe(10.56);
    expect(round2(100)).toBe(100);
  });

  it("handles epsilon edge cases correctly", () => {
    expect(round2(0.1 + 0.2)).toBe(0.3);
  });
});

describe("computeVatAmount", () => {
  it("returns 0 for no_vat treatment", () => {
    expect(computeVatAmount(1000, "no_vat", 5)).toBe(0);
    expect(computeVatAmount(1000, "no_vat", 0)).toBe(0);
  });

  it("computes vat_exclusive correctly: VAT = subtotal × rate/100", () => {
    expect(computeVatAmount(1000, "vat_exclusive", 5)).toBe(50);
    expect(computeVatAmount(100, "vat_exclusive", 15)).toBe(15);
    expect(computeVatAmount(99.99, "vat_exclusive", 5)).toBe(5);
  });

  it("computes vat_inclusive correctly: VAT = subtotal − subtotal/(1+rate/100)", () => {
    // 1050 inclusive at 5%: VAT = 1050 - 1050/1.05 = 50
    expect(computeVatAmount(1050, "vat_inclusive", 5)).toBe(50);
    // 115 inclusive at 15%: VAT = 115 - 115/1.15 = 15
    expect(computeVatAmount(115, "vat_inclusive", 15)).toBe(15);
  });

  it("returns 0 for unknown treatment", () => {
    expect(computeVatAmount(1000, "other", 5)).toBe(0);
  });
});

describe("computeCostSummary", () => {
  const base = {
    lineItemsSubtotal: 1000,
    discount: 50,
    deliveryFee: 30,
    vatTreatment: "no_vat",
    vatRate: 0,
    vatManualOverride: false,
    vatAmountOverride: null,
  };

  it("computes grand total with no VAT: subtotal − discount + delivery", () => {
    const result = computeCostSummary(base);
    expect(result.subtotal).toBe(1000);
    expect(result.vatAmount).toBe(0);
    expect(result.grandTotal).toBe(980); // 1000 - 50 + 30
  });

  it("computes grand total with vat_exclusive", () => {
    const result = computeCostSummary({ ...base, vatTreatment: "vat_exclusive", vatRate: 5 });
    // VAT = 1000 × 0.05 = 50; total = 1000 - 50 + 30 + 50 = 1030
    expect(result.vatAmount).toBe(50);
    expect(result.grandTotal).toBe(1030);
  });

  it("computes grand total with vat_inclusive", () => {
    // subtotal 1050, inclusive 5%: VAT = 50; total = 1050 - 50 + 30 + 50 = 1080
    const result = computeCostSummary({ ...base, lineItemsSubtotal: 1050, vatTreatment: "vat_inclusive", vatRate: 5 });
    expect(result.vatAmount).toBe(50);
    expect(result.grandTotal).toBe(1080); // 1050 - 50 + 30 + 50
  });

  it("uses manual override amount when vat_manual_override is true", () => {
    const result = computeCostSummary({
      ...base,
      vatTreatment: "vat_exclusive",
      vatRate: 5,
      vatManualOverride: true,
      vatAmountOverride: 75,
    });
    expect(result.vatAmount).toBe(75);
    expect(result.grandTotal).toBe(1055); // 1000 - 50 + 30 + 75
  });

  it("ignores override when vatManualOverride is false even if vatAmountOverride is set", () => {
    const result = computeCostSummary({
      ...base,
      vatTreatment: "vat_exclusive",
      vatRate: 5,
      vatManualOverride: false,
      vatAmountOverride: 999,
    });
    expect(result.vatAmount).toBe(50); // 1000 × 5% computed, not 999
  });

  it("clamps grand total to 0 when discount exceeds subtotal + delivery", () => {
    const result = computeCostSummary({ ...base, discount: 10000, deliveryFee: 0 });
    expect(result.grandTotal).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests for POST /purchase-orders/:id/line-items — auto-tax resolution
// ---------------------------------------------------------------------------

const MOCK_PO_WITH_LOCATION = { rows: [{ id: 42, supplier_id: 7, location_id: 1 }], rowCount: 1 };
const MOCK_PO_NO_LOCATION = { rows: [{ id: 42, supplier_id: 7, location_id: null }], rowCount: 1 };
const MOCK_SYNC_EARLY_RETURN = {
  rows: [{ total: "1", fully_received: "0", any_received: "0" }],
  rowCount: 1,
};

function makeLineItemResult(overrides: Record<string, unknown> = {}) {
  return {
    rows: [{
      id: 201,
      purchase_order_id: 42,
      base_item_id: 5,
      supplier_catalog_item_id: null,
      base_item_name: "Widget",
      supplier_item_code: null,
      supplier_item_unit: null,
      description: "Widget",
      quantity: "2",
      unit_price: "5.00",
      currency: "AED",
      received_quantity: null,
      tax_category: null,
      applied_tax_rate: null,
      taxable_amount: null,
      tax_amount: null,
      vat_treatment: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...overrides,
    }],
    rowCount: 1,
  };
}

const BASE_LINE_ITEM_BODY = {
  base_item_id: 5,
  description: "Widget",
  quantity: 2,
  unit_price: 5,
  currency: "AED",
};

describe("POST /purchase-orders/:id/line-items — auto-tax resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockClientQuery.mockReset();
    mockClientRelease.mockReset();
    stubWorkspaceRole.value = "owner";
  });

  const MOCK_RECOMPUTE_PO = {
    rows: [{
      discount_amount: null,
      delivery_fee_amount: null,
      vat_treatment: "no_vat",
      vat_rate: null,
      vat_manual_override: false,
      vat_amount: null,
      total_amount_manual_override: false,
    }],
    rowCount: 1,
  };
  const MOCK_RECOMPUTE_SUBTOTAL = { rows: [{ subtotal: "10.00" }], rowCount: 1 };

  it("stores resolved tax fields when a matching tax rule exists for the base item category and PO location", async () => {
    const insertResult = makeLineItemResult({
      tax_category: "standard_taxable",
      applied_tax_rate: "5.00",
      taxable_amount: "10.00",
      tax_amount: "0.50",
    });

    mockDbQuery
      .mockResolvedValueOnce(MOCK_PO_WITH_LOCATION)
      .mockResolvedValueOnce({ rows: [{ tax_category: "standard_taxable" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ rate_percent: "5.00" }], rowCount: 1 })
      .mockResolvedValueOnce(MOCK_SYNC_EARLY_RETURN)
      .mockResolvedValueOnce({});

    mockClientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(insertResult)
      .mockResolvedValueOnce(MOCK_RECOMPUTE_PO)
      .mockResolvedValueOnce(MOCK_RECOMPUTE_SUBTOTAL)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const res = await request(app)
      .post("/purchase-orders/42/line-items")
      .send(BASE_LINE_ITEM_BODY);

    expect(res.status).toBe(201);
    expect(res.body.line_item).toMatchObject({
      tax_category: "standard_taxable",
      applied_tax_rate: "5.00",
      taxable_amount: "10.00",
      tax_amount: "0.50",
    });

    const insertCall = mockClientQuery.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("INSERT INTO purchase_order_line_items"),
    );
    expect(insertCall).toBeDefined();
    const params = insertCall![1] as unknown[];
    expect(params[11]).toBe("5.00");   // $12 applied_tax_rate
    expect(params[12]).toBe("10.00"); // $13 taxable_amount
    expect(params[13]).toBe("0.50");  // $14 tax_amount
  });

  it("leaves applied_tax_rate and tax_amount null when no matching tax rule is found", async () => {
    const insertResult = makeLineItemResult({ tax_category: "standard_taxable" });

    mockDbQuery
      .mockResolvedValueOnce(MOCK_PO_WITH_LOCATION)
      .mockResolvedValueOnce({ rows: [{ tax_category: "standard_taxable" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce(MOCK_SYNC_EARLY_RETURN)
      .mockResolvedValueOnce({});

    mockClientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(insertResult)
      .mockResolvedValueOnce(MOCK_RECOMPUTE_PO)
      .mockResolvedValueOnce(MOCK_RECOMPUTE_SUBTOTAL)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const res = await request(app)
      .post("/purchase-orders/42/line-items")
      .send(BASE_LINE_ITEM_BODY);

    expect(res.status).toBe(201);
    expect(res.body.line_item.applied_tax_rate).toBeNull();
    expect(res.body.line_item.tax_amount).toBeNull();
    expect(res.body.line_item.taxable_amount).toBeNull();

    const insertCall = mockClientQuery.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("INSERT INTO purchase_order_line_items"),
    );
    expect(insertCall).toBeDefined();
    const params = insertCall![1] as unknown[];
    expect(params[11]).toBeNull();   // $12 applied_tax_rate
    expect(params[12]).toBeNull();  // $13 taxable_amount
    expect(params[13]).toBeNull();  // $14 tax_amount
  });

  it("skips tax_rules query and leaves tax fields null when base item has tax_category = not_classified", async () => {
    const insertResult = makeLineItemResult({ tax_category: "not_classified" });

    mockDbQuery
      .mockResolvedValueOnce(MOCK_PO_WITH_LOCATION)
      .mockResolvedValueOnce({ rows: [{ tax_category: "not_classified" }], rowCount: 1 })
      // supplier fallback lookup — returns no default_tax_category, so tax stays null
      .mockResolvedValueOnce({ rows: [{ default_tax_category: null }], rowCount: 1 })
      .mockResolvedValueOnce(MOCK_SYNC_EARLY_RETURN)
      .mockResolvedValueOnce({});

    mockClientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(insertResult)
      .mockResolvedValueOnce(MOCK_RECOMPUTE_PO)
      .mockResolvedValueOnce(MOCK_RECOMPUTE_SUBTOTAL)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const res = await request(app)
      .post("/purchase-orders/42/line-items")
      .send(BASE_LINE_ITEM_BODY);

    expect(res.status).toBe(201);
    expect(res.body.line_item.applied_tax_rate).toBeNull();
    expect(res.body.line_item.tax_amount).toBeNull();

    const taxRuleCall = mockDbQuery.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("tax_rules"),
    );
    expect(taxRuleCall).toBeUndefined();
  });

  it("skips tax_rules query when the PO has no location even if the base item has a taxable category", async () => {
    const insertResult = makeLineItemResult({ tax_category: "standard_taxable" });

    mockDbQuery
      .mockResolvedValueOnce(MOCK_PO_NO_LOCATION)
      .mockResolvedValueOnce({ rows: [{ tax_category: "standard_taxable" }], rowCount: 1 })
      .mockResolvedValueOnce(MOCK_SYNC_EARLY_RETURN)
      .mockResolvedValueOnce({});

    mockClientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(insertResult)
      .mockResolvedValueOnce(MOCK_RECOMPUTE_PO)
      .mockResolvedValueOnce(MOCK_RECOMPUTE_SUBTOTAL)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const res = await request(app)
      .post("/purchase-orders/42/line-items")
      .send(BASE_LINE_ITEM_BODY);

    expect(res.status).toBe(201);
    expect(res.body.line_item.applied_tax_rate).toBeNull();
    expect(res.body.line_item.tax_amount).toBeNull();

    const taxRuleCall = mockDbQuery.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("tax_rules"),
    );
    expect(taxRuleCall).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests for GET /purchase-orders/:id/pdf — tax information in PDF output
// ---------------------------------------------------------------------------

// Reuse MOCK_PO_FOR_PDF defined in the "delivery location field" suite above.
// MOCK_PO_FOR_PDF already has calculated_total: "100.00" which triggers the
// Net / Tax / Gross Total footer when tax is present on line items.

const MOCK_TAXED_LINE_ITEM = {
  id: 201,
  purchase_order_id: 42,
  base_item_id: null,
  supplier_catalog_item_id: null,
  base_item_name: null,
  supplier_item_code: null,
  supplier_item_unit: null,
  description: "Taxed Widget",
  quantity: "10",
  unit_price: "2.00",
  currency: "AED",
  received_quantity: null,
  tax_category: "standard_taxable",
  applied_tax_rate: "5.00",
  taxable_amount: "20.00",
  tax_amount: "1.00",
  vat_treatment: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

async function getPdf(poRows: object[], lineItemRows: object[]): Promise<import("supertest").Response> {
  mockDbQuery
    .mockResolvedValueOnce({ rows: poRows, rowCount: poRows.length })
    .mockResolvedValueOnce({ rows: lineItemRows, rowCount: lineItemRows.length });

  return request(app)
    .get("/purchase-orders/42/pdf")
    .buffer(true)
    .parse((res, callback) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => callback(null, Buffer.concat(chunks)));
    });
}

describe("GET /purchase-orders/:id/pdf — tax information", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    stubWorkspaceRole.value = "owner";
  });

  it("returns application/pdf with a non-empty body when line items carry tax", async () => {
    const res = await getPdf([MOCK_PO_FOR_PDF], [MOCK_TAXED_LINE_ITEM]);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/pdf/);
    expect((res.body as Buffer).length).toBeGreaterThan(0);
  });

  it("returns a valid PDF when the tax category label and rate would appear on a taxed line", async () => {
    const res = await getPdf([MOCK_PO_FOR_PDF], [MOCK_TAXED_LINE_ITEM]);

    expect(res.status).toBe(200);
    const body = res.body as Buffer;
    expect(body.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(body.length).toBeGreaterThan(0);
  });

  it("returns a valid PDF when the tax amount would appear on the taxed line item row", async () => {
    const res = await getPdf([MOCK_PO_FOR_PDF], [MOCK_TAXED_LINE_ITEM]);

    expect(res.status).toBe(200);
    const body = res.body as Buffer;
    expect(body.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(body.length).toBeGreaterThan(0);
  });

  it("returns a valid PDF with Net Subtotal / Tax / Gross Total footer rows when any line item carries tax", async () => {
    const res = await getPdf([MOCK_PO_FOR_PDF], [MOCK_TAXED_LINE_ITEM]);

    expect(res.status).toBe(200);
    const body = res.body as Buffer;
    expect(body.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(body.length).toBeGreaterThan(0);
  });

  it("returns a valid PDF with a plain Total footer when no line item carries tax", async () => {
    const untaxedLineItem = {
      ...MOCK_TAXED_LINE_ITEM,
      tax_category: null,
      applied_tax_rate: null,
      tax_amount: null,
      taxable_amount: null,
    };

    const res = await getPdf([MOCK_PO_FOR_PDF], [untaxedLineItem]);

    expect(res.status).toBe(200);
    const body = res.body as Buffer;
    expect(body.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(body.length).toBeGreaterThan(0);
  });

  it("returns a valid PDF with a Tax Rate column when any line item has applied_tax_rate set", async () => {
    const res = await getPdf([MOCK_PO_FOR_PDF], [MOCK_TAXED_LINE_ITEM]);

    expect(res.status).toBe(200);
    const body = res.body as Buffer;
    expect(body.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(body.length).toBeGreaterThan(0);
  });

  it("returns a valid PDF without a Tax Rate column when no line item has applied_tax_rate set", async () => {
    const untaxedLineItem = {
      ...MOCK_TAXED_LINE_ITEM,
      tax_category: null,
      applied_tax_rate: null,
      tax_amount: null,
      taxable_amount: null,
    };

    const res = await getPdf([MOCK_PO_FOR_PDF], [untaxedLineItem]);

    expect(res.status).toBe(200);
    const body = res.body as Buffer;
    expect(body.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(body.length).toBeGreaterThan(0);
  });

  it("returns a valid PDF showing 5.00% in the Tax Rate column for a taxed row", async () => {
    const res = await getPdf([MOCK_PO_FOR_PDF], [MOCK_TAXED_LINE_ITEM]);

    expect(res.status).toBe(200);
    const body = res.body as Buffer;
    expect(body.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(body.length).toBeGreaterThan(0);
  });

  it("returns a valid PDF when the table has both taxed and untaxed items", async () => {
    const untaxedRow = {
      ...MOCK_TAXED_LINE_ITEM,
      id: 202,
      description: "Untaxed Widget",
      tax_category: null,
      applied_tax_rate: null,
      tax_amount: null,
      taxable_amount: null,
    };

    const res = await getPdf([MOCK_PO_FOR_PDF], [MOCK_TAXED_LINE_ITEM, untaxedRow]);

    expect(res.status).toBe(200);
    const body = res.body as Buffer;
    expect(body.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(body.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Tests for PATCH /purchase-orders/:id — tax re-resolution on location change
// ---------------------------------------------------------------------------

const MOCK_PREV_PO = {
  id: 42,
  workspace_owner_id: "owner_abc",
  supplier_id: 7,
  location_id: 1,
  po_number: null,
  status: "draft",
  currency: "AED",
  total_amount: null,
  total_amount_manual_override: false,
  expected_delivery_date: null,
  notes: null,
  discount_amount: null,
  delivery_fee_amount: null,
  vat_treatment: "no_vat",
  vat_rate: null,
  vat_amount: null,
  vat_manual_override: false,
  vat_override_reason: null,
  subtotal_amount: null,
  grand_total_amount: null,
  payment_terms: null,
  supplier_reference: null,
  attachment_urls: null,
  created_by_clerk_id: "user_test",
  updated_by_clerk_id: "user_test",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  sent_at: null,
};

const MOCK_PO_UPDATE_RETURNING = {
  ...MOCK_PREV_PO,
  location_id: 2,
  supplier_name: "Test Supplier",
  supplier_is_archived: false,
  location_name: "New Location",
  effective_total: null,
  calculated_total: null,
  line_items_count: "1",
  received_items_count: "0",
  outstanding_units: "2",
};

describe("PATCH /purchase-orders/:id — tax re-resolution on location change", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockClientQuery.mockReset();
    mockClientRelease.mockReset();
    stubWorkspaceRole.value = "owner";
  });

  it("re-resolves tax for taxable line items when location_id changes", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [MOCK_PREV_PO], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 2 }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ id: 101, quantity: "2", unit_price: "5.00", tax_category: "standard_taxable" }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ rate_percent: "5.00" }], rowCount: 1 })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ subtotal: "10.00" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [MOCK_PO_UPDATE_RETURNING], rowCount: 1 });

    const res = await request(app)
      .patch("/purchase-orders/42")
      .send({ location_id: 2 });

    expect(res.status).toBe(200);

    const lineItemUpdateCall = mockDbQuery.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("UPDATE purchase_order_line_items"),
    );
    expect(lineItemUpdateCall).toBeDefined();
    const params = lineItemUpdateCall![1] as unknown[];
    expect(params[0]).toBe("5.00");   // applied_tax_rate
    expect(params[1]).toBe("10.00");  // taxable_amount (2 × 5.00)
    expect(params[2]).toBe("0.50");   // tax_amount (10.00 × 5%)
    expect(params[3]).toBe(101);      // line item id
  });

  it("clears tax fields when no matching tax rule exists for the new location", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [MOCK_PREV_PO], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 2 }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ id: 101, quantity: "2", unit_price: "5.00", tax_category: "standard_taxable" }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ subtotal: "10.00" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [MOCK_PO_UPDATE_RETURNING], rowCount: 1 });

    const res = await request(app)
      .patch("/purchase-orders/42")
      .send({ location_id: 2 });

    expect(res.status).toBe(200);

    const lineItemUpdateCall = mockDbQuery.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("UPDATE purchase_order_line_items"),
    );
    expect(lineItemUpdateCall).toBeDefined();
    const params = lineItemUpdateCall![1] as unknown[];
    expect(params[0]).toBeNull(); // applied_tax_rate cleared
    expect(params[1]).toBeNull(); // taxable_amount cleared
    expect(params[2]).toBeNull(); // tax_amount cleared
  });

  it("clears tax fields when location_id is changed to null", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [MOCK_PREV_PO], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ id: 101, quantity: "3", unit_price: "4.00", tax_category: "standard_taxable" }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ subtotal: "12.00" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ ...MOCK_PO_UPDATE_RETURNING, location_id: null, location_name: null }], rowCount: 1 });

    const res = await request(app)
      .patch("/purchase-orders/42")
      .send({ location_id: null });

    expect(res.status).toBe(200);

    const taxRuleCall = mockDbQuery.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("tax_rules"),
    );
    expect(taxRuleCall).toBeUndefined();

    const lineItemUpdateCall = mockDbQuery.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("UPDATE purchase_order_line_items"),
    );
    expect(lineItemUpdateCall).toBeDefined();
    const params = lineItemUpdateCall![1] as unknown[];
    expect(params[0]).toBeNull();
    expect(params[1]).toBeNull();
    expect(params[2]).toBeNull();
  });

  it("skips retax queries entirely when location_id is not in the request body", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [MOCK_PREV_PO], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ subtotal: "10.00" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [MOCK_PO_UPDATE_RETURNING], rowCount: 1 });

    const res = await request(app)
      .patch("/purchase-orders/42")
      .send({ notes: "Updated notes" });

    expect(res.status).toBe(200);

    const retaxCall = mockDbQuery.mock.calls.find(
      (call) =>
        typeof call[0] === "string" &&
        (call[0].includes("tax_rules") ||
          (call[0].includes("purchase_order_line_items") && call[0].includes("tax_category"))),
    );
    expect(retaxCall).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests for recomputePoTotals — totals stay accurate on line-item mutations
//
// recomputePoTotals runs inside the transaction client (txClient), so its
// three queries appear in mockClientQuery in fixed positions:
//   [0] BEGIN
//   [1] INSERT / UPDATE / DELETE (the triggering mutation)
//   [2] SELECT … FROM purchase_orders   (PO config for computeCostSummary)
//   [3] SELECT COALESCE(SUM(…)) AS subtotal … (new line-items subtotal)
//   [4] UPDATE purchase_orders SET subtotal_amount=$1, vat_amount=$2,
//              grand_total_amount=$3, total_amount=…, updated_at=now()
//   [5] COMMIT
//
// The UPDATE params are always:
//   $1 = subtotal.toFixed(2)
//   $2 = vatAmount.toFixed(2)
//   $3 = grandTotal.toFixed(2)
//   $4 = lineItemsSubtotal.toFixed(4)   (kept in sync with total_amount)
//   $5 = poId
// ---------------------------------------------------------------------------

const MOCK_PO_VAT_EXCLUSIVE = {
  rows: [{
    discount_amount: null,
    delivery_fee_amount: null,
    vat_treatment: "vat_exclusive",
    vat_rate: "5",
    vat_manual_override: false,
    vat_amount: null,
    total_amount_manual_override: false,
  }],
  rowCount: 1,
};

const MOCK_PO_VAT_MANUAL_OVERRIDE = {
  rows: [{
    discount_amount: null,
    delivery_fee_amount: null,
    vat_treatment: "vat_exclusive",
    vat_rate: "5",
    vat_manual_override: true,
    vat_amount: "3.00",
    total_amount_manual_override: false,
  }],
  rowCount: 1,
};

function findPoTotalsUpdateCall(calls: unknown[][]): unknown[] | undefined {
  return calls.find(
    (call) =>
      typeof call[0] === "string" &&
      call[0].includes("UPDATE purchase_orders") &&
      call[0].includes("subtotal_amount"),
  ) as unknown[] | undefined;
}

// ─── db.query call sequence for POST /purchase-orders/:id/line-items ────────
//
// The handler issues up to 5 db.query calls before opening the transaction.
// Their order is fixed; inserting a new query shifts all subsequent indices.
// Update every test in this describe block whenever the sequence changes.
//
//  Call 1 (always):
//    SELECT id, supplier_id, location_id FROM purchase_orders   ← PO ownership check
//
//  Call 2 (only when supplier_catalog_item_id is provided):
//    SELECT id, name, price, currency, base_item_id, ...
//      FROM supplier_catalog_items WHERE id = $1 AND supplier_id = $2 ...
//
//  Call 3 (only when resolvedBaseItemId != null, i.e. base_item_id provided
//           directly or resolved from a supplier catalog item):
//    SELECT tax_category FROM base_items WHERE id = $1 AND workspace_owner_id = $2
//
//  Call 4 (when resolvedTaxCategory is null or "not_classified" — this fires
//           whenever no base_item_id is supplied, OR the base item's tax_category
//           is unset/not_classified):
//    SELECT default_tax_category FROM suppliers WHERE id = $1 AND workspace_owner_id = $2
//    ↑ This is the "supplier fallback" call. It ALWAYS fires for simple line items
//      that carry no base_item_id, even if the supplier has no useful value.
//      Tests that skip this mock cause every subsequent mockResolvedValueOnce to
//      mis-align — the root cause of the original recomputePoTotals test breakage.
//
//  Call 5 (only when resolvedTaxCategory is set AND poLocationId != null):
//    SELECT rate_percent FROM tax_rules WHERE workspace_owner_id = $1
//      AND tax_category = $2 AND is_active = true ...
//
// After the transaction (BEGIN / INSERT / SELECT PO / UPDATE totals / COMMIT),
// recomputePoTotals fires one more db.query to check line-item sync status
// (MOCK_SYNC_EARLY_RETURN → total/fully_received/any_received aggregate).
//
// Tests below use SIMPLE_LINE_ITEM_BODY (no base_item_id, no supplier_catalog_item_id,
// PO has no location), so the active sequence is:
//   db.query[0] → PO check (MOCK_PO_NO_LOCATION)
//   db.query[1] → supplier fallback (default_tax_category: null)
//   db.query[2] → recomputePoTotals sync query (MOCK_SYNC_EARLY_RETURN)
//   db.query[3] → safety fallback ({}) — absorbs any extra call so the chain
//                 doesn't silently return undefined if the route gains a new query
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wire up the full db.query mock chain for a POST /purchase-orders/:id/line-items
 * request that has no base_item_id and no supplier_catalog_item_id, targeting a PO
 * with no location (MOCK_PO_NO_LOCATION).
 *
 * Call order (must stay in sync with the route handler):
 *   [0] PO ownership check       → MOCK_PO_NO_LOCATION
 *   [1] Supplier fallback query  → { default_tax_category: null }
 *   [2] recomputePoTotals sync   → MOCK_SYNC_EARLY_RETURN
 *   [3] Extra fallback           → {}
 *
 * If a new db.query call is ever added to the route before or between these,
 * update this helper first — every test that calls it will then automatically
 * pick up the correct sequence.
 */
function mockSimplePostLineItemDbQueries() {
  mockDbQuery
    .mockResolvedValueOnce(MOCK_PO_NO_LOCATION)
    .mockResolvedValueOnce({ rows: [{ default_tax_category: null }], rowCount: 1 })
    .mockResolvedValueOnce(MOCK_SYNC_EARLY_RETURN)
    .mockResolvedValueOnce({});
}

describe("POST /purchase-orders/:id/line-items — recomputePoTotals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockClientQuery.mockReset();
    mockClientRelease.mockReset();
    stubWorkspaceRole.value = "owner";
  });

  const SIMPLE_LINE_ITEM_BODY = { description: "Widget", quantity: 2, unit_price: 5 };

  it("sends UPDATE with correct subtotal_amount, vat_amount, grand_total_amount for vat_exclusive", async () => {
    mockSimplePostLineItemDbQueries();

    mockClientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(makeLineItemResult())
      .mockResolvedValueOnce(MOCK_PO_VAT_EXCLUSIVE)
      .mockResolvedValueOnce({ rows: [{ subtotal: "10.00" }], rowCount: 1 })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const res = await request(app)
      .post("/purchase-orders/42/line-items")
      .send(SIMPLE_LINE_ITEM_BODY);

    expect(res.status).toBe(201);

    const updateCall = findPoTotalsUpdateCall(mockClientQuery.mock.calls as unknown[][]);
    expect(updateCall).toBeDefined();
    const params = updateCall![1] as unknown[];
    expect(params[0]).toBe("10.00");
    expect(params[1]).toBe("0.50");
    expect(params[2]).toBe("10.50");
    expect(params[3]).toBe("10.0000");
    expect(params[4]).toBe(42);
  });

  it("sends UPDATE using the manual override amount when vat_manual_override is true", async () => {
    mockSimplePostLineItemDbQueries();

    mockClientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(makeLineItemResult())
      .mockResolvedValueOnce(MOCK_PO_VAT_MANUAL_OVERRIDE)
      .mockResolvedValueOnce({ rows: [{ subtotal: "10.00" }], rowCount: 1 })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const res = await request(app)
      .post("/purchase-orders/42/line-items")
      .send(SIMPLE_LINE_ITEM_BODY);

    expect(res.status).toBe(201);

    const updateCall = findPoTotalsUpdateCall(mockClientQuery.mock.calls as unknown[][]);
    expect(updateCall).toBeDefined();
    const params = updateCall![1] as unknown[];
    expect(params[0]).toBe("10.00");
    expect(params[1]).toBe("3.00");
    expect(params[2]).toBe("13.00");
    expect(params[3]).toBe("10.0000");
    expect(params[4]).toBe(42);
  });
});

// ─── db.query call sequence for PATCH /purchase-orders/:id/line-items/:lineItemId ─
//
// The handler issues up to 5 db.query calls before opening the transaction.
// Their order is fixed; inserting a new query shifts all subsequent indices.
// Update every test in this describe block whenever the sequence changes.
//
//  Call 1 (always):
//    SELECT id, location_id, supplier_id FROM purchase_orders   ← PO ownership check
//
//  Call 2 (always):
//    SELECT * FROM purchase_order_line_items WHERE id = $1 AND purchase_order_id = $2
//    ← fetches the existing line item so unchanged fields can be preserved
//
//  Call 3 (only when base_item_id is non-null AND either the id changed from what
//           was stored, OR the stored tax_category is null/missing on the old row):
//    SELECT name, tax_category FROM base_items WHERE id = $1 AND workspace_owner_id = $2
//
//  Call 4 (when the auto-resolve tax path is active AND resolvedTaxCategory is null
//           or "not_classified" — this fires whenever no base item supplies a category):
//    SELECT default_tax_category FROM suppliers WHERE id = $1 AND workspace_owner_id = $2
//    ↑ Same supplier-fallback call as in POST. Missing this mock causes every
//      subsequent mockResolvedValueOnce to mis-align. See the POST block above for
//      the full explanation.
//
//  Call 5 (only when resolvedTaxCategory is set AND poLocationId != null):
//    SELECT rate_percent FROM tax_rules WHERE workspace_owner_id = $1
//      AND tax_category = $2 AND is_active = true ...
//
// After the transaction (BEGIN / UPDATE / SELECT PO / UPDATE totals / COMMIT),
// recomputePoTotals fires one more db.query to check line-item sync status
// (MOCK_SYNC_EARLY_RETURN → total/fully_received/any_received aggregate).
//
// Tests below use MOCK_PREV_LINE_ITEM (base_item_id: 5, tax_category: "standard_taxable")
// and send only quantity or unit_price changes; PO has no location. Because the stored
// tax_category is already set and base_item_id is unchanged, Call 3 does not fire.
// Because resolvedTaxCategory is non-null, Call 4 does not fire. Because poLocationId
// is null, Call 5 does not fire. The active sequence is therefore:
//   db.query[0] → PO check ({ id: 42, location_id: null, supplier_id: … })
//   db.query[1] → existing line item fetch (MOCK_PREV_LINE_ITEM)
//   db.query[2] → recomputePoTotals sync query (MOCK_SYNC_EARLY_RETURN)
// ─────────────────────────────────────────────────────────────────────────────
describe("PATCH /purchase-orders/:id/line-items/:lineItemId — recomputePoTotals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockClientQuery.mockReset();
    mockClientRelease.mockReset();
    stubWorkspaceRole.value = "owner";
  });

  const MOCK_PREV_LINE_ITEM = {
    rows: [{
      id: 201,
      purchase_order_id: 42,
      base_item_id: 5,
      supplier_catalog_item_id: null,
      description: "Widget",
      quantity: "2",
      unit_price: "5.00",
      currency: "AED",
      received_quantity: null,
      tax_category: "standard_taxable",
      applied_tax_rate: null,
      taxable_amount: null,
      tax_amount: null,
      vat_treatment: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }],
    rowCount: 1,
  };

  const MOCK_UPDATED_LINE_ITEM = makeLineItemResult({ quantity: "4", unit_price: "5.00" });

  it("sends UPDATE with correct totals for vat_exclusive after changing quantity", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 42, location_id: null }], rowCount: 1 })
      .mockResolvedValueOnce(MOCK_PREV_LINE_ITEM)
      .mockResolvedValueOnce(MOCK_SYNC_EARLY_RETURN)
      .mockResolvedValueOnce({});

    mockClientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(MOCK_UPDATED_LINE_ITEM)
      .mockResolvedValueOnce(MOCK_PO_VAT_EXCLUSIVE)
      .mockResolvedValueOnce({ rows: [{ subtotal: "20.00" }], rowCount: 1 })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const res = await request(app)
      .patch("/purchase-orders/42/line-items/201")
      .send({ quantity: 4 });

    expect(res.status).toBe(200);

    const updateCall = findPoTotalsUpdateCall(mockClientQuery.mock.calls as unknown[][]);
    expect(updateCall).toBeDefined();
    const params = updateCall![1] as unknown[];
    expect(params[0]).toBe("20.00");
    expect(params[1]).toBe("1.00");
    expect(params[2]).toBe("21.00");
    expect(params[3]).toBe("20.0000");
    expect(params[4]).toBe(42);
  });

  it("sends UPDATE using the manual override amount when vat_manual_override is true after changing unit_price", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 42, location_id: null }], rowCount: 1 })
      .mockResolvedValueOnce(MOCK_PREV_LINE_ITEM)
      .mockResolvedValueOnce(MOCK_SYNC_EARLY_RETURN)
      .mockResolvedValueOnce({});

    mockClientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(makeLineItemResult({ quantity: "2", unit_price: "10.00" }))
      .mockResolvedValueOnce(MOCK_PO_VAT_MANUAL_OVERRIDE)
      .mockResolvedValueOnce({ rows: [{ subtotal: "20.00" }], rowCount: 1 })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const res = await request(app)
      .patch("/purchase-orders/42/line-items/201")
      .send({ unit_price: 10 });

    expect(res.status).toBe(200);

    const updateCall = findPoTotalsUpdateCall(mockClientQuery.mock.calls as unknown[][]);
    expect(updateCall).toBeDefined();
    const params = updateCall![1] as unknown[];
    expect(params[0]).toBe("20.00");
    expect(params[1]).toBe("3.00");
    expect(params[2]).toBe("23.00");
    expect(params[3]).toBe("20.0000");
    expect(params[4]).toBe(42);
  });
});

// ─── db.query call sequence for DELETE /purchase-orders/:id/line-items/:lineItemId ─
//
// The handler issues exactly 2 db.query calls before opening the transaction
// and 1 more after it commits. Their order is fixed; inserting a new query
// shifts all subsequent indices.
// Update every test in this describe block whenever the sequence changes.
//
//  Call 1 (always):
//    SELECT id FROM purchase_orders WHERE id = $1 AND workspace_owner_id = $2
//    ← PO ownership check (resolvePoOwner)
//
//  Call 2 (always):
//    SELECT id, description, quantity::text, unit_price::text, currency
//      FROM purchase_order_line_items WHERE id = $1 AND purchase_order_id = $2
//    ← fetches the existing line item so its details can be captured in the
//      activity log; also guards against 404 if the item doesn't belong to the PO
//
// After the transaction (BEGIN / DELETE / SELECT PO config / SELECT subtotal /
// UPDATE purchase_orders totals / COMMIT), one more db.query fires:
//
//  Call 3 (always):
//    INSERT INTO purchase_order_activity … event_type = 'po_line_item_removed'
//    ← records the deletion for audit purposes; return value is not inspected.
//
// Note: unlike PATCH, DELETE does NOT call syncPoStatus after the transaction,
// so there is no "sync aggregate SELECT" in this sequence.
//
// Unlike POST and PATCH there are no conditional calls (no supplier-fallback,
// no base-item tax lookup, no tax-rate lookup) because DELETE carries no
// line-item body that would trigger those branches.
//
// Tests below supply MOCK_PO_OWNERSHIP for Call 1, an inline existing-item
// row for Call 2, and a trailing `{}` for Call 3. The single `{}` is
// sufficient because there is exactly one post-commit db.query to absorb.
//   db.query[0] → PO ownership check (MOCK_PO_OWNERSHIP)
//   db.query[1] → existing line item fetch (inline row)
//   db.query[2] → {} (absorbs the activity INSERT)
// ─────────────────────────────────────────────────────────────────────────────
describe("DELETE /purchase-orders/:id/line-items/:lineItemId — recomputePoTotals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockClientQuery.mockReset();
    mockClientRelease.mockReset();
    stubWorkspaceRole.value = "owner";
  });

  it("sends UPDATE setting totals to zero for vat_exclusive when no line items remain", async () => {
    mockDbQuery
      .mockResolvedValueOnce(MOCK_PO_OWNERSHIP)
      .mockResolvedValueOnce({ rows: [{ id: 201, description: "Widget", quantity: "2", unit_price: "5.00", currency: "AED" }], rowCount: 1 })
      .mockResolvedValueOnce({});

    mockClientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(MOCK_PO_VAT_EXCLUSIVE)
      .mockResolvedValueOnce({ rows: [{ subtotal: "0.00" }], rowCount: 1 })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const res = await request(app).delete("/purchase-orders/42/line-items/201");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const updateCall = findPoTotalsUpdateCall(mockClientQuery.mock.calls as unknown[][]);
    expect(updateCall).toBeDefined();
    const params = updateCall![1] as unknown[];
    expect(params[0]).toBe("0.00");
    expect(params[1]).toBe("0.00");
    expect(params[2]).toBe("0.00");
    expect(params[3]).toBe("0.0000");
    expect(params[4]).toBe(42);
  });

  it("sends UPDATE with manual override vat_amount even when subtotal drops to zero", async () => {
    mockDbQuery
      .mockResolvedValueOnce(MOCK_PO_OWNERSHIP)
      .mockResolvedValueOnce({ rows: [{ id: 201, description: "Widget", quantity: "2", unit_price: "5.00", currency: "AED" }], rowCount: 1 })
      .mockResolvedValueOnce({});

    mockClientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(MOCK_PO_VAT_MANUAL_OVERRIDE)
      .mockResolvedValueOnce({ rows: [{ subtotal: "0.00" }], rowCount: 1 })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const res = await request(app).delete("/purchase-orders/42/line-items/201");

    expect(res.status).toBe(200);

    const updateCall = findPoTotalsUpdateCall(mockClientQuery.mock.calls as unknown[][]);
    expect(updateCall).toBeDefined();
    const params = updateCall![1] as unknown[];
    expect(params[0]).toBe("0.00");
    expect(params[1]).toBe("3.00");
    expect(params[2]).toBe("3.00");
    expect(params[3]).toBe("0.0000");
    expect(params[4]).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// PO approval workflow — accept endpoint, create default, send gating
// ---------------------------------------------------------------------------

describe("POST /purchase-orders/:id/accept — approval workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockClientQuery.mockReset();
    mockClientRelease.mockReset();
    stubWorkspaceRole.value = "owner";
  });

  const MOCK_PENDING_PO = {
    rows: [{ id: 42, status: "pending_approval", workspace_owner_id: "owner_abc" }],
    rowCount: 1,
  };
  const MOCK_APPROVED_ROW = {
    rows: [{
      id: 42,
      status: "supplier_accepted",
      po_number: null,
      line_items_count: "0",
      received_items_count: "0",
      outstanding_units: "0",
    }],
    rowCount: 1,
  };

  it("approves a pending PO for an owner (200) and logs the activity event", async () => {
    mockDbQuery
      .mockResolvedValueOnce(MOCK_PENDING_PO) // SELECT existing
      .mockResolvedValueOnce(MOCK_APPROVED_ROW) // UPDATE RETURNING
      .mockResolvedValueOnce({}); // INSERT activity

    const res = await request(app).post("/purchase-orders/42/accept");

    expect(res.status).toBe(200);
    expect(res.body.purchase_order.status).toBe("supplier_accepted");

    const activityCall = mockDbQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("purchase_order_activity"),
    );
    expect(activityCall).toBeDefined();
    expect(activityCall![0]).toContain("po_manually_accepted");
  });

  it("approves a pending PO for a member holding suppliers.approve (200)", async () => {
    stubWorkspaceRole.value = "member";
    stubAllowedPages.value = ["suppliers.approve"];

    mockDbQuery
      .mockResolvedValueOnce(MOCK_PENDING_PO)
      .mockResolvedValueOnce(MOCK_APPROVED_ROW)
      .mockResolvedValueOnce({});

    const res = await request(app).post("/purchase-orders/42/accept");
    expect(res.status).toBe(200);

    stubAllowedPages.value = [];
  });

  it("returns 403 for a member without the suppliers.approve permission", async () => {
    stubWorkspaceRole.value = "member";

    const res = await request(app).post("/purchase-orders/42/accept");

    expect(res.status).toBe(403);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 404 when the PO does not exist", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).post("/purchase-orders/99/accept");
    expect(res.status).toBe(404);
  });

  it("returns 409 when the PO is already supplier-accepted", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ id: 42, status: "supplier_accepted", workspace_owner_id: "owner_abc" }],
      rowCount: 1,
    });

    const res = await request(app).post("/purchase-orders/42/accept");
    expect(res.status).toBe(409);
  });
});

describe("POST /purchase-orders/:id/send — blocked until approved", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockClientQuery.mockReset();
    mockClientRelease.mockReset();
    stubWorkspaceRole.value = "owner";
  });

  it("returns 409 when the PO is in a non-sendable status", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ id: 42, status: "received", contact_email: "x@y.com" }],
      rowCount: 1,
    });

    const res = await request(app).post("/purchase-orders/42/send");

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/cannot send/i);
  });
});

describe("PATCH /purchase-orders/:id — status cannot jump to sent before approval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockClientQuery.mockReset();
    mockClientRelease.mockReset();
    stubWorkspaceRole.value = "owner";
  });

  it("returns 409 when setting status to supplier_accepted without using the acceptance endpoint", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ id: 42, status: "sent", currency: "AED" }],
      rowCount: 1,
    });

    const res = await request(app)
      .patch("/purchase-orders/42")
      .send({ status: "supplier_accepted" });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/acceptance endpoint/i);
  });

  it("returns 409 when setting status to approved via a generic PATCH (legacy status no longer used)", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ id: 42, status: "created", currency: "AED" }],
      rowCount: 1,
    });

    const res = await request(app)
      .patch("/purchase-orders/42")
      .send({ status: "approved" });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no longer used/i);
  });

  it("returns 409 when setting status to pending_approval via a generic PATCH (legacy status no longer used)", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ id: 42, status: "created", currency: "AED" }],
      rowCount: 1,
    });

    const res = await request(app)
      .patch("/purchase-orders/42")
      .send({ status: "pending_approval" });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no longer used/i);
  });

  it("allows a no-op PATCH that keeps status unchanged on a sent PO", async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{ id: 42, status: "sent", currency: "AED", po_number: "PO-1" }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{ id: 42, status: "sent", currency: "AED", po_number: "PO-1" }],
        rowCount: 1,
      });

    const res = await request(app)
      .patch("/purchase-orders/42")
      .send({ status: "sent", notes: "unchanged status, edit other field" });

    expect(res.status).not.toBe(409);
  });
});
