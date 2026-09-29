import {
  boolean,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Shared, stable-code unit-of-measure catalog.
 *
 * Display names may change without changing the code stored by domain tables.
 * Context availability keeps the catalog reusable without making every unit
 * selectable in every workflow.
 */
export const uomCatalog = pgTable(
  "uom_catalog",
  {
    code: text("code").primaryKey(),
    displayName: text("display_name").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_uom_catalog_active_sort").on(t.isActive, t.sortOrder)],
);

export const uomAliases = pgTable(
  "uom_aliases",
  {
    id: serial("id").primaryKey(),
    uomCode: text("uom_code")
      .notNull()
      .references(() => uomCatalog.code, { onDelete: "cascade" }),
    alias: text("alias").notNull(),
    normalizedAlias: text("normalized_alias").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("idx_uom_aliases_normalized_unique").on(t.normalizedAlias),
    index("idx_uom_aliases_code").on(t.uomCode),
  ],
);

export const uomContextAvailability = pgTable(
  "uom_context_availability",
  {
    id: serial("id").primaryKey(),
    uomCode: text("uom_code")
      .notNull()
      .references(() => uomCatalog.code, { onDelete: "cascade" }),
    context: text("context").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("idx_uom_context_code_unique").on(t.context, t.uomCode),
    index("idx_uom_context_active").on(t.context, t.isActive),
  ],
);

export type UomCatalogRow = typeof uomCatalog.$inferSelect;
export type InsertUomCatalogRow = typeof uomCatalog.$inferInsert;
export type UomAlias = typeof uomAliases.$inferSelect;
export type InsertUomAlias = typeof uomAliases.$inferInsert;
export type UomContextAvailability = typeof uomContextAvailability.$inferSelect;
export type InsertUomContextAvailability = typeof uomContextAvailability.$inferInsert;