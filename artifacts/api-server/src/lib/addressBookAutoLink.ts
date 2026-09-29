/**
 * Address Book — real-time single-order auto-linking
 *
 * Called after a new order is committed (both manual-create and external-ingest
 * paths). Extracts the delivery address from the JSONB snapshot, matches or
 * creates a canonical `places` entry and inserts an `order_place_links` row.
 * The raw delivery text remains private order-scoped matching context; it is
 * never promoted to a workspace-wide alias.
 *
 * Contract:
 *  - orders.delivery_address is NEVER mutated — only the join tables are written.
 *  - Fully idempotent and reconcilable: safe to repeat after an address or
 *    contact-role correction; existing order links and saved address details
 *    are preserved or updated without duplicating active contact associations.
 *  - Best-effort: all errors are logged; nothing is ever thrown to the caller.
 *  - Single-order context: we cannot use the count-threshold heuristic (≥3
 *    orders) from the batch backfill. Instead, if a place with ≥0.9 bigram
 *    similarity already exists in the workspace we auto-link to it; otherwise
 *    AI must validate a new candidate before it can be created.
 */

import { db } from "./db";
import { logger } from "./logger";
import {
  assessPlaceValidity,
  geocodeAddress,
  type GeocodeProviderOptions,
  type PlaceAssessment,
  type PlaceAssessmentContext,
} from "./placeAiAssessor.js";
import { MapProviderError } from "./mapProvider.js";
import { normalizeTrustedCountry } from "./placeGeography";
import { detectScript as detectScriptFromTranslation, translateAddressToEnglish } from "./translation.js";
import {
  AUH_HOSPITAL_CANONICAL_NAME,
  classifyPlaceType,
  extractClearlyNamedHospitalTitle,
  extractClearlyNamedHotelTitle,
  isClearlyNamedHospital,
  isNamedHotel,
  isAccommodationPlaceName,
  recognizeAUHHospital,
} from "@workspace/api-zod/place-types";

// ── Text normalization ────────────────────────────────────────────────────────
// These are the canonical implementations; addressBookBackfill.ts imports
// them from here to avoid duplication.

const ARABIC_ABBREVS: Record<string, string> = {
  "ش": "شارع",
  "ح": "حارة",
  "م": "مبنى",
};

const LATIN_ABBREVS: Record<string, string> = {
  "imm\\.": "immeuble",
  "imm ": "immeuble ",
  "bldg\\.?": "building",
  "blvd\\.?": "boulevard",
  "ave\\.?": "avenue",
  "st\\.?(?= |$)": "street",
  "rd\\.?(?= |$)": "road",
  "apt\\.?": "apartment",
  "fl\\.?(?= |$)": "floor",
};

// The canonical implementation is now in translation.ts. Re-export so that any
// existing callers importing detectScript from this module continue to work.
export { detectScript } from "./translation.js";

class AddressBookPersistenceError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "AddressBookPersistenceError";
  }
}

/**
 * True only for errors that plausibly indicate a network/transport problem
 * reaching an external map or AI provider (timeouts, DNS, connection resets).
 * Everything else — AI response parsing bugs, unexpected exceptions, logic
 * errors — is an application-level failure and must be classified as such;
 * see `isNetworkLikeError` usage in `assessAndGeocode`.
 */
function isNetworkLikeError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError" || err.name === "TimeoutError") return true;
  return /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|fetch failed|network|socket hang up/i.test(
    err.message || "",
  );
}

/**
 * Runs a PostgreSQL query on behalf of the AI verification/geocoding
 * pipeline and rethrows any failure as `AddressBookPersistenceError`.
 *
 * `isNetworkLikeError` matches on message text alone (timeouts, connection
 * resets, "socket hang up"), and a dropped or reset PostgreSQL connection can
 * produce exactly that shape. Every database call inside `assessAndGeocode`
 * and `clearUnsupportedAiPin` must go through this wrapper so a DB transport
 * failure is tagged as a database/persistence failure *before* it reaches the
 * outer classifier, never mistaken for a map-provider outage that would
 * inflate provider_failures or trip the reverification circuit breaker.
 */
async function dbQueryForVerification<T extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
): Promise<{ rows: T[] }> {
  try {
    return await db.query<T>(sql, params);
  } catch (err) {
    if (err instanceof AddressBookPersistenceError) throw err;
    throw new AddressBookPersistenceError(
      `Database operation failed during AI verification: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
}

export function normalizePlaceName(text: string): string {
  if (!text || !text.trim()) return "";

  let s = text.toLowerCase().trim();
  const script = detectScriptFromTranslation(s);

  if (script === "arabic") {
    for (const [abbr, expansion] of Object.entries(ARABIC_ABBREVS)) {
      s = s.replace(new RegExp(`(?<=[\\s,.]|^)${abbr}(?=[\\s,.]|$)`, "g"), expansion);
    }
  } else {
    for (const [pattern, expansion] of Object.entries(LATIN_ABBREVS)) {
      s = s.replace(new RegExp(pattern, "gi"), expansion);
    }
  }

  s = s.replace(/[!"#$%&'()*+,./\\:;<=>?@[\]^_`{|}~]/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

export interface CompactPlaceTitleContext {
  area?: string | null;
  city?: string | null;
  country?: string | null;
  placeName?: string | null;
  landmark?: string | null;
  storeName?: string | null;
  privateFragments?: readonly (string | null | undefined)[];
}

export interface CompactPlaceTitleResult {
  title: string | null;
  removedFragments: string[];
}

const PRIVATE_ADDRESS_PATTERNS = [
  /\b(?:call|contact|ring|leave|deliver|delivery|recipient|customer|receiver|driver|patient|reception|gate\s*code|door\s*code|do\s+not|don't|dont|please|kindly)\b/i,
  /\b(?:near|next\s+to)\s+(?:the\s+)?(?:petrol|gas)\s+station\b/i,
  /\b(?:near|next\s+to)\s+(?:the\s+)?(?:door|gate|house|home|building)\b/i,
];
const CONTACT_DETAIL_PATTERN =
  /(?:\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b)|(?:\+?\d[\d\s().-]{6,}\d)/i;
const UNIT_DETAIL_PATTERN =
  /\b(?:apt|apartment|flat|unit|suite|floor|fl|chalet|room|ward|bed)\s*(?:[#.:/-]?\s*[\p{L}\p{N}-]+)?\b/giu;
const UNIT_LABEL_PATTERN =
  /^\s*(?:apt|apartment|flat|unit|suite|floor|fl|chalet|room|ward|bed)\b/i;
const UNIT_DETAIL_DETECT_PATTERN =
  /\b(?:apt|apartment|flat|unit|suite|floor|fl|chalet|room|ward|bed)\s*(?:[#.:/-]?\s*[\p{L}\p{N}-]+)?\b/iu;

function cleanTitlePart(value: string): string {
  return value
    .replace(/^\s*(?:address|location)\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .replace(/^[,;|\s-]+|[,;|\s-]+$/g, "")
    .trim();
}

function isPrivateAddressFragment(value: string): boolean {
  return !value || CONTACT_DETAIL_PATTERN.test(value) ||
    PRIVATE_ADDRESS_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Make a reusable human-readable identity from an order address.
 *
 * This intentionally does not attempt to "understand" arbitrary prose. It
 * removes only well-defined private delivery details and keeps the remaining
 * location words. The original order snapshot is retained separately for
 * matching and audit.
 */
export function compactPlaceTitle(
  addressText: string,
  context: CompactPlaceTitleContext = {},
): CompactPlaceTitleResult {
  const raw = addressText.trim();
  if (!raw) return { title: null, removedFragments: [] };

  const removedFragments: string[] = [];
  let scrubbed = raw;
  for (const fragment of context.privateFragments ?? []) {
    const value = fragment?.trim();
    if (!value) continue;
    const next = scrubbed.replace(new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"), " ");
    if (next !== scrubbed) removedFragments.push(value);
    scrubbed = next;
  }

  scrubbed = scrubbed
    .replace(CONTACT_DETAIL_PATTERN, (match) => {
      removedFragments.push(match);
      return " ";
    })
    // Unit/floor/chalet values are private details, not place identities.
    .replace(UNIT_DETAIL_PATTERN, (match) => {
      removedFragments.push(match.trim());
      return " ";
    })
    .replace(/\b(?:call|contact|ring|leave|deliver|delivery|recipient|customer|receiver|driver|patient|reception|gate\s*code|door\s*code)\b[^,;|]*/gi, (match) => {
      removedFragments.push(match.trim());
      return " ";
    });

  const parts = scrubbed
    .split(/[,;\n|]+/)
    .map(cleanTitlePart)
    .filter((part) => {
      if (!part || isPrivateAddressFragment(part)) {
        if (part) removedFragments.push(part);
        return false;
      }
      // A leftover unit-only fragment must never become a title.
      if (UNIT_LABEL_PATTERN.test(part) || /^\d{1,5}$/.test(part)) {
        removedFragments.push(part);
        return false;
      }
      return true;
    });

  const explicitCandidates = [
    context.placeName,
    context.landmark,
    context.storeName,
    context.area,
  ]
    .map((value) => (typeof value === "string" ? cleanTitlePart(value) : ""))
    .filter((value) => value && !isPrivateAddressFragment(value) && !UNIT_LABEL_PATTERN.test(value));

  const uniqueParts: string[] = [];
  for (const part of [...parts, ...explicitCandidates]) {
    if (!uniqueParts.some((existing) => normalizePlaceName(existing) === normalizePlaceName(part))) {
      uniqueParts.push(part);
    }
  }

  const title = uniqueParts.join(", ").slice(0, 160).trim().replace(/[,;|-]+$/, "").trim();
  return { title: title || null, removedFragments };
}

export type SharedAliasSource =
  | "manual"
  | "approved_landmark"
  | "approved_transliteration"
  | "ai_suggestion"
  | "search_suggestion";

export interface SharedAliasQualification {
  accepted: boolean;
  normalizedAlias: string | null;
  reason: "accepted" | "empty" | "private_detail" | "requires_owner_approval";
  requiresOwnerApproval: boolean;
}

/**
 * Validate text before it enters the workspace-wide alias namespace.
 * AI/search candidates are intentionally rejected until an owner approves
 * them; automatic order ingestion never calls this with an approved source.
 */
export function qualifySharedAlias(
  aliasText: string,
  source: SharedAliasSource = "manual",
  ownerApproved = source === "manual" || source === "approved_landmark" || source === "approved_transliteration",
): SharedAliasQualification {
  const trimmed = aliasText.trim();
  const normalizedAlias = trimmed ? normalizePlaceName(trimmed) : null;
  const requiresOwnerApproval = source === "ai_suggestion" || source === "search_suggestion";
  if (!normalizedAlias) {
    return { accepted: false, normalizedAlias: null, reason: "empty", requiresOwnerApproval };
  }
  if (requiresOwnerApproval && !ownerApproved) {
    return { accepted: false, normalizedAlias, reason: "requires_owner_approval", requiresOwnerApproval: true };
  }
  if (
    CONTACT_DETAIL_PATTERN.test(trimmed) ||
    PRIVATE_ADDRESS_PATTERNS.some((pattern) => pattern.test(trimmed)) ||
    UNIT_DETAIL_DETECT_PATTERN.test(trimmed) ||
    /^\d{1,5}$/.test(normalizedAlias)
  ) {
    return { accepted: false, normalizedAlias, reason: "private_detail", requiresOwnerApproval };
  }
  return { accepted: true, normalizedAlias, reason: "accepted", requiresOwnerApproval };
}

/** Dice-coefficient bigram similarity — same algorithm as the batch backfill. */
export function stringSimilarity(a: string, b: string): number {
  if (a === b) return 1.0;
  if (a.length < 2 || b.length < 2) return 0.0;

  const bigrams = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const bg = s.substring(i, i + 2);
      m.set(bg, (m.get(bg) ?? 0) + 1);
    }
    return m;
  };

  const bgA = bigrams(a);
  const bgB = bigrams(b);
  let intersect = 0;
  for (const [bg, countA] of bgA) {
    intersect += Math.min(countA, bgB.get(bg) ?? 0);
  }
  return (2 * intersect) / (a.length - 1 + b.length - 1);
}

// ── Address extraction ────────────────────────────────────────────────────────

export function extractAddressInfo(deliveryAddress: Record<string, unknown>): {
  addressText: string | null;
  area: string | null;
  cityKey: string | null;
  cityId: number | null;
  country: string | null;
  phone: string | null;
  noAddress: boolean;
} {
  if (!deliveryAddress || typeof deliveryAddress !== "object") {
    return {
      addressText: null,
      area: null,
      cityKey: null,
      cityId: null,
      country: null,
      phone: null,
      noAddress: false,
    };
  }

  const d = deliveryAddress as Record<string, unknown>;

  let addressText: string | null = null;
  const addr1 = typeof d["address_1"] === "string" ? d["address_1"].trim() : null;
  const addr2 = typeof d["address_2"] === "string" ? d["address_2"].trim() : null;
  const addrMain = typeof d["address"] === "string" ? d["address"].trim() : null;
  const district = typeof d["district"] === "string" ? d["district"].trim() : null;
  const storeName = typeof d["storeName"] === "string" ? d["storeName"].trim() : null;
  const area = typeof d["area"] === "string" ? d["area"].trim() : null;

  if (addr1) {
    addressText = addr2 ? `${addr1} ${addr2}` : addr1;
  } else if (addrMain) {
    addressText = addrMain;
  } else if (district) {
    addressText = district;
  } else if (storeName) {
    addressText = storeName;
  } else if (area) {
    addressText = area;
  }

  if (addressText && area && !addressText.toLowerCase().includes(area.toLowerCase())) {
    addressText = `${addressText}, ${area}`;
  }

  let cityId: number | null = null;
  let cityKey: string | null = null;

  const rawCityId = d["cityId"] ?? d["city_id"];
  if (rawCityId !== null && rawCityId !== undefined) {
    const n = Number(rawCityId);
    if (!isNaN(n) && n > 0) {
      cityId = n;
      cityKey = String(n);
    }
  }

  if (!cityKey) {
    const cityName =
      (typeof d["cityName"] === "string" ? d["cityName"] : null) ??
      (typeof d["city"] === "string" ? d["city"] : null);
    if (cityName && cityName.trim()) {
      cityKey = cityName.trim().toLowerCase();
    }
  }

  const phone =
    typeof d["phone"] === "string" ? d["phone"].trim() || null : null;
  const country =
    (typeof d["country"] === "string" ? d["country"] : null) ??
    (typeof d["countryName"] === "string" ? d["countryName"] : null) ??
    (typeof d["country_code"] === "string" ? d["country_code"] : null);

  return {
    addressText,
    area,
    cityKey,
    cityId,
    country: country?.trim() || null,
    phone,
    noAddress: d["noAddress"] === true || d["no_address"] === true,
  };
}

/** Best-effort area/district label to carry into a saved contact address. */
export function extractAddressArea(deliveryAddress: Record<string, unknown>): string | null {
  const area =
    typeof deliveryAddress.area === "string"
      ? deliveryAddress.area.trim()
      : typeof deliveryAddress.district === "string"
        ? deliveryAddress.district.trim()
        : null;
  return area || null;
}
export type AddressEligibilityReason =
  | "eligible"
  | "no_address_requested"
  | "placeholder_instruction"
  | "missing_address";

export interface AddressEligibility {
  eligible: boolean;
  reason: AddressEligibilityReason;
  addressText: string | null;
}

/**
 * Normalize text for deterministic placeholder detection. This is deliberately
 * separate from normalizePlaceName: address names retain their punctuation for
 * display, while this check should treat "don't", "dont", and "don’t" alike.
 */
function normalizeEligibilityText(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’‘`]/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const PLACEHOLDER_ADDRESS_PATTERNS: RegExp[] = [
  /\b(?:i\s+)?(?:do\s+not|don\s+t|dont)\s+know(?:\s+the)?\s+address\b/,
  /\b(?:address|location)\s+(?:unknown|unavailable|not\s+(?:provided|known|available))\b/,
  /\b(?:no|without)\s+(?:address|location)\b/,
  /\b(?:please\s+|kindly\s+)?(?:call|contact)\s+(?:the\s+)?(?:recipient|customer|receiver|addressee|person)\b/,
  /\b(?:recipient|customer|receiver)\s+(?:will|can|should)?\s*(?:provide|give|share)\s+(?:the\s+)?address\b/,
];

/**
 * Return true for text that is clearly an instruction or an explicit
 * placeholder rather than a delivery location. Ambiguous text is intentionally
 * left for the AI safeguard so informal areas and landmarks remain supported.
 */
export function isPlaceholderAddress(text: string): boolean {
  const normalized = normalizeEligibilityText(text);
  if (!normalized) return false;

  if (PLACEHOLDER_ADDRESS_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  // A phone number by itself is useful delivery context, but cannot be a place.
  const compact = normalized.replace(/\s/g, "");
  return /^\d{7,15}$/.test(compact);
}

/** Central eligibility gate for order-to-Address-Book linking. */
export function getAddressEligibility(
  deliveryAddress: Record<string, unknown>,
): AddressEligibility {
  const { addressText, noAddress } = extractAddressInfo(deliveryAddress);
  if (noAddress) {
    return {
      eligible: false,
      reason: "no_address_requested",
      addressText,
    };
  }
  if (!addressText) {
    return { eligible: false, reason: "missing_address", addressText: null };
  }
  if (isPlaceholderAddress(addressText)) {
    return {
      eligible: false,
      reason: "placeholder_instruction",
      addressText,
    };
  }
  return { eligible: true, reason: "eligible", addressText };
}

async function resolveDeliveryCity(cityId: number): Promise<{
  id: number;
  name: string;
  country_code: string;
} | null> {
  const r = await db.query<{ id: number; name: string; country_code: string }>(
    `SELECT id, name, country_code FROM delivery_cities WHERE id = $1`,
    [cityId],
  );
  return r.rows[0] ?? null;
}
const HIGH_CONFIDENCE_SIMILARITY_THRESHOLD = 0.9;

// A name built from a single generic word ("Home", "Villa", "Office") or that
// is otherwise very short carries too little identity to trust bigram title
// similarity across an entire city — many unrelated customers reuse the same
// generic word. These must fall through to AI-validated creation (or one of
// the more specific matches above: exact title, alias, or private raw-address
// context) instead of silently reusing a different customer's place.
const GENERIC_PLACE_NAME_TERMS = new Set([
  "home", "house", "residence", "apartment", "apartments", "flat", "villa",
  "building", "office", "shop", "store", "clinic", "school", "warehouse",
  "salon", "cafe", "restaurant", "pharmacy", "center", "centre", "complex",
  "tower", "mall", "market", "garage", "farm", "chalet", "hotel", "hospital",
]);

function isGenericOrTooShortPlaceName(normalizedName: string): boolean {
  const compact = normalizedName.replace(/\s+/g, "");
  if (compact.length < 6) return true;
  const tokens = normalizedName.split(/\s+/).filter(Boolean);
  return tokens.length <= 1 && GENERIC_PLACE_NAME_TERMS.has(tokens[0] ?? "");
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async function findExistingPlace(
  workspaceId: string,
  canonicalName: string,
  normalizedName: string,
  resolvedCityId: number | null,
  rawAddress?: string,
  alternateNormalizedNames: readonly string[] = [],
): Promise<string | null> {
  // 1. Exact raw order context is the most specific match. It must win over
  // a public title similarity match so a repeat delivery cannot be relinked
  // to a merely similar place.
  //
  // place_order_address_contexts is keyed only by workspace + normalized
  // address text, not by contact/customer. If the raw address text itself is
  // generic or too short (a customer who only typed "Home" or "Villa" with no
  // street/building detail), that key carries no more identity than a bare
  // name match does, and a later unrelated customer typing the same bare word
  // must not silently reuse the first customer's place. Skip this lookup in
  // that case and fall through to the AI-validated path below, which is
  // consistent with the name-based generic gate.
  const normalizedRawAddress = rawAddress ? normalizePlaceName(rawAddress) : "";
  if (rawAddress && !isGenericOrTooShortPlaceName(normalizedRawAddress)) {
    const contextMatch = await db.query<{ place_id: string }>(
      `SELECT place_id
         FROM place_order_address_contexts
        WHERE workspace_owner_id = $1
          AND normalized_address = $2
          AND (city_id = $3 OR (city_id IS NULL AND $3::integer IS NULL))
        ORDER BY updated_at DESC
        LIMIT 1`,
      [workspaceId, normalizedRawAddress, resolvedCityId],
    );
    if (contextMatch.rows[0]) return contextMatch.rows[0].place_id;
  }

  // 2. Exact normalized shared title in the same city, and official
  // institutional variants already stored as aliases on a place whose
  // canonical title predates deterministic recognition.
  //
  // A generic or very short incoming name ("Home", "Villa", "Office") carries
  // too little identity to trust on its own — many unrelated customers reuse
  // the same generic word, so neither an exact-title match nor an alias match
  // is safe here without stronger corroborating evidence (a raw-address
  // context match, above, or a delivery/coordinate-based reconciliation
  // outside this function). See isGenericOrTooShortPlaceName.
  if (!isGenericOrTooShortPlaceName(normalizedName)) {
    const exact = await db.query<{ id: string }>(
      `SELECT id FROM places
        WHERE workspace_owner_id = $1
          AND lower(canonical_name) = lower($2)
          AND (city_id = $3 OR (city_id IS NULL AND $3::integer IS NULL))
          AND archived_at IS NULL
        LIMIT 1`,
      [workspaceId, canonicalName, resolvedCityId],
    );
    if (exact.rows[0]) return exact.rows[0].id;

    const aliasNames = [normalizedName, ...alternateNormalizedNames]
      .map((name) => normalizePlaceName(name))
      .filter(Boolean);
    if (aliasNames.length) {
      const aliasMatch = await db.query<{ place_id: string }>(
        `SELECT pa.place_id
           FROM place_aliases pa
           JOIN places p ON p.id = pa.place_id
          WHERE p.workspace_owner_id = $1
            AND p.archived_at IS NULL
            AND (p.city_id = $2 OR (p.city_id IS NULL AND $2::integer IS NULL))
            AND pa.deleted_at IS NULL
            AND pa.normalized_alias = ANY($3::text[])
          ORDER BY pa.created_at ASC
          LIMIT 1`,
        [workspaceId, resolvedCityId, aliasNames],
      );
      if (aliasMatch.rows[0]) return aliasMatch.rows[0].place_id;
    }

    // 3. Similarity match — scan active places in the same city.
    const candidates = await db.query<{ id: string; canonical_name: string }>(
      `SELECT id, canonical_name FROM places
        WHERE workspace_owner_id = $1
          AND (city_id = $2 OR (city_id IS NULL AND $2::integer IS NULL))
          AND archived_at IS NULL`,
      [workspaceId, resolvedCityId],
    );
    for (const row of candidates.rows) {
      const sim = stringSimilarity(normalizedName, normalizePlaceName(row.canonical_name));
      if (sim >= HIGH_CONFIDENCE_SIMILARITY_THRESHOLD) {
        return row.id;
      }
    }
  }

  // 4. Relaxed institution similarity — hospitals and hotels use a lower threshold
  //    (0.75 vs 0.9) so that minor name variants ("Rassoul Al Azam Hospital Cardiology"
  //    vs "Rassoul Al Azam Hospital") resolve to the same physical place.
  const INSTITUTION_SIMILARITY_THRESHOLD = 0.75;
  if (isClearlyNamedHospital(canonicalName) || isNamedHotel(canonicalName)) {
    const institutionCandidates = await db.query<{ id: string; canonical_name: string }>(
      `SELECT id, canonical_name FROM places
        WHERE workspace_owner_id = $1
          AND (city_id = $2 OR (city_id IS NULL AND $2::integer IS NULL))
          AND archived_at IS NULL
          AND place_type IN ('hospital', 'hotel')`,
      [workspaceId, resolvedCityId],
    );
    for (const row of institutionCandidates.rows) {
      const sim = stringSimilarity(normalizedName, normalizePlaceName(row.canonical_name));
      if (sim >= INSTITUTION_SIMILARITY_THRESHOLD) {
        return row.id;
      }
    }
  }

  return null;
}

async function createPlace(
  workspaceId: string,
  canonicalName: string,
  resolvedCityId: number | null,
  sourceNames: readonly string[] = [],
  requestedPlaceType = "residence",
  trustedCountry?: string | null,
): Promise<{ placeId: string; wasCreated: boolean }> {
  // No match — create a new unverified place. This function is called only
  // after the address has passed the AI creation safeguard.
  const insertRes = await db.query<{ id: string }>(
    `INSERT INTO places
        (workspace_owner_id, canonical_name, canonical_name_source, place_type, city_id,
         trusted_country_code, trusted_country_source,
        verification_state, created_at, updated_at)
       VALUES ($1, $2, 'auto', $3, $4, $5, CASE WHEN $5::text IS NULL THEN NULL ELSE 'order_ingest' END,
               'unverified', now(), now())
     ON CONFLICT (workspace_owner_id, city_id, canonical_name) DO NOTHING
     RETURNING id`,
    [
      workspaceId,
      canonicalName,
      classifyPlaceType(requestedPlaceType, [canonicalName, ...sourceNames]),
      resolvedCityId,
      normalizeTrustedCountry(trustedCountry),
    ],
  );

  if (insertRes.rows[0]) {
    const placeId = insertRes.rows[0].id;
    await db.query(
      `INSERT INTO place_verification_events
         (place_id, event_type, to_state, source, notes)
       VALUES ($1, 'created', 'unverified', $2, $3)`,
      [
        placeId,
        "order_ingest_auto",
        "Auto-created from AI-validated new order delivery address",
      ],
    );
    return { placeId, wasCreated: true };
  }

  // Race: another concurrent request inserted it — retry the select
  const retry = await db.query<{ id: string }>(
    `SELECT id FROM places
      WHERE workspace_owner_id = $1
        AND lower(canonical_name) = lower($2)
        AND (city_id = $3 OR (city_id IS NULL AND $3::integer IS NULL))
        AND archived_at IS NULL
      LIMIT 1`,
    [workspaceId, canonicalName, resolvedCityId],
  );
  if (retry.rows[0]) return { placeId: retry.rows[0].id, wasCreated: false };

  throw new Error(
    `addressBookAutoLink: could not find or create place for "${canonicalName}"`,
  );
}

async function promoteLegacyAccommodationPlace(
  placeId: string,
  names: readonly (string | null | undefined)[],
): Promise<void> {
  if (!names.some((name) => isAccommodationPlaceName(name))) return;

  await db.query(
    `UPDATE places
        SET place_type = 'hotel', updated_at = now()
      WHERE id = $1 AND lower(trim(place_type)) = 'residence'`,
    [placeId],
  );
}

async function promoteLegacyHospitalPlace(
  placeId: string,
  names: readonly (string | null | undefined)[],
  source: "order_ingest_auto" | "historical_reconciliation",
): Promise<boolean> {
  if (
    !names.some(
      (name) =>
        recognizeAUHHospital(name) !== null || isClearlyNamedHospital(name),
    )
  ) {
    return false;
  }

  const updated = await db.query<{ id: string }>(
    `UPDATE places
        SET place_type = 'hospital', updated_at = now()
      WHERE id = $1
        AND lower(trim(place_type)) = 'residence'
        AND canonical_name_source = 'auto'
      RETURNING id`,
    [placeId],
  );
  if (!updated.rows[0]) return false;

  await db.query(
    `INSERT INTO place_verification_events
       (place_id, event_type, source, notes)
     VALUES ($1, 'place_type_corrected', $2, $3)`,
    [
      placeId,
      source,
      "Promoted an automatic Residence to Hospital after deterministic hospital recognition; order delivery details remain private.",
    ],
  );
  return true;
}

async function promoteLegacyHotelPlace(
  placeId: string,
  names: readonly (string | null | undefined)[],
  source: "order_ingest_auto" | "historical_reconciliation",
): Promise<boolean> {
  if (!names.some((name) => isNamedHotel(name))) return false;

  const updated = await db.query<{ id: string }>(
    `UPDATE places
        SET place_type = 'hotel', updated_at = now()
      WHERE id = $1
        AND lower(trim(place_type)) = 'residence'
        AND canonical_name_source = 'auto'
      RETURNING id`,
    [placeId],
  );
  if (!updated.rows[0]) return false;

  await db.query(
    `INSERT INTO place_verification_events
       (place_id, event_type, source, notes)
     VALUES ($1, 'place_type_corrected', $2, $3)`,
    [
      placeId,
      source,
      "Promoted an automatic Residence to Hotel after deterministic hotel recognition; order delivery details remain private.",
    ],
  );
  return true;
}
async function insertAliasIfNew(
  placeId: string,
  aliasText: string,
  normalizedAlias: string,
): Promise<void> {
  await db.query(
    `INSERT INTO place_aliases (place_id, alias_text, normalized_alias)
     VALUES ($1, $2, $3)
     ON CONFLICT (place_id, normalized_alias) DO NOTHING`,
    [placeId, aliasText, normalizedAlias],
  );
}

export async function upsertOrderPlaceAddressContext(opts: {
  workspaceId: string;
  orderId: string;
  placeId: string;
  rawAddress: string;
  cityId: number | null;
}): Promise<void> {
  const rawAddress = opts.rawAddress.trim();
  const normalizedAddress = normalizePlaceName(rawAddress);
  if (!rawAddress || !normalizedAddress) return;

  await db.query(
    `INSERT INTO place_order_address_contexts
       (workspace_owner_id, order_id, place_id, raw_address, normalized_address, city_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (order_id) DO UPDATE
       SET workspace_owner_id = EXCLUDED.workspace_owner_id,
           place_id = EXCLUDED.place_id,
           raw_address = EXCLUDED.raw_address,
           normalized_address = EXCLUDED.normalized_address,
           city_id = EXCLUDED.city_id,
           updated_at = now()`,
    [
      opts.workspaceId,
      opts.orderId,
      opts.placeId,
      rawAddress,
      normalizedAddress,
      opts.cityId,
    ],
  );
}

async function insertOrderLink(
  orderId: string,
  placeId: string,
  workspaceId: string,
): Promise<void> {
  await db.query(
    `INSERT INTO order_place_links (workspace_owner_id, order_id, place_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (order_id) DO UPDATE
       SET workspace_owner_id = EXCLUDED.workspace_owner_id,
           place_id = EXCLUDED.place_id,
           linked_at = CASE
             WHEN order_place_links.place_id IS DISTINCT FROM EXCLUDED.place_id
             THEN now()
             ELSE order_place_links.linked_at
           END`,
    [workspaceId, orderId, placeId],
  );
}

/**
 * Create the active saved-address association used by the Address Book.
 *
 * Existing active rows are deliberately left untouched: a staff-entered label,
 * coordinates, or entrance notes are more authoritative than an order snapshot.
 * Archived rows are never reactivated; a later delivery creates a fresh active
 * association instead. The partial unique index in initDb makes this safe when
 * multiple order-ingest/backfill workers race.
 */
export async function insertContactPlaceAddress(opts: {
  workspaceId: string;
  contactId: string;
  placeId: string;
  rawAddress: string;
  area?: string | null;
  cityId?: number | null;
  autoLinked?: boolean;
}): Promise<void> {
  if (!opts.rawAddress.trim()) return;

  await db.query(
    `INSERT INTO contact_addresses
       (workspace_owner_id, contact_id, place_id, raw_address, area, city_id, auto_linked)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (workspace_owner_id, contact_id, place_id)
       WHERE archived_at IS NULL AND place_id IS NOT NULL
     DO NOTHING`,
    [
      opts.workspaceId,
      opts.contactId,
      opts.placeId,
      opts.rawAddress.trim(),
      opts.area ?? null,
      opts.cityId ?? null,
      opts.autoLinked ?? false,
    ],
  );
}
async function clearUnsupportedAiPin(
  placeId: string,
  workspaceId: string,
  aiInvalid: boolean,
  notes: string,
): Promise<{ cleared: boolean; preservedVerifiedCoordinates: boolean }> {
  const cleared = await dbQueryForVerification<{ id: string }>(
    `WITH locked_place AS (
       SELECT id, verification_state, coordinate_source, canonical_name_source,
              google_place_id, source_order_id, latitude, longitude,
              verification_precision, verification_method
         FROM places
        WHERE id = $1
          AND workspace_owner_id = $2
          AND archived_at IS NULL
        FOR UPDATE
     ),
     updated AS (
       UPDATE places p
          SET latitude = NULL,
              longitude = NULL,
              coordinate_source = NULL,
              verification_precision = NULL,
              verification_method = NULL,
              verification_source = NULL,
              verification_state = 'unverified'::place_verification_state,
              checkout_ready = false,
              verified_at = NULL,
              verified_by = NULL,
              location_conflict = false,
              ai_invalid = $3,
              updated_at = now()
         FROM locked_place
        WHERE p.id = locked_place.id
          AND locked_place.verification_state IN ('unverified', 'estimated', 'ai_verified')
          AND (
            locked_place.coordinate_source IN ('ai', 'legacy')
            OR (
              locked_place.coordinate_source = 'geocoder'
              AND locked_place.google_place_id IS NULL
              AND locked_place.source_order_id IS NULL
            )
            OR (
              locked_place.coordinate_source IS NULL
              AND locked_place.latitude IS NULL
              AND locked_place.longitude IS NULL
            )
          )
       RETURNING locked_place.verification_state AS from_state,
                 p.verification_state AS to_state,
                 locked_place.latitude AS previous_latitude,
                 locked_place.longitude AS previous_longitude,
                 locked_place.verification_precision AS previous_precision,
                 locked_place.verification_method AS previous_method
     )
     INSERT INTO place_verification_events
       (place_id, event_type, from_state, to_state, source, notes, metadata)
      SELECT $1, 'map_pin_cleared', from_state, to_state, 'ai', $4::text,
            jsonb_build_object(
              'coordinates_before', jsonb_build_object(
                'latitude', previous_latitude,
                'longitude', previous_longitude
              ),
              'coordinates_after', jsonb_build_object('latitude', NULL, 'longitude', NULL),
              'precision_before', previous_precision,
              'precision_after', NULL,
              'method_before', previous_method,
              'method_after', NULL,
               'correction_reason', $4::text
            )
       FROM updated
     RETURNING id`,
    [placeId, workspaceId, aiInvalid, notes],
  );
  if (cleared.rows[0]) {
    return { cleared: true, preservedVerifiedCoordinates: false };
  }

  const stateRes = await dbQueryForVerification<{
    verification_state: string;
    coordinate_source: string | null;
    google_place_id: string | null;
    source_order_id: string | null;
  }>(
    `SELECT verification_state, coordinate_source, google_place_id, source_order_id FROM places
      WHERE id = $1 AND workspace_owner_id = $2 AND archived_at IS NULL`,
    [placeId, workspaceId],
  );
  const current = stateRes.rows[0];
  const currentState = current?.verification_state;
  const protectedCoordinates =
    current?.coordinate_source === "manual" ||
    current?.coordinate_source === "gps" ||
    current?.coordinate_source === "import" ||
    Boolean(current?.source_order_id) ||
    (current?.coordinate_source === "geocoder" && Boolean(current?.google_place_id));
  if (currentState === "staff_verified" || currentState === "delivery_verified" || protectedCoordinates) {
    await dbQueryForVerification(
      `INSERT INTO place_verification_events
         (place_id, event_type, from_state, to_state, source, notes)
       VALUES ($1, 'ai_assessed', $2::place_verification_state, $2::place_verification_state, 'ai', $3)`,
      [
        placeId,
        currentState,
        `${notes} Existing protected coordinates were preserved.`,
      ],
    );
    return { cleared: false, preservedVerifiedCoordinates: true };
  }
  return { cleared: false, preservedVerifiedCoordinates: false };
}

/**
 * Run AI validity check + optional geocoding for a place, then persist results.
 *
 * Fire-and-forget safe: call without await; errors are caught internally.
 *
 * - If AI says invalid: sets places.ai_invalid = true, inserts event.
 * - If AI says valid AND Nominatim finds coords: writes lat/lng, marks the
 *   result AI verified, and inserts an event.
 * - If AI says valid BUT Nominatim finds nothing: inserts informational event.
 */
export async function assessAndGeocode(
  placeId: string,
  canonicalName: string,
  aliases: string[],
  workspaceId: string,
  existingAssessment?: PlaceAssessment,
  context: PlaceAssessmentContext = {},
  providerOptions: GeocodeProviderOptions = {},
): Promise<{
  status: "exact" | "landmark" | "street" | "locality" | "ambiguous" | "invalid" | "unresolved";
  reason?: string;
  matchedLocation?: string;
  latitude?: number | null;
  longitude?: number | null;
  coordinatesUpdated?: boolean;
  coordinatesCleared?: boolean;
  preservedVerifiedCoordinates?: boolean;
  precision?: "exact" | "landmark" | "street" | "locality";
  method?: "exact_match" | "landmark_match" | "street_match" | "locality_fallback";
  failure?: {
    provider: string;
    failureType: string;
    httpStatus?: number;
    providerMessage?: string;
    errorCategory?: string;
    retryAfter?: string | null;
    stage: string;
    query?: string;
    retryable: boolean;
    message: string;
  };
}> {
  try {
    if (context.geographyConflict) {
      const notes =
        "AI reverification stopped because trusted delivery evidence spans multiple countries; its previous automated coordinates were cleared, checkout was disabled, and the place returned to review.";
      const unsupported = await clearUnsupportedAiPin(placeId, workspaceId, false, notes);
      if (!unsupported.cleared && !unsupported.preservedVerifiedCoordinates) {
        await dbQueryForVerification(
          `UPDATE places
              SET ai_invalid = false, updated_at = now()
            WHERE id = $1
              AND workspace_owner_id = $2
              AND verification_state NOT IN ('staff_verified', 'delivery_verified')`,
          [placeId, workspaceId],
        );
        await dbQueryForVerification(
          `INSERT INTO place_verification_events
             (place_id, event_type, source, notes)
           VALUES ($1, 'ai_assessed', 'ai', $2)`,
          [placeId, notes],
        );
      }
      return {
        status: "unresolved",
        reason: "geography_conflict",
        latitude: unsupported.cleared ? null : undefined,
        longitude: unsupported.cleared ? null : undefined,
        coordinatesCleared: unsupported.cleared,
        preservedVerifiedCoordinates: unsupported.preservedVerifiedCoordinates,
      };
    }

    const assessment =
      existingAssessment ?? (await assessPlaceValidity(canonicalName, aliases, {
        ...context,
        workspaceOwnerId: workspaceId,
      }));
    const { valid, reason } = assessment;

    if (!valid) {
      const unsupported = await clearUnsupportedAiPin(
        placeId,
        workspaceId,
        true,
        `AI reverification rejected the address (${reason || "no usable address evidence"}); its previous automated coordinates were cleared, checkout was disabled, and the place returned to review.`,
      );
      if (unsupported.cleared || unsupported.preservedVerifiedCoordinates) {
        return {
          status: "invalid",
          reason,
          latitude: unsupported.cleared ? null : undefined,
          longitude: unsupported.cleared ? null : undefined,
          coordinatesCleared: unsupported.cleared,
          preservedVerifiedCoordinates: unsupported.preservedVerifiedCoordinates,
        };
      }

      // No stale AI pin existed. Flag the eligible place and record the
      // assessment without touching trusted verification states.
      const invalidWrite = await dbQueryForVerification<{ id: string }>(
        `UPDATE places
            SET ai_invalid = true, updated_at = now()
          WHERE id = $1
            AND workspace_owner_id = $2
           AND verification_state NOT IN ('staff_verified', 'delivery_verified')
           AND coordinate_source IS DISTINCT FROM 'manual'
           AND coordinate_source IS DISTINCT FROM 'gps'
           AND coordinate_source IS DISTINCT FROM 'import'
           AND source_order_id IS NULL
           AND NOT (coordinate_source = 'geocoder' AND google_place_id IS NOT NULL)
         RETURNING id`,
        [placeId, workspaceId],
      );
      if (!invalidWrite.rows[0]) {
        return {
          status: "invalid",
          reason,
          preservedVerifiedCoordinates: true,
        };
      }
      await dbQueryForVerification(
        `INSERT INTO place_verification_events
           (place_id, event_type, source, notes)
         VALUES ($1, 'ai_assessed', 'ai', $2)`,
        [placeId, `AI flagged as invalid: ${reason}`],
      );
      logger.info(
        { placeId, reason },
        "addressBook: AI flagged place as invalid",
      );
      return { status: "invalid", reason };
    }

    // Valid — try the full address and progressively broader, contextual
    // searches. Only Nominatim results can supply coordinates.
    const geocodeContext: PlaceAssessmentContext = {
      ...context,
      aliases,
    };
    const geocode = await geocodeAddress(
      canonicalName,
      geocodeContext,
      assessment.locationHints,
      providerOptions,
    );

    if (geocode) {
      const provider = geocode.provider ?? "nominatim";
      const precision = geocode.precision ??
        (geocode.matchType === "exact" ? "exact" : "locality");
      const method = geocode.method ??
        (precision === "exact" ? "exact_match" : "locality_fallback");
      const evidenceScore = Number.isFinite(geocode.evidenceScore) ? geocode.evidenceScore : 0;
      if (precision !== "exact" && precision !== "landmark") {
        const notes =
          `Map provider returned only ${precision} precision; no delivery pin was accepted. ` +
          `provider=${provider}; query=${geocode.query}; result=${geocode.matchedLocation}`;
        const unsupported = await clearUnsupportedAiPin(placeId, workspaceId, false, notes);
        return {
          status: precision,
          reason: "review_required_precision",
          matchedLocation: geocode.matchedLocation,
          latitude: unsupported.cleared ? null : undefined,
          longitude: unsupported.cleared ? null : undefined,
          coordinatesCleared: unsupported.cleared,
          preservedVerifiedCoordinates: unsupported.preservedVerifiedCoordinates,
          precision,
          method,
          failure: {
            provider,
            failureType: "insufficient_precision",
            stage: "geocode",
            query: geocode.query,
            retryable: false,
            message: notes,
          },
        };
      }
      const evidenceAudit = [
        `provider=${provider}`,
        `precision=${precision}`,
        `method=${method}`,
        geocode.placeIdentity ? `place=${geocode.placeIdentity}` : null,
        `query=${geocode.query}`,
        `evidence=${evidenceScore.toFixed(2)}`,
      ].filter(Boolean).join("; ");
      const confidenceEvidence = {
        ...(geocode.confidenceEvidence ?? {}),
        ...(geocode.candidateEvidence?.length
          ? { candidates: geocode.candidateEvidence }
          : {}),
      };
      const notes = precision === "exact"
        ? `AI verified exact map match: ${geocode.matchedLocation}. Coordinates came from ${provider} (${geocode.lat.toFixed(6)}, ${geocode.lng.toFixed(6)}). ${evidenceAudit}`
        : `AI verified approximate map match: ${geocode.matchedLocation}. Precision is ${precision}. Coordinates came from the closest validated ${provider} result (${geocode.lat.toFixed(6)}, ${geocode.lng.toFixed(6)}). ${evidenceAudit}`;
      // Lock, write, and audit in one statement. The verification-state guard is
      // evaluated at write time so a concurrent staff/delivery verification can
      // never be overwritten by an automated pin.
      const write = await dbQueryForVerification<{ id: string }>(
          `WITH locked_place AS (
           SELECT id, verification_state, coordinate_source, canonical_name_source,
                  google_place_id, source_order_id, latitude, longitude,
                  verification_precision, verification_method, verification_source
             FROM places
            WHERE id = $4
              AND workspace_owner_id = $5
              AND archived_at IS NULL
            FOR UPDATE
         ),
         updated AS (
           UPDATE places p
              SET latitude = $1,
                  longitude = $2,
                  verification_state = 'ai_verified'::place_verification_state,
                  ai_invalid = false,
                  coordinate_source = 'geocoder',
                  verification_precision = $3::text,
                  verification_method = '${method}',
                  verification_source = '${provider}',
                  verified_at = now(),
                  verified_by = NULL,
                  updated_at = now()
             FROM locked_place
            WHERE p.id = locked_place.id
          AND locked_place.verification_state IN ('unverified', 'estimated', 'ai_verified')
              AND (
               locked_place.coordinate_source IN ('ai', 'legacy')
               OR (
                 locked_place.coordinate_source = 'geocoder'
                 AND locked_place.google_place_id IS NULL
                 AND locked_place.source_order_id IS NULL
               )
               OR (
                 locked_place.coordinate_source IS NULL
                 AND locked_place.latitude IS NULL
                 AND locked_place.longitude IS NULL
               )
              )
              AND (
                locked_place.latitude IS DISTINCT FROM $1
                OR locked_place.longitude IS DISTINCT FROM $2
                OR p.verification_precision IS DISTINCT FROM $3::text
                OR p.verification_method IS DISTINCT FROM '${method}'
                OR p.verification_source IS DISTINCT FROM '${provider}'
                OR locked_place.verification_state IS DISTINCT FROM 'ai_verified'::place_verification_state
              )
           RETURNING locked_place.verification_state AS from_state,
                     p.verification_state AS to_state,
                     locked_place.latitude AS previous_latitude,
                     locked_place.longitude AS previous_longitude,
                     locked_place.verification_precision AS previous_precision,
                     locked_place.verification_method AS previous_method
         )
         INSERT INTO place_verification_events
           (place_id, event_type, from_state, to_state, source, notes, metadata)
         SELECT $4, 'map_pin_updated', from_state, to_state, 'ai', $6::text,
                jsonb_build_object(
                  'coordinates_before', jsonb_build_object(
                    'latitude', previous_latitude,
                    'longitude', previous_longitude
                  ),
                  'coordinates_after', jsonb_build_object(
                    'latitude', $1,
                    'longitude', $2
                  ),
                  'precision_before', previous_precision,
                  'precision_after', $3::text,
                  'method_before', previous_method,
                  'method_after', '${method}',
                  'correction_reason', $6::text,
                  'provider', $7::text,
                  'query', $8::text,
                  'matched_location', $9::text,
                  'place_identity', $10::text,
                  'evidence_score', $11::numeric,
                  'queries_tried', $12::jsonb,
                  'provider_types', $13::jsonb,
                  'confidence_evidence', $14::jsonb
                )
           FROM updated
         RETURNING id`,
          [
            geocode.lat,
            geocode.lng,
            precision,
            placeId,
            workspaceId,
            notes,
            provider,
            geocode.query,
            geocode.matchedLocation,
            geocode.placeIdentity,
            evidenceScore,
            JSON.stringify(geocode.queriesTried ?? []),
            JSON.stringify(geocode.providerTypes ?? []),
             JSON.stringify(confidenceEvidence),
          ],
        );

      if (write.rows[0]) {
        logger.info(
          { placeId, lat: geocode.lat, lng: geocode.lng, matchType: geocode.matchType },
          "addressBook: AI geocoded place successfully",
        );
        return {
          status: precision,
          matchedLocation: geocode.matchedLocation,
          latitude: geocode.lat,
          longitude: geocode.lng,
          coordinatesUpdated: true,
          precision,
          method,
        };
      }

      // A no-row write is either a missing/archived place or a verified place
      // that became protected before the write. Only the latter receives an
      // audit event, and it is explicitly marked as preserved rather than set.
      const stateRes = await dbQueryForVerification<{
        verification_state: string;
        coordinate_source: string | null;
        google_place_id: string | null;
        source_order_id: string | null;
      }>(
        `SELECT verification_state, coordinate_source, google_place_id, source_order_id FROM places
          WHERE id = $1 AND workspace_owner_id = $2 AND archived_at IS NULL`,
        [placeId, workspaceId],
      );
      const currentState = stateRes.rows[0]?.verification_state;
      const current = stateRes.rows[0];
      const protectedCoordinates =
        current?.coordinate_source === "manual" ||
        current?.coordinate_source === "gps" ||
        current?.coordinate_source === "import" ||
        Boolean(current?.source_order_id) ||
        (current?.coordinate_source === "geocoder" && Boolean(current?.google_place_id));
      if (currentState === "staff_verified" || currentState === "delivery_verified" || protectedCoordinates) {
        await dbQueryForVerification(
          `INSERT INTO place_verification_events
             (place_id, event_type, from_state, to_state, source, notes)
           VALUES ($1, 'ai_assessed', $2::place_verification_state, $2::place_verification_state, 'ai', $3)`,
          [
            placeId,
            currentState,
            `${notes} Existing protected coordinates were preserved.`,
          ],
        );
        return {
          status: precision,
          matchedLocation: geocode.matchedLocation,
          latitude: null,
          longitude: null,
          coordinatesUpdated: false,
          preservedVerifiedCoordinates: true,
          precision,
          method,
        };
      }
      return { status: "unresolved", reason: "place_unavailable" };
    } else {
      const notes =
        "AI reverification found no address-specific validated map result; its previous automated coordinates were cleared, checkout was disabled, and the place returned to review.";
      const unsupported = await clearUnsupportedAiPin(
        placeId,
        workspaceId,
        false,
        notes,
      );
      if (unsupported.cleared || unsupported.preservedVerifiedCoordinates) {
        return {
          status: "unresolved",
          reason,
          latitude: unsupported.cleared ? null : undefined,
          longitude: unsupported.cleared ? null : undefined,
          coordinatesCleared: unsupported.cleared,
          preservedVerifiedCoordinates: unsupported.preservedVerifiedCoordinates,
        };
      }

      // Valid but no coordinates and no stale AI pin to clear.
      await dbQueryForVerification(
        `UPDATE places
            SET ai_invalid = false, updated_at = now()
          WHERE id = $1
            AND workspace_owner_id = $2
            AND verification_state NOT IN ('staff_verified', 'delivery_verified')`,
        [placeId, workspaceId],
      );
      await dbQueryForVerification(
        `INSERT INTO place_verification_events
           (place_id, event_type, source, notes)
         VALUES ($1, 'ai_assessed', 'ai', $2)`,
        [
          placeId,
          "AI assessed this as a plausible address, but no validated map result passed the locality safeguards; it remains unverified.",
        ],
      );
      logger.info(
        { placeId },
        "addressBook: AI assessed as valid but geocoding returned no results",
      );
      return { status: "unresolved", reason };
    }
  } catch (err) {
    logger.error(
      { err, placeId },
      "addressBook: AI assessment/geocoding failed — place is unaffected",
    );
    if (err instanceof MapProviderError) {
      return {
        status: "unresolved",
        reason: "assessment_failed",
        failure: {
          provider: err.provider,
          failureType: err.failureType,
          httpStatus: err.upstreamStatus,
          providerMessage: err.providerMessage,
          errorCategory: err.errorCategory,
          retryAfter: err.retryAfter,
          stage: err.stage,
          query: err.query,
          retryable: err.retryable,
          message: err.message,
        },
      };
    }
    if (err instanceof AddressBookPersistenceError) {
      return {
        status: "unresolved",
        reason: "persistence_failed",
        failure: {
          provider: "database",
          failureType: "database_write",
          stage: "persistence",
          retryable: false,
          message: err.message,
        },
      };
    }
    if (isNetworkLikeError(err)) {
      return {
        status: "unresolved",
        reason: "assessment_failed",
        failure: {
          provider: "unknown",
          failureType: "timeout_network",
          stage: "geocode",
          retryable: true,
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
    // Any other unexpected error (an AI-response parsing bug, an unwrapped
    // database error from a query above, or another application-level
    // exception) must never be reported as a map-provider outage: doing so
    // previously made real bugs look like transient provider failures and
    // could trip the reverification circuit breaker for something unrelated
    // to Google/Nominatim availability.
    return {
      status: "unresolved",
      reason: "application_error",
      failure: {
        provider: "application",
        failureType: "application_error",
        stage: "assessment",
        retryable: true,
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Auto-link a newly-created order to the address book.
 *
 * Fire-and-forget safe: call with `void linkOrderToAddressBook(...)`.
 * Errors are logged but never rethrown.
 *
 * @param orderId        UUID of the order that was just committed.
 * @param workspaceId    workspace_owner_id of the order.
 * @param deliveryAddress  The JSONB delivery_address value from the order row
 *                          (pass the in-memory value, no need for an extra DB read).
 */
export async function linkOrderToAddressBook(
  orderId: string,
  workspaceId: string,
  deliveryAddress: unknown,
  deliveryContext?: {
    deliveryInstructions?: string | null;
    readStoredAddress?: boolean;
  },
): Promise<void> {
  try {
    // On re-ingest callers may not have an address in the current payload
    // because the order upsert intentionally preserves its prior snapshot.
    // Read that immutable snapshot only when no usable in-memory value was
    // supplied; never rewrite it here.
    let effectiveDeliveryAddress = deliveryAddress;
    if (
      (!effectiveDeliveryAddress || typeof effectiveDeliveryAddress !== "object") &&
      deliveryContext?.readStoredAddress
    ) {
      const stored = await db.query<{ delivery_address: Record<string, unknown> | null }>(
        `SELECT delivery_address
           FROM orders
          WHERE id = $1 AND workspace_owner_id = $2
          LIMIT 1`,
        [orderId, workspaceId],
      );
      effectiveDeliveryAddress = stored.rows[0]?.delivery_address ?? null;
    }
    if (!effectiveDeliveryAddress || typeof effectiveDeliveryAddress !== "object") {
      await unlinkOrderFromAddressBook(orderId, workspaceId);
      return;
    }

    const addressInfo = extractAddressInfo(
      effectiveDeliveryAddress as Record<string, unknown>,
    );
    const eligibility = getAddressEligibility(
      effectiveDeliveryAddress as Record<string, unknown>,
    );
    if (!eligibility.eligible) {
      logger.info(
        {
          orderId,
          workspaceId,
          reason: eligibility.reason,
          addressText: eligibility.addressText,
        },
        "addressBook: skipped ineligible delivery address",
      );
      await unlinkOrderFromAddressBook(orderId, workspaceId);
      return;
    }

    const { addressText, area, cityId, cityKey, country, phone } = addressInfo;
    // getAddressEligibility above guarantees this, but keep the guard local to
    // make the invariant obvious if extraction changes later.
    if (!addressText) return;

    const normalized = normalizePlaceName(addressText);
    if (!normalized) return;

    const addressRecord = effectiveDeliveryAddress as Record<string, unknown>;
    const institutionText = [
      addressText,
      typeof addressRecord.placeName === "string" ? addressRecord.placeName : null,
      typeof addressRecord.landmark === "string" ? addressRecord.landmark : null,
      typeof addressRecord.storeName === "string" ? addressRecord.storeName : null,
    ]
      .filter(Boolean)
      .join(" | ");
    const recognizedAUH = recognizeAUHHospital(institutionText);
    const genericHospitalTitle = [
      typeof addressRecord.placeName === "string" ? addressRecord.placeName : null,
      typeof addressRecord.landmark === "string" ? addressRecord.landmark : null,
      typeof addressRecord.storeName === "string" ? addressRecord.storeName : null,
      addressText,
    ]
      .map(extractClearlyNamedHospitalTitle)
      .find((title): title is string => Boolean(title));
    const recognizedHospital =
      recognizedAUH !== null || genericHospitalTitle !== undefined;

    // Hotel recognition — only attempted when the address is not already a
    // recognized hospital, since hospitals take precedence.
    const genericHotelTitle = !recognizedHospital
      ? [
          typeof addressRecord.placeName === "string" ? addressRecord.placeName : null,
          typeof addressRecord.landmark === "string" ? addressRecord.landmark : null,
          typeof addressRecord.storeName === "string" ? addressRecord.storeName : null,
          addressText,
        ]
          .map(extractClearlyNamedHotelTitle)
          .find((title): title is string => Boolean(title))
      : undefined;
    const recognizedHotel = genericHotelTitle !== undefined;

    const compactTitle = (recognizedAUH || recognizedHospital || recognizedHotel)
      ? { title: recognizedAUH ? AUH_HOSPITAL_CANONICAL_NAME : (genericHospitalTitle ?? genericHotelTitle!), removedFragments: [] }
      : compactPlaceTitle(addressText, {
          area,
          city: cityKey && !/^\d+$/.test(cityKey) ? cityKey : null,
          country,
          placeName: typeof addressRecord.placeName === "string" ? addressRecord.placeName : null,
          landmark: typeof addressRecord.landmark === "string" ? addressRecord.landmark : null,
          storeName: typeof addressRecord.storeName === "string" ? addressRecord.storeName : null,
          privateFragments: [
            typeof addressRecord.recipientName === "string" ? addressRecord.recipientName : null,
            typeof addressRecord.recipient_name === "string" ? addressRecord.recipient_name : null,
            typeof addressRecord.contactName === "string" ? addressRecord.contactName : null,
            typeof addressRecord.contact_name === "string" ? addressRecord.contact_name : null,
            phone,
            deliveryContext?.deliveryInstructions,
          ],
        });
    // Institution recognition uses a bounded phrase, never surrounding delivery
    // prose (patient name, room, ward, guest details). The compact title is
    // only computed for non-institution addresses.
    let canonicalTitle = compactTitle.title;
    if (!canonicalTitle) {
      logger.info(
        { orderId, workspaceId, reason: "no_reusable_place_identity" },
        "addressBook: skipped delivery address without a reusable place identity",
      );
      await unlinkOrderFromAddressBook(orderId, workspaceId);
      return;
    }

    // Translate Arabic (or other non-Latin) titles to English so the Address
    // Book stays consistent and searchable regardless of input language.
    // The original non-English text is preserved as a language-tagged alias.
    let arabicOriginalTitle: string | null = null;
    if (detectScriptFromTranslation(canonicalTitle) === "arabic") {
      const translated = await translateAddressToEnglish(canonicalTitle, {
        workspaceOwnerId: workspaceId,
        orderId,
      });
      if (translated && detectScriptFromTranslation(translated) !== "arabic") {
        arabicOriginalTitle = canonicalTitle;
        canonicalTitle = translated;
        logger.info(
          { orderId, workspaceId, original: arabicOriginalTitle },
          "addressBook: translated Arabic place title to English",
        );
      }
    }

    const normalizedTitle = normalizePlaceName(canonicalTitle);
    const recognizedAUHAliases = recognizedAUH
      ? [
          normalizePlaceName("AUH"),
          normalizePlaceName("AUH Hospital"),
          normalizePlaceName("American University Hospital"),
          normalizePlaceName("American University of Beirut Hospital"),
        ]
      : [];

    // Validate city reference
    const resolvedCity = cityId !== null ? await resolveDeliveryCity(cityId) : null;
    const resolvedCityId = resolvedCity?.id ?? null;
    const city =
      resolvedCity?.name ??
      (cityKey && !/^\d+$/.test(cityKey) ? cityKey : null);
    // The assessment/geocoding boundary receives only the compact reusable
    // identity and coarse geographic context. Raw delivery text, phone
    // numbers, recipient details, and instructions stay in private order
    // storage and never leave the application for map/AI processing.
    const assessmentContext: PlaceAssessmentContext = {
      ...(city ? { city } : {}),
      ...(country ? { country } : {}),
      ...(area ? { area } : {}),
    };
    if (!assessmentContext.country && resolvedCity?.country_code) {
      assessmentContext.country = resolvedCity.country_code;
    }

    // When a title was translated from Arabic, include its normalized original
    // as an alternate alias candidate. This lets a subsequent order that arrives
    // in Arabic (and whose compact title normalizes to the same stored alias)
    // resolve to the same place even if the English translation differs slightly.
    const normalizedArabicAlias =
      arabicOriginalTitle ? normalizePlaceName(arabicOriginalTitle) : null;

    // Existing places are trusted matches. The AI safeguard is only needed
    // before creating a new candidate, preserving the fast path for known
    // legitimate locations.
    const existingPlaceId = await findExistingPlace(
      workspaceId,
      canonicalTitle,
      normalizedTitle,
      resolvedCityId,
      addressText,
      [
        ...recognizedAUHAliases,
        ...(normalizedArabicAlias ? [normalizedArabicAlias] : []),
      ],
    );

    let placeId = existingPlaceId;
    let wasCreated = false;
    let assessment: PlaceAssessment | undefined;

    if (!placeId) {
      try {
        assessment = (recognizedHospital || recognizedHotel)
          ? {
              valid: true,
              reason: recognizedAUH
                ? "Deterministically recognized American University Hospital (AUH)."
                : recognizedHospital
                ? "Deterministically recognized a clearly named hospital location."
                : "Deterministically recognized a clearly named hotel location.",
            }
          : await assessPlaceValidity(
              canonicalTitle,
              [],
              { ...assessmentContext, workspaceOwnerId: workspaceId, orderId },
            );
      } catch (err) {
        logger.warn(
          {
            err,
            orderId,
            workspaceId,
            reason: "ai_assessment_failed",
            canonicalTitle,
          },
          "addressBook: skipped new delivery address after AI assessment failure",
        );
        await unlinkOrderFromAddressBook(orderId, workspaceId);
        return;
      }
      if (!assessment.valid) {
        logger.info(
          {
            orderId,
            workspaceId,
            reason: "ai_invalid",
            assessmentReason: assessment.reason,
            canonicalTitle,
          },
          "addressBook: skipped AI-invalid new delivery address",
        );
        await unlinkOrderFromAddressBook(orderId, workspaceId);
        return;
      }

      const created = await createPlace(
        workspaceId,
        canonicalTitle,
        resolvedCityId,
        [canonicalTitle],
        recognizedHospital ? "hospital" : recognizedHotel ? "hotel" : "residence",
        assessmentContext.country,
      );
      placeId = created.placeId;
      wasCreated = created.wasCreated;
    }

    // Preserve the original non-English text as a language-tagged alias so
    // future orders arriving in the same language still resolve to this place.
    if (arabicOriginalTitle) {
      const normalizedArabic = normalizePlaceName(arabicOriginalTitle);
      if (normalizedArabic) {
        await db.query(
          `INSERT INTO place_aliases
             (place_id, alias_text, normalized_alias, language, source, approval_state)
           VALUES ($1, $2, $3, 'ar', 'approved_transliteration', 'approved')
           ON CONFLICT (place_id, normalized_alias) DO NOTHING`,
          [placeId, arabicOriginalTitle, normalizedArabic],
        );
      }
    }

    await promoteLegacyHospitalPlace(
      placeId,
      [canonicalTitle, addressText, ...recognizedAUHAliases],
      "order_ingest_auto",
    );
    // Promote a legacy Residence to Hotel when the canonical title or current
    // delivery text is a deterministically recognised hotel name.
    await promoteLegacyHotelPlace(placeId, [canonicalTitle, addressText], "order_ingest_auto");
    // This also handles a similarity match to a legacy Residence whose new
    // order address is the first accommodation alias we have seen.
    await promoteLegacyAccommodationPlace(placeId, [canonicalTitle]);
    await insertOrderLink(orderId, placeId, workspaceId);
    if (assessmentContext.country) {
      await db.query(
        `UPDATE places
            SET trusted_country_code = COALESCE(trusted_country_code, upper($3)),
                trusted_country_source = COALESCE(trusted_country_source, 'order_ingest'),
                updated_at = now()
          WHERE id = $1 AND workspace_owner_id = $2`,
        [placeId, workspaceId, assessmentContext.country],
      );
    }
    await upsertOrderPlaceAddressContext({
      workspaceId,
      orderId,
      placeId,
      rawAddress: addressText,
      cityId: resolvedCityId,
    });

    const contactIds = await resolveOrderDeliveryContacts(orderId, workspaceId);
    const addressArea = extractAddressArea(effectiveDeliveryAddress as Record<string, unknown>);
    await syncOrderDeliveryContactPlaceLinks({
      workspaceId,
      orderId,
      placeId,
      contactIds,
      rawAddress: addressText,
      area: addressArea,
      cityId: resolvedCityId,
    });

    logger.info(
      { orderId, workspaceId, placeId, contactCount: contactIds.length },
      "addressBook: order and delivery contacts linked to place",
    );

    // Geocode AI-valid newly-created places asynchronously. Reuse the
    // pre-creation assessment so the same candidate is not assessed twice.
    if (wasCreated) {
      assessAndGeocode(
        placeId,
        canonicalTitle,
        [],
        workspaceId,
        assessment,
        { ...assessmentContext, canonicalAddress: canonicalTitle },
      ).catch(
        (err) => logger.error({ err, placeId }, "addressBook: assessAndGeocode fire-and-forget error"),
      );
    }
  } catch (err) {
    logger.warn(
      { err, orderId, workspaceId },
      "addressBook: failed to auto-link order — order is unaffected",
    );
  }
}
if (false) {
/**
 * Auto-link a newly-created order to the address book.
 *
 * Fire-and-forget safe: call with `void linkOrderToAddressBook(...)`.
 * Errors are logged but never rethrown.
 *
 * @param orderId        UUID of the order that was just committed.
 * @param workspaceId    workspace_owner_id of the order.
 * @param deliveryAddress  The JSONB delivery_address value from the order row
 *                          (pass the in-memory value, no need for an extra DB read).
 */
async function linkOrderToAddressBookWithoutContactReconciliation(
  orderId: string,
  workspaceId: string,
  deliveryAddress: unknown,
  deliveryContext?: {
    deliveryInstructions?: string | null;
  },
): Promise<void> {
  try {
    if (!deliveryAddress || typeof deliveryAddress !== "object") return;

    const addressInfo = extractAddressInfo(
      deliveryAddress as Record<string, unknown>,
    );
    const eligibility = getAddressEligibility(
      deliveryAddress as Record<string, unknown>,
    );
    if (!eligibility.eligible) {
      logger.info(
        {
          orderId,
          workspaceId,
          reason: eligibility.reason,
          addressText: eligibility.addressText,
        },
        "addressBook: skipped ineligible delivery address",
      );
      return;
    }

    // Skip if this order is already linked (idempotency)
    const alreadyLinked = await db.query<{ order_id: string }>(
      `SELECT order_id FROM order_place_links WHERE order_id = $1 LIMIT 1`,
      [orderId],
    );
    if (alreadyLinked.rows[0]) return;

    const { addressText, area, cityId, cityKey, country, phone } = addressInfo;
    // getAddressEligibility above guarantees this, but keep the guard local to
    // make the invariant obvious if extraction changes later.
    if (!addressText) return;

    const normalized = normalizePlaceName(addressText);
    if (!normalized) return;

    // Validate city reference
    const resolvedCity = cityId !== null ? await resolveDeliveryCity(cityId) : null;
    const resolvedCityId = resolvedCity?.id ?? null;
    const city =
      resolvedCity?.name ??
      (cityKey && !/^\d+$/.test(cityKey) ? cityKey : null);
    const assessmentContext: PlaceAssessmentContext = {
      ...(city ? { city } : {}),
      ...(country ? { country } : {}),
      ...(area ? { area } : {}),
      ...(phone ? { phone } : {}),
      ...(deliveryContext?.deliveryInstructions
        ? { deliveryInstructions: deliveryContext.deliveryInstructions }
        : {}),
    };
    if (!assessmentContext.country && resolvedCity?.country_code) {
      assessmentContext.country = resolvedCity.country_code;
    }

    // Existing places are trusted matches. The AI safeguard is only needed
    // before creating a new candidate, preserving the fast path for known
    // legitimate locations.
    const existingPlaceId = await findExistingPlace(
      workspaceId,
      addressText.trim(),
      normalized,
      resolvedCityId,
    );
    if (existingPlaceId) {
      await insertAliasIfNew(existingPlaceId, addressText.trim(), normalized);
      await insertOrderLink(orderId, existingPlaceId, workspaceId);

      logger.info(
        { orderId, workspaceId, placeId: existingPlaceId },
        "addressBook: order linked to place",
      );
      return;
    }

    let assessment: PlaceAssessment;
    try {
      assessment = await assessPlaceValidity(
        addressText.trim(),
        [normalized],
        { ...assessmentContext, workspaceOwnerId: workspaceId, orderId },
      );
    } catch (err) {
      logger.warn(
        {
          err,
          orderId,
          workspaceId,
          reason: "ai_assessment_failed",
          addressText: addressText.trim(),
        },
        "addressBook: skipped new delivery address after AI assessment failure",
      );
      return;
    }
    if (!assessment.valid) {
      logger.info(
        {
          orderId,
          workspaceId,
          reason: "ai_invalid",
          assessmentReason: assessment.reason,
          addressText: addressText.trim(),
        },
        "addressBook: skipped AI-invalid new delivery address",
      );
      return;
    }

    const { placeId, wasCreated } = await createPlace(
      workspaceId,
      addressText.trim(),
      resolvedCityId,
    );

    await insertAliasIfNew(placeId, addressText.trim(), normalized);
    // This also handles a similarity match to a legacy Residence whose new
    // order address is the first accommodation alias we have seen.
    await promoteLegacyAccommodationPlace(placeId, [addressText]);
    await insertOrderLink(orderId, placeId, workspaceId);

    logger.info(
      { orderId, workspaceId, placeId },
      "addressBook: order linked to place",
    );

    // Geocode AI-valid newly-created places asynchronously. Reuse the
    // pre-creation assessment so the same candidate is not assessed twice.
    if (wasCreated) {
      assessAndGeocode(
        placeId,
        addressText.trim(),
        [normalized],
        workspaceId,
        assessment,
        assessmentContext,
      ).catch(
        (err) => logger.error({ err, placeId }, "addressBook: assessAndGeocode fire-and-forget error"),
      );
    }
  } catch (err) {
    logger.warn(
      { err, orderId, workspaceId },
      "addressBook: failed to auto-link order — order is unaffected",
    );
  }
}
}

/**
 * Remove delivery-contact provenance for an order that no longer has a usable
 * delivery address. Only unsupported, untouched automatic saved addresses are
 * retired; manually owned addresses stay active.
 */
async function unlinkOrderFromAddressBook(
  orderId: string,
  workspaceId: string,
): Promise<void> {
  const prior = await db.query<{ contact_id: string; place_id: string }>(
    `SELECT contact_id, place_id
       FROM order_place_contact_links
      WHERE order_id = $1 AND workspace_owner_id = $2`,
    [orderId, workspaceId],
  );

  await db.query(
    `DELETE FROM order_place_contact_links
      WHERE order_id = $1 AND workspace_owner_id = $2`,
    [orderId, workspaceId],
  );
  await db.query(
    `DELETE FROM order_place_links
      WHERE order_id = $1 AND workspace_owner_id = $2`,
    [orderId, workspaceId],
  );

  for (const row of prior.rows) {
    await retireUnsupportedAutomaticAddress(workspaceId, row.contact_id, row.place_id);
  }
}
export async function resolveOrderDeliveryContacts(
  orderId: string,
  workspaceId: string,
): Promise<string[]> {
  const result = await db.query<{ contact_id: string; role: string }>(
    `SELECT DISTINCT oc.contact_id, oc.role
       FROM order_contacts oc
       JOIN contacts c ON c.id = oc.contact_id
      WHERE oc.order_id = $1
        AND c.workspace_owner_id = $2
        AND oc.role IN ('customer', 'recipient')`,
    [orderId, workspaceId],
  );

  const recipients = result.rows
    .filter((row) => row.role === "recipient")
    .map((row) => row.contact_id);
  if (recipients.length > 0) return recipients;
  return result.rows
    .filter((row) => row.role === "customer")
    .map((row) => row.contact_id);
}

/**
 * Reconcile the delivery contacts attributed to one order and Place.
 *
 * The small provenance table lets a later recipient correction retire only an
 * automatically created customer/sender address when no other delivery still
 * supports it. Staff-saved contact addresses are never touched.
 */
export async function syncOrderDeliveryContactPlaceLinks(opts: {
  workspaceId: string;
  orderId: string;
  placeId: string;
  contactIds: string[];
  rawAddress: string;
  area?: string | null;
  cityId?: number | null;
}): Promise<void> {
  const contactIds = [...new Set(opts.contactIds.filter(Boolean))];
  const stale = await db.query<{ contact_id: string; place_id: string }>(
    `SELECT contact_id, place_id
       FROM order_place_contact_links
      WHERE order_id = $1
        AND (
          place_id IS DISTINCT FROM $2
          OR NOT (contact_id = ANY($3::uuid[]))
        )`,
    [opts.orderId, opts.placeId, contactIds],
  );

  if (stale.rowCount) {
    await db.query(
      `DELETE FROM order_place_contact_links
        WHERE order_id = $1
          AND (
            place_id IS DISTINCT FROM $2
            OR NOT (contact_id = ANY($3::uuid[]))
          )`,
      [opts.orderId, opts.placeId, contactIds],
    );
  }

  for (const contactId of contactIds) {
    await db.query(
      `INSERT INTO order_place_contact_links
         (workspace_owner_id, order_id, contact_id, place_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (order_id, contact_id) DO UPDATE
         SET workspace_owner_id = EXCLUDED.workspace_owner_id,
             place_id = EXCLUDED.place_id,
             updated_at = now()`,
      [opts.workspaceId, opts.orderId, contactId, opts.placeId],
    );
    await insertContactPlaceAddress({
      workspaceId: opts.workspaceId,
      contactId,
      placeId: opts.placeId,
      rawAddress: opts.rawAddress,
      area: opts.area,
      cityId: opts.cityId,
      autoLinked: true,
    });
  }

  for (const prior of stale.rows) {
    await retireUnsupportedAutomaticAddress(
      opts.workspaceId,
      prior.contact_id,
      prior.place_id,
    );
  }
}

async function retireUnsupportedAutomaticAddress(
  workspaceId: string,
  contactId: string,
  placeId: string,
): Promise<void> {
  await db.query(
    `UPDATE contact_addresses ca
        SET archived_at = now(), updated_at = now()
      WHERE ca.workspace_owner_id = $1
        AND ca.contact_id = $2
        AND ca.place_id = $3
        AND ca.archived_at IS NULL
        AND ca.auto_linked = true
        AND NOT EXISTS (
          SELECT 1
            FROM order_place_contact_links opl
           WHERE opl.workspace_owner_id = $1
             AND opl.contact_id = $2
             AND opl.place_id = $3
        )`,
    [workspaceId, contactId, placeId],
  );
}
