/**
 * respond.io client — contact find-or-create, profile links, and WhatsApp
 * template sends for the Presentail OS workspace.
 *
 * API notes (verified against https://developers.respond.io, API v2):
 *  - Base URL: https://api.respond.io/v2
 *  - Auth: Bearer token (workspace API token from Settings → Integrations →
 *    Developer API) via the RESPONDIO_API_TOKEN secret.
 *  - Contacts are addressed by identifier: `id:{contactId}` | `phone:+E164`.
 *  - POST /contact/create_or_update/{identifier} finds-or-creates in one call.
 *  - POST /contact/{identifier}/message sends a message; WhatsApp outreach
 *    outside the 24h window must use an approved template
 *    (message.type = "whatsapp_template").
 */
import { logger } from "./logger";
import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";
const RESPONDIO_BASE_URL = "https://api.respond.io/v2";
const RESPONDIO_SEND_TIMEOUT_MS = 15_000;

export function isRespondIoEnabled(): boolean {
  return !!process.env.RESPONDIO_API_TOKEN;
}
function authHeaders(): Record<string, string> | null {
  const token = process.env.RESPONDIO_API_TOKEN;
  if (!token) return null;
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}
/**
 * Normalize a phone string toward E.164:
 * - Strips all non-digit characters, preserving a single leading `+` if present.
 * - Any `+` in non-leading positions is removed.
 * Result is `+<digits>` when the input had a leading `+`, otherwise `<digits>`.
 * Callers are responsible for validating the result with isStrictE164 before use.
 */
export function normalizePhone(phone: string): string {
  const hasLeadingPlus = phone.trimStart().startsWith("+");
  const digits = phone.replace(/\D/g, "");
  return hasLeadingPlus ? `+${digits}` : digits;
}

/**
 * Normalize a recipient phone using the delivery country when the submitted
 * value is local (for example, 03 159 639 in Lebanon). International values
 * are parsed independently of the hint so a country hint can never rewrite a
 * valid E.164 number.
 */
export function normalizePhoneForCountry(
  phone: string,
  countryCode?: string | null,
): string | null {
  const raw = phone.trim();
  if (!raw) return null;
  const country = countryCode?.trim().toUpperCase();
  const parsed = parsePhoneNumberFromString(
    raw,
    country && /^[A-Z]{2}$/.test(country) ? (country as CountryCode) : undefined,
  );
  if (!parsed || !parsed.isValid()) return null;
  const value = parsed.number;
  return isStrictE164(value) ? value : null;
}

/**
 * Returns true when `phone` is strictly E.164:
 *   +<country-code (1 digit, non-zero)><subscriber (1–14 digits)>
 *   Total length: 2–16 characters.
 */
export function isStrictE164(phone: string): boolean {
  return /^\+[1-9]\d{1,14}$/.test(phone);
}

/**
 * Build the respond.io contact profile URL for the "Open in respond.io" link.
 * respond.io deep links require the numeric space (workspace) ID, which is
 * not derivable from the API token — configure RESPONDIO_SPACE_ID (visible in
 * the app URL after login: app.respond.io/space/{spaceId}/...).
 * Returns null when the space ID is not configured so callers hide the link.
 */
export function getRespondIoContactUrl(contactId: string): string | null {
  const spaceId = process.env.RESPONDIO_SPACE_ID?.trim();
  if (!spaceId) return null;
  return `https://app.respond.io/space/${spaceId}/inbox/${encodeURIComponent(contactId)}`;
}

type RespondIoContactBody = {
  id?: number | string;
  // create_or_update responds with { contactId: <number> } (observed live).
  contactId?: number | string;
  data?: { id?: number | string; contactId?: number | string; [key: string]: unknown };
  [key: string]: unknown;
};

function extractContactId(body: RespondIoContactBody | null | undefined): string | null {
  const raw = body?.id ?? body?.contactId ?? body?.data?.id ?? body?.data?.contactId;
  return raw == null ? null : String(raw);
}

/** GET /contact/{identifier} — used when create_or_update omits the contact body. */
async function getContactIdByIdentifier(
  identifier: string,
  headers: Record<string, string>,
): Promise<string | null> {
  try {
    const res = await fetch(
      `${RESPONDIO_BASE_URL}/contact/${encodeURIComponent(identifier)}`,
      { headers },
    );
    if (!res.ok) {
      logger.warn({ status: res.status, identifier }, "respondio getContact failed");
      return null;
    }
    const body = (await res.json().catch(() => null)) as RespondIoContactBody | null;
    return extractContactId(body);
  } catch (err) {
    logger.warn({ err, identifier }, "respondio getContact error");
    return null;
  }
}

/**
 * Find-or-create a respond.io contact by phone via
 * POST /contact/create_or_update/phone:+E164.
 *
 * Returns:
 *  - the respond.io contact ID string on success,
 *  - "phone_format_invalid" when the phone is not strict E.164 (no network call),
 *  - null on any API/network failure (caller may retry later).
 */
export async function findOrCreateContactByPhone(
  phone: string,
  firstName?: string | null,
  lastName?: string | null,
): Promise<string | "phone_format_invalid" | null> {
  const headers = authHeaders();
  if (!headers) return null;

  const normalizedPhone = normalizePhone(phone);
  // Reject before any network call when the number is not strict E.164.
  if (!isStrictE164(normalizedPhone)) {
    logger.warn({ phone, normalizedPhone }, "respondio: phone is not strict E.164, skipping sync");
    return "phone_format_invalid";
  }

  const identifier = `phone:${normalizedPhone}`;
  try {
    const res = await fetch(
      `${RESPONDIO_BASE_URL}/contact/create_or_update/${encodeURIComponent(identifier)}`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          ...(firstName ? { firstName } : {}),
          ...(lastName ? { lastName } : {}),
          phone: normalizedPhone,
        }),
      },
    );

    if (res.status === 401) {
      logger.error(
        { phone: normalizedPhone },
        "respondio create_or_update: 401 Unauthorized — check RESPONDIO_API_TOKEN",
      );
      return null;
    }

    const body = (await res.json().catch(() => null)) as RespondIoContactBody | null;

    if (res.ok) {
      const id = extractContactId(body);
      if (id) return id;
      // Some responses omit the contact payload — resolve the ID with a follow-up GET.
      return await getContactIdByIdentifier(identifier, headers);
    }

    logger.warn({ status: res.status }, "respondio create_or_update failed");
    return null;
  } catch (err) {
    logger.warn({ err, phone: normalizedPhone }, "respondio create_or_update error");
    return null;
  }
}

/**
 * Merge custom attributes onto an existing respond.io contact (best-effort).
 *
 * Uses POST /contact/create_or_update/id:{contactId} with a `customAttributes`
 * payload. Failures are logged as warnings but never thrown — callers must not
 * let this block their primary path.
 */
export async function setContactCustomAttributes(
  contactId: string,
  customAttributes: Record<string, string | number | boolean | null>,
): Promise<boolean> {
  const headers = authHeaders();
  if (!headers) return false;

  try {
    const identifier = `id:${contactId}`;
    const res = await fetch(
      `${RESPONDIO_BASE_URL}/contact/create_or_update/${encodeURIComponent(identifier)}`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ customAttributes }),
      },
    );

    if (!res.ok) {
      logger.warn(
        { status: res.status, contactId },
        "respondio setContactCustomAttributes failed",
      );
      return false;
    }
    return true;
  } catch (err) {
    logger.warn({ err, contactId }, "respondio setContactCustomAttributes error");
    return false;
  }
}
/**
 * Update the name of an existing respond.io contact.
 *
 * This deliberately uses the provider ID rather than looking up by phone so a
 * first-order repair also works when the contact was linked before the order
 * was created. The local contact ID is never cleared when this best-effort
 * provider call fails.
 */
export async function updateContactName(
  contactId: string,
  firstName: string | null,
  lastName: string | null,
): Promise<boolean> {
  const headers = authHeaders();
  if (!headers) return false;
  if (!firstName && !lastName) return false;

  try {
    const identifier = `id:${contactId}`;
    const res = await fetch(
      `${RESPONDIO_BASE_URL}/contact/create_or_update/${encodeURIComponent(identifier)}`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          ...(firstName ? { firstName } : {}),
          ...(lastName ? { lastName } : {}),
        }),
      },
    );

    if (!res.ok) {
      logger.warn(
        { status: res.status, contactId },
        "respondio contact name update failed",
      );
      return false;
    }
    return true;
  } catch (err) {
    logger.warn({ err, contactId }, "respondio contact name update error");
    return false;
  }
}
export type RespondIoSendResult =
  | { ok: true; providerRef: string | null }
  | { ok: false; retryable: boolean; errorCode: string; errorMessage: string };

/**
 * Exact transport shape for a provider-approved WhatsApp template. Order and
 * payment sends supply one of these contracts; generic integrations may omit
 * it while retaining the lower-level transport API.
 */
export type RespondIoTemplateContract = {
  templateName: string;
  languageCode: string;
  bodyParameterCount: number;
  includeBodyComponent: boolean;
  requiresImageHeader: boolean;
  requiresChannelId: boolean;
  /** Expected provider component types in their approved order. */
  providerComponentOrder: readonly string[];
  /** Exact approved text copied from Respond.io Template Manager. */
  staticBodyText?: string;
  staticFooterText?: string;
  staticButtons?: readonly { type: string; text: string; url?: string }[];
};

export type RespondIoTemplateSendOptions = {
  /**
   * Required for contract-driven sends. Generic integrations that do not yet
   * have a local contract may continue to provide templateName/languageCode.
   */
  contract?: RespondIoTemplateContract;
  templateName?: string;
  /** ISO 639-1 language code of the approved template, e.g. "en" | "ar". */
  languageCode?: string;
  /** Positional body parameters ({{1}}, {{2}}, …) of the template. */
  bodyParameters: string[];
  /**
   * Include a body component even when there are no replacement parameters.
   * Useful for approved templates whose body is static but still required.
   */
  includeBodyComponent?: boolean;
  /** respond.io channel ID; omitted = last-interacted channel. */
  channelId?: number | null;
  /**
   * Publicly reachable image URL for the template's header IMAGE component.
   * When provided, a header component is prepended to the components array.
   * Must be omitted (or undefined) for templates that have no header.
   */
  headerImageUrl?: string | null;
};

type RespondIoTemplateComponent =
  | {
      type: "header";
      format: "image";
      parameters: Array<{
        type: "image";
        image: { link: string };
      }>;
    }
  | {
      type: "body";
      text: string;
      parameters: Array<{ type: "text"; text: string }>;
    }
  | {
      type: "footer";
      text: string;
    }
  | {
      type: "buttons";
      buttons: Array<{ type: string; text: string; url?: string }>;
    };

/**
 * Pure provider-payload builder shared by production transport and live
 * template-parity tests. Validation remains in sendWhatsAppTemplateToContact.
 */
export function buildRespondIoWhatsAppTemplatePayload(
  opts: RespondIoTemplateSendOptions,
): {
  channelId?: number;
  message: {
    type: "whatsapp_template";
    template: {
      name: string;
      languageCode: string;
      components: RespondIoTemplateComponent[];
    };
  };
} {
  const contract = opts.contract;
  const templateName = contract?.templateName ?? opts.templateName?.trim() ?? "";
  const languageCode = contract?.languageCode ?? opts.languageCode?.trim() ?? "";
  const includeBodyComponent =
    contract?.includeBodyComponent ?? opts.includeBodyComponent ?? false;
  const components: RespondIoTemplateComponent[] = [];

  if (opts.headerImageUrl) {
    components.push({
      type: "header",
      format: "image",
      parameters: [{ type: "image", image: { link: opts.headerImageUrl } }],
    });
  }
  if (includeBodyComponent || opts.bodyParameters.length > 0) {
    components.push({
      type: "body",
      text: contract?.staticBodyText ?? "",
      parameters: opts.bodyParameters.map((text) => ({ type: "text", text })),
    });
  }
  if (contract?.staticFooterText) {
    components.push({
      type: "footer",
      text: contract.staticFooterText,
    });
  }
  if (contract?.staticButtons?.length) {
    components.push({
      type: "buttons",
      buttons: contract.staticButtons.map((button) => ({ ...button })),
    });
  }

  return {
    ...(opts.channelId != null ? { channelId: opts.channelId } : {}),
    message: {
      type: "whatsapp_template",
      template: {
        name: templateName,
        languageCode,
        components,
      },
    },
  };
}

function safeProviderFailureMessage(status: number): string {
  return `Respond.io rejected the template (HTTP ${status})`;
}

function invalidTemplateContract(
  templateName: string | undefined,
  errorCode: string,
  errorMessage: string,
): RespondIoSendResult {
  logger.warn({ templateName, errorCode }, "respondio template contract rejected before send");
  return { ok: false, retryable: false, errorCode, errorMessage };
}

function isPublicHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Send an approved WhatsApp template message to a respond.io contact via
 * POST /contact/id:{contactId}/message with message.type = "whatsapp_template".
 *
 * IMPORTANT: a 200 response only means respond.io ACCEPTED the message for
 * sending — never that WhatsApp delivered it. Callers must record this as
 * provider_status='accepted' and rely on the status webhook or the configured
 * undelivered timeout for authoritative delivery signals.
 *
 * Error classification: HTTP 429/449 and 5xx (and network errors) are
 * retryable; other 4xx responses are permanent failures.
 */
export async function sendWhatsAppTemplateToContact(
  contactId: string,
  opts: RespondIoTemplateSendOptions,
): Promise<RespondIoSendResult> {
  const contract = opts.contract;
  const templateName = contract?.templateName ?? opts.templateName?.trim();
  const languageCode = contract?.languageCode ?? opts.languageCode?.trim();

  if (!templateName || !languageCode) {
    return invalidTemplateContract(
      templateName,
      "template_contract_invalid",
      "Template name and approved language are required",
    );
  }
  if (
    contract &&
    (opts.bodyParameters.length !== contract.bodyParameterCount ||
      opts.bodyParameters.some((value) => !value?.trim()))
  ) {
    return invalidTemplateContract(
      templateName,
      "template_contract_invalid",
      `Template requires exactly ${contract.bodyParameterCount} non-empty body parameters`,
    );
  }
  if (contract?.includeBodyComponent && !contract.staticBodyText) {
    return invalidTemplateContract(
      templateName,
      "template_contract_invalid",
      "Template contract is missing its approved body text",
    );
  }
  if (contract?.requiresChannelId && opts.channelId == null) {
    return invalidTemplateContract(
      templateName,
      "missing_channel",
      "A configured Respond.io WhatsApp channel is required for this template",
    );
  }
  if (contract?.requiresImageHeader && !opts.headerImageUrl) {
    return invalidTemplateContract(
      templateName,
      "missing_header_image",
      "A public HTTPS header image is required for this template",
    );
  }
  if (opts.headerImageUrl && !isPublicHttpsUrl(opts.headerImageUrl)) {
    return invalidTemplateContract(
      templateName,
      "invalid_header_image",
      "Template header image must be a public HTTPS URL",
    );
  }

  const headers = authHeaders();
  if (!headers) {
    return {
      ok: false,
      retryable: false,
      errorCode: "not_configured",
      errorMessage: "RESPONDIO_API_TOKEN missing",
    };
  }

  try {
    const res = await fetch(
      `${RESPONDIO_BASE_URL}/contact/${encodeURIComponent(`id:${contactId}`)}/message`,
      {
        method: "POST",
        headers,
        // Ready-photo sends may hold a short DB row lease so a concurrent
        // replacement cannot invalidate approved media during dispatch.
        // Never let an upstream hang pin that lease or exhaust the pool.
        signal: AbortSignal.timeout(RESPONDIO_SEND_TIMEOUT_MS),
        body: JSON.stringify(buildRespondIoWhatsAppTemplatePayload(opts)),
      },
    );

    const text = await res.text().catch(() => "");
    let body: { messageId?: number | string; message?: string } = {};
    try {
      body = JSON.parse(text) as { messageId?: number | string; message?: string };
    } catch {
      /* non-JSON body */
    }

    if (res.ok) {
      return { ok: true, providerRef: body.messageId != null ? String(body.messageId) : null };
    }

    const retryable = res.status === 429 || res.status === 449 || res.status >= 500;
    const genericMessage = safeProviderFailureMessage(res.status);
    const providerMessage = body.message ?? null;
    logger.warn(
      {
        status: res.status,
        message: genericMessage,
        providerMessage,
        contactId,
        templateName,
      },
      "respondio sendWhatsAppTemplate failed",
    );
    const errorMessage = providerMessage ? `${genericMessage}: ${providerMessage}` : genericMessage;
    return {
      ok: false,
      retryable,
      errorCode: `http_${res.status}`,
      errorMessage,
    };
  } catch (err) {
    logger.warn({ contactId }, "respondio sendWhatsAppTemplate network error");
    return {
      ok: false,
      retryable: true,
      errorCode: "network_error",
      errorMessage: "Network error while sending the WhatsApp template",
    };
  }
}
