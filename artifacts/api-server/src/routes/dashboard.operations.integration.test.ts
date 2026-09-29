/**
 * Real-database coverage for the Ops dashboard's raw-SQL eligibility rules.
 * Auth and workspace middleware are stubbed; PostgreSQL is not.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import pg from "pg";
import type { WorkspaceRequest } from "../lib/workspace";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const OWNER_ID = "__test_ops_dashboard__";
const OTHER_OWNER_ID = "__test_ops_dashboard_other__";

vi.mock("../lib/auth", () => ({
  requireAuth: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => next(),
}));

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = OWNER_ID;
    wreq.workspaceRole = "member";
    wreq.workspaceActualRole = "member";
    wreq.allowedPages = ["ops-dashboard"];
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
  hasPageAccess: (wreq: WorkspaceRequest, pageKey: string) =>
    wreq.workspaceRole === "owner" || !!wreq.allowedPages?.includes(pageKey),
}));

import dashboardRouter from "./dashboard";

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(dashboardRouter);
  return app;
}

describe.skipIf(!DATABASE_URL)(
  "GET /dashboard/operations-summary (integration)",
  () => {
    let pool: InstanceType<typeof Pool>;
    let app: express.Express;

    async function cleanup(): Promise<void> {
      await pool.query(
        `DELETE FROM order_florist_assignments
          WHERE workspace_owner_id = ANY($1::text[])`,
        [[OWNER_ID, OTHER_OWNER_ID]],
      );
      await pool.query(
        `DELETE FROM cmc_requests
          WHERE workspace_owner_id = ANY($1::text[])`,
        [[OWNER_ID, OTHER_OWNER_ID]],
      );
      await pool.query(
        `DELETE FROM orders
          WHERE workspace_owner_id = ANY($1::text[])`,
        [[OWNER_ID, OTHER_OWNER_ID]],
      );
      await pool.query(
        `DELETE FROM locations
          WHERE workspace_owner_id = ANY($1::text[])`,
        [[OWNER_ID, OTHER_OWNER_ID]],
      );
    }

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL });
      app = makeApp();
      await cleanup();
    });

    afterAll(async () => {
      await cleanup();
      await pool.end();
    });

    it("returns all-zero counts for an empty workspace", async () => {
      const response = await request(app).get(
        "/dashboard/operations-summary?date=2026-08-19&tz=Asia%2FBeirut",
      );

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        florist_manual_review_count: 0,
        cmc_submitted_request_count: 0,
        processing_orders_today_count: 0,
      });
    });

    it("applies florist, CMC, workspace, and zoned delivery-date rules together", async () => {
      const primaryLocation = await pool.query<{ id: number }>(
        `INSERT INTO locations (workspace_owner_id, name)
         VALUES ($1, 'Ops Dashboard Primary') RETURNING id`,
        [OWNER_ID],
      );
      const otherLocation = await pool.query<{ id: number }>(
        `INSERT INTO locations (workspace_owner_id, name)
         VALUES ($1, 'Ops Dashboard Other') RETURNING id`,
        [OTHER_OWNER_ID],
      );

      const orders = await pool.query<{ id: string }>(
        `INSERT INTO orders
          (workspace_owner_id, status, delivery_address, window_start)
         VALUES
          ($1, 'processing', '{"date":"2026-08-19"}', '2026-08-17T12:00:00Z'),
          ($1, 'processing', '{"date":"2026-08-20"}', '2026-08-18T21:30:00Z'),
           ($1, 'processing', '{}',                    '2026-08-18T21:30:00Z'),
           ($1, 'processing', '{"date":"2026-02-30"}', '2026-08-18T21:30:00Z'),
           ($1, 'processing', '{"date":"2026-08-19extra"}', '2026-08-17T12:00:00Z'),
          ($1, 'pending',    '{"date":"2026-08-19"}', '2026-08-18T21:30:00Z')
         RETURNING id`,
        [OWNER_ID],
      );
      const otherOrder = await pool.query<{ id: string }>(
        `INSERT INTO orders
          (workspace_owner_id, status, delivery_address, window_start)
         VALUES
          ($1, 'processing', '{"date":"2026-08-19"}', '2026-08-18T21:30:00Z')
         RETURNING id`,
        [OTHER_OWNER_ID],
      );

      await pool.query(
        `INSERT INTO order_florist_assignments
          (workspace_owner_id, order_id, location_id, status,
           verification_status, photo_items_path, photo_card_path)
         VALUES
          ($1, $2, $3, 'in_progress', 'rejected', '/items-a', '/card-a'),
          ($1, $4, $3, 'in_progress', 'rejected', '/items-b', NULL),
           ($1, $5, $3, 'in_progress', 'approved', '/items-c', '/card-c'),
           ($1, $6, $3, 'completed',   'rejected', '/items-d', '/card-d'),
          ($7, $8, $9, 'in_progress', 'rejected', '/items-e', '/card-e')`,
        [
          OWNER_ID,
          orders.rows[0].id,
          primaryLocation.rows[0].id,
          orders.rows[1].id,
          orders.rows[2].id,
          orders.rows[5].id,
          OTHER_OWNER_ID,
          otherOrder.rows[0].id,
          otherLocation.rows[0].id,
        ],
      );

      await pool.query(
        `INSERT INTO cmc_requests
          (workspace_owner_id, destination_location_id, status, created_by_user_id)
         VALUES
          ($1, $2, 'submitted', 'ops-test'),
          ($1, $2, 'draft', 'ops-test'),
          ($3, $4, 'submitted', 'ops-test')`,
        [
          OWNER_ID,
          primaryLocation.rows[0].id,
          OTHER_OWNER_ID,
          otherLocation.rows[0].id,
        ],
      );

      const response = await request(app).get(
        "/dashboard/operations-summary?date=2026-08-19&tz=Asia%2FBeirut",
      );

      expect(response.status, response.text).toBe(200);
      expect(response.body).toEqual({
        florist_manual_review_count: 2,
        cmc_submitted_request_count: 1,
        processing_orders_today_count: 2,
      });
    });
  },
);