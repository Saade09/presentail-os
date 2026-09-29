import { describe, expect, it } from "vitest";
import {
  AUH_HOSPITAL_CANONICAL_NAME,
  classifyPlaceType,
  extractClearlyNamedHospitalTitle,
  extractClearlyNamedHotelTitle,
  isAccommodationPlaceName,
  isClearlyNamedHospital,
  isNamedHotel,
  isOfficialAUHHospitalAlias,
  recognizeAUHHospital,
} from "@workspace/api-zod/place-types";

describe("Address Book accommodation place classification", () => {
  it.each([
    "Palm Guest House",
    "Palm Guesthouse",
    "Palm Guest-House",
    "Marina Airbnb",
    "Marina Air BnB",
  ])("recognizes %s as accommodation", (name) => {
    expect(isAccommodationPlaceName(name)).toBe(true);
    expect(classifyPlaceType("residence", [name])).toBe("hotel");
  });

  it("promotes a legacy Residence when an accommodation alias identifies it", () => {
    expect(
      classifyPlaceType("residence", ["Villa 27, Jumeirah", "Airbnb near the beach"]),
    ).toBe("hotel");
  });

  it("does not overwrite an explicitly selected non-residential type", () => {
    expect(classifyPlaceType("office", ["Airbnb reception office"])).toBe("office");
    expect(classifyPlaceType("church", ["Guest House annex"])).toBe("church");
  });
});

describe("AUH Hospital recognition", () => {
  it.each([
    "American University Hospital, reception",
    "American University of Beirut Hospital - floor 4",
    "A.U.H. Hospital, Room 412",
    "AUH, maternity ward",
  ])("recognizes %s as the reusable hospital identity", (address) => {
    expect(recognizeAUHHospital(address)).toMatchObject({
      canonicalName: AUH_HOSPITAL_CANONICAL_NAME,
      placeType: "hospital",
    });
    expect(classifyPlaceType("residence", [address])).toBe("hospital");
  });

  it("does not turn an unrelated AUH abbreviation into a hospital", () => {
    expect(recognizeAUHHospital("AUH offices, downtown")).toBeNull();
    expect(classifyPlaceType("residence", ["AUH offices, downtown"])).toBe("residence");
  });

  it("keeps an explicit non-default type authoritative", () => {
    expect(classifyPlaceType("office", ["AUH Hospital reception office"])).toBe("office");
  });

  it("only treats standalone official variants as reusable aliases", () => {
    expect(isOfficialAUHHospitalAlias("A.U.H. Hospital")).toBe(true);
    expect(isOfficialAUHHospitalAlias("AUH Hospital, patient Jane Doe")).toBe(false);
    expect(isOfficialAUHHospitalAlias("American University Hospital, Ward C")).toBe(false);
  });

  it("recognizes a clearly named hospital without treating generic hospital prose as a place", () => {
    expect(isClearlyNamedHospital("St George Hospital, Ward 3, Room 12")).toBe(true);
    expect(extractClearlyNamedHospitalTitle("Jane Doe at City Hospital, Ward 3")).toBe("City Hospital");
    expect(isClearlyNamedHospital("Please deliver to the hospital reception")).toBe(false);
    expect(isClearlyNamedHospital("Hospital Road, Beirut")).toBe(false);
    expect(classifyPlaceType("residence", ["St George Hospital, Ward 3"])).toBe("hospital");
  });

  it("captures multi-word hospital names that exceed the old 3-word limit", () => {
    expect(isClearlyNamedHospital("Saint George University Hospital")).toBe(true);
    expect(isClearlyNamedHospital("Rassoul Al Azam Al Rashid Hospital")).toBe(true);
    expect(extractClearlyNamedHospitalTitle("Rassoul Al Azam Hospital Cardiology Dept")).toBe(
      "Rassoul Al Azam Hospital",
    );
  });

  it("rejects patient delivery prose even with the wider word-count limit", () => {
    expect(isClearlyNamedHospital("Patient Jane Doe at the hospital")).toBe(false);
    expect(extractClearlyNamedHospitalTitle("Patient Jane Doe at the hospital")).toBeNull();
  });
});

describe("Hotel name extraction", () => {
  it("extracts 'X Hotel' form (name before marker)", () => {
    expect(extractClearlyNamedHotelTitle("Grand Hyatt Hotel, Floor 12, Guest: Smith")).toBe(
      "Grand Hyatt Hotel",
    );
    expect(extractClearlyNamedHotelTitle("Marriott Hotel, Room 302")).toBe("Marriott Hotel");
    expect(extractClearlyNamedHotelTitle("Four Seasons Hotel, leave with concierge")).toBe(
      "Four Seasons Hotel",
    );
  });

  it("extracts 'Hotel X' form (marker before name)", () => {
    expect(extractClearlyNamedHotelTitle("Hotel Le Bristol, suite 3")).toBe("Hotel Le Bristol");
  });

  it("extracts hotel name embedded after a preposition", () => {
    expect(extractClearlyNamedHotelTitle("deliver to Grand Hyatt Hotel, reception")).toBe(
      "Grand Hyatt Hotel",
    );
  });

  it("returns null for bare hotel references without a proper name", () => {
    expect(extractClearlyNamedHotelTitle("at the hotel")).toBeNull();
    expect(extractClearlyNamedHotelTitle("deliver to the hotel")).toBeNull();
    expect(extractClearlyNamedHotelTitle(null)).toBeNull();
    expect(extractClearlyNamedHotelTitle("")).toBeNull();
  });

  it("returns null for non-hotel address text", () => {
    expect(extractClearlyNamedHotelTitle("Hamra, near the petrol station")).toBeNull();
    expect(extractClearlyNamedHotelTitle("Cedar Heights, Floor 4, Apt 12B")).toBeNull();
  });

  it("isNamedHotel matches clearly named hotels and rejects bare references", () => {
    expect(isNamedHotel("Ritz Carlton Hotel, Floor 3")).toBe(true);
    expect(isNamedHotel("Hotel Phoenicia, lobby")).toBe(true);
    expect(isNamedHotel("at the hotel")).toBe(false);
    expect(isNamedHotel(null)).toBe(false);
  });

  it("classifyPlaceType promotes a Residence to hotel when a name matches", () => {
    expect(classifyPlaceType("residence", ["Grand Hyatt Hotel"])).toBe("hotel");
    expect(classifyPlaceType("residence", ["Hotel Le Bristol"])).toBe("hotel");
    expect(classifyPlaceType("hospital", ["Grand Hyatt Hotel"])).toBe("hospital");
    expect(classifyPlaceType("residence", ["Cedar Heights, Floor 4"])).toBe("residence");
  });
});