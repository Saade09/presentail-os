/**
 * Integration tests: PATCH /api/orders/:id/contacts, exercised against a REAL
 * PostgreSQL database (not mocked db.query).
 *
 * The unit tests in orders.test.ts mock every db.query call, so they cannot
 * catch column-name drift, the real unique-index behaviour, or the actual
 * UPDATE/INSERT wiring. This suite seeds real orders + contacts, edits them
 * through the endpoint, and asserts both the contacts table and the GET order
 * detail response reflect the change. It also drives the HTTP 409 unique
 * violation against a real `contacts_workspace_*_unique` index.
 *
 * Auth/workspace and logger are stubbed; the database is real. The suite skips
 * automatically when DATABASE_URL is not set.
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

const OWNER_ID = `__order_contacts_test_${Date.now()}`;

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn().mockReturnThis(),
}));

const mockPlaceAi = vi.hoisted(() => ({
  assessPlaceValidity: vi.fn().mockResolvedValue({ valid: true, reason: "test" }),
  geocodeAddress: vi.fn().mockResolvedValue(null),
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
    wreq.userId = "integration-test-owner";
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
  hasPageAccess: () => true,
}));

vi.mock("../lib/logger", () => ({ logger: mockLogger }));

vi.mock("../lib/placeAiAssessor.js", () => ({
  assessPlaceValidity: mockPlaceAi.assessPlaceValidity,
  geocodeAddress: mockPlaceAi.geocodeAddress,
}));

vi.mock("../lib/catalogWebhook", () => ({
  fireWebhookEvent: vi.fn().mockResolvedValue(undefined),
}));

import ordersRouter from "./orders";
import addressBookRouter from "./addressBook";
import { linkOrderToAddressBook } from "../lib/addressBookAutoLink";
import { runBackfill } from "../jobs/addressBookBackfill";

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
  app.use("/api", addressBookRouter);
  return app;
}

async function cleanup(pool: InstanceType<typeof Pool>): Promise<void> {
  await pool.query(`DELETE FROM orders WHERE workspace_owner_id = $1`, [OWNER_ID]);
  await pool.query(`DELETE FROM places WHERE workspace_owner_id = $1`, [OWNER_ID]);
  await pool.query(`DELETE FROM contacts WHERE workspace_owner_id = $1`, [OWNER_ID]);
}

describe.skipIf(!DATABASE_URL)("PATCH /api/orders/:id/contacts (integration)", () => {
  let pool: InstanceType<typeof Pool>;
  let app: express.Express;
  let uniqueSeq = 0;

  // Seed an order and return its id. Optionally link a customer and/or
  // recipient contact created from the supplied fields. Returns the created
  // contact ids so callers can assert against them directly.
  async function seedOrder(opts?: {
    customer?: { name?: string; email?: string; phone?: string };
    recipient?: { name?: string; phone?: string; respondioContactId?: string | null };
    deliveryAddress?: Record<string, unknown>;
  }): Promise<{ orderId: string; customerId?: string; recipientId?: string }> {
    uniqueSeq += 1;
    const orderRes = await pool.query<{ id: string }>(
      `INSERT INTO orders
         (workspace_owner_id, source, external_order_id, status, ordered_at, totals, delivery_address)
        VALUES ($1, 'external', $2, 'pending', now(), $3::jsonb, $4::jsonb)
       RETURNING id`,
      [
        OWNER_ID,
        `contacts-${Date.now()}-${uniqueSeq}-${Math.random().toString(36).slice(2, 8)}`,
        JSON.stringify({ total: 40, currency: "USD" }),
        opts?.deliveryAddress ? JSON.stringify(opts.deliveryAddress) : null,
      ],
    );
    const orderId = orderRes.rows[0].id;

    let customerId: string | undefined;
    let recipientId: string | undefined;

    if (opts?.customer) {
      const c = await pool.query<{ id: string }>(
        `INSERT INTO contacts
           (workspace_owner_id, source, is_guest, display_name, email, phone)
         VALUES ($1, 'external', true, $2, $3, $4)
         RETURNING id`,
        [
          OWNER_ID,
          opts.customer.name ?? null,
          opts.customer.email ?? null,
          opts.customer.phone ?? null,
        ],
      );
      customerId = c.rows[0].id;
      await pool.query(
        `INSERT INTO order_contacts (order_id, contact_id, role) VALUES ($1, $2, 'customer')`,
        [orderId, customerId],
      );
    }

    if (opts?.recipient) {
      const r = await pool.query<{ id: string }>(
        `INSERT INTO contacts
           (workspace_owner_id, source, is_guest, display_name, phone, respondio_contact_id)
         VALUES ($1, 'external', true, $2, $3, $4)
         RETURNING id`,
        [
          OWNER_ID,
          opts.recipient.name ?? null,
          opts.recipient.phone ?? null,
          opts.recipient.respondioContactId ?? null,
        ],
      );
      recipientId = r.rows[0].id;
      await pool.query(
        `INSERT INTO order_contacts (order_id, contact_id, role) VALUES ($1, $2, 'recipient')`,
        [orderId, recipientId],
      );
    }

    return { orderId, customerId, recipientId };
  }

  async function createAddressBookTables(): Promise<void> {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS places (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_owner_id text NOT NULL,
        canonical_name text NOT NULL,
        place_type text NOT NULL DEFAULT 'residence',
        area text,
        city_id integer,
        canonical_address text,
        latitude numeric(10, 7),
        longitude numeric(10, 7),
        entrance_notes text,
        internal_notes text,
        verification_state text NOT NULL DEFAULT 'unverified',
        ai_invalid boolean,
        archived_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (workspace_owner_id, city_id, canonical_name)
      );
      CREATE TABLE IF NOT EXISTS place_aliases (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        place_id uuid NOT NULL REFERENCES places(id) ON DELETE CASCADE,
        alias_text text NOT NULL,
        normalized_alias text NOT NULL,
        language text,
        deleted_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (place_id, normalized_alias)
      );
      CREATE TABLE IF NOT EXISTS contact_addresses (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_owner_id text NOT NULL,
        contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        place_id uuid REFERENCES places(id) ON DELETE SET NULL,
        label text,
        raw_address text,
        area text,
        city_id integer,
        latitude numeric(10, 7),
        longitude numeric(10, 7),
        entrance_notes text,
        is_default boolean NOT NULL DEFAULT false,
        auto_linked boolean NOT NULL DEFAULT false,
        archived_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_addresses_active_contact_place
        ON contact_addresses(workspace_owner_id, contact_id, place_id)
        WHERE archived_at IS NULL AND place_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS order_place_links (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_owner_id text NOT NULL,
        order_id uuid NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
        place_id uuid NOT NULL REFERENCES places(id) ON DELETE CASCADE,
        linked_by_user_id text,
        linked_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS order_place_contact_links (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_owner_id text NOT NULL,
        order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
        place_id uuid NOT NULL REFERENCES places(id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (order_id, contact_id)
      );
      CREATE TABLE IF NOT EXISTS place_verification_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        place_id uuid NOT NULL REFERENCES places(id) ON DELETE CASCADE,
        event_type text NOT NULL,
        from_state text,
        to_state text,
        actor_user_id text,
        actor_name text,
        source text,
        notes text,
        metadata jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
  }

  async function getContact(
    id: string,
  ): Promise<{ display_name: string | null; email: string | null; phone: string | null } | null> {
    const res = await pool.query<{
      display_name: string | null;
      email: string | null;
      phone: string | null;
    }>(`SELECT display_name, email, phone FROM contacts WHERE id = $1`, [id]);
    return res.rows[0] ?? null;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    app = makeApp();
    await createAddressBookTables();
    await cleanup(pool);
  });

  afterAll(async () => {
    if (!pool) return;
    await cleanup(pool);
    await pool.end();
  });

  beforeEach(() => {
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
  });

  it("edits an existing customer contact and reflects it in DB + order detail", async () => {
    const { orderId, customerId } = await seedOrder({
      customer: { name: "Old Name", email: "old-cust@example.com", phone: "+96100000001" },
    });

    const res = await request(app)
      .patch(`/api/orders/${orderId}/contacts`)
      .send({
        customer: {
          name: "New Name",
          email: "NEW-Cust@Example.com",
          phone: "+961 70 111 222",
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Email is lowercased; phone is normalized to digits/+ only.
    const row = await getContact(customerId!);
    expect(row).toMatchObject({
      display_name: "New Name",
      email: "new-cust@example.com",
      phone: "+96170111222",
    });

    // GET order detail must reflect the same values.
    const detail = await request(app).get(`/api/orders/${orderId}`);
    expect(detail.status).toBe(200);
    const customer = (detail.body.contacts as Array<Record<string, unknown>>).find(
      (c) => c.role === "customer",
    );
    expect(customer).toMatchObject({
      display_name: "New Name",
      email: "new-cust@example.com",
      phone: "+96170111222",
    });
  });

  it("edits an existing recipient contact (name + phone, no email)", async () => {
    const { orderId, recipientId } = await seedOrder({
      recipient: { name: "Recipient Old", phone: "+96100000002" },
    });

    const res = await request(app)
      .patch(`/api/orders/${orderId}/contacts`)
      .send({ recipient: { name: "Recipient New", phone: "+961 71 999 888" } });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const row = await getContact(recipientId!);
    expect(row).toMatchObject({
      display_name: "Recipient New",
      phone: "+96171999888",
    });

    const detail = await request(app).get(`/api/orders/${orderId}`);
    const recipient = (detail.body.contacts as Array<Record<string, unknown>>).find(
      (c) => c.role === "recipient",
    );
    expect(recipient).toMatchObject({
      display_name: "Recipient New",
      phone: "+96171999888",
    });
  });

  it("returns the linked recipient's respond.io profile URL", async () => {
    const previousSpaceId = process.env.RESPONDIO_SPACE_ID;
    process.env.RESPONDIO_SPACE_ID = "12345";
    try {
      const { orderId, recipientId } = await seedOrder({
        recipient: {
          name: "Synced Recipient",
          phone: "+961 71 111 222",
          respondioContactId: "respondio-contact-42",
        },
      });

      const detail = await request(app).get(`/api/orders/${orderId}`);
      expect(detail.status).toBe(200);
      const recipient = (detail.body.contacts as Array<Record<string, unknown>>).find(
        (c) => c.role === "recipient",
      );
      expect(recipient).toMatchObject({
        contact_id: recipientId,
        respondio_contact_id: "respondio-contact-42",
        respondio_url:
          "https://app.respond.io/space/12345/inbox/respondio-contact-42",
      });
    } finally {
      if (previousSpaceId === undefined) delete process.env.RESPONDIO_SPACE_ID;
      else process.env.RESPONDIO_SPACE_ID = previousSpaceId;
    }
  });

  it("returns a null respond.io URL when the recipient is not synced", async () => {
    const { orderId } = await seedOrder({
      recipient: { name: "Unsynced Recipient", phone: "+961 71 333 444" },
    });

    const detail = await request(app).get(`/api/orders/${orderId}`);
    expect(detail.status).toBe(200);
    const recipient = (detail.body.contacts as Array<Record<string, unknown>>).find(
      (c) => c.role === "recipient",
    );
    expect(recipient).toMatchObject({
      respondio_contact_id: null,
      respondio_url: null,
    });
  });

  it("returns a null respond.io URL when the Respond.io space is not configured", async () => {
    const previousSpaceId = process.env.RESPONDIO_SPACE_ID;
    delete process.env.RESPONDIO_SPACE_ID;
    try {
      const { orderId } = await seedOrder({
        recipient: {
          name: "Recipient Without Space",
          phone: "+961 71 555 666",
          respondioContactId: "respondio-contact-no-space",
        },
      });

      const detail = await request(app).get(`/api/orders/${orderId}`);
      expect(detail.status).toBe(200);
      const recipient = (detail.body.contacts as Array<Record<string, unknown>>).find(
        (c) => c.role === "recipient",
      );
      expect(recipient).toMatchObject({
        respondio_contact_id: "respondio-contact-no-space",
        respondio_url: null,
      });
    } finally {
      if (previousSpaceId === undefined) delete process.env.RESPONDIO_SPACE_ID;
      else process.env.RESPONDIO_SPACE_ID = previousSpaceId;
    }
  });

  it("creates and links a new contact when the role has none yet", async () => {
    const { orderId } = await seedOrder(); // no contacts linked

    const res = await request(app)
      .patch(`/api/orders/${orderId}/contacts`)
      .send({ customer: { name: "Brand New", email: "brand-new@example.com" } });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const detail = await request(app).get(`/api/orders/${orderId}`);
    const customer = (detail.body.contacts as Array<Record<string, unknown>>).find(
      (c) => c.role === "customer",
    );
    expect(customer).toMatchObject({
      display_name: "Brand New",
      email: "brand-new@example.com",
    });

    // The freshly created contact really exists in the contacts table.
    const created = await pool.query(
      `SELECT id FROM contacts WHERE workspace_owner_id = $1 AND email = $2`,
      [OWNER_ID, "brand-new@example.com"],
    );
    expect(created.rowCount).toBe(1);
  });

  it("returns 409 when an edit collides with another contact's email (real unique index)", async () => {
    // Two orders, each with its own customer contact. Editing order B's
    // customer to use order A's email must hit contacts_workspace_email_unique.
    const taken = `taken-${Date.now()}@example.com`;
    await seedOrder({ customer: { name: "Owner Of Email", email: taken } });
    const { orderId: orderB, customerId: custB } = await seedOrder({
      customer: { name: "Other", email: `other-${Date.now()}@example.com`, phone: "+96100000003" },
    });

    const res = await request(app)
      .patch(`/api/orders/${orderB}/contacts`)
      .send({ customer: { email: taken } });

    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(String(res.body.error)).toMatch(/already belongs/i);

    // The collided edit must NOT have been applied.
    const row = await getContact(custB!);
    expect(row?.email).not.toBe(taken);
  });

  it("returns 404 for an order outside the workspace", async () => {
    const res = await request(app)
      .patch(`/api/orders/00000000-0000-0000-0000-000000000000/contacts`)
      .send({ customer: { name: "Nope" } });

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it("links recipients (not gift senders), shares a Place across contacts, and keeps retries idempotent", async () => {
    const deliveryAddress = {
      address: "12 Cedar Street",
      district: "Achrafieh",
    };
    const gift = await seedOrder({
      customer: { name: "Gift Sender", phone: "+96170000101" },
      recipient: { name: "Gift Recipient", phone: "+96170000102" },
      deliveryAddress,
    });

    await linkOrderToAddressBook(gift.orderId, OWNER_ID, deliveryAddress);
    await linkOrderToAddressBook(gift.orderId, OWNER_ID, deliveryAddress);

    const place = await pool.query<{ id: string }>(
      `SELECT id FROM places WHERE workspace_owner_id = $1 AND canonical_name = $2`,
      [OWNER_ID, "12 Cedar Street"],
    );
    const placeId = place.rows[0]!.id;

    const giftLinks = await pool.query<{ contact_id: string }>(
      `SELECT contact_id FROM contact_addresses
        WHERE workspace_owner_id = $1 AND place_id = $2 AND archived_at IS NULL`,
      [OWNER_ID, placeId],
    );
    expect(giftLinks.rows.map((row) => row.contact_id)).toEqual([gift.recipientId]);

    const customerOnly = await seedOrder({
      customer: { name: "Delivery Customer", phone: "+96170000103" },
      deliveryAddress,
    });
    await linkOrderToAddressBook(customerOnly.orderId, OWNER_ID, deliveryAddress);

    const customerOnlyDetail = await request(app).get(`/api/address-book/places/${placeId}`);
    expect(customerOnlyDetail.status).toBe(200);
    expect(customerOnlyDetail.body.contacts.total).toBe(2);
    expect(customerOnlyDetail.body.contacts.items.map((contact: { id: string }) => contact.id).sort()).toEqual(
      [gift.recipientId, customerOnly.customerId].sort(),
    );

    // Delayed recipient data replaces the initial customer-only attribution for
    // this order, without removing an independently valid gift recipient.
    const delayedRecipient = await pool.query<{ id: string }>(
      `INSERT INTO contacts (workspace_owner_id, source, is_guest, display_name, phone)
       VALUES ($1, 'external', true, 'Delayed Recipient', '+96170000104')
       RETURNING id`,
      [OWNER_ID],
    );
    const delayedRecipientId = delayedRecipient.rows[0]!.id;
    await pool.query(
      `INSERT INTO order_contacts (order_id, contact_id, role) VALUES ($1, $2, 'recipient')`,
      [customerOnly.orderId, delayedRecipientId],
    );
    await linkOrderToAddressBook(customerOnly.orderId, OWNER_ID, deliveryAddress);

    const correctedDetail = await request(app).get(`/api/address-book/places/${placeId}`);
    expect(correctedDetail.status).toBe(200);
    expect(correctedDetail.body.contacts.total).toBe(2);
    expect(correctedDetail.body.contacts.items.map((contact: { id: string }) => contact.id).sort()).toEqual(
      [gift.recipientId, delayedRecipientId].sort(),
    );

    const activeCount = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM contact_addresses
        WHERE workspace_owner_id = $1 AND contact_id = $2 AND place_id = $3 AND archived_at IS NULL`,
      [OWNER_ID, gift.recipientId, placeId],
    );
    expect(activeCount.rows[0]?.count).toBe("1");
  });

  it("keeps a staff-edited automatic address when a later recipient replaces customer attribution", async () => {
    const deliveryAddress = { address: "91 Manual Notes Lane", district: "Mar Mikhael" };
    const order = await seedOrder({
      customer: { name: "Original Delivery Customer", phone: "+96170000301" },
      deliveryAddress,
    });
    await linkOrderToAddressBook(order.orderId, OWNER_ID, deliveryAddress);

    const autoAddress = await pool.query<{ id: string; place_id: string }>(
      `SELECT id, place_id
         FROM contact_addresses
        WHERE workspace_owner_id = $1
          AND contact_id = $2
          AND archived_at IS NULL`,
      [OWNER_ID, order.customerId],
    );
    const addressId = autoAddress.rows[0]!.id;
    const placeId = autoAddress.rows[0]!.place_id;

    const edit = await request(app)
      .put(`/api/contact-addresses/${addressId}`)
      .send({ entrance_notes: "Ring the side bell" });
    expect(edit.status).toBe(200);

    const replacement = await pool.query<{ id: string }>(
      `INSERT INTO contacts (workspace_owner_id, source, is_guest, display_name, phone)
       VALUES ($1, 'external', true, 'Corrected Recipient', '+96170000302')
       RETURNING id`,
      [OWNER_ID],
    );
    const recipientId = replacement.rows[0]!.id;
    await pool.query(
      `INSERT INTO order_contacts (order_id, contact_id, role) VALUES ($1, $2, 'recipient')`,
      [order.orderId, recipientId],
    );
    await linkOrderToAddressBook(order.orderId, OWNER_ID, deliveryAddress);

    const addresses = await pool.query<{
      contact_id: string;
      auto_linked: boolean;
      archived_at: Date | null;
      entrance_notes: string | null;
    }>(
      `SELECT contact_id, auto_linked, archived_at, entrance_notes
         FROM contact_addresses
        WHERE workspace_owner_id = $1 AND place_id = $2
        ORDER BY contact_id`,
      [OWNER_ID, placeId],
    );
    expect(addresses.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          contact_id: order.customerId,
          auto_linked: false,
          archived_at: null,
          entrance_notes: "Ring the side bell",
        }),
        expect.objectContaining({
          contact_id: recipientId,
          auto_linked: true,
          archived_at: null,
        }),
      ]),
    );
  });

  it("removes automatic Place attribution when a delivery address is cleared", async () => {
    const deliveryAddress = { address: "18 Cleared Address Road", district: "Gemmayze" };
    const order = await seedOrder({
      customer: { name: "Address Was Cleared", phone: "+96170000303" },
      deliveryAddress,
    });
    await linkOrderToAddressBook(order.orderId, OWNER_ID, deliveryAddress);

    const place = await pool.query<{ place_id: string }>(
      `SELECT place_id FROM order_place_links WHERE order_id = $1`,
      [order.orderId],
    );
    const placeId = place.rows[0]!.place_id;

    // An explicit null is an address removal, unlike a re-ingestion call that
    // opts into reading its retained snapshot.
    await linkOrderToAddressBook(order.orderId, OWNER_ID, null);

    const [orderLink, provenance, savedAddress] = await Promise.all([
      pool.query(`SELECT 1 FROM order_place_links WHERE order_id = $1`, [order.orderId]),
      pool.query(`SELECT 1 FROM order_place_contact_links WHERE order_id = $1`, [order.orderId]),
      pool.query<{ archived_at: Date | null }>(
        `SELECT archived_at FROM contact_addresses
          WHERE workspace_owner_id = $1 AND contact_id = $2 AND place_id = $3`,
        [OWNER_ID, order.customerId, placeId],
      ),
    ]);
    expect(orderLink.rowCount).toBe(0);
    expect(provenance.rowCount).toBe(0);
    expect(savedAddress.rows[0]?.archived_at).not.toBeNull();
  });

  it("removes automatic Place attribution when a replacement address is AI-invalid", async () => {
    const initialAddress = { address: "23 Previously Valid Street", district: "Hamra" };
    const order = await seedOrder({
      customer: { name: "AI Rejected Replacement", phone: "+96170000304" },
      deliveryAddress: initialAddress,
    });
    await linkOrderToAddressBook(order.orderId, OWNER_ID, initialAddress);

    const originalPlace = await pool.query<{ place_id: string }>(
      `SELECT place_id FROM order_place_links WHERE order_id = $1`,
      [order.orderId],
    );
    const originalPlaceId = originalPlace.rows[0]!.place_id;

    mockPlaceAi.assessPlaceValidity.mockResolvedValueOnce({
      valid: false,
      reason: "not a delivery location",
    });
    await linkOrderToAddressBook(order.orderId, OWNER_ID, {
      address: "Unusable replacement address",
      district: "Hamra",
    });

    const [orderLink, provenance, savedAddress] = await Promise.all([
      pool.query(`SELECT 1 FROM order_place_links WHERE order_id = $1`, [order.orderId]),
      pool.query(`SELECT 1 FROM order_place_contact_links WHERE order_id = $1`, [order.orderId]),
      pool.query<{ archived_at: Date | null }>(
        `SELECT archived_at FROM contact_addresses
          WHERE workspace_owner_id = $1 AND contact_id = $2 AND place_id = $3`,
        [OWNER_ID, order.customerId, originalPlaceId],
      ),
    ]);
    expect(orderLink.rowCount).toBe(0);
    expect(provenance.rowCount).toBe(0);
    expect(savedAddress.rows[0]?.archived_at).not.toBeNull();
  });

  it("backfills historical links, imports unlinked deliveries, and excludes archived addresses from Place detail", async () => {
    const historicalAddress = { address: "8 Olive Road", district: "Verdun" };
    const historical = await seedOrder({
      recipient: { name: "Historical Recipient", phone: "+96170000201" },
      deliveryAddress: historicalAddress,
    });
    const historicalPlace = await pool.query<{ id: string }>(
      `INSERT INTO places (workspace_owner_id, canonical_name, place_type)
       VALUES ($1, $2, 'residence') RETURNING id`,
      [OWNER_ID, "8 Olive Road"],
    );
    const historicalPlaceId = historicalPlace.rows[0]!.id;
    await pool.query(
      `INSERT INTO order_place_links (workspace_owner_id, order_id, place_id)
       VALUES ($1, $2, $3)`,
      [OWNER_ID, historical.orderId, historicalPlaceId],
    );

    const unlinkedAddress = { address: "44 Palm Avenue", district: "Hamra" };
    const unlinked = await seedOrder({
      recipient: { name: "Imported Recipient", phone: "+96170000202" },
      deliveryAddress: unlinkedAddress,
    });

    await runBackfill({ workspaceId: OWNER_ID });
    await runBackfill({ workspaceId: OWNER_ID });

    const historicalLinks = await pool.query<{ contact_id: string }>(
      `SELECT contact_id FROM contact_addresses
        WHERE workspace_owner_id = $1 AND place_id = $2 AND archived_at IS NULL`,
      [OWNER_ID, historicalPlaceId],
    );
    expect(historicalLinks.rows.map((row) => row.contact_id)).toContain(historical.recipientId);

    const imported = await pool.query<{ place_id: string; count: string }>(
      `SELECT ca.place_id, COUNT(*)::text AS count
         FROM contact_addresses ca
         JOIN order_place_links opl ON opl.place_id = ca.place_id
        WHERE opl.order_id = $1
          AND ca.contact_id = $2
          AND ca.archived_at IS NULL
        GROUP BY ca.place_id`,
      [unlinked.orderId, unlinked.recipientId],
    );
    expect(imported.rows).toHaveLength(1);
    expect(imported.rows[0]?.count).toBe("1");

    await pool.query(
      `UPDATE contact_addresses
          SET archived_at = now()
        WHERE workspace_owner_id = $1
          AND contact_id = $2
          AND place_id = $3`,
      [OWNER_ID, historical.recipientId, historicalPlaceId],
    );
    const detail = await request(app).get(`/api/address-book/places/${historicalPlaceId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.contacts.total).toBe(0);
    expect(detail.body.contacts.items).toEqual([]);
  });
});
