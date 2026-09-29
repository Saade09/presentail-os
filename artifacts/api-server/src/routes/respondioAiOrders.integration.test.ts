/**
 * Real-PostgreSQL coverage for Respond.io AI order phone ownership checks.
 * In particular, these requests bind phone search tokens as text[] values;
 * mocked query tests cannot detect a PostgreSQL array-type regression.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import express from "express";
import pg from "pg";
import request from "supertest";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const OWNER_ID = `__respondio_ai_orders_${Date.now()}`;
const OTHER_OWNER_ID = `${OWNER_ID}_other`;
const CHANNEL_ID = `respondio-ai-channel-${Date.now()}`;
const AI_SECRET = `respondio-ai-secret-${Date.now()}`;

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn().mockReturnThis(),
}));
const { mockAssessPlaceValidity, mockGeocodeAddress, mockReverseGeocode } = vi.hoisted(() => ({
  mockAssessPlaceValidity: vi.fn(),
  mockGeocodeAddress: vi.fn(),
  mockReverseGeocode: vi.fn(),
}));

vi.mock("../lib/logger", () => ({ logger: mockLogger }));
vi.mock("../lib/placeAiAssessor.js", () => ({
  assessPlaceValidity: (...args: unknown[]) => mockAssessPlaceValidity(...args),
  geocodeAddress: (...args: unknown[]) => mockGeocodeAddress(...args),
}));
vi.mock("../lib/placeConflictChecker", () => ({
  reverseGeocode: (...args: unknown[]) => mockReverseGeocode(...args),
}));
vi.mock("./orders", async (original) => {
  const actual = await original<typeof import("./orders")>();
  return {
    ...actual,
    processPendingOrderRescheduleJobs: vi.fn(async () => undefined),
  };
});

import respondioAiOrdersRouter from "./respondioAiOrders";
import {
  processIncomingReply,
  registerIncomingReply,
  type IncomingReply,
} from "../lib/addressCollector/incomingReplyHandler";

function makeApp(): express.Express {
  const app = express();
  app.use((req, res, next) => {
    if (req.path === "/api/respondio/workflows/order-address-change") {
      express.raw({ type: "application/json" })(req, res, (error) => {
        if (error) return next(error);
        (req as express.Request & { rawBody?: Buffer }).rawBody =
          req.body as Buffer;
        next();
      });
      return;
    }
    express.json()(req, res, next);
  });
  app.use("/api", respondioAiOrdersRouter);
  return app;
}

describe.skipIf(!DATABASE_URL)("Respond.io AI orders (integration)", () => {
  let pool: InstanceType<typeof Pool>;
  let app: express.Express;
  let sequence = 0;
  let previousSecret: string | undefined;
  let previousIncomingSecret: string | undefined;

  async function cleanupWorkspace(workspaceOwnerId: string): Promise<void> {
    await pool.query(
      `DELETE FROM fleet_driver_order_assignments WHERE workspace_owner_id = $1`,
      [workspaceOwnerId],
    );
    await pool.query(`DELETE FROM orders WHERE workspace_owner_id = $1`, [workspaceOwnerId]);
    await pool.query(`DELETE FROM contacts WHERE workspace_owner_id = $1`, [workspaceOwnerId]);
    await pool.query(`DELETE FROM fleet_drivers WHERE workspace_owner_id = $1`, [workspaceOwnerId]);
    await pool.query(
      `DELETE FROM district_weekly_delivery_slots WHERE workspace_owner_id = $1`,
      [workspaceOwnerId],
    );
    await pool.query(`DELETE FROM delivery_cities WHERE workspace_owner_id = $1`, [
      workspaceOwnerId,
    ]);
    await pool.query(`DELETE FROM omni_channel_accounts WHERE workspace_owner_id = $1`, [
      workspaceOwnerId,
    ]);
  }

  async function cleanup(): Promise<void> {
    await cleanupWorkspace(OWNER_ID);
    await cleanupWorkspace(OTHER_OWNER_ID);
  }

  async function seedOrder(options: {
    workspaceOwnerId?: string;
    orderNumber: string;
    status?: string;
    customerPhone?: string;
    recipientPhones?: string[];
    deliveryAddress?: Record<string, unknown>;
  }): Promise<{ id: string }> {
    const workspaceOwnerId = options.workspaceOwnerId ?? OWNER_ID;
    const order = await pool.query<{ id: string }>(
      `INSERT INTO orders
         (workspace_owner_id, source, external_order_number, status, ordered_at,
          totals, card_message, delivery_address)
       VALUES ($1, 'integration-test', $2, $3, now(), $4::jsonb,
               'Original card message', $5::jsonb)
       RETURNING id`,
      [
        workspaceOwnerId,
        options.orderNumber,
        options.status ?? "pending",
        JSON.stringify({ total: 1, currency: "USD" }),
        JSON.stringify(options.deliveryAddress ?? {}),
      ],
    );

    async function addContact(phone: string, role: "customer" | "recipient"): Promise<void> {
      sequence += 1;
      const contact = await pool.query<{ id: string }>(
        `INSERT INTO contacts (workspace_owner_id, source, is_guest, display_name, phone)
         VALUES ($1, 'integration-test', true, $2, $3)
          ON CONFLICT (workspace_owner_id, phone) WHERE phone IS NOT NULL
          DO UPDATE SET updated_at = contacts.updated_at
         RETURNING id`,
        [workspaceOwnerId, `${role}-${sequence}`, phone],
      );
      await pool.query(
        `INSERT INTO order_contacts (order_id, contact_id, role) VALUES ($1, $2, $3)`,
        [order.rows[0]!.id, contact.rows[0]!.id, role],
      );
    }

    await addContact(options.customerPhone ?? "+96170000000", "customer");
    for (const phone of options.recipientPhones ?? []) {
      await addContact(phone, "recipient");
    }
    return { id: order.rows[0]!.id };
  }

  beforeAll(async () => {
    previousSecret = process.env.RESPONDIO_AI_AGENT_SECRET;
    previousIncomingSecret = process.env.RESPONDIO_INCOMING_WEBHOOK_SECRET;
    process.env.RESPONDIO_AI_AGENT_SECRET = AI_SECRET;
    process.env.RESPONDIO_INCOMING_WEBHOOK_SECRET = AI_SECRET;
    pool = new Pool({ connectionString: DATABASE_URL });
    app = makeApp();
    await cleanup();
    await pool.query(
      `INSERT INTO omni_channel_accounts
         (workspace_owner_id, provider, name, external_account_id, status, is_active)
       VALUES ($1, 'respondio', 'AI integration channel', $2, 'connected', true)`,
      [OWNER_ID, CHANNEL_ID],
    );
  });

  afterEach(async () => {
    await pool.query(
      `DELETE FROM fleet_driver_order_assignments WHERE workspace_owner_id IN ($1, $2)`,
      [OWNER_ID, OTHER_OWNER_ID],
    );
    await pool.query(`DELETE FROM orders WHERE workspace_owner_id IN ($1, $2)`, [
      OWNER_ID,
      OTHER_OWNER_ID,
    ]);
    await pool.query(`DELETE FROM contacts WHERE workspace_owner_id IN ($1, $2)`, [
      OWNER_ID,
      OTHER_OWNER_ID,
    ]);
    await pool.query(`DELETE FROM fleet_drivers WHERE workspace_owner_id IN ($1, $2)`, [
      OWNER_ID,
      OTHER_OWNER_ID,
    ]);
    await pool.query(
      `DELETE FROM district_weekly_delivery_slots WHERE workspace_owner_id IN ($1, $2)`,
      [OWNER_ID, OTHER_OWNER_ID],
    );
    await pool.query(`DELETE FROM delivery_cities WHERE workspace_owner_id IN ($1, $2)`, [
      OWNER_ID,
      OTHER_OWNER_ID,
    ]);
  });

  it("truthfully acknowledges an active native claim, then atomically recovers it after expiry", async () => {
    mockAssessPlaceValidity.mockResolvedValue({
      valid: true,
      reason: "specific address",
      locationHints: { city: "Beirut" },
    });
    mockGeocodeAddress.mockResolvedValue({
      lat: 33.8938,
      lng: 35.5018,
      matchType: "exact",
      precision: "landmark",
      method: "landmark_match",
      matchedLocation: "Sassine Square, Beirut",
      query: "Sassine Square, Beirut",
      provider: "nominatim",
      placeIdentity: "osm:integration",
      evidenceScore: 1,
    });
    const address = "Sassine Square, Achrafieh, Beirut";
    const phone = "+96170123460";
    const seeded = await seedOrder({
      orderNumber: "AI-ADDRESS-RACE-1",
      customerPhone: "+96170999998",
      recipientPhones: [phone],
      deliveryAddress: {
        address: "To be confirmed",
        noAddress: true,
        no_address: true,
        address_1: "Ask recipient",
      },
    });
    const collector = await pool.query<{ id: string }>(
      `INSERT INTO address_collection_requests
         (workspace_owner_id, order_id, recipient_name, recipient_phone, status,
          token_hash, token_expires_at, delivery_country_code,
          respondio_contact_id, respondio_channel_id, source, processing_started_at)
       VALUES ($1, $2, 'Recipient', $3, 'processing', $4,
               now() + interval '1 day', 'LB', 'contact-race', $5, 'order', now())
       RETURNING id`,
      [OWNER_ID, seeded.id, phone, `race-token-${Date.now()}`, CHANNEL_ID],
    );
    const requestId = collector.rows[0]!.id;
    await pool.query(
      `UPDATE orders SET tookan_job_id = 'existing-race-tookan-job' WHERE id = $1`,
      [seeded.id],
    );
    await pool.query(
      `INSERT INTO address_collection_actions
         (request_id, action_type, channel, scheduled_at, status, idempotency_key)
       VALUES ($1, 'reminder', 'whatsapp', now() + interval '1 hour', 'pending', $2)`,
      [requestId, `race-reminder-${requestId}`],
    );
    const providerMessageId = `race-native-${Date.now()}`;
    await pool.query(
      `INSERT INTO address_collection_inbound_messages
         (provider_message_id, channel_id, contact_id, workspace_owner_id,
          request_id, normalized_phone, reply_type, reply_text,
          processing_started_at, claim_token, attempt_count, received_at)
       VALUES ($1, $2, 'contact-race', $3, $4, $5, 'text', $6,
               now(), gen_random_uuid(), 1, now() - interval '1 hour')`,
      [providerMessageId, CHANNEL_ID, OWNER_ID, requestId, phone, address],
    );

    const callFallback = () => request(app)
      .post("/api/respondio/ai/address-collection/fallback")
      .set("Authorization", `Bearer ${AI_SECRET}`)
      .set("x-respondio-channel-id", CHANNEL_ID)
      .send({
        contact_phone: phone,
        contact_id: "contact-race",
        address_collection_ref: requestId,
        address,
      });

    const active = await callFallback();
    expect(active.status).toBe(200);
    expect(active.body).toMatchObject({
      success: true,
      processing: true,
      saved: false,
      changed: false,
      address_collection_ref: requestId,
      delivery_address: null,
    });
    const beforeExpiry = await pool.query<{ address: Record<string, unknown> }>(
      `SELECT delivery_address AS address FROM orders WHERE id = $1`,
      [seeded.id],
    );
    expect(beforeExpiry.rows[0]!.address.address).toBe("To be confirmed");

    await pool.query(
      `UPDATE address_collection_inbound_messages
          SET processing_started_at = now() - interval '11 minutes'
        WHERE provider_message_id = $1`,
      [providerMessageId],
    );
    await pool.query(
      `UPDATE address_collection_requests
          SET processing_started_at = now() - interval '11 minutes'
        WHERE id = $1`,
      [requestId],
    );

    const recoveredResponses = await Promise.all([callFallback(), callFallback()]);
    expect(recoveredResponses.every((response) => response.status === 200)).toBe(true);
    const changed = recoveredResponses.find((response) => response.body.changed === true);
    const concurrentRetry = recoveredResponses.find((response) => response.body.changed === false);
    expect(changed?.body).toMatchObject({
      success: true,
      processing: false,
      saved: true,
      changed: true,
      address_collection_ref: requestId,
      delivery_address: { address },
    });
    expect(concurrentRetry?.body).toMatchObject({
      success: true,
      processing: false,
      saved: true,
      changed: false,
      idempotent: true,
      address_collection_ref: requestId,
    });
    const retry = await callFallback();
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({
      saved: true,
      changed: false,
      idempotent: true,
      address_collection_ref: requestId,
    });

    const [storedOrder, storedRequest, inbounds, actions, events, orderEvents] = await Promise.all([
      pool.query(`SELECT delivery_address FROM orders WHERE id = $1`, [seeded.id]),
      pool.query(
        `SELECT status, closed_at, submitted_address, inbound_outcome
           FROM address_collection_requests WHERE id = $1`,
        [requestId],
      ),
      pool.query(
        `SELECT provider_message_id, outcome, processed_at, claim_token
           FROM address_collection_inbound_messages
          WHERE request_id = $1 ORDER BY received_at`,
        [requestId],
      ),
      pool.query(
        `SELECT action_type, status FROM address_collection_actions
          WHERE request_id = $1 ORDER BY action_type`,
        [requestId],
      ),
      pool.query(
        `SELECT event_type FROM address_collection_events WHERE request_id = $1`,
        [requestId],
      ),
      pool.query(
        `SELECT event_type FROM order_events
          WHERE order_id = $1 AND event_type = 'delivery_address_updated'`,
        [seeded.id],
      ),
    ]);
    expect(storedOrder.rows[0].delivery_address).toMatchObject({ address });
    expect(storedRequest.rows[0]).toMatchObject({
      status: "resolved",
      submitted_address: expect.objectContaining({ address }),
      inbound_outcome: "resolved",
    });
    expect(storedRequest.rows[0].closed_at).toBeTruthy();
    expect(inbounds.rows).toHaveLength(2);
    expect(inbounds.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider_message_id: providerMessageId,
        outcome: "superseded_by_support_fallback",
        claim_token: null,
      }),
      expect.objectContaining({ outcome: "resolved" }),
    ]));
    expect(actions.rows).toContainEqual({ action_type: "reminder", status: "cancelled" });
    expect(actions.rows.filter((row) =>
      row.action_type === "tookan_destination_update"
      && row.status === "pending")).toHaveLength(1);
    expect(events.rows.filter((row) => row.event_type === "reply_recovery_handoff")).toHaveLength(1);
    expect(events.rows.filter((row) => row.event_type === "reply_resolved")).toHaveLength(1);
    expect(orderEvents.rows).toHaveLength(1);
  });

  it("lets the native worker remain the sole writer when support overlaps a successful save", async () => {
    let releaseAssessment!: (value: {
      valid: boolean;
      reason: string;
      locationHints: { city: string };
    }) => void;
    mockAssessPlaceValidity.mockImplementation(() => new Promise((resolve) => {
      releaseAssessment = resolve;
    }));
    mockGeocodeAddress.mockResolvedValue({
      lat: 33.8938,
      lng: 35.5018,
      matchType: "exact",
      precision: "landmark",
      method: "landmark_match",
      matchedLocation: "Sassine Square, Beirut",
      query: "Sassine Square, Beirut",
      provider: "nominatim",
      placeIdentity: "osm:native-success",
      evidenceScore: 1,
    });
    mockReverseGeocode.mockResolvedValue({
      display_name: "Sassine Square, Achrafieh, Beirut, Lebanon",
      address: {
        city: "Beirut",
        suburb: "Achrafieh",
        country: "Lebanon",
        country_code: "lb",
      },
    });
    const address = "Sassine Square, Achrafieh, Beirut";
    const phone = "+96170123461";
    const seeded = await seedOrder({
      orderNumber: "AI-ADDRESS-RACE-2",
      customerPhone: "+96170999997",
      recipientPhones: [phone],
      deliveryAddress: { address: "To be confirmed", noAddress: true },
    });
    const collector = await pool.query<{ id: string }>(
      `INSERT INTO address_collection_requests
         (workspace_owner_id, order_id, recipient_name, recipient_phone, status,
          token_hash, token_expires_at, delivery_country_code,
          respondio_contact_id, respondio_channel_id, source)
       VALUES ($1, $2, 'Recipient', $3, 'whatsapp_sent', $4,
               now() + interval '1 day', 'LB', 'contact-native-success', $5, 'order')
       RETURNING id`,
      [OWNER_ID, seeded.id, phone, `native-success-${Date.now()}`, CHANNEL_ID],
    );
    const requestId = collector.rows[0]!.id;
    const reply: IncomingReply = {
      providerMessageId: `native-success-${Date.now()}`,
      rawPhone: phone,
      channelId: CHANNEL_ID,
      contactId: "contact-native-success",
      inReplyToProviderMessageId: null,
      type: "text",
      text: address,
      latitude: null,
      longitude: null,
    };
    expect(await registerIncomingReply(reply)).toBe(true);
    const nativeWork = processIncomingReply(reply);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const state = await pool.query<{ status: string }>(
        `SELECT status FROM address_collection_requests WHERE id = $1`,
        [requestId],
      );
      if (state.rows[0]?.status === "processing") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const overlap = await request(app)
      .post("/api/respondio/ai/address-collection/fallback")
      .set("Authorization", `Bearer ${AI_SECRET}`)
      .set("x-respondio-channel-id", CHANNEL_ID)
      .send({
        contact_phone: phone,
        contact_id: "contact-native-success",
        address,
      });
    expect(overlap.status).toBe(200);
    expect(overlap.body).toMatchObject({
      success: true,
      changed: false,
      idempotent: true,
    });
    if (overlap.body.processing) {
      expect(overlap.body).toMatchObject({
        saved: false,
        delivery_address: null,
      });
    } else {
      expect(overlap.body).toMatchObject({
        saved: true,
        delivery_address: { address },
      });
    }

    releaseAssessment?.({
      valid: true,
      reason: "specific address",
      locationHints: { city: "Beirut" },
    });
    await nativeWork;

    const settled = await request(app)
      .post("/api/respondio/ai/address-collection/fallback")
      .set("Authorization", `Bearer ${AI_SECRET}`)
      .set("x-respondio-channel-id", CHANNEL_ID)
      .send({
        contact_phone: phone,
        contact_id: "contact-native-success",
        address,
      });
    expect(settled.status).toBe(200);
    expect(settled.body).toMatchObject({
      processing: false,
      saved: true,
      changed: false,
      idempotent: true,
      delivery_address: { address },
    });
    const [requestState, inboundState, orderEvents] = await Promise.all([
      pool.query(`SELECT status, inbound_outcome FROM address_collection_requests WHERE id = $1`, [requestId]),
      pool.query(`SELECT outcome FROM address_collection_inbound_messages WHERE provider_message_id = $1`, [reply.providerMessageId]),
      pool.query(`SELECT event_type FROM order_events WHERE order_id = $1 AND event_type = 'delivery_address_updated'`, [seeded.id]),
    ]);
    expect(requestState.rows[0]).toMatchObject({ status: "resolved", inbound_outcome: "resolved" });
    expect(inboundState.rows[0]).toMatchObject({ outcome: "resolved" });
    expect(orderEvents.rows).toHaveLength(1);
  });

  it("returns the saved native pin when Respond.io later sends differently shaped location fields", async () => {
    mockAssessPlaceValidity.mockClear();
    mockGeocodeAddress.mockClear();
    const phone = "+96170123462";
    const seeded = await seedOrder({
      orderNumber: "AI-NATIVE-PIN-IDEMPOTENT",
      customerPhone: "+96170999996",
      recipientPhones: [phone],
      deliveryAddress: { address: "To be confirmed", noAddress: true },
    });
    const collector = await pool.query<{ id: string }>(
      `INSERT INTO address_collection_requests
         (workspace_owner_id, order_id, recipient_name, recipient_phone, status,
          token_hash, token_expires_at, delivery_country_code,
          respondio_contact_id, respondio_channel_id, source)
       VALUES ($1, $2, 'Recipient', $3, 'whatsapp_sent', $4,
               now() + interval '1 day', 'LB', 'contact-native-pin', $5, 'order')
       RETURNING id`,
      [OWNER_ID, seeded.id, phone, `native-pin-${Date.now()}`, CHANNEL_ID],
    );
    const requestId = collector.rows[0]!.id;
    const reply: IncomingReply = {
      providerMessageId: `native-pin-${Date.now()}`,
      rawPhone: phone,
      channelId: CHANNEL_ID,
      contactId: "contact-native-pin",
      inReplyToProviderMessageId: null,
      type: "location",
      text: null,
      latitude: 33.8938,
      longitude: 35.5018,
    };

    expect(await registerIncomingReply(reply)).toBe(true);
    await processIncomingReply(reply);

    const response = await request(app)
      .post("/api/respondio/ai/address-collection/fallback")
      .set("Authorization", `Bearer ${AI_SECRET}`)
      .set("x-respondio-channel-id", CHANNEL_ID)
      .send({
        contact_phone: phone,
        contact_id: "contact-native-pin",
        address_collection_ref: requestId,
        message_id: reply.providerMessageId,
        address: {
          lat: reply.latitude,
          lng: reply.longitude,
        },
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      changed: false,
      processing: false,
      saved: true,
      status: "saved",
      idempotent: true,
      address_collection_ref: requestId,
      delivery_address: {
        reply_type: "location",
        latitude: reply.latitude,
        longitude: reply.longitude,
        location: {
          latitude: reply.latitude,
          longitude: reply.longitude,
        },
      },
    });
    expect(mockAssessPlaceValidity).not.toHaveBeenCalled();
    expect(mockGeocodeAddress).not.toHaveBeenCalled();

    const saved = await pool.query<{
      status: string;
      delivery_address: Record<string, unknown>;
    }>(
      `SELECT r.status, o.delivery_address
         FROM address_collection_requests r
         JOIN orders o ON o.id = r.order_id
        WHERE r.id = $1`,
      [requestId],
    );
    expect(saved.rows[0]).toMatchObject({
      status: "resolved",
      delivery_address: {
        reply_type: "location",
        latitude: reply.latitude,
        longitude: reply.longitude,
      },
    });
  });

  afterAll(async () => {
    if (!pool) return;
    await cleanup();
    await pool.end();
    if (previousSecret === undefined) delete process.env.RESPONDIO_AI_AGENT_SECRET;
    else process.env.RESPONDIO_AI_AGENT_SECRET = previousSecret;
    if (previousIncomingSecret === undefined) {
      delete process.env.RESPONDIO_INCOMING_WEBHOOK_SECRET;
    } else {
      process.env.RESPONDIO_INCOMING_WEBHOOK_SECRET = previousIncomingSecret;
    }
  });

  it("finds an order by a canonical phone on a non-first recipient and excludes another workspace", async () => {
    const phone = "+96170123456";
    await seedOrder({
      orderNumber: "AI-12001",
      status: "ready_for_delivery",
      customerPhone: "+96170999999",
      recipientPhones: ["+96170888888", phone],
    });
    await seedOrder({
      workspaceOwnerId: OTHER_OWNER_ID,
      orderNumber: "AI-12002",
      status: "pending",
      customerPhone: phone,
    });

    const byPhone = await request(app)
      .post("/api/respondio/ai/orders/find")
      .set("Authorization", `Bearer ${AI_SECRET}`)
      .set("x-respondio-channel-id", CHANNEL_ID)
      .send({ phone: "+961 70 123 456" });

    expect(byPhone.status).toBe(200);
    expect(byPhone.body).toMatchObject({
      success: true,
      found: true,
      verified: true,
      count: 1,
      order: { orderNumber: "AI-12001", status: "ready_for_delivery" },
    });
    expect(byPhone.body.orders).toHaveLength(1);
    expect(byPhone.body.orders[0]).toMatchObject({
      order_number: "AI-12001",
      status: "ready_for_delivery",
    });

    const byOrderAndPhone = await request(app)
      .post("/api/respondio/ai/orders/find")
      .set("Authorization", `Bearer ${AI_SECRET}`)
      .set("x-respondio-channel-id", CHANNEL_ID)
      .send({ order_number: "AI-12001", customer_phone: "+96170123456" });

    expect(byOrderAndPhone.status).toBe(200);
    expect(byOrderAndPhone.body).toMatchObject({
      success: true,
      found: true,
      order: { orderNumber: "AI-12001", status: "ready_for_delivery" },
    });

    const byOrderOnly = await request(app)
      .post("/api/respondio/ai/orders/find")
      .set("Authorization", `Bearer ${AI_SECRET}`)
      .set("x-respondio-channel-id", CHANNEL_ID)
      .send({ orderNumber: "Order 12001" });

    expect(byOrderOnly.status).toBe(200);
    expect(byOrderOnly.body).toMatchObject({
      success: true,
      found: true,
      order: { orderNumber: "AI-12001", status: "ready_for_delivery" },
    });
  });

  it("finds an older terminal order by public number even when Respond.io supplies a different phone", async () => {
    const seeded = await seedOrder({
      orderNumber: "LB-2641",
      status: "completed",
      customerPhone: "+96170111111",
    });
    await pool.query(
      `UPDATE orders
          SET ordered_at = now() - INTERVAL '180 days',
              created_at = now() - INTERVAL '180 days'
        WHERE id = $1`,
      [seeded.id],
    );

    const response = await request(app)
      .post("/api/respondio/ai/orders/find")
      .set("Authorization", `Bearer ${AI_SECRET}`)
      .set("x-respondio-channel-id", CHANNEL_ID)
      .send({ orderNumber: "LB-2641", contactPhone: "+96170999999" });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      found: true,
      verified: true,
      verification_required: false,
      count: 1,
      order: {
        orderId: "2641",
        orderNumber: "LB-2641",
        status: "completed",
      },
    });
    expect(response.body.orders).toHaveLength(1);
  });

  it("updates card_message with customer_phone through preflight and locked ownership lookups", async () => {
    const phone = "+96170123457";
    const seeded = await seedOrder({
      orderNumber: "AI-12003",
      customerPhone: phone,
      recipientPhones: ["+96170888887"],
    });

    const response = await request(app)
      .patch("/api/respondio/ai/orders/AI-12003")
      .set("Authorization", `Bearer ${AI_SECRET}`)
      .set("x-respondio-channel-id", CHANNEL_ID)
      .send({
        customer_phone: "+961 70 123 457",
        changes: { card_message: "Updated by integration test" },
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      changed: true,
      changed_fields: ["card_message"],
      order_number: "AI-12003",
      order: { card_message: "Updated by integration test" },
    });
    const saved = await pool.query<{ card_message: string | null }>(
      `SELECT card_message FROM orders WHERE id = $1`,
      [seeded.id],
    );
    expect(saved.rows[0]?.card_message).toBe("Updated by integration test");
  });

  it("updates the linked canonical fleet assignment when Respond.io changes the schedule", async () => {
    const deliveryDate = "2099-01-02";
    const windowStart = "2099-01-02T14:00:00.000Z";
    const phone = "+96170123459";
    const seeded = await seedOrder({
      orderNumber: "AI-12006",
      customerPhone: phone,
    });
    const city = await pool.query<{ id: number }>(
      `INSERT INTO delivery_cities
         (workspace_owner_id, country_code, name, slug, is_active, delivery_timezone)
       VALUES ($1, 'LB', 'Respondio Integration City', $2, true, 'UTC')
       RETURNING id`,
      [OWNER_ID, `respondio-integration-city-${Date.now()}`],
    );
    const cityId = city.rows[0]!.id;
    const dayOfWeek = new Date(`${deliveryDate}T00:00:00.000Z`).getUTCDay();
    await pool.query(
      `INSERT INTO district_weekly_delivery_slots
         (city_id, workspace_owner_id, day_of_week, label, start_time, end_time,
          is_enabled, delivery_type, capacity, sort_order)
       VALUES ($1, $2, $3, 'Afternoon', '14:00', '18:00', true, 'standard', 10, 0)`,
      [cityId, OWNER_ID, dayOfWeek],
    );
    await pool.query(
      `UPDATE orders
          SET delivery_type = 'standard',
              delivery_address = $2::jsonb,
              window_start = '2099-01-01T09:00:00Z',
              window_end = '2099-01-01T12:00:00Z'
        WHERE id = $1`,
      [
        seeded.id,
        JSON.stringify({
          cityId,
          city: "Respondio Integration City",
          date: "2099-01-01",
          slot: "09:00–12:00",
        }),
      ],
    );
    const driver = await pool.query<{ id: number }>(
      `INSERT INTO fleet_drivers
         (workspace_owner_id, first_name, last_name, vehicle_type)
       VALUES ($1, 'Respondio', 'Driver', 'car')
       RETURNING id`,
      [OWNER_ID],
    );
    await pool.query(
      `INSERT INTO fleet_driver_order_assignments
         (workspace_owner_id, driver_id, order_id, order_reference, status, scheduled_at)
       VALUES ($1, $2, $3, 'DISPLAY-REFERENCE-NOT-ORDER-ID', 'assigned',
               '2099-01-01T09:00:00Z')`,
      [OWNER_ID, driver.rows[0]!.id, seeded.id],
    );

    const response = await request(app)
      .patch("/api/respondio/ai/orders/AI-12006")
      .set("Authorization", `Bearer ${AI_SECRET}`)
      .set("x-respondio-channel-id", CHANNEL_ID)
      .send({
        customer_phone: phone,
        changes: {
          delivery_date: deliveryDate,
          delivery_slot: { start_time: "14:00", end_time: "18:00" },
        },
      });

    expect(response.status).toBe(200);
    expect(response.body.changed_fields).toEqual(["delivery_date", "delivery_slot"]);
    const saved = await pool.query<{ window_start: Date; scheduled_at: Date | null }>(
      `SELECT o.window_start, a.scheduled_at
         FROM orders o
         JOIN fleet_driver_order_assignments a ON a.order_id = o.id
        WHERE o.id = $1`,
      [seeded.id],
    );
    expect(saved.rows[0]?.window_start.toISOString()).toBe(windowStart);
    expect(saved.rows[0]?.scheduled_at?.toISOString()).toBe(windowStart);
  });

  it("fails closed when a phone-only lookup matches multiple in-workspace orders", async () => {
    const phone = "+96170123458";
    await seedOrder({ orderNumber: "AI-12004", customerPhone: phone });
    await seedOrder({ orderNumber: "AI-12005", customerPhone: phone });

    const response = await request(app)
      .post("/api/respondio/ai/orders/find")
      .set("Authorization", `Bearer ${AI_SECRET}`)
      .set("x-respondio-channel-id", CHANNEL_ID)
      .send({ phone });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      found: false,
      count: 2,
    });
    expect(response.body).not.toHaveProperty("order");
  });

  it("persists one signed workflow receipt and returns the saved result on replay", async () => {
    const address = {
      address: "12 Cedar Street, Beirut",
      latitude: 33.89,
      longitude: 35.5,
    };
    const seeded = await seedOrder({
      orderNumber: "AI-12007",
      customerPhone: "+96170123460",
      deliveryAddress: address,
    });
    const body = {
      order_id: "12007",
      delivery_address: address.address,
      channel_id: CHANNEL_ID,
      request_id: `workflow-${Date.now()}`,
    };
    const signature = createHmac("sha256", AI_SECRET)
      .update(JSON.stringify(body))
      .digest("base64");

    const send = () => request(app)
      .post("/api/respondio/workflows/order-address-change")
      .set("X-Webhook-Signature", signature)
      .set("X-Respondio-Channel-Id", CHANNEL_ID)
      .send(body);

    const first = await send();
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      success: true,
      saved: true,
      changed: false,
      idempotent: true,
      order_number: "AI-12007",
      delivery_address: address,
    });

    const replay = await send();
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({
      success: true,
      saved: true,
      changed: false,
      idempotent: true,
      delivery_address: address,
    });

    const receipts = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM order_events
        WHERE order_id = $1
          AND payload->>'workflow_request_id' = $2`,
      [seeded.id, body.request_id],
    );
    expect(receipts.rows[0]?.count).toBe("1");
  });
});