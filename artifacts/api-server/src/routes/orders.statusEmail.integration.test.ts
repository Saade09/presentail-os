/**
 * Integration tests: the customer-facing ORDER STATUS email fired by
 * PATCH /api/orders/:id/status, exercised against a real PostgreSQL database and
 * the REAL email layer.
 *
 * Unlike the unit tests (which mock `../lib/email` wholesale), this suite lets
 * the real sendOrderStatusEmail / buildOrderStatusHtml / lookupOrderEmailDetails
 * code run and only intercepts the `resend` transport, so the actual send path
 * is verified end-to-end.
 *
 * Covers:
 *   - graceful skip when RESEND_API_KEY is UNSET (status still updates, no crash,
 *     the real send path logs the "skipping" warning)        ← must run first
 *   - status email fires on a REAL status change
 *   - status email does NOT fire when the status is set to its current value
 *
 * IMPORTANT ordering note: the RESEND_API_KEY-unset test must run BEFORE any
 * test sets the key, because the email layer caches its Resend client lazily on
 * first successful build. getResend() never caches when the key is absent (it
 * throws and is caught), so running the unset case first keeps the cache empty.
 *
 * Auth/workspace, logger, and webhooks are stubbed; the database and email layer
 * are real. The suite skips automatically when DATABASE_URL is not set.
 *
 * Run via:
 *   pnpm --filter @workspace/api-server run test:integration:local
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import pg from "pg";
import type { WorkspaceRequest } from "../lib/workspace";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;

const OWNER_ID = `__order_status_email_test_${Date.now()}`;
const CUSTOMER_EMAIL = `status-customer-${Date.now()}@example.com`;
const CUSTOMER_NAME = "Maya Fares";

// ─────────────────────────────────────────────────────────────────────────────
// Mocks — `resend` transport intercepted with a hoisted spy; auth/workspace,
// logger and webhooks stubbed. db + email layer are real.
// ─────────────────────────────────────────────────────────────────────────────

const mockResendEmailsSend = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ data: { id: "test-email-id" }, error: null }),
);

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn().mockReturnThis(),
}));

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: mockResendEmailsSend };
  },
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
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
  hasPageAccess: () => true,
}));

vi.mock("../lib/logger", () => ({ logger: mockLogger }));

vi.mock("../lib/catalogWebhook", () => ({
  fireWebhookEvent: vi.fn().mockResolvedValue(undefined),
}));

import ordersRouter from "./orders";

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
  app.use("/api", ordersRouter);
  return app;
}

async function cleanup(pool: InstanceType<typeof Pool>): Promise<void> {
  await pool.query(`DELETE FROM orders WHERE workspace_owner_id = $1`, [OWNER_ID]);
  await pool.query(`DELETE FROM contacts WHERE workspace_owner_id = $1`, [OWNER_ID]);
}

describe.skipIf(!DATABASE_URL)(
  "PATCH /api/orders/:id/status — customer status email (integration)",
  () => {
    let pool: InstanceType<typeof Pool>;
    let app: express.Express;
    let customerContactId: string;

    // Seed a fresh order at the given status, linked to the shared customer
    // contact, and return its id. A line item is added so the email details
    // lookup has something to render.
    async function seedOrder(status: string): Promise<string> {
      const orderRes = await pool.query<{ id: string }>(
        `INSERT INTO orders
           (workspace_owner_id, source, external_order_id, status, ordered_at, totals)
         VALUES ($1, 'external', $2, $3, now(), $4::jsonb)
         RETURNING id`,
        [
          OWNER_ID,
          `status-${status}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          status,
          JSON.stringify({ total: 60, currency: "USD" }),
        ],
      );
      const orderId = orderRes.rows[0].id;
      await pool.query(
        `INSERT INTO order_contacts (order_id, contact_id, role)
         VALUES ($1, $2, 'customer')`,
        [orderId, customerContactId],
      );
      await pool.query(
        `INSERT INTO order_line_items (order_id, name, quantity, unit_price, line_total)
         VALUES ($1, 'Mixed Bouquet', 1, 60, 60)`,
        [orderId],
      );
      // Mark the order paid so the pending → processing transition passes the
      // paid-before-processing guard (these tests exercise email behavior, not
      // the payment gate).
      await pool.query(
        `INSERT INTO order_payment (order_id, status, paid_at)
         VALUES ($1, 'paid', now())
         ON CONFLICT (order_id) DO UPDATE SET status = 'paid', paid_at = now()`,
        [orderId],
      );
      return orderId;
    }

    beforeAll(async () => {
      // Start with NO key so the first test exercises the graceful skip path.
      delete process.env.RESEND_API_KEY;

      pool = new Pool({ connectionString: DATABASE_URL });
      app = makeApp();
      await cleanup(pool);

      const contactRes = await pool.query<{ id: string }>(
        `INSERT INTO contacts
           (workspace_owner_id, source, display_name, email)
         VALUES ($1, 'external', $2, $3)
         RETURNING id`,
        [OWNER_ID, CUSTOMER_NAME, CUSTOMER_EMAIL],
      );
      customerContactId = contactRes.rows[0].id;
    });

    afterAll(async () => {
      if (!pool) return;
      await cleanup(pool);
      await pool.end();
      delete process.env.RESEND_API_KEY;
    });

    beforeEach(() => {
      mockResendEmailsSend.mockClear();
      mockResendEmailsSend.mockResolvedValue({ data: { id: "test-email-id" }, error: null });
      mockLogger.warn.mockClear();
    });

    // ── MUST RUN FIRST (see ordering note in the file header) ────────────────
    it("gracefully skips the status email when RESEND_API_KEY is unset", async () => {
      expect(process.env.RESEND_API_KEY).toBeUndefined();
      const orderId = await seedOrder("pending");

      const res = await request(app)
        .patch(`/api/orders/${orderId}/status`)
        .send({ status: "processing" });

      // The status update itself must succeed regardless of email config.
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.order.status).toBe("processing");

      // The real send path runs (fire-and-forget) and gracefully skips: it logs
      // the "skipping" warning and never calls the transport.
      await vi.waitFor(() => {
        const skipped = mockLogger.warn.mock.calls.some(
          (c) =>
            typeof c[1] === "string" &&
            c[1].includes("Skipping order status email — RESEND_API_KEY not configured"),
        );
        expect(skipped).toBe(true);
      });
      expect(mockResendEmailsSend).not.toHaveBeenCalled();
    });

    it("sends a status email on a real status change", async () => {
      process.env.RESEND_API_KEY = "test_resend_key_integration";
      const orderId = await seedOrder("pending");

      const res = await request(app)
        .patch(`/api/orders/${orderId}/status`)
        .send({ status: "processing" });

      expect(res.status).toBe(200);
      expect(res.body.order.status).toBe("processing");

      await vi.waitFor(() => expect(mockResendEmailsSend).toHaveBeenCalledTimes(1));
      const payload = mockResendEmailsSend.mock.calls[0][0] as {
        to: string;
        subject: string;
        html: string;
      };
      expect(payload.to).toBe(CUSTOMER_EMAIL);
      expect(payload.subject.toLowerCase()).toContain("order");
    });

    it("does NOT send a status email when the status is unchanged", async () => {
      process.env.RESEND_API_KEY = "test_resend_key_integration";
      // Seed an order already at the target status, then set the same status.
      const orderId = await seedOrder("processing");

      const res = await request(app)
        .patch(`/api/orders/${orderId}/status`)
        .send({ status: "processing" });

      expect(res.status).toBe(200);
      expect(res.body.order.status).toBe("processing");

      // No real change → notifyOrderStatusEmail is never invoked. Wait a beat to
      // be sure nothing fires asynchronously.
      await new Promise((r) => setTimeout(r, 150));
      expect(mockResendEmailsSend).not.toHaveBeenCalled();
    });
  },
);
