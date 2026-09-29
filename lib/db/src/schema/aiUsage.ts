import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const aiUsageLog = pgTable(
  "ai_usage_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    actionKey: text("action_key").notNull(),
    surface: text("surface").notNull(),
    provider: text("provider").notNull(),
    modelId: text("model_id").notNull(),
    keySource: text("key_source").notNull(),
    wasFallback: boolean("was_fallback").notNull().default(false),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cachedTokens: integer("cached_tokens"),
    reasoningTokens: integer("reasoning_tokens"),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
    costSource: text("cost_source"),
    imageSize: text("image_size"),
    imageQuality: text("image_quality"),
    latencyMs: integer("latency_ms"),
    success: boolean("success").notNull(),
    errorCode: text("error_code"),
    orderId: text("order_id"),
    sessionId: text("session_id"),
    country: text("country"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_ai_usage_created").on(t.createdAt.desc()),
    index("idx_ai_usage_action").on(t.actionKey, t.createdAt.desc()),
    index("idx_ai_usage_order")
      .on(t.orderId)
      .where(sql`${t.orderId} IS NOT NULL`),
  ],
);

export type AiUsageLog = typeof aiUsageLog.$inferSelect;
export type InsertAiUsageLog = typeof aiUsageLog.$inferInsert;
