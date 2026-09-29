import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

// ---------------------------------------------------------------------------
// Hoisted mock state
// ---------------------------------------------------------------------------

const { mockDbQuery, stubWorkspaceRole } = vi.hoisted(() => ({
  mockDbQuery: vi.fn(),
  stubWorkspaceRole: { value: "owner" as "owner" | "member", allowed: [] as string[] },
}));

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../lib/db", () => ({
  db: { query: (...args: unknown[]) => mockDbQuery(...args) },
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = "owner_abc";
    wreq.workspaceRole = stubWorkspaceRole.value;
    wreq.allowedPages = stubWorkspaceRole.allowed;
    wreq.memberDbId = 1;
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

import couponsRouter from "./coupons";

// ---------------------------------------------------------------------------
// Test app
// ---------------------------------------------------------------------------

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: unknown }).log = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
    };
    next();
  });
  app.use("/api", couponsRouter);
  app.use((_req, res) => res.status(599).json({ fellThrough: true }));
  return app;
}

function couponDbRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    workspace_owner_id: "owner_abc",
    code: "SAVE10",
    description: null,
    discount_type: "percentage",
    discount_value: "10",
    min_order_usd: null,
    scope: "all",
    starts_at: null,
    expires_at: null,
    per_user_limit: null,
    global_limit: null,
    is_active: true,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Default mock for the batched assembleCoupons lookups (includes/excludes/usage). */
function mockAssembleEmpty() {
  mockDbQuery
    .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // coupon_products
    .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // coupon_attributes
    .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // coupon_excluded_products
    .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // coupon_excluded_attributes
    .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // coupon_redemptions usage
}

beforeEach(() => {
  mockDbQuery.mockReset();
  stubWorkspaceRole.value = "owner";
  stubWorkspaceRole.allowed = [];
});

describe("GET /api/coupons", () => {
  it("lists coupons for an owner", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [couponDbRow()], rowCount: 1 });
    mockAssembleEmpty();

    const res = await request(makeApp()).get("/api/coupons");
    expect(res.status).toBe(200);
    expect(res.body.coupons).toHaveLength(1);
    expect(res.body.coupons[0]).toMatchObject({
      code: "SAVE10",
      discountType: "percentage",
      discountValue: 10,
      scope: "all",
      usedCount: 0,
    });
  });

  it("allows a member with the coupons page permission", async () => {
    stubWorkspaceRole.value = "member";
    stubWorkspaceRole.allowed = ["coupons"];
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(makeApp()).get("/api/coupons");
    expect(res.status).toBe(200);
    expect(res.body.coupons).toEqual([]);
  });

  it("denies a member without the coupons page permission", async () => {
    stubWorkspaceRole.value = "member";
    stubWorkspaceRole.allowed = ["payment-links"];

    const res = await request(makeApp()).get("/api/coupons");
    expect(res.status).toBe(403);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });
});

describe("POST /api/coupons", () => {
  it("creates a percentage coupon", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [couponDbRow()], rowCount: 1 }); // INSERT
    mockAssembleEmpty();

    const res = await request(makeApp())
      .post("/api/coupons")
      .send({ code: "SAVE10", discountType: "percentage", discountValue: 10 });

    expect(res.status).toBe(201);
    expect(res.body.coupon.code).toBe("SAVE10");
    const insertSql = mockDbQuery.mock.calls[0][0] as string;
    expect(insertSql).toMatch(/INSERT INTO coupons/);
  });

  it("rejects a percentage discount over 100", async () => {
    const res = await request(makeApp())
      .post("/api/coupons")
      .send({ code: "TOOBIG", discountType: "percentage", discountValue: 150 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Percentage discount cannot exceed 100/);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("rejects a missing code", async () => {
    const res = await request(makeApp())
      .post("/api/coupons")
      .send({ discountType: "fixed", discountValue: 5 });

    expect(res.status).toBe(400);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 409 on a duplicate code", async () => {
    mockDbQuery.mockRejectedValueOnce({ code: "23505" });

    const res = await request(makeApp())
      .post("/api/coupons")
      .send({ code: "DUP", discountType: "fixed", discountValue: 5 });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already exists/);
  });
});

describe("DELETE /api/coupons/:id", () => {
  it("returns 404 when the coupon does not exist", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(makeApp()).delete("/api/coupons/does-not-exist");
    expect(res.status).toBe(404);
  });

  it("deletes an existing coupon", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(makeApp()).delete(
      "/api/coupons/11111111-1111-1111-1111-111111111111",
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });
});
