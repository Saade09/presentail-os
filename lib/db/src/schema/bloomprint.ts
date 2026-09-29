import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { recipeSuggestions } from "./recipeIntelligence";
import { products } from "./products";

/**
 * Bloomprint only stores the temporary, creative work around a normal product
 * and recipe. The final catalog product continues to live in products and its
 * buildable composition in product_recipes.
 */
export const bloomprintStyleProfiles = pgTable(
  "bloomprint_style_profiles",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    name: text("name").notNull(),
    version: integer("version").notNull().default(1),
    prompt: text("prompt").notNull(),
    referenceImagePaths: jsonb("reference_image_paths")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    isDefault: boolean("is_default").notNull().default(false),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("bloomprint_style_profiles_workspace_name_version_unique").on(
      t.workspaceOwnerId,
      t.name,
      t.version,
    ),
    index("idx_bloomprint_style_profiles_workspace").on(t.workspaceOwnerId, t.createdAt),
  ],
);

export const bloomprintDrafts = pgTable(
  "bloomprint_drafts",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    inspirationImagePath: text("inspiration_image_path").notNull(),
    analysis: jsonb("analysis").notNull().default(sql`'{}'::jsonb`),
    name: text("name"),
    description: text("description"),
    priceUsd: numeric("price_usd", { precision: 10, scale: 2 }),
    priceAed: numeric("price_aed", { precision: 10, scale: 2 }),
    boxColor: text("box_color").notNull().default("black"),
    substitutionNotes: text("substitution_notes"),
    status: text("status").notNull().default("draft"),
    styleProfileId: integer("style_profile_id").references(() => bloomprintStyleProfiles.id, {
      onDelete: "set null",
    }),
    recipeSuggestionId: integer("recipe_suggestion_id").references(() => recipeSuggestions.id, {
      onDelete: "set null",
    }),
    generatedImagePath: text("generated_image_path"),
    generatedImagePublicPath: text("generated_image_public_path"),
    approvedProductId: integer("approved_product_id").references(() => products.id, {
      onDelete: "set null",
    }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_bloomprint_drafts_workspace_status").on(
      t.workspaceOwnerId,
      t.status,
      t.createdAt,
    ),
    check(
      "bloomprint_drafts_status_check",
      sql`${t.status} IN ('draft', 'analysis_failed', 'rendered', 'render_failed', 'approved', 'discarded')`,
    ),
  ],
);

export const bloomprintRenderAttempts = pgTable(
  "bloomprint_render_attempts",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    draftId: integer("draft_id")
      .notNull()
      .references(() => bloomprintDrafts.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("started"),
    model: text("model").notNull().default("gpt-image-1"),
    generationMode: text("generation_mode").notNull().default("text_only"),
    referenceImageCount: integer("reference_image_count").notNull().default(0),
    prompt: text("prompt").notNull(),
    outputImagePath: text("output_image_path"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("idx_bloomprint_render_attempts_draft").on(
      t.workspaceOwnerId,
      t.draftId,
      t.createdAt,
    ),
    check(
      "bloomprint_render_attempts_status_check",
      sql`${t.status} IN ('started', 'succeeded', 'failed')`,
    ),
  ],
);

export type BloomprintDraft = typeof bloomprintDrafts.$inferSelect;
export type BloomprintStyleProfile = typeof bloomprintStyleProfiles.$inferSelect;
export type BloomprintRenderAttempt = typeof bloomprintRenderAttempts.$inferSelect;