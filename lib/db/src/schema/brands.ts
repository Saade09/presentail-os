import {
  pgTable,
  serial,
  integer,
  text,
  boolean,
  timestamp,
  numeric,
  unique,
  index,
  customType,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { locations } from "./workspace";

// ---------------------------------------------------------------------------
// Custom types
// ---------------------------------------------------------------------------

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

// ---------------------------------------------------------------------------
// brands
// ---------------------------------------------------------------------------

export const brands = pgTable(
  "brands",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    logoData: bytea("logo_data"),
    logoMime: text("logo_mime"),
    description: text("description"),
    targetCogs: numeric("target_cogs", { precision: 5, scale: 2 }),
    cardMessageData: bytea("card_message_data"),
    cardMessageMime: text("card_message_mime"),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
  },
  (t) => [
    index("idx_brands_workspace").on(t.workspaceOwnerId),
  ],
);

export type Brand = typeof brands.$inferSelect;
export type InsertBrand = typeof brands.$inferInsert;

// ---------------------------------------------------------------------------
// brand_cover_photos
// ---------------------------------------------------------------------------

export const brandCoverPhotos = pgTable(
  "brand_cover_photos",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    brandId: integer("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    photoData: bytea("photo_data").notNull(),
    photoMime: text("photo_mime").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_cover_photos_brand").on(t.workspaceOwnerId, t.brandId),
  ],
);

export type BrandCoverPhoto = typeof brandCoverPhotos.$inferSelect;
export type InsertBrandCoverPhoto = typeof brandCoverPhotos.$inferInsert;

// ---------------------------------------------------------------------------
// brand_logos
// ---------------------------------------------------------------------------

export const brandLogos = pgTable(
  "brand_logos",
  {
    id: serial("id").primaryKey(),
    brandId: integer("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    label: text("label"),
    logoData: bytea("logo_data").notNull(),
    logoMime: text("logo_mime").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_brand_logos_brand")
      .on(t.workspaceOwnerId, t.brandId)
      .where(sql`${t.deletedAt} IS NULL`),
  ],
);

export type BrandLogo = typeof brandLogos.$inferSelect;
export type InsertBrandLogo = typeof brandLogos.$inferInsert;

// ---------------------------------------------------------------------------
// location_brands
// ---------------------------------------------------------------------------

export const locationBrands = pgTable(
  "location_brands",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    locationId: integer("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    brandId: integer("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    actorEmail: text("actor_email"),
  },
  (t) => [
    unique().on(t.locationId, t.brandId),
    index("idx_location_brands_location").on(t.workspaceOwnerId, t.locationId),
  ],
);

export type LocationBrand = typeof locationBrands.$inferSelect;
export type InsertLocationBrand = typeof locationBrands.$inferInsert;
