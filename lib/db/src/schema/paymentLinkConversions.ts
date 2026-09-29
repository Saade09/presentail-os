import {
  pgTable,
  bigserial,
  integer,
  text,
  timestamp,
  numeric,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { paymentLinks } from "./paymentLinks";

export const paymentLinkConversions = pgTable(
  "payment_link_conversions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    paymentLinkId: integer("payment_link_id")
      .notNull()
      .references(() => paymentLinks.id, { onDelete: "cascade" }),
    transactionId: text("transaction_id").notNull(),
    destinationCountry: text("destination_country").notNull(),
    clickIdType: text("click_id_type").notNull(),
    clickId: text("click_id").notNull(),
    conversionValue: numeric("conversion_value", { precision: 20, scale: 4 }).notNull(),
    currency: text("currency").notNull(),
    conversionTime: timestamp("conversion_time", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }),
    lastError: text("last_error"),
    failureReason: text("failure_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("idx_payment_link_conversions_transaction").on(t.transactionId),
    index("idx_payment_link_conversions_retry").on(t.status, t.nextAttemptAt),
  ],
);

export type PaymentLinkConversion = typeof paymentLinkConversions.$inferSelect;