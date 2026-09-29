import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { db } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";
import {
  requireOrderAccess,
  lookupOrderCustomerContact,
  lookupOrderEmailDetails,
  formatOrderAmount,
} from "./orders";
import {
  sendOrderConfirmationEmail,
  sendOrderPaymentInstructionsEmail,
  sendOrderPaymentReceivedEmail,
  sendOrderStatusEmail,
  sendOrderRefundEmail,
  ORDER_STATUS_EMAIL_STATUSES,
} from "../lib/email";
import {
  trackOrderEmail,
  ORDER_COMM_TEMPLATE_TYPES,
  type OrderCommTemplateType,
} from "../lib/orderComms";
import {
  notifyOrderStatusWhatsApp,
  sendWhishPaymentInstructions,
} from "../lib/orderWhatsappNotify";
import { isRespondIoEnabled, isStrictE164, normalizePhone } from "../lib/respondio";

const router = Router();

router.use("/orders/:id/communications", requireAuth, resolveWorkspace);

type OrderRow = {
  id: string;
  status: string;
  external_order_id: string | null;
  display_order_number: string | null;
};

async function loadOrder(
  orderId: string,
  workspaceOwnerId: string,
): Promise<OrderRow | null> {
  const result = await db.query<OrderRow>(
    `SELECT id, status, external_order_id, display_order_number
       FROM orders
      WHERE id = $1 AND workspace_owner_id = $2
      LIMIT 1`,
    [orderId, workspaceOwnerId],
  );
  return result.rows[0] ?? null;
}

/**
 * GET /orders/:id/communications — list every recorded communication for the
 * order (newest first) with its provider event history, plus customer contact
 * availability for email and approved WhatsApp template actions. Viewable by
 * anyone who can view the order (workspace member).
 */
router.get(
  "/orders/:id/communications",
  async (req: Request, res: Response): Promise<void> => {
    const wreq = workspace(req);
    const { id } = req.params;

    const order = await loadOrder(String(id), wreq.workspaceOwnerId);
    if (!order) {
      res.status(404).json({ success: false, error: "Order not found" });
      return;
    }

    const [commsResult, customer, whatsappContact] = await Promise.all([
      db.query<{
        id: string;
        template_type: string;
        channel: string;
        recipient_role: string;
        recipient_name: string | null;
        recipient_email: string | null;
        recipient_phone: string | null;
        subject: string | null;
        template_name: string | null;
        provider: string;
        provider_message_id: string | null;
        status: string;
        attempt: number;
        failure_reason: string | null;
        triggered_by_user_id: string | null;
        triggered_by_name: string | null;
        created_at: Date;
        sent_at: Date | null;
        delivered_at: Date | null;
        opened_at: Date | null;
        clicked_at: Date | null;
        last_event_at: Date | null;
      }>(
        `SELECT id, template_type, channel, recipient_role, recipient_name, recipient_email,
                recipient_phone, subject, template_name, provider, provider_message_id, status, attempt,
                failure_reason, triggered_by_user_id, triggered_by_name,
                created_at, sent_at, delivered_at, opened_at, clicked_at,
                last_event_at
           FROM order_communications
          WHERE order_id = $1 AND workspace_owner_id = $2
          ORDER BY created_at DESC, attempt DESC`,
        [id, wreq.workspaceOwnerId],
      ),
      lookupOrderCustomerContact(String(id)),
      db.query<{
        phone: string | null;
        whatsapp_consent: boolean | null;
        unsubscribed_at: Date | null;
      }>(
        `SELECT c.phone, c.whatsapp_consent, c.unsubscribed_at
           FROM order_contacts oc
           JOIN contacts c ON c.id = oc.contact_id
          WHERE oc.order_id = $1
            AND oc.role = 'customer'
            AND c.workspace_owner_id = $2
          LIMIT 1`,
        [id, wreq.workspaceOwnerId],
      ),
    ]);

    const commIds = commsResult.rows.map((r) => r.id);
    const eventsByComm = new Map<
      string,
      { eventType: string; rawType: string | null; occurredAt: string }[]
    >();
    if (commIds.length > 0) {
      const eventsResult = await db.query<{
        communication_id: string;
        event_type: string;
        raw_type: string | null;
        occurred_at: Date;
      }>(
        `SELECT communication_id, event_type, raw_type, occurred_at
           FROM order_communication_events
          WHERE communication_id = ANY($1::uuid[])
          ORDER BY occurred_at ASC`,
        [commIds],
      );
      for (const e of eventsResult.rows) {
        const list = eventsByComm.get(e.communication_id) ?? [];
        list.push({
          eventType: e.event_type,
          rawType: e.raw_type,
          occurredAt: e.occurred_at.toISOString(),
        });
        eventsByComm.set(e.communication_id, list);
      }
    }

    const customerPhone = whatsappContact.rows[0]?.phone?.trim() || null;
    const whatsappEligible =
      isRespondIoEnabled() &&
      whatsappContact.rows[0]?.whatsapp_consent === true &&
      !whatsappContact.rows[0]?.unsubscribed_at &&
      !!customerPhone &&
      isStrictE164(normalizePhone(customerPhone));

    res.json({
      success: true,
      customerEmail: customer.email,
      customerName: customer.name,
      customerPhone,
      whatsappEligible,
      communications: commsResult.rows.map((r) => ({
        id: r.id,
        templateType: r.template_type,
        templateName: r.template_name,
        channel: r.channel,
        recipientRole: r.recipient_role,
        recipientName: r.recipient_name,
        recipientEmail: r.recipient_email,
        recipientPhone: r.recipient_phone,
        subject: r.subject,
        provider: r.provider,
        providerMessageId: r.provider_message_id,
        status: r.status,
        attempt: r.attempt,
        failureReason: r.failure_reason,
        triggeredByName: r.triggered_by_name,
        createdAt: r.created_at.toISOString(),
        sentAt: r.sent_at?.toISOString() ?? null,
        deliveredAt: r.delivered_at?.toISOString() ?? null,
        openedAt: r.opened_at?.toISOString() ?? null,
        clickedAt: r.clicked_at?.toISOString() ?? null,
        lastEventAt: r.last_event_at?.toISOString() ?? null,
        events: eventsByComm.get(r.id) ?? [],
      })),
    });
  },
);

const sendBodySchema = z.object({
  templateType: z.enum(
    ORDER_COMM_TEMPLATE_TYPES as unknown as [string, ...string[]],
  ),
  /** Present when resending an existing communication row. */
  communicationId: z.string().uuid().optional(),
  /** Optional corrected email to store on the customer contact and use. */
  email: z.string().email().optional(),
  /** Email remains the default; WhatsApp only sends approved templates. */
  channel: z.enum(["email", "whatsapp"]).default("email"),
});

/**
 * POST /orders/:id/communications/send — manual send/resend of an approved
 * order email or WhatsApp template. Permission-gated like other order
 * mutations. When `email` is
 * provided it also updates the order's customer contact email (add/correct
 * flow). Records who triggered the send.
 */
router.post(
  "/orders/:id/communications/send",
  async (req: Request, res: Response): Promise<void> => {
    const wreq = workspace(req);
    if (!requireOrderAccess(wreq, res)) return;
    const { id } = req.params;

    const parsed = sendBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ success: false, error: "Invalid request body" });
      return;
    }
    const templateType = parsed.data.templateType as OrderCommTemplateType;
    const isResend = Boolean(parsed.data.communicationId);

    const order = await loadOrder(String(id), wreq.workspaceOwnerId);
    if (!order) {
      res.status(404).json({ success: false, error: "Order not found" });
      return;
    }

    if (parsed.data.channel === "whatsapp") {
      if (parsed.data.email) {
        res.status(400).json({
          success: false,
          error: "WhatsApp updates can only use the linked customer contact",
        });
        return;
      }

      let result:
        | { ok: true; providerRef: string | null }
        | { ok: false; errorCode: string; errorMessage: string; retryable: boolean }
        | null;
      const whatsappOptions = {
        manual: true,
        actorUserId: wreq.userId,
        actorName: wreq.userEmail,
      };
      const orderNumber =
        order.display_order_number ?? order.external_order_id ?? String(id);
      let whatsappTemplateType = templateType;
      let approvedTemplateName: string | null = null;

      if (parsed.data.communicationId) {
        const original = await db.query<{
          template_type: string;
          template_name: string | null;
          channel: string;
        }>(
          `SELECT template_type, template_name, channel
             FROM order_communications
            WHERE id = $1 AND order_id = $2 AND workspace_owner_id = $3
            LIMIT 1`,
          [parsed.data.communicationId, id, wreq.workspaceOwnerId],
        );
        const originalRow = original.rows[0];
        if (!originalRow || originalRow.channel !== "whatsapp") {
          res.status(422).json({
            success: false,
            error: "The selected WhatsApp communication is no longer available",
          });
          return;
        }
        if (originalRow.template_type !== templateType) {
          res.status(400).json({
            success: false,
            error: "The requested template does not match the selected communication",
          });
          return;
        }
        whatsappTemplateType = originalRow.template_type as OrderCommTemplateType;
        approvedTemplateName = originalRow.template_name;
      }

      if (
        whatsappTemplateType === "order_confirmation" &&
        (!approvedTemplateName || approvedTemplateName === "new_order_received")
      ) {
        result = await notifyOrderStatusWhatsApp(
          String(id),
          orderNumber,
          "created",
          wreq.workspaceOwnerId,
          whatsappOptions,
        );
      } else if (whatsappTemplateType === "status_update") {
        const event =
          approvedTemplateName === "order_ready"
            ? "ready_for_delivery"
            : approvedTemplateName === "order_delivered"
              ? "completed"
              : order.status === "ready_for_delivery" || order.status === "completed"
                ? order.status
                : null;
        if (!event) {
          res.status(422).json({
            success: false,
            error: "No approved WhatsApp update is available for this order status",
          });
          return;
        }
        result = await notifyOrderStatusWhatsApp(
          String(id),
          orderNumber,
          event,
          wreq.workspaceOwnerId,
          whatsappOptions,
        );
      } else if (
        whatsappTemplateType === "payment_instructions" &&
        (!approvedTemplateName || approvedTemplateName === "whishpayment")
      ) {
        const whish = await sendWhishPaymentInstructions(String(id), wreq.workspaceOwnerId, whatsappOptions);
        result = whish.ok
          ? { ok: true, providerRef: whish.providerRef }
          : whish;
      } else {
        res.status(422).json({
          success: false,
          error: "This WhatsApp template is not approved for order updates",
        });
        return;
      }

      if (!result?.ok) {
        const error =
          result && "errorMessage" in result
            ? result.errorMessage
            : "WhatsApp update was not sent. Check the customer phone, consent, and Respond.io configuration.";
        const providerFailed =
          result &&
          "errorCode" in result &&
          (result.errorCode === "network_error" || result.errorCode.startsWith("http_"));
        res.status(providerFailed ? 502 : 422).json({ success: false, error });
        return;
      }

      req.log.info(
        {
          orderId: id,
          userId: wreq.userId,
          templateType,
          isResend,
          channel: "whatsapp",
          action: "order.communication_send",
        },
        "Manual order WhatsApp communication send",
      );
      res.json({
        success: true,
        channel: "whatsapp",
        provider_message_id: result.providerRef,
      });
      return;
    }

    // Add/correct email: persist onto the order's customer contact.
    if (parsed.data.email) {
      await db.query(
        `UPDATE contacts c
            SET email = $1, updated_at = now()
           FROM order_contacts oc
          WHERE oc.order_id = $2
            AND oc.role = 'customer'
            AND oc.contact_id = c.id
            AND c.workspace_owner_id = $3`,
        [parsed.data.email, id, wreq.workspaceOwnerId],
      );
    }

    const customer = await lookupOrderCustomerContact(String(id));
    const toEmail = parsed.data.email ?? customer.email;
    if (!toEmail) {
      res.status(400).json({ success: false, error: "No email address on file" });
      return;
    }

    const orderNumber =
      order.display_order_number ?? order.external_order_id ?? String(id);
    const customerName = customer.name;

    const result = await trackOrderEmail(
      {
        workspaceOwnerId: wreq.workspaceOwnerId,
        orderId: String(id),
        templateType,
        recipientName: customerName,
        recipientEmail: toEmail,
        triggeredByUserId: wreq.userId,
        triggeredByName: wreq.userEmail,
        isResend,
      },
      async () => {
        const details = await lookupOrderEmailDetails(
          String(id),
          wreq.workspaceOwnerId,
        );
        switch (templateType) {
          case "order_confirmation":
            return sendOrderConfirmationEmail({
              toEmail,
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
            });
          case "payment_instructions":
            return sendOrderPaymentInstructionsEmail({
              toEmail,
              orderNumber,
              customerName,
              amountDueText: details.amountPaidText,
              items: details.items,
              deliveryDateText: details.deliveryDateText,
            });
          case "payment_received":
            return sendOrderPaymentReceivedEmail({
              toEmail,
              orderNumber,
              customerName,
              items: details.items,
              amountPaidText: details.amountPaidText,
              deliveryDateText: details.deliveryDateText,
            });
          case "status_update": {
            // Fall back to a generic processing update for statuses outside
            // the customer-facing set (route rejects instead of silently
            // skipping so the UI can explain).
            const status = ORDER_STATUS_EMAIL_STATUSES.has(order.status)
              ? order.status
              : null;
            if (!status) {
              return {
                sent: false,
                skipped: true,
                messageId: null,
                errorMessage: `No customer email template for status "${order.status}"`,
                subject: "",
              };
            }
            return sendOrderStatusEmail({
              toEmail,
              orderNumber,
              status,
              customerName,
              items: details.items,
              amountPaidText: details.amountPaidText,
              deliveryDateText: details.deliveryDateText,
            });
          }
          case "refund": {
            const payment = await db.query<{
              refunded_amount: string | number | null;
              currency: string | null;
            }>(
              `SELECT refunded_amount, currency
                 FROM order_payment
                WHERE order_id = $1
                LIMIT 1`,
              [id],
            );
            const p = payment.rows[0];
            const refunded =
              p?.refunded_amount != null ? Number(p.refunded_amount) : null;
            const currency = p?.currency ?? "USD";
            return sendOrderRefundEmail({
              toEmail,
              orderNumber,
              isPartial: false,
              customerName,
              refundAmountText:
                refunded != null && Number.isFinite(refunded)
                  ? formatOrderAmount(refunded, currency)
                  : null,
              totalRefundedText:
                refunded != null && Number.isFinite(refunded)
                  ? formatOrderAmount(refunded, currency)
                  : null,
              items: details.items,
              amountPaidText: details.amountPaidText,
              deliveryDateText: details.deliveryDateText,
            });
          }
          default:
            throw new Error(`Unsupported order communication template: ${templateType}`);
        }
      },
    );

    if (!result) {
      res.status(500).json({ success: false, error: "Send failed" });
      return;
    }
    if (!result.sent) {
      res.status(502).json({
        success: false,
        error: result.errorMessage ?? "Email was not sent",
      });
      return;
    }

    req.log.info(
      {
        orderId: id,
        userId: wreq.userId,
        templateType,
        isResend,
        action: "order.communication_send",
      },
      "Manual order communication send",
    );

    res.json({ success: true });
  },
);

export default router;
