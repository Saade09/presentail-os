import { Router, type Request } from "express";
import { and, asc, eq, notExists, sql } from "drizzle-orm";
import { drizzleDb } from "../lib/drizzle.js";
import { resolveApiKeyWorkspace } from "../lib/apiKeyAuth";
import { buildPublicObjectUrl } from "../lib/objectStorage";
import {
  occasions,
  catalogCategories,
  catalogBrands,
  recipients,
  occasionCityAvailability,
  catalogCategoryCityAvailability,
  catalogBrandCityAvailability,
  recipientCityAvailability,
  type Occasion,
} from "@workspace/db/schema";
import type { PgColumn } from "drizzle-orm/pg-core";

const router = Router();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AnyAttrTable =
  | typeof occasions
  | typeof catalogCategories
  | typeof catalogBrands
  | typeof recipients;

type AnyCityTable =
  | typeof occasionCityAvailability
  | typeof catalogCategoryCityAvailability
  | typeof catalogBrandCityAvailability
  | typeof recipientCityAvailability;

/**
 * Public subset of columns returned for each catalog attribute.
 * Snake_case keys to preserve backward-compatible API response format.
 * Types are derived from the Drizzle Occasion schema (all 4 tables share
 * the same column structure — see lib/db/src/schema/catalogAttributes.ts).
 */
type AttrPublicRow = {
  id: Occasion["id"];
  name: Occasion["name"];
  slug: Occasion["slug"];
  description: Occasion["description"];
  image_url: Occasion["imageUrl"];
  sort_order: Occasion["sortOrder"];
  // Absolute, auth-free public URL of the image (null when no image). Emitted
  // for all catalog attribute types.
  image_public_url: string | null;
  // Absolute, auth-free public URL of the hero banner image. Only populated
  // for catalog_brands; null for all other attribute types.
  banner_image_url: string | null;
};

// ---------------------------------------------------------------------------
// Table entries for each attribute type
// ---------------------------------------------------------------------------

interface PublicTableEntry {
  main: AnyAttrTable;
  city: AnyCityTable;
  cityFkCol: PgColumn;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TABLE_ENTRIES = {
  occasions: {
    main: occasions as any,
    city: occasionCityAvailability as any,
    cityFkCol: occasionCityAvailability.occasionId,
  } as PublicTableEntry,
  catalog_categories: {
    main: catalogCategories as any,
    city: catalogCategoryCityAvailability as any,
    cityFkCol: catalogCategoryCityAvailability.catalogCategoryId,
  } as PublicTableEntry,
  catalog_brands: {
    main: catalogBrands as any,
    city: catalogBrandCityAvailability as any,
    cityFkCol: catalogBrandCityAvailability.catalogBrandId,
  } as PublicTableEntry,
  recipients: {
    main: recipients as any,
    city: recipientCityAvailability as any,
    cityFkCol: recipientCityAvailability.recipientId,
  } as PublicTableEntry,
};

// ---------------------------------------------------------------------------
// Core fetch helper (replaces the old raw-SQL fetchAttributes function)
// ---------------------------------------------------------------------------

/**
 * Returns active attributes for the given table, optionally filtered by city.
 *
 * Default-on model: every active attribute is available in ALL cities by
 * default.  When cityId is provided the query excludes only attributes that
 * have an explicit city-availability row with is_enabled = false for that
 * city; attributes with no row (or is_enabled = true) remain visible.  When
 * cityId is null all active attributes are returned.
 */
async function fetchAttributes(
  entry: PublicTableEntry,
  cityId: number | null,
  workspaceOwnerId: string,
): Promise<AttrPublicRow[]> {
  // All 4 main tables share the same column names; `as any` is required
  // because TypeScript cannot resolve column access on the union type.
  const t = entry.main;

  const isBrands = t === (catalogBrands as any);

  const selectShape: Record<string, unknown> = {
    id: t.id,
    name: t.name,
    slug: t.slug,
    description: t.description,
    image_url: t.imageUrl,
    sort_order: t.sortOrder,
    // All 4 tables carry a public image copy column.
    image_public_path: (t as any).imagePublicPath,
  };

  // banner_public_path is only present on catalog_brands.
  if (isBrands) {
    selectShape.banner_public_path = (t as any).bannerPublicPath;
  }

  const mapRow = (row: any): AttrPublicRow => {
    const { image_public_path, banner_public_path, ...rest } = row;
    return {
      ...(rest as AttrPublicRow),
      image_public_url: buildPublicObjectUrl(image_public_path ?? null),
      banner_image_url: banner_public_path != null
        ? buildPublicObjectUrl(banner_public_path)
        : null,
    };
  };

  if (cityId !== null) {
    // Default-on: exclude only attributes explicitly disabled for this city.
    const disabledForCity = drizzleDb
      .select({ one: sql`1` })
      .from(entry.city)
      .where(
        and(
          eq(entry.cityFkCol, t.id),
          eq((entry.city as any).cityId, cityId),
          eq((entry.city as any).isEnabled, false),
        ),
      );
    const rows = await drizzleDb
      .select(selectShape as any)
      .from(t)
      .where(
        and(
          eq(t.workspaceOwnerId, workspaceOwnerId),
          eq(t.isActive, true),
          notExists(disabledForCity),
        ),
      )
      .orderBy(asc(t.sortOrder), asc(t.name));
    return (rows as any[]).map(mapRow);
  }

  const rows = await drizzleDb
    .select(selectShape as any)
    .from(t)
    .where(and(eq(t.workspaceOwnerId, workspaceOwnerId), eq(t.isActive, true)))
    .orderBy(asc(t.sortOrder), asc(t.name));
  return (rows as any[]).map(mapRow);
}

// ---------------------------------------------------------------------------
// City + workspace resolver (delivery_cities not yet in Drizzle)
// ---------------------------------------------------------------------------

type CityResolution = { cityId: number | null; workspaceOwnerId: string };

async function resolveCityAndOwner(
  req: Request,
): Promise<CityResolution | { error: string; status: number }> {
  const query = req.query as Record<string, unknown>;
  const ownerIdParam =
    typeof query.workspace_owner_id === "string" ? query.workspace_owner_id : null;
  const citySlug =
    typeof query.city_slug === "string" && query.city_slug.trim()
      ? query.city_slug.trim()
      : null;

  if (citySlug !== null) {
    const slugResult = await drizzleDb.execute<{ id: number; workspace_owner_id: string }>(
      sql`SELECT id, workspace_owner_id FROM delivery_cities WHERE slug = ${citySlug} AND is_active = true LIMIT 1`,
    );
    const r = slugResult.rows[0];
    if (!r) return { error: `No active city found with slug '${citySlug}'`, status: 404 };
    return { cityId: r.id, workspaceOwnerId: r.workspace_owner_id };
  }

  const rawCityId = query.city_id;
  const cityId = rawCityId
    ? (() => {
        const n = parseInt(String(rawCityId), 10);
        return Number.isFinite(n) && n > 0 ? n : null;
      })()
    : null;

  if (cityId !== null) {
    if (ownerIdParam) return { cityId, workspaceOwnerId: ownerIdParam };
    const cityResult = await drizzleDb.execute<{ workspace_owner_id: string }>(
      sql`SELECT workspace_owner_id FROM delivery_cities WHERE id = ${cityId} LIMIT 1`,
    );
    const ownerId = cityResult.rows[0]?.workspace_owner_id ?? null;
    if (!ownerId) return { error: `No city found with id ${cityId}`, status: 404 };
    return { cityId, workspaceOwnerId: ownerId };
  }

  if (ownerIdParam) return { cityId: null, workspaceOwnerId: ownerIdParam };

  const apiKeyOwnerId = await resolveApiKeyWorkspace(req);
  if (apiKeyOwnerId) return { cityId: null, workspaceOwnerId: apiKeyOwnerId };

  return { error: "city_id, city_slug, or workspace_owner_id is required", status: 400 };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

router.get("/catalog-attributes", async (req, res) => {
  const result = await resolveCityAndOwner(req);
  if ("error" in result) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  const { cityId, workspaceOwnerId } = result;
  if (!workspaceOwnerId) {
    res.status(400).json({ error: "city_id, city_slug, or workspace_owner_id is required" });
    return;
  }

  const [occ, cats, brands, recs] = await Promise.all([
    fetchAttributes(TABLE_ENTRIES.occasions, cityId, workspaceOwnerId),
    fetchAttributes(TABLE_ENTRIES.catalog_categories, cityId, workspaceOwnerId),
    fetchAttributes(TABLE_ENTRIES.catalog_brands, cityId, workspaceOwnerId),
    fetchAttributes(TABLE_ENTRIES.recipients, cityId, workspaceOwnerId),
  ]);

  res.json({ occasions: occ, categories: cats, brands: brands, recipients: recs });
});

router.get("/catalog-attributes/occasions", async (req, res) => {
  const r = await resolveCityAndOwner(req);
  if ("error" in r) { res.status(r.status).json({ error: r.error }); return; }
  const items = await fetchAttributes(TABLE_ENTRIES.occasions, r.cityId, r.workspaceOwnerId);
  res.json({ occasions: items });
});

router.get("/catalog-attributes/categories", async (req, res) => {
  const r = await resolveCityAndOwner(req);
  if ("error" in r) { res.status(r.status).json({ error: r.error }); return; }
  const items = await fetchAttributes(TABLE_ENTRIES.catalog_categories, r.cityId, r.workspaceOwnerId);
  res.json({ categories: items });
});

router.get("/catalog-attributes/brands", async (req, res) => {
  const r = await resolveCityAndOwner(req);
  if ("error" in r) { res.status(r.status).json({ error: r.error }); return; }
  const items = await fetchAttributes(TABLE_ENTRIES.catalog_brands, r.cityId, r.workspaceOwnerId);
  res.json({ brands: items });
});

router.get("/catalog-attributes/recipients", async (req, res) => {
  const r = await resolveCityAndOwner(req);
  if ("error" in r) { res.status(r.status).json({ error: r.error }); return; }
  const items = await fetchAttributes(TABLE_ENTRIES.recipients, r.cityId, r.workspaceOwnerId);
  res.json({ recipients: items });
});

export default router;
