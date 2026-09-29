import { sql } from "drizzle-orm";
import { pgTable, serial, integer, text, timestamp, decimal, boolean, date, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";

export const customers = pgTable(
  "customers",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    firstName: text("first_name"),
    lastName: text("last_name"),
    email: text("email"),
    phone: text("phone"),
    country: text("country"),
    city: text("city"),
    notes: text("notes"),
    source: text("source"),
    totalOrders: integer("total_orders").notNull().default(0),
    totalSpent: decimal("total_spent", { precision: 14, scale: 2 }).notNull().default("0"),
    lastOrderAt: timestamp("last_order_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    websiteUserId: text("website_user_id"),
    dateOfBirth: date("date_of_birth"),
    gender: text("gender"),
    marketingOptIn: boolean("marketing_opt_in").notNull().default(false),
    savedAddresses: jsonb("saved_addresses").default(sql`'[]'::jsonb`),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("customers_workspace_email_unique")
      .on(t.workspaceOwnerId, t.email)
      .where(sql`${t.email} IS NOT NULL`),
    index("idx_customers_workspace").on(t.workspaceOwnerId),
    index("idx_customers_workspace_phone")
      .on(t.workspaceOwnerId, t.phone)
      .where(sql`${t.phone} IS NOT NULL`),
    uniqueIndex("customers_workspace_website_user_id_unique")
      .on(t.workspaceOwnerId, t.websiteUserId)
      .where(sql`${t.websiteUserId} IS NOT NULL`),
  ],
);

export type Customer = typeof customers.$inferSelect;
export type InsertCustomer = typeof customers.$inferInsert;
