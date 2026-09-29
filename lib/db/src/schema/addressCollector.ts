import {
  pgTable,
  text,
  timestamp,
  jsonb,
  uuid,
  integer,
  boolean,
  doublePrecision,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Address Collector — automated delivery-address collection from gift
 * recipients (WhatsApp via respond.io, SMS fallback via Twilio).
 * DDL source of truth: artifacts/api-server/src/lib/initDb.ts.
 */

export const addressCollectionRequests = pgTable(
  "address_collection_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    orderId: uuid("order_id"),
    recipientName: text("recipient_name").notNull(),
    // E.164; full number is only exposed in authorized detail views.
    recipientPhone: text("recipient_phone").notNull(),
    preferredLanguage: text("preferred_language").notNull().default("en"),
    status: text("status").notNull().default("awaiting_address"),
    riskLevel: text("risk_level").notNull().default("normal"),
    // Only the SHA-256 hash of the secure link token is stored.
    tokenHash: text("token_hash").notNull(),
    // Previous token stays valid until expiry so a reminder's fresh link
    // doesn't strand a recipient still holding the first message.
    previousTokenHash: text("previous_token_hash"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }).notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }),
    windowEnd: timestamp("window_end", { withTimezone: true }),
    addressDeadline: timestamp("address_deadline", { withTimezone: true }),
    deliveryTimezone: text("delivery_timezone").notNull().default("Asia/Beirut"),
    deliveryCountryCode: text("delivery_country_code"),
    // Records that outreach consent came from the PURCHASER's toggle — never
    // treated as recipient marketing opt-in.
    complianceState: text("compliance_state").notNull().default("purchaser_toggle"),
    smsOptOut: boolean("sms_opt_out").notNull().default(false),
    /** Legacy ManyChat column — integration replaced by respond.io; kept dormant to avoid a destructive migration. */
    manychatSubscriberId: text("manychat_subscriber_id"),
    respondioContactId: text("respondio_contact_id"),
    respondioChannelId: text("respondio_channel_id"),
    source: text("source").notNull().default("order"),
    submittedAddress: jsonb("submitted_address"),
    submittedLat: doublePrecision("submitted_lat"),
    submittedLng: doublePrecision("submitted_lng"),
    linkFirstOpenedAt: timestamp("link_first_opened_at", { withTimezone: true }),
    lastContactAt: timestamp("last_contact_at", { withTimezone: true }),
    lastContactChannel: text("last_contact_channel"),
    addressReceivedAt: timestamp("address_received_at", { withTimezone: true }),
    escalatedAt: timestamp("escalated_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    // Durable lifecycle closure metadata. `resolutionOutcome` describes what
    // happened without implying that an address was collected.
    resolutionOutcome: text("resolution_outcome"),
    closureReason: text("closure_reason"),
    closureSource: text("closure_source"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    processingStartedAt: timestamp("processing_started_at", { withTimezone: true }),
    inboundReplyType: text("inbound_reply_type"),
    inboundReplyText: text("inbound_reply_text"),
    inboundLat: doublePrecision("inbound_lat"),
    inboundLng: doublePrecision("inbound_lng"),
    inboundClassifier: jsonb("inbound_classifier"),
    inboundConfidence: doublePrecision("inbound_confidence"),
    inboundOutcome: text("inbound_outcome"),
    inboundError: text("inbound_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One ACTIVE request per order (cancelled/expired don't block re-creation).
    uniqueIndex("acr_one_active_per_order_v2")
      .on(t.orderId)
      .where(sql`order_id IS NOT NULL AND closed_at IS NULL AND status NOT IN ('resolved', 'address_received', 'verified', 'cancelled', 'expired')`),
    uniqueIndex("acr_token_hash_unique").on(t.tokenHash),
    index("idx_acr_workspace_status").on(t.workspaceOwnerId, t.status),
    index("idx_acr_order").on(t.orderId),
    index("idx_acr_respondio_contact").on(t.workspaceOwnerId, t.respondioContactId),
    uniqueIndex("acr_one_active_standalone_respondio_contact_v2")
      .on(t.workspaceOwnerId, t.respondioContactId)
      .where(sql`source = 'respondio' AND respondio_contact_id IS NOT NULL AND closed_at IS NULL AND status NOT IN ('resolved', 'address_received', 'verified', 'cancelled', 'expired')`),
  ],
);

export const addressCollectionActions = pgTable(
  "address_collection_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => addressCollectionRequests.id, { onDelete: "cascade" }),
    actionType: text("action_type").notNull(),
    channel: text("channel").notNull(),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
    // pending | processing | sent | failed | cancelled | blocked | skipped
    status: text("status").notNull().default("pending"),
    idempotencyKey: text("idempotency_key").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    triggeringRule: text("triggering_rule"),
    providerRef: text("provider_ref"),
    // Provider delivery status recorded separately from our own action state:
    // accepted | queued | sent | delivered | failed | undelivered
    providerStatus: text("provider_status"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("aca_idempotency_key_unique").on(t.idempotencyKey),
    index("idx_aca_due").on(t.status, t.scheduledAt),
    index("idx_aca_request").on(t.requestId),
    uniqueIndex("aca_provider_ref_unique").on(t.providerRef).where(sql`provider_ref IS NOT NULL`),
  ],
);

export const addressCollectionEvents = pgTable(
  "address_collection_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => addressCollectionRequests.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    previousState: text("previous_state"),
    newState: text("new_state"),
    actor: text("actor").notNull().default("system"),
    channel: text("channel"),
    providerRef: text("provider_ref"),
    // Never contains plaintext tokens, message bodies with secrets, or PII
    // beyond what the dashboard timeline needs.
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_ace_request_created").on(t.requestId, t.createdAt)],
);

/**
 * Raw Respond.io replies are kept separately from the request timeline so the
 * webhook can be acknowledged before a request is identified or processed.
 * providerMessageId is the replay/concurrency boundary.
 */
export const addressCollectionInboundMessages = pgTable(
  "address_collection_inbound_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerMessageId: text("provider_message_id").notNull(),
    channelId: text("channel_id"),
    contactId: text("contact_id"),
    replyToProviderRef: text("reply_to_provider_ref"),
    workspaceOwnerId: text("workspace_owner_id"),
    requestId: uuid("request_id").references(() => addressCollectionRequests.id, { onDelete: "set null" }),
    normalizedPhone: text("normalized_phone"),
    replyType: text("reply_type").notNull(),
    replyText: text("reply_text"),
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),
    classifierResult: jsonb("classifier_result"),
    confidence: doublePrecision("confidence"),
    outcome: text("outcome"),
    errorMessage: text("error_message"),
    /** Lease fields make webhook acknowledgement safe across worker instances. */
    attemptCount: integer("attempt_count").notNull().default(0),
    processingStartedAt: timestamp("processing_started_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    claimToken: uuid("claim_token"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("acim_provider_message_unique").on(t.providerMessageId),
    index("idx_acim_phone_received").on(t.normalizedPhone, t.receivedAt),
    index("idx_acim_request_received").on(t.requestId, t.receivedAt),
  ],
);

export type AddressCollectionRequest = typeof addressCollectionRequests.$inferSelect;
export type AddressCollectionAction = typeof addressCollectionActions.$inferSelect;
export type AddressCollectionEvent = typeof addressCollectionEvents.$inferSelect;
export type AddressCollectionInboundMessage = typeof addressCollectionInboundMessages.$inferSelect;
