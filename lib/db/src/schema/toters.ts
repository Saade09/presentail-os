import {
  pgTable,
  integer,
  text,
  timestamp,
  numeric,
  uuid,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// toters_import_batches — one row per confirmed Toters CSV import
// ---------------------------------------------------------------------------

export const totersImportBatches = pgTable(
  "toters_import_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    fileName: text("file_name"),
    importedByUserId: text("imported_by_user_id").notNull(),
    /** Data rows detected in the uploaded file (excluding the header). */
    totalRows: integer("total_rows").notNull().default(0),
    insertedCount: integer("inserted_count").notNull().default(0),
    duplicateCount: integer("duplicate_count").notNull().default(0),
    rejectedCount: integer("rejected_count").notNull().default(0),
    /** Inserted orders whose status is not "arrived" (stored, no revenue). */
    excludedCount: integer("excluded_count").notNull().default(0),
    /** Sum of calculated revenue (USD) of the arrived orders inserted by this batch. */
    revenueAdded: numeric("revenue_added", { precision: 18, scale: 8 })
      .notNull()
      .default("0"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_toters_import_batches_workspace").on(t.workspaceOwnerId, t.createdAt)],
);

export type TotersImportBatch = typeof totersImportBatches.$inferSelect;
export type InsertTotersImportBatch = typeof totersImportBatches.$inferInsert;

// ---------------------------------------------------------------------------
// toters_orders — individual Toters marketplace orders imported from CSV
// ---------------------------------------------------------------------------
//
// Money convention: original Items Total is stored verbatim as numeric(14,4);
// the calculated USD revenue (items_total × 1500 ÷ 89700) is stored with full
// precision as numeric(18,8). Values are only rounded for display; aggregates
// sum the unrounded stored values and round once.
//
// Dedup: the normalized Toters Code is the primary identity — a DB-level
// unique index on (workspace, source, external_order_code) guarantees that
// concurrent imports cannot insert the same order twice. Rows without a Code
// fall back to dedup_fingerprint (client name + store + exact order timestamp
// + original items total), enforced by a second unique index.

export const totersOrders = pgTable(
  "toters_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    /** Import source discriminator; always "toters" for CSV imports today. */
    source: text("source").notNull().default("toters"),
    /** Normalized (trimmed, uppercased) Toters order Code; null when the CSV row had none. */
    externalOrderCode: text("external_order_code"),
    /** Uniqueness fallback: "code:<code>" when a Code exists, else a content hash. */
    dedupFingerprint: text("dedup_fingerprint").notNull(),
    clientFirstName: text("client_first_name"),
    store: text("store"),
    /** Normalized (lowercased) Toters status; only "arrived" contributes revenue. */
    status: text("status").notNull(),
    orderTime: timestamp("order_time", { withTimezone: true }),
    deliveryTime: timestamp("delivery_time", { withTimezone: true }),
    arrivedTime: timestamp("arrived_time", { withTimezone: true }),
    approvedTime: timestamp("approved_time", { withTimezone: true }),
    markedReadyTime: timestamp("marked_ready_time", { withTimezone: true }),
    /** Original CSV Items Total, stored verbatim (source currency units). */
    itemsTotal: numeric("items_total", { precision: 14, scale: 4 }).notNull().default("0"),
    /** items_total × 1500 ÷ 89700, treated as USD, full precision. */
    calculatedRevenue: numeric("calculated_revenue", { precision: 18, scale: 8 })
      .notNull()
      .default("0"),
    batchId: uuid("batch_id").references(() => totersImportBatches.id, {
      onDelete: "set null",
    }),
    importedByUserId: text("imported_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_toters_orders_code")
      .on(t.workspaceOwnerId, t.source, t.externalOrderCode)
      .where(sql`${t.externalOrderCode} IS NOT NULL`),
    uniqueIndex("uq_toters_orders_fingerprint").on(
      t.workspaceOwnerId,
      t.source,
      t.dedupFingerprint,
    ),
    index("idx_toters_orders_workspace_status").on(t.workspaceOwnerId, t.status, t.arrivedTime),
    index("idx_toters_orders_batch").on(t.batchId),
  ],
);

export type TotersOrder = typeof totersOrders.$inferSelect;
export type InsertTotersOrder = typeof totersOrders.$inferInsert;
