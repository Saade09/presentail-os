import {
  pgTable,
  serial,
  integer,
  text,
  boolean,
  timestamp,
  jsonb,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// accounting_months — top-level monthly close record per workspace
// ---------------------------------------------------------------------------

export const accountingMonths = pgTable(
  "accounting_months",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    year: integer("year").notNull(),
    month: integer("month").notNull(),
    status: text("status").notNull().default("draft"),
    notes: text("notes"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("accounting_months_workspace_year_month_unique").on(t.workspaceOwnerId, t.year, t.month),
    index("idx_accounting_months_workspace").on(t.workspaceOwnerId, t.year, t.month),
  ],
);

export type AccountingMonth = typeof accountingMonths.$inferSelect;
export type InsertAccountingMonth = typeof accountingMonths.$inferInsert;

// ---------------------------------------------------------------------------
// accounting_entity_months — per-entity status within a monthly close
// ---------------------------------------------------------------------------

export const accountingEntityMonths = pgTable(
  "accounting_entity_months",
  {
    id: serial("id").primaryKey(),
    accountingMonthId: integer("accounting_month_id")
      .notNull()
      .references(() => accountingMonths.id, { onDelete: "cascade" }),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    entityId: integer("entity_id").notNull(),
    status: text("status").notNull().default("draft"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("accounting_entity_months_month_entity_unique").on(t.accountingMonthId, t.entityId),
    index("idx_accounting_entity_months_month").on(t.accountingMonthId),
    index("idx_accounting_entity_months_workspace").on(t.workspaceOwnerId),
  ],
);

export type AccountingEntityMonth = typeof accountingEntityMonths.$inferSelect;
export type InsertAccountingEntityMonth = typeof accountingEntityMonths.$inferInsert;

// ---------------------------------------------------------------------------
// accounting_sources — source definitions per workspace/entity
// ---------------------------------------------------------------------------

export const accountingSources = pgTable(
  "accounting_sources",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    entityId: integer("entity_id").notNull(),
    name: text("name").notNull(),
    sourceType: text("source_type").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    config: jsonb("config").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("accounting_sources_workspace_entity_name_unique").on(t.workspaceOwnerId, t.entityId, t.name),
    index("idx_accounting_sources_workspace_entity").on(t.workspaceOwnerId, t.entityId),
  ],
);

export type AccountingSource = typeof accountingSources.$inferSelect;
export type InsertAccountingSource = typeof accountingSources.$inferInsert;

// ---------------------------------------------------------------------------
// accounting_source_months — per-source reconciliation data per month
// ---------------------------------------------------------------------------

export const accountingSourceMonths = pgTable(
  "accounting_source_months",
  {
    id: serial("id").primaryKey(),
    accountingEntityMonthId: integer("accounting_entity_month_id")
      .notNull()
      .references(() => accountingEntityMonths.id, { onDelete: "cascade" }),
    sourceId: integer("source_id")
      .notNull()
      .references(() => accountingSources.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"),
    totalAmountCents: integer("total_amount_cents"),
    varianceCents: integer("variance_cents"),
    notes: text("notes"),
    osSalesCents: integer("os_sales_cents"),
    externalSourceCents: integer("external_source_cents"),
    refundsCents: integer("refunds_cents"),
    feesCents: integer("fees_cents"),
    netActivityCents: integer("net_activity_cents"),
    payoutStatus: text("payout_status"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("accounting_source_months_entity_month_source_unique").on(t.accountingEntityMonthId, t.sourceId),
    index("idx_accounting_source_months_entity_month").on(t.accountingEntityMonthId),
  ],
);

export type AccountingSourceMonth = typeof accountingSourceMonths.$inferSelect;
export type InsertAccountingSourceMonth = typeof accountingSourceMonths.$inferInsert;

// ---------------------------------------------------------------------------
// source_sync_runs — history of automated sync attempts per source-month
// ---------------------------------------------------------------------------

export const sourceSyncRuns = pgTable(
  "source_sync_runs",
  {
    id: serial("id").primaryKey(),
    sourceMonthId: integer("source_month_id")
      .notNull()
      .references(() => accountingSourceMonths.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("running"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    errorMessage: text("error_message"),
    recordsSynced: integer("records_synced").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_source_sync_runs_source_month").on(t.sourceMonthId, t.startedAt),
  ],
);

export type SourceSyncRun = typeof sourceSyncRuns.$inferSelect;
export type InsertSourceSyncRun = typeof sourceSyncRuns.$inferInsert;

// ---------------------------------------------------------------------------
// source_statement_lines — individual imported/synced statement lines
// ---------------------------------------------------------------------------

export const sourceStatementLines = pgTable(
  "source_statement_lines",
  {
    id: serial("id").primaryKey(),
    sourceMonthId: integer("source_month_id")
      .notNull()
      .references(() => accountingSourceMonths.id, { onDelete: "cascade" }),
    lineDate: text("line_date"),
    description: text("description"),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull().default("USD"),
    reference: text("reference"),
    isMatched: boolean("is_matched").notNull().default(false),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_source_statement_lines_source_month").on(t.sourceMonthId),
  ],
);

export type SourceStatementLine = typeof sourceStatementLines.$inferSelect;
export type InsertSourceStatementLine = typeof sourceStatementLines.$inferInsert;

// ---------------------------------------------------------------------------
// accounting_exceptions — flagged discrepancies per month
// ---------------------------------------------------------------------------

export const accountingExceptions = pgTable(
  "accounting_exceptions",
  {
    id: serial("id").primaryKey(),
    accountingMonthId: integer("accounting_month_id")
      .notNull()
      .references(() => accountingMonths.id, { onDelete: "cascade" }),
    entityId: integer("entity_id"),
    exceptionType: text("exception_type").notNull(),
    description: text("description").notNull(),
    amountCents: integer("amount_cents"),
    status: text("status").notNull().default("open"),
    resolvedBy: text("resolved_by"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_accounting_exceptions_month").on(t.accountingMonthId),
  ],
);

export type AccountingException = typeof accountingExceptions.$inferSelect;
export type InsertAccountingException = typeof accountingExceptions.$inferInsert;

// ---------------------------------------------------------------------------
// close_checklist_items — ordered close checklist per month
// ---------------------------------------------------------------------------

export const closeChecklistItems = pgTable(
  "close_checklist_items",
  {
    id: serial("id").primaryKey(),
    accountingMonthId: integer("accounting_month_id")
      .notNull()
      .references(() => accountingMonths.id, { onDelete: "cascade" }),
    entityId: integer("entity_id"),
    label: text("label").notNull(),
    isChecked: boolean("is_checked").notNull().default(false),
    checkedBy: text("checked_by"),
    checkedAt: timestamp("checked_at", { withTimezone: true }),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_close_checklist_items_month").on(t.accountingMonthId, t.sortOrder),
  ],
);

export type CloseChecklistItem = typeof closeChecklistItems.$inferSelect;
export type InsertCloseChecklistItem = typeof closeChecklistItems.$inferInsert;

// ---------------------------------------------------------------------------
// accounting_documents — uploaded supporting documents per month
// ---------------------------------------------------------------------------

export const accountingDocuments = pgTable(
  "accounting_documents",
  {
    id: serial("id").primaryKey(),
    accountingMonthId: integer("accounting_month_id")
      .notNull()
      .references(() => accountingMonths.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    storagePath: text("storage_path").notNull(),
    mimeType: text("mime_type"),
    uploadedBy: text("uploaded_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_accounting_documents_month").on(t.accountingMonthId),
  ],
);

export type AccountingDocument = typeof accountingDocuments.$inferSelect;
export type InsertAccountingDocument = typeof accountingDocuments.$inferInsert;

// ---------------------------------------------------------------------------
// journal_entry_drafts — journal entry headers per month
// ---------------------------------------------------------------------------

export const journalEntryDrafts = pgTable(
  "journal_entry_drafts",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    accountingMonthId: integer("accounting_month_id")
      .references(() => accountingMonths.id, { onDelete: "set null" }),
    description: text("description").notNull(),
    status: text("status").notNull().default("draft"),
    createdBy: text("created_by").notNull(),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    postedBy: text("posted_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_journal_entry_drafts_workspace").on(t.workspaceOwnerId, t.createdAt),
    index("idx_journal_entry_drafts_month").on(t.accountingMonthId),
  ],
);

export type JournalEntryDraft = typeof journalEntryDrafts.$inferSelect;
export type InsertJournalEntryDraft = typeof journalEntryDrafts.$inferInsert;

// ---------------------------------------------------------------------------
// journal_entry_lines — individual debit/credit lines per journal entry
// ---------------------------------------------------------------------------

export const journalEntryLines = pgTable(
  "journal_entry_lines",
  {
    id: serial("id").primaryKey(),
    journalEntryId: integer("journal_entry_id")
      .notNull()
      .references(() => journalEntryDrafts.id, { onDelete: "cascade" }),
    accountCode: text("account_code").notNull(),
    accountName: text("account_name").notNull(),
    debitCents: integer("debit_cents").notNull().default(0),
    creditCents: integer("credit_cents").notNull().default(0),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_journal_entry_lines_entry").on(t.journalEntryId),
  ],
);

export type JournalEntryLine = typeof journalEntryLines.$inferSelect;
export type InsertJournalEntryLine = typeof journalEntryLines.$inferInsert;

// ---------------------------------------------------------------------------
// import_templates — saved column-mapping templates for CSV/Excel imports
// ---------------------------------------------------------------------------

export const importTemplates = pgTable(
  "import_templates",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    name: text("name").notNull(),
    sourceType: text("source_type").notNull(),
    columnMappings: jsonb("column_mappings").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_import_templates_workspace").on(t.workspaceOwnerId),
  ],
);

export type ImportTemplate = typeof importTemplates.$inferSelect;
export type InsertImportTemplate = typeof importTemplates.$inferInsert;

// ---------------------------------------------------------------------------
// close_audit_events — immutable audit trail for the monthly close process
// ---------------------------------------------------------------------------

export const closeAuditEvents = pgTable(
  "close_audit_events",
  {
    id: serial("id").primaryKey(),
    accountingMonthId: integer("accounting_month_id")
      .notNull()
      .references(() => accountingMonths.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    actorUserId: text("actor_user_id"),
    description: text("description").notNull(),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_close_audit_events_month").on(t.accountingMonthId, t.createdAt),
  ],
);

export type CloseAuditEvent = typeof closeAuditEvents.$inferSelect;
export type InsertCloseAuditEvent = typeof closeAuditEvents.$inferInsert;

// ---------------------------------------------------------------------------
// vat_summaries — VAT breakdown per entity-month
// ---------------------------------------------------------------------------

export const vatSummaries = pgTable(
  "vat_summaries",
  {
    id: serial("id").primaryKey(),
    accountingEntityMonthId: integer("accounting_entity_month_id")
      .notNull()
      .references(() => accountingEntityMonths.id, { onDelete: "cascade" }),
    vatRate: integer("vat_rate").notNull(),
    taxableAmountCents: integer("taxable_amount_cents").notNull().default(0),
    vatAmountCents: integer("vat_amount_cents").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_vat_summaries_entity_month").on(t.accountingEntityMonthId),
  ],
);

export type VatSummary = typeof vatSummaries.$inferSelect;
export type InsertVatSummary = typeof vatSummaries.$inferInsert;

// ---------------------------------------------------------------------------
// channel_accounting_configs — maps a channel to an accounting source
// ---------------------------------------------------------------------------

export const channelAccountingConfigs = pgTable(
  "channel_accounting_configs",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    channelId: integer("channel_id").notNull(),
    accountingSourceId: integer("accounting_source_id")
      .references(() => accountingSources.id, { onDelete: "set null" }),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("channel_accounting_configs_workspace_channel_unique").on(t.workspaceOwnerId, t.channelId),
    index("idx_channel_accounting_configs_workspace").on(t.workspaceOwnerId),
  ],
);

export type ChannelAccountingConfig = typeof channelAccountingConfigs.$inferSelect;
export type InsertChannelAccountingConfig = typeof channelAccountingConfigs.$inferInsert;
