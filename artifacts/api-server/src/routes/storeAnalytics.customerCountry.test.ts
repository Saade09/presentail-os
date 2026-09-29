import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockDbQuery = vi.fn();

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
  },
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
  authed: (req: express.Request) => req,
}));

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = "owner_123";
    wreq.workspaceRole = "owner";
    wreq.workspaceActualRole = "owner";
    wreq.userId = "user_abc";
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
  hasPageAccess: () => true,
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import storeAnalyticsRouter from "./storeAnalytics.js";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: unknown }).log = {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };
    next();
  });
  app.use("/api", storeAnalyticsRouter);
  return app;
}

/** Return mocked rows depending on which sales sub-query is being executed. */
function salesQueryImpl(sql: string): { rows: unknown[] } {
  if (sql.includes("cust.phone")) {
    // buyer's country classification query (revenueByCountry).
    return {
      rows: [
        { country_code: "sa", revenue: "750", orders: "3", aov: "250", visitor_sessions: null, conversion_rate_pct: null, prev_revenue: null, prev_orders: null, conversion_rate_prev_pct: null, conversion_trend: null },
        { country_code: null, revenue: "250", orders: "1", aov: "250", visitor_sessions: null, conversion_rate_pct: null, prev_revenue: null, prev_orders: null, conversion_rate_prev_pct: null, conversion_trend: null },
      ],
    };
  }
  return { rows: [] };
}

describe("GET /api/store-analytics/sales — buyer's country via phone dial code", () => {
  beforeEach(() => {
    mockDbQuery.mockReset();
    mockDbQuery.mockImplementation((sql: string) => Promise.resolve(salesQueryImpl(sql)));
  });

  it("classifies via the customer's phone dial code (LATERAL customer contact)", async () => {
    const res = await request(buildApp()).get("/api/store-analytics/sales");
    expect(res.status).toBe(200);

    const call = mockDbQuery.mock.calls.find(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("cust.phone"),
    );
    expect(call).toBeDefined();
    const sql = call![0] as string;
    // Joins the ordering customer's contact phone…
    expect(sql).toMatch(/oc\.role = 'customer'/);
    expect(sql).toMatch(/LEFT JOIN LATERAL/);
    // …and classifies it with the dial-code CASE (longest prefixes first).
    expect(sql).toMatch(/LIKE '966%'[^\n]*THEN 'sa'/);
    expect(sql.indexOf("LIKE '1242%'")).toBeLessThan(sql.indexOf("LIKE '1%'"));
  });

  it("returns buyer's country data in revenueByCountry", async () => {
    const res = await request(buildApp()).get("/api/store-analytics/sales");
    expect(res.status).toBe(200);
    // revenueByCountry now uses phone-derived buyer's country
    const byCountry = res.body.revenueByCountry as { code: string | null; name: string; revenue: number; orders: number }[];
    expect(byCountry.find((r) => r.code === "sa")).toMatchObject({
      code: "sa",
      name: "Saudi Arabia",
      revenue: 750,
      orders: 3,
    });
    expect(byCountry.find((r) => r.code === null)).toMatchObject({
      code: null,
      name: "Unknown",
      revenue: 250,
      orders: 1,
    });
    // purchasesByCustomerCountry no longer exists
    expect(res.body.purchasesByCustomerCountry).toBeUndefined();
  });

  it("returns an empty revenueByCountry when there are no orders", async () => {
    mockDbQuery.mockImplementation(() => Promise.resolve({ rows: [] }));
    const res = await request(buildApp()).get("/api/store-analytics/sales");
    expect(res.status).toBe(200);
    expect(res.body.revenueByCountry).toEqual([]);
    expect(res.body.purchasesByCustomerCountry).toBeUndefined();
  });
});
