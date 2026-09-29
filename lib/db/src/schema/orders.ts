import {
  pgTable,
  serial,
  text,
  timestamp,
  date,
  jsonb,
  uuid,
  integer,
  numeric,
  unique,
  uniqueIndex,
  index,
  boolean,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { contacts } from "./contacts";
import { locations } from "./workspace";

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    source: text("source").notNull().default("manual"),
    externalOrderId: text("external_order_id"),
    externalOrderNumber: text("external_order_number"),
    idempotencyKey: text("idempotency_key"),
    orderNumber: text("order_number"),
    displayOrderNumber: text("display_order_number"),
    status: text("status").notNull().default("pending"),
    // Monotonic identity for physical ready-for-delivery events. The value is
    // incremented only when entering ready_for_delivery from another status.
    inventoryFulfillmentCycle: integer("inventory_fulfillment_cycle")
      .notNull()
      .default(0),
    channel: text("channel"),
    locationId: integer("location_id"),
    customerId: integer("customer_id"),
    orderedAt: timestamp("ordered_at", { withTimezone: true }),
    deliveryType: text("delivery_type"),
    deliveryDate: date("delivery_date"),
    deliveryAddressStatus: text("delivery_address_status"),
    deliveryAddress: jsonb("delivery_address"),
    deliveryInstructions: text("delivery_instructions"),
    cardMessage: text("card_message"),
    cardFrom: text("card_from"),
    cardTo: text("card_to"),
    qrLink: text("qr_link"),
    windowStart: timestamp("window_start", { withTimezone: true }),
    windowEnd: timestamp("window_end", { withTimezone: true }),
    totals: jsonb("totals"),
    rawPayload: jsonb("raw_payload"),
    tookanTaskId: text("tookan_task_id"),
    tookanJobId: text("tookan_job_id"),
    tookanStatus: text("tookan_status"),
    tookanCreatedAt: timestamp("tookan_created_at", { withTimezone: true }),
    tookanError: text("tookan_error"),
    tookanPayload: jsonb("tookan_payload"),
    // Actual delivered timestamp captured when the Tookan job reaches
    // "successful" (webhook or status poll). Set once, never overwritten.
    tookanDeliveredAt: timestamp("tookan_delivered_at", { withTimezone: true }),
    marketingAttribution: jsonb("marketing_attribution"),
    // Human-readable reason set when the order's delivery date fails validation
    // (before the order date, or in the past) at day granularity in the delivery
    // timezone. Null when the delivery date is valid or absent. Re-ingest
    // re-evaluates this flag. The order is still accepted regardless.
    deliveryDateReview: text("delivery_date_review"),
    isAnonymous: boolean("is_anonymous").notNull().default(false),
    // Sensitive-occasion flag (sympathy/funeral/condolence). Auto-detected at
    // creation from the line items' taxonomy; manually togglable from the
    // order page. Suppresses review invitations and promotional sends.
    isSensitiveOccasion: boolean("is_sensitive_occasion").notNull().default(false),
    // Optional link to a payment_link record that was used to collect payment
    // before the order was created in the dashboard wizard. Nullable — most
    // orders are created without a pre-existing payment link.
    paymentLinkId: integer("payment_link_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("idx_orders_workspace_source_ext")
      .on(t.workspaceOwnerId, t.source, t.externalOrderId)
      .where(sql`${t.externalOrderId} IS NOT NULL`),
    index("idx_orders_workspace").on(t.workspaceOwnerId, t.orderedAt),
  ],
);

export const orderContacts = pgTable(
  "order_contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("customer"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique("order_contacts_order_contact_role_unique").on(t.orderId, t.contactId, t.role),
    index("idx_order_contacts_order").on(t.orderId),
    index("idx_order_contacts_contact").on(t.contactId),
  ],
);

export const orderCardMessages = pgTable(
  "order_card_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    cardTo: text("card_to"),
    cardMessage: text("card_message").notNull(),
    cardFrom: text("card_from"),
    qrLink: text("qr_link"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_order_card_messages_order").on(t.orderId, t.createdAt, t.id),
    index("idx_order_card_messages_workspace").on(t.workspaceOwnerId),
  ],
);

export const orderLineItems = pgTable(
  "order_line_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    productId: integer("product_id"),
    // Legacy v1 clients call this field external_product_id in request JSON,
    // but all order-creation paths persist it in production's external_id column.
    externalId: text("external_id"),
    sku: text("sku"),
    name: text("name").notNull(),
    quantity: integer("quantity").notNull().default(1),
    unitPrice: numeric("unit_price", { precision: 14, scale: 4 }),
    // Production/initDb name this column `line_total`; all app code (raw SQL)
    // reads/writes `line_total`. Keep the Drizzle column name in lockstep so
    // `drizzle-kit push` (used by integration tests) matches production.
    lineTotal: numeric("line_total", { precision: 14, scale: 4 }),
    // Actual charged per-item price in the customer's paid currency (the
    // storefront rounds prices to the nearest 0/5/10 in the display currency
    // and charges the rounded amount). Null for legacy/USD orders; the paid
    // currency itself lives in orders.totals.paid_currency.
    paidUnitPrice: numeric("paid_unit_price", { precision: 14, scale: 4 }),
    paidLineTotal: numeric("paid_line_total", { precision: 14, scale: 4 }),
    imageUrl: text("image_url"),
    // Per-line customer personalization typed on the storefront input field
    // (capped at 22 chars on ingest). Null when the product has no input field.
    customInput: text("custom_input"),
    // Custom (one-off) items created by agents in the dashboard wizard.
    isCustomItem: boolean("is_custom_item").notNull().default(false),
    productionInstructions: text("production_instructions"),
    customItemCreatedBy: text("custom_item_created_by"),
    // Complimentary (free) line item, added by staff as a $0 customer-service
    // gesture from the Add Product modal. complimentaryOriginalPrice is the
    // immutable per-unit catalog price captured at add time (used to compute
    // the Merchandise subtotal / Complimentary item(s) totals rows); reason
    // and note back the required audit trail alongside the order_events row.
    isComplimentary: boolean("is_complimentary").notNull().default(false),
    complimentaryOriginalPrice: numeric("complimentary_original_price", { precision: 14, scale: 4 }),
    complimentaryReason: text("complimentary_reason"),
    complimentaryNote: text("complimentary_note"),
    complimentaryAddedBy: text("complimentary_added_by"),
    complimentaryAddedAt: timestamp("complimentary_added_at", { withTimezone: true }),
    options: jsonb("options"),
    metadata: jsonb("metadata"),
    // initDb's CREATE TABLE has always had created_at; keep Drizzle in
    // lockstep so `drizzle-kit push` (integration tests) matches production.
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_order_line_items_order").on(t.orderId),
    index("idx_order_line_items_product").on(t.productId),
  ],
);

export const orderPayment = pgTable(
  "order_payment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .unique()
      .references(() => orders.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"),
    method: text("method"),
    provider: text("provider"),
    reference: text("provider_ref"),
    amountCents: integer("amount_cents"),
    // numeric(14,4): supports three-decimal currencies (KWD, BHD, OMR) without
    // silent truncation. initDb widens existing columns on first run.
    amountUsd: numeric("amount_usd", { precision: 14, scale: 4 }),
    // Amount actually charged in `currency` (paid-currency amount); amountUsd
    // stays the USD equivalent.
    amount: numeric("amount", { precision: 14, scale: 4 }),
    currency: text("currency"),
    // Cumulative amount refunded so far in the paid currency; refundedAmountUsd
    // is the running USD equivalent. Both accumulate across partial refunds.
    refundedAmount: numeric("refunded_amount", { precision: 14, scale: 4 }),
    refundedAmountUsd: numeric("refunded_amount_usd", { precision: 14, scale: 4 }),
    whishInstructionsSentAt: timestamp("whish_instructions_sent_at", { withTimezone: true }),
    whishInstructionsProviderRef: text("whish_instructions_provider_ref"),
    whishInstructionsStatus: text("whish_instructions_status").notNull().default("not_sent"),
    whishInstructionsFailureReason: text("whish_instructions_failure_reason"),
    whishInstructionsClaimedAt: timestamp("whish_instructions_claimed_at", { withTimezone: true }),
    whishInstructionsClaimToken: uuid("whish_instructions_claim_token"),
    metadata: jsonb("metadata"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("idx_order_payment_order").on(t.orderId)],
);

export const orderNotes = pgTable(
  "order_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    customerNote: text("customer_note"),
    floristNote: text("florist_note"),
    driverNote: text("driver_note"),
    internalNote: text("internal_note"),
  },
  // UNIQUE so the externalOrders / PATCH order-note upsert can use
  // ON CONFLICT (order_id). Must stay unique to match initDb.ts and the
  // dev database; a plain index here would let db:push drop the unique
  // constraint and silently break the upsert.
  (t) => [uniqueIndex("idx_order_notes_order").on(t.orderId)],
);

/**
 * Append-only activity log for an order. Rows are written best-effort when
 * staff change an order's status, mark it paid, refund it, or add an internal
 * note. The order detail Activity timeline merges these rows with synthesized
 * events (order placed, payment paid_at, contact edits).
 */
export const orderEvents = pgTable(
  "order_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload"),
    actorUserId: text("actor_user_id"),
    actorName: text("actor_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_order_events_order").on(t.orderId, t.createdAt)],
);

export const orderContactEdits = pgTable(
  "order_contact_edits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    editedByUserId: text("edited_by_user_id").notNull(),
    editedByName: text("edited_by_name"),
    editedAt: timestamp("edited_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_order_contact_edits_order_role").on(t.orderId, t.role, t.editedAt)],
);

/**
 * Florist workflow assignment for an order. Exactly one row per order (UNIQUE
 * order_id) — re-sending an order to a different florist location replaces the
 * previous assignment. Status is the florist task state, independent of the
 * main order status: pending → in_progress ⇄ paused → completed.
 */
export const orderFloristAssignments = pgTable(
  "order_florist_assignments",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    orderId: uuid("order_id")
      .notNull()
      .unique("order_florist_assignments_order_unique")
      .references(() => orders.id, { onDelete: "cascade" }),
    locationId: integer("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"),
    assignedBy: text("assigned_by"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    // Photo verification workflow (durable per-assignment state).
    cardPrintedAt: timestamp("card_printed_at", { withTimezone: true }),
    photoItemsPath: text("photo_items_path"),
    photoCardPath: text("photo_card_path"),
    verificationStatus: text("verification_status").notNull().default("none"),
    verificationStartedAt: timestamp("verification_started_at", { withTimezone: true }),
    verificationResult: jsonb("verification_result"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    slackPendingAt: timestamp("slack_pending_at", { withTimezone: true }),
    slackSentAt: timestamp("slack_sent_at", { withTimezone: true }),
    photoSetRev: integer("photo_set_rev").notNull().default(0),
    slackAttemptedRev: integer("slack_attempted_rev"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("idx_order_florist_assignments_location").on(t.locationId, t.status),
    index("idx_order_florist_assignments_workspace").on(t.workspaceOwnerId),
  ],
);

/**
 * One row per outgoing customer-communication attempt for an order (currently
 * order emails sent via Resend and WhatsApp templates sent via respond.io.
 * Rows are written best-effort around the send
 * so email sending never breaks when tracking fails. `status` is the
 * normalized latest delivery status; per-status timestamps are set once from
 * webhook events. A row with no recipient_email is recorded as `not_sent`.
 */
export const orderCommunications = pgTable(
  "order_communications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    templateType: text("template_type").notNull(),
    channel: text("channel").notNull().default("email"),
    recipientRole: text("recipient_role").notNull().default("customer"),
    recipientName: text("recipient_name"),
    recipientEmail: text("recipient_email"),
    recipientPhone: text("recipient_phone"),
    subject: text("subject"),
    templateName: text("template_name"),
    idempotencyKey: text("idempotency_key"),
    provider: text("provider").notNull().default("resend"),
    providerMessageId: text("provider_message_id"),
    status: text("status").notNull().default("not_sent"),
    attempt: integer("attempt").notNull().default(1),
    failureReason: text("failure_reason"),
    triggeredByUserId: text("triggered_by_user_id"),
    triggeredByName: text("triggered_by_name"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    openedAt: timestamp("opened_at", { withTimezone: true }),
    clickedAt: timestamp("clicked_at", { withTimezone: true }),
    lastEventAt: timestamp("last_event_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_order_communications_order").on(t.orderId, t.createdAt),
    index("idx_order_communications_provider_msg").on(t.providerMessageId),
    uniqueIndex("idx_order_communications_idempotency")
      .on(t.idempotencyKey)
      .where(sql`${t.idempotencyKey} IS NOT NULL`),
  ],
);

export const orderRescheduleJobs = pgTable(
  "order_reschedule_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => orderEvents.id, { onDelete: "cascade" }),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    orderNumber: text("order_number").notNull(),
    tookanJobId: text("tookan_job_id"),
    windowStart: timestamp("window_start", { withTimezone: true }),
    windowEnd: timestamp("window_end", { withTimezone: true }),
    tookanAddressPayload: jsonb("tookan_address_payload"),
    isReschedule: boolean("is_reschedule").notNull().default(true),
    planningCompletedAt: timestamp("planning_completed_at", { withTimezone: true }),
    tookanCompletedAt: timestamp("tookan_completed_at", { withTimezone: true }),
    notificationCompletedAt: timestamp("notification_completed_at", { withTimezone: true }),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lastError: text("last_error"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("idx_order_reschedule_jobs_event").on(t.eventId),
    index("idx_order_reschedule_jobs_pending").on(t.nextAttemptAt, t.createdAt),
  ],
);

/**
 * Append-only ledger of provider (Resend) delivery events for a communication
 * attempt. `provider_event_id` (svix message id) is unique when present so
 * duplicate webhook deliveries are ignored idempotently.
 */
export const orderCommunicationEvents = pgTable(
  "order_communication_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    communicationId: uuid("communication_id")
      .notNull()
      .references(() => orderCommunications.id, { onDelete: "cascade" }),
    providerEventId: text("provider_event_id"),
    eventType: text("event_type").notNull(),
    rawType: text("raw_type"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_order_comm_events_comm").on(t.communicationId, t.createdAt),
    uniqueIndex("idx_order_comm_events_provider_event")
      .on(t.providerEventId)
      .where(sql`${t.providerEventId} IS NOT NULL`),
  ],
);

/**
 * Trustpilot service-review invitation queue — exactly one row per order
 * (UNIQUE on order_id makes the enqueue idempotent). Rows are created when an
 * order transitions to `completed` and processed asynchronously with retries.
 * Statuses: pending | processing | created | failed | skipped.
 */
export const trustpilotInvitations = pgTable(
  "trustpilot_invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id").notNull().unique(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    status: text("status").notNull().default("pending"),
    recipientEmail: text("recipient_email"),
    recipientName: text("recipient_name"),
    referenceId: text("reference_id"),
    locale: text("locale"),
    preferredSendTime: timestamp("preferred_send_time", { withTimezone: true }),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastError: text("last_error"),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    trustpilotInvitationId: text("trustpilot_invitation_id"),
    responsePayload: jsonb("response_payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_trustpilot_invitations_due").on(t.status, t.nextAttemptAt)],
);

export type TrustpilotInvitation = typeof trustpilotInvitations.$inferSelect;

export type Order = typeof orders.$inferSelect;
export type InsertOrder = typeof orders.$inferInsert;
export type OrderContact = typeof orderContacts.$inferSelect;
export type OrderContactEdit = typeof orderContactEdits.$inferSelect;
export type OrderLineItem = typeof orderLineItems.$inferSelect;
export type OrderPayment = typeof orderPayment.$inferSelect;
export type OrderNotes = typeof orderNotes.$inferSelect;
