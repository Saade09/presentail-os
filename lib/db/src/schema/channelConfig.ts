import {
  pgTable,
  serial,
  integer,
  text,
  boolean,
  timestamp,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { channels } from "./workspace";

// ---------------------------------------------------------------------------
// channel_image_configs — image dimension config per channel per image type
// ---------------------------------------------------------------------------

export const channelImageConfigs = pgTable(
  "channel_image_configs",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    channelId: integer("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    imageType: text("image_type").notNull(),
    widthPx: integer("width_px").notNull(),
    heightPx: integer("height_px").notNull(),
    outputFormat: text("output_format").notNull().default("jpeg"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("channel_image_configs_unique").on(t.channelId, t.imageType),
    index("idx_channel_image_configs_channel").on(
      t.workspaceOwnerId,
      t.channelId,
    ),
  ],
);

export type ChannelImageConfig = typeof channelImageConfigs.$inferSelect;
export type InsertChannelImageConfig = typeof channelImageConfigs.$inferInsert;

// ---------------------------------------------------------------------------
// channel_contacts — contacts (account managers, BDMs, etc.) per channel
// ---------------------------------------------------------------------------

export const channelContacts = pgTable(
  "channel_contacts",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    channelId: integer("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    firstName: text("first_name").notNull(),
    lastName: text("last_name"),
    email: text("email"),
    phone: text("phone"),
    title: text("title"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_channel_contacts_channel")
      .on(t.workspaceOwnerId, t.channelId)
      .where(sql`is_active = true`),
  ],
);

export type ChannelContact = typeof channelContacts.$inferSelect;
export type InsertChannelContact = typeof channelContacts.$inferInsert;
