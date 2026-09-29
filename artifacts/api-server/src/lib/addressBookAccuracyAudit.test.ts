import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDbQuery = vi.fn();
const mockAssessPlaceValidity = vi.fn();
const mockGeocodeAddress = vi.fn();
const mockCheckPlaceLocationConflict = vi.fn();

vi.mock("./db.js", () => ({
  db: { query: (...args: unknown[]) => mockDbQuery(...args) },
}));

vi.mock("./placeAiAssessor.js", () => ({
  assessPlaceValidity: (...args: unknown[]) => mockAssessPlaceValidity(...args),
  geocodeAddress: (...args: unknown[]) => mockGeocodeAddress(...args),
}));

vi.mock("./placeConflictChecker.js", () => ({
  checkPlaceLocationConflict: (...args: unknown[]) => mockCheckPlaceLocationConflict(...args),
}));

import { auditExistingAiVerifiedPlaces } from "./addressBookAccuracyAudit.js";
import { MapProviderError } from "./mapProvider.js";

const basePlace = {
  canonical_address: "12 Main Street",
  area: "Hamra",
  city_name: "Beirut",
  country_code: "LB",
  latitude: "33.8938",
  longitude: "35.5018",
  coordinate_source: "ai",
  source_order_id: null,
  verification_state: "ai_verified",
  aliases: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckPlaceLocationConflict.mockResolvedValue({ conflict: false });
  mockAssessPlaceValidity.mockResolvedValue({ valid: true, reason: "Address" });
  mockDbQuery.mockResolvedValue({ rows: [] });
});

describe("auditExistingAiVerifiedPlaces", () => {
  it("reports changed candidates and distance without issuing any mutation query", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{
        ...basePlace,
        id: "place-1",
        canonical_name: "12 Main Street",
      }],
    });
    mockGeocodeAddress.mockResolvedValue({
      lat: 33.9008,
      lng: 35.5702,
      matchedLocation: "12 Main Street, Zalka, Lebanon",
      precision: "exact",
      provider: "nominatim",
      query: "12 Main Street, Beirut, LB",
      candidateEvidence: [{
        provider: "nominatim",
        trusted_coordinate_source: "ai",
      }],
    });

    const report = await auditExistingAiVerifiedPlaces({ workspaceId: "ws-1", limit: 10 });

    expect(report.dry_run).toBe(true);
    expect(report.metrics).toMatchObject({
      existing_ai_verified_reviewed: 1,
      materially_different_coordinate: 1,
      requires_owner_review: 1,
    });
    expect(report.results[0]).toMatchObject({
      place_id: "place-1",
      classification: "changed_candidate",
      requires_owner_review: true,
      distance_km: expect.any(Number),
      selected_candidate: {
        latitude: 33.9008,
        longitude: 35.5702,
      },
    });
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
    expect(String(mockDbQuery.mock.calls[0]?.[0])).toMatch(/SELECT p\.id/i);
    expect(String(mockDbQuery.mock.calls[0]?.[0])).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/i);
  });

  it("classifies ambiguity and protects manual coordinates without querying providers", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          ...basePlace,
          id: "place-ambiguous",
          canonical_name: "Twin Building",
          coordinate_source: "ai",
        },
        {
          ...basePlace,
          id: "place-protected",
          canonical_name: "Staff Pin",
          coordinate_source: "manual",
        },
      ],
    });
    mockGeocodeAddress.mockRejectedValueOnce(new MapProviderError(
      "nominatim",
      "ambiguity",
      "ambiguous candidate set",
      false,
    ));

    const report = await auditExistingAiVerifiedPlaces({ workspaceId: "ws-1" });

    expect(report.metrics).toMatchObject({
      existing_ai_verified_reviewed: 2,
      ambiguous: 1,
      provider_failure: 0,
      protected_coordinate: 1,
      requires_owner_review: 1,
    });
    expect(report.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ place_id: "place-ambiguous", classification: "ambiguous" }),
      expect.objectContaining({ place_id: "place-protected", classification: "protected_coordinate" }),
    ]));
    expect(mockGeocodeAddress).toHaveBeenCalledTimes(1);
  });

  it("classifies low-precision candidates as insufficient without changing checkout state", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{
        ...basePlace,
        id: "place-locality",
        canonical_name: "Hamra",
      }],
    });
    mockGeocodeAddress.mockResolvedValue({
      lat: 33.8938,
      lng: 35.5018,
      matchedLocation: "Hamra, Beirut, Lebanon",
      precision: "locality",
      provider: "nominatim",
      query: "Hamra, Beirut, LB",
    });

    const report = await auditExistingAiVerifiedPlaces({ workspaceId: "ws-1" });

    expect(report.metrics.insufficient_precision).toBe(1);
    expect(report.results[0]).toMatchObject({
      classification: "insufficient_precision",
      requires_owner_review: true,
    });
    expect(mockDbQuery).toHaveBeenCalledTimes(1);
  });

  it("explains why no precise candidate passed the delivery safeguards", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{
        ...basePlace,
        id: "place-rejected-candidate",
        canonical_name: "12 Main Street",
      }],
    });
    mockGeocodeAddress.mockImplementation(async (...args: unknown[]) => {
      const options = args[3] as {
        onCandidateEvidence?: (evidence: Record<string, unknown>) => void;
      };
      options.onCandidateEvidence?.({
        candidate_id: "way:1",
        display_name: "12 Main Street, Zalka, Lebanon",
        accepted: false,
        rejection: "locality_contradiction",
      });
      return null;
    });

    const report = await auditExistingAiVerifiedPlaces({ workspaceId: "ws-1" });

    expect(report.results[0]).toMatchObject({
      classification: "insufficient_precision",
      reason: "No precise delivery candidate passed the safeguards: specific locality mismatch (1).",
      candidate_evidence: [{
        candidate_id: "way:1",
        accepted: false,
        rejection: "locality_contradiction",
      }],
    });
  });
});