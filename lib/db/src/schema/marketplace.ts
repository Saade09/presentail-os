import {
  pgTable,
  serial,
  integer,
  text,
  boolean,
  timestamp,
  numeric,
  date,
  jsonb,
  unique,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

export const marketplaceBrandAliases = pgTable(
  "marketplace_brand_aliases",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    marketplace: text("marketplace").notNull(),
    aliasName: text("alias_name").notNull(),
    brandId: integer("brand_id"),
    locationId: integer("location_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => [
    unique("marketplace_brand_aliases_workspace_marketplace_alias_unique").on(
      t.workspaceOwnerId,
      t.marketplace,
      t.aliasName,
    ),
    index("idx_marketplace_brand_aliases_workspace").on(t.workspaceOwnerId, t.marketplace),
  ],
);

export const marketplaceReportImports = pgTable(
  "marketplace_report_imports",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    sourceType: text("source_type").notNull().default("webhook_email"),
    marketplace: text("marketplace").notNull().default("toters"),
    importStatus: text("import_status").notNull().default("pending"),
    pdfStoragePath: text("pdf_storage_path"),
    pdfSha256: text("pdf_sha256"),
    emailMessageId: text("email_message_id"),
    detectedMerchantName: text("detected_merchant_name"),
    detectedBrandId: integer("detected_brand_id"),
    detectedLocationId: integer("detected_location_id"),
    autoMatchedAliasId: integer("auto_matched_alias_id"),
    reportPeriodStart: date("report_period_start"),
    reportPeriodEnd: date("report_period_end"),
    extractedData: jsonb("extracted_data"),
    notes: text("notes"),
    approvedReportId: integer("approved_report_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_marketplace_report_imports_workspace").on(t.workspaceOwnerId, t.createdAt),
    index("idx_marketplace_report_imports_brand").on(t.workspaceOwnerId, t.detectedBrandId),
  ],
);

export const marketplaceReports = pgTable(
  "marketplace_reports",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    importId: integer("import_id").notNull(),
    marketplace: text("marketplace").notNull(),
    brandId: integer("brand_id").notNull(),
    locationId: integer("location_id").notNull().default(0),
    reportPeriodStart: date("report_period_start").notNull(),
    reportPeriodEnd: date("report_period_end").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("marketplace_reports_unique_per_period").on(
      t.workspaceOwnerId,
      t.marketplace,
      t.brandId,
      t.locationId,
      t.reportPeriodStart,
      t.reportPeriodEnd,
    ),
    index("idx_marketplace_reports_workspace_brand").on(
      t.workspaceOwnerId,
      t.brandId,
      t.reportPeriodStart,
    ),
  ],
);

export const marketplaceReportMetrics = pgTable(
  "marketplace_report_metrics",
  {
    id: serial("id").primaryKey(),
    reportId: integer("report_id").notNull(),
    metricName: text("metric_name").notNull(),
    metricValue: numeric("metric_value"),
    metricUnit: text("metric_unit"),
    category: text("category"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_marketplace_report_metrics_report").on(t.reportId)],
);

export const marketplaceReportWeeklyTrends = pgTable(
  "marketplace_report_weekly_trends",
  {
    id: serial("id").primaryKey(),
    reportId: integer("report_id").notNull(),
    weekLabel: text("week_label").notNull(),
    weekStart: date("week_start"),
    value: numeric("value"),
    metricName: text("metric_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_marketplace_report_weekly_trends_report").on(t.reportId)],
);

export const marketplaceReportItems = pgTable(
  "marketplace_report_items",
  {
    id: serial("id").primaryKey(),
    reportId: integer("report_id").notNull(),
    itemName: text("item_name").notNull(),
    rank: integer("rank"),
    quantity: numeric("quantity"),
    revenue: numeric("revenue"),
    matchStatus: text("match_status").notNull().default("unmatched"),
    matchedProductId: integer("matched_product_id"),
    matchScore: numeric("match_score"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_marketplace_report_items_report").on(t.reportId)],
);

export type MarketplaceBrandAlias = typeof marketplaceBrandAliases.$inferSelect;
export type InsertMarketplaceBrandAlias = typeof marketplaceBrandAliases.$inferInsert;

export type MarketplaceReportImport = typeof marketplaceReportImports.$inferSelect;
export type InsertMarketplaceReportImport = typeof marketplaceReportImports.$inferInsert;

export type MarketplaceReport = typeof marketplaceReports.$inferSelect;
export type InsertMarketplaceReport = typeof marketplaceReports.$inferInsert;

export type MarketplaceReportMetric = typeof marketplaceReportMetrics.$inferSelect;
export type MarketplaceReportWeeklyTrend = typeof marketplaceReportWeeklyTrends.$inferSelect;
export type MarketplaceReportItem = typeof marketplaceReportItems.$inferSelect;
