import { db } from "./db";
import { findCountryByCode, findCountryByName } from "./defaults";

export interface TrustedPlaceGeography {
  city: string | null;
  country: string | null;
  conflict: boolean;
}

export function normalizeTrustedCountry(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  const alias =
    normalized.toUpperCase() === "LBN" ? "LB" :
    normalized.toUpperCase() === "UAE" ? "AE" :
    normalized;
  const country = findCountryByCode(alias) ?? findCountryByName(alias);
  return country?.code.toUpperCase() ?? null;
}

/**
 * Resolve only durable geography: owner/ingest provenance, a linked delivery
 * city, and countries recorded on linked order address snapshots. Conflicting
 * evidence is intentionally unresolved rather than guessed.
 */
export async function resolveTrustedPlaceGeography(
  placeId: string,
  workspaceOwnerId: string,
): Promise<TrustedPlaceGeography | null> {
  const result = await db.query<{
    city_name: string | null;
    stored_country: string | null;
    stored_country_source: string | null;
    city_country: string | null;
    linked_countries: string[] | null;
  }>(
    `SELECT p.trusted_country_code AS stored_country,
             p.trusted_country_source AS stored_country_source,
            dc.name AS city_name,
            dc.country_code AS city_country,
            ARRAY(
              SELECT DISTINCT CASE
                WHEN upper(trim(country_value)) IN ('LEBANON', 'LBN') THEN 'LB'
                WHEN upper(trim(country_value)) IN ('UNITED ARAB EMIRATES', 'UAE') THEN 'AE'
                ELSE upper(trim(country_value))
              END
                FROM order_place_links opl
                JOIN orders o ON o.id::text = opl.order_id::text
                CROSS JOIN LATERAL (
                  VALUES (
                    COALESCE(
                      o.delivery_address->>'country_code',
                      o.delivery_address->>'country',
                      o.delivery_address->>'countryName'
                    )
                  )
                ) evidence(country_value)
               WHERE opl.place_id = p.id
                 AND opl.workspace_owner_id = p.workspace_owner_id
                 AND country_value IS NOT NULL
                 AND trim(country_value) <> ''
               ORDER BY 1
            )::text[] AS linked_countries
       FROM places p
       LEFT JOIN delivery_cities dc ON dc.id = p.city_id
      WHERE p.id = $1 AND p.workspace_owner_id = $2 AND p.archived_at IS NULL`,
    [placeId, workspaceOwnerId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const trustedStoredSources = new Set(["owner", "delivery_city", "order_ingest", "linked_delivery"]);
  const storedCountry = trustedStoredSources.has(row.stored_country_source ?? "")
    ? normalizeTrustedCountry(row.stored_country)
    : null;
  const countries = new Set(
    [storedCountry, row.city_country, ...(row.linked_countries ?? [])]
      .map(normalizeTrustedCountry)
      .filter((value): value is string => Boolean(value)),
  );
  return {
    city: countries.size > 1 ? null : row.city_name,
    country: countries.size === 1 ? [...countries][0] : null,
    conflict: countries.size > 1,
  };
}