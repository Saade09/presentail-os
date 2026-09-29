/**
 * Canonical list of routes wrapped by ProtectedDashboard in App.tsx.
 *
 * This is the single source of truth used by:
 *   - the sign-out guard e2e tests (avatar-dropdown.spec.ts)
 *   - the coverage unit test (app-route-coverage.test.ts)
 *
 * Dynamic segments (e.g. :id) are represented with concrete IDs sourced
 * from the e2e seed fixture (`e2e/seed-protected-routes.ts`).
 *
 * The seed helper runs from Playwright's globalSetup, upserts a known set
 * of records (one brand, one location, one product, one base item, and
 * one customer) into the test database, and writes the resulting IDs to
 * `e2e/.protected-route-ids.json`. This module reads that file
 * synchronously at load time.
 *
 * When the file is absent (e.g. unit tests / CI without DATABASE_URL,
 * fresh checkouts before the first e2e run) every dynamic ID falls back
 * to the literal "1" so the coverage unit test and any non-DB-backed
 * caller continues to work without DB access.
 *
 * When you add a new <Route> inside <ProtectedDashboard> in App.tsx you MUST
 * also add a corresponding entry here. The unit test will fail on CI if you
 * forget.
 *
 * If the new route contains a dynamic segment (e.g. :id, :brandId), also add
 * its normalised path to DYNAMIC_PROTECTED_ROUTE_PATHS below so the e2e test
 * can assert the guard fires before any data fetch occurs.
 */

import fs from "node:fs";
import path from "node:path";

type DynamicIds = {
  brandId: string;
  locationId: string;
  productId: string;
  baseItemId: string;
  customerId: string;
  driverId: string;
  channelId: string;
  budgetId: string;
  supplierId: string;
  memberId: string;
  personId: string;
  purchaseOrderId: string;
};

const FALLBACK_IDS: DynamicIds = {
  brandId: "1",
  locationId: "1",
  productId: "1",
  baseItemId: "1",
  customerId: "1",
  driverId: "1",
  channelId: "1",
  budgetId: "1",
  supplierId: "1",
  memberId: "1",
  personId: "1",
  purchaseOrderId: "1",
};

function loadDynamicIds(): DynamicIds {
  // This module is only imported by tests (Vitest + Playwright, both Node).
  // It is not part of the Vite browser bundle, so importing node:fs/node:path
  // is safe. We still guard the read so that a missing or malformed seed
  // file falls back to the literal "1" — preserving unit-test behaviour
  // in environments without DATABASE_URL.
  try {
    // import.meta.dirname is available on Node 20.11+ and in Vitest.
    const here = import.meta.dirname;
    const filePath = path.resolve(
      here,
      "..",
      "e2e",
      ".protected-route-ids.json",
    );
    if (!fs.existsSync(filePath)) return FALLBACK_IDS;
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<DynamicIds>;
    return {
      brandId: parsed.brandId ?? FALLBACK_IDS.brandId,
      locationId: parsed.locationId ?? FALLBACK_IDS.locationId,
      productId: parsed.productId ?? FALLBACK_IDS.productId,
      baseItemId: parsed.baseItemId ?? FALLBACK_IDS.baseItemId,
      customerId: parsed.customerId ?? FALLBACK_IDS.customerId,
      driverId: parsed.driverId ?? FALLBACK_IDS.driverId,
      channelId: parsed.channelId ?? FALLBACK_IDS.channelId,
      budgetId: parsed.budgetId ?? FALLBACK_IDS.budgetId,
      supplierId: parsed.supplierId ?? FALLBACK_IDS.supplierId,
      memberId: parsed.memberId ?? FALLBACK_IDS.memberId,
      personId: parsed.personId ?? FALLBACK_IDS.personId,
      purchaseOrderId: parsed.purchaseOrderId ?? FALLBACK_IDS.purchaseOrderId,
    };
  } catch {
    return FALLBACK_IDS;
  }
}

const IDS = loadDynamicIds();

export const PROTECTED_ROUTES: readonly string[] = [
  "/analytics",
  "/store-analytics",
  "/cart-checkout-analytics",
  "/operations-analytics",
  "/customer-analytics",
  "/marketing-analytics",
  "/seo-analytics",
  "/delivery-analytics",
  "/search-discovery-analytics",
  "/inventory-cogs-analytics",
  "/marketplace-analytics",
  "/dashboard",
  "/api-keys",
  "/base-items",
  "/base-item-categories",
  "/suppliers",
  "/brand-aliases",
  "/brands",
  "/channels",
  `/channels/${IDS.channelId}`,
  "/devices",
  "/downloads",
  "/locations",
  "/cities",
  "/customers",
  "/address-book",
  "/address-book/1",
  "/address-collector",
  "/fleet",
  "/orders",
  "/florist-orders",
  "/events",
  "/review-rewards",
  "/payment-links",
  "/coupons",
  "/print-history",
  "/products",
  "/bloomprint",
  "/bloomprint/1",
  "/recipe-review",
  "/recipe-benchmarks",
  "/upsell",
  "/profile",
  "/project-manager-dashboard",
  "/ops-dashboard",
  "/roles",
  "/settings",
  "/stickers",
  "/users",
  `/users/${IDS.memberId}/profile`,
  "/people/access",
  // Nested routes with dynamic segments — guard regressions on these
  // would not be caught by the top-level entries above. Concrete IDs come
  // from the e2e seed fixture (see file-level JSDoc).
  `/locations/${IDS.locationId}`,
  `/brands/${IDS.brandId}`,
  `/products/${IDS.productId}`,
  `/base-items/${IDS.baseItemId}`,
  `/customers/${IDS.customerId}`,
  "/contacts/1",
  `/suppliers/${IDS.supplierId}`,
  `/suppliers/${IDS.supplierId}/catalog/1`,
  "/suppliers/reorder",
  `/purchase-orders/${IDS.purchaseOrderId}`,
  `/orders/1`,
  // Purchase orders
  "/purchase-orders",
  "/occasion-campaigns",
  "/audiences",
  "/audiences/1",
  // Fleet sub-routes — all wrapped in ProtectedDashboard in App.tsx.
  "/fleet/vehicle-types",
  `/fleet/drivers/${IDS.driverId}`,
  // Time-off routes — all wrapped in ProtectedDashboard in App.tsx.
  "/time-off/my",
  "/time-off/calendar",
  "/time-off/approvals",
  "/admin/time-off/policies",
  "/admin/time-off/blackout-dates",
  "/admin/public-holidays",
  // People directory — all wrapped in ProtectedDashboard in App.tsx.
  "/people",
  `/people/${IDS.personId}`,
  "/invites",
  // Admin people routes — all wrapped in ProtectedDashboard in App.tsx.
  "/admin/people/team-members",
  "/admin/people/team-members/1",
  "/admin/people/attendance",
  "/attendance/my",
  "/admin/attendance/requests",
  "/admin/attendance",
  "/admin/people/work-schedules",
  "/admin/people/attendance-settings",
  "/admin/homepage-banners",
  "/marketing-budget-planner",
  `/marketing-budget-planner/${IDS.budgetId}`,
  "/ai-invoice-import",
  "/ai-invoice-import/1/review",
  "/occasion-campaigns/occasions/new",
  "/occasion-campaigns/occasions/1",
  "/occasion-campaigns/occasions/1/edit",
  "/occasion-campaigns/plans/1",
  // Catalog attribute routes — all wrapped in ProtectedDashboard + PageGuard in App.tsx.
  "/catalog-attributes/occasions",
  "/catalog-attributes/categories",
  "/catalog-attributes/brands",
  "/catalog-attributes/recipients",
  // Tax rules — owner-only.
  "/tax-rules",
  // Webhook endpoints — owner-only.
  "/webhook-endpoints",
  // Smoke-test run history — owner-only.
  "/smoke-tests",
  // Publishing channels — owner-only.
  "/publishing-channels",
  "/publishing-channels/1",
  // Developer catalog API docs — owner-only.
  "/developer",
  // Google Business Profile post tool — owner-only.
  "/google-product-post",
  "/omnichannel/inbox",
  "/omnichannel/automations",
  "/omnichannel/automations/1",
  "/omnichannel/templates",
  "/omnichannel/analytics",
  "/omnichannel/contacts",
  "/omnichannel/contacts/1",
  "/omnichannel/audit-log",
  // Invoice scanner station management — requires Devices page access.
  "/settings/devices/scanners",
  // Messaging channel admin — owner-only.
  "/settings/channels",
  "/settings/channels/whatsapp",
  "/settings/channels/messenger",
  "/settings/channels/instagram",
  "/settings/channels/tiktok",
  // Card message print form — accessible to all workspace members.
  "/card-message",
  // Invoice history / audit trail.
  "/invoices",
  // Finance & Accounting pages.
  "/finance/accounting/monthly-closing/supplier-recon/1",
  "/finance/accounting/monthly-closing",
  "/finance/accounting/monthly-sales",
  "/finance/accounting/cash-activity",
  "/finance/accounting/journal-entries",
  "/finance/accounting/reconciliation",
  "/finance/accounting/reconciliation/review/1",
  "/finance/accounting/chart-of-accounts",
  "/finance/accounting/reports",
  // Cash desk routes — all wrapped in ProtectedDashboard in App.tsx.
  "/cash-drawers",
  "/cash-sessions",
  "/cash-sessions/new",
  "/cash-sessions/1",
  "/cash-sessions/1/close",
  "/cash-bills",
  "/cash-transfers",
  "/cash-transfers/1",
  "/cash-approvals",
  // Publish center — owner-only.
  "/publish",
  // Backlink Engine — all wrapped in ProtectedDashboard + PageGuard in App.tsx.
  "/backlink-engine",
  "/backlink-engine/opportunities",
  "/backlink-engine/competitors",
  "/backlink-engine/campaigns",
  "/backlink-engine/monitor",
  "/backlink-engine/reports",
  "/backlink-engine/settings",
  // CMC POS routes — all wrapped in ProtectedDashboard + PageGuard in App.tsx.
  "/cmc-pos",
  "/cmc-pos/monthly-sales",
  "/cmc-pos/audit",
  "/cmc-pos/location-requests",
  "/cmc-pos/sales",
  "/cmc-pos/sale",
  "/cmc-pos/request",
  "/cmc-pos/delivery",
  "/cmc-pos/new-order",
  "/cmc-pos/returns",
  "/cmc-pos/returns/history",
  "/cmc-pos/request/1",
  "/cmc-pos/cash-drawer",
];

/**
 * The subset of PROTECTED_ROUTES whose paths contain a dynamic segment.
 *
 * For these routes the e2e sign-out test wires up a Playwright network
 * interceptor that aborts — and tracks — any route-specific API call.
 * If ProtectedDashboard is working correctly the guard redirects the
 * unauthenticated user to /sign-in *before* the page component renders,
 * so no route-specific fetch should ever be attempted.
 *
 * IDs come from the e2e seed fixture; when the seed file is absent the
 * IDs fall back to the literal "1" (see file-level JSDoc).
 *
 * Keep this set in sync with the dynamic-segment entries in PROTECTED_ROUTES.
 * The first path segment after "/" is used to derive the resource name for
 * the API intercept pattern (e.g. "/brands/123" uses the resource "brands").
 */
export const DYNAMIC_PROTECTED_ROUTE_PATHS: ReadonlySet<string> = new Set([
  `/locations/${IDS.locationId}`,
  `/brands/${IDS.brandId}`,
  `/products/${IDS.productId}`,
  `/bloomprint/1`,
  `/base-items/${IDS.baseItemId}`,
  `/customers/${IDS.customerId}`,
  "/contacts/1",
  `/suppliers/${IDS.supplierId}`,
  `/suppliers/${IDS.supplierId}/catalog/1`,
  `/fleet/drivers/${IDS.driverId}`,
  `/channels/${IDS.channelId}`,
  `/orders/1`,
  `/marketing-budget-planner/${IDS.budgetId}`,
  `/users/${IDS.memberId}/profile`,
  `/omnichannel/automations/1`,
  `/omnichannel/contacts/1`,
  `/people/${IDS.personId}`,
  `/purchase-orders/${IDS.purchaseOrderId}`,
  `/occasion-campaigns/occasions/1`,
  `/occasion-campaigns/occasions/1/edit`,
  `/occasion-campaigns/plans/1`,
  "/audiences/1",
  `/publishing-channels/1`,
  `/admin/people/team-members/1`,
  `/cash-sessions/1`,
  `/cash-sessions/1/close`,
  `/address-book/1`,
  `/cash-transfers/1`,
  "/finance/accounting/monthly-closing/supplier-recon/1",
  "/finance/accounting/reconciliation/review/1",
  `/cmc-pos/request/1`,
  "/ai-invoice-import/1/review",
]);
