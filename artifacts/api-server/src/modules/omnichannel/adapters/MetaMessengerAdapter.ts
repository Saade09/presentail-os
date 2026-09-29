/**
 * MetaMessengerAdapter — production adapter for Facebook Messenger Pages API.
 *
 * Provider: Meta / Facebook Messenger
 * Send API base: https://graph.facebook.com/v19.0/me/messages
 *
 * Webhook verification uses the same Meta signature scheme as WhatsApp:
 *   x-hub-signature-256: sha256=<HMAC-SHA256 of raw body using app secret>
 *
 * Messaging window: standard 24-hour messaging window.  Outside this window
 * only Message Tags or One-Time Notification (OTN) requests are allowed.
 *
 * @see https://developers.facebook.com/docs/messenger-platform/webhooks
 * @see https://developers.facebook.com/docs/messenger-platform/send-messages
 */

import { timingSafeEqual } from "crypto";
import type { Request } from "express";
import type { IChannelAdapter } from "./IChannelAdapter";
import { hmacSha256Hex } from "./tokenRefresh";
import type {
  ChannelCapabilities,
  MediaResult,
  NormalizedMessage,
  NormalizedMessageInput,
  NormalizedProviderError,
  NormalizedWebhookEvent,
  OmniMessageStatus,
  OmniMessageType,
  SendMessageResult,
  ValidationResult,
} from "../types";
import {
  ProviderAuthError,
  ProviderRateLimitError,
  WebhookVerificationError,
} from "../errors";

const GRAPH_API_BASE = "https://graph.facebook.com/v19.0";

const CAPABILITIES: ChannelCapabilities = {
  provider: "messenger",
  supportsText: true,
  supportsImage: true,
  supportsVideo: true,
  supportsAudio: true,
  supportsDocument: true,
  supportsSticker: true,
  supportsTemplate: false,
  supportsInteractive: true,
  supportsReaction: false,
  supportsLocation: true,
  supportsReadReceipts: true,
  supportsDeliveryReceipts: true,
  supportsTypingIndicator: true,
  maxTextLength: 2000,
  maxMediaSizeBytes: 25 * 1024 * 1024,
  requiresBusinessAccount: false,
  has24HourWindow: true,
};

/** Meta error codes indicating a rate limit. */
const RATE_LIMIT_CODES = new Set([4, 32, 613]);
/** Meta error codes indicating an auth failure. */
const AUTH_ERROR_CODES = new Set([100, 102, 190, 200, 210]);

interface MetaError {
  message: string;
  type?: string;
  code: number;
  error_subcode?: number;
  fbtrace_id?: string;
}

function mapMessengerAttachmentType(type: string): OmniMessageType {
  switch (type) {
    case "image": return "image";
    case "video": return "video";
    case "audio": return "audio";
    case "file": return "document";
    default: return "unsupported";
  }
}

function mapDeliveryStatus(status: string): OmniMessageStatus {
  switch (status) {
    case "delivered": return "delivered";
    case "read": return "read";
    default: return "sent";
  }
}

export class MetaMessengerAdapter implements IChannelAdapter {
  /**
   * @param appSecret — Meta App Secret for HMAC webhook signature verification.
   */
  constructor(private readonly appSecret: string) {}

  // ---------------------------------------------------------------------------
  // Webhook verification
  // ---------------------------------------------------------------------------

  async verifyWebhook(req: Request, verifyToken: string): Promise<string | undefined> {
    if (req.method === "GET") {
      const query = req.query as Record<string, string>;
      const mode = query["hub.mode"];
      const token = query["hub.verify_token"];
      const challenge = query["hub.challenge"];

      if (mode === "subscribe" && token === verifyToken) {
        return challenge ?? "";
      }
      throw new WebhookVerificationError(
        `Messenger webhook challenge failed: hub.mode=${mode}, token mismatch`,
      );
    }

    const sigHeader = (req.headers["x-hub-signature-256"] as string | undefined) ?? "";
    if (!sigHeader.startsWith("sha256=")) {
      throw new WebhookVerificationError(
        "Messenger webhook POST missing x-hub-signature-256 header",
      );
    }

    const rawBody: Buffer = (req as Request & { rawBody?: Buffer }).rawBody
      ?? Buffer.from(JSON.stringify(req.body), "utf8");

    const expectedSig = hmacSha256Hex(this.appSecret, rawBody);
    const providedSig = sigHeader.slice("sha256=".length);

    try {
      const expectedBuf = Buffer.from(expectedSig, "hex");
      const providedBuf = Buffer.from(providedSig, "hex");
      if (expectedBuf.length !== providedBuf.length || !timingSafeEqual(expectedBuf, providedBuf)) {
        throw new WebhookVerificationError("Messenger webhook signature mismatch");
      }
    } catch (err) {
      if (err instanceof WebhookVerificationError) throw err;
      throw new WebhookVerificationError("Messenger webhook signature comparison failed");
    }

    return undefined;
  }

  // ---------------------------------------------------------------------------
  // Webhook event parsing
  // ---------------------------------------------------------------------------

  async parseWebhookEvent(
    rawPayload: unknown,
    channelAccountExternalId: string,
  ): Promise<NormalizedWebhookEvent> {
    const payload = rawPayload as Record<string, unknown>;
    const messages: NormalizedWebhookEvent["messages"] = [];
    const contacts: NormalizedWebhookEvent["contacts"] = [];
    const statuses: NormalizedWebhookEvent["statuses"] = [];

    // Structure: { object: "page", entry: [{ id, time, messaging: [...] }] }
    const entry = Array.isArray(payload["entry"]) ? payload["entry"] : [];
    for (const e of entry) {
      const messaging = Array.isArray(e?.messaging) ? e.messaging : [];
      for (const event of messaging) {
        const senderId = String(event?.sender?.id ?? "");
        const recipientId = String(event?.recipient?.id ?? "");
        const timestamp = new Date(Number(event?.timestamp ?? 0));

        if (event?.message) {
          const msg = event.message as Record<string, unknown>;
          messages.push(this.normalizeInboundMessage({ ...msg, from: senderId, timestamp: event.timestamp }));
          // Track contact
          contacts.push({
            externalUserId: senderId,
            displayName: null,
            avatarUrl: null,
            phone: null,
            email: null,
            provider: "messenger",
          });
        } else if (event?.delivery) {
          const delivery = event.delivery as Record<string, unknown>;
          const mids = Array.isArray(delivery["mids"]) ? delivery["mids"] : [];
          for (const mid of mids) {
            statuses.push({
              externalMessageId: String(mid),
              status: "delivered",
              timestamp,
            });
          }
        } else if (event?.read) {
          const read = event.read as Record<string, unknown>;
          // read.watermark is a timestamp; mark most recent outbound as read
          statuses.push({
            externalMessageId: `watermark_${recipientId}_${read["watermark"]}`,
            status: "read",
            timestamp,
          });
        }
      }
    }

    return {
      provider: "messenger",
      rawEventId: String(payload["id"] ?? entry[0]?.id ?? ""),
      eventType: "messenger.webhook",
      channelAccountExternalId,
      messages,
      contacts,
      statuses,
      rawPayload,
      receivedAt: new Date(),
    };
  }

  // ---------------------------------------------------------------------------
  // Message normalization
  // ---------------------------------------------------------------------------

  normalizeInboundMessage(rawMessage: unknown): NormalizedMessage {
    const msg = rawMessage as Record<string, unknown>;
    const mid = String(msg["mid"] ?? "");
    const from = String(msg["from"] ?? "");
    const timestamp = new Date(Number(msg["timestamp"] ?? 0));

    let messageType: OmniMessageType = "text";
    let content: string | null = null;
    let mediaUrl: string | null = null;
    let mediaMimeType: string | null = null;
    let interactivePayload: Record<string, unknown> | null = null;

    if (msg["text"] !== undefined) {
      messageType = "text";
      content = String(msg["text"] ?? "");
    } else if (msg["attachments"]) {
      const attachments = Array.isArray(msg["attachments"]) ? msg["attachments"] : [];
      const first = attachments[0] as Record<string, unknown> | undefined;
      if (first) {
        messageType = mapMessengerAttachmentType(String(first["type"] ?? ""));
        mediaUrl = String((first["payload"] as Record<string, unknown>)?.["url"] ?? "");
      }
    } else if (msg["quick_reply"]) {
      messageType = "interactive";
      interactivePayload = msg["quick_reply"] as Record<string, unknown>;
    }

    return {
      externalMessageId: mid,
      provider: "messenger",
      direction: "inbound",
      messageType,
      content,
      mediaUrl,
      mediaMimeType,
      interactivePayload,
      senderExternalUserId: from,
      senderName: null,
      timestamp,
      status: "delivered",
      metadata: { raw: rawMessage },
    };
  }

  // ---------------------------------------------------------------------------
  // Sending messages
  // ---------------------------------------------------------------------------

  async sendMessage(
    recipientExternalId: string,
    message: NormalizedMessageInput,
    accessToken: string,
  ): Promise<SendMessageResult> {
    const validation = this.validateOutboundMessage(message);
    if (!validation.valid) {
      return {
        success: false,
        status: "failed",
        error: { code: "VALIDATION_FAILED", message: validation.errors.join("; "), retryable: false },
      };
    }

    const body = this.buildSendPayload(recipientExternalId, message);
    return this.callSendApi(body, accessToken);
  }

  async sendTemplateMessage(
    _recipientExternalId: string,
    _templateName: string,
    _params: Record<string, unknown>,
    _accessToken: string,
  ): Promise<SendMessageResult> {
    return {
      success: false,
      status: "failed",
      error: {
        code: "PROVIDER_UNSUPPORTED_MESSAGE_TYPE",
        message: "Messenger does not support HSM template messages",
        retryable: false,
      },
    };
  }

  async sendInteractiveMessage(
    recipientExternalId: string,
    interactivePayload: Record<string, unknown>,
    accessToken: string,
  ): Promise<SendMessageResult> {
    // Messenger interactive = quick replies / generic templates
    const body = {
      recipient: { id: recipientExternalId },
      message: interactivePayload,
    };
    return this.callSendApi(body, accessToken);
  }

  async markRead(externalMessageId: string, accessToken: string): Promise<boolean> {
    const body = {
      recipient: { id: externalMessageId },
      sender_action: "mark_seen",
    };
    const result = await this.callSendApi(body, accessToken);
    return result.success;
  }

  async getMedia(mediaIdOrUrl: string, _accessToken: string): Promise<MediaResult> {
    // Messenger media URLs are signed CDN URLs returned directly in webhook payloads
    return {
      success: true,
      mediaUrl: mediaIdOrUrl,
    };
  }

  validateOutboundMessage(message: NormalizedMessageInput): ValidationResult {
    const errors: string[] = [];

    if (message.messageType === "text") {
      if (!message.content?.trim()) errors.push("Text content must not be empty");
      else if (message.content.length > CAPABILITIES.maxTextLength) {
        errors.push(`Text exceeds max length of ${CAPABILITIES.maxTextLength}`);
      }
    }
    if (message.messageType === "template") {
      errors.push("Messenger does not support HSM template messages");
    }

    return { valid: errors.length === 0, errors };
  }

  mapProviderError(rawError: unknown): NormalizedProviderError {
    if (rawError instanceof Error) {
      return { code: "PROVIDER_ERROR", message: rawError.message, retryable: false };
    }

    const err = rawError as { error?: MetaError } | MetaError;
    const metaErr: MetaError | undefined =
      (err as { error?: MetaError }).error ?? (err as MetaError);

    if (!metaErr?.code) {
      return { code: "PROVIDER_ERROR", message: JSON.stringify(rawError), retryable: false };
    }

    const code = metaErr.code;
    if (RATE_LIMIT_CODES.has(code)) {
      return {
        code: "PROVIDER_RATE_LIMIT",
        message: metaErr.message,
        retryable: true,
        providerCode: String(code),
        providerMessage: metaErr.message,
      };
    }
    if (AUTH_ERROR_CODES.has(code)) {
      return {
        code: "PROVIDER_AUTH_ERROR",
        message: metaErr.message,
        retryable: false,
        providerCode: String(code),
        providerMessage: metaErr.message,
      };
    }

    return {
      code: "PROVIDER_ERROR",
      message: metaErr.message,
      retryable: false,
      providerCode: String(code),
      providerMessage: metaErr.message,
    };
  }

  /**
   * Messenger uses Page Access Tokens which are long-lived and do not expire
   * automatically.  No token refresh logic is required here.
   */
  async refreshTokenIfNeeded(
    accessToken: string,
    _refreshToken: string | null,
    _expiresAt: Date | null,
  ): Promise<string> {
    return accessToken;
  }

  getCapabilities(): ChannelCapabilities {
    return CAPABILITIES;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private buildSendPayload(
    recipientId: string,
    message: NormalizedMessageInput,
  ): Record<string, unknown> {
    const base: Record<string, unknown> = {
      recipient: { id: recipientId },
    };

    switch (message.messageType) {
      case "text":
        base["message"] = { text: message.content ?? "" };
        break;
      case "image":
      case "video":
      case "audio":
        base["message"] = {
          attachment: {
            type: message.messageType,
            payload: { url: message.mediaUrl, is_reusable: true },
          },
        };
        break;
      case "document":
        base["message"] = {
          attachment: {
            type: "file",
            payload: { url: message.mediaUrl, is_reusable: true },
          },
        };
        break;
      default:
        base["message"] = { text: message.content ?? "" };
    }

    return base;
  }

  private async callSendApi(
    body: Record<string, unknown>,
    accessToken: string,
  ): Promise<SendMessageResult> {
    const url = `${GRAPH_API_BASE}/me/messages?access_token=${encodeURIComponent(accessToken)}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      return {
        success: false,
        status: "failed",
        error: { code: "NETWORK_ERROR", message: String(err), retryable: true },
      };
    }

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      const normalized = this.mapProviderError(errorBody);

      if (normalized.code === "PROVIDER_RATE_LIMIT") {
        throw new ProviderRateLimitError(normalized.message, undefined, normalized.providerCode);
      }
      if (normalized.code === "PROVIDER_AUTH_ERROR") {
        throw new ProviderAuthError(normalized.message, normalized.providerCode);
      }

      return { success: false, status: "failed", error: normalized };
    }

    const data = await response.json() as { message_id?: string; recipient_id?: string };
    return {
      success: true,
      externalMessageId: data.message_id,
      status: "sent",
    };
  }
}
