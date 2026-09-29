import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockFindOrCreate, mockSendTemplate, mockSetCustomAttrs } = vi.hoisted(() => ({
  mockFindOrCreate: vi.fn(),
  mockSendTemplate: vi.fn(),
  mockSetCustomAttrs: vi.fn(),
}));

vi.mock("../respondio", () => ({
  isRespondIoEnabled: () => !!process.env.RESPONDIO_API_TOKEN,
  findOrCreateContactByPhone: (...a: unknown[]) => mockFindOrCreate(...a),
  sendWhatsAppTemplateToContact: (...a: unknown[]) => mockSendTemplate(...a),
  setContactCustomAttributes: (...a: unknown[]) => mockSetCustomAttrs(...a),
}));

vi.mock("../logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { sendWhatsAppAddressRequest, sendSmsAddressRequest, smsFallbackText, formatWindowLabel } from "./providers";
import { ADDRESS_COLLECTION_TEMPLATE_CONTRACT } from "./config";

const opts = {
  phone: "+96181865589",
  recipientName: "Maya Khalil",
  orderReference: "M-1001",
  language: "en",
  secureUrl: "https://x.test/address/tok",
  requestRef: "req-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.RESPONDIO_API_TOKEN = "token";
  delete process.env.TWILIO_ACCOUNT_SID;
  mockSetCustomAttrs.mockResolvedValue(true);
});

describe("sendWhatsAppAddressRequest", () => {
  it("is blocked-by-configuration when respond.io is not configured", async () => {
    delete process.env.RESPONDIO_API_TOKEN;
    const r = await sendWhatsAppAddressRequest(opts);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.blockedByConfig).toBe(true);
  });

  it("classifies invalid phone as permanent, lookup failure as retryable", async () => {
    mockFindOrCreate.mockResolvedValueOnce("phone_format_invalid");
    let r = await sendWhatsAppAddressRequest(opts);
    if (r.ok) throw new Error("expected failure");
    expect(r.retryable).toBe(false);

    mockFindOrCreate.mockResolvedValueOnce(null);
    r = await sendWhatsAppAddressRequest(opts);
    if (r.ok) throw new Error("expected failure");
    expect(r.retryable).toBe(true);
  });

  it("sends the WhatsApp template with surprise-safe body parameters", async () => {
    mockFindOrCreate.mockResolvedValue("123");
    mockSendTemplate.mockResolvedValue({ ok: true, providerRef: "msg-1" });
    const r = await sendWhatsAppAddressRequest(opts);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.providerRef).toBe("msg-1");
      expect(r.respondioContactId).toBe("123");
    }
    expect(mockSendTemplate).toHaveBeenCalledTimes(1);
    const [contactId, sendOpts] = mockSendTemplate.mock.calls[0] as [
      string,
      {
        contract: typeof ADDRESS_COLLECTION_TEMPLATE_CONTRACT;
        bodyParameters: string[];
        channelId: number;
      },
    ];
    expect(contactId).toBe("123");
    expect(sendOpts.contract).toBe(ADDRESS_COLLECTION_TEMPLATE_CONTRACT);
    expect(sendOpts.contract.templateName).toBe("address_collection");
    expect(sendOpts.contract.languageCode).toBe("en");
    expect(sendOpts.contract.staticBodyText).toContain("Please share your location");
    expect(sendOpts.bodyParameters).toEqual([opts.recipientName]);
    expect(sendOpts.channelId).toBe(543704);
    // No sender/gift/price details ever sent
    expect(JSON.stringify(sendOpts.bodyParameters).toLowerCase()).not.toMatch(/sender|gift|price|card/);
  });

  it("uses the approved English template even for Arabic recipients", async () => {
    mockFindOrCreate.mockResolvedValue("123");
    mockSendTemplate.mockResolvedValue({ ok: true, providerRef: null });
    const r = await sendWhatsAppAddressRequest({ ...opts, language: "ar" });
    expect(r.ok).toBe(true);
    const [, sendOpts] = mockSendTemplate.mock.calls[0] as [
      string,
      { contract: typeof ADDRESS_COLLECTION_TEMPLATE_CONTRACT },
    ];
    expect(sendOpts.contract.languageCode).toBe("en");
  });

  it("writes address_collection_ref onto the contact before sending the template", async () => {
    mockFindOrCreate.mockResolvedValue("contact-999");
    mockSendTemplate.mockResolvedValue({ ok: true, providerRef: "msg-2" });
    await sendWhatsAppAddressRequest({ ...opts, requestRef: "req-uuid-abc" });
    expect(mockSetCustomAttrs).toHaveBeenCalledWith("contact-999", {
      address_collection_ref: "req-uuid-abc",
    });
    // attribute write must happen before template send
    expect(mockSetCustomAttrs.mock.invocationCallOrder[0]).toBeLessThan(
      mockSendTemplate.mock.invocationCallOrder[0],
    );
  });

  it("does not fail the send when the custom-attributes write errors", async () => {
    mockFindOrCreate.mockResolvedValue("contact-999");
    mockSetCustomAttrs.mockRejectedValue(new Error("unexpected throw"));
    mockSendTemplate.mockResolvedValue({ ok: true, providerRef: "msg-3" });
    const r = await sendWhatsAppAddressRequest(opts);
    expect(r.ok).toBe(true);
    expect(mockSendTemplate).toHaveBeenCalledTimes(1);
  });

  it("propagates retryable classification from the template send (429/5xx)", async () => {
    mockFindOrCreate.mockResolvedValue("123");
    mockSendTemplate.mockResolvedValue({ ok: false, retryable: true, errorCode: "http_429", errorMessage: "rate" });
    const r = await sendWhatsAppAddressRequest(opts);
    if (r.ok) throw new Error("expected failure");
    expect(r.retryable).toBe(true);
  });

  it("does not require a secure-link URL for the reply template", async () => {
    mockFindOrCreate.mockResolvedValue("123");
    mockSendTemplate.mockResolvedValue({ ok: true, providerRef: "msg-url-free" });
    const r = await sendWhatsAppAddressRequest({ ...opts, secureUrl: "http://localhost/address/token" });
    expect(r).toMatchObject({ ok: true });
    expect(mockSendTemplate).toHaveBeenCalledOnce();
  });

  it("does not send the template with empty approved variables", async () => {
    const r = await sendWhatsAppAddressRequest({ ...opts, recipientName: " " });
    expect(r).toMatchObject({
      ok: false,
      retryable: false,
      blockedByConfig: true,
      errorCode: "missing_template_value",
    });
    expect(mockFindOrCreate).not.toHaveBeenCalled();
  });
});

describe("sendSmsAddressRequest", () => {
  it("is blocked-by-configuration when Twilio env vars are missing", async () => {
    const r = await sendSmsAddressRequest({ ...opts, windowLabel: "Thursday, 4 PM–7 PM" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.blockedByConfig).toBe(true);
      expect(r.retryable).toBe(false);
    }
  });
});

describe("message content", () => {
  it("SMS text is surprise-safe in both languages", () => {
    for (const lang of ["en", "ar"]) {
      const text = smsFallbackText(lang, "Thursday, 4 PM", "https://x.test/a/t");
      expect(text).toContain("https://x.test/a/t");
      expect(text.toLowerCase()).not.toMatch(/sender|gift|price|card|from /);
    }
  });

  it("formats the window label in the delivery timezone", () => {
    const label = formatWindowLabel(
      new Date(Date.UTC(2026, 7, 20, 13)),
      new Date(Date.UTC(2026, 7, 20, 16)),
      "Asia/Beirut",
      "en",
    );
    expect(label).toContain("4"); // 16:00 Beirut
    expect(label).toContain("7");
  });
});
