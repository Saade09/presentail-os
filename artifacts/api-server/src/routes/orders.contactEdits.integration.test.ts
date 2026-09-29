/**
 * Integration tests: the CONTACT-EDIT AUDIT TRAIL written by
 * PATCH /api/orders/:id/contacts and surfaced by GET /api/orders/:id, exercised
 * against a real PostgreSQL database.
 *
 * Unit tests mock the DB, so a column-name drift between the raw SQL in
 * orders.ts and the DDL in initDb.ts would never surface there. This suite runs
 * the real INSERT/SELECT against the `order_contact_edits` table to catch that.
 *
 * Covers:
 *   - editing customer + recipient writes one audit row per role and returns
 *     `contact_edits` with the editor's resolved name
 *   - GET /api/orders/:id surfaces the latest edit per role
 *   - re-editing the same role appends a new row and the latest one wins
 *
 * Auth/workspace, logger, webhooks, and Clerk are stubbed; the database is real.
 * The suite skips automatically when DATABASE_URL is not set.
 *
 * Run via:
 *   pnpm --filter @workspace/api-server run test:integration:local
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import pg from "pg";
import type { WorkspaceRequest } from "../lib/workspace";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;

const OWNER_ID = `__order_contact_edits_test_${Date.now()}`;
const EDITOR_USER_ID = "user_contact_editor_1";
const EDITOR_NAME = "Dana Khoury";

// ─────────────────────────────────────────────────────────────────────────────
// Mocks — auth/workspace/logger/webhooks/Clerk stubbed. db is real.
// ─────────────────────────────────────────────────────────────────────────────

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
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
    wreq.userId = EDITOR_USER_ID;
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
        firstName: "Dana",
        lastName: "Khoury",
        primaryEmailAddress: { emailAddress: "dana@example.com" },
      }),
    },
  },
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
  // order_contact_edits FK→orders ON DELETE CASCADE clears audit rows too.
  await pool.query(`DELETE FROM orders WHERE workspace_owner_id = $1`, [OWNER_ID]);
  await pool.query(`DELETE FROM contacts WHERE workspace_owner_id = $1`, [OWNER_ID]);
}

type Edit = { role: string; edited_by_user_id: string; edited_by_name: string | null };

describe.skipIf(!DATABASE_URL)(
  "PATCH /api/orders/:id/contacts — contact-edit audit trail (integration)",
  () => {
    let pool: InstanceType<typeof Pool>;
    let app: express.Express;
    let customerContactId: string;
    let recipientContactId: string;

    async function seedOrder(): Promise<string> {
      const orderRes = await pool.query<{ id: string }>(
        `INSERT INTO orders
           (workspace_owner_id, source, external_order_id, status, ordered_at, totals)
         VALUES ($1, 'external', $2, 'pending', now(), $3::jsonb)
         RETURNING id`,
        [
          OWNER_ID,
          `contact-edit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          JSON.stringify({ total: 40, currency: "USD" }),
        ],
      );
      const orderId = orderRes.rows[0].id;
      await pool.query(
        `INSERT INTO order_contacts (order_id, contact_id, role)
         VALUES ($1, $2, 'customer'), ($1, $3, 'recipient')`,
        [orderId, customerContactId, recipientContactId],
      );
      return orderId;
    }

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL });
      app = makeApp();
      await cleanup(pool);

      const cust = await pool.query<{ id: string }>(
        `INSERT INTO contacts (workspace_owner_id, source, display_name, email)
         VALUES ($1, 'external', 'Original Customer', 'orig-cust@example.com')
         RETURNING id`,
        [OWNER_ID],
      );
      customerContactId = cust.rows[0].id;
      const recip = await pool.query<{ id: string }>(
        `INSERT INTO contacts (workspace_owner_id, source, display_name, phone)
         VALUES ($1, 'external', 'Original Recipient', '+9610000000')
         RETURNING id`,
        [OWNER_ID],
      );
      recipientContactId = recip.rows[0].id;
    });

    afterAll(async () => {
      if (!pool) return;
      await cleanup(pool);
      await pool.end();
    });

    it("writes one audit row per edited role and returns them with the editor name", async () => {
      const orderId = await seedOrder();

      const res = await request(app)
        .patch(`/api/orders/${orderId}/contacts`)
        .send({
          customer: { name: "Edited Customer", email: "edited-cust@example.com" },
          recipient: { name: "Edited Recipient", phone: "+9619999999" },
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const edits = res.body.contact_edits as Edit[];
      expect(Array.isArray(edits)).toBe(true);
      const byRole = Object.fromEntries(edits.map((e) => [e.role, e]));
      expect(byRole.customer).toBeDefined();
      expect(byRole.recipient).toBeDefined();
      expect(byRole.customer.edited_by_user_id).toBe(EDITOR_USER_ID);
      expect(byRole.customer.edited_by_name).toBe(EDITOR_NAME);
      expect(byRole.recipient.edited_by_name).toBe(EDITOR_NAME);

      // The rows really landed in the DB (catches column drift vs initDb.ts).
      const dbRows = await pool.query<{ role: string; edited_by_name: string | null }>(
        `SELECT role, edited_by_name FROM order_contact_edits WHERE order_id = $1`,
        [orderId],
      );
      expect(dbRows.rowCount).toBe(2);
    });

    it("surfaces the latest edit per role on GET /api/orders/:id", async () => {
      const orderId = await seedOrder();

      await request(app)
        .patch(`/api/orders/${orderId}/contacts`)
        .send({ customer: { name: "Cust V1" } })
        .expect(200);

      const res = await request(app).get(`/api/orders/${orderId}`);
      expect(res.status).toBe(200);
      const edits = res.body.contact_edits as Edit[];
      const customer = edits.find((e) => e.role === "customer");
      expect(customer).toBeDefined();
      expect(customer!.edited_by_user_id).toBe(EDITOR_USER_ID);
    });

    it("appends a new row on re-edit and the latest one wins", async () => {
      const orderId = await seedOrder();

      await request(app)
        .patch(`/api/orders/${orderId}/contacts`)
        .send({ customer: { name: "First Edit" } })
        .expect(200);
      // Ensure a strictly later edited_at for the second edit.
      await new Promise((r) => setTimeout(r, 10));
      await request(app)
        .patch(`/api/orders/${orderId}/contacts`)
        .send({ customer: { name: "Second Edit" } })
        .expect(200);

      const all = await pool.query(
        `SELECT id FROM order_contact_edits WHERE order_id = $1 AND role = 'customer'`,
        [orderId],
      );
      expect(all.rowCount).toBe(2);

      const res = await request(app).get(`/api/orders/${orderId}`);
      const edits = res.body.contact_edits as Edit[];
      const customerEdits = edits.filter((e) => e.role === "customer");
      // Only the latest customer edit is surfaced (DISTINCT ON role).
      expect(customerEdits).toHaveLength(1);
    });

    it("GET /api/orders/:id/contact-edits returns the FULL history, newest first", async () => {
      const orderId = await seedOrder();

      await request(app)
        .patch(`/api/orders/${orderId}/contacts`)
        .send({ customer: { name: "Hist V1" } })
        .expect(200);
      await new Promise((r) => setTimeout(r, 10));
      await request(app)
        .patch(`/api/orders/${orderId}/contacts`)
        .send({ customer: { name: "Hist V2" }, recipient: { name: "Hist R1" } })
        .expect(200);

      const res = await request(app).get(`/api/orders/${orderId}/contact-edits`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const edits = res.body.contact_edits as Array<Edit & { edited_at: string }>;
      // 2 customer edits + 1 recipient edit = 3 rows, NOT collapsed per role.
      expect(edits).toHaveLength(3);
      expect(res.body.total).toBe(3);
      expect(edits.filter((e) => e.role === "customer")).toHaveLength(2);
      expect(edits.filter((e) => e.role === "recipient")).toHaveLength(1);

      // Newest first: edited_at is non-increasing across the list.
      for (let i = 1; i < edits.length; i++) {
        expect(
          new Date(edits[i - 1].edited_at).getTime(),
        ).toBeGreaterThanOrEqual(new Date(edits[i].edited_at).getTime());
      }
    });

    it("GET /api/orders/:id/contact-edits paginates with limit/offset", async () => {
      const orderId = await seedOrder();

      for (let i = 0; i < 3; i++) {
        await request(app)
          .patch(`/api/orders/${orderId}/contacts`)
          .send({ customer: { name: `Page V${i}` } })
          .expect(200);
        await new Promise((r) => setTimeout(r, 5));
      }

      const page1 = await request(app).get(
        `/api/orders/${orderId}/contact-edits?limit=2&offset=0`,
      );
      expect(page1.status).toBe(200);
      expect(page1.body.total).toBe(3);
      expect(page1.body.limit).toBe(2);
      expect(page1.body.offset).toBe(0);
      expect(page1.body.contact_edits).toHaveLength(2);

      const page2 = await request(app).get(
        `/api/orders/${orderId}/contact-edits?limit=2&offset=2`,
      );
      expect(page2.status).toBe(200);
      expect(page2.body.contact_edits).toHaveLength(1);
    });

    it("GET /api/orders/:id/contact-edits 404s for an unknown order", async () => {
      const res = await request(app).get(
        `/api/orders/00000000-0000-0000-0000-000000000000/contact-edits`,
      );
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });
  },
);
