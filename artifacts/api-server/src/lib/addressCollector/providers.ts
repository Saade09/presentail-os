/**
 * Address Collector — outbound message providers.
 *
 * WhatsApp: respond.io WhatsApp template send (respondio module). SMS
 * fallback: Twilio, using the same credential pattern as fleet driver
 * notifications.
 *
 * Both providers return a normalized result distinguishing retryable from
 * permanent failures. "Accepted" by the provider API is NEVER treated as
 * delivered — delivery status arrives separately (webhook or timeout).
 */
import { logger } from "../logger";
import {
  isRespondIoEnabled,
  findOrCreateContactByPhone,
  sendWhatsAppTemplateToContact,
  setContactCustomAttributes,
} from "../respondio";
import {
  ADDRESS_COLLECTION_TEMPLATE_CONTRACT,
  isPublicHttpsUrl,
  respondIoChannelId,
} from "./config";

export type ProviderSendResult =
  | { ok: true; providerRef: string | null; respondioContactId?: string }
  | {
      ok: false;
      retryable: boolean;
      blockedByConfig?: boolean;
      /** True only when no template-dispatch request reached respond.io. */
      preSendFailure?: boolean;
      errorCode: string;
      errorMessage: string;
    };

/** Surprise-safe delivery-window label, e.g. "today between 4–7 PM". */
export function formatWindowLabel(
  windowStart: Date | null,
  windowEnd: Date | null,
  timezone: string,
  language: string,
): string {
  if (!windowStart) return language === "ar" ? "قريباً" : "soon";
  const dayFmt = new Intl.DateTimeFormat(language === "ar" ? "ar" : "en-US", {
    timeZone: timezone,
    weekday: "long",
    month: "short",
    day: "numeric",
  });
  const timeFmt = new Intl.DateTimeFormat(language === "ar" ? "ar" : "en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
  });
  const day = dayFmt.format(windowStart);
  const start = timeFmt.format(windowStart);
  const end = windowEnd ? timeFmt.format(windowEnd) : null;
  return end ? `${day}, ${start}–${end}` : `${day}, ${start}`;
}

/**
 * Send the WhatsApp address-collection message via respond.io:
 * find/create the respond.io contact → send the approved WhatsApp template.
 *
 * The message copy lives in the approved WhatsApp template. The
 * address_collection contract supplies exactly one body variable: recipient
 * name. The template is always English and always sent through channel 543704.
 * The request ref is persisted on the request row and correlated back via
 * the delivery-status webhook (see /webhooks/respondio/address-status).
 */
export async function sendWhatsAppAddressRequest(opts: {
  phone: string;
  recipientName: string;
  orderReference: string;
  language: string;
  secureUrl: string;
  requestRef: string;
}): Promise<ProviderSendResult> {
  const recipientName = opts.recipientName.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (!recipientName) {
    return {
      ok: false,
      retryable: false,
      blockedByConfig: true,
      preSendFailure: true,
      errorCode: "missing_template_value",
      errorMessage: "Address request template values are incomplete",
    };
  }
  if (!isRespondIoEnabled()) {
    return {
      ok: false,
      retryable: false,
      blockedByConfig: true,
      preSendFailure: true,
      errorCode: "respondio_not_configured",
      errorMessage: "RESPONDIO_API_TOKEN is not set",
    };
  }
  const respondioContactId = await findOrCreateContactByPhone(opts.phone, recipientName);
  if (respondioContactId === "phone_format_invalid") {
    return {
      ok: false,
      retryable: false,
      preSendFailure: true,
      errorCode: "phone_invalid",
      errorMessage: "Recipient phone is not a valid E.164 number for WhatsApp",
    };
  }
  if (!respondioContactId) {
    return {
      ok: false,
      retryable: true,
      preSendFailure: true,
      errorCode: "contact_lookup_failed",
      errorMessage: "respond.io contact lookup/create failed",
    };
  }

  // Write requestRef onto the contact so respond.io's Workflow can include
  // it as `request_ref` in the delivery-status webhook body. Best-effort:
  // failure here must not block the send or surface to the caller.
  await setContactCustomAttributes(respondioContactId, {
    address_collection_ref: opts.requestRef,
  }).catch(() => {
    /* intentionally swallowed — setContactCustomAttributes never throws in
       production, but the catch guards any unexpected edge case */
  });

  const result = await sendWhatsAppTemplateToContact(respondioContactId, {
    contract: ADDRESS_COLLECTION_TEMPLATE_CONTRACT,
    bodyParameters: [recipientName],
    channelId: respondIoChannelId(),
  });
  if (result.ok) return { ok: true, providerRef: result.providerRef, respondioContactId };
  const confirmedPreSend = new Set([
    "template_contract_invalid",
    "missing_channel",
    "missing_header_image",
    "invalid_header_image",
    "not_configured",
  ]);
  return {
    ...result,
    blockedByConfig: false,
    preSendFailure: confirmedPreSend.has(result.errorCode),
  };
}

function twilioConfig(): { sid: string; token: string; from: string } | null {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_PHONE_NUMBER;
  if (!sid || !token || !from) return null;
  return { sid, token, from };
}

/** The ONLY approved SMS texts — surprise-safe, no sender/gift/price/card. */
export function smsFallbackText(language: string, windowLabel: string, url: string): string {
  if (language === "ar") {
    return `لديك توصيلة خاصة مجدولة (${windowLabel}). يرجى تأكيد عنوان التوصيل هنا: ${url}`;
  }
  return `A special delivery is scheduled for you (${windowLabel}). Please confirm your delivery address here: ${url}`;
}

/** Send the SMS fallback via Twilio (dynamic import, same pattern as fleet). */
export async function sendSmsAddressRequest(opts: {
  phone: string;
  language: string;
  secureUrl: string;
  windowLabel: string;
}): Promise<ProviderSendResult> {
  const cfg = twilioConfig();
  if (!cfg) {
    return {
      ok: false,
      retryable: false,
      blockedByConfig: true,
      errorCode: "twilio_not_configured",
      errorMessage: "TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_PHONE_NUMBER not set",
    };
  }
  try {
    const twilioModule = await import("twilio");
    const client = twilioModule.default(cfg.sid, cfg.token);
    const message = await client.messages.create({
      to: opts.phone,
      from: cfg.from,
      body: smsFallbackText(opts.language, opts.windowLabel, opts.secureUrl),
    });
    return { ok: true, providerRef: message.sid ?? null };
  } catch (err) {
    const anyErr = err as { code?: number | string; status?: number; message?: string };
    const status = Number(anyErr.status ?? 0);
    // Twilio 21610 = recipient has opted out (STOP). Permanent; respect it.
    const code = String(anyErr.code ?? "");
    const optedOut = code === "21610";
    const retryable = !optedOut && (status === 429 || status >= 500 || status === 0);
    logger.warn({ code, status }, "addressCollector: twilio SMS send failed");
    return {
      ok: false,
      retryable,
      errorCode: optedOut ? "sms_opt_out" : code || `http_${status}`,
      errorMessage: (anyErr.message ?? "Twilio send failed").slice(0, 500),
    };
  }
}
