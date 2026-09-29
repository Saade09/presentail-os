import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  date,
  numeric,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { occasionCampaigns } from "./catalogHelpers";

// ---------------------------------------------------------------------------
// campaign_plans — marketing campaign plans tied to an occasion campaign
// ---------------------------------------------------------------------------

export const campaignPlans = pgTable(
  "campaign_plans",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    occasionId: integer("occasion_id")
      .notNull()
      .references(() => occasionCampaigns.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    targetDate: date("target_date").notNull(),
    markets: jsonb("markets").notNull().default(sql`'[]'::jsonb`),
    budget: numeric("budget", { precision: 12, scale: 2 }),
    currency: text("currency").notNull().default("AED"),
    notes: text("notes"),
    status: text("status").notNull().default("draft"),
    // Extended fields added via ALTER TABLE
    channel: text("channel"),
    market: text("market"),
    ownerUserId: text("owner_user_id"),
    startDate: date("start_date"),
    endDate: date("end_date"),
    goal: text("goal"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("idx_campaign_plans_workspace").on(t.workspaceOwnerId, t.targetDate),
    index("idx_campaign_plans_occasion").on(t.occasionId),
  ],
);

export type CampaignPlan = typeof campaignPlans.$inferSelect;
export type InsertCampaignPlan = typeof campaignPlans.$inferInsert;

// ---------------------------------------------------------------------------
// campaign_actions — checklist items for a campaign plan
// ---------------------------------------------------------------------------

export const campaignActions = pgTable(
  "campaign_actions",
  {
    id: serial("id").primaryKey(),
    planId: integer("plan_id")
      .notNull()
      .references(() => campaignPlans.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status").notNull().default("not_started"),
    dueDate: date("due_date"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("idx_campaign_actions_plan").on(t.planId),
  ],
);

export type CampaignAction = typeof campaignActions.$inferSelect;
export type InsertCampaignAction = typeof campaignActions.$inferInsert;
