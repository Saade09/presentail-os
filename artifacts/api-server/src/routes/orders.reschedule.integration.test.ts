/**
 * Real-PostgreSQL coverage for delivery reschedule persistence.
 *
 * The route intentionally runs against the initialized schema so a stale fleet
 * assignment relation or incompatible order identity column fails the request
 * instead of being hidden by query mocks.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import pg from "pg";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const OWNER_ID = `__order_reschedule_${Date.now()}`;
const USER_ID = "order_reschedule_integration_user";
const DELIVERY_DATE = "2099-01-02";
const WINDOW_START = "2099-01-02T14:00:00.000Z";
const WINDOW_END = "2099-01-02T18:00:00.000Z";

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn().mockReturnThis(),
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
  authed: (req: express.Request) => req,
}));

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = OWNER_ID;
    wreq.workspaceRole = "owner";
    wreq.workspaceActualRole = "owner";
    wreq.userId = USER_ID;
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
  hasPageAccess: () => true,
}));

vi.mock("../lib/logger", () => ({ logger: mockLogger }));
vi.mock("../lib/catalogWebhook", () => ({
  fireWebhookEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@clerk/express", () => ({
  clerkClient: {
    users: {
      getUser: vi.fn().mockResolvedValue({
        firstName: "Integration",
        lastName: "User",
        primaryEmailAddress: null,
      }),
    },
  },
}));

import ordersRouter from "./orders";

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: typeof mockLogger }).log = mockLogger;
    next();
  });
  app.use("/api", ordersRouter);
  return app;
}

describe.skipIf(!DATABASE_URL)("order delivery reschedule persistence (integration)", () => {
  let pool: InstanceType<typeof Pool>;
  let app: express.Express;
  let cityId: number;
  let slotId: number;
  let driverId: number;

  async function cleanup(): Promise<void> {
    await pool.query(`DELETE FROM fleet_driver_order_assignments WHERE workspace_owner_id = $1`, [
      OWNER_ID,
    ]);
    await pool.query(`DELETE FROM orders WHERE workspace_owner_id = $1`, [OWNER_ID]);
    await pool.query(`DELETE FROM fleet_drivers WHERE workspace_owner_id = $1`, [OWNER_ID]);
    await pool.query(`DELETE FROM district_weekly_delivery_slots WHERE workspace_owner_id = $1`, [
      OWNER_ID,
    ]);
    await pool.query(`DELETE FROM delivery_cities WHERE workspace_owner_id = $1`, [OWNER_ID]);
  }

  async function seedOrder(
    withAssignment: boolean,
    deliveryType: "standard" | "express" = "standard",
  ): Promise<string> {
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO orders
         (workspace_owner_id, source, external_order_id, display_order_number, status,
          ordered_at, totals, delivery_type, delivery_address, window_start, window_end)
       VALUES ($1, 'integration-test', $2, $2, 'processing', now(), $3::jsonb,
                $4, $5::jsonb, '2099-01-01T09:00:00Z', '2099-01-01T12:00:00Z')
       RETURNING id`,
      [
        OWNER_ID,
        `RESCHEDULE-${withAssignment ? "ASSIGNED" : "UNASSIGNED"}-${Date.now()}`,
        JSON.stringify({ total: 1, currency: "USD" }),
        deliveryType,
        JSON.stringify({
          cityId,
          city: "Integration City",
          date: "2099-01-01",
          slot: "09:00–12:00",
        }),
      ],
    );
    const orderId = inserted.rows[0]!.id;
    if (withAssignment) {
      await pool.query(
        `INSERT INTO fleet_driver_order_assignments
           (workspace_owner_id, driver_id, order_id, order_reference, status, scheduled_at)
         VALUES ($1, $2, $3, 'DISPLAY-REFERENCE-NOT-ORDER-ID', 'assigned',
                 '2099-01-01T09:00:00Z')`,
        [OWNER_ID, driverId, orderId],
      );
    }
    return orderId;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    app = makeApp();
    await cleanup();

    const city = await pool.query<{ id: number }>(
      `INSERT INTO delivery_cities
         (workspace_owner_id, country_code, name, slug, is_active, delivery_timezone,
          standard_delivery_available, express_delivery_available, express_delivery_enabled)
       VALUES ($1, 'LB', 'Integration City', $2, true, 'UTC', true, true, true)
       RETURNING id`,
      [OWNER_ID, `integration-city-${Date.now()}`],
    );
    cityId = city.rows[0]!.id;

    await pool.query(
      `INSERT INTO district_delivery_settings
         (city_id, workspace_owner_id, express_enabled, express_start_time,
          express_end_time, express_min_prep_minutes, express_daily_capacity)
       VALUES ($1, $2, true, '14:00', '18:00', 0, 10)
       ON CONFLICT (city_id) DO UPDATE
         SET workspace_owner_id = EXCLUDED.workspace_owner_id,
             express_enabled = EXCLUDED.express_enabled,
             express_start_time = EXCLUDED.express_start_time,
             express_end_time = EXCLUDED.express_end_time,
             express_min_prep_minutes = EXCLUDED.express_min_prep_minutes,
             express_daily_capacity = EXCLUDED.express_daily_capacity`,
      [cityId, OWNER_ID],
    );

    const dayOfWeek = new Date(`${DELIVERY_DATE}T00:00:00.000Z`).getUTCDay();
    const slot = await pool.query<{ id: number }>(
      `INSERT INTO district_weekly_delivery_slots
         (city_id, workspace_owner_id, day_of_week, label, start_time, end_time,
          is_enabled, delivery_type, capacity, sort_order)
       VALUES ($1, $2, $3, 'Afternoon', '14:00', '18:00', true, 'standard', 10, 0)
       RETURNING id`,
      [cityId, OWNER_ID, dayOfWeek],
    );
    slotId = slot.rows[0]!.id;

    const driver = await pool.query<{ id: number }>(
      `INSERT INTO fleet_drivers
         (workspace_owner_id, first_name, last_name, vehicle_type)
       VALUES ($1, 'Integration', 'Driver', 'car')
       RETURNING id`,
      [OWNER_ID],
    );
    driverId = driver.rows[0]!.id;
  });

  beforeEach(async () => {
    await pool.query(`DELETE FROM fleet_driver_order_assignments WHERE workspace_owner_id = $1`, [
      OWNER_ID,
    ]);
    await pool.query(`DELETE FROM orders WHERE workspace_owner_id = $1`, [OWNER_ID]);
    await pool.query(
      `UPDATE district_delivery_settings
          SET express_daily_capacity = 10
        WHERE city_id = $1 AND workspace_owner_id = $2`,
      [cityId, OWNER_ID],
    );
  });

  afterAll(async () => {
    if (!pool) return;
    await cleanup();
    await pool.end();
  });

  it("saves the order window, display metadata, and linked fleet schedule atomically", async () => {
    const orderId = await seedOrder(true);

    const response = await request(app)
      .post(`/api/orders/${orderId}/reschedule`)
      .send({
        date: DELIVERY_DATE,
        slot_id: String(slotId),
        start_time: "14:00",
        end_time: "18:00",
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, changed: true });

    const saved = await pool.query<{
      window_start: Date;
      window_end: Date;
      delivery_address: { date?: string; slot?: string };
      scheduled_at: Date | null;
    }>(
      `SELECT o.window_start, o.window_end, o.delivery_address, a.scheduled_at
         FROM orders o
         JOIN fleet_driver_order_assignments a ON a.order_id = o.id
        WHERE o.id = $1 AND o.workspace_owner_id = $2`,
      [orderId, OWNER_ID],
    );
    expect(saved.rows[0]?.window_start.toISOString()).toBe(WINDOW_START);
    expect(saved.rows[0]?.window_end.toISOString()).toBe(WINDOW_END);
    expect(saved.rows[0]?.delivery_address).toMatchObject({
      date: DELIVERY_DATE,
      slot: "14:00–18:00",
    });
    expect(saved.rows[0]?.scheduled_at?.toISOString()).toBe(WINDOW_START);
  });

  it("succeeds when the order has no fleet assignment row", async () => {
    const orderId = await seedOrder(false);

    const response = await request(app)
      .post(`/api/orders/${orderId}/reschedule`)
      .send({
        date: DELIVERY_DATE,
        slot_id: String(slotId),
        start_time: "14:00",
        end_time: "18:00",
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, changed: true });
    const saved = await pool.query<{ window_start: Date }>(
      `SELECT window_start FROM orders WHERE id = $1`,
      [orderId],
    );
    expect(saved.rows[0]?.window_start.toISOString()).toBe(WINDOW_START);
  });

  it("discovers and saves the returned Express window", async () => {
    const orderId = await seedOrder(false, "express");

    const options = await request(app)
      .get(`/api/orders/${orderId}/reschedule-options`)
      .query({ date: DELIVERY_DATE });

    expect(options.status).toBe(200);
    expect(options.body.slots).toEqual([
      expect.objectContaining({
        id: "express",
        start_time: "14:00",
        end_time: "18:00",
      }),
    ]);

    const selected = options.body.slots[0];
    const response = await request(app)
      .post(`/api/orders/${orderId}/reschedule`)
      .send({
        date: DELIVERY_DATE,
        slot_id: selected.id,
        start_time: selected.start_time,
        end_time: selected.end_time,
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, changed: true });
    const saved = await pool.query<{
      delivery_type: string;
      window_start: Date;
      window_end: Date;
    }>(
      `SELECT delivery_type, window_start, window_end
         FROM orders
        WHERE id = $1 AND workspace_owner_id = $2`,
      [orderId, OWNER_ID],
    );
    expect(saved.rows[0]).toMatchObject({ delivery_type: "express" });
    expect(saved.rows[0]?.window_start.toISOString()).toBe(WINDOW_START);
    expect(saved.rows[0]?.window_end.toISOString()).toBe(WINDOW_END);
  });

  it("saves a previously returned Express window even when customer capacity is consumed", async () => {
    await pool.query(
      `UPDATE district_delivery_settings
          SET express_daily_capacity = 1
        WHERE city_id = $1 AND workspace_owner_id = $2`,
      [cityId, OWNER_ID],
    );
    const orderId = await seedOrder(false, "express");
    const options = await request(app)
      .get(`/api/orders/${orderId}/reschedule-options`)
      .query({ date: DELIVERY_DATE });
    expect(options.status).toBe(200);
    expect(options.body.slots).toHaveLength(1);

    const competingOrderId = await seedOrder(false, "express");
    await pool.query(
      `UPDATE orders
          SET delivery_type = ' Express ', window_start = $1, window_end = $2
        WHERE id = $3 AND workspace_owner_id = $4`,
      [WINDOW_START, WINDOW_END, competingOrderId, OWNER_ID],
    );

    const selected = options.body.slots[0];
    const response = await request(app)
      .post(`/api/orders/${orderId}/reschedule`)
      .send({
        date: DELIVERY_DATE,
        slot_id: selected.id,
        start_time: selected.start_time,
        end_time: selected.end_time,
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, changed: true });
    const saved = await pool.query<{ window_start: Date }>(
      `SELECT window_start FROM orders WHERE id = $1 AND workspace_owner_id = $2`,
      [orderId, OWNER_ID],
    );
    expect(saved.rows[0]?.window_start.toISOString()).toBe(WINDOW_START);
  });
});
