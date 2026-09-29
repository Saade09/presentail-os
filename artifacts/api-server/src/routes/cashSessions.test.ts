import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

const mockDbQuery = vi.fn();

vi.mock("../lib/orderWhatsappNotify", () => ({
  notifyOrderStatusWhatsApp: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
    connect: () =>
      Promise.resolve({
        query: (...args: unknown[]) => mockDbQuery(...args),
        release: vi.fn(),
      }),
  },
  withTransaction: async (_client: unknown, fn: () => Promise<unknown>) => fn(),
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  authed: () => ({ userId: "user_abc" }),
}));

let stubWorkspaceOwnerId = "owner_123";
let stubWorkspaceRole: "owner" | "member" = "owner";
let stubAllowedPages: string[] = [];

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = stubWorkspaceOwnerId;
    wreq.workspaceRole = stubWorkspaceRole;
    wreq.workspaceActualRole = stubWorkspaceRole;
    (wreq as unknown as { allowedPages: string[] }).allowedPages = stubAllowedPages;
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
  logPageAccessDenial: vi.fn(),
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const mockRecordCashTransaction = vi.fn();
const mockComputeSessionCurrencySummary = vi.fn();

vi.mock("../lib/cashDesk", () => ({
  generateSessionNumber: vi.fn(),
  recomputeSessionTotals: vi.fn(),
  logSessionActivity: vi.fn(),
  recordCashTransaction: (...args: unknown[]) => mockRecordCashTransaction(...args),
  sessionCurrencies: (...currencies: (string | null | undefined)[]) => {
    const out: string[] = [];
    for (const c of currencies) {
      const cur = (c ?? "").trim().toUpperCase();
      if (cur && !out.includes(cur)) out.push(cur);
    }
    return out;
  },
  computeSessionCurrencySummary: (...args: unknown[]) =>
    mockComputeSessionCurrencySummary(...args),
  validateClosingCounts: (...args: unknown[]) => mockValidateClosingCounts(...args),
  buildReconciliationCounts: vi.fn().mockReturnValue({ ok: true, counts: [] }),
  reconciliationCloseBlockers: vi.fn().mockReturnValue([]),
  isReconciliationStale: vi.fn().mockReturnValue(false),
  receiptRequiredThreshold: (currency: string) => (currency === "LBP" ? 5000000 : 50),
  varianceApprovalThreshold: (currency: string) => (currency === "LBP" ? 1000000 : 10),
  SALE_CHANNELS: [
    "walk_in", "whatsapp", "website", "phone_order", "toters", "deliveroo", "careem", "talabat", "other",
  ],
  EXPENSE_CATEGORIES: [
    "supplies", "flowers", "packaging", "delivery", "fuel", "utilities", "maintenance", "food_beverage",
    "salaries_wages", "other",
  ],
  PAYROLL_PAYMENT_TYPES: ["salary", "salary_advance", "bonus", "other_payroll"],
  isPayrollCategory: (cat: string) => cat === "salaries_wages",
}));

const mockValidateClosingCounts = vi.fn();

const mockSave = vi.fn();
const mockGetPrivateObjectDir = vi.fn(() => "test-bucket/private");
vi.mock("../lib/objectStorage", () => ({
  objectStorageClient: {
    bucket: () => ({
      file: () => ({ save: (...args: unknown[]) => mockSave(...args) }),
    }),
  },
  objectStorageService: {
    getPrivateObjectDir: () => mockGetPrivateObjectDir(),
  },
}));

vi.mock("@clerk/express", () => ({
  clerkClient: { users: { getUserList: vi.fn().mockResolvedValue({ data: [] }) } },
}));

vi.mock("../lib/exchangeRateService", () => ({
  getStoredRate: vi.fn().mockResolvedValue(null),
}));

vi.mock("../lib/eventsSse", () => ({
  broadcastEvent: vi.fn(),
}));

vi.mock("../lib/orderAlerts", () => ({
  notifyCashSessionFlaggedAlerts: vi.fn(),
}));

const mockNotifySalaryApprovalRequested = vi.fn().mockResolvedValue(undefined);
const mockNotifySalaryDecisionToRequester = vi.fn().mockResolvedValue(undefined);
vi.mock("../lib/slack", () => ({
  notifySalaryApprovalRequested: (...args: unknown[]) => mockNotifySalaryApprovalRequested(...args),
  notifySalaryDecisionToRequester: (...args: unknown[]) => mockNotifySalaryDecisionToRequester(...args),
}));

import cashSessionsRouter from "./cashSessions";

// ---------------------------------------------------------------------------
// Test app
// ---------------------------------------------------------------------------

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: { error: () => void; warn: () => void; info: () => void } }).log = {
      error: () => {},
      warn: () => {},
      info: () => {},
    };
    next();
  });
  app.use(cashSessionsRouter);
  return app;
}

function makeSessionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    workspace_owner_id: "owner_123",
    status: "open",
    currency: "USD",
    drawer_id: 5,
    location_id: 7,
    opening_cash: "100.00",
    expected_cash: "100.00",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  mockRecordCashTransaction.mockResolvedValue({ transactionId: 99 });
  mockComputeSessionCurrencySummary.mockReturnValue([]);
  mockValidateClosingCounts.mockReturnValue({
    ok: true,
    counts: [{ currency: "USD", expected: 100, actual: 100, variance: 0, explanation: null }],
    requiresApproval: false,
  });
  mockSave.mockResolvedValue(undefined);
  stubWorkspaceOwnerId = "owner_123";
  stubWorkspaceRole = "owner";
  stubAllowedPages = [];
  process.env.PRIVATE_OBJECT_DIR = "test-bucket/private";
});

// ---------------------------------------------------------------------------
// GET /cash-sessions — paginated session list
// ---------------------------------------------------------------------------

describe("GET /cash-sessions paginated list", () => {
  it("returns paginated sessions with total_count", async () => {
    // The GET handler runs two parallel queries: COUNT + session list.
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ total: "2" }], rowCount: 1 }) // COUNT
      .mockResolvedValueOnce({
        rows: [
          makeSessionRow({ id: 1, currency: "USD" }),
          makeSessionRow({ id: 2, currency: "LBP" }),
        ],
        rowCount: 2,
      }); // session list

    const res = await request(makeApp()).get("/cash-sessions");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.sessions)).toBe(true);
    expect(res.body.sessions).toHaveLength(2);
    expect(res.body.total_count).toBe(2);
    expect(res.body.page).toBe(1);
    expect(res.body.page_size).toBe(20);
  });

  it("returns an empty sessions array when there are no sessions", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ total: "0" }], rowCount: 1 }) // COUNT
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // session list

    const res = await request(makeApp()).get("/cash-sessions");

    expect(res.status).toBe(200);
    expect(res.body.sessions).toEqual([]);
    expect(res.body.total_count).toBe(0);
  });

  it("returns the entitled workspace's sessions for a member with Cash Sessions page access", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = ["orders", "cash-sessions"];
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ total: "1" }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [makeSessionRow({ id: 8, session_number: "CS-0008" })],
        rowCount: 1,
      });

    const res = await request(makeApp()).get("/cash-sessions");

    expect(res.status).toBe(200);
    expect(res.body.sessions).toEqual([
      expect.objectContaining({ id: 8, session_number: "CS-0008" }),
    ]);
    expect(mockDbQuery.mock.calls[0][1]).toEqual(["owner_123"]);
    expect(mockDbQuery.mock.calls[1][1]).toEqual(["owner_123"]);
  });

  it.each([
    "cmc_pos.cash_drawer",
    "cash_sessions.open",
    "cash_sessions.close",
  ])(
    "lets a cash-session operator with %s view sessions without the page key",
    async (operatorPermission) => {
      stubWorkspaceRole = "member";
      stubAllowedPages = ["cmc-pos-dashboard", operatorPermission];
      mockDbQuery
        .mockResolvedValueOnce({ rows: [{ total: "1" }], rowCount: 1 })
        .mockResolvedValueOnce({
          rows: [makeSessionRow({ id: 9, session_number: "CS-0009" })],
          rowCount: 1,
        });

      const res = await request(makeApp()).get("/cash-sessions");

      expect(res.status).toBe(200);
      expect(res.body.sessions).toEqual([
        expect.objectContaining({ id: 9, session_number: "CS-0009" }),
      ]);
    },
  );

  it("denies a member without Cash Sessions page access before querying data", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = ["orders"];

    const res = await request(makeApp()).get("/cash-sessions");

    expect(res.status).toBe(403);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("runs a COUNT query and a session-list query (with JOIN) in parallel", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ total: "1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [makeSessionRow({ id: 1, currency: "USD" })], rowCount: 1 });

    await request(makeApp()).get("/cash-sessions");

    expect(mockDbQuery).toHaveBeenCalledTimes(2);
    const countSql = mockDbQuery.mock.calls[0][0] as string;
    const listSql = mockDbQuery.mock.calls[1][0] as string;
    expect(countSql).toMatch(/SELECT COUNT\(\*\) AS total/);
    expect(listSql).toMatch(/ORDER BY/);
    expect(listSql).toMatch(/LIMIT/);
  });
});

// ---------------------------------------------------------------------------
// POST /cash-sessions/:id/bill
// ---------------------------------------------------------------------------

describe("POST /cash-sessions/:id/bill", () => {
  it("records a bill without an attachment", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [makeSessionRow()] }) // loadSession
      .mockResolvedValueOnce({ rows: [makeSessionRow()] }); // refreshed loadSession

    const res = await request(makeApp())
      .post("/cash-sessions/1/bill")
      .send({ amount: 25.5, description: "Office supplies" });

    expect(res.status).toBe(201);
    expect(res.body.transaction_id).toBe(99);
    expect(res.body.session).toBeTruthy();
    expect(mockRecordCashTransaction).toHaveBeenCalledTimes(1);
    expect(mockRecordCashTransaction.mock.calls[0][0]).toMatchObject({
      type: "bill",
      direction: "out",
      amount: 25.5,
      description: "Office supplies",
      attachmentUrl: null,
    });
  });

  it("records a bill with a valid attachment URL", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [makeSessionRow()] })
      .mockResolvedValueOnce({ rows: [makeSessionRow()] });

    const res = await request(makeApp())
      .post("/cash-sessions/1/bill")
      .send({
        amount: 10,
        description: "Invoice 42",
        attachment_url: "/objects/owner_123/cash-bills/abc",
      });

    expect(res.status).toBe(201);
    expect(mockRecordCashTransaction.mock.calls[0][0]).toMatchObject({
      attachmentUrl: "/objects/owner_123/cash-bills/abc",
    });
  });

  it("rejects an attachment URL outside the workspace prefix", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [makeSessionRow()] });

    const res = await request(makeApp())
      .post("/cash-sessions/1/bill")
      .send({ amount: 10, description: "x", attachment_url: "/objects/other_ws/cash-bills/abc" });

    expect(res.status).toBe(400);
    expect(mockRecordCashTransaction).not.toHaveBeenCalled();
  });

  it("rejects a non-positive amount", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [makeSessionRow()] });

    const res = await request(makeApp())
      .post("/cash-sessions/1/bill")
      .send({ amount: 0, description: "x" });

    expect(res.status).toBe(400);
    expect(mockRecordCashTransaction).not.toHaveBeenCalled();
  });

  it("rejects a missing description", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [makeSessionRow()] });

    const res = await request(makeApp())
      .post("/cash-sessions/1/bill")
      .send({ amount: 10, description: "   " });

    expect(res.status).toBe(400);
    expect(mockRecordCashTransaction).not.toHaveBeenCalled();
  });

  it("returns 404 when the session does not exist", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(makeApp())
      .post("/cash-sessions/1/bill")
      .send({ amount: 10, description: "x" });

    expect(res.status).toBe(404);
  });

  it("returns 409 when the session is not open", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [makeSessionRow({ status: "closed" })] });

    const res = await request(makeApp())
      .post("/cash-sessions/1/bill")
      .send({ amount: 10, description: "x" });

    expect(res.status).toBe(409);
    expect(mockRecordCashTransaction).not.toHaveBeenCalled();
  });

  it("returns 403 for a member without the adjust permission", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = [];

    const res = await request(makeApp())
      .post("/cash-sessions/1/bill")
      .send({ amount: 10, description: "x" });

    expect(res.status).toBe(403);
    expect(mockRecordCashTransaction).not.toHaveBeenCalled();
  });

  it("allows a member who has the cash_sessions.adjust permission", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = ["cash_sessions.adjust"];
    mockDbQuery
      .mockResolvedValueOnce({ rows: [makeSessionRow()] })
      .mockResolvedValueOnce({ rows: [makeSessionRow()] });

    const res = await request(makeApp())
      .post("/cash-sessions/1/bill")
      .send({ amount: 10, description: "x" });

    expect(res.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// POST /cash-sessions/:id/bill/invoice
// ---------------------------------------------------------------------------

describe("POST /cash-sessions/:id/bill/invoice", () => {
  it("uploads an invoice and returns the object path", async () => {
    const res = await request(makeApp())
      .post("/cash-sessions/1/bill/invoice")
      .attach("invoice", Buffer.from("fake-pdf"), { filename: "inv.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/^\/objects\/owner_123\/cash-bills\//);
    expect(mockSave).toHaveBeenCalledTimes(1);
  });

  it("rejects an unsupported file type", async () => {
    const res = await request(makeApp())
      .post("/cash-sessions/1/bill/invoice")
      .attach("invoice", Buffer.from("text"), { filename: "x.txt", contentType: "text/plain" });

    expect(res.status).toBe(400);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("returns 400 when no file is provided", async () => {
    const res = await request(makeApp()).post("/cash-sessions/1/bill/invoice");

    expect(res.status).toBe(400);
  });

  it("returns 403 for a member without the adjust permission", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = [];

    const res = await request(makeApp())
      .post("/cash-sessions/1/bill/invoice")
      .attach("invoice", Buffer.from("fake"), { filename: "inv.pdf", contentType: "application/pdf" });

    expect(res.status).toBe(403);
    expect(mockSave).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// PATCH /cash-sessions/:id/bill/:txId
// ---------------------------------------------------------------------------

function makeBillRow(overrides: Record<string, unknown> = {}) {
  return { id: 10, type: "bill", attachment_url: null, ...overrides };
}

describe("PATCH /cash-sessions/:id/bill/:txId", () => {
  it("edits a bill's amount and description and recomputes totals", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [makeSessionRow()] }) // loadSession
      .mockResolvedValueOnce({ rows: [makeBillRow()], rowCount: 1 }) // loadBill
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE
      .mockResolvedValueOnce({ rows: [makeSessionRow()] }); // refreshed loadSession

    const res = await request(makeApp())
      .patch("/cash-sessions/1/bill/10")
      .send({ amount: 42.75, description: "Corrected amount" });

    expect(res.status).toBe(200);
    expect(res.body.transaction_id).toBe(10);
    expect(res.body.session).toBeTruthy();
    const updateCall = mockDbQuery.mock.calls[2];
    expect(updateCall[0]).toMatch(/UPDATE cash_transactions/);
    expect(updateCall[1]).toEqual(["42.75", "Corrected amount", null, false, 10, 1, "owner_123"]);
  });

  it("keeps the existing attachment when attachment_url is omitted", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [makeSessionRow()] })
      .mockResolvedValueOnce({ rows: [makeBillRow({ attachment_url: "/objects/owner_123/cash-bills/keep" })], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [makeSessionRow()] });

    const res = await request(makeApp())
      .patch("/cash-sessions/1/bill/10")
      .send({ amount: 5, description: "x" });

    expect(res.status).toBe(200);
    const updateCall = mockDbQuery.mock.calls[2];
    expect(updateCall[1][2]).toBe("/objects/owner_123/cash-bills/keep");
    expect(updateCall[1][3]).toBe(true);
  });

  it("clears the attachment when attachment_url is empty", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [makeSessionRow()] })
      .mockResolvedValueOnce({ rows: [makeBillRow({ attachment_url: "/objects/owner_123/cash-bills/old" })], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [makeSessionRow()] });

    const res = await request(makeApp())
      .patch("/cash-sessions/1/bill/10")
      .send({ amount: 5, description: "x", attachment_url: "" });

    expect(res.status).toBe(200);
    const updateCall = mockDbQuery.mock.calls[2];
    expect(updateCall[1][2]).toBeNull();
    expect(updateCall[1][3]).toBe(false);
  });

  it("rejects an attachment URL outside the workspace prefix", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [makeSessionRow()] })
      .mockResolvedValueOnce({ rows: [makeBillRow()], rowCount: 1 });

    const res = await request(makeApp())
      .patch("/cash-sessions/1/bill/10")
      .send({ amount: 5, description: "x", attachment_url: "/objects/other_ws/cash-bills/abc" });

    expect(res.status).toBe(400);
  });

  it("rejects a non-positive amount", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [makeSessionRow()] })
      .mockResolvedValueOnce({ rows: [makeBillRow()], rowCount: 1 });

    const res = await request(makeApp())
      .patch("/cash-sessions/1/bill/10")
      .send({ amount: 0, description: "x" });

    expect(res.status).toBe(400);
  });

  it("rejects a missing description", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [makeSessionRow()] })
      .mockResolvedValueOnce({ rows: [makeBillRow()], rowCount: 1 });

    const res = await request(makeApp())
      .patch("/cash-sessions/1/bill/10")
      .send({ amount: 5, description: "  " });

    expect(res.status).toBe(400);
  });

  it("returns 404 when the bill does not exist", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [makeSessionRow()] })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(makeApp())
      .patch("/cash-sessions/1/bill/10")
      .send({ amount: 5, description: "x" });

    expect(res.status).toBe(404);
  });

  it("returns 400 when the transaction is not a bill", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [makeSessionRow()] })
      .mockResolvedValueOnce({ rows: [makeBillRow({ type: "adjustment" })], rowCount: 1 });

    const res = await request(makeApp())
      .patch("/cash-sessions/1/bill/10")
      .send({ amount: 5, description: "x" });

    expect(res.status).toBe(400);
  });

  it("returns 404 when the session does not exist", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(makeApp())
      .patch("/cash-sessions/1/bill/10")
      .send({ amount: 5, description: "x" });

    expect(res.status).toBe(404);
  });

  it("returns 409 when the session is not open", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [makeSessionRow({ status: "closed" })] });

    const res = await request(makeApp())
      .patch("/cash-sessions/1/bill/10")
      .send({ amount: 5, description: "x" });

    expect(res.status).toBe(409);
  });

  it("returns 403 for a member without the adjust permission", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = [];

    const res = await request(makeApp())
      .patch("/cash-sessions/1/bill/10")
      .send({ amount: 5, description: "x" });

    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// DELETE /cash-sessions/:id/bill/:txId
// ---------------------------------------------------------------------------

describe("DELETE /cash-sessions/:id/bill/:txId", () => {
  it("always returns 405 — transactions cannot be deleted", async () => {
    const res = await request(makeApp()).delete("/cash-sessions/1/bill/10");

    expect(res.status).toBe(405);
    expect(res.body.error).toMatch(/reversal/i);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /cash-sessions/:id/sale
// ---------------------------------------------------------------------------

describe("POST /cash-sessions/:id/sale", () => {
  function primeDrawerCurrencies(currency = "USD", secondary: string | null = null) {
    return { rows: [{ currency, secondary_currency: secondary }], rowCount: 1 };
  }

  it("records a sale with a channel and updates sale_channel", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [makeSessionRow()] }) // loadSession
      .mockResolvedValueOnce(primeDrawerCurrencies()) // allowedCurrenciesFor
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE sale_channel
      .mockResolvedValueOnce({ rows: [makeSessionRow()] }); // refreshed loadSession

    const res = await request(makeApp())
      .post("/cash-sessions/1/sale")
      .send({ amount: 25, currency: "USD", sale_channel: "walk_in", reference: "ORD-1" });

    expect(res.status).toBe(201);
    expect(res.body.transaction_id).toBe(99);
    expect(mockRecordCashTransaction).toHaveBeenCalledTimes(1);
    expect(mockRecordCashTransaction.mock.calls[0][0]).toMatchObject({
      type: "sale",
      direction: "in",
      amount: 25,
      currency: "USD",
    });
    const updateCall = mockDbQuery.mock.calls[2];
    expect(updateCall[0]).toMatch(/UPDATE cash_transactions/);
    expect(updateCall[0]).toMatch(/sale_channel/);
  });

  it("rejects an unknown sale channel", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [makeSessionRow()] })
      .mockResolvedValueOnce(primeDrawerCurrencies());

    const res = await request(makeApp())
      .post("/cash-sessions/1/sale")
      .send({ amount: 25, currency: "USD", sale_channel: "carrier_pigeon" });

    expect(res.status).toBe(400);
    expect(mockRecordCashTransaction).not.toHaveBeenCalled();
  });

  it("rejects a currency outside the session's currencies", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [makeSessionRow({ currency: "USD" })] })
      .mockResolvedValueOnce(primeDrawerCurrencies("USD", "LBP"));

    const res = await request(makeApp())
      .post("/cash-sessions/1/sale")
      .send({ amount: 25, currency: "EUR", sale_channel: "walk_in" });

    expect(res.status).toBe(400);
    expect(mockRecordCashTransaction).not.toHaveBeenCalled();
  });

  it("returns 403 for a member without the cash_transactions.create permission", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = [];

    const res = await request(makeApp())
      .post("/cash-sessions/1/sale")
      .send({ amount: 25, currency: "USD", sale_channel: "walk_in" });

    expect(res.status).toBe(403);
  });

  it("returns 409 when the session is not open", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [makeSessionRow({ status: "approved" })] });

    const res = await request(makeApp())
      .post("/cash-sessions/1/sale")
      .send({ amount: 25, currency: "USD", sale_channel: "walk_in" });

    expect(res.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// POST /cash-sessions/:id/expense
// ---------------------------------------------------------------------------

describe("POST /cash-sessions/:id/expense", () => {
  const validExpense = {
    amount: 20,
    currency: "USD",
    expense_category: "supplies",
    payee: "Ribbon supplier",
    description: "Gift ribbons",
    paid_from_drawer: true,
  };

  it("records an expense below the receipt threshold without a receipt", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [makeSessionRow()] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE category/payee
      .mockResolvedValueOnce({ rows: [makeSessionRow()] });

    const res = await request(makeApp()).post("/cash-sessions/1/expense").send(validExpense);

    expect(res.status).toBe(201);
    expect(mockRecordCashTransaction.mock.calls[0][0]).toMatchObject({
      type: "expense",
      direction: "out",
      amount: 20,
    });
  });

  it("records an expense at or above the threshold without a receipt (receipts are optional)", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [makeSessionRow()] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [makeSessionRow()] });

    const res = await request(makeApp())
      .post("/cash-sessions/1/expense")
      .send({ ...validExpense, amount: 50 }); // USD threshold = 50 in the mock

    expect(res.status).toBe(201);
    expect(mockRecordCashTransaction).toHaveBeenCalledTimes(1);
  });

  it("accepts an above-threshold expense with a receipt attachment", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [makeSessionRow()] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [makeSessionRow()] });

    const res = await request(makeApp())
      .post("/cash-sessions/1/expense")
      .send({ ...validExpense, amount: 80, attachment_url: "/objects/owner_123/cash-bills/r1" });

    expect(res.status).toBe(201);
  });

  it("rejects when paid_from_drawer is not confirmed", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [makeSessionRow()] });

    const res = await request(makeApp())
      .post("/cash-sessions/1/expense")
      .send({ ...validExpense, paid_from_drawer: false });

    expect(res.status).toBe(400);
    expect(mockRecordCashTransaction).not.toHaveBeenCalled();
  });

  it("rejects a missing payee or category", async () => {
    mockDbQuery.mockResolvedValue({ rows: [makeSessionRow()] });

    const noPayee = await request(makeApp())
      .post("/cash-sessions/1/expense")
      .send({ ...validExpense, payee: "  " });
    const badCategory = await request(makeApp())
      .post("/cash-sessions/1/expense")
      .send({ ...validExpense, expense_category: "misc_junk" });

    expect(noPayee.status).toBe(400);
    expect(badCategory.status).toBe(400);
    expect(mockRecordCashTransaction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /cash-sessions/:id/expense — salaries_wages payroll flow
// ---------------------------------------------------------------------------

describe("POST /cash-sessions/:id/expense — payroll (salaries_wages)", () => {
  // Reset db mock before each payroll test to avoid once-queue / fallback leakage
  // from earlier describe blocks that call mockResolvedValue (non-Once).
  // Provide a safe fallback so exhausted calls return { rows: [] } instead of
  // undefined (which throws TypeError inside the employee-lookup try-catch).
  beforeEach(() => {
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 }); // safe default for exhausted calls
    mockRecordCashTransaction.mockResolvedValue({ transactionId: 1, linked: true, cashSessionId: 1, warning: undefined });
  });

  // db query order for a full payroll expense (owner, no duplicate, no multi-currency):
  //   #1 loadSession
  //   #2 allowedCurrenciesFor (cash_drawers lookup)
  //   #3 employee lookup (team_members)
  //   #4 duplicate check (cash_transactions)
  //   #5 UPDATE category/payee
  //   #6 UPDATE payroll columns
  //   #7 logSessionActivity → MOCKED (no db call)
  //   #8 loadSession refreshed → exhausted mock → null (still returns 201)

  const validPayroll = {
    amount: 1500,
    currency: "USD",
    expense_category: "salaries_wages",
    payroll_employee_id: "tm_42",
    payroll_period: "2026-08",
    payroll_payment_type: "salary",
    paid_from_drawer: true,
  };

  function makeDrawerRow() {
    return { currency: "USD", secondary_currency: null };
  }

  function makeEmployeeRow() {
    return { id: 42, first_name: "Ahmad", last_name: "Saade" };
  }

  it("records a valid payroll expense and builds the description automatically", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [makeSessionRow()] })                  // #1 loadSession
      .mockResolvedValueOnce({ rows: [makeDrawerRow()] })                   // #2 allowedCurrenciesFor
      .mockResolvedValueOnce({ rows: [makeEmployeeRow()], rowCount: 1 })    // #3 employee lookup
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                     // #4 duplicate check (none)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                     // #5 UPDATE category/payee
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });                    // #6 UPDATE payroll columns
    // #7 logSessionActivity → MOCKED; #8 loadSession refreshed → exhausted → null

    const res = await request(makeApp()).post("/cash-sessions/1/expense").send(validPayroll);

    expect(res.status).toBe(201);
    const callArgs = mockRecordCashTransaction.mock.calls[0][0];
    expect(callArgs.type).toBe("expense");
    expect(callArgs.description).toMatch(/Ahmad Saade/);
    expect(callArgs.description).toMatch(/August 2026/);
    expect(callArgs.description).toMatch(/Salary/);
  });

  it("returns 403 when role is not owner/admin and lacks payroll_expenses permission", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = ["cash-sessions"]; // no payroll_expenses
    try {
      mockDbQuery
        .mockResolvedValueOnce({ rows: [makeSessionRow()] })                // #1 loadSession
        .mockResolvedValueOnce({ rows: [makeDrawerRow()] });                // #2 allowedCurrenciesFor

      const res = await request(makeApp()).post("/cash-sessions/1/expense").send(validPayroll);
      expect(res.status).toBe(403);
      expect(mockRecordCashTransaction).not.toHaveBeenCalled();
    } finally {
      stubWorkspaceRole = "owner";
      stubAllowedPages = [];
    }
  });

  it("allows a member who has the payroll_expenses permission to record a payroll expense", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = ["cash-sessions", "cash_transactions.create", "payroll_expenses"];
    try {
      mockDbQuery
        .mockResolvedValueOnce({ rows: [makeSessionRow()] })                  // #1 loadSession
        .mockResolvedValueOnce({ rows: [makeDrawerRow()] })                   // #2 allowedCurrenciesFor
        .mockResolvedValueOnce({ rows: [makeEmployeeRow()], rowCount: 1 })    // #3 employee lookup
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })                     // #4 duplicate check (none)
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })                     // #5 UPDATE category/payee
        .mockResolvedValueOnce({ rows: [], rowCount: 1 });                    // #6 UPDATE payroll columns

      const res = await request(makeApp()).post("/cash-sessions/1/expense").send(validPayroll);
      expect(res.status).toBe(201);
      expect(mockRecordCashTransaction).toHaveBeenCalledTimes(1);
    } finally {
      stubWorkspaceRole = "owner";
      stubAllowedPages = [];
    }
  });

  it("returns 400 when a required payroll field is missing", async () => {
    // Each sub-request: loadSession + allowedCurrenciesFor (2 db calls before field validation fails)
    for (let i = 0; i < 3; i++) {
      mockDbQuery
        .mockResolvedValueOnce({ rows: [makeSessionRow()] })
        .mockResolvedValueOnce({ rows: [makeDrawerRow()] });
    }

    const noEmployee = await request(makeApp())
      .post("/cash-sessions/1/expense")
      .send({ ...validPayroll, payroll_employee_id: "" });
    expect(noEmployee.status).toBe(400);
    expect(noEmployee.body.fields?.payroll_employee_id).toBeTruthy();

    const badPeriod = await request(makeApp())
      .post("/cash-sessions/1/expense")
      .send({ ...validPayroll, payroll_period: "08-2026" }); // wrong format
    expect(badPeriod.status).toBe(400);

    const noType = await request(makeApp())
      .post("/cash-sessions/1/expense")
      .send({ ...validPayroll, payroll_payment_type: "unknown_type" });
    expect(noType.status).toBe(400);

    expect(mockRecordCashTransaction).not.toHaveBeenCalled();
  });

  it("returns 400 when the employee does not exist or is archived", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [makeSessionRow()] })                  // #1 loadSession
      .mockResolvedValueOnce({ rows: [makeDrawerRow()] })                   // #2 allowedCurrenciesFor
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });                    // #3 employee lookup (not found)

    const res = await request(makeApp()).post("/cash-sessions/1/expense").send(validPayroll);

    expect(res.status).toBe(400);
    expect(res.body.fields?.payroll_employee_id).toBeTruthy();
    expect(mockRecordCashTransaction).not.toHaveBeenCalled();
  });

  it("returns 409 when a duplicate payroll expense exists and confirm_duplicate is absent", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [makeSessionRow()] })                  // #1 loadSession
      .mockResolvedValueOnce({ rows: [makeDrawerRow()] })                   // #2 allowedCurrenciesFor
      .mockResolvedValueOnce({ rows: [makeEmployeeRow()], rowCount: 1 })    // #3 employee lookup (found)
      .mockResolvedValueOnce({ rows: [{ id: 99 }], rowCount: 1 });         // #4 duplicate found

    const res = await request(makeApp()).post("/cash-sessions/1/expense").send(validPayroll);

    expect(res.status).toBe(409);
    expect(res.body.duplicate).toBeDefined();
    expect(res.body.duplicate.employee_name).toBe("Ahmad Saade");
    expect(mockRecordCashTransaction).not.toHaveBeenCalled();
  });

  it("records the expense when confirm_duplicate: true bypasses the duplicate check", async () => {
    // With confirm_duplicate: true, the duplicate check is skipped (no query #4)
    mockDbQuery
      .mockResolvedValueOnce({ rows: [makeSessionRow()] })                  // #1 loadSession
      .mockResolvedValueOnce({ rows: [makeDrawerRow()] })                   // #2 allowedCurrenciesFor
      .mockResolvedValueOnce({ rows: [makeEmployeeRow()], rowCount: 1 })    // #3 employee lookup
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                     // #4 UPDATE category/payee
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });                    // #5 UPDATE payroll columns

    const res = await request(makeApp())
      .post("/cash-sessions/1/expense")
      .send({ ...validPayroll, confirm_duplicate: true });

    expect(res.status).toBe(201);
    expect(mockRecordCashTransaction).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// POST /cash-sessions/:id/sale — multi-currency payment line currency validation
// ---------------------------------------------------------------------------

describe("POST /cash-sessions/:id/sale — payment-line currency validation", () => {
  function primeDrawerCurrencies(currency = "USD", secondary: string | null = null) {
    return { rows: [{ currency, secondary_currency: secondary }], rowCount: 1 };
  }

  it("rejects a payment line whose currency is not in the drawer's allowed set (single-currency drawer)", async () => {
    // A USD-only drawer must not accept AED payment lines: mixing currencies
    // produces an incommensurate sum in recomputeSessionTotals.
    mockDbQuery
      .mockResolvedValueOnce({ rows: [makeSessionRow({ currency: "USD" })] })
      .mockResolvedValueOnce(primeDrawerCurrencies("USD", null)); // single-currency

    const res = await request(makeApp())
      .post("/cash-sessions/1/sale")
      .send({
        amount: 100,
        currency: "USD",
        sale_channel: "walk_in",
        payments: [{ amount: 100, currency: "AED" }], // foreign currency
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/AED/);
    expect(res.body.error).toMatch(/not accepted by this drawer/);
    // No ledger entry should have been written
    expect(mockRecordCashTransaction).not.toHaveBeenCalled();
  });

  it("accepts payment lines that match the drawer's allowed currencies (dual-currency drawer)", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [makeSessionRow({ currency: "USD" })] })
      .mockResolvedValueOnce(primeDrawerCurrencies("USD", "AED")) // dual-currency
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE
      .mockResolvedValueOnce({ rows: [makeSessionRow()], rowCount: 1 }); // refreshed

    const res = await request(makeApp())
      .post("/cash-sessions/1/sale")
      .send({
        amount: 100,
        currency: "USD",
        sale_channel: "walk_in",
        payments: [
          { amount: 80, currency: "USD" },
          { amount: 20, currency: "AED", exchange_rate: 1 }, // AED is allowed
        ],
      });

    expect(res.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// POST /cash-sessions/:id/expense — payment-line currency validation
// ---------------------------------------------------------------------------

describe("POST /cash-sessions/:id/expense — payment-line currency validation", () => {
  const baseExpense = {
    amount: 20,
    currency: "USD",
    expense_category: "supplies",
    payee: "Vendor",
    description: "Supplies",
    paid_from_drawer: true,
  };

  function primeDrawerCurrencies(currency = "USD", secondary: string | null = null) {
    return { rows: [{ currency, secondary_currency: secondary }], rowCount: 1 };
  }

  it("rejects an expense payment line with a foreign currency on a single-currency drawer", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [makeSessionRow({ currency: "USD" })] })
      .mockResolvedValueOnce(primeDrawerCurrencies("USD", null)); // single-currency

    const res = await request(makeApp())
      .post("/cash-sessions/1/expense")
      .send({
        ...baseExpense,
        payments: [{ amount: 20, currency: "EUR" }], // foreign currency
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/EUR/);
    expect(res.body.error).toMatch(/not accepted by this drawer/);
    expect(mockRecordCashTransaction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /cash-sessions/:id/transactions/:txId/reverse
// ---------------------------------------------------------------------------

describe("POST /cash-sessions/:id/transactions/:txId/reverse", () => {
  function makeTxRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 10,
      type: "sale",
      direction: "in",
      amount: "25.00",
      currency: "USD",
      description: "Walk-in sale",
      is_reversed: false,
      ...overrides,
    };
  }

  it("records an opposite-direction reversal and marks the original", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [makeSessionRow()] }) // loadSession
      .mockResolvedValueOnce({ rows: [makeTxRow()], rowCount: 1 }) // load original
      .mockResolvedValueOnce({ rows: [{ id: 77 }], rowCount: 1 }) // INSERT reversal
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE is_reversed
      .mockResolvedValueOnce({ rows: [makeSessionRow()] }); // refreshed loadSession

    const res = await request(makeApp())
      .post("/cash-sessions/1/transactions/10/reverse")
      .send({ reason: "Entered twice" });

    expect(res.status).toBe(201);
    expect(res.body.reversal_id).toBe(77);
    const insertCall = mockDbQuery.mock.calls[2];
    expect(insertCall[0]).toMatch(/INSERT INTO cash_transactions/);
    expect(insertCall[0]).toMatch(/'reversal'/);
    const markCall = mockDbQuery.mock.calls[3];
    expect(markCall[0]).toMatch(/SET is_reversed = true/);
  });

  it("rejects a missing reason", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [makeSessionRow()] }); // loadSession

    const res = await request(makeApp())
      .post("/cash-sessions/1/transactions/10/reverse")
      .send({ reason: "  " });

    expect(res.status).toBe(400);
  });

  it("rejects reversing a reversal", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [makeSessionRow()] })
      .mockResolvedValueOnce({ rows: [makeTxRow({ type: "reversal" })], rowCount: 1 });

    const res = await request(makeApp())
      .post("/cash-sessions/1/transactions/10/reverse")
      .send({ reason: "oops" });

    expect(res.status).toBe(400);
  });

  it("rejects a double reversal", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [makeSessionRow()] })
      .mockResolvedValueOnce({ rows: [makeTxRow({ is_reversed: true })], rowCount: 1 });

    const res = await request(makeApp())
      .post("/cash-sessions/1/transactions/10/reverse")
      .send({ reason: "again" });

    expect(res.status).toBe(409);
  });

  it("returns 403 for a member without the adjust permission", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = [];

    const res = await request(makeApp())
      .post("/cash-sessions/1/transactions/10/reverse")
      .send({ reason: "x" });

    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// POST /cash-sessions/:id/close — multi-currency counts
// ---------------------------------------------------------------------------

describe("POST /cash-sessions/:id/close with counts", () => {
  it("lets a Cash Sessions page member close a session at any workspace location", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = ["cash-sessions"];
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [makeSessionRow({ location_id: 99 })],
        rowCount: 1,
      }) // workspace-scoped session lookup
      .mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1 }) // pending approvals
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // transactions
      .mockResolvedValueOnce({
        rows: [makeSessionRow({ location_id: 99, status: "pending_review" })],
        rowCount: 1,
      }); // close

    const res = await request(makeApp())
      .post("/cash-sessions/1/close")
      .send({ counts: [{ currency: "USD", actual_cash: 100 }] });

    expect(res.status).toBe(200);
    expect(mockValidateClosingCounts).toHaveBeenCalledTimes(1);
  });

  it("closes with per-currency counts via validateClosingCounts", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [makeSessionRow()] }) // loadSession
      .mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1 }) // pending approvals
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // transactions for summary
      .mockResolvedValueOnce({ rows: [makeSessionRow({ status: "pending_review" })] }); // UPDATE close

    const res = await request(makeApp())
      .post("/cash-sessions/1/close")
      .send({ counts: [{ currency: "USD", actual_cash: 100 }] });

    expect(res.status).toBe(200);
    expect(mockValidateClosingCounts).toHaveBeenCalledTimes(1);
  });

  it("returns 403 requires_approval when over threshold without approve permission", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = ["cash_sessions.close"];
    mockValidateClosingCounts.mockReturnValue({
      ok: true,
      counts: [{ currency: "USD", expected: 100, actual: 50, variance: -50, explanation: "short" }],
      requiresApproval: true,
    });
    mockDbQuery
      .mockResolvedValueOnce({ rows: [makeSessionRow()] })
      .mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(makeApp())
      .post("/cash-sessions/1/close")
      .send({ counts: [{ currency: "USD", actual_cash: 50, explanation: "short" }] });

    expect(res.status).toBe(403);
    expect(res.body.requires_approval).toBe(true);
  });

  it("returns 400 when validateClosingCounts rejects", async () => {
    mockValidateClosingCounts.mockReturnValue({ ok: false, error: "Missing actual count for LBP" });
    mockDbQuery
      .mockResolvedValueOnce({ rows: [makeSessionRow()] })
      .mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(makeApp())
      .post("/cash-sessions/1/close")
      .send({ counts: [{ currency: "USD", actual_cash: 100 }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/LBP/);
  });

  it("accepts a legacy LBP-only close without requiring the drawer's USD currency", async () => {
    const session = makeSessionRow({
      currency: "LBP",
      secondary_currency: null,
      opening_cash: "5000000.00",
      expected_cash: "5000000.00",
    });
    mockComputeSessionCurrencySummary.mockReturnValue([
      {
        currency: "LBP",
        opening_cash: 5_000_000,
        sales_collected: 0,
        expenses_paid: 0,
        adjustments: 0,
        expected_cash: 5_000_000,
      },
    ]);
    mockValidateClosingCounts.mockReturnValue({
      ok: true,
      counts: [
        {
          currency: "LBP",
          expected: 5_000_000,
          actual: 5_000_000,
          variance: 0,
          explanation: null,
        },
      ],
      requiresApproval: false,
    });
    mockDbQuery
      .mockResolvedValueOnce({ rows: [session], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [{ ...session, status: "pending_review" }],
        rowCount: 1,
      });

    const res = await request(makeApp())
      .post("/cash-sessions/1/close")
      .send({ actual_cash: 5_000_000 });

    expect(res.status).toBe(200);
    expect(mockComputeSessionCurrencySummary.mock.calls[0]?.[1]).toEqual(["LBP"]);
    expect(mockValidateClosingCounts).toHaveBeenCalledWith(
      expect.any(Array),
      [expect.objectContaining({ currency: "LBP", actual: 5_000_000 })],
    );
  });

  it("requires per-currency counts for a true dual-currency legacy close", async () => {
    const session = makeSessionRow({
      currency: "USD",
      secondary_currency: "LBP",
      opening_cash_secondary: "5000000.00",
    });
    mockComputeSessionCurrencySummary.mockReturnValue([
      {
        currency: "USD",
        opening_cash: 100,
        sales_collected: 0,
        expenses_paid: 0,
        adjustments: 0,
        expected_cash: 100,
      },
      {
        currency: "LBP",
        opening_cash: 5_000_000,
        sales_collected: 0,
        expenses_paid: 0,
        adjustments: 0,
        expected_cash: 5_000_000,
      },
    ]);
    mockDbQuery
      .mockResolvedValueOnce({ rows: [session], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(makeApp())
      .post("/cash-sessions/1/close")
      .send({ actual_cash: 100 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/multiple currencies/i);
  });
});

// ---------------------------------------------------------------------------
// POST /cash-sessions — dual-currency session-currency resolution
// ---------------------------------------------------------------------------

describe("POST /cash-sessions session currency", () => {
  function makeDrawerRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 5,
      name: "Front Desk",
      code: "FD",
      location_id: 7,
      currency: "AED",
      secondary_currency: null,
      is_active: true,
      location_name: "Main",
      ...overrides,
    };
  }

  // The handler issues queries in this order:
  //   1. drawer SELECT, 2. open-session check, 3. INSERT cash_sessions.
  // The INSERT params place the resolved currency at index 4.
  function primeOpenSession(drawerRow: Record<string, unknown>) {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [drawerRow], rowCount: 1 }) // drawer SELECT
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // open-session check
      .mockResolvedValueOnce({ rows: [makeSessionRow()], rowCount: 1 }); // INSERT
  }

  function insertCurrency(): unknown {
    const insertParams = mockDbQuery.mock.calls[2][1] as unknown[];
    return insertParams[4];
  }

  it("lets a Cash Sessions page member open a session on another workspace location", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = ["cash-sessions"];
    primeOpenSession(makeDrawerRow({ location_id: 99, currency: "USD" }));

    const res = await request(makeApp())
      .post("/cash-sessions")
      .send({ drawer_id: 5, opening_cash: 100 });

    expect(res.status).toBe(201);
    expect(insertCurrency()).toBe("USD");
  });

  it("ignores a body currency on a single-currency drawer and uses the main currency", async () => {
    primeOpenSession(makeDrawerRow({ currency: "AED", secondary_currency: null }));

    const res = await request(makeApp())
      .post("/cash-sessions")
      .send({ drawer_id: 5, opening_cash: 100, currency: "USD" });

    expect(res.status).toBe(201);
    expect(insertCurrency()).toBe("AED");
  });

  it("honors a valid secondary currency on a two-currency drawer", async () => {
    primeOpenSession(makeDrawerRow({ currency: "USD", secondary_currency: "LBP" }));

    const res = await request(makeApp())
      .post("/cash-sessions")
      .send({ drawer_id: 5, opening_cash: 100, currency: "LBP" });

    expect(res.status).toBe(201);
    expect(insertCurrency()).toBe("LBP");
  });

  it("honors the main currency (lowercase) on a two-currency drawer", async () => {
    primeOpenSession(makeDrawerRow({ currency: "USD", secondary_currency: "LBP" }));

    const res = await request(makeApp())
      .post("/cash-sessions")
      .send({ drawer_id: 5, opening_cash: 100, currency: "usd" });

    expect(res.status).toBe(201);
    expect(insertCurrency()).toBe("USD");
  });

  it("rejects a dual-currency open without opening_cash_secondary", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [makeDrawerRow({ currency: "USD", secondary_currency: "LBP" })],
      rowCount: 1,
    }); // drawer SELECT

    const res = await request(makeApp())
      .post("/cash-sessions")
      .send({ drawer_id: 5, opening_cash: 100 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/opening_cash_secondary/);
  });

  it("opens a dual-currency session when both opening amounts are provided", async () => {
    primeOpenSession(makeDrawerRow({ currency: "USD", secondary_currency: "LBP" }));

    const res = await request(makeApp())
      .post("/cash-sessions")
      .send({ drawer_id: 5, opening_cash: 100, opening_cash_secondary: 500000 });

    expect(res.status).toBe(201);
    expect(insertCurrency()).toBe("USD");
  });

  it("rejects a currency that is not one of the drawer's two currencies", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [makeDrawerRow({ currency: "USD", secondary_currency: "LBP" })],
      rowCount: 1,
    }); // drawer SELECT

    const res = await request(makeApp())
      .post("/cash-sessions")
      .send({ drawer_id: 5, opening_cash: 100, currency: "EUR" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/one of the drawer's currencies/);
    // No open-session check or INSERT should have run.
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// POST /cash-sessions/:id/sale — Quick Entry idempotency
// ---------------------------------------------------------------------------

describe("POST /cash-sessions/:id/sale — X-Idempotency-Key deduplication", () => {
  function primeDrawerCurrencies(currency = "USD", secondary: string | null = null) {
    return { rows: [{ currency, secondary_currency: secondary }], rowCount: 1 };
  }

  it("second POST with same X-Idempotency-Key returns 409 without inserting a duplicate", async () => {
    const key = `idem-test-${Math.random().toString(36).slice(2)}`;

    // First call: succeeds and caches the response body.
    mockDbQuery
      .mockResolvedValueOnce({ rows: [makeSessionRow()], rowCount: 1 }) // loadSession
      .mockResolvedValueOnce(primeDrawerCurrencies())                   // allowedCurrenciesFor
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                 // UPDATE sale_channel
      .mockResolvedValueOnce({ rows: [makeSessionRow()], rowCount: 1 }); // refreshed loadSession

    const first = await request(makeApp())
      .post("/cash-sessions/1/sale")
      .set("X-Idempotency-Key", key)
      .send({ amount: 25, currency: "USD", sale_channel: "walk_in" });

    expect(first.status).toBe(201);
    expect(mockRecordCashTransaction).toHaveBeenCalledTimes(1);

    // Second call: same key → 409 replay; only loadSession is queried.
    mockDbQuery.mockResolvedValueOnce({ rows: [makeSessionRow()], rowCount: 1 });

    const second = await request(makeApp())
      .post("/cash-sessions/1/sale")
      .set("X-Idempotency-Key", key)
      .send({ amount: 25, currency: "USD", sale_channel: "walk_in" });

    expect(second.status).toBe(409);
    // recordCashTransaction must NOT have been called a second time.
    expect(mockRecordCashTransaction).toHaveBeenCalledTimes(1);
  });

  it("different idempotency keys result in two independent transactions", async () => {
    const key1 = `idem-a-${Math.random().toString(36).slice(2)}`;
    const key2 = `idem-b-${Math.random().toString(36).slice(2)}`;

    for (let i = 0; i < 2; i++) {
      mockDbQuery
        .mockResolvedValueOnce({ rows: [makeSessionRow()], rowCount: 1 })
        .mockResolvedValueOnce(primeDrawerCurrencies())
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [makeSessionRow()], rowCount: 1 });
    }

    const r1 = await request(makeApp())
      .post("/cash-sessions/1/sale")
      .set("X-Idempotency-Key", key1)
      .send({ amount: 25, currency: "USD", sale_channel: "walk_in" });

    const r2 = await request(makeApp())
      .post("/cash-sessions/1/sale")
      .set("X-Idempotency-Key", key2)
      .send({ amount: 25, currency: "USD", sale_channel: "walk_in" });

    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(mockRecordCashTransaction).toHaveBeenCalledTimes(2);
  });

  it("request without X-Idempotency-Key is never cached — two calls create two transactions", async () => {
    for (let i = 0; i < 2; i++) {
      mockDbQuery
        .mockResolvedValueOnce({ rows: [makeSessionRow()], rowCount: 1 })
        .mockResolvedValueOnce(primeDrawerCurrencies())
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [makeSessionRow()], rowCount: 1 });
    }

    const r1 = await request(makeApp())
      .post("/cash-sessions/1/sale")
      .send({ amount: 25, currency: "USD", sale_channel: "walk_in" });

    const r2 = await request(makeApp())
      .post("/cash-sessions/1/sale")
      .send({ amount: 25, currency: "USD", sale_channel: "walk_in" });

    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(mockRecordCashTransaction).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// GET /cash-sessions/:id — session detail
// ---------------------------------------------------------------------------

function makeDetailSessionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    workspace_owner_id: "owner_123",
    session_number: "CS-ACH-2026-0001",
    status: "open",
    currency: "USD",
    secondary_currency: null,
    drawer_id: 5,
    location_id: 7,
    opening_cash: "100.00",
    opening_cash_secondary: null,
    expected_cash: "270.00",
    expected_cash_secondary: null,
    actual_cash: null,
    actual_cash_secondary: null,
    difference: null,
    difference_secondary: null,
    closing_counts: null,
    opened_by_clerk_id: "user_abc",
    closed_by_clerk_id: null,
    approved_by_clerk_id: null,
    opened_at: "2026-07-16T10:00:00Z",
    closed_at: null,
    drawer_name: "Main Drawer",
    drawer_code: "MAIN",
    drawer_currency: "USD",
    drawer_secondary_currency: null,
    location_name: "Beirut",
    ...overrides,
  };
}

describe("GET /cash-sessions/:id — historical open_conflict suppression", () => {
  it("returns open_conflict: null for an approved session even when another session is open", async () => {
    // For an approved session, shouldCheckConflict = false → no otherOpen query fired.
    // Queries: 1. session SELECT, 2. txns (parallel), 3. movements (parallel), 4. logs
    mockDbQuery
      .mockResolvedValueOnce({ rows: [makeDetailSessionRow({ status: "approved", actual_cash: "270.00" })], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // txns
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // movements
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // logs

    const res = await request(makeApp()).get("/cash-sessions/1");

    expect(res.status).toBe(200);
    expect(res.body.open_conflict).toBeNull();
    // Confirm the otherOpen query was NOT issued. Queries: session SELECT,
    // txns, movements, logs, activeTransfers = 5 (no otherOpen).
    expect(mockDbQuery).toHaveBeenCalledTimes(5);
  });

  it("sets open_conflict when an open session sees a concurrent session on the same drawer", async () => {
    // For an open session, shouldCheckConflict = true → otherOpen query fires.
    mockDbQuery
      .mockResolvedValueOnce({ rows: [makeDetailSessionRow({ status: "open" })], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // txns
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // movements
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // logs
      .mockResolvedValueOnce({ rows: [{ id: 99, session_number: "CS-OTHER-0001" }], rowCount: 1 }); // otherOpen

    const res = await request(makeApp()).get("/cash-sessions/1");

    expect(res.status).toBe(200);
    expect(res.body.open_conflict).toEqual({ id: 99, session_number: "CS-OTHER-0001" });
    // session SELECT, txns, movements, logs, otherOpen, activeTransfers = 6.
    expect(mockDbQuery).toHaveBeenCalledTimes(6);
  });

  it("open_conflict is null when no other open session exists on the same drawer", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [makeDetailSessionRow({ status: "open" })], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // txns
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // movements
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // logs
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });  // otherOpen — no conflict

    const res = await request(makeApp()).get("/cash-sessions/1");

    expect(res.status).toBe(200);
    expect(res.body.open_conflict).toBeNull();
  });
});

describe("GET /cash-sessions/:id — session currency snapshot", () => {
  it("does not add USD from the drawer to an LBP-only session", async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [
          makeDetailSessionRow({
            currency: "LBP",
            secondary_currency: null,
            opening_cash: "5000000.00",
            drawer_currency: "USD",
            drawer_secondary_currency: "LBP",
          }),
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(makeApp()).get("/cash-sessions/1");

    expect(res.status).toBe(200);
    expect(res.body.currencies).toEqual(["LBP"]);
  });

  it("keeps both currencies from a true dual-currency session snapshot", async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [
          makeDetailSessionRow({
            currency: "USD",
            secondary_currency: "LBP",
            opening_cash_secondary: "5000000.00",
            drawer_currency: "USD",
            drawer_secondary_currency: "LBP",
          }),
        ],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(makeApp()).get("/cash-sessions/1");

    expect(res.status).toBe(200);
    expect(res.body.currencies).toEqual(["USD", "LBP"]);
  });
});

describe("GET /cash-sessions/:id — closing_counts result field enrichment", () => {
  function primeGetDetail(closingCounts: unknown[]) {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [makeDetailSessionRow({
          status: "pending_review",
          actual_cash: "270.00",
          closing_counts: closingCounts,
        })],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // txns
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // movements
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })  // logs
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // otherOpen
  }

  it("result is 'balanced' when variance = 0", async () => {
    primeGetDetail([{ currency: "USD", expected: 270, actual: 270, variance: 0 }]);

    const res = await request(makeApp()).get("/cash-sessions/1");

    expect(res.status).toBe(200);
    const counts = res.body.session.closing_counts as Array<{ result: string }>;
    expect(counts[0].result).toBe("balanced");
  });

  it("result is 'shortage' when variance < 0 (counted less than expected)", async () => {
    primeGetDetail([{ currency: "USD", expected: 270, actual: 255, variance: -15 }]);

    const res = await request(makeApp()).get("/cash-sessions/1");

    expect(res.status).toBe(200);
    const counts = res.body.session.closing_counts as Array<{ result: string }>;
    expect(counts[0].result).toBe("shortage");
  });

  it("result is 'overage' when variance > 0 (counted more than expected)", async () => {
    primeGetDetail([{ currency: "USD", expected: 270, actual: 285, variance: 15 }]);

    const res = await request(makeApp()).get("/cash-sessions/1");

    expect(res.status).toBe(200);
    const counts = res.body.session.closing_counts as Array<{ result: string }>;
    expect(counts[0].result).toBe("overage");
  });

  it("result is 'awaiting_count' when actual is null", async () => {
    primeGetDetail([{ currency: "USD", expected: 270, actual: null, variance: 0 }]);

    const res = await request(makeApp()).get("/cash-sessions/1");

    expect(res.status).toBe(200);
    const counts = res.body.session.closing_counts as Array<{ result: string }>;
    expect(counts[0].result).toBe("awaiting_count");
  });

  it("handles multiple currencies with different result labels", async () => {
    primeGetDetail([
      { currency: "USD", expected: 270, actual: 270, variance: 0 },
      { currency: "LBP", expected: 5_000_000, actual: 4_800_000, variance: -200_000 },
    ]);

    const res = await request(makeApp()).get("/cash-sessions/1");

    expect(res.status).toBe(200);
    const counts = res.body.session.closing_counts as Array<{ currency: string; result: string }>;
    const usd = counts.find((c) => c.currency === "USD");
    const lbp = counts.find((c) => c.currency === "LBP");
    expect(usd?.result).toBe("balanced");
    expect(lbp?.result).toBe("shortage");
  });
});

describe("GET /cash-sessions/:id — session_activity does not include sale/expense events", () => {
  it("session_activity contains only session-lifecycle events, not per-transaction events", async () => {
    const logs = [
      // session-lifecycle event → must appear in session_activity
      { id: 1, action: "opened", actor_clerk_id: null, actor_name: "Alice", detail: null, created_at: "2026-07-16T10:00:00Z" },
      // per-transaction event (not in SESSION_SCOPE_ACTIONS) → must NOT appear in session_activity
      { id: 2, action: "sale_recorded", actor_clerk_id: null, actor_name: "Alice", detail: JSON.stringify({ transactionId: 99, amount: "25.00" }), created_at: "2026-07-16T10:05:00Z" },
      { id: 3, action: "transaction_linked", actor_clerk_id: null, actor_name: "Alice", detail: JSON.stringify({ transactionId: 99 }), created_at: "2026-07-16T10:05:01Z" },
    ];

    mockDbQuery
      .mockResolvedValueOnce({ rows: [makeDetailSessionRow({ status: "open" })], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })   // txns
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })   // movements
      .mockResolvedValueOnce({ rows: logs, rowCount: 3 }) // activity logs
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });  // otherOpen

    const res = await request(makeApp()).get("/cash-sessions/1");

    expect(res.status).toBe(200);
    const sessionActivity: Array<{ action: string }> = res.body.session_activity;
    // Only "opened" should appear; sale_recorded and transaction_linked must not.
    expect(sessionActivity.map((l) => l.action)).toEqual(["opened"]);

    // The full activity log still contains all three entries.
    const fullActivity: Array<{ action: string }> = res.body.activity;
    expect(fullActivity).toHaveLength(3);
  });

  it("session_activity includes all recognised session-scope action types", async () => {
    const scopedActions = ["opened", "closed", "approved", "flagged", "reopened",
      "reconciliation_started", "reconciliation_counts_submitted"];
    const logs = scopedActions.map((action, idx) => ({
      id: idx + 1,
      action,
      actor_clerk_id: null,
      actor_name: null,
      detail: null,
      created_at: `2026-07-16T10:0${idx}:00Z`,
    }));

    mockDbQuery
      .mockResolvedValueOnce({ rows: [makeDetailSessionRow({ status: "approved" })], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: logs, rowCount: logs.length })
      // approved session → no otherOpen query
    ;

    const res = await request(makeApp()).get("/cash-sessions/1");

    expect(res.status).toBe(200);
    const sessionActivity: Array<{ action: string }> = res.body.session_activity;
    expect(sessionActivity.map((l) => l.action)).toEqual(scopedActions);
  });
});

describe("POST /cash-sessions/:id/sale — block transaction on closed session", () => {
  it("returns 409 when attempting to record a sale on a non-open session", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [makeSessionRow({ status: "pending_review" })], rowCount: 1 });

    const res = await request(makeApp())
      .post("/cash-sessions/1/sale")
      .send({ amount: 50, currency: "USD", sale_channel: "walk_in" });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/open/i);
    expect(mockRecordCashTransaction).not.toHaveBeenCalled();
  });

  it("returns 409 when attempting to record a sale on an approved session", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [makeSessionRow({ status: "approved" })], rowCount: 1 });

    const res = await request(makeApp())
      .post("/cash-sessions/1/sale")
      .send({ amount: 50, currency: "USD", sale_channel: "walk_in" });

    expect(res.status).toBe(409);
    expect(mockRecordCashTransaction).not.toHaveBeenCalled();
  });
});

describe("POST /cash-sessions/:id/reopen — conflict detection", () => {
  it("returns 409 when the drawer already has another open session", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [makeSessionRow({ status: "approved" })], rowCount: 1 }) // loadSession
      .mockResolvedValueOnce({ rows: [{ id: 99 }], rowCount: 1 }); // openExisting check

    const res = await request(makeApp())
      .post("/cash-sessions/1/reopen")
      .send({ reopen_reason: "Correction needed" });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already has another open session/);
  });

  it("succeeds when no conflicting open session exists on the drawer", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [makeSessionRow({ status: "approved" })], rowCount: 1 }) // loadSession
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                                        // openExisting
      .mockResolvedValueOnce({ rows: [makeSessionRow({ status: "open" })], rowCount: 1 });    // UPDATE RETURNING

    const res = await request(makeApp())
      .post("/cash-sessions/1/reopen")
      .send({ reopen_reason: "Correction needed" });

    expect(res.status).toBe(200);
    expect(res.body.session.status).toBe("open");
  });
});

// ---------------------------------------------------------------------------
// Salary expense approvals
// ---------------------------------------------------------------------------

describe("POST /cash-sessions/:id/expense — salaries_wages routes to pending approval", () => {
  beforeEach(() => {
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockRecordCashTransaction.mockResolvedValue({ transactionId: 55, linked: true, cashSessionId: 1 });
  });

  it("inserts the transaction as pending, flags the response, and fires approver DMs", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [makeSessionRow()] })                                          // loadSession
      .mockResolvedValueOnce({ rows: [{ currency: "USD", secondary_currency: null }] })             // allowedCurrenciesFor
      .mockResolvedValueOnce({ rows: [{ id: 42, name: "Ahmad Saade" }], rowCount: 1 })              // employee lookup
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                                             // duplicate check
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                                             // UPDATE expense_category/payee
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                                             // UPDATE payroll metadata
      .mockResolvedValueOnce({ rows: [makeSessionRow()] })                                          // refreshed loadSession
      .mockResolvedValueOnce({                                                                      // BD approver names
        rows: [{ member_user_id: null, member_email: "bassel@presentail.com" }],
        rowCount: 1,
      });

    const res = await request(makeApp()).post("/cash-sessions/1/expense").send({
      amount: 1500,
      currency: "USD",
      expense_category: "salaries_wages",
      payroll_employee_id: "tm_42",
      payroll_period: "2026-08",
      payroll_payment_type: "salary",
      paid_from_drawer: true,
    });

    expect(res.status).toBe(201);
    expect(res.body.pending_approval).toBe(true);
    // The response names who the request is waiting on (email prefix fallback).
    expect(res.body.approver_names).toEqual(["bassel"]);
    expect(mockRecordCashTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ approvalStatus: "pending", requestedByClerkId: "user_abc" }),
    );
    expect(mockNotifySalaryApprovalRequested).toHaveBeenCalledTimes(1);
  });

  it("keeps non-payroll categories confirmed with no approval flow", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [makeSessionRow()] })                                          // loadSession
      .mockResolvedValueOnce({ rows: [{ currency: "USD", secondary_currency: null }] });            // allowedCurrenciesFor

    const res = await request(makeApp()).post("/cash-sessions/1/expense").send({
      amount: 20,
      currency: "USD",
      expense_category: "supplies",
      payee: "Flower supplier",
      description: "Ribbon restock",
      paid_from_drawer: true,
    });

    expect(res.status).toBe(201);
    expect(res.body.pending_approval).toBe(false);
    expect(mockRecordCashTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ approvalStatus: "confirmed", requestedByClerkId: null }),
    );
    expect(mockNotifySalaryApprovalRequested).not.toHaveBeenCalled();
  });
});

describe("Salary approval endpoints", () => {
  const pendingRow = {
    id: 55,
    cash_session_id: 1,
    amount: "1500.00",
    currency: "USD",
    transaction_currency: "USD",
    payee: "Ahmad Saade",
    description: "Salary — Ahmad Saade",
    payroll_payment_type: "salary",
    payroll_period: "2026-08",
    requested_by_clerk_id: "user_abc",
    approval_status: "pending",
    transaction_date: "2026-08-17T09:00:00Z",
    session_number: "CS-1",
  };

  beforeEach(() => {
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("GET /cash-approvals returns pending requests for an owner", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [pendingRow], rowCount: 1 }); // pending list (owner skips role query)
    const res = await request(makeApp()).get("/cash-approvals");
    expect(res.status).toBe(200);
    expect(res.body.requests).toHaveLength(1);
    expect(res.body.requests[0].id).toBe(55);
  });

  it("GET /cash-approvals rejects members without the Business Development role", async () => {
    stubWorkspaceRole = "member";
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // BD role check → no rows
    const res = await request(makeApp()).get("/cash-approvals");
    expect(res.status).toBe(403);
  });

  it("approve confirms the transaction, recomputes totals, and notifies the requester", async () => {
    const { recomputeSessionTotals } = await import("../lib/cashDesk");
    mockDbQuery
      .mockResolvedValueOnce({ rows: [pendingRow], rowCount: 1 })  // loadPendingSalaryApproval
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });           // UPDATE → confirmed

    const res = await request(makeApp()).post("/cash-approvals/55/approve");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("confirmed");
    expect(recomputeSessionTotals).toHaveBeenCalledWith(1, "owner_123");
    expect(mockNotifySalaryDecisionToRequester).toHaveBeenCalledWith(
      expect.objectContaining({ fields: expect.objectContaining({ approved: true }) }),
    );
  });

  it("approve is blocked for a member without the BD role", async () => {
    stubWorkspaceRole = "member";
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // BD role check → no rows
    const res = await request(makeApp()).post("/cash-approvals/55/approve");
    expect(res.status).toBe(403);
    expect(mockNotifySalaryDecisionToRequester).not.toHaveBeenCalled();
  });

  it("decline records the reason, never recomputes, and notifies the requester", async () => {
    const { recomputeSessionTotals } = await import("../lib/cashDesk");
    mockDbQuery
      .mockResolvedValueOnce({ rows: [pendingRow], rowCount: 1 })  // loadPendingSalaryApproval
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });           // UPDATE → declined

    const res = await request(makeApp())
      .post("/cash-approvals/55/decline")
      .send({ reason: "Wrong amount" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("declined");
    expect(recomputeSessionTotals).not.toHaveBeenCalled();
    expect(mockNotifySalaryDecisionToRequester).toHaveBeenCalledWith(
      expect.objectContaining({ fields: expect.objectContaining({ approved: false, reason: "Wrong amount" }) }),
    );
  });

  it("returns 409 when the request was already decided", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ ...pendingRow, approval_status: "declined" }], rowCount: 1 });
    const res = await request(makeApp()).post("/cash-approvals/55/approve");
    expect(res.status).toBe(409);
  });

  it("cancel succeeds for the requester and fails for anyone else", async () => {
    // Requester (authed userId is user_abc) cancels own request.
    mockDbQuery
      .mockResolvedValueOnce({ rows: [pendingRow], rowCount: 1 })  // load
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });           // UPDATE → cancelled
    const ok = await request(makeApp()).post("/cash-approvals/55/cancel");
    expect(ok.status).toBe(200);

    // Someone else's request → 403.
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ ...pendingRow, requested_by_clerk_id: "user_other" }],
      rowCount: 1,
    });
    const forbidden = await request(makeApp()).post("/cash-approvals/55/cancel");
    expect(forbidden.status).toBe(403);
  });
});

describe("Session close blocked by pending salary approvals", () => {
  beforeEach(() => {
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("POST /cash-sessions/:id/close returns 409 while salary requests are pending", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [makeSessionRow()], rowCount: 1 })   // loadSession
      .mockResolvedValueOnce({ rows: [{ count: "2" }], rowCount: 1 });    // pending approvals count

    const res = await request(makeApp())
      .post("/cash-sessions/1/close")
      .send({ counts: [{ currency: "USD", actual: 100 }] });

    expect(res.status).toBe(409);
    expect(res.body.pending_salary_approvals).toBe(2);
    expect(res.body.error).toMatch(/pending salary expense approval/i);
  });
});

// ---------------------------------------------------------------------------
// POST /cash-sessions — CMC Beirut Hospital location guard
// ---------------------------------------------------------------------------

describe("POST /cash-sessions — CMC location guard", () => {
  function makeDrawerRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 5,
      name: "Front Desk",
      code: "FD",
      location_id: 7,
      currency: "USD",
      secondary_currency: null,
      is_active: true,
      location_name: "Main Branch",
      ...overrides,
    };
  }

  beforeEach(() => {
    mockDbQuery.mockReset();
    stubWorkspaceRole = "owner";
    stubAllowedPages = [];
  });

  it("rejects a drawer belonging to CMC Beirut Hospital with 422", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [makeDrawerRow({ location_name: "CMC Beirut Hospital" })],
      rowCount: 1,
    }); // drawer SELECT

    const res = await request(makeApp())
      .post("/cash-sessions")
      .send({ drawer_id: 5, opening_cash: 0 });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/CMC Beirut Hospital/);
    expect(res.body.error).toMatch(/CMC POS/);
    // Guard fires right after the drawer SELECT — no further DB calls.
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
  });

  it("rejects a CMC drawer regardless of name casing", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [makeDrawerRow({ location_name: "cmc beirut hospital – ground floor" })],
      rowCount: 1,
    });

    const res = await request(makeApp())
      .post("/cash-sessions")
      .send({ drawer_id: 5, opening_cash: 0 });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/CMC POS/);
  });

  it("allows a non-CMC drawer to open normally", async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [makeDrawerRow({ location_name: "Regular Store" })],
        rowCount: 1,
      }) // drawer SELECT
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // open-session check
      .mockResolvedValueOnce({ rows: [makeSessionRow()], rowCount: 1 }); // INSERT

    const res = await request(makeApp())
      .post("/cash-sessions")
      .send({ drawer_id: 5, opening_cash: 0 });

    expect(res.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// GET /cash-sessions/:id — tx_type=sale filter includes cash_sale entries
// ---------------------------------------------------------------------------

describe("GET /cash-sessions/:id — tx_type=sale filter includes cash_sale rows", () => {
  beforeEach(() => {
    mockDbQuery.mockReset();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("returns cash_sale transactions when tx_type=sale is requested", async () => {
    const txRows = [
      {
        id: 10,
        type: "sale",
        amount: "50.00",
        currency: "USD",
        description: "Regular sale",
        created_at: "2026-07-16T10:01:00Z",
        created_by_clerk_id: null,
        sale_channel: "walk_in",
        category: null,
        receipt_number: null,
        idempotency_key: null,
        reversal_of_id: null,
        is_reversed: false,
      },
      {
        id: 11,
        type: "cash_sale",
        amount: "30.00",
        currency: "USD",
        description: "CMC cash sale",
        created_at: "2026-07-16T10:02:00Z",
        created_by_clerk_id: null,
        sale_channel: null,
        category: null,
        receipt_number: null,
        idempotency_key: null,
        reversal_of_id: null,
        is_reversed: false,
      },
      {
        id: 12,
        type: "expense",
        amount: "20.00",
        currency: "USD",
        description: "Supplies",
        created_at: "2026-07-16T10:03:00Z",
        created_by_clerk_id: null,
        sale_channel: null,
        category: "supplies",
        receipt_number: null,
        idempotency_key: null,
        reversal_of_id: null,
        is_reversed: false,
      },
    ];

    mockDbQuery
      .mockResolvedValueOnce({ rows: [makeDetailSessionRow({ status: "open" })], rowCount: 1 }) // session
      .mockResolvedValueOnce({ rows: txRows, rowCount: 3 })   // txns
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })        // movements
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })        // logs
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })        // otherOpen
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });       // activeTransfers

    const res = await request(makeApp()).get("/cash-sessions/1?tx_type=sale");

    expect(res.status).toBe(200);
    const txIds: number[] = res.body.transactions.map((t: { id: number }) => t.id);
    // Both the regular "sale" and the CMC "cash_sale" must appear.
    expect(txIds).toContain(10);
    expect(txIds).toContain(11);
    // The "expense" entry must not appear under the sale filter.
    expect(txIds).not.toContain(12);
  });
});
