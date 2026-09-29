import { bigint, bigserial, boolean, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/** Local ownership record for a single Google offer, never inferred from Google listing rows. */
export const merchantOfferStates = pgTable("merchant_offer_states", {
  workspaceOwnerId: text("workspace_owner_id").notNull(),
  // Deliberately no FK: offers are durable ownership records after product purge.
  productId: integer("product_id").notNull(),
  country: text("country").notNull(),
  contentLanguage: text("content_language").notNull(),
  offerId: text("offer_id").notNull(),
  accountId: text("account_id").notNull(),
  dataSourceId: text("data_source_id").notNull(),
  dataSourceName: text("data_source_name").notNull(),
  merchantResourceName: text("merchant_resource_name"),
  syncStatus: text("sync_status").notNull().default("PENDING"),
  payloadHash: text("payload_hash"),
  payloadSnapshot: jsonb("payload_snapshot"),
  lastError: text("last_error"),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  isOwned: boolean("is_owned").notNull().default(true),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({
    columns: [
      t.workspaceOwnerId,
      t.productId,
      t.country,
      t.contentLanguage,
      t.accountId,
      t.dataSourceId,
      t.offerId,
    ],
  }),
  uniqueIndex("idx_merchant_offer_states_offer").on(t.accountId, t.offerId, t.country, t.contentLanguage),
]);

export const merchantReconciliationRuns = pgTable("merchant_reconciliation_runs", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  workspaceOwnerId: text("workspace_owner_id").notNull(),
  country: text("country").notNull(),
  contentLanguage: text("content_language").notNull(),
  status: text("status").notNull().default("DRAFT"),
  summary: jsonb("summary").notNull().default({}),
  createdBy: text("created_by").notNull(),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  approvedBy: text("approved_by"),
  appliedAt: timestamp("applied_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const merchantReconciliationItems = pgTable("merchant_reconciliation_items", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  runId: bigint("run_id", { mode: "number" }).notNull().references(() => merchantReconciliationRuns.id, { onDelete: "cascade" }),
  // Retain immutable product identity for deletion audit/reconciliation.
  productId: integer("product_id"),
  country: text("country").notNull(),
  contentLanguage: text("content_language").notNull(),
  offerId: text("offer_id").notNull(),
  action: text("action").notNull(),
  reason: text("reason"),
  stateIdentity: jsonb("state_identity"),
  deleteApproved: boolean("delete_approved").notNull().default(false),
  lastOfferApproved: boolean("last_offer_approved").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("idx_merchant_reconciliation_item_identity").on(
    t.runId,
    t.action,
    t.offerId,
    sql`(COALESCE(${t.stateIdentity}->>'accountId', ''))`,
    sql`(COALESCE(${t.stateIdentity}->>'dataSourceId', ''))`,
  ),
]);

export type MerchantOfferState = typeof merchantOfferStates.$inferSelect;
export type MerchantReconciliationRun = typeof merchantReconciliationRuns.$inferSelect;
export type MerchantReconciliationItem = typeof merchantReconciliationItems.$inferSelect;