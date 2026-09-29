import { describe, expect, it } from "vitest";
import {
  hasUsableDeliveryAddress,
  isPlaceholderDeliveryAddress,
  shouldCollectAddressCollection,
} from "./eligibility";

describe("Address Collector eligibility", () => {
  it.each([
    null,
    undefined,
    "",
    "   ",
    "to be confirmed",
    "To be confirmed / ask recipient",
    "To be confirmed — ask recipient for address — To be confirmed",
    "ask the recipient for address",
    { address: "" },
    { address: "TBC", district: "Beirut" },
    { address_1: "not provided", city: "Dubai" },
    { city: "Beirut", countryCode: "LB" },
  ])("treats missing and placeholder address shape %# as unusable", (deliveryAddress) => {
    expect(hasUsableDeliveryAddress(deliveryAddress)).toBe(false);
    expect(shouldCollectAddressCollection({ deliveryAddress })).toBe(true);
  });

  it.each([
    "12 Main Street",
    { address: "12 Main Street" },
    { address_1: "Villa 4, Palm Road" },
    { streetAddress: "Cedar Building, Hamra" },
  ])("recognizes real address shape %#", (deliveryAddress) => {
    expect(hasUsableDeliveryAddress(deliveryAddress)).toBe(true);
    expect(shouldCollectAddressCollection({ deliveryAddress })).toBe(false);
  });

  it("lets an explicit collection request override a real address", () => {
    expect(shouldCollectAddressCollection({
      deliveryAddress: { address: "12 Main Street" },
      explicitRequest: true,
    })).toBe(true);
  });

  it.each([
    { noAddress: true },
    { no_address: true },
    { noAddress: true, address: "To be confirmed" },
    { noAddress: true, address: "To be confirmed — ask recipient for address — To be confirmed" },
    [{ address: "12 Main Street" }, { noAddress: true }],
  ])("honors explicit no-address marker %#", (deliveryAddress) => {
    expect(shouldCollectAddressCollection({ deliveryAddress })).toBe(true);
  });

  it("does not classify ordinary address text containing recipient words as a placeholder", () => {
    expect(isPlaceholderDeliveryAddress("Recipient Building, Main Street")).toBe(false);
    expect(isPlaceholderDeliveryAddress("12 Main Street, ask recipient at gate")).toBe(false);
  });

  it("recognizes coordinates as a usable delivery address", () => {
    expect(hasUsableDeliveryAddress({ latitude: 33.8938, longitude: 35.5018 })).toBe(true);
  });
});