import { db } from "./db";
import {
  COUNTRY_CATALOGUE,
  DEFAULT_COUNTRIES,
  findCountryByName,
  getDefaultFlagUrl,
  isExcludedCountry,
} from "./defaults";

/**
 * Decorate an already-resolved list of country names with `{code, flagImageUrl}`,
 * applying per-workspace overrides. Use this when the caller has already
 * read `workspace_settings.available_countries` itself, to avoid an extra
 * SELECT round-trip.
 */
export async function decorateCountryNames(
  ownerId: string,
  names: string[],
): Promise<ResolvedCountry[]> {
  const overrides = await loadFlagOverrides(ownerId);
  return names.map((name) => {
    const entry = findCountryByName(name);
    if (!entry) return { name, code: null, flagImageUrl: null };
    return {
      name: entry.name,
      code: entry.code,
      flagImageUrl: overrides.get(entry.code) ?? getDefaultFlagUrl(entry.code),
    };
  });
}

export type ResolvedCountry = {
  name: string;
  /** ISO 3166-1 alpha-2 code (lowercase) — null if the saved name is unknown. */
  code: string | null;
  /** Resolved flag URL: per-workspace override if set, otherwise bundled default. */
  flagImageUrl: string | null;
};

export async function loadFlagOverrides(ownerId: string): Promise<Map<string, string>> {
  const result = await db.query<{ country_code: string; image_url: string }>(
    `SELECT country_code, image_url FROM country_flag_overrides WHERE workspace_owner_id = $1`,
    [ownerId],
  );
  const map = new Map<string, string>();
  for (const r of result.rows) map.set(r.country_code.toLowerCase(), r.image_url);
  return map;
}

/**
 * Read workspace_settings.available_countries (with default fallback) and
 * return an enriched `{name, code, flagImageUrl}` array. Excluded countries
 * are filtered out. Per-workspace `country_flag_overrides` win over the
 * bundled default.
 */
export async function resolveWorkspaceCountries(
  ownerId: string,
): Promise<{ names: string[]; details: ResolvedCountry[] }> {
  const settingsResult = await db.query<{ available_countries: string[] | null }>(
    `SELECT available_countries FROM workspace_settings WHERE workspace_owner_id = $1`,
    [ownerId],
  );
  const raw = settingsResult.rows[0]?.available_countries ?? null;
  const source = raw && raw.length > 0 ? raw : DEFAULT_COUNTRIES;
  const names = source.filter((n) => !isExcludedCountry(n));

  const overrides = await loadFlagOverrides(ownerId);
  const details: ResolvedCountry[] = names.map((name) => {
    const entry = findCountryByName(name);
    if (!entry) return { name, code: null, flagImageUrl: null };
    const override = overrides.get(entry.code);
    return {
      name: entry.name,
      code: entry.code,
      flagImageUrl: override ?? getDefaultFlagUrl(entry.code),
    };
  });

  return { names, details };
}

/**
 * Resolve every country in the global catalogue with the workspace's
 * overrides applied. Used by the Settings UI checklist so we can render a
 * thumbnail next to every selectable country (not just enabled ones).
 */
export async function resolveCatalogueWithOverrides(
  ownerId: string,
): Promise<ResolvedCountry[]> {
  const overrides = await loadFlagOverrides(ownerId);
  return COUNTRY_CATALOGUE.map((c) => ({
    name: c.name,
    code: c.code,
    flagImageUrl: overrides.get(c.code) ?? getDefaultFlagUrl(c.code),
  }));
}
