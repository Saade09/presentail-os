import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

// ---------------------------------------------------------------------------
// Mocks — declared before importing the module under test
// ---------------------------------------------------------------------------

const mockDbQuery = vi.fn();

vi.mock("../lib/orderWhatsappNotify", () => ({
  notifyOrderStatusWhatsApp: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/db", () => ({
  db: { query: (...args: unknown[]) => mockDbQuery(...args) },
  withTransaction: async (_client: unknown, fn: () => Promise<unknown>) => fn(),
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  authed: (req: express.Request) => req,
}));

let stubWorkspaceRole: "owner" | "member" = "owner";
let stubAllowedPages: string[] | null = null;

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = "owner_1";
    wreq.workspaceRole = stubWorkspaceRole;
    wreq.workspaceActualRole = stubWorkspaceRole;
    wreq.allowedPages = stubAllowedPages;
    wreq.userId = "user_1";
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

const mockIsTookanEnabled = vi.fn();
const mockCreateTookanStockRequestTask = vi.fn();

vi.mock("../lib/tookan", () => ({
  isTookanEnabled: (...args: unknown[]) => mockIsTookanEnabled(...args),
  createTookanStockRequestTask: (...args: unknown[]) => mockCreateTookanStockRequestTask(...args),
  createTookanReturnTask: vi.fn(),
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

import cmcPosRouter, { classifyRetryRequest, TOOKAN_RETRY_ELIGIBLE_STATUSES } from "./cmcPos";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", cmcPosRouter);
  return app;
}

const REQUEST_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function makeRow(status: string, tookan_job_id: string | null) {
  return { id: REQUEST_ID, status, tookan_job_id };
}

// ---------------------------------------------------------------------------
// classifyRetryRequest — pure-function unit tests
// ---------------------------------------------------------------------------

describe("classifyRetryRequest", () => {
  it("returns ineligible_status for draft", () => {
    expect(classifyRetryRequest(makeRow("draft", null))).toBe("ineligible_status");
  });

  it("returns ineligible_status for received", () => {
    expect(classifyRetryRequest(makeRow("received", null))).toBe("ineligible_status");
  });

  it("returns ineligible_status for cancelled", () => {
    expect(classifyRetryRequest(makeRow("cancelled", null))).toBe("ineligible_status");
  });

  it.each(TOOKAN_RETRY_ELIGIBLE_STATUSES)("returns retryable for %s with null job ID", (status) => {
    expect(classifyRetryRequest(makeRow(status, null))).toBe("retryable");
  });

  it("returns job_exists when a real job ID is present", () => {
    expect(classifyRetryRequest(makeRow("submitted", "job_12345"))).toBe("job_exists");
  });

  it("returns pending for any 'pending' sentinel regardless of age", () => {
    expect(classifyRetryRequest(makeRow("submitted", "pending"))).toBe("pending");
  });

  it.each(TOOKAN_RETRY_ELIGIBLE_STATUSES)("returns pending for %s status with pending sentinel", (status) => {
    expect(classifyRetryRequest(makeRow(status, "pending"))).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// POST /api/cmc-pos/requests/:id/retry-tookan — HTTP integration tests
// ---------------------------------------------------------------------------

describe("POST /api/cmc-pos/requests/:id/retry-tookan", () => {
  beforeEach(() => {
    stubWorkspaceRole = "owner";
    stubAllowedPages = null;
    mockDbQuery.mockReset();
    mockIsTookanEnabled.mockReset();
    mockCreateTookanStockRequestTask.mockReset();
  });

  it("returns 403 when caller has no CMC POS access at all", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = ["orders"]; // no cmc-pos page and no cmc_pos.* keys
    const app = makeApp();
    const res = await request(app).post(`/api/cmc-pos/requests/${REQUEST_ID}/retry-tookan`);
    expect(res.status).toBe(403);
    expect(mockCreateTookanStockRequestTask).not.toHaveBeenCalled();
  });

  it("allows a member with page-level CMC access (no accept_request key) to retry", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = ["cmc-pos"]; // page access implies action access
    mockIsTookanEnabled.mockReturnValue(false);
    const app = makeApp();
    const res = await request(app).post(`/api/cmc-pos/requests/${REQUEST_ID}/retry-tookan`);
    // Passes the permission gate; fails later only because Tookan is disabled.
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Tookan/);
  });

  it("returns 400 when Tookan is not enabled", async () => {
    mockIsTookanEnabled.mockReturnValue(false);
    const app = makeApp();
    const res = await request(app).post(`/api/cmc-pos/requests/${REQUEST_ID}/retry-tookan`);
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(mockCreateTookanStockRequestTask).not.toHaveBeenCalled();
  });

  it("returns 404 when request does not exist", async () => {
    mockIsTookanEnabled.mockReturnValue(true);
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const app = makeApp();
    const res = await request(app).post(`/api/cmc-pos/requests/${REQUEST_ID}/retry-tookan`);
    expect(res.status).toBe(404);
    expect(mockCreateTookanStockRequestTask).not.toHaveBeenCalled();
  });

  it("returns 409 for ineligible status (draft)", async () => {
    mockIsTookanEnabled.mockReturnValue(true);
    mockDbQuery.mockResolvedValueOnce({ rows: [makeRow("draft", null)], rowCount: 1 });
    const app = makeApp();
    const res = await request(app).post(`/api/cmc-pos/requests/${REQUEST_ID}/retry-tookan`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/draft/);
    expect(mockCreateTookanStockRequestTask).not.toHaveBeenCalled();
  });

  it("returns 409 for ineligible status (received)", async () => {
    mockIsTookanEnabled.mockReturnValue(true);
    mockDbQuery.mockResolvedValueOnce({ rows: [makeRow("received", null)], rowCount: 1 });
    const app = makeApp();
    const res = await request(app).post(`/api/cmc-pos/requests/${REQUEST_ID}/retry-tookan`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/received/);
    expect(mockCreateTookanStockRequestTask).not.toHaveBeenCalled();
  });

  it("returns 409 for ineligible status (cancelled)", async () => {
    mockIsTookanEnabled.mockReturnValue(true);
    mockDbQuery.mockResolvedValueOnce({ rows: [makeRow("cancelled", null)], rowCount: 1 });
    const app = makeApp();
    const res = await request(app).post(`/api/cmc-pos/requests/${REQUEST_ID}/retry-tookan`);
    expect(res.status).toBe(409);
    expect(mockCreateTookanStockRequestTask).not.toHaveBeenCalled();
  });

  it("returns 409 when a real Tookan job ID is already set", async () => {
    mockIsTookanEnabled.mockReturnValue(true);
    mockDbQuery.mockResolvedValueOnce({ rows: [makeRow("submitted", "job_999")], rowCount: 1 });
    const app = makeApp();
    const res = await request(app).post(`/api/cmc-pos/requests/${REQUEST_ID}/retry-tookan`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already created/);
    expect(mockCreateTookanStockRequestTask).not.toHaveBeenCalled();
  });

  it("returns 409 with pending flag when sentinel is 'pending' (any age)", async () => {
    mockIsTookanEnabled.mockReturnValue(true);
    mockDbQuery.mockResolvedValueOnce({ rows: [makeRow("submitted", "pending")], rowCount: 1 });
    const app = makeApp();
    const res = await request(app).post(`/api/cmc-pos/requests/${REQUEST_ID}/retry-tookan`);
    expect(res.status).toBe(409);
    expect(res.body.tookan_pending).toBe(true);
    // Must NEVER clear the sentinel or call Tookan — risk of duplicate delivery task
    expect(mockCreateTookanStockRequestTask).not.toHaveBeenCalled();
    const clearCall = mockDbQuery.mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("tookan_job_id = NULL"),
    );
    expect(clearCall).toBeUndefined();
  });

  it("returns 200 and job details on successful retry from null state", async () => {
    mockIsTookanEnabled.mockReturnValue(true);
    mockDbQuery.mockResolvedValueOnce({ rows: [makeRow("submitted", null)], rowCount: 1 });
    mockCreateTookanStockRequestTask.mockResolvedValue({ ok: true, jobId: "job_abc", taskId: "task_xyz" });
    const app = makeApp();
    const res = await request(app).post(`/api/cmc-pos/requests/${REQUEST_ID}/retry-tookan`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, tookan_job_id: "job_abc", tookan_task_id: "task_xyz" });
    expect(mockCreateTookanStockRequestTask).toHaveBeenCalledWith(REQUEST_ID, "owner_1");
  });

  it("propagates the actionable missing-branch-address message when pre-flight validation fails", async () => {
    mockIsTookanEnabled.mockReturnValue(true);
    mockDbQuery.mockResolvedValueOnce({ rows: [makeRow("submitted", null)], rowCount: 1 });
    mockCreateTookanStockRequestTask.mockResolvedValue({
      ok: false,
      error: "Source branch 'Warehouse' has no address — add one in Locations and retry",
    });
    const app = makeApp();
    const res = await request(app).post(`/api/cmc-pos/requests/${REQUEST_ID}/retry-tookan`);
    expect(res.status).toBe(502);
    expect(res.body.error).toBe(
      "Source branch 'Warehouse' has no address — add one in Locations and retry",
    );
  });

  it("returns 502 with the Tookan error message when creation fails", async () => {
    mockIsTookanEnabled.mockReturnValue(true);
    mockDbQuery.mockResolvedValueOnce({ rows: [makeRow("submitted", null)], rowCount: 1 });
    mockCreateTookanStockRequestTask.mockResolvedValue({ ok: false, error: "customer_phone is required" });
    const app = makeApp();
    const res = await request(app).post(`/api/cmc-pos/requests/${REQUEST_ID}/retry-tookan`);
    expect(res.status).toBe(502);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe("customer_phone is required");
  });

  it.each(TOOKAN_RETRY_ELIGIBLE_STATUSES)("works for status=%s", async (status) => {
    mockIsTookanEnabled.mockReturnValue(true);
    mockDbQuery.mockResolvedValueOnce({ rows: [makeRow(status, null)], rowCount: 1 });
    mockCreateTookanStockRequestTask.mockResolvedValue({ ok: true, jobId: "job_1", taskId: "t_1" });
    const app = makeApp();
    const res = await request(app).post(`/api/cmc-pos/requests/${REQUEST_ID}/retry-tookan`);
    expect(res.status, `expected 200 for status=${status}`).toBe(200);
  });

  it("member with cmc_pos.accept_request sub-permission is allowed", async () => {
    stubWorkspaceRole = "member";
    stubAllowedPages = ["cmc-pos", "cmc_pos.accept_request"];
    mockIsTookanEnabled.mockReturnValue(true);
    mockDbQuery.mockResolvedValueOnce({ rows: [makeRow("submitted", null)], rowCount: 1 });
    mockCreateTookanStockRequestTask.mockResolvedValue({ ok: true, jobId: "j1", taskId: "t1" });
    const app = makeApp();
    const res = await request(app).post(`/api/cmc-pos/requests/${REQUEST_ID}/retry-tookan`);
    expect(res.status).toBe(200);
  });

  it("concurrent retry: returns 502 when createTookanStockRequestTask finds slot already claimed", async () => {
    // Two concurrent retries both read null from the initial SELECT; the first wins the
    // atomic DB claim inside createTookanStockRequestTask. The second gets { ok: false }
    // because its UPDATE WHERE tookan_job_id IS NULL matches 0 rows.
    mockIsTookanEnabled.mockReturnValue(true);
    mockDbQuery.mockResolvedValueOnce({ rows: [makeRow("submitted", null)], rowCount: 1 });
    mockCreateTookanStockRequestTask.mockResolvedValue({ ok: false, error: "slot already claimed or request not found" });
    const app = makeApp();
    const res = await request(app).post(`/api/cmc-pos/requests/${REQUEST_ID}/retry-tookan`);
    expect(res.status).toBe(502);
    expect(res.body.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// POST /api/cmc-pos/requests/:id/submit — Tookan error propagation
// ---------------------------------------------------------------------------

describe("POST /api/cmc-pos/requests/:id/submit (Tookan error propagation)", () => {
  beforeEach(() => {
    stubWorkspaceRole = "owner";
    stubAllowedPages = null;
    mockDbQuery.mockReset();
    mockIsTookanEnabled.mockReset();
    mockCreateTookanStockRequestTask.mockReset();
  });

  function mockSubmitDbPath(
    overrides: { source_location_id?: number | null; destination_location_id?: number | null } = {},
  ) {
    const row = {
      id: REQUEST_ID,
      status: "draft",
      source_location_id: 20,
      destination_location_id: 10,
      ...overrides,
    };
    mockDbQuery
      .mockResolvedValueOnce({ rows: [row], rowCount: 1 }) // existing SELECT
      .mockResolvedValueOnce({ rows: [{ id: REQUEST_ID, status: "submitted" }], rowCount: 1 }) // compare-and-set UPDATE
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // event INSERT
  }

  it("returns 400 with an actionable error when submitting without a source branch", async () => {
    mockIsTookanEnabled.mockReturnValue(true);
    mockSubmitDbPath({ source_location_id: null });
    const app = makeApp();
    const res = await request(app).post(`/api/cmc-pos/requests/${REQUEST_ID}/submit`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/source branch is required/i);
    // No status change and no Tookan call happened
    expect(mockCreateTookanStockRequestTask).not.toHaveBeenCalled();
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
  });

  it("returns 400 with an actionable error when submitting without a destination branch", async () => {
    mockIsTookanEnabled.mockReturnValue(true);
    mockSubmitDbPath({ destination_location_id: null });
    const app = makeApp();
    const res = await request(app).post(`/api/cmc-pos/requests/${REQUEST_ID}/submit`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/destination branch is required/i);
    expect(mockCreateTookanStockRequestTask).not.toHaveBeenCalled();
  });

  it("returns the actionable Tookan error in the response body when task creation fails", async () => {
    mockIsTookanEnabled.mockReturnValue(true);
    mockSubmitDbPath();
    mockCreateTookanStockRequestTask.mockResolvedValue({
      ok: false,
      error: "Destination branch 'Branch A' has no address — add one in Locations and retry",
    });
    const app = makeApp();
    const res = await request(app).post(`/api/cmc-pos/requests/${REQUEST_ID}/submit`);
    expect(res.status).toBe(200);
    expect(res.body.request.status).toBe("submitted");
    expect(res.body.tookan_error).toBe(
      "Destination branch 'Branch A' has no address — add one in Locations and retry",
    );
    expect(mockCreateTookanStockRequestTask).toHaveBeenCalledWith(REQUEST_ID, "owner_1");
  });

  it("returns no tookan_error when task creation succeeds", async () => {
    mockIsTookanEnabled.mockReturnValue(true);
    mockSubmitDbPath();
    mockCreateTookanStockRequestTask.mockResolvedValue({ ok: true, jobId: "j1", taskId: "t1" });
    const app = makeApp();
    const res = await request(app).post(`/api/cmc-pos/requests/${REQUEST_ID}/submit`);
    expect(res.status).toBe(200);
    expect(res.body.tookan_error).toBeUndefined();
  });

  it("does not call Tookan when the integration is disabled", async () => {
    mockIsTookanEnabled.mockReturnValue(false);
    mockSubmitDbPath();
    const app = makeApp();
    const res = await request(app).post(`/api/cmc-pos/requests/${REQUEST_ID}/submit`);
    expect(res.status).toBe(200);
    expect(res.body.tookan_error).toBeUndefined();
    expect(mockCreateTookanStockRequestTask).not.toHaveBeenCalled();
  });
});
