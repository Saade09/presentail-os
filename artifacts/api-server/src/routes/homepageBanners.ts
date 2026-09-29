import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { db } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";
import { computeBannerStatus } from "../lib/homepageBannerStatus";
import { fireCatalogDataWebhook, fireWebhookEvent } from "../lib/catalogWebhook";
import { logger } from "../lib/logger";
import { findCountryByCode, findCountryByName } from "../lib/defaults";
import { objectStorageService, buildPublicObjectUrl } from "../lib/objectStorage";

const router = Router();

/**
 * Build the set of normalized (lowercased, trimmed) string variants that a
 * stored `country_codes` value may take for a given caller-supplied country.
 *
 * The website sends ISO alpha-2 codes (e.g. `LB`), while the admin UI may have
 * saved full names (e.g. `Lebanon`) — or vice-versa. Resolving the input to a
 * known catalogue entry lets a banner match whether it stored the code or the
 * name, in either direction. Always includes the raw normalized input as a
 * fallback for values not in the catalogue.
 */
export function buildCountryMatchCandidates(input: string): string[] {
  const normalized = input.trim().toLowerCase();
  const candidates = new Set<string>();
  if (normalized) candidates.add(normalized);

  const entry = findCountryByName(input) ?? findCountryByCode(input);
  if (entry) {
    candidates.add(entry.name.trim().toLowerCase());
    candidates.add(entry.code.trim().toLowerCase());
  }

  return Array.from(candidates);
}

const MEDIA_TYPES = ["image", "video"] as const;
const LINK_KINDS = ["category", "occasion"] as const;
type LinkKind = (typeof LINK_KINDS)[number];

const SideSchema = z.object({
  enabled: z.boolean(),
  media_type: z.enum(MEDIA_TYPES).nullable().optional(),
  media_url: z.string().min(1).nullable().optional(),
  fallback_image_url: z.string().min(1).nullable().optional(),
  // Legacy free-text link URL. Retained for backward compatibility: the admin UI
  // no longer collects it, but existing values are carried through on edit and
  // still served by the storefront when no structured link target is set.
  link_url: z.string().min(1).nullable().optional(),
});

const DESTINATION_TYPES = ["none", "category", "occasion", "custom_url"] as const;

const BannerInputSchema = z
  .object({
    internal_name: z.string().min(1).max(200),
    title: z.string().max(500).nullable().optional(),
    headline: z.string().max(500).nullable().optional(),
    subtitle: z.string().max(1000).nullable().optional(),
    cta_text: z.string().max(200).nullable().optional(),
    country_codes: z
      .array(z.string().min(1).max(100))
      .min(1, "At least one country is required"),
    city_ids: z.array(z.number().int().positive()).optional().default([]),
    is_global_for_country: z.boolean().optional().default(false),
    // Language targeting: ['en', 'ar', 'fr']. Defaults to all supported.
    languages: z.array(z.string().min(1).max(10)).optional().default(["en", "ar"]),
    desktop: SideSchema,
    mobile: SideSchema,
    // Structured banner-level link target. The slug is resolved server-side from
    // the picked attribute id and never trusted from the client.
    link_kind: z.enum(LINK_KINDS).nullable().optional(),
    link_attribute_id: z.number().int().positive().nullable().optional(),
    // New destination fields — stored alongside link_kind for the admin UI.
    // destination_type: 'none' | 'category' | 'occasion' | 'custom_url'
    // destination_value: the custom URL when destination_type = 'custom_url'
    destination_type: z.enum(DESTINATION_TYPES).nullable().optional(),
    destination_value: z.string().max(2000).nullable().optional(),
    // start_at is optional — drafts may omit it.
    start_at: z.string().nullable().optional(),
    end_at: z.string().nullable().optional(),
    timezone: z.string().min(1).max(100),
    sort_order: z.number().int().optional().default(0),
    priority: z.number().int().optional().default(0),
    is_active: z.boolean().optional().default(false),
  })
  .superRefine((data, ctx) => {
    if (!data.desktop.enabled && !data.mobile.enabled) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "At least one of desktop or mobile must be enabled",
        path: ["desktop"],
      });
    }
    for (const side of ["desktop", "mobile"] as const) {
      const s = data[side];
      if (!s.enabled) continue;
      if (!s.media_type) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${side}.media_type is required`, path: [side, "media_type"] });
      }
      if (!s.media_url) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${side}.media_url is required`, path: [side, "media_url"] });
      }
      if (s.media_type === "video" && !s.fallback_image_url) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${side}.fallback_image_url is required when media_type is video`,
          path: [side, "fallback_image_url"],
        });
      }
    }
    // A link target requires both a kind and a picked item, or neither.
    if (
      (data.link_kind && data.link_attribute_id == null) ||
      (!data.link_kind && data.link_attribute_id != null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "link_kind and link_attribute_id must be provided together",
        path: ["link_attribute_id"],
      });
    }
  });

/**
 * Resolve a banner's structured link target to a slug snapshot.
 *
 * SECURITY: the slug is looked up server-side from the workspace-scoped
 * catalog_categories/occasions tables — the client-provided slug (if any) is
 * never trusted. Returns nulls when no target is set; throws a 400-style error
 * when the picked attribute does not exist in the workspace.
 */
async function resolveBannerLinkTarget(
  workspaceOwnerId: string,
  linkKind: LinkKind | null | undefined,
  linkAttributeId: number | null | undefined,
): Promise<{ link_kind: string | null; link_attribute_id: number | null; link_slug: string | null }> {
  if (!linkKind || linkAttributeId == null) {
    return { link_kind: null, link_attribute_id: null, link_slug: null };
  }
  const table = linkKind === "category" ? "catalog_categories" : "occasions";
  const result = await db.query<{ slug: string }>(
    `SELECT slug FROM ${table} WHERE id = $1 AND workspace_owner_id = $2`,
    [linkAttributeId, workspaceOwnerId],
  );
  if (result.rowCount === 0) {
    const err = new Error(`Selected ${linkKind} was not found in this workspace`);
    (err as Error & { statusCode?: number }).statusCode = 400;
    throw err;
  }
  return {
    link_kind: linkKind,
    link_attribute_id: linkAttributeId,
    link_slug: result.rows[0].slug,
  };
}

/**
 * Batch-resolve human-readable display names for the structured link targets of
 * a set of banner rows. Returns a map of banner id → attribute name. Looks up
 * the current name from catalog_categories/occasions (scoped to the workspace)
 * so the storefront shows up-to-date labels even if an attribute was renamed.
 */
async function resolveBannerLinkNames(
  workspaceOwnerId: string,
  rows: Pick<BannerRow, "id" | "link_kind" | "link_attribute_id">[],
): Promise<Map<number, string>> {
  const byKind: Record<LinkKind, Map<number, number[]>> = {
    category: new Map(),
    occasion: new Map(),
  };
  for (const row of rows) {
    if (
      (row.link_kind === "category" || row.link_kind === "occasion") &&
      row.link_attribute_id != null
    ) {
      const map = byKind[row.link_kind];
      const list = map.get(row.link_attribute_id) ?? [];
      list.push(row.id);
      map.set(row.link_attribute_id, list);
    }
  }

  const names = new Map<number, string>();
  for (const kind of LINK_KINDS) {
    const map = byKind[kind];
    if (map.size === 0) continue;
    const ids = Array.from(map.keys());
    const table = kind === "category" ? "catalog_categories" : "occasions";
    const result = await db.query<{ id: number; name: string }>(
      `SELECT id, name FROM ${table} WHERE workspace_owner_id = $1 AND id = ANY($2::int[])`,
      [workspaceOwnerId, ids],
    );
    for (const attr of result.rows) {
      for (const bannerId of map.get(attr.id) ?? []) {
        names.set(bannerId, attr.name);
      }
    }
  }
  return names;
}

export type BannerInput = z.infer<typeof BannerInputSchema>;

interface BannerRow {
  id: number;
  workspace_owner_id: string;
  internal_name: string;
  title: string | null;
  headline: string | null;
  subtitle: string | null;
  cta_text: string | null;
  country_codes: string[];
  city_ids: number[];
  is_global_for_country: boolean;
  languages: string[];
  desktop_enabled: boolean;
  desktop_media_type: string | null;
  desktop_media_url: string | null;
  desktop_media_public_path: string | null;
  desktop_fallback_url: string | null;
  desktop_fallback_public_path: string | null;
  desktop_link_url: string | null;
  mobile_enabled: boolean;
  mobile_media_type: string | null;
  mobile_media_url: string | null;
  mobile_media_public_path: string | null;
  mobile_fallback_url: string | null;
  mobile_fallback_public_path: string | null;
  mobile_link_url: string | null;
  link_kind: string | null;
  link_attribute_id: number | null;
  link_slug: string | null;
  destination_type: string | null;
  destination_value: string | null;
  status_override: string | null;
  start_at: Date | null;
  end_at: Date | null;
  timezone: string;
  sort_order: number;
  priority: number;
  is_active: boolean;
  activated_at: Date | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: Date;
  updated_at: Date;
}

function serializeBanner(row: BannerRow) {
  return {
    id: row.id,
    internal_name: row.internal_name,
    title: row.title,
    headline: row.headline,
    subtitle: row.subtitle,
    cta_text: row.cta_text,
    country_codes: row.country_codes,
    city_ids: row.city_ids,
    is_global_for_country: row.is_global_for_country,
    languages: row.languages ?? ["en", "ar"],
    desktop: {
      enabled: row.desktop_enabled,
      media_type: row.desktop_media_type,
      media_url: row.desktop_media_url,
      fallback_image_url: row.desktop_fallback_url,
      link_url: row.desktop_link_url,
    },
    mobile: {
      enabled: row.mobile_enabled,
      media_type: row.mobile_media_type,
      media_url: row.mobile_media_url,
      fallback_image_url: row.mobile_fallback_url,
      link_url: row.mobile_link_url,
    },
    link_kind: row.link_kind,
    link_attribute_id: row.link_attribute_id,
    link_slug: row.link_slug,
    destination_type: row.destination_type,
    destination_value: row.destination_value,
    status_override: row.status_override,
    start_at: row.start_at?.toISOString() ?? null,
    end_at: row.end_at?.toISOString() ?? null,
    timezone: row.timezone,
    sort_order: row.sort_order,
    priority: row.priority,
    is_active: row.is_active,
    activated_at: row.activated_at?.toISOString() ?? null,
    status: computeBannerStatus({
      is_active: row.is_active,
      activated_at: row.activated_at,
      start_at: row.start_at,
      end_at: row.end_at,
      status_override: row.status_override,
    }),
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export type SerializedBanner = ReturnType<typeof serializeBanner>;

/**
 * Fire `banner.updated` with the full current banner list for the workspace.
 * Called fire-and-forget after any banner mutation so subscribers can refresh
 * their cache without a round-trip.
 */
async function fireBannerUpdated(ownerId: string): Promise<void> {
  try {
    const r = await db.query<BannerRow>(
      `SELECT * FROM homepage_banners WHERE workspace_owner_id = $1 ORDER BY sort_order ASC, priority ASC, created_at DESC`,
      [ownerId],
    );
    void fireWebhookEvent("banner.updated", ownerId, { banners: r.rows.map(serializeBanner) });
  } catch (err) {
    logger.error({ err, ownerId }, "fireBannerUpdated: error building or dispatching banner list");
  }
}

// ---------------------------------------------------------------------------
// Public-image syncing
//
// Banner media is uploaded as a PRIVATE object (`/objects/<owner>/...`) served
// only through the cookie-gated `/api/storage/objects/*` route, so it is NOT
// reachable from the public storefront. Mirroring how product images work, we
// copy each banner's media into the auth-free public bucket and store the
// resulting stable key, then serve an absolute public URL from the storefront.
// ---------------------------------------------------------------------------

type BannerMediaField =
  | "desktop_media"
  | "desktop_fallback"
  | "mobile_media"
  | "mobile_fallback";

// Maps each logical media field to its stored-URL column and the column that
// holds the public copy's key. Column names come from this fixed server-side
// allowlist only — never from client input — so the dynamic SQL below is safe.
const BANNER_MEDIA_FIELDS: Record<
  BannerMediaField,
  { urlCol: keyof BannerRow; publicCol: string }
> = {
  desktop_media: { urlCol: "desktop_media_url", publicCol: "desktop_media_public_path" },
  desktop_fallback: { urlCol: "desktop_fallback_url", publicCol: "desktop_fallback_public_path" },
  mobile_media: { urlCol: "mobile_media_url", publicCol: "mobile_media_public_path" },
  mobile_fallback: { urlCol: "mobile_fallback_url", publicCol: "mobile_fallback_public_path" },
};

/** A stored value that points at a private uploaded object we can copy. */
function isPrivateObjectPath(value: string | null | undefined): value is string {
  return typeof value === "string" && value.startsWith("/objects/");
}

/**
 * Copy a banner field's private object into the public bucket and persist the
 * resulting key on the matching `*_public_path` column. Returns the public key,
 * or null when there is nothing to copy or the copy fails. Best-effort: errors
 * are logged and swallowed so they never break a save or a storefront read.
 */
async function ensureBannerFieldPublicKey(
  bannerId: number,
  ownerId: string,
  field: BannerMediaField,
  storedUrl: string | null,
): Promise<string | null> {
  if (!isPrivateObjectPath(storedUrl)) return null;
  const { publicCol } = BANNER_MEDIA_FIELDS[field];
  try {
    const publicKey = await objectStorageService.copyPrivateObjectToPublic(
      storedUrl,
      `homepage_banners/${bannerId}/${field}`,
      ownerId,
    );
    await db.query(
      `UPDATE homepage_banners SET ${publicCol} = $1 WHERE id = $2 AND workspace_owner_id = $3`,
      [publicKey, bannerId, ownerId],
    );
    return publicKey;
  } catch (err) {
    logger.error({ err, bannerId, field }, "Failed to copy banner media to public bucket");
    return null;
  }
}

/**
 * After a banner create/update, keep every public media copy in sync with the
 * stored private URLs: copy private objects into the public bucket, and clear
 * stale public keys when a field is now empty or an external URL. Best-effort.
 */
async function syncBannerPublicMedia(row: BannerRow): Promise<void> {
  await Promise.all(
    (Object.keys(BANNER_MEDIA_FIELDS) as BannerMediaField[]).map(async (field) => {
      const { urlCol, publicCol } = BANNER_MEDIA_FIELDS[field];
      const storedUrl = row[urlCol] as string | null;
      if (isPrivateObjectPath(storedUrl)) {
        const publicKey = await ensureBannerFieldPublicKey(
          row.id,
          row.workspace_owner_id,
          field,
          storedUrl,
        );
        // Normalize the stored URL column itself to the absolute public URL so a
        // private `/objects/...` path is never persisted as the saved media URL
        // (the admin dashboard and any client now read a loadable online link).
        // Guarded on the value still equalling the private path to avoid
        // clobbering a concurrent edit. Best-effort: on copy/update failure the
        // private path remains and is still resolved publicly at read time.
        const publicUrl = buildPublicObjectUrl(publicKey);
        if (publicUrl) {
          try {
            await db.query(
              `UPDATE homepage_banners SET ${urlCol} = $1 WHERE id = $2 AND workspace_owner_id = $3 AND ${urlCol} = $4`,
              [publicUrl, row.id, row.workspace_owner_id, storedUrl],
            );
          } catch (err) {
            logger.error(
              { err, bannerId: row.id, field },
              "Failed to normalize banner media url to public",
            );
          }
        }
      } else {
        try {
          await db.query(
            `UPDATE homepage_banners SET ${publicCol} = NULL WHERE id = $1 AND workspace_owner_id = $2`,
            [row.id, row.workspace_owner_id],
          );
        } catch (err) {
          logger.error({ err, bannerId: row.id, field }, "Failed to clear banner public path");
        }
      }
    }),
  );
}

/**
 * Resolve a banner media field to an absolute URL the public storefront can
 * load directly. Prefers the stored public key; falls back to passing through
 * external http(s) URLs; for legacy banners with only a private object path it
 * lazily copies to the public bucket (persisting the key for next time).
 */
async function resolveStorefrontMediaUrl(
  row: BannerRow,
  field: BannerMediaField,
): Promise<string | null> {
  const { urlCol, publicCol } = BANNER_MEDIA_FIELDS[field];
  const existingPublic = row[publicCol as keyof BannerRow] as string | null;
  if (existingPublic) return buildPublicObjectUrl(existingPublic);

  const stored = row[urlCol] as string | null;
  if (!stored) return null;
  if (/^https?:\/\//i.test(stored)) return stored;
  if (isPrivateObjectPath(stored)) {
    const key = await ensureBannerFieldPublicKey(row.id, row.workspace_owner_id, field, stored);
    return key ? buildPublicObjectUrl(key) : null;
  }
  return null;
}

/**
 * Resolve the workspace that powers the public storefront.
 *
 * Resolution order (per Task #2510):
 *   1. The DB-backed `storefront_config` singleton, set by an owner from the
 *      dashboard Settings page. This is the primary source so a non-technical
 *      owner can connect the storefront without a deploy-time secret.
 *   2. Fall back to the `STOREFRONT_WORKSPACE_OWNER_ID` env var (backward
 *      compatible) only when the setting is absent.
 *
 * SECURITY: the workspace is always resolved fully server-side. No workspace
 * identifier is ever accepted from the public caller, preventing cross-tenant
 * enumeration via the no-auth storefront endpoint.
 */
export async function resolveStorefrontWorkspaceOwnerId(): Promise<{
  ownerId: string | null;
  source: "setting" | "env" | null;
}> {
  try {
    const r = await db.query<{ workspace_owner_id: string | null }>(
      `SELECT workspace_owner_id FROM storefront_config WHERE id = 1`,
    );
    const fromDb = r.rows[0]?.workspace_owner_id ?? null;
    if (fromDb) return { ownerId: fromDb, source: "setting" };
  } catch (err) {
    logger.error({ err }, "resolveStorefrontWorkspaceOwnerId: storefront_config lookup failed");
  }
  const env = process.env.STOREFRONT_WORKSPACE_OWNER_ID;
  if (env) return { ownerId: env, source: "env" };
  return { ownerId: null, source: null };
}

// ---------------------------------------------------------------------------
// Public storefront endpoint — NO auth.
// ---------------------------------------------------------------------------
router.get("/storefront/homepage-banners", async (req: Request, res: Response) => {
  // SECURITY: workspace scope is determined SERVER-SIDE (DB setting, then env).
  // We deliberately do NOT accept any workspace identifier from public callers,
  // to prevent cross-tenant enumeration via this no-auth endpoint.
  const querySchema = z.object({
    countryCode: z.string().min(1),
    cityId: z.coerce.number().int().positive().optional(),
    device: z.enum(["desktop", "mobile"]),
  });
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid query" });
    return;
  }
  const { countryCode, cityId, device } = parsed.data;
  const { ownerId: workspaceId } = await resolveStorefrontWorkspaceOwnerId();
  if (!workspaceId) {
    res.status(500).json({
      error:
        "Storefront workspace not configured: connect a workspace from Settings or set STOREFRONT_WORKSPACE_OWNER_ID",
    });
    return;
  }
  const enabledCol = device === "desktop" ? "desktop_enabled" : "mobile_enabled";

  // Country matching is format-agnostic: the storefront may send an ISO alpha-2
  // code (e.g. `LB`) while the admin UI saved a full name (e.g. `Lebanon`), or
  // vice-versa. We resolve the caller's country to all known string variants
  // and compare against each stored value normalized (lowercased + trimmed) so
  // a banner matches regardless of code-vs-name format, case, or whitespace.
  const countryCandidates = buildCountryMatchCandidates(countryCode);

  // CRITICAL: scope to a single workspace to prevent cross-tenant leakage.
  // Schedule comparison uses now() against timestamptz columns: this is
  // already timezone-correct in absolute time. The banner.timezone column
  // documents how admins entered the wall-clock values; conversion to UTC
  // happens client-side at write time.
  const result = await db.query<BannerRow>(
    `SELECT * FROM homepage_banners
       WHERE workspace_owner_id = $1
         AND is_active = true
         AND ${enabledCol} = true
         AND EXISTS (
           SELECT 1 FROM unnest(country_codes) AS cc
           WHERE lower(btrim(cc)) = ANY($2::text[])
         )
         AND (start_at IS NULL OR start_at <= now())
         AND (end_at IS NULL OR end_at >= now())
         AND (
           is_global_for_country = true
           OR ($3::int IS NOT NULL AND $3 = ANY(city_ids))
         )
       ORDER BY sort_order ASC, priority ASC, created_at DESC`,
    [workspaceId, countryCandidates, cityId ?? null],
  );

  const isDesktop = device === "desktop";
  const mediaField: BannerMediaField = isDesktop ? "desktop_media" : "mobile_media";
  const fallbackField: BannerMediaField = isDesktop ? "desktop_fallback" : "mobile_fallback";

  // Resolve display names for structured link targets in two batched queries
  // (one per attribute kind), scoped to the storefront workspace. The slug is
  // already stored on the banner; only the human-readable name needs a lookup.
  const linkNames = await resolveBannerLinkNames(workspaceId, result.rows);

  const items = await Promise.all(
    result.rows.map(async (row) => {
      const [mediaUrl, fallbackUrl] = await Promise.all([
        resolveStorefrontMediaUrl(row, mediaField),
        resolveStorefrontMediaUrl(row, fallbackField),
      ]);
      const legacyLinkUrl = isDesktop ? row.desktop_link_url : row.mobile_link_url;
      const hasStructuredLink = !!row.link_kind && !!row.link_slug;
      return {
        id: row.id,
        internal_name: row.internal_name,
        title: row.title,
        headline: row.headline,
        subtitle: row.subtitle,
        cta_text: row.cta_text,
        country_codes: row.country_codes,
        city_ids: row.city_ids,
        is_global_for_country: row.is_global_for_country,
        device,
        media_type: isDesktop ? row.desktop_media_type : row.mobile_media_type,
        media_url: mediaUrl,
        fallback_image_url: fallbackUrl,
        // Structured link target. The website builds the destination URL from
        // link_kind + link_slug; link_name is the human-readable label.
        link_kind: hasStructuredLink ? row.link_kind : null,
        link_slug: hasStructuredLink ? row.link_slug : null,
        link_name: hasStructuredLink ? (linkNames.get(row.id) ?? null) : null,
        // Legacy free-text URL, kept for backward compatibility. Populated only
        // when no structured link target is set on the banner.
        link_url: hasStructuredLink ? null : legacyLinkUrl,
        sort_order: row.sort_order,
        priority: row.priority,
        start_at: row.start_at?.toISOString() ?? null,
        end_at: row.end_at?.toISOString() ?? null,
      };
    }),
  );

  res.json({ banners: items });
});

// ---------------------------------------------------------------------------
// Admin endpoints — require auth, workspace, and the homepage_banners.manage permission.
// ---------------------------------------------------------------------------

function requireBannersPermission(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const wreq = workspace(req);
  if (wreq.workspaceRole === "owner") {
    next();
    return;
  }
  const allowed = wreq.allowedPages;
  if (allowed === null || allowed.includes("homepage_banners.manage")) {
    next();
    return;
  }
  res.status(403).json({ error: "Missing homepage_banners.manage permission" });
}

const ADMIN_BASE = "/admin/homepage-banners";

router.get(
  ADMIN_BASE,
  requireAuth,
  resolveWorkspace,
  requireBannersPermission,
  async (req, res) => {
    const wreq = workspace(req);
    const result = await db.query<BannerRow>(
      `SELECT * FROM homepage_banners
         WHERE workspace_owner_id = $1
         ORDER BY sort_order ASC, priority ASC, created_at DESC`,
      [wreq.workspaceOwnerId],
    );
    res.json({ banners: result.rows.map(serializeBanner) });
  },
);

router.get(
  `${ADMIN_BASE}/:id`,
  requireAuth,
  resolveWorkspace,
  requireBannersPermission,
  async (req, res) => {
    const wreq = workspace(req);
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const result = await db.query<BannerRow>(
      `SELECT * FROM homepage_banners WHERE id = $1 AND workspace_owner_id = $2`,
      [id, wreq.workspaceOwnerId],
    );
    if (result.rowCount === 0) {
      res.status(404).json({ error: "Banner not found" });
      return;
    }
    res.json({ banner: serializeBanner(result.rows[0]) });
  },
);

router.post(
  ADMIN_BASE,
  requireAuth,
  resolveWorkspace,
  requireBannersPermission,
  async (req, res) => {
    const wreq = workspace(req);
    const parsed = BannerInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: parsed.error.issues[0]?.message ?? "Invalid input", issues: parsed.error.issues });
      return;
    }
    const d = parsed.data;
    const cityIds = d.is_global_for_country ? [] : (d.city_ids ?? []);
    const activatedAt = d.is_active ? new Date() : null;
    const userKey = wreq.userEmail ?? wreq.userId;

    let link: { link_kind: string | null; link_attribute_id: number | null; link_slug: string | null };
    try {
      link = await resolveBannerLinkTarget(wreq.workspaceOwnerId, d.link_kind, d.link_attribute_id);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "Invalid link target" });
      return;
    }

    const result = await db.query<BannerRow>(
      `INSERT INTO homepage_banners (
         workspace_owner_id, internal_name, title, headline, subtitle, cta_text,
         country_codes, city_ids, is_global_for_country, languages,
         desktop_enabled, desktop_media_type, desktop_media_url, desktop_fallback_url, desktop_link_url,
         mobile_enabled, mobile_media_type, mobile_media_url, mobile_fallback_url, mobile_link_url,
         link_kind, link_attribute_id, link_slug,
         destination_type, destination_value,
         start_at, end_at, timezone, sort_order, priority, is_active, activated_at,
         created_by, updated_by
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9, $10,
         $11, $12, $13, $14, $15,
         $16, $17, $18, $19, $20,
         $21, $22, $23,
         $24, $25,
         $26, $27, $28, $29, $30, $31, $32,
         $33, $33
       )
       RETURNING *`,
      [
        wreq.workspaceOwnerId,
        d.internal_name,
        d.title ?? null,
        d.headline ?? null,
        d.subtitle ?? null,
        d.cta_text ?? null,
        d.country_codes,
        cityIds,
        d.is_global_for_country ?? false,
        d.languages ?? ["en", "ar"],
        d.desktop.enabled,
        d.desktop.media_type ?? null,
        d.desktop.media_url ?? null,
        d.desktop.fallback_image_url ?? null,
        d.desktop.link_url ?? null,
        d.mobile.enabled,
        d.mobile.media_type ?? null,
        d.mobile.media_url ?? null,
        d.mobile.fallback_image_url ?? null,
        d.mobile.link_url ?? null,
        link.link_kind,
        link.link_attribute_id,
        link.link_slug,
        d.destination_type ?? null,
        d.destination_value ?? null,
        d.start_at ?? null,
        d.end_at ?? null,
        d.timezone,
        d.sort_order ?? 0,
        d.priority ?? 0,
        d.is_active ?? false,
        activatedAt,
        userKey,
      ],
    );
    await syncBannerPublicMedia(result.rows[0]);
    void fireCatalogDataWebhook("catalog.banners.changed", wreq.workspaceOwnerId, { action: "created", banner_id: result.rows[0].id });
    void fireBannerUpdated(wreq.workspaceOwnerId);
    res.status(201).json({ banner: serializeBanner(result.rows[0]) });
  },
);

router.put(
  `${ADMIN_BASE}/:id`,
  requireAuth,
  resolveWorkspace,
  requireBannersPermission,
  async (req, res) => {
    const wreq = workspace(req);
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const parsed = BannerInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: parsed.error.issues[0]?.message ?? "Invalid input", issues: parsed.error.issues });
      return;
    }
    const d = parsed.data;
    const cityIds = d.is_global_for_country ? [] : (d.city_ids ?? []);
    const userKey = wreq.userEmail ?? wreq.userId;

    let link: { link_kind: string | null; link_attribute_id: number | null; link_slug: string | null };
    try {
      link = await resolveBannerLinkTarget(wreq.workspaceOwnerId, d.link_kind, d.link_attribute_id);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "Invalid link target" });
      return;
    }

    const result = await db.query<BannerRow>(
      `UPDATE homepage_banners SET
         internal_name = $3,
         title = $4,
         headline = $5,
         subtitle = $6,
         cta_text = $7,
         country_codes = $8,
         city_ids = $9,
         is_global_for_country = $10,
         languages = $11,
         desktop_enabled = $12,
         desktop_media_type = $13,
         desktop_media_url = $14,
         desktop_fallback_url = $15,
         desktop_link_url = $16,
         mobile_enabled = $17,
         mobile_media_type = $18,
         mobile_media_url = $19,
         mobile_fallback_url = $20,
         mobile_link_url = $21,
         link_kind = $22,
         link_attribute_id = $23,
         link_slug = $24,
         destination_type = $25,
         destination_value = $26,
         start_at = $27,
         end_at = $28,
         timezone = $29,
         sort_order = $30,
         priority = $31,
         is_active = $32,
         status_override = CASE
           WHEN $32 = true AND status_override = 'paused' THEN NULL
           ELSE status_override
         END,
         activated_at = CASE
           WHEN $32 = true AND activated_at IS NULL THEN now()
           ELSE activated_at
         END,
         updated_by = $33,
         updated_at = now()
       WHERE id = $1 AND workspace_owner_id = $2
       RETURNING *`,
      [
        id,
        wreq.workspaceOwnerId,
        d.internal_name,
        d.title ?? null,
        d.headline ?? null,
        d.subtitle ?? null,
        d.cta_text ?? null,
        d.country_codes,
        cityIds,
        d.is_global_for_country ?? false,
        d.languages ?? ["en", "ar"],
        d.desktop.enabled,
        d.desktop.media_type ?? null,
        d.desktop.media_url ?? null,
        d.desktop.fallback_image_url ?? null,
        d.desktop.link_url ?? null,
        d.mobile.enabled,
        d.mobile.media_type ?? null,
        d.mobile.media_url ?? null,
        d.mobile.fallback_image_url ?? null,
        d.mobile.link_url ?? null,
        link.link_kind,
        link.link_attribute_id,
        link.link_slug,
        d.destination_type ?? null,
        d.destination_value ?? null,
        d.start_at ?? null,
        d.end_at ?? null,
        d.timezone,
        d.sort_order ?? 0,
        d.priority ?? 0,
        d.is_active ?? false,
        userKey,
      ],
    );
    if (result.rowCount === 0) {
      res.status(404).json({ error: "Banner not found" });
      return;
    }
    await syncBannerPublicMedia(result.rows[0]);
    void fireCatalogDataWebhook("catalog.banners.changed", wreq.workspaceOwnerId, { action: "updated", banner_id: id });
    void fireBannerUpdated(wreq.workspaceOwnerId);
    res.json({ banner: serializeBanner(result.rows[0]) });
  },
);

router.delete(
  `${ADMIN_BASE}/:id`,
  requireAuth,
  resolveWorkspace,
  requireBannersPermission,
  async (req, res) => {
    const wreq = workspace(req);
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const result = await db.query(
      `DELETE FROM homepage_banners WHERE id = $1 AND workspace_owner_id = $2`,
      [id, wreq.workspaceOwnerId],
    );
    if (result.rowCount === 0) {
      res.status(404).json({ error: "Banner not found" });
      return;
    }
    void fireCatalogDataWebhook("catalog.banners.changed", wreq.workspaceOwnerId, { action: "deleted", banner_id: id });
    void fireBannerUpdated(wreq.workspaceOwnerId);
    res.status(204).end();
  },
);

router.post(
  `${ADMIN_BASE}/:id/duplicate`,
  requireAuth,
  resolveWorkspace,
  requireBannersPermission,
  async (req, res) => {
    const wreq = workspace(req);
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const userKey = wreq.userEmail ?? wreq.userId;
    const result = await db.query<BannerRow>(
      `INSERT INTO homepage_banners (
         workspace_owner_id, internal_name, title, headline, subtitle, cta_text,
         country_codes, city_ids, is_global_for_country, languages,
         desktop_enabled, desktop_media_type, desktop_media_url, desktop_fallback_url, desktop_link_url,
         mobile_enabled, mobile_media_type, mobile_media_url, mobile_fallback_url, mobile_link_url,
         link_kind, link_attribute_id, link_slug,
         destination_type, destination_value,
         start_at, end_at, timezone, sort_order, priority,
         is_active, activated_at, created_by, updated_by
       )
       SELECT
         workspace_owner_id, 'Copy of ' || internal_name, title, headline, subtitle, cta_text,
         country_codes, city_ids, is_global_for_country, languages,
         desktop_enabled, desktop_media_type, desktop_media_url, desktop_fallback_url, desktop_link_url,
         mobile_enabled, mobile_media_type, mobile_media_url, mobile_fallback_url, mobile_link_url,
         link_kind, link_attribute_id, link_slug,
         destination_type, destination_value,
         start_at, end_at, timezone, sort_order, priority,
         false, NULL, $3, $3
       FROM homepage_banners
       WHERE id = $1 AND workspace_owner_id = $2
       RETURNING *`,
      [id, wreq.workspaceOwnerId, userKey],
    );
    if (result.rowCount === 0) {
      res.status(404).json({ error: "Banner not found" });
      return;
    }
    await syncBannerPublicMedia(result.rows[0]);
    void fireCatalogDataWebhook("catalog.banners.changed", wreq.workspaceOwnerId, { action: "duplicated", banner_id: result.rows[0].id });
    void fireBannerUpdated(wreq.workspaceOwnerId);
    res.status(201).json({ banner: serializeBanner(result.rows[0]) });
  },
);

router.post(
  `${ADMIN_BASE}/:id/activate`,
  requireAuth,
  resolveWorkspace,
  requireBannersPermission,
  async (req, res) => {
    const wreq = workspace(req);
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const userKey = wreq.userEmail ?? wreq.userId;
    const result = await db.query<BannerRow>(
      `UPDATE homepage_banners SET
         is_active = true,
         activated_at = COALESCE(activated_at, now()),
         updated_by = $3,
         updated_at = now()
       WHERE id = $1 AND workspace_owner_id = $2
       RETURNING *`,
      [id, wreq.workspaceOwnerId, userKey],
    );
    if (result.rowCount === 0) {
      res.status(404).json({ error: "Banner not found" });
      return;
    }
    void fireCatalogDataWebhook("catalog.banners.changed", wreq.workspaceOwnerId, { action: "activated", banner_id: id });
    void fireBannerUpdated(wreq.workspaceOwnerId);
    res.json({ banner: serializeBanner(result.rows[0]) });
  },
);

router.post(
  `${ADMIN_BASE}/:id/deactivate`,
  requireAuth,
  resolveWorkspace,
  requireBannersPermission,
  async (req, res) => {
    const wreq = workspace(req);
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const userKey = wreq.userEmail ?? wreq.userId;
    const result = await db.query<BannerRow>(
      `UPDATE homepage_banners SET
         is_active = false,
         updated_by = $3,
         updated_at = now()
       WHERE id = $1 AND workspace_owner_id = $2
       RETURNING *`,
      [id, wreq.workspaceOwnerId, userKey],
    );
    if (result.rowCount === 0) {
      res.status(404).json({ error: "Banner not found" });
      return;
    }
    void fireCatalogDataWebhook("catalog.banners.changed", wreq.workspaceOwnerId, { action: "deactivated", banner_id: id });
    void fireBannerUpdated(wreq.workspaceOwnerId);
    res.json({ banner: serializeBanner(result.rows[0]) });
  },
);

router.post(
  `${ADMIN_BASE}/:id/pause`,
  requireAuth,
  resolveWorkspace,
  requireBannersPermission,
  async (req, res) => {
    const wreq = workspace(req);
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const userKey = wreq.userEmail ?? wreq.userId;
    const result = await db.query<BannerRow>(
      `UPDATE homepage_banners SET
         status_override = 'paused',
         is_active = false,
         updated_by = $3,
         updated_at = now()
       WHERE id = $1 AND workspace_owner_id = $2
       RETURNING *`,
      [id, wreq.workspaceOwnerId, userKey],
    );
    if (result.rowCount === 0) {
      res.status(404).json({ error: "Banner not found" });
      return;
    }
    void fireCatalogDataWebhook("catalog.banners.changed", wreq.workspaceOwnerId, { action: "paused", banner_id: id });
    void fireBannerUpdated(wreq.workspaceOwnerId);
    res.json({ banner: serializeBanner(result.rows[0]) });
  },
);

router.post(
  `${ADMIN_BASE}/:id/resume`,
  requireAuth,
  resolveWorkspace,
  requireBannersPermission,
  async (req, res) => {
    const wreq = workspace(req);
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const userKey = wreq.userEmail ?? wreq.userId;
    const result = await db.query<BannerRow>(
      `UPDATE homepage_banners SET
         status_override = NULL,
         is_active = true,
         activated_at = COALESCE(activated_at, now()),
         updated_by = $3,
         updated_at = now()
       WHERE id = $1 AND workspace_owner_id = $2
       RETURNING *`,
      [id, wreq.workspaceOwnerId, userKey],
    );
    if (result.rowCount === 0) {
      res.status(404).json({ error: "Banner not found" });
      return;
    }
    void fireCatalogDataWebhook("catalog.banners.changed", wreq.workspaceOwnerId, { action: "resumed", banner_id: id });
    void fireBannerUpdated(wreq.workspaceOwnerId);
    res.json({ banner: serializeBanner(result.rows[0]) });
  },
);

// ---------------------------------------------------------------------------
// Batch reorder banners — updates sort_order for all supplied ids.
// ---------------------------------------------------------------------------

router.patch(
  `${ADMIN_BASE}/reorder`,
  requireAuth,
  resolveWorkspace,
  requireBannersPermission,
  async (req, res) => {
    const wreq = workspace(req);
    const BodySchema = z.object({
      items: z
        .array(
          z.object({
            id: z.number().int().positive(),
            sort_order: z.number().int(),
          }),
        )
        .min(1)
        .max(200),
    });
    const parsed = BodySchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
      return;
    }
    const { items } = parsed.data;
    const ids = items.map((i) => i.id);
    const orders = items.map((i) => i.sort_order);
    await db.query(
      `UPDATE homepage_banners
         SET sort_order = data.sort_order,
             priority   = data.sort_order,
             updated_at = now()
         FROM unnest($1::int[], $2::int[]) AS data(id, sort_order)
         WHERE homepage_banners.id = data.id
           AND homepage_banners.workspace_owner_id = $3`,
      [ids, orders, wreq.workspaceOwnerId],
    );
    void fireBannerUpdated(wreq.workspaceOwnerId);
    res.json({ ok: true });
  },
);

// ---------------------------------------------------------------------------
// Storefront workspace connection — owner-only.
//
// Lets a workspace owner mark THEIR workspace as the public storefront
// workspace (the one whose banners the public website shows), persisted in the
// `storefront_config` singleton. This removes the dependency on the deploy-time
// STOREFRONT_WORKSPACE_OWNER_ID secret. See resolveStorefrontWorkspaceOwnerId.
// ---------------------------------------------------------------------------

function requireOwner(req: Request, res: Response, next: NextFunction): void {
  if (workspace(req).workspaceRole !== "owner") {
    res.status(403).json({ error: "owner_only" });
    return;
  }
  next();
}

async function buildStorefrontStatus(currentOwnerId: string): Promise<{
  connected: boolean;
  configured_via: "setting" | "env" | null;
  is_current_workspace: boolean;
}> {
  const { ownerId, source } = await resolveStorefrontWorkspaceOwnerId();
  return {
    connected: ownerId !== null,
    configured_via: source,
    is_current_workspace: ownerId !== null && ownerId === currentOwnerId,
  };
}

const STOREFRONT_WORKSPACE_PATH = "/admin/storefront-workspace";

router.get(
  STOREFRONT_WORKSPACE_PATH,
  requireAuth,
  resolveWorkspace,
  requireOwner,
  async (req, res) => {
    const wreq = workspace(req);
    res.json(await buildStorefrontStatus(wreq.workspaceOwnerId));
  },
);

router.put(
  STOREFRONT_WORKSPACE_PATH,
  requireAuth,
  resolveWorkspace,
  requireOwner,
  async (req, res) => {
    const wreq = workspace(req);
    const userKey = wreq.userEmail ?? wreq.userId ?? null;
    await db.query(
      `INSERT INTO storefront_config (id, workspace_owner_id, updated_by, updated_at)
         VALUES (1, $1, $2, now())
       ON CONFLICT (id) DO UPDATE
         SET workspace_owner_id = EXCLUDED.workspace_owner_id,
             updated_by = EXCLUDED.updated_by,
             updated_at = now()`,
      [wreq.workspaceOwnerId, userKey],
    );
    res.json(await buildStorefrontStatus(wreq.workspaceOwnerId));
  },
);

router.delete(
  STOREFRONT_WORKSPACE_PATH,
  requireAuth,
  resolveWorkspace,
  requireOwner,
  async (req, res) => {
    const wreq = workspace(req);
    const userKey = wreq.userEmail ?? wreq.userId ?? null;
    // Only clear when THIS workspace is the connected storefront, so one owner
    // can never disconnect another workspace's storefront. (Cannot clear an
    // env-var fallback; that remains a deploy-time concern.)
    await db.query(
      `UPDATE storefront_config
          SET workspace_owner_id = NULL, updated_by = $2, updated_at = now()
        WHERE id = 1 AND workspace_owner_id = $1`,
      [wreq.workspaceOwnerId, userKey],
    );
    res.json(await buildStorefrontStatus(wreq.workspaceOwnerId));
  },
);

export default router;
