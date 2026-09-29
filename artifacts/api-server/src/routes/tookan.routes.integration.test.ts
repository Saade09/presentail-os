/**
 * Integration tests: Tookan fire-and-forget on order creation and the
 * POST /api/orders/:id/retry-tookan endpoint, exercised against a REAL
 * PostgreSQL database. The Tookan HTTP call is intercepted via vi.spyOn so no
 * actual network traffic leaves the test runner.
 *
 * Run via:
 *   pnpm --filter @workspace/api-server run test:integration:local
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import pg from "pg";
import type { WorkspaceRequest } from "../lib/workspace";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;

const OWNER_ID = `__tookan_test_${Date.now()}`;

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
  resolveWorkspace: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = OWNER_ID;
    wreq.workspaceRole = "owner";
    wreq.workspaceActualRole = "owner";
    wreq.allowedPages = null;
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
  hasPageAccess: () => true,
}));

vi.mock("../lib/logger", () => ({ logger: mockLogger }));

vi.mock("../lib/catalogWebhook", () => ({
  fireWebhookEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/email", () => ({
  sendOrderConfirmationEmail: vi.fn().mockResolvedValue(undefined),
  sendNewOrderStaffEmail: vi.fn().mockResolvedValue(undefined),
}));

import ordersRouter from "./orders";
import tookanWebhookRouter from "./tookanWebhook";
import { parseDeliveryWindow } from "../lib/tookan";
import { fireWebhookEvent } from "../lib/catalogWebhook";

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: Record<string, () => void> }).log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    next();
  });
  app.use("/api", ordersRouter);
  return app;
}

function makeWebhookApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api", tookanWebhookRouter);
  return app;
}

// ── parseDeliveryWindow unit tests (pure, no DB needed) ──────────────────────

describe("parseDeliveryWindow", () => {
  it("returns nulls when date is absent", () => {
    expect(parseDeliveryWindow(null, null)).toEqual({ window_start: null, window_end: null });
    expect(parseDeliveryWindow(undefined, "9am - 12pm")).toEqual({
      window_start: null,
      window_end: null,
    });
  });

  it("defaults to 09:00–21:00 when date provided but no slot", () => {
    const result = parseDeliveryWindow("2024-06-15", null);
    expect(result.window_start).toBe("2024-06-15T09:00:00.000Z");
    expect(result.window_end).toBe("2024-06-15T21:00:00.000Z");
  });

  it("parses '9am - 12pm' slot correctly", () => {
    const result = parseDeliveryWindow("2024-06-15", "9am - 12pm");
    expect(result.window_start).toBe("2024-06-15T09:00:00.000Z");
    expect(result.window_end).toBe("2024-06-15T12:00:00.000Z");
  });

  it("parses '14:00 - 17:00' slot correctly", () => {
    const result = parseDeliveryWindow("2024-06-15", "14:00 - 17:00");
    expect(result.window_start).toBe("2024-06-15T14:00:00.000Z");
    expect(result.window_end).toBe("2024-06-15T17:00:00.000Z");
  });

  it("infers end +3h when only start time in slot", () => {
    const result = parseDeliveryWindow("2024-06-15", "10am");
    expect(result.window_start).toBe("2024-06-15T10:00:00.000Z");
    expect(result.window_end).toBe("2024-06-15T13:00:00.000Z");
  });

  it("handles midnight edge (12am)", () => {
    const result = parseDeliveryWindow("2024-06-15", "12am - 3am");
    expect(result.window_start).toBe("2024-06-15T00:00:00.000Z");
    expect(result.window_end).toBe("2024-06-15T03:00:00.000Z");
  });

  it("handles noon edge (12pm)", () => {
    const result = parseDeliveryWindow("2024-06-15", "12pm - 2pm");
    expect(result.window_start).toBe("2024-06-15T12:00:00.000Z");
    expect(result.window_end).toBe("2024-06-15T14:00:00.000Z");
  });
});

// ── Route-level integration tests (real DB) ───────────────────────────────────

describe.skipIf(!DATABASE_URL)(
  "Tookan retry endpoint — real DB (integration)",
  () => {
    let pool: InstanceType<typeof Pool>;
    let app: express.Express;
    let testOrderId: string;

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL });
      app = makeApp();

      // Seed a workspace_members row (required for FK on some workspace queries)
      await pool.query(
        `INSERT INTO workspace_members (workspace_owner_id, member_user_id, member_email, role, created_at)
         VALUES ($1, 'clerk_tookan_test', 'tookan_test@example.com', 'owner', now())
         ON CONFLICT DO NOTHING`,
        [OWNER_ID],
      );
    });

    afterAll(async () => {
      if (!pool) return;
      await pool.query(`DELETE FROM orders WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(
        `DELETE FROM workspace_members WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      await pool.end();
    });

    beforeEach(async () => {
      // Create a fresh order for each test
      const r = await pool.query<{ id: string }>(
        `INSERT INTO orders (workspace_owner_id, external_order_id, status, source, created_at, updated_at)
         VALUES ($1, $2, 'processing', 'external', now(), now())
         RETURNING id`,
        [OWNER_ID, `ext-tookan-${Date.now()}`],
      );
      testOrderId = r.rows[0]!.id;
    });

    afterEach(async () => {
      await pool.query(`DELETE FROM orders WHERE workspace_owner_id = $1`, [OWNER_ID]);
    });

    it("returns 400 when Tookan is not enabled (no TOOKAN_API_KEY)", async () => {
      const saved = process.env.TOOKAN_API_KEY;
      delete process.env.TOOKAN_API_KEY;
      try {
        const res = await request(app)
          .post(`/api/orders/${testOrderId}/retry-tookan`)
          .expect(400);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/not enabled/i);
      } finally {
        if (saved !== undefined) process.env.TOOKAN_API_KEY = saved;
      }
    });

    it("returns 400 when TOOKAN_ENABLED=false even with API key", async () => {
      const savedKey = process.env.TOOKAN_API_KEY;
      const savedEnabled = process.env.TOOKAN_ENABLED;
      process.env.TOOKAN_API_KEY = "test_key";
      process.env.TOOKAN_ENABLED = "false";
      try {
        const res = await request(app)
          .post(`/api/orders/${testOrderId}/retry-tookan`)
          .expect(400);
        expect(res.body.success).toBe(false);
      } finally {
        if (savedKey !== undefined) process.env.TOOKAN_API_KEY = savedKey;
        else delete process.env.TOOKAN_API_KEY;
        if (savedEnabled !== undefined) process.env.TOOKAN_ENABLED = savedEnabled;
        else delete process.env.TOOKAN_ENABLED;
      }
    });

    it("returns 404 for an order that doesn't belong to the workspace", async () => {
      const savedKey = process.env.TOOKAN_API_KEY;
      process.env.TOOKAN_API_KEY = "test_key";
      try {
        const res = await request(app)
          .post(`/api/orders/00000000-0000-0000-0000-000000000000/retry-tookan`)
          .expect(404);
        expect(res.body.success).toBe(false);
      } finally {
        if (savedKey !== undefined) process.env.TOOKAN_API_KEY = savedKey;
        else delete process.env.TOOKAN_API_KEY;
      }
    });

    it("returns 409 when tookan_job_id is already set on the order", async () => {
      // Pre-set a job ID on the order
      await pool.query(
        `UPDATE orders SET tookan_job_id = 'existing-job-123', tookan_status = 'created' WHERE id = $1`,
        [testOrderId],
      );

      const savedKey = process.env.TOOKAN_API_KEY;
      process.env.TOOKAN_API_KEY = "test_key";
      try {
        const res = await request(app)
          .post(`/api/orders/${testOrderId}/retry-tookan`)
          .expect(409);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/already created/i);
      } finally {
        if (savedKey !== undefined) process.env.TOOKAN_API_KEY = savedKey;
        else delete process.env.TOOKAN_API_KEY;
      }
    });

    it("calls Tookan API and persists job_id on success", async () => {
      const savedKey = process.env.TOOKAN_API_KEY;
      process.env.TOOKAN_API_KEY = "test_key";
      const mockFetch = vi.spyOn(global, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({ status: 200, message: "OK", data: { job_id: 9901, task_id: 1234 } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

      try {
        const res = await request(app)
          .post(`/api/orders/${testOrderId}/retry-tookan`)
          .expect(200);
        expect(res.body.success).toBe(true);
        expect(res.body.tookan_job_id).toBe("9901");
        expect(res.body.tookan_status).toBe("created");

        // Verify DB was updated
        const db = await pool.query<{ tookan_job_id: string; tookan_status: string }>(
          `SELECT tookan_job_id, tookan_status FROM orders WHERE id = $1`,
          [testOrderId],
        );
        expect(db.rows[0]?.tookan_job_id).toBe("9901");
        expect(db.rows[0]?.tookan_status).toBe("created");
      } finally {
        mockFetch.mockRestore();
        if (savedKey !== undefined) process.env.TOOKAN_API_KEY = savedKey;
        else delete process.env.TOOKAN_API_KEY;
      }
    });

    it("persists failure on Tookan API error and returns 502", async () => {
      const savedKey = process.env.TOOKAN_API_KEY;
      process.env.TOOKAN_API_KEY = "test_key";
      const mockFetch = vi.spyOn(global, "fetch").mockResolvedValueOnce(
        new Response(
          JSON.stringify({ status: 400, message: "Invalid API key" }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        ),
      );

      try {
        const res = await request(app)
          .post(`/api/orders/${testOrderId}/retry-tookan`)
          .expect(502);
        expect(res.body.success).toBe(false);

        // Verify DB recorded the failure
        const db = await pool.query<{ tookan_status: string; tookan_error: string }>(
          `SELECT tookan_status, tookan_error FROM orders WHERE id = $1`,
          [testOrderId],
        );
        expect(db.rows[0]?.tookan_status).toBe("failed");
        expect(db.rows[0]?.tookan_error).toMatch(/Invalid API key/i);
      } finally {
        mockFetch.mockRestore();
        if (savedKey !== undefined) process.env.TOOKAN_API_KEY = savedKey;
        else delete process.env.TOOKAN_API_KEY;
      }
    });

    it("GET /api/orders/:id returns tookan fields in order row", async () => {
      await pool.query(
        `UPDATE orders
            SET tookan_job_id = 'job-abc', tookan_status = 'created', tookan_error = NULL
          WHERE id = $1`,
        [testOrderId],
      );

      const res = await request(app)
        .get(`/api/orders/${testOrderId}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.order.tookan_job_id).toBe("job-abc");
      expect(res.body.order.tookan_status).toBe("created");
    });
  },
);

// ── Tookan webhook → order status sync (real DB) ──────────────────────────────

describe.skipIf(!DATABASE_URL)(
  "Tookan webhook — status sync (integration)",
  () => {
    let pool: InstanceType<typeof Pool>;
    let app: express.Express;
    let testOrderId: string;
    const JOB_ID = `wh-job-${Date.now()}`;
    const SECRET = "test_tookan_secret";

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL });
      app = makeWebhookApp();
      await pool.query(
        `INSERT INTO workspace_members (workspace_owner_id, member_user_id, member_email, role, created_at)
         VALUES ($1, 'clerk_tookan_wh_test', 'tookan_wh_test@example.com', 'owner', now())
         ON CONFLICT DO NOTHING`,
        [OWNER_ID],
      );
    });

    afterAll(async () => {
      if (!pool) return;
      await pool.query(`DELETE FROM orders WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM workspace_members WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.end();
    });

    beforeEach(async () => {
      vi.mocked(fireWebhookEvent).mockClear();
      const r = await pool.query<{ id: string }>(
        `INSERT INTO orders (workspace_owner_id, external_order_id, status, source, tookan_job_id, tookan_status, created_at, updated_at)
         VALUES ($1, $2, 'processing', 'external', $3, 'created', now(), now())
         RETURNING id`,
        [OWNER_ID, `ext-tookan-wh-${Date.now()}`, JOB_ID],
      );
      testOrderId = r.rows[0]!.id;
    });

    afterEach(async () => {
      await pool.query(`DELETE FROM orders WHERE workspace_owner_id = $1`, [OWNER_ID]);
      delete process.env.TOOKAN_WEBHOOK_SECRET;
    });

    it("returns 503 when TOOKAN_WEBHOOK_SECRET is not configured", async () => {
      delete process.env.TOOKAN_WEBHOOK_SECRET;
      await request(app)
        .post(`/api/webhooks/tookan`)
        .send({ job_id: JOB_ID, job_status: 2 })
        .expect(503);
    });

    it("returns 401 when the secret does not match", async () => {
      process.env.TOOKAN_WEBHOOK_SECRET = SECRET;
      await request(app)
        .post(`/api/webhooks/tookan`)
        .set("x-tookan-webhook-secret", "wrong")
        .send({ job_id: JOB_ID, job_status: 2 })
        .expect(401);
    });

    it("returns 400 when job_id / job_status are missing", async () => {
      process.env.TOOKAN_WEBHOOK_SECRET = SECRET;
      await request(app)
        .post(`/api/webhooks/tookan`)
        .set("x-tookan-webhook-secret", SECRET)
        .send({})
        .expect(400);
    });

    it("marks the order completed on a Successful (status 2) update", async () => {
      process.env.TOOKAN_WEBHOOK_SECRET = SECRET;
      const res = await request(app)
        .post(`/api/webhooks/tookan`)
        .set("x-tookan-webhook-secret", SECRET)
        .send({ job_id: JOB_ID, job_status: 2 })
        .expect(200);

      expect(res.body).toMatchObject({ received: true, matched: true, statusChanged: true });

      expect(fireWebhookEvent).toHaveBeenCalledWith(
        "order.status_updated",
        OWNER_ID,
        expect.objectContaining({ orderId: testOrderId, status: "completed" }),
      );

      const db = await pool.query<{ status: string; tookan_status: string }>(
        `SELECT status, tookan_status FROM orders WHERE id = $1`,
        [testOrderId],
      );
      expect(db.rows[0]?.status).toBe("completed");
      expect(db.rows[0]?.tookan_status).toBe("successful");
    });

    it("rejects the secret via ?secret= query param", async () => {
      process.env.TOOKAN_WEBHOOK_SECRET = SECRET;
      await request(app)
        .post(`/api/webhooks/tookan?secret=${SECRET}`)
        .send({ job_id: JOB_ID, job_status: 2 })
        .expect(401);

      const db = await pool.query<{ status: string }>(
        `SELECT status FROM orders WHERE id = $1`,
        [testOrderId],
      );
      expect(db.rows[0]?.status).toBe("processing");
    });

    it("marks the order out_for_delivery on an Assigned (status 0) update", async () => {
      process.env.TOOKAN_WEBHOOK_SECRET = SECRET;
      const res = await request(app)
        .post(`/api/webhooks/tookan`)
        .set("x-tookan-webhook-secret", SECRET)
        .send({ job_id: JOB_ID, job_status: 0 })
        .expect(200);

      expect(res.body).toMatchObject({ received: true, matched: true, statusChanged: true });

      expect(fireWebhookEvent).toHaveBeenCalledWith(
        "order.status_updated",
        OWNER_ID,
        expect.objectContaining({ orderId: testOrderId, status: "out_for_delivery" }),
      );

      const db = await pool.query<{ status: string; tookan_status: string }>(
        `SELECT status, tookan_status FROM orders WHERE id = $1`,
        [testOrderId],
      );
      expect(db.rows[0]?.status).toBe("out_for_delivery");
      expect(db.rows[0]?.tookan_status).toBe("assigned");
    });

    it("does not override a completed order when an Assigned update arrives", async () => {
      process.env.TOOKAN_WEBHOOK_SECRET = SECRET;
      await pool.query(`UPDATE orders SET status = 'completed' WHERE id = $1`, [testOrderId]);

      const res = await request(app)
        .post(`/api/webhooks/tookan`)
        .set("x-tookan-webhook-secret", SECRET)
        .send({ job_id: JOB_ID, job_status: 0 })
        .expect(200);

      expect(res.body).toMatchObject({ matched: true, statusChanged: false });

      const db = await pool.query<{ status: string; tookan_status: string }>(
        `SELECT status, tookan_status FROM orders WHERE id = $1`,
        [testOrderId],
      );
      expect(db.rows[0]?.status).toBe("completed");
      expect(db.rows[0]?.tookan_status).toBe("assigned");
    });

    // The full "driver is handling this delivery" family — assigned (0),
    // started (1), in_progress (4), accepted (7) — must all move the order to
    // out_for_delivery, because Tookan does not emit a single clean code on
    // assignment.
    it.each([
      [1, "started"],
      [4, "in_progress"],
      [7, "accepted"],
    ])(
      "marks the order out_for_delivery on an assignment-family update (status %i = %s)",
      async (jobStatus, label) => {
        process.env.TOOKAN_WEBHOOK_SECRET = SECRET;
        const res = await request(app)
          .post(`/api/webhooks/tookan`)
          .set("x-tookan-webhook-secret", SECRET)
          .send({ job_id: JOB_ID, job_status: jobStatus })
          .expect(200);

        expect(res.body).toMatchObject({ received: true, matched: true, statusChanged: true });

        expect(fireWebhookEvent).toHaveBeenCalledWith(
          "order.status_updated",
          OWNER_ID,
          expect.objectContaining({ orderId: testOrderId, status: "out_for_delivery" }),
        );

        const db = await pool.query<{ status: string; tookan_status: string }>(
          `SELECT status, tookan_status FROM orders WHERE id = $1`,
          [testOrderId],
        );
        expect(db.rows[0]?.status).toBe("out_for_delivery");
        expect(db.rows[0]?.tookan_status).toBe(label);
      },
    );

    it("records the status label but does not change status on an unmapped update", async () => {
      process.env.TOOKAN_WEBHOOK_SECRET = SECRET;
      // status 6 = unassigned — not in the assignment family and not successful,
      // so it only updates the stored label.
      const res = await request(app)
        .post(`/api/webhooks/tookan`)
        .set("x-tookan-webhook-secret", SECRET)
        .send({ job_id: JOB_ID, job_status: 6 })
        .expect(200);

      expect(res.body).toMatchObject({ matched: true, statusChanged: false });

      const db = await pool.query<{ status: string; tookan_status: string }>(
        `SELECT status, tookan_status FROM orders WHERE id = $1`,
        [testOrderId],
      );
      expect(db.rows[0]?.status).toBe("processing");
      expect(db.rows[0]?.tookan_status).toBe("unassigned");
    });

    it("does not override an already-cancelled order", async () => {
      process.env.TOOKAN_WEBHOOK_SECRET = SECRET;
      await pool.query(`UPDATE orders SET status = 'cancelled' WHERE id = $1`, [testOrderId]);

      const res = await request(app)
        .post(`/api/webhooks/tookan`)
        .set("x-tookan-webhook-secret", SECRET)
        .send({ job_id: JOB_ID, job_status: 2 })
        .expect(200);

      expect(res.body).toMatchObject({ matched: true, statusChanged: false });

      const db = await pool.query<{ status: string }>(
        `SELECT status FROM orders WHERE id = $1`,
        [testOrderId],
      );
      expect(db.rows[0]?.status).toBe("cancelled");
    });

    it("returns matched:false for an unknown job_id", async () => {
      process.env.TOOKAN_WEBHOOK_SECRET = SECRET;
      const res = await request(app)
        .post(`/api/webhooks/tookan`)
        .set("x-tookan-webhook-secret", SECRET)
        .send({ job_id: "does-not-exist", job_status: 2 })
        .expect(200);

      expect(res.body).toMatchObject({ received: true, matched: false });
    });
  },
);
