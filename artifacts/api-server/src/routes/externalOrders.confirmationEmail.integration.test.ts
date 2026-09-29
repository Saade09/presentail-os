/**
 * Integration tests: the customer-facing ORDER CONFIRMATION email fired by the
 * external-order ingest (POST /api/orders), exercised against a real PostgreSQL
 * database and the REAL email layer.
 *
 * Unlike the unit tests (which mock `../lib/email` wholesale), this suite lets
 * the real sendOrderConfirmationEmail / buildOrderConfirmationHtml /
 * lookupOrderEmailDetails code run and only intercepts the `resend` transport,
 * so the actual send path is verified end-to-end.
 *
 * Covers:
 *   - confirmation fires on a NEW order (first INSERT)
 *   - confirmation does NOT fire on re-ingest of the same external_order_id
 *     (idempotent duplicate → HTTP 200, no second email)
 *   - graceful skip when there is no customer email on file (order still created)
 *
 * Auth (requireApiKey), logger, SSE, and webhooks are stubbed; the database and
 * the email layer are real. The suite skips automatically when DATABASE_URL is
 * not set.
 *
 * Run via:
 *   pnpm --filter @workspace/api-server run test:integration:local
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import pg from "pg";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;

const OWNER_ID = `__ext_order_confirm_email_test_${Date.now()}`;

// ─────────────────────────────────────────────────────────────────────────────
// Mocks — the `resend` transport is intercepted with a hoisted spy so the real
// email code runs but no HTTP request leaves the process. db + email + ingest
// route are real. Auth / logger / SSE / webhook are stubbed.
// ─────────────────────────────────────────────────────────────────────────────

const mockResendEmailsSend = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ data: { id: "test-email-id" }, error: null }),
);

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: mockResendEmailsSend };
  },
}));

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

vi.mock("../lib/tookan", () => ({
  isTookanEnabled: vi.fn().mockReturnValue(false),
  createTookanDeliveryTask: vi.fn().mockResolvedValue(undefined),
  extractTookanFailurePayload: vi.fn().mockReturnValue(null),
  parseDeliveryWindow: vi.fn().mockReturnValue({ window_start: null, window_end: null }),
  TOOKAN_MISSING_ADDRESS_ERROR: "Delivery address missing — add an address and retry",
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
  // order_line_items / order_contacts / order_payment / order_notes cascade from orders.
  await pool.query(`DELETE FROM orders WHERE workspace_owner_id = $1`, [OWNER_ID]);
  await pool.query(`DELETE FROM contacts WHERE workspace_owner_id = $1`, [OWNER_ID]);
}

describe.skipIf(!DATABASE_URL)(
  "External order ingest — customer confirmation email (integration)",
  () => {
    let pool: InstanceType<typeof Pool>;
    let app: express.Express;

    beforeAll(async () => {
      // A fake key so getResend() builds the (mocked) Resend client instead of
      // throwing — i.e. the "configured" send path is exercised here.
      process.env.RESEND_API_KEY = "test_resend_key_integration";

      pool = new Pool({ connectionString: DATABASE_URL });
      app = makeApp();
      await cleanup(pool);
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
    });

    it("sends a confirmation email on a new order with a customer email", async () => {
      const externalId = `web-confirm-${Date.now()}`;
      const email = `confirm-${Date.now()}@example.com`;

      const res = await request(app)
        .post("/api/orders")
        .send({
          appOrderId: externalId,
          items: [{ productName: "Red Roses", quantity: 2, priceUsd: 25 }],
          billing: { firstName: "Lina", lastName: "Haddad", email },
          payment: { method: "stripe", verified: true, totalUsd: 50, currencyCode: "USD" },
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);

      // The confirmation email is fire-and-forget (void ...then(...)), so wait
      // for the real send path to reach the (mocked) transport.
      await vi.waitFor(() => expect(mockResendEmailsSend).toHaveBeenCalledTimes(1));

      const payload = mockResendEmailsSend.mock.calls[0][0] as {
        to: string;
        subject: string;
        html: string;
        text: string;
      };
      expect(payload.to).toBe(email);
      expect(payload.subject).toContain(externalId);
      expect(payload.html).toContain(externalId);
    });

    it("resolves the persisted delivery city into the staff notification", async () => {
      const suffix = Date.now();
      const externalId = `web-staff-city-${suffix}`;
      const customerEmail = `staff-city-customer-${suffix}@example.com`;
      const staffEmail = `staff-city-admin-${suffix}@example.com`;
      const cityName = `Integration Beirut ${suffix}`;

      const cityResult = await pool.query<{ id: number }>(
        `INSERT INTO delivery_cities (workspace_owner_id, country_code, name, slug)
         VALUES ($1, 'LB', $2, $3)
         RETURNING id`,
        [OWNER_ID, cityName, `integration-beirut-${suffix}`],
      );
      const cityId = cityResult.rows[0].id;
      await pool.query(
        `INSERT INTO workspace_members
           (workspace_owner_id, member_email, role, notify_email_on_new_order)
         VALUES ($1, $2, 'admin', true)`,
        [OWNER_ID, staffEmail],
      );

      try {
        const res = await request(app)
          .post("/api/orders")
          .send({
            appOrderId: externalId,
            items: [{ productName: "Delivery City Test Roses", quantity: 1, priceUsd: 45 }],
            billing: {
              firstName: "Lina",
              lastName: "Haddad",
              email: customerEmail,
              phone: "+96170000001",
            },
            recipient: { firstName: "Omar", lastName: "Saad", phone: "+96170000002" },
            delivery: {
              address: "17 Bliss Street",
              district: "Hamra",
              cityId: String(cityId),
              countryCode: "LB",
              date: "2026-06-10",
              slot: "2:00 PM – 5:00 PM",
            },
            orderNotes: "Ring the doorbell twice",
            cardMessage: "Congratulations, Omar!",
            cardFrom: "Lina",
            cardTo: "Omar",
            payment: { method: "stripe", verified: true, totalUsd: 45, currencyCode: "USD" },
          });

        expect(res.status).toBe(201);
        await vi.waitFor(() => expect(mockResendEmailsSend).toHaveBeenCalledTimes(2));

        const staffPayload = mockResendEmailsSend.mock.calls
          .map(
            ([message]) =>
              message as {
                to: string | string[];
                subject: string;
                html: string;
                text: string;
              },
          )
          .find((message) => Array.isArray(message.to) && message.to.includes(staffEmail));

        expect(staffPayload).toBeDefined();
        expect(staffPayload?.subject).toContain(externalId);
        for (const body of [staffPayload!.html, staffPayload!.text]) {
          expect(body).toContain(cityName);
          expect(body).toContain("LB");
          expect(body).toContain("17 Bliss Street");
          expect(body).toContain("Hamra");
          expect(body).toContain("2:00 PM – 5:00 PM");
          expect(body).toContain("Ring the doorbell twice");
          expect(body).toContain("Congratulations, Omar!");
          expect(body).toContain("From: Lina");
          expect(body).toContain("To: Omar");
        }
      } finally {
        await pool.query(
          `DELETE FROM workspace_members
            WHERE workspace_owner_id = $1 AND member_email = $2`,
          [OWNER_ID, staffEmail],
        );
        await pool.query(`DELETE FROM delivery_cities WHERE id = $1`, [cityId]);
      }
    });

    it("renders an AED-paid order in AED only (no USD approximation) with the full breakdown", async () => {
      const externalId = `web-aed-${Date.now()}`;
      const email = `aed-${Date.now()}@example.com`;

      // USD totals: subtotal 63 + delivery 43 = 106, paid as AED 425.
      const res = await request(app)
        .post("/api/orders")
        .send({
          appOrderId: externalId,
          items: [
            { productName: "Congrats Bundle", quantity: 1, priceUsd: 31 },
            { productName: "Gold Ring Balloon Bundle", quantity: 1, priceUsd: 32 },
          ],
          totals: { subtotal: 63, delivery_fee: 43, total: 106 },
          billing: { firstName: "Rana", lastName: "Khalil", email },
          cardMessage: "Mabrouk! So proud of you.",
          payment: {
            method: "stripe",
            verified: true,
            totalUsd: 106,
            totalAmount: 425,
            currencyCode: "AED",
          },
        });

      expect(res.status).toBe(201);
      await vi.waitFor(() => expect(mockResendEmailsSend).toHaveBeenCalledTimes(1));

      const payload = mockResendEmailsSend.mock.calls[0][0] as {
        html: string;
        text: string;
      };
      const rate = 425 / 106;

      for (const body of [payload.html, payload.text]) {
        // Every amount is AED-only — no USD approximation anywhere.
        expect(body).not.toContain("≈");
        expect(body).not.toContain("$");
        expect(body).not.toContain("USD");
        // Line items in AED via the implied rate, rounded to the nearest 5
        // (no stored paid price on this payload).
        expect(body).toContain(`AED ${(Math.round((31 * rate) / 5) * 5).toFixed(2)}`);
        expect(body).toContain(`AED ${(Math.round((32 * rate) / 5) * 5).toFixed(2)}`);
        // Full breakdown: subtotal, delivery fee, total, payment method.
        expect(body).toContain(`AED ${(63 * rate).toFixed(2)}`);
        expect(body).toContain(`AED ${(43 * rate).toFixed(2)}`);
        expect(body).toContain("AED 425.00");
        expect(body).toContain("Subtotal");
        expect(body).toContain("Delivery fee");
        expect(body).toContain("Total");
        expect(body).toContain("Payment method");
        expect(body).toContain("Stripe");
        // Card message included.
        expect(body).toContain("Card message");
        expect(body).toContain("Mabrouk! So proud of you.");
      }
    });

    it("keeps a USD order in plain USD with the breakdown", async () => {
      const externalId = `web-usd-${Date.now()}`;
      const email = `usd-${Date.now()}@example.com`;

      const res = await request(app)
        .post("/api/orders")
        .send({
          appOrderId: externalId,
          items: [{ productName: "Red Roses", quantity: 2, priceUsd: 25 }],
          totals: { subtotal: 50, delivery_fee: 10, total: 60 },
          billing: { firstName: "Lina", lastName: "Haddad", email },
          payment: { method: "whish", verified: true, totalUsd: 60, currencyCode: "USD" },
        });

      expect(res.status).toBe(201);
      await vi.waitFor(() => expect(mockResendEmailsSend).toHaveBeenCalledTimes(1));

      const payload = mockResendEmailsSend.mock.calls[0][0] as {
        html: string;
        text: string;
      };
      for (const body of [payload.html, payload.text]) {
        expect(body).not.toContain("≈");
        expect(body).toContain("$50.00"); // subtotal + line total
        expect(body).toContain("$10.00"); // delivery fee
        expect(body).toContain("$60.00"); // total
        expect(body).toContain("Whish"); // payment method
      }
    });

    it("does NOT send a second confirmation email when the same order is re-ingested", async () => {
      const externalId = `web-dupe-${Date.now()}`;
      const email = `dupe-${Date.now()}@example.com`;
      const body = {
        appOrderId: externalId,
        items: [{ productName: "White Lilies", quantity: 1, priceUsd: 40 }],
        billing: { firstName: "Omar", lastName: "Saad", email },
        payment: { method: "stripe", verified: true, totalUsd: 40, currencyCode: "USD" },
      };

      // First ingest → new order → one confirmation email.
      const first = await request(app).post("/api/orders").send(body);
      expect(first.status).toBe(201);
      await vi.waitFor(() => expect(mockResendEmailsSend).toHaveBeenCalledTimes(1));

      // Re-ingest the identical payload → idempotent duplicate (HTTP 200).
      mockResendEmailsSend.mockClear();
      const second = await request(app).post("/api/orders").send(body);
      expect(second.status).toBe(200);
      expect(second.body.order_id).toBe(first.body.order_id);

      // Give any (incorrectly) scheduled async email a chance to fire, then
      // assert none did — re-ingest must not re-notify the customer.
      await new Promise((r) => setTimeout(r, 150));
      expect(mockResendEmailsSend).not.toHaveBeenCalled();
    });

    it("creates the order but skips the email when no customer email is on file", async () => {
      const externalId = `web-noemail-${Date.now()}`;

      const res = await request(app)
        .post("/api/orders")
        .send({
          appOrderId: externalId,
          items: [{ productName: "Tulips", quantity: 1, priceUsd: 30 }],
          billing: { firstName: "Nour", lastName: "Aziz", phone: `+9613${Date.now() % 10000000}` },
          payment: { method: "stripe", verified: true, totalUsd: 30, currencyCode: "USD" },
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);

      // No email address → the confirmation block is skipped entirely. Wait a
      // beat to be sure nothing fires asynchronously.
      await new Promise((r) => setTimeout(r, 150));
      expect(mockResendEmailsSend).not.toHaveBeenCalled();
    });
  },
);
