/**
 * Integration tests: GET /api/contacts and the manual-tag endpoints, exercised
 * against a REAL PostgreSQL database (not mocked db.query).
 *
 * Covers the computed Customer/Recipient role flags, recipient-only people
 * appearing in the list, role/tag filtering, search, pagination, and the
 * add/remove manual-tag endpoints (including reserved-word rejection and
 * workspace scoping).
 *
 * Auth/workspace and logger are stubbed; the database is real. The suite skips
 * automatically when DATABASE_URL is not set.
 *
 * Run via:
 *   bash test-integration-local.sh src/routes/contactsDashboard.integration.test.ts
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import pg from "pg";
import type { WorkspaceRequest } from "../lib/workspace";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;

const OWNER_ID = `__contacts_dash_test_${Date.now()}`;
const OTHER_OWNER_ID = `__contacts_dash_other_${Date.now()}`;

const roleState = vi.hoisted(() => ({ role: "owner" as "owner" | "member" }));

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
    wreq.workspaceRole = roleState.role;
    wreq.workspaceActualRole = roleState.role;
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
  hasPageAccess: () => true,
}));

vi.mock("../lib/logger", () => ({ logger: mockLogger }));

import contactsDashboardRouter from "./contactsDashboard";

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
  app.use("/api", contactsDashboardRouter);
  return app;
}

async function cleanup(pool: InstanceType<typeof Pool>): Promise<void> {
  for (const owner of [OWNER_ID, OTHER_OWNER_ID]) {
    await pool.query(`DELETE FROM orders WHERE workspace_owner_id = $1`, [owner]);
    await pool.query(`DELETE FROM contacts WHERE workspace_owner_id = $1`, [owner]);
    await pool.query(`DELETE FROM customers WHERE workspace_owner_id = $1`, [owner]);
  }
}

describe.skipIf(!DATABASE_URL)("GET /api/contacts (integration)", () => {
  let pool: InstanceType<typeof Pool>;
  let app: express.Express;
  let uniqueSeq = 0;

  async function makeContact(opts: {
    owner?: string;
    displayName?: string;
    email?: string;
    phone?: string;
    tags?: string[];
  }): Promise<string> {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO contacts
         (workspace_owner_id, source, is_guest, display_name, email, phone, tags)
       VALUES ($1, 'external', true, $2, $3, $4, $5)
       RETURNING id`,
      [
        opts.owner ?? OWNER_ID,
        opts.displayName ?? null,
        opts.email ?? null,
        opts.phone ?? null,
        opts.tags ?? [],
      ],
    );
    return r.rows[0].id;
  }

  async function seedOrderWith(
    links: { contactId: string; role: "customer" | "recipient" }[],
    owner = OWNER_ID,
    opts?: { deliveryCountryCode?: string; paymentUsd?: number; paymentStatus?: string },
  ): Promise<string> {
    uniqueSeq += 1;
    const orderRes = await pool.query<{ id: string }>(
      `INSERT INTO orders
         (workspace_owner_id, source, external_order_id, status, ordered_at, totals, delivery_address)
       VALUES ($1, 'external', $2, 'pending', now(), $3::jsonb, $4::jsonb)
       RETURNING id`,
      [
        owner,
        `cdash-${Date.now()}-${uniqueSeq}-${Math.random().toString(36).slice(2, 8)}`,
        JSON.stringify({ total: 10, currency: "USD" }),
        opts?.deliveryCountryCode
          ? JSON.stringify({ countryCode: opts.deliveryCountryCode })
          : null,
      ],
    );
    const orderId = orderRes.rows[0].id;
    for (const l of links) {
      await pool.query(
        `INSERT INTO order_contacts (order_id, contact_id, role) VALUES ($1, $2, $3)`,
        [orderId, l.contactId, l.role],
      );
    }
    if (opts?.paymentUsd != null) {
      await pool.query(
        `INSERT INTO order_payment (order_id, status, amount_usd) VALUES ($1, $2, $3)`,
        [orderId, opts.paymentStatus ?? "paid", opts.paymentUsd],
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

  it("computes role flags and includes recipient-only people", async () => {
    // A: customer only
    const a = await makeContact({ displayName: "Alice Customer", email: "alice@example.com" });
    await seedOrderWith([{ contactId: a, role: "customer" }]);
    // B: recipient only — must still appear
    const b = await makeContact({ displayName: "Bob Recipient", phone: "+96170000002" });
    await seedOrderWith([{ contactId: b, role: "recipient" }]);
    // C: both roles
    const c = await makeContact({ displayName: "Carol Both", email: "carol@example.com" });
    await seedOrderWith([
      { contactId: c, role: "customer" },
      { contactId: c, role: "recipient" },
    ]);

    const res = await request(app).get("/api/contacts").query({ limit: 100 });
    expect(res.status).toBe(200);
    const byId = new Map<string, { is_customer: boolean; is_recipient: boolean }>(
      res.body.contacts.map((r: { id: string; is_customer: boolean; is_recipient: boolean }) => [
        r.id,
        r,
      ]),
    );

    expect(byId.get(a)).toMatchObject({ is_customer: true, is_recipient: false });
    expect(byId.get(b)).toMatchObject({ is_customer: false, is_recipient: true });
    expect(byId.get(c)).toMatchObject({ is_customer: true, is_recipient: true });
  });

  it("filters by role", async () => {
    const recOnly = await request(app)
      .get("/api/contacts")
      .query({ limit: 100, role: "recipient" });
    expect(recOnly.status).toBe(200);
    for (const r of recOnly.body.contacts) {
      expect(r.is_recipient).toBe(true);
    }

    const both = await request(app).get("/api/contacts").query({ limit: 100, role: "both" });
    for (const r of both.body.contacts) {
      expect(r.is_customer && r.is_recipient).toBe(true);
    }
  });

  it("supports search and excludes people not involved in orders", async () => {
    // A contact with no order link must NOT appear.
    await makeContact({ displayName: "Ghost NoOrders", email: "ghost@example.com" });

    const res = await request(app).get("/api/contacts").query({ search: "Ghost", limit: 100 });
    expect(res.status).toBe(200);
    expect(res.body.contacts).toHaveLength(0);

    const hit = await request(app).get("/api/contacts").query({ search: "Alice", limit: 100 });
    expect(hit.body.contacts.some((r: { email: string | null }) => r.email === "alice@example.com")).toBe(
      true,
    );
  });

  it("paginates", async () => {
    const p1 = await request(app).get("/api/contacts").query({ page: 1, limit: 2 });
    expect(p1.status).toBe(200);
    expect(p1.body.contacts.length).toBeLessThanOrEqual(2);
    expect(p1.body.limit).toBe(2);
    expect(p1.body.total).toBeGreaterThanOrEqual(3);
  });

  it("does not leak contacts from other workspaces", async () => {
    const other = await makeContact({
      owner: OTHER_OWNER_ID,
      displayName: "Other Workspace Person",
      email: "other@example.com",
    });
    await seedOrderWith([{ contactId: other, role: "customer" }], OTHER_OWNER_ID);

    const res = await request(app).get("/api/contacts").query({ limit: 100 });
    expect(res.body.contacts.some((r: { id: string }) => r.id === other)).toBe(false);
  });

  describe("manual tags", () => {
    it("adds, lists, filters, and removes a manual tag", async () => {
      const id = await makeContact({ displayName: "Tagged Person", email: "tagged@example.com" });
      await seedOrderWith([{ contactId: id, role: "customer" }]);

      const add = await request(app).post(`/api/contacts/${id}/tags`).send({ tag: "VIP" });
      expect(add.status).toBe(200);
      expect(add.body.tags).toContain("VIP");

      // Idempotent: adding the same tag again does not duplicate.
      const addAgain = await request(app).post(`/api/contacts/${id}/tags`).send({ tag: "VIP" });
      expect(addAgain.body.tags.filter((t: string) => t === "VIP")).toHaveLength(1);

      const list = await request(app).get("/api/contacts").query({ limit: 100 });
      expect(list.body.available_tags).toContain("VIP");
      const row = list.body.contacts.find((r: { id: string }) => r.id === id);
      expect(row.tags).toContain("VIP");

      const filtered = await request(app).get("/api/contacts").query({ tag: "VIP", limit: 100 });
      expect(filtered.body.contacts.every((r: { tags: string[] }) => r.tags.includes("VIP"))).toBe(
        true,
      );

      const del = await request(app).delete(`/api/contacts/${id}/tags/VIP`);
      expect(del.status).toBe(200);
      expect(del.body.tags).not.toContain("VIP");
    });

    it("rejects reserved role words as manual tags", async () => {
      const id = await makeContact({ displayName: "Reserved Test", email: "reserved@example.com" });
      await seedOrderWith([{ contactId: id, role: "customer" }]);

      for (const reserved of ["customer", "Recipient", "CUSTOMER"]) {
        const res = await request(app).post(`/api/contacts/${id}/tags`).send({ tag: reserved });
        expect(res.status).toBe(400);
      }
    });

    it("404s when tagging a contact in another workspace", async () => {
      const other = await makeContact({
        owner: OTHER_OWNER_ID,
        displayName: "Other Tagger",
        email: "othertag@example.com",
      });
      const res = await request(app).post(`/api/contacts/${other}/tags`).send({ tag: "x" });
      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/contacts/:id (detail)", () => {
    it("404s on a non-uuid id", async () => {
      const res = await request(app).get("/api/contacts/not-a-uuid");
      expect(res.status).toBe(404);
    });

    it("404s on a contact from another workspace", async () => {
      const other = await makeContact({
        owner: OTHER_OWNER_ID,
        displayName: "Other Detail",
        email: "otherdetail@example.com",
      });
      const res = await request(app).get(`/api/contacts/${other}`);
      expect(res.status).toBe(404);
    });

    it("returns contact detail with roles, tags and no customer match", async () => {
      const id = await makeContact({
        displayName: "Detail NoMatch",
        phone: "+96170001111",
        tags: ["VIP"],
      });
      await seedOrderWith([{ contactId: id, role: "recipient" }]);

      const res = await request(app).get(`/api/contacts/${id}`);
      expect(res.status).toBe(200);
      const c = res.body.contact;
      expect(c.id).toBe(id);
      expect(c.display_name).toBe("Detail NoMatch");
      expect(c.phone).toBe("+96170001111");
      expect(c.tags).toContain("VIP");
      expect(c.is_customer).toBe(false);
      expect(c.is_recipient).toBe(true);
      expect(c.orders_placed).toBe(0);
      expect(c.customer_id).toBeNull();
      expect(c.customer).toBeNull();
    });

    it("includes matched customer aggregates when a customers row matches by email", async () => {
      const email = "matched-detail@example.com";
      const id = await makeContact({ displayName: "Detail Matched", email });
      await seedOrderWith([{ contactId: id, role: "customer" }]);
      const cu = await pool.query<{ id: number }>(
        `INSERT INTO customers (workspace_owner_id, email, total_orders, total_spent, last_order_at)
         VALUES ($1, $2, 7, 123.45, now())
         RETURNING id`,
        [OWNER_ID, email],
      );

      const res = await request(app).get(`/api/contacts/${id}`);
      expect(res.status).toBe(200);
      const c = res.body.contact;
      expect(c.is_customer).toBe(true);
      expect(c.orders_placed).toBe(1);
      expect(c.customer_id).toBe(cu.rows[0].id);
      expect(c.customer).toMatchObject({
        id: cu.rows[0].id,
        total_orders: 7,
        total_spent: "123.45",
      });
      expect(c.customer.last_order_at).toBeTruthy();
    });

    it("ignores soft-deleted customers rows when matching", async () => {
      const email = "softdeleted-detail@example.com";
      const id = await makeContact({ displayName: "Detail SoftDel", email });
      await pool.query(
        `INSERT INTO customers (workspace_owner_id, email, total_orders, total_spent, deleted_at)
         VALUES ($1, $2, 3, 50, now())`,
        [OWNER_ID, email],
      );

      const res = await request(app).get(`/api/contacts/${id}`);
      expect(res.status).toBe(200);
      expect(res.body.contact.customer_id).toBeNull();
      expect(res.body.contact.customer).toBeNull();
    });
  });

  describe("GET /api/contacts/:id/orders", () => {
    it("404s on a non-uuid id and on another workspace's contact", async () => {
      const bad = await request(app).get("/api/contacts/nope/orders");
      expect(bad.status).toBe(404);

      const other = await makeContact({
        owner: OTHER_OWNER_ID,
        displayName: "Other Orders",
        email: "otherorders@example.com",
      });
      const res = await request(app).get(`/api/contacts/${other}/orders`);
      expect(res.status).toBe(404);
    });

    it("lists orders with per-order roles, merging both roles on one order", async () => {
      const id = await makeContact({ displayName: "Orders Person", email: "orders@example.com" });
      const asCustomer = await seedOrderWith([{ contactId: id, role: "customer" }]);
      const asRecipient = await seedOrderWith([{ contactId: id, role: "recipient" }]);
      const asBoth = await seedOrderWith([
        { contactId: id, role: "customer" },
        { contactId: id, role: "recipient" },
      ]);

      const res = await request(app).get(`/api/contacts/${id}/orders`);
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(3);
      expect(res.body.orders).toHaveLength(3);

      const byId = new Map(
        (res.body.orders as { id: string; roles: string[] }[]).map((o) => [o.id, o]),
      );
      expect(byId.get(asCustomer)?.roles).toEqual(["customer"]);
      expect(byId.get(asRecipient)?.roles).toEqual(["recipient"]);
      expect(byId.get(asBoth)?.roles).toEqual(["customer", "recipient"]);

      const first = res.body.orders[0];
      expect(first).toHaveProperty("status");
      expect(first).toHaveProperty("totals");
      expect(first.totals).toMatchObject({ total: 10, currency: "USD" });
    });

    it("paginates and clamps limit", async () => {
      const id = await makeContact({ displayName: "Pager", email: "pager@example.com" });
      for (let i = 0; i < 3; i++) {
        await seedOrderWith([{ contactId: id, role: "customer" }]);
      }

      const p1 = await request(app).get(`/api/contacts/${id}/orders`).query({ page: 1, limit: 2 });
      expect(p1.body.total).toBe(3);
      expect(p1.body.orders).toHaveLength(2);
      expect(p1.body.page).toBe(1);
      expect(p1.body.limit).toBe(2);

      const p2 = await request(app).get(`/api/contacts/${id}/orders`).query({ page: 2, limit: 2 });
      expect(p2.body.orders).toHaveLength(1);

      const clamped = await request(app)
        .get(`/api/contacts/${id}/orders`)
        .query({ limit: 5000 });
      expect(clamped.body.limit).toBe(100);
    });

    it("does not include another workspace's orders for a same-id contact", async () => {
      const id = await makeContact({ displayName: "Scoped Orders", email: "scoped@example.com" });
      await seedOrderWith([{ contactId: id, role: "customer" }]);
      // An order in the other workspace linked to the same contact id must not leak.
      await seedOrderWith([{ contactId: id, role: "customer" }], OTHER_OWNER_ID);

      const res = await request(app).get(`/api/contacts/${id}/orders`);
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);
    });
  });

  describe("CRM enrichment (spent, country, vip, duplicates, summary)", () => {
    it("computes total_spent_usd from paid/recorded customer payments only", async () => {
      const id = await makeContact({ displayName: "Spender", email: "spender@example.com" });
      await seedOrderWith([{ contactId: id, role: "customer" }], OWNER_ID, { paymentUsd: 40 });
      await seedOrderWith([{ contactId: id, role: "customer" }], OWNER_ID, {
        paymentUsd: 12.5,
        paymentStatus: "recorded",
      });
      // Pending payment must not count.
      await seedOrderWith([{ contactId: id, role: "customer" }], OWNER_ID, {
        paymentUsd: 100,
        paymentStatus: "pending",
      });
      // Recipient-role order payments must not count either.
      await seedOrderWith([{ contactId: id, role: "recipient" }], OWNER_ID, { paymentUsd: 77 });

      const res = await request(app).get("/api/contacts").query({ search: "Spender", limit: 10 });
      expect(res.status).toBe(200);
      const row = res.body.contacts.find((r: { id: string }) => r.id === id);
      expect(row.total_spent_usd).toBeCloseTo(52.5);
      expect(row.is_repeat).toBe(true);
      expect(row.orders_placed).toBe(3);
    });

    it("derives country from metadata, falls back to order delivery, and filters by it", async () => {
      const meta = await makeContact({ displayName: "Meta Country", email: "meta-country@example.com" });
      await pool.query(`UPDATE contacts SET metadata = '{"country_code":"AE"}'::jsonb WHERE id = $1`, [meta]);
      await seedOrderWith([{ contactId: meta, role: "customer" }]);

      const delivery = await makeContact({ displayName: "Delivery Country", email: "del-country@example.com" });
      await seedOrderWith([{ contactId: delivery, role: "recipient" }], OWNER_ID, {
        deliveryCountryCode: "LB",
      });

      const res = await request(app).get("/api/contacts").query({ limit: 100 });
      const metaRow = res.body.contacts.find((r: { id: string }) => r.id === meta);
      const delRow = res.body.contacts.find((r: { id: string }) => r.id === delivery);
      expect(metaRow.country).toBe("United Arab Emirates");
      expect(delRow.country).toBe("Lebanon");
      expect(res.body.available_countries).toEqual(
        expect.arrayContaining(["United Arab Emirates", "Lebanon"]),
      );

      const filtered = await request(app)
        .get("/api/contacts")
        .query({ country: "Lebanon", limit: 100 });
      expect(filtered.status).toBe(200);
      expect(filtered.body.contacts.some((r: { id: string }) => r.id === delivery)).toBe(true);
      expect(filtered.body.contacts.some((r: { id: string }) => r.id === meta)).toBe(false);
    });

    it("filters type=vip by the VIP manual tag", async () => {
      const vip = await makeContact({
        displayName: "Very Important",
        email: "vip@example.com",
        tags: ["VIP"],
      });
      await seedOrderWith([{ contactId: vip, role: "customer" }]);

      const res = await request(app).get("/api/contacts").query({ type: "vip", limit: 100 });
      expect(res.status).toBe(200);
      expect(res.body.contacts.some((r: { id: string }) => r.id === vip)).toBe(true);
      expect(res.body.contacts.every((r: { is_vip: boolean }) => r.is_vip === true)).toBe(true);
    });

    it("filters type=duplicates by normalized phone/email variants", async () => {
      const d1 = await makeContact({ displayName: "Dup One", phone: "+961 70 111 222" });
      await seedOrderWith([{ contactId: d1, role: "customer" }]);
      const d2 = await makeContact({ displayName: "Dup Two", phone: "96170111222" });
      await seedOrderWith([{ contactId: d2, role: "recipient" }]);

      const res = await request(app)
        .get("/api/contacts")
        .query({ type: "duplicates", limit: 100 });
      expect(res.status).toBe(200);
      const ids = res.body.contacts.map((r: { id: string }) => r.id);
      expect(ids).toContain(d1);
      expect(ids).toContain(d2);
      // Non-duplicate contacts are excluded.
      const all = await request(app).get("/api/contacts").query({ limit: 100 });
      expect(all.body.total).toBeGreaterThan(res.body.total);
    });

    it("GET /api/contacts/summary returns the four KPI counts", async () => {
      const res = await request(app).get("/api/contacts/summary");
      expect(res.status).toBe(200);
      for (const key of ["total_contacts", "customers", "recipients", "repeat_customers"]) {
        expect(res.body[key]).toHaveProperty("count");
        expect(typeof res.body[key].count).toBe("number");
      }
      // Everything was created this month → previous-month baselines are 0 → null deltas.
      expect(res.body.total_contacts.delta_pct).toBeNull();
      expect(res.body.total_contacts.count).toBeGreaterThanOrEqual(3);
      expect(res.body.repeat_customers.count).toBeGreaterThanOrEqual(1);
      expect(res.body.customers.count).toBeLessThanOrEqual(res.body.total_contacts.count);
    });
  });

  describe("notes and activity", () => {
    it("creates, edits, lists and deletes a note; note appears in activity", async () => {
      const cid = await makeContact({ displayName: "Note Person" });

      const created = await request(app)
        .post(`/api/contacts/${cid}/notes`)
        .send({ body: "First note" });
      expect(created.status).toBe(201);
      const noteId = created.body.note.id;
      expect(created.body.note.body).toBe("First note");

      const patched = await request(app)
        .patch(`/api/contacts/${cid}/notes/${noteId}`)
        .send({ body: "Edited note" });
      expect(patched.status).toBe(200);
      expect(patched.body.note.body).toBe("Edited note");

      const list = await request(app).get(`/api/contacts/${cid}/notes`);
      expect(list.status).toBe(200);
      expect(list.body.notes).toHaveLength(1);

      const activity = await request(app).get(`/api/contacts/${cid}/activity`);
      expect(activity.status).toBe(200);
      const noteItems = activity.body.items.filter(
        (i: { type: string }) => i.type === "note",
      );
      expect(noteItems).toHaveLength(1);
      expect(noteItems[0].body).toBe("Edited note");
      expect(String(noteItems[0].ref_id)).toBe(String(noteId));

      const del = await request(app).delete(`/api/contacts/${cid}/notes/${noteId}`);
      expect(del.status).toBe(200);
      const after = await request(app).get(`/api/contacts/${cid}/notes`);
      expect(after.body.notes).toHaveLength(0);
    });

    it("scopes notes to the workspace", async () => {
      const foreign = await makeContact({ owner: OTHER_OWNER_ID, displayName: "Foreign" });
      const res = await request(app)
        .post(`/api/contacts/${foreign}/notes`)
        .send({ body: "nope" });
      expect(res.status).toBe(404);
    });
  });

  describe("duplicates and merge", () => {
    it("lists duplicates by normalized phone and email with matched_on", async () => {
      const a = await makeContact({
        displayName: "Merge A",
        phone: "+961 71 999 888",
        email: "merge@example.com",
      });
      const b = await makeContact({
        displayName: "Merge B",
        phone: "96171999888",
        email: "MERGE@example.com",
      });
      const res = await request(app).get(`/api/contacts/${a}/duplicates`);
      expect(res.status).toBe(200);
      const dup = res.body.duplicates.find((d: { id: string }) => d.id === b);
      expect(dup).toBeDefined();
      expect(dup.matched_on).toBe("both");
    });

    it("merges the loser into the survivor transactionally", async () => {
      const survivor = await makeContact({
        displayName: "Survivor",
        phone: "+961 76 000 111",
      });
      const loser = await makeContact({
        displayName: "Loser",
        phone: "961 76 000 111",
        email: "loser@example.com",
        tags: ["vip"],
      });
      // Shared order (dedupe path) + a loser-only order that must move over.
      const sharedOrder = await seedOrderWith([
        { contactId: survivor, role: "customer" },
        { contactId: loser, role: "customer" },
      ]);
      await seedOrderWith([{ contactId: loser, role: "recipient" }]);
      await request(app).post(`/api/contacts/${loser}/notes`).send({ body: "keep me" });

      const res = await request(app)
        .post(`/api/contacts/${loser}/merge`)
        .send({ targetId: survivor });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, survivorId: survivor });

      // Loser row is gone.
      const gone = await request(app).get(`/api/contacts/${loser}`);
      expect(gone.status).toBe(404);

      // Survivor absorbed email, tag, orders, gifts and the note.
      const detail = await request(app).get(`/api/contacts/${survivor}`);
      expect(detail.status).toBe(200);
      expect(detail.body.contact.email).toBe("loser@example.com");
      expect(detail.body.contact.tags).toContain("vip");
      expect(detail.body.contact.orders_placed).toBe(1); // deduped shared order
      expect(detail.body.contact.gifts_received).toBe(1);

      const notes = await request(app).get(`/api/contacts/${survivor}/notes`);
      expect(notes.body.notes.map((n: { body: string }) => n.body)).toContain("keep me");

      // No duplicate order_contacts rows on the shared order.
      const links = await pool.query(
        `SELECT role, COUNT(*)::int AS n FROM order_contacts
          WHERE order_id = $1 AND contact_id = $2 GROUP BY role`,
        [sharedOrder, survivor],
      );
      for (const row of links.rows) expect(row.n).toBe(1);

      // A contact_merged activity entry was logged on the survivor.
      const activity = await request(app).get(`/api/contacts/${survivor}/activity`);
      expect(
        activity.body.items.some((i: { type: string }) => i.type === "contact_merged"),
      ).toBe(true);
    });

    it("rejects self-merge and cross-workspace merges", async () => {
      const a = await makeContact({ displayName: "Self" });
      const self = await request(app).post(`/api/contacts/${a}/merge`).send({ targetId: a });
      expect(self.status).toBe(400);

      const foreign = await makeContact({ owner: OTHER_OWNER_ID, displayName: "Foreign2" });
      const cross = await request(app)
        .post(`/api/contacts/${a}/merge`)
        .send({ targetId: foreign });
      expect(cross.status).toBe(404);
    });
  });

  describe("tag activity logging", () => {
    it("logs tag_added and tag_removed, and only on actual changes", async () => {
      const cid = await makeContact({ displayName: "Tag Logger" });

      const add = await request(app).post(`/api/contacts/${cid}/tags`).send({ tag: "vip" });
      expect(add.status).toBe(200);
      // Re-adding the same tag is a no-op and must NOT log again.
      const addAgain = await request(app)
        .post(`/api/contacts/${cid}/tags`)
        .send({ tag: "vip" });
      expect(addAgain.status).toBe(200);

      const rem = await request(app).delete(`/api/contacts/${cid}/tags/vip`);
      expect(rem.status).toBe(200);
      // Removing an absent tag must NOT log.
      const remAgain = await request(app).delete(`/api/contacts/${cid}/tags/vip`);
      expect(remAgain.status).toBe(200);

      const activity = await request(app).get(`/api/contacts/${cid}/activity`);
      expect(activity.status).toBe(200);
      const added = activity.body.items.filter(
        (i: { type: string }) => i.type === "tag_added",
      );
      const removed = activity.body.items.filter(
        (i: { type: string }) => i.type === "tag_removed",
      );
      expect(added).toHaveLength(1);
      expect(removed).toHaveLength(1);
      expect(added[0].data?.tag ?? added[0].data).toBeTruthy();
    });
  });

  describe("archive / unarchive", () => {
    it("archives (owner), hides from list + summary, keeps detail viewable, unarchives", async () => {
      const cid = await makeContact({
        displayName: "Archie Vable",
        email: "archie@example.com",
      });
      await seedOrderWith([{ contactId: cid, role: "customer" }]);

      const arch = await request(app).post(`/api/contacts/${cid}/archive`);
      expect(arch.status).toBe(200);

      // Hidden from list.
      const list = await request(app).get(`/api/contacts?search=Archie`);
      expect(list.status).toBe(200);
      expect(list.body.contacts.find((c: { id: string }) => c.id === cid)).toBeUndefined();

      // Excluded from summary counts.
      const summary = await request(app).get(`/api/contacts/summary`);
      expect(summary.status).toBe(200);

      // Detail still loads with archived_at set.
      const detail = await request(app).get(`/api/contacts/${cid}`);
      expect(detail.status).toBe(200);
      expect(detail.body.contact.archived_at).toBeTruthy();

      // Activity entries logged.
      const unarch = await request(app).post(`/api/contacts/${cid}/unarchive`);
      expect(unarch.status).toBe(200);
      const back = await request(app).get(`/api/contacts?search=Archie`);
      expect(back.body.contacts.some((c: { id: string }) => c.id === cid)).toBe(true);

      const activity = await request(app).get(`/api/contacts/${cid}/activity`);
      const types = activity.body.items.map((i: { type: string }) => i.type);
      expect(types).toContain("contact_archived");
      expect(types).toContain("contact_unarchived");
    });

    it("rejects archive/unarchive for non-owners with 403", async () => {
      const cid = await makeContact({ displayName: "Member Blocked" });
      roleState.role = "member";
      try {
        const arch = await request(app).post(`/api/contacts/${cid}/archive`);
        expect(arch.status).toBe(403);
        const unarch = await request(app).post(`/api/contacts/${cid}/unarchive`);
        expect(unarch.status).toBe(403);
      } finally {
        roleState.role = "owner";
      }
    });

    it("returns 404 for cross-workspace archive", async () => {
      const foreign = await makeContact({ owner: OTHER_OWNER_ID, displayName: "ForeignArch" });
      const res = await request(app).post(`/api/contacts/${foreign}/archive`);
      expect(res.status).toBe(404);
    });
  });

  describe("preferred language", () => {
    it("sets, returns, and clears preferred_language via PATCH", async () => {
      const cid = await makeContact({ displayName: "Lang Person" });

      const set = await request(app)
        .patch(`/api/contacts/${cid}`)
        .send({ preferred_language: "Arabic" });
      expect(set.status).toBe(200);

      const detail = await request(app).get(`/api/contacts/${cid}`);
      expect(detail.body.contact.preferred_language).toBe("Arabic");

      const clear = await request(app)
        .patch(`/api/contacts/${cid}`)
        .send({ preferred_language: null });
      expect(clear.status).toBe(200);
      const after = await request(app).get(`/api/contacts/${cid}`);
      expect(after.body.contact.preferred_language).toBeNull();
    });

    it("rejects non-string preferred_language", async () => {
      const cid = await makeContact({ displayName: "Lang Bad" });
      const res = await request(app)
        .patch(`/api/contacts/${cid}`)
        .send({ preferred_language: 42 });
      expect(res.status).toBe(400);
    });
  });

  describe("profile metrics and role computation", () => {
    it("computes orders_placed, gifts_received, total_spent_usd, last_activity_at and role flags", async () => {
      const cid = await makeContact({
        displayName: "Metric Person",
        email: "metrics@example.com",
      });
      // Two orders placed (one paid $25), one gift received.
      await seedOrderWith([{ contactId: cid, role: "customer" }], OWNER_ID, {
        paymentUsd: 25,
      });
      await seedOrderWith([{ contactId: cid, role: "customer" }]);
      await seedOrderWith([{ contactId: cid, role: "recipient" }]);

      const res = await request(app).get(`/api/contacts/${cid}`);
      expect(res.status).toBe(200);
      const c = res.body.contact;
      expect(c.orders_placed).toBe(2);
      expect(c.gifts_received).toBe(1);
      expect(c.is_customer).toBe(true);
      expect(c.is_recipient).toBe(true);
      expect(c.total_spent_usd).toBe(25);
      expect(c.last_activity_at).toBeTruthy();
    });

    it("keeps roles false and metrics zero for a contact with no orders", async () => {
      const cid = await makeContact({ displayName: "Zero Person" });
      const res = await request(app).get(`/api/contacts/${cid}`);
      expect(res.status).toBe(200);
      const c = res.body.contact;
      expect(c.orders_placed).toBe(0);
      expect(c.gifts_received).toBe(0);
      expect(c.is_customer).toBe(false);
      expect(c.is_recipient).toBe(false);
      expect(c.total_spent_usd).toBe(0);
    });
  });
});
