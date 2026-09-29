// Export your models here. Add one export per file
// export * from "./posts";
//
// Each model/table should ideally be split into different files.
// Each model/table should define a Drizzle table, insert schema, and types:
//
//   import { pgTable, text, serial } from "drizzle-orm/pg-core";
//   import { createInsertSchema } from "drizzle-zod";
//   import { z } from "zod/v4";
//
//   export const postsTable = pgTable("posts", {
//     id: serial("id").primaryKey(),
//     title: text("title").notNull(),
//   });
//
//   export const insertPostSchema = createInsertSchema(postsTable).omit({ id: true });
//   export type InsertPost = z.infer<typeof insertPostSchema>;
//   export type Post = typeof postsTable.$inferSelect;

export * from "./contacts";
export * from "./orders";
export * from "./fleet";
export * from "./suppliers";
export * from "./supplierStatementCollection";
export * from "./omnichannel";
export * from "./marketplace";
export * from "./people";
export * from "./customers";
export * from "./workspace";
export * from "./brands";
export * from "./products";
export * from "./productGallery";
export * from "./catalogAttributes";
export * from "./publishing";
export * from "./taxRules";
export * from "./paymentLinks";
export * from "./paymentLinkConversions";
export * from "./webhooks";
export * from "./baseItems";
export * from "./uoms";
export * from "./catalogHelpers";
export * from "./holidays";
export * from "./deliveryDistricts";
export * from "./timeOff";
export * from "./finance";
export * from "./campaigns";
export * from "./analytics";
export * from "./channelConfig";
export * from "./exchangeRates";
export * from "./stickers";
export * from "./auditLog";
export * from "./accessRequests";
export * from "./workshopSales";
export * from "./cashDesk";
export * from "./storefrontConfig";
export * from "./branchPrintConfigs";
export * from "./cardPrintLogs";
export * from "./weeklyDigest";
export * from "./webPush";
export * from "./recipeIntelligence";
// baseItemStock tables merged into baseItems.ts
export * from "./accounting";
export * from "./backlinkEngine";
export * from "./cmcPos";
export * from "./generatedInvoices";
export * from "./addressCollector";
export * from "./reviewRewards";
export * from "./audiences";
export * from "./toters";
export * from "./recipeBenchmarks";
export * from "./bloomprint";
export * from "./lbBankRecon";
export * from "./aiUsage";
export * from "./merchant";
