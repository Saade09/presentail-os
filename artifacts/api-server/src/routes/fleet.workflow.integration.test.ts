/**
 * Integration test: end-to-end Fleet driver workflow against a real database.
 *
 * Exercises the full happy path:
 *   owner approves driver
 *     -> bearer token issued exactly once
 *     -> GET /fleet/me with token
 *     -> owner assigns driver to a seeded native order
 *     -> GET /fleet/me/orders shows the assignment
 *     -> PATCH /fleet/me/orders/:id/status accepted -> picked_up
 *        (verifies accepted_at / picked_up_at timestamps are set)
 *     -> POST /fleet/me/orders/:id/proof-of-delivery
 *        (verifies assignment.status flips to 'delivered' + delivered_at set)
 *
 * Negative cases:
 *   - Revoked token returns 401.
 *   - A non-approved driver's token is treated as revoked (rejected with 401).
 *   - Status transitions stamp the right timestamps and only the matching ones.
 *
 * Auth/workspace middleware is mocked for the OWNER endpoints so the test does
 * not require a Clerk session. Driver-token endpoints use the real
 * `requireDriverToken` middleware against the real database, so the token
 * issuance and validation paths are fully exercised.
 *
 * Skips automatically when DATABASE_URL is not set.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import pg from "pg";
import type { WorkspaceRequest } from "../lib/workspace";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;

const OWNER_ID = "__fleet_workflow_owner__";

// ─────────────────────────────────────────────────────────────────────────────
// Mocks: only auth + workspace + logger. db is the real module.
// The driver-token endpoints in fleet.ts run BEFORE these middlewares, so they
// are exercised against the real database and the real requireDriverToken.
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
    wreq.userId = OWNER_ID;
    wreq.userEmail = "fleet-workflow-owner@example.com";
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

// Imports MUST come AFTER vi.mock declarations.
import fleetRouter from "./fleet";

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(fleetRouter);
  return app;
}

async function cleanup(pool: InstanceType<typeof Pool>): Promise<void> {
  // Cascades clean up tokens, assignments, events, and PODs.
  await pool.query(
    `DELETE FROM fleet_proof_of_delivery WHERE workspace_owner_id = $1`,
    [OWNER_ID],
  );
  await pool.query(
    `DELETE FROM fleet_delivery_events WHERE workspace_owner_id = $1`,
    [OWNER_ID],
  );
  await pool.query(
    `DELETE FROM fleet_driver_order_assignments WHERE workspace_owner_id = $1`,
    [OWNER_ID],
  );
  await pool.query(
    `DELETE FROM fleet_driver_api_tokens
       WHERE driver_id IN (SELECT id FROM fleet_drivers WHERE workspace_owner_id = $1)`,
    [OWNER_ID],
  );
  await pool.query(`DELETE FROM fleet_drivers WHERE workspace_owner_id = $1`, [OWNER_ID]);
  await pool.query(
    `DELETE FROM fleet_vehicle_types WHERE workspace_owner_id = $1`,
    [OWNER_ID],
  );
  await pool.query(
    `DELETE FROM order_contacts
       WHERE order_id IN (SELECT id FROM orders WHERE workspace_owner_id = $1)`,
    [OWNER_ID],
  );
  await pool.query(`DELETE FROM orders WHERE workspace_owner_id = $1`, [OWNER_ID]);
}

async function seedDriver(
  pool: InstanceType<typeof Pool>,
  overrides: { firstName?: string; lastName?: string; status?: string } = {},
): Promise<number> {
  const r = await pool.query<{ id: number }>(
    `INSERT INTO fleet_drivers
       (workspace_owner_id, first_name, last_name, vehicle_type, onboarding_status, status)
     VALUES ($1, $2, $3, 'Motorcycle', $4, 'inactive')
     RETURNING id`,
    [
      OWNER_ID,
      overrides.firstName ?? "Driver",
      overrides.lastName ?? "Workflow",
      overrides.status ?? "pending",
    ],
  );
  return r.rows[0].id;
}

async function seedOrder(
  pool: InstanceType<typeof Pool>,
): Promise<{ orderId: string; displayOrderNumber: string }> {
  const order = await pool.query<{ id: string }>(
    `INSERT INTO orders
       (workspace_owner_id, source, external_order_id, display_order_number,
        status, delivery_address, totals, ordered_at, created_at, updated_at)
     VALUES ($1, 'native', $2, $3, 'pending',
             $4::jsonb, $5::jsonb, now(), now(), now())
     RETURNING id`,
    [
      OWNER_ID,
      "999001",
      "999001",
      JSON.stringify({ address_1: "1 Workflow St", city: "Beirut" }),
      JSON.stringify({ grand_total: "49.99", currency: "USD" }),
    ],
  );
  return { orderId: order.rows[0].id, displayOrderNumber: "999001" };
}

describe.skipIf(!DATABASE_URL)(
  "Fleet driver workflow — end-to-end (integration)",
  () => {
    let pool: InstanceType<typeof Pool>;
    let app: express.Express;

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL });
      await cleanup(pool);
      app = makeApp();
    });

    afterAll(async () => {
      if (!pool) return;
      await cleanup(pool);
      await pool.end();
    });

    beforeEach(async () => {
      // Each test owns its own seeded data; clean between tests so they are
      // independent and order-insensitive.
      await cleanup(pool);
    });

    it("happy path: approve -> token -> /me -> /me/orders -> status -> proof-of-delivery", async () => {
      const driverId = await seedDriver(pool);
      const { orderId, displayOrderNumber } = await seedOrder(pool);

      // ── 1. Owner approves driver — token returned exactly once. ────────────
      const approveRes = await request(app)
        .patch(`/fleet/drivers/${driverId}/status`)
        .send({ onboarding_status: "approved" })
        .expect(200);
      expect(approveRes.body.success).toBe(true);
      expect(approveRes.body.onboarding_status).toBe("approved");
      const token: string = approveRes.body.token;
      expect(typeof token).toBe("string");
      expect(token.startsWith("fdt_live_")).toBe(true);

      // Re-approving should NOT issue another token (idempotent moves).
      const reApprove = await request(app)
        .patch(`/fleet/drivers/${driverId}/status`)
        .send({ onboarding_status: "approved" })
        .expect(200);
      expect(reApprove.body.token).toBeNull();

      // ── 2. Driver fetches /fleet/me with the issued token. ─────────────────
      const meRes = await request(app)
        .get("/fleet/me")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(meRes.body.success).toBe(true);
      expect(meRes.body.driver.id).toBe(driverId);
      expect(meRes.body.driver.onboarding_status).toBe("approved");

      // ── 3. Owner assigns the driver to the seeded native order. ─────────────
      const assignRes = await request(app)
        .patch(`/fleet/orders/${orderId}/assign-driver`)
        .send({ driver_id: driverId })
        .expect(200);
      expect(assignRes.body.success).toBe(true);
      const assignmentId: number = assignRes.body.assignment_id;
      expect(typeof assignmentId).toBe("number");

      // ── 4. Driver lists active orders — sees the new assignment. ──────────
      const ordersRes = await request(app)
        .get("/fleet/me/orders")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);
      expect(ordersRes.body.success).toBe(true);
      expect(Array.isArray(ordersRes.body.orders)).toBe(true);
      const ord = ordersRes.body.orders.find(
        (o: { id: number }) => o.id === assignmentId,
      );
      expect(ord, "newly assigned order should be visible").toBeDefined();
      expect(ord.order_id).toBe(orderId);
      expect(ord.orderNumber).toBe(displayOrderNumber);

      // ── 5. Status transitions stamp the right timestamps. ─────────────────
      // accepted -> accepted_at set, picked_up_at + delivered_at NULL.
      await request(app)
        .patch(`/fleet/me/orders/${assignmentId}/status`)
        .set("Authorization", `Bearer ${token}`)
        .send({ status: "accepted" })
        .expect(200);
      let row = await pool.query<{
        status: string;
        accepted_at: Date | null;
        picked_up_at: Date | null;
        delivered_at: Date | null;
      }>(
        `SELECT status, accepted_at, picked_up_at, delivered_at
           FROM fleet_driver_order_assignments WHERE id = $1`,
        [assignmentId],
      );
      expect(row.rows[0].status).toBe("accepted");
      expect(row.rows[0].accepted_at).not.toBeNull();
      expect(row.rows[0].picked_up_at).toBeNull();
      expect(row.rows[0].delivered_at).toBeNull();
      const acceptedAt = row.rows[0].accepted_at;

      // picked_up -> picked_up_at set, accepted_at preserved.
      await request(app)
        .patch(`/fleet/me/orders/${assignmentId}/status`)
        .set("Authorization", `Bearer ${token}`)
        .send({ status: "picked_up" })
        .expect(200);
      row = await pool.query(
        `SELECT status, accepted_at, picked_up_at, delivered_at
           FROM fleet_driver_order_assignments WHERE id = $1`,
        [assignmentId],
      );
      expect(row.rows[0].status).toBe("picked_up");
      expect(row.rows[0].accepted_at?.toISOString()).toBe(acceptedAt?.toISOString());
      expect(row.rows[0].picked_up_at).not.toBeNull();
      expect(row.rows[0].delivered_at).toBeNull();

      // ── 6. Proof of delivery — assignment marked delivered. ───────────────
      const podRes = await request(app)
        .post(`/fleet/me/orders/${assignmentId}/proof-of-delivery`)
        .set("Authorization", `Bearer ${token}`)
        .send({ recipient_name: "Workflow Customer", notes: "Left at door" })
        .expect(201);
      expect(podRes.body.success).toBe(true);
      expect(podRes.body.assignment_id).toBe(assignmentId);

      const finalRow = await pool.query<{
        status: string;
        delivered_at: Date | null;
      }>(
        `SELECT status, delivered_at FROM fleet_driver_order_assignments WHERE id = $1`,
        [assignmentId],
      );
      expect(finalRow.rows[0].status).toBe("delivered");
      expect(finalRow.rows[0].delivered_at).not.toBeNull();

      const podRow = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM fleet_proof_of_delivery
          WHERE assignment_id = $1`,
        [assignmentId],
      );
      expect(parseInt(podRow.rows[0].count, 10)).toBe(1);
    });

    it("revoked token returns 401 on /fleet/me and /fleet/me/orders", async () => {
      const driverId = await seedDriver(pool);
      const approveRes = await request(app)
        .patch(`/fleet/drivers/${driverId}/status`)
        .send({ onboarding_status: "approved" })
        .expect(200);
      const token: string = approveRes.body.token;

      // Token works initially.
      await request(app)
        .get("/fleet/me")
        .set("Authorization", `Bearer ${token}`)
        .expect(200);

      // Revoke by deactivating the driver (owner endpoint, revokes tokens).
      await request(app)
        .patch(`/fleet/drivers/${driverId}/status`)
        .send({ onboarding_status: "deactivated", deactivation_reason: "test" })
        .expect(200);

      const meRes = await request(app)
        .get("/fleet/me")
        .set("Authorization", `Bearer ${token}`)
        .expect(401);
      expect(meRes.body.success).toBe(false);
      expect(meRes.body.error.code).toBe("INVALID_TOKEN");

      await request(app)
        .get("/fleet/me/orders")
        .set("Authorization", `Bearer ${token}`)
        .expect(401);
    });

    it("non-approved driver cannot use a leftover token", async () => {
      // Approve, capture token, then move driver back to pending.
      // Tokens are revoked on the move-out, so the leftover token is invalid.
      const driverId = await seedDriver(pool);
      const approveRes = await request(app)
        .patch(`/fleet/drivers/${driverId}/status`)
        .send({ onboarding_status: "approved" })
        .expect(200);
      const token: string = approveRes.body.token;

      await request(app)
        .patch(`/fleet/drivers/${driverId}/status`)
        .send({ onboarding_status: "pending" })
        .expect(200);

      const driverRow = await pool.query<{ onboarding_status: string }>(
        `SELECT onboarding_status FROM fleet_drivers WHERE id = $1`,
        [driverId],
      );
      expect(driverRow.rows[0].onboarding_status).toBe("pending");

      const meRes = await request(app)
        .get("/fleet/me")
        .set("Authorization", `Bearer ${token}`)
        .expect(401);
      expect(meRes.body.error.code).toBe("INVALID_TOKEN");
    });

    it("rejects requests with no Authorization header", async () => {
      const res = await request(app).get("/fleet/me").expect(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe("MISSING_TOKEN");
    });

    it("driver cannot update a status for an order they aren't assigned to", async () => {
      const driverA = await seedDriver(pool, { firstName: "Alpha" });
      const driverB = await seedDriver(pool, { firstName: "Beta" });
      const { orderId } = await seedOrder(pool);

      const approveA = await request(app)
        .patch(`/fleet/drivers/${driverA}/status`)
        .send({ onboarding_status: "approved" })
        .expect(200);
      const approveB = await request(app)
        .patch(`/fleet/drivers/${driverB}/status`)
        .send({ onboarding_status: "approved" })
        .expect(200);
      const tokenA: string = approveA.body.token;
      const tokenB: string = approveB.body.token;

      // Order is assigned to driver A.
      const assignRes = await request(app)
        .patch(`/fleet/orders/${orderId}/assign-driver`)
        .send({ driver_id: driverA })
        .expect(200);
      const assignmentId: number = assignRes.body.assignment_id;

      // Driver B has a valid token but is not assigned — must get 404.
      const res = await request(app)
        .patch(`/fleet/me/orders/${assignmentId}/status`)
        .set("Authorization", `Bearer ${tokenB}`)
        .send({ status: "accepted" })
        .expect(404);
      expect(res.body.error.code).toBe("ASSIGNMENT_NOT_FOUND");

      // Driver A succeeds.
      await request(app)
        .patch(`/fleet/me/orders/${assignmentId}/status`)
        .set("Authorization", `Bearer ${tokenA}`)
        .send({ status: "accepted" })
        .expect(200);
    });
  },
);
