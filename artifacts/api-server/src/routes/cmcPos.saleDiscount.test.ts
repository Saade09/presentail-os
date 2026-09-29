import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

// ---------------------------------------------------------------------------
// Task: shelf-sale discount on the COMBINED total (shelf + custom) as either
// a percentage or a fixed amount, with an optional description. The legacy
// amount-only shelf-subtotal discount must keep working unchanged.
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
    (req as express.Request & { userId?: string }).userId = "user_seller";
    next();
  },
  authed: () => ({ userId: "user_seller" }),
}));

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = "owner_ws";
    wreq.workspaceRole = "owner";
    wreq.workspaceActualRole = "owner";
    (wreq as unknown as { allowedPages: string[] }).allowedPages = ["cmc-pos", "cmc_pos.sell", "cmc_pos.edit"];
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
vi.mock("../lib/cashDesk", () => ({
  generateSessionNumber: vi.fn(),
  logSessionActivity: vi.fn(),
  recomputeSessionTotals: vi.fn(),
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

// Non-cash payload avoids the cash-shift gate; shelf 2×$10 + custom 1×$30 = $50
const BASE_PAYLOAD = {
  location_id: 5,
  shift_id: null,
  line_items: [
    { product_id: 1, name: "Roses", qty: 2, unit_price: 10, item_type: "shelf" },
    { product_id: null, name: "Custom Bouquet", qty: 1, unit_price: 30, item_type: "custom" },
  ],
  payment_method: "card",
  idempotency_key: "idem-disc-1",
};

function installDbDispatch() {
  mockDbQuery.mockImplementation((sql: string) => {
    if (sql.includes("INSERT INTO cmc_sales")) {
      return Promise.resolve({ rows: [{ id: "sale-1" }] });
    }
    return Promise.resolve({ rows: [] });
  });
}

function saleInsertParams(): unknown[] {
  const call = mockDbQuery.mock.calls.find(([sql]) =>
    (sql as string).includes("INSERT INTO cmc_sales"),
  )!;
  return call[1] as unknown[];
}

// INSERT param positions (0-based):
// 5=subtotal, 6=discount_amount, 7=total, 16=discount_type, 17=discount_value, 18=discount_description
const P = { subtotal: 5, discount: 6, total: 7, type: 16, value: 17, desc: 18 };

beforeEach(() => {
  vi.clearAllMocks();
  installDbDispatch();
});

describe("POST /api/cmc-pos/sales — total-level discount", () => {
  it("applies a percentage discount to the combined subtotal and stores type/value/description", async () => {
    const res = await request(makeApp())
      .post("/api/cmc-pos/sales")
      .send({ ...BASE_PAYLOAD, discount_type: "percent", discount_value: 10, discount_description: "Loyal customer" });
    expect(res.status).toBe(201);
    const p = saleInsertParams();
    expect(p[P.subtotal]).toBe("50.0000");
    expect(p[P.discount]).toBe("5.0000"); // 10% of $50 combined
    expect(p[P.total]).toBe("45.0000");
    expect(p[P.type]).toBe("percent");
    expect(p[P.value]).toBe("10.0000");
    expect(p[P.desc]).toBe("Loyal customer");
  });

  it("applies a fixed-amount discount to the combined subtotal (custom items included)", async () => {
    const res = await request(makeApp())
      .post("/api/cmc-pos/sales")
      .send({ ...BASE_PAYLOAD, discount_type: "amount", discount_value: 35 });
    // $35 > shelf subtotal ($20) but ≤ combined subtotal ($50) — must be accepted
    expect(res.status).toBe(201);
    const p = saleInsertParams();
    expect(p[P.discount]).toBe("35.0000");
    expect(p[P.total]).toBe("15.0000");
    expect(p[P.type]).toBe("amount");
    expect(p[P.desc]).toBeNull();
  });

  it("rejects a percentage above 100", async () => {
    const res = await request(makeApp())
      .post("/api/cmc-pos/sales")
      .send({ ...BASE_PAYLOAD, discount_type: "percent", discount_value: 101 });
    expect(res.status).toBe(422);
  });

  it("rejects an amount exceeding the combined subtotal", async () => {
    const res = await request(makeApp())
      .post("/api/cmc-pos/sales")
      .send({ ...BASE_PAYLOAD, discount_type: "amount", discount_value: 50.01 });
    expect(res.status).toBe(422);
  });

  it("rejects discount_type without discount_value", async () => {
    const res = await request(makeApp())
      .post("/api/cmc-pos/sales")
      .send({ ...BASE_PAYLOAD, discount_type: "percent" });
    expect(res.status).toBe(422);
  });

  it("a 100% discount brings the total to zero, never negative", async () => {
    const res = await request(makeApp())
      .post("/api/cmc-pos/sales")
      .send({ ...BASE_PAYLOAD, discount_type: "percent", discount_value: 100 });
    expect(res.status).toBe(201);
    const p = saleInsertParams();
    expect(p[P.discount]).toBe("50.0000");
    expect(p[P.total]).toBe("0.0000");
  });

  it("no discount fields behaves exactly as today (no discount, null metadata)", async () => {
    const res = await request(makeApp()).post("/api/cmc-pos/sales").send(BASE_PAYLOAD);
    expect(res.status).toBe(201);
    const p = saleInsertParams();
    expect(p[P.discount]).toBe("0.0000");
    expect(p[P.total]).toBe("50.0000");
    expect(p[P.type]).toBeNull();
    expect(p[P.value]).toBeNull();
    expect(p[P.desc]).toBeNull();
  });

  it("legacy discount_amount is applied to the shelf subtotal only", async () => {
    const ok = await request(makeApp())
      .post("/api/cmc-pos/sales")
      .send({ ...BASE_PAYLOAD, discount_amount: 5 });
    expect(ok.status).toBe(201);
    const p = saleInsertParams();
    expect(p[P.discount]).toBe("5.0000");
    expect(p[P.total]).toBe("45.0000");
    expect(p[P.type]).toBeNull();

    installDbDispatch();
    const tooBig = await request(makeApp())
      .post("/api/cmc-pos/sales")
      .send({ ...BASE_PAYLOAD, discount_amount: 25 }); // > shelf subtotal ($20)
    expect(tooBig.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// PATCH /cmc-pos/sales/:id — edits must preserve/validate total-level discounts
// ---------------------------------------------------------------------------

const STORED_ITEMS = [
  { product_id: 1, name: "Roses", qty: 2, unit_price: 10, item_type: "shelf" },
  { product_id: null, name: "Custom Bouquet", qty: 1, unit_price: 30, item_type: "custom" },
];

function installPatchDispatch(stored: { discount_type: string | null; discount_value: string | null }) {
  mockDbQuery.mockImplementation((sql: string) => {
    if (sql.includes("SELECT line_items")) {
      return Promise.resolve({
        rows: [{ line_items: STORED_ITEMS, ...stored }],
      });
    }
    if (sql.includes("UPDATE cmc_sales")) {
      return Promise.resolve({ rows: [{ id: "sale-1" }] });
    }
    return Promise.resolve({ rows: [] });
  });
}

function updateSetClause(): [string, unknown[]] {
  const call = mockDbQuery.mock.calls.find(([sql]) =>
    (sql as string).includes("UPDATE cmc_sales"),
  )!;
  return [call[0] as string, call[1] as unknown[]];
}

describe("PATCH /api/cmc-pos/sales/:id — total-level discount", () => {
  it("accepts a total-level amount discount larger than the shelf subtotal", async () => {
    installPatchDispatch({ discount_type: null, discount_value: null });
    const res = await request(makeApp())
      .patch("/api/cmc-pos/sales/sale-1")
      .send({ discount_type: "amount", discount_value: 35, discount_description: "VIP" });
    expect(res.status).toBe(200);
    const [sql, params] = updateSetClause();
    expect(sql).toContain("discount_type =");
    expect(params).toContain("35.0000"); // discount_value + discount_amount
    expect(params).toContain("15.0000"); // total = 50 - 35
    expect(params).toContain("VIP");
  });

  it("preserves stored total-level discount metadata when editing other fields", async () => {
    installPatchDispatch({ discount_type: "percent", discount_value: "10.0000" });
    // Simulates the edit dialog PATCHing line items without changing the discount
    const res = await request(makeApp())
      .patch("/api/cmc-pos/sales/sale-1")
      .send({ notes: "updated", line_items: STORED_ITEMS });
    expect(res.status).toBe(200);
    const [sql, params] = updateSetClause();
    expect(sql).toContain("discount_type =");
    expect(params).toContain("10.0000"); // stored percent value preserved
    expect(params).toContain("5.0000");  // recomputed: 10% of $50
    expect(params).toContain("45.0000"); // total
  });

  it("rejects a total-level amount discount exceeding the combined subtotal", async () => {
    installPatchDispatch({ discount_type: null, discount_value: null });
    const res = await request(makeApp())
      .patch("/api/cmc-pos/sales/sale-1")
      .send({ discount_type: "amount", discount_value: 60 });
    expect(res.status).toBe(422);
  });

  it("rejects a percentage above 100 on edit", async () => {
    installPatchDispatch({ discount_type: null, discount_value: null });
    const res = await request(makeApp())
      .patch("/api/cmc-pos/sales/sale-1")
      .send({ discount_type: "percent", discount_value: 120 });
    expect(res.status).toBe(422);
  });

  it("discount_type: null clears the total-level discount and falls back to legacy", async () => {
    installPatchDispatch({ discount_type: "percent", discount_value: "10.0000" });
    const res = await request(makeApp())
      .patch("/api/cmc-pos/sales/sale-1")
      .send({ discount_type: null, discount_amount: 0, discount_description: null });
    expect(res.status).toBe(200);
    const [sql, params] = updateSetClause();
    expect(sql).toContain("discount_type = NULL");
    expect(sql).toContain("discount_value = NULL");
    expect(params).toContain("0.0000");  // discount cleared
    expect(params).toContain("50.0000"); // total restored
  });

  it("legacy edits on sales without discount metadata behave exactly as before", async () => {
    installPatchDispatch({ discount_type: null, discount_value: null });
    const ok = await request(makeApp())
      .patch("/api/cmc-pos/sales/sale-1")
      .send({ discount_amount: 5 });
    expect(ok.status).toBe(200);
    const [, params] = updateSetClause();
    expect(params).toContain("5.0000");
    expect(params).toContain("45.0000"); // 20 - 5 + 30

    installPatchDispatch({ discount_type: null, discount_value: null });
    const tooBig = await request(makeApp())
      .patch("/api/cmc-pos/sales/sale-1")
      .send({ discount_amount: 25 }); // > shelf subtotal
    expect(tooBig.status).toBe(422);
  });

  it("editing line items on a legacy discounted sale keeps legacy shelf-subtotal semantics", async () => {
    // Edit-dialog shape: line_items + discount_amount, no discount_type.
    installPatchDispatch({ discount_type: null, discount_value: null });
    const res = await request(makeApp())
      .patch("/api/cmc-pos/sales/sale-1")
      .send({ line_items: STORED_ITEMS, discount_amount: 5 });
    expect(res.status).toBe(200);
    const [sql, params] = updateSetClause();
    // Stays legacy: no total-level metadata written
    expect(sql).not.toContain("discount_type =");
    expect(sql).not.toContain("discount_type = NULL");
    expect(params).toContain("5.0000");
    expect(params).toContain("45.0000"); // (20 - 5) + 30

    // And legacy validation still rejects a discount above the shelf subtotal
    installPatchDispatch({ discount_type: null, discount_value: null });
    const tooBig = await request(makeApp())
      .patch("/api/cmc-pos/sales/sale-1")
      .send({ line_items: STORED_ITEMS, discount_amount: 25 });
    expect(tooBig.status).toBe(422);
    expect(tooBig.body.error).toContain("shelf items subtotal");
  });
});
