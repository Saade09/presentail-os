import type { Request } from "express";
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

/**
 * IChannelAdapter — contract that every messaging provider adapter must satisfy.
 *
 * Implement this interface for each channel (WhatsApp, Instagram, Messenger,
 * TikTok, …) and register the concrete class with the adapter registry.
 * The interface is intentionally provider-agnostic so the automation engine
 * and outbound queue can operate without knowing provider-specific details.
 */
export interface IChannelAdapter {
  /**
   * Verify an inbound webhook request from the provider.
   * For GET (challenge) requests: validate the hub.verify_token and return the
   * hub.challenge string.  For POST requests: validate the HMAC signature.
   *
   * @throws {WebhookVerificationError} if verification fails.
   * @returns The challenge string for GET verification, or undefined for POST.
   */
  verifyWebhook(req: Request, verifyToken: string): Promise<string | undefined>;

  /**
   * Parse the raw webhook POST body into a normalized event structure.
   * Should NOT throw — return an empty messages/contacts/statuses array on
   * unrecognized event types rather than crashing.
   */
  parseWebhookEvent(
    rawPayload: unknown,
    channelAccountExternalId: string,
  ): Promise<NormalizedWebhookEvent>;

  /**
   * Normalize a single inbound message from the provider's raw shape into the
   * canonical NormalizedMessage type.
   */
  normalizeInboundMessage(rawMessage: unknown): NormalizedMessage;

  /**
   * Send an outbound message to a recipient identified by their external user
   * ID on this channel.
   *
   * @param recipientExternalId — Provider-specific recipient ID (phone number,
   *   Instagram IGSID, etc.)
   * @param message — Normalized message payload to send.
   * @param accessToken — OAuth / API token for the channel account.
   */
  sendMessage(
    recipientExternalId: string,
    message: NormalizedMessageInput,
    accessToken: string,
  ): Promise<SendMessageResult>;

  /**
   * Send a pre-approved template message (e.g. WhatsApp HSM template).
   * Returns `{ success: false }` with an UNSUPPORTED error on channels that
   * do not support templates.
   */
  sendTemplateMessage(
    recipientExternalId: string,
    templateName: string,
    params: Record<string, unknown>,
    accessToken: string,
  ): Promise<SendMessageResult>;

  /**
   * Send an interactive message (buttons, lists, quick replies, etc.).
   * Returns `{ success: false }` with an UNSUPPORTED error on channels that
   * do not support interactive messages.
   */
  sendInteractiveMessage(
    recipientExternalId: string,
    interactivePayload: Record<string, unknown>,
    accessToken: string,
  ): Promise<SendMessageResult>;

  /**
   * Mark a message as read on the provider side (send a read receipt).
   * No-op and returns `true` on channels that do not support read receipts.
   */
  markRead(externalMessageId: string, accessToken: string): Promise<boolean>;

  /**
   * Download or resolve a media URL for an inbound media message.
   * The `mediaIdOrUrl` may be a provider-specific media ID that needs to be
   * exchanged for a real download URL, or it may already be a signed URL.
   */
  getMedia(mediaIdOrUrl: string, accessToken: string): Promise<MediaResult>;

  /**
   * Validate an outbound message payload before attempting to send it.
   * Should check message type support, content length, required fields, etc.
   */
  validateOutboundMessage(message: NormalizedMessageInput): ValidationResult;

  /**
   * Map a provider-specific error (HTTP error body, error code, etc.) into
   * the canonical NormalizedProviderError shape.
   */
  mapProviderError(rawError: unknown): NormalizedProviderError;

  /**
   * Refresh the OAuth access token if the current token is expired or about
   * to expire.  Returns the new access token, or the existing one if refresh
   * was not needed.
   *
   * @throws {ProviderAuthError} if the refresh fails.
   */
  refreshTokenIfNeeded(
    accessToken: string,
    refreshToken: string | null,
    expiresAt: Date | null,
  ): Promise<string>;

  /**
   * Return the static capability matrix for this channel/provider.
   */
  getCapabilities(): ChannelCapabilities;
}
