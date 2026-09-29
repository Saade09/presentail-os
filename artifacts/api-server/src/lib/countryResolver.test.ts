import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDbQuery = vi.fn();

vi.mock("./db", () => ({
  db: { query: (...args: unknown[]) => mockDbQuery(...args) },
}));

import { decorateCountryNames, loadFlagOverrides } from "./countryResolver";

describe("decorateCountryNames", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it("returns default flag URL when no override exists", async () => {
    const out = await decorateCountryNames("owner_1", ["Lebanon", "France"]);
    expect(out).toEqual([
      { name: "Lebanon", code: "lb", flagImageUrl: "/flags/lb.svg" },
      { name: "France", code: "fr", flagImageUrl: "/flags/fr.svg" },
    ]);
  });

  it("applies per-workspace overrides keyed by country code", async () => {
    mockDbQuery.mockResolvedValueOnce({
      rows: [{ country_code: "lb", image_url: "/api/storage/objects/owner_1/x.svg" }],
      rowCount: 1,
    });
    const out = await decorateCountryNames("owner_1", ["Lebanon", "France"]);
    expect(out[0].flagImageUrl).toBe("/api/storage/objects/owner_1/x.svg");
    expect(out[1].flagImageUrl).toBe("/flags/fr.svg");
  });

  it("returns null code/url for unknown country names", async () => {
    const out = await decorateCountryNames("owner_1", ["Atlantis"]);
    expect(out).toEqual([{ name: "Atlantis", code: null, flagImageUrl: null }]);
  });
});

describe("loadFlagOverrides", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("scopes the overrides query by workspace owner id", async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await loadFlagOverrides("owner_42");
    expect(mockDbQuery.mock.calls[0][1]).toEqual(["owner_42"]);
  });
});
