import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

const mockDbQuery = vi.fn();

vi.mock("../lib/db", () => ({
  db: { query: (...args: unknown[]) => mockDbQuery(...args) },
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const mockResolveApiKeyWorkspace = vi.fn();

vi.mock("../lib/apiKeyAuth", () => ({
  resolveApiKeyWorkspace: (...args: unknown[]) => mockResolveApiKeyWorkspace(...args),
}));

import router from "./deliveryCatalog";

// ---------------------------------------------------------------------------
// Test app
// ---------------------------------------------------------------------------

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: Record<string, unknown> }).log = {
      error: () => {},
      warn: () => {},
      info: () => {},
    };
    next();
  });
  app.use("/api", router);
  return app;
}

const OWNER_ID = "user_abc";
const WORKSPACE_PARAM = `?workspace=${OWNER_ID}`;

// Minimal DB mock helpers
function stubCities(rows: unknown[] = []) {
  mockDbQuery.mockResolvedValueOnce({ rows, rowCount: rows.length });
}
function stubEmptyCities() {
  mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
}
function stubSlots(rows: unknown[] = []) {
  mockDbQuery.mockResolvedValueOnce({ rows, rowCount: rows.length });
}
function stubOverrides(rows: unknown[] = []) {
  mockDbQuery.mockResolvedValueOnce({ rows, rowCount: rows.length });
}
function stubOverrideSlots(rows: unknown[] = []) {
  mockDbQuery.mockResolvedValueOnce({ rows, rowCount: rows.length });
}

beforeEach(() => {
  vi.resetAllMocks();
  mockResolveApiKeyWorkspace.mockResolvedValue(null);
});

// ---------------------------------------------------------------------------
// Auth resolution
// ---------------------------------------------------------------------------

describe("GET /api/delivery-catalog — auth", () => {
  it("returns 401 when no API key and no workspace param", async () => {
    const res = await request(makeApp()).get("/api/delivery-catalog");
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/API key or workspace/i);
  });

  it("resolves workspace from direct user_ param", async () => {
    stubEmptyCities();
    const res = await request(makeApp()).get(`/api/delivery-catalog?workspace=${OWNER_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.cities).toEqual([]);
  });

  it("resolves workspace from workspace slug param", async () => {
    // First db call resolves slug → owner_id
    mockDbQuery.mockResolvedValueOnce({ rows: [{ workspace_owner_id: OWNER_ID }], rowCount: 1 });
    // Then cities call returns empty
    stubEmptyCities();
    const res = await request(makeApp()).get("/api/delivery-catalog?workspace=my-shop");
    expect(res.status).toBe(200);
  });

  it("resolves workspace from API key", async () => {
    mockResolveApiKeyWorkspace.mockResolvedValue(OWNER_ID);
    stubEmptyCities();
    const res = await request(makeApp())
      .get("/api/delivery-catalog")
      .set("Authorization", "Bearer pk_live_test");
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Response shape
// ---------------------------------------------------------------------------

describe("GET /api/delivery-catalog — response shape", () => {
  const CITY = {
    id: 1,
    name: "Beirut",
    slug: "beirut",
    country_code: "lb",
    sort_order: 0,
    is_active: true,
    delivery_fee: "5.00",
    free_delivery_enabled: false,
    free_delivery_threshold: null,
    express_delivery_enabled: true,
    express_delivery_fee: "15.00",
    express_delivery_cutoff_time: "14:00",
  };

  const SLOT = {
    city_id: 1,
    id: 10,
    day_of_week: 1,
    start_time: "09:00",
    end_time: "13:00",
    label: "Morning",
    is_enabled: true,
    delivery_type: "standard",
    fee_override: null,
    capacity: null,
    sort_order: 1,
  };

  const OVERRIDE = {
    id: 5,
    city_id: 1,
    name: "Christmas",
    start_date: "2026-12-24",
    end_date: "2026-12-26",
    override_type: "holiday",
    is_active: true,
  };

  const OVERRIDE_SLOT = {
    override_id: 5,
    id: 20,
    label: "Morning",
    start_time: "10:00",
    end_time: "14:00",
    is_enabled: true,
    fee_override: "5.00",
    cutoff_time: "12:00",
    capacity: 10,
    sort_order: 1,
  };

  it("returns cities with timeslots and empty special_overrides", async () => {
    stubCities([CITY]);
    stubSlots([SLOT]);
    stubOverrides([]);

    const res = await request(makeApp()).get(`/api/delivery-catalog?workspace=${OWNER_ID}`);
    expect(res.status).toBe(200);
    const city = res.body.cities[0];
    expect(city.slug).toBe("beirut");
    expect(city.delivery_fee).toBe(5.0);
    expect(city.express_delivery_fee).toBe(15.0);
    expect(city.timeslots).toHaveLength(1);
    expect(city.timeslots[0].label).toBe("Morning");
    expect(city.special_overrides).toEqual([]);
  });

  it("includes override slots nested inside special_overrides", async () => {
    stubCities([CITY]);
    stubSlots([]);
    stubOverrides([OVERRIDE]);
    stubOverrideSlots([OVERRIDE_SLOT]);

    const res = await request(makeApp()).get(`/api/delivery-catalog?workspace=${OWNER_ID}`);
    expect(res.status).toBe(200);
    const override = res.body.cities[0].special_overrides[0];
    expect(override.id).toBe(5);
    expect(override.name).toBe("Christmas");
    expect(override.slots).toHaveLength(1);
    const slot = override.slots[0];
    expect(slot.id).toBe(20);
    expect(slot.label).toBe("Morning");
    expect(slot.fee_override).toBe(5.0);
    expect(slot.cutoff_time).toBe("12:00");
    expect(slot.capacity).toBe(10);
  });

  it("returns numeric delivery_fee (not string)", async () => {
    stubCities([CITY]);
    stubSlots([]);
    stubOverrides([]);

    const res = await request(makeApp()).get(`/api/delivery-catalog?workspace=${OWNER_ID}`);
    const city = res.body.cities[0];
    expect(typeof city.delivery_fee).toBe("number");
    expect(typeof city.express_delivery_fee).toBe("number");
  });

  it("returns empty cities array when workspace has no active cities", async () => {
    stubEmptyCities();
    const res = await request(makeApp()).get(`/api/delivery-catalog${WORKSPACE_PARAM}`);
    expect(res.status).toBe(200);
    expect(res.body.cities).toEqual([]);
  });
});
