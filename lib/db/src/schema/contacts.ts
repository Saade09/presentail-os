import { pgTable, text, boolean, timestamp, jsonb, uuid, uniqueIndex, index, bigserial, numeric } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    source: text("source"),
    externalContactId: text("external_contact_id"),
    accountId: text("account_id"),
    isGuest: boolean("is_guest").notNull().default(true),
    firstName: text("first_name"),
    lastName: text("last_name"),
    displayName: text("display_name"),
    email: text("email"),
    phone: text("phone"),
    phoneSearchTokens: text("phone_search_tokens").array(),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    autoTagsApplied: text("auto_tags_applied").array().notNull().default(sql`'{}'::text[]`),
    addresses: jsonb("addresses"),
    metadata: jsonb("metadata"),
    gender: text("gender").notNull().default("unknown"),
    genderSource: text("gender_source"),
    genderConfidence: numeric("gender_confidence"),
    genderContextCountry: text("gender_context_country"),
    genderInferredAt: timestamp("gender_inferred_at", { withTimezone: true }),
    genderModelVersion: text("gender_model_version"),
    /** Legacy ManyChat column — integration replaced by respond.io; kept dormant to avoid a destructive migration. */
    manychatSubscriberId: text("manychat_subscriber_id"),
    respondioContactId: text("respondio_contact_id"),
    // ── Consent & suppression (Audiences) ────────────────────────────────
    // Reachability is NEVER inferred from mere possession of an email/phone:
    // a contact is email-reachable only when it has an email AND
    // email_consent AND is not globally suppressed (unsubscribed_at IS NULL);
    // WhatsApp-reachable analogously with phone + whatsapp_consent.
    // Existing contacts default to NOT consented — no automatic backfill rule
    // applies (a messaging-provider link, e.g. a respond.io contact, is not
    // proof of consent).
    emailConsent: boolean("email_consent").notNull().default(false),
    whatsappConsent: boolean("whatsapp_consent").notNull().default(false),
    /** Global unsubscribe/suppression — set means unreachable on ALL channels. */
    unsubscribedAt: timestamp("unsubscribed_at", { withTimezone: true }),
    consentUpdatedAt: timestamp("consent_updated_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_contacts_workspace").on(t.workspaceOwnerId),
    uniqueIndex("contacts_workspace_source_external_unique")
      .on(t.workspaceOwnerId, t.source, t.externalContactId)
      .where(sql`${t.source} IS NOT NULL AND ${t.externalContactId} IS NOT NULL`),
    uniqueIndex("contacts_workspace_email_unique")
      .on(t.workspaceOwnerId, t.email)
      .where(sql`${t.email} IS NOT NULL`),
    uniqueIndex("contacts_workspace_phone_unique")
      .on(t.workspaceOwnerId, t.phone)
      .where(sql`${t.phone} IS NOT NULL`),
  ],
);

export type Contact = typeof contacts.$inferSelect;
export type InsertContact = typeof contacts.$inferInsert;

/** Manual notes attached to a contact by workspace members. */
export const contactNotes = pgTable(
  "contact_notes",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    authorUserId: text("author_user_id"),
    authorName: text("author_name"),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_contact_notes_contact").on(t.contactId, t.createdAt)],
);

export type ContactNote = typeof contactNotes.$inferSelect;

/** Append-only system activity log for a contact (edits, tags, merges…). */
export const contactActivity = pgTable(
  "contact_activity",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    actorUserId: text("actor_user_id"),
    actorName: text("actor_name"),
    data: jsonb("data"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_contact_activity_contact").on(t.contactId, t.createdAt)],
);

export type ContactActivityRow = typeof contactActivity.$inferSelect;

/**
 * Cache of AI gender-inference results keyed by normalized first name +
 * country context + language + prompt/model version. Ambiguous/unknown
 * results are cached too so repeat names never re-call the AI.
 */
export const genderInferenceCache = pgTable(
  "gender_inference_cache",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    normalizedFirstName: text("normalized_first_name").notNull(),
    countryContext: text("country_context").notNull().default(""),
    language: text("language").notNull().default(""),
    promptVersion: text("prompt_version").notNull(),
    gender: text("gender").notNull(),
    confidence: numeric("confidence"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("gender_inference_cache_key_unique").on(
      t.normalizedFirstName,
      t.countryContext,
      t.language,
      t.promptVersion,
    ),
  ],
);

export type GenderInferenceCacheRow = typeof genderInferenceCache.$inferSelect;
