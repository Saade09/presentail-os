import { db } from "./db";
import { logger } from "./logger";
import { encrypt, decrypt } from "./credentialEncryption";
import { GoogleAuth } from "google-auth-library";

/**
 * Ad platform auto-sync — pulls daily, per-campaign spend from the Google Ads
 * API and the Meta (Facebook/Instagram) Marketing API into `ad_spend_entries`.
 *
 * Precedence rule: API-sourced rows upsert ONLY API-sourced rows. A row whose
 * `source` differs from the incoming row's source (e.g. a manual entry at the
 * same channel/campaign/period slot) is never overwritten — the ON CONFLICT
 * UPDATE carries a `WHERE ad_spend_entries.source = EXCLUDED.source` guard.
 */

export type AdPlatform = "google_ads" | "meta_ads";

export const AD_PLATFORMS: AdPlatform[] = ["google_ads", "meta_ads"];

/** `ad_spend_entries.source` value per platform (distinguishes API rows from manual). */
export const PLATFORM_SOURCE: Record<AdPlatform, string> = {
  google_ads: "google_ads_api",
  meta_ads: "meta_api",
};

/** `ad_spend_entries.channel` value per platform (normalises via spendChannelCase). */
export const PLATFORM_CHANNEL: Record<AdPlatform, string> = {
  google_ads: "google_ads",
  meta_ads: "meta_ads",
};

/** Stable, safe error classification for server-owned Google Ads analytics. */
export type GoogleAdsAnalyticsErrorCode =
  | "missing_config" | "malformed_json" | "malformed_private_key"
  | "token_generation_failed" | "api_disabled" | "project_access_unapproved"
  | "invalid_customer_id" | "access_denied" | "invalid_login_customer_id"
  | "reporting_query_failed";
export class GoogleAdsAnalyticsError extends Error {
  constructor(readonly code: GoogleAdsAnalyticsErrorCode) {
    super(`Google Ads analytics error: ${code}`);
    this.name = "GoogleAdsAnalyticsError";
  }
}

export interface GoogleAdsAnalyticsConfig {
  customerId: string;
  loginCustomerId?: string | null;
  serviceAccountJson: string;
}

const GOOGLE_ADS_API_VERSION = "v25";
const GOOGLE_ADS_WORKSPACE_ENV = "GOOGLE_ADS_WORKSPACE_OWNER_ID";

export const GOOGLE_ADS_CONFIG_VARS = [
  "GOOGLE_ADS_SERVICE_ACCOUNT_JSON", "GOOGLE_ADS_CUSTOMER_ID",
  "GOOGLE_ADS_LOGIN_CUSTOMER_ID", "GOOGLE_ADS_WORKSPACE_OWNER_ID",
] as const;

export function normalizeCustomerId(id: string, code: "invalid_customer_id" | "invalid_login_customer_id" = "invalid_customer_id"): string {
  const normalized = id.replace(/-/g, "").trim();
  if (!/^\d{6,20}$/.test(normalized)) throw new GoogleAdsAnalyticsError(code);
  return normalized;
}

export function serviceAccountConfig(): GoogleAdsAnalyticsConfig {
  const json = process.env.GOOGLE_ADS_SERVICE_ACCOUNT_JSON?.trim();
  const customerId = process.env.GOOGLE_ADS_CUSTOMER_ID?.trim();
  if (!json || !customerId) throw new GoogleAdsAnalyticsError("missing_config");
  const login = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID?.trim() || null;
  normalizeCustomerId(customerId);
  if (login) normalizeCustomerId(login, "invalid_login_customer_id");
  return {
    serviceAccountJson: json,
    customerId,
    loginCustomerId: login,
  };
}

export function isGoogleAdsWorkspaceAllowed(ownerId: string): boolean {
  const intended = process.env[GOOGLE_ADS_WORKSPACE_ENV]?.trim();
  return !!intended && intended === ownerId;
}

let cachedAuth: GoogleAuth | null = null;
let cachedClient: ReturnType<GoogleAuth["getClient"]> | null = null;
let cachedServiceAccountJson: string | null = null;
/** Test-only cache reset; production callers should let google-auth-library renew tokens. */
export function resetGoogleAdsAuthCacheForTests(): void {
  cachedAuth = null;
  cachedClient = null;
  cachedServiceAccountJson = null;
}
async function getServiceAccountAccessToken(config: GoogleAdsAnalyticsConfig) {
  let credentials: { type?: string; client_email?: string; private_key?: string };
  try {
    credentials = JSON.parse(config.serviceAccountJson) as typeof credentials;
  } catch {
    throw new GoogleAdsAnalyticsError("malformed_json");
  }
  if (credentials.type !== "service_account" || !credentials.client_email || !credentials.private_key)
    throw new GoogleAdsAnalyticsError("malformed_json");
  if (!credentials.private_key.includes("BEGIN PRIVATE KEY") ||
      !credentials.private_key.includes("END PRIVATE KEY"))
    throw new GoogleAdsAnalyticsError("malformed_private_key");
  let token;
  try {
    // Rebuild immediately when the secret rotates; otherwise let the maintained
    // auth client cache and renew its own short-lived tokens.
    if (!cachedAuth || cachedServiceAccountJson !== config.serviceAccountJson) {
      cachedAuth = new GoogleAuth({ credentials, scopes: ["https://www.googleapis.com/auth/adwords"] });
      cachedClient = cachedAuth.getClient();
      cachedServiceAccountJson = config.serviceAccountJson;
    }
    const client = await cachedClient!;
    token = await client.getAccessToken();
  } catch {
    throw new GoogleAdsAnalyticsError("token_generation_failed");
  }
  if (!token.token) throw new GoogleAdsAnalyticsError("token_generation_failed");
  return token.token;
}

async function serviceAccountSearch(query: string, config = serviceAccountConfig()) {
  const token = await getServiceAccountAccessToken(config);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  if (config.loginCustomerId) headers["login-customer-id"] = normalizeCustomerId(config.loginCustomerId, "invalid_login_customer_id");
  const results: unknown[] = [];
  let pageToken: string | undefined;
  do {
    let response: Response;
    try {
      response = await fetch(
        `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers/${normalizeCustomerId(config.customerId)}/googleAds:search`,
        { method: "POST", headers, body: JSON.stringify({ query, pageToken }) },
      );
    } catch {
      throw new GoogleAdsAnalyticsError("reporting_query_failed");
    }
    if (!response.ok) {
      if (response.status === 401) throw new GoogleAdsAnalyticsError("access_denied");
      if (response.status === 403) {
        const detail = (await response.text()).toLowerCase();
        if (detail.includes("service_disabled") || detail.includes("api not enabled"))
          throw new GoogleAdsAnalyticsError("api_disabled");
        if (detail.includes("unapproved") || detail.includes("project"))
          throw new GoogleAdsAnalyticsError("project_access_unapproved");
        throw new GoogleAdsAnalyticsError("access_denied");
      }
      throw new GoogleAdsAnalyticsError("reporting_query_failed");
    }
    const body = (await response.json()) as { results?: unknown[]; nextPageToken?: string };
    results.push(...(body.results ?? []));
    pageToken = body.nextPageToken;
  } while (pageToken);
  return results;
}

export async function validateGoogleAdsAnalytics(): Promise<{
  currency: string;
  timeZone: string;
  accountLabel: string;
}> {
  const config = serviceAccountConfig();
  const rows = (await serviceAccountSearch(
    "SELECT customer.currency_code, customer.time_zone, customer.descriptive_name FROM customer LIMIT 1",
    config,
  )) as Array<{ customer?: { currencyCode?: string; timeZone?: string; descriptiveName?: string } }>;
  const customer = rows[0]?.customer;
  if (!customer?.currencyCode || !customer.timeZone) {
    throw new GoogleAdsAnalyticsError("reporting_query_failed");
  }
  return {
    currency: customer.currencyCode,
    timeZone: customer.timeZone,
    accountLabel: customer.descriptiveName
      ? `${customer.descriptiveName} (${normalizeCustomerId(config.customerId)})`
      : normalizeCustomerId(config.customerId),
  };
}

export async function fetchGoogleAdsAnalyticsSpend(from: string, to: string): Promise<SpendRow[]> {
  const config = serviceAccountConfig();
  const metadata = await validateGoogleAdsAnalytics();
  const rows: SpendRow[] = [];
  let cursor = from;
  while (cursor <= to) {
    const end = addDays(cursor, 364) < to ? addDays(cursor, 364) : to;
    const query = `SELECT customer.id, campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.ctr, metrics.average_cpc, metrics.conversions, metrics.conversions_value FROM campaign WHERE segments.date BETWEEN '${cursor}' AND '${end}'`;
    const raw = await serviceAccountSearch(query, config);
    for (const row of raw) {
      const mapped = mapGoogleAdsRow(row as Parameters<typeof mapGoogleAdsRow>[0], metadata.currency);
      if (mapped) rows.push(mapped);
    }
    cursor = addDays(end, 1);
  }
  return rows;
}

export interface MetaAdsCredentials {
  accessToken: string;
  adAccountId: string;
}

export type PlatformCredentials = MetaAdsCredentials;
type StoredAnalyticsMarker = { type: "google_ads_analytics_service_account" };

/** A normalised daily, per-campaign spend row ready for upsert. */
export interface SpendRow {
  channel: string;
  campaign: string;
  campaignExternalId: string;
  /** YYYY-MM-DD (both period_start and period_end — daily granularity). */
  date: string;
  spendAmount: number;
  currency: string;
  impressions: number | null;
  clicks: number | null;
  conversions: number | null;
  source: string;
}

// ── Credential storage ───────────────────────────────────────────────────────

export function encryptCredentials(creds: PlatformCredentials | StoredAnalyticsMarker): string {
  return encrypt(JSON.stringify(creds));
}

export function decryptCredentials<T>(encrypted: string): T {
  return JSON.parse(decrypt(encrypted)) as T;
}

// ── Row mapping (pure; unit-tested) ─────────────────────────────────────────

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Map one Google Ads report row (googleAds:search result) to a SpendRow.
 * Returns null for rows with no activity (0 spend, 0 impressions, 0 clicks)
 * or rows missing required fields.
 */
export function mapGoogleAdsRow(
  row: {
    campaign?: { id?: string | number; name?: string };
    metrics?: {
      costMicros?: string | number;
      impressions?: string | number;
      clicks?: string | number;
      conversions?: string | number;
    };
    segments?: { date?: string };
  },
  currency: string,
): SpendRow | null {
  const date = row.segments?.date;
  const campaignId = row.campaign?.id;
  if (!date || campaignId == null) return null;
  const spend = round2(Number(row.metrics?.costMicros ?? 0) / 1_000_000);
  const impressions = Number(row.metrics?.impressions ?? 0);
  const clicks = Number(row.metrics?.clicks ?? 0);
  const conversions = Math.round(Number(row.metrics?.conversions ?? 0));
  if (spend === 0 && impressions === 0 && clicks === 0) return null;
  return {
    channel: PLATFORM_CHANNEL.google_ads,
    campaign: row.campaign?.name?.trim() || `Campaign ${campaignId}`,
    campaignExternalId: String(campaignId),
    date,
    spendAmount: spend,
    currency,
    impressions,
    clicks,
    conversions,
    source: PLATFORM_SOURCE.google_ads,
  };
}

/** Action types counted as a purchase conversion, in preference order. */
const META_PURCHASE_ACTIONS = [
  "omni_purchase",
  "purchase",
  "offsite_conversion.fb_pixel_purchase",
  "onsite_web_purchase",
];

/**
 * Map one Meta Insights row (level=campaign, time_increment=1) to a SpendRow.
 * Returns null for rows with no activity or missing required fields.
 */
export function mapMetaInsightsRow(
  row: {
    campaign_id?: string;
    campaign_name?: string;
    spend?: string;
    impressions?: string;
    clicks?: string;
    actions?: Array<{ action_type?: string; value?: string }>;
    date_start?: string;
  },
  currency: string,
): SpendRow | null {
  const date = row.date_start;
  const campaignId = row.campaign_id;
  if (!date || !campaignId) return null;
  const spend = round2(Number(row.spend ?? 0));
  const impressions = Number(row.impressions ?? 0);
  const clicks = Number(row.clicks ?? 0);
  if (spend === 0 && impressions === 0 && clicks === 0) return null;

  let conversions: number | null = null;
  if (Array.isArray(row.actions)) {
    // Prefer the first purchase-type action with a non-zero value; fall back
    // to a zero-valued one so "0 purchases" is still recorded as tracked.
    for (const type of META_PURCHASE_ACTIONS) {
      const hit = row.actions.find((a) => a.action_type === type);
      if (hit) {
        const value = Math.round(Number(hit.value ?? 0));
        if (conversions === null) conversions = value;
        if (value > 0) {
          conversions = value;
          break;
        }
      }
    }
  }

  return {
    channel: PLATFORM_CHANNEL.meta_ads,
    campaign: row.campaign_name?.trim() || `Campaign ${campaignId}`,
    campaignExternalId: campaignId,
    date,
    spendAmount: spend,
    currency,
    impressions,
    clicks,
    conversions,
    source: PLATFORM_SOURCE.meta_ads,
  };
}

// ── Upsert (precedence-aware) ────────────────────────────────────────────────

/**
 * Upsert API-sourced spend rows. Rows conflict on the natural key
 * (workspace, channel, campaign, period_start, period_end); the UPDATE is
 * guarded so a manual (or differently-sourced) row at the same slot is left
 * untouched. Returns the count of rows written (inserted or updated).
 */
export async function upsertSpendRows(
  ownerId: string,
  rows: SpendRow[],
): Promise<number> {
  if (rows.length === 0) return 0;
  let written = 0;
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    for (const r of rows) {
      const result = await client.query(
        `WITH updated AS (
           UPDATE ad_spend_entries
              SET campaign = $3,
                  campaign_external_id = $4,
                  spend_amount = $6,
                  currency = $7,
                  impressions = $8,
                  clicks = $9,
                  conversions = $10,
                  updated_at = now()
            WHERE workspace_owner_id = $1
              AND channel = $2
              AND source = $11
              AND period_start = $5
              AND period_end = $5
              AND (
                campaign_external_id = $4
                OR (campaign_external_id IS NULL AND campaign = $3)
              )
            RETURNING id
         ),
         inserted AS (
           INSERT INTO ad_spend_entries
           (workspace_owner_id, channel, campaign, campaign_external_id,
            period_start, period_end, spend_amount, currency,
            impressions, clicks, conversions, source)
           SELECT $1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$10,$11
            WHERE NOT EXISTS (SELECT 1 FROM updated)
           ON CONFLICT DO NOTHING
           RETURNING id
         )
         SELECT id FROM updated
         UNION ALL
         SELECT id FROM inserted`,
        [
          ownerId,
          r.channel,
          r.campaign,
          r.campaignExternalId,
          r.date,
          r.spendAmount,
          r.currency,
          r.impressions,
          r.clicks,
          r.conversions,
          r.source,
        ],
      );
      written += result.rowCount ?? 0;
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return written;
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

class AdPlatformApiError extends Error {}

async function fetchJson(
  url: string,
  init: RequestInit,
  label: string,
): Promise<unknown> {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok) {
    const detail =
      (body as { error?: { message?: string } } | null)?.error?.message ??
      text.slice(0, 300);
    throw new AdPlatformApiError(`${label} request failed (${res.status}): ${detail}`);
  }
  return body;
}

/** Earliest date attempted when backfilling all Google Ads history. */
const GOOGLE_BACKFILL_START = "2016-01-01";

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(dateIso: string, days: number): string {
  const d = new Date(`${dateIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

/** Fetch daily campaign spend rows from Google Ads for [from, to] inclusive. */
// ── Meta (Facebook/Instagram) client ─────────────────────────────────────────

const META_API_VERSION = "v21.0";

function normalizeAdAccountId(id: string): string {
  const trimmed = id.trim();
  return trimmed.startsWith("act_") ? trimmed : `act_${trimmed}`;
}

/** Validate Meta credentials and return account currency + creation time. */
export async function validateMetaAds(
  creds: MetaAdsCredentials,
): Promise<{ currency: string; accountLabel: string; createdTime: string | null }> {
  const acct = normalizeAdAccountId(creds.adAccountId);
  const json = (await fetchJson(
    `https://graph.facebook.com/${META_API_VERSION}/${acct}?fields=currency,name,created_time`,
    { method: "GET", headers: { Authorization: `Bearer ${creds.accessToken}` } },
    "Meta ad account",
  )) as { currency?: string; name?: string; created_time?: string };
  if (!json.currency) {
    throw new AdPlatformApiError("Could not read the Meta ad account currency");
  }
  return {
    currency: json.currency,
    accountLabel: json.name ? `${json.name} (${acct})` : acct,
    createdTime: json.created_time ?? null,
  };
}

/** Fetch daily campaign insight rows from Meta for [from, to] inclusive. */
export async function fetchMetaAdsSpend(
  creds: MetaAdsCredentials,
  from: string,
  to: string,
): Promise<SpendRow[]> {
  const acct = normalizeAdAccountId(creds.adAccountId);
  const { currency } = await validateMetaAds(creds);
  const rows: SpendRow[] = [];
  // Chunk into ~90-day windows (time_increment=1 over long ranges is rejected).
  let cursor = from;
  while (cursor <= to) {
    const chunkEnd = addDays(cursor, 89) < to ? addDays(cursor, 89) : to;
    const timeRange = encodeURIComponent(
      JSON.stringify({ since: cursor, until: chunkEnd }),
    );
    let url: string | null =
      `https://graph.facebook.com/${META_API_VERSION}/${acct}/insights` +
      `?level=campaign&time_increment=1&limit=500` +
      `&fields=campaign_id,campaign_name,spend,impressions,clicks,actions` +
      `&time_range=${timeRange}`;
    while (url) {
      const json = (await fetchJson(
        url,
        { method: "GET", headers: { Authorization: `Bearer ${creds.accessToken}` } },
        "Meta insights",
      )) as {
        data?: unknown[];
        paging?: { next?: string };
      };
      for (const raw of json.data ?? []) {
        const mapped = mapMetaInsightsRow(
          raw as Parameters<typeof mapMetaInsightsRow>[0],
          currency,
        );
        if (mapped) rows.push(mapped);
      }
      url = json.paging?.next ?? null;
    }
    cursor = addDays(chunkEnd, 1);
  }
  return rows;
}

// ── Sync orchestration ───────────────────────────────────────────────────────

/** Days re-fetched on scheduled/manual refreshes to capture restatements. */
export const RECENT_SYNC_WINDOW_DAYS = 30;

/** Meta insights retention: ~37 months. Clamp backfills to that. */
const META_MAX_BACKFILL_DAYS = 37 * 30;

export interface ConnectionRow {
  id: number;
  workspace_owner_id: string;
  platform: AdPlatform;
  credentials_encrypted: string;
  account_created_time: string | null;
}

/**
 * Run one sync for a connection. `mode: "full"` backfills all available
 * history; `"recent"` re-fetches the last RECENT_SYNC_WINDOW_DAYS days.
 * Updates the connection row's sync state; rethrows nothing — errors are
 * recorded on the connection (`last_error`) so the UI can surface them.
 */
export async function runAdPlatformSync(
  conn: ConnectionRow,
  mode: "full" | "recent",
): Promise<{ ok: boolean; written?: number; error?: string }> {
  if (conn.platform === "google_ads" && !isGoogleAdsWorkspaceAllowed(conn.workspace_owner_id)) {
    return { ok: false, error: "Google Ads analytics is not enabled for this workspace." };
  }
  const today = isoDate(new Date());
  let from: string;
  if (mode === "recent") {
    from = addDays(today, -RECENT_SYNC_WINDOW_DAYS);
  } else if (conn.platform === "meta_ads") {
    const earliest = addDays(today, -META_MAX_BACKFILL_DAYS);
    const created = conn.account_created_time?.slice(0, 10);
    from = created && created > earliest ? created : earliest;
  } else {
    from = GOOGLE_BACKFILL_START;
  }

  await db.query(
    `UPDATE ad_platform_connections
        SET sync_status = 'syncing', updated_at = now()
      WHERE id = $1`,
    [conn.id],
  );

  try {
    let rows: SpendRow[];
    if (conn.platform === "google_ads") {
      rows = await fetchGoogleAdsAnalyticsSpend(from, today);
    } else {
      const creds = decryptCredentials<MetaAdsCredentials>(
        conn.credentials_encrypted,
      );
      rows = await fetchMetaAdsSpend(creds, from, today);
    }
    const written = await upsertSpendRows(conn.workspace_owner_id, rows);
    await db.query(
      `UPDATE ad_platform_connections
          SET sync_status = 'idle', last_sync_at = now(), last_error = NULL,
              last_full_sync_at = CASE WHEN $2 THEN now() ELSE last_full_sync_at END,
              updated_at = now()
        WHERE id = $1`,
      [conn.id, mode === "full"],
    );
    logger.info(
      { connectionId: conn.id, platform: conn.platform, mode, fetched: rows.length, written },
      "ad platform sync completed",
    );
    return { ok: true, written };
  } catch (err) {
    const googleError = conn.platform === "google_ads" && err instanceof GoogleAdsAnalyticsError;
    const message = googleError ? err.message : (err instanceof Error ? err.message : String(err));
    await db
      .query(
        `UPDATE ad_platform_connections
            SET sync_status = 'error', last_error = $2, updated_at = now()
          WHERE id = $1`,
        [conn.id, message.slice(0, 1000)],
      )
      .catch(() => {});
    logger.warn(
      { ...(googleError ? { code: (err as GoogleAdsAnalyticsError).code } : { err }), connectionId: conn.id, platform: conn.platform, mode },
      "ad platform sync failed",
    );
    return { ok: false, error: message };
  }
}
