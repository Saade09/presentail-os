/**
 * TikTokBusinessMessagingAdapter — capability-driven stub adapter for
 * TikTok Business Messaging API.
 *
 * Current status: STUB / MOCK-DELEGATING
 *
 * TikTok Business Messaging requires an approved TikTok for Business developer
 * account and a separate API access approval process.  Until credentials and
 * API access are confirmed, this adapter delegates all calls to the
 * MockChannelAdapter.
 *
 * Activation criteria (real mode):
 *   - `TIKTOK_ACCESS_TOKEN` env var must be set AND
 *   - `MOCK_CHANNELS_ENABLED` must NOT be "true"
 *
 * When real mode is enabled replace the TODO stubs below with real API calls.
 *
 * Official documentation references:
 * @see https://business-api.tiktok.com/portal/docs?id=1738855099573250  (Business API overview)
 * @see https://business-api.tiktok.com/portal/docs?id=1771101027431425  (Messaging API)
 * @see https://business-api.tiktok.com/portal/docs?id=1771101027431426  (Webhook events)
 * @see https://business-api.tiktok.com/portal/docs?id=1770669520396290  (Authentication)
 */

import type { Request } from "express";
import type { IChannelAdapter } from "./IChannelAdapter";
import { MockChannelAdapter } from "./MockChannelAdapter";
import {
  isTokenExpiringSoon,
  persistRefreshedToken,
} from "./tokenRefresh";
import type {
  ChannelCapabilities,
  MediaResult,
  NormalizedMessage,
  NormalizedMessageInput,
  NormalizedProviderError,
  NormalizedWebhookEvent,
  SendMessageResult,
  ValidationResult,
} from "../types";
import { ProviderAuthError } from "../errors";

/**
 * Capabilities are marked conservatively until TikTok Business Messaging API
 * access is confirmed and full feature parity is tested.
 */
const CAPABILITIES: ChannelCapabilities = {
  provider: "tiktok",
  supportsText: true,     // confirmed supported (mock mode)
  supportsImage: false,   // TODO: confirm when TikTok Business Messaging API access is approved
  supportsVideo: false,   // TODO: confirm when TikTok Business Messaging API access is approved
  supportsAudio: false,   // TODO: confirm when TikTok Business Messaging API access is approved
  supportsDocument: false, // TODO: confirm when TikTok Business Messaging API access is approved
  supportsSticker: false, // TODO: confirm when TikTok Business Messaging API access is approved
  supportsTemplate: false, // TODO: confirm when TikTok Business Messaging API access is approved
  supportsInteractive: false, // TODO: confirm when TikTok Business Messaging API access is approved
  supportsReaction: false, // TODO: confirm when TikTok Business Messaging API access is approved
  supportsLocation: false, // TODO: confirm when TikTok Business Messaging API access is approved
  supportsReadReceipts: false, // TODO: confirm when TikTok Business Messaging API access is approved
  supportsDeliveryReceipts: false, // TODO: confirm when TikTok Business Messaging API access is approved
  supportsTypingIndicator: false, // TODO: confirm when TikTok Business Messaging API access is approved
  maxTextLength: 500,
  requiresBusinessAccount: true,
  has24HourWindow: false, // TikTok does not enforce a 24-hour session window
};

/**
 * The TikTok Business API base URL.
 * TODO: implement when TikTok Business Messaging API access is approved.
 * @see https://business-api.tiktok.com/portal/docs?id=1738855099573250
 */
const TIKTOK_API_BASE = "https://business-api.tiktok.com/open_api/v1.3";

export class TikTokBusinessMessagingAdapter implements IChannelAdapter {
  private readonly mock: MockChannelAdapter;

  /**
   * @param channelAccountId — DB row ID, used for persisting refreshed tokens.
   */
  constructor(private readonly channelAccountId: number) {
    this.mock = new MockChannelAdapter("tiktok");
  }

  /**
   * Returns true when real TikTok credentials are available and
   * MOCK_CHANNELS_ENABLED is not "true".
   */
  private get isRealMode(): boolean {
    return (
      Boolean(process.env.TIKTOK_ACCESS_TOKEN) &&
      process.env.MOCK_CHANNELS_ENABLED !== "true"
    );
  }

  // ---------------------------------------------------------------------------
  // Webhook verification
  // ---------------------------------------------------------------------------

  async verifyWebhook(req: Request, verifyToken: string): Promise<string | undefined> {
    if (!this.isRealMode) {
      return this.mock.verifyWebhook(req, verifyToken);
    }

    // TODO: implement when TikTok Business Messaging API access is approved.
    // TikTok webhook verification uses a different challenge mechanism from Meta.
    // @see https://business-api.tiktok.com/portal/docs?id=1771101027431426
    //
    // Expected implementation:
    //   GET: respond with the challenge parameter from the query string
    //   POST: verify the X-TikTok-Signature header using the app secret
    throw new Error(
      "TikTok webhook verification real mode: not yet implemented. Waiting for API access approval. " +
      "See https://business-api.tiktok.com/portal/docs?id=1771101027431426",
    );
  }

  // ---------------------------------------------------------------------------
  // Webhook event parsing
  // ---------------------------------------------------------------------------

  async parseWebhookEvent(
    rawPayload: unknown,
    channelAccountExternalId: string,
  ): Promise<NormalizedWebhookEvent> {
    if (!this.isRealMode) {
      return this.mock.parseWebhookEvent(rawPayload, channelAccountExternalId);
    }

    // TODO: implement when TikTok Business Messaging API access is approved.
    // TikTok webhook event structure differs from Meta platforms.
    // @see https://business-api.tiktok.com/portal/docs?id=1771101027431426
    //
    // Expected implementation:
    //   Parse TikTok-specific event types: message, read, delivery
    //   Map sender open_id to externalUserId
    //   Normalize message content types
    return this.mock.parseWebhookEvent(rawPayload, channelAccountExternalId);
  }

  // ---------------------------------------------------------------------------
  // Message normalization
  // ---------------------------------------------------------------------------

  normalizeInboundMessage(rawMessage: unknown): NormalizedMessage {
    if (!this.isRealMode) {
      return this.mock.normalizeInboundMessage(rawMessage);
    }

    // TODO: implement when TikTok Business Messaging API access is approved.
    // TikTok message objects use different field names (open_id, create_time, etc.).
    // @see https://business-api.tiktok.com/portal/docs?id=1771101027431425
    return this.mock.normalizeInboundMessage(rawMessage);
  }

  // ---------------------------------------------------------------------------
  // Sending messages
  // ---------------------------------------------------------------------------

  async sendMessage(
    recipientExternalId: string,
    message: NormalizedMessageInput,
    accessToken: string,
  ): Promise<SendMessageResult> {
    if (!this.isRealMode) {
      return this.mock.sendMessage(recipientExternalId, message, accessToken);
    }

    // TODO: implement when TikTok Business Messaging API access is approved.
    // TikTok Business Messaging send endpoint:
    //   POST https://business-api.tiktok.com/open_api/v1.3/business/notificationcenter/send/
    // @see https://business-api.tiktok.com/portal/docs?id=1771101027431425
    //
    // Expected request body:
    // {
    //   "business_id": "<business_id>",
    //   "open_id": "<recipient_open_id>",
    //   "message": { "type": "TEXT", "content": "..." }
    // }
    void TIKTOK_API_BASE; // suppress unused warning until implemented
    return this.mock.sendMessage(recipientExternalId, message, accessToken);
  }

  async sendTemplateMessage(
    recipientExternalId: string,
    templateName: string,
    params: Record<string, unknown>,
    accessToken: string,
  ): Promise<SendMessageResult> {
    if (!this.isRealMode) {
      return this.mock.sendTemplateMessage(recipientExternalId, templateName, params, accessToken);
    }

    // TODO: implement when TikTok Business Messaging API access is approved.
    // TikTok does not have an equivalent to Meta HSM templates.
    // Confirm capability before implementing.
    // @see https://business-api.tiktok.com/portal/docs?id=1771101027431425
    return {
      success: false,
      status: "failed",
      error: {
        code: "PROVIDER_UNSUPPORTED_MESSAGE_TYPE",
        message: "TikTok does not support template messages (pending API access approval)",
        retryable: false,
      },
    };
  }

  async sendInteractiveMessage(
    recipientExternalId: string,
    interactivePayload: Record<string, unknown>,
    accessToken: string,
  ): Promise<SendMessageResult> {
    if (!this.isRealMode) {
      return this.mock.sendInteractiveMessage(recipientExternalId, interactivePayload, accessToken);
    }

    // TODO: implement when TikTok Business Messaging API access is approved.
    // Confirm whether TikTok Business Messaging supports interactive messages.
    // @see https://business-api.tiktok.com/portal/docs?id=1771101027431425
    return {
      success: false,
      status: "failed",
      error: {
        code: "PROVIDER_UNSUPPORTED_MESSAGE_TYPE",
        message: "TikTok interactive messages: not yet implemented (pending API access approval)",
        retryable: false,
      },
    };
  }

  async markRead(_externalMessageId: string, _accessToken: string): Promise<boolean> {
    if (!this.isRealMode) {
      return this.mock.markRead(_externalMessageId, _accessToken);
    }

    // TODO: implement when TikTok Business Messaging API access is approved.
    // Confirm whether TikTok Business Messaging supports read receipts.
    // @see https://business-api.tiktok.com/portal/docs?id=1771101027431425
    return true;
  }

  async getMedia(mediaIdOrUrl: string, accessToken: string): Promise<MediaResult> {
    if (!this.isRealMode) {
      return this.mock.getMedia(mediaIdOrUrl, accessToken);
    }

    // TODO: implement when TikTok Business Messaging API access is approved.
    // @see https://business-api.tiktok.com/portal/docs?id=1771101027431425
    return { success: true, mediaUrl: mediaIdOrUrl };
  }

  validateOutboundMessage(message: NormalizedMessageInput): ValidationResult {
    if (!this.isRealMode) {
      return this.mock.validateOutboundMessage(message);
    }

    const errors: string[] = [];
    if (message.messageType === "text") {
      if (!message.content?.trim()) errors.push("Text content must not be empty");
      else if (message.content.length > CAPABILITIES.maxTextLength) {
        errors.push(`Text exceeds TikTok max length of ${CAPABILITIES.maxTextLength}`);
      }
    }

    return { valid: errors.length === 0, errors };
  }

  mapProviderError(rawError: unknown): NormalizedProviderError {
    if (!this.isRealMode) {
      return this.mock.mapProviderError(rawError);
    }

    // TODO: implement when TikTok Business Messaging API access is approved.
    // Map TikTok-specific error codes.
    // @see https://business-api.tiktok.com/portal/docs?id=1738855099573250
    if (rawError instanceof Error) {
      return { code: "PROVIDER_ERROR", message: rawError.message, retryable: false };
    }
    return {
      code: "PROVIDER_ERROR",
      message: JSON.stringify(rawError),
      retryable: false,
    };
  }

  /**
   * TikTok Business API uses OAuth 2.0 access tokens with a configurable
   * expiry window.  Refresh via the token refresh endpoint.
   *
   * TODO: implement when TikTok Business Messaging API access is approved.
   * TikTok token refresh endpoint:
   *   POST https://business-api.tiktok.com/open_api/v1.3/tt_user/oauth2/refresh_token/
   * @see https://business-api.tiktok.com/portal/docs?id=1770669520396290
   */
  async refreshTokenIfNeeded(
    accessToken: string,
    refreshToken: string | null,
    expiresAt: Date | null,
  ): Promise<string> {
    if (!this.isRealMode) {
      return this.mock.refreshTokenIfNeeded(accessToken, refreshToken, expiresAt);
    }

    if (!isTokenExpiringSoon(expiresAt)) {
      return accessToken;
    }

    if (!refreshToken) {
      throw new ProviderAuthError(
        "TikTok token is expiring but no refresh token is stored. Re-authorize the channel account.",
      );
    }

    // TODO: implement when TikTok Business Messaging API access is approved.
    // Exchange refreshToken for a new access token via TikTok OAuth endpoint.
    // @see https://business-api.tiktok.com/portal/docs?id=1770669520396290
    //
    // Expected implementation:
    //   POST https://business-api.tiktok.com/open_api/v1.3/tt_user/oauth2/refresh_token/
    //   Body: { app_id, secret, grant_type: "refresh_token", refresh_token }
    //   Response: { data: { access_token, refresh_token, expires_in } }
    //
    // Then call persistRefreshedToken(this.channelAccountId, newToken, newRefresh, newExpiry)
    void persistRefreshedToken; // suppress unused import warning until implemented
    return accessToken;
  }

  getCapabilities(): ChannelCapabilities {
    return CAPABILITIES;
  }
}
