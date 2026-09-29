import { test, expect } from "./fixtures";
import { setupFapiWithFakeSession } from "./clerk-fapi-redirect";

test.use({
  _fapiMock: [
    async ({ page }, use) => {
      await setupFapiWithFakeSession(page);
      await use();
    },
    { auto: true },
  ],
});

const MOCK_CATEGORIES = { categories: [] };

const MOCK_ITEMS = {
  items: [
    {
      id: 1,
      name: "Totally Out Item",
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
      low_stock_threshold: 10,
    },
    {
      id: 2,
      name: "Low Stock Item",
      code: "BI0002",
      image_url: null,
      category_id: null,
      alternate_name: null,
      accounting_category: null,
      tax_rate: null,
      main_category_name: null,
      sub_category_name: null,
      created_at: new Date().toISOString(),
      stock: 5,
      low_stock_threshold: 10,
    },
    {
      id: 3,
      name: "Healthy Stock Item",
      code: "BI0003",
      image_url: null,
      category_id: null,
      alternate_name: null,
      accounting_category: null,
      tax_rate: null,
      main_category_name: null,
      sub_category_name: null,
      created_at: new Date().toISOString(),
      stock: 50,
      low_stock_threshold: 10,
    },
  ],
  total: 3,
  page: 1,
  pageSize: 10,
};

const MOCK_SUMMARY = { total: 3, flower: 0, packaging: 0, uncategorized: 3 };

async function setupPage(page: import("@playwright/test").Page) {
  await page.route("**/api/**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({}) });
  });

  await page.route("**/api/users**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        members: [],
        me: { role: "owner", email: "e2e-tester@presentail.com", allowedPages: null, customRoleId: null },
      }),
    });
  });

  await page.route("**/api/base-item-categories**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_CATEGORIES),
    });
  });

  await page.route(/\/api\/base-items\/summary/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_SUMMARY),
    });
  });

  await page.route(/\/api\/base-items\b/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_ITEMS),
    });
  });
}

/**
 * Navigate to the base-items list and wait until the page shell is fully
 * rendered.  `waitUntil: "domcontentloaded"` avoids hangs caused by Clerk FAPI
 * calls (all mocked) before we assert on anything, and the heading check
 * confirms the component has mounted and Clerk's session is settled.
 */
async function gotoBaseItems(page: import("@playwright/test").Page, path = "/base-items") {
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Base Items", level: 1 })).toBeVisible({
    timeout: 15_000,
  });
}

test.describe("Base Items list — stock-level badges", () => {
  test("shows Out of Stock badge for an item with stock=0", async ({ page }) => {
    await setupPage(page);
    await gotoBaseItems(page);

    await expect(page.getByText("Totally Out Item")).toBeVisible({ timeout: 5_000 });

    const itemRow = page.getByRole("row").filter({ hasText: "Totally Out Item" });
    await expect(itemRow.getByText("Out of Stock", { exact: true })).toBeVisible({ timeout: 5_000 });
  });

  test("shows Low Stock badge for an item whose stock is at or below the threshold", async ({ page }) => {
    await setupPage(page);
    await gotoBaseItems(page);

    await expect(page.getByText("Low Stock Item")).toBeVisible({ timeout: 5_000 });

    const itemRow = page.getByRole("row").filter({ hasText: "Low Stock Item" });
    await expect(itemRow.getByText("Low Stock", { exact: true })).toBeVisible({ timeout: 5_000 });
  });

  test("shows no stock badge for an item whose stock is above the threshold", async ({ page }) => {
    await setupPage(page);
    await gotoBaseItems(page);

    await expect(page.getByText("Healthy Stock Item")).toBeVisible({ timeout: 5_000 });

    const itemRow = page.getByRole("row").filter({ hasText: "Healthy Stock Item" });
    await expect(itemRow.getByText("Out of Stock", { exact: true })).not.toBeVisible();
    await expect(itemRow.getByText("Low Stock", { exact: true })).not.toBeVisible();
  });

  test("shows Out of Stock badge for an item with null stock (treated as 0)", async ({ page }) => {
    const itemsWithNullStock = {
      items: [
        {
          id: 4,
          name: "Null Stock Item",
          code: "BI0004",
          image_url: null,
          category_id: null,
          alternate_name: null,
          accounting_category: null,
          tax_rate: null,
          main_category_name: null,
          sub_category_name: null,
          created_at: new Date().toISOString(),
          stock: null,
          low_stock_threshold: 5,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 10,
    };

    await page.route("**/api/**", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({}) });
    });
    await page.route("**/api/users**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          members: [],
          me: { role: "owner", email: "e2e-tester@presentail.com", allowedPages: null, customRoleId: null },
        }),
      });
    });
    await page.route("**/api/base-item-categories**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(MOCK_CATEGORIES),
      });
    });
    await page.route(/\/api\/base-items\/summary/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ total: 1, flower: 0, packaging: 0, uncategorized: 1 }),
      });
    });
    await page.route(/\/api\/base-items\b/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(itemsWithNullStock),
      });
    });

    await page.goto("/base-items", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Base Items", level: 1 })).toBeVisible({
      timeout: 15_000,
    });

    await expect(page.getByText("Null Stock Item")).toBeVisible({ timeout: 5_000 });

    const itemRow = page.getByRole("row").filter({ hasText: "Null Stock Item" });
    await expect(itemRow.getByText("Out of Stock", { exact: true })).toBeVisible({ timeout: 5_000 });
  });

  test("all three badge states appear correctly for the three seeded items", async ({ page }) => {
    await setupPage(page);
    await gotoBaseItems(page);

    await expect(page.getByText("Totally Out Item")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Low Stock Item")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Healthy Stock Item")).toBeVisible({ timeout: 5_000 });

    await expect(page.getByText("Out of Stock", { exact: true })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Low Stock", { exact: true })).toBeVisible({ timeout: 5_000 });

    const healthyRow = page.getByRole("row").filter({ hasText: "Healthy Stock Item" });
    await expect(healthyRow.getByText("Out of Stock", { exact: true })).not.toBeVisible();
    await expect(healthyRow.getByText("Low Stock", { exact: true })).not.toBeVisible();
  });
});
