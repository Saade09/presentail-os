import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __test,
  parseMapUrlCoordinates,
  parseRespondIoIncomingMessage,
  resolveSupportedMapLink,
} from "./incomingReplyHandler";

describe("parseRespondIoIncomingMessage", () => {
  it("parses a documented incoming text fixture", () => {
    expect(parseRespondIoIncomingMessage({
      event_type: "message.received",
      event_id: "sanitized-text-event",
      contact: { id: 123, phone: "03 159 639" },
      message: {
        messageId: "wamid.text-1",
        contactId: 123,
        channelId: 543704,
        traffic: "incoming",
        message: { type: "text", text: "Sassine Square, Achrafieh, Beirut" },
        replyTo: { id: "outbound-template-1" },
      },
      channel: { id: 543704 },
    })).toEqual({
      providerMessageId: "wamid.text-1",
      rawPhone: "03 159 639",
      channelId: "543704",
      contactId: "123",
      inReplyToProviderMessageId: "outbound-template-1",
      type: "text",
      text: "Sassine Square, Achrafieh, Beirut",
      latitude: null,
      longitude: null,
    });
  });

  it("preserves recipient text exactly, including leading and trailing whitespace", () => {
    const reply = parseRespondIoIncomingMessage({
      event_type: "message.received",
      contact: { id: "contact-exact-text", phone: "+9613159639" },
      message: {
        id: "wamid.exact-text",
        channelId: "543704",
        traffic: "incoming",
        message: { type: "text", text: "  beirut manara al mada building  " },
      },
    });
    expect(reply?.text).toBe("  beirut manara al mada building  ");
  });

  it("parses nested location coordinates from a Respond.io fixture", () => {
    expect(parseRespondIoIncomingMessage({
      event_type: "message.received",
      event_id: "sanitized-location-event",
      contact: { id: 456, phone: "+9613159639" },
      message: {
        messageId: "wamid.location-1",
        contactId: 456,
        channelId: "543704",
        traffic: "incoming",
        message: {
          type: "location",
          latitude: "33.8938",
          longitude: "35.5018",
          name: "Sassine Square",
        },
      },
      channel: { id: "543704" },
    })).toMatchObject({
      providerMessageId: "wamid.location-1",
      contactId: "456",
      inReplyToProviderMessageId: null,
      type: "location",
      latitude: 33.8938,
      longitude: 35.5018,
      text: "Sassine Square",
    });
  });

  it("keeps a location-shaped payload without coordinates for unsupported-location handling", () => {
    expect(parseRespondIoIncomingMessage({
      event_type: "message.received",
      contact: { id: "contact-1", phone: "+9613159639" },
      message: {
        id: "wamid.location-missing",
        channelId: "543704",
        traffic: "incoming",
        message: { type: "location", name: "Shared location" },
      },
    })).toMatchObject({
      providerMessageId: "wamid.location-missing",
      type: "location",
      latitude: null,
      longitude: null,
    });
  });

  it("does not treat ordinary image or file attachments as location pins", () => {
    expect(parseRespondIoIncomingMessage({
      event_type: "message.received",
      contact: { id: "contact-1", phone: "+9613159639" },
      message: {
        id: "wamid.image",
        channelId: "543704",
        traffic: "incoming",
        message: {
          type: "attachment",
          url: "https://example.invalid/photo.jpg",
          latitude: 33.8938,
          longitude: 35.5018,
        },
      },
    })).toBeNull();
  });

  it("keeps a Google Maps link as text for the asynchronous map resolver", () => {
    expect(parseRespondIoIncomingMessage({
      event_type: "message.received",
      data: {
        channel: { id: "543704" },
        contact: { id: "contact-1", phone: "+9613159639" },
        message: {
          id: "wamid.map-link-1",
          direction: "incoming",
          type: "text",
          text: "My location: https://www.google.com/maps?q=33.8938,35.5018",
        },
      },
    })).toMatchObject({
      providerMessageId: "wamid.map-link-1",
      type: "text",
      text: "My location: https://www.google.com/maps?q=33.8938,35.5018",
      latitude: null,
      longitude: null,
    });
  });

  it("ignores outbound messages and unsupported payloads", () => {
    expect(parseRespondIoIncomingMessage({
      event_type: "message.sent",
      data: {
        contact: { phone: "+9613159639" },
        message: { id: "out-1", direction: "outgoing", text: "hello" },
      },
    })).toBeNull();
    expect(parseRespondIoIncomingMessage({ event_type: "contact.updated" })).toBeNull();
    expect(parseRespondIoIncomingMessage({
      event_type: "message.received",
      data: {
        contact: { id: "contact-1", phone: "+9613159639" },
        message: { id: "msg-no-channel", direction: "incoming", type: "text", text: "Address" },
      },
    })).toBeNull();
  });
});

describe("fail-closed geographic verification", () => {
  const reverse = {
    display_name: "Sassine Square, Beirut, Lebanon",
    address: { city: "Beirut", country: "Lebanon", country_code: "lb" },
  };

  it("accepts a reverse result matching the required country and city", () => {
    expect(__test.validateReverseGeography(reverse, { delivery_country_code: "LB" }, "Beirut"))
      .toEqual({ valid: true, reason: "verified" });
  });

  it("accepts Arabic Beirut governorate and locality values", () => {
    expect(__test.validateReverseGeography({
      display_name: "الناصرة، الأشرفية، محافظة بيروت، لبنان",
      address: {
        city: "الناصرة",
        municipality: "الأشرفية",
        state: "محافظة بيروت",
        country: "لبنان",
        country_code: "lb",
      },
    }, { delivery_country_code: "LB" }, "Beirut")).toEqual({ valid: true, reason: "verified" });
  });

  it("accepts authoritative LB-BA administrative evidence for Beirut", () => {
    expect(__test.validateReverseGeography({
      display_name: "Achrafieh, Lebanon",
      address: {
        municipality: "Achrafieh",
        "ISO3166-2-lvl4": "LB-BA",
        country_code: "lb",
      },
    }, { delivery_country_code: "LB" }, "Beirut")).toEqual({ valid: true, reason: "verified" });
  });

  it("rejects a genuine non-Beirut Lebanese location", () => {
    expect(__test.validateReverseGeography({
      display_name: "Tripoli, North Governorate, Lebanon",
      address: {
        city: "Tripoli",
        state: "North Governorate",
        "ISO3166-2-lvl4": "LB-AS",
        country_code: "lb",
      },
    }, { delivery_country_code: "LB" }, "Beirut")).toEqual({ valid: false, reason: "city_mismatch" });
  });

  it("rejects provider outages, missing country context, and country mismatches", () => {
    expect(__test.validateReverseGeography(null, { delivery_country_code: "LB" }, "Beirut").valid)
      .toBe(false);
    expect(__test.validateReverseGeography(reverse, { delivery_country_code: null }, "Beirut").valid)
      .toBe(false);
    expect(__test.validateReverseGeography(reverse, { delivery_country_code: "AE" }, "Dubai").valid)
      .toBe(false);
  });

  it("rejects a reverse result that cannot confirm the expected city", () => {
    expect(__test.validateReverseGeography(reverse, { delivery_country_code: "LB" }, "Tripoli"))
      .toEqual({ valid: false, reason: "city_mismatch" });
  });
});

describe("map reply normalization", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("extracts coordinates from direct Google Maps and Apple Maps URLs", () => {
    expect(parseMapUrlCoordinates("https://www.google.com/maps/place/Test/@25.2048,55.2708,16z"))
      .toEqual({ latitude: 25.2048, longitude: 55.2708 });
    expect(parseMapUrlCoordinates("https://maps.apple.com/?ll=33.8938,35.5018&q=Sassine"))
      .toEqual({ latitude: 33.8938, longitude: 35.5018 });
  });

  it("rejects non-HTTPS, unapproved hosts, malformed coordinates, and encoded junk", () => {
    expect(parseMapUrlCoordinates("http://maps.google.com/?q=25.2,55.2")).toBeNull();
    expect(parseMapUrlCoordinates("https://maps.google.com.evil.example/?q=25.2,55.2")).toBeNull();
    expect(parseMapUrlCoordinates("https://maps.apple.com/?ll=200,55")).toBeNull();
    expect(parseMapUrlCoordinates("https://maps.apple.com/?q=%E0%A4%A")).toBeNull();
  });

  it("follows a bounded allowlisted short-link redirect", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 302,
      headers: new Headers({
        location: "https://www.google.com/maps/place/Test/@25.2048,55.2708,16z",
      }),
      body: null,
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(resolveSupportedMapLink("https://maps.app.goo.gl/abc123"))
      .resolves.toEqual({ latitude: 25.2048, longitude: 55.2708 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("refuses a short-link redirect to a non-map host", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      status: 302,
      headers: new Headers({ location: "https://internal.example/secret" }),
      body: null,
    }));
    await expect(resolveSupportedMapLink("https://maps.app.goo.gl/abc123"))
      .resolves.toBeNull();
  });
});

describe("unambiguous request selection", () => {
  const candidate = {
    id: "request-1",
    workspace_owner_id: "workspace-1",
    order_id: "order-1",
    status: "whatsapp_sent",
    recipient_phone: "+9613159639",
    respondio_contact_id: "contact-1",
    delivery_country_code: "LB",
    delivery_timezone: "Asia/Beirut",
    window_start: null,
    delivery_address: null,
    delivery_instructions: null,
    tookan_job_id: null,
  };

  it("does not select a request when the webhook phone differs", () => {
    expect(__test.selectUniqueCandidate(
      [candidate],
      { contactId: "different-contact", rawPhone: "+96170111111" },
    )).toEqual({ outcome: "unknown_phone", chosen: null });
  });

  it("selects the newest phone-matching request when several are active", () => {
    expect(__test.selectUniqueCandidate(
      [candidate, { ...candidate, id: "request-2", order_id: "order-2" }],
      { contactId: "contact-1", rawPhone: "+9613159639" },
    )).toMatchObject({ outcome: "matched", chosen: { id: "request-1" } });
  });

  it("uses the recipient phone rather than the Respond.io contact ID", () => {
    expect(__test.selectUniqueCandidate(
      [
        candidate,
        { ...candidate, id: "request-2", respondio_contact_id: "other-contact" },
      ],
      { contactId: "other-contact", rawPhone: "+9613159639" },
    )).toMatchObject({ outcome: "matched", chosen: { id: "request-1" } });
  });
});

describe("direct recipient address persistence", () => {
  it("stores even nonsensical text without rewriting or validating it", () => {
    expect(__test.directRecipientAddress({
      providerMessageId: "message-text",
      rawPhone: "+9613159639",
      channelId: "channel",
      contactId: null,
      inReplyToProviderMessageId: null,
      type: "text",
      text: "beirut manara al mada building",
      latitude: null,
      longitude: null,
    })).toEqual({
      address: "beirut manara al mada building",
      source: "respondio_recipient_reply",
      reply_type: "text",
    });
  });

  it("stores native location data directly without reverse-geocoding", () => {
    expect(__test.directRecipientAddress({
      providerMessageId: "message-location",
      rawPhone: "+9613159639",
      channelId: "channel",
      contactId: null,
      inReplyToProviderMessageId: null,
      type: "location",
      text: "Manara",
      latitude: 33.875,
      longitude: 35.48,
    })).toEqual({
      address: "Manara",
      source: "respondio_recipient_reply",
      reply_type: "location",
      location: { latitude: 33.875, longitude: 35.48, label: "Manara" },
      latitude: 33.875,
      longitude: 35.48,
    });
  });
});

describe("canonical address fields", () => {
  it("builds the canonical delivery shape from a validated reverse result", () => {
    expect(__test.canonicalAddress({
      fallbackLabel: "Sassine",
      latitude: 33.8938,
      longitude: 35.5018,
      reverse: {
        display_name: "Sassine Square, Achrafieh, Beirut, Lebanon",
        address: {
          city: "Beirut",
          suburb: "Achrafieh",
          country: "Lebanon",
          country_code: "lb",
        },
      },
      source: "shared_location",
    })).toMatchObject({
      address: "Sassine Square, Achrafieh, Beirut, Lebanon",
      city: "Beirut",
      area: "Achrafieh",
      countryCode: "LB",
      latitude: 33.8938,
      longitude: 35.5018,
      collection_source: "respondio",
      collection_reply_type: "shared_location",
    });
  });

  it("keeps submitted text canonical while retaining approximate geocoder evidence", () => {
    expect(__test.canonicalAddress({
      fallbackLabel: "Al Bayada, Lebanon",
      canonicalText: "Al Bayada 5th Street Jamil Building",
      latitude: 33.902,
      longitude: 35.59,
      reverse: {
        display_name: "Al Bayada, Lebanon",
        address: {
          city: "Beirut",
          suburb: "Al Bayada",
          country: "Lebanon",
          country_code: "lb",
        },
      },
      geocode: {
        lat: 33.902,
        lng: 35.59,
        matchType: "approximate",
        precision: "locality",
        method: "locality_fallback",
        matchedLocation: "Al Bayada, Lebanon",
        query: "Al Bayada, Lebanon",
        provider: "nominatim",
        placeIdentity: "osm:456",
        evidenceScore: 12,
      },
      source: "text",
    })).toMatchObject({
      address: "Al Bayada 5th Street Jamil Building",
      formattedAddress: "Al Bayada 5th Street Jamil Building",
      geocodeMatchType: "approximate",
      geocodePrecision: "locality",
      geocodeMethod: "locality_fallback",
      placeMetadata: {
        matchedLocation: "Al Bayada, Lebanon",
        precision: "locality",
        method: "locality_fallback",
      },
    });
  });

  it("replaces stale address-owned fields while preserving fulfilment fields", () => {
    expect(__test.replaceCanonicalAddress(
      {
        address: "Old address",
        noAddress: true,
        no_address: true,
        address_1: "Ask recipient",
        city: "Old city",
        area: "Old area",
        countryCode: "AE",
        latitude: 25.2,
        date: "2026-09-01",
        slot: "10:00-12:00",
      },
      {
        address: "New address",
        city: "Beirut",
        countryCode: "LB",
        latitude: 33.8,
        longitude: 35.5,
      },
    )).toEqual({
      address: "New address",
      city: "Beirut",
      countryCode: "LB",
      latitude: 33.8,
      longitude: 35.5,
      date: "2026-09-01",
      slot: "10:00-12:00",
    });
    expect(__test.replaceCanonicalAddress(
      {
        noAddress: true,
        no_address: true,
        address_1: "Ask recipient",
        date: "2026-09-01",
      },
      { address: "New address" },
    )).toEqual({
      address: "New address",
      date: "2026-09-01",
    });
  });
});