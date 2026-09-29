import "./lib/clerkSecretOverride";
import app from "./app";
import { logger } from "./lib/logger";
import { initDb } from "./lib/initDb";
import { startOfflineAlertJob } from "./lib/offlineAlertJob";
import { startPaymentLinkCleanupJob } from "./lib/paymentLinkCleanupJob";
import { startExchangeRateJob, checkStaleExchangeRates } from "./lib/exchangeRateJob";
import { startPrintJobCleanupJob } from "./lib/printJobCleanupJob";
import { validateMaxPaymentAmountEnv } from "./routes/paymentLinks";
import { ensureMamoWebhook, warnMamoEnvVars } from "./lib/mamoWebhook";
import { loadAdapterRegistry } from "./modules/omnichannel/adapters/adapterRegistry";
import { startOutboundQueueWorker } from "./modules/omnichannel/queue/outboundQueue";
import { startMessageNotRespondedJob } from "./modules/omnichannel/automation/messageNotRespondedJob";
import { startDelayResumeJob } from "./modules/omnichannel/automation/delayResumeJob";
import { startMissedClockOutJob } from "./lib/missedClockOutJob";
import { startStockAlertDismissalCleanupJob } from "./lib/stockAlertDismissalCleanupJob";
import { startWeeklyDigestJob } from "./lib/weeklyDigestJob";
import { startTookanStatusPollJob } from "./lib/tookanStatusPollJob";
import { startAddressCollectorWorker } from "./lib/addressCollector/worker";
import { startTrustpilotInvitationJob } from "./lib/trustpilotInvitations";
import { startDeliveredWhatsappJob } from "./lib/deliveredWhatsappJob";
import { logTrustpilotStartupStatus } from "./lib/trustpilot";
import { startAdPlatformSyncJob } from "./lib/adPlatformSyncJob";
import { startSearchConsoleSyncJob } from "./lib/searchConsoleSyncJob";
import { backfillOccasionPublicImages } from "./lib/backfillOccasionPublicImages";
import { backfillProductPublicImages } from "./lib/productPublicImages";
import { backfillBaseItemPublicImages } from "./lib/baseItemPublicImages";
import {
  backfillPaidCurrencyAmounts,
  repairStripePaidAmounts,
  repairMislabeledPaidPairs,
} from "./lib/backfillPaidCurrency";
import { backfillLineItemProducts } from "./lib/backfillLineItemProducts";
import { backfillRespondioContactIds } from "./lib/backfillRespondioContactIds";
import { checkWhatsAppTemplateImages } from "./lib/checkWhatsAppTemplateImages";
import { startCashSessionPoller } from "./lib/cashSessionPoller";
import { startGenderBackfillJob } from "./lib/genderInference";
import { startBacklinkDiscoveryJob } from "./lib/backlinkDiscoveryJob";
import { startBacklinkOutreachJob } from "./lib/backlinkOutreachJob";
import { startBacklinkMonitorJob } from "./lib/backlinkMonitorJob";
import { startCmcMonthlyReportJob } from "./lib/cmcMonthlyReportJob";
import { startMerchantSyncJob } from "./lib/merchantSyncJob";
import { startReviewRewardJob } from "./lib/reviewRewardJob";
import { startAudienceRefreshJob } from "./lib/audienceRefreshJob";
import { startGbpReconciliationJob } from "./lib/gbpReconciliationJob";
import { startAddressReverificationJob } from "./lib/addressReverificationJob";
import { db } from "./lib/db";
import { logGbpOauthStartupStatus } from "./lib/googleBusinessProfile";
import { startOrderRescheduleWorker } from "./routes/orders";
import type { Server } from "node:http";
import { startProductGalleryWorker } from "./lib/productGallery";
import { logStartupTiming } from "./lib/startupTiming";
import { startDataRetentionJob } from "./lib/dataRetentionJob";
import { startPaymentLinkConversionJob } from "./lib/paymentLinkConversions";
import { startRealDeliveryPublicationWorker } from "./lib/realDeliveryPublication";
import { startSupplierStatementWorker } from "./lib/supplierStatementWorker";
import {
  markDatabaseReady,
  markDatabaseStarting,
} from "./lib/startupReadiness";
import { assertMutationDatabaseReady } from "./lib/mutationDatabaseReadiness";

const rawPort = process.env["PORT"];
const processStartedAt =
  (globalThis as typeof globalThis & {
    __PRESENTAIL_API_PROCESS_STARTED_AT__?: number;
  }).__PRESENTAIL_API_PROCESS_STARTED_AT__ ?? Date.now();

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

validateMaxPaymentAmountEnv();
warnMamoEnvVars();
logTrustpilotStartupStatus();
logGbpOauthStartupStatus();

// Start listening immediately so the deployment's port health check passes,
// while startupReadinessGate keeps API traffic out until initDb is complete.
markDatabaseStarting();
const preboundServer = (
  globalThis as typeof globalThis & {
    __PRESENTAIL_API_HTTP_SERVER__?: Server;
  }
).__PRESENTAIL_API_HTTP_SERVER__;

if (process.env.NODE_ENV === "production" && !preboundServer) {
  throw new Error(
    "Production API must start through production-entry.cjs; direct bundle startup is not allowed.",
  );
}

if (preboundServer) {
  logger.info({ port }, "Using prebound production HTTP server");
} else {
    const portBindingStartedAt = Date.now();
    logStartupTiming("port_binding", "start", portBindingStartedAt, { port });
  const server = app.listen(port, "0.0.0.0", () => {
      logStartupTiming("port_binding", "complete", portBindingStartedAt, {
        port,
        status: "success",
      });
    logger.info({ port }, "Server listening");
  });
  server.on("error", (err) => {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  });
}

export { app };

initDb()
  .then(async () => {
    await assertMutationDatabaseReady();
    markDatabaseReady();
    logger.info(
      { since_process_start_ms: Date.now() - processStartedAt },
      "Database ready; API traffic enabled",
    );
    // The API can accept gallery runs as soon as the schema is ready. Start
    // its consumer before any unrelated post-database work can delay it.
    startProductGalleryWorker();
    startRealDeliveryPublicationWorker();
    try {
    startOfflineAlertJob();
    startPaymentLinkCleanupJob();
    startPrintJobCleanupJob();
    await checkStaleExchangeRates();
    startExchangeRateJob();
    // Mamo registration is optional startup work. Keep an unexpected logger
    // or runtime failure from becoming an unhandled rejection that can affect
    // unrelated API startup/mutations.
    void ensureMamoWebhook().catch((err) => {
      logger.warn({ err }, "Mamo webhook auto-registration failed; continuing startup");
    });
    await loadAdapterRegistry();
    startOutboundQueueWorker();
    startMessageNotRespondedJob();
    startDelayResumeJob();
    startMissedClockOutJob();
    startStockAlertDismissalCleanupJob();
    startWeeklyDigestJob();
    startTookanStatusPollJob();
    startAddressCollectorWorker();
    // One-time idempotent respond.io backfill — safe to re-run on every boot;
    // no-ops when respond.io is not configured or all contacts are synced.
    void backfillRespondioContactIds();
    // Non-blocking startup probe: confirms each WhatsApp template header image
    // is publicly reachable so missing uploads are caught before orders arrive.
    void checkWhatsAppTemplateImages();
    startTrustpilotInvitationJob();
    startDeliveredWhatsappJob();
    startAdPlatformSyncJob();
    startSearchConsoleSyncJob();
    startCashSessionPoller();
    startAudienceRefreshJob();
    startGenderBackfillJob();
    startBacklinkDiscoveryJob();
    startBacklinkOutreachJob();
    startBacklinkMonitorJob();
    startCmcMonthlyReportJob();
    startMerchantSyncJob();
    startReviewRewardJob();
    startGbpReconciliationJob();
    startAddressReverificationJob();
    startOrderRescheduleWorker();
    startSupplierStatementWorker();
    startDataRetentionJob();
    startPaymentLinkConversionJob();
    void backfillOccasionPublicImages();
    void backfillProductPublicImages();
    void backfillBaseItemPublicImages();
    void backfillPaidCurrencyAmounts()
      .then(() => repairStripePaidAmounts())
      .then(() => repairMislabeledPaidPairs());
    void backfillLineItemProducts();
    // Clear stale "GBP_PUBSUB_TOPIC is not configured" errors that were
    // incorrectly written as blocking errors. Push notifications are optional;
    // locations should show "Connected" when reviews sync via polling.
    void (async () => {
      const staleMsg =
        "GBP_PUBSUB_TOPIC is not configured; notifications not subscribed. Set the secret and re-select the location.";
      await db.query(
        `UPDATE gbp_location_connections SET last_error = NULL, updated_at = now()
          WHERE last_error = $1`,
        [staleMsg],
      ).catch(() => {});
      await db.query(
        `UPDATE gbp_connections SET last_error = NULL, updated_at = now()
          WHERE last_error = $1`,
        [staleMsg],
      ).catch(() => {});
    })();
    logger.info("Startup complete");
    logStartupTiming("application_readiness", "complete", undefined, {
      status: "ready",
      since_process_start_ms: Date.now() - processStartedAt,
    });
    } catch (error) {
      logger.error(
        { err: error },
        "POST-DATABASE STARTUP FAILED: an unrelated startup job failed; product gallery worker remains active.",
      );
    }
  })
  .catch((err: unknown) => {
    logger.error(
      {
        err,
        errorMessage: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      },
      "STARTUP FAILED: initDb threw an error — the API is running but the database is unavailable. Check deployment logs for the full error details.",
    );
    process.exit(1);
  });
