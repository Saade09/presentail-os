import { beforeEach, describe, expect, it, vi } from "vitest";

const mockQuery = vi.fn();
vi.mock("./db", () => ({
  db: { query: (...args: unknown[]) => mockQuery(...args) },
}));

import { resolveTrustedPlaceGeography } from "./placeGeography";

describe("resolveTrustedPlaceGeography", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps null-city Lebanese linked-delivery evidence", async () => {
    mockQuery.mockResolvedValue({
      rows: [{
        city_name: null,
        stored_country: "LB",
        stored_country_source: "order_ingest",
        city_country: null,
        linked_countries: ["LB"],
      }],
    });
    await expect(resolveTrustedPlaceGeography("place-1", "ws-1")).resolves.toEqual({
      city: null,
      country: "LB",
      conflict: false,
    });
  });

  it("does not collapse mixed-country evidence", async () => {
    mockQuery.mockResolvedValue({
      rows: [{
        city_name: "Beirut",
        stored_country: "LB",
        stored_country_source: "order_ingest",
        city_country: "LB",
        linked_countries: ["AE", "LB"],
      }],
    });
    await expect(resolveTrustedPlaceGeography("place-1", "ws-1")).resolves.toEqual({
      city: null,
      country: null,
      conflict: true,
    });
  });

  it("leaves absent country evidence unresolved", async () => {
    mockQuery.mockResolvedValue({
      rows: [{
        city_name: null,
        stored_country: null,
        stored_country_source: null,
        city_country: null,
        linked_countries: [],
      }],
    });
    await expect(resolveTrustedPlaceGeography("place-1", "ws-1")).resolves.toEqual({
      city: null,
      country: null,
      conflict: false,
    });
  });

  it("ignores a stored country whose provenance is not trusted", async () => {
    mockQuery.mockResolvedValue({
      rows: [{
        city_name: null,
        stored_country: "LB",
        stored_country_source: "ai",
        city_country: null,
        linked_countries: [],
      }],
    });
    await expect(resolveTrustedPlaceGeography("place-1", "ws-1")).resolves.toEqual({
      city: null,
      country: null,
      conflict: false,
    });
  });
});