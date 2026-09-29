/**
 * Integration tests (REAL database) for the analytics 500s caused by orders
 * that store a city SLUG (e.g. "lb-saida") instead of a numeric delivery-city
 * id in `delivery_address->>'cityId'`.
 *
 * The old by-city SQL cast that field with `::int`, so a single slug-valued
 * order made Postgres throw 22P02 (`invalid input syntax for type integer`)
 * and the WHOLE endpoint returned HTTP 500 — confirmed in production for
 * executive-overview, customer-insights, and delivery.
 *
 * Coverage:
 *   1. Every endpoint with a by-city breakdown returns 200 with a slug order
 *      present (executive-overview, sales, customer-insights,
 *      product-performance, delivery).
 *   2. Slug orders resolve to the correct city NAME in the by-city rows (not
 *      "Unknown"/dropped) alongside numeric-id orders for the same city, and
 *      the two storage forms are MERGED into exactly one row per city (the
 *      by-city SQL groups by the resolved delivery_cities.id, falling back to
 *      the raw stored text only when unresolved).
 *   3. Junk cityId values ("no-such-city") never crash — they fall back to
 *      the un-resolved bucket.
 *   4. The shared `city` filter matches BOTH numeric-id orders AND slug
 *      orders for the selected city.
 *
 * Auth / workspace / logger are mocked; the database is real and the suite is
 * skipped automatically when DATABASE_URL is not set.
 *
 * Run via:
 *   bash artifacts/api-server/test-integration-local.sh src/routes/storeAnalytics.cityslug.integration.test.ts
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import pg from "pg";
import type { WorkspaceRequest } from "../lib/workspace";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;

const OWNER_ID = "__test_city_slug_analytics__";

// ─────────────────────────────────────────────────────────────────────────────
// Mocks — auth / workspace / logger. db is NOT mocked (real pool).
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
  authed: (req: express.Request) => req,
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
    wreq.userId = "__test_city_slug_user__";
    wreq.userEmail = "city-slug-test@example.com";
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

// Imports MUST come AFTER vi.mock declarations.
import storeAnalyticsRouter from "./storeAnalytics";
import deliveryAnalyticsRouter from "./deliveryAnalytics";

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (
      req as unknown as {
        log: {
          error: (...a: unknown[]) => void;
          warn: (...a: unknown[]) => void;
          info: (...a: unknown[]) => void;
          debug: (...a: unknown[]) => void;
        };
      }
    ).log = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
    next();
  });
  app.use("/api", storeAnalyticsRouter);
  app.use("/api", deliveryAnalyticsRouter);
  return app;
}

const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf("store analytics with slug-valued cityId orders (integration)", () => {
  let pool: InstanceType<typeof Pool>;
  let app: express.Express;
  let cityId: number;
  let uniq = 0;

  const CITY_NAME = "Saida Slug Test";
  const CITY_SLUG = "lb-saida-slug-test";

  async function seedOrder(opts: {
    cityIdValue: string | null;
    totalUsd: number;
    withCustomerContact?: boolean;
  }): Promise<string> {
    const address: Record<string, unknown> = { countryCode: "LB" };
    if (opts.cityIdValue !== null) address.cityId = opts.cityIdValue;
    const r = await pool.query<{ id: string }>(
      `INSERT INTO orders
         (workspace_owner_id, source, external_order_id, status, ordered_at, totals, delivery_address)
       VALUES ($1, 'external', $2, 'completed', now(), $3::jsonb, $4::jsonb)
       RETURNING id`,
      [
        OWNER_ID,
        `cityslug-${Date.now()}-${uniq++}-${Math.random().toString(36).slice(2, 8)}`,
        JSON.stringify({ total: opts.totalUsd, currency: "USD" }),
        JSON.stringify(address),
      ],
    );
    const orderId = r.rows[0].id;
    if (opts.withCustomerContact) {
      const c = await pool.query<{ id: string }>(
        `INSERT INTO contacts (workspace_owner_id, source, is_guest, display_name)
         VALUES ($1, 'external', true, $2) RETURNING id`,
        [OWNER_ID, `Slug Tester ${uniq}`],
      );
      await pool.query(
        `INSERT INTO order_contacts (order_id, contact_id, role) VALUES ($1, $2, 'customer')`,
        [orderId, c.rows[0].id],
      );
    }
    return orderId;
  }

  async function cleanup(): Promise<void> {
    await pool.query(
      `DELETE FROM order_contacts WHERE order_id IN (SELECT id FROM orders WHERE workspace_owner_id = $1)`,
      [OWNER_ID],
    );
    await pool.query(`DELETE FROM contacts WHERE workspace_owner_id = $1`, [OWNER_ID]);
    await pool.query(`DELETE FROM orders WHERE workspace_owner_id = $1`, [OWNER_ID]);
    await pool.query(`DELETE FROM delivery_cities WHERE workspace_owner_id = $1`, [OWNER_ID]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await cleanup();

    const city = await pool.query<{ id: number }>(
      `INSERT INTO delivery_cities (workspace_owner_id, country_code, name, slug)
       VALUES ($1, 'LB', $2, $3) RETURNING id`,
      [OWNER_ID, CITY_NAME, CITY_SLUG],
    );
    cityId = city.rows[0].id;

    // One numeric-id order, one slug order (the production crasher), one junk
    // cityId order, one with no cityId at all.
    await seedOrder({ cityIdValue: String(cityId), totalUsd: 100, withCustomerContact: true });
    await seedOrder({ cityIdValue: CITY_SLUG, totalUsd: 50, withCustomerContact: true });
    await seedOrder({ cityIdValue: "no-such-city", totalUsd: 25 });
    await seedOrder({ cityIdValue: null, totalUsd: 10 });

    app = makeApp();
  }, 30000);

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  const query = { from: "2020-01-01", to: "2030-01-01" };

  it("executive-overview merges id + slug orders into ONE city row", async () => {
    const res = await request(app).get("/api/store-analytics/executive-overview").query(query);
    expect(res.status).toBe(200);
    const rows = (res.body.revenueByCity ?? []) as { name: string; revenue: number; orders: number }[];
    const cityRows = rows.filter((r) => r.name === CITY_NAME);
    expect(cityRows).toHaveLength(1);
    expect(cityRows[0].revenue).toBe(150);
    expect(cityRows[0].orders).toBe(2);
  });

  it("sales merges id + slug orders into ONE city row", async () => {
    const res = await request(app).get("/api/store-analytics/sales").query(query);
    expect(res.status).toBe(200);
    const rows = (res.body.revenueByCity ?? []) as { name: string; revenue: number }[];
    const cityRows = rows.filter((r) => r.name === CITY_NAME);
    expect(cityRows).toHaveLength(1);
    expect(cityRows[0].revenue).toBe(150);
  });

  it("customer-insights merges id + slug orders into ONE city row", async () => {
    const res = await request(app).get("/api/store-analytics/customer-insights").query(query);
    expect(res.status).toBe(200);
    const rows = (res.body.customersByCity ?? []) as { name: string; customers: number }[];
    const cityRows = rows.filter((r) => r.name === CITY_NAME);
    expect(cityRows).toHaveLength(1);
    expect(cityRows[0].customers).toBe(2);
  });

  it("product-performance merges id + slug orders into ONE city row", async () => {
    const res = await request(app).get("/api/store-analytics/product-performance").query(query);
    expect(res.status).toBe(200);
    const rows = (res.body.byCity ?? []) as { name: string; orders: number }[];
    const cityRows = rows.filter((r) => r.name === CITY_NAME);
    expect(cityRows).toHaveLength(1);
    expect(cityRows[0].orders).toBe(2);
  });

  it("delivery merges id + slug orders into ONE city row", async () => {
    const res = await request(app).get("/api/store-analytics/delivery").query(query);
    expect(res.status).toBe(200);
    const rows = (res.body.districts ?? []) as { name: string | null; orders: number }[];
    const cityRows = rows.filter((r) => r.name === CITY_NAME);
    expect(cityRows).toHaveLength(1);
    expect(cityRows[0].orders).toBe(2);
  });

  it("junk cityId values never resolve to the city (and never crash)", async () => {
    const res = await request(app).get("/api/store-analytics/executive-overview").query(query);
    expect(res.status).toBe(200);
    const rows = (res.body.revenueByCity ?? []) as { name: string; revenue: number }[];
    const junk = rows.find((r) => r.name === "City no-such-city");
    expect(junk).toBeDefined();
    expect(junk!.revenue).toBe(25);
  });

  it("the city filter matches both numeric-id AND slug orders", async () => {
    const res = await request(app)
      .get("/api/store-analytics/executive-overview")
      .query({ ...query, city: String(cityId) });
    expect(res.status).toBe(200);
    // Both the numeric-id order (100) and the slug order (50) must be in
    // scope; the junk (25) and no-city (10) orders must be excluded.
    expect(res.body.kpis.totalRevenue).toBe(150);
    expect(res.body.kpis.orders).toBe(2);
  });
});
