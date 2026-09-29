/**
 * Integration coverage for the Address Book place-detail endpoint's recent
 * delivery order references. Uses a real PostgreSQL database and skips when
 * DATABASE_URL is not configured.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import pg from "pg";
import type { WorkspaceRequest } from "../lib/workspace";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const OWNER_ID = `__address_book_order_number_${Date.now()}`;
const OTHER_OWNER_ID = `${OWNER_ID}_other`;

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
    wreq.userId = "address-book-integration-owner";
    wreq.userEmail = "address-book-integration-owner@example.com";
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
  hasPageAccess: () => true,
}));

vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

import addressBookRouter from "./addressBook";

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api", addressBookRouter);
  return app;
}

async function cleanup(pool: InstanceType<typeof Pool>): Promise<void> {
  for (const owner of [OWNER_ID, OTHER_OWNER_ID]) {
    await pool.query(`DELETE FROM order_place_links WHERE workspace_owner_id = $1`, [owner]);
    await pool.query(
      `DELETE FROM contact_addresses WHERE workspace_owner_id = $1`,
      [owner],
    );
    await pool.query(
      `DELETE FROM place_aliases
        WHERE place_id IN (
          SELECT id FROM places WHERE workspace_owner_id = $1
        )`,
      [owner],
    );
    await pool.query(`DELETE FROM places WHERE workspace_owner_id = $1`, [owner]);
    await pool.query(`DELETE FROM orders WHERE workspace_owner_id = $1`, [owner]);
    await pool.query(`DELETE FROM contacts WHERE workspace_owner_id = $1`, [
      owner,
    ]);
  }
}

describe.skipIf(!DATABASE_URL)("Address Book place detail (integration)", () => {
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

  it("returns display number, then external ID, then the full order ID", async () => {
    const placeRes = await pool.query<{ id: string }>(
      `INSERT INTO places (workspace_owner_id, canonical_name)
       VALUES ($1, $2)
       RETURNING id`,
      [OWNER_ID, `Recent deliveries ${Date.now()}`],
    );
    const placeId = placeRes.rows[0].id;

    async function seedDelivery(opts: {
      externalOrderId: string | null;
      displayOrderNumber: string | null;
      linkedAt: string;
    }): Promise<string> {
      const orderRes = await pool.query<{ id: string }>(
        `INSERT INTO orders
           (workspace_owner_id, source, external_order_id, display_order_number, status, ordered_at)
         VALUES ($1, 'integration-test', $2, $3, 'pending', now())
         RETURNING id`,
        [OWNER_ID, opts.externalOrderId, opts.displayOrderNumber],
      );
      const orderId = orderRes.rows[0].id;
      await pool.query(
        `INSERT INTO order_place_links (workspace_owner_id, order_id, place_id, linked_at)
         VALUES ($1, $2, $3, $4)`,
        [OWNER_ID, orderId, placeId, opts.linkedAt],
      );
      return orderId;
    }

    const displayOrderId = await seedDelivery({
      externalOrderId: "external-display-case",
      displayOrderNumber: "M-1001",
      linkedAt: "2020-01-03T00:00:00Z",
    });
    const externalOrderId = await seedDelivery({
      externalOrderId: "channel-1002",
      displayOrderNumber: null,
      linkedAt: "2020-01-02T00:00:00Z",
    });
    const uuidFallbackOrderId = await seedDelivery({
      externalOrderId: null,
      displayOrderNumber: null,
      linkedAt: "2020-01-01T00:00:00Z",
    });

    const response = await request(app).get(`/api/address-book/places/${placeId}`);

    expect(response.status).toBe(200);
    expect(response.body.recent_deliveries).toEqual([
      expect.objectContaining({
        order_id: displayOrderId,
        display_order_number: "M-1001",
      }),
      expect.objectContaining({
        order_id: externalOrderId,
        display_order_number: "channel-1002",
      }),
      expect.objectContaining({
        order_id: uuidFallbackOrderId,
        display_order_number: uuidFallbackOrderId,
      }),
    ]);
    expect(response.body.recent_deliveries).toHaveLength(3);
    expect(response.body.recent_deliveries[0]).toHaveProperty("linked_at");
    expect(response.body.recent_deliveries[0]).toHaveProperty("ordered_at");
  });

  it("does not include a link or order from another workspace", async () => {
    const placeRes = await pool.query<{ id: string }>(
      `INSERT INTO places (workspace_owner_id, canonical_name)
       VALUES ($1, $2)
       RETURNING id`,
      [OWNER_ID, `Workspace scoped place ${Date.now()}`],
    );
    const placeId = placeRes.rows[0].id;
    const orderRes = await pool.query<{ id: string }>(
      `INSERT INTO orders
         (workspace_owner_id, source, external_order_id, status, ordered_at)
       VALUES ($1, 'integration-test', 'other-workspace-order', 'pending', now())
       RETURNING id`,
      [OTHER_OWNER_ID],
    );
    await pool.query(
      `INSERT INTO order_place_links (workspace_owner_id, order_id, place_id)
       VALUES ($1, $2, $3)`,
      [OTHER_OWNER_ID, orderRes.rows[0].id, placeId],
    );

    const response = await request(app).get(`/api/address-book/places/${placeId}`);

    expect(response.status).toBe(200);
    expect(response.body.recent_deliveries).toEqual([]);
  });

  it("filters active places by q and search across supported fields", async () => {
    const suffix = Date.now();
    const canonicalMarker = `Canonical Search ${suffix}`;
    const aliasMarker = `Alias Search ${suffix}`;
    const areaMarker = `Area Search ${suffix}`;
    const contactName = `Contact Search ${suffix}`;
    const phoneMarker = `+971500${String(suffix).slice(-6)}`;

    const placeResult = await pool.query<{ id: string }>(
      `INSERT INTO places (workspace_owner_id, canonical_name, area)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [OWNER_ID, canonicalMarker, areaMarker],
    );
    const placeId = placeResult.rows[0].id;

    await pool.query(
      `INSERT INTO place_aliases (place_id, alias_text, normalized_alias)
       VALUES ($1, $2, $3)`,
      [placeId, aliasMarker, aliasMarker.toLowerCase()],
    );

    const contactResult = await pool.query<{ id: string }>(
      `INSERT INTO contacts (workspace_owner_id, display_name, phone)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [OWNER_ID, contactName, phoneMarker],
    );
    await pool.query(
      `INSERT INTO contact_addresses (workspace_owner_id, contact_id, place_id)
       VALUES ($1, $2, $3)`,
      [OWNER_ID, contactResult.rows[0].id, placeId],
    );

    const archivedMarker = `Archived Search ${suffix}`;
    await pool.query(
      `INSERT INTO places (workspace_owner_id, canonical_name, archived_at)
       VALUES ($1, $2, now())`,
      [OWNER_ID, archivedMarker],
    );
    await pool.query(
      `INSERT INTO places (workspace_owner_id, canonical_name)
       VALUES ($1, $2)`,
      [OTHER_OWNER_ID, `Other Workspace ${canonicalMarker}`],
    );

    async function search(query: {
      q?: string;
      search?: string;
    }): Promise<string[]> {
      const response = await request(app)
        .get("/api/address-book/places")
        .query(query);
      expect(response.status).toBe(200);
      return response.body.places.map(
        (place: { canonical_name: string }) => place.canonical_name,
      );
    }

    expect(await search({ q: canonicalMarker })).toEqual([canonicalMarker]);
    expect(await search({ search: aliasMarker })).toEqual([canonicalMarker]);
    expect(await search({ q: areaMarker })).toEqual([canonicalMarker]);
    expect(await search({ q: contactName })).toEqual([canonicalMarker]);
    expect(await search({ q: phoneMarker })).toEqual([canonicalMarker]);
    expect(await search({ q: archivedMarker })).toEqual([]);
  });

  it("checkout gate: blocks order-link when place checkout_ready is false", async () => {
    // Create a place (checkout_ready defaults to false)
    const placeRes = await pool.query<{ id: string }>(
      `INSERT INTO places (workspace_owner_id, canonical_name)
       VALUES ($1, $2)
       RETURNING id`,
      [OWNER_ID, `Checkout Gate Test ${Date.now()}`],
    );
    const placeId = placeRes.rows[0].id;

    const orderRes = await pool.query<{ id: string }>(
      `INSERT INTO orders (workspace_owner_id, source, external_order_id, status, ordered_at)
       VALUES ($1, 'integration-test', $2, 'pending', now())
       RETURNING id`,
      [OWNER_ID, `checkout-gate-order-${Date.now()}`],
    );
    const orderId = orderRes.rows[0].id;

    // Attempt to link the order — should be blocked (422)
    const linkRes = await request(app)
      .put(`/api/order-links/${orderId}`)
      .send({ place_id: placeId });

    expect(linkRes.status).toBe(422);
    expect(linkRes.body.error).toMatch(/not activated for checkout/i);

    // Activate checkout: requires staff_verified + no conflict + coordinates.
    // Set up the place so activation succeeds.
    await pool.query(
      `UPDATE places
          SET verification_state = 'staff_verified',
              latitude            = 25.123,
              longitude           = 55.456,
              location_conflict   = false
        WHERE id = $1`,
      [placeId],
    );

    const activateRes = await request(app)
      .post(`/api/address-book/places/${placeId}/activate-checkout`)
      .send({});

    expect(activateRes.status).toBe(200);
    expect(activateRes.body.success).toBe(true);

    // Now the order-link should succeed
    const linkRes2 = await request(app)
      .put(`/api/order-links/${orderId}`)
      .send({ place_id: placeId });

    expect(linkRes2.status).toBe(200);
    expect(linkRes2.body.success).toBe(true);
  });

  it("checkout gate: tenant isolation — cannot link to another workspace's place", async () => {
    const placeRes = await pool.query<{ id: string }>(
      `INSERT INTO places (workspace_owner_id, canonical_name, verification_state, latitude, longitude)
       VALUES ($1, $2, 'staff_verified', 25.1, 55.1)
       RETURNING id`,
      [OTHER_OWNER_ID, `Other Workspace Checkout Place ${Date.now()}`],
    );
    const otherPlaceId = placeRes.rows[0].id;

    const orderRes = await pool.query<{ id: string }>(
      `INSERT INTO orders (workspace_owner_id, source, external_order_id, status, ordered_at)
       VALUES ($1, 'integration-test', $2, 'pending', now())
       RETURNING id`,
      [OWNER_ID, `cross-workspace-order-${Date.now()}`],
    );
    const orderId = orderRes.rows[0].id;

    // Attempt to link OWNER's order to OTHER_OWNER's place — should 404 (place not visible)
    const res = await request(app)
      .put(`/api/order-links/${orderId}`)
      .send({ place_id: otherPlaceId });

    expect(res.status).toBe(404);
  });

  it("activate-checkout: returns 422 with blocking_reasons when conditions not met", async () => {
    const placeRes = await pool.query<{ id: string }>(
      `INSERT INTO places (workspace_owner_id, canonical_name)
       VALUES ($1, $2)
       RETURNING id`,
      [OWNER_ID, `Activate Blocking Test ${Date.now()}`],
    );
    const placeId = placeRes.rows[0].id;

    const res = await request(app)
      .post(`/api/address-book/places/${placeId}/activate-checkout`)
      .send({});

    expect(res.status).toBe(422);
    expect(res.body.blocking_reasons).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/verification_state/),
        expect.stringMatching(/coordinates/),
      ]),
    );
  });

  it("bulk activate-checkout is workspace-scoped, safety-filtered, audited, and idempotent", async () => {
    await cleanup(pool);

    async function seedPlace(input: {
      owner?: string;
      name: string;
      verificationState: "unverified" | "estimated" | "ai_verified" | "staff_verified" | "delivery_verified";
      latitude?: number | null;
      longitude?: number | null;
      locationConflict?: boolean;
      checkoutReady?: boolean;
      archived?: boolean;
    }): Promise<string> {
      const result = await pool.query<{ id: string }>(
        `INSERT INTO places
           (workspace_owner_id, canonical_name, verification_state, latitude, longitude,
            location_conflict, checkout_ready, archived_at)
         VALUES ($1, $2, $3::place_verification_state, $4, $5, $6, $7,
                 CASE WHEN $8 THEN now() ELSE NULL END)
         RETURNING id`,
        [
          input.owner ?? OWNER_ID,
          input.name,
          input.verificationState,
          input.latitude ?? null,
          input.longitude ?? null,
          input.locationConflict ?? false,
          input.checkoutReady ?? false,
          input.archived ?? false,
        ],
      );
      return result.rows[0].id;
    }

    const suffix = Date.now();
    const eligibleId = await seedPlace({
      name: `Bulk eligible ${suffix}`,
      verificationState: "ai_verified",
      latitude: 25.1,
      longitude: 55.1,
    });
    const alreadyActiveId = await seedPlace({
      name: `Bulk already active ${suffix}`,
      verificationState: "staff_verified",
      latitude: 25.2,
      longitude: 55.2,
      checkoutReady: true,
    });
    await seedPlace({
      name: `Bulk unverified ${suffix}`,
      verificationState: "unverified",
      latitude: 25.3,
      longitude: 55.3,
    });
    await seedPlace({
      name: `Bulk missing coordinates ${suffix}`,
      verificationState: "delivery_verified",
    });
    await seedPlace({
      name: `Bulk conflict ${suffix}`,
      verificationState: "staff_verified",
      latitude: 25.4,
      longitude: 55.4,
      locationConflict: true,
    });
    const archivedId = await seedPlace({
      name: `Bulk archived ${suffix}`,
      verificationState: "staff_verified",
      latitude: 25.5,
      longitude: 55.5,
      archived: true,
    });
    const otherWorkspaceId = await seedPlace({
      owner: OTHER_OWNER_ID,
      name: `Bulk other workspace ${suffix}`,
      verificationState: "delivery_verified",
      latitude: 25.6,
      longitude: 55.6,
    });

    const first = await request(app).post("/api/address-book/places/activate-checkout");

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      success: true,
      activated: 1,
      already_active: 1,
      skipped: 3,
      blockers: {
        verification_state: 1,
        location_conflict: 1,
        coordinates: 1,
      },
    });

    const changed = await pool.query<{
      id: string;
      checkout_ready: boolean;
      verified_at: string | null;
      verified_by: string | null;
    }>(
      `SELECT id, checkout_ready, verified_at, verified_by
         FROM places
        WHERE id = ANY($1::uuid[])`,
      [[eligibleId, alreadyActiveId, archivedId, otherWorkspaceId]],
    );
    const byId = new Map(changed.rows.map((row) => [row.id, row]));
    expect(byId.get(eligibleId)).toMatchObject({
      checkout_ready: true,
      verified_by: "address-book-integration-owner@example.com",
    });
    expect(byId.get(eligibleId)?.verified_at).not.toBeNull();
    expect(byId.get(alreadyActiveId)).toMatchObject({
      checkout_ready: true,
      verified_at: null,
      verified_by: null,
    });
    expect(byId.get(archivedId)?.checkout_ready).toBe(false);
    expect(byId.get(otherWorkspaceId)?.checkout_ready).toBe(false);

    const events = await pool.query<{
      place_id: string;
      actor_user_id: string | null;
      actor_name: string | null;
      source: string | null;
      notes: string | null;
    }>(
      `SELECT place_id, actor_user_id, actor_name, source, notes
         FROM place_verification_events
        WHERE place_id = ANY($1::uuid[]) AND event_type = 'checkout_activated'`,
      [[eligibleId, alreadyActiveId, archivedId, otherWorkspaceId]],
    );
    expect(events.rows).toEqual([{
      place_id: eligibleId,
      actor_user_id: "address-book-integration-owner",
      actor_name: "address-book-integration-owner@example.com",
      source: "manual",
      notes: "Checkout activated by owner",
    }]);

    const second = await request(app).post("/api/address-book/places/activate-checkout");
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({
      activated: 0,
      already_active: 2,
      skipped: 3,
    });

    const repeatedEvents = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM place_verification_events
        WHERE place_id = $1 AND event_type = 'checkout_activated'`,
      [eligibleId],
    );
    expect(repeatedEvents.rows[0].count).toBe("1");
  });

  it("persists coordinate_source on map-pin update and returns new verification schema fields", async () => {
    const placeRes = await pool.query<{ id: string }>(
      `INSERT INTO places (workspace_owner_id, canonical_name)
       VALUES ($1, $2)
       RETURNING id`,
      [OWNER_ID, `Verification schema ${Date.now()}`],
    );
    const placeId = placeRes.rows[0].id;

    // Add an alias so we can verify source/approval_state are returned.
    await pool.query(
      `INSERT INTO place_aliases (place_id, alias_text, normalized_alias, source, approval_state)
       VALUES ($1, 'Test Alias', 'test alias', 'manual', 'approved')`,
      [placeId],
    );

    // Update the map pin — this should also persist coordinate_source on the row.
    const pinRes = await request(app)
      .put(`/api/address-book/places/${placeId}/map-pin`)
      .send({ latitude: 25.123, longitude: 55.456, source: "gps" });
    expect(pinRes.status).toBe(200);

    // Fetch the place detail and assert the new schema fields are present.
    const detailRes = await request(app).get(`/api/address-book/places/${placeId}`);
    expect(detailRes.status).toBe(200);

    const place = detailRes.body.place;
    expect(place.coordinate_source).toBe("gps");
    expect(place.checkout_ready).toBe(false);
    expect(place.location_conflict).toBe(false);
    expect(place).toHaveProperty("verified_at");
    expect(place).toHaveProperty("verified_by");

    // Aliases must include source and approval_state.
    const aliases: { source: string; approval_state: string }[] = detailRes.body.aliases;
    expect(aliases).toHaveLength(1);
    expect(aliases[0].source).toBe("manual");
    expect(aliases[0].approval_state).toBe("approved");
  });
});
