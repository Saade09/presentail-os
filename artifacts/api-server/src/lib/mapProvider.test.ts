import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  autocompleteGooglePlaces,
  diagnoseMapProviders,
  MapProviderError,
  searchGooglePlacesText,
  searchNominatim,
} from "./mapProvider";

describe("mapProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("always restricts interactive Google autocomplete to Lebanon", async () => {
    vi.stubEnv("GOOGLE_PLACES_SERVER_KEY", "test-key");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ suggestions: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await autocompleteGooglePlaces({ input: "Hamra" });

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      input: "Hamra",
      includedRegionCodes: ["LB"],
    });
  });

  it("retries a transient Nominatim failure within a bounded attempt count", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ display_name: "Hamra Street, Beirut, Lebanon" }],
      });
    vi.stubGlobal("fetch", fetchMock);

    await expect(searchNominatim("Hamra Street", { countryCode: "lb" }))
      .resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("countrycodes=lb");
  });

  it("returns a structured non-retryable provider error", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 400 });
    vi.stubGlobal("fetch", fetchMock);

    await expect(searchNominatim("bad request")).rejects.toMatchObject({
      provider: "nominatim",
      code: "upstream",
      retryable: false,
      upstreamStatus: 400,
    } satisfies Partial<MapProviderError>);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("captures a redacted, categorized Google Places (New) error response", async () => {
    vi.stubEnv("GOOGLE_PLACES_SERVER_KEY", "test-key");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      headers: { get: () => null },
      clone: () => ({
        json: async () => ({
          error: {
            status: "PERMISSION_DENIED",
            message: "API key=AIza123456789012345678901234567890 and Places API is disabled",
          },
        }),
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    let providerError: MapProviderError | undefined;
    try {
      await searchGooglePlacesText({ textQuery: "Beirut", regionCode: "LB" });
    } catch (error) {
      if (error instanceof MapProviderError) providerError = error;
    }
    expect(providerError).toMatchObject({
        provider: "google_places",
        upstreamStatus: 403,
        errorCategory: "api_disabled",
        providerMessage: expect.stringContaining("Places API is disabled"),
      } satisfies Partial<MapProviderError>);
    expect(providerError?.providerResponseBody).toContain("Places API is disabled");
    expect(providerError?.providerResponseBody).not.toContain("AIza");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://places.googleapis.com/v1/places:searchText");
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      "Content-Type": "application/json",
      "X-Goog-Api-Key": "test-key",
      "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.types",
    });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({
        textQuery: "Beirut",
        pageSize: 5,
        languageCode: "en",
        regionCode: "LB",
      }),
    });
  });

  it("preserves complete Google error details while redacting secrets and tokens", async () => {
    vi.stubEnv("GOOGLE_PLACES_SERVER_KEY", "test-key");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: {
        code: 403,
        status: "PERMISSION_DENIED",
        message: "The caller does not have permission",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "ORG_RESTRICTION_VIOLATION",
            domain: "googleapis.com",
            metadata: {
              service: "places.googleapis.com",
              method: "google.maps.places.v1.Places.SearchText",
              consumer: "projects/123456789",
              project_number: "123456789",
              quota_location: "us-central1",
              api_key: "AIza-secret-value",
              access_token: "opaque-access-token",
              authorization: "Bearer opaque-bearer-token",
              customer_address: "42 Example Street",
              additional_metadata: { policy_name: "places-access" },
            },
          },
          {
            "@type": "type.googleapis.com/google.rpc.Help",
            links: [{
              description: "Review Places API settings",
              url: "https://console.cloud.google.com/apis/api/places.googleapis.com/overview?project=123456789&key=AIza-secret-value&access_token=opaque-help-token",
            }],
          },
          { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ subject: "projects/123456789" }] },
          { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "3s" },
          { "@type": "type.googleapis.com/google.rpc.DebugInfo", detail: "request routed to places.googleapis.com" },
          { "@type": "type.googleapis.com/google.rpc.LocalizedMessage", locale: "en", message: "See the Help link above" },
          { "@type": "type.googleapis.com/google.rpc.TestDetail", diagnostic: "sixth detail retained" },
        ],
      },
    }), { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);

    let providerError: MapProviderError | undefined;
    try {
      await searchGooglePlacesText({ textQuery: "Beirut, Lebanon", regionCode: "LB", pageSize: 1 });
    } catch (error) {
      if (error instanceof MapProviderError) providerError = error;
    }

    expect(providerError).toMatchObject({
      upstreamStatus: 403,
      errorCategory: "organization_policy",
      providerMessage: expect.stringContaining("ORG_RESTRICTION_VIOLATION"),
    });
    const safeBody = JSON.parse(providerError?.providerResponseBody ?? "{}");
    expect(safeBody.error.details[0]).toMatchObject({
      "@type": "type.googleapis.com/google.rpc.ErrorInfo",
      reason: "ORG_RESTRICTION_VIOLATION",
      domain: "googleapis.com",
      metadata: {
        service: "places.googleapis.com",
        method: "google.maps.places.v1.Places.SearchText",
        consumer: "projects/123456789",
        project_number: "123456789",
        quota_location: "us-central1",
        api_key: "[redacted]",
        access_token: "[redacted]",
        authorization: "[redacted]",
        customer_address: "42 Example Street",
        additional_metadata: { policy_name: "places-access" },
      },
    });
    expect(safeBody.error.details).toHaveLength(7);
    expect(safeBody.error.details[1]).toMatchObject({
      "@type": "type.googleapis.com/google.rpc.Help",
      links: [{
        description: "Review Places API settings",
        url: expect.stringContaining("https://console.cloud.google.com/apis/api/places.googleapis.com/overview?project=123456789"),
      }],
    });
    expect(safeBody.error.details[1].links[0].url).toContain("key=[redacted]");
    expect(safeBody.error.details[1].links[0].url).toContain("access_token=[redacted]");
    expect(safeBody.error.details[6]).toMatchObject({
      diagnostic: "sixth detail retained",
    });
    expect(providerError?.providerResponseBody).not.toContain("AIza-secret-value");
    expect(providerError?.providerResponseBody).not.toContain("opaque-access-token");
    expect(providerError?.providerResponseBody).not.toContain("opaque-bearer-token");
    expect(providerError?.providerResponseBody).not.toContain("opaque-help-token");
  });

  it("reports provider reachability without returning results or credential values", async () => {
    vi.stubEnv("GOOGLE_PLACES_SERVER_KEY", "private-test-key");
    const fetchMock = vi.fn((input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://places.googleapis.com/v1/places:searchText") {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        return Promise.resolve(
          headers["X-Goog-FieldMask"] === "places.id,places.displayName,places.formattedAddress,places.location"
            ? new Response(JSON.stringify({ places: [] }), { status: 200 })
            : new Response(JSON.stringify({ places: [{ id: "private-result" }] }), { status: 200 }),
        );
      }
      return Promise.resolve(new Response(JSON.stringify([{ display_name: "private-result" }]), { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await diagnoseMapProviders();

    expect(result).toHaveLength(2);
    expect(result.every((provider) => provider.reachable)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private-test-key");
    expect(JSON.stringify(result)).not.toContain("private-result");
    const googleDiagnostic = result.find((provider) => provider.provider === "google_places");
    expect(googleDiagnostic?.credentialFingerprint)
      .toBe(createHash("sha256").update("private-test-key").digest("hex").slice(0, 16));
    expect(googleDiagnostic?.minimalTextSearch).toMatchObject({
      attempted: true,
      method: "POST",
      endpoint: "https://places.googleapis.com/v1/places:searchText",
      authHeader: "X-Goog-Api-Key",
      fieldMask: "places.id,places.displayName,places.formattedAddress,places.location",
      textQuery: "Beirut, Lebanon",
      httpStatus: 200,
    });
    const googleRequests = fetchMock.mock.calls.filter(([url]) =>
      String(url) === "https://places.googleapis.com/v1/places:searchText",
    );
    expect(googleRequests).toHaveLength(2);
    expect(googleRequests[0]?.[1]).toMatchObject({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": "private-test-key",
        "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location",
      },
      body: JSON.stringify({ textQuery: "Beirut, Lebanon" }),
    });
    expect(googleRequests[0]?.[1]?.headers).not.toHaveProperty("Authorization");
    expect(googleRequests[0]?.[1]?.headers).not.toHaveProperty("x-goog-user-project");
    expect(googleRequests[1]?.[1]).toMatchObject({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": "private-test-key",
        "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.types",
      },
      body: JSON.stringify({
        textQuery: "Beirut, Lebanon",
        pageSize: 1,
        languageCode: "en",
        regionCode: "LB",
      }),
    });
  });

  it("captures Help and ErrorInfo data from the minimal Text Search control", async () => {
    vi.stubEnv("GOOGLE_PLACES_SERVER_KEY", "private-test-key");
    const googleFailure = () => new Response(JSON.stringify({
      error: {
        code: 403,
        status: "PERMISSION_DENIED",
        message: "The caller does not have permission",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "CONSUMER_INVALID",
            domain: "googleapis.com",
            metadata: {
              service: "places.googleapis.com",
              consumer: "projects/123456789",
              project_number: "123456789",
            },
          },
          {
            "@type": "type.googleapis.com/google.rpc.Help",
            links: [{ description: "Inspect the project", url: "https://cloud.google.com/service-usage?project=123456789" }],
          },
        ],
      },
    }), { status: 403 });
    const fetchMock = vi.fn((input: unknown) =>
      Promise.resolve(
        String(input) === "https://places.googleapis.com/v1/places:searchText"
          ? googleFailure()
          : new Response("[]", { status: 200 }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const providers = await diagnoseMapProviders();
    const google = providers.find((provider) => provider.provider === "google_places");

    expect(google).toMatchObject({
      reachable: false,
      httpStatus: 403,
      errorCategory: "wrong_consumer_project",
      minimalTextSearch: {
        attempted: true,
        httpStatus: 403,
        errorCategory: "wrong_consumer_project",
      },
    });
    const controlBody = JSON.parse(google?.minimalTextSearch?.providerResponseBody ?? "{}");
    expect(controlBody.error.details).toEqual(expect.arrayContaining([
      expect.objectContaining({
        reason: "CONSUMER_INVALID",
        metadata: {
          service: "places.googleapis.com",
          consumer: "projects/123456789",
          project_number: "123456789",
        },
      }),
      expect.objectContaining({
        "@type": "type.googleapis.com/google.rpc.Help",
        links: [{ description: "Inspect the project", url: "https://cloud.google.com/service-usage?project=123456789" }],
      }),
    ]));
  });
});