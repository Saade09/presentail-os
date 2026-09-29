import { test, expect } from "./fixtures";
import { setupFapiWithFakeSession } from "./clerk-fapi-redirect";

// Override the _fapiMock auto-fixture with setupFapiWithFakeSession for this
// spec.  All API routes are mocked via page.route, so the backend never
// validates the JWT — a fully static fake Clerk session is sufficient and
// avoids any dependency on the live FAPI host (clerk.presentail.com) or a
// real .auth-session.json written by global-setup.
test.use({
  _fapiMock: [
    async ({ page }, use) => {
      await setupFapiWithFakeSession(page);
      await use();
    },
    { auto: true },
  ],
});

const OWNER_EMAIL = "e2e-tester@presentail.com";

type MockBaseItem = {
  id: number;
  workspace_owner_id: string;
  name: string;
  code: string;
  image_url: string | null;
  category_id: number | null;
  alternate_name: string | null;
  accounting_category: string | null;
  tax_rate: string | null;
  main_category_name: string | null;
  sub_category_name: string | null;
  created_at: string;
  stock: number;
  low_stock_threshold: number;
};

type MockAdjustment = {
  id: number;
  base_item_id: number;
  quantity_change: number;
  reason: "received" | "wasted" | "stocktake" | "other";
  note: string | null;
  stock_after: number;
  created_at: string;
};

function makeItem(overrides: Partial<MockBaseItem> = {}): MockBaseItem {
  return {
    id: 42,
    workspace_owner_id: "user_test",
    name: "Red Roses",
    code: "BI0001",
    image_url: null,
    category_id: null,
    alternate_name: null,
    accounting_category: null,
    tax_rate: null,
    main_category_name: null,
    sub_category_name: null,
    created_at: new Date().toISOString(),
    stock: 0,
    low_stock_threshold: 0,
    ...overrides,
  };
}

type SetupResult = {
  getCurrentItem: () => MockBaseItem;
  getLastPatchBody: () => Record<string, unknown> | null;
  getPatchCallCount: () => number;
  getLastAdjustmentBody: () => Record<string, unknown> | null;
  getAdjustmentPostCount: () => number;
};

async function setupPage(
  page: import("@playwright/test").Page,
  initialItem: MockBaseItem,
  initialAdjustments: MockAdjustment[] = [],
): Promise<SetupResult> {
  let currentItem = { ...initialItem };
  let lastPatchBody: Record<string, unknown> | null = null;
  let patchCallCount = 0;
  let adjustments = [...initialAdjustments];
  let lastAdjustmentBody: Record<string, unknown> | null = null;
  let adjustmentPostCount = 0;

  // Catch-all for any dashboard/sidebar API routes not explicitly mocked
  // below. Registered first so the more-specific handlers below take
  // priority via Playwright's LIFO route ordering.
  await page.route("**/api/**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({}) });
  });

  await page.route("**/api/users**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        members: [],
        me: { role: "owner", email: OWNER_EMAIL, allowedPages: null, customRoleId: null },
      }),
    });
  });

  await page.route("**/api/base-item-categories**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ categories: [] }),
    });
  });

  await page.route("**/api/base-items/42/location-statuses**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        locationStatuses: [
          {
            location_id: 1,
            location_name: "Main Warehouse",
            is_active: true,
            stock: currentItem.stock,
            low_stock_threshold: currentItem.low_stock_threshold,
          },
        ],
      }),
    });
  });

  await page.route("**/api/base-items/42/products**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ products: [] }),
    });
  });

  await page.route("**/api/base-items/42/packages**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ packages: [] }),
    });
  });

  await page.route("**/api/base-items/42/suppliers**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ suppliers: [] }),
    });
  });

  await page.route(/\/api\/base-items\/42\/adjustments/, async (route) => {
    if (route.request().method() === "POST") {
      adjustmentPostCount += 1;
      const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
      lastAdjustmentBody = body;
      const qtyChange = typeof body.quantity_change === "number" ? body.quantity_change : 0;
      const newStock = Math.max(0, currentItem.stock + qtyChange);
      currentItem = { ...currentItem, stock: newStock };
      const newAdj: MockAdjustment = {
        id: adjustmentPostCount,
        base_item_id: 42,
        quantity_change: qtyChange,
        reason: (body.reason as MockAdjustment["reason"]) ?? "received",
        note: typeof body.note === "string" ? body.note : null,
        stock_after: newStock,
        created_at: new Date().toISOString(),
      };
      adjustments = [newAdj, ...adjustments];
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ adjustment: newAdj, stock: newStock }),
      });
    } else {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ adjustments }),
      });
    }
  });

  await page.route(/\/api\/base-items\/42(\?|$)/, async (route) => {
    if (route.request().method() === "PATCH") {
      patchCallCount += 1;
      const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
      lastPatchBody = body;
      if (typeof body.low_stock_threshold === "number")
        currentItem = { ...currentItem, low_stock_threshold: body.low_stock_threshold };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ item: currentItem }),
      });
    } else {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ item: currentItem }),
      });
    }
  });

  return {
    getCurrentItem: () => currentItem,
    getLastPatchBody: () => lastPatchBody,
    getPatchCallCount: () => patchCallCount,
    getLastAdjustmentBody: () => lastAdjustmentBody,
    getAdjustmentPostCount: () => adjustmentPostCount,
  };
}

/**
 * Navigate to a base-item detail page and wait until the page shell is fully
 * rendered.  `waitUntil: "domcontentloaded"` avoids hanging on Clerk.js CDN
 * chunks and SSE endpoints that keep the network busy indefinitely; the
 * heading assertion's timeout is sufficient to confirm the component has
 * mounted and Clerk's session is settled.
 */
async function gotoBaseItemDetail(
  page: import("@playwright/test").Page,
  id: number,
  itemName: string,
) {
  await page.goto(`/base-items/${id}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: itemName })).toBeVisible({ timeout: 15_000 });
}

test.describe("Base Item Detail — Inventory tab", () => {
  test("inventory tab renders stock level, threshold input, and adjustment form", async ({ page }) => {
    await setupPage(page, makeItem({ stock: 100, low_stock_threshold: 20 }));
    await gotoBaseItemDetail(page, 42, "Red Roses");

    await page.getByRole("tab", { name: "Inventory" }).click();

    await expect(page.getByText("100 units")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByLabel("Low-Stock Alert Threshold")).toBeVisible();
    await expect(page.getByLabel("Low-Stock Alert Threshold")).toHaveValue("20");
    await expect(page.getByRole("button", { name: "Record Adjustment" })).toBeVisible();
    await expect(page.getByText("Adjustment History")).toBeVisible();
  });

  test("shows In Stock badge when stock > threshold", async ({ page }) => {
    await setupPage(page, makeItem({ stock: 50, low_stock_threshold: 10 }));
    await gotoBaseItemDetail(page, 42, "Red Roses");
    await page.getByRole("tab", { name: "Inventory" }).click();

    await expect(page.getByText("In Stock", { exact: true }).first()).toBeVisible({ timeout: 5_000 });
  });

  test("shows Low Stock badge when stock <= threshold and stock > 0", async ({ page }) => {
    await setupPage(page, makeItem({ stock: 5, low_stock_threshold: 10 }));
    await gotoBaseItemDetail(page, 42, "Red Roses");
    await page.getByRole("tab", { name: "Inventory" }).click();

    await expect(page.getByText("Low Stock", { exact: true }).first()).toBeVisible({ timeout: 5_000 });
  });

  test("shows Out of Stock badge when stock is 0", async ({ page }) => {
    await setupPage(page, makeItem({ stock: 0, low_stock_threshold: 10 }));
    await gotoBaseItemDetail(page, 42, "Red Roses");
    await page.getByRole("tab", { name: "Inventory" }).click();

    await expect(page.getByText("Out of Stock", { exact: true }).first()).toBeVisible({ timeout: 5_000 });
  });

  test("Record Adjustment button is disabled until quantity is entered", async ({ page }) => {
    await setupPage(page, makeItem({ stock: 100, low_stock_threshold: 20 }));
    await gotoBaseItemDetail(page, 42, "Red Roses");
    await page.getByRole("tab", { name: "Inventory" }).click();

    await expect(page.getByRole("button", { name: "Record Adjustment" })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole("button", { name: "Record Adjustment" })).toBeDisabled();

    await page.locator("#adj-location").click();
    await page.getByRole("option", { name: "Main Warehouse" }).click();
    await page.locator("#adj-qty").fill("10");
    await expect(page.getByRole("button", { name: "Record Adjustment" })).toBeEnabled();
  });

  test("records an adjustment and updates stock level and history", async ({ page }) => {
    const ctx = await setupPage(page, makeItem({ stock: 0, low_stock_threshold: 0 }));
    await gotoBaseItemDetail(page, 42, "Red Roses");
    await page.getByRole("tab", { name: "Inventory" }).click();

    await expect(page.getByText("0 units")).toBeVisible({ timeout: 5_000 });

    await page.locator("#adj-location").click();
    await page.getByRole("option", { name: "Main Warehouse" }).click();
    await page.locator("#adj-qty").fill("25");
    await page.locator("#adj-note").fill("Initial delivery");
    await page.getByRole("button", { name: "Record Adjustment" }).click();

    await expect(page.getByText("Adjustment recorded", { exact: true })).toBeVisible({ timeout: 5_000 });

    expect(ctx.getAdjustmentPostCount()).toBe(1);
    const body = ctx.getLastAdjustmentBody();
    expect(body).not.toBeNull();
    expect((body as Record<string, unknown>).quantity_change).toBe(25);
    expect((body as Record<string, unknown>).reason).toBe("received");
  });

  test("saves updated threshold via PATCH and shows Save/Cancel buttons on dirty", async ({ page }) => {
    const ctx = await setupPage(page, makeItem({ stock: 0, low_stock_threshold: 0 }));
    await gotoBaseItemDetail(page, 42, "Red Roses");
    await page.getByRole("tab", { name: "Inventory" }).click();

    await expect(page.getByLabel("Low-Stock Alert Threshold")).toBeVisible({ timeout: 5_000 });

    await page.getByLabel("Low-Stock Alert Threshold").fill("10");
    await expect(page.getByRole("button", { name: "Save" }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Cancel" }).first()).toBeVisible();

    await page.getByRole("button", { name: "Save" }).first().click();

    await expect(page.getByText("Threshold updated", { exact: true })).toBeVisible({ timeout: 5_000 });

    expect(ctx.getPatchCallCount()).toBe(1);
    const body = ctx.getLastPatchBody();
    expect(body).not.toBeNull();
    expect((body as Record<string, unknown>).low_stock_threshold).toBe(10);
  });

  test("Cancel button reverts unsaved threshold changes", async ({ page }) => {
    await setupPage(page, makeItem({ stock: 100, low_stock_threshold: 20 }));
    await gotoBaseItemDetail(page, 42, "Red Roses");
    await page.getByRole("tab", { name: "Inventory" }).click();

    await expect(page.getByLabel("Low-Stock Alert Threshold")).toBeVisible({ timeout: 5_000 });
    await page.getByLabel("Low-Stock Alert Threshold").fill("999");

    await expect(page.getByRole("button", { name: "Cancel" }).first()).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).first().click();

    await expect(page.getByLabel("Low-Stock Alert Threshold")).toHaveValue("20");
    await expect(page.getByRole("button", { name: "Cancel" }).first()).not.toBeVisible();
  });

  test("shows empty history message when no adjustments exist", async ({ page }) => {
    await setupPage(page, makeItem({ stock: 0, low_stock_threshold: 0 }), []);
    await gotoBaseItemDetail(page, 42, "Red Roses");
    await page.getByRole("tab", { name: "Inventory" }).click();

    await expect(page.getByText("No adjustments recorded yet")).toBeVisible({ timeout: 5_000 });
  });

  test("shows existing adjustment history entries", async ({ page }) => {
    const pastAdj: MockAdjustment = {
      id: 1,
      base_item_id: 42,
      quantity_change: 50,
      reason: "received",
      note: "From supplier",
      stock_after: 50,
      created_at: new Date(Date.now() - 3600_000).toISOString(),
    };
    await setupPage(page, makeItem({ stock: 50, low_stock_threshold: 0 }), [pastAdj]);
    await gotoBaseItemDetail(page, 42, "Red Roses");
    await page.getByRole("tab", { name: "Inventory" }).click();

    await expect(page.getByText("+50")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("From supplier")).toBeVisible();
  });
});
