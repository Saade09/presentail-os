import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Request } from "express";
import { TikTokBusinessMessagingAdapter } from "../TikTokBusinessMessagingAdapter";

const CHANNEL_ACCOUNT_ID = 99;

function makeAdapter() {
  return new TikTokBusinessMessagingAdapter(CHANNEL_ACCOUNT_ID);
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
// Mock mode behaviour (MOCK_CHANNELS_ENABLED=true or no TIKTOK_ACCESS_TOKEN)
// ---------------------------------------------------------------------------

describe("TikTokBusinessMessagingAdapter — mock mode", () => {
  beforeEach(() => {
    // Ensure real mode is off
    delete process.env.TIKTOK_ACCESS_TOKEN;
    process.env.MOCK_CHANNELS_ENABLED = "false";
    vi.restoreAllMocks();
  });

  afterEach(() => {
    delete process.env.TIKTOK_ACCESS_TOKEN;
    delete process.env.MOCK_CHANNELS_ENABLED;
  });

  it("delegates verifyWebhook to mock in mock mode (no token)", async () => {
    const adapter = makeAdapter();
    const req = fakeReq({
      method: "GET",
      query: {
        "hub.mode": "subscribe",
        "hub.verify_token": "my-token",
        "hub.challenge": "challenge-tt",
      } as Record<string, string>,
    });
    const result = await adapter.verifyWebhook(req, "my-token");
    expect(result).toBe("challenge-tt");
  });

  it("delegates sendMessage to mock — returns success", async () => {
    const adapter = makeAdapter();
    const result = await adapter.sendMessage(
      "tt_user_open_id",
      { messageType: "text", content: "Hello TikTok!" },
      "mock-token",
    );
    expect(result.success).toBe(true);
    expect(result.status).toBe("sent");
  });

  it("sends text message when MOCK_CHANNELS_ENABLED=true even with token set", async () => {
    process.env.TIKTOK_ACCESS_TOKEN = "some-token";
    process.env.MOCK_CHANNELS_ENABLED = "true";
    const adapter = makeAdapter();
    const result = await adapter.sendMessage(
      "tt_user",
      { messageType: "text", content: "Test" },
      "some-token",
    );
    expect(result.success).toBe(true);
  });

  it("returns unsupported for template messages (mock mode)", async () => {
    const adapter = makeAdapter();
    const result = await adapter.sendTemplateMessage("tt_user", "tmpl", {}, "token");
    // Mock for tiktok has supportsTemplate: false, so sendTemplateMessage returns failure
    expect(result.success).toBe(false);
  });

  it("delegates parseWebhookEvent to mock — returns empty event", async () => {
    const adapter = makeAdapter();
    const event = await adapter.parseWebhookEvent(
      { event_type: "message", data: {} },
      "tt_account_id",
    );
    expect(event.provider).toBe("tiktok");
    expect(Array.isArray(event.messages)).toBe(true);
  });

  it("delegates normalizeInboundMessage to mock", () => {
    const adapter = makeAdapter();
    const msg = adapter.normalizeInboundMessage({
      id: "tt_msg_123",
      from: "tt_sender",
      text: "Hi",
    });
    expect(msg.provider).toBe("tiktok");
    expect(msg.direction).toBe("inbound");
  });

  it("validates text message length in mock mode", () => {
    const adapter = makeAdapter();
    const longText = "a".repeat(600);
    const result = adapter.validateOutboundMessage({
      messageType: "text",
      content: longText,
    });
    // Mock validates using TikTok caps (maxTextLength: 500)
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("returns token unchanged in refreshTokenIfNeeded (mock mode)", async () => {
    const adapter = makeAdapter();
    const result = await adapter.refreshTokenIfNeeded("current-token", null, null);
    expect(result).toBe("current-token");
  });

  it("returns correct capabilities", () => {
    const adapter = makeAdapter();
    const caps = adapter.getCapabilities();
    expect(caps.provider).toBe("tiktok");
    expect(caps.has24HourWindow).toBe(false);
    expect(caps.requiresBusinessAccount).toBe(true);
    expect(caps.maxTextLength).toBe(500);
    // Uncertain capabilities should be false until confirmed
    expect(caps.supportsTemplate).toBe(false);
    expect(caps.supportsInteractive).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Real mode behaviour
// ---------------------------------------------------------------------------

describe("TikTokBusinessMessagingAdapter — real mode stub", () => {
  beforeEach(() => {
    process.env.TIKTOK_ACCESS_TOKEN = "tt_live_token_abc";
    delete process.env.MOCK_CHANNELS_ENABLED;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    delete process.env.TIKTOK_ACCESS_TOKEN;
    delete process.env.MOCK_CHANNELS_ENABLED;
  });

  it("verifyWebhook throws not-implemented in real mode (stub)", async () => {
    const adapter = makeAdapter();
    const req = fakeReq({ method: "POST", headers: {} });
    await expect(adapter.verifyWebhook(req, "token")).rejects.toThrow(
      /not yet implemented/i,
    );
  });

  it("sendMessage delegates to mock in real mode (stub pending API approval)", async () => {
    const adapter = makeAdapter();
    const result = await adapter.sendMessage(
      "tt_user",
      { messageType: "text", content: "Hello in real mode stub" },
      "tt_live_token_abc",
    );
    // Stub: still delegates to mock until implementation is complete
    expect(result.success).toBe(true);
  });

  it("sendTemplateMessage returns unsupported in real mode", async () => {
    const adapter = makeAdapter();
    const result = await adapter.sendTemplateMessage("tt_user", "tmpl", {}, "token");
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("PROVIDER_UNSUPPORTED_MESSAGE_TYPE");
  });

  it("sendInteractiveMessage returns unsupported in real mode", async () => {
    const adapter = makeAdapter();
    const result = await adapter.sendInteractiveMessage("tt_user", {}, "token");
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("PROVIDER_UNSUPPORTED_MESSAGE_TYPE");
  });
});
