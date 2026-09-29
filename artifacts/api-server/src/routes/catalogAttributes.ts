import { Router } from "express";
import { z } from "zod";
import { and, asc, eq, ilike, or, sql, count as drizzleCount } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { drizzleDb } from "../lib/drizzle.js";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";
import { fireCatalogAttributeWebhook, type CatalogAttributeType } from "../lib/catalogWebhook";
import { objectStorageService, buildPublicObjectUrl } from "../lib/objectStorage";
import { logger } from "../lib/logger";
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AttributeType = "occasions" | "catalog_categories" | "catalog_brands" | "recipients";

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
 * Row shape returned in API responses (snake_case to preserve backward compat).
 * Column types are derived from the Drizzle Occasion type (all 4 tables share
 * the same column structure). `banner_image_url` and `banner_image_public_url`
 * are only populated for catalog_brands; other types receive null.
 */
type CatalogAttributeRow = {
  id: Occasion["id"];
  workspace_owner_id: Occasion["workspaceOwnerId"];
  name: Occasion["name"];
  slug: Occasion["slug"];
  description: Occasion["description"];
  image_url: Occasion["imageUrl"];
  image_public_url: string | null;
  banner_image_url: string | null;
  banner_image_public_url: string | null;
  sort_order: Occasion["sortOrder"];
  is_active: Occasion["isActive"];
  is_featured: boolean | null;
  is_upsell: boolean | null;
  created_at: Occasion["createdAt"];
  updated_at: Occasion["updatedAt"];
};

type CatalogAttributeRowWithCounts = CatalogAttributeRow & {
  product_count: string;
  enabled_city_count: string;
};

/**
 * Maps a camelCase Drizzle row back to the snake_case shape the API has
 * always returned, keeping the response format backward-compatible.
 */
function toApiRow(row: {
  id: number;
  workspaceOwnerId: string;
  name: string;
  slug: string;
  description: string | null;
  imageUrl: string | null;
  imagePublicPath?: string | null;
  bannerImageUrl?: string | null;
  bannerPublicPath?: string | null;
  sortOrder: number;
  isActive: boolean;
  isFeatured?: boolean | null;
  isUpsell?: boolean | null;
  createdAt: Date;
  updatedAt: Date;
}): CatalogAttributeRow {
  return {
    id: row.id,
    workspace_owner_id: row.workspaceOwnerId,
    name: row.name,
    slug: row.slug,
    description: row.description,
    image_url: row.imageUrl,
    image_public_url: buildPublicObjectUrl(row.imagePublicPath ?? null),
    banner_image_url: row.bannerImageUrl ?? null,
    banner_image_public_url: buildPublicObjectUrl(row.bannerPublicPath ?? null),
    sort_order: row.sortOrder,
    is_active: row.isActive,
    is_featured: row.isFeatured ?? null,
    is_upsell: row.isUpsell ?? null,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

/**
 * Builds the webhook payload for a catalog attribute. For occasions, it adds the
 * downstream contract fields `featured` (from `is_featured`) and `image` (from
 * `image_url`) alongside the existing fields, so subscribers can read the
 * mega-menu state directly from the webhook body without re-fetching.
 */
function toWebhookPayload(type: string, apiRow: CatalogAttributeRow): Record<string, unknown> {
  if (supportsFeatured(type)) {
    return {
      ...apiRow,
      featured: Boolean(apiRow.is_featured),
      image: apiRow.image_url ?? null,
    };
  }
  return apiRow as unknown as Record<string, unknown>;
}

/**
 * Attribute types that carry an `is_featured` mega-menu flag. Occasions and
 * catalog categories support it; brands and recipients do not.
 */
function supportsFeatured(type: string): boolean {
  return type === "occasions" || type === "catalog_categories";
}

/**
 * Attribute types that carry an `is_upsell` flag. Only catalog categories
 * support it; occasions, brands, and recipients do not.
 */
function supportsUpsell(type: string): boolean {
  return type === "catalog_categories";
}

// ---------------------------------------------------------------------------
// Table map  (Drizzle table objects + per-type ancillary info)
// ---------------------------------------------------------------------------

interface DrizzleTableEntry {
  /** The Drizzle-managed main attribute table. */
  main: AnyAttrTable;
  /** The Drizzle-managed city-availability join table. */
  city: AnyCityTable;
  /**
   * The FK column on the city table that references the main table PK
   * (e.g. occasionCityAvailability.occasionId).  Used in JOIN conditions and
   * onConflictDoUpdate targets.
   */
  cityFkCol: PgColumn;
  /**
   * camelCase JS property name for the FK column used in insert values objects
   * (e.g. "occasionId", "catalogCategoryId").
   */
  cityFkProp: string;
  /**
   * Product-attribute join table name.  These tables have not yet been
   * graduated to Drizzle schema, so they are referenced via a sql`` fragment
   * only, never as interpolated strings.
   */
  productJoinTable: string;
}

// All four tables share an identical column structure, so accessing columns
// via `(table as any).columnName` is safe even though TypeScript cannot
// resolve union-type column access at compile time.
const DRIZZLE_TABLE_MAP: Record<AttributeType, DrizzleTableEntry> = {
  occasions: {
    main: occasions,
    city: occasionCityAvailability,
    cityFkCol: occasionCityAvailability.occasionId,
    cityFkProp: "occasionId",
    productJoinTable: "product_occasions",
  },
  catalog_categories: {
    main: catalogCategories,
    city: catalogCategoryCityAvailability,
    cityFkCol: catalogCategoryCityAvailability.catalogCategoryId,
    cityFkProp: "catalogCategoryId",
    productJoinTable: "product_catalog_categories",
  },
  catalog_brands: {
    main: catalogBrands,
    city: catalogBrandCityAvailability,
    cityFkCol: catalogBrandCityAvailability.catalogBrandId,
    cityFkProp: "catalogBrandId",
    productJoinTable: "product_catalog_brands",
  },
  recipients: {
    main: recipients,
    city: recipientCityAvailability,
    cityFkCol: recipientCityAvailability.recipientId,
    cityFkProp: "recipientId",
    productJoinTable: "product_recipients",
  },
};

// ---------------------------------------------------------------------------
// Permission / page key map
// ---------------------------------------------------------------------------

const PAGE_KEY_MAP: Record<
  AttributeType,
  { read: string; create: string; edit: string; delete: string }
> = {
  occasions: {
    read: "catalog-occasions",
    create: "catalog-occasions.create",
    edit: "catalog-occasions.edit",
    delete: "catalog-occasions.delete",
  },
  catalog_categories: {
    read: "catalog-categories-attr",
    create: "catalog-categories-attr.create",
    edit: "catalog-categories-attr.edit",
    delete: "catalog-categories-attr.delete",
  },
  catalog_brands: {
    read: "catalog-brands-attr",
    create: "catalog-brands-attr.create",
    edit: "catalog-brands-attr.edit",
    delete: "catalog-brands-attr.delete",
  },
  recipients: {
    read: "catalog-recipients",
    create: "catalog-recipients.create",
    edit: "catalog-recipients.edit",
    delete: "catalog-recipients.delete",
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const router = Router();
router.use(requireAuth, resolveWorkspace);

function hasPermission(wreq: ReturnType<typeof workspace>, perm: string): boolean {
  return wreq.workspaceActualRole === "owner" || (wreq.allowedPages?.includes(perm) ?? false);
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/['']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

const VALID_TYPES = [
  "occasions",
  "catalog_categories",
  "catalog_brands",
  "recipients",
] as const;

const createSchema = z.object({
  name: z.string().min(1).max(200),
  slug: z.string().min(1).max(80).optional(),
  description: z.string().max(2000).optional().nullable(),
  image_url: z.string().max(500).optional().nullable(),
  banner_image_url: z.string().max(500).optional().nullable(),
  sort_order: z.number().int().optional().default(0),
  is_active: z.boolean().optional().default(true),
  is_featured: z.boolean().optional(),
  is_upsell: z.boolean().optional(),
});

const updateSchema = createSchema.partial();

const cityAvailabilityBatchSchema = z.array(
  z.object({
    city_id: z.number().int(),
    is_enabled: z.boolean(),
  }),
);

// ---------------------------------------------------------------------------
// Webhook event name helper
// ---------------------------------------------------------------------------

function webhookEventSuffix(type: AttributeType): string {
  if (type === "catalog_categories") return "catalog_category";
  if (type === "catalog_brands") return "catalog_brand";
  return type.replace(/s$/, "");
}

// ---------------------------------------------------------------------------
// Catalog-attribute public-image sync
// ---------------------------------------------------------------------------

/**
 * Keeps a catalog attribute's public, auth-free image copy in sync with its
 * private `image_url`. When `imageUrl` is set, the private object is copied into
 * the public bucket and the resulting public key is stored on
 * `image_public_path`. When `imageUrl` is null, the stored public key is
 * cleared. The public-bucket key is namespaced by attribute type
 * (e.g. "occasions/123", "catalog_categories/45"). Failures are logged and
 * swallowed so they never break the create/update response.
 */
async function syncAttributePublicImage(
  type: AttributeType,
  id: number,
  imageUrl: string | null,
  ownerId: string,
): Promise<void> {
  // All four tables carry an identical `imagePublicPath` column; `as any` is
  // required because TypeScript cannot resolve column access on the union type.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mainTable = DRIZZLE_TABLE_MAP[type].main as any;
  try {
    if (imageUrl) {
      const publicKey = await objectStorageService.copyPrivateObjectToPublic(
        imageUrl,
        `${type}/${id}`,
        ownerId,
      );
      await drizzleDb
        .update(mainTable)
        .set({ imagePublicPath: publicKey })
        .where(eq(mainTable.id, id));
    } else {
      await drizzleDb
        .update(mainTable)
        .set({ imagePublicPath: null })
        .where(eq(mainTable.id, id));
    }
  } catch (err) {
    logger.error({ err, type, id }, "Failed to sync catalog attribute public image");
  }
}

// ---------------------------------------------------------------------------
// Catalog-brand banner public-image sync
// ---------------------------------------------------------------------------

/**
 * Keeps the catalog brand's banner image public copy in sync with its private
 * `banner_image_url`. When `bannerImageUrl` is set, the private object is
 * copied into the public bucket under `catalog_brands_banners/{id}` and the
 * resulting key is stored in `banner_public_path`. When null, the stored key
 * is cleared. Failures are logged and swallowed.
 */
async function syncBrandBannerPublicImage(
  id: number,
  bannerImageUrl: string | null,
  ownerId: string,
): Promise<void> {
  try {
    if (bannerImageUrl) {
      const publicKey = await objectStorageService.copyPrivateObjectToPublic(
        bannerImageUrl,
        `catalog_brands_banners/${id}`,
        ownerId,
      );
      await drizzleDb
        .update(catalogBrands)
        .set({ bannerPublicPath: publicKey })
        .where(eq(catalogBrands.id, id));
    } else {
      await drizzleDb
        .update(catalogBrands)
        .set({ bannerPublicPath: null })
        .where(eq(catalogBrands.id, id));
    }
  } catch (err) {
    logger.error({ err, id }, "Failed to sync catalog brand banner public image");
  }
}

// ---------------------------------------------------------------------------
// Per-type route factory
// ---------------------------------------------------------------------------

function attributeRouter(type: AttributeType) {
  const entry = DRIZZLE_TABLE_MAP[type];
  const pk = PAGE_KEY_MAP[type];
  // Convenience alias; TypeScript cannot resolve column access on union types
  // so we use `as any` here — safe because all four tables share the same
  // column set.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mainTable = entry.main as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cityTable = entry.city as any;

  const sub = Router({ mergeParams: true });

  // ── LIST ──────────────────────────────────────────────────────────────────

  sub.get(`/${type}`, async (req, res) => {
    const wreq = workspace(req);
    const ownerId = wreq.workspaceOwnerId;

    const q =
      typeof req.query.q === "string" && req.query.q.trim() ? req.query.q.trim() : null;
    const status = typeof req.query.status === "string" ? req.query.status : null;
    const rawPage = parseInt(typeof req.query.page === "string" ? req.query.page : "1", 10);
    const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;
    const rawPageSize = parseInt(
      typeof req.query.pageSize === "string" ? req.query.pageSize : "50",
      10,
    );
    const pageSize = [10, 25, 50, 100].includes(rawPageSize) ? rawPageSize : 50;

    // Build WHERE conditions
    const conditions = [eq(mainTable.workspaceOwnerId, ownerId)];
    if (q) {
      const pattern = `%${q.replace(/([%_\\])/g, "\\$1")}%`;
      conditions.push(
        or(
          ilike(mainTable.name, pattern),
          ilike(mainTable.slug, pattern),
        ) as ReturnType<typeof eq>,
      );
    }
    if (status === "active") conditions.push(eq(mainTable.isActive, true));
    else if (status === "inactive") conditions.push(eq(mainTable.isActive, false));

    const where = and(...conditions);

    // The product join tables are not yet in Drizzle; reference them via
    // sql template (table names are constants, not user input — safe).
    const productJoinSql = sql.raw(`"${entry.productJoinTable}"`);

    const [countResult, rows] = await Promise.all([
      drizzleDb
        .select({ total: drizzleCount() })
        .from(mainTable)
        .where(where),
      drizzleDb
        .select({
          id: mainTable.id,
          workspace_owner_id: mainTable.workspaceOwnerId,
          name: mainTable.name,
          slug: mainTable.slug,
          description: mainTable.description,
          image_url: mainTable.imageUrl,
          image_public_path: mainTable.imagePublicPath,
          banner_image_url: type === "catalog_brands" ? (mainTable as any).bannerImageUrl : sql<string | null>`null`,
          banner_public_path: type === "catalog_brands" ? (mainTable as any).bannerPublicPath : sql<string | null>`null`,
          sort_order: mainTable.sortOrder,
          is_active: mainTable.isActive,
          is_featured: supportsFeatured(type) ? mainTable.isFeatured : sql<boolean>`false`,
          is_upsell: supportsUpsell(type) ? (mainTable as any).isUpsell : sql<boolean>`false`,
          created_at: mainTable.createdAt,
          updated_at: mainTable.updatedAt,
          product_count: sql<string>`(SELECT COUNT(*) FROM ${productJoinSql} WHERE attribute_id = ${mainTable.id})`,
          enabled_city_count: sql<string>`(SELECT COUNT(*) FROM ${entry.city} WHERE ${entry.cityFkCol} = ${mainTable.id} AND is_enabled = true)`,
        })
        .from(mainTable)
        .where(where)
        .orderBy(asc(mainTable.sortOrder), asc(mainTable.name))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
    ]);

    const total = Number(countResult[0]?.total ?? 0);
    const items = (rows as Array<Record<string, unknown>>).map((row) => {
      const { image_public_path, banner_public_path, ...rest } = row;
      return {
        ...rest,
        image_public_url: buildPublicObjectUrl(
          (image_public_path as string | null | undefined) ?? null,
        ),
        banner_image_public_url: buildPublicObjectUrl(
          (banner_public_path as string | null | undefined) ?? null,
        ),
      } as CatalogAttributeRowWithCounts;
    });
    res.json({
      items,
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    });
  });

  // ── CREATE ────────────────────────────────────────────────────────────────

  sub.post(`/${type}`, async (req, res) => {
    const wreq = workspace(req);
    if (!hasPermission(wreq, pk.create)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });
      return;
    }
    const data = parsed.data;
    const slug = data.slug ?? slugify(data.name);

    const existing = await drizzleDb
      .select({ id: mainTable.id })
      .from(mainTable)
      .where(and(eq(mainTable.workspaceOwnerId, wreq.workspaceOwnerId), eq(mainTable.slug, slug)))
      .limit(1);
    if (existing.length > 0) {
      res.status(409).json({ error: "An item with this slug already exists" });
      return;
    }

    const insertValues: Record<string, unknown> = {
      workspaceOwnerId: wreq.workspaceOwnerId,
      name: data.name,
      slug,
      description: data.description ?? null,
      imageUrl: data.image_url ?? null,
      sortOrder: data.sort_order ?? 0,
      isActive: data.is_active ?? true,
    };
    if (type === "catalog_brands" && data.banner_image_url !== undefined) {
      insertValues.bannerImageUrl = data.banner_image_url ?? null;
    }

    const [inserted] = await drizzleDb
      .insert(entry.main)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .values(insertValues as any)
      .returning();

    if (!inserted) {
      res.status(500).json({ error: "Insert failed" });
      return;
    }
    const apiRow = toApiRow(inserted as Parameters<typeof toApiRow>[0]);
    if (data.image_url) {
      await syncAttributePublicImage(type, apiRow.id, data.image_url, wreq.workspaceOwnerId);
    }
    if (type === "catalog_brands" && data.banner_image_url !== undefined) {
      await syncBrandBannerPublicImage(apiRow.id, data.banner_image_url ?? null, wreq.workspaceOwnerId);
    }
    res.status(201).json({ item: apiRow });
    fireCatalogAttributeWebhook(
      `catalog_attribute.${webhookEventSuffix(type)}.created` as Parameters<typeof fireCatalogAttributeWebhook>[0],
      type as CatalogAttributeType,
      toWebhookPayload(type, apiRow),
      wreq.workspaceOwnerId,
    ).catch(() => {});
  });

  // ── GET BY ID ─────────────────────────────────────────────────────────────

  sub.get(`/${type}/:id`, async (req, res) => {
    const wreq = workspace(req);
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    const productJoinSql = sql.raw(`"${entry.productJoinTable}"`);

    const [row] = await drizzleDb
      .select({
        id: mainTable.id,
        workspace_owner_id: mainTable.workspaceOwnerId,
        name: mainTable.name,
        slug: mainTable.slug,
        description: mainTable.description,
        image_url: mainTable.imageUrl,
        image_public_path: mainTable.imagePublicPath,
        banner_image_url: type === "catalog_brands" ? (mainTable as any).bannerImageUrl : sql<string | null>`null`,
        banner_public_path: type === "catalog_brands" ? (mainTable as any).bannerPublicPath : sql<string | null>`null`,
        sort_order: mainTable.sortOrder,
        is_active: mainTable.isActive,
        is_featured: supportsFeatured(type) ? mainTable.isFeatured : sql<boolean>`false`,
        is_upsell: supportsUpsell(type) ? (mainTable as any).isUpsell : sql<boolean>`false`,
        created_at: mainTable.createdAt,
        updated_at: mainTable.updatedAt,
        product_count: sql<string>`(SELECT COUNT(*) FROM ${productJoinSql} WHERE attribute_id = ${mainTable.id})`,
        // Default-on model: an item is available in EVERY workspace delivery city
        // unless an explicit row disables it. The enabled count is therefore the
        // total number of delivery cities minus the explicitly-disabled rows.
        enabled_city_count: sql<string>`(
          (SELECT COUNT(*) FROM delivery_cities WHERE workspace_owner_id = ${mainTable.workspaceOwnerId})
          - (SELECT COUNT(*) FROM ${entry.city} WHERE ${entry.cityFkCol} = ${mainTable.id} AND is_enabled = false)
        )`,
      })
      .from(mainTable)
      .where(and(eq(mainTable.id, id), eq(mainTable.workspaceOwnerId, wreq.workspaceOwnerId)))
      .limit(1);

    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const { image_public_path, banner_public_path, ...rest } = row as Record<string, unknown>;
    const item = {
      ...rest,
      image_public_url: buildPublicObjectUrl(
        (image_public_path as string | null | undefined) ?? null,
      ),
      banner_image_public_url: buildPublicObjectUrl(
        (banner_public_path as string | null | undefined) ?? null,
      ),
    } as CatalogAttributeRowWithCounts;
    res.json({ item });
  });

  // ── PATCH ─────────────────────────────────────────────────────────────────

  sub.patch(`/${type}/:id`, async (req, res) => {
    const wreq = workspace(req);
    if (!hasPermission(wreq, pk.edit)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    const check = await drizzleDb
      .select({ id: mainTable.id })
      .from(mainTable)
      .where(and(eq(mainTable.id, id), eq(mainTable.workspaceOwnerId, wreq.workspaceOwnerId)))
      .limit(1);
    if (check.length === 0) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });
      return;
    }
    const data = parsed.data;

    // Slug uniqueness check (only when slug is being changed)
    if (data.slug !== undefined) {
      const slugConflict = await drizzleDb
        .select({ id: mainTable.id })
        .from(mainTable)
        .where(
          and(
            eq(mainTable.workspaceOwnerId, wreq.workspaceOwnerId),
            eq(mainTable.slug, data.slug),
            sql`${mainTable.id} != ${id}`,
          ),
        )
        .limit(1);
      if (slugConflict.length > 0) {
        res.status(409).json({ error: "Slug already exists" });
        return;
      }
    }

    // Build partial update object (only set fields that were provided)
    const updateValues: Record<string, unknown> = { updatedAt: new Date() };
    if (data.name !== undefined) updateValues.name = data.name;
    if (data.slug !== undefined) updateValues.slug = data.slug;
    if (data.description !== undefined) updateValues.description = data.description;
    if (data.image_url !== undefined) updateValues.imageUrl = data.image_url;
    if (data.sort_order !== undefined) updateValues.sortOrder = data.sort_order;
    if (data.is_active !== undefined) updateValues.isActive = data.is_active;
    if (data.is_featured !== undefined && supportsFeatured(type)) updateValues.isFeatured = data.is_featured;
    if (data.is_upsell !== undefined && supportsUpsell(type)) updateValues.isUpsell = data.is_upsell;
    if (type === "catalog_brands" && data.banner_image_url !== undefined) {
      updateValues.bannerImageUrl = data.banner_image_url ?? null;
    }

    const [updated] = await drizzleDb
      .update(entry.main)
      .set(updateValues)
      .where(and(eq(mainTable.id, id), eq(mainTable.workspaceOwnerId, wreq.workspaceOwnerId)))
      .returning();

    if (!updated) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const apiRow = toApiRow(updated as Parameters<typeof toApiRow>[0]);
    if (data.image_url !== undefined) {
      await syncAttributePublicImage(type, apiRow.id, data.image_url ?? null, wreq.workspaceOwnerId);
    }
    if (type === "catalog_brands" && data.banner_image_url !== undefined) {
      await syncBrandBannerPublicImage(apiRow.id, data.banner_image_url ?? null, wreq.workspaceOwnerId);
    }
    res.json({ item: apiRow });
    fireCatalogAttributeWebhook(
      `catalog_attribute.${webhookEventSuffix(type)}.updated` as Parameters<typeof fireCatalogAttributeWebhook>[0],
      type as CatalogAttributeType,
      toWebhookPayload(type, apiRow),
      wreq.workspaceOwnerId,
    ).catch(() => {});
  });

  // ── DELETE ────────────────────────────────────────────────────────────────

  sub.delete(`/${type}/:id`, async (req, res) => {
    const wreq = workspace(req);
    if (!hasPermission(wreq, pk.delete)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    const check = await drizzleDb
      .select({ id: mainTable.id })
      .from(mainTable)
      .where(and(eq(mainTable.id, id), eq(mainTable.workspaceOwnerId, wreq.workspaceOwnerId)))
      .limit(1);
    if (check.length === 0) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    // Refuse delete if products are assigned (product join tables not yet in Drizzle)
    const productJoinSql = sql.raw(`"${entry.productJoinTable}"`);
    const countResult = await drizzleDb.execute<{ count: string }>(
      sql`SELECT COUNT(*) AS count FROM ${productJoinSql} WHERE attribute_id = ${id}`,
    );
    const productCount = parseInt(countResult.rows[0]?.count ?? "0", 10);
    if (productCount > 0) {
      res.status(409).json({
        error: `Cannot delete: ${productCount} product(s) are assigned to this item`,
      });
      return;
    }

    await drizzleDb
      .delete(entry.main)
      .where(and(eq(mainTable.id, id), eq(mainTable.workspaceOwnerId, wreq.workspaceOwnerId)));

    res.json({ success: true });
    fireCatalogAttributeWebhook(
      `catalog_attribute.${webhookEventSuffix(type)}.deleted` as Parameters<typeof fireCatalogAttributeWebhook>[0],
      type as CatalogAttributeType,
      { id },
      wreq.workspaceOwnerId,
    ).catch(() => {});
  });

  // ── GET city-availability ─────────────────────────────────────────────────

  sub.get(`/${type}/:id/city-availability`, async (req, res) => {
    const wreq = workspace(req);
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    const ownerCheck = await drizzleDb
      .select({ id: mainTable.id })
      .from(mainTable)
      .where(and(eq(mainTable.id, id), eq(mainTable.workspaceOwnerId, wreq.workspaceOwnerId)))
      .limit(1);
    if (ownerCheck.length === 0) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    // delivery_cities is not yet in Drizzle; use drizzleDb.execute with a
    // parametrized sql template.  The city-availability table IS a Drizzle
    // table: it is referenced via ${entry.city} and its columns via the
    // Drizzle column objects (${entry.cityFkCol}, ${cityTable.cityId}, …),
    // which render proper, table-qualified identifiers. Do NOT hand-build an
    // alias + sql.identifier(col.name) — that double-qualifies the column
    // (e.g. ca."catalog_brand_city_availability"."catalog_brand_id") and
    // Postgres rejects it with "missing FROM-clause entry".
    type CityRow = {
      city_id: number;
      city_name: string;
      country_code: string;
      city_slug: string;
      city_is_active: boolean;
      is_enabled: boolean;
      updated_at: Date | null;
    };
    const citiesResult = await drizzleDb.execute<CityRow>(
      sql`
        SELECT dc.id          AS city_id,
               dc.name        AS city_name,
               dc.country_code,
               dc.slug        AS city_slug,
               dc.is_active   AS city_is_active,
               -- Default-on: a city with no explicit row is ENABLED by default.
               COALESCE(${cityTable.isEnabled}, true) AS is_enabled,
               ${cityTable.updatedAt} AS updated_at
          FROM delivery_cities dc
          LEFT JOIN ${entry.city}
            ON ${entry.cityFkCol} = ${id}
           AND ${cityTable.cityId} = dc.id
         WHERE dc.workspace_owner_id = ${wreq.workspaceOwnerId}
         ORDER BY dc.country_code ASC, dc.sort_order ASC, dc.name ASC
      `,
    );
    const cities = citiesResult.rows;

    const total_cities = cities.length;
    const enabled_count = cities.filter((c) => c.is_enabled).length;
    res.json({ cities, enabled_count, total_cities });
  });

  // ── PUT city-availability (batch) ─────────────────────────────────────────

  sub.put(`/${type}/:id/city-availability`, async (req, res) => {
    const wreq = workspace(req);
    if (wreq.workspaceActualRole !== "owner") {
      res.status(403).json({ error: "Owner access required" });
      return;
    }
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    const ownerCheck = await drizzleDb
      .select({ id: mainTable.id })
      .from(mainTable)
      .where(and(eq(mainTable.id, id), eq(mainTable.workspaceOwnerId, wreq.workspaceOwnerId)))
      .limit(1);
    if (ownerCheck.length === 0) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const parsed = cityAvailabilityBatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed" });
      return;
    }
    const updates = parsed.data;
    if (updates.length === 0) {
      res.json({ success: true });
      return;
    }

    // Validate that the city IDs belong to this workspace (delivery_cities not
    // in Drizzle). Interpolating a JS array into a sql`` template renders it as
    // a record (e.g. `($1, $2)`), which cannot be cast to int[], so we fetch
    // all workspace city IDs and filter in JS instead.
    const validCityResult = await drizzleDb.execute<{ id: number }>(
      sql`SELECT id FROM delivery_cities WHERE workspace_owner_id = ${wreq.workspaceOwnerId}`,
    );
    const validIds = new Set(validCityResult.rows.map((r) => r.id));

    await drizzleDb.transaction(async (tx) => {
      for (const u of updates) {
        if (!validIds.has(u.city_id)) continue;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (tx.insert(entry.city) as any)
          .values({ [entry.cityFkProp]: id, cityId: u.city_id, isEnabled: u.is_enabled, updatedAt: new Date() })
          .onConflictDoUpdate({
            target: [entry.cityFkCol, cityTable.cityId],
            set: { isEnabled: u.is_enabled, updatedAt: new Date() },
          });
      }
    });

    const enabledCityIds = updates.filter((u) => u.is_enabled).map((u) => u.city_id);
    res.json({ success: true });
    fireCatalogAttributeWebhook(
      `catalog_attribute.${webhookEventSuffix(type)}.city_availability_updated` as Parameters<typeof fireCatalogAttributeWebhook>[0],
      type as CatalogAttributeType,
      { id },
      wreq.workspaceOwnerId,
      enabledCityIds,
    ).catch(() => {});
  });

  // ── PATCH city-availability/bulk ──────────────────────────────────────────

  sub.patch(`/${type}/:id/city-availability/bulk`, async (req, res) => {
    const wreq = workspace(req);
    if (wreq.workspaceActualRole !== "owner") {
      res.status(403).json({ error: "Owner access required" });
      return;
    }
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    const ownerCheck = await drizzleDb
      .select({ id: mainTable.id })
      .from(mainTable)
      .where(and(eq(mainTable.id, id), eq(mainTable.workspaceOwnerId, wreq.workspaceOwnerId)))
      .limit(1);
    if (ownerCheck.length === 0) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const enableAll = req.body?.enable_all;
    if (typeof enableAll !== "boolean") {
      res.status(400).json({ error: "enable_all (boolean) is required" });
      return;
    }

    // delivery_cities not yet in Drizzle — use execute
    const allCitiesResult = await drizzleDb.execute<{ id: number }>(
      sql`SELECT id FROM delivery_cities WHERE workspace_owner_id = ${wreq.workspaceOwnerId}`,
    );
    const allCities = allCitiesResult.rows;

    await drizzleDb.transaction(async (tx) => {
      for (const city of allCities) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (tx.insert(entry.city) as any)
          .values({ [entry.cityFkProp]: id, cityId: city.id, isEnabled: enableAll, updatedAt: new Date() })
          .onConflictDoUpdate({
            target: [entry.cityFkCol, cityTable.cityId],
            set: { isEnabled: enableAll, updatedAt: new Date() },
          });
      }
    });

    const affectedCityIds = enableAll ? allCities.map((c) => c.id) : [];
    res.json({ success: true });
    fireCatalogAttributeWebhook(
      `catalog_attribute.${webhookEventSuffix(type)}.city_availability_updated` as Parameters<typeof fireCatalogAttributeWebhook>[0],
      type as CatalogAttributeType,
      { id },
      wreq.workspaceOwnerId,
      affectedCityIds,
    ).catch(() => {});
  });

  return sub;
}

for (const type of VALID_TYPES) {
  router.use(attributeRouter(type));
}

export default router;
