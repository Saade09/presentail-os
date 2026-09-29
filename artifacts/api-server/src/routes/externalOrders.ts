import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { db } from "../lib/db";
import { requireApiKey, type ApiKeyAuthedRequest } from "../lib/apiKeyAuth";
import {
  upsertContact,
  refreshPhonePlaceholderContactAfterFirstOrder,
} from "../lib/contactUpsert";
import { applyAutoTagsForContact } from "../lib/autoTags";
import { broadcastEvent } from "../lib/eventsSse";
import { notifyNewOrderAlerts } from "../lib/orderAlerts";
import { fireWebhookEvent } from "../lib/catalogWebhook";
import {
  sendOrderConfirmationEmail,
  sendNewOrderStaffEmail,
  sendOrderPaymentInstructionsEmail,
} from "../lib/email";
import { lookupOrderEmailDetails, lookupWorkspaceStaffEmails } from "./orders";
import { trackOrderEmail } from "../lib/orderComms";
import { logger } from "../lib/logger";
import {
  isTookanEnabled,
  createTookanDeliveryTask,
  parseDeliveryWindow,
  isOvernightDeliverySlot,
  extractTookanFailurePayload,
  syncTookanDestinationForOrder,
  tookanDestinationsEqual,
  type OrderForTookan,
  type RecipientForTookan,
  type LineItemForTookan,
} from "../lib/tookan";
import { syncApprovedFloristPhotoForOrderToTookan } from "../lib/floristTookanPhotoSync";
import { notifyNewUaeOrderToSlack } from "../lib/slack";
import {
  notifyOrderStatusWhatsApp,
  sendWhishPaymentInstructions,
} from "../lib/orderWhatsappNotify";
import { applySensitiveOccasionFlag } from "../lib/sensitiveOccasion";
import { linkOrderToAddressBook } from "../lib/addressBookAutoLink";
import { createAddressCollectionRequest } from "../lib/addressCollector/service";
import { shouldCollectAddressCollection } from "../lib/addressCollector/eligibility";
import { isWhishPayment } from "../lib/orderInvoicePdf";
import {
  isStripeMethod,
  isStripePaymentIntentRef,
  verifyStripePaymentIntentAmount,
} from "../lib/stripeAmountVerification";
import { checkPaidPairPlausibility } from "../lib/paidPairPlausibility";
import { computeLineTotal } from "@workspace/money";

const router = Router();

// ── Delivery date validation ──────────────────────────────────────────────────

/**
 * Truncate a UTC ISO timestamp to a `YYYY-MM-DD` calendar date in the given IANA
 * timezone. Returns null on invalid input. Uses the en-CA locale because it
 * formats as `YYYY-MM-DD` natively. Mirrors the timezone handling in
 * `formatTookanDatetime` (env TOOKAN_TIMEZONE, default UTC).
 */
function isoToCalendarDate(iso: string, timeZone: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  } catch {
    return null;
  }
}

/** Format a `YYYY-MM-DD` calendar date as `DD/MM` for the review reason text. */
function formatReviewDate(calendarDate: string): string {
  const m = calendarDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return calendarDate;
  return `${m[3]}/${m[2]}`;
}

/**
 * Resolve an order's delivery date, auto-correcting it when it is before the
 * order's received date, and return the review-flag text describing what
 * happened. The comparison is done at day granularity in the delivery timezone.
 *
 * Behavior:
 *  (a) delivery date before the order date (ordered_at) → the date is
 *      auto-corrected to the order date (any time suffix on the original
 *      string is preserved) and `review` explains the correction, naming the
 *      original customer-picked date.
 *  (b) an overnight slot submitted for the day immediately after the order
 *      date → the date is normalized to the order date, the start day of the
 *      delivery window, with no review flag.
 *  (c) delivery date on/after the order date but before today → the date is
 *      kept as-is and `review` carries the plain "is in the past" flag.
 *  (d) otherwise (future/same-day, missing, or unparseable) → the date is
 *      kept as-is and `review` is null.
 *
 * The order is always accepted regardless — this only adjusts the stored date
 * and produces the flag text. The original date remains in `raw_payload`.
 */
export function resolveDeliveryDate(
  deliveryDate: string | null | undefined,
  orderedAtIso: string,
  timeZone: string,
  deliverySlot?: string | null,
): { date: string | null; review: string | null } {
  const original = deliveryDate == null ? null : String(deliveryDate);
  if (original == null) return { date: null, review: null };
  const dm = original.match(/^(\d{4}-\d{2}-\d{2})/);
  if (!dm) return { date: original, review: null };
  const deliveryDay = dm[1];

  const orderedDay = isoToCalendarDate(orderedAtIso, timeZone);
  const today = isoToCalendarDate(new Date().toISOString(), timeZone);

  // YYYY-MM-DD strings compare lexicographically the same as chronologically.
  if (orderedDay && deliveryDay < orderedDay) {
    // Auto-correct: bump the calendar date to the order date, preserving any
    // time suffix (e.g. "2026-07-02T18:00" → "2026-07-03T18:00").
    const corrected = orderedDay + original.slice(deliveryDay.length);
    return {
      date: corrected,
      review: `Delivery date automatically corrected from ${formatReviewDate(deliveryDay)} to the order date ${formatReviewDate(orderedDay)}`,
    };
  }

  // The storefront's date for an overnight window is the date on which the
  // window ends (for example, 11 PM–1 AM is submitted as tomorrow). The
  // operational delivery date must instead be the business date on which the
  // window starts, but only when that submitted date is exactly the next day
  // after receipt. More distant future deliveries are left untouched.
  if (orderedDay && isOvernightDeliverySlot(deliverySlot)) {
    const orderedDate = new Date(`${orderedDay}T00:00:00.000Z`);
    orderedDate.setUTCDate(orderedDate.getUTCDate() + 1);
    const nextDay = orderedDate.toISOString().slice(0, 10);
    if (deliveryDay === nextDay) {
      return { date: orderedDay + original.slice(deliveryDay.length), review: null };
    }
  }

  if (today && deliveryDay < today) {
    return {
      date: original,
      review: `Delivery date ${formatReviewDate(deliveryDay)} is in the past`,
    };
  }
  return { date: original, review: null };
}

// ── Sub-schemas ───────────────────────────────────────────────────────────────

const lineItemSchema = z.object({
  sku: z.string().nullable().optional(),
  name: z.string().min(1),
  quantity: z.number().int().positive().default(1),
  unit_price: z.number().min(0).nullable().optional(),
  // Actual charged per-item price in the customer's paid currency (the
  // storefront rounds displayed prices to the nearest 0/5/10 and charges the
  // rounded amount, e.g. AED 55 for a USD-derived 56.67). Optional; the paid
  // currency itself comes from payment.currencyCode.
  paid_unit_price: z.number().min(0).nullable().optional(),
  // Optional per-line personalization typed on the storefront input field.
  // Hard-capped server-side at 22 chars (longer strings are truncated on ingest).
  custom_input: z.string().max(2000).nullable().optional(),
  // Optional product image URL sent by the storefront. When absent, the
  // resolved workspace product's main image is stored instead.
  image_url: z.string().max(2048).nullable().optional(),
});

const contactSchema = z.object({
  first_name: z.string().nullable().optional(),
  last_name: z.string().nullable().optional(),
  email: z.string().email().nullable().optional(),
  phone: z.string().nullable().optional(),
});

const totalsSchema = z.object({
  subtotal: z.number().min(0).nullable().optional(),
  shipping: z.number().min(0).nullable().optional(),
  discount: z.number().min(0).nullable().optional(),
  total: z.number().min(0).nullable().optional(),
  currency: z.string().min(1).max(10).nullable().optional(),
  // Legacy snake_case charged amounts in the paid currency (aliases of the
  // rich payment.subtotalAmount / payment.deliveryFeeAmount fields).
  paid_subtotal: z.number().min(0).nullable().optional(),
  paid_shipping: z.number().min(0).nullable().optional(),
  // Pre-converted paid pair — when the client has already converted amounts to
  // the checkout currency, these take priority over re-applying any exchange
  // rate. The Stripe-verified amount still unconditionally wins over both.
  paid_total: z.number().min(0).nullable().optional(),
  paid_currency: z.string().min(1).max(10).nullable().optional(),
});

// Rich checkout schemas (camelCase, from external website checkout flow).
const checkoutItemSchema = z.object({
  productId: z.string().nullable().optional(),
  productName: z.string().min(1),
  quantity: z.number().int().positive().default(1),
  priceUsd: z.number().min(0).nullable().optional(),
  // Actual charged per-item price in the customer's paid currency (the
  // storefront rounds displayed prices to the nearest 0/5/10 and charges the
  // rounded amount, e.g. AED 55 for a USD-derived 56.67). Optional; the paid
  // currency itself comes from payment.currencyCode.
  paidUnitPrice: z.number().min(0).nullable().optional(),
  // Optional per-line personalization typed on the storefront input field.
  // Hard-capped server-side at 22 chars (longer strings are truncated on ingest).
  customInput: z.string().max(2000).nullable().optional(),
  // Optional product image URL sent by the storefront checkout.
  imageUrl: z.string().max(2048).nullable().optional(),
});

const feeItemSchema = z.object({
  name: z.string().min(1),
  quantity: z.number().int().positive().default(1),
  priceUsd: z.number().min(0).nullable().optional(),
});

const billingSchema = z.object({
  firstName: z.string().nullable().optional(),
  lastName: z.string().nullable().optional(),
  email: z.string().email().nullable().optional(),
  phone: z.string().nullable().optional(),
  countryCode: z.string().nullable().optional(),
});

const recipientSchema = z.object({
  firstName: z.string().nullable().optional(),
  lastName: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
});

const deliverySchema = z.object({
  district: z.string().nullable().optional(),
  // The public checkout has historically sent this as a numeric catalog id,
  // a city slug, or (for older clients) a city name.
  cityId: z.union([z.string(), z.number().int()]).nullable().optional(),
  city_id: z.union([z.string(), z.number().int()]).nullable().optional(),
  cityName: z.string().nullable().optional(),
  city_name: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  citySlug: z.string().nullable().optional(),
  city_slug: z.string().nullable().optional(),
  countryCode: z.string().nullable().optional(),
  country_code: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  noAddress: z.boolean().nullable().optional(),
  // Address Collector: checkout "collect address from recipient" toggle and
  // the recipient's preferred outreach language.
  collectAddress: z.boolean().nullable().optional(),
  preferredLanguage: z.enum(["en", "ar"]).nullable().optional(),
  date: z.string().nullable().optional(),
  slot: z.string().nullable().optional(),
  deliveryDate: z.string().nullable().optional(),
  deliverySlot: z.string().nullable().optional(),
  delivery_date: z.string().nullable().optional(),
  delivery_slot: z.string().nullable().optional(),
  timeSlot: z.string().nullable().optional(),
  isExpress: z.boolean().nullable().optional(),
  feeUsd: z.number().min(0).nullable().optional(),
  expressSurchargeUsd: z.number().min(0).nullable().optional(),
  slotFeeUsd: z.number().min(0).nullable().optional(),
});

const paymentSchema = z.object({
  method: z.string().nullable().optional(),
  ref: z.string().nullable().optional(),
  verified: z.boolean().nullable().optional(),
  totalUsd: z.number().min(0).nullable().optional(),
  // The amount actually charged in `currencyCode` (e.g. 70 CHF, while
  // totalUsd carries the 72 USD equivalent).
  totalAmount: z.number().min(0).nullable().optional(),
  currencyCode: z.string().min(1).max(10).nullable().optional(),
  // Order-level charged amounts in `currencyCode` — what the storefront
  // displayed (rounded) and actually charged for the items subtotal and the
  // delivery fee. Optional; when present on a non-USD order they are stored
  // in totals as paid_subtotal / paid_shipping and preferred by order emails.
  subtotalAmount: z.number().min(0).nullable().optional(),
  deliveryFeeAmount: z.number().min(0).nullable().optional(),
});

const marketingAttributionTouchSchema = z.object({
  gclid: z.string().nullable().optional(),
  gbraid: z.string().nullable().optional(),
  wbraid: z.string().nullable().optional(),
  utm_source: z.string().nullable().optional(),
  utm_medium: z.string().nullable().optional(),
  utm_campaign: z.string().nullable().optional(),
  utm_id: z.string().nullable().optional(),
  utm_term: z.string().nullable().optional(),
  utm_content: z.string().nullable().optional(),
  referrer: z.string().nullable().optional(),
  landing_page_url: z.string().nullable().optional(),
  landing_page_path: z.string().nullable().optional(),
  captured_at: z.string().nullable().optional(),
}).optional();

// Parsed separately from the main body so that a malformed attribution block
// is silently dropped rather than rejecting the entire order request.
const marketingAttributionSchema = z.object({
  source: z.string().nullable().optional(),
  first_touch: marketingAttributionTouchSchema,
  last_touch: marketingAttributionTouchSchema,
  conversion: z.object({
    order_total: z.number().nullable().optional(),
    currency: z.string().nullable().optional(),
    converted_at: z.string().nullable().optional(),
  }).nullable().optional(),
}).nullable().optional();

// Unified body schema — all the rich fields are optional; the minimal format
// (line_items only) remains valid for backward compatibility.
const externalOrderBodySchema = z.object({
  // Identity
  external_order_id: z.string().nullable().optional(),
  appOrderId: z.string().nullable().optional(),
  workspace: z.string().nullable().optional(),
  platform: z.string().nullable().optional(),

  // Simple contact (legacy) — also accepted as `contact` alias
  contact: contactSchema.nullable().optional(),

  // Rich billing contact (camelCase)
  billing: billingSchema.nullable().optional(),

  // Checkout opt-in for WhatsApp order updates. Sent explicitly (true/false)
  // by the storefront; when true, whatsapp_consent is enabled on the billing
  // contact. False/absent never revokes existing consent.
  whatsapp_opt_in: z.boolean().nullable().optional(),

  // Recipient contact
  recipient: recipientSchema.nullable().optional(),

  // Simple line items (legacy: line_items with snake_case)
  line_items: z.array(lineItemSchema).optional(),

  // Rich items (camelCase: items array from checkout)
  items: z.array(checkoutItemSchema).optional(),

  // Fee items (extras like greeting card, ribbon, etc.)
  feeItems: z.array(feeItemSchema).optional(),

  // Delivery details
  delivery: deliverySchema.nullable().optional(),
  delivery_address: z.unknown().nullable().optional(),
  deliveryDate: z.string().nullable().optional(),
  deliverySlot: z.string().nullable().optional(),
  delivery_date: z.string().nullable().optional(),
  delivery_slot: z.string().nullable().optional(),
  timeSlot: z.string().nullable().optional(),

  // Totals (legacy) and payment (rich)
  totals: totalsSchema.nullable().optional(),
  payment: paymentSchema.nullable().optional(),

  // Notes / card message
  // The storefront "Note for Presentail Team" field may arrive under any of
  // these aliases; all are accepted so the note is never dropped on ingest.
  notes: z.string().nullable().optional(),
  orderNotes: z.string().nullable().optional(),
  orderNote: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  cardMessage: z.string().nullable().optional(),
  cardFrom: z.string().nullable().optional(),
  cardTo: z.string().nullable().optional(),
  qrLink: z.string().nullable().optional(),

  // Discount / coupon code (camelCase and snake_case accepted)
  couponCode: z.string().nullable().optional(),
  coupon_code: z.string().nullable().optional(),
  // Coupon redemption (resolved by the storefront via /coupons/validate)
  couponId: z.string().uuid().nullable().optional(),
  couponDiscountUsd: z.number().nonnegative().nullable().optional(),

  ordered_at: z.string().datetime().nullable().optional(),

  // Marketing attribution (Google Ads + UTM) captured by the storefront.
  // Accepted as `unknown` in the body schema so that a malformed attribution
  // block never causes order rejection — it is validated separately below
  // with safeParse and silently dropped when invalid.
  marketing_attribution: z.unknown().nullable().optional(),

  // Anonymous order flag — when true the customer's name and email are masked
  // in staff-facing UIs. The contact record is preserved intact. Accepted
  // under all three field names used across storefronts.
  isAnonymous: z.boolean().nullable().optional(),
  senderAnonymous: z.boolean().nullable().optional(),
  anonymous: z.boolean().nullable().optional(),
}).refine(
  (d) =>
    (d.line_items && d.line_items.length > 0) ||
    (d.items && d.items.length > 0) ||
    (d.feeItems && d.feeItems.length > 0),
  {
    message:
      "Provide at least one entry in items, line_items, or feeItems (fee-only orders are allowed)",
  },
);

type OrderRow = {
  id: string;
  display_order_number: string | null;
  was_inserted: boolean;
  previous_delivery_address?: Record<string, unknown> | null;
};

function parseName(name: string | null | undefined): { firstName: string | null; lastName: string | null } {
  if (!name) return { firstName: null, lastName: null };
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0] ?? null, lastName: null };
  return {
    firstName: parts.slice(0, -1).join(" "),
    lastName: parts.at(-1) ?? null,
  };
}

/**
 * POST /api/orders
 *
 * Inbound order creation endpoint authenticated via workspace API key.
 *
 * Supports two payload shapes:
 *   1. Simple (legacy): { line_items, contact?, totals?, external_order_id?, ... }
 *   2. Rich (checkout): { items, feeItems?, billing?, recipient?, delivery?,
 *                         payment?, cardMessage?, cardFrom?, cardTo?,
 *                         orderNotes?, appOrderId?, platform?, ... }
 *
 * Also accepts backward-compatible aliases:
 *   customer / billing  → contact  (customer.name split into first/last)
 *   qty                 → quantity  (per line item)
 *   delivery_fee        → shipping  (inside totals)
 *   appOrderId          → external_order_id
 *
 * Idempotent on external_order_id / appOrderId: resubmitting returns the
 * existing order_id without duplicating data.
 *
 * Success: HTTP 201 { success: true, order_id: "<uuid>" }   (new order)
 *          HTTP 200 { success: true, order_id: "<uuid>" }   (duplicate)
 * Failure: HTTP 400 { success: false, error: "<message>" }
 *          HTTP 500 { success: false, error: "<message>" }
 */
router.post(
  "/orders",
  requireApiKey,
  async (req: Request, res: Response): Promise<void> => {
    const rawBody = req.body ?? {};

    // ── Alias normalization ──────────────────────────────────────────────────
    // Resolve contact from: contact | customer | billing (in priority order).
    let normalizedContact = rawBody.contact;
    if (!normalizedContact && rawBody.customer && typeof rawBody.customer === "object") {
      const c = rawBody.customer as Record<string, unknown>;
      // Support both camelCase (firstName) and snake_case (first_name) fields.
      // When neither is present, attempt to split a combined `name` field.
      const { firstName: nameFirst, lastName: nameLast } = parseName(
        c.name as string | null | undefined,
      );
      normalizedContact = {
        first_name: ((c.firstName ?? c.first_name) as string | null) ?? nameFirst,
        last_name: ((c.lastName ?? c.last_name) as string | null) ?? nameLast,
        email: c.email ?? null,
        phone: c.phone ?? null,
      };
    }
    if (!normalizedContact && rawBody.billing && typeof rawBody.billing === "object") {
      const b = rawBody.billing as Record<string, unknown>;
      normalizedContact = {
        first_name: b.firstName ?? b.first_name ?? null,
        last_name: b.lastName ?? b.last_name ?? null,
        email: b.email ?? null,
        phone: b.phone ?? null,
      };
    }

    // Resolve items: prefer `items` (rich), fall back to `line_items` (legacy).
    let normalizedLineItems = rawBody.line_items;
    if (!Array.isArray(normalizedLineItems) || normalizedLineItems.length === 0) {
      if (Array.isArray(rawBody.items)) {
        normalizedLineItems = (rawBody.items as Record<string, unknown>[]).map((i) => ({
          sku: i.productId ?? null,
          name: i.productName ?? i.name,
          quantity: i.quantity ?? i.qty ?? 1,
          unit_price: i.priceUsd ?? i.unit_price ?? null,
          paid_unit_price: i.paidUnitPrice ?? i.paid_unit_price ?? null,
          custom_input: i.customInput ?? i.custom_input ?? null,
          image_url: i.imageUrl ?? i.image_url ?? null,
        }));
      }
    } else {
      // Normalize qty/unit_price aliases in legacy format.
      normalizedLineItems = (normalizedLineItems as Record<string, unknown>[]).map((i) => ({
        ...i,
        quantity: i.quantity ?? i.qty ?? 1,
        paid_unit_price: i.paid_unit_price ?? i.paidUnitPrice ?? null,
        custom_input: i.custom_input ?? i.customInput ?? null,
        image_url: i.image_url ?? i.imageUrl ?? null,
      }));
    }

    // Normalize totals: accept delivery_fee as alias for shipping.
    let normalizedTotals = rawBody.totals;
    if (normalizedTotals && typeof normalizedTotals === "object") {
      const t = normalizedTotals as Record<string, unknown>;
      normalizedTotals = {
        ...t,
        shipping: t.shipping ?? t.delivery_fee ?? undefined,
        paid_subtotal: t.paid_subtotal ?? t.paidSubtotal ?? undefined,
        paid_shipping:
          t.paid_shipping ?? t.paid_delivery_fee ?? t.paidDeliveryFee ?? undefined,
      };
    }

    const normalizedBody = {
      ...rawBody,
      contact: normalizedContact,
      line_items: normalizedLineItems,
      totals: normalizedTotals,
      external_order_id: rawBody.external_order_id ?? rawBody.appOrderId ?? null,
    };

    const parsed = externalOrderBodySchema.safeParse(normalizedBody);
    if (!parsed.success) {
      // Build a human-readable message that names every offending field so
      // callers get an actionable explanation instead of a bare status code.
      const error = parsed.error.issues
        .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
        .join("; ") || "Invalid input";
      res.status(400).json({ success: false, error });
      return;
    }

    const d = parsed.data;
    const ownerId = (req as ApiKeyAuthedRequest).userId;

    // Normalize coupon code: accept couponCode (camelCase) or coupon_code (snake_case).
    const couponCode = d.couponCode ?? d.coupon_code ?? null;

    // ── Product resolution ───────────────────────────────────────────────────
    // The external products endpoint exposes a stable string `sku` (and a numeric
    // `id`). Orders reference a product via that identifier (carried as the line
    // item's `sku`, populated from the checkout `productId`). Resolve each
    // identifier to the underlying workspace product so the created
    // order_line_items row links to it via the integer product_id FK and the
    // canonical sku. Resolution is by sku first, then by numeric id when the
    // identifier is all digits. A digit-string identifier never throws — an
    // unresolved value is stored as the line item sku with a null product_id.
    type ResolvedProduct = {
      id: number;
      sku: string | null;
      name: string | null;
      main_image_url: string | null;
    };
    const productBySku = new Map<string, ResolvedProduct>();
    const productById = new Map<number, ResolvedProduct>();
    const productByName = new Map<string, ResolvedProduct>();
    const identifiers = (d.line_items ?? [])
      .map((i) => (i.sku ?? "").trim())
      .filter((s) => s.length > 0);
    // Exact-name fallback: when the sku/id doesn't resolve, an item whose name
    // exactly matches a workspace product (case-insensitive) still links.
    const itemNames = Array.from(
      new Set(
        (d.line_items ?? [])
          .map((i) => i.name.trim().toLowerCase())
          .filter((s) => s.length > 0),
      ),
    );
    if (identifiers.length > 0 || itemNames.length > 0) {
      const numericIds = Array.from(
        new Set(
          identifiers
            .filter((s) => /^\d+$/.test(s))
            .map((s) => parseInt(s, 10))
            .filter((n) => Number.isSafeInteger(n)),
        ),
      );
      // Best-effort: a failed product lookup must not block order creation.
      // Unresolved identifiers are stored as the line item sku with no FK.
      try {
        const resolveResult = await db.query<ResolvedProduct>(
          `SELECT id, sku, name, main_image_url FROM products
            WHERE workspace_owner_id = $1
              AND is_archived = false
              AND (sku = ANY($2::text[]) OR id = ANY($3::int[])
                   OR lower(name) = ANY($4::text[]))`,
          [ownerId, identifiers, numericIds, itemNames],
        );
        for (const row of resolveResult.rows) {
          if (row.sku) productBySku.set(row.sku, row);
          productById.set(row.id, row);
          if (row.name) {
            const key = row.name.trim().toLowerCase();
            // First match wins on duplicate names (deterministic best-effort).
            if (!productByName.has(key)) productByName.set(key, row);
          }
        }
      } catch (resolveErr) {
        logger.warn(
          { err: resolveErr },
          "externalOrders: product resolution failed; proceeding with unresolved skus",
        );
      }
    }

    const resolveProduct = (
      idStr: string | null | undefined,
      itemName?: string | null,
    ): { productId: number | null; sku: string | null; imageUrl: string | null } => {
      const s = (idStr ?? "").trim();
      const bySku = s ? productBySku.get(s) : undefined;
      if (bySku) {
        return { productId: bySku.id, sku: bySku.sku ?? s, imageUrl: bySku.main_image_url };
      }
      if (s && /^\d+$/.test(s)) {
        const n = parseInt(s, 10);
        const byId = productById.get(n);
        if (byId) return { productId: byId.id, sku: byId.sku ?? s, imageUrl: byId.main_image_url };
      }
      // Exact-name fallback (case-insensitive) when the identifier is missing
      // or unresolved.
      const nameKey = (itemName ?? "").trim().toLowerCase();
      const byName = nameKey ? productByName.get(nameKey) : undefined;
      if (byName) {
        return {
          productId: byName.id,
          sku: byName.sku ?? (s || null),
          imageUrl: byName.main_image_url,
        };
      }
      // Unresolved: keep the original identifier as the sku, no product link.
      return { productId: null, sku: s || null, imageUrl: null };
    };

    // ── Contact resolution ───────────────────────────────────────────────────
    let billingContactId: string | null = null;
    const contactData = d.contact ?? null;
    if (contactData && (contactData.email || contactData.phone || contactData.first_name || contactData.last_name)) {
      const firstName = contactData?.first_name ?? d.billing?.firstName ?? null;
      const lastName = contactData?.last_name ?? d.billing?.lastName ?? null;
      // Best-effort: a contact upsert failure (e.g. a cross-constraint unique
      // violation on email/phone) must not block order creation.
      try {
        billingContactId = await upsertContact({
          workspaceOwnerId: ownerId,
          source: "external",
          firstName,
          lastName,
          displayName: [firstName, lastName].filter(Boolean).join(" ") || null,
          email: contactData.email ?? null,
          phone: contactData.phone ?? null,
          // Fold WhatsApp opt-in consent atomically into the upsert so it is
          // never silently lost if a follow-up UPDATE were to fail.
          whatsappConsent: d.whatsapp_opt_in === true,
        });
      } catch (contactErr) {
        logger.warn(
          { err: contactErr },
          "externalOrders: billing contact upsert failed; order will be created without it",
        );
      }

      // Persist the billing country code onto the contact. There is no dedicated
      // country column on contacts, so it is merged into the contact's metadata
      // JSON (best-effort: a failure must never block order creation).
      const billingCountryCode = d.billing?.countryCode ?? null;
      if (billingContactId && billingCountryCode) {
        try {
          await db.query(
            `UPDATE contacts
               SET metadata = COALESCE(metadata, '{}'::jsonb)
                              || jsonb_build_object('country_code', $2::text),
                   updated_at = now()
             WHERE id = $1`,
            [billingContactId, billingCountryCode],
          );
        } catch (countryErr) {
          logger.warn(
            { err: countryErr },
            "externalOrders: failed to persist billing country code; order still created",
          );
        }
      }
    }

    let recipientContactId: string | null = null;
    if (d.recipient && (d.recipient.firstName || d.recipient.lastName || d.recipient.phone)) {
      // Best-effort: see billing contact note above.
      try {
        recipientContactId = await upsertContact({
          workspaceOwnerId: ownerId,
          source: "external",
          firstName: d.recipient.firstName ?? null,
          lastName: d.recipient.lastName ?? null,
          displayName: [d.recipient.firstName, d.recipient.lastName].filter(Boolean).join(" ") || null,
          email: null,
          phone: d.recipient.phone ?? null,
        });
      } catch (contactErr) {
        logger.warn(
          { err: contactErr },
          "externalOrders: recipient contact upsert failed; order will be created without it",
        );
      }
    }

    // ── Build totals JSON ───────────────────────────────────────────────────
    // Use the rich payment/delivery data when the simple totals isn't provided.
    // The stored `total` must always reflect the full amount charged to the
    // payment provider (including the delivery fee), so OS matches Stripe.
    const deliveryFee =
      (d.delivery?.feeUsd ?? 0) +
      (d.delivery?.expressSurchargeUsd ?? 0) +
      (d.delivery?.slotFeeUsd ?? 0);
    let totalsJson: Record<string, unknown> | null = null;
    if (d.totals) {
      // Prefer the website-supplied shipping; otherwise derive it from the
      // delivery block so the delivery fee is never dropped from the total.
      const _lineItemsTotal = (d.line_items ?? []).reduce(
        (sum, i) => sum + (i.unit_price ?? 0) * i.quantity,
        0,
      );
      const shipping = deliveryFee > 0 ? deliveryFee : null;
      const subtotal = _lineItemsTotal > 0 ? _lineItemsTotal : null;
      const discount = d.totals.discount ?? null;
      // Authoritative charged amount:
      // 1. payment.totalUsd — what the provider actually received (highest priority)
      // 2. d.totals.total  — what the website calculated (may omit delivery fee)
      // 3. computed         — subtotal + shipping − discount (fallback)
      const _paymentUsdTotal =
        typeof d.payment?.totalUsd === "number" && Number.isFinite(d.payment.totalUsd)
          ? d.payment.totalUsd
          : null;
      const _rawTotalsTotal =
        typeof d.totals.total === "number" && Number.isFinite(d.totals.total)
          ? d.totals.total
          : null;
      const computedTotal = (subtotal ?? 0) + (shipping ?? 0) - (discount ?? 0);
      const total = _paymentUsdTotal ?? _rawTotalsTotal ?? computedTotal;
      totalsJson = {
        subtotal,
        shipping,
        discount,
        total,
        currency: d.totals.currency ?? "USD",
      };
    } else if (d.payment || d.delivery) {
      const _lineItemsTotal = (d.line_items ?? []).reduce(
        (sum, i) => sum + (i.unit_price ?? 0) * i.quantity,
        0,
      );
      const subtotal = _lineItemsTotal > 0 ? _lineItemsTotal : null;
      const shipping = deliveryFee > 0 ? deliveryFee : null;
      const _paymentUsdTotal =
        typeof d.payment?.totalUsd === "number" && Number.isFinite(d.payment.totalUsd)
          ? d.payment.totalUsd
          : null;
      const computedTotal = (subtotal ?? 0) + (shipping ?? 0);
      const total = _paymentUsdTotal ?? computedTotal;
      totalsJson = {
        subtotal,
        shipping,
        total,
        currency: "USD",
      };
    }

    // ── Paid-currency capture ───────────────────────────────────────────────
    // When the customer paid in a non-USD currency the website sends BOTH the
    // USD equivalent (payment.totalUsd → totals.total) and the amount actually
    // charged (payment.totalAmount + currencyCode). Store the paid pair in the
    // totals JSON so the dashboard/emails can show what was really paid. USD
    // orders are untouched — the totals JSON stays exactly as before.
    const payloadPaidCurrencyRaw = d.payment?.currencyCode?.trim() || null;
    let paidCurrency = payloadPaidCurrencyRaw ? payloadPaidCurrencyRaw.toUpperCase() : null;

    // Double-conversion guard: when the incoming totals already carry a
    // pre-converted paid pair (set by the storefront after applying its own
    // rate), use it directly — do NOT re-apply any exchange rate. The Stripe-
    // verified amount (below) still unconditionally wins over both sources.
    const preConvertedPaidTotal =
      typeof d.totals?.paid_total === "number" && Number.isFinite(d.totals.paid_total)
        ? d.totals.paid_total
        : null;
    const preConvertedPaidCurrency =
      typeof d.totals?.paid_currency === "string" && d.totals.paid_currency.trim() !== ""
        ? d.totals.paid_currency.trim().toUpperCase()
        : null;

    let paidAmount: number | null;
    if (
      preConvertedPaidTotal != null &&
      preConvertedPaidCurrency != null
    ) {
      // Authoritative pre-converted pair in totals: use it directly for ALL
      // currencies, including USD. payment.currencyCode can disagree (e.g.
      // storefront sends AED code while totals carries SAR, or sends a non-USD
      // code while totals.paid_currency is "USD"). In every case, adopting the
      // payment currency instead of the totals currency produces a mismatched
      // amount/currency pair in the payment record.
      paidAmount = preConvertedPaidTotal;
      paidCurrency = preConvertedPaidCurrency;
      // Warn when payment.totalAmount also exists and disagrees materially.
      const payloadTotalAmount =
        typeof d.payment?.totalAmount === "number" && Number.isFinite(d.payment.totalAmount)
          ? d.payment.totalAmount
          : null;
      if (payloadTotalAmount != null && Math.abs(payloadTotalAmount - preConvertedPaidTotal) > 0.01) {
        logger.warn(
          {
            preConvertedPaidTotal,
            payloadTotalAmount,
            currency: preConvertedPaidCurrency,
          },
          "externalOrders: totals.paid_total and payment.totalAmount disagree; using pre-converted totals.paid_total as authoritative",
        );
      }
    } else {
      paidAmount =
        typeof d.payment?.totalAmount === "number" && Number.isFinite(d.payment.totalAmount)
          ? d.payment.totalAmount
          : null;
    }

    // Stripe is the source of truth for the paid amount: the storefront has
    // sent wrong `totalAmount` values before (the USD figure paired with a
    // foreign currencyCode). When the payload carries a Stripe payment intent
    // reference, retrieve the intent and use its amount/currency as the
    // authoritative paid pair. Fail-open: if Stripe can't be reached the
    // payload values are used unchanged (the startup repair pass fixes it
    // later).
    let stripeVerified = false;
    if (isStripeMethod(d.payment?.method) && isStripePaymentIntentRef(d.payment?.ref)) {
      const verification = await verifyStripePaymentIntentAmount(d.payment.ref);
      if (verification.status === "ok") {
        stripeVerified = true;
        if (
          (paidAmount != null && paidAmount !== verification.amount) ||
          (paidCurrency != null && paidCurrency !== verification.currency)
        ) {
          logger.warn(
            {
              paymentRef: d.payment.ref,
              payloadAmount: paidAmount,
              payloadCurrency: paidCurrency,
              stripeAmount: verification.amount,
              stripeCurrency: verification.currency,
            },
            "externalOrders: payload paid amount disagrees with Stripe; using the Stripe-verified amount",
          );
        }
        paidAmount = verification.amount;
        paidCurrency = verification.currency;
      }
    }

    // NOTE: there is intentionally NO "mislabeled currency" sanity guard here.
    // A previous heuristic dropped the paid pair when the local-currency amount
    // was within ~1% of the USD total, but that also discarded genuine paid
    // amounts that happen to be numerically close to the USD figure (e.g.
    // AED 170 on a USD ~168 order), so emails showed USD while the dashboard
    // showed AED. The payload paid pair is stored verbatim; Stripe verification
    // above remains the authoritative correction when a payment intent ref is
    // present.

    // When the payload names a non-USD payment currency but omits
    // payment.totalAmount, derive the paid total from the other paid-currency
    // figures it DID send — order-level charged amounts
    // (payment.subtotalAmount / deliveryFeeAmount or their legacy totals
    // aliases) or, failing that, the per-line paid_unit_price amounts. Only
    // real payload figures are summed; no conversion rate is ever invented.
    // Without any of them the paid pair stays unset, so downstream display
    // falls back to USD-labeled USD amounts instead of mislabeling.
    if (paidCurrency && paidCurrency !== "USD" && paidAmount == null) {
      const paidSubtotalSrc = d.payment?.subtotalAmount ?? d.totals?.paid_subtotal ?? null;
      const paidShippingSrc = d.payment?.deliveryFeeAmount ?? d.totals?.paid_shipping ?? null;
      const finiteShipping =
        typeof paidShippingSrc === "number" && Number.isFinite(paidShippingSrc)
          ? paidShippingSrc
          : null;
      if (typeof paidSubtotalSrc === "number" && Number.isFinite(paidSubtotalSrc)) {
        paidAmount = paidSubtotalSrc + (finiteShipping ?? 0);
      } else {
        const items = d.line_items ?? [];
        const allLinesPaid =
          items.length > 0 &&
          items.every(
            (i) => typeof i.paid_unit_price === "number" && Number.isFinite(i.paid_unit_price),
          );
        if (allLinesPaid) {
          const lineSum = items.reduce(
            (sum, i) => sum + (i.paid_unit_price as number) * i.quantity,
            0,
          );
          paidAmount = lineSum + (finiteShipping ?? 0);
        }
      }
    }

    // ── Mislabeled-pair plausibility guard ─────────────────────────────────
    // Known storefront failure mode: the USD figure paired with a foreign
    // currencyCode (e.g. totalAmount 168 + "QAR" on a USD 168 order actually
    // charged QAR ~630) with no Stripe intent ref available to correct it.
    // When the pair was NOT Stripe-verified, sanity-check the claimed foreign
    // amount against the USD figure of the same charge using reference rates
    // with a very generous tolerance (see paidPairPlausibility.ts — this is a
    // broad implausibility check, not the removed ±2% near-equality one).
    // Rejected pairs are not stored anywhere: totals, order_payment, and
    // line-item paid prices all fall back to USD-labeled USD amounts.
    // Corroboration: when the storefront really charged in the foreign
    // currency it sends the paid-currency breakdown alongside the total
    // (payment.subtotalAmount / deliveryFeeAmount, a pre-converted totals
    // pair, legacy totals.paid_subtotal/paid_shipping, or per-line paid
    // prices). The observed mislabeled payloads carry ONLY a bare
    // totalAmount that echoes the USD figure. Corroborated pairs are stored
    // verbatim (the Stripe startup repair still re-checks them); only a bare,
    // uncorroborated pair is subjected to the rate check below.
    const hasPaidBreakdown =
      (typeof d.payment?.subtotalAmount === "number" &&
        Number.isFinite(d.payment.subtotalAmount)) ||
      (typeof d.payment?.deliveryFeeAmount === "number" &&
        Number.isFinite(d.payment.deliveryFeeAmount)) ||
      (preConvertedPaidTotal != null && preConvertedPaidCurrency != null) ||
      (typeof d.totals?.paid_subtotal === "number" && Number.isFinite(d.totals.paid_subtotal)) ||
      (typeof d.totals?.paid_shipping === "number" && Number.isFinite(d.totals.paid_shipping)) ||
      (d.line_items ?? []).some(
        (i) => typeof i.paid_unit_price === "number" && Number.isFinite(i.paid_unit_price),
      );
    let paidPairRejected = false;
    if (
      !stripeVerified &&
      !hasPaidBreakdown &&
      paidCurrency &&
      paidCurrency !== "USD" &&
      paidAmount != null
    ) {
      // Compare against the USD amount of the SAME charge: payment.totalUsd
      // first (it describes the same payment as totalAmount), then the USD
      // order total.
      const usdReference =
        typeof d.payment?.totalUsd === "number" && Number.isFinite(d.payment.totalUsd)
          ? d.payment.totalUsd
          : totalsJson && typeof totalsJson.total === "number" && Number.isFinite(totalsJson.total)
            ? totalsJson.total
            : null;
      const check = checkPaidPairPlausibility(paidAmount, paidCurrency, usdReference);
      if (!check.plausible) {
        logger.warn(
          {
            paidAmount,
            paidCurrency,
            usdReference,
            impliedRate: check.impliedRate,
            referenceRate: check.referenceRate,
          },
          "externalOrders: paid pair implausible against exchange rate — treating as mislabeled (likely the USD figure with a foreign currency code); falling back to USD-labeled USD amounts",
        );
        paidAmount = null;
        paidCurrency = null;
        paidPairRejected = true;
      }
    }

    if (totalsJson && paidCurrency && paidCurrency !== "USD" && paidAmount != null) {
      totalsJson.paid_total = paidAmount;
      totalsJson.paid_currency = paidCurrency;
      // Order-level charged amounts in the paid currency (what the storefront
      // displayed and charged for the items subtotal and the delivery fee).
      // Rich payloads send payment.subtotalAmount / payment.deliveryFeeAmount;
      // legacy payloads may send totals.paid_subtotal / totals.paid_shipping.
      // Stored alongside paid_total so order emails can show the exact
      // website amounts instead of implied-rate conversions.
      const paidSubtotal = d.payment?.subtotalAmount ?? d.totals?.paid_subtotal ?? null;
      const paidShipping = d.payment?.deliveryFeeAmount ?? d.totals?.paid_shipping ?? null;
      if (typeof paidSubtotal === "number" && Number.isFinite(paidSubtotal)) {
        totalsJson.paid_subtotal = paidSubtotal;
      }
      if (typeof paidShipping === "number" && Number.isFinite(paidShipping)) {
        totalsJson.paid_shipping = paidShipping;
      }
    }
    if (totalsJson && stripeVerified) {
      // Marker consumed by the startup repair pass so already-verified orders
      // are never re-checked against Stripe.
      totalsJson.stripe_verified = true;
    }

    // ── Delivery date resolution ────────────────────────────────────────────
    // Resolve the order's received date once so the same value drives the
    // ordered_at column, the delivery-date auto-correction, and the review
    // flag below.
    const orderedAtIso = d.ordered_at
      ? new Date(d.ordered_at).toISOString()
      : new Date().toISOString();

    // Auto-correct a delivery date that is before the order date (e.g. the
    // customer picked "today" just before midnight and checked out after) by
    // bumping it to the order date, and flag it for staff review with a
    // message naming the original date. A date merely in the past (but not
    // before the order date) keeps the plain "in the past" flag and is NOT
    // corrected. Compared at day granularity in the delivery timezone. The
    // original customer-picked date stays untouched in raw_payload. Re-ingest
    // computes newly submitted values here; the upsert below preserves either
    // stored schedule member when the latest submission omits it.
    const legacyDeliveryAddress =
      typeof d.delivery_address === "object" && d.delivery_address !== null
        ? d.delivery_address as Record<string, unknown>
        : {};
    const firstScheduleString = (...values: unknown[]): string | null => {
      for (const value of values) {
        if (typeof value === "string" && value.trim()) return value.trim();
      }
      return null;
    };
    const receivedDeliveryDate = firstScheduleString(
      d.delivery?.date,
      d.delivery?.deliveryDate,
      d.delivery?.delivery_date,
      legacyDeliveryAddress.date,
      legacyDeliveryAddress.deliveryDate,
      legacyDeliveryAddress.delivery_date,
      d.deliveryDate,
      d.delivery_date,
    );
    const receivedDeliverySlot = firstScheduleString(
      d.delivery?.slot,
      d.delivery?.deliverySlot,
      d.delivery?.delivery_slot,
      d.delivery?.timeSlot,
      legacyDeliveryAddress.slot,
      legacyDeliveryAddress.deliverySlot,
      legacyDeliveryAddress.delivery_slot,
      legacyDeliveryAddress.timeSlot,
      d.deliverySlot,
      d.delivery_slot,
      d.timeSlot,
    );
    const receivedExpressFlag =
      d.delivery?.isExpress ??
      (/^express$/i.test(receivedDeliverySlot ?? "") ? true : null);
    const { date: effectiveDeliveryDate, review: deliveryDateReview } =
      resolveDeliveryDate(
        receivedDeliveryDate,
        orderedAtIso,
        process.env.TOOKAN_TIMEZONE ?? "UTC",
        receivedDeliverySlot,
      );

    // ── Card-message guard ──────────────────────────────────────────────────
    // Clear card_to and card_from when there is no card message. The storefront
    // sends the recipient name as cardTo regardless of whether the sender wrote
    // a message; storing it without a message causes the PDF and dashboard to
    // show a floating "To:" line the sender never intended.
    const cardMessageTrimmed = (d.cardMessage ?? "").trim();
    const effectiveCardMessage = cardMessageTrimmed || null;
    const effectiveCardTo = cardMessageTrimmed ? (d.cardTo ?? null) : null;
    const effectiveCardFrom = cardMessageTrimmed ? (d.cardFrom ?? null) : null;

    // ── Build delivery_address JSON ─────────────────────────────────────────
    let deliveryAddressJson: unknown = d.delivery_address ?? null;
    if (d.delivery || effectiveDeliveryDate || receivedDeliverySlot) {
      const existingDeliveryAddress =
        typeof deliveryAddressJson === "object" && deliveryAddressJson !== null
          ? deliveryAddressJson as Record<string, unknown>
          : {};
      deliveryAddressJson = {
        ...existingDeliveryAddress,
        ...(d.delivery ?? {}),
        district: d.delivery?.district ?? existingDeliveryAddress.district ?? null,
        cityId: d.delivery?.cityId ?? existingDeliveryAddress.cityId ?? null,
        city_id: d.delivery?.city_id ?? existingDeliveryAddress.city_id ?? null,
        cityName: d.delivery?.cityName ?? existingDeliveryAddress.cityName ?? null,
        city_name: d.delivery?.city_name ?? existingDeliveryAddress.city_name ?? null,
        city: d.delivery?.city ?? existingDeliveryAddress.city ?? null,
        citySlug: d.delivery?.citySlug ?? existingDeliveryAddress.citySlug ?? null,
        city_slug: d.delivery?.city_slug ?? existingDeliveryAddress.city_slug ?? null,
        countryCode:
          d.delivery?.countryCode ?? existingDeliveryAddress.countryCode ?? null,
        country_code:
          d.delivery?.country_code ?? existingDeliveryAddress.country_code ?? null,
        address: d.delivery?.address ?? existingDeliveryAddress.address ?? null,
        phone: d.delivery?.phone ?? existingDeliveryAddress.phone ?? d.recipient?.phone ?? null,
        noAddress: d.delivery?.noAddress ?? existingDeliveryAddress.noAddress ?? false,
        date: effectiveDeliveryDate,
        slot: receivedDeliverySlot,
        isExpress:
          receivedExpressFlag ??
          existingDeliveryAddress.isExpress ??
          false,
        feeUsd: d.delivery?.feeUsd ?? existingDeliveryAddress.feeUsd ?? null,
        expressSurchargeUsd: d.delivery?.expressSurchargeUsd ?? existingDeliveryAddress.expressSurchargeUsd ?? null,
        slotFeeUsd: d.delivery?.slotFeeUsd ?? existingDeliveryAddress.slotFeeUsd ?? null,
        cardFrom: effectiveCardFrom,
        cardTo: effectiveCardTo,
      };
    }

    // ── Order creation ───────────────────────────────────────────────────────
    // Acquire a dedicated client and run inside a transaction. The order row is
    // the ONLY critical write: once it succeeds the order is created. Every child
    // record (line items, contacts, payment record, card note) is written as a
    // best-effort, SAVEPOINT-isolated statement, so a failure in any of them is
    // logged but never rolls back the order. Requirement: the sole reason an
    // order is not created is a payment failure — never a secondary write error
    // such as a schema mismatch on a child table.
    // A paid order should land in "processing" rather than "pending" — once the
    // money is in, the order is ready to be worked on. An unpaid (or
    // unverified-payment) order stays "pending". The status is bound as a
    // parameter ($9, appended at the end so existing $1–$8 positions are
    // unchanged). Note: re-ingests (ON CONFLICT DO UPDATE) intentionally do NOT
    // touch status, so a manually-advanced order is never reset.
    const initialOrderStatus = d.payment?.verified === true ? "processing" : "pending";
    const client = await db.connect();
    let orderId = "";
    let displayNumber: string | null = null;
    let wasInserted = false;
    let addressChangedOnUpsert = false;
    try {
      await client.query("BEGIN");

      // Validate and serialize marketing attribution. The body schema accepts
      // this field as `unknown` to prevent a malformed attribution block from
      // rejecting the order. We now do the real schema check here with
      // safeParse and silently drop invalid data — never blocking order creation.
      let marketingAttributionJson: string | null = null;
      try {
        if (d.marketing_attribution != null) {
          const attrResult = marketingAttributionSchema.safeParse(d.marketing_attribution);
          if (attrResult.success && attrResult.data != null) {
            marketingAttributionJson = JSON.stringify(attrResult.data);
          } else if (!attrResult.success) {
            logger.warn(
              { issues: attrResult.error.issues },
              "externalOrders: marketing_attribution failed validation and will be dropped; order still created",
            );
          }
        }
      } catch {
        // attribution serialisation failed — proceed without it
      }

      const insertResult = await client.query<OrderRow>(
        `WITH existing AS (
           SELECT id, delivery_address
             FROM orders
            WHERE workspace_owner_id = $1
              AND source = 'external'
              AND external_order_id = $2
            FOR UPDATE
         ), upsert AS (
         INSERT INTO orders
           (workspace_owner_id, source, external_order_id, status,
            ordered_at, delivery_address, delivery_type, delivery_instructions,
            totals, raw_payload, card_message, card_from, card_to, qr_link,
            marketing_attribution, delivery_date_review, is_anonymous)
         VALUES ($1, 'external', $2, $9, $3, $4, $5, $6, $7, $8, $10, $11, $12, $13, $14, $15, $16)
         ON CONFLICT (workspace_owner_id, source, external_order_id)
           WHERE external_order_id IS NOT NULL
           DO UPDATE SET
             ordered_at            = COALESCE(EXCLUDED.ordered_at, orders.ordered_at),
             delivery_address      = CASE
               WHEN EXCLUDED.delivery_address IS NULL THEN orders.delivery_address
               ELSE jsonb_set(
                 jsonb_set(
                   EXCLUDED.delivery_address,
                   '{date}',
                   COALESCE(
                     CASE WHEN NULLIF(btrim(EXCLUDED.delivery_address->>'date'), '') IS NOT NULL
                       THEN EXCLUDED.delivery_address->'date' END,
                     orders.delivery_address->'date',
                     'null'::jsonb
                   ),
                   true
                 ),
                 '{slot}',
                 COALESCE(
                   CASE WHEN NULLIF(btrim(EXCLUDED.delivery_address->>'slot'), '') IS NOT NULL
                     THEN EXCLUDED.delivery_address->'slot' END,
                   orders.delivery_address->'slot',
                   'null'::jsonb
                 ),
                 true
               )
             END,
             delivery_type         = COALESCE(EXCLUDED.delivery_type, orders.delivery_type),
             delivery_instructions = COALESCE(EXCLUDED.delivery_instructions, orders.delivery_instructions),
             card_message          = COALESCE(EXCLUDED.card_message, orders.card_message),
             card_from             = EXCLUDED.card_from,
             card_to               = EXCLUDED.card_to,
             qr_link               = COALESCE(EXCLUDED.qr_link, orders.qr_link),
             totals                = EXCLUDED.totals,
             raw_payload           = EXCLUDED.raw_payload,
             marketing_attribution = COALESCE(EXCLUDED.marketing_attribution, orders.marketing_attribution),
             delivery_date_review  = EXCLUDED.delivery_date_review,
             is_anonymous          = EXCLUDED.is_anonymous,
             updated_at            = now()
         RETURNING id, display_order_number, (xmax = 0) AS was_inserted
         )
         SELECT upsert.id, upsert.display_order_number, upsert.was_inserted,
                existing.delivery_address AS previous_delivery_address
           FROM upsert
      LEFT JOIN existing ON existing.id = upsert.id`,
        [
          ownerId,
          d.external_order_id ?? null,
          orderedAtIso,
          deliveryAddressJson ? JSON.stringify(deliveryAddressJson) : null,
          receivedExpressFlag === true
            ? "express"
            : (d.delivery || effectiveDeliveryDate || receivedDeliverySlot ? "standard" : null),
          d.orderNotes ?? d.notes ?? d.orderNote ?? d.note ?? null,
          totalsJson ? JSON.stringify(totalsJson) : null,
          JSON.stringify({ ...rawBody, couponCode, _platform: d.platform ?? null }),
          initialOrderStatus,
          effectiveCardMessage,
          effectiveCardFrom,
          effectiveCardTo,
          d.qrLink ?? null,
          marketingAttributionJson,
          deliveryDateReview,
          d.isAnonymous ?? d.senderAnonymous ?? d.anonymous ?? false,
        ],
      );

      const orderRow = insertResult.rows[0];
      if (!orderRow) {
        await client.query("ROLLBACK");
        res.status(500).json({ success: false, error: "Failed to create order" });
        return;
      }
      orderId = orderRow.id;
      displayNumber = orderRow.display_order_number;
      wasInserted = orderRow.was_inserted;
      addressChangedOnUpsert =
        !wasInserted
        && (d.delivery_address != null || d.delivery != null)
        && !tookanDestinationsEqual(
          orderRow.previous_delivery_address ?? null,
          deliveryAddressJson as Record<string, unknown> | null,
        );

      // Best-effort wrapper for non-critical child records. Each runs inside its
      // own SAVEPOINT, so if the statement fails (e.g. a schema mismatch on a
      // child table) only that one statement is rolled back — the order row and
      // every other child write still commit. Without the SAVEPOINT a single
      // failed statement would poison the whole transaction (Postgres aborts it),
      // discarding the order. This guarantees a successful payment always yields
      // a saved order.
      const runSideEffect = async (
        label: string,
        fn: () => Promise<void>,
      ): Promise<void> => {
        await client.query("SAVEPOINT side_effect");
        try {
          await fn();
          await client.query("RELEASE SAVEPOINT side_effect");
        } catch (sideErr) {
          await client.query("ROLLBACK TO SAVEPOINT side_effect");
          await client.query("RELEASE SAVEPOINT side_effect");
          logger.warn(
            { err: sideErr, orderId, label },
            "externalOrders: non-critical side-effect failed; order still created",
          );
        }
      };

      // ── Side effects — only on first INSERT ─────────────────────────────
      if (wasInserted) {
        // Line items (main items)
        for (const item of d.line_items ?? []) {
          const resolved = resolveProduct(item.sku, item.name);
          // Server-enforced 22-char cap on the personalization input.
          const customInput =
            typeof item.custom_input === "string" && item.custom_input.trim() !== ""
              ? item.custom_input.slice(0, 22)
              : null;
          // Prefer the storefront-supplied image, else the resolved product's
          // main image, so florists always see the product picture.
          const imageUrl =
            (typeof item.image_url === "string" && item.image_url.trim() !== ""
              ? item.image_url
              : null) ?? resolved.imageUrl;
          await runSideEffect("line_item", async () => {
            await client.query(
              `INSERT INTO order_line_items (order_id, product_id, sku, name, quantity, unit_price, line_total, paid_unit_price, paid_line_total, custom_input, image_url)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
              [
                orderId,
                resolved.productId,
                resolved.sku,
                item.name,
                item.quantity,
                item.unit_price != null ? String(item.unit_price) : null,
                item.unit_price != null ? String(item.unit_price * item.quantity) : null,
                // When the order-level paid pair was rejected as mislabeled,
                // the per-line paid prices came from the same untrustworthy
                // payload figures — drop them too so every record agrees.
                item.paid_unit_price != null && !paidPairRejected
                  ? String(item.paid_unit_price)
                  : null,
                // Use integer minor-unit arithmetic to avoid floating-point
                // errors (e.g. 55.1 × 2 = 110.20000000000001 in IEEE 754).
                // Also respects currency's decimal rule: 0 for JPY, 3 for KWD.
                item.paid_unit_price != null && !paidPairRejected
                  ? computeLineTotal(item.paid_unit_price, item.quantity, paidCurrency ?? "USD")
                  : null,
                customInput,
                imageUrl,
              ],
            );
          });
        }

        // Fee items (greeting card, ribbon, etc.)
        for (const fee of d.feeItems ?? []) {
          await runSideEffect("fee_item", async () => {
            await client.query(
              `INSERT INTO order_line_items (order_id, sku, name, quantity, unit_price, line_total)
               VALUES ($1, NULL, $2, $3, $4, $5)`,
              [
                orderId,
                fee.name,
                fee.quantity,
                fee.priceUsd != null ? String(fee.priceUsd) : null,
                fee.priceUsd != null ? String(fee.priceUsd * fee.quantity) : null,
              ],
            );
          });
        }

        // Sensitive-occasion auto-detect (sympathy/funeral/condolence
        // products). Runs after all line items are written; best-effort.
        await runSideEffect("sensitive_occasion", async () => {
          await applySensitiveOccasionFlag(client, orderId, ownerId);
        });

        // Billing contact → role 'customer'
        if (billingContactId) {
          await runSideEffect("billing_contact", async () => {
            await client.query(
              `INSERT INTO order_contacts (order_id, contact_id, role)
               VALUES ($1, $2, 'customer')
               ON CONFLICT DO NOTHING`,
              [orderId, billingContactId],
            );
          });
        }

        // Recipient contact → role 'recipient'
        if (recipientContactId) {
          await runSideEffect("recipient_contact", async () => {
            await client.query(
              `INSERT INTO order_contacts (order_id, contact_id, role)
               VALUES ($1, $2, 'recipient')
               ON CONFLICT DO NOTHING`,
              [orderId, recipientContactId],
            );
          });
        }

        // Coupon redemption ledger. Recorded only on first INSERT and made
        // idempotent via the partial unique index on (coupon_id, order_id), so
        // a re-ingest never double-counts a redemption. The coupon must belong
        // to this workspace (guarded by the WHERE on the coupons sub-select).
        if (d.couponId) {
          const couponCustomerEmail =
            contactData?.email ?? d.billing?.email ?? null;
          await runSideEffect("coupon_redemption", async () => {
            await client.query(
              `INSERT INTO coupon_redemptions
                 (coupon_id, workspace_owner_id, order_id, customer_email, discount_amount_usd, status)
               SELECT c.id, c.workspace_owner_id, $2, $3, $4, 'confirmed'
                 FROM coupons c
                WHERE c.id = $1 AND c.workspace_owner_id = $5
               ON CONFLICT (coupon_id, order_id) WHERE order_id IS NOT NULL DO NOTHING`,
              [
                d.couponId,
                orderId,
                couponCustomerEmail,
                d.couponDiscountUsd != null ? String(d.couponDiscountUsd) : "0",
                ownerId,
              ],
            );
          });
        }

        // Card message (text, from, to) is stored as dedicated columns on the
        // orders row during the INSERT above — no separate order_notes write.
      }

      // A retry can contain delayed recipient data even when the order already
      // exists. Preserve the first-insert side-effect order above and fill
      // missing role links only for this re-ingestion path.
      if (!wasInserted && billingContactId) {
        await runSideEffect("billing_contact", async () => {
          await client.query(
            `INSERT INTO order_contacts (order_id, contact_id, role)
             VALUES ($1, $2, 'customer')
             ON CONFLICT DO NOTHING`,
            [orderId, billingContactId],
          );
        });
      }
      if (!wasInserted && recipientContactId) {
        await runSideEffect("recipient_contact", async () => {
          // A retry can carry corrected recipient data. Replace older
          // recipient-role links for this order, while retaining the customer
          // role as a fallback only when no recipient exists.
          await client.query(
            `DELETE FROM order_contacts
              WHERE order_id = $1
                AND role = 'recipient'
                AND contact_id <> $2`,
            [orderId, recipientContactId],
          );
          await client.query(
            `INSERT INTO order_contacts (order_id, contact_id, role)
             VALUES ($1, $2, 'recipient')
             ON CONFLICT DO NOTHING`,
            [orderId, recipientContactId],
          );
        });
      }

      // Payment record. Runs on BOTH first-ingest and re-ingest so the charged
      // amount always reflects what the customer actually paid: on re-ingest the
      // ON CONFLICT DO UPDATE refreshes amount_usd (via EXCLUDED) even though the
      // rest of the side effects above are first-INSERT only. This only records
      // an already-completed payment; a failure to write it must not discard the
      // order.
      const paymentStatus = d.payment?.verified ? "paid" : "pending";
      // Currency comes from the Stripe-verified currency first (source of
      // truth when the payload carried a payment intent ref), then the
      // authoritative paidCurrency (which may have been set from the
      // pre-converted totals pair — overriding a conflicting payment.currencyCode),
      // then the legacy totals currency, finally defaulting to USD. When the
      // paid pair was rejected as mislabeled, force USD: the only trustworthy
      // amount left is the USD figure, and pairing it with a payload currency
      // would recreate exactly the mismatch the guard removed.
      const paymentCurrency = paidPairRejected
        ? "USD"
        : paidCurrency ??
          d.totals?.currency ??
          "USD";
      // The USD equivalent of the charge (explicitly USD — the column name says
      // so), kept independent of the totals JSON.
      const chargedAmountUsd =
        d.payment?.totalUsd ??
        (typeof totalsJson?.total === "number" ? totalsJson.total : null);
      // The amount actually charged in `paymentCurrency`, so the (currency,
      // amount) pair is always consistent: for non-USD charges this is
      // payment.totalAmount; for USD charges it equals the USD amount. Never
      // pair a foreign currency code with the USD figure.
      const chargedAmount =
        paidAmount != null
          ? paidAmount
          : paymentCurrency.trim().toUpperCase() === "USD"
            ? chargedAmountUsd
            : null;
      // Persist the payment provider when it can be derived: a known provider
      // name in `method` (the website sends "stripe"/"paypal" there), or a
      // Stripe payment-intent ref (pi_...). Refund eligibility keys off this.
      const methodLower = (d.payment?.method ?? "").trim().toLowerCase();
      const paymentProvider =
        methodLower === "stripe" || methodLower === "paypal"
          ? methodLower
          : (d.payment?.ref ?? "").startsWith("pi_")
            ? "stripe"
            : null;
      await runSideEffect("payment_record", async () => {
        await client.query(
          `INSERT INTO order_payment (order_id, method, provider, provider_ref, status, currency, amount_usd, amount)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (order_id) DO UPDATE SET
             amount_usd = EXCLUDED.amount_usd,
             currency   = EXCLUDED.currency,
             amount     = EXCLUDED.amount
             ${d.payment ? `,
             method     = COALESCE(EXCLUDED.method, order_payment.method),
             provider   = COALESCE(EXCLUDED.provider, order_payment.provider),
             provider_ref = COALESCE(EXCLUDED.provider_ref, order_payment.provider_ref),
             status     = EXCLUDED.status` : ""}`,
          [
            orderId,
            d.payment?.method ?? null,
            paymentProvider,
            d.payment?.ref ?? null,
            paymentStatus,
            paymentCurrency,
            chargedAmountUsd,
            chargedAmount,
          ],
        );
      });

      await client.query("COMMIT");
    } catch (err) {
      try { await client.query("ROLLBACK"); } catch { /* swallow rollback errors */ }
      logger.error({ err }, "externalOrders: failed to create order");
      // Surface the specific failure so the (API-key authenticated) caller can
      // self-diagnose instead of getting a bare "Failed to create order".
      const e = err as { message?: unknown; code?: unknown; detail?: unknown };
      const detail =
        typeof e?.message === "string" && e.message.trim()
          ? e.message.trim()
          : "Unknown error";
      const pgCode = typeof e?.code === "string" ? e.code : undefined;
      res.status(500).json({
        success: false,
        error: `Failed to create order: ${detail}`,
        detail,
        ...(pgCode ? { code: pgCode } : {}),
        ...(typeof e?.detail === "string" && e.detail.trim()
          ? { hint: e.detail.trim() }
          : {}),
      });
      return;
    } finally {
      client.release();
    }

    if (addressChangedOnUpsert) {
      void syncTookanDestinationForOrder(orderId, ownerId).catch((err) => {
        logger.warn(
          { orderId, workspaceOwnerId: ownerId, err },
          "tookan: failed to sync order destination after idempotent ingest",
        );
      });
    }

    // Reconcile Places and delivery contacts after every successful ingest,
    // including retries. When this payload omitted delivery details, the linker
    // reads the immutable stored snapshot instead of changing it.
    void linkOrderToAddressBook(orderId, ownerId, deliveryAddressJson, {
      deliveryInstructions:
        d.orderNotes ?? d.notes ?? d.orderNote ?? d.note ?? null,
      readStoredAddress: true,
    });

    if (wasInserted && billingContactId) {
      void refreshPhonePlaceholderContactAfterFirstOrder({
        workspaceOwnerId: ownerId,
        contactId: billingContactId,
        orderId,
        buyer: {
          firstName: contactData?.first_name ?? d.billing?.firstName,
          lastName: contactData?.last_name ?? d.billing?.lastName,
          displayName: [contactData?.first_name ?? d.billing?.firstName, contactData?.last_name ?? d.billing?.lastName]
            .filter(Boolean)
            .join(" ") || null,
        },
      });
    }

    // SSE broadcast after successful commit. Best-effort: enrich the payload with
    // the human-friendly fields the dashboard toast needs (display number,
    // customer name, total + currency). Broadcasting must never block or fail the
    // already-committed order, so any error here is swallowed.
    if (wasInserted) {
      try {
      const orderNumber = d.external_order_id ?? orderId;
      const firstName = contactData?.first_name ?? d.billing?.firstName ?? null;
      const lastName = contactData?.last_name ?? d.billing?.lastName ?? null;
      const customerName = [firstName, lastName].filter(Boolean).join(" ") || null;
        // Prefer the paid-currency pair (what the customer actually paid) for
        // the new-order toast; fall back to the USD total for USD/legacy orders.
        const paidTotalRaw = totalsJson?.paid_total;
        const paidTotalNum = paidTotalRaw == null ? null : Number(paidTotalRaw);
        const paidCurrencyStr =
          typeof totalsJson?.paid_currency === "string" && totalsJson.paid_currency.trim() !== ""
            ? totalsJson.paid_currency
            : null;
        const hasPaidPair =
          paidCurrencyStr != null && paidTotalNum != null && Number.isFinite(paidTotalNum);
        const totalRaw = totalsJson?.total;
        const totalNum = totalRaw == null ? null : Number(totalRaw);
        const total = hasPaidPair
          ? paidTotalNum
          : totalNum != null && Number.isFinite(totalNum)
            ? totalNum
            : null;
        const currency = hasPaidPair
          ? paidCurrencyStr
          : typeof totalsJson?.currency === "string"
            ? totalsJson.currency
            : null;
        broadcastEvent(ownerId, {
          event: "order.created",
          workspaceId: ownerId,
          data: {
            id: orderId,
            source: "external",
            displayOrderNumber: orderNumber,
            customerName,
            total,
            currency,
          },
        });
      } catch (err) {
        logger.warn({ err, orderId }, "externalOrders: order.created broadcast failed");
      }
      void notifyNewOrderAlerts(ownerId, orderId);
      // WhatsApp "order received" notification to the (opted-in) customer contact.
      void notifyOrderStatusWhatsApp(orderId, d.external_order_id ?? orderId, "created", ownerId);
      // Recompute automatic contact tags (vip / corporate / one-time /
      // regular) for the billing (customer) contact. Best-effort after
      // commit; never blocks ingestion.
      if (billingContactId) {
        void applyAutoTagsForContact(ownerId, billingContactId);
      }
    }

    // Whish instructions are evaluated after every successful ingest. The
    // payment upsert above updates an existing method when payment data is
    // present, allowing a later payment event to trigger the one-send guard.
    void Promise.resolve()
      .then(() => sendWhishPaymentInstructions(orderId, ownerId))
      .catch((err) => {
        logger.warn({ err, orderId }, "externalOrders: Whish instructions trigger failed");
      });

    // Tookan delivery task — fire-and-forget; never blocks order creation or
    // the HTTP response. Runs only on the first INSERT (wasInserted) and only
    // when Tookan is enabled via TOOKAN_API_KEY / TOOKAN_ENABLED env vars.
    if (wasInserted && !isTookanEnabled()) {
      req.log.debug(
        { orderId },
        "tookan: skipping task creation — integration disabled (TOOKAN_API_KEY not set or TOOKAN_ENABLED=false)",
      );
    }
    // A Whish order that arrives unpaid (payment not verified) must NOT get a
    // Tookan delivery task yet — the customer hasn't actually transferred the
    // money at ingest time. Persist a distinct `awaiting_payment` Tookan state
    // so the dashboard can tell it apart from a failure; the task is created
    // automatically when staff mark the order as paid (see the mark-paid route
    // in routes/orders.ts). Non-Whish orders keep today's create-at-ingest
    // behavior.
    const whishAwaitingPayment =
      isWhishPayment(d.payment?.method, null) && d.payment?.verified !== true;
    if (wasInserted && isTookanEnabled() && whishAwaitingPayment) {
      void db
        .query(
          `UPDATE orders
              SET tookan_status = 'awaiting_payment',
                  updated_at    = now()
            WHERE id = $1`,
          [orderId],
        )
        .then(() => {
          logger.info(
            { orderId },
            "tookan: Whish order awaiting payment — task deferred until marked paid",
          );
        })
        .catch((err) => {
          logger.warn(
            { orderId, err },
            "tookan: failed to persist awaiting_payment status; order is unaffected",
          );
        });
    }
    if (wasInserted && isTookanEnabled() && !whishAwaitingPayment) {
      void (async () => {
        try {
          // Derive delivery window from the resolved (possibly auto-corrected)
          // delivery date and the delivery.slot field. slot strings like
          // "9am - 12pm" or "09:00-13:00" are parsed into start/end times; the
          // date alone is enough for Tookan even if the slot is absent.
          const deliveryWindow = parseDeliveryWindow(effectiveDeliveryDate, receivedDeliverySlot);
          const tookanOrder: OrderForTookan = {
            id: orderId,
            display_order_number: displayNumber ?? null,
            external_order_id: d.external_order_id ?? null,
            delivery_address: deliveryAddressJson as Record<string, unknown> | null,
            window_start: deliveryWindow.window_start,
            window_end: deliveryWindow.window_end,
            delivery_instructions:
              d.orderNotes ?? d.notes ?? d.orderNote ?? d.note ?? null,
            card_message: d.cardMessage ?? null,
          };
          const recipName = d.recipient
            ? [d.recipient.firstName, d.recipient.lastName].filter(Boolean).join(" ") || null
            : null;
          const tookanRecipient: RecipientForTookan = {
            display_name: recipName,
            phone: d.recipient?.phone ?? null,
            email: null,
          };
          const tookanLineItems: LineItemForTookan[] = (d.line_items ?? []).map((i) => ({
            name: i.name,
            quantity: i.quantity,
          }));

          const result = await createTookanDeliveryTask(
            tookanOrder,
            tookanRecipient,
            tookanLineItems,
          );
          await db.query(
            `UPDATE orders
                SET tookan_job_id     = $1,
                    tookan_task_id    = $2,
                    tookan_status     = 'created',
                    tookan_created_at = now(),
                    tookan_payload    = $3::jsonb,
                    updated_at        = now()
              WHERE id = $4`,
            [result.jobId, result.taskId, JSON.stringify(result.debugPayload), orderId],
          );
          logger.info(
            { orderId, jobId: result.jobId },
            "tookan: delivery task created after order ingest",
          );
          void syncApprovedFloristPhotoForOrderToTookan(orderId, ownerId);
        } catch (tookanErr) {
          const message = tookanErr instanceof Error ? tookanErr.message : String(tookanErr);
          const failedPayload = extractTookanFailurePayload(tookanErr);
          await db.query(
            `UPDATE orders
                SET tookan_status = 'failed',
                    tookan_error  = $1,
                    tookan_payload = COALESCE($2::jsonb, tookan_payload),
                    updated_at    = now()
              WHERE id = $3`,
            [message, failedPayload ? JSON.stringify(failedPayload) : null, orderId],
          );
          logger.warn(
            { orderId, err: tookanErr },
            "tookan: delivery task creation failed after order ingest; order is unaffected",
          );
        }
      })();
    }

    // Address Collector: collect an actually missing address even when older
    // checkout clients omitted the toggle. Only on first INSERT; request
    // creation is idempotent and best-effort.
    const shouldCollectAddress = shouldCollectAddressCollection({
      deliveryAddress: [d.delivery, d.delivery_address],
      explicitRequest: d.delivery?.collectAddress,
    });
    if (
      wasInserted
      && shouldCollectAddress
      && (d.delivery?.collectAddress === true || initialOrderStatus === "processing")
    ) {
      const collectionDelivery: Record<string, unknown> =
        d.delivery ??
        (typeof d.delivery_address === "object" && d.delivery_address !== null
          ? d.delivery_address as Record<string, unknown>
          : {});
      const collectionCountryCode =
        typeof collectionDelivery?.countryCode === "string"
          ? collectionDelivery.countryCode
          : typeof collectionDelivery?.country_code === "string"
            ? collectionDelivery.country_code
            : null;
      const recipientName =
        [d.recipient?.firstName, d.recipient?.lastName].filter(Boolean).join(" ").trim() || null;
      void createAddressCollectionRequest({
        workspaceOwnerId: ownerId,
        orderId,
        recipientName,
        recipientPhone: d.recipient?.phone ??
          (typeof collectionDelivery.phone === "string" ? collectionDelivery.phone : null),
        preferredLanguage: d.delivery?.preferredLanguage ??
          (typeof collectionDelivery?.preferredLanguage === "string"
            ? collectionDelivery.preferredLanguage
            : null),
        deliveryDate: effectiveDeliveryDate ??
          (typeof collectionDelivery?.date === "string" ? collectionDelivery.date : null),
        deliverySlot: receivedDeliverySlot ??
          (typeof collectionDelivery?.slot === "string" ? collectionDelivery.slot : null),
        isExpress:
          d.delivery?.isExpress === true
          || collectionDelivery.isExpress === true
          || (
            typeof collectionDelivery.deliveryType === "string"
            && collectionDelivery.deliveryType.trim().toLowerCase() === "express"
          ),
        deliveryCountryCode: collectionCountryCode,
        explicitRequest: d.delivery?.collectAddress,
        source: "external",
      }).catch((err) => {
        logger.warn({ err, orderId }, "addressCollector: request creation failed (external)");
      });
    }

    // Outgoing webhook events after successful commit
    const webhookEvent = wasInserted ? "order.created" : "order.updated";
    void fireWebhookEvent(webhookEvent, ownerId, {
      order_id: orderId,
      external_order_id: d.external_order_id ?? null,
      source: "external",
    });

    // Order emails — only on first INSERT (a new order), best-effort and never
    // blocking the response (mirrors the side effects above). The order detail
    // lookup is shared between the customer confirmation and the staff
    // notification so we only query once.
    if (wasInserted) {
      const orderNumber = d.external_order_id ?? orderId;
      const firstName = contactData?.first_name ?? d.billing?.firstName ?? null;
      const lastName = contactData?.last_name ?? d.billing?.lastName ?? null;
      const customerName = [firstName, lastName].filter(Boolean).join(" ") || null;
      const customerEmail = contactData?.email ?? d.billing?.email ?? null;

      void Promise.all([
        lookupOrderEmailDetails(orderId, ownerId),
        lookupWorkspaceStaffEmails(ownerId),
      ]).then(([details, staffEmails]) => {
        // Customer-facing email — skipped gracefully when no customer email is
        // on file. An order that arrives awaiting payment (payment not verified)
        // gets the Whish payment-instructions email automatically; an already-
        // paid order gets the standard confirmation.
        if (d.payment?.verified === true) {
          void trackOrderEmail(
            {
              workspaceOwnerId: ownerId,
              orderId,
              templateType: "order_confirmation",
              recipientName: customerName,
              recipientEmail: customerEmail,
            },
            () =>
              sendOrderConfirmationEmail({
                toEmail: customerEmail!,
                orderNumber,
                customerName,
                items: details.items,
                amountPaidText: details.amountPaidText,
                deliveryDateText: details.deliveryDateText,
                subtotalText: details.subtotalText,
                deliveryFeeText: details.deliveryFeeText,
                discountText: details.discountText,
                paymentMethodText: details.paymentMethodText,
                cardMessage: details.cardMessage,
              }),
          );
        } else {
          void trackOrderEmail(
            {
              workspaceOwnerId: ownerId,
              orderId,
              templateType: "payment_instructions",
              recipientName: customerName,
              recipientEmail: customerEmail,
            },
            () =>
              sendOrderPaymentInstructionsEmail({
                toEmail: customerEmail!,
                orderNumber,
                customerName,
                amountDueText: details.amountPaidText,
                items: details.items,
                deliveryDateText: details.deliveryDateText,
              }),
          );
        }
        // Staff/owner notification — skipped gracefully when no owner/admin
        // email is on file.
        void sendNewOrderStaffEmail({
          toEmails: staffEmails,
          orderNumber,
          customerName: details.customerName ?? customerName,
          customerEmail: details.customerEmail,
          customerPhone: details.customerPhone,
          recipientName: details.recipientName,
          recipientPhone: details.recipientPhone,
          deliveryAddress: details.deliveryAddress,
          deliveryDistrict: details.deliveryDistrict,
          deliveryCity: details.deliveryCity,
          deliveryCountry: details.deliveryCountry,
          deliveryInstructions: details.deliveryInstructions,
          deliveryTimeSlot: details.deliveryTimeSlot,
          items: details.items,
          amountPaidText: details.amountPaidText,
          deliveryDateText: details.deliveryDateText,
          subtotalText: details.subtotalText,
          deliveryFeeText: details.deliveryFeeText,
          discountText: details.discountText,
          cardMessage: details.cardMessage,
          cardFrom: details.cardFrom,
          cardTo: details.cardTo,
        });
      });
    }

    // Slack new-order notification for UAE orders — only on first INSERT,
    // best-effort and never blocking the response. Routed by delivery city
    // (Abu Dhabi vs Dubai); non-UAE orders are skipped inside the helper.
    if (wasInserted) {
      void notifyNewUaeOrderToSlack({ orderId, workspaceOwnerId: ownerId });
    }

    res.status(wasInserted ? 201 : 200).json({ success: true, order_id: orderId });
  },
);

export default router;
