import {
  index,
  integer,
  jsonb,
  serial,
  text,
  timestamp,
  unique,
  pgTable,
} from "drizzle-orm/pg-core";

export const recipeBenchmarkRuns = pgTable(
  "recipe_benchmark_runs",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    createdByUserId: text("created_by_user_id").notNull(),
    createdByEmail: text("created_by_email"),
    status: text("status").notNull(),
    engineVersion: text("engine_version").notNull(),
    // Immutable revision snapshot for engine/rules/aliases/metadata/prompt/model.
    versionManifest: jsonb("version_manifest").notNull().default({}),
    sampleDefinition: jsonb("sample_definition").notNull(),
    sampleComposition: jsonb("sample_composition").notNull(),
    exclusions: jsonb("exclusions").notNull(),
    metrics: jsonb("metrics").notNull(),
    limitations: jsonb("limitations").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("idx_recipe_benchmark_runs_workspace").on(t.workspaceOwnerId, t.createdAt),
  ],
);

export const recipeBenchmarkResults = pgTable(
  "recipe_benchmark_results",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    // Snapshot records intentionally do not cascade away when a live product is
    // later deleted. productId is retained as a historical identifier only.
    runId: integer("run_id").notNull().references(() => recipeBenchmarkRuns.id),
    productId: integer("product_id").notNull(),
    productSnapshot: jsonb("product_snapshot").notNull(),
    approvedRecipe: jsonb("approved_recipe").notNull(),
    generatedSuggestion: jsonb("generated_suggestion").notNull(),
    evidenceUsed: jsonb("evidence_used").notNull(),
    comparison: jsonb("comparison").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("recipe_benchmark_results_run_product_unique").on(t.runId, t.productId),
    index("idx_recipe_benchmark_results_workspace").on(t.workspaceOwnerId, t.createdAt),
  ],
);

export type RecipeBenchmarkRun = typeof recipeBenchmarkRuns.$inferSelect;
export type RecipeBenchmarkResult = typeof recipeBenchmarkResults.$inferSelect;