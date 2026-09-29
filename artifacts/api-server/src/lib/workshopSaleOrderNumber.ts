import { db } from "./db.js";

/**
 * Derive a short, deterministic LOCATION_CODE for use in workshop-sale order
 * numbers. The `locations` table has no dedicated `code` column, so we derive
 * one from the location name: uppercase, strip non-alphanumerics, take the
 * first three characters. Falls back to "LOC" when no usable name is present.
 */
export function deriveLocationCode(name: string | null | undefined): string {
  const cleaned = (name ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 3);
  return cleaned.length > 0 ? cleaned : "LOC";
}

/**
 * Generate the next workshop-sale order number for a workspace + location +
 * year, in the form `WS-{LOCATION_CODE}-{YEAR}-{SEQUENCE}` (sequence is a
 * zero-padded, 4-digit, monotonically-increasing counter).
 *
 * Race-safety: the sequence is allocated atomically via an
 * `INSERT … ON CONFLICT DO UPDATE … RETURNING seq` against
 * `workshop_sale_counters`, keyed by (workspace_owner_id, location_code, year).
 * Concurrent callers each receive a distinct sequence value. Because the
 * counter is keyed by the derived location code (not the location id), two
 * locations that happen to share a derived code share a sequence and therefore
 * never collide on the final order number.
 */
export async function generateWorkshopSaleOrderNumber(opts: {
  workspaceOwnerId: string;
  locationName: string | null | undefined;
  year?: number;
}): Promise<string> {
  const year = opts.year ?? new Date().getUTCFullYear();
  const locationCode = deriveLocationCode(opts.locationName);

  const { rows } = await db.query<{ seq: number }>(
    `
    INSERT INTO workshop_sale_counters (workspace_owner_id, location_code, year, seq)
    VALUES ($1, $2, $3, 1)
    ON CONFLICT (workspace_owner_id, location_code, year)
    DO UPDATE SET seq = workshop_sale_counters.seq + 1
    RETURNING seq
    `,
    [opts.workspaceOwnerId, locationCode, year],
  );

  const seq = rows[0]?.seq ?? 1;
  const padded = String(seq).padStart(4, "0");
  return `WS-${locationCode}-${year}-${padded}`;
}
