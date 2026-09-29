import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

const mockDbQuery = vi.fn();
const mockResolveApiKeyWorkspace = vi.fn();

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
  },
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
  workspace: (req: express.Request) => req,
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("../lib/apiKeyAuth", () => ({
  resolveApiKeyWorkspace: (...args: unknown[]) => mockResolveApiKeyWorkspace(...args),
}));

import { publicRouter } from "./settings-delivery";

// ---------------------------------------------------------------------------
// Test app
// ---------------------------------------------------------------------------

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (
      req as unknown as {
        log: { error: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; info: (...a: unknown[]) => void };
      }
    ).log = { error: () => {}, warn: () => {}, info: () => {} };
    next();
  });
  app.use(publicRouter);
  return app;
}

// ---------------------------------------------------------------------------
// Helpers — mirror the DB row shapes used by the route
// ---------------------------------------------------------------------------

/**
 * Mock calls for a successful GET /delivery-locations request when using a
 * ?workspace=user_XXX param (Clerk user ID — no slug lookup).
 *
 * Query order in the route:
 *   1. delivery_cities DISTINCT   (country codes — all cities, active or inactive)
 *   2. delivery_country_settings  (sort order + delivery_active per country)
 *   3. country_flag_overrides     (custom flag image URLs)
 *   4. delivery_cities            (full city rows, active and inactive)
 *   5. district_weekly_delivery_slots (only when cityIds non-empty — uses default mock fallback)
 */
function setupDeliveryLocationsMocks({
  deliverySettings = [{ country_code: "LB", delivery_sort_order: 0, delivery_active: true }],
  flagOverrides = [] as Array<{ country_code: string; image_url: string }>,
  cities = [
    { id: 1, country_code: "LB", name: "Beirut", slug: "beirut", sort_order: 0, is_active: true },
  ],
}: {
  deliverySettings?: Array<{ country_code: string; delivery_sort_order: number; delivery_active?: boolean }>;
  flagOverrides?: Array<{ country_code: string; image_url: string }>;
  cities?: Array<{ id: number; country_code: string; name: string; slug: string; sort_order: number; is_active: boolean }>;
} = {}) {
  const distinctCodes = [...new Set(cities.map((c) => c.country_code))];
  mockDbQuery
    .mockResolvedValueOnce({ rows: distinctCodes.map((c) => ({ country_code: c })), rowCount: distinctCodes.length })
    .mockResolvedValueOnce({ rows: deliverySettings, rowCount: deliverySettings.length })
    .mockResolvedValueOnce({ rows: flagOverrides, rowCount: flagOverrides.length })
    .mockResolvedValueOnce({ rows: cities, rowCount: cities.length });
}

/**
 * Mock calls for a slug-based workspace lookup followed by delivery data.
 * Prepends the workspace_settings slug lookup mock before the delivery data mocks.
 */
function setupSlugResolutionMocks(
  slug: string,
  ownerId: string,
  deliveryMockOpts?: Parameters<typeof setupDeliveryLocationsMocks>[0],
) {
  mockDbQuery.mockResolvedValueOnce({
    rows: [{ workspace_owner_id: ownerId }],
    rowCount: 1,
  });
  setupDeliveryLocationsMocks(deliveryMockOpts);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  mockResolveApiKeyWorkspace.mockResolvedValue(null);
});

describe("GET /delivery-locations", () => {
  it("returns 400 when the workspace query param is missing and no API key is provided", async () => {
    const res = await request(makeApp()).get("/delivery-locations");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/workspace/i);
  });

  it("returns 400 when an invalid API key is supplied and no ?workspace= param is present", async () => {
    mockResolveApiKeyWorkspace.mockResolvedValue(null);
    const res = await request(makeApp())
      .get("/delivery-locations")
      .set("Authorization", "Bearer pk_live_invalid_key");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/workspace/i);
  });

  it("resolves workspace from a valid API key without ?workspace= param", async () => {
    mockResolveApiKeyWorkspace.mockResolvedValue("owner_from_key");
    setupDeliveryLocationsMocks();

    const res = await request(makeApp())
      .get("/delivery-locations")
      .set("Authorization", "Bearer pk_live_somekey");
    expect(res.status).toBe(200);
    expect(res.body.countries).toHaveLength(1);
  });

  it("resolves workspace from x-api-key header", async () => {
    mockResolveApiKeyWorkspace.mockResolvedValue("owner_from_xkey");
    setupDeliveryLocationsMocks();

    const res = await request(makeApp())
      .get("/delivery-locations")
      .set("x-api-key", "pk_live_somekey");
    expect(res.status).toBe(200);
    expect(res.body.countries).toHaveLength(1);
    // Confirm resolveApiKeyWorkspace was called (it handles the x-api-key header internally)
    expect(mockResolveApiKeyWorkspace).toHaveBeenCalledTimes(1);
  });

  it("resolves workspace from ?apiKey= query parameter", async () => {
    mockResolveApiKeyWorkspace.mockResolvedValue("owner_from_queryparam");
    setupDeliveryLocationsMocks();

    const res = await request(makeApp()).get("/delivery-locations?apiKey=pk_live_somekey");
    expect(res.status).toBe(200);
    expect(res.body.countries).toHaveLength(1);
    expect(mockResolveApiKeyWorkspace).toHaveBeenCalledTimes(1);
  });

  it("returns 400 when ?apiKey= param is invalid and no ?workspace= is present", async () => {
    mockResolveApiKeyWorkspace.mockResolvedValue(null);
    const res = await request(makeApp()).get("/delivery-locations?apiKey=bad_key");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/workspace/i);
  });

  it("API key takes precedence over ?workspace= param when both are supplied", async () => {
    mockResolveApiKeyWorkspace.mockResolvedValue("owner_from_key");
    setupDeliveryLocationsMocks();

    const res = await request(makeApp())
      .get("/delivery-locations?workspace=user_from_param")
      .set("Authorization", "Bearer pk_live_somekey");
    expect(res.status).toBe(200);
    const flagQueryCall = mockDbQuery.mock.calls.find(
      ([sql]: [string]) =>
        typeof sql === "string" && sql.includes("country_flag_overrides"),
    );
    expect(flagQueryCall?.[1]).toContain("owner_from_key");
  });

  it("resolves workspace from a slug when ?workspace= is not a Clerk user ID", async () => {
    setupSlugResolutionMocks("presentail", "user_resolved_owner");

    const res = await request(makeApp()).get("/delivery-locations?workspace=presentail");
    expect(res.status).toBe(200);
    expect(res.body.countries).toHaveLength(1);
    // The slug lookup query must have been called with "presentail"
    const slugCall = mockDbQuery.mock.calls.find(
      ([sql]: [string]) =>
        typeof sql === "string" && sql.includes("workspace_slug"),
    );
    expect(slugCall).toBeDefined();
    expect(slugCall?.[1]).toEqual(["presentail"]);
  });

  it("returns 400 when the slug lookup finds no matching workspace", async () => {
    // Default mock returns { rows: [], rowCount: 0 } — slug not found
    const res = await request(makeApp()).get("/delivery-locations?workspace=unknown-slug");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/workspace/i);
  });

  it("uses ?workspace= as a direct Clerk user ID when it starts with user_", async () => {
    setupDeliveryLocationsMocks();

    const res = await request(makeApp()).get("/delivery-locations?workspace=user_direct_id");
    expect(res.status).toBe(200);
    // No slug lookup query should have run
    const slugCall = mockDbQuery.mock.calls.find(
      ([sql]: [string]) =>
        typeof sql === "string" && sql.includes("workspace_slug"),
    );
    expect(slugCall).toBeUndefined();
  });

  it("returns an empty countries array when no cities exist for the workspace", async () => {
    // delivery_cities DISTINCT returns no rows → early return with empty countries
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(makeApp()).get("/delivery-locations?workspace=user_1");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ countries: [] });
  });

  it("returns flag_image_url as null when no custom flag override is set", async () => {
    setupDeliveryLocationsMocks({ flagOverrides: [] });

    const res = await request(makeApp()).get("/delivery-locations?workspace=user_1");
    expect(res.status).toBe(200);
    expect(res.body.countries).toHaveLength(1);
    expect(res.body.countries[0].flag_image_url).toBeNull();
  });

  it("returns flag_image_url with the stored image URL when a custom flag override exists", async () => {
    setupDeliveryLocationsMocks({
      flagOverrides: [
        { country_code: "lb", image_url: "/api/storage/objects/user_1/uploads/lb-flag.svg" },
      ],
    });

    const res = await request(makeApp()).get("/delivery-locations?workspace=user_1");
    expect(res.status).toBe(200);
    expect(res.body.countries).toHaveLength(1);
    expect(res.body.countries[0].flag_image_url).toBe(
      "/api/storage/objects/user_1/uploads/lb-flag.svg",
    );
  });

  it("includes all required country fields alongside flag_image_url", async () => {
    setupDeliveryLocationsMocks();

    const res = await request(makeApp()).get("/delivery-locations?workspace=user_1");
    expect(res.status).toBe(200);
    const country = res.body.countries[0];
    expect(country).toMatchObject({
      country_code: "LB",
      name: expect.any(String),
      flag_emoji: expect.any(String),
      flag_image_url: null,
      delivery_sort_order: expect.any(Number),
      cities: expect.any(Array),
    });
  });

  it("includes integration contract fields id, code (lowercase) and isActive on each country", async () => {
    setupDeliveryLocationsMocks({
      deliverySettings: [{ country_code: "LB", delivery_sort_order: 0, delivery_active: true }],
    });

    const res = await request(makeApp()).get("/delivery-locations?workspace=user_1");
    expect(res.status).toBe(200);
    const country = res.body.countries[0];
    expect(country.id).toBe("lb");
    expect(country.code).toBe("lb");
    expect(country.isActive).toBe(true);
  });

  it("sets isActive to false on a country whose delivery_active is false", async () => {
    setupDeliveryLocationsMocks({
      deliverySettings: [{ country_code: "LB", delivery_sort_order: 0, delivery_active: false }],
    });

    const res = await request(makeApp()).get("/delivery-locations?workspace=user_1");
    expect(res.status).toBe(200);
    expect(res.body.countries[0].isActive).toBe(false);
  });

  it("defaults isActive to true on a country with no delivery_country_settings row", async () => {
    setupDeliveryLocationsMocks({
      deliverySettings: [], // no row for LB
    });

    const res = await request(makeApp()).get("/delivery-locations?workspace=user_1");
    expect(res.status).toBe(200);
    expect(res.body.countries[0].isActive).toBe(true);
  });

  it("includes city id (slug string) and isActive on each city", async () => {
    setupDeliveryLocationsMocks({
      cities: [
        { id: 1, country_code: "LB", name: "Beirut", slug: "beirut", sort_order: 0, is_active: true },
      ],
    });

    const res = await request(makeApp()).get("/delivery-locations?workspace=user_1");
    expect(res.status).toBe(200);
    const city = res.body.countries[0].cities[0];
    expect(city.id).toBe("beirut");
    expect(city.isActive).toBe(true);
  });

  it("sets city isActive to false when is_active is false", async () => {
    setupDeliveryLocationsMocks({
      cities: [
        { id: 1, country_code: "LB", name: "Tripoli", slug: "tripoli", sort_order: 0, is_active: false },
      ],
    });

    const res = await request(makeApp()).get("/delivery-locations?workspace=user_1");
    expect(res.status).toBe(200);
    const city = res.body.countries[0].cities[0];
    expect(city.id).toBe("tripoli");
    expect(city.isActive).toBe(false);
  });

  it("returns flag_image_url for the matching country and null for countries without an override", async () => {
    setupDeliveryLocationsMocks({
      deliverySettings: [
        { country_code: "LB", delivery_sort_order: 0 },
        { country_code: "AE", delivery_sort_order: 1 },
      ],
      flagOverrides: [
        { country_code: "ae", image_url: "/api/storage/objects/user_1/uploads/ae-flag.png" },
      ],
      cities: [
        { id: 1, country_code: "LB", name: "Beirut", slug: "beirut", sort_order: 0, is_active: true },
        { id: 2, country_code: "AE", name: "Dubai", slug: "dubai", sort_order: 0, is_active: true },
      ],
    });

    const res = await request(makeApp()).get("/delivery-locations?workspace=user_1");
    expect(res.status).toBe(200);
    expect(res.body.countries).toHaveLength(2);

    const lb = res.body.countries.find((c: { country_code: string }) => c.country_code === "LB");
    const ae = res.body.countries.find((c: { country_code: string }) => c.country_code === "AE");
    expect(lb?.flag_image_url).toBeNull();
    expect(ae?.flag_image_url).toBe("/api/storage/objects/user_1/uploads/ae-flag.png");
  });

  it("queries country_flag_overrides with the correct owner and active country codes", async () => {
    setupDeliveryLocationsMocks();

    await request(makeApp()).get("/delivery-locations?workspace=user_42");

    const flagQueryCall = mockDbQuery.mock.calls.find(
      ([sql]: [string]) =>
        typeof sql === "string" && sql.includes("country_flag_overrides"),
    );
    expect(flagQueryCall).toBeDefined();
    expect(flagQueryCall?.[1]).toContain("user_42");
  });

  it("includes is_active: true on an active city", async () => {
    setupDeliveryLocationsMocks();

    const res = await request(makeApp()).get("/delivery-locations?workspace=user_1");
    expect(res.status).toBe(200);
    const city = res.body.countries[0].cities[0];
    expect(city.is_active).toBe(true);
  });

  it("returns inactive cities with is_active: false alongside active ones", async () => {
    setupDeliveryLocationsMocks({
      deliverySettings: [{ country_code: "LB", delivery_sort_order: 0 }],
      cities: [
        { id: 1, country_code: "LB", name: "Beirut", slug: "beirut", sort_order: 0, is_active: true },
        { id: 2, country_code: "LB", name: "Tripoli", slug: "tripoli", sort_order: 1, is_active: false },
      ],
    });

    const res = await request(makeApp()).get("/delivery-locations?workspace=user_1");
    expect(res.status).toBe(200);
    expect(res.body.countries).toHaveLength(1);
    const cities: Array<{ name: string; is_active: boolean }> = res.body.countries[0].cities;
    expect(cities).toHaveLength(2);
    const beirut = cities.find((c) => c.name === "Beirut");
    const tripoli = cities.find((c) => c.name === "Tripoli");
    expect(beirut?.is_active).toBe(true);
    expect(tripoli?.is_active).toBe(false);
  });

  it("includes a country whose only cities are inactive", async () => {
    setupDeliveryLocationsMocks({
      deliverySettings: [{ country_code: "LB", delivery_sort_order: 0 }],
      cities: [
        { id: 1, country_code: "LB", name: "Beirut", slug: "beirut", sort_order: 0, is_active: false },
      ],
    });

    const res = await request(makeApp()).get("/delivery-locations?workspace=user_1");
    expect(res.status).toBe(200);
    expect(res.body.countries).toHaveLength(1);
    expect(res.body.countries[0].cities).toHaveLength(1);
    expect(res.body.countries[0].cities[0].is_active).toBe(false);
  });

  it("does not filter the country discovery query by is_active", async () => {
    setupDeliveryLocationsMocks();

    await request(makeApp()).get("/delivery-locations?workspace=user_1");

    const discoveryCall = mockDbQuery.mock.calls[0];
    const [sql] = discoveryCall as [string, unknown[]];
    expect(sql).not.toMatch(/is_active/);
  });

  it("slug lookup uses workspace_settings.workspace_slug column", async () => {
    setupSlugResolutionMocks("my-workspace", "user_abc");

    const res = await request(makeApp()).get("/delivery-locations?workspace=my-workspace");
    expect(res.status).toBe(200);
    const slugCall = mockDbQuery.mock.calls.find(
      ([sql]: [string]) =>
        typeof sql === "string" && sql.includes("workspace_settings") && sql.includes("workspace_slug"),
    );
    expect(slugCall).toBeDefined();
    expect(slugCall?.[1]).toEqual(["my-workspace"]);
    // Subsequent queries must use the resolved owner ID
    const flagCall = mockDbQuery.mock.calls.find(
      ([sql]: [string]) =>
        typeof sql === "string" && sql.includes("country_flag_overrides"),
    );
    expect(flagCall?.[1]).toContain("user_abc");
  });

  it("returns 200 with countries when country_flag_overrides query throws (table not yet created)", async () => {
    // Queries: 1=distinct codes, 2=settings, 3=flag overrides (throws), 4=cities, 5=slots (default empty)
    const distinctCodes = [{ country_code: "LB" }];
    const deliverySettings = [{ country_code: "LB", delivery_sort_order: 0, delivery_active: true }];
    const cities = [
      { id: 1, country_code: "LB", name: "Beirut", slug: "beirut", sort_order: 0, is_active: true },
    ];
    mockDbQuery
      .mockResolvedValueOnce({ rows: distinctCodes, rowCount: 1 })
      .mockResolvedValueOnce({ rows: deliverySettings, rowCount: 1 })
      .mockRejectedValueOnce(new Error('relation "country_flag_overrides" does not exist'))
      .mockResolvedValueOnce({ rows: cities, rowCount: 1 });

    const res = await request(makeApp()).get("/delivery-locations?workspace=user_1");
    expect(res.status).toBe(200);
    expect(res.body.countries).toHaveLength(1);
    expect(res.body.countries[0].flag_image_url).toBeNull();
    expect(res.body.countries[0].cities).toHaveLength(1);
  });

  it("returns 200 with countries when district_weekly_delivery_slots query throws (table not yet created)", async () => {
    setupDeliveryLocationsMocks();
    // Override the default catch-all so the slots query (5th call) throws
    mockDbQuery.mockRejectedValueOnce(new Error('relation "district_weekly_delivery_slots" does not exist'));

    const res = await request(makeApp()).get("/delivery-locations?workspace=user_1");
    expect(res.status).toBe(200);
    expect(res.body.countries).toHaveLength(1);
    expect(res.body.countries[0].cities[0].delivery_slots).toEqual([]);
  });
});
