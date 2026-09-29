import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

// ---------------------------------------------------------------------------
// Hoisted mock state
// ---------------------------------------------------------------------------

const { mockDbQuery, mockSendPurchaseOrderEmail, stubWorkspaceRole } = vi.hoisted(() => ({
  mockDbQuery: vi.fn(),
  mockSendPurchaseOrderEmail: vi.fn(),
  stubWorkspaceRole: { value: "owner" as "owner" | "member" },
}));

// ---------------------------------------------------------------------------
// Mocks — all declared before any imports
// ---------------------------------------------------------------------------

vi.mock("../lib/db", () => ({
  db: { query: (...args: unknown[]) => mockDbQuery(...args) },
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
    wreq.allowedPages = [];
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
  sendPurchaseOrderEmail: (...args: unknown[]) => mockSendPurchaseOrderEmail(...args),
}));

// ---------------------------------------------------------------------------
// Router import (after vi.mock hoisting)
// ---------------------------------------------------------------------------

import purchaseOrdersRouter from "./purchaseOrders";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const MOCK_PO_ROW = {
  id: 42,
  workspace_owner_id: "owner_abc",
  supplier_id: 7,
  po_number: "PO-0042",
  status: "created",
  currency: "AED",
  total_amount: null,
  total_amount_manual_override: false,
  effective_total: null,
  calculated_total: null,
  expected_delivery_date: null,
  notes: null,
  created_by_clerk_id: "user_test",
  updated_by_clerk_id: "user_test",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  sent_at: null,
  supplier_name: "ACME Supplies",
  contact_email: "acme@example.com",
  line_items_count: "0",
  received_items_count: "0",
};

const MOCK_UPDATED_PO_ROW = {
  ...MOCK_PO_ROW,
  status: "sent",
  sent_at: new Date().toISOString(),
};

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(purchaseOrdersRouter);
  return app;
}

const app = makeApp();

// ---------------------------------------------------------------------------
// Tests for POST /purchase-orders/:id/send
// ---------------------------------------------------------------------------

describe("POST /purchase-orders/:id/send — line item fetching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    stubWorkspaceRole.value = "owner";
    mockSendPurchaseOrderEmail.mockResolvedValue(undefined);
  });

  it("fetches line items from the DB before sending the email", async () => {
    const lineItems = [
      { description: "Ribbon Roll", quantity: "10", unit_price: "3.50", currency: "AED" },
      { description: "Gift Box",   quantity: "5",  unit_price: "8.00", currency: "AED" },
    ];

    mockDbQuery
      .mockResolvedValueOnce({ rows: [MOCK_PO_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: lineItems, rowCount: 2 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [MOCK_UPDATED_PO_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app).post("/purchase-orders/42/send");

    expect(res.status).toBe(200);

    const secondCall = mockDbQuery.mock.calls[1];
    const sql: string = secondCall[0];
    expect(sql).toMatch(/purchase_order_line_items/);
    expect(sql).toMatch(/purchase_order_id/);
    const params: unknown[] = secondCall[1];
    expect(params[0]).toBe(42);
  });

  it("passes the fetched line items to sendPurchaseOrderEmail", async () => {
    const lineItems = [
      { description: "Sticker Pack", quantity: "3", unit_price: "5.00", currency: "AED" },
    ];

    mockDbQuery
      .mockResolvedValueOnce({ rows: [MOCK_PO_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: lineItems, rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [MOCK_UPDATED_PO_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app).post("/purchase-orders/42/send");

    expect(res.status).toBe(200);
    expect(mockSendPurchaseOrderEmail).toHaveBeenCalledOnce();
    expect(mockSendPurchaseOrderEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        lineItems: lineItems,
      }),
    );
  });

  it("passes an empty lineItems array to sendPurchaseOrderEmail when the PO has no line items", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [MOCK_PO_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [MOCK_UPDATED_PO_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app).post("/purchase-orders/42/send");

    expect(res.status).toBe(200);
    expect(mockSendPurchaseOrderEmail).toHaveBeenCalledOnce();
    expect(mockSendPurchaseOrderEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        lineItems: [],
      }),
    );
  });

  it("computes effectiveTotal from line items when no manual total_amount is set", async () => {
    const lineItems = [
      { description: "Item A", quantity: "2", unit_price: "10.00", currency: "AED" },
      { description: "Item B", quantity: "3", unit_price: "5.00", currency: "AED" },
    ];

    mockDbQuery
      .mockResolvedValueOnce({ rows: [MOCK_PO_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: lineItems, rowCount: 2 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [MOCK_UPDATED_PO_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app).post("/purchase-orders/42/send");

    expect(res.status).toBe(200);
    expect(mockSendPurchaseOrderEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        effectiveTotal: "35.0000",
      }),
    );
  });

  it("uses total_amount as effectiveTotal when the PO has no line items", async () => {
    const poWithManualTotal = {
      ...MOCK_PO_ROW,
      total_amount: "250.00",
    };

    mockDbQuery
      .mockResolvedValueOnce({ rows: [poWithManualTotal], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [MOCK_UPDATED_PO_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app).post("/purchase-orders/42/send");

    expect(res.status).toBe(200);
    expect(mockSendPurchaseOrderEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        effectiveTotal: "250.00",
      }),
    );
  });

  it("returns 400 when the supplier has no contact email", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ ...MOCK_PO_ROW, contact_email: null }],
      rowCount: 1,
    });

    const res = await request(app).post("/purchase-orders/42/send");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no contact email/i);
    expect(mockSendPurchaseOrderEmail).not.toHaveBeenCalled();
  });

  it("returns 404 when the purchase order is not found", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).post("/purchase-orders/42/send");

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
    expect(mockSendPurchaseOrderEmail).not.toHaveBeenCalled();
  });

  it("returns 403 for a non-owner member without suppliers.edit permission", async () => {
    stubWorkspaceRole.value = "member";

    const res = await request(app).post("/purchase-orders/42/send");

    expect(res.status).toBe(403);
    expect(mockSendPurchaseOrderEmail).not.toHaveBeenCalled();
  });

  it("advances PO status to 'sent' after emailing", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [MOCK_PO_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [MOCK_UPDATED_PO_ROW], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app).post("/purchase-orders/42/send");

    expect(res.status).toBe(200);
    expect(res.body.purchase_order.status).toBe("sent");

    const updateCall = mockDbQuery.mock.calls[5];
    const updateSql: string = updateCall[0];
    expect(updateSql).toMatch(/status = 'sent'/);
    expect(updateSql).toMatch(/sent_at = now\(\)/);
  });
});
