import {
  pgTable,
  serial,
  text,
  timestamp,
  jsonb,
  boolean,
  integer,
  numeric,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const backlinkCompetitors = pgTable(
  "backlink_competitors",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    domain: text("domain").notNull(),
    market: text("market").notNull().default("uae"),
    active: boolean("active").notNull().default(true),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_backlink_competitors_workspace").on(t.workspaceOwnerId),
    uniqueIndex("idx_backlink_competitors_workspace_domain").on(t.workspaceOwnerId, t.domain),
  ],
);

export const backlinkOpportunities = pgTable(
  "backlink_opportunities",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    domain: text("domain").notNull(),
    normalizedDomain: text("normalized_domain").notNull(),
    pageUrl: text("page_url").notNull(),
    opportunityType: text("opportunity_type"),
    market: text("market").notNull().default("uae"),
    source: text("source"),
    destinationUrl: text("destination_url"),
    domainAuthority: numeric("domain_authority", { precision: 5, scale: 2 }),
    estimatedTraffic: integer("estimated_traffic"),
    spamScore: numeric("spam_score", { precision: 5, scale: 2 }),
    aiScore: numeric("ai_score", { precision: 5, scale: 2 }),
    aiScoreComponents: jsonb("ai_score_components"),
    aiExplanation: text("ai_explanation"),
    status: text("status").notNull().default("discovered"),
    ownerUserId: text("owner_user_id"),
    duplicateOfId: integer("duplicate_of_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
  },
  (t) => [
    index("idx_backlink_opportunities_workspace").on(t.workspaceOwnerId, t.status),
    index("idx_backlink_opportunities_score").on(t.workspaceOwnerId, t.aiScore),
    uniqueIndex("idx_backlink_opportunities_dedup").on(
      t.workspaceOwnerId,
      t.normalizedDomain,
      t.pageUrl,
    ),
  ],
);

export const backlinkContacts = pgTable(
  "backlink_contacts",
  {
    id: serial("id").primaryKey(),
    opportunityId: integer("opportunity_id").notNull(),
    name: text("name"),
    role: text("role"),
    email: text("email"),
    confidence: numeric("confidence", { precision: 5, scale: 2 }),
    source: text("source"),
    doNotContact: boolean("do_not_contact").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_backlink_contacts_opportunity").on(t.opportunityId)],
);

export const backlinkCampaigns = pgTable(
  "backlink_campaigns",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    name: text("name").notNull(),
    market: text("market"),
    opportunityType: text("opportunity_type"),
    targetUrl: text("target_url"),
    contentAsset: text("content_asset"),
    status: text("status").notNull().default("active"),
    coolingPeriodDays: integer("cooling_period_days").notNull().default(30),
    maxFollowups: integer("max_followups").notNull().default(2),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_backlink_campaigns_workspace").on(t.workspaceOwnerId)],
);

export const backlinkMessages = pgTable(
  "backlink_messages",
  {
    id: serial("id").primaryKey(),
    campaignId: integer("campaign_id").notNull(),
    opportunityId: integer("opportunity_id").notNull(),
    contactId: integer("contact_id"),
    subject: text("subject"),
    body: text("body"),
    status: text("status").notNull().default("draft"),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    sequenceNumber: integer("sequence_number").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_backlink_messages_campaign").on(t.campaignId),
    index("idx_backlink_messages_opportunity").on(t.opportunityId),
    index("idx_backlink_messages_status").on(t.status, t.sentAt),
    uniqueIndex("idx_backlink_messages_dedup").on(
      t.contactId,
      t.campaignId,
      t.sequenceNumber,
    ),
  ],
);

export const backlinkLinks = pgTable(
  "backlink_links",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    opportunityId: integer("opportunity_id"),
    sourceUrl: text("source_url").notNull(),
    destinationUrl: text("destination_url").notNull(),
    anchorText: text("anchor_text"),
    relType: text("rel_type").notNull().default("follow"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    httpStatus: integer("http_status"),
    status: text("status").notNull().default("live"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_backlink_links_workspace").on(t.workspaceOwnerId, t.status),
    index("idx_backlink_links_check_due").on(t.status, t.lastCheckedAt),
  ],
);

export const backlinkMonitorChecks = pgTable(
  "backlink_monitor_checks",
  {
    id: serial("id").primaryKey(),
    linkId: integer("link_id").notNull(),
    checkedAt: timestamp("checked_at", { withTimezone: true }).defaultNow().notNull(),
    httpStatus: integer("http_status"),
    relType: text("rel_type"),
    anchorText: text("anchor_text"),
    destinationUrl: text("destination_url"),
    status: text("status"),
    notes: text("notes"),
  },
  (t) => [index("idx_backlink_monitor_checks_link").on(t.linkId, t.checkedAt)],
);

export const backlinkOpportunityNotes = pgTable(
  "backlink_opportunity_notes",
  {
    id: serial("id").primaryKey(),
    opportunityId: integer("opportunity_id").notNull(),
    userId: text("user_id").notNull(),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_backlink_opportunity_notes_opp").on(t.opportunityId, t.createdAt)],
);

export const backlinkAuditEvents = pgTable(
  "backlink_audit_events",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    action: text("action").notNull(),
    userId: text("user_id"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_backlink_audit_events_workspace").on(t.workspaceOwnerId, t.createdAt),
    index("idx_backlink_audit_events_entity").on(t.entityType, t.entityId),
  ],
);

export const backlinkJobRuns = pgTable(
  "backlink_job_runs",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    jobType: text("job_type").notNull(),
    status: text("status").notNull().default("running"),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    recordsProcessed: integer("records_processed").notNull().default(0),
    error: text("error"),
  },
  (t) => [index("idx_backlink_job_runs_workspace").on(t.workspaceOwnerId, t.jobType, t.startedAt)],
);

export const backlinkSuppressionList = pgTable(
  "backlink_suppression_list",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    email: text("email"),
    domain: text("domain"),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("idx_backlink_suppression_workspace").on(t.workspaceOwnerId)],
);

export const backlinkSettings = pgTable("backlink_settings", {
  id: serial("id").primaryKey(),
  workspaceOwnerId: text("workspace_owner_id").notNull().unique(),
  seoProvider: text("seo_provider").notNull().default("stub"),
  qualificationThreshold: integer("qualification_threshold").notNull().default(70),
  scoringWeights: jsonb("scoring_weights"),
  followupTimingDays: jsonb("followup_timing_days"),
  maxFollowups: integer("max_followups").notNull().default(2),
  dailySendLimit: integer("daily_send_limit").notNull().default(20),
  coolingPeriodDays: integer("cooling_period_days").notNull().default(30),
  discoveryJobCron: text("discovery_job_cron").notNull().default("0 3 * * *"),
  monitorJobCron: text("monitor_job_cron").notNull().default("0 4 * * 0"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type BacklinkCompetitor = typeof backlinkCompetitors.$inferSelect;
export type BacklinkOpportunity = typeof backlinkOpportunities.$inferSelect;
export type BacklinkContact = typeof backlinkContacts.$inferSelect;
export type BacklinkCampaign = typeof backlinkCampaigns.$inferSelect;
export type BacklinkMessage = typeof backlinkMessages.$inferSelect;
export type BacklinkLink = typeof backlinkLinks.$inferSelect;
export type BacklinkMonitorCheck = typeof backlinkMonitorChecks.$inferSelect;
export type BacklinkOpportunityNote = typeof backlinkOpportunityNotes.$inferSelect;
export type BacklinkAuditEvent = typeof backlinkAuditEvents.$inferSelect;
export type BacklinkJobRun = typeof backlinkJobRuns.$inferSelect;
export type BacklinkSuppressionEntry = typeof backlinkSuppressionList.$inferSelect;
export type BacklinkSettings = typeof backlinkSettings.$inferSelect;
