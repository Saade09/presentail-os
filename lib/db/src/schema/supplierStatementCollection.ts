import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  time,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { suppliers, supplierStatements } from "./suppliers";
import { financeEntities } from "./finance";

export const supplierStatementContacts = pgTable(
  "supplier_statement_contacts",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    supplierId: integer("supplier_id").notNull().references(() => suppliers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    role: text("role"),
    department: text("department"),
    email: text("email"),
    phone: text("phone"),
    whatsappPhone: text("whatsapp_phone"),
    provenance: text("provenance").notNull().default("manual"),
    sourceReference: text("source_reference"),
    isApproved: boolean("is_approved").notNull().default(false),
    isSelected: boolean("is_selected").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: text("approved_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_supplier_statement_contacts_workspace_supplier").on(t.workspaceOwnerId, t.supplierId),
    index("idx_supplier_statement_contacts_active").on(t.workspaceOwnerId, t.isActive),
    unique("supplier_statement_contacts_email_unique").on(t.workspaceOwnerId, t.supplierId, t.email),
  ],
);

export const supplierStatementJourneys = pgTable(
  "supplier_statement_journeys",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    supplierId: integer("supplier_id").references(() => suppliers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    isActive: boolean("is_active").notNull().default(true),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_supplier_statement_journeys_workspace").on(t.workspaceOwnerId, t.isActive),
    index("idx_supplier_statement_journeys_supplier").on(t.workspaceOwnerId, t.supplierId),
  ],
);

export const supplierStatementJourneyVersions = pgTable(
  "supplier_statement_journey_versions",
  {
    id: serial("id").primaryKey(),
    journeyId: integer("journey_id").notNull().references(() => supplierStatementJourneys.id, { onDelete: "cascade" }),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    version: integer("version").notNull(),
    steps: jsonb("steps").notNull().default(sql`'[]'::jsonb`),
    recipients: jsonb("recipients").notNull().default(sql`'[]'::jsonb`),
    escalationSettings: jsonb("escalation_settings").notNull().default(sql`'{}'::jsonb`),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("supplier_statement_journey_versions_unique").on(t.journeyId, t.version),
    index("idx_supplier_statement_journey_versions_workspace").on(t.workspaceOwnerId, t.journeyId),
  ],
);

export const supplierStatementSchedules = pgTable(
  "supplier_statement_schedules",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    supplierId: integer("supplier_id").notNull().references(() => suppliers.id, { onDelete: "cascade" }),
    financeEntityId: integer("finance_entity_id").notNull().references(() => financeEntities.id, { onDelete: "cascade" }),
    cadence: text("cadence").notNull().default("monthly"),
    localDay: integer("local_day").notNull().default(1),
    localTime: time("local_time").notNull().default("09:00"),
    timezone: text("timezone").notNull().default("UTC"),
    firstRunDate: date("first_run_date").notNull(),
    journeyId: integer("journey_id").references(() => supplierStatementJourneys.id, { onDelete: "set null" }),
    escalationSettings: jsonb("escalation_settings").notNull().default(sql`'{}'::jsonb`),
    isActive: boolean("is_active").notNull().default(false),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    pausedReason: text("paused_reason"),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    createdBy: text("created_by"),
    updatedBy: text("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("supplier_statement_schedules_supplier_entity_unique").on(t.workspaceOwnerId, t.supplierId, t.financeEntityId),
    index("idx_supplier_statement_schedules_workspace").on(t.workspaceOwnerId, t.isActive, t.nextRunAt),
    index("idx_supplier_statement_schedules_supplier").on(t.workspaceOwnerId, t.supplierId),
  ],
);

export const supplierStatementRequests = pgTable(
  "supplier_statement_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    supplierId: integer("supplier_id").notNull().references(() => suppliers.id, { onDelete: "cascade" }),
    financeEntityId: integer("finance_entity_id").notNull().references(() => financeEntities.id, { onDelete: "cascade" }),
    scheduleId: integer("schedule_id").references(() => supplierStatementSchedules.id, { onDelete: "set null" }),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    periodLabel: text("period_label").notNull(),
    cadence: text("cadence").notNull(),
    timezone: text("timezone").notNull().default("UTC"),
    status: text("status").notNull().default("open"),
    source: text("source").notNull().default("manual"),
    nextAction: text("next_action").notNull().default("prepare"),
    nextActionAt: timestamp("next_action_at", { withTimezone: true }),
    nextRecurringCycleAt: timestamp("next_recurring_cycle_at", { withTimezone: true }),
    journeyVersionId: integer("journey_version_id").references(() => supplierStatementJourneyVersions.id, { onDelete: "set null" }),
    journeySnapshot: jsonb("journey_snapshot").notNull().default(sql`'{}'::jsonb`),
    recipientsSnapshot: jsonb("recipients_snapshot").notNull().default(sql`'[]'::jsonb`),
    idempotencyKey: text("idempotency_key"),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledReason: text("cancelled_reason"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_supplier_statement_requests_workspace").on(t.workspaceOwnerId, t.status, t.nextActionAt),
    index("idx_supplier_statement_requests_supplier").on(t.workspaceOwnerId, t.supplierId, t.periodStart),
    index("idx_supplier_statement_requests_entity").on(t.workspaceOwnerId, t.financeEntityId, t.periodStart),
    unique("supplier_statement_requests_idempotency_unique").on(t.workspaceOwnerId, t.idempotencyKey),
    uniqueIndex("supplier_statement_requests_open_period_unique")
      .on(t.workspaceOwnerId, t.supplierId, t.financeEntityId, t.periodStart, t.periodEnd)
      .where(sql`${t.status} NOT IN ('received', 'reconciled', 'cancelled')`),
  ],
);

export const supplierStatementStepExecutions = pgTable(
  "supplier_statement_step_executions",
  {
    id: serial("id").primaryKey(),
    requestId: uuid("request_id").notNull().references(() => supplierStatementRequests.id, { onDelete: "cascade" }),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    stepOrder: integer("step_order").notNull(),
    channel: text("channel").notNull(),
    delayMinutes: integer("delay_minutes").notNull().default(0),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    status: text("status").notNull().default("pending"),
    providerMessageId: text("provider_message_id"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    lastError: text("last_error"),
    attemptCount: integer("attempt_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("supplier_statement_step_executions_request_step_unique").on(t.requestId, t.stepOrder),
    index("idx_supplier_statement_step_executions_due").on(t.workspaceOwnerId, t.status, t.scheduledAt),
  ],
);

export const supplierStatementCommunicationEvents = pgTable(
  "supplier_statement_communication_events",
  {
    id: serial("id").primaryKey(),
    requestId: uuid("request_id").notNull().references(() => supplierStatementRequests.id, { onDelete: "cascade" }),
    stepExecutionId: integer("step_execution_id").references(() => supplierStatementStepExecutions.id, { onDelete: "set null" }),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    eventType: text("event_type").notNull(),
    channel: text("channel"),
    providerEventId: text("provider_event_id"),
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_supplier_statement_communication_events_request").on(t.requestId, t.occurredAt),
    index("idx_supplier_statement_communication_events_workspace").on(t.workspaceOwnerId, t.occurredAt),
    unique("supplier_statement_communication_events_provider_unique").on(t.workspaceOwnerId, t.providerEventId),
  ],
);

export const supplierStatementInboundMessages = pgTable(
  "supplier_statement_inbound_messages",
  {
    id: serial("id").primaryKey(),
    requestId: uuid("request_id").notNull().references(() => supplierStatementRequests.id, { onDelete: "cascade" }),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    channel: text("channel").notNull(),
    sender: text("sender"),
    body: text("body"),
    attachmentUrl: text("attachment_url"),
    attachmentFileName: text("attachment_file_name"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_supplier_statement_inbound_messages_request").on(t.requestId, t.receivedAt),
    index("idx_supplier_statement_inbound_messages_workspace").on(t.workspaceOwnerId, t.receivedAt),
  ],
);

export const supplierStatementAuditEvents = pgTable(
  "supplier_statement_audit_events",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    action: text("action").notNull(),
    actorId: text("actor_id"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_supplier_statement_audit_events_entity").on(t.workspaceOwnerId, t.entityType, t.entityId, t.createdAt),
  ],
);

export type SupplierStatementContact = typeof supplierStatementContacts.$inferSelect;
export type SupplierStatementJourney = typeof supplierStatementJourneys.$inferSelect;
export type SupplierStatementJourneyVersion = typeof supplierStatementJourneyVersions.$inferSelect;
export type SupplierStatementSchedule = typeof supplierStatementSchedules.$inferSelect;
export type SupplierStatementRequest = typeof supplierStatementRequests.$inferSelect;
export type SupplierStatementStepExecution = typeof supplierStatementStepExecutions.$inferSelect;
export type SupplierStatementCommunicationEvent = typeof supplierStatementCommunicationEvents.$inferSelect;
export type SupplierStatementInboundMessage = typeof supplierStatementInboundMessages.$inferSelect;
export type SupplierStatementAuditEvent = typeof supplierStatementAuditEvents.$inferSelect;

// Keep this import in the module so schema consumers can discover the
// statement link while the legacy table remains defined in suppliers.ts.
export type SupplierStatementCollectionLink = typeof supplierStatements.$inferSelect;