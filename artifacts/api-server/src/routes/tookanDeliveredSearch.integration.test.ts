/**
 * Integration tests (REAL database) for Task: populate Delivery (Tookan) &
 * Search analytics data.
 *
 * Coverage:
 *   1. Delivery Analytics on-time rate is computed from `orders.tookan_delivered_at`
 *      when there is no fleet-driver assignment: one Tookan order delivered
 *      inside the promised window and one delivered after it must yield
 *      onTimeRate = 50 and lateDeliveries = 1.
 *   2. Search & Discovery surfaces search terms stored ONLY inside the
 *      `properties` jsonb (no top-level `search_query`), via the COALESCE
 *      fallback (`query`, `search_term`, `q`, ...).
 *
 * Auth / workspace / logger are mocked; the database is real and the suite is
 * skipped automatically when DATABASE_URL is not set.
 *
 * Run via:
 *   bash artifacts/api-server/test-integration-local.sh src/routes/tookanDeliveredSearch.integration.test.ts
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import pg from "pg";
import type { WorkspaceRequest } from "../lib/workspace";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;

const OWNER_ID = "__test_tookan_delivered_search__";

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
    wreq.userId = "__test_tookan_search_user__";
    wreq.userEmail = "tookan-search-test@example.com";
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
import deliveryAnalyticsRouter from "./deliveryAnalytics";
import storeAnalyticsRouter from "./storeAnalytics";

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
  app.use("/api", deliveryAnalyticsRouter);
  app.use("/api", storeAnalyticsRouter);
  return app;
}

const describeIf = DATABASE_URL ? describe : describe.skip;

describeIf("Tookan delivered-at & search-term fallback (integration)", () => {
  let pool: InstanceType<typeof Pool>;
  let app: express.Express;
  let uniq = 0;

  async function seedTookanOrder(opts: {
    windowStart: string;
    windowEnd: string;
    tookanDeliveredAt: string | null;
  }): Promise<string> {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO orders
         (workspace_owner_id, source, external_order_id, status, ordered_at,
          window_start, window_end, tookan_status, tookan_delivered_at, totals)
       VALUES ($1, 'external', $2, 'completed', now() - interval '1 day',
               $3, $4, 'successful', $5, '{"total": 40, "currency": "USD"}'::jsonb)
       RETURNING id`,
      [
        OWNER_ID,
        `tookan-ontime-${Date.now()}-${uniq++}`,
        opts.windowStart,
        opts.windowEnd,
        opts.tookanDeliveredAt,
      ],
    );
    return r.rows[0].id;
  }

  async function seedSearchEvent(opts: {
    properties: Record<string, unknown>;
    searchQuery?: string | null;
    resultCount?: number | null;
  }): Promise<void> {
    await pool.query(
      `INSERT INTO web_events
         (workspace_owner_id, event_type, session_id, occurred_at, search_query,
          result_count, properties)
       VALUES ($1, 'search', $2, now() - interval '1 day', $3, $4, $5::jsonb)`,
      [
        OWNER_ID,
        `sess-${uniq++}`,
        opts.searchQuery ?? null,
        opts.resultCount ?? 5,
        JSON.stringify(opts.properties),
      ],
    );
  }

  async function cleanup(): Promise<void> {
    await pool.query(`DELETE FROM web_events WHERE workspace_owner_id = $1`, [OWNER_ID]);
    await pool.query(`DELETE FROM orders WHERE workspace_owner_id = $1`, [OWNER_ID]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await cleanup();

    // On-time: delivered before window_end. Late: delivered after window_end.
    // No fleet_driver_order_assignments rows → delivered_at comes purely from
    // orders.tookan_delivered_at.
    await seedTookanOrder({
      windowStart: "2026-07-07T10:00:00Z",
      windowEnd: "2026-07-07T12:00:00Z",
      tookanDeliveredAt: "2026-07-07T11:30:00Z",
    });
    await seedTookanOrder({
      windowStart: "2026-07-07T10:00:00Z",
      windowEnd: "2026-07-07T12:00:00Z",
      tookanDeliveredAt: "2026-07-07T13:15:00Z",
    });
    // Delivered but with NO tookan_delivered_at → excluded from the rate.
    await seedTookanOrder({
      windowStart: "2026-07-07T10:00:00Z",
      windowEnd: "2026-07-07T12:00:00Z",
      tookanDeliveredAt: null,
    });

    // Search events whose term lives ONLY in properties (legacy website shape).
    await seedSearchEvent({ properties: { query: "Red Roses" } });
    await seedSearchEvent({ properties: { search_term: "red roses" } });
    await seedSearchEvent({ properties: { q: "chocolate box" }, resultCount: 0 });

    app = makeApp();
  }, 30000);

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  const query = { from: "2020-01-01", to: "2030-01-01" };

  it("computes on-time rate from tookan_delivered_at (no driver assignment)", async () => {
    const res = await request(app).get("/api/store-analytics/delivery").query(query);
    expect(res.status).toBe(200);
    expect(res.body.kpis.totalDeliveries).toBe(3);
    expect(res.body.kpis.onTimeRate).toBe(50);
    expect(res.body.kpis.lateDeliveries).toBe(1);
  });

  it("surfaces search terms stored only inside properties jsonb", async () => {
    const res = await request(app)
      .get("/api/store-analytics/search-discovery")
      .query(query);
    expect(res.status).toBe(200);
    expect(res.body.searchTracked).toBe(true);
    expect(res.body.totals.searches).toBe(3);
    expect(res.body.totals.uniqueTerms).toBe(2);

    const terms = (res.body.topSearchTerms as { term: string; searches: number }[]) ?? [];
    const roses = terms.find((t) => t.term === "red roses");
    expect(roses).toBeDefined();
    expect(roses!.searches).toBe(2);
    expect(terms.some((t) => t.term === "chocolate box")).toBe(true);

    const noResult = (res.body.noResultTerms as { term: string }[]) ?? [];
    expect(noResult.some((t) => t.term === "chocolate box")).toBe(true);
  });
});
