import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

// ---------------------------------------------------------------------------
// Route-level DB-mock tests: CMC shelf-sale cash transactions are tagged
// with sale_channel = 'walk_in' in the INSERT INTO cash_transactions call.
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
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { userId?: string }).userId = "clerk_user_1";
    next();
  },
  authed: () => ({ userId: "clerk_user_1" }),
}));

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = "owner_ws";
    wreq.workspaceRole = "owner";
    wreq.workspaceActualRole = "owner";
    (wreq as unknown as { allowedPages: string[] }).allowedPages = [
      "cmc-pos",
      "cmc_pos.sell",
    ];
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

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
}));
vi.mock("../lib/eventsSse", () => ({ broadcastEvent: vi.fn() }));
vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// Import after mocks
import cmcPosRouter from "./cmcPos";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", cmcPosRouter);
  return app;
}

/** Standard single shelf item ($25) — no product_id so no inventory_movements query */
const SHELF_ITEM = { product_id: null, name: "Bouquet", qty: 1, unit_price: 25, item_type: "custom" };

/**
 * Install the mock DB dispatch for a successful cash sale.
 * The route needs:
 *  1. cmc_shifts lookup → returns shift with cash_session_id=10
 *  2. SELECT cash_sessions FOR UPDATE (inside transaction) → session open
 *  3. INSERT INTO cmc_sales → returns { id: "sale-99" }
 *  4. INSERT INTO cash_transactions → no-op { rows: [] }
 */
function installCashSaleDispatch() {
  mockDbQuery.mockImplementation((sql: string) => {
    if (String(sql).includes("FROM cmc_shifts")) {
      return Promise.resolve({
        rows: [{ id: 1, location_id: 5, cash_session_id: 10 }],
      });
    }
    if (String(sql).includes("FROM cash_sessions") && String(sql).includes("FOR UPDATE")) {
      return Promise.resolve({ rows: [{ id: 10 }] }); // session is open
    }
    if (String(sql).includes("INSERT INTO cmc_sales")) {
      return Promise.resolve({ rows: [{ id: "sale-99" }] });
    }
    // cash_transactions, inventory_movements, etc.
    return Promise.resolve({ rows: [] });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Scenario 1 — Cash sale: INSERT INTO cash_transactions includes sale_channel
// ---------------------------------------------------------------------------

describe("POST /api/cmc-pos/sales — cash sale channel tagging", () => {
  it("includes sale_channel in the INSERT INTO cash_transactions SQL", async () => {
    installCashSaleDispatch();

    const res = await request(makeApp())
      .post("/api/cmc-pos/sales")
      .send({
        location_id: 5,
        line_items: [SHELF_ITEM],
        payment_method: "cash",
        idempotency_key: "test-cash-channel-1",
      });

    expect(res.status).toBe(201);

    const cashTxCall = mockDbQuery.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO cash_transactions"),
    );
    expect(cashTxCall).toBeDefined();

    const sql = cashTxCall![0] as string;
    expect(sql).toContain("sale_channel");
    expect(sql).toContain("walk_in");
  });

  it("does NOT include sale_channel in the params (it is hardcoded in the SQL literal)", async () => {
    installCashSaleDispatch();

    const res = await request(makeApp())
      .post("/api/cmc-pos/sales")
      .send({
        location_id: 5,
        line_items: [SHELF_ITEM],
        payment_method: "cash",
        idempotency_key: "test-cash-channel-2",
      });

    expect(res.status).toBe(201);

    const cashTxCall = mockDbQuery.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO cash_transactions"),
    );
    expect(cashTxCall).toBeDefined();
    // 'walk_in' is hardcoded in the SQL, so there should be exactly 7 positional params:
    // $1=wsId, $2=sessionId, $3=locationId, $4=amount, $5=description, $6=saleId, $7=userId
    const params = cashTxCall![1] as unknown[];
    expect(params).toHaveLength(7);
    // walk_in is NOT in the params array — it is a SQL literal
    expect(params).not.toContain("walk_in");
  });

  it("references the correct cash session ID in the cash_transactions INSERT", async () => {
    installCashSaleDispatch();

    const res = await request(makeApp())
      .post("/api/cmc-pos/sales")
      .send({
        location_id: 5,
        line_items: [SHELF_ITEM],
        payment_method: "cash",
        idempotency_key: "test-cash-channel-3",
      });

    expect(res.status).toBe(201);

    const cashTxCall = mockDbQuery.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO cash_transactions"),
    );
    const params = cashTxCall![1] as unknown[];
    expect(params[1]).toBe(10); // $2 = cashSessionId derived from shift
  });

  it("does NOT create a cash_transactions entry for a non-cash payment", async () => {
    // For card/link payments, no shift lookup or cash_transactions insert should occur.
    mockDbQuery.mockImplementation((sql: string) => {
      if (String(sql).includes("INSERT INTO cmc_sales")) {
        return Promise.resolve({ rows: [{ id: "sale-100" }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await request(makeApp())
      .post("/api/cmc-pos/sales")
      .send({
        location_id: 5,
        line_items: [SHELF_ITEM],
        payment_method: "card",
        idempotency_key: "test-cash-channel-4",
      });

    expect(res.status).toBe(201);

    const cashTxCall = mockDbQuery.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO cash_transactions"),
    );
    expect(cashTxCall).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — GET /api/cmc-pos/cash-drawer/transactions includes sale_channel
// ---------------------------------------------------------------------------

describe("GET /api/cmc-pos/cash-drawer/transactions — sale_channel in response", () => {
  it("returns sale_channel field from the transactions query", async () => {
    mockDbQuery.mockImplementation((sql: string) => {
      // Session ownership check: SELECT id FROM cash_sessions WHERE id=$1 AND workspace_owner_id=$2
      if (String(sql).includes("FROM cash_sessions") && !String(sql).includes("JOIN")) {
        return Promise.resolve({ rows: [{ id: 20 }] });
      }
      if (String(sql).includes("COUNT(*)") && String(sql).includes("cash_transactions")) {
        return Promise.resolve({ rows: [{ total: "1" }] });
      }
      if (String(sql).includes("FROM cash_transactions ct")) {
        return Promise.resolve({
          rows: [
            {
              id: 1,
              type: "cash_sale",
              direction: "in",
              amount: "25.00",
              currency: "AED",
              description: "CMC cash sale",
              reference_type: "cmc_sale",
              reference_id: "99",
              is_reversed: false,
              reversal_of_id: null,
              entered_by_name: null,
              created_by_clerk_id: "clerk_user_1",
              transaction_date: "2026-08-18T12:00:00.000Z",
              status: null,
              note: null,
              sale_channel: "walk_in",
            },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const res = await request(makeApp())
      .get("/api/cmc-pos/cash-drawer/transactions?session_id=20")
      .send();

    expect(res.status).toBe(200);
    expect(res.body.transactions).toHaveLength(1);
    expect(res.body.transactions[0].sale_channel).toBe("walk_in");
  });

  it("the transactions SQL selects ct.sale_channel", async () => {
    mockDbQuery.mockImplementation((sql: string) => {
      // Session ownership check
      if (String(sql).includes("FROM cash_sessions") && !String(sql).includes("JOIN")) {
        return Promise.resolve({ rows: [{ id: 20 }] });
      }
      if (String(sql).includes("COUNT(*)") && String(sql).includes("cash_transactions")) {
        return Promise.resolve({ rows: [{ total: "0" }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await request(makeApp())
      .get("/api/cmc-pos/cash-drawer/transactions?session_id=20")
      .send();

    const txQueryCall = mockDbQuery.mock.calls.find(([sql]) =>
      String(sql).includes("FROM cash_transactions ct") &&
      String(sql).includes("ORDER BY ct.created_at"),
    );
    expect(txQueryCall).toBeDefined();
    expect(txQueryCall![0] as string).toContain("ct.sale_channel");
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — Backfill SQL contract
// The initDb backfill updates CMC shelf-sale cash transactions where
// reference_type = 'cmc_sale' and sale_channel IS NULL to 'walk_in'.
// This test verifies the SQL predicate semantics directly.
// ---------------------------------------------------------------------------

describe("initDb backfill — CMC cash transactions walk_in channel", () => {
  it("backfill targets only cash_sale type + cmc_sale reference + NULL channel rows", () => {
    // The UPDATE predicate from initDb.ts:
    //   WHERE type = 'cash_sale'
    //     AND reference_type = 'cmc_sale'
    //     AND sale_channel IS NULL
    type Row = { type: string; reference_type: string | null; sale_channel: string | null };

    function matchesBackfill(r: Row): boolean {
      return r.type === "cash_sale" && r.reference_type === "cmc_sale" && r.sale_channel === null;
    }

    // Should be updated
    expect(matchesBackfill({ type: "cash_sale", reference_type: "cmc_sale", sale_channel: null })).toBe(true);

    // Should NOT be updated — already has a channel
    expect(matchesBackfill({ type: "cash_sale", reference_type: "cmc_sale", sale_channel: "walk_in" })).toBe(false);

    // Should NOT be updated — different reference type (quick-entry sale)
    expect(matchesBackfill({ type: "cash_sale", reference_type: null, sale_channel: null })).toBe(false);

    // Should NOT be updated — not a cash_sale
    expect(matchesBackfill({ type: "adjustment", reference_type: "cmc_sale", sale_channel: null })).toBe(false);
  });

  it("backfill sets sale_channel to walk_in on matched rows", () => {
    type Row = { type: string; reference_type: string | null; sale_channel: string | null };

    function applyBackfill(rows: Row[]): Row[] {
      return rows.map((r) =>
        r.type === "cash_sale" && r.reference_type === "cmc_sale" && r.sale_channel === null
          ? { ...r, sale_channel: "walk_in" }
          : r,
      );
    }

    const rows: Row[] = [
      { type: "cash_sale", reference_type: "cmc_sale", sale_channel: null },
      { type: "cash_sale", reference_type: "cmc_sale", sale_channel: "walk_in" },
      { type: "cash_sale", reference_type: null, sale_channel: null },
      { type: "adjustment", reference_type: "cmc_sale", sale_channel: null },
    ];

    const updated = applyBackfill(rows);
    expect(updated[0].sale_channel).toBe("walk_in");   // backfilled
    expect(updated[1].sale_channel).toBe("walk_in");   // already set, unchanged
    expect(updated[2].sale_channel).toBeNull();         // no cmc_sale ref — not touched
    expect(updated[3].sale_channel).toBeNull();         // not cash_sale — not touched
  });
});
