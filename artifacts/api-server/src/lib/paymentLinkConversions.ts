import { db } from "./db";
import { logger } from "./logger";
import {
  decryptCredentials,
} from "./adPlatformSync";
import { COUNTRY_CATALOGUE } from "./defaults";

type ClickIdType = "gclid" | "gbraid" | "wbraid";

type MarketConfig = {
  customerId: string;
  conversionActionId: string;
};
// Deliberately separate legacy conversion-upload credentials from analytics.
type LegacyConversionCredentials = {
  developerToken: string; clientId: string; clientSecret: string;
  refreshToken: string; customerId: string; loginCustomerId?: string | null;
};

type ConversionJob = {
  id: number;
  workspace_owner_id: string;
  transaction_id: string;
  destination_country: string;
  click_id_type: ClickIdType;
  click_id: string;
  conversion_value: string;
  currency: string;
  conversion_time: string;
};

export type ConversionFailureCode =
  | "destination_not_configured"
  | "google_ads_not_connected"
  | "google_ads_authentication"
  | "google_ads_rejected"
  | "retry_exhausted"
  | "unexpected";

const CONVERSION_FAILURE_CODES = new Set<ConversionFailureCode>([
  "destination_not_configured",
  "google_ads_not_connected",
  "google_ads_authentication",
  "google_ads_rejected",
  "retry_exhausted",
  "unexpected",
]);

export function normalizeConversionFailureCode(
  value: string | null | undefined,
  lastError?: string | null,
): ConversionFailureCode {
  if (value && CONVERSION_FAILURE_CODES.has(value as ConversionFailureCode)) {
    return value as ConversionFailureCode;
  }
  // Older failed rows predate failure_reason. Classify their internal error
  // without returning that error to the dashboard.
  if (lastError && /market configured for destination/i.test(lastError)) {
    return "destination_not_configured";
  }
  if (lastError && /connection not found/i.test(lastError)) {
    return "google_ads_not_connected";
  }
  return "unexpected";
}

export function safeConversionFailureReason(code: ConversionFailureCode): string {
  switch (code) {
    case "destination_not_configured":
      return "No Google Ads conversion market is configured for this destination.";
    case "google_ads_not_connected":
      return "Google Ads is not connected for this workspace.";
    case "google_ads_authentication":
      return "Google Ads rejected the connection. Reconnect Google Ads and try again.";
    case "google_ads_rejected":
      return "Google Ads rejected this conversion. Check the destination conversion action and try again.";
    case "retry_exhausted":
      return "Google Ads did not accept this conversion after automatic retries. Check the connection and try again.";
    default:
      return "The conversion could not be reported to Google Ads. Check the connection and try again.";
  }
}

const API_VERSION = "v21";
const POLL_MS = 30_000;
let timer: ReturnType<typeof setInterval> | null = null;

class ConversionUploadError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly failureCode: ConversionFailureCode = "google_ads_rejected",
  ) {
    super(message);
  }
}

export function parseGoogleAdsConversionMarkets(
  raw = process.env.GOOGLE_ADS_CONVERSION_MARKETS,
): Record<string, MarketConfig> {
  if (!raw?.trim()) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const result: Record<string, MarketConfig> = {};
    for (const [rawCountry, rawConfig] of Object.entries(value)) {
      const country = rawCountry.trim().toUpperCase();
      if (!/^[A-Z]{2}$/.test(country) || !rawConfig || typeof rawConfig !== "object") continue;
      const { customerId, conversionActionId } = rawConfig as Partial<MarketConfig>;
      if (
        typeof customerId !== "string" ||
        !/^\d[\d-]+$/.test(customerId.trim()) ||
        typeof conversionActionId !== "string" ||
        !/^\d+$/.test(conversionActionId.trim())
      ) continue;
      result[country] = {
        customerId: customerId.replace(/-/g, ""),
        conversionActionId: conversionActionId.trim(),
      };
    }
    return result;
  } catch {
    return {};
  }
}

export function normalizeDestinationCountry(country: string): string | null {
  const trimmed = country.trim();
  if (/^[A-Za-z]{2}$/.test(trimmed)) return trimmed.toUpperCase();
  const match = COUNTRY_CATALOGUE.find(
    (entry) => entry.name.toLowerCase() === trimmed.toLowerCase(),
  );
  return match?.code.toUpperCase() ?? null;
}

function formatGoogleDateTime(value: string): string {
  return `${new Date(value).toISOString().slice(0, 19).replace("T", " ")}+00:00`;
}

async function accessToken(creds: LegacyConversionCredentials): Promise<string> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: creds.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const body = await response.json() as { access_token?: string; error_description?: string };
  if (!response.ok || !body.access_token) {
    throw new ConversionUploadError(
      body.error_description || `Google OAuth failed (${response.status})`,
      response.status === 408 || response.status === 429 || response.status >= 500,
      "google_ads_authentication",
    );
  }
  return body.access_token;
}

export async function uploadPaymentLinkConversion(
  job: ConversionJob,
  market: MarketConfig,
  creds: LegacyConversionCredentials,
): Promise<void> {
  const token = await accessToken(creds);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "developer-token": creds.developerToken,
    "Content-Type": "application/json",
  };
  if (creds.loginCustomerId) headers["login-customer-id"] = creds.loginCustomerId.replace(/-/g, "");
  const conversion = {
    conversionAction: `customers/${market.customerId}/conversionActions/${market.conversionActionId}`,
    conversionDateTime: formatGoogleDateTime(job.conversion_time),
    conversionValue: Number(job.conversion_value),
    currencyCode: job.currency,
    orderId: job.transaction_id,
    [job.click_id_type]: job.click_id,
  };
  const response = await fetch(
    `https://googleads.googleapis.com/${API_VERSION}/customers/${market.customerId}/conversionUploads:uploadClickConversions`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ conversions: [conversion], partialFailure: true }),
    },
  );
  const body = await response.json() as {
    partialFailureError?: { code?: number; message?: string; status?: string };
    error?: { message?: string };
  };
  if (!response.ok || body.partialFailureError) {
    const partialCode = body.partialFailureError?.code;
    const partialStatus = body.partialFailureError?.status;
    const retryablePartialFailure =
      partialCode === 4 ||
      partialCode === 8 ||
      partialCode === 13 ||
      partialCode === 14 ||
      partialStatus === "DEADLINE_EXCEEDED" ||
      partialStatus === "RESOURCE_EXHAUSTED" ||
      partialStatus === "INTERNAL" ||
      partialStatus === "UNAVAILABLE";
    throw new ConversionUploadError(
      body.partialFailureError?.message ||
      body.error?.message ||
      `Google Ads conversion upload failed (${response.status})`,
      retryablePartialFailure ||
        (!body.partialFailureError &&
          (response.status === 408 || response.status === 429 || response.status >= 500)),
      response.status === 401 || response.status === 403
        ? "google_ads_authentication"
        : "google_ads_rejected",
    );
  }
}

export async function processPaymentLinkConversions(): Promise<void> {
  const jobs = await db.query<ConversionJob>(
    `UPDATE payment_link_conversions plc
        SET status = 'processing', attempt_count = attempt_count + 1, updated_at = now()
       FROM payment_links pl
      WHERE plc.payment_link_id = pl.id
         AND NOT EXISTS (
           SELECT 1
             FROM ad_platform_connections apc
            WHERE apc.workspace_owner_id = pl.workspace_owner_id
              AND apc.platform = 'google_ads'
              AND apc.auth_mode = 'service_account'
         )
        AND (
          (plc.status IN ('pending', 'retry') AND plc.next_attempt_at <= now())
          OR (plc.status = 'processing' AND plc.updated_at < now() - interval '10 minutes')
        )
      RETURNING plc.id, pl.workspace_owner_id, plc.transaction_id,
                plc.destination_country, plc.click_id_type, plc.click_id,
                plc.conversion_value, plc.currency, plc.conversion_time`,
  );
  const markets = parseGoogleAdsConversionMarkets();
  for (const job of jobs.rows) {
    try {
      const countryCode = normalizeDestinationCountry(job.destination_country);
      const market = countryCode ? markets[countryCode] : undefined;
      if (!market) {
        throw new ConversionUploadError(
          "No Google Ads conversion market configured for destination",
          false,
          "destination_not_configured",
        );
      }
      const connection = await db.query<{ credentials_encrypted: string }>(
        `SELECT credentials_encrypted
           FROM ad_platform_connections
          WHERE workspace_owner_id = $1
            AND platform = 'google_ads'
            AND auth_mode IS DISTINCT FROM 'service_account'
          LIMIT 1`,
        [job.workspace_owner_id],
      );
      if (!connection.rows[0]) {
        throw new ConversionUploadError(
          "Workspace Google Ads connection not found",
          false,
          "google_ads_not_connected",
        );
      }
      let creds: LegacyConversionCredentials;
      try {
        creds = decryptCredentials<LegacyConversionCredentials>(connection.rows[0].credentials_encrypted);
      } catch {
        throw new ConversionUploadError(
          "Stored Google Ads connection credentials could not be decrypted",
          false,
          "google_ads_authentication",
        );
      }
      await uploadPaymentLinkConversion(job, market, creds);
      await db.query(
        `UPDATE payment_link_conversions
            SET status = 'uploaded', uploaded_at = now(), last_error = NULL,
                failure_reason = NULL, updated_at = now()
          WHERE id = $1`,
        [job.id],
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const retryable = err instanceof ConversionUploadError ? err.retryable : true;
      const failureCode = err instanceof ConversionUploadError ? err.failureCode : "unexpected";
      await db.query(
        `UPDATE payment_link_conversions
            SET status = CASE WHEN NOT $3 OR attempt_count >= 10 THEN 'failed' ELSE 'retry' END,
                next_attempt_at = now() + (LEAST(3600, 30 * power(2, LEAST(attempt_count, 7))) || ' seconds')::interval,
                last_error = $2,
                failure_reason = CASE
                  WHEN NOT $3 THEN $4
                  WHEN attempt_count >= 10 THEN 'retry_exhausted'
                  ELSE NULL
                END,
                updated_at = now()
          WHERE id = $1`,
        [job.id, message.slice(0, 1000), retryable, failureCode],
      );
      logger.warn({ err, conversionJobId: job.id }, "Payment-link Google Ads conversion upload failed");
    }
  }
}

export function startPaymentLinkConversionJob(): void {
  if (timer || process.env.NODE_ENV === "test") return;
  void processPaymentLinkConversions();
  timer = setInterval(() => void processPaymentLinkConversions(), POLL_MS);
  timer.unref?.();
}