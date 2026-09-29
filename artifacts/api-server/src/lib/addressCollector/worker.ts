/**
 * Address Collector — scheduled-action worker.
 *
 * DB-backed interval poller (same pattern as the omnichannel outbound queue):
 * atomic claim with FOR UPDATE SKIP LOCKED, per-action idempotency keys,
 * retry only on retryable failures, quiet-hours deferral in the delivery
 * timezone, and restart safety (state lives entirely in Postgres).
 */
import { db } from "../db";
import { logger } from "../logger";
import { deferForQuietHours, isQuietHour } from "./schedule";
import {
  quietHours,
  buildAddressUrl,
  isPublicHttpsUrl,
  waUndeliveredTimeoutMinutes,
} from "./config";
import {
  sendWhatsAppAddressRequest,
  sendSmsAddressRequest,
  formatWindowLabel,
} from "./providers";
import {
  ACTIVE_STATUSES,
  TERMINAL_ORDER_STATUSES,
  isActiveStatus,
  recordCollectionEvent,
  transitionRequestStatus,
  scheduleSmsFallback,
  cancelPendingActions,
  claimWhatsappTemplateAttempt,
  releaseWhatsappTemplateAttempt,
  recordWhatsappTemplateOutcome,
  finalizeAddressCollectionForOrder,
  reconcileOrphanedAddressCollectionRequests,
} from "./service";
import { generateAddressToken } from "./tokens";
import { processPendingIncomingReplies } from "./incomingReplyHandler";
import { buildTookanAddressUpdate, editTookanDeliveryTask } from "../tookan";
import { isDeliveryAddressMissing } from "./eligibility";
import { normalizePhoneForCountry } from "../respondio";
import { withOrderDestinationLock } from "../orderDestinationLock";
import type { PoolClient } from "pg";

const POLL_INTERVAL_MS = 30_000;
const CLAIM_BATCH = 10;
const MAX_ATTEMPTS = 4;
const RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000];
const LEGACY_REPEAT_ACTIONS = new Set(["reminder", "final_reminder", "manual_reminder"]);

type ActionRow = {
  id: string;
  request_id: string;
  action_type: string;
  channel: string;
  scheduled_at: string;
  attempt_count: number;
  idempotency_key: string;
};

type WorkerRequestRow = {
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
  order_window_start?: string | null;
  delivery_timezone: string;
  delivery_country_code: string | null;
  sms_opt_out: boolean;
  respondio_contact_id: string | null;
  source: string;
  link_first_opened_at: string | null;
  last_contact_at: string | null;
  submitted_address: Record<string, unknown> | null;
  tookan_job_id: string | null;
  order_status?: string | null;
  delivery_address?: Record<string, unknown> | null;
  current_recipient_name?: string | null;
  current_recipient_phone?: string | null;
  closed_at?: string | null;
  resolution_outcome?: string | null;
};

type NonDispatchableReason =
  | "request_closed"
  | "request_not_active"
  | "order_unavailable"
  | "order_terminal"
  | "address_already_present"
  | "recipient_unavailable"
  | "recipient_invalid";

type QueryClient = Pick<PoolClient, "query">;

function sameCanonicalDestination(
  left: Record<string, unknown> | null | undefined,
  right: Record<string, unknown> | null | undefined,
): boolean {
  const text = (value: unknown) =>
    typeof value === "string"
      ? value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase()
      : "";
  const street = (value: Record<string, unknown> | null | undefined) =>
    text(value?.address) || text(value?.address_1);
  const coordinate = (
    value: Record<string, unknown> | null | undefined,
    primary: string,
    alias: string,
  ) => {
    const raw = value?.[primary] ?? value?.[alias];
    if (raw === null || raw === undefined || raw === "") return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  };
  return Boolean(left && right)
    && street(left) === street(right)
    && coordinate(left, "latitude", "lat") === coordinate(right, "latitude", "lat")
    && coordinate(left, "longitude", "lng") === coordinate(right, "longitude", "lng");
}

let timer: NodeJS.Timeout | null = null;
let running = false;

/**
 * A crashed worker may leave a claimed WhatsApp action in `processing`.
 * Re-dispatching it could duplicate a template whose HTTP response was lost,
 * so stale WhatsApp claims become an unknown outcome for staff review.
 */
async function recoverStaleProcessingActions(): Promise<void> {
  await db.query(`
    WITH stale AS (
      UPDATE address_collection_actions
         SET status = 'failed',
             provider_status = 'unknown',
             error_code = COALESCE(error_code, 'stale_processing_unknown'),
             error_message = COALESCE(error_message, 'Worker stopped while the WhatsApp send outcome was unknown'),
             updated_at = now()
       WHERE status = 'processing'
         AND channel = 'whatsapp'
         AND updated_at < now() - interval '2 minutes'
       RETURNING request_id, action_type
    ),
    reviewed AS (
      UPDATE address_collection_requests r
         SET whatsapp_template_attempted_at = COALESCE(r.whatsapp_template_attempted_at, now()),
             whatsapp_template_status = 'unknown',
             status = CASE
               WHEN r.status = ANY($1::text[]) THEN 'needs_review'
               ELSE r.status
             END,
             risk_level = CASE
               WHEN r.status = ANY($1::text[]) THEN 'at_risk'
               ELSE r.risk_level
             END,
             updated_at = now()
        FROM stale
       WHERE r.id = stale.request_id
       RETURNING r.id, stale.action_type
    )
    INSERT INTO address_collection_events
      (request_id, event_type, actor, channel, metadata)
    SELECT id, 'whatsapp_outcome_unknown', 'system', 'whatsapp',
           jsonb_build_object('action_type', action_type, 'reason', 'stale_processing_recovered')
      FROM reviewed
  `, [ACTIVE_STATUSES]);
}

/** Atomically claim due pending actions. */
async function claimDueActions(): Promise<ActionRow[]> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query<ActionRow>(
      `UPDATE address_collection_actions
          SET status = 'processing', updated_at = now()
        WHERE id IN (
          SELECT id FROM address_collection_actions
           WHERE status = 'pending' AND scheduled_at <= now()
           ORDER BY scheduled_at
           LIMIT ${CLAIM_BATCH}
           FOR UPDATE SKIP LOCKED
        )
        RETURNING id, request_id, action_type, channel, scheduled_at, attempt_count, idempotency_key`,
    );
    await client.query("COMMIT");
    return r.rows;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function finishAction(
  id: string,
  status: "sent" | "failed" | "cancelled" | "blocked" | "skipped",
  extra?: { providerRef?: string | null; providerStatus?: string | null; errorCode?: string; errorMessage?: string },
  client: QueryClient = db,
): Promise<void> {
  await client.query(
    `UPDATE address_collection_actions
        SET status = $2,
            sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE sent_at END,
            provider_ref = COALESCE($3, provider_ref),
            provider_status = COALESCE($4, provider_status),
            error_code = COALESCE($5, error_code),
            error_message = COALESCE($6, error_message),
            updated_at = now()
      WHERE id = $1`,
    [id, status, extra?.providerRef ?? null, extra?.providerStatus ?? null, extra?.errorCode ?? null, extra?.errorMessage ?? null],
  );
}

async function retryOrFail(action: ActionRow, errorCode: string, errorMessage: string): Promise<void> {
  const attempts = action.attempt_count + 1;
  if (attempts >= MAX_ATTEMPTS) {
    await finishAction(action.id, "failed", { errorCode, errorMessage });
    await transitionRequestStatus({
      requestId: action.request_id,
      newStatus: "needs_review",
      onlyFrom: ACTIVE_STATUSES,
      extraSet: "risk_level = 'at_risk'",
      metadata: { action_type: action.action_type, reason: "retry_limit_reached", error_code: errorCode },
    });
    await recordCollectionEvent({
      requestId: action.request_id,
      eventType: "action_failed",
      channel: action.channel,
      metadata: { action_type: action.action_type, error_code: errorCode, attempts },
    });
    return;
  }
  const backoff = RETRY_BACKOFF_MS[Math.min(attempts - 1, RETRY_BACKOFF_MS.length - 1)];
  await db.query(
    `UPDATE address_collection_actions
        SET status = 'pending', attempt_count = $2,
            scheduled_at = now() + ($3 || ' milliseconds')::interval,
            error_code = $4, error_message = $5, updated_at = now()
      WHERE id = $1`,
    [action.id, attempts, String(backoff), errorCode, errorMessage],
  );
}

async function loadRequest(
  requestId: string,
  client: QueryClient = db,
): Promise<WorkerRequestRow | null> {
  const r = await client.query<WorkerRequestRow>(
    `SELECT r.*, o.tookan_job_id, o.window_start AS order_window_start,
            o.status AS order_status, o.delivery_address,
            recipient.current_recipient_name, recipient.current_recipient_phone,
            recipient.current_recipient_contact_id
       FROM address_collection_requests r
       LEFT JOIN orders o
         ON o.id = r.order_id
        AND o.workspace_owner_id = r.workspace_owner_id
       LEFT JOIN LATERAL (
         SELECT c.id AS current_recipient_contact_id,
                c.display_name AS current_recipient_name,
                c.phone AS current_recipient_phone
           FROM order_contacts oc
           JOIN contacts c
             ON c.id = oc.contact_id
            AND c.workspace_owner_id = r.workspace_owner_id
          WHERE oc.order_id = o.id
            AND oc.role = 'recipient'
          ORDER BY oc.created_at DESC, oc.id DESC
          LIMIT 1
       ) recipient ON true
      WHERE r.id = $1`,
    [requestId],
  );
  return r.rows[0] ?? null;
}

/**
 * Lock every mutable row that determines whether and where the template may
 * be sent. Order is locked before request to match lifecycle finalization.
 * The final reload happens only after all locks are held.
 */
async function loadRequestForDispatch(
  requestId: string,
  client: QueryClient,
): Promise<WorkerRequestRow | null> {
  const identity = await client.query<{
    order_id: string | null;
    workspace_owner_id: string;
  }>(
    `SELECT r.order_id, r.workspace_owner_id
       FROM address_collection_requests r
      WHERE r.id = $1`,
    [requestId],
  );
  const row = identity.rows[0];
  if (!row) return null;

  if (row.order_id) {
    await client.query(
      `SELECT id FROM orders
        WHERE id = $1 AND workspace_owner_id = $2
        FOR UPDATE`,
      [row.order_id, row.workspace_owner_id],
    );
  }
  await client.query(
    `SELECT id FROM address_collection_requests WHERE id = $1 FOR UPDATE`,
    [requestId],
  );
  if (row.order_id) {
    await client.query(
      `SELECT c.id
         FROM order_contacts oc
         JOIN contacts c
           ON c.id = oc.contact_id
          AND c.workspace_owner_id = $2
        WHERE oc.order_id = $1
          AND oc.role = 'recipient'
        ORDER BY oc.created_at DESC, oc.id DESC
        LIMIT 1
        FOR UPDATE OF oc, c`,
      [row.order_id, row.workspace_owner_id],
    );
  }
  return loadRequest(requestId, client);
}

function dispatchRecipient(
  req: WorkerRequestRow,
): { name: string; phone: string } | null {
  const rawName = req.order_id ? req.current_recipient_name : req.recipient_name;
  const rawPhone = req.order_id ? req.current_recipient_phone : req.recipient_phone;
  const name = rawName?.trim() ?? "";
  if (!name || !rawPhone?.trim()) return null;
  const phone = normalizePhoneForCountry(rawPhone, req.delivery_country_code);
  return phone ? { name, phone } : null;
}

function requestNonDispatchableReason(req: WorkerRequestRow): NonDispatchableReason | null {
  if (req.closed_at || req.resolution_outcome) return "request_closed";
  if (!isActiveStatus(req.status)) return "request_not_active";
  if (req.order_id && !req.order_status) return "order_unavailable";
  if (
    req.order_status
    && (TERMINAL_ORDER_STATUSES as readonly string[]).includes(req.order_status)
  ) {
    return "order_terminal";
  }
  if (!isDeliveryAddressMissing(req.delivery_address)) return "address_already_present";

  const rawName = req.order_id ? req.current_recipient_name : req.recipient_name;
  const rawPhone = req.order_id ? req.current_recipient_phone : req.recipient_phone;
  if (!rawName?.trim() || !rawPhone?.trim()) return "recipient_unavailable";
  if (!normalizePhoneForCountry(rawPhone, req.delivery_country_code)) return "recipient_invalid";
  return null;
}

function requestIsDispatchable(req: WorkerRequestRow): boolean {
  return requestNonDispatchableReason(req) === null;
}

async function reconcileRequestAfterCancellation(
  action: ActionRow,
  req: WorkerRequestRow,
  reason: NonDispatchableReason,
  client: QueryClient,
): Promise<void> {
  if (reason === "address_already_present" && req.order_id) {
    await finalizeAddressCollectionForOrder(client, {
      orderId: req.order_id,
      workspaceOwnerId: req.workspace_owner_id,
      outcome: "manual_resolution",
      reason: "Order has a usable delivery address",
      source: "worker_revalidation",
    });
    return;
  }

  if (reason === "order_terminal" && req.order_id) {
    const cancelled = req.order_status === "cancelled" || req.order_status === "refunded";
    await finalizeAddressCollectionForOrder(client, {
      orderId: req.order_id,
      workspaceOwnerId: req.workspace_owner_id,
      outcome: cancelled ? "order_cancelled" : "order_delivered",
      reason: `Order is ${req.order_status ?? "terminal"}`,
      source: "worker_revalidation",
    });
    return;
  }

  if (
    reason === "order_unavailable"
    || reason === "recipient_unavailable"
    || reason === "recipient_invalid"
  ) {
    await transitionRequestStatus({
      requestId: req.id,
      newStatus: "needs_review",
      onlyFrom: ACTIVE_STATUSES,
      extraSet: "risk_level = 'at_risk'",
      metadata: { action_type: action.action_type, reason },
    }, client);
    return;
  }

  if (reason === "request_closed" && isActiveStatus(req.status)) {
    const newStatus = req.resolution_outcome === "order_cancelled"
      ? "cancelled"
      : req.resolution_outcome === "failed"
        ? "expired"
        : "resolved";
    await transitionRequestStatus({
      requestId: req.id,
      newStatus,
      onlyFrom: ACTIVE_STATUSES,
      metadata: { action_type: action.action_type, reason },
    }, client);
  }
}

async function cancelNonDispatchableAction(
  action: ActionRow,
): Promise<boolean> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const current = await loadRequestForDispatch(action.request_id, client);
    if (!current) {
      await finishAction(action.id, "cancelled", {
        errorCode: "request_unavailable",
        errorMessage: "Address collection action cancelled: request_unavailable",
      }, client);
      await client.query("COMMIT");
      return true;
    }

    const reason = requestNonDispatchableReason(current);
    if (!reason) {
      await client.query("COMMIT");
      return false;
    }
    if (action.channel === "whatsapp") {
      await releaseWhatsappTemplateAttemptWithClient(current.id, reason, client);
    }
    await finishAction(action.id, "cancelled", {
      errorCode: reason,
      errorMessage: `Address collection action cancelled: ${reason}`,
    }, client);
    await reconcileRequestAfterCancellation(action, current, reason, client);
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function releaseWhatsappTemplateAttemptWithClient(
  requestId: string,
  reason: string,
  client: QueryClient,
): Promise<void> {
  const released = await client.query(
    `UPDATE address_collection_requests
        SET whatsapp_template_attempted_at = NULL,
            whatsapp_template_status = 'pre_send_failed',
            updated_at = now()
      WHERE id = $1
        AND whatsapp_template_status = 'attempting'
        AND whatsapp_template_provider_ref IS NULL
      RETURNING id`,
    [requestId],
  );
  if ((released.rowCount ?? 0) === 0) return;
  await recordCollectionEvent({
    requestId,
    eventType: "whatsapp_pre_send_failed",
    channel: "whatsapp",
    metadata: { reason },
  }, client);
}

async function revalidateBeforeProviderIo(action: ActionRow): Promise<WorkerRequestRow | null> {
  const current = await loadRequest(action.request_id);
  if (!current) {
    await finishAction(action.id, "cancelled", {
      errorCode: "request_unavailable",
      errorMessage: "Address collection action cancelled: request_unavailable",
    });
    return null;
  }
  const reason = requestNonDispatchableReason(current);
  if (reason) {
    const cancelled = await cancelNonDispatchableAction(action);
    return cancelled ? null : loadRequest(action.request_id);
  }
  return current;
}

async function sendWhatsAppWithDispatchLocks(
  action: ActionRow,
  opts: {
    language: string;
    orderReference: string;
    secureUrl: string;
  },
): Promise<{
  request: WorkerRequestRow;
  result: Awaited<ReturnType<typeof sendWhatsAppAddressRequest>>;
} | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const current = await loadRequestForDispatch(action.request_id, client);
    if (!current) {
      await finishAction(action.id, "cancelled", {
        errorCode: "request_unavailable",
        errorMessage: "Address collection action cancelled: request_unavailable",
      }, client);
      await client.query("COMMIT");
      return null;
    }

    const reason = requestNonDispatchableReason(current);
    if (reason) {
      await releaseWhatsappTemplateAttemptWithClient(current.id, reason, client);
      await finishAction(action.id, "cancelled", {
        errorCode: reason,
        errorMessage: `Address collection action cancelled: ${reason}`,
      }, client);
      await reconcileRequestAfterCancellation(action, current, reason, client);
      await client.query("COMMIT");
      return null;
    }

    const recipient = dispatchRecipient(current);
    if (!recipient) {
      await releaseWhatsappTemplateAttemptWithClient(current.id, "recipient_unavailable", client);
      await finishAction(action.id, "cancelled", {
        errorCode: "recipient_unavailable",
        errorMessage: "Address collection action cancelled: recipient_unavailable",
      }, client);
      await reconcileRequestAfterCancellation(
        action,
        current,
        "recipient_unavailable",
        client,
      );
      await client.query("COMMIT");
      return null;
    }
    if (
      recipient.name !== current.recipient_name
      || recipient.phone !== current.recipient_phone
    ) {
      await client.query(
        `UPDATE address_collection_requests
            SET recipient_name = $2, recipient_phone = $3, updated_at = now()
          WHERE id = $1`,
        [current.id, recipient.name, recipient.phone],
      );
      current.recipient_name = recipient.name;
      current.recipient_phone = recipient.phone;
    }

    // Keep order, request, and current-recipient locks until Respond.io has
    // accepted or rejected the provider call. Concurrent edits wait and cannot
    // invalidate the destination between final validation and dispatch.
    const result = await sendWhatsAppAddressRequest({
      phone: recipient.phone,
      recipientName: recipient.name,
      orderReference: opts.orderReference,
      language: opts.language,
      secureUrl: opts.secureUrl,
      requestRef: current.id,
    });
    await client.query("COMMIT");
    return { request: current, result };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

const SAFE_ORDER_REFERENCE_FALLBACK = "your order";

function safeOrderReference(value: string | null | undefined): string | null {
  const reference = value?.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (!reference || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(reference)) return null;
  return reference.slice(0, 80);
}

/** Resolve only customer-safe order references; never fall back to the UUID. */
async function loadOrderReference(orderId: string): Promise<string> {
  const r = await db.query<{ display_order_number: string | null; external_order_id: string | null }>(
    `SELECT display_order_number, external_order_id FROM orders WHERE id = $1`,
    [orderId],
  );
  const row = r.rows[0];
  return (
    safeOrderReference(row?.display_order_number) ??
    safeOrderReference(row?.external_order_id) ??
    SAFE_ORDER_REFERENCE_FALLBACK
  );
}

async function blockMessageAction(
  action: ActionRow,
  req: WorkerRequestRow,
  errorCode: string,
  errorMessage: string,
): Promise<void> {
  await finishAction(action.id, "blocked", { errorCode, errorMessage });
  await transitionRequestStatus({
    requestId: req.id,
    newStatus: "needs_review",
    onlyFrom: ACTIVE_STATUSES,
    extraSet: "risk_level = 'at_risk'",
    metadata: { action_type: action.action_type, blocked_by_configuration: errorCode },
  });
  await recordCollectionEvent({
    requestId: req.id,
    eventType: "action_blocked",
    channel: action.channel,
    metadata: { action_type: action.action_type, error_code: errorCode },
  });
}

/**
 * The plaintext token is never stored, so the SMS fallback rotates the token:
 * a fresh token replaces token_hash while the prior hash is kept in
 * previous_token_hash (still valid until expiry).
 */
async function rotateToken(requestId: string): Promise<string> {
  const { token, tokenHash } = generateAddressToken();
  await db.query(
    `UPDATE address_collection_requests
        SET previous_token_hash = token_hash, token_hash = $2, updated_at = now()
      WHERE id = $1`,
    [requestId, tokenHash],
  );
  return token;
}

async function processMessageAction(action: ActionRow, req: WorkerRequestRow): Promise<void> {
  const tz = req.delivery_timezone || "Asia/Beirut";
  const qh = quietHours();
  const now = new Date();

  // Quiet hours: defer, don't send.
  if (action.action_type !== "first_message" && isQuietHour(now, tz, qh)) {
    const deferred = deferForQuietHours(now, tz, qh);
    await db.query(
      `UPDATE address_collection_actions
          SET status = 'pending', scheduled_at = $2, updated_at = now()
        WHERE id = $1`,
      [action.id, deferred.toISOString()],
    );
    await recordCollectionEvent({
      requestId: req.id,
      eventType: "action_deferred_quiet_hours",
      channel: action.channel,
      metadata: { action_type: action.action_type, deferred_to: deferred.toISOString(), timezone: tz },
    });
    return;
  }

  const windowStart = req.window_start ? new Date(req.window_start) : null;
  const windowEnd = req.window_end ? new Date(req.window_end) : null;
  const language = req.preferred_language === "ar" ? "ar" : "en";
  const windowLabel = formatWindowLabel(windowStart, windowEnd, tz, language);
  let orderReference = SAFE_ORDER_REFERENCE_FALLBACK;
  let secureUrl = "";
  // The approved WhatsApp reply template has no secure-link variable. SMS
  // fallback retains the existing secure-link flow and validates/rotates the
  // link only when it is actually needed.
  if (action.channel !== "whatsapp") {
    if (!isPublicHttpsUrl(buildAddressUrl("address-link"))) {
      await blockMessageAction(
        action,
        req,
        "invalid_address_url",
        "Address request URL must be configured as a public HTTPS URL",
      );
      return;
    }
    orderReference = req.order_id ? await loadOrderReference(req.order_id) : SAFE_ORDER_REFERENCE_FALLBACK;
    const token = await rotateToken(req.id);
    secureUrl = buildAddressUrl(token);
  }
  if (action.channel === "whatsapp") {
    const claimed = await claimWhatsappTemplateAttempt({
      requestId: req.id,
      actionId: action.id,
    });
    if (!claimed) {
      await finishAction(action.id, "skipped", {
        errorCode: "duplicate_whatsapp_suppressed",
        errorMessage: "WhatsApp address outreach was already attempted for this request",
      });
      await recordCollectionEvent({
        requestId: req.id,
        eventType: "whatsapp_outreach_suppressed",
        channel: "whatsapp",
        metadata: { action_type: action.action_type, reason: "request_already_attempted" },
      });
      return;
    }
    await recordCollectionEvent({
      requestId: req.id,
      eventType: "whatsapp_outreach_attempted",
      channel: "whatsapp",
      metadata: { action_type: action.action_type },
    });

    const dispatch = await sendWhatsAppWithDispatchLocks(action, {
      orderReference,
      language,
      secureUrl,
    });
    if (!dispatch) return;
    req = dispatch.request;
    const result = dispatch.result;
    if (result.ok) {
      await finishAction(action.id, "sent", { providerRef: result.providerRef, providerStatus: "accepted" });
      await recordWhatsappTemplateOutcome({
        requestId: req.id,
        status: "accepted",
        providerRef: result.providerRef,
      });
      if (result.respondioContactId) {
        await db.query(
          `UPDATE address_collection_requests
              SET respondio_contact_id = COALESCE(respondio_contact_id, $2),
                  last_contact_at = now(), last_contact_channel = 'whatsapp', updated_at = now()
            WHERE id = $1`,
          [req.id, result.respondioContactId],
        );
      } else {
        await db.query(
          `UPDATE address_collection_requests
              SET last_contact_at = now(), last_contact_channel = 'whatsapp', updated_at = now()
            WHERE id = $1`,
          [req.id],
        );
      }
      await transitionRequestStatus({
        requestId: req.id,
        newStatus: "whatsapp_sent",
        channel: "whatsapp",
        onlyFrom: ["scheduled", "whatsapp_queued", "whatsapp_failed", "whatsapp_sent", "whatsapp_delivered", "sms_fallback_sent", "needs_review"],
        extraSet: "risk_level = 'normal'",
        metadata: { action_type: action.action_type },
      });
      await recordCollectionEvent({
        requestId: req.id,
        eventType: "message_sent",
        channel: "whatsapp",
        metadata: { action_type: action.action_type, provider_status: "accepted" },
      });
      // Optional configured timeout: if no authoritative delivered/opened
      // signal within N minutes, treat as undelivered → SMS fallback.
      const timeoutMin = waUndeliveredTimeoutMinutes();
      if (timeoutMin > 0 && action.action_type === "first_message") {
        await db.query(
          `INSERT INTO address_collection_actions
             (request_id, action_type, channel, scheduled_at, idempotency_key, triggering_rule)
           VALUES ($1, 'wa_delivery_check', 'internal', $2, $3, $4)
           ON CONFLICT (idempotency_key) DO NOTHING`,
          [
            req.id,
            new Date(Date.now() + timeoutMin * 60_000).toISOString(),
            `${req.id}:wa_delivery_check`,
            `no delivery signal after ${timeoutMin}m`,
          ],
        );
      }
      return;
    }
    if (result.preSendFailure) {
      await releaseWhatsappTemplateAttempt(req.id, result.errorCode);
      if (result.blockedByConfig) {
        await blockMessageAction(action, req, result.errorCode, result.errorMessage);
        return;
      }
      if (result.retryable) {
        await retryOrFail(action, result.errorCode, result.errorMessage);
        return;
      }
      await finishAction(action.id, "failed", {
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
      });
      await transitionRequestStatus({
        requestId: req.id,
        newStatus: "needs_review",
        onlyFrom: ACTIVE_STATUSES,
        extraSet: "risk_level = 'at_risk'",
        metadata: { action_type: action.action_type, reason: "confirmed_pre_send_failure", error_code: result.errorCode },
      });
      return;
    }
    if (result.blockedByConfig) {
      await blockMessageAction(action, req, result.errorCode, result.errorMessage);
      return;
    }
    if (result.retryable) {
      await finishAction(action.id, "failed", {
        providerStatus: "unknown",
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
      });
      await recordWhatsappTemplateOutcome({ requestId: req.id, status: "unknown" });
      await transitionRequestStatus({
        requestId: req.id,
        newStatus: "needs_review",
        onlyFrom: ACTIVE_STATUSES,
        extraSet: "risk_level = 'at_risk'",
        metadata: { action_type: action.action_type, reason: "ambiguous_transport_failure", error_code: result.errorCode },
      });
      await recordCollectionEvent({
        requestId: req.id,
        eventType: "whatsapp_outcome_unknown",
        channel: "whatsapp",
        metadata: { action_type: action.action_type, error_code: result.errorCode },
      });
      return;
    }
    // Permanent WhatsApp failure — this IS an authoritative failure signal.
    await finishAction(action.id, "failed", {
      providerStatus: "failed",
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
    });
    await recordWhatsappTemplateOutcome({ requestId: req.id, status: "failed" });
    await transitionRequestStatus({
      requestId: req.id,
      newStatus: req.status === "awaiting_address" ? "failed" : "whatsapp_failed",
      channel: "whatsapp",
      onlyFrom: ACTIVE_STATUSES,
      extraSet: "risk_level = 'at_risk'",
      metadata: { error_code: result.errorCode },
    });
    if (req.source !== "respondio" && !req.sms_opt_out) {
      await scheduleSmsFallback(req.id, `whatsapp permanent failure: ${result.errorCode}`);
    }
    return;
  }

  // SMS fallback
  const current = await revalidateBeforeProviderIo(action);
  if (!current) return;
  req = current;
  const result = await sendSmsAddressRequest({
    phone: req.recipient_phone,
    language,
    secureUrl,
    windowLabel,
  });
  if (result.ok) {
    await finishAction(action.id, "sent", { providerRef: result.providerRef, providerStatus: "accepted" });
    await db.query(
      `UPDATE address_collection_requests
          SET last_contact_at = now(), last_contact_channel = 'sms', updated_at = now()
        WHERE id = $1`,
      [req.id],
    );
    await transitionRequestStatus({
      requestId: req.id,
      newStatus: "sms_fallback_sent",
      channel: "sms",
      onlyFrom: ["whatsapp_failed", "whatsapp_sent", "whatsapp_queued", "scheduled", "whatsapp_delivered"],
    });
    await recordCollectionEvent({
      requestId: req.id,
      eventType: "message_sent",
      channel: "sms",
      providerRef: result.providerRef,
      metadata: { action_type: action.action_type },
    });
    return;
  }
  if (result.blockedByConfig) {
    await blockMessageAction(action, req, result.errorCode, result.errorMessage);
    return;
  }
  if (result.errorCode === "sms_opt_out") {
    await finishAction(action.id, "failed", { errorCode: result.errorCode, errorMessage: result.errorMessage });
    await db.query(
      `UPDATE address_collection_requests SET sms_opt_out = true, updated_at = now() WHERE id = $1`,
      [req.id],
    );
    await transitionRequestStatus({
      requestId: req.id,
      newStatus: "needs_review",
      extraSet: "risk_level = 'at_risk'",
      metadata: { reason: "recipient opted out of SMS" },
    });
    return;
  }
  if (result.retryable) {
    await retryOrFail(action, result.errorCode, result.errorMessage);
    return;
  }
  await finishAction(action.id, "failed", { errorCode: result.errorCode, errorMessage: result.errorMessage });
}

async function processAction(action: ActionRow): Promise<void> {
  const req = await loadRequest(action.request_id);
  if (!req) {
    await finishAction(action.id, "cancelled", { errorMessage: "request no longer exists" });
    return;
  }
  const nonDispatchableReason = requestNonDispatchableReason(req);
  if (action.action_type !== "tookan_destination_update" && nonDispatchableReason) {
    if (await cancelNonDispatchableAction(action)) return;
  }
  if (action.channel === "whatsapp" && LEGACY_REPEAT_ACTIONS.has(action.action_type)) {
    await finishAction(action.id, "cancelled", {
      errorCode: "legacy_repeat_suppressed",
      errorMessage: "WhatsApp address outreach is limited to one template send",
    });
    await recordCollectionEvent({
      requestId: req.id,
      eventType: "whatsapp_outreach_suppressed",
      channel: "whatsapp",
      metadata: { action_type: action.action_type, reason: "legacy_repeat_action" },
    });
    return;
  }
  if (action.action_type === "tookan_destination_update") {
    if (!req.order_id) {
      await finishAction(action.id, "cancelled", {
        errorCode: "order_unavailable",
        errorMessage: "collector request is not linked to an order",
      });
      return;
    }
    let sentMetadata: {
      providerRef: string;
      address: string;
      latitude: number;
      longitude: number;
    } | null = null;
    try {
      sentMetadata = await withOrderDestinationLock(req.order_id, async (client) => {
    // A support correction may supersede this action after it was claimed.
    // Re-read immediately before the external write and fail closed unless the
    // collector destination still equals the order's canonical destination.
    const latestReq = await loadRequest(action.request_id, client);
    if (
      !latestReq
      || !sameCanonicalDestination(
        latestReq.submitted_address,
        latestReq.delivery_address,
      )
    ) {
      await finishAction(action.id, "cancelled", {
        errorCode: "destination_superseded",
        errorMessage: "collector destination no longer matches the canonical order address",
      }, client);
      return null;
    }
    if (!latestReq.tookan_job_id) {
      await finishAction(action.id, "skipped", {
        errorMessage: "order has no existing Tookan task",
      }, client);
      return null;
    }
    const addressUpdate = buildTookanAddressUpdate(latestReq.delivery_address);
    if (!addressUpdate) {
      await finishAction(action.id, "failed", {
        errorCode: "invalid_destination",
        errorMessage: "resolved address is missing canonical destination fields",
      }, client);
      return null;
    }
      await editTookanDeliveryTask(
        latestReq.tookan_job_id,
        latestReq.order_window_start ?? latestReq.window_start,
        addressUpdate,
      );
      await finishAction(action.id, "sent", {
        providerRef: latestReq.tookan_job_id,
        providerStatus: "updated",
      }, client);
      return {
        providerRef: latestReq.tookan_job_id,
        address: addressUpdate.address ?? "",
        latitude: addressUpdate.latitude ?? 0,
        longitude: addressUpdate.longitude ?? 0,
      };
      });
    } catch (err) {
      await retryOrFail(
        action,
        "tookan_update_failed",
        err instanceof Error ? err.message : String(err),
      );
      return;
    }
    if (sentMetadata) {
      await recordCollectionEvent({
        requestId: req.id,
        eventType: "tookan_task_updated",
        channel: "tookan",
        providerRef: sentMetadata.providerRef,
        metadata: {
          outcome: "updated",
          address: sentMetadata.address,
          latitude: sentMetadata.latitude,
          longitude: sentMetadata.longitude,
        },
      });
    }
    return;
  }
  // Address received / cancelled / expired — outreach is over.
  if (!isActiveStatus(req.status)) {
    await finishAction(action.id, "skipped", { errorMessage: `request status is ${req.status}` });
    return;
  }
  // Token expired → mark request expired.
  if (new Date(req.token_expires_at).getTime() <= Date.now() && action.channel !== "internal") {
    await finishAction(action.id, "skipped", { errorMessage: "token expired" });
    await transitionRequestStatus({
      requestId: req.id,
      newStatus: "expired",
      onlyFrom: [...([] as string[]), "scheduled", "whatsapp_queued", "whatsapp_sent", "whatsapp_delivered", "whatsapp_failed", "sms_fallback_sent", "link_opened", "in_progress", "escalated"],
    });
    await cancelPendingActions(req.id, "token expired");
    return;
  }

  switch (action.action_type) {
    case "escalation": {
      await finishAction(action.id, "sent");
      await transitionRequestStatus({
        requestId: req.id,
        newStatus: "escalated",
        onlyFrom: ["scheduled", "whatsapp_queued", "whatsapp_sent", "whatsapp_delivered", "whatsapp_failed", "sms_fallback_sent", "link_opened", "in_progress"],
        extraSet: "risk_level = 'at_risk', escalated_at = now()",
        metadata: { reason: "no address 45 minutes before delivery window" },
      });
      return;
    }
    case "wa_delivery_check": {
      await finishAction(action.id, "sent");
      // No delivered signal and the link was never opened → treat as
      // undelivered per configured timeout.
      const opened = !!req.link_first_opened_at;
      const delivered = req.status === "whatsapp_delivered" || req.status === "link_opened" || req.status === "in_progress";
      if (!opened && !delivered && isActiveStatus(req.status) && !req.sms_opt_out) {
        await recordCollectionEvent({
          requestId: req.id,
          eventType: "wa_timeout_undelivered",
          metadata: { note: "no delivery/open signal within configured timeout" },
        });
        await scheduleSmsFallback(req.id, "configured WhatsApp delivery timeout");
      }
      return;
    }
    default:
      await processMessageAction(action, req);
  }
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await reconcileOrphanedAddressCollectionRequests(db, CLAIM_BATCH);
    await recoverStaleProcessingActions();
    await processPendingIncomingReplies(CLAIM_BATCH);
    const actions = await claimDueActions();
    for (const action of actions) {
      try {
        await processAction(action);
      } catch (err) {
        logger.warn({ err, actionId: action.id }, "addressCollector worker: action processing error");
        const message = err instanceof Error ? err.message : String(err);
        if (action.channel === "whatsapp") {
          await finishAction(action.id, "failed", {
            providerStatus: "unknown",
            errorCode: "internal_error",
            errorMessage: message,
          }).catch(() => {});
          await recordWhatsappTemplateOutcome({
            requestId: action.request_id,
            status: "unknown",
          }).catch(() => {});
          await transitionRequestStatus({
            requestId: action.request_id,
            newStatus: "needs_review",
            onlyFrom: ACTIVE_STATUSES,
            extraSet: "risk_level = 'at_risk'",
            metadata: { action_type: action.action_type, reason: "ambiguous_internal_failure" },
          }).catch(() => {});
        } else {
          await retryOrFail(action, "internal_error", message).catch(() => {});
        }
      }
    }
  } catch (err) {
    logger.warn({ err }, "addressCollector worker: tick failed");
  } finally {
    running = false;
  }
}

export function startAddressCollectorWorker(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
  setTimeout(() => void tick(), 10_000);
  logger.info({ intervalMs: POLL_INTERVAL_MS }, "addressCollector worker started");
}

export function stopAddressCollectorWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** Exported for tests. */
export const __test = {
  tick,
  claimDueActions,
  processAction,
  loadOrderReference,
  recoverStaleProcessingActions,
  requestIsDispatchable,
  requestNonDispatchableReason,
  revalidateBeforeProviderIo,
};
