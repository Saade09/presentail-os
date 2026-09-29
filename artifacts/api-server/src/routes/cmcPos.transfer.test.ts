import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

// ---------------------------------------------------------------------------
// Task: Send Cash must act on the LOCATION'S open shift/session (the one the
// page displays), regardless of who opened it — not the caller's own shift.
// These tests mount the real cmcPos router with a mocked db.
// ---------------------------------------------------------------------------

let currentUserId = "user_sender";

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
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { userId?: string }).userId = currentUserId;
    next();
  },
  authed: () => ({ userId: currentUserId }),
}));

let stubWorkspaceRole: "owner" | "member" = "member";
let stubAllowedPages: string[] = ["cmc-pos", "cmc_pos.cash_drawer"];

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = "owner_ws";
    wreq.workspaceRole = stubWorkspaceRole;
    wreq.workspaceActualRole = stubWorkspaceRole;
    (wreq as unknown as { allowedPages: string[] }).allowedPages = stubAllowedPages;
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

// Side-effect modules imported by cmcPos.ts — all mocked (per repo pattern).
vi.mock("../lib/orderCreate", () => ({ createManualOrder: vi.fn() }));
vi.mock("../lib/cmcOrderNumber", () => ({ generateCmcOrderNumber: vi.fn() }));
vi.mock("../lib/cmcReturnReference", () => ({ generateReturnReference: vi.fn() }));
vi.mock("../lib/objectStorage", () => ({ objectStorageClient: { bucket: vi.fn() } }));
vi.mock("../lib/cmcMonthlySales", () => ({
  computeMonthlySales: vi.fn(),
  resolveMonthBounds: vi.fn(),
}));
vi.mock("../lib/cmcMonthlySalesPdf", () => ({
  generateCmcCommissionSummaryPdf: vi.fn(),
  generateCmcCommissionStatementPdf: vi.fn(),
}));
vi.mock("../lib/tookan", () => ({
  isTookanEnabled: () => false,
  createTookanStockRequestTask: vi.fn(),
  createTookanReturnTask: vi.fn(),
}));
vi.mock("../lib/inventoryService", () => ({ postMovement: vi.fn() }));
const mockRecompute = vi.fn();
vi.mock("../lib/cashDesk", () => ({
  generateSessionNumber: vi.fn(),
  logSessionActivity: vi.fn(),
  recomputeSessionTotals: (...args: unknown[]) => mockRecompute(...args),
  recordCashTransaction: vi.fn(),
}));
vi.mock("../lib/eventsSse", () => ({ broadcastEvent: vi.fn() }));

import cmcPosRouter from "./cmcPos";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", cmcPosRouter);
  return app;
}

// Shift opened by ANOTHER user at location 5, with a linked cash session
const OTHER_USERS_SHIFT = {
  id: 77,
  location_id: 5,
  cash_session_id: 900,
  opened_by_user_id: "user_opener",
  status: "open",
};

const SOURCE_SESSION = {
  id: 900,
  drawer_id: 10,
  location_id: 5,
  currency: "USD",
  status: "open",
  expected_cash: "500.00",
};

const TRANSFER_PAYLOAD = {
  amount: 100,
  destination_location_id: 8,
  source_location_id: 5,
  note: "test transfer",
};

/** Dispatch db.query mocks by SQL substring. */
function installDbDispatch(overrides: {
  shiftRows?: unknown[];
  sourceRows?: unknown[];
} = {}) {
  mockDbQuery.mockImplementation((sql: string) => {
    if (sql.includes("FROM cmc_shifts")) {
      return Promise.resolve({ rows: overrides.shiftRows ?? [OTHER_USERS_SHIFT] });
    }
    if (sql.includes("FROM cash_sessions") && sql.includes("expected_cash")) {
      return Promise.resolve({ rows: overrides.sourceRows ?? [SOURCE_SESSION] });
    }
    if (sql.includes("FROM cash_drawers")) {
      return Promise.resolve({ rows: [{ id: 20 }] });
    }
    if (sql.includes("FROM cash_sessions") && sql.includes("drawer_id")) {
      return Promise.resolve({ rows: [{ id: 901, status: "open" }] });
    }
    return Promise.resolve({ rows: [] });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  currentUserId = "user_sender";
  stubWorkspaceRole = "member";
  stubAllowedPages = ["cmc-pos", "cmc_pos.cash_drawer"];
});

describe("POST /api/cmc-pos/cash-drawer/transfer — shared shift resolution", () => {
  it("succeeds when the location's open shift was opened by another user", async () => {
    installDbDispatch();
    const res = await request(makeApp())
      .post("/api/cmc-pos/cash-drawer/transfer")
      .send(TRANSFER_PAYLOAD);
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);

    // Shift lookup must be workspace + location scoped, never opener scoped
    const shiftCall = mockDbQuery.mock.calls.find(([sql]) =>
      (sql as string).includes("FROM cmc_shifts"),
    )!;
    expect(shiftCall[0]).not.toContain("opened_by_user_id");
    expect(shiftCall[0]).toContain("location_id");
    expect(shiftCall[1]).toEqual(["owner_ws", 5]);
  });

  it("records the transfer against the displayed session and attributes it to the caller", async () => {
    installDbDispatch();
    const res = await request(makeApp())
      .post("/api/cmc-pos/cash-drawer/transfer")
      .send(TRANSFER_PAYLOAD);
    expect(res.status).toBe(201);

    const outInsert = mockDbQuery.mock.calls.find(([sql]) =>
      (sql as string).includes("'transfer_out'"),
    )!;
    const outParams = outInsert[1] as unknown[];
    expect(outParams[1]).toBe(900); // the location's session, not the caller's
    expect(outParams[outParams.length - 1]).toBe("user_sender");
  });

  it("resolves workspace-wide when no source_location_id is passed", async () => {
    installDbDispatch();
    const { source_location_id: _omit, ...payload } = TRANSFER_PAYLOAD;
    const res = await request(makeApp())
      .post("/api/cmc-pos/cash-drawer/transfer")
      .send(payload);
    expect(res.status).toBe(201);
    const shiftCall = mockDbQuery.mock.calls.find(([sql]) =>
      (sql as string).includes("FROM cmc_shifts"),
    )!;
    expect(shiftCall[1]).toEqual(["owner_ws"]);
  });

  it("fails with a location-specific error when no shift is open at the location", async () => {
    installDbDispatch({ shiftRows: [] });
    const res = await request(makeApp())
      .post("/api/cmc-pos/cash-drawer/transfer")
      .send(TRANSFER_PAYLOAD);
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/No open CMC shift at this location/i);
  });

  it("fails clearly when no shift is open anywhere (no location passed)", async () => {
    installDbDispatch({ shiftRows: [] });
    const { source_location_id: _omit, ...payload } = TRANSFER_PAYLOAD;
    const res = await request(makeApp())
      .post("/api/cmc-pos/cash-drawer/transfer")
      .send(payload);
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/No open CMC shift/i);
  });

  it("fails with a distinct error when the open shift has no linked cash session", async () => {
    installDbDispatch({ shiftRows: [{ ...OTHER_USERS_SHIFT, cash_session_id: null }] });
    const res = await request(makeApp())
      .post("/api/cmc-pos/cash-drawer/transfer")
      .send(TRANSFER_PAYLOAD);
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/no linked cash session/i);
  });

  it("fails with a refresh hint when the session closed in a race", async () => {
    installDbDispatch({ sourceRows: [{ ...SOURCE_SESSION, status: "closed" }] });
    const res = await request(makeApp())
      .post("/api/cmc-pos/cash-drawer/transfer")
      .send(TRANSFER_PAYLOAD);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/closed.*refresh/i);
  });

  it("rejects a non-numeric source_location_id", async () => {
    installDbDispatch();
    const res = await request(makeApp())
      .post("/api/cmc-pos/cash-drawer/transfer")
      .send({ ...TRANSFER_PAYLOAD, source_location_id: "abc" });
    expect(res.status).toBe(400);
  });

  it("still rejects transfers exceeding the available balance", async () => {
    installDbDispatch();
    const res = await request(makeApp())
      .post("/api/cmc-pos/cash-drawer/transfer")
      .send({ ...TRANSFER_PAYLOAD, amount: 10000 });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/exceeds available balance/i);
  });

  it("requires the cmc_pos.cash_drawer permission", async () => {
    installDbDispatch();
    stubAllowedPages = ["cmc-pos"];
    const res = await request(makeApp())
      .post("/api/cmc-pos/cash-drawer/transfer")
      .send(TRANSFER_PAYLOAD);
    expect(res.status).toBe(403);
  });
});
