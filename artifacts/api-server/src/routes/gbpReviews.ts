import { Router, type IRouter, type Request, type Response } from "express";
import { timingSafeEqual, randomBytes } from "crypto";
import type { PoolClient } from "pg";
import { db } from "../lib/db";
import { logger } from "../lib/logger";
import { requireAuth } from "../lib/auth";
import { hasPageAccess, resolveWorkspace, workspace } from "../lib/workspace";
import { externalOrigin } from "../lib/oauthRedirect";
import {
  GBP_SCOPE,
  GbpApiError,
  gbpOauthConfigured,
  resolveGbpOauthClient,
  exchangeGbpCode,
  getGbpAccessToken,
  listGbpAccounts,
  listAllGbpLocationOptions,
  updateGbpNotificationSetting,
  encryptGbpCredentials,
  encryptGbpOauthClient,
  decryptGbpOauthClient,
  maskGbpClientId,
  decryptGbpCredentials,
  loadGbpConnection,
  processGbpNotification,
} from "../lib/googleBusinessProfile";
import { credentialEncryptionConfigurationError } from "../lib/credentialEncryption";
import { isSafeReviewUrl } from "../lib/reviewAttribution";

/**
 * Google Business Profile connection for Review Rewards.
 *
 * Admin flow (owner-only, Clerk auth):
 *   GET    /reviews/google/status      — connection + notifications status
 *   GET    /reviews/google/auth-url    — start OAuth (business.manage)
 *   GET    /reviews/google/callback    — OAuth redirect target
 *   GET    /reviews/google/locations   — list verified locations to pick from
 *   POST   /reviews/google/location    — persist the selected location and
 *                                        subscribe NEW_REVIEW/UPDATED_REVIEW
 *   DELETE /reviews/google/connection  — disconnect
 *
 * Pub/Sub push (public, shared-token verified):
 *   POST /webhooks/gbp-pubsub?token=…  — mounted separately (see below)
 */

/**
 * Classify a GBP OAuth callback failure into one of four error codes so the
 * UI can show an actionable message rather than a generic retry prompt.
 *
 * - api_disabled        — 403 SERVICE_DISABLED from any GBP API call
 * - quota_exceeded      — 429 / RESOURCE_EXHAUSTED (GBP API access not yet approved)
 * - token_exchange_failed — token exchange itself failed (bad client secret / code)
 * - callback_failed     — anything else
 */
type GbpCallbackErrorCode =
  | "api_disabled"
  | "quota_exceeded"
  | "token_exchange_failed"
  | "callback_failed";

function classifyGbpCallbackError(err: unknown): {
  code: GbpCallbackErrorCode;
  detail: string;
} {
  const detail = err instanceof Error ? err.message : String(err);
  if (err instanceof GbpApiError) {
    if (err.status === 403 && detail.includes("SERVICE_DISABLED")) {
      return { code: "api_disabled", detail };
    }
    if (err.status === 429 || detail.includes("RESOURCE_EXHAUSTED")) {
      return { code: "quota_exceeded", detail };
    }
    // exchangeGbpCode labels its errors with "GBP OAuth token exchange"
    if (
      detail.includes("GBP OAuth token exchange") ||
      detail.includes("Token response missing")
    ) {
      return { code: "token_exchange_failed", detail };
    }
  }
  return { code: "callback_failed", detail };
}

function normalizeGbpLocationsError(err: unknown): {
  status: number;
  code: string;
  error: string;
} {
  const detail = err instanceof Error ? err.message : String(err);
  if (err instanceof GbpApiError) {
    if (err.status === 401) {
      return {
        status: 401,
        code: "gbp_reauthorization_required",
        error:
          "Google rejected the dedicated Business Profile OAuth credentials while refreshing access. Update the GBP Client ID and Client Secret, then reconnect Google Business Profile.",
      };
    }
    if (err.status === 403 && detail.includes("SERVICE_DISABLED")) {
      return {
        status: 503,
        code: "gbp_api_disabled",
        error:
          "Google Business Profile API access is disabled for the connected OAuth project. Enable the Account Management and Business Information APIs, then try again.",
      };
    }
    if (err.status === 403) {
      return {
        status: 403,
        code: "gbp_permission_denied",
        error:
          "Google denied access to Business Profile locations. Reconnect with the business.manage permission and confirm this Google account manages the locations.",
      };
    }
    if (err.status === 429) {
      return {
        status: 503,
        code: "gbp_quota_exceeded",
        error:
          "Google Business Profile temporarily rejected the request because the API quota is unavailable. Check the OAuth project's GBP API access and try again.",
      };
    }
  }
  return {
    status: 502,
    code: "gbp_locations_failed",
    error: `Google Business Profile locations could not be loaded: ${detail}`,
  };
}

const router: IRouter = Router();

router.use(requireAuth, resolveWorkspace);

function isOwner(req: Parameters<typeof workspace>[0]): boolean {
  return workspace(req).workspaceRole === "owner";
}

interface GbpOauthConfigRow {
  id: number;
  workspace_owner_id: string;
  oauth_client_encrypted: string;
}

const CREDENTIAL_STORAGE_UNAVAILABLE_MESSAGE =
  "Saved Google Business Profile credential storage is unavailable. Please try again after database initialization completes.";

async function loadGbpOauthConfig(ownerId: string): Promise<GbpOauthConfigRow | null> {
  const result = await db.query<GbpOauthConfigRow>(
    `SELECT id, workspace_owner_id, oauth_client_encrypted
       FROM gbp_oauth_config
      WHERE workspace_owner_id = $1`,
    [ownerId],
  );
  return result.rows[0] ?? null;
}

/**
 * Canonical OAuth redirect URI for GBP.
 *
 * Priority:
 * 1. GOOGLE_REDIRECT_URI env var (set in production via .replit [userenv.production])
 * 2. GBP_OAUTH_REDIRECT_URI legacy alias
 * 3. Request-derived origin (development / Replit preview — falls back to
 *    externalOrigin so the callback path is always resolvable without a
 *    pre-configured URI, matching the pre-deploy development flow).
 *
 * In production the env var is always set, so the request-derived fallback
 * only activates in development where the hostname is registered in Google
 * Cloud Console as a test redirect URI.
 */
export function gbpRedirectUri(req?: { protocol: string; hostname: string }): string | null {
  const configured =
    process.env.GOOGLE_REDIRECT_URI ??
    process.env.GBP_OAUTH_REDIRECT_URI ??
    null;
  if (configured) return configured;
  if (req) return `${externalOrigin(req)}/api/reviews/google/callback`;
  return null;
}

// ── GET /reviews/google/status ────────────────────────────────────────────

router.get("/reviews/google/status", async (req, res) => {
  if (!hasPageAccess(workspace(req), "review-rewards")) {
    res.status(403).json({ error: "Review rewards page access required" });
    return;
  }
  const ownerView = isOwner(req);
  const ownerId = workspace(req).workspaceOwnerId;

  const credentialsFromEnv = gbpOauthConfigured();
  let credentialsSaved = false;
  let savedClientId: string | null = null;
  let credentialError: string | null = null;
  let credentialStorageAvailable = true;
  try {
    const config = await loadGbpOauthConfig(ownerId);
    credentialsSaved = !!config;
    if (config && !credentialsFromEnv) {
      try {
        savedClientId = maskGbpClientId(
          decryptGbpOauthClient(config.oauth_client_encrypted).clientId,
        );
      } catch {
        savedClientId = "••••";
        credentialError =
          "The saved Google credentials cannot be read. Replace them to continue.";
      }
    }
  } catch (err) {
    credentialStorageAvailable = false;
    if (!credentialsFromEnv) {
      credentialError = CREDENTIAL_STORAGE_UNAVAILABLE_MESSAGE;
    }
    req.log.warn({ err }, "gbp status: failed to load OAuth config");
  }
  const credentialSource = credentialsFromEnv
    ? "environment"
    : !credentialStorageAvailable
      ? "none"
      : credentialsSaved
        ? "workspace"
        : "none";
  const enabled = credentialSource !== "none";
  const clientId = credentialSource === "environment"
    ? maskGbpClientId(process.env.GBP_OAUTH_CLIENT_ID!)
    : savedClientId;
  let conn = null;
  try {
    conn = await loadGbpConnection(ownerId);
  } catch (err) {
    req.log.warn({ err }, "gbp status: failed to load connection — falling back");
  }

  let notifications: { pubsubTopic?: string; notificationTypes?: string[] } | null = null;
  if (conn?.notifications_state) {
    try {
      notifications = JSON.parse(conn.notifications_state);
    } catch { /* corrupt state — surface as null */ }
  }

  // Count enabled locations from the new multi-location table.
  let enabledCount = 0;
  if (conn) {
    try {
      const countRes = await db.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM gbp_location_connections
          WHERE workspace_owner_id = $1 AND is_enabled = true`,
        [ownerId],
      );
      enabledCount = Number(countRes.rows[0]?.count ?? 0);
    } catch (err) {
      req.log.warn({ err }, "gbp status: failed to count enabled locations");
    }
  }

  res.json({
    enabled,
    connected: Boolean(conn?.credentials_encrypted),
    enabledCount,
    connectedLocationCount: enabledCount,
    accountName: conn?.account_name ?? null,
    accountLabel: conn?.account_label ?? null,
    locationName: conn?.location_name ?? null,
    locationTitle: conn?.location_title ?? null,
    locationSelected: enabledCount > 0 || !!conn?.location_name,
    lastSyncedAt: conn?.last_synced_at ?? null,
    ...(ownerView
      ? {
          lastError: conn?.last_error ?? null,
          credentialsSaved,
          credentialsFromEnv,
          credentialSource,
          clientId,
          credentialError,
          notifications,
          notificationsConfigured: !!notifications,
          pubsubTopicConfigured: !!process.env.GBP_PUBSUB_TOPIC,
          pushTokenConfigured: !!process.env.GBP_PUBSUB_PUSH_TOKEN,
        }
      : {}),
  });
});

// ── Google Business Profile OAuth client credentials ───────────────────────

router.get("/reviews/google/credentials", async (req, res) => {
  if (!isOwner(req)) { res.status(403).json({ error: "Owner access required" }); return; }
  const ownerId = workspace(req).workspaceOwnerId;
  const credentialsFromEnv = gbpOauthConfigured();
  let config: GbpOauthConfigRow | null = null;
  try {
    config = await loadGbpOauthConfig(ownerId);
  } catch (err) {
    req.log.warn({ err }, "gbp credentials: failed to load OAuth config");
    if (!credentialsFromEnv) {
      res.status(503).json({ error: CREDENTIAL_STORAGE_UNAVAILABLE_MESSAGE });
      return;
    }
  }

  let clientId = credentialsFromEnv
    ? maskGbpClientId(process.env.GBP_OAUTH_CLIENT_ID!)
    : null;
  let credentialError: string | null = null;
  if (config && !credentialsFromEnv) {
    try {
      clientId = maskGbpClientId(
        decryptGbpOauthClient(config.oauth_client_encrypted).clientId,
      );
    } catch {
      clientId = "••••";
      credentialError =
        "The saved Google credentials cannot be read. Replace them to continue.";
    }
  }
  res.json({
    saved: !!config,
    credentialsFromEnv,
    credentialSource: credentialsFromEnv ? "environment" : config ? "workspace" : "none",
    clientId,
    credentialError,
  });
});

router.post("/reviews/google/credentials", async (req, res) => {
  if (!isOwner(req)) { res.status(403).json({ error: "Owner access required" }); return; }
  if (credentialEncryptionConfigurationError()) {
    res.status(503).json({
      error:
        "Secure credential storage is not configured correctly on the server. Fix CREDENTIAL_ENCRYPTION_KEY and try again.",
    });
    return;
  }

  const { clientId, clientSecret } = req.body as {
    clientId?: unknown;
    clientSecret?: unknown;
  };
  if (typeof clientId !== "string" || !clientId.trim() || clientId.trim().length > 2048) {
    res.status(400).json({ error: "Client ID is required and must be at most 2048 characters." });
    return;
  }
  if (typeof clientSecret !== "string" || !clientSecret.trim() || clientSecret.trim().length > 4096) {
    res.status(400).json({ error: "Client Secret is required and must be at most 4096 characters." });
    return;
  }

  const ownerId = workspace(req).workspaceOwnerId;
  const oauthClient = { clientId: clientId.trim(), clientSecret: clientSecret.trim() };
  const credentialsFromEnv = gbpOauthConfigured();
  let client: PoolClient | null = null;
  try {
    client = await db.connect() as PoolClient;
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`gbp-oauth:${ownerId}`]);
    const existing = await client.query<GbpOauthConfigRow>(
      `SELECT id, workspace_owner_id, oauth_client_encrypted
         FROM gbp_oauth_config WHERE workspace_owner_id = $1 FOR UPDATE`,
      [ownerId],
    );
    let unchanged = false;
    if (existing.rows[0]) {
      try {
        const current = decryptGbpOauthClient(existing.rows[0].oauth_client_encrypted);
        unchanged =
          current.clientId === oauthClient.clientId &&
          current.clientSecret === oauthClient.clientSecret;
      } catch {
        // An unreadable override remains replaceable from the dashboard.
      }
    }
    if (credentialsFromEnv) {
      const removed = await client.query(
        `DELETE FROM gbp_oauth_config
          WHERE workspace_owner_id = $1
          RETURNING 1`,
        [ownerId],
      );
      await client.query(`DELETE FROM gbp_oauth_states WHERE workspace_owner_id = $1`, [ownerId]);
      await client.query("COMMIT");
      res.json({
        ok: true,
        clientId: maskGbpClientId(process.env.GBP_OAUTH_CLIENT_ID!),
        credentialSource: "environment",
        workspaceOverrideCleared: Boolean(removed.rowCount),
        reauthorizationRequired: false,
      });
      return;
    }
    if (unchanged) {
      await client.query("COMMIT");
      res.json({
        ok: true,
        clientId: maskGbpClientId(oauthClient.clientId),
        credentialSource: "workspace",
        workspaceOverrideCleared: false,
        reauthorizationRequired: false,
      });
      return;
    }
    await client.query(
      `INSERT INTO gbp_oauth_config (workspace_owner_id, oauth_client_encrypted)
       VALUES ($1, $2)
       ON CONFLICT (workspace_owner_id)
       DO UPDATE SET oauth_client_encrypted = EXCLUDED.oauth_client_encrypted, updated_at = now()`,
      [ownerId, encryptGbpOauthClient(oauthClient)],
    );
    // A complete shared GBP client remains authoritative. Saving a dormant
    // workspace fallback must not disrupt an otherwise healthy connection.
    const existingConnection = gbpOauthConfigured()
      ? { rowCount: 0 }
      : await client.query(
          `UPDATE gbp_connections
              SET last_error = $2,
                  updated_at = now()
            WHERE workspace_owner_id = $1
            RETURNING id`,
          [
            ownerId,
            "Google Business Profile OAuth credentials changed. Reconnect to continue.",
          ],
        );
    await client.query(`DELETE FROM gbp_oauth_states WHERE workspace_owner_id = $1`, [ownerId]);
    await client.query("COMMIT");
    res.json({
      ok: true,
      clientId: maskGbpClientId(oauthClient.clientId),
      credentialSource: "workspace",
      workspaceOverrideCleared: false,
      reauthorizationRequired: (existingConnection.rowCount ?? 0) > 0,
    });
  } catch (err) {
    await client?.query("ROLLBACK").catch(() => {});
    req.log.error({ err }, "Failed to save Google Business Profile credentials");
    res.status(500).json({ error: "Failed to save credentials. The previous credential remains active." });
  } finally {
    client?.release();
  }
});

router.delete("/reviews/google/credentials", async (req, res) => {
  if (!isOwner(req)) { res.status(403).json({ error: "Owner access required" }); return; }
  const ownerId = workspace(req).workspaceOwnerId;
  let client: PoolClient | null = null;
  try {
    client = await db.connect() as PoolClient;
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`gbp-oauth:${ownerId}`]);
    const removed = await client.query(
      `DELETE FROM gbp_oauth_config WHERE workspace_owner_id = $1 RETURNING 1`,
      [ownerId],
    );
    // Never delete the GBP connection or its tracked locations when changing
    // credential sources. Without shared credentials the preserved connection
    // simply needs a fresh authorization.
    const reconnectRequired =
      Boolean(removed.rowCount) && !gbpOauthConfigured();
    if (reconnectRequired) {
      await client.query(
        `UPDATE gbp_connections
            SET last_error = $2,
                updated_at = now()
          WHERE workspace_owner_id = $1`,
        [
          ownerId,
          "Google Business Profile OAuth credentials are unavailable. Configure the dedicated GBP client and reconnect.",
        ],
      );
    }
    if (removed.rowCount) {
      await client.query(`DELETE FROM gbp_oauth_states WHERE workspace_owner_id = $1`, [ownerId]);
    }
    await client.query("COMMIT");
    res.json({
      ok: true,
      credentialSource: gbpOauthConfigured() ? "environment" : "none",
      reauthorizationRequired: reconnectRequired,
    });
  } catch (err) {
    await client?.query("ROLLBACK").catch(() => {});
    req.log.error({ err }, "Failed to clear Google Business Profile credentials");
    res.status(500).json({ error: "Failed to clear credentials. The workspace override remains active." });
  } finally {
    client?.release();
  }
});

// ── GET /reviews/google/auth-url ──────────────────────────────────────────

router.get("/reviews/google/auth-url", async (req, res) => {
  if (!isOwner(req)) { res.status(403).json({ error: "Owner access required" }); return; }
  const ownerId = workspace(req).workspaceOwnerId;
  let oauthClient;
  try {
    oauthClient = await resolveGbpOauthClient(ownerId);
  } catch (err) {
    req.log.warn({ err }, "gbp auth-url: saved OAuth credentials are unreadable");
    res.status(503).json({ error: "Saved Google credentials cannot be read. Replace them to continue." });
    return;
  }
  if (!oauthClient) {
    res.status(503).json({
      error:
        "Google Business Profile OAuth is not configured. Add your Google Client ID and Client Secret first.",
    });
    return;
  }
  const configuredRedirectUri = gbpRedirectUri(req);
  // gbpRedirectUri(req) is always non-null when req is provided (externalOrigin
  // always returns a string). Guard for TypeScript type safety only.
  if (!configuredRedirectUri) {
    res.status(503).json({ error: "Google Business Profile OAuth redirect URI could not be determined." });
    return;
  }

  // CSRF protection: a high-entropy, short-lived state bound server-side to
  // the initiating workspace, consumed atomically by the callback.
  const state = randomBytes(32).toString("hex");
  await db.query(
    `INSERT INTO gbp_oauth_states (state, workspace_owner_id, expires_at)
     VALUES ($1, $2, now() + INTERVAL '10 minutes')`,
    [state, ownerId],
  );
  // Opportunistic cleanup of expired states.
  void db.query(`DELETE FROM gbp_oauth_states WHERE expires_at < now()`).catch(() => {});

  const params = new URLSearchParams({
    client_id: oauthClient.clientId,
    redirect_uri: configuredRedirectUri,
    response_type: "code",
    scope: GBP_SCOPE,
    access_type: "offline",
    // Force an account chooser on every connect/reconnect so an active browser
    // Google session cannot silently authorize a different identity.
    prompt: "consent select_account",
    state,
  });
  res.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` });
});

// ── GET /reviews/google/callback ──────────────────────────────────────────

router.get("/reviews/google/callback", async (req, res) => {
  if (!isOwner(req)) {
    res.status(403).json({ error: "Owner access required" });
    return;
  }
  const code = typeof req.query.code === "string" ? req.query.code : null;
  const error = typeof req.query.error === "string" ? req.query.error : null;
  if (error || !code) {
    res.redirect("/review-rewards?gbp_error=access_denied");
    return;
  }
  const state = typeof req.query.state === "string" ? req.query.state : null;
  const ownerId = workspace(req).workspaceOwnerId;

  // State is REQUIRED and consumed atomically (single-use) BEFORE the token
  // exchange, and must have been issued to this same workspace — otherwise an
  // attacker could trick an owner into consuming a code for an
  // attacker-controlled Google account.
  if (!state) {
    res.redirect("/review-rewards?gbp_error=state_missing");
    return;
  }
  const stateRow = await db.query<{ workspace_owner_id: string }>(
    `DELETE FROM gbp_oauth_states
      WHERE state = $1 AND expires_at > now()
      RETURNING workspace_owner_id`,
    [state],
  );
  if (!stateRow.rowCount || stateRow.rows[0].workspace_owner_id !== ownerId) {
    res.redirect("/review-rewards?gbp_error=state_mismatch");
    return;
  }

  const configuredRedirectUri = gbpRedirectUri(req);
  if (!configuredRedirectUri) {
    // Should be unreachable (req always provides a fallback), but guard defensively.
    res.redirect("/review-rewards?gbp_error=callback_failed");
    return;
  }

  try {
    const oauthClient = await resolveGbpOauthClient(ownerId);
    if (!oauthClient) throw new Error("Google Business Profile OAuth is not configured.");
    const creds = await exchangeGbpCode(code, configuredRedirectUri, oauthClient);
    const accessToken = await getGbpAccessToken(creds, oauthClient);
    const accounts = await listGbpAccounts(accessToken);
    if (accounts.length === 0) {
      res.redirect("/review-rewards?gbp_error=no_accounts");
      return;
    }
    // Store the connection with a provisional account label; the owning
    // account is definitively set when a location is selected (locations are
    // enumerated across ALL managed accounts in the selection step).
    const account = accounts[0];
    // A (re)connect resets the selected location and notification state — the
    // new account may not own the previously selected location, and a stale
    // pairing would corrupt notifications and reconciliation. The owner must
    // explicitly reselect a location.
    await db.query(
      `INSERT INTO gbp_connections
         (workspace_owner_id, credentials_encrypted, account_name, account_label, last_error)
       VALUES ($1,$2,$3,$4,NULL)
       ON CONFLICT (workspace_owner_id)
       DO UPDATE SET
         credentials_encrypted = EXCLUDED.credentials_encrypted,
         account_name          = EXCLUDED.account_name,
         account_label         = EXCLUDED.account_label,
         location_name         = NULL,
         location_title        = NULL,
         notifications_state   = NULL,
         last_error            = NULL,
         updated_at            = now()`,
      [ownerId, encryptGbpCredentials(creds), account.name, account.accountName],
    );
    res.redirect("/review-rewards?gbp_connected=1");
  } catch (err) {
    req.log.error({ err }, "gbp: OAuth callback failed");
    const { code, detail } = classifyGbpCallbackError(err);
    // Best-effort: persist the error detail on any existing connection row so
    // the status endpoint can surface it after the redirect.
    void db
      .query(
        `UPDATE gbp_connections SET last_error = $2, updated_at = now()
          WHERE workspace_owner_id = $1`,
        [ownerId, detail.slice(0, 1000)],
      )
      .catch(() => {});
    res.redirect(`/review-rewards?gbp_error=${code}`);
  }
});

// ── GET /reviews/google/locations ─────────────────────────────────────────

interface GbpLocationConnectionRow {
  id: number;
  gbp_connection_id: number;
  location_name: string;
  location_title: string | null;
  location_locality: string | null;
  account_name: string | null;
  is_enabled: boolean;
  last_error: string | null;
  last_synced_at: string | null;
  review_url: string | null;
}

function normalizeLocationIdentity(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/**
 * Google can issue a new resource name for the same storefront. Preserve the
 * local row (and therefore its review/reward/profile foreign keys) when the
 * provider identity is unambiguous. Never guess when title/locality are
 * incomplete or duplicated, and let the database reject a cross-workspace
 * collision without changing either location.
 */
async function remapUnambiguousRenamedLocations(
  ownerId: string,
  options: Array<{
    name: string;
    title: string | null;
    locality?: string | null;
    accountName: string;
    accountLabel: string | null;
  }>,
  existingRows: GbpLocationConnectionRow[],
  log: { warn: (obj: unknown, message: string) => void },
): Promise<void> {
  const currentNames = new Set(options.map((option) => option.name));
  const renamed = new Set<string>();

  // Exact resource names are the strongest identity. If Google now reports
  // that same location under a different managed account, refresh the stored
  // account binding so review sync stops calling the stale account path.
  for (const option of options) {
    const existing = existingRows.find((row) => row.location_name === option.name);
    if (!existing?.is_enabled || existing.account_name === option.accountName) continue;

    try {
      const result = await db.query(
        `UPDATE gbp_location_connections
            SET account_name = $2,
                location_title = $3,
                location_locality = $4,
                last_error = NULL,
                updated_at = now()
          WHERE id = $1
            AND workspace_owner_id = $5
            AND is_enabled = true
            AND location_name = $6
            AND account_name IS NOT DISTINCT FROM $7`,
        [
          existing.id,
          option.accountName,
          option.title,
          option.locality ?? null,
          ownerId,
          option.name,
          existing.account_name,
        ],
      );
      if ((result.rowCount ?? 0) !== 1) continue;

      // Update the legacy parent account only when its display pointer still
      // names this exact location and old account binding.
      await db.query(
        `UPDATE gbp_connections
            SET account_name = $2,
                account_label = $3,
                updated_at = now()
          WHERE id = $1
            AND workspace_owner_id = $4
            AND location_name = $5
            AND account_name IS NOT DISTINCT FROM $6`,
        [
          existing.gbp_connection_id,
          option.accountName,
          option.accountLabel,
          ownerId,
          option.name,
          existing.account_name,
        ],
      );
      existing.account_name = option.accountName;
      existing.location_title = option.title;
      existing.location_locality = option.locality ?? null;
      existing.last_error = null;
    } catch (err) {
      log.warn(
        { err, ownerId, locationName: option.name },
        "gbp: could not refresh exact location account binding",
      );
    }
  }

  for (const option of options) {
    const title = normalizeLocationIdentity(option.title);
    const locality = normalizeLocationIdentity(option.locality);
    if (!title || !locality || renamed.has(option.name)) continue;

    const candidates = existingRows.filter((existing) =>
      existing.is_enabled &&
      !currentNames.has(existing.location_name) &&
      !renamed.has(existing.location_name) &&
      normalizeLocationIdentity(existing.location_title) === title &&
      normalizeLocationIdentity(existing.location_locality) === locality &&
      (!existing.account_name || existing.account_name === option.accountName),
    );
    if (candidates.length !== 1) continue;

    const existing = candidates[0];
    try {
      const result = await db.query(
        `UPDATE gbp_location_connections
            SET location_name = $2,
                location_title = $3,
                location_locality = $4,
                account_name = $5,
                last_error = NULL,
                updated_at = now()
          WHERE id = $1
            AND workspace_owner_id = $6
            AND is_enabled = true
            AND location_name = $7`,
        [
          existing.id,
          option.name,
          option.title,
          option.locality ?? null,
          option.accountName,
          ownerId,
          existing.location_name,
        ],
      );
      if ((result.rowCount ?? 0) !== 1) continue;

      // Keep the legacy parent display pointer aligned when it pointed at the
      // old resource name. The per-location row remains the source of truth.
      await db.query(
        `UPDATE gbp_connections
            SET location_name = $2,
                location_title = $3,
                account_name = $4,
                account_label = $5,
                last_error = NULL,
                updated_at = now()
          WHERE id = $1
            AND workspace_owner_id = $6
            AND location_name = $7`,
        [
          existing.gbp_connection_id,
          option.name,
          option.title,
          option.accountName,
          option.accountLabel,
          ownerId,
          existing.location_name,
        ],
      );

      existing.location_name = option.name;
      existing.location_title = option.title;
      existing.location_locality = option.locality ?? null;
      existing.account_name = option.accountName;
      existing.last_error = null;
      renamed.add(option.name);
    } catch (err) {
      // A unique-index conflict means another workspace owns the new provider
      // key. Leave the existing row untouched and surface it as attention.
      log.warn(
        { err, ownerId, existingLocationName: existing.location_name, providerLocationName: option.name },
        "gbp: could not safely remap renamed location",
      );
    }
  }
}

router.get("/reviews/google/locations", async (req, res) => {
  if (!isOwner(req)) { res.status(403).json({ error: "Owner access required" }); return; }
  const ownerId = workspace(req).workspaceOwnerId;
  const conn = await loadGbpConnection(ownerId);
  if (!conn?.account_name || !conn.credentials_encrypted) {
    res.status(404).json({ error: "No Google Business Profile connected" });
    return;
  }
  try {
    const creds = decryptGbpCredentials(conn.credentials_encrypted);
    const oauthClient = await resolveGbpOauthClient(ownerId);
    const credentialsBeforeRefresh = JSON.stringify(creds);
    const accessToken = await getGbpAccessToken(creds, oauthClient ?? undefined);
    const credentialsChanged = JSON.stringify(creds) !== credentialsBeforeRefresh;
    // Enumerate every managed account and return its safe identifying context
    // even when Google returns no locations for the authorized identity.
    const accounts = await listGbpAccounts(accessToken);
    const options = await listAllGbpLocationOptions(accessToken, accounts);

    // Fetch current connection state for all locations in this workspace.
    const existingRes = await db.query<GbpLocationConnectionRow>(
      `SELECT id, gbp_connection_id, location_name, location_title, location_locality, account_name,
              is_enabled, last_error, last_synced_at, review_url
         FROM gbp_location_connections
        WHERE workspace_owner_id = $1`,
      [ownerId],
    );
    await remapUnambiguousRenamedLocations(ownerId, options, existingRes.rows, req.log);
    if (credentialsChanged || conn.last_error) {
      await db.query(
        `UPDATE gbp_connections
            SET credentials_encrypted = $2,
                last_error = NULL,
                updated_at = now()
          WHERE workspace_owner_id = $1`,
        [ownerId, encryptGbpCredentials(creds)],
      );
    }
    const locationMap = new Map(existingRes.rows.map((r) => [r.location_name, r]));
    const currentNames = new Set(options.map((l) => l.name));

    res.json({
      accounts,
      connectedAccount: {
        name: conn.account_name,
        label: conn.account_label,
      },
      locations: [
        ...options.map((l) => {
        const existing = locationMap.get(l.name);
        let connectionStatus: "connected" | "needs_attention" | "available" | "not_connected";
        if (!existing) {
          connectionStatus = "not_connected";
        } else if (!existing.is_enabled) {
          connectionStatus = "available";
        } else if (existing.last_error) {
          connectionStatus = "needs_attention";
        } else {
          connectionStatus = "connected";
        }
        return {
          name: l.name,
          title: l.title,
          address: l.address ?? null,
          locality: l.locality ?? null,
          verified: l.verified,
          accountName: l.accountName,
          accountLabel: l.accountLabel,
          selected: existing?.is_enabled ?? false,
          connectionStatus,
          connectionId: existing?.id ?? null,
          isEnabled: existing?.is_enabled ?? false,
          lastSyncedAt: existing?.last_synced_at ?? null,
          lastError: existing?.last_error ?? null,
          reviewUrl: existing?.review_url ?? null,
          availableInGoogle: true,
        };
        }),
        ...existingRes.rows
          .filter((existing) => existing.is_enabled && !currentNames.has(existing.location_name))
          .map((existing) => ({
            name: existing.location_name,
            title: existing.location_title,
            address: null,
            locality: existing.location_locality,
            verified: false,
            accountName: existing.account_name,
            accountLabel: null,
            selected: true,
            connectionStatus: "needs_attention" as const,
            connectionId: existing.id,
            isEnabled: true,
            lastSyncedAt: existing.last_synced_at,
            lastError: existing.last_error,
            reviewUrl: existing.review_url,
            availableInGoogle: false,
          })),
      ],
    });
  } catch (err) {
    req.log.error({ err }, "gbp: locations list failed");
    const normalized = normalizeGbpLocationsError(err);
    await db
      .query(
        `UPDATE gbp_connections
            SET last_error = $2,
                updated_at = now()
          WHERE workspace_owner_id = $1`,
        [ownerId, normalized.error.slice(0, 1000)],
      )
      .catch(() => {});
    res.status(normalized.status).json({
      error: normalized.error,
      code: normalized.code,
    });
  }
});

// ── Shared multi-location save logic ──────────────────────────────────────

/**
 * Enable one or more GBP locations for a workspace. For each name in
 * `locationNames`, upserts a `gbp_location_connections` row (enabled) and
 * subscribes review notifications on the owning account. Any previously
 * enabled locations not in the list are soft-disabled.
 *
 * Shared by both the new POST /locations (multi-select) and the legacy
 * POST /location (single-select) handlers.
 */
async function saveGbpLocations(
  ownerId: string,
  locationNames: string[],
  conn: { id: number; account_name: string | null },
  accessToken: string,
  log: { error: (obj: unknown, msg: string) => void; warn: (msg: string) => void },
  reviewUrls?: Record<string, string>,
): Promise<{
  locationNames: string[];
  notificationsConfigured: boolean;
  notificationsError: string | null;
}> {
  const options = await listAllGbpLocationOptions(accessToken);
  const optionMap = new Map(options.map((l) => [l.name, l]));

  // Validate each requested location
  for (const name of locationNames) {
    const loc = optionMap.get(name);
    if (!loc) {
      throw Object.assign(
        new Error(`Location is no longer available from Google: ${name}. Reconnect Google or remove it from the selected locations.`),
        { statusCode: 400 },
      );
    }
    if (loc.verified === false) {
      throw Object.assign(new Error(`Location is not verified: ${name}`), { statusCode: 400 });
    }
  }

  // Subscribe notifications for each distinct owning account (deduplicated).
  const involvedAccounts = [...new Set(locationNames.map((n) => optionMap.get(n)!.accountName))];
  const notificationResults = new Map<string, string | null>();
  const topic = process.env.GBP_PUBSUB_TOPIC;
  let notificationsError: string | null = null;
  if (topic) {
    for (const accountName of involvedAccounts) {
      try {
        const setting = await updateGbpNotificationSetting(accessToken, accountName, topic);
        notificationResults.set(accountName, JSON.stringify(setting));
      } catch (err) {
        notificationResults.set(accountName, null);
        notificationsError = err instanceof Error ? err.message : String(err);
        log.error({ err, accountName }, "gbp: notification setting update failed for account");
      }
    }
  } else {
    // GBP_PUBSUB_TOPIC is optional — reviews still sync via polling without it.
    // Do not surface its absence as an error; the location is still usable.
    log.warn("gbp: GBP_PUBSUB_TOPIC not set — skipping notification subscription");
  }

  // Preflight: confirm none of the requested locations is already enabled by
  // a different workspace.  Doing this BEFORE acquiring a transaction prevents
  // a partial write — if any location is already taken we abort with no changes.
  const conflictCheck = await db.query<{ location_name: string }>(
    `SELECT location_name
       FROM gbp_location_connections
      WHERE location_name = ANY($1::text[])
        AND is_enabled    = true
        AND workspace_owner_id != $2`,
    [locationNames, ownerId],
  );
  if (conflictCheck.rows.length > 0) {
    const names = conflictCheck.rows.map((r) => r.location_name).join(", ");
    throw Object.assign(
      new Error(`These locations are already connected to another workspace: ${names}`),
      { statusCode: 409 },
    );
  }

  // All writes happen in a single transaction so a constraint race or mid-save
  // error leaves the database unchanged.
  const client = await db.connect() as import("pg").PoolClient;
  try {
    await client.query("BEGIN");

    // Mapping from ISO 3166-1 alpha-2 region codes to the country name stored on
  // gbp_location_connections.country, driving the currency label in the UI.
  const REGION_CODE_TO_COUNTRY: Record<string, string> = {
    LB: "Lebanon",
    AE: "UAE",
  };

  for (const name of locationNames) {
      const loc = optionMap.get(name)!;
      const notificationsState = topic ? (notificationResults.get(loc.accountName) ?? null) : null;
      // Optional per-location review URL — validate with the same allowlist used
      // for workspace-level URLs before persisting so the public redirect cannot
      // be turned into an open redirect by storing an arbitrary URL.
      const rawUrl = reviewUrls?.[name];
      const reviewUrl = rawUrl && isSafeReviewUrl(rawUrl) ? rawUrl : null;
      // Derive country from the GBP address regionCode so the UI can show the
      // correct payout currency label without a separate lookup.
      const country = loc.regionCode ? (REGION_CODE_TO_COUNTRY[loc.regionCode] ?? null) : null;
      await client.query(
        `INSERT INTO gbp_location_connections
           (workspace_owner_id, gbp_connection_id, location_name, location_title,
            is_enabled, notifications_state, last_error, review_url, account_name, country, location_locality)
         VALUES ($1, $2, $3, $4, true, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (workspace_owner_id, location_name)
         DO UPDATE SET
           gbp_connection_id   = EXCLUDED.gbp_connection_id,
           location_title      = COALESCE(EXCLUDED.location_title, gbp_location_connections.location_title),
           is_enabled          = true,
           notifications_state = COALESCE(EXCLUDED.notifications_state, gbp_location_connections.notifications_state),
           last_error          = EXCLUDED.last_error,
           review_url          = COALESCE(EXCLUDED.review_url, gbp_location_connections.review_url),
           account_name        = COALESCE(EXCLUDED.account_name, gbp_location_connections.account_name),
           country             = COALESCE(EXCLUDED.country, gbp_location_connections.country),
           location_locality   = COALESCE(EXCLUDED.location_locality, gbp_location_connections.location_locality),
           updated_at          = now()`,
        [ownerId, conn.id, loc.name, loc.title, notificationsState, notificationsError, reviewUrl, loc.accountName, country, loc.locality ?? null],
      );
    }

    // Soft-disable previously enabled locations that are not in the new list.
    await client.query(
      `UPDATE gbp_location_connections
          SET is_enabled = false, updated_at = now()
        WHERE workspace_owner_id = $1
          AND is_enabled = true
          AND location_name != ALL($2::text[])`,
      [ownerId, locationNames],
    );

    // Keep gbp_connections in sync with the first selected location (backward compat).
    // The parent location_name field is display-only; ownership is enforced by
    // gbp_location_connections.uq_gbp_location_connections_active. Clearing the
    // selection must remain a valid operation: keep the OAuth connection but
    // remove its display-only location pointer.
    if (locationNames.length > 0) {
      const firstLoc = optionMap.get(locationNames[0])!;
      const firstNotificationsState = topic ? (notificationResults.get(firstLoc.accountName) ?? null) : null;
      await client.query(
        `UPDATE gbp_connections
            SET account_name = $2, account_label = $3,
                location_name = $4, location_title = $5,
                notifications_state = $6,
                last_error = $7,
                updated_at = now()
          WHERE workspace_owner_id = $1`,
        [ownerId, firstLoc.accountName, firstLoc.accountLabel, firstLoc.name, firstLoc.title,
         firstNotificationsState, notificationsError],
      );
    } else {
      await client.query(
        `UPDATE gbp_connections
            SET location_name = NULL, location_title = NULL,
                notifications_state = NULL, last_error = NULL,
                updated_at = now()
          WHERE workspace_owner_id = $1`,
        [ownerId],
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return {
    locationNames,
    notificationsConfigured: topic ? [...notificationResults.values()].some((v) => v !== null) : false,
    notificationsError,
  };
}

// ── POST /reviews/google/locations (multi-select, new) ────────────────────

router.post("/reviews/google/locations", async (req, res) => {
  if (!isOwner(req)) { res.status(403).json({ error: "Owner access required" }); return; }
  const ownerId = workspace(req).workspaceOwnerId;
  const { locationNames, reviewUrls } = req.body as {
    locationNames?: unknown;
    reviewUrls?: unknown;
  };
  if (
    !Array.isArray(locationNames) ||
    !locationNames.every((n) => typeof n === "string" && n.length > 0)
  ) {
    res.status(400).json({ error: "locationNames must be an array of location resource name strings" });
    return;
  }
  // reviewUrls is an optional map { [locationName]: url }; ignore invalid shapes.
  const safeReviewUrls: Record<string, string> | undefined =
    reviewUrls != null &&
    typeof reviewUrls === "object" &&
    !Array.isArray(reviewUrls) &&
    Object.values(reviewUrls as Record<string, unknown>).every((v) => typeof v === "string")
      ? (reviewUrls as Record<string, string>)
      : undefined;
  const conn = await loadGbpConnection(ownerId);
  if (!conn?.account_name || !conn.credentials_encrypted) {
    res.status(404).json({ error: "No Google Business Profile connected" });
    return;
  }
  try {
    const creds = decryptGbpCredentials(conn.credentials_encrypted);
    const oauthClient = await resolveGbpOauthClient(ownerId);
    const accessToken = await getGbpAccessToken(creds, oauthClient ?? undefined);
    const result = await saveGbpLocations(ownerId, locationNames as string[], conn, accessToken, req.log, safeReviewUrls);
    res.json({ ok: true, enabledCount: result.locationNames.length, ...result });
  } catch (err) {
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (statusCode === 400) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    if ((err as { code?: string }).code === "23505") {
      res.status(409).json({ error: "This location is already connected to another workspace" });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    req.log.error({ err }, "gbp: multi-location save failed");
    res.status(502).json({ error: `Failed to save locations: ${message}` });
  }
});

// ── POST /reviews/google/location (single-select, deprecated) ─────────────
// Proxies to the multi-select handler with a one-element array. Kept for
// backward compatibility with in-flight clients that use the singular path.

router.post("/reviews/google/location", async (req, res) => {
  if (!isOwner(req)) { res.status(403).json({ error: "Owner access required" }); return; }
  const ownerId = workspace(req).workspaceOwnerId;
  const { locationName } = req.body as { locationName?: unknown };
  if (typeof locationName !== "string" || locationName.length === 0) {
    res.status(400).json({ error: "locationName is required" });
    return;
  }
  const conn = await loadGbpConnection(ownerId);
  if (!conn?.account_name || !conn.credentials_encrypted) {
    res.status(404).json({ error: "No Google Business Profile connected" });
    return;
  }
  try {
    const creds = decryptGbpCredentials(conn.credentials_encrypted);
    const oauthClient = await resolveGbpOauthClient(ownerId);
    const accessToken = await getGbpAccessToken(creds, oauthClient ?? undefined);
    const result = await saveGbpLocations(ownerId, [locationName], conn, accessToken, req.log);
    res.json({
      ok: true,
      locationName,
      locationTitle: null,
      notificationsConfigured: result.notificationsConfigured,
      notificationsError: result.notificationsError,
    });
  } catch (err) {
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (statusCode === 400) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    // Handle preflight 409 (thrown before transaction) and PG unique-constraint violation (23505).
    if (statusCode === 409 || (err as { code?: string }).code === "23505") {
      const msg = statusCode === 409 ? (err as Error).message : "This location is already connected to another workspace";
      res.status(409).json({ error: msg });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    req.log.error({ err }, "gbp: single-location save failed");
    res.status(502).json({ error: `Failed to save location: ${message}` });
  }
});

// NOTE: The deprecated single-location POST /reviews/google/location handler was
// removed — the backward-compat proxy handler above already covers this path.
// ── DELETE /reviews/google/connection ─────────────────────────────────────

router.delete("/reviews/google/connection", async (req, res) => {
  if (!isOwner(req)) { res.status(403).json({ error: "Owner access required" }); return; }
  const ownerId = workspace(req).workspaceOwnerId;
  const result = await db.query(
    // Never delete the parent row: gbp_location_connections references it with
    // ON DELETE CASCADE, and those rows link tracked locations to review history.
    // An empty encrypted-credential sentinel marks the OAuth connection as
    // disconnected while preserving all location and historical associations.
    `UPDATE gbp_connections
        SET credentials_encrypted = '',
            location_name = NULL,
            location_title = NULL,
            notifications_state = NULL,
            last_error = NULL,
            updated_at = now()
      WHERE workspace_owner_id = $1`,
    [ownerId],
  );
  if (!result.rowCount) {
    res.status(404).json({ error: "No Google Business Profile connected" });
    return;
  }
  res.json({ ok: true });
});

export default router;

// ── Pub/Sub push webhook (public, no Clerk auth) ─────────────────────────

function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided.trim());
  const b = Buffer.from(expected.trim());
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export const gbpPubSubRouter: IRouter = Router();

/**
 * POST /webhooks/gbp-pubsub?token=…
 *
 * Google Cloud Pub/Sub push endpoint for Business Profile review
 * notifications. Verified by a shared token in the push endpoint URL
 * (GBP_PUBSUB_PUSH_TOKEN) — configure the same token on the Pub/Sub push
 * subscription. Returns:
 *   2xx → message acked (processed, duplicate, or safely ignorable)
 *   401/503 → misconfiguration (Pub/Sub will retry; fix config)
 *   500 → transient failure (Pub/Sub retries with backoff)
 */
gbpPubSubRouter.post("/webhooks/gbp-pubsub", async (req: Request, res: Response) => {
  const secret = process.env.GBP_PUBSUB_PUSH_TOKEN;
  if (!secret) {
    res.status(503).json({ error: "GBP Pub/Sub webhook not configured" });
    return;
  }
  const provided = typeof req.query.token === "string" ? req.query.token : undefined;
  if (!tokenMatches(provided, secret)) {
    logger.warn(
      { providedPresent: provided !== undefined },
      "gbp pubsub: rejected — token mismatch",
    );
    res.status(401).json({ error: "Invalid token" });
    return;
  }

  // Pub/Sub push envelope: { message: { data: base64(JSON), messageId }, subscription }
  const body = (req.body ?? {}) as {
    message?: { data?: string; messageId?: string };
    subscription?: string;
  };
  const data = body.message?.data;
  if (!data) {
    logger.warn({ bodyKeys: Object.keys(body) }, "gbp pubsub: missing message.data — acked");
    res.status(204).end();
    return;
  }

  let notification: Record<string, unknown>;
  try {
    notification = JSON.parse(Buffer.from(data, "base64").toString("utf8"));
  } catch (err) {
    logger.warn({ err, messageId: body.message?.messageId }, "gbp pubsub: undecodable message — acked");
    res.status(204).end();
    return;
  }

  try {
    const outcome = await processGbpNotification(notification);
    logger.info(
      {
        messageId: body.message?.messageId,
        notificationType: notification.notificationType,
        outcome,
      },
      "gbp pubsub: notification processed",
    );
    res.status(204).end();
  } catch (err) {
    // Transient failure — non-2xx makes Pub/Sub redeliver; processing is
    // idempotent (strict dedupe by google reviewId) so replays are safe.
    const status = err instanceof GbpApiError && err.status === 403 ? 204 : 500;
    if (status === 204) {
      // Permanent auth/permission failure: retrying won't help; error is
      // already recorded on the connection for the status endpoint.
      res.status(204).end();
      return;
    }
    res.status(500).json({ error: "Processing failed" });
  }
});
