import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ---------------------------------------------------------------------------
// Hoisted mock state
// ---------------------------------------------------------------------------

const { mockDbQuery, mockResolveApiKeyWorkspace } = vi.hoisted(() => ({
  mockDbQuery: vi.fn(),
  mockResolveApiKeyWorkspace: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../lib/db", () => ({
  db: { query: (...args: unknown[]) => mockDbQuery(...args) },
}));

vi.mock("../lib/apiKeyAuth", () => ({
  requireApiKey: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as unknown as { userId: string }).userId = "owner_abc";
    next();
  },
  resolveApiKeyWorkspace: (...args: unknown[]) => mockResolveApiKeyWorkspace(...args),
}));

import validateRouter from "./couponsValidate";

// ---------------------------------------------------------------------------
// Test app
// ---------------------------------------------------------------------------

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", validateRouter);
  app.use((_req, res) => res.status(599).json({ fellThrough: true }));
  return app;
}

function couponRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "cpn-1",
    code: "SAVE10",
    description: "10% off",
    discount_type: "percentage",
    discount_value: "10",
    min_order_usd: null,
    scope: "all",
    starts_at: null,
    expires_at: null,
    per_user_limit: null,
    global_limit: null,
    is_active: true,
    ...overrides,
  };
}

beforeEach(() => {
  mockDbQuery.mockReset();
  mockResolveApiKeyWorkspace.mockReset();
});

/** Coupon validation always loads product and attribute exclusions. */
function mockEmptyExclusions() {
  mockDbQuery
    .mockResolvedValueOnce({ rows: [], rowCount: 0 })
    .mockResolvedValueOnce({ rows: [], rowCount: 0 });
}

describe("POST /api/coupons/validate", () => {
  it("returns 400 for an invalid body", async () => {
    const res = await request(makeApp()).post("/api/coupons/validate").send({ code: "" });
    expect(res.status).toBe(400);
  });

  it("returns not_found (200) when the code does not exist", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(makeApp())
      .post("/api/coupons/validate")
      .send({ code: "NOPE", cartTotalUsd: 100 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ valid: false, error: "not_found" });
  });

  it("returns inactive for a disabled coupon", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [couponRow({ is_active: false })], rowCount: 1 });

    const res = await request(makeApp())
      .post("/api/coupons/validate")
      .send({ code: "SAVE10", cartTotalUsd: 100 });

    expect(res.body).toMatchObject({ valid: false, error: "inactive" });
  });

  it("returns expired for a past expiry", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [couponRow({ expires_at: "2020-01-01T00:00:00.000Z" })],
      rowCount: 1,
    });

    const res = await request(makeApp())
      .post("/api/coupons/validate")
      .send({ code: "SAVE10", cartTotalUsd: 100 });

    expect(res.body).toMatchObject({ valid: false, error: "expired" });
  });

  it("returns not_started_yet for a future start date", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [couponRow({ starts_at: "2999-01-01T00:00:00.000Z" })],
      rowCount: 1,
    });

    const res = await request(makeApp())
      .post("/api/coupons/validate")
      .send({ code: "SAVE10", cartTotalUsd: 100 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ valid: false, error: "not_started_yet" });
  });

  it("returns usage_limit_per_user_reached when the per-user limit is hit", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [couponRow({ per_user_limit: 1 })],
      rowCount: 1,
    });
    mockEmptyExclusions();
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "1" }], rowCount: 1 });

    const res = await request(makeApp())
      .post("/api/coupons/validate")
      .send({ code: "SAVE10", cartTotalUsd: 100, customerEmail: "buyer@example.com" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ valid: false, error: "usage_limit_per_user_reached" });
  });

  it("returns below_minimum when cart total is under the minimum", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [couponRow({ min_order_usd: "50" })],
      rowCount: 1,
    });

    const res = await request(makeApp())
      .post("/api/coupons/validate")
      .send({ code: "SAVE10", cartTotalUsd: 20 });

    expect(res.body).toMatchObject({ valid: false, error: "below_minimum" });
  });

  it("computes a percentage discount for a valid coupon", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [couponRow()], rowCount: 1 });
    mockEmptyExclusions();

    const res = await request(makeApp())
      .post("/api/coupons/validate")
      .send({ code: "SAVE10", cartTotalUsd: 200 });

    expect(res.body).toMatchObject({
      valid: true,
      discountAmountUsd: 20,
      couponId: "cpn-1",
    });
  });

  it("computes a fixed discount capped at the cart total", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [couponRow({ discount_type: "fixed", discount_value: "30" })],
      rowCount: 1,
    });
    mockEmptyExclusions();

    const res = await request(makeApp())
      .post("/api/coupons/validate")
      .send({ code: "SAVE10", cartTotalUsd: 25 });

    expect(res.body).toMatchObject({ valid: true, discountAmountUsd: 25 });
  });

  it("returns usage_limit_reached when the global limit is hit", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [couponRow({ global_limit: 5 })],
      rowCount: 1,
    });
    mockEmptyExclusions();
    mockDbQuery.mockResolvedValueOnce({ rows: [{ count: "5" }], rowCount: 1 });

    const res = await request(makeApp())
      .post("/api/coupons/validate")
      .send({ code: "SAVE10", cartTotalUsd: 100 });

    expect(res.body).toMatchObject({ valid: false, error: "usage_limit_reached" });
  });

  it("returns no_eligible_items for a restricted coupon with no matching cart items", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [couponRow({ scope: "restricted" })], rowCount: 1 }) // coupon
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // coupon_excluded_products
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // coupon_excluded_attributes
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // products resolve
      .mockResolvedValueOnce({ rows: [{ product_id: 999 }], rowCount: 1 }) // coupon_products
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // coupon_attributes

    const res = await request(makeApp())
      .post("/api/coupons/validate")
      .send({
        code: "SAVE10",
        cartTotalUsd: 100,
        items: [{ productId: 1, lineTotalUsd: 100 }],
      });

    expect(res.body).toMatchObject({ valid: false, error: "no_eligible_items" });
  });
});

describe("GET /api/coupons (external)", () => {
  it("falls through when no API key is present", async () => {
    mockResolveApiKeyWorkspace.mockResolvedValueOnce(null);

    const res = await request(makeApp()).get("/api/coupons");

    expect(res.status).toBe(599);
    expect(res.body).toMatchObject({ fellThrough: true });
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("scopes the coupon query to the API key's workspace and filters active/expired", async () => {
    mockResolveApiKeyWorkspace.mockResolvedValueOnce("owner_abc");
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // coupons list

    const res = await request(makeApp()).get("/api/coupons");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ coupons: [] });
    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toContain("workspace_owner_id = $1");
    expect(sql).toContain("is_active = true");
    expect(sql).toMatch(/expires_at IS NULL OR expires_at > now\(\)/);
    expect(params).toEqual(["owner_abc"]);
  });

  it("returns unrestricted coupons with usage counts and null restrictions", async () => {
    mockResolveApiKeyWorkspace.mockResolvedValueOnce("owner_abc");
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [couponRow({ per_user_limit: 1, global_limit: 100 })],
        rowCount: 1,
      }) // coupons list
      .mockResolvedValueOnce({
        rows: [{ coupon_id: "cpn-1", used_count: "7" }],
        rowCount: 1,
      }); // usage counts

    const res = await request(makeApp()).get("/api/coupons");

    expect(res.status).toBe(200);
    expect(res.body.coupons).toHaveLength(1);
    expect(res.body.coupons[0]).toMatchObject({
      id: "cpn-1",
      code: "SAVE10",
      description: "10% off",
      discountType: "percentage",
      discountValue: 10,
      minOrderUsd: null,
      scope: "all",
      startsAt: null,
      expiresAt: null,
      isActive: true,
      perUserLimit: 1,
      globalLimit: 100,
      usedCount: 7,
      restrictions: null,
    });
    // No restriction lookups needed for an unrestricted coupon.
    expect(mockDbQuery).toHaveBeenCalledTimes(2);
  });

  it("returns restricted coupons with product ids/slugs and attribute ids/slugs", async () => {
    mockResolveApiKeyWorkspace.mockResolvedValueOnce("owner_abc");
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [
          couponRow({
            scope: "restricted",
            min_order_usd: "50",
            expires_at: "2999-06-01T00:00:00.000Z",
          }),
        ],
        rowCount: 1,
      }) // coupons list
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // usage counts
      .mockResolvedValueOnce({
        rows: [{ coupon_id: "cpn-1", id: 42, sku: "red-roses-bouquet" }],
        rowCount: 1,
      }) // coupon products join
      .mockResolvedValueOnce({
        rows: [{ coupon_id: "cpn-1", id: 3, slug: "birthday", name: "Birthday" }],
        rowCount: 1,
      }) // occasions
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // categories
      .mockResolvedValueOnce({
        rows: [{ coupon_id: "cpn-1", id: 9, slug: "acme", name: "Acme" }],
        rowCount: 1,
      }) // brands
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // recipients

    const res = await request(makeApp()).get("/api/coupons");

    expect(res.status).toBe(200);
    expect(res.body.coupons[0]).toMatchObject({
      scope: "restricted",
      minOrderUsd: 50,
      expiresAt: "2999-06-01T00:00:00.000Z",
      usedCount: 0,
      restrictions: {
        products: [{ id: 42, slug: "red-roses-bouquet" }],
        occasions: [{ id: 3, slug: "birthday", name: "Birthday" }],
        categories: [],
        brands: [{ id: 9, slug: "acme", name: "Acme" }],
        recipients: [],
      },
    });
  });
});
