/**
 * Integration tests: the Audiences API against a REAL PostgreSQL database.
 *
 * Covers CRUD (create/list/update/archive/duplicate), rule validation via the
 * API, preview metrics + contact evidence, opportunity templates, summary
 * metrics, static membership management + snapshot, membership updates after
 * order/contact/consent changes, refresh persistence, dedup/self-order
 * semantics, and page-access permission enforcement.
 *
 * Run via:
 *   bash test-integration-local.sh src/routes/audiences.integration.test.ts
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import pg from "pg";
import type { WorkspaceRequest } from "../lib/workspace";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;

const OWNER_ID = `__audiences_test_${Date.now()}`;
const OTHER_OWNER_ID = `__audiences_other_${Date.now()}`;

const accessState = vi.hoisted(() => ({ allowed: true }));

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
    wreq.userId = "user_test";
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
  hasPageAccess: () => accessState.allowed,
}));

vi.mock("../lib/logger", () => ({ logger: mockLogger }));

import audiencesRouter from "./audiences";
import { refreshAudience } from "../lib/audienceRefreshJob";

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api", audiencesRouter);
  return app;
}

const RULES_ALL_CONTACTS = {
  schemaVersion: 1,
  include: { logic: "ALL", conditions: [{ field: "orders_count", operator: "gte", value: 0 }] },
};

async function cleanup(pool: InstanceType<typeof Pool>): Promise<void> {
  for (const owner of [OWNER_ID, OTHER_OWNER_ID]) {
    await pool.query(`DELETE FROM audiences WHERE workspace_owner_id = $1`, [owner]);
    await pool.query(`DELETE FROM orders WHERE workspace_owner_id = $1`, [owner]);
    await pool.query(`DELETE FROM contacts WHERE workspace_owner_id = $1`, [owner]);
  }
}

describe.skipIf(!DATABASE_URL)("Audiences API (integration)", () => {
  let pool: InstanceType<typeof Pool>;
  let app: express.Express;
  let seq = 0;

  async function makeContact(opts: {
    owner?: string;
    name?: string;
    email?: string;
    phone?: string;
    tags?: string[];
    emailConsent?: boolean;
    whatsappConsent?: boolean;
    unsubscribed?: boolean;
  }): Promise<string> {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO contacts
         (workspace_owner_id, source, is_guest, display_name, email, phone, tags,
          email_consent, whatsapp_consent, unsubscribed_at)
       VALUES ($1, 'external', true, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        opts.owner ?? OWNER_ID,
        opts.name ?? null,
        opts.email ?? null,
        opts.phone ?? null,
        opts.tags ?? [],
        opts.emailConsent ?? false,
        opts.whatsappConsent ?? false,
        opts.unsubscribed ? new Date() : null,
      ],
    );
    return r.rows[0].id;
  }

  async function seedOrder(
    links: { contactId: string; role: "customer" | "recipient" }[],
    opts?: { orderedAt?: string; paymentUsd?: number; owner?: string },
  ): Promise<string> {
    seq += 1;
    const r = await pool.query<{ id: string }>(
      `INSERT INTO orders
         (workspace_owner_id, source, external_order_id, status, ordered_at, totals)
       VALUES ($1, 'external', $2, 'pending', $3, '{"total":10,"currency":"USD"}'::jsonb)
       RETURNING id`,
      [
        opts?.owner ?? OWNER_ID,
        `aud-${Date.now()}-${seq}-${Math.random().toString(36).slice(2, 8)}`,
        opts?.orderedAt ?? new Date().toISOString(),
      ],
    );
    const orderId = r.rows[0].id;
    for (const l of links) {
      await pool.query(
        `INSERT INTO order_contacts (order_id, contact_id, role) VALUES ($1, $2, $3)`,
        [orderId, l.contactId, l.role],
      );
    }
    if (opts?.paymentUsd != null) {
      await pool.query(
        `INSERT INTO order_payment (order_id, status, amount_usd) VALUES ($1, 'paid', $2)`,
        [orderId, opts.paymentUsd],
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

  it("enforces page access on every endpoint", async () => {
    accessState.allowed = false;
    try {
      for (const [method, url] of [
        ["get", "/api/audiences"],
        ["post", "/api/audiences"],
        ["get", "/api/audiences/summary"],
        ["get", "/api/audiences/templates"],
        ["post", "/api/audiences/preview"],
      ] as const) {
        const res = await (request(app) as never as Record<string, (u: string) => request.Test>)[
          method
        ](url);
        expect(res.status, `${method} ${url}`).toBe(403);
      }
    } finally {
      accessState.allowed = true;
    }
  });

  it("rejects invalid rule trees with per-node errors on create and validate", async () => {
    const bad = {
      schemaVersion: 1,
      include: {
        logic: "ALL",
        conditions: [{ field: "bogus", operator: "eq", value: "x" }],
      },
    };
    const create = await request(app)
      .post("/api/audiences")
      .send({ name: "Bad", kind: "dynamic", rules: bad });
    expect(create.status).toBe(400);
    expect(create.body.rule_errors[0].path).toBe("include.conditions[0].field");

    const validate = await request(app).post("/api/audiences/validate").send({ rules: bad });
    expect(validate.status).toBe(200);
    expect(validate.body.valid).toBe(false);
    expect(validate.body.rule_errors.length).toBeGreaterThan(0);
  });

  it("CRUD: create draft → activate → update rules (version bump) → duplicate → archive", async () => {
    const create = await request(app)
      .post("/api/audiences")
      .send({ name: "Repeat buyers", kind: "dynamic", rules: RULES_ALL_CONTACTS });
    expect(create.status).toBe(201);
    const id = create.body.audience.id as string;
    expect(create.body.audience.status).toBe("draft");
    expect(create.body.audience.rules_version).toBe(1);
    expect(create.body.audience.rules_summary).toContain("Contacts where");

    const activate = await request(app).patch(`/api/audiences/${id}`).send({ status: "active" });
    expect(activate.status).toBe(200);
    expect(activate.body.audience.status).toBe("active");

    const newRules = {
      schemaVersion: 1,
      include: { logic: "ALL", conditions: [{ field: "is_repeat_customer", operator: "is_true" }] },
    };
    const update = await request(app).patch(`/api/audiences/${id}`).send({ rules: newRules });
    expect(update.status).toBe(200);
    expect(update.body.audience.rules_version).toBe(2);
    const versions = await pool.query(
      `SELECT version FROM audience_rule_versions WHERE audience_id = $1 ORDER BY version`,
      [id],
    );
    expect(versions.rows.map((r) => r.version)).toEqual([1, 2]);

    const dup = await request(app).post(`/api/audiences/${id}/duplicate`);
    expect(dup.status).toBe(201);
    expect(dup.body.audience.name).toContain("(copy)");
    expect(dup.body.audience.status).toBe("draft");

    const archive = await request(app).post(`/api/audiences/${id}/archive`);
    expect(archive.status).toBe(200);
    expect(archive.body.audience.status).toBe("archived");
    expect(archive.body.audience.archived_at).toBeTruthy();

    // Archived hidden by default, visible with status filter.
    const list = await request(app).get("/api/audiences").query({ limit: 100 });
    expect(list.body.audiences.map((a: { id: string }) => a.id)).not.toContain(id);
    const archived = await request(app).get("/api/audiences").query({ status: "archived" });
    expect(archived.body.audiences.map((a: { id: string }) => a.id)).toContain(id);
  });

  it("is workspace-scoped (404 for another workspace's audience)", async () => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO audiences (workspace_owner_id, name, kind, status) VALUES ($1, 'Other', 'static', 'draft') RETURNING id`,
      [OTHER_OWNER_ID],
    );
    const res = await request(app).get(`/api/audiences/${r.rows[0].id}`);
    expect(res.status).toBe(404);
  });

  it("preview computes counts, reachability, exclusions, avg spend, and evidence; dedup + self-order hold", async () => {
    await cleanup(pool);
    // sender: 2 orders — one gift to recipient, one self-order. Consented on email.
    const sender = await makeContact({
      name: "Sender",
      email: "sender@example.com",
      phone: "+96170000001",
      emailConsent: true,
    });
    // recipient: never purchased; whatsapp-consented.
    const recipient = await makeContact({
      name: "Recipient",
      phone: "+96170000002",
      whatsappConsent: true,
    });
    // suppressed: consented but globally unsubscribed → not reachable.
    const suppressed = await makeContact({
      name: "Suppressed",
      email: "sup@example.com",
      emailConsent: true,
      unsubscribed: true,
    });
    await seedOrder(
      [
        { contactId: sender, role: "customer" },
        { contactId: recipient, role: "recipient" },
      ],
      { paymentUsd: 100 },
    );
    // self-order: same contact both roles — must not duplicate or count as gift.
    await seedOrder(
      [
        { contactId: sender, role: "customer" },
        { contactId: sender, role: "recipient" },
      ],
      { paymentUsd: 50 },
    );

    const preview = await request(app)
      .post("/api/audiences/preview")
      .send({ rules: RULES_ALL_CONTACTS });
    expect(preview.status).toBe(200);
    const m = preview.body.metrics;
    expect(m.matched).toBe(3);
    expect(m.emailReachable).toBe(1); // sender only (suppressed is unsubscribed)
    expect(m.whatsappReachable).toBe(1); // recipient only
    expect(m.bothReachable).toBe(0);
    // avg spend across the 3 contacts: sender 150, others 0 → 50
    expect(m.avgLifetimeSpendUsd).toBe(50);

    // excluded count via exclusions group
    const withExclusion = await request(app)
      .post("/api/audiences/preview")
      .send({
        rules: {
          ...RULES_ALL_CONTACTS,
          exclude: { logic: "ALL", conditions: [{ field: "is_suppressed", operator: "is_true" }] },
        },
      });
    expect(withExclusion.body.metrics.matched).toBe(2);
    expect(withExclusion.body.metrics.excluded).toBe(1);

    // classification + gift semantics through the evaluator
    const senderOnly = await request(app)
      .post("/api/audiences/preview/contacts")
      .send({
        rules: {
          schemaVersion: 1,
          include: {
            logic: "ALL",
            conditions: [
              { field: "contact_type", operator: "eq", value: "both" },
              { field: "gifts_sent_count", operator: "eq", value: 1 },
              { field: "has_self_order", operator: "is_true" },
              { field: "orders_count", operator: "eq", value: 2 },
            ],
          },
          exclude: { logic: "ALL", conditions: [{ field: "is_suppressed", operator: "is_true" }] },
        },
      });
    expect(senderOnly.status).toBe(200);
    expect(senderOnly.body.total).toBe(1);
    const row = senderOnly.body.contacts[0];
    expect(row.id).toBe(sender);
    // evidence: every include condition matched, with actual values
    expect(row.evidence).toHaveLength(4);
    expect(row.evidence.every((e: { matched: boolean }) => e.matched)).toBe(true);
    const evByField = Object.fromEntries(
      row.evidence.map((e: { field: string; actual: unknown }) => [e.field, e.actual]),
    );
    expect(evByField.contact_type).toBe("both");
    expect(Number(evByField.orders_count)).toBe(2);
    // near-miss exclusions listed (sender not suppressed → matched false)
    expect(row.nearMissExclusions).toHaveLength(1);
    expect(row.nearMissExclusions[0].matched).toBe(false);

    // recipient-only classification: gifts received, never purchased
    const recOnly = await request(app)
      .post("/api/audiences/preview/contacts")
      .send({
        rules: {
          schemaVersion: 1,
          include: {
            logic: "ALL",
            conditions: [
              { field: "contact_type", operator: "eq", value: "recipient" },
              { field: "gifts_received_count", operator: "eq", value: 1 },
              { field: "orders_count", operator: "eq", value: 0 },
            ],
          },
        },
      });
    expect(recOnly.body.total).toBe(1);
    expect(recOnly.body.contacts[0].id).toBe(recipient);
  });

  it("templates return prefilled rule trees with live counts; lapsed window is editable", async () => {
    const res = await request(app).get("/api/audiences/templates");
    expect(res.status).toBe(200);
    const keys = res.body.templates.map((t: { key: string }) => t.key);
    expect(keys).toEqual([
      "recipients_never_purchased",
      "lapsed_gift_senders",
      "repeat_occasion_opportunity",
    ]);
    const neverPurchased = res.body.templates[0];
    expect(neverPurchased.metrics.matched).toBe(1); // the recipient seeded above
    expect(neverPurchased.rules.include.conditions.length).toBeGreaterThan(0);

    const custom = await request(app).get("/api/audiences/templates").query({ lapsed_days: 30 });
    const lapsed = custom.body.templates.find((t: { key: string }) => t.key === "lapsed_gift_senders");
    expect(lapsed.rules.include.conditions[1].value).toBe(30);
    // nothing persisted
    const count = await pool.query(
      `SELECT COUNT(*)::int AS n FROM audiences WHERE workspace_owner_id = $1 AND name ILIKE '%lapsed%'`,
      [OWNER_ID],
    );
    expect(count.rows[0].n).toBe(0);
  });

  it("summary metrics come from the shared evaluator", async () => {
    const res = await request(app).get("/api/audiences/summary");
    expect(res.status).toBe(200);
    expect(res.body.email_reachable).toBe(1);
    expect(res.body.whatsapp_reachable).toBe(1);
    expect(res.body.marketable_contacts).toBe(2);
    expect(res.body.recipients_not_converted).toBe(1);
  });

  it("membership responds to order and consent changes (dynamic re-evaluation)", async () => {
    const create = await request(app)
      .post("/api/audiences")
      .send({
        name: "Email reachable",
        kind: "dynamic",
        status: "active",
        rules: {
          schemaVersion: 1,
          include: { logic: "ALL", conditions: [{ field: "email_reachable", operator: "is_true" }] },
        },
      });
    const id = create.body.audience.id as string;

    const refresh1 = await request(app).post(`/api/audiences/${id}/refresh`);
    expect(refresh1.status).toBe(200);
    expect(refresh1.body.audience.cached_counts.matched).toBe(1);
    expect(refresh1.body.audience.evaluation_status).toBe("ok");
    expect(refresh1.body.audience.last_evaluated_at).toBeTruthy();

    // consent change adds a member on the next evaluation
    const newbie = await makeContact({ name: "Newbie", email: "new@example.com" });
    await pool.query(
      `UPDATE contacts SET email_consent = true WHERE id = $1`,
      [newbie],
    );
    const refresh2 = await request(app).post(`/api/audiences/${id}/refresh`);
    expect(refresh2.body.audience.cached_counts.matched).toBe(2);

    // an order changes purchasing-based membership too
    const orders = await request(app)
      .post("/api/audiences/preview")
      .send({
        rules: {
          schemaVersion: 1,
          include: { logic: "ALL", conditions: [{ field: "orders_count", operator: "gte", value: 1 }] },
        },
      });
    const before = orders.body.metrics.matched;
    await seedOrder([{ contactId: newbie, role: "customer" }]);
    const after = await request(app)
      .post("/api/audiences/preview")
      .send({
        rules: {
          schemaVersion: 1,
          include: { logic: "ALL", conditions: [{ field: "orders_count", operator: "gte", value: 1 }] },
        },
      });
    expect(after.body.metrics.matched).toBe(before + 1);
  });

  it("refresh persists an error state recoverably on bad rules", async () => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO audiences (workspace_owner_id, name, kind, status, rules)
       VALUES ($1, 'Broken', 'dynamic', 'active', '{"schemaVersion":1,"include":{"logic":"ALL","conditions":[{"field":"bogus","operator":"eq","value":1}]}}'::jsonb)
       RETURNING id`,
      [OWNER_ID],
    );
    const ok = await refreshAudience(OWNER_ID, r.rows[0].id);
    expect(ok).toBe(false);
    const row = await pool.query(
      `SELECT evaluation_status, evaluation_error FROM audiences WHERE id = $1`,
      [r.rows[0].id],
    );
    expect(row.rows[0].evaluation_status).toBe("error");
    expect(row.rows[0].evaluation_error).toContain("bogus");
  });

  it("static audiences: explicit membership, snapshot, and no automatic change", async () => {
    const c1 = await makeContact({ name: "Static A", email: "sa@example.com" });
    const c2 = await makeContact({ name: "Static B", email: "sb@example.com" });
    const foreign = await makeContact({ owner: OTHER_OWNER_ID, name: "Foreign" });

    const create = await request(app)
      .post("/api/audiences")
      .send({ name: "Hand-picked", kind: "static" });
    expect(create.status).toBe(201);
    const id = create.body.audience.id as string;

    // add members — foreign contact silently skipped (workspace scoping)
    const add = await request(app)
      .post(`/api/audiences/${id}/members`)
      .send({ contact_ids: [c1, c2, foreign] });
    expect(add.status).toBe(200);
    expect(add.body.added).toBe(2);

    // idempotent re-add
    const readd = await request(app)
      .post(`/api/audiences/${id}/members`)
      .send({ contact_ids: [c1] });
    expect(readd.body.added).toBe(0);

    const contacts = await request(app).get(`/api/audiences/${id}/contacts`);
    expect(contacts.body.total).toBe(2);

    // membership does NOT change when contact data changes
    await pool.query(`UPDATE contacts SET email_consent = true WHERE id = $1`, [c1]);
    await seedOrder([{ contactId: c2, role: "customer" }]);
    const still = await request(app).get(`/api/audiences/${id}/contacts`);
    expect(still.body.total).toBe(2);

    const remove = await request(app)
      .delete(`/api/audiences/${id}/members`)
      .send({ contact_ids: [c2] });
    expect(remove.body.removed).toBe(1);

    // members on a dynamic audience is a 400
    const dyn = await request(app)
      .post("/api/audiences")
      .send({ name: "Dyn", kind: "dynamic", rules: RULES_ALL_CONTACTS });
    const bad = await request(app)
      .post(`/api/audiences/${dyn.body.audience.id}/members`)
      .send({ contact_ids: [c1] });
    expect(bad.status).toBe(400);

    // snapshot from a dynamic audience's rules
    const snapTarget = await request(app)
      .post("/api/audiences")
      .send({ name: "Snapshot", kind: "static" });
    const snap = await request(app)
      .post(`/api/audiences/${snapTarget.body.audience.id}/snapshot`)
      .send({ from_audience_id: dyn.body.audience.id });
    expect(snap.status).toBe(200);
    expect(snap.body.added).toBeGreaterThan(0);
    const snapRows = await pool.query(
      `SELECT DISTINCT source FROM audience_members WHERE audience_id = $1`,
      [snapTarget.body.audience.id],
    );
    expect(snapRows.rows.map((r) => r.source)).toEqual(["snapshot"]);
  });

  it("templates never match non-consented, malformed-channel, or suppressed contacts", async () => {
    const before = await request(app).get("/api/audiences/templates");
    const matchedBefore = before.body.templates[0].metrics.matched;

    // gift recipients who are NOT reachable: no consent / malformed phone / suppressed
    const noConsent = await makeContact({ name: "NoConsent", phone: "+96170000010" });
    const malformed = await makeContact({
      name: "Malformed",
      phone: "123", // too short to be WhatsApp-capable
      whatsappConsent: true,
    });
    const badEmail = await makeContact({
      name: "BadEmail",
      email: "not-an-email",
      emailConsent: true,
    });
    const suppressedRec = await makeContact({
      name: "SuppressedRec",
      phone: "+96170000011",
      whatsappConsent: true,
      unsubscribed: true,
    });
    const buyer = await makeContact({ name: "Buyer2", email: "b2@example.com" });
    for (const rec of [noConsent, malformed, badEmail, suppressedRec]) {
      await seedOrder([
        { contactId: buyer, role: "customer" },
        { contactId: rec, role: "recipient" },
      ]);
    }

    const after = await request(app).get("/api/audiences/templates");
    // none of the four unreachable recipients qualify for "recipients who never purchased"
    expect(after.body.templates[0].metrics.matched).toBe(matchedBefore);
    // every template requires a reachable channel and excludes suppression
    for (const t of after.body.templates) {
      const anyGroup = t.rules.include.groups[0];
      expect(anyGroup.logic).toBe("ANY");
      expect(anyGroup.conditions.map((c: { field: string }) => c.field).sort()).toEqual([
        "email_reachable",
        "whatsapp_reachable",
      ]);
      expect(t.rules.exclude.conditions[0].field).toBe("is_suppressed");
    }
  });

  it("inferred repeat date requires gifts to the SAME recipient across years; self/unrelated orders never qualify", async () => {
    const gifter = await makeContact({ name: "Gifter", email: "g@example.com", emailConsent: true });
    const mom = await makeContact({ name: "Mom", phone: "+96170000020" });
    const friend = await makeContact({ name: "Friend", phone: "+96170000021" });
    const selfBuyer = await makeContact({ name: "SelfBuyer", email: "self@example.com" });
    const scatter = await makeContact({ name: "Scatter", email: "sc@example.com" });

    const now = new Date();
    const iso = (yearsAgo: number, dayOffset: number) => {
      const d = new Date(now);
      d.setFullYear(d.getFullYear() - yearsAgo);
      d.setDate(d.getDate() + dayOffset);
      return d.toISOString();
    };

    // gifter → mom, same calendar window, two different years → qualifies
    await seedOrder(
      [
        { contactId: gifter, role: "customer" },
        { contactId: mom, role: "recipient" },
      ],
      { orderedAt: iso(2, 5) },
    );
    await seedOrder(
      [
        { contactId: gifter, role: "customer" },
        { contactId: mom, role: "recipient" },
      ],
      { orderedAt: iso(1, 7) },
    );
    // scatter → gifts to DIFFERENT recipients near same date → must NOT qualify
    await seedOrder(
      [
        { contactId: scatter, role: "customer" },
        { contactId: mom, role: "recipient" },
      ],
      { orderedAt: iso(2, 5) },
    );
    await seedOrder(
      [
        { contactId: scatter, role: "customer" },
        { contactId: friend, role: "recipient" },
      ],
      { orderedAt: iso(1, 5) },
    );
    // selfBuyer → self orders in both years → must NOT qualify
    await seedOrder(
      [
        { contactId: selfBuyer, role: "customer" },
        { contactId: selfBuyer, role: "recipient" },
      ],
      { orderedAt: iso(2, 5) },
    );
    await seedOrder(
      [
        { contactId: selfBuyer, role: "customer" },
        { contactId: selfBuyer, role: "recipient" },
      ],
      { orderedAt: iso(1, 5) },
    );

    const res = await request(app)
      .post("/api/audiences/preview/contacts")
      .send({
        rules: {
          schemaVersion: 1,
          include: {
            logic: "ALL",
            conditions: [{ field: "has_inferred_repeat_date", operator: "is_true" }],
          },
        },
      });
    expect(res.body.total).toBe(1);
    expect(res.body.contacts[0].id).toBe(gifter);
  });

  it("occasion_upcoming_days ignores unrelated/self orders — mixed history false-positive guard", async () => {
    // A contact with: (a) an old same-recipient gift pair that qualifies for
    // has_inferred_repeat_date but whose next occurrence is ~6 months away,
    // AND (b) an unrelated self-order placed near today.
    // The contact must NOT match "occasion within next 10 days" because the
    // self-order's upcoming date must not contribute.
    const mixed = await makeContact({ name: "Mixed", email: "mx@example.com" });
    const recip = await makeContact({ name: "RecipMixed", phone: "+96170000030" });

    const now = new Date();
    const isoOffset = (months: number, daysExtra: number) => {
      const d = new Date(now);
      d.setMonth(d.getMonth() + months);
      d.setDate(d.getDate() + daysExtra);
      return d.toISOString();
    };

    // Gift pair ~6 months ago (year 1) and ~18 months ago (year 2): same DOY window,
    // same recipient → has_inferred_repeat_date = true, but next occurrence ~6 months away.
    await seedOrder(
      [{ contactId: mixed, role: "customer" }, { contactId: recip, role: "recipient" }],
      { orderedAt: isoOffset(-6, 0) },
    );
    // approx same DOY, different year
    await seedOrder(
      [{ contactId: mixed, role: "customer" }, { contactId: recip, role: "recipient" }],
      { orderedAt: isoOffset(-18, 3) },
    );

    // Unrelated self-order placed 3 days ago — near today, different recipient context.
    const threeDaysAgo = new Date(now);
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
    await seedOrder(
      [{ contactId: mixed, role: "customer" }, { contactId: mixed, role: "recipient" }],
      { orderedAt: threeDaysAgo.toISOString() },
    );

    // Must have inferred repeat date (gift pair qualifies)
    const flagRes = await request(app).post("/api/audiences/preview/contacts").send({
      rules: {
        schemaVersion: 1,
        include: {
          logic: "ALL",
          conditions: [
            { field: "has_inferred_repeat_date", operator: "is_true" },
            { field: "contact_type", operator: "eq", value: "both" },
          ],
        },
      },
    });
    const inResult = flagRes.body.contacts.some((c: { id: string }) => c.id === mixed);
    expect(inResult).toBe(true);

    // Must NOT match "occasion within next 10 days" — only the self-order is near today
    // and it must never contribute to occasion_upcoming_days.
    const windowRes = await request(app).post("/api/audiences/preview/contacts").send({
      rules: {
        schemaVersion: 1,
        include: {
          logic: "ALL",
          conditions: [
            { field: "has_inferred_repeat_date", operator: "is_true" },
            { field: "occasion_upcoming_days", operator: "within_next_days", value: 10 },
          ],
        },
      },
    });
    const inWindow = windowRes.body.contacts.some((c: { id: string }) => c.id === mixed);
    expect(inWindow).toBe(false);
  });
});
