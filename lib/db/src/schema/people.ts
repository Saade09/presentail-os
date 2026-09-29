import {
  pgTable,
  serial,
  integer,
  numeric,
  text,
  boolean,
  timestamp,
  date,
  time,
  index,
  uniqueIndex,
  unique,
  jsonb,
  doublePrecision,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspaceMembers } from "./workspace";
import { timeOffPolicies } from "./timeOff";

export const people = pgTable("people", {
  id: serial("id").primaryKey(),
  workspaceOwnerId: text("workspace_owner_id").notNull(),
  firstName: text("first_name").notNull(),
  lastName: text("last_name"),
  displayName: text("display_name"),
  email: text("email"),
  phone: text("phone"),
  avatarUrl: text("avatar_url"),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
});

export type Person = typeof people.$inferSelect;
export type InsertPerson = typeof people.$inferInsert;

export const teamMemberProfiles = pgTable(
  "team_member_profiles",
  {
    id: serial("id").primaryKey(),
    personId: integer("person_id").references(() => people.id, { onDelete: "cascade" }),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    teamMemberId: integer("team_member_id"),
    employeeCode: text("employee_code"),
    departmentId: integer("department_id"),
    jobTitle: text("job_title"),
    managerPersonId: integer("manager_person_id"),
    employmentType: text("employment_type").notNull().default("full_time"),
    startDate: date("start_date"),
    workLocationId: integer("work_location_id"),
    workScheduleId: integer("work_schedule_id"),
    timeOffPolicyId: integer("time_off_policy_id"),
    attendanceEnabled: boolean("attendance_enabled").notNull().default(false),
    emergencyContactName: text("emergency_contact_name"),
    emergencyContactPhone: text("emergency_contact_phone"),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_tmp_team_member_id")
      .on(t.teamMemberId)
      .where(sql`${t.teamMemberId} IS NOT NULL`),
  ],
);

export type TeamMemberProfile = typeof teamMemberProfiles.$inferSelect;
export type InsertTeamMemberProfile = typeof teamMemberProfiles.$inferInsert;

export const departments = pgTable(
  "departments",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_departments_workspace").on(t.workspaceOwnerId)],
);

export type Department = typeof departments.$inferSelect;
export type InsertDepartment = typeof departments.$inferInsert;

export const teamMembers = pgTable(
  "team_members",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    memberDbId: integer("member_db_id"),
    firstName: text("first_name").notNull(),
    lastName: text("last_name"),
    email: text("email"),
    phone: text("phone"),
    departmentId: integer("department_id").references(() => departments.id, {
      onDelete: "set null",
    }),
    locationId: integer("location_id"),
    managerId: integer("manager_id"),
    employmentStatus: text("employment_status").notNull().default("full_time"),
    startDate: date("start_date"),
    birthday: date("birthday"),
    emergencyContactName: text("emergency_contact_name"),
    emergencyContactPhone: text("emergency_contact_phone"),
    emergencyContactRelationship: text("emergency_contact_relationship"),
    leavePolicyId: integer("leave_policy_id"),
    workScheduleId: integer("work_schedule_id"),
    notes: text("notes"),
    expoPushToken: text("expo_push_token"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_team_members_workspace").on(t.workspaceOwnerId)],
);

export type TeamMember = typeof teamMembers.$inferSelect;
export type InsertTeamMember = typeof teamMembers.$inferInsert;

export const workSchedules = pgTable("work_schedules", {
  id: serial("id").primaryKey(),
  workspaceOwnerId: text("workspace_owner_id").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  status: text("status").notNull().default("active"),
  defaultTimezone: text("default_timezone").notNull().default("UTC"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type WorkSchedule = typeof workSchedules.$inferSelect;
export type InsertWorkSchedule = typeof workSchedules.$inferInsert;

export const workScheduleDays = pgTable(
  "work_schedule_days",
  {
    id: serial("id").primaryKey(),
    scheduleId: integer("schedule_id")
      .notNull()
      .references(() => workSchedules.id, { onDelete: "cascade" }),
    dayOfWeek: text("day_of_week").notNull(),
    isWorkingDay: boolean("is_working_day").notNull().default(true),
    startTime: time("start_time"),
    endTime: time("end_time"),
    breakMinutes: integer("break_minutes").notNull().default(0),
    notes: text("notes"),
  },
  (t) => [index("idx_wsd_schedule_day").on(t.scheduleId, t.dayOfWeek)],
);

export type WorkScheduleDay = typeof workScheduleDays.$inferSelect;
export type InsertWorkScheduleDay = typeof workScheduleDays.$inferInsert;

export const workScheduleAssignments = pgTable("work_schedule_assignments", {
  id: serial("id").primaryKey(),
  scheduleId: integer("schedule_id")
    .notNull()
    .references(() => workSchedules.id, { onDelete: "cascade" }),
  employeeId: integer("employee_id").notNull(),
  effectiveDate: date("effective_date").notNull(),
  endDate: date("end_date"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type WorkScheduleAssignment = typeof workScheduleAssignments.$inferSelect;
export type InsertWorkScheduleAssignment = typeof workScheduleAssignments.$inferInsert;

export const workScheduleExceptions = pgTable("work_schedule_exceptions", {
  id: serial("id").primaryKey(),
  scheduleId: integer("schedule_id")
    .notNull()
    .references(() => workSchedules.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
  affectedLocationIds: text("affected_location_ids"),
  affectedEmployeeIds: text("affected_employee_ids"),
  isWorkingDay: boolean("is_working_day"),
  startTime: time("start_time"),
  endTime: time("end_time"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type WorkScheduleException = typeof workScheduleExceptions.$inferSelect;
export type InsertWorkScheduleException = typeof workScheduleExceptions.$inferInsert;

export const attendanceRecords = pgTable(
  "attendance_records",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    employeeId: integer("employee_id").notNull(),
    attendanceDate: date("attendance_date").notNull(),
    scheduledStart: time("scheduled_start"),
    scheduledEnd: time("scheduled_end"),
    clockIn: timestamp("clock_in", { withTimezone: true }),
    clockOut: timestamp("clock_out", { withTimezone: true }),
    breakMinutes: integer("break_minutes").notNull().default(0),
    totalMinutes: integer("total_minutes"),
    status: text("status").notNull().default("present"),
    locationId: integer("location_id"),
    source: text("source").notNull().default("manual"),
    notes: text("notes"),
    createdBy: text("created_by"),
    updatedBy: text("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_attendance_records_workspace").on(t.workspaceOwnerId, t.attendanceDate),
    index("idx_attendance_records_employee").on(t.employeeId, t.attendanceDate),
  ],
);

export type AttendanceRecord = typeof attendanceRecords.$inferSelect;
export type InsertAttendanceRecord = typeof attendanceRecords.$inferInsert;

export const blackoutDates = pgTable(
  "blackout_dates",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    restrictionType: text("restriction_type").notNull().default("warning_only"),
    affectedLocationIds: text("affected_location_ids"),
    affectedDepartmentIds: text("affected_department_ids"),
    affectedEmployeeIds: text("affected_employee_ids"),
    affectedLeaveTypeIds: text("affected_leave_type_ids"),
    employeeMessage: text("employee_message"),
    allowExceptions: boolean("allow_exceptions").notNull().default(false),
    exceptionApproverType: text("exception_approver_type"),
    status: text("status").notNull().default("upcoming"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_blackout_dates_workspace").on(t.workspaceOwnerId)],
);

export type BlackoutDate = typeof blackoutDates.$inferSelect;
export type InsertBlackoutDate = typeof blackoutDates.$inferInsert;

export const timeOffBalanceAdjustments = pgTable(
  "time_off_balance_adjustments",
  {
    id: serial("id").primaryKey(),
    memberId: integer("member_id").notNull(),
    policyId: integer("policy_id").notNull(),
    policyYear: integer("policy_year").notNull(),
    vacationEntitledBefore: numeric("vacation_entitled_before", { precision: 6, scale: 2 }).notNull(),
    vacationEntitledAfter: numeric("vacation_entitled_after", { precision: 6, scale: 2 }).notNull(),
    reason: text("reason").notNull(),
    adjustedByMemberId: integer("adjusted_by_member_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_toba_member").on(t.memberId, t.createdAt),
  ],
);

export type TimeOffBalanceAdjustment = typeof timeOffBalanceAdjustments.$inferSelect;
export type InsertTimeOffBalanceAdjustment = typeof timeOffBalanceAdjustments.$inferInsert;

export const peopleAuditLog = pgTable(
  "people_audit_log",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    teamMemberId: integer("team_member_id").notNull(),
    changedByUserId: text("changed_by_user_id").notNull(),
    fieldName: text("field_name").notNull(),
    oldValue: text("old_value"),
    newValue: text("new_value"),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_pal_team_member").on(t.teamMemberId, t.changedAt),
  ],
);

export type PeopleAuditLog = typeof peopleAuditLog.$inferSelect;
export type InsertPeopleAuditLog = typeof peopleAuditLog.$inferInsert;

export const externalProfiles = pgTable(
  "external_profiles",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    personId: integer("person_id").notNull(),
    externalType: text("external_type").notNull().default("other"),
    companyName: text("company_name"),
    internalOwnerPersonId: integer("internal_owner_person_id"),
    reasonForAccess: text("reason_for_access"),
    notes: text("notes"),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_external_profiles_workspace").on(t.workspaceOwnerId),
    index("idx_external_profiles_person").on(t.personId, t.workspaceOwnerId),
  ],
);

export type ExternalProfile = typeof externalProfiles.$inferSelect;
export type InsertExternalProfile = typeof externalProfiles.$inferInsert;

export const locationActivityLog = pgTable(
  "location_activity_log",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    locationId: integer("location_id").notNull(),
    eventType: text("event_type").notNull(),
    subjectId: text("subject_id"),
    subjectName: text("subject_name"),
    actorEmail: text("actor_email"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_location_activity_log_location").on(
      t.workspaceOwnerId,
      t.locationId,
      t.occurredAt,
    ),
  ],
);

export type LocationActivityLog = typeof locationActivityLog.$inferSelect;
export type InsertLocationActivityLog = typeof locationActivityLog.$inferInsert;

export const attendanceSessions = pgTable(
  "attendance_sessions",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    employeeId: integer("employee_id").notNull(),
    locationId: integer("location_id"),
    scheduledShiftId: integer("scheduled_shift_id"),
    clockInAt: timestamp("clock_in_at", { withTimezone: true }).notNull(),
    clockOutAt: timestamp("clock_out_at", { withTimezone: true }),
    clockInLatitude: doublePrecision("clock_in_latitude"),
    clockInLongitude: doublePrecision("clock_in_longitude"),
    clockInAccuracyMeters: doublePrecision("clock_in_accuracy_meters"),
    clockInDistanceMeters: doublePrecision("clock_in_distance_meters"),
    clockOutLatitude: doublePrecision("clock_out_latitude"),
    clockOutLongitude: doublePrecision("clock_out_longitude"),
    clockOutAccuracyMeters: doublePrecision("clock_out_accuracy_meters"),
    clockOutDistanceMeters: doublePrecision("clock_out_distance_meters"),
    clockInVerificationStatus: text("clock_in_verification_status")
      .notNull()
      .default("no_location"),
    clockOutVerificationStatus: text("clock_out_verification_status"),
    status: text("status").notNull().default("open"),
    lateMinutes: integer("late_minutes").notNull().default(0),
    earlyLeaveMinutes: integer("early_leave_minutes").notNull().default(0),
    grossMinutes: integer("gross_minutes"),
    breakMinutes: integer("break_minutes").notNull().default(0),
    paidMinutes: integer("paid_minutes"),
    overtimeMinutes: integer("overtime_minutes").notNull().default(0),
    employeeNote: text("employee_note"),
    managerNote: text("manager_note"),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    rejectedBy: text("rejected_by"),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    missedClockoutNotifSentAt: timestamp("missed_clockout_notif_sent_at", {
      withTimezone: true,
    }),
    missedClockoutReminderSentAt: timestamp("missed_clockout_reminder_sent_at", {
      withTimezone: true,
    }),
  },
  (t) => [
    index("idx_att_sessions_workspace").on(t.workspaceOwnerId, t.clockInAt),
    index("idx_att_sessions_employee").on(t.employeeId, t.clockInAt),
    index("idx_att_sessions_status").on(t.workspaceOwnerId, t.status),
    uniqueIndex("idx_att_sessions_uniq_emp_clockin").on(
      t.workspaceOwnerId,
      t.employeeId,
      t.clockInAt,
    ),
    uniqueIndex("idx_att_sessions_uniq_emp_clockin_narrow").on(t.employeeId, t.clockInAt),
  ],
);

export type AttendanceSession = typeof attendanceSessions.$inferSelect;
export type InsertAttendanceSession = typeof attendanceSessions.$inferInsert;

export const attendanceBreaks = pgTable(
  "attendance_breaks",
  {
    id: serial("id").primaryKey(),
    attendanceSessionId: integer("attendance_session_id").notNull(),
    employeeId: integer("employee_id").notNull(),
    breakStartAt: timestamp("break_start_at", { withTimezone: true }).notNull(),
    breakEndAt: timestamp("break_end_at", { withTimezone: true }),
    breakType: text("break_type").notNull().default("other"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_att_breaks_session").on(t.attendanceSessionId),
    index("idx_att_breaks_employee").on(t.employeeId, t.breakStartAt),
  ],
);

export type AttendanceBreak = typeof attendanceBreaks.$inferSelect;
export type InsertAttendanceBreak = typeof attendanceBreaks.$inferInsert;

export const attendanceRequests = pgTable(
  "attendance_requests",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    employeeId: integer("employee_id").notNull(),
    attendanceSessionId: integer("attendance_session_id"),
    requestType: text("request_type").notNull(),
    requestedClockInAt: timestamp("requested_clock_in_at", { withTimezone: true }),
    requestedClockOutAt: timestamp("requested_clock_out_at", { withTimezone: true }),
    requestedLocationId: integer("requested_location_id"),
    reason: text("reason"),
    status: text("status").notNull().default("pending"),
    reviewedBy: text("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewerNote: text("reviewer_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    isRead: boolean("is_read").notNull().default(false),
  },
  (t) => [
    index("idx_att_requests_workspace").on(t.workspaceOwnerId, t.status, t.createdAt),
    index("idx_att_requests_employee").on(t.employeeId, t.createdAt),
    uniqueIndex("uq_att_requests_pending_session_type")
      .on(t.employeeId, t.attendanceSessionId, t.requestType)
      .where(sql`${t.status} = 'pending'`),
    uniqueIndex("uq_att_requests_pending_null_session_type")
      .on(t.employeeId, t.requestType)
      .where(sql`${t.status} = 'pending' AND ${t.attendanceSessionId} IS NULL`),
  ],
);

export type AttendanceRequest = typeof attendanceRequests.$inferSelect;
export type InsertAttendanceRequest = typeof attendanceRequests.$inferInsert;

export const attendanceAuditLogs = pgTable(
  "attendance_audit_logs",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    attendanceSessionId: integer("attendance_session_id"),
    attendanceRequestId: integer("attendance_request_id"),
    actorUserId: text("actor_user_id").notNull(),
    action: text("action").notNull(),
    oldValueJson: jsonb("old_value_json"),
    newValueJson: jsonb("new_value_json"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_att_audit_session").on(t.attendanceSessionId, t.createdAt),
    index("idx_att_audit_workspace").on(t.workspaceOwnerId, t.createdAt),
  ],
);

export type AttendanceAuditLog = typeof attendanceAuditLogs.$inferSelect;
export type InsertAttendanceAuditLog = typeof attendanceAuditLogs.$inferInsert;
