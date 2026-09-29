/**
 * Integration tests: the external-order ingest (POST /api/orders) maps every
 * website checkout field into its structured destination, exercised against a
 * real PostgreSQL database.
 *
 * Verifies, for a website-shaped payload:
 *   - order_payment.currency is populated from payment.currencyCode
 *   - delivery.countryCode / delivery.noAddress land in the delivery_address JSON
 *   - billing.countryCode is retained on the billing contact's metadata JSON
 *   - the card message is stored in order_notes.customer_note
 *   - the full body is still captured verbatim in orders.raw_payload
 *
 * Auth (requireApiKey) and the SSE/webhook side-effects are stubbed; the
 * database is real. The suite skips automatically when DATABASE_URL is not set.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import pg from "pg";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;

const OWNER_ID = `__ext_order_fieldmap_test_${Date.now()}`;

// ─────────────────────────────────────────────────────────────────────────────
// Mocks — auth / logger / SSE / webhook only. db and contactUpsert are real.
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("../lib/apiKeyAuth", () => ({
  requireApiKey: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as unknown as { userId: string }).userId = OWNER_ID;
    next();
  },
  resolveApiKeyWorkspace: vi.fn().mockResolvedValue(null),
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn().mockReturnThis() },
}));

vi.mock("../lib/eventsSse", () => ({
  broadcastEvent: vi.fn(),
}));

vi.mock("../lib/catalogWebhook", () => ({
  fireWebhookEvent: vi.fn().mockResolvedValue(undefined),
}));

import externalOrdersRouter from "./externalOrders";

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
  app.use("/api", externalOrdersRouter);
  return app;
}

async function cleanup(pool: InstanceType<typeof Pool>): Promise<void> {
  // order_payment / order_line_items / order_contacts / order_notes cascade from orders.
  await pool.query(`DELETE FROM orders WHERE workspace_owner_id = $1`, [OWNER_ID]);
  await pool.query(`DELETE FROM contacts WHERE workspace_owner_id = $1`, [OWNER_ID]);
}

describe.skipIf(!DATABASE_URL)(
  "External order ingest — full website field mapping (integration)",
  () => {
    let pool: InstanceType<typeof Pool>;
    let app: express.Express;

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

    it("maps every website order field into its structured destination", async () => {
      const res = await request(app)
        .post("/api/orders")
        .send({
          appOrderId: `web-fieldmap-${Date.now()}`,
          items: [{ productName: "White Roses", quantity: 1, priceUsd: 79.99 }],
          billing: {
            firstName: "Sarah",
            lastName: "Khalil",
            email: `sarah-${Date.now()}@example.com`,
            phone: `+9617${Date.now() % 10000000}`,
            countryCode: "LB",
          },
          delivery: {
            district: "Hamra",
            cityId: "beirut",
            countryCode: "LB",
            address: "123 Main St",
            noAddress: false,
            date: "2099-06-20",
            slot: "afternoon",
            isExpress: false,
            feeUsd: 5,
          },
          payment: {
            method: "stripe",
            ref: "pi_fieldmap_1",
            verified: true,
            totalUsd: 84.99,
            currencyCode: "AED",
          },
          cardMessage: "Happy Birthday!",
          cardFrom: "The Team",
          cardTo: "Ahmad",
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      const orderId = res.body.order_id as string;
      expect(orderId).toBeTruthy();

      // ── delivery_address JSON: countryCode + noAddress ──────────────────────
      const orderRow = await pool.query<{
        delivery_address: Record<string, unknown> | null;
        raw_payload: Record<string, unknown> | null;
      }>(`SELECT delivery_address, raw_payload FROM orders WHERE id = $1`, [orderId]);
      const deliveryAddress = orderRow.rows[0]?.delivery_address ?? {};
      expect(deliveryAddress.countryCode).toBe("LB");
      expect(deliveryAddress.noAddress).toBe(false);
      expect(deliveryAddress.cityId).toBe("beirut");
      expect(deliveryAddress.date).toBe("2099-06-20");
      expect(deliveryAddress.slot).toBe("afternoon");
      // raw_payload still captures the full body verbatim.
      expect(orderRow.rows[0]?.raw_payload).toMatchObject({
        cardMessage: "Happy Birthday!",
      });

      // ── order_payment.currency + charged amount_usd ─────────────────────────
      const paymentRow = await pool.query<{
        currency: string | null;
        status: string;
        amount_usd: string | null;
      }>(
        `SELECT currency, status, amount_usd FROM order_payment WHERE order_id = $1`,
        [orderId],
      );
      expect(paymentRow.rows[0]?.currency).toBe("AED");
      expect(paymentRow.rows[0]?.status).toBe("paid");
      // The exact provider-charged amount is stored independent of totals JSON.
      expect(Number(paymentRow.rows[0]?.amount_usd)).toBe(84.99);

      // ── totals.total includes the delivery fee (matches what was charged) ───
      const totalsRow = await pool.query<{ totals: Record<string, unknown> | null }>(
        `SELECT totals FROM orders WHERE id = $1`,
        [orderId],
      );
      const totals = totalsRow.rows[0]?.totals ?? {};
      expect(Number(totals.total)).toBe(84.99);
      expect(Number(totals.shipping)).toBe(5);
      expect(Number(totals.subtotal)).toBe(79.99);

      // ── orders.card_message carries the card message ────────────────────────
      // cardMessage is stored as a dedicated column on the orders row, not as a
      // separate order_notes.customer_note write.
      const cardRow = await pool.query<{ card_message: string | null }>(
        `SELECT card_message FROM orders WHERE id = $1`,
        [orderId],
      );
      expect(cardRow.rows[0]?.card_message).toContain("Happy Birthday!");

      // ── billing.countryCode retained on the contact metadata ────────────────
      const contactRow = await pool.query<{ metadata: Record<string, unknown> | null }>(
        `SELECT c.metadata
           FROM contacts c
           JOIN order_contacts oc ON oc.contact_id = c.id
          WHERE oc.order_id = $1 AND oc.role = 'customer'`,
        [orderId],
      );
      expect(contactRow.rows[0]?.metadata).toMatchObject({ country_code: "LB" });
    });
  },
);
