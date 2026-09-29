/**
 * PostgreSQL regression coverage for the unsupported automated-pin clear path.
 * This query previously failed before any queued reverification job could
 * complete because PostgreSQL could not infer the type of the audit-note
 * parameter used by both a text column and jsonb_build_object.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const OWNER = `__address_auto_link_sql_${Date.now()}`;

const mockAssessPlaceValidity = vi.fn();
const mockGeocodeAddress = vi.fn();

vi.mock("./placeAiAssessor.js", () => ({
  assessPlaceValidity: (...args: unknown[]) => mockAssessPlaceValidity(...args),
  geocodeAddress: (...args: unknown[]) => mockGeocodeAddress(...args),
}));

import { assessAndGeocode } from "./addressBookAutoLink";

describe.skipIf(!DATABASE_URL)("address auto-link SQL (integration)", () => {
  let pool: InstanceType<typeof Pool>;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
    mockAssessPlaceValidity.mockResolvedValue({
      valid: true,
      reason: "Plausible address",
    });
    mockGeocodeAddress.mockResolvedValue(null);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM places WHERE workspace_owner_id = $1`, [OWNER]);
    await pool.end();
  });

  it("clears an unsupported automated pin and records its audit reason", async () => {
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO places (
         workspace_owner_id,
         canonical_name,
         canonical_address,
         verification_state,
         latitude,
         longitude,
         coordinate_source,
         checkout_ready
       )
       VALUES ($1, $2, $3, 'ai_verified', 33.8938, 35.5018, 'ai', true)
       RETURNING id`,
      [OWNER, "Unmatched test address", "Near an unknown landmark"],
    );
    const placeId = inserted.rows[0].id;

    await expect(
      assessAndGeocode(
        placeId,
        "Unmatched test address",
        [],
        OWNER,
        { valid: true, reason: "Plausible address" },
        { city: "Beirut", country: "LB" },
      ),
    ).resolves.toMatchObject({
      status: "unresolved",
      coordinatesCleared: true,
      latitude: null,
      longitude: null,
    });

    const place = await pool.query<{
      verification_state: string;
      latitude: string | null;
      longitude: string | null;
      coordinate_source: string | null;
      checkout_ready: boolean;
    }>(
      `SELECT verification_state, latitude, longitude, coordinate_source, checkout_ready
         FROM places
        WHERE id = $1`,
      [placeId],
    );
    expect(place.rows[0]).toEqual({
      verification_state: "unverified",
      latitude: null,
      longitude: null,
      coordinate_source: null,
      checkout_ready: false,
    });

    const event = await pool.query<{ notes: string; correction_reason: string }>(
      `SELECT notes, metadata->>'correction_reason' AS correction_reason
         FROM place_verification_events
        WHERE place_id = $1
          AND event_type = 'map_pin_cleared'
        ORDER BY created_at DESC
        LIMIT 1`,
      [placeId],
    );
    expect(event.rows[0]?.notes).toContain("returned to review");
    expect(event.rows[0]?.correction_reason).toBe(event.rows[0]?.notes);
  });

  it("persists a successful geocode and typed map-pin audit without activating checkout", async () => {
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO places (
         workspace_owner_id,
         canonical_name,
         canonical_address,
         verification_state,
         checkout_ready
       )
       VALUES ($1, $2, $3, 'unverified', false)
       RETURNING id`,
      [OWNER, "Validated test address", "Hamra, Beirut"],
    );
    const placeId = inserted.rows[0].id;
    mockGeocodeAddress.mockResolvedValueOnce({
      lat: 33.8938,
      lng: 35.5018,
      matchType: "exact",
      precision: "exact",
      method: "exact_match",
      provider: "nominatim",
      matchedLocation: "Hamra, Beirut, Lebanon",
      query: "Validated test address, Beirut, LB",
       queriesTried: ["Validated test address, Beirut, LB", "Hamra, Beirut, LB"],
       providerTypes: ["place", "house"],
       confidenceEvidence: {
         candidate_count: 1,
         result_level: "premise",
       },
       candidateEvidence: [{
         candidate_id: "way:address-book-test",
         accepted: true,
         precision: "exact",
         result_level: "premise",
       }],
    });

    await expect(
      assessAndGeocode(
        placeId,
        "Validated test address",
        [],
        OWNER,
        { valid: true, reason: "Plausible address" },
        { city: "Beirut", country: "LB" },
      ),
    ).resolves.toMatchObject({
      status: "exact",
      coordinatesUpdated: true,
      latitude: 33.8938,
      longitude: 35.5018,
    });

    const place = await pool.query<{
      verification_state: string;
      latitude: string | null;
      longitude: string | null;
      coordinate_source: string | null;
      checkout_ready: boolean;
    }>(
      `SELECT verification_state, latitude, longitude, coordinate_source, checkout_ready
         FROM places
        WHERE id = $1`,
      [placeId],
    );
    expect(place.rows[0]).toMatchObject({
      verification_state: "ai_verified",
      coordinate_source: "geocoder",
      checkout_ready: false,
    });
    expect(Number(place.rows[0]?.latitude)).toBeCloseTo(33.8938, 4);
    expect(Number(place.rows[0]?.longitude)).toBeCloseTo(35.5018, 4);

    const event = await pool.query<{
      notes: string;
      correction_reason: string;
      candidates: Array<Record<string, unknown>>;
    }>(
      `SELECT notes,
              metadata->>'correction_reason' AS correction_reason,
              metadata->'confidence_evidence'->'candidates' AS candidates
         FROM place_verification_events
        WHERE place_id = $1 AND event_type = 'map_pin_updated'
        ORDER BY created_at DESC
        LIMIT 1`,
      [placeId],
    );
    expect(event.rows[0]?.notes).toContain("AI verified exact map match");
    expect(event.rows[0]?.correction_reason).toBe(event.rows[0]?.notes);
    expect(event.rows[0]?.candidates).toEqual([
      expect.objectContaining({
        candidate_id: "way:address-book-test",
        accepted: true,
        result_level: "premise",
      }),
    ]);
  });

  it("preserves checkout_ready when repairing a previously active AI pin", async () => {
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO places (
         workspace_owner_id,
         canonical_name,
         canonical_address,
         verification_state,
         latitude,
         longitude,
         coordinate_source,
         checkout_ready
       )
       VALUES ($1, $2, $3, 'ai_verified', 33.9000, 35.5200, 'ai', true)
       RETURNING id`,
      [OWNER, "Active verified test place", "Hamra, Beirut"],
    );
    const placeId = inserted.rows[0].id;
    mockGeocodeAddress.mockResolvedValueOnce({
      lat: 33.8938,
      lng: 35.5018,
      matchType: "exact",
      precision: "exact",
      method: "exact_match",
      provider: "nominatim",
      matchedLocation: "Hamra, Beirut, Lebanon",
      query: "Active verified test place, Beirut, LB",
    });

    await expect(
      assessAndGeocode(
        placeId,
        "Active verified test place",
        [],
        OWNER,
        { valid: true, reason: "Plausible address" },
        { city: "Beirut", country: "LB" },
      ),
    ).resolves.toMatchObject({ status: "exact", coordinatesUpdated: true });

    const result = await pool.query<{
      checkout_ready: boolean;
      latitude: string;
      longitude: string;
    }>(
      `SELECT checkout_ready, latitude, longitude FROM places WHERE id = $1`,
      [placeId],
    );
    expect(result.rows[0]?.checkout_ready).toBe(true);
    expect(Number(result.rows[0]?.latitude)).toBeCloseTo(33.8938, 4);
    expect(Number(result.rows[0]?.longitude)).toBeCloseTo(35.5018, 4);
  });
});