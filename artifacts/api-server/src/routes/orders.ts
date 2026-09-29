import { Router, type Request, type Response } from "express";
import { z } from "zod";
import Stripe from "stripe";
import { clerkClient } from "@clerk/express";
import {
  RestoreRefundedOrderParams,
  RestoreRefundedOrderResponse,
} from "@workspace/api-zod";
import { db, withTransaction } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace, hasPageAccess } from "../lib/workspace";
import { hasCmcPosNewOrderAccess } from "../lib/cmcAccess";
import { logger } from "../lib/logger";
import { fireWebhookEvent } from "../lib/catalogWebhook";
import { PUBLIC_OBJECT_HOST, buildPublicObjectUrl } from "../lib/objectStorage";
import { buildGiftCardPdf } from "../lib/giftCardPdf";
import {
  buildOrderInvoicePdf,
  resolveInvoiceSenderLines,
  isWhishPayment,
  includedVatAmount,
  WHISH_VAT_RATE,
  type InvoiceLineItem,
} from "../lib/orderInvoicePdf";
import { normalizePhone, syncContactToRespondIo } from "../lib/contactUpsert";
import { queueGenderInference } from "../lib/genderInference";
import {
  stripeMajorToMinor,
  currencyDecimals,
  applyRounding,
  computeLineTotal,
} from "../lib/stripeAmountVerification";
import {
  createManualOrder,
  ContactNotFoundError,
  ManualOrderPricingError,
} from "../lib/orderCreate";
import { CmcOrderDiscountError } from "../lib/cmcOrderDiscount";
import { PaymentLinkOrderError } from "../lib/paymentLinkOrder";
import { getOrderPaymentSummary } from "../lib/paymentLinkOrder";
import {
  createAutomaticAddressCollectionRequest,
  createAddressCollectionRequest,
  recalcScheduleForOrder,
  finalizeAddressCollectionForOrder,
  hasUsableDeliveryAddress,
} from "../lib/addressCollector/service";
import {
  sendOrderStatusEmail,
  sendOrderRefundEmail,
  sendOrderPaymentInstructionsEmail,
  sendOrderPaymentReceivedEmail,
  sendOrderRescheduledEmail,
  ORDER_STATUS_EMAIL_STATUSES,
  type OrderEmailItem,
} from "../lib/email";
import {
  isTookanEnabled,
  retryTookanDeliveryTask,
  backfillTookanDeliveryTasks,
  editTookanDeliveryTask,
  syncTookanDestinationWithClient,
  syncTookanDestinationForOrder,
  tookanDestinationsEqual,
  assignTookanAgent,
  TOOKAN_MISSING_ADDRESS_ERROR,
} from "../lib/tookan";
import {
  maybeEnqueueTrustpilotInvitation,
  processTrustpilotInvitation,
  SENSITIVE_SUPPRESSION_MESSAGE,
} from "../lib/trustpilotInvitations";
import { isTrustpilotEnabled, isTrustpilotTestMode } from "../lib/trustpilot";
import {
  notifyOrderStatusWhatsApp,
  sendWhishPaymentInstructions,
} from "../lib/orderWhatsappNotify";
import { enqueueDeliveredWhatsappNotification } from "../lib/deliveredWhatsappJob";
import { isUaeStripeCountry } from "./paymentLinks";
import { isUaeCountryCode } from "../lib/slack";
import { trackOrderEmail } from "../lib/orderComms";
import { transitionOrderStatus } from "../lib/orderStatusTransition";
import { findCountryByCode, findCountryByName } from "../lib/defaults";
import { linkOrderToAddressBook } from "../lib/addressBookAutoLink";
import { getRespondIoContactUrl } from "../lib/respondio";
import { withOrderDestinationLock } from "../lib/orderDestinationLock";

/**
 * Convert a stored product image reference into an absolute, browser-fetchable
 * URL. Mirrors the externalProducts resolution: an `image_public_path` is
 * preferred (auth-free public copy), falling back to the private
 * `main_image_url` served through the storage object route. Values already
 * absolute (http/https) pass through unchanged.
 */
function resolveProductImageUrl(
  mainImageUrl: string | null,
  imagePublicPath: string | null,
): string | null {
  const fromPublic = buildPublicObjectUrl(imagePublicPath);
  if (fromPublic) return fromPublic;

  const stored = (mainImageUrl ?? "").trim();
  if (!stored) return null;
  if (/^https?:\/\//i.test(stored)) return stored;

  const base = process.env.PUBLIC_BASE_URL?.replace(/\/+$/, "") || PUBLIC_OBJECT_HOST;
  if (stored.startsWith("/objects/")) return `${base}/api/storage${stored}`;
  if (stored.startsWith("/")) return `${base}${stored}`;
  return `${base}/${stored}`;
}

const router = Router();

router.use(requireAuth);
router.use(resolveWorkspace);
router.use("/orders", (req, res, next) => {
  if (req.method !== "GET" || hasPageAccess(workspace(req), "orders")) {
    next();
    return;
  }
  res.status(403).json({ success: false, error: "You do not have access to orders" });
});

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve an order-detail route param into the order's UUID. Accepts either a
 * raw UUID (returned as-is), a display order number, or an external order id
 * (e.g. `LB-2368`), matched case-insensitively within the workspace.
 *
 * Both fields must be checked: the orders list shows whichever one is set
 * (`display_order_number || external_order_id`, see the "#..." badge on each
 * row and the list's own search, which already matches both columns), but
 * externally-ingested orders are never assigned a `display_order_number` —
 * only manual dashboard orders get the "M-..." sequence. Matching on
 * `display_order_number` alone means the exact reference number staff see
 * and use for an ingested order 404s here even though it resolves fine in
 * the list search, which is misleadingly indistinguishable from the order
 * actually not existing.
 *
 * Order numbers are not guaranteed unique, so ties resolve to the most
 * recently created order for determinism. Returns null when no matching
 * order exists.
 */
async function resolveOrderIdParam(
  param: string,
  workspaceOwnerId: string,
): Promise<string | null> {
  if (UUID_RE.test(param)) return param;
  const result = await db.query<{ id: string }>(
    `SELECT id
       FROM orders
      WHERE workspace_owner_id = $1
        AND (LOWER(display_order_number) = LOWER($2) OR LOWER(external_order_id) = LOWER($2))
      ORDER BY created_at DESC
      LIMIT 1`,
    [workspaceOwnerId, param],
  );
  return result.rows[0]?.id ?? null;
}

/**
 * Canonical order status set — must stay in lockstep with the frontend
 * `lib/orderStatus.ts` list (status filter, badges, edit form). Every status
 * selectable in the dashboard is accepted here so picking one always succeeds.
 */
const ORDER_STATUSES = [
  "pending",
  "processing",
  "preparing",
  "ready_for_delivery",
  "out_for_delivery",
  "completed",
  "cancelled",
  "on_hold",
  "refunded",
] as const;

/**
 * Linear fulfilment flow used to classify a status change as forward,
 * skip, or backward. Mirrors STEPPER_FLOW in
 * print-agent-web/src/components/OrderStatusStepper.tsx (also reused by the
 * Orders board's drag-and-drop) — keep the two in sync. cancelled/on_hold/
 * refunded sit outside this flow: any transition to/from them is
 * unrestricted here, matching the client's classifyTransition.
 */
const ORDER_STATUS_FLOW = [
  "pending",
  "processing",
  "preparing",
  "ready_for_delivery",
  "out_for_delivery",
  "completed",
] as const;

type OrderTransitionKind = "none" | "forward" | "forward-skip" | "backward";

function classifyOrderStatusTransition(fromStatus: string, toStatus: string): OrderTransitionKind {
  const flow = ORDER_STATUS_FLOW as readonly string[];
  const fromIdx = flow.indexOf(fromStatus);
  const toIdx = flow.indexOf(toStatus);
  if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return "none";
  if (toIdx < fromIdx) return "backward";
  if (toIdx - fromIdx > 1) return "forward-skip";
  return "forward";
}

/**
 * Gate for order write endpoints. Workspace owners and members whose role
 * grants access to the Orders page may edit; everyone else gets a 403.
 */
export function requireOrderAccess(
  wreq: ReturnType<typeof workspace>,
  res: Response,
): boolean {
  if (hasPageAccess(wreq, "orders")) return true;
  res
    .status(403)
    .json({ success: false, error: "You do not have access to edit orders" });
  return false;
}

/**
 * Elevated order-management actions are limited to owners, admins, and members
 * assigned the exact Ops 2 role in this workspace.
 */
async function hasOwnerAdminOrOps2Access(
  wreq: ReturnType<typeof workspace>,
): Promise<boolean> {
  if (wreq.workspaceRole === "owner" || wreq.workspaceActualRole === "admin") {
    return true;
  }
  if (wreq.memberDbId == null || !wreq.userId) return false;

  const roleResult = await db.query(
    `SELECT 1
       FROM workspace_member_roles wmr
       JOIN workspace_roles wr ON wr.id = wmr.role_id
       JOIN workspace_members wm ON wm.id = wmr.member_id
      WHERE wm.id = $1
        AND wm.workspace_owner_id = $2
        AND wm.member_user_id = $3
        AND wm.joined_at IS NOT NULL
        AND wm.revoked_at IS NULL
        AND (wm.access_expires_at IS NULL OR wm.access_expires_at > NOW())
        AND wr.workspace_owner_id = $2
        AND wr.name = 'Ops 2'
      LIMIT 1`,
    [wreq.memberDbId, wreq.workspaceOwnerId, wreq.userId],
  );
  return (roleResult.rowCount ?? roleResult.rows.length) > 0;
}


/**
 * Best-effort append-only activity record for an order. Never throws — a
 * failed insert only logs a warning so the calling mutation is never blocked.
 * The actor name is resolved from Clerk lazily (also best-effort).
 */
export function recordOrderEvent(opts: {
  workspaceOwnerId: string;
  orderId: string;
  eventType: string;
  payload?: Record<string, unknown> | null;
  actorUserId?: string | null;
}): void {
  void (async () => {
    try {
      const actorName = opts.actorUserId
        ? await resolveEditorName(opts.actorUserId)
        : null;
      await db.query(
        `INSERT INTO order_events
           (workspace_owner_id, order_id, event_type, payload, actor_user_id, actor_name)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
        [
          opts.workspaceOwnerId,
          opts.orderId,
          opts.eventType,
          opts.payload ? JSON.stringify(opts.payload) : null,
          opts.actorUserId ?? null,
          actorName,
        ],
      );
    } catch (err) {
      logger.warn(
        { err, orderId: opts.orderId, eventType: opts.eventType },
        "Failed to record order event",
      );
    }
  })();
}

/**
 * True when `tz` is a valid IANA time-zone identifier accepted by the JS Intl
 * APIs (and therefore safe to pass to Postgres `AT TIME ZONE`). Used to reject
 * bogus client-supplied zones before they reach SQL — an invalid zone would
 * raise a runtime SQL error. Callers fall back to UTC when this returns false.
 */
function isValidTimeZone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the order's customer (sender) contact email + display name for the
 * status-change emails. Returns nulls when there is no customer contact on
 * file. Best-effort: a failed lookup never blocks the order mutation.
 */
export async function lookupOrderCustomerContact(
  orderId: string,
): Promise<{ email: string | null; name: string | null }> {
  try {
    // Prefer the customer role contact with a usable email. If the customer
    // has no email (e.g. a CMC delivery order where only a recipient email
    // was entered), fall back to the recipient contact so status-change emails
    // can still be delivered. Priority: customer-with-email > recipient-with-email
    // > customer-without-email > recipient-without-email.
    const r = await db.query<{ contact_email: string | null; contact_name: string | null }>(
      `SELECT c.email AS contact_email, c.display_name AS contact_name
         FROM order_contacts oc
         JOIN contacts c ON c.id = oc.contact_id
        WHERE oc.order_id = $1
          AND oc.role IN ('customer', 'recipient')
        ORDER BY
          CASE
            WHEN oc.role = 'customer' AND c.email IS NOT NULL THEN 1
            WHEN oc.role = 'recipient' AND c.email IS NOT NULL THEN 2
            WHEN oc.role = 'customer' THEN 3
            ELSE 4
          END
        LIMIT 1`,
      [orderId],
    );
    const row = r.rows[0];
    return { email: row?.contact_email ?? null, name: row?.contact_name ?? null };
  } catch {
    return { email: null, name: null };
  }
}

/**
 * Format a numeric amount with the proper currency symbol for the customer
 * emails, e.g. `120.5` + `USD` → `$120.50`, `680` + `QAR` → `QAR 680.00`
 * (Intl's en-US narrow symbol — same approach as the invoice PDF). Falls back
 * to `CODE 120.50` when Intl does not recognize the currency code.
 */
export function formatOrderAmount(amount: number, currency: string): string {
  const code = (currency || "USD").toUpperCase();
  if (!Number.isFinite(amount)) return code;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: code,
      currencyDisplay: "narrowSymbol",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
      .format(amount)
      // Intl separates code-style symbols with non-breaking/narrow spaces;
      // normalize to plain spaces for consistent email/text rendering.
      .replace(/[\u00A0\u202F]/g, " ");
  } catch {
    return `${code} ${amount.toFixed(2)}`;
  }
}

/**
 * Human-friendly label for the order's payment method for the customer emails,
 * e.g. `cash_on_delivery` → `Cash on Delivery`, `stripe` → `Stripe`. Returns
 * null when no method is stored.
 */
const PAYMENT_METHOD_LABELS: Record<string, string> = {
  apple_pay: "Apple Pay",
  google_pay: "Google Pay",
  card: "Card",
  credit_card: "Card",
  cash: "Cash",
  cash_on_delivery: "Cash on Delivery",
  cod: "Cash on Delivery",
  bank_transfer: "Bank Transfer",
  wire_transfer: "Bank Transfer",
  stripe: "Stripe",
  paypal: "PayPal",
  whish: "Whish",
  payment_link: "Payment Link",
  already_paid: "Already Paid",
  cybersource: "Cybersource",
};

function formatPaymentMethod(method: string | null | undefined): string | null {
  if (typeof method !== "string") return null;
  const trimmed = method.trim();
  if (trimmed === "") return null;
  const key = trimmed.toLowerCase().replace(/[\s-]+/g, "_");
  const known = PAYMENT_METHOD_LABELS[key];
  if (known) return known;
  // Unknown identifiers: underscores/dashes → spaces, Title Case per word.
  return trimmed
    .replace(/[_-]+/g, " ")
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

/**
 * Format the order's delivery timestamp into a friendly calendar date for the
 * customer emails, e.g. `23 June 2026`. Returns null on bad input.
 */
function formatDeliveryDate(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Gather the customer-facing order details (line items with resolved image
 * thumbnails, the amount paid, and the delivery date) for the order emails.
 * Best-effort: any failure yields empty details so the email still sends and the
 * order mutation is never blocked.
 */
export async function lookupOrderEmailDetails(
  orderId: string,
  workspaceOwnerId: string,
): Promise<{
  items: OrderEmailItem[];
  amountPaidText: string | null;
  deliveryDateText: string | null;
  subtotalText: string | null;
  deliveryFeeText: string | null;
  discountText: string | null;
  paymentMethodText: string | null;
  cardMessage: string | null;
  cardFrom: string | null;
  cardTo: string | null;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  recipientName: string | null;
  recipientPhone: string | null;
  deliveryAddress: string | null;
  deliveryDistrict: string | null;
  deliveryCity: string | null;
  deliveryCountry: string | null;
  deliveryInstructions: string | null;
  deliveryTimeSlot: string | null;
}> {
  const empty = {
    items: [] as OrderEmailItem[],
    amountPaidText: null,
    deliveryDateText: null,
    subtotalText: null,
    deliveryFeeText: null,
    discountText: null,
    paymentMethodText: null,
    cardMessage: null,
    cardFrom: null,
    cardTo: null,
    customerName: null,
    customerEmail: null,
    customerPhone: null,
    recipientName: null,
    recipientPhone: null,
    deliveryAddress: null,
    deliveryDistrict: null,
    deliveryCity: null,
    deliveryCountry: null,
    deliveryInstructions: null,
    deliveryTimeSlot: null,
  };
  try {
    const orderRes = await db.query<{
      totals: {
        total?: number | null;
        currency?: string | null;
        subtotal?: number | string | null;
        shipping?: number | string | null;
        discount?: number | string | null;
        paid_total?: number | string | null;
        paid_currency?: string | null;
        paid_subtotal?: number | string | null;
        paid_shipping?: number | string | null;
      } | null;
      window_start: string | null;
      requested_delivery_date: string | null;
      delivery_address: string | null;
      delivery_district: string | null;
      delivery_city: string | null;
      delivery_country: string | null;
      delivery_instructions: string | null;
      delivery_time_slot: string | null;
      card_message: string | null;
      card_from: string | null;
      card_to: string | null;
      payment_method: string | null;
      payment_currency: string | null;
      payment_amount: string | null;
      coupon_discount_usd: string | null;
      coupon_code: string | null;
      customer_name: string | null;
      customer_email: string | null;
      customer_phone: string | null;
      recipient_name: string | null;
      recipient_phone: string | null;
    }>(
      // Discount resolution: prefer orders.totals.discount (read from the
      // totals jsonb below); the coupon-redemption ledger amount and coupon
      // code are fetched in the same query as fallback/context so no extra
      // round-trip is added. The raw_payload couponCode covers legacy orders
      // ingested before the redemption ledger existed.
      // payment_currency / payment_amount: used as fallback when totals.paid_currency
      // is absent (e.g. Stripe-verified orders where the paid pair lands in
      // order_payment but was never written back to the totals JSONB).
      `SELECT o.totals, o.window_start,
              o.delivery_address->>'date' AS requested_delivery_date,
              o.delivery_address->>'address' AS delivery_address,
              o.delivery_address->>'district' AS delivery_district,
              COALESCE(NULLIF(btrim(o.delivery_address->>'city'), ''), NULLIF(btrim(city.name), ''), NULLIF(btrim(o.delivery_address->>'cityId'), '')) AS delivery_city,
              COALESCE(NULLIF(btrim(o.delivery_address->>'country'), ''), NULLIF(btrim(city.country_code), ''), NULLIF(btrim(o.delivery_address->>'countryCode'), '')) AS delivery_country,
              o.delivery_instructions,
              o.delivery_address->>'slot' AS delivery_time_slot,
              o.card_message, o.card_from, o.card_to,
              COALESCE(NULLIF(btrim(customer.display_name), ''), NULLIF(btrim(concat_ws(' ', customer.first_name, customer.last_name)), '')) AS customer_name,
              customer.email AS customer_email, customer.phone AS customer_phone,
              COALESCE(NULLIF(btrim(recipient.display_name), ''), NULLIF(btrim(concat_ws(' ', recipient.first_name, recipient.last_name)), '')) AS recipient_name,
              recipient.phone AS recipient_phone,
              op.method AS payment_method,
              op.currency AS payment_currency, op.amount AS payment_amount,
              cr.discount_amount_usd AS coupon_discount_usd,
              COALESCE(cp.code, o.raw_payload->>'couponCode', o.raw_payload->>'coupon_code') AS coupon_code
         FROM orders o
          LEFT JOIN LATERAL (
            SELECT c.display_name, c.first_name, c.last_name, c.email, c.phone
              FROM order_contacts oc
              JOIN contacts c ON c.id = oc.contact_id
             WHERE oc.order_id = o.id
               AND oc.role = 'customer'
               AND c.workspace_owner_id = o.workspace_owner_id
             ORDER BY oc.created_at
             LIMIT 1
          ) customer ON true
          LEFT JOIN LATERAL (
            SELECT c.display_name, c.first_name, c.last_name, c.phone
              FROM order_contacts oc
              JOIN contacts c ON c.id = oc.contact_id
             WHERE oc.order_id = o.id
               AND oc.role = 'recipient'
               AND c.workspace_owner_id = o.workspace_owner_id
             ORDER BY oc.created_at
             LIMIT 1
          ) recipient ON true
          LEFT JOIN LATERAL (
            SELECT dc.name, dc.country_code
              FROM delivery_cities dc
             WHERE dc.workspace_owner_id = o.workspace_owner_id
               AND (
                 dc.id::text = o.delivery_address->>'cityId'
                 OR lower(dc.slug) = lower(o.delivery_address->>'cityId')
               )
             LIMIT 1
          ) city ON true
         LEFT JOIN order_payment op ON op.order_id = o.id
         LEFT JOIN LATERAL (
           SELECT r.coupon_id, r.discount_amount_usd
             FROM coupon_redemptions r
            WHERE r.order_id = o.id
              AND r.workspace_owner_id = o.workspace_owner_id
              AND r.status = 'confirmed'
            ORDER BY r.created_at
            LIMIT 1
         ) cr ON true
         LEFT JOIN coupons cp ON cp.id = cr.coupon_id
        WHERE o.id = $1 AND o.workspace_owner_id = $2 LIMIT 1`,
      [orderId, workspaceOwnerId],
    );
    const order = orderRes.rows[0];
    const totals = order?.totals ?? null;
    const totalNum = totals?.total != null ? Number(totals.total) : null;
    // Prefer the amount the customer actually paid (paid-currency pair stored
    // at ingest, e.g. CHF 70.00) over the USD figure; USD/legacy orders fall
    // back to the stored USD total exactly as before.
    const paidNum = totals?.paid_total != null ? Number(totals.paid_total) : null;
    // Primary source: totals JSONB paid_currency (written at ingest).
    // Fallback: order_payment.currency — the authoritative Stripe/gateway
    // currency for orders where paid_currency was not written back to totals
    // (e.g. early Stripe-verified ingest paths). This prevents the email from
    // showing "USD" when the customer actually paid in GBP / AED / etc.
    const paidCurrency =
      typeof totals?.paid_currency === "string" && totals.paid_currency.trim() !== ""
        ? totals.paid_currency
        : typeof order?.payment_currency === "string" &&
          order.payment_currency.trim() !== "" &&
          order.payment_currency.trim().toUpperCase() !== "USD"
          ? order.payment_currency.trim()
          : null;
    // When we fell back to order_payment.currency, also use order_payment.amount
    // as paidNum so the total text is consistent with the payment record.
    const paidNumEffective: number | null = (() => {
      if (totals?.paid_total != null) return paidNum; // totals-sourced
      if (
        paidCurrency !== null &&
        typeof order?.payment_amount === "string" &&
        order.payment_amount.trim() !== ""
      ) {
        const v = Number(order.payment_amount);
        return Number.isFinite(v) ? v : null;
      }
      return paidNum;
    })();
    // Prefer the ACTUAL charged paid-currency amounts stored at ingest
    // (totals.paid_subtotal / paid_shipping) — the exact numbers the website
    // showed the customer. Legacy orders without them fall back to the
    // rounded implied-rate conversion above.
    const paidSubtotalNum =
      totals?.paid_subtotal != null ? Number(totals.paid_subtotal) : null;
    const paidShippingNum =
      totals?.paid_shipping != null ? Number(totals.paid_shipping) : null;
    // Use component sum as the effective total when components are available.
    // paid_total can be a deposit/partial amount; paid_subtotal + paid_shipping
    // is always the real order value in the paid currency.
    const effectivePaidNum = (() => {
      const hasSub = paidSubtotalNum != null && Number.isFinite(paidSubtotalNum);
      const hasShip = paidShippingNum != null && Number.isFinite(paidShippingNum);
      if (hasSub || hasShip) {
        return (hasSub ? paidSubtotalNum! : 0) + (hasShip ? paidShippingNum! : 0);
      }
      return paidNumEffective;
    })();
    // NOTE: there is intentionally NO "mislabeled currency" plausibility guard
    // here. The dashboard renders the stored paid_total/paid_currency verbatim,
    // and the emails must always agree with it. A previous ±2% implied-rate
    // heuristic silently discarded genuine paid amounts (e.g. AED 170 on a
    // USD ~168 order), making emails show USD while the dashboard showed AED.
    // Stored totals figures (total/subtotal/shipping/line totals) are USD by
    // construction. When no usable paid amount exists, they must be labeled
    // USD — a payload can carry a foreign payment currency (or even a foreign
    // totals.currency) without any paid amounts, and relabeling the USD
    // numbers with that currency was the mislabeling bug.
    const usdFallbackCurrency =
      typeof totals?.currency === "string" &&
      totals.currency.trim() !== "" &&
      totals.currency.trim().toUpperCase() === "USD"
        ? totals.currency
        : "USD";
    const amountPaidText =
      effectivePaidNum != null && Number.isFinite(effectivePaidNum) && paidCurrency
        ? formatOrderAmount(effectivePaidNum, paidCurrency)
        : totalNum != null && Number.isFinite(totalNum)
          ? formatOrderAmount(totalNum, usdFallbackCurrency)
          : null;
    // For non-USD orders, line-item amounts (stored in USD) are shown in the
    // paid currency using the order's implied rate (effective_paid ÷ USD total),
    // mirroring the order detail page. USD/legacy orders keep plain USD amounts.
    const paidConversion =
      paidCurrency &&
      paidCurrency.toUpperCase() !== "USD" &&
      effectivePaidNum != null &&
      Number.isFinite(effectivePaidNum) &&
      effectivePaidNum > 0 &&
      totalNum != null &&
      Number.isFinite(totalNum) &&
      totalNum > 0
        ? { currency: paidCurrency.toUpperCase(), rate: effectivePaidNum / totalNum }
        : null;
    const textValue = (value: string | null | undefined): string | null =>
      typeof value === "string" && value.trim() !== "" ? value.trim() : null;
    const deliveryDateText = formatDeliveryDate(
      textValue(order?.requested_delivery_date) ?? order?.window_start ?? null,
    );

    // Subtotal and delivery fee are stored in USD inside the totals jsonb;
    // convert them to the paid currency with the same implied rate so every
    // amount in the email is stated in the currency the customer paid.
    const displayCurrency = paidConversion
      ? paidConversion.currency
      : usdFallbackCurrency;
    // For non-USD orders, convert the USD amount with the implied rate AND
    // round to the nearest multiple of 5, matching the storefront's 0/5/10
    // display rounding (same fallback as line items). USD orders stay exact.
    const toDisplayAmount = (value: number): number =>
      paidConversion ? Math.round((value * paidConversion.rate) / 5) * 5 : value;
    const subtotalNum = totals?.subtotal != null ? Number(totals.subtotal) : null;
    const shippingNum = totals?.shipping != null ? Number(totals.shipping) : null;
    const subtotalText = paidConversion &&
      paidSubtotalNum != null &&
      Number.isFinite(paidSubtotalNum)
        ? formatOrderAmount(paidSubtotalNum, paidConversion.currency)
        : subtotalNum != null && Number.isFinite(subtotalNum)
          ? formatOrderAmount(toDisplayAmount(subtotalNum), displayCurrency)
          : null;
    const deliveryFeeText = paidConversion &&
      paidShippingNum != null &&
      Number.isFinite(paidShippingNum)
        ? paidShippingNum === 0
          ? "Free"
          : formatOrderAmount(paidShippingNum, paidConversion.currency)
        : shippingNum != null && Number.isFinite(shippingNum)
          ? shippingNum === 0
            ? "Free"
            : formatOrderAmount(toDisplayAmount(shippingNum), displayCurrency)
          : null;
    // Discount: prefer the USD discount stored in the totals jsonb; fall back
    // to the confirmed coupon-redemption ledger amount. Rendered as a negative
    // amount (with the coupon code when known) so Subtotal + Delivery fee −
    // Discount = Total visibly adds up. Zero/absent discounts render nothing.
    const totalsDiscountNum =
      totals?.discount != null ? Number(totals.discount) : null;
    const couponDiscountNum =
      order?.coupon_discount_usd != null && order.coupon_discount_usd !== ""
        ? Number(order.coupon_discount_usd)
        : null;
    const discountNum =
      totalsDiscountNum != null && Number.isFinite(totalsDiscountNum) && totalsDiscountNum > 0
        ? totalsDiscountNum
        : couponDiscountNum != null && Number.isFinite(couponDiscountNum) && couponDiscountNum > 0
          ? couponDiscountNum
          : null;
    const couponCode =
      typeof order?.coupon_code === "string" && order.coupon_code.trim() !== ""
        ? order.coupon_code.trim()
        : null;
    const discountText =
      discountNum != null
        ? `-${formatOrderAmount(toDisplayAmount(discountNum), displayCurrency)}${couponCode ? ` (${couponCode})` : ""}`
        : null;
    const paymentMethodText = formatPaymentMethod(order?.payment_method ?? null);
    const cardMessage =
      textValue(order?.card_message);
    const cardFrom = textValue(order?.card_from);
    const cardTo = textValue(order?.card_to);

    const liRes = await db.query<{
      name: string;
      quantity: string | null;
      line_total: string | null;
      unit_price: string | null;
      paid_line_total: string | null;
      image_url: string | null;
      product_id: number | null;
      sku: string | null;
    }>(
      `SELECT name, quantity, line_total, unit_price, paid_line_total, image_url, product_id, sku
         FROM order_line_items WHERE order_id = $1 ORDER BY id`,
      [orderId],
    );

    // Line-item amounts are stored in USD; without a paid conversion they are
    // labeled USD (never a foreign totals.currency — see usdFallbackCurrency).
    const currency = usdFallbackCurrency;

    const productIds = Array.from(
      new Set(
        liRes.rows
          .map((it) => it.product_id)
          .filter((v): v is number => typeof v === "number" && Number.isFinite(v)),
      ),
    );
    const skus = Array.from(
      new Set(
        liRes.rows
          .map((it) => (it.sku ?? "").trim())
          .filter((s) => s.length > 0),
      ),
    );

    const byId = new Map<number, string | null>();
    const bySku = new Map<string, string | null>();
    if (productIds.length > 0 || skus.length > 0) {
      const productImages = await db.query<{
        id: number;
        sku: string | null;
        main_image_url: string | null;
        image_public_path: string | null;
      }>(
        `SELECT id, sku, main_image_url, image_public_path
           FROM products
          WHERE workspace_owner_id = $1
            AND (id = ANY($2::int[]) OR sku = ANY($3::text[]))`,
        [workspaceOwnerId, productIds, skus],
      );
      for (const row of productImages.rows) {
        const url = resolveProductImageUrl(row.main_image_url, row.image_public_path);
        byId.set(row.id, url);
        if (row.sku) bySku.set(row.sku, url);
      }
    }

    const items: OrderEmailItem[] = liRes.rows.map((it) => {
      // Prefer the public bucket URL from the products table (always email-safe).
      // Fall back to resolving the stored image_url (handles https:// links and
      // the /objects/ private-path fallback for products not yet synced).
      let imageUrl: string | null | undefined =
        (it.product_id != null ? byId.get(it.product_id) : undefined) ??
        (it.sku ? bySku.get(it.sku.trim()) : undefined) ??
        (it.image_url ? resolveProductImageUrl(it.image_url, null) : null);

      const lineTotalNum =
        it.line_total != null && it.line_total !== "" ? Number(it.line_total) : null;
      const qtyNum = it.quantity != null && it.quantity !== "" ? Number(it.quantity) : null;
      // For non-USD paid orders, prefer the ACTUAL charged paid-currency line
      // amount stored at ingest (the storefront rounds displayed prices to the
      // nearest 0/5/10 and charges the rounded amount). Legacy orders without
      // it fall back to the implied-rate conversion rounded to the nearest
      // multiple of 5 so the email matches what the storefront displayed.
      // USD-paid orders keep exact USD values (no rounding).
      const paidLineTotalNum =
        it.paid_line_total != null && it.paid_line_total !== ""
          ? Number(it.paid_line_total)
          : null;
      const priceText = paidConversion
        ? paidLineTotalNum != null && Number.isFinite(paidLineTotalNum)
          ? formatOrderAmount(paidLineTotalNum, paidConversion.currency)
          : lineTotalNum != null && Number.isFinite(lineTotalNum)
            ? formatOrderAmount(
                Math.round((lineTotalNum * paidConversion.rate) / 5) * 5,
                paidConversion.currency,
              )
            : null
        : lineTotalNum != null && Number.isFinite(lineTotalNum)
          ? formatOrderAmount(lineTotalNum, currency)
          : null;

      return {
        name: it.name,
        imageUrl: imageUrl ?? null,
        quantity: qtyNum != null && Number.isFinite(qtyNum) ? qtyNum : it.quantity,
        priceText,
      };
    });

    return {
      items,
      amountPaidText,
      deliveryDateText,
      subtotalText,
      deliveryFeeText,
      discountText,
      paymentMethodText,
      cardMessage,
      cardFrom,
      cardTo,
      customerName: textValue(order?.customer_name),
      customerEmail: textValue(order?.customer_email),
      customerPhone: textValue(order?.customer_phone),
      recipientName: textValue(order?.recipient_name),
      recipientPhone: textValue(order?.recipient_phone),
      deliveryAddress: textValue(order?.delivery_address),
      deliveryDistrict: textValue(order?.delivery_district),
      deliveryCity: textValue(order?.delivery_city),
      deliveryCountry: textValue(order?.delivery_country),
      deliveryInstructions: textValue(order?.delivery_instructions),
      deliveryTimeSlot: textValue(order?.delivery_time_slot),
    };
  } catch {
    return empty;
  }
}

/**
 * Return the distinct owner/admin staff email addresses for a workspace,
 * scoped to the given workspace owner id. Used to notify staff when a new order
 * is received. Best-effort: returns an empty array on any failure so callers
 * never block or fail their response.
 *
 * Schema sentinel: reads workspace_members.member_email, role, and
 * workspace_owner_id. Update here if any of those columns are renamed.
 */
export async function lookupWorkspaceStaffEmails(
  workspaceOwnerId: string,
): Promise<string[]> {
  try {
    const result = await db.query<{ member_email: string }>(
      `SELECT DISTINCT member_email
         FROM workspace_members
        WHERE workspace_owner_id = $1
          AND role IN ('owner', 'admin')
          AND member_email IS NOT NULL
          AND notify_email_on_new_order = true`,
      [workspaceOwnerId],
    );
    return result.rows.map((r) => r.member_email);
  } catch {
    return [];
  }
}

/**
 * Look up the order's customer contact and, when an email is on file, fire a
 * customer-facing status email (best-effort, non-blocking).
 */
export async function notifyOrderStatusEmail(
  orderId: string,
  orderNumber: string,
  status: string,
  workspaceOwnerId: string,
): Promise<void> {
  if (!ORDER_STATUS_EMAIL_STATUSES.has(status)) return;
  const customer = await lookupOrderCustomerContact(orderId);
  await trackOrderEmail(
    {
      workspaceOwnerId,
      orderId,
      templateType: "status_update",
      recipientName: customer.name,
      recipientEmail: customer.email,
    },
    async () => {
      const details = await lookupOrderEmailDetails(orderId, workspaceOwnerId);
      return sendOrderStatusEmail({
        toEmail: customer.email!,
        orderNumber,
        status,
        customerName: customer.name,
        items: details.items,
        amountPaidText: details.amountPaidText,
        deliveryDateText: details.deliveryDateText,
      });
    },
  );
}

/**
 * Resolve one complete retained legacy schedule pair in SQL. A source only
 * wins when both its date and slot are valid, so malformed canonical metadata
 * cannot block a valid pair retained in raw_payload and fields from unrelated
 * payload shapes are never combined.
 */
function retainedDeliveryScheduleSql(alias: string): {
  lateralSql: string;
  dateTextExpr: string;
  slotTextExpr: string;
  dateExpr: string;
  usableExpr: string;
} {
  const pairs = [
    {
      date: `NULLIF(btrim(${alias}.delivery_address->>'date'), '')`,
      slot: `NULLIF(btrim(${alias}.delivery_address->>'slot'), '')`,
    },
    {
      date: `COALESCE(
        NULLIF(btrim(${alias}.raw_payload#>>'{delivery,date}'), ''),
        NULLIF(btrim(${alias}.raw_payload#>>'{delivery,deliveryDate}'), ''),
        NULLIF(btrim(${alias}.raw_payload#>>'{delivery,delivery_date}'), '')
      )`,
      slot: `COALESCE(
        NULLIF(btrim(${alias}.raw_payload#>>'{delivery,slot}'), ''),
        NULLIF(btrim(${alias}.raw_payload#>>'{delivery,deliverySlot}'), ''),
        NULLIF(btrim(${alias}.raw_payload#>>'{delivery,delivery_slot}'), ''),
        NULLIF(btrim(${alias}.raw_payload#>>'{delivery,timeSlot}'), '')
      )`,
    },
    {
      date: `COALESCE(
        NULLIF(btrim(${alias}.raw_payload#>>'{delivery_address,date}'), ''),
        NULLIF(btrim(${alias}.raw_payload#>>'{delivery_address,deliveryDate}'), ''),
        NULLIF(btrim(${alias}.raw_payload#>>'{delivery_address,delivery_date}'), '')
      )`,
      slot: `COALESCE(
        NULLIF(btrim(${alias}.raw_payload#>>'{delivery_address,slot}'), ''),
        NULLIF(btrim(${alias}.raw_payload#>>'{delivery_address,deliverySlot}'), ''),
        NULLIF(btrim(${alias}.raw_payload#>>'{delivery_address,delivery_slot}'), ''),
        NULLIF(btrim(${alias}.raw_payload#>>'{delivery_address,timeSlot}'), '')
      )`,
    },
    {
      date: `COALESCE(
        NULLIF(btrim(${alias}.raw_payload->>'deliveryDate'), ''),
        NULLIF(btrim(${alias}.raw_payload->>'delivery_date'), '')
      )`,
      slot: `COALESCE(
        NULLIF(btrim(${alias}.raw_payload->>'deliverySlot'), ''),
        NULLIF(btrim(${alias}.raw_payload->>'delivery_slot'), ''),
        NULLIF(btrim(${alias}.raw_payload->>'timeSlot'), '')
      )`,
    },
  ];
  const lateralSql = `LEFT JOIN LATERAL (
    SELECT candidate.date_text,
           candidate.slot_text,
           substring(candidate.date_text FROM '^\\d{4}-\\d{2}-\\d{2}')::date AS delivery_date
      FROM (VALUES
        ${pairs.map((pair, index) => `(${index + 1}, ${pair.date}, ${pair.slot})`).join(",\n        ")}
      ) AS candidate(priority, date_text, slot_text)
     WHERE candidate.date_text ~ '^\\d{4}-\\d{2}-\\d{2}'
       AND to_char(
             to_date(substring(candidate.date_text FROM '^\\d{4}-\\d{2}-\\d{2}'), 'YYYY-MM-DD'),
             'YYYY-MM-DD'
           ) = substring(candidate.date_text FROM '^\\d{4}-\\d{2}-\\d{2}')
       AND (
         candidate.slot_text ~* '^(morning|afternoon|evening|night|express)$'
         OR candidate.slot_text ~* '^\\d{1,2}(:[0-5]\\d)?\\s*(am|pm)?\\s*(–|—|-|to)\\s*\\d{1,2}(:[0-5]\\d)?\\s*(am|pm)?$'
       )
     ORDER BY candidate.priority
     LIMIT 1
  ) retained_schedule ON true`;
  return {
    lateralSql,
    dateTextExpr: "retained_schedule.date_text",
    slotTextExpr: "retained_schedule.slot_text",
    dateExpr: "retained_schedule.delivery_date",
    usableExpr: "retained_schedule.delivery_date IS NOT NULL",
  };
}

/**
 * Result of resolving the Stripe secret key for an order's country.
 * Mirrors payment-link creation: UAE orders settle on the separate UAE Stripe
 * account, and a missing key is surfaced (never silently replaced).
 */
type OrderStripeClientResult =
  | { client: Stripe; missingKey: null }
  | { client: null; missingKey: string };

/**
 * Picks the Stripe secret key for a refund based on the order's delivery
 * country, the same way payment-link creation does: UAE orders (delivery
 * countryCode "AE" or country "United Arab Emirates") use
 * STRIPE_SECRET_KEY_UAE, everything else uses STRIPE_SECRET_KEY. If the
 * required key is missing, returns which env var to set — no silent fallback
 * to the other account.
 */
function getStripeClientForOrderCountry(
  countryCode: string | null | undefined,
  country: string | null | undefined,
): OrderStripeClientResult {
  const isUae = isUaeCountryCode(countryCode) || isUaeStripeCountry(country);
  const envKey = isUae ? "STRIPE_SECRET_KEY_UAE" : "STRIPE_SECRET_KEY";
  const key = process.env[envKey];
  if (!key) return { client: null, missingKey: envKey };
  return {
    client: new Stripe(key, { apiVersion: "2026-04-22.dahlia" }),
    missingKey: null,
  };
}

/**
 * PayPal REST API base, mirroring the payment-links / pay routes. Uses the live
 * host only when PAYPAL_ENV is explicitly "live"; otherwise the sandbox.
 */
function getPaypalBase(): string {
  return process.env.PAYPAL_ENV === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";
}

/**
 * Exchange the configured PayPal client credentials for an OAuth2 access token.
 * Returns null when PayPal is not configured (so callers can respond with 503).
 */
async function getPaypalAccessToken(): Promise<string | null> {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const resp = await fetch(`${getPaypalBase()}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!resp.ok) return null;
  const data = (await resp.json()) as { access_token?: string };
  return data.access_token ?? null;
}

/**
 * Zod schema for the dashboard "Create Order" wizard. Mirrors
 * `CreateOrderInput` in the OpenAPI spec. Source defaults to `manual`; payment
 * records the chosen method + status only (this endpoint never charges a card
 * or generates a payment link).
 */
const createOrderContactSchema = z
  .object({
    contact_id: z.string().uuid().nullish(),
    first_name: z.string().trim().max(300).nullish(),
    last_name: z.string().trim().max(300).nullish(),
    display_name: z.string().trim().max(300).nullish(),
    email: z.string().trim().max(300).nullish(),
    phone: z.string().trim().max(100).nullish(),
  })
  .strict();

const createOrderLineItemSchema = z
  .object({
    product_id: z.number().int().positive().nullish(),
    external_id: z.string().trim().max(300).nullish(),
    sku: z.string().trim().max(300).nullish(),
    name: z.string().trim().min(1).max(500),
    quantity: z.number().positive().max(100000),
    unit_price: z.number().min(0).nullish(),
    image_url: z.string().trim().max(2000).nullish(),
    custom_input: z.string().trim().max(500).nullish(),
    is_custom_item: z.boolean().nullish(),
    production_instructions: z.string().trim().max(5000).nullish(),
    custom_item_created_by: z.string().trim().max(300).nullish(),
  })
  .strict()
  .refine(
    (v) => {
      if (v.is_custom_item === true) {
        return (v.unit_price ?? 0) > 0 && (v.production_instructions ?? "").trim().length > 0;
      }
      return true;
    },
    {
      message: "Custom items require a positive price and production instructions",
    },
  );

const createOrderSchema = z
  .object({
    source: z.string().trim().max(100).nullish(),
    status: z.enum(ORDER_STATUSES).nullish(),
    ordered_at: z.string().datetime().nullish(),
    delivery_type: z.string().trim().max(100).nullish(),
    delivery_address: z.record(z.string(), z.unknown()).nullish(),
    delivery_instructions: z.string().trim().max(5000).nullish(),
    window_start: z.string().datetime().nullish(),
    window_end: z.string().datetime().nullish(),
    card_message: z.string().trim().max(5000).nullish(),
    card_from: z.string().trim().max(300).nullish(),
    card_to: z.string().trim().max(300).nullish(),
    totals: z.record(z.string(), z.unknown()).nullish(),
    discount: z
      .object({
        type: z.enum(["percent", "amount"]),
        value: z.number().positive(),
        reason: z.string().trim().min(1).max(100),
        explanation: z.string().trim().max(500).nullish(),
      })
      .strict()
      .nullish(),
    customer: createOrderContactSchema.nullish(),
    recipient: createOrderContactSchema.nullish(),
    line_items: z.array(createOrderLineItemSchema).max(200).optional(),
    payment: z
      .object({
        status: z.string().trim().max(100).nullish(),
        method: z.string().trim().max(100).nullish(),
        currency: z.string().trim().max(10).nullish(),
      })
      .strict()
      .nullish(),
    notes: z
      .object({
        customer_note: z.string().trim().max(5000).nullish(),
        florist_note: z.string().trim().max(5000).nullish(),
        driver_note: z.string().trim().max(5000).nullish(),
        internal_note: z.string().trim().max(5000).nullish(),
      })
      .strict()
      .nullish(),
    payment_link_id: z.number().int().positive().nullish(),
    confirm_payment_link_reassignment: z.boolean().optional(),
    confirm_payment_link_mismatch: z.boolean().optional(),
    collect_address: z.boolean().nullish(),
    preferred_language: z.string().trim().max(20).nullish(),
    idempotency_key: z.string().trim().min(1).max(200).nullish(),
  })
  .strict();

const additionalCardMessageSchema = z
  .object({
    card_to: z.string().trim().max(300).nullable().optional(),
    card_message: z.string().trim().min(1).max(5000),
    card_from: z.string().trim().max(300).nullable().optional(),
    qr_link: z
      .string()
      .trim()
      .max(2000)
      .url()
      .refine((value) => {
        const protocol = new URL(value).protocol;
        return protocol === "http:" || protocol === "https:";
      }, "QR link must use http:// or https://")
      .nullable()
      .optional(),
  })
  .strict();

// NOTE: the bare `POST /orders` path is already owned by the API-key external
// ingest (`externalOrders.ts`, mounted earlier with `requireApiKey`, which 401s
// any request lacking a `pk_live_` key). The Clerk-authenticated dashboard
// create-order endpoint therefore lives at `POST /orders/manual` to avoid the
// route collision while keeping the same order-creation semantics.
router.post("/orders/manual", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);
  const parsed = createOrderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: "Validation error",
      details: parsed.error.issues,
    });
    return;
  }

  const data = parsed.data;
  // CMC staff can create only CMC-originated orders through this shared route.
  // Never use a broad CMC sub-permission to authorize ordinary dashboard
  // manual orders.
  if (data.source === "cmc-pos") {
    if (!hasCmcPosNewOrderAccess(wreq)) {
      res.status(403).json({ success: false, error: "You do not have access to create CMC orders" });
      return;
    }
  } else if (!hasPageAccess(wreq, "orders")) {
    res.status(403).json({ success: false, error: "You do not have access to create orders" });
    return;
  }
  // Associating a payment link is a payment-links action, not merely an
  // order-creation action. This prevents the broader CMC order-create role
  // from moving or attaching a link it is not permitted to manage.
  if (data.payment_link_id != null && !hasPageAccess(wreq, "payment-links")) {
    res.status(403).json({ success: false, error: "You do not have access to manage payment links" });
    return;
  }
  if (data.discount && data.source !== "cmc-pos") {
    res.status(400).json({ success: false, error: "Discounts are only supported for CMC POS orders" });
    return;
  }
  if (data.discount && !hasPageAccess(wreq, "cmc_pos.discount")) {
    res.status(403).json({ success: false, error: "You do not have permission to apply CMC discounts" });
    return;
  }
  const hasItems = (data.line_items?.length ?? 0) > 0;
  const hasCustomer =
    data.customer != null &&
    (!!data.customer.contact_id ||
      Object.values(data.customer).some((v) => typeof v === "string" && v.trim() !== ""));
  if (!hasItems) {
    res.status(400).json({ success: false, error: "An order must have at least one product" });
    return;
  }
  if (!hasCustomer) {
    res.status(400).json({ success: false, error: "An order must have customer details" });
    return;
  }

  try {
    const { orderId, displayOrderNumber } = await createManualOrder({
      workspaceOwnerId: wreq.workspaceOwnerId,
      actorUserId: wreq.userId ?? null,
      data: {
        ...data,
        payment_link_id: data.payment_link_id ?? null,
        confirm_payment_link_reassignment: data.confirm_payment_link_reassignment === true,
        confirm_payment_link_mismatch: data.confirm_payment_link_mismatch === true,
      },
    });
    res
      .status(201)
      .json({ success: true, id: orderId, display_order_number: displayOrderNumber });
  } catch (err) {
    if (err instanceof ContactNotFoundError) {
      res.status(400).json({ success: false, error: err.message });
      return;
    }
    if (err instanceof ManualOrderPricingError) {
      res.status(400).json({ success: false, error: err.message });
      return;
    }
    if (err instanceof PaymentLinkOrderError) {
      res.status(err.status).json({ success: false, error: err.message, ...err.details });
      return;
    }
    if (err instanceof CmcOrderDiscountError) {
      res.status(422).json({ success: false, error: err.message });
      return;
    }
    req.log.error({ err }, "POST /orders: failed to create manual order");
    res.status(500).json({ success: false, error: "Failed to create order" });
  }
});

router.get("/orders", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const status = typeof req.query.status === "string" ? req.query.status.trim() : "";
  const source = typeof req.query.source === "string" ? req.query.source.trim() : "";
  const attribution =
    typeof req.query.attribution === "string"
      ? req.query.attribution.trim().toLowerCase()
      : "";
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  const conditions: string[] = ["o.workspace_owner_id = $1"];
  const params: unknown[] = [wreq.workspaceOwnerId];

  if (status) {
    params.push(status);
    conditions.push(`o.status = $${params.length}`);
  }
  if (source) {
    if (source === "dashboard") {
      // "Dashboard orders" — all sources that can be picked in the create-order wizard
      params.push(["manual", "whatsapp", "instagram", "phone", "walkin", "website", "other"]);
      conditions.push(`o.source = ANY($${params.length}::text[])`);
    } else {
      params.push(source);
      conditions.push(`o.source = $${params.length}`);
    }
  }
  if (attribution) {
    // Resolve the effective marketing attribution source from the JSONB field,
    // preferring last_touch utm_source → first_touch utm_source → top-level source.
    const attrSrc = `lower(COALESCE(
      NULLIF(o.marketing_attribution->'last_touch'->>'utm_source', ''),
      NULLIF(o.marketing_attribution->'first_touch'->>'utm_source', ''),
      NULLIF(o.marketing_attribution->>'source', ''),
      ''
    ))`;
    if (attribution === "direct" || attribution === "unknown") {
      // Direct/unknown: no attribution or effectively empty source
      conditions.push(
        `(o.marketing_attribution IS NULL OR ${attrSrc} IN ('', 'direct'))`,
      );
    } else {
      params.push(attribution);
      conditions.push(`${attrSrc} = $${params.length}`);
    }
  }

  // Country filter — optional ISO 3166-1 alpha-2 code (lb, ae, cy).
  // Matches against either the stored countryCode (ISO) or country (name) in
  // the delivery_address JSONB, tolerating both representations.
  const countryParam =
    typeof req.query.country === "string" ? req.query.country.trim().toLowerCase() : "";
  if (countryParam) {
    const countryEntry = findCountryByCode(countryParam);
    // Match by ISO code (any case stored by ingest) OR by full country name.
    params.push(countryParam);
    const codeIdx = params.length;
    if (countryEntry) {
      params.push(countryEntry.name.toLowerCase());
      const nameIdx = params.length;
      conditions.push(
        `(LOWER(o.delivery_address->>'countryCode') = $${codeIdx} OR LOWER(o.delivery_address->>'country') = $${nameIdx})`,
      );
    } else {
      // Unknown code: fall back to code-only match.
      conditions.push(`LOWER(o.delivery_address->>'countryCode') = $${codeIdx}`);
    }
  }

  // These SQL expressions mirror resolveDeliverySchedule in the web app:
  // canonical timestamps have priority, and legacy metadata is usable only as
  // a validated date + slot pair. In particular, placement timestamps are
  // never part of a delivery schedule.
  const {
    lateralSql: retainedScheduleJoin,
    dateTextExpr: retainedDateTextExpr,
    slotTextExpr: retainedSlotTextExpr,
    dateExpr: legacyDateExpr,
    usableExpr: usableLegacyExpr,
  } = retainedDeliveryScheduleSql("o");
  // Share the list's canonical/legacy schedule and delivery-market timezone
  // expressions between Today filtering and urgency ordering. A legacy date
  // only participates when its date+slot pair was validated by the resolver.
  const urgencyDayKey = `CASE
      WHEN o.window_start IS NOT NULL OR o.window_end IS NOT NULL
        THEN (COALESCE(o.window_start, o.window_end)
              AT TIME ZONE COALESCE(dctz.timezone, 'UTC'))::date
      WHEN ${usableLegacyExpr} THEN ${legacyDateExpr}
      ELSE NULL END`;
  const todayInMarket = `(now() AT TIME ZONE COALESCE(dctz.timezone, 'UTC'))::date`;
  const finishedExpr = `o.status IN ('completed','delivered','cancelled','refunded')`;

  if (req.query.today === "true") {
    // getUrgency groups scheduled orders on/before the market-local day as
    // Today, except finished orders from an earlier day. Thus overdue open
    // orders remain actionable while historical finished orders are excluded.
    conditions.push(
      `(${urgencyDayKey} <= ${todayInMarket}
        AND NOT (${finishedExpr} AND ${urgencyDayKey} < ${todayInMarket}))`,
    );
  }

  // Multi-date Delivery Date filter. The browser timezone remains a fallback
  // for old rows whose city cannot be resolved; normal rows use their delivery
  // market timezone, just like the list/detail presentation.
  const deliveryDates = (
    typeof req.query.deliveryDates === "string" ? req.query.deliveryDates : ""
  )
    .split(",")
    .map((d) => d.trim())
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  const tzRaw = typeof req.query.tz === "string" ? req.query.tz.trim() : "";
  const tz = tzRaw && isValidTimeZone(tzRaw) ? tzRaw : "UTC";
  if (deliveryDates.length > 0) {
    params.push(tz);
    const tzPh = params.length;
    params.push(deliveryDates);
    const datesPh = params.length;
    conditions.push(
      `COALESCE(
         CASE WHEN o.window_start IS NOT NULL OR o.window_end IS NOT NULL
              THEN (COALESCE(o.window_start, o.window_end)
                    AT TIME ZONE COALESCE(dctz.timezone, $${tzPh}))::date END,
         CASE WHEN o.window_start IS NULL AND o.window_end IS NULL
              AND ${usableLegacyExpr} THEN ${legacyDateExpr} END
       ) = ANY($${datesPh}::date[])`,
    );
  }

  // Multi-value Time slot filter. Accepts a comma-separated list of
  // "HH:MM–HH:MM" window strings (e.g. "09:00–13:00") as returned by
  // GET /orders/delivery-slots. Matches against the order's window_start/
  // window_end columns formatted identically (UTC). Orders with no delivery
  // window never match.
  const slots = (typeof req.query.slots === "string" ? req.query.slots : "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 50);
  if (slots.length > 0) {
    params.push(slots);
    conditions.push(
      `(
        (o.window_start IS NOT NULL AND o.window_end IS NOT NULL
          AND to_char(o.window_start AT TIME ZONE COALESCE(dctz.timezone, 'UTC'), 'HH24:MI') || '–' ||
              to_char(o.window_end   AT TIME ZONE COALESCE(dctz.timezone, 'UTC'), 'HH24:MI') = ANY($${params.length}::text[]))
        OR
        (o.window_start IS NULL AND o.window_end IS NULL
          AND ${usableLegacyExpr}
          AND ${retainedSlotTextExpr} = ANY($${params.length}::text[]))
      )`,
    );
  }

  if (q) {
    params.push(`%${q}%`);
    const pn = params.length;
    conditions.push(
      `(o.display_order_number ILIKE $${pn} OR o.external_order_id ILIKE $${pn} OR c.display_name ILIKE $${pn} OR c.email ILIKE $${pn} OR c.phone ILIKE $${pn})`,
    );
  }

  const where = conditions.join(" AND ");

  // Optional urgency ordering (used by the dashboard Orders list as its
  // default): use the same canonical/legacy schedule and delivery-market
  // timezone as the clients, then sink finished orders below open ones within
  // that day. Orders without usable delivery information sort last.
  const sortMode = typeof req.query.sort === "string" ? req.query.sort : "";
  const unscheduledExpr = `(${urgencyDayKey} IS NULL)`;
  // Buckets: 0 = scheduled & actionable (open, or finished for today/future),
  // 2 = unscheduled, 3 = past finished history (dead last, most recent first).
  // Within bucket 0 the day is clamped to today so overdue OPEN orders fold
  // into Today (oldest overdue first), finished rows sink below open ones of
  // the same day, and ties resolve by window end ascending.
  const urgencyBucket = `CASE
      WHEN ${unscheduledExpr} THEN 2
      WHEN ${finishedExpr} AND ${urgencyDayKey} < ${todayInMarket} THEN 3
      ELSE 0 END`;
  const orderBy =
    sortMode === "urgency"
      ? `ORDER BY
          ${urgencyBucket} ASC,
          (CASE WHEN (${urgencyBucket}) = 0 THEN GREATEST(${urgencyDayKey}, ${todayInMarket}) END) ASC NULLS LAST,
          (CASE WHEN (${urgencyBucket}) = 0 AND ${finishedExpr} THEN 1 ELSE 0 END) ASC,
          (CASE WHEN (${urgencyBucket}) = 0 THEN ${urgencyDayKey} END) ASC NULLS LAST,
          (CASE WHEN (${urgencyBucket}) = 0 THEN COALESCE(o.window_end, o.window_start) END) ASC NULLS LAST,
          (CASE WHEN (${urgencyBucket}) = 3 THEN ${urgencyDayKey} END) DESC NULLS LAST,
          o.created_at DESC, o.id DESC`
      : `ORDER BY o.created_at DESC, o.id DESC`;

  params.push(limit);
  const limitPh = params.length;
  params.push(offset);
  const offsetPh = params.length;

  const result = await db.query(
    `SELECT
        o.id,
        o.display_order_number,
        o.external_order_id,
        o.status,
        o.source,
        o.channel,
        o.ordered_at,
        CASE
          WHEN ${usableLegacyExpr}
            AND ${retainedSlotTextExpr} ~* '^express$'
            AND o.raw_payload#>>'{delivery,isExpress}' IS NULL
          THEN 'express'
          ELSE o.delivery_type
        END AS delivery_type,
        CASE WHEN ${usableLegacyExpr} THEN
          jsonb_set(
            jsonb_set(COALESCE(o.delivery_address, '{}'::jsonb), '{date}', to_jsonb(${retainedDateTextExpr}), true),
            '{slot}', to_jsonb(${retainedSlotTextExpr}), true
          )
        ELSE o.delivery_address END AS delivery_address,
        o.window_start,
        o.window_end,
        o.totals,
        o.created_at,
        o.qr_link,
        o.delivery_date_review,
        o.is_anonymous,
        o.is_sensitive_occasion,
        o.marketing_attribution,
        c.id         AS contact_id,
        c.display_name AS contact_name,
        c.email      AS contact_email,
        c.phone      AS contact_phone,
        COALESCE(plsum.payment_status, p.status) AS payment_status,
        p.method     AS payment_method,
        jsonb_build_object(
          'commercial_total', NULLIF(o.totals->>'total', '')::numeric,
          'commercial_currency', UPPER(COALESCE(o.totals->>'currency', 'USD')),
          'paid', COALESCE(plsum.paid, 0),
          'pending', COALESCE(plsum.pending, 0),
          'remaining', CASE WHEN NULLIF(o.totals->>'total', '') IS NULL THEN NULL
            ELSE GREATEST(NULLIF(o.totals->>'total', '')::numeric - COALESCE(plsum.paid, 0), 0) END,
          'overpaid', CASE WHEN NULLIF(o.totals->>'total', '') IS NULL THEN 0
            ELSE GREATEST(COALESCE(plsum.paid, 0) - NULLIF(o.totals->>'total', '')::numeric, 0) END,
          'linked_count', COALESCE(plsum.linked_count, 0),
          'currency_mismatch', COALESCE(plsum.currency_mismatch, false)
        ) AS payment_summary,
        d.first_name AS driver_first_name,
        d.last_name  AS driver_last_name,
        a.status     AS assignment_status,
        CASE WHEN ofa.location_id IS NOT NULL THEN
          jsonb_build_object(
            'location_id', ofa.location_id,
            'location_name', loc.name,
            'status', ofa.status
          )
        ELSE NULL END AS workshop,
        COALESCE(a.delivered_at, o.tookan_delivered_at) AS delivered_at,
        COALESCE(dctz.timezone, 'UTC') AS delivery_timezone
       FROM orders o
  LEFT JOIN order_contacts ocon ON ocon.order_id = o.id AND ocon.role = 'customer'
  LEFT JOIN contacts c ON c.id = ocon.contact_id
  LEFT JOIN order_payment p ON p.order_id = o.id
   LEFT JOIN LATERAL (
     SELECT COUNT(*)::int AS linked_count,
            COALESCE(SUM(CASE WHEN pl.status = 'paid'
                    AND UPPER(pl.currency) = UPPER(COALESCE(o.totals->>'currency', 'USD'))
                  THEN pl.amount / 100.0 ELSE 0 END), 0) AS paid,
            COALESCE(SUM(CASE WHEN pl.status <> 'paid'
                    AND UPPER(pl.currency) = UPPER(COALESCE(o.totals->>'currency', 'USD'))
                  THEN pl.amount / 100.0 ELSE 0 END), 0) AS pending,
            BOOL_OR(UPPER(pl.currency) <> UPPER(COALESCE(o.totals->>'currency', 'USD'))) AS currency_mismatch,
            CASE
              WHEN BOOL_OR(UPPER(pl.currency) <> UPPER(COALESCE(o.totals->>'currency', 'USD'))) THEN 'mismatch'
              WHEN COALESCE(SUM(CASE WHEN pl.status = 'paid'
                        AND UPPER(pl.currency) = UPPER(COALESCE(o.totals->>'currency', 'USD'))
                      THEN pl.amount / 100.0 ELSE 0 END), 0)
                   >= COALESCE(NULLIF(o.totals->>'total', '')::numeric, 999999999) THEN 'paid'
              WHEN COALESCE(SUM(CASE WHEN pl.status = 'paid'
                        AND UPPER(pl.currency) = UPPER(COALESCE(o.totals->>'currency', 'USD'))
                      THEN pl.amount / 100.0 ELSE 0 END), 0) > 0 THEN 'partially_paid'
              WHEN COUNT(*) > 0 THEN 'pending'
              ELSE NULL
            END AS payment_status
       FROM payment_links pl
      WHERE pl.order_id = o.id AND pl.workspace_owner_id = o.workspace_owner_id
   ) plsum ON true
  LEFT JOIN fleet_driver_order_assignments a ON a.order_id = o.id
  LEFT JOIN fleet_drivers d ON d.id = a.driver_id
  LEFT JOIN order_florist_assignments ofa ON ofa.order_id = o.id
  LEFT JOIN locations loc ON loc.id = ofa.location_id
   LEFT JOIN LATERAL (
     -- Operational timezone from the delivery city (mirrors GET /orders/:id).
     -- Read through to_jsonb instead of a direct column reference: older
     -- production schemas may not have the delivery timezone column yet, and
     -- a direct reference would fail every list request with PostgreSQL 42703
     -- until the publish-time schema migration completes.
     SELECT COALESCE(
              (SELECT name
                 FROM pg_timezone_names
                WHERE name = NULLIF(to_jsonb(dc)->>'delivery_timezone', '')
                LIMIT 1),
              'UTC'
            ) AS timezone
       FROM delivery_cities dc
      WHERE dc.workspace_owner_id = o.workspace_owner_id
        AND NULLIF(o.delivery_address->>'cityId', '') IS NOT NULL
        AND (
          dc.id::text = o.delivery_address->>'cityId'
          OR lower(dc.slug) = lower(o.delivery_address->>'cityId')
        )
      LIMIT 1
   ) dctz ON true
  ${retainedScheduleJoin}
      WHERE ${where}
      ${orderBy}
      LIMIT $${limitPh} OFFSET $${offsetPh}`,
    params,
  );

  const countParams = params.slice(0, params.length - 2);
  const countResult = await db.query(
    `SELECT COUNT(*) AS total
       FROM orders o
  LEFT JOIN order_contacts ocon ON ocon.order_id = o.id AND ocon.role = 'customer'
  LEFT JOIN contacts c ON c.id = ocon.contact_id
  LEFT JOIN LATERAL (
    SELECT COALESCE(
             (SELECT name
                FROM pg_timezone_names
               WHERE name = NULLIF(to_jsonb(dc)->>'delivery_timezone', '')
               LIMIT 1),
             'UTC'
           ) AS timezone
      FROM delivery_cities dc
     WHERE dc.workspace_owner_id = o.workspace_owner_id
       AND NULLIF(o.delivery_address->>'cityId', '') IS NOT NULL
       AND (
         dc.id::text = o.delivery_address->>'cityId'
         OR lower(dc.slug) = lower(o.delivery_address->>'cityId')
       )
     LIMIT 1
  ) dctz ON true
  ${retainedScheduleJoin}
      WHERE ${where}`,
    countParams,
  );

  // Resolve a single representative product thumbnail per order for the list.
  // All work is batched for the whole page (never per-order N+1): one query to
  // pull the line items for every order, one products lookup, then the first
  // line item (by id) that resolves to an image wins per order.
  const orderRows = result.rows as Array<{ id: string; thumbnail_url?: string | null }>;
  const orderIds = orderRows.map((o) => o.id);
  if (orderIds.length > 0) {
    const lineItemRows = await db.query<{
      order_id: string;
      image_url: string | null;
      product_id: number | null;
      sku: string | null;
    }>(
      `SELECT order_id, image_url, product_id, sku
         FROM order_line_items
        WHERE order_id = ANY($1::uuid[])
        ORDER BY order_id, id`,
      [orderIds],
    );

    const productIds = Array.from(
      new Set(
        lineItemRows.rows
          .map((it) => it.product_id)
          .filter((v): v is number => typeof v === "number" && Number.isFinite(v)),
      ),
    );
    const skus = Array.from(
      new Set(
        lineItemRows.rows
          .map((it) => (it.sku ?? "").trim())
          .filter((s) => s.length > 0),
      ),
    );

    const byId = new Map<number, string | null>();
    const bySku = new Map<string, string | null>();
    if (productIds.length > 0 || skus.length > 0) {
      const productImages = await db.query<{
        id: number;
        sku: string | null;
        main_image_url: string | null;
        image_public_path: string | null;
      }>(
        `SELECT id, sku, main_image_url, image_public_path
           FROM products
          WHERE workspace_owner_id = $1
            AND (id = ANY($2::int[]) OR sku = ANY($3::text[]))`,
        [wreq.workspaceOwnerId, productIds, skus],
      );
      for (const row of productImages.rows) {
        const url = resolveProductImageUrl(row.main_image_url, row.image_public_path);
        byId.set(row.id, url);
        if (row.sku) bySku.set(row.sku, url);
      }
    }

    const thumbByOrder = new Map<string, string>();
    for (const it of lineItemRows.rows) {
      if (thumbByOrder.has(it.order_id)) continue;
      const resolved =
        (it.product_id != null ? byId.get(it.product_id) : undefined) ??
        (it.sku ? bySku.get(it.sku.trim()) : undefined) ??
        (it.image_url ? resolveProductImageUrl(it.image_url, null) : null);
      if (resolved) thumbByOrder.set(it.order_id, resolved);
    }

    for (const o of orderRows) {
      o.thumbnail_url = thumbByOrder.get(o.id) ?? null;
    }
  }

  res.json({
    success: true,
    orders: orderRows,
    total: Number(countResult.rows[0]?.total ?? 0),
    limit,
    offset,
  });

});

/**
 * Distinct delivery time slots present on this workspace's orders, used to
 * populate the Orders page "Time slot" filter dropdown. Slots are the
 * `delivery_address.slot` labels (e.g. "9:00 AM – 12:00 PM"); ordering is
 * chronological by each slot's earliest window start time (falling back to
 * label sort) so the dropdown reads like a day schedule.
 */
router.get("/orders/delivery-slots", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);
  const {
    lateralSql: retainedScheduleJoin,
    slotTextExpr,
    usableExpr,
  } = retainedDeliveryScheduleSql("o");
  const result = await db.query(
    `SELECT slot, MIN(sort_start) AS sort_start
       FROM (
         SELECT to_char(o.window_start AT TIME ZONE COALESCE(dctz.timezone, 'UTC'), 'HH24:MI') || '–' ||
                to_char(o.window_end   AT TIME ZONE COALESCE(dctz.timezone, 'UTC'), 'HH24:MI') AS slot,
                o.window_start AS sort_start
           FROM orders o
          LEFT JOIN LATERAL (
            SELECT COALESCE(
                     (SELECT name
                        FROM pg_timezone_names
                       WHERE name = NULLIF(to_jsonb(dc)->>'delivery_timezone', '')
                       LIMIT 1),
                     'UTC'
                   ) AS timezone
              FROM delivery_cities dc
             WHERE dc.workspace_owner_id = o.workspace_owner_id
               AND NULLIF(o.delivery_address->>'cityId', '') IS NOT NULL
               AND (
                 dc.id::text = o.delivery_address->>'cityId'
                 OR lower(dc.slug) = lower(o.delivery_address->>'cityId')
               )
             LIMIT 1
          ) dctz ON true
          WHERE o.workspace_owner_id = $1
            AND o.window_start IS NOT NULL
            AND o.window_end   IS NOT NULL
         UNION ALL
          SELECT ${slotTextExpr} AS slot,
                NULL::timestamptz AS sort_start
           FROM orders o
           ${retainedScheduleJoin}
          WHERE o.workspace_owner_id = $1
            AND o.window_start IS NULL
            AND o.window_end IS NULL
            AND ${usableExpr}
       ) delivery_slots
      GROUP BY slot
      ORDER BY sort_start NULLS LAST, slot
      LIMIT 100`,
    [wreq.workspaceOwnerId],
  );
  const slots = result.rows.map((r: { slot: string }) => r.slot);
  res.json({ slots });
});

router.get("/orders/pending-count", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);
  const result = await db.query(
    `SELECT COUNT(*) AS count FROM orders WHERE workspace_owner_id = $1 AND status = 'pending'`,
    [wreq.workspaceOwnerId],
  );
  res.json({ success: true, count: Number(result.rows[0]?.count ?? 0) });
});

/**
 * Start address collection from an order when its delivery address is missing.
 * The collector service owns all outreach and is intentionally idempotent:
 * repeated clicks keep the existing request instead of scheduling duplicate
 * messages.
 */
router.post("/orders/:id/address-collector", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);
  if (!requireOrderAccess(wreq, res)) return;

  const id = await resolveOrderIdParam(String(req.params.id), wreq.workspaceOwnerId);
  if (!id) {
    res.status(404).json({ success: false, error: "Order not found" });
    return;
  }

  try {
    const orderResult = await db.query<{
      id: string;
      status: string;
      window_start: string | null;
      window_end: string | null;
      delivery_address: Record<string, unknown> | null;
      delivery_type: string | null;
      recipient_name: string | null;
      recipient_phone: string | null;
    }>(
      `SELECT o.id, o.status, o.window_start, o.window_end, o.delivery_address, o.delivery_type,
              c.display_name AS recipient_name, c.phone AS recipient_phone
         FROM orders o
    LEFT JOIN LATERAL (
           SELECT c.display_name, c.phone
             FROM order_contacts oc
             JOIN contacts c ON c.id = oc.contact_id
            WHERE oc.order_id = o.id
              AND oc.role = 'recipient'
              AND c.workspace_owner_id = o.workspace_owner_id
            LIMIT 1
         ) c ON true
        WHERE o.id = $1 AND o.workspace_owner_id = $2
        LIMIT 1`,
      [id, wreq.workspaceOwnerId],
    );
    const order = orderResult.rows[0];
    if (!order) {
      res.status(404).json({ success: false, error: "Order not found" });
      return;
    }
    if (["completed", "delivered", "cancelled", "refunded"].includes(order.status)) {
      res.status(409).json({ success: false, code: "order_terminal", error: "Address collection is closed for this order" });
      return;
    }
    if (hasUsableDeliveryAddress(order.delivery_address)) {
      res.status(409).json({ success: false, code: "address_present", error: "This order already has a delivery address" });
      return;
    }

    const existing = await db.query<{ id: string; status: string }>(
      `SELECT id, status
         FROM address_collection_requests
        WHERE order_id = $1
          AND workspace_owner_id = $2
          AND status NOT IN ('cancelled', 'expired')
        ORDER BY created_at DESC
        LIMIT 1`,
      [id, wreq.workspaceOwnerId],
    );
    if (existing.rows[0]) {
      res.json({
        success: true,
        created: false,
        reason: "duplicate",
        requestId: existing.rows[0].id,
        status: existing.rows[0].status,
      });
      return;
    }

    const address = order.delivery_address ?? {};
    const deliveryDate = typeof address.date === "string" ? address.date : null;
    const deliverySlot = typeof address.slot === "string" ? address.slot : null;
    const deliveryCountryCode =
      typeof address.country_code === "string"
        ? address.country_code
        : typeof address.country === "string"
          ? address.country
          : null;
    const missing: string[] = [];
    if (!order.recipient_name?.trim()) missing.push("recipient_name");
    if (!order.recipient_phone?.trim()) missing.push("recipient_phone");
    if (missing.length > 0) {
      res.status(422).json({
        success: false,
        code: "missing_recipient",
        error: "Add the recipient name and phone number before requesting an address",
        missing,
      });
      return;
    }

    const result = await createAddressCollectionRequest({
      workspaceOwnerId: wreq.workspaceOwnerId,
      orderId: id,
      recipientName: order.recipient_name,
      recipientPhone: order.recipient_phone,
      windowStart: order.window_start ? new Date(order.window_start) : null,
      windowEnd: order.window_end ? new Date(order.window_end) : null,
      deliveryDate,
      deliverySlot,
      deliveryCountryCode,
      isExpress: order.delivery_type?.trim().toLowerCase() === "express",
      explicitRequest: true,
      source: "ops",
    });
    if (!result.created && result.reason === "missing_recipient") {
      res.status(422).json({
        success: false,
        code: "missing_recipient",
        error: "Add the recipient name and phone number before requesting an address",
      });
      return;
    }

    let requestId = result.created ? result.requestId : result.requestId ?? null;
    // A concurrent request can win between the preflight read and the
    // service's partial-unique insert. Look it up again so every successful
    // idempotent response still points to the exact existing request.
    if (!requestId) {
      const racedRequest = await db.query<{ id: string; status: string }>(
        `SELECT id, status
           FROM address_collection_requests
          WHERE order_id = $1
            AND workspace_owner_id = $2
            AND status NOT IN ('cancelled', 'expired')
          ORDER BY created_at DESC
          LIMIT 1`,
        [id, wreq.workspaceOwnerId],
      );
      requestId = racedRequest.rows[0]?.id ?? null;
    }

    res.json({
      success: true,
      created: result.created,
      // If the post-insert lookup found an active request, a concurrent
      // creator won the race regardless of the service's pre-insert reason.
      reason: result.created ? undefined : requestId ? "duplicate" : result.reason,
      requestId,
    });
  } catch (err) {
    logger.error({ err, orderId: id }, "address collector request creation failed");
    res.status(500).json({ success: false, error: "Could not create address request" });
  }
});

router.get("/orders/:id", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);
  const id = await resolveOrderIdParam(String(req.params.id), wreq.workspaceOwnerId);
  if (!id) {
    res.status(404).json({ success: false, error: "Order not found" });
    return;
  }

  const {
    lateralSql: retainedScheduleJoin,
    dateTextExpr,
    slotTextExpr,
    usableExpr,
  } = retainedDeliveryScheduleSql("o");
  const orderResult = await db.query(
    `SELECT
        o.*,
        CASE WHEN ${usableExpr} THEN
          jsonb_set(
            jsonb_set(COALESCE(o.delivery_address, '{}'::jsonb), '{date}', to_jsonb(${dateTextExpr}), true),
            '{slot}', to_jsonb(${slotTextExpr}), true
          )
        ELSE o.delivery_address END AS delivery_address,
        p.status  AS payment_status,
        p.method  AS payment_method,
        COALESCE(NULLIF(TRIM(p.provider), ''), p.method) AS payment_provider,
        p.provider_ref AS payment_reference,
        p.amount_usd AS payment_amount_usd,
        p.amount AS payment_amount,
        p.currency AS payment_currency,
        p.whish_instructions_sent_at,
        p.refunded_amount,
        p.refunded_amount_usd,
        p.paid_at,
        cr.discount_amount_usd AS coupon_discount_usd,
        COALESCE(cp.code, o.raw_payload->>'couponCode', o.raw_payload->>'coupon_code') AS coupon_code,
        cp.discount_type AS coupon_discount_type,
        cp.discount_value AS coupon_discount_value,
        cp.description AS coupon_description,
        n.customer_note,
        n.florist_note,
        n.driver_note,
        n.internal_note
       FROM orders o
  LEFT JOIN order_payment p ON p.order_id = o.id
  LEFT JOIN LATERAL (
        SELECT r.coupon_id, r.discount_amount_usd
          FROM coupon_redemptions r
         WHERE r.order_id = o.id
           AND r.workspace_owner_id = o.workspace_owner_id
           AND r.status = 'confirmed'
         ORDER BY r.created_at
         LIMIT 1
       ) cr ON true
  LEFT JOIN coupons cp ON cp.id = cr.coupon_id
  LEFT JOIN order_notes n ON n.order_id = o.id
  ${retainedScheduleJoin}
      WHERE o.id = $1 AND o.workspace_owner_id = $2
      LIMIT 1`,
    [id, wreq.workspaceOwnerId],
  );

  if (orderResult.rowCount === 0) {
    res.status(404).json({ success: false, error: "Order not found" });
    return;
  }

  const lineItems = await db.query(
    `SELECT * FROM order_line_items WHERE order_id = $1 ORDER BY id`,
    [id],
  );

  // Resolve a product image for each line item that doesn't already carry one.
  // Match by product_id first, then by sku within the workspace, using a single
  // batched products query (never per-item). Any image already stored on the
  // line item wins; the lookup only fills empty image_url values.
  const lineItemRows = lineItems.rows as Array<{
    image_url: string | null;
    product_id: number | null;
    sku: string | null;
  }>;
  const itemsNeedingImage = lineItemRows.filter((it) => !it.image_url);
  if (itemsNeedingImage.length > 0) {
    const productIds = Array.from(
      new Set(
        itemsNeedingImage
          .map((it) => it.product_id)
          .filter((v): v is number => typeof v === "number" && Number.isFinite(v)),
      ),
    );
    const skus = Array.from(
      new Set(
        itemsNeedingImage
          .map((it) => (it.sku ?? "").trim())
          .filter((s) => s.length > 0),
      ),
    );
    if (productIds.length > 0 || skus.length > 0) {
      const productImages = await db.query<{
        id: number;
        sku: string | null;
        main_image_url: string | null;
        image_public_path: string | null;
      }>(
        `SELECT id, sku, main_image_url, image_public_path
           FROM products
          WHERE workspace_owner_id = $1
            AND (id = ANY($2::int[]) OR sku = ANY($3::text[]))`,
        [wreq.workspaceOwnerId, productIds, skus],
      );
      const byId = new Map<number, string | null>();
      const bySku = new Map<string, string | null>();
      for (const row of productImages.rows) {
        const url = resolveProductImageUrl(row.main_image_url, row.image_public_path);
        byId.set(row.id, url);
        if (row.sku) bySku.set(row.sku, url);
      }
      for (const it of itemsNeedingImage) {
        let resolved: string | null | undefined;
        if (it.product_id != null) resolved = byId.get(it.product_id);
        if (!resolved && it.sku) resolved = bySku.get(it.sku.trim());
        if (resolved) it.image_url = resolved;
      }
    }
  }

  const contacts = await db.query<{
    role: string;
    contact_id: string;
    first_name: string | null;
    last_name: string | null;
    display_name: string | null;
    email: string | null;
    phone: string | null;
    respondio_contact_id: string | null;
    respondio_sync_status: string | null;
  }>(
    `SELECT oc.role, c.id AS contact_id, c.first_name, c.last_name,
            c.display_name, c.email, c.phone, c.respondio_contact_id,
            c.respondio_sync_status
       FROM order_contacts oc
       JOIN contacts c ON c.id = oc.contact_id
      WHERE oc.order_id = $1 AND c.workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  const contactsWithRespondIo = contacts.rows.map((contact) => ({
    ...contact,
    respondio_url: contact.respondio_contact_id
      ? getRespondIoContactUrl(contact.respondio_contact_id)
      : null,
    // True when the contact is synced to respond.io but the profile URL
    // cannot be built (RESPONDIO_SPACE_ID not configured).
    respondio_synced: !!contact.respondio_contact_id,
  }));

  // Ensure the recipient entry always carries a usable name and phone when the
  // data exists anywhere in the order record. Two cases are handled:
  //
  // 1. A linked order_contacts recipient exists but its contact row has no
  //    usable name (display_name is null/empty, first_name/last_name both
  //    null/empty). This happens with legacy partial-contact rows. In this
  //    case we keep the real linked contact (preserving phone, respond.io
  //    URL, etc.) and only supplement the missing name fields from raw_payload.
  //
  // 2. No linked recipient contact exists at all. We synthesize a lightweight
  //    entry from raw_payload so the UI shows the name/phone instead of
  //    "No customer linked". The synthetic entry carries contact_id = null so
  //    the UI knows not to offer respond.io or edit actions.
  //
  // Supported raw_payload schemas: recipient.firstName/lastName/phone,
  // recipient.first_name/last_name, recipient.name, delivery.phone,
  // delivery.recipient_name, top-level recipient_name / recipient_phone.
  const rawPayload = (orderResult.rows[0]?.raw_payload ?? {}) as Record<string, unknown>;
  const recipObj = (typeof rawPayload.recipient === "object" && rawPayload.recipient !== null
    ? rawPayload.recipient : {}) as Record<string, unknown>;
  const deliveryObj = (typeof rawPayload.delivery === "object" && rawPayload.delivery !== null
    ? rawPayload.delivery : {}) as Record<string, unknown>;

  const rawFirstName = (
    typeof recipObj.firstName === "string" ? recipObj.firstName.trim()
    : typeof recipObj.first_name === "string" ? recipObj.first_name.trim() : ""
  ) || null;
  const rawLastName = (
    typeof recipObj.lastName === "string" ? recipObj.lastName.trim()
    : typeof recipObj.last_name === "string" ? recipObj.last_name.trim() : ""
  ) || null;
  const rawDisplayName = (
    typeof recipObj.name === "string" ? recipObj.name.trim()
    : typeof rawPayload.recipient_name === "string" ? rawPayload.recipient_name.trim()
    : typeof deliveryObj.recipient_name === "string" ? deliveryObj.recipient_name.trim() : ""
  ) || null;
  const rawPhone = (
    typeof recipObj.phone === "string" ? recipObj.phone.trim()
    : typeof deliveryObj.phone === "string" ? deliveryObj.phone.trim()
    : typeof rawPayload.recipient_phone === "string" ? rawPayload.recipient_phone.trim() : ""
  ) || null;

  /** True when a contact row carries at least one non-empty name token. */
  function hasUsableName(c: { display_name: string | null; first_name: string | null; last_name: string | null }): boolean {
    return !!(
      (c.display_name ?? "").trim() ||
      (c.first_name ?? "").trim() ||
      (c.last_name ?? "").trim()
    );
  }

  const hasLinkedRecipient = contactsWithRespondIo.some((c) => c.role === "recipient");
  let finalContacts: Array<Record<string, unknown>>;

  if (hasLinkedRecipient) {
    // Case 1: linked contact exists — supplement name from raw_payload if blank.
    finalContacts = contactsWithRespondIo.map((c) => {
      if (c.role !== "recipient" || hasUsableName(c)) return c;
      // Contact has no usable name: fill from raw_payload, keep everything else.
      return {
        ...c,
        first_name: (c.first_name ?? "").trim() || rawFirstName,
        last_name: (c.last_name ?? "").trim() || rawLastName,
        display_name: (c.display_name ?? "").trim() || rawDisplayName,
      };
    });
  } else if (rawDisplayName || rawFirstName || rawLastName || rawPhone) {
    // Case 2: no linked contact — synthesize from raw_payload.
    finalContacts = [
      ...contactsWithRespondIo,
      {
        role: "recipient",
        contact_id: null,
        first_name: rawFirstName,
        last_name: rawLastName,
        display_name: rawDisplayName,
        email: null,
        phone: rawPhone,
        respondio_contact_id: null,
        respondio_sync_status: null,
        respondio_url: null,
        respondio_synced: false,
      },
    ];
  } else {
    finalContacts = contactsWithRespondIo;
  }

  const assignment = await db.query(
    `SELECT a.id AS assignment_id, a.status AS assignment_status,
            a.scheduled_at, a.delivered_at, a.notes AS assignment_notes,
            d.id AS driver_id, d.first_name AS driver_first_name,
            d.last_name AS driver_last_name, d.phone AS driver_phone
       FROM fleet_driver_order_assignments a
       JOIN fleet_drivers d ON d.id = a.driver_id
      WHERE a.order_id = $1 AND a.workspace_owner_id = $2
      LIMIT 1`,
    [id, wreq.workspaceOwnerId],
  );

  const contactEdits = await fetchLatestContactEdits(String(id));
  const additionalCardMessages = await db.query(
    `SELECT id, card_to, card_message, card_from, qr_link, created_at
       FROM order_card_messages
      WHERE order_id = $1 AND workspace_owner_id = $2
      ORDER BY created_at, id`,
    [id, wreq.workspaceOwnerId],
  );

  // Returning-customer indicator: how many OTHER orders in this workspace are
  // linked to the same customer contact. 0 for first-time buyers or orders
  // without a linked customer contact.
  let customerPriorOrders = 0;
  const customerContact = (contacts.rows as Array<{ role: string; contact_id: string }>).find(
    (c) => c.role === "customer",
  );
  if (customerContact) {
    const prior = await db.query<{ count: string }>(
      `SELECT COUNT(DISTINCT oc.order_id)::text AS count
         FROM order_contacts oc
         JOIN orders o ON o.id = oc.order_id
        WHERE oc.contact_id = $1
          AND oc.role = 'customer'
          AND oc.order_id <> $2
          AND o.workspace_owner_id = $3`,
      [customerContact.contact_id, id, wreq.workspaceOwnerId],
    );
    customerPriorOrders = Number(prior.rows[0]?.count ?? 0);
  }

  // Returning-recipient indicator: how many OTHER orders in this workspace are
  // linked to the same recipient contact. 0 for first-time recipients or orders
  // without a linked recipient contact.
  let recipientPriorOrders = 0;
  const recipientContact = (contacts.rows as Array<{ role: string; contact_id: string }>).find(
    (c) => c.role === "recipient",
  );
  if (recipientContact) {
    const prior = await db.query<{ count: string }>(
      `SELECT COUNT(DISTINCT oc.order_id)::text AS count
         FROM order_contacts oc
         JOIN orders o ON o.id = oc.order_id
        WHERE oc.contact_id = $1
          AND oc.role = 'recipient'
          AND oc.order_id <> $2
          AND o.workspace_owner_id = $3`,
      [recipientContact.contact_id, id, wreq.workspaceOwnerId],
    );
    recipientPriorOrders = Number(prior.rows[0]?.count ?? 0);
  }

  // "Edited after placement" flag: true when any line-item edit event was
  // recorded for this order (add/remove/replace/quantity/custom-input).
  const editedResult = await db.query<{ edited: boolean }>(
    `SELECT EXISTS(
        SELECT 1 FROM order_events
         WHERE order_id = $1 AND event_type LIKE 'line_item_%'
      ) AS edited`,
    [id],
  );
  const lineItemsEdited = editedResult.rows[0]?.edited === true;
  // Run canonical payment queries after the existing detail hydration work.
  // This preserves the established query order for unrelated order detail
  // behavior while adding a non-duplicating link collection/read model.
  // Extract delivery city ID for timezone lookup.
  const deliveryAddr = orderResult.rows[0]?.delivery_address as Record<string, unknown> | null;
  const cityId =
    typeof deliveryAddr?.cityId === "string" ? deliveryAddr.cityId.trim() : "";

  const [linkedPaymentLinks, paymentSummary, addressCollectorRequest, statusTsResult, tzResult] = await Promise.all([
    db.query(
      `SELECT pl.id, pl.public_token, pl.amount, pl.currency, pl.status, pl.provider,
              pl.description, pl.created_at, pl.paid_at, pl.created_by_member_id,
              wm.member_user_id AS creator_clerk_id
         FROM payment_links pl
         LEFT JOIN workspace_members wm ON wm.id = pl.created_by_member_id
        WHERE pl.order_id = $1 AND pl.workspace_owner_id = $2
        ORDER BY pl.created_at DESC`,
      [id, wreq.workspaceOwnerId],
    ),
    getOrderPaymentSummary(db, id),
    db.query<{
      id: string;
      status: string;
      risk_level: string | null;
      submitted_address: Record<string, unknown> | string | null;
      address_received_at: string | null;
      resolution_outcome: string | null;
      closure_reason: string | null;
      closure_source: string | null;
      closed_at: string | null;
    }>(
      `SELECT id, status, risk_level, submitted_address, address_received_at,
              resolution_outcome, closure_reason, closure_source, closed_at
         FROM address_collection_requests
        WHERE order_id = $1
          AND workspace_owner_id = $2
        ORDER BY created_at DESC
        LIMIT 1`,
      [id, wreq.workspaceOwnerId],
    ),
    // Status-transition timestamps: most-recent time each status was entered.
    db.query<{ status: string; ts: string }>(
      `SELECT payload->>'to' AS status,
              MAX(created_at)::text AS ts
         FROM order_events
        WHERE order_id = $1
          AND event_type = 'status_changed'
          AND payload->>'to' IS NOT NULL
        GROUP BY payload->>'to'`,
      [id],
    ),
    // Operational timezone from the delivery city (for frontend time formatting).
    // Read through to_jsonb instead of referencing dc.delivery_timezone
    // directly. Older production schemas do not have that column yet; a direct
    // reference makes every order-detail request fail with PostgreSQL 42703
    // until the publish-time schema migration completes. JSON field access is
    // backwards-compatible and falls back safely during that rollout window.
    cityId
      ? db.query<{ timezone: string }>(
          `SELECT COALESCE(to_jsonb(dc)->>'delivery_timezone', 'UTC') AS timezone
             FROM delivery_cities dc
            WHERE dc.workspace_owner_id = $1
              AND (dc.id::text = $2 OR lower(dc.slug) = lower($2))
            LIMIT 1`,
          [wreq.workspaceOwnerId, cityId],
        )
      : Promise.resolve({ rows: [] as Array<{ timezone: string }>, rowCount: 0 }),
  ]);

  const statusTimestamps: Record<string, string> = {};
  for (const row of statusTsResult.rows) {
    if (row.status) statusTimestamps[row.status] = row.ts;
  }
  const timezone = tzResult.rows[0]?.timezone ?? "UTC";

  res.json({
    success: true,
    order: {
      ...orderResult.rows[0],
      // Compatibility for older clients. This is deliberately derived from
      // canonical links and never from orders.payment_link_id.
      payment_link: linkedPaymentLinks.rows[0] ?? null,
      linked_payment_links: linkedPaymentLinks.rows,
      payment_summary: paymentSummary,
      address_collector_request: addressCollectorRequest.rows[0] ?? null,
    },
    line_items: lineItems.rows,
    contacts: finalContacts,
    contact_edits: contactEdits,
    additional_card_messages: additionalCardMessages.rows,
    assignment: assignment.rows[0] ?? null,
    customer_prior_orders: customerPriorOrders,
    recipient_prior_orders: recipientPriorOrders,
    line_items_edited: lineItemsEdited,
    status_timestamps: statusTimestamps,
    timezone,
  });
});

router.post(
  "/orders/:id/card-messages",
  async (req: Request, res: Response): Promise<void> => {
    const wreq = workspace(req);
    if (!requireOrderAccess(wreq, res)) return;
    const orderIdResult = z.string().uuid().safeParse(req.params.id);
    if (!orderIdResult.success) {
      res.status(400).json({ success: false, error: "Invalid order ID" });
      return;
    }
    const parsed = additionalCardMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: parsed.error.issues[0]?.message ?? "Invalid card message",
      });
      return;
    }

    const input = parsed.data;
    const orderId = orderIdResult.data;
    const result = await db.query<{
      id: string;
      card_to: string | null;
      card_message: string;
      card_from: string | null;
      qr_link: string | null;
      created_at: string;
    }>(
      `INSERT INTO order_card_messages
         (workspace_owner_id, order_id, card_to, card_message, card_from, qr_link, created_by)
       SELECT o.workspace_owner_id, o.id, $3, $4, $5, $6, $7
         FROM orders o
        WHERE o.id = $1 AND o.workspace_owner_id = $2
       RETURNING id, card_to, card_message, card_from, qr_link, created_at`,
      [
        orderId,
        wreq.workspaceOwnerId,
        input.card_to || null,
        input.card_message,
        input.card_from || null,
        input.qr_link || null,
        wreq.userId ?? null,
      ],
    );
    if (result.rowCount === 0) {
      res.status(404).json({ success: false, error: "Order not found" });
      return;
    }
    const createdCardMessage = result.rows[0]!;
    try {
      await db.query(
        `INSERT INTO order_events
           (workspace_owner_id, order_id, event_type, payload, actor_user_id)
         VALUES ($1, $2, 'card_message_added', $3::jsonb, $4)`,
        [
          wreq.workspaceOwnerId,
          orderId,
          JSON.stringify({ card_message_id: createdCardMessage.id }),
          wreq.userId ?? null,
        ],
      );
    } catch (err) {
      logger.warn({ err, orderId }, "Failed to record additional card message event");
    }
    res.status(201).json({ success: true, card_message: createdCardMessage });
  },
);

/**
 * GET /api/orders/:id/activity
 * Merged activity timeline for an order, newest first. Combines:
 *  - a synthesized "order_placed" event from the order row's created_at,
 *  - recorded order_events rows (status changes, mark-paid, refund, notes),
 *  - a synthesized "payment_received" event from order_payment.paid_at when
 *    no explicit payment event was recorded (e.g. webhook-paid orders),
 *  - contact edits from order_contact_edits.
 */
router.get("/orders/:id/activity", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);
  const id = await resolveOrderIdParam(String(req.params.id), wreq.workspaceOwnerId);
  if (!id) {
    res.status(404).json({ success: false, error: "Order not found" });
    return;
  }

  const orderResult = await db.query<{
    created_at: string;
    source: string;
    paid_at: string | null;
  }>(
    `SELECT o.created_at, o.source, p.paid_at
       FROM orders o
  LEFT JOIN order_payment p ON p.order_id = o.id
      WHERE o.id = $1 AND o.workspace_owner_id = $2
      LIMIT 1`,
    [id, wreq.workspaceOwnerId],
  );
  if (orderResult.rowCount === 0) {
    res.status(404).json({ success: false, error: "Order not found" });
    return;
  }
  const orderRow = orderResult.rows[0];

  const [eventsResult, editsResult] = await Promise.all([
    db.query<{
      id: string;
      event_type: string;
      payload: Record<string, unknown> | null;
      actor_name: string | null;
      created_at: string;
    }>(
      `SELECT id, event_type, payload, actor_name, created_at
         FROM order_events
        WHERE order_id = $1
        ORDER BY created_at DESC
        LIMIT 200`,
      [id],
    ),
    db.query<{
      id: string;
      role: string;
      edited_by_name: string | null;
      edited_at: string;
    }>(
      `SELECT id, role, edited_by_name, edited_at
         FROM order_contact_edits
        WHERE order_id = $1
        ORDER BY edited_at DESC
        LIMIT 200`,
      [id],
    ),
  ]);

  type ActivityEvent = {
    id: string;
    event_type: string;
    payload: Record<string, unknown> | null;
    actor_name: string | null;
    created_at: string;
  };

  const events: ActivityEvent[] = [
    {
      id: `placed-${id}`,
      event_type: "order_placed",
      payload: { source: orderRow.source },
      actor_name: null,
      created_at: orderRow.created_at,
    },
    ...eventsResult.rows.map((r) => ({
      id: r.id,
      event_type: r.event_type,
      payload: r.payload,
      actor_name: r.actor_name,
      created_at: r.created_at,
    })),
    ...editsResult.rows.map((r) => ({
      id: `contact-${r.id}`,
      event_type: "contact_updated",
      payload: { role: r.role } as Record<string, unknown>,
      actor_name: r.edited_by_name,
      created_at: r.edited_at,
    })),
  ];

  // Synthesize a payment event from paid_at when none was explicitly recorded
  // (covers orders paid before event logging existed and webhook-paid orders).
  const hasPaymentEvent = eventsResult.rows.some(
    (r) => r.event_type === "payment_marked_paid",
  );
  if (orderRow.paid_at && !hasPaymentEvent) {
    events.push({
      id: `paid-${id}`,
      event_type: "payment_received",
      payload: null,
      actor_name: null,
      created_at: orderRow.paid_at,
    });
  }

  events.sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );

  res.json({ success: true, events });
});

// ── Quick-add an internal note (Activity/Internal Notes card) ────────────────
const addInternalNoteSchema = z
  .object({ note: z.string().trim().min(1).max(5000) })
  .strict();

/**
 * POST /api/orders/:id/internal-notes
 * Appends an attributed internal note as an order_events row (event_type
 * `internal_note`). Unlike the legacy single `order_notes.internal_note` blob,
 * each note keeps its author and timestamp. Requires Orders page access.
 */
router.post("/orders/:id/internal-notes", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);
  if (!requireOrderAccess(wreq, res)) return;
  const id = await resolveOrderIdParam(String(req.params.id), wreq.workspaceOwnerId);
  if (!id) {
    res.status(404).json({ success: false, error: "Order not found" });
    return;
  }

  const parsed = addInternalNoteSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ success: false, error: "Note text is required" });
    return;
  }

  const existing = await db.query<{ id: string }>(
    `SELECT id FROM orders WHERE id = $1 AND workspace_owner_id = $2 LIMIT 1`,
    [id, wreq.workspaceOwnerId],
  );
  if (existing.rowCount === 0) {
    res.status(404).json({ success: false, error: "Order not found" });
    return;
  }

  const actorName = await resolveEditorName(wreq.userId);
  const inserted = await db.query<{
    id: string;
    event_type: string;
    payload: Record<string, unknown> | null;
    actor_name: string | null;
    created_at: string;
  }>(
    `INSERT INTO order_events
       (workspace_owner_id, order_id, event_type, payload, actor_user_id, actor_name)
     VALUES ($1, $2, 'internal_note', $3::jsonb, $4, $5)
     RETURNING id, event_type, payload, actor_name, created_at`,
    [
      wreq.workspaceOwnerId,
      id,
      JSON.stringify({ note: parsed.data.note }),
      wreq.userId,
      actorName,
    ],
  );

  res.status(201).json({ success: true, event: inserted.rows[0] });
});

// ── Order line-item editing (add / edit / remove) ────────────────────────────
// Post-placement edits to an order's line items. All routes require Orders
// page access, run in a transaction that locks the order row, recompute the
// order's stored totals (subtotal from SUM(line_total); total preserves the
// stored shipping/discount), and record an order_events row so the Activity
// feed carries the full edit history.

const MAX_CUSTOM_INPUT_LENGTH = 22;

/** Reasons a staff member can pick when adding a $0 complimentary line item. */
export const COMPLIMENTARY_LINE_ITEM_REASONS = [
  "customer_service_gesture",
  "complaint_resolution",
  "vip_gesture",
  "damaged_replacement_item",
  "other",
] as const;

const complimentaryReasonEnum = z.enum(COMPLIMENTARY_LINE_ITEM_REASONS);

const complimentaryInputSchema = z
  .object({
    reason: complimentaryReasonEnum,
    note: z.string().trim().max(1000).nullable().optional(),
  })
  .strict()
  .refine((v) => v.reason !== "other" || !!(v.note && v.note.trim().length > 0), {
    message: "A note is required when reason is 'other'",
    path: ["note"],
  });

const addLineItemSchema = z
  .object({
    product_id: z.number().int().positive(),
    quantity: z.number().int().min(1).max(999),
    custom_input: z.string().max(MAX_CUSTOM_INPUT_LENGTH).nullable().optional(),
    // When set, the item is added as a $0 customer-service gesture: the
    // catalog price is captured as the immutable original value and the
    // selling price/line total are forced to zero.
    complimentary: complimentaryInputSchema.nullable().optional(),
  })
  .strict();

const updateLineItemSchema = z
  .object({
    product_id: z.number().int().positive().optional(),
    quantity: z.number().int().min(1).max(999).optional(),
    custom_input: z.string().max(MAX_CUSTOM_INPUT_LENGTH).nullable().optional(),
    name: z.string().trim().min(1).max(500).optional(),
    unit_price: z.number().min(0).optional(),
    production_instructions: z.string().trim().max(5000).optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.product_id !== undefined ||
      v.quantity !== undefined ||
      v.custom_input !== undefined ||
      v.name !== undefined ||
      v.unit_price !== undefined ||
      v.production_instructions !== undefined,
    { message: "At least one field is required" },
  );

/** Thrown inside a line-item transaction to roll back and answer with a status. */
class LineItemHttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function toFiniteMoney(value: unknown): number | null {
  if (value == null) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

type OrderTotalsRow = {
  id: string;
  totals: Record<string, unknown> | null;
  delivery_address?: Record<string, unknown> | null;
  payment_currency?: string | null;
  payment_amount?: string | number | null;
  payment_amount_usd?: string | number | null;
  source?: string | null;
  status?: string | null;
  tookan_status?: string | null;
  fleet_assignment_status?: string | null;
};

/**
 * Tookan statuses meaning the driver has the order (job started / in
 * progress). Mirrors the "Out for delivery"-family badges the dashboard shows
 * (`lib/tookanStatusBadge.ts`).
 */
const TOOKAN_OUT_FOR_DELIVERY_STATUSES = new Set(["started", "in_progress", "arrived"]);

/** Fleet-driver assignment statuses meaning the driver has picked up the order. */
const FLEET_OUT_FOR_DELIVERY_STATUSES = new Set(["picked_up", "out_for_delivery"]);

/**
 * True when the order is out for delivery via any delivery path: the order
 * status itself, the Tookan job progression, or a fleet-driver assignment.
 */
export function isOrderOutForDelivery(row: {
  status?: string | null;
  tookan_status?: string | null;
  fleet_assignment_status?: string | null;
}): boolean {
  const status = String(row.status ?? "").trim().toLowerCase();
  if (status === "out_for_delivery") return true;
  const tookan = String(row.tookan_status ?? "").trim().toLowerCase();
  if (TOOKAN_OUT_FOR_DELIVERY_STATUSES.has(tookan)) return true;
  const fleet = String(row.fleet_assignment_status ?? "").trim().toLowerCase();
  return FLEET_OUT_FOR_DELIVERY_STATUSES.has(fleet);
}

/**
 * Lock the order row for the duration of the transaction and return its
 * current totals. Throws 404 when the order isn't in the workspace, and 409
 * when line items are locked: the order is completed (legacy "delivered"
 * treated as completed) or out for delivery (order status, Tookan job
 * started/in progress, or fleet-driver assignment picked up).
 */
async function lockOrderForLineItemEdit(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }> },
  orderId: string,
  workspaceOwnerId: string,
): Promise<OrderTotalsRow> {
  const result = await client.query(
    `SELECT o.id, o.totals, o.delivery_address, o.source, o.status, o.tookan_status,
            op.currency AS payment_currency, op.amount AS payment_amount,
            op.amount_usd AS payment_amount_usd,
            (SELECT a.status FROM fleet_driver_order_assignments a
              WHERE a.order_id = o.id LIMIT 1) AS fleet_assignment_status
       FROM orders o
       LEFT JOIN order_payment op ON op.order_id = o.id
      WHERE o.id = $1 AND o.workspace_owner_id = $2
      LIMIT 1 FOR UPDATE OF o`,
    [orderId, workspaceOwnerId],
  );
  const row = result.rows[0] as OrderTotalsRow | undefined;
  if (!row) throw new LineItemHttpError(404, "Order not found");
  const status = String(row.status ?? "").toLowerCase();
  if (status === "completed" || status === "delivered") {
    throw new LineItemHttpError(409, "Line items cannot be modified on a completed order");
  }
  if (isOrderOutForDelivery(row)) {
    throw new LineItemHttpError(
      409,
      "Line items cannot be modified while the order is out for delivery",
    );
  }
  return row;
}

/**
 * Recompute the order's stored totals after a line-item change: subtotal is
 * SUM(line_total) over the remaining items; total = subtotal + shipping −
 * discount using the shipping/discount already stored in the totals JSON.
 * All other totals keys (currency, paid_total, …) are preserved untouched.
 *
 * Paid-currency subtotal (totals.paid_subtotal, the actually-charged amount
 * stored at ingest for external non-USD orders): when present, it is kept in
 * lockstep — recomputed as SUM(paid_line_total) while every line still
 * carries a paid_line_total, and REMOVED once any line lacks one (a product
 * added/replaced from the dashboard has no paid-currency price). Removing it
 * makes the dashboard fall back explicitly to base USD pricing with the
 * implied-rate conversion, instead of showing a stale mixed-currency subtotal.
 */
async function recomputeOrderTotals(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }> },
  orderId: string,
  currentTotals: Record<string, unknown> | null,
  source?: string | null,
): Promise<Record<string, unknown>> {
  const sumResult = await client.query(
    `SELECT COALESCE(SUM(line_total), 0)::text AS subtotal,
            COALESCE(SUM(paid_line_total), 0)::text AS paid_subtotal,
            COUNT(*) FILTER (WHERE paid_line_total IS NULL)::int AS unpaid_lines,
            COUNT(*)::int AS total_lines,
            COALESCE(SUM(CASE WHEN is_complimentary
                          THEN COALESCE(complimentary_original_price, 0) * quantity
                          ELSE 0 END), 0)::text AS complimentary_value
       FROM order_line_items WHERE order_id = $1`,
    [orderId],
  );
  const sumRow = sumResult.rows[0] as
    | {
        subtotal?: string;
        paid_subtotal?: string;
        unpaid_lines?: number;
        total_lines?: number;
        complimentary_value?: string;
      }
    | undefined;
  const subtotalRaw = sumRow?.subtotal;
  const subtotal = round2(toFiniteMoney(subtotalRaw) ?? 0);
  const complimentaryValue = round2(toFiniteMoney(sumRow?.complimentary_value) ?? 0);

  const totals: Record<string, unknown> = { ...(currentTotals ?? {}) };
  if (totals.paid_subtotal != null) {
    const unpaidLines = sumRow?.unpaid_lines ?? 0;
    const totalLines = sumRow?.total_lines ?? 0;
    const paidSubtotal = toFiniteMoney(sumRow?.paid_subtotal);
    if (totalLines > 0 && unpaidLines === 0 && paidSubtotal != null) {
      const paidCurrency =
        typeof totals.paid_currency === "string" ? totals.paid_currency.trim().toUpperCase() : "USD";
      totals.paid_subtotal = applyRounding(paidSubtotal, paidCurrency || "USD");
    } else {
      // Explicit fallback to base pricing: at least one line has no
      // paid-currency price, so a paid-currency subtotal can no longer be
      // maintained consistently.
      delete totals.paid_subtotal;
    }
  }
  const shipping =
    toFiniteMoney(totals.shipping) ??
    toFiniteMoney(totals.delivery_fee) ??
    toFiniteMoney(totals.shipping_total) ??
    0;
  const storedDiscount = toFiniteMoney(totals.discount) ?? 0;
  const cmcDiscount =
    totals.cmc_discount && typeof totals.cmc_discount === "object"
      ? (totals.cmc_discount as Record<string, unknown>)
      : null;
  let discount = storedDiscount;
  if (
    cmcDiscount &&
    (cmcDiscount.type === "percent" || cmcDiscount.type === "amount") &&
    toFiniteMoney(cmcDiscount.value) != null
  ) {
    const value = toFiniteMoney(cmcDiscount.value) ?? 0;
    discount =
      cmcDiscount.type === "percent"
        ? round2((subtotal * value) / 100)
        : Math.min(round2(value), subtotal);
    totals.discount = discount;
    totals.cmc_discount = { ...cmcDiscount, amount: discount, currency: "USD" };
  }
  totals.subtotal = subtotal;
  totals.total = round2(subtotal + shipping - discount);
  // Merchandise subtotal is the full retail value of every line (catalog
  // price × qty), including complimentary ones; complimentary_total is the
  // negative deduction that reconciles it back down to the customer subtotal
  // (merchandise_subtotal + complimentary_total === subtotal). Both keys are
  // only present when the order actually has a complimentary line, so orders
  // without one keep showing the plain Subtotal/Total rows unchanged.
  if (complimentaryValue > 0) {
    totals.merchandise_subtotal = round2(subtotal + complimentaryValue);
    totals.complimentary_total = round2(-complimentaryValue);
  } else {
    delete totals.merchandise_subtotal;
    delete totals.complimentary_total;
  }

  await client.query(
    `UPDATE orders SET totals = $2::jsonb, updated_at = now() WHERE id = $1`,
    [orderId, JSON.stringify(totals)],
  );
  // CMC new orders have a mirrored cmc_sales snapshot and a USD order-payment
  // record. Keep every CMC item edit synchronized, with or without a discount.
  if (source === "cmc-pos") {
    const total = toFiniteMoney(totals.total) ?? 0;
    const saleItemsResult = await client.query(
      `SELECT COALESCE(
          jsonb_agg(jsonb_build_object(
            'product_id', CASE WHEN COALESCE(is_custom_item, false) THEN NULL ELSE product_id END,
            'name', name,
            'qty', CASE WHEN quantity > 0 THEN quantity ELSE 1 END,
            'unit_price', COALESCE(unit_price, 0),
            'image_url', image_url,
            'item_type', CASE WHEN COALESCE(is_custom_item, false) THEN 'custom' ELSE 'shelf' END
          ) ORDER BY created_at, id),
          '[]'::jsonb
        ) AS line_items
        FROM order_line_items
        WHERE order_id = $1`,
      [orderId],
    );
    const saleLineItems =
      (saleItemsResult.rows[0] as { line_items?: unknown } | undefined)?.line_items ?? [];
    await client.query(
      `UPDATE order_payment
          SET amount = $2,
              amount_usd = $2
        WHERE order_id = $1`,
      [orderId, total],
    );
    await client.query(
      `UPDATE cmc_sales
          SET line_items = $2::jsonb,
              subtotal = $3,
              discount_amount = $4,
              total = $5,
              discount_type = $6,
              discount_value = $7,
              discount_description = $8,
              updated_at = now()
        WHERE order_id = $1 AND workflow_type = 'order'`,
      [
        orderId,
        JSON.stringify(saleLineItems),
        subtotal,
        discount,
        total,
        cmcDiscount?.type ?? null,
        cmcDiscount?.value ?? null,
        cmcDiscount
          ? [cmcDiscount.reason, cmcDiscount.explanation].filter(Boolean).join(": ") || null
          : null,
      ],
    );
  }
  return totals;
}

type LineItemProductRow = {
  id: number;
  name: string;
  sku: string | null;
  price_usd: string | number | null;
  discount_price_usd: string | number | null;
  price_aed: string | number | null;
  discount_price_aed: string | number | null;
  main_image_url: string | null;
  image_public_path: string | null;
};

/** Load a workspace product for add/replace. Throws 404 when missing. */
async function loadProductForLineItem(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }> },
  productId: number,
  workspaceOwnerId: string,
): Promise<LineItemProductRow> {
  const result = await client.query(
    `SELECT id, name, sku, price_usd, discount_price_usd, price_aed, discount_price_aed,
            main_image_url, image_public_path
       FROM products
      WHERE id = $1 AND workspace_owner_id = $2 AND is_archived = false
      LIMIT 1`,
    [productId, workspaceOwnerId],
  );
  const row = result.rows[0] as LineItemProductRow | undefined;
  if (!row) throw new LineItemHttpError(404, "Product not found");
  return row;
}

function productUnitPrice(product: LineItemProductRow): number {
  const price = toFiniteMoney(product.discount_price_usd) ?? toFiniteMoney(product.price_usd);
  if (price == null) throw new LineItemHttpError(422, "This product does not have a usable price");
  return price;
}

type OrderAddProductContext = {
  countryCode: string | null;
  cityId: number | null;
  cityRef: string | null;
  marketLabel: string;
  currency: string;
  rate: number | null;
};

async function resolveOrderAddProductContext(
  queryable: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }> },
  order: Pick<OrderTotalsRow, "totals" | "delivery_address" | "payment_currency" | "payment_amount" | "payment_amount_usd">,
  workspaceOwnerId: string,
): Promise<OrderAddProductContext> {
  const totals = order.totals ?? {};
  const address = order.delivery_address ?? {};
  const cityRefRaw = address.cityId ?? address.city_id;
  const cityRef =
    typeof cityRefRaw === "string" || typeof cityRefRaw === "number"
      ? String(cityRefRaw).trim() || null
      : null;
  let cityId: number | null = null;
  let cityCountryCode: string | null = null;
  if (cityRef) {
    const cityResult = await queryable.query(
      `SELECT id, country_code
         FROM delivery_cities
        WHERE workspace_owner_id = $1
          AND (id::text = $2 OR lower(slug) = lower($2))
        LIMIT 1`,
      [workspaceOwnerId, cityRef],
    );
    const city = cityResult.rows[0] as { id?: number; country_code?: string | null } | undefined;
    cityId = typeof city?.id === "number" ? city.id : null;
    cityCountryCode = typeof city?.country_code === "string" ? city.country_code.toUpperCase() : null;
  }

  const addressCountry =
    [address.countryCode, address.country_code, address.country]
      .find((value) => typeof value === "string" && value.trim() !== "");
  const countryText = typeof addressCountry === "string" ? addressCountry.trim() : "";
  const countryEntry =
    (countryText.length === 2 ? findCountryByCode(countryText) : findCountryByName(countryText)) ??
    findCountryByCode(cityCountryCode);
  const countryCode = (countryEntry?.code ?? cityCountryCode)?.toUpperCase() ?? null;

  const totalsCurrency =
    typeof totals.paid_currency === "string" ? totals.paid_currency.trim().toUpperCase() : "";
  const paymentCurrency =
    typeof order.payment_currency === "string" ? order.payment_currency.trim().toUpperCase() : "";
  if (totalsCurrency && paymentCurrency && totalsCurrency !== paymentCurrency) {
    throw new LineItemHttpError(
      422,
      `Order currency is inconsistent (${totalsCurrency} vs ${paymentCurrency}); correct the payment before adding a product`,
    );
  }
  const currency = paymentCurrency || totalsCurrency || "USD";
  const baseTotal =
    toFiniteMoney(totals.total ?? totals.grand_total ?? totals.order_total) ??
    toFiniteMoney(order.payment_amount_usd);
  const paidTotal = toFiniteMoney(totals.paid_total) ?? toFiniteMoney(order.payment_amount);
  const baseSubtotal = toFiniteMoney(totals.subtotal);
  const paidSubtotal = toFiniteMoney(totals.paid_subtotal);
  const paymentAmount = toFiniteMoney(order.payment_amount);
  const paymentAmountUsd = toFiniteMoney(order.payment_amount_usd);
  const rate =
    currency === "USD"
      ? 1
      : paymentCurrency && paymentAmountUsd != null && paymentAmountUsd > 0 && paymentAmount != null && paymentAmount > 0
          ? paymentAmount / paymentAmountUsd
          : baseSubtotal != null && baseSubtotal > 0 && paidSubtotal != null && paidSubtotal > 0
            ? paidSubtotal / baseSubtotal
            : baseTotal != null && baseTotal > 0 && paidTotal != null && paidTotal > 0
              ? paidTotal / baseTotal
              : null;

  return {
    countryCode,
    cityId,
    cityRef,
    marketLabel: `${countryEntry?.name ?? countryCode ?? "Order"} catalog`,
    currency,
    rate,
  };
}

function resolveOrderProductPrice(
  product: LineItemProductRow,
  context: OrderAddProductContext,
): { baseUnitPrice: number | null; displayUnitPrice: number | null } {
  const baseUnitPrice =
    toFiniteMoney(product.discount_price_usd) ?? toFiniteMoney(product.price_usd);
  if (baseUnitPrice == null) return { baseUnitPrice: null, displayUnitPrice: null };
  if (context.currency === "USD") {
    return { baseUnitPrice, displayUnitPrice: applyRounding(baseUnitPrice, "USD") };
  }
  if (context.currency === "AED") {
    const aedPrice =
      toFiniteMoney(product.discount_price_aed) ?? toFiniteMoney(product.price_aed);
    if (aedPrice != null) {
      return { baseUnitPrice, displayUnitPrice: applyRounding(aedPrice, "AED") };
    }
  }
  return {
    baseUnitPrice,
    displayUnitPrice:
      context.rate == null ? null : applyRounding(baseUnitPrice * context.rate, context.currency),
  };
}

async function ensureProductEligibleForOrder(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }> },
  productId: number,
  workspaceOwnerId: string,
  context: OrderAddProductContext,
): Promise<LineItemProductRow> {
  const result = await client.query(
    `SELECT p.id, p.name, p.sku, p.price_usd, p.discount_price_usd,
            p.price_aed, p.discount_price_aed, p.main_image_url, p.image_public_path
       FROM products p
      WHERE p.id = $1
        AND p.workspace_owner_id = $2
        AND p.is_archived = false
        AND p.status = 'available'
        AND ($3::text IS NULL OR NOT EXISTS (
          SELECT 1 FROM product_country_availability pca
           WHERE pca.product_id = p.id
             AND upper(pca.country_code) = $3
             AND pca.is_available = false
        ))
        AND ($4::int IS NULL OR NOT EXISTS (
          SELECT 1 FROM product_city_availability pcia
           WHERE pcia.product_id = p.id
             AND pcia.city_id = $4
             AND pcia.is_available = false
        ))
      LIMIT 1`,
    [productId, workspaceOwnerId, context.countryCode, context.cityId],
  );
  const product = result.rows[0] as LineItemProductRow | undefined;
  if (!product) {
    const exists = await client.query(
      `SELECT id FROM products
        WHERE id = $1 AND workspace_owner_id = $2 AND is_archived = false
        LIMIT 1`,
      [productId, workspaceOwnerId],
    );
    if (exists.rowCount === 0) throw new LineItemHttpError(404, "Product not found");
    throw new LineItemHttpError(422, "This product is unavailable for the order's market");
  }
  return product;
}

router.get("/orders/:id/line-items", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);
  if (!requireOrderAccess(wreq, res)) return;
  const page = Math.max(1, Number.parseInt(String(req.query.page ?? "1"), 10) || 1);
  const pageSize = Math.min(50, Math.max(1, Number.parseInt(String(req.query.page_size ?? "25"), 10) || 25));
  const search = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 200) : "";

  const orderResult = await db.query(
    `SELECT o.totals, o.delivery_address, op.currency AS payment_currency,
            op.amount AS payment_amount, op.amount_usd AS payment_amount_usd
       FROM orders o
       LEFT JOIN order_payment op ON op.order_id = o.id
      WHERE o.id = $1 AND o.workspace_owner_id = $2
      LIMIT 1`,
    [req.params.id, wreq.workspaceOwnerId],
  );
  const order = orderResult.rows[0] as OrderTotalsRow | undefined;
  if (!order) {
    res.status(404).json({ success: false, error: "Order not found" });
    return;
  }
  let context: OrderAddProductContext;
  try {
    context = await resolveOrderAddProductContext(db, order, wreq.workspaceOwnerId);
  } catch (error) {
    if (error instanceof LineItemHttpError) {
      res.status(error.status).json({ success: false, error: error.message });
      return;
    }
    throw error;
  }
  const params: unknown[] = [wreq.workspaceOwnerId, context.countryCode, context.cityId];
  const searchClause = search
    ? (() => {
        params.push(`%${search.replace(/([%_\\])/g, "\\$1")}%`);
        const p = `$${params.length}`;
        return `AND (p.name ILIKE ${p} ESCAPE '\\' OR p.sku ILIKE ${p} ESCAPE '\\'
          OR array_to_string(p.tags, ' ') ILIKE ${p} ESCAPE '\\'
          OR EXISTS (SELECT 1 FROM product_publications pp
            WHERE pp.product_id = p.id AND pp.public_title ILIKE ${p} ESCAPE '\\'))`;
      })()
    : "";
  const where = `p.workspace_owner_id = $1 AND p.is_archived = false AND p.status = 'available'
    AND ($2::text IS NULL OR NOT EXISTS (
      SELECT 1 FROM product_country_availability pca
       WHERE pca.product_id = p.id AND upper(pca.country_code) = $2 AND pca.is_available = false))
    AND ($3::int IS NULL OR NOT EXISTS (
      SELECT 1 FROM product_city_availability pcia
       WHERE pcia.product_id = p.id AND pcia.city_id = $3 AND pcia.is_available = false))
    ${searchClause}`;
  const countResult = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM products p WHERE ${where}`,
    params,
  );
  const total = Number.parseInt(countResult.rows[0]?.count ?? "0", 10);
  params.push(pageSize, (page - 1) * pageSize);
  const productsResult = await db.query(
    `SELECT p.id, p.name, p.sku, p.price_usd, p.discount_price_usd,
            p.price_aed, p.discount_price_aed, p.main_image_url, p.image_public_path
       FROM products p
      WHERE ${where}
      ORDER BY p.name, p.id
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const products = (productsResult.rows as LineItemProductRow[]).map((product) => {
    const price = resolveOrderProductPrice(product, context);
    const available = price.displayUnitPrice != null;
    return {
      id: product.id,
      name: product.name,
      sku: product.sku,
      image_url: resolveProductImageUrl(product.main_image_url, product.image_public_path),
      status: available ? "available" : "unavailable_price",
      available,
      unit_price: price.displayUnitPrice,
      currency: context.currency,
      price_error: available ? null : "Price unavailable for this order currency",
    };
  });
  res.json({
    success: true,
    market: {
      label: context.marketLabel,
      country_code: context.countryCode,
      city_id: context.cityId,
      currency: context.currency,
    },
    products,
    total,
    page,
    page_size: pageSize,
    total_pages: Math.max(1, Math.ceil(total / pageSize)),
  });
});

/**
 * Recipe consumption is posted once, atomically, on the transition into
 * "ready_for_delivery" (see orderStatusTransition.ts) — it is not
 * incrementally reconciled against later line-item edits for any item type.
 * That is a pre-existing, order-wide limitation (regular items can already
 * be added/edited/removed at that stage without any stock adjustment) that
 * is out of scope to redesign here. To avoid *introducing new* stock drift
 * via this task's new complimentary-item capability specifically, adding,
 * quantity-editing, or removing a complimentary line is blocked once
 * consumption has actually been posted for this order.
 *
 * The check is based on durable per-order evidence — an unreversed
 * product_consumption movement row in base_item_stock_adjustments — rather
 * than the order's current status or the workspace's live feature-flag
 * value. Status alone is insufficient: an order can move on from
 * ready_for_delivery (e.g. to on_hold or back to processing) while its
 * posted consumption remains un-reconciled. The live flag alone is also
 * insufficient: disabling the feature after stock was already posted must
 * not silently reopen the lock on orders it already affected.
 */
async function hasPostedRecipeConsumption(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }> },
  workspaceOwnerId: string,
  orderId: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT EXISTS (
        SELECT 1
          FROM base_item_stock_adjustments a
         WHERE a.order_id = $1
           AND a.workspace_owner_id = $2
           AND a.movement_type = 'product_consumption'
           AND NOT EXISTS (
             SELECT 1 FROM base_item_stock_adjustments r
              WHERE r.reversal_of_id = a.id AND r.movement_type = 'order_cancellation'
           )
      ) AS has_active_consumption`,
    [orderId, workspaceOwnerId],
  );
  return Boolean(
    (result.rows[0] as { has_active_consumption?: boolean } | undefined)?.has_active_consumption,
  );
}

async function blockComplimentaryChangeAfterConsumptionPosted(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }> },
  workspaceOwnerId: string,
  orderId: string,
  message: string,
): Promise<void> {
  const posted = await hasPostedRecipeConsumption(client, workspaceOwnerId, orderId);
  if (posted) throw new LineItemHttpError(409, message);
}

function normalizeCustomInput(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed.slice(0, MAX_CUSTOM_INPUT_LENGTH);
}

/**
 * POST /api/orders/:id/line-items
 * Add a product to an order. Price is captured from the product at add time
 * (discount price when set, else the regular USD price).
 */
router.post("/orders/:id/line-items", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);
  if (!requireOrderAccess(wreq, res)) return;
  const { id } = req.params;

  const parsed = addLineItemSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ success: false, error: "Invalid line item payload" });
    return;
  }
  const input = parsed.data;

  const client = await db.connect();
  try {
    const { lineItem, totals, displayUnitPrice, catalogUnitPrice, currency } =
      await withTransaction(client, async () => {
      const order = await lockOrderForLineItemEdit(client, String(id), wreq.workspaceOwnerId);
      const context = await resolveOrderAddProductContext(client, order, wreq.workspaceOwnerId);
      const product = await ensureProductEligibleForOrder(
        client,
        input.product_id,
        wreq.workspaceOwnerId,
        context,
      );
      const resolvedPrice = resolveOrderProductPrice(product, context);
      if (resolvedPrice.baseUnitPrice == null || resolvedPrice.displayUnitPrice == null) {
        throw new LineItemHttpError(422, "This product does not have a usable price in the order currency");
      }
      const catalogUnitPrice = resolvedPrice.baseUnitPrice;
      const displayUnitPrice = resolvedPrice.displayUnitPrice;
      const isComplimentary = input.complimentary != null;
      if (isComplimentary) {
        await blockComplimentaryChangeAfterConsumptionPosted(
          client,
          wreq.workspaceOwnerId,
          String(id),
          "Complimentary items can't be added once the order has entered fulfilment and inventory has already been reconciled for it.",
        );
      }
      // Complimentary items still consume inventory/recipe stock exactly like
      // a regular line (that logic keys off product_id/quantity, never
      // price) but are sold at $0: the catalog price is preserved separately
      // as the immutable original value for the totals/activity trail.
      const unitPrice = isComplimentary ? 0 : catalogUnitPrice;
      const lineTotal = isComplimentary ? 0 : round2(catalogUnitPrice * input.quantity);
      const paidUnitPrice =
        context.currency === "USD" ? null : isComplimentary ? 0 : displayUnitPrice;
      const paidLineTotal =
        context.currency === "USD"
          ? null
          : isComplimentary
            ? 0
            : Number(computeLineTotal(displayUnitPrice, input.quantity, context.currency));
      // Intentional: resolve and store the image URL at insert time so that
      // old orders with null image_url can still be enriched by the GET handler,
      // while newly-added items always carry the correct URL without relying on
      // the fallback enrichment path.
      const imageUrl = resolveProductImageUrl(product.main_image_url, product.image_public_path);
      // Denormalized display name (same pattern as order_events.actor_name)
      // so the Line Items card's inline complimentary summary can show who
      // added it without joining back to the users table.
      const complimentaryActorName = isComplimentary ? await resolveEditorName(wreq.userId) : null;

      const inserted = await client.query(
        `INSERT INTO order_line_items
           (order_id, product_id, name, sku, quantity, unit_price, line_total,
            paid_unit_price, paid_line_total, image_url, custom_input, metadata,
            is_complimentary, complimentary_original_price, complimentary_reason, complimentary_note,
            complimentary_added_by, complimentary_added_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb,
                 $13, $14, $15, $16, $17, $18)
         RETURNING *`,
        [
          id,
          product.id,
          product.name,
          product.sku,
          input.quantity,
          unitPrice,
          lineTotal,
          paidUnitPrice,
          paidLineTotal,
          imageUrl,
          normalizeCustomInput(input.custom_input),
          JSON.stringify({
            add_product_price: {
              currency: context.currency,
              unit_price: isComplimentary ? 0 : displayUnitPrice,
              original_unit_price: displayUnitPrice,
            },
          }),
          isComplimentary,
          isComplimentary ? catalogUnitPrice : null,
          isComplimentary ? input.complimentary!.reason : null,
          isComplimentary ? input.complimentary!.note?.trim() || null : null,
          isComplimentary ? complimentaryActorName : null,
          isComplimentary ? new Date() : null,
        ],
      );

      const totalsInput =
        context.currency === "USD"
          ? order.totals
          : {
              ...(order.totals ?? {}),
              paid_currency: context.currency,
              // paid_subtotal is the order-currency commercial subtotal. A
              // zero sentinel asks recomputeOrderTotals to maintain it when
              // every line has an order-currency line total.
              paid_subtotal: order.totals?.paid_subtotal ?? 0,
            };
      const totals = await recomputeOrderTotals(client, String(id), totalsInput, order.source);
        return {
          lineItem: inserted.rows[0],
          totals,
          displayUnitPrice,
          catalogUnitPrice,
          currency: context.currency,
        };
      });

    const name = (lineItem as { name: string }).name;
    if ((lineItem as unknown as { is_complimentary?: boolean }).is_complimentary) {
      const originalValue = applyRounding(displayUnitPrice * input.quantity, currency);
      recordOrderEvent({
        workspaceOwnerId: wreq.workspaceOwnerId,
        orderId: String(id),
        eventType: "line_item_complimentary_added",
        payload: {
          name,
          quantity: input.quantity,
          reason: input.complimentary!.reason,
          note: input.complimentary!.note?.trim() || null,
          original_value: originalValue,
          currency,
          original_value_usd: round2(catalogUnitPrice * input.quantity),
        },
        actorUserId: wreq.userId,
      });
    } else {
      recordOrderEvent({
        workspaceOwnerId: wreq.workspaceOwnerId,
        orderId: String(id),
        eventType: "line_item_added",
        payload: { name, quantity: input.quantity },
        actorUserId: wreq.userId,
      });
    }

    res.status(201).json({ success: true, line_item: lineItem, totals });
  } catch (err) {
    if (err instanceof LineItemHttpError) {
      res.status(err.status).json({ success: false, error: err.message });
      return;
    }
    throw err;
  } finally {
    client.release();
  }
});

/**
 * PATCH /api/orders/:id/line-items/:itemId
 * Edit a line item: change quantity, edit the custom input, or replace the
 * product (product_id → name/sku/price/image are re-captured from the new
 * product). line_total is recomputed from unit_price × quantity.
 */
router.patch(
  "/orders/:id/line-items/:itemId",
  async (req: Request, res: Response): Promise<void> => {
    const wreq = workspace(req);
    if (!requireOrderAccess(wreq, res)) return;
    const { id, itemId } = req.params;

    const parsed = updateLineItemSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ success: false, error: "Invalid line item payload" });
      return;
    }
    const input = parsed.data;

    const client = await db.connect();
    try {
      const { lineItem, totals, events } = await withTransaction(client, async () => {
        const order = await lockOrderForLineItemEdit(client, String(id), wreq.workspaceOwnerId);

        const existingResult = await client.query(
          `SELECT * FROM order_line_items WHERE id = $1 AND order_id = $2 LIMIT 1 FOR UPDATE`,
          [itemId, id],
        );
        const existing = existingResult.rows[0] as
          | {
              id: string;
              name: string;
              quantity: string | number;
              unit_price: string | number | null;
              paid_unit_price: string | number | null;
              custom_input: string | null;
              is_custom_item: boolean;
              production_instructions: string | null;
              is_complimentary: boolean | null;
            }
          | undefined;
        if (!existing) throw new LineItemHttpError(404, "Line item not found");

        // Complimentary status is only assigned at add time (see the "Add
        // product" flow's Pricing section) and is immutable afterward — a
        // complimentary line's $0 price, catalog value, reason, and audit
        // trail must never be silently overwritten by a product swap or a
        // direct price edit. Staff who want to change their mind remove the
        // item and re-add it (as regular or complimentary).
        if (existing.is_complimentary && (input.product_id !== undefined || input.unit_price !== undefined)) {
          throw new LineItemHttpError(
            400,
            "Complimentary items can't be replaced or repriced — remove it and add it again instead.",
          );
        }

        if (existing.is_complimentary && input.quantity !== undefined) {
          await blockComplimentaryChangeAfterConsumptionPosted(
            client,
            wreq.workspaceOwnerId,
            String(id),
            "This complimentary item's quantity can't be changed once the order has entered fulfilment and inventory has already been reconciled for it.",
          );
        }

        const oldQuantity = toFiniteMoney(existing.quantity) ?? 1;
        const newQuantity = input.quantity ?? oldQuantity;

        let name = existing.name;
        let unitPrice = toFiniteMoney(existing.unit_price) ?? 0;
        const events: Array<{ eventType: string; payload: Record<string, unknown> }> = [];

        let replacedProduct: LineItemProductRow | null = null;
        if (input.product_id !== undefined) {
          replacedProduct = await loadProductForLineItem(client, input.product_id, wreq.workspaceOwnerId);
          name = replacedProduct.name;
          unitPrice = productUnitPrice(replacedProduct);
          events.push({
            eventType: "line_item_replaced",
            payload: { from: existing.name, to: replacedProduct.name, quantity: newQuantity },
          });
        }

        if (input.quantity !== undefined && input.quantity !== oldQuantity && replacedProduct === null) {
          events.push({
            eventType: "line_item_quantity_changed",
            payload: { name, from: oldQuantity, to: input.quantity },
          });
        }

        const oldCustomInput = existing.custom_input ?? null;
        const newCustomInput =
          input.custom_input === undefined ? oldCustomInput : normalizeCustomInput(input.custom_input);
        if (input.custom_input !== undefined && newCustomInput !== oldCustomInput) {
          events.push({
            eventType: "line_item_custom_input_changed",
            payload: { name, from: oldCustomInput, to: newCustomInput },
          });
        }

        const oldProductionInstructions = existing.production_instructions ?? null;
        const newProductionInstructions =
          input.production_instructions === undefined
            ? oldProductionInstructions
            : input.production_instructions.trim() || null;
        if (input.production_instructions !== undefined && newProductionInstructions !== oldProductionInstructions) {
          events.push({
            eventType: "line_item_production_instructions_changed",
            payload: { name, from: oldProductionInstructions, to: newProductionInstructions },
          });
        }

        if (input.name !== undefined && input.name !== name) {
          const oldName = name;
          name = input.name;
          events.push({
            eventType: "line_item_name_changed",
            payload: { from: oldName, to: name },
          });
        }

        const oldUnitPrice = toFiniteMoney(existing.unit_price) ?? 0;
        if (input.unit_price !== undefined && input.unit_price !== oldUnitPrice) {
          unitPrice = input.unit_price;
          events.push({
            eventType: "line_item_price_changed",
            payload: { name, from: oldUnitPrice, to: unitPrice },
          });
        }

        const lineTotal = round2(unitPrice * newQuantity);

        // Paid-currency maintenance: a quantity-only change keeps the stored
        // paid_unit_price and rescales paid_line_total with it, so the paid
        // amounts stay exactly what the customer's cart charged per unit. A
        // USD unit-price edit or a product replacement invalidates the paid
        // pair (the new price has no paid-currency counterpart), so both paid
        // fields are cleared and the line falls back to base USD pricing.
        const existingPaidUnitPrice = toFiniteMoney(existing.paid_unit_price);
        const clearPaidPricing =
          replacedProduct !== null ||
          (input.unit_price !== undefined && input.unit_price !== oldUnitPrice);
        const newPaidUnitPrice =
          !clearPaidPricing && existingPaidUnitPrice != null ? existingPaidUnitPrice : null;
        const newPaidLineTotal =
          newPaidUnitPrice != null ? round2(newPaidUnitPrice * newQuantity) : null;

        const updated = replacedProduct
          ? await client.query(
              `UPDATE order_line_items
                  SET product_id = $3, name = $4, sku = $5, unit_price = $6,
                      image_url = $7, quantity = $8, line_total = $9, custom_input = $10,
                      production_instructions = $11,
                      paid_unit_price = NULL, paid_line_total = NULL
                WHERE id = $1 AND order_id = $2
                RETURNING *`,
              [
                itemId,
                id,
                replacedProduct.id,
                replacedProduct.name,
                replacedProduct.sku,
                unitPrice,
                resolveProductImageUrl(replacedProduct.main_image_url, replacedProduct.image_public_path),
                newQuantity,
                lineTotal,
                newCustomInput,
                newProductionInstructions,
              ],
            )
          : await client.query(
              `UPDATE order_line_items
                  SET quantity = $3, line_total = $4, custom_input = $5,
                      name = COALESCE($6, name),
                      unit_price = COALESCE($7, unit_price),
                      production_instructions = $8,
                      paid_unit_price = $9, paid_line_total = $10
                WHERE id = $1 AND order_id = $2
                RETURNING *`,
              [
                itemId,
                id,
                newQuantity,
                lineTotal,
                newCustomInput,
                input.name ?? null,
                input.unit_price !== undefined ? unitPrice : null,
                newProductionInstructions,
                newPaidUnitPrice,
                newPaidLineTotal,
              ],
            );

        const totals = await recomputeOrderTotals(client, String(id), order.totals, order.source);
        return { lineItem: updated.rows[0], totals, events };
      });

      for (const event of events) {
        recordOrderEvent({
          workspaceOwnerId: wreq.workspaceOwnerId,
          orderId: String(id),
          eventType: event.eventType,
          payload: event.payload,
          actorUserId: wreq.userId,
        });
      }

      res.json({ success: true, line_item: lineItem, totals });
    } catch (err) {
      if (err instanceof LineItemHttpError) {
        res.status(err.status).json({ success: false, error: err.message });
        return;
      }
      throw err;
    } finally {
      client.release();
    }
  },
);

/**
 * DELETE /api/orders/:id/line-items/:itemId
 * Remove a line item. The last remaining item on an order cannot be removed
 * (409) — delete the order instead.
 */
router.delete(
  "/orders/:id/line-items/:itemId",
  async (req: Request, res: Response): Promise<void> => {
    const wreq = workspace(req);
    if (!requireOrderAccess(wreq, res)) return;
    const { id, itemId } = req.params;

    const client = await db.connect();
    try {
      const { removed, totals } = await withTransaction(client, async () => {
        const order = await lockOrderForLineItemEdit(client, String(id), wreq.workspaceOwnerId);

        const existingResult = await client.query(
          `SELECT id, name, quantity, is_complimentary, complimentary_reason, complimentary_note,
                  complimentary_original_price, metadata
             FROM order_line_items
            WHERE id = $1 AND order_id = $2 LIMIT 1 FOR UPDATE`,
          [itemId, id],
        );
        const existing = existingResult.rows[0] as
          | {
              id: string;
              name: string;
              quantity: string | number;
              is_complimentary: boolean;
              complimentary_reason: string | null;
              complimentary_note: string | null;
              complimentary_original_price: string | number | null;
              metadata: Record<string, unknown> | null;
            }
          | undefined;
        if (!existing) throw new LineItemHttpError(404, "Line item not found");

        if (existing.is_complimentary) {
          await blockComplimentaryChangeAfterConsumptionPosted(
            client,
            wreq.workspaceOwnerId,
            String(id),
            "This complimentary item can't be removed once the order has entered fulfilment and inventory has already been reconciled for it.",
          );
        }

        const countResult = await client.query(
          `SELECT COUNT(*)::int AS count FROM order_line_items WHERE order_id = $1`,
          [id],
        );
        const count = (countResult.rows[0] as { count: number } | undefined)?.count ?? 0;
        if (count <= 1) {
          throw new LineItemHttpError(409, "Cannot remove the last item on an order");
        }

        await client.query(`DELETE FROM order_line_items WHERE id = $1 AND order_id = $2`, [
          itemId,
          id,
        ]);

        const totals = await recomputeOrderTotals(client, String(id), order.totals, order.source);
        return { removed: existing, totals };
      });

      if (removed.is_complimentary) {
        const quantity = toFiniteMoney(removed.quantity) ?? 1;
        const addPrice =
          removed.metadata?.add_product_price &&
          typeof removed.metadata.add_product_price === "object"
            ? (removed.metadata.add_product_price as Record<string, unknown>)
            : null;
        const currency =
          typeof addPrice?.currency === "string" ? addPrice.currency.trim().toUpperCase() : "USD";
        const originalUnitPrice =
          toFiniteMoney(addPrice?.original_unit_price) ??
          toFiniteMoney(removed.complimentary_original_price) ??
          0;
        const originalValue = applyRounding(originalUnitPrice * quantity, currency);
        recordOrderEvent({
          workspaceOwnerId: wreq.workspaceOwnerId,
          orderId: String(id),
          eventType: "line_item_complimentary_removed",
          payload: {
            name: removed.name,
            quantity,
            reason: removed.complimentary_reason,
            note: removed.complimentary_note,
            original_value: originalValue,
            currency,
          },
          actorUserId: wreq.userId,
        });
      } else {
        recordOrderEvent({
          workspaceOwnerId: wreq.workspaceOwnerId,
          orderId: String(id),
          eventType: "line_item_removed",
          payload: { name: removed.name, quantity: toFiniteMoney(removed.quantity) ?? undefined },
          actorUserId: wreq.userId,
        });
      }

      res.json({ success: true, totals });
    } catch (err) {
      if (err instanceof LineItemHttpError) {
        res.status(err.status).json({ success: false, error: err.message });
        return;
      }
      throw err;
    } finally {
      client.release();
    }
  },
);

/**
 * Extract a human-readable country string from a contact's `addresses` jsonb.
 * The column shape is loose (array of address objects or a single object), so
 * we probe the first address for a `country` field. Returns null when absent.
 */
function countryFromAddresses(addresses: unknown): string | null {
  const first = Array.isArray(addresses) ? addresses[0] : addresses;
  if (first && typeof first === "object") {
    const c = (first as Record<string, unknown>).country;
    if (typeof c === "string" && c.trim() !== "") return c.trim();
  }
  return null;
}

/**
 * GET /api/orders/:id/invoice
 * Generate and download a branded invoice PDF for a single order. Loads the
 * order, its line items, and the customer (sender) contact, then renders the
 * PDF via the shared pdfkit builder. Amounts follow the order's stored
 * currency. Authenticated (router-level) and workspace-scoped, matching the
 * sibling order read/export routes (GET /orders/:id, /orders/:id/card-pdf).
 */
router.get("/orders/:id/invoice", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);
  const { id } = req.params;

  try {
    const orderResult = await db.query<{
      id: string;
      display_order_number: string | null;
      created_at: string;
      totals: Record<string, unknown> | null;
    }>(
      `SELECT id, display_order_number, created_at, totals
       FROM orders
      WHERE id = $1 AND workspace_owner_id = $2
      LIMIT 1`,
      [id, wreq.workspaceOwnerId],
    );

    if (orderResult.rowCount === 0) {
      res.status(404).json({ success: false, error: "Order not found" });
      return;
    }
    const order = orderResult.rows[0];

    const lineItemsResult = await db.query<{
      name: string;
      quantity: number | string | null;
      unit_price: string | null;
      line_total: string | null;
    }>(
      `SELECT name, quantity, unit_price, line_total
       FROM order_line_items
      WHERE order_id = $1
      ORDER BY id`,
      [id],
    );

    const customerResult = await db.query<{
      display_name: string | null;
      first_name: string | null;
      last_name: string | null;
      email: string | null;
      addresses: unknown;
    }>(
      `SELECT c.display_name, c.first_name, c.last_name, c.email, c.addresses
       FROM order_contacts oc
       JOIN contacts c ON c.id = oc.contact_id
      WHERE oc.order_id = $1 AND oc.role = 'customer'
      LIMIT 1`,
      [id],
    );
    const customer = customerResult.rows[0] ?? null;

    // Recorded payment (if any) decides the invoice sender: Stripe/PayPal
    // orders are issued from Presentail LTD (Cyprus), everything else from
    // Presentail SAL.
    const paymentResult = await db.query<{
      method: string | null;
      provider: string | null;
    }>(
      `SELECT method, provider
       FROM order_payment
      WHERE order_id = $1
      LIMIT 1`,
      [id],
    );
    const payment = paymentResult.rows[0] ?? null;

    const totals = order.totals ?? {};
    const currency =
      typeof totals.currency === "string" && totals.currency.trim() !== ""
        ? totals.currency.trim().toUpperCase()
        : "USD";

    const toNum = (v: unknown): number => {
      if (typeof v === "number") return Number.isFinite(v) ? v : 0;
      if (typeof v === "string" && v.trim() !== "") {
        const x = Number(v);
        return Number.isFinite(x) ? x : 0;
      }
      return 0;
    };

    const items: InvoiceLineItem[] = lineItemsResult.rows.map((li) => {
      const qty = toNum(li.quantity);
      const unit = li.unit_price != null ? toNum(li.unit_price) : null;
      const amount =
        li.line_total != null
          ? toNum(li.line_total)
          : unit != null
            ? qty * unit
            : null;
      return {
        name: li.name,
        quantity: li.quantity == null ? qty : li.quantity,
        unitPrice: unit,
        amount,
      };
    });

    const itemsSum = items.reduce((sum, it) => sum + toNum(it.amount), 0);
    const subtotalRaw = totals.subtotal ?? totals.sub_total;
    const subtotal = subtotalRaw != null ? toNum(subtotalRaw) : itemsSum;
    const totalRaw = totals.total ?? totals.grand_total ?? totals.order_total;
    const total = totalRaw != null ? toNum(totalRaw) : subtotal;

    const requestedBillToName =
      typeof req.query.billToName === "string" ? req.query.billToName.trim().slice(0, 200) : "";
    const billToName =
      requestedBillToName ||
      (customer?.display_name && customer.display_name.trim()) ||
      [customer?.first_name, customer?.last_name]
        .filter((v): v is string => typeof v === "string" && v.trim() !== "")
        .join(" ") ||
      null;

    const invoiceNumber =
      order.display_order_number && order.display_order_number.trim() !== ""
        ? order.display_order_number.trim()
        : order.id.slice(0, 8).toUpperCase();

    // Whish-paid orders show the included 11% VAT broken out of the total
    // (presentation only — stored totals are unchanged). All other payment
    // methods render without a VAT line.
    const whish = isWhishPayment(payment?.method, payment?.provider);
    const vatAmount = whish ? includedVatAmount(total, WHISH_VAT_RATE) : null;

    const pdf = await buildOrderInvoicePdf({
      invoiceNumber,
      currency,
      dateOfIssue: new Date(),
      dateDue: order.created_at,
      billToName,
      billToCountry: customer ? countryFromAddresses(customer.addresses) : null,
      billToEmail: customer?.email ?? null,
      items,
      subtotal,
      total,
      amountDue: total,
      senderLines: resolveInvoiceSenderLines(payment?.method, payment?.provider),
      ...(vatAmount != null && vatAmount > 0
        ? { vatRate: WHISH_VAT_RATE, vatAmount }
        : {}),
    });
    const safeName = `Invoice-${invoiceNumber.replace(/[^a-zA-Z0-9_-]/g, "_")}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
    res.send(pdf);
  } catch (err) {
    req.log.error({ err }, "Failed to generate order invoice PDF");
    res.status(500).json({ success: false, error: "Failed to generate invoice" });
  }
});

/**
 * Return the full, append-only edit history for an order's contacts, newest
 * first and paginated. Unlike the order detail response (which collapses to the
 * latest edit per role via DISTINCT ON), this lists every recorded edit so
 * staff can review the complete timeline for disputes or tracing changes.
 */
router.get("/orders/:id/contact-edits", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);
  const { id } = req.params;

  const order = await db.query<{ id: string }>(
    `SELECT id FROM orders WHERE id = $1 AND workspace_owner_id = $2 LIMIT 1`,
    [id, wreq.workspaceOwnerId],
  );
  if (order.rowCount === 0) {
    res.status(404).json({ success: false, error: "Order not found" });
    return;
  }

  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  const totalResult = await db.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM order_contact_edits WHERE order_id = $1`,
    [id],
  );
  const total = Number(totalResult.rows[0]?.count ?? 0);

  const edits = await db.query<ContactEditRow>(
    `SELECT role, edited_by_user_id, edited_by_name, edited_at
       FROM order_contact_edits
      WHERE order_id = $1
      ORDER BY edited_at DESC, id DESC
      LIMIT $2 OFFSET $3`,
    [id, limit, offset],
  );

  res.json({
    success: true,
    contact_edits: edits.rows,
    total,
    limit,
    offset,
  });
});

/**
 * Generate a styled Presentail gift-card PDF for an order. Lays out the order's
 * card TO / message / FROM on the branded stationery, with a QR code from the
 * order's `qr_link` when present. Requires an authenticated workspace session
 * and is scoped to the caller's workspace (same gate as the order detail GET).
 */
router.get("/orders/:id/card-pdf", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);
  const { id } = req.params;

  const orderResult = await db.query<{
    display_order_number: string | null;
    external_order_id: string | null;
    card_message: string | null;
    card_from: string | null;
    card_to: string | null;
    qr_link: string | null;
  }>(
    `SELECT display_order_number, external_order_id, card_message, card_from, card_to, qr_link
       FROM orders
      WHERE id = $1 AND workspace_owner_id = $2
      LIMIT 1`,
    [id, wreq.workspaceOwnerId],
  );

  const order = orderResult.rows[0];
  if (!order) {
    res.status(404).json({ success: false, error: "Order not found" });
    return;
  }

  try {
    const pdf = await buildGiftCardPdf({
      cardTo: order.card_to,
      cardMessage: order.card_message,
      cardFrom: order.card_from,
      qrLink: order.qr_link,
    });
    const ref = String(order.display_order_number || order.external_order_id || id).replace(
      /[^a-zA-Z0-9_-]/g,
      "_",
    );
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="Card-${ref}.pdf"`);
    res.send(pdf);
  } catch (err) {
    req.log.error({ err }, "Failed to generate gift card PDF");
    res.status(500).json({ success: false, error: "Failed to generate card" });
  }
});

router.patch("/orders/:id/status", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);
  const canEditOrders = hasPageAccess(wreq, "orders");
  let canManageRefundedStatus =
    wreq.workspaceRole === "owner" || wreq.workspaceActualRole === "admin";
  if (!canEditOrders && !canManageRefundedStatus) {
    canManageRefundedStatus = await hasOwnerAdminOrOps2Access(wreq);
    if (!canManageRefundedStatus) {
      res.status(403).json({ success: false, error: "You do not have access to edit orders" });
      return;
    }
  }
  const { id } = req.params;
  const { status } = req.body as { status?: string };

  if (!status || !(ORDER_STATUSES as readonly string[]).includes(status)) {
    res.status(400).json({
      success: false,
      error: `Invalid status. Must be one of: ${ORDER_STATUSES.join(", ")}`,
    });
    return;
  }

  // Capture the current status first so the customer email only fires on an
  // actual change (the webhook keeps its existing always-fires behavior).
  // The payment status is joined so the transition-to-processing guard below
  // can enforce the paid-before-processing rule in one round trip.
  const existing = await db.query<{ status: string; payment_status: string | null }>(
    `SELECT o.status, p.status AS payment_status
       FROM orders o
  LEFT JOIN order_payment p ON p.order_id = o.id
      WHERE o.id = $1 AND o.workspace_owner_id = $2 LIMIT 1`,
    [id, wreq.workspaceOwnerId],
  );
  if (existing.rowCount === 0) {
    res.status(404).json({ success: false, error: "Order not found" });
    return;
  }
  const previousStatus = existing.rows[0].status;
  const isRefundedStatusChange =
    previousStatus === "refunded" && status !== "refunded";

  if (isRefundedStatusChange && !canManageRefundedStatus) {
    canManageRefundedStatus = await hasOwnerAdminOrOps2Access(wreq);
    if (!canManageRefundedStatus) {
      res.status(403).json({
        success: false,
        error: "Only workspace owners, admins, or Ops 2 members can change refunded orders",
      });
      return;
    }
  }
  if (!isRefundedStatusChange && !canEditOrders) {
    res.status(403).json({ success: false, error: "You do not have access to edit orders" });
    return;
  }

  // Backward moves and stage skips are owner-only (mirrors the Orders
  // board's client-side isElevatedTransition gate). Enforced here too so
  // the restriction holds regardless of which UI — or a direct API call —
  // issues the request.
  const transitionKind = classifyOrderStatusTransition(previousStatus, status);
  if (
    !isRefundedStatusChange &&
    (transitionKind === "backward" || transitionKind === "forward-skip") &&
    wreq.workspaceRole !== "owner"
  ) {
    res.status(403).json({
      success: false,
      code: "elevated_transition_forbidden",
      error: "Only workspace owners can move an order backward or skip a stage.",
    });
    return;
  }

  // Unpaid orders may not enter fulfillment: block any transition INTO
  // `processing` until the payment is marked paid (the mark-as-paid route's
  // auto-advance runs its own direct UPDATE, so it is unaffected by this
  // guard). Orders already in processing or later are untouched.
  if (
    !isRefundedStatusChange &&
    status === "processing" &&
    previousStatus !== "processing" &&
    (existing.rows[0].payment_status ?? "").toLowerCase() !== "paid"
  ) {
    res.status(409).json({
      success: false,
      code: "payment_not_paid",
      error: "Order must be marked as paid before it can move to Processing",
    });
    return;
  }

  const transition = await transitionOrderStatus(db, {
    orderId: String(id),
    newStatus: status,
    workspaceOwnerId: wreq.workspaceOwnerId,
    actorUserId: wreq.userId,
    restoreRefundedPayment: isRefundedStatusChange,
    allowedFromStatuses: [previousStatus],
  });

  if (!transition.success) {
    req.log.error({ orderId: id, transition }, "orderStatusTransition failed");
    res.status(409).json({
      success: false,
      code: transition.error?.code ?? "transition_failed",
      error:
        transition.error?.code === "REFUNDED_PAYMENT_NOT_FOUND"
          ? "Cannot change a refunded order without its payment record"
          : "Inventory posting failed",
      detail: transition.error?.detail,
    });
    return;
  }
  if (transition.skipped) {
    res.status(409).json({
      success: false,
      code: "order_status_changed",
      error: "The order status changed while you were updating it. Reload and try again.",
    });
    return;
  }

  const order = await db.query<{ id: string; external_order_id: string | null; status: string }>(
    `SELECT id, external_order_id, status FROM orders WHERE id = $1 AND workspace_owner_id = $2 LIMIT 1`,
    [id, wreq.workspaceOwnerId],
  );
  if (order.rowCount === 0) {
    res.status(404).json({ success: false, error: "Order not found" });
    return;
  }
  const orderRow = order.rows[0];

  if (isRefundedStatusChange) {
    recordOrderEvent({
      workspaceOwnerId: wreq.workspaceOwnerId,
      orderId: String(id),
      eventType: "refunded_order_restored",
      payload: {
        from_order_status: previousStatus,
        from_payment_status: transition.previousPaymentStatus,
        to_order_status: orderRow.status,
        to_payment_status: "paid",
        scope: "local_only",
      },
      actorUserId: wreq.userId,
    });
  }

  // Keep the linked CMC Sales record (CMC New Order → workflow_type='order')
  // in sync: a cancelled order is voided so it never counts in audit totals.
  if (orderRow.status === "cancelled" && previousStatus !== "cancelled") {
    await db.query(
      `UPDATE cmc_sales
          SET status = 'voided', updated_at = now()
        WHERE order_id = $1 AND workspace_owner_id = $2 AND workflow_type = 'order'`,
      [id, wreq.workspaceOwnerId],
    );
  }

  void fireWebhookEvent("order.status_updated", wreq.workspaceOwnerId, {
    orderId: orderRow.id,
    appOrderId: orderRow.external_order_id ?? null,
    status: orderRow.status,
    updatedAt: new Date().toISOString(),
  });

  if (orderRow.status !== previousStatus) {
    recordOrderEvent({
      workspaceOwnerId: wreq.workspaceOwnerId,
      orderId: String(id),
      eventType: "status_changed",
      payload: { from: previousStatus, to: orderRow.status },
      actorUserId: wreq.userId,
    });
    void notifyOrderStatusEmail(
      orderRow.id,
      orderRow.external_order_id ?? orderRow.id,
      orderRow.status,
      wreq.workspaceOwnerId,
    );
    if (orderRow.status === "completed") {
      void enqueueDeliveredWhatsappNotification(
        orderRow.id,
        orderRow.external_order_id ?? orderRow.id,
        wreq.workspaceOwnerId,
      );
    } else {
      void notifyOrderStatusWhatsApp(
        orderRow.id,
        orderRow.external_order_id ?? orderRow.id,
        orderRow.status,
        wreq.workspaceOwnerId,
      );
    }
    void maybeEnqueueTrustpilotInvitation(orderRow.id, previousStatus, orderRow.status);
    req.log.warn({ orderId: id, newStatus: status }, "tookan: status change detected; Tookan task sync not yet implemented");
  }

  res.json({ success: true, order: orderRow });
});

const isoString = z
  .string()
  .datetime({ offset: true })
  .or(z.string().datetime());

const updateOrderSchema = z
  .object({
    status: z.enum(ORDER_STATUSES).optional(),
    ordered_at: isoString.nullable().optional(),
    window_start: isoString.nullable().optional(),
    window_end: isoString.nullable().optional(),
    delivery_type: z.string().max(100).nullable().optional(),
    delivery_address: z.record(z.string(), z.unknown()).nullable().optional(),
    delivery_instructions: z.string().max(5000).nullable().optional(),
    card_to: z.string().max(300).nullable().optional(),
    card_message: z.string().max(5000).nullable().optional(),
    card_from: z.string().max(300).nullable().optional(),
    qr_link: z
      .string()
      .max(2000)
      .nullable()
      .optional()
      .transform((v) => {
        if (v === undefined || v === null) return v;
        const t = v.trim();
        return t === "" ? null : t;
      })
      .refine(
        (v) => {
          if (v === undefined || v === null) return true;
          try {
            const u = new URL(v);
            return u.protocol === "http:" || u.protocol === "https:";
          } catch {
            return false;
          }
        },
        { message: "qr_link must be a valid http(s) URL" },
      ),
    is_sensitive_occasion: z.boolean().optional(),
    customer_note: z.string().max(5000).nullable().optional(),
    florist_note: z.string().max(5000).nullable().optional(),
    driver_note: z.string().max(5000).nullable().optional(),
    internal_note: z.string().max(5000).nullable().optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (
      data.window_start &&
      data.window_end &&
      new Date(data.window_end).getTime() <
        new Date(data.window_start).getTime()
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["window_end"],
        message: "window_end must be the same as or after window_start",
      });
    }
  });

export function isValidCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

const rescheduleOrderSchema = z
  .object({
    date: z.string().refine(isValidCalendarDate, "A valid date is required"),
    slot_id: z.string().min(1).max(100),
    start_time: z.string().regex(/^\d{2}:\d{2}$/),
    end_time: z.string().regex(/^\d{2}:\d{2}$/),
    delivery_type: z.string().max(100).nullable().optional(),
    delivery_address: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .strict();

export type RescheduleOrderRow = {
  id: string;
  status: string;
  external_order_id: string | null;
  delivery_type: string | null;
  delivery_address: Record<string, unknown> | null;
  window_start: string | null;
  window_end: string | null;
  tookan_job_id: string | null;
};

export type RescheduleSlot = {
  id: string;
  label: string;
  start_time: string;
  end_time: string;
  capacity: number | null;
  same_day_available?: boolean;
  next_day_available?: boolean;
};

type ConfiguredRescheduleSlot = RescheduleSlot & {
  cutoff_time: string | null;
  delivery_type: string;
  fee_override: string | null;
};

export type RescheduleQueryable = {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
};

function dateKeyInTimeZone(value: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function zonedDateTimeToIso(date: string, time: string, timeZone: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const desiredUtc = Date.UTC(year, month - 1, day, hour, minute);
  let guess = desiredUtc;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const parts = formatter.formatToParts(new Date(guess));
    const get = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((part) => part.type === type)?.value ?? 0);
    const representedUtc = Date.UTC(
      get("year"),
      get("month") - 1,
      get("day"),
      get("hour"),
      get("minute"),
    );
    guess += desiredUtc - representedUtc;
  }
  return new Date(guess).toISOString();
}

export function addOneDay(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return next.toISOString().slice(0, 10);
}

function normalizedRescheduleTime(time: string): string {
  const [hours = "", minutes = ""] = time.split(":");
  return `${hours.padStart(2, "0")}:${minutes.padStart(2, "0")}`;
}

function effectiveRescheduleSlotKey(slot: ConfiguredRescheduleSlot): string {
  return [
    (slot.delivery_type || "standard").trim().toLowerCase(),
    normalizedRescheduleTime(slot.start_time),
    normalizedRescheduleTime(slot.end_time),
  ].join("|");
}

function effectiveRescheduleAttributes(slot: ConfiguredRescheduleSlot): string {
  return JSON.stringify({
    label: slot.label,
    capacity: slot.capacity,
    cutoff_time: slot.cutoff_time,
    fee_override: slot.fee_override,
    same_day_available: slot.same_day_available ?? false,
    next_day_available: slot.next_day_available ?? true,
  });
}

/**
 * Builds the order-facing effective schedule without mutating or concealing the
 * raw admin configuration. Identical legacy repetitions collapse safely.
 * Conflicting rows are withheld until the reviewed cleanup process names a
 * survivor; choosing one here would silently change booking behavior.
 *
 * Additive date overrides are authoritative for an identity they explicitly
 * define. This keeps "add" semantics for every non-colliding weekly slot while
 * ensuring one dated definition controls a colliding window.
 */
export function resolveEffectiveRescheduleSlots(
  weeklySlots: ConfiguredRescheduleSlot[],
  overrideSlots: ConfiguredRescheduleSlot[],
  overrideType: string | null,
): ConfiguredRescheduleSlot[] {
  const collapseUnambiguous = (
    slots: ConfiguredRescheduleSlot[],
    source: "weekly" | "override",
  ): ConfiguredRescheduleSlot[] => {
    const groups = new Map<string, ConfiguredRescheduleSlot[]>();
    for (const slot of slots) {
      const key = effectiveRescheduleSlotKey(slot);
      groups.set(key, [...(groups.get(key) ?? []), slot]);
    }

    const resolved: ConfiguredRescheduleSlot[] = [];
    for (const [identity, group] of groups) {
      const attributes = new Set(group.map(effectiveRescheduleAttributes));
      if (attributes.size > 1) {
        logger.warn(
          { source, identity, slotIds: group.map((slot) => slot.id) },
          "Ambiguous delivery-slot identity withheld from reschedule options",
        );
        continue;
      }
      resolved.push(group[0]);
    }
    return resolved;
  };

  const weekly = collapseUnambiguous(weeklySlots, "weekly");
  const overrides = collapseUnambiguous(overrideSlots, "override");
  if (overrideType === "replace_regular_schedule") return overrides;
  if (overrideType !== "add_to_regular_schedule") return weekly;

  const overrideKeys = new Set(overrides.map(effectiveRescheduleSlotKey));
  return [
    ...weekly.filter((slot) => !overrideKeys.has(effectiveRescheduleSlotKey(slot))),
    ...overrides,
  ];
}

export async function resolveRescheduleContext(
  queryable: RescheduleQueryable,
  workspaceOwnerId: string,
  order: RescheduleOrderRow,
  date: string,
  options: {
    excludedWeeklySlotIds?: number[];
    now?: Date;
  } = {},
): Promise<{
  timezone: string;
  cityId: number;
  slots: RescheduleSlot[];
}> {
  const address = order.delivery_address ?? {};
  const cityValue = (value: unknown): string =>
    typeof value === "string" || typeof value === "number"
      ? String(value).trim()
      : "";
  const cityId = cityValue(address.cityId);
  const legacyCityId = cityValue(address.city_id);
  const cityName = cityValue(address.cityName);
  const legacyCityName = cityValue(address.city);
  const district = cityValue(address.district);
  const cityResult = await queryable.query<{
    id: number;
    timezone: string;
    is_active: boolean;
    standard_available: boolean;
    express_available: boolean;
    standard_capacity: number | null;
    express_capacity: number | null;
    standard_cutoff_time: string | null;
    express_enabled: boolean;
    express_start_time: string | null;
    express_end_time: string | null;
    express_cutoff_time: string | null;
    express_min_prep_minutes: number | null;
    express_daily_capacity: number | null;
    standard_globally_active: boolean;
    express_globally_active: boolean;
  }>(
    `SELECT dc.id,
            COALESCE(to_jsonb(dc)->>'delivery_timezone', 'UTC') AS timezone,
            dc.is_active,
            COALESCE((to_jsonb(dc)->>'standard_delivery_available')::boolean, true) AS standard_available,
            COALESCE((to_jsonb(dc)->>'express_delivery_available')::boolean, dc.express_delivery_enabled, false) AS express_available,
            (to_jsonb(dc)->>'max_standard_orders_per_slot')::integer AS standard_capacity,
            (to_jsonb(dc)->>'max_express_orders_per_slot')::integer AS express_capacity,
            to_jsonb(dc)->>'cutoff_time' AS standard_cutoff_time,
            COALESCE(dds.express_enabled, dc.express_delivery_enabled, false) AS express_enabled,
            dds.express_start_time,
            dds.express_end_time,
            dds.express_cutoff_time,
            dds.express_min_prep_minutes,
            dds.express_daily_capacity,
            COALESCE(ds.standard_delivery_active, true) AS standard_globally_active,
            COALESCE(ds.express_delivery_active, true) AS express_globally_active
       FROM delivery_cities dc
  LEFT JOIN district_delivery_settings dds
         ON dds.city_id = dc.id AND dds.workspace_owner_id = dc.workspace_owner_id
  LEFT JOIN delivery_settings ds
         ON ds.workspace_owner_id = dc.workspace_owner_id
      WHERE dc.workspace_owner_id = $1
      ORDER BY CASE
        WHEN dc.is_active AND $2 <> '' AND (dc.id::text = $2 OR lower(dc.slug) = lower($2)) THEN 0
        WHEN dc.is_active AND $3 <> '' AND (dc.id::text = $3 OR lower(dc.slug) = lower($3)) THEN 1
        WHEN dc.is_active AND $4 <> '' AND lower(dc.name) = lower($4) THEN 2
        WHEN dc.is_active AND $5 <> '' AND lower(dc.name) = lower($5) THEN 3
        WHEN dc.is_active AND $6 <> '' AND lower(dc.name) = lower($6) THEN 4
        WHEN dc.is_active THEN 5
        ELSE 6
      END, dc.id
      LIMIT 1`,
    [workspaceOwnerId, cityId, legacyCityId, cityName, legacyCityName, district],
  );
  const city = cityResult.rows[0];
  if (!city || !city.is_active) {
    throw Object.assign(new Error("The delivery area is unavailable"), {
      status: 409,
      code: "delivery_area_unavailable",
    });
  }
  const timezone = isValidTimeZone(city.timezone) ? city.timezone : "UTC";
  const validationNow = options.now ?? new Date();
  if (date < dateKeyInTimeZone(validationNow, timezone)) {
    throw Object.assign(new Error("Choose a future delivery date"), {
      status: 409,
      code: "delivery_date_in_past",
    });
  }

  const deliveryType = (order.delivery_type ?? "standard").trim().toLowerCase();
  if (deliveryType === "express") {
    const expressOverrideResult = await queryable.query<{
      override_type: string;
      express_enabled: boolean;
      express_start_time: string | null;
      express_end_time: string | null;
      express_cutoff_time: string | null;
      express_min_prep_minutes: number | null;
      express_daily_capacity: number | null;
    }>(
      `SELECT override_type, express_enabled, express_start_time,
              express_end_time, express_cutoff_time,
              express_min_prep_minutes, express_daily_capacity
         FROM district_special_date_overrides
        WHERE workspace_owner_id = $1
          AND is_active = true
          AND start_date <= $2::date
          AND end_date >= $2::date
          AND (city_id IS NULL OR city_id = $3)
        ORDER BY city_id NULLS LAST, id
        LIMIT 1`,
      [workspaceOwnerId, date, city.id],
    );
    const expressOverride = expressOverrideResult.rows[0] ?? null;
    const expressStart =
      expressOverride?.express_start_time ?? city.express_start_time;
    const expressEnd =
      expressOverride?.express_end_time ?? city.express_end_time;
    if (!expressStart || !expressEnd) {
      return { timezone, cityId: city.id, slots: [] };
    }
    return {
      timezone,
      cityId: city.id,
      slots: [{
        id: "express",
        label: "Express",
        start_time: expressStart,
        end_time: expressEnd,
        capacity: null,
      }],
    };
  }

  const overrideResult = await queryable.query<{ id: number; override_type: string }>(
    `SELECT id, override_type
       FROM district_special_date_overrides
      WHERE workspace_owner_id = $1
        AND is_active = true
        AND start_date <= $2::date
        AND end_date >= $2::date
        AND (city_id IS NULL OR city_id = $3)
      ORDER BY city_id NULLS LAST, id
      LIMIT 1`,
    [workspaceOwnerId, date, city.id],
  );
  const activeOverride = overrideResult.rows[0] ?? null;
  const weeklyResult = await queryable.query<ConfiguredRescheduleSlot>(
    `SELECT weekly_slot.id::text, weekly_slot.label, weekly_slot.start_time,
             weekly_slot.end_time, weekly_slot.capacity, weekly_slot.cutoff_time,
             weekly_slot.delivery_type, weekly_slot.fee_override,
             weekly_slot.same_day_available, weekly_slot.next_day_available
       FROM district_weekly_delivery_slots weekly_slot
       JOIN delivery_cities slot_city ON slot_city.id = weekly_slot.city_id
      WHERE slot_city.workspace_owner_id = $1
        AND weekly_slot.is_enabled = true
        AND weekly_slot.delivery_type = 'standard'
        AND weekly_slot.id <> ALL($2::integer[])
      ORDER BY weekly_slot.sort_order, weekly_slot.id`,
    [workspaceOwnerId, options.excludedWeeklySlotIds ?? []],
  );
  let overrideSlots: ConfiguredRescheduleSlot[] = [];
  if (activeOverride) {
    const overrideResult = await queryable.query<ConfiguredRescheduleSlot>(
      `SELECT ('override-' || id)::text AS id, label, start_time, end_time, capacity, cutoff_time,
              delivery_type, fee_override, same_day_available, next_day_available
         FROM district_special_date_override_slots
        WHERE override_id = $1 AND is_enabled = true
          AND delivery_type = 'standard'
        ORDER BY sort_order, id`,
      [activeOverride.id],
    );
    overrideSlots = overrideResult.rows;
  }
  const configured = resolveEffectiveRescheduleSlots(
    weeklyResult.rows,
    overrideSlots,
    activeOverride ? "add_to_regular_schedule" : null,
  );

  return {
    timezone,
    cityId: city.id,
    slots: configured.map((slot) => ({
      id: slot.id,
      label: slot.label,
      start_time: slot.start_time.slice(0, 5),
      end_time: slot.end_time.slice(0, 5),
      capacity: null,
    })),
  };
}

async function notifyOrderRescheduledEmail(
  orderId: string,
  orderNumber: string,
  workspaceOwnerId: string,
  idempotencyKey?: string,
): Promise<void> {
  const [contact, details] = await Promise.all([
    lookupOrderCustomerContact(orderId),
    lookupOrderEmailDetails(orderId, workspaceOwnerId),
  ]);
  await trackOrderEmail(
    {
      workspaceOwnerId,
      orderId,
      templateType: "delivery_rescheduled",
      recipientEmail: contact.email,
      recipientName: contact.name,
      idempotencyKey,
    },
    () =>
      sendOrderRescheduledEmail({
        toEmail: contact.email!,
        orderNumber,
        customerName: contact.name,
        deliveryDateText: details.deliveryDateText,
        idempotencyKey,
      }),
  );
}

type OrderRescheduleJobRow = {
  id: string;
  event_id: string;
  workspace_owner_id: string;
  order_id: string;
  order_number: string;
  tookan_job_id: string | null;
  window_start: string | null;
  window_end: string | null;
  tookan_address_payload: {
    address?: string;
    latitude?: number;
    longitude?: number;
  } | null;
  is_reschedule: boolean;
  planning_completed_at: string | null;
  tookan_completed_at: string | null;
  notification_completed_at: string | null;
};

export async function runOrderRescheduleEffects(
  job: OrderRescheduleJobRow,
): Promise<void> {
  const failures: string[] = [];
  const completeEffect = async (
    column: "planning_completed_at" | "tookan_completed_at" | "notification_completed_at",
    effect: () => Promise<unknown>,
  ) => {
    try {
      await effect();
      await db.query(
        `UPDATE order_reschedule_jobs
            SET ${column} = COALESCE(${column}, now()), updated_at = now()
          WHERE id = $1`,
        [job.id],
      );
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  };

  if (!job.planning_completed_at) {
    await completeEffect("planning_completed_at", async () => {
      if (job.is_reschedule && job.window_start && job.window_end) {
        await recalcScheduleForOrder(
          job.order_id,
          new Date(job.window_start),
          new Date(job.window_end),
        );
      }
    });
  }
  if (!job.tookan_completed_at) {
    await completeEffect("tookan_completed_at", async () => {
      if (!isTookanEnabled()) return;
      await withOrderDestinationLock(job.order_id, async (client) => {
        const canonical = await client.query<{
          tookan_job_id: string | null;
          window_start: string | null;
          delivery_address: {
            address?: unknown;
            latitude?: unknown;
            longitude?: unknown;
            lat?: unknown;
            lng?: unknown;
          } | null;
        }>(
          `SELECT tookan_job_id, window_start, delivery_address
             FROM orders
            WHERE id = $1 AND workspace_owner_id = $2`,
          [job.order_id, job.workspace_owner_id],
        );
        const current = canonical.rows[0];
        if (!current) {
          throw new Error("Order no longer exists in the reschedule job workspace");
        }
        const rawAddress = current.delivery_address;
        const currentAddress = job.tookan_address_payload && rawAddress
          ? {
              address: typeof rawAddress.address === "string"
                ? rawAddress.address
                : undefined,
              latitude: typeof rawAddress.latitude === "number"
                ? rawAddress.latitude
                : typeof rawAddress.lat === "number" ? rawAddress.lat : undefined,
              longitude: typeof rawAddress.longitude === "number"
                ? rawAddress.longitude
                : typeof rawAddress.lng === "number" ? rawAddress.lng : undefined,
            }
          : undefined;
        if (current.tookan_job_id && job.tookan_address_payload) {
          await syncTookanDestinationWithClient(client, job.order_id, job.workspace_owner_id);
          return false;
        }
        if (current.tookan_job_id) {
          await editTookanDeliveryTask(
            current.tookan_job_id,
            current.window_start,
            currentAddress,
          );
          return false;
        }
        return false;
      });
      // Address effects are edits only. A missing task is intentionally left
      // untouched; this path must never create a duplicate Tookan task.
    });
  }
  if (!job.notification_completed_at) {
    await completeEffect("notification_completed_at", async () => {
      if (job.is_reschedule && job.window_start && job.window_end) {
        await notifyOrderRescheduledEmail(
          job.order_id,
          job.order_number,
          job.workspace_owner_id,
          `delivery-rescheduled-${job.event_id}`,
        );
      }
    });
  }

  if (failures.length === 0) {
    await db.query(
      `UPDATE order_reschedule_jobs
          SET status = 'completed', completed_at = now(), locked_at = NULL,
              last_error = NULL, updated_at = now()
        WHERE id = $1`,
      [job.id],
    );
    return;
  }
  await db.query(
    `UPDATE order_reschedule_jobs
        SET status = 'pending', locked_at = NULL, last_error = $2,
            next_attempt_at = now() + INTERVAL '1 minute', updated_at = now()
      WHERE id = $1`,
    [job.id, failures.join("; ").slice(0, 2000)],
  );
  throw new Error(failures.join("; "));
}

async function claimOrderRescheduleJob(
  jobId: string,
): Promise<OrderRescheduleJobRow | null> {
  const claimed = await db.query<OrderRescheduleJobRow>(
    `UPDATE order_reschedule_jobs
        SET status = 'processing', attempts = attempts + 1,
            locked_at = now(), updated_at = now()
      WHERE id = $1
        AND status = 'pending'
        AND next_attempt_at <= now()
      RETURNING *`,
    [jobId],
  );
  return claimed.rows[0] ?? null;
}

let processingRescheduleJobs = false;
export async function processPendingOrderRescheduleJobs(): Promise<void> {
  if (processingRescheduleJobs) return;
  processingRescheduleJobs = true;
  try {
    await db.query(
      `UPDATE order_reschedule_jobs
          SET status = 'pending', locked_at = NULL, updated_at = now()
        WHERE status = 'processing'
          AND locked_at < now() - INTERVAL '10 minutes'`,
    );
    while (true) {
      const claimed = await db.query<OrderRescheduleJobRow>(
        `WITH next_job AS (
           SELECT id FROM order_reschedule_jobs
            WHERE status = 'pending' AND next_attempt_at <= now()
            ORDER BY created_at, id
            LIMIT 1
            FOR UPDATE SKIP LOCKED
         )
         UPDATE order_reschedule_jobs j
            SET status = 'processing', attempts = attempts + 1,
                locked_at = now(), updated_at = now()
           FROM next_job
          WHERE j.id = next_job.id
         RETURNING j.*`,
      );
      const job = claimed.rows[0];
      if (!job) break;
      try {
        await runOrderRescheduleEffects(job);
      } catch (error) {
        logger.warn({ error, jobId: job.id }, "delivery reschedule effects queued for retry");
      }
    }
  } finally {
    processingRescheduleJobs = false;
  }
}

export function startOrderRescheduleWorker(): void {
  void processPendingOrderRescheduleJobs();
  const timer = setInterval(() => {
    void processPendingOrderRescheduleJobs();
  }, 15_000);
  timer.unref?.();
  logger.info("order reschedule worker started");
}

router.get("/orders/:id/reschedule-options", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);
  if (!requireOrderAccess(wreq, res)) return;
  const id = await resolveOrderIdParam(String(req.params.id), wreq.workspaceOwnerId);
  const date = typeof req.query.date === "string" ? req.query.date : "";
  const requestedDeliveryType =
    req.query.delivery_type === "standard" || req.query.delivery_type === "express"
      ? req.query.delivery_type
      : null;
  if (!id || !isValidCalendarDate(date)) {
    res.status(id ? 400 : 404).json({ success: false, error: id ? "A valid date is required" : "Order not found" });
    return;
  }
  const result = await db.query<RescheduleOrderRow>(
    `SELECT id, status, external_order_id, delivery_type, delivery_address,
            window_start, window_end, tookan_job_id
       FROM orders WHERE id = $1 AND workspace_owner_id = $2`,
    [id, wreq.workspaceOwnerId],
  );
  const order = result.rows[0];
  if (!order) {
    res.status(404).json({ success: false, error: "Order not found" });
    return;
  }
  try {
    const context = await resolveRescheduleContext(
      db,
      wreq.workspaceOwnerId,
      requestedDeliveryType ? { ...order, delivery_type: requestedDeliveryType } : order,
      date,
    );
    const slots = [];
    for (const slot of context.slots) {
      const endDate = slot.end_time <= slot.start_time ? addOneDay(date) : date;
      const windowStart = zonedDateTimeToIso(date, slot.start_time, context.timezone);
      const windowEnd = zonedDateTimeToIso(endDate, slot.end_time, context.timezone);
      slots.push({ ...slot, window_start: windowStart, window_end: windowEnd });
    }
    res.json({ success: true, date, timezone: context.timezone, slots });
  } catch (error) {
    const known = error as Error & { status?: number; code?: string };
    if (!known.status) {
      req.log.error(
        {
          err: error,
          orderId: id,
          workspaceOwnerId: wreq.workspaceOwnerId,
          requestedDate: date,
        },
        "Unexpected reschedule-options failure",
      );
    }
    res.status(known.status ?? 500).json({
      success: false,
      code: known.status ? known.code ?? "schedule_unavailable" : "schedule_unavailable",
      error: known.status ? known.message : "Could not load delivery slots",
    });
  }
});

router.post("/orders/:id/reschedule", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);
  if (!requireOrderAccess(wreq, res)) return;
  const parsed = rescheduleOrderSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ success: false, code: "invalid_schedule", error: "Choose a valid delivery date and time" });
    return;
  }
  const id = await resolveOrderIdParam(String(req.params.id), wreq.workspaceOwnerId);
  if (!id) {
    res.status(404).json({ success: false, error: "Order not found" });
    return;
  }
  const actorName = wreq.userId ? await resolveEditorName(wreq.userId) : null;
  const client = await db.connect();
  let changed: {
    order: RescheduleOrderRow;
    previous: { window_start: string | null; window_end: string | null };
    next: { window_start: string; window_end: string };
    timezone: string;
    jobId: string | null;
    eventId: string | null;
  } | null = null;
  try {
    changed = await withTransaction(client, async () => {
      const result = await client.query<RescheduleOrderRow>(
        `SELECT id, status, external_order_id, delivery_type, delivery_address,
                window_start, window_end, tookan_job_id
           FROM orders
          WHERE id = $1 AND workspace_owner_id = $2
          FOR UPDATE`,
        [id, wreq.workspaceOwnerId],
      );
      const order = result.rows[0];
      if (!order) throw Object.assign(new Error("Order not found"), { status: 404, code: "order_not_found" });
      if (
        ["out_for_delivery", "completed", "cancelled"].includes(
          String(order.status).trim().toLowerCase().replace(/[\s-]+/g, "_"),
        )
      ) {
        throw Object.assign(new Error("This order can no longer be rescheduled"), {
          status: 409,
          code: "order_not_reschedulable",
        });
      }
      const proposedOrder: RescheduleOrderRow = {
        ...order,
        delivery_type:
          parsed.data.delivery_type !== undefined
            ? parsed.data.delivery_type
            : order.delivery_type,
        delivery_address:
          parsed.data.delivery_address !== undefined
            ? parsed.data.delivery_address
            : order.delivery_address,
      };
      const context = await resolveRescheduleContext(
        client,
        wreq.workspaceOwnerId,
        proposedOrder,
        parsed.data.date,
      );
      const selected = context.slots.find(
        (slot) =>
          slot.id === parsed.data.slot_id &&
          slot.start_time === parsed.data.start_time &&
          slot.end_time === parsed.data.end_time,
      );
      if (!selected) {
        throw Object.assign(new Error("That delivery slot is no longer available. Choose another slot."), {
          status: 409,
          code: "slot_no_longer_available",
        });
      }
      const endDate = selected.end_time <= selected.start_time ? addOneDay(parsed.data.date) : parsed.data.date;
      const windowStart = zonedDateTimeToIso(parsed.data.date, selected.start_time, context.timezone);
      const windowEnd = zonedDateTimeToIso(endDate, selected.end_time, context.timezone);
      if (
        order.window_start && order.window_end &&
        new Date(order.window_start).toISOString() === windowStart &&
        new Date(order.window_end).toISOString() === windowEnd
      ) return null;

      const address = {
        ...(proposedOrder.delivery_address ?? {}),
        date: parsed.data.date,
        slot: `${selected.start_time}–${selected.end_time}`,
      };
      await client.query(
        `UPDATE orders
            SET window_start = $1, window_end = $2, delivery_address = $3::jsonb,
                delivery_type = $4,
                delivery_date_review = NULL, updated_at = now()
          WHERE id = $5 AND workspace_owner_id = $6`,
        [
          windowStart,
          windowEnd,
          JSON.stringify(address),
          proposedOrder.delivery_type,
          order.id,
          wreq.workspaceOwnerId,
        ],
      );
      await client.query(
        `UPDATE fleet_driver_order_assignments
            SET scheduled_at = $1, updated_at = now()
          WHERE order_id = $2 AND workspace_owner_id = $3`,
        [windowStart, order.id, wreq.workspaceOwnerId],
      );
      const queued = await client.query<{ id: string; event_id: string }>(
        `WITH event AS (
           INSERT INTO order_events
             (workspace_owner_id, order_id, event_type, payload, actor_user_id, actor_name)
           VALUES ($1, $2, 'delivery_rescheduled', $3::jsonb, $4, $5)
           RETURNING id
         )
         INSERT INTO order_reschedule_jobs
           (event_id, workspace_owner_id, order_id, order_number, tookan_job_id,
            window_start, window_end)
         SELECT event.id, $1, $2, $6, $7, $8::timestamptz, $9::timestamptz
           FROM event
         RETURNING id, event_id`,
        [
          wreq.workspaceOwnerId,
          order.id,
          JSON.stringify({
            previous: { window_start: order.window_start, window_end: order.window_end },
            next: { window_start: windowStart, window_end: windowEnd },
            timezone: context.timezone,
          }),
          wreq.userId ?? null,
          actorName,
          order.external_order_id ?? order.id,
          order.tookan_job_id,
          windowStart,
          windowEnd,
        ],
      );
      return {
        order,
        previous: { window_start: order.window_start, window_end: order.window_end },
        next: { window_start: windowStart, window_end: windowEnd },
        timezone: context.timezone,
        jobId: queued.rows[0]?.id ?? null,
        eventId: queued.rows[0]?.event_id ?? null,
      };
    });
  } catch (error) {
    const known = error as Error & { status?: number; code?: string };
    if (!known.status) {
      req.log.error(
        {
          err: error,
          orderId: id,
          workspaceOwnerId: wreq.workspaceOwnerId,
          requestedDate: parsed.data.date,
          requestedSlotId: parsed.data.slot_id ?? null,
          requestedStartTime: parsed.data.start_time,
          requestedEndTime: parsed.data.end_time,
        },
        "Unexpected order reschedule failure",
      );
    }
    res.status(known.status ?? 500).json({
      success: false,
      code: known.status ? known.code ?? "reschedule_failed" : "reschedule_failed",
      error: known.status ? known.message : "Could not reschedule delivery",
    });
    return;
  } finally {
    client.release();
  }

  if (changed) {
    const eventId =
      changed.eventId ??
      `${changed.order.id}-${changed.next.window_start}`;
    const fallbackJob: OrderRescheduleJobRow = {
      id: changed.jobId ?? eventId,
      event_id: eventId,
      workspace_owner_id: wreq.workspaceOwnerId,
      order_id: changed.order.id,
      order_number: changed.order.external_order_id ?? changed.order.id,
      tookan_job_id: changed.order.tookan_job_id,
      window_start: changed.next.window_start,
      window_end: changed.next.window_end,
      tookan_address_payload: null,
      is_reschedule: true,
      planning_completed_at: null,
      tookan_completed_at: null,
      notification_completed_at: null,
    };
    const claimedJob = changed.jobId
      ? await claimOrderRescheduleJob(changed.jobId)
      : fallbackJob;
    if (claimedJob) {
      await runOrderRescheduleEffects(claimedJob).catch((error) => {
        req.log.warn({ orderId: changed?.order.id, error }, "delivery reschedule effects queued for retry");
      });
    }
  }
  res.json({ success: true, changed: changed !== null });
});

// Columns updated directly on the orders table (allowlist; values parameterized).
const ORDER_COLUMN_KEYS = [
  "status",
  "ordered_at",
  "window_start",
  "window_end",
  "delivery_type",
  "delivery_address",
  "delivery_instructions",
  "card_to",
  "card_message",
  "card_from",
  "qr_link",
  "is_sensitive_occasion",
] as const;

// Columns stored as a single row in order_notes (upserted on order_id).
const NOTE_COLUMN_KEYS = [
  "customer_note",
  "florist_note",
  "driver_note",
  "internal_note",
] as const;

router.patch("/orders/:id", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);
  if (!requireOrderAccess(wreq, res)) return;
  const { id } = req.params;

  const parsed = updateOrderSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: parsed.error.issues.map((i) => i.message).join("; "),
    });
    return;
  }
  const data = parsed.data;

  if (Object.keys(data).length === 0) {
    res.status(400).json({ success: false, error: "No fields to update" });
    return;
  }
  if (
    (data.window_start !== undefined || data.window_end !== undefined) &&
    (data.window_start !== null || data.window_end !== null)
  ) {
    res.status(409).json({
      success: false,
      code: "use_reschedule_endpoint",
      error: "Use the delivery reschedule action to change the delivery window",
    });
    return;
  }

  // Confirm the order exists in this workspace and capture the current status
  // so the webhook only fires when status actually changes.
  const existing = await db.query<{
    id: string;
    status: string;
    external_order_id: string | null;
    tookan_job_id: string | null;
    tookan_status: string | null;
    tookan_error: string | null;
    payment_status: string | null;
    delivery_address: Record<string, unknown> | null;
  }>(
    `SELECT o.id, o.status, o.external_order_id, o.tookan_job_id,
            o.tookan_status, o.tookan_error,
            p.status AS payment_status, o.delivery_address
       FROM orders o
  LEFT JOIN order_payment p ON p.order_id = o.id
      WHERE o.id = $1 AND o.workspace_owner_id = $2 LIMIT 1`,
    [id, wreq.workspaceOwnerId],
  );
  if (existing.rowCount === 0) {
    res.status(404).json({ success: false, error: "Order not found" });
    return;
  }
  const previousStatus = existing.rows[0].status;
  const isRefundedStatusChange =
    data.status !== undefined &&
    previousStatus === "refunded" &&
    data.status !== "refunded";

  if (isRefundedStatusChange && !(await hasOwnerAdminOrOps2Access(wreq))) {
    res.status(403).json({
      success: false,
      error: "Only workspace owners, admins, or Ops 2 members can change refunded orders",
    });
    return;
  }

  // Same paid-before-processing rule as the dedicated status route: the
  // general edit route must not be a side door for advancing unpaid orders
  // into fulfillment.
  if (
    !isRefundedStatusChange &&
    data.status === "processing" &&
    previousStatus !== "processing" &&
    (existing.rows[0].payment_status ?? "").toLowerCase() !== "paid"
  ) {
    res.status(409).json({
      success: false,
      code: "payment_not_paid",
      error: "Order must be marked as paid before it can move to Processing",
    });
    return;
  }

  const addressChanged =
    data.delivery_address !== undefined
    && !tookanDestinationsEqual(existing.rows[0].delivery_address, data.delivery_address);

  // --- Update editable columns on the orders table (status handled separately) ---
  const orderCols = ORDER_COLUMN_KEYS.filter((k) => k !== "status" && data[k] !== undefined);
  if (orderCols.length > 0) {
    const setParts: string[] = [];
    const params: unknown[] = [];
    for (const col of orderCols) {
      const value = data[col];
      if (col === "delivery_address") {
        params.push(value === null ? null : JSON.stringify(value));
        setParts.push(`${col} = $${params.length}::jsonb`);
      } else {
        params.push(value);
        setParts.push(`${col} = $${params.length}`);
      }
    }
    setParts.push(`updated_at = now()`);
    params.push(id, wreq.workspaceOwnerId);
    await db.query(
      `UPDATE orders SET ${setParts.join(", ")}
        WHERE id = $${params.length - 1} AND workspace_owner_id = $${params.length}`,
      params,
    );

    // Sensitive-occasion toggled ON: suppress any still-pending Trustpilot
    // invitation so it can never send. (Toggling OFF does not auto-requeue;
    // staff can use the explicit retry action on the Trustpilot card.)
    if (data.is_sensitive_occasion === true) {
      await db.query(
        `UPDATE trustpilot_invitations
            SET status = 'skipped', last_error = $3, updated_at = now()
          WHERE order_id = $1 AND workspace_owner_id = $2 AND status = 'pending'`,
        [id, wreq.workspaceOwnerId, SENSITIVE_SUPPRESSION_MESSAGE],
      );
      recordOrderEvent({
        workspaceOwnerId: wreq.workspaceOwnerId,
        orderId: String(id),
        eventType: "sensitive_occasion_flagged",
        payload: {},
        actorUserId: wreq.userId,
      });
    } else if (data.is_sensitive_occasion === false) {
      recordOrderEvent({
        workspaceOwnerId: wreq.workspaceOwnerId,
        orderId: String(id),
        eventType: "sensitive_occasion_unflagged",
        payload: {},
        actorUserId: wreq.userId,
      });
    }

    // Address Collector: delivery-window changes re-plan any pending outreach
    // for the order's active collection request. Best-effort, never blocks.
    if (data.window_start !== undefined || data.window_end !== undefined) {
      const ws = await db.query<{ window_start: string | null; window_end: string | null }>(
        `SELECT window_start, window_end FROM orders WHERE id = $1 AND workspace_owner_id = $2`,
        [id, wreq.workspaceOwnerId],
      );
      const row = ws.rows[0];
      if (row) {
        void recalcScheduleForOrder(
          String(id),
          row.window_start ? new Date(row.window_start) : null,
          row.window_end ? new Date(row.window_end) : null,
        ).catch(() => {});
      }
    }
  }

  // --- Upsert the single order_notes row ---
  const noteCols = NOTE_COLUMN_KEYS.filter((k) => data[k] !== undefined);
  if (noteCols.length > 0) {
    const insertCols = ["order_id", ...noteCols];
    const placeholders = insertCols.map((_, i) => `$${i + 1}`);
    const updateSet = noteCols.map((c) => `${c} = EXCLUDED.${c}`);
    const params = [id, ...noteCols.map((c) => data[c])];
    await db.query(
      `INSERT INTO order_notes (${insertCols.join(", ")})
       VALUES (${placeholders.join(", ")})
       ON CONFLICT (order_id) DO UPDATE SET ${updateSet.join(", ")}`,
      params,
    );
  }

  // --- Re-fetch the updated order row for the response ---
  const updated = await db.query(
    `SELECT o.*,
            n.customer_note, n.florist_note, n.driver_note, n.internal_note
       FROM orders o
       LEFT JOIN order_notes n ON n.order_id = o.id
      WHERE o.id = $1 AND o.workspace_owner_id = $2
      LIMIT 1`,
    [id, wreq.workspaceOwnerId],
  );
  const order = updated.rows[0];

  if (data.status !== undefined && data.status !== previousStatus) {
    const transition = await transitionOrderStatus(db, {
      orderId: String(id),
      newStatus: data.status,
      workspaceOwnerId: wreq.workspaceOwnerId,
      actorUserId: wreq.userId,
      restoreRefundedPayment: isRefundedStatusChange,
      allowedFromStatuses: [previousStatus],
    });
    if (!transition.success) {
      req.log.error({ orderId: id, transition }, "orderStatusTransition failed in PATCH /orders/:id");
      res.status(409).json({
        success: false,
        code: transition.error?.code ?? "transition_failed",
        error:
          transition.error?.code === "REFUNDED_PAYMENT_NOT_FOUND"
            ? "Cannot change a refunded order without its payment record"
            : "Inventory posting failed",
        detail: transition.error?.detail,
      });
      return;
    }
    if (transition.skipped) {
      res.status(409).json({
        success: false,
        code: "order_status_changed",
        error: "The order status changed while you were updating it. Reload and try again.",
      });
      return;
    }
    if (order && isRefundedStatusChange) {
      order.status = transition.newStatus;
    }
    recordOrderEvent({
      workspaceOwnerId: wreq.workspaceOwnerId,
      orderId: String(id),
      eventType: "status_changed",
      payload: { from: previousStatus, to: data.status },
      actorUserId: wreq.userId,
    });
    if (isRefundedStatusChange) {
      recordOrderEvent({
        workspaceOwnerId: wreq.workspaceOwnerId,
        orderId: String(id),
        eventType: "refunded_order_restored",
        payload: {
          from_order_status: previousStatus,
          from_payment_status: transition.previousPaymentStatus,
          to_order_status: transition.newStatus,
          to_payment_status: "paid",
          scope: "local_only",
        },
        actorUserId: wreq.userId,
      });
    }
    void fireWebhookEvent("order.status_updated", wreq.workspaceOwnerId, {
      orderId: id,
      appOrderId: existing.rows[0].external_order_id ?? null,
      status: data.status,
      updatedAt: new Date().toISOString(),
    });
    void notifyOrderStatusEmail(
      String(id),
      existing.rows[0].external_order_id ?? String(id),
      data.status,
      wreq.workspaceOwnerId,
    );
    if (data.status === "completed") {
      void enqueueDeliveredWhatsappNotification(
        String(id),
        existing.rows[0].external_order_id ?? String(id),
        wreq.workspaceOwnerId,
      );
    } else {
      void notifyOrderStatusWhatsApp(
        String(id),
        existing.rows[0].external_order_id ?? String(id),
        data.status,
        wreq.workspaceOwnerId,
      );
    }
    req.log.warn({ orderId: id, newStatus: data.status }, "tookan: status change detected; Tookan task sync not yet implemented");
  }

  // --- Sync a rescheduled delivery window to the existing Tookan task ---
  // Best-effort: only when the window changed, Tookan is enabled, and the order
  // already has a Tookan task. Failures are logged but never block the OS save.
  const windowChanged =
    data.window_start !== undefined || data.window_end !== undefined;
  const tookanJobId = existing.rows[0].tookan_job_id;
  if (windowChanged && tookanJobId && isTookanEnabled()) {
    const newWindowStart =
      (order?.window_start as string | null | undefined) ?? null;
    void editTookanDeliveryTask(tookanJobId, newWindowStart).catch((err) => {
      req.log.warn(
        { orderId: id, tookanJobId, err },
        "tookan: failed to sync rescheduled delivery time to Tookan",
      );
    });
  }

  // --- Auto-retry Tookan task creation when the missing address arrives ---
  // Best-effort: a manual order whose Tookan sync was skipped for lack of a
  // delivery address gets its task created automatically as soon as staff save
  // an address on the order. Failures land back in tookan_status='failed' (via
  // retryTookanDeliveryTask's own persistence) so the Retry button still works.
  if (
    data.delivery_address != null &&
    !existing.rows[0].tookan_job_id &&
    existing.rows[0].tookan_status === "failed" &&
    existing.rows[0].tookan_error === TOOKAN_MISSING_ADDRESS_ERROR &&
    isTookanEnabled()
  ) {
    void retryTookanDeliveryTask(String(id), wreq.workspaceOwnerId).catch((err) => {
      req.log.warn(
        { orderId: id, err },
        "tookan: auto-retry after address save failed; order remains retryable",
      );
    });
  }

  if (addressChanged) {
    void syncTookanDestinationForOrder(String(id), wreq.workspaceOwnerId).catch((err) => {
      req.log.warn(
        { orderId: id, workspaceOwnerId: wreq.workspaceOwnerId, err },
        "tookan: failed to sync order destination after address save",
      );
    });
  }

  // Reconcile the canonical Place and its delivery-contact association after an
  // address edit. The linker only reads the just-saved order snapshot and never
  // mutates it, so this remains safe as a best-effort post-save side effect.
  if (data.delivery_address !== undefined) {
    if (hasUsableDeliveryAddress(data.delivery_address)) {
      await finalizeAddressCollectionForOrder(db, {
        orderId: String(id),
        workspaceOwnerId: wreq.workspaceOwnerId,
        outcome: "manual_resolution",
        reason: "Delivery address supplied by staff",
        source: "order_edit",
        actor: wreq.userId ? `user:${wreq.userId}` : "ops",
      });
    }
    void linkOrderToAddressBook(String(id), wreq.workspaceOwnerId, data.delivery_address);
  }

  res.json({ success: true, order });
});

// ── Edit the customer / recipient contact records linked to an order ────────
const contactNameField = z.string().max(300).nullable().optional();
const contactPhoneField = z.string().max(100).nullable().optional();

const updateOrderContactsSchema = z
  .object({
    customer: z
      .object({
        name: contactNameField,
        email: z.string().max(300).nullable().optional(),
        phone: contactPhoneField,
      })
      .strict()
      .optional(),
    recipient: z
      .object({
        name: contactNameField,
        phone: contactPhoneField,
      })
      .strict()
      .optional(),
  })
  .strict();

function trimToNull(v: string | null | undefined): string | null {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
}

/** True for a Postgres unique violation on the contacts email/phone index. */
function isContactUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; constraint?: string };
  return (
    e.code === "23505" &&
    typeof e.constraint === "string" &&
    (e.constraint.includes("email") || e.constraint.includes("phone"))
  );
}

/**
 * Apply an edit to a single linked contact (or create + link one when the role
 * has no contact yet). Only the fields present in the request body are written.
 * `email` is omitted for the recipient role. Throws on a unique violation so the
 * route can translate it into a 409.
 */
async function applyContactEdit(opts: {
  workspaceOwnerId: string;
  orderId: string;
  role: "customer" | "recipient";
  contactId: string | null;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
}): Promise<void> {
  const setName = opts.name !== undefined;
  const setEmail = opts.email !== undefined;
  const setPhone = opts.phone !== undefined;

  const nameVal = setName ? trimToNull(opts.name) : undefined;
  const emailVal = setEmail ? (trimToNull(opts.email)?.toLowerCase() ?? null) : undefined;
  const phoneVal = setPhone ? normalizePhone(opts.phone) : undefined;

  if (opts.contactId) {
    const setParts: string[] = [];
    const params: unknown[] = [];
    if (setName) {
      params.push(nameVal);
      setParts.push(`display_name = $${params.length}`);
    }
    if (setEmail) {
      params.push(emailVal);
      setParts.push(`email = $${params.length}`);
    }
    if (setPhone) {
      params.push(phoneVal);
      setParts.push(`phone = $${params.length}`);
    }
    if (setParts.length === 0) return;
    setParts.push(`updated_at = now()`);
    params.push(opts.contactId, opts.workspaceOwnerId);
    await db.query(
      `UPDATE contacts SET ${setParts.join(", ")}
        WHERE id = $${params.length - 1} AND workspace_owner_id = $${params.length}`,
      params,
    );
    if (setPhone && phoneVal) {
      void syncContactToRespondIo(opts.contactId).catch((err: unknown) => {
        logger.warn({ err, contactId: opts.contactId }, "respondio: order contact sync failed");
      });
    }
    // Name or phone (country-context) changes can affect the inferred gender.
    if (setName || setPhone) queueGenderInference(opts.contactId);
    return;
  }

  // No contact linked for this role yet — create one and link it, but only if
  // the caller actually provided some value to store.
  if (!nameVal && !emailVal && !phoneVal) return;
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO contacts
       (workspace_owner_id, source, is_guest, display_name, email, phone, updated_at)
     VALUES ($1, 'manual', true, $2, $3, $4, now())
     RETURNING id`,
    [opts.workspaceOwnerId, nameVal ?? null, emailVal ?? null, phoneVal ?? null],
  );
  const newId = inserted.rows[0]?.id;
  if (!newId) return;
  await db.query(
    `INSERT INTO order_contacts (order_id, contact_id, role) VALUES ($1, $2, $3)`,
    [opts.orderId, newId, opts.role],
  );
  if (phoneVal) {
    void syncContactToRespondIo(newId).catch((err: unknown) => {
      logger.warn({ err, contactId: newId }, "respondio: order contact sync failed");
    });
  }
  queueGenderInference(newId);
}

/** Best-effort resolve a Clerk user's display name for the audit snapshot. */
async function resolveEditorName(userId: string): Promise<string | null> {
  if (!userId) return null;
  try {
    const user = await clerkClient.users.getUser(userId);
    const parts = [user.firstName, user.lastName].filter(Boolean);
    if (parts.length > 0) return parts.join(" ");
    return user.primaryEmailAddress?.emailAddress ?? null;
  } catch (err) {
    logger.warn({ err, userId }, "Failed to resolve Clerk name for order contact edit");
    return null;
  }
}

type ContactEditRow = {
  role: string;
  edited_by_user_id: string;
  edited_by_name: string | null;
  edited_at: string;
};

/**
 * Return the most-recent contact edit per role (customer / recipient) for an
 * order, used to surface "last edited by X at Y" on the order detail.
 */
async function fetchLatestContactEdits(orderId: string): Promise<ContactEditRow[]> {
  const result = await db.query<ContactEditRow>(
    `SELECT DISTINCT ON (role) role, edited_by_user_id, edited_by_name, edited_at
       FROM order_contact_edits
      WHERE order_id = $1
      ORDER BY role, edited_at DESC`,
    [orderId],
  );
  return result.rows;
}

router.patch("/orders/:id/contacts", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);
  if (!requireOrderAccess(wreq, res)) return;
  const { id } = req.params;

  const parsed = updateOrderContactsSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: parsed.error.issues.map((i) => i.message).join("; "),
    });
    return;
  }
  const data = parsed.data;
  if (!data.customer && !data.recipient) {
    res.status(400).json({ success: false, error: "No fields to update" });
    return;
  }

  const existing = await db.query<{ id: string }>(
    `SELECT id FROM orders WHERE id = $1 AND workspace_owner_id = $2 LIMIT 1`,
    [id, wreq.workspaceOwnerId],
  );
  if (existing.rowCount === 0) {
    res.status(404).json({ success: false, error: "Order not found" });
    return;
  }

  const linked = await db.query<{ role: string; contact_id: string }>(
    `SELECT role, contact_id FROM order_contacts
      WHERE order_id = $1 AND role = ANY($2::text[])`,
    [id, ["customer", "recipient"]],
  );
  const contactIdByRole = new Map<string, string>();
  for (const row of linked.rows) contactIdByRole.set(row.role, row.contact_id);

  try {
    if (data.customer) {
      await applyContactEdit({
        workspaceOwnerId: wreq.workspaceOwnerId,
        orderId: String(id),
        role: "customer",
        contactId: contactIdByRole.get("customer") ?? null,
        name: data.customer.name,
        email: data.customer.email,
        phone: data.customer.phone,
      });
    }
    if (data.recipient) {
      await applyContactEdit({
        workspaceOwnerId: wreq.workspaceOwnerId,
        orderId: String(id),
        role: "recipient",
        contactId: contactIdByRole.get("recipient") ?? null,
        name: data.recipient.name,
        phone: data.recipient.phone,
      });
    }
  } catch (err) {
    if (isContactUniqueViolation(err)) {
      res.status(409).json({
        success: false,
        error: "That email or phone number already belongs to another contact.",
      });
      return;
    }
    throw err;
  }

  // Record an audit row per edited role (append-only) so the order detail can
  // surface "last edited by X at Y" for the Customer / Recipient sections.
  const editedRoles: Array<"customer" | "recipient"> = [];
  if (data.customer) editedRoles.push("customer");
  if (data.recipient) editedRoles.push("recipient");
  if (editedRoles.length > 0) {
    const editorName = await resolveEditorName(wreq.userId);
    for (const role of editedRoles) {
      await db.query(
        `INSERT INTO order_contact_edits
           (workspace_owner_id, order_id, role, edited_by_user_id, edited_by_name)
         VALUES ($1, $2, $3, $4, $5)`,
        [wreq.workspaceOwnerId, String(id), role, wreq.userId, editorName],
      );
    }
  }

  // A recipient may be added after an address was already saved. Re-run the
  // address-book linker so the recipient (preferred over the gift sender) gains
  // the existing canonical Place association without touching that snapshot.
  void linkOrderToAddressBook(String(id), wreq.workspaceOwnerId, null, {
    readStoredAddress: true,
  });

  const contacts = await db.query(
    `SELECT oc.role, c.id AS contact_id, c.first_name, c.last_name,
            c.display_name, c.email, c.phone
       FROM order_contacts oc
       JOIN contacts c ON c.id = oc.contact_id
      WHERE oc.order_id = $1`,
    [id],
  );

  const contactEdits = await fetchLatestContactEdits(String(id));

  res.json({ success: true, contacts: contacts.rows, contact_edits: contactEdits });
});

// ── Orders-page access: hard delete an order and all its child rows ─────────
router.delete("/orders/:id", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);
  if (!requireOrderAccess(wreq, res)) return;
  // Deletion is destructive (removes line items, notes, payments, contacts) —
  // require an elevated workspace role beyond plain orders-page access.
  if (!(await hasOwnerAdminOrOps2Access(wreq))) {
    res.status(403).json({
      success: false,
      error: "Only workspace owners, admins, or Ops 2 members can delete orders",
    });
    return;
  }
  const { id } = req.params;

  const existing = await db.query<{ id: string }>(
    `SELECT id FROM orders WHERE id = $1 AND workspace_owner_id = $2 LIMIT 1`,
    [id, wreq.workspaceOwnerId],
  );
  if (existing.rowCount === 0) {
    res.status(404).json({ success: false, error: "Order not found" });
    return;
  }

  const client = await db.connect();
  try {
    await withTransaction(client, async () => {
      await finalizeAddressCollectionForOrder(client, {
        orderId: String(id),
        workspaceOwnerId: wreq.workspaceOwnerId,
        outcome: "order_deleted",
        reason: "Parent order was deleted",
        source: "order_hard_delete",
        actor: wreq.userId,
      });
      // Detach/remove fleet assignments (order_id FK is ON DELETE SET NULL, so
      // the rows would otherwise be left orphaned). Proof-of-delivery rows
      // cascade-delete from the assignment.
      await client.query(
        `DELETE FROM fleet_driver_order_assignments WHERE order_id = $1`,
        [id],
      );
      // The remaining child tables reference orders.id with ON DELETE CASCADE,
      // but we delete them explicitly so the contract is clear and order-safe.
      await client.query(`DELETE FROM order_line_items WHERE order_id = $1`, [id]);
      await client.query(`DELETE FROM order_notes WHERE order_id = $1`, [id]);
      await client.query(`DELETE FROM order_payment WHERE order_id = $1`, [id]);
      await client.query(`DELETE FROM order_contacts WHERE order_id = $1`, [id]);
      await client.query(
        `DELETE FROM orders WHERE id = $1 AND workspace_owner_id = $2`,
        [id, wreq.workspaceOwnerId],
      );
    });
  } finally {
    client.release();
  }

  res.json({ success: true });
});

// ── Restore a fully-refunded order's local state for authorized recovery ──────
router.post(
  "/orders/:id/restore-refunded",
  async (req: Request, res: Response): Promise<void> => {
    const wreq = workspace(req);
    const params = RestoreRefundedOrderParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: params.error.message });
      return;
    }

    if (!(await hasOwnerAdminOrOps2Access(wreq))) {
      res.status(403).json({
        success: false,
        error: "Only workspace owners, admins, or Ops 2 members can restore refunded orders",
      });
      return;
    }

    const { id } = params.data;
    const actorName = wreq.userId ? await resolveEditorName(wreq.userId) : null;
    const client = await db.connect();
    let outcome: "not_found" | "not_refunded" | "restored" = "not_found";

    try {
      await withTransaction(client, async () => {
        const orderResult = await client.query<{ id: string; status: string }>(
          `SELECT id, status
             FROM orders
            WHERE id = $1 AND workspace_owner_id = $2
            FOR UPDATE`,
          [id, wreq.workspaceOwnerId],
        );
        const order = orderResult.rows[0];
        if (!order) {
          outcome = "not_found";
          return;
        }

        const paymentResult = await client.query<{ status: string }>(
          `SELECT status
             FROM order_payment
            WHERE order_id = $1
            FOR UPDATE`,
          [id],
        );
        const payment = paymentResult.rows[0];
        if (order.status !== "refunded" || payment?.status !== "refunded") {
          outcome = "not_refunded";
          return;
        }

        // Preserve the original paid_at, refund amounts, provider reference,
        // and every other payment field. This is a local status correction only.
        const paymentUpdate = await client.query(
          `UPDATE order_payment
              SET status = 'paid', updated_at = now()
            WHERE order_id = $1 AND status = 'refunded'`,
          [id],
        );
        if (paymentUpdate.rowCount !== 1) {
          throw new Error("Refunded order payment changed during recovery");
        }

        const orderUpdate = await client.query(
          `UPDATE orders
              SET status = 'processing', updated_at = now()
            WHERE id = $1 AND workspace_owner_id = $2 AND status = 'refunded'`,
          [id, wreq.workspaceOwnerId],
        );
        if (orderUpdate.rowCount !== 1) {
          throw new Error("Refunded order changed during recovery");
        }

        await client.query(
          `INSERT INTO order_events
             (workspace_owner_id, order_id, event_type, payload, actor_user_id, actor_name)
           VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
          [
            wreq.workspaceOwnerId,
            id,
            "refunded_order_restored",
            JSON.stringify({
              from_order_status: order.status,
              from_payment_status: payment.status,
              to_order_status: "processing",
              to_payment_status: "paid",
              scope: "local_only",
            }),
            wreq.userId,
            actorName,
          ],
        );
        outcome = "restored";
      });
    } finally {
      client.release();
    }

    if (outcome === "not_found") {
      res.status(404).json({ success: false, error: "Order not found" });
      return;
    }
    if (outcome === "not_refunded") {
      res.status(409).json({
        success: false,
        error: "Only orders with both order and payment status fully refunded can be restored",
      });
      return;
    }

    req.log.info(
      { orderId: id, userId: wreq.userId, action: "order.restore_refunded" },
      "Refunded order restored locally",
    );
    res.json(
      RestoreRefundedOrderResponse.parse({
        success: true,
        order: { id, status: "processing" },
        payment: { status: "paid" },
      }),
    );
  },
);

// ── Manually mark an order as paid (e.g. after a Whish transfer) ─────────────
// Owner or anyone with `orders` page access. Upserts the order_payment row to
// paid, then best-effort fires a customer "payment received" confirmation email.
router.post("/orders/:id/mark-paid", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);
  if (!requireOrderAccess(wreq, res)) return;
  const { id } = req.params;

  const orderResult = await db.query<{
    id: string;
    status: string;
    external_order_id: string | null;
    display_order_number: string | null;
    payment_status: string | null;
    tookan_job_id: string | null;
    tookan_status: string | null;
  }>(
    `SELECT o.id, o.status, o.external_order_id, o.display_order_number,
            o.tookan_job_id, o.tookan_status,
            p.status AS payment_status
       FROM orders o
  LEFT JOIN order_payment p ON p.order_id = o.id
      WHERE o.id = $1 AND o.workspace_owner_id = $2
      LIMIT 1`,
    [id, wreq.workspaceOwnerId],
  );

  if (orderResult.rowCount === 0) {
    res.status(404).json({ success: false, error: "Order not found" });
    return;
  }

  const order = orderResult.rows[0];
  const paymentStatus = (order.payment_status ?? "").toLowerCase();

  if (order.status === "refunded" || paymentStatus === "refunded") {
    res.status(409).json({ success: false, error: "This order has been refunded" });
    return;
  }
  if (paymentStatus === "paid") {
    res.status(409).json({ success: false, error: "This order is already marked as paid" });
    return;
  }

  await db.query(
    `INSERT INTO order_payment (order_id, status, paid_at)
          VALUES ($1, 'paid', now())
     ON CONFLICT (order_id)
     DO UPDATE SET status = 'paid',
                   paid_at = now(),
                   whish_instructions_claimed_at = NULL,
                   whish_instructions_claim_token = NULL,
                   updated_at = now()`,
    [id],
  );

  // Keep the linked CMC Sales record (CMC New Order → workflow_type='order')
  // in sync: once paid, it counts toward the paid-only audit totals.
  await db.query(
    `UPDATE cmc_sales
        SET status = 'paid', updated_at = now()
      WHERE order_id = $1 AND workspace_owner_id = $2 AND workflow_type = 'order'`,
    [id, wreq.workspaceOwnerId],
  );

  // Auto-advance a freshly-paid order into fulfillment. Only a still-`pending`
  // order is moved to `processing`; orders already further along (or paused/
  // cancelled) keep their current status so payment never regresses progress.
  const statusResult = await db.query(
    `UPDATE orders
        SET status = 'processing', updated_at = now()
      WHERE id = $1 AND workspace_owner_id = $2 AND status = 'pending'`,
    [id, wreq.workspaceOwnerId],
  );
  const statusAdvanced = (statusResult.rowCount ?? 0) > 0;

  recordOrderEvent({
    workspaceOwnerId: wreq.workspaceOwnerId,
    orderId: String(id),
    eventType: "payment_marked_paid",
    payload: statusAdvanced ? { status_advanced_to: "processing" } : null,
    actorUserId: wreq.userId,
  });
  if (statusAdvanced) {
    recordOrderEvent({
      workspaceOwnerId: wreq.workspaceOwnerId,
      orderId: String(id),
      eventType: "status_changed",
      payload: { from: "pending", to: "processing" },
      actorUserId: wreq.userId,
    });
    void createAutomaticAddressCollectionRequest({
      workspaceOwnerId: wreq.workspaceOwnerId,
      orderId: String(id),
    }).catch((err) => {
      req.log.warn(
        { err, orderId: id },
        "addressCollector: automatic request creation after mark-paid failed",
      );
    });
  }

  // Attributable activity record, consistent with how the refund route records
  // the payment-state change (structured log + best-effort customer email).
  req.log.info(
    {
      orderId: id,
      userId: wreq.userId,
      action: "order.mark_paid",
      statusAdvancedToProcessing: statusAdvanced,
    },
    "Order manually marked as paid",
  );

  const orderNumber =
    order.display_order_number ?? order.external_order_id ?? String(id);

  // A Whish order whose Tookan task was deferred at creation time
  // (tookan_status='awaiting_payment') gets its delivery task created now that
  // payment is confirmed. Fire-and-forget: the retry helper persists success
  // (tookan_status='created' + job id/payload) or failure
  // (tookan_status='failed', so the dashboard Retry button works) exactly like
  // the ingest-time path. The tookan_job_id guard makes this idempotent — an
  // order already pushed to Tookan never gets a duplicate task.
  if (
    isTookanEnabled() &&
    !order.tookan_job_id &&
    order.tookan_status === "awaiting_payment"
  ) {
    void retryTookanDeliveryTask(String(id), wreq.workspaceOwnerId).catch((err) => {
      req.log.warn(
        { err, orderId: id },
        "tookan: task creation after mark-paid failed; order lands in 'failed' state for manual retry",
      );
    });
  }

  // Best-effort customer confirmation — never blocks the response.
  void (async () => {
    try {
      const customer = await lookupOrderCustomerContact(String(id));
      await trackOrderEmail(
        {
          workspaceOwnerId: wreq.workspaceOwnerId,
          orderId: String(id),
          templateType: "payment_received",
          recipientName: customer.name,
          recipientEmail: customer.email,
          triggeredByUserId: wreq.userId,
        },
        async () => {
          const details = await lookupOrderEmailDetails(String(id), wreq.workspaceOwnerId);
          return sendOrderPaymentReceivedEmail({
            toEmail: customer.email!,
            orderNumber,
            customerName: customer.name,
            items: details.items,
            amountPaidText: details.amountPaidText,
            deliveryDateText: details.deliveryDateText,
          });
        },
      );
    } catch (err) {
      req.log.warn({ err, orderId: id }, "Failed to send payment received email");
    }
  })();

  res.json({ success: true });
});

// ── Send Whish payment instructions to the order's customer ─────────────────
// Owner or anyone with `orders` page access. Emails the customer the Whish
// account number plus the amount due. Returns success with `emailed: false`
// (still HTTP 200) when no customer email is on file.
router.post(
  "/orders/:id/send-payment-instructions",
  async (req: Request, res: Response): Promise<void> => {
    const wreq = workspace(req);
    if (!requireOrderAccess(wreq, res)) return;
    const { id } = req.params;

    const orderResult = await db.query<{
      id: string;
      external_order_id: string | null;
      display_order_number: string | null;
    }>(
      `SELECT id, external_order_id, display_order_number
         FROM orders
        WHERE id = $1 AND workspace_owner_id = $2
        LIMIT 1`,
      [id, wreq.workspaceOwnerId],
    );

    if (orderResult.rowCount === 0) {
      res.status(404).json({ success: false, error: "Order not found" });
      return;
    }

    const order = orderResult.rows[0];
    const orderNumber =
      order.display_order_number ?? order.external_order_id ?? String(id);

    const customer = await lookupOrderCustomerContact(String(id));
    if (!customer.email) {
      await trackOrderEmail(
        {
          workspaceOwnerId: wreq.workspaceOwnerId,
          orderId: String(id),
          templateType: "payment_instructions",
          recipientName: customer.name,
          recipientEmail: null,
          triggeredByUserId: wreq.userId,
        },
        async () => {
          throw new Error("unreachable — no recipient email");
        },
      );
      res.json({ success: true, emailed: false });
      return;
    }

    await trackOrderEmail(
      {
        workspaceOwnerId: wreq.workspaceOwnerId,
        orderId: String(id),
        templateType: "payment_instructions",
        recipientName: customer.name,
        recipientEmail: customer.email,
        triggeredByUserId: wreq.userId,
      },
      async () => {
        const details = await lookupOrderEmailDetails(String(id), wreq.workspaceOwnerId);
        return sendOrderPaymentInstructionsEmail({
          toEmail: customer.email!,
          orderNumber,
          customerName: customer.name,
          amountDueText: details.amountPaidText,
          items: details.items,
          deliveryDateText: details.deliveryDateText,
        });
      },
    );

    req.log.info(
      { orderId: id, userId: wreq.userId, action: "order.send_payment_instructions" },
      "Sent Whish payment instructions to customer",
    );

    res.json({ success: true, emailed: true });
  },
);

// ── Resend Whish payment instructions by WhatsApp ───────────────────────────
// This is deliberately separate from the legacy email action above. It never
// changes payment status or order fulfillment; it only creates one new,
// serialized Respond.io template attempt for an eligible Whish order.
router.post(
  "/orders/:id/resend-whish-payment-instructions",
  async (req: Request, res: Response): Promise<void> => {
    const wreq = workspace(req);
    if (!requireOrderAccess(wreq, res)) return;
    const id = await resolveOrderIdParam(String(req.params.id), wreq.workspaceOwnerId);
    if (!id) {
      res.status(404).json({ success: false, error: "Order not found" });
      return;
    }

    const paymentResult = await db.query<{
      method: string | null;
      provider: string | null;
      status: string | null;
    }>(
      `SELECT p.method, p.provider, p.status
         FROM orders o
    LEFT JOIN order_payment p ON p.order_id = o.id
        WHERE o.id = $1 AND o.workspace_owner_id = $2
        LIMIT 1`,
      [id, wreq.workspaceOwnerId],
    );
    const payment = paymentResult.rows[0];
    if (
      !payment ||
      !isWhishPayment(payment.method, payment.provider) ||
      ["paid", "refunded"].includes((payment.status ?? "").toLowerCase())
    ) {
      res.status(409).json({
        success: false,
        sent: false,
        error: "Whish payment instructions are only available for unpaid Whish orders",
      });
      return;
    }

    const result = await sendWhishPaymentInstructions(id, wreq.workspaceOwnerId, {
      manual: true,
      actorUserId: wreq.userId,
      actorName: wreq.userEmail,
    });
    if (result.ok) {
      res.json({
        success: true,
        sent: true,
        provider_message_id: result.providerRef,
      });
      return;
    }

    const status =
      result.errorCode === "already_in_progress"
        ? 409
        : result.errorCode === "network_error" || result.errorCode.startsWith("http_")
          ? 502
          : 422;
    res.status(status).json({ success: false, sent: false, error: result.errorMessage });
  },
);

// ── Orders-page access: issue a Stripe/PayPal refund for a paid order ───────
router.post("/orders/:id/refund", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);
  if (!requireOrderAccess(wreq, res)) return;
  const { id } = req.params;

  // Optional `amount` (in the paid currency) drives a partial refund; when
  // omitted the whole remaining balance is refunded.
  const refundBody = z
    .object({ amount: z.number().finite().positive().optional() })
    .safeParse(req.body ?? {});
  if (!refundBody.success) {
    res.status(400).json({ success: false, error: "Invalid refund amount" });
    return;
  }
  const requestedAmount = refundBody.data.amount ?? null;

  const orderResult = await db.query<{
    id: string;
    status: string;
    external_order_id: string | null;
    payment_status: string | null;
    payment_provider: string | null;
    payment_reference: string | null;
    payment_amount: string | number | null;
    payment_amount_usd: string | number | null;
    payment_currency: string | null;
    refunded_amount: string | number | null;
    refunded_amount_usd: string | number | null;
    delivery_country_code: string | null;
    delivery_country: string | null;
  }>(
    `SELECT o.id, o.status, o.external_order_id,
            p.status AS payment_status,
            COALESCE(NULLIF(TRIM(p.provider), ''), p.method) AS payment_provider,
            p.provider_ref AS payment_reference,
            p.amount AS payment_amount,
            p.amount_usd AS payment_amount_usd,
            p.currency AS payment_currency,
            p.refunded_amount,
            p.refunded_amount_usd,
            o.delivery_address->>'countryCode' AS delivery_country_code,
            o.delivery_address->>'country' AS delivery_country
       FROM orders o
  LEFT JOIN order_payment p ON p.order_id = o.id
      WHERE o.id = $1 AND o.workspace_owner_id = $2
      LIMIT 1`,
    [id, wreq.workspaceOwnerId],
  );

  if (orderResult.rowCount === 0) {
    res.status(404).json({ success: false, error: "Order not found" });
    return;
  }

  const order = orderResult.rows[0];

  const provider = (order.payment_provider ?? "").toLowerCase();
  if (provider !== "stripe" && provider !== "paypal") {
    res.status(400).json({
      success: false,
      error: "Refunds are only supported for Stripe- or PayPal-paid orders",
    });
    return;
  }

  if (order.status === "refunded" || order.payment_status === "refunded") {
    res.status(400).json({ success: false, error: "This order has already been refunded" });
    return;
  }

  const reference = (order.payment_reference ?? "").trim();
  if (!reference) {
    res.status(400).json({
      success: false,
      error: "No payment reference is available to refund",
    });
    return;
  }

  // ── Resolve the refundable amounts (paid currency + USD equivalent) ─────────
  const toNum = (v: string | number | null): number | null => {
    if (v == null) return null;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const round2 = (n: number): number => Math.round(n * 100) / 100;
  const EPS = 0.005;

  const paidCurrency =
    (order.payment_currency ?? "USD").trim().toUpperCase() || "USD";
  // Paid-currency total; fall back to the USD figure for legacy/USD rows.
  const paidTotal = toNum(order.payment_amount) ?? toNum(order.payment_amount_usd);
  const amountUsdTotal = toNum(order.payment_amount_usd);
  const alreadyRefunded = toNum(order.refunded_amount) ?? 0;
  const alreadyRefundedUsd = toNum(order.refunded_amount_usd) ?? 0;

  const remaining = paidTotal != null ? round2(paidTotal - alreadyRefunded) : null;
  if (remaining != null && remaining <= EPS) {
    res.status(400).json({
      success: false,
      error: "This order has already been fully refunded",
    });
    return;
  }

  if (requestedAmount != null) {
    if (paidTotal == null) {
      res.status(400).json({
        success: false,
        error:
          "The paid amount for this order is unknown, so a partial refund cannot be issued",
      });
      return;
    }
    if (remaining != null && requestedAmount > remaining + EPS) {
      res.status(400).json({
        success: false,
        error: "The refund amount exceeds the remaining refundable balance",
      });
      return;
    }
  }

  // The amount to send to the provider (paid currency). null only when the paid
  // total is unknown and the caller asked for a full refund.
  const refundAmount = requestedAmount ?? remaining;
  // A "true" full refund (nothing refunded yet + covering the whole payment)
  // lets us omit the amount so the provider refunds the entire capture.
  const isTrueFullRefund =
    alreadyRefunded <= EPS &&
    (paidTotal == null ||
      (refundAmount != null && Math.abs(refundAmount - paidTotal) <= EPS));

  if (provider === "stripe") {
    // UAE orders were paid into the separate UAE Stripe account, so the refund
    // must be issued from that account (same selection as payment-link
    // creation, no silent fallback).
    const { client: stripe, missingKey } = getStripeClientForOrderCountry(
      order.delivery_country_code,
      order.delivery_country,
    );
    if (!stripe) {
      res.status(503).json({
        success: false,
        error:
          missingKey === "STRIPE_SECRET_KEY_UAE"
            ? `The UAE Stripe account is not configured. Please add ${missingKey} to your environment secrets to refund United Arab Emirates orders.`
            : "Stripe is not configured on this server",
      });
      return;
    }

    // A payment intent id starts with `pi_`; anything else is treated as a charge.
    const refundParams: Stripe.RefundCreateParams = reference.startsWith("pi_")
      ? { payment_intent: reference }
      : { charge: reference };
    // Partial (or top-up) refund: send the amount in minor units. Omitting it
    // makes Stripe refund the whole remaining charge.
    if (!isTrueFullRefund && refundAmount != null) {
      refundParams.amount = stripeMajorToMinor(refundAmount, paidCurrency);
    }

    try {
      await stripe.refunds.create(refundParams);
    } catch (err) {
      req.log.error({ err, orderId: id }, "Stripe refund failed");
      const message =
        err instanceof Stripe.errors.StripeError
          ? err.message
          : "Failed to issue the Stripe refund";
      res.status(502).json({ success: false, error: message });
      return;
    }
  } else {
    // PayPal: refund the original capture in full. `reference` holds the
    // capture id stored on the order_payment row at ingest / checkout time.
    const accessToken = await getPaypalAccessToken();
    if (!accessToken) {
      res.status(503).json({
        success: false,
        error: "PayPal is not configured on this server",
      });
      return;
    }

    // Empty object body issues a full refund of the captured amount; a partial
    // (or top-up) refund specifies the amount + currency.
    const paypalBody =
      isTrueFullRefund || refundAmount == null
        ? "{}"
        : JSON.stringify({
            amount: {
              value: refundAmount.toFixed(currencyDecimals(paidCurrency)),
              currency_code: paidCurrency,
            },
          });

    try {
      const resp = await fetch(
        `${getPaypalBase()}/v2/payments/captures/${encodeURIComponent(reference)}/refund`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: paypalBody,
        },
      );
      if (!resp.ok) {
        const errText = await resp.text();
        req.log.error(
          { orderId: id, status: resp.status, errText },
          "PayPal refund failed",
        );
        let paypalMessage: string | null = null;
        try {
          const errJson = JSON.parse(errText) as {
            message?: string;
            details?: { description?: string }[];
          };
          paypalMessage = errJson.details?.[0]?.description ?? errJson.message ?? null;
        } catch {
          paypalMessage = null;
        }
        res.status(502).json({
          success: false,
          error: paypalMessage
            ? `PayPal rejected this refund: ${paypalMessage}`
            : "Failed to issue the PayPal refund",
        });
        return;
      }
    } catch (err) {
      req.log.error({ err, orderId: id }, "PayPal refund failed");
      res.status(502).json({
        success: false,
        error: "Failed to issue the PayPal refund",
      });
      return;
    }
  }

  // Decide whether this refund closes out the payment. When the paid total is
  // unknown (legacy rows) a no-amount refund is treated as full, preserving the
  // prior always-full behavior.
  const fullyRefunded =
    paidTotal == null
      ? true
      : refundAmount != null && round2(alreadyRefunded + refundAmount) >= paidTotal - EPS;

  const newRefundedAmount =
    paidTotal == null
      ? null
      : fullyRefunded
        ? paidTotal
        : round2(alreadyRefunded + (refundAmount ?? 0));

  let newRefundedUsd: number | null;
  if (amountUsdTotal == null) {
    newRefundedUsd = null;
  } else if (fullyRefunded) {
    newRefundedUsd = amountUsdTotal;
  } else {
    const ratio = paidTotal && paidTotal > 0 ? amountUsdTotal / paidTotal : 1;
    newRefundedUsd = round2(alreadyRefundedUsd + (refundAmount ?? 0) * ratio);
  }

  const newPaymentStatus = fullyRefunded ? "refunded" : "partially_refunded";

  await db.query(
    `UPDATE order_payment
        SET status = $2,
            refunded_amount = $3,
            refunded_amount_usd = $4,
            updated_at = now()
      WHERE order_id = $1`,
    [id, newPaymentStatus, newRefundedAmount, newRefundedUsd],
  );

  // Keep the linked CMC Sales record (CMC New Order → workflow_type='order')
  // in sync: a fully refunded order drops out of the paid-only audit totals.
  if (fullyRefunded) {
    await db.query(
      `UPDATE cmc_sales
          SET status = 'refunded', updated_at = now()
        WHERE order_id = $1 AND workspace_owner_id = $2 AND workflow_type = 'order'`,
      [id, wreq.workspaceOwnerId],
    );
  }

  let orderRow: {
    id: string;
    external_order_id: string | null;
    status: string;
  };
  if (fullyRefunded) {
    const updated = await db.query<{
      id: string;
      external_order_id: string | null;
      status: string;
    }>(
      `UPDATE orders SET status = 'refunded' WHERE id = $1 AND workspace_owner_id = $2
       RETURNING id, external_order_id, status`,
      [id, wreq.workspaceOwnerId],
    );
    orderRow = updated.rows[0];
    await finalizeAddressCollectionForOrder(db, {
      orderId: String(id),
      workspaceOwnerId: wreq.workspaceOwnerId,
      outcome: "order_cancelled",
      reason: "Parent order refunded",
      source: "refund",
      actor: wreq.userId ? `user:${wreq.userId}` : "ops",
    });
  } else {
    // Partial refund: the order itself stays in its current status.
    orderRow = {
      id: order.id,
      external_order_id: order.external_order_id,
      status: order.status,
    };
  }

  recordOrderEvent({
    workspaceOwnerId: wreq.workspaceOwnerId,
    orderId: String(id),
    eventType: "order_refunded",
    payload: {
      from: order.status,
      to: fullyRefunded ? "refunded" : order.status,
      amount: refundAmount,
      currency: paidCurrency,
      partial: !fullyRefunded,
      refundedTotal: newRefundedAmount,
    },
    actorUserId: wreq.userId,
  });

  // Only a full refund changes the order status, so the status webhook + email
  // hook fire exactly as before. Partial refunds leave the order status intact.
  if (fullyRefunded) {
    void fireWebhookEvent("order.status_updated", wreq.workspaceOwnerId, {
      orderId: id,
      appOrderId: order.external_order_id ?? null,
      status: "refunded",
      updatedAt: new Date().toISOString(),
    });

    // "refunded" is intentionally NOT in ORDER_STATUS_EMAIL_STATUSES, so no
    // customer email is actually sent; routed through for consistency.
    void notifyOrderStatusEmail(
      String(id),
      order.external_order_id ?? String(id),
      "refunded",
      wreq.workspaceOwnerId,
    );
  }

  // Refund confirmation email to the customer (full + partial). Best-effort:
  // a failed lookup or send is logged and never fails the refund response.
  try {
    const customer = await lookupOrderCustomerContact(String(id));
    await trackOrderEmail(
      {
        workspaceOwnerId: wreq.workspaceOwnerId,
        orderId: String(id),
        templateType: "refund",
        recipientName: customer.name,
        recipientEmail: customer.email,
        triggeredByUserId: wreq.userId,
      },
      async () => {
        const details = await lookupOrderEmailDetails(String(id), wreq.workspaceOwnerId);
        return sendOrderRefundEmail({
          toEmail: customer.email!,
          orderNumber: order.external_order_id ?? String(id),
          isPartial: !fullyRefunded,
          customerName: customer.name,
          refundAmountText:
            refundAmount != null ? formatOrderAmount(refundAmount, paidCurrency) : null,
          totalRefundedText:
            newRefundedAmount != null
              ? formatOrderAmount(newRefundedAmount, paidCurrency)
              : null,
          items: details.items,
          amountPaidText: details.amountPaidText,
          deliveryDateText: details.deliveryDateText,
        });
      },
    );
  } catch (err) {
    req.log.warn({ err, orderId: id }, "Failed to send refund email");
  }

  res.json({
    success: true,
    order: orderRow,
    partial: !fullyRefunded,
    payment: {
      status: newPaymentStatus,
      refunded_amount: newRefundedAmount,
      refunded_amount_usd: newRefundedUsd,
      currency: paidCurrency,
    },
  });
});

// ── Bulk backfill: send all un-synced orders to Tookan ───────────────────────
// Owner-only. Pushes every order in the workspace that has no Tookan job yet
// (past + new) using the same single-order create path, persisting per-order
// success/failure. Returns a summary { attempted, succeeded, failed }. The
// static path must be registered before "/orders/:id/..." routes so it isn't
// parsed as an order id.
router.post(
  "/orders/backfill-tookan",
  async (req: Request, res: Response): Promise<void> => {
    const wreq = workspace(req);
    if (!requireOrderAccess(wreq, res)) return;

    if (!isTookanEnabled()) {
      res.status(400).json({ success: false, error: "Tookan integration is not enabled" });
      return;
    }

    const result = await backfillTookanDeliveryTasks(wreq.workspaceOwnerId);
    res.json({ success: true, ...result });
  },
);

// ── Retry Tookan delivery task ────────────────────────────────────────────────
router.post("/orders/:id/retry-tookan", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);
  if (!requireOrderAccess(wreq, res)) return;
  const { id } = req.params;

  if (!isTookanEnabled()) {
    res.status(400).json({ success: false, error: "Tookan integration is not enabled" });
    return;
  }

  try {
    await retryTookanDeliveryTask(String(id), wreq.workspaceOwnerId);
  } catch (err) {
    const e = err as { code?: string; message?: string };
    if (e.code === "ALREADY_CREATED") {
      res.status(409).json({ success: false, error: "Tookan task already created for this order" });
      return;
    }
    if (e.code === "NOT_FOUND") {
      res.status(404).json({ success: false, error: "Order not found" });
      return;
    }
    req.log.warn({ err, orderId: id }, "Tookan retry failed");
    res.status(502).json({ success: false, error: e.message ?? "Tookan retry failed" });
    return;
  }

  const updated = await db.query<{
    tookan_job_id: string | null;
    tookan_task_id: string | null;
    tookan_status: string | null;
    tookan_created_at: string | null;
    tookan_error: string | null;
  }>(
    `SELECT tookan_job_id, tookan_task_id, tookan_status, tookan_created_at, tookan_error
       FROM orders WHERE id = $1 AND workspace_owner_id = $2 LIMIT 1`,
    [String(id), wreq.workspaceOwnerId],
  );

  res.json({ success: true, ...(updated.rows[0] ?? {}) });
});

// ── Tookan quick-assign (Taxi / Butler) ─────────────────────────────────────

const TOOKAN_QUICK_ASSIGN_AGENTS: Record<"taxi" | "butler", number> = {
  taxi: 2111639,
  butler: 2111640,
};

router.post("/orders/:id/assign-tookan-agent", async (req: Request, res: Response): Promise<void> => {
  const wreq = workspace(req);
  if (!requireOrderAccess(wreq, res)) return;

  const bodyParse = z.object({ agent_type: z.enum(["taxi", "butler"]) }).safeParse(req.body);
  if (!bodyParse.success) {
    res.status(400).json({ error: "agent_type must be 'taxi' or 'butler'" });
    return;
  }
  const { agent_type } = bodyParse.data;
  const agentId = TOOKAN_QUICK_ASSIGN_AGENTS[agent_type];

  const orderRes = await db.query<{ tookan_job_id: string | null }>(
    `SELECT tookan_job_id FROM orders WHERE id = $1 AND workspace_owner_id = $2 LIMIT 1`,
    [String(req.params.id), wreq.workspaceOwnerId],
  );
  const order = orderRes.rows[0];
  if (!order) {
    res.status(404).json({ error: "Order not found" });
    return;
  }
  if (!order.tookan_job_id) {
    res.status(422).json({ error: "no_tookan_job" });
    return;
  }

  try {
    await assignTookanAgent(order.tookan_job_id, agentId);
  } catch (err) {
    req.log.warn({ err, orderId: req.params.id, agent_type }, "Tookan quick-assign failed");
    res.status(502).json({
      error: err instanceof Error ? err.message : "Tookan assignment failed",
    });
    return;
  }

  res.json({ ok: true });
});

// ── Trustpilot service-review invitation (admin card) ───────────────────────

/** Trustpilot invitation admin endpoints are workspace-owner only. */
function requireTrustpilotAdmin(
  wreq: ReturnType<typeof workspace>,
  res: Response,
): boolean {
  if (wreq.workspaceRole === "owner") return true;
  res.status(403).json({
    success: false,
    error: "Only the workspace owner can manage Trustpilot invitations",
  });
  return false;
}

const TRUSTPILOT_INVITATION_COLUMNS = `
  id, order_id, status, recipient_email, recipient_name, reference_id, locale,
  preferred_send_time, attempt_count, next_attempt_at, last_error, last_attempt_at,
  trustpilot_invitation_id, created_at, updated_at`;

/**
 * Resolve a route :id param (which may be a UUID or a display_order_number
 * like "m-1020") to the order's actual UUID.  Returns null when no matching
 * order is found in this workspace.
 *
 * Uses a regex-guard in SQL so we never attempt an invalid ::uuid cast —
 * the error "invalid input syntax for type uuid" is a common prod 500 when
 * the order detail page passes a display_order_number to these routes.
 */
async function resolveOrderId(
  idParam: string,
  workspaceOwnerId: string,
): Promise<string | null> {
  const res = await db.query<{ id: string }>(
    `SELECT id FROM orders
      WHERE (
        display_order_number = $1
        OR (
          $1 ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          AND id::text = lower($1)
        )
      )
        AND workspace_owner_id = $2
      LIMIT 1`,
    [idParam, workspaceOwnerId],
  );
  return res.rows[0]?.id ?? null;
}

/**
 * GET /orders/:id/trustpilot-invitation — invitation state for the order
 * detail admin card. Returns `{ enabled, invitation }` where invitation is
 * null when nothing has been enqueued for this order.
 */
router.get(
  "/orders/:id/trustpilot-invitation",
  async (req: Request, res: Response): Promise<void> => {
    const wreq = workspace(req);
    if (!requireTrustpilotAdmin(wreq, res)) return;
    const { id } = req.params;

    const orderId = await resolveOrderId(String(id), wreq.workspaceOwnerId);
    if (!orderId) {
      res.status(404).json({ success: false, error: "Order not found" });
      return;
    }

    const result = await db.query(
      `SELECT ${TRUSTPILOT_INVITATION_COLUMNS}
         FROM trustpilot_invitations
        WHERE order_id = $1 AND workspace_owner_id = $2
        LIMIT 1`,
      [orderId, wreq.workspaceOwnerId],
    );
    // `enabled` combines the env master switch with the workspace toggle so
    // the admin card hides when either is off.
    let workspaceEnabled = true;
    if (isTrustpilotEnabled()) {
      const ws = await db.query<{ trustpilot_invitations_enabled: boolean | null }>(
        `SELECT trustpilot_invitations_enabled FROM workspace_settings
          WHERE workspace_owner_id = $1`,
        [wreq.workspaceOwnerId],
      );
      workspaceEnabled = ws.rows[0]?.trustpilot_invitations_enabled ?? true;
    }
    res.json({
      success: true,
      enabled: isTrustpilotEnabled() && workspaceEnabled,
      testMode: isTrustpilotTestMode(),
      invitation: result.rows[0] ?? null,
    });
  },
);

/**
 * POST /orders/:id/trustpilot-invitation/retry — re-queue a failed/skipped
 * invitation (admin action). Requires the order to already be completed and
 * a customer email to exist; refreshes recipient details from the order.
 */
router.post(
  "/orders/:id/trustpilot-invitation/retry",
  async (req: Request, res: Response): Promise<void> => {
    const wreq = workspace(req);
    if (!requireTrustpilotAdmin(wreq, res)) return;
    const { id } = req.params;

    if (!isTrustpilotEnabled()) {
      res.status(400).json({ success: false, error: "Trustpilot integration is not enabled" });
      return;
    }

    const resolvedId = await resolveOrderId(String(id), wreq.workspaceOwnerId);
    if (!resolvedId) {
      res.status(404).json({ success: false, error: "Order not found" });
      return;
    }

    const orderRes = await db.query<{
      id: string;
      status: string;
      is_sensitive_occasion: boolean | null;
      customer_email: string | null;
      customer_name: string | null;
    }>(
      `SELECT o.id, o.status, o.is_sensitive_occasion,
              COALESCE(c.email, o.raw_payload->>'customer_email') AS customer_email,
              c.display_name AS customer_name
         FROM orders o
    LEFT JOIN order_contacts oc ON oc.order_id = o.id AND oc.role = 'customer'
    LEFT JOIN contacts c ON c.id = oc.contact_id
        WHERE o.id = $1 AND o.workspace_owner_id = $2
        LIMIT 1`,
      [resolvedId, wreq.workspaceOwnerId],
    );
    const order = orderRes.rows[0];
    if (!order) {
      res.status(404).json({ success: false, error: "Order not found" });
      return;
    }
    if (order.status !== "completed") {
      res.status(409).json({ success: false, error: "Order is not completed" });
      return;
    }
    if (order.is_sensitive_occasion === true) {
      res.status(409).json({
        success: false,
        error:
          "Review invitation is suppressed for this order (sensitive occasion). Unflag the order first to send one.",
      });
      return;
    }
    const email = (order.customer_email ?? "").trim();
    if (!email) {
      res.status(409).json({ success: false, error: "Order has no customer email" });
      return;
    }

    // Re-queue: reset a FAILED or SKIPPED row back to pending with a fresh
    // attempt budget (skipped covers "no email at the time" and sensitive-
    // occasion suppressions later unflagged); never touch created/processing/
    // pending.
    const requeued = await db.query(
      `UPDATE trustpilot_invitations
          SET status = 'pending',
              recipient_email = $1,
              recipient_name = $2,
              attempt_count = 0,
              next_attempt_at = now(),
              last_error = NULL,
              updated_at = now()
        WHERE order_id = $3
          AND workspace_owner_id = $4
          AND status IN ('failed', 'skipped')
        RETURNING id`,
      [email, order.customer_name ?? null, order.id, wreq.workspaceOwnerId],
    );

    const invitationRowId = requeued.rows[0]?.id as string | undefined;

    if (!invitationRowId) {
      const existing = await db.query<{ status: string }>(
        `SELECT status FROM trustpilot_invitations
          WHERE order_id = $1 AND workspace_owner_id = $2 LIMIT 1`,
        [order.id, wreq.workspaceOwnerId],
      );
      if (existing.rows[0]) {
        res.status(409).json({
          success: false,
          error:
            existing.rows[0].status === "created"
              ? "Invitation already sent for this order"
              : "Invitation is currently being processed",
        });
        return;
      }
      // No row yet (e.g. completed before the feature shipped) — enqueue now.
      const outcome = await maybeEnqueueTrustpilotInvitation(order.id, null, "completed");
      if (outcome !== "enqueued" && outcome !== "skipped" && outcome !== "duplicate") {
        res.status(502).json({ success: false, error: "Failed to enqueue invitation" });
        return;
      }
    } else {
      void processTrustpilotInvitation(invitationRowId).catch((err) =>
        req.log.warn({ err, orderId: id }, "trustpilot retry processing failed"),
      );
    }

    const updated = await db.query(
      `SELECT ${TRUSTPILOT_INVITATION_COLUMNS}
         FROM trustpilot_invitations
        WHERE order_id = $1 AND workspace_owner_id = $2
        LIMIT 1`,
      [order.id, wreq.workspaceOwnerId],
    );
    res.json({ success: true, invitation: updated.rows[0] ?? null });
  },
);

/**
 * GET /orders/:id/omnichannel-conversation — look up the most recent respond.io
 * conversation thread for the order's customer contact (matched by phone).
 * Returns { conversation, messages, contact } or { conversation: null } when
 * no omnichannel thread exists. Responds 404 only when the order itself is not
 * found.
 */
router.get(
  "/orders/:id/omnichannel-conversation",
  async (req: Request, res: Response): Promise<void> => {
    const wreq = workspace(req);
    const id = await resolveOrderId(String(req.params.id), wreq.workspaceOwnerId);
    if (!id) {
      res.status(404).json({ success: false, error: "Order not found" });
      return;
    }

    // Load customer contact phone — no phone means no omnichannel match.
    const contactResult = await db.query<{ phone: string | null; display_name: string | null }>(
      `SELECT c.phone, c.display_name
         FROM order_contacts oc
         JOIN contacts c ON c.id = oc.contact_id
        WHERE oc.order_id = $1
          AND oc.role = 'customer'
          AND c.workspace_owner_id = $2
        ORDER BY oc.created_at
        LIMIT 1`,
      [id, wreq.workspaceOwnerId],
    );
    const customerPhone = contactResult.rows[0]?.phone ?? null;
    if (!customerPhone) {
      res.json({ conversation: null, messages: [], contact: null });
      return;
    }

    // Match an omni_contacts row by workspace + phone.
    const omniContactResult = await db.query<{ id: number; display_name: string | null }>(
      `SELECT id, display_name FROM omni_contacts
        WHERE workspace_owner_id = $1 AND phone = $2
        LIMIT 1`,
      [wreq.workspaceOwnerId, customerPhone],
    );
    const omniContact = omniContactResult.rows[0] ?? null;
    if (!omniContact) {
      res.json({ conversation: null, messages: [], contact: null });
      return;
    }

    // Fetch most recent conversation for that contact.
    const convResult = await db.query<{
      id: number;
      status: string;
      channel_provider: string;
      channel_name: string;
    }>(
      `SELECT c.id, c.status, ca.provider AS channel_provider, ca.name AS channel_name
         FROM omni_conversations c
         JOIN omni_channel_accounts ca ON ca.id = c.channel_account_id
        WHERE c.contact_id = $1 AND c.workspace_owner_id = $2
        ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC
        LIMIT 1`,
      [omniContact.id, wreq.workspaceOwnerId],
    );
    const conversation = convResult.rows[0] ?? null;
    if (!conversation) {
      res.json({ conversation: null, messages: [], contact: omniContact });
      return;
    }

    // Load all messages for the conversation, including template fields.
    const messagesResult = await db.query(
      `SELECT id, conversation_id, direction, message_type, content, media_url, media_mime_type,
              sender_name, sender_agent_id, status, error_code, error_message,
              template_name, template_params, sent_at, delivered_at, read_at, created_at
         FROM omni_messages
        WHERE conversation_id = $1
        ORDER BY created_at ASC`,
      [conversation.id],
    );

    res.json({
      conversation,
      messages: messagesResult.rows,
      contact: omniContact,
    });
  },
);

export default router;
