/**
 * The approved Respond.io contracts for customer order and payment messages.
 *
 * This is deliberately limited to the four templates owned by the order
 * workflow. Address Collector has its own language/template selection because
 * it supports a separate bilingual provider contract.
 */
import { buildPublicObjectUrl } from "./objectStorage";
import type { RespondIoTemplateContract } from "./respondio";

export const RESPONDIO_ORDER_PAYMENT_TEMPLATE_CONTRACTS = {
  new_order_received: {
    templateName: "new_order_received",
    languageCode: "en",
    bodyParameterCount: 4,
    includeBodyComponent: true,
    requiresImageHeader: true,
    requiresChannelId: true,
    providerComponentOrder: ["header", "body", "footer"],
    staticBodyText:
      "Hi {{1}}! 🌸\nWe’ve received your order.\n\n*Order Number:* {{2}}\n*Delivery Date:* {{3}}\n*Delivery Time:* {{4}}\n\nWe’ll send you a photo of your arrangement here before it goes out for delivery. 💐",
    staticFooterText: "Natasha From Presentail Support",
  },
  order_ready: {
    templateName: "order_ready",
    languageCode: "en",
    bodyParameterCount: 2,
    includeBodyComponent: true,
    requiresImageHeader: true,
    requiresChannelId: true,
    providerComponentOrder: ["header", "body"],
    staticBodyText: "Hi {{1}}. Natasha here! Your order is now ready. 😁\n\n*Order Number:* {{2}} ❤️",
  },
  order_delivered: {
    templateName: "order_delivered",
    languageCode: "en",
    bodyParameterCount: 0,
    // The approved delivered template has static thank-you/review copy. Its
    // empty parameter list must still be serialized as a body component.
    includeBodyComponent: true,
    requiresImageHeader: true,
    requiresChannelId: true,
    providerComponentOrder: ["header", "body", "buttons"],
    staticBodyText:
      "Your order has been delivered! 💐\n\nThank you for choosing Presentail ❤️ We hope they love it!\n\nIf you have a moment, we’d really appreciate it if you could leave us a review. Your feedback means a lot to us.",
    staticButtons: [
      {
        type: "url",
        text: "Leave a Review",
        url: "https://g.page/r/CWGtXONHheoLEBM/review",
      },
    ],
  },
  whishpayment: {
    templateName: "whishpayment",
    languageCode: "en",
    bodyParameterCount: 3,
    includeBodyComponent: true,
    requiresImageHeader: false,
    requiresChannelId: true,
    providerComponentOrder: ["body"],
    staticBodyText:
      "Hi {{1}},\n\nTo finish your order, please send your payment via Whish to the account number below. Once we receive it, we'll confirm your order right away.\n\n*WHISH ACCOUNT NUMBER:* +961 3 159 639\n\n*AMOUNT DUE:* {{2}} {{3}}\n\nThank you. ",
  },
} as const satisfies Record<string, RespondIoTemplateContract>;

export type RespondIoOrderPaymentTemplateName =
  keyof typeof RESPONDIO_ORDER_PAYMENT_TEMPLATE_CONTRACTS;

/**
 * Per-order media is intentionally narrower than a generic header override.
 * The only approved dynamic-media capability is the florist item photo on the
 * order_ready template. Other templates always resolve their own branded
 * header, even if this capability is accidentally forwarded to them.
 */
export type OrderReadyFloristPhotoMedia = {
  kind: "order_ready_florist_item_photo";
  publicUrl: string;
};

export function selectedRespondIoWhatsAppChannelId(): number | null {
  const raw = process.env.RESPONDIO_CHANNEL_ID?.trim();
  if (!raw) return null;
  const channelId = Number(raw);
  return Number.isSafeInteger(channelId) && channelId > 0 ? channelId : null;
}

/**
 * Dynamic image headers must be publicly retrievable by Meta/respond.io.
 * Environment overrides are retained for approved replacement artwork.
 */
export function orderPaymentTemplateHeaderImage(
  templateName: RespondIoOrderPaymentTemplateName,
): string | null {
  const overrideByTemplate: Partial<Record<RespondIoOrderPaymentTemplateName, string | undefined>> = {
    new_order_received: process.env.RESPONDIO_IMG_NEW_ORDER,
    order_ready: process.env.RESPONDIO_IMG_ORDER_READY,
    order_delivered: process.env.RESPONDIO_IMG_ORDER_DELIVERED,
  };
  const override = overrideByTemplate[templateName]?.trim();
  if (override) return override;

  const publicKeyByTemplate: Partial<Record<RespondIoOrderPaymentTemplateName, string>> = {
    new_order_received: "whatsapp/new-order-received.png",
    order_ready: "whatsapp/order-ready.png",
    order_delivered: "whatsapp/order-delivered.png",
  };
  const key = publicKeyByTemplate[templateName];
  return key ? buildPublicObjectUrl(key) : null;
}

/**
 * Use this factory for every order/payment send so production and the smoke
 * utility have one source for the provider-facing contract.
 *
 * @param media  Ready-only capability for the approved florist item photo.
 *   Passing it with any other template is ignored at runtime, so delivered
 *   notifications cannot accidentally inherit ready-event media.
 */
export function buildOrderPaymentTemplateSendOptions(
  templateName: RespondIoOrderPaymentTemplateName,
  bodyParameters: string[],
  media?: OrderReadyFloristPhotoMedia | null,
) {
  const contract = RESPONDIO_ORDER_PAYMENT_TEMPLATE_CONTRACTS[templateName];
  const readyPhotoUrl =
    templateName === "order_ready" &&
    media?.kind === "order_ready_florist_item_photo"
      ? media.publicUrl
      : null;
  const resolvedHeaderImageUrl = contract.requiresImageHeader
    ? (readyPhotoUrl ?? orderPaymentTemplateHeaderImage(templateName))
    : null;
  return {
    contract,
    bodyParameters,
    channelId: selectedRespondIoWhatsAppChannelId(),
    headerImageUrl: resolvedHeaderImageUrl,
  };
}