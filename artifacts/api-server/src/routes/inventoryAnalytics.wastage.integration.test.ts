import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import pg from "pg";
import { randomUUID } from "node:crypto";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const OWNER_ID = "__integration_test_wastage__";
const USER_ID = "__integration_test_wastage_user__";

vi.mock("../lib/db", async () => {
  const { default: pgLib } = await import("pg");
  return { db: new pgLib.Pool({ connectionString: process.env.DATABASE_URL }) };
});

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    const wreq = req as unknown as Record<string, unknown>;
    const role = req.header("x-test-role") === "member" ? "member" : "owner";
    const pages = (req.header("x-test-pages") ?? "")
      .split(",")
      .map((page) => page.trim())
      .filter(Boolean);
    wreq.workspaceOwnerId = OWNER_ID;
    wreq.workspaceRole = role;
    wreq.workspaceActualRole = role;
    wreq.allowedPages = role === "owner" ? null : pages;
    wreq.userId = USER_ID;
    next();
  },
  workspace: (req: express.Request) => req as unknown as import("../lib/workspace").WorkspaceRequest,
}));

import inventoryAnalyticsRouter from "./inventoryAnalytics";
import { db as routeDb } from "../lib/db";

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: { error: () => void } }).log = { error: () => undefined };
    next();
  });
  app.use(inventoryAnalyticsRouter);
  return app;
}

describe.skipIf(!DATABASE_URL)(
  "Base Item wastage operational ledger — integration (real database)",
  () => {
    let pool: InstanceType<typeof Pool>;
    let app: express.Express;
    let baseItemId: number;
    let locationId: number;

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL });
      app = makeApp();
      await pool.query(`DELETE FROM wastage_records WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM base_item_stock_adjustments WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM base_item_location_statuses WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM base_items WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM locations WHERE workspace_owner_id = $1`, [OWNER_ID]);

      const baseItem = await pool.query<{ id: number }>(
        `INSERT INTO base_items (workspace_owner_id, name, code, status, stock)
         VALUES ($1, 'Wastage Test Item', 'WASTE-TEST-001', 'active', 10)
         RETURNING id`,
        [OWNER_ID],
      );
      baseItemId = baseItem.rows[0].id;
      const location = await pool.query<{ id: number }>(
        `INSERT INTO locations (workspace_owner_id, name, country)
         VALUES ($1, 'Wastage Test Location', 'AE')
         RETURNING id`,
        [OWNER_ID],
      );
      locationId = location.rows[0].id;
      await pool.query(
        `INSERT INTO base_item_location_statuses
           (workspace_owner_id, base_item_id, location_id, stock, is_active)
         VALUES ($1, $2, $3, 10, true)`,
        [OWNER_ID, baseItemId, locationId],
      );
    });

    afterAll(async () => {
      if (!pool) return;
      await pool.query(`DELETE FROM wastage_records WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM base_item_stock_adjustments WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM base_item_location_statuses WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM base_items WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM locations WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.end();
      await (routeDb as unknown as import("pg").Pool).end();
    });

    it("rejects members without base-items management permission without changing stock", async () => {
      const response = await request(app)
        .post("/base-items/wastage")
        .set("x-test-role", "member")
        .set("x-test-pages", "base_items.view")
        .send({
          actionId: randomUUID(),
          baseItemId,
          locationId,
          quantity: 1,
          unitOfMeasure: "unit",
          reason: "expired",
          employeeId: "__spoofed_employee__",
        });

      expect(response.status).toBe(403);
      expect(response.body.error).toBe(
        "Requires owner or base_items.manage permission",
      );

      const movementCount = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM base_item_stock_adjustments
          WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      expect(movementCount.rows[0].count).toBe("0");

      const stock = await pool.query<{ stock: string }>(
        `SELECT stock
           FROM base_item_location_statuses
          WHERE workspace_owner_id = $1
            AND base_item_id = $2
            AND location_id = $3`,
        [OWNER_ID, baseItemId, locationId],
      );
      expect(stock.rows[0].stock).toBe("10");
    });

    it("allows a base-items manager, records the authenticated actor, and leaves analytics isolated", async () => {
      const payload = {
        actionId: randomUUID(),
        baseItemId,
        locationId,
        quantity: 3,
        unitOfMeasure: "unit",
        reason: "expired",
        employeeId: "__responsible_employee__",
        notes: "integration wastage",
        unitCost: 4,
      };
      const first = await request(app)
        .post("/base-items/wastage")
        .set("x-test-role", "member")
        .set("x-test-pages", "base_items.manage")
        .send(payload);

      expect(first.status).toBe(201);

      const operational = await pool.query<{
        id: number;
        quantity_change: string;
        movement_type: string;
        ledger_scope: string;
        idempotency_key: string;
        canonical_unit: string;
        created_by_user_id: string | null;
      }>(
        `SELECT id, quantity_change, movement_type, ledger_scope, idempotency_key,
                canonical_unit, created_by_user_id
           FROM base_item_stock_adjustments
          WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      expect(operational.rows).toHaveLength(1);
      expect(operational.rows[0]).toMatchObject({
        quantity_change: "-3",
        movement_type: "waste_damage",
        ledger_scope: "base_item_operational",
        idempotency_key: `wastage:${payload.actionId}`,
        canonical_unit: "unit",
        created_by_user_id: USER_ID,
      });

      const status = await pool.query<{ stock: string }>(
        `SELECT stock FROM base_item_location_statuses
          WHERE workspace_owner_id = $1 AND base_item_id = $2 AND location_id = $3`,
        [OWNER_ID, baseItemId, locationId],
      );
      expect(status.rows[0].stock).toBe("7");
      const item = await pool.query<{ stock: string }>(
        `SELECT stock FROM base_items WHERE id = $1`,
        [baseItemId],
      );
      expect(item.rows[0].stock).toBe("7");

      const wastage = await pool.query<{
        operational_movement_id: number;
        movement_id: number | null;
        employee_id: string | null;
      }>(
        `SELECT operational_movement_id, movement_id, employee_id
           FROM wastage_records WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      expect(wastage.rows).toEqual([{
        operational_movement_id: operational.rows[0].id,
        movement_id: null,
        employee_id: "__responsible_employee__",
      }]);
      const analyticsRows = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM inventory_movements WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      expect(analyticsRows.rows[0].count).toBe("0");

      const retry = await request(app)
        .post("/base-items/wastage")
        .set("x-test-role", "member")
        .set("x-test-pages", "base_items.manage")
        .send(payload);
      expect(retry.status).toBe(200);
      expect(retry.body).toMatchObject({ id: first.body.id, duplicate: true });

      const afterRetry = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM base_item_stock_adjustments WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      expect(afterRetry.rows[0].count).toBe("1");
    });

    it("rejects wastage that would overdraw the location without changing history", async () => {
      const response = await request(app)
        .post("/base-items/wastage")
        .send({
          baseItemId,
          locationId,
          actionId: randomUUID(),
          quantity: 8,
          reason: "expired",
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("INSUFFICIENT_STOCK");
      const count = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM base_item_stock_adjustments WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      expect(count.rows[0].count).toBe("1");
    });

    it("rejects a non-canonical unit instead of guessing a conversion", async () => {
      const response = await request(app)
        .post("/base-items/wastage")
        .send({
          baseItemId,
          locationId,
          actionId: randomUUID(),
          quantity: 1,
          unitOfMeasure: "case",
          reason: "expired",
        });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        error: "INVALID_UNIT_OF_MEASURE",
        details: { requestedUnit: "case", canonicalUnit: "unit" },
      });
      const count = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM base_item_stock_adjustments WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      expect(count.rows[0].count).toBe("1");
    });

    it("serializes concurrent reuse of an action ID and rejects the changed payload", async () => {
      await pool.query(
        `UPDATE base_item_location_statuses SET stock = 10
          WHERE workspace_owner_id = $1 AND base_item_id = $2 AND location_id = $3`,
        [OWNER_ID, baseItemId, locationId],
      );
      await pool.query(`UPDATE base_items SET stock = 10 WHERE id = $1`, [baseItemId]);
      const actionId = randomUUID();
      const basePayload = {
        actionId,
        baseItemId,
        locationId,
        unitOfMeasure: "unit",
        reason: "quality_issue",
        notes: "concurrent action",
      };
      const [first, second] = await Promise.all([
        request(app).post("/base-items/wastage").send({ ...basePayload, quantity: 1 }),
        request(app).post("/base-items/wastage").send({ ...basePayload, quantity: 2 }),
      ]);

      expect([first.status, second.status].sort()).toEqual([201, 409]);
      const rows = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM base_item_stock_adjustments
          WHERE workspace_owner_id = $1 AND idempotency_key = $2`,
        [OWNER_ID, `wastage:${actionId}`],
      );
      expect(Number(rows.rows[0].count)).toBe(1);
    });
  },
);