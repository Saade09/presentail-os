import {
  pgTable,
  serial,
  integer,
  text,
  boolean,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// webhook_endpoints
// ---------------------------------------------------------------------------

export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    name: text("name").notNull(),
    endpointUrl: text("endpoint_url").notNull(),
    subscribedEvents: jsonb("subscribed_events")
      .notNull()
      .default(sql`'[]'::jsonb`),
    signingSecret: text("signing_secret").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    lastDeliveryStatus: text("last_delivery_status"),
    lastDeliveryAt: timestamp("last_delivery_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_webhook_endpoints_owner").on(t.workspaceOwnerId),
  ],
);

export type WebhookEndpoint = typeof webhookEndpoints.$inferSelect;
export type InsertWebhookEndpoint = typeof webhookEndpoints.$inferInsert;

// ---------------------------------------------------------------------------
// webhook_deliveries
// ---------------------------------------------------------------------------

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: serial("id").primaryKey(),
    webhookEndpointId: integer("webhook_endpoint_id")
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: "cascade" }),
    event: text("event").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("pending"),
    responseStatus: integer("response_status"),
    responseBody: text("response_body"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_webhook_deliveries_endpoint").on(
      t.webhookEndpointId,
      t.createdAt,
    ),
    index("idx_webhook_deliveries_retry")
      .on(t.nextRetryAt)
      .where(sql`${t.status} = 'pending_retry'`),
    index("idx_webhook_deliveries_retention")
      .on(t.createdAt)
      .where(sql`${t.status} IN ('delivered', 'failed')`),
  ],
);

export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;
export type InsertWebhookDelivery = typeof webhookDeliveries.$inferInsert;
