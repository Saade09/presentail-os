import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { WorkspaceRequest } from "../lib/workspace";

const {
  mockDbQuery,
  mockClientQuery,
  mockConnect,
  mockTranslateAddressToEnglish,
  mockRunTranslationBackfill,
} = vi.hoisted(() => ({
  mockDbQuery: vi.fn(),
  mockClientQuery: vi.fn(),
  mockConnect: vi.fn(),
  mockTranslateAddressToEnglish: vi.fn(),
  mockRunTranslationBackfill: vi.fn(),
}));

vi.mock("../lib/db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
    connect: () => mockConnect(),
  },
  withTransaction: async (_client: unknown, fn: () => Promise<unknown>) => fn(),
}));

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = "workspace_1";
    wreq.workspaceRole = "owner";
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../lib/driverTokenAuth", () => ({
  requireDriverToken: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  driverAuthed: () => ({ workspaceOwnerId: "workspace_1" }),
}));

vi.mock("../jobs/addressBookBackfill", () => ({
  runBackfill: vi.fn(),
}));

vi.mock("../jobs/addressBookTranslationBackfill", () => ({
  runTranslationBackfill: (...args: unknown[]) => mockRunTranslationBackfill(...args),
}));

vi.mock("../lib/addressBookAutoLink", () => ({
  assessAndGeocode: vi.fn(),
  normalizePlaceName: (text: string) => text.toLowerCase().trim().replace(/\s+/g, " "),
  qualifySharedAlias: (alias: string) => ({
    accepted: true,
    normalizedAlias: alias.toLowerCase().trim(),
    reason: "accepted",
    requiresOwnerApproval: false,
  }),
}));

// Use real detectScript logic; intercept translateAddressToEnglish per-test.
vi.mock("../lib/translation", () => ({
  detectScript: (text: string) => {
    if (!text) return "latin";
    let arabicCount = 0;
    for (const ch of text) {
      const cp = (ch as string).codePointAt(0) ?? 0;
      if (cp >= 0x0600 && cp <= 0x06ff) arabicCount++;
    }
    return arabicCount / text.length > 0.3 ? "arabic" : "latin";
  },
  translateAddressToEnglish: (...args: unknown[]) => mockTranslateAddressToEnglish(...args),
}));

import addressBookRouter from "./addressBook";

const PLACE_ID = "00000000-0000-4000-8000-000000000001";
const CONTACT_ID = "00000000-0000-4000-8000-000000000002";
const CONTACT_ADDRESS_ID = "00000000-0000-4000-8000-000000000003";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(addressBookRouter);
  return app;
}

describe("Address Book place-type persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbQuery.mockReset();
    mockClientQuery.mockReset();
    mockClientQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    mockConnect.mockReturnValue({
      query: (...args: unknown[]) => mockClientQuery(...args),
      release: vi.fn(),
    });
    // Default: no translation so existing Latin-name tests are unaffected.
    mockTranslateAddressToEnglish.mockResolvedValue(null);
    mockRunTranslationBackfill.mockReset();
  });

  it("persists Hotel when creating a Residence-default guest house", async () => {
    mockClientQuery.mockImplementation((sql: string) => {
      if (sql.includes("INSERT INTO places")) return { rows: [{ id: PLACE_ID }], rowCount: 1 };
      if (sql.includes("FROM delivery_cities")) return { rows: [{ id: 42 }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    mockDbQuery.mockResolvedValue({ rows: [{ id: PLACE_ID, place_type: "hotel" }], rowCount: 1 });

    const response = await request(makeApp())
      .post("/address-book/places")
      .send({ canonical_name: "Palm Guesthouse", city_id: 42 });

    expect(response.status).toBe(201);
    const insertCall = mockClientQuery.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO places"),
    );
    expect(insertCall?.[1]).toEqual(
      expect.arrayContaining(["workspace_1", "Palm Guesthouse", "hotel"]),
    );
  });

  it("creates a Google location with an active Lebanese district", async () => {
    vi.stubEnv("GOOGLE_PLACES_SERVER_KEY", "test-google-key");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          addressComponents: [
            { shortText: "LB", types: ["country"] },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    mockClientQuery.mockImplementation((sql: string) => {
      if (sql.includes("FROM delivery_cities")) return { rows: [{ id: 42 }], rowCount: 1 };
      if (sql.includes("INSERT INTO places")) return { rows: [{ id: PLACE_ID }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    mockDbQuery.mockResolvedValue({
      rows: [{ id: PLACE_ID, canonical_name: "Beirut Souks" }],
      rowCount: 1,
    });

    try {
      const response = await request(makeApp())
        .post("/address-book/places")
        .send({
          canonical_name: "Beirut Souks",
          city_id: 42,
          google_place_id: "ChIJ-lebanon",
          google_country: "Lebanon",
        });

      expect(response.status).toBe(201);
      const districtCall = mockClientQuery.mock.calls.find(([sql]) =>
        String(sql).includes("FROM delivery_cities"),
      );
      expect(districtCall?.[1]).toEqual([42, "workspace_1"]);
      expect(String(districtCall?.[0])).toContain("UPPER(country_code) = 'LB'");
    } finally {
      fetchSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it.each([
    ["a non-Lebanese district", 77],
    ["a district owned by another workspace", 88],
  ])("rejects %s", async (_label, cityId) => {
    mockClientQuery.mockImplementation((sql: string) => {
      if (sql.includes("FROM delivery_cities")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    });

    const response = await request(makeApp())
      .post("/address-book/places")
      .send({ canonical_name: "Blocked location", city_id: cityId });

    expect(response.status).toBe(422);
    expect(response.body.error).toMatch(/active Lebanon delivery district in this workspace/i);
    expect(
      mockClientQuery.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO places")),
    ).toBe(false);
  });

  it.each([
    ["United Arab Emirates"],
    ["US"],
    [null],
  ])("rejects Google country metadata %s", async (googleCountry) => {
    const response = await request(makeApp())
      .post("/address-book/places")
      .send({
        canonical_name: "Foreign Google result",
        city_id: 42,
        google_place_id: "ChIJ-foreign",
        google_country: googleCountry,
      });

    expect(response.status).toBe(422);
    expect(response.body.error).toMatch(/Google locations must identify Lebanon/i);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it("rejects a foreign Google Place ID even when the client labels it as Lebanon", async () => {
    vi.stubEnv("GOOGLE_PLACES_SERVER_KEY", "test-google-key");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          addressComponents: [
            { shortText: "AE", types: ["country"] },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    try {
      const response = await request(makeApp())
        .post("/address-book/places")
        .send({
          canonical_name: "Forged foreign result",
          city_id: 42,
          google_place_id: "ChIJ-foreign-forged",
          google_country: "LB",
        });

      expect(response.status).toBe(422);
      expect(response.body.error).toMatch(/outside Lebanon/i);
      expect(mockConnect).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("rejects a countryless Google Place ID even when the client labels it as Lebanon", async () => {
    vi.stubEnv("GOOGLE_PLACES_SERVER_KEY", "test-google-key");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          addressComponents: [
            { shortText: "Beirut", types: ["locality"] },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    try {
      const response = await request(makeApp())
        .post("/address-book/places")
        .send({
          canonical_name: "Countryless Google result",
          city_id: 42,
          google_place_id: "ChIJ-countryless-forged",
          google_country: "LB",
        });

      expect(response.status).toBe(422);
      expect(response.body.error).toMatch(/could not identify.*country/i);
      expect(mockConnect).not.toHaveBeenCalled();
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining("ChIJ-countryless-forged"),
        expect.objectContaining({
          headers: expect.objectContaining({
            "X-Goog-FieldMask": expect.stringContaining("addressComponents"),
          }),
        }),
      );
    } finally {
      fetchSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("always constrains Address Book autocomplete to Lebanon", async () => {
    vi.stubEnv("GOOGLE_PLACES_SERVER_KEY", "test-google-key");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ suggestions: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    try {
      const response = await request(makeApp())
        .get("/address-book/places/google-autocomplete")
        .query({ q: "Beirut", countryCode: "AE" });

      expect(response.status).toBe(200);
      const requestBody = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
      expect(requestBody.includedRegionCodes).toEqual(["LB"]);
    } finally {
      fetchSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("promotes an edited legacy Residence from an active Airbnb alias", async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{
          canonical_name: "Villa 27",
          place_type: "residence",
          aliases: ["Airbnb near the beach"],
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ id: PLACE_ID }], rowCount: 1 });

    const response = await request(makeApp())
      .put(`/address-book/places/${PLACE_ID}`)
      .send({ area: "Jumeirah" });

    expect(response.status).toBe(200);
    const updateCall = mockClientQuery.mock.calls.find(([sql]) =>
      String(sql).startsWith("UPDATE places SET"),
    );
    expect(updateCall?.[1]).toEqual(
      expect.arrayContaining(["workspace_1", PLACE_ID, "hotel", "Jumeirah"]),
    );
  });

  it("keeps a non-residential type when an edit includes an accommodation name", async () => {
    mockDbQuery
      .mockResolvedValueOnce({
        rows: [{ canonical_name: "Office Annex", place_type: "office", aliases: [] }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ id: PLACE_ID }], rowCount: 1 });

    const response = await request(makeApp())
      .put(`/address-book/places/${PLACE_ID}`)
      .send({ canonical_name: "Airbnb reception office", place_type: "office" });

    expect(response.status).toBe(200);
    const updateCall = mockClientQuery.mock.calls.find(([sql]) =>
      String(sql).startsWith("UPDATE places SET"),
    );
    expect(updateCall?.[1]).toEqual(
      expect.arrayContaining(["workspace_1", PLACE_ID, "Airbnb reception office", "office"]),
    );
  });

  it("translates an Arabic canonical_name to English and stores the original as an ar alias", async () => {
    mockTranslateAddressToEnglish.mockResolvedValue("Khalil Kanaan Building");
    mockClientQuery.mockImplementation((sql: string) => {
      if (sql.includes("INSERT INTO places")) return { rows: [{ id: PLACE_ID }], rowCount: 1 };
      if (sql.includes("FROM delivery_cities")) return { rows: [{ id: 42 }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    mockDbQuery.mockResolvedValue({ rows: [{ id: PLACE_ID, place_type: "residence" }], rowCount: 1 });

    const arabicName = "مبنى شركة خليل كنعان";
    const response = await request(makeApp())
      .post("/address-book/places")
      .send({ canonical_name: arabicName, city_id: 42 });

    expect(response.status).toBe(201);

    // Place should be stored with the English-translated name
    const insertCall = mockClientQuery.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO places"),
    );
    expect(insertCall?.[1]).toEqual(
      expect.arrayContaining(["workspace_1", "Khalil Kanaan Building"]),
    );

    // Arabic original must be persisted as an approved_transliteration alias.
    // 'ar' and 'approved_transliteration' are SQL literals, not bound params.
    const aliasCall = mockClientQuery.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO place_aliases") &&
      String(sql).includes("approved_transliteration"),
    );
    expect(aliasCall).toBeDefined();
    // Bound params: [place_id, alias_text, normalized_alias]
    expect(aliasCall?.[1]).toEqual(
      expect.arrayContaining([PLACE_ID, arabicName]),
    );
  });

  it("translates canonical_address on place creation and preserves its Arabic original", async () => {
    const arabicAddress = "شارع الحمرا، مبنى ٤٢";
    mockTranslateAddressToEnglish.mockImplementation(async (text: string) =>
      text === arabicAddress ? "42 Hamra Street" : null,
    );
    mockClientQuery.mockImplementation((sql: string) => {
      if (sql.includes("INSERT INTO places")) return { rows: [{ id: PLACE_ID }], rowCount: 1 };
      if (sql.includes("FROM delivery_cities")) return { rows: [{ id: 42 }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    mockDbQuery.mockResolvedValue({ rows: [{ id: PLACE_ID, place_type: "residence" }], rowCount: 1 });

    const response = await request(makeApp())
      .post("/address-book/places")
      .send({ canonical_name: "Hamra Building", canonical_address: arabicAddress, city_id: 42 });

    expect(response.status).toBe(201);
    const placeInsert = mockClientQuery.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO places"),
    );
    expect(placeInsert?.[1]?.[6]).toBe("42 Hamra Street");
    expect(mockClientQuery.mock.calls.some(([sql, params]) =>
      String(sql).includes("approved_transliteration") &&
      Array.isArray(params) &&
      params.includes(arabicAddress),
    )).toBe(true);
  });

  it("re-translates place name and address edits and preserves both originals", async () => {
    const arabicName = "مبنى الأرز";
    const arabicAddress = "شارع بلس، بيروت";
    mockTranslateAddressToEnglish.mockImplementation(async (text: string) => {
      if (text === arabicName) return "Cedar Building";
      if (text === arabicAddress) return "Bliss Street, Beirut";
      return null;
    });
    mockDbQuery.mockImplementation((sql: string) => {
      if (sql.includes("ARRAY(") && sql.includes("FROM places p")) {
        return Promise.resolve({
          rows: [{ canonical_name: "Old name", place_type: "residence", aliases: [] }],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    const response = await request(makeApp())
      .put(`/address-book/places/${PLACE_ID}`)
      .send({ canonical_name: arabicName, canonical_address: arabicAddress });

    expect(response.status).toBe(200);
    const update = mockClientQuery.mock.calls.find(([sql]) =>
      String(sql).startsWith("UPDATE places SET"),
    );
    expect(update?.[1]).toEqual([
      "workspace_1",
      PLACE_ID,
      "Cedar Building",
      "Bliss Street, Beirut",
    ]);
    const translatedAliases = mockClientQuery.mock.calls.filter(([sql]) =>
      String(sql).includes("approved_transliteration"),
    );
    expect(translatedAliases).toHaveLength(2);
    expect(translatedAliases.map((call) => call[1]?.[1])).toEqual([
      arabicName,
      arabicAddress,
    ]);
  });

  it("translates contact raw_address on create and keeps the original on failure", async () => {
    const arabicAddress = "الأشرفية، شارع ساسين";
    mockDbQuery.mockResolvedValue({ rows: [{ id: CONTACT_ID }], rowCount: 1 });
    mockClientQuery.mockImplementation((sql: string) => {
      if (sql.includes("INSERT INTO contact_addresses")) {
        return { rows: [{ id: CONTACT_ADDRESS_ID }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    mockTranslateAddressToEnglish.mockResolvedValueOnce("Sassine Street, Achrafieh");

    const translatedResponse = await request(makeApp())
      .post("/contact-addresses")
      .send({ contact_id: CONTACT_ID, raw_address: arabicAddress });

    expect(translatedResponse.status).toBe(201);
    const translatedInsert = mockClientQuery.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO contact_addresses"),
    );
    expect(translatedInsert?.[1]?.[4]).toBe("Sassine Street, Achrafieh");

    vi.clearAllMocks();
    mockDbQuery.mockResolvedValue({ rows: [{ id: CONTACT_ID }], rowCount: 1 });
    mockConnect.mockReturnValue({
      query: (...args: unknown[]) => mockClientQuery(...args),
      release: vi.fn(),
    });
    mockClientQuery.mockImplementation((sql: string) => {
      if (sql.includes("INSERT INTO contact_addresses")) {
        return { rows: [{ id: CONTACT_ADDRESS_ID }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    mockTranslateAddressToEnglish.mockResolvedValue(null);

    const fallbackResponse = await request(makeApp())
      .post("/contact-addresses")
      .send({ contact_id: CONTACT_ID, raw_address: arabicAddress });

    expect(fallbackResponse.status).toBe(201);
    const fallbackInsert = mockClientQuery.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO contact_addresses"),
    );
    expect(fallbackInsert?.[1]?.[4]).toBe(arabicAddress);
  });

  it("translates contact raw_address on update", async () => {
    const arabicAddress = "الروشة، شارع أستراليا";
    mockTranslateAddressToEnglish.mockResolvedValue("Australia Street, Raouche");
    mockDbQuery.mockResolvedValue({
      rows: [{ id: CONTACT_ADDRESS_ID, contact_id: CONTACT_ID }],
      rowCount: 1,
    });
    mockClientQuery.mockResolvedValue({ rows: [], rowCount: 1 });

    const response = await request(makeApp())
      .put(`/contact-addresses/${CONTACT_ADDRESS_ID}`)
      .send({ raw_address: arabicAddress });

    expect(response.status).toBe(200);
    const update = mockClientQuery.mock.calls.find(([sql]) =>
      String(sql).includes("UPDATE contact_addresses SET"),
    );
    expect(update?.[1]).toEqual([CONTACT_ADDRESS_ID, "Australia Street, Raouche"]);
  });

  it("promotes a Residence before returning a duplicate accommodation-alias conflict", async () => {
    mockDbQuery.mockResolvedValue({
      rows: [{ id: PLACE_ID, canonical_name: "Villa 27" }],
      rowCount: 1,
    });
    mockClientQuery.mockImplementation((sql: string) => {
      if (sql.includes("INSERT INTO place_aliases")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    });

    const response = await request(makeApp())
      .post(`/address-book/places/${PLACE_ID}/aliases`)
      .send({ alias_text: "Airbnb near the beach" });

    expect(response.status).toBe(409);
    const promotionCall = mockClientQuery.mock.calls.find(([sql]) =>
      String(sql).startsWith("UPDATE places"),
    );
    expect(promotionCall?.[1]).toEqual([PLACE_ID]);
  });

  it("runs the owner-only Arabic translation backfill with dry-run enabled", async () => {
    const summary = {
      workspace_id: "workspace_1",
      dry_run: true,
      places_scanned: 3,
      place_names_updated: 2,
      place_addresses_updated: 0,
      contact_addresses_scanned: 0,
      contact_addresses_updated: 0,
      aliases_added: 0,
      skipped_translation: 1,
      errors: [],
    };
    mockRunTranslationBackfill.mockResolvedValue(summary);

    const response = await request(makeApp())
      .post("/address-book/import/translation-run")
      .send({ dry_run: true });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, dry_run: true, summary });
    expect(mockRunTranslationBackfill).toHaveBeenCalledWith({
      workspaceId: "workspace_1",
      dryRun: true,
    });
  });
});