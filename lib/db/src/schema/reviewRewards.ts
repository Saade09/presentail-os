import {
  pgTable,
  serial,
  integer,
  numeric,
  text,
  boolean,
  timestamp,
  index,
  uniqueIndex,
  jsonb,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { teamMembers } from "./people";
import { workspaceMembers } from "./workspace";

// ---------------------------------------------------------------------------
// Google Review Rewards module
//
// Employee QR profiles carry a random, non-identifying code that is embedded
// in a tracking URL (/reviews/e/{code}). Scans of that URL are logged and
// 302-redirected to the store's Google review page. Ingested Google reviews
// are attributed to the most recent eligible scan within 6 hours; confirmed
// matches create exactly one reward per Google review id, pending for 7 days
// before auto-approval (or voided if the review is deleted).
//
// Multi-location support: one gbp_connections row holds OAuth credentials per
// workspace; gbp_location_connections tracks each enabled GBP location so
// reviews, scans, and profiles are all scoped per location.
// ---------------------------------------------------------------------------

// Forward-declare so employee_review_profiles can reference it
// (gbpLocationConnections is defined below; Drizzle resolves circular refs via thunks)

export const gbpLocationConnections = pgTable(
  "gbp_location_connections",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    // Parent connection that holds the OAuth credentials.
    gbpConnectionId: integer("gbp_connection_id").notNull(),
    // GBP resource name, e.g. "locations/9876543210"
    locationName: text("location_name").notNull(),
    locationTitle: text("location_title"),
    // Structured locality/city used to disambiguate branches sharing a title.
    locationLocality: text("location_locality"),
    // Owning GBP account for location-scoped reconciliation.
    accountName: text("account_name"),
    // Country derived from Google's structured region code.
    country: text("country"),
    isEnabled: boolean("is_enabled").notNull().default(true),
    notificationsState: text("notifications_state"),
    reviewSyncStatus: text("review_sync_status"),
    lastError: text("last_error"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_gbp_location_connections_workspace_location").on(
      t.workspaceOwnerId,
      t.locationName,
    ),
    index("idx_gbp_location_connections_workspace").on(t.workspaceOwnerId),
    index("idx_gbp_location_connections_conn").on(t.gbpConnectionId),
  ],
);

export type GbpLocationConnection = typeof gbpLocationConnections.$inferSelect;
export type InsertGbpLocationConnection = typeof gbpLocationConnections.$inferInsert;

export const employeeReviewProfiles = pgTable(
  "employee_review_profiles",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    employeeName: text("employee_name").notNull(),
    role: text("role"),
    // Reward amount (USD) granted per confirmed review — equal regardless of
    // star rating.
    rewardAmount: numeric("reward_amount", { precision: 10, scale: 2 })
      .notNull()
      .default("0"),
    // Random, non-identifying, globally unique code used in the tracking URL.
    code: text("code").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    // Location this profile belongs to (multi-location support).
    gbpLocationId: integer("gbp_location_id").references(
      () => gbpLocationConnections.id,
      { onDelete: "set null" },
    ),
    teamMemberId: integer("team_member_id").references(() => teamMembers.id, {
      onDelete: "set null",
    }),
    workspaceMemberId: integer("workspace_member_id").references(() => workspaceMembers.id, {
      onDelete: "set null",
    }),
    rewardCurrency: text("reward_currency").notNull().default("USD"),
    // Soft delete — archived profiles keep their scan/reward/audit history but
    // are hidden from listings, scans, and attribution.
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_erp_code").on(t.code),
    uniqueIndex("uq_erp_team_member_location")
      .on(t.workspaceOwnerId, t.gbpLocationId, t.teamMemberId)
      .where(sql`${t.teamMemberId} IS NOT NULL AND ${t.archivedAt} IS NULL`),
    uniqueIndex("uq_erp_workspace_member_location")
      .on(t.workspaceOwnerId, t.gbpLocationId, t.workspaceMemberId)
      .where(sql`${t.workspaceMemberId} IS NOT NULL AND ${t.archivedAt} IS NULL`),
    index("idx_erp_workspace").on(t.workspaceOwnerId),
    index("idx_erp_gbp_location").on(t.gbpLocationId),
  ],
);

export type EmployeeReviewProfile = typeof employeeReviewProfiles.$inferSelect;
export type InsertEmployeeReviewProfile = typeof employeeReviewProfiles.$inferInsert;

export const reviewScans = pgTable(
  "review_scans",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    profileId: integer("profile_id")
      .notNull()
      .references(() => employeeReviewProfiles.id, { onDelete: "cascade" }),
    scannedAt: timestamp("scanned_at", { withTimezone: true }).notNull().defaultNow(),
    // Anonymized device hash (salted SHA-256 of ip+user-agent, truncated).
    deviceHash: text("device_hash"),
    source: text("source"),
    // Repeated scans from the same device hash in a short interval are flagged
    // as suspicious; flagged scans are excluded from auto-matching.
    flagged: boolean("flagged").notNull().default(false),
    // unmatched | matched
    matchStatus: text("match_status").notNull().default("unmatched"),
    matchedReviewId: integer("matched_review_id"),
    // Location this scan was attributed to (copied from the profile at scan time).
    gbpLocationId: integer("gbp_location_id").references(
      () => gbpLocationConnections.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_review_scans_workspace_time").on(t.workspaceOwnerId, t.scannedAt),
    index("idx_review_scans_device").on(t.deviceHash, t.scannedAt),
    index("idx_review_scans_profile").on(t.profileId, t.scannedAt),
    index("idx_review_scans_gbp_location").on(t.gbpLocationId),
  ],
);

export type ReviewScan = typeof reviewScans.$inferSelect;
export type InsertReviewScan = typeof reviewScans.$inferInsert;

export const googleReviews = pgTable(
  "google_reviews",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    // Google's review id — dedupe key (one reward max per review id).
    googleReviewId: text("google_review_id").notNull(),
    reviewerName: text("reviewer_name"),
    rating: integer("rating"),
    comment: text("comment"),
    reviewCreatedAt: timestamp("review_created_at", { withTimezone: true }).notNull(),
    isDeleted: boolean("is_deleted").notNull().default(false),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    // pending | auto_matched | manually_matched | needs_review | rejected | unmatched
    matchStatus: text("match_status").notNull().default("pending"),
    matchedScanId: integer("matched_scan_id"),
    matchedProfileId: integer("matched_profile_id"),
    matchReason: text("match_reason"),
    matchResolvedBy: text("match_resolved_by"),
    matchResolvedAt: timestamp("match_resolved_at", { withTimezone: true }),
    // Location this review arrived from (set during ingestion).
    gbpLocationId: integer("gbp_location_id").references(
      () => gbpLocationConnections.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_google_reviews_workspace_review").on(
      t.workspaceOwnerId,
      t.googleReviewId,
    ),
    index("idx_google_reviews_workspace_status").on(t.workspaceOwnerId, t.matchStatus),
    index("idx_google_reviews_gbp_location").on(t.gbpLocationId),
  ],
);

export type GoogleReview = typeof googleReviews.$inferSelect;
export type InsertGoogleReview = typeof googleReviews.$inferInsert;

export const reviewRewards = pgTable(
  "review_rewards",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    reviewId: integer("review_id")
      .notNull()
      .references(() => googleReviews.id, { onDelete: "cascade" }),
    profileId: integer("profile_id")
      .notNull()
      .references(() => employeeReviewProfiles.id, { onDelete: "cascade" }),
    amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
    // pending | approved | paid | voided
    status: text("status").notNull().default("pending"),
    pendingUntil: timestamp("pending_until", { withTimezone: true }).notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    paidBy: text("paid_by"),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidReason: text("void_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Exactly one reward per Google review record.
    uniqueIndex("uq_review_rewards_review").on(t.reviewId),
    index("idx_review_rewards_workspace_status").on(t.workspaceOwnerId, t.status),
    index("idx_review_rewards_profile").on(t.profileId),
  ],
);

export type ReviewReward = typeof reviewRewards.$inferSelect;
export type InsertReviewReward = typeof reviewRewards.$inferInsert;

export const reviewMatchAudit = pgTable(
  "review_match_audit",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    reviewId: integer("review_id"),
    rewardId: integer("reward_id"),
    action: text("action").notNull(),
    actorUserId: text("actor_user_id"),
    details: jsonb("details"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_review_match_audit_review").on(t.reviewId, t.createdAt)],
);

export type ReviewMatchAudit = typeof reviewMatchAudit.$inferSelect;
export type InsertReviewMatchAudit = typeof reviewMatchAudit.$inferInsert;
