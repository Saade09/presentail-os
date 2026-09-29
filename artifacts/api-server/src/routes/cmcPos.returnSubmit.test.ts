/**
 * Route-level test: POST /api/cmc-pos/returns/:id/submit must fire the
 * fire-and-forget Tookan return task (createTookanReturnTask) when Tookan is
 * enabled, and must NOT fire it when Tookan is disabled.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

// ---------------------------------------------------------------------------
// Mocks — declared before importing the module under test
// ---------------------------------------------------------------------------

const mockDbQuery = vi.fn();
const mockClientQuery = vi.fn();

vi.mock("../lib/orderWhatsappNotify", () => ({
  notifyOrderStatusWhatsApp: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
    connect: async () => ({
      query: (...args: unknown[]) => mockClientQuery(...args),
      release: vi.fn(),
    }),
  },
  withTransaction: async (_client: unknown, fn: () => Promise<unknown>) => fn(),
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  authed: (req: express.Request) => req,
}));

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = "owner_1";
    wreq.workspaceRole = "owner";
    wreq.workspaceActualRole = "owner";
    wreq.allowedPages = null;
    wreq.userId = "user_1";
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

const mockIsTookanEnabled = vi.fn();
const mockCreateTookanReturnTask = vi.fn();

vi.mock("../lib/tookan", () => ({
  isTookanEnabled: (...args: unknown[]) => mockIsTookanEnabled(...args),
  createTookanStockRequestTask: vi.fn(),
  createTookanReturnTask: (...args: unknown[]) => mockCreateTookanReturnTask(...args),
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock("../lib/objectStorage", () => ({
  objectStorageClient: { bucket: vi.fn(() => ({ file: vi.fn(() => ({ save: vi.fn() })) })) },
}));

vi.mock("../lib/orderCreate", () => ({ createManualOrder: vi.fn() }));
vi.mock("../lib/cmcOrderNumber", () => ({ generateCmcOrderNumber: vi.fn() }));
vi.mock("../lib/cmcReturnReference", () => ({ generateReturnReference: vi.fn() }));
vi.mock("../lib/cmcMonthlySales", () => ({
  computeMonthlySales: vi.fn(),
  resolveMonthBounds: vi.fn(),
}));
vi.mock("../lib/cmcMonthlySalesPdf", () => ({
  generateCmcCommissionSummaryPdf: vi.fn(),
  generateCmcCommissionStatementPdf: vi.fn(),
}));
vi.mock("../lib/inventoryService", () => ({ postMovement: vi.fn() }));
vi.mock("../lib/cashDesk", () => ({
  generateSessionNumber: vi.fn(),
  logSessionActivity: vi.fn(),
  recomputeSessionTotals: vi.fn(),
}));
vi.mock("../lib/eventsSse", () => ({ broadcastEvent: vi.fn() }));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import cmcPosRouter from "./cmcPos";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: Record<string, unknown> }).log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    next();
  });
  app.use("/api", cmcPosRouter);
  return app;
}

const RETURN_ID = "11111111-2222-3333-4444-555555555555";

function setupSubmitMocks() {
  const draftRow = {
    id: RETURN_ID,
    workspace_owner_id: "owner_1",
    status: "draft",
    reference: "RET-TEST-001",
    branch_location_id: 7,
    return_to_location_id: 42,
    collection_date: "2026-08-13",
  };
  mockDbQuery
    // 1) Load the return
    .mockResolvedValueOnce({ rows: [draftRow], rowCount: 1 })
    // 2) Load line items (empty — skips stock validation/deduction)
    .mockResolvedValueOnce({ rows: [], rowCount: 0 })
    // 3) Final detail SELECT after submit
    .mockResolvedValueOnce({
      rows: [{ ...draftRow, status: "awaiting_pickup", line_items: [], events: [] }],
      rowCount: 1,
    });
  mockClientQuery
    // a) UPDATE cmc_returns → awaiting_pickup
    .mockResolvedValueOnce({ rows: [{ ...draftRow, status: "awaiting_pickup" }], rowCount: 1 })
    // b) INSERT audit event
    .mockResolvedValueOnce({ rows: [], rowCount: 1 });
}

describe("POST /api/cmc-pos/returns/:id/submit — Tookan task creation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fires createTookanReturnTask with the return id and workspace when Tookan is enabled", async () => {
    setupSubmitMocks();
    mockIsTookanEnabled.mockReturnValue(true);

    const res = await request(makeApp()).post(`/api/cmc-pos/returns/${RETURN_ID}/submit`);

    expect(res.status).toBe(200);
    expect(res.body.return.status).toBe("awaiting_pickup");
    expect(mockCreateTookanReturnTask).toHaveBeenCalledWith(RETURN_ID, "owner_1");
  });

  it("does not fire createTookanReturnTask when Tookan is disabled", async () => {
    setupSubmitMocks();
    mockIsTookanEnabled.mockReturnValue(false);

    const res = await request(makeApp()).post(`/api/cmc-pos/returns/${RETURN_ID}/submit`);

    expect(res.status).toBe(200);
    expect(mockCreateTookanReturnTask).not.toHaveBeenCalled();
  });
});
