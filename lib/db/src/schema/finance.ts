import {
  pgTable,
  serial,
  integer,
  text,
  boolean,
  timestamp,
  date,
  numeric,
  jsonb,
  index,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { suppliers } from "./suppliers";

// ---------------------------------------------------------------------------
// wafeq_connections — one encrypted, workspace-scoped Wafeq credential
// ---------------------------------------------------------------------------

/**
 * The API key is encrypted before it is written here. It is intentionally
 * separate from finance_entities because a workspace has one Wafeq account,
 * while it may have multiple legal entities.
 */
export const wafeqConnections = pgTable(
  "wafeq_connections",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    encryptedApiKey: text("encrypted_api_key").notNull(),
    organizationId: text("organization_id"),
    organizationName: text("organization_name"),
    status: text("status").notNull().default("pending"),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    lastError: text("last_error"),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("wafeq_connections_workspace_owner_unique").on(t.workspaceOwnerId),
    index("idx_wafeq_connections_status").on(t.status),
  ],
);

export type WafeqConnection = typeof wafeqConnections.$inferSelect;
export type InsertWafeqConnection = typeof wafeqConnections.$inferInsert;

// ---------------------------------------------------------------------------
// finance_entities — per-workspace legal entities for invoice management
// ---------------------------------------------------------------------------

export const financeEntities = pgTable(
  "finance_entities",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    legalName: text("legal_name").notNull(),
    displayName: text("display_name"),
    country: text("country"),
    taxRegistrationNumber: text("tax_registration_number"),
    accountingSystem: text("accounting_system").notNull().default("none"),
    odooCompanyId: integer("odoo_company_id"),
    odooCompanyName: text("odoo_company_name"),
    odooDatabase: text("odoo_database"),
    odooBaseUrl: text("odoo_base_url"),
    odooIntegrationToken: text("odoo_integration_token"),
    odooDefaultExpenseAccountId: integer("odoo_default_expense_account_id"),
    defaultCurrency: text("default_currency").notNull().default("USD"),
    /** Retained for compatibility; new entities use the explicit review workflow. */
    invoiceReviewEnabled: boolean("invoice_review_enabled").notNull().default(true),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_finance_entities_workspace").on(t.workspaceOwnerId),
    uniqueIndex("finance_entities_one_active_lb_per_workspace")
      .on(t.workspaceOwnerId)
      .where(sql`${t.country} = 'LB' AND ${t.isActive} = true`),
  ],
);

export type FinanceEntity = typeof financeEntities.$inferSelect;
export type InsertFinanceEntity = typeof financeEntities.$inferInsert;

// ---------------------------------------------------------------------------
// ai_invoice_imports — AI-parsed invoice PDF imports per entity
// ---------------------------------------------------------------------------

export const aiInvoiceImports = pgTable(
  "ai_invoice_imports",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    entityId: integer("entity_id")
      .notNull()
      .references(() => financeEntities.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("uploaded"),
    originalFilename: text("original_filename"),
    pdfStoragePath: text("pdf_storage_path"),
    vendorName: text("vendor_name"),
    vendorTaxNumber: text("vendor_tax_number"),
    vendorAddress: text("vendor_address"),
    invoiceNumber: text("invoice_number"),
    invoiceDate: date("invoice_date"),
    dueDate: date("due_date"),
    currency: text("currency"),
    subtotal: numeric("subtotal", { precision: 20, scale: 4 }),
    taxAmount: numeric("tax_amount", { precision: 20, scale: 4 }),
    totalAmount: numeric("total_amount", { precision: 20, scale: 4 }),
    lineItems: jsonb("line_items").notNull().default(sql`'[]'::jsonb`),
    confidence: numeric("confidence", { precision: 4, scale: 3 }),
    companyValidationStatus: text("company_validation_status"),
    companyValidationNotes: text("company_validation_notes"),
    rawAiJson: jsonb("raw_ai_json"),
    odooBillId: text("odoo_bill_id"),
    odooBillUrl: text("odoo_bill_url"),
    manuallyEnteredBy: text("manually_entered_by"),
    manuallyEnteredAt: timestamp("manually_entered_at", { withTimezone: true }),
    manualNotes: text("manual_notes"),
    manualAccountingReference: text("manual_accounting_reference"),
    errorMessage: text("error_message"),
    // Added via ALTER TABLE
    isReviewed: boolean("is_reviewed").notNull().default(false),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedBy: text("reviewed_by"),
    processingStep: text("processing_step").notNull().default("queued"),
    supplierId: integer("supplier_id").references(() => suppliers.id, { onDelete: "set null" }),
    billingCountry: text("billing_country"),
    // Stable external selections required when a bill is sent to Wafeq.
    wafeqSupplierId: text("wafeq_supplier_id"),
    wafeqAccountId: text("wafeq_account_id"),
    wafeqTaxId: text("wafeq_tax_id"),
    // Provider-neutral bill identity and sync state. Legacy Odoo columns
    // above remain for backwards compatibility with existing integrations.
    providerBillId: text("provider_bill_id"),
    providerBillStatus: text("provider_bill_status"),
    providerBillUrl: text("provider_bill_url"),
    providerSyncStatus: text("provider_sync_status").notNull().default("pending"),
    providerSyncedAt: timestamp("provider_synced_at", { withTimezone: true }),
    providerSyncError: text("provider_sync_error"),
    providerSyncIdempotencyKey: text("provider_sync_idempotency_key"),
    // Review and accounting sync are deliberately independent lifecycles.
     // Null means use the entity/routing rules; "undecided" is an explicit
     // reviewer choice to approve without syncing yet.
     accountingDestination: text("accounting_destination"),
    reviewStatus: text("review_status").notNull().default("needs_review"),
    syncStatus: text("sync_status").notNull().default("not_requested"),
    reviewVersion: integer("review_version").notNull().default(1),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: text("approved_by"),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    rejectedBy: text("rejected_by"),
    rejectionReason: text("rejection_reason"),
    reviewedSnapshot: jsonb("reviewed_snapshot"),
    sourceMetadata: jsonb("source_metadata").notNull().default(sql`'{}'::jsonb`),
    extractionEvidence: jsonb("extraction_evidence").notNull().default(sql`'{}'::jsonb`),
    sourceBatchId: text("source_batch_id"),
    sourcePageNumber: integer("source_page_number"),
    sourcePageCount: integer("source_page_count"),
    supersededByImportId: integer("superseded_by_import_id"),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    supersedeReason: text("supersede_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_ai_invoice_imports_workspace").on(
      t.workspaceOwnerId,
      t.createdAt,
    ),
    index("idx_ai_invoice_imports_entity").on(t.entityId),
    index("idx_ai_invoice_imports_supplier").on(t.supplierId),
    index("idx_ai_invoice_imports_wafeq_supplier").on(t.workspaceOwnerId, t.wafeqSupplierId),
    index("idx_ai_invoice_imports_provider_bill").on(t.workspaceOwnerId, t.providerBillId),
    uniqueIndex("ai_invoice_imports_provider_sync_key_unique")
      .on(t.workspaceOwnerId, t.providerSyncIdempotencyKey)
      .where(sql`${t.providerSyncIdempotencyKey} IS NOT NULL`),
    index("idx_ai_invoice_imports_review_queue").on(t.entityId, t.reviewStatus, t.createdAt),
    index("idx_ai_invoice_imports_source_batch").on(t.workspaceOwnerId, t.sourceBatchId, t.sourcePageNumber),
  ],
);

export type AiInvoiceImport = typeof aiInvoiceImports.$inferSelect;
export type InsertAiInvoiceImport = typeof aiInvoiceImports.$inferInsert;

// ---------------------------------------------------------------------------
// ai_invoice_import_settings — per-entity AI import configuration
// ---------------------------------------------------------------------------

export const aiInvoiceImportSettings = pgTable(
  "ai_invoice_import_settings",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    entityId: integer("entity_id")
      .notNull()
      .references(() => financeEntities.id, { onDelete: "cascade" }),
    settingsJson: jsonb("settings_json").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("ai_invoice_import_settings_entity_unique").on(
      t.workspaceOwnerId,
      t.entityId,
    ),
  ],
);

export type AiInvoiceImportSettings = typeof aiInvoiceImportSettings.$inferSelect;
export type InsertAiInvoiceImportSettings = typeof aiInvoiceImportSettings.$inferInsert;

// ---------------------------------------------------------------------------
// ai_invoice_import_edits — audit trail for manual edits on invoice imports
// ---------------------------------------------------------------------------

export const aiInvoiceImportEdits = pgTable(
  "ai_invoice_import_edits",
  {
    id: serial("id").primaryKey(),
    importId: integer("import_id")
      .notNull()
      .references(() => aiInvoiceImports.id, { onDelete: "cascade" }),
    changedBy: text("changed_by").notNull(),
    changedAt: timestamp("changed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    beforeValues: jsonb("before_values").notNull(),
    afterValues: jsonb("after_values").notNull(),
  },
  (t) => [
    index("idx_ai_invoice_edits_import").on(t.importId, t.changedAt),
  ],
);

export type AiInvoiceImportEdit = typeof aiInvoiceImportEdits.$inferSelect;
export type InsertAiInvoiceImportEdit = typeof aiInvoiceImportEdits.$inferInsert;

/** Stable validation records; resolved records remain evidence of the decision. */
export const aiInvoiceImportIssues = pgTable(
  "ai_invoice_import_issues",
  {
    id: serial("id").primaryKey(),
    importId: integer("import_id").notNull().references(() => aiInvoiceImports.id, { onDelete: "cascade" }),
    issueKey: text("issue_key").notNull(),
    severity: text("severity").notNull(),
    message: text("message").notNull(),
    field: text("field"),
    blocking: boolean("blocking").notNull().default(false),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: text("resolved_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("ai_invoice_import_issue_unique").on(t.importId, t.issueKey), index("idx_ai_invoice_import_issues_import").on(t.importId, t.blocking)],
);

export const aiInvoiceImportAcknowledgements = pgTable(
  "ai_invoice_import_acknowledgements",
  { id: serial("id").primaryKey(), importId: integer("import_id").notNull().references(() => aiInvoiceImports.id, { onDelete: "cascade" }), issueKey: text("issue_key").notNull(), version: integer("version").notNull(), acknowledgedBy: text("acknowledged_by").notNull(), acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }).notNull().defaultNow() },
  (t) => [unique("ai_invoice_import_ack_unique").on(t.importId, t.issueKey, t.version)],
);

export const aiInvoiceImportSyncAttempts = pgTable(
  "ai_invoice_import_sync_attempts",
  { id: serial("id").primaryKey(), importId: integer("import_id").notNull().references(() => aiInvoiceImports.id, { onDelete: "cascade" }), idempotencyKey: text("idempotency_key").notNull(), reviewVersion: integer("review_version").notNull(), status: text("status").notNull().default("pending"), destination: text("destination"), externalReference: text("external_reference"), error: text("error"), leaseToken: text("lease_token"), leaseUntil: timestamp("lease_until", { withTimezone: true }), startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(), completedAt: timestamp("completed_at", { withTimezone: true }) },
  (t) => [unique("ai_invoice_import_sync_attempt_key_unique").on(t.importId, t.idempotencyKey), index("idx_ai_invoice_import_sync_attempts_import").on(t.importId, t.startedAt)],
);

export const aiInvoiceImportAuditEvents = pgTable(
  "ai_invoice_import_audit_events",
  { id: serial("id").primaryKey(), importId: integer("import_id").notNull().references(() => aiInvoiceImports.id, { onDelete: "cascade" }), actorId: text("actor_id"), eventType: text("event_type").notNull(), details: jsonb("details").notNull().default(sql`'{}'::jsonb`), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow() },
  (t) => [index("idx_ai_invoice_import_audit_import").on(t.importId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// budget_configs — saved budget planner setups per workspace
// ---------------------------------------------------------------------------

export const budgetConfigs = pgTable(
  "budget_configs",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    name: text("name").notNull(),
    month: integer("month").notNull(),
    year: integer("year").notNull(),
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    channels: jsonb("channels").notNull(),
    // Added via ALTER TABLE
    currency: text("currency").notNull().default("AED"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_budget_configs_workspace").on(t.workspaceOwnerId, t.createdAt),
  ],
);

export type BudgetConfig = typeof budgetConfigs.$inferSelect;
export type InsertBudgetConfig = typeof budgetConfigs.$inferInsert;
