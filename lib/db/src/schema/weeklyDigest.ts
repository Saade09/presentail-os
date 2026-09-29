import {
  pgTable,
  text,
  boolean,
  jsonb,
  timestamp,
  serial,
  date,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Per-workspace Weekly Sales Digest settings.
 * The workspace owner always receives the digest when enabled;
 * extra_recipients holds additional email addresses (JSON array of strings).
 */
export const weeklyDigestSettings = pgTable("weekly_digest_settings", {
  workspaceOwnerId: text("workspace_owner_id").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  extraRecipients: jsonb("extra_recipients").notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Idempotency ledger for weekly digest sends — one row per workspace per
 * ISO week (identified by its Monday date). The unique index is the guard
 * that prevents double-sends for the same week.
 */
export const weeklyDigestSends = pgTable(
  "weekly_digest_sends",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    weekStart: date("week_start").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).defaultNow().notNull(),
    recipients: jsonb("recipients"),
  },
  (t) => [
    uniqueIndex("idx_weekly_digest_sends_owner_week").on(t.workspaceOwnerId, t.weekStart),
  ],
);

export const insertWeeklyDigestSettingsSchema = createInsertSchema(weeklyDigestSettings);
export type WeeklyDigestSettingsRow = typeof weeklyDigestSettings.$inferSelect;
export type InsertWeeklyDigestSettings = z.infer<typeof insertWeeklyDigestSettingsSchema>;
export type WeeklyDigestSendRow = typeof weeklyDigestSends.$inferSelect;
