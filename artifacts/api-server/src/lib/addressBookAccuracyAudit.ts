import { db } from "./db.js";
import { MapProviderError } from "./mapProvider.js";
import {
  assessPlaceValidity,
  geocodeAddress,
  type PlaceAssessmentContext,
  type GeocodeResult,
} from "./placeAiAssessor.js";
import { checkPlaceLocationConflict } from "./placeConflictChecker.js";

export type AccuracyAuditClassification =
  | "still_supported"
  | "changed_candidate"
  | "ambiguous"
  | "contradiction"
  | "insufficient_precision"
  | "provider_unavailable"
  | "protected_coordinate";

export interface AccuracyAuditMetrics {
  existing_ai_verified_reviewed: number;
  still_supported: number;
  materially_different_coordinate: number;
  locality_contradiction: number;
  ambiguous: number;
  insufficient_precision: number;
  provider_failure: number;
  protected_coordinate: number;
  requires_owner_review: number;
}

export interface AccuracyAuditResult {
  place_id: string;
  canonical_name: string;
  classification: AccuracyAuditClassification;
  requires_owner_review: boolean;
  current_pin: { latitude: number; longitude: number } | null;
  selected_candidate: {
    latitude: number;
    longitude: number;
    matched_location: string;
    precision: string;
    provider: string;
    query: string;
  } | null;
  distance_km: number | null;
  coordinate_source: string | null;
  candidate_evidence: Array<Record<string, unknown>>;
  reason: string | null;
}

export interface AccuracyAuditReport {
  dry_run: true;
  generated_at: string;
  metrics: AccuracyAuditMetrics;
  results: AccuracyAuditResult[];
}

interface AuditPlaceRow {
  id: string;
  canonical_name: string;
  canonical_address: string | null;
  area: string | null;
  city_name: string | null;
  country_code: string | null;
  latitude: string | null;
  longitude: string | null;
  coordinate_source: string | null;
  source_order_id: string | null;
  verification_state: string;
  aliases: string[];
}

const PROTECTED_COORDINATE_SOURCES = new Set(["manual", "gps", "import"]);
const MATERIAL_DISTANCE_KM = 0.2;

function haversineDistanceKm(
  first: { latitude: number; longitude: number },
  second: { latitude: number; longitude: number },
): number {
  const toRadians = (value: number) => value * Math.PI / 180;
  const dLat = toRadians(second.latitude - first.latitude);
  const dLng = toRadians(second.longitude - first.longitude);
  const lat1 = toRadians(first.latitude);
  const lat2 = toRadians(second.latitude);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function numberOrNull(value: string | null): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isProtectedCoordinate(place: AuditPlaceRow): boolean {
  return (
    place.source_order_id != null ||
    PROTECTED_COORDINATE_SOURCES.has(place.coordinate_source ?? "") ||
    place.coordinate_source === "geocoder" && Boolean(place.source_order_id)
  );
}

function providerUnavailable(error: unknown): boolean {
  if (!(error instanceof MapProviderError)) return true;
  return error.code !== "ambiguity";
}

function candidateView(result: GeocodeResult | null): AccuracyAuditResult["selected_candidate"] {
  if (!result) return null;
  return {
    latitude: result.lat,
    longitude: result.lng,
    matched_location: result.matchedLocation,
    precision: result.precision,
    provider: result.provider,
    query: result.query,
  };
}

const CANDIDATE_REJECTION_LABELS: Record<string, string> = {
  invalid_coordinates: "invalid coordinates",
  missing_display_name: "missing candidate name",
  unsupported_result_type: "unsupported result type",
  geography_contradiction: "country or locality contradiction",
  insufficient_address_evidence: "insufficient address-level evidence",
  locality_contradiction: "specific locality mismatch",
  anchor_mismatch: "named venue or landmark mismatch",
  area_mismatch: "delivery area mismatch",
};

function noCandidateReason(rejections: Record<string, number>): string {
  const summary = Object.entries(rejections)
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([reason, count]) =>
      `${CANDIDATE_REJECTION_LABELS[reason] ?? reason.replaceAll("_", " ")} (${count})`,
    );
  return summary.length
    ? `No precise delivery candidate passed the safeguards: ${summary.join(", ")}.`
    : "The providers returned no candidates for the tested search variants.";
}

function emptyMetrics(): AccuracyAuditMetrics {
  return {
    existing_ai_verified_reviewed: 0,
    still_supported: 0,
    materially_different_coordinate: 0,
    locality_contradiction: 0,
    ambiguous: 0,
    insufficient_precision: 0,
    provider_failure: 0,
    protected_coordinate: 0,
    requires_owner_review: 0,
  };
}

function incrementMetrics(
  metrics: AccuracyAuditMetrics,
  classification: AccuracyAuditClassification,
  requiresOwnerReview: boolean,
): void {
  metrics[classification === "changed_candidate" ? "materially_different_coordinate" : classification === "contradiction" ? "locality_contradiction" : classification === "provider_unavailable" ? "provider_failure" : classification] += 1;
  if (requiresOwnerReview) metrics.requires_owner_review += 1;
}

/**
 * Re-run the current read-only assessor against old automated pins.
 *
 * This deliberately performs no UPDATE, INSERT, DELETE, transaction, event
 * write, or checkout mutation. It is an owner-facing report only; any result
 * other than still_supported is surfaced for review rather than applied.
 */
export async function auditExistingAiVerifiedPlaces(options: {
  workspaceId: string;
  limit?: number;
}): Promise<AccuracyAuditReport> {
  const limit = Math.min(500, Math.max(1, Math.floor(options.limit ?? 100)));
  const places = await db.query<AuditPlaceRow>(
    `SELECT p.id, p.canonical_name, p.canonical_address, p.area,
            dc.name AS city_name, dc.country_code,
            p.latitude, p.longitude, p.coordinate_source, p.source_order_id,
            p.verification_state,
            ARRAY(
              SELECT pa.alias_text
                FROM place_aliases pa
               WHERE pa.place_id = p.id
                 AND pa.deleted_at IS NULL
                 AND COALESCE(pa.approval_state, 'approved') = 'approved'
               ORDER BY pa.created_at
            ) AS aliases
       FROM places p
       LEFT JOIN delivery_cities dc ON dc.id = p.city_id
      WHERE p.workspace_owner_id = $1
        AND p.archived_at IS NULL
        AND p.verification_state = 'ai_verified'
      ORDER BY p.updated_at ASC, p.id ASC
      LIMIT $2`,
    [options.workspaceId, limit],
  );

  const metrics = emptyMetrics();
  const results: AccuracyAuditResult[] = [];
  for (const place of places.rows) {
    metrics.existing_ai_verified_reviewed += 1;
    const currentLat = numberOrNull(place.latitude);
    const currentLng = numberOrNull(place.longitude);
    const currentPin = currentLat != null && currentLng != null
      ? { latitude: currentLat, longitude: currentLng }
      : null;

    if (isProtectedCoordinate(place)) {
      const classification: AccuracyAuditClassification = "protected_coordinate";
      incrementMetrics(metrics, classification, false);
      results.push({
        place_id: place.id,
        canonical_name: place.canonical_name,
        classification,
        requires_owner_review: false,
        current_pin: currentPin,
        selected_candidate: null,
        distance_km: null,
        coordinate_source: place.coordinate_source,
        candidate_evidence: [],
        reason: "Existing coordinate provenance is protected; audit did not query or alter it.",
      });
      continue;
    }

    const context: PlaceAssessmentContext = {
      workspaceOwnerId: options.workspaceId,
      canonicalAddress: place.canonical_address,
      area: place.area,
      city: place.city_name,
      country: place.country_code,
      aliases: place.aliases ?? [],
      trustedLatitude: currentLat,
      trustedLongitude: currentLng,
      trustedCoordinateSource: place.coordinate_source ?? "historical",
    };

    let providerResult: GeocodeResult | null = null;
    const candidateEvidence: Array<Record<string, unknown>> = [];
    const candidateRejections: Record<string, number> = {};
    let classification: AccuracyAuditClassification;
    let reason: string | null = null;
    try {
      const assessment = await assessPlaceValidity(place.canonical_name, place.aliases ?? [], context);
      if (!assessment.valid) {
        classification = "contradiction";
        reason = assessment.reason || "AI assessment found no valid address evidence.";
      } else {
        providerResult = await geocodeAddress(
          place.canonical_name,
          context,
          assessment.locationHints,
          {
            onCandidateEvidence: (evidence) => {
              const rejection = evidence.rejection;
              if (typeof rejection === "string") {
                candidateRejections[rejection] = (candidateRejections[rejection] ?? 0) + 1;
              }
              if (candidateEvidence.length < 12) candidateEvidence.push(evidence);
            },
          },
        );
        if (!providerResult) {
          classification = "insufficient_precision";
          reason = noCandidateReason(candidateRejections);
        } else if (providerResult.precision !== "exact" && providerResult.precision !== "landmark") {
          classification = "insufficient_precision";
          reason = `The selected candidate has ${providerResult.precision} precision.`;
        } else {
          const conflict = await checkPlaceLocationConflict({
            latitude: providerResult.lat,
            longitude: providerResult.lng,
            cityName: place.city_name,
            countryCode: place.country_code,
          });
          if (conflict.conflict) {
            classification = "contradiction";
            reason = "The selected candidate conflicts with the place's trusted locality or country.";
          } else if (
            currentPin &&
            haversineDistanceKm(currentPin, {
              latitude: providerResult.lat,
              longitude: providerResult.lng,
            }) > MATERIAL_DISTANCE_KM
          ) {
            classification = "changed_candidate";
            reason = `The selected candidate is more than ${MATERIAL_DISTANCE_KM} km from the saved pin.`;
          } else {
            classification = "still_supported";
          }
        }
      }
    } catch (error) {
      if (error instanceof MapProviderError && error.code === "ambiguity") {
        classification = "ambiguous";
        reason = error.message;
      } else if (providerUnavailable(error)) {
        classification = "provider_unavailable";
        reason = error instanceof Error ? error.message : "Map provider unavailable.";
      } else {
        classification = "provider_unavailable";
        reason = "Provider audit failed.";
      }
    }

    const requiresOwnerReview = classification !== "still_supported";
    incrementMetrics(metrics, classification, requiresOwnerReview);
    const distanceKm = currentPin && providerResult
      ? Math.round(haversineDistanceKm(currentPin, {
          latitude: providerResult.lat,
          longitude: providerResult.lng,
        }) * 100) / 100
      : null;
    results.push({
      place_id: place.id,
      canonical_name: place.canonical_name,
      classification,
      requires_owner_review: requiresOwnerReview,
      current_pin: currentPin,
      selected_candidate: candidateView(providerResult),
      distance_km: distanceKm,
      coordinate_source: place.coordinate_source,
      candidate_evidence: candidateEvidence.length
        ? candidateEvidence
        : providerResult?.candidateEvidence ?? [],
      reason,
    });
  }

  return {
    dry_run: true,
    generated_at: new Date().toISOString(),
    metrics,
    results,
  };
}