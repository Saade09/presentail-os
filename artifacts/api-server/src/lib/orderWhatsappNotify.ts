/**
 * Customer-facing WhatsApp order notifications via respond.io.
 *
 * Sends approved WhatsApp utility templates to the order's CUSTOMER contact
 * (never the gift recipient) when:
 *  - the order is placed            → template `new_order_received`
 *  - status → ready_for_delivery    → template `order_ready`
 *  - status → completed (delivered) → template `order_delivered`
 *
 * Template bodies are approved in respond.io (English). Positional params:
 *  - new_order_received: {{1}} first name, {{2}} order number,
 *                        {{3}} delivery date, {{4}} delivery time
 *  - order_ready:        {{1}} first name, {{2}} order number
 *  - order_delivered:    (no variables)
 *
 * All three templates include an IMAGE header filled with a branded per-event
 * image hosted in the public object-storage bucket (auth-free so Meta can
 * fetch it). Overridable per event via RESPONDIO_IMG_* env vars.
 *
 * EXPLICIT OPT-IN: messages are only sent to contacts with
 * `whatsapp_consent = TRUE` and no global unsubscribe. Possession of a phone
 * number alone never triggers a send.
 *
 * Best-effort and fire-and-forget: any failure is logged and never blocks
 * the order mutation. A respond.io contact is found-or-created on demand and
 * its ID persisted on the contact row (same as the auto-sync path).
 */
import { db } from "./db";
import { logger } from "./logger";
import type { PoolClient } from "pg";
import {
  isRespondIoEnabled,
  findOrCreateContactByPhone,
  isStrictE164,
  normalizePhone,
  sendWhatsAppTemplateToContact,
} from "./respondio";
import {
  buildOrderPaymentTemplateSendOptions,
  RESPONDIO_ORDER_PAYMENT_TEMPLATE_CONTRACTS,
  type OrderReadyFloristPhotoMedia,
  type RespondIoOrderPaymentTemplateName,
} from "./respondioOrderTemplates";
import { isWhishPayment } from "./orderInvoicePdf";
import { recordCommActivityEvent, trackOrderWhatsApp } from "./orderComms";
import { objectStorageService, buildPublicObjectUrl } from "./objectStorage";

type OrderWhatsAppNotificationDefinition = {
  templateName: RespondIoOrderPaymentTemplateName;
  mediaCapability: "static_header" | "approved_florist_item_photo";
};

/**
 * Event → exact provider-approved contract and media capability.
 * Only ready_for_delivery may resolve per-order florist media; completed is
 * permanently constrained to the order_delivered branded header.
 */
const NOTIFICATIONS: Record<string, OrderWhatsAppNotificationDefinition> = {
  created: {
    templateName: "new_order_received",
    mediaCapability: "static_header",
  },
  ready_for_delivery: {
    templateName: "order_ready",
    mediaCapability: "approved_florist_item_photo",
  },
  completed: {
    templateName: "order_delivered",
    mediaCapability: "static_header",
  },
};
const WHISH_TEMPLATE = RESPONDIO_ORDER_PAYMENT_TEMPLATE_CONTRACTS.whishpayment.templateName;

type WhishInstructionResult =
  | { ok: true; providerRef: string | null }
  | { ok: false; errorCode: string; errorMessage: string; retryable: boolean };

/**
 * Send the approved Whish payment-instructions template for one order.
 *
 * Automatic sends claim the row only while it has never successfully sent.
 * Manual sends use the same short claim lease but intentionally bypass that
 * one-success guard. Both paths finalize the claim only after respond.io
 * accepts the message, so a timeout or provider failure remains retryable.
 * All work is best-effort and the returned outcome is safe for route callers
 * to ignore.
 */
export async function sendWhishPaymentInstructions(
  orderId: string,
  workspaceOwnerId: string,
  options: {
    manual?: boolean;
    actorUserId?: string | null;
    actorName?: string | null;
  } = {},
): Promise<WhishInstructionResult> {
  const manual = options.manual === true;
  let claim: {
    currency: string | null;
    amount: string | number | null;
    claim_token: string;
  } | null = null;
  let claimToken: string | null = null;
  let contact: {
    id: string;
    phone: string | null;
    first_name: string | null;
    last_name: string | null;
    display_name: string | null;
    respondio_contact_id: string | null;
    whatsapp_consent?: boolean | null;
    unsubscribed_at?: Date | string | null;
  } | null = null;
  let communicationTracked = false;
  let activityPayload: Record<string, unknown> = {
    template: WHISH_TEMPLATE,
    mode: manual ? "manual_resend" : "automatic",
  };

  const fail = async (
    errorCode: string,
    errorMessage: string,
    retryable = true,
  ): Promise<WhishInstructionResult> => {
    activityPayload = {
      ...activityPayload,
      error_code: errorCode,
      error: errorMessage,
      retryable,
    };
    const updated = await db.query(
      `UPDATE order_payment
          SET whish_instructions_status = 'failed',
              whish_instructions_failure_reason = $2,
              whish_instructions_claimed_at = NULL,
              whish_instructions_claim_token = NULL,
              updated_at = now()
        WHERE order_id = $1
          AND whish_instructions_claim_token = $3`,
      [orderId, errorMessage, claimToken],
    ).catch((err) => logger.warn({ err, orderId }, "whish instructions: failed-state update failed"));
    // A stale worker must never write a failure audit event for another
    // worker's claim. `undefined` rowCount is accepted for lightweight tests.
    if (!updated || updated.rowCount !== 0) {
      if (!communicationTracked) {
        await trackOrderWhatsApp({
          workspaceOwnerId,
          orderId,
          templateType: "payment_instructions",
          templateName: WHISH_TEMPLATE,
          recipientName: contact?.display_name ?? null,
          recipientPhone: contact?.phone ? normalizePhone(contact.phone) : null,
          triggeredByUserId: options.actorUserId,
          triggeredByName: options.actorName,
          isResend: manual,
          skipReason: errorMessage,
        }).catch((err) =>
          logger.warn({ err, orderId }, "whish instructions: communication tracking failed"),
        );
        communicationTracked = true;
      }
      await recordCommActivityEvent({
        workspaceOwnerId,
        orderId,
        eventType: "whish_payment_instructions_failed",
        payload: activityPayload,
        actorUserId: options.actorUserId,
        actorName: options.actorName,
      }).catch((err) => logger.warn({ err, orderId }, "whish instructions: activity write failed"));
    }
    return { ok: false, errorCode, errorMessage, retryable };
  };

  try {
    // Claim only a currently unpaid Whish payment. The SQL predicate mirrors
    // isWhishPayment's exact, case-insensitive trimmed identifier check.
    const claimResult = await db.query<{
      currency: string | null;
      amount: string | number | null;
      claim_token: string;
    }>(
      `UPDATE order_payment
          SET whish_instructions_status = 'sending',
              whish_instructions_claimed_at = now(),
              whish_instructions_claim_token = gen_random_uuid(),
              whish_instructions_failure_reason = NULL,
              updated_at = now()
        WHERE order_id = $1
          AND LOWER(COALESCE(status, '')) NOT IN ('paid', 'refunded')
          AND (
            $2::boolean = TRUE
            OR whish_instructions_sent_at IS NULL
          )
          AND (
            LOWER(TRIM(COALESCE(method, ''))) = 'whish'
            OR LOWER(TRIM(COALESCE(provider, ''))) = 'whish'
          )
          AND whish_instructions_claim_token IS NULL
        RETURNING currency, amount, whish_instructions_claim_token AS claim_token`,
      [orderId, manual],
    );
    claim = claimResult.rows[0] ?? null;
    claimToken = claim?.claim_token ?? null;
    if (!claim) {
      return {
        ok: false,
        errorCode: manual ? "already_in_progress" : "not_eligible",
        errorMessage: manual
          ? "Another Whish instruction send is already in progress"
          : "Order is not an unpaid Whish order or instructions were already sent",
        retryable: !manual,
      };
    }
    if (!isRespondIoEnabled()) {
      return await fail("not_configured", "Respond.io is not configured", true);
    }

    const amount = claim.amount == null ? null : Number(claim.amount);
    const currency = claim.currency?.trim() || null;
    activityPayload = {
      ...activityPayload,
      currency,
      amount: amount != null && Number.isFinite(amount) ? amount.toFixed(2) : null,
    };
    if (!currency || amount == null || !Number.isFinite(amount)) {
      return await fail(
        "missing_amount",
        "The order has no authoritative stored payment currency and amount",
        true,
      );
    }

    const contactResult = await db.query<{
      id: string;
      phone: string | null;
      whatsapp_consent: boolean | null;
      unsubscribed_at: Date | string | null;
      first_name: string | null;
      last_name: string | null;
      display_name: string | null;
      respondio_contact_id: string | null;
    }>(
      `SELECT c.id, c.phone, c.whatsapp_consent, c.unsubscribed_at,
              c.first_name, c.last_name, c.display_name, c.respondio_contact_id
         FROM order_contacts oc
         JOIN contacts c ON c.id = oc.contact_id
       WHERE oc.order_id = $1
           AND oc.role = 'customer'
           AND c.workspace_owner_id = $2
        LIMIT 1`,
      [orderId, workspaceOwnerId],
    );
    contact = contactResult.rows[0] ?? null;
    const phone = contact?.phone?.trim() || null;
    if (!contact) {
      return await fail("missing_recipient", "No linked customer WhatsApp contact is available", true);
    }
    if (!phone) {
      return await fail("missing_recipient", "No opted-in customer WhatsApp number is available", true);
    }
    if (contact.whatsapp_consent !== true) {
      return await fail("consent_required", "Customer has not consented to WhatsApp updates", false);
    }
    if (contact.unsubscribed_at) {
      return await fail("unsubscribed", "Customer is unsubscribed from WhatsApp updates", false);
    }
    const normalizedPhone = normalizePhone(phone);
    if (!isStrictE164(normalizedPhone)) {
      return await fail("phone_format_invalid", "Customer WhatsApp number is not valid E.164", false);
    }

    const fullName =
      [contact.first_name, contact.last_name].filter((v): v is string => !!v?.trim()).join(" ").trim() ||
      contact.display_name?.trim() ||
      "there";
    let respondioId = contact.respondio_contact_id;
    if (!respondioId) {
       const created = await findOrCreateContactByPhone(normalizedPhone, contact.first_name, contact.last_name);
      if (created === "phone_format_invalid") {
         return await fail("phone_format_invalid", "Customer WhatsApp number is not valid E.164", false);
      }
      if (!created) {
        return await fail("contact_sync_failed", "Could not create or find the respond.io contact", true);
      }
      respondioId = created;
      await db.query(
        `UPDATE contacts SET respondio_contact_id = $1
          WHERE id = $2 AND respondio_contact_id IS NULL`,
        [respondioId, contact.id],
      );
    }

    activityPayload = {
      ...activityPayload,
      destination: phone,
      recipient_name: fullName,
    };
    // Payment confirmation can race an asynchronous dispatch. Recheck the
    // exact claim immediately before contacting Respond.io, while mark-paid
    // clears outstanding claim tokens.
    const dispatchAllowed = await db.query(
      `SELECT 1
         FROM order_payment
        WHERE order_id = $1
          AND whish_instructions_claim_token = $2
          AND LOWER(COALESCE(status, '')) NOT IN ('paid', 'refunded')`,
      [orderId, claimToken],
    );
    if (dispatchAllowed.rowCount === 0) {
      return {
        ok: false,
        errorCode: "not_eligible",
        errorMessage: "The Whish payment is no longer unpaid",
        retryable: false,
      };
    }
    const result = await trackOrderWhatsApp(
      {
        workspaceOwnerId,
        orderId,
        templateType: "payment_instructions",
        templateName: WHISH_TEMPLATE,
        recipientName: fullName,
        recipientPhone: normalizedPhone,
        triggeredByUserId: options.actorUserId,
        triggeredByName: options.actorName,
        isResend: manual,
      },
      () =>
        sendWhatsAppTemplateToContact(
          respondioId!,
          buildOrderPaymentTemplateSendOptions("whishpayment", [
            fullName,
            currency,
            amount.toFixed(2),
          ]),
        ),
    );
    communicationTracked = true;
    if (!result) {
      return await fail("unexpected_error", "WhatsApp communication tracking did not return a send outcome", true);
    }
    if (result.ok === false) {
      return await fail(result.errorCode, result.errorMessage, result.retryable);
    }

    const finalized = await db.query(
      `UPDATE order_payment
          SET whish_instructions_sent_at = now(),
              whish_instructions_provider_ref = $2,
              whish_instructions_status = 'sent',
              whish_instructions_failure_reason = NULL,
              whish_instructions_claimed_at = NULL,
              whish_instructions_claim_token = NULL,
              updated_at = now()
        WHERE order_id = $1
          AND whish_instructions_claim_token = $3
          AND LOWER(COALESCE(status, '')) NOT IN ('paid', 'refunded')
        RETURNING id`,
      [orderId, result.providerRef, claimToken],
    );
    if (finalized.rowCount === 0) {
      return {
        ok: false,
        errorCode: "not_eligible",
        errorMessage: "The Whish payment is no longer unpaid",
        retryable: false,
      };
    }
    activityPayload = {
      ...activityPayload,
      provider_ref: result.providerRef,
    };
    await recordCommActivityEvent({
      workspaceOwnerId,
      orderId,
      eventType: manual
        ? "whish_payment_instructions_resent"
        : "whish_payment_instructions_sent",
      payload: activityPayload,
      actorUserId: options.actorUserId,
      actorName: options.actorName,
    }).catch((err) => logger.warn({ err, orderId }, "whish instructions: activity write failed"));
    logger.info(
      { orderId, template: WHISH_TEMPLATE, destination: phone, currency, amount, providerRef: result.providerRef },
      "whish instructions: accepted by respond.io",
    );
    return { ok: true, providerRef: result.providerRef };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected Whish instruction send failure";
    logger.warn({ err, orderId }, "whish instructions: unexpected error");
    return await fail("unexpected_error", message, true);
  }
}

/** e.g. "18 August 2026" (UTC — matches the order status emails). */
function formatDate(value: Date | string | null): string | null {
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

/** e.g. "4:00 PM–7:00 PM" (UTC — delivery windows are stored as literal local times in UTC). */
function formatTimeRange(start: Date | string | null, end: Date | string | null): string | null {
  if (!start) return null;
  const s = start instanceof Date ? start : new Date(start);
  if (Number.isNaN(s.getTime())) return null;
  const fmt = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  });
  const e = end ? (end instanceof Date ? end : new Date(end)) : null;
  const endOk = e && !Number.isNaN(e.getTime());
  return endOk ? `${fmt.format(s)}–${fmt.format(e)}` : fmt.format(s);
}

async function releaseReadyPhotoLease(
  client: PoolClient,
  action: "COMMIT" | "ROLLBACK",
): Promise<void> {
  try {
    await client.query(action);
  } catch (err) {
    logger.warn({ err, action }, "order whatsapp notify: ready-photo lease release failed");
    // Never return a client with an uncertain/open transaction to the pool.
    client.release(true);
    return;
  }
  client.release();
}

/**
 * Send the WhatsApp order notification for `event` — "created" or the new
 * canonical order status. Statuses without a mapped template are a no-op.
 * Never throws.
 */
export async function notifyOrderStatusWhatsApp(
  orderId: string,
  orderNumber: string,
  event: string,
  workspaceOwnerId: string,
  options: {
    manual?: boolean;
    actorUserId?: string | null;
    actorName?: string | null;
  } = {},
): Promise<import("./respondio").RespondIoSendResult | null> {
  let readyPhotoLease: PoolClient | null = null;
  try {
    const notification = NOTIFICATIONS[event];
    if (!notification) return null;
    const { templateName } = notification;

    // Resolve the linked customer without filtering first. This lets the
    // communications card show useful audit rows for consent, unsubscribe,
    // missing-phone, and provider-configuration skips.
    const contactRes = await db.query<{
      id: string;
      phone: string | null;
      whatsapp_consent: boolean | null;
      unsubscribed_at: Date | string | null;
      first_name: string | null;
      last_name: string | null;
      display_name: string | null;
      respondio_contact_id: string | null;
    }>(
      `SELECT c.id, c.phone, c.whatsapp_consent, c.unsubscribed_at,
              c.first_name, c.last_name, c.display_name, c.respondio_contact_id
         FROM order_contacts oc
         JOIN contacts c ON c.id = oc.contact_id
        WHERE oc.order_id = $1
          AND oc.role = 'customer'
          AND c.workspace_owner_id = $2
        LIMIT 1`,
      [orderId, workspaceOwnerId],
    );
    const contact = contactRes.rows[0];
    const rawPhone = contact?.phone?.trim() || null;
    const normalizedPhone = rawPhone ? normalizePhone(rawPhone) : null;
    const firstName =
      contact?.first_name?.trim() ||
      contact?.display_name?.trim().split(/\s+/)[0] ||
      "there";
    const recipientName =
      [contact?.first_name, contact?.last_name]
        .filter((v): v is string => !!v?.trim())
        .join(" ")
        .trim() ||
      contact?.display_name?.trim() ||
      null;

    let skipReason: string | null = null;
    if (!contact) {
      skipReason = "No linked customer contact is available";
    } else if (!rawPhone) {
      skipReason = "No customer WhatsApp number is available";
    } else if (contact.whatsapp_consent !== true) {
      skipReason = "Customer has not consented to WhatsApp updates";
    } else if (contact.unsubscribed_at) {
      skipReason = "Customer is unsubscribed from WhatsApp updates";
    } else if (!normalizedPhone || !isStrictE164(normalizedPhone)) {
      skipReason = "Customer WhatsApp number is not valid E.164";
    } else if (!isRespondIoEnabled()) {
      skipReason = "Respond.io is not configured";
    }

    const trackingOpts = {
      workspaceOwnerId,
      orderId,
      templateType:
        event === "created"
          ? "order_confirmation"
          : event === "completed"
            ? "status_update"
            : "status_update",
      templateName,
      recipientName,
      recipientPhone: normalizedPhone,
      skipReason,
      triggeredByUserId: options.actorUserId,
      triggeredByName: options.actorName,
      isResend: options.manual === true,
    } as const;

    if (skipReason) {
      await trackOrderWhatsApp(trackingOpts);
      return null;
    }
    const validPhone = normalizedPhone!;

    // Resolve (and persist) the respond.io contact ID.
    let respondioId = contact.respondio_contact_id;
    if (!respondioId) {
      const created = await findOrCreateContactByPhone(
        validPhone,
        contact.first_name,
        contact.last_name,
      );
      if (!created || created === "phone_format_invalid") {
        await trackOrderWhatsApp({
          ...trackingOpts,
          skipReason:
            created === "phone_format_invalid"
              ? "Customer WhatsApp number is not valid E.164"
              : "Could not create or find the respond.io contact",
        });
        logger.info(
          { orderId, contactId: contact.id, reason: created ?? "api_failure" },
          "order whatsapp notify: skipped (no respond.io contact)",
        );
        return null;
      }
      respondioId = created;
      await db.query(
        `UPDATE contacts SET respondio_contact_id = $1 WHERE id = $2 AND respondio_contact_id IS NULL`,
        [respondioId, contact.id],
      );
    }

    let bodyParameters: string[] = [];

    if (event === "created") {
      const orderRes = await db.query<{
        window_start: string | null;
        window_end: string | null;
        addr_date: string | null;
        addr_slot: string | null;
      }>(
        `SELECT window_start, window_end,
                delivery_address->>'date' AS addr_date,
                delivery_address->>'slot' AS addr_slot
         FROM orders WHERE id = $1 AND workspace_owner_id = $2`,
        [orderId, workspaceOwnerId],
      );
      const win = orderRes.rows[0];
      const dateParam =
        formatDate(win?.addr_date ?? null) ??
        formatDate(win?.window_start ?? null) ??
        "To be confirmed";
      const timeParam =
        formatTimeRange(win?.window_start ?? null, win?.window_end ?? null) ??
        (win?.addr_slot?.trim() || null) ??
        "To be confirmed";
      bodyParameters = [firstName, orderNumber, dateParam, timeParam];
    } else if (event === "ready_for_delivery") {
      bodyParameters = [firstName, orderNumber];
    }
    // completed → order_delivered has static body text and no variables.

    // For ready_for_delivery, try to use the florist-submitted items photo as
    // the header image so the customer sees their actual arrangement.
    // Any failure (missing/unapproved assignment, copy error) is silently caught
    // and falls back to the standard static branded image — the send is never
    // blocked by a photo-copy failure.
    let media: OrderReadyFloristPhotoMedia | undefined;
    if (notification.mediaCapability === "approved_florist_item_photo") {
      try {
        const assignmentRes = await db.query<{
          id: number;
          photo_items_path: string | null;
          photo_set_rev: number;
        }>(
          `SELECT id, photo_items_path, photo_set_rev
             FROM order_florist_assignments
            WHERE order_id = $1
              AND workspace_owner_id = $2
              AND verification_status = 'approved'
              AND photo_items_path IS NOT NULL
            LIMIT 1`,
          [orderId, workspaceOwnerId],
        );
        const approvedPhoto = assignmentRes.rows[0] ?? null;
        const photoItemsPath = approvedPhoto?.photo_items_path ?? null;
        if (photoItemsPath) {
          const publicKey = await objectStorageService.copyPrivateObjectToPublic(
            photoItemsPath,
            `whatsapp-order-ready/${workspaceOwnerId}/${orderId}/rev-${approvedPhoto.photo_set_rev}`,
            workspaceOwnerId,
          );
          const publicUrl = buildPublicObjectUrl(publicKey);
          if (publicUrl) {
            // The copy can take long enough for a florist to replace/reassign
            // the photo set. Revalidate the exact approved revision under a
            // shared row lock and hold it through Respond.io acceptance.
            // Replacement UPDATEs then either win before this check (static
            // fallback) or wait until this send has finished.
            const leaseClient = await db.connect();
            try {
              await leaseClient.query("BEGIN");
              // Slightly exceed the bounded 15-second Respond.io send. Postgres
              // will terminate an unexpectedly idle transaction even if the
              // application process fails before normal cleanup.
              await leaseClient.query(
                "SET LOCAL idle_in_transaction_session_timeout = '20s'",
              );
              const stillApproved = await leaseClient.query(
                `SELECT 1
                   FROM order_florist_assignments
                  WHERE id = $1
                    AND order_id = $2
                    AND workspace_owner_id = $3
                    AND verification_status = 'approved'
                    AND photo_items_path = $4
                    AND photo_set_rev = $5
                  FOR SHARE`,
                [
                  approvedPhoto.id,
                  orderId,
                  workspaceOwnerId,
                  photoItemsPath,
                  approvedPhoto.photo_set_rev,
                ],
              );
              if ((stillApproved.rowCount ?? 0) > 0) {
                readyPhotoLease = leaseClient;
                media = {
                  kind: "order_ready_florist_item_photo",
                  publicUrl,
                };
              } else {
                await releaseReadyPhotoLease(leaseClient, "ROLLBACK");
                logger.info(
                  {
                    orderId,
                    assignmentId: approvedPhoto.id,
                    photoSetRev: approvedPhoto.photo_set_rev,
                  },
                  "order whatsapp notify: florist photo changed before send — using static fallback",
                );
              }
            } catch (leaseErr) {
              await releaseReadyPhotoLease(leaseClient, "ROLLBACK");
              throw leaseErr;
            }
          }
        }
      } catch (photoErr) {
        logger.warn(
          { err: photoErr, orderId },
          "order whatsapp notify: florist photo copy failed — using static fallback",
        );
      }
    }

    const sendOptions = buildOrderPaymentTemplateSendOptions(
      templateName,
      bodyParameters,
      media,
    );

    // Guard: if the approved template includes a required image header but no
    // publicly reachable image was resolved, sending would produce a payload
    // that doesn't match the approved template structure — Meta/respond.io
    // rejects such messages outright. Skip and log so the problem is visible.
    if (sendOptions.contract.requiresImageHeader && !sendOptions.headerImageUrl) {
      if (readyPhotoLease) {
        await releaseReadyPhotoLease(readyPhotoLease, "ROLLBACK");
        readyPhotoLease = null;
      }
      await trackOrderWhatsApp({
        ...trackingOpts,
        recipientPhone: normalizedPhone,
        skipReason: "WhatsApp template header image is not configured",
      });
      return null;
    }

    const result = await trackOrderWhatsApp(
      trackingOpts,
      () =>
        sendWhatsAppTemplateToContact(respondioId!, sendOptions),
    );
    if (readyPhotoLease) {
      await releaseReadyPhotoLease(readyPhotoLease, "COMMIT");
      readyPhotoLease = null;
    }

    if (result?.ok) {
      logger.info(
        { orderId, event, templateName, providerRef: result.providerRef },
        "order whatsapp notify: accepted by respond.io",
      );
    } else if (result) {
      logger.warn(
        { orderId, event, templateName, errorCode: result.errorCode, errorMessage: result.errorMessage },
        "order whatsapp notify: send failed",
      );
    }
    return result;
  } catch (err) {
    if (readyPhotoLease) {
      await releaseReadyPhotoLease(readyPhotoLease, "ROLLBACK");
      readyPhotoLease = null;
    }
    logger.warn({ err, orderId, event }, "order whatsapp notify: unexpected error");
    return null;
  }
}

/**
 * Delivered-only entry point for delayed jobs. Keeping this separate from the
 * status router makes it impossible for queue processing to request or forward
 * the ready event's florist-photo capability.
 */
export async function notifyDeliveredOrderWhatsApp(
  orderId: string,
  orderNumber: string,
  workspaceOwnerId: string,
): Promise<import("./respondio").RespondIoSendResult | null> {
  return notifyOrderStatusWhatsApp(
    orderId,
    orderNumber,
    "completed",
    workspaceOwnerId,
  );
}
