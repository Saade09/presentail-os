import {
  pgTable,
  serial,
  integer,
  text,
  boolean,
  timestamp,
  date,
  numeric,
  primaryKey,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// delivery_country_settings — per-workspace delivery activation per country
// ---------------------------------------------------------------------------

export const deliveryCountrySettings = pgTable(
  "delivery_country_settings",
  {
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    countryCode: text("country_code").notNull(),
    deliveryActive: boolean("delivery_active").notNull().default(false),
    deliverySortOrder: integer("delivery_sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workspaceOwnerId, t.countryCode] })],
);

export type DeliveryCountrySetting = typeof deliveryCountrySettings.$inferSelect;
export type InsertDeliveryCountrySetting =
  typeof deliveryCountrySettings.$inferInsert;

// ---------------------------------------------------------------------------
// delivery_cities — per-workspace delivery cities per country
// ---------------------------------------------------------------------------

export const deliveryCities = pgTable(
  "delivery_cities",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    countryCode: text("country_code").notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    deliveryTimezone: text("delivery_timezone").notNull().default("UTC"),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Delivery pricing columns added after initial release
    deliveryFee: numeric("delivery_fee", { precision: 10, scale: 2 })
      .notNull()
      .default("0"),
    freeDeliveryEnabled: boolean("free_delivery_enabled")
      .notNull()
      .default(false),
    freeDeliveryThreshold: numeric("free_delivery_threshold", {
      precision: 10,
      scale: 2,
    }),
    expressDeliveryEnabled: boolean("express_delivery_enabled")
      .notNull()
      .default(false),
    expressDeliveryFee: numeric("express_delivery_fee", {
      precision: 10,
      scale: 2,
    }),
    expressDeliveryCutoffTime: text("express_delivery_cutoff_time"),
    // Availability and slot-cap columns added in a later release
    standardDeliveryAvailable: boolean("standard_delivery_available")
      .notNull()
      .default(true),
    expressDeliveryAvailable: boolean("express_delivery_available")
      .notNull()
      .default(false),
    expressFreeDeliveryThreshold: numeric("express_free_delivery_threshold", {
      precision: 10,
      scale: 2,
    }),
    cutoffTime: text("cutoff_time"),
    maxStandardOrdersPerSlot: integer("max_standard_orders_per_slot"),
    maxExpressOrdersPerSlot: integer("max_express_orders_per_slot"),
  },
  (t) => [
    uniqueIndex("idx_delivery_cities_owner_country_slug").on(
      t.workspaceOwnerId,
      t.countryCode,
      t.slug,
    ),
    index("idx_delivery_cities_owner_country").on(
      t.workspaceOwnerId,
      t.countryCode,
    ),
    index("idx_delivery_cities_owner_country_active").on(
      t.workspaceOwnerId,
      t.countryCode,
      t.isActive,
    ),
  ],
);

export type DeliveryCity = typeof deliveryCities.$inferSelect;
export type InsertDeliveryCity = typeof deliveryCities.$inferInsert;

// ---------------------------------------------------------------------------
// district_delivery_settings — express delivery config per city
// ---------------------------------------------------------------------------

export const districtDeliverySettings = pgTable(
  "district_delivery_settings",
  {
    cityId: integer("city_id")
      .primaryKey()
      .references(() => deliveryCities.id, { onDelete: "cascade" }),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    expressStartTime: text("express_start_time"),
    expressEndTime: text("express_end_time"),
    expressMinPrepMinutes: integer("express_min_prep_minutes"),
    expressDailyCapacity: integer("express_daily_capacity"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Extended columns added after initial release
    expressEnabled: boolean("express_enabled").notNull().default(true),
    expressFee: numeric("express_fee", { precision: 10, scale: 2 }),
    expressCutoffTime: text("express_cutoff_time"),
    // Persistent marker: true once default weekly slots have been seeded for
    // this city. Prevents the startup seed from ever re-introducing defaults
    // for a city that has already been configured (or intentionally emptied).
    weeklySlotsSeeded: boolean("weekly_slots_seeded").notNull().default(false),
  },
  (t) => [index("idx_dds_owner").on(t.workspaceOwnerId)],
);

export type DistrictDeliverySetting =
  typeof districtDeliverySettings.$inferSelect;
export type InsertDistrictDeliverySetting =
  typeof districtDeliverySettings.$inferInsert;

// ---------------------------------------------------------------------------
// district_weekly_delivery_slots — per-day-of-week slots for each city
// ---------------------------------------------------------------------------

// Natural identity is city + weekday + normalized delivery type + normalized
// start/end time. initDb installs a trigger until historical duplicates can be
// reviewed and a declarative unique index can safely replace it.
export const districtWeeklyDeliverySlots = pgTable(
  "district_weekly_delivery_slots",
  {
    id: serial("id").primaryKey(),
    cityId: integer("city_id")
      .notNull()
      .references(() => deliveryCities.id, { onDelete: "cascade" }),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    dayOfWeek: integer("day_of_week").notNull(),
    label: text("label").notNull().default(""),
    startTime: text("start_time").notNull(),
    endTime: text("end_time").notNull(),
    isEnabled: boolean("is_enabled").notNull().default(true),
    feeOverride: numeric("fee_override", { precision: 10, scale: 2 }),
    cutoffTime: text("cutoff_time"),
    capacity: integer("capacity"),
    internalNote: text("internal_note"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Extended columns added after initial release
    deliveryType: text("delivery_type").notNull().default("standard"),
    sameDayAvailable: boolean("same_day_available").notNull().default(false),
    nextDayAvailable: boolean("next_day_available").notNull().default(true),
  },
  (t) => [
    index("idx_dwds_city_day").on(t.cityId, t.dayOfWeek),
    index("idx_dwds_owner").on(t.workspaceOwnerId),
  ],
);

export type DistrictWeeklyDeliverySlot =
  typeof districtWeeklyDeliverySlots.$inferSelect;
export type InsertDistrictWeeklyDeliverySlot =
  typeof districtWeeklyDeliverySlots.$inferInsert;

// ---------------------------------------------------------------------------
// district_special_date_overrides — date/range overrides for a city/country
// ---------------------------------------------------------------------------

export const districtSpecialDateOverrides = pgTable(
  "district_special_date_overrides",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    cityId: integer("city_id").references(() => deliveryCities.id, {
      onDelete: "cascade",
    }),
    countryCode: text("country_code"),
    name: text("name").notNull(),
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    overrideType: text("override_type")
      .notNull()
      .default("replace_regular_schedule"),
    expressEnabled: boolean("express_enabled").notNull().default(false),
    expressStartTime: text("express_start_time"),
    expressEndTime: text("express_end_time"),
    expressCutoffTime: text("express_cutoff_time"),
    expressFee: numeric("express_fee", { precision: 10, scale: 2 }),
    expressMinPrepMinutes: integer("express_min_prep_minutes"),
    expressDailyCapacity: integer("express_daily_capacity"),
    internalNote: text("internal_note"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_dsdo_owner").on(t.workspaceOwnerId),
    index("idx_dsdo_city")
      .on(t.cityId)
      .where(sql`city_id IS NOT NULL`),
    index("idx_dsdo_dates").on(t.workspaceOwnerId, t.startDate, t.endDate),
  ],
);

export type DistrictSpecialDateOverride =
  typeof districtSpecialDateOverrides.$inferSelect;
export type InsertDistrictSpecialDateOverride =
  typeof districtSpecialDateOverrides.$inferInsert;

// ---------------------------------------------------------------------------
// district_special_date_override_slots — time slots for a special date override
// ---------------------------------------------------------------------------

export const districtSpecialDateOverrideSlots = pgTable(
  "district_special_date_override_slots",
  {
    id: serial("id").primaryKey(),
    overrideId: integer("override_id")
      .notNull()
      .references(() => districtSpecialDateOverrides.id, {
        onDelete: "cascade",
      }),
    label: text("label").notNull().default(""),
    startTime: text("start_time").notNull(),
    endTime: text("end_time").notNull(),
    isEnabled: boolean("is_enabled").notNull().default(true),
    feeOverride: numeric("fee_override", { precision: 10, scale: 2 }),
    cutoffTime: text("cutoff_time"),
    capacity: integer("capacity"),
    internalNote: text("internal_note"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Extended columns added after initial release
    deliveryType: text("delivery_type").notNull().default("standard"),
    sameDayAvailable: boolean("same_day_available").notNull().default(false),
    nextDayAvailable: boolean("next_day_available").notNull().default(true),
  },
  (t) => [index("idx_dsdos_override").on(t.overrideId)],
);

export type DistrictSpecialDateOverrideSlot =
  typeof districtSpecialDateOverrideSlots.$inferSelect;
export type InsertDistrictSpecialDateOverrideSlot =
  typeof districtSpecialDateOverrideSlots.$inferInsert;

// ---------------------------------------------------------------------------
// delivery_settings — workspace-level delivery feature toggles and global fees
// ---------------------------------------------------------------------------

export const deliverySettings = pgTable("delivery_settings", {
  workspaceOwnerId: text("workspace_owner_id").primaryKey(),
  standardDeliveryActive: boolean("standard_delivery_active")
    .notNull()
    .default(true),
  expressDeliveryActive: boolean("express_delivery_active")
    .notNull()
    .default(false),
  sameDayExpressActive: boolean("same_day_express_active")
    .notNull()
    .default(false),
  globalStandardFee: numeric("global_standard_fee", {
    precision: 10,
    scale: 2,
  }),
  globalExpressFee: numeric("global_express_fee", { precision: 10, scale: 2 }),
  globalFreeDeliveryThreshold: numeric("global_free_delivery_threshold", {
    precision: 10,
    scale: 2,
  }),
  globalExpressFreeThreshold: numeric("global_express_free_threshold", {
    precision: 10,
    scale: 2,
  }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type DeliverySetting = typeof deliverySettings.$inferSelect;
export type InsertDeliverySetting = typeof deliverySettings.$inferInsert;
