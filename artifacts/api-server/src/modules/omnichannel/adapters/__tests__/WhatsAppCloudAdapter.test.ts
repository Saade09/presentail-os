import { createHmac } from "crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request } from "express";
import { WhatsAppCloudAdapter } from "../WhatsAppCloudAdapter";
import { WebhookVerificationError, ProviderRateLimitError, ProviderAuthError } from "../../errors";

const APP_SECRET = "test-app-secret-32-chars-long!!!";

function makeAdapter() {
  return new WhatsAppCloudAdapter(APP_SECRET);
}

function makeSig(body: string, secret = APP_SECRET) {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

function fakeReq(overrides: Partial<Request> = {}): Request {
  return {
    method: "POST",
    headers: {},
    query: {},
    body: {},
    ...overrides,
  } as unknown as Request;
}

// ---------------------------------------------------------------------------
// verifyWebhook
// ---------------------------------------------------------------------------

describe("WhatsAppCloudAdapter.verifyWebhook", () => {
  it("returns challenge on valid GET hub challenge", async () => {
    const adapter = makeAdapter();
    const req = fakeReq({
      method: "GET",
      query: {
        "hub.mode": "subscribe",
        "hub.verify_token": "my-verify-token",
        "hub.challenge": "challenge-abc",
      } as Record<string, string>,
    });
    const result = await adapter.verifyWebhook(req, "my-verify-token");
    expect(result).toBe("challenge-abc");
  });

  it("throws WebhookVerificationError on GET with wrong token", async () => {
    const adapter = makeAdapter();
    const req = fakeReq({
      method: "GET",
      query: {
        "hub.mode": "subscribe",
        "hub.verify_token": "wrong-token",
        "hub.challenge": "challenge-abc",
      } as Record<string, string>,
    });
    await expect(adapter.verifyWebhook(req, "correct-token")).rejects.toThrow(WebhookVerificationError);
  });

  it("returns undefined on valid POST with correct signature", async () => {
    const adapter = makeAdapter();
    const bodyStr = JSON.stringify({ object: "whatsapp_business_account" });
    const rawBody = Buffer.from(bodyStr);
    const sig = makeSig(bodyStr);
    const req = fakeReq({
      method: "POST",
      headers: { "x-hub-signature-256": sig },
      rawBody,
    } as unknown as Request);
    const result = await adapter.verifyWebhook(req, "");
    expect(result).toBeUndefined();
  });

  it("throws WebhookVerificationError on POST with wrong signature", async () => {
    const adapter = makeAdapter();
    const bodyStr = JSON.stringify({ object: "whatsapp_business_account" });
    const rawBody = Buffer.from(bodyStr);
    const badSig = makeSig(bodyStr, "wrong-secret");
    const req = fakeReq({
      method: "POST",
      headers: { "x-hub-signature-256": badSig },
      rawBody,
    } as unknown as Request);
    await expect(adapter.verifyWebhook(req, "")).rejects.toThrow(WebhookVerificationError);
  });

  it("throws WebhookVerificationError on POST with missing signature header", async () => {
    const adapter = makeAdapter();
    const req = fakeReq({ method: "POST", headers: {} });
    await expect(adapter.verifyWebhook(req, "")).rejects.toThrow(WebhookVerificationError);
  });
});

// ---------------------------------------------------------------------------
// normalizeInboundMessage
// ---------------------------------------------------------------------------

describe("WhatsAppCloudAdapter.normalizeInboundMessage", () => {
  const adapter = makeAdapter();

  it("normalizes a text message", () => {
    const raw = {
      from: "15559876543",
      id: "wamid.test123",
      timestamp: "1700000000",
      type: "text",
      text: { body: "Hello World" },
    };
    const msg = adapter.normalizeInboundMessage(raw);
    expect(msg.provider).toBe("whatsapp");
    expect(msg.messageType).toBe("text");
    expect(msg.content).toBe("Hello World");
    expect(msg.senderExternalUserId).toBe("15559876543");
    expect(msg.externalMessageId).toBe("wamid.test123");
    expect(msg.direction).toBe("inbound");
  });

  it("normalizes an image message", () => {
    const raw = {
      from: "15559876543",
      id: "wamid.img123",
      timestamp: "1700000000",
      type: "image",
      image: {
        id: "media_id_999",
        mime_type: "image/jpeg",
        caption: "Nice photo",
      },
    };
    const msg = adapter.normalizeInboundMessage(raw);
    expect(msg.messageType).toBe("image");
    expect(msg.mediaUrl).toBe("media_id_999");
    expect(msg.mediaMimeType).toBe("image/jpeg");
    expect(msg.content).toBe("Nice photo");
  });

  it("normalizes a location message", () => {
    const raw = {
      from: "15559876543",
      id: "wamid.loc123",
      timestamp: "1700000000",
      type: "location",
      location: { latitude: 33.8, longitude: 35.5, name: "Beirut" },
    };
    const msg = adapter.normalizeInboundMessage(raw);
    expect(msg.messageType).toBe("location");
    expect(msg.content).toContain("33.8");
  });

  it("maps unknown message type to unsupported", () => {
    const raw = {
      from: "15559876543",
      id: "wamid.unknown",
      timestamp: "1700000000",
      type: "order",
    };
    const msg = adapter.normalizeInboundMessage(raw);
    expect(msg.messageType).toBe("unsupported");
  });
});

// ---------------------------------------------------------------------------
// sendMessage
// ---------------------------------------------------------------------------

describe("WhatsAppCloudAdapter.sendMessage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns success result on 200 response", async () => {
    const adapter = makeAdapter();
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ messages: [{ id: "wamid.sent123" }] }),
        { status: 200 },
      ),
    );
    const result = await adapter.sendMessage(
      "15559876543",
      { messageType: "text", content: "Hello" },
      "PHONE_NUMBER_ID|access-token-abc",
    );
    expect(result.success).toBe(true);
    expect(result.externalMessageId).toBe("wamid.sent123");
    expect(result.status).toBe("sent");
  });

  it("returns failure result on 4xx error response", async () => {
    const adapter = makeAdapter();
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: { message: "Invalid recipient", code: 131031, type: "OAuthException" },
        }),
        { status: 400 },
      ),
    );
    const result = await adapter.sendMessage(
      "invalid",
      { messageType: "text", content: "Hello" },
      "PHONE_NUMBER_ID|access-token-abc",
    );
    expect(result.success).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("PROVIDER_ERROR");
  });

  it("throws ProviderRateLimitError on rate limit error code", async () => {
    const adapter = makeAdapter();
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: { message: "Rate limit hit", code: 130429 },
        }),
        { status: 429 },
      ),
    );
    await expect(
      adapter.sendMessage("15559876543", { messageType: "text", content: "Hello" }, "PHONE_ID|token"),
    ).rejects.toThrow(ProviderRateLimitError);
  });

  it("throws ProviderAuthError on auth error code", async () => {
    const adapter = makeAdapter();
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: { message: "Invalid access token", code: 190 },
        }),
        { status: 401 },
      ),
    );
    await expect(
      adapter.sendMessage("15559876543", { messageType: "text", content: "Hello" }, "PHONE_ID|token"),
    ).rejects.toThrow(ProviderAuthError);
  });

  it("returns validation error for empty text content", async () => {
    const adapter = makeAdapter();
    const result = await adapter.sendMessage(
      "15559876543",
      { messageType: "text", content: "" },
      "PHONE_ID|token",
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("VALIDATION_FAILED");
  });
});

// ---------------------------------------------------------------------------
// sendTemplateMessage
// ---------------------------------------------------------------------------

describe("WhatsAppCloudAdapter.sendTemplateMessage", () => {
  it("sends a template message successfully", async () => {
    const adapter = makeAdapter();
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ messages: [{ id: "wamid.tmpl456" }] }),
        { status: 200 },
      ),
    );
    const result = await adapter.sendTemplateMessage(
      "15559876543",
      "order_confirmation",
      { language_code: "en_US", components: [] },
      "PHONE_ID|token",
    );
    expect(result.success).toBe(true);
    expect(result.externalMessageId).toBe("wamid.tmpl456");
  });
});

// ---------------------------------------------------------------------------
// getCapabilities
// ---------------------------------------------------------------------------

describe("WhatsAppCloudAdapter.getCapabilities", () => {
  it("reports correct capabilities", () => {
    const adapter = makeAdapter();
    const caps = adapter.getCapabilities();
    expect(caps.provider).toBe("whatsapp");
    expect(caps.supportsTemplate).toBe(true);
    expect(caps.maxTextLength).toBe(4096);
    expect(caps.has24HourWindow).toBe(true);
    expect(caps.supportsLocation).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// mapProviderError
// ---------------------------------------------------------------------------

describe("WhatsAppCloudAdapter.mapProviderError", () => {
  const adapter = makeAdapter();

  it("maps rate limit error code to PROVIDER_RATE_LIMIT", () => {
    const err = adapter.mapProviderError({ error: { code: 130429, message: "Too many requests" } });
    expect(err.code).toBe("PROVIDER_RATE_LIMIT");
    expect(err.retryable).toBe(true);
  });

  it("maps auth error code to PROVIDER_AUTH_ERROR", () => {
    const err = adapter.mapProviderError({ error: { code: 190, message: "Invalid token" } });
    expect(err.code).toBe("PROVIDER_AUTH_ERROR");
    expect(err.retryable).toBe(false);
  });

  it("maps unknown error to PROVIDER_ERROR", () => {
    const err = adapter.mapProviderError({ error: { code: 999, message: "Something went wrong" } });
    expect(err.code).toBe("PROVIDER_ERROR");
    expect(err.retryable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// refreshTokenIfNeeded
// ---------------------------------------------------------------------------

describe("WhatsAppCloudAdapter.refreshTokenIfNeeded", () => {
  it("returns the same token (WhatsApp tokens do not expire)", async () => {
    const adapter = makeAdapter();
    const result = await adapter.refreshTokenIfNeeded("my-token", null, null);
    expect(result).toBe("my-token");
  });
});
