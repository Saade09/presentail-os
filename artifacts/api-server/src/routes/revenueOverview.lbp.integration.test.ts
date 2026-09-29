/**
 * Regression coverage for the complete LBP retail analytics path:
 * startup seed/repair -> real stored-rate lookup -> Revenue Overview response.
 *
 * Auth/workspace middleware is stubbed; PostgreSQL and exchangeRateService are real.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import pg from "pg";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const OWNER_ID = "__integration_test_revenue_lbp__";

vi.mock("../lib/db", async () => {
  const { default: pgLib } = await import("pg");
  const pool = new pgLib.Pool({ connectionString: process.env.DATABASE_URL });
  return { db: pool };
});

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
    const wreq = req as unknown as import("../lib/workspace").WorkspaceRequest;
    wreq.workspaceOwnerId = OWNER_ID;
    wreq.workspaceRole = "owner";
    wreq.workspaceActualRole = "owner";
    wreq.userId = "__integration_test_revenue_lbp_user__";
    next();
  },
  workspace: (req: express.Request) =>
    req as unknown as import("../lib/workspace").WorkspaceRequest,
}));

vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

import { repairGlobalLbpRate } from "../lib/initDb";
import { getStoredRate } from "../lib/exchangeRateService";
import revenueOverviewRouter from "./revenueOverview";

type SavedRate = {
  base_currency: string;
  target_currency: string;
  rate: string;
  provider: string;
  fetched_at: Date;
};

describe.skipIf(!DATABASE_URL).sequential(
  "Revenue Overview LBP conversion (integration)",
  () => {
    let pool: InstanceType<typeof Pool>;
    let app: express.Express;
    let savedRates: SavedRate[] = [];

    async function clearLbpRates(): Promise<void> {
      await pool.query(
        `DELETE FROM exchange_rates
          WHERE workspace_owner_id = '__global__'
            AND (
              (base_currency = 'USD' AND target_currency = 'LBP')
              OR (base_currency = 'LBP' AND target_currency = 'USD')
            )`,
      );
    }

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL });
      const saved = await pool.query<SavedRate>(
        `SELECT base_currency, target_currency, rate::text AS rate, provider, fetched_at
           FROM exchange_rates
          WHERE workspace_owner_id = '__global__'
            AND (
              (base_currency = 'USD' AND target_currency = 'LBP')
              OR (base_currency = 'LBP' AND target_currency = 'USD')
            )`,
      );
      savedRates = saved.rows;

      await pool.query(`DELETE FROM workshop_sales WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await clearLbpRates();

      app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        (req as unknown as { log: Record<string, unknown> }).log = {
          error: () => undefined,
          warn: () => undefined,
          info: () => undefined,
          debug: () => undefined,
        };
        next();
      });
      app.use("/api", revenueOverviewRouter);
    });

    afterAll(async () => {
      if (!pool) return;
      await pool.query(`DELETE FROM workshop_sales WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await clearLbpRates();
      for (const row of savedRates) {
        await pool.query(
          `INSERT INTO exchange_rates
             (workspace_owner_id, base_currency, target_currency, rate, provider, fetched_at)
           VALUES ('__global__', $1, $2, $3, $4, $5)
           ON CONFLICT (workspace_owner_id, base_currency, target_currency)
           DO UPDATE SET rate = EXCLUDED.rate, provider = EXCLUDED.provider,
                         fetched_at = EXCLUDED.fetched_at`,
          [
            row.base_currency,
            row.target_currency,
            row.rate,
            row.provider,
            row.fetched_at,
          ],
        );
      }
      await pool.end();
    });

    it("seeds 89,500 LBP/USD idempotently and reconciles every response projection", async () => {
      await repairGlobalLbpRate();
      await repairGlobalLbpRate();

      const rows = await pool.query<{
        base_currency: string;
        target_currency: string;
        rate: string;
        provider: string;
      }>(
        `SELECT base_currency, target_currency, rate::text AS rate, provider
           FROM exchange_rates
          WHERE workspace_owner_id = '__global__'
            AND (
              (base_currency = 'USD' AND target_currency = 'LBP')
              OR (base_currency = 'LBP' AND target_currency = 'USD')
            )`,
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]).toMatchObject({
        base_currency: "USD",
        target_currency: "LBP",
        provider: "manual",
      });
      expect(Number(rows.rows[0].rate)).toBeCloseTo(1 / 89_500, 10);

      const stored = await getStoredRate("LBP", "USD", "__global__");
      expect(stored?.rate).toBeCloseTo(1 / 89_500, 10);

      await pool.query(
        `INSERT INTO workshop_sales
           (workspace_owner_id, order_number, status, currency, total, created_at)
         VALUES ($1, $2, 'completed', 'LBP', 3640000, '2026-08-02T12:00:00.000Z')`,
        [OWNER_ID, `WS-LBP-${Date.now()}`],
      );

      const response = await request(app).get(
        "/api/revenue-overview?from=2026-08-01T00:00:00.000Z&to=2026-08-08T00:00:00.000Z",
      );
      expect(response.status).toBe(200);

      const retail = response.body.totals.streams.find(
        (stream: { key: string }) => stream.key === "retail",
      );
      expect(retail).toMatchObject({
        revenue: 40.67,
        orders: 1,
        shareOfTotal: 100,
      });
      expect(response.body.totals.totalRevenue).toBe(40.67);

      const retailPoint = response.body.series.find(
        (point: { retail: number | null }) => point.retail !== null,
      );
      expect(retailPoint).toMatchObject({ retail: 40.67, total: 40.67 });
      expect(response.body.snapshot.orders).toMatchObject({ value: 1, available: true });
      expect(response.body.snapshot.aov).toMatchObject({ value: 40.67, available: true });
      expect(
        response.body.availability.find(
          (entry: { stream: string }) => entry.stream === "retail",
        ),
      ).toMatchObject({ available: true, partial: false });
    });

    it("repairs a stale reversed pair without allowing it to win lookup", async () => {
      await clearLbpRates();
      await pool.query(
        `INSERT INTO exchange_rates
           (workspace_owner_id, base_currency, target_currency, rate, provider, fetched_at)
         VALUES ('__global__', 'LBP', 'USD', 89500, 'exchangerate-api.com', now())`,
      );

      await repairGlobalLbpRate();
      await repairGlobalLbpRate();

      const stored = await getStoredRate("LBP", "USD", "__global__");
      expect(stored?.rate).toBeCloseTo(1 / 89_500, 10);
      const reverse = await pool.query(
        `SELECT 1
           FROM exchange_rates
          WHERE workspace_owner_id = '__global__'
            AND base_currency = 'LBP'
            AND target_currency = 'USD'`,
      );
      expect(reverse.rowCount).toBe(0);
    });

    it("preserves a valid reversed manual override ahead of canonical provider data", async () => {
      await clearLbpRates();
      await pool.query(
        `INSERT INTO exchange_rates
           (workspace_owner_id, base_currency, target_currency, rate, provider, fetched_at)
         VALUES
           ('__global__', 'USD', 'LBP', 89500, 'exchangerate-api.com', '2026-08-01T00:00:00Z'),
           ('__global__', 'LBP', 'USD', 80000, 'manual', '2026-08-02T00:00:00Z')`,
      );

      await repairGlobalLbpRate();
      await repairGlobalLbpRate();

      const stored = await getStoredRate("LBP", "USD", "__global__");
      expect(stored?.rate).toBeCloseTo(1 / 80_000, 10);
      const canonical = await pool.query<{ provider: string; rate: string }>(
        `SELECT provider, rate::text AS rate
           FROM exchange_rates
          WHERE workspace_owner_id = '__global__'
            AND base_currency = 'USD'
            AND target_currency = 'LBP'`,
      );
      expect(canonical.rows).toHaveLength(1);
      expect(canonical.rows[0].provider).toBe("manual");
      expect(Number(canonical.rows[0].rate)).toBeCloseTo(1 / 80_000, 10);
    });

    it("uses a valid reversed row instead of replacing it because canonical data is invalid", async () => {
      await clearLbpRates();
      await pool.query(
        `INSERT INTO exchange_rates
           (workspace_owner_id, base_currency, target_currency, rate, provider, fetched_at)
         VALUES
           ('__global__', 'USD', 'LBP', 0, 'exchangerate-api.com', '2026-08-02T00:00:00Z'),
           ('__global__', 'LBP', 'USD', 89500, 'exchangerate-api.com', '2026-08-01T00:00:00Z')`,
      );

      await repairGlobalLbpRate();
      await repairGlobalLbpRate();

      const stored = await getStoredRate("LBP", "USD", "__global__");
      expect(stored?.rate).toBeCloseTo(1 / 89_500, 10);
      const canonical = await pool.query<{ provider: string; rate: string }>(
        `SELECT provider, rate::text AS rate
           FROM exchange_rates
          WHERE workspace_owner_id = '__global__'
            AND base_currency = 'USD'
            AND target_currency = 'LBP'`,
      );
      expect(canonical.rows).toHaveLength(1);
      expect(canonical.rows[0].provider).toBe("exchangerate-api.com");
      expect(Number(canonical.rows[0].rate)).toBeCloseTo(89_500, 5);
    });
  },
);