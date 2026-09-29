import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";

const { mockAssess, mockGeocode, mockReverse } = vi.hoisted(() => ({
  mockAssess: vi.fn(),
  mockGeocode: vi.fn(),
  mockReverse: vi.fn(),
}));

vi.mock("../placeAiAssessor", () => ({
  assessPlaceValidity: (...args: unknown[]) => mockAssess(...args),
  geocodeAddress: (...args: unknown[]) => mockGeocode(...args),
}));

vi.mock("../placeConflictChecker", () => ({
  reverseGeocode: (...args: unknown[]) => mockReverse(...args),
}));

vi.mock("../logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { processIncomingReply, registerIncomingReply, type IncomingReply } from "./incomingReplyHandler";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const WORKSPACE = `__address_reply_${Date.now()}`;
const CHANNEL = `respondio-channel-${Date.now()}`;
const PHONE = "+9613159639";

describe.skipIf(!DATABASE_URL)("Respond.io inbound address lifecycle (integration)", () => {
  let pool: InstanceType<typeof Pool>;

  async function cleanup(): Promise<void> {
    await pool.query(
      `DELETE FROM address_collection_requests WHERE workspace_owner_id = $1`,
      [WORKSPACE],
    );
    await pool.query(
      `DELETE FROM omni_channel_accounts WHERE workspace_owner_id = $1`,
      [WORKSPACE],
    );
    await pool.query(`DELETE FROM orders WHERE workspace_owner_id = $1`, [WORKSPACE]);
  }

  async function seedRequest(opts: {
    contactId?: string | null;
    phone?: string;
    tookanJobId?: string | null;
    providerRef?: string | null;
  } = {}): Promise<{ orderId: string; requestId: string }> {
    const order = await pool.query<{ id: string }>(
      `INSERT INTO orders
         (workspace_owner_id, source, status, delivery_address, tookan_job_id)
       VALUES ($1, 'integration-test', 'pending', $2::jsonb, $3)
       RETURNING id`,
      [
        WORKSPACE,
        JSON.stringify({
          address: "Old address",
          city: "Beirut",
          countryCode: "LB",
           noAddress: true,
           no_address: true,
           address_1: "Ask recipient",
          date: "2026-09-01",
        }),
        opts.tookanJobId ?? null,
      ],
    );
    const request = await pool.query<{ id: string }>(
      `INSERT INTO address_collection_requests
         (workspace_owner_id, order_id, recipient_name, recipient_phone,
          status, token_hash, token_expires_at, delivery_country_code,
          respondio_contact_id, respondio_channel_id, source)
       VALUES ($1, $2, 'Recipient', $3, 'whatsapp_sent', $4,
               now() + interval '1 day', 'LB', $5, $6, 'order')
       RETURNING id`,
      [
        WORKSPACE,
        order.rows[0].id,
        opts.phone ?? PHONE,
        `token-${Date.now()}-${Math.random()}`,
        opts.contactId ?? null,
        CHANNEL,
      ],
    );
    await pool.query(
      `INSERT INTO address_collection_actions
         (request_id, action_type, channel, scheduled_at, status,
          idempotency_key, provider_ref)
       VALUES ($1, 'reminder', 'whatsapp', now() + interval '1 hour',
               'pending', $2, $3)`,
      [
        request.rows[0].id,
        `reminder-${request.rows[0].id}`,
        opts.providerRef ?? null,
      ],
    );
    return { orderId: order.rows[0].id, requestId: request.rows[0].id };
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await cleanup();
    await pool.query(
      `INSERT INTO omni_channel_accounts
         (workspace_owner_id, provider, name, external_account_id, status, is_active)
       VALUES ($1, 'respondio', 'Inbound integration', $2, 'connected', true)`,
      [WORKSPACE, CHANNEL],
    );
  });

  beforeEach(() => {
    mockAssess.mockReset().mockResolvedValue({
      valid: true,
      reason: "specific address",
      locationHints: { city: "Beirut" },
    });
    mockGeocode.mockReset().mockResolvedValue({
      lat: 33.8938,
      lng: 35.5018,
      matchType: "exact",
      precision: "landmark",
      method: "landmark_match",
      matchedLocation: "Sassine Square, Beirut",
      query: "Sassine Square",
      provider: "nominatim",
      placeIdentity: "osm:123",
      evidenceScore: 0.95,
    });
    mockReverse.mockReset().mockResolvedValue({
      display_name: "Sassine Square, Achrafieh, Beirut, Lebanon",
      address: {
        city: "Beirut",
        suburb: "Achrafieh",
        country: "Lebanon",
        country_code: "lb",
      },
    });
  });

  afterAll(async () => {
    if (!pool) return;
    await cleanup();
    await pool.end();
  });

  it("atomically stores the exact recipient text, request, reminders, audit, and Tookan update action", async () => {
    const seeded = await seedRequest({
      contactId: "recipient-contact",
      tookanJobId: "existing-tookan-job",
      providerRef: "outbound-template-exact",
    });
    const reply: IncomingReply = {
      providerMessageId: `incoming-${Date.now()}`,
      rawPhone: "03 159 639",
      channelId: CHANNEL,
      contactId: "purchaser-contact",
      inReplyToProviderMessageId: "outbound-template-exact",
      type: "text",
      text: "  beirut manara al mada building  ",
      latitude: null,
      longitude: null,
    };

    expect(await registerIncomingReply(reply)).toBe(true);
    await Promise.all([processIncomingReply(reply), processIncomingReply(reply)]);

    const [order, request, inbound, actions, collectorEvents, orderEvents] = await Promise.all([
      pool.query(`SELECT delivery_address FROM orders WHERE id = $1`, [seeded.orderId]),
      pool.query(`SELECT status, submitted_address, resolved_at FROM address_collection_requests WHERE id = $1`, [seeded.requestId]),
      pool.query(`SELECT outcome, processed_at, attempt_count FROM address_collection_inbound_messages WHERE provider_message_id = $1`, [reply.providerMessageId]),
      pool.query(`SELECT action_type, status FROM address_collection_actions WHERE request_id = $1 ORDER BY action_type`, [seeded.requestId]),
      pool.query(`SELECT event_type FROM address_collection_events WHERE request_id = $1`, [seeded.requestId]),
      pool.query(`SELECT event_type, payload FROM order_events WHERE order_id = $1`, [seeded.orderId]),
    ]);

    expect(order.rows[0].delivery_address).toMatchObject({
      address: "  beirut manara al mada building  ",
      source: "respondio_recipient_reply",
      reply_type: "text",
      date: "2026-09-01",
    });
    expect(order.rows[0].delivery_address).not.toHaveProperty("noAddress");
    expect(order.rows[0].delivery_address).not.toHaveProperty("no_address");
    expect(order.rows[0].delivery_address).not.toHaveProperty("address_1");
    expect(request.rows[0]).toMatchObject({ status: "resolved" });
    expect(request.rows[0].resolved_at).toBeTruthy();
    expect(inbound.rows[0]).toMatchObject({ outcome: "resolved", attempt_count: 1 });
    expect(inbound.rows[0].processed_at).toBeTruthy();
    expect(actions.rows).toEqual(expect.arrayContaining([
      { action_type: "reminder", status: "cancelled" },
      { action_type: "tookan_destination_update", status: "pending" },
    ]));
    expect(collectorEvents.rows.filter((row) => row.event_type === "reply_resolved")).toHaveLength(1);
    expect(orderEvents.rows).toHaveLength(1);
    expect(orderEvents.rows[0]).toMatchObject({
      event_type: "delivery_address_updated",
      payload: {
        source: "respondio_address_collection",
        previous_address: { address: "Old address" },
        recipient_phone: PHONE,
      },
    });
    expect(mockAssess).not.toHaveBeenCalled();
    expect(mockGeocode).not.toHaveBeenCalled();
    expect(mockReverse).not.toHaveBeenCalled();
  });

  it("selects only the newest eligible order for the recipient phone", async () => {
    const first = await seedRequest();
    const second = await seedRequest();
    const reply: IncomingReply = {
      providerMessageId: `ambiguous-${Date.now()}`,
      rawPhone: PHONE,
      channelId: CHANNEL,
      contactId: null,
      inReplyToProviderMessageId: null,
      type: "location",
      text: null,
      latitude: 33.8938,
      longitude: 35.5018,
    };

    await registerIncomingReply(reply);
    await processIncomingReply(reply);

    const result = await pool.query(
      `SELECT id, delivery_address FROM orders WHERE id = ANY($1::uuid[])`,
      [[first.orderId, second.orderId]],
    );
    const inbound = await pool.query(
      `SELECT outcome FROM address_collection_inbound_messages WHERE provider_message_id = $1`,
      [reply.providerMessageId],
    );
    expect(result.rows).toHaveLength(2);
    expect(result.rows.find((row) => row.id === first.orderId).delivery_address.address)
      .toBe("Old address");
    expect(result.rows.find((row) => row.id === second.orderId).delivery_address).toMatchObject({
      source: "respondio_recipient_reply",
      reply_type: "location",
      location: { latitude: 33.8938, longitude: 35.5018 },
      latitude: 33.8938,
      longitude: 35.5018,
    });
    expect(inbound.rows[0].outcome).toBe("resolved");
    expect(mockAssess).not.toHaveBeenCalled();
    expect(mockGeocode).not.toHaveBeenCalled();
    expect(mockReverse).not.toHaveBeenCalled();
  });

  it("stores an unrecognized text reply exactly without geocoding", async () => {
    mockGeocode.mockResolvedValue({
      lat: 33.902,
      lng: 35.59,
      matchType: "approximate",
      precision: "locality",
      method: "locality_fallback",
      matchedLocation: "Al Bayada, Lebanon",
      query: "Al Bayada, Lebanon",
      provider: "nominatim",
      placeIdentity: "osm:456",
      evidenceScore: 12,
    });
    mockReverse.mockResolvedValue({
      display_name: "Al Bayada, Lebanon",
      address: {
        city: "Beirut",
        suburb: "Al Bayada",
        country: "Lebanon",
        country_code: "lb",
      },
    });
    const seeded = await seedRequest({
      contactId: "contact-approximate",
      tookanJobId: "existing-tookan-job",
    });
    const reply: IncomingReply = {
      providerMessageId: `incoming-approximate-${Date.now()}`,
      rawPhone: "03 159 639",
      channelId: CHANNEL,
      contactId: "contact-approximate",
      inReplyToProviderMessageId: null,
      type: "text",
      text: "Al Bayada 5th Street Jamil Building",
      latitude: null,
      longitude: null,
    };

    expect(await registerIncomingReply(reply)).toBe(true);
    await processIncomingReply(reply);

    const [order, request, actions] = await Promise.all([
      pool.query(`SELECT delivery_address FROM orders WHERE id = $1`, [seeded.orderId]),
      pool.query(`SELECT status, submitted_address FROM address_collection_requests WHERE id = $1`, [seeded.requestId]),
      pool.query(`SELECT action_type, status FROM address_collection_actions WHERE request_id = $1`, [seeded.requestId]),
    ]);
    expect(order.rows[0].delivery_address).toMatchObject({
      address: "Al Bayada 5th Street Jamil Building",
      source: "respondio_recipient_reply",
      reply_type: "text",
    });
    expect(order.rows[0].delivery_address).not.toHaveProperty("noAddress");
    expect(order.rows[0].delivery_address).not.toHaveProperty("no_address");
    expect(order.rows[0].delivery_address).not.toHaveProperty("address_1");
    expect(request.rows[0]).toMatchObject({
      status: "resolved",
      submitted_address: expect.objectContaining({
        address: "Al Bayada 5th Street Jamil Building",
      }),
    });
    expect(actions.rows).toEqual(expect.arrayContaining([
      { action_type: "reminder", status: "cancelled" },
      { action_type: "tookan_destination_update", status: "pending" },
    ]));
  });

  it("does not fall back to a request when the incoming phone is not the recipient phone", async () => {
    const seeded = await seedRequest({ contactId: "contact-wrong-phone" });
    const reply: IncomingReply = {
      providerMessageId: `incoming-wrong-phone-${Date.now()}`,
      rawPhone: "+96170111111",
      channelId: CHANNEL,
      contactId: "contact-wrong-phone",
      inReplyToProviderMessageId: "outbound-template-for-wrong-phone",
      type: "text",
      text: "beirut manara al mada building",
      latitude: null,
      longitude: null,
    };

    await registerIncomingReply(reply);
    await processIncomingReply(reply);

    const [order, request, inbound] = await Promise.all([
      pool.query(`SELECT delivery_address FROM orders WHERE id = $1`, [seeded.orderId]),
      pool.query(`SELECT status FROM address_collection_requests WHERE id = $1`, [seeded.requestId]),
      pool.query(`SELECT outcome FROM address_collection_inbound_messages WHERE provider_message_id = $1`, [reply.providerMessageId]),
    ]);
    expect(order.rows[0].delivery_address.address).toBe("Old address");
    expect(request.rows[0].status).toBe("whatsapp_sent");
    expect(inbound.rows[0].outcome).toBe("unknown_phone");
  });

  it("stores gibberish text instead of sending it to review", async () => {
    const seeded = await seedRequest({ contactId: "contact-gibberish" });
    const reply: IncomingReply = {
      providerMessageId: `incoming-gibberish-${Date.now()}`,
      rawPhone: PHONE,
      channelId: CHANNEL,
      contactId: "different-contact",
      inReplyToProviderMessageId: null,
      type: "text",
      text: "qzxx 000 ???",
      latitude: null,
      longitude: null,
    };

    await registerIncomingReply(reply);
    await processIncomingReply(reply);

    const [order, request, inbound, actions] = await Promise.all([
      pool.query(`SELECT delivery_address FROM orders WHERE id = $1`, [seeded.orderId]),
      pool.query(`SELECT status FROM address_collection_requests WHERE id = $1`, [seeded.requestId]),
      pool.query(`SELECT outcome FROM address_collection_inbound_messages WHERE provider_message_id = $1`, [reply.providerMessageId]),
      pool.query(`SELECT action_type, status FROM address_collection_actions WHERE request_id = $1`, [seeded.requestId]),
    ]);
    expect(order.rows[0].delivery_address).toMatchObject({
      address: "qzxx 000 ???",
      source: "respondio_recipient_reply",
    });
    expect(request.rows[0].status).toBe("resolved");
    expect(inbound.rows[0].outcome).toBe("resolved");
    expect(actions.rows).toContainEqual({ action_type: "reminder", status: "cancelled" });
    expect(mockAssess).not.toHaveBeenCalled();
    expect(mockGeocode).not.toHaveBeenCalled();
    expect(mockReverse).not.toHaveBeenCalled();
  });
});