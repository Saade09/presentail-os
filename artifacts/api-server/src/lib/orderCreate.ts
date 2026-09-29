import { db } from "./db";
import { logger } from "./logger";
import { createAddressCollectionRequest } from "./addressCollector/service";
import { shouldCollectAddressCollection } from "./addressCollector/eligibility";
import {
  upsertContact,
  refreshPhonePlaceholderContactAfterFirstOrder,
} from "./contactUpsert";
import { broadcastEvent } from "./eventsSse";
import { applyAutoTagsForContact } from "./autoTags";
import { notifyNewOrderAlerts } from "./orderAlerts";
import { fireWebhookEvent } from "./catalogWebhook";
import { linkOrderToAddressBook } from "./addressBookAutoLink";
import {
  isTookanEnabled,
  createTookanDeliveryTask,
  extractTookanFailurePayload,
  recordTookanInvitationComm,
  type OrderForTookan,
  type RecipientForTookan,
  type LineItemForTookan,
} from "./tookan";
import { syncApprovedFloristPhotoForOrderToTookan } from "./floristTookanPhotoSync";
import { notifyNewUaeOrderToSlack } from "./slack";
import {
  notifyOrderStatusWhatsApp,
  sendWhishPaymentInstructions,
} from "./orderWhatsappNotify";
import { applySensitiveOccasionFlag } from "./sensitiveOccasion";
import { isWhishPayment } from "./orderInvoicePdf";
import { normalizePersonName } from "./personName";
import { linkPaymentLinkToOrderInTransaction } from "./paymentLinkOrder";
import {
  calculateCmcOrderDiscount,
  type CmcOrderDiscountInput,
} from "./cmcOrderDiscount";

/**
 * Shared order-creation logic for orders authored from inside Presentail OS
 * (the dashboard "Create Order" wizard). Mirrors the inbound external-order
 * ingest in `externalOrders.ts` — same tables, same column names, same
 * `order.created` SSE + webhook events — but is workspace-scoped via Clerk
 * instead of an API key and never touches payment providers (it only records
 * the chosen method + status).
 *
 * Unlike the external ingest, a manual order is created atomically: the whole
 * insert runs inside a single transaction and any failure rolls everything
 * back, so the dashboard never produces a half-written order. The column set
 * deliberately follows the live database (see `initDb.ts`): line items use
 * `external_id` / `line_total` (NOT the stale Drizzle `total` /
 * `external_product_id`).
 */

export type CreateOrderContactInput = {
  /** When set, links an existing contact by id (no upsert-by-fields). */
  contact_id?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  display_name?: string | null;
  email?: string | null;
  phone?: string | null;
};

export type CreateOrderLineItemInput = {
  product_id?: number | null;
  external_id?: string | null;
  sku?: string | null;
  name: string;
  quantity: number;
  unit_price?: number | null;
  image_url?: string | null;
  custom_input?: string | null;
  is_custom_item?: boolean | null;
  production_instructions?: string | null;
  custom_item_created_by?: string | null;
};

export type CreateOrderPaymentInput = {
  status?: string | null;
  method?: string | null;
  currency?: string | null;
};

export type CreateOrderNotesInput = {
  customer_note?: string | null;
  florist_note?: string | null;
  driver_note?: string | null;
  internal_note?: string | null;
};

export type CreateOrderData = {
  source?: string | null;
  status?: string | null;
  ordered_at?: string | null;
  delivery_type?: string | null;
  delivery_address?: unknown;
  delivery_instructions?: string | null;
  window_start?: string | null;
  window_end?: string | null;
  card_message?: string | null;
  card_from?: string | null;
  card_to?: string | null;
  totals?: unknown;
  customer?: CreateOrderContactInput | null;
  recipient?: CreateOrderContactInput | null;
  line_items?: CreateOrderLineItemInput[];
  payment?: CreateOrderPaymentInput | null;
  notes?: CreateOrderNotesInput | null;
  /** Optional: link an existing payment_link record to this order. */
  payment_link_id?: number | null;
  /** Explicit confirmations required when the selected link is not a clean match. */
  confirm_payment_link_reassignment?: boolean | null;
  confirm_payment_link_mismatch?: boolean | null;
  /** Address Collector: "Collect address later" wizard toggle. */
  collect_address?: boolean | null;
  /** Recipient's preferred outreach language for address collection (en|ar). */
  preferred_language?: string | null;
  /** CMC POS total-level discount. Calculated against items on the server. */
  discount?: CmcOrderDiscountInput | null;
  /** Client-generated key used to safely retry a CMC order create. */
  idempotency_key?: string | null;
};

type OrderRow = { id: string };

/** Thrown when a supplied contact_id doesn't exist in the caller's workspace. */
export class ContactNotFoundError extends Error {
  constructor(role: "customer" | "recipient") {
    super(`Selected ${role} contact was not found in this workspace`);
    this.name = "ContactNotFoundError";
  }
}

export class ManualOrderPricingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManualOrderPricingError";
  }
}

type ManualOrderCityRow = {
  country_code: string;
  delivery_fee: string | number;
  free_delivery_enabled: boolean;
  free_delivery_threshold: string | number | null;
};

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function cityCurrency(countryCode: string): "AED" | "USD" {
  return countryCode.trim().toUpperCase() === "AE" ? "AED" : "USD";
}

function requestedOrderCurrency(
  data: CreateOrderData,
  incomingTotals: Record<string, unknown>,
): string {
  return typeof incomingTotals.currency === "string" && incomingTotals.currency.trim()
    ? incomingTotals.currency.trim().toUpperCase()
    : (data.payment?.currency?.trim().toUpperCase() || "USD");
}

async function calculateManualItemSubtotal(args: {
  workspaceOwnerId: string;
  data: CreateOrderData;
  currency: string;
}): Promise<number> {
  const lines = args.data.line_items ?? [];
  const productIds = [
    ...new Set(
      lines
        .filter((line) => line.is_custom_item !== true && line.product_id != null)
        .map((line) => line.product_id as number),
    ),
  ];
  const productPrices = new Map<number, { price_usd: string | number; price_aed: string | number }>();
  if (productIds.length > 0) {
    const result = await db.query<{
      id: number;
      price_usd: string | number;
      price_aed: string | number;
    }>(
      `SELECT id, price_usd, price_aed
         FROM products
        WHERE workspace_owner_id = $1
          AND id = ANY($2::int[])
          AND is_archived = false`,
      [args.workspaceOwnerId, productIds],
    );
    for (const row of result.rows) productPrices.set(row.id, row);
    if (productPrices.size !== productIds.length) {
      throw new ManualOrderPricingError("One or more selected products were not found in this workspace");
    }
  }

  return lines.reduce((sum, line) => {
    const quantity = Number(line.quantity);
    const normalizedQuantity = Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
    const product = line.product_id != null ? productPrices.get(line.product_id) : null;
    const rawUnitPrice =
      line.is_custom_item !== true && product
        ? args.currency === "AED"
          ? product.price_aed
          : product.price_usd
        : line.unit_price ?? 0;
    const unitPrice = Number(rawUnitPrice);
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      throw new ManualOrderPricingError(`Product "${line.name}" does not have a valid ${args.currency} price`);
    }
    return sum + normalizedQuantity * unitPrice;
  }, 0);
}

async function calculateManualOrderTotals(args: {
  workspaceOwnerId: string;
  data: CreateOrderData;
  itemSubtotal: number;
  incomingTotals: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const requestedCurrency = requestedOrderCurrency(args.data, args.incomingTotals);
  const paymentCurrency = args.data.payment?.currency?.trim().toUpperCase();
  if (paymentCurrency && paymentCurrency !== requestedCurrency) {
    throw new ManualOrderPricingError("Order totals currency must match payment currency");
  }

  const address =
    args.data.delivery_address != null && typeof args.data.delivery_address === "object"
      ? (args.data.delivery_address as Record<string, unknown>)
      : {};
  const cityRefRaw = address.cityId ?? address.city_id;
  const cityRef =
    typeof cityRefRaw === "string" || typeof cityRefRaw === "number"
      ? String(cityRefRaw).trim()
      : "";
  let shipping = 0;

  if (cityRef) {
    const countryRaw = address.countryCode ?? address.country_code;
    const countryCode = typeof countryRaw === "string" ? countryRaw.trim().toUpperCase() : "";
    if (!countryCode) {
      throw new ManualOrderPricingError("A country is required when a delivery city is selected");
    }
    const cityResult = await db.query<ManualOrderCityRow>(
      `SELECT country_code, delivery_fee, free_delivery_enabled, free_delivery_threshold
         FROM delivery_cities
        WHERE workspace_owner_id = $1
          AND is_active = true
          AND (id::text = $2 OR lower(slug) = lower($2))
        LIMIT 1`,
      [args.workspaceOwnerId, cityRef],
    );
    const city = cityResult.rows[0];
    if (!city) {
      throw new ManualOrderPricingError("Selected delivery city was not found in this workspace");
    }
    if (city.country_code.trim().toUpperCase() !== countryCode) {
      throw new ManualOrderPricingError("Selected delivery city does not belong to the selected country");
    }
    const expectedCurrency = cityCurrency(city.country_code);
    if (requestedCurrency !== expectedCurrency) {
      throw new ManualOrderPricingError(
        `Selected delivery city requires ${expectedCurrency} pricing`,
      );
    }
    const fee = Math.max(0, Number(city.delivery_fee) || 0);
    const threshold =
      city.free_delivery_threshold == null ? null : Number(city.free_delivery_threshold);
    const waived =
      city.free_delivery_enabled &&
      threshold != null &&
      Number.isFinite(threshold) &&
      args.itemSubtotal >= threshold;
    shipping = waived ? 0 : fee;
  }

  const subtotal = roundMoney(args.itemSubtotal);
  shipping = roundMoney(shipping);
  return {
    ...args.incomingTotals,
    subtotal,
    shipping,
    delivery_fee: shipping,
    total: roundMoney(subtotal + shipping),
    currency: requestedCurrency,
  };
}

type ContactFieldsRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  display_name: string | null;
  email: string | null;
  phone: string | null;
};

function normalizedContactFields(c: {
  first_name: string | null;
  last_name: string | null;
  display_name: string | null;
}) {
  return {
    first_name: normalizePersonName(c.first_name),
    last_name: normalizePersonName(c.last_name),
    display_name: normalizePersonName(c.display_name),
  };
}
/**
 * Resolve a wizard contact input to a contact id. When `contact_id` is
 * provided, the existing contact is loaded (validating workspace ownership)
 * and its identity fields are merged back into the input so downstream
 * side effects (Tookan recipient fallback, etc.) see real values. Otherwise
 * falls back to the shared upsert-by-fields path.
 */
async function resolveOrderContact(
  workspaceOwnerId: string,
  source: string,
  role: "customer" | "recipient",
  input: CreateOrderContactInput | null | undefined,
): Promise<string | null> {
  if (input?.contact_id) {
    const r = await db.query<ContactFieldsRow>(
      `SELECT id, first_name, last_name, display_name, email, phone
         FROM contacts
        WHERE id = $1 AND workspace_owner_id = $2`,
      [input.contact_id, workspaceOwnerId],
    );
    const row = r.rows[0];
    if (!row) throw new ContactNotFoundError(role);
    const normalizedRow = normalizedContactFields(row);
    // Orders list/detail views read names through the linked contact. Keep the
    // selected contact's name consistent with this manual order without
    // changing its identity fields (id, email, phone, or links).
    if (
      normalizedRow.first_name !== row.first_name ||
      normalizedRow.last_name !== row.last_name ||
      normalizedRow.display_name !== row.display_name
    ) {
      await db.query(
        `UPDATE contacts
            SET first_name = $1, last_name = $2, display_name = $3, updated_at = now()
          WHERE id = $4 AND workspace_owner_id = $5`,
        [
          normalizedRow.first_name,
          normalizedRow.last_name,
          normalizedRow.display_name,
          row.id,
          workspaceOwnerId,
        ],
      );
    }
    input.first_name = normalizePersonName(input.first_name ?? normalizedRow.first_name);
    input.last_name = normalizePersonName(input.last_name ?? normalizedRow.last_name);
    input.display_name = normalizePersonName(input.display_name ?? normalizedRow.display_name);
    // Prefer the caller-supplied email over the stored one. If the caller
    // provided an email and the contact has none on file, persist it so that
    // lookupOrderCustomerContact (and status-change emails) can resolve it.
    // This is additive-only — never overwrites an existing contact email.
    const incomingEmail = typeof input.email === "string" && input.email.trim() ? input.email.trim() : null;
    if (incomingEmail && !row.email) {
      await db.query(
        `UPDATE contacts SET email = $1, updated_at = now() WHERE id = $2`,
        [incomingEmail, row.id],
      );
    }
    input.email = incomingEmail ?? row.email;
    input.phone = input.phone ?? row.phone;
    return row.id;
  }
  if (!hasContactIdentity(input)) return null;
  return upsertContact({
    workspaceOwnerId,
    source,
    firstName: normalizePersonName(input?.first_name),
    lastName: normalizePersonName(input?.last_name),
    displayName: normalizePersonName(input?.display_name),
    email: input?.email ?? null,
    phone: input?.phone ?? null,
  });
}

function hasContactIdentity(c: CreateOrderContactInput | null | undefined): boolean {
  if (!c) return false;
  return Boolean(
    (c.first_name && c.first_name.trim()) ||
      (c.last_name && c.last_name.trim()) ||
      (c.display_name && c.display_name.trim()) ||
      (c.email && c.email.trim()) ||
      (c.phone && c.phone.trim()),
  );
}

/**
 * Create a manual order for `workspaceOwnerId`. Resolves contacts via the
 * shared contact pool, writes the order + child rows in one transaction, then
 * emits the `order.created` SSE and webhook events after commit. Returns the
 * new order id.
 */
export async function createManualOrder(opts: {
  workspaceOwnerId: string;
  actorUserId?: string | null;
  data: CreateOrderData;
  /**
   * When provided, this value is used as the `display_order_number` instead
   * of generating the default `M-{N}` number. Callers are responsible for
   * ensuring uniqueness (e.g. by pre-generating via an atomic counter).
   */
  displayOrderNumber?: string;
}): Promise<{ orderId: string; displayOrderNumber: string }> {
  const { workspaceOwnerId, actorUserId, data } = opts;
  const source = (data.source && data.source.trim()) || "manual";
  const normalizedCardFrom = normalizePersonName(data.card_from);
  const normalizedCardTo = normalizePersonName(data.card_to);
  const incomingTotals =
    data.totals != null && typeof data.totals === "object"
      ? (data.totals as Record<string, unknown>)
      : {};
  const itemSubtotal =
    source === "cmc-pos"
      ? (data.line_items ?? []).reduce((sum, line) => {
          const quantity = Number(line.quantity);
          const unitPrice = Number(line.unit_price ?? 0);
          return sum + (Number.isFinite(quantity) && quantity > 0 ? quantity : 1) *
            (Number.isFinite(unitPrice) && unitPrice >= 0 ? unitPrice : 0);
        }, 0)
      : await calculateManualItemSubtotal({
          workspaceOwnerId,
          data,
          currency: requestedOrderCurrency(data, incomingTotals),
        });
  // CMC POS catalogue prices and reporting use USD; don't let a caller relabel
  // server-calculated USD totals with an arbitrary currency.
  const currency =
    source === "cmc-pos"
      ? "USD"
      : typeof incomingTotals.currency === "string" && incomingTotals.currency.trim()
        ? incomingTotals.currency.trim().toUpperCase()
        : "USD";
  const cmcDiscount =
    source === "cmc-pos" && data.discount
      ? calculateCmcOrderDiscount(data.discount, itemSubtotal, currency)
      : null;
  const effectiveTotals: Record<string, unknown> =
    source === "cmc-pos"
      ? {
          ...incomingTotals,
          subtotal: Math.round(itemSubtotal * 100) / 100,
          discount: cmcDiscount?.amount ?? 0,
          total: Math.max(0, Math.round((itemSubtotal - (cmcDiscount?.amount ?? 0)) * 100) / 100),
          currency,
          ...(cmcDiscount
            ? {
                cmc_discount: {
                  ...cmcDiscount,
                  applied_by_user_id: actorUserId ?? null,
                  applied_at: new Date().toISOString(),
                },
              }
            : {}),
        }
      : await calculateManualOrderTotals({
          workspaceOwnerId,
          data,
          itemSubtotal,
          incomingTotals,
        });
  // Capture the submitted buyer name before resolving a selected contact. The
  // resolver intentionally backfills omitted fields from the saved contact for
  // downstream delivery work; that must not turn a phone placeholder back into
  // the "new order" name used by the first-order repair.
  const submittedCustomerName = data.customer
    ? {
        firstName: data.customer.first_name ?? null,
        lastName: data.customer.last_name ?? null,
        displayName: data.customer.display_name ?? null,
      }
    : null;

  // Resolve contacts up-front (outside the transaction — the contact pool is
  // shared and idempotent; an orphan contact from a rolled-back order is
  // harmless and matches the external ingest behaviour).
  const customerContactId = await resolveOrderContact(
    workspaceOwnerId,
    source,
    "customer",
    data.customer,
  );
  const recipientContactId = await resolveOrderContact(
    workspaceOwnerId,
    source,
    "recipient",
    data.recipient,
  );

  const client = await db.connect();
  let orderId = "";
  let displayOrderNumber = "";
  try {
    await client.query("BEGIN");

    if (opts.displayOrderNumber) {
      // Caller pre-generated a display order number (e.g. CMC-1001). Use it
      // directly — no advisory lock or sequence query needed.
      displayOrderNumber = opts.displayOrderNumber;
    } else {
      // Assign the next per-workspace manual order number (M-1001, M-1002, …).
      // A transaction-scoped advisory lock serialises concurrent manual creates
      // within the same workspace, so two transactions can never read the same
      // MAX and compute the same number. The lock releases automatically at
      // COMMIT/ROLLBACK. Numbering is atomic with the order insert by design:
      // if either fails the whole transaction rolls back — a manual order is
      // never created without its number.
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended('manual_order_number:' || $1, 0))`,
        [workspaceOwnerId],
      );
      const seqResult = await client.query<{ next_number: string }>(
        `SELECT COALESCE(MAX((substring(display_order_number from '^M-([0-9]+)$'))::bigint), 1000) + 1
                  AS next_number
           FROM orders
          WHERE workspace_owner_id = $1
            AND display_order_number ~ '^M-[0-9]+$'`,
        [workspaceOwnerId],
      );
      const nextNumber = seqResult.rows[0]?.next_number;
      if (nextNumber == null || `${nextNumber}`.trim() === "") {
        throw new Error("Failed to compute the next manual order number");
      }
      displayOrderNumber = `M-${nextNumber}`;
    }

    const insertResult = await client.query<OrderRow>(
      `INSERT INTO orders
         (workspace_owner_id, source, status, ordered_at, delivery_type,
          delivery_address, delivery_instructions, window_start, window_end,
          card_message, card_from, card_to, totals, raw_payload,
           display_order_number)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING id`,
      [
        workspaceOwnerId,
        source,
        (data.status && data.status.trim()) || "pending",
        data.ordered_at ? new Date(data.ordered_at).toISOString() : new Date().toISOString(),
        data.delivery_type ?? null,
        data.delivery_address != null ? JSON.stringify(data.delivery_address) : null,
        data.delivery_instructions ?? null,
        data.window_start ? new Date(data.window_start).toISOString() : null,
        data.window_end ? new Date(data.window_end).toISOString() : null,
        data.card_message ?? null,
         normalizedCardFrom,
         normalizedCardTo,
         Object.keys(effectiveTotals).length > 0 ? JSON.stringify(effectiveTotals) : null,
        JSON.stringify({
          _source: "dashboard_manual",
          created_via: source === "cmc-pos" ? "cmc_new_order" : "create_order_wizard",
          ...(data.idempotency_key ? { idempotency_key: data.idempotency_key } : {}),
        }),
         displayOrderNumber,
      ],
    );
    const row = insertResult.rows[0];
    if (!row) {
      throw new Error("Order insert returned no row");
    }
    orderId = row.id;

    // Line items — column set follows the live DB (external_id / line_total).
    for (const li of data.line_items ?? []) {
      const qty = li.quantity > 0 ? li.quantity : 1;
      const unitPrice = li.unit_price != null ? Number(li.unit_price) : null;
      const lineTotal = unitPrice != null ? unitPrice * qty : null;
      // Custom items skip the 22-char cap (they have no storefront length limit).
      const isCustomItem = li.is_custom_item === true;
      const customInput =
        typeof li.custom_input === "string" && li.custom_input.trim() !== ""
          ? isCustomItem
            ? li.custom_input.trim()
            : li.custom_input.slice(0, 22)
          : null;
      const productionInstructions =
        typeof li.production_instructions === "string" && li.production_instructions.trim() !== ""
          ? li.production_instructions.trim()
          : null;
      // For custom items: null out storefront product/sku refs (server-enforced invariant).
      // custom_item_created_by is always server-authored from the authenticated actor.
      const productId = isCustomItem ? null : (li.product_id ?? null);
      const sku = isCustomItem ? null : (li.sku ?? null);
      const customItemCreatedBy = isCustomItem ? (actorUserId ?? null) : null;
      await client.query(
        `INSERT INTO order_line_items
           (order_id, product_id, external_id, sku, name, quantity,
            unit_price, line_total, image_url, custom_input,
            is_custom_item, production_instructions, custom_item_created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          orderId,
          productId,
          li.external_id ?? null,
          sku,
          li.name,
          qty,
          unitPrice != null ? String(unitPrice) : null,
          lineTotal != null ? String(lineTotal) : null,
          li.image_url ?? null,
          customInput,
          isCustomItem,
          productionInstructions,
          customItemCreatedBy,
        ],
      );
    }

    // Sensitive-occasion auto-detect (sympathy/funeral/condolence products).
    // Best-effort: a detection failure must never block order creation.
    try {
      await applySensitiveOccasionFlag(client, orderId, workspaceOwnerId);
    } catch (err) {
      logger.warn({ err, orderId }, "orderCreate: sensitive-occasion detection failed; order still created");
    }

    // Contact links.
    if (customerContactId) {
      await client.query(
        `INSERT INTO order_contacts (order_id, contact_id, role)
         VALUES ($1, $2, 'customer')
         ON CONFLICT DO NOTHING`,
        [orderId, customerContactId],
      );
    }
    if (recipientContactId) {
      await client.query(
        `INSERT INTO order_contacts (order_id, contact_id, role)
         VALUES ($1, $2, 'recipient')
         ON CONFLICT DO NOTHING`,
        [orderId, recipientContactId],
      );
    }

    // Payment record — method + status only. This NEVER charges a card or
    // creates a payment link; it just records how the customer is paying.
    // The caller (dashboard wizard) always sends payment.currency explicitly;
    // fall back to "USD" as a safe default if it is somehow omitted.
    if (data.payment && (data.payment.method || data.payment.status || data.payment.currency)) {
      // Keep the (currency, amount) pair atomic, mirroring the external-ingest
      // convention: `amount` is only recorded when a figure in the payment
      // currency is actually known — the USD total for USD payments, or the
      // totals paid pair when it names the same currency. Never pair the USD
      // figure with a non-USD currency code.
      const totalsForPayment = effectiveTotals;
      const paymentCurrency =
        source === "cmc-pos"
          ? "USD"
          : ((data.payment.currency ?? "USD").trim() || "USD").toUpperCase();
      const usdTotalRaw = Number(totalsForPayment.total ?? totalsForPayment.subtotal);
      const usdTotal = Number.isFinite(usdTotalRaw) ? usdTotalRaw : null;
      const paidTotalRaw = Number(totalsForPayment.paid_total);
      const paidCurrency =
        typeof totalsForPayment.paid_currency === "string"
          ? totalsForPayment.paid_currency.trim().toUpperCase()
          : null;
      const totalsCurrency =
        typeof totalsForPayment.currency === "string"
          ? totalsForPayment.currency.trim().toUpperCase()
          : "USD";
      const paymentAmount =
        source !== "cmc-pos" && paymentCurrency === totalsCurrency
          ? usdTotal
          : paymentCurrency === "USD"
            ? usdTotal
            : paidCurrency === paymentCurrency && Number.isFinite(paidTotalRaw)
              ? paidTotalRaw
              : null;
      const paymentAmountUsd =
        source !== "cmc-pos"
          ? paymentCurrency === "USD"
            ? paymentAmount
            : null
          : usdTotal;
      await client.query(
        `INSERT INTO order_payment (order_id, method, status, currency, amount, amount_usd)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (order_id) DO NOTHING`,
        [
          orderId,
          data.payment.method ?? null,
          (data.payment.status && data.payment.status.trim()) || "pending",
          paymentCurrency,
          paymentAmount,
          paymentAmountUsd,
        ],
      );
    }

    // CMC Sales record — an order created from the CMC New Order page
    // (source = 'cmc-pos') is also recorded in CMC Sales as a distinct
    // workflow ('order', vs the POS 'shelf_sale'). The record is dated by the
    // order's CREATION date (fulfilment_date = today), never the delivery
    // date, so the CMC Sales history/audit views count it under the day the
    // order was taken. Status mirrors the payment: paid orders count toward
    // the audit totals immediately; pending ones flip to 'paid' when staff
    // mark the order as paid (mark-paid route in routes/orders.ts).
    if (source === "cmc-pos") {
      const totalsObj = effectiveTotals;
      const rawTotal = Number(totalsObj.total ?? totalsObj.subtotal);
      const saleTotal = Number.isFinite(rawTotal) ? rawTotal : 0;
      const saleLineItems = (data.line_items ?? []).map((li) => ({
        product_id: li.is_custom_item === true ? null : (li.product_id ?? null),
        name: li.name,
        qty: li.quantity > 0 ? li.quantity : 1,
        unit_price: li.unit_price != null ? Number(li.unit_price) : 0,
        image_url: li.image_url ?? null,
        item_type: li.is_custom_item === true ? "custom" : "shelf",
      }));
      const saleStatus =
        (data.payment?.status ?? "").trim().toLowerCase() === "paid" ? "paid" : "pending";
      await client.query(
        `INSERT INTO cmc_sales
           (workspace_owner_id, created_by_user_id, workflow_type, source_channel,
             status, order_id, line_items, subtotal, discount_amount, total,
             discount_type, discount_value, discount_description, payment_method, fulfilment_date)
           VALUES ($1, $2, 'order', 'cmc-pos', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now()::date)`,
        [
          workspaceOwnerId,
          actorUserId ?? "system",
          saleStatus,
          orderId,
          JSON.stringify(saleLineItems),
          itemSubtotal.toFixed(4),
          (cmcDiscount?.amount ?? 0).toFixed(4),
          saleTotal.toFixed(4),
          cmcDiscount?.type ?? null,
          cmcDiscount?.value ?? null,
          cmcDiscount
            ? [cmcDiscount.reason, cmcDiscount.explanation].filter(Boolean).join(": ")
            : null,
          data.payment?.method ?? null,
        ],
      );
    }

    if (cmcDiscount) {
      await client.query(
        `INSERT INTO order_events
           (workspace_owner_id, order_id, event_type, payload, actor_user_id)
         VALUES ($1, $2, 'discount_applied', $3::jsonb, $4)`,
        [workspaceOwnerId, orderId, JSON.stringify(cmcDiscount), actorUserId ?? null],
      );
    }

    // Notes — single row per order.
    const n = data.notes;
    if (n && (n.customer_note || n.florist_note || n.driver_note || n.internal_note)) {
      await client.query(
        `INSERT INTO order_notes
           (order_id, customer_note, florist_note, driver_note, internal_note)
         VALUES ($1,$2,$3,$4,$5)`,
        [
          orderId,
          n.customer_note ?? null,
          n.florist_note ?? null,
          n.driver_note ?? null,
          n.internal_note ?? null,
        ],
      );
    }

    // Keep the canonical association in this transaction. If the link is
    // missing, belongs to another order without confirmation, or differs from
    // the commercial total without confirmation, the entire order rolls back.
    if (data.payment_link_id != null) {
      await linkPaymentLinkToOrderInTransaction(client, {
        workspaceOwnerId,
        linkId: data.payment_link_id,
        orderId,
        actorUserId: actorUserId ?? null,
        confirmMismatch: data.confirm_payment_link_mismatch === true,
        confirmReassignment: data.confirm_payment_link_reassignment === true,
      });
    }

    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* swallow rollback errors */
    }
    if (
      source === "cmc-pos" &&
      data.idempotency_key &&
      typeof err === "object" &&
      err != null &&
      "code" in err &&
      (err as { code?: string }).code === "23505"
    ) {
      const existing = await db.query<{ id: string; display_order_number: string }>(
        `SELECT id, display_order_number
           FROM orders
          WHERE workspace_owner_id = $1
            AND source = 'cmc-pos'
            AND raw_payload->>'idempotency_key' = $2
          LIMIT 1`,
        [workspaceOwnerId, data.idempotency_key],
      );
      const row = existing.rows[0];
      if (row) return { orderId: row.id, displayOrderNumber: row.display_order_number };
    }
    logger.error({ err, workspaceOwnerId }, "createManualOrder: failed to create order");
    throw err;
  } finally {
    client.release();
  }

  // SSE broadcast + outgoing webhook after a successful commit. Mirrors the
  // external ingest so the dashboard order list refreshes in real time.
  if (customerContactId) {
    void refreshPhonePlaceholderContactAfterFirstOrder({
      workspaceOwnerId,
      contactId: customerContactId,
      orderId,
      buyer: {
        firstName: submittedCustomerName?.firstName,
        lastName: submittedCustomerName?.lastName,
        displayName: submittedCustomerName?.displayName,
      },
    });
  }
  broadcastEvent(workspaceOwnerId, {
    event: "order.created",
    workspaceId: workspaceOwnerId,
    data: { id: orderId, source, displayOrderNumber },
  });
  void notifyNewOrderAlerts(workspaceOwnerId, orderId);
  // WhatsApp "order received" notification to the (opted-in) customer contact.
  void notifyOrderStatusWhatsApp(orderId, displayOrderNumber, "created", workspaceOwnerId);
  // Whish payment instructions are independent of the order-received template.
  // The sender claims and persists its own attempt, so creation never waits on
  // Respond.io and duplicate triggers do not duplicate the message.
  void Promise.resolve()
    .then(() => sendWhishPaymentInstructions(orderId, workspaceOwnerId))
    .catch((err) => logger.warn({ err, orderId }, "Whish instructions trigger failed"));
  // Recompute automatic contact tags (vip / corporate / one-time / regular)
  // for the customer contact. Best-effort after commit; never blocks creation.
  if (customerContactId) {
    void applyAutoTagsForContact(workspaceOwnerId, customerContactId);
  }
  // Auto-link the delivery address to the address book (places / order_place_links).
  // Best-effort: errors are logged inside; never throws here.
  void linkOrderToAddressBook(
    orderId,
    workspaceOwnerId,
    data.delivery_address ?? null,
    { deliveryInstructions: data.delivery_instructions ?? null },
  );
  void fireWebhookEvent("order.created", workspaceOwnerId, {
    order_id: orderId,
    external_order_id: null,
    source,
  });

  // Address Collector: collect a missing/placeholder address automatically,
  // while preserving the wizard's explicit collection request behavior.
  // Best-effort after commit — order creation never fails because of it.
  const automaticCollectionEligible =
    (data.status?.trim() || "pending") === "processing";
  if (shouldCollectAddressCollection({
    deliveryAddress: data.delivery_address,
    explicitRequest: data.collect_address,
  }) && (data.collect_address === true || automaticCollectionEligible)) {
    const deliveryAddress =
      data.delivery_address && typeof data.delivery_address === "object"
        ? data.delivery_address as Record<string, unknown>
        : null;
    const recipientName =
      (data.recipient?.display_name && data.recipient.display_name.trim()) ||
      [data.recipient?.first_name, data.recipient?.last_name].filter(Boolean).join(" ").trim() ||
      null;
    void createAddressCollectionRequest({
      workspaceOwnerId,
      orderId,
      recipientName,
      recipientPhone: data.recipient?.phone ?? null,
      preferredLanguage: data.preferred_language ?? null,
      windowStart: data.window_start ? new Date(data.window_start) : null,
      windowEnd: data.window_end ? new Date(data.window_end) : null,
      isExpress: data.delivery_type?.trim().toLowerCase() === "express",
      deliveryCountryCode:
        typeof deliveryAddress?.countryCode === "string"
          ? deliveryAddress.countryCode
          : typeof deliveryAddress?.country_code === "string"
            ? deliveryAddress.country_code
            : null,
      explicitRequest: data.collect_address,
      source: "wizard",
    }).catch((err) => {
      logger.warn({ err, orderId }, "addressCollector: request creation failed (wizard)");
    });
  }

  // Push the delivery to Tookan, mirroring the external-order ingest path so a
  // manually-created order also produces a driver task carrying the address,
  // recipient, items, scheduled window, and gift-card message. Best-effort by
  // contract: any failure is persisted on the order (tookan_status='failed')
  // and never surfaced to the dashboard create-order flow. The delivery contact
  // falls back to the customer when no separate recipient was supplied.
  //
  // Whish exception: a manually-created Whish order that is not already paid
  // must NOT get a Tookan task yet — the money hasn't been transferred. It is
  // parked in the `awaiting_payment` Tookan state instead; the task is created
  // automatically when staff mark the order as paid (mark-paid route in
  // routes/orders.ts). Mirrors the external-ingest gating exactly.
  const whishAwaitingPayment =
    isWhishPayment(data.payment?.method, null) &&
    (data.payment?.status ?? "").trim().toLowerCase() !== "paid";
  if (isTookanEnabled() && whishAwaitingPayment) {
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
  if (isTookanEnabled() && !whishAwaitingPayment) {
    const tookanRecipient: RecipientForTookan = {
      display_name:
        (data.recipient?.display_name && data.recipient.display_name.trim()) ||
        [data.recipient?.first_name, data.recipient?.last_name].filter(Boolean).join(" ") ||
        (data.customer?.display_name && data.customer.display_name.trim()) ||
        [data.customer?.first_name, data.customer?.last_name].filter(Boolean).join(" ") ||
        null,
      phone: data.recipient?.phone ?? data.customer?.phone ?? null,
      email: data.recipient?.email ?? data.customer?.email ?? null,
    };
    const tookanOrder: OrderForTookan = {
      id: orderId,
      display_order_number: displayOrderNumber,
      external_order_id: null,
      delivery_address:
        data.delivery_address != null
          ? (data.delivery_address as Record<string, unknown>)
          : null,
      window_start: data.window_start ? new Date(data.window_start).toISOString() : null,
      window_end: data.window_end ? new Date(data.window_end).toISOString() : null,
      delivery_instructions: data.delivery_instructions ?? null,
      card_message: data.card_message ?? null,
    };
    const tookanLineItems: LineItemForTookan[] = (data.line_items ?? []).map((li) => ({
      name: li.name,
      quantity: li.quantity > 0 ? li.quantity : 1,
    }));

    void (async () => {
      try {
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
          "tookan: delivery task created after manual order create",
        );
        void syncApprovedFloristPhotoForOrderToTookan(orderId, workspaceOwnerId);
        void recordTookanInvitationComm({
          workspaceOwnerId,
          orderId,
          recipientName: tookanRecipient.display_name,
          recipientEmail: tookanRecipient.email,
        });
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
          "tookan: delivery task creation failed after manual order create; order is unaffected",
        );
      }
    })();
  }

  // Slack new-order notification for UAE orders — best-effort, never throws,
  // routed by delivery city (Abu Dhabi vs Dubai). Non-UAE orders are skipped
  // inside the helper. Mirrors the Tookan / email side-effect contract.
  void notifyNewUaeOrderToSlack({ orderId, workspaceOwnerId });

  return { orderId, displayOrderNumber };
}
