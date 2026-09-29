import {
  pgTable,
  text,
  timestamp,
  jsonb,
  uuid,
  integer,
  bigserial,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { contacts } from "./contacts";

/**
 * Audiences — marketing segmentation layer above Contacts.
 *
 * Two kinds:
 *  - dynamic: membership defined by a versioned rule tree (see `rules`),
 *    re-evaluated on a schedule; counts cached on the row.
 *  - static: membership is an explicit list in `audience_members` and never
 *    changes automatically.
 *
 * Rule trees are stored as jsonb with a `rules_schema_version` so the shape
 * can evolve. Every rules change also appends a row to
 * `audience_rule_versions` for auditability.
 */
export const audiences = pgTable(
  "audiences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /** 'dynamic' | 'static' */
    kind: text("kind").notNull().default("dynamic"),
    /** 'draft' | 'active' | 'archived' */
    status: text("status").notNull().default("draft"),
    /** Current rule tree (dynamic audiences; null for static). */
    rules: jsonb("rules"),
    rulesSchemaVersion: integer("rules_schema_version").notNull().default(1),
    /** Monotonic version counter for audience_rule_versions. */
    rulesVersion: integer("rules_version").notNull().default(0),
    /** Cached evaluation metrics: matched/emailReachable/whatsappReachable/... */
    cachedCounts: jsonb("cached_counts"),
    lastEvaluatedAt: timestamp("last_evaluated_at", { withTimezone: true }),
    /** 'idle' | 'running' | 'ok' | 'error' */
    evaluationStatus: text("evaluation_status").notNull().default("idle"),
    evaluationError: text("evaluation_error"),
    createdBy: text("created_by"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_audiences_workspace").on(t.workspaceOwnerId, t.status),
    index("idx_audiences_workspace_updated").on(t.workspaceOwnerId, t.updatedAt),
  ],
);

export type Audience = typeof audiences.$inferSelect;
export type InsertAudience = typeof audiences.$inferInsert;

/** Append-only history of rule trees for a dynamic audience. */
export const audienceRuleVersions = pgTable(
  "audience_rule_versions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    audienceId: uuid("audience_id")
      .notNull()
      .references(() => audiences.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    rules: jsonb("rules").notNull(),
    rulesSchemaVersion: integer("rules_schema_version").notNull().default(1),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("audience_rule_versions_unique").on(t.audienceId, t.version),
  ],
);

export type AudienceRuleVersion = typeof audienceRuleVersions.$inferSelect;

/**
 * Explicit membership for static audiences. Rows are only ever written by
 * user action (manual add / snapshot of a dynamic audience) — never by the
 * evaluator or the refresh job.
 */
export const audienceMembers = pgTable(
  "audience_members",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    audienceId: uuid("audience_id")
      .notNull()
      .references(() => audiences.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    /** 'manual' | 'snapshot' */
    source: text("source").notNull().default("manual"),
    addedBy: text("added_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("audience_members_unique").on(t.audienceId, t.contactId),
    index("idx_audience_members_contact").on(t.contactId),
  ],
);

export type AudienceMember = typeof audienceMembers.$inferSelect;

// Segmentation-support indexes on contacts live in contacts.ts / initDb.ts.
export const AUDIENCE_KINDS = ["dynamic", "static"] as const;
export const AUDIENCE_STATUSES = ["draft", "active", "archived"] as const;
export const audienceStatusCheck = sql`status in ('draft','active','archived')`;
