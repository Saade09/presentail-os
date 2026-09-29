import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDbQuery = vi.fn();
const mockAssessPlaceValidity = vi.fn();
const mockGeocodeAddress = vi.fn();
const mockLoggerInfo = vi.fn();
const mockLoggerWarn = vi.fn();
const mockLoggerError = vi.fn();
const mockTranslateAddressToEnglish = vi.fn();

vi.mock("./db", () => ({
  db: {
    query: (...args: unknown[]) => mockDbQuery(...args),
  },
}));

vi.mock("./logger", () => ({
  logger: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: (...args: unknown[]) => mockLoggerError(...args),
  },
}));

vi.mock("./placeAiAssessor.js", () => ({
  assessPlaceValidity: (...args: unknown[]) => mockAssessPlaceValidity(...args),
  geocodeAddress: (...args: unknown[]) => mockGeocodeAddress(...args),
}));

// Use the real detectScript logic so normalizePlaceName continues to work;
// intercept translateAddressToEnglish so tests control translation output.
vi.mock("./translation.js", () => ({
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

import {
  assessAndGeocode,
  compactPlaceTitle,
  getAddressEligibility,
  linkOrderToAddressBook,
  qualifySharedAlias,
} from "./addressBookAutoLink";

async function flushBackgroundWork() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGeocodeAddress.mockResolvedValue(null);
  // Default: translation returns null (no-op) so existing tests are unaffected.
  mockTranslateAddressToEnglish.mockResolvedValue(null);
});

describe("getAddressEligibility", () => {
  it("rejects no-address orders before their text can be treated as a place", () => {
    expect(
      getAddressEligibility({
        noAddress: true,
        address: "Hamra, near the petrol station",
      }),
    ).toEqual({
      eligible: false,
      reason: "no_address_requested",
      addressText: "Hamra, near the petrol station",
    });
  });

  it("recognizes punctuation and case variations of a call-recipient placeholder", () => {
    expect(
      getAddressEligibility({
        address: "I DON’T know the address — please, call the recipient!",
      }),
    ).toMatchObject({
      eligible: false,
      reason: "placeholder_instruction",
    });
  });
});

describe("compactPlaceTitle", () => {
  it("keeps the reusable identity while removing unit, contact, and delivery detail", () => {
    expect(
      compactPlaceTitle(
        "Cedar Heights, Floor 4, Apt 12B, call +961 3 123 456, leave with reception",
      ),
    ).toMatchObject({
      title: "Cedar Heights",
    });
  });

  it("uses safe address context as a deterministic fallback", () => {
    expect(
      compactPlaceTitle("Apartment 7, Chalet 3", { area: "Saadiyat Villas" }),
    ).toMatchObject({
      title: "Saadiyat Villas",
    });
  });

  it("removes hospital room and ward details from a reusable title", () => {
    expect(compactPlaceTitle("AUH Hospital, Ward C, Room 412")).toMatchObject({
      title: "AUH Hospital",
    });
  });
});

describe("qualifySharedAlias", () => {
  it("accepts reusable aliases but rejects private delivery-specific details", () => {
    expect(qualifySharedAlias("Cedar Heights")).toMatchObject({ accepted: true });
    expect(qualifySharedAlias("Cedar Heights, Floor 4")).toMatchObject({
      accepted: false,
      reason: "private_detail",
    });
    expect(qualifySharedAlias("Call +961 3 123 456")).toMatchObject({
      accepted: false,
      reason: "private_detail",
    });
  });

  it("requires explicit owner approval for AI and search suggestions", () => {
    expect(qualifySharedAlias("Cedar Heights", "ai_suggestion", false)).toMatchObject({
      accepted: false,
      reason: "requires_owner_approval",
    });
    expect(qualifySharedAlias("Cedar Heights", "search_suggestion", true)).toMatchObject({
      accepted: true,
    });
  });
});

describe("linkOrderToAddressBook", () => {
  it("does not assess, match, or create a place for an order marked as having no address", async () => {
    await linkOrderToAddressBook("order-no-address", "ws-1", {
      noAddress: true,
      address: "Hamra",
    });

    expect(mockAssessPlaceValidity).not.toHaveBeenCalled();
    expect(
      mockDbQuery.mock.calls.some((call) => /INSERT INTO places|INSERT INTO order_place_links/i.test(String(call[0]))),
    ).toBe(false);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "no_address_requested" }),
      expect.any(String),
    );
  });

  it("does not match or create a clear call-recipient placeholder", async () => {
    await linkOrderToAddressBook("order-placeholder", "ws-1", {
      address: "I don't know the address, please call the recipient.",
    });

    expect(mockAssessPlaceValidity).not.toHaveBeenCalled();
    expect(
      mockDbQuery.mock.calls.some((call) => /INSERT INTO places|INSERT INTO order_place_links/i.test(String(call[0]))),
    ).toBe(false);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "placeholder_instruction" }),
      expect.any(String),
    );
  });

  it("creates, links, and geocodes an AI-valid new location", async () => {
    mockDbQuery.mockImplementation((sql: string) => {
      if (/INSERT INTO places/i.test(sql)) return Promise.resolve({ rows: [{ id: "place-1" }] });
      return Promise.resolve({ rows: [] });
    });
    mockAssessPlaceValidity.mockResolvedValue({
      valid: true,
      reason: "Street and neighborhood are a plausible delivery location.",
    });

    await linkOrderToAddressBook(
      "order-valid",
      "ws-1",
      { address: "Hamra, near the petrol station", city: "Beirut", phone: "+9613000111" },
      { deliveryInstructions: "Please leave with reception" },
    );
    await flushBackgroundWork();

    expect(mockAssessPlaceValidity).toHaveBeenCalledWith(
      "Hamra",
      [],
      {
        city: "beirut",
        workspaceOwnerId: "ws-1",
        orderId: "order-valid",
      },
    );
    expect(mockDbQuery.mock.calls.some((call) => /INSERT INTO places/i.test(String(call[0])))).toBe(
      true,
    );
    expect(mockDbQuery.mock.calls.some((call) => /INSERT INTO order_place_links/i.test(String(call[0])))).toBe(
      true,
    );
    expect(mockDbQuery.mock.calls.some((call) => /INSERT INTO place_order_address_contexts/i.test(String(call[0])))).toBe(
      true,
    );
    expect(mockDbQuery.mock.calls.some((call) => /INSERT INTO place_aliases/i.test(String(call[0])))).toBe(
      false,
    );
    expect(mockGeocodeAddress).toHaveBeenCalledWith(
      "Hamra",
      expect.objectContaining({
        aliases: [],
        city: "beirut",
      }),
      undefined,
      {},
    );

    const assessmentCallOrder = mockAssessPlaceValidity.mock.invocationCallOrder[0];
    const insertCallIndex = mockDbQuery.mock.calls.findIndex((call) =>
      /INSERT INTO places/i.test(String(call[0])),
    );
    expect(assessmentCallOrder).toBeLessThan(
      mockDbQuery.mock.invocationCallOrder[insertCallIndex]!,
    );
  });

  it("links an existing legitimate place without asking AI to reassess it", async () => {
    mockDbQuery.mockImplementation((sql: string) => {
      if (/SELECT id FROM places/i.test(sql)) {
        return Promise.resolve({ rows: [{ id: "place-existing" }] });
      }
      return Promise.resolve({ rows: [] });
    });
    mockAssessPlaceValidity.mockResolvedValue({
      valid: false,
      reason: "Should not be consulted for an existing match.",
    });

    await linkOrderToAddressBook("order-existing", "ws-1", {
      address: "12 Main Street",
    });

    expect(mockAssessPlaceValidity).not.toHaveBeenCalled();
    const linkCall = mockDbQuery.mock.calls.find((call) =>
      /INSERT INTO order_place_links/i.test(String(call[0])),
    );
    expect(linkCall?.[1]).toEqual(["ws-1", "order-existing", "place-existing"]);
  });

  it("does not fuzzy-match a generic single-word place name to an unrelated place across the city", async () => {
    mockDbQuery.mockImplementation((sql: string) => {
      if (/FROM place_order_address_contexts/i.test(sql)) return Promise.resolve({ rows: [] });
      if (/SELECT id FROM places/i.test(sql)) return Promise.resolve({ rows: [] }); // no exact title match
      if (/FROM place_aliases pa/i.test(sql)) return Promise.resolve({ rows: [] });
      if (/SELECT id, canonical_name FROM places/i.test(sql)) {
        // If the generic-name gate were missing, this unrelated "Home" would
        // fuzzy-match and silently reuse a different customer's place.
        return Promise.resolve({ rows: [{ id: "unrelated-home", canonical_name: "Home" }] });
      }
      if (/INSERT INTO places/i.test(sql)) return Promise.resolve({ rows: [{ id: "place-new-home" }] });
      return Promise.resolve({ rows: [] });
    });
    mockAssessPlaceValidity.mockResolvedValue({
      valid: true,
      reason: "Plausible delivery location.",
    });

    await linkOrderToAddressBook("order-generic-name", "ws-1", { address: "Home" });

    // AI must be consulted for a generic name instead of trusting a fuzzy
    // title match, and a new place is created rather than reusing "unrelated-home".
    expect(mockAssessPlaceValidity).toHaveBeenCalled();
    expect(
      mockDbQuery.mock.calls.some((call) =>
        /SELECT id, canonical_name FROM places/i.test(String(call[0])),
      ),
    ).toBe(false);
    const linkCall = mockDbQuery.mock.calls.find((call) =>
      /INSERT INTO order_place_links/i.test(String(call[0])),
    );
    expect(linkCall?.[1]).toEqual(["ws-1", "order-generic-name", "place-new-home"]);
  });

  it("does not reuse an unrelated place with the exact same generic name, even on an exact title match", async () => {
    mockDbQuery.mockImplementation((sql: string) => {
      if (/FROM place_order_address_contexts/i.test(sql)) return Promise.resolve({ rows: [] });
      if (/SELECT id FROM places/i.test(sql)) {
        // If the generic-name gate did not also cover the exact-title lookup,
        // this unrelated "Home" would be reused purely on name equality.
        return Promise.resolve({ rows: [{ id: "unrelated-home-exact" }] });
      }
      if (/FROM place_aliases pa/i.test(sql)) return Promise.resolve({ rows: [] });
      if (/SELECT id, canonical_name FROM places/i.test(sql)) return Promise.resolve({ rows: [] });
      if (/INSERT INTO places/i.test(sql)) return Promise.resolve({ rows: [{ id: "place-new-home-2" }] });
      return Promise.resolve({ rows: [] });
    });
    mockAssessPlaceValidity.mockResolvedValue({
      valid: true,
      reason: "Plausible delivery location.",
    });

    await linkOrderToAddressBook("order-generic-name-exact", "ws-1", { address: "Home" });

    // AI must be consulted and a new place created — the exact-title match on
    // a bare generic name is not trustworthy corroboration by itself.
    expect(mockAssessPlaceValidity).toHaveBeenCalled();
    const linkCall = mockDbQuery.mock.calls.find((call) =>
      /INSERT INTO order_place_links/i.test(String(call[0])),
    );
    expect(linkCall?.[1]).toEqual(["ws-1", "order-generic-name-exact", "place-new-home-2"]);
    expect(linkCall?.[1]).not.toContain("unrelated-home-exact");
  });

  it("does not reuse an unrelated place via a generic alias match on a bare generic name", async () => {
    mockDbQuery.mockImplementation((sql: string) => {
      if (/FROM place_order_address_contexts/i.test(sql)) return Promise.resolve({ rows: [] });
      if (/SELECT id FROM places/i.test(sql)) return Promise.resolve({ rows: [] });
      if (/FROM place_aliases pa/i.test(sql)) {
        // If the generic-name gate did not also cover the alias lookup, this
        // unrelated place (aliased "Home") would be reused purely on the
        // incoming address matching a stored generic alias.
        return Promise.resolve({ rows: [{ place_id: "unrelated-home-alias" }] });
      }
      if (/SELECT id, canonical_name FROM places/i.test(sql)) return Promise.resolve({ rows: [] });
      if (/INSERT INTO places/i.test(sql)) return Promise.resolve({ rows: [{ id: "place-new-home-3" }] });
      return Promise.resolve({ rows: [] });
    });
    mockAssessPlaceValidity.mockResolvedValue({
      valid: true,
      reason: "Plausible delivery location.",
    });

    await linkOrderToAddressBook("order-generic-name-alias", "ws-1", { address: "Villa" });

    expect(mockAssessPlaceValidity).toHaveBeenCalled();
    const linkCall = mockDbQuery.mock.calls.find((call) =>
      /INSERT INTO order_place_links/i.test(String(call[0])),
    );
    expect(linkCall?.[1]).toEqual(["ws-1", "order-generic-name-alias", "place-new-home-3"]);
    expect(linkCall?.[1]).not.toContain("unrelated-home-alias");
  });

  it("matches a repeated raw delivery address from the private context ledger", async () => {
    mockDbQuery.mockImplementation((sql: string) => {
      if (/FROM place_order_address_contexts/i.test(sql)) {
        return Promise.resolve({ rows: [{ place_id: "place-private-match" }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await linkOrderToAddressBook("order-private-match", "ws-1", {
      address: "Cedar Heights, Floor 4, Apt 12B",
    });

    expect(mockAssessPlaceValidity).not.toHaveBeenCalled();
    const contextLookup = mockDbQuery.mock.calls.find((call) =>
      /FROM place_order_address_contexts/i.test(String(call[0])),
    );
    expect(contextLookup?.[1]).toEqual([
      "ws-1",
      "cedar heights floor 4 apartment 12b",
      null,
    ]);
    const linkCall = mockDbQuery.mock.calls.find((call) =>
      /INSERT INTO order_place_links/i.test(String(call[0])),
    );
    expect(linkCall?.[1]).toEqual(["ws-1", "order-private-match", "place-private-match"]);
  });

  it("leaves an AI-invalid unmatched candidate unlinked and unpersisted", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [] }) // already linked
      .mockResolvedValueOnce({ rows: [] }) // exact place
      .mockResolvedValueOnce({ rows: [] }); // similarity candidates
    mockAssessPlaceValidity.mockResolvedValue({
      valid: false,
      reason: "This is a delivery instruction, not a location.",
    });

    await linkOrderToAddressBook("order-ai-invalid", "ws-1", {
      address: "Meet the driver outside",
    });

    expect(mockDbQuery.mock.calls.some((call) => /INSERT INTO places/i.test(String(call[0])))).toBe(
      false,
    );
    expect(mockDbQuery.mock.calls.some((call) => /INSERT INTO order_place_links/i.test(String(call[0])))).toBe(
      false,
    );
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "ai_invalid",
        assessmentReason: "This is a delivery instruction, not a location.",
      }),
      expect.any(String),
    );
  });

  it("leaves an unmatched candidate unlinked when AI assessment fails", async () => {
    mockDbQuery
      .mockResolvedValueOnce({ rows: [] }) // already linked
      .mockResolvedValueOnce({ rows: [] }) // exact place
      .mockResolvedValueOnce({ rows: [] }); // similarity candidates
    mockAssessPlaceValidity.mockRejectedValue(new Error("AI service unavailable"));

    await expect(
      linkOrderToAddressBook("order-ai-failure", "ws-1", { address: "Near City Mall" }),
    ).resolves.toBeUndefined();

    expect(mockDbQuery.mock.calls.some((call) => /INSERT INTO places/i.test(String(call[0])))).toBe(
      false,
    );
    expect(mockDbQuery.mock.calls.some((call) => /INSERT INTO order_place_links/i.test(String(call[0])))).toBe(
      false,
    );
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: "order-ai-failure",
        reason: "ai_assessment_failed",
      }),
      expect.stringContaining("AI assessment failure"),
    );
  });

  it("recognizes AUH delivery text without exposing patient room details and geocodes the canonical hospital identity", async () => {
    mockDbQuery.mockImplementation((sql: string) => {
      if (/INSERT INTO places/i.test(sql)) return Promise.resolve({ rows: [{ id: "place-auh" }] });
      return Promise.resolve({ rows: [] });
    });

    await linkOrderToAddressBook(
      "order-auh",
      "ws-1",
      {
        address: "American University Hospital (A.U.H.), Ward C, Room 412",
        city: "Beirut",
        country: "Lebanon",
      },
      { deliveryInstructions: "For patient Jane Doe" },
    );
    await flushBackgroundWork();

    expect(mockAssessPlaceValidity).not.toHaveBeenCalled();
    const insert = mockDbQuery.mock.calls.find((call) => /INSERT INTO places/i.test(String(call[0])));
    expect(insert?.[1]).toEqual(["ws-1", "AUH Hospital", "hospital", null, "LB"]);
    expect(mockGeocodeAddress).toHaveBeenCalledWith(
      "AUH Hospital",
      expect.objectContaining({ canonicalAddress: "AUH Hospital" }),
      undefined,
      {},
    );
  });

  it("does not infer a hospital identity from patient delivery prose", async () => {
    await linkOrderToAddressBook("order-private-hospital", "ws-1", {
      address: "Patient Jane Doe at the hospital",
    });

    expect(mockAssessPlaceValidity).not.toHaveBeenCalled();
    expect(mockGeocodeAddress).not.toHaveBeenCalled();
    expect(
      mockDbQuery.mock.calls.some((call) => /INSERT INTO places/i.test(String(call[0]))),
    ).toBe(false);
  });

  it("matches a recognized AUH alias and safely repairs only the automatic Residence default", async () => {
    mockDbQuery.mockImplementation((sql: string) => {
      if (/FROM place_order_address_contexts/i.test(sql)) return Promise.resolve({ rows: [] });
      if (/SELECT id FROM places/i.test(sql)) return Promise.resolve({ rows: [] });
      if (/FROM place_aliases pa/i.test(sql)) return Promise.resolve({ rows: [{ place_id: "place-auh-legacy" }] });
      if (/UPDATE places\s+SET place_type = 'hospital'/i.test(sql)) {
        return Promise.resolve({ rows: [{ id: "place-auh-legacy" }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await linkOrderToAddressBook("order-auh-alias", "ws-1", {
      address: "AUH Hospital, Floor 4, Room 412",
    });

    expect(mockAssessPlaceValidity).not.toHaveBeenCalled();
    expect(
      mockDbQuery.mock.calls.some((call) =>
        /INSERT INTO place_verification_events/i.test(String(call[0])) &&
        String(call[1]?.[2]).includes("Promoted an automatic Residence to Hospital"),
      ),
    ).toBe(true);
    expect(
      mockDbQuery.mock.calls.some((call) =>
        /UPDATE places\s+SET place_type = 'hospital'[\s\S]*canonical_name_source = 'auto'/i.test(String(call[0])),
      ),
    ).toBe(true);
  });
});

describe("linkOrderToAddressBook — hotel detection", () => {
  it("classifies a clearly named hotel, skips AI assessment, and geocodes the hotel identity", async () => {
    mockDbQuery.mockImplementation((sql: string) => {
      if (/INSERT INTO places/i.test(sql)) return Promise.resolve({ rows: [{ id: "place-hyatt" }] });
      return Promise.resolve({ rows: [] });
    });

    await linkOrderToAddressBook("order-hotel", "ws-1", {
      address: "Grand Hyatt Hotel, Floor 12, Guest: Smith",
      city: "Beirut",
    });
    await flushBackgroundWork();

    expect(mockAssessPlaceValidity).not.toHaveBeenCalled();
    const insert = mockDbQuery.mock.calls.find((call) => /INSERT INTO places/i.test(String(call[0])));
    expect(insert?.[1]).toEqual(["ws-1", "Grand Hyatt Hotel", "hotel", null, null]);
    expect(mockGeocodeAddress).toHaveBeenCalledWith(
      "Grand Hyatt Hotel",
      expect.objectContaining({ canonicalAddress: "Grand Hyatt Hotel" }),
      undefined,
      {},
    );
  });

  it("does not infer a hospital identity from patient delivery prose", async () => {
    await linkOrderToAddressBook("order-private-hospital", "ws-1", {
      address: "Patient Jane Doe at the hospital",
    });

    expect(mockAssessPlaceValidity).not.toHaveBeenCalled();
    expect(mockGeocodeAddress).not.toHaveBeenCalled();
    expect(
      mockDbQuery.mock.calls.some((call) => /INSERT INTO places/i.test(String(call[0]))),
    ).toBe(false);
  });

  it("matches a recognized AUH alias and safely repairs only the automatic Residence default", async () => {
    mockDbQuery.mockImplementation((sql: string) => {
      if (/FROM place_order_address_contexts/i.test(sql)) return Promise.resolve({ rows: [] });
      if (/SELECT id FROM places/i.test(sql)) return Promise.resolve({ rows: [] });
      if (/FROM place_aliases pa/i.test(sql)) return Promise.resolve({ rows: [{ place_id: "place-auh-legacy" }] });
      if (/UPDATE places\s+SET place_type = 'hospital'/i.test(sql)) {
        return Promise.resolve({ rows: [{ id: "place-auh-legacy" }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await linkOrderToAddressBook("order-auh-alias", "ws-1", {
      address: "AUH Hospital, Floor 4, Room 412",
    });

    expect(mockAssessPlaceValidity).not.toHaveBeenCalled();
    expect(
      mockDbQuery.mock.calls.some((call) =>
        /INSERT INTO place_verification_events/i.test(String(call[0])) &&
        String(call[1]?.[2]).includes("Promoted an automatic Residence to Hospital"),
      ),
    ).toBe(true);
    expect(
      mockDbQuery.mock.calls.some((call) =>
        /UPDATE places\s+SET place_type = 'hospital'[\s\S]*canonical_name_source = 'auto'/i.test(String(call[0])),
      ),
    ).toBe(true);
  });
});

describe("assessAndGeocode — AI verification semantics", () => {
  it("fails mixed-country evidence closed before AI or map providers", async () => {
    mockDbQuery.mockImplementation((sql: string) => {
      if (/WITH locked_place/i.test(sql)) return Promise.resolve({ rows: [{ id: "event-1" }] });
      return Promise.resolve({ rows: [] });
    });

    await expect(
      assessAndGeocode(
        "place-conflict",
        "12 Main Street",
        [],
        "ws-1",
        undefined,
        { geographyConflict: true },
      ),
    ).resolves.toMatchObject({
      status: "unresolved",
      reason: "geography_conflict",
      coordinatesCleared: true,
      latitude: null,
      longitude: null,
    });
    expect(mockAssessPlaceValidity).not.toHaveBeenCalled();
    expect(mockGeocodeAddress).not.toHaveBeenCalled();
  });
  it("passes structured landmark targeting hints through the shared assessment path", async () => {
    const locationHints = {
      searchAnchor: "Pain D'Or",
      anchorType: "landmark" as const,
      area: "Zarif",
    };
    mockAssessPlaceValidity.mockResolvedValue({
      valid: true,
      reason: "Explicit named landmark.",
      locationHints,
    });
    mockGeocodeAddress.mockResolvedValue(null);
    mockDbQuery.mockResolvedValue({ rows: [] });

    await assessAndGeocode(
      "place-landmark",
      "Al Zarif next to Pain Dor- Al rawda Building- 14th",
      [],
      "ws-1",
      undefined,
      { area: "Zarif", city: "Beirut", country: "Lebanon" },
    );

    expect(mockGeocodeAddress).toHaveBeenCalledWith(
      "Al Zarif next to Pain Dor- Al rawda Building- 14th",
      {
        aliases: [],
        area: "Zarif",
        city: "Beirut",
        country: "Lebanon",
      },
      locationHints,
      {},
    );
  });

  it("saves a validated approximate result as AI verified when the place is unverified", async () => {
    mockGeocodeAddress.mockResolvedValue({
      lat: 24.514,
      lng: 54.38,
      matchType: "approximate",
       precision: "exact",
      matchedLocation: "Saadiyat Beach Villas, Abu Dhabi, United Arab Emirates",
      query: "Saadiyat, Abu Dhabi, AE",
    });
    mockDbQuery.mockImplementation((sql: string) => {
      if (/WITH locked_place/i.test(sql)) {
        return Promise.resolve({ rows: [{ id: "event-approximate-1" }] });
      }
      if (/SELECT verification_state/i.test(sql)) {
        return Promise.resolve({ rows: [{ verification_state: "unverified" }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(
      assessAndGeocode(
        "place-estimated",
        "Saadiyat Beach Villas",
        ["Saadiyat villas"],
        "ws-1",
        { valid: true, reason: "Named villa community." },
        { area: "Saadiyat", city: "Abu Dhabi", country: "AE" },
      ),
     ).resolves.toMatchObject({
       status: "exact",
       coordinatesUpdated: true,
     });

    const atomicWrite = mockDbQuery.mock.calls.find((call) =>
      /UPDATE places p[\s\S]*INSERT INTO place_verification_events/i.test(String(call[0])),
    );
    expect(atomicWrite?.[1]).toEqual([
      24.514,
      54.38,
       "exact",
      "place-estimated",
      "ws-1",
       expect.stringContaining("AI verified exact map match: Saadiyat Beach Villas"),
      "nominatim",
      "Saadiyat, Abu Dhabi, AE",
      "Saadiyat Beach Villas, Abu Dhabi, United Arab Emirates",
      undefined,
      0,
      "[]",
      "[]",
      "{}",
    ]);
    expect(String(atomicWrite?.[0])).toContain("'map_pin_updated'");
    expect(String(atomicWrite?.[0])).toContain("'ai_verified'::place_verification_state");
  });

  it("saves a validated exact result as AI verified when the place is unverified", async () => {
    mockGeocodeAddress.mockResolvedValue({
      lat: 24.514,
      lng: 54.38,
      matchType: "exact",
      matchedLocation: "Saadiyat Beach Villas, Abu Dhabi, United Arab Emirates",
      query: "Saadiyat Beach Villas, Abu Dhabi, AE",
    });
    mockDbQuery.mockImplementation((sql: string) => {
      if (/WITH locked_place/i.test(sql)) {
        return Promise.resolve({ rows: [{ id: "event-exact-1" }] });
      }
      if (/SELECT verification_state/i.test(sql)) {
        return Promise.resolve({ rows: [{ verification_state: "unverified" }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(
      assessAndGeocode(
        "place-exact",
        "Saadiyat Beach Villas",
        ["Saadiyat villas"],
        "ws-1",
        { valid: true, reason: "Named villa community." },
        { area: "Saadiyat", city: "Abu Dhabi", country: "AE" },
      ),
    ).resolves.toMatchObject({
      status: "exact",
      matchedLocation: "Saadiyat Beach Villas, Abu Dhabi, United Arab Emirates",
      coordinatesUpdated: true,
    });

    const atomicWrite = mockDbQuery.mock.calls.find((call) =>
      /UPDATE places p[\s\S]*INSERT INTO place_verification_events/i.test(String(call[0])),
    );
    expect(atomicWrite?.[1]).toEqual([
      24.514,
      54.38,
      "exact",
      "place-exact",
      "ws-1",
      expect.stringContaining("AI verified exact map match: Saadiyat Beach Villas"),
      "nominatim",
      "Saadiyat Beach Villas, Abu Dhabi, AE",
      "Saadiyat Beach Villas, Abu Dhabi, United Arab Emirates",
      undefined,
      0,
      "[]",
      "[]",
      "{}",
    ]);
    expect(String(atomicWrite?.[0])).toContain("'map_pin_updated'");
    expect(String(atomicWrite?.[0])).toContain("'ai_verified'::place_verification_state");
    expect(String(atomicWrite?.[0])).toContain("IN ('unverified', 'estimated', 'ai_verified')");
    expect(String(atomicWrite?.[0])).not.toContain("checkout_ready");
  });

  it("never overwrites a staff-verified place even when a geocoder finds a result", async () => {
    mockGeocodeAddress.mockResolvedValue({
      lat: 33.9,
      lng: 35.5,
      matchType: "exact",
      matchedLocation: "Hamra Main Street, Beirut, Lebanon",
      query: "Hamra, Beirut, Lebanon",
    });
    mockDbQuery.mockImplementation((sql: string) => {
      if (/WITH locked_place/i.test(sql)) {
        return Promise.resolve({ rows: [] });
      }
      if (/SELECT verification_state, coordinate_source/i.test(sql)) {
        return Promise.resolve({ rows: [{ verification_state: "staff_verified" }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(
      assessAndGeocode(
        "place-protected",
        "Hamra Main Street",
        [],
        "ws-1",
        { valid: true, reason: "Street address." },
      ),
    ).resolves.toMatchObject({ status: "exact", latitude: null, longitude: null });

    const audit = mockDbQuery.mock.calls.find((call) =>
      /VALUES \(\$1, 'ai_assessed'/i.test(String(call[0])),
    );
    expect(audit?.[1]).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Existing protected coordinates were preserved"),
      ]),
    );
  });

  it("leaves a delivery-verified place untouched when the atomic write sees its protected state", async () => {
    mockGeocodeAddress.mockResolvedValue({
      lat: 24.5,
      lng: 54.3,
      matchType: "approximate",
       precision: "exact",
      matchedLocation: "Saadiyat, Abu Dhabi, United Arab Emirates",
      query: "Saadiyat, Abu Dhabi, AE",
    });
    mockDbQuery.mockImplementation((sql: string) => {
      if (/WITH locked_place/i.test(sql)) return Promise.resolve({ rows: [] });
      if (/SELECT verification_state, coordinate_source/i.test(sql)) {
        return Promise.resolve({ rows: [{ verification_state: "delivery_verified" }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(
      assessAndGeocode(
        "place-delivery-verified",
        "Saadiyat Beach Villas",
        [],
        "ws-1",
        { valid: true, reason: "Named community." },
      ),
     ).resolves.toMatchObject({
       status: "exact",
       coordinatesUpdated: false,
       preservedVerifiedCoordinates: true,
     });
    expect(
      mockDbQuery.mock.calls.some((call) => /VALUES \(\$1, 'ai_assessed'/i.test(String(call[0]))),
    ).toBe(true);
  });

  it("classifies a concurrent manual pin as protected even if its state is still eligible", async () => {
    mockGeocodeAddress.mockResolvedValue({
      lat: 33.9,
      lng: 35.5,
      matchType: "exact",
      matchedLocation: "12 Main Street, Beirut, Lebanon",
      query: "12 Main Street, Beirut, Lebanon",
    });
    mockDbQuery.mockImplementation((sql: string) => {
      if (/WITH locked_place/i.test(sql)) return Promise.resolve({ rows: [] });
      if (/SELECT verification_state, coordinate_source/i.test(sql)) {
        return Promise.resolve({
          rows: [{
            verification_state: "unverified",
            coordinate_source: "manual",
            google_place_id: null,
            source_order_id: null,
          }],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(
      assessAndGeocode(
        "place-manual-race",
        "12 Main Street",
        [],
        "ws-1",
        { valid: true, reason: "Street address." },
      ),
    ).resolves.toMatchObject({
      status: "exact",
      coordinatesUpdated: false,
      preservedVerifiedCoordinates: true,
    });
  });

  it("does not write a successful pin event when the place is unavailable at write time", async () => {
    mockGeocodeAddress.mockResolvedValue({
      lat: 24.5,
      lng: 54.3,
      matchType: "exact",
      matchedLocation: "Saadiyat Beach Villas, Abu Dhabi, United Arab Emirates",
      query: "Saadiyat Beach Villas, Abu Dhabi, AE",
    });
    mockDbQuery.mockResolvedValue({ rows: [] });

    await expect(
      assessAndGeocode(
        "place-gone",
        "Saadiyat Beach Villas",
        [],
        "ws-1",
        { valid: true, reason: "Named community." },
      ),
    ).resolves.toMatchObject({ status: "unresolved", reason: "place_unavailable" });

    expect(
      mockDbQuery.mock.calls.filter((call) => /INSERT INTO place_verification_events/i.test(String(call[0]))),
    ).toHaveLength(1);
    expect(String(mockDbQuery.mock.calls[0]?.[0])).toContain("WITH locked_place");
  });

  it("records an unresolved valid address without changing coordinates", async () => {
    mockGeocodeAddress.mockResolvedValue(null);
    mockDbQuery.mockResolvedValue({ rows: [] });

    await expect(
      assessAndGeocode(
        "place-unresolved",
        "Near the old bridge",
        [],
        "ws-1",
        { valid: true, reason: "Informal landmark address." },
      ),
    ).resolves.toMatchObject({ status: "unresolved" });

    const guardedClear = mockDbQuery.mock.calls.find((call) =>
      /UPDATE places p[\s\S]*latitude = NULL/i.test(String(call[0])),
    );
    expect(String(guardedClear?.[0])).toContain("locked_place.coordinate_source IN ('ai', 'legacy')");
    expect(String(guardedClear?.[0])).toContain("locked_place.google_place_id IS NULL");
    expect(String(guardedClear?.[0])).toContain("locked_place.source_order_id IS NULL");
    expect(String(guardedClear?.[0])).not.toContain("'manual'");
    expect(String(guardedClear?.[0])).not.toContain("'gps'");
    expect(String(guardedClear?.[0])).not.toContain("'import'");
    expect(
      mockDbQuery.mock.calls.some((call) =>
        Array.isArray(call[1]) &&
        String(call[1][1]).includes("no validated map result passed the locality safeguards"),
      ),
    ).toBe(true);
  });

  it("clears an unsupported stale AI pin, disables checkout, and audits the review reset atomically", async () => {
    mockGeocodeAddress.mockResolvedValue(null);
    mockDbQuery.mockImplementation((sql: string) => {
      if (/WITH locked_place/i.test(sql)) {
        return Promise.resolve({ rows: [{ id: "clear-event-1" }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(
      assessAndGeocode(
        "place-stale-ai",
        "Cedar Heights, Main Street",
        [],
        "ws-1",
        { valid: true, reason: "Plausible building address." },
        { city: "Beirut", country: "Lebanon" },
      ),
    ).resolves.toMatchObject({
      status: "unresolved",
      latitude: null,
      longitude: null,
      coordinatesCleared: true,
    });

    const atomicClear = mockDbQuery.mock.calls.find((call) =>
      /WITH locked_place[\s\S]*'map_pin_cleared'/i.test(String(call[0])),
    );
    expect(String(atomicClear?.[0])).toContain("latitude = NULL");
    expect(String(atomicClear?.[0])).toContain("longitude = NULL");
    expect(String(atomicClear?.[0])).toContain("verification_state = 'unverified'");
    expect(String(atomicClear?.[0])).toContain("checkout_ready = false");
    expect(String(atomicClear?.[0])).toContain("'ai', $4::text");
    expect(String(atomicClear?.[0])).toContain("'correction_reason', $4::text");
    expect(atomicClear?.[1]).toEqual([
      "place-stale-ai",
      "ws-1",
      false,
      expect.stringContaining("returned to review"),
    ]);
  });
});

describe("assessAndGeocode — failure classification", () => {
  it("classifies a network/timeout error as a retryable provider failure, not an application bug", async () => {
    mockAssessPlaceValidity.mockResolvedValue({ valid: true, reason: "Plausible address." });
    const networkError = new Error("fetch failed: ETIMEDOUT");
    mockGeocodeAddress.mockRejectedValue(networkError);

    await expect(
      assessAndGeocode("place-network", "12 Main Street", [], "ws-1", undefined, {
        city: "Beirut",
        country: "LB",
      }),
    ).resolves.toMatchObject({
      status: "unresolved",
      reason: "assessment_failed",
      failure: {
        provider: "unknown",
        failureType: "timeout_network",
        retryable: true,
      },
    });
  });

  it("classifies an unexpected application exception as an application error, never a provider outage", async () => {
    mockAssessPlaceValidity.mockResolvedValue({ valid: true, reason: "Plausible address." });
    const bug = new Error("Cannot read properties of undefined (reading 'lat')");
    mockGeocodeAddress.mockRejectedValue(bug);

    await expect(
      assessAndGeocode("place-app-bug", "12 Main Street", [], "ws-1", undefined, {
        city: "Beirut",
        country: "LB",
      }),
    ).resolves.toMatchObject({
      status: "unresolved",
      reason: "application_error",
      failure: {
        provider: "application",
        failureType: "application_error",
        retryable: true,
        message: bug.message,
      },
    });
  });

  it("classifies an AI-assessment exception (not a map-provider call) as an application error", async () => {
    const bug = new Error("Unexpected AI response shape");
    mockAssessPlaceValidity.mockRejectedValue(bug);

    await expect(
      assessAndGeocode("place-ai-bug", "12 Main Street", [], "ws-1", undefined, {
        city: "Beirut",
        country: "LB",
      }),
    ).resolves.toMatchObject({
      status: "unresolved",
      reason: "application_error",
      failure: {
        provider: "application",
        failureType: "application_error",
      },
    });
    expect(mockGeocodeAddress).not.toHaveBeenCalled();
  });

  it("classifies a network-shaped PostgreSQL failure in a non-final-write path as a database failure, never a provider outage", async () => {
    // A dropped/reset PostgreSQL connection can produce the exact same
    // message shape (ECONNRESET, "socket hang up") that isNetworkLikeError
    // uses to detect a map-provider transport failure. This must never reach
    // that classifier: it has to be tagged as a database/persistence failure
    // before the outer catch runs, or it would inflate provider_failures and
    // could trip the reverification circuit breaker for something that has
    // nothing to do with map-provider availability.
    mockAssessPlaceValidity.mockResolvedValue({ valid: true, reason: "Plausible address." });
    mockGeocodeAddress.mockResolvedValue(null); // no-result path — reaches clearUnsupportedAiPin's DB write
    mockDbQuery.mockRejectedValue(new Error("Connection terminated unexpectedly: ECONNRESET"));

    const result = await assessAndGeocode("place-db-network", "12 Main Street", [], "ws-1", undefined, {
      city: "Beirut",
      country: "LB",
    });

    expect(result).toMatchObject({
      status: "unresolved",
      reason: "persistence_failed",
      failure: {
        provider: "database",
        failureType: "database_write",
      },
    });
  });

  it("classifies a network-shaped PostgreSQL failure in the invalid-address path as a database failure", async () => {
    mockAssessPlaceValidity.mockResolvedValue({ valid: false, reason: "No usable address evidence." });
    mockDbQuery.mockRejectedValue(new Error("socket hang up"));

    const result = await assessAndGeocode("place-db-network-invalid", "x", [], "ws-1", undefined, {
      city: "Beirut",
      country: "LB",
    });

    expect(result).toMatchObject({
      status: "unresolved",
      reason: "persistence_failed",
      failure: {
        provider: "database",
        failureType: "database_write",
      },
    });
  });
});

describe("linkOrderToAddressBook — Arabic translation", () => {
  it("translates an Arabic canonical title to English and stores the original as an ar alias", async () => {
    mockTranslateAddressToEnglish.mockResolvedValue("Hamra Street");
    mockAssessPlaceValidity.mockResolvedValue({ valid: true, reason: "Valid Arabic address." });
    mockDbQuery.mockImplementation((sql: string) => {
      if (/INSERT INTO places\b/i.test(sql)) return Promise.resolve({ rows: [{ id: "place-ar-1" }] });
      return Promise.resolve({ rows: [] });
    });

    await linkOrderToAddressBook("order-ar", "ws-1", {
      address: "شارع الحمراء",
      city: "Beirut",
      country: "Lebanon",
    });

    // Place must be created with the English title
    const insert = mockDbQuery.mock.calls.find((call) => /INSERT INTO places\b/i.test(String(call[0])));
    expect(insert?.[1]).toEqual(expect.arrayContaining(["ws-1", "Hamra Street"]));

    // Arabic original must be preserved as a language-tagged alias.
    // 'ar' and 'approved_transliteration' are SQL literals in the query string,
    // not bound parameters, so we check the SQL for them.
    const aliasInsert = mockDbQuery.mock.calls.find(
      (call) =>
        /INSERT INTO place_aliases/i.test(String(call[0])) &&
        String(call[0]).includes("approved_transliteration"),
    );
    expect(aliasInsert).toBeDefined();
    // Bound params: [place_id, alias_text, normalized_alias]
    expect(aliasInsert?.[1]).toEqual(
      expect.arrayContaining(["place-ar-1", "شارع الحمراء"]),
    );
  });

  it("falls back to storing the original Arabic title when translation returns null (fail-open)", async () => {
    // mockTranslateAddressToEnglish already returns null from beforeEach default
    mockAssessPlaceValidity.mockResolvedValue({ valid: true, reason: "Valid Arabic address." });
    mockDbQuery.mockImplementation((sql: string) => {
      if (/INSERT INTO places\b/i.test(sql)) return Promise.resolve({ rows: [{ id: "place-ar-2" }] });
      return Promise.resolve({ rows: [] });
    });

    await linkOrderToAddressBook("order-ar-fail", "ws-1", {
      address: "شارع الحمراء",
      city: "Beirut",
    });

    // Place must be created with the original Arabic title (fail-open, no crash)
    const insert = mockDbQuery.mock.calls.find((call) => /INSERT INTO places\b/i.test(String(call[0])));
    expect(insert?.[1]).toEqual(expect.arrayContaining(["ws-1", "شارع الحمراء"]));

    // No approved_transliteration alias because no translation occurred
    const aliasInsert = mockDbQuery.mock.calls.find(
      (call) =>
        /INSERT INTO place_aliases/i.test(String(call[0])) &&
        Array.isArray(call[1]) &&
        (call[1] as unknown[]).includes("approved_transliteration"),
    );
    expect(aliasInsert).toBeUndefined();
  });

  it("rejects a translation result that is still Arabic", async () => {
    mockTranslateAddressToEnglish.mockResolvedValue("شارع الحمرا في بيروت");
    mockAssessPlaceValidity.mockResolvedValue({ valid: true, reason: "Valid Arabic address." });
    mockDbQuery.mockImplementation((sql: string) => {
      if (/INSERT INTO places\b/i.test(sql)) return Promise.resolve({ rows: [{ id: "place-ar-3" }] });
      return Promise.resolve({ rows: [] });
    });

    await linkOrderToAddressBook("order-ar-invalid-output", "ws-1", {
      address: "شارع الحمراء",
      city: "Beirut",
    });

    const insert = mockDbQuery.mock.calls.find((call) =>
      /INSERT INTO places\b/i.test(String(call[0])),
    );
    expect(insert?.[1]).toEqual(expect.arrayContaining(["ws-1", "شارع الحمراء"]));
    expect(mockDbQuery.mock.calls.some((call) =>
      /approved_transliteration/i.test(String(call[0])),
    )).toBe(false);
  });

  it("does not call translation for a Latin-script address", async () => {
    mockAssessPlaceValidity.mockResolvedValue({ valid: true, reason: "Valid Latin address." });
    mockDbQuery.mockImplementation((sql: string) => {
      if (/INSERT INTO places\b/i.test(sql)) return Promise.resolve({ rows: [{ id: "place-latin" }] });
      return Promise.resolve({ rows: [] });
    });

    await linkOrderToAddressBook("order-latin", "ws-1", {
      address: "Hamra Street, Beirut",
    });

    expect(mockTranslateAddressToEnglish).not.toHaveBeenCalled();
    const aliasInsert = mockDbQuery.mock.calls.find(
      (call) =>
        /INSERT INTO place_aliases/i.test(String(call[0])) &&
        Array.isArray(call[1]) &&
        (call[1] as unknown[]).includes("approved_transliteration"),
    );
    expect(aliasInsert).toBeUndefined();
  });

  it("resolves a subsequent Arabic order to an existing place via the stored Arabic alias", async () => {
    // Simulate a case where the place already exists with English canonical name and
    // the Arabic alias is stored. The subsequent order arrives with the same Arabic
    // compact title, raw address differs so context lookup misses, and the alias
    // query is the path that should resolve it.
    // The translation mock returns a slightly different English form to ensure we
    // are NOT hitting the exact canonical_name match — only the alias path.
    mockTranslateAddressToEnglish.mockResolvedValue("Hamra St");

    const existingId = "place-ar-existing";

    mockDbQuery.mockImplementation((sql: string, params?: unknown[]) => {
      const s = String(sql);

      // Context lookup: no match (fresh raw address)
      if (/FROM place_order_address_contexts/i.test(s)) {
        return Promise.resolve({ rows: [] });
      }

      // Exact canonical_name match: no match (simulate slight translation variance)
      if (/lower\(canonical_name\)/i.test(s)) {
        return Promise.resolve({ rows: [] });
      }

      // Alias lookup: return the existing place when the normalized Arabic form is
      // present in the candidates array — this is the behaviour being tested.
      if (/FROM place_aliases/i.test(s) && Array.isArray(params)) {
        const candidates = params[2] as string[];
        if (Array.isArray(candidates) && candidates.includes("شارع الحمراء")) {
          return Promise.resolve({ rows: [{ place_id: existingId }] });
        }
      }

      return Promise.resolve({ rows: [] });
    });

    await linkOrderToAddressBook("order-ar-repeat", "ws-1", {
      address: "شارع الحمراء",
      city: "Beirut",
    });

    // No new place should be created — resolved via alias
    expect(
      mockDbQuery.mock.calls.some((call) => /INSERT INTO places\b/i.test(String(call[0]))),
    ).toBe(false);

    // The order must be linked to the existing place found via the Arabic alias
    const linkCall = mockDbQuery.mock.calls.find((call) =>
      /INSERT INTO order_place_links/i.test(String(call[0])),
    );
    expect(linkCall?.[1]).toEqual(expect.arrayContaining([existingId]));
  });
});
