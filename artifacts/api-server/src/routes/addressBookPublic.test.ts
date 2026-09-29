import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const { mockDbQuery } = vi.hoisted(() => ({
  mockDbQuery: vi.fn(),
}));

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
  },
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { mockResolveApiKeyWorkspace } = vi.hoisted(() => ({
  mockResolveApiKeyWorkspace: vi.fn(),
}));

vi.mock("../lib/apiKeyAuth", () => ({
  resolveApiKeyWorkspace: (...args: unknown[]) => mockResolveApiKeyWorkspace(...args),
}));

import addressBookPublicRouter from "./addressBookPublic";

const PLACE_ROW = {
  id: "00000000-0000-4000-8000-000000000001",
  canonical_name: "AUB Medical Center",
  area: "Hamra",
  place_type: "landmark",
  city_name: "Beirut",
  latitude: "33.9",
  longitude: "35.47",
  verification_state: "staff_verified",
};

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api", addressBookPublicRouter);
  return app;
}

describe("GET /api/address-book/places/search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockResolveApiKeyWorkspace.mockReset();
  });

  it("returns 401 when no API key is present", async () => {
    mockResolveApiKeyWorkspace.mockResolvedValue(null);

    const response = await request(makeApp())
      .get("/api/address-book/places/search")
      .query({ q: "AUB" });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: "API key required" });
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns 401 when the API key resolves to no workspace", async () => {
    mockResolveApiKeyWorkspace.mockResolvedValue(null);

    const response = await request(makeApp())
      .get("/api/address-book/places/search")
      .set("x-api-key", "pk_live_unknownkey")
      .query({ q: "AUB" });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: "API key required" });
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns empty places list when q is absent", async () => {
    mockResolveApiKeyWorkspace.mockResolvedValue("workspace_1");

    const response = await request(makeApp())
      .get("/api/address-book/places/search")
      .set("x-api-key", "pk_live_validkey");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ places: [] });
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns empty places list when q is blank whitespace", async () => {
    mockResolveApiKeyWorkspace.mockResolvedValue("workspace_1");

    const response = await request(makeApp())
      .get("/api/address-book/places/search")
      .set("x-api-key", "pk_live_validkey")
      .query({ q: "   " });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ places: [] });
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("returns matching places in camelCase shape with a valid API key", async () => {
    mockResolveApiKeyWorkspace.mockResolvedValue("workspace_1");
    mockDbQuery.mockResolvedValue({ rows: [PLACE_ROW], rowCount: 1 });

    const response = await request(makeApp())
      .get("/api/address-book/places/search")
      .set("x-api-key", "pk_live_validkey")
      .query({ q: "AUB" });

    expect(response.status).toBe(200);
    expect(response.body.places).toHaveLength(1);
    expect(response.body.places[0]).toMatchObject({
      id: PLACE_ROW.id,
      canonicalName: PLACE_ROW.canonical_name,
      area: PLACE_ROW.area,
      type: PLACE_ROW.place_type,
      cityName: PLACE_ROW.city_name,
      latitude: 33.9,
      longitude: 35.47,
      verificationState: PLACE_ROW.verification_state,
    });
  });

  it("passes workspace owner ID and ILIKE pattern to the DB query", async () => {
    mockResolveApiKeyWorkspace.mockResolvedValue("workspace_1");
    mockDbQuery.mockResolvedValue({ rows: [PLACE_ROW], rowCount: 1 });

    await request(makeApp())
      .get("/api/address-book/places/search")
      .set("x-api-key", "pk_live_validkey")
      .query({ q: "AUB" });

    expect(mockDbQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual(["workspace_1", "%AUB%"]);
    expect(sql).toContain("p.workspace_owner_id = $1");
    expect(sql).toContain("p.archived_at IS NULL");
    expect(sql).toContain("p.canonical_name ILIKE $2");
    expect(sql).toContain("pa.alias_text ILIKE $2");
    expect(sql).toContain("LIMIT 20");
  });

  it("escapes ILIKE wildcard characters in the search term", async () => {
    mockResolveApiKeyWorkspace.mockResolvedValue("workspace_1");
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const response = await request(makeApp())
      .get("/api/address-book/places/search")
      .set("x-api-key", "pk_live_validkey")
      .query({ q: "100%_\\test" });

    expect(response.status).toBe(200);
    const [, params] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    expect(params[1]).toBe("%100\\%\\_\\\\test%");
  });

  it("returns null latitude/longitude when coordinates are absent", async () => {
    mockResolveApiKeyWorkspace.mockResolvedValue("workspace_1");
    mockDbQuery.mockResolvedValue({
      rows: [{ ...PLACE_ROW, latitude: null, longitude: null, city_name: null }],
      rowCount: 1,
    });

    const response = await request(makeApp())
      .get("/api/address-book/places/search")
      .set("x-api-key", "pk_live_validkey")
      .query({ q: "AUB" });

    expect(response.status).toBe(200);
    expect(response.body.places[0]).toMatchObject({
      latitude: null,
      longitude: null,
      cityName: null,
    });
  });
});
