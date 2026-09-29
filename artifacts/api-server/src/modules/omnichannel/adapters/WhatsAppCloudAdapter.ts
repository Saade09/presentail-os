/**
 * WhatsAppCloudAdapter — production adapter for the WhatsApp Business Cloud API.
 *
 * Provider: Meta / WhatsApp Cloud API
 * Graph API base: https://graph.facebook.com/v19.0
 *
 * Webhook verification:
 *   GET  — hub.mode / hub.verify_token / hub.challenge challenge flow
 *   POST — x-hub-signature-256: sha256=<hex> HMAC over raw request body
 *
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
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
  provider: "whatsapp",
  supportsText: true,
  supportsImage: true,
  supportsVideo: true,
  supportsAudio: true,
  supportsDocument: true,
  supportsSticker: true,
  supportsTemplate: true,
  supportsInteractive: true,
  supportsReaction: true,
  supportsLocation: true,
  supportsReadReceipts: true,
  supportsDeliveryReceipts: true,
  supportsTypingIndicator: false,
  maxTextLength: 4096,
  maxMediaSizeBytes: 16 * 1024 * 1024,
  requiresBusinessAccount: true,
  has24HourWindow: true,
};

/** WhatsApp Cloud API error codes that indicate a rate limit. */
const RATE_LIMIT_CODES = new Set([130429, 131056]);

/** WhatsApp Cloud API error codes that are authentication failures. */
const AUTH_ERROR_CODES = new Set([190, 102, 10, 200, 210, 220, 230, 240, 290, 300, 368]);

interface WaError {
  message: string;
  type?: string;
  code: number;
  error_subcode?: number;
  fbtrace_id?: string;
}

interface WaApiError {
  error: WaError;
}

function mapWaMessageType(waType: string): OmniMessageType {
  switch (waType) {
    case "text": return "text";
    case "image": return "image";
    case "video": return "video";
    case "audio": return "audio";
    case "document": return "document";
    case "sticker": return "sticker";
    case "template": return "template";
    case "interactive": return "interactive";
    case "reaction": return "reaction";
    case "location": return "location";
    default: return "unsupported";
  }
}

function mapWaStatus(status: string): OmniMessageStatus {
  switch (status) {
    case "sent": return "sent";
    case "delivered": return "delivered";
    case "read": return "read";
    case "failed": return "failed";
    default: return "sent";
  }
}

export class WhatsAppCloudAdapter implements IChannelAdapter {
  /**
   * @param appSecret — The Meta App Secret used to verify webhook signatures.
   *   Stored as WHATSAPP_APP_SECRET env var; injected by the adapter registry.
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
        `WhatsApp webhook challenge failed: hub.mode=${mode}, token mismatch`,
      );
    }

    // POST — verify HMAC-SHA256 signature
    const sigHeader = (req.headers["x-hub-signature-256"] as string | undefined) ?? "";
    if (!sigHeader.startsWith("sha256=")) {
      throw new WebhookVerificationError(
        "WhatsApp webhook POST missing x-hub-signature-256 header",
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
        throw new WebhookVerificationError("WhatsApp webhook signature mismatch");
      }
    } catch (err) {
      if (err instanceof WebhookVerificationError) throw err;
      throw new WebhookVerificationError("WhatsApp webhook signature comparison failed");
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

    // Traverse the WhatsApp webhook envelope
    // Structure: { object: "whatsapp_business_account", entry: [{ changes: [{ value: { ... } }] }] }
    const entry = Array.isArray(payload["entry"]) ? payload["entry"] : [];
    for (const e of entry) {
      const changes = Array.isArray(e?.changes) ? e.changes : [];
      for (const change of changes) {
        const value = change?.value as Record<string, unknown> | undefined;
        if (!value) continue;

        // Parse contacts
        const rawContacts = Array.isArray(value["contacts"]) ? value["contacts"] : [];
        for (const c of rawContacts) {
          contacts.push({
            externalUserId: String(c?.wa_id ?? ""),
            displayName: String(c?.profile?.name ?? ""),
            avatarUrl: null,
            phone: String(c?.wa_id ?? ""),
            email: null,
            provider: "whatsapp",
          });
        }

        // Parse messages
        const rawMessages = Array.isArray(value["messages"]) ? value["messages"] : [];
        for (const msg of rawMessages) {
          messages.push(this.normalizeInboundMessage(msg));
        }

        // Parse status updates
        const rawStatuses = Array.isArray(value["statuses"]) ? value["statuses"] : [];
        for (const s of rawStatuses) {
          statuses.push({
            externalMessageId: String(s?.id ?? ""),
            status: mapWaStatus(String(s?.status ?? "")),
            timestamp: new Date((s?.timestamp ?? 0) * 1000),
            errorCode: s?.errors?.[0]?.code ? String(s.errors[0].code) : undefined,
            errorMessage: s?.errors?.[0]?.title ?? undefined,
          });
        }
      }
    }

    return {
      provider: "whatsapp",
      rawEventId: String(payload["id"] ?? entry[0]?.id ?? ""),
      eventType: "whatsapp.webhook",
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
    const msgType = mapWaMessageType(String(msg["type"] ?? "text"));
    const from = String(msg["from"] ?? "");
    const timestamp = new Date((Number(msg["timestamp"] ?? 0)) * 1000);
    const id = String(msg["id"] ?? "");

    let content: string | null = null;
    let mediaUrl: string | null = null;
    let mediaMimeType: string | null = null;
    let templateName: string | null = null;
    let interactivePayload: Record<string, unknown> | null = null;

    switch (msgType) {
      case "text":
        content = String((msg["text"] as Record<string, unknown>)?.["body"] ?? "");
        break;
      case "image":
      case "video":
      case "audio":
      case "document":
      case "sticker": {
        const media = msg[msgType] as Record<string, unknown> | undefined;
        mediaUrl = String(media?.["id"] ?? ""); // media ID to be resolved via getMedia()
        mediaMimeType = String(media?.["mime_type"] ?? "");
        content = String(media?.["caption"] ?? "") || null;
        break;
      }
      case "template":
        templateName = String((msg["template"] as Record<string, unknown>)?.["name"] ?? "");
        break;
      case "interactive":
        interactivePayload = msg["interactive"] as Record<string, unknown> | null ?? null;
        break;
      case "location": {
        const loc = msg["location"] as Record<string, unknown> | undefined;
        content = JSON.stringify({ lat: loc?.["latitude"], lng: loc?.["longitude"], name: loc?.["name"] });
        break;
      }
      case "reaction": {
        const reaction = msg["reaction"] as Record<string, unknown> | undefined;
        content = String(reaction?.["emoji"] ?? "");
        break;
      }
    }

    return {
      externalMessageId: id,
      provider: "whatsapp",
      direction: "inbound",
      messageType: msgType,
      content,
      mediaUrl,
      mediaMimeType,
      templateName,
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

    // We need the phone number ID (WABA phone number ID) which is used as the
    // path parameter. In practice the registry passes it as part of the token
    // context; here we extract it from a conventional "phoneNumberId|token"
    // format injected by the registry, or fall back to a simpler call.
    const { phoneNumberId, token } = parseWhatsAppToken(accessToken);

    return this.callMessagesApi(phoneNumberId, body, token);
  }

  async sendTemplateMessage(
    recipientExternalId: string,
    templateName: string,
    params: Record<string, unknown>,
    accessToken: string,
  ): Promise<SendMessageResult> {
    const { phoneNumberId, token } = parseWhatsAppToken(accessToken);
    const body = {
      messaging_product: "whatsapp",
      to: recipientExternalId,
      type: "template",
      template: {
        name: templateName,
        language: { code: String(params["language_code"] ?? "en_US") },
        components: params["components"] ?? [],
      },
    };
    return this.callMessagesApi(phoneNumberId, body, token);
  }

  async sendInteractiveMessage(
    recipientExternalId: string,
    interactivePayload: Record<string, unknown>,
    accessToken: string,
  ): Promise<SendMessageResult> {
    const { phoneNumberId, token } = parseWhatsAppToken(accessToken);
    const body = {
      messaging_product: "whatsapp",
      to: recipientExternalId,
      type: "interactive",
      interactive: interactivePayload,
    };
    return this.callMessagesApi(phoneNumberId, body, token);
  }

  async markRead(externalMessageId: string, accessToken: string): Promise<boolean> {
    const { phoneNumberId, token } = parseWhatsAppToken(accessToken);
    const body = {
      messaging_product: "whatsapp",
      status: "read",
      message_id: externalMessageId,
    };
    const result = await this.callMessagesApi(phoneNumberId, body, token);
    return result.success;
  }

  async getMedia(mediaIdOrUrl: string, accessToken: string): Promise<MediaResult> {
    const { token } = parseWhatsAppToken(accessToken);
    // Resolve media ID to download URL
    const response = await fetch(`${GRAPH_API_BASE}/${mediaIdOrUrl}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as WaApiError;
      return {
        success: false,
        error: this.mapProviderError(body),
      };
    }

    const data = await response.json() as { url?: string; mime_type?: string; file_size?: number };
    return {
      success: true,
      mediaUrl: data.url,
      mimeType: data.mime_type,
      size: data.file_size,
    };
  }

  validateOutboundMessage(message: NormalizedMessageInput): ValidationResult {
    const errors: string[] = [];
    const caps = CAPABILITIES;

    if (message.messageType === "text") {
      if (!message.content?.trim()) errors.push("Text content must not be empty");
      else if (message.content.length > caps.maxTextLength) {
        errors.push(`Text exceeds max length of ${caps.maxTextLength}`);
      }
    }
    if (message.messageType === "template" && !caps.supportsTemplate) {
      errors.push("WhatsApp does not support template messages");
    }
    if (message.messageType === "image" && !message.mediaUrl) {
      errors.push("Image message requires mediaUrl");
    }

    return { valid: errors.length === 0, errors };
  }

  mapProviderError(rawError: unknown): NormalizedProviderError {
    const err = rawError as { error?: WaError } | WaError | Error;

    if (err instanceof Error) {
      return { code: "PROVIDER_ERROR", message: err.message, retryable: false };
    }

    const waErr: WaError | undefined =
      (err as { error?: WaError }).error ?? (err as WaError);

    if (!waErr?.code) {
      return { code: "PROVIDER_ERROR", message: JSON.stringify(rawError), retryable: false };
    }

    const code = waErr.code;
    if (RATE_LIMIT_CODES.has(code)) {
      return {
        code: "PROVIDER_RATE_LIMIT",
        message: waErr.message,
        retryable: true,
        providerCode: String(code),
        providerMessage: waErr.message,
      };
    }
    if (AUTH_ERROR_CODES.has(code)) {
      return {
        code: "PROVIDER_AUTH_ERROR",
        message: waErr.message,
        retryable: false,
        providerCode: String(code),
        providerMessage: waErr.message,
      };
    }

    return {
      code: "PROVIDER_ERROR",
      message: waErr.message,
      retryable: false,
      providerCode: String(code),
      providerMessage: waErr.message,
    };
  }

  /**
   * WhatsApp Cloud API uses long-lived system user tokens that do not expire
   * in the traditional OAuth sense.  The registry keeps them encrypted in DB.
   * No automatic refresh is performed here; return the existing token.
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
    to: string,
    message: NormalizedMessageInput,
  ): Record<string, unknown> {
    const base: Record<string, unknown> = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: message.messageType,
    };

    switch (message.messageType) {
      case "text":
        base["text"] = { body: message.content ?? "", preview_url: false };
        break;
      case "image":
        base["image"] = { link: message.mediaUrl, caption: message.content ?? undefined };
        break;
      case "video":
        base["video"] = { link: message.mediaUrl, caption: message.content ?? undefined };
        break;
      case "audio":
        base["audio"] = { link: message.mediaUrl };
        break;
      case "document":
        base["document"] = { link: message.mediaUrl, filename: message.content ?? undefined };
        break;
    }

    if (message.replyToExternalMessageId) {
      base["context"] = { message_id: message.replyToExternalMessageId };
    }

    return base;
  }

  private async callMessagesApi(
    phoneNumberId: string,
    body: Record<string, unknown>,
    token: string,
  ): Promise<SendMessageResult> {
    const url = `${GRAPH_API_BASE}/${phoneNumberId}/messages`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
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

    const data = await response.json() as {
      messages?: Array<{ id: string }>;
      contacts?: Array<{ wa_id: string }>;
    };

    return {
      success: true,
      externalMessageId: data.messages?.[0]?.id,
      status: "sent",
    };
  }
}

/**
 * Parse the WhatsApp access token string, which the registry encodes as
 * `<phoneNumberId>|<bearerToken>` to carry both pieces of context through
 * the single `accessToken` parameter in the IChannelAdapter interface.
 *
 * Falls back to treating the entire string as the bearer token and using
 * a well-known env-var fallback for the phone number ID.
 */
function parseWhatsAppToken(accessToken: string): { phoneNumberId: string; token: string } {
  const sepIdx = accessToken.indexOf("|");
  if (sepIdx > 0) {
    return {
      phoneNumberId: accessToken.slice(0, sepIdx),
      token: accessToken.slice(sepIdx + 1),
    };
  }
  return {
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ?? "",
    token: accessToken,
  };
}

