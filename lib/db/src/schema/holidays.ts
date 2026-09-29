import {
  pgTable,
  serial,
  integer,
  text,
  boolean,
  timestamp,
  date,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// public_holiday_calendars — named holiday calendars per workspace
// ---------------------------------------------------------------------------

export const publicHolidayCalendars = pgTable(
  "public_holiday_calendars",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    name: text("name").notNull(),
    countryCode: text("country_code"),
    locationId: integer("location_id"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("idx_phc_workspace").on(t.workspaceOwnerId)],
);

export type PublicHolidayCalendar = typeof publicHolidayCalendars.$inferSelect;
export type InsertPublicHolidayCalendar =
  typeof publicHolidayCalendars.$inferInsert;

// ---------------------------------------------------------------------------
// public_holidays — individual holiday entries within a calendar
// ---------------------------------------------------------------------------

export const publicHolidays = pgTable(
  "public_holidays",
  {
    id: serial("id").primaryKey(),
    calendarId: integer("calendar_id")
      .notNull()
      .references(() => publicHolidayCalendars.id, { onDelete: "cascade" }),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    name: text("name").notNull(),
    date: date("date").notNull(),
    endDate: date("end_date"),
    isPaid: boolean("is_paid").notNull().default(true),
    description: text("description"),
    createdByMemberId: integer("created_by_member_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Import-related columns added after initial release
    localName: text("local_name"),
    observedDate: date("observed_date"),
    year: integer("year"),
    countryCode: text("country_code"),
    regionCode: text("region_code"),
    type: text("type"),
    status: text("status"),
    source: text("source").notNull().default("Manual"),
    notes: text("notes"),
    createdBy: text("created_by"),
    updatedBy: text("updated_by"),
  },
  (t) => [
    index("idx_ph_calendar").on(t.calendarId, t.date),
    unique("public_holidays_calendar_date_name_unique").on(
      t.calendarId,
      t.date,
      t.name,
    ),
  ],
);

export type PublicHoliday = typeof publicHolidays.$inferSelect;
export type InsertPublicHoliday = typeof publicHolidays.$inferInsert;

// ---------------------------------------------------------------------------
// user_holiday_calendars — assigns a holiday calendar to a member
// ---------------------------------------------------------------------------

export const userHolidayCalendars = pgTable(
  "user_holiday_calendars",
  {
    id: serial("id").primaryKey(),
    memberId: integer("member_id").notNull(),
    calendarId: integer("calendar_id")
      .notNull()
      .references(() => publicHolidayCalendars.id, { onDelete: "cascade" }),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    effectiveFrom: date("effective_from").notNull().default(sql`CURRENT_DATE`),
    effectiveTo: date("effective_to"),
    assignedByMemberId: integer("assigned_by_member_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_uhc_member").on(t.memberId),
    unique("user_holiday_calendars_member_calendar_unique").on(
      t.memberId,
      t.calendarId,
    ),
  ],
);

export type UserHolidayCalendar = typeof userHolidayCalendars.$inferSelect;
export type InsertUserHolidayCalendar =
  typeof userHolidayCalendars.$inferInsert;
