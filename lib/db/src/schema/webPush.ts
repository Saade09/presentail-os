import {
  pgTable,
  serial,
  text,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// web_push_subscriptions — browser Web Push (VAPID) subscriptions for
// dashboard users. One row per browser endpoint; workspace-scoped so
// order alerts fan out to every subscribed member of the workspace.
export const webPushSubscriptions = pgTable(
  "web_push_subscriptions",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    userId: text("user_id").notNull(),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("idx_web_push_subscriptions_endpoint").on(t.endpoint),
    index("idx_web_push_subscriptions_workspace").on(t.workspaceOwnerId),
  ],
);
