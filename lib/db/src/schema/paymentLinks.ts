import {
  pgTable,
  serial,
  integer,
  text,
  boolean,
  timestamp,
  numeric,
  uniqueIndex,
  index,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspaceMembers } from "./workspace";

// ---------------------------------------------------------------------------
// payment_links
// ---------------------------------------------------------------------------

export const paymentLinks = pgTable(
  "payment_links",
  {
    id: serial("id").primaryKey(),
    workspaceOwnerId: text("workspace_owner_id").notNull(),
    amount: integer("amount").notNull(),
    currency: text("currency").notNull().default("USD"),
    provider: text("provider").notNull(),
    description: text("description"),
    status: text("status").notNull().default("active"),
    providerLinkId: text("provider_link_id"),
    providerCheckoutUrl: text("provider_checkout_url"),
    publicToken: text("public_token").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    createdByMemberId: integer("created_by_member_id").references(
      () => workspaceMembers.id,
      { onDelete: "set null" },
    ),
    country: text("country"),
    // Conversion audit columns (added after initial release)
    originalAmount: numeric("original_amount", { precision: 20, scale: 4 }),
    originalCurrency: text("original_currency"),
    officialExchangeRate: numeric("official_exchange_rate", {
      precision: 20,
      scale: 10,
    }),
    markupPercentageUsed: numeric("markup_percentage_used", {
      precision: 6,
      scale: 3,
    }),
    convertedAmountExact: numeric("converted_amount_exact", {
      precision: 20,
      scale: 4,
    }),
    finalAmountCharged: numeric("final_amount_charged", {
      precision: 20,
      scale: 4,
    }),
    convertedCurrency: text("converted_currency"),
    roundingRuleUsed: text("rounding_rule_used"),
    exchangeRateFetchedAt: timestamp("exchange_rate_fetched_at", {
      withTimezone: true,
    }),
    // Sender details — collected on the public pay page before checkout
    senderFirstName: text("sender_first_name"),
    senderLastName: text("sender_last_name"),
    senderPhoneCountryCode: text("sender_phone_country_code"),
    senderPhone: text("sender_phone"),
    senderEmail: text("sender_email"),
    senderSubmittedAt: timestamp("sender_submitted_at", { withTimezone: true }),
    googleClickIdType: text("google_click_id_type"),
    googleClickId: text("google_click_id"),
    googleClickCapturedAt: timestamp("google_click_captured_at", { withTimezone: true }),
    // Canonical relationship: a payment link belongs to zero or one order.
    // The legacy orders.payment_link_id column is retained only for migration
    // compatibility and is no longer used by application writes/reads.
    orderId: uuid("order_id"),
    linkedAt: timestamp("linked_at", { withTimezone: true }),
    linkedByUserId: text("linked_by_user_id"),
  },
  (t) => [
    uniqueIndex("idx_payment_links_public_token").on(t.publicToken),
    index("idx_payment_links_workspace").on(
      t.workspaceOwnerId,
      t.createdAt,
    ),
    index("idx_payment_links_provider_link_id")
      .on(t.provider, t.providerLinkId)
      .where(sql`${t.providerLinkId} IS NOT NULL`),
    index("idx_payment_links_sender_email").on(t.senderEmail).where(sql`${t.senderEmail} IS NOT NULL`),
    index("idx_payment_links_order").on(t.orderId).where(sql`${t.orderId} IS NOT NULL`),
  ],
);

export type PaymentLink = typeof paymentLinks.$inferSelect;
export type InsertPaymentLink = typeof paymentLinks.$inferInsert;
