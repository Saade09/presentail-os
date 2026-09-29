import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — declared before importing the module under test
// ---------------------------------------------------------------------------

const mockDbQuery = vi.fn();

vi.mock("./db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
  },
}));

vi.mock("./logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("./publicWebhookFetch", () => ({
  publicWebhookFetch: (...args: unknown[]) => fetch(...args as [string, RequestInit]),
}));

vi.mock("./defaults", () => ({
  DEFAULT_COUNTRIES: ["Lebanon"],
  isExcludedCountry: (_name: string) => false,
  getCountryMetadata: (name: string) => {
    if (name === "Lebanon") return { code: "lb", name: "Lebanon", flagEmoji: "🇱🇧", currency: "LBP" };
    return null;
  },
  getCountryMetadataByCode: (code: string) => {
    if (code === "LB") return { code: "lb", name: "Lebanon", flagEmoji: "🇱🇧", currency: "LBP" };
    return null;
  },
}));

import { createHmac } from "node:crypto";
import {
  buildDeliveryLocationsPayload,
  buildOsDeliveryConfigCountries,
  fireOsDeliveryConfigWebhook,
} from "./deliveryWebhook";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const OWNER = "user_test_owner";

const CITY_ROW = {
  id: 1,
  country_code: "LB",
  name: "Beirut",
  slug: "beirut",
  sort_order: 0,
  is_active: true,
  delivery_fee: "5.00",
  free_delivery_enabled: false,
  free_delivery_threshold: null,
  express_delivery_enabled: false,
  express_delivery_fee: null,
  express_delivery_cutoff_time: null,
  updated_at: "2024-01-01T00:00:00.000Z",
};

const SLOT_ROW: {
  city_id: number;
  id: number;
  day_of_week: number;
  label: string;
  start_time: string;
  end_time: string;
  fee_override: string | null;
  cutoff_time: string | null;
  capacity: number | null;
  sort_order: number;
} = {
  city_id: 1,
  id: 10,
  day_of_week: 1,
  label: "Morning",
  start_time: "08:00",
  end_time: "12:00",
  fee_override: "2.50",
  cutoff_time: "07:00",
  capacity: 20,
  sort_order: 0,
};

/**
 * Sets up the standard sequence of mock DB calls used by
 * buildDeliveryLocationsPayload:
 *   1. workspace_settings   → available_countries
 *   2. delivery_country_settings → active codes
 *   3. country_flag_overrides  (try/catch)
 *   4. delivery_cities
 *   5. district_weekly_delivery_slots (try/catch, only if cities non-empty)
 */
function setupHappyPath({
  slots = [SLOT_ROW],
}: { slots?: typeof SLOT_ROW[] } = {}) {
  mockDbQuery
    // 1. workspace_settings
    .mockResolvedValueOnce({ rows: [{ available_countries: ["Lebanon"] }], rowCount: 1 })
    // 2. delivery_country_settings
    .mockResolvedValueOnce({
      rows: [{ country_code: "LB", delivery_sort_order: 0, updated_at: "2024-01-01T00:00:00.000Z" }],
      rowCount: 1,
    })
    // 3. country_flag_overrides
    .mockResolvedValueOnce({ rows: [], rowCount: 0 })
    // 4. delivery_cities
    .mockResolvedValueOnce({ rows: [CITY_ROW], rowCount: 1 })
    // 5. district_weekly_delivery_slots
    .mockResolvedValueOnce({ rows: slots, rowCount: slots.length });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe("buildDeliveryLocationsPayload", () => {
  it("returns countries with cities and delivery_slots on the happy path", async () => {
    setupHappyPath();

    const { countries } = await buildDeliveryLocationsPayload(OWNER);

    expect(countries).toHaveLength(1);
    const country = countries[0] as {
      country_code: string;
      cities: Array<{ id: number; delivery_slots: unknown[] }>;
    };
    expect(country.country_code).toBe("LB");
    expect(country.cities).toHaveLength(1);
    const city = country.cities[0];
    expect(city.delivery_slots).toHaveLength(1);
    expect(city.delivery_slots[0]).toMatchObject({
      id: 10,
      day_of_week: 1,
      label: "Morning",
      start_time: "08:00",
      end_time: "12:00",
      fee_override: 2.5,
      cutoff_time: "07:00",
      capacity: 20,
      sort_order: 0,
    });
  });

  it("returns empty delivery_slots when district_weekly_delivery_slots query throws (table not yet created)", async () => {
    mockDbQuery
      // 1. workspace_settings
      .mockResolvedValueOnce({ rows: [{ available_countries: ["Lebanon"] }], rowCount: 1 })
      // 2. delivery_country_settings
      .mockResolvedValueOnce({
        rows: [{ country_code: "LB", delivery_sort_order: 0, updated_at: "2024-01-01T00:00:00.000Z" }],
        rowCount: 1,
      })
      // 3. country_flag_overrides
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      // 4. delivery_cities
      .mockResolvedValueOnce({ rows: [CITY_ROW], rowCount: 1 })
      // 5. district_weekly_delivery_slots — table missing
      .mockRejectedValueOnce(new Error('relation "district_weekly_delivery_slots" does not exist'));

    const { countries } = await buildDeliveryLocationsPayload(OWNER);

    expect(countries).toHaveLength(1);
    const country = countries[0] as {
      cities: Array<{ delivery_slots: unknown[] }>;
    };
    expect(country.cities).toHaveLength(1);
    expect(country.cities[0].delivery_slots).toEqual([]);
  });

  it("skips the slots query entirely when there are no cities", async () => {
    mockDbQuery
      // 1. workspace_settings
      .mockResolvedValueOnce({ rows: [{ available_countries: ["Lebanon"] }], rowCount: 1 })
      // 2. delivery_country_settings — no active countries
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const { countries } = await buildDeliveryLocationsPayload(OWNER);

    expect(countries).toEqual([]);
    // Only 2 DB calls were made (workspace_settings + delivery_country_settings)
    expect(mockDbQuery).toHaveBeenCalledTimes(2);
  });

  it("returns empty delivery_slots when no slots exist for the city", async () => {
    setupHappyPath({ slots: [] });

    const { countries } = await buildDeliveryLocationsPayload(OWNER);

    const country = countries[0] as {
      cities: Array<{ delivery_slots: unknown[] }>;
    };
    expect(country.cities[0].delivery_slots).toEqual([]);
  });

  it("still returns countries and cities even when country_flag_overrides throws", async () => {
    mockDbQuery
      // 1. workspace_settings
      .mockResolvedValueOnce({ rows: [{ available_countries: ["Lebanon"] }], rowCount: 1 })
      // 2. delivery_country_settings
      .mockResolvedValueOnce({
        rows: [{ country_code: "LB", delivery_sort_order: 0, updated_at: "2024-01-01T00:00:00.000Z" }],
        rowCount: 1,
      })
      // 3. country_flag_overrides — table missing
      .mockRejectedValueOnce(new Error('relation "country_flag_overrides" does not exist'))
      // 4. delivery_cities
      .mockResolvedValueOnce({ rows: [CITY_ROW], rowCount: 1 })
      // 5. district_weekly_delivery_slots
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const { countries } = await buildDeliveryLocationsPayload(OWNER);

    expect(countries).toHaveLength(1);
    const country = countries[0] as {
      flag_image_url: string | null;
      cities: Array<{ delivery_slots: unknown[] }>;
    };
    expect(country.flag_image_url).toBeNull();
    expect(country.cities).toHaveLength(1);
  });

  it("parses fee_override as a float number", async () => {
    setupHappyPath({ slots: [{ ...SLOT_ROW, fee_override: "3.75" }] });

    const { countries } = await buildDeliveryLocationsPayload(OWNER);

    const country = countries[0] as {
      cities: Array<{ delivery_slots: Array<{ fee_override: number | null }> }>;
    };
    expect(country.cities[0].delivery_slots[0].fee_override).toBe(3.75);
  });

  it("sets fee_override to null when the DB value is null", async () => {
    setupHappyPath({ slots: [{ ...SLOT_ROW, fee_override: null }] });

    const { countries } = await buildDeliveryLocationsPayload(OWNER);

    const country = countries[0] as {
      cities: Array<{ delivery_slots: Array<{ fee_override: number | null }> }>;
    };
    expect(country.cities[0].delivery_slots[0].fee_override).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildOsDeliveryConfigCountries
// ---------------------------------------------------------------------------

type OsCity = {
  slug: string;
  name: string;
  is_active: boolean;
  delivery_fee: number;
  express_available: boolean;
  express_fee: number;
  express_cutoff_hour: number | null;
  free_delivery_threshold: number;
  free_delivery_enabled: boolean;
  delivery_slots: Array<{
    label: string;
    start_time: string;
    end_time: string;
    cutoff_hour: number | null;
    extra_fee: number;
  }>;
};
type OsCountry = { code: string; name: string; is_active: boolean; cities: OsCity[] };

function builtCountry(overrides: Record<string, unknown> = {}) {
  return {
    country_code: "LB",
    name: "Lebanon",
    cities: [
      {
        name: "Beirut",
        slug: "beirut",
        is_active: true,
        delivery_fee: 7,
        free_delivery_enabled: true,
        free_delivery_threshold: 90,
        express_delivery_enabled: true,
        express_delivery_fee: 12,
        express_delivery_cutoff_time: "14:30:00",
        delivery_slots: [
          { label: "Morning", start_time: "10:00:00", end_time: "12:00:00", fee_override: null, cutoff_time: null },
          { label: "Evening", start_time: "18:00:00", end_time: "20:00:00", fee_override: 5, cutoff_time: "16:00:00" },
        ],
      },
    ],
    ...overrides,
  };
}

describe("buildOsDeliveryConfigCountries", () => {
  it("maps the internal payload to the OS contract shape", () => {
    const result = buildOsDeliveryConfigCountries([builtCountry()]) as OsCountry[];
    expect(result).toHaveLength(1);
    const country = result[0];
    expect(country).toMatchObject({ code: "LB", name: "Lebanon", is_active: true });
    expect(country.cities).toHaveLength(1);
    expect(country.cities[0]).toMatchObject({
      slug: "beirut",
      name: "Beirut",
      is_active: true,
      delivery_fee: 7,
      express_available: true,
      express_fee: 12,
      express_cutoff_hour: 14,
      free_delivery_threshold: 90,
      free_delivery_enabled: true,
    });
  });

  it("defaults express_fee to 0 and express_cutoff_hour to null when express data is absent", () => {
    const country = builtCountry({
      cities: [
        {
          name: "Tripoli",
          slug: "tripoli",
          is_active: true,
          delivery_fee: 7,
          free_delivery_enabled: true,
          free_delivery_threshold: 90,
          express_delivery_enabled: false,
          express_delivery_fee: null,
          express_delivery_cutoff_time: null,
          delivery_slots: [],
        },
      ],
    });
    const result = buildOsDeliveryConfigCountries([country]) as OsCountry[];
    expect(result[0].cities[0]).toMatchObject({ express_fee: 0, express_cutoff_hour: null });
  });

  it("normalizes times to HH:MM, derives cutoff_hour, and defaults extra_fee to 0", () => {
    const result = buildOsDeliveryConfigCountries([builtCountry()]) as OsCountry[];
    const slots = result[0].cities[0].delivery_slots;
    expect(slots[0]).toEqual({ label: "Morning", start_time: "10:00", end_time: "12:00", cutoff_hour: null, extra_fee: 0 });
    expect(slots[1]).toEqual({ label: "Evening", start_time: "18:00", end_time: "20:00", cutoff_hour: 16, extra_fee: 5 });
  });

  it("de-duplicates identical slots that repeat across weekdays", () => {
    const country = builtCountry();
    // Same slot definition appearing for multiple days of the week.
    country.cities[0].delivery_slots = [
      { label: "Morning", start_time: "10:00", end_time: "12:00", fee_override: null, cutoff_time: null },
      { label: "Morning", start_time: "10:00", end_time: "12:00", fee_override: null, cutoff_time: null },
      { label: "Morning", start_time: "10:00", end_time: "12:00", fee_override: null, cutoff_time: null },
    ];
    const result = buildOsDeliveryConfigCountries([country]) as OsCountry[];
    expect(result[0].cities[0].delivery_slots).toHaveLength(1);
  });

  it("sorts slots by start_time", () => {
    const country = builtCountry();
    country.cities[0].delivery_slots = [
      { label: "Evening", start_time: "18:00", end_time: "20:00", fee_override: null, cutoff_time: null },
      { label: "Morning", start_time: "09:00", end_time: "11:00", fee_override: null, cutoff_time: null },
    ];
    const result = buildOsDeliveryConfigCountries([country]) as OsCountry[];
    const labels = result[0].cities[0].delivery_slots.map((s) => s.label);
    expect(labels).toEqual(["Morning", "Evening"]);
  });

  it("defaults free_delivery_threshold to 0 when null", () => {
    const country = builtCountry();
    country.cities[0].free_delivery_threshold = null as unknown as number;
    const result = buildOsDeliveryConfigCountries([country]) as OsCountry[];
    expect(result[0].cities[0].free_delivery_threshold).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// fireOsDeliveryConfigWebhook
// ---------------------------------------------------------------------------

describe("fireOsDeliveryConfigWebhook", () => {
  const ORIGINAL_SECRET = process.env.PRESENTAIL_OS_WEBHOOK_SECRET;
  const ORIGINAL_URL = process.env.OS_DELIVERY_WEBHOOK_URL;

  beforeEach(() => {
    process.env.OS_DELIVERY_WEBHOOK_URL = "https://example.test/os/webhook";
  });

  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) delete process.env.PRESENTAIL_OS_WEBHOOK_SECRET;
    else process.env.PRESENTAIL_OS_WEBHOOK_SECRET = ORIGINAL_SECRET;
    if (ORIGINAL_URL === undefined) delete process.env.OS_DELIVERY_WEBHOOK_URL;
    else process.env.OS_DELIVERY_WEBHOOK_URL = ORIGINAL_URL;
    vi.unstubAllGlobals();
  });

  it("no-ops and returns false when the secret is not configured", async () => {
    delete process.env.PRESENTAIL_OS_WEBHOOK_SECRET;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const ok = await fireOsDeliveryConfigWebhook([builtCountry()]);

    expect(ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts a signed full-snapshot payload when the secret is set", async () => {
    process.env.PRESENTAIL_OS_WEBHOOK_SECRET = "shh-secret";
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => "ok" });
    vi.stubGlobal("fetch", fetchMock);

    const ok = await fireOsDeliveryConfigWebhook([builtCountry()]);

    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.test/os/webhook");
    expect(init.method).toBe("POST");

    const headers = init.headers as Record<string, string>;
    expect(headers["x-presentail-event"]).toBe("delivery_config.updated");
    expect(headers["x-presentail-delivery-id"]).toBeTruthy();
    expect(headers["x-presentail-timestamp"]).toMatch(/^\d+$/);

    const body = init.body as string;
    const parsed = JSON.parse(body);
    expect(parsed.event).toBe("delivery_config.updated");
    expect(parsed.data.countries[0].code).toBe("LB");

    // Signature must match HMAC-SHA256("{delivery-id}.{timestamp}.{raw body}", secret).
    const expected =
      "sha256=" +
      createHmac("sha256", "shh-secret")
        .update(`${headers["x-presentail-delivery-id"]}.${headers["x-presentail-timestamp"]}.${body}`)
        .digest("hex");
    expect(headers["x-presentail-signature"]).toBe(expected);
  });

  it("retries on non-2xx, honoring every configured backoff delay, then returns false", async () => {
    process.env.PRESENTAIL_OS_WEBHOOK_SECRET = "shh-secret";
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "err" });
    vi.stubGlobal("fetch", fetchMock);

    const promise = fireOsDeliveryConfigWebhook([builtCountry()]);
    await vi.runAllTimersAsync();
    const ok = await promise;

    expect(ok).toBe(false);
    // 1 initial attempt + 3 configured backoff delays = 4 total attempts.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    vi.useRealTimers();
  });

  it("refuses to POST to a non-public / non-HTTPS override URL", async () => {
    process.env.PRESENTAIL_OS_WEBHOOK_SECRET = "shh-secret";
    process.env.OS_DELIVERY_WEBHOOK_URL = "http://localhost:9999/os/webhook";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const ok = await fireOsDeliveryConfigWebhook([builtCountry()]);

    expect(ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
