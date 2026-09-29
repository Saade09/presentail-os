import { describe, expect, it } from "vitest";
import {
  buildDeliveryPresentationModel,
  needsAddressCollectorAttention,
} from "./orderDeliveryModel";

describe("buildDeliveryPresentationModel", () => {
  it("keeps original free text intact while separating explicit destination, locality, and instructions", () => {
    const model = buildDeliveryPresentationModel({
      deliveryAddress: {
        address: "Hamra Street, Building 14",
        city: "Beirut",
        country: "LB",
        map_link: "https://maps.google.com/?q=33.8938,35.5018",
      },
      deliveryInstructions: "Call from the lobby",
    });

    expect(model.originalAddress).toBe("Hamra Street, Building 14");
    expect(model.destination).toBe("Hamra Street, Building 14");
    expect(model.locality).toBe("Beirut");
    expect(model.instructions).toBe("Call from the lobby");
    expect(model.mapUrl).toContain("maps.google.com");
    expect(model.isIncomplete).toBe(false);
  });

  it("uses a received collector address without replacing the original customer text", () => {
    const model = buildDeliveryPresentationModel({
      deliveryAddress: { address: "Near the old cinema", city: "Beirut" },
      addressCollectorRequest: {
        id: "11111111-1111-1111-1111-111111111111",
        status: "address_received",
        submitted_address: {
          area: "Achrafieh",
          street: "Charles Malek Avenue",
          building: "Alma Building",
          notes: "Apartment 4B",
        },
      },
    });

    expect(model.originalAddress).toBe("Near the old cinema");
    expect(model.destination).toBe("Charles Malek Avenue");
    expect(model.locality).toBe("Achrafieh");
    expect(model.instructions).toBe("Apartment 4B");
    expect(model.usesCollectedAddress).toBe(true);
  });

  it("does not invent a destination from locality-only input", () => {
    const model = buildDeliveryPresentationModel({
      deliveryAddress: { city: "Beirut", country: "LB" },
    });

    expect(model.destination).toBeNull();
    expect(model.locality).toBe("Beirut");
    expect(model.isIncomplete).toBe(true);
  });

  it("removes a map URL from visible free text while retaining only supported map actions", () => {
    const model = buildDeliveryPresentationModel({
      deliveryAddress: {
        address: "Building 9 https://example.com/pin",
        map_link: "https://example.com/pin",
      },
    });

    expect(model.destination).toBe("Building 9");
    expect(model.mapUrl).toBeNull();
  });

  it("marks at-risk collector requests as needing attention even before a terminal status", () => {
    expect(needsAddressCollectorAttention({
      id: "11111111-1111-1111-1111-111111111111",
      status: "whatsapp_sent",
      risk_level: "at_risk",
    })).toBe(true);
  });
});