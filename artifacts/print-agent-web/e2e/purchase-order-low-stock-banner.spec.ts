import { test, expect } from "./fixtures";
import { setupFapiWithFakeSession } from "./clerk-fapi-redirect";
import { setupPurchaseOrderRoutes } from "./purchase-order-test-utils";

test.use({
  _fapiMock: [
    async ({ page }, use) => {
      await setupFapiWithFakeSession(page);
      await use();
    },
    { auto: true },
  ],
});

const PO_ID = 77;
const LOCATION_ID = 3;
const BASE_ITEM_ID = 5;

const MOCK_PO = {
  id: PO_ID,
  workspace_owner_id: "user_owner",
  supplier_id: 7,
  supplier_name: "Alpha Supplier",
  po_number: "PO-0077",
  po_number_label: "PO-0077",
  status: "confirmed",
  currency: "AED",
  total_amount: null,
  total_amount_manual_override: false,
  expected_delivery_date: null,
  notes: null,
  effective_total: "250.00",
  calculated_total: "250.00",
  sent_at: null,
  line_items_count: 1,
  received_items_count: 0,
  location_id: LOCATION_ID,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  created_by_clerk_id: null,
  updated_by_clerk_id: null,
};

const MOCK_LINE_ITEM = {
  id: 101,
  purchase_order_id: PO_ID,
  base_item_id: BASE_ITEM_ID,
  base_item_name: "Red Roses",
  description: "Red Roses",
  quantity: "5",
  unit_price: "50.00",
  currency: "AED",
  received_quantity: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const MOCK_LOCATION = { id: LOCATION_ID, name: "Main Warehouse" };

function stocksResponse(currentStock: number) {
  return {
    stocks: [
      {
        line_item_id: MOCK_LINE_ITEM.id,
        base_item_id: BASE_ITEM_ID,
        base_item_name: "Red Roses",
        current_stock: currentStock,
        low_stock_threshold: 10,
      },
    ],
  };
}

/**
 * Sets up all PO routes plus a mutable stocks route.
 *
 * Pass a getter so tests can change the returned stock level at any point
 * (e.g. before a reload) without re-registering the route.
 */
async function setupRoutes(
  page: import("@playwright/test").Page,
  getStocks: () => object,
): Promise<void> {
  await setupPurchaseOrderRoutes(page, {
    poId: PO_ID,
    getPo: MOCK_PO,
    getLineItems: [MOCK_LINE_ITEM],
    locations: [MOCK_LOCATION],
    suppliers: [],
  });

  // Registered after setupPurchaseOrderRoutes → higher LIFO priority than the
  // catch-all and the generic line-items handler.
  await page.route(
    `**/api/purchase-orders/${PO_ID}/line-item-stocks**`,
    async (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(getStocks()),
        });
      }
      await route.continue();
    },
  );
}

async function gotoPurchaseOrderDetail(page: import("@playwright/test").Page) {
  await page.goto(`/purchase-orders/${PO_ID}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "PO-0077" })).toBeVisible({ timeout: 15_000 });
}

const BANNER_TEXT = "1 item is running low on stock at this location";
const DISMISS_BUTTON = "Dismiss low-stock warning";

test.describe("Purchase Order Detail — low-stock banner", () => {
  test("banner appears when a line item has stock at or below the threshold", async ({ page }) => {
    let currentStock = 5;
    await setupRoutes(page, () => stocksResponse(currentStock));
    await gotoPurchaseOrderDetail(page);

    await expect(page.getByText(BANNER_TEXT)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Red Roses")).toBeVisible();
    await expect(page.getByText(/5 left/)).toBeVisible();
  });

  test("banner is hidden after dismissal", async ({ page }) => {
    let currentStock = 5;
    await setupRoutes(page, () => stocksResponse(currentStock));
    await gotoPurchaseOrderDetail(page);

    await expect(page.getByText(BANNER_TEXT)).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: DISMISS_BUTTON }).click();

    await expect(page.getByText(BANNER_TEXT)).not.toBeVisible({ timeout: 5_000 });
  });

  test("banner stays hidden after dismissal when page reloads with the same stock level", async ({ page }) => {
    let currentStock = 5;
    await setupRoutes(page, () => stocksResponse(currentStock));
    await gotoPurchaseOrderDetail(page);

    await expect(page.getByText(BANNER_TEXT)).toBeVisible({ timeout: 10_000 });

    // Dismiss — sessionStorage records currentStock = 5 for this base item
    await page.getByRole("button", { name: DISMISS_BUTTON }).click();
    await expect(page.getByText(BANNER_TEXT)).not.toBeVisible({ timeout: 5_000 });

    // Reload the page; sessionStorage persists across reloads in the same tab.
    // Stock is still 5 (same as at dismissal) → banner must remain hidden.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "PO-0077" })).toBeVisible({ timeout: 15_000 });

    // Give time for the stocks response to arrive and render
    await expect(page.getByText(BANNER_TEXT)).not.toBeVisible({ timeout: 10_000 });
  });

  test("banner reappears after reload when stock drops below the level recorded at dismissal", async ({ page }) => {
    let currentStock = 5;
    await setupRoutes(page, () => stocksResponse(currentStock));
    await gotoPurchaseOrderDetail(page);

    await expect(page.getByText(BANNER_TEXT)).toBeVisible({ timeout: 10_000 });

    // Dismiss at stock = 5
    await page.getByRole("button", { name: DISMISS_BUTTON }).click();
    await expect(page.getByText(BANNER_TEXT)).not.toBeVisible({ timeout: 5_000 });

    // Stock falls to 3 — below the 5 recorded at dismissal time
    currentStock = 3;

    // Reload; sessionStorage still holds dismissedStock = 5 for this base item.
    // Because 3 < 5, the banner logic re-shows the banner.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "PO-0077" })).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText(BANNER_TEXT)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/3 left/)).toBeVisible();
  });

  test("banner does NOT reappear when stock is the same as at dismissal", async ({ page }) => {
    let currentStock = 5;
    await setupRoutes(page, () => stocksResponse(currentStock));
    await gotoPurchaseOrderDetail(page);

    await expect(page.getByText(BANNER_TEXT)).toBeVisible({ timeout: 10_000 });

    // Dismiss at stock = 5
    await page.getByRole("button", { name: DISMISS_BUTTON }).click();
    await expect(page.getByText(BANNER_TEXT)).not.toBeVisible({ timeout: 5_000 });

    // Stock stays at 5 (equal to dismissal level — not strictly less)
    currentStock = 5;

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "PO-0077" })).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText(BANNER_TEXT)).not.toBeVisible({ timeout: 10_000 });
  });

  test("banner does NOT reappear when stock rises (but is still below threshold)", async ({ page }) => {
    let currentStock = 5;
    await setupRoutes(page, () => stocksResponse(currentStock));
    await gotoPurchaseOrderDetail(page);

    await expect(page.getByText(BANNER_TEXT)).toBeVisible({ timeout: 10_000 });

    // Dismiss at stock = 5
    await page.getByRole("button", { name: DISMISS_BUTTON }).click();
    await expect(page.getByText(BANNER_TEXT)).not.toBeVisible({ timeout: 5_000 });

    // Stock rises to 7 — still below the threshold of 10 (item is still "low-stock")
    // but above the 5 recorded at dismissal, so the banner must remain hidden.
    currentStock = 7;

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "PO-0077" })).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText(BANNER_TEXT)).not.toBeVisible({ timeout: 10_000 });
  });
});
