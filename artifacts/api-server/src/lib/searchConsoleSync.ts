import { db } from "./db";
import { logger } from "./logger";
import { encrypt, decrypt } from "./credentialEncryption";

/**
 * Google Search Console sync — fetches daily search-analytics rows
 * (per date × landing page × query) via the Search Analytics API and
 * upserts them into `seo_metrics` with source = 'search_console'.
 *
 * Precedence rule: only rows whose source matches 'search_console' are
 * updated on conflict — manual entries are never overwritten.
 */

export const GSC_SOURCE = "search_console";

/** Days re-fetched on scheduled/manual refreshes. */
export const GSC_RECENT_SYNC_DAYS = 30;

/** Days backfilled on initial connect. */
export const GSC_INITIAL_SYNC_DAYS = 90;

// ── Credential helpers ────────────────────────────────────────────────────

export interface GscCredentials {
  refreshToken: string;
  accessToken: string | null;
  expiresAt: number | null;
}

export function encryptGscCredentials(creds: GscCredentials): string {
  return encrypt(JSON.stringify(creds));
}

export function decryptGscCredentials(encrypted: string): GscCredentials {
  return JSON.parse(decrypt(encrypted)) as GscCredentials;
}

// ── OAuth client credential helpers (workspace-supplied Client ID+Secret) ─

export interface GscOauthClient {
  clientId: string;
  clientSecret: string;
}

interface GscOauthConfigRow {
  oauth_client_encrypted: string;
}

type GscOauthConfigQuery = Pick<typeof db, "query">;

export function encryptGscOauthClient(client: GscOauthClient): string {
  return encrypt(JSON.stringify(client));
}

export function decryptGscOauthClient(encrypted: string): GscOauthClient {
  return JSON.parse(decrypt(encrypted)) as GscOauthClient;
}

/**
 * Returns the effective OAuth client for a workspace. A workspace override is
 * deliberately preferred to server credentials so an owner can recover from a
 * deleted Google OAuth client without waiting for a server-side secret change.
 */
export async function resolveGscOauthClient(
  ownerId: string,
  query: GscOauthConfigQuery = db,
): Promise<GscOauthClient | null> {
  const config = await query.query<GscOauthConfigRow>(
    `SELECT oauth_client_encrypted
       FROM search_console_oauth_config
      WHERE workspace_owner_id = $1`,
    [ownerId],
  );

  if (config.rows[0]) {
    const client = decryptGscOauthClient(config.rows[0].oauth_client_encrypted);
    if (!client.clientId.trim() || !client.clientSecret.trim()) {
      throw new Error("Saved Search Console credentials are incomplete.");
    }
    return client;
  }

  const clientId = process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET;
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/** Returns a browser-safe partial Client ID. OAuth secrets are never masked or returned. */
export function maskGscClientId(clientId: string): string {
  return clientId.length > 8
    ? `${clientId.slice(0, 6)}…${clientId.slice(-4)}`
    : "••••";
}

// ── OAuth token exchange ──────────────────────────────────────────────────

class GscApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
  }
}

/**
 * Resolve the OAuth Client ID. Uses the DB-supplied override when provided,
 * falling back to the environment variable.
 */
function clientId(override?: string): string {
  const v = override ?? process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_ID;
  if (!v) throw new GscApiError("Missing GOOGLE_SEARCH_CONSOLE_CLIENT_ID env var");
  return v;
}

/**
 * Resolve the OAuth Client Secret. Uses the DB-supplied override when provided,
 * falling back to the environment variable.
 */
function clientSecret(override?: string): string {
  const v = override ?? process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET;
  if (!v) throw new GscApiError("Missing GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET env var");
  return v;
}

async function fetchJson(url: string, init: RequestInit, label: string): Promise<unknown> {
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
      (body as { error_description?: string } | null)?.error_description ??
      text.slice(0, 300);
    throw new GscApiError(`${label} failed (${res.status}): ${detail}`, res.status);
  }
  return body;
}

/** Exchange an authorization code for access + refresh tokens. */
export async function exchangeCode(
  code: string,
  redirectUri: string,
  clientOverride?: GscOauthClient,
): Promise<GscCredentials> {
  const body = new URLSearchParams({
    code,
    client_id: clientId(clientOverride?.clientId),
    client_secret: clientSecret(clientOverride?.clientSecret),
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  const json = (await fetchJson(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
    "Google OAuth token exchange",
  )) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!json.access_token || !json.refresh_token) {
    throw new GscApiError("Token response missing access_token or refresh_token");
  }
  const expiresAt = Date.now() + (json.expires_in ?? 3600) * 1000 - 60_000;
  return {
    refreshToken: json.refresh_token,
    accessToken: json.access_token,
    expiresAt,
  };
}

/** Return a fresh access token, refreshing via the stored refresh token if needed. */
export async function getAccessToken(
  creds: GscCredentials,
  clientOverride?: GscOauthClient,
): Promise<string> {
  if (creds.accessToken && creds.expiresAt && Date.now() < creds.expiresAt) {
    return creds.accessToken;
  }
  const body = new URLSearchParams({
    client_id: clientId(clientOverride?.clientId),
    client_secret: clientSecret(clientOverride?.clientSecret),
    refresh_token: creds.refreshToken,
    grant_type: "refresh_token",
  });
  const json = (await fetchJson(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
    "Google OAuth token refresh",
  )) as { access_token?: string; expires_in?: number };
  if (!json.access_token) {
    throw new GscApiError("Token refresh response missing access_token");
  }
  creds.accessToken = json.access_token;
  creds.expiresAt = Date.now() + (json.expires_in ?? 3600) * 1000 - 60_000;
  return json.access_token;
}

// ── GSC Sites API ─────────────────────────────────────────────────────────

/** List all verified Search Console properties for the authenticated user. */
export async function listGscSites(
  accessToken: string,
): Promise<string[]> {
  const json = (await fetchJson(
    "https://www.googleapis.com/webmasters/v3/sites",
    {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    },
    "GSC sites list",
  )) as {
    siteEntry?: Array<{ siteUrl?: string; permissionLevel?: string }>;
  };
  return (json.siteEntry ?? [])
    .filter(
      (s) =>
        s.siteUrl &&
        (s.permissionLevel === "siteOwner" || s.permissionLevel === "siteFullUser" || s.permissionLevel === "siteRestrictedUser"),
    )
    .map((s) => s.siteUrl as string);
}

// ── Search Analytics fetch ────────────────────────────────────────────────

export interface GscRow {
  date: string;
  landingPage: string | null;
  query: string | null;
  impressions: number;
  clicks: number;
  ctr: number;
  avgPosition: number;
}

const GSC_SEARCH_ANALYTICS_BASE =
  "https://www.googleapis.com/webmasters/v3/sites";

/**
 * Fetch Search Analytics rows for [fromDate, toDate] inclusive.
 * Dimensions: date × page × query (row limit 25 000 per request with pagination).
 */
export async function fetchSearchConsoleRows(
  creds: GscCredentials,
  siteUrl: string,
  fromDate: string,
  toDate: string,
  oauthClient?: GscOauthClient,
): Promise<GscRow[]> {
  const accessToken = await getAccessToken(creds, oauthClient);
  const encodedSite = encodeURIComponent(siteUrl);
  const url = `${GSC_SEARCH_ANALYTICS_BASE}/${encodedSite}/searchAnalytics/query`;

  const rows: GscRow[] = [];
  let startRow = 0;
  const rowLimit = 25_000;

  while (true) {
    const body = {
      startDate: fromDate,
      endDate: toDate,
      dimensions: ["date", "page", "query"],
      rowLimit,
      startRow,
    };

    const json = (await fetchJson(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
      "GSC searchAnalytics",
    )) as {
      rows?: Array<{
        keys?: string[];
        impressions?: number;
        clicks?: number;
        ctr?: number;
        position?: number;
      }>;
    };

    const batch = json.rows ?? [];
    for (const r of batch) {
      const [date, page, query] = r.keys ?? [];
      if (!date) continue;
      rows.push({
        date,
        landingPage: page ?? null,
        query: query ?? null,
        impressions: r.impressions ?? 0,
        clicks: r.clicks ?? 0,
        ctr: r.ctr ?? 0,
        avgPosition: r.position ?? 0,
      });
    }

    if (batch.length < rowLimit) break;
    startRow += rowLimit;
  }

  return rows;
}

// ── Upsert into seo_metrics ───────────────────────────────────────────────

/**
 * Upsert GSC-sourced rows into seo_metrics. Uses source guard so manual
 * entries at the same slot are never overwritten.
 */
export async function upsertGscRows(
  ownerId: string,
  rows: GscRow[],
): Promise<number> {
  if (rows.length === 0) return 0;
  let written = 0;
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    for (const r of rows) {
      const result = await client.query(
        `INSERT INTO seo_metrics
           (workspace_owner_id, period_start, period_end, landing_page, query,
            impressions, clicks, ctr, avg_position, source)
         VALUES ($1,$2,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (workspace_owner_id, period_start, period_end, landing_page, query)
         DO UPDATE SET
           impressions  = EXCLUDED.impressions,
           clicks       = EXCLUDED.clicks,
           ctr          = EXCLUDED.ctr,
           avg_position = EXCLUDED.avg_position,
           source       = EXCLUDED.source,
           updated_at   = now()
         WHERE seo_metrics.source = EXCLUDED.source
         RETURNING id`,
        [
          ownerId,
          r.date,
          r.landingPage,
          r.query,
          r.impressions,
          r.clicks,
          r.ctr,
          r.avgPosition,
          GSC_SOURCE,
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

// ── Sync orchestration ────────────────────────────────────────────────────

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(dateIso: string, days: number): string {
  const d = new Date(`${dateIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

export interface GscConnectionRow {
  id: number;
  workspace_owner_id: string;
  site_url: string;
  credentials_encrypted: string;
}

/**
 * Run one sync for a GSC connection. Marks sync_status accordingly.
 * Never rethrows — errors are recorded on the connection row.
 */
export async function runSearchConsoleSync(
  conn: GscConnectionRow,
  mode: "full" | "recent",
): Promise<{ ok: boolean; written?: number; error?: string }> {
  await db.query(
    `UPDATE search_console_connections
        SET sync_status = 'syncing', last_error = NULL, updated_at = now()
      WHERE id = $1`,
    [conn.id],
  );

  const today = isoDate(new Date());
  const days = mode === "full" ? GSC_INITIAL_SYNC_DAYS : GSC_RECENT_SYNC_DAYS;
  const fromDate = addDays(today, -days);

  try {
    const creds = decryptGscCredentials(conn.credentials_encrypted);
    const oauthClient = await resolveGscOauthClient(conn.workspace_owner_id);
    if (!oauthClient) {
      throw new GscApiError("Google Search Console OAuth is not configured.");
    }
    const rows = await fetchSearchConsoleRows(
      creds,
      conn.site_url,
      fromDate,
      today,
      oauthClient,
    );
    const written = await upsertGscRows(conn.workspace_owner_id, rows);

    // Persist potentially-refreshed access token
    const updatedEncrypted = encryptGscCredentials(creds);
    await db.query(
      `UPDATE search_console_connections
          SET credentials_encrypted = $1,
              sync_status = 'idle',
              last_sync_at = now(),
              last_error = NULL,
              updated_at = now()
        WHERE id = $2`,
      [updatedEncrypted, conn.id],
    );

    logger.info(
      { ownerId: conn.workspace_owner_id, mode, written },
      "GSC sync completed",
    );
    return { ok: true, written };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      { err, ownerId: conn.workspace_owner_id, connId: conn.id },
      "GSC sync failed",
    );
    await db
      .query(
        `UPDATE search_console_connections
            SET sync_status = 'error',
                last_error = $1,
                updated_at = now()
          WHERE id = $2`,
        [message.slice(0, 500), conn.id],
      )
      .catch(() => {});
    return { ok: false, error: message };
  }
}
