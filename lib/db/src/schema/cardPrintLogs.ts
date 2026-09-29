import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Card print log — one row per successful card print sent from the Order Detail
 * dialog. Records who printed, from which branch, for which order.
 */
export const cardPrintLogs = pgTable("card_print_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceOwnerId: text("workspace_owner_id").notNull(),
  orderId: text("order_id").notNull(),
  realOrderId: uuid("real_order_id"),
  userId: text("user_id").notNull(),
  userDisplayName: text("user_display_name").notNull(),
  location: text("location").notNull(),
  shopName: text("shop_name").notNull(),
  printedAt: timestamp("printed_at", { withTimezone: true }).notNull().defaultNow(),
});

export type CardPrintLog = typeof cardPrintLogs.$inferSelect;
export type InsertCardPrintLog = typeof cardPrintLogs.$inferInsert;
