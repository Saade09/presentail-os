import { createHmac, timingSafeEqual } from "crypto";
import type { Request } from "express";
import type { IChannelAdapter } from "./IChannelAdapter";
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
import { WebhookVerificationError } from "../errors";
import { logger } from "../../../lib/logger";

const GRAPH_API_VERSION = "v20.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

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

type RawWaMessage = {
  id: string;
  from: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  image?: { id: string; mime_type: string; sha256: string; caption?: string };
  video?: { id: string; mime_type: string; sha256: string; caption?: string };
  audio?: { id: string; mime_type: string; sha256: string };
  document?: { id: string; mime_type: string; sha256: string; filename?: string; caption?: string };
  sticker?: { id: string; mime_type: string; sha256: string; animated: boolean };
  reaction?: { message_id: string; emoji: string };
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  interactive?: { type: string; button_reply?: unknown; list_reply?: unknown };
  template?: unknown;
};

type RawWaContact = {
  profile: { name: string };
  wa_id: string;
};

type RawWaStatus = {
  id: string;
  status: string;
  timestamp: string;
  recipient_id: string;
  errors?: Array<{ code: number; title: string }>;
};

type RawWaChangeValue = {
  messaging_product: string;
  metadata: { display_phone_number: string; phone_number_id: string };
  contacts?: RawWaContact[];
  messages?: RawWaMessage[];
  statuses?: RawWaStatus[];
};

type RawWaPayload = {
  object: string;
  entry?: Array<{
    id: string;
    changes?: Array<{ value: RawWaChangeValue; field: string }>;
  }>;
};

function mapWaStatus(waStatus: string): OmniMessageStatus {
  switch (waStatus) {
    case "sent": return "sent";
    case "delivered": return "delivered";
    case "read": return "read";
    case "failed": return "failed";
    default: return "sent";
  }
}

function mapWaMessageType(waType: string): OmniMessageType {
  switch (waType) {
    case "text": return "text";
    case "image": return "image";
    case "video": return "video";
    case "audio": return "audio";
    case "document": return "document";
    case "sticker": return "sticker";
    case "reaction": return "reaction";
    case "location": return "location";
    case "interactive": return "interactive";
    case "template": return "template";
    default: return "unsupported";
  }
}

/**
 * WhatsAppAdapter — real adapter for the WhatsApp Cloud API.
 *
 * @param phoneNumberId  The WhatsApp phone number ID (from omni_channel_accounts.external_account_id).
 *                       Used as the sender endpoint: POST /v20.0/{phoneNumberId}/messages
 */
export class WhatsAppAdapter implements IChannelAdapter {
  constructor(private readonly phoneNumberId: string) {}

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
        `WhatsApp hub challenge failed: token mismatch`,
      );
    }
    return undefined;
  }

  async parseWebhookEvent(
    rawPayload: unknown,
    channelAccountExternalId: string,
  ): Promise<NormalizedWebhookEvent> {
    const payload = rawPayload as RawWaPayload;
    const messages: NormalizedMessage[] = [];
    const statuses: NormalizedWebhookEvent["statuses"] = [];
    const contactMap = new Map<string, string>();

    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== "messages") continue;
        const val = change.value;

        for (const c of val.contacts ?? []) {
          contactMap.set(c.wa_id, c.profile.name);
        }

        for (const msg of val.messages ?? []) {
          messages.push(this.normalizeInboundMessage({ ...msg, _contactName: contactMap.get(msg.from) ?? null }));
        }

        for (const st of val.statuses ?? []) {
          statuses.push({
            externalMessageId: st.id,
            status: mapWaStatus(st.status),
            timestamp: new Date(parseInt(st.timestamp, 10) * 1000),
            errorCode: st.errors?.[0]?.code != null ? String(st.errors[0].code) : undefined,
            errorMessage: st.errors?.[0]?.title,
          });
        }
      }
    }

    return {
      provider: "whatsapp",
      rawEventId: "",
      eventType: messages.length > 0 ? "messages" : statuses.length > 0 ? "statuses" : "notification",
      channelAccountExternalId,
      messages,
      contacts: [],
      statuses,
      rawPayload,
      receivedAt: new Date(),
    };
  }

  normalizeInboundMessage(rawMessage: unknown): NormalizedMessage {
    const msg = rawMessage as RawWaMessage & { _contactName?: string | null };
    const msgType = mapWaMessageType(msg.type);
    const ts = new Date(parseInt(msg.timestamp ?? "0", 10) * 1000);

    let content: string | null = null;
    let mediaUrl: string | null = null;
    let mediaMimeType: string | null = null;
    let interactivePayload: Record<string, unknown> | null = null;

    if (msg.text) {
      content = msg.text.body;
    } else if (msg.image) {
      content = msg.image.caption ?? null;
      mediaUrl = msg.image.id;
      mediaMimeType = msg.image.mime_type;
    } else if (msg.video) {
      content = msg.video.caption ?? null;
      mediaUrl = msg.video.id;
      mediaMimeType = msg.video.mime_type;
    } else if (msg.audio) {
      mediaUrl = msg.audio.id;
      mediaMimeType = msg.audio.mime_type;
    } else if (msg.document) {
      content = msg.document.caption ?? msg.document.filename ?? null;
      mediaUrl = msg.document.id;
      mediaMimeType = msg.document.mime_type;
    } else if (msg.sticker) {
      mediaUrl = msg.sticker.id;
      mediaMimeType = msg.sticker.mime_type;
    } else if (msg.reaction) {
      content = msg.reaction.emoji;
    } else if (msg.location) {
      content = [
        msg.location.name,
        msg.location.address,
        `${msg.location.latitude},${msg.location.longitude}`,
      ]
        .filter(Boolean)
        .join(" — ");
    } else if (msg.interactive) {
      interactivePayload = msg.interactive as Record<string, unknown>;
    }

    return {
      externalMessageId: msg.id,
      provider: "whatsapp",
      direction: "inbound",
      messageType: msgType,
      content,
      mediaUrl,
      mediaMimeType,
      senderExternalUserId: msg.from,
      senderName: msg._contactName ?? null,
      timestamp: ts,
      status: "delivered",
      interactivePayload,
    };
  }

  async sendMessage(
    recipientExternalId: string,
    message: NormalizedMessageInput,
    accessToken: string,
  ): Promise<SendMessageResult> {
    const validation = this.validateOutboundMessage(message);
    if (!validation.valid) {
      return { success: false, status: "failed", error: { code: "VALIDATION_FAILED", message: validation.errors.join("; "), retryable: false } };
    }

    const body = this._buildSendBody(recipientExternalId, message);
    if (!body) {
      return { success: false, status: "failed", error: { code: "UNSUPPORTED_TYPE", message: `Message type '${message.messageType}' cannot be sent directly`, retryable: false } };
    }

    const url = `${GRAPH_BASE}/${this.phoneNumberId}/messages`;
    return this._postGraphApi(url, body, accessToken);
  }

  async sendTemplateMessage(
    recipientExternalId: string,
    templateName: string,
    params: Record<string, unknown>,
    accessToken: string,
  ): Promise<SendMessageResult> {
    const body: Record<string, unknown> = {
      messaging_product: "whatsapp",
      to: recipientExternalId,
      type: "template",
      template: {
        name: templateName,
        language: { code: (params["language"] as string | undefined) ?? "en" },
        components: (params["components"] as unknown[] | undefined) ?? [],
      },
    };
    const url = `${GRAPH_BASE}/${this.phoneNumberId}/messages`;
    return this._postGraphApi(url, body, accessToken);
  }

  async sendInteractiveMessage(
    recipientExternalId: string,
    interactivePayload: Record<string, unknown>,
    accessToken: string,
  ): Promise<SendMessageResult> {
    const body: Record<string, unknown> = {
      messaging_product: "whatsapp",
      to: recipientExternalId,
      type: "interactive",
      interactive: interactivePayload,
    };
    const url = `${GRAPH_BASE}/${this.phoneNumberId}/messages`;
    return this._postGraphApi(url, body, accessToken);
  }

  async markRead(externalMessageId: string, accessToken: string): Promise<boolean> {
    const body = {
      messaging_product: "whatsapp",
      status: "read",
      message_id: externalMessageId,
    };
    const url = `${GRAPH_BASE}/${this.phoneNumberId}/messages`;
    try {
      const result = await this._postGraphApi(url, body, accessToken);
      return result.success;
    } catch {
      return false;
    }
  }

  async getMedia(mediaIdOrUrl: string, accessToken: string): Promise<MediaResult> {
    try {
      const url = `${GRAPH_BASE}/${mediaIdOrUrl}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        return { success: false, error: this.mapProviderError(errBody) };
      }
      const data = (await res.json()) as Record<string, unknown>;
      return {
        success: true,
        mediaUrl: data["url"] as string | undefined,
        mimeType: data["mime_type"] as string | undefined,
        size: typeof data["file_size"] === "number" ? data["file_size"] : undefined,
      };
    } catch (err) {
      return { success: false, error: this.mapProviderError(err) };
    }
  }

  validateOutboundMessage(message: NormalizedMessageInput): ValidationResult {
    const errors: string[] = [];
    if (message.messageType === "text") {
      if (!message.content || message.content.trim().length === 0) {
        errors.push("Text message content must not be empty");
      } else if (message.content.length > CAPABILITIES.maxTextLength) {
        errors.push(`Text content exceeds ${CAPABILITIES.maxTextLength} character limit`);
      }
    }
    if (message.messageType === "template" && !message.templateName) {
      errors.push("Template messages require a templateName");
    }
    return { valid: errors.length === 0, errors };
  }

  mapProviderError(rawError: unknown): NormalizedProviderError {
    if (rawError instanceof Error) {
      return { code: "PROVIDER_ERROR", message: rawError.message, retryable: false, providerMessage: rawError.message };
    }
    const err = rawError as Record<string, unknown>;
    const waError = (err["error"] as Record<string, unknown> | undefined) ?? err;
    const code = waError["code"] != null ? String(waError["code"]) : "PROVIDER_ERROR";
    const message = String(waError["message"] ?? "Unknown WhatsApp API error");
    const retryable = ["131026", "131047", "130429"].includes(code);
    return { code, message, retryable, providerCode: code, providerMessage: message };
  }

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

  private _buildSendBody(
    to: string,
    message: NormalizedMessageInput,
  ): Record<string, unknown> | null {
    const base = { messaging_product: "whatsapp", to };
    switch (message.messageType) {
      case "text":
        return { ...base, type: "text", text: { preview_url: false, body: message.content ?? "" } };
      case "image":
        return { ...base, type: "image", image: { link: message.mediaUrl, caption: message.content } };
      case "video":
        return { ...base, type: "video", video: { link: message.mediaUrl, caption: message.content } };
      case "audio":
        return { ...base, type: "audio", audio: { link: message.mediaUrl } };
      case "document":
        return { ...base, type: "document", document: { link: message.mediaUrl, caption: message.content } };
      case "sticker":
        return { ...base, type: "sticker", sticker: { link: message.mediaUrl } };
      default:
        return null;
    }
  }

  private async _postGraphApi(
    url: string,
    body: Record<string, unknown>,
    accessToken: string,
  ): Promise<SendMessageResult> {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;

      if (!res.ok) {
        const normalizedError = this.mapProviderError(data);
        logger.warn({ url, status: res.status, error: normalizedError }, "omnichannel: WhatsApp API error");
        return { success: false, status: "failed", error: normalizedError };
      }

      const messages = data["messages"] as Array<{ id: string }> | undefined;
      const externalMessageId = messages?.[0]?.id;

      return { success: true, externalMessageId, status: "sent", metadata: data };
    } catch (err) {
      logger.error({ err, url }, "omnichannel: WhatsApp API fetch error");
      return { success: false, status: "failed", error: this.mapProviderError(err) };
    }
  }

  /**
   * Verify a Meta HMAC signature for tests / standalone use.
   */
  static verifyHmac(rawBody: Buffer, signature: string, appSecret: string): boolean {
    if (!signature.startsWith("sha256=")) return false;
    const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
    const expectedBuf = Buffer.from(`sha256=${expected}`, "utf8");
    const actualBuf = Buffer.from(signature, "utf8");
    if (expectedBuf.length !== actualBuf.length) return false;
    return timingSafeEqual(expectedBuf, actualBuf);
  }
}
