/**
 * Address Collector — request lifecycle service.
 *
 * Creation (idempotent per order), state transitions with activity events,
 * schedule (re)computation, cancellation, and address submission handling.
 * All provider I/O lives in providers.ts; all timing math in schedule.ts.
 */
import { db } from "../db";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import { logger } from "../logger";
import { normalizePhoneForCountry } from "../respondio";
import { generateAddressToken } from "./tokens";
import {
  computeSchedule,
  parseDateSlotToWindow,
  resolveDeliveryTimezone,
  type PlannedAction,
} from "./schedule";
import { quietHours } from "./config";
import {
  hasUsableDeliveryAddress,
  shouldCollectAddressCollection,
} from "./eligibility";

export { hasUsableDeliveryAddress } from "./eligibility";

const HOUR = 3600_000;

/** Statuses in which outreach is still meaningful. */
export const ACTIVE_STATUSES = [
  "awaiting_address",
  "processing",
  "scheduled",
  "whatsapp_queued",
  "whatsapp_sent",
  "whatsapp_delivered",
  "whatsapp_failed",
  "sms_fallback_sent",
  "link_opened",
  "in_progress",
  "escalated",
  "needs_review",
  "failed",
] as const;

export const TERMINAL_STATUSES = ["resolved", "address_received", "verified", "cancelled", "expired"] as const;
export const TERMINAL_ORDER_STATUSES = ["completed", "delivered", "cancelled", "refunded"] as const;

export type AddressCollectionResolutionOutcome =
  | "automatic_collection"
  | "manual_resolution"
  | "order_delivered"
  | "order_cancelled"
  | "order_deleted"
  | "failed";

type QueryClient = {
  query<T extends QueryResultRow = any>(text: string, values?: any[]): Promise<QueryResult<T>>;
  connect?: () => Promise<any>;
  release?: () => void;
};

export function isActiveStatus(status: string): boolean {
  return (ACTIVE_STATUSES as readonly string[]).includes(status);
}

export type RequestRow = {
  id: string;
  workspace_owner_id: string;
  order_id: string | null;
  recipient_name: string;
  recipient_phone: string;
  preferred_language: string;
  status: string;
  risk_level: string;
  token_hash: string;
  token_expires_at: string;
  window_start: string | null;
  window_end: string | null;
  delivery_timezone: string;
  delivery_country_code: string | null;
  sms_opt_out: boolean;
  respondio_contact_id: string | null;
  respondio_channel_id: string | null;
  source: string;
  link_first_opened_at: string | null;
  address_received_at: string | null;
  whatsapp_template_attempted_at: string | null;
  whatsapp_template_provider_ref: string | null;
  whatsapp_template_status: string | null;
  created_at: string;
  closed_at?: string | null;
  resolution_outcome?: AddressCollectionResolutionOutcome | null;
};

/**
 * Atomically reserve the request's one WhatsApp template attempt.
 *
 * The request row is the durable concurrency boundary. Existing terminal
 * action records are also consulted so requests created before the guard was
 * deployed cannot be sent again merely because their new columns are null.
 */
export async function claimWhatsappTemplateAttempt(opts: {
  requestId: string;
  actionId?: string | null;
  attemptedAt?: Date;
}): Promise<boolean> {
  const r = await db.query<{ id: string }>(
    `UPDATE address_collection_requests r
        SET whatsapp_template_attempted_at = $3,
            whatsapp_template_status = 'attempting',
            updated_at = now()
      WHERE r.id = $1
        AND r.closed_at IS NULL
        AND r.status = ANY($4::text[])
        AND r.whatsapp_template_attempted_at IS NULL
        AND (
          r.order_id IS NULL
          OR EXISTS (
            SELECT 1
              FROM orders o
             WHERE o.id = r.order_id
               AND o.workspace_owner_id = r.workspace_owner_id
               AND o.status <> ALL($5::text[])
          )
        )
        AND NOT EXISTS (
          SELECT 1
            FROM address_collection_actions a
           WHERE a.request_id = r.id
             AND a.channel = 'whatsapp'
             AND a.status IN ('sent', 'failed', 'blocked')
             AND ($2::text IS NULL OR a.id::text <> $2)
        )
      RETURNING r.id`,
    [
      opts.requestId,
      opts.actionId ?? null,
      (opts.attemptedAt ?? new Date()).toISOString(),
      ACTIVE_STATUSES,
      TERMINAL_ORDER_STATUSES,
    ],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Release the guard only when the provider confirms no template dispatch was attempted. */
export async function releaseWhatsappTemplateAttempt(requestId: string, reason: string): Promise<void> {
  await db.query(
    `UPDATE address_collection_requests
        SET whatsapp_template_attempted_at = NULL,
            whatsapp_template_status = 'pre_send_failed',
            updated_at = now()
      WHERE id = $1
        AND whatsapp_template_status = 'attempting'
        AND whatsapp_template_provider_ref IS NULL`,
    [requestId],
  );
  await recordCollectionEvent({
    requestId,
    eventType: "whatsapp_pre_send_failed",
    channel: "whatsapp",
    metadata: { reason },
  });
}

export async function recordWhatsappTemplateOutcome(opts: {
  requestId: string;
  status: string;
  providerRef?: string | null;
}): Promise<void> {
  await db.query(
    `UPDATE address_collection_requests
        SET whatsapp_template_status = $2,
            whatsapp_template_provider_ref = COALESCE($3, whatsapp_template_provider_ref),
            updated_at = now()
      WHERE id = $1`,
    [opts.requestId, opts.status, opts.providerRef ?? null],
  );
}

export async function recordCollectionEvent(opts: {
  requestId: string;
  eventType: string;
  previousState?: string | null;
  newState?: string | null;
  actor?: string;
  channel?: string | null;
  providerRef?: string | null;
  metadata?: Record<string, unknown> | null;
}, client: QueryClient = db, strict = false): Promise<void> {
  try {
    await client.query(
      `INSERT INTO address_collection_events
         (request_id, event_type, previous_state, new_state, actor, channel, provider_ref, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        opts.requestId,
        opts.eventType,
        opts.previousState ?? null,
        opts.newState ?? null,
        opts.actor ?? "system",
        opts.channel ?? null,
        opts.providerRef ?? null,
        opts.metadata != null ? JSON.stringify(opts.metadata) : null,
      ],
    );
  } catch (err) {
    logger.warn({ err, requestId: opts.requestId }, "addressCollector: failed to record event");
    if (strict) throw err;
  }
}

/** Transition the request status, writing an activity event. */
export async function transitionRequestStatus(opts: {
  requestId: string;
  newStatus: string;
  actor?: string;
  channel?: string | null;
  providerRef?: string | null;
  metadata?: Record<string, unknown> | null;
  /** Only transition when the current status is one of these (guards races). */
  onlyFrom?: readonly string[];
  extraSet?: string; // additional SET fragment, e.g. "escalated_at = now()"
}, client: QueryClient = db): Promise<boolean> {
  const guard = opts.onlyFrom?.length
    ? `AND status = ANY($3::text[])`
    : "";
  const params: unknown[] = [opts.newStatus, opts.requestId];
  if (opts.onlyFrom?.length) params.push(opts.onlyFrom as string[]);
  const r = await client.query<{ status: string }>(
    `UPDATE address_collection_requests
        SET status = $1, updated_at = now()${opts.extraSet ? `, ${opts.extraSet}` : ""}
      WHERE id = $2 ${guard}
      RETURNING status`,
    params,
  );
  if (r.rowCount === 0) return false;
  await recordCollectionEvent({
    requestId: opts.requestId,
    eventType: "status_changed",
    newState: opts.newStatus,
    actor: opts.actor ?? "system",
    channel: opts.channel ?? null,
    providerRef: opts.providerRef ?? null,
    metadata: opts.metadata ?? null,
  }, client);
  return true;
}

/** Insert scheduled actions with idempotency keys (ON CONFLICT DO NOTHING). */
async function insertActions(
  requestId: string,
  planned: PlannedAction[],
  generation: number,
): Promise<void> {
  for (const p of planned) {
    const channel =
      p.type === "escalation" || p.type === "wa_delivery_check"
        ? "internal"
        : p.type === "sms_fallback"
          ? "sms"
          : "whatsapp";
    await db.query(
      `INSERT INTO address_collection_actions
         (request_id, action_type, channel, scheduled_at, idempotency_key, triggering_rule)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [requestId, p.type, channel, p.at.toISOString(), `${requestId}:${p.type}:g${generation}`, p.rule],
    );
  }
}

export type CreateRequestInput = {
  workspaceOwnerId: string;
  orderId: string;
  recipientName: string | null | undefined;
  recipientPhone: string | null | undefined;
  preferredLanguage?: string | null;
  windowStart?: Date | null;
  windowEnd?: Date | null;
  /** Fallback when no window timestamps exist (external orders). */
  deliveryDate?: string | null;
  deliverySlot?: string | null;
  deliveryCountryCode?: string | null;
  isExpress?: boolean | null;
  /** An explicit business request may collect even when an address is present. */
  explicitRequest?: boolean | null;
  source: "wizard" | "external" | "ops";
};

export type CreateRequestResult =
  | { created: true; requestId: string; token: string }
  | {
      created: false;
      reason:
        | "duplicate"
        | "missing_recipient"
        | "invalid_phone"
        | "address_present"
        | "order_not_eligible";
      requestId?: string;
    };

type AutomaticRequestOrderRow = {
  status: string;
  delivery_address: Record<string, unknown> | null;
  delivery_type: string | null;
  window_start: string | null;
  window_end: string | null;
  source: string | null;
  raw_payload: Record<string, unknown> | null;
  recipient_name: string | null;
  recipient_phone: string | null;
};

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/**
 * Re-run automatic missing-address collection after an order is promoted to
 * processing. This is intentionally a lookup by order id so every promotion
 * path uses the same recipient, delivery, and idempotency rules as creation.
 */
export async function createAutomaticAddressCollectionRequest(opts: {
  workspaceOwnerId: string;
  orderId: string;
}): Promise<CreateRequestResult> {
  const result = await db.query<AutomaticRequestOrderRow>(
    `SELECT o.status, o.delivery_address, o.delivery_type,
            o.window_start, o.window_end, o.source, o.raw_payload,
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
    [opts.orderId, opts.workspaceOwnerId],
  );
  const order = result.rows[0];
  if (!order || order.status !== "processing") {
    return { created: false, reason: "order_not_eligible" };
  }

  const address = order.delivery_address ?? {};
  const rawDelivery =
    order.raw_payload?.delivery && typeof order.raw_payload.delivery === "object"
      ? order.raw_payload.delivery as Record<string, unknown>
      : {};
  const rawDeliveryAddress =
    order.raw_payload?.delivery_address && typeof order.raw_payload.delivery_address === "object"
      ? order.raw_payload.delivery_address as Record<string, unknown>
      : {};
  const deliveryDate = firstString(
    address.date,
    address.deliveryDate,
    address.delivery_date,
    rawDelivery.date,
    rawDelivery.deliveryDate,
    rawDelivery.delivery_date,
    rawDeliveryAddress.date,
    rawDeliveryAddress.deliveryDate,
    rawDeliveryAddress.delivery_date,
    order.raw_payload?.deliveryDate,
    order.raw_payload?.delivery_date,
  );
  const deliverySlot = firstString(
    address.slot,
    address.deliverySlot,
    address.delivery_slot,
    rawDelivery.slot,
    rawDelivery.deliverySlot,
    rawDelivery.delivery_slot,
    rawDelivery.timeSlot,
    rawDeliveryAddress.slot,
    rawDeliveryAddress.deliverySlot,
    rawDeliveryAddress.delivery_slot,
    rawDeliveryAddress.timeSlot,
    order.raw_payload?.deliverySlot,
    order.raw_payload?.delivery_slot,
    order.raw_payload?.timeSlot,
  );
  const deliveryCountryCode = firstString(
    address.countryCode,
    address.country_code,
    address.country,
    rawDelivery.countryCode,
    rawDelivery.country_code,
    rawDeliveryAddress.countryCode,
    rawDeliveryAddress.country_code,
  );
  const preferredLanguage = firstString(
    rawDelivery.preferredLanguage,
    rawDelivery.preferred_language,
    rawDeliveryAddress.preferredLanguage,
    rawDeliveryAddress.preferred_language,
  );
  const source = order.source === "external" ? "external" : "wizard";

  return createAddressCollectionRequest({
    workspaceOwnerId: opts.workspaceOwnerId,
    orderId: opts.orderId,
    recipientName: order.recipient_name,
    recipientPhone: order.recipient_phone,
    preferredLanguage,
    windowStart: order.window_start ? new Date(order.window_start) : null,
    windowEnd: order.window_end ? new Date(order.window_end) : null,
    deliveryDate,
    deliverySlot,
    deliveryCountryCode,
    isExpress: order.delivery_type?.trim().toLowerCase() === "express",
    explicitRequest: false,
    source,
  });
}

/**
 * Create the (single) active address-collection request for an order.
 * Idempotent: a second call for the same order is a no-op. Recipient name +
 * phone are required; the phone is normalized to E.164. An invalid phone
 * still creates the request — in `needs_review` with no outreach — so ops
 * sees it in "Needs attention" instead of it silently disappearing.
 */
export async function createAddressCollectionRequest(
  input: CreateRequestInput,
): Promise<CreateRequestResult> {
  const name = (input.recipientName ?? "").trim();
  const rawPhone = (input.recipientPhone ?? "").trim();
  if (!name || !rawPhone) {
    logger.warn(
      { orderId: input.orderId, hasName: !!name, hasPhone: !!rawPhone },
      "addressCollector: cannot create request without recipient name + phone",
    );
    return { created: false, reason: "missing_recipient" };
  }

  const orderResult = await db.query<{
    status: string;
    delivery_address: Record<string, unknown> | null;
  }>(
    `SELECT status, delivery_address
       FROM orders
      WHERE id = $1 AND workspace_owner_id = $2
      LIMIT 1`,
    [input.orderId, input.workspaceOwnerId],
  );
  const order = orderResult.rows[0];
  if (!order || (TERMINAL_ORDER_STATUSES as readonly string[]).includes(order.status)) {
    logger.warn(
      { orderId: input.orderId, orderFound: Boolean(order), orderStatus: order?.status ?? null },
      "addressCollector: order is not eligible for request creation",
    );
    return { created: false, reason: "order_not_eligible" };
  }
  if (input.explicitRequest !== true && order.status !== "processing") {
    logger.info(
      { orderId: input.orderId, orderStatus: order.status },
      "addressCollector: automatic request deferred until order is processing",
    );
    return { created: false, reason: "order_not_eligible" };
  }
  if (!shouldCollectAddressCollection({
    deliveryAddress: order.delivery_address,
    explicitRequest: input.explicitRequest,
  })) {
    logger.info(
      { orderId: input.orderId },
      "addressCollector: request not created because order has a usable delivery address",
    );
    return { created: false, reason: "address_present" };
  }

  const phone = normalizePhoneForCountry(rawPhone, input.deliveryCountryCode);
  const phoneValid = Boolean(phone);

  const timezone = resolveDeliveryTimezone(input.deliveryCountryCode);
  let windowStart = input.windowStart ?? null;
  let windowEnd = input.windowEnd ?? null;
  if (!windowStart && input.deliveryDate) {
    const parsed = parseDateSlotToWindow(input.deliveryDate, input.deliverySlot, timezone);
    windowStart = parsed.windowStart;
    windowEnd = windowEnd ?? parsed.windowEnd;
  }

  const now = new Date();
  const { token, tokenHash } = generateAddressToken();
  // Token lives until 24h after the window end (or 72h without a window).
  const expiresAt = windowEnd
    ? new Date(windowEnd.getTime() + 24 * HOUR)
    : new Date(now.getTime() + 72 * HOUR);
  const language = input.preferredLanguage === "ar" ? "ar" : "en";
  const status = phoneValid ? "awaiting_address" : "needs_review";

  const inserted = await db.query<{ id: string }>(
    `INSERT INTO address_collection_requests
       (workspace_owner_id, order_id, recipient_name, recipient_phone, preferred_language,
        status, risk_level, token_hash, token_expires_at, window_start, window_end,
         address_deadline, delivery_timezone, delivery_country_code, source)
       SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15
         FROM orders o
        WHERE o.id = $2
          AND o.workspace_owner_id = $1
          AND o.status <> ALL($16::text[])
     ON CONFLICT (order_id)
       WHERE order_id IS NOT NULL
          AND closed_at IS NULL
          AND status NOT IN ('resolved', 'address_received', 'verified', 'cancelled', 'expired')
     DO NOTHING
     RETURNING id`,
    [
      input.workspaceOwnerId,
      input.orderId,
      name,
      phone ?? rawPhone,
      language,
      status,
      phoneValid ? "normal" : "at_risk",
      tokenHash,
      expiresAt.toISOString(),
      windowStart?.toISOString() ?? null,
      windowEnd?.toISOString() ?? null,
      windowStart ? new Date(windowStart.getTime() - 45 * 60_000).toISOString() : null,
      timezone,
      input.deliveryCountryCode?.trim().toUpperCase() || null,
      input.source,
      TERMINAL_ORDER_STATUSES,
    ],
  );
  const row = inserted.rows[0];
  if (!row) {
    const existing = await db.query<{ id: string }>(
      `SELECT id
         FROM address_collection_requests
        WHERE order_id = $1
          AND workspace_owner_id = $2
          AND closed_at IS NULL
          AND status NOT IN ('resolved', 'address_received', 'verified', 'cancelled', 'expired')
        ORDER BY created_at DESC
        LIMIT 1`,
      [input.orderId, input.workspaceOwnerId],
    );
    const existingRequest = existing.rows[0];
    if (existingRequest) {
      logger.info(
        { orderId: input.orderId, requestId: existingRequest.id },
        "addressCollector: active request already exists (idempotent no-op)",
      );
      return { created: false, reason: "duplicate", requestId: existingRequest.id };
    }

    logger.warn(
      { orderId: input.orderId },
      "addressCollector: request insert guard no longer matched the order",
    );
    return { created: false, reason: "order_not_eligible" };
  }

  await recordCollectionEvent({
    requestId: row.id,
    eventType: "request_created",
    newState: status,
    metadata: {
      source: input.source,
      phone_valid: phoneValid,
      window_start: windowStart?.toISOString() ?? null,
      timezone,
    },
  });

  if (phoneValid) {
    const planned = computeSchedule({
      now,
      windowStart,
      timezone,
      isExpress: input.isExpress === true,
      quietHours: quietHours(),
    });
    await insertActions(row.id, planned, 1);
    await transitionRequestStatus({
      requestId: row.id,
      newStatus: "scheduled",
      onlyFrom: ["awaiting_address"],
      metadata: { source: input.source },
    });
    await recordCollectionEvent({
      requestId: row.id,
      eventType: "schedule_computed",
      metadata: { plan: planned.map((p) => ({ type: p.type, at: p.at.toISOString(), rule: p.rule })) },
    });
  } else {
    await recordCollectionEvent({
      requestId: row.id,
      eventType: "phone_invalid",
      metadata: { note: "Recipient phone could not be normalized to E.164; manual follow-up required" },
    });
  }

  logger.info(
    { orderId: input.orderId, requestId: row.id, phoneValid },
    "addressCollector: collection request created",
  );
  return { created: true, requestId: row.id, token };
}

export type RespondIoTemplateSend = {
  providerMessageId: string;
  workspaceOwnerId: string;
  contactId: string;
  channelId: string | null;
  recipientPhone: string;
  recipientName: string;
  languageCode: string;
  sentAt: Date;
};

/**
 * Record a template that was sent from Respond.io itself. This intentionally
 * creates no pending action: the provider already sent the message, so the OS
 * worker must never send it a second time. The contact and provider message
 * indexes make retries and concurrent webhook deliveries idempotent.
 */
export async function ingestRespondIoTemplateSend(
  input: RespondIoTemplateSend,
): Promise<{ requestId: string; duplicate: boolean }> {
  const existingAction = await db.query<{ request_id: string }>(
    `SELECT request_id FROM address_collection_actions WHERE provider_ref = $1 LIMIT 1`,
    [input.providerMessageId],
  );
  if (existingAction.rows[0]) {
    const requestId = existingAction.rows[0].request_id;
    await db.query(
      `UPDATE address_collection_requests
          SET whatsapp_template_attempted_at = COALESCE(whatsapp_template_attempted_at, $2),
              whatsapp_template_provider_ref = COALESCE(whatsapp_template_provider_ref, $3),
              whatsapp_template_status = 'sent',
              status = CASE
                WHEN status IN ('awaiting_address', 'scheduled', 'whatsapp_queued', 'needs_review')
                  THEN 'whatsapp_sent'
                ELSE status
              END,
              updated_at = now()
        WHERE id = $1`,
      [requestId, input.sentAt.toISOString(), input.providerMessageId],
    );
    return { requestId, duplicate: true };
  }

  const normalizedPhone = normalizePhoneForCountry(input.recipientPhone) ?? input.recipientPhone.trim();
  const existingRequest = await db.query<{ id: string; order_id: string | null; source: string }>(
    `SELECT id, order_id, source
       FROM address_collection_requests
      WHERE workspace_owner_id = $1
        AND status NOT IN ('resolved', 'address_received', 'verified', 'cancelled', 'expired')
        AND (
          respondio_contact_id = $2
          OR recipient_phone = $3
        )
      ORDER BY (respondio_contact_id = $2) DESC, created_at DESC
      LIMIT 2`,
    [input.workspaceOwnerId, input.contactId, normalizedPhone],
  );
  // A provider event with no exact message reference can enrich an active
  // request only when the receiver identifies exactly one candidate. Two
  // simultaneous orders for the same contact are intentionally not guessed.
  const matchedRequest = existingRequest.rows.length === 1 ? existingRequest.rows[0] : null;
  let requestId = matchedRequest?.id;
  if (!requestId) {
    const { tokenHash } = generateAddressToken();
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO address_collection_requests
         (workspace_owner_id, order_id, recipient_name, recipient_phone,
          preferred_language, status, risk_level, token_hash, token_expires_at,
          delivery_timezone, respondio_contact_id, respondio_channel_id, source,
          last_contact_at, last_contact_channel)
       VALUES ($1, NULL, $2, $3, $4, 'awaiting_address', 'normal', $5,
               now() + interval '72 hours', 'Asia/Beirut', $6, $7, 'respondio',
               $8, 'whatsapp')
       ON CONFLICT (workspace_owner_id, respondio_contact_id)
         WHERE source = 'respondio'
           AND respondio_contact_id IS NOT NULL
           AND status NOT IN ('resolved', 'address_received', 'verified', 'cancelled', 'expired')
       DO NOTHING
       RETURNING id`,
      [
        input.workspaceOwnerId,
        input.recipientName.trim() || "Unknown recipient",
        normalizedPhone,
        input.languageCode === "ar" ? "ar" : "en",
        tokenHash,
        input.contactId,
        input.channelId,
        input.sentAt.toISOString(),
      ],
    );
    requestId = inserted.rows[0]?.id;
    if (requestId) {
      await recordCollectionEvent({
        requestId,
        eventType: "request_created",
        newState: "awaiting_address",
        channel: "whatsapp",
        providerRef: input.providerMessageId,
        metadata: { source: "respondio", template_send: true },
      });
    } else {
      const raced = await db.query<{ id: string }>(
        `SELECT id FROM address_collection_requests
          WHERE workspace_owner_id = $1 AND respondio_contact_id = $2
            AND source = 'respondio'
            AND status NOT IN ('resolved', 'address_received', 'verified', 'cancelled', 'expired')
          LIMIT 1`,
        [input.workspaceOwnerId, input.contactId],
      );
      requestId = raced.rows[0]?.id;
    }
  }
  if (!requestId) throw new Error("Unable to associate Respond.io template send");

  // The request-level gate and provider action must be one atomic statement:
  // a crash can happen after this commits, but can never leave an orphaned
  // `attempting` request without the provider reference needed for replay.
  const action = await db.query<{ request_id: string }>(
    `WITH claimed AS (
       UPDATE address_collection_requests r
          SET whatsapp_template_attempted_at = $2,
              whatsapp_template_provider_ref = $4,
              whatsapp_template_status = 'sent',
              recipient_name = CASE
                WHEN recipient_name = '' OR recipient_name = 'Unknown recipient' THEN $5
                ELSE recipient_name
              END,
              respondio_contact_id = COALESCE(respondio_contact_id, $6),
              respondio_channel_id = COALESCE(respondio_channel_id, $7),
              last_contact_at = $2,
              last_contact_channel = 'whatsapp',
              status = CASE
                WHEN r.status IN ('awaiting_address', 'scheduled', 'whatsapp_queued', 'needs_review')
                  THEN 'whatsapp_sent'
                ELSE r.status
              END,
              risk_level = CASE WHEN r.status = 'needs_review' THEN 'normal' ELSE r.risk_level END,
              updated_at = now()
        WHERE r.id = $1
          AND r.whatsapp_template_attempted_at IS NULL
          AND NOT EXISTS (
            SELECT 1
              FROM address_collection_actions prior
             WHERE prior.request_id = r.id
               AND prior.channel = 'whatsapp'
               AND prior.status IN ('sent', 'failed', 'blocked')
          )
        RETURNING r.id
     )
     INSERT INTO address_collection_actions
       (request_id, action_type, channel, scheduled_at, status, idempotency_key,
        provider_ref, provider_status, sent_at, triggering_rule)
     SELECT id, 'template_send', 'whatsapp', $2, 'sent', $3, $4, 'sent', $2,
            'respondio:manual_template'
       FROM claimed
     RETURNING request_id`,
    [
      requestId,
      input.sentAt.toISOString(),
      `respondio:${input.providerMessageId}`,
      input.providerMessageId,
      input.recipientName.trim() || "Unknown recipient",
      input.contactId,
      input.channelId,
    ],
  );
  if ((action.rowCount ?? 0) === 0) {
    await recordCollectionEvent({
      requestId,
      eventType: "whatsapp_outreach_suppressed",
      channel: "whatsapp",
      providerRef: input.providerMessageId,
      metadata: { reason: "request_already_attempted", source: "respondio" },
    });
    return { requestId, duplicate: true };
  }
  await recordCollectionEvent({
    requestId,
    eventType: "whatsapp_outreach_attempted",
    channel: "whatsapp",
    providerRef: input.providerMessageId,
    metadata: { source: "respondio" },
  });

  if (matchedRequest?.order_id) {
    await db.query(
      `UPDATE address_collection_actions
          SET status = 'cancelled', updated_at = now(),
              error_message = COALESCE(error_message, 'superseded by manual respond.io send')
        WHERE request_id = $1
          AND channel = 'whatsapp'
          AND status IN ('pending', 'blocked', 'processing')`,
      [requestId],
    );
  }
  await recordCollectionEvent({
    requestId,
    eventType: "message_sent",
    channel: "whatsapp",
    providerRef: input.providerMessageId,
    metadata: { action_type: "template_send", provider_status: "sent", source: "respondio" },
  });
  return { requestId, duplicate: false };
}

/** Cancel all pending/blocked actions for a request. Returns count. */
export async function cancelPendingActions(requestId: string, reason: string): Promise<number> {
  return cancelPendingActionsWithClient(db, requestId, reason);
}

async function cancelPendingActionsWithClient(
  client: QueryClient,
  requestId: string,
  reason: string,
): Promise<number> {
  const r = await client.query(
    `UPDATE address_collection_actions
        SET status = 'cancelled', updated_at = now(), error_message = COALESCE(error_message, $2)
      WHERE request_id = $1 AND status IN ('pending', 'blocked', 'processing')`,
    [requestId, reason],
  );
  return r.rowCount ?? 0;
}

const OUTCOME_STATUS: Record<AddressCollectionResolutionOutcome, string> = {
  automatic_collection: "address_received",
  manual_resolution: "resolved",
  order_delivered: "resolved",
  order_cancelled: "cancelled",
  order_deleted: "cancelled",
  failed: "expired",
};

export async function finalizeAddressCollectionForOrder(
  client: QueryClient,
  opts: {
    orderId: string;
    workspaceOwnerId: string;
    outcome: AddressCollectionResolutionOutcome;
    reason: string;
    source: string;
    actor?: string;
  },
): Promise<number> {
  if (client.connect && !client.release) {
    const transactionClient = await client.connect();
    try {
      await transactionClient.query("BEGIN");
      const count = await finalizeAddressCollectionForOrder(transactionClient, opts);
      await transactionClient.query("COMMIT");
      return count;
    } catch (error) {
      await transactionClient.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      transactionClient.release();
    }
  }
  await client.query(
    `SELECT id FROM orders WHERE id = $1 AND workspace_owner_id = $2 FOR UPDATE`,
    [opts.orderId, opts.workspaceOwnerId],
  );
  const requests = await client.query<{ id: string; status: string }>(
    `UPDATE address_collection_requests
        SET status = $3,
            resolution_outcome = $4,
            closure_reason = $5,
            closure_source = $6,
            closed_at = now(),
            resolved_at = CASE WHEN $4 IN ('automatic_collection','manual_resolution','order_delivered') THEN COALESCE(resolved_at, now()) ELSE resolved_at END,
             cancelled_at = CASE WHEN $4 IN ('order_cancelled','order_deleted') THEN COALESCE(cancelled_at, now()) ELSE cancelled_at END,
            token_expires_at = LEAST(token_expires_at, now()),
            risk_level = 'normal',
            updated_at = now()
      WHERE order_id = $1
        AND workspace_owner_id = $2
        AND closed_at IS NULL
        AND status <> ALL($7::text[])
      RETURNING id, status`,
    [
      opts.orderId,
      opts.workspaceOwnerId,
      OUTCOME_STATUS[opts.outcome],
      opts.outcome,
      opts.reason,
      opts.source,
      TERMINAL_STATUSES,
    ],
  );
  for (const request of requests.rows) {
    const cancelledActions = await cancelPendingActionsWithClient(client, request.id, opts.reason);
    await recordCollectionEvent({
      requestId: request.id,
      eventType: "request_closed",
      previousState: request.status,
      newState: OUTCOME_STATUS[opts.outcome],
      actor: opts.actor ?? "system",
      metadata: {
        outcome: opts.outcome,
        reason: opts.reason,
        source: opts.source,
        cancelled_actions: cancelledActions,
      },
    }, client, true);
  }
  return requests.rowCount ?? 0;
}

/**
 * Terminally closes a bounded batch of requests whose exact linked order no
 * longer exists. The request/order relationship is never changed or inferred.
 */
export async function reconcileOrphanedAddressCollectionRequests(
  client: QueryClient = db,
  batchSize = 100,
): Promise<number> {
  const safeBatchSize = Math.max(1, Math.min(500, Math.trunc(batchSize)));
  if (client.connect && !client.release) {
    const transactionClient = await client.connect();
    try {
      await transactionClient.query("BEGIN");
      const count = await reconcileOrphanedAddressCollectionRequests(
        transactionClient,
        safeBatchSize,
      );
      await transactionClient.query("COMMIT");
      return count;
    } catch (error) {
      await transactionClient.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      transactionClient.release();
    }
  }

  const requests = await client.query<{ id: string; previous_status: string }>(
    `WITH candidates AS (
       SELECT r.id, r.status
         FROM address_collection_requests r
        WHERE r.order_id IS NOT NULL
          AND r.closed_at IS NULL
          AND r.status <> ALL($2::text[])
          AND NOT EXISTS (
            SELECT 1
              FROM orders o
             WHERE o.id = r.order_id
               AND o.workspace_owner_id = r.workspace_owner_id
          )
        ORDER BY r.created_at
        FOR UPDATE OF r SKIP LOCKED
        LIMIT $1
     )
     UPDATE address_collection_requests r
        SET status = 'cancelled',
            resolution_outcome = 'order_deleted',
            closure_reason = 'Linked order no longer exists',
            closure_source = 'orphan_reconciliation',
            closed_at = now(),
            cancelled_at = COALESCE(cancelled_at, now()),
            token_expires_at = LEAST(token_expires_at, now()),
            risk_level = 'normal',
            updated_at = now()
       FROM candidates c
      WHERE r.id = c.id
      RETURNING r.id, c.status AS previous_status`,
    [safeBatchSize, TERMINAL_STATUSES],
  );

  for (const request of requests.rows) {
    const cancelledActions = await cancelPendingActionsWithClient(
      client,
      request.id,
      "Linked order no longer exists",
    );
    await recordCollectionEvent({
      requestId: request.id,
      eventType: "request_closed",
      previousState: request.previous_status,
      newState: "cancelled",
      actor: "system",
      metadata: {
        outcome: "order_deleted",
        reason: "Linked order no longer exists",
        source: "orphan_reconciliation",
        cancelled_actions: cancelledActions,
      },
    }, client, true);
  }
  return requests.rowCount ?? 0;
}

/**
 * Cancel the active request for an order (order cancelled). Invalidate the
 * token and stop all outreach.
 */
export async function cancelAddressCollectionForOrder(
  orderId: string,
  reason: string,
): Promise<void> {
  try {
    const closed = await db.query<{ id: string; status: string }>(
      `UPDATE address_collection_requests
          SET status = 'cancelled',
              resolution_outcome = 'order_cancelled',
              closure_reason = $2,
              closure_source = 'legacy_cancel_helper',
              closed_at = now(),
              cancelled_at = COALESCE(cancelled_at, now()),
              token_expires_at = now(),
              updated_at = now()
        WHERE order_id = $1
          AND closed_at IS NULL
          AND status = ANY($3::text[])
        RETURNING id, status`,
      [orderId, reason, ACTIVE_STATUSES],
    );
    for (const request of closed.rows) {
      await db.query(
        `UPDATE address_collection_actions
            SET status = 'cancelled', error_message = $2,
                processing_started_at = NULL, updated_at = now()
          WHERE request_id = $1
            AND status IN ('pending','processing','blocked')`,
        [request.id, reason],
      );
      await recordCollectionEvent({
        requestId: request.id,
        eventType: "request_closed",
        metadata: {
          outcome: "order_cancelled",
          reason,
          source: "legacy_cancel_helper",
          actor: "system",
        },
      });
    }
  } catch (err) {
    logger.warn({ err, orderId }, "addressCollector: cancel-for-order failed");
  }
}

/**
 * Recompute pending outreach after the order's delivery window changed.
 * Cancels not-yet-run actions and inserts a fresh generation of actions.
 */
export async function recalcScheduleForOrder(
  orderId: string,
  windowStart: Date | null,
  windowEnd: Date | null,
): Promise<void> {
  try {
    const r = await db.query<RequestRow & { order_delivery_type: string | null }>(
      `SELECT r.*, o.delivery_type AS order_delivery_type /* SELECT * FROM address_collection_requests */
         FROM address_collection_requests r
         JOIN orders o ON o.id = r.order_id AND o.workspace_owner_id = r.workspace_owner_id
        WHERE r.order_id = $1
          AND r.closed_at IS NULL
          AND r.status = ANY($2::text[])
          AND o.status <> ALL($3::text[])
          AND (
            o.delivery_address IS NULL
            OR COALESCE(NULLIF(btrim(o.delivery_address->>'address'), ''), NULLIF(btrim(o.delivery_address->>'address_1'), ''), NULLIF(btrim(o.delivery_address->>'street'), ''), NULLIF(btrim(o.delivery_address->>'formatted_address'), ''), NULLIF(btrim(o.delivery_address->>'full_address'), '')) IS NULL
          )`,
      [orderId, ACTIVE_STATUSES, TERMINAL_ORDER_STATUSES],
    );
    const req = r.rows[0];
    if (!req || !isActiveStatus(req.status)) return;

    const now = new Date();
    const expiresAt = windowEnd
      ? new Date(windowEnd.getTime() + 24 * HOUR)
      : new Date(now.getTime() + 72 * HOUR);
    await db.query(
      `UPDATE address_collection_requests
          SET window_start = $2, window_end = $3,
              address_deadline = $4, token_expires_at = GREATEST(token_expires_at, $5),
              updated_at = now()
        WHERE id = $1`,
      [
        req.id,
        windowStart?.toISOString() ?? null,
        windowEnd?.toISOString() ?? null,
        windowStart ? new Date(windowStart.getTime() - 45 * 60_000).toISOString() : null,
        expiresAt.toISOString(),
      ],
    );
    const cancelled = await cancelPendingActions(req.id, "delivery window changed");

    // New generation of idempotency keys so re-inserted steps don't collide
    // with already-sent ones.
    const gen = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM address_collection_actions WHERE request_id = $1`,
      [req.id],
    );
    const generation = Number(gen.rows[0]?.n ?? "0") + 1;

    // A delivery-window edit may move the still-pending initial send, but once
    // the durable request-level attempt gate is set it may only re-plan the
    // internal escalation.
    const sent = await db.query<{ action_type: string }>(
      `SELECT DISTINCT action_type FROM address_collection_actions
        WHERE request_id = $1 AND status = 'sent'`,
      [req.id],
    );
    const sentTypes = new Set(sent.rows.map((x) => x.action_type));
    const whatsappAlreadyAttempted =
      Boolean(req.whatsapp_template_attempted_at) ||
      [...sentTypes].some((type) =>
        ["first_message", "reminder", "final_reminder", "manual_reminder", "template_send"].includes(type),
      );
    const timezone = req.delivery_timezone || "Asia/Beirut";
    const planned = computeSchedule({
      now,
      windowStart,
      timezone,
      isExpress: req.order_delivery_type?.trim().toLowerCase() === "express",
      quietHours: quietHours(),
    }).filter(
      (p) => !sentTypes.has(p.type) && !(p.type === "first_message" && whatsappAlreadyAttempted),
    );
    await insertActions(req.id, planned, generation);
    await recordCollectionEvent({
      requestId: req.id,
      eventType: "schedule_recomputed",
      metadata: {
        reason: "delivery_window_changed",
        cancelled_actions: cancelled,
        window_start: windowStart?.toISOString() ?? null,
        plan: planned.map((p) => ({ type: p.type, at: p.at.toISOString() })),
      },
    });
  } catch (err) {
    logger.warn({ err, orderId }, "addressCollector: schedule recalculation failed");
  }
}

/**
 * Schedule the SMS fallback after an authoritative WhatsApp failure or
 * undelivered signal — 10 minutes later, idempotent (single fallback per
 * request regardless of how many failure signals arrive).
 */
export async function scheduleSmsFallback(requestId: string, reason: string): Promise<void> {
  const at = new Date(Date.now() + 10 * 60_000);
  const r = await db.query(
    `INSERT INTO address_collection_actions
       (request_id, action_type, channel, scheduled_at, idempotency_key, triggering_rule)
     SELECT $1, 'sms_fallback', 'sms', $2, $3, $4
       FROM address_collection_requests r
       LEFT JOIN orders o ON o.id = r.order_id AND o.workspace_owner_id = r.workspace_owner_id
      WHERE r.id = $1
        AND r.closed_at IS NULL
        AND r.status = ANY($5::text[])
        AND (r.order_id IS NULL OR o.status <> ALL($6::text[]))
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [requestId, at.toISOString(), `${requestId}:sms_fallback`, reason, ACTIVE_STATUSES, TERMINAL_ORDER_STATUSES],
  );
  if ((r.rowCount ?? 0) > 0) {
    await recordCollectionEvent({
      requestId,
      eventType: "sms_fallback_scheduled",
      metadata: { reason, at: at.toISOString() },
    });
  }
}

/**
 * Handle a verified provider delivery-status signal (from the respond.io
 * webhook). Idempotent per (request, status). Authoritative failure /
 * undelivered triggers the SMS fallback.
 */
export async function applyProviderStatus(opts: {
  requestId: string;
  providerStatus: string; // accepted|queued|sent|delivered|failed|undelivered
  providerRef?: string | null;
}): Promise<void> {
  const s = opts.providerStatus.toLowerCase();
  // A provider reference is the correlation boundary. Only the legacy
  // request-only form may fall back to the latest sent action.
  const action = await db.query(
    `UPDATE address_collection_actions
        SET provider_status = $2,
            provider_ref = COALESCE($3, provider_ref),
            status = CASE
              WHEN status IN ('processing', 'failed')
               AND (status = 'processing' OR provider_status = 'unknown')
               AND $2 IN ('accepted', 'queued', 'sent', 'delivered')
                THEN 'sent'
              WHEN status = 'processing' AND $2 IN ('failed', 'undelivered')
                THEN 'failed'
              ELSE status
            END,
            sent_at = CASE
              WHEN status IN ('processing', 'failed')
               AND (status = 'processing' OR provider_status = 'unknown')
               AND $2 IN ('accepted', 'queued', 'sent', 'delivered')
                THEN COALESCE(sent_at, now())
              ELSE sent_at
            END,
            updated_at = now()
      WHERE id = (
        SELECT id FROM address_collection_actions
         WHERE request_id = $1
           AND channel = 'whatsapp'
           AND (
             status = 'sent'
             OR status = 'processing'
             OR (status = 'failed' AND provider_status = 'unknown')
           )
           AND (
             $3::text IS NULL
             OR provider_ref = $3
             OR (
               provider_ref IS NULL
               AND (provider_status = 'unknown' OR status = 'processing')
             )
           )
           AND provider_status IS DISTINCT FROM $2
           AND (
             provider_status IS NULL
             OR provider_status = 'accepted'
             OR (provider_status = 'queued' AND $2 = 'sent')
             OR $2 IN ('delivered', 'failed', 'undelivered')
           )
         ORDER BY sent_at DESC NULLS LAST LIMIT 1
      )
        AND EXISTS (
          SELECT 1
            FROM address_collection_requests r
           WHERE r.id = address_collection_actions.request_id
             AND r.closed_at IS NULL
             AND r.status = ANY($4::text[])
        )`,
    [opts.requestId, s, opts.providerRef ?? null, ACTIVE_STATUSES],
  );
  if ((action.rowCount ?? 0) === 0) {
    logger.warn(
      { requestId: opts.requestId, providerRef: opts.providerRef ?? null, providerStatus: s },
      "addressCollector: ignored uncorrelated provider status",
    );
    return;
  }
  await recordCollectionEvent({
    requestId: opts.requestId,
    eventType: "provider_status",
    channel: "whatsapp",
    providerRef: opts.providerRef ?? null,
    metadata: { provider_status: s },
  });
  await recordWhatsappTemplateOutcome({
    requestId: opts.requestId,
    status: s,
    providerRef: opts.providerRef ?? null,
  });
  if (s === "accepted" || s === "sent") {
    await transitionRequestStatus({
      requestId: opts.requestId,
      newStatus: "whatsapp_sent",
      channel: "whatsapp",
      onlyFrom: ["awaiting_address", "scheduled", "whatsapp_queued", "needs_review"],
      extraSet: "risk_level = 'normal'",
    });
  } else if (s === "queued") {
    await transitionRequestStatus({
      requestId: opts.requestId,
      newStatus: "whatsapp_queued",
      channel: "whatsapp",
      onlyFrom: ["awaiting_address", "scheduled", "needs_review"],
      extraSet: "risk_level = 'normal'",
    });
  } else if (s === "delivered") {
    await transitionRequestStatus({
      requestId: opts.requestId,
      newStatus: "whatsapp_delivered",
      channel: "whatsapp",
      onlyFrom: ["awaiting_address", "whatsapp_queued", "whatsapp_sent", "scheduled", "needs_review"],
      extraSet: "risk_level = 'normal'",
    });
  } else if (s === "failed" || s === "undelivered") {
    await transitionRequestStatus({
      requestId: opts.requestId,
      newStatus: "whatsapp_failed",
      channel: "whatsapp",
      onlyFrom: ["awaiting_address", "whatsapp_queued", "whatsapp_sent", "whatsapp_delivered", "scheduled", "needs_review"],
      extraSet: "risk_level = 'at_risk'",
    });
    const req = await db.query<{ status: string; sms_opt_out: boolean; source: string }>(
      `SELECT status, sms_opt_out, source FROM address_collection_requests WHERE id = $1`,
      [opts.requestId],
    );
    const row = req.rows[0];
    if (row && row.source !== "respondio" && isActiveStatus(row.status) && !row.sms_opt_out) {
      await scheduleSmsFallback(opts.requestId, `whatsapp ${s}`);
    }
  }
}
