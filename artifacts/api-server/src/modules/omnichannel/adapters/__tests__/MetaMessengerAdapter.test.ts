import { createHmac } from "crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request } from "express";
import { MetaMessengerAdapter } from "../MetaMessengerAdapter";
import { WebhookVerificationError, ProviderRateLimitError, ProviderAuthError } from "../../errors";

const APP_SECRET = "test-meta-app-secret-32-chars!!!";

function makeAdapter() {
  return new MetaMessengerAdapter(APP_SECRET);
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

describe("MetaMessengerAdapter.verifyWebhook", () => {
  it("returns challenge on valid GET hub challenge", async () => {
    const adapter = makeAdapter();
    const req = fakeReq({
      method: "GET",
      query: {
        "hub.mode": "subscribe",
        "hub.verify_token": "page-verify-token",
        "hub.challenge": "challenge-xyz",
      } as Record<string, string>,
    });
    const result = await adapter.verifyWebhook(req, "page-verify-token");
    expect(result).toBe("challenge-xyz");
  });

  it("throws WebhookVerificationError on GET with wrong verify token", async () => {
    const adapter = makeAdapter();
    const req = fakeReq({
      method: "GET",
      query: {
        "hub.mode": "subscribe",
        "hub.verify_token": "wrong",
        "hub.challenge": "challenge-xyz",
      } as Record<string, string>,
    });
    await expect(adapter.verifyWebhook(req, "correct-token")).rejects.toThrow(WebhookVerificationError);
  });

  it("returns undefined on POST with valid HMAC signature", async () => {
    const adapter = makeAdapter();
    const bodyStr = JSON.stringify({ object: "page" });
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
    const bodyStr = JSON.stringify({ object: "page" });
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

describe("MetaMessengerAdapter.normalizeInboundMessage", () => {
  const adapter = makeAdapter();

  it("normalizes a text message", () => {
    const raw = {
      mid: "m_abc123",
      from: "USER_PSID_999",
      timestamp: 1700000000000,
      text: "Hello Messenger!",
    };
    const msg = adapter.normalizeInboundMessage(raw);
    expect(msg.provider).toBe("messenger");
    expect(msg.messageType).toBe("text");
    expect(msg.content).toBe("Hello Messenger!");
    expect(msg.senderExternalUserId).toBe("USER_PSID_999");
    expect(msg.externalMessageId).toBe("m_abc123");
    expect(msg.direction).toBe("inbound");
  });

  it("normalizes an image attachment message", () => {
    const raw = {
      mid: "m_img456",
      from: "USER_PSID_999",
      timestamp: 1700000000000,
      attachments: [
        {
          type: "image",
          payload: { url: "https://cdn.example.com/photo.jpg" },
        },
      ],
    };
    const msg = adapter.normalizeInboundMessage(raw);
    expect(msg.messageType).toBe("image");
    expect(msg.mediaUrl).toBe("https://cdn.example.com/photo.jpg");
  });

  it("normalizes a file attachment as document", () => {
    const raw = {
      mid: "m_file789",
      from: "USER_PSID_999",
      timestamp: 1700000000000,
      attachments: [
        {
          type: "file",
          payload: { url: "https://cdn.example.com/doc.pdf" },
        },
      ],
    };
    const msg = adapter.normalizeInboundMessage(raw);
    expect(msg.messageType).toBe("document");
  });

  it("normalizes a quick reply as interactive", () => {
    const raw = {
      mid: "m_qr123",
      from: "USER_PSID_999",
      timestamp: 1700000000000,
      quick_reply: { payload: "YES_CONFIRM" },
    };
    const msg = adapter.normalizeInboundMessage(raw);
    expect(msg.messageType).toBe("interactive");
    expect(msg.interactivePayload).toEqual({ payload: "YES_CONFIRM" });
  });
});

// ---------------------------------------------------------------------------
// parseWebhookEvent
// ---------------------------------------------------------------------------

describe("MetaMessengerAdapter.parseWebhookEvent", () => {
  const adapter = makeAdapter();

  it("parses a page messaging webhook event", async () => {
    const payload = {
      object: "page",
      entry: [
        {
          id: "PAGE_ID",
          time: 1700000000000,
          messaging: [
            {
              sender: { id: "USER_PSID" },
              recipient: { id: "PAGE_ID" },
              timestamp: 1700000000000,
              message: { mid: "m_hello", text: "Hi there" },
            },
          ],
        },
      ],
    };
    const event = await adapter.parseWebhookEvent(payload, "PAGE_ID");
    expect(event.provider).toBe("messenger");
    expect(event.messages).toHaveLength(1);
    expect(event.messages[0].content).toBe("Hi there");
    expect(event.contacts).toHaveLength(1);
    expect(event.contacts[0].externalUserId).toBe("USER_PSID");
  });

  it("parses delivery status events", async () => {
    const payload = {
      object: "page",
      entry: [
        {
          id: "PAGE_ID",
          time: 1700000000000,
          messaging: [
            {
              sender: { id: "USER_PSID" },
              recipient: { id: "PAGE_ID" },
              timestamp: 1700000000000,
              delivery: { mids: ["m_delivered1", "m_delivered2"], watermark: 1700000000000 },
            },
          ],
        },
      ],
    };
    const event = await adapter.parseWebhookEvent(payload, "PAGE_ID");
    expect(event.statuses).toHaveLength(2);
    expect(event.statuses[0].status).toBe("delivered");
  });
});

// ---------------------------------------------------------------------------
// sendMessage
// ---------------------------------------------------------------------------

describe("MetaMessengerAdapter.sendMessage", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("sends a text message successfully", async () => {
    const adapter = makeAdapter();
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ message_id: "m_sent_999", recipient_id: "USER_PSID" }),
        { status: 200 },
      ),
    );
    const result = await adapter.sendMessage(
      "USER_PSID",
      { messageType: "text", content: "Hello!" },
      "page-access-token",
    );
    expect(result.success).toBe(true);
    expect(result.externalMessageId).toBe("m_sent_999");
  });

  it("throws ProviderRateLimitError on rate limit response", async () => {
    const adapter = makeAdapter();
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { code: 4, message: "Application request limit reached" } }),
        { status: 429 },
      ),
    );
    await expect(
      adapter.sendMessage("USER_PSID", { messageType: "text", content: "Hi" }, "token"),
    ).rejects.toThrow(ProviderRateLimitError);
  });

  it("throws ProviderAuthError on auth error response", async () => {
    const adapter = makeAdapter();
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { code: 190, message: "Invalid OAuth access token" } }),
        { status: 401 },
      ),
    );
    await expect(
      adapter.sendMessage("USER_PSID", { messageType: "text", content: "Hi" }, "bad-token"),
    ).rejects.toThrow(ProviderAuthError);
  });

  it("returns validation error for empty text content", async () => {
    const adapter = makeAdapter();
    const result = await adapter.sendMessage(
      "USER_PSID",
      { messageType: "text", content: "" },
      "token",
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("VALIDATION_FAILED");
  });

  it("returns unsupported error for template messages", async () => {
    const adapter = makeAdapter();
    const result = await adapter.sendTemplateMessage(
      "USER_PSID",
      "my_template",
      {},
      "token",
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("PROVIDER_UNSUPPORTED_MESSAGE_TYPE");
  });
});

// ---------------------------------------------------------------------------
// getCapabilities
// ---------------------------------------------------------------------------

describe("MetaMessengerAdapter.getCapabilities", () => {
  it("reports correct Messenger capabilities", () => {
    const adapter = makeAdapter();
    const caps = adapter.getCapabilities();
    expect(caps.provider).toBe("messenger");
    expect(caps.supportsTemplate).toBe(false);
    expect(caps.maxTextLength).toBe(2000);
    expect(caps.has24HourWindow).toBe(true);
    expect(caps.supportsTypingIndicator).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// mapProviderError
// ---------------------------------------------------------------------------

describe("MetaMessengerAdapter.mapProviderError", () => {
  const adapter = makeAdapter();

  it("maps rate limit code 4 to PROVIDER_RATE_LIMIT", () => {
    const err = adapter.mapProviderError({ error: { code: 4, message: "Rate limited" } });
    expect(err.code).toBe("PROVIDER_RATE_LIMIT");
    expect(err.retryable).toBe(true);
  });

  it("maps auth error code 190 to PROVIDER_AUTH_ERROR", () => {
    const err = adapter.mapProviderError({ error: { code: 190, message: "Invalid token" } });
    expect(err.code).toBe("PROVIDER_AUTH_ERROR");
    expect(err.retryable).toBe(false);
  });
});
