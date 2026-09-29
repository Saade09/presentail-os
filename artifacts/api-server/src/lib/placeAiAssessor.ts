/**
 * AI-powered place validity assessor and safe geocoder.
 *
 * The AI is allowed to refine address text into search hints, but it is never
 * trusted with coordinates. Every coordinate returned by this module comes
 * from a validated OpenStreetMap/Nominatim result.
 */

import { openai } from "@workspace/integrations-openai-ai-server/image";
import { findCountryByCode, findCountryByName } from "./defaults.js";
import { logger } from "./logger.js";
import {
  getGooglePlaceDetails,
  MapProviderError,
  searchGooglePlacesText,
  searchNominatim,
  type GooglePlaceDetails,
  type ProviderHealthUpdate,
  type ProviderName,
} from "./mapProvider.js";
import { aiUsageAttribution } from "./aiUsageRecorder.js";

// ── AI validity check ─────────────────────────────────────────────────────────

const VALIDITY_PROMPT = `You are an address validation assistant for a delivery company operating in the Middle East and Lebanon.

Determine whether the supplied text represents a REAL, geocodable delivery location (a street address, building, landmark, villa community, or area) or is only a placeholder, instruction, or non-address text.

Respond with ONLY a valid JSON object — no markdown, no explanation:
{
  "valid": true,
  "reason": "Brief reason (10-20 words)",
  "location_hints": {
    "normalized_address": "A cleaned address, if one can be safely inferred",
    "building_or_venue": "A named building, business, venue, institution, mall, hotel, school, or hospital",
    "landmark": "A named landmark, building, or community, if present",
    "street": "A named street or road, without unit details",
    "neighborhood": "The most specific neighborhood or district explicitly present",
    "town": "The town or municipality explicitly present",
    "search_anchor": "The strongest explicit landmark or institution target to search",
    "anchor_type": "landmark or institution, when search_anchor is present",
    "area": "A neighborhood or area, if present",
    "city": "A city, only when supplied or strongly implied by context",
    "country": "A country, only when supplied or strongly implied by context",
    "unit_details": "Floor, apartment, room, block, suite, or other sub-unit text",
    "delivery_instructions": "Contact, access, proximity, or handoff instructions that are not part of the mapped place",
    "search_queries": ["Tiered map-search queries from most specific to least specific"],
    "semantic_clues": ["Short place-identifying clues grounded in the supplied address"]
  }
}

Rules:
- "valid": true means the text contains enough geographic information that a geocoding service could plausibly find coordinates.
- "valid": false means the text is not an address at all (instructions, placeholders, gibberish, names without location context).
- Partial or informal addresses (for example "Hamra, near the petrol station") should be valid: true.
- Delivery instructions and contact details are context only. They never turn a non-address into a valid address.
- location_hints may contain text only. Never return latitude, longitude, coordinates, map URLs, or directions.
- Separate building_or_venue, landmark, street, neighborhood, town, city, country, unit_details, and delivery_instructions. Unit details and delivery instructions are never map-search targets.
- Do not invent a street, landmark, locality, city, or country. Leave an unknown hint out.
- search_queries must be ordered from most specific to least specific, producing three tiers:
  (a) The full cleaned address (sub-unit details such as floor, flat, room, gate, apt, suite stripped if they are unlikely to appear in a mapping database).
  (b) Just the landmark or building name plus area/city (omit specific sub-unit or unit designations).
  (c) Just the area plus city.
  Each tier must be a short, clean map-search query derived only from the supplied address and context — no invented facts.
- When the address contains sub-unit tokens (Floor, Flat, Apt, Room, Gate, Unit, Suite, Office, Wing, Ward, Block) that are unlikely to be found as standalone map entries, omit them from search_queries and fall back to the enclosing street, landmark, or area.
- When the address text contains a clearly named institution (a hospital, clinic, medical centre, hotel, or resort), search_queries must use only the institution name and its city/country. Strip room numbers, floor designations, ward names, patient names, guest names, and any other sub-unit or delivery-specific details before including text in search_queries.
- When the address contains an explicit proximity landmark (for example, "near Pain D'Or" or "next to the old bridge"), set search_anchor to that landmark alone and set anchor_type to "landmark". Do not include the proximity wording or the following street/building/instruction fragments.
- Recognizable institution acronyms (for example, AUBMC) are valid search_anchor values. Remove trailing floors, rooms, ordinal numbers, and delivery-specific numeric details from the anchor and institution queries.
- semantic_clues may translate, transliterate, or expand a supplied clue (for example Rue Hamra → Hamra Street, or جبيل → Byblos), but must never add a new place.
- The reason must be concise (under 25 words).
- Always write every field in location_hints in English, even when the input address is in another language.
`;

export interface PlaceLocationHints {
  normalizedAddress?: string;
  buildingOrVenue?: string;
  landmark?: string;
  street?: string;
  neighborhood?: string;
  town?: string;
  searchAnchor?: string;
  anchorType?: "landmark" | "institution";
  area?: string;
  city?: string;
  country?: string;
  unitDetails?: string;
  deliveryInstructions?: string;
  searchQueries?: string[];
  semanticClues?: string[];
}

export interface PlaceAssessmentContext {
  workspaceOwnerId?: string | null;
  orderId?: string | number | null;
  city?: string | null;
  country?: string | null;
  area?: string | null;
  canonicalAddress?: string | null;
  aliases?: string[];
  phone?: string | null;
  deliveryInstructions?: string | null;
  geographyConflict?: boolean;
  /**
   * Optional weak evidence from an existing non-protected pin. Trusted
   * manual/GPS/delivery coordinates must never be passed here as a way to
   * override the protection gate; this is only a ranking signal.
   */
  trustedLatitude?: number | null;
  trustedLongitude?: number | null;
  /**
   * Provenance is kept explicit in candidate evidence. Protected sources are
   * never used as a ranking override by the audit/reverification callers.
   */
  trustedCoordinateSource?: string | null;
}

export interface PlaceAssessment {
  valid: boolean;
  reason: string;
  locationHints?: PlaceLocationHints;
}

function cleanHint(value: unknown, maxLength = 240): string | undefined {
  if (typeof value !== "string") return undefined;
  const valueTrimmed = value.trim();
  return valueTrimmed ? valueTrimmed.slice(0, maxLength) : undefined;
}

function parseLocationHints(value: unknown): PlaceLocationHints | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const rawQueries = Array.isArray(raw.search_queries)
    ? raw.search_queries
    : Array.isArray(raw.searchQueries)
      ? raw.searchQueries
      : [];
  const searchQueries = rawQueries
    .map((query) => cleanHint(query, 300))
    .filter((query): query is string => Boolean(query))
    .slice(0, 8);
  const rawClues = Array.isArray(raw.semantic_clues)
    ? raw.semantic_clues
    : Array.isArray(raw.semanticClues)
      ? raw.semanticClues
      : [];
  const semanticClues = rawClues
    .map((clue) => cleanHint(clue, 240))
    .filter((clue): clue is string => Boolean(clue))
    .slice(0, 8);

  const hints: PlaceLocationHints = {
    normalizedAddress: cleanHint(raw.normalized_address ?? raw.normalizedAddress),
    buildingOrVenue: cleanHint(raw.building_or_venue ?? raw.buildingOrVenue),
    landmark: cleanHint(raw.landmark),
    street: cleanHint(raw.street),
    neighborhood: cleanHint(raw.neighborhood ?? raw.neighbourhood),
    town: cleanHint(raw.town ?? raw.municipality),
    searchAnchor: cleanHint(raw.search_anchor ?? raw.searchAnchor),
    ...(raw.anchor_type === "landmark" || raw.anchor_type === "institution"
      ? { anchorType: raw.anchor_type }
      : raw.anchorType === "landmark" || raw.anchorType === "institution"
        ? { anchorType: raw.anchorType }
        : {}),
    area: cleanHint(raw.area),
    city: cleanHint(raw.city),
    country: cleanHint(raw.country),
    unitDetails: cleanHint(raw.unit_details ?? raw.unitDetails),
    deliveryInstructions: cleanHint(raw.delivery_instructions ?? raw.deliveryInstructions),
    ...(searchQueries.length ? { searchQueries } : {}),
    ...(semanticClues.length ? { semanticClues } : {}),
  };
  return Object.values(hints).some((hint) => (Array.isArray(hint) ? hint.length > 0 : Boolean(hint)))
    ? hints
    : undefined;
}

export async function assessPlaceValidity(
  name: string,
  aliases: string[],
  context?: PlaceAssessmentContext,
): Promise<PlaceAssessment> {
  const addressText = [name, ...aliases].filter(Boolean).join(" | ");
  const contextLines = [
    context?.canonicalAddress ? `Canonical address: ${context.canonicalAddress}` : null,
    context?.aliases?.length ? `Approved address aliases: ${context.aliases.join(" | ")}` : null,
    context?.area ? `Area or locality: ${context.area}` : null,
    context?.city ? `City: ${context.city}` : null,
    context?.country ? `Country: ${context.country}` : null,
    context?.phone ? `Delivery phone: ${context.phone}` : null,
    context?.deliveryInstructions
      ? `Delivery instructions: ${context.deliveryInstructions}`
      : null,
  ].filter(Boolean);

  const model = process.env.AI_PLACE_ASSESSOR_MODEL ?? "gpt-4o-mini";

  let rawText: string;
  try {
    const { callAI } = await import("./ai/callAI.js");
    const response = await callAI({
      actionKey: "places.validity_assessment",
      surface: "places",
      provider: "openai",
      model,
      client: openai,
      country: context?.country ?? null,
      ...aiUsageAttribution({
        workspaceOwnerId: context?.workspaceOwnerId,
        orderId: context?.orderId,
        country: context?.country,
      }),
      maxTokens: 8192,
      messages: [
        { role: "system", content: VALIDITY_PROMPT },
        {
          role: "user",
          content: [
            `Address text to assess:\n${addressText}`,
            contextLines.length
              ? `Delivery context (not an address by itself):\n${contextLines.join("\n")}`
              : null,
          ]
            .filter(Boolean)
            .join("\n\n"),
        },
      ],
    });
    rawText = response.choices[0]?.message?.content ?? "";
  } catch (err) {
    logger.error({ err }, "placeAiAssessor: OpenAI API call failed");
    throw new Error(
      "AI assessment failed: " +
        (err instanceof Error ? err.message : "Unknown error"),
    );
  }

  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("AI assessment returned no valid JSON");

  let parsed: {
    valid?: boolean;
    reason?: string;
    location_hints?: unknown;
    locationHints?: unknown;
  };
  try {
    parsed = JSON.parse(jsonMatch[0]) as typeof parsed;
  } catch {
    throw new Error("AI assessment returned invalid JSON");
  }

  const locationHints = parseLocationHints(parsed.location_hints ?? parsed.locationHints);
  return {
    valid: parsed.valid === true,
    reason: typeof parsed.reason === "string" ? parsed.reason.trim() : "",
    ...(locationHints ? { locationHints } : {}),
  };
}

// ── Nominatim geocoder ────────────────────────────────────────────────────────

interface NominatimResult {
  place_id?: number;
  osm_id?: number;
  osm_type?: string;
  lat: string;
  lon: string;
  display_name: string;
  type?: string;
  class?: string;
  importance?: number;
  address?: Record<string, string>;
}

export type GeocodeMatchType = "exact" | "approximate";
export type GeocodePrecision = "exact" | "landmark" | "street" | "locality";
export type GeocodeResultLevel =
  | "premise"
  | "landmark"
  | "street"
  | "neighborhood"
  | "municipality"
  | "city"
  | "country"
  | "locality";
export type GeocodeMethod =
  | "exact_match"
  | "landmark_match"
  | "street_match"
  | "locality_fallback";

export interface GeocodeResult {
  lat: number;
  lng: number;
  matchType: GeocodeMatchType;
  precision: GeocodePrecision;
  method: GeocodeMethod;
  resultLevel?: GeocodeResultLevel;
  matchedLocation: string;
  query: string;
  provider: "google_places" | "nominatim";
  placeIdentity: string | null;
  evidenceScore: number;
  confidenceEvidence?: Record<string, unknown>;
  queriesTried?: string[];
  providerTypes?: string[];
  candidateEvidence?: Array<Record<string, unknown>>;
}

export interface GeocodeProviderOptions {
  skipProviders?: ProviderName[];
  onProviderHealth?: (update: ProviderHealthUpdate) => Promise<void> | void;
  onCandidateEvidence?: (evidence: Record<string, unknown>) => void;
}

function providerHealthForError(error: MapProviderError): ProviderHealthUpdate {
  const status =
    error.failureType === "configuration_authentication"
      ? error.code === "not_configured" ? "disabled_unconfigured" : "configuration_failure"
      : error.failureType === "quota_rate_limit"
        ? "rate_limited"
        : "temporarily_unavailable";
  return {
    provider: error.provider,
    status,
    httpStatus: error.upstreamStatus ?? null,
    errorCategory: error.errorCategory ?? error.failureType,
    providerMessage: error.providerMessage ?? null,
    lastChecked: new Date().toISOString(),
  };
}

function healthyProviderUpdate(provider: ProviderName): ProviderHealthUpdate {
  return {
    provider,
    status: "healthy",
    httpStatus: 200,
    errorCategory: null,
    providerMessage: null,
    lastChecked: new Date().toISOString(),
  };
}

interface NormalizedGeocodeCandidate {
  provider: "google_places" | "nominatim";
  placeIdentity: string | null;
  lat: number;
  lng: number;
  rawProviderTypes: string[];
  resultLevel: GeocodeResultLevel;
  precision: GeocodePrecision;
  formattedAddress: string;
  name: string;
  premiseEvidence: number;
  landmarkEvidence: number;
  streetEvidence: number;
  neighborhoodEvidence: number;
  municipalityEvidence: number;
  country: string | null;
  addressSimilarity: number;
  localitySimilarity: number;
  trustedDistanceKm: number | null;
  contradictions: string[];
  query: string;
  queryIndex: number;
  decisionScore: number;
  providerScore: number;
  auditEvidence: Record<string, unknown>;
}

function clampUnit(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function precisionEvidence(precision: GeocodePrecision): number {
  return {
    exact: 1,
    landmark: 0.86,
    street: 0.68,
    locality: 0.25,
  }[precision];
}

function normalizedCandidateScore(candidate: Omit<NormalizedGeocodeCandidate, "decisionScore">): number {
  const structuralEvidence = Math.max(
    candidate.premiseEvidence,
    candidate.landmarkEvidence,
    candidate.streetEvidence,
    candidate.neighborhoodEvidence,
    candidate.municipalityEvidence,
  );
  const trustedProximity = candidate.trustedDistanceKm == null
    ? 0
    : clampUnit(1 - candidate.trustedDistanceKm / 15);
  // Provider-specific retrieval scores are retained in the audit record, but
  // final acceptance uses this shared, bounded score for both providers.
  return clampUnit(
    precisionEvidence(candidate.precision) * 0.45 +
    clampUnit(candidate.addressSimilarity) * 0.25 +
    clampUnit(candidate.localitySimilarity) * 0.2 +
    clampUnit(structuralEvidence) * 0.08 +
    trustedProximity * 0.02,
  );
}

function candidateAuditEvidence(candidate: NormalizedGeocodeCandidate): Record<string, unknown> {
  return {
    provider: candidate.provider,
    place_id: candidate.placeIdentity,
    provider_types: candidate.rawProviderTypes,
    result_level: candidate.resultLevel,
    precision: candidate.precision,
    formatted_address: candidate.formattedAddress,
    name: candidate.name,
    premise_evidence: candidate.premiseEvidence,
    landmark_evidence: candidate.landmarkEvidence,
    street_evidence: candidate.streetEvidence,
    neighborhood_evidence: candidate.neighborhoodEvidence,
    municipality_evidence: candidate.municipalityEvidence,
    country: candidate.country,
    address_similarity: candidate.addressSimilarity,
    locality_similarity: candidate.localitySimilarity,
    trusted_distance_km: candidate.trustedDistanceKm,
    trusted_coordinate_source: candidate.auditEvidence.trusted_coordinate_source ?? null,
    contradictions: candidate.contradictions,
    query: candidate.query,
    query_index: candidate.queryIndex,
    provider_score: candidate.providerScore,
    deterministic_score: candidate.decisionScore,
  };
}

function finalizeNormalizedCandidates(
  candidates: NormalizedGeocodeCandidate[],
  queriesTried: string[],
): GeocodeResult | null {
  const usable = candidates
    .filter((candidate) => candidate.contradictions.length === 0)
    .sort((a, b) =>
      b.decisionScore - a.decisionScore ||
      a.queryIndex - b.queryIndex ||
      String(a.placeIdentity).localeCompare(String(b.placeIdentity)) ||
      a.formattedAddress.localeCompare(b.formattedAddress),
    );
  const best = usable[0];
  if (!best) return null;

  const deduped: NormalizedGeocodeCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of usable) {
    const identity = `${candidate.provider}:${candidate.placeIdentity ?? `${candidate.lat.toFixed(6)}:${candidate.lng.toFixed(6)}`}`;
    if (!seen.has(identity)) {
      seen.add(identity);
      deduped.push(candidate);
    }
  }
  const rankedBest = deduped[0];
  if (!rankedBest) return null;
  const runnerUp = deduped.find((candidate) =>
    candidate.placeIdentity !== rankedBest.placeIdentity ||
    candidate.provider !== rankedBest.provider,
  );

  // Locality-only results are review context, not delivery candidates. For
  // precise candidates, close scores are unsafe to guess between.
  if (
    runnerUp &&
    rankedBest.precision !== "locality" &&
    runnerUp.precision === rankedBest.precision &&
    rankedBest.decisionScore - runnerUp.decisionScore < 0.08
  ) {
    throw new MapProviderError(
      rankedBest.provider,
      "ambiguity",
      `${rankedBest.provider} returned multiple similarly supported address candidates`,
      false,
      undefined,
      null,
      rankedBest.provider === "google_places" ? "text_search" : "geocode",
      rankedBest.query,
    );
  }

  const candidateEvidence = deduped.map((candidate) => candidateAuditEvidence(candidate));
  return {
    lat: rankedBest.lat,
    lng: rankedBest.lng,
    matchType: rankedBest.precision === "exact" ? "exact" : "approximate",
    precision: rankedBest.precision,
    method: methodForPrecision(rankedBest.precision),
    resultLevel: rankedBest.resultLevel,
    matchedLocation: rankedBest.formattedAddress,
    query: rankedBest.query,
    provider: rankedBest.provider,
    placeIdentity: rankedBest.placeIdentity,
    evidenceScore: rankedBest.decisionScore,
    queriesTried,
    providerTypes: rankedBest.rawProviderTypes,
    confidenceEvidence: {
      candidate_count: deduped.length,
      candidate_margin: runnerUp ? rankedBest.decisionScore - runnerUp.decisionScore : null,
      deterministic_score: rankedBest.decisionScore,
      trusted_distance_km: rankedBest.trustedDistanceKm,
      accepted_candidate_id: rankedBest.placeIdentity,
    },
    candidateEvidence,
  };
}

const GOOGLE_GENERIC_TYPES = new Set([
  "locality", "sublocality", "sublocality_level_1", "administrative_area_level_1",
  "administrative_area_level_2", "administrative_area_level_3", "country",
  "postal_code", "political",
]);
const GOOGLE_STREET_TYPES = new Set(["route", "intersection"]);
const GOOGLE_EXACT_TYPES = new Set([
  "street_address", "premise", "subpremise", "establishment", "point_of_interest",
  "lodging", "hotel", "hospital", "school", "shopping_mall", "store", "restaurant",
  "apartment_building", "corporate_office",
]);

function googleComponent(details: GooglePlaceDetails, types: string[]): string | null {
  return details.addressComponents.find((component) =>
    component.types?.some((type) => types.includes(type)),
  )?.longText?.trim() ?? null;
}

function googleLocalityText(details: GooglePlaceDetails): string {
  return [
    googleComponent(details, ["neighborhood", "sublocality", "sublocality_level_1"]),
    googleComponent(details, ["locality", "administrative_area_level_2"]),
    details.formattedAddress,
  ].filter(Boolean).join(" ");
}

function resultLevelForNominatim(
  result: NominatimResult,
  precision: GeocodePrecision,
): GeocodeResultLevel {
  if (precision === "exact") return "premise";
  if (precision === "landmark") return "landmark";
  if (precision === "street") return "street";
  const type = normalizeSearchText(result.type ?? "");
  if (["neighbourhood", "suburb", "quarter"].includes(type)) return "neighborhood";
  if (["town", "village", "municipality", "county", "hamlet"].includes(type)) {
    return "municipality";
  }
  if (type === "city") return "city";
  if (type === "country") return "country";
  return "locality";
}

function resultLevelForGoogle(
  details: GooglePlaceDetails,
  precision: GeocodePrecision,
): GeocodeResultLevel {
  if (precision === "exact") return "premise";
  if (precision === "landmark") return "landmark";
  if (precision === "street") return "street";
  const types = new Set([details.primaryType, ...details.types].filter(Boolean));
  if ([...types].some((type) => ["neighborhood", "sublocality", "sublocality_level_1"].includes(type!))) {
    return "neighborhood";
  }
  if ([...types].some((type) => ["administrative_area_level_2", "administrative_area_level_3"].includes(type!))) {
    return "municipality";
  }
  if (types.has("locality")) return "city";
  if (types.has("country")) return "country";
  return "locality";
}

async function resolveWithGoogle(
  queries: string[],
  addressText: string,
  context: PlaceAssessmentContext,
  hints: PlaceLocationHints | undefined,
  onProviderHealth?: GeocodeProviderOptions["onProviderHealth"],
): Promise<GeocodeResult | null> {
  if (process.env.NODE_ENV === "test" && process.env.ENABLE_GOOGLE_PLACES_TEST !== "true") {
    return null;
  }
  if (!queries.length) return null;
  const anchor = resolveSearchAnchor(sanitizeLocationHints(hints, addressText, context), extractSearchAnchor(addressText)) ||
    hints?.buildingOrVenue || hints?.landmark || stripSubUnits(addressText);
  const expectedCountry = countryCodesFor(context.country ?? hints?.country ?? "")[0]?.toUpperCase();
  const expectedLocalities = [
    hints?.neighborhood, hints?.town, hints?.area, context.area, context.city,
  ].filter((value): value is string => Boolean(value?.trim()));
  const strictExpectedLocalities = [
    hints?.neighborhood,
    hints?.town,
    hints?.area,
    ...rawSpecificLocalities(addressText, context),
  ].filter((value): value is string => Boolean(value?.trim()));
  const scored: Array<{
    details: GooglePlaceDetails;
    query: string;
    score: number;
    precision: GeocodePrecision;
    nameScore: number;
    localityScore: number;
  }> = [];
  const queriesTried: string[] = [];
  let lastProviderError: MapProviderError | null = null;

  for (const query of queries.slice(0, 5)) {
    queriesTried.push(query);
    try {
      const matches = await searchGooglePlacesText({
        textQuery: query,
        regionCode: expectedCountry,
        pageSize: 5,
      });
      await onProviderHealth?.(healthyProviderUpdate("google_places"));
      for (const match of matches.slice(0, 3)) {
        const details = await getGooglePlaceDetails(match.placeId);
        const lat = details.location?.latitude;
        const lng = details.location?.longitude;
        if (lat == null || lng == null) continue;
        if (expectedCountry && details.countryCode !== expectedCountry) continue;
        const types = new Set([details.primaryType, ...details.types].filter(Boolean) as string[]);
        const onlyGeneric = [...types].every((type) => GOOGLE_GENERIC_TYPES.has(type));
        if (onlyGeneric) continue;
        const nameTarget = [details.displayName, details.formattedAddress].filter(Boolean).join(" ");
        const nameScore = Math.max(
          semanticMatchScore(anchor, nameTarget),
          semanticMatchScore(hints?.buildingOrVenue ?? "", nameTarget),
          semanticMatchScore(hints?.landmark ?? "", nameTarget),
        );
        const localityText = googleLocalityText(details);
        const localityScore = expectedLocalities.length
          ? Math.max(...expectedLocalities.map((value) => semanticMatchScore(value, localityText)))
          : 1;
        const strictLocalityScore = strictExpectedLocalities.length
          ? Math.max(...strictExpectedLocalities.map((value) => semanticMatchScore(value, localityText)))
          : 1;
        if (expectedLocalities.length && localityScore < 0.4) continue;
        // A city match cannot compensate for an explicitly supplied
        // neighborhood/town mismatch. Provider precision is never allowed to
        // overpower this semantic locality contradiction.
        if (strictExpectedLocalities.length && strictLocalityScore < 0.4) continue;
        const precision: GeocodePrecision = [...types].some((type) => GOOGLE_STREET_TYPES.has(type))
          ? "street"
          : [...types].some((type) => GOOGLE_EXACT_TYPES.has(type)) && nameScore >= 0.62
            ? "exact"
            : nameScore >= 0.58
              ? "landmark"
              : "locality";
        if (precision === "locality") continue;
        const score = nameScore * 0.65 + localityScore * 0.25 +
          (precision === "exact" ? 0.1 : precision === "landmark" ? 0.05 : 0);
        scored.push({ details, query, score, precision, nameScore, localityScore });
      }
    } catch (error) {
      if (error instanceof MapProviderError) {
        lastProviderError = error;
        await onProviderHealth?.(providerHealthForError(error));
      }
      logger.warn({ error }, "placeAiAssessor: Google Places search failed");
      // Retrying another address query cannot repair a provider-wide auth or
      // configuration failure, and creates unnecessary calls for a broken key.
      if (error instanceof MapProviderError) break;
    }
  }

  scored.sort((a, b) => b.score - a.score || String(a.details.placeId).localeCompare(String(b.details.placeId)));
  if (!scored.length) {
    if (lastProviderError && scored.length === 0) throw lastProviderError;
    return null;
  }
  const normalizedCandidates = scored.flatMap((candidate) => {
    const lat = candidate.details.location?.latitude;
    const lng = candidate.details.location?.longitude;
    if (lat == null || lng == null) return [];
    const formattedAddress = candidate.details.formattedAddress ??
      candidate.details.displayName ??
      candidate.query;
    const normalized: Omit<NormalizedGeocodeCandidate, "decisionScore"> = {
      provider: "google_places",
      placeIdentity: candidate.details.placeId,
      lat,
      lng,
      rawProviderTypes: candidate.details.types,
      resultLevel: resultLevelForGoogle(candidate.details, candidate.precision),
      precision: candidate.precision,
      formattedAddress,
      name: candidate.details.displayName ?? formattedAddress,
      premiseEvidence: candidate.precision === "exact" ? candidate.nameScore : 0,
      landmarkEvidence: candidate.precision === "landmark" ? candidate.nameScore : 0,
      streetEvidence: candidate.precision === "street" ? candidate.nameScore : 0,
      neighborhoodEvidence: candidate.localityScore,
      municipalityEvidence: candidate.localityScore,
      country: candidate.details.countryCode,
      addressSimilarity: candidate.nameScore,
      localitySimilarity: candidate.localityScore,
      trustedDistanceKm: null,
      contradictions: [],
      query: candidate.query,
      queryIndex: queriesTried.indexOf(candidate.query),
      providerScore: candidate.score,
      auditEvidence: {
        name_similarity: candidate.nameScore,
        locality_similarity: candidate.localityScore,
        country_code: candidate.details.countryCode,
        trusted_coordinate_source: context.trustedCoordinateSource ?? null,
      },
    };
    return [{ ...normalized, decisionScore: normalizedCandidateScore(normalized) }];
  });
  const result = finalizeNormalizedCandidates(normalizedCandidates, queriesTried);
  if (result?.confidenceEvidence) {
    result.confidenceEvidence = {
      ...result.confidenceEvidence,
      provider_name_similarity: normalizedCandidates[0]?.auditEvidence.name_similarity,
      provider_locality_similarity: normalizedCandidates[0]?.auditEvidence.locality_similarity,
    };
  }
  return result;
}

const STOP_WORDS = new Set([
  "the", "and", "near", "next", "to", "at", "in", "of", "on", "road",
  "street", "st", "building", "villa", "house", "address", "please",
]);
const CREDIBLE_TYPES = new Set([
  "house", "building", "residential", "road", "suburb", "neighbourhood",
  "quarter", "village", "town", "city", "municipality", "county", "locality",
  "hamlet", "commercial", "retail", "landmark",
]);
const GENERIC_RESULT_TYPES = new Set([
  "suburb", "neighbourhood", "quarter", "village", "town", "city",
  "municipality", "county", "locality", "hamlet",
]);
const SPECIFIC_RESULT_FIELDS = new Set([
  "house_number", "road", "building", "house", "amenity", "shop",
  "tourism", "hospital", "hotel", "office", "residential",
]);
function normalizeSearchText(value: string): string {
  return value
    .toLocaleLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    // Common Lebanese Arabic locality spellings. These replacements happen
    // before character transliteration so words such as الحمرا retain their
    // established Latin map-search form rather than becoming opaque letters.
    .replace(/الأشرفية|الاشرفية/gu, "achrafieh")
    .replace(/مار\s*مخايل/gu, "mar mikhael")
    .replace(/جل\s*الديب/gu, "jal el dib")
    .replace(/سن\s*الفيل/gu, "sin el fil")
    .replace(/الحمرا|حمراء/gu, "hamra")
    .replace(/بيروت/gu, "beirut")
    .replace(/جونية/gu, "jounieh")
    .replace(/جبيل/gu, "byblos")
    .replace(/طرابلس/gu, "tripoli")
    .replace(/زحلة/gu, "zahle")
    .replace(/بعبدا/gu, "baabda")
    .replace(/ضبية/gu, "dbayeh")
    .replace(/انطلياس/gu, "antelias")
    .replace(/شارع/gu, "street")
    .replace(/طريق/gu, "road")
    .replace(/مبنى/gu, "building")
    .replace(/قرب|بالقرب\s+من/gu, "near")
    .replace(/بجانب|حد/gu, "next to")
    // Common Lebanese Latin transliteration variants. These are matching
    // aliases only; the stored/customer-facing address remains untouched.
    .replace(/\b(?:ashrafieh|ashrafiyeh|achrafiyeh)\b/gu, "achrafieh")
    .replace(/\b(?:jouniyeh|jouniyeh)\b/gu, "jounieh")
    .replace(/\b(?:zalqa|zalkaa)\b/gu, "zalka")
    .replace(/\b(?:dbaye|dbayeh)\b/gu, "dbayeh")
    .replace(/\b(?:hazmiyeh|hazmieh)\b/gu, "hazmieh")
    .replace(/\b(?:broumana|brummana|broumanna)\b/gu, "broumanna")
    .replace(/[\u0600-\u06ff]/gu, (character) => {
      const arabicChars: Record<string, string> = {
        ا: "a", أ: "a", إ: "a", آ: "a", ب: "b", ت: "t", ث: "th",
        ج: "j", ح: "h", خ: "kh", د: "d", ذ: "dh", ر: "r", ز: "z",
        س: "s", ش: "sh", ص: "s", ض: "d", ط: "t", ظ: "z", ع: "a",
        غ: "gh", ف: "f", ق: "q", ك: "k", ل: "l", م: "m", ن: "n",
        ه: "h", و: "w", ي: "y", ى: "a", ة: "a",
      };
      return arabicChars[character] ?? "";
    })
    .replace(/['’‘`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function meaningfulTokens(value: string): string[] {
  return normalizeSearchText(value)
    .split(" ")
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

const SEMANTIC_SYNONYMS: Record<string, string> = {
  rue: "street",
  st: "street",
  road: "street",
  rd: "street",
  avenue: "street",
  ave: "street",
  boulevard: "street",
  blvd: "street",
  voie: "street",
  immeuble: "building",
  bldg: "building",
  tower: "building",
  residence: "building",
  resid: "building",
  quartier: "area",
  district: "area",
  neighborhood: "area",
  suburb: "area",
  près: "near",
  proche: "near",
  adjacent: "next",
  beside: "next",
  opposite: "across",
  clinique: "clinic",
  medical: "hospital",
  centre: "center",
  center: "center",
  centreville: "downtown",
  hotel: "hotel",
  hosp: "hospital",
  univ: "university",
};

function semanticTokens(value: string): string[] {
  const stopWords = new Set([
    ...STOP_WORDS,
    "al", "el", "la", "le", "de", "du", "des", "en", "chez",
    "the", "and", "with", "plus", "than",
  ]);
  return normalizeSearchText(value)
    .split(" ")
    .map((token) => SEMANTIC_SYNONYMS[token] ?? token)
    .filter((token) => token.length > 1 && !stopWords.has(token));
}

/**
 * Compare meaning-bearing clues rather than requiring the exact input words
 * to appear in the provider's spelling. This covers transliteration, French
 * address vocabulary, and small map/index spelling differences while retaining
 * a conservative source-token coverage requirement.
 */
export function semanticMatchScore(source: string, target: string): number {
  const sourceTokens = [...new Set(semanticTokens(source))];
  const targetTokens = [...new Set(semanticTokens(target))];
  if (!sourceTokens.length || !targetTokens.length) return 0;
  let matched = 0;
  for (const sourceToken of sourceTokens) {
    if (targetTokens.includes(sourceToken)) {
      matched++;
      continue;
    }
    // A bounded edit-distance-like prefix check handles common map spelling
    // variations (e.g. Jounieh/Jounyeh) without accepting unrelated words.
    if (targetTokens.some((targetToken) =>
      Math.min(sourceToken.length, targetToken.length) >= 4 &&
      (sourceToken.startsWith(targetToken.slice(0, 4)) ||
        targetToken.startsWith(sourceToken.slice(0, 4))),
    )) {
      matched += 0.75;
    }
  }
  return matched / sourceTokens.length;
}

function isSemanticallyGrounded(candidate: string, trustedEvidence: string): boolean {
  const candidateTokens = [...new Set(semanticTokens(candidate))];
  return candidateTokens.length > 0 && candidateTokens.every((token) =>
    semanticMatchScore(token, trustedEvidence) >= 0.75,
  );
}

function dedupeQueries(queries: string[]): string[] {
  const seen = new Set<string>();
  return queries
    .map((query) => query.trim())
    .filter((query) => {
      const key = normalizeSearchText(query);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 12);
}

/**
 * Hints can refine trusted address text, but cannot introduce a location the
 * address/context did not already support. This keeps an AI hallucination from
 * steering Nominatim to an otherwise plausible pin in an arbitrary city.
 */
function sanitizeLocationHints(
  hints: PlaceLocationHints | undefined,
  addressText: string,
  context: PlaceAssessmentContext,
): PlaceLocationHints | undefined {
  if (!hints) return undefined;
  const addressEvidence = [
    addressText,
    context.canonicalAddress,
    context.area,
    ...(context.aliases ?? []),
  ]
    .filter(Boolean)
    .join(" ");
  const isKnownContextValue = (value: string) => {
    const normalizedValue = normalizeSearchText(value);
    return [context.city, context.country]
      .filter((known): known is string => Boolean(known))
      .some((known) => {
        const normalizedKnown = normalizeSearchText(known);
        // Exact match OR the hint value is a substring of the known city/country
        // (e.g. "Beirut" is kept when context.city is "Greater Beirut").
        // The reverse (city substring of hint) is intentionally excluded so
        // "Unrelated Place, Abu Dhabi" is not treated as a known city value.
        return normalizedKnown === normalizedValue || normalizedKnown.includes(normalizedValue);
      });
  };
  const isSupported = (value: string | undefined) =>
    Boolean(value && (
      isSemanticallyGrounded(value, addressEvidence) ||
      isKnownContextValue(value)
    ));
  const searchQueries = (hints.searchQueries ?? []).filter(isSupported);
  const cleanedSearchAnchor = hints.searchAnchor ? cleanSearchAnchor(hints.searchAnchor) : undefined;
  const searchAnchor = cleanedSearchAnchor &&
    isSemanticallyGrounded(cleanedSearchAnchor, addressEvidence)
    ? cleanedSearchAnchor
    : undefined;
  const sanitized: PlaceLocationHints = {
    ...(isSupported(hints.normalizedAddress) ? { normalizedAddress: hints.normalizedAddress } : {}),
    ...(isSupported(hints.buildingOrVenue) ? { buildingOrVenue: hints.buildingOrVenue } : {}),
    ...(isSupported(hints.landmark) ? { landmark: hints.landmark } : {}),
    ...(isSupported(hints.street) ? { street: hints.street } : {}),
    ...(isSupported(hints.neighborhood) ? { neighborhood: hints.neighborhood } : {}),
    ...(isSupported(hints.town) ? { town: hints.town } : {}),
    ...(searchAnchor ? { searchAnchor } : {}),
    ...(searchAnchor && hints.anchorType ? { anchorType: hints.anchorType } : {}),
    ...(isSupported(hints.area) ? { area: hints.area } : {}),
    ...(isSupported(hints.city) ? { city: hints.city } : {}),
    ...(isSupported(hints.country) ? { country: hints.country } : {}),
    // These fields are retained for assessment/audit only and are deliberately
    // excluded from query construction and candidate evidence.
    ...(isSupported(hints.unitDetails) ? { unitDetails: hints.unitDetails } : {}),
    ...(isSupported(hints.deliveryInstructions) ? { deliveryInstructions: hints.deliveryInstructions } : {}),
    ...(searchQueries.length ? { searchQueries } : {}),
    ...(hints.semanticClues?.filter(isSupported).length
      ? { semanticClues: hints.semanticClues.filter(isSupported) }
      : {}),
  };
  return Object.keys(sanitized).length ? sanitized : undefined;
}

/**
 * Remove common sub-unit tokens from address text so the geocoder can retry
 * at building/street level when specific unit details are not in the map index.
 *
 * Strips tokens like: floor, flat, apartment, apt, room, gate, unit, suite,
 * office, ward, wing, block — plus any trailing number or letter identifier.
 */
const SUB_UNIT_PATTERN =
  /\b(?:floor|fl|flat|apartment|apt|room|gate|unit|suite|office|ward|wing|block)\b[\s.#:/-]*(?:[\p{L}\p{N}][.\p{L}\p{N}-]*)?\s*/giu;

const PROXIMITY_ANCHOR_PATTERN =
  /\b(?:near|next\s+to|opposite|beside|behind|across\s+from|in\s+front\s+of|adjacent\s+to)\s+(?:the\s+)?([^,;|]+?)(?=\s*[,;|]\s*|\s*[-–—]\s*|\s+(?:road|street|building|bldg|floor|flat|apartment|apt|room|gate|unit|suite|office|ward|wing|block)\b|$)/iu;
const RECOGNIZABLE_INSTITUTION_ACRONYMS = new Set(["AUBMC"]);
const UPPERCASE_TOKEN_PATTERN = /\b[A-Z][A-Z0-9]{2,7}\b/g;
const GENERIC_PROXIMITY_ANCHOR_PATTERN =
  /^(?:petrol|gas|fuel)\s+station$/iu;
const TRAILING_DELIVERY_DETAILS_PATTERN =
  /(?:\s*[-–—,;]\s*|\s+)(?:\d{1,3}(?:st|nd|rd|th)?)(?:\s+\d{1,6})?\s*$/iu;

function cleanSearchAnchor(value: string): string {
  const explicitProximity = value.match(PROXIMITY_ANCHOR_PATTERN)?.[1];
  return (explicitProximity ?? value)
    .replace(
      /\s*[-–—]\s*[^,;|]*(?:\b(?:building|bldg|floor|flat|apartment|apt|room|gate|unit|suite|office|ward|wing|block)\b|\b\d{1,6}(?:st|nd|rd|th)?\b).*$/iu,
      "",
    )
    .split(/\s+[-–—]\s+|[,;|]/u, 1)[0]!
    .replace(/\s+\b(?:building|bldg|floor|flat|apartment|apt|room|gate|unit|suite|office|ward|wing|block)\b.*$/iu, "")
    .replace(/^[\s,;|:/-]+|[\s,;|:/-]+$/g, "")
    .replace(TRAILING_DELIVERY_DETAILS_PATTERN, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

/**
 * Find an anchor that is explicit in the supplied text. This is deliberately
 * conservative: only proximity phrases and conspicuous institution acronyms
 * are extracted without an AI hint.
 */
export function extractSearchAnchor(text: string): {
  value: string;
  type: "landmark" | "institution";
} | null {
  const proximity = text.match(PROXIMITY_ANCHOR_PATTERN)?.[1];
  if (proximity) {
    const value = cleanSearchAnchor(proximity);
    if (value && !GENERIC_PROXIMITY_ANCHOR_PATTERN.test(normalizeSearchText(value))) {
      return { value, type: "landmark" };
    }
  }

  const acronym = text
    .match(UPPERCASE_TOKEN_PATTERN)
    ?.find((token) => RECOGNIZABLE_INSTITUTION_ACRONYMS.has(token));
  if (acronym) return { value: acronym, type: "institution" };
  return null;
}

function resolveSearchAnchor(
  safeHints: PlaceLocationHints | undefined,
  extractedAnchor: ReturnType<typeof extractSearchAnchor>,
): string {
  // Text parsed directly from the supplied address is stronger evidence than
  // an AI-provided reformulation. AI remains useful when deterministic
  // extraction finds no explicit anchor.
  return cleanSearchAnchor(extractedAnchor?.value ?? safeHints?.searchAnchor ?? "");
}

function stripTrailingDeliveryDetails(text: string): string {
  return text.replace(TRAILING_DELIVERY_DETAILS_PATTERN, "").trim();
}

/**
 * Build deterministic, context-rich queries. AI hints are supplementary; the
 * canonical text and known address context always get priority.
 *
 * Query order:
 *  1. Explicit landmark/institution anchor + context suffix
 *  2. Primary address (delivery suffixes omitted when an anchor exists)
 *  3. Canonical address and aliases
 *  4. AI-hint normalized address and landmark
 *  5. AI-hint search queries
 *  6. Sub-unit stripped tier (retry without floor/flat/apt/etc.)
 *  7. Last-resort breadcrumbs: area+city+country, city+country
 */
export function buildGeocoderQueries(
  addressText: string,
  context: PlaceAssessmentContext = {},
  hints?: PlaceLocationHints,
): string[] {
  const safeHints = sanitizeLocationHints(hints, addressText, context);
  const extractedAnchor = extractSearchAnchor(addressText);
  const anchor = resolveSearchAnchor(safeHints, extractedAnchor);
  const locationSuffix = [context.area, context.city, context.country]
    .filter((value): value is string => Boolean(value?.trim()))
    .join(", ");
  const canonical = context.canonicalAddress?.trim();
  const aliases = context.aliases ?? [];
  const addressForSearch = anchor ? anchor : addressText;
  const contextualAnchorQuery = [anchor, safeHints?.area ?? context.area, safeHints?.city ?? context.city, safeHints?.country ?? context.country]
    .filter(Boolean)
    .join(", ");
  const queries = [
    anchor
      ? contextualAnchorQuery
      : "",
    [addressForSearch, locationSuffix].filter(Boolean).join(", "),
    canonical
      ? [
          stripTrailingDeliveryDetails(stripSubUnits(canonical)),
          locationSuffix,
        ].filter(Boolean).join(", ")
      : "",
    ...aliases.map((alias) => [
      stripTrailingDeliveryDetails(stripSubUnits(alias)),
      locationSuffix,
    ].filter(Boolean).join(", ")),
    safeHints?.normalizedAddress
      ? [safeHints.normalizedAddress, locationSuffix].filter(Boolean).join(", ")
      : "",
    safeHints?.buildingOrVenue
      ? [safeHints.buildingOrVenue, safeHints.town, safeHints.neighborhood, context.country]
          .filter(Boolean)
          .join(", ")
      : "",
    safeHints?.buildingOrVenue && safeHints?.neighborhood
      ? [safeHints.buildingOrVenue, safeHints.neighborhood, context.country].filter(Boolean).join(", ")
      : "",
    safeHints?.buildingOrVenue && safeHints?.town
      ? [safeHints.buildingOrVenue, safeHints.town, context.country].filter(Boolean).join(", ")
      : "",
    safeHints?.landmark
      ? [safeHints.landmark, safeHints.area ?? context.area, safeHints.city ?? context.city, safeHints.country ?? context.country]
          .filter(Boolean)
          .join(", ")
      : "",
    ...(safeHints?.searchQueries ?? []).map((query) => {
      return [query, context.city, context.country].filter(Boolean).join(", ");
    }),
    safeHints?.street
      ? [safeHints.street, safeHints.neighborhood ?? safeHints.town ?? context.area, context.country]
          .filter(Boolean)
          .join(", ")
      : "",
    safeHints?.neighborhood
      ? [safeHints.neighborhood, safeHints.town, context.country].filter(Boolean).join(", ")
      : "",
    safeHints?.town
      ? [safeHints.town, context.country].filter(Boolean).join(", ")
      : "",
  ];

  // Sub-unit stripped tier: retry without floor/flat/apt/etc. tokens
  const strippedText = stripSubUnits(addressText);
  if (!anchor && strippedText !== addressText && strippedText) {
    queries.push([strippedText, locationSuffix].filter(Boolean).join(", "));
    if (canonical) {
      const strippedCanonical = stripSubUnits(canonical);
      if (strippedCanonical !== canonical) {
        queries.push([strippedCanonical, locationSuffix].filter(Boolean).join(", "));
      }
    }
    for (const alias of aliases) {
      const strippedAlias = stripSubUnits(alias);
      if (strippedAlias !== alias && strippedAlias) {
        queries.push([strippedAlias, locationSuffix].filter(Boolean).join(", "));
      }
    }
  }

  // Last-resort breadcrumbs are still queried for provider diagnostics, but
  // geocodeAddress refuses to promote their generic locality results.
  const areaFallback = [context.area, context.city, context.country].filter(Boolean).join(", ");
  const cityFallback = [context.city, context.country].filter(Boolean).join(", ");
  if (areaFallback) queries.push(areaFallback);
  if (cityFallback) queries.push(cityFallback);

  return dedupeQueries(queries);
}

function resultText(result: NominatimResult): string {
  return [
    result.display_name,
    ...Object.values(result.address ?? {}),
  ]
    .filter(Boolean)
    .join(" ");
}

function overlapScore(source: string, target: string): number {
  const sourceTokens = meaningfulTokens(source);
  if (!sourceTokens.length) return 0;
  const targetText = normalizeSearchText(target);
  return sourceTokens.filter((token) => targetText.includes(token)).length / sourceTokens.length;
}

/**
 * Return clues that identify this place rather than merely its locality.
 * Locality words are useful query suffixes, but accepting them as the only
 * evidence would send every same-city place to the same city-centre result.
 */
function addressSpecificTokens(
  addressText: string,
  context: PlaceAssessmentContext,
  hints: PlaceLocationHints | undefined,
): string[] {
  const localityTokens = new Set(
    meaningfulTokens(
      [context.area, context.city, context.country].filter(Boolean).join(" "),
    ),
  );
  const evidence = [
    addressText,
    context.canonicalAddress,
    ...(context.aliases ?? []),
    hints?.normalizedAddress,
    hints?.buildingOrVenue,
    hints?.landmark,
    hints?.street,
    hints?.searchAnchor,
    ...(hints?.searchQueries ?? []),
    ...(hints?.semanticClues ?? []),
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .flatMap((value) => semanticTokens(value));

  return [...new Set(evidence)].filter(
    (token) => !localityTokens.has(token) && (token.length > 2 || /\d/u.test(token)),
  );
}

function localityEvidence(
  context: PlaceAssessmentContext,
  hints: PlaceLocationHints | undefined,
): string[] {
  return [...new Set([
    hints?.neighborhood,
    hints?.town,
    hints?.area,
    // Context area is useful when structured parsing did not identify a
    // stronger locality, but only parsed neighborhood/town values are strict.
    hints?.neighborhood || hints?.town || hints?.area ? undefined : context.area,
  ].filter((value): value is string => Boolean(value?.trim())))];
}

const BROAD_LEBANESE_ADMIN_LABELS = new Set([
  "beirut",
  "greater beirut",
  "mount lebanon",
  "metn",
  "matn",
  "lebanon",
  "liban",
]);

function rawSpecificLocalities(
  addressText: string,
  context: PlaceAssessmentContext,
): string[] {
  const country = normalizeSearchText(context.country ?? "");
  if (country && !["lb", "lebanon", "liban"].includes(country)) return [];
  const excluded = new Set([
    ...BROAD_LEBANESE_ADMIN_LABELS,
    normalizeSearchText(context.city ?? ""),
    normalizeSearchText(context.country ?? ""),
  ]);
  const parts = addressText
    .split(/[,،]/u)
    .map((part) => part.trim())
    .filter(Boolean);
  const instructionPattern =
    /\b(?:near|next to|beside|behind|opposite|facing|call|contact|entrance|gate|delivery)\b/iu;
  const allowFirst =
    parts.length === 2 ||
    (parts.length > 2 &&
      parts.slice(1, -1).every((part) =>
        excluded.has(normalizeSearchText(part)) || instructionPattern.test(part),
      ));
  return parts
    .filter((part, index) => {
      const normalized = normalizeSearchText(part);
      if (!normalized || excluded.has(normalized)) return false;
      // A two-part input such as "Zalka, Lebanon" is commonly locality-first.
      // For longer informal addresses the first part is usually the venue.
      if (index === 0 && !allowFirst) {
        return false;
      }
      if (instructionPattern.test(part)) return false;
      if (/\b(?:street|st|road|rd|highway|autostrade|route|floor|fl|apartment|apt|unit|block)\b/iu.test(part)) {
        return false;
      }
      return true;
    })
    .slice(-2);
}

function broadCityOnly(
  addressText: string,
  context: PlaceAssessmentContext,
): string | null {
  const parts = addressText
    .split(/[,،]/u)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => {
      const normalized = normalizeSearchText(part);
      return normalized !== normalizeSearchText(context.country ?? "") &&
        !["lebanon", "liban", "lb"].includes(normalized);
    });
  if (parts.length !== 1) return null;
  const city = context.city ?? parts[0];
  return city && (
    BROAD_LEBANESE_ADMIN_LABELS.has(normalizeSearchText(city)) ||
    semanticMatchScore(city, parts[0] ?? "") >= 0.8
  ) ? city : null;
}

function resultLocalities(result: NominatimResult): string[] {
  const address = result.address ?? {};
  return [
    address.neighbourhood,
    address.suburb,
    address.quarter,
    address.village,
    address.town,
    address.municipality,
    address.city_district,
    address.county,
    address.city,
    result.display_name,
  ].filter((value): value is string => Boolean(value?.trim()));
}

function localityMatchScore(expected: string[], result: NominatimResult): number {
  if (!expected.length) return 1;
  const candidates = resultLocalities(result);
  if (!candidates.length) return 0;
  return Math.max(...expected.flatMap((source) =>
    candidates.map((candidate) =>
      Math.max(semanticMatchScore(source, candidate), semanticMatchScore(candidate, source)),
    ),
  ));
}

function inferPrecision(
  result: NominatimResult,
  hints: PlaceLocationHints | undefined,
  addressText: string,
): GeocodePrecision {
  const displayed = resultText(result);
  const type = normalizeSearchText(result.type ?? "");
  const resultClass = normalizeSearchText(result.class ?? "");
  const address = result.address ?? {};
  if (address.house_number && semanticMatchScore(addressText, displayed) >= 0.5) {
    return "exact";
  }
  const venueEvidence = hints?.buildingOrVenue ?? hints?.searchAnchor;
  if (
    venueEvidence &&
    semanticMatchScore(venueEvidence, displayed) >= 0.55 &&
    (["house", "building", "residential", "commercial", "retail"].includes(type) ||
      ["building", "shop", "amenity", "tourism"].includes(resultClass) ||
      Object.keys(address).some((key) => SPECIFIC_RESULT_FIELDS.has(key)))
  ) {
    return "exact";
  }
  if (
    (hints?.landmark || hints?.searchAnchor) &&
    semanticMatchScore(hints.landmark ?? hints.searchAnchor ?? "", displayed) >= 0.5
  ) {
    return "landmark";
  }
  const street = hints?.street ?? addressText;
  if (
    (address.road || type === "road" || resultClass === "highway") &&
    semanticMatchScore(street, displayed) >= 0.4
  ) {
    return "street";
  }
  return "locality";
}

function methodForPrecision(precision: GeocodePrecision): GeocodeMethod {
  return precision === "exact"
    ? "exact_match"
    : precision === "landmark"
      ? "landmark_match"
      : precision === "street"
        ? "street_match"
        : "locality_fallback";
}

function resultDistanceKm(a: NominatimResult, b: NominatimResult): number | null {
  const first = toCoordinates(a);
  const second = toCoordinates(b);
  if (!first || !second) return null;
  return coordinateDistanceKm(first, second);
}

function coordinateDistanceKm(
  first: { lat: number; lng: number },
  second: { lat: number; lng: number },
): number {
  const lat1 = first.lat * Math.PI / 180;
  const lat2 = second.lat * Math.PI / 180;
  const dLat = lat2 - lat1;
  const dLng = (second.lng - first.lng) * Math.PI / 180;
  const value = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function candidateIdentity(result: NominatimResult): string {
  if (result.osm_id != null) return `${result.osm_type ?? "osm"}:${result.osm_id}`;
  const coords = toCoordinates(result);
  return coords
    ? `${coords.lat.toFixed(6)}:${coords.lng.toFixed(6)}`
    : result.display_name;
}

function addressSpecificity(
  result: NominatimResult,
  specificTokens: string[],
): { score: number; supported: boolean } {
  if (!specificTokens.length) return { score: 0, supported: false };
  const resultTokens = new Set(semanticTokens(resultText(result)));
  const score = specificTokens.filter((token) => resultTokens.has(token)).length /
    specificTokens.length;
  const type = (result.type ?? "").toLocaleLowerCase();
  const hasStructuredAddress = Object.keys(result.address ?? {}).some((key) =>
    SPECIFIC_RESULT_FIELDS.has(key.toLocaleLowerCase()),
  );
  const isGenericLocality = GENERIC_RESULT_TYPES.has(type) && !hasStructuredAddress;

  // A named building or landmark may be represented as a "place" without
  // structured address fields. It still needs meaningful non-locality clue
  // support. A generic locality with no such support is never usable.
  return {
    score,
    supported: !isGenericLocality &&
      score >= (specificTokens.length === 1 ? 1 : 0.3),
  };
}

function countryCodesFor(value: string): string[] {
  const trimmed = value.trim();
  const country = findCountryByCode(trimmed) ?? findCountryByName(trimmed);
  if (country) return [country.code];
  const normalized = normalizeSearchText(trimmed);
  return normalized === "uae" || normalized === "emirates" ? ["ae"] : [];
}

function isConsistentWithContext(
  result: NominatimResult,
  context: PlaceAssessmentContext,
): boolean {
  const text = resultText(result);
  const normalizedText = normalizeSearchText(text);
  const address = result.address ?? {};

  // Country check: hard-reject only when the country code actively contradicts.
  // A missing city in the display name is a soft signal (lower relevance score)
  // and must not cause a hard rejection — Nominatim often returns district-level
  // names that omit the city string entirely.
  if (context.country) {
    const expectedCodes = countryCodesFor(context.country);
    const resultCode = normalizeSearchText(address.country_code ?? "");
    if (resultCode && expectedCodes.length && !expectedCodes.includes(resultCode)) {
      return false;
    }
    if (!resultCode && expectedCodes.length) {
      const countryName = normalizeSearchText(context.country);
      const countryMentioned = normalizedText.includes(countryName) ||
        expectedCodes.some((code) => normalizedText.includes(code));
      // A known city is sufficient when Nominatim omits country in display text.
      if (!countryMentioned && context.city && !normalizedText.includes(normalizeSearchText(context.city))) {
        return false;
      }
    }
  }

  // A result may omit its parent city, but an explicitly different locality is
  // a hard contradiction. This prevents an anchor query from accepting a
  // same-country result in an unrelated city.
  if (context.city) {
    const resultLocalities = [
      address.city,
      address.town,
      address.municipality,
      address.village,
      address.county,
    ].filter((value): value is string => Boolean(value));
    if (
      resultLocalities.length &&
      !resultLocalities.some((locality) =>
        semanticMatchScore(context.city!, locality) >= 0.5 ||
        semanticMatchScore(locality, context.city!) >= 0.5,
      )
    ) {
      return false;
    }
  }

  return true;
}

function isCredibleResult(result: NominatimResult): boolean {
  if (!result.type && !result.class) return true;
  return CREDIBLE_TYPES.has((result.type ?? "").toLocaleLowerCase()) ||
    ["amenity", "building", "highway", "place", "shop", "tourism"].includes(
      (result.class ?? "").toLocaleLowerCase(),
    );
}

function toCoordinates(result: NominatimResult): { lat: number; lng: number } | null {
  const lat = Number(result.lat);
  const lng = Number(result.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return null;
  }
  return { lat, lng };
}

/**
 * Query Nominatim with exact-first and context-rich fallback searches.
 * Only validated map results are returned; the AI never participates in
 * coordinate generation.
 */
export async function geocodeAddress(
  addressText: string,
  context: PlaceAssessmentContext = {},
  hints?: PlaceLocationHints,
  providerOptions: GeocodeProviderOptions = {},
): Promise<GeocodeResult | null> {
  if (context.geographyConflict) return null;
  const queries = buildGeocoderQueries(addressText, context, hints);
  const safeHints = sanitizeLocationHints(hints, addressText, context);
  const extractedAnchor = extractSearchAnchor(addressText);
  const anchor = resolveSearchAnchor(safeHints, extractedAnchor);
  const specificTokens = addressSpecificTokens(addressText, context, safeHints);
  const parsedLocalities = localityEvidence(context, safeHints);
  const rawLocalities = rawSpecificLocalities(addressText, context);
  const strictExpectedLocalities = [
    ...rawLocalities,
    safeHints?.neighborhood,
    safeHints?.town,
    safeHints?.area,
  ].filter((value): value is string => Boolean(value?.trim()));
  const expectedLocalities = parsedLocalities.length ? parsedLocalities : rawLocalities;
  const explicitBroadCity = broadCityOnly(addressText, context);
  const hasStrictParsedLocality = Boolean(
    safeHints?.neighborhood || safeHints?.town || safeHints?.area,
  ) || rawLocalities.length > 0;
  const ambiguousNamedPlace =
    Boolean(anchor || safeHints?.buildingOrVenue || safeHints?.landmark) ||
    /\b(hospital|hotel|clinic|medical\s+cent(?:er|re)|resort|mall|school|university|landmark)\b/i.test(
      addressText,
    );
  // A globally reusable institution/landmark name is not enough geographic
  // evidence for a delivery pin. This also makes mixed-country place evidence
  // fail closed because the trusted-context resolver deliberately supplies no
  // country or locality when its sources disagree.
  if (
    ambiguousNamedPlace &&
    !context.country &&
    !context.city &&
    expectedLocalities.length === 0
  ) {
    return null;
  }
  let googleHealthy = false;
  let googleAddressDecisionError: MapProviderError | null = null;
  const reportProviderHealth: GeocodeProviderOptions["onProviderHealth"] = async (update) => {
    if (update.provider === "google_places") googleHealthy = update.status === "healthy";
    await providerOptions.onProviderHealth?.(update);
  };
  const skipGoogle = providerOptions.skipProviders?.includes("google_places") ?? false;
  const skipNominatim = providerOptions.skipProviders?.includes("nominatim") ?? false;
  if (!skipGoogle) {
    try {
      const google = await resolveWithGoogle(
        queries,
        addressText,
        context,
        safeHints,
        reportProviderHealth,
      );
      if (google) return google;
    } catch (error) {
      if (
        error instanceof MapProviderError &&
        (error.code === "ambiguity" || error.code === "zero_results")
      ) {
        // A candidate-level outcome is not provider health. Preserve the
        // successful Google response and let Nominatim get a chance to resolve
        // the address before returning a per-address review result.
        googleAddressDecisionError = error;
        googleHealthy = true;
      }
      logger.warn({ error }, "placeAiAssessor: Google Places resolver unavailable; trying fallback");
    }
  }
  const candidates: Array<{
    result: NominatimResult;
    query: string;
    queryIndex: number;
    score: number;
    precision: GeocodePrecision;
    identity: string;
    addressSimilarity: number;
    localitySimilarity: number;
    specificityScore: number;
    anchorScore: number;
    trustedDistanceKm: number | null;
  }> = [];
  const candidateEvidence: Array<Record<string, unknown>> = [];
  const recordCandidateEvidence = (
    result: NominatimResult,
    query: string,
    queryIndex: number,
    evidence: Record<string, unknown>,
  ) => {
    if (candidateEvidence.length >= 48) return;
    const evidenceRecord = {
      candidate_id: candidateIdentity(result),
      query,
      query_index: queryIndex,
      display_name: result.display_name,
      provider_type: result.type ?? null,
      provider_class: result.class ?? null,
      ...evidence,
    };
    candidateEvidence.push(evidenceRecord);
    providerOptions.onCandidateEvidence?.(evidenceRecord);
  };
  const compareCandidates = (
    a: (typeof candidates)[number],
    b: (typeof candidates)[number],
  ): number =>
    b.score - a.score ||
    a.queryIndex - b.queryIndex ||
    (a.result.place_id ?? Number.MAX_SAFE_INTEGER) -
      (b.result.place_id ?? Number.MAX_SAFE_INTEGER) ||
    a.result.display_name.localeCompare(b.result.display_name);
  let hadSuccessfulProviderResponse = false;
  let lastFallbackError: MapProviderError | null = null;

  for (const [queryIndex, query] of (skipNominatim ? [] : queries).entries()) {
    let results: NominatimResult[];
    try {
      results = await searchNominatim<NominatimResult>(query, {
        countryCode: countryCodesFor(context.country ?? "").includes("lb") ? "lb" : undefined,
        limit: 5,
      });
      hadSuccessfulProviderResponse = true;
      await providerOptions.onProviderHealth?.(healthyProviderUpdate("nominatim"));
    } catch (err) {
      if (err instanceof MapProviderError) {
        lastFallbackError = err;
        await providerOptions.onProviderHealth?.(providerHealthForError(err));
      }
      logger.warn(
        {
          err,
          providerCode: err instanceof MapProviderError ? err.code : "unknown",
        },
        "placeAiAssessor: Nominatim request failed",
      );
      // Provider transport/configuration errors are shared across progressive
      // query variants. The worker will resume them later rather than flooding
      // a known-broken service with nearly identical requests.
      break;
    }

    for (const result of results) {
      const coords = toCoordinates(result);
      if (!coords) {
        recordCandidateEvidence(result, query, queryIndex, { accepted: false, rejection: "invalid_coordinates" });
        continue;
      }
      if (!result.display_name) {
        recordCandidateEvidence(result, query, queryIndex, { accepted: false, rejection: "missing_display_name" });
        continue;
      }
      if (!isCredibleResult(result)) {
        recordCandidateEvidence(result, query, queryIndex, { accepted: false, rejection: "unsupported_result_type" });
        continue;
      }
      if (!isConsistentWithContext(result, context)) {
        recordCandidateEvidence(result, query, queryIndex, { accepted: false, rejection: "geography_contradiction" });
        continue;
      }

      const displayed = resultText(result);
      const exactScore = semanticMatchScore(addressText, displayed);
      const queryScore = semanticMatchScore(query, displayed);
      const anchorScore = anchor ? semanticMatchScore(anchor, displayed) : 1;
      const specificity = addressSpecificity(result, specificTokens);
      const localityScore = localityMatchScore(expectedLocalities, result);
      const inferredPrecision = inferPrecision(result, safeHints, addressText);
      // A legacy area hint is not strong enough to disqualify an otherwise
      // specific result, but it does prevent claiming exact precision.
      const precision: GeocodePrecision =
        inferredPrecision === "exact" &&
        expectedLocalities.length > 0 &&
        localityScore < 0.4
          ? "street"
          : inferredPrecision;
      const localityFallback =
        precision === "locality" &&
        expectedLocalities.length > 0 &&
        !anchor &&
        localityScore >= 0.5;
      // Generic results are retained only as review candidates. The persistence
      // layer below refuses to save street/locality coordinates as verified.
      const cityFallback =
        precision === "locality" &&
        expectedLocalities.length === 0 &&
        !anchor &&
        Boolean(explicitBroadCity) &&
        resultLocalities(result).some((locality) =>
          semanticMatchScore(explicitBroadCity ?? "", locality) >= 0.5,
        );
      if (!specificity.supported && !localityFallback && !cityFallback) {
        recordCandidateEvidence(result, query, queryIndex, {
          accepted: false,
          rejection: "insufficient_address_evidence",
          exact_similarity: exactScore,
          query_similarity: queryScore,
          locality_similarity: localityScore,
          specificity: specificity.score,
          precision,
        });
        continue;
      }
      // A specific parsed locality is a stronger constraint than a broad city
      // label. A candidate that identifies a different locality is disqualified;
      // country or Beirut matches can never compensate for this contradiction.
      if (
        hasStrictParsedLocality &&
        resultLocalities(result).length &&
        strictExpectedLocalities.length &&
        !resultLocalities(result).some((locality) =>
          strictExpectedLocalities.some((expected) =>
            semanticMatchScore(expected, locality) >= 0.4 ||
            semanticMatchScore(locality, expected) >= 0.4,
          ),
        )
      ) {
        recordCandidateEvidence(result, query, queryIndex, {
          accepted: false,
          rejection: "locality_contradiction",
          locality_similarity: localityScore,
          precision,
        });
        continue;
      }
      // Once a trustworthy explicit anchor is present, a generic locality
      // result is not an acceptable substitute for that anchor.
      const anchorRequired = Boolean(anchor && queryIndex === 0);
      if (anchorRequired && anchorScore < 0.5) {
        recordCandidateEvidence(result, query, queryIndex, {
          accepted: false,
          rejection: "anchor_mismatch",
          anchor_similarity: anchorScore,
          precision,
        });
        continue;
      }
      // Area match is now a soft gate (0.4) rather than a hard 0.8 boundary.
      // When the area check fails the result is still considered as an approximate
      // candidate — it is not promoted to bestExact.
      const areaScore = expectedLocalities.length ? localityScore : 1;
      const areaMatches = areaScore >= 0.4;
      const targetScore = anchorRequired
        ? anchorScore
        : Math.max(exactScore, queryScore, specificity.score);
      if (hasStrictParsedLocality && !areaMatches) {
        recordCandidateEvidence(result, query, queryIndex, {
          accepted: false,
          rejection: "area_mismatch",
          locality_similarity: localityScore,
          precision,
        });
        continue;
      }
      const precisionWeight = { exact: 4, landmark: 3, street: 2, locality: 1 }[precision];
      const trustedDistanceKm =
        context.trustedLatitude != null &&
        context.trustedLongitude != null &&
        Number.isFinite(context.trustedLatitude) &&
        Number.isFinite(context.trustedLongitude)
          ? coordinateDistanceKm(coords, {
              lat: context.trustedLatitude,
              lng: context.trustedLongitude,
            })
          : null;
      // Existing non-protected evidence is deliberately a weak tie-breaker:
      // textual/locality evidence and precision always dominate it.
      const trustedDistanceScore = trustedDistanceKm == null
        ? 0
        : Math.max(0, 1 - trustedDistanceKm / 15);
      const score =
        precisionWeight * 10 +
        targetScore * 5 +
        localityScore * 4 +
        specificity.score * 3 +
        trustedDistanceScore -
        queryIndex * 0.01;
      if (targetScore >= 0.3 || localityFallback || cityFallback) {
        const identity = candidateIdentity(result);
        candidates.push({
          result,
          query,
          queryIndex,
          score,
          precision,
          identity,
          addressSimilarity: Math.max(exactScore, queryScore),
          localitySimilarity: localityScore,
          specificityScore: specificity.score,
          anchorScore,
          trustedDistanceKm,
        });
        recordCandidateEvidence(result, query, queryIndex, {
          accepted: true,
          precision,
          result_level: resultLevelForNominatim(result, precision),
          score,
          exact_similarity: exactScore,
          query_similarity: queryScore,
          anchor_similarity: anchorScore,
          locality_similarity: localityScore,
          specificity: specificity.score,
          trusted_distance_km: trustedDistanceKm,
        });
      }
    }
  }

  if (!hadSuccessfulProviderResponse && googleHealthy) {
    // Google answered successfully, even if it had no sufficiently precise
    // candidate. A Nominatim outage is then an address-level review outcome,
    // not evidence that every provider is down.
    if (googleAddressDecisionError) throw googleAddressDecisionError;
    return null;
  }
  if (!hadSuccessfulProviderResponse && !skipNominatim && queries.length > 0) {
    if (lastFallbackError) throw lastFallbackError;
    throw new MapProviderError(
      "nominatim",
      "unavailable",
      "Fallback geocoder was unavailable for every address query",
      true,
      undefined,
      null,
      "geocode",
      queries[0],
    );
  }
  if (skipGoogle && skipNominatim) {
    throw new MapProviderError(
      "nominatim",
      "unavailable",
      "No configured geocoding provider is available for this run",
      true,
      undefined,
      null,
      "geocode",
    );
  }
  // The same provider result commonly appears for several progressive
  // queries. Deduplicate by provider identity before ranking or ambiguity
  // detection so repeated evidence cannot create a false tie.
  candidates.sort(compareCandidates);
  const uniqueCandidates = new Map<string, (typeof candidates)[number]>();
  for (const candidate of candidates) {
    if (!uniqueCandidates.has(candidate.identity)) {
      uniqueCandidates.set(candidate.identity, candidate);
    }
  }
  candidates.length = 0;
  candidates.push(...uniqueCandidates.values());
  candidates.sort(compareCandidates);

  const localityReference = candidates
    .filter((candidate) =>
      candidate.precision === "locality" &&
      GENERIC_RESULT_TYPES.has(normalizeSearchText(candidate.result.type ?? "")) &&
      localityMatchScore(expectedLocalities, candidate.result) >= 0.5
    )
    .sort((a, b) =>
      localityMatchScore(expectedLocalities, b.result) -
        localityMatchScore(expectedLocalities, a.result) ||
      compareCandidates(a, b),
    )[0];
  const geographicallyConsistent = candidates.filter((candidate) => {
    if (candidate.precision === "locality") return true;
    if (!localityReference) return !hasStrictParsedLocality;
    const distance = resultDistanceKm(candidate.result, localityReference.result);
    if (distance == null) return false;
    const maximumKm =
      candidate.precision === "exact" ? 15 :
      candidate.precision === "landmark" ? 12 :
      8;
    return distance <= maximumKm;
  });
  if (!geographicallyConsistent.length) return null;
  const normalizedCandidates = geographicallyConsistent.flatMap((candidate) => {
    const coords = toCoordinates(candidate.result);
    if (!coords) return [];
    const resultLevel = resultLevelForNominatim(candidate.result, candidate.precision);
    const normalized: Omit<NormalizedGeocodeCandidate, "decisionScore"> = {
      provider: "nominatim",
      placeIdentity: candidate.identity,
      lat: coords.lat,
      lng: coords.lng,
      rawProviderTypes: [candidate.result.class, candidate.result.type].filter(
        (value): value is string => Boolean(value),
      ),
      resultLevel,
      precision: candidate.precision,
      formattedAddress: candidate.result.display_name,
      name: candidate.result.display_name,
      premiseEvidence: candidate.precision === "exact" ? candidate.specificityScore : 0,
      landmarkEvidence: candidate.precision === "landmark" ? candidate.anchorScore : 0,
      streetEvidence: candidate.precision === "street" ? candidate.specificityScore : 0,
      neighborhoodEvidence: candidate.localitySimilarity,
      municipalityEvidence: candidate.localitySimilarity,
      country: candidate.result.address?.country_code ?? null,
      addressSimilarity: candidate.addressSimilarity,
      localitySimilarity: candidate.localitySimilarity,
      trustedDistanceKm: candidate.trustedDistanceKm,
      contradictions: [],
      query: candidate.query,
      queryIndex: candidate.queryIndex,
      providerScore: candidate.score,
      auditEvidence: {
        exact_similarity: semanticMatchScore(addressText, resultText(candidate.result)),
        query_similarity: semanticMatchScore(candidate.query, resultText(candidate.result)),
        anchor_similarity: candidate.anchorScore,
        locality_similarity: candidate.localitySimilarity,
        specificity: candidate.specificityScore,
        trusted_distance_km: candidate.trustedDistanceKm,
        trusted_coordinate_source: context.trustedCoordinateSource ?? null,
      },
    };
    return [{ ...normalized, decisionScore: normalizedCandidateScore(normalized) }];
  });
  const result = finalizeNormalizedCandidates(normalizedCandidates, queries);
  if (!result) return null;
  result.confidenceEvidence = {
    ...(result.confidenceEvidence ?? {}),
    exact_similarity: normalizedCandidates[0]?.auditEvidence.exact_similarity,
    locality_similarity: normalizedCandidates[0]?.auditEvidence.locality_similarity,
    precision: result.precision,
    result_level: result.resultLevel,
  };
  // Preserve provider retrieval evidence alongside the shared normalized
  // candidate evidence. This is useful for audit/review without allowing
  // provider-specific scores to decide acceptance.
  result.candidateEvidence = [
    ...candidateEvidence,
    ...(result.candidateEvidence ?? []),
  ];
  return result;
}

export function stripSubUnits(text: string): string {
  // Replace each sub-unit token with a comma marker, then re-split and rejoin
  // to eliminate the resulting empty/dangling fragments cleanly.
  const replaced = text.replace(SUB_UNIT_PATTERN, ",");
  const parts = replaced
    .split(/[,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts.join(", ") : text.trim();
}
