/**
 * Locality conflict checker for places.
 *
 * Determines whether a place's stored coordinates are geographically
 * consistent with its assigned city / country by reverse-geocoding the
 * coordinates via Nominatim and comparing the result against the
 * configured delivery geography.
 *
 * This module never reads from or writes to the database; callers are
 * responsible for persisting `location_conflict` on the place row.
 */
import { logger } from "./logger.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ConflictCheckInput {
  latitude: number;
  longitude: number;
  /** Expected city name from delivery_cities.name (e.g. "Dubai"). */
  cityName?: string | null;
  /** Expected ISO 3166-1 alpha-2 country code stored on delivery_cities (e.g. "ae"). */
  countryCode?: string | null;
  /** Expected neighbourhood / area from places.area — used for explanation only. */
  area?: string | null;
}

export interface ConflictCheckResult {
  conflict: boolean;
  explanation: string;
}

// ── Internal types ────────────────────────────────────────────────────────────

interface NominatimAddress {
  city?: string;
  town?: string;
  village?: string;
  municipality?: string;
  suburb?: string;
  county?: string;
  state?: string;
  state_district?: string;
  country?: string;
  country_code?: string;
  "ISO3166-2-lvl4"?: string;
  "ISO3166-2-lvl6"?: string;
}

export interface NominatimReverseResult {
  address?: NominatimAddress;
  display_name?: string;
  error?: string;
}

// ── Country-code alias table ──────────────────────────────────────────────────

/**
 * Map of ISO 3166-1 alpha-2 codes to their common aliases.
 * Used so that "AE", "ae", "UAE", and "United Arab Emirates" all resolve to
 * the same country when comparing against a Nominatim `country_code`.
 */
const COUNTRY_CODE_ALIASES: Record<string, string[]> = {
  ae: ["ae", "uae", "united arab emirates", "emirates"],
  lb: ["lb", "lbn", "lebanon"],
  cy: ["cy", "cyp", "cyprus"],
  kw: ["kw", "kwt", "kuwait"],
  sa: ["sa", "sau", "saudi arabia", "ksa"],
  qa: ["qa", "qat", "qatar"],
  bh: ["bh", "bhr", "bahrain"],
  om: ["om", "omn", "oman"],
  jo: ["jo", "jor", "jordan"],
  eg: ["eg", "egy", "egypt"],
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
}

/**
 * Return true if the Nominatim result country code is consistent with the
 * expected value.  `expected` may be a bare ISO code ("ae"), a name alias
 * ("UAE"), or a full country name ("United Arab Emirates").
 */
function countryCodeMatches(resultCode: string, expected: string): boolean {
  const normResult = normalizeText(resultCode);
  const normExpected = normalizeText(expected);
  // Direct code equality
  if (normResult === normExpected) return true;
  // Check via alias table keyed by result code
  const aliases = COUNTRY_CODE_ALIASES[normResult];
  if (aliases) return aliases.includes(normExpected);
  // Reverse: check if expected is a code whose alias table includes the result
  for (const [, aliasSet] of Object.entries(COUNTRY_CODE_ALIASES)) {
    if (aliasSet.includes(normExpected) && aliasSet.includes(normResult)) return true;
  }
  return false;
}

/**
 * Return true if any Nominatim locality field matches the expected city name.
 * Partial word overlap is accepted because "Abu Dhabi" appears as "Abu Dhabi"
 * in some Nominatim results but as "Municipality of Abu Dhabi" in others.
 */
function cityMatches(addr: NominatimAddress, expectedCity: string): boolean {
  const norm = normalizeText(expectedCity);
  const candidates = [
    addr.city,
    addr.town,
    addr.village,
    addr.county,
    addr.state_district,
    addr.suburb,
    addr.state,
  ].filter((c): c is string => Boolean(c));

  for (const candidate of candidates) {
    const normCandidate = normalizeText(candidate);
    if (normCandidate.includes(norm) || norm.includes(normCandidate)) return true;
    // Word-level overlap: every meaningful word of the expected city appears
    const words = norm.split(" ").filter((w) => w.length > 2);
    if (words.length > 0 && words.every((w) => normCandidate.includes(w))) return true;
  }
  return false;
}

// ── Nominatim caller (exported for test stubbing) ─────────────────────────────

export async function reverseGeocode(
  latitude: number,
  longitude: number,
): Promise<NominatimReverseResult | null> {
  const params = new URLSearchParams({
    lat: String(latitude),
    lon: String(longitude),
    format: "json",
    addressdetails: "1",
    "accept-language": "en",
  });
  const url = `https://nominatim.openstreetmap.org/reverse?${params}`;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Presentail/1.0 (place-conflict-checker; contact@presentail.com)",
        Accept: "application/json",
        "Accept-Language": "en",
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      logger.warn(
        { status: res.status, latitude, longitude },
        "placeConflictChecker: Nominatim returned non-200",
      );
      return null;
    }
    return (await res.json()) as NominatimReverseResult;
  } catch (err) {
    logger.warn(
      { err, latitude, longitude },
      "placeConflictChecker: reverse geocode request failed",
    );
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Check whether the given coordinates are geographically consistent with
 * the place's assigned country / city.
 *
 * Returns `{ conflict: false }` whenever the conflict cannot be determined
 * (Nominatim unavailable, no constraints provided) so that network hiccups
 * never incorrectly flag a place.
 */
export async function checkPlaceLocationConflict(
  input: ConflictCheckInput,
): Promise<ConflictCheckResult> {
  const { latitude, longitude, cityName, countryCode } = input;

  // Nothing to compare against
  if (!cityName && !countryCode) {
    return {
      conflict: false,
      explanation: "No geographic constraint assigned — nothing to compare",
    };
  }

  const geocoded = await reverseGeocode(latitude, longitude);

  if (!geocoded || geocoded.error || !geocoded.address) {
    return {
      conflict: false,
      explanation: "Coordinates could not be verified via reverse geocode",
    };
  }

  const addr = geocoded.address;
  const resultCode = (addr.country_code ?? "").toLowerCase().trim();

  // ── Country check (strongest signal) ───────────────────────────────────────
  if (countryCode && resultCode) {
    if (!countryCodeMatches(resultCode, countryCode)) {
      const resultCountryName = addr.country ?? resultCode.toUpperCase();
      return {
        conflict: true,
        explanation: `Coordinates are in ${resultCountryName} but the place is assigned to ${countryCode.toUpperCase()}`,
      };
    }
  }

  // ── City check ─────────────────────────────────────────────────────────────
  if (cityName) {
    if (!cityMatches(addr, cityName)) {
      const resolvedLocality = [addr.city, addr.town, addr.village, addr.county]
        .filter(Boolean)
        .join(" / ") || "an unknown locality";
      return {
        conflict: true,
        explanation: `Coordinates appear to be in "${resolvedLocality}" but the place is assigned to "${cityName}"`,
      };
    }
  }

  return {
    conflict: false,
    explanation: "Coordinates are consistent with the assigned country and city",
  };
}
