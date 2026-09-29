// ---------------------------------------------------------------------------
// Omnichannel module — normalized type definitions
// ---------------------------------------------------------------------------

// --- Enums ------------------------------------------------------------------

export type OmniProvider = "whatsapp" | "instagram" | "messenger" | "tiktok";

export type OmniMessageDirection = "inbound" | "outbound";

export type OmniMessageType =
  | "text"
  | "image"
  | "video"
  | "audio"
  | "document"
  | "sticker"
  | "template"
  | "interactive"
  | "reaction"
  | "location"
  | "unsupported";

export type OmniMessageStatus = "pending" | "sent" | "delivered" | "read" | "failed";

export type OmniConversationStatus = "open" | "resolved" | "pending" | "snoozed";

export type OmniAutomationState = "active" | "paused" | "draft";

export type OmniActorType = "agent" | "system" | "automation" | "provider";

// --- Normalized core types --------------------------------------------------

export interface NormalizedContact {
  externalUserId: string;
  displayName: string | null;
  avatarUrl: string | null;
  phone: string | null;
  email: string | null;
  provider: OmniProvider;
  metadata?: Record<string, unknown>;
}

export interface NormalizedConversation {
  externalConversationId?: string;
  provider: OmniProvider;
  contact: NormalizedContact;
  subject?: string | null;
  metadata?: Record<string, unknown>;
}

export interface NormalizedMessage {
  externalMessageId: string;
  provider: OmniProvider;
  direction: OmniMessageDirection;
  messageType: OmniMessageType;
  content?: string | null;
  mediaUrl?: string | null;
  mediaMimeType?: string | null;
  mediaSize?: number | null;
  templateName?: string | null;
  templateParams?: Record<string, unknown> | null;
  interactivePayload?: Record<string, unknown> | null;
  senderExternalUserId: string;
  senderName?: string | null;
  timestamp: Date;
  status: OmniMessageStatus;
  metadata?: Record<string, unknown>;
}

export interface NormalizedWebhookEvent {
  provider: OmniProvider;
  rawEventId: string;
  eventType: string;
  channelAccountExternalId: string;
  messages: NormalizedMessage[];
  contacts: NormalizedContact[];
  statuses: Array<{
    externalMessageId: string;
    status: OmniMessageStatus;
    timestamp: Date;
    errorCode?: string;
    errorMessage?: string;
  }>;
  rawPayload: unknown;
  receivedAt: Date;
}

// --- Outbound types ---------------------------------------------------------

export interface NormalizedMessageInput {
  messageType: OmniMessageType;
  content?: string;
  mediaUrl?: string;
  mediaMimeType?: string;
  templateName?: string;
  templateParams?: Record<string, unknown>;
  interactivePayload?: Record<string, unknown>;
  replyToExternalMessageId?: string;
}

export interface SendMessageResult {
  success: boolean;
  externalMessageId?: string;
  status: OmniMessageStatus;
  error?: NormalizedProviderError;
  metadata?: Record<string, unknown>;
}

export interface MediaResult {
  success: boolean;
  mediaUrl?: string;
  mimeType?: string;
  size?: number;
  error?: NormalizedProviderError;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// --- Error types ------------------------------------------------------------

export interface NormalizedProviderError {
  code: string;
  message: string;
  retryable: boolean;
  providerCode?: string;
  providerMessage?: string;
  metadata?: Record<string, unknown>;
}

// --- Capabilities -----------------------------------------------------------

export interface ChannelCapabilities {
  provider: OmniProvider;
  supportsText: boolean;
  supportsImage: boolean;
  supportsVideo: boolean;
  supportsAudio: boolean;
  supportsDocument: boolean;
  supportsSticker: boolean;
  supportsTemplate: boolean;
  supportsInteractive: boolean;
  supportsReaction: boolean;
  supportsLocation: boolean;
  supportsReadReceipts: boolean;
  supportsDeliveryReceipts: boolean;
  supportsTypingIndicator: boolean;
  maxTextLength: number;
  maxMediaSizeBytes?: number;
  allowedMimeTypes?: string[];
  requiresBusinessAccount: boolean;
  has24HourWindow: boolean;
}
