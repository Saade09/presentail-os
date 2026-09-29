/**
 * Integration tests: GET /api/orders/:id/invoice, exercised against a REAL
 * PostgreSQL database (not mocked db.query).
 *
 * The unit tests in orders.test.ts mock every db.query call, so they cannot
 * catch column-name drift — which is exactly how the production 500 happened:
 * the invoice route selected `total` from `order_line_items`, but the real
 * column is `line_total`. This suite seeds a real order with real line items and
 * hits the endpoint, so any missing/renamed column surfaces as a failing test
 * instead of a production 500.
 *
 * Auth/workspace and logger are stubbed; the database is real. The suite skips
 * automatically when DATABASE_URL is not set.
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

const OWNER_ID = `__order_invoice_test_${Date.now()}`;

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
    (req as unknown as { log: Record<string, (...a: unknown[]) => void> }).log = {
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

function isPdf(buf: Buffer): boolean {
  return buf.length > 4 && buf.subarray(0, 5).toString("latin1") === "%PDF-";
}

describe.skipIf(!DATABASE_URL)("GET /api/orders/:id/invoice (integration)", () => {
  let pool: InstanceType<typeof Pool>;
  let app: express.Express;
  let uniqueSeq = 0;

  // Seed an order plus its line items and an optional customer contact. Line
  // items use the real `line_total` column so the invoice route's SELECT is
  // exercised against the true schema.
  async function seedOrderWithItems(opts?: {
    withCustomer?: boolean;
    items?: Array<{ name: string; quantity: number; unit_price: number; line_total: number }>;
  }): Promise<string> {
    uniqueSeq += 1;
    const items = opts?.items ?? [
      { name: "Rose Bouquet", quantity: 2, unit_price: 20, line_total: 40 },
      { name: "Greeting Card", quantity: 1, unit_price: 5, line_total: 5 },
    ];
    const orderRes = await pool.query<{ id: string }>(
      `INSERT INTO orders
         (workspace_owner_id, source, external_order_id, status, ordered_at, totals)
       VALUES ($1, 'external', $2, 'pending', now(), $3::jsonb)
       RETURNING id`,
      [
        OWNER_ID,
        `invoice-${Date.now()}-${uniqueSeq}-${Math.random().toString(36).slice(2, 8)}`,
        JSON.stringify({ total: 45, subtotal: 45, currency: "USD" }),
      ],
    );
    const orderId = orderRes.rows[0].id;

    for (const it of items) {
      await pool.query(
        `INSERT INTO order_line_items (order_id, name, quantity, unit_price, line_total)
         VALUES ($1, $2, $3, $4, $5)`,
        [orderId, it.name, it.quantity, it.unit_price, it.line_total],
      );
    }

    if (opts?.withCustomer) {
      const c = await pool.query<{ id: string }>(
        `INSERT INTO contacts
           (workspace_owner_id, source, is_guest, display_name, email)
         VALUES ($1, 'external', true, $2, $3)
         RETURNING id`,
        [OWNER_ID, "Invoice Customer", `inv-${uniqueSeq}@example.com`],
      );
      await pool.query(
        `INSERT INTO order_contacts (order_id, contact_id, role) VALUES ($1, $2, 'customer')`,
        [orderId, c.rows[0].id],
      );
    }

    return orderId;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    app = makeApp();
    await cleanup(pool);
  });

  afterAll(async () => {
    if (!pool) return;
    await cleanup(pool);
    await pool.end();
  });

  it("returns a PDF (never a 500) for an order with line items", async () => {
    const orderId = await seedOrderWithItems({ withCustomer: true });

    const res = await request(app)
      .get(`/api/orders/${orderId}/invoice`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });

    // A missing/renamed column (e.g. the old `total` bug) would make this 500.
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(isPdf(res.body as Buffer)).toBe(true);
    expect((res.body as Buffer).length).toBeGreaterThan(1000);
  });

  it("returns a PDF for an order with no line items", async () => {
    const orderId = await seedOrderWithItems({ items: [] });

    const res = await request(app)
      .get(`/api/orders/${orderId}/invoice`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(isPdf(res.body as Buffer)).toBe(true);
  });

  it("returns 404 for an order outside the workspace", async () => {
    const res = await request(app).get(
      `/api/orders/00000000-0000-0000-0000-000000000000/invoice`,
    );
    expect(res.status).toBe(404);
  });
});
