import { Router, type IRouter } from "express";
import { randomBytes } from "crypto";
import type { PoolClient } from "pg";
import { db } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";
import { externalOrigin } from "../lib/oauthRedirect";
import {
  exchangeCode,
  getAccessToken,
  listGscSites,
  encryptGscCredentials,
  encryptGscOauthClient,
  decryptGscOauthClient,
  maskGscClientId,
  resolveGscOauthClient,
  runSearchConsoleSync,
  type GscConnectionRow,
  type GscOauthClient,
} from "../lib/searchConsoleSync";
import { credentialEncryptionConfigurationError } from "../lib/credentialEncryption";

const router: IRouter = Router();

router.use(requireAuth, resolveWorkspace);

function isOwner(req: Parameters<typeof workspace>[0]): boolean {
  return workspace(req).workspaceRole === "owner";
}

interface OauthConfigRow {
  id: number;
  workspace_owner_id: string;
  oauth_client_encrypted: string;
}

type CredentialErrorCode =
  | "credentials_unreadable"
  | "credential_storage_unavailable";

const CREDENTIAL_STORAGE_UNAVAILABLE_MESSAGE =
  "Saved Search Console credential storage is unavailable. Please try again after database initialization completes.";

async function loadOauthConfig(ownerId: string): Promise<OauthConfigRow | null> {
  const res = await db.query<OauthConfigRow>(
    `SELECT id, workspace_owner_id, oauth_client_encrypted
       FROM search_console_oauth_config
      WHERE workspace_owner_id = $1`,
    [ownerId],
  );
  return res.rows[0] ?? null;
}

function redirectUri(req: { protocol: string; hostname: string }): string {
  const base =
    process.env.GOOGLE_SEARCH_CONSOLE_REDIRECT_URI ??
    `${externalOrigin(req)}/api/seo/search-console/callback`;
  return base;
}

async function loadConnection(ownerId: string): Promise<GscConnectionRow | null> {
  const res = await db.query<GscConnectionRow>(
    `SELECT id, workspace_owner_id, site_url, credentials_encrypted
       FROM search_console_connections
      WHERE workspace_owner_id = $1`,
    [ownerId],
  );
  return res.rows[0] ?? null;
}

// ── GET /seo/search-console/status ───────────────────────────────────────

router.get("/seo/search-console/status", async (req, res) => {
  if (!isOwner(req)) {
    res.status(403).json({ error: "Owner access required" });
    return;
  }
  const ownerId = workspace(req).workspaceOwnerId;

  const credentialsFromEnv = !!(
    process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_ID &&
    process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET
  );

  // Wrap DB access in try/catch — a missing table or transient error must
  // never cause a 500 here; we still surface credentialsFromEnv from env vars.
  let oauthConfig: OauthConfigRow | null = null;
  let credentialsSaved = false;
  let savedClientId: string | null = null;
  let credentialError: string | null = null;
  let credentialErrorCode: CredentialErrorCode | null = null;
  let credentialStorageAvailable = true;

  try {
    oauthConfig = await loadOauthConfig(ownerId);
    credentialsSaved = !!oauthConfig;
    if (oauthConfig) {
      try {
        const client = decryptGscOauthClient(oauthConfig.oauth_client_encrypted);
        // Return only a masked/partial Client ID — never the full value or Secret.
        savedClientId = maskGscClientId(client.clientId);
      } catch {
        savedClientId = "••••";
        credentialError = "The saved workspace credentials cannot be read. Replace them to continue.";
        credentialErrorCode = "credentials_unreadable";
      }
    }
  } catch (err) {
    credentialStorageAvailable = false;
    credentialError = CREDENTIAL_STORAGE_UNAVAILABLE_MESSAGE;
    credentialErrorCode = "credential_storage_unavailable";
    req.log.warn({ err }, "GSC status: failed to load oauth config from DB");
  }

  // Do not claim a server fallback while the workspace override storage cannot
  // be read: an unreadable override must not silently be bypassed.
  const credentialSource = !credentialStorageAvailable
    ? "none"
    : credentialsSaved
      ? "workspace"
      : credentialsFromEnv
        ? "environment"
        : "none";
  const clientId = credentialSource === "environment"
    ? maskGscClientId(process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_ID!)
    : savedClientId;
  const enabled = credentialSource !== "none";

  if (!enabled) {
    res.json({
      connected: false,
      enabled: false,
      siteUrl: null,
      syncStatus: null,
      lastSyncAt: null,
      lastError: null,
      credentialsSaved,
      credentialsFromEnv,
      credentialSource,
      clientId,
      credentialError,
      credentialErrorCode,
    });
    return;
  }

  let conn:
    | { site_url: string; sync_status: string; last_sync_at: string | null; last_error: string | null }
    | undefined;
  try {
    const row = await db.query<{
      site_url: string;
      sync_status: string;
      last_sync_at: string | null;
      last_error: string | null;
    }>(
      `SELECT site_url, sync_status, last_sync_at, last_error
         FROM search_console_connections
        WHERE workspace_owner_id = $1`,
      [ownerId],
    );
    conn = row.rows[0];
  } catch (err) {
    req.log.warn({ err }, "GSC status: failed to load connection from DB — falling back");
  }

  res.json({
    connected: !!conn,
    enabled: true,
    siteUrl: conn?.site_url ?? null,
    syncStatus: conn?.sync_status ?? null,
    lastSyncAt: conn?.last_sync_at ?? null,
    lastError: conn?.last_error ?? null,
    credentialsSaved,
    credentialsFromEnv,
    credentialSource,
    clientId,
    credentialError,
    credentialErrorCode,
  });
});

// ── GET /seo/search-console/credentials ──────────────────────────────────

router.get("/seo/search-console/credentials", async (req, res) => {
  if (!isOwner(req)) {
    res.status(403).json({ error: "Owner access required" });
    return;
  }
  const ownerId = workspace(req).workspaceOwnerId;

  const credentialsFromEnv = !!(
    process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_ID &&
    process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET
  );
  let config: OauthConfigRow | null;
  try {
    config = await loadOauthConfig(ownerId);
  } catch (err) {
    req.log.warn({ err }, "GSC credentials: failed to load oauth config from DB");
    res.status(503).json({
      code: "credential_storage_unavailable",
      error: CREDENTIAL_STORAGE_UNAVAILABLE_MESSAGE,
    });
    return;
  }
  let maskedClientId: string | null = credentialsFromEnv
    ? maskGscClientId(process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_ID!)
    : null;
  let credentialError: string | null = null;
  try {
    if (config) {
      const client = decryptGscOauthClient(config.oauth_client_encrypted);
      maskedClientId = maskGscClientId(client.clientId);
    }
  } catch {
    maskedClientId = "••••";
    credentialError = "The saved workspace credentials cannot be read. Replace them to continue.";
  }

  res.json({
    saved: !!config,
    credentialsFromEnv,
    credentialSource: config ? "workspace" : credentialsFromEnv ? "environment" : "none",
    clientId: maskedClientId,
    credentialError,
    credentialErrorCode: credentialError ? "credentials_unreadable" : null,
  });
});

// ── POST /seo/search-console/credentials ─────────────────────────────────

router.post("/seo/search-console/credentials", async (req, res) => {
  if (!isOwner(req)) {
    res.status(403).json({ error: "Owner access required" });
    return;
  }

  if (credentialEncryptionConfigurationError()) {
    res.status(503).json({
      code: "encryption_unavailable",
      error:
        "Secure credential storage is not configured correctly on the server. Fix CREDENTIAL_ENCRYPTION_KEY and try again.",
    });
    return;
  }

  const ownerId = workspace(req).workspaceOwnerId;

  const { clientId, clientSecret } = req.body as {
    clientId?: unknown;
    clientSecret?: unknown;
  };

  if (
    typeof clientId !== "string" ||
    !clientId.trim() ||
    clientId.trim().length > 2048
  ) {
    res.status(400).json({
      code: "invalid_client_id",
      error: "Client ID is required and must be at most 2048 characters.",
    });
    return;
  }
  if (
    typeof clientSecret !== "string" ||
    !clientSecret.trim() ||
    clientSecret.trim().length > 4096
  ) {
    res.status(400).json({
      code: "invalid_client_secret",
      error: "Client Secret is required and must be at most 4096 characters.",
    });
    return;
  }

  const normalizedClient = {
    clientId: clientId.trim(),
    clientSecret: clientSecret.trim(),
  };

  let client: PoolClient | null = null;
  try {
    client = await db.connect() as PoolClient;
    const transactionClient = client;
    await transactionClient.query("BEGIN");
    await transactionClient.query(
      `SELECT pg_advisory_xact_lock(hashtext($1))`,
      [`gsc-oauth:${ownerId}`],
    );
    const existing = await transactionClient.query<OauthConfigRow>(
      `SELECT id, workspace_owner_id, oauth_client_encrypted
         FROM search_console_oauth_config
        WHERE workspace_owner_id = $1
        FOR UPDATE`,
      [ownerId],
    );

    let unchanged = false;
    if (existing.rows[0]) {
      try {
        const current = decryptGscOauthClient(
          existing.rows[0].oauth_client_encrypted,
        );
        unchanged =
          current.clientId === normalizedClient.clientId &&
          current.clientSecret === normalizedClient.clientSecret;
      } catch {
        // An unreadable override must remain replaceable from the dashboard.
      }
    }

    if (unchanged) {
      await transactionClient.query("COMMIT");
      res.json({
        ok: true,
        credentialSource: "workspace",
        clientId: maskGscClientId(normalizedClient.clientId),
        reauthorizationRequired: false,
      });
      return;
    }

    const encrypted = encryptGscOauthClient(normalizedClient);
    await transactionClient.query(
      `INSERT INTO search_console_oauth_config (workspace_owner_id, oauth_client_encrypted)
       VALUES ($1, $2)
       ON CONFLICT (workspace_owner_id)
       DO UPDATE SET oauth_client_encrypted = EXCLUDED.oauth_client_encrypted,
                     updated_at = now()`,
      [ownerId, encrypted],
    );
    const disconnected = await transactionClient.query(
      `DELETE FROM search_console_connections WHERE workspace_owner_id = $1`,
      [ownerId],
    );
    // States are bound to the OAuth client that issued them. Removing stale
    // states prevents a code started with replaced credentials from being
    // exchanged against the newly active client.
    await transactionClient.query(
      `DELETE FROM search_console_oauth_states WHERE workspace_owner_id = $1`,
      [ownerId],
    );
    await transactionClient.query("COMMIT");

    res.json({
      ok: true,
      credentialSource: "workspace",
      clientId: maskGscClientId(normalizedClient.clientId),
      reauthorizationRequired: (disconnected.rowCount ?? 0) > 0,
    });
  } catch (err) {
    await client?.query("ROLLBACK").catch(() => {});
    req.log.error({ err }, "Failed to encrypt or save Search Console credentials");
    res.status(500).json({
      code: "save_failed",
      error: "Failed to save credentials. The previous credential remains active.",
    });
  } finally {
    client?.release();
  }
});

// ── DELETE /seo/search-console/credentials ───────────────────────────────

router.delete("/seo/search-console/credentials", async (req, res) => {
  if (!isOwner(req)) {
    res.status(403).json({ error: "Owner access required" });
    return;
  }
  const ownerId = workspace(req).workspaceOwnerId;

  let client: PoolClient | null = null;
  try {
    client = await db.connect() as PoolClient;
    const transactionClient = client;
    await transactionClient.query("BEGIN");
    await transactionClient.query(
      `SELECT pg_advisory_xact_lock(hashtext($1))`,
      [`gsc-oauth:${ownerId}`],
    );
    const cleared = await transactionClient.query<{ connections_deleted: number }>(
      `WITH removed AS (
         DELETE FROM search_console_oauth_config
          WHERE workspace_owner_id = $1
         RETURNING 1
       ),
       disconnected AS (
         DELETE FROM search_console_connections
          WHERE workspace_owner_id = $1
            AND EXISTS (SELECT 1 FROM removed)
         RETURNING 1
       ),
       invalidated_states AS (
         DELETE FROM search_console_oauth_states
          WHERE workspace_owner_id = $1
            AND EXISTS (SELECT 1 FROM removed)
         RETURNING 1
       )
       SELECT COUNT(*)::integer AS connections_deleted FROM disconnected`,
      [ownerId],
    );
    await transactionClient.query("COMMIT");
    const hasEnvironmentFallback = !!(
      process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_ID &&
      process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET
    );
    res.json({
      ok: true,
      credentialSource: hasEnvironmentFallback ? "environment" : "none",
      reauthorizationRequired: (cleared.rows[0]?.connections_deleted ?? 0) > 0,
    });
  } catch (err) {
    await client?.query("ROLLBACK").catch(() => {});
    req.log.error({ err }, "Failed to clear Search Console workspace credentials");
    res.status(500).json({
      code: "clear_failed",
      error: "Failed to clear credentials. The workspace override remains active.",
    });
  } finally {
    client?.release();
  }
});

// ── GET /seo/search-console/auth-url ─────────────────────────────────────

router.get("/seo/search-console/auth-url", async (req, res) => {
  if (!isOwner(req)) {
    res.status(403).json({ error: "Owner access required" });
    return;
  }

  const ownerId = workspace(req).workspaceOwnerId;
  let client: PoolClient | null = null;
  let oauthClient: GscOauthClient | null;
  const state = randomBytes(32).toString("hex");
  let writingState = false;
  try {
    client = await db.connect() as PoolClient;
    const transactionClient = client;
    await transactionClient.query("BEGIN");
    await transactionClient.query(
      `SELECT pg_advisory_xact_lock(hashtext($1))`,
      [`gsc-oauth:${ownerId}`],
    );
    // Read the effective client and write its state while holding the same
    // workspace lock as save, clear, and callback completion. A credential
    // mutation that follows this commit removes the just-created state; one
    // that precedes it is reflected in the effective client we return.
    oauthClient = await resolveGscOauthClient(ownerId, transactionClient);
    if (!oauthClient) {
      await transactionClient.query("ROLLBACK");
      res.status(503).json({
        code: "not_configured",
        error:
          "Google Search Console OAuth is not configured. Set GOOGLE_SEARCH_CONSOLE_CLIENT_ID and GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET, or enter credentials in the dashboard.",
      });
      return;
    }
    writingState = true;
    await transactionClient.query(
      `INSERT INTO search_console_oauth_states (state, workspace_owner_id, expires_at)
       VALUES ($1, $2, now() + INTERVAL '10 minutes')`,
      [state, ownerId],
    );
    await transactionClient.query(
      `DELETE FROM search_console_oauth_states WHERE expires_at < now()`,
    );
    await transactionClient.query("COMMIT");
  } catch (err) {
    await client?.query("ROLLBACK").catch(() => {});
    if (writingState) {
      req.log.error({ err }, "GSC auth URL: failed to create OAuth state");
      res.status(500).json({
        code: "oauth_state_failed",
        error: "Unable to start a secure Google authorization. Please try again.",
      });
      return;
    }
    req.log.warn({ err }, "GSC auth URL: unable to read workspace credentials");
    res.status(503).json({
      code: "credentials_unavailable",
      error: "Saved workspace credentials cannot be read. Replace them and try again.",
    });
    return;
  } finally {
    client?.release();
  }

  const ru = redirectUri(req);
  const params = new URLSearchParams({
    client_id: oauthClient.clientId,
    redirect_uri: ru,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/webmasters.readonly",
    access_type: "offline",
    prompt: "consent",
    state,
  });

  res.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` });
});

// ── GET /seo/search-console/callback ─────────────────────────────────────
// Exchanges the authorization code, discovers GSC properties, and saves the
// connection. On success, redirects to the SEO analytics page.

router.get("/seo/search-console/callback", async (req, res) => {
  if (!isOwner(req)) {
    res.redirect("/seo-analytics?gsc_error=owner_required");
    return;
  }

  const code = typeof req.query.code === "string" ? req.query.code : null;
  const error = typeof req.query.error === "string" ? req.query.error : null;
  const state = typeof req.query.state === "string" ? req.query.state : null;
  const ownerId = workspace(req).workspaceOwnerId;

  if (!state) {
    res.redirect("/seo-analytics?gsc_error=state_missing");
    return;
  }

  // Hold the same workspace lock used by credential save/clear operations
  // until callback persistence finishes. This prevents a callback started with
  // an older OAuth client from recreating a connection after that client has
  // been replaced or cleared. The lock is session-scoped because state
  // consumption must commit before the external Google requests, otherwise a
  // failed callback could leave a valid state replayable.
  let client: PoolClient | null = null;
  let sessionLockHeld = false;
  try {
    client = await db.connect() as PoolClient;
    const lockKey = `gsc-oauth:${ownerId}`;
    await client.query(
      `SELECT pg_advisory_lock(hashtext($1))`,
      [lockKey],
    );
    sessionLockHeld = true;

    const stateRow = await client.query<{ workspace_owner_id: string }>(
      `DELETE FROM search_console_oauth_states
        WHERE state = $1 AND expires_at > now()
        RETURNING workspace_owner_id`,
      [state],
    );
    if (stateRow.rows[0]?.workspace_owner_id !== ownerId) {
      res.redirect("/seo-analytics?gsc_error=state_mismatch");
      return;
    }
    // A supplied state is always consumed, including when Google denies the
    // authorization or omits a code, so it cannot be replayed until expiry.
    if (error || !code) {
      res.redirect("/seo-analytics?gsc_error=access_denied");
      return;
    }

    let oauthClient: GscOauthClient | null;
    try {
      oauthClient = await resolveGscOauthClient(ownerId);
    } catch (err) {
      req.log.warn({ err }, "GSC callback: unable to read workspace credentials");
      res.redirect("/seo-analytics?gsc_error=credentials_unavailable");
      return;
    }
    if (!oauthClient) {
      res.redirect("/seo-analytics?gsc_error=not_configured");
      return;
    }

    const ru = redirectUri(req);
    const creds = await exchangeCode(code, ru, oauthClient);
    const accessToken = await getAccessToken(creds, oauthClient);

    const sites = await listGscSites(accessToken);
    if (sites.length === 0) {
      res.redirect("/seo-analytics?gsc_error=no_properties");
      return;
    }

    // Auto-select the first verified property (single-property auto-select
    // as per task spec; property-selection UI is out of scope).
    const siteUrl = sites[0];
    const encrypted = encryptGscCredentials(creds);

    const saved = await client.query<{ id: number }>(
      `INSERT INTO search_console_connections
         (workspace_owner_id, site_url, credentials_encrypted, sync_status, last_error)
       VALUES ($1,$2,$3,'idle',NULL)
       ON CONFLICT (workspace_owner_id)
       DO UPDATE SET
         site_url              = EXCLUDED.site_url,
         credentials_encrypted = EXCLUDED.credentials_encrypted,
         sync_status           = 'idle',
         last_error            = NULL,
          updated_at            = now()
       RETURNING id`,
      [ownerId, siteUrl, encrypted],
    );

    // Kick off initial full-range sync in the background.
    const connectionId = saved.rows[0]?.id;
    if (connectionId) {
      void runSearchConsoleSync({
        id: connectionId,
        workspace_owner_id: ownerId,
        site_url: siteUrl,
        credentials_encrypted: encrypted,
      }, "full");
    }

    res.redirect("/seo-analytics?gsc_connected=1");
  } catch (err) {
    req.log.warn({ err }, "GSC callback failed");
    res.redirect("/seo-analytics?gsc_error=callback_failed");
  } finally {
    if (client && sessionLockHeld) {
      await client.query(
        `SELECT pg_advisory_unlock(hashtext($1))`,
        [`gsc-oauth:${ownerId}`],
      ).catch(() => {});
    }
    client?.release();
  }
});

// ── POST /seo/search-console/sync ────────────────────────────────────────

router.post("/seo/search-console/sync", async (req, res) => {
  if (!isOwner(req)) {
    res.status(403).json({ error: "Owner access required" });
    return;
  }
  const ownerId = workspace(req).workspaceOwnerId;

  const conn = await loadConnection(ownerId);
  if (!conn) {
    res.status(404).json({ error: "No Search Console property connected" });
    return;
  }

  // Reject if a live sync is already running.
  const busy = await db.query(
    `SELECT 1 FROM search_console_connections
      WHERE id = $1 AND sync_status = 'syncing'
        AND updated_at >= now() - INTERVAL '3 hours'`,
    [conn.id],
  );
  if (busy.rowCount) {
    res.status(409).json({ error: "A sync is already running" });
    return;
  }

  void runSearchConsoleSync(conn, "recent");
  res.status(202).json({ ok: true, message: "Sync started" });
});

// ── DELETE /seo/search-console/connection ────────────────────────────────

router.delete("/seo/search-console/connection", async (req, res) => {
  if (!isOwner(req)) {
    res.status(403).json({ error: "Owner access required" });
    return;
  }
  const ownerId = workspace(req).workspaceOwnerId;

  const result = await db.query(
    `DELETE FROM search_console_connections WHERE workspace_owner_id = $1`,
    [ownerId],
  );
  if (!result.rowCount) {
    res.status(404).json({ error: "No Search Console property connected" });
    return;
  }

  res.json({ ok: true });
});

export default router;
