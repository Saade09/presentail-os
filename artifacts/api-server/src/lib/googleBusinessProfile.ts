import { db } from "./db";
import { logger } from "./logger";
import { encrypt, decrypt } from "./credentialEncryption";
import { ingestReview, markReviewDeleted } from "./reviewAttribution";

/**
 * Google Business Profile (GBP) review ingestion.
 *
 * OAuth (business.manage scope) + Business Profile APIs:
 *  - Account Management API  (mybusinessaccountmanagement.googleapis.com/v1)
 *  - Business Information API (mybusinessbusinessinformation.googleapis.com/v1)
 *  - Notifications API       (mybusinessnotifications.googleapis.com/v1)
 *  - Reviews (legacy v4)      (mybusiness.googleapis.com/v4) — reviews never
 *    moved to a v1 surface; v4 remains the documented reviews endpoint.
 *
 * Reviews arrive via Cloud Pub/Sub push notifications (NEW_REVIEW /
 * UPDATED_REVIEW) and via a periodic reconciliation sweep that also detects
 * deletions during the reward pending window.
 */

export const GBP_SCOPE = "https://www.googleapis.com/auth/business.manage";

// ── Credentials ───────────────────────────────────────────────────────────

export interface GbpCredentials {
  refreshToken: string;
  accessToken: string | null;
  expiresAt: number | null;
  /**
   * The dedicated GBP OAuth client that issued this refresh token.
   * Kept inside the encrypted credential bundle so later workspace/env
   * configuration changes cannot silently break token refresh.
   */
  oauthClient?: GbpOauthClient;
}

/** Workspace-supplied OAuth application credentials for Google Business Profile. */
export interface GbpOauthClient {
  clientId: string;
  clientSecret: string;
}

interface GbpOauthConfigRow {
  oauth_client_encrypted: string;
}

type GbpOauthConfigQuery = Pick<typeof db, "query">;

export function encryptGbpCredentials(creds: GbpCredentials): string {
  return encrypt(JSON.stringify(creds));
}

export function decryptGbpCredentials(encrypted: string): GbpCredentials {
  return JSON.parse(decrypt(encrypted)) as GbpCredentials;
}

export function encryptGbpOauthClient(client: GbpOauthClient): string {
  return encrypt(JSON.stringify(client));
}

export function decryptGbpOauthClient(encrypted: string): GbpOauthClient {
  return JSON.parse(decrypt(encrypted)) as GbpOauthClient;
}

/**
 * The dedicated server GBP client is authoritative when both Replit secrets
 * are configured. A workspace client is only used when the shared GBP client
 * is absent. The generic GOOGLE_* credentials are intentionally never used:
 * those belong to other Google integrations, including Business Posts.
 */
export async function resolveGbpOauthClient(
  ownerId: string,
  query: GbpOauthConfigQuery = db,
): Promise<GbpOauthClient | null> {
  const envClientId = process.env.GBP_OAUTH_CLIENT_ID?.trim();
  const envClientSecret = process.env.GBP_OAUTH_CLIENT_SECRET?.trim();
  const environmentClient =
    envClientId && envClientSecret
      ? { clientId: envClientId, clientSecret: envClientSecret }
      : null;
  if (environmentClient) return environmentClient;

  const config = await query.query<GbpOauthConfigRow>(
    `SELECT oauth_client_encrypted
       FROM gbp_oauth_config
      WHERE workspace_owner_id = $1`,
    [ownerId],
  );
  if (config.rows[0]) {
    const client = decryptGbpOauthClient(config.rows[0].oauth_client_encrypted);
    if (!client.clientId.trim() || !client.clientSecret.trim()) {
      throw new Error("Saved Google Business Profile credentials are incomplete.");
    }
    return client;
  }

  return null;
}

/** Browser-safe display value. OAuth secrets are never returned to clients. */
export function maskGbpClientId(clientId: string): string {
  return clientId.length > 8
    ? `${clientId.slice(0, 6)}…${clientId.slice(-4)}`
    : "••••";
}

export class GbpApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly code?: string,
  ) {
    super(message);
  }
}

function clientId(override?: string): string {
  const v = override?.trim() || process.env.GBP_OAUTH_CLIENT_ID?.trim();
  if (!v) throw new GbpApiError("Missing GBP_OAUTH_CLIENT_ID env var");
  return v;
}

function clientSecret(override?: string): string {
  const v = override?.trim() || process.env.GBP_OAUTH_CLIENT_SECRET?.trim();
  if (!v) throw new GbpApiError("Missing GBP_OAUTH_CLIENT_SECRET env var");
  return v;
}

/**
 * Startup check: warn (names only, never values) about any missing Google
 * OAuth env vars so a misconfigured Reviews integration is visible in logs
 * without preventing the rest of the app from booting.
 */
export function logGbpOauthStartupStatus(): void {
  const missing: string[] = [];
  if (!process.env.GBP_OAUTH_CLIENT_ID?.trim()) {
    missing.push("GBP_OAUTH_CLIENT_ID");
  }
  if (!process.env.GBP_OAUTH_CLIENT_SECRET?.trim()) {
    missing.push("GBP_OAUTH_CLIENT_SECRET");
  }
  if (!(process.env.GOOGLE_REDIRECT_URI ?? process.env.GBP_OAUTH_REDIRECT_URI)) {
    missing.push("GOOGLE_REDIRECT_URI");
  }
  if (missing.length > 0) {
    logger.warn(
      { missing },
      `gbp: Google Reviews OAuth is not fully configured — missing env var(s): ${missing.join(", ")}`,
    );
  }
}

export function gbpOauthConfigured(): boolean {
  return Boolean(
    process.env.GBP_OAUTH_CLIENT_ID?.trim() &&
      process.env.GBP_OAUTH_CLIENT_SECRET?.trim(),
  );
}

async function fetchJson(url: string, init: RequestInit, label: string): Promise<unknown> {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    const oauthCode =
      typeof (body as { error?: unknown } | null)?.error === "string"
        ? (body as { error: string }).error
        : undefined;
    const detail =
      (body as { error?: { message?: string } } | null)?.error?.message ??
      (body as { error_description?: string } | null)?.error_description ??
      text.slice(0, 300);
    const description =
      oauthCode && !detail.includes(oauthCode)
        ? `${oauthCode}: ${detail}`
        : detail;
    throw new GbpApiError(
      `${label} failed (${res.status}): ${description}`,
      res.status,
      oauthCode,
    );
  }
  return body;
}

// ── OAuth token exchange / refresh ────────────────────────────────────────

export async function exchangeGbpCode(
  code: string,
  redirectUri: string,
  clientOverride?: GbpOauthClient,
): Promise<GbpCredentials> {
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
    "GBP OAuth token exchange",
  )) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!json.access_token || !json.refresh_token) {
    throw new GbpApiError("Token response missing access_token or refresh_token");
  }
  return {
    refreshToken: json.refresh_token,
    accessToken: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 - 60_000,
    oauthClient: clientOverride
      ? {
          clientId: clientOverride.clientId,
          clientSecret: clientOverride.clientSecret,
        }
      : undefined,
  };
}

/** Return a fresh access token, refreshing via the refresh token if needed. */
export async function getGbpAccessToken(
  creds: GbpCredentials,
  clientOverride?: GbpOauthClient,
): Promise<string> {
  if (
    creds.oauthClient &&
    clientOverride &&
    creds.oauthClient.clientId !== clientOverride.clientId
  ) {
    throw new GbpApiError(
      "The stored Google Business Profile refresh token belongs to a different OAuth client. Reconnect Google Business Profile.",
      401,
      "oauth_client_mismatch",
    );
  }
  if (creds.accessToken && creds.expiresAt && Date.now() < creds.expiresAt) {
    return creds.accessToken;
  }

  const configuredClient = clientOverride
    ? {
        clientId: clientOverride.clientId,
        clientSecret: clientOverride.clientSecret,
      }
    : null;
  const candidates = (
    creds.oauthClient
      ? [
          creds.oauthClient,
          // A secret can be rotated without changing the OAuth client ID.
          // Trying the currently configured secret for that same client is
          // safe; trying a different client ID is not.
          ...(configuredClient &&
          configuredClient.clientId === creds.oauthClient.clientId
            ? [configuredClient]
            : []),
        ]
      : configuredClient
        ? [configuredClient]
        : []
  ).filter(
    (candidate, index, all) =>
      all.findIndex(
        (other) =>
          other.clientId === candidate.clientId &&
          other.clientSecret === candidate.clientSecret,
      ) === index,
  );
  if (candidates.length === 0) {
    candidates.push({
      clientId: clientId(),
      clientSecret: clientSecret(),
    });
  }

  let lastError: unknown;
  for (const [index, candidate] of candidates.entries()) {
    const body = new URLSearchParams({
      client_id: candidate.clientId,
      client_secret: candidate.clientSecret,
      refresh_token: creds.refreshToken,
      grant_type: "refresh_token",
    });
    try {
      const json = (await fetchJson(
        "https://oauth2.googleapis.com/token",
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: body.toString(),
        },
        "GBP OAuth token refresh",
      )) as { access_token?: string; expires_in?: number };
      if (!json.access_token) {
        throw new GbpApiError("Token refresh response missing access_token");
      }
      creds.accessToken = json.access_token;
      creds.expiresAt = Date.now() + (json.expires_in ?? 3600) * 1000 - 60_000;
      creds.oauthClient = {
        clientId: candidate.clientId,
        clientSecret: candidate.clientSecret,
      };
      if (index > 0) {
        logger.warn(
          { attemptedDedicatedGbpClients: index + 1 },
          "gbp: recovered legacy refresh token with alternate dedicated GBP OAuth client",
        );
      }
      return json.access_token;
    } catch (err) {
      lastError = err;
      const credentialRejected =
        err instanceof GbpApiError &&
        (err.status === 401 ||
          err.code === "invalid_client" ||
          err.code === "invalid_grant" ||
          err.code === "unauthorized_client");
      const canTryAnother =
        index < candidates.length - 1 &&
        credentialRejected;
      if (!canTryAnother) break;
    }
  }
  logger.error({ err: lastError }, "gbp: OAuth token refresh failed");
  if (
    lastError instanceof GbpApiError &&
    (lastError.status === 401 ||
      lastError.code === "invalid_client" ||
      lastError.code === "invalid_grant" ||
      lastError.code === "unauthorized_client")
  ) {
    throw new GbpApiError(
      "The stored Google Business Profile refresh token cannot be reused with its issuing OAuth client. Reconnect Google Business Profile.",
      401,
      lastError.code,
    );
  }
  throw lastError;
}

// ── Accounts & locations ──────────────────────────────────────────────────

export interface GbpAccount {
  /** Resource name, e.g. "accounts/1234567890" */
  name: string;
  accountName: string | null;
  type: string | null;
}

export async function listGbpAccounts(
  accessToken: string,
  maxPages = 10,
): Promise<GbpAccount[]> {
  const all: GbpAccount[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({ pageSize: "20" });
    if (pageToken) params.set("pageToken", pageToken);
    const json = (await fetchJson(
      `https://mybusinessaccountmanagement.googleapis.com/v1/accounts?${params}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
      "GBP accounts list",
    )) as {
      accounts?: Array<{ name?: string; accountName?: string; type?: string }>;
      nextPageToken?: string;
    };
    all.push(
      ...(json.accounts ?? [])
        .filter((a) => a.name)
        .map((a) => ({
          name: a.name as string,
          accountName: a.accountName ?? null,
          type: a.type ?? null,
        })),
    );
    pageToken = json.nextPageToken ?? null;
    if (!pageToken) break;
  }
  return all;
}

export interface GbpLocation {
  /** Resource name, e.g. "locations/9876543210" */
  name: string;
  title: string | null;
  /** Human-readable branch address from the Google Business Profile. */
  address?: string | null;
  /**
   * Verification status when Google includes it. Some Business Information
   * API responses omit this metadata, so absence is unknown rather than false.
   */
  verified: boolean | null;
  /**
   * ISO 3166-1 alpha-2 country code from the GBP storefrontAddress, e.g.
   * "LB" (Lebanon), "AE" (UAE). Null when address is absent or has no code.
   */
  regionCode?: string | null;
  /**
   * Neighbourhood / city from the GBP storefrontAddress (e.g. "Achrafieh",
   * "Jdeideh"). Used to disambiguate branches that share the same title.
   */
  locality?: string | null;
}

type GbpStorefrontAddress = {
  regionCode?: string;
  addressLines?: string[];
  locality?: string;
  administrativeArea?: string;
  postalCode?: string;
};

function getGbpLocationArea(address: GbpStorefrontAddress | undefined): string | null {
  for (const value of [address?.locality, address?.administrativeArea]) {
    const area = value?.trim();
    if (area) return area;
  }
  return null;
}

function formatGbpLocationAddress(address: GbpStorefrontAddress | undefined): string | null {
  if (!address) return null;
  const parts = [
    ...(address.addressLines ?? []),
    address.locality,
    address.administrativeArea,
    address.postalCode,
  ]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));
  return parts.length > 0 ? [...new Set(parts)].join(", ") : null;
}

type GbpLocationApiResponse = {
  name?: string;
  title?: string;
  storefrontAddress?: GbpStorefrontAddress;
  metadata?: { hasVoiceOfMerchant?: boolean };
};

function mapGbpLocation(raw: GbpLocationApiResponse): GbpLocation | null {
  if (!raw.name) return null;
  return {
    name: raw.name,
    title: raw.title?.trim() || null,
    address: formatGbpLocationAddress(raw.storefrontAddress),
    verified: typeof raw.metadata?.hasVoiceOfMerchant === "boolean"
      ? raw.metadata.hasVoiceOfMerchant
      : null,
    regionCode: raw.storefrontAddress?.regionCode?.trim().toUpperCase() || null,
    // Google sometimes supplies a city only as administrativeArea (notably
    // Dubai), so prefer locality but retain the administrative fallback.
    locality: getGbpLocationArea(raw.storefrontAddress),
  };
}

export async function listGbpLocations(
  accessToken: string,
  accountName: string,
  maxPages = 10,
): Promise<GbpLocation[]> {
  const all: GbpLocation[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({
      readMask: "name,title,storefrontAddress,metadata",
      pageSize: "100",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const json = (await fetchJson(
      `https://mybusinessbusinessinformation.googleapis.com/v1/${accountName}/locations?${params}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
      "GBP locations list",
    )) as {
      locations?: GbpLocationApiResponse[];
      nextPageToken?: string;
    };
    all.push(
      ...(json.locations ?? [])
        .map(mapGbpLocation)
        .filter((l): l is GbpLocation => l !== null),
    );
    pageToken = json.nextPageToken ?? null;
    if (!pageToken) break;
  }
  return all;
}

/**
 * Fetch current structured metadata for one connected GBP location.
 * A direct lookup avoids downloading every location in an account during the
 * hourly reconciliation sweep.
 */
export async function fetchGbpLocation(
  accessToken: string,
  locationName: string,
): Promise<GbpLocation | null> {
  try {
    const json = (await fetchJson(
      `https://mybusinessbusinessinformation.googleapis.com/v1/${locationName}?readMask=name,title,storefrontAddress,metadata`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
      "GBP location fetch",
    )) as GbpLocationApiResponse;
    return mapGbpLocation(json);
  } catch (err) {
    if (err instanceof GbpApiError && err.status === 404) return null;
    throw err;
  }
}

export interface GbpLocationOption extends GbpLocation {
  /** Owning account resource name, e.g. "accounts/1234567890" */
  accountName: string;
  accountLabel: string | null;
}

/**
 * Enumerate locations across EVERY managed account (both lists paginated) so
 * multi-account users can select any verified location, not just those in the
 * first account.
 */
export async function listAllGbpLocationOptions(
  accessToken: string,
  accounts?: GbpAccount[],
): Promise<GbpLocationOption[]> {
  const managedAccounts = accounts ?? await listGbpAccounts(accessToken);
  const options: GbpLocationOption[] = [];
  for (const account of managedAccounts) {
    const locations = await listGbpLocations(accessToken, account.name);
    for (const location of locations) {
      options.push({
        ...location,
        accountName: account.name,
        accountLabel: account.accountName,
      });
    }
  }
  return options;
}

// ── Notifications API ─────────────────────────────────────────────────────

/**
 * Point the account's notification setting at our Pub/Sub topic and subscribe
 * to NEW_REVIEW + UPDATED_REVIEW. Returns the applied setting.
 */
export async function updateGbpNotificationSetting(
  accessToken: string,
  accountName: string,
  pubsubTopic: string,
): Promise<{ pubsubTopic: string; notificationTypes: string[] }> {
  const json = (await fetchJson(
    `https://mybusinessnotifications.googleapis.com/v1/${accountName}/notificationSetting?updateMask=pubsub_topic,notification_types`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: `${accountName}/notificationSetting`,
        pubsubTopic,
        notificationTypes: ["NEW_REVIEW", "UPDATED_REVIEW"],
      }),
    },
    "GBP notification setting update",
  )) as { pubsubTopic?: string; notificationTypes?: string[] };
  return {
    pubsubTopic: json.pubsubTopic ?? pubsubTopic,
    notificationTypes: json.notificationTypes ?? ["NEW_REVIEW", "UPDATED_REVIEW"],
  };
}

// ── Reviews (v4) ──────────────────────────────────────────────────────────

const STAR_RATING: Record<string, number> = {
  ONE: 1,
  TWO: 2,
  THREE: 3,
  FOUR: 4,
  FIVE: 5,
};

export interface GbpReview {
  /** Full resource name: accounts/{a}/locations/{l}/reviews/{r} */
  name: string;
  reviewId: string;
  reviewerName: string | null;
  rating: number | null;
  comment: string | null;
  createTime: string | null;
  updateTime: string | null;
}

function mapReview(raw: {
  name?: string;
  reviewId?: string;
  reviewer?: { displayName?: string };
  starRating?: string;
  comment?: string;
  createTime?: string;
  updateTime?: string;
}, fallbackName?: (reviewId: string) => string): GbpReview | null {
  const reviewId = raw.reviewId ?? raw.name?.split("/reviews/")[1] ?? null;
  if (!reviewId) return null;
  // GBP v4 Review responses often omit `name`; derive the full resource name
  // from the request context so provenance is always persisted.
  return {
    name: raw.name || (fallbackName ? fallbackName(reviewId) : ""),
    reviewId,
    reviewerName: raw.reviewer?.displayName ?? null,
    rating: raw.starRating ? (STAR_RATING[raw.starRating] ?? null) : null,
    comment: raw.comment ?? null,
    createTime: raw.createTime ?? null,
    updateTime: raw.updateTime ?? null,
  };
}

/**
 * Fetch a single review by its full resource name. Returns null when the
 * review no longer exists (deleted by the reviewer or removed by Google).
 */
export async function fetchGbpReview(
  accessToken: string,
  reviewName: string,
): Promise<GbpReview | null> {
  try {
    const json = (await fetchJson(
      `https://mybusiness.googleapis.com/v4/${reviewName}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
      "GBP review fetch",
    )) as Parameters<typeof mapReview>[0];
    // The v4 API may omit `name`; we requested this exact resource, so it IS
    // the review's provenance.
    return mapReview(json, () => reviewName);
  } catch (err) {
    if (err instanceof GbpApiError && err.status === 404) return null;
    throw err;
  }
}

/**
 * List recent reviews for a location (newest updates first), following
 * `nextPageToken` until either every page is consumed, `maxPages` is hit, or
 * a page ends with reviews last updated before `updatedSince` — bounding the
 * sweep to the window reconciliation actually cares about while still
 * covering >1 page of missed notifications between sweeps.
 */
export async function listRecentGbpReviews(
  accessToken: string,
  accountName: string,
  locationName: string,
  options: { pageSize?: number; maxPages?: number; updatedSince?: Date } = {},
): Promise<GbpReview[]> {
  const pageSize = options.pageSize ?? 50;
  const maxPages = options.maxPages ?? 10;
  const updatedSince = options.updatedSince ?? null;

  const all: GbpReview[] = [];
  let pageToken: string | null = null;

  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({
      pageSize: String(pageSize),
      orderBy: "updateTime desc",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const json = (await fetchJson(
      `https://mybusiness.googleapis.com/v4/${accountName}/${locationName}/reviews?${params}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
      "GBP reviews list",
    )) as { reviews?: Array<Parameters<typeof mapReview>[0]>; nextPageToken?: string };

    const reviews = (json.reviews ?? [])
      .map((r) =>
        mapReview(r, (reviewId) => `${accountName}/${locationName}/reviews/${reviewId}`),
      )
      .filter((r): r is GbpReview => r !== null);
    all.push(...reviews);

    pageToken = json.nextPageToken ?? null;
    if (!pageToken || reviews.length === 0) break;

    // Results are ordered by updateTime desc — once the oldest review on this
    // page predates the window we care about, later pages are all older.
    if (updatedSince) {
      const last = reviews[reviews.length - 1];
      const lastUpdated = last.updateTime ?? last.createTime;
      if (lastUpdated && new Date(lastUpdated) < updatedSince) break;
    }
  }
  return all;
}

export interface GbpConnectionRow {
  id: number;
  workspace_owner_id: string;
  credentials_encrypted: string;
  account_name: string | null;
  account_label: string | null;
  location_name: string | null;
  location_title: string | null;
  notifications_state: string | null;
  last_error: string | null;
  last_synced_at: string | null;
}

export const GBP_CONNECTION_COLUMNS = `id, workspace_owner_id, credentials_encrypted,
       account_name, account_label, location_name, location_title,
       notifications_state, last_error, last_synced_at`;

export async function loadGbpConnection(ownerId: string): Promise<GbpConnectionRow | null> {
  const res = await db.query<GbpConnectionRow>(
    `SELECT ${GBP_CONNECTION_COLUMNS}
       FROM gbp_connections
      WHERE workspace_owner_id = $1`,
    [ownerId],
  );
  return res.rows[0] ?? null;
}

/** Find the connection whose selected location matches a notification. */
export async function findGbpConnectionByLocation(
  locationName: string,
): Promise<GbpConnectionRow | null> {
  const res = await db.query<GbpConnectionRow>(
    `SELECT ${GBP_CONNECTION_COLUMNS}
       FROM gbp_connections
      WHERE location_name = $1
        AND credentials_encrypted <> ''`,
    [locationName],
  );
  return res.rows[0] ?? null;
}

// ── Multi-location connection helpers ─────────────────────────────────────

export interface GbpLocationRow {
  id: number;
  workspace_owner_id: string;
  gbp_connection_id: number;
  location_name: string;
  location_title: string | null;
  is_enabled: boolean;
  notifications_state: string | null;
  last_error: string | null;
  last_synced_at: string | null;
  /** Joined from gbp_connections — needed for credential resolution. */
  credentials_encrypted: string;
}

/**
 * Look up the enabled gbp_location_connections row matching a GBP location
 * resource name (e.g. "locations/9876543210"), joined with the parent
 * gbp_connections row for credentials. Returns null when the location is not
 * connected or is disabled.
 */
export async function findGbpLocationByName(
  locationName: string,
): Promise<GbpLocationRow | null> {
  const res = await db.query<GbpLocationRow>(
    `SELECT glc.id, glc.workspace_owner_id, glc.gbp_connection_id,
            glc.location_name, glc.location_title, glc.is_enabled,
            glc.notifications_state, glc.last_error, glc.last_synced_at,
            gc.credentials_encrypted
       FROM gbp_location_connections glc
       JOIN gbp_connections gc ON gc.id = glc.gbp_connection_id
      WHERE glc.location_name = $1
        AND glc.is_enabled = true
        AND gc.credentials_encrypted <> ''`,
    [locationName],
  );
  return res.rows[0] ?? null;
}

export async function recordGbpLocationError(locationId: number, message: string): Promise<void> {
  await db
    .query(
      `UPDATE gbp_location_connections
          SET last_error = $2, updated_at = now()
        WHERE id = $1`,
      [locationId, message.slice(0, 1000)],
    )
    .catch(() => {});
}

export async function clearGbpLocationError(locationId: number): Promise<void> {
  await db.query(
    `UPDATE gbp_location_connections
        SET last_error = NULL, last_synced_at = now(), updated_at = now()
      WHERE id = $1`,
    [locationId],
  );
}

export async function recordGbpError(connectionId: number, message: string): Promise<void> {
  await db.query(
    `UPDATE gbp_connections SET last_error = $2, updated_at = now() WHERE id = $1`,
    [connectionId, message.slice(0, 1000)],
  );
}

export async function clearGbpError(connectionId: number): Promise<void> {
  await db.query(
    `UPDATE gbp_connections
        SET last_error = NULL, last_synced_at = now(), updated_at = now()
      WHERE id = $1`,
    [connectionId],
  );
}

// ── Ingest processing ─────────────────────────────────────────────────────

/**
 * Upsert a fetched review into google_reviews and run attribution (new rows)
 * or refresh mutable fields (existing rows). Idempotent by google reviewId —
 * duplicate/replayed notifications create no extra records or rewards.
 *
 * @param gbpLocationId  The `gbp_location_connections.id` for the location
 *   that produced this review. Written to `google_reviews.gbp_location_id`
 *   on insert so attribution is location-scoped. Null for legacy/backfill paths.
 */
export async function upsertFetchedReview(
  workspaceOwnerId: string,
  review: GbpReview,
  gbpLocationId?: number | null,
): Promise<{ reviewId: number; created: boolean }> {
  const result = await ingestReview({
    workspaceOwnerId,
    googleReviewId: review.reviewId,
    reviewerName: review.reviewerName,
    rating: review.rating,
    comment: review.comment,
    reviewCreatedAt: review.createTime ? new Date(review.createTime) : undefined,
    gbpLocationId: gbpLocationId ?? null,
  });
  if (result.created) {
    // Record provenance (full review resource name) so reconciliation only
    // ever checks this review against the location that produced it.
    if (review.name) {
      await db.query(
        `UPDATE google_reviews SET gbp_review_name = $3, updated_at = now()
          WHERE workspace_owner_id = $1 AND google_review_id = $2`,
        [workspaceOwnerId, review.reviewId, review.name],
      );
    }
  } else {
    // UPDATED_REVIEW: refresh the mutable display fields (never re-attribute).
    await db.query(
      `UPDATE google_reviews
          SET reviewer_name   = COALESCE($3, reviewer_name),
              rating          = COALESCE($4, rating),
              comment         = $5,
              gbp_review_name = COALESCE($6, gbp_review_name),
              updated_at      = now()
        WHERE workspace_owner_id = $1 AND google_review_id = $2 AND is_deleted = false`,
      [workspaceOwnerId, review.reviewId, review.reviewerName, review.rating, review.comment, review.name || null],
    );
  }
  return { reviewId: result.reviewId, created: result.created };
}

/**
 * Mark a stored review deleted (voiding any pending/approved reward) when the
 * live review is gone. No-op when we never stored it or already marked it.
 */
export async function handleDeletedReview(
  workspaceOwnerId: string,
  googleReviewId: string,
): Promise<boolean> {
  const res = await db.query<{ id: number; is_deleted: boolean }>(
    `SELECT id, is_deleted FROM google_reviews
      WHERE workspace_owner_id = $1 AND google_review_id = $2`,
    [workspaceOwnerId, googleReviewId],
  );
  const row = res.rows[0];
  if (!row || row.is_deleted) return false;
  await markReviewDeleted(workspaceOwnerId, row.id);
  logger.info(
    { workspaceOwnerId, googleReviewId },
    "gbp: review deleted — pending reward voided",
  );
  return true;
}

/**
 * Process one decoded Pub/Sub review notification end-to-end: resolve the
 * connection by location, fetch the review, and upsert or mark deleted.
 *
 * Returns "ok" when processed, "ignored" for notifications we can safely ack
 * without work (unknown location, non-review notification), and throws on
 * transient failures so the caller can NACK and let Pub/Sub retry.
 */
export async function processGbpNotification(notification: {
  notificationType?: string;
  /** Documented GBP field: full review resource name accounts/{a}/locations/{l}/reviews/{r}. */
  reviewName?: string;
  /** Documented GBP field: accounts/{a}/locations/{l}. */
  locationName?: string;
  /** Legacy/alternate field name — accepted as fallback. */
  review?: string;
}): Promise<"ok" | "ignored"> {
  const type = notification.notificationType;
  if (type !== "NEW_REVIEW" && type !== "UPDATED_REVIEW") return "ignored";
  const reviewName = notification.reviewName ?? notification.review;
  if (!reviewName) {
    logger.warn({ notification }, "gbp: review notification missing reviewName");
    return "ignored";
  }

  // Resource name: accounts/{a}/locations/{l}/reviews/{r}
  const match = reviewName.match(/^(accounts\/[^/]+)\/(locations\/[^/]+)\/reviews\/(.+)$/);
  if (!match) {
    logger.warn({ reviewName }, "gbp: unparseable review resource name");
    return "ignored";
  }
  const [, accountName, locationName, googleReviewId] = match;

  // Cross-check the notification's locationName against the review resource —
  // a mismatch means a malformed/spoofed payload we should not act on. GBP's
  // documented value is the canonical "locations/{id}"; the account-qualified
  // "accounts/{a}/locations/{id}" form is accepted as a compatibility variant.
  if (
    notification.locationName &&
    notification.locationName !== locationName &&
    notification.locationName !== `${accountName}/${locationName}`
  ) {
    logger.warn(
      { reviewName, locationName: notification.locationName },
      "gbp: notification locationName does not match review resource — ignored",
    );
    return "ignored";
  }

  // First try the new per-location table (multi-location support).
  const locConn = await findGbpLocationByName(locationName);
  if (locConn) {
    try {
      const creds = decryptGbpCredentials(locConn.credentials_encrypted);
      const oauthClient = await resolveGbpOauthClient(locConn.workspace_owner_id);
      const accessToken = await getGbpAccessToken(creds, oauthClient ?? undefined);
      const review = await fetchGbpReview(accessToken, reviewName);

      if (!review) {
        await handleDeletedReview(locConn.workspace_owner_id, googleReviewId);
      } else {
        await upsertFetchedReview(locConn.workspace_owner_id, review, locConn.id);
      }
      await clearGbpLocationError(locConn.id);
      // Also clear the parent connection error so the status page stays clean.
      await clearGbpError(locConn.gbp_connection_id);
      return "ok";
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        { err, reviewName, locationId: locConn.id, notificationType: type },
        "gbp: failed to process review notification (location-scoped)",
      );
      await recordGbpLocationError(locConn.id, `Notification processing failed: ${message}`);
      throw err;
    }
  }

  // Fall back to the legacy single-location lookup for workspaces that have
  // not yet been migrated to gbp_location_connections.
  const conn = await findGbpConnectionByLocation(locationName);
  if (!conn) {
    logger.info({ locationName }, "gbp: notification for unconnected location — ignored");
    return "ignored";
  }

  try {
    const creds = decryptGbpCredentials(conn.credentials_encrypted);
    const oauthClient = await resolveGbpOauthClient(conn.workspace_owner_id);
    const accessToken = await getGbpAccessToken(creds, oauthClient ?? undefined);
    const review = await fetchGbpReview(accessToken, reviewName);

    if (!review) {
      await handleDeletedReview(conn.workspace_owner_id, googleReviewId);
    } else {
      await upsertFetchedReview(conn.workspace_owner_id, review);
    }
    await clearGbpError(conn.id);
    return "ok";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { err, reviewName, connectionId: conn.id, notificationType: type },
      "gbp: failed to process review notification",
    );
    await recordGbpError(conn.id, `Notification processing failed: ${message}`).catch(() => {});
    throw err;
  }
}

