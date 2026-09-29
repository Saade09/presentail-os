/**
 * Unit tests: GET /api/orders/:id/invoice sender selection.
 *
 * Verifies that the invoice route reads the order's recorded payment
 * (order_payment.method / .provider) and passes the correct sender block to
 * the PDF builder: Presentail LTD (Cyprus address) for Stripe/PayPal
 * payments, Presentail SAL for everything else. The db and the PDF builder
 * are mocked; queries are matched by SQL text (not call order) so unrelated
 * query changes don't break these tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

const mockDbQuery = vi.fn();

vi.mock("../lib/orderWhatsappNotify", () => ({
  notifyOrderStatusWhatsApp: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
    connect: vi.fn(),
  },
  withTransaction: async (_client: unknown, fn: () => Promise<unknown>) => fn(),
}));

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
    wreq.workspaceOwnerId = "owner_123";
    wreq.workspaceRole = "owner";
    wreq.workspaceActualRole = "owner";
    wreq.userId = "user_1";
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
  hasPageAccess: () => true,
}));

vi.mock("../lib/catalogWebhook", () => ({
  fireWebhookEvent: vi.fn().mockResolvedValue(undefined),
}));

const mockBuildOrderInvoicePdf = vi.fn();

vi.mock("../lib/orderInvoicePdf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/orderInvoicePdf")>();
  return {
    ...actual,
    buildOrderInvoicePdf: (...args: unknown[]) => mockBuildOrderInvoicePdf(...args),
  };
});

import { SAL_SENDER_LINES, LTD_SENDER_LINES } from "../lib/orderInvoicePdf";
import ordersRouter from "./orders";

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: Record<string, (...a: unknown[]) => void> }).log = {
      error: () => {},
      warn: () => {},
      info: () => {},
    };
    next();
  });
  app.use("/api", ordersRouter);
  return app;
}

const ORDER_ID = "11111111-1111-1111-1111-111111111111";

/**
 * Route db.query calls by SQL text. `payment` controls the row returned for
 * the order_payment lookup (null → no payment recorded).
 */
function stubQueries(payment: { method: string | null; provider: string | null } | null) {
  mockDbQuery.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM orders")) {
      return {
        rowCount: 1,
        rows: [
          {
            id: ORDER_ID,
            display_order_number: "PT-1001",
            created_at: "2026-07-01T00:00:00Z",
            totals: { total: 45, subtotal: 45, currency: "USD" },
          },
        ],
      };
    }
    if (sql.includes("FROM order_line_items")) {
      return {
        rowCount: 1,
        rows: [{ name: "Rose Bouquet", quantity: 1, unit_price: "45", line_total: "45" }],
      };
    }
    if (sql.includes("FROM order_contacts")) {
      return { rowCount: 0, rows: [] };
    }
    if (sql.includes("FROM order_payment")) {
      return payment ? { rowCount: 1, rows: [payment] } : { rowCount: 0, rows: [] };
    }
    return { rowCount: 0, rows: [] };
  });
}

describe("GET /api/orders/:id/invoice — sender selection", () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    mockBuildOrderInvoicePdf.mockResolvedValue(Buffer.from("%PDF-fake"));
    app = makeApp();
  });

  async function downloadInvoice(): Promise<request.Response> {
    return request(app).get(`/api/orders/${ORDER_ID}/invoice`);
  }

  it("uses the Presentail LTD sender for a Stripe payment", async () => {
    stubQueries({ method: "Stripe", provider: null });
    const res = await downloadInvoice();
    expect(res.status).toBe(200);
    expect(mockBuildOrderInvoicePdf).toHaveBeenCalledTimes(1);
    const data = mockBuildOrderInvoicePdf.mock.calls[0][0] as { senderLines: string[] };
    expect(data.senderLines).toEqual(LTD_SENDER_LINES);
    expect(data.senderLines[0]).toBe("Presentail LTD");
  });

  it("uses the Presentail LTD sender for a PayPal payment (provider column)", async () => {
    stubQueries({ method: "wallet", provider: "PayPal" });
    const res = await downloadInvoice();
    expect(res.status).toBe(200);
    const data = mockBuildOrderInvoicePdf.mock.calls[0][0] as { senderLines: string[] };
    expect(data.senderLines).toEqual(LTD_SENDER_LINES);
  });

  it("keeps the Presentail SAL sender for a Whish payment", async () => {
    stubQueries({ method: "Whish", provider: "whish" });
    const res = await downloadInvoice();
    expect(res.status).toBe(200);
    const data = mockBuildOrderInvoicePdf.mock.calls[0][0] as { senderLines: string[] };
    expect(data.senderLines).toEqual(SAL_SENDER_LINES);
    expect(data.senderLines[0]).toBe("Presentail SAL");
  });

  it("keeps the Presentail SAL sender for a cash payment", async () => {
    stubQueries({ method: "cash", provider: null });
    const res = await downloadInvoice();
    expect(res.status).toBe(200);
    const data = mockBuildOrderInvoicePdf.mock.calls[0][0] as { senderLines: string[] };
    expect(data.senderLines).toEqual(SAL_SENDER_LINES);
    expect(data.senderLines[0]).toBe("Presentail SAL");
  });

  it("keeps the Presentail SAL sender when no payment row exists", async () => {
    stubQueries(null);
    const res = await downloadInvoice();
    expect(res.status).toBe(200);
    const data = mockBuildOrderInvoicePdf.mock.calls[0][0] as { senderLines: string[] };
    expect(data.senderLines).toEqual(SAL_SENDER_LINES);
  });

  it("uses the explicitly selected invoice name", async () => {
    stubQueries(null);
    const res = await request(app)
      .get(`/api/orders/${ORDER_ID}/invoice`)
      .query({ billToType: "company", billToName: "Presentail Client LLC" });
    expect(res.status).toBe(200);
    const data = mockBuildOrderInvoicePdf.mock.calls[0][0] as { billToName: string };
    expect(data.billToName).toBe("Presentail Client LLC");
  });
});

describe("GET /api/orders/:id/invoice — Whish VAT (11%) and MOF number", () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    mockBuildOrderInvoicePdf.mockResolvedValue(Buffer.from("%PDF-fake"));
    app = makeApp();
  });

  async function downloadInvoice(): Promise<request.Response> {
    return request(app).get(`/api/orders/${ORDER_ID}/invoice`);
  }

  type InvoiceCall = {
    senderLines: string[];
    subtotal: number;
    total: number;
    amountDue: number;
    vatRate?: number;
    vatAmount?: number;
  };

  it("Whish payment: passes the 11% included VAT, SAL sender with MOF, total unchanged", async () => {
    stubQueries({ method: "Whish", provider: null });
    const res = await downloadInvoice();
    expect(res.status).toBe(200);
    const data = mockBuildOrderInvoicePdf.mock.calls[0][0] as InvoiceCall;
    // Total 45 → included VAT = 45 - 45/1.11 = 4.46 (rounded to 2 decimals).
    expect(data.vatRate).toBe(11);
    expect(data.vatAmount).toBe(4.46);
    expect(data.total).toBe(45);
    expect(data.amountDue).toBe(45);
    expect(data.senderLines).toEqual(SAL_SENDER_LINES);
    expect(data.senderLines).toContain("MOF: 3616289-601");
  });

  it("Whish detected via the provider column (case-insensitive)", async () => {
    stubQueries({ method: "wallet", provider: "WHISH" });
    const res = await downloadInvoice();
    expect(res.status).toBe(200);
    const data = mockBuildOrderInvoicePdf.mock.calls[0][0] as InvoiceCall;
    expect(data.vatRate).toBe(11);
    expect(data.vatAmount).toBe(4.46);
  });

  it("Stripe payment: LTD sender, no VAT fields, no MOF line", async () => {
    stubQueries({ method: "stripe", provider: null });
    const res = await downloadInvoice();
    expect(res.status).toBe(200);
    const data = mockBuildOrderInvoicePdf.mock.calls[0][0] as InvoiceCall;
    expect(data.senderLines).toEqual(LTD_SENDER_LINES);
    expect(data.vatRate).toBeUndefined();
    expect(data.vatAmount).toBeUndefined();
    expect(data.senderLines.join(" ")).not.toContain("MOF");
  });

  it("cash payment: SAL sender with MOF, no VAT fields", async () => {
    stubQueries({ method: "cash", provider: null });
    const res = await downloadInvoice();
    expect(res.status).toBe(200);
    const data = mockBuildOrderInvoicePdf.mock.calls[0][0] as InvoiceCall;
    expect(data.senderLines).toEqual(SAL_SENDER_LINES);
    expect(data.senderLines).toContain("MOF: 3616289-601");
    expect(data.vatRate).toBeUndefined();
    expect(data.vatAmount).toBeUndefined();
  });

  it("no payment recorded: SAL sender with MOF, no VAT fields", async () => {
    stubQueries(null);
    const res = await downloadInvoice();
    expect(res.status).toBe(200);
    const data = mockBuildOrderInvoicePdf.mock.calls[0][0] as InvoiceCall;
    expect(data.senderLines).toEqual(SAL_SENDER_LINES);
    expect(data.senderLines).toContain("MOF: 3616289-601");
    expect(data.vatRate).toBeUndefined();
    expect(data.vatAmount).toBeUndefined();
  });
});
