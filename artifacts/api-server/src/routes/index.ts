import { Router, type IRouter } from "express";
import purchaseOrdersPublicRouter from "./purchaseOrdersPublic";
import addressCollectionPublicRouter from "./addressCollection";
import respondioIncomingRouter from "./respondioIncoming";
import respondioAiOrdersRouter from "./respondioAiOrders";
import addressCollectorRouter from "./addressCollector";
import healthRouter from "./health";
import downloadRouter from "./download";
import apiKeysRouter from "./apiKeys";
import devicesRouter from "./devices";
import printJobsRouter from "./printJobs";
import downloadsHistoryRouter from "./downloads-history";
import agentRouter from "./agent";
import jobsRouter from "./jobs";
import usersRouter from "./users";
import stickersRouter from "./stickers";
import brandStickerSheetsRouter from "./brandStickerSheets";
import analyticsRouter from "./analytics";
import revenueOverviewRouter from "./revenueOverview";
import totersImportsRouter from "./totersImports";
import storeAnalyticsRouter from "./storeAnalytics";
import deliveryAnalyticsRouter from "./deliveryAnalytics";
import settingsRouter from "./settings";
import locationsRouter from "./locations";
import brandsRouter from "./brands";
import rolesRouter from "./roles";
import requestAccessRouter from "./requestAccess";
import accessRequestsRouter from "./accessRequests";
import profileRouter from "./profile";
import inviteRouter from "./invite";
import testHelpersRouter from "./testHelpers";
import storageRouter from "./storage";
import productsRouter from "./products";
import recipeBenchmarksRouter from "./recipeBenchmarks";
import recipeSuggestionsRouter from "./recipeSuggestions";
import bloomprintRouter from "./bloomprint";
import manageEventsRouter from "./manageEvents";
import paymentLinksRouter from "./paymentLinks";
import weeklyDigestRouter from "./weeklyDigest";
import payRouter from "./pay";
import tookanWebhookRouter from "./tookanWebhook";
import channelsRouter from "./channels";
import channelDetailRouter from "./channelDetail";
import dashboardRouter from "./dashboard";
import baseItemCategoriesRouter from "./baseItemCategories";
import baseItemsRouter from "./baseItems";
import recipeConsumptionExceptionsRouter from "./recipeConsumptionExceptions";
import suppliersRouter from "./suppliers";
import supplierStatementCollectionRouter from "./supplierStatementCollection";
import cashDrawersRouter from "./cashDrawers";
import cashSessionsRouter from "./cashSessions";
import cashTransfersRouter from "./cashTransfers";
import cashActivityRouter from "./cashActivity";
import v1Router from "./v1";
import notificationsRouter from "./notifications";
import timeOffRouter from "./timeOff";
import teamMembersRouter from "./teamMembers";
import peopleRouter from "./people";
import workSchedulesRouter from "./workSchedules";
import attendanceSettingsRouter from "./attendanceSettings";
import attendanceRouter from "./attendance";
import attendanceMobileRouter from "./attendanceMobile";
import attendanceAdminRouter from "./attendanceAdmin";
import blackoutDatesRouter from "./blackoutDates";
import fleetRouter from "./fleet";
import citiesRouter from "./cities";
import deliverySchedulingRouter, { deliveryAvailabilityRouter } from "./deliveryScheduling";
import publicLocationsRouter from "./publicLocations";
import publicCurrencyRatesRouter from "./publicCurrencyRates";
import publicCatalogRouter from "./publicCatalog";
import workspaceImageTokenRouter from "./workspaceImageToken";
import {
  adminRouter as settingsDeliveryAdminRouter,
  publicRouter as settingsDeliveryPublicRouter,
} from "./settings-delivery";
import homepageBannersRouter from "./homepageBanners";
import customersRouter from "./customers"; // kept for omnichannel contacts compatibility
import contactsDashboardRouter from "./contactsDashboard";
import contactsWizardRouter from "./contactsWizard";
import countryFlagsRouter from "./countryFlags";
import authUserTypeRouter from "./authUserType";
import exchangeRatesRouter from "./exchangeRates";
import budgetRouter from "./budget";
import devEmailPreviewRouter from "./devEmailPreview";
import financeRouter from "./finance";
import workshopSalesRouter from "./workshopSales";
import cmcPosRouter from "./cmcPos";
import catalogAttributesRouter from "./catalogAttributes";
import catalogAttributesPublicRouter from "./catalogAttributesPublic";
import webhookEndpointsRouter from "./webhookEndpoints";
import publishRouter from "./publish";
import securityRouter from "./security";
import clerkWebhookRouter from "./clerkWebhook";
import resendWebhookRouter from "./resendWebhook";
import orderCommunicationsRouter from "./orderCommunications";
import omnichannelWebhookRouter from "../modules/omnichannel/webhooks/webhookRouter";
import omnichannelConversationsRouter from "../modules/omnichannel/routes/conversationsRouter";
import omnichannelChannelsRouter from "../modules/omnichannel/routes/channelsRouter";
import omnichannelFlowsRouter from "../modules/omnichannel/routes/flowsRouter";
import omnichannelAiRouter from "../modules/omnichannel/routes/aiRouter";
import omnichannelKnowledgeBaseRouter from "../modules/omnichannel/routes/knowledgeBaseRouter";
import omnichannelSseRouter from "../modules/omnichannel/routes/sseRouter";
import omnichannelAnalyticsRouter from "../modules/omnichannel/routes/analyticsRouter";
import omnichannelContactsRouter from "../modules/omnichannel/routes/contactsRouter";
import omnichannelAuditLogRouter from "../modules/omnichannel/routes/auditLogRouter";
import marketplaceWebhookRouter from "./marketplaceWebhook";
import marketplaceEmailInboundRouter from "./marketplaceEmailInbound";
import supplierEmailInboundRouter from "./supplierEmailInbound";
import marketplaceReportsRouter from "./marketplaceReports";
import occasionCampaignsRouter from "./occasionCampaigns";
import purchaseOrdersRouter from "./purchaseOrders";
import ordersRouter from "./orders";
import floristOrdersRouter from "./floristOrders";
import catalogV1Router from "./catalogV1";
import publishingChannelsRouter from "./publishingChannels";
import googleProductPostRouter from "./googleProductPost";
import smokeTestRunsRouter from "./smokeTestRuns";
import ingestKeyRouter from "./ingestKey";
import deliverySettingsRouter from "./deliverySettings";
import eventsRouter from "./events";
import webPushRouter from "./webPush";
import taxRulesRouter from "./taxRules";
import deliveryCatalogRouter from "./deliveryCatalog";
import deliveryLocationsRouter from "./deliveryLocations";
import externalProductsRouter from "./externalProducts";
import addressBookPublicRouter from "./addressBookPublic";
import externalOrdersRouter from "./externalOrders";
import couponsValidateRouter from "./couponsValidate";
import couponsRouter from "./coupons";
import importTotersRouter from "./importToters";
import cardMessageRouter from "./cardMessage";
import invoicesRouter from "./invoices";
import trustpilotAdminRouter from "./trustpilotAdmin";
import webEventsRouter from "./webEvents";
import webEventsTrackerRouter from "./webEventsTracker";
import marketingDataRouter from "./marketingData";
import adPlatformsRouter from "./adPlatforms";
import searchConsoleRouter from "./searchConsole";
import accountingRouter from "./accounting";
import mobileAuthRouter from "./mobileAuth";
import backlinkEngineRouter from "./backlinkEngine";
import inventoryAnalyticsRouter from "./inventoryAnalytics";
import addressBookRouter from "./addressBook";
import reviewRewardsRouter from "./reviewRewards";
import { apiKeyReadAuth } from "../lib/apiKeyAuth";
import scannerRouter from "./scanner";
import audiencesRouter from "./audiences";
import gbpReviewsRouter, { gbpPubSubRouter } from "./gbpReviews";
import recipeIntelligenceRouter from "./recipeIntelligence";
import lbBankReconRouter from "./lbBankRecon";
import productGalleryRouter from "./productGallery";
import realDeliveriesRouter from "./realDeliveries";

const router: IRouter = Router();

// Mobile app auth — public, no Clerk session required.
router.use(mobileAuthRouter);
// Agent + Jobs endpoints use API-key (Bearer) auth — must be mounted BEFORE
// the routers below that apply requireAuth (Clerk session) to all sub-paths.
router.use(agentRouter);
router.use(jobsRouter);
// Scanner station routes — mix of owner-only (Clerk auth inside router) and
// scanner-device bearer token auth; must come before requireAuth-gated routers.
router.use(scannerRouter);
// Test-only helper routes (no auth required, disabled in production).
router.use(testHelpersRouter);
// Dev-only email preview routes (no auth required, disabled in production).
router.use(devEmailPreviewRouter);
// Clerk webhook — no auth required; verified by svix signature.
router.use(clerkWebhookRouter);
// Resend email delivery webhook — no auth required; verified by svix signature.
router.use(resendWebhookRouter);
// Omnichannel inbound webhooks — no auth required; verified per-provider.
// Must come before any router that applies requireAuth to all sub-paths.
router.use(omnichannelWebhookRouter);
// Request access: Clerk-auth only, no resolveWorkspace.
// Invite: GET /invite/:token is public; POST /invite/claim requires Clerk auth only.
// Public pay and webhook routes: no auth required — must come before workspace-gated routers.
// Both must come before workspace-gated routers.
router.use(v1Router);
router.use(payRouter);
// Tookan task-status webhook — no auth; validated by TOOKAN_WEBHOOK_SECRET.
// Marks the matching OS order completed when a delivery succeeds in Tookan.
// Must come before workspace-gated routers.
router.use(tookanWebhookRouter);
// Google Business Profile Pub/Sub push webhook — no Clerk auth; verified by
// the GBP_PUBSUB_PUSH_TOKEN shared token in the push endpoint URL.
// Must come before workspace-gated routers.
router.use(gbpPubSubRouter);
// Public PO acceptance routes — unauthenticated, must come before requireAuth.
router.use(purchaseOrdersPublicRouter);
// Public address-collection recipient routes + respond.io status webhook —
// token-secured, no auth; must come before workspace-gated routers.
router.use(addressCollectionPublicRouter);
router.use(respondioIncomingRouter);
// Respond.io AI Agent HTTP actions use their own bearer secret and must be
// mounted before Clerk-gated order routes.
router.use(respondioAiOrdersRouter);
// Public, unauthenticated read-only endpoints — must come before requireAuth routers.
// publicCatalogRouter serves: /public/catalog/products, /public/catalog/base-items,
// /public/catalog/brands, /public/catalog/banners, /public/catalog/occasions,
// /public/catalog/categories, /public/catalog/events, /public/catalog/places
// /public/catalog/customers (API-key protected).
router.use(publicLocationsRouter);
router.use(publicCurrencyRatesRouter);
router.use(publicCatalogRouter);
router.use(settingsDeliveryPublicRouter);
router.use(catalogAttributesPublicRouter);
// Delivery catalog — API-key or ?workspace=slug authenticated read-only endpoint.
// Must come before requireAuth routers.
router.use(deliveryCatalogRouter);
// Delivery locations ext — camelCase shape at /delivery-locations-ext; avoids conflict
// with existing /delivery-locations (settings-delivery). API-key or ?workspace=slug.
// Must come before requireAuth routers.
router.use(deliveryLocationsRouter);
// External products — API-key authenticated GET /products (camelCase shape).
// Calls next() when no API key present so the Clerk-auth internal route handles it.
// Must come before requireAuth routers.
router.use(externalProductsRouter);
// Address Book public landmark search — API-key authenticated GET /address-book/places/search.
// Returns a lightweight camelCase suggestion shape for storefronts. Uses
// resolveApiKeyWorkspace directly (no Clerk session needed). Must come before
// apiKeyReadAuth and the Clerk-gated addressBookRouter below.
router.use(addressBookPublicRouter);
// External order ingest — API-key authenticated POST /orders endpoint.
// Must come before any router that applies requireAuth to all sub-paths.
router.use(externalOrdersRouter);
// Coupon storefront routes — API-key authenticated POST /coupons/validate and
// GET /coupons (external rules list; falls through to the Clerk dashboard route
// when no API key is present). Must come before apiKeyReadAuth and any router
// that applies requireAuth to all sub-paths.
router.use(couponsValidateRouter);
// Toters order import — API-key authenticated POST /orders/import-toters.
// Must come before any router that applies requireAuth to all sub-paths.
router.use(importTotersRouter);
// Website behavioral event ingestion — API-key authenticated POST /web-events.
// Must come before any router that applies requireAuth to all sub-paths.
router.use(webEventsRouter);
// Public drop-in storefront analytics tracker script (no auth, no secrets).
router.use(webEventsTrackerRouter);
// Website real-deliveries feed is explicitly API-key authenticated.
router.use(realDeliveriesRouter);
// Workspace API-key READ access — grants a valid pk_live_ key read access to
// every workspace-gated endpoint below. For GET/HEAD only, it resolves the key
// to its workspace owner and populates the request identity so the downstream
// requireAuth/resolveWorkspace grant owner-level context (no Clerk session
// needed). Never rejects and never grants write access; mutating methods fall
// through to Clerk-only auth. Mounted AFTER the dedicated API-key routers above
// (external products/orders, delivery catalog/locations) so they keep handling
// their own shapes, and BEFORE every requireAuth-gated router below.
router.use(apiKeyReadAuth);
// Delivery availability — public endpoint (auth optional, workspace param fallback).
router.use(deliveryAvailabilityRouter);
// Workspace image token issuance — requires Clerk auth, issues the HMAC cookie
// consumed by publicImagesRouter above.
router.use(workspaceImageTokenRouter);
// Homepage banners router exposes a public /storefront endpoint with no auth,
// alongside admin endpoints that apply requireAuth + resolveWorkspace per route.
// Mount it before the workspace-gated bulk routers below.
router.use(homepageBannersRouter);
router.use(requestAccessRouter);
router.use(inviteRouter);
router.use(healthRouter);
router.use(downloadRouter);
router.use(apiKeysRouter);
router.use(devicesRouter);
router.use(printJobsRouter);
router.use(downloadsHistoryRouter);
router.use(usersRouter);
router.use(stickersRouter);
router.use(brandStickerSheetsRouter);
router.use(analyticsRouter);
router.use(revenueOverviewRouter);
router.use(totersImportsRouter);
router.use(storeAnalyticsRouter);
router.use(deliveryAnalyticsRouter);
router.use(settingsRouter);
router.use(settingsDeliveryAdminRouter);
router.use(locationsRouter);
router.use(brandsRouter);
router.use(rolesRouter);
router.use(accessRequestsRouter);
router.use(notificationsRouter);
router.use(profileRouter);
router.use(storageRouter);
// Benchmark paths are more specific than /products/:id and must precede the
// general products router.
router.use(recipeBenchmarksRouter);
router.use(recipeSuggestionsRouter);
  router.use(bloomprintRouter);
router.use(productsRouter);
router.use(productGalleryRouter);
router.use(recipeIntelligenceRouter);
router.use(manageEventsRouter);
router.use(couponsRouter);
router.use(paymentLinksRouter);
router.use(weeklyDigestRouter);
router.use(channelsRouter);
router.use(channelDetailRouter);
router.use(baseItemCategoriesRouter);
router.use(baseItemsRouter);
router.use(recipeConsumptionExceptionsRouter);
router.use(supplierStatementCollectionRouter);
router.use(suppliersRouter);
router.use(cashDrawersRouter);
router.use(cashSessionsRouter);
router.use(cashTransfersRouter);
router.use(cashActivityRouter);
router.use(purchaseOrdersRouter);
router.use(timeOffRouter);
router.use(teamMembersRouter);
router.use(peopleRouter);
router.use(workSchedulesRouter);
router.use(attendanceSettingsRouter);
// Mobile attendance routes first so specific paths (/attendance/today,
// /attendance/my-timesheets, etc.) take precedence over legacy catch-all
// /attendance/:id in attendanceRouter.
router.use(attendanceMobileRouter);
router.use(attendanceRouter);
router.use(attendanceAdminRouter);
router.use(blackoutDatesRouter);
router.use(fleetRouter);
router.use(citiesRouter);
router.use(deliverySchedulingRouter);
router.use(customersRouter);
// Wizard contact search/dup-check/create must be mounted BEFORE the dashboard
// contacts router so `/contacts/wizard-*` isn't swallowed by `GET /contacts/:id`.
router.use(contactsWizardRouter);
router.use(contactsDashboardRouter);
// Audiences — marketing segmentation over contacts (Clerk auth + resolveWorkspace).
router.use(audiencesRouter);
router.use(financeRouter);
router.use(workshopSalesRouter);
router.use(countryFlagsRouter);
router.use(authUserTypeRouter);
router.use(exchangeRatesRouter);
router.use(dashboardRouter);
router.use(budgetRouter);
router.use(catalogAttributesRouter);
router.use(webhookEndpointsRouter);
router.use(publishRouter);
router.use(securityRouter);
router.use(omnichannelConversationsRouter);
router.use(omnichannelChannelsRouter);
router.use(omnichannelFlowsRouter);
router.use(omnichannelAiRouter);
router.use(omnichannelKnowledgeBaseRouter);
router.use(omnichannelSseRouter);
router.use(omnichannelAnalyticsRouter);
router.use(omnichannelContactsRouter);
router.use(omnichannelAuditLogRouter);
// Marketplace webhook — no auth required; validated by shared secret.
// Must come before the workspace-gated marketplaceReportsRouter.
router.use(marketplaceWebhookRouter);
// Marketplace email inbound — no auth required; validated by shared secret.
// Accepts Postmark inbound email JSON payloads with PDF attachments.
router.use(marketplaceEmailInboundRouter);
// Supplier email inbound — no auth required; validated by SUPPLIER_WEBHOOK_SECRET.
// Routes supplier replies (with PDF attachments) to matching Purchase Orders.
router.use(supplierEmailInboundRouter);
router.use(marketplaceReportsRouter);
router.use(occasionCampaignsRouter);
router.use(ordersRouter);
router.use(orderCommunicationsRouter);
// Florist Orders workflow — Clerk auth + resolveWorkspace, florist_orders page.
router.use(floristOrdersRouter);
// Catalog v1 public API — uses catalog API key auth (not Clerk sessions).
// Must come before publishingChannelsRouter so /catalog/v1/* are matched first.
router.use(catalogV1Router);
// Publishing channels admin routes — uses Clerk auth + resolveWorkspace.
router.use(publishingChannelsRouter);
// Google Business Profile product post — owner-only, Clerk auth + resolveWorkspace.
router.use(googleProductPostRouter);
// Smoke-test run history — POST uses shared-secret auth (script use); GET is owner-only.
router.use(smokeTestRunsRouter);
// Ingest key management — owner-only, Clerk auth + resolveWorkspace.
router.use(ingestKeyRouter);
// Delivery settings — global per-workspace configuration (GET public, PATCH owner-only).
router.use(deliverySettingsRouter);
// Tax rules — workspace-level location-based tax rates (owner-only CRUD).
router.use(taxRulesRouter);
// Card message print — Clerk auth + resolveWorkspace; proxies to Make.com webhook.
router.use(cardMessageRouter);
// Invoice history — list, CSV export, and PDF re-download (Clerk auth + resolveWorkspace).
router.use(invoicesRouter);
// Trustpilot admin tools — owner-only; test-fire builds/inspects invitation payload.
router.use(trustpilotAdminRouter);
// Marketing data — owner-managed ad spend + SEO metrics (Clerk auth + resolveWorkspace).
router.use(marketingDataRouter);
router.use(adPlatformsRouter);
// Search Console OAuth + sync (Clerk auth + resolveWorkspace, owner-only).
router.use(searchConsoleRouter);
// SSE events stream — real-time workspace event broadcast.
router.use(eventsRouter);
// Web Push (VAPID) subscriptions — browser new-order notifications.
router.use(webPushRouter);
// Finance & Accounting — monthly close, journal entries, reconciliation.
router.use(accountingRouter);
// Backlink Engine — competitor tracking, opportunities, outreach campaigns, link monitor.
router.use(backlinkEngineRouter);
// CMC POS — CMC Beirut Hospital customer service agent POS module.
router.use(cmcPosRouter);
// Inventory & Cost Analytics — Clerk auth + resolveWorkspace; reporting + wastage record creation.
router.use(inventoryAnalyticsRouter);
// Address Book — places, aliases, contact addresses, order links, fleet lean endpoint.
router.use(addressBookRouter);
router.use(addressCollectorRouter);
// Google Review Rewards — employee QR profiles, match resolution, rewards, metrics.
// (The public scan redirect /reviews/e/:code is mounted at the app level in app.ts.)
router.use(reviewRewardsRouter);
// Google Business Profile connection for Review Rewards — owner-only OAuth
// (business.manage), location selection, notifications subscription status.
router.use(gbpReviewsRouter);
// Lebanon bank reconciliation — finance_accounting role, Lebanon entity guard.
router.use(lbBankReconRouter);

export default router;
