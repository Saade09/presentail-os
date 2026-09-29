import {
  pgTable,
  serial,
  integer,
  numeric,
  text,
  boolean,
  timestamp,
  date,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspaceMembers } from "./workspace";

export const timeOffTypes = pgTable(
  "time_off_types",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    isPaid: boolean("is_paid").notNull().default(true),
    requiresApproval: boolean("requires_approval").notNull().default(true),
    color: text("color").notNull().default("#6b7280"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_time_off_types_workspace").on(t.workspaceOwnerId),
    unique("time_off_types_workspace_code_unique").on(t.workspaceOwnerId, t.code),
  ],
);

export type TimeOffType = typeof timeOffTypes.$inferSelect;
export type InsertTimeOffType = typeof timeOffTypes.$inferInsert;

export const timeOffPolicies = pgTable(
  "time_off_policies",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    vacationDaysPerYear: numeric("vacation_days_per_year", { precision: 5, scale: 1 })
      .notNull()
      .default("15"),
    sickLeaveDaysPerYear: numeric("sick_leave_days_per_year", { precision: 5, scale: 1 }),
    accrualType: text("accrual_type").notNull().default("ANNUAL_GRANT"),
    annualGrantMonth: integer("annual_grant_month").notNull().default(1),
    carryoverAllowed: boolean("carryover_allowed").notNull().default(false),
    maxCarryoverDays: numeric("max_carryover_days", { precision: 5, scale: 1 }),
    appliesAfterMonthsOfEmployment: integer("applies_after_months_of_employment")
      .notNull()
      .default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_time_off_policies_workspace").on(t.workspaceOwnerId),
    unique("time_off_policies_workspace_name_unique").on(t.workspaceOwnerId, t.name),
  ],
);

export type TimeOffPolicy = typeof timeOffPolicies.$inferSelect;
export type InsertTimeOffPolicy = typeof timeOffPolicies.$inferInsert;

export const userTimeOffPolicies = pgTable(
  "user_time_off_policies",
  {
    id: serial("id").primaryKey(),
    memberId: integer("member_id")
      .notNull()
      .references(() => workspaceMembers.id, { onDelete: "cascade" }),
    policyId: integer("policy_id")
      .notNull()
      .references(() => timeOffPolicies.id, { onDelete: "cascade" }),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    assignedByMemberId: integer("assigned_by_member_id").references(
      () => workspaceMembers.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_utp_member").on(t.memberId, t.effectiveFrom),
  ],
);

export type UserTimeOffPolicy = typeof userTimeOffPolicies.$inferSelect;
export type InsertUserTimeOffPolicy = typeof userTimeOffPolicies.$inferInsert;

export const timeOffBalances = pgTable(
  "time_off_balances",
  {
    id: serial("id").primaryKey(),
    memberId: integer("member_id")
      .notNull()
      .references(() => workspaceMembers.id, { onDelete: "cascade" }),
    policyId: integer("policy_id")
      .notNull()
      .references(() => timeOffPolicies.id, { onDelete: "cascade" }),
    policyYear: integer("policy_year").notNull(),
    vacationEntitled: numeric("vacation_entitled", { precision: 6, scale: 2 })
      .notNull()
      .default("0"),
    vacationUsed: numeric("vacation_used", { precision: 6, scale: 2 }).notNull().default("0"),
    vacationPending: numeric("vacation_pending", { precision: 6, scale: 2 }).notNull().default("0"),
    vacationCarryover: numeric("vacation_carryover", { precision: 6, scale: 2 })
      .notNull()
      .default("0"),
    sickLeaveEntitled: numeric("sick_leave_entitled", { precision: 6, scale: 2 }),
    sickLeaveUsed: numeric("sick_leave_used", { precision: 6, scale: 2 }).notNull().default("0"),
    sickLeavePending: numeric("sick_leave_pending", { precision: 6, scale: 2 })
      .notNull()
      .default("0"),
    manuallyAdjustedByMemberId: integer("manually_adjusted_by_member_id").references(
      () => workspaceMembers.id,
      { onDelete: "set null" },
    ),
    adjustmentReason: text("adjustment_reason"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_tob_member_year").on(t.memberId, t.policyYear),
    unique("time_off_balances_member_year_unique").on(t.memberId, t.policyYear),
  ],
);

export type TimeOffBalance = typeof timeOffBalances.$inferSelect;
export type InsertTimeOffBalance = typeof timeOffBalances.$inferInsert;

export const timeOffRequests = pgTable(
  "time_off_requests",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    memberId: integer("member_id")
      .notNull()
      .references(() => workspaceMembers.id, { onDelete: "cascade" }),
    managerMemberId: integer("manager_member_id").references(
      () => workspaceMembers.id,
      { onDelete: "set null" },
    ),
    typeId: integer("type_id")
      .notNull()
      .references(() => timeOffTypes.id, { onDelete: "restrict" }),
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    totalDays: numeric("total_days", { precision: 6, scale: 2 }).notNull(),
    halfDay: boolean("half_day").notNull().default(false),
    halfDayPeriod: text("half_day_period"),
    reason: text("reason"),
    status: text("status").notNull().default("PENDING"),
    managerNote: text("manager_note"),
    reviewedByMemberId: integer("reviewed_by_member_id").references(
      () => workspaceMembers.id,
      { onDelete: "set null" },
    ),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledBy: text("cancelled_by"),
    cancellationReason: text("cancellation_reason"),
  },
  (t) => [
    index("idx_tor_workspace_member")
      .on(t.workspaceOwnerId, t.memberId, t.startDate)
      .where(sql`${t.deletedAt} IS NULL`),
    index("idx_tor_status")
      .on(t.workspaceOwnerId, t.status, t.startDate)
      .where(sql`${t.deletedAt} IS NULL`),
  ],
);

export type TimeOffRequest = typeof timeOffRequests.$inferSelect;
export type InsertTimeOffRequest = typeof timeOffRequests.$inferInsert;

export const timeOffNotifications = pgTable(
  "time_off_notifications",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    recipientMemberId: integer("recipient_member_id")
      .notNull()
      .references(() => workspaceMembers.id, { onDelete: "cascade" }),
    actorMemberId: integer("actor_member_id")
      .notNull()
      .references(() => workspaceMembers.id, { onDelete: "cascade" }),
    type: text("type").notNull().default("TIME_OFF_REQUEST"),
    title: text("title").notNull(),
    body: text("body").notNull(),
    entityType: text("entity_type").notNull().default("time_off_request"),
    entityId: integer("entity_id").references(() => timeOffRequests.id, {
      onDelete: "cascade",
    }),
    isRead: boolean("is_read").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_ton_recipient")
      .on(t.recipientMemberId, t.createdAt)
      .where(sql`NOT ${t.isRead}`),
  ],
);

export type TimeOffNotification = typeof timeOffNotifications.$inferSelect;
export type InsertTimeOffNotification = typeof timeOffNotifications.$inferInsert;
