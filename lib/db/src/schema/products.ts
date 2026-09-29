import {
  pgTable,
  serial,
  bigserial,
  integer,
  text,
  boolean,
  timestamp,
  numeric,
  uuid,
  uniqueIndex,
  unique,
  index,
  primaryKey,
  jsonb,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { locations } from "./workspace";
import {
  occasions,
  catalogCategories,
  catalogBrands,
  recipients,
} from "./catalogAttributes";
import { baseItems } from "./baseItems";

// ---------------------------------------------------------------------------
// products
// ---------------------------------------------------------------------------

export const products = pgTable(
  "products",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    name: text("name").notNull(),
    priceUsd: numeric("price_usd", { precision: 10, scale: 2 })
      .notNull()
      .default("0"),
    priceAed: numeric("price_aed", { precision: 10, scale: 2 })
      .notNull()
      .default("0"),
    // Optional sale/discount prices. Null when the product is not on sale.
    discountPriceUsd: numeric("discount_price_usd", { precision: 10, scale: 2 }),
    discountPriceAed: numeric("discount_price_aed", { precision: 10, scale: 2 }),
    mainImageUrl: text("main_image_url"),
    additionalImageUrls: text("additional_image_urls")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    // Stable key (relative to PUBLIC_OBJECT_SEARCH_PATHS) of the public,
    // auth-free copy of the main image. Populated on create/update and by the
    // startup backfill in backfillProductPublicImages(). Null when no image.
    imagePublicPath: text("image_public_path"),
    // Public keys of the auth-free copies of the additional images, positionally
    // aligned with additionalImageUrls.
    additionalImagePublicPaths: text("additional_image_public_paths")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    // Versioned public WebP derivatives for catalog display and dense
    // thumbnail surfaces. Originals above remain the download/edit source.
    imageDisplayPublicPath: text("image_display_public_path"),
    imageThumbnailPublicPath: text("image_thumbnail_public_path"),
    additionalImageDisplayPublicPaths: text("additional_image_display_public_paths")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    additionalImageThumbnailPublicPaths: text("additional_image_thumbnail_public_paths")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    description: text("description"),
    // Cached auto-translated Arabic description (best-effort, filled lazily
    // when florist orders are viewed). Null until first translation.
    descriptionAr: text("description_ar"),
    status: text("status").notNull().default("available"),
    brand: text("brand"),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    sku: text("sku"),
    isArchived: boolean("is_archived").notNull().default(false),
    expressDeliveryEnabled: boolean("express_delivery_enabled")
      .notNull()
      .default(true),
    // When true the public ordering website shows a free-text personalization
    // input on this product (capped at 22 chars). Off by default.
    hasInputField: boolean("has_input_field").notNull().default(false),
    // When true the public ordering website shows a single-letter (1 character)
    // input on this product (e.g. letter-shaped products). Off by default.
    letterInputEnabled: boolean("letter_input_enabled").notNull().default(false),
    // When true this product is an upsell item. It appears in an upsell
    // category's section on the website only when it is also linked to a
    // catalog category that is itself marked upsell. Off by default.
    isUpsell: boolean("is_upsell").notNull().default(false),
    // ---------------------------------------------------------------------------
    // Google Merchant Center sync columns (added via SQL, not ALTER in initDb)
    // ---------------------------------------------------------------------------
    // WooCommerce product ID used to build the public product URL on presentail.com.
    wooProductId: integer("woo_product_id"),
    // Sync lifecycle: 'pending' | 'synced' | 'error' | 'disabled'
    merchantSyncStatus: text("merchant_sync_status"),
    merchantSyncError: text("merchant_sync_error"),
    merchantSyncedAt: timestamp("merchant_synced_at", { withTimezone: true }),
    // The fully-qualified resource name returned by the Merchant API on insert/update.
    merchantResourceName: text("merchant_resource_name"),
    // Raw JSON response body from the last Merchant API call (for debugging).
    merchantLastResponse: jsonb("merchant_last_response"),
    // Number of sync attempts made (for back-off / circuit-breaker logic).
    merchantSyncAttempts: integer("merchant_sync_attempts").default(0),
    // When true this product is excluded from all Merchant sync runs.
    merchantSyncDisabled: boolean("merchant_sync_disabled").default(false),
    // Google Merchant Center numeric category ID (e.g. 632 for Flowers).
    googleProductCategory: text("google_product_category"),
    // target_country remains in deployed databases for backwards compatibility,
    // but is intentionally not modeled. Merchant offers are country-scoped state.
    // BCP-47 content language code for the feed entry. Defaults to en.
    contentLanguage: text("content_language"),
    // When true this product participates in recipe-based inventory consumption.
    // Backfilled from product_recipes on migration.
    inventoryTracked: boolean("inventory_tracked").notNull().default(false),
    recipeVersion: integer("recipe_version").notNull().default(0),
  },
  (t) => [
    index("idx_products_workspace").on(t.workspaceOwnerId),
    // This composite key backs workspace-scoped recipe intelligence foreign
    // keys. Keep it as a table-level constraint so the publish diff recognizes
    // it as a prerequisite before adding dependent foreign keys.
    unique("recipe_intelligence_products_workspace_id_unique").on(
      t.workspaceOwnerId,
      t.id,
    ),
    index("idx_products_brand").on(t.workspaceOwnerId, t.brand),
    index("idx_products_workspace_status").on(t.workspaceOwnerId, t.status),
    uniqueIndex("idx_products_workspace_sku_unique")
      .on(t.workspaceOwnerId, t.sku)
      .where(sql`${t.sku} IS NOT NULL`),
    index("idx_products_workspace_sku").on(t.workspaceOwnerId, t.sku),
    // GIN trigram indexes — use gin access method with gin_trgm_ops operator class.
    // brand uses a lower() functional expression to match initDb DDL.
    index("idx_products_name_trgm").using("gin", sql`${t.name} gin_trgm_ops`),
    index("idx_products_brand_trgm").using(
      "gin",
      sql`lower(${t.brand}) gin_trgm_ops`,
    ),
    index("idx_products_sku_trgm")
      .using("gin", sql`${t.sku} gin_trgm_ops`)
      .where(sql`${t.sku} IS NOT NULL`),
  ],
);

/** @deprecated targetCountry exists only to type legacy callers during migration. */
export type Product = typeof products.$inferSelect & { targetCountry?: string | null };
export type InsertProduct = typeof products.$inferInsert;

// ---------------------------------------------------------------------------
// product_recipes — join table: which base items (and quantity) make a product
// ---------------------------------------------------------------------------

export const productRecipes = pgTable(
  "product_recipes",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    productId: integer("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    baseItemId: integer("base_item_id")
      .notNull()
      .references(() => baseItems.id, { onDelete: "cascade" }),
    quantity: numeric("quantity").notNull().default("1"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    // Added via ALTER TABLE
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [
    // Inline CONSTRAINT in CREATE TABLE — not a separate CREATE UNIQUE INDEX
    unique("product_recipes_product_base_item_unique").on(
      t.productId,
      t.baseItemId,
    ),
    index("idx_product_recipes_product").on(t.workspaceOwnerId, t.productId),
  ],
);

export type ProductRecipe = typeof productRecipes.$inferSelect;
export type InsertProductRecipe = typeof productRecipes.$inferInsert;

// ---------------------------------------------------------------------------
// product_location_statuses — per-product per-location availability toggles
// ---------------------------------------------------------------------------

export const productLocationStatuses = pgTable(
  "product_location_statuses",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    productId: integer("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    locationId: integer("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Inline CONSTRAINT in CREATE TABLE — not a separate CREATE UNIQUE INDEX
    unique("product_location_statuses_unique").on(t.productId, t.locationId),
    index("idx_pls_workspace").on(t.workspaceOwnerId),
  ],
);

export type ProductLocationStatus = typeof productLocationStatuses.$inferSelect;
export type InsertProductLocationStatus = typeof productLocationStatuses.$inferInsert;

// ---------------------------------------------------------------------------
// product_city_availability — per-product per-city availability flag
// ---------------------------------------------------------------------------

export const productCityAvailability = pgTable(
  "product_city_availability",
  {
    id: serial("id").primaryKey(),
    productId: integer("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    // city_id historically referenced the legacy `cities` table. That table is
    // retired (its data migrated to delivery_cities and the table archived), so
    // this is now a bare integer holding delivery_cities IDs — no FK. The column
    // is filtered against delivery_cities at query time. See initDb.ts.
    cityId: integer("city_id").notNull(),
    isAvailable: boolean("is_available").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("idx_pca_product_city").on(t.productId, t.cityId),
    index("idx_pca_city").on(t.cityId),
  ],
);

export type ProductCityAvailability = typeof productCityAvailability.$inferSelect;
export type InsertProductCityAvailability = typeof productCityAvailability.$inferInsert;

// ---------------------------------------------------------------------------
// product_country_availability — per-product per-country availability flag
//
// Parallel to product_city_availability but keyed by ISO 3166-1 alpha-2
// country code (uppercase) rather than a numeric id, consistent with
// delivery_cities.country_code. Default-on model: a product is available in
// every enabled workspace country unless an explicit row sets is_available =
// false. No FK — the country universe is derived from the workspace's
// available_countries at query time.
// ---------------------------------------------------------------------------

export const productCountryAvailability = pgTable(
  "product_country_availability",
  {
    id: serial("id").primaryKey(),
    productId: integer("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    countryCode: text("country_code").notNull(),
    isAvailable: boolean("is_available").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("idx_pcountrya_product_country").on(t.productId, t.countryCode),
    index("idx_pcountrya_country").on(t.countryCode),
  ],
);

export type ProductCountryAvailability = typeof productCountryAvailability.$inferSelect;
export type InsertProductCountryAvailability = typeof productCountryAvailability.$inferInsert;

// ---------------------------------------------------------------------------
// product_occasions — product ↔ occasion assignment (composite-PK join table)
// ---------------------------------------------------------------------------

export const productOccasions = pgTable(
  "product_occasions",
  {
    productId: integer("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    attributeId: integer("attribute_id")
      .notNull()
      .references(() => occasions.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.productId, t.attributeId] }),
    index("idx_product_occasions_attr").on(t.attributeId),
  ],
);

export type ProductOccasion = typeof productOccasions.$inferSelect;
export type InsertProductOccasion = typeof productOccasions.$inferInsert;

// ---------------------------------------------------------------------------
// product_catalog_categories — product ↔ catalog category (composite-PK join)
// ---------------------------------------------------------------------------

export const productCatalogCategories = pgTable(
  "product_catalog_categories",
  {
    productId: integer("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    attributeId: integer("attribute_id")
      .notNull()
      .references(() => catalogCategories.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.productId, t.attributeId] }),
    index("idx_product_catalog_categories_attr").on(t.attributeId),
  ],
);

export type ProductCatalogCategory = typeof productCatalogCategories.$inferSelect;
export type InsertProductCatalogCategory = typeof productCatalogCategories.$inferInsert;

// ---------------------------------------------------------------------------
// product_catalog_brands — product ↔ catalog brand (composite-PK join table)
// ---------------------------------------------------------------------------

export const productCatalogBrands = pgTable(
  "product_catalog_brands",
  {
    productId: integer("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    attributeId: integer("attribute_id")
      .notNull()
      .references(() => catalogBrands.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.productId, t.attributeId] }),
    index("idx_product_catalog_brands_attr").on(t.attributeId),
  ],
);

export type ProductCatalogBrand = typeof productCatalogBrands.$inferSelect;
export type InsertProductCatalogBrand = typeof productCatalogBrands.$inferInsert;

// ---------------------------------------------------------------------------
// product_recipients — product ↔ recipient (composite-PK join table)
// ---------------------------------------------------------------------------

export const productRecipients = pgTable(
  "product_recipients",
  {
    productId: integer("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    attributeId: integer("attribute_id")
      .notNull()
      .references(() => recipients.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.productId, t.attributeId] }),
    index("idx_product_recipients_attr").on(t.attributeId),
  ],
);

export type ProductRecipient = typeof productRecipients.$inferSelect;
export type InsertProductRecipient = typeof productRecipients.$inferInsert;

// ---------------------------------------------------------------------------
// coupons — discount/promo codes (USD only). UUID PK = opaque couponId echoed
// back in the storefront order payload.
// ---------------------------------------------------------------------------

export const coupons = pgTable(
  "coupons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    code: text("code").notNull(),
    description: text("description"),
    // 'percentage' | 'fixed'
    discountType: text("discount_type").notNull().default("percentage"),
    discountValue: numeric("discount_value", { precision: 10, scale: 2 })
      .notNull()
      .default("0"),
    minOrderUsd: numeric("min_order_usd", { precision: 10, scale: 2 }),
    // 'all' | 'restricted'
    scope: text("scope").notNull().default("all"),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    // null = unlimited
    perUserLimit: integer("per_user_limit"),
    globalLimit: integer("global_limit"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Codes are unique per workspace, matched case-insensitively.
    uniqueIndex("idx_coupons_workspace_code_unique").on(
      t.workspaceOwnerId,
      sql`lower(${t.code})`,
    ),
    index("idx_coupons_workspace").on(t.workspaceOwnerId),
  ],
);

export type Coupon = typeof coupons.$inferSelect;
export type InsertCoupon = typeof coupons.$inferInsert;

// ---------------------------------------------------------------------------
// coupon_products — coupon ↔ product restriction (composite-PK join table)
// ---------------------------------------------------------------------------

export const couponProducts = pgTable(
  "coupon_products",
  {
    couponId: uuid("coupon_id")
      .notNull()
      .references(() => coupons.id, { onDelete: "cascade" }),
    productId: integer("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.couponId, t.productId] }),
    index("idx_coupon_products_product").on(t.productId),
  ],
);

export type CouponProduct = typeof couponProducts.$inferSelect;
export type InsertCouponProduct = typeof couponProducts.$inferInsert;

// ---------------------------------------------------------------------------
// coupon_attributes — coupon ↔ catalog-attribute restriction. attribute_type
// discriminates occasion/category/brand/recipient; attribute_id references the
// matching attribute table (validated at write time, no polymorphic FK).
// ---------------------------------------------------------------------------

export const couponAttributes = pgTable(
  "coupon_attributes",
  {
    couponId: uuid("coupon_id")
      .notNull()
      .references(() => coupons.id, { onDelete: "cascade" }),
    // 'occasion' | 'category' | 'brand' | 'recipient'
    attributeType: text("attribute_type").notNull(),
    attributeId: integer("attribute_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.couponId, t.attributeType, t.attributeId] }),
  ],
);

export type CouponAttribute = typeof couponAttributes.$inferSelect;
export type InsertCouponAttribute = typeof couponAttributes.$inferInsert;

// ---------------------------------------------------------------------------
// coupon_redemptions — ledger of confirmed redemptions used to enforce usage
// limits. One row per order (idempotent on re-ingest via unique coupon+order).
// ---------------------------------------------------------------------------

export const couponRedemptions = pgTable(
  "coupon_redemptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    couponId: uuid("coupon_id")
      .notNull()
      .references(() => coupons.id, { onDelete: "cascade" }),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    // orders.id (uuid). No FK to avoid a cross-file circular import; the link is
    // managed at the application layer.
    orderId: uuid("order_id"),
    customerEmail: text("customer_email"),
    discountAmountUsd: numeric("discount_amount_usd", { precision: 10, scale: 2 })
      .notNull()
      .default("0"),
    status: text("status").notNull().default("confirmed"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("idx_coupon_redemptions_order_unique")
      .on(t.couponId, t.orderId)
      .where(sql`${t.orderId} IS NOT NULL`),
    index("idx_coupon_redemptions_coupon").on(t.couponId),
    index("idx_coupon_redemptions_coupon_email").on(t.couponId, t.customerEmail),
  ],
);

export type CouponRedemption = typeof couponRedemptions.$inferSelect;
export type InsertCouponRedemption = typeof couponRedemptions.$inferInsert;

// ---------------------------------------------------------------------------
// merchant_sync_jobs — durable queue for Google Merchant Center sync operations
// ---------------------------------------------------------------------------

export const merchantSyncJobs = pgTable(
  "merchant_sync_jobs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    productId: integer("product_id").references(() => products.id, {
      onDelete: "set null",
    }),
    offerCountry: text("offer_country"),
    offerContentLanguage: text("offer_content_language"),
    reconciliationItemId: bigserial("reconciliation_item_id", { mode: "number" }),
    dependsOnJobId: bigserial("depends_on_job_id", { mode: "number" }),
    operation: text("operation").notNull(),
    status: text("status").notNull().default("PENDING"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    payload: jsonb("payload").notNull().default({}),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_msj_status_next_retry").on(t.status, t.nextRetryAt),
    index("idx_msj_product").on(t.productId),
    index("idx_msj_created").on(t.createdAt),
    uniqueIndex("idx_msj_one_active_per_offer")
      .on(t.productId, t.offerCountry, t.offerContentLanguage)
      .where(sql`${t.status} IN ('PENDING', 'RUNNING', 'RETRY_WAITING')`),
  ],
);

export type MerchantSyncJob = typeof merchantSyncJobs.$inferSelect;
export type InsertMerchantSyncJob = typeof merchantSyncJobs.$inferInsert;
