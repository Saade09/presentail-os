/**
 * Integration test: email tracking end-to-end against real PostgreSQL.
 *
 * Covers the full pipeline:
 *   trackOrderEmail → inserts order_communications row (status=sent, with
 *     provider_message_id) via the real DB
 *   POST /api/webhooks/resend → verifies real svix signature, upgrades comm
 *     status, writes an order_communication_events ledger row, and mirrors the
 *     transition into the order_events activity feed.
 *
 * Unlike the unit tests (which mock ../lib/db and svix entirely), this suite
 * runs against a throwaway PostgreSQL instance so column drift between the
 * Drizzle schema and initDb.ts DDL is caught before production.
 *
 * What is mocked:
 *   - eventsSse.broadcastEvent  — fire-and-forget SSE, uses pg LISTEN/NOTIFY
 *     which doesn't matter here and would add noise.
 *   - logger                    — suppress output.
 * What is NOT mocked:
 *   - db (order_communications / order_communication_events / order_events)
 *   - svix Webhook              — the route verifies a real signature built by
 *     the same library, so the verification path is exercised end-to-end.
 *   - trackOrderEmail           — the real lib function runs against real PG.
 *
 * Run via:
 *   bash artifacts/api-server/test-integration-local.sh \
 *     src/routes/resendWebhook.emailTracking.integration.test.ts
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import pg from "pg";
import { Webhook } from "svix";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;

const OWNER_ID = `__email_tracking_int_test_${Date.now()}`;

// ─────────────────────────────────────────────────────────────────────────────
// Mocks — only the fire-and-forget side-effects that don't touch the DB path
// we want to exercise.
// ─────────────────────────────────────────────────────────────────────────────
vi.mock("../lib/eventsSse", () => ({ broadcastEvent: vi.fn() }));
vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

// Import after mocks are registered.
import { trackOrderEmail } from "../lib/orderComms";
import resendWebhookRouter from "./resendWebhook";

// ─────────────────────────────────────────────────────────────────────────────
// Svix signing helpers — use a real secret so the route's verify() call passes.
// ─────────────────────────────────────────────────────────────────────────────

// Svix requires the base64-decoded secret to be ≥24 bytes. 32 'x' bytes works.
const TEST_WEBHOOK_SECRET =
  "whsec_" + Buffer.alloc(32, "x").toString("base64");

/**
 * Signs a webhook payload and returns the headers + the raw JSON body string
 * (NOT a Buffer). The caller sends `bodyStr` via supertest's `.send(bodyStr)`
 * which emits it as plain text — the rawBody middleware captures those exact
 * bytes, so the svix HMAC computed over them matches the one computed here.
 */
function signWebhook(
  msgId: string,
  payload: Record<string, unknown>,
): { headers: Record<string, string>; bodyStr: string } {
  const wh = new Webhook(TEST_WEBHOOK_SECRET);
  const ts = new Date();
  const bodyStr = JSON.stringify(payload);
  const sig = wh.sign(msgId, ts, bodyStr);
  return {
    headers: {
      "svix-id": msgId,
      "svix-timestamp": Math.floor(ts.getTime() / 1000).toString(),
      "svix-signature": sig,
    },
    bodyStr,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Express test app — mirrors the rawBody capture in the production app.ts.
// NOTE: no express.json() so the route gets the raw bytes via req.rawBody.
// ─────────────────────────────────────────────────────────────────────────────
function makeApp(): express.Express {
  const app = express();
  // Capture rawBody before any body-parser so the route can verify the svix
  // signature.
  app.use((req: express.Request & { rawBody?: Buffer }, _res, next) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      req.rawBody = Buffer.concat(chunks);
      next();
    });
  });
  app.use((req, _res, next) => {
    (req as unknown as { log: Record<string, () => void> }).log = {
      error: () => {},
      warn: () => {},
      info: () => {},
      debug: () => {},
    };
    next();
  });
  app.use("/api", resendWebhookRouter);
  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
// DB helpers
// ─────────────────────────────────────────────────────────────────────────────
async function seedOrder(pool: InstanceType<typeof Pool>): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO orders
       (workspace_owner_id, source, external_order_id, status, ordered_at, totals)
     VALUES ($1, 'external', $2, 'pending', now(), $3::jsonb)
     RETURNING id`,
    [
      OWNER_ID,
      `email-track-int-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      JSON.stringify({ total: 50, currency: "USD" }),
    ],
  );
  return res.rows[0].id;
}

async function cleanup(pool: InstanceType<typeof Pool>): Promise<void> {
  // order_communications / order_communication_events / order_events all
  // cascade-delete when the parent order row is removed.
  await pool.query(`DELETE FROM orders WHERE workspace_owner_id = $1`, [
    OWNER_ID,
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!DATABASE_URL)(
  "Email tracking end-to-end (integration)",
  () => {
    let pool: InstanceType<typeof Pool>;
    let app: express.Express;
    let orderId: string;

    beforeAll(async () => {
      process.env.RESEND_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
      pool = new Pool({ connectionString: DATABASE_URL });
      app = makeApp();

      await cleanup(pool);
      orderId = await seedOrder(pool);
    });

    afterAll(async () => {
      if (!pool) return;
      await cleanup(pool);
      await pool.end();
      delete process.env.RESEND_WEBHOOK_SECRET;
    });

    // ── 1. trackOrderEmail → sent comm row ──────────────────────────────────

    it("trackOrderEmail inserts a sent comm row with the provider_message_id", async () => {
      const result = await trackOrderEmail(
        {
          workspaceOwnerId: OWNER_ID,
          orderId,
          templateType: "order_confirmation",
          recipientRole: "customer",
          recipientName: "Test Customer",
          recipientEmail: "test@example.com",
        },
        async () => ({
          sent: true,
          skipped: false,
          messageId: "re_track_int_sent",
          subject: "Your order confirmation",
          errorMessage: null,
        }),
      );

      // trackOrderEmail returns the sendFn result when sent=true.
      expect(result?.sent).toBe(true);
      expect(result?.messageId).toBe("re_track_int_sent");

      // Verify the DB row was written with the correct columns.
      const { rows } = await pool.query<{
        status: string;
        provider_message_id: string | null;
        template_type: string;
        recipient_email: string | null;
        sent_at: Date | null;
      }>(
        `SELECT status, provider_message_id, template_type, recipient_email, sent_at
           FROM order_communications
          WHERE order_id = $1 AND workspace_owner_id = $2
          ORDER BY created_at DESC
          LIMIT 1`,
        [orderId, OWNER_ID],
      );

      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row.status).toBe("sent");
      expect(row.provider_message_id).toBe("re_track_int_sent");
      expect(row.template_type).toBe("order_confirmation");
      expect(row.recipient_email).toBe("test@example.com");
      expect(row.sent_at).not.toBeNull();
    });

    // ── 2. trackOrderEmail with no email → not_sent row ────────────────────

    it("trackOrderEmail records a not_sent row when no recipient email is provided", async () => {
      const result = await trackOrderEmail(
        {
          workspaceOwnerId: OWNER_ID,
          orderId,
          templateType: "payment_instructions",
          recipientRole: "customer",
          recipientEmail: null,
        },
        async () => ({
          sent: false,
          skipped: false,
          messageId: null,
          subject: "",
          errorMessage: "No email",
        }),
      );

      // Returns null when there is no recipient email (send never called).
      expect(result).toBeNull();

      const { rows } = await pool.query<{ status: string; failure_reason: string | null }>(
        `SELECT status, failure_reason
           FROM order_communications
          WHERE order_id = $1 AND template_type = 'payment_instructions'
          ORDER BY created_at DESC
          LIMIT 1`,
        [orderId],
      );

      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("not_sent");
      expect(rows[0].failure_reason).toBe("No email address");
    });

    // ── 3. Signed webhook → status upgrade + events + activity ─────────────
    // The body is sent as a raw JSON string so supertest doesn't re-serialize
    // the bytes (which would break the svix HMAC computed over the original
    // JSON string in signWebhook).

    it("a signed email.delivered webhook upgrades status, sets delivered_at, and writes event + activity rows", async () => {
      const emailId = "re_track_int_sent"; // matches the row from test 1
      const svixMsgId = `msg_deliver_${Date.now()}`;

      const webhookBody = {
        type: "email.delivered",
        created_at: new Date().toISOString(),
        data: {
          email_id: emailId,
          to: ["test@example.com"],
          subject: "Your order confirmation",
        },
      };

      const { headers, bodyStr } = signWebhook(svixMsgId, webhookBody);

      const res = await request(app)
        .post("/api/webhooks/resend")
        .set(headers)
        .type("text/plain")
        .send(bodyStr);

      expect(res.status).toBe(200);
      expect(res.body.received).toBe(true);
      expect(res.body.duplicate).toBeUndefined();

      // ── comm row upgraded ─────────────────────────────────────────────────
      const { rows: commRows } = await pool.query<{
        status: string;
        delivered_at: Date | null;
        last_event_at: Date | null;
      }>(
        `SELECT status, delivered_at, last_event_at
           FROM order_communications
          WHERE provider_message_id = $1`,
        [emailId],
      );

      expect(commRows).toHaveLength(1);
      expect(commRows[0].status).toBe("delivered");
      expect(commRows[0].delivered_at).not.toBeNull();
      expect(commRows[0].last_event_at).not.toBeNull();

      // ── event ledger row written ──────────────────────────────────────────
      const { rows: eventRows } = await pool.query<{
        event_type: string;
        raw_type: string | null;
        provider_event_id: string | null;
        occurred_at: Date | null;
      }>(
        `SELECT e.event_type, e.raw_type, e.provider_event_id, e.occurred_at
           FROM order_communication_events e
           JOIN order_communications c ON c.id = e.communication_id
          WHERE c.provider_message_id = $1`,
        [emailId],
      );

      expect(eventRows).toHaveLength(1);
      expect(eventRows[0].event_type).toBe("delivered");
      expect(eventRows[0].raw_type).toBe("email.delivered");
      expect(eventRows[0].provider_event_id).toBe(svixMsgId);
      expect(eventRows[0].occurred_at).not.toBeNull();

      // ── activity row in order_events ──────────────────────────────────────
      const { rows: activityRows } = await pool.query<{ event_type: string }>(
        `SELECT event_type FROM order_events
          WHERE order_id = $1 AND event_type = 'email_delivered'`,
        [orderId],
      );

      expect(activityRows).toHaveLength(1);
      expect(activityRows[0].event_type).toBe("email_delivered");
    });

    // ── 4. Duplicate svix-id is idempotent ──────────────────────────────────
    // Seed the event ledger row directly so we only need ONE HTTP request —
    // this avoids any re-signing complexity while still verifying the
    // ON CONFLICT path in the route.

    it("posting a svix-id that is already in the event ledger returns duplicate=true without a new row", async () => {
      const emailId = "re_track_int_sent"; // comm row from test 1
      const knownSvixId = `msg_dupe_test_${Date.now()}`;

      // Find the comm row id.
      const { rows: commRows } = await pool.query<{ id: string }>(
        `SELECT id FROM order_communications WHERE provider_message_id = $1`,
        [emailId],
      );
      expect(commRows).toHaveLength(1);
      const commId = commRows[0].id;

      // Seed an event row with this svixId so the ON CONFLICT fires.
      await pool.query(
        `INSERT INTO order_communication_events
           (communication_id, provider_event_id, event_type, occurred_at)
         VALUES ($1, $2, 'delivered', now())`,
        [commId, knownSvixId],
      );

      // Count event rows before the duplicate request.
      const { rows: before } = await pool.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM order_communication_events WHERE communication_id = $1`,
        [commId],
      );
      const countBefore = Number(before[0].n);

      // Post a validly-signed webhook carrying the already-seen svixId.
      const webhookBody = {
        type: "email.delivered",
        created_at: new Date().toISOString(),
        data: { email_id: emailId, to: ["test@example.com"] },
      };
      const { headers, bodyStr } = signWebhook(knownSvixId, webhookBody);

      const res = await request(app)
        .post("/api/webhooks/resend")
        .set(headers)
        .type("text/plain")
        .send(bodyStr);

      expect(res.status).toBe(200);
      expect(res.body.duplicate).toBe(true);

      // The event ledger must not have grown.
      const { rows: after } = await pool.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM order_communication_events WHERE communication_id = $1`,
        [commId],
      );
      expect(Number(after[0].n)).toBe(countBefore);
    });

    // ── 5. Out-of-order delivery (opened then late delivered) ────────────────

    it("a late email.delivered after email.opened does not downgrade the status but still sets delivered_at", async () => {
      // Seed a second order + comm row already at status 'opened'.
      const orderId2 = await seedOrder(pool);
      const msgId2 = `re_track_int_opened_${Date.now()}`;

      await pool.query(
        `INSERT INTO order_communications
           (workspace_owner_id, order_id, template_type, recipient_role,
            recipient_email, status, provider_message_id, sent_at)
         VALUES ($1, $2, 'status_update', 'customer',
                 'opened@example.com', 'opened', $3, now())`,
        [OWNER_ID, orderId2, msgId2],
      );

      const svixMsgId = `msg_late_deliver_${Date.now()}`;
      const webhookBody = {
        type: "email.delivered",
        created_at: new Date().toISOString(),
        data: { email_id: msgId2, to: ["opened@example.com"] },
      };
      const { headers, bodyStr } = signWebhook(svixMsgId, webhookBody);

      const res = await request(app)
        .post("/api/webhooks/resend")
        .set(headers)
        .type("text/plain")
        .send(bodyStr);

      expect(res.status).toBe(200);

      // Status must NOT be downgraded from 'opened' → 'delivered'.
      const { rows } = await pool.query<{
        status: string;
        delivered_at: Date | null;
      }>(
        `SELECT status, delivered_at FROM order_communications
          WHERE provider_message_id = $1`,
        [msgId2],
      );

      expect(rows[0].status).toBe("opened"); // no downgrade
      expect(rows[0].delivered_at).not.toBeNull(); // timestamp still set (first-event-wins)

      // An event ledger row is still written even when the status didn't upgrade.
      const { rows: evtRows } = await pool.query<{ event_type: string }>(
        `SELECT e.event_type FROM order_communication_events e
           JOIN order_communications c ON c.id = e.communication_id
          WHERE c.provider_message_id = $1`,
        [msgId2],
      );

      expect(evtRows).toHaveLength(1);
      expect(evtRows[0].event_type).toBe("delivered");
    });

    // ── 6. Bounce → failure_reason + email_bounced activity ─────────────────

    it("a bounce event sets failure_reason and records email_bounced in order_events", async () => {
      const orderId3 = await seedOrder(pool);
      const msgId3 = `re_track_int_bounce_${Date.now()}`;

      await pool.query(
        `INSERT INTO order_communications
           (workspace_owner_id, order_id, template_type, recipient_role,
            recipient_email, status, provider_message_id, sent_at)
         VALUES ($1, $2, 'order_confirmation', 'customer',
                 'bounce@example.com', 'delivered', $3, now())`,
        [OWNER_ID, orderId3, msgId3],
      );

      const svixMsgId = `msg_bounce_${Date.now()}`;
      const webhookBody = {
        type: "email.bounced",
        created_at: new Date().toISOString(),
        data: {
          email_id: msgId3,
          to: ["bounce@example.com"],
          bounce: { message: "mailbox full" },
        },
      };
      const { headers, bodyStr } = signWebhook(svixMsgId, webhookBody);

      const res = await request(app)
        .post("/api/webhooks/resend")
        .set(headers)
        .type("text/plain")
        .send(bodyStr);

      expect(res.status).toBe(200);

      const { rows } = await pool.query<{
        status: string;
        failure_reason: string | null;
      }>(
        `SELECT status, failure_reason FROM order_communications
          WHERE provider_message_id = $1`,
        [msgId3],
      );

      expect(rows[0].status).toBe("bounced");
      expect(rows[0].failure_reason).toBe("mailbox full");

      const { rows: actRows } = await pool.query<{ event_type: string }>(
        `SELECT event_type FROM order_events
          WHERE order_id = $1 AND event_type = 'email_bounced'`,
        [orderId3],
      );

      expect(actRows).toHaveLength(1);
    });

    // ── 7. Invalid signature → 400, no DB writes ────────────────────────────

    it("returns 400 and writes nothing when the svix signature is invalid", async () => {
      const { rows: before } = await pool.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM order_communications WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );

      const res = await request(app)
        .post("/api/webhooks/resend")
        .set({
          "svix-id": "msg_bad_sig",
          "svix-timestamp": Math.floor(Date.now() / 1000).toString(),
          "svix-signature": "v1,invalidsignature",
        })
        .type("text/plain")
        .send(
          JSON.stringify({
            type: "email.delivered",
            created_at: new Date().toISOString(),
            data: { email_id: "re_track_int_sent" },
          }),
        );

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Invalid signature");

      const { rows: after } = await pool.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM order_communications WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      // No new rows written.
      expect(Number(after[0].n)).toBe(Number(before[0].n));
    });
  },
);
