import {
  pgTable,
  serial,
  integer,
  text,
  boolean,
  timestamp,
  numeric,
  unique,
  uniqueIndex,
  index,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { orders } from "./orders";

export const fleetDrivers = pgTable(
  "fleet_drivers",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    phone: text("phone"),
    countryCode: text("country_code").notNull().default("+961"),
    email: text("email"),
    taxiCompany: text("taxi_company"),
    vehicleType: text("vehicle_type").notNull(),
    licenseNumber: text("license_number"),
    status: text("status").notNull().default("active"),
    onboardingStatus: text("onboarding_status").notNull().default("pending"),
    availabilityStatus: text("availability_status").notNull().default("offline"),
    notes: text("notes"),
    clerkUserId: text("clerk_user_id"),
    expoPushToken: text("expo_push_token"),
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
    deactivationReason: text("deactivation_reason"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("idx_fleet_drivers_phone_workspace")
      .on(t.workspaceOwnerId, sql`regexp_replace(${t.phone}, '[^+0-9]', '', 'g')`)
      .where(sql`${t.phone} IS NOT NULL AND ${t.deletedAt} IS NULL`),
    uniqueIndex("idx_fleet_drivers_clerk_user_id")
      .on(t.clerkUserId)
      .where(sql`${t.clerkUserId} IS NOT NULL`),
    index("idx_fleet_drivers_workspace")
      .on(t.workspaceOwnerId, t.status)
      .where(sql`${t.deletedAt} IS NULL`),
  ],
);

export const fleetDriverVehicles = pgTable(
  "fleet_driver_vehicles",
  {
    id: serial("id").primaryKey(),
    driverId: integer("driver_id")
      .notNull()
      .references(() => fleetDrivers.id, { onDelete: "cascade" }),
    make: text("make"),
    model: text("model"),
    year: integer("year"),
    plateNumber: text("plate_number"),
    vehicleType: text("vehicle_type").notNull(),
    color: text("color"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_fdv_driver").on(t.driverId)],
);

export const fleetVehicleTypes = pgTable(
  "fleet_vehicle_types",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    name: text("name").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("fleet_vehicle_types_workspace_name_unique").on(t.workspaceOwnerId, t.name),
    index("idx_fvt_workspace")
      .on(t.workspaceOwnerId)
      .where(sql`${t.isActive} = true`),
  ],
);

export const fleetDriverApiTokens = pgTable(
  "fleet_driver_api_tokens",
  {
    id: serial("id").primaryKey(),
    driverId: integer("driver_id")
      .notNull()
      .references(() => fleetDrivers.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    tokenPrefix: text("token_prefix").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => [index("idx_fdat_driver").on(t.driverId)],
);

export const fleetDriverAvailability = pgTable(
  "fleet_driver_availability",
  {
    id: serial("id").primaryKey(),
    driverId: integer("driver_id")
      .notNull()
      .references(() => fleetDrivers.id, { onDelete: "cascade" }),
    dayOfWeek: integer("day_of_week").notNull(),
    startTime: text("start_time").notNull(),
    endTime: text("end_time").notNull(),
  },
  (t) => [unique("fleet_driver_availability_driver_day_unique").on(t.driverId, t.dayOfWeek)],
);

export const fleetDriverOrderAssignments = pgTable(
  "fleet_driver_order_assignments",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    driverId: integer("driver_id")
      .notNull()
      .references(() => fleetDrivers.id, { onDelete: "restrict" }),
    orderId: uuid("order_id").references(() => orders.id, {
      onDelete: "set null",
    }),
    orderReference: text("order_reference").notNull(),
    pickupAddress: text("pickup_address"),
    deliveryAddress: text("delivery_address"),
    status: text("status").notNull().default("pending"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    pickedUpAt: timestamp("picked_up_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_fdoa_workspace").on(t.workspaceOwnerId, t.createdAt),
    index("idx_fdoa_order_id").on(t.orderId),
    index("idx_fdoa_driver").on(t.driverId, t.status),
  ],
);

export const fleetDeliveryEvents = pgTable(
  "fleet_delivery_events",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    assignmentId: integer("assignment_id")
      .notNull()
      .references(() => fleetDriverOrderAssignments.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    notes: text("notes"),
    lat: numeric("lat", { precision: 10, scale: 7 }),
    lng: numeric("lng", { precision: 10, scale: 7 }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_fde_assignment").on(t.assignmentId, t.occurredAt)],
);

export const fleetProofOfDelivery = pgTable(
  "fleet_proof_of_delivery",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    assignmentId: integer("assignment_id")
      .notNull()
      .references(() => fleetDriverOrderAssignments.id, { onDelete: "cascade" }),
    driverId: integer("driver_id").references(() => fleetDrivers.id, { onDelete: "set null" }),
    recipientName: text("recipient_name"),
    notes: text("notes"),
    signatureData: text("signature_data"),
    hasSignature: boolean("has_signature").notNull().default(false),
    imageUrl: text("image_url"),
    latitude: numeric("latitude", { precision: 10, scale: 7 }),
    longitude: numeric("longitude", { precision: 10, scale: 7 }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_fpod_assignment").on(t.assignmentId)],
);

export const driverOtpCodes = pgTable(
  "driver_otp_codes",
  {
    id: serial("id").primaryKey(),
    phoneNumber: text("phone_number").notNull(),
    codeHash: text("code_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    used: boolean("used").notNull().default(false),
    failedAttempts: integer("failed_attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_driver_otp_codes_phone").on(t.phoneNumber, t.expiresAt)],
);

export const fleetDriverTransactions = pgTable(
  "fleet_driver_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    driverId: integer("driver_id")
      .notNull()
      .references(() => fleetDrivers.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    amountCents: integer("amount_cents").notNull(),
    description: text("description").notNull(),
    orderId: text("order_id"),
    date: text("date").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_fdt_driver").on(t.driverId, t.createdAt)],
);

export const fleetDriverNotifications = pgTable(
  "fleet_driver_notifications",
  {
    id: serial("id").primaryKey(),
    driverId: integer("driver_id")
      .notNull()
      .references(() => fleetDrivers.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    body: text("body").notNull(),
    data: text("data"),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_fdn_driver").on(t.driverId, t.createdAt)],
);

export type FleetDriver = typeof fleetDrivers.$inferSelect;
export type FleetVehicleType = typeof fleetVehicleTypes.$inferSelect;
export type FleetDriverApiToken = typeof fleetDriverApiTokens.$inferSelect;
export type FleetDriverOrderAssignment = typeof fleetDriverOrderAssignments.$inferSelect;
export type FleetDeliveryEvent = typeof fleetDeliveryEvents.$inferSelect;
export type FleetProofOfDelivery = typeof fleetProofOfDelivery.$inferSelect;
export type DriverOtpCode = typeof driverOtpCodes.$inferSelect;
export type FleetDriverTransaction = typeof fleetDriverTransactions.$inferSelect;
export type FleetDriverNotification = typeof fleetDriverNotifications.$inferSelect;
