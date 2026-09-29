import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

// ---------------------------------------------------------------------------
// Mocks
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
  authed: (req: express.Request) => req,
}));

let stubWorkspaceOwnerId = "owner_123";
let stubWorkspaceRole: "owner" | "member" = "owner";

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = stubWorkspaceOwnerId;
    wreq.workspaceRole = stubWorkspaceRole;
    wreq.workspaceActualRole = stubWorkspaceRole;
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

vi.mock("../lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("../lib/apiKeyAuth", () => ({
  resolveApiKeyWorkspace: (...args: unknown[]) => mockResolveApiKeyWorkspace(...args),
}));

import { adminRouter, publicRouter } from "./settings-delivery";

function silentLog(req: express.Request, _res: express.Response, next: express.NextFunction) {
  (req as unknown as { log: { error: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; info: (...a: unknown[]) => void } }).log = {
    error: () => {},
    warn: () => {},
    info: () => {},
  };
  next();
}

function makeAdminApp() {
  const app = express();
  app.use(express.json());
  app.use(silentLog);
  app.use(adminRouter);
  return app;
}

function makePublicApp() {
  const app = express();
  app.use(express.json());
  app.use(silentLog);
  app.use(publicRouter);
  return app;
}

// Helper: mock the leading SELECT available_countries call.
function mockAvailableCountries(countries: string[]) {
  mockDbQuery.mockResolvedValueOnce({
    rows: [{ available_countries: countries }],
    rowCount: 1,
  });
}

// ---------------------------------------------------------------------------
// GET /admin/settings/countries
// ---------------------------------------------------------------------------

describe("GET /admin/settings/countries", () => {
  const app = makeAdminApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubWorkspaceRole = "owner";
  });

  it("decorates available_countries with delivery state, currency, flag and active-cities count", async () => {
    mockAvailableCountries(["United Arab Emirates", "Lebanon"]);
    // delivery_country_settings rows
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ country_code: "AE", delivery_active: true, delivery_sort_order: 5 }],
      rowCount: 1,
    });
    // active cities count
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ country_code: "AE", active_count: "8" }],
      rowCount: 1,
    });

    const res = await request(app).get("/admin/settings/countries");
    expect(res.status).toBe(200);
    expect(res.body.countries).toHaveLength(2);

    const ae = res.body.countries.find((c: { code: string }) => c.code === "AE");
    expect(ae).toBeTruthy();
    expect(ae.delivery_active).toBe(true);
    expect(ae.delivery_sort_order).toBe(5);
    expect(ae.active_cities_count).toBe(8);
    expect(ae.currency).toBe("AED");
    expect(ae.flag_emoji).toBe("🇦🇪");

    const lb = res.body.countries.find((c: { code: string }) => c.code === "LB");
    expect(lb.delivery_active).toBe(false);
    expect(lb.active_cities_count).toBe(0);
    expect(lb.currency).toBe("LBP");
  });

  it("counts cities correctly when the DB returns UPPER-normalised country_code (lowercase-storage fix)", async () => {
    mockAvailableCountries(["Lebanon"]);
    // delivery_country_settings — no custom delivery settings for LB
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // active cities count — query uses UPPER() so returned code is uppercase
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ country_code: "LB", active_count: "26" }],
      rowCount: 1,
    });

    const res = await request(app).get("/admin/settings/countries");
    expect(res.status).toBe(200);
    const lb = res.body.countries.find((c: { code: string }) => c.code === "LB");
    expect(lb).toBeTruthy();
    expect(lb.active_cities_count).toBe(26);
  });

  it("falls back to DEFAULT_COUNTRIES when no row exists", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/admin/settings/countries");
    expect(res.status).toBe(200);
    // DEFAULT_COUNTRIES kicks in (Lebanon + UAE) when no row exists.
    expect(res.body.countries.length).toBeGreaterThan(0);
  });

  it("reports active_cities_count of exactly 3 for a country with 3 active city rows", async () => {
    mockAvailableCountries(["United Arab Emirates"]);
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ country_code: "AE", active_count: "3" }],
      rowCount: 1,
    });

    const res = await request(app).get("/admin/settings/countries");
    expect(res.status).toBe(200);
    const ae = res.body.countries.find((c: { code: string }) => c.code === "AE");
    expect(ae).toBeDefined();
    expect(ae.active_cities_count).toBe(3);
  });

  it("reports active_cities_count of exactly 0 for a country absent from the count query result", async () => {
    mockAvailableCountries(["Lebanon", "United Arab Emirates"]);
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // Count query returns only AE — LB is missing entirely (0 active cities).
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ country_code: "AE", active_count: "2" }],
      rowCount: 1,
    });

    const res = await request(app).get("/admin/settings/countries");
    expect(res.status).toBe(200);
    const lb = res.body.countries.find((c: { code: string }) => c.code === "LB");
    expect(lb).toBeDefined();
    expect(lb.active_cities_count).toBe(0);
    const ae = res.body.countries.find((c: { code: string }) => c.code === "AE");
    expect(ae).toBeDefined();
    expect(ae.active_cities_count).toBe(2);
  });

  it("does not crash and counts correctly when a NULL country_code appears in the count result", async () => {
    mockAvailableCountries(["Lebanon"]);
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // DB returns a legit row for LB plus a NULL country_code row that should be ignored.
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        { country_code: "LB", active_count: "4" },
        { country_code: null, active_count: "99" },
      ],
      rowCount: 2,
    });

    const res = await request(app).get("/admin/settings/countries");
    expect(res.status).toBe(200);
    const lb = res.body.countries.find((c: { code: string }) => c.code === "LB");
    expect(lb).toBeDefined();
    // Only the legitimate LB row must be counted — NULL must not inflate the total.
    expect(lb.active_cities_count).toBe(4);
  });

  it("reports exact counts for each of multiple countries simultaneously", async () => {
    mockAvailableCountries(["Lebanon", "United Arab Emirates", "Saudi Arabia"]);
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        { country_code: "LB", active_count: "7" },
        { country_code: "AE", active_count: "1" },
        { country_code: "SA", active_count: "5" },
      ],
      rowCount: 3,
    });

    const res = await request(app).get("/admin/settings/countries");
    expect(res.status).toBe(200);

    const lb = res.body.countries.find((c: { code: string }) => c.code === "LB");
    const ae = res.body.countries.find((c: { code: string }) => c.code === "AE");
    const sa = res.body.countries.find((c: { code: string }) => c.code === "SA");

    expect(lb).toBeDefined();
    expect(ae).toBeDefined();
    expect(sa).toBeDefined();

    expect(lb.active_cities_count).toBe(7);
    expect(ae.active_cities_count).toBe(1);
    expect(sa.active_cities_count).toBe(5);
  });

  it("reports active_cities_count of exactly 1 even when the count query returns '1' as a string", async () => {
    mockAvailableCountries(["Lebanon"]);
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // The route uses COUNT(*)::text so the value arrives as a string — parseInt must be applied.
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ country_code: "LB", active_count: "1" }],
      rowCount: 1,
    });

    const res = await request(app).get("/admin/settings/countries");
    expect(res.status).toBe(200);
    const lb = res.body.countries.find((c: { code: string }) => c.code === "LB");
    expect(lb).toBeDefined();
    expect(lb.active_cities_count).toBe(1);
    expect(typeof lb.active_cities_count).toBe("number");
  });

});

// ---------------------------------------------------------------------------
// PATCH /admin/settings/countries/reorder
// ---------------------------------------------------------------------------

describe("PATCH /admin/settings/countries/reorder", () => {
  const app = makeAdminApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubWorkspaceRole = "owner";
  });

  it("returns 403 when caller is not owner", async () => {
    stubWorkspaceRole = "member";
    const res = await request(app)
      .patch("/admin/settings/countries/reorder")
      .send({ codes: ["AE", "LB"] });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("owner_only");
  });

  it("returns 400 when codes field is missing from body", async () => {
    const res = await request(app)
      .patch("/admin/settings/countries/reorder")
      .send({});
    expect(res.status).toBe(400);
  });

  it("returns 400 when codes is an empty array", async () => {
    const res = await request(app)
      .patch("/admin/settings/countries/reorder")
      .send({ codes: [] });
    expect(res.status).toBe(400);
  });

  it("returns 400 when codes contains only one entry (nothing to swap)", async () => {
    const res = await request(app)
      .patch("/admin/settings/countries/reorder")
      .send({ codes: ["AE"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least 2/i);
  });

  it("returns 400 when a code is not a valid 2-letter alpha-2 string", async () => {
    const res = await request(app)
      .patch("/admin/settings/countries/reorder")
      .send({ codes: ["AE", "ZZ9"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid country code/i);
  });

  it("returns 400 when a code is not in available_countries", async () => {
    mockAvailableCountries(["Lebanon"]);
    const res = await request(app)
      .patch("/admin/settings/countries/reorder")
      .send({ codes: ["LB", "AE"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not in available_countries/i);
  });

  it("returns { ok: true } on a successful reorder", async () => {
    mockAvailableCountries(["United Arab Emirates", "Lebanon"]);
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const res = await request(app)
      .patch("/admin/settings/countries/reorder")
      .send({ codes: ["AE", "LB"] });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("writes 0-indexed sort orders with correct owner id in each upsert call", async () => {
    mockAvailableCountries(["United Arab Emirates", "Lebanon"]);
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    await request(app)
      .patch("/admin/settings/countries/reorder")
      .send({ codes: ["LB", "AE"] });

    const insertCalls = mockDbQuery.mock.calls.filter(
      ([sql]: [string]) =>
        typeof sql === "string" && sql.includes("INSERT INTO delivery_country_settings"),
    );
    expect(insertCalls).toHaveLength(2);
    expect(insertCalls[0][1]).toEqual(["owner_123", "LB", 0]);
    expect(insertCalls[1][1]).toEqual(["owner_123", "AE", 1]);
  });

  it("normalises lowercase codes to uppercase before validating and upserting", async () => {
    mockAvailableCountries(["United Arab Emirates", "Lebanon"]);
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const res = await request(app)
      .patch("/admin/settings/countries/reorder")
      .send({ codes: ["ae", "lb"] });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const insertCalls = mockDbQuery.mock.calls.filter(
      ([sql]: [string]) =>
        typeof sql === "string" && sql.includes("INSERT INTO delivery_country_settings"),
    );
    expect(insertCalls).toHaveLength(2);
    expect(insertCalls[0][1]).toEqual(["owner_123", "AE", 0]);
    expect(insertCalls[1][1]).toEqual(["owner_123", "LB", 1]);
  });
});

// ---------------------------------------------------------------------------
// PATCH /admin/settings/countries/:countryCode/delivery
// ---------------------------------------------------------------------------

describe("PATCH /admin/settings/countries/:code/delivery", () => {
  const app = makeAdminApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubWorkspaceRole = "owner";
  });

  it("returns 403 when caller is not owner", async () => {
    stubWorkspaceRole = "member";
    const res = await request(app)
      .patch("/admin/settings/countries/AE/delivery")
      .send({ delivery_active: true });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("owner_only");
  });

  it("returns 400 for an invalid country code", async () => {
    const res = await request(app)
      .patch("/admin/settings/countries/zz9/delivery")
      .send({ delivery_active: true });
    expect(res.status).toBe(400);
  });

  it("returns 400 when country is not in available_countries", async () => {
    mockAvailableCountries(["Lebanon"]);
    const res = await request(app)
      .patch("/admin/settings/countries/AE/delivery")
      .send({ delivery_active: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/available_countries/i);
  });

  it("upserts delivery_active for an allowed country", async () => {
    mockAvailableCountries(["United Arab Emirates"]);
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ country_code: "AE", delivery_active: true, delivery_sort_order: 0 }],
      rowCount: 1,
    });
    const res = await request(app)
      .patch("/admin/settings/countries/AE/delivery")
      .send({ delivery_active: true });
    expect(res.status).toBe(200);
    expect(res.body.delivery_active).toBe(true);
    expect(res.body.country_code).toBe("AE");

    const upsertCall = mockDbQuery.mock.calls[1];
    expect(upsertCall[0]).toMatch(/INSERT INTO delivery_country_settings/);
    expect(upsertCall[1]).toEqual(["owner_123", "AE", true, null]);
  });
});

// ---------------------------------------------------------------------------
// PATCH/DELETE /admin/settings/cities/:id
// ---------------------------------------------------------------------------

describe("PATCH/DELETE /admin/settings/cities/:id", () => {
  const app = makeAdminApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubWorkspaceRole = "owner";
  });

  const baseCity = {
    id: 5,
    workspace_owner_id: "owner_123",
    country_code: "AE",
    name: "Dubai",
    slug: "dubai",
    sort_order: 1,
    is_active: true,
    delivery_fee: "5.00",
    free_delivery_enabled: false,
    free_delivery_threshold: null,
    express_delivery_enabled: false,
    express_delivery_fee: null,
    express_delivery_cutoff_time: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };

  it("updates a city and re-derives slug when name changes without explicit slug", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [baseCity], rowCount: 1 });
    const updated = { ...baseCity, name: "New Dubai", slug: "new-dubai" };
    mockDbQuery.mockResolvedValueOnce({ rows: [updated], rowCount: 1 });

    const res = await request(app)
      .patch("/admin/settings/cities/5")
      .send({ name: "New Dubai" });
    expect(res.status).toBe(200);
    expect(res.body.city.slug).toBe("new-dubai");
  });

  it("returns 404 for an unknown city id", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await request(app).patch("/admin/settings/cities/999").send({ name: "X" });
    expect(res.status).toBe(404);
  });

  it("returns 409 on slug duplicate", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [baseCity], rowCount: 1 });
    const dupErr: Error & { code?: string } = new Error("dup");
    dupErr.code = "23505";
    mockDbQuery.mockRejectedValueOnce(dupErr);
    const res = await request(app)
      .patch("/admin/settings/cities/5")
      .send({ slug: "dubai" });
    expect(res.status).toBe(409);
  });

  it("deletes a city", async () => {
    mockDbQuery.mockResolvedValueOnce({ rowCount: 1 });
    const res = await request(app).delete("/admin/settings/cities/5");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("non-owners cannot delete", async () => {
    stubWorkspaceRole = "member";
    const res = await request(app).delete("/admin/settings/cities/5");
    expect(res.status).toBe(403);
  });

  it("round-trips express delivery fields correctly", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [baseCity], rowCount: 1 });
    const updated = {
      ...baseCity,
      express_delivery_enabled: true,
      express_delivery_fee: "8.50",
      express_delivery_cutoff_time: "14:00",
    };
    mockDbQuery.mockResolvedValueOnce({ rows: [updated], rowCount: 1 });

    const res = await request(app)
      .patch("/admin/settings/cities/5")
      .send({
        express_delivery_enabled: true,
        express_delivery_fee: 8.5,
        express_delivery_cutoff_time: "14:00",
      });
    expect(res.status).toBe(200);
    expect(res.body.city.express_delivery_enabled).toBe(true);
    expect(res.body.city.express_delivery_fee).toBe("8.50");
    expect(res.body.city.express_delivery_cutoff_time).toBe("14:00");

    const updateCall = mockDbQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === "string" && sql.includes("UPDATE delivery_cities"),
    );
    expect(updateCall).toBeTruthy();
    const params = updateCall![1] as unknown[];
    // UPDATE params: name(0), slug(1), sort_order(2), is_active(3), delivery_fee(4),
    //   free_delivery_enabled(5), free_delivery_threshold(6),
    //   express_delivery_enabled(7), express_delivery_fee(8),
    //   express_delivery_cutoff_time(9), id(10), ownerId(11)
    expect(params[7]).toBe(true);
    expect(params[8]).toBe(8.5);
    expect(params[9]).toBe("14:00");
  });

  it("returns 409 with a message containing the slug and country code", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [baseCity], rowCount: 1 });
    const dupErr: Error & { code?: string } = new Error("dup");
    dupErr.code = "23505";
    mockDbQuery.mockRejectedValueOnce(dupErr);
    const res = await request(app)
      .patch("/admin/settings/cities/5")
      .send({ slug: "sharjah" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/sharjah/);
    expect(res.body.error).toMatch(/AE/);
  });
});

// ---------------------------------------------------------------------------
// PATCH /admin/settings/countries/:countryCode/cities/reorder
// ---------------------------------------------------------------------------

describe("PATCH /admin/settings/countries/:countryCode/cities/reorder", () => {
  const app = makeAdminApp();

  beforeEach(() => {
    vi.clearAllMocks();
    stubWorkspaceOwnerId = "owner_123";
    stubWorkspaceRole = "owner";
  });

  it("returns 403 when caller is not owner", async () => {
    stubWorkspaceRole = "member";
    const res = await request(app)
      .patch("/admin/settings/countries/AE/cities/reorder")
      .send({ ids: [1, 2] });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("owner_only");
  });

  it("returns 400 for an invalid country code", async () => {
    const res = await request(app)
      .patch("/admin/settings/countries/zz9/cities/reorder")
      .send({ ids: [1] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid country code/);
  });

  it("returns 400 when ids is missing from body", async () => {
    const res = await request(app)
      .patch("/admin/settings/countries/AE/cities/reorder")
      .send({});
    expect(res.status).toBe(400);
  });

  it("returns 400 when ids count does not match existing city count", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ id: 1 }, { id: 2 }, { id: 3 }],
      rowCount: 3,
    });
    const res = await request(app)
      .patch("/admin/settings/countries/AE/cities/reorder")
      .send({ ids: [1, 2] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/exactly all cities/);
  });

  it("returns 400 when ids contain duplicates", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ id: 1 }, { id: 2 }],
      rowCount: 2,
    });
    const res = await request(app)
      .patch("/admin/settings/countries/AE/cities/reorder")
      .send({ ids: [1, 1] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/duplicates/);
  });

  it("returns 400 when an id is unknown for the country", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ id: 1 }, { id: 2 }],
      rowCount: 2,
    });
    const res = await request(app)
      .patch("/admin/settings/countries/AE/cities/reorder")
      .send({ ids: [1, 99] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not found/);
  });

  it("sets sort_order on each city according to its position in the ids array", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ id: 10 }, { id: 20 }, { id: 30 }],
      rowCount: 3,
    });
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // BEGIN
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE id=30
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE id=10
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE id=20
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // COMMIT

    const res = await request(app)
      .patch("/admin/settings/countries/AE/cities/reorder")
      .send({ ids: [30, 10, 20] });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const updateCalls = mockDbQuery.mock.calls.filter(
      ([sql]: [string]) => typeof sql === "string" && sql.includes("UPDATE delivery_cities"),
    );
    expect(updateCalls).toHaveLength(3);
    // sort_order is the first param, city id is the second
    expect(updateCalls[0][1]).toEqual([0, 30, "owner_123"]);
    expect(updateCalls[1][1]).toEqual([1, 10, "owner_123"]);
    expect(updateCalls[2][1]).toEqual([2, 20, "owner_123"]);
  });

  it("wraps all updates in a transaction (BEGIN … COMMIT)", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 5 }], rowCount: 1 });
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // BEGIN
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // COMMIT

    await request(app)
      .patch("/admin/settings/countries/LB/cities/reorder")
      .send({ ids: [5] });

    const sqlCalls = mockDbQuery.mock.calls.map(([sql]: [string]) => sql);
    expect(sqlCalls).toContain("BEGIN");
    expect(sqlCalls).toContain("COMMIT");
    const beginIdx = sqlCalls.indexOf("BEGIN");
    const commitIdx = sqlCalls.indexOf("COMMIT");
    expect(beginIdx).toBeLessThan(commitIdx);
  });

  it("single-city reorder succeeds and sets sort_order to 0", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [{ id: 7 }], rowCount: 1 });
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // BEGIN
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // COMMIT

    const res = await request(app)
      .patch("/admin/settings/countries/LB/cities/reorder")
      .send({ ids: [7] });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const updateCall = mockDbQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === "string" && sql.includes("UPDATE delivery_cities"),
    );
    expect(updateCall![1]).toEqual([0, 7, "owner_123"]);
  });
});

// ---------------------------------------------------------------------------
// GET /delivery-locations (public)
// ---------------------------------------------------------------------------

describe("GET /delivery-locations", () => {
  const app = makePublicApp();

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveApiKeyWorkspace.mockResolvedValue(null);
  });

  it("returns 400 when ?workspace= is missing and no API key is provided", async () => {
    const res = await request(app).get("/delivery-locations");
    expect(res.status).toBe(400);
  });

  it("returns 400 when API key resolves to null and no ?workspace= param is present", async () => {
    mockResolveApiKeyWorkspace.mockResolvedValue(null);
    const res = await request(app)
      .get("/delivery-locations")
      .set("Authorization", "Bearer pk_live_bad");
    expect(res.status).toBe(400);
  });

  it("resolves workspace from a valid API key when no ?workspace= param is given", async () => {
    mockResolveApiKeyWorkspace.mockResolvedValue("owner_from_key");
    // Public endpoint: 1. delivery_cities DISTINCT, 2. delivery_country_settings,
    // 3. country_flag_overrides, 4. delivery_cities full
    mockDbQuery.mockResolvedValueOnce({ rows: [{ country_code: "LB" }], rowCount: 1 });
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ country_code: "LB", delivery_sort_order: 0 }],
      rowCount: 1,
    });
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app)
      .get("/delivery-locations")
      .set("Authorization", "Bearer pk_live_validkey");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("countries");
  });

  it("API key takes precedence over ?workspace= param", async () => {
    mockResolveApiKeyWorkspace.mockResolvedValue("owner_from_key");
    // Public endpoint: 1. delivery_cities DISTINCT, 2. delivery_country_settings,
    // 3. country_flag_overrides, 4. delivery_cities full
    mockDbQuery.mockResolvedValueOnce({ rows: [{ country_code: "LB" }], rowCount: 1 });
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ country_code: "LB", delivery_sort_order: 0 }],
      rowCount: 1,
    });
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await request(app)
      .get("/delivery-locations?workspace=owner_from_param")
      .set("Authorization", "Bearer pk_live_validkey");

    const flagQueryCall = mockDbQuery.mock.calls.find(
      ([sql]: [string]) => typeof sql === "string" && sql.includes("delivery_country_settings"),
    );
    expect(flagQueryCall?.[1]).toContain("owner_from_key");
  });

  it("returns active countries with their active cities, sorted", async () => {
    // Public endpoint query order:
    // 1. delivery_cities DISTINCT (active country codes)
    // 2. delivery_country_settings (sort orders)
    // 3. country_flag_overrides
    // 4. delivery_cities (full data)
    // 5. district_weekly_delivery_slots
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ country_code: "AE" }, { country_code: "LB" }],
      rowCount: 2,
    });
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        { country_code: "LB", delivery_sort_order: 1 },
        { country_code: "AE", delivery_sort_order: 2 },
      ],
      rowCount: 2,
    });
    // country_flag_overrides (no custom overrides in this test)
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    mockDbQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 1, country_code: "AE", name: "Dubai", slug: "dubai", sort_order: 1,
          delivery_fee: "5.00", free_delivery_enabled: false, free_delivery_threshold: null,
          express_delivery_enabled: false, express_delivery_fee: null,
          express_delivery_cutoff_time: null, updated_at: "2026-01-01T00:00:00Z",
        },
        {
          id: 2, country_code: "LB", name: "Beirut", slug: "beirut", sort_order: 1,
          delivery_fee: "0.00", free_delivery_enabled: false, free_delivery_threshold: null,
          express_delivery_enabled: false, express_delivery_fee: null,
          express_delivery_cutoff_time: null, updated_at: "2026-01-01T00:00:00Z",
        },
      ],
      rowCount: 2,
    });
    // district_weekly_delivery_slots (no slots in this test)
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/delivery-locations?workspace=user_123");
    expect(res.status).toBe(200);
    expect(res.body.countries).toHaveLength(2);
    // Sorted by delivery_sort_order ASC
    expect(res.body.countries[0].country_code).toBe("LB");
    expect(res.body.countries[1].country_code).toBe("AE");
    // city id is now the slug string (integration contract)
    expect(res.body.countries[1].cities).toMatchObject([
      {
        id: "dubai", name: "Dubai", slug: "dubai", sort_order: 1,
        delivery_fee: 5, free_delivery_enabled: false, free_delivery_threshold: null,
        express_delivery_enabled: false, express_delivery_fee: null,
        express_delivery_cutoff_time: null, delivery_slots: [],
      },
    ]);
    expect(res.body.countries[1].flag_emoji).toBe("🇦🇪");
    expect(res.body.countries[1].currency).toBe("AED");
  });

  it("hides countries with no active cities", async () => {
    // When delivery_cities DISTINCT returns 0 rows the route returns early.
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).get("/delivery-locations?workspace=user_123");
    expect(res.status).toBe(200);
    expect(res.body.countries).toEqual([]);
  });
});
