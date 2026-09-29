/**
 * Integration tests: Florist Orders workflow.
 *
 * Covers the full lifecycle against a real PostgreSQL database:
 *  - POST /orders/:id/send-to-florist (owner-only, upsert-replaces assignment)
 *  - GET  /orders/:id/florist-assignment
 *  - GET  /florist-orders (member location scoping enforced server-side)
 *  - POST /florist-orders/:id/start|pause|complete (status transitions + 409s)
 *  - complete moves the parent order to ready_for_delivery
 *  - cross-location assignments are hidden (404) from members
 *
 * Auth / workspace middleware are stubbed with a mutable test context so each
 * test can act as owner or member; the database is real. Skips automatically
 * when DATABASE_URL is not set.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import pg from "pg";
import type { WorkspaceRequest } from "../lib/workspace";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;

const OWNER_ID = "__test_florist_orders__";
const MEMBER_USER_ID = "__test_florist_member__";

/** Mutable per-test caller context applied by the workspace mock. */
const ctx = {
  role: "owner" as "owner" | "member",
  userId: OWNER_ID,
  memberDbId: null as number | null,
  allowedPages: [] as string[],
};

vi.mock("../lib/auth", () => ({
  requireAuth: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => next(),
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
    wreq.workspaceRole = ctx.role;
    wreq.workspaceActualRole = ctx.role;
    wreq.userId = ctx.userId;
    wreq.memberDbId = ctx.memberDbId;
    wreq.allowedPages = ctx.allowedPages;
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
  hasPageAccess: (wreq: WorkspaceRequest, pageKey: string) =>
    wreq.workspaceRole === "owner" || !!wreq.allowedPages?.includes(pageKey),
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

const fireWebhookEventMock = vi.fn();
vi.mock("../lib/catalogWebhook", () => ({
  fireWebhookEvent: (...args: unknown[]) => fireWebhookEventMock(...args),
}));

const notifyOrderStatusEmailMock = vi.fn();
const recordOrderEventMock = vi.fn();
vi.mock("./orders", () => ({
  notifyOrderStatusEmail: (...args: unknown[]) =>
    notifyOrderStatusEmailMock(...args),
  recordOrderEvent: (...args: unknown[]) => recordOrderEventMock(...args),
}));

vi.mock("../lib/giftCardPdf", () => ({
  buildGiftCardPdf: vi.fn().mockResolvedValue(Buffer.from("%PDF-fake")),
  normalizePrintableQrLink: (value: string | null | undefined) => {
    const trimmed = (value ?? "").trim();
    return /^https?:\/\/.+/i.test(trimmed) ? trimmed : null;
  },
}));

// cardMessage's print-log path looks up the caller in Clerk; keep it offline.
vi.mock("@clerk/express", () => ({
  clerkClient: {
    users: {
      getUser: vi.fn().mockRejectedValue(new Error("clerk offline in tests")),
    },
  },
}));

import floristOrdersRouter from "./floristOrders";
import { transitionOrderStatus } from "../lib/orderStatusTransition";

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: express.Request & { log?: unknown }, _res, next) => {
    req.log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn().mockReturnThis(),
    } as unknown as express.Request["log"];
    next();
  });
  app.use(floristOrdersRouter);
  // Surface unexpected route errors in test output instead of a silent 500.
  app.use(
    (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      // eslint-disable-next-line no-console
      console.error("route error:", err);
      res.status(500).json({ success: false, error: err.message });
    },
  );
  return app;
}

function asOwner(): void {
  ctx.role = "owner";
  ctx.userId = OWNER_ID;
  ctx.memberDbId = null;
  ctx.allowedPages = [];
}

function asMember(memberDbId: number | null, pages: string[]): void {
  ctx.role = "member";
  ctx.userId = MEMBER_USER_ID;
  ctx.memberDbId = memberDbId;
  ctx.allowedPages = pages;
}

describe.skipIf(!DATABASE_URL)("Florist Orders workflow (integration)", () => {
  let pool: InstanceType<typeof Pool>;
  let app: express.Express;
  let locationA: number;
  let locationB: number;
  let memberDbId: number;

  async function cleanup(): Promise<void> {
    await pool.query(
      `DELETE FROM order_florist_assignments WHERE workspace_owner_id = $1`,
      [OWNER_ID],
    );
    await pool.query(`DELETE FROM orders WHERE workspace_owner_id = $1`, [OWNER_ID]);
    await pool.query(`DELETE FROM workspace_members WHERE workspace_owner_id = $1`, [
      OWNER_ID,
    ]);
    await pool.query(`DELETE FROM locations WHERE workspace_owner_id = $1`, [
      OWNER_ID,
    ]);
  }

  async function seedOrder(opts?: {
    cardMessage?: string | null;
    status?: string;
  }): Promise<string> {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO orders
         (workspace_owner_id, source, external_order_id, status, ordered_at,
          totals, card_message)
       VALUES ($1, 'external', $2, $3, now(), $4::jsonb, $5)
       RETURNING id`,
      [
        OWNER_ID,
        `florist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        opts?.status ?? "processing",
        JSON.stringify({ total: 25, currency: "USD" }),
        opts?.cardMessage ?? null,
      ],
    );
    const orderId = r.rows[0].id;
    await pool.query(
      `INSERT INTO order_line_items (order_id, name, quantity)
       VALUES ($1, 'Red Roses Bouquet', 2), ($1, 'Greeting Card', 1)`,
      [orderId],
    );
    return orderId;
  }

  async function sendToFlorist(orderId: string, locationId: number) {
    asOwner();
    return request(app)
      .post(`/orders/${orderId}/send-to-florist`)
      .send({ locationId });
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    app = makeApp();
    await cleanup();

    const locA = await pool.query<{ id: number }>(
      `INSERT INTO locations (workspace_owner_id, name) VALUES ($1, 'Florist A') RETURNING id`,
      [OWNER_ID],
    );
    locationA = locA.rows[0].id;
    const locB = await pool.query<{ id: number }>(
      `INSERT INTO locations (workspace_owner_id, name) VALUES ($1, 'Florist B') RETURNING id`,
      [OWNER_ID],
    );
    locationB = locB.rows[0].id;

    const member = await pool.query<{ id: number }>(
      `INSERT INTO workspace_members
         (workspace_owner_id, member_user_id, member_email, role, florist_location_id)
       VALUES ($1, $2, 'florist-member@example.com', 'member', $3)
       RETURNING id`,
      [OWNER_ID, MEMBER_USER_ID, locationA],
    );
    memberDbId = member.rows[0].id;
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  beforeEach(async () => {
    asOwner();
    fireWebhookEventMock.mockClear();
    notifyOrderStatusEmailMock.mockClear();
    recordOrderEventMock.mockClear();
    await pool.query(
      `DELETE FROM order_florist_assignments WHERE workspace_owner_id = $1`,
      [OWNER_ID],
    );
  });

  describe("parent-order completion synchronization", () => {
    it("completes pending, in-progress, and paused florist tasks with timestamps", async () => {
      for (const floristStatus of ["pending", "in_progress", "paused"] as const) {
        const orderId = await seedOrder({ status: "preparing" });
        const sent = await sendToFlorist(orderId, locationA);
        const assignmentId = sent.body.assignment.id as number;
        await pool.query(
          `UPDATE order_florist_assignments
              SET status = $1,
                  started_at = CASE WHEN $1 = 'pending' THEN NULL ELSE now() END,
                  completed_at = NULL
            WHERE id = $2`,
          [floristStatus, assignmentId],
        );

        const transition = await transitionOrderStatus(pool, {
          orderId,
          newStatus: "completed",
          workspaceOwnerId: OWNER_ID,
          actorUserId: OWNER_ID,
        });
        expect(transition.success).toBe(true);

        const assignment = await pool.query<{
          status: string;
          completed_at: string | null;
        }>(
          `SELECT status, completed_at
             FROM order_florist_assignments
            WHERE id = $1`,
          [assignmentId],
        );
        expect(assignment.rows[0].status).toBe("completed");
        expect(assignment.rows[0].completed_at).not.toBeNull();
      }
    });

    it("preserves completed timestamps and leaves unrelated or cross-workspace tasks unchanged", async () => {
      const completedOrderId = await seedOrder({ status: "preparing" });
      const completedSent = await sendToFlorist(completedOrderId, locationA);
      const completedAssignmentId = completedSent.body.assignment.id as number;
      const originalCompletedAt = "2026-08-01T12:34:56.000Z";
      await pool.query(
        `UPDATE order_florist_assignments
            SET status = 'completed', completed_at = $1
          WHERE id = $2`,
        [originalCompletedAt, completedAssignmentId],
      );

      const unrelatedOrderId = await seedOrder({ status: "preparing" });
      const unrelatedSent = await sendToFlorist(unrelatedOrderId, locationA);
      const unrelatedAssignmentId = unrelatedSent.body.assignment.id as number;

      const crossWorkspaceOrderId = await seedOrder({ status: "preparing" });
      const crossWorkspaceSent = await sendToFlorist(crossWorkspaceOrderId, locationA);
      const crossWorkspaceAssignmentId = crossWorkspaceSent.body.assignment.id as number;
      await pool.query(
        `UPDATE order_florist_assignments
            SET workspace_owner_id = '__different_workspace__'
          WHERE id = $1`,
        [crossWorkspaceAssignmentId],
      );

      await transitionOrderStatus(pool, {
        orderId: completedOrderId,
        newStatus: "completed",
        workspaceOwnerId: OWNER_ID,
        actorUserId: OWNER_ID,
      });
      await transitionOrderStatus(pool, {
        orderId: crossWorkspaceOrderId,
        newStatus: "completed",
        workspaceOwnerId: OWNER_ID,
        actorUserId: OWNER_ID,
      });

      const assignments = await pool.query<{
        id: number;
        status: string;
        completed_at: string | null;
      }>(
        `SELECT id, status, completed_at
           FROM order_florist_assignments
          WHERE id = ANY($1::int[])
          ORDER BY id`,
        [[completedAssignmentId, unrelatedAssignmentId, crossWorkspaceAssignmentId]],
      );
      const byId = new Map(assignments.rows.map((row) => [row.id, row]));

      expect(new Date(byId.get(completedAssignmentId)!.completed_at!).toISOString()).toBe(
        originalCompletedAt,
      );
      expect(byId.get(unrelatedAssignmentId)).toMatchObject({
        status: "pending",
        completed_at: null,
      });
      expect(byId.get(crossWorkspaceAssignmentId)).toMatchObject({
        status: "pending",
        completed_at: null,
      });
    });

    it("does not complete a florist task for a non-completed parent transition", async () => {
      const orderId = await seedOrder({ status: "processing" });
      const sent = await sendToFlorist(orderId, locationA);
      const assignmentId = sent.body.assignment.id as number;

      const transition = await transitionOrderStatus(pool, {
        orderId,
        newStatus: "preparing",
        workspaceOwnerId: OWNER_ID,
        actorUserId: OWNER_ID,
      });
      expect(transition.success).toBe(true);

      const assignment = await pool.query<{ status: string; completed_at: string | null }>(
        `SELECT status, completed_at FROM order_florist_assignments WHERE id = $1`,
        [assignmentId],
      );
      expect(assignment.rows[0]).toMatchObject({
        status: "pending",
        completed_at: null,
      });
    });
  });

  // ── send-to-florist ────────────────────────────────────────────────────────

  it("owner sends an order to a florist location (pending assignment)", async () => {
    const orderId = await seedOrder();
    const res = await sendToFlorist(orderId, locationA);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.assignment).toMatchObject({
      order_id: orderId,
      location_id: locationA,
      status: "pending",
    });
  });

  it("keeps florist card payload and requirements tied to the primary order card", async () => {
    const orderId = await seedOrder({ cardMessage: null });
    await pool.query(
      `INSERT INTO order_card_messages
         (workspace_owner_id, order_id, card_to, card_message, card_from)
       VALUES ($1, $2, 'Extra recipient', 'Extra message only', 'Extra sender')`,
      [OWNER_ID, orderId],
    );
    await sendToFlorist(orderId, locationA);

    asMember(memberDbId, ["florist_orders"]);
    const queue = await request(app).get("/florist-orders");
    expect(queue.status).toBe(200);
    const floristOrder = queue.body.florist_orders.find(
      (entry: { order_id: string }) => entry.order_id === orderId,
    );
    expect(floristOrder).toMatchObject({
      order_id: orderId,
      has_card: false,
      card_message: null,
      card_to: null,
      card_from: null,
    });
    expect(JSON.stringify(floristOrder)).not.toContain("Extra message only");
  });

  it("does not create or reopen a florist task after the parent order is completed", async () => {
    const alreadyCompletedOrderId = await seedOrder({ status: "completed" });
    const rejectedNew = await sendToFlorist(alreadyCompletedOrderId, locationA);
    expect(rejectedNew.status).toBe(409);
    expect(rejectedNew.body.code).toBe("order_completed");
    const noAssignment = await pool.query(
      `SELECT 1 FROM order_florist_assignments WHERE order_id = $1`,
      [alreadyCompletedOrderId],
    );
    expect(noAssignment.rowCount).toBe(0);

    const orderId = await seedOrder({ status: "preparing" });
    const sent = await sendToFlorist(orderId, locationA);
    const assignmentId = sent.body.assignment.id as number;
    await transitionOrderStatus(pool, {
      orderId,
      newStatus: "completed",
      workspaceOwnerId: OWNER_ID,
      actorUserId: OWNER_ID,
    });
    const before = await pool.query<{ completed_at: string }>(
      `SELECT completed_at FROM order_florist_assignments WHERE id = $1`,
      [assignmentId],
    );

    const rejectedResend = await sendToFlorist(orderId, locationB);
    expect(rejectedResend.status).toBe(409);
    expect(rejectedResend.body.code).toBe("order_completed");
    const after = await pool.query<{
      location_id: number;
      status: string;
      completed_at: string;
    }>(
      `SELECT location_id, status, completed_at
         FROM order_florist_assignments
        WHERE id = $1`,
      [assignmentId],
    );
    expect(after.rows[0].location_id).toBe(locationA);
    expect(after.rows[0].status).toBe("completed");
    expect(new Date(after.rows[0].completed_at).toISOString()).toBe(
      new Date(before.rows[0].completed_at).toISOString(),
    );
  });

  it("re-sending replaces the assignment and resets the task", async () => {
    const orderId = await seedOrder();
    const first = await sendToFlorist(orderId, locationA);
    const assignmentId = first.body.assignment.id;

    // Move it in_progress as the member, then re-send as owner.
    asMember(memberDbId, ["florist_orders"]);
    await request(app).post(`/florist-orders/${assignmentId}/start`);

    const second = await sendToFlorist(orderId, locationB);
    expect(second.status).toBe(200);
    expect(second.body.assignment).toMatchObject({
      id: assignmentId, // same row, upserted
      location_id: locationB,
      status: "pending",
      started_at: null,
      completed_at: null,
    });

    // Exactly one assignment per order.
    const rows = await pool.query(
      `SELECT count(*)::int AS n FROM order_florist_assignments WHERE order_id = $1`,
      [orderId],
    );
    expect(rows.rows[0].n).toBe(1);
  });

  it("auto-advances a processing order to preparing on send-to-florist", async () => {
    const orderId = await seedOrder({ status: "processing" });
    const res = await sendToFlorist(orderId, locationA);
    expect(res.status).toBe(200);

    const order = await pool.query<{ status: string }>(
      `SELECT status FROM orders WHERE id = $1`,
      [orderId],
    );
    expect(order.rows[0].status).toBe("preparing");
    expect(fireWebhookEventMock).toHaveBeenCalledWith(
      "order.status_updated",
      OWNER_ID,
      expect.objectContaining({ orderId, status: "preparing" }),
    );
    expect(recordOrderEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId,
        eventType: "status_changed",
        payload: { from: "processing", to: "preparing" },
      }),
    );
  });

  it("auto-advances a pending order to preparing on send-to-florist", async () => {
    const orderId = await seedOrder({ status: "pending" });
    const res = await sendToFlorist(orderId, locationA);
    expect(res.status).toBe(200);

    const order = await pool.query<{ status: string }>(
      `SELECT status FROM orders WHERE id = $1`,
      [orderId],
    );
    expect(order.rows[0].status).toBe("preparing");
    expect(recordOrderEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId,
        eventType: "status_changed",
        payload: { from: "pending", to: "preparing" },
      }),
    );
  });

  it("does not regress an order already at or past preparing", async () => {
    const orderId = await seedOrder({ status: "ready_for_delivery" });
    const res = await sendToFlorist(orderId, locationA);
    expect(res.status).toBe(200);

    const order = await pool.query<{ status: string }>(
      `SELECT status FROM orders WHERE id = $1`,
      [orderId],
    );
    expect(order.rows[0].status).toBe("ready_for_delivery");
    expect(fireWebhookEventMock).not.toHaveBeenCalled();
    expect(recordOrderEventMock).not.toHaveBeenCalled();
  });

  it("rejects send-to-florist from members without Orders-page access", async () => {
    const orderId = await seedOrder();
    asMember(memberDbId, ["florist_orders"]);
    const res = await request(app)
      .post(`/orders/${orderId}/send-to-florist`)
      .send({ locationId: locationA });
    expect(res.status).toBe(403);
  });

  it("allows send-to-florist from members with Orders-page access", async () => {
    const orderId = await seedOrder();
    asMember(memberDbId, ["orders"]);
    const res = await request(app)
      .post(`/orders/${orderId}/send-to-florist`)
      .send({ locationId: locationB });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.assignment).toMatchObject({
      order_id: orderId,
      location_id: locationB,
      status: "pending",
    });
  });

  it("unassigns active florist work and returns preparing orders to processing", async () => {
    const orderId = await seedOrder({ status: "processing" });
    const sent = await sendToFlorist(orderId, locationA);
    await pool.query(
      `UPDATE order_florist_assignments
          SET status = 'in_progress', started_at = now()
        WHERE id = $1`,
      [sent.body.assignment.id],
    );
    fireWebhookEventMock.mockClear();
    recordOrderEventMock.mockClear();

    const res = await request(app).delete(
      `/orders/${orderId}/florist-assignment`,
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      removed_assignment: {
        id: sent.body.assignment.id,
        order_id: orderId,
        status: "in_progress",
      },
      parent_order_status: "processing",
      status_reverted: true,
    });
    const assignment = await pool.query(
      `SELECT 1 FROM order_florist_assignments WHERE order_id = $1`,
      [orderId],
    );
    expect(assignment.rowCount).toBe(0);
    const order = await pool.query<{ status: string }>(
      `SELECT status FROM orders WHERE id = $1`,
      [orderId],
    );
    expect(order.rows[0].status).toBe("processing");
    expect(fireWebhookEventMock).toHaveBeenCalledWith(
      "order.status_updated",
      OWNER_ID,
      expect.objectContaining({ orderId, status: "processing" }),
    );
    expect(recordOrderEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId,
        eventType: "status_changed",
        payload: { from: "preparing", to: "processing" },
      }),
    );
  });

  it("returns a preparing order to processing when a pending assignment is unassigned", async () => {
    const orderId = await seedOrder({ status: "processing" });
    const sent = await sendToFlorist(orderId, locationA);
    expect(sent.body.assignment.status).toBe("pending");
    fireWebhookEventMock.mockClear();
    recordOrderEventMock.mockClear();
    notifyOrderStatusEmailMock.mockClear();

    const res = await request(app).delete(
      `/orders/${orderId}/florist-assignment`,
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      removed_assignment: {
        id: sent.body.assignment.id,
        order_id: orderId,
        status: "pending",
      },
      parent_order_status: "processing",
      status_reverted: true,
    });
    const assignment = await pool.query(
      `SELECT 1 FROM order_florist_assignments WHERE order_id = $1`,
      [orderId],
    );
    expect(assignment.rowCount).toBe(0);
    const order = await pool.query<{ status: string }>(
      `SELECT status FROM orders WHERE id = $1`,
      [orderId],
    );
    expect(order.rows[0].status).toBe("processing");
    expect(fireWebhookEventMock).toHaveBeenCalledTimes(1);
    expect(fireWebhookEventMock).toHaveBeenCalledWith(
      "order.status_updated",
      OWNER_ID,
      expect.objectContaining({ orderId, status: "processing" }),
    );
    expect(recordOrderEventMock).toHaveBeenCalledTimes(1);
    expect(recordOrderEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId,
        eventType: "status_changed",
        payload: { from: "preparing", to: "processing" },
      }),
    );
    expect(notifyOrderStatusEmailMock).toHaveBeenCalledTimes(1);
    expect(notifyOrderStatusEmailMock).toHaveBeenCalledWith(
      orderId,
      expect.any(String),
      "processing",
      OWNER_ID,
    );
  });

  it("returns paused florist work to processing when unassigned", async () => {
    const orderId = await seedOrder({ status: "processing" });
    const sent = await sendToFlorist(orderId, locationA);
    await pool.query(
      `UPDATE order_florist_assignments
          SET status = 'paused', started_at = now()
        WHERE id = $1`,
      [sent.body.assignment.id],
    );

    const res = await request(app).delete(
      `/orders/${orderId}/florist-assignment`,
    );

    expect(res.status).toBe(200);
    expect(res.body.status_reverted).toBe(true);
    expect(res.body.parent_order_status).toBe("processing");
    const order = await pool.query<{ status: string }>(
      `SELECT status FROM orders WHERE id = $1`,
      [orderId],
    );
    expect(order.rows[0].status).toBe("processing");
  });

  it("allows Orders-page members to unassign but denies florist-only members", async () => {
    const deniedOrderId = await seedOrder();
    await sendToFlorist(deniedOrderId, locationA);
    asMember(memberDbId, ["florist_orders"]);
    const denied = await request(app).delete(
      `/orders/${deniedOrderId}/florist-assignment`,
    );
    expect(denied.status).toBe(403);

    const allowedOrderId = await seedOrder();
    await sendToFlorist(allowedOrderId, locationB);
    asMember(memberDbId, ["orders"]);
    const allowed = await request(app).delete(
      `/orders/${allowedOrderId}/florist-assignment`,
    );
    expect(allowed.status).toBe(200);
    expect(allowed.body.removed_assignment.order_id).toBe(allowedOrderId);
  });

  it("protects completed assignments and later parent fulfillment statuses", async () => {
    const completedOrderId = await seedOrder({ status: "preparing" });
    const completed = await sendToFlorist(completedOrderId, locationA);
    await pool.query(
      `UPDATE order_florist_assignments
          SET status = 'completed', completed_at = now()
        WHERE id = $1`,
      [completed.body.assignment.id],
    );
    const completedRes = await request(app).delete(
      `/orders/${completedOrderId}/florist-assignment`,
    );
    expect(completedRes.status).toBe(409);
    expect(completedRes.body.code).toBe("assignment_completed");

    const laterOrderId = await seedOrder({ status: "ready_for_delivery" });
    await sendToFlorist(laterOrderId, locationA);
    const laterRes = await request(app).delete(
      `/orders/${laterOrderId}/florist-assignment`,
    );
    expect(laterRes.status).toBe(409);
    expect(laterRes.body.code).toBe("order_fulfillment_started");
    const order = await pool.query<{ status: string }>(
      `SELECT status FROM orders WHERE id = $1`,
      [laterOrderId],
    );
    expect(order.rows[0].status).toBe("ready_for_delivery");
  });

  it("returns a conflict when the assignment was already unassigned", async () => {
    const orderId = await seedOrder();
    await sendToFlorist(orderId, locationA);
    const first = await request(app).delete(
      `/orders/${orderId}/florist-assignment`,
    );
    expect(first.status).toBe(200);

    const second = await request(app).delete(
      `/orders/${orderId}/florist-assignment`,
    );
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("florist_assignment_conflict");
  });

  it("404s on unknown order or location", async () => {
    const orderId = await seedOrder();
    asOwner();
    const badOrder = await request(app)
      .post(`/orders/00000000-0000-0000-0000-000000000000/send-to-florist`)
      .send({ locationId: locationA });
    expect(badOrder.status).toBe(404);

    const badLocation = await sendToFlorist(orderId, 99999999);
    expect(badLocation.status).toBe(404);
  });

  it("exposes the current assignment via GET /orders/:id/florist-assignment", async () => {
    const orderId = await seedOrder();
    await sendToFlorist(orderId, locationA);
    const res = await request(app).get(`/orders/${orderId}/florist-assignment`);
    expect(res.status).toBe(200);
    expect(res.body.assignment).toMatchObject({
      order_id: orderId,
      location_id: locationA,
      location_name: "Florist A",
      status: "pending",
    });

    const other = await seedOrder();
    const none = await request(app).get(`/orders/${other}/florist-assignment`);
    expect(none.body.assignment).toBeNull();
  });

  it("exposes approved verification photos once the status is approved", async () => {
    const orderId = await seedOrder();
    await sendToFlorist(orderId, locationA);

    // Photos not yet approved — hidden.
    await pool.query(
      `UPDATE order_florist_assignments
          SET photo_items_path = '/objects/private/items.jpg',
              photo_card_path = '/objects/private/card.jpg'
        WHERE order_id = $1 AND workspace_owner_id = $2`,
      [orderId, OWNER_ID],
    );
    const pending = await request(app).get(`/orders/${orderId}/florist-assignment`);
    expect(pending.status).toBe(200);
    expect(pending.body.assignment).toMatchObject({
      photo_items_path: null,
      photo_card_path: null,
    });

    // Photos approved — now visible.
    await pool.query(
      `UPDATE order_florist_assignments
          SET verification_status = 'approved',
              verified_at = now()
        WHERE order_id = $1 AND workspace_owner_id = $2`,
      [orderId, OWNER_ID],
    );
    const approved = await request(app).get(`/orders/${orderId}/florist-assignment`);
    expect(approved.status).toBe(200);
    expect(approved.body.assignment).toMatchObject({
      photo_items_path: "/objects/private/items.jpg",
      photo_card_path: "/objects/private/card.jpg",
    });

    // Reassignment wipes photos regardless.
    await sendToFlorist(orderId, locationB);
    const reassigned = await request(app).get(`/orders/${orderId}/florist-assignment`);
    expect(reassigned.status).toBe(200);
    expect(reassigned.body.assignment).toMatchObject({
      location_id: locationB,
      photo_items_path: null,
      photo_card_path: null,
    });
  });

  it("keeps approved florist photos accessible after ready-for-delivery becomes completed", async () => {
    const orderId = await seedOrder({ status: "ready_for_delivery" });
    await sendToFlorist(orderId, locationA);
    await pool.query(
      `UPDATE order_florist_assignments
          SET status = 'completed',
              photo_items_path = '/objects/private/completed-items.jpg',
              photo_card_path = '/objects/private/completed-card.jpg',
              verification_status = 'approved',
              verified_at = now()
        WHERE order_id = $1 AND workspace_owner_id = $2`,
      [orderId, OWNER_ID],
    );

    const ready = await request(app).get(`/orders/${orderId}/florist-assignment`);
    expect(ready.status).toBe(200);
    expect(ready.body.assignment).toMatchObject({
      order_id: orderId,
      status: "completed",
      parent_order_status: "ready_for_delivery",
      photo_items_path: "/objects/private/completed-items.jpg",
      photo_card_path: "/objects/private/completed-card.jpg",
    });

    const transition = await transitionOrderStatus(pool, {
      orderId,
      newStatus: "completed",
      workspaceOwnerId: OWNER_ID,
      actorUserId: OWNER_ID,
    });
    expect(transition.success).toBe(true);

    const completed = await request(app).get(`/orders/${orderId}/florist-assignment`);
    expect(completed.status).toBe(200);
    expect(completed.body.assignment).toMatchObject({
      order_id: orderId,
      status: "completed",
      parent_order_status: "completed",
      photo_items_path: "/objects/private/completed-items.jpg",
      photo_card_path: "/objects/private/completed-card.jpg",
      publication: {
        feed_eligibility: {
          eligible: true,
          eligible_photo_count: 1,
          reasons: [],
        },
      },
    });
  });

  // ── florist queue scoping ─────────────────────────────────────────────────

  it("scopes the member queue to their florist location and hides PII", async () => {
    const orderA = await seedOrder({ cardMessage: "Happy Birthday!" });
    const orderB = await seedOrder();
    await sendToFlorist(orderA, locationA);
    await sendToFlorist(orderB, locationB);

    asMember(memberDbId, ["florist_orders"]);
    const res = await request(app).get(`/florist-orders`);
    expect(res.status).toBe(200);
    expect(res.body.florist_orders).toHaveLength(1);
    const card = res.body.florist_orders[0];
    expect(card.order_id).toBe(orderA);
    expect(card.location_id).toBe(locationA);
    expect(card.has_card).toBe(true);
    expect(card.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Red Roses Bouquet", quantity: 2 }),
      ]),
    );
    // No customer PII fields in the payload. (Card fields — message/from/to —
    // are intentionally exposed since florists print the gift card.)
    expect(card).not.toHaveProperty("customer_name");
    expect(card).not.toHaveProperty("customer_phone");
    expect(JSON.stringify(res.body)).not.toContain("customer_email");
  });

  it("gives Orders reviewers a cross-location queue containing only complete active AI rejections", async () => {
    const reviewA = await seedOrder({ cardMessage: "Happy birthday" });
    const reviewB = await seedOrder({ cardMessage: "Thinking of you" });
    const incomplete = await seedOrder({ cardMessage: "With love" });
    const alreadyApproved = await seedOrder({ cardMessage: "Congratulations" });
    await sendToFlorist(reviewA, locationA);
    await sendToFlorist(reviewB, locationB);
    await sendToFlorist(incomplete, locationA);
    await sendToFlorist(alreadyApproved, locationB);

    await pool.query(
      `UPDATE order_florist_assignments
          SET status = 'in_progress',
              photo_items_path = '/objects/private/items.jpg',
              photo_card_path = '/objects/private/card.jpg',
              verification_status = 'rejected',
              verification_result = '{"approved":false,"reason_code":"unclear_photo","reason":"Image too dark"}'::jsonb,
              verified_at = now()
        WHERE order_id = ANY($1::uuid[])`,
      [[reviewA, reviewB, incomplete, alreadyApproved]],
    );
    await pool.query(
      `UPDATE order_florist_assignments
          SET photo_card_path = NULL
        WHERE order_id = $1`,
      [incomplete],
    );
    await pool.query(
      `UPDATE order_florist_assignments
          SET verification_status = 'approved',
              verification_result =
                verification_result
                || '{"manual_override":{"actor_user_id":"reviewer","overridden_at":"2026-08-17T09:30:00Z"}}'::jsonb
        WHERE order_id = $1`,
      [alreadyApproved],
    );

    asMember(null, ["orders"]);
    const queue = await request(app).get("/florist-orders/manual-review");
    expect(queue.status).toBe(200);
    expect(queue.body.manual_reviews).toHaveLength(2);
    expect(queue.body.manual_reviews).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          order_id: reviewA,
          location_id: locationA,
          location_name: "Florist A",
          verification_reason: "Image too dark",
        }),
        expect.objectContaining({
          order_id: reviewB,
          location_id: locationB,
          location_name: "Florist B",
        }),
      ]),
    );
    expect(
      queue.body.manual_reviews.map((review: { order_id: string }) => review.order_id),
    ).not.toEqual(expect.arrayContaining([incomplete, alreadyApproved]));

    const count = await request(app).get("/florist-orders/manual-review/count");
    expect(count.status).toBe(200);
    expect(count.body).toEqual({ success: true, count: 2 });

    asMember(memberDbId, ["florist_orders"]);
    const forbidden = await request(app).get("/florist-orders/manual-review");
    expect(forbidden.status).toBe(403);
  });

  it("includes items-only no-card evidence in the review queue", async () => {
    const orderId = await seedOrder({ cardMessage: null });
    await sendToFlorist(orderId, locationA);
    await pool.query(
      `UPDATE order_florist_assignments
          SET status = 'in_progress',
              photo_items_path = '/objects/private/no-card-items.jpg',
              photo_card_path = NULL,
              verification_status = 'rejected',
              verification_result = '{"approved":false,"reason_code":"unclear_photo"}'::jsonb,
              verified_at = now()
        WHERE order_id = $1`,
      [orderId],
    );

    asMember(null, ["orders"]);
    const review = await request(app).get("/florist-orders/manual-review");
    expect(review.status).toBe(200);
    expect(review.body.manual_reviews).toEqual([
      expect.objectContaining({
        order_id: orderId,
        photo_items_path: "/objects/private/no-card-items.jpg",
        photo_card_path: null,
      }),
    ]);
    const count = await request(app).get("/florist-orders/manual-review/count");
    expect(count.body).toEqual({ success: true, count: 1 });
  });

  it("exposes product_id and recipe entries on line items", async () => {
    // Product with a two-entry recipe and a description.
    const product = await pool.query<{ id: number }>(
      `INSERT INTO products (workspace_owner_id, name, description)
       VALUES ($1, 'Rose Box', 'A dozen red roses in a hat box.') RETURNING id`,
      [OWNER_ID],
    );
    const productId = product.rows[0].id;
    const rose = await pool.query<{ id: number }>(
      `INSERT INTO base_items (workspace_owner_id, name, code, image_url)
       VALUES ($1, 'Red Rose', 'FL-ROSE-1', '/objects/x/rose.jpg') RETURNING id`,
      [OWNER_ID],
    );
    const ribbon = await pool.query<{ id: number }>(
      `INSERT INTO base_items (workspace_owner_id, name, code) VALUES ($1, 'Ribbon', 'FL-RIBBON-1') RETURNING id`,
      [OWNER_ID],
    );
    await pool.query(
      `INSERT INTO product_recipes (workspace_owner_id, product_id, base_item_id, quantity, sort_order)
       VALUES ($1, $2, $3, 12, 0), ($1, $2, $4, 1, 1)`,
      [OWNER_ID, productId, rose.rows[0].id, ribbon.rows[0].id],
    );

    const orderId = await seedOrder();
    await pool.query(
      `INSERT INTO order_line_items (order_id, name, quantity, product_id)
       VALUES ($1, 'Rose Box', 1, $2)`,
      [orderId, productId],
    );
    await sendToFlorist(orderId, locationA);

    asMember(memberDbId, ["florist_orders"]);
    const res = await request(app).get(`/florist-orders`);
    expect(res.status).toBe(200);
    const card = res.body.florist_orders.find(
      (c: { order_id: string }) => c.order_id === orderId,
    );
    expect(card).toBeDefined();

    const recipeItem = card.items.find(
      (i: { name: string }) => i.name === "Rose Box",
    );
    expect(recipeItem.product_id).toBe(productId);
    expect(recipeItem.description).toBe("A dozen red roses in a hat box.");
    expect(recipeItem.recipe).toEqual([
      expect.objectContaining({
        base_item_name: "Red Rose",
        base_item_image_url: "/objects/x/rose.jpg",
      }),
      expect.objectContaining({ base_item_name: "Ribbon" }),
    ]);
    expect(Number(recipeItem.recipe[0].quantity)).toBe(12);

    // Items without a linked product return an empty recipe.
    const plainItem = card.items.find(
      (i: { name: string }) => i.name === "Greeting Card",
    );
    expect(plainItem.product_id).toBeNull();
    expect(plainItem.description).toBeNull();
    expect(plainItem.recipe).toEqual([]);

    await pool.query(`DELETE FROM products WHERE id = $1`, [productId]);
    await pool.query(`DELETE FROM base_items WHERE id = ANY($1::int[])`, [
      [rose.rows[0].id, ribbon.rows[0].id],
    ]);
  });

  it("falls back to the product image and recipe for legacy items with null product_id", async () => {
    // Product with sku, main image, and a recipe.
    const product = await pool.query<{ id: number }>(
      `INSERT INTO products (workspace_owner_id, name, sku, main_image_url)
       VALUES ($1, 'Tulip Bundle', 'TULIP-9', '/objects/x/tulip.jpg') RETURNING id`,
      [OWNER_ID],
    );
    const productId = product.rows[0].id;
    const tulip = await pool.query<{ id: number }>(
      `INSERT INTO base_items (workspace_owner_id, name, code, image_url)
       VALUES ($1, 'Tulip', 'FL-TULIP-1', '/objects/x/tulip-base.jpg') RETURNING id`,
      [OWNER_ID],
    );
    await pool.query(
      `INSERT INTO product_recipes (workspace_owner_id, product_id, base_item_id, quantity, sort_order)
       VALUES ($1, $2, $3, 9, 0)`,
      [OWNER_ID, productId, tulip.rows[0].id],
    );

    const orderId = await seedOrder();
    // Legacy rows: one matched by sku, one matched by name, both with null
    // product_id and null image_url (as ingested before the fix).
    await pool.query(
      `INSERT INTO order_line_items (order_id, name, quantity, sku)
       VALUES ($1, 'Some Old Name', 1, 'TULIP-9'),
              ($1, 'tulip bundle', 2, 'unmatched-sku')`,
      [orderId],
    );
    await sendToFlorist(orderId, locationA);

    asMember(memberDbId, ["florist_orders"]);
    const res = await request(app).get(`/florist-orders`);
    expect(res.status).toBe(200);
    const card = res.body.florist_orders.find(
      (c: { order_id: string }) => c.order_id === orderId,
    );
    expect(card).toBeDefined();

    // Matched by exact sku.
    const bySku = card.items.find((i: { name: string }) => i.name === "Some Old Name");
    expect(bySku.product_id).toBe(productId);
    expect(bySku.image_url).toBe("/objects/x/tulip.jpg");
    expect(bySku.recipe).toEqual([
      expect.objectContaining({
        base_item_name: "Tulip",
        base_item_image_url: "/objects/x/tulip-base.jpg",
      }),
    ]);

    // Matched by exact (case-insensitive) name.
    const byName = card.items.find((i: { name: string }) => i.name === "tulip bundle");
    expect(byName.product_id).toBe(productId);
    expect(byName.image_url).toBe("/objects/x/tulip.jpg");
    expect(byName.recipe).toHaveLength(1);

    // Unmatched items degrade gracefully: no image, no recipe, no error.
    const unmatched = card.items.find(
      (i: { name: string }) => i.name === "Red Roses Bouquet",
    );
    expect(unmatched.product_id).toBeNull();
    expect(unmatched.image_url).toBeNull();
    expect(unmatched.recipe).toEqual([]);

    await pool.query(`DELETE FROM products WHERE id = $1`, [productId]);
    await pool.query(`DELETE FROM base_items WHERE id = $1`, [tulip.rows[0].id]);
  });

  it("falls back to the linked product's main image when the item image is null", async () => {
    const product = await pool.query<{ id: number }>(
      `INSERT INTO products (workspace_owner_id, name, main_image_url)
       VALUES ($1, 'Orchid Pot', '/objects/x/orchid.jpg') RETURNING id`,
      [OWNER_ID],
    );
    const productId = product.rows[0].id;

    const orderId = await seedOrder();
    await pool.query(
      `INSERT INTO order_line_items (order_id, name, quantity, product_id)
       VALUES ($1, 'Orchid Pot', 1, $2)`,
      [orderId, productId],
    );
    await sendToFlorist(orderId, locationA);

    asMember(memberDbId, ["florist_orders"]);
    const res = await request(app).get(`/florist-orders`);
    expect(res.status).toBe(200);
    const card = res.body.florist_orders.find(
      (c: { order_id: string }) => c.order_id === orderId,
    );
    const item = card.items.find((i: { name: string }) => i.name === "Orchid Pot");
    expect(item.image_url).toBe("/objects/x/orchid.jpg");

    await pool.query(`DELETE FROM products WHERE id = $1`, [productId]);
  });

  it("owner sees all locations and can filter with ?location_id=", async () => {
    const orderA = await seedOrder();
    const orderB = await seedOrder();
    await sendToFlorist(orderA, locationA);
    await sendToFlorist(orderB, locationB);

    asOwner();
    const all = await request(app).get(`/florist-orders`);
    expect(all.body.florist_orders).toHaveLength(2);

    const onlyB = await request(app).get(`/florist-orders?location_id=${locationB}`);
    expect(onlyB.body.florist_orders).toHaveLength(1);
    expect(onlyB.body.florist_orders[0].order_id).toBe(orderB);
  });

  it("403s members without the florist_orders page or without a location", async () => {
    asMember(memberDbId, []); // no page access
    const noPage = await request(app).get(`/florist-orders`);
    expect(noPage.status).toBe(403);

    // Member with page access but no florist_location_id configured.
    const bare = await pool.query<{ id: number }>(
      `INSERT INTO workspace_members
         (workspace_owner_id, member_user_id, member_email, role)
       VALUES ($1, '__test_florist_bare__', 'bare@example.com', 'member')
       RETURNING id`,
      [OWNER_ID],
    );
    asMember(bare.rows[0].id, ["florist_orders"]);
    const noLocation = await request(app).get(`/florist-orders`);
    expect(noLocation.status).toBe(403);
    await pool.query(`DELETE FROM workspace_members WHERE id = $1`, [
      bare.rows[0].id,
    ]);
  });

  // ── lifecycle transitions ─────────────────────────────────────────────────

  /**
   * Satisfy the photo verification completion gate directly in the DB (photos
   * present, AI approved) so lifecycle tests can complete.
   */
  async function satisfyVerificationGate(assignmentId: number) {
    await pool.query(
      `UPDATE order_florist_assignments
          SET card_printed_at = now(),
              photo_items_path = '/objects/${OWNER_ID}/uploads/test-items',
              photo_card_path = '/objects/${OWNER_ID}/uploads/test-card',
              verification_status = 'approved',
              verified_at = now()
        WHERE id = $1`,
      [assignmentId],
    );
  }

  it("walks pending → in_progress ⇄ paused → completed and sets ready_for_delivery", async () => {
    const orderId = await seedOrder();
    const sent = await sendToFlorist(orderId, locationA);
    const id = sent.body.assignment.id;
    await satisfyVerificationGate(id);

    asMember(memberDbId, ["florist_orders"]);

    const started = await request(app).post(`/florist-orders/${id}/start`);
    expect(started.status).toBe(200);
    expect(started.body.assignment.status).toBe("in_progress");
    expect(started.body.assignment.started_at).not.toBeNull();

    const paused = await request(app).post(`/florist-orders/${id}/pause`);
    expect(paused.body.assignment.status).toBe("paused");

    const resumed = await request(app).post(`/florist-orders/${id}/start`);
    expect(resumed.body.assignment.status).toBe("in_progress");

    const completed = await request(app).post(`/florist-orders/${id}/complete`);
    expect(completed.status).toBe(200);
    expect(completed.body.assignment.status).toBe("completed");
    expect(completed.body.assignment.completed_at).not.toBeNull();

    const order = await pool.query<{ status: string }>(
      `SELECT status FROM orders WHERE id = $1`,
      [orderId],
    );
    expect(order.rows[0].status).toBe("ready_for_delivery");
    expect(fireWebhookEventMock).toHaveBeenCalledWith(
      "order.status_updated",
      OWNER_ID,
      expect.objectContaining({ orderId, status: "ready_for_delivery" }),
    );
    expect(notifyOrderStatusEmailMock).toHaveBeenCalled();
  });

  it("409s invalid transitions", async () => {
    const orderId = await seedOrder();
    const sent = await sendToFlorist(orderId, locationA);
    const id = sent.body.assignment.id;

    asMember(memberDbId, ["florist_orders"]);

    // pause before start
    const pauseEarly = await request(app).post(`/florist-orders/${id}/pause`);
    expect(pauseEarly.status).toBe(409);
    // complete before start
    const completeEarly = await request(app).post(`/florist-orders/${id}/complete`);
    expect(completeEarly.status).toBe(409);

    await satisfyVerificationGate(id);
    await request(app).post(`/florist-orders/${id}/start`);
    await request(app).post(`/florist-orders/${id}/complete`);

    // already completed
    const startAgain = await request(app).post(`/florist-orders/${id}/start`);
    expect(startAgain.status).toBe(409);
  });

  it("blocks completion until the photo verification gate is satisfied", async () => {
    const orderId = await seedOrder();
    const sent = await sendToFlorist(orderId, locationA);
    const id = sent.body.assignment.id;

    asMember(memberDbId, ["florist_orders"]);
    await request(app).post(`/florist-orders/${id}/start`);

    // No photos yet.
    const noPhotos = await request(app).post(`/florist-orders/${id}/complete`);
    expect(noPhotos.status).toBe(409);
    expect(noPhotos.body.code).toBe("photos_required");

    // Photos present but not verified.
    await pool.query(
      `UPDATE order_florist_assignments
          SET photo_items_path = '/objects/${OWNER_ID}/uploads/gate-items',
              photo_card_path = '/objects/${OWNER_ID}/uploads/gate-card'
        WHERE id = $1`,
      [id],
    );
    const notVerified = await request(app).post(`/florist-orders/${id}/complete`);
    expect(notVerified.status).toBe(409);
    expect(notVerified.body.code).toBe("verification_required");

    // Approved — now fully satisfied.
    await pool.query(
      `UPDATE order_florist_assignments
          SET verification_status = 'approved', verified_at = now()
        WHERE id = $1`,
      [id],
    );
    const done = await request(app).post(`/florist-orders/${id}/complete`);
    expect(done.status).toBe(200);
    expect(done.body.assignment.status).toBe("completed");
  });

  it("an order with only card_to/qr_link (no printable message) is not print-gated and can complete", async () => {
    // has_card must mean "printable card message exists" — the print route
    // rejects message-less orders with no_card_message, so gating completion
    // on printing for to/from/QR-only orders would be an unresolvable dead end.
    const orderId = await seedOrder({ cardMessage: null });
    await pool.query(
      `UPDATE orders SET card_to = 'Alice', qr_link = 'https://example.com/qr' WHERE id = $1`,
      [orderId],
    );
    const sent = await sendToFlorist(orderId, locationA);
    const id = sent.body.assignment.id;

    asMember(memberDbId, ["florist_orders"]);
    const list = await request(app).get(`/florist-orders`);
    const card = list.body.florist_orders.find(
      (c: { order_id: string }) => c.order_id === orderId,
    );
    expect(card.has_card).toBe(false);

    await request(app).post(`/florist-orders/${id}/start`);
    // Satisfy the photo/AI gate but leave card_printed_at NULL.
    await pool.query(
      `UPDATE order_florist_assignments
          SET photo_items_path = '/objects/${OWNER_ID}/uploads/nocard-items',
              photo_card_path = NULL,
              verification_status = 'approved',
              verified_at = now()
        WHERE id = $1`,
      [id],
    );
    const done = await request(app).post(`/florist-orders/${id}/complete`);
    expect(done.status).toBe(200);
    expect(done.body.assignment.status).toBe("completed");
  });

  it("an empty/whitespace card_message is not print-gated (no deadlock)", async () => {
    // '' and '   ' are unprintable (the print route rejects them with
    // no_card_message), so has_card must be false or the order could never
    // complete.
    const orderId = await seedOrder({ cardMessage: "   " });
    const sent = await sendToFlorist(orderId, locationA);
    const id = sent.body.assignment.id;

    asMember(memberDbId, ["florist_orders"]);
    const list = await request(app).get(`/florist-orders`);
    const card = list.body.florist_orders.find(
      (c: { order_id: string }) => c.order_id === orderId,
    );
    expect(card.has_card).toBe(false);

    await request(app).post(`/florist-orders/${id}/start`);
    await pool.query(
      `UPDATE order_florist_assignments
          SET photo_items_path = '/objects/${OWNER_ID}/uploads/blank-items',
              photo_card_path = NULL,
              verification_status = 'approved',
              verified_at = now()
        WHERE id = $1`,
      [id],
    );
    const done = await request(app).post(`/florist-orders/${id}/complete`);
    expect(done.status).toBe(200);
  });

  it("a card message added concurrently (after load, before the UPDATE) blocks unprinted completion", async () => {
    // The completion UPDATE re-evaluates the printable-card predicate against
    // the orders row, so a card added after the pre-checks cannot slip through
    // without a print.
    const orderId = await seedOrder({ cardMessage: null });
    const sent = await sendToFlorist(orderId, locationA);
    const id = sent.body.assignment.id;

    asMember(memberDbId, ["florist_orders"]);
    await request(app).post(`/florist-orders/${id}/start`);
    await pool.query(
      `UPDATE order_florist_assignments
          SET photo_items_path = '/objects/${OWNER_ID}/uploads/race-items',
              photo_card_path = '/objects/${OWNER_ID}/uploads/race-card',
              verification_status = 'approved',
              verified_at = now()
        WHERE id = $1`,
      [id],
    );
    // Simulate the race: the card appears on the order right before complete.
    await pool.query(`UPDATE orders SET card_message = 'Added late!' WHERE id = $1`, [
      orderId,
    ]);
    const blocked = await request(app).post(`/florist-orders/${id}/complete`);
    expect(blocked.status).toBe(409);
    // Printing the card then unblocks completion.
    await pool.query(
      `UPDATE order_florist_assignments SET card_printed_at = now() WHERE id = $1`,
      [id],
    );
    const done = await request(app).post(`/florist-orders/${id}/complete`);
    expect(done.status).toBe(200);
  });

  it("reassignment wipes all verification evidence — old approval cannot complete the new assignment", async () => {
    const orderId = await seedOrder();
    const sent = await sendToFlorist(orderId, locationA);
    const id = sent.body.assignment.id;
    await satisfyVerificationGate(id);
    const before = await pool.query<{ photo_set_rev: number }>(
      `SELECT photo_set_rev FROM order_florist_assignments WHERE id = $1`,
      [id],
    );

    // Re-send (same unique row is reused): every piece of the quality-gate
    // evidence must be cleared and the photo-set revision bumped.
    const resent = await sendToFlorist(orderId, locationB);
    expect(resent.status).toBe(200);
    expect(resent.body.assignment.id).toBe(id);
    const row = await pool.query(
      `SELECT card_printed_at, photo_items_path, photo_card_path,
              verification_status, verification_result, verified_at,
              slack_sent_at, slack_pending_at, slack_attempted_rev, photo_set_rev
         FROM order_florist_assignments WHERE id = $1`,
      [id],
    );
    const a = row.rows[0];
    expect(a.card_printed_at).toBeNull();
    expect(a.photo_items_path).toBeNull();
    expect(a.photo_card_path).toBeNull();
    expect(a.verification_status).toBe("none");
    expect(a.verification_result).toBeNull();
    expect(a.verified_at).toBeNull();
    expect(a.slack_sent_at).toBeNull();
    expect(a.slack_pending_at).toBeNull();
    expect(a.slack_attempted_rev).toBeNull();
    expect(Number(a.photo_set_rev)).toBe(Number(before.rows[0].photo_set_rev) + 1);

    // The new assignment cannot complete on the old (wiped) evidence.
    asOwner();
    await request(app).post(`/florist-orders/${id}/start`);
    const blocked = await request(app).post(`/florist-orders/${id}/complete`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe("photos_required");
  });

  it("completion is atomic against a concurrent reassignment (stale request cannot complete a pending assignment)", async () => {
    const orderId = await seedOrder();
    const sent = await sendToFlorist(orderId, locationA);
    const id = sent.body.assignment.id;
    await satisfyVerificationGate(id);
    asOwner();
    await request(app).post(`/florist-orders/${id}/start`);

    // Simulate a reassignment landing between the complete route's pre-read
    // and its conditional UPDATE: the row is back to 'pending' but (in this
    // simulation) still carries gate evidence — the status predicate on the
    // completing UPDATE must refuse it.
    await pool.query(
      `UPDATE order_florist_assignments SET status = 'pending', started_at = NULL WHERE id = $1`,
      [id],
    );
    const blocked = await request(app).post(`/florist-orders/${id}/complete`);
    expect(blocked.status).toBe(409);
    const after = await pool.query<{ status: string }>(
      `SELECT status FROM order_florist_assignments WHERE id = $1`,
      [id],
    );
    expect(after.rows[0].status).toBe("pending");
  });

  // ── card-print gate binding ────────────────────────────────────────────────
  // POST /card-message/print with realOrderId must rebuild the printed payload
  // from the persisted order card fields and only ever unlock that exact
  // assignment — a forged body cannot falsify another order's printed state.
  describe("card-print gate binding", () => {
    let printApp: express.Express;
    const printFetchMock = vi.fn();
    const originalFetch = global.fetch;
    const originalWebhookUrl = process.env.CARD_PRINT_MAKE_WEBHOOK_URL;
    const BRANCH = "Gate Test Branch";

    beforeAll(async () => {
      process.env.CARD_PRINT_MAKE_WEBHOOK_URL = "https://hooks.make.test/gate";
      vi.resetModules();
      const mod = await import("./cardMessage");
      printApp = express();
      printApp.use(express.json());
      printApp.use(mod.default);
      await pool.query(
        `INSERT INTO branch_print_configs (workspace_owner_id, name, machine_id, printer_id)
         VALUES ($1, $2, 'm-gate', 'p-gate')
         ON CONFLICT DO NOTHING`,
        [OWNER_ID, BRANCH],
      );
    });

    afterAll(async () => {
      global.fetch = originalFetch;
      if (originalWebhookUrl === undefined) delete process.env.CARD_PRINT_MAKE_WEBHOOK_URL;
      else process.env.CARD_PRINT_MAKE_WEBHOOK_URL = originalWebhookUrl;
      await pool.query(
        `DELETE FROM branch_print_configs WHERE workspace_owner_id = $1 AND name = $2`,
        [OWNER_ID, BRANCH],
      );
      await pool.query(`DELETE FROM card_print_logs WHERE workspace_owner_id = $1`, [OWNER_ID]);
    });

    beforeEach(() => {
      printFetchMock.mockReset();
      printFetchMock.mockResolvedValue({ ok: true, text: () => Promise.resolve("") });
      global.fetch = printFetchMock as unknown as typeof fetch;
    });

    function printBody(realOrderId: string) {
      return {
        location: BRANCH,
        shopName: "Gate Shop",
        orderId: "FORGED-123",
        cardMessage: "forged content",
        toName: "Forged To",
        fromName: "Forged From",
        qrLink: "https://evil.example/qr",
        realOrderId,
      };
    }

    async function printedAt(orderId: string): Promise<string | null> {
      const r = await pool.query<{ card_printed_at: string | null }>(
        `SELECT card_printed_at FROM order_florist_assignments WHERE order_id = $1`,
        [orderId],
      );
      return r.rows[0]?.card_printed_at ?? null;
    }

    it("prints the persisted card and unlocks only the named assignment — forged content is ignored", async () => {
      const orderA = await seedOrder({ cardMessage: "Real card for A" });
      const orderB = await seedOrder({ cardMessage: "Real card for B" });
      await pool.query(
        `UPDATE orders SET card_to = 'Alice', card_from = 'Bob', qr_link = 'https://example.com/qr/real' WHERE id = $1`,
        [orderB],
      );
      await sendToFlorist(orderA, locationA);
      await sendToFlorist(orderB, locationA);

      const res = await request(printApp)
        .post("/card-message/print")
        .send(printBody(orderB));
      expect(res.status).toBe(200);

      // Payload sent to the printer webhook is the persisted card, not the body.
      const [, options] = printFetchMock.mock.calls[0];
      const payload = JSON.parse(options.body as string)[0];
      expect(payload["Card Message"]).toBe("Real card for B");
      expect(payload.receiverName).toBe("Alice");
      expect(payload.senderName).toBe("Bob");
      expect(payload["QR code"]).toBe("https://example.com/qr/real");
      expect(payload).not.toHaveProperty("QR Link");
      expect(payload["Order ID"]).not.toBe("FORGED-123");

      // Only B's assignment is unlocked.
      expect(await printedAt(orderB)).not.toBeNull();
      expect(await printedAt(orderA)).toBeNull();
    });

    it("404s and unlocks nothing for a realOrderId without a florist assignment", async () => {
      const bare = await seedOrder({ cardMessage: "No assignment" });
      const res = await request(printApp)
        .post("/card-message/print")
        .send(printBody(bare));
      expect(res.status).toBe(404);
      expect(printFetchMock).not.toHaveBeenCalled();
    });

    it("404s when a location-bound member targets another location's assignment", async () => {
      const orderB = await seedOrder({ cardMessage: "Cross-location card" });
      await sendToFlorist(orderB, locationB); // NOT the member's location
      asMember(memberDbId, ["florist_orders"]); // member is bound to locationA

      const res = await request(printApp)
        .post("/card-message/print")
        .send(printBody(orderB));
      expect(res.status).toBe(404);
      expect(printFetchMock).not.toHaveBeenCalled();
      expect(await printedAt(orderB)).toBeNull();
    });

    it("400s when the order has no persisted card message (cannot mint a printed state)", async () => {
      const orderNoCard = await seedOrder({ cardMessage: null });
      await sendToFlorist(orderNoCard, locationA);
      const res = await request(printApp)
        .post("/card-message/print")
        .send(printBody(orderNoCard));
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("no_card_message");
      expect(printFetchMock).not.toHaveBeenCalled();
      expect(await printedAt(orderNoCard)).toBeNull();
    });
  });

  it("/complete succeeds and marks the assignment completed when the order is already ready_for_delivery", async () => {
    // Simulate the auto-advance path: Slack send succeeded on /verify or
    // /slack-retry and already moved the order to ready_for_delivery before
    // the florist presses Complete.
    const orderId = await seedOrder({ status: "preparing" });
    const sent = await sendToFlorist(orderId, locationA);
    const id = sent.body.assignment.id;
    await satisfyVerificationGate(id);

    // Advance directly to ready_for_delivery (as autoAdvanceOrderAfterSlack does).
    await pool.query(
      `UPDATE orders SET status = 'ready_for_delivery' WHERE id = $1 AND workspace_owner_id = $2`,
      [orderId, OWNER_ID],
    );

    asMember(memberDbId, ["florist_orders"]);
    await request(app).post(`/florist-orders/${id}/start`);

    const completed = await request(app).post(`/florist-orders/${id}/complete`);
    expect(completed.status).toBe(200);
    expect(completed.body.assignment.status).toBe("completed");

    // Order must remain at ready_for_delivery — no regression.
    const order = await pool.query<{ status: string }>(
      `SELECT status FROM orders WHERE id = $1`,
      [orderId],
    );
    expect(order.rows[0].status).toBe("ready_for_delivery");

    // The /complete endpoint skipped transitionOrderStatus and its side
    // effects since the order was already at ready_for_delivery — so the
    // webhook should NOT have been fired for the ready_for_delivery transition
    // (it may have been fired for the preparing transition from sendToFlorist,
    // but seedOrder starts at 'preparing' so send-to-florist won't fire it).
    const rfwCalls = fireWebhookEventMock.mock.calls.filter(
      (c: unknown[]) =>
        c[0] === "order.status_updated" &&
        (c[2] as { status?: string })?.status === "ready_for_delivery",
    );
    expect(rfwCalls).toHaveLength(0);
  });

  it("hides cross-location assignments from members (404)", async () => {
    const orderId = await seedOrder();
    const sent = await sendToFlorist(orderId, locationB); // not the member's location
    const id = sent.body.assignment.id;

    asMember(memberDbId, ["florist_orders"]);
    const res = await request(app).post(`/florist-orders/${id}/start`);
    expect(res.status).toBe(404);
  });

  it("serves the gift-card PDF for a scoped assignment", async () => {
    const orderId = await seedOrder({ cardMessage: "With love" });
    const sent = await sendToFlorist(orderId, locationA);
    const id = sent.body.assignment.id;

    asMember(memberDbId, ["florist_orders"]);
    const res = await request(app).get(`/florist-orders/${id}/card-pdf`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
  });
});
