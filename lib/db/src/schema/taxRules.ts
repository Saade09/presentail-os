import {
  pgTable,
  integer,
  text,
  boolean,
  timestamp,
  numeric,
  date,
  uuid,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { locations } from "./workspace";

export const TAX_CATEGORIES = [
  "not_classified",
  "standard_taxable",
  "zero_rated",
  "exempt",
  "non_taxable",
  "food_grocery",
  "packaging",
  "service",
  "import_related",
] as const;

export type TaxCategory = (typeof TAX_CATEGORIES)[number];

export const taxRules = pgTable(
  "tax_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    countryCode: text("country_code").notNull(),
    locationId: integer("location_id").references(() => locations.id, {
      onDelete: "set null",
    }),
    taxCategory: text("tax_category").notNull(),
    ratePercent: numeric("rate_percent", { precision: 6, scale: 4 }).notNull(),
    effectiveFrom: date("effective_from").notNull().default(sql`CURRENT_DATE`),
    effectiveTo: date("effective_to"),
    isActive: boolean("is_active").notNull().default(true),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("idx_tax_rules_unique_rule").on(
      t.workspaceOwnerId,
      t.countryCode,
      sql`COALESCE(CAST(location_id AS text), '')`,
      t.taxCategory,
      t.effectiveFrom,
    ),
    index("idx_tax_rules_workspace").on(
      t.workspaceOwnerId,
      t.isActive,
      t.countryCode,
      t.taxCategory,
    ),
  ],
);

export type TaxRule = typeof taxRules.$inferSelect;
export type InsertTaxRule = typeof taxRules.$inferInsert;

export const insertTaxRuleSchema = createInsertSchema(taxRules, {
  countryCode: z
    .string({ message: "country_code is required" })
    .transform((v) => v.trim())
    .pipe(z.string().min(1, "country_code is required")),
  taxCategory: z
    .string()
    .refine(
      (v) => (TAX_CATEGORIES as readonly string[]).includes(v),
      { message: `tax_category must be one of: ${TAX_CATEGORIES.join(", ")}` },
    ),
  ratePercent: z
    .coerce
    .number({ message: "rate_percent must be a number between 0 and 100" })
    .min(0, { message: "rate_percent must be a number between 0 and 100" })
    .max(100, { message: "rate_percent must be a number between 0 and 100" })
    .transform((v) => String(v)),
  locationId: z
    .number({ message: "location_id must be a valid integer" })
    .int("location_id must be a valid integer")
    .nullable()
    .optional(),
}).omit({ id: true, workspaceOwnerId: true, createdAt: true });

export const updateTaxRuleSchema = insertTaxRuleSchema.partial();

export const selectTaxRuleSchema = createSelectSchema(taxRules);
