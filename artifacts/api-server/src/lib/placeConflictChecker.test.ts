import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./logger.js", () => ({
  logger: { warn: vi.fn(), error: vi.fn() },
}));

import { checkPlaceLocationConflict } from "./placeConflictChecker";

type FetchResponse = Record<string, unknown> | null;

function stubFetch(response: FetchResponse, ok = true): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok,
      json: () => Promise.resolve(response),
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ── No constraints ────────────────────────────────────────────────────────────

describe("checkPlaceLocationConflict — no constraints", () => {
  it("returns no conflict when neither countryCode nor cityName is provided", async () => {
    // fetch must NOT be called when there is nothing to compare against
    const result = await checkPlaceLocationConflict({ latitude: 25.2, longitude: 55.3 });
    expect(result.conflict).toBe(false);
    expect(result.explanation).toMatch(/No geographic constraint/);
  });

  it("returns no conflict when only area is provided (area alone is not a constraint)", async () => {
    const result = await checkPlaceLocationConflict({
      latitude: 25.2,
      longitude: 55.3,
      area: "Jumeirah",
    });
    expect(result.conflict).toBe(false);
  });
});

// ── Nominatim unavailable ─────────────────────────────────────────────────────

describe("checkPlaceLocationConflict — Nominatim unavailable", () => {
  it("returns no conflict when fetch throws (network error)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));
    const result = await checkPlaceLocationConflict({
      latitude: 25.2,
      longitude: 55.3,
      countryCode: "ae",
    });
    expect(result.conflict).toBe(false);
    expect(result.explanation).toMatch(/could not be verified/);
  });

  it("returns no conflict when Nominatim returns non-200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 503, json: () => Promise.resolve(null) }),
    );
    const result = await checkPlaceLocationConflict({
      latitude: 25.2,
      longitude: 55.3,
      countryCode: "ae",
    });
    expect(result.conflict).toBe(false);
    expect(result.explanation).toMatch(/could not be verified/);
  });

  it("returns no conflict when Nominatim returns an error field", async () => {
    stubFetch({ error: "Unable to geocode" });
    const result = await checkPlaceLocationConflict({
      latitude: 0,
      longitude: 0,
      countryCode: "ae",
    });
    expect(result.conflict).toBe(false);
  });
});

// ── Country conflict ──────────────────────────────────────────────────────────

describe("checkPlaceLocationConflict — country conflict", () => {
  it("detects conflict when coordinates land in a different country", async () => {
    stubFetch({
      address: { city: "Beirut", country: "Lebanon", country_code: "lb" },
    });
    const result = await checkPlaceLocationConflict({
      latitude: 33.888,
      longitude: 35.495,
      countryCode: "ae",
    });
    expect(result.conflict).toBe(true);
    expect(result.explanation).toMatch(/Lebanon/);
    expect(result.explanation).toMatch(/AE/);
  });

  it("checks country before city (country mismatch takes priority)", async () => {
    // The city name is 'Dubai' in the geocode result, but the country is wrong.
    stubFetch({
      address: { city: "Dubai", country: "Lebanon", country_code: "lb" },
    });
    const result = await checkPlaceLocationConflict({
      latitude: 33.888,
      longitude: 35.495,
      countryCode: "ae",
      cityName: "Dubai",
    });
    expect(result.conflict).toBe(true);
    expect(result.explanation).toMatch(/Lebanon/);
  });

  it("recognises 'AE' as matching country_code 'ae'", async () => {
    stubFetch({
      address: { city: "Dubai", country: "United Arab Emirates", country_code: "ae" },
    });
    const result = await checkPlaceLocationConflict({
      latitude: 25.2,
      longitude: 55.3,
      countryCode: "AE",
    });
    expect(result.conflict).toBe(false);
  });

  it("recognises 'lb' as matching countryCode 'lb'", async () => {
    stubFetch({
      address: { city: "Beirut", country: "Lebanon", country_code: "lb" },
    });
    const result = await checkPlaceLocationConflict({
      latitude: 33.888,
      longitude: 35.495,
      countryCode: "lb",
    });
    expect(result.conflict).toBe(false);
  });

  it("skips country check when Nominatim omits country_code", async () => {
    // No country_code in response — should fall through to city check only
    stubFetch({
      address: { city: "Dubai" },
    });
    const result = await checkPlaceLocationConflict({
      latitude: 25.2,
      longitude: 55.3,
      countryCode: "ae",
      cityName: "Dubai",
    });
    // country_code is empty so we can't determine a conflict — should pass city check
    expect(result.conflict).toBe(false);
  });
});

// ── City conflict ─────────────────────────────────────────────────────────────

describe("checkPlaceLocationConflict — city conflict", () => {
  it("detects conflict when coordinates are in a different city", async () => {
    stubFetch({
      address: { city: "Dubai", country: "United Arab Emirates", country_code: "ae" },
    });
    const result = await checkPlaceLocationConflict({
      latitude: 25.2,
      longitude: 55.3,
      countryCode: "ae",
      cityName: "Abu Dhabi",
    });
    expect(result.conflict).toBe(true);
    expect(result.explanation).toMatch(/Abu Dhabi/);
  });

  it("returns no conflict when city matches exactly", async () => {
    stubFetch({
      address: { city: "Dubai", country: "United Arab Emirates", country_code: "ae" },
    });
    const result = await checkPlaceLocationConflict({
      latitude: 25.2,
      longitude: 55.3,
      countryCode: "ae",
      cityName: "Dubai",
    });
    expect(result.conflict).toBe(false);
  });

  it("matches city via the town field when city is absent", async () => {
    stubFetch({
      address: { town: "Limassol", country: "Cyprus", country_code: "cy" },
    });
    const result = await checkPlaceLocationConflict({
      latitude: 34.68,
      longitude: 33.04,
      countryCode: "cy",
      cityName: "Limassol",
    });
    expect(result.conflict).toBe(false);
  });

  it("matches city via partial word overlap (Municipality of Abu Dhabi vs Abu Dhabi)", async () => {
    stubFetch({
      address: {
        city: "Municipality of Abu Dhabi",
        country: "United Arab Emirates",
        country_code: "ae",
      },
    });
    const result = await checkPlaceLocationConflict({
      latitude: 24.45,
      longitude: 54.37,
      countryCode: "ae",
      cityName: "Abu Dhabi",
    });
    expect(result.conflict).toBe(false);
  });

  it("returns no conflict when only countryCode is given and country matches", async () => {
    stubFetch({
      address: { city: "Dubai", country: "United Arab Emirates", country_code: "ae" },
    });
    const result = await checkPlaceLocationConflict({
      latitude: 25.2,
      longitude: 55.3,
      countryCode: "ae",
    });
    expect(result.conflict).toBe(false);
  });
});
