import {
  pgTable,
  serial,
  text,
  timestamp,
  numeric,
  index,
  unique,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// exchange_rates — cached exchange rate data per workspace
// ---------------------------------------------------------------------------

export const exchangeRates = pgTable(
  "exchange_rates",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    baseCurrency: text("base_currency").notNull(),
    targetCurrency: text("target_currency").notNull(),
    rate: numeric("rate", { precision: 20, scale: 10 }).notNull(),
    provider: text("provider").notNull().default("exchangerate-api.com"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("exchange_rates_workspace_pair_unique").on(
      t.workspaceOwnerId,
      t.baseCurrency,
      t.targetCurrency,
    ),
    index("idx_exchange_rates_owner").on(t.workspaceOwnerId),
  ],
);

export type ExchangeRate = typeof exchangeRates.$inferSelect;
export type InsertExchangeRate = typeof exchangeRates.$inferInsert;

// ---------------------------------------------------------------------------
// exchange_rate_settings — per-workspace markup and rounding configuration
// ---------------------------------------------------------------------------

export const exchangeRateSettings = pgTable("exchange_rate_settings", {
  workspaceOwnerId: text("workspace_owner_id").primaryKey(),
  defaultMarkupPercentage: numeric("default_markup_percentage", {
    precision: 6,
    scale: 3,
  })
    .notNull()
    .default("0"),
  roundingRule: text("rounding_rule").notNull().default("round_up_whole"),
  // Added via ALTER TABLE
  baseCurrency: text("base_currency").notNull().default("USD"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type ExchangeRateSettings = typeof exchangeRateSettings.$inferSelect;
export type InsertExchangeRateSettings = typeof exchangeRateSettings.$inferInsert;
