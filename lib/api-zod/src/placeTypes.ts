/**
 * Address Book place types shared by the API and dashboard.
 *
 * The database intentionally keeps place_type as free text for compatibility
 * with older records. These values are the supported, human-friendly options;
 * formatPlaceType still provides a readable label for an unknown legacy value.
 */
export const PLACE_TYPE_OPTIONS = [
  { value: "residence", label: "Residence" },
  { value: "building", label: "Building" },
  { value: "compound", label: "Compound" },
  { value: "hospital", label: "Hospital" },
  { value: "university", label: "University" },
  { value: "office", label: "Office" },
  { value: "hotel", label: "Hotel" },
  { value: "school", label: "School" },
  { value: "warehouse", label: "Warehouse" },
  { value: "retail", label: "Retail" },
  { value: "landmark", label: "Landmark" },
  { value: "church", label: "Church" },
  { value: "other", label: "Other" },
] as const;

export const PLACE_TYPE_VALUES = PLACE_TYPE_OPTIONS.map(({ value }) => value);

export type PlaceType = (typeof PLACE_TYPE_OPTIONS)[number]["value"];

export const PLACE_TYPE_LABELS: Record<PlaceType, string> = Object.fromEntries(
  PLACE_TYPE_OPTIONS.map(({ value, label }) => [value, label]),
) as Record<PlaceType, string>;

export const AUH_HOSPITAL_CANONICAL_NAME = "AUH Hospital";

export interface RecognizedAUHHospital {
  canonicalName: typeof AUH_HOSPITAL_CANONICAL_NAME;
  placeType: "hospital";
  matchedVariant: string;
}

/**
 * Words that disqualify a regex match entirely — their presence in the name
 * prefix indicates delivery prose rather than a proper institution name.
 * e.g. "at City Hospital" is valid (preposition anchor), but "Patient Jane at
 * City Hospital" from a greedy ^-anchored match must be rejected.
 */
const HOSPITAL_DISQUALIFYING_WORDS = new Set([
  "at", "by", "do", "deliver", "delivery", "dont", "entrance", "floor",
  "for", "from", "in", "near", "of", "patient", "please", "reception",
  "room", "the", "to", "unit", "ward", "with",
]);

/**
 * Words that appear in institution names but carry no identifying information
 * on their own (e.g. "University" in "St George University Hospital").
 * These are stripped before checking that the name has ≥1 identity token.
 */
const HOSPITAL_IDENTITY_STOP_WORDS = new Set([
  "center", "centre", "clinic", "hospital", "medical", "university",
]);

const HOSPITAL_MARKER = "(?:hospital|medical\\s+cent(?:er|re)|university|clinic)";

/**
 * Highest-priority pattern: institution name appears *after* a preposition.
 * "Jane Doe at City Hospital" → captures "City Hospital" reliably because the
 * preposition terminates any leading prose.
 */
const HOSPITAL_NAME_AFTER_PREP =
  new RegExp(
    `\\b(?:at|to|in|near)\\s+([a-z][a-z.'&-]*(?:\\s+[a-z][a-z.'&-]*){0,5}\\s+${HOSPITAL_MARKER})\\b`,
    "gi",
  );

/**
 * Fallback pattern: institution name at start of string or after a delimiter.
 * The stop-word check in the extractor prevents delivery prose from matching.
 */
const HOSPITAL_NAME_AT_START =
  new RegExp(
    `(?:^|[,;|\\n])\\s*([a-z][a-z.'&-]*(?:\\s+[a-z][a-z.'&-]*){0,5}\\s+${HOSPITAL_MARKER})\\b`,
    "gi",
  );

const HOTEL_DISQUALIFYING_WORDS = new Set([
  "a", "an", "at", "by", "deliver", "delivery", "do", "dont", "for",
  "from", "guest", "in", "near", "of", "please", "reception", "room",
  "the", "to", "with",
]);

const HOTEL_IDENTITY_STOP_WORDS = new Set([
  "hotel", "inn", "international", "resort",
]);

const HOTEL_MARKER = "(?:hotel|resort|inn)";

/** Highest-priority: hotel marker after name ("Grand Hyatt Hotel"). */
const HOTEL_SUFFIX_AFTER_PREP =
  new RegExp(
    `\\b(?:at|to|in|near)\\s+([a-z][a-z.'&-]*(?:\\s+[a-z][a-z.'&-]*){0,5}\\s+${HOTEL_MARKER})\\b`,
    "gi",
  );

/** Fallback: hotel suffix at start of string or after delimiter. */
const HOTEL_SUFFIX_AT_START =
  new RegExp(
    `(?:^|[,;|\\n])\\s*([a-z][a-z.'&-]*(?:\\s+[a-z][a-z.'&-]*){0,5}\\s+${HOTEL_MARKER})\\b`,
    "gi",
  );

/** Highest-priority: hotel marker before name ("Hotel Le Bristol"). */
const HOTEL_PREFIX_AFTER_PREP =
  new RegExp(
    `\\b(?:at|to|in|near)\\s+(${HOTEL_MARKER}\\s+[a-z][a-z.'&-]*(?:\\s+[a-z][a-z.'&-]*){0,5})\\b`,
    "gi",
  );

/** Fallback: hotel prefix at start of string or after delimiter. */
const HOTEL_PREFIX_AT_START =
  new RegExp(
    `(?:^|[,;|\\n])\\s*(${HOTEL_MARKER}\\s+[a-z][a-z.'&-]*(?:\\s+[a-z][a-z.'&-]*){0,5})\\b`,
    "gi",
  );

function normalizeInstitutionText(value: string): string {
  return value
    .toLocaleLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Recognize the American University Hospital conservatively.
 *
 * AUH is only accepted as an abbreviation when hospital/medical or clear
 * inpatient delivery context is present. This avoids treating an unrelated
 * three-letter abbreviation as a shared hospital location. Full official
 * names are strong enough on their own.
 */
export function recognizeAUHHospital(value: string | null | undefined): RecognizedAUHHospital | null {
  if (!value?.trim()) return null;

  const normalized = normalizeInstitutionText(value);
  const fullName =
    /\bamerican university(?: of beirut)? hospital\b/.test(normalized);
  const abbreviation = /\b(?:auh|a u h)\b/.test(normalized);
  const hospitalContext =
    /\b(?:hospital|medical center|medical|clinic|ward|patient|inpatient|room|floor|unit|emergency|reception|entrance|maternity)\b/.test(
      normalized,
    );

  if (!fullName && !(abbreviation && hospitalContext)) return null;

  return {
    canonicalName: AUH_HOSPITAL_CANONICAL_NAME,
    placeType: "hospital",
    matchedVariant: fullName ? "American University Hospital" : "AUH",
  };
}

/**
 * Legacy aliases are shared workspace data, so a recognized AUH reference is
 * not enough to retain one. Only standalone official variants are reusable;
 * patient, ward, room, and other order-specific text must remain private.
 */
export function isOfficialAUHHospitalAlias(value: string | null | undefined): boolean {
  if (!value?.trim()) return false;
  return new Set([
    "auh hospital",
    "a u h hospital",
    "american university hospital",
    "american university of beirut hospital",
  ]).has(normalizeInstitutionText(value));
}

/**
 * Recognize a clearly named hospital without attempting to maintain a global
 * hospital directory. A hospital marker plus at least one non-generic name
 * token is enough; bare delivery prose such as "at the hospital" is not.
 */
function validateInstitutionCandidate(
  candidate: string,
  markerPattern: RegExp,
  disqualifyingWords: ReadonlySet<string>,
  identityStopWords: ReadonlySet<string>,
): boolean {
  const normalized = normalizeInstitutionText(candidate);
  const marker = markerPattern.exec(normalized);
  if (!marker) return false;
  const prefixTokens = normalized.slice(0, marker.index).trim().split(/\s+/).filter(Boolean);
  // Reject if any prefix token is a delivery / function word.
  if (prefixTokens.some((t) => disqualifyingWords.has(t))) return false;
  // Require at least one token that carries proper-noun identity.
  const identityTokens = prefixTokens.filter((t) => t.length > 1 && !identityStopWords.has(t));
  return identityTokens.length > 0;
}

export function extractClearlyNamedHospitalTitle(
  value: string | null | undefined,
): string | null {
  if (!value?.trim()) return null;
  const MARKER_PATTERN = /\b(?:hospital|medical center|medical centre|university|clinic)\b/;

  // 1. Preposition-anchored matches have highest priority: the preposition
  //    cleanly terminates any leading prose so "Jane Doe at City Hospital"
  //    produces "City Hospital" rather than the greedy ^-anchored phrase.
  for (const match of value.matchAll(HOSPITAL_NAME_AFTER_PREP)) {
    const candidate = match[1]?.trim();
    if (!candidate) continue;
    if (validateInstitutionCandidate(candidate, MARKER_PATTERN, HOSPITAL_DISQUALIFYING_WORDS, HOSPITAL_IDENTITY_STOP_WORDS)) {
      return candidate;
    }
  }

  // 2. Segment-start matches: institution name at ^ or after a delimiter.
  //    The stop-word check prevents greedy matches that swallow leading prose.
  for (const match of value.matchAll(HOSPITAL_NAME_AT_START)) {
    const candidate = match[1]?.trim();
    if (!candidate) continue;
    if (validateInstitutionCandidate(candidate, MARKER_PATTERN, HOSPITAL_DISQUALIFYING_WORDS, HOSPITAL_IDENTITY_STOP_WORDS)) {
      return candidate;
    }
  }

  return null;
}

export function isClearlyNamedHospital(value: string | null | undefined): boolean {
  return extractClearlyNamedHospitalTitle(value) !== null;
}

/**
 * Recognize a clearly named hotel, resort, or inn without a global directory.
 * Handles both "X Hotel" (name before marker) and "Hotel X" (name after marker)
 * forms. Bare references like "at the hotel" are rejected.
 */
export function extractClearlyNamedHotelTitle(
  value: string | null | undefined,
): string | null {
  if (!value?.trim()) return null;
  const SUFFIX_MARKER = /\b(?:hotel|resort|inn)\b/;
  const PREFIX_MARKER = /^(?:hotel|resort|inn)\s+/;

  // "X Hotel" form — preposition-anchored matches first (highest priority)
  for (const match of value.matchAll(HOTEL_SUFFIX_AFTER_PREP)) {
    const candidate = match[1]?.trim();
    if (!candidate) continue;
    if (validateInstitutionCandidate(candidate, SUFFIX_MARKER, HOTEL_DISQUALIFYING_WORDS, HOTEL_IDENTITY_STOP_WORDS)) {
      return candidate;
    }
  }

  // "X Hotel" form — segment-start fallback
  for (const match of value.matchAll(HOTEL_SUFFIX_AT_START)) {
    const candidate = match[1]?.trim();
    if (!candidate) continue;
    if (validateInstitutionCandidate(candidate, SUFFIX_MARKER, HOTEL_DISQUALIFYING_WORDS, HOTEL_IDENTITY_STOP_WORDS)) {
      return candidate;
    }
  }

  // "Hotel X" form — preposition-anchored matches first
  for (const match of value.matchAll(HOTEL_PREFIX_AFTER_PREP)) {
    const candidate = match[1]?.trim();
    if (!candidate) continue;
    const normalized = normalizeInstitutionText(candidate);
    const markerEnd = PREFIX_MARKER.exec(normalized);
    if (!markerEnd) continue;
    const afterTokens = normalized.slice(markerEnd[0].length).split(/\s+/).filter(Boolean);
    if (afterTokens.some((t) => HOTEL_DISQUALIFYING_WORDS.has(t))) continue;
    const identityTokens = afterTokens.filter((t) => t.length > 1 && !HOTEL_IDENTITY_STOP_WORDS.has(t));
    if (identityTokens.length > 0) return candidate;
  }

  // "Hotel X" form — segment-start fallback
  for (const match of value.matchAll(HOTEL_PREFIX_AT_START)) {
    const candidate = match[1]?.trim();
    if (!candidate) continue;
    const normalized = normalizeInstitutionText(candidate);
    const markerEnd = PREFIX_MARKER.exec(normalized);
    if (!markerEnd) continue;
    const afterTokens = normalized.slice(markerEnd[0].length).split(/\s+/).filter(Boolean);
    if (afterTokens.some((t) => HOTEL_DISQUALIFYING_WORDS.has(t))) continue;
    const identityTokens = afterTokens.filter((t) => t.length > 1 && !HOTEL_IDENTITY_STOP_WORDS.has(t));
    if (identityTokens.length > 0) return candidate;
  }

  return null;
}

export function isNamedHotel(value: string | null | undefined): boolean {
  return extractClearlyNamedHotelTitle(value) !== null;
}

/**
 * Convert a stored type to a human-friendly label, including values from
 * older/custom records that are not in the supported catalog.
 */
export function formatPlaceType(placeType: string | null | undefined): string {
  const value = (placeType ?? "").trim();
  if (!value) return "Unknown";

  const knownLabel = PLACE_TYPE_LABELS[value.toLowerCase() as PlaceType];
  if (knownLabel) return knownLabel;

  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

/**
 * Accommodation names are intentionally narrow. Only the legacy Residence
 * default is eligible for this inference; explicit non-residential choices
 * are never changed.
 */
export function isAccommodationPlaceName(value: string | null | undefined): boolean {
  if (!value?.trim()) return false;

  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return /\bguest\s*houses?\b|\bair\s*bnb\b/i.test(normalized);
}

/**
 * Apply the accommodation rule to a stored/submitted type. Names may include
 * the canonical name and any aliases available at the classification point.
 */
export function classifyPlaceType(
  placeType: string,
  names: readonly (string | null | undefined)[],
): string {
  if (
    placeType.trim().toLowerCase() === "residence" &&
    names.some((name) => isAccommodationPlaceName(name))
  ) {
    return "hotel";
  }
  if (
    placeType.trim().toLowerCase() === "residence" &&
    names.some((name) => isNamedHotel(name))
  ) {
    return "hotel";
  }
  if (
    placeType.trim().toLowerCase() === "residence" &&
    names.some((name) => recognizeAUHHospital(name) !== null)
  ) {
    return "hospital";
  }
  if (
    placeType.trim().toLowerCase() === "residence" &&
    names.some((name) => isClearlyNamedHospital(name))
  ) {
    return "hospital";
  }
  return placeType;
}