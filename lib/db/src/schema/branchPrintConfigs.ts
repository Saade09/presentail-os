import { pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Branch print configurations — maps a branch/shop name to the Make.com
 * machineId + printerId pair used by the card-message print flow.
 * Replaces the legacy CARD_PRINT_BRANCH_CONFIG env variable.
 */
export const branchPrintConfigs = pgTable(
  "branch_print_configs",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    name: text("name").notNull(),
    machineId: text("machine_id").notNull(),
    printerId: text("printer_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("idx_branch_print_configs_workspace_name").on(t.workspaceOwnerId, t.name)],
);

export type BranchPrintConfig = typeof branchPrintConfigs.$inferSelect;
export type InsertBranchPrintConfig = typeof branchPrintConfigs.$inferInsert;
