import {
  pgTable,
  serial,
  integer,
  text,
  boolean,
  timestamp,
  numeric,
  uniqueIndex,
  unique,
  index,
  jsonb,
  uuid,
  check,
  foreignKey,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { locations } from "./workspace";
import { suppliers } from "./suppliers";
import { uomCatalog } from "./uoms";

// ---------------------------------------------------------------------------
// base_item_categories — hierarchical (main → sub) classification system
// ---------------------------------------------------------------------------

export const baseItemCategories = pgTable(
  "base_item_categories",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    name: text("name").notNull(),
    // Self-referencing FK — parent null = top-level category
    parentId: integer("parent_id").references(
      (): AnyPgColumn => baseItemCategories.id,
      { onDelete: "cascade" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Extended columns added via ALTER TABLE
    description: text("description"),
    categoryType: text("category_type"),
    status: text("status").notNull().default("active"),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
    createdBy: text("created_by"),
    updatedBy: text("updated_by"),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [
    index("idx_bic_workspace").on(t.workspaceOwnerId),
  ],
);

export type BaseItemCategory = typeof baseItemCategories.$inferSelect;
export type InsertBaseItemCategory = typeof baseItemCategories.$inferInsert;

// ---------------------------------------------------------------------------
// base_items
// ---------------------------------------------------------------------------

export const baseItems = pgTable(
  "base_items",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    name: text("name").notNull(),
    code: text("code").notNull(),
    imageUrl: text("image_url"),
    // Stable key (relative to PUBLIC_OBJECT_SEARCH_PATHS) of the public,
    // auth-free copy of the image. Populated on create/update and by the
    // startup backfill in backfillBaseItemPublicImages().
    imagePublicPath: text("image_public_path"),
    categoryId: integer("category_id").references(
      () => baseItemCategories.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Optional descriptive columns (added after initial release)
    alternateName: text("alternate_name"),
    accountingCategory: text("accounting_category"),
    taxRate: numeric("tax_rate"),
    // Stock tracking columns
    stock: numeric("stock").notNull().default("0"),
    lowStockThreshold: numeric("low_stock_threshold").notNull().default("0"),
    // Status and type
    status: text("status").notNull().default("active"),
    type: text("type"),
    // Merge / archive tracking columns
    mergedIntoBaseItemId: integer("merged_into_base_item_id"),
    mergedAt: timestamp("merged_at", { withTimezone: true }),
    mergedByUserId: text("merged_by_user_id"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    archivedByUserId: text("archived_by_user_id"),
  },
  (t) => [
    index("idx_base_items_workspace").on(t.workspaceOwnerId),
    // This composite key backs workspace-scoped recipe intelligence foreign
    // keys. Keep it as a table-level constraint so the publish diff recognizes
    // it as a prerequisite before adding dependent foreign keys.
    unique("recipe_intelligence_base_items_workspace_id_unique").on(
      t.workspaceOwnerId,
      t.id,
    ),
    uniqueIndex("idx_base_items_workspace_code_unique").on(
      t.workspaceOwnerId,
      t.code,
    ),
  ],
);

export type BaseItem = typeof baseItems.$inferSelect;
export type InsertBaseItem = typeof baseItems.$inferInsert;

// ---------------------------------------------------------------------------
// Governed Base Item intelligence — proposed metadata and approved aliases
// ---------------------------------------------------------------------------

/**
 * Extracted metadata is deliberately separate from base_items. A candidate does
 * not alter operational item data until an explicit decision is recorded.
 */
export const baseItemMetadataCandidates = pgTable(
  "base_item_metadata_candidates",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    baseItemId: integer("base_item_id").notNull(),
    attributeType: text("attribute_type").notNull(),
    proposedValue: jsonb("proposed_value").notNull(),
    sourceText: text("source_text"),
    extractionMethod: text("extraction_method").notNull(),
    confidence: numeric("confidence", { precision: 5, scale: 4 }),
    sourceType: text("source_type").notNull().default("system"),
    sourceActorUserId: text("source_actor_user_id"),
    status: text("status").notNull().default("candidate"),
    decidedByUserId: text("decided_by_user_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("base_item_metadata_candidates_workspace_id_unique").on(
      t.workspaceOwnerId,
      t.id,
    ),
    index("idx_bimc_workspace_status").on(t.workspaceOwnerId, t.status, t.createdAt),
    index("idx_bimc_base_item").on(t.workspaceOwnerId, t.baseItemId, t.createdAt),
    foreignKey({
      columns: [t.workspaceOwnerId, t.baseItemId],
      foreignColumns: [baseItems.workspaceOwnerId, baseItems.id],
      name: "base_item_metadata_candidates_workspace_base_item_fk",
    }).onDelete("cascade"),
    check(
      "base_item_metadata_candidates_status_check",
      sql`${t.status} IN ('candidate', 'approved', 'rejected', 'deactivated')`,
    ),
    check(
      "base_item_metadata_candidates_source_type_check",
      sql`${t.sourceType} IN ('actor', 'system')`,
    ),
  ],
);

/** Immutable record of every metadata-candidate lifecycle decision. */
export const baseItemMetadataCandidateDecisions = pgTable(
  "base_item_metadata_candidate_decisions",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    candidateId: integer("candidate_id").notNull(),
    action: text("action").notNull(),
    actorUserId: text("actor_user_id"),
    previousState: jsonb("previous_state").notNull().default({}),
    nextState: jsonb("next_state").notNull().default({}),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_bimcd_candidate").on(t.workspaceOwnerId, t.candidateId, t.createdAt),
    foreignKey({
      columns: [t.workspaceOwnerId, t.candidateId],
      foreignColumns: [baseItemMetadataCandidates.workspaceOwnerId, baseItemMetadataCandidates.id],
      name: "base_item_metadata_candidate_decisions_workspace_candidate_fk",
    }).onDelete("cascade"),
    check(
      "base_item_metadata_candidate_decisions_action_check",
      sql`${t.action} IN ('created', 'corrected', 'approved', 'rejected', 'deactivated', 'commented')`,
    ),
  ],
);

/**
 * Alias values are normalized by the writer before storage; the database's
 * workspace-wide unique key prevents an alias from resolving to two items.
 */
export const baseItemAliases = pgTable(
  "base_item_aliases",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    baseItemId: integer("base_item_id").notNull(),
    alias: text("alias").notNull(),
    normalizedAlias: text("normalized_alias").notNull(),
    sourceType: text("source_type").notNull().default("actor"),
    sourceActorUserId: text("source_actor_user_id"),
    status: text("status").notNull().default("candidate"),
    decidedByUserId: text("decided_by_user_id"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("base_item_aliases_workspace_id_unique").on(t.workspaceOwnerId, t.id),
    unique("base_item_aliases_workspace_normalized_alias_unique").on(
      t.workspaceOwnerId,
      t.normalizedAlias,
    ),
    index("idx_bia_workspace_base_item").on(t.workspaceOwnerId, t.baseItemId, t.status),
    foreignKey({
      columns: [t.workspaceOwnerId, t.baseItemId],
      foreignColumns: [baseItems.workspaceOwnerId, baseItems.id],
      name: "base_item_aliases_workspace_base_item_fk",
    }).onDelete("cascade"),
    check(
      "base_item_aliases_status_check",
      sql`${t.status} IN ('candidate', 'approved', 'rejected', 'deactivated')`,
    ),
    check(
      "base_item_aliases_source_type_check",
      sql`${t.sourceType} IN ('actor', 'system')`,
    ),
  ],
);

/** Immutable audit ledger for governed alias lifecycle decisions. */
export const baseItemAliasDecisions = pgTable(
  "base_item_alias_decisions",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    aliasId: integer("alias_id").notNull(),
    action: text("action").notNull(),
    actorUserId: text("actor_user_id"),
    previousState: jsonb("previous_state").notNull().default({}),
    nextState: jsonb("next_state").notNull().default({}),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_biad_alias").on(t.workspaceOwnerId, t.aliasId, t.createdAt),
    foreignKey({
      columns: [t.workspaceOwnerId, t.aliasId],
      foreignColumns: [baseItemAliases.workspaceOwnerId, baseItemAliases.id],
      name: "base_item_alias_decisions_workspace_alias_fk",
    }).onDelete("cascade"),
    check(
      "base_item_alias_decisions_action_check",
      sql`${t.action} IN ('created', 'corrected', 'approved', 'rejected', 'deactivated', 'commented')`,
    ),
  ],
);

export type BaseItemMetadataCandidate = typeof baseItemMetadataCandidates.$inferSelect;
export type BaseItemMetadataCandidateDecision =
  typeof baseItemMetadataCandidateDecisions.$inferSelect;
export type BaseItemAlias = typeof baseItemAliases.$inferSelect;
export type BaseItemAliasDecision = typeof baseItemAliasDecisions.$inferSelect;

// ---------------------------------------------------------------------------
// base_item_packages — packaging definitions for a base item
// ---------------------------------------------------------------------------

export const baseItemPackages = pgTable(
  "base_item_packages",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    baseItemId: integer("base_item_id")
      .notNull()
      .references(() => baseItems.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    unit: text("unit"),
    quantity: integer("quantity").notNull().default(1),
    barcode: text("barcode"),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_bip_base_item").on(t.baseItemId),
  ],
);

export type BaseItemPackage = typeof baseItemPackages.$inferSelect;
export type InsertBaseItemPackage = typeof baseItemPackages.$inferInsert;

// ---------------------------------------------------------------------------
// base_item_suppliers — links between base items and workspace suppliers
// ---------------------------------------------------------------------------

export const baseItemSuppliers = pgTable(
  "base_item_suppliers",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    baseItemId: integer("base_item_id")
      .notNull()
      .references(() => baseItems.id, { onDelete: "cascade" }),
    supplierId: integer("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "cascade" }),
    packageId: integer("package_id").references(
      () => baseItemPackages.id,
      { onDelete: "set null" },
    ),
    supplierItemName: text("supplier_item_name"),
    supplierItemCode: text("supplier_item_code"),
    pricingUomCode: text("pricing_uom_code").references(() => uomCatalog.code, {
      onDelete: "restrict",
    }),
    // Compatibility text retained for unresolved legacy values and older readers.
    pricingUom: text("pricing_uom"),
    price: numeric("price", { precision: 14, scale: 4 }),
    currency: text("currency").notNull().default("AED"),
    isPreferred: boolean("is_preferred").notNull().default(false),
    isDefaultOrderUnit: boolean("is_default_order_unit").notNull().default(false),
    nameAr: text("name_ar"),
    nameArSource: text("name_ar_source"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_bis_base_item").on(t.baseItemId),
  ],
);

export type BaseItemSupplier = typeof baseItemSuppliers.$inferSelect;
export type InsertBaseItemSupplier = typeof baseItemSuppliers.$inferInsert;

// ---------------------------------------------------------------------------
// base_item_location_statuses — per-base-item per-location availability
// ---------------------------------------------------------------------------

export const baseItemLocationStatuses = pgTable(
  "base_item_location_statuses",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    baseItemId: integer("base_item_id").notNull(),
    locationId: integer("location_id").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    stock: numeric("stock").notNull().default("0"),
    lowStockThreshold: numeric("low_stock_threshold").notNull().default("0"),
  },
  (t) => [
    index("idx_bils_workspace").on(t.workspaceOwnerId),
    unique("base_item_location_statuses_unique").on(
      t.baseItemId,
      t.locationId,
    ),
  ],
);

export type BaseItemLocationStatus =
  typeof baseItemLocationStatuses.$inferSelect;
export type InsertBaseItemLocationStatus =
  typeof baseItemLocationStatuses.$inferInsert;

// ---------------------------------------------------------------------------
// base_item_stock_transfers — records stock movement between locations
// ---------------------------------------------------------------------------

export const baseItemStockTransfers = pgTable(
  "base_item_stock_transfers",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    baseItemId: integer("base_item_id").notNull(),
    country: text("country").notNull(),
    fromLocationId: integer("from_location_id").notNull(),
    toLocationId: integer("to_location_id").notNull(),
    quantity: numeric("quantity").notNull(),
    reason: text("reason").notNull(),
    note: text("note"),
    performedByUserId: text("performed_by_user_id"),
    idempotencyKey: uuid("idempotency_key"),
    payloadHash: text("payload_hash"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_bist_base_item").on(t.baseItemId, t.createdAt),
    uniqueIndex("idx_bist_workspace_action").on(
      t.workspaceOwnerId,
      t.idempotencyKey,
    ),
  ],
);

export type BaseItemStockTransfer = typeof baseItemStockTransfers.$inferSelect;
export type InsertBaseItemStockTransfer =
  typeof baseItemStockTransfers.$inferInsert;

// ---------------------------------------------------------------------------
// base_item_stock_adjustments — authoritative Base Item operational ledger.
// Rows with ledger_scope="cmc_product_compat" are isolated legacy/product-only
// records and are never used to derive Base Item on-hand balances.
// ---------------------------------------------------------------------------

export const baseItemStockAdjustments = pgTable(
  "base_item_stock_adjustments",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    baseItemId: integer("base_item_id"),
    quantityChange: numeric("quantity_change").notNull(),
    reason: text("reason").notNull(),
    note: text("note"),
    stockAfter: numeric("stock_after").notNull(),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    locationId: integer("location_id"),
    purchaseOrderId: integer("purchase_order_id"),
    movementType: text("movement_type"),
    transferId: integer("transfer_id"),
    // Ledger extension columns
    orderId: text("order_id"),
    orderLineItemId: text("order_line_item_id"),
    productId: integer("product_id"),
    idempotencyKey: text("idempotency_key"),
    reversalOfId: integer("reversal_of_id"),
    recipeSnapshot: jsonb("recipe_snapshot"),
    cutoverBaseline: boolean("cutover_baseline").notNull().default(false),
    adjustmentActionId: uuid("adjustment_action_id"),
    ledgerScope: text("ledger_scope")
      .notNull()
      .default("base_item_operational"),
    canonicalUnit: text("canonical_unit"),
    baseItemNameSnapshot: text("base_item_name_snapshot"),
    locationNameSnapshot: text("location_name_snapshot"),
    actorType: text("actor_type"),
    actorId: text("actor_id"),
    actorLabelSnapshot: text("actor_label_snapshot"),
    sourceType: text("source_type"),
    sourceId: text("source_id"),
    sourceLabelSnapshot: text("source_label_snapshot"),
    referenceType: text("reference_type"),
    referenceId: text("reference_id"),
    referenceLabelSnapshot: text("reference_label_snapshot"),
    metadataSnapshot: jsonb("metadata_snapshot").notNull().default({}),
  },
  (t) => [
    index("idx_bisa_base_item").on(t.baseItemId, t.createdAt),
    index("idx_bisa_workspace").on(t.workspaceOwnerId, t.createdAt),
    uniqueIndex("base_item_stock_adj_idempotency").on(
      t.workspaceOwnerId,
      t.idempotencyKey,
    ),
    uniqueIndex("base_item_stock_adj_one_reversal").on(t.reversalOfId),
    index("idx_bisa_item_date_id").on(t.baseItemId, t.createdAt, t.id),
    index("idx_bisa_item_loc_date_id").on(
      t.baseItemId,
      t.locationId,
      t.createdAt,
      t.id,
    ),
    index("idx_bisa_order_id").on(t.orderId),
    index("idx_bisa_purchase_order_id").on(t.purchaseOrderId),
    index("idx_bisa_transfer_id").on(t.transferId),
    index("idx_bisa_reversal_of_id").on(t.reversalOfId),
    index("idx_bisa_movement_type").on(t.movementType),
    index("idx_bisa_ledger_scope").on(
      t.workspaceOwnerId,
      t.ledgerScope,
      t.createdAt,
    ),
    uniqueIndex("idx_bisa_adjustment_action_id").on(
      t.workspaceOwnerId,
      t.adjustmentActionId,
    ),
  ],
);

export type BaseItemStockAdjustment =
  typeof baseItemStockAdjustments.$inferSelect;
export type InsertBaseItemStockAdjustment =
  typeof baseItemStockAdjustments.$inferInsert;

// ---------------------------------------------------------------------------
// base_item_country_thresholds — per-country default low-stock thresholds
// ---------------------------------------------------------------------------

export const baseItemCountryThresholds = pgTable(
  "base_item_country_thresholds",
  {
    id: serial("id").primaryKey(),
    baseItemId: integer("base_item_id").notNull(),
    country: text("country").notNull(),
    defaultLowStockThreshold: numeric("default_low_stock_threshold")
      .notNull()
      .default("0"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_bict_base_item").on(t.baseItemId),
    unique("base_item_country_thresholds_unique").on(
      t.baseItemId,
      t.country,
    ),
  ],
);

export type BaseItemCountryThreshold =
  typeof baseItemCountryThresholds.$inferSelect;
export type InsertBaseItemCountryThreshold =
  typeof baseItemCountryThresholds.$inferInsert;

// ---------------------------------------------------------------------------
// inventory_movements — permanent append-only ledger of stock changes
// ---------------------------------------------------------------------------

export const inventoryMovements = pgTable(
  "inventory_movements",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    baseItemId: integer("base_item_id").notNull(),
    locationId: integer("location_id"),
    movementType: text("movement_type").notNull(),
    quantityChange: numeric("quantity_change", { precision: 18, scale: 4 }).notNull(),
    unitOfMeasure: text("unit_of_measure"),
    unitCost: numeric("unit_cost", { precision: 14, scale: 4 }),
    totalValue: numeric("total_value", { precision: 14, scale: 4 }),
    currency: text("currency").notNull().default("USD"),
    fxRateToUsd: numeric("fx_rate_to_usd", { precision: 14, scale: 6 }),
    entityId: text("entity_id"),
    sourceType: text("source_type"),
    sourceId: text("source_id"),
    sourceLabel: text("source_label"),
    employeeId: text("employee_id"),
    notes: text("notes"),
    postedAt: timestamp("posted_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    reversedById: integer("reversed_by_id"),
  },
  (t) => [
    index("idx_inv_mov_workspace").on(t.workspaceOwnerId, t.postedAt),
    index("idx_inv_mov_base_item").on(t.baseItemId, t.postedAt),
    index("idx_inv_mov_location").on(t.locationId, t.postedAt),
    index("idx_inv_mov_source").on(t.sourceType, t.sourceId),
  ],
);

export type InventoryMovement = typeof inventoryMovements.$inferSelect;
export type InsertInventoryMovement = typeof inventoryMovements.$inferInsert;

// ---------------------------------------------------------------------------
// base_item_location_costs — per-location weighted-average unit cost
// ---------------------------------------------------------------------------

export const baseItemLocationCosts = pgTable(
  "base_item_location_costs",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    baseItemId: integer("base_item_id").notNull(),
    locationId: integer("location_id"),
    weightedAvgCost: numeric("weighted_avg_cost", { precision: 14, scale: 4 }).notNull().default("0"),
    currency: text("currency").notNull().default("USD"),
    lastReceiptAt: timestamp("last_receipt_at", { withTimezone: true }),
    totalUnitsOnHand: numeric("total_units_on_hand", { precision: 18, scale: 4 }).notNull().default("0"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_bilc_workspace").on(t.workspaceOwnerId),
    unique("base_item_location_costs_unique").on(t.baseItemId, t.locationId),
  ],
);

export type BaseItemLocationCost = typeof baseItemLocationCosts.$inferSelect;
export type InsertBaseItemLocationCost = typeof baseItemLocationCosts.$inferInsert;

// ---------------------------------------------------------------------------
// wastage_records — tracked inventory wastage events
// ---------------------------------------------------------------------------

export const wastageRecords = pgTable(
  "wastage_records",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    baseItemId: integer("base_item_id").notNull(),
    locationId: integer("location_id"),
    quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull(),
    unitOfMeasure: text("unit_of_measure"),
    reason: text("reason").notNull(),
    employeeId: text("employee_id"),
    orderId: integer("order_id"),
    notes: text("notes"),
    imageUrls: jsonb("image_urls"),
    movementId: integer("movement_id"),
    operationalMovementId: integer("operational_movement_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_wastage_workspace").on(t.workspaceOwnerId, t.createdAt),
    index("idx_wastage_base_item").on(t.baseItemId, t.createdAt),
  ],
);

export type WastageRecord = typeof wastageRecords.$inferSelect;
export type InsertWastageRecord = typeof wastageRecords.$inferInsert;

// ---------------------------------------------------------------------------
// inventory_cogs_targets — configurable COGS % target per entity/location
// ---------------------------------------------------------------------------

export const inventoryCogsTargets = pgTable(
  "inventory_cogs_targets",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    entityId: text("entity_id"),
    locationId: integer("location_id"),
    targetCogsPct: numeric("target_cogs_pct", { precision: 6, scale: 2 }).notNull(),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_ict_workspace").on(t.workspaceOwnerId),
  ],
);

export type InventoryCogsTarget = typeof inventoryCogsTargets.$inferSelect;
export type InsertInventoryCogsTarget = typeof inventoryCogsTargets.$inferInsert;

// ---------------------------------------------------------------------------
// base_item_ledger_settings — cutover baseline anchor per (base_item, location)
// ---------------------------------------------------------------------------

export const baseItemLedgerSettings = pgTable(
  "base_item_ledger_settings",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    baseItemId: integer("base_item_id").notNull(),
    locationId: integer("location_id").notNull(),
    cutoverAt: timestamp("cutover_at", { withTimezone: true }).notNull(),
    cutoverBalance: numeric("cutover_balance").notNull(),
    verifiedByUserId: text("verified_by_user_id").notNull(),
    verifiedByLabelSnapshot: text("verified_by_label_snapshot"),
    verificationReason: text("verification_reason").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_bils_settings_workspace").on(t.workspaceOwnerId),
    index("idx_bils_settings_base_item").on(t.baseItemId),
    unique("base_item_ledger_settings_unique").on(
      t.workspaceOwnerId,
      t.baseItemId,
      t.locationId,
    ),
  ],
);

export type BaseItemLedgerSetting = typeof baseItemLedgerSettings.$inferSelect;
export type InsertBaseItemLedgerSetting = typeof baseItemLedgerSettings.$inferInsert;

// ---------------------------------------------------------------------------
// purchase_order_receipt_events — idempotency anchors for PO receiving
// ---------------------------------------------------------------------------

export const purchaseOrderReceiptEvents = pgTable(
  "purchase_order_receipt_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    purchaseOrderId: integer("purchase_order_id").notNull(),
    locationId: integer("location_id").notNull(),
    receiveActionId: uuid("receive_action_id"),
    payloadHash: text("payload_hash"),
    receivedByUserId: text("received_by_user_id"),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_pore_po").on(t.purchaseOrderId),
    uniqueIndex("idx_pore_workspace_action").on(
      t.workspaceOwnerId,
      t.receiveActionId,
    ),
  ],
);

export const recipeConsumptionExceptions = pgTable(
  "recipe_consumption_exceptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    orderId: text("order_id").notNull(),
    lineItemId: text("line_item_id").notNull(),
    baseItemId: integer("base_item_id"),
    productId: integer("product_id"),
    locationId: integer("location_id"),
    reason: text("reason").notNull(),
    status: text("status").notNull().default("open"),
    idempotencyKey: text("idempotency_key").notNull(),
    sourceSnapshot: jsonb("source_snapshot").notNull().default({}),
    attemptHistory: jsonb("attempt_history").notNull().default([]),
    resolvedMovementId: integer("resolved_movement_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("idx_rce_workspace_event_key").on(
      t.workspaceOwnerId,
      t.idempotencyKey,
    ),
    index("idx_rce_workspace_status").on(
      t.workspaceOwnerId,
      t.status,
      t.createdAt,
    ),
  ],
);
export type PurchaseOrderReceiptEvent = typeof purchaseOrderReceiptEvents.$inferSelect;
export type InsertPurchaseOrderReceiptEvent = typeof purchaseOrderReceiptEvents.$inferInsert;
