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
  doublePrecision,
  unique,
  uniqueIndex,
  index,
  primaryKey,
  customType,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Custom types
// ---------------------------------------------------------------------------

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

// ---------------------------------------------------------------------------
// workspace_roles  (defined before workspace_members to allow FK reference)
// ---------------------------------------------------------------------------

export const workspaceRoles = pgTable(
  "workspace_roles",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    name: text("name").notNull(),
    allowedPages: jsonb("allowed_pages").notNull().default(sql`'[]'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    description: text("description"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("workspace_roles_name_workspace").on(t.workspaceOwnerId, t.name),
    index("idx_workspace_roles_owner").on(t.workspaceOwnerId),
  ],
);

export type WorkspaceRole = typeof workspaceRoles.$inferSelect;
export type InsertWorkspaceRole = typeof workspaceRoles.$inferInsert;

// ---------------------------------------------------------------------------
// workspace_members
// ---------------------------------------------------------------------------

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    memberUserId: text("member_user_id"),
    memberEmail: text("member_email").notNull(),
    role: text("role").notNull().default("member"),
    invitedByUserId: text("invited_by_user_id"),
    invitedByEmail: text("invited_by_email"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    joinedAt: timestamp("joined_at", { withTimezone: true }),
    // Emergency contact columns
    ecName: text("ec_name"),
    ecRelationship: text("ec_relationship"),
    ecPhoneCountryCode: text("ec_phone_country_code"),
    ecPhone: text("ec_phone"),
    // Security notification preferences
    notifyEmailOnNewSignIn: boolean("notify_email_on_new_sign_in")
      .notNull()
      .default(true),
    lastCountryAlertAt: timestamp("last_country_alert_at", {
      withTimezone: true,
    }),
    // Manager relationship
    managerMemberId: integer("manager_member_id"),
    // Time-off notification preferences
    notifyEmailOnTimeOffRequest: boolean("notify_email_on_time_off_request")
      .notNull()
      .default(true),
    notifyEmailOnTimeOffDecision: boolean("notify_email_on_time_off_decision")
      .notNull()
      .default(true),
    // Email preferences — per-user opt-outs for staff/owner emails
    notifyEmailOnNewOrder: boolean("notify_email_on_new_order")
      .notNull()
      .default(true),
    notifyEmailWeeklyDigest: boolean("notify_email_weekly_digest")
      .notNull()
      .default(true),
    // Invite token / expiry
    inviteToken: text("invite_token"),
    inviteExpiresAt: timestamp("invite_expires_at", { withTimezone: true }),
    // Custom role FK
    customRoleId: integer("custom_role_id").references(
      () => workspaceRoles.id,
      { onDelete: "set null" },
    ),
    // HR profile fields
    birthday: date("birthday"),
    gender: text("gender"),
    workingDays: jsonb("working_days"),
    phone: text("phone"),
    jobTitle: text("job_title"),
    startDate: date("start_date"),
    department: text("department"),
    location: text("location"),
    employmentType: text("employment_type"),
    employmentStatus: text("employment_status").notNull().default("active"),
    // Access control columns
    accessExpiresAt: timestamp("access_expires_at", { withTimezone: true }),
    revokedBy: text("revoked_by"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    // UI preferences
    prefAddPersonLastType: text("pref_add_person_last_type"),
    uiPreferences: jsonb("ui_preferences")
      .notNull()
      .default(sql`'{}'::jsonb`),
    // Florist Orders: the workspace location this member works at as a florist.
    // Required (enforced at the API layer) for members whose role grants the
    // `florist_orders` page; null for everyone else.
    floristLocationId: integer("florist_location_id").references(
      () => locations.id,
      { onDelete: "set null" },
    ),
  },
  (t) => [
    unique("workspace_members_email_unique").on(
      t.workspaceOwnerId,
      t.memberEmail,
    ),
    uniqueIndex("idx_wm_unique_member")
      .on(t.memberUserId)
      .where(sql`${t.memberUserId} IS NOT NULL`),
    index("idx_wm_owner").on(t.workspaceOwnerId),
    uniqueIndex("idx_wm_invite_token")
      .on(t.inviteToken)
      .where(sql`${t.inviteToken} IS NOT NULL`),
  ],
);

export type WorkspaceMember = typeof workspaceMembers.$inferSelect;
export type InsertWorkspaceMember = typeof workspaceMembers.$inferInsert;

export const appleIdentities = pgTable(
  "apple_identities",
  {
    appleSubject: text("apple_subject").primaryKey(),
    clerkUserId: text("clerk_user_id").notNull(),
    linkedEmail: text("linked_email").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSignedInAt: timestamp("last_signed_in_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("idx_apple_identities_clerk_user").on(t.clerkUserId)],
);

export type AppleIdentity = typeof appleIdentities.$inferSelect;
export type InsertAppleIdentity = typeof appleIdentities.$inferInsert;

export const appleAuthChallenges = pgTable(
  "apple_auth_challenges",
  {
    nonceHash: text("nonce_hash").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_apple_auth_challenges_expiry").on(t.expiresAt)],
);

export const mobileAuthSessions = pgTable(
  "mobile_auth_sessions",
  {
    id: text("id").primaryKey(),
    clerkUserId: text("clerk_user_id").notNull(),
    userUpdatedAt: numeric("user_updated_at", { precision: 20, scale: 0 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_mobile_auth_sessions_user").on(t.clerkUserId),
    index("idx_mobile_auth_sessions_expiry").on(t.expiresAt),
  ],
);

// ---------------------------------------------------------------------------
// workspace_member_roles  (junction table for multi-role support)
// ---------------------------------------------------------------------------

export const workspaceMemberRoles = pgTable(
  "workspace_member_roles",
  {
    memberId: integer("member_id")
      .notNull()
      .references(() => workspaceMembers.id, { onDelete: "cascade" }),
    roleId: integer("role_id")
      .notNull()
      .references(() => workspaceRoles.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.memberId, t.roleId] }),
    index("idx_wmr_member_id").on(t.memberId),
    index("idx_wmr_role_id").on(t.roleId),
  ],
);

export type WorkspaceMemberRole = typeof workspaceMemberRoles.$inferSelect;

// ---------------------------------------------------------------------------
// workspace_settings
// ---------------------------------------------------------------------------

export const workspaceSettings = pgTable("workspace_settings", {
  workspaceOwnerId: text("workspace_owner_id").primaryKey(),
  offlineAlertThresholdMinutes: integer("offline_alert_threshold_minutes")
    .notNull()
    .default(5),
  offlineAlertEmailEnabled: boolean("offline_alert_email_enabled")
    .notNull()
    .default(false),
  availableCountries: text("available_countries")
    .array()
    .notNull()
    .default(sql`ARRAY['Lebanon', 'United Arab Emirates']`),
  workspaceSlug: text("workspace_slug").unique(),
  // Per-marketplace-channel commission rates (percent), keyed by canonical
  // channel key (toters/deliveroo/careem/talabat/website/pos/whatsapp).
  // Consumed by the Marketplace Analytics section; code supplies defaults for
  // any missing key.
  marketplaceCommissionRates: jsonb("marketplace_commission_rates")
    .notNull()
    .default(sql`'{}'::jsonb`),
  // Per-workspace on/off switch for Trustpilot review invitations (the
  // TRUSTPILOT_ENABLED env flag is the global master switch).
  trustpilotInvitationsEnabled: boolean("trustpilot_invitations_enabled")
    .notNull()
    .default(true),
  // Minutes past a location's daily-close cutoff before an open cash session
  // is considered overdue (default 120 = 2 hours).
  cashSessionOverdueGraceMinutes: integer("cash_session_overdue_grace_minutes")
    .notNull()
    .default(120),
  // Google review page URL used by the Review Rewards scan redirect. Nullable —
  // code falls back to the module's default URL when unset.
  googleReviewUrl: text("google_review_url"),
});

export type WorkspaceSettings = typeof workspaceSettings.$inferSelect;
export type InsertWorkspaceSettings = typeof workspaceSettings.$inferInsert;

// ---------------------------------------------------------------------------
// locations
// ---------------------------------------------------------------------------

export const locations = pgTable(
  "locations",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    name: text("name").notNull(),
    country: text("country").notNull().default("Lebanon"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    locationType: text("location_type").notNull().default("Point of Sale"),
    // Rent / finance fields
    annualRent: numeric("annual_rent"),
    rentCurrency: text("rent_currency"),
    paymentsPerYear: integer("payments_per_year"),
    // Operations dashboard fields
    status: text("status").notNull().default("active"),
    dailyCapacity: integer("daily_capacity"),
    sameDayCutoffTime: text("same_day_cutoff_time"),
    expressCutoffTime: text("express_cutoff_time"),
    operatingHours: jsonb("operating_hours"),
    timezone: text("timezone"),
    backupLocationId: integer("backup_location_id"),
    autoRoutingEnabled: boolean("auto_routing_enabled").notNull().default(false),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    pausedBy: text("paused_by"),
    pauseReason: text("pause_reason"),
    servedAreaIds: jsonb("served_area_ids"),
    internalNotes: text("internal_notes"),
    address: text("address"),
    // Geofencing / attendance columns
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),
    geofenceRadiusMeters: integer("geofence_radius_meters")
      .notNull()
      .default(100),
    attendanceEnabled: boolean("attendance_enabled").notNull().default(true),
  },
  (t) => [index("idx_locations_workspace").on(t.workspaceOwnerId)],
);

export type Location = typeof locations.$inferSelect;
export type InsertLocation = typeof locations.$inferInsert;

// ---------------------------------------------------------------------------
// member_locations
// ---------------------------------------------------------------------------

export const memberLocations = pgTable(
  "member_locations",
  {
    id: serial("id").primaryKey(),
    memberId: integer("member_id")
      .notNull()
      .references(() => workspaceMembers.id, { onDelete: "cascade" }),
    locationId: integer("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    actorEmail: text("actor_email"),
  },
  (t) => [
    unique().on(t.memberId, t.locationId),
    index("idx_member_locations_member").on(t.memberId),
    index("idx_member_locations_location").on(t.locationId),
  ],
);

export type MemberLocation = typeof memberLocations.$inferSelect;
export type InsertMemberLocation = typeof memberLocations.$inferInsert;

// ---------------------------------------------------------------------------
// channels
// ---------------------------------------------------------------------------

export const channels = pgTable(
  "channels",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    name: text("name").notNull(),
    hasCoverPhoto: boolean("has_cover_photo").notNull().default(true),
    coverPhotoWidth: integer("cover_photo_width"),
    coverPhotoHeight: integer("cover_photo_height"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    logoData: bytea("logo_data"),
    logoMimeType: text("logo_mime_type"),
  },
  (t) => [
    index("idx_channels_workspace").on(t.workspaceOwnerId),
    uniqueIndex("idx_channels_workspace_name_unique").on(
      t.workspaceOwnerId,
      sql`lower(${t.name})`,
    ),
  ],
);

export type Channel = typeof channels.$inferSelect;
export type InsertChannel = typeof channels.$inferInsert;

// ---------------------------------------------------------------------------
// workspace_ingest_keys
// ---------------------------------------------------------------------------

export const workspaceIngestKeys = pgTable(
  "workspace_ingest_keys",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull().unique(),
    keyHash: text("key_hash").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("idx_workspace_ingest_keys_hash").on(t.keyHash),
  ],
);

export type WorkspaceIngestKey = typeof workspaceIngestKeys.$inferSelect;
export type InsertWorkspaceIngestKey = typeof workspaceIngestKeys.$inferInsert;

// ---------------------------------------------------------------------------
// ingest_key_usage — per-endpoint daily call counts
// ---------------------------------------------------------------------------

export const ingestKeyUsage = pgTable(
  "ingest_key_usage",
  {
    ingestKeyId: integer("ingest_key_id")
      .notNull()
      .references(() => workspaceIngestKeys.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull(),
    usageDate: date("usage_date").notNull(),
    callCount: integer("call_count").notNull().default(1),
  },
  (t) => [
    unique("ingest_key_usage_pkey").on(t.ingestKeyId, t.endpoint, t.usageDate),
    index("idx_ingest_key_usage_key_date").on(t.ingestKeyId, t.usageDate),
  ],
);

export type IngestKeyUsage = typeof ingestKeyUsage.$inferSelect;
