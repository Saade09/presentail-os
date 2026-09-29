import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

// ---------------------------------------------------------------------------
// Mocks — real pure cashDesk helpers, mocked db/auth/side-effects.
// ---------------------------------------------------------------------------

const mockDbQuery = vi.fn();
const mockClientQuery = vi.fn();
const mockRelease = vi.fn();

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
    connect: () =>
      Promise.resolve({
        query: (...args: unknown[]) => mockClientQuery(...args),
        release: mockRelease,
      }),
  },
  withTransaction: async (_client: unknown, fn: () => Promise<unknown>) => fn(),
}));

let stubUserId = "user_abc";
vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  authed: () => ({ userId: stubUserId }),
}));

let stubWorkspaceRole: "owner" | "member" = "owner";
let stubAllowedPages: string[] = [];

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = "owner_123";
    wreq.workspaceRole = stubWorkspaceRole;
    wreq.workspaceActualRole = stubWorkspaceRole;
    (wreq as unknown as { allowedPages: string[] }).allowedPages = stubAllowedPages;
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("../lib/objectStorage", () => ({
  objectStorageClient: { bucket: () => ({ file: () => ({ save: vi.fn() }) }) },
}));

vi.mock("@clerk/express", () => ({
  clerkClient: { users: { getUserList: vi.fn().mockResolvedValue({ data: [] }) } },
}));

const mockLogActivity = vi.fn();
const mockRecompute = vi.fn();

vi.mock("../lib/cashDesk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/cashDesk")>();
  return {
    ...actual,
    recomputeSessionTotals: (...args: unknown[]) => mockRecompute(...args),
    logSessionActivity: (...args: unknown[]) => mockLogActivity(...args),
  };
});

import cashSessionsRouter from "./cashSessions";

const app = express();
app.use(express.json());
app.use("/api", cashSessionsRouter);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseSession = {
  id: 7,
  workspace_owner_id: "owner_123",
  session_number: "CS-001",
  drawer_id: 1,
  location_id: null,
  currency: "USD",
  secondary_currency: null,
  status: "open",
  opening_cash: "100.00",
  reconciliation: null as unknown,
};

const lbpOnlySession = {
  ...baseSession,
  currency: "LBP",
  secondary_currency: null,
  opening_cash: "5000000.00",
  opening_cash_secondary: null,
};

const dualCurrencySession = {
  ...baseSession,
  currency: "USD",
  secondary_currency: "LBP",
  opening_cash: "100.00",
  opening_cash_secondary: "5000000.00",
};

function readyReconciliation(overrides: Record<string, unknown> = {}) {
  return {
    started_at: "2026-07-17T00:00:00.000Z",
    started_by_clerk_id: "user_abc",
    counted_at: "2026-07-17T00:05:00.000Z",
    counted_by_clerk_id: "user_abc",
    tx_count: 0,
    last_tx_id: null,
    counts: [
      {
        currency: "USD",
        expected: 100,
        actual: 100,
        variance: 0,
        explanation: null,
        requires_approval: false,
        approval: null,
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  stubUserId = "user_abc";
  stubWorkspaceRole = "owner";
  stubAllowedPages = [];
});

// ---------------------------------------------------------------------------
// POST /reconciliation/counts
// ---------------------------------------------------------------------------

describe("POST /api/cash-sessions/:id/reconciliation/counts", () => {
  it("submits blind counts, snapshots tx stats, and flags above-threshold variances", async () => {
    mockDbQuery
      // loadSession
      .mockResolvedValueOnce({ rows: [{ ...baseSession }], rowCount: 1 })
      // loadSession (refresh after recompute)
      .mockResolvedValueOnce({ rows: [{ ...baseSession }], rowCount: 1 })
      // loadSessionSummary: transactions
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      // loadSessionSummary: movements
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      // loadTxStats
      .mockResolvedValueOnce({ rows: [{ tx_count: "2", last_tx_id: 42 }], rowCount: 1 })
      // saveReconciliation
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app)
      .post("/api/cash-sessions/7/reconciliation/counts")
      .send({ counts: [{ currency: "USD", actual: 130 }] });

    expect(res.status).toBe(200);
    expect(res.body.reconciliation.tx_count).toBe(2);
    expect(res.body.reconciliation.last_tx_id).toBe(42);
    expect(res.body.reconciliation.counted_by_clerk_id).toBe("user_abc");
    // Opening cash 100 → expected 100, counted 130 → +30 variance > $10 threshold
    expect(res.body.reconciliation.counts[0]).toMatchObject({
      currency: "USD",
      expected: 100,
      actual: 130,
      variance: 30,
      requires_approval: true,
    });
    expect(res.body.reconciliation.counts[0].approval.status).toBe("pending");
    const actions = mockLogActivity.mock.calls.map((c) => c[2]);
    expect(actions).toContain("reconciliation_started");
    expect(actions).toContain("reconciliation_counts_submitted");
    expect(actions).toContain("reconciliation_approval_requested");
  });

  it("rejects when the session is not open", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ ...baseSession, status: "pending_review" }],
      rowCount: 1,
    });
    const res = await request(app)
      .post("/api/cash-sessions/7/reconciliation/counts")
      .send({ counts: [{ currency: "USD", actual: 100 }] });
    expect(res.status).toBe(409);
  });

  it("requires the close permission", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = [];
    const res = await request(app)
      .post("/api/cash-sessions/7/reconciliation/counts")
      .send({ counts: [] });
    expect(res.status).toBe(403);
  });

  it("accepts only an LBP count when the session snapshot is LBP-only", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [lbpOnlySession], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [lbpOnlySession], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ tx_count: "0", last_tx_id: null }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app)
      .post("/api/cash-sessions/7/reconciliation/counts")
      .send({ counts: [{ currency: "LBP", actual: 5_000_000 }] });

    expect(res.status).toBe(200);
    expect(res.body.reconciliation.counts).toEqual([
      expect.objectContaining({
        currency: "LBP",
        expected: 5_000_000,
        actual: 5_000_000,
        variance: 0,
      }),
    ]);
  });

  it("requires both counts for a true dual-currency session", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [dualCurrencySession], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [dualCurrencySession], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .post("/api/cash-sessions/7/reconciliation/counts")
      .send({ counts: [{ currency: "LBP", actual: 5_000_000 }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/USD/);
  });
});

// ---------------------------------------------------------------------------
// POST /reconciliation/approval
// ---------------------------------------------------------------------------

describe("POST /api/cash-sessions/:id/reconciliation/approval", () => {
  const withPendingApproval = () =>
    readyReconciliation({
      counts: [
        {
          currency: "USD",
          expected: 100,
          actual: 130,
          variance: 30,
          explanation: "bank drop miscount",
          requires_approval: true,
          approval: {
            status: "pending",
            requested_at: "2026-07-17T00:05:00.000Z",
            decided_by_clerk_id: null,
            decided_at: null,
            note: null,
          },
        },
      ],
    });

  it("blocks self-approval when the approver submitted the counts", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ ...baseSession, reconciliation: withPendingApproval() }],
      rowCount: 1,
    });
    const res = await request(app)
      .post("/api/cash-sessions/7/reconciliation/approval")
      .send({ currency: "USD", decision: "approved" });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/own/i);
  });

  it("lets a different supervisor approve", async () => {
    stubUserId = "user_supervisor";
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{ ...baseSession, reconciliation: withPendingApproval() }],
        rowCount: 1,
      })
      // saveReconciliation
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const res = await request(app)
      .post("/api/cash-sessions/7/reconciliation/approval")
      .send({ currency: "USD", decision: "approved", note: "verified drop" });
    expect(res.status).toBe(200);
    expect(res.body.reconciliation.counts[0].approval).toMatchObject({
      status: "approved",
      decided_by_clerk_id: "user_supervisor",
      note: "verified drop",
    });
    expect(mockLogActivity.mock.calls.map((c) => c[2])).toContain(
      "reconciliation_approval_approved",
    );
  });

  it("requires the approve permission", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = ["cash-sessions", "cash_sessions.close"];
    const res = await request(app)
      .post("/api/cash-sessions/7/reconciliation/approval")
      .send({ currency: "USD", decision: "approved" });
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// POST /reconcile-close
// ---------------------------------------------------------------------------

describe("POST /api/cash-sessions/:id/reconcile-close", () => {
  it("closes atomically when the reconciliation is ready and fresh", async () => {
    const rec = readyReconciliation();
    mockClientQuery
      // FOR UPDATE lock
      .mockResolvedValueOnce({ rows: [{ ...baseSession, reconciliation: rec }], rowCount: 1 })
      // pending salary approvals count (none)
      .mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1 })
      // loadTxStats (fresh: 0 / null)
      .mockResolvedValueOnce({ rows: [{ tx_count: "0", last_tx_id: null }], rowCount: 1 })
      // UPDATE ... RETURNING
      .mockResolvedValueOnce({
        rows: [{ ...baseSession, status: "pending_review", reconciliation: rec }],
        rowCount: 1,
      });
    // logSessionActivity is mocked; no more db calls expected.

    const res = await request(app)
      .post("/api/cash-sessions/7/reconcile-close")
      .send({ confirmed: true });

    expect(res.status).toBe(200);
    expect(res.body.session.status).toBe("pending_review");
    const lockSql = String(mockClientQuery.mock.calls[0][0]);
    expect(lockSql).toContain("FOR UPDATE");
    const updateSql = String(mockClientQuery.mock.calls[3][0]);
    expect(updateSql).toContain("status = 'pending_review'");
    expect(updateSql).toContain("AND status = 'open'");
    expect(mockRelease).toHaveBeenCalled();
    expect(mockLogActivity.mock.calls.map((c) => c[2])).toContain("closed");
  });

  it("requires the confirmation checkbox", async () => {
    const res = await request(app).post("/api/cash-sessions/7/reconcile-close").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/confirmed/);
  });

  it("409s when the session was closed by someone else", async () => {
    mockClientQuery.mockResolvedValueOnce({
      rows: [{ ...baseSession, status: "pending_review" }],
      rowCount: 1,
    });
    const res = await request(app)
      .post("/api/cash-sessions/7/reconcile-close")
      .send({ confirmed: true });
    expect(res.status).toBe(409);
    expect(res.body.already_closed).toBe(true);
    expect(mockRelease).toHaveBeenCalled();
  });

  it("409s with stale flag when transactions changed after counting", async () => {
    mockClientQuery
      .mockResolvedValueOnce({
        rows: [{ ...baseSession, reconciliation: readyReconciliation() }],
        rowCount: 1,
      })
      // pending salary approvals count (none)
      .mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1 })
      // loadTxStats: a new transaction appeared
      .mockResolvedValueOnce({ rows: [{ tx_count: "1", last_tx_id: 99 }], rowCount: 1 });
    const res = await request(app)
      .post("/api/cash-sessions/7/reconcile-close")
      .send({ confirmed: true });
    expect(res.status).toBe(409);
    expect(res.body.stale).toBe(true);
  });

  it("409s with blockers when a variance is unexplained or approval pending", async () => {
    const rec = readyReconciliation({
      counts: [
        {
          currency: "USD",
          expected: 100,
          actual: 90,
          variance: -10,
          explanation: null,
          requires_approval: false,
          approval: null,
        },
      ],
    });
    mockClientQuery
      .mockResolvedValueOnce({ rows: [{ ...baseSession, reconciliation: rec }], rowCount: 1 })
      // pending salary approvals count (none)
      .mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ tx_count: "0", last_tx_id: null }], rowCount: 1 });
    const res = await request(app)
      .post("/api/cash-sessions/7/reconcile-close")
      .send({ confirmed: true });
    expect(res.status).toBe(409);
    expect(res.body.blockers).toEqual([{ code: "missing_explanation", currency: "USD" }]);
  });

  it("400s when there are no submitted counts", async () => {
    mockClientQuery.mockResolvedValueOnce({
      rows: [{ ...baseSession, reconciliation: null }],
      rowCount: 1,
    });
    const res = await request(app)
      .post("/api/cash-sessions/7/reconcile-close")
      .send({ confirmed: true });
    expect(res.status).toBe(400);
  });

  it("closes an LBP-only session with only its LBP reconciliation count", async () => {
    const rec = readyReconciliation({
      counts: [
        {
          currency: "LBP",
          expected: 5_000_000,
          actual: 5_000_000,
          variance: 0,
          explanation: null,
          requires_approval: false,
          approval: null,
        },
      ],
    });
    mockClientQuery
      .mockResolvedValueOnce({
        rows: [{ ...lbpOnlySession, reconciliation: rec }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ count: "0" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ tx_count: "0", last_tx_id: null }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ ...lbpOnlySession, status: "pending_review", reconciliation: rec }],
        rowCount: 1,
      });

    const res = await request(app)
      .post("/api/cash-sessions/7/reconcile-close")
      .send({ confirmed: true });

    expect(res.status).toBe(200);
    expect(res.body.session.status).toBe("pending_review");
  });

  it("refuses to close a dual-currency session when its stored reconciliation lacks LBP", async () => {
    mockClientQuery.mockResolvedValueOnce({
      rows: [
        {
          ...dualCurrencySession,
          reconciliation: readyReconciliation(),
        },
      ],
      rowCount: 1,
    });

    const res = await request(app)
      .post("/api/cash-sessions/7/reconcile-close")
      .send({ confirmed: true });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/LBP/);
  });
});
