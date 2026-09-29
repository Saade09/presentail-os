import { randomUUID } from "crypto";
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
  OmniProvider,
  SendMessageResult,
  ValidationResult,
} from "../types";
import { WebhookVerificationError } from "../errors";

const CAPABILITIES: Record<OmniProvider, ChannelCapabilities> = {
  whatsapp: {
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
  },
  instagram: {
    provider: "instagram",
    supportsText: true,
    supportsImage: true,
    supportsVideo: true,
    supportsAudio: false,
    supportsDocument: false,
    supportsSticker: false,
    supportsTemplate: false,
    supportsInteractive: true,
    supportsReaction: true,
    supportsLocation: false,
    supportsReadReceipts: true,
    supportsDeliveryReceipts: true,
    supportsTypingIndicator: true,
    maxTextLength: 1000,
    requiresBusinessAccount: true,
    has24HourWindow: true,
  },
  messenger: {
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
    requiresBusinessAccount: false,
    has24HourWindow: true,
  },
  tiktok: {
    provider: "tiktok",
    supportsText: true,
    supportsImage: false,
    supportsVideo: false,
    supportsAudio: false,
    supportsDocument: false,
    supportsSticker: false,
    supportsTemplate: false,
    supportsInteractive: false,
    supportsReaction: false,
    supportsLocation: false,
    supportsReadReceipts: false,
    supportsDeliveryReceipts: false,
    supportsTypingIndicator: false,
    maxTextLength: 500,
    requiresBusinessAccount: true,
    has24HourWindow: false,
  },
};

/**
 * MockChannelAdapter — implements IChannelAdapter without making real HTTP
 * calls.  Useful for tests, seed scripts, and local development.
 *
 * Construct with any supported provider:
 *   const adapter = new MockChannelAdapter("whatsapp");
 *
 * Use `simulateInbound()` to generate a realistic-looking inbound message
 * that can be fed into integration tests or seed data.
 */
export class MockChannelAdapter implements IChannelAdapter {
  constructor(private readonly provider: OmniProvider = "whatsapp") {}

  async verifyWebhook(req: Request, verifyToken: string): Promise<string | undefined> {
    const query = req.query as Record<string, string>;
    if (req.method === "GET") {
      const mode = query["hub.mode"];
      const token = query["hub.verify_token"];
      const challenge = query["hub.challenge"];
      if (mode === "subscribe" && token === verifyToken) {
        return challenge ?? "mock-challenge";
      }
      throw new WebhookVerificationError(
        `Mock webhook verification failed: token mismatch (got ${token}, expected ${verifyToken})`,
      );
    }
    return undefined;
  }

  async parseWebhookEvent(
    rawPayload: unknown,
    channelAccountExternalId: string,
  ): Promise<NormalizedWebhookEvent> {
    return {
      provider: this.provider,
      rawEventId: randomUUID(),
      eventType: "mock.message",
      channelAccountExternalId,
      messages: [],
      contacts: [],
      statuses: [],
      rawPayload,
      receivedAt: new Date(),
    };
  }

  normalizeInboundMessage(rawMessage: unknown): NormalizedMessage {
    const raw = rawMessage as Record<string, unknown>;
    return {
      externalMessageId: (raw["id"] as string | undefined) ?? randomUUID(),
      provider: this.provider,
      direction: "inbound",
      messageType: "text",
      content: (raw["text"] as string | undefined) ?? "(mock message)",
      senderExternalUserId: (raw["from"] as string | undefined) ?? "mock-user-id",
      senderName: (raw["senderName"] as string | undefined) ?? "Mock User",
      timestamp: new Date(),
      status: "delivered",
    };
  }

  async sendMessage(
    recipientExternalId: string,
    message: NormalizedMessageInput,
    _accessToken: string,
  ): Promise<SendMessageResult> {
    const validation = this.validateOutboundMessage(message);
    if (!validation.valid) {
      return {
        success: false,
        status: "failed",
        error: {
          code: "VALIDATION_FAILED",
          message: validation.errors.join("; "),
          retryable: false,
        },
      };
    }
    return {
      success: true,
      externalMessageId: `mock_${this.provider}_${Date.now()}_${recipientExternalId}`,
      status: "sent",
      metadata: { mock: true, provider: this.provider },
    };
  }

  async sendTemplateMessage(
    recipientExternalId: string,
    templateName: string,
    params: Record<string, unknown>,
    _accessToken: string,
  ): Promise<SendMessageResult> {
    if (!this.getCapabilities().supportsTemplate) {
      return {
        success: false,
        status: "failed",
        error: {
          code: "PROVIDER_UNSUPPORTED_MESSAGE_TYPE",
          message: `${this.provider} does not support template messages`,
          retryable: false,
        },
      };
    }
    return {
      success: true,
      externalMessageId: `mock_tmpl_${Date.now()}_${recipientExternalId}`,
      status: "sent",
      metadata: { mock: true, templateName, params },
    };
  }

  async sendInteractiveMessage(
    recipientExternalId: string,
    interactivePayload: Record<string, unknown>,
    _accessToken: string,
  ): Promise<SendMessageResult> {
    if (!this.getCapabilities().supportsInteractive) {
      return {
        success: false,
        status: "failed",
        error: {
          code: "PROVIDER_UNSUPPORTED_MESSAGE_TYPE",
          message: `${this.provider} does not support interactive messages`,
          retryable: false,
        },
      };
    }
    return {
      success: true,
      externalMessageId: `mock_interactive_${Date.now()}_${recipientExternalId}`,
      status: "sent",
      metadata: { mock: true, interactivePayload },
    };
  }

  async markRead(_externalMessageId: string, _accessToken: string): Promise<boolean> {
    return true;
  }

  async getMedia(_mediaIdOrUrl: string, _accessToken: string): Promise<MediaResult> {
    return {
      success: true,
      mediaUrl: `https://mock-cdn.example.com/media/${randomUUID()}`,
      mimeType: "image/jpeg",
      size: 102400,
    };
  }

  validateOutboundMessage(message: NormalizedMessageInput): ValidationResult {
    const errors: string[] = [];
    const caps = this.getCapabilities();

    if (message.messageType === "text") {
      if (!message.content || message.content.trim().length === 0) {
        errors.push("Text message content must not be empty");
      } else if (message.content.length > caps.maxTextLength) {
        errors.push(
          `Text content exceeds maximum length of ${caps.maxTextLength} characters`,
        );
      }
    }

    if (message.messageType === "template" && !caps.supportsTemplate) {
      errors.push(`${this.provider} does not support template messages`);
    }
    if (message.messageType === "interactive" && !caps.supportsInteractive) {
      errors.push(`${this.provider} does not support interactive messages`);
    }
    if (message.messageType === "image" && !caps.supportsImage) {
      errors.push(`${this.provider} does not support image messages`);
    }
    if (message.messageType === "video" && !caps.supportsVideo) {
      errors.push(`${this.provider} does not support video messages`);
    }
    if (message.messageType === "audio" && !caps.supportsAudio) {
      errors.push(`${this.provider} does not support audio messages`);
    }
    if (message.messageType === "document" && !caps.supportsDocument) {
      errors.push(`${this.provider} does not support document messages`);
    }

    return { valid: errors.length === 0, errors };
  }

  mapProviderError(rawError: unknown): NormalizedProviderError {
    if (rawError instanceof Error) {
      return {
        code: "PROVIDER_ERROR",
        message: rawError.message,
        retryable: false,
        providerMessage: rawError.message,
      };
    }
    const err = rawError as Record<string, unknown>;
    return {
      code: String(err["code"] ?? "PROVIDER_ERROR"),
      message: String(err["message"] ?? "Unknown provider error"),
      retryable: Boolean(err["retryable"] ?? false),
      providerCode: err["providerCode"] != null ? String(err["providerCode"]) : undefined,
      providerMessage:
        err["providerMessage"] != null ? String(err["providerMessage"]) : undefined,
    };
  }

  async refreshTokenIfNeeded(
    accessToken: string,
    _refreshToken: string | null,
    expiresAt: Date | null,
  ): Promise<string> {
    if (expiresAt && expiresAt < new Date()) {
      return `mock_refreshed_token_${Date.now()}`;
    }
    return accessToken;
  }

  getCapabilities(): ChannelCapabilities {
    return CAPABILITIES[this.provider];
  }

  /**
   * Simulate an inbound message event — useful for tests and seed scripts.
   *
   * @param text — Message text content.
   * @param contactExternalId — Optional sender ID; defaults to a stable mock ID.
   * @returns A NormalizedMessage ready to be persisted or processed.
   */
  simulateInbound(
    text: string,
    contactExternalId = "mock-contact-001",
  ): NormalizedMessage & { _simulated: true } {
    return {
      externalMessageId: `sim_${this.provider}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      provider: this.provider,
      direction: "inbound",
      messageType: "text",
      content: text,
      senderExternalUserId: contactExternalId,
      senderName: "Simulated Contact",
      timestamp: new Date(),
      status: "delivered" as OmniMessageStatus,
      metadata: { simulated: true },
      _simulated: true,
    };
  }
}
