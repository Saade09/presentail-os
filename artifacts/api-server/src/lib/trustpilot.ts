import { logger } from "./logger";

/**
 * Trustpilot Invitations API client.
 *
 * Auth: OAuth2 client-credentials against the Trustpilot business-users token
 * endpoint (Basic auth with API key/secret). The access token is cached in
 * memory and refreshed shortly before expiry.
 *
 * Env configuration:
 * - TRUSTPILOT_ENABLED               master switch ("true" to enable)
 * - TRUSTPILOT_API_KEY               OAuth client id (secret)
 * - TRUSTPILOT_API_SECRET            OAuth client secret (secret)
 * - TRUSTPILOT_BUSINESS_UNIT_ID      business unit the invitations belong to
 * - TRUSTPILOT_BUSINESS_USER_ID      business user sending invitations
 *                                    (x-business-user-id header)
 * - TRUSTPILOT_SERVICE_TEMPLATE_ID   invitation email template id
 * - TRUSTPILOT_INVITATION_DELAY_HOURS  delay between order completion and the
 *                                    preferred send time (default 24)
 * - TRUSTPILOT_TEST_MODE             "true" → log the payload and mark the
 *                                    invitation created without calling
 *                                    Trustpilot (for verification without
 *                                    sending real emails)
 */

const TOKEN_URL =
  "https://api.trustpilot.com/v1/oauth/oauth-business-users-for-applications/accesstoken";

const DEFAULT_DELAY_HOURS = 24;

/**
 * Log at startup which Trustpilot env vars are present (never logs values).
 * Call once from index.ts after the server starts listening.
 */
export function logTrustpilotStartupStatus(): void {
  logger.info(
    {
      TRUSTPILOT_ENABLED: (process.env.TRUSTPILOT_ENABLED ?? "").toLowerCase() === "true",
      TRUSTPILOT_API_KEY_present: !!process.env.TRUSTPILOT_API_KEY,
      TRUSTPILOT_API_SECRET_present: !!process.env.TRUSTPILOT_API_SECRET,
      TRUSTPILOT_BUSINESS_UNIT_ID_present: !!process.env.TRUSTPILOT_BUSINESS_UNIT_ID,
      TRUSTPILOT_BUSINESS_USER_ID_present: !!process.env.TRUSTPILOT_BUSINESS_USER_ID,
      TRUSTPILOT_SERVICE_TEMPLATE_ID_present: !!process.env.TRUSTPILOT_SERVICE_TEMPLATE_ID,
      TRUSTPILOT_INVITATION_DELAY_HOURS: process.env.TRUSTPILOT_INVITATION_DELAY_HOURS ?? "(default 24)",
      TRUSTPILOT_TEST_MODE: (process.env.TRUSTPILOT_TEST_MODE ?? "").toLowerCase() === "true",
      enabled: isTrustpilotEnabled(),
    },
    "trustpilot: startup credential status",
  );
}

/** Master switch: env flag on AND credentials present. */
export function isTrustpilotEnabled(): boolean {
  return (
    (process.env.TRUSTPILOT_ENABLED ?? "").toLowerCase() === "true" &&
    !!process.env.TRUSTPILOT_API_KEY &&
    !!process.env.TRUSTPILOT_API_SECRET &&
    !!process.env.TRUSTPILOT_BUSINESS_UNIT_ID
  );
}

/** Test mode: build + log the payload but never call Trustpilot. */
export function isTrustpilotTestMode(): boolean {
  return (process.env.TRUSTPILOT_TEST_MODE ?? "").toLowerCase() === "true";
}

/** Configured delay (hours) between completion and preferred send time. */
export function trustpilotDelayHours(): number {
  const raw = Number(process.env.TRUSTPILOT_INVITATION_DELAY_HOURS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_DELAY_HOURS;
}

/**
 * Map the order's audience to a Trustpilot invitation locale:
 * - Arabic content → "ar"
 * - English for Cyprus → "en-GB"
 * - English for Lebanon/UAE and anything unknown → "en-US"
 */
export function resolveTrustpilotLocale(
  language: string | null | undefined,
  country: string | null | undefined,
): string {
  const lang = (language ?? "").trim().toLowerCase();
  if (lang.startsWith("ar")) return "ar";
  const c = (country ?? "").trim().toLowerCase();
  if (c === "cyprus" || c === "cy") return "en-GB";
  return "en-US";
}

/**
 * Preferred send time = completion time + configured delay, as an ISO string.
 * Falls back to `now` when the completion timestamp is missing/invalid.
 */
export function computePreferredSendTime(
  completedAt: string | Date | null | undefined,
  now: Date = new Date(),
): string {
  const base =
    completedAt instanceof Date
      ? completedAt
      : completedAt
        ? new Date(completedAt)
        : now;
  const validBase = Number.isNaN(base.getTime()) ? now : base;
  return new Date(validBase.getTime() + trustpilotDelayHours() * 3600_000).toISOString();
}

// ---------------------------------------------------------------------------
// OAuth token cache
// ---------------------------------------------------------------------------

let cachedToken: { token: string; expiresAt: number } | null = null;

/** Test-only: clear the cached OAuth token. */
export function resetTrustpilotTokenCache(): void {
  cachedToken = null;
}

/** Error carrying the HTTP status so callers can classify retryability. */
export class TrustpilotApiError extends Error {
  status: number;
  body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = "TrustpilotApiError";
    this.status = status;
    this.body = body;
  }
}

/** Transient failures (retry): 429 rate limit and any 5xx. */
export function isRetryableTrustpilotError(err: unknown): boolean {
  if (err instanceof TrustpilotApiError) {
    return err.status === 429 || err.status >= 500;
  }
  // Network-level failures (fetch TypeError, timeouts) are retryable.
  return !(err instanceof TrustpilotApiError);
}

/**
 * Get a valid access token, refreshing via the client-credentials grant when
 * the cached one is missing or within 60s of expiry.
 */
export async function getTrustpilotAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }
  const key = process.env.TRUSTPILOT_API_KEY ?? "";
  const secret = process.env.TRUSTPILOT_API_SECRET ?? "";
  const basic = Buffer.from(`${key}:${secret}`).toString("base64");
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new TrustpilotApiError(
      `Trustpilot token request failed (${resp.status})`,
      resp.status,
      text,
    );
  }
  let parsed: { access_token?: string; expires_in?: number | string };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    throw new TrustpilotApiError("Trustpilot token response was not JSON", 502, text);
  }
  if (!parsed.access_token) {
    throw new TrustpilotApiError("Trustpilot token response missing access_token", 502, text);
  }
  const expiresInSec = Number(parsed.expires_in);
  const ttlMs = Number.isFinite(expiresInSec) && expiresInSec > 0 ? expiresInSec * 1000 : 3600_000;
  cachedToken = { token: parsed.access_token, expiresAt: Date.now() + ttlMs };
  return parsed.access_token;
}

// ---------------------------------------------------------------------------
// Invitation call
// ---------------------------------------------------------------------------

export type TrustpilotInvitationInput = {
  email: string;
  name: string | null;
  referenceId: string;
  locale: string;
  preferredSendTime: string;
  tags: string[];
};

export type TrustpilotInvitationResult = {
  invitationId: string | null;
  responsePayload: unknown;
};

/** Build the Invitations API request body (exported for tests/test mode). */
export function buildInvitationPayload(input: TrustpilotInvitationInput): Record<string, unknown> {
  return {
    replyTo: null,
    referenceNumber: input.referenceId,
    consumerName: input.name ?? input.email,
    consumerEmail: input.email,
    locale: input.locale,
    serviceReviewInvitation: {
      templateId: process.env.TRUSTPILOT_SERVICE_TEMPLATE_ID ?? undefined,
      preferredSendTime: input.preferredSendTime,
      tags: input.tags,
    },
  };
}

/**
 * Create a service-review invitation. In test mode the payload is logged and a
 * synthetic success is returned without any network call. Throws
 * TrustpilotApiError on non-2xx responses (status drives retry classification).
 */
export async function createTrustpilotInvitation(
  input: TrustpilotInvitationInput,
): Promise<TrustpilotInvitationResult> {
  const payload = buildInvitationPayload(input);

  if (isTrustpilotTestMode()) {
    // Redacted log — no customer email/name (PII); the full payload is stored
    // on the invitation row's response_payload for inspection.
    logger.info(
      { referenceNumber: input.referenceId, locale: input.locale, tags: input.tags },
      "trustpilot: TEST MODE — invitation not sent",
    );
    return {
      invitationId: null,
      responsePayload: { testMode: true, request: payload },
    };
  }

  const businessUnitId = process.env.TRUSTPILOT_BUSINESS_UNIT_ID ?? "";
  const businessUserId = process.env.TRUSTPILOT_BUSINESS_USER_ID ?? "";

  const send = async (token: string) =>
    fetch(
      `https://invitations-api.trustpilot.com/v1/private/business-units/${encodeURIComponent(businessUnitId)}/email-invitations`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...(businessUserId ? { "x-business-user-id": businessUserId } : {}),
        },
        body: JSON.stringify(payload),
      },
    );

  let resp = await send(await getTrustpilotAccessToken());
  if (resp.status === 401) {
    // Auth error — the cached token may have been revoked early. Invalidate,
    // fetch a fresh token and retry ONCE within this same attempt.
    cachedToken = null;
    logger.warn("trustpilot: 401 from invitation API — refreshing token and retrying once");
    resp = await send(await getTrustpilotAccessToken());
  }
  const text = await resp.text();
  if (!resp.ok) {
    if (resp.status === 401) cachedToken = null;
    throw new TrustpilotApiError(
      `Trustpilot invitation request failed (${resp.status})`,
      resp.status,
      text.slice(0, 2000),
    );
  }
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 2000) };
  }
  const invitationId =
    body && typeof body === "object" && "id" in body && typeof (body as { id: unknown }).id === "string"
      ? (body as { id: string }).id
      : null;
  return { invitationId, responsePayload: body };
}
