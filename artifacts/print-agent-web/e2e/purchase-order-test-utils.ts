/**
 * Shared route-setup helpers for Purchase Order e2e tests.
 *
 * Playwright's route handler stack uses LIFO ordering: the *last* registered
 * handler that matches a URL is tried first.  The helpers below encode the
 * correct registration order so callers cannot accidentally introduce the
 * "catch-all wins over specific route" bug:
 *
 *   1.  Register the catch-all `**\/api\/**` FIRST  ← lowest priority (LIFO)
 *   2.  Register broad routes next  (e.g. /api/purchase-orders)
 *   3.  Register specific sub-routes LAST  ← highest priority (LIFO)
 *
 * Adding a new route to a test?  Register it *after* calling one of the
 * helpers here so the more-specific handler takes priority over the catch-all.
 */

import type { Page } from "@playwright/test";

// ─── Shared constants ─────────────────────────────────────────────────────────

export const OWNER_EMAIL = "e2e-tester@presentail.com";

export function ownerUsersResponse(email = OWNER_EMAIL) {
  return {
    members: [
      {
        id: 1,
        email,
        role: "owner",
        custom_role_id: null,
        role_name: null,
        joined: true,
        joined_at: new Date().toISOString(),
        invited_at: new Date().toISOString(),
        invited_by_email: null,
        manager_member_id: null,
        manager_email: null,
      },
    ],
    me: {
      role: "owner",
      email,
      allowedPages: null,
      customRoleId: null,
    },
  };
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type CommonRouteOptions = {
  /** Override the list of suppliers returned by GET /api/suppliers.  Defaults to []. */
  suppliers?: object[];
  /** Override the list of locations returned by GET /api/locations.  Defaults to []. */
  locations?: object[];
};

export type PurchaseOrderRouteOptions = CommonRouteOptions & {
  /** The numeric PO id used to build /api/purchase-orders/:id routes. */
  poId: number;
  /**
   * Initial purchase-order object returned by GET /api/purchase-orders/:id.
   * Provide a getter function to simulate dynamic state changes (e.g. after a
   * receive mutation the status should flip from "partial" to "received").
   */
  getPo: object | (() => object);
  /**
   * Initial line-item array returned by GET /api/purchase-orders/:id/line-items.
   * Provide a getter function to return a snapshot at call time.
   */
  getLineItems?: object[] | (() => object[]);
  /**
   * Optional handler called when POST /api/purchase-orders/:id/receive arrives.
   * Receives the parsed request body and must return the JSON response object.
   * If omitted a minimal success envelope is returned.
   */
  onReceive?: (body: Record<string, unknown>) => object;
};

export type SetupResult = {
  /** How many times POST /api/purchase-orders/:id/receive was called. */
  getReceivePostCount: () => number;
  /** The most recent parsed body sent to the receive endpoint. */
  getLastReceiveBody: () => Record<string, unknown> | null;
  /** How many times GET /api/purchase-orders/:id/line-items was called. */
  getLineItemsCallCount: () => number;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Registers the shared "infrastructure" routes required by every PO page:
 * catch-all fallback, failed-access-requests, users, access-requests,
 * and optionally suppliers and locations.
 *
 * The catch-all is registered FIRST (lowest LIFO priority) so any route
 * registered *after* this call automatically takes precedence over it.
 */
export async function setupCommonPurchaseOrderRoutes(
  page: Page,
  opts: CommonRouteOptions = {},
): Promise<void> {
  const { suppliers = [], locations = [] } = opts;

  // ── Step 1: catch-all — registered FIRST so it has lowest priority (LIFO) ──
  await page.route("**/api/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({}),
    }),
  );

  // ── Step 2: broad shared routes — registered after the catch-all so they
  //    win over it.  Order within this block matters too: more-specific
  //    patterns are registered later so they take priority over less-specific
  //    ones.  E.g. /users/failed-access-requests must be registered AFTER
  //    /users** so the specific path wins.  ────────────────────────────────────

  await page.route("**/api/users**", async (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(ownerUsersResponse()),
      });
    }
    await route.continue();
  });

  // More specific than /users** — registered after so LIFO gives it priority
  await page.route("**/api/users/failed-access-requests**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ failedRequests: [] }),
    }),
  );

  await page.route("**/api/access-requests**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ requests: [] }),
    }),
  );

  if (suppliers.length > 0 || opts.suppliers !== undefined) {
    await page.route(/\/api\/suppliers(\?.*)?$/, async (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ suppliers }),
        });
      }
      await route.continue();
    });
  }

  if (locations.length > 0 || opts.locations !== undefined) {
    await page.route(/\/api\/locations(\?.*)?$/, async (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ locations }),
        });
      }
      await route.continue();
    });
  }
}

/**
 * Full purchase-order route setup: calls `setupCommonPurchaseOrderRoutes` then
 * registers all PO-specific routes in the correct LIFO order.
 *
 * Registration order (broad → specific, so specific wins under LIFO):
 *   1. catch-all + shared infrastructure  (via setupCommonPurchaseOrderRoutes)
 *   2. PO list   /api/purchase-orders
 *   3. PO detail /api/purchase-orders/:id
 *   4. Line-items /api/purchase-orders/:id/line-items  (registered after detail)
 *   5. Receive   /api/purchase-orders/:id/receive      (registered last = highest priority)
 *
 * Returns counters and body accessors for the receive endpoint so tests can
 * assert on submission behaviour without repeating the tracking boilerplate.
 */
export async function setupPurchaseOrderRoutes(
  page: Page,
  options: PurchaseOrderRouteOptions,
): Promise<SetupResult> {
  const {
    poId,
    getPo,
    getLineItems = [],
    onReceive,
    suppliers,
    locations,
  } = options;

  let receivePostCount = 0;
  let lastReceiveBody: Record<string, unknown> | null = null;
  let lineItemsCallCount = 0;

  // ── Step 1: common infrastructure (catch-all registered first inside here) ──
  await setupCommonPurchaseOrderRoutes(page, { suppliers, locations });

  // ── Step 2: PO list — anchored to avoid matching sub-paths ───────────────────
  await page.route(/\/api\/purchase-orders(\?.*)?$/, async (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ purchase_orders: [], total: 0 }),
      });
    }
    await route.continue();
  });

  // ── Step 3: PO detail — anchored so /42/line-items doesn't match ─────────────
  await page.route(
    new RegExp(`\\/api\\/purchase-orders\\/${poId}(\\?.*)?$`),
    async (route) => {
      if (route.request().method() === "GET") {
        const po = typeof getPo === "function" ? getPo() : getPo;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ purchase_order: po }),
        });
      }
      await route.continue();
    },
  );

  // ── Step 4: line-items sub-route (registered after detail so LIFO wins) ──────
  await page.route(
    `**/api/purchase-orders/${poId}/line-items**`,
    async (route) => {
      if (route.request().method() === "GET") {
        lineItemsCallCount += 1;
        const items =
          typeof getLineItems === "function" ? getLineItems() : getLineItems;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ line_items: items }),
        });
      }
      await route.continue();
    },
  );

  // ── Step 5: receive sub-route (registered last = highest LIFO priority) ───────
  await page.route(
    `**/api/purchase-orders/${poId}/receive`,
    async (route) => {
      if (route.request().method() === "POST") {
        receivePostCount += 1;
        const body = JSON.parse(
          route.request().postData() ?? "{}",
        ) as Record<string, unknown>;
        lastReceiveBody = body;

        const response = onReceive
          ? onReceive(body)
          : { received: [], location_name: "" };

        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(response),
        });
      }
      await route.continue();
    },
  );

  return {
    getReceivePostCount: () => receivePostCount,
    getLastReceiveBody: () => lastReceiveBody,
    getLineItemsCallCount: () => lineItemsCallCount,
  };
}
