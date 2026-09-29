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
// lb_bank_accounts — Lebanese bank account configuration per workspace
// ---------------------------------------------------------------------------

export const lbBankAccounts = pgTable(
  "lb_bank_accounts",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    bankName: text("bank_name").notNull(),
    accountName: text("account_name").notNull(),
    maskedAccountNumber: text("masked_account_number"),
    currency: text("currency").notNull().default("LBP"),
    isActive: boolean("is_active").notNull().default(true),
    isRequiredForClose: boolean("is_required_for_close").notNull().default(false),
    odooJournalId: integer("odoo_journal_id"),
    odooJournalName: text("odoo_journal_name"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("lb_bank_accounts_workspace_bank_account_currency_unique").on(
      t.workspaceOwnerId,
      t.bankName,
      t.accountName,
      t.currency,
    ),
    index("idx_lb_bank_accounts_workspace").on(t.workspaceOwnerId),
  ],
);

export type LbBankAccount = typeof lbBankAccounts.$inferSelect;
export type InsertLbBankAccount = typeof lbBankAccounts.$inferInsert;

// ---------------------------------------------------------------------------
// lb_bank_statements — uploaded bank statement file metadata per account
// ---------------------------------------------------------------------------

export const lbBankStatements = pgTable(
  "lb_bank_statements",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    accountId: integer("account_id")
      .notNull()
      .references(() => lbBankAccounts.id, { onDelete: "cascade" }),
    originalFilename: text("original_filename"),
    storagePath: text("storage_path"),
    fileHash: text("file_hash"),
    periodStart: text("period_start"),
    periodEnd: text("period_end"),
    status: text("status").notNull().default("uploaded"),
    uploadedBy: text("uploaded_by").notNull(),
    errorMessage: text("error_message"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    // Odoo sync status: not_synced | synced | partial | failed
    odooSyncStatus: text("odoo_sync_status").notNull().default("not_synced"),
    // Reconciliation status: pending | reconciled
    reconciliationStatus: text("reconciliation_status").notNull().default("pending"),
    reconciledBy: text("reconciled_by"),
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("lb_bank_statements_account_hash_unique").on(t.accountId, t.fileHash),
    index("idx_lb_bank_statements_workspace").on(t.workspaceOwnerId, t.createdAt),
    index("idx_lb_bank_statements_account").on(t.accountId),
  ],
);

export type LbBankStatement = typeof lbBankStatements.$inferSelect;
export type InsertLbBankStatement = typeof lbBankStatements.$inferInsert;

// ---------------------------------------------------------------------------
// lb_bank_statement_lines — individual posted/pending rows per statement
// ---------------------------------------------------------------------------

export const lbBankStatementLines = pgTable(
  "lb_bank_statement_lines",
  {
    id: serial("id").primaryKey(),
    statementId: integer("statement_id")
      .notNull()
      .references(() => lbBankStatements.id, { onDelete: "cascade" }),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    lineDate: text("line_date"),
    valueDate: text("value_date"),
    description: text("description"),
    reference: text("reference"),
    debitAmount: text("debit_amount"),
    creditAmount: text("credit_amount"),
    balance: text("balance"),
    currency: text("currency").notNull().default("LBP"),
    lineType: text("line_type").notNull().default("posted"),
    fingerprint: text("fingerprint"),
    isMatched: boolean("is_matched").notNull().default(false),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    // Exception classification: matched | bank_fee | inter_account | inter_entity |
    //   timing_difference | duplicate_excluded | unidentified
    classification: text("classification"),
    classificationReason: text("classification_reason"),
    classifiedBy: text("classified_by"),
    classifiedAt: timestamp("classified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("lb_bank_statement_lines_fingerprint_unique").on(t.statementId, t.fingerprint),
    index("idx_lb_bank_statement_lines_statement").on(t.statementId),
    index("idx_lb_bank_statement_lines_workspace").on(t.workspaceOwnerId),
  ],
);

export type LbBankStatementLine = typeof lbBankStatementLines.$inferSelect;
export type InsertLbBankStatementLine = typeof lbBankStatementLines.$inferInsert;

// ---------------------------------------------------------------------------
// lb_bank_statement_odoo_syncs — per-line Odoo sync results
// ---------------------------------------------------------------------------

export const lbBankStatementOdooSyncs = pgTable(
  "lb_bank_statement_odoo_syncs",
  {
    id: serial("id").primaryKey(),
    lineId: integer("line_id")
      .notNull()
      .references(() => lbBankStatementLines.id, { onDelete: "cascade" }),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    status: text("status").notNull().default("pending"),
    odooRecordId: text("odoo_record_id"),
    odooRecordUrl: text("odoo_record_url"),
    errorMessage: text("error_message"),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_lb_bank_statement_odoo_syncs_line").on(t.lineId),
    index("idx_lb_bank_statement_odoo_syncs_workspace").on(t.workspaceOwnerId),
    unique("idx_lb_bank_statement_odoo_syncs_line_unique").on(t.lineId),
  ],
);

export type LbBankStatementOdooSync = typeof lbBankStatementOdooSyncs.$inferSelect;
export type InsertLbBankStatementOdooSync = typeof lbBankStatementOdooSyncs.$inferInsert;

// ---------------------------------------------------------------------------
// lb_bank_audit_log — immutable append-only configuration change log
// ---------------------------------------------------------------------------

export const lbBankAuditLog = pgTable(
  "lb_bank_audit_log",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    actorId: text("actor_id").notNull(),
    accountId: integer("account_id"),
    action: text("action").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_lb_bank_audit_log_workspace").on(t.workspaceOwnerId, t.createdAt),
    index("idx_lb_bank_audit_log_account").on(t.accountId),
  ],
);

export type LbBankAuditLog = typeof lbBankAuditLog.$inferSelect;
export type InsertLbBankAuditLog = typeof lbBankAuditLog.$inferInsert;
