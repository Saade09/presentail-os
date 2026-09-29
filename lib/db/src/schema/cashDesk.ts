import {
  pgTable,
  serial,
  integer,
  text,
  boolean,
  timestamp,
  numeric,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { locations } from "./workspace";

/**
 * Workshop Cash Desk — cash drawers, shift-based cash sessions, the cash
 * transaction ledger linked to sessions, and a per-session activity log.
 */

export const cashDrawers = pgTable(
  "cash_drawers",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    name: text("name").notNull(),
    /** Short code used in generated session numbers (e.g. "D1"). */
    code: text("code").notNull(),
    locationId: integer("location_id").references(() => locations.id, {
      onDelete: "set null",
    }),
    /** Main currency for the drawer. */
    currency: text("currency").notNull().default("AED"),
    /**
     * Optional second currency. When set, staff choose which of the two
     * currencies a session tracks at open time. Null = single-currency drawer.
     */
    secondaryCurrency: text("secondary_currency"),
    /**
     * Optional entity scope. When set, this drawer and its transactions are
     * treated as belonging to the given finance entity, enabling entity-level
     * filtering in the Cash Activity module without adding entity_id to the
     * high-frequency cash_transactions table.
     */
    entityId: integer("entity_id"),
    isActive: boolean("is_active").notNull().default(true),
    notes: text("notes"),
    createdByClerkId: text("created_by_clerk_id"),
    updatedByClerkId: text("updated_by_clerk_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("idx_cash_drawers_workspace").on(t.workspaceOwnerId),
    index("idx_cash_drawers_location").on(t.locationId),
  ],
);

export type CashDrawer = typeof cashDrawers.$inferSelect;
export type InsertCashDrawer = typeof cashDrawers.$inferInsert;

/**
 * A cash session represents one shift on one drawer in one currency.
 * status: open | pending_review | approved | flagged
 */
export const cashSessions = pgTable(
  "cash_sessions",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    sessionNumber: text("session_number").notNull(),
    drawerId: integer("drawer_id")
      .notNull()
      .references(() => cashDrawers.id, { onDelete: "restrict" }),
    locationId: integer("location_id").references(() => locations.id, {
      onDelete: "set null",
    }),
    currency: text("currency").notNull().default("AED"),
    /**
     * Second tracked currency for dual-currency drawers. When set, the session
     * reconciles both currencies: the *_secondary columns hold that currency's
     * figures. Null = single-currency session (all historical sessions).
     */
    secondaryCurrency: text("secondary_currency"),
    status: text("status").notNull().default("open"),
    openingCash: numeric("opening_cash", { precision: 14, scale: 2 })
      .notNull()
      .default("0"),
    openingCashSecondary: numeric("opening_cash_secondary", {
      precision: 14,
      scale: 2,
    }),
    cashInTotal: numeric("cash_in_total", { precision: 14, scale: 2 })
      .notNull()
      .default("0"),
    cashOutTotal: numeric("cash_out_total", { precision: 14, scale: 2 })
      .notNull()
      .default("0"),
    adjustmentsTotal: numeric("adjustments_total", { precision: 14, scale: 2 })
      .notNull()
      .default("0"),
    cashInTotalSecondary: numeric("cash_in_total_secondary", {
      precision: 14,
      scale: 2,
    }),
    cashOutTotalSecondary: numeric("cash_out_total_secondary", {
      precision: 14,
      scale: 2,
    }),
    adjustmentsTotalSecondary: numeric("adjustments_total_secondary", {
      precision: 14,
      scale: 2,
    }),
    /** Totals for cash transferred in/out of this session. */
    transfersInTotal: numeric("transfers_in_total", { precision: 14, scale: 2 })
      .notNull()
      .default("0"),
    transfersOutTotal: numeric("transfers_out_total", { precision: 14, scale: 2 })
      .notNull()
      .default("0"),
    transfersInTotalSecondary: numeric("transfers_in_total_secondary", {
      precision: 14,
      scale: 2,
    }),
    transfersOutTotalSecondary: numeric("transfers_out_total_secondary", {
      precision: 14,
      scale: 2,
    }),
    /** Expected closing cash, computed at close time. */
    expectedCash: numeric("expected_cash", { precision: 14, scale: 2 }),
    expectedCashSecondary: numeric("expected_cash_secondary", {
      precision: 14,
      scale: 2,
    }),
    /** Actual counted cash entered at close. */
    actualCash: numeric("actual_cash", { precision: 14, scale: 2 }),
    actualCashSecondary: numeric("actual_cash_secondary", {
      precision: 14,
      scale: 2,
    }),
    /** actual - expected (positive = over, negative = short). */
    difference: numeric("difference", { precision: 14, scale: 2 }),
    differenceSecondary: numeric("difference_secondary", {
      precision: 14,
      scale: 2,
    }),
    /**
     * Per-currency reconciliation counts captured at close time. JSON array of
     * { currency, expected, actual, variance, explanation } — currencies are
     * never converted or combined.
     */
    closingCounts: jsonb("closing_counts"),
    /**
     * Guided Reconcile & Close state. JSON object holding the in-progress (and
     * final) reconciliation: who started/counted, a transaction snapshot for
     * stale-data detection, and per-currency counts with expected snapshot,
     * variance, explanation, and approval (approver, decision, timestamps).
     * Null on legacy sessions and sessions closed via the simple close route.
     */
    reconciliation: jsonb("reconciliation"),
    openingNote: text("opening_note"),
    closingNote: text("closing_note"),
    flagReason: text("flag_reason"),
    reopenReason: text("reopen_reason"),
    openedByMemberId: integer("opened_by_member_id"),
    openedByClerkId: text("opened_by_clerk_id"),
    closedByClerkId: text("closed_by_clerk_id"),
    approvedByClerkId: text("approved_by_clerk_id"),
    openedAt: timestamp("opened_at", { withTimezone: true }).defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("idx_cash_sessions_workspace").on(t.workspaceOwnerId),
    index("idx_cash_sessions_drawer").on(t.drawerId),
    index("idx_cash_sessions_status").on(t.workspaceOwnerId, t.status),
  ],
);

export type CashSession = typeof cashSessions.$inferSelect;
export type InsertCashSession = typeof cashSessions.$inferInsert;

/**
 * Cash transaction ledger. Each row is one cash movement (sale, expense,
 * adjustment) linked to a session when one is open for its drawer/currency.
 * direction: in | out      type: sale | expense | adjustment | other
 */
export const cashTransactions = pgTable(
  "cash_transactions",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    cashSessionId: integer("cash_session_id").references(() => cashSessions.id, {
      onDelete: "set null",
    }),
    cashDrawerId: integer("cash_drawer_id").references(() => cashDrawers.id, {
      onDelete: "set null",
    }),
    locationId: integer("location_id").references(() => locations.id, {
      onDelete: "set null",
    }),
    currency: text("currency").notNull().default("AED"),
    type: text("type").notNull().default("sale"),
    direction: text("direction").notNull().default("in"),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    description: text("description"),
    referenceType: text("reference_type"),
    referenceId: text("reference_id"),
    hasReceipt: boolean("has_receipt").notNull().default(false),
    /** Optional invoice/receipt object-storage path (e.g. for a bill). */
    attachmentUrl: text("attachment_url"),
    /** Sales channel for sale-type transactions (walk_in, whatsapp, …). */
    saleChannel: text("sale_channel"),
    /** Expense category for expense-type transactions. */
    expenseCategory: text("expense_category"),
    /** Supplier/payee for expense-type transactions. */
    payee: text("payee"),
    /** For reversal rows: the id of the transaction being reversed. */
    reversalOfId: integer("reversal_of_id"),
    /** Required reason recorded on a reversal row. */
    reversalReason: text("reversal_reason"),
    /** Set true on the original transaction once it has been reversed. */
    isReversed: boolean("is_reversed").notNull().default(false),
    /**
     * Links paired outgoing+incoming transfer rows. Both rows of a cash
     * transfer between locations share the same UUID here.
     */
    transferId: text("transfer_id"),
    status: text("status").notNull().default("confirmed"),
    /**
     * Approval lifecycle for expenses that require sign-off (salaries_wages):
     * confirmed | pending | declined | cancelled. Non-confirmed rows are
     * excluded from session total recomputation and currency summaries.
     */
    approvalStatus: text("approval_status").notNull().default("confirmed"),
    /** Clerk id of the member who submitted an approval-gated expense. */
    requestedByClerkId: text("requested_by_clerk_id"),
    /** Clerk id of the approver who approved/declined the request. */
    approvalDecidedByClerkId: text("approval_decided_by_clerk_id"),
    /** Timestamp of the approve/decline/cancel decision. */
    approvalDecidedAt: timestamp("approval_decided_at", { withTimezone: true }),
    /** Optional reason recorded when a request is declined. */
    approvalDeclineReason: text("approval_decline_reason"),
    /** Set when the requester has seen the decision in-app (bell dismissal). */
    approvalRequesterAckAt: timestamp("approval_requester_ack_at", { withTimezone: true }),
    createdByClerkId: text("created_by_clerk_id"),
    transactionDate: timestamp("transaction_date", { withTimezone: true }).defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    /**
     * The document/sale currency for this transaction. When set, the
     * settlement may span multiple physical currencies via movement rows.
     */
    transactionCurrency: text("transaction_currency"),
    /**
     * How any residual difference between received and due is classified.
     * balanced | rounding | fx_difference | overpayment
     */
    balanceDifferenceKind: text("balance_difference_kind"),
  },
  (t) => [
    index("idx_cash_transactions_workspace").on(t.workspaceOwnerId),
    index("idx_cash_transactions_session").on(t.cashSessionId),
    index("idx_cash_transactions_drawer").on(t.cashDrawerId),
  ],
);

export type CashTransaction = typeof cashTransactions.$inferSelect;
export type InsertCashTransaction = typeof cashTransactions.$inferInsert;

/**
 * Per-movement lines for a cash transaction. Each row records one payment
 * received or change returned, with its physical currency and exchange rate.
 * A single transaction may have many movement rows (multi-currency settlement).
 */
export const cashTransactionMovements = pgTable(
  "cash_transaction_movements",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    cashTransactionId: integer("cash_transaction_id")
      .notNull()
      .references(() => cashTransactions.id, { onDelete: "cascade" }),
    /** inflow = money entering the drawer; outflow = change given back */
    direction: text("direction").notNull(), // 'inflow' | 'outflow'
    /** payment | change | expense_payment | refund | adjustment */
    kind: text("kind").notNull(),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    currency: text("currency").notNull(),
    /** Exchange rate to the transaction (document) currency. Null for same-currency lines. */
    exchangeRate: numeric("exchange_rate", { precision: 20, scale: 8 }),
    /** Amount converted into the transaction currency at the stored rate. */
    convertedAmount: numeric("converted_amount", { precision: 14, scale: 2 }),
    /** session_rate | override */
    rateSource: text("rate_source"),
    /** Clerk ID of the user who approved an exchange-rate override. */
    overrideApprovedBy: text("override_approved_by"),
    createdByClerkId: text("created_by_clerk_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("idx_cash_txn_movements_transaction").on(t.cashTransactionId),
    index("idx_cash_txn_movements_workspace").on(t.workspaceOwnerId),
  ],
);

export type CashTransactionMovement = typeof cashTransactionMovements.$inferSelect;
export type InsertCashTransactionMovement = typeof cashTransactionMovements.$inferInsert;

export const cashSessionActivityLogs = pgTable(
  "cash_session_activity_logs",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    cashSessionId: integer("cash_session_id")
      .notNull()
      .references(() => cashSessions.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    actorClerkId: text("actor_clerk_id"),
    actorName: text("actor_name"),
    detail: text("detail"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [index("idx_cash_session_activity_session").on(t.cashSessionId)],
);

export type CashSessionActivityLog = typeof cashSessionActivityLogs.$inferSelect;
export type InsertCashSessionActivityLog =
  typeof cashSessionActivityLogs.$inferInsert;

/**
 * Cash transfers — inter-drawer / inter-location cash handover records.
 * Each transfer moves cash from a source drawer to a destination drawer
 * with an immutable audit trail in cash_transfer_audit_events.
 * status: IN_TRANSIT | COMPLETED | DISPUTED | CANCELLED
 */
export const cashTransfers = pgTable(
  "cash_transfers",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    transferNumber: text("transfer_number").notNull(),
    sourceLocationId: integer("source_location_id").references(
      () => locations.id,
      { onDelete: "set null" },
    ),
    sourceDrawerId: integer("source_drawer_id")
      .notNull()
      .references(() => cashDrawers.id, { onDelete: "restrict" }),
    sourceSessionId: integer("source_session_id").references(
      () => cashSessions.id,
      { onDelete: "set null" },
    ),
    destinationLocationId: integer("destination_location_id").references(
      () => locations.id,
      { onDelete: "set null" },
    ),
    destinationDrawerId: integer("destination_drawer_id")
      .notNull()
      .references(() => cashDrawers.id, { onDelete: "restrict" }),
    destinationSessionId: integer("destination_session_id").references(
      () => cashSessions.id,
      { onDelete: "set null" },
    ),
    currencyCode: text("currency_code").notNull(),
    sentAmount: numeric("sent_amount", { precision: 14, scale: 2 }).notNull(),
    receivedAmount: numeric("received_amount", { precision: 14, scale: 2 }),
    differenceAmount: numeric("difference_amount", { precision: 14, scale: 2 }),
    actualReceivedAmount: numeric("actual_received_amount", {
      precision: 14,
      scale: 2,
    }),
    transferMethod: text("transfer_method").notNull().default("internal"),
    status: text("status").notNull().default("IN_TRANSIT"),
    initiatedByUserId: text("initiated_by_user_id"),
    handedOverByUserId: text("handed_over_by_user_id"),
    intendedReceiverUserId: text("intended_receiver_user_id"),
    receivedByUserId: text("received_by_user_id"),
    carrierUserId: text("carrier_user_id"),
    carrierType: text("carrier_type"),
    externalCarrierName: text("external_carrier_name"),
    note: text("note"),
    /** Optimistic-lock version, incremented on each status transition. */
    version: integer("version").notNull().default(1),
    resolutionReason: text("resolution_reason"),
    resolutionNote: text("resolution_note"),
    resolvedByUserId: text("resolved_by_user_id"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    disputeExplanation: text("dispute_explanation"),
    disputedAt: timestamp("disputed_at", { withTimezone: true }),
    idempotencyKey: text("idempotency_key"),
    handedOverAt: timestamp("handed_over_at", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("idx_cash_transfers_workspace").on(t.workspaceOwnerId),
    index("idx_cash_transfers_status").on(t.workspaceOwnerId, t.status),
    index("idx_cash_transfers_source_drawer").on(t.sourceDrawerId),
    index("idx_cash_transfers_dest_drawer").on(t.destinationDrawerId),
  ],
);

export type CashTransfer = typeof cashTransfers.$inferSelect;
export type InsertCashTransfer = typeof cashTransfers.$inferInsert;

/**
 * Immutable audit log for cash transfer lifecycle events.
 */
export const cashTransferAuditEvents = pgTable(
  "cash_transfer_audit_events",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    cashTransferId: integer("cash_transfer_id")
      .notNull()
      .references(() => cashTransfers.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    actorUserId: text("actor_user_id"),
    actorName: text("actor_name"),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("idx_cash_transfer_audit_transfer").on(t.cashTransferId),
    index("idx_cash_transfer_audit_workspace").on(t.workspaceOwnerId),
  ],
);

export type CashTransferAuditEvent = typeof cashTransferAuditEvents.$inferSelect;
export type InsertCashTransferAuditEvent =
  typeof cashTransferAuditEvents.$inferInsert;

// ── Cash Activity Module ──────────────────────────────────────────────────────

/**
 * Groups of matched cash-in + cash-out transactions. A Finance user creates a
 * group to assert that a set of transactions balance each other out (e.g. a
 * cash advance repaid later in the same month). Status transitions:
 *   ACTIVE  → group is live and transactions are considered matched
 *   UNMATCHED → Finance Admin unmatch action; group is logically deleted
 */
export const cashMatchGroups = pgTable(
  "cash_match_groups",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    /** Optional entity scope for multi-entity workspaces. */
    entityId: integer("entity_id"),
    locationId: integer("location_id").references(() => locations.id, {
      onDelete: "set null",
    }),
    cashDrawerId: integer("cash_drawer_id").references(() => cashDrawers.id, {
      onDelete: "set null",
    }),
    currency: text("currency").notNull(),
    /** Accounting month in YYYY-MM format. */
    accountingMonth: text("accounting_month").notNull(),
    /** Clerk user ID of the person who created the match. */
    matchedBy: text("matched_by").notNull(),
    note: text("note"),
    /** ACTIVE | UNMATCHED */
    status: text("status").notNull().default("ACTIVE"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_cash_match_groups_workspace").on(t.workspaceOwnerId),
    index("idx_cash_match_groups_month").on(t.workspaceOwnerId, t.accountingMonth),
  ],
);

export type CashMatchGroup = typeof cashMatchGroups.$inferSelect;
export type InsertCashMatchGroup = typeof cashMatchGroups.$inferInsert;

/**
 * Bridge table linking individual cash transactions to a match group.
 * The UNIQUE constraint on transaction_id is the concurrency guard — it
 * prevents the same transaction from being included in two groups even under
 * concurrent requests.
 */
export const cashMatchGroupTransactions = pgTable(
  "cash_match_group_transactions",
  {
    id: serial("id").primaryKey(),
    matchGroupId: integer("match_group_id")
      .notNull()
      .references(() => cashMatchGroups.id, { onDelete: "cascade" }),
    transactionId: integer("transaction_id")
      .notNull()
      .references(() => cashTransactions.id, { onDelete: "cascade" }),
  },
  (t) => [
    index("idx_cash_match_group_txns_group").on(t.matchGroupId),
    index("idx_cash_match_group_txns_txn").on(t.transactionId),
  ],
);

export type CashMatchGroupTransaction = typeof cashMatchGroupTransactions.$inferSelect;
export type InsertCashMatchGroupTransaction = typeof cashMatchGroupTransactions.$inferInsert;

/**
 * Immutable audit log for every match, unmatch, finalization, and reopen event.
 * The payload JSONB captures before/after state for each event type.
 */
export const cashActivityAuditLog = pgTable(
  "cash_activity_audit_log",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    /** MATCH | UNMATCH | FINALIZE | REOPEN */
    action: text("action").notNull(),
    actor: text("actor").notNull(),
    /** Required for unmatch and reopen; optional for other event types. */
    reason: text("reason"),
    /** Before/after state snapshot; shape varies by action. */
    payload: jsonb("payload").notNull().default({}),
    /** Set for match/unmatch events. */
    matchGroupId: integer("match_group_id"),
    /** Set for finalize/reopen events (YYYY-MM). */
    yearMonth: text("year_month"),
    /** Set for finalize/reopen events. */
    entityId: integer("entity_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_cash_activity_audit_workspace").on(t.workspaceOwnerId),
    index("idx_cash_activity_audit_group").on(t.matchGroupId),
    index("idx_cash_activity_audit_month").on(t.workspaceOwnerId, t.yearMonth),
  ],
);

export type CashActivityAuditLog = typeof cashActivityAuditLog.$inferSelect;
export type InsertCashActivityAuditLog = typeof cashActivityAuditLog.$inferInsert;

/**
 * Tracks finalization state per workspace / entity / accounting month.
 * Status: OPEN | FINALIZED
 */
export const cashActivityMonths = pgTable(
  "cash_activity_months",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    /** Null = no entity scoping (workspace-level). */
    entityId: integer("entity_id"),
    /** Accounting month in YYYY-MM format. */
    yearMonth: text("year_month").notNull(),
    /** OPEN | FINALIZED */
    status: text("status").notNull().default("OPEN"),
    finalizedBy: text("finalized_by"),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    reopenReason: text("reopen_reason"),
    reopenActor: text("reopen_actor"),
    reopenAt: timestamp("reopen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_cash_activity_months_workspace").on(t.workspaceOwnerId),
    index("idx_cash_activity_months_month").on(t.workspaceOwnerId, t.yearMonth),
  ],
);

export type CashActivityMonth = typeof cashActivityMonths.$inferSelect;
export type InsertCashActivityMonth = typeof cashActivityMonths.$inferInsert;
