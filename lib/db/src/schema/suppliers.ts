import {
  pgTable,
  serial,
  integer,
  text,
  boolean,
  timestamp,
  numeric,
  index,
  uniqueIndex,
  uuid,
  date,
  jsonb,
  unique,
} from "drizzle-orm/pg-core";
import { locations, workspaceMembers } from "./workspace";
import { sql } from "drizzle-orm";

export const suppliers = pgTable(
  "suppliers",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    name: text("name").notNull(),
    displayName: text("display_name"),
    contactName: text("contact_name"),
    contactEmail: text("contact_email"),
    contactPhone: text("contact_phone"),
    country: text("country"),
    taxNumber: text("tax_number"),
    odooPartnerId: integer("odoo_partner_id"),
    isArchived: boolean("is_archived").notNull().default(false),
    supplierCode: text("supplier_code"),
    paymentTerms: text("payment_terms"),
    currencyPref: text("currency_pref"),
    leadTimeDays: integer("lead_time_days"),
    minOrderValue: numeric("min_order_value"),
    notes: text("notes"),
    category: text("category"),
    vatRegistered: boolean("vat_registered").default(false),
    defaultVatTreatment: text("default_vat_treatment"),
    defaultVatRate: numeric("default_vat_rate"),
    defaultTaxCategory: text("default_tax_category"),
    billingAddress: text("billing_address"),
    website: text("website"),
    tags: text("tags"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
    updatedByClerkId: text("updated_by_clerk_id"),
    createdByClerkId: text("created_by_clerk_id"),
  },
  (t) => [
    index("idx_suppliers_workspace").on(t.workspaceOwnerId),
    uniqueIndex("suppliers_workspace_odoo_partner_unique")
      .on(t.workspaceOwnerId, t.odooPartnerId)
      .where(sql`${t.odooPartnerId} IS NOT NULL`),
  ],
);

export type Supplier = typeof suppliers.$inferSelect;
export type InsertSupplier = typeof suppliers.$inferInsert;

export const supplierDocuments = pgTable(
  "supplier_documents",
  {
    id: serial("id").primaryKey(),
    supplierId: integer("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "cascade" }),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    fileName: text("file_name").notNull(),
    fileUrl: text("file_url").notNull(),
    uploadedByClerkId: text("uploaded_by_clerk_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [index("idx_supplier_docs_supplier").on(t.supplierId)],
);

export type SupplierDocument = typeof supplierDocuments.$inferSelect;
export type InsertSupplierDocument = typeof supplierDocuments.$inferInsert;

export const supplierStatements = pgTable(
  "supplier_statements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    supplierId: integer("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "cascade" }),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    statementMonth: integer("statement_month").notNull(),
    statementYear: integer("statement_year").notNull(),
    statementDate: date("statement_date"),
    currency: text("currency"),
    openingBalance: numeric("opening_balance", { precision: 14, scale: 4 }),
    closingBalance: numeric("closing_balance", { precision: 14, scale: 4 }),
    fileUrl: text("file_url").notNull(),
    originalFileName: text("original_file_name").notNull(),
    mimeType: text("mime_type"),
    fileSizeBytes: integer("file_size_bytes"),
    notes: text("notes"),
    status: text("status").notNull().default("uploaded"),
    uploadedByMemberId: integer("uploaded_by_member_id").references(
      () => workspaceMembers.id,
      { onDelete: "set null" },
    ),
    financeEntityId: integer("finance_entity_id"),
    periodStart: date("period_start"),
    periodEnd: date("period_end"),
    periodLabel: text("period_label"),
    sourceChannel: text("source_channel").notNull().default("manual_upload"),
    collectionRequestId: uuid("collection_request_id"),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    reconciliationStatus: text("reconciliation_status").notNull().default("unmatched"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("idx_supplier_statements_supplier").on(t.supplierId),
    index("idx_supplier_statements_workspace").on(t.workspaceOwnerId),
    index("idx_supplier_statements_collection_request").on(t.collectionRequestId),
    index("idx_supplier_statements_exact_period").on(
      t.workspaceOwnerId,
      t.supplierId,
      t.financeEntityId,
      t.periodStart,
      t.periodEnd,
    ),
  ],
);

export type SupplierStatement = typeof supplierStatements.$inferSelect;
export type InsertSupplierStatement = typeof supplierStatements.$inferInsert;

export const supplierInvoices = pgTable(
  "supplier_invoices",
  {
    id: serial("id").primaryKey(),
    supplierId: integer("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "cascade" }),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    amount: numeric("amount", { precision: 14, scale: 4 }).notNull(),
    currency: text("currency").notNull().default("AED"),
    status: text("status").notNull().default("issued"),
    invoiceNumber: text("invoice_number"),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    notes: text("notes"),
    referenceType: text("reference_type"),
    referenceId: integer("reference_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    // Extended fields (task #3258)
    dueDate: timestamp("due_date", { withTimezone: false }),
    vatAmount: numeric("vat_amount", { precision: 14, scale: 4 }),
    deliveryCharge: numeric("delivery_charge", { precision: 14, scale: 4 }),
    subtotal: numeric("subtotal", { precision: 14, scale: 4 }),
    discount: numeric("discount", { precision: 14, scale: 4 }),
    grandTotal: numeric("grand_total", { precision: 14, scale: 4 }),
    paymentStatus: text("payment_status").notNull().default("unpaid"),
    paymentTerms: text("payment_terms"),
    fileUrls: jsonb("file_urls"),
    lineItems: jsonb("line_items"),
    aiImportId: integer("ai_import_id"),
    // Legacy Odoo sync columns retained for existing workspaces.
    odooBillId: text("odoo_bill_id"),
    odooBillUrl: text("odoo_bill_url"),
    odooSyncedAt: timestamp("odoo_synced_at", { withTimezone: true }),
    odooSyncStatus: text("odoo_sync_status").default("pending"),
    odooSyncError: text("odoo_sync_error"),
    odooSyncIdempotencyKey: text("odoo_sync_idempotency_key"),
    // Provider-neutral identity/state is canonical for new accounting
    // connectors; legacy Odoo columns remain in this table.
    providerBillId: text("provider_bill_id"),
    providerBillStatus: text("provider_bill_status"),
    providerBillUrl: text("provider_bill_url"),
    providerSyncStatus: text("provider_sync_status").notNull().default("pending"),
    providerSyncedAt: timestamp("provider_synced_at", { withTimezone: true }),
    providerSyncError: text("provider_sync_error"),
    providerSyncIdempotencyKey: text("provider_sync_idempotency_key"),
  },
  (t) => [
    index("idx_supplier_invoices_supplier").on(t.supplierId),
    index("idx_supplier_invoices_workspace").on(t.workspaceOwnerId, t.issuedAt),
    uniqueIndex("supplier_invoices_ai_import_unique")
      .on(t.aiImportId)
      .where(sql`${t.aiImportId} IS NOT NULL`),
    index("idx_supplier_invoices_provider_bill").on(t.workspaceOwnerId, t.providerBillId),
    uniqueIndex("supplier_invoices_provider_sync_key_unique")
      .on(
        t.workspaceOwnerId,
        t.providerSyncIdempotencyKey,
      )
      .where(sql`${t.providerSyncIdempotencyKey} IS NOT NULL`),
  ],
);

export type SupplierInvoice = typeof supplierInvoices.$inferSelect;
export type InsertSupplierInvoice = typeof supplierInvoices.$inferInsert;

export const purchaseOrders = pgTable(
  "purchase_orders",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    supplierId: integer("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "cascade" }),
    poNumber: text("po_number"),
    status: text("status").notNull().default("draft"),
    currency: text("currency").notNull().default("AED"),
    totalAmount: numeric("total_amount", { precision: 14, scale: 4 }),
    totalAmountManualOverride: boolean("total_amount_manual_override").notNull().default(false),
    expectedDeliveryDate: timestamp("expected_delivery_date", { withTimezone: true }),
    notes: text("notes"),
    locationId: integer("location_id").references(() => locations.id, { onDelete: "set null" }),
    createdByClerkId: text("created_by_clerk_id"),
    updatedByClerkId: text("updated_by_clerk_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    subtotalAmount: numeric("subtotal_amount"),
    discountAmount: numeric("discount_amount"),
    deliveryFeeAmount: numeric("delivery_fee_amount"),
    vatTreatment: text("vat_treatment").default("no_vat"),
    vatRate: numeric("vat_rate"),
    vatAmount: numeric("vat_amount"),
    vatManualOverride: boolean("vat_manual_override").notNull().default(false),
    vatOverrideReason: text("vat_override_reason"),
    grandTotalAmount: numeric("grand_total_amount"),
    paymentTerms: text("payment_terms"),
    supplierReference: text("supplier_reference"),
    attachmentUrls: text("attachment_urls"),
    invoiceCoverageStatus: text("invoice_coverage_status"),
    invoiceStatus: text("invoice_status").notNull().default("not_attached"),
    receivedAt: timestamp("received_at", { withTimezone: true }),
  },
  (t) => [
    index("idx_purchase_orders_workspace").on(t.workspaceOwnerId),
    index("idx_purchase_orders_supplier").on(t.supplierId),
    index("idx_purchase_orders_location").on(t.locationId),
  ],
);

export type PurchaseOrder = typeof purchaseOrders.$inferSelect;
export type InsertPurchaseOrder = typeof purchaseOrders.$inferInsert;

export const purchaseOrderInvoices = pgTable(
  "purchase_order_invoices",
  {
    id: serial("id").primaryKey(),
    purchaseOrderId: integer("purchase_order_id")
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: "cascade" }),
    supplierInvoiceId: integer("supplier_invoice_id")
      .notNull()
      .references(() => supplierInvoices.id, { onDelete: "cascade" }),
    linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
    linkedBy: text("linked_by"),
    notes: text("notes"),
  },
  (t) => [
    index("idx_poi_po").on(t.purchaseOrderId),
    index("idx_poi_inv").on(t.supplierInvoiceId),
    uniqueIndex("purchase_order_invoices_unique").on(t.purchaseOrderId, t.supplierInvoiceId),
  ],
);

export type PurchaseOrderInvoice = typeof purchaseOrderInvoices.$inferSelect;
export type InsertPurchaseOrderInvoice = typeof purchaseOrderInvoices.$inferInsert;

export const purchaseOrderAssignees = pgTable(
  "purchase_order_assignees",
  {
    id: serial("id").primaryKey(),
    purchaseOrderId: integer("purchase_order_id")
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: "cascade" }),
    memberUserId: text("member_user_id").notNull(),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    unique("po_assignee_unique").on(t.purchaseOrderId, t.memberUserId),
    index("idx_po_assignees_po").on(t.purchaseOrderId),
  ],
);

export type PurchaseOrderAssignee = typeof purchaseOrderAssignees.$inferSelect;
export type InsertPurchaseOrderAssignee = typeof purchaseOrderAssignees.$inferInsert;

export const supplierDefaultAssignees = pgTable(
  "supplier_default_assignees",
  {
    id: serial("id").primaryKey(),
    supplierId: integer("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "cascade" }),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    memberUserId: text("member_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    unique("supplier_default_assignee_unique").on(t.supplierId, t.memberUserId),
    index("idx_supplier_default_assignees_supplier").on(t.supplierId),
  ],
);

export type SupplierDefaultAssignee = typeof supplierDefaultAssignees.$inferSelect;
export type InsertSupplierDefaultAssignee = typeof supplierDefaultAssignees.$inferInsert;

export const supplierCatalogItems = pgTable(
  "supplier_catalog_items",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    supplierId: integer("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "cascade" }),
    baseItemId: integer("base_item_id"),
    supplierItemCode: text("supplier_item_code"),
    name: text("name").notNull(),
    category: text("category"),
    unit: text("unit"),
    packageSize: text("package_size"),
    price: numeric("price", { precision: 14, scale: 4 }),
    currency: text("currency").notNull().default("AED"),
    minOrderQuantity: numeric("min_order_quantity", { precision: 14, scale: 4 }).notNull().default("1"),
    parLevel: numeric("par_level", { precision: 14, scale: 4 }),
    currentStock: numeric("current_stock", { precision: 14, scale: 4 }),
    leadTimeDays: integer("lead_time_days"),
    isActive: boolean("is_active").notNull().default(true),
    nameAr: text("name_ar"),
    nameArSource: text("name_ar_source"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("idx_supplier_catalog_items_supplier").on(t.supplierId),
    index("idx_supplier_catalog_items_workspace").on(t.workspaceOwnerId),
  ],
);

export type SupplierCatalogItem = typeof supplierCatalogItems.$inferSelect;
export type InsertSupplierCatalogItem = typeof supplierCatalogItems.$inferInsert;

export const purchaseOrderLineItems = pgTable("purchase_order_line_items", {
  id: serial("id").primaryKey(),
  purchaseOrderId: integer("purchase_order_id")
    .notNull()
    .references(() => purchaseOrders.id, { onDelete: "cascade" }),
  baseItemId: integer("base_item_id"),
  supplierCatalogItemId: integer("supplier_catalog_item_id").references(() => supplierCatalogItems.id, { onDelete: "set null" }),
  baseItemSupplierId: integer("base_item_supplier_id"),
  packageQuantity: numeric("package_quantity", { precision: 14, scale: 4 }),
  description: text("description").notNull(),
  quantity: numeric("quantity", { precision: 14, scale: 4 }).notNull().default("1"),
  unitPrice: numeric("unit_price", { precision: 14, scale: 4 }).notNull().default("0"),
  currency: text("currency").notNull().default("AED"),
  receivedQuantity: numeric("received_quantity", { precision: 14, scale: 4 }),
  descriptionAr: text("description_ar"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export type PurchaseOrderLineItem = typeof purchaseOrderLineItems.$inferSelect;
export type InsertPurchaseOrderLineItem = typeof purchaseOrderLineItems.$inferInsert;

export const supplierAssignments = pgTable(
  "supplier_assignments",
  {
    id: serial("id").primaryKey(),
    supplierId: integer("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "cascade" }),
    memberId: integer("member_id")
      .notNull()
      .references(() => workspaceMembers.id, { onDelete: "cascade" }),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    isLead: boolean("is_lead").notNull().default(false),
    createdByClerkId: text("created_by_clerk_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("idx_supplier_assignments_supplier").on(t.supplierId),
    index("idx_supplier_assignments_member").on(t.memberId),
    uniqueIndex("idx_supplier_assignments_unique").on(t.supplierId, t.memberId),
  ],
);

export type SupplierAssignment = typeof supplierAssignments.$inferSelect;
export type InsertSupplierAssignment = typeof supplierAssignments.$inferInsert;

export const supplierActivities = pgTable(
  "supplier_activities",
  {
    id: serial("id").primaryKey(),
    supplierId: integer("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "cascade" }),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    actorClerkId: text("actor_clerk_id"),
    action: text("action").notNull(),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [index("idx_supplier_activities_supplier").on(t.supplierId)],
);

export type SupplierActivity = typeof supplierActivities.$inferSelect;
export type InsertSupplierActivity = typeof supplierActivities.$inferInsert;
