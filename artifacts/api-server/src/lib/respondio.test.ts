import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { logger } from "./logger";
import {
  findOrCreateContactByPhone,
  sendWhatsAppTemplateToContact,
  updateContactName,
  setContactCustomAttributes,
  normalizePhoneForCountry,
} from "./respondio";
import { RESPONDIO_ORDER_PAYMENT_TEMPLATE_CONTRACTS } from "./respondioOrderTemplates";
import { ADDRESS_COLLECTION_TEMPLATE_CONTRACT } from "./addressCollector/config";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("RESPONDIO_API_TOKEN", "test-token");
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const jsonResponse = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

const textResponse = (status: number, body: unknown) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  }) as unknown as Response;

const CHANNEL_ID = 543704;
const APPROVED_LIVE_TEMPLATE_TEXT = {
  address_collection:
    "Hi {{1}}! Natasha here from Presentail support.\nSomeone sent you a gift! 💐\n\nPlease share your location so the driver delivers the order as soon as possible. 📍",
  new_order_received:
    "Hi {{1}}! 🌸\nWe’ve received your order.\n\n*Order Number:* {{2}}\n*Delivery Date:* {{3}}\n*Delivery Time:* {{4}}\n\nWe’ll send you a photo of your arrangement here before it goes out for delivery. 💐",
  order_ready:
    "Hi {{1}}. Natasha here! Your order is now ready. 😁\n\n*Order Number:* {{2}} ❤️",
  order_delivered:
    "Your order has been delivered! 💐\n\nThank you for choosing Presentail ❤️ We hope they love it!\n\nIf you have a moment, we’d really appreciate it if you could leave us a review. Your feedback means a lot to us.",
  whishpayment:
    "Hi {{1}},\n\nTo finish your order, please send your payment via Whish to the account number below. Once we receive it, we'll confirm your order right away.\n\n*WHISH ACCOUNT NUMBER:* +961 3 159 639\n\n*AMOUNT DUE:* {{2}} {{3}}\n\nThank you. ",
} as const;
const APPROVED_REVIEW_URL = "https://g.page/r/CWGtXONHheoLEBM/review";

describe("normalizePhoneForCountry", () => {
  it("normalizes Lebanese local mobile formatting to E.164", () => {
    expect(normalizePhoneForCountry("03 159 639", "LB")).toBe("+9613159639");
  });

  it("preserves valid international numbers regardless of country hint", () => {
    expect(normalizePhoneForCountry("+971 50 123 4567", "LB")).toBe("+971501234567");
  });

  it("rejects ambiguous local numbers without a country", () => {
    expect(normalizePhoneForCountry("03 159 639")).toBeNull();
  });
});

describe("sendWhatsAppTemplateToContact order/payment contracts", () => {
  const cases = [
    {
      label: "new order",
      contract: RESPONDIO_ORDER_PAYMENT_TEMPLATE_CONTRACTS.new_order_received,
      bodyParameters: ["Rana", "LB-1024", "22 August 2026", "8:00 AM–2:00 PM"],
      headerImageUrl: "https://cdn.example.com/new-order.png",
      components: [
        {
          type: "header",
          format: "image",
          parameters: [{ type: "image", image: { link: "https://cdn.example.com/new-order.png" } }],
        },
        {
          type: "body",
          text: APPROVED_LIVE_TEMPLATE_TEXT.new_order_received,
          parameters: [
            { type: "text", text: "Rana" },
            { type: "text", text: "LB-1024" },
            { type: "text", text: "22 August 2026" },
            { type: "text", text: "8:00 AM–2:00 PM" },
          ],
        },
        {
          type: "footer",
          text: "Natasha From Presentail Support",
        },
      ],
    },
    {
      label: "ready order",
      contract: RESPONDIO_ORDER_PAYMENT_TEMPLATE_CONTRACTS.order_ready,
      bodyParameters: ["Rana", "LB-1024"],
      headerImageUrl: "https://cdn.example.com/order-ready.png",
      components: [
        {
          type: "header",
          format: "image",
          parameters: [{ type: "image", image: { link: "https://cdn.example.com/order-ready.png" } }],
        },
        {
          type: "body",
          text: APPROVED_LIVE_TEMPLATE_TEXT.order_ready,
          parameters: [{ type: "text", text: "Rana" }, { type: "text", text: "LB-1024" }],
        },
      ],
    },
    {
      label: "delivered order static body",
      contract: RESPONDIO_ORDER_PAYMENT_TEMPLATE_CONTRACTS.order_delivered,
      bodyParameters: [],
      headerImageUrl: "https://cdn.example.com/order-delivered.png",
      components: [
        {
          type: "header",
          format: "image",
          parameters: [{ type: "image", image: { link: "https://cdn.example.com/order-delivered.png" } }],
        },
        {
          type: "body",
          text: APPROVED_LIVE_TEMPLATE_TEXT.order_delivered,
          parameters: [],
        },
        {
          type: "buttons",
          buttons: [{ type: "url", text: "Leave a Review", url: APPROVED_REVIEW_URL }],
        },
      ],
    },
    {
      label: "Whish payment",
      contract: RESPONDIO_ORDER_PAYMENT_TEMPLATE_CONTRACTS.whishpayment,
      bodyParameters: ["Ahmad Saade", "AED", "200.00"],
      headerImageUrl: null,
      components: [
        {
          type: "body",
          text: APPROVED_LIVE_TEMPLATE_TEXT.whishpayment,
          parameters: [
            { type: "text", text: "Ahmad Saade" },
            { type: "text", text: "AED" },
            { type: "text", text: "200.00" },
          ],
        },
      ],
    },
  ] as const;

  it.each(cases)("serializes the approved $label template exactly", async (template) => {
    fetchMock.mockResolvedValueOnce(textResponse(200, { messageId: 77 }));

    await expect(
      sendWhatsAppTemplateToContact("cid-1", {
        contract: template.contract,
        bodyParameters: [...template.bodyParameters],
        channelId: CHANNEL_ID,
        headerImageUrl: template.headerImageUrl,
      }),
    ).resolves.toEqual({ ok: true, providerRef: "77" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.respond.io/v2/contact/id%3Acid-1/message",
      expect.objectContaining({ method: "POST" }),
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({
      channelId: CHANNEL_ID,
      message: {
        type: "whatsapp_template",
        template: {
          name: template.contract.templateName,
          languageCode: "en",
          components: template.components,
        },
      },
    });
  });

  it("serializes address_collection with approved text for Inbox rendering and workflow matching", async () => {
    fetchMock.mockResolvedValueOnce(textResponse(200, { messageId: 78 }));

    await expect(
      sendWhatsAppTemplateToContact("cid-address", {
        contract: ADDRESS_COLLECTION_TEMPLATE_CONTRACT,
        bodyParameters: ["Maya"],
        channelId: CHANNEL_ID,
      }),
    ).resolves.toEqual({ ok: true, providerRef: "78" });

    const payload = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(payload).toEqual({
      channelId: CHANNEL_ID,
      message: {
        type: "whatsapp_template",
        template: {
          name: "address_collection",
          languageCode: "en",
          components: [
            {
              type: "body",
              text: APPROVED_LIVE_TEMPLATE_TEXT.address_collection,
              parameters: [{ type: "text", text: "Maya" }],
            },
          ],
        },
      },
    });
    expect(payload.message.template.components[0].text).toBe(
      APPROVED_LIVE_TEMPLATE_TEXT.address_collection,
    );
    expect(JSON.stringify(payload)).not.toContain('"examples"');
  });

  it("fails before transport when a contract has the wrong number of parameters", async () => {
    await expect(
      sendWhatsAppTemplateToContact("cid-1", {
        contract: RESPONDIO_ORDER_PAYMENT_TEMPLATE_CONTRACTS.new_order_received,
        bodyParameters: ["Rana", "LB-1024", "22 August 2026"],
        channelId: CHANNEL_ID,
        headerImageUrl: "https://cdn.example.com/new-order.png",
      }),
    ).resolves.toEqual({
      ok: false,
      retryable: false,
      errorCode: "template_contract_invalid",
      errorMessage: "Template requires exactly 4 non-empty body parameters",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ templateName: "new_order_received", errorCode: "template_contract_invalid" }),
      "respondio template contract rejected before send",
    );
  });

  it("fails before transport when a required header or selected channel is absent", async () => {
    await expect(
      sendWhatsAppTemplateToContact("cid-1", {
        contract: RESPONDIO_ORDER_PAYMENT_TEMPLATE_CONTRACTS.order_delivered,
        bodyParameters: [],
        channelId: null,
        headerImageUrl: null,
      }),
    ).resolves.toMatchObject({
      ok: false,
      errorCode: "missing_channel",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports missing Respond.io configuration safely", async () => {
    vi.stubEnv("RESPONDIO_API_TOKEN", "");
    await expect(
      sendWhatsAppTemplateToContact("cid-1", {
        contract: RESPONDIO_ORDER_PAYMENT_TEMPLATE_CONTRACTS.whishpayment,
        bodyParameters: ["Ahmad Saade", "USD", "90.00"],
        channelId: CHANNEL_ID,
        headerImageUrl: null,
      }),
    ).resolves.toEqual({
      ok: false,
      retryable: false,
      errorCode: "not_configured",
      errorMessage: "RESPONDIO_API_TOKEN missing",
    });
  });

  it("surfaces the provider rejection message in the returned errorMessage and in the warning log", async () => {
    fetchMock.mockResolvedValueOnce(
      textResponse(400, { message: "channel not found for contactId" }),
    );

    await expect(
      sendWhatsAppTemplateToContact("cid-1", {
        contract: RESPONDIO_ORDER_PAYMENT_TEMPLATE_CONTRACTS.order_ready,
        bodyParameters: ["Rana", "LB-1024"],
        channelId: CHANNEL_ID,
        headerImageUrl: "https://cdn.example.com/order-ready.png",
      }),
    ).resolves.toEqual({
      ok: false,
      retryable: false,
      errorCode: "http_400",
      errorMessage: "Respond.io rejected the template (HTTP 400): channel not found for contactId",
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 400,
        message: "Respond.io rejected the template (HTTP 400)",
        providerMessage: "channel not found for contactId",
        contactId: "cid-1",
        templateName: "order_ready",
      }),
      "respondio sendWhatsAppTemplate failed",
    );
  });

  it("falls back to the generic message when the provider body has no message field", async () => {
    fetchMock.mockResolvedValueOnce(textResponse(400, {}));

    await expect(
      sendWhatsAppTemplateToContact("cid-1", {
        contract: RESPONDIO_ORDER_PAYMENT_TEMPLATE_CONTRACTS.order_ready,
        bodyParameters: ["Rana", "LB-1024"],
        channelId: CHANNEL_ID,
        headerImageUrl: "https://cdn.example.com/order-ready.png",
      }),
    ).resolves.toEqual({
      ok: false,
      retryable: false,
      errorCode: "http_400",
      errorMessage: "Respond.io rejected the template (HTTP 400)",
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 400,
        message: "Respond.io rejected the template (HTTP 400)",
        providerMessage: null,
        contactId: "cid-1",
        templateName: "order_ready",
      }),
      "respondio sendWhatsAppTemplate failed",
    );
  });
});

describe("body component shape — zero vs non-zero parameters", () => {
  it("preserves approved text and an empty parameters array for a zero-param static template", async () => {
    fetchMock.mockResolvedValueOnce(textResponse(200, { messageId: 1 }));

    await sendWhatsAppTemplateToContact("cid-1", {
      contract: RESPONDIO_ORDER_PAYMENT_TEMPLATE_CONTRACTS.order_delivered,
      bodyParameters: [],
      channelId: CHANNEL_ID,
      headerImageUrl: "https://cdn.example.com/order-delivered.png",
    });

    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    const bodyComponent = sent.message.template.components.find(
      (c: { type: string }) => c.type === "body",
    );
    expect(bodyComponent).toEqual({
      type: "body",
      text: RESPONDIO_ORDER_PAYMENT_TEMPLATE_CONTRACTS.order_delivered.staticBodyText,
      parameters: [],
    });
  });

  it("includes the parameters array for a template that has body variables", async () => {
    fetchMock.mockResolvedValueOnce(textResponse(200, { messageId: 2 }));

    await sendWhatsAppTemplateToContact("cid-1", {
      contract: RESPONDIO_ORDER_PAYMENT_TEMPLATE_CONTRACTS.order_ready,
      bodyParameters: ["Rana", "LB-1024"],
      channelId: CHANNEL_ID,
      headerImageUrl: "https://cdn.example.com/order-ready.png",
    });

    const sent = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    const bodyComponent = sent.message.template.components.find(
      (c: { type: string }) => c.type === "body",
    );
    expect(bodyComponent.text).toBe(
      RESPONDIO_ORDER_PAYMENT_TEMPLATE_CONTRACTS.order_ready.staticBodyText,
    );
    expect(bodyComponent.parameters).toEqual([
      { type: "text", text: "Rana" },
      { type: "text", text: "LB-1024" },
    ]);
  });
});

describe("findOrCreateContactByPhone response shapes", () => {
  it("extracts the id from the live create_or_update shape { contactId }", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { contactId: 513976736 }));
    await expect(findOrCreateContactByPhone("+96170000001", "A", "B")).resolves.toBe("513976736");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.respond.io/v2/contact/create_or_update/phone%3A%2B96170000001",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ firstName: "A", lastName: "B", phone: "+96170000001" }),
      }),
    );
  });

  it("falls back to a contact GET when create_or_update omits the ID", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, {}))
      .mockResolvedValueOnce(jsonResponse(200, { id: 99 }));
    await expect(findOrCreateContactByPhone("+96170000001")).resolves.toBe("99");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns phone_format_invalid without a network call for a bad phone", async () => {
    await expect(findOrCreateContactByPhone("70123")).resolves.toBe("phone_format_invalid");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not log a raw provider body when contact creation fails", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, { message: "Rejected https://os.example.com/address/secret-token" }),
    );

    await expect(findOrCreateContactByPhone("+96170000001")).resolves.toBeNull();

    expect(logger.warn).toHaveBeenCalledWith(
      { status: 400 },
      "respondio create_or_update failed",
    );
  });
});

describe("updateContactName", () => {
  it("updates an already-linked contact by respond.io id", async () => {
    fetchMock.mockResolvedValueOnce(textResponse(200, { contactId: 42 }));

    await expect(updateContactName("42", "Rana", "K")).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.respond.io/v2/contact/create_or_update/id%3A42",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ firstName: "Rana", lastName: "K" }),
      }),
    );
  });
});

describe("setContactCustomAttributes", () => {
  it("POSTs custom attributes onto the contact and returns true on success", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { contactId: 42 }));

    await expect(
      setContactCustomAttributes("42", { address_collection_ref: "req-uuid-1" }),
    ).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.respond.io/v2/contact/create_or_update/id%3A42",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ customAttributes: { address_collection_ref: "req-uuid-1" } }),
      }),
    );
  });

  it("returns false and warns on API failure, never throws", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(400, {}));

    await expect(
      setContactCustomAttributes("42", { address_collection_ref: "x" }),
    ).resolves.toBe(false);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ status: 400, contactId: "42" }),
      "respondio setContactCustomAttributes failed",
    );
  });

  it("returns false on network error, never throws", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network failure"));

    await expect(
      setContactCustomAttributes("42", { address_collection_ref: "x" }),
    ).resolves.toBe(false);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ contactId: "42" }),
      "respondio setContactCustomAttributes error",
    );
  });

  it("is a no-op when RESPONDIO_API_TOKEN is not configured", async () => {
    vi.stubEnv("RESPONDIO_API_TOKEN", "");

    await expect(
      setContactCustomAttributes("42", { address_collection_ref: "x" }),
    ).resolves.toBe(false);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
