import { pgTable, serial, text, numeric, timestamp, index } from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// generated_invoices — persisted history of ad-hoc invoices generated via
// POST /api/invoices/generate. PDF is stored in private object storage.
// ---------------------------------------------------------------------------

export const generatedInvoices = pgTable(
  "generated_invoices",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    invoiceNumber: text("invoice_number").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    customerName: text("customer_name"),
    customerEmail: text("customer_email"),
    customerAddress: text("customer_address"),
    itemDescription: text("item_description"),
    amount: numeric("amount", { precision: 14, scale: 4 }),
    currency: text("currency"),
    createdByUserId: text("created_by_user_id"),
    createdByName: text("created_by_name"),
    pdfObjectKey: text("pdf_object_key"),
  },
  (t) => [
    index("idx_generated_invoices_workspace").on(t.workspaceOwnerId, t.createdAt),
  ],
);

export type GeneratedInvoice = typeof generatedInvoices.$inferSelect;
export type InsertGeneratedInvoice = typeof generatedInvoices.$inferInsert;
