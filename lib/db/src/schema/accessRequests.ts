import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  primaryKey,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { workspaceRoles, channels } from "./workspace";

export const failedAccessRequests = pgTable(
  "failed_access_requests",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    requesterEmail: text("requester_email").notNull(),
    requesterName: text("requester_name").notNull().default("Unknown"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
  },
  (t) => [index("idx_far_created").on(t.createdAt)],
);

export type FailedAccessRequest = typeof failedAccessRequests.$inferSelect;
export type InsertFailedAccessRequest =
  typeof failedAccessRequests.$inferInsert;

export const accessRequests = pgTable(
  "access_requests",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    requesterClerkId: text("requester_clerk_id").notNull(),
    requesterEmail: text("requester_email").notNull(),
    requesterName: text("requester_name").notNull().default(""),
    status: text("status").notNull().default("pending"),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("access_requests_workspace_clerk_id_unique").on(
      t.workspaceOwnerId,
      t.requesterClerkId,
    ),
    index("idx_access_requests_workspace_status").on(
      t.workspaceOwnerId,
      t.status,
      t.requestedAt,
    ),
  ],
);

export type AccessRequest = typeof accessRequests.$inferSelect;
export type InsertAccessRequest = typeof accessRequests.$inferInsert;

export const roleChannelAccess = pgTable(
  "role_channel_access",
  {
    roleId: integer("role_id")
      .notNull()
      .references(() => workspaceRoles.id, { onDelete: "cascade" }),
    channelId: integer("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.roleId, t.channelId] }),
    index("idx_role_channel_access_channel").on(t.channelId),
  ],
);

export type RoleChannelAccess = typeof roleChannelAccess.$inferSelect;
export type InsertRoleChannelAccess = typeof roleChannelAccess.$inferInsert;
