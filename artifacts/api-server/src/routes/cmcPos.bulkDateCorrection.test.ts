import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

const mockDbQuery = vi.fn();
const release = vi.fn();
const workspaceState: {
  ownerId: string;
  role: "owner" | "member";
  allowedPages: string[];
} = {
  ownerId: "workspace-a",
  role: "member",
  allowedPages: ["cmc_pos.audit", "cmc_pos.edit"],
};

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
    connect: () => Promise.resolve({
      query: (...args: unknown[]) => mockDbQuery(...args),
      release,
    }),
  },
  withTransaction: async (client: { query: (sql: string) => Promise<unknown> }, fn: () => Promise<unknown>) => {
    await client.query("BEGIN");
    try {
      const result = await fn();
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  },
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = workspaceState.ownerId;
    wreq.workspaceRole = workspaceState.role;
    wreq.workspaceActualRole = workspaceState.role;
    wreq.allowedPages = workspaceState.allowedPages;
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
  recordCashTransaction: vi.fn(),
  computeShiftOverdue: vi.fn(),
  sessionCurrencies: vi.fn(),
  computeSessionCurrencySummary: vi.fn(),
}));
vi.mock("../lib/eventsSse", () => ({ broadcastEvent: vi.fn() }));

import cmcPosRouter from "./cmcPos";

const payload = {
  source_from: "2026-07-01",
  source_to: "2026-07-31",
  target_date: "2026-08-01",
};

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).log = { error: vi.fn() };
    next();
  });
  app.use("/api", cmcPosRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  workspaceState.ownerId = "workspace-a";
  workspaceState.role = "member";
  workspaceState.allowedPages = ["cmc_pos.audit", "cmc_pos.edit"];
  mockDbQuery.mockResolvedValue({ rows: [] });
});

describe("CMC bulk date correction API", () => {
  it("previews the inclusive July scope for the current workspace", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ matching_count: "3", gross_total: "145.50" }],
    });

    const response = await request(makeApp())
      .post("/api/cmc-pos/sales/bulk-date-correction/preview")
      .send(payload);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      matching_count: 3,
      gross_total: "145.50",
      target_date: "2026-08-01",
    });
    const [sql, params] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("workspace_owner_id = $1");
    expect(sql).toContain("workflow_type IN ('shelf_sale', 'order')");
    expect(sql).toContain("created_at AT TIME ZONE 'Asia/Beirut'");
    expect(sql).toContain("BETWEEN $2 AND $3");
    expect(params).toEqual(["workspace-a", "2026-07-01", "2026-07-31"]);
  });

  it("rejects preview and apply without cmc_pos.edit", async () => {
    workspaceState.allowedPages = ["cmc_pos.audit"];

    const [preview, apply] = await Promise.all([
      request(makeApp()).post("/api/cmc-pos/sales/bulk-date-correction/preview").send(payload),
      request(makeApp()).post("/api/cmc-pos/sales/bulk-date-correction/apply").send(payload),
    ]);

    expect(preview.status).toBe(403);
    expect(apply.status).toBe(403);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("validates real chronological source and target dates", async () => {
    const invalid = await request(makeApp())
      .post("/api/cmc-pos/sales/bulk-date-correction/preview")
      .send({
        source_from: "2026-07-31",
        source_to: "2026-07-01",
        target_date: "2026-02-30",
      });

    expect(invalid.status).toBe(400);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("rejects ranges or targets outside the one-purpose July-to-August operation", async () => {
    const [partialJuly, overlappingTarget] = await Promise.all([
      request(makeApp())
        .post("/api/cmc-pos/sales/bulk-date-correction/preview")
        .send({ ...payload, source_from: "2026-07-02" }),
      request(makeApp())
        .post("/api/cmc-pos/sales/bulk-date-correction/apply")
        .send({ ...payload, target_date: "2026-07-31" }),
    ]);

    expect(partialJuly.status).toBe(400);
    expect(overlappingTarget.status).toBe(400);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("locks the selected rows and changes only fulfilment_date", async () => {
    mockDbQuery.mockImplementation((sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT") return Promise.resolve({ rows: [] });
      if (sql.includes("SELECT id, total") && sql.includes("FOR UPDATE")) {
        return Promise.resolve({
          rows: [
            { id: "11111111-1111-4111-8111-111111111111", total: "100.00" },
            { id: "22222222-2222-4222-8222-222222222222", total: "45.50" },
          ],
        });
      }
      if (sql.includes("UPDATE cmc_sales")) {
        return Promise.resolve({
          rows: [
            { id: "11111111-1111-4111-8111-111111111111", total: "100.00" },
            { id: "22222222-2222-4222-8222-222222222222", total: "45.50" },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const response = await request(makeApp())
      .post("/api/cmc-pos/sales/bulk-date-correction/apply")
      .send(payload);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      before_count: 2,
      before_gross_total: "145.50",
      moved_count: 2,
      moved_gross_total: "145.50",
      after_count: 2,
      target_date: "2026-08-01",
    });

    const updateCall = mockDbQuery.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE cmc_sales"),
    ) as [string, unknown[]];
    expect(updateCall[0]).toContain("SET fulfilment_date = $4");
    const setClause = updateCall[0].split("WHERE")[0];
    expect(setClause).not.toMatch(/(created_at|total|payment_method|status|shift_id|location_id|order_id)\s*=/);
    expect(updateCall[1][3]).toBe("2026-08-01");
    expect(updateCall[1][0]).toBe("workspace-a");
  });

  it("is a no-op when repeated after the source range is empty", async () => {
    mockDbQuery.mockImplementation((sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT") return Promise.resolve({ rows: [] });
      if (sql.includes("FOR UPDATE")) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });

    const response = await request(makeApp())
      .post("/api/cmc-pos/sales/bulk-date-correction/apply")
      .send(payload);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      before_count: 0,
      moved_count: 0,
      after_count: 0,
    });
    expect(mockDbQuery.mock.calls.some(([sql]) => String(sql).includes("UPDATE cmc_sales"))).toBe(false);
  });

  it("rolls back the whole correction when the update fails", async () => {
    mockDbQuery.mockImplementation((sql: string) => {
      if (sql === "BEGIN" || sql === "ROLLBACK") return Promise.resolve({ rows: [] });
      if (sql.includes("FOR UPDATE")) {
        return Promise.resolve({
          rows: [{ id: "11111111-1111-4111-8111-111111111111", total: "100.00" }],
        });
      }
      if (sql.includes("UPDATE cmc_sales")) {
        return Promise.reject(new Error("simulated update failure"));
      }
      return Promise.resolve({ rows: [] });
    });

    const response = await request(makeApp())
      .post("/api/cmc-pos/sales/bulk-date-correction/apply")
      .send(payload);

    expect(response.status).toBe(500);
    expect(mockDbQuery.mock.calls.some(([sql]) => sql === "ROLLBACK")).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });
});