import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const roleChangeAuditLog = pgTable(
  "role_change_audit_log",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    changedByUserId: text("changed_by_user_id").notNull(),
    targetMemberId: integer("target_member_id").notNull(),
    oldRole: text("old_role"),
    newRole: text("new_role"),
    oldCustomRoleId: integer("old_custom_role_id"),
    newCustomRoleId: integer("new_custom_role_id"),
    changedAt: timestamp("changed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("idx_rcal_workspace").on(t.workspaceOwnerId, t.changedAt)],
);

export type RoleChangeAuditLog = typeof roleChangeAuditLog.$inferSelect;
export type InsertRoleChangeAuditLog = typeof roleChangeAuditLog.$inferInsert;

export const baseItemAuditLog = pgTable(
  "base_item_audit_log",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    action: text("action").notNull(),
    userId: text("user_id").notNull(),
    affectedIds: jsonb("affected_ids")
      .notNull()
      .default(sql`'[]'::jsonb`),
    previousValues: jsonb("previous_values"),
    newValues: jsonb("new_values"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("idx_bial_workspace").on(t.workspaceOwnerId)],
);

export type BaseItemAuditLog = typeof baseItemAuditLog.$inferSelect;
export type InsertBaseItemAuditLog = typeof baseItemAuditLog.$inferInsert;
