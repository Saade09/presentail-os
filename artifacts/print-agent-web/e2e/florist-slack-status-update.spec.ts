import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import type { Page } from "@playwright/test";

/**
 * Confirms that the parent order's status badge updates immediately to
 * "ready for delivery" on the florist screen after a successful photo
 * verification, without requiring a separate refetch or page reload.
 *
 * The behaviour under test:
 *  - POST /florist-orders/:id/verify  returns order_status_updated: true
 *  - The UI calls queryClient.setQueriesData immediately to patch the
 *    parent_order_status to "ready_for_delivery" in the cached florist list
 *  - The badge text changes in-place, before any refetch completes
 */

const ASSIGNMENT_ID = 42;
const ORDER_ID = "aaaa-bbbb-cccc-dddd";
const ORDER_NUMBER = "FLO-001";

function makeFloristOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: ASSIGNMENT_ID,
    order_id: ORDER_ID,
    order_number: ORDER_NUMBER,
    location_id: 10,
    location_name: "Achrafieh",
    status: "in_progress",
    started_at: new Date().toISOString(),
    completed_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    has_card: false,
    has_cake: false,
    window_start: null,
    window_end: null,
    card_message: null,
    card_from: null,
    card_to: null,
    qr_link: null,
    card_printed_at: null,
    items: [],
    // Photos already uploaded so the verify button is enabled
    photo_items_path: "/objects/test-owner/uploads/items.jpg",
    photo_card_path: "/objects/test-owner/uploads/card.jpg",
    photo_card_on_box_path: null,
    verification_status: "none",
    verification_reason_code: null,
    verification_reason: null,
    verified_at: null,
    // Parent order is currently preparing
    parent_order_status: "preparing",
    ...overrides,
  };
}

function makeUsersResponse() {
  return {
    members: [
      {
        id: 1,
        email: "e2e-tester@presentail.com",
        role: "owner",
        custom_role_id: null,
        role_name: null,
        joined: true,
        joined_at: new Date().toISOString(),
        invited_at: new Date().toISOString(),
        invited_by_email: null,
        manager_member_id: null,
        manager_email: null,
        image_url: null,
        invite_token: null,
        assigned_locations: [],
      },
    ],
    me: {
      role: "owner",
      email: "e2e-tester@presentail.com",
      allowedPages: null,
      customRoleId: null,
    },
  };
}

async function setupFloristRoutes(
  page: Page,
  {
    initialOrders = [makeFloristOrder()],
    verifyResponse = {
      success: true,
      verification: {
        verification_status: "approved",
        verified_at: new Date().toISOString(),
        photo_items_path: "/objects/test-owner/uploads/items.jpg",
        photo_card_path: "/objects/test-owner/uploads/card.jpg",
        photo_card_on_box_path: null,
        card_printed_at: null,
        verification_reason_code: null,
        verification_reason: null,
      },
      order_status_updated: true,
    },
  }: {
    initialOrders?: ReturnType<typeof makeFloristOrder>[];
    verifyResponse?: unknown;
  } = {},
) {
  // Track orders so the list refetch returns updated data after verify
  let currentOrders = [...initialOrders];

  // --- Boilerplate routes shared across pages ---
  await page.route("**/api/users/failed-access-requests**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ failedRequests: [] }) }),
  );
  await page.route("**/api/users**", async (route) => {
    if (route.request().method() !== "GET") { await route.continue(); return; }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(makeUsersResponse()) });
  });
  await page.route("**/api/access-requests**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ requests: [] }) }),
  );
  await page.route("**/api/notifications/seen**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) }),
  );
  await page.route("**/api/time-off/notifications/events**", (route) =>
    route.fulfill({ status: 200, contentType: "text/event-stream", body: "" }),
  );
  await page.route("**/api/time-off/notifications/seen**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) }),
  );
  await page.route("**/api/time-off/notifications**", async (route) => {
    const url = route.request().url();
    if (url.includes("/seen") || url.includes("/events")) { await route.continue(); return; }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ notifications: [] }) });
  });
  // SSE endpoint for new-order alerts
  await page.route("**/api/events**", (route) =>
    route.fulfill({ status: 200, contentType: "text/event-stream", body: "" }),
  );

  // --- Florist-specific routes ---
  await page.route("**/api/locations**", (route) => {
    if (route.request().method() !== "GET") { route.continue(); return; }
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ locations: [] }) });
  });
  await page.route("**/api/card-message/branch-configs**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ configs: [] }) }),
  );
  await page.route("**/api/florist-orders/manual-review/count**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ count: 0 }) }),
  );
  await page.route("**/api/florist-orders/manual-review**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ manual_reviews: [] }) }),
  );

  // Florist orders list — returns updated data after the verify mutation
  await page.route("**/api/florist-orders**", async (route) => {
    const method = route.request().method();
    const url = route.request().url();

    // POST /api/florist-orders/:id/verify
    if (method === "POST" && url.match(/\/florist-orders\/\d+\/verify/)) {
      // After a successful verify, mark the order as ready_for_delivery in the list
      currentOrders = currentOrders.map((o) =>
        o.id === ASSIGNMENT_ID
          ? {
              ...o,
              verification_status: "approved",
              verified_at: new Date().toISOString(),
              parent_order_status: "ready_for_delivery",
            }
          : o,
      );
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(verifyResponse),
      });
      return;
    }

    // GET /api/florist-orders (list)
    if (method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, florist_orders: currentOrders }),
      });
      return;
    }

    await route.continue();
  });
}

// ──────────────────────────────────────────────────────────────────────────────

test.describe("Florist orders — parent order status update after Slack send", () => {
  test("parent order status badge updates to 'ready for delivery' immediately after verify succeeds", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupFloristRoutes(page);

    await page.goto("/florist-orders", { waitUntil: "domcontentloaded" });

    // Page should load and show the florist orders heading
    await expect(page.getByRole("heading", { name: /florist orders/i })).toBeVisible({ timeout: 15_000 });

    // Switch to the In Progress tab to reveal the in_progress order card
    await page.getByTestId("tab-in-progress").click();

    const orderCard = page.getByTestId(`florist-order-${ASSIGNMENT_ID}`);
    await expect(orderCard).toBeVisible({ timeout: 8_000 });

    // Initially, the parent order status badge shows "preparing"
    const parentStatusBadge = page.getByTestId(`parent-order-status-${ASSIGNMENT_ID}`);
    await expect(parentStatusBadge).toBeVisible({ timeout: 5_000 });
    await expect(parentStatusBadge).toHaveText(/preparing/i);

    // The verify button should be enabled (photos are set, verification_status=none)
    const verifyBtn = page.getByTestId(`button-verify-${ASSIGNMENT_ID}`);
    await expect(verifyBtn).toBeVisible({ timeout: 5_000 });
    await expect(verifyBtn).not.toBeDisabled();

    // Click verify — the mocked endpoint returns order_status_updated: true
    await verifyBtn.click();

    // The parent order status badge should update immediately to "ready for delivery"
    // without waiting for a full page reload
    await expect(parentStatusBadge).toHaveText(/ready for delivery/i, { timeout: 8_000 });
  });

  test("parent order status badge updates immediately after slack-retry succeeds", async ({ page }) => {
    await setupClerkTestingToken({ page });

    // Order is already approved, awaiting Slack delivery
    const approvedOrder = makeFloristOrder({
      verification_status: "approved",
      verified_at: new Date().toISOString(),
      slack_sent_at: null,
      parent_order_status: "preparing",
    });

    await setupFloristRoutes(page, { initialOrders: [approvedOrder] });

    await page.goto("/florist-orders", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: /florist orders/i })).toBeVisible({ timeout: 15_000 });

    await page.getByTestId("tab-in-progress").click();

    const orderCard = page.getByTestId(`florist-order-${ASSIGNMENT_ID}`);
    await expect(orderCard).toBeVisible({ timeout: 8_000 });

    // Initially shows "preparing"
    const parentStatusBadge = page.getByTestId(`parent-order-status-${ASSIGNMENT_ID}`);
    await expect(parentStatusBadge).toHaveText(/preparing/i, { timeout: 5_000 });

    // The Slack retry button should be visible (approved but not yet sent)
    const retryBtn = page.getByTestId(`button-slack-retry-${ASSIGNMENT_ID}`);
    await expect(retryBtn).toBeVisible({ timeout: 5_000 });

    // Click retry
    await retryBtn.click();

    // Badge should immediately update
    await expect(parentStatusBadge).toHaveText(/ready for delivery/i, { timeout: 8_000 });
  });
});
