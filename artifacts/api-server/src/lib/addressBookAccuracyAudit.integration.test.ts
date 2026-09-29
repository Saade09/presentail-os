/**
 * PostgreSQL coverage for the dry-run boundary. The audit must be able to
 * inspect a real historical ai_verified row while leaving every persisted
 * checkout/verification field untouched.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const OWNER = `__address_accuracy_audit_sql_${Date.now()}`;

const mockAssessPlaceValidity = vi.fn();
const mockGeocodeAddress = vi.fn();

vi.mock("./placeAiAssessor.js", () => ({
  assessPlaceValidity: (...args: unknown[]) => mockAssessPlaceValidity(...args),
  geocodeAddress: (...args: unknown[]) => mockGeocodeAddress(...args),
}));

import { auditExistingAiVerifiedPlaces } from "./addressBookAccuracyAudit.js";

describe.skipIf(!DATABASE_URL)("address accuracy audit SQL (integration)", () => {
  let pool: InstanceType<typeof Pool>;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
    mockAssessPlaceValidity.mockResolvedValue({ valid: true, reason: "Address" });
    mockGeocodeAddress.mockResolvedValue({
      lat: 33.8938,
      lng: 35.5018,
      matchedLocation: "Hamra, Beirut, Lebanon",
      precision: "locality",
      provider: "nominatim",
      query: "Hamra, Beirut, LB",
      candidateEvidence: [{ precision: "locality" }],
    });
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM places WHERE workspace_owner_id = $1`, [OWNER]);
    await pool.end();
  });

  it("performs a zero-mutation dry run on a checkout-ready historical pin", async () => {
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
       VALUES ($1, 'Historical Hamra Pin', 'Hamra, Beirut', 'ai_verified',
               33.8938, 35.5018, 'ai', true)
       RETURNING id`,
      [OWNER],
    );

    const before = await pool.query(
      `SELECT verification_state, latitude, longitude, coordinate_source,
              checkout_ready, verified_at
         FROM places
        WHERE id = $1`,
      [inserted.rows[0].id],
    );
    const eventCountBefore = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM place_verification_events WHERE place_id = $1`,
      [inserted.rows[0].id],
    );

    const report = await auditExistingAiVerifiedPlaces({ workspaceId: OWNER });

    expect(report.dry_run).toBe(true);
    expect(report.metrics).toMatchObject({
      existing_ai_verified_reviewed: 1,
      insufficient_precision: 1,
      requires_owner_review: 1,
    });

    const after = await pool.query(
      `SELECT verification_state, latitude, longitude, coordinate_source,
              checkout_ready, verified_at
         FROM places
        WHERE id = $1`,
      [inserted.rows[0].id],
    );
    const eventCountAfter = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM place_verification_events WHERE place_id = $1`,
      [inserted.rows[0].id],
    );
    expect(after.rows).toEqual(before.rows);
    expect(eventCountAfter.rows[0]?.count).toBe(eventCountBefore.rows[0]?.count);
  });
});