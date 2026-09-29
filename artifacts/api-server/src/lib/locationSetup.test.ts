import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockDbQuery = vi.fn();

vi.mock("./db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
  },
}));

import {
  maybeAutoActivateLocation,
  maybeAutoActivateLocationsByBrand,
} from "./locationSetup";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSetupRow(overrides: Record<string, unknown> = {}) {
  return {
    status: "setup_incomplete",
    has_devices: true,
    has_brands: true,
    has_products: true,
    has_operating_hours: true,
    has_routing: true,
    has_capacity: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// maybeAutoActivateLocation — happy path
// ---------------------------------------------------------------------------

describe("maybeAutoActivateLocation — happy path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("updates status to 'active' when location is setup_incomplete and all 6 flags are true", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [makeSetupRow()], rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 });

    await maybeAutoActivateLocation("owner_1", 42);

    expect(mockDbQuery).toHaveBeenCalledTimes(2);

    const [updateSql, updateParams] = mockDbQuery.mock.calls[1] as [string, unknown[]];
    expect(updateSql).toMatch(/UPDATE locations SET status = 'active'/i);
    expect(updateParams).toContain(42);
    expect(updateParams).toContain("owner_1");
  });

  it("calls the logger.info when the location auto-activates", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [makeSetupRow()], rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 });

    const mockLog = { info: vi.fn() };
    await maybeAutoActivateLocation("owner_1", 42, mockLog);

    expect(mockLog.info).toHaveBeenCalledOnce();
    const [meta] = mockLog.info.mock.calls[0] as [{ locationId: number }, string];
    expect(meta.locationId).toBe(42);
  });

  it("passes the correct locationId and ownerId in the SELECT query", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [makeSetupRow()], rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 });

    await maybeAutoActivateLocation("owner_abc", 99);

    const [selectSql, selectParams] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    expect(selectSql).toMatch(/FROM locations/i);
    expect(selectParams).toContain(99);
    expect(selectParams).toContain("owner_abc");
  });
});

// ---------------------------------------------------------------------------
// maybeAutoActivateLocation — no-op when status is not setup_incomplete
// ---------------------------------------------------------------------------

describe("maybeAutoActivateLocation — no-op when already active or paused", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(["active", "paused"])(
    "does NOT issue an UPDATE when status is '%s' even if all flags are true",
    async (status) => {
      mockDbQuery.mockResolvedValueOnce({
        rows: [makeSetupRow({ status })],
        rowCount: 1,
      });

      await maybeAutoActivateLocation("owner_1", 1);

      expect(mockDbQuery).toHaveBeenCalledTimes(1);
    },
  );
});

// ---------------------------------------------------------------------------
// maybeAutoActivateLocation — no-op when location not found
// ---------------------------------------------------------------------------

describe("maybeAutoActivateLocation — no-op when location not found", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns early and does not UPDATE when no row is returned", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await maybeAutoActivateLocation("owner_1", 999);

    expect(mockDbQuery).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// maybeAutoActivateLocation — does NOT activate when exactly 5 of 6 flags met
// ---------------------------------------------------------------------------

describe("maybeAutoActivateLocation — does NOT activate when only 5 of 6 steps are complete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const missingOneFlag = [
    { flag: "has_devices",          overrides: { has_devices: false } },
    { flag: "has_brands",           overrides: { has_brands: false } },
    { flag: "has_products",         overrides: { has_products: false } },
    { flag: "has_operating_hours",  overrides: { has_operating_hours: false } },
    { flag: "has_routing",          overrides: { has_routing: false } },
    { flag: "has_capacity",         overrides: { has_capacity: false } },
  ];

  it.each(missingOneFlag)(
    "does NOT UPDATE when '$flag' is false (5 of 6 complete)",
    async ({ overrides }) => {
      mockDbQuery.mockResolvedValueOnce({
        rows: [makeSetupRow(overrides)],
        rowCount: 1,
      });

      await maybeAutoActivateLocation("owner_1", 7);

      // Only the SELECT should have been called; no UPDATE
      expect(mockDbQuery).toHaveBeenCalledTimes(1);
    },
  );
});

// ---------------------------------------------------------------------------
// maybeAutoActivateLocation — the SELECT query covers all 6 conditions
// ---------------------------------------------------------------------------

describe("maybeAutoActivateLocation — SELECT query structure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("SELECT query checks for devices", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await maybeAutoActivateLocation("owner_1", 1);
    const sql = mockDbQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/device_count/i);
  });

  it("SELECT query checks for brands", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await maybeAutoActivateLocation("owner_1", 1);
    const sql = mockDbQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/brands_count/i);
  });

  it("SELECT query checks for products", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await maybeAutoActivateLocation("owner_1", 1);
    const sql = mockDbQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/products_count/i);
  });

  it("SELECT query checks operating_hours for has_operating_hours", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await maybeAutoActivateLocation("owner_1", 1);
    const sql = mockDbQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/operating_hours/i);
    expect(sql).toMatch(/has_operating_hours/i);
  });

  it("SELECT query checks auto_routing / backup_location_id / served_area_ids for has_routing", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await maybeAutoActivateLocation("owner_1", 1);
    const sql = mockDbQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/auto_routing_enabled/i);
    expect(sql).toMatch(/backup_location_id/i);
    expect(sql).toMatch(/served_area_ids/i);
    expect(sql).toMatch(/has_routing/i);
  });

  it("SELECT query checks daily_capacity for has_capacity", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await maybeAutoActivateLocation("owner_1", 1);
    const sql = mockDbQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/daily_capacity/i);
    expect(sql).toMatch(/has_capacity/i);
  });

  it("UPDATE query uses an atomic WHERE status = 'setup_incomplete' guard", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [makeSetupRow()], rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 });

    await maybeAutoActivateLocation("owner_1", 5);

    const updateSql = mockDbQuery.mock.calls[1][0] as string;
    expect(updateSql).toMatch(/AND status = 'setup_incomplete'/i);
  });
});

// ---------------------------------------------------------------------------
// maybeAutoActivateLocationsByBrand — dispatches per matching location
// ---------------------------------------------------------------------------

describe("maybeAutoActivateLocationsByBrand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is a no-op when brandName is null", async () => {
    await maybeAutoActivateLocationsByBrand("owner_1", null);
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("is a no-op when brandName is empty string", async () => {
    await maybeAutoActivateLocationsByBrand("owner_1", "");
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  it("queries setup_incomplete locations linked to the given brand", async () => {
    // Return no locations so no further queries fire
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await maybeAutoActivateLocationsByBrand("owner_1", "Nike");

    const [sql, params] = mockDbQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/setup_incomplete/i);
    expect(params).toContain("owner_1");
    expect(params).toContain("Nike");
  });

  it("calls maybeAutoActivateLocation for each matching location", async () => {
    // First call: find 2 setup_incomplete locations linked to the brand
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{ location_id: 10 }, { location_id: 20 }],
        rowCount: 2,
      })
      // Second call: SELECT for location 10 — all flags true → will UPDATE
      .mockResolvedValueOnce({ rows: [makeSetupRow()], rowCount: 1 })
      // Third call: UPDATE for location 10
      .mockResolvedValueOnce({ rowCount: 1 })
      // Fourth call: SELECT for location 20 — missing capacity → no UPDATE
      .mockResolvedValueOnce({
        rows: [makeSetupRow({ has_capacity: false })],
        rowCount: 1,
      });

    await maybeAutoActivateLocationsByBrand("owner_1", "Nike");

    // brand lookup + SELECT(10) + UPDATE(10) + SELECT(20) = 4 calls total
    expect(mockDbQuery).toHaveBeenCalledTimes(4);

    const updateCall = mockDbQuery.mock.calls[2] as [string, unknown[]];
    expect(updateCall[0]).toMatch(/UPDATE locations SET status = 'active'/i);
    expect(updateCall[1]).toContain(10);
  });

  it("does NOT issue any UPDATE when the found locations all have incomplete setup", async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{ location_id: 5 }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [makeSetupRow({ has_brands: false })],
        rowCount: 1,
      });

    await maybeAutoActivateLocationsByBrand("owner_1", "Adidas");

    expect(mockDbQuery).toHaveBeenCalledTimes(2);
    // No UPDATE call
    for (const [sql] of mockDbQuery.mock.calls as [string, unknown[]][]) {
      expect(sql).not.toMatch(/UPDATE locations/i);
    }
  });
});
