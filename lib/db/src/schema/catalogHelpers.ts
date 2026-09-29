import {
  pgTable,
  serial,
  integer,
  text,
  boolean,
  timestamp,
  date,
  primaryKey,
  index,
  jsonb,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// occasion_types — workspace-scoped custom occasion types with colour
// ---------------------------------------------------------------------------

export const occasionTypes = pgTable(
  "occasion_types",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    name: text("name").notNull(),
    color: text("color").notNull().default("#6366f1"),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [index("idx_occasion_types_workspace").on(t.workspaceOwnerId)],
);

export type OccasionType = typeof occasionTypes.$inferSelect;
export type InsertOccasionType = typeof occasionTypes.$inferInsert;

// ---------------------------------------------------------------------------
// occasion_campaigns — named marketing campaigns linked to occasions
// ---------------------------------------------------------------------------

export const occasionCampaigns = pgTable(
  "occasion_campaigns",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    name: text("name").notNull(),
    type: text("type").notNull().default("seasonal"),
    markets: jsonb("markets").notNull().default(sql`'[]'::jsonb`),
    productFocus: text("product_focus"),
    recommendedChannels: jsonb("recommended_channels")
      .notNull()
      .default(sql`'[]'::jsonb`),
    campaignStartDaysBefore: integer("campaign_start_days_before")
      .notNull()
      .default(30),
    month: integer("month"),
    day: integer("day"),
    notes: text("notes"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
    // Extended fields added after initial release
    priority: text("priority").notNull().default("medium"),
    status: text("status").notNull().default("active"),
    description: text("description"),
    recurrence: text("recurrence").notNull().default("annual_fixed"),
    preparationDays: integer("preparation_days"),
    demandLevel: text("demand_level"),
    ownerUserId: text("owner_user_id"),
    tags: jsonb("tags").notNull().default(sql`'[]'::jsonb`),
  },
  (t) => [
    index("idx_occasion_campaigns_workspace").on(
      t.workspaceOwnerId,
      t.isActive,
    ),
  ],
);

export type OccasionCampaign = typeof occasionCampaigns.$inferSelect;
export type InsertOccasionCampaign = typeof occasionCampaigns.$inferInsert;

// ---------------------------------------------------------------------------
// occasion_readiness_items — checklist items tracking readiness per occasion
// ---------------------------------------------------------------------------

export const occasionReadinessItems = pgTable(
  "occasion_readiness_items",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    occasionId: integer("occasion_id")
      .notNull()
      .references(() => occasionCampaigns.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    category: text("category").notNull().default("general"),
    status: text("status").notNull().default("not_started"),
    ownerUserId: text("owner_user_id"),
    dueDate: date("due_date"),
    notes: text("notes"),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("idx_readiness_items_occasion").on(t.occasionId),
    index("idx_readiness_items_workspace").on(t.workspaceOwnerId),
  ],
);

export type OccasionReadinessItem = typeof occasionReadinessItems.$inferSelect;
export type InsertOccasionReadinessItem =
  typeof occasionReadinessItems.$inferInsert;

// ---------------------------------------------------------------------------
// homepage_banners — admin-managed banners for the public storefront
// ---------------------------------------------------------------------------

export const homepageBanners = pgTable(
  "homepage_banners",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    internalName: text("internal_name").notNull(),
    title: text("title"),
    headline: text("headline"),
    subtitle: text("subtitle"),
    ctaText: text("cta_text"),
    countryCodes: text("country_codes")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    cityIds: integer("city_ids")
      .array()
      .notNull()
      .default(sql`'{}'::integer[]`),
    isGlobalForCountry: boolean("is_global_for_country")
      .notNull()
      .default(false),
    desktopEnabled: boolean("desktop_enabled").notNull().default(false),
    desktopMediaType: text("desktop_media_type"),
    desktopMediaUrl: text("desktop_media_url"),
    desktopMediaPublicPath: text("desktop_media_public_path"),
    desktopFallbackUrl: text("desktop_fallback_url"),
    desktopFallbackPublicPath: text("desktop_fallback_public_path"),
    desktopLinkUrl: text("desktop_link_url"),
    mobileEnabled: boolean("mobile_enabled").notNull().default(false),
    mobileMediaType: text("mobile_media_type"),
    mobileMediaUrl: text("mobile_media_url"),
    mobileMediaPublicPath: text("mobile_media_public_path"),
    mobileFallbackUrl: text("mobile_fallback_url"),
    mobileFallbackPublicPath: text("mobile_fallback_public_path"),
    mobileLinkUrl: text("mobile_link_url"),
    // Structured banner-level link target. linkKind is "category" | "occasion";
    // linkAttributeId references the picked catalog_categories/occasions row;
    // linkSlug is the resolved slug snapshot the storefront uses to build URLs.
    linkKind: text("link_kind"),
    linkAttributeId: integer("link_attribute_id"),
    linkSlug: text("link_slug"),
    // Language targeting: array of locale codes ('en', 'ar', 'fr'). Defaults to all.
    languages: text("languages")
      .array()
      .notNull()
      .default(sql`'{en,ar}'::text[]`),
    // Structured click destination (replaces per-side link_url in the admin UI).
    // destination_type: 'none' | 'category' | 'occasion' | 'custom_url'
    // destination_value: the custom URL when destination_type = 'custom_url'
    destinationType: text("destination_type"),
    destinationValue: text("destination_value"),
    // Status override: 'paused' when an admin manually pauses a live/scheduled banner.
    statusOverride: text("status_override"),
    startAt: timestamp("start_at", { withTimezone: true }),
    endAt: timestamp("end_at", { withTimezone: true }),
    timezone: text("timezone").notNull().default("UTC"),
    sortOrder: integer("sort_order").notNull().default(0),
    priority: integer("priority").notNull().default(0),
    isActive: boolean("is_active").notNull().default(false),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    createdBy: text("created_by"),
    updatedBy: text("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_homepage_banners_workspace").on(
      t.workspaceOwnerId,
      t.createdAt,
    ),
    index("idx_homepage_banners_storefront")
      .on(t.isActive, t.startAt, t.endAt)
      .where(sql`is_active = true`),
    index("idx_homepage_banners_country").on(t.countryCodes),
  ],
);

export type HomepageBanner = typeof homepageBanners.$inferSelect;
export type InsertHomepageBanner = typeof homepageBanners.$inferInsert;

// ---------------------------------------------------------------------------
// country_flag_overrides — per-workspace URL overrides for country flag images
// ---------------------------------------------------------------------------

export const countryFlagOverrides = pgTable(
  "country_flag_overrides",
  {
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    countryCode: text("country_code").notNull(),
    imageUrl: text("image_url").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceOwnerId, t.countryCode] })],
);

export type CountryFlagOverride = typeof countryFlagOverrides.$inferSelect;
export type InsertCountryFlagOverride =
  typeof countryFlagOverrides.$inferInsert;
