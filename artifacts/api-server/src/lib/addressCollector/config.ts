/**
 * Address Collector — configuration.
 *
 * Env vars:
 *   RESPONDIO_API_TOKEN                   — enables WhatsApp outreach (shared with contact sync)
 *   RESPONDIO_CHANNEL_ID                  — respond.io WhatsApp channel ID (optional; unset =
 *                                           last-interacted channel)
 *   RESPONDIO_STATUS_WEBHOOK_SECRET       — shared secret for the delivery-status callback
 *   RESPONDIO_OUTBOUND_WEBHOOK_SECRET     — HMAC secret for manual template-send events
 *   RESPONDIO_INCOMING_WEBHOOK_SECRET     — Respond.io Developer Webhook signing key
 *   TWILIO_ACCOUNT_SID/AUTH_TOKEN/PHONE_NUMBER — SMS fallback (same creds as fleet notifications)
 *   ADDRESS_COLLECTOR_QUIET_HOURS         — "21-9" (local delivery-timezone quiet window)
 *   ADDRESS_COLLECTOR_WA_TIMEOUT_MINUTES  — treat WhatsApp as undelivered after N minutes with
 *                                           no delivered/opened signal (0/unset = disabled)
 *   APP_PUBLIC_URL                        — explicit public base URL for /address/:token links
 */
import { parseQuietHoursEnv, type QuietHours } from "./schedule";
import { isIP } from "node:net";
import type { RespondIoTemplateContract } from "../respondio";

export const DEFAULT_ADDRESS_TEMPLATE_NAME = "address_collection";
export const ADDRESS_COLLECTION_TEMPLATE_CONTRACT = {
  templateName: DEFAULT_ADDRESS_TEMPLATE_NAME,
  languageCode: "en",
  bodyParameterCount: 1,
  includeBodyComponent: true,
  requiresImageHeader: false,
  requiresChannelId: true,
  providerComponentOrder: ["body"],
  staticBodyText:
    "Hi {{1}}! Natasha here from Presentail support.\nSomeone sent you a gift! 💐\n\nPlease share your location so the driver delivers the order as soon as possible. 📍",
} as const satisfies RespondIoTemplateContract;

/** Approved WhatsApp template name for the address-request message. */
export function addressTemplateName(): string {
  // Address Collector is governed by one approved provider contract. Do not
  // allow a generic template override to silently change its variables.
  return DEFAULT_ADDRESS_TEMPLATE_NAME;
}

/** respond.io channel ID to send on; null = last-interacted channel. */
export function respondIoChannelId(): number | null {
  return 543704;
}

export function quietHours(): QuietHours {
  return parseQuietHoursEnv(process.env.ADDRESS_COLLECTOR_QUIET_HOURS);
}

export function waUndeliveredTimeoutMinutes(): number {
  const n = Number(process.env.ADDRESS_COLLECTOR_WA_TIMEOUT_MINUTES ?? "0");
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Public base URL for recipient links. Mirrors the payment-link builder:
 * explicit APP_PUBLIC_URL first, then the custom production domain, then the
 * dev domain. Never uses localhost.
 */
export function publicBaseUrl(): string {
  const explicit = process.env.APP_PUBLIC_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const domains = (process.env.REPLIT_DOMAINS ?? "")
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
  const custom = domains.find((d) => !d.endsWith(".replit.app") && !d.endsWith(".replit.dev"));
  const prod = custom ?? domains[0];
  if (process.env.NODE_ENV === "production" && prod) return `https://${prod}`;
  const dev = process.env.REPLIT_DEV_DOMAIN?.trim();
  if (dev) return `https://${dev}`;
  if (prod) return `https://${prod}`;
  return process.env.PUBLIC_URL?.trim()?.replace(/\/+$/, "") ?? "";
}

export function buildAddressUrl(token: string): string {
  return `${publicBaseUrl()}/address/${token}`;
}

/**
 * Address links are fetched by WhatsApp/Meta without a browser session. Only
 * absolute HTTPS URLs on public hosts are sendable; localhost and private
 * network addresses are configuration mistakes, not valid fallbacks.
 */
export function isPublicHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return false;
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    // A branded public HTTPS domain is required. Avoid treating a literal IP
    // address (including IPv6 and IPv4-mapped IPv6) as a public recipient URL.
    if (isIP(hostname) !== 0) return false;
    if (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      hostname === "0.0.0.0" ||
      hostname === "::1" ||
      hostname.startsWith("fc") ||
      hostname.startsWith("fd") ||
      hostname.startsWith("fe80:")
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}
