import {
  pgTable,
  serial,
  integer,
  text,
  boolean,
  timestamp,
  date,
  numeric,
  uuid,
  index,
  unique,
  jsonb,
} from "drizzle-orm/pg-core";
import { locations } from "./workspace";
import { cashSessions } from "./cashDesk";

// ---------------------------------------------------------------------------
// cmc_shifts — work shifts for CMC Beirut Hospital POS agents
// ---------------------------------------------------------------------------

export const cmcShifts = pgTable(
  "cmc_shifts",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    locationId: integer("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    openedByUserId: text("opened_by_user_id").notNull(),
    closedByUserId: text("closed_by_user_id"),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    status: text("status").notNull().default("open"),
    totalsByMethod: jsonb("totals_by_method").notNull().default("{}"),
    /** Linked cash session auto-opened when this shift starts. */
    cashSessionId: integer("cash_session_id").references(() => cashSessions.id, { onDelete: "set null" }),
    /** Opening cash amount recorded at shift start (mirrors cash session's opening_cash). */
    openingCash: numeric("opening_cash", { precision: 14, scale: 2 }).notNull().default("0"),
    /** Cash kept at this location at close. */
    closingCashKept: numeric("closing_cash_kept", { precision: 14, scale: 2 }),
    /** Cash transferred to another location at close. */
    closingCashTransferred: numeric("closing_cash_transferred", { precision: 14, scale: 2 }),
    /** Destination location for any cash transfer at close. */
    closingDestinationLocationId: integer("closing_destination_location_id").references(() => locations.id, { onDelete: "set null" }),
    /** Required when discrepancy ≠ 0 at close. */
    discrepancyNote: text("discrepancy_note"),
  },
  (t) => [
    index("idx_cmc_shifts_workspace").on(t.workspaceOwnerId, t.openedAt),
    index("idx_cmc_shifts_location").on(t.locationId, t.status),
  ],
);

export type CmcShift = typeof cmcShifts.$inferSelect;
export type InsertCmcShift = typeof cmcShifts.$inferInsert;

// ---------------------------------------------------------------------------
// cmc_sales — Workflow 1 shelf-sale transactions
// ---------------------------------------------------------------------------

export const cmcSales = pgTable(
  "cmc_sales",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    shiftId: integer("shift_id").references(() => cmcShifts.id, { onDelete: "set null" }),
    /** Nullable: order-type records (CMC New Order) carry no POS location. */
    locationId: integer("location_id").references(() => locations.id, { onDelete: "restrict" }),
    createdByUserId: text("created_by_user_id").notNull(),
    workflowType: text("workflow_type").notNull().default("shelf_sale"),
    sourceChannel: text("source_channel").notNull().default("cmc-pos"),
    status: text("status").notNull().default("paid"),
    /** Linked orders.id for workflow_type='order' records (CMC New Order). */
    orderId: uuid("order_id"),
    customerContactId: uuid("customer_contact_id"),
    lineItems: jsonb("line_items").notNull().default("[]"),
    subtotal: numeric("subtotal", { precision: 14, scale: 4 }).notNull().default("0"),
    discountAmount: numeric("discount_amount", { precision: 14, scale: 4 }).notNull().default("0"),
    /** 'percent' | 'amount' — total-level discount applied to shelf + custom combined. */
    discountType: text("discount_type"),
    discountValue: numeric("discount_value", { precision: 14, scale: 4 }),
    discountDescription: text("discount_description"),
    taxAmount: numeric("tax_amount", { precision: 14, scale: 4 }).notNull().default("0"),
    total: numeric("total", { precision: 14, scale: 4 }).notNull().default("0"),
    paymentMethod: text("payment_method"),
    paymentReference: text("payment_reference"),
    notes: text("notes"),
    idempotencyKey: text("idempotency_key"),
    fulfilmentDate: date("fulfilment_date"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_cmc_sales_workspace").on(t.workspaceOwnerId, t.createdAt),
    index("idx_cmc_sales_shift").on(t.shiftId),
    index("idx_cmc_sales_location").on(t.locationId, t.createdAt),
    unique("cmc_sales_idempotency_unique").on(t.workspaceOwnerId, t.idempotencyKey),
    unique("cmc_sales_order_unique").on(t.orderId),
  ],
);

export type CmcSale = typeof cmcSales.$inferSelect;
export type InsertCmcSale = typeof cmcSales.$inferInsert;

// ---------------------------------------------------------------------------
// cmc_requests — Workflow 2 inter-branch product requests
// ---------------------------------------------------------------------------

export const cmcRequests = pgTable(
  "cmc_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    destinationLocationId: integer("destination_location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    purpose: text("purpose").notNull().default("for_customer"),
    customerContactId: uuid("customer_contact_id"),
    status: text("status").notNull().default("draft"),
    priority: text("priority").notNull().default("standard"),
    neededBy: timestamp("needed_by", { withTimezone: true }),
    notes: text("notes"),
    createdByUserId: text("created_by_user_id").notNull(),
    tookanJobId: text("tookan_job_id"),
    tookanTaskId: text("tookan_task_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_cmc_requests_workspace").on(t.workspaceOwnerId, t.createdAt),
    index("idx_cmc_requests_location").on(t.destinationLocationId, t.status),
  ],
);

export type CmcRequest = typeof cmcRequests.$inferSelect;
export type InsertCmcRequest = typeof cmcRequests.$inferInsert;

// ---------------------------------------------------------------------------
// cmc_request_line_items — line items for a branch request
// ---------------------------------------------------------------------------

export const cmcRequestLineItems = pgTable(
  "cmc_request_line_items",
  {
    id: serial("id").primaryKey(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => cmcRequests.id, { onDelete: "cascade" }),
    productId: integer("product_id"),
    sourceLocationId: integer("source_location_id").references(
      () => locations.id,
      { onDelete: "set null" },
    ),
    requestedQty: integer("requested_qty").notNull().default(1),
    acceptedQty: integer("accepted_qty"),
    receivedQty: integer("received_qty"),
    unitPrice: numeric("unit_price", { precision: 14, scale: 4 }),
    notes: text("notes"),
  },
  (t) => [
    index("idx_cmc_rli_request").on(t.requestId),
  ],
);

export type CmcRequestLineItem = typeof cmcRequestLineItems.$inferSelect;
export type InsertCmcRequestLineItem = typeof cmcRequestLineItems.$inferInsert;

// ---------------------------------------------------------------------------
// cmc_request_events — status-change audit trail for requests
// ---------------------------------------------------------------------------

export const cmcRequestEvents = pgTable(
  "cmc_request_events",
  {
    id: serial("id").primaryKey(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => cmcRequests.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id"),
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_cmc_re_request").on(t.requestId, t.createdAt),
  ],
);

export type CmcRequestEvent = typeof cmcRequestEvents.$inferSelect;
export type InsertCmcRequestEvent = typeof cmcRequestEvents.$inferInsert;

// ---------------------------------------------------------------------------
// cmc_monthly_settlements — payment status per workspace per month
// ---------------------------------------------------------------------------

export const cmcMonthlySettlements = pgTable(
  "cmc_monthly_settlements",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    settlementMonth: text("settlement_month").notNull(),
    currency: text("currency").notNull().default("USD"),
    status: text("status").notNull().default("unpaid"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    paidByUserId: text("paid_by_user_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedByUserId: text("updated_by_user_id"),
  },
  (t) => [
    unique("cmc_monthly_settlements_workspace_month").on(t.workspaceOwnerId, t.settlementMonth),
    index("idx_cmc_settlements_workspace").on(t.workspaceOwnerId, t.settlementMonth),
  ],
);

export type CmcMonthlySettlement = typeof cmcMonthlySettlements.$inferSelect;
export type InsertCmcMonthlySettlement = typeof cmcMonthlySettlements.$inferInsert;

// ---------------------------------------------------------------------------
// cmc_monthly_settlement_audit — audit log for settlement status changes
// ---------------------------------------------------------------------------

export const cmcMonthlySettlementAudit = pgTable(
  "cmc_monthly_settlement_audit",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    settlementMonth: text("settlement_month").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    actorUserId: text("actor_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_cmc_settlement_audit_workspace").on(t.workspaceOwnerId, t.settlementMonth),
  ],
);

export type CmcMonthlySettlementAudit = typeof cmcMonthlySettlementAudit.$inferSelect;
export type InsertCmcMonthlySettlementAudit = typeof cmcMonthlySettlementAudit.$inferInsert;

// ---------------------------------------------------------------------------
// cmc_monthly_report_deliveries — email delivery tracking for monthly reports
// ---------------------------------------------------------------------------

export const cmcMonthlyReportDeliveries = pgTable(
  "cmc_monthly_report_deliveries",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    reportMonth: text("report_month").notNull(),
    recipientUserId: text("recipient_user_id").notNull(),
    recipientEmail: text("recipient_email").notNull(),
    status: text("status").notNull().default("pending"),
    providerMessageId: text("provider_message_id"),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    failureReason: text("failure_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("cmc_monthly_report_deliveries_unique").on(t.workspaceOwnerId, t.reportMonth, t.recipientUserId),
    index("idx_cmc_report_deliveries_workspace").on(t.workspaceOwnerId, t.reportMonth),
    index("idx_cmc_report_deliveries_status").on(t.status, t.lastAttemptAt),
  ],
);

export type CmcMonthlyReportDelivery = typeof cmcMonthlyReportDeliveries.$inferSelect;
export type InsertCmcMonthlyReportDelivery = typeof cmcMonthlyReportDeliveries.$inferInsert;

// ---------------------------------------------------------------------------
// cmc_returns — Workflow 4: return of poor-condition CMC stock for collection
// ---------------------------------------------------------------------------

export const cmcReturns = pgTable(
  "cmc_returns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    branchLocationId: integer("branch_location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    returnToLocationId: integer("return_to_location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    operatorUserId: text("operator_user_id").notNull(),
    reference: text("reference").notNull(),
    status: text("status").notNull().default("draft"),
    collectionMethod: text("collection_method").notNull().default("pickup"),
    collectionDate: date("collection_date").notNull(),
    notes: text("notes"),
    tookanJobId: text("tookan_job_id"),
    tookanTaskId: text("tookan_task_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_cmc_returns_workspace").on(t.workspaceOwnerId, t.createdAt),
    index("idx_cmc_returns_branch").on(t.branchLocationId, t.status),
    unique("cmc_returns_reference_unique").on(t.reference),
  ],
);

export type CmcReturn = typeof cmcReturns.$inferSelect;
export type InsertCmcReturn = typeof cmcReturns.$inferInsert;

// ---------------------------------------------------------------------------
// cmc_return_line_items — line items per return
// ---------------------------------------------------------------------------

export const cmcReturnLineItems = pgTable(
  "cmc_return_line_items",
  {
    id: serial("id").primaryKey(),
    returnId: uuid("return_id")
      .notNull()
      .references(() => cmcReturns.id, { onDelete: "cascade" }),
    productId: integer("product_id"),
    skuSnapshot: text("sku_snapshot"),
    nameSnapshot: text("name_snapshot").notNull(),
    imageUrl: text("image_url"),
    quantity: integer("quantity").notNull().default(1),
    reason: text("reason").notNull().default("poor_condition"),
    stockSnapshot: integer("stock_snapshot"),
    adjustmentId: integer("adjustment_id"),
    isCustom: boolean("is_custom").notNull().default(false),
  },
  (t) => [
    index("idx_cmc_rli_return").on(t.returnId),
  ],
);

export type CmcReturnLineItem = typeof cmcReturnLineItems.$inferSelect;
export type InsertCmcReturnLineItem = typeof cmcReturnLineItems.$inferInsert;

// ---------------------------------------------------------------------------
// cmc_return_events — status-change audit trail for returns
// ---------------------------------------------------------------------------

export const cmcReturnEvents = pgTable(
  "cmc_return_events",
  {
    id: serial("id").primaryKey(),
    returnId: uuid("return_id")
      .notNull()
      .references(() => cmcReturns.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id"),
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_cmc_rev_return").on(t.returnId, t.createdAt),
  ],
);

export type CmcReturnEvent = typeof cmcReturnEvents.$inferSelect;
export type InsertCmcReturnEvent = typeof cmcReturnEvents.$inferInsert;
