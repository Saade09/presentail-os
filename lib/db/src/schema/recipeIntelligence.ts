import {
  check,
  boolean,
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
import { products } from "./products";
import { baseItems } from "./baseItems";

/**
 * Recipe intelligence records deliberately live outside product_recipes.
 *
 * A suggestion is a versioned proposal only. It is never the live recipe used
 * for COGS or inventory; a later, explicitly-reviewed workflow may choose to
 * copy it into product_recipes.
 */
export const recipeSuggestions = pgTable(
  "recipe_suggestions",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    productId: integer("product_id").references(() => products.id, {
      onDelete: "set null",
    }),
    version: integer("version").notNull(),
    // Snapshots engine, rule, alias, metadata, prompt, and model revisions used
    // to generate this proposal, without coupling it to mutable live records.
    versionManifest: jsonb("version_manifest").notNull().default(sql`'{}'::jsonb`),
    status: text("status").notNull().default("draft"),
    generationContext: jsonb("generation_context").notNull().default(sql`'{}'::jsonb`),
    confidence: numeric("confidence", { precision: 5, scale: 4 }),
    rationale: text("rationale"),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("recipe_suggestions_workspace_product_version_unique").on(
      t.workspaceOwnerId,
      t.productId,
      t.version,
    ),
    unique("recipe_suggestions_workspace_id_unique").on(t.workspaceOwnerId, t.id),
    index("idx_recipe_suggestions_workspace_product").on(
      t.workspaceOwnerId,
      t.productId,
      t.createdAt,
    ),
    check(
      "recipe_suggestions_status_check",
      sql`${t.status} IN ('draft', 'generated', 'under_review', 'approved', 'rejected', 'superseded')`,
    ),
  ],
);

export const recipeSuggestionLines = pgTable(
  "recipe_suggestion_lines",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    suggestionId: integer("suggestion_id")
      .notNull()
      .references(() => recipeSuggestions.id, { onDelete: "cascade" }),
    lineOrder: integer("line_order").notNull().default(0),
    proposedBaseItemId: integer("proposed_base_item_id").references(() => baseItems.id, {
      onDelete: "set null",
    }),
    proposedBaseItemName: text("proposed_base_item_name"),
    proposedBaseItemCode: text("proposed_base_item_code"),
    extractedRequirement: text("extracted_requirement"),
    unitContext: text("unit_context"),
    sourceEvidence: jsonb("source_evidence").notNull().default(sql`'[]'::jsonb`),
    matchConfidence: text("match_confidence").notNull().default("no_match"),
    quantity: numeric("quantity").notNull().default("1"),
    confidence: numeric("confidence", { precision: 5, scale: 4 }),
    sourceType: text("source_type").notNull(),
    sourceRuleId: integer("source_rule_id").references(() => recipeRules.id, {
      onDelete: "set null",
    }),
    rationale: text("rationale"),
    resolutionStatus: text("resolution_status").notNull().default("unresolved"),
    exclusionReason: text("exclusion_reason"),
    exclusionAcknowledged: boolean("exclusion_acknowledged").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_recipe_suggestion_lines_suggestion").on(
      t.workspaceOwnerId,
      t.suggestionId,
      t.lineOrder,
    ),
    check("recipe_suggestion_lines_quantity_check", sql`${t.quantity} > 0`),
    check(
      "recipe_suggestion_lines_match_confidence_check",
      sql`${t.matchConfidence} IN ('high', 'medium', 'low', 'no_match')`,
    ),
    check(
      "recipe_suggestion_lines_resolution_status_check",
      sql`${t.resolutionStatus} IN ('resolved', 'unresolved', 'excluded')`,
    ),
  ],
);

/** Explicit action log for generation and human review of a suggestion version. */
export const recipeSuggestionActions = pgTable(
  "recipe_suggestion_actions",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    suggestionId: integer("suggestion_id")
      .notNull()
      .references(() => recipeSuggestions.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    actorUserId: text("actor_user_id"),
    note: text("note"),
    context: jsonb("context").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_recipe_suggestion_actions_suggestion").on(
      t.workspaceOwnerId,
      t.suggestionId,
      t.createdAt,
    ),
    check(
      "recipe_suggestion_actions_action_check",
      sql`${t.action} IN ('generated', 'submitted_for_review', 'corrected', 'approved', 'rejected', 'superseded', 'commented')`,
    ),
  ],
);

/**
 * Candidate rules are inactive until explicitly approved. Definitions are
 * structured JSON to make both deterministic and later learned rules auditable.
 */
export const recipeRules = pgTable(
  "recipe_rules",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    ruleKey: text("rule_key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    ruleType: text("rule_type").notNull().default("hidden_item"),
    source: text("source").notNull().default("discovered"),
    status: text("status").notNull().default("candidate"),
    definition: jsonb("definition").notNull().default(sql`'{}'::jsonb`),
    confidence: numeric("confidence", { precision: 5, scale: 4 }),
    createdByUserId: text("created_by_user_id"),
    decidedByUserId: text("decided_by_user_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("recipe_rules_workspace_key_unique").on(t.workspaceOwnerId, t.ruleKey),
    unique("recipe_rules_workspace_id_unique").on(t.workspaceOwnerId, t.id),
    index("idx_recipe_rules_workspace_status").on(t.workspaceOwnerId, t.status, t.createdAt),
    check(
      "recipe_rules_status_check",
      sql`${t.status} IN ('candidate', 'approved', 'rejected', 'inactive')`,
    ),
    check(
      "recipe_rules_source_check",
      sql`${t.source} IN ('deterministic', 'discovered', 'manual')`,
    ),
  ],
);

export const recipeRuleEvidence = pgTable(
  "recipe_rule_evidence",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    ruleId: integer("rule_id")
      .notNull()
      .references(() => recipeRules.id, { onDelete: "cascade" }),
    evidenceType: text("evidence_type").notNull(),
    productId: integer("product_id").references(() => products.id, {
      onDelete: "set null",
    }),
    baseItemId: integer("base_item_id").references(() => baseItems.id, {
      onDelete: "set null",
    }),
    productNameSnapshot: text("product_name_snapshot"),
    baseItemNameSnapshot: text("base_item_name_snapshot"),
    details: jsonb("details").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_recipe_rule_evidence_rule").on(t.workspaceOwnerId, t.ruleId, t.createdAt),
    check(
      "recipe_rule_evidence_type_check",
      sql`${t.evidenceType} IN ('supporting', 'conflicting', 'observation')`,
    ),
  ],
);

/** Append-only lifecycle decisions, including edits, for a rule. */
export const recipeRuleActions = pgTable(
  "recipe_rule_actions",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    ruleId: integer("rule_id")
      .notNull()
      .references(() => recipeRules.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    actorUserId: text("actor_user_id"),
    previousState: jsonb("previous_state").notNull().default(sql`'{}'::jsonb`),
    nextState: jsonb("next_state").notNull().default(sql`'{}'::jsonb`),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_recipe_rule_actions_rule").on(t.workspaceOwnerId, t.ruleId, t.createdAt),
    check(
      "recipe_rule_actions_action_check",
      sql`${t.action} IN ('seeded', 'discovered', 'approved', 'rejected', 'edited', 'deactivated', 'rolled_back')`,
    ),
  ],
);

export type RecipeSuggestion = typeof recipeSuggestions.$inferSelect;
export type RecipeSuggestionLine = typeof recipeSuggestionLines.$inferSelect;
export type RecipeSuggestionAction = typeof recipeSuggestionActions.$inferSelect;
export type RecipeRule = typeof recipeRules.$inferSelect;
export type RecipeRuleEvidence = typeof recipeRuleEvidence.$inferSelect;
export type RecipeRuleAction = typeof recipeRuleActions.$inferSelect;

/**
 * Immutable line-level correction ledger. JSON snapshots intentionally retain
 * names, requirements, product/format context, and evidence as they existed at
 * correction time, even when operational records later change.
 */
export const recipeSuggestionCorrections = pgTable(
  "recipe_suggestion_corrections",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    suggestionId: integer("suggestion_id").notNull(),
    lineId: integer("line_id"),
    correctionType: text("correction_type").notNull(),
    extractionErrorType: text("extraction_error_type"),
    originalStructuredRequirement: jsonb("original_structured_requirement").notNull().default(sql`'{}'::jsonb`),
    correctedStructuredRequirement: jsonb("corrected_structured_requirement").notNull().default(sql`'{}'::jsonb`),
    originalLine: jsonb("original_line").notNull().default(sql`'{}'::jsonb`),
    correctedLine: jsonb("corrected_line").notNull().default(sql`'{}'::jsonb`),
    productContext: jsonb("product_context").notNull().default(sql`'{}'::jsonb`),
    formatContext: jsonb("format_context").notNull().default(sql`'{}'::jsonb`),
    reason: text("reason").notNull(),
    note: text("note"),
    actorUserId: text("actor_user_id"),
    intent: text("intent").notNull().default("product_only"),
    proposedScope: text("proposed_scope"),
    candidateAliasId: integer("candidate_alias_id"),
    candidateRuleId: integer("candidate_rule_id"),
    candidateMetadataId: integer("candidate_metadata_id"),
    beforeEvidence: jsonb("before_evidence").notNull().default(sql`'[]'::jsonb`),
    afterEvidence: jsonb("after_evidence").notNull().default(sql`'[]'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_recipe_suggestion_corrections_suggestion").on(t.workspaceOwnerId, t.suggestionId, t.createdAt),
    index("idx_recipe_suggestion_corrections_type").on(t.workspaceOwnerId, t.correctionType, t.createdAt),
    check(
      "recipe_suggestion_corrections_type_check",
      sql`${t.correctionType} IN ('replace_base_item', 'change_quantity', 'add_line', 'remove_line', 'correct_requirement', 'preserve_unresolved')`,
    ),
    check(
      "recipe_suggestion_corrections_intent_check",
      sql`${t.intent} IN ('product_only', 'propose_learning')`,
    ),
  ],
);

export type RecipeSuggestionCorrection = typeof recipeSuggestionCorrections.$inferSelect;