import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dbQuery: vi.fn(),
  postMessage: vi.fn(),
  fetch: vi.fn(),
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("../db", () => ({
  db: { query: (...args: unknown[]) => mocks.dbQuery(...args) },
}));

vi.mock("../logger", () => ({ logger: mocks.logger }));

vi.mock("@slack/web-api", () => ({
  WebClient: class {
    chat = { postMessage: (...args: unknown[]) => mocks.postMessage(...args) };
  },
}));

import {
  isUaeCountryCode,
  isSlackConfigured,
  resolveSlackRouting,
  formatSlackDeliveryDate,
  buildNewOrderSlackText,
  notifyNewUaeOrderToSlack,
} from "../slack";

const DUBAI = "C_DUBAI";
const ABU_DHABI = "C_ABU_DHABI";

function clearChannels() {
  delete process.env.SLACK_DUBAI_CHANNEL_ID;
  delete process.env.SLACK_ABU_DHABI_CHANNEL_ID;
}

describe("isUaeCountryCode", () => {
  it("is true for 'ae' (any case)", () => {
    expect(isUaeCountryCode("ae")).toBe(true);
    expect(isUaeCountryCode("AE")).toBe(true);
    expect(isUaeCountryCode(" Ae ")).toBe(true);
  });

  it("is false for other / missing codes", () => {
    expect(isUaeCountryCode("lb")).toBe(false);
    expect(isUaeCountryCode("us")).toBe(false);
    expect(isUaeCountryCode(null)).toBe(false);
    expect(isUaeCountryCode(undefined)).toBe(false);
    expect(isUaeCountryCode("")).toBe(false);
  });
});

describe("isSlackConfigured", () => {
  beforeEach(clearChannels);
  afterEach(clearChannels);

  it("is false when no channel env is set", () => {
    expect(isSlackConfigured()).toBe(false);
  });

  it("is true when either channel env is set", () => {
    process.env.SLACK_DUBAI_CHANNEL_ID = DUBAI;
    expect(isSlackConfigured()).toBe(true);
    clearChannels();
    process.env.SLACK_ABU_DHABI_CHANNEL_ID = ABU_DHABI;
    expect(isSlackConfigured()).toBe(true);
  });
});

describe("resolveSlackRouting", () => {
  beforeEach(() => {
    clearChannels();
    process.env.SLACK_DUBAI_CHANNEL_ID = DUBAI;
    process.env.SLACK_ABU_DHABI_CHANNEL_ID = ABU_DHABI;
  });
  afterEach(clearChannels);

  it("skips non-UAE orders", () => {
    const r = resolveSlackRouting({ countryCode: "lb", cityName: "Beirut", citySlug: "beirut" });
    expect(r).toEqual({ skip: true, reason: "not_uae" });
  });

  it("routes Abu Dhabi (by slug) to the Abu Dhabi channel", () => {
    const r = resolveSlackRouting({ countryCode: "ae", cityName: "Abu Dhabi", citySlug: "abu-dhabi" });
    expect(r).toEqual({ skip: false, channelId: ABU_DHABI, channelLabel: "abu_dhabi" });
  });

  it("routes Abu Dhabi (by name, case-insensitive) to the Abu Dhabi channel", () => {
    const r = resolveSlackRouting({ countryCode: "ae", cityName: "ABU DHABI", citySlug: "" });
    expect(r).toEqual({ skip: false, channelId: ABU_DHABI, channelLabel: "abu_dhabi" });
  });

  it("routes Dubai to the Dubai channel", () => {
    const r = resolveSlackRouting({ countryCode: "ae", cityName: "Dubai", citySlug: "dubai" });
    expect(r).toEqual({ skip: false, channelId: DUBAI, channelLabel: "dubai" });
  });

  it("routes every other UAE city to the Dubai channel", () => {
    const r = resolveSlackRouting({ countryCode: "ae", cityName: "Sharjah", citySlug: "sharjah" });
    expect(r).toEqual({ skip: false, channelId: DUBAI, channelLabel: "dubai" });
  });

  it("routes UAE order with unknown/missing city to the Dubai channel", () => {
    const r = resolveSlackRouting({ countryCode: "ae", cityName: null, citySlug: null });
    expect(r).toEqual({ skip: false, channelId: DUBAI, channelLabel: "dubai" });
  });

  it("does not fall back to Dubai for Abu Dhabi when the AD channel is unset", () => {
    delete process.env.SLACK_ABU_DHABI_CHANNEL_ID;
    const r = resolveSlackRouting({ countryCode: "ae", cityName: "Abu Dhabi", citySlug: "abu-dhabi" });
    expect(r).toEqual({ skip: true, reason: "abu_dhabi_channel_not_configured" });
  });

  it("does not fall back to Abu Dhabi for Dubai when the Dubai channel is unset", () => {
    delete process.env.SLACK_DUBAI_CHANNEL_ID;
    const r = resolveSlackRouting({ countryCode: "ae", cityName: "Dubai", citySlug: "dubai" });
    expect(r).toEqual({ skip: true, reason: "dubai_channel_not_configured" });
  });

  it("skips UAE order when no channel is configured", () => {
    clearChannels();
    const r = resolveSlackRouting({ countryCode: "ae", cityName: "Dubai", citySlug: "dubai" });
    expect(r).toEqual({ skip: true, reason: "dubai_channel_not_configured" });
  });

  it("recognizes Abu Dhabi from a slug-valued city id or district fallback", () => {
    expect(resolveSlackRouting({
      countryCode: "AE",
      cityName: null,
      citySlug: null,
      cityId: "abu-dhabi",
    })).toEqual({ skip: false, channelId: ABU_DHABI, channelLabel: "abu_dhabi" });
    expect(resolveSlackRouting({
      countryCode: "AE",
      cityName: null,
      citySlug: null,
      district: "Abu Dhabi",
    })).toEqual({ skip: false, channelId: ABU_DHABI, channelLabel: "abu_dhabi" });
  });

  it("uses district only when no authoritative city value is available", () => {
    expect(resolveSlackRouting({
      countryCode: "AE",
      cityName: "Dubai",
      citySlug: "dubai",
      district: "Abu Dhabi",
    })).toEqual({ skip: false, channelId: DUBAI, channelLabel: "dubai" });
    expect(resolveSlackRouting({
      countryCode: "AE",
      cityName: "Abu Dhabi",
      citySlug: "abu-dhabi",
      district: "Dubai",
    })).toEqual({ skip: false, channelId: ABU_DHABI, channelLabel: "abu_dhabi" });
  });
});

describe("formatSlackDeliveryDate", () => {
  it("formats a calendar date string", () => {
    expect(formatSlackDeliveryDate("2026-06-30", null)).toBe("30 June 2026");
  });

  it("falls back to window_start ISO timestamp", () => {
    expect(formatSlackDeliveryDate(null, "2026-01-15T10:00:00Z")).toBe("15 January 2026");
  });

  it("prefers the calendar date over window_start", () => {
    expect(formatSlackDeliveryDate("2026-06-30", "2026-01-15T10:00:00Z")).toBe("30 June 2026");
  });

  it("returns the raw string when unparseable", () => {
    expect(formatSlackDeliveryDate("next Tuesday", null)).toBe("next Tuesday");
  });

  it("returns null when nothing usable is present", () => {
    expect(formatSlackDeliveryDate(null, null)).toBeNull();
    expect(formatSlackDeliveryDate("", "")).toBeNull();
  });
});

describe("buildNewOrderSlackText", () => {
  it("includes order number, delivery date, recipient, phone, and items", () => {
    const text = buildNewOrderSlackText({
      orderNumber: "AE-1042",
      deliveryDate: "30 June 2026",
      recipientName: "Jane Doe",
      recipientPhone: "+971500000000",
      lineItems: [
        { name: "Red Roses Bouquet", quantity: 1 },
        { name: "Chocolate Box", quantity: 2 },
      ],
    });
    expect(text).toContain("AE-1042");
    expect(text).toContain("30 June 2026");
    expect(text).toContain("Jane Doe");
    expect(text).toContain("+971500000000");
    expect(text).toContain("1 × Red Roses Bouquet");
    expect(text).toContain("2 × Chocolate Box");
  });

  it("renders em-dash placeholders for missing fields and no items", () => {
    const text = buildNewOrderSlackText({
      orderNumber: "AE-1",
      deliveryDate: null,
      recipientName: null,
      recipientPhone: null,
      lineItems: [],
    });
    expect(text).toContain("*Delivery date:* —");
    expect(text).toContain("*Recipient:* —");
    expect(text).toContain("*Phone:* —");
    expect(text).toContain("*Items:* —");
  });

  it("defaults a non-positive quantity to 1", () => {
    const text = buildNewOrderSlackText({
      orderNumber: "AE-2",
      deliveryDate: null,
      recipientName: null,
      recipientPhone: null,
      lineItems: [{ name: "Vase", quantity: 0 }],
    });
    expect(text).toContain("1 × Vase");
  });
});

describe("notifyNewUaeOrderToSlack", () => {
  const ORDER_ID = "order-1";
  const OWNER_ID = "owner-1";

  function configureConnector() {
    process.env.REPLIT_CONNECTORS_HOSTNAME = "connectors.test";
    process.env.REPL_IDENTITY = "test-identity";
    mocks.fetch.mockResolvedValue({
      json: async () => ({
        items: [{ settings: { access_token: "test-token" } }],
      }),
    });
    vi.stubGlobal("fetch", mocks.fetch);
  }

  function stubOrder(
    deliveryAddress: Record<string, unknown>,
    city: { name: string; slug: string } | null = null,
  ) {
    mocks.dbQuery.mockImplementation((sql: string) => {
      if (/FROM orders/i.test(sql)) {
        return {
          rows: [{
            display_order_number: "AE-1001",
            delivery_address: deliveryAddress,
            window_start: null,
          }],
        };
      }
      if (/FROM delivery_cities/i.test(sql)) {
        return { rows: city ? [city] : [] };
      }
      if (/FROM order_contacts/i.test(sql)) {
        return { rows: [{ display_name: "Recipient", phone: "+971500000000" }] };
      }
      if (/FROM order_line_items/i.test(sql)) {
        return { rows: [{ name: "Roses", quantity: "1" }] };
      }
      return { rows: [] };
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    clearChannels();
    process.env.SLACK_DUBAI_CHANNEL_ID = DUBAI;
    process.env.SLACK_ABU_DHABI_CHANNEL_ID = ABU_DHABI;
    configureConnector();
    mocks.postMessage.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    clearChannels();
    delete process.env.REPLIT_CONNECTORS_HOSTNAME;
    delete process.env.REPL_IDENTITY;
    vi.unstubAllGlobals();
  });

  it("routes the reported Abu Dhabi city-and-district payload only to Abu Dhabi", async () => {
    stubOrder(
      { countryCode: "AE", cityId: "abu-dhabi", district: "Abu Dhabi" },
      { name: "Abu Dhabi", slug: "abu-dhabi" },
    );

    await notifyNewUaeOrderToSlack({ orderId: ORDER_ID, workspaceOwnerId: OWNER_ID });

    expect(mocks.postMessage).toHaveBeenCalledTimes(1);
    expect(mocks.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: ABU_DHABI }),
    );
    expect(mocks.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ channel: DUBAI }),
    );
    const cityLookup = mocks.dbQuery.mock.calls.find(
      ([sql]) => typeof sql === "string" && /FROM delivery_cities/i.test(sql),
    );
    expect(cityLookup?.[1]).toEqual(["abu-dhabi", OWNER_ID]);
  });

  it.each([
    ["numeric city id", { countryCode: "AE", cityId: 42 }, { name: "Abu Dhabi", slug: "abu-dhabi" }],
    ["explicit city name", { country_code: "AE", cityName: "Abu Dhabi" }, null],
    ["legacy city field", { countryCode: "AE", city: "Abu Dhabi" }, null],
    ["district fallback", { countryCode: "AE", district: "Abu Dhabi" }, null],
  ])("routes Abu Dhabi from %s", async (_label, address, city) => {
    stubOrder(address, city);

    await notifyNewUaeOrderToSlack({ orderId: ORDER_ID, workspaceOwnerId: OWNER_ID });

    expect(mocks.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: ABU_DHABI }),
    );
  });

  it.each([
    ["Dubai", { countryCode: "AE", cityId: "dubai" }, { name: "Dubai", slug: "dubai" }],
    ["another UAE city", { countryCode: "AE", cityName: "Sharjah" }, null],
    ["unknown UAE city", { countryCode: "AE" }, null],
  ])("routes %s only to Dubai", async (_label, address, city) => {
    stubOrder(address, city);

    await notifyNewUaeOrderToSlack({ orderId: ORDER_ID, workspaceOwnerId: OWNER_ID });

    expect(mocks.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: DUBAI }),
    );
    expect(mocks.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ channel: ABU_DHABI }),
    );
  });

  it("keeps a resolved numeric Dubai city authoritative over a stale Abu Dhabi district", async () => {
    stubOrder(
      { countryCode: "AE", cityId: 42, district: "Abu Dhabi" },
      { name: "Dubai", slug: "dubai" },
    );

    await notifyNewUaeOrderToSlack({ orderId: ORDER_ID, workspaceOwnerId: OWNER_ID });

    expect(mocks.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: DUBAI }),
    );
    expect(mocks.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ channel: ABU_DHABI }),
    );
  });

  it("keeps a resolved numeric Abu Dhabi city authoritative over a stale Dubai district", async () => {
    stubOrder(
      { countryCode: "AE", cityId: 43, district: "Dubai" },
      { name: "Abu Dhabi", slug: "abu-dhabi" },
    );

    await notifyNewUaeOrderToSlack({ orderId: ORDER_ID, workspaceOwnerId: OWNER_ID });

    expect(mocks.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: ABU_DHABI }),
    );
    expect(mocks.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ channel: DUBAI }),
    );
  });

  it("skips non-UAE orders without opening Slack", async () => {
    stubOrder({ countryCode: "LB", cityId: "beirut" });

    await notifyNewUaeOrderToSlack({ orderId: ORDER_ID, workspaceOwnerId: OWNER_ID });

    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.postMessage).not.toHaveBeenCalled();
  });

  it("logs and skips when the exact Abu Dhabi channel is unavailable", async () => {
    delete process.env.SLACK_ABU_DHABI_CHANNEL_ID;
    stubOrder({ countryCode: "AE", cityId: "abu-dhabi", district: "Abu Dhabi" });

    await notifyNewUaeOrderToSlack({ orderId: ORDER_ID, workspaceOwnerId: OWNER_ID });

    expect(mocks.postMessage).not.toHaveBeenCalled();
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "abu_dhabi_channel_not_configured" }),
      expect.stringContaining("target channel is not configured"),
    );
  });

  it("logs a Slack failure and never throws into order creation", async () => {
    stubOrder({ countryCode: "AE", cityId: "dubai" }, { name: "Dubai", slug: "dubai" });
    mocks.postMessage.mockRejectedValue(new Error("not_in_channel"));

    await expect(
      notifyNewUaeOrderToSlack({ orderId: ORDER_ID, workspaceOwnerId: OWNER_ID }),
    ).resolves.toBeUndefined();

    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: ORDER_ID, err: expect.any(Error) }),
      expect.stringContaining("order is unaffected"),
    );
  });
});
