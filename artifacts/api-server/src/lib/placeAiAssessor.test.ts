import { afterEach, describe, expect, it, vi } from "vitest";

const mockCreateCompletion = vi.fn();

vi.mock("@workspace/integrations-openai-ai-server/image", () => ({
  openai: {
    chat: {
      completions: {
        create: (...args: unknown[]) => mockCreateCompletion(...args),
      },
    },
  },
}));

vi.mock("./logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn() },
}));

import {
  assessPlaceValidity,
  buildGeocoderQueries,
  extractSearchAnchor,
  geocodeAddress,
  semanticMatchScore,
  stripSubUnits,
} from "./placeAiAssessor";

function mapResult(overrides: Record<string, unknown> = {}) {
  return {
    lat: "24.514",
    lon: "54.38",
    display_name: "Saadiyat Beach Villas, Saadiyat, Abu Dhabi, United Arab Emirates",
    type: "residential",
    class: "place",
    address: {
      city: "Abu Dhabi",
      country: "United Arab Emirates",
      country_code: "ae",
    },
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("place AI geocoding", () => {
  it.each([
    ["St Joseph Hospital", "St. Joseph Hospital, Hot Springs, Arkansas, United States", "us"],
    ["St Joseph Hospital", "Saint Joseph, Persian Gulf", "ir"],
  ])("rejects a wrong-country result for a Lebanese %s", async (address, displayName, countryCode) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [mapResult({
        display_name: displayName,
        type: "hospital",
        class: "amenity",
        address: { hospital: "St Joseph Hospital", country_code: countryCode },
      })],
    }));
    await expect(
      geocodeAddress(address, { country: "Lebanon" }, {
        buildingOrVenue: "St Joseph Hospital",
        anchorType: "institution",
      }),
    ).resolves.toBeNull();
  });

  it("does not verify a globally ambiguous institution without trusted geography", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      geocodeAddress("St Joseph Hospital", {}, {
        buildingOrVenue: "St Joseph Hospital",
        anchorType: "institution",
      }),
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not geocode an ordinary address when trusted country evidence conflicts", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      geocodeAddress("12 Main Street", { geographyConflict: true }),
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to validated Nominatim coordinates after a Google Places 403", async () => {
    vi.stubEnv("ENABLE_GOOGLE_PLACES_TEST", "true");
    vi.stubEnv("GOOGLE_PLACES_SERVER_KEY", "test-key");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        headers: { get: () => null },
        clone: () => ({
          json: async () => ({
            error: { status: "PERMISSION_DENIED", message: "API key is restricted" },
          }),
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [mapResult({
          place_id: 101,
          osm_id: 202,
          osm_type: "way",
          display_name: "12 Main Street, Abu Dhabi, United Arab Emirates",
          type: "house",
          class: "place",
          address: {
            house_number: "12",
            road: "Main Street",
            city: "Abu Dhabi",
            country_code: "ae",
          },
        })],
      });
    vi.stubGlobal("fetch", fetchMock);
    const health: Array<{ provider: string; status: string }> = [];

    const result = await geocodeAddress(
      "12 Main Street",
      { city: "Abu Dhabi", country: "AE" },
      undefined,
      { onProviderHealth: (update) => { health.push(update); } },
    );

    expect(result).toMatchObject({
      provider: "nominatim",
      precision: "exact",
      lat: 24.514,
      lng: 54.38,
    });
    const requestedUrls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(requestedUrls.filter((url) => url.includes("places.googleapis.com")).length).toBe(1);
    expect(requestedUrls.some((url) => url.includes("nominatim.openstreetmap.org"))).toBe(true);
    expect(health).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "google_places", status: "configuration_failure" }),
      expect.objectContaining({ provider: "nominatim", status: "healthy" }),
    ]));
  });

  it("skips Google Places for the rest of a run after its config failure is recorded", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [mapResult({
        type: "house",
        address: {
          house_number: "12",
          road: "Main Street",
          city: "Abu Dhabi",
          country_code: "ae",
        },
      })],
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await geocodeAddress(
      "12 Main Street",
      { city: "Abu Dhabi", country: "AE" },
      undefined,
      { skipProviders: ["google_places"] },
    );

    expect(result?.provider).toBe("nominatim");
    const requestedUrls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(requestedUrls.length).toBeGreaterThan(0);
    expect(requestedUrls.every((url) => url.includes("nominatim.openstreetmap.org"))).toBe(true);
  });
  it("parses the full structured address contract without accepting AI coordinates", async () => {
    mockCreateCompletion.mockResolvedValue({
      choices: [{
        message: {
          content: JSON.stringify({
            valid: true,
            reason: "Named venue with street and locality.",
            location_hints: {
              building_or_venue: "W by Nour",
              street: "Antelias Main Road",
              neighborhood: "Rabieh",
              town: "Antelias",
              country: "Lebanon",
              unit_details: "Floor 2",
              delivery_instructions: "Call when outside",
              latitude: 33.9,
              longitude: 35.6,
            },
          }),
        },
      }],
    });

    await expect(
      assessPlaceValidity("W by Nour, Antelias main road, Rabieh, Floor 2", [], {
        country: "Lebanon",
      }),
    ).resolves.toMatchObject({
      valid: true,
      locationHints: {
        buildingOrVenue: "W by Nour",
        street: "Antelias Main Road",
        neighborhood: "Rabieh",
        town: "Antelias",
        country: "Lebanon",
        unitDetails: "Floor 2",
        deliveryInstructions: "Call when outside",
      },
    });
  });

  it("prefers a Zalka locality fallback over a precise contradictory Hamra pin", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        mapResult({
          lat: "33.895920",
          lon: "35.478430",
          display_name: "Villa Youssef Akl, Hamra, Beirut, Lebanon",
          type: "house",
          address: { house: "Villa Youssef Akl", suburb: "Hamra", city: "Beirut", country_code: "lb" },
        }),
        mapResult({
          lat: "33.9008",
          lon: "35.5702",
          display_name: "Zalka, Matn District, Lebanon",
          type: "town",
          address: { town: "Zalka", municipality: "Amaret Chalhoub", country_code: "lb" },
        }),
      ],
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      geocodeAddress(
        "Villa Youssef Akl, Zalka Main Road, Amaret Chalhoub, Beirut, Lebanon",
        { country: "Lebanon" },
        {
          buildingOrVenue: "Villa Youssef Akl",
          street: "Zalka Main Road",
          neighborhood: "Zalka",
          town: "Amaret Chalhoub",
          country: "Lebanon",
        },
      ),
    ).resolves.toMatchObject({
      lat: 33.9008,
      lng: 35.5702,
      precision: "locality",
      method: "locality_fallback",
      matchedLocation: expect.stringContaining("Zalka"),
    });
  });

  it("derives a conservative Lebanese locality gate when AI returns no hints", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        mapResult({
          lat: "33.895920",
          lon: "35.478430",
          display_name: "Villa Youssef Akl, Hamra, Beirut, Lebanon",
          type: "house",
          address: { house: "Villa Youssef Akl", suburb: "Hamra", city: "Beirut", country_code: "lb" },
        }),
        mapResult({
          lat: "33.9008",
          lon: "35.5702",
          display_name: "Zalka, Amaret Chalhoub, Matn, Lebanon",
          type: "town",
          address: { town: "Zalka", municipality: "Amaret Chalhoub", country_code: "lb" },
        }),
      ],
    }));

    await expect(
      geocodeAddress(
        "Villa Youssef Akl, Zalka Main Road, Amaret Chalhoub, Beirut, Lebanon",
        { country: "Lebanon" },
      ),
    ).resolves.toMatchObject({
      lat: 33.9008,
      precision: "locality",
      matchedLocation: expect.stringContaining("Zalka"),
    });
  });

  it("accepts a locality-first Lebanese address without AI hints", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [mapResult({
        lat: "33.9008",
        lon: "35.5702",
        display_name: "Zalka, Matn District, Lebanon",
        type: "town",
        address: { town: "Zalka", country_code: "lb" },
      })],
    }));
    await expect(
      geocodeAddress("Zalka, Lebanon", { country: "Lebanon" }),
    ).resolves.toMatchObject({ precision: "locality", lat: 33.9008 });
  });

  it("keeps a full informal address when only the Al Bayada locality is mapped", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [mapResult({
        lat: "33.9212",
        lon: "35.6124",
        display_name: "Al Bayada, Matn District, Lebanon",
        type: "neighbourhood",
        address: {
          neighbourhood: "Al Bayada",
          county: "Matn District",
          country_code: "lb",
        },
      })],
    }));

    await expect(
      geocodeAddress(
        "Al Bayada 5th Street Jamil Building",
        { country: "Lebanon" },
        { neighborhood: "Al Bayada", country: "Lebanon" },
      ),
    ).resolves.toMatchObject({
      lat: 33.9212,
      precision: "locality",
      method: "locality_fallback",
      matchedLocation: expect.stringContaining("Al Bayada"),
    });
  });

  it.each(["Beirut, Lebanon", "Hamra, near petrol station, Beirut, Lebanon"])(
    "degrades %s to the most specific available locality",
    async (address) => {
      const isHamra = address.startsWith("Hamra");
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [mapResult({
          lat: isHamra ? "33.8959" : "33.8938",
          lon: isHamra ? "35.4784" : "35.5018",
          display_name: isHamra ? "Hamra, Beirut, Lebanon" : "Beirut, Lebanon",
          type: isHamra ? "suburb" : "city",
          address: isHamra
            ? { suburb: "Hamra", city: "Beirut", country_code: "lb" }
            : { city: "Beirut", country_code: "lb" },
        })],
      }));
      await expect(
        geocodeAddress(address, { country: "Lebanon" }),
      ).resolves.toMatchObject({
        precision: "locality",
        matchedLocation: expect.stringContaining(isHamra ? "Hamra" : "Beirut"),
      });
    },
  );

  it("does not let Beirut centre replace a supplied Zalka locality", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [mapResult({
        lat: "33.8938",
        lon: "35.5018",
        display_name: "Beirut, Lebanon",
        type: "city",
        address: { city: "Beirut", country_code: "lb" },
      })],
    }));
    await expect(
      geocodeAddress("Zalka, Beirut, Lebanon", { country: "Lebanon" }),
    ).resolves.toBeNull();
  });

  it("rejects a high-precision Beirut premise when the supplied locality is Dbayeh", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [mapResult({
        osm_id: 901,
        osm_type: "way",
        display_name: "ABC Building, Hamra, Beirut, Lebanon",
        type: "house",
        address: {
          house_number: "12",
          road: "Hamra Street",
          suburb: "Hamra",
          city: "Beirut",
          country_code: "lb",
        },
      })],
    }));

    await expect(
      geocodeAddress(
        "12 ABC Building, Dbayeh, Lebanon",
        { city: "Beirut", country: "Lebanon" },
        { buildingOrVenue: "ABC Building", town: "Dbayeh", country: "Lebanon" },
      ),
    ).resolves.toBeNull();
  });

  it("does not treat near-spelled Lebanese localities as equivalent", () => {
    expect(semanticMatchScore("Jal El Dib", "Jal El Dbayeh")).toBeLessThan(0.8);
    expect(semanticMatchScore("Jounieh", "Jbeil")).toBeLessThan(0.8);
  });

  it("uses deterministic locality tie-breaking when provider order reverses", async () => {
    const first = mapResult({
      place_id: 11,
      lat: "33.9008",
      lon: "35.5702",
      display_name: "Zalka, Matn, Lebanon",
      type: "town",
      address: { town: "Zalka", country_code: "lb" },
    });
    const second = mapResult({
      place_id: 22,
      lat: "33.9010",
      lon: "35.5704",
      display_name: "Zalka, Amaret Chalhoub, Lebanon",
      type: "town",
      address: { town: "Zalka", municipality: "Amaret Chalhoub", country_code: "lb" },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => [second, first] })
      .mockResolvedValue({ ok: true, json: async () => [] });
    vi.stubGlobal("fetch", fetchMock);
    const forward = await geocodeAddress("Zalka, Lebanon", { country: "Lebanon" });

    fetchMock.mockReset()
      .mockResolvedValueOnce({ ok: true, json: async () => [first, second] })
      .mockResolvedValue({ ok: true, json: async () => [] });
    const reversed = await geocodeAddress("Zalka, Lebanon", { country: "Lebanon" });
    expect(reversed).toMatchObject({
      lat: forward?.lat,
      lng: forward?.lng,
      placeIdentity: forward?.placeIdentity,
    });
  });

  it("builds progressive W by Nour venue, street, and locality searches", () => {
    const queries = buildGeocoderQueries(
      "Google Maps: W by Nour, Antelias main road, Rabieh",
      { country: "Lebanon" },
      {
        normalizedAddress: "W by Nour, Antelias Main Road, Rabieh",
        buildingOrVenue: "W by Nour",
        street: "Antelias Main Road",
        neighborhood: "Rabieh",
        town: "Antelias",
        country: "Lebanon",
      },
    );
    expect(queries).toEqual(expect.arrayContaining([
      "W by Nour, Antelias, Rabieh, Lebanon",
      "W by Nour, Rabieh, Lebanon",
      "W by Nour, Antelias, Lebanon",
      "Antelias Main Road, Rabieh, Lebanon",
      "Rabieh, Antelias, Lebanon",
      "Antelias, Lebanon",
    ]));
  });

  it.each([
    {
      address: "ABC Mall Dbayeh, Lebanon",
      hints: { buildingOrVenue: "ABC Mall", town: "Dbayeh", country: "Lebanon" },
      expectedQuery: "ABC Mall, Dbayeh, Lebanon",
    },
    {
      address: "City Centre Beirut, Hazmieh, Lebanon",
      hints: { buildingOrVenue: "City Centre Beirut", town: "Hazmieh", country: "Lebanon" },
      expectedQuery: "City Centre Beirut, Hazmieh, Lebanon",
    },
  ])("searches $address as a locality-grounded venue", ({ address, hints, expectedQuery }) => {
    expect(buildGeocoderQueries(address, { country: "Lebanon" }, hints)).toContain(expectedQuery);
  });

  it("drops unit-only detail and retains Zalka as an eligible locality fallback", () => {
    const queries = buildGeocoderQueries(
      "Apartment 4, Floor 2, Zalka, Lebanon",
      { country: "Lebanon" },
      {
        neighborhood: "Zalka",
        country: "Lebanon",
        unitDetails: "Apartment 4, Floor 2",
      },
    );
    expect(queries).toContain("Zalka, Lebanon");
    expect(queries.find((query) => query === "Zalka, Lebanon")).not.toMatch(/Apartment|Floor/i);
  });

  it("matches Lebanese Arabic transliteration and French address synonyms semantically", () => {
    expect(semanticMatchScore("شارع الحمرا، بيروت", "Hamra Street, Beirut")).toBeGreaterThan(0.9);
    expect(semanticMatchScore("Rue Hamra près de Pain Dor", "Pain D'Or, Hamra Street")).toBeGreaterThan(0.7);
    expect(semanticMatchScore("جبيل", "Byblos, Lebanon")).toBe(1);
  });

  it("normalizes common Lebanese Latin spelling variants for matching only", () => {
    expect(semanticMatchScore("Ashrafieh, Beirut", "Achrafieh, Beirut")).toBe(1);
    expect(semanticMatchScore("Jouniyeh", "Jounieh")).toBe(1);
    expect(semanticMatchScore("Zalqa", "Zalka")).toBe(1);
    expect(semanticMatchScore("Dbayé", "Dbayeh")).toBe(1);
  });

  it("accepts a grounded translated search target without literal input-token overlap", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [mapResult({
        lat: "33.896",
        lon: "35.482",
        display_name: "Hamra Street, Beirut, Lebanon",
        type: "road",
        class: "highway",
        address: {
          road: "Hamra Street",
          city: "Beirut",
          country_code: "lb",
        },
      })],
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      geocodeAddress(
        "شارع الحمرا",
        { city: "بيروت", country: "Lebanon" },
        {
          normalizedAddress: "Hamra Street",
          semanticClues: ["Hamra Street"],
          searchQueries: ["Hamra Street, Beirut"],
        },
      ),
    ).resolves.toMatchObject({
      matchedLocation: "Hamra Street, Beirut, Lebanon",
      provider: "nominatim",
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("countrycodes=lb");
  });

  it("keeps AI output text-only and never exposes suggested coordinates", async () => {
    mockCreateCompletion.mockResolvedValue({
      choices: [{
        message: {
          content: JSON.stringify({
            valid: true,
            reason: "Named villa community with a city.",
            location_hints: {
              landmark: "Saadiyat Beach Villas",
              city: "Abu Dhabi",
              latitude: 24.5,
              longitude: 54.3,
            },
          }),
        },
      }],
    });

    const assessment = await assessPlaceValidity("Saadiyat Beach Villas", [], {
      city: "Abu Dhabi",
      country: "AE",
    });

    expect(assessment).toMatchObject({
      valid: true,
      locationHints: { landmark: "Saadiyat Beach Villas", city: "Abu Dhabi" },
    });
    expect(JSON.stringify(assessment)).not.toMatch(/latitude|longitude|24\.5|54\.3/);
  });

  it("tries canonical text before context-rich nearby fallback queries", () => {
    expect(
      buildGeocoderQueries(
        "Saadiyat Beach Villas",
        {
          aliases: ["Saadiyat villas"],
          area: "Saadiyat",
          city: "Abu Dhabi",
          country: "AE",
        },
        { landmark: "Saadiyat Beach Villas" },
      ),
    ).toEqual(
      expect.arrayContaining([
        "Saadiyat Beach Villas, Saadiyat, Abu Dhabi, AE",
        "Saadiyat villas, Saadiyat, Abu Dhabi, AE",
        "Saadiyat, Abu Dhabi, AE",
      ]),
    );
  });

  it("drops AI hints that introduce a location not supported by the address context", () => {
    const queries = buildGeocoderQueries(
      "Saadiyat Beach Villas",
      { area: "Saadiyat", city: "Abu Dhabi", country: "AE" },
      {
        landmark: "Unrelated Palace",
        searchQueries: ["Unrelated Palace, Abu Dhabi"],
      },
    );

    expect(queries.join(" | ")).not.toContain("Unrelated Palace");
  });

  it("drops an AI hint even when invented place evidence is mixed with real terms", () => {
    const queries = buildGeocoderQueries(
      "Hamra Street, Beirut",
      { area: "Hamra", city: "Beirut", country: "Lebanon" },
      {
        landmark: "Hamra Street Atlantis Palace",
        searchQueries: ["Hamra Street Atlantis Palace, Beirut"],
        semanticClues: ["Hamra Atlantis Palace"],
      },
    );

    expect(queries.join(" | ")).not.toContain("Atlantis");
  });

  it("returns an exact result for a direct, city-consistent map match", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [mapResult({
        display_name: "12 Main Street, Abu Dhabi, United Arab Emirates",
        type: "house",
        address: { house_number: "12", road: "Main Street", city: "Abu Dhabi", country_code: "ae" },
      })],
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      geocodeAddress("12 Main Street", { city: "Abu Dhabi", country: "AE" }),
    ).resolves.toMatchObject({
      matchType: "exact",
      matchedLocation: "12 Main Street, Abu Dhabi, United Arab Emirates",
    });
    // The verifier ranks the complete candidate set rather than accepting the
    // first provider response, so later progressive queries are also checked.
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("records query and candidate evidence for an accepted result", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [mapResult({
        place_id: 101,
        osm_id: 202,
        osm_type: "way",
        display_name: "12 Main Street, Abu Dhabi, United Arab Emirates",
        type: "house",
        class: "place",
        address: {
          house_number: "12",
          road: "Main Street",
          city: "Abu Dhabi",
          country_code: "ae",
        },
      })],
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await geocodeAddress("12 Main Street", {
      city: "Abu Dhabi",
      country: "AE",
    });

    expect(result).toMatchObject({
      resultLevel: "premise",
      queriesTried: expect.arrayContaining(["12 Main Street, Abu Dhabi, AE"]),
      candidateEvidence: expect.arrayContaining([
        expect.objectContaining({
          accepted: true,
          precision: "exact",
          result_level: "premise",
          candidate_id: "way:202",
        }),
      ]),
      confidenceEvidence: expect.objectContaining({
        candidate_count: 1,
        result_level: "premise",
      }),
    });
  });

  it("does not guess between two similarly supported premise candidates", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => [
        mapResult({
          osm_id: 301,
          osm_type: "way",
          display_name: "12 Main Street, Abu Dhabi, United Arab Emirates",
          type: "house",
          address: {
            house_number: "12",
            road: "Main Street",
            city: "Abu Dhabi",
            country_code: "ae",
          },
        }),
        mapResult({
          osm_id: 302,
          osm_type: "way",
          display_name: "12 Main St, Abu Dhabi, United Arab Emirates",
          type: "house",
          address: {
            house_number: "12",
            road: "Main St",
            city: "Abu Dhabi",
            country_code: "ae",
          },
        }),
      ],
    }).mockResolvedValue({
      ok: true,
      json: async () => [],
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      geocodeAddress("12 Main Street", {
        city: "Abu Dhabi",
        country: "AE",
      }),
    ).rejects.toMatchObject({
      name: "MapProviderError",
      failureType: "ambiguity",
    });
  });

  it("uses an address-specific community result as an approximate fallback after the direct lookup misses", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    }).mockResolvedValue({
      ok: true,
      json: async () => [mapResult()],
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      geocodeAddress("Saadiyat Beach Villas", {
        area: "Saadiyat",
        city: "Abu Dhabi",
        country: "AE",
      }),
    ).resolves.toMatchObject({
      matchType: "approximate",
      matchedLocation: "Saadiyat Beach Villas, Saadiyat, Abu Dhabi, United Arab Emirates",
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });

  it("rejects a generic same-city fallback for two distinct addresses", async () => {
    const genericCityResult = mapResult({
      lat: "24.4539",
      lon: "54.3773",
      display_name: "Abu Dhabi, United Arab Emirates",
      type: "city",
      class: "place",
      address: {
        city: "Abu Dhabi",
        country: "United Arab Emirates",
        country_code: "ae",
      },
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [genericCityResult],
    });
    vi.stubGlobal("fetch", fetchMock);

    const context = { city: "Abu Dhabi", country: "AE" };
    await expect(geocodeAddress("Cedar Tower, Main Street", context)).resolves.toBeNull();
    await expect(geocodeAddress("Palm Residence, Corniche Road", context)).resolves.toBeNull();
  });

  it("rejects a same-named suburb centroid without structured address evidence", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [mapResult({
        lat: "24.4900",
        lon: "54.3600",
        display_name: "Cedar Heights, Abu Dhabi, United Arab Emirates",
        type: "suburb",
        class: "place",
        address: {
          suburb: "Cedar Heights",
          city: "Abu Dhabi",
          country_code: "ae",
        },
      })],
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      geocodeAddress("Cedar Heights, Main Street", {
        city: "Abu Dhabi",
        country: "AE",
      }),
    ).resolves.toBeNull();
  });

  it("accepts an approximate result only when it supports address-specific building evidence", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [mapResult({
        lat: "24.4701",
        lon: "54.3552",
        display_name: "Cedar Tower, Main Street, Abu Dhabi, United Arab Emirates",
        type: "building",
        class: "building",
        address: {
          building: "Cedar Tower",
          road: "Main Street",
          city: "Abu Dhabi",
          country_code: "ae",
        },
      })],
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      geocodeAddress("Cedar Tower, Main Street", {
        area: "Corniche",
        city: "Abu Dhabi",
        country: "AE",
      }),
    ).resolves.toMatchObject({
      matchType: "approximate",
      matchedLocation: expect.stringContaining("Cedar Tower"),
    });
  });

  it("rejects a result whose country code contradicts the expected country", async () => {
    // A result in Lebanon when the expected country is UAE must be hard-rejected.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [mapResult({
        display_name: "Saadiyat Street, Beirut, Lebanon",
        address: { city: "Beirut", country_code: "lb" },
      })],
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      geocodeAddress("Saadiyat Beach Villas", {
        area: "Saadiyat",
        city: "Abu Dhabi",
        country: "AE",
      }),
    ).resolves.toBeNull();
  });

  it("returns approximate for a same-city result outside the known area (soft area gate)", async () => {
    // With the softened 0.4 area gate, a result that fails the area check is
    // allowed as an approximate candidate rather than hard-rejected.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [mapResult({
        display_name: "Villa 24, Khalifa City, Abu Dhabi, United Arab Emirates",
        type: "house",
        address: { house_number: "24", city: "Abu Dhabi", country_code: "ae" },
      })],
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      geocodeAddress("Villa 24", {
        area: "Saadiyat",
        city: "Abu Dhabi",
        country: "AE",
      }),
    ).resolves.toMatchObject({ matchType: "approximate" });
  });

  it("stripSubUnits removes floor/flat/apt tokens leaving the street-level text", () => {
    expect(stripSubUnits("Floor 3, Flat B, Al Quoz Industrial Area")).toBe("Al Quoz Industrial Area");
    expect(stripSubUnits("Apt 12, Hamra Street")).toBe("Hamra Street");
    expect(stripSubUnits("Suite 100, Tower A, Downtown")).toBe("Tower A, Downtown");
    expect(stripSubUnits("Gate 2, Jumeirah Village")).toBe("Jumeirah Village");
    // Text with no sub-unit tokens should be unchanged
    expect(stripSubUnits("Saadiyat Beach Villas")).toBe("Saadiyat Beach Villas");
  });

  it("buildGeocoderQueries includes sub-unit stripped variants after the primary queries", () => {
    const queries = buildGeocoderQueries(
      "Flat 3B, near the petrol station, Hamra",
      { city: "Beirut", country: "Lebanon" },
    );
    // Primary query includes original text
    expect(queries[0]).toContain("Flat 3B");
    // Stripped variant should also appear (Flat removed)
    const strippedEntry = queries.find((q) => !q.includes("Flat") && q.includes("Hamra"));
    expect(strippedEntry).toBeTruthy();
  });

  it("defaults the AI model to gpt-4o-mini when the env var is absent", async () => {
    delete process.env.AI_PLACE_ASSESSOR_MODEL;
    mockCreateCompletion.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ valid: true, reason: "Named area." }) } }],
    });

    await assessPlaceValidity("Hamra, Beirut", [], { city: "Beirut", country: "Lebanon" });

    expect(mockCreateCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-4o-mini" }),
    );
  });

  it("keeps a hint whose value matches a known context city even with low token overlap", () => {
    // "Beirut" has near-zero token overlap with the address text
    // but exactly matches context.city, so it must be kept.
    const queries = buildGeocoderQueries(
      "Near the blue mosque, Hamra",
      { city: "Beirut", country: "Lebanon" },
      { city: "Beirut", searchQueries: ["Hamra, Beirut"] },
    );
    expect(queries.join(" | ")).toContain("Beirut");
  });

  it("parses a text-only landmark anchor from the structured AI contract", async () => {
    mockCreateCompletion.mockResolvedValue({
      choices: [{
        message: {
          content: JSON.stringify({
            valid: true,
            reason: "A named landmark with city context.",
            location_hints: {
              search_anchor: "Pain D'Or",
              anchor_type: "landmark",
              latitude: 33.9,
              longitude: 35.5,
            },
          }),
        },
      }],
    });

    const assessment = await assessPlaceValidity(
      "Al Zarif next to Pain Dor",
      [],
      { city: "Beirut", country: "Lebanon" },
    );

    expect(assessment.locationHints).toEqual({
      searchAnchor: "Pain D'Or",
      anchorType: "landmark",
    });
    expect(JSON.stringify(assessment)).not.toMatch(/latitude|longitude|33\.9|35\.5/);
  });

  it("puts an explicit proximity landmark ahead of noisy address fragments", () => {
    const anchor = extractSearchAnchor(
      "Al Zarif next to Pain Dor- Talaat Harb Road- Al rawda Building- Balaa- 14th",
    );
    expect(anchor).toEqual({ value: "Pain Dor", type: "landmark" });

    const queries = buildGeocoderQueries(
      "Al Zarif next to Pain Dor- Talaat Harb Road- Al rawda Building- Balaa- 14th",
      { area: "Zarif", city: "Beirut", country: "Lebanon" },
      { searchAnchor: "Pain D'Or", anchorType: "landmark" },
    );

    expect(queries[0]).toBe("Pain Dor, Zarif, Beirut, Lebanon");
    expect(queries.join(" | ")).not.toMatch(/next to|14th|Balaa/i);
  });

  it("extracts comma-delimited proximity landmarks without consuming the locality", () => {
    expect(extractSearchAnchor("Hamra, near Pain D'Or, Beirut")).toEqual({
      value: "Pain D'Or",
      type: "landmark",
    });
    expect(
      buildGeocoderQueries(
        "Hamra, near Pain D'Or, Beirut",
        { area: "Hamra", city: "Beirut", country: "Lebanon" },
      )[0],
    ).toBe("Pain D'Or, Hamra, Beirut, Lebanon");
  });

  it("uses an institution acronym as the only target and removes ordinal room details", () => {
    expect(extractSearchAnchor("AUBMC 10th 1011")).toEqual({
      value: "AUBMC",
      type: "institution",
    });

    const queries = buildGeocoderQueries(
      "AUBMC 10th 1011",
      { city: "Beirut", country: "Lebanon" },
    );

    expect(queries[0]).toBe("AUBMC, Beirut, Lebanon");
    expect(queries.join(" | ")).not.toMatch(/10th|1011/);
  });

  it("does not mistake ordinary uppercase address tokens for institutions", () => {
    expect(extractSearchAnchor("BLDG 12, UNIT 4, Main Street")).toBeNull();
    const queries = buildGeocoderQueries(
      "BLDG 12, UNIT 4, Main Street",
      { city: "Beirut", country: "Lebanon" },
    );
    expect(queries[0]).toBe("BLDG 12, UNIT 4, Main Street, Beirut, Lebanon");
    expect(queries).toContain("BLDG 12, UNIT 4, Main Street, Beirut, Lebanon");
  });

  it("keeps generic proximity descriptions on the normal address fallback path", () => {
    expect(extractSearchAnchor("Flat 3B, near the petrol station, Hamra")).toBeNull();
    expect(
      buildGeocoderQueries(
        "Flat 3B, near the petrol station, Hamra",
        { city: "Beirut", country: "Lebanon" },
      )[0],
    ).toContain("Flat 3B");
  });

  it("cleans proximity and building tails from an AI-provided anchor", () => {
    const queries = buildGeocoderQueries(
      "Al Zarif next to Pain Dor, Al Rawda Building",
      { area: "Zarif", city: "Beirut", country: "Lebanon" },
      {
        searchAnchor: "next to Pain Dor - Al Rawda Building",
        anchorType: "landmark",
      },
    );
    expect(queries[0]).toBe("Pain Dor, Zarif, Beirut, Lebanon");
    expect(queries.join(" | ")).not.toMatch(/Al Rawda|next to/i);
  });

  it("prefers the address-derived landmark over an AI anchor with an unspaced building tail", () => {
    const queries = buildGeocoderQueries(
      "Al Zarif next to Pain Dor-Al Rawda Building",
      { area: "Zarif", city: "Beirut", country: "Lebanon" },
      {
        searchAnchor: "Pain Dor-Al Rawda Building",
        anchorType: "landmark",
      },
    );
    expect(queries[0]).toBe("Pain Dor, Zarif, Beirut, Lebanon");
    expect(queries.join(" | ")).not.toContain("Al Rawda");
  });

  it("accepts harmless landmark punctuation and spelling variation from the map provider", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [mapResult({
        lat: "33.894",
        lon: "35.486",
        display_name: "Pain D'Or, Zarif, Beirut, Lebanon",
        type: "retail",
        class: "shop",
        address: {
          shop: "Pain D'Or",
          suburb: "Zarif",
          city: "Beirut",
          country_code: "lb",
        },
      })],
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      geocodeAddress(
        "Al Zarif next to Pain Dor",
        { area: "Zarif", city: "Beirut", country: "Lebanon" },
        { searchAnchor: "Pain Dor", anchorType: "landmark" },
      ),
    ).resolves.toMatchObject({
      matchType: "exact",
      matchedLocation: "Pain D'Or, Zarif, Beirut, Lebanon",
      query: "Pain Dor, Zarif, Beirut, Lebanon",
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects an anchor result from a different city even when the country matches", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [mapResult({
        display_name: "AUBMC, Tripoli, Lebanon",
        type: "hospital",
        class: "amenity",
        address: {
          hospital: "AUBMC",
          city: "Tripoli",
          country_code: "lb",
        },
      })],
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      geocodeAddress(
        "AUBMC 10th 1011",
        { city: "Beirut", country: "Lebanon" },
      ),
    ).resolves.toBeNull();
  });

  it("rejects an anchor result whose country conflicts with any supported ISO country", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [mapResult({
        display_name: "AUBMC, Beirut, Lebanon",
        type: "hospital",
        class: "amenity",
        address: {
          hospital: "AUBMC",
          country_code: "lb",
        },
      })],
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      geocodeAddress("AUBMC 10th 1011", { country: "Qatar" }),
    ).resolves.toBeNull();
  });

  it("rejects a same-city locality result that does not support the explicit anchor", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [mapResult({
        display_name: "Zarif, Beirut, Lebanon",
        type: "suburb",
        class: "place",
        address: {
          suburb: "Zarif",
          city: "Beirut",
          country_code: "lb",
        },
      })],
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      geocodeAddress(
        "Al Zarif next to Pain Dor",
        { area: "Zarif", city: "Beirut", country: "Lebanon" },
        { searchAnchor: "Pain Dor", anchorType: "landmark" },
      ),
    ).resolves.toBeNull();
  });
});