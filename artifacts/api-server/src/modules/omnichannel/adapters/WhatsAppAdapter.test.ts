/**
 * WhatsApp Cloud API adapter — inbound webhook parsing tests.
 *
 * Verifies that real WhatsApp Cloud API webhook payloads are correctly
 * parsed into the canonical NormalizedMessage shape used by the rest of
 * the omnichannel pipeline.  No DB or HTTP calls are made.
 */

import { describe, it, expect } from "vitest";
import { WhatsAppAdapter } from "./WhatsAppAdapter";

const PHONE_NUMBER_ID = "12345678901";

function makeAdapter(): WhatsAppAdapter {
  return new WhatsAppAdapter(PHONE_NUMBER_ID);
}

// ---------------------------------------------------------------------------
// Helper — minimal WhatsApp Cloud API webhook payload
// ---------------------------------------------------------------------------

function makeWaPayload(messages: unknown[], contacts: unknown[] = [], statuses: unknown[] = []): unknown {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA_ID_123",
        changes: [
          {
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "+1234567890",
                phone_number_id: PHONE_NUMBER_ID,
              },
              contacts,
              messages,
              statuses,
            },
            field: "messages",
          },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// parseWebhookEvent
// ---------------------------------------------------------------------------

describe("WhatsAppAdapter.parseWebhookEvent", () => {
  it("parses a text message and returns a NormalizedWebhookEvent", async () => {
    const adapter = makeAdapter();
    const payload = makeWaPayload(
      [
        {
          from: "15551234567",
          id: "wamid.HBgLMTU1NTEyMzQ1NjcVAgASGBQzQTQ2Q0VBRDQ1RThFRTA4MQAA",
          timestamp: "1716200000",
          type: "text",
          text: { body: "Hello, world!" },
        },
      ],
      [{ profile: { name: "Alice" }, wa_id: "15551234567" }],
    );

    const event = await adapter.parseWebhookEvent(payload, PHONE_NUMBER_ID);

    expect(event.provider).toBe("whatsapp");
    expect(event.eventType).toBe("messages");
    expect(event.messages).toHaveLength(1);

    const msg = event.messages[0];
    expect(msg.messageType).toBe("text");
    expect(msg.content).toBe("Hello, world!");
    expect(msg.senderExternalUserId).toBe("15551234567");
    expect(msg.senderName).toBe("Alice");
    expect(msg.direction).toBe("inbound");
    expect(msg.status).toBe("delivered");
    expect(msg.externalMessageId).toBe("wamid.HBgLMTU1NTEyMzQ1NjcVAgASGBQzQTQ2Q0VBRDQ1RThFRTA4MQAA");
    expect(msg.timestamp).toBeInstanceOf(Date);
    expect(msg.timestamp.getTime()).toBe(1716200000 * 1000);
  });

  it("parses an image message with caption", async () => {
    const adapter = makeAdapter();
    const payload = makeWaPayload([
      {
        from: "15559876543",
        id: "wamid.image001",
        timestamp: "1716201000",
        type: "image",
        image: {
          id: "media_id_abc123",
          mime_type: "image/jpeg",
          sha256: "abc123def",
          caption: "Check this out",
        },
      },
    ]);

    const event = await adapter.parseWebhookEvent(payload, PHONE_NUMBER_ID);

    expect(event.messages).toHaveLength(1);
    const msg = event.messages[0];
    expect(msg.messageType).toBe("image");
    expect(msg.content).toBe("Check this out");
    expect(msg.mediaUrl).toBe("media_id_abc123");
    expect(msg.mediaMimeType).toBe("image/jpeg");
  });

  it("parses a status update (no messages, only statuses)", async () => {
    const adapter = makeAdapter();
    const payload = makeWaPayload(
      [],
      [],
      [
        {
          id: "wamid.status001",
          status: "delivered",
          timestamp: "1716202000",
          recipient_id: "15551234567",
        },
      ],
    );

    const event = await adapter.parseWebhookEvent(payload, PHONE_NUMBER_ID);

    expect(event.eventType).toBe("statuses");
    expect(event.messages).toHaveLength(0);
    expect(event.statuses).toHaveLength(1);
    expect(event.statuses[0].externalMessageId).toBe("wamid.status001");
    expect(event.statuses[0].status).toBe("delivered");
    expect(event.statuses[0].timestamp.getTime()).toBe(1716202000 * 1000);
  });

  it("parses a failed status with error details", async () => {
    const adapter = makeAdapter();
    const payload = makeWaPayload(
      [],
      [],
      [
        {
          id: "wamid.status002",
          status: "failed",
          timestamp: "1716203000",
          recipient_id: "15551234567",
          errors: [{ code: 131026, title: "Message undeliverable" }],
        },
      ],
    );

    const event = await adapter.parseWebhookEvent(payload, PHONE_NUMBER_ID);

    expect(event.statuses[0].status).toBe("failed");
    expect(event.statuses[0].errorCode).toBe("131026");
    expect(event.statuses[0].errorMessage).toBe("Message undeliverable");
  });

  it("returns empty messages array for an empty entry array", async () => {
    const adapter = makeAdapter();
    const event = await adapter.parseWebhookEvent({ object: "whatsapp_business_account", entry: [] }, PHONE_NUMBER_ID);

    expect(event.messages).toHaveLength(0);
    expect(event.statuses).toHaveLength(0);
    expect(event.eventType).toBe("notification");
  });

  it("parses a location message", async () => {
    const adapter = makeAdapter();
    const payload = makeWaPayload([
      {
        from: "15551234567",
        id: "wamid.loc001",
        timestamp: "1716210000",
        type: "location",
        location: {
          latitude: 33.8938,
          longitude: 35.5018,
          name: "Beirut",
          address: "Lebanon",
        },
      },
    ]);

    const event = await adapter.parseWebhookEvent(payload, PHONE_NUMBER_ID);
    const msg = event.messages[0];
    expect(msg.messageType).toBe("location");
    expect(msg.content).toContain("33.8938");
    expect(msg.content).toContain("Beirut");
  });

  it("ignores changes with field != 'messages'", async () => {
    const adapter = makeAdapter();
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA_ID_123",
          changes: [
            {
              value: { messaging_product: "whatsapp", metadata: {}, messages: [{ from: "1", id: "x", timestamp: "1716200000", type: "text", text: { body: "hi" } }] },
              field: "account_review_update",
            },
          ],
        },
      ],
    };

    const event = await adapter.parseWebhookEvent(payload, PHONE_NUMBER_ID);
    expect(event.messages).toHaveLength(0);
  });

  it("handles multiple messages in the same change", async () => {
    const adapter = makeAdapter();
    const payload = makeWaPayload([
      { from: "111", id: "wamid.m1", timestamp: "1716200001", type: "text", text: { body: "msg 1" } },
      { from: "222", id: "wamid.m2", timestamp: "1716200002", type: "text", text: { body: "msg 2" } },
    ]);

    const event = await adapter.parseWebhookEvent(payload, PHONE_NUMBER_ID);
    expect(event.messages).toHaveLength(2);
    expect(event.messages[0].content).toBe("msg 1");
    expect(event.messages[1].content).toBe("msg 2");
  });
});

// ---------------------------------------------------------------------------
// normalizeInboundMessage
// ---------------------------------------------------------------------------

describe("WhatsAppAdapter.normalizeInboundMessage", () => {
  it("normalizes an audio message", () => {
    const adapter = makeAdapter();
    const raw = {
      from: "15551234567",
      id: "wamid.audio001",
      timestamp: "1716205000",
      type: "audio",
      audio: { id: "audio_media_id", mime_type: "audio/ogg; codecs=opus", sha256: "xyz" },
    };

    const msg = adapter.normalizeInboundMessage(raw);
    expect(msg.messageType).toBe("audio");
    expect(msg.mediaUrl).toBe("audio_media_id");
    expect(msg.mediaMimeType).toBe("audio/ogg; codecs=opus");
    expect(msg.content).toBeNull();
  });

  it("normalizes a document message", () => {
    const adapter = makeAdapter();
    const raw = {
      from: "15551234567",
      id: "wamid.doc001",
      timestamp: "1716205001",
      type: "document",
      document: { id: "doc_media_id", mime_type: "application/pdf", sha256: "abc", filename: "invoice.pdf" },
    };

    const msg = adapter.normalizeInboundMessage(raw);
    expect(msg.messageType).toBe("document");
    expect(msg.content).toBe("invoice.pdf");
    expect(msg.mediaUrl).toBe("doc_media_id");
  });

  it("normalizes a reaction message", () => {
    const adapter = makeAdapter();
    const raw = {
      from: "15551234567",
      id: "wamid.react001",
      timestamp: "1716205002",
      type: "reaction",
      reaction: { message_id: "wamid.original", emoji: "👍" },
    };

    const msg = adapter.normalizeInboundMessage(raw);
    expect(msg.messageType).toBe("reaction");
    expect(msg.content).toBe("👍");
  });

  it("normalizes an unsupported message type gracefully", () => {
    const adapter = makeAdapter();
    const raw = {
      from: "15551234567",
      id: "wamid.unknown001",
      timestamp: "1716205003",
      type: "order",
    };

    const msg = adapter.normalizeInboundMessage(raw);
    expect(msg.messageType).toBe("unsupported");
  });
});

// ---------------------------------------------------------------------------
// validateOutboundMessage
// ---------------------------------------------------------------------------

describe("WhatsAppAdapter.validateOutboundMessage", () => {
  it("passes for valid text", () => {
    const result = makeAdapter().validateOutboundMessage({ messageType: "text", content: "Hello" });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("fails for empty text content", () => {
    const result = makeAdapter().validateOutboundMessage({ messageType: "text", content: "" });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/empty/i);
  });

  it("fails for text exceeding 4096 characters", () => {
    const result = makeAdapter().validateOutboundMessage({ messageType: "text", content: "a".repeat(4097) });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/4096/);
  });

  it("fails for template without templateName", () => {
    const result = makeAdapter().validateOutboundMessage({ messageType: "template" });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/templateName/);
  });
});

// ---------------------------------------------------------------------------
// mapProviderError
// ---------------------------------------------------------------------------

describe("WhatsAppAdapter.mapProviderError", () => {
  it("maps a WhatsApp Cloud API error response", () => {
    const raw = {
      error: {
        message: "Message failed to send because more than 24 hours have passed since the customer last replied to this number",
        type: "OAuthException",
        code: 131026,
        fbtrace_id: "abc",
      },
    };

    const err = makeAdapter().mapProviderError(raw);
    expect(err.code).toBe("131026");
    expect(err.retryable).toBe(true);
  });

  it("maps an Error instance", () => {
    const err = makeAdapter().mapProviderError(new Error("network timeout"));
    expect(err.code).toBe("PROVIDER_ERROR");
    expect(err.message).toBe("network timeout");
    expect(err.retryable).toBe(false);
  });
});
