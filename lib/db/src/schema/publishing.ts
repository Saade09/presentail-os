import {
  pgTable,
  serial,
  integer,
  text,
  boolean,
  timestamp,
  numeric,
  jsonb,
  uniqueIndex,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// publishing_channels
// ---------------------------------------------------------------------------

export const publishingChannels = pgTable(
  "publishing_channels",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    type: text("type").notNull().default("website"),
    brandId: integer("brand_id"),
    status: text("status").notNull().default("active"),
    defaultCurrency: text("default_currency").notNull().default("USD"),
    autoPublishNewProducts: boolean("auto_publish_new_products").notNull().default(false),
    allowedOrigins: text("allowed_origins"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("idx_publishing_channels_workspace_slug").on(t.workspaceOwnerId, t.slug),
    index("idx_publishing_channels_workspace").on(t.workspaceOwnerId),
  ],
);

export type PublishingChannel = typeof publishingChannels.$inferSelect;
export type InsertPublishingChannel = typeof publishingChannels.$inferInsert;

// ---------------------------------------------------------------------------
// product_publications
// ---------------------------------------------------------------------------

export const productPublications = pgTable(
  "product_publications",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    productId: integer("product_id").notNull(),
    channelId: integer("channel_id").notNull(),
    publicationStatus: text("publication_status").notNull().default("draft"),
    isVisible: boolean("is_visible").notNull().default(true),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    unpublishedAt: timestamp("unpublished_at", { withTimezone: true }),
    scheduledPublishAt: timestamp("scheduled_publish_at", { withTimezone: true }),
    scheduledUnpublishAt: timestamp("scheduled_unpublish_at", { withTimezone: true }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    syncStatus: text("sync_status").notNull().default("never_synced"),
    syncError: text("sync_error"),
    publicSlug: text("public_slug"),
    publicTitle: text("public_title"),
    shortDescription: text("short_description"),
    longDescription: text("long_description"),
    seoTitle: text("seo_title"),
    seoDescription: text("seo_description"),
    ogImageUrl: text("og_image_url"),
    featured: boolean("featured").notNull().default(false),
    sortOrder: integer("sort_order"),
    badges: jsonb("badges").default(sql`'[]'::jsonb`),
    extraFields: jsonb("extra_fields").default(sql`'{}'::jsonb`),
    priceOverride: numeric("price_override", { precision: 10, scale: 2 }),
    salePriceOverride: numeric("sale_price_override", { precision: 10, scale: 2 }),
    currencyOverride: text("currency_override"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("product_publications_product_channel_unique").on(t.productId, t.channelId),
    index("idx_product_publications_product").on(t.productId),
    index("idx_product_publications_channel").on(t.channelId),
    index("idx_product_publications_workspace").on(t.workspaceOwnerId),
    index("idx_product_publications_status").on(t.channelId, t.publicationStatus, t.isVisible),
  ],
);

export type ProductPublication = typeof productPublications.$inferSelect;
export type InsertProductPublication = typeof productPublications.$inferInsert;

// ---------------------------------------------------------------------------
// catalog_api_keys
// ---------------------------------------------------------------------------

export const catalogApiKeys = pgTable(
  "catalog_api_keys",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    name: text("name").notNull(),
    keyHash: text("key_hash").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    channelId: integer("channel_id"),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("idx_catalog_api_keys_hash").on(t.keyHash),
    index("idx_catalog_api_keys_workspace").on(t.workspaceOwnerId),
  ],
);

export type CatalogApiKey = typeof catalogApiKeys.$inferSelect;
export type InsertCatalogApiKey = typeof catalogApiKeys.$inferInsert;

// ---------------------------------------------------------------------------
// product_sync_logs
// ---------------------------------------------------------------------------

export const productSyncLogs = pgTable(
  "product_sync_logs",
  {
    id: serial("id").primaryKey(),
    productId: integer("product_id").notNull(),
    channelId: integer("channel_id").notNull(),
    eventType: text("event_type").notNull(),
    changedFields: jsonb("changed_fields"),
    status: text("status").notNull().default("ok"),
    message: text("message"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_product_sync_logs_product").on(t.productId),
    index("idx_product_sync_logs_channel").on(t.channelId),
    index("idx_product_sync_logs_created").on(t.createdAt),
  ],
);

export type ProductSyncLog = typeof productSyncLogs.$inferSelect;
export type InsertProductSyncLog = typeof productSyncLogs.$inferInsert;

// ---------------------------------------------------------------------------
// channel_webhook_endpoints
// ---------------------------------------------------------------------------

export const channelWebhookEndpoints = pgTable(
  "channel_webhook_endpoints",
  {
    id: serial("id").primaryKey(),
    channelId: integer("channel_id").notNull(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    name: text("name").notNull(),
    endpointUrl: text("endpoint_url").notNull(),
    signingSecret: text("signing_secret").notNull(),
    subscribedEvents: jsonb("subscribed_events").notNull().default(sql`'[]'::jsonb`),
    isActive: boolean("is_active").notNull().default(true),
    lastDeliveryStatus: text("last_delivery_status"),
    lastDeliveryAt: timestamp("last_delivery_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_channel_webhook_endpoints_channel").on(t.channelId),
    index("idx_channel_webhook_endpoints_workspace").on(t.workspaceOwnerId),
  ],
);

export type ChannelWebhookEndpoint = typeof channelWebhookEndpoints.$inferSelect;
export type InsertChannelWebhookEndpoint = typeof channelWebhookEndpoints.$inferInsert;
