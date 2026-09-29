/**
 * Cash Activity module — unit tests.
 *
 * Covers:
 * - Eligibility validation: all 8 invalid conditions are rejected
 * - Entity validation: transactions belonging to wrong entity are rejected
 * - Valid match creates group and audit log
 * - Bridge rows are deleted on unmatch so transactions can be re-matched
 * - Unmatch requires Finance Admin
 * - Finalization is blocked when conditions fail (open sessions, missing evidence, pending txns)
 * - Reopening records reason
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

// ---------------------------------------------------------------------------
// Mocks — declared before the module under test is imported
// ---------------------------------------------------------------------------

const mockDbQuery = vi.fn();
const mockDbConnect = vi.fn();

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
    connect: (...args: unknown[]) => mockDbConnect(...args),
  },
  // Matches actual signature: withTransaction(client, fn) — mock ignores client
  // and calls fn() directly (no BEGIN/COMMIT in unit tests).
  withTransaction: async (_client: unknown, fn: () => Promise<unknown>) => fn(),
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
  authed: () => ({ userId: "user_abc" }),
}));

let stubWorkspaceOwnerId = "owner_123";
let stubWorkspaceRole: "owner" | "member" = "owner";
let stubAllowedPages: string[] = [];
let stubPermissions: string[] = [];

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = stubWorkspaceOwnerId;
    wreq.workspaceRole = stubWorkspaceRole;
    wreq.workspaceActualRole = stubWorkspaceRole;
    (wreq as unknown as { allowedPages: string[] }).allowedPages = stubAllowedPages;
    (wreq as unknown as { permissions: string[] }).permissions = stubPermissions;
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

// Mock cashActivity lib to avoid heavy DB wiring in unit tests.
// The route file re-exports validateMatchEligibility and parseYearMonth from the
// lib, so we keep those as-is via importOriginal.
vi.mock("../lib/cashActivity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/cashActivity")>();
  return {
    ...actual,
    getPaginatedTransactions: vi.fn().mockResolvedValue({
      rows: [],
      total: 0,
      page: 1,
      pageSize: 25,
      totalPages: 1,
    }),
    getCashActivitySummary: vi.fn().mockResolvedValue({
      cashSalesTotal: "0.00",
      refundsTotal: "0.00",
      cashExpensesTotal: "0.00",
      netCashActivity: "0.00",
      needsReviewCount: 0,
      totalTransactions: 0,
      expectedCash: "0.00",
      deposited: "0.00",
      transferred: "0.00",
      cashPositionDifference: "0.00",
      balanced: true,
    }),
    getCashActivityChart: vi.fn().mockResolvedValue([]),
    getOrCreateMonthStatus: vi.fn().mockResolvedValue({
      id: 1,
      yearMonth: "2026-08",
      status: "OPEN",
      finalizedBy: null,
      finalizedAt: null,
      reopenReason: null,
      reopenActor: null,
      reopenAt: null,
    }),
    parseYearMonth: actual.parseYearMonth,
    validateMatchEligibility: actual.validateMatchEligibility,
  };
});

import cashActivityRouter from "./cashActivity";
import {
  getPaginatedTransactions,
  getCashActivitySummary,
  getCashActivityChart,
  getOrCreateMonthStatus,
} from "../lib/cashActivity";

// ---------------------------------------------------------------------------
// Test app factory
// ---------------------------------------------------------------------------

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => {
    const r = _req as any;
    r.log = { error: () => {}, warn: () => {}, info: () => {} };

    // Simulate what requireAuth middleware would set:
    // When role is "owner", the current user IS the workspace owner.
    const userId =
      stubWorkspaceRole === "owner" ? stubWorkspaceOwnerId : "user_member_abc";
    r.auth = { userId };

    // Simulate what the workspace middleware would set:
    r.workspace = {
      owner_id: stubWorkspaceOwnerId, // always the workspace owner's ID
      allowed_pages: stubAllowedPages,
      permissions: stubPermissions,
    };

    next();
  });
  app.use(cashActivityRouter);
  return app;
}

/** Shared factory for MatchCandidate-shaped transaction rows. */
function makeTxn(overrides: Partial<import("../lib/cashActivity").MatchCandidate> = {}) {
  return {
    id: Math.floor(Math.random() * 10000),
    workspace_owner_id: "owner_123",
    currency: "AED",
    direction: "in",
    amount: "100.00",
    status: "confirmed",
    approval_status: "confirmed",
    is_reversed: false,
    cash_drawer_id: 1,
    drawer_entity_id: null, // newly required by entity validation
    location_id: 10,
    transaction_date: "2026-08-15T10:00:00Z",
    type: "sale",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Reset mocks between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  // resetAllMocks clears both call history AND the mockResolvedValueOnce queue,
  // preventing implementation bleed-through between tests.
  vi.resetAllMocks();
  stubWorkspaceOwnerId = "owner_123";
  stubWorkspaceRole = "owner";
  stubAllowedPages = [];
  stubPermissions = [];

  // Default connect mock: returns a pooled client-like object whose .query
  // delegates to the shared mockDbQuery spy.
  mockDbConnect.mockResolvedValue({
    query: (...args: unknown[]) => mockDbQuery(...args),
    release: vi.fn(),
  });

  // Default query mock: returns empty result
  mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });

  // Re-apply lib function defaults that resetAllMocks() cleared.
  (getPaginatedTransactions as ReturnType<typeof vi.fn>).mockResolvedValue({
    rows: [],
    total: 0,
    page: 1,
    pageSize: 25,
    totalPages: 1,
  });
  (getCashActivitySummary as ReturnType<typeof vi.fn>).mockResolvedValue({
    cashSalesTotal: "0.00",
    refundsTotal: "0.00",
    cashExpensesTotal: "0.00",
    netCashActivity: "0.00",
    needsReviewCount: 0,
    totalTransactions: 0,
    expectedCash: "0.00",
    deposited: "0.00",
    transferred: "0.00",
    cashPositionDifference: "0.00",
    balanced: true,
  });
  (getCashActivityChart as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (getOrCreateMonthStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: 1,
    yearMonth: "2026-08",
    status: "OPEN",
    finalizedBy: null,
    finalizedAt: null,
    reopenReason: null,
    reopenActor: null,
    reopenAt: null,
  });
});

// ===========================================================================
// GET /cash-activity/transactions
// ===========================================================================

describe("GET /cash-activity/transactions", () => {
  it("returns 403 when user lacks general access", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = [];
    const res = await request(makeApp())
      .get("/cash-activity/transactions")
      .query({ yearMonth: "2026-08" });
    expect(res.status).toBe(403);
  });

  it("returns 400 when yearMonth is missing", async () => {
    const res = await request(makeApp()).get("/cash-activity/transactions");
    expect(res.status).toBe(400);
  });

  it("returns 400 when yearMonth is malformed", async () => {
    const res = await request(makeApp())
      .get("/cash-activity/transactions")
      .query({ yearMonth: "2026-13" });
    expect(res.status).toBe(400);
  });

  it("returns 200 with paginated results for an owner", async () => {
    const res = await request(makeApp())
      .get("/cash-activity/transactions")
      .query({ yearMonth: "2026-08", tab: "unmatched" });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("rows");
    expect(res.body).toHaveProperty("total");
  });

  it("returns 200 for a member with cash-activity permission", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = ["cash-activity"];
    const res = await request(makeApp())
      .get("/cash-activity/transactions")
      .query({ yearMonth: "2026-08" });
    expect(res.status).toBe(200);
  });
});

// ===========================================================================
// GET /cash-activity/summary
// ===========================================================================

describe("GET /cash-activity/summary", () => {
  it("returns 403 for unauthorized user", async () => {
    stubWorkspaceRole = "member";
    const res = await request(makeApp())
      .get("/cash-activity/summary")
      .query({ yearMonth: "2026-08" });
    expect(res.status).toBe(403);
  });

  it("returns 200 with summary for authorized user", async () => {
    const res = await request(makeApp())
      .get("/cash-activity/summary")
      .query({ yearMonth: "2026-08" });
    expect(res.status).toBe(200);
    expect(res.body.summary).toBeDefined();
    expect(res.body.summary).toHaveProperty("cashSalesTotal");
    expect(res.body.summary).toHaveProperty("balanced");
  });
});

// ===========================================================================
// GET /cash-activity/chart
// ===========================================================================

describe("GET /cash-activity/chart", () => {
  it("returns 200 with series array", async () => {
    const res = await request(makeApp())
      .get("/cash-activity/chart")
      .query({ yearMonth: "2026-08" });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("series");
    expect(Array.isArray(res.body.series)).toBe(true);
  });
});

// ===========================================================================
// POST /cash-activity/match — eligibility rules
//
// Query order inside the transaction (client.query calls via mockDbQuery):
//   1. SELECT cash_transactions LEFT JOIN cash_drawers  → candidate rows
//   2. SELECT status FROM cash_activity_months          → month status
//   3. INSERT INTO cash_match_groups                    → { id }
//   4. INSERT INTO cash_match_group_transactions        → {} (one per txId)
//   5. INSERT INTO cash_activity_audit_log              → {}
// ===========================================================================

describe("POST /cash-activity/match — eligibility validation", () => {
  it("returns 400 when transactionIds is missing", async () => {
    const res = await request(makeApp())
      .post("/cash-activity/match")
      .send({ yearMonth: "2026-08" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when fewer than 2 transaction IDs are provided", async () => {
    const res = await request(makeApp())
      .post("/cash-activity/match")
      .send({ transactionIds: [1], yearMonth: "2026-08" });
    expect(res.status).toBe(400);
  });

  it("returns 404 when a transaction is not found", async () => {
    // Step 1 (SELECT txns): only 1 row returned when 2 IDs were requested → 404
    mockDbQuery
      .mockResolvedValueOnce({ rows: [makeTxn({ id: 1 })], rowCount: 1 });

    const res = await request(makeApp())
      .post("/cash-activity/match")
      .send({ transactionIds: [1, 2], yearMonth: "2026-08" });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("Hierarchical lock — returns 409 when workspace-level month is finalized for entity-scoped match", async () => {
    // Transactions belong to entity 5 (derivedEntityId = 5 ≠ null).
    // The entity-5 month is OPEN, but the workspace-level (null-entity) month is FINALIZED.
    // The hierarchical lock must detect this and reject the match.
    const txn1 = makeTxn({ id: 1, direction: "in",  amount: "100.00", drawer_entity_id: 5 });
    const txn2 = makeTxn({ id: 2, direction: "out", amount: "100.00", drawer_entity_id: 5 });

    mockDbQuery
      .mockResolvedValueOnce({ rows: [txn1, txn2], rowCount: 2 })                       // 1. SELECT txns
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                                  // 2. INSERT entity-5 month ON CONFLICT
      .mockResolvedValueOnce({ rows: [{ id: 1, status: "OPEN" }], rowCount: 1 })        // 3. SELECT FOR UPDATE entity-5 month (OPEN)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                                  // 4. INSERT workspace-null month ON CONFLICT
      .mockResolvedValueOnce({ rows: [{ id: 2, status: "FINALIZED" }], rowCount: 1 });  // 5. SELECT FOR UPDATE workspace-null month → FINALIZED

    const res = await request(makeApp())
      .post("/cash-activity/match")
      .send({ transactionIds: [1, 2], yearMonth: "2026-08" }); // entityId omitted: derived from drawers
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/finalized/i);
  });

  it("Rule 1 — returns 409 when month is FINALIZED", async () => {
    const txn1 = makeTxn({ id: 1, direction: "in",  amount: "100.00" });
    const txn2 = makeTxn({ id: 2, direction: "out", amount: "100.00" });

    mockDbQuery
      .mockResolvedValueOnce({ rows: [txn1, txn2], rowCount: 2 })                      // 1. SELECT txns
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                                 // 2. INSERT months ON CONFLICT
      .mockResolvedValueOnce({ rows: [{ id: 1, status: "FINALIZED" }], rowCount: 1 }); // 3. SELECT FOR UPDATE

    const res = await request(makeApp())
      .post("/cash-activity/match")
      .send({ transactionIds: [1, 2], yearMonth: "2026-08" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/finalized/i);
  });

  it("Rule 2 — rejects when there is no cash-in transaction", async () => {
    const txn1 = makeTxn({ id: 1, direction: "out", amount: "50.00" });
    const txn2 = makeTxn({ id: 2, direction: "out", amount: "50.00" });

    mockDbQuery
      .mockResolvedValueOnce({ rows: [txn1, txn2], rowCount: 2 })                    // 1. SELECT txns
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                               // 2. INSERT months ON CONFLICT
      .mockResolvedValueOnce({ rows: [{ id: 1, status: "OPEN" }], rowCount: 1 });    // 3. SELECT FOR UPDATE

    const res = await request(makeApp())
      .post("/cash-activity/match")
      .send({ transactionIds: [1, 2], yearMonth: "2026-08" });
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual(
      expect.arrayContaining([expect.stringMatching(/cash-in/i)]),
    );
  });

  it("Rule 3 — rejects when there is no cash-out transaction", async () => {
    const txn1 = makeTxn({ id: 1, direction: "in", amount: "100.00" });
    const txn2 = makeTxn({ id: 2, direction: "in", amount: "100.00" });

    mockDbQuery
      .mockResolvedValueOnce({ rows: [txn1, txn2], rowCount: 2 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: 1, status: "OPEN" }], rowCount: 1 });

    const res = await request(makeApp())
      .post("/cash-activity/match")
      .send({ transactionIds: [1, 2], yearMonth: "2026-08" });
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual(
      expect.arrayContaining([expect.stringMatching(/cash-out/i)]),
    );
  });

  it("Rule 4 — rejects when transactions have different currencies", async () => {
    const txn1 = makeTxn({ id: 1, direction: "in",  currency: "AED", amount: "100.00" });
    const txn2 = makeTxn({ id: 2, direction: "out", currency: "USD", amount: "100.00" });

    mockDbQuery
      .mockResolvedValueOnce({ rows: [txn1, txn2], rowCount: 2 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: 1, status: "OPEN" }], rowCount: 1 });

    const res = await request(makeApp())
      .post("/cash-activity/match")
      .send({ transactionIds: [1, 2], yearMonth: "2026-08" });
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual(
      expect.arrayContaining([expect.stringMatching(/currency/i)]),
    );
  });

  it("Rule 4 — rejects when transactions belong to different months", async () => {
    const txn1 = makeTxn({ id: 1, direction: "in",  amount: "100.00", transaction_date: "2026-08-15T10:00:00Z" });
    const txn2 = makeTxn({ id: 2, direction: "out", amount: "100.00", transaction_date: "2026-07-28T10:00:00Z" });

    mockDbQuery
      .mockResolvedValueOnce({ rows: [txn1, txn2], rowCount: 2 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: 1, status: "OPEN" }], rowCount: 1 });

    const res = await request(makeApp())
      .post("/cash-activity/match")
      .send({ transactionIds: [1, 2], yearMonth: "2026-08" });
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual(
      expect.arrayContaining([expect.stringMatching(/month/i)]),
    );
  });

  it("Rule 6 — rejects cancelled (voided) transactions", async () => {
    const txn1 = makeTxn({ id: 1, direction: "in",  amount: "100.00" });
    const txn2 = makeTxn({ id: 2, direction: "out", amount: "100.00", approval_status: "cancelled" });

    mockDbQuery
      .mockResolvedValueOnce({ rows: [txn1, txn2], rowCount: 2 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: 1, status: "OPEN" }], rowCount: 1 });

    const res = await request(makeApp())
      .post("/cash-activity/match")
      .send({ transactionIds: [1, 2], yearMonth: "2026-08" });
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual(
      expect.arrayContaining([expect.stringMatching(/cancelled/i)]),
    );
  });

  it("Rule 7 — rejects reversed transactions", async () => {
    const txn1 = makeTxn({ id: 1, direction: "in",  amount: "100.00" });
    const txn2 = makeTxn({ id: 2, direction: "out", amount: "100.00", is_reversed: true });

    mockDbQuery
      .mockResolvedValueOnce({ rows: [txn1, txn2], rowCount: 2 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: 1, status: "OPEN" }], rowCount: 1 });

    const res = await request(makeApp())
      .post("/cash-activity/match")
      .send({ transactionIds: [1, 2], yearMonth: "2026-08" });
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual(
      expect.arrayContaining([expect.stringMatching(/reversed/i)]),
    );
  });

  it("Rule 8 — rejects when cash-in total does not equal cash-out total", async () => {
    const txn1 = makeTxn({ id: 1, direction: "in",  amount: "100.00" });
    const txn2 = makeTxn({ id: 2, direction: "out", amount: "90.00" });

    mockDbQuery
      .mockResolvedValueOnce({ rows: [txn1, txn2], rowCount: 2 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: 1, status: "OPEN" }], rowCount: 1 });

    const res = await request(makeApp())
      .post("/cash-activity/match")
      .send({ transactionIds: [1, 2], yearMonth: "2026-08" });
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual(
      expect.arrayContaining([expect.stringMatching(/cash-in total.*cash-out total/i)]),
    );
  });

  it("Entity rule — rejects when transaction drawers belong to a different entity", async () => {
    // Transactions whose drawers are scoped to entity 7 while the caller
    // requests entity 99.
    const txn1 = makeTxn({ id: 1, direction: "in",  amount: "100.00", drawer_entity_id: 7 });
    const txn2 = makeTxn({ id: 2, direction: "out", amount: "100.00", drawer_entity_id: 7 });

    mockDbQuery
      .mockResolvedValueOnce({ rows: [txn1, txn2], rowCount: 2 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: 1, status: "OPEN" }], rowCount: 1 });

    const res = await request(makeApp())
      .post("/cash-activity/match")
      .send({ transactionIds: [1, 2], yearMonth: "2026-08", entityId: 99 });
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual(
      expect.arrayContaining([expect.stringMatching(/entity/i)]),
    );
  });

  it("Dimension rule — rejects when caller-supplied entityId conflicts with transaction entity", async () => {
    // Transactions belong to entity 5 (via their drawer), but caller says entity 99.
    const txn1 = makeTxn({ id: 1, direction: "in",  amount: "100.00", drawer_entity_id: 5 });
    const txn2 = makeTxn({ id: 2, direction: "out", amount: "100.00", drawer_entity_id: 5 });

    mockDbQuery
      .mockResolvedValueOnce({ rows: [txn1, txn2], rowCount: 2 })                    // 1. SELECT txns
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                               // 2. INSERT months ON CONFLICT
      .mockResolvedValueOnce({ rows: [{ id: 1, status: "OPEN" }], rowCount: 1 });    // 3. SELECT FOR UPDATE

    const res = await request(makeApp())
      .post("/cash-activity/match")
      .send({ transactionIds: [1, 2], yearMonth: "2026-08", entityId: 99 });
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual(
      expect.arrayContaining([expect.stringMatching(/entityId mismatch/i)]),
    );
  });

  it("creates group and audit log on valid match", async () => {
    const txn1 = makeTxn({ id: 1, direction: "in",  amount: "100.00" });
    const txn2 = makeTxn({ id: 2, direction: "out", amount: "100.00" });

    mockDbQuery
      .mockResolvedValueOnce({ rows: [txn1, txn2], rowCount: 2 })                    // 1. SELECT txns
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                               // 2. INSERT months ON CONFLICT
      .mockResolvedValueOnce({ rows: [{ id: 1, status: "OPEN" }], rowCount: 1 })     // 3. SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 })                    // 4. INSERT match_groups
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                               // 5. INSERT bridge txn1
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                               // 6. INSERT bridge txn2
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });                              // 7. INSERT audit_log

    const res = await request(makeApp())
      .post("/cash-activity/match")
      .send({ transactionIds: [1, 2], yearMonth: "2026-08", note: "test match" });

    expect(res.status).toBe(201);
    expect(res.body.groupId).toBe(42);

    // Verify audit log was inserted with action 'MATCH'
    const auditCall = mockDbQuery.mock.calls.find(
      (args) =>
        typeof args[0] === "string" &&
        args[0].includes("cash_activity_audit_log") &&
        args[0].includes("'MATCH'"),
    );
    expect(auditCall).toBeDefined();
  });

  it("returns 409 on concurrent match (unique constraint violation)", async () => {
    const txn1 = makeTxn({ id: 1, direction: "in",  amount: "100.00" });
    const txn2 = makeTxn({ id: 2, direction: "out", amount: "100.00" });

    const uniqueViolation = Object.assign(new Error("duplicate key"), { code: "23505" });

    mockDbQuery
      .mockResolvedValueOnce({ rows: [txn1, txn2], rowCount: 2 })                    // 1. SELECT txns
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                               // 2. INSERT months ON CONFLICT
      .mockResolvedValueOnce({ rows: [{ id: 1, status: "OPEN" }], rowCount: 1 })     // 3. SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ id: 99 }], rowCount: 1 })                    // 4. INSERT match_groups
      .mockRejectedValueOnce(uniqueViolation);                                        // 5. INSERT bridge → duplicate

    const res = await request(makeApp())
      .post("/cash-activity/match")
      .send({ transactionIds: [1, 2], yearMonth: "2026-08" });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already part of an active match group/i);
  });
});

// ===========================================================================
// DELETE /cash-activity/match/:groupId — unmatch
//
// Query order inside the transaction (client.query calls via mockDbQuery):
//   1. SELECT ... FROM cash_match_groups ... FOR UPDATE  → group
//   2. SELECT status FROM cash_activity_months           → month status
//   3. SELECT transaction_id FROM cash_match_group_transactions → bridge IDs
//   4. DELETE FROM cash_match_group_transactions         → {} (releases bridge)
//   5. UPDATE cash_match_groups SET status = 'UNMATCHED' → {}
//   6. INSERT INTO cash_activity_audit_log               → {}
// ===========================================================================

describe("DELETE /cash-activity/match/:groupId", () => {
  it("returns 403 for non-admin user", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = ["cash-activity"]; // general only, not admin
    const res = await request(makeApp())
      .delete("/cash-activity/match/1")
      .send({ reason: "correction" });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/admin/i);
  });

  it("returns 400 when reason is missing", async () => {
    const res = await request(makeApp())
      .delete("/cash-activity/match/1")
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/reason/i);
  });

  it("returns 400 for invalid groupId", async () => {
    const res = await request(makeApp())
      .delete("/cash-activity/match/abc")
      .send({ reason: "correction" });
    expect(res.status).toBe(400);
  });

  it("returns 404 when group is not found", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // FOR UPDATE → no rows
    const res = await request(makeApp())
      .delete("/cash-activity/match/99")
      .send({ reason: "correction" });
    expect(res.status).toBe(404);
  });

  it("returns 409 when group is already unmatched", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ id: 1, status: "UNMATCHED", accounting_month: "2026-08", entity_id: null }],
      rowCount: 1,
    });
    const res = await request(makeApp())
      .delete("/cash-activity/match/1")
      .send({ reason: "correction" });
    expect(res.status).toBe(409);
  });

  it("returns 409 when month is finalized", async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{ id: 1, status: "ACTIVE", accounting_month: "2026-08", entity_id: null }],
        rowCount: 1,
      }) // 1. group FOR UPDATE
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                                  // 2. INSERT month ON CONFLICT
      .mockResolvedValueOnce({ rows: [{ id: 1, status: "FINALIZED" }], rowCount: 1 }); // 3. month FOR UPDATE
    const res = await request(makeApp())
      .delete("/cash-activity/match/1")
      .send({ reason: "correction" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/finalized/i);
  });

  it("Hierarchical lock — returns 409 when workspace-level month is finalized for entity-scoped unmatch", async () => {
    // Group belongs to entity 7 (entity_id: 7 ≠ null). Entity month is OPEN,
    // but workspace-null month is FINALIZED. The hierarchical lock must detect this.
    stubWorkspaceRole = "member";
    stubAllowedPages = ["cash-activity-admin"];

    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{ id: 1, status: "ACTIVE", accounting_month: "2026-08", entity_id: 7 }],
        rowCount: 1,
      }) // 1. group FOR UPDATE
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                                  // 2. INSERT entity-7 month ON CONFLICT
      .mockResolvedValueOnce({ rows: [{ id: 1, status: "OPEN" }], rowCount: 1 })        // 3. SELECT FOR UPDATE entity-7 month (OPEN)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                                  // 4. INSERT workspace-null month ON CONFLICT
      .mockResolvedValueOnce({ rows: [{ id: 2, status: "FINALIZED" }], rowCount: 1 });  // 5. SELECT FOR UPDATE workspace-null → FINALIZED

    const res = await request(makeApp())
      .delete("/cash-activity/match/1")
      .send({ reason: "correction" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/finalized/i);
  });

  it("unmatch succeeds: bridge rows are deleted so transactions can be re-matched", async () => {
    // Uses cash-activity-admin page (not owner role)
    stubWorkspaceRole = "member";
    stubAllowedPages = ["cash-activity-admin"];

    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{ id: 1, status: "ACTIVE", accounting_month: "2026-08", entity_id: null }],
        rowCount: 1,
      }) // 1. group FOR UPDATE
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                                            // 2. INSERT month ON CONFLICT
      .mockResolvedValueOnce({ rows: [{ id: 9, status: "OPEN" }], rowCount: 1 })                  // 3. month FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ transaction_id: 5 }, { transaction_id: 6 }], rowCount: 2 }) // 4. bridge IDs
      .mockResolvedValueOnce({ rows: [], rowCount: 2 })                                            // 5. DELETE bridge rows
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                                            // 6. UPDATE group status
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });                                           // 7. INSERT audit log

    const res = await request(makeApp())
      .delete("/cash-activity/match/1")
      .send({ reason: "Entered wrong month" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Verify the DELETE bridge step was called (step 4)
    const deleteCall = mockDbQuery.mock.calls.find(
      (args) =>
        typeof args[0] === "string" &&
        args[0].includes("DELETE FROM cash_match_group_transactions"),
    );
    expect(deleteCall).toBeDefined();

    // Verify audit log was written with reason and 'UNMATCH' action
    const auditCall = mockDbQuery.mock.calls.find(
      (args) =>
        typeof args[0] === "string" &&
        args[0].includes("cash_activity_audit_log") &&
        args[0].includes("'UNMATCH'"),
    );
    expect(auditCall).toBeDefined();
    expect(auditCall?.[1]).toContain("Entered wrong month");
  });
});

// ===========================================================================
// POST /cash-activity/months/:yearMonth/finalize
//
// Query order inside the transaction (client.query calls via mockDbQuery):
//   1. INSERT INTO cash_activity_months ... ON CONFLICT DO NOTHING
//   2. SELECT id, status FROM cash_activity_months ... FOR UPDATE
//   3a. (parallel) SELECT COUNT open sessions
//   3b. (parallel) SELECT COUNT missing evidence
//   3c. (parallel) SELECT COUNT pending transactions
//   3d. (parallel) SELECT COUNT unmatched confirmed transactions
//   4. UPDATE cash_activity_months SET status = 'FINALIZED'
//   5. INSERT INTO cash_activity_audit_log
// ===========================================================================

describe("POST /cash-activity/months/:yearMonth/finalize", () => {
  it("returns 403 for non-admin user", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = ["cash-activity"];
    const res = await request(makeApp()).post(
      "/cash-activity/months/2026-08/finalize",
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 for invalid yearMonth format", async () => {
    const res = await request(makeApp()).post(
      "/cash-activity/months/2026-13/finalize",
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid entityId query parameter", async () => {
    const res = await request(makeApp())
      .post("/cash-activity/months/2026-08/finalize")
      .query({ entityId: "not-a-number" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/entityId/i);
  });

  it("returns 409 when open sessions exist", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                       // 1. INSERT ON CONFLICT
      .mockResolvedValueOnce({ rows: [{ id: 1, status: "OPEN" }], rowCount: 1 }) // 2. SELECT FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ count: "2" }], rowCount: 1 })         // 3a. open sessions
      .mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1 })         // 3b. missing evidence
      .mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1 })         // 3c. pending
      .mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1 });        // 3d. unmatched

    const res = await request(makeApp()).post(
      "/cash-activity/months/2026-08/finalize",
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/open session/i);
  });

  it("returns 409 when transactions are missing evidence", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: 1, status: "OPEN" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1 })  // open sessions
      .mockResolvedValueOnce({ rows: [{ count: "3" }], rowCount: 1 })  // missing evidence
      .mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1 })  // pending
      .mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1 }); // unmatched

    const res = await request(makeApp()).post(
      "/cash-activity/months/2026-08/finalize",
    );
    expect(res.status).toBe(409);
    // Missing evidence blocks finalization regardless of match status
    expect(res.body.error).toMatch(/missing.*evidence/i);
  });

  it("returns 409 when pending transactions exist", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: 1, status: "OPEN" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1 })  // open sessions
      .mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1 })  // missing evidence
      .mockResolvedValueOnce({ rows: [{ count: "5" }], rowCount: 1 })  // pending
      .mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1 }); // unmatched

    const res = await request(makeApp()).post(
      "/cash-activity/months/2026-08/finalize",
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/pending/i);
  });

  it("returns 409 when unmatched confirmed transactions exist", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: 1, status: "OPEN" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1 })  // open sessions
      .mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1 })  // missing evidence
      .mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1 })  // pending
      .mockResolvedValueOnce({ rows: [{ count: "4" }], rowCount: 1 }); // unmatched confirmed

    const res = await request(makeApp()).post(
      "/cash-activity/months/2026-08/finalize",
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/unmatched/i);
  });

  it("returns 409 when month is already finalized", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ id: 1, status: "FINALIZED" }], rowCount: 1 });

    const res = await request(makeApp()).post(
      "/cash-activity/months/2026-08/finalize",
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already finalized/i);
  });

  it("finalizes successfully when all conditions are clear", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                       // 1. INSERT ON CONFLICT
      .mockResolvedValueOnce({ rows: [{ id: 1, status: "OPEN" }], rowCount: 1 }) // 2. FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1 })         // 3a. sessions
      .mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1 })         // 3b. evidence
      .mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1 })         // 3c. pending
      .mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1 })         // 3d. unmatched
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                        // 4. UPDATE
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });                       // 5. audit log

    const res = await request(makeApp()).post(
      "/cash-activity/months/2026-08/finalize",
    );
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("FINALIZED");
  });
});

// ===========================================================================
// POST /cash-activity/months/:yearMonth/reopen
//
// Query order inside the transaction:
//   1. SELECT id, status FROM cash_activity_months ... FOR UPDATE
//   2. UPDATE cash_activity_months SET status = 'OPEN'
//   3. INSERT INTO cash_activity_audit_log
// ===========================================================================

describe("POST /cash-activity/months/:yearMonth/reopen", () => {
  it("returns 403 for non-admin user", async () => {
    stubWorkspaceRole = "member";
    const res = await request(makeApp())
      .post("/cash-activity/months/2026-08/reopen")
      .send({ reason: "mistake" });
    expect(res.status).toBe(403);
  });

  it("returns 400 when reason is missing", async () => {
    const res = await request(makeApp())
      .post("/cash-activity/months/2026-08/reopen")
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/reason/i);
  });

  it("returns 404 when month record does not exist", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // FOR UPDATE → not found
    const res = await request(makeApp())
      .post("/cash-activity/months/2026-08/reopen")
      .send({ reason: "mistake" });
    expect(res.status).toBe(404);
  });

  it("returns 409 when month is already OPEN", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ id: 1, status: "OPEN" }],
      rowCount: 1,
    });
    const res = await request(makeApp())
      .post("/cash-activity/months/2026-08/reopen")
      .send({ reason: "mistake" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already open/i);
  });

  it("reopens successfully and records reason in audit log", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [{ id: 1, status: "FINALIZED" }], rowCount: 1 }) // 1. FOR UPDATE
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                                // 2. UPDATE
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });                               // 3. audit log

    const res = await request(makeApp())
      .post("/cash-activity/months/2026-08/reopen")
      .send({ reason: "Finance manager requested recheck" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("OPEN");

    // Verify the reason is persisted in the audit log call
    const auditCall = mockDbQuery.mock.calls.find(
      (args) =>
        typeof args[0] === "string" &&
        args[0].includes("cash_activity_audit_log") &&
        args[0].includes("'REOPEN'"),
    );
    expect(auditCall).toBeDefined();
    expect(auditCall?.[1]).toContain("Finance manager requested recheck");
  });
});

// ===========================================================================
// validateMatchEligibility — unit tests (pure function)
// ===========================================================================

import { validateMatchEligibility } from "../lib/cashActivity";

describe("validateMatchEligibility (pure function)", () => {
  function twoTxns(inOverride = {}, outOverride = {}) {
    return [
      makeTxn({ id: 1, direction: "in",  amount: "100.00", ...inOverride }),
      makeTxn({ id: 2, direction: "out", amount: "100.00", ...outOverride }),
    ];
  }

  it("returns valid for a well-formed pair", () => {
    const result = validateMatchEligibility(twoTxns(), "OPEN", "2026-08");
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("reports error for FINALIZED month", () => {
    const result = validateMatchEligibility(twoTxns(), "FINALIZED", "2026-08");
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringMatching(/finalized/i)]),
    );
  });

  it("reports error when no cash-in", () => {
    const txns = [
      makeTxn({ id: 1, direction: "out", amount: "50.00" }),
      makeTxn({ id: 2, direction: "out", amount: "50.00" }),
    ];
    const result = validateMatchEligibility(txns, "OPEN", "2026-08");
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringMatching(/cash-in/i)]),
    );
  });

  it("reports error when no cash-out", () => {
    const txns = [
      makeTxn({ id: 1, direction: "in", amount: "50.00" }),
      makeTxn({ id: 2, direction: "in", amount: "50.00" }),
    ];
    const result = validateMatchEligibility(txns, "OPEN", "2026-08");
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringMatching(/cash-out/i)]),
    );
  });

  it("reports error for currency mismatch", () => {
    const txns = twoTxns({ currency: "AED" }, { currency: "USD" });
    const result = validateMatchEligibility(txns, "OPEN", "2026-08");
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringMatching(/currency/i)]),
    );
  });

  it("reports error for month mismatch", () => {
    const txns = twoTxns(
      { transaction_date: "2026-08-10T00:00:00Z" },
      { transaction_date: "2026-07-15T00:00:00Z" },
    );
    const result = validateMatchEligibility(txns, "OPEN", "2026-08");
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringMatching(/month/i)]),
    );
  });

  it("reports error for cancelled transaction", () => {
    const txns = twoTxns({}, { approval_status: "cancelled" });
    const result = validateMatchEligibility(txns, "OPEN", "2026-08");
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringMatching(/cancelled/i)]),
    );
  });

  it("reports error for reversed transaction", () => {
    const txns = twoTxns({}, { is_reversed: true });
    const result = validateMatchEligibility(txns, "OPEN", "2026-08");
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringMatching(/reversed/i)]),
    );
  });

  it("reports error when totals do not balance", () => {
    const txns = twoTxns({ amount: "100.00" }, { amount: "99.00" });
    const result = validateMatchEligibility(txns, "OPEN", "2026-08");
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringMatching(/cash-in total.*cash-out total/i)]),
    );
  });

  it("reports entity error when drawer belongs to a different entity", () => {
    // Drawers scoped to entity 5; caller requests entity 10
    const txns = twoTxns({ drawer_entity_id: 5 }, { drawer_entity_id: 5 });
    const result = validateMatchEligibility(txns, "OPEN", "2026-08", 10);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringMatching(/entity/i)]),
    );
  });

  it("passes entity validation when all drawer entities match", () => {
    const txns = twoTxns({ drawer_entity_id: 5 }, { drawer_entity_id: 5 });
    const result = validateMatchEligibility(txns, "OPEN", "2026-08", 5);
    expect(result.valid).toBe(true);
  });
});
