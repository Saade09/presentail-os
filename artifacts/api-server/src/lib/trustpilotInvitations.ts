import { db } from "./db";
import { logger } from "./logger";
import {
  computePreferredSendTime,
  createTrustpilotInvitation,
  isRetryableTrustpilotError,
  isTrustpilotEnabled,
  resolveTrustpilotLocale,
  TrustpilotApiError,
} from "./trustpilot";

/**
 * Trustpilot service-review invitation queue.
 *
 * Enqueue: when an order transitions to `completed` (dashboard status PATCH,
 * Tookan webhook, or Tookan status poller), exactly one `pending` row is
 * inserted per order (UNIQUE(order_id) + ON CONFLICT DO NOTHING makes repeat
 * completions idempotent). Orders without a customer email are recorded as
 * `skipped` so the admin card can explain why nothing was sent.
 *
 * Processing: rows are claimed with a status-guarded UPDATE (pending →
 * processing) so concurrent instances never double-send, then the Trustpilot
 * Invitations API is called. 429/5xx/network failures back off and retry up to
 * MAX_ATTEMPTS; other 4xx responses fail immediately. A periodic sweep picks
 * up due retries and rows orphaned in `processing` by a crashed instance.
 */

export const MAX_TRUSTPILOT_ATTEMPTS = 5;

/** Backoff schedule (minutes) indexed by the attempt count AFTER the failure. */
const BACKOFF_MINUTES = [1, 5, 15, 60, 240];

const SWEEP_INTERVAL_MS = 60_000;

/** Rows stuck in `processing` longer than this are reclaimed by the sweep. */
const STUCK_PROCESSING_MINUTES = 15;

export function backoffMinutesForAttempt(attemptCount: number): number {
  const idx = Math.min(Math.max(attemptCount - 1, 0), BACKOFF_MINUTES.length - 1);
  return BACKOFF_MINUTES[idx];
}

type OrderForInvitation = {
  id: string;
  workspace_owner_id: string;
  display_order_number: string | null;
  external_order_id: string | null;
  channel: string | null;
  delivery_address: Record<string, unknown> | null;
  tookan_delivered_at: string | null;
  customer_email: string | null;
  customer_name: string | null;
  trustpilot_invitations_enabled: boolean | null;
  is_sensitive_occasion: boolean | null;
};

/** last_error text recorded when an invitation is suppressed for sensitivity. */
export const SENSITIVE_SUPPRESSION_MESSAGE =
  "Suppressed — sensitive occasion (sympathy/funeral order)";

/** Extract the destination country from the stored delivery address JSON. */
function addressCountry(addr: Record<string, unknown> | null): string | null {
  if (!addr) return null;
  const c = addr.country;
  return typeof c === "string" && c.trim() !== "" ? c.trim() : null;
}

/** Extract the stored language hint (if the storefront recorded one). */
function addressLanguage(addr: Record<string, unknown> | null): string | null {
  if (!addr) return null;
  for (const key of ["language", "locale", "lang"]) {
    const v = addr[key];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return null;
}

/**
 * Enqueue a Trustpilot invitation when an order genuinely transitions to
 * `completed`. Fire-and-forget safe: never throws. Returns the outcome for
 * tests/logging:
 * - "disabled"  env master switch off
 * - "not_completion" not a → completed transition
 * - "workspace_disabled" workspace toggle off
 * - "enqueued"  new pending row created (processing kicked off async)
 * - "skipped"   recorded as skipped (no customer email)
 * - "duplicate" a row for this order already existed
 * - "error"     unexpected failure (logged)
 */
export async function maybeEnqueueTrustpilotInvitation(
  orderId: string,
  previousStatus: string | null,
  newStatus: string | null,
): Promise<string> {
  try {
    logger.info(
      { orderId, previousStatus, newStatus },
      "trustpilot: maybeEnqueueTrustpilotInvitation called",
    );

    if (!isTrustpilotEnabled()) {
      logger.info({ orderId }, "trustpilot: skipping enqueue — integration disabled (env/credentials)");
      return "disabled";
    }
    if (newStatus !== "completed" || previousStatus === "completed") {
      logger.info(
        { orderId, previousStatus, newStatus },
        "trustpilot: skipping enqueue — not a transition into completed",
      );
      return "not_completion";
    }

    const orderRes = await db.query<OrderForInvitation>(
      `SELECT o.id, o.workspace_owner_id, o.display_order_number, o.external_order_id,
              o.channel, o.delivery_address, o.tookan_delivered_at,
              o.is_sensitive_occasion,
              COALESCE(c.email, o.raw_payload->>'customer_email') AS customer_email,
              c.display_name AS customer_name,
              ws.trustpilot_invitations_enabled
         FROM orders o
    LEFT JOIN order_contacts oc ON oc.order_id = o.id AND oc.role = 'customer'
    LEFT JOIN contacts c ON c.id = oc.contact_id
    LEFT JOIN workspace_settings ws ON ws.workspace_owner_id = o.workspace_owner_id
        WHERE o.id = $1
        LIMIT 1`,
      [orderId],
    );
    const order = orderRes.rows[0];
    if (!order) {
      logger.warn({ orderId }, "trustpilot: skipping enqueue — order not found");
      return "not_completion";
    }

    // Workspace toggle defaults ON when no settings row exists.
    if (order.trustpilot_invitations_enabled === false) {
      logger.info(
        { orderId, workspaceOwnerId: order.workspace_owner_id },
        "trustpilot: skipping enqueue — workspace toggle disabled",
      );
      return "workspace_disabled";
    }

    // Sensitive-occasion orders (sympathy/funeral/condolence) never receive a
    // review invitation. Record the suppression so the order detail card can
    // show it as intentionally suppressed rather than silently missing.
    if (order.is_sensitive_occasion === true) {
      logger.info(
        { orderId: order.id },
        "trustpilot: skipping enqueue — sensitive occasion order (suppressed)",
      );
      await db.query(
        `INSERT INTO trustpilot_invitations
           (order_id, workspace_owner_id, status, reference_id, last_error)
         VALUES ($1, $2, 'skipped', $3, $4)
         ON CONFLICT (order_id) DO NOTHING`,
        [
          order.id,
          order.workspace_owner_id,
          order.display_order_number ?? order.external_order_id ?? order.id,
          SENSITIVE_SUPPRESSION_MESSAGE,
        ],
      );
      return "suppressed_sensitive";
    }

    const email = (order.customer_email ?? "").trim();
    const country = addressCountry(order.delivery_address);
    const locale = resolveTrustpilotLocale(addressLanguage(order.delivery_address), country);
    const referenceId = order.display_order_number ?? order.external_order_id ?? order.id;
    const preferredSendTime = computePreferredSendTime(order.tookan_delivered_at);

    if (!email) {
      logger.warn(
        {
          orderId: order.id,
          referenceId,
          checkedSources: ["order_contacts(role=customer).email", "raw_payload.customer_email"],
        },
        "trustpilot: no customer email found — recording as skipped",
      );
      const ins = await db.query(
        `INSERT INTO trustpilot_invitations
           (order_id, workspace_owner_id, status, reference_id, locale, last_error)
         VALUES ($1, $2, 'skipped', $3, $4, 'No customer email on order')
         ON CONFLICT (order_id) DO NOTHING`,
        [order.id, order.workspace_owner_id, referenceId, locale],
      );
      const outcome = (ins.rowCount ?? 0) > 0 ? "skipped" : "duplicate";
      logger.info({ orderId: order.id, outcome }, `trustpilot: enqueue outcome: ${outcome}`);
      return outcome;
    }

    const ins = await db.query<{ id: string }>(
      `INSERT INTO trustpilot_invitations
         (order_id, workspace_owner_id, status, recipient_email, recipient_name,
          reference_id, locale, preferred_send_time)
       VALUES ($1, $2, 'pending', $3, $4, $5, $6, $7)
       ON CONFLICT (order_id) DO NOTHING
       RETURNING id`,
      [
        order.id,
        order.workspace_owner_id,
        email,
        order.customer_name ?? null,
        referenceId,
        locale,
        preferredSendTime,
      ],
    );
    if ((ins.rowCount ?? 0) === 0) {
      logger.info({ orderId: order.id }, "trustpilot: enqueue outcome: duplicate (row already exists)");
      return "duplicate";
    }

    const invitationId = ins.rows[0].id;
    logger.info(
      { orderId: order.id, invitationId, referenceId, locale, preferredSendTime },
      "trustpilot: invitation enqueued on order completion",
    );
    // Kick processing immediately; the sweep is the safety net.
    void processTrustpilotInvitation(invitationId).catch((err) =>
      logger.warn({ err, invitationId }, "trustpilot: immediate processing failed"),
    );
    return "enqueued";
  } catch (err) {
    logger.warn({ err, orderId }, "trustpilot: enqueue failed unexpectedly");
    return "error";
  }
}

type InvitationRow = {
  id: string;
  order_id: string;
  workspace_owner_id: string;
  recipient_email: string | null;
  recipient_name: string | null;
  reference_id: string | null;
  locale: string | null;
  preferred_send_time: string | null;
  attempt_count: number;
  channel: string | null;
  delivery_address: Record<string, unknown> | null;
};

/**
 * Claim and process one invitation. The claim UPDATE only matches rows in
 * `pending` (or long-stuck `processing`), so a row is never sent twice.
 */
export async function processTrustpilotInvitation(invitationId: string): Promise<void> {
  logger.info({ invitationId }, "trustpilot: process attempt started — claiming row");

  const claim = await db.query<InvitationRow>(
    `UPDATE trustpilot_invitations ti
        SET status = 'processing', updated_at = now()
       FROM orders o
      WHERE ti.id = $1
        AND o.id = ti.order_id
        AND (
          ti.status = 'pending'
          OR (ti.status = 'processing' AND ti.updated_at < now() - INTERVAL '${STUCK_PROCESSING_MINUTES} minutes')
        )
        AND ti.next_attempt_at <= now()
      RETURNING ti.id, ti.order_id, ti.workspace_owner_id, ti.recipient_email,
                ti.recipient_name, ti.reference_id, ti.locale, ti.preferred_send_time,
                ti.attempt_count, o.channel, o.delivery_address, o.is_sensitive_occasion`,
    [invitationId],
  );
  const row = claim.rows[0];
  if (!row) {
    logger.info({ invitationId }, "trustpilot: claim skipped — row not claimable (not pending/due or already claimed)");
    return;
  }

  logger.info(
    { invitationId: row.id, orderId: row.order_id, attemptCount: row.attempt_count, referenceId: row.reference_id, locale: row.locale },
    "trustpilot: row claimed for processing",
  );

  // Re-check the sensitive-occasion flag at send time: the flag may have been
  // toggled on after the row was enqueued (e.g. staff flagged the order while
  // the invitation was still pending). Never send for sensitive orders.
  if ((row as InvitationRow & { is_sensitive_occasion?: boolean }).is_sensitive_occasion === true) {
    logger.info(
      { invitationId: row.id, orderId: row.order_id },
      "trustpilot: order flagged sensitive occasion — marking suppressed instead of sending",
    );
    await db.query(
      `UPDATE trustpilot_invitations
          SET status = 'skipped', last_error = $2, updated_at = now()
        WHERE id = $1`,
      [row.id, SENSITIVE_SUPPRESSION_MESSAGE],
    );
    return;
  }

  if (!row.recipient_email) {
    logger.warn(
      { invitationId: row.id, orderId: row.order_id },
      "trustpilot: no recipient email on row — marking skipped",
    );
    await db.query(
      `UPDATE trustpilot_invitations
          SET status = 'skipped', last_error = 'No customer email on order', updated_at = now()
        WHERE id = $1`,
      [row.id],
    );
    return;
  }

  const country = addressCountry(row.delivery_address);
  const tags = [country, row.channel].filter(
    (t): t is string => typeof t === "string" && t.trim() !== "",
  );

  const referenceId = row.reference_id ?? row.order_id;
  const locale = row.locale ?? "en-US";
  const preferredSendTime = row.preferred_send_time ?? new Date().toISOString();

  logger.info(
    { invitationId: row.id, orderId: row.order_id, referenceId, locale, preferredSendTime, tags },
    "trustpilot: sending invitation request to Trustpilot API",
  );

  try {
    const result = await createTrustpilotInvitation({
      email: row.recipient_email,
      name: row.recipient_name,
      referenceId,
      locale,
      preferredSendTime,
      tags,
    });
    logger.info(
      {
        invitationId: row.id,
        orderId: row.order_id,
        trustpilotInvitationId: result.invitationId,
        hasResponsePayload: result.responsePayload != null,
      },
      "trustpilot: API call succeeded — marking created",
    );
    await db.query(
      `UPDATE trustpilot_invitations
          SET status = 'created',
              trustpilot_invitation_id = $1,
              response_payload = $2::jsonb,
              attempt_count = attempt_count + 1,
              last_error = NULL,
              last_attempt_at = now(),
              updated_at = now()
        WHERE id = $3`,
      [result.invitationId, JSON.stringify(result.responsePayload ?? null), row.id],
    );
    logger.info(
      { invitationId: row.id, orderId: row.order_id },
      "trustpilot: invitation created successfully",
    );
  } catch (err) {
    const attempts = row.attempt_count + 1;
    const message = err instanceof Error ? err.message : String(err);
    const retryable = isRetryableTrustpilotError(err) && attempts < MAX_TRUSTPILOT_ATTEMPTS;

    // Sanitize error: log status code and message but never token values.
    const sanitizedError = {
      message,
      status: err instanceof TrustpilotApiError ? err.status : null,
      body: err instanceof TrustpilotApiError ? err.body.slice(0, 500) : null,
      retryable,
      attempts,
    };

    if (retryable) {
      const backoff = backoffMinutesForAttempt(attempts);
      await db.query(
        `UPDATE trustpilot_invitations
            SET status = 'pending',
                attempt_count = $1,
                last_error = $2,
                next_attempt_at = now() + ($3 || ' minutes')::interval,
                last_attempt_at = now(),
                updated_at = now()
          WHERE id = $4`,
        [attempts, message.slice(0, 2000), String(backoff), row.id],
      );
      logger.warn(
        { invitationId: row.id, orderId: row.order_id, backoffMinutes: backoff, error: sanitizedError },
        "trustpilot: invitation attempt failed — will retry",
      );
    } else {
      await db.query(
        `UPDATE trustpilot_invitations
            SET status = 'failed',
                attempt_count = $1,
                last_error = $2,
                last_attempt_at = now(),
                updated_at = now()
          WHERE id = $3`,
        [attempts, message.slice(0, 2000), row.id],
      );
      logger.warn(
        { invitationId: row.id, orderId: row.order_id, error: sanitizedError },
        "trustpilot: invitation failed permanently",
      );
    }
  }
}

/** Sweep: process every due pending (or stuck-processing) invitation. */
export async function runTrustpilotInvitationSweep(): Promise<void> {
  if (!isTrustpilotEnabled()) return;
  const due = await db.query<{ id: string }>(
    `SELECT id FROM trustpilot_invitations
      WHERE (
              status = 'pending'
              OR (status = 'processing' AND updated_at < now() - INTERVAL '${STUCK_PROCESSING_MINUTES} minutes')
            )
        AND next_attempt_at <= now()
      ORDER BY next_attempt_at ASC
      LIMIT 25`,
  );
  for (const { id } of due.rows) {
    try {
      await processTrustpilotInvitation(id);
    } catch (err) {
      logger.warn({ err, invitationId: id }, "trustpilot: sweep processing failed");
    }
  }
}

export function startTrustpilotInvitationJob(): void {
  const tick = async () => {
    try {
      await runTrustpilotInvitationSweep();
    } catch (err) {
      logger.warn({ err }, "trustpilot invitation job error");
    }
  };
  setInterval(tick, SWEEP_INTERVAL_MS);
  setTimeout(tick, 20 * 1000);
  logger.info("Trustpilot invitation background job started");
}
