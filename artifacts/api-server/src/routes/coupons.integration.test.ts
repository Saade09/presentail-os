/**
 * Integration tests: coupons end-to-end against a real PostgreSQL database.
 *
 * The unit suites (coupons.test.ts, couponsValidate.test.ts) mock every DB
 * query, so they cannot catch column-name drift between the raw SQL in the
 * routes and the actual DDL in initDb.ts — a recurring failure mode for the
 * raw-SQL order/coupon routes. This suite pushes the real schema and exercises:
 *
 *   - create (POST /coupons) → validate (POST /coupons/validate)
 *   - order redemption (POST /api/orders) → re-ingest idempotency
 *   - restricted-scope eligibility (product match + attribute match)
 *   - global and per-user usage limits against real redemption rows
 *
 * Auth/workspace middleware and SSE/webhook side-effects are stubbed; the
 * database is real. The suite skips automatically when DATABASE_URL is not set.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import pg from "pg";
import type { WorkspaceRequest } from "../lib/workspace";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;

const OWNER_ID = `__coupons_integration_test_${Date.now()}`;
const USER_ID = `__coupons_integration_user_${Date.now()}`;

// ─────────────────────────────────────────────────────────────────────────────
// Mocks — auth / workspace / api-key / logger / SSE / webhook only.
// db and contactUpsert are real.
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
  authed: (_req: express.Request) => ({ userId: USER_ID }),
}));

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = OWNER_ID;
    wreq.workspaceRole = "owner";
    wreq.workspaceActualRole = "owner";
    wreq.userId = USER_ID;
    wreq.userEmail = "coupons-test@example.com";
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

vi.mock("../lib/apiKeyAuth", () => ({
  requireApiKey: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as unknown as { userId: string }).userId = OWNER_ID;
    next();
  },
  resolveApiKeyWorkspace: vi.fn().mockResolvedValue(null),
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn().mockReturnThis() },
}));

vi.mock("../lib/eventsSse", () => ({
  broadcastEvent: vi.fn(),
}));

vi.mock("../lib/catalogWebhook", () => ({
  fireWebhookEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@clerk/express", () => ({
  clerkClient: {
    users: {
      getUserList: vi.fn().mockResolvedValue({ data: [] }),
    },
  },
}));

import couponsRouter from "./coupons";
import couponsValidateRouter from "./couponsValidate";
import externalOrdersRouter from "./externalOrders";

// ─────────────────────────────────────────────────────────────────────────────
// Express app fixture
// ─────────────────────────────────────────────────────────────────────────────

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: Record<string, () => void> }).log = {
      error: () => {},
      warn: () => {},
      info: () => {},
    };
    next();
  });
  app.use(couponsValidateRouter);
  app.use(couponsRouter);
  app.use("/api", externalOrdersRouter);
  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      console.error("TEST APP ERROR:", err?.message, err?.stack?.split("\n")[1]);
      res.status(500).json({ error: err?.message ?? "Internal server error" });
    },
  );
  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
// Seed / cleanup helpers
// ─────────────────────────────────────────────────────────────────────────────

async function cleanup(pool: InstanceType<typeof Pool>): Promise<void> {
  // coupon_products / coupon_attributes / coupon_redemptions cascade from coupons.
  await pool.query(`DELETE FROM coupons WHERE workspace_owner_id = $1`, [OWNER_ID]);
  await pool.query(`DELETE FROM orders WHERE workspace_owner_id = $1`, [OWNER_ID]);
  await pool.query(`DELETE FROM contacts WHERE workspace_owner_id = $1`, [OWNER_ID]);
  await pool.query(`DELETE FROM product_catalog_categories WHERE product_id IN (SELECT id FROM products WHERE workspace_owner_id = $1)`, [OWNER_ID]);
  await pool.query(`DELETE FROM products WHERE workspace_owner_id = $1`, [OWNER_ID]);
  await pool.query(`DELETE FROM catalog_categories WHERE workspace_owner_id = $1`, [OWNER_ID]);
}

async function createProduct(
  pool: InstanceType<typeof Pool>,
  name: string,
): Promise<number> {
  const r = await pool.query<{ id: number }>(
    `INSERT INTO products (workspace_owner_id, name, price_usd) VALUES ($1, $2, 50) RETURNING id`,
    [OWNER_ID, name],
  );
  return r.rows[0].id;
}

async function createCategory(
  pool: InstanceType<typeof Pool>,
  name: string,
  slug: string,
): Promise<number> {
  const r = await pool.query<{ id: number }>(
    `INSERT INTO catalog_categories (workspace_owner_id, name, slug) VALUES ($1, $2, $3) RETURNING id`,
    [OWNER_ID, name, slug],
  );
  return r.rows[0].id;
}

describe.skipIf(!DATABASE_URL)(
  "Coupons — create / validate / redeem end-to-end (integration)",
  () => {
    let pool: InstanceType<typeof Pool>;
    let app: express.Express;

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL });
      app = makeApp();
      await cleanup(pool);
    });

    afterAll(async () => {
      if (!pool) return;
      await cleanup(pool);
      await pool.end();
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Create → validate (all scope, percentage)
    // ─────────────────────────────────────────────────────────────────────────

    it("creates an all-scope percentage coupon and validates it with a discount", async () => {
      const create = await request(app)
        .post("/coupons")
        .send({
          code: "SAVE10",
          discountType: "percentage",
          discountValue: 10,
          minOrderUsd: 20,
          scope: "all",
        });

      expect(create.status).toBe(201);
      expect(create.body.coupon.code).toBe("SAVE10");
      expect(create.body.coupon.scope).toBe("all");

      const validate = await request(app)
        .post("/coupons/validate")
        .send({ code: "SAVE10", cartTotalUsd: 100 });

      expect(validate.status).toBe(200);
      expect(validate.body.valid).toBe(true);
      // 10% of 100 = 10
      expect(validate.body.discountAmountUsd).toBe(10);
      expect(validate.body.couponId).toBe(create.body.coupon.id);
    });

    it("rejects validation below the minimum order amount", async () => {
      const validate = await request(app)
        .post("/coupons/validate")
        .send({ code: "SAVE10", cartTotalUsd: 5 });

      expect(validate.status).toBe(200);
      expect(validate.body.valid).toBe(false);
      expect(validate.body.error).toBe("below_minimum");
    });

    it("returns not_found for an unknown code", async () => {
      const validate = await request(app)
        .post("/coupons/validate")
        .send({ code: "DOES_NOT_EXIST", cartTotalUsd: 100 });

      expect(validate.status).toBe(200);
      expect(validate.body.valid).toBe(false);
      expect(validate.body.error).toBe("not_found");
    });

    it("returns expired / not_started_yet / inactive for the matching window states", async () => {
      const past = new Date(Date.now() - 2 * 86_400_000).toISOString();
      const earlierPast = new Date(Date.now() - 3 * 86_400_000).toISOString();
      const future = new Date(Date.now() + 3 * 86_400_000).toISOString();
      const laterFuture = new Date(Date.now() + 4 * 86_400_000).toISOString();

      const expired = await request(app)
        .post("/coupons")
        .send({
          code: "EXPIRED",
          discountType: "fixed",
          discountValue: 5,
          startsAt: earlierPast,
          expiresAt: past,
        });
      expect(expired.status).toBe(201);

      const notStarted = await request(app)
        .post("/coupons")
        .send({
          code: "FUTURE",
          discountType: "fixed",
          discountValue: 5,
          startsAt: future,
          expiresAt: laterFuture,
        });
      expect(notStarted.status).toBe(201);

      const inactive = await request(app)
        .post("/coupons")
        .send({
          code: "INACTIVE",
          discountType: "fixed",
          discountValue: 5,
          isActive: false,
        });
      expect(inactive.status).toBe(201);

      const expiredRes = await request(app)
        .post("/coupons/validate")
        .send({ code: "EXPIRED", cartTotalUsd: 100 });
      expect(expiredRes.body.error).toBe("expired");

      const notStartedRes = await request(app)
        .post("/coupons/validate")
        .send({ code: "FUTURE", cartTotalUsd: 100 });
      expect(notStartedRes.body.error).toBe("not_started_yet");

      const inactiveRes = await request(app)
        .post("/coupons/validate")
        .send({ code: "INACTIVE", cartTotalUsd: 100 });
      expect(inactiveRes.body.error).toBe("inactive");
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Order redemption + re-ingest idempotency
    // ─────────────────────────────────────────────────────────────────────────

    it("records exactly one redemption across an order re-ingest (idempotent)", async () => {
      const create = await request(app)
        .post("/coupons")
        .send({ code: "REDEEM1", discountType: "fixed", discountValue: 5 });
      expect(create.status).toBe(201);
      const couponId = create.body.coupon.id as string;

      const appOrderId = `coupon-redeem-${Date.now()}`;
      const orderBody = {
        appOrderId,
        items: [{ productName: "White Roses", quantity: 1, priceUsd: 79.99 }],
        billing: {
          firstName: "Sara",
          lastName: "K",
          email: `redeem-${Date.now()}@example.com`,
          phone: `+9617${Date.now() % 10000000}`,
        },
        couponId,
        couponDiscountUsd: 5,
      };

      const first = await request(app).post("/api/orders").send(orderBody);
      expect(first.status).toBe(201);
      expect(first.body.success).toBe(true);

      // Re-ingest the identical order — must not double-count.
      const second = await request(app).post("/api/orders").send(orderBody);
      expect([200, 201]).toContain(second.status);
      expect(second.body.order_id).toBe(first.body.order_id);

      const redemptions = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM coupon_redemptions WHERE coupon_id = $1 AND status = 'confirmed'`,
        [couponId],
      );
      expect(Number(redemptions.rows[0].count)).toBe(1);

      // usedCount surfaced through the management GET endpoint reflects the ledger.
      const detail = await request(app).get(`/coupons/${couponId}`);
      expect(detail.status).toBe(200);
      expect(detail.body.coupon.usedCount).toBe(1);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Restricted scope — product match
    // ─────────────────────────────────────────────────────────────────────────

    it("validates a restricted coupon only for carts containing an allowed product", async () => {
      const eligibleId = await createProduct(pool, "Eligible Bouquet");
      const otherId = await createProduct(pool, "Other Bouquet");

      const create = await request(app)
        .post("/coupons")
        .send({
          code: "PRODONLY",
          discountType: "percentage",
          discountValue: 20,
          scope: "restricted",
          productIds: [eligibleId],
        });
      expect(create.status).toBe(201);
      expect(create.body.coupon.productIds).toContain(eligibleId);

      const matched = await request(app)
        .post("/coupons/validate")
        .send({
          code: "PRODONLY",
          cartTotalUsd: 50,
          cartItems: [{ productId: eligibleId, priceUsd: 50, quantity: 1 }],
        });
      expect(matched.body.valid).toBe(true);
      // 20% of the eligible subtotal (50) = 10
      expect(matched.body.discountAmountUsd).toBe(10);

      const unmatched = await request(app)
        .post("/coupons/validate")
        .send({
          code: "PRODONLY",
          cartTotalUsd: 50,
          cartItems: [{ productId: otherId, priceUsd: 50, quantity: 1 }],
        });
      expect(unmatched.body.valid).toBe(false);
      expect(unmatched.body.error).toBe("no_eligible_items");
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Restricted scope — attribute (category) match
    // ─────────────────────────────────────────────────────────────────────────

    it("validates a restricted coupon by catalog attribute (category) association", async () => {
      const categoryId = await createCategory(pool, "Birthday", `birthday-${Date.now()}`);
      const productId = await createProduct(pool, "Birthday Cake Flowers");
      await pool.query(
        `INSERT INTO product_catalog_categories (product_id, attribute_id) VALUES ($1, $2)`,
        [productId, categoryId],
      );
      const unrelatedId = await createProduct(pool, "Unrelated Plant");

      const create = await request(app)
        .post("/coupons")
        .send({
          code: "CATONLY",
          discountType: "fixed",
          discountValue: 7,
          scope: "restricted",
          categoryIds: [categoryId],
        });
      expect(create.status).toBe(201);
      expect(create.body.coupon.categoryIds).toContain(categoryId);

      const matched = await request(app)
        .post("/coupons/validate")
        .send({
          code: "CATONLY",
          cartTotalUsd: 50,
          cartItems: [{ productId, priceUsd: 50, quantity: 1 }],
        });
      expect(matched.body.valid).toBe(true);
      expect(matched.body.discountAmountUsd).toBe(7);

      const unmatched = await request(app)
        .post("/coupons/validate")
        .send({
          code: "CATONLY",
          cartTotalUsd: 50,
          cartItems: [{ productId: unrelatedId, priceUsd: 50, quantity: 1 }],
        });
      expect(unmatched.body.valid).toBe(false);
      expect(unmatched.body.error).toBe("no_eligible_items");
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Usage limits — global
    // ─────────────────────────────────────────────────────────────────────────

    it("enforces the global usage limit against real redemption rows", async () => {
      const create = await request(app)
        .post("/coupons")
        .send({ code: "GLOBAL1", discountType: "fixed", discountValue: 5, globalLimit: 1 });
      expect(create.status).toBe(201);
      const couponId = create.body.coupon.id as string;

      // Before any redemption it validates fine.
      const before = await request(app)
        .post("/coupons/validate")
        .send({ code: "GLOBAL1", cartTotalUsd: 100 });
      expect(before.body.valid).toBe(true);

      // Redeem once via a real order ingest.
      const order = await request(app)
        .post("/api/orders")
        .send({
          appOrderId: `global-limit-${Date.now()}`,
          items: [{ productName: "Roses", quantity: 1, priceUsd: 100 }],
          billing: {
            firstName: "A",
            lastName: "B",
            email: `global-${Date.now()}@example.com`,
            phone: `+9617${Date.now() % 10000000}`,
          },
          couponId,
          couponDiscountUsd: 5,
        });
      expect(order.status).toBe(201);

      const after = await request(app)
        .post("/coupons/validate")
        .send({ code: "GLOBAL1", cartTotalUsd: 100 });
      expect(after.body.valid).toBe(false);
      expect(after.body.error).toBe("usage_limit_reached");
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Usage limits — per user
    // ─────────────────────────────────────────────────────────────────────────

    it("enforces the per-user usage limit against real redemption rows", async () => {
      const create = await request(app)
        .post("/coupons")
        .send({ code: "PERUSER1", discountType: "fixed", discountValue: 5, perUserLimit: 1 });
      expect(create.status).toBe(201);
      const couponId = create.body.coupon.id as string;
      const email = `peruser-${Date.now()}@example.com`;

      const order = await request(app)
        .post("/api/orders")
        .send({
          appOrderId: `peruser-limit-${Date.now()}`,
          items: [{ productName: "Roses", quantity: 1, priceUsd: 100 }],
          billing: { firstName: "A", lastName: "B", email, phone: `+9617${Date.now() % 10000000}` },
          couponId,
          couponDiscountUsd: 5,
        });
      expect(order.status).toBe(201);

      // Same customer is now blocked.
      const sameUser = await request(app)
        .post("/coupons/validate")
        .send({ code: "PERUSER1", cartTotalUsd: 100, customerEmail: email });
      expect(sameUser.body.valid).toBe(false);
      expect(sameUser.body.error).toBe("usage_limit_per_user_reached");

      // A different customer can still redeem.
      const otherUser = await request(app)
        .post("/coupons/validate")
        .send({
          code: "PERUSER1",
          cartTotalUsd: 100,
          customerEmail: `other-${Date.now()}@example.com`,
        });
      expect(otherUser.body.valid).toBe(true);
    });
  },
);
