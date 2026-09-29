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
} from "drizzle-orm/pg-core";
import { locations, workspaceMembers } from "./workspace";
import { brands } from "./brands";
import { customers } from "./customers";
import { baseItems } from "./baseItems";

// ---------------------------------------------------------------------------
// workshop_sales — main offline/walk-in custom-order record
// ---------------------------------------------------------------------------

export const workshopSales = pgTable(
  "workshop_sales",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    orderNumber: text("order_number").notNull(),
    brandId: integer("brand_id").references(() => brands.id, {
      onDelete: "set null",
    }),
    locationId: integer("location_id").references(() => locations.id, {
      onDelete: "set null",
    }),
    countryId: integer("country_id"),
    saleType: text("sale_type").notNull().default("custom"),
    assignedFloristMemberId: integer("assigned_florist_member_id").references(
      () => workspaceMembers.id,
      { onDelete: "set null" },
    ),
    status: text("status").notNull().default("draft"),
    paymentStatus: text("payment_status").notNull().default("unpaid"),
    currency: text("currency").notNull().default("USD"),
    // Customer
    customerType: text("customer_type").notNull().default("guest"),
    customerId: integer("customer_id").references(() => customers.id, {
      onDelete: "set null",
    }),
    customerName: text("customer_name"),
    customerPhone: text("customer_phone"),
    customerEmail: text("customer_email"),
    // Customer request
    requestDescription: text("request_description"),
    occasion: text("occasion"),
    colors: jsonb("colors"),
    style: text("style"),
    budget: numeric("budget"),
    internalNotes: text("internal_notes"),
    // Totals
    subtotal: numeric("subtotal").notNull().default("0"),
    discountTotal: numeric("discount_total").notNull().default("0"),
    taxTotal: numeric("tax_total").notNull().default("0"),
    total: numeric("total").notNull().default("0"),
    amountPaid: numeric("amount_paid").notNull().default("0"),
    balanceDue: numeric("balance_due").notNull().default("0"),
    // COGS
    cogsAmount: numeric("cogs_amount"),
    cogsPercentage: numeric("cogs_percentage"),
    // Photos
    coverPhotoId: integer("cover_photo_id"),
    // Lifecycle
    cancellationReason: text("cancellation_reason"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledBy: text("cancelled_by"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdBy: text("created_by"),
    updatedBy: text("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
  },
  (t) => [
    index("idx_workshop_sales_workspace").on(t.workspaceOwnerId),
    uniqueIndex("idx_workshop_sales_order_number_unique").on(
      t.workspaceOwnerId,
      t.orderNumber,
    ),
  ],
);

export type WorkshopSale = typeof workshopSales.$inferSelect;
export type InsertWorkshopSale = typeof workshopSales.$inferInsert;

// ---------------------------------------------------------------------------
// workshop_sale_items — custom line items
// ---------------------------------------------------------------------------

export const workshopSaleItems = pgTable(
  "workshop_sale_items",
  {
    id: serial("id").primaryKey(),
    workshopSaleId: integer("workshop_sale_id")
      .notNull()
      .references(() => workshopSales.id, { onDelete: "cascade" }),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    quantity: numeric("quantity").notNull().default("1"),
    unitPrice: numeric("unit_price").notNull().default("0"),
    discount: numeric("discount").notNull().default("0"),
    discountType: text("discount_type").notNull().default("amount"),
    taxRate: numeric("tax_rate").notNull().default("0"),
    total: numeric("total").notNull().default("0"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("idx_workshop_sale_items_sale").on(t.workshopSaleId)],
);

export type WorkshopSaleItem = typeof workshopSaleItems.$inferSelect;
export type InsertWorkshopSaleItem = typeof workshopSaleItems.$inferInsert;

// ---------------------------------------------------------------------------
// workshop_sale_payments — payment records
// ---------------------------------------------------------------------------

export const workshopSalePayments = pgTable(
  "workshop_sale_payments",
  {
    id: serial("id").primaryKey(),
    workshopSaleId: integer("workshop_sale_id")
      .notNull()
      .references(() => workshopSales.id, { onDelete: "cascade" }),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    method: text("method").notNull().default("cash"),
    amount: numeric("amount").notNull().default("0"),
    currency: text("currency").notNull().default("USD"),
    reference: text("reference"),
    collectedBy: text("collected_by"),
    paidAt: timestamp("paid_at", { withTimezone: true }).notNull().defaultNow(),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("idx_workshop_sale_payments_sale").on(t.workshopSaleId)],
);

export type WorkshopSalePayment = typeof workshopSalePayments.$inferSelect;
export type InsertWorkshopSalePayment =
  typeof workshopSalePayments.$inferInsert;

// ---------------------------------------------------------------------------
// workshop_sale_photos — proof-of-work photos
// ---------------------------------------------------------------------------

export const workshopSalePhotos = pgTable(
  "workshop_sale_photos",
  {
    id: serial("id").primaryKey(),
    workshopSaleId: integer("workshop_sale_id")
      .notNull()
      .references(() => workshopSales.id, { onDelete: "cascade" }),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    url: text("url").notNull(),
    isCover: boolean("is_cover").notNull().default(false),
    caption: text("caption"),
    uploadedBy: text("uploaded_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("idx_workshop_sale_photos_sale").on(t.workshopSaleId)],
);

export type WorkshopSalePhoto = typeof workshopSalePhotos.$inferSelect;
export type InsertWorkshopSalePhoto = typeof workshopSalePhotos.$inferInsert;

// ---------------------------------------------------------------------------
// workshop_sale_activity_logs — audit / activity timeline
// ---------------------------------------------------------------------------

export const workshopSaleActivityLogs = pgTable(
  "workshop_sale_activity_logs",
  {
    id: serial("id").primaryKey(),
    workshopSaleId: integer("workshop_sale_id")
      .notNull()
      .references(() => workshopSales.id, { onDelete: "cascade" }),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    action: text("action").notNull(),
    description: text("description"),
    actorId: text("actor_id"),
    actorName: text("actor_name"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_workshop_sale_activity_sale").on(t.workshopSaleId, t.createdAt),
  ],
);

export type WorkshopSaleActivityLog =
  typeof workshopSaleActivityLogs.$inferSelect;
export type InsertWorkshopSaleActivityLog =
  typeof workshopSaleActivityLogs.$inferInsert;

// ---------------------------------------------------------------------------
// workshop_sale_inventory_usage — stub (no stock deduction in MVP)
// ---------------------------------------------------------------------------

export const workshopSaleInventoryUsage = pgTable(
  "workshop_sale_inventory_usage",
  {
    id: serial("id").primaryKey(),
    workshopSaleId: integer("workshop_sale_id")
      .notNull()
      .references(() => workshopSales.id, { onDelete: "cascade" }),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    baseItemId: integer("base_item_id").references(() => baseItems.id, {
      onDelete: "set null",
    }),
    itemName: text("item_name"),
    quantity: numeric("quantity").notNull().default("0"),
    unit: text("unit"),
    countryId: integer("country_id"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("idx_workshop_sale_inventory_sale").on(t.workshopSaleId)],
);

export type WorkshopSaleInventoryUsage =
  typeof workshopSaleInventoryUsage.$inferSelect;
export type InsertWorkshopSaleInventoryUsage =
  typeof workshopSaleInventoryUsage.$inferInsert;

// ---------------------------------------------------------------------------
// workshop_sale_counters — race-safe per-location-per-year sequence counter
// ---------------------------------------------------------------------------

export const workshopSaleCounters = pgTable(
  "workshop_sale_counters",
  {
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    locationCode: text("location_code").notNull(),
    year: integer("year").notNull(),
    seq: integer("seq").notNull().default(0),
  },
  (t) => [
    uniqueIndex("idx_workshop_sale_counters_pk").on(
      t.workspaceOwnerId,
      t.locationCode,
      t.year,
    ),
  ],
);

export type WorkshopSaleCounter = typeof workshopSaleCounters.$inferSelect;
export type InsertWorkshopSaleCounter =
  typeof workshopSaleCounters.$inferInsert;
