/**
 * Address Book router — Places, aliases, contact addresses, order links,
 * and fleet read-only endpoint. Mounted at /api/address-book in index.ts.
 *
 * Verification states (enforced at DB level via place_verification_state enum):
 *   unverified → ai_verified → staff_verified → delivery_verified
 *
 * Immutability rule: orders.delivery_address is NEVER mutated here; only the
 * order_place_links join table is written.
 */
import { Router, type Request, type Response } from "express";
import type pg from "pg";
import { z } from "zod";
import { db, withTransaction } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace, type WorkspaceRequest } from "../lib/workspace";
import { logger } from "../lib/logger";
import { requireDriverToken, driverAuthed } from "../lib/driverTokenAuth";
import { runBackfill } from "../jobs/addressBookBackfill";
import { runTranslationBackfill } from "../jobs/addressBookTranslationBackfill";
import {
  assessAndGeocode,
  normalizePlaceName,
  qualifySharedAlias,
  resolveOrderDeliveryContacts,
  stringSimilarity,
  syncOrderDeliveryContactPlaceLinks,
  type SharedAliasSource,
} from "../lib/addressBookAutoLink";
import { detectScript, translateAddressToEnglish } from "../lib/translation";
import { classifyPlaceType, isAccommodationPlaceName } from "@workspace/api-zod/place-types";
import { checkPlaceLocationConflict } from "../lib/placeConflictChecker.js";
import { assessPlaceValidity, geocodeAddress } from "../lib/placeAiAssessor.js";
import {
  enqueueAddressReverificationRun,
  getAddressReverificationRun,
  processPendingAddressReverificationJobs,
} from "../lib/addressReverificationJob.js";
import { auditExistingAiVerifiedPlaces } from "../lib/addressBookAccuracyAudit.js";
import {
  autocompleteGooglePlaces,
  diagnoseMapProviders,
  getGooglePlaceCountryCode,
  getGooglePlaceDetails,
  MapProviderError,
} from "../lib/mapProvider.js";
import { resolveTrustedPlaceGeography } from "../lib/placeGeography.js";

const router = Router();

type TranslatedAddressField = {
  value: string | null | undefined;
  original: string | null;
};

/**
 * Translate an Address Book text field when it is Arabic. The translation
 * helper intentionally fails open, so a failed translation keeps the text
 * exactly as entered instead of silently dropping it.
 */
async function translateAddressField(
  value: string | null | undefined,
  workspaceOwnerId?: string,
): Promise<TranslatedAddressField> {
  if (value == null) return { value, original: null };

  const translated = await translateAddressToEnglish(value, { workspaceOwnerId });
  const usableTranslation =
    translated && detectScript(translated) !== "arabic" ? translated : null;
  return {
    value: usableTranslation ?? value,
    original: usableTranslation ? value : null,
  };
}

async function insertTranslatedPlaceAlias(
  placeId: string,
  originalText: string,
  query: (sql: string, params: unknown[]) => Promise<unknown>,
): Promise<void> {
  const normalizedOriginal = normalizePlaceName(originalText);
  if (!normalizedOriginal) return;

  await query(
    `INSERT INTO place_aliases
       (place_id, alias_text, normalized_alias, language, source, approval_state)
     VALUES ($1, $2, $3, 'ar', 'approved_transliteration', 'approved')
     ON CONFLICT (place_id, normalized_alias) DO NOTHING`,
    [placeId, originalText, normalizedOriginal],
  );
}

// Warn once at startup if the Google Places server key is missing so ops can
// diagnose misconfigured environments without needing a live search attempt.
if (!process.env.GOOGLE_PLACES_SERVER_KEY) {
  logger.warn("GOOGLE_PLACES_SERVER_KEY is not set — Google Places search will be unavailable");
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

/**
 * Normalize an alias string:
 * - Lowercase
 * - Collapse multiple whitespace chars to a single space
 * - Strip ASCII punctuation (but preserve Arabic/French script characters)
 */
const VERIFICATION_STATES = [
  "unverified",
  "estimated",
  "ai_verified",
  "staff_verified",
  "delivery_verified",
] as const;
type VerificationState = (typeof VERIFICATION_STATES)[number];

function isVerificationState(s: string): s is VerificationState {
  return (VERIFICATION_STATES as readonly string[]).includes(s);
}

/** Guard: only workspace owners can mutate places. Members get 403. */
function requireOwner(wreq: WorkspaceRequest, res: Response): boolean {
  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Only workspace owners may perform this action" });
    return false;
  }
  return true;
}

/** Haversine great-circle distance between two coordinates, in kilometres. */
function haversineDistanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Non-blocking helper: reverse-geocode a place's current coordinates and
 * persist the locality-conflict result to `places.location_conflict`.
 * Appends a verification event only when the flag changes value.
 * Never throws — all errors are logged as warnings.
 */
async function refreshLocationConflict(placeId: string, workspaceOwnerId: string): Promise<void> {
  try {
    const r = await db.query<{
      latitude: string | null;
      longitude: string | null;
      city_name: string | null;
      country_code: string | null;
      area: string | null;
      location_conflict: boolean;
      verification_state: string;
    }>(
      `SELECT p.latitude, p.longitude, p.area, p.location_conflict, p.verification_state,
              dc.name AS city_name, dc.country_code
         FROM places p
         LEFT JOIN delivery_cities dc ON dc.id = p.city_id
        WHERE p.id = $1 AND p.workspace_owner_id = $2 AND p.archived_at IS NULL`,
      [placeId, workspaceOwnerId],
    );
    const row = r.rows[0];
    if (!row || row.latitude == null || row.longitude == null) return;

    const result = await checkPlaceLocationConflict({
      latitude: parseFloat(row.latitude),
      longitude: parseFloat(row.longitude),
      cityName: row.city_name,
      countryCode: row.country_code,
      area: row.area,
    });

    const prevConflict = row.location_conflict;
    await db.query(
      `UPDATE places SET location_conflict = $1, updated_at = now()
        WHERE id = $2 AND workspace_owner_id = $3`,
      [result.conflict, placeId, workspaceOwnerId],
    );

    // Append event only when the conflict flag actually changes
    if (result.conflict !== prevConflict) {
      const eventType = result.conflict ? "location_conflict_detected" : "location_conflict_cleared";
      await db.query(
        `INSERT INTO place_verification_events
           (place_id, event_type, from_state, to_state, source, notes)
         VALUES ($1, $2, $3::place_verification_state, $3::place_verification_state, 'system', $4)`,
        [placeId, eventType, row.verification_state, result.explanation],
      );
    }
  } catch (err) {
    logger.warn({ err, placeId }, "refreshLocationConflict: failed (non-fatal)");
  }
}

// ── Middleware ────────────────────────────────────────────────────────────────

// All /address-book routes (except the fleet lean endpoint) require Clerk auth
// and workspace resolution.
router.use(
  [
    "/address-book",
    "/contact-addresses",
    "/order-links",
  ],
  requireAuth,
  resolveWorkspace,
);

// ── Place list ────────────────────────────────────────────────────────────────

const PLACE_SORTABLE: Record<string, string> = {
  created_at: "p.created_at",
  updated_at: "p.updated_at",
  canonical_name: "p.canonical_name",
  area: "p.area",
  verification_state: "p.verification_state",
};

/**
 * GET /api/address-book/places
 * Paginated list with search (name/alias/area/contact/phone),
 * filters (area, verification_state, type), tabs (all/needs-review/duplicates/recently-delivered),
 * and summary card counts.
 */
router.get("/address-book/places", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);
  const page = Math.max(1, parseInt((req.query.page as string) || "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt((req.query.limit as string) || "50", 10)));
  const offset = (page - 1) * limit;
  // The dashboard uses `q`, while `search` is the documented API parameter.
  // Prefer the dashboard value when both are present, but keep the API
  // parameter working for existing callers.
  const searchQuery =
    typeof req.query.q === "string"
      ? req.query.q
      : typeof req.query.search === "string"
        ? req.query.search
        : "";
  const search = searchQuery.trim();
  const sortKey = ((req.query.sort as string) || "created_at").toLowerCase();
  const sortDir = ((req.query.dir as string) || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  const sortCol = PLACE_SORTABLE[sortKey] ?? PLACE_SORTABLE.created_at;
  const filterArea = ((req.query.area as string) || "").trim();
  const filterState = (
    (req.query.verification_state as string) ||
    (req.query.verification as string) ||
    ""
  ).trim();
  const filterType = ((req.query.type as string) || "").trim();
  const tab = ((req.query.tab as string) || "all").trim().toLowerCase().replace(/_/g, "-");

  const conds: string[] = [
    "p.workspace_owner_id = $1",
    "p.archived_at IS NULL",
  ];
  const params: unknown[] = [wreq.workspaceOwnerId];
  let idx = 2;

  if (filterArea) {
    conds.push(`lower(p.area) = lower($${idx})`);
    params.push(filterArea);
    idx++;
  }

  if (filterState && isVerificationState(filterState)) {
    conds.push(`p.verification_state = $${idx}::place_verification_state`);
    params.push(filterState);
    idx++;
  }

  if (filterType) {
    conds.push(`p.place_type = $${idx}`);
    params.push(filterType);
    idx++;
  }

  // Tab filters
  if (tab === "needs-review") {
    conds.push(`p.verification_state = 'unverified'`);
  } else if (tab === "recently-delivered") {
    conds.push(`EXISTS (
      SELECT 1 FROM order_place_links opl
       WHERE opl.place_id = p.id
         AND opl.linked_at >= now() - INTERVAL '30 days'
    )`);
  } else if (tab === "duplicates") {
    // Candidate duplicates: places with very similar canonical names (lowercased)
    conds.push(`EXISTS (
      SELECT 1 FROM places p2
       WHERE p2.workspace_owner_id = p.workspace_owner_id
         AND p2.id <> p.id
         AND p2.archived_at IS NULL
         AND lower(p2.canonical_name) = lower(p.canonical_name)
    )`);
  }

  if (search) {
    const like = `%${search.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    conds.push(`(
      p.canonical_name ILIKE $${idx} ESCAPE '\\'
      OR p.area ILIKE $${idx} ESCAPE '\\'
      OR EXISTS (
        SELECT 1 FROM place_aliases pa
         WHERE pa.place_id = p.id AND pa.deleted_at IS NULL
           AND pa.alias_text ILIKE $${idx} ESCAPE '\\'
      )
      OR EXISTS (
        SELECT 1 FROM contact_addresses ca
          JOIN contacts c ON c.id = ca.contact_id
         WHERE ca.place_id = p.id AND ca.archived_at IS NULL
           AND (
             c.display_name ILIKE $${idx} ESCAPE '\\'
             OR c.first_name ILIKE $${idx} ESCAPE '\\'
             OR c.last_name ILIKE $${idx} ESCAPE '\\'
             OR c.phone ILIKE $${idx} ESCAPE '\\'
           )
      )
    )`);
    params.push(like);
    idx++;
  }

  const where = conds.join(" AND ");

  const [rowsRes, countRes, summaryRes] = await Promise.all([
    db.query<{
      id: string;
      canonical_name: string;
      place_type: string;
      area: string | null;
      city_id: number | null;
      city_name: string | null;
      canonical_address: string | null;
      latitude: string | null;
      longitude: string | null;
      entrance_notes: string | null;
      verification_state: string;
      ai_invalid: boolean | null;
       checkout_ready: boolean;
       location_conflict: boolean;
      delivery_count: string;
      alias_count: string;
      contact_count: string;
       last_delivered_at: string | null;
       verified_at: string | null;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT
         p.id, p.canonical_name, p.place_type, p.area, p.city_id,
         dc.name AS city_name,
         p.canonical_address, p.latitude, p.longitude, p.entrance_notes,
         p.verification_state, p.ai_invalid, p.created_at, p.updated_at,
          p.checkout_ready, p.location_conflict, p.verified_at,
         (SELECT COUNT(*) FROM order_place_links opl WHERE opl.place_id = p.id)::text AS delivery_count,
         (SELECT COUNT(*) FROM place_aliases pa WHERE pa.place_id = p.id AND pa.deleted_at IS NULL)::text AS alias_count,
          (SELECT COUNT(DISTINCT ca.contact_id) FROM contact_addresses ca WHERE ca.place_id = p.id AND ca.archived_at IS NULL)::text AS contact_count,
          (SELECT MAX(opl.linked_at)
             FROM order_place_links opl
            WHERE opl.place_id = p.id
              AND opl.workspace_owner_id = p.workspace_owner_id) AS last_delivered_at
       FROM places p
       LEFT JOIN delivery_cities dc ON dc.id = p.city_id
       WHERE ${where}
       ORDER BY ${sortCol} ${sortDir} NULLS LAST, p.id DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset],
    ),
    db.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM places p WHERE ${where}`,
      params,
    ),
    // Summary card counts. AI-verified places count as verified while remaining
    // opt-in for checkout through the separate checkout_ready flag.
    db.query<{
      total: string;
      unverified: string;
      recently_delivered: string;
      verified_count: string;
       checkout_ready_count: string;
       checkout_eligible_count: string;
      ai_reverification_count: string;
      linked_deliveries_count: string;
      possible_duplicates_count: string;
      missing_coordinates_count: string;
    }>(
      `SELECT
         COUNT(*)::text AS total,
         COUNT(*) FILTER (WHERE p.verification_state = 'unverified')::text AS unverified,
         COUNT(*) FILTER (WHERE p.verification_state <> 'unverified')::text AS verified_count,
          COUNT(*) FILTER (WHERE p.checkout_ready = true)::text AS checkout_ready_count,
          COUNT(*) FILTER (
            WHERE p.verification_state = ANY(ARRAY['ai_verified','staff_verified','delivery_verified']::place_verification_state[])
              AND p.location_conflict = false
              AND p.latitude IS NOT NULL
              AND p.longitude IS NOT NULL
          )::text AS checkout_eligible_count,
         COUNT(*) FILTER (
            WHERE (
              p.verification_state = 'unverified'
              AND (
                p.latitude IS NULL
                OR p.longitude IS NULL
                OR p.coordinate_source IN ('ai', 'legacy')
                OR (p.coordinate_source = 'geocoder' AND p.google_place_id IS NULL AND p.source_order_id IS NULL)
              )
            )
               OR (
                 p.verification_state IN ('estimated', 'ai_verified')
                 AND (
                   p.coordinate_source IN ('ai', 'legacy')
                   OR (p.coordinate_source = 'geocoder' AND p.google_place_id IS NULL AND p.source_order_id IS NULL)
                   OR (
                     p.latitude IS NOT NULL
                     AND p.longitude IS NOT NULL
                     AND EXISTS (
                       SELECT 1
                         FROM places duplicate_pin
                        WHERE duplicate_pin.workspace_owner_id = p.workspace_owner_id
                          AND duplicate_pin.id <> p.id
                          AND duplicate_pin.archived_at IS NULL
                          AND round(duplicate_pin.latitude, 5) = round(p.latitude, 5)
                          AND round(duplicate_pin.longitude, 5) = round(p.longitude, 5)
                          AND lower(trim(duplicate_pin.canonical_name)) <> lower(trim(p.canonical_name))
                     )
                   )
                 )
               )
         )::text AS ai_reverification_count,
         (SELECT COUNT(*) FROM order_place_links opl
           WHERE opl.workspace_owner_id = $1)::text AS linked_deliveries_count,
         COUNT(*) FILTER (WHERE p.latitude IS NULL OR p.longitude IS NULL)::text AS missing_coordinates_count,
         COUNT(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM places p2
            WHERE p2.workspace_owner_id = p.workspace_owner_id
              AND p2.id <> p.id
              AND p2.archived_at IS NULL
              AND lower(p2.canonical_name) = lower(p.canonical_name)
         ))::text AS possible_duplicates_count,
         COUNT(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM order_place_links opl
            WHERE opl.place_id = p.id AND opl.linked_at >= now() - INTERVAL '30 days'
         ))::text AS recently_delivered
       FROM places p
       WHERE p.workspace_owner_id = $1 AND p.archived_at IS NULL`,
      [wreq.workspaceOwnerId],
    ),
  ]);

  const total = parseInt(countRes.rows[0]?.total ?? "0", 10);
  const summary = summaryRes.rows[0];

  res.json({
    places: rowsRes.rows.map((r) => ({
      id: r.id,
      canonical_name: r.canonical_name,
      place_type: r.place_type,
      area: r.area,
      city_id: r.city_id,
      city_name: r.city_name,
      canonical_address: r.canonical_address,
      latitude: r.latitude != null ? parseFloat(r.latitude) : null,
      longitude: r.longitude != null ? parseFloat(r.longitude) : null,
      entrance_notes: r.entrance_notes,
      verification_state: r.verification_state,
      ai_invalid: r.ai_invalid ?? false,
       checkout_ready: r.checkout_ready ?? false,
       location_conflict: r.location_conflict ?? false,
      delivery_count: parseInt(r.delivery_count, 10),
      alias_count: parseInt(r.alias_count, 10),
      contact_count: parseInt(r.contact_count, 10),
       last_delivered_at: r.last_delivered_at,
       verified_at: r.verified_at,
      created_at: r.created_at,
      updated_at: r.updated_at,
    })),
    summary: {
      total: parseInt(summary?.total ?? "0", 10),
      unverified: parseInt(summary?.unverified ?? "0", 10),
      needs_review_count: parseInt(summary?.unverified ?? "0", 10),
      verified_count: parseInt(summary?.verified_count ?? "0", 10),
       checkout_ready_count: parseInt(summary?.checkout_ready_count ?? "0", 10),
       checkout_eligible_count: parseInt(summary?.checkout_eligible_count ?? "0", 10),
      ai_reverification_count: parseInt(summary?.ai_reverification_count ?? "0", 10),
      linked_deliveries_count: parseInt(summary?.linked_deliveries_count ?? "0", 10),
      possible_duplicates_count: parseInt(summary?.possible_duplicates_count ?? "0", 10),
      missing_coordinates_count: parseInt(summary?.missing_coordinates_count ?? "0", 10),
      recently_delivered: parseInt(summary?.recently_delivered ?? "0", 10),
    },
    total,
    page,
    limit,
  });
});

// ── Create place ──────────────────────────────────────────────────────────────

const CreatePlaceSchema = z.object({
  canonical_name: z.string().min(1).max(500),
  place_type: z.string().max(50).default("residence"),
  area: z.string().max(200).optional().nullable(),
  city_id: z.number().int().positive().optional().nullable(),
  canonical_address: z.string().max(1000).optional().nullable(),
  latitude: z.number().min(-90).max(90).optional().nullable(),
  longitude: z.number().min(-180).max(180).optional().nullable(),
  entrance_notes: z.string().max(2000).optional().nullable(),
  internal_notes: z.string().max(2000).optional().nullable(),
  aliases: z.array(z.string().min(1).max(500)).optional().default([]),
  // Google Places fields — present when the location was selected via google autocomplete
  google_place_id: z.string().max(500).optional().nullable(),
  google_formatted_address: z.string().max(1000).optional().nullable(),
  google_place_type: z.string().max(200).optional().nullable(),
  google_country: z.string().max(200).optional().nullable(),
  google_city: z.string().max(200).optional().nullable(),
  google_original_lat: z.number().min(-90).max(90).optional().nullable(),
  google_original_lng: z.number().min(-180).max(180).optional().nullable(),
  // Delivery-point support — when set, this place is a sub-entrance of the named parent
  parent_place_id: z.string().uuid("parent_place_id must be a valid UUID").optional().nullable(),
});

function isLebanonCountry(value: string | null | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "lb" || normalized === "lebanon";
}

class GooglePlaceCountryVerificationError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function fetchGooglePlaceCountryCode(placeId: string): Promise<string | null> {
  try {
    return await getGooglePlaceCountryCode(placeId);
  } catch (error) {
    if (error instanceof MapProviderError) {
      throw new GooglePlaceCountryVerificationError(
        error.code === "not_configured"
          ? "Google Places integration is not configured on this server"
          : "Google Places could not verify this location",
        error.code === "not_configured" ? 503 : 502,
      );
    }
    throw error;
  }
}

/** POST /api/address-book/places — create a place with optional aliases. */
router.post("/address-book/places", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);
  if (!requireOwner(wreq, res)) return;

  const parsed = CreatePlaceSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid input" });
    return;
  }

  const d = parsed.data;
  if (d.city_id == null) {
    res.status(422).json({ error: "An active Lebanon delivery district is required" });
    return;
  }
  if (d.google_place_id && !isLebanonCountry(d.google_country)) {
    res.status(422).json({
      error: "Google locations must identify Lebanon before they can be added",
    });
    return;
  }
  if (d.google_country != null && !isLebanonCountry(d.google_country)) {
    res.status(422).json({ error: "Google country must be Lebanon" });
    return;
  }
  if (d.google_place_id) {
    try {
      const authoritativeCountryCode = await fetchGooglePlaceCountryCode(d.google_place_id);
      if (authoritativeCountryCode !== "LB") {
        res.status(422).json({
          error: authoritativeCountryCode
            ? "The selected Google location is outside Lebanon"
            : "Google could not identify this location's country",
        });
        return;
      }
    } catch (err) {
      if (err instanceof GooglePlaceCountryVerificationError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      logger.error({ err, placeId: d.google_place_id }, "create place: country verification failed");
      res.status(502).json({ error: "Google Places could not verify this location" });
      return;
    }
  }
  const aliases = d.aliases.map((aliasText) => ({
    aliasText,
    qualification: qualifySharedAlias(aliasText, "manual", true),
  }));
  const unsafeAlias = aliases.find(({ qualification }) => !qualification.accepted);
  if (unsafeAlias) {
    res.status(400).json({
      error: "Aliases must be reusable place names and cannot contain contact, unit, floor, or delivery-instruction details",
    });
    return;
  }

  // Translate canonical display fields before saving. Latin input is returned
  // unchanged by the helper, while translated Arabic input is preserved as a
  // language-tagged alias so searches in the original language still resolve.
  const [translatedName, translatedAddress] = await Promise.all([
    translateAddressField(d.canonical_name, wreq.workspaceOwnerId),
    translateAddressField(d.canonical_address, wreq.workspaceOwnerId),
  ]);
  const canonicalName = translatedName.value as string;

  const client = await db.connect();
  try {
    const place = await withTransaction(client, async () => {
      const districtCheck = await client.query<{ id: number }>(
        `SELECT id
           FROM delivery_cities
          WHERE id = $1
            AND workspace_owner_id = $2
            AND is_active = true
            AND UPPER(country_code) = 'LB'`,
        [d.city_id, wreq.workspaceOwnerId],
      );
      if (districtCheck.rowCount === 0) {
        throw Object.assign(new Error("district is not an active Lebanon district in this workspace"), {
          _httpStatus: 422,
          _httpBody: {
            error: "District must be an active Lebanon delivery district in this workspace",
          },
        });
      }

      // Validate parent_place_id when provided: must belong to this workspace,
      // not be archived, and must itself be a top-level place (no nesting).
      if (d.parent_place_id) {
        const parentCheck = await client.query<{ parent_place_id: string | null }>(
          `SELECT parent_place_id FROM places
            WHERE id = $1
              AND workspace_owner_id = $2
              AND archived_at IS NULL`,
          [d.parent_place_id, wreq.workspaceOwnerId],
        );
        if (!parentCheck.rows[0]) {
          throw Object.assign(new Error("parent_place_id not found in this workspace"), { _httpStatus: 422, _httpBody: { error: "Parent place not found in this workspace" } });
        }
        if (parentCheck.rows[0].parent_place_id !== null) {
          throw Object.assign(new Error("parent is already a child place"), { _httpStatus: 422, _httpBody: { error: "Cannot create a delivery point under another delivery point" } });
        }
      }

      const r = await client.query<{ id: string }>(
        `INSERT INTO places
           (workspace_owner_id, canonical_name, canonical_name_source, place_type, area, city_id,
            canonical_address, latitude, longitude, entrance_notes, internal_notes,
            google_place_id, google_formatted_address, google_place_type, google_country, google_city,
             google_original_lat, google_original_lng, parent_place_id,
             trusted_country_code, trusted_country_source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'LB','owner')
         RETURNING id`,
        [
          wreq.workspaceOwnerId,
          canonicalName,
          d.google_place_id ? "google" : "manual",
          classifyPlaceType(d.place_type, [canonicalName, ...d.aliases]),
          d.area ?? null,
          d.city_id ?? null,
          translatedAddress.value ?? null,
          d.latitude ?? null,
          d.longitude ?? null,
          d.entrance_notes ?? null,
          d.internal_notes ?? null,
          d.google_place_id ?? null,
          d.google_formatted_address ?? null,
          d.google_place_type ?? null,
          d.google_country ?? null,
          d.google_city ?? null,
          d.google_original_lat ?? null,
          d.google_original_lng ?? null,
          d.parent_place_id ?? null,
        ],
      );
      const placeId = r.rows[0]!.id;

      // Insert aliases (deduplicated by normalized form)
      for (const { aliasText, qualification } of aliases) {
        await client.query(
          `INSERT INTO place_aliases
             (place_id, alias_text, normalized_alias, source, approval_state)
           VALUES ($1, $2, $3, 'manual', 'approved')
           ON CONFLICT (place_id, normalized_alias) DO NOTHING`,
          [placeId, aliasText.trim(), qualification.normalizedAlias],
        );
      }

      if (translatedName.original) {
        await insertTranslatedPlaceAlias(
          placeId,
          translatedName.original,
          (sql, params) => client.query(sql, params),
        );
      }
      if (translatedAddress.original) {
        await insertTranslatedPlaceAlias(
          placeId,
          translatedAddress.original,
          (sql, params) => client.query(sql, params),
        );
      }

      // Record initial verification event
      await client.query(
        `INSERT INTO place_verification_events
           (place_id, event_type, to_state, actor_user_id, actor_name, source, notes)
         VALUES ($1, 'created', 'unverified', $2, $3, 'manual', NULL)`,
        [placeId, wreq.userId ?? null, wreq.userEmail ?? null],
      );

      return placeId;
    });

    const detail = await db.query(
      `SELECT p.*, dc.name AS city_name
         FROM places p
         LEFT JOIN delivery_cities dc ON dc.id = p.city_id
        WHERE p.id = $1`,
      [place],
    );

    res.status(201).json({ place: detail.rows[0] });
  } catch (err: unknown) {
    // Structured validation errors thrown from inside the transaction
    const httpErr = err as { _httpStatus?: number; _httpBody?: object };
    if (httpErr._httpStatus && httpErr._httpBody) {
      res.status(httpErr._httpStatus).json(httpErr._httpBody);
      return;
    }
    const pgErr = err as { code?: string };
    if (pgErr.code === "23505") {
      res.status(409).json({ error: "A place with this name already exists in this city" });
      return;
    }
    logger.error({ err }, "Failed to create place");
    res.status(500).json({ error: "Internal server error" });
  } finally {
    client.release();
  }
});

// ── Google Places proxy ───────────────────────────────────────────────────────
// NOTE: These three routes MUST be registered before /:id so that the literal
// path segments are not swallowed by the UUID param guard.

/**
 * GET /api/address-book/places/google-autocomplete
 * Server-side proxy for Google Places Autocomplete (New) API.
 * Query params:
 *   q           (required) — free-text search input
 *   countryCode (ignored) — the Address Book is permanently restricted to Lebanon
 *   lat, lng    (optional) — decimal coordinates for geographic location bias
 *                            (biases results toward a 50 km circle; applies after
 *                             countryCode restriction when both are provided)
 *   sessionToken (optional) — Autocomplete session token for billing grouping
 * Returns up to 5 suggestions: { placeId, displayName, formattedAddress, types }
 */
router.get("/address-book/places/google-autocomplete", async (req: Request, res: Response): Promise<void> => {
  const GOOGLE_PLACES_SERVER_KEY = process.env.GOOGLE_PLACES_SERVER_KEY;
  if (!GOOGLE_PLACES_SERVER_KEY) {
    res.status(503).json({ error: "Google Places integration is not configured on this server" });
    return;
  }

  const q = (req.query.q as string | undefined)?.trim();
  if (!q) {
    res.status(400).json({ error: "q is required" });
    return;
  }

  const sessionToken = (req.query.sessionToken as string | undefined)?.trim();
  const latParam = parseFloat((req.query.lat as string | undefined) ?? "");
  const lngParam = parseFloat((req.query.lng as string | undefined) ?? "");
  const hasLocationBias =
    !isNaN(latParam) && !isNaN(lngParam) &&
    latParam >= -90 && latParam <= 90 &&
    lngParam >= -180 && lngParam <= 180;

  try {
    const suggestions = await autocompleteGooglePlaces({
      input: q,
      sessionToken,
      ...(hasLocationBias ? { latitude: latParam, longitude: lngParam } : {}),
    });
    res.json({ suggestions });
  } catch (err) {
    logger.error({ err }, "google-autocomplete: fetch failed");
    const status = err instanceof MapProviderError && err.code === "not_configured" ? 503 : 502;
    res.status(status).json({ error: err instanceof MapProviderError ? err.message : "Failed to reach Google Places API" });
  }
});

/**
 * GET /api/address-book/places/google-details
 * Server-side proxy for Google Place Details (New) API.
 * Query params: placeId (required), sessionToken (optional)
 * Returns structured place details including location coordinates.
 */
router.get("/address-book/places/google-details", async (req: Request, res: Response): Promise<void> => {
  const GOOGLE_PLACES_SERVER_KEY = process.env.GOOGLE_PLACES_SERVER_KEY;
  if (!GOOGLE_PLACES_SERVER_KEY) {
    res.status(503).json({ error: "Google Places integration is not configured on this server" });
    return;
  }

  const placeId = (req.query.placeId as string | undefined)?.trim();
  if (!placeId) {
    res.status(400).json({ error: "placeId is required" });
    return;
  }

  const sessionToken = (req.query.sessionToken as string | undefined)?.trim();

  try {
    res.json(await getGooglePlaceDetails(placeId, sessionToken));
  } catch (err) {
    logger.error({ err }, "google-details: fetch failed");
    const status = err instanceof MapProviderError && err.code === "not_configured" ? 503 : 502;
    res.status(status).json({ error: err instanceof MapProviderError ? err.message : "Failed to reach Google Places API" });
  }
});

/**
 * POST /api/address-book/places/pre-check
 * Checks for potential duplicate places before creation. Does NOT create anything.
 * Body: { google_place_id?, name?, lat?, lng?, proximity_m? }
 * Returns: { matches: [{ id, canonical_name, verification_state, delivery_count, match_type }] }
 * match_type: exact_google_id | exact_name | alias_match | nearby_coordinate
 */
router.post("/address-book/places/pre-check", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);

  const PreCheckSchema = z.object({
    google_place_id: z.string().max(500).optional().nullable(),
    name: z.string().max(500).optional().nullable(),
    lat: z.number().min(-90).max(90).optional().nullable(),
    lng: z.number().min(-180).max(180).optional().nullable(),
    proximity_m: z.number().positive().max(5000).optional().default(50),
  });

  const parsed = PreCheckSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid input" });
    return;
  }

  const { google_place_id, name, lat, lng, proximity_m } = parsed.data;

  type MatchRow = {
    id: string;
    canonical_name: string;
    verification_state: string;
    delivery_count: string;
    match_type: "exact_google_id" | "exact_name" | "alias_match" | "nearby_coordinate";
    latitude: string | null;
    longitude: string | null;
  };

  const matches: Array<{
    id: string;
    canonical_name: string;
    verification_state: string;
    delivery_count: number;
    match_type: string;
  }> = [];

  const seenIds = new Set<string>();

  // Helper to push a match deduplicated by place id (highest-priority match_type wins)
  function pushMatch(row: MatchRow, match_type: MatchRow["match_type"]) {
    if (seenIds.has(row.id)) return;
    seenIds.add(row.id);
    matches.push({
      id: row.id,
      canonical_name: row.canonical_name,
      verification_state: row.verification_state,
      delivery_count: parseInt(row.delivery_count, 10),
      match_type,
    });
  }

  try {
    // 1. Exact Google Place ID match
    if (google_place_id) {
      const r = await db.query<MatchRow>(
        `SELECT p.id, p.canonical_name, p.verification_state, p.latitude, p.longitude,
                (SELECT COUNT(*)::text FROM order_place_links opl WHERE opl.place_id = p.id) AS delivery_count
           FROM places p
          WHERE p.workspace_owner_id = $1
            AND p.google_place_id = $2
            AND p.archived_at IS NULL`,
        [wreq.workspaceOwnerId, google_place_id],
      );
      for (const row of r.rows) pushMatch(row, "exact_google_id");
    }

    // 2. Exact canonical name match (case-insensitive)
    if (name) {
      const r = await db.query<MatchRow>(
        `SELECT p.id, p.canonical_name, p.verification_state, p.latitude, p.longitude,
                (SELECT COUNT(*)::text FROM order_place_links opl WHERE opl.place_id = p.id) AS delivery_count
           FROM places p
          WHERE p.workspace_owner_id = $1
            AND lower(p.canonical_name) = lower($2)
            AND p.archived_at IS NULL`,
        [wreq.workspaceOwnerId, name],
      );
      for (const row of r.rows) pushMatch(row, "exact_name");
    }

    // 3. Alias match (normalized)
    if (name) {
      const normalized = normalizePlaceName(name);
      const r = await db.query<MatchRow>(
        `SELECT p.id, p.canonical_name, p.verification_state, p.latitude, p.longitude,
                (SELECT COUNT(*)::text FROM order_place_links opl WHERE opl.place_id = p.id) AS delivery_count
           FROM places p
           JOIN place_aliases pa ON pa.place_id = p.id
          WHERE p.workspace_owner_id = $1
            AND pa.normalized_alias = $2
            AND pa.deleted_at IS NULL
            AND p.archived_at IS NULL`,
        [wreq.workspaceOwnerId, normalized],
      );
      for (const row of r.rows) pushMatch(row, "alias_match");
    }

    // 4. Nearby coordinate match (haversine, within proximity_m metres)
    if (lat != null && lng != null) {
      const proximityKm = (proximity_m ?? 50) / 1000;
      // Fetch all places with coordinates in this workspace (within a generous bounding box first)
      const latDelta = proximityKm / 111; // ~111 km per degree latitude
      const lngDelta = proximityKm / (111 * Math.cos((lat * Math.PI) / 180));
      const r = await db.query<MatchRow>(
        `SELECT p.id, p.canonical_name, p.verification_state, p.latitude, p.longitude,
                (SELECT COUNT(*)::text FROM order_place_links opl WHERE opl.place_id = p.id) AS delivery_count
           FROM places p
          WHERE p.workspace_owner_id = $1
            AND p.latitude  BETWEEN $2 AND $3
            AND p.longitude BETWEEN $4 AND $5
            AND p.archived_at IS NULL`,
        [wreq.workspaceOwnerId, lat - latDelta, lat + latDelta, lng - lngDelta, lng + lngDelta],
      );
      for (const row of r.rows) {
        if (row.latitude == null || row.longitude == null) continue;
        const distKm = haversineDistanceKm(lat, lng, parseFloat(row.latitude), parseFloat(row.longitude));
        if (distKm <= proximityKm) pushMatch(row, "nearby_coordinate");
      }
    }

    res.json({ matches });
  } catch (err) {
    logger.error({ err }, "pre-check: failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── Delivery points ───────────────────────────────────────────────────────────

/**
 * POST /api/address-book/places/:id/delivery-points
 * Creates a sub-entrance (delivery point) under an existing canonical location.
 * The parent must not itself already be a child (no nested nesting).
 * Inherits city_id, place_type, and workspace_owner_id from the parent.
 * NOTE: This route is registered below the static routes but before the other
 * /:id sub-routes so it does not collide with them.
 */
router.post("/address-book/places/:id/delivery-points", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);
  if (!requireOwner(wreq, res)) return;

  const parentId = String(req.params.id || "").trim();
  if (!isUuid(parentId)) {
    res.status(404).json({ error: "Place not found" });
    return;
  }

  const DeliveryPointSchema = z.object({
    canonical_name: z.string().min(1).max(500),
    entrance_notes: z.string().max(2000).optional().nullable(),
    aliases: z.array(z.string().min(1).max(500)).optional().default([]),
  });

  const parsed = DeliveryPointSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid input" });
    return;
  }

  // Fetch the parent — must belong to this workspace, not be archived, and not
  // itself already be a child (parent_place_id IS NULL).
  const parentRes = await db.query<{
    id: string;
    city_id: number | null;
    place_type: string;
    parent_place_id: string | null;
  }>(
    `SELECT id, city_id, place_type, parent_place_id
       FROM places
      WHERE id = $1 AND workspace_owner_id = $2 AND archived_at IS NULL`,
    [parentId, wreq.workspaceOwnerId],
  );

  if (!parentRes.rows[0]) {
    res.status(404).json({ error: "Place not found" });
    return;
  }

  if (parentRes.rows[0].parent_place_id !== null) {
    res.status(422).json({ error: "Cannot create a delivery point under another delivery point" });
    return;
  }

  const parent = parentRes.rows[0];
  const d = parsed.data;

  const aliases = d.aliases.map((aliasText) => ({
    aliasText,
    qualification: qualifySharedAlias(aliasText, "manual", true),
  }));
  const unsafeAlias = aliases.find(({ qualification }) => !qualification.accepted);
  if (unsafeAlias) {
    res.status(400).json({
      error: "Aliases must be reusable place names and cannot contain contact, unit, floor, or delivery-instruction details",
    });
    return;
  }

  const client = await db.connect();
  try {
    const deliveryPointId = await withTransaction(client, async () => {
      const r = await client.query<{ id: string }>(
        `INSERT INTO places
           (workspace_owner_id, canonical_name, canonical_name_source, place_type,
            city_id, entrance_notes, parent_place_id)
         VALUES ($1, $2, 'manual', $3, $4, $5, $6)
         RETURNING id`,
        [
          wreq.workspaceOwnerId,
          d.canonical_name,
          parent.place_type,
          parent.city_id ?? null,
          d.entrance_notes ?? null,
          parentId,
        ],
      );
      const dpId = r.rows[0]!.id;

      for (const { aliasText, qualification } of aliases) {
        await client.query(
          `INSERT INTO place_aliases
             (place_id, alias_text, normalized_alias, source, approval_state)
           VALUES ($1, $2, $3, 'manual', 'approved')
           ON CONFLICT (place_id, normalized_alias) DO NOTHING`,
          [dpId, aliasText.trim(), qualification.normalizedAlias],
        );
      }

      await client.query(
        `INSERT INTO place_verification_events
           (place_id, event_type, to_state, actor_user_id, actor_name, source, notes)
         VALUES ($1, 'created', 'unverified', $2, $3, 'manual', $4)`,
        [dpId, wreq.userId ?? null, wreq.userEmail ?? null, `Delivery point of place ${parentId}`],
      );

      return dpId;
    });

    const detail = await db.query(
      `SELECT p.*, dc.name AS city_name
         FROM places p
         LEFT JOIN delivery_cities dc ON dc.id = p.city_id
        WHERE p.id = $1`,
      [deliveryPointId],
    );

    res.status(201).json({ place: detail.rows[0] });
  } catch (err: unknown) {
    const pgErr = err as { code?: string };
    if (pgErr.code === "23505") {
      res.status(409).json({ error: "A place with this name already exists in this city" });
      return;
    }
    logger.error({ err }, "Failed to create delivery point");
    res.status(500).json({ error: "Internal server error" });
  } finally {
    client.release();
  }
});

// ── Place detail ──────────────────────────────────────────────────────────────

/**
 * GET /api/address-book/places/:id
 * Returns full place with aliases, linked contacts (paginated), recent deliveries,
 * and verification timeline.
 */
router.get("/address-book/places/:id", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);
  const id = String(req.params.id || "").trim();
  if (!isUuid(id)) {
    res.status(404).json({ error: "Place not found" });
    return;
  }

  const contactPage = Math.max(1, parseInt((req.query.contact_page as string) || "1", 10));
  const contactLimit = Math.min(50, Math.max(1, parseInt((req.query.contact_limit as string) || "20", 10)));
  const contactOffset = (contactPage - 1) * contactLimit;

  const [placeRes, aliasRes, contactRes, deliveryRes, timelineRes, deliveryPointsRes] = await Promise.all([
    db.query<{
      id: string;
      canonical_name: string;
      place_type: string;
      area: string | null;
      city_id: number | null;
      city_name: string | null;
      canonical_address: string | null;
      latitude: string | null;
      longitude: string | null;
      entrance_notes: string | null;
      internal_notes: string | null;
      verification_state: string;
      checkout_ready: boolean;
      verified_at: string | null;
      verified_by: string | null;
      coordinate_source: string | null;
      location_conflict: boolean;
      archived_at: string | null;
      created_at: string;
      updated_at: string;
      city_country_code: string | null;
    }>(
      `SELECT p.*, dc.name AS city_name, dc.country_code AS city_country_code
         FROM places p
         LEFT JOIN delivery_cities dc ON dc.id = p.city_id
        WHERE p.id = $1 AND p.workspace_owner_id = $2`,
      [id, wreq.workspaceOwnerId],
    ),
    db.query<{ id: string; alias_text: string; normalized_alias: string; language: string | null; source: string; approval_state: string; created_at: string }>(
      `SELECT id, alias_text, normalized_alias, language, source, approval_state, created_at
         FROM place_aliases
        WHERE place_id = $1 AND deleted_at IS NULL
        ORDER BY created_at ASC`,
      [id],
    ),
    db.query<{
      id: string;
      first_name: string | null;
      last_name: string | null;
      display_name: string | null;
      phone: string | null;
      email: string | null;
      address_label: string | null;
      address_id: string;
      total: string;
    }>(
      `SELECT linked_contacts.*,
              COUNT(*) OVER() AS total
         FROM (
           SELECT DISTINCT ON (ca.contact_id)
                  c.id, c.first_name, c.last_name, c.display_name, c.phone, c.email,
                  ca.label AS address_label, ca.id AS address_id, ca.created_at
             FROM contact_addresses ca
             JOIN contacts c ON c.id = ca.contact_id
            WHERE ca.place_id = $1
              AND ca.archived_at IS NULL
              AND c.workspace_owner_id = $2
            ORDER BY ca.contact_id, ca.created_at DESC, ca.id DESC
         ) AS linked_contacts
        ORDER BY linked_contacts.created_at DESC, linked_contacts.id DESC
        LIMIT $3 OFFSET $4`,
      [id, wreq.workspaceOwnerId, contactLimit, contactOffset],
    ),
    db.query<{
      order_id: string;
      linked_at: string;
      display_order_number: string;
      ordered_at: string | null;
    }>(
      `SELECT opl.order_id, opl.linked_at,
              COALESCE(o.display_order_number, o.external_order_id, o.id::text) AS display_order_number,
              o.ordered_at
         FROM order_place_links opl
         JOIN orders o ON o.id = opl.order_id
         WHERE opl.place_id = $1
           AND opl.workspace_owner_id = $2
           AND o.workspace_owner_id = $2
        ORDER BY opl.linked_at DESC
        LIMIT 20`,
      [id, wreq.workspaceOwnerId],
    ),
    db.query<{
      id: string;
      event_type: string;
      from_state: string | null;
      to_state: string | null;
      actor_user_id: string | null;
      actor_name: string | null;
      source: string | null;
      notes: string | null;
      metadata: Record<string, unknown> | null;
      created_at: string;
    }>(
      `SELECT id, event_type, from_state, to_state, actor_user_id, actor_name, source, notes, metadata, created_at
         FROM place_verification_events
        WHERE place_id = $1
        ORDER BY created_at DESC`,
      [id],
    ),
    // Child delivery points — sub-entrances of this canonical location
    db.query<{
      id: string;
      canonical_name: string;
      entrance_notes: string | null;
      aliases: string[];
    }>(
      `SELECT dp.id, dp.canonical_name, dp.entrance_notes,
              ARRAY(
                SELECT pa.alias_text
                  FROM place_aliases pa
                 WHERE pa.place_id = dp.id AND pa.deleted_at IS NULL
              ) AS aliases
         FROM places dp
        WHERE dp.parent_place_id = $1
          AND dp.workspace_owner_id = $2
          AND dp.archived_at IS NULL
        ORDER BY dp.created_at ASC`,
      [id, wreq.workspaceOwnerId],
    ),
  ]);

  if (!placeRes.rows[0]) {
    res.status(404).json({ error: "Place not found" });
    return;
  }

  const p = placeRes.rows[0];
  const contactTotal = parseInt(contactRes.rows[0]?.total ?? "0", 10);

  res.json({
    place: {
      ...p,
      latitude: p.latitude != null ? parseFloat(p.latitude) : null,
      longitude: p.longitude != null ? parseFloat(p.longitude) : null,
    },
    aliases: aliasRes.rows,
    contacts: {
      items: contactRes.rows.map(({ total: _t, ...r }) => r),
      total: contactTotal,
      page: contactPage,
      limit: contactLimit,
    },
    recent_deliveries: deliveryRes.rows,
    verification_timeline: timelineRes.rows,
    delivery_points: deliveryPointsRes.rows,
  });
});

// ── Update place ──────────────────────────────────────────────────────────────

const UpdatePlaceSchema = z.object({
  canonical_name: z.string().min(1).max(500).optional(),
  place_type: z.string().max(50).optional(),
  area: z.string().max(200).optional().nullable(),
  city_id: z.number().int().positive().optional().nullable(),
  canonical_address: z.string().max(1000).optional().nullable(),
  entrance_notes: z.string().max(2000).optional().nullable(),
  internal_notes: z.string().max(2000).optional().nullable(),
});

/** PUT /api/address-book/places/:id — update canonical fields. */
router.put("/address-book/places/:id", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);
  if (!requireOwner(wreq, res)) return;

  const id = String(req.params.id || "").trim();
  if (!isUuid(id)) {
    res.status(404).json({ error: "Place not found" });
    return;
  }

  const parsed = UpdatePlaceSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid input" });
    return;
  }

  const d = parsed.data;
  // Resolve the current record before building the update so a canonical-name
  // edit or a newly supplied default type is classified consistently with
  // creates. The workspace predicate also keeps this lookup tenant-scoped.
  const existing = await db.query<{
    canonical_name: string;
    place_type: string;
    aliases: string[];
  }>(
    `SELECT
       p.canonical_name,
       p.place_type,
       ARRAY(
         SELECT pa.alias_text
           FROM place_aliases pa
          WHERE pa.place_id = p.id AND pa.deleted_at IS NULL
       ) AS aliases
       FROM places p
      WHERE p.workspace_owner_id = $1 AND p.id = $2 AND p.archived_at IS NULL`,
    [wreq.workspaceOwnerId, id],
  );
  if (!existing.rows[0]) {
    res.status(404).json({ error: "Place not found" });
    return;
  }

  const [translatedName, translatedAddress] = await Promise.all([
    d.canonical_name !== undefined
      ? translateAddressField(d.canonical_name, wreq.workspaceOwnerId)
      : Promise.resolve({ value: undefined, original: null }),
    "canonical_address" in d
      ? translateAddressField(d.canonical_address, wreq.workspaceOwnerId)
      : Promise.resolve({ value: undefined, original: null }),
  ]);
  const resultingName = d.canonical_name !== undefined
    ? (translatedName.value as string)
    : existing.rows[0].canonical_name;
  const resultingType = classifyPlaceType(
    d.place_type ?? existing.rows[0].place_type,
    [resultingName, ...existing.rows[0].aliases],
  );

  const sets: string[] = ["updated_at = now()"];
  const params: unknown[] = [wreq.workspaceOwnerId, id];
  let idx = 3;

  if (d.canonical_name !== undefined) {
    sets.push(`canonical_name = $${idx++}`);
    params.push(translatedName.value);
    // A direct owner edit is authoritative and must never be compacted by a
    // future historical reconciliation.
    sets.push(`canonical_name_source = 'manual'`);
  }
  if (d.place_type !== undefined || resultingType !== existing.rows[0].place_type) {
    sets.push(`place_type = $${idx++}`);
    params.push(resultingType);
  }
  if ("area" in d) { sets.push(`area = $${idx++}`); params.push(d.area ?? null); }
  if ("city_id" in d) { sets.push(`city_id = $${idx++}`); params.push(d.city_id ?? null); }
  if ("city_id" in d && d.city_id != null) {
    sets.push(`trusted_country_code = (SELECT upper(country_code) FROM delivery_cities WHERE id = $${idx++})`);
    params.push(d.city_id);
    sets.push(`trusted_country_source = 'owner'`);
  }
  if ("canonical_address" in d) {
    sets.push(`canonical_address = $${idx++}`);
    params.push(translatedAddress.value ?? null);
  }
  if ("entrance_notes" in d) { sets.push(`entrance_notes = $${idx++}`); params.push(d.entrance_notes ?? null); }
  if ("internal_notes" in d) { sets.push(`internal_notes = $${idx++}`); params.push(d.internal_notes ?? null); }

  if (sets.length === 1) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }

  const client = await db.connect();
  try {
    const updated = await withTransaction(client, async () => {
      const r = await client.query(
        `UPDATE places SET ${sets.join(", ")}
          WHERE workspace_owner_id = $1 AND id = $2 AND archived_at IS NULL
         RETURNING id`,
        params,
      );
      if (!r.rowCount) return false;

      if (translatedName.original) {
        await insertTranslatedPlaceAlias(
          id,
          translatedName.original,
          (sql, queryParams) => client.query(sql, queryParams),
        );
      }
      if (translatedAddress.original) {
        await insertTranslatedPlaceAlias(
          id,
          translatedAddress.original,
          (sql, queryParams) => client.query(sql, queryParams),
        );
      }
      if (d.canonical_name !== undefined) {
        await client.query(
          `INSERT INTO place_verification_events
             (place_id, event_type, actor_user_id, actor_name, source, notes)
           VALUES ($1, 'title_updated', $2, $3, 'manual', 'Owner updated the canonical place title')`,
          [id, wreq.userId ?? null, wreq.userEmail ?? null],
        );
      }
      return true;
    });
    if (!updated) {
      res.status(404).json({ error: "Place not found" });
      return;
    }
    res.json({ success: true });
    // Non-blocking: re-evaluate location conflict if city assignment changed
    void refreshLocationConflict(id, wreq.workspaceOwnerId);
  } catch (err: unknown) {
    const pgErr = err as { code?: string };
    if (pgErr.code === "23505") {
      res.status(409).json({ error: "A place with this name already exists in this city" });
      return;
    }
    logger.error({ err }, "Failed to update place");
    res.status(500).json({ error: "Internal server error" });
  } finally {
    client.release();
  }
});

// ── AI assess endpoint ────────────────────────────────────────────────────────

/**
 * POST /api/address-book/places/:id/ai-assess
 * Manually trigger AI validity + geocoding for a single place.
 * Runs synchronously (awaited) so the caller gets the result immediately.
 */
router.post("/address-book/places/:id/ai-assess", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);
  if (!requireOwner(wreq, res)) return;

  const id = String(req.params.id || "").trim();
  if (!isUuid(id)) {
    res.status(404).json({ error: "Place not found" });
    return;
  }

  // Fetch the place + its aliases
  const placeRes = await db.query<{
    canonical_name: string;
    canonical_address: string | null;
    area: string | null;
    city_name: string | null;
    country_code: string | null;
  }>(
    `SELECT p.canonical_name, p.canonical_address, p.area,
            dc.name AS city_name, dc.country_code
       FROM places p
       LEFT JOIN delivery_cities dc ON dc.id = p.city_id
      WHERE p.id = $1 AND p.workspace_owner_id = $2 AND p.archived_at IS NULL`,
    [id, wreq.workspaceOwnerId],
  );

  if (!placeRes.rows[0]) {
    res.status(404).json({ error: "Place not found" });
    return;
  }

  const { canonical_name, canonical_address, area } = placeRes.rows[0];
  const geography = (await resolveTrustedPlaceGeography(id, wreq.workspaceOwnerId)) ?? {
    city: placeRes.rows[0].city_name,
    country: placeRes.rows[0].country_code,
    conflict: false,
  };

  const aliasRes = await db.query<{ alias_text: string }>(
    `SELECT alias_text FROM place_aliases WHERE place_id = $1
        AND deleted_at IS NULL
        AND COALESCE(approval_state, 'approved') = 'approved'`,
    [id],
  );
  const aliases = aliasRes.rows.map((r) => r.alias_text);

  try {
    // Reset ai_invalid before re-assessment so stale flags don't persist
    await db.query(
      `UPDATE places SET ai_invalid = NULL, updated_at = now()
        WHERE id = $1 AND workspace_owner_id = $2`,
      [id, wreq.workspaceOwnerId],
    );

    const assessment = await assessAndGeocode(
      id,
      canonical_name,
      aliases,
      wreq.workspaceOwnerId,
      undefined,
      {
        canonicalAddress: canonical_address,
        area,
        city: geography?.city ?? null,
        country: geography?.country ?? null,
        geographyConflict: geography?.conflict ?? false,
      },
    );

    // Return the updated place state
    const updated = await db.query<{
      ai_invalid: boolean | null;
      latitude: string | null;
      longitude: string | null;
      verification_state: string;
    }>(
      `SELECT ai_invalid, latitude, longitude, verification_state FROM places WHERE id = $1`,
      [id],
    );

    const row = updated.rows[0];
    res.json({
      success: true,
      ai_invalid: row?.ai_invalid ?? false,
      latitude: row?.latitude != null ? parseFloat(row.latitude) : null,
      longitude: row?.longitude != null ? parseFloat(row.longitude) : null,
      verification_state: row?.verification_state ?? null,
      assessment_status: assessment.status,
      matched_location: assessment.matchedLocation ?? null,
      coordinates_updated: assessment.coordinatesUpdated ?? false,
      coordinates_cleared: assessment.coordinatesCleared ?? false,
      preserved_verified_coordinates: assessment.preservedVerifiedCoordinates ?? false,
      precision: assessment.precision ?? null,
      verification_method: assessment.method ?? null,
    });
  } catch (err) {
    logger.error({ err, placeId: id }, "Failed to run AI assessment");
    res.status(500).json({ error: "AI assessment failed" });
  }
});

// ── Bulk AI reverification ───────────────────────────────────────────────────

/** Start a new run, or return the currently active run for this workspace. */
router.post("/address-book/reverification-runs", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);
  if (!requireOwner(wreq, res)) return;

  try {
    const run = await enqueueAddressReverificationRun(
      wreq.workspaceOwnerId,
      wreq.userId ?? null,
    );
    void processPendingAddressReverificationJobs();
    res.status(run.status === "COMPLETED" ? 200 : 202).json({ run });
  } catch (err) {
    logger.error({ err, workspaceId: wreq.workspaceOwnerId }, "Failed to start address reverification run");
    res.status(500).json({ error: "Unable to queue address reverification" });
  }
});

/** Read durable progress for the latest run or a specific workspace-owned run. */
router.get("/address-book/reverification-runs/:runId", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);
  if (!requireOwner(wreq, res)) return;

  const requested = String(req.params.runId || "");
  const runId = requested === "latest" ? undefined : requested;
  if (runId && !isUuid(runId)) {
    res.status(404).json({ error: "Reverification run not found" });
    return;
  }

  const run = await getAddressReverificationRun(wreq.workspaceOwnerId, runId);
  if (!run) {
    res.status(404).json({ error: "Reverification run not found" });
    return;
  }
  res.json({ run });
});

// ── Archive place ─────────────────────────────────────────────────────────────

/** PUT /api/address-book/places/:id/archive — soft-delete (never hard-delete). */
router.put("/address-book/places/:id/archive", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);
  if (!requireOwner(wreq, res)) return;

  const id = String(req.params.id || "").trim();
  if (!isUuid(id)) {
    res.status(404).json({ error: "Place not found" });
    return;
  }

  const r = await db.query(
    `UPDATE places SET archived_at = now(), updated_at = now()
      WHERE workspace_owner_id = $1 AND id = $2 AND archived_at IS NULL
     RETURNING id`,
    [wreq.workspaceOwnerId, id],
  );

  if (!r.rowCount) {
    res.status(404).json({ error: "Place not found or already archived" });
    return;
  }

  res.json({ success: true });
});

// ── Map-pin update ────────────────────────────────────────────────────────────

const MapPinSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  /** Logical source. `google_places` and `linked_delivery` are UI-facing aliases
   *  that map to DB enum values before writing. */
  source: z
    .enum(["manual", "gps", "geocoder", "import", "google_places", "linked_delivery"])
    .default("manual"),
  notes: z.string().max(2000).optional().nullable(),
  // Google Places fields — present when source is google_places
  google_place_id: z.string().max(500).optional().nullable(),
  google_formatted_address: z.string().max(1000).optional().nullable(),
  google_place_type: z.string().max(200).optional().nullable(),
  google_country: z.string().max(200).optional().nullable(),
  google_city: z.string().max(200).optional().nullable(),
  google_original_lat: z.number().min(-90).max(90).optional().nullable(),
  google_original_lng: z.number().min(-180).max(180).optional().nullable(),
  // Source order reference — present when source is linked_delivery
  source_order_id: z.string().uuid().optional().nullable(),
  // Google Maps deep-link URL — present when source is google_places
  google_maps_url: z.string().max(2000).optional().nullable(),
});

/**
 * PUT /api/address-book/places/:id/map-pin
 * Updates coordinates. Automated sources (geocoder/import) are blocked when
 * the place is already staff_verified or delivery_verified. Always records a
 * verification event.
 *
 * UI-facing source aliases accepted by the schema:
 *   google_places   → maps to "geocoder" in coordinate_source DB enum;
 *                     also writes Google Place fields onto the places row.
 *   linked_delivery → maps to "gps" in coordinate_source DB enum.
 *
 * Returns HTTP 409 with { conflict: "duplicate_google_place_id", existing_place }
 * when another active place in this workspace already holds the same google_place_id.
 *
 * Resets verification_state to "unverified" (and logs a state_change event) when
 * the current state is staff_verified or delivery_verified and the source is
 * "manual" or "google_places", since the previous field-confirmation no longer applies.
 */
router.put("/address-book/places/:id/map-pin", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);
  if (!requireOwner(wreq, res)) return;

  const id = String(req.params.id || "").trim();
  if (!isUuid(id)) {
    res.status(404).json({ error: "Place not found" });
    return;
  }

  const parsed = MapPinSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid input" });
    return;
  }

  const {
    latitude,
    longitude,
    source: inputSource,
    notes,
    google_place_id,
    google_formatted_address,
    google_place_type,
    google_country,
    google_city,
    google_original_lat,
    google_original_lng,
    source_order_id,
    google_maps_url,
  } = parsed.data;

  // Map UI-facing source aliases to DB coordinate_source enum values
  const dbSource: string =
    inputSource === "google_places"
      ? "geocoder"
      : inputSource === "linked_delivery"
        ? "gps"
        : inputSource;

  const AUTOMATED_SOURCES = ["geocoder", "import"];

  const existing = await db.query<{ verification_state: string; latitude: string | null; longitude: string | null }>(
    `SELECT verification_state, latitude, longitude FROM places
      WHERE workspace_owner_id = $1 AND id = $2 AND archived_at IS NULL`,
    [wreq.workspaceOwnerId, id],
  );

  if (!existing.rows[0]) {
    res.status(404).json({ error: "Place not found" });
    return;
  }

  const currentState = existing.rows[0].verification_state;
  const PROTECTED_STATES = ["staff_verified", "delivery_verified"];

  // Block fully-automated rewrites on protected places (not UI-sourced google_places)
  if (AUTOMATED_SOURCES.includes(dbSource) && inputSource !== "google_places" && PROTECTED_STATES.includes(currentState)) {
    res.status(409).json({
      error: `Cannot overwrite coordinates for a ${currentState} place with an automated source`,
    });
    return;
  }

  // ── Duplicate Google Place ID check ──────────────────────────────────────────
  if (google_place_id) {
    const dupCheck = await db.query<{ id: string; canonical_name: string }>(
      `SELECT id, canonical_name FROM places
        WHERE workspace_owner_id = $1
          AND id <> $2
          AND archived_at IS NULL
          AND google_place_id = $3
        LIMIT 1`,
      [wreq.workspaceOwnerId, id, google_place_id],
    );
    if (dupCheck.rows[0]) {
      const dup = dupCheck.rows[0];
      res.status(409).json({
        conflict: "duplicate_google_place_id",
        existing_place: {
          id: dup.id,
          title: dup.canonical_name,
          url: `/address-book/${dup.id}`,
        },
      });
      return;
    }
  }

  // ── Determine whether verification state should be reset ──────────────────
  const RESET_STATES = ["staff_verified", "delivery_verified"];
  // Every permitted UI source can materially change the pin; all must reset verification.
  const RESET_SOURCES = ["manual", "google_places", "linked_delivery"];
  const shouldResetVerification =
    RESET_STATES.includes(currentState) && RESET_SOURCES.includes(inputSource);

  // ── Build audit-event notes with full source detail + before/after coords ──
  const prevLat = existing.rows[0].latitude != null ? parseFloat(existing.rows[0].latitude) : null;
  const prevLng = existing.rows[0].longitude != null ? parseFloat(existing.rows[0].longitude) : null;
  const auditDetails: Record<string, unknown> = {
    source: inputSource,
    coordinates_before: { latitude: prevLat, longitude: prevLng },
    coordinates_after: { latitude, longitude },
    ...(google_place_id ? { google_place_id } : {}),
    ...(source_order_id ? { source_order_id } : {}),
  };
  const auditNotes =
    (notes ?? "") +
    (Object.keys(auditDetails).length > 0
      ? (notes ? " | " : "") + JSON.stringify(auditDetails)
      : "");

  const client = await db.connect();
  try {
    await withTransaction(client, async () => {
      // Update coordinates and coordinate_source
      if (google_place_id) {
        // Persist Google Place fields + optional Maps URL onto the places row
        await client.query(
          `UPDATE places
              SET latitude = $1, longitude = $2, coordinate_source = $3::coordinate_source,
                  google_place_id = $4, google_formatted_address = $5, google_place_type = $6,
                  google_country = $7, google_city = $8,
                  google_original_lat = $9, google_original_lng = $10,
                  google_maps_url = $11,
                  source_order_id = NULL,
                  updated_at = now()
            WHERE workspace_owner_id = $12 AND id = $13`,
          [
            latitude, longitude, dbSource,
            google_place_id, google_formatted_address ?? null, google_place_type ?? null,
            google_country ?? null, google_city ?? null,
            google_original_lat ?? null, google_original_lng ?? null,
            google_maps_url ?? null,
            wreq.workspaceOwnerId, id,
          ],
        );
      } else if (inputSource === "linked_delivery" && source_order_id) {
        // Persist the source delivery order for traceability
        await client.query(
          `UPDATE places
              SET latitude = $1, longitude = $2, coordinate_source = $3::coordinate_source,
                  source_order_id = $4,
                  google_place_id = NULL, google_formatted_address = NULL, google_place_type = NULL,
                  google_country = NULL, google_city = NULL,
                  google_original_lat = NULL, google_original_lng = NULL, google_maps_url = NULL,
                  updated_at = now()
            WHERE workspace_owner_id = $5 AND id = $6`,
          [latitude, longitude, dbSource, source_order_id, wreq.workspaceOwnerId, id],
        );
      } else {
        await client.query(
          `UPDATE places SET latitude = $1, longitude = $2, coordinate_source = $3::coordinate_source, updated_at = now()
            WHERE workspace_owner_id = $4 AND id = $5`,
          [latitude, longitude, dbSource, wreq.workspaceOwnerId, id],
        );
      }

      // Record map_pin_updated audit event
      await client.query(
        `INSERT INTO place_verification_events
           (place_id, event_type, from_state, to_state, actor_user_id, actor_name, source, notes)
         VALUES ($1, 'map_pin_updated', $2::place_verification_state, $2::place_verification_state, $3, $4, $5, $6)`,
        [id, currentState, wreq.userId ?? null, wreq.userEmail ?? null, inputSource, auditNotes || null],
      );

      // Reset verification state AND checkout eligibility if needed, log state_change
      if (shouldResetVerification) {
        await client.query(
          `UPDATE places
              SET verification_state = 'unverified'::place_verification_state,
                  checkout_ready = false,
                  updated_at = now()
            WHERE workspace_owner_id = $1 AND id = $2`,
          [wreq.workspaceOwnerId, id],
        );
        await client.query(
          `INSERT INTO place_verification_events
             (place_id, event_type, from_state, to_state, actor_user_id, actor_name, source, notes)
           VALUES ($1, 'state_change', $2::place_verification_state, 'unverified'::place_verification_state, $3, $4, $5, $6)`,
          [
            id, currentState,
            wreq.userId ?? null, wreq.userEmail ?? null,
            inputSource,
            "Verification reset to unverified and checkout_ready cleared after map pin update",
          ],
        );
      }
    });

    res.json({ success: true });
    // Non-blocking: re-evaluate location conflict with the newly saved coordinates
    void refreshLocationConflict(id, wreq.workspaceOwnerId);
  } catch (err) {
    logger.error({ err }, "Failed to update map pin");
    res.status(500).json({ error: "Internal server error" });
  } finally {
    client.release();
  }
});

// ── Alias endpoints ───────────────────────────────────────────────────────────

const AddAliasSchema = z.object({
  alias_text: z.string().min(1).max(500),
  language: z.string().max(20).optional().nullable(),
  source: z.enum(["manual", "approved_landmark", "approved_transliteration", "ai_suggestion", "search_suggestion"]).optional(),
  owner_approved: z.boolean().optional(),
});

/** POST /api/address-book/places/:id/aliases — add an alias to a place. */
router.post("/address-book/places/:id/aliases", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);
  if (!requireOwner(wreq, res)) return;

  const id = String(req.params.id || "").trim();
  if (!isUuid(id)) {
    res.status(404).json({ error: "Place not found" });
    return;
  }

  const parsed = AddAliasSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid input" });
    return;
  }

  const { alias_text, language } = parsed.data;
  const source: SharedAliasSource = parsed.data.source ?? "manual";
  const qualification = qualifySharedAlias(
    alias_text,
    source,
    parsed.data.owner_approved ?? source === "manual",
  );
  if (!qualification.normalizedAlias) {
    // Empty or private-detail text — always rejected regardless of source.
    res.status(400).json({
      error: "Aliases must be reusable place names and cannot contain contact, unit, floor, or delivery-instruction details",
    });
    return;
  }
  // AI / search suggestions are stored as pending rather than immediately shared;
  // manual and pre-approved sources are stored as approved directly.
  const approvalState = qualification.requiresOwnerApproval ? "pending" : "approved";

  // Verify place belongs to workspace
  const placeCheck = await db.query<{ id: string; canonical_name: string }>(
    `SELECT id, canonical_name
       FROM places
      WHERE id = $1 AND workspace_owner_id = $2 AND archived_at IS NULL`,
    [id, wreq.workspaceOwnerId],
  );
  if (!placeCheck.rows[0]) {
    res.status(404).json({ error: "Place not found" });
    return;
  }

  const shouldPromoteToHotel =
    isAccommodationPlaceName(placeCheck.rows[0].canonical_name) ||
    isAccommodationPlaceName(alias_text);
  const client = await db.connect();
  try {
    const alias = await withTransaction(client, async () => {
      // Promote first so a duplicate alias retry repairs any pre-migration
      // Residence record too. ON CONFLICT keeps the promotion and alias write
      // atomic while preserving the existing 409 response for duplicates.
      if (shouldPromoteToHotel) {
        await client.query(
          `UPDATE places
              SET place_type = 'hotel', updated_at = now()
            WHERE id = $1 AND lower(trim(place_type)) = 'residence'`,
          [id],
        );
      }

      const r = await client.query<{ id: string }>(
        `INSERT INTO place_aliases
           (place_id, alias_text, normalized_alias, language, source, approval_state)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (place_id, normalized_alias) DO NOTHING
         RETURNING id`,
        [id, alias_text.trim(), qualification.normalizedAlias, language ?? null, source, approvalState],
      );
      return r.rows[0] ?? null;
    });

    if (!alias) {
      res.status(409).json({ error: "This alias already exists for this place" });
      return;
    }
    res.status(201).json({ alias });
  } catch (err: unknown) {
    logger.error({ err }, "Failed to add alias");
    res.status(500).json({ error: "Internal server error" });
  } finally {
    client.release();
  }
});

/** DELETE /api/address-book/places/:id/aliases/:aliasId — soft-delete an alias. */
router.delete("/address-book/places/:id/aliases/:aliasId", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);
  if (!requireOwner(wreq, res)) return;

  const id = String(req.params.id || "").trim();
  const aliasId = String(req.params.aliasId || "").trim();
  if (!isUuid(id) || !isUuid(aliasId)) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  // Verify the alias belongs to a place in this workspace
  const r = await db.query(
    `UPDATE place_aliases pa
        SET deleted_at = now()
       FROM places p
      WHERE pa.id = $1
        AND pa.place_id = p.id
        AND p.id = $2
        AND p.workspace_owner_id = $3
        AND pa.deleted_at IS NULL
     RETURNING pa.id`,
    [aliasId, id, wreq.workspaceOwnerId],
  );

  if (!r.rowCount) {
    res.status(404).json({ error: "Alias not found" });
    return;
  }

  res.json({ success: true });
});

// ── Alias governance ──────────────────────────────────────────────────────────

/** POST /api/address-book/places/:id/aliases/:aliasId/approve — owner approves a pending alias. */
router.post("/address-book/places/:id/aliases/:aliasId/approve", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);
  if (!requireOwner(wreq, res)) return;

  const id = String(req.params.id || "").trim();
  const aliasId = String(req.params.aliasId || "").trim();
  if (!isUuid(id) || !isUuid(aliasId)) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const r = await db.query<{ id: string }>(
    `UPDATE place_aliases pa
        SET approval_state = 'approved',
            approved_by    = $1,
            approved_at    = now()
       FROM places p
      WHERE pa.id = $2
        AND pa.place_id = p.id
        AND p.id = $3
        AND p.workspace_owner_id = $4
        AND pa.deleted_at IS NULL
      RETURNING pa.id`,
    [wreq.userEmail ?? wreq.userId ?? null, aliasId, id, wreq.workspaceOwnerId],
  );

  if (!r.rowCount) {
    res.status(404).json({ error: "Alias not found" });
    return;
  }

  await db.query(
    `INSERT INTO place_verification_events
       (place_id, event_type, actor_user_id, actor_name, source, notes)
     VALUES ($1, 'alias_approved', $2, $3, 'manual', $4)`,
    [id, wreq.userId ?? null, wreq.userEmail ?? null, `Alias approved: ${aliasId}`],
  );

  res.json({ success: true });
});

/** POST /api/address-book/places/:id/aliases/:aliasId/reject — owner rejects a pending alias. */
router.post("/address-book/places/:id/aliases/:aliasId/reject", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);
  if (!requireOwner(wreq, res)) return;

  const id = String(req.params.id || "").trim();
  const aliasId = String(req.params.aliasId || "").trim();
  if (!isUuid(id) || !isUuid(aliasId)) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const r = await db.query(
    `UPDATE place_aliases pa
        SET approval_state = 'rejected'
       FROM places p
      WHERE pa.id = $1
        AND pa.place_id = p.id
        AND p.id = $2
        AND p.workspace_owner_id = $3
        AND pa.deleted_at IS NULL
      RETURNING pa.id`,
    [aliasId, id, wreq.workspaceOwnerId],
  );

  if (!r.rowCount) {
    res.status(404).json({ error: "Alias not found" });
    return;
  }

  await db.query(
    `INSERT INTO place_verification_events
       (place_id, event_type, actor_user_id, actor_name, source, notes)
     VALUES ($1, 'alias_rejected', $2, $3, 'manual', $4)`,
    [id, wreq.userId ?? null, wreq.userEmail ?? null, `Alias rejected: ${aliasId}`],
  );

  res.json({ success: true });
});

/** GET /api/address-book/places/:id/aliases/pending — list aliases awaiting owner approval. */
router.get("/address-book/places/:id/aliases/pending", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);
  if (!requireOwner(wreq, res)) return;

  const id = String(req.params.id || "").trim();
  if (!isUuid(id)) {
    res.status(404).json({ error: "Place not found" });
    return;
  }

  const placeCheck = await db.query(
    `SELECT id FROM places WHERE id = $1 AND workspace_owner_id = $2 AND archived_at IS NULL`,
    [id, wreq.workspaceOwnerId],
  );
  if (!placeCheck.rows[0]) {
    res.status(404).json({ error: "Place not found" });
    return;
  }

  const r = await db.query<{
    id: string;
    alias_text: string;
    normalized_alias: string;
    language: string | null;
    source: string;
    created_at: string;
  }>(
    `SELECT id, alias_text, normalized_alias, language, source, created_at
       FROM place_aliases
      WHERE place_id = $1
        AND approval_state = 'pending'
        AND deleted_at IS NULL
      ORDER BY created_at ASC`,
    [id],
  );

  res.json({ aliases: r.rows });
});

// ── Verify place ──────────────────────────────────────────────────────────────

const VerifyPlaceSchema = z.object({
  state: z.enum(["unverified", "estimated", "ai_verified", "staff_verified", "delivery_verified"]),
  notes: z.string().max(2000).optional().nullable(),
  source: z.string().max(50).optional().nullable(),
});

/** POST /api/address-book/places/:id/verify — promote verification state. */
router.post("/address-book/places/:id/verify", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);
  if (!requireOwner(wreq, res)) return;

  const id = String(req.params.id || "").trim();
  if (!isUuid(id)) {
    res.status(404).json({ error: "Place not found" });
    return;
  }

  const parsed = VerifyPlaceSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid input" });
    return;
  }

  const { state, notes, source } = parsed.data;
  const client = await db.connect();
  try {
    await withTransaction(client, async () => {
      const existing = await client.query<{ verification_state: string }>(
        `SELECT verification_state FROM places
          WHERE workspace_owner_id = $1 AND id = $2 AND archived_at IS NULL`,
        [wreq.workspaceOwnerId, id],
      );

      if (!existing.rows[0]) {
        throw Object.assign(new Error("Place not found"), { statusCode: 404 });
      }

      const fromState = existing.rows[0].verification_state;

      await client.query(
        `UPDATE places SET verification_state = $1::place_verification_state, updated_at = now()
          WHERE workspace_owner_id = $2 AND id = $3`,
        [state, wreq.workspaceOwnerId, id],
      );

      await client.query(
        `INSERT INTO place_verification_events
           (place_id, event_type, from_state, to_state, actor_user_id, actor_name, source, notes)
         VALUES ($1, 'state_change', $2::place_verification_state, $3::place_verification_state, $4, $5, $6, $7)`,
        [id, fromState, state, wreq.userId ?? null, wreq.userEmail ?? null, source ?? "manual", notes ?? null],
      );
    });

    res.json({ success: true, verification_state: state });
  } catch (err: unknown) {
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode === 404) {
      res.status(404).json({ error: "Place not found" });
      return;
    }
    logger.error({ err }, "Failed to verify place");
    res.status(500).json({ error: "Internal server error" });
  } finally {
    client.release();
  }
});

// ── Checkout activation ───────────────────────────────────────────────────────

const CHECKOUT_VERIFIED_STATES = new Set(["ai_verified", "staff_verified", "delivery_verified"]);

type CheckoutPlaceRow = {
  id: string;
  verification_state: string;
  location_conflict: boolean;
  latitude: string | null;
  longitude: string | null;
  checkout_ready: boolean;
};

function checkoutBlockingReasons(place: CheckoutPlaceRow): string[] {
  const blockingReasons: string[] = [];

  if (!CHECKOUT_VERIFIED_STATES.has(place.verification_state)) {
    blockingReasons.push(
      `verification_state must be ai_verified, staff_verified, or delivery_verified (current: ${place.verification_state})`,
    );
  }
  if (place.location_conflict) {
    blockingReasons.push("location_conflict must be resolved before activating checkout");
  }
  if (place.latitude == null || place.longitude == null) {
    blockingReasons.push("coordinates (latitude and longitude) must be set");
  }

  return blockingReasons;
}

/**
 * POST /api/address-book/places/activate-checkout
 * Activates checkout for every active, safe place in the current workspace.
 * Already-active places are counted but never rewritten. Every newly activated
 * place gets the same timestamp, actor fields, and audit event as the
 * individual activation route.
 */
router.post("/address-book/places/activate-checkout", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);
  if (!requireOwner(wreq, res)) return;

  let client: pg.PoolClient | undefined;
  try {
    client = (await db.connect()) as pg.PoolClient;
    const transactionClient: pg.PoolClient = client;
    const result = await withTransaction(transactionClient, async () => {
      const transactionResult = {
        activated: 0,
        already_active: 0,
        skipped: 0,
        blockers: {
          verification_state: 0,
          location_conflict: 0,
          coordinates: 0,
        },
      };
      const places = await transactionClient.query<CheckoutPlaceRow>(
        `SELECT id, verification_state, location_conflict, latitude, longitude, checkout_ready
           FROM places
          WHERE workspace_owner_id = $1 AND archived_at IS NULL
          FOR UPDATE`,
        [wreq.workspaceOwnerId],
      );

      for (const place of places.rows) {
        if (place.checkout_ready) {
          transactionResult.already_active++;
          continue;
        }

        const blockingReasons = checkoutBlockingReasons(place);
        if (blockingReasons.length > 0) {
          transactionResult.skipped++;
          if (!CHECKOUT_VERIFIED_STATES.has(place.verification_state)) {
            transactionResult.blockers.verification_state++;
          }
          if (place.location_conflict) {
            transactionResult.blockers.location_conflict++;
          }
          if (place.latitude == null || place.longitude == null) {
            transactionResult.blockers.coordinates++;
          }
          continue;
        }

        await transactionClient.query(
          `UPDATE places
              SET checkout_ready = true,
                  verified_at    = now(),
                  verified_by    = $1,
                  updated_at     = now()
            WHERE workspace_owner_id = $2 AND id = $3`,
          [wreq.userEmail ?? wreq.userId ?? null, wreq.workspaceOwnerId, place.id],
        );
        await transactionClient.query(
          `INSERT INTO place_verification_events
             (place_id, event_type, from_state, to_state, actor_user_id, actor_name, source, notes)
           VALUES ($1, 'checkout_activated', $2::place_verification_state, $2::place_verification_state, $3, $4, 'manual', 'Checkout activated by owner')`,
          [place.id, place.verification_state, wreq.userId ?? null, wreq.userEmail ?? null],
        );
        transactionResult.activated++;
      }

      return transactionResult;
    });

    res.json({ success: true, ...result });
  } catch (err) {
    logger.error({ err }, "Failed to bulk activate checkout");
    res.status(500).json({ error: "Internal server error" });
  } finally {
    client?.release();
  }
});

/**
 * POST /api/address-book/places/:id/activate-checkout
 * Sets checkout_ready = true when all gate conditions are satisfied:
 *   - verification_state is AI, staff, or delivery verified
 *   - location_conflict is false
 *   - coordinates (latitude + longitude) are present
 * Returns a structured list of blocking reasons when any condition fails.
 */
router.post("/address-book/places/:id/activate-checkout", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);
  if (!requireOwner(wreq, res)) return;

  const id = String(req.params.id || "").trim();
  if (!isUuid(id)) {
    res.status(404).json({ error: "Place not found" });
    return;
  }

  const placeRes = await db.query<{
    verification_state: string;
    location_conflict: boolean;
    latitude: string | null;
    longitude: string | null;
    checkout_ready: boolean;
  }>(
    `SELECT verification_state, location_conflict, latitude, longitude, checkout_ready
       FROM places
      WHERE workspace_owner_id = $1 AND id = $2 AND archived_at IS NULL`,
    [wreq.workspaceOwnerId, id],
  );

  if (!placeRes.rows[0]) {
    res.status(404).json({ error: "Place not found" });
    return;
  }

  const place = placeRes.rows[0];
  if (place.checkout_ready) {
    res.json({ success: true, already_active: true });
    return;
  }
  const blockingReasons = checkoutBlockingReasons({ id, ...place });

  if (blockingReasons.length > 0) {
    res.status(422).json({ error: "Place cannot be activated for checkout", blocking_reasons: blockingReasons });
    return;
  }

  const client = await db.connect();
  try {
    await withTransaction(client, async () => {
      await client.query(
        `UPDATE places
            SET checkout_ready = true,
                verified_at    = now(),
                verified_by    = $1,
                updated_at     = now()
          WHERE workspace_owner_id = $2 AND id = $3`,
        [wreq.userEmail ?? wreq.userId ?? null, wreq.workspaceOwnerId, id],
      );
      await client.query(
        `INSERT INTO place_verification_events
           (place_id, event_type, from_state, to_state, actor_user_id, actor_name, source, notes)
         VALUES ($1, 'checkout_activated', $2::place_verification_state, $2::place_verification_state, $3, $4, 'manual', 'Checkout activated by owner')`,
        [id, place.verification_state, wreq.userId ?? null, wreq.userEmail ?? null],
      );
    });
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "Failed to activate checkout");
    res.status(500).json({ error: "Internal server error" });
  } finally {
    client.release();
  }
});

/**
 * POST /api/address-book/places/:id/deactivate-checkout
 * Clears checkout_ready and appends a verification event.
 */
router.post("/address-book/places/:id/deactivate-checkout", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);
  if (!requireOwner(wreq, res)) return;

  const id = String(req.params.id || "").trim();
  if (!isUuid(id)) {
    res.status(404).json({ error: "Place not found" });
    return;
  }

  const existing = await db.query<{ verification_state: string }>(
    `SELECT verification_state FROM places
      WHERE workspace_owner_id = $1 AND id = $2 AND archived_at IS NULL`,
    [wreq.workspaceOwnerId, id],
  );
  if (!existing.rows[0]) {
    res.status(404).json({ error: "Place not found" });
    return;
  }

  const client = await db.connect();
  try {
    await withTransaction(client, async () => {
      await client.query(
        `UPDATE places SET checkout_ready = false, updated_at = now()
          WHERE workspace_owner_id = $1 AND id = $2`,
        [wreq.workspaceOwnerId, id],
      );
      await client.query(
        `INSERT INTO place_verification_events
           (place_id, event_type, from_state, to_state, actor_user_id, actor_name, source, notes)
         VALUES ($1, 'checkout_deactivated', $2::place_verification_state, $2::place_verification_state, $3, $4, 'manual', 'Checkout deactivated by owner')`,
        [id, existing.rows[0].verification_state, wreq.userId ?? null, wreq.userEmail ?? null],
      );
    });
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "Failed to deactivate checkout");
    res.status(500).json({ error: "Internal server error" });
  } finally {
    client.release();
  }
});

// ── Provider comparison ───────────────────────────────────────────────────────

/**
 * POST /api/address-book/places/:id/compare-provider
 * Read-only: runs the AI-assess + geocoder path without saving any coordinates.
 * Returns the current stored pin, the provider suggestion (address + coordinates),
 * distance between them, locality-match result, and prior successful-delivery
 * order references from order_place_links.
 */
router.post("/address-book/places/:id/compare-provider", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);
  if (!requireOwner(wreq, res)) return;

  const id = String(req.params.id || "").trim();
  if (!isUuid(id)) {
    res.status(404).json({ error: "Place not found" });
    return;
  }

  const placeRes = await db.query<{
    canonical_name: string;
    canonical_address: string | null;
    area: string | null;
    city_name: string | null;
    country_code: string | null;
    latitude: string | null;
    longitude: string | null;
  }>(
    `SELECT p.canonical_name, p.canonical_address, p.area, p.latitude, p.longitude,
            dc.name AS city_name, dc.country_code
       FROM places p
       LEFT JOIN delivery_cities dc ON dc.id = p.city_id
      WHERE p.id = $1 AND p.workspace_owner_id = $2 AND p.archived_at IS NULL`,
    [id, wreq.workspaceOwnerId],
  );

  if (!placeRes.rows[0]) {
    res.status(404).json({ error: "Place not found" });
    return;
  }

  const place = placeRes.rows[0];

  const [aliasRes, deliveryRes] = await Promise.all([
    db.query<{ alias_text: string }>(
      `SELECT alias_text FROM place_aliases WHERE place_id = $1 AND deleted_at IS NULL`,
      [id],
    ),
    db.query<{
      order_id: string;
      display_order_number: string;
      ordered_at: string | null;
      linked_at: string;
    }>(
      `SELECT opl.order_id, opl.linked_at,
              COALESCE(o.display_order_number, o.external_order_id, o.id::text) AS display_order_number,
              o.ordered_at
         FROM order_place_links opl
         JOIN orders o ON o.id = opl.order_id
        WHERE opl.place_id = $1
          AND opl.workspace_owner_id = $2
          AND o.workspace_owner_id = $2
          AND o.status = 'completed'
        ORDER BY opl.linked_at DESC
        LIMIT 5`,
      [id, wreq.workspaceOwnerId],
    ),
  ]);

  const aliases = aliasRes.rows.map((r) => r.alias_text);
  const context = {
    workspaceOwnerId: wreq.workspaceOwnerId,
    canonicalAddress: place.canonical_address,
    area: place.area,
    city: place.city_name,
    country: place.country_code,
  };

  try {
    // AI assessment (read-only — no DB writes)
    const assessment = await assessPlaceValidity(place.canonical_name, aliases, context);

    // Geocoder lookup (read-only — no DB writes)
    const providerResult = await geocodeAddress(place.canonical_name, context, assessment.locationHints);

    const currentLat = place.latitude != null ? parseFloat(place.latitude) : null;
    const currentLng = place.longitude != null ? parseFloat(place.longitude) : null;

    let distanceKm: number | null = null;
    if (providerResult && currentLat != null && currentLng != null) {
      distanceKm = Math.round(
        haversineDistanceKm(currentLat, currentLng, providerResult.lat, providerResult.lng) * 100,
      ) / 100;
    }

    let localityMatch: boolean | null = null;
    if (providerResult) {
      const conflictCheck = await checkPlaceLocationConflict({
        latitude: providerResult.lat,
        longitude: providerResult.lng,
        cityName: place.city_name,
        countryCode: place.country_code,
      });
      localityMatch = !conflictCheck.conflict;
    }

    res.json({
      current_pin: currentLat != null && currentLng != null
        ? { latitude: currentLat, longitude: currentLng }
        : null,
      provider_suggestion: providerResult
        ? {
            latitude: providerResult.lat,
            longitude: providerResult.lng,
            matched_location: providerResult.matchedLocation,
            match_type: providerResult.matchType,
            precision: providerResult.precision,
            verification_method: providerResult.method,
            query: providerResult.query,
          }
        : null,
      distance_km: distanceKm,
      locality_match: localityMatch,
      delivery_history: deliveryRes.rows,
    });
  } catch (err) {
    logger.error({ err, placeId: id }, "compare-provider: failed");
    res.status(500).json({ error: "Provider comparison failed" });
  }
});

/**
 * POST /api/address-book/accuracy-audit
 *
 * Owner-only, read-only audit of historical ai_verified places. This runs the
 * current assessor/geocoder and returns review classifications, but it never
 * updates places, verification events, checkout readiness, or any audit row.
 */
router.post("/address-book/accuracy-audit", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);
  if (!requireOwner(wreq, res)) return;

  const parsed = z.object({
    limit: z.number().int().min(1).max(500).optional().default(100),
  }).safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid input" });
    return;
  }

  try {
    const report = await auditExistingAiVerifiedPlaces({
      workspaceId: wreq.workspaceOwnerId,
      limit: parsed.data.limit,
    });
    res.json(report);
  } catch (err) {
    logger.error({ err, workspaceId: wreq.workspaceOwnerId }, "address-book accuracy audit failed");
    res.status(500).json({ error: "Accuracy audit failed" });
  }
});

/** Owner-only, one-shot connectivity probe; it never uses customer addresses or writes records. */
router.post("/address-book/provider-diagnostics", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);
  if (!requireOwner(wreq, res)) return;
  res.setHeader("Cache-Control", "no-store");
  try {
    res.json({
      checked_at: new Date().toISOString(),
      providers: await diagnoseMapProviders(),
    });
  } catch (err) {
    logger.error({ err, workspaceId: wreq.workspaceOwnerId }, "Address Book provider diagnostics failed");
    res.status(503).json({ error: "Provider diagnostics could not complete" });
  }
});

// ── Delivery history ──────────────────────────────────────────────────────────

/**
 * GET /api/address-book/places/:id/delivery-history
 * Returns the most recent N confirmed (status = completed) delivery orders
 * linked to this place via order_place_links.
 *
 * Each row includes a `coordinates` field with the best available GPS pin
 * for that delivery, resolved in priority order:
 *   1. Driver-confirmed GPS from fleet_proof_of_delivery (most accurate)
 *   2. The place's current saved latitude/longitude (fallback)
 *   3. null — no usable coordinates for this delivery row
 *
 * The modal filters out rows where `coordinates` is null before presenting
 * them as usable "Use this pin" candidates.
 */
router.get("/address-book/places/:id/delivery-history", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);
  if (!requireOwner(wreq, res)) return;

  const id = String(req.params.id || "").trim();
  if (!isUuid(id)) {
    res.status(404).json({ error: "Place not found" });
    return;
  }

  const limitParam = Math.min(50, Math.max(1, parseInt((req.query.limit as string) || "20", 10)));

  const placeCheck = await db.query<{ latitude: string | null; longitude: string | null }>(
    `SELECT latitude, longitude FROM places
      WHERE id = $1 AND workspace_owner_id = $2 AND archived_at IS NULL`,
    [id, wreq.workspaceOwnerId],
  );
  if (!placeCheck.rows[0]) {
    res.status(404).json({ error: "Place not found" });
    return;
  }

  const placeLat = placeCheck.rows[0].latitude != null ? parseFloat(placeCheck.rows[0].latitude) : null;
  const placeLng = placeCheck.rows[0].longitude != null ? parseFloat(placeCheck.rows[0].longitude) : null;
  const placeCoords = placeLat != null && placeLng != null
    ? { latitude: placeLat, longitude: placeLng }
    : null;

  const r = await db.query<{
    order_id: string;
    display_order_number: string;
    ordered_at: string | null;
    linked_at: string;
    pod_lat: string | null;
    pod_lng: string | null;
  }>(
    `SELECT opl.order_id, opl.linked_at,
            COALESCE(o.display_order_number, o.external_order_id, o.id::text) AS display_order_number,
            o.ordered_at,
            pod.latitude  AS pod_lat,
            pod.longitude AS pod_lng
       FROM order_place_links opl
       JOIN orders o ON o.id = opl.order_id
       -- Join to driver assignment (native order_id UUID link added in migration 8567)
       LEFT JOIN fleet_driver_order_assignments fdoa
         ON fdoa.order_id = opl.order_id
        AND fdoa.workspace_owner_id = $2
       -- Lateral subquery: first proof-of-delivery GPS for this assignment
       LEFT JOIN LATERAL (
         SELECT pod2.latitude, pod2.longitude
           FROM fleet_proof_of_delivery pod2
          WHERE pod2.assignment_id = fdoa.id
            AND pod2.latitude  IS NOT NULL
            AND pod2.longitude IS NOT NULL
          ORDER BY pod2.id DESC
          LIMIT 1
       ) pod ON true
      WHERE opl.place_id = $1
        AND opl.workspace_owner_id = $2
        AND o.workspace_owner_id = $2
        AND o.status = 'completed'
      ORDER BY opl.linked_at DESC
      LIMIT $3`,
    [id, wreq.workspaceOwnerId, limitParam],
  );

  res.json({
    deliveries: r.rows.map((row) => {
      // Prefer driver-confirmed GPS; fall back to place's current pin
      const driverLat = row.pod_lat != null ? parseFloat(row.pod_lat) : null;
      const driverLng = row.pod_lng != null ? parseFloat(row.pod_lng) : null;
      const coordinates =
        driverLat != null && driverLng != null
          ? { latitude: driverLat, longitude: driverLng }
          : placeCoords;
      return {
        order_id: row.order_id,
        display_order_number: row.display_order_number,
        ordered_at: row.ordered_at,
        linked_at: row.linked_at,
        coordinates,
      };
    }),
    place_coordinates: placeCoords,
  });
});

// ── Duplicate detection ───────────────────────────────────────────────────────

/**
 * GET /api/address-book/places/:id/duplicates
 * Candidate duplicates: exact canonical-name match plus, for institution types
 * (hospital/hotel), any same-type place with string similarity ≥ 0.75.
 * Each result includes a `matchType` field ("exact" | "similar").
 */
router.get("/address-book/places/:id/duplicates", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);
  const id = String(req.params.id || "").trim();
  if (!isUuid(id)) {
    res.status(404).json({ error: "Place not found" });
    return;
  }

  const source = await db.query<{ canonical_name: string; city_id: number | null; place_type: string }>(
    `SELECT canonical_name, city_id, place_type FROM places
      WHERE id = $1 AND workspace_owner_id = $2 AND archived_at IS NULL`,
    [id, wreq.workspaceOwnerId],
  );

  if (!source.rows[0]) {
    res.status(404).json({ error: "Place not found" });
    return;
  }

  const { canonical_name, place_type } = source.rows[0];

  const exactCandidates = await db.query<{
    id: string; canonical_name: string; place_type: string; area: string | null;
    city_id: number | null; city_name: string | null; verification_state: string;
    created_at: string; delivery_count: number;
  }>(
    `SELECT p.id, p.canonical_name, p.place_type, p.area, p.city_id, dc.name AS city_name,
            p.verification_state, p.created_at,
            (SELECT COUNT(*) FROM order_place_links opl WHERE opl.place_id = p.id)::int AS delivery_count
       FROM places p
       LEFT JOIN delivery_cities dc ON dc.id = p.city_id
      WHERE p.workspace_owner_id = $1
        AND p.id <> $2
        AND p.archived_at IS NULL
        AND lower(p.canonical_name) = lower($3)
      ORDER BY p.created_at ASC`,
    [wreq.workspaceOwnerId, id, canonical_name],
  );

  type DuplicateRow = (typeof exactCandidates.rows)[number] & { matchType: "exact" | "similar" };
  const exactIds = new Set(exactCandidates.rows.map((r) => r.id));
  const duplicates: DuplicateRow[] = exactCandidates.rows.map((r) => ({ ...r, matchType: "exact" as const }));

  // For institution types, also surface fuzzy-similar places of the same type.
  const INSTITUTION_TYPES = new Set(["hospital", "hotel"]);
  if (INSTITUTION_TYPES.has(place_type)) {
    const FUZZY_THRESHOLD = 0.75;
    const normalizedSource = normalizePlaceName(canonical_name);

    const typedPlaces = await db.query<{
      id: string; canonical_name: string; place_type: string; area: string | null;
      city_id: number | null; city_name: string | null; verification_state: string;
      created_at: string; delivery_count: number;
    }>(
      `SELECT p.id, p.canonical_name, p.place_type, p.area, p.city_id, dc.name AS city_name,
              p.verification_state, p.created_at,
              (SELECT COUNT(*) FROM order_place_links opl WHERE opl.place_id = p.id)::int AS delivery_count
         FROM places p
         LEFT JOIN delivery_cities dc ON dc.id = p.city_id
        WHERE p.workspace_owner_id = $1
          AND p.id <> $2
          AND p.archived_at IS NULL
          AND p.place_type = $3
        ORDER BY p.created_at ASC`,
      [wreq.workspaceOwnerId, id, place_type],
    );

    for (const row of typedPlaces.rows) {
      if (exactIds.has(row.id)) continue;
      const sim = stringSimilarity(normalizedSource, normalizePlaceName(row.canonical_name));
      if (sim >= FUZZY_THRESHOLD) {
        duplicates.push({ ...row, matchType: "similar" });
      }
    }
  }

  res.json({ duplicates });
});

// ── Merge places ──────────────────────────────────────────────────────────────

const MergePlaceSchema = z.object({
  survivor_id: z.string().uuid("survivor_id must be a valid UUID"),
  notes: z.string().max(2000).optional().nullable(),
});

/**
 * POST /api/address-book/places/:id/merge
 * Merges :id (loser) into survivor_id. Moves aliases, contact links, and order
 * links; records a merge audit event; archives the loser. All in one transaction.
 */
router.post("/address-book/places/:id/merge", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);
  if (!requireOwner(wreq, res)) return;

  const loserId = String(req.params.id || "").trim();
  if (!isUuid(loserId)) {
    res.status(404).json({ error: "Place not found" });
    return;
  }

  const parsed = MergePlaceSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid input" });
    return;
  }

  const { survivor_id: survivorId, notes } = parsed.data;

  if (loserId === survivorId) {
    res.status(400).json({ error: "Cannot merge a place into itself" });
    return;
  }

  const client = await db.connect();
  try {
    await withTransaction(client, async () => {
      // Verify both places belong to the workspace
      const places = await client.query<{ id: string; verification_state: string }>(
        `SELECT id, verification_state FROM places
          WHERE id = ANY($1::uuid[]) AND workspace_owner_id = $2 AND archived_at IS NULL`,
        [[loserId, survivorId], wreq.workspaceOwnerId],
      );

      if (places.rows.length !== 2) {
        throw Object.assign(new Error("One or both places not found"), { statusCode: 404 });
      }

      const loserState = places.rows.find((r) => r.id === loserId)!.verification_state;

      // Move aliases (skip if normalized duplicate exists on survivor)
      const loserAliases = await client.query<{
        alias_text: string;
        normalized_alias: string;
        language: string | null;
        source: string;
        approval_state: string;
      }>(
        `SELECT alias_text, normalized_alias, language, source, approval_state FROM place_aliases
          WHERE place_id = $1 AND deleted_at IS NULL`,
        [loserId],
      );

      for (const alias of loserAliases.rows) {
        await client.query(
          `INSERT INTO place_aliases
             (place_id, alias_text, normalized_alias, language, source, approval_state)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (place_id, normalized_alias) DO NOTHING`,
          [
            survivorId,
            alias.alias_text,
            alias.normalized_alias,
            alias.language,
            alias.source,
            alias.approval_state,
          ],
        );
      }

      // Relink contact_addresses to survivor
      await client.query(
        `UPDATE contact_addresses SET place_id = $1 WHERE place_id = $2`,
        [survivorId, loserId],
      );

      // Relink order_place_links to survivor (skip conflict — order already linked to survivor)
      await client.query(
        `UPDATE order_place_links SET place_id = $1
          WHERE place_id = $2
            AND order_id NOT IN (SELECT order_id FROM order_place_links WHERE place_id = $1)`,
        [survivorId, loserId],
      );

      // Move existing verification events (preserve history)
      await client.query(
        `UPDATE place_verification_events SET place_id = $1 WHERE place_id = $2`,
        [survivorId, loserId],
      );

      // Record merge audit event on the survivor
      await client.query(
        `INSERT INTO place_verification_events
           (place_id, event_type, from_state, to_state, actor_user_id, actor_name, source, notes, metadata)
         VALUES ($1, 'merge', $2::place_verification_state, $2::place_verification_state, $3, $4, 'manual', $5, $6)`,
        [
          survivorId,
          loserState,
          wreq.userId ?? null,
          wreq.userEmail ?? null,
          notes ?? null,
          JSON.stringify({ merged_place_id: loserId }),
        ],
      );

      // Archive the loser
      await client.query(
        `UPDATE places SET archived_at = now(), updated_at = now() WHERE id = $1`,
        [loserId],
      );
    });

    res.json({ success: true, survivor_id: survivorId });
  } catch (err: unknown) {
    const e = err as { statusCode?: number };
    if (e.statusCode === 404) {
      res.status(404).json({ error: "One or both places not found" });
      return;
    }
    logger.error({ err }, "Failed to merge places");
    res.status(500).json({ error: "Internal server error" });
  } finally {
    client.release();
  }
});

// ── Place contact sync ────────────────────────────────────────────────────────

/**
 * POST /api/address-book/places/:id/sync-contacts
 * Owner-only. Walk every order linked to this place, resolve the
 * recipient/customer contacts, and upsert the missing contact_addresses +
 * order_place_contact_links rows.  Idempotent — already-linked contacts are
 * left untouched.  Returns { synced_contacts: N }.
 */
router.post("/address-book/places/:id/sync-contacts", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);
  if (!requireOwner(wreq, res)) return;

  const placeId = String(req.params.id || "").trim();
  if (!isUuid(placeId)) {
    res.status(404).json({ error: "Place not found" });
    return;
  }

  // Verify place belongs to workspace
  const placeCheck = await db.query<{ id: string; area: string | null; city_id: number | null }>(
    `SELECT id, area, city_id FROM places WHERE id = $1 AND workspace_owner_id = $2 AND archived_at IS NULL`,
    [placeId, wreq.workspaceOwnerId],
  );
  if (!placeCheck.rows[0]) {
    res.status(404).json({ error: "Place not found" });
    return;
  }

  const { area, city_id: cityId } = placeCheck.rows[0];

  // Fetch all orders linked to this place
  const linkedOrders = await db.query<{ order_id: string; delivery_address: string }>(
    `SELECT opl.order_id, o.delivery_address
       FROM order_place_links opl
       JOIN orders o ON o.id = opl.order_id
      WHERE opl.place_id = $1
        AND o.workspace_owner_id = $2`,
    [placeId, wreq.workspaceOwnerId],
  );

  const syncedSet = new Set<string>();

  for (const row of linkedOrders.rows) {
    try {
      const contactIds = await resolveOrderDeliveryContacts(row.order_id, wreq.workspaceOwnerId);
      if (contactIds.length === 0) continue;

      await syncOrderDeliveryContactPlaceLinks({
        workspaceId: wreq.workspaceOwnerId,
        orderId: row.order_id,
        placeId,
        contactIds,
        rawAddress: row.delivery_address ?? "",
        area,
        cityId,
      });

      for (const id of contactIds) syncedSet.add(id);
    } catch (err) {
      logger.warn({ err, orderId: row.order_id, placeId }, "Skipped order during place contact sync");
    }
  }

  res.json({ synced_contacts: syncedSet.size });
});

// ── Contact addresses ─────────────────────────────────────────────────────────

/**
 * GET /api/contact-addresses?contact_id=<uuid>
 * List all non-archived addresses for a contact.
 */
router.get("/contact-addresses", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);
  const contactId = ((req.query.contact_id as string) || "").trim();

  if (!isUuid(contactId)) {
    res.status(400).json({ error: "contact_id must be a valid UUID" });
    return;
  }

  // Validate contact belongs to workspace
  const contactCheck = await db.query<{ id: string }>(
    `SELECT id FROM contacts WHERE id = $1 AND workspace_owner_id = $2`,
    [contactId, wreq.workspaceOwnerId],
  );
  if (!contactCheck.rows[0]) {
    res.status(404).json({ error: "Contact not found" });
    return;
  }

  const r = await db.query(
    `SELECT ca.id, ca.contact_id, ca.place_id, ca.label, ca.raw_address,
            ca.area, ca.city_id, dc.name AS city_name,
            ca.latitude, ca.longitude, ca.entrance_notes, ca.is_default,
            ca.created_at, ca.updated_at,
            p.canonical_name AS place_canonical_name
       FROM contact_addresses ca
       LEFT JOIN delivery_cities dc ON dc.id = ca.city_id
       LEFT JOIN places p ON p.id = ca.place_id
      WHERE ca.contact_id = $1 AND ca.archived_at IS NULL
      ORDER BY ca.is_default DESC, ca.created_at DESC`,
    [contactId],
  );

  res.json({ addresses: r.rows });
});

const ContactAddressSchema = z.object({
  contact_id: z.string().uuid(),
  place_id: z.string().uuid().optional().nullable(),
  label: z.string().max(200).optional().nullable(),
  raw_address: z.string().max(1000).optional().nullable(),
  area: z.string().max(200).optional().nullable(),
  city_id: z.number().int().positive().optional().nullable(),
  latitude: z.number().min(-90).max(90).optional().nullable(),
  longitude: z.number().min(-180).max(180).optional().nullable(),
  entrance_notes: z.string().max(2000).optional().nullable(),
  is_default: z.boolean().optional().default(false),
});

/** POST /api/contact-addresses — create a contact address. */
router.post("/contact-addresses", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);
  if (!requireOwner(wreq, res)) return;

  const parsed = ContactAddressSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid input" });
    return;
  }

  const d = parsed.data;

  // Validate contact belongs to workspace
  const contactCheck = await db.query<{ id: string }>(
    `SELECT id FROM contacts WHERE id = $1 AND workspace_owner_id = $2`,
    [d.contact_id, wreq.workspaceOwnerId],
  );
  if (!contactCheck.rows[0]) {
    res.status(404).json({ error: "Contact not found" });
    return;
  }

  const translatedRawAddress = await translateAddressField(d.raw_address, wreq.workspaceOwnerId);
  const client = await db.connect();
  try {
    const row = await withTransaction(client, async () => {
      // If is_default, clear other defaults for this contact
      if (d.is_default) {
        await client.query(
          `UPDATE contact_addresses SET is_default = false
            WHERE contact_id = $1 AND archived_at IS NULL`,
          [d.contact_id],
        );
      }

      const r = await client.query<{ id: string }>(
        `INSERT INTO contact_addresses
           (workspace_owner_id, contact_id, place_id, label, raw_address,
            area, city_id, latitude, longitude, entrance_notes, is_default)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING id`,
        [
          wreq.workspaceOwnerId,
          d.contact_id,
          d.place_id ?? null,
          d.label ?? null,
          translatedRawAddress.value ?? null,
          d.area ?? null,
          d.city_id ?? null,
          d.latitude ?? null,
          d.longitude ?? null,
          d.entrance_notes ?? null,
          d.is_default,
        ],
      );
      return r.rows[0];
    });

    res.status(201).json({ address: row });
  } catch (err) {
    logger.error({ err }, "Failed to create contact address");
    res.status(500).json({ error: "Internal server error" });
  } finally {
    client.release();
  }
});

const UpdateContactAddressSchema = z.object({
  place_id: z.string().uuid().optional().nullable(),
  label: z.string().max(200).optional().nullable(),
  raw_address: z.string().max(1000).optional().nullable(),
  area: z.string().max(200).optional().nullable(),
  city_id: z.number().int().positive().optional().nullable(),
  latitude: z.number().min(-90).max(90).optional().nullable(),
  longitude: z.number().min(-180).max(180).optional().nullable(),
  entrance_notes: z.string().max(2000).optional().nullable(),
  is_default: z.boolean().optional(),
});

/** PUT /api/contact-addresses/:id — update a contact address. */
router.put("/contact-addresses/:id", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);
  if (!requireOwner(wreq, res)) return;

  const id = String(req.params.id || "").trim();
  if (!isUuid(id)) {
    res.status(404).json({ error: "Address not found" });
    return;
  }

  const parsed = UpdateContactAddressSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid input" });
    return;
  }

  const d = parsed.data;

  // Verify address belongs to workspace
  const existing = await db.query<{ id: string; contact_id: string }>(
    `SELECT ca.id, ca.contact_id FROM contact_addresses ca
       JOIN contacts c ON c.id = ca.contact_id
      WHERE ca.id = $1 AND c.workspace_owner_id = $2 AND ca.archived_at IS NULL`,
    [id, wreq.workspaceOwnerId],
  );
  if (!existing.rows[0]) {
    res.status(404).json({ error: "Address not found" });
    return;
  }

  const { contact_id } = existing.rows[0];
  const translatedRawAddress = "raw_address" in d
    ? await translateAddressField(d.raw_address, wreq.workspaceOwnerId)
    : { value: undefined, original: null };
  const client = await db.connect();
  try {
    await withTransaction(client, async () => {
      if (d.is_default) {
        await client.query(
          `UPDATE contact_addresses SET is_default = false
            WHERE contact_id = $1 AND archived_at IS NULL AND id <> $2`,
          [contact_id, id],
        );
      }

      const sets: string[] = ["updated_at = now()"];
      const params: unknown[] = [id];
      let idx = 2;

      if ("place_id" in d) { sets.push(`place_id = $${idx++}`); params.push(d.place_id ?? null); }
      if ("label" in d) { sets.push(`label = $${idx++}`); params.push(d.label ?? null); }
      if ("raw_address" in d) {
        sets.push(`raw_address = $${idx++}`);
        params.push(translatedRawAddress.value ?? null);
      }
      if ("area" in d) { sets.push(`area = $${idx++}`); params.push(d.area ?? null); }
      if ("city_id" in d) { sets.push(`city_id = $${idx++}`); params.push(d.city_id ?? null); }
      if ("latitude" in d) { sets.push(`latitude = $${idx++}`); params.push(d.latitude ?? null); }
      if ("longitude" in d) { sets.push(`longitude = $${idx++}`); params.push(d.longitude ?? null); }
      if ("entrance_notes" in d) { sets.push(`entrance_notes = $${idx++}`); params.push(d.entrance_notes ?? null); }
      if (d.is_default !== undefined) { sets.push(`is_default = $${idx++}`); params.push(d.is_default); }

      if (sets.length > 1) {
        // A staff edit makes this saved address authoritative. Later order
        // corrections may retire only untouched automatic associations.
        sets.push("auto_linked = false");
        await client.query(
          `UPDATE contact_addresses SET ${sets.join(", ")} WHERE id = $1`,
          params,
        );
      }
    });

    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, "Failed to update contact address");
    res.status(500).json({ error: "Internal server error" });
  } finally {
    client.release();
  }
});

/** PUT /api/contact-addresses/:id/archive — soft-delete a contact address. */
router.put("/contact-addresses/:id/archive", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);
  if (!requireOwner(wreq, res)) return;

  const id = String(req.params.id || "").trim();
  if (!isUuid(id)) {
    res.status(404).json({ error: "Address not found" });
    return;
  }

  const r = await db.query(
    `UPDATE contact_addresses ca
        SET archived_at = now(), updated_at = now()
       FROM contacts c
      WHERE ca.id = $1
        AND ca.contact_id = c.id
        AND c.workspace_owner_id = $2
        AND ca.archived_at IS NULL
     RETURNING ca.id`,
    [id, wreq.workspaceOwnerId],
  );

  if (!r.rowCount) {
    res.status(404).json({ error: "Address not found or already archived" });
    return;
  }

  res.json({ success: true });
});

// ── Order links ───────────────────────────────────────────────────────────────

const OrderLinkSchema = z.object({
  place_id: z.string().uuid(),
});

/**
 * PUT /api/order-links/:orderId — link or relink an order to a place.
 * Never touches the immutable orders.delivery_address column.
 */
router.put("/order-links/:orderId", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);
  if (!requireOwner(wreq, res)) return;

  const orderId = String(req.params.orderId || "").trim();
  if (!isUuid(orderId)) {
    res.status(404).json({ error: "Order not found" });
    return;
  }

  const parsed = OrderLinkSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid input" });
    return;
  }

  const { place_id } = parsed.data;

  // Validate both order and place belong to workspace
  const [orderCheck, placeCheck] = await Promise.all([
    db.query<{ id: string }>(
      `SELECT id FROM orders WHERE id = $1 AND workspace_owner_id = $2`,
      [orderId, wreq.workspaceOwnerId],
    ),
    db.query<{ id: string; checkout_ready: boolean }>(
      `SELECT id, checkout_ready FROM places WHERE id = $1 AND workspace_owner_id = $2 AND archived_at IS NULL`,
      [place_id, wreq.workspaceOwnerId],
    ),
  ]);

  if (!orderCheck.rows[0]) {
    res.status(404).json({ error: "Order not found" });
    return;
  }
  if (!placeCheck.rows[0]) {
    res.status(404).json({ error: "Place not found" });
    return;
  }
  if (!placeCheck.rows[0].checkout_ready) {
    res.status(422).json({
      error: "This place is not activated for checkout. Verify the place and activate checkout before linking orders to it.",
    });
    return;
  }

  await db.query(
    `INSERT INTO order_place_links (workspace_owner_id, order_id, place_id, linked_by_user_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (order_id) DO UPDATE SET place_id = EXCLUDED.place_id,
                                           linked_by_user_id = EXCLUDED.linked_by_user_id,
                                           linked_at = now()`,
    [wreq.workspaceOwnerId, orderId, place_id, wreq.userId ?? null],
  );

  // Fire contact sync non-blocking — a sync failure must never roll back the link.
  (async () => {
    try {
      const [orderRow, placeRow] = await Promise.all([
        db.query<{ delivery_address: string }>(
          `SELECT delivery_address FROM orders WHERE id = $1`,
          [orderId],
        ),
        db.query<{ area: string | null; city_id: number | null }>(
          `SELECT area, city_id FROM places WHERE id = $1`,
          [place_id],
        ),
      ]);
      const rawAddress = orderRow.rows[0]?.delivery_address ?? "";
      const area = placeRow.rows[0]?.area ?? null;
      const cityId = placeRow.rows[0]?.city_id ?? null;

      const contactIds = await resolveOrderDeliveryContacts(orderId, wreq.workspaceOwnerId);
      if (contactIds.length > 0) {
        await syncOrderDeliveryContactPlaceLinks({
          workspaceId: wreq.workspaceOwnerId,
          orderId,
          placeId: place_id,
          contactIds,
          rawAddress,
          area,
          cityId,
        });
      }
    } catch (err) {
      logger.warn({ err, orderId, placeId: place_id }, "Contact sync after order-link failed (non-fatal)");
    }
  })();

  res.json({ success: true });
});

// ── Address Book import (backfill trigger) ────────────────────────────────────

const ImportRunSchema = z.object({
  dry_run: z.boolean().optional().default(false),
});

/**
 * POST /api/address-book/import/run
 * Admin-only endpoint that triggers the historical backfill job for the
 * requesting workspace.  Accepts { dry_run: boolean } and returns the
 * BackfillSummary JSON.  Long-running — typical runtimes are seconds to a
 * few minutes depending on order volume.
 */
router.post("/address-book/import/run", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);
  if (!requireOwner(wreq, res)) return;

  const parsed = ImportRunSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid input" });
    return;
  }

  const { dry_run: dryRun } = parsed.data;

  try {
    const summary = await runBackfill({
      workspaceId: wreq.workspaceOwnerId,
      dryRun,
    });
    res.json({ success: true, dry_run: dryRun, summary });
  } catch (err: unknown) {
    logger.error({ err, workspaceId: wreq.workspaceOwnerId }, "address-book import/run failed");
    res.status(500).json({ error: "Import job failed — check server logs for details" });
  }
});

/**
 * POST /api/address-book/import/translation-run
 * Owner-only one-time backfill for Arabic Address Book display names.
 * Accepts { dry_run: boolean } and returns the translation summary. The job
 * preserves each translated Arabic value as an approved transliteration alias.
 */
router.post(
  "/address-book/import/translation-run",
  async (req: Request, res: Response): Promise<void> => {
    const wreq = workspace(req);
    if (!requireOwner(wreq, res)) return;

    const parsed = ImportRunSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.errors[0]?.message ?? "Invalid input" });
      return;
    }

    const { dry_run: dryRun } = parsed.data;
    try {
      const summary = await runTranslationBackfill({
        workspaceId: wreq.workspaceOwnerId,
        dryRun,
      });
      res.json({ success: true, dry_run: dryRun, summary });
    } catch (err: unknown) {
      logger.error(
        { err, workspaceId: wreq.workspaceOwnerId },
        "address-book import/translation-run failed",
      );
      res.status(500).json({ error: "Translation backfill failed — check server logs for details" });
    }
  },
);

// ── Fleet lean endpoint ───────────────────────────────────────────────────────

/**
 * GET /api/fleet/place/:id — lean read-only endpoint for Fleet drivers.
 * Returns canonical coordinates and delivery instructions for a place.
 * Authenticated via driver bearer token (not Clerk).
 */
router.get(
  "/fleet/place/:id",
  requireDriverToken,
  async (req: Request, res: Response): Promise<void> => {
    // driverAuthed validates the token; we just need the driver's workspace.
    const dreq = driverAuthed(req);

    const id = String(req.params.id || "").trim();
    if (!isUuid(id)) {
      res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Place not found" } });
      return;
    }

    // Resolve driver's workspace
    const driverRes = await db.query<{ workspace_owner_id: string }>(
      `SELECT workspace_owner_id FROM fleet_drivers WHERE id = $1`,
      [dreq.driverId],
    );

    if (!driverRes.rows[0]) {
      res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Driver not found" } });
      return;
    }

    const workspaceOwnerId = driverRes.rows[0].workspace_owner_id;

    const r = await db.query<{
      id: string;
      canonical_address: string | null;
      area: string | null;
      city_name: string | null;
      latitude: string | null;
      longitude: string | null;
      entrance_notes: string | null;
      verification_state: string;
    }>(
      `SELECT p.id, p.canonical_address, p.area,
              dc.name AS city_name,
              p.latitude, p.longitude, p.entrance_notes, p.verification_state
         FROM places p
         LEFT JOIN delivery_cities dc ON dc.id = p.city_id
        WHERE p.id = $1 AND p.workspace_owner_id = $2 AND p.archived_at IS NULL`,
      [id, workspaceOwnerId],
    );

    if (!r.rows[0]) {
      res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Place not found" } });
      return;
    }

    const p = r.rows[0];
    res.json({
      success: true,
      place: {
        id: p.id,
        canonical_address: p.canonical_address,
        area: p.area,
        city: p.city_name,
        latitude: p.latitude != null ? parseFloat(p.latitude) : null,
        longitude: p.longitude != null ? parseFloat(p.longitude) : null,
        entrance_notes: p.entrance_notes,
        verification_state: p.verification_state,
      },
    });
  },
);

export default router;
