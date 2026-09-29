import { createHash } from "node:crypto";
import { logger } from "./logger";

export type ProviderName = "google_places" | "nominatim";
export type ProviderHealthStatus =
  | "healthy"
  | "temporarily_unavailable"
  | "configuration_failure"
  | "rate_limited"
  | "disabled_unconfigured";

export interface ProviderHealthUpdate {
  provider: ProviderName;
  status: ProviderHealthStatus;
  httpStatus: number | null;
  errorCategory: string | null;
  providerMessage: string | null;
  lastChecked: string;
}

export type ProviderRunHealth = Partial<Record<ProviderName, ProviderHealthUpdate>>;

export class MapProviderError extends Error {
  constructor(
    readonly provider: ProviderName,
    readonly code: "not_configured" | "rate_limited" | "upstream" | "unavailable" | "invalid_response" | "zero_results" | "ambiguity",
    message: string,
    readonly retryable: boolean,
    readonly upstreamStatus?: number,
    readonly retryAfter?: string | null,
    readonly stage: "autocomplete" | "text_search" | "place_details" | "geocode" = "geocode",
    readonly query?: string,
    readonly providerMessage?: string,
    readonly errorCategory?: string,
    readonly providerResponseBody?: string,
  ) {
    super(message);
    this.name = "MapProviderError";
  }

  get failureType():
    | "configuration_authentication"
    | "quota_rate_limit"
    | "timeout_network"
    | "upstream_5xx"
    | "invalid_response"
    | "zero_results"
    | "ambiguity" {
    if (this.code === "not_configured" || this.upstreamStatus === 401 || this.upstreamStatus === 403) {
      return "configuration_authentication";
    }
    if (this.code === "rate_limited" || this.upstreamStatus === 429) return "quota_rate_limit";
    if (this.code === "invalid_response") return "invalid_response";
    if (this.code === "zero_results") return "zero_results";
    if (this.code === "ambiguity") return "ambiguity";
    if (this.upstreamStatus != null && this.upstreamStatus >= 500) return "upstream_5xx";
    return "timeout_network";
  }
}

const GOOGLE_SECRET_FIELD_NAMES = new Set([
  "apikey",
  "xgoogapikey",
  "authorization",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "token",
  "clientsecret",
  "secret",
  "privatekey",
  "password",
]);

function redactGoogleErrorText(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const configuredKey = process.env.GOOGLE_PLACES_SERVER_KEY?.trim();
  let safeValue = configuredKey ? value.replaceAll(configuredKey, "[redacted key]") : value;
  safeValue = safeValue
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[redacted key]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[redacted token]")
    .replace(/((?:[?&#]|\b)(?:x-goog-api-key|api[_\s-]?key|key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|client[_-]?secret|password)\s*[=:]\s*["']?)[^&#\s"'`,}]+/gi, "$1[redacted]")
    .replace(/\b(Authorization\s*[:=]\s*)(?:(?:Bearer|Basic)\s+)?[^,\s"'`}]+/gi, "$1[redacted]");
  return safeValue;
}

type GoogleErrorSanitizationBudget = {
  remainingNodes: number;
  remainingCharacters: number;
};

function sanitizeGoogleErrorValue(
  value: unknown,
  budget: GoogleErrorSanitizationBudget,
  depth = 0,
): unknown {
  if (budget.remainingNodes <= 0) return "[truncated: response size limit]";
  budget.remainingNodes -= 1;

  if (typeof value === "string") {
    const safeValue = redactGoogleErrorText(value) ?? "";
    if (safeValue.length <= budget.remainingCharacters) {
      budget.remainingCharacters -= safeValue.length;
      return safeValue;
    }
    const retained = Math.max(0, budget.remainingCharacters);
    budget.remainingCharacters = 0;
    return `${safeValue.slice(0, retained)}[truncated: response size limit]`;
  }
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 10) return "[truncated: maximum detail depth]";

  if (Array.isArray(value)) {
    const items = value.slice(0, 100).map((item) =>
      sanitizeGoogleErrorValue(item, budget, depth + 1),
    );
    if (value.length > items.length) items.push("[truncated: additional array items]");
    return items;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const safeObject: Record<string, unknown> = {};
    for (const [key, item] of entries.slice(0, 100)) {
      if (budget.remainingNodes <= 0) {
        safeObject["...truncated"] = "response size limit";
        break;
      }
      const safeKey = key.slice(0, 256);
      budget.remainingCharacters = Math.max(0, budget.remainingCharacters - safeKey.length);
      const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      safeObject[safeKey] = GOOGLE_SECRET_FIELD_NAMES.has(normalizedKey)
        ? "[redacted]"
        : sanitizeGoogleErrorValue(item, budget, depth + 1);
    }
    if (entries.length > 100) safeObject["...truncated"] = "additional object fields";
    return safeObject;
  }
  return String(value);
}

function findGoogleErrorReason(value: unknown, depth = 0): string | undefined {
  if (depth >= 10 || value == null || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const reason = findGoogleErrorReason(item, depth + 1);
      if (reason) return reason;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.reason === "string" && record.reason.trim()) return record.reason;
  for (const child of Object.values(record)) {
    const reason = findGoogleErrorReason(child, depth + 1);
    if (reason) return reason;
  }
  return undefined;
}

function googleErrorCategory(status: number, googleStatus?: string, message?: string): string {
  const text = `${googleStatus ?? ""} ${message ?? ""}`.toLowerCase();
  if (/org[_ -]?(policy|restriction)|organization[_ -]?policy/.test(text)) return "organization_policy";
  if (/consumer_invalid|project_not_found|wrong (cloud )?project|project mismatch|consumer.*mismatch/.test(text)) {
    return "wrong_consumer_project";
  }
  if (/api has not been used|api .* is disabled|has not been enabled|service_disabled/.test(text)) return "api_disabled";
  if (/billing|billingnotenabled/.test(text)) return "billing";
  if (/api[_ ]key.*(invalid|not valid)|invalid api key/.test(text)) return "invalid_key";
  if (/api[_ ]key.*(restriction|restricted|service_blocked)|referer|referrer|ip address|client is blocked/.test(text)) {
    return "key_restriction";
  }
  if (/quota|rate limit|resource_exhausted/.test(text) || status === 429) return "quota_or_rate_limit";
  if (/invalid_argument|malformed|parse error/.test(text) || status === 400) return "malformed_request";
  if (status === 401 || status === 403) return "permission_denied_unclassified";
  if (status >= 500) return "provider_server_error";
  return "provider_error";
}

async function googleErrorDetails(response: Response): Promise<{
  message?: string;
  category: string;
  responseBody?: string;
}> {
  let status: string | undefined;
  let message: string | undefined;
  let responseBody: string | undefined;
  try {
    const payload = await response.clone().json() as {
      error?: {
        code?: number;
        status?: string;
        message?: string;
        details?: unknown;
      };
    };
    status = payload.error?.status;
    const detailReason = findGoogleErrorReason(payload.error?.details);
    message = [payload.error?.message, detailReason].filter(Boolean).join(" · ");
    const safeMessage = redactGoogleErrorText(payload.error?.message);
    const detailsBudget = { remainingNodes: 800, remainingCharacters: 16_000 };
    const details = payload.error?.details === undefined
      ? undefined
      : sanitizeGoogleErrorValue(payload.error.details, detailsBudget);
    const safeBody = {
      error: {
        ...(payload.error?.code != null ? { code: payload.error.code } : {}),
        ...(status ? { status } : {}),
        ...(safeMessage ? { message: safeMessage.slice(0, 2_000) } : {}),
        ...(details !== undefined ? { details } : {}),
      },
    };
    // Preserve Google's complete structured detail shape, including Help links,
    // while redacting credentials and bounding pathological responses.
    responseBody = JSON.stringify(safeBody);
  } catch {
    // Some gateways return plain text; status and HTTP code remain useful.
  }
  return {
    message: redactGoogleErrorText(message)?.slice(0, 2_000),
    category: googleErrorCategory(response.status, status, message),
    responseBody,
  };
}

type GoogleAddressComponent = {
  longText?: string;
  shortText?: string;
  types?: string[];
  languageCode?: string;
};

export type GooglePlaceDetails = {
  placeId: string | null;
  displayName: string | null;
  formattedAddress: string | null;
  addressComponents: GoogleAddressComponent[];
  location: { latitude: number | null; longitude: number | null } | null;
  types: string[];
  primaryType: string | null;
  countryCode: string | null;
};

export type GooglePlaceSuggestion = {
  placeId: string;
  displayName: string;
  formattedAddress: string;
  types: string[];
};

export type GooglePlaceSearchResult = GooglePlaceSuggestion;

const nextAllowedRequest = new Map<ProviderName, number>();
const requestQueues = new Map<ProviderName, Promise<void>>();

function advanceProviderCooldown(
  provider: ProviderName,
  retryAfter: string | null | undefined,
  fallbackMs: number,
): number {
  let cooldownMs = fallbackMs;
  if (retryAfter) {
    const deltaSeconds = Number(retryAfter);
    if (Number.isFinite(deltaSeconds) && deltaSeconds >= 0) {
      cooldownMs = deltaSeconds * 1_000;
    } else {
      const retryDate = Date.parse(retryAfter);
      if (Number.isFinite(retryDate)) cooldownMs = Math.max(0, retryDate - Date.now());
    }
  }
  nextAllowedRequest.set(
    provider,
    Math.max(nextAllowedRequest.get(provider) ?? 0, Date.now() + cooldownMs),
  );
  return cooldownMs;
}

async function waitForProviderSlot(provider: ProviderName, minimumGapMs: number): Promise<void> {
  const prior = requestQueues.get(provider) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  requestQueues.set(provider, prior.then(() => current));
  await prior;
  while (true) {
    const waitMs = Math.max(0, (nextAllowedRequest.get(provider) ?? 0) - Date.now());
    if (waitMs <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  nextAllowedRequest.set(
    provider,
    Math.max(nextAllowedRequest.get(provider) ?? 0, Date.now() + minimumGapMs),
  );
  release();
}

async function requestWithRetries(
  provider: ProviderName,
  url: string,
  init: RequestInit,
  minimumGapMs: number,
  maxAttempts = 2,
  stage: MapProviderError["stage"] = "geocode",
  query?: string,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await waitForProviderSlot(provider, minimumGapMs);
    try {
      const response = await fetch(url, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(10_000),
      });
      if (response.ok) return response;
      const retryable = response.status === 429 || response.status >= 500;
      const code = response.status === 429 ? "rate_limited" : "upstream";
      const details = provider === "google_places"
        ? await googleErrorDetails(response)
        : undefined;
      lastError = new MapProviderError(
        provider,
        code,
        `${provider} returned HTTP ${response.status}`,
        retryable,
        response.status,
        response.headers?.get?.("retry-after"),
        stage,
        query,
        details?.message,
        details?.category,
        details?.responseBody,
      );
      if (response.status === 429) {
        advanceProviderCooldown(
          provider,
          response.headers?.get?.("retry-after"),
          process.env.NODE_ENV === "test" ? 0 : 250 * attempt,
        );
      } else if (retryable) {
        advanceProviderCooldown(
          provider,
          undefined,
          process.env.NODE_ENV === "test" ? 0 : 250 * attempt,
        );
      }
      if (!retryable || attempt === maxAttempts) throw lastError;
    } catch (error) {
      lastError = error;
      if (error instanceof MapProviderError && !error.retryable) throw error;
      if (attempt === maxAttempts) {
        throw error instanceof MapProviderError
          ? error
          : new MapProviderError(
              provider,
              "unavailable",
              `${provider} is unavailable: ${error instanceof Error ? error.message : String(error)}`,
              true,
              undefined,
              null,
              stage,
              query,
            );
      }
    }
  }
  throw lastError;
}

function googleKey(): string {
  const key = process.env.GOOGLE_PLACES_SERVER_KEY?.trim();
  if (!key) {
    throw new MapProviderError(
      "google_places",
      "not_configured",
      "Google Places integration is not configured on this server",
      false,
    );
  }
  return key;
}

export async function autocompleteGooglePlaces(options: {
  input: string;
  sessionToken?: string;
  latitude?: number;
  longitude?: number;
}): Promise<GooglePlaceSuggestion[]> {
  const body: Record<string, unknown> = {
    input: options.input,
    includedRegionCodes: ["LB"],
  };
  if (options.sessionToken) body.sessionToken = options.sessionToken;
  if (options.latitude != null && options.longitude != null) {
    body.locationBias = {
      circle: {
        center: { latitude: options.latitude, longitude: options.longitude },
        radius: 50_000,
      },
    };
  }
  const response = await requestWithRetries(
    "google_places",
    "https://places.googleapis.com/v1/places:autocomplete",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": googleKey(),
        "X-Goog-FieldMask":
          "suggestions.placePrediction.placeId,suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat,suggestions.placePrediction.types",
      },
      body: JSON.stringify(body),
    },
    25,
    2,
    "autocomplete",
    options.input,
  );
  const data = await response.json() as {
    error?: { status?: string };
    suggestions?: Array<{ placePrediction?: {
      placeId?: string;
      text?: { text?: string };
      structuredFormat?: { mainText?: { text?: string } };
      types?: string[];
    } }>;
  };
  if (data.error) {
    throw new MapProviderError("google_places", "invalid_response", `Google Places: ${data.error.status ?? "error"}`, false);
  }
  return (data.suggestions ?? []).flatMap(({ placePrediction: place }) =>
    place?.placeId
      ? [{
          placeId: place.placeId,
          displayName: place.structuredFormat?.mainText?.text ?? place.text?.text ?? "",
          formattedAddress: place.text?.text ?? "",
          types: place.types ?? [],
        }]
      : [],
  ).slice(0, 5);
}

/**
 * Search named delivery locations with Google Places Text Search (New).
 * Callers must fetch Place Details before accepting a candidate coordinate.
 */
export async function searchGooglePlacesText(options: {
  textQuery: string;
  regionCode?: string;
  pageSize?: number;
}): Promise<GooglePlaceSearchResult[]> {
  const body: Record<string, unknown> = {
    textQuery: options.textQuery,
    pageSize: Math.min(10, Math.max(1, options.pageSize ?? 5)),
    languageCode: "en",
  };
  if (options.regionCode && /^[A-Za-z]{2}$/.test(options.regionCode)) {
    body.regionCode = options.regionCode.toUpperCase();
  }
  const response = await requestWithRetries(
    "google_places",
    "https://places.googleapis.com/v1/places:searchText",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": googleKey(),
        "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.types",
      },
      body: JSON.stringify(body),
    },
    50,
    2,
    "text_search",
    options.textQuery,
  );
  let data: {
    error?: { status?: string; message?: string };
    places?: Array<{
      id?: string;
      displayName?: { text?: string };
      formattedAddress?: string;
      types?: string[];
    }>;
  };
  try {
    data = await response.json() as typeof data;
  } catch {
    throw new MapProviderError(
      "google_places",
      "invalid_response",
      "Google Places Text Search returned invalid JSON",
      false,
      undefined,
      null,
      "text_search",
    );
  }
  if (data.error) {
    throw new MapProviderError(
      "google_places",
      "invalid_response",
      `Google Places Text Search: ${data.error.status ?? data.error.message ?? "error"}`,
      false,
      undefined,
      null,
      "text_search",
    );
  }
  return (data.places ?? []).flatMap((place) =>
    place.id
      ? [{
          placeId: place.id,
          displayName: place.displayName?.text ?? "",
          formattedAddress: place.formattedAddress ?? "",
          types: place.types ?? [],
        }]
      : [],
  );
}

export async function getGooglePlaceDetails(
  placeId: string,
  sessionToken?: string,
): Promise<GooglePlaceDetails> {
  const headers: Record<string, string> = {
    "X-Goog-Api-Key": googleKey(),
    "X-Goog-FieldMask": "id,displayName,formattedAddress,addressComponents,location,types,primaryType",
  };
  if (sessionToken) headers["X-Goog-Session-Token"] = sessionToken;
  const response = await requestWithRetries(
    "google_places",
    `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`,
    { headers },
    25,
    2,
    "place_details",
    placeId,
  );
  const data = await response.json() as {
    error?: { status?: string };
    id?: string;
    displayName?: { text?: string };
    formattedAddress?: string;
    addressComponents?: GoogleAddressComponent[];
    location?: { latitude?: number; longitude?: number };
    types?: string[];
    primaryType?: string;
  };
  if (data.error) {
    throw new MapProviderError("google_places", "invalid_response", `Google Places: ${data.error.status ?? "error"}`, false);
  }
  const country = (data.addressComponents ?? []).find((component) => component.types?.includes("country"));
  return {
    placeId: data.id ?? null,
    displayName: data.displayName?.text ?? null,
    formattedAddress: data.formattedAddress ?? null,
    addressComponents: data.addressComponents ?? [],
    location: data.location
      ? {
          latitude: data.location.latitude ?? null,
          longitude: data.location.longitude ?? null,
        }
      : null,
    types: data.types ?? [],
    primaryType: data.primaryType ?? null,
    countryCode: country?.shortText?.trim().toUpperCase() ?? null,
  };
}

export async function getGooglePlaceCountryCode(placeId: string): Promise<string | null> {
  return (await getGooglePlaceDetails(placeId)).countryCode;
}

export async function searchNominatim<T>(
  query: string,
  options: { countryCode?: string; limit?: number } = {},
): Promise<T[]> {
  const params = new URLSearchParams({
    q: query,
    format: "json",
    limit: String(options.limit ?? 5),
    addressdetails: "1",
  });
  if (options.countryCode) params.set("countrycodes", options.countryCode.toLowerCase());
  const response = await requestWithRetries(
    "nominatim",
    `https://nominatim.openstreetmap.org/search?${params}`,
    {
      headers: {
        "User-Agent": "Presentail/1.0 (address-book auto-geocoder; contact@presentail.com)",
        Accept: "application/json",
      },
    },
    process.env.NODE_ENV === "test" ? 0 : 1_100,
    2,
    "geocode",
    query,
  );
  try {
    return await response.json() as T[];
  } catch (error) {
    logger.warn({ error, query }, "mapProvider: invalid Nominatim response");
    throw new MapProviderError(
      "nominatim",
      "invalid_response",
      "Nominatim returned invalid JSON",
      false,
      undefined,
      null,
      "geocode",
      query,
    );
  }
}

export interface ProviderDiagnostic {
  provider: ProviderName;
  endpoint: string;
  credentialSource: string;
  credentialFingerprint: string | null;
  configured: boolean;
  reachable: boolean;
  httpStatus: number | null;
  errorCategory: string | null;
  providerMessage: string | null;
  providerResponseBody: string | null;
  minimalTextSearch?: MinimalGoogleTextSearchDiagnostic;
  lastChecked: string;
}

export interface MinimalGoogleTextSearchDiagnostic {
  attempted: boolean;
  method: "POST";
  endpoint: string;
  authHeader: "X-Goog-Api-Key";
  fieldMask: string;
  textQuery: string;
  httpStatus: number | null;
  errorCategory: string | null;
  providerMessage: string | null;
  providerResponseBody: string | null;
}

const MINIMAL_GOOGLE_TEXT_SEARCH_QUERY = "Beirut, Lebanon";
const MINIMAL_GOOGLE_TEXT_SEARCH_FIELD_MASK =
  "places.id,places.displayName,places.formattedAddress,places.location";

async function diagnoseMinimalGoogleTextSearch(): Promise<MinimalGoogleTextSearchDiagnostic> {
  const endpoint = "https://places.googleapis.com/v1/places:searchText";
  const request = {
    attempted: true as const,
    method: "POST" as const,
    endpoint,
    authHeader: "X-Goog-Api-Key" as const,
    fieldMask: MINIMAL_GOOGLE_TEXT_SEARCH_FIELD_MASK,
    textQuery: MINIMAL_GOOGLE_TEXT_SEARCH_QUERY,
  };
  try {
    await requestWithRetries(
      "google_places",
      endpoint,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": googleKey(),
          "X-Goog-FieldMask": MINIMAL_GOOGLE_TEXT_SEARCH_FIELD_MASK,
        },
        body: JSON.stringify({ textQuery: MINIMAL_GOOGLE_TEXT_SEARCH_QUERY }),
      },
      50,
      1,
      "text_search",
      MINIMAL_GOOGLE_TEXT_SEARCH_QUERY,
    );
    return {
      ...request,
      httpStatus: 200,
      errorCategory: null,
      providerMessage: null,
      providerResponseBody: null,
    };
  } catch (error) {
    const providerError = error instanceof MapProviderError ? error : null;
    return {
      ...request,
      httpStatus: providerError?.upstreamStatus ?? null,
      errorCategory: providerError?.errorCategory ??
        (providerError?.code === "not_configured" ? "disabled_unconfigured" : "timeout_network"),
      providerMessage: providerError?.providerMessage ??
        (providerError ? null : "Minimal Text Search control failed before an HTTP response"),
      providerResponseBody: providerError?.providerResponseBody ?? null,
    };
  }
}

async function diagnoseProvider(provider: ProviderName): Promise<ProviderDiagnostic> {
  const lastChecked = new Date().toISOString();
  const googleCredential = provider === "google_places"
    ? process.env.GOOGLE_PLACES_SERVER_KEY?.trim()
    : undefined;
  const endpoint = provider === "google_places"
    ? "https://places.googleapis.com/v1/places:searchText"
    : "https://nominatim.openstreetmap.org/search";
  const credentialSource = provider === "google_places"
    ? "GOOGLE_PLACES_SERVER_KEY (server-side secret)"
    : "No credential required";
  const configured = provider === "google_places"
    ? Boolean(googleCredential)
    : true;
  const credentialFingerprint = googleCredential
    ? createHash("sha256").update(googleCredential).digest("hex").slice(0, 16)
    : null;
  if (!configured) {
    return {
      provider,
      endpoint,
      credentialSource,
      credentialFingerprint,
      configured,
      reachable: false,
      httpStatus: null,
      errorCategory: "disabled_unconfigured",
      providerMessage: null,
      providerResponseBody: null,
      ...(provider === "google_places"
        ? {
            minimalTextSearch: {
              attempted: false,
              method: "POST" as const,
              endpoint,
              authHeader: "X-Goog-Api-Key" as const,
              fieldMask: MINIMAL_GOOGLE_TEXT_SEARCH_FIELD_MASK,
              textQuery: MINIMAL_GOOGLE_TEXT_SEARCH_QUERY,
              httpStatus: null,
              errorCategory: "disabled_unconfigured",
              providerMessage: null,
              providerResponseBody: null,
            },
          }
        : {}),
      lastChecked,
    };
  }
  const minimalTextSearch = provider === "google_places"
    ? await diagnoseMinimalGoogleTextSearch()
    : undefined;
  try {
    if (provider === "google_places") {
      // Probe the same Places API (New) Text Search endpoint used by reverification.
      // Request only names/addresses; never return provider results or coordinates.
      await searchGooglePlacesText({
        textQuery: "Beirut, Lebanon",
        regionCode: "LB",
        pageSize: 1,
      });
    } else {
      // A single bounded public search confirms Nominatim is reachable without
      // sending any customer address or persisting the result.
      await searchNominatim("Beirut, Lebanon", { countryCode: "lb", limit: 1 });
    }
    return {
      provider,
      endpoint,
      credentialSource,
      credentialFingerprint,
      configured,
      reachable: true,
      httpStatus: 200,
      errorCategory: null,
      providerMessage: null,
      providerResponseBody: null,
      ...(minimalTextSearch ? { minimalTextSearch } : {}),
      lastChecked,
    };
  } catch (error) {
    const providerError = error instanceof MapProviderError ? error : null;
    return {
      provider,
      endpoint,
      credentialSource,
      credentialFingerprint,
      configured,
      reachable: false,
      httpStatus: providerError?.upstreamStatus ?? null,
      errorCategory: providerError?.errorCategory ??
        (providerError?.code === "not_configured" ? "disabled_unconfigured" : providerError?.failureType ?? "timeout_network"),
      providerMessage: providerError?.providerMessage ?? null,
      providerResponseBody: providerError?.providerResponseBody ?? null,
      ...(minimalTextSearch ? { minimalTextSearch } : {}),
      lastChecked,
    };
  }
}

export async function diagnoseMapProviders(): Promise<ProviderDiagnostic[]> {
  return Promise.all([
    diagnoseProvider("google_places"),
    diagnoseProvider("nominatim"),
  ]);
}