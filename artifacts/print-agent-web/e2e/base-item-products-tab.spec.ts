import { test, expect } from "./fixtures";
import { setupFapiWithFakeSession } from "./clerk-fapi-redirect";

// All API routes are mocked so no real backend or Clerk session is needed.
// setupFapiWithFakeSession installs a static fake Clerk session that satisfies
// the React client without hitting the live FAPI host.
test.use({
  _fapiMock: [
    async ({ page }, use) => {
      await setupFapiWithFakeSession(page);
      await use();
    },
    { auto: true },
  ],
});

const BASE_ITEM_ID = 42;

const MOCK_BASE_ITEM = {
  id: BASE_ITEM_ID,
  workspace_owner_id: "user_test",
  name: "Red Roses",
  code: "BI0042",
  image_url: null,
  category_id: null,
  alternate_name: null,
  accounting_category: null,
  tax_rate: null,
  main_category_name: null,
  sub_category_name: null,
  created_at: "2024-01-01T00:00:00.000Z",
  stock: 0,
  low_stock_threshold: 0,
};

// Three products: two available (qty 2 + 5 stem), one out_of_stock (qty 3 piece).
// Usage summary: "Used in 3 products · 7 stem, 3 piece"
// Default sort (Qty desc): Berry Bunch (5), Cherry Corsage (3), Apple Bouquet (2)
// Name sort (asc): Apple Bouquet, Berry Bunch, Cherry Corsage
const PRODUCT_APPLE = {
  id: 201,
  name: "Apple Bouquet",
  category: "Floral",
  status: "available",
  image_url: null,
  brand_id: null,
  brand_logo_id: null,
  quantity: "2",
  unit: "stem",
  recipe_updated_at: "2024-01-10T00:00:00.000Z",
};

const PRODUCT_BERRY = {
  id: 202,
  name: "Berry Bunch",
  category: "Floral",
  status: "available",
  image_url: null,
  brand_id: null,
  brand_logo_id: null,
  quantity: "5",
  unit: "stem",
  recipe_updated_at: "2024-01-12T00:00:00.000Z",
};

const PRODUCT_CHERRY = {
  id: 203,
  name: "Cherry Corsage",
  category: "Accessory",
  status: "out_of_stock",
  image_url: null,
  brand_id: null,
  brand_logo_id: null,
  quantity: "3",
  unit: "piece",
  recipe_updated_at: "2024-01-11T00:00:00.000Z",
};

const MOCK_PRODUCTS = {
  products: [PRODUCT_APPLE, PRODUCT_BERRY, PRODUCT_CHERRY],
};

async function setupPage(page: import("@playwright/test").Page) {
  // Catch-all for any sidebar/dashboard API routes not explicitly mocked below.
  // Registered first so the more-specific handlers below take priority via
  // Playwright's LIFO route ordering.
  await page.route("**/api/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({}),
    });
  });

  await page.route("**/api/users**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        members: [],
        me: {
          role: "owner",
          email: "e2e-tester@presentail.com",
          allowedPages: null,
          customRoleId: null,
        },
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

  await page.route(`**/api/base-items/${BASE_ITEM_ID}/location-statuses**`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ locationStatuses: [] }),
    });
  });

  await page.route(`**/api/base-items/${BASE_ITEM_ID}/products**`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_PRODUCTS),
    });
  });

  await page.route(`**/api/base-items/${BASE_ITEM_ID}/packages**`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ packages: [] }),
    });
  });

  await page.route(`**/api/base-items/${BASE_ITEM_ID}/suppliers**`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ suppliers: [] }),
    });
  });

  await page.route(/\/api\/base-items\/42(\?|$)/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ item: MOCK_BASE_ITEM }),
    });
  });
}

/**
 * Navigate to a base-item detail page and wait until the page shell is fully
 * rendered.  `waitUntil: "domcontentloaded"` avoids hangs caused by Clerk FAPI
 * calls (all mocked) before we assert on anything, and the heading check
 * confirms the component has mounted and Clerk's session is settled.
 */
async function gotoBaseItemDetail(
  page: import("@playwright/test").Page,
  id: number,
  itemName: string,
) {
  await page.goto(`/base-items/${id}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: itemName })).toBeVisible({ timeout: 15_000 });
}

test.describe("Base Item detail – Products tab usage summary and sorting", () => {
  test("shows usage summary with correct product count and unit grouping", async ({ page }) => {
    await setupPage(page);
    await gotoBaseItemDetail(page, BASE_ITEM_ID, "Red Roses");

    await page.getByRole("tab", { name: "Products" }).click();

    // 3 products total; 7 stem (2+5 from Apple+Berry) and 3 piece (Cherry)
    await expect(
      page.getByText("Used in 3 products · 7 stem, 3 piece"),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("status filter hides products that do not match the selected status", async ({ page }) => {
    await setupPage(page);
    await gotoBaseItemDetail(page, BASE_ITEM_ID, "Red Roses");

    await page.getByRole("tab", { name: "Products" }).click();

    // All three products should be visible on the default "All" filter
    await expect(page.getByText("Apple Bouquet")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Berry Bunch")).toBeVisible();
    await expect(page.getByText("Cherry Corsage")).toBeVisible();

    // Switch to "Available" (exact match to avoid hitting "Not Available") —
    // Cherry Corsage (out_of_stock) should disappear
    await page.getByRole("button", { name: "Available", exact: true }).click();
    await expect(page.getByText("Cherry Corsage")).not.toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Apple Bouquet")).toBeVisible();
    await expect(page.getByText("Berry Bunch")).toBeVisible();

    // Switch to "Out of Stock" — only Cherry Corsage should be visible
    await page.getByRole("button", { name: "Out of Stock" }).click();
    await expect(page.getByText("Cherry Corsage")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Apple Bouquet")).not.toBeVisible();
    await expect(page.getByText("Berry Bunch")).not.toBeVisible();
  });

  test("sort by Name changes product order to alphabetical ascending", async ({ page }) => {
    await setupPage(page);
    await gotoBaseItemDetail(page, BASE_ITEM_ID, "Red Roses");

    await page.getByRole("tab", { name: "Products" }).click();

    // Scope to the active tab panel's product list to avoid matching hidden panels
    const productList = page
      .locator('[data-state="active"] .divide-y.divide-border')
      .first();

    // Default sort: Qty descending → Berry (5), Cherry (3), Apple (2)
    const firstRow = productList.locator("p.font-medium.text-sm").first();
    await expect(firstRow).toHaveText("Berry Bunch", { timeout: 8_000 });

    const lastRow = productList.locator("p.font-medium.text-sm").last();
    await expect(lastRow).toHaveText("Apple Bouquet");

    // Click the Name sort button → switches to alphabetical ascending
    await page.getByRole("button", { name: "Name" }).click();

    await expect(firstRow).toHaveText("Apple Bouquet", { timeout: 5_000 });
    await expect(lastRow).toHaveText("Cherry Corsage");
  });
});
