import { describe, expect, it } from "vitest";
import {
  formatPlaceType,
  PLACE_TYPE_OPTIONS,
} from "@workspace/api-zod/place-types";

describe("Address Book place-type catalog", () => {
  it("supplies Hotel and Church to filters and place forms", () => {
    expect(PLACE_TYPE_OPTIONS).toEqual(
      expect.arrayContaining([
        { value: "hotel", label: "Hotel" },
        { value: "church", label: "Church" },
      ]),
    );
  });

  it("formats supported and unknown legacy values consistently", () => {
    expect(formatPlaceType("residence")).toBe("Residence");
    expect(formatPlaceType("hotel")).toBe("Hotel");
    expect(formatPlaceType("warehouse")).toBe("Warehouse");
    expect(formatPlaceType("legacy_guest_house")).toBe("Legacy Guest House");
  });
});