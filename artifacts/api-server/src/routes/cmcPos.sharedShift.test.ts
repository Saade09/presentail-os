import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

// ---------------------------------------------------------------------------
// Task: shelf sales must be allowed against the LOCATION'S open shift/session
// regardless of who opened it, while still attributing the sale to the actual
// seller. These tests mount the real cmcPos router with a mocked db.
// ---------------------------------------------------------------------------

// The user making requests (NOT the shift opener)
let currentUserId = "user_seller";

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
let stubAllowedPages: string[] = ["cmc-pos", "cmc_pos.sell"];

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

// Side-effect modules imported by cmcPos.ts — all mocked (per repo pattern:
// every order/sale side effect must be mocked or db-call assertions break).
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
vi.mock("../lib/cashDesk", () => ({
  generateSessionNumber: vi.fn(),
  logSessionActivity: vi.fn(),
  recomputeSessionTotals: vi.fn(),
  recordCashTransaction: vi.fn(),
  computeShiftOverdue: vi.fn(() => ({ isOverdue: false, overdueAt: null })),
}));
const mockBroadcastEvent = vi.fn();
vi.mock("../lib/eventsSse", () => ({
  broadcastEvent: (...args: unknown[]) => mockBroadcastEvent(...args),
}));

import cmcPosRouter from "./cmcPos";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", cmcPosRouter);
  return app;
}

// A shift opened by ANOTHER user at location 5, with a linked cash session
const OTHER_USERS_SHIFT = {
  id: 77,
  location_id: 5,
  cash_session_id: 900,
  opened_by_user_id: "user_opener",
  status: "open",
};

const SALE_PAYLOAD = {
  location_id: 5,
  shift_id: null,
  line_items: [
    { product_id: 1, name: "Roses", qty: 2, unit_price: 10, item_type: "shelf" },
  ],
  payment_method: "cash",
  idempotency_key: "idem-1",
};

/** Dispatch db.query mocks by SQL substring. */
function installDbDispatch(overrides: { shiftRows?: unknown[] } = {}) {
  mockDbQuery.mockImplementation((sql: string) => {
    if (sql.includes("FROM cmc_shifts")) {
      return Promise.resolve({ rows: overrides.shiftRows ?? [OTHER_USERS_SHIFT] });
    }
    if (sql.includes("FROM cash_sessions") && sql.includes("FOR UPDATE")) {
      return Promise.resolve({ rows: [{ id: 900 }] });
    }
    if (sql.includes("INSERT INTO cmc_sales")) {
      return Promise.resolve({ rows: [{ id: 501, total: "20.0000" }] });
    }
    return Promise.resolve({ rows: [] });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  currentUserId = "user_seller";
  stubWorkspaceRole = "member";
  stubAllowedPages = ["cmc-pos", "cmc_pos.sell"];
});

// ---------------------------------------------------------------------------
// GET /cmc-pos/shifts/active — location-scoped, not opener-scoped
// ---------------------------------------------------------------------------

describe("GET /api/cmc-pos/shifts/active", () => {
  it("returns an open shift even when it was opened by another user", async () => {
    installDbDispatch();
    const res = await request(makeApp()).get("/api/cmc-pos/shifts/active");
    expect(res.status).toBe(200);
    expect(res.body.shift).toMatchObject({ id: 77, opened_by_user_id: "user_opener" });
    const [sql, params] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toContain("opened_by_user_id =");
    expect(params).toEqual(["owner_ws"]);
  });

  it("filters by location_id when provided", async () => {
    installDbDispatch();
    const res = await request(makeApp()).get("/api/cmc-pos/shifts/active?location_id=5");
    expect(res.status).toBe(200);
    const [sql, params] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("s.location_id = $2");
    expect(params).toEqual(["owner_ws", 5]);
  });

  it("rejects a non-numeric location_id", async () => {
    installDbDispatch();
    const res = await request(makeApp()).get("/api/cmc-pos/shifts/active?location_id=abc");
    expect(res.status).toBe(400);
  });

  it("returns null when no shift is open", async () => {
    installDbDispatch({ shiftRows: [] });
    const res = await request(makeApp()).get("/api/cmc-pos/shifts/active");
    expect(res.status).toBe(200);
    expect(res.body.shift).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// POST /cmc-pos/sales — cash sale allowed on another user's open shift
// ---------------------------------------------------------------------------

describe("POST /api/cmc-pos/sales — shared open shift", () => {
  it("accepts a cash sale when the location's open shift was opened by another user", async () => {
    installDbDispatch();
    const res = await request(makeApp()).post("/api/cmc-pos/sales").send(SALE_PAYLOAD);
    expect(res.status).toBe(201);
    expect(res.body.sale.id).toBe(501);

    // Shift lookup must be by workspace + location, never by the caller
    const shiftCall = mockDbQuery.mock.calls.find(([sql]) => (sql as string).includes("FROM cmc_shifts"))!;
    expect(shiftCall[0]).toContain("location_id");
    expect(shiftCall[0]).not.toContain("opened_by_user_id");
    expect(shiftCall[1]).toEqual(["owner_ws", 5]);
  });

  it("attributes the sale and cash ledger entry to the actual seller, not the shift opener", async () => {
    installDbDispatch();
    const res = await request(makeApp()).post("/api/cmc-pos/sales").send(SALE_PAYLOAD);
    expect(res.status).toBe(201);

    const saleInsert = mockDbQuery.mock.calls.find(([sql]) =>
      (sql as string).includes("INSERT INTO cmc_sales"),
    )!;
    // params: ws, shift_id, location_id, created_by_user_id, ...
    expect((saleInsert[1] as unknown[])[1]).toBe(77); // linked to the shared shift
    expect((saleInsert[1] as unknown[])[3]).toBe("user_seller");

    const ledgerInsert = mockDbQuery.mock.calls.find(([sql]) =>
      (sql as string).includes("INSERT INTO cash_transactions"),
    )!;
    const ledgerParams = ledgerInsert[1] as unknown[];
    expect(ledgerParams[1]).toBe(900); // the shared shift's cash session
    expect(ledgerParams[ledgerParams.length - 1]).toBe("user_seller"); // created_by_clerk_id
  });

  it("returns 422 NO_ACTIVE_CASH_SESSION when the location has no open shift", async () => {
    installDbDispatch({ shiftRows: [] });
    const res = await request(makeApp()).post("/api/cmc-pos/sales").send(SALE_PAYLOAD);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("NO_ACTIVE_CASH_SESSION");
  });

  it("accepts a matching client-provided shift_id and rejects a stale one", async () => {
    installDbDispatch();
    const ok = await request(makeApp())
      .post("/api/cmc-pos/sales")
      .send({ ...SALE_PAYLOAD, shift_id: 77, idempotency_key: "idem-2" });
    expect(ok.status).toBe(201);

    installDbDispatch();
    const stale = await request(makeApp())
      .post("/api/cmc-pos/sales")
      .send({ ...SALE_PAYLOAD, shift_id: 12, idempotency_key: "idem-3" });
    expect(stale.status).toBe(403);
    expect(stale.body.code).toBe("SHIFT_OWNERSHIP");
  });

  it("does not require any shift for non-cash sales", async () => {
    installDbDispatch({ shiftRows: [] });
    const res = await request(makeApp())
      .post("/api/cmc-pos/sales")
      .send({ ...SALE_PAYLOAD, payment_method: "card", idempotency_key: "idem-4" });
    expect(res.status).toBe(201);
  });
});
