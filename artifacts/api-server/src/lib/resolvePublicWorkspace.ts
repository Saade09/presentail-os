import type { Request } from "express";
import { db } from "./db";
import { resolveApiKeyWorkspace } from "./apiKeyAuth";

/**
 * Result of resolving a public workspace from a request.
 *
 * - `{ ownerId }` — successfully resolved
 * - `{ error: "missing_workspace" }` — no workspace param and no API key (→ 400)
 * - `{ error: "workspace_not_found" }` — slug present but not found in DB (→ 404)
 */
export type PublicWorkspaceResult =
  | { ownerId: string }
  | { error: "missing_workspace" }
  | { error: "workspace_not_found" };

/**
 * Resolves the workspace owner ID for public (unauthenticated) catalog endpoints.
 *
 * Resolution order (highest priority first):
 *   1. `x-api-key` header / `?apiKey=` / `Authorization: Bearer pk_live_…`
 *   2. `?workspace=user_<clerkId>` — direct Clerk user ID
 *   3. `?workspace=<slug>` — slug lookup in workspace_settings
 *
 * Returns a discriminated `PublicWorkspaceResult` object.
 */
export async function resolvePublicWorkspace(req: Request): Promise<PublicWorkspaceResult> {
  const apiKeyOwner = await resolveApiKeyWorkspace(req);
  if (apiKeyOwner) return { ownerId: apiKeyOwner };

  const raw = req.query.workspace;
  if (typeof raw !== "string" || !raw.trim()) {
    return { error: "missing_workspace" };
  }
  const param = raw.trim();

  if (param.startsWith("user_")) return { ownerId: param };

  const slugResult = await db.query<{ workspace_owner_id: string }>(
    `SELECT workspace_owner_id FROM workspace_settings WHERE workspace_slug = $1 LIMIT 1`,
    [param],
  );
  if (!slugResult.rows[0]) {
    return { error: "workspace_not_found" };
  }
  return { ownerId: slugResult.rows[0].workspace_owner_id };
}

/**
 * Resolves a delivery city ID from `?city_slug=` or `?city_id=` query params,
 * scoped to the given workspace owner. Returns `null` if neither param is present.
 * Returns an error object `{ error, status }` if the slug/id is invalid.
 */
export async function resolveCityFilter(
  req: Request,
  workspaceOwnerId: string,
): Promise<
  { cityId: number | null; countryCode: string | null } | { error: string; status: number }
> {
  // A country can be requested directly (independent of any city) via a
  // `country` / `country_code` query param; when a city is resolved its own
  // country_code takes precedence so country and city filters stay consistent.
  const countryParam =
    typeof req.query.country === "string" && req.query.country.trim()
      ? req.query.country.trim().toUpperCase()
      : typeof req.query.country_code === "string" && req.query.country_code.trim()
        ? req.query.country_code.trim().toUpperCase()
        : null;

  const citySlug =
    typeof req.query.city_slug === "string" && req.query.city_slug.trim()
      ? req.query.city_slug.trim()
      : null;

  if (citySlug !== null) {
    const row = await db.query<{ id: number; country_code: string | null }>(
      `SELECT id, country_code FROM delivery_cities
        WHERE workspace_owner_id = $1 AND slug = $2 AND is_active = true
        LIMIT 1`,
      [workspaceOwnerId, citySlug],
    );
    if (!row.rows[0]) {
      return { error: `No active delivery city found with slug '${citySlug}'`, status: 404 };
    }
    const cc = row.rows[0].country_code;
    return { cityId: row.rows[0].id, countryCode: cc ? cc.toUpperCase() : countryParam };
  }

  const cityIdRaw = typeof req.query.city_id === "string" ? parseInt(req.query.city_id, 10) : null;
  if (cityIdRaw !== null && Number.isFinite(cityIdRaw) && cityIdRaw > 0) {
    const row = await db.query<{ country_code: string | null }>(
      `SELECT country_code FROM delivery_cities
        WHERE workspace_owner_id = $1 AND id = $2
        LIMIT 1`,
      [workspaceOwnerId, cityIdRaw],
    );
    const cc = row.rows[0]?.country_code;
    return { cityId: cityIdRaw, countryCode: cc ? cc.toUpperCase() : countryParam };
  }

  return { cityId: null, countryCode: countryParam };
}
