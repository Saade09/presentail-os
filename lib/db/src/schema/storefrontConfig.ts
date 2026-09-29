import { pgTable, integer, text, timestamp } from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// storefront_config — global singleton pointing at the workspace that powers
// the public storefront (homepage banners, etc.). Exactly one row (id = 1).
//
// The public storefront endpoint must resolve "which workspace" BEFORE any
// workspace context exists, so this is a single global pointer rather than a
// per-workspace `workspace_settings` row. `workspace_owner_id` is null when no
// workspace is connected; the storefront endpoint then falls back to the
// STOREFRONT_WORKSPACE_OWNER_ID env var.
// ---------------------------------------------------------------------------

export const storefrontConfig = pgTable("storefront_config", {
  id: integer("id").primaryKey().default(1),
  workspaceOwnerId: text("workspace_owner_id"),
  updatedBy: text("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export type StorefrontConfig = typeof storefrontConfig.$inferSelect;
export type InsertStorefrontConfig = typeof storefrontConfig.$inferInsert;
