import {
  pgTable,
  serial,
  bigserial,
  integer,
  text,
  timestamp,
  date,
  numeric,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// web_events — behavioral events pushed from the public website (presentail.com)
//
// The website pushes visitor behavior (page views, product views, add-to-cart,
// checkout steps, payment states, promo-code usage, search queries, etc.) to OS
// via an API-key authenticated ingestion endpoint (mirrors the order webhook).
// Rows are append-only and suitable for funnel/session/search aggregation.
// ---------------------------------------------------------------------------

export const webEvents = pgTable(
  "web_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    // Event name, e.g. page_view, product_view, add_to_cart, checkout_step,
    // payment_started, payment_completed, promo_applied, search, search_no_result.
    eventType: text("event_type").notNull(),
    // Anonymous session + visitor identifiers assigned by the website.
    sessionId: text("session_id"),
    visitorId: text("visitor_id"),
    // Client-provided event time; received_at is the server ingest time.
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Page / navigation context.
    url: text("url"),
    path: text("path"),
    referrer: text("referrer"),
    // Traffic source + UTM attribution.
    trafficSource: text("traffic_source"),
    utmSource: text("utm_source"),
    utmMedium: text("utm_medium"),
    utmCampaign: text("utm_campaign"),
    utmTerm: text("utm_term"),
    utmContent: text("utm_content"),
    // Device / locale context.
    deviceType: text("device_type"),
    language: text("language"),
    country: text("country"),
    city: text("city"),
    // Catalog context (free-text refs from the website; not FK-constrained).
    productRef: text("product_ref"),
    category: text("category"),
    occasion: text("occasion"),
    brand: text("brand"),
    // Search context.
    searchQuery: text("search_query"),
    resultCount: integer("result_count"),
    // Monetary context (cart/checkout value where relevant).
    value: numeric("value", { precision: 12, scale: 2 }),
    currency: text("currency"),
    // Catch-all for any additional event-specific fields the website sends.
    properties: jsonb("properties").notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [
    index("idx_web_events_owner_time").on(t.workspaceOwnerId, t.occurredAt),
    index("idx_web_events_owner_type_time").on(
      t.workspaceOwnerId,
      t.eventType,
      t.occurredAt,
    ),
    index("idx_web_events_owner_session").on(t.workspaceOwnerId, t.sessionId),
    index("idx_web_events_retention").on(t.receivedAt),
  ],
);

export type WebEvent = typeof webEvents.$inferSelect;
export type InsertWebEvent = typeof webEvents.$inferInsert;

// ---------------------------------------------------------------------------
// ad_spend_entries — marketing ad spend per channel/campaign and period
//
// Records spend (plus optional impressions/clicks/conversions) so downstream
// analytics can compute ROAS/CAC. Owner-managed via the dashboard (manual entry
// or bulk import). Upsert keyed by (workspace, channel, campaign, period).
// ---------------------------------------------------------------------------

export const adSpendEntries = pgTable(
  "ad_spend_entries",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    // e.g. google_ads, meta, tiktok, snapchat.
    channel: text("channel").notNull(),
    campaign: text("campaign"),
    campaignExternalId: text("campaign_external_id"),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    spendAmount: numeric("spend_amount", { precision: 12, scale: 2 }).notNull(),
    currency: text("currency").notNull().default("AED"),
    impressions: integer("impressions"),
    clicks: integer("clicks"),
    conversions: integer("conversions"),
    // How the row was recorded: manual | import | integration.
    source: text("source").notNull().default("manual"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_ad_spend_owner_period").on(
      t.workspaceOwnerId,
      t.periodStart,
      t.periodEnd,
    ),
    index("idx_ad_spend_owner_channel").on(t.workspaceOwnerId, t.channel),
    index("idx_ad_spend_api_external_lookup")
      .on(
        t.workspaceOwnerId,
        t.channel,
        t.source,
        t.campaignExternalId,
        t.periodStart,
        t.periodEnd,
      )
      .where(
        sql`${t.campaignExternalId} IS NOT NULL AND ${t.source} IN ('google_ads_api', 'meta_api')`,
      ),
  ],
);

export type AdSpendEntry = typeof adSpendEntries.$inferSelect;
export type InsertAdSpendEntry = typeof adSpendEntries.$inferInsert;

// ---------------------------------------------------------------------------
// ad_platform_connections — per-workspace ad platform connection + sync state
//
// One row per (workspace, platform) with encrypted API credentials, sync
// status, last sync timestamps and the last error, driving the automatic
// Google Ads / Meta Ads spend sync into ad_spend_entries.
// ---------------------------------------------------------------------------

export const adPlatformConnections = pgTable(
  "ad_platform_connections",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    // google_ads | meta_ads
    platform: text("platform").notNull(),
    // AES-256-GCM encrypted JSON blob of platform credentials.
    credentialsEncrypted: text("credentials_encrypted").notNull(),
    // service_account after a successful server-side Google Ads verification.
    // Legacy encrypted credentials remain untouched for rollback.
    authMode: text("auth_mode"),
    accountLabel: text("account_label"),
    accountCurrency: text("account_currency"),
    accountTimeZone: text("account_time_zone"),
    accountCreatedTime: text("account_created_time"),
    // idle | syncing | error
    syncStatus: text("sync_status").notNull().default("idle"),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    lastFullSyncAt: timestamp("last_full_sync_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("idx_ad_platform_connections_unique").on(
      t.workspaceOwnerId,
      t.platform,
    ),
  ],
);

export type AdPlatformConnection = typeof adPlatformConnections.$inferSelect;
export type InsertAdPlatformConnection = typeof adPlatformConnections.$inferInsert;

// ---------------------------------------------------------------------------
// seo_metrics — SEO performance metrics (impressions, clicks, CTR, position)
//
// Per landing-page and/or query, per period. Owner-managed (manual entry or
// import from Google Search Console). Upsert keyed by
// (workspace, period, landing_page, query).
// ---------------------------------------------------------------------------

export const seoMetrics = pgTable(
  "seo_metrics",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    // Nullable: a NULL landing_page / query row represents an aggregate.
    landingPage: text("landing_page"),
    query: text("query"),
    impressions: integer("impressions").notNull().default(0),
    clicks: integer("clicks").notNull().default(0),
    ctr: numeric("ctr", { precision: 6, scale: 4 }),
    avgPosition: numeric("avg_position", { precision: 6, scale: 2 }),
    source: text("source").notNull().default("manual"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_seo_metrics_owner_period").on(
      t.workspaceOwnerId,
      t.periodStart,
      t.periodEnd,
    ),
  ],
);

export type SeoMetric = typeof seoMetrics.$inferSelect;
export type InsertSeoMetric = typeof seoMetrics.$inferInsert;

// ---------------------------------------------------------------------------
// search_console_connections — per-workspace Google Search Console connection
//
// One row per workspace with encrypted OAuth credentials, connected site URL,
// sync status, and last sync timestamps. Drives the automatic Search Analytics
// data ingestion into seo_metrics.
// ---------------------------------------------------------------------------

export const searchConsoleConnections = pgTable(
  "search_console_connections",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    // Verified GSC property URL (e.g. "https://example.com/").
    siteUrl: text("site_url").notNull(),
    // AES-256-GCM encrypted JSON blob: { accessToken, refreshToken, expiresAt }.
    credentialsEncrypted: text("credentials_encrypted").notNull(),
    // idle | syncing | error
    syncStatus: text("sync_status").notNull().default("idle"),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("idx_search_console_connections_unique").on(t.workspaceOwnerId),
  ],
);

export type SearchConsoleConnection =
  typeof searchConsoleConnections.$inferSelect;
export type InsertSearchConsoleConnection =
  typeof searchConsoleConnections.$inferInsert;

// ---------------------------------------------------------------------------
// search_console_oauth_config — workspace-specific Google OAuth application
//
// A workspace can override the server OAuth application with its own encrypted
// Client ID and Client Secret. The encrypted value is deliberately the only
// credential field represented in the database schema.
// ---------------------------------------------------------------------------

export const searchConsoleOauthConfigs = pgTable(
  "search_console_oauth_config",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    oauthClientEncrypted: text("oauth_client_encrypted").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("idx_search_console_oauth_config_unique").on(t.workspaceOwnerId),
  ],
);

export type SearchConsoleOauthConfig =
  typeof searchConsoleOauthConfigs.$inferSelect;
export type InsertSearchConsoleOauthConfig =
  typeof searchConsoleOauthConfigs.$inferInsert;

// ---------------------------------------------------------------------------
// search_console_oauth_states — short-lived, single-use OAuth state records
//
// The callback atomically deletes a non-expired state record, binding one
// authorization attempt to the workspace owner that started it.
// ---------------------------------------------------------------------------

export const searchConsoleOauthStates = pgTable(
  "search_console_oauth_states",
  {
    state: text("state").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_search_console_oauth_states_expires_at").on(t.expiresAt),
  ],
);

export type SearchConsoleOauthState =
  typeof searchConsoleOauthStates.$inferSelect;
export type InsertSearchConsoleOauthState =
  typeof searchConsoleOauthStates.$inferInsert;
