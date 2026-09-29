import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { products } from "./products";

export const productGalleryRuns = pgTable(
  "product_gallery_runs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    productId: integer("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    selectedTypes: text("selected_types").array().notNull(),
    sourcePath: text("source_path").notNull(),
    sourceVersion: text("source_version").notNull(),
    productSnapshot: jsonb("product_snapshot").notNull(),
    model: text("model").notNull(),
    quality: text("quality").notNull(),
    outputSize: text("output_size").notNull(),
    outputFormat: text("output_format").notNull(),
    promptVersion: text("prompt_version").notNull(),
    status: text("status").notNull().default("PENDING"),
    leaseToken: text("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    error: jsonb("error"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("idx_pgr_idempotency").on(table.workspaceOwnerId, table.productId, table.idempotencyKey),
    uniqueIndex("idx_pgr_active_product_source")
      .on(table.workspaceOwnerId, table.productId, table.sourceVersion)
      .where(sql`${table.status} IN ('PENDING','RUNNING','RETRY_WAITING')`),
    index("idx_pgr_product_history").on(table.workspaceOwnerId, table.productId, table.createdAt),
  ],
);

export const productGalleryCandidates = pgTable(
  "product_gallery_candidates",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    runId: bigint("run_id", { mode: "number" }).notNull().references(() => productGalleryRuns.id, { onDelete: "cascade" }),
    galleryType: text("gallery_type").notNull(),
    status: text("status").notNull().default("PENDING"),
    imagePath: text("image_path"),
    sourcePath: text("source_path").notNull(),
    sourceVersion: text("source_version").notNull(),
    attempts: integer("attempts").notNull().default(0),
    retryCount: integer("retry_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    leaseToken: text("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    error: jsonb("error"),
    usage: jsonb("usage"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    generatedAt: timestamp("generated_at", { withTimezone: true }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedBy: text("reviewed_by"),
  },
  (table) => [
    uniqueIndex("idx_pgc_run_type").on(table.runId, table.galleryType),
    index("idx_pgc_due").on(table.status, table.nextAttemptAt, table.leaseUntil),
  ],
);

export const productGalleryAttempts = pgTable(
  "product_gallery_attempts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    candidateId: bigint("candidate_id", { mode: "number" }).notNull().references(() => productGalleryCandidates.id, { onDelete: "cascade" }),
    attemptNumber: integer("attempt_number").notNull(),
    status: text("status").notNull(),
    model: text("model").notNull(),
    prompt: text("prompt").notNull(),
    promptVersion: text("prompt_version").notNull(),
    config: jsonb("config").notNull(),
    error: jsonb("error"),
    usage: jsonb("usage"),
    leaseToken: text("lease_token").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("idx_pga_candidate_attempt").on(table.candidateId, table.attemptNumber)],
);

export const productGalleryAuditEvents = pgTable(
  "product_gallery_audit_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    productId: integer("product_id").notNull(),
    // Deliberately scalar rather than foreign keys: append-only audit history
    // must survive deletion of a product, run, or candidate without mutation.
    runId: bigint("run_id", { mode: "number" }),
    candidateId: bigint("candidate_id", { mode: "number" }),
    eventType: text("event_type").notNull(),
    actorId: text("actor_id"),
    details: jsonb("details").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("idx_pgae_product").on(table.workspaceOwnerId, table.productId, table.createdAt)],
);