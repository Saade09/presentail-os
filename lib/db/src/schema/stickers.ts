import {
  pgTable,
  serial,
  integer,
  text,
  boolean,
  timestamp,
  numeric,
  index,
  uniqueIndex,
  customType,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { brands } from "./brands";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const stickers = pgTable(
  "stickers",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    name: text("name").notNull(),
    fileName: text("file_name").notNull(),
    pdfData: bytea("pdf_data").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    brandId: integer("brand_id").references(() => brands.id, {
      onDelete: "set null",
    }),
    thumbnailData: bytea("thumbnail_data"),
    thumbnailMime: text("thumbnail_mime"),
  },
  (t) => [
    index("idx_stickers_workspace").on(t.workspaceOwnerId),
    index("idx_stickers_brand").on(t.brandId),
  ],
);

export type Sticker = typeof stickers.$inferSelect;
export type InsertSticker = typeof stickers.$inferInsert;

// ---------------------------------------------------------------------------
// brand_sticker_sheets — versioned sticker sheet PDFs stored in object storage
// ---------------------------------------------------------------------------

export const brandStickerSheets = pgTable(
  "brand_sticker_sheets",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    brandId: integer("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    fileUrl: text("file_url").notNull(),
    fileName: text("file_name").notNull(),
    fileSize: integer("file_size").notNull().default(0),
    thumbnailUrl: text("thumbnail_url"),
    sheetSize: text("sheet_size").notNull().default("a4"),
    customWidth: numeric("custom_width"),
    customHeight: numeric("custom_height"),
    stickerCount: integer("sticker_count").notNull().default(1),
    status: text("status").notNull().default("pending_review"),
    versionNumber: integer("version_number").notNull().default(1),
    versionNotes: text("version_notes"),
    isActive: boolean("is_active").notNull().default(false),
    uploadedByUserId: text("uploaded_by_user_id").notNull(),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    reviewedByUserId: text("reviewed_by_user_id"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    approvedByUserId: text("approved_by_user_id"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    changeRequestNotes: text("change_request_notes"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_bss_workspace").on(t.workspaceOwnerId),
    index("idx_bss_brand").on(t.brandId),
    uniqueIndex("idx_bss_active_per_brand")
      .on(t.brandId)
      .where(sql`is_active = TRUE`),
  ],
);

export type BrandStickerSheet = typeof brandStickerSheets.$inferSelect;
export type InsertBrandStickerSheet = typeof brandStickerSheets.$inferInsert;

// ---------------------------------------------------------------------------
// brand_sticker_sheet_audit_log — audit trail for sticker sheet lifecycle events
// ---------------------------------------------------------------------------

export const brandStickerSheetAuditLog = pgTable(
  "brand_sticker_sheet_audit_log",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    sheetId: integer("sheet_id"),
    brandId: integer("brand_id"),
    brandName: text("brand_name").notNull(),
    versionNumber: integer("version_number"),
    fileName: text("file_name"),
    action: text("action").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    actorEmail: text("actor_email"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("idx_bss_audit_workspace").on(t.workspaceOwnerId, t.createdAt),
  ],
);

export type BrandStickerSheetAuditLog =
  typeof brandStickerSheetAuditLog.$inferSelect;
export type InsertBrandStickerSheetAuditLog =
  typeof brandStickerSheetAuditLog.$inferInsert;
