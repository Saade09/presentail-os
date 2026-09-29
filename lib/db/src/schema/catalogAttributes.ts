import {
  pgTable,
  serial,
  integer,
  text,
  boolean,
  timestamp,
  index,
  unique,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// occasions
// ---------------------------------------------------------------------------

export const occasions = pgTable(
  "occasions",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    imageUrl: text("image_url"),
    // Public, auth-free copy of the occasion image stored in the public bucket.
    // Holds the key relative to PUBLIC_OBJECT_SEARCH_PATHS (e.g. "occasions/123.jpg")
    // so the absolute /api/storage/public-objects/<path> URL can be rebuilt.
    imagePublicPath: text("image_public_path"),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    isFeatured: boolean("is_featured").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("occasions_workspace_slug_unique").on(t.workspaceOwnerId, t.slug),
    index("idx_occasions_workspace").on(t.workspaceOwnerId),
  ],
);

export type Occasion = typeof occasions.$inferSelect;
export type InsertOccasion = typeof occasions.$inferInsert;

// ---------------------------------------------------------------------------
// catalog_categories
// ---------------------------------------------------------------------------

export const catalogCategories = pgTable(
  "catalog_categories",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    imageUrl: text("image_url"),
    // Public, auth-free copy of the image stored in the public bucket. Holds the
    // key relative to PUBLIC_OBJECT_SEARCH_PATHS (e.g. "catalog_categories/123.jpg").
    imagePublicPath: text("image_public_path"),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    isFeatured: boolean("is_featured").notNull().default(false),
    // When true this category defines an upsell section on the website. Off by default.
    isUpsell: boolean("is_upsell").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("catalog_categories_workspace_slug_unique").on(t.workspaceOwnerId, t.slug),
    index("idx_catalog_categories_workspace").on(t.workspaceOwnerId),
  ],
);

export type CatalogCategory = typeof catalogCategories.$inferSelect;
export type InsertCatalogCategory = typeof catalogCategories.$inferInsert;

// ---------------------------------------------------------------------------
// catalog_brands
// ---------------------------------------------------------------------------

export const catalogBrands = pgTable(
  "catalog_brands",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    imageUrl: text("image_url"),
    // Public, auth-free copy of the image stored in the public bucket. Holds the
    // key relative to PUBLIC_OBJECT_SEARCH_PATHS (e.g. "catalog_brands/123.jpg").
    imagePublicPath: text("image_public_path"),
    // Hero/banner image shown at the top of the brand's storefront page.
    bannerImageUrl: text("banner_image_url"),
    // Public, auth-free copy of the banner image stored in the public bucket.
    // Holds the key relative to PUBLIC_OBJECT_SEARCH_PATHS
    // (e.g. "catalog_brands_banners/123.jpg").
    bannerPublicPath: text("banner_public_path"),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("catalog_brands_workspace_slug_unique").on(t.workspaceOwnerId, t.slug),
    index("idx_catalog_brands_workspace").on(t.workspaceOwnerId),
  ],
);

export type CatalogBrand = typeof catalogBrands.$inferSelect;
export type InsertCatalogBrand = typeof catalogBrands.$inferInsert;

// ---------------------------------------------------------------------------
// recipients
// ---------------------------------------------------------------------------

export const recipients = pgTable(
  "recipients",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    imageUrl: text("image_url"),
    // Public, auth-free copy of the image stored in the public bucket. Holds the
    // key relative to PUBLIC_OBJECT_SEARCH_PATHS (e.g. "recipients/123.jpg").
    imagePublicPath: text("image_public_path"),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("recipients_workspace_slug_unique").on(t.workspaceOwnerId, t.slug),
    index("idx_recipients_workspace").on(t.workspaceOwnerId),
  ],
);

export type Recipient = typeof recipients.$inferSelect;
export type InsertRecipient = typeof recipients.$inferInsert;

// ---------------------------------------------------------------------------
// occasion_city_availability — join table linking occasions to delivery_cities
// ---------------------------------------------------------------------------

export const occasionCityAvailability = pgTable(
  "occasion_city_availability",
  {
    id: serial("id").primaryKey(),
    occasionId: integer("occasion_id")
      .notNull()
      .references(() => occasions.id, { onDelete: "cascade" }),
    cityId: integer("city_id").notNull(),
    isEnabled: boolean("is_enabled").notNull().default(true),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("occasion_city_availability_unique").on(t.occasionId, t.cityId),
    index("idx_occasion_city_avail_city").on(t.cityId),
  ],
);

export type OccasionCityAvailability = typeof occasionCityAvailability.$inferSelect;

// ---------------------------------------------------------------------------
// catalog_category_city_availability
// ---------------------------------------------------------------------------

export const catalogCategoryCityAvailability = pgTable(
  "catalog_category_city_availability",
  {
    id: serial("id").primaryKey(),
    catalogCategoryId: integer("catalog_category_id")
      .notNull()
      .references(() => catalogCategories.id, { onDelete: "cascade" }),
    cityId: integer("city_id").notNull(),
    isEnabled: boolean("is_enabled").notNull().default(true),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("catalog_category_city_avail_unique").on(t.catalogCategoryId, t.cityId),
    index("idx_cat_category_city_avail_city").on(t.cityId),
  ],
);

export type CatalogCategoryCityAvailability = typeof catalogCategoryCityAvailability.$inferSelect;

// ---------------------------------------------------------------------------
// catalog_brand_city_availability
// ---------------------------------------------------------------------------

export const catalogBrandCityAvailability = pgTable(
  "catalog_brand_city_availability",
  {
    id: serial("id").primaryKey(),
    catalogBrandId: integer("catalog_brand_id")
      .notNull()
      .references(() => catalogBrands.id, { onDelete: "cascade" }),
    cityId: integer("city_id").notNull(),
    isEnabled: boolean("is_enabled").notNull().default(true),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("catalog_brand_city_avail_unique").on(t.catalogBrandId, t.cityId),
    index("idx_catalog_brand_city_avail_city").on(t.cityId),
  ],
);

export type CatalogBrandCityAvailability = typeof catalogBrandCityAvailability.$inferSelect;

// ---------------------------------------------------------------------------
// recipient_city_availability
// ---------------------------------------------------------------------------

export const recipientCityAvailability = pgTable(
  "recipient_city_availability",
  {
    id: serial("id").primaryKey(),
    recipientId: integer("recipient_id")
      .notNull()
      .references(() => recipients.id, { onDelete: "cascade" }),
    cityId: integer("city_id").notNull(),
    isEnabled: boolean("is_enabled").notNull().default(true),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("recipient_city_availability_unique").on(t.recipientId, t.cityId),
    index("idx_recipient_city_avail_city").on(t.cityId),
  ],
);

export type RecipientCityAvailability = typeof recipientCityAvailability.$inferSelect;
