import { Router, type IRouter } from "express";
import { z } from "zod";
import { db } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";
import {
  AD_PLATFORMS,
  PLATFORM_SOURCE,
  encryptCredentials,
  runAdPlatformSync,
  validateGoogleAdsAnalytics,
  serviceAccountConfig,
  GOOGLE_ADS_CONFIG_VARS,
  GoogleAdsAnalyticsError,
  isGoogleAdsWorkspaceAllowed,
  validateMetaAds,
  type AdPlatform,
  type ConnectionRow,
} from "../lib/adPlatformSync";
import {
  normalizeConversionFailureCode,
  normalizeDestinationCountry,
  safeConversionFailureReason,
  type ConversionFailureCode,
} from "../lib/paymentLinkConversions";
import { COUNTRY_CATALOGUE } from "../lib/defaults";

const router: IRouter = Router();

router.use(requireAuth, resolveWorkspace);

function isOwner(req: Parameters<typeof workspace>[0]): boolean {
  return workspace(req).workspaceRole === "owner";
}

function parsePlatform(raw: string): AdPlatform | null {
  return (AD_PLATFORMS as string[]).includes(raw) ? (raw as AdPlatform) : null;
}

const metaCredsSchema = z.object({
  accessToken: z.string().min(1).max(2000),
  adAccountId: z.string().min(1).max(100),
});

type ConnectionDbRow = {
  id: number;
  platform: string;
  account_label: string | null;
  account_currency: string | null;
  account_time_zone: string | null;
  auth_mode: string | null;
  sync_status: string;
  last_sync_at: string | null;
  last_full_sync_at: string | null;
  last_error: string | null;
  created_at: string;
  credentials_encrypted?: string;
};

type ConversionFailureDbRow = {
  id: number;
  destination_country: string;
  attempt_count: number;
  failure_reason: string | null;
  last_error: string | null;
  failed_at: string;
};

async function conversionFailureSummary(ownerId: string) {
  const result = await db.query<ConversionFailureDbRow>(
    `SELECT plc.id, plc.destination_country, plc.attempt_count,
            plc.failure_reason, plc.last_error, plc.updated_at::text AS failed_at
       FROM payment_link_conversions plc
       JOIN payment_links pl ON pl.id = plc.payment_link_id
      WHERE pl.workspace_owner_id = $1 AND plc.status = 'failed'
      ORDER BY plc.updated_at DESC, plc.id DESC`,
    [ownerId],
  );

  const marketByKey = new Map<
    string,
    {
      countryCode: string | null;
      marketName: string;
      failedCount: number;
      latestFailedAt: string;
      failures: Array<{
        id: number;
        attemptCount: number;
        failedAt: string;
        reasonCode: ConversionFailureCode;
        reason: string;
      }>;
    }
  >();

  for (const row of result.rows) {
    const countryCode = normalizeDestinationCountry(row.destination_country);
    const catalogueEntry = countryCode
      ? COUNTRY_CATALOGUE.find((entry) => entry.code.toUpperCase() === countryCode)
      : undefined;
    const marketName = catalogueEntry?.name ?? row.destination_country;
    const key = countryCode ?? marketName.trim().toUpperCase();
    const existing = marketByKey.get(key);
    const reasonCode = normalizeConversionFailureCode(row.failure_reason, row.last_error);
    const failure = {
      id: row.id,
      attemptCount: row.attempt_count,
      failedAt: row.failed_at,
      reasonCode,
      reason: safeConversionFailureReason(reasonCode),
    };
    if (existing) {
      existing.failedCount += 1;
      existing.failures.push(failure);
    } else {
      marketByKey.set(key, {
        countryCode,
        marketName,
        failedCount: 1,
        latestFailedAt: row.failed_at,
        failures: [failure],
      });
    }
  }

  return {
    total: result.rows.length,
    markets: [...marketByKey.values()],
  };
}

async function connectionStatusList(ownerId: string) {
  const [connsRes, statsRes, conversionFailures] = await Promise.all([
    db.query<ConnectionDbRow>(
       `SELECT id, platform, account_label, account_currency, account_time_zone, auth_mode,
               sync_status,
              last_sync_at, last_full_sync_at, last_error, created_at
         FROM ad_platform_connections
        WHERE workspace_owner_id = $1`,
      [ownerId],
    ),
    db.query<{ source: string; entry_count: string; latest_date: string | null }>(
      `SELECT source, COUNT(*) AS entry_count, MAX(period_end)::text AS latest_date
         FROM ad_spend_entries
        WHERE workspace_owner_id = $1 AND source = ANY($2)
        GROUP BY source`,
      [ownerId, Object.values(PLATFORM_SOURCE)],
    ),
    conversionFailureSummary(ownerId),
  ]);
  const statsBySource = new Map(statsRes.rows.map((r) => [r.source, r]));
  const bySlug = new Map(connsRes.rows.map((r) => [r.platform, r]));

  const configMissing = GOOGLE_ADS_CONFIG_VARS.filter((name) =>
    name !== "GOOGLE_ADS_LOGIN_CUSTOMER_ID" && !process.env[name]?.trim());
  const googleConfigReady = configMissing.length === 0;
  const connections = AD_PLATFORMS.map((platform) => {
    const conn = bySlug.get(platform);
    const stats = statsBySource.get(PLATFORM_SOURCE[platform]);
    const googleConnected = platform === "google_ads" &&
      conn?.auth_mode === "service_account" &&
      googleConfigReady &&
      isGoogleAdsWorkspaceAllowed(ownerId);
    return {
      platform,
      connected: platform === "google_ads"
        ? googleConnected
        : !!conn,
      accountLabel: platform === "google_ads" && !googleConnected ? null : conn?.account_label ?? null,
      accountCurrency: platform === "google_ads" && !googleConnected ? null : conn?.account_currency ?? null,
      syncStatus: conn ? conn.sync_status : null,
      lastSyncAt: conn?.last_sync_at ?? null,
      lastFullSyncAt: conn?.last_full_sync_at ?? null,
      lastError: conn?.last_error ?? null,
      entryCount: stats ? parseInt(stats.entry_count, 10) : 0,
      latestDataDate: stats?.latest_date ?? null,
      missingConfigurationVariables: platform === "google_ads" ? configMissing : [],
      customerId: platform === "google_ads" && googleConfigReady ? process.env.GOOGLE_ADS_CUSTOMER_ID!.replace(/-/g, "") : null,
      accountName: platform === "google_ads" && googleConnected && conn?.account_label ? conn.account_label : null,
      accountTimeZone: platform === "google_ads" && googleConnected ? conn?.account_time_zone ?? null : null,
    };
  });
  return {
    connections,
    conversionFailures,
  };
}

async function loadConnection(
  ownerId: string,
  platform: AdPlatform,
): Promise<ConnectionRow | null> {
  const res = await db.query<ConnectionRow>(
    `SELECT id, workspace_owner_id, platform, credentials_encrypted, account_created_time
       FROM ad_platform_connections
      WHERE workspace_owner_id = $1 AND platform = $2`,
    [ownerId, platform],
  );
  return res.rows[0] ?? null;
}

/** GET /ad-platforms — connection + sync status for both platforms (owner only). */
router.get("/ad-platforms", async (req, res) => {
  if (!isOwner(req)) { res.status(403).json({ error: "Owner access required" }); return; }
  const ownerId = workspace(req).workspaceOwnerId;
  res.json(await connectionStatusList(ownerId));
});

/** Requeue one terminal conversion upload without changing its transaction key. */
router.post("/ad-platforms/conversion-failures/:id/retry", async (req, res) => {
  if (!isOwner(req)) { res.status(403).json({ error: "Owner access required" }); return; }
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid conversion failure ID" });
    return;
  }
  const ownerId = workspace(req).workspaceOwnerId;
  const updated = await db.query(
    `UPDATE payment_link_conversions plc
        SET status = 'retry', attempt_count = 0, next_attempt_at = now(),
            last_error = NULL, failure_reason = NULL, updated_at = now()
       FROM payment_links pl
      WHERE plc.id = $1
        AND plc.payment_link_id = pl.id
        AND pl.workspace_owner_id = $2
        AND plc.status = 'failed'
      RETURNING plc.id`,
    [id, ownerId],
  );
  if (updated.rowCount) {
    res.json({ queued: true });
    return;
  }

  const existing = await db.query<{ status: string }>(
    `SELECT plc.status
       FROM payment_link_conversions plc
       JOIN payment_links pl ON pl.id = plc.payment_link_id
      WHERE plc.id = $1 AND pl.workspace_owner_id = $2`,
    [id, ownerId],
  );
  if (!existing.rows[0]) {
    res.status(404).json({ error: "Conversion failure not found" });
    return;
  }
  res.status(409).json({ error: "Conversion is not currently failed" });
});

/** Verify server-owned analytics credentials and create/update only a safe marker. */
router.post("/ad-platforms/google_ads/verify", async (req, res) => {
  if (!isOwner(req)) { res.status(403).json({ error: "Owner access required" }); return; }
  const ownerId = workspace(req).workspaceOwnerId;
  if (!isGoogleAdsWorkspaceAllowed(ownerId)) {
    res.status(403).json({ error: "Google Ads analytics is not enabled for this workspace" });
    return;
  }
  try {
    const config = serviceAccountConfig();
    const info = await validateGoogleAdsAnalytics();
    const marker = encryptCredentials({ type: "google_ads_analytics_service_account" });
    await db.query(
      `INSERT INTO ad_platform_connections
       (workspace_owner_id, platform, credentials_encrypted, auth_mode, account_label,
        account_currency, account_time_zone, sync_status, last_error)
       VALUES ($1,'google_ads',$2,'service_account',$3,$4,$5,'idle',NULL)
       ON CONFLICT (workspace_owner_id, platform) DO UPDATE SET
        auth_mode='service_account', account_label=EXCLUDED.account_label,
        account_currency=EXCLUDED.account_currency, account_time_zone=EXCLUDED.account_time_zone,
        sync_status='idle', last_error=NULL, updated_at=now()`,
      [ownerId, marker, info.accountLabel, info.currency, info.timeZone],
    );
    const conn = await loadConnection(ownerId, "google_ads");
    if (conn) void runAdPlatformSync(conn, "full");
    res.json({ verified: true, missingConfigurationVariables: [], customerId: config.customerId.replace(/-/g, ""), accountName: info.accountLabel, currency: info.currency, timezone: info.timeZone });
  } catch (err) {
    const code = err instanceof GoogleAdsAnalyticsError ? err.code : "reporting_query_failed";
    req.log.warn({ code }, "Google Ads analytics verification failed");
    res.status(422).json({ verified: false, error: code });
  }
});

/**
 * POST /ad-platforms/:platform/connect — save + validate credentials, then
 * kick off a full-history backfill in the background (owner only).
 * Reconnecting an existing platform replaces its credentials.
 */
router.post("/ad-platforms/:platform/connect", async (req, res) => {
  if (!isOwner(req)) { res.status(403).json({ error: "Owner access required" }); return; }
  const platform = parsePlatform(req.params.platform);
  if (!platform) { res.status(400).json({ error: "Unknown platform" }); return; }
  const ownerId = workspace(req).workspaceOwnerId;
  if (platform === "google_ads") {
    res.status(405).json({ error: "Google Ads uses server configuration; call /ad-platforms/google_ads/verify" });
    return;
  }

  if (!process.env.CREDENTIAL_ENCRYPTION_KEY && !process.env.WOOCOMMERCE_ENCRYPTION_KEY) {
    res.status(503).json({
      error:
        "Server is missing the CREDENTIAL_ENCRYPTION_KEY secret needed to store ad platform credentials securely. Add it in the environment secrets and try again.",
    });
    return;
  }

  let accountLabel = "";
  let accountCurrency = "";
  let accountTimeZone: string | null = null;
  let accountCreatedTime: string | null = null;
  let encrypted = "";

  try {
     if (platform === "meta_ads") {
      const parsed = metaCredsSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });
        return;
      }
      const info = await validateMetaAds(parsed.data);
      accountLabel = info.accountLabel;
      accountCurrency = info.currency;
      accountCreatedTime = info.createdTime;
      encrypted = encryptCredentials(parsed.data);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    req.log.warn({ err, platform }, "ad platform credential validation failed");
    res.status(422).json({
      error: `Could not connect to Meta Ads: ${message}`,
    });
    return;
  }

  const upserted = await db.query<{ id: number }>(
     `INSERT INTO ad_platform_connections
       (workspace_owner_id, platform, credentials_encrypted, account_label,
         account_currency, account_time_zone, account_created_time, sync_status, last_error)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'idle',NULL)
     ON CONFLICT (workspace_owner_id, platform)
     DO UPDATE SET
       credentials_encrypted = EXCLUDED.credentials_encrypted,
       account_label = EXCLUDED.account_label,
       account_currency = EXCLUDED.account_currency,
        account_time_zone = EXCLUDED.account_time_zone,
       account_created_time = EXCLUDED.account_created_time,
       sync_status = 'idle',
       last_error = NULL,
       updated_at = now()
     RETURNING id`,
     [ownerId, platform, encrypted, accountLabel, accountCurrency, accountTimeZone, accountCreatedTime],
  );
  const connId = upserted.rows[0].id;

  // Full-history backfill in the background; progress is visible via
  // GET /ad-platforms (sync_status/last_error).
  const conn = await loadConnection(ownerId, platform);
  if (conn && conn.id === connId) {
    void runAdPlatformSync(conn, "full");
  }

  res.status(201).json(await connectionStatusList(ownerId));
});

/** POST /ad-platforms/:platform/sync — manual "Sync now" (owner only). */
router.post("/ad-platforms/:platform/sync", async (req, res) => {
  if (!isOwner(req)) { res.status(403).json({ error: "Owner access required" }); return; }
  const platform = parsePlatform(req.params.platform);
  if (!platform) { res.status(400).json({ error: "Unknown platform" }); return; }
  const ownerId = workspace(req).workspaceOwnerId;

  const conn = await loadConnection(ownerId, platform);
  if (!conn) { res.status(404).json({ error: "Platform is not connected" }); return; }
  if (platform === "google_ads" && !isGoogleAdsWorkspaceAllowed(ownerId)) {
    res.status(403).json({ error: "Google Ads analytics is not enabled for this workspace" });
    return;
  }

  // A 'syncing' row older than 3h is a dead sync (crash/restart) — allow retry.
  const busy = await db.query(
    `SELECT 1 FROM ad_platform_connections
      WHERE id = $1 AND sync_status = 'syncing'
        AND updated_at >= now() - INTERVAL '3 hours'`,
    [conn.id],
  );
  if (busy.rowCount) {
    res.status(409).json({ error: "A sync is already running for this platform" });
    return;
  }

  // Full backfill when requested (or never completed); otherwise recent window.
  const full = req.body?.full === true;
  void runAdPlatformSync(conn, full ? "full" : "recent");
  res.status(202).json(await connectionStatusList(ownerId));
});

/** DELETE /ad-platforms/:platform — disconnect; synced spend rows are kept (owner only). */
router.delete("/ad-platforms/:platform", async (req, res) => {
  if (!isOwner(req)) { res.status(403).json({ error: "Owner access required" }); return; }
  const platform = parsePlatform(req.params.platform);
  if (!platform) { res.status(400).json({ error: "Unknown platform" }); return; }
  const ownerId = workspace(req).workspaceOwnerId;

  const result = await db.query(
    `DELETE FROM ad_platform_connections
      WHERE workspace_owner_id = $1 AND platform = $2`,
    [ownerId, platform],
  );
  if (!result.rowCount) { res.status(404).json({ error: "Platform is not connected" }); return; }
  res.json(await connectionStatusList(ownerId));
});

export default router;
