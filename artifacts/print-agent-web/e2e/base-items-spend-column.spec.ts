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
const MOCK_SUMMARY = { total: 2, flower: 0, packaging: 0, uncategorized: 2 };

const HIGH_SPEND_ITEM = {
  id: 1,
  name: "High Spend Item",
  code: "BI0001",
  image_url: null,
  category_id: null,
  alternate_name: null,
  accounting_category: null,
  tax_rate: null,
  main_category_name: null,
  sub_category_name: null,
  created_at: new Date().toISOString(),
  stock: 10,
  low_stock_threshold: 5,
  total_spend: "5000.00",
  spend_ytd: "1200.00",
};

const LOW_SPEND_ITEM = {
  id: 2,
  name: "Low Spend Item",
  code: "BI0002",
  image_url: null,
  category_id: null,
  alternate_name: null,
  accounting_category: null,
  tax_rate: null,
  main_category_name: null,
  sub_category_name: null,
  created_at: new Date().toISOString(),
  stock: 3,
  low_stock_threshold: 5,
  total_spend: "250.00",
  spend_ytd: null,
};

const MOCK_ITEMS_DEFAULT = {
  items: [HIGH_SPEND_ITEM, LOW_SPEND_ITEM],
  total: 2,
  page: 1,
  pageSize: 10,
};

const MOCK_ITEMS_SPEND_DESC = {
  items: [HIGH_SPEND_ITEM, LOW_SPEND_ITEM],
  total: 2,
  page: 1,
  pageSize: 10,
};

const MOCK_ITEMS_SPEND_ASC = {
  items: [LOW_SPEND_ITEM, HIGH_SPEND_ITEM],
  total: 2,
  page: 1,
  pageSize: 10,
};

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
    const url = new URL(route.request().url());
    const sort = url.searchParams.get("sort");
    let body: typeof MOCK_ITEMS_DEFAULT;
    if (sort === "spend_desc") {
      body = MOCK_ITEMS_SPEND_DESC;
    } else if (sort === "spend_asc") {
      body = MOCK_ITEMS_SPEND_ASC;
    } else {
      body = MOCK_ITEMS_DEFAULT;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
}

async function gotoBaseItems(page: import("@playwright/test").Page) {
  await page.goto("/base-items", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Base Items", level: 1 })).toBeVisible({
    timeout: 15_000,
  });
}

test.describe("Base Items — Total Spend column toggle", () => {
  test("Total Spend column header is hidden by default", async ({ page }) => {
    await setupPage(page);
    await gotoBaseItems(page);

    await expect(page.getByRole("columnheader", { name: /Total Spend/i })).not.toBeVisible();
  });

  test("clicking Columns then Total Spend shows the column header", async ({ page }) => {
    await setupPage(page);
    await gotoBaseItems(page);

    await page.getByRole("button", { name: /Columns/i }).click();

    const toggleItem = page.getByRole("menuitem", { name: /Total Spend/i });
    await expect(toggleItem).toBeVisible({ timeout: 5_000 });
    await toggleItem.click();

    await expect(page.getByRole("columnheader", { name: /Total Spend/i })).toBeVisible({
      timeout: 5_000,
    });
  });

  test("badge shows Off before enabling and On after enabling", async ({ page }) => {
    await setupPage(page);
    await gotoBaseItems(page);

    await page.getByRole("button", { name: /Columns/i }).click();

    const toggleItem = page.getByRole("menuitem", { name: /Total Spend/i });
    await expect(toggleItem).toBeVisible({ timeout: 5_000 });
    await expect(toggleItem.getByText("Off")).toBeVisible();

    await toggleItem.click();

    await page.getByRole("button", { name: /Columns/i }).click();
    await expect(page.getByRole("menuitem", { name: /Total Spend/i }).getByText("On")).toBeVisible({
      timeout: 5_000,
    });
  });

  test("spend values appear in the row cells once the column is enabled", async ({ page }) => {
    await setupPage(page);
    await gotoBaseItems(page);

    await page.getByRole("button", { name: /Columns/i }).click();
    const toggleItem = page.getByRole("menuitem", { name: /Total Spend/i });
    await expect(toggleItem).toBeVisible({ timeout: 5_000 });
    await toggleItem.click();

    await expect(page.getByText("High Spend Item")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Low Spend Item")).toBeVisible({ timeout: 5_000 });

    const highRow = page.getByRole("row").filter({ hasText: "High Spend Item" });
    await expect(highRow.getByText(/5,000/)).toBeVisible({ timeout: 5_000 });

    const lowRow = page.getByRole("row").filter({ hasText: "Low Spend Item" });
    await expect(lowRow.getByText(/250/)).toBeVisible({ timeout: 5_000 });
  });

  test("toggling the column off again hides the column header", async ({ page }) => {
    await setupPage(page);
    await gotoBaseItems(page);

    await page.getByRole("button", { name: /Columns/i }).click();
    const toggleItem = page.getByRole("menuitem", { name: /Total Spend/i });
    await expect(toggleItem).toBeVisible({ timeout: 5_000 });
    await toggleItem.click();

    await expect(page.getByRole("columnheader", { name: /Total Spend/i })).toBeVisible({
      timeout: 5_000,
    });

    await page.getByRole("button", { name: /Columns/i }).click();
    const toggleItemAgain = page.getByRole("menuitem", { name: /Total Spend/i });
    await expect(toggleItemAgain).toBeVisible({ timeout: 5_000 });
    await toggleItemAgain.click();

    await expect(page.getByRole("columnheader", { name: /Total Spend/i })).not.toBeVisible();
  });

  test("preference is remembered after navigating away and back", async ({ page }) => {
    await setupPage(page);
    await gotoBaseItems(page);

    await page.getByRole("button", { name: /Columns/i }).click();
    const toggleItem = page.getByRole("menuitem", { name: /Total Spend/i });
    await expect(toggleItem).toBeVisible({ timeout: 5_000 });
    await toggleItem.click();

    await expect(page.getByRole("columnheader", { name: /Total Spend/i })).toBeVisible({
      timeout: 5_000,
    });

    await page.goto("/brands", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Brands" })).toBeVisible({ timeout: 15_000 });

    await gotoBaseItems(page);

    await expect(page.getByRole("columnheader", { name: /Total Spend/i })).toBeVisible({
      timeout: 5_000,
    });
  });
});

test.describe("Base Items — spend sort row ordering", () => {
  test("selecting Highest spend renders the highest-spend item first", async ({ page }) => {
    await setupPage(page);
    await gotoBaseItems(page);

    await expect(page.getByText("High Spend Item")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Low Spend Item")).toBeVisible({ timeout: 5_000 });

    const sortTrigger = page.getByRole("combobox").filter({ hasText: /Newest first/i });
    await expect(sortTrigger).toBeVisible({ timeout: 5_000 });

    await Promise.all([
      page.waitForResponse((res) => res.url().includes("/api/base-items") && !res.url().includes("/summary")),
      sortTrigger.click().then(async () => {
        const option = page.getByRole("option", { name: "Highest spend" });
        await expect(option).toBeVisible({ timeout: 5_000 });
        await option.click();
      }),
    ]);

    const dataRows = page.getByRole("row").filter({ hasNot: page.getByRole("columnheader") });
    const firstRowText = await dataRows.first().textContent();
    expect(firstRowText).toContain("High Spend Item");
  });

  test("selecting Lowest spend renders the lowest-spend item first", async ({ page }) => {
    await setupPage(page);
    await gotoBaseItems(page);

    await expect(page.getByText("High Spend Item")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Low Spend Item")).toBeVisible({ timeout: 5_000 });

    const sortTrigger = page.getByRole("combobox").filter({ hasText: /Newest first/i });
    await expect(sortTrigger).toBeVisible({ timeout: 5_000 });

    await Promise.all([
      page.waitForResponse((res) => res.url().includes("/api/base-items") && !res.url().includes("/summary")),
      sortTrigger.click().then(async () => {
        const option = page.getByRole("option", { name: "Lowest spend" });
        await expect(option).toBeVisible({ timeout: 5_000 });
        await option.click();
      }),
    ]);

    const dataRows = page.getByRole("row").filter({ hasNot: page.getByRole("columnheader") });
    const firstRowText = await dataRows.first().textContent();
    expect(firstRowText).toContain("Low Spend Item");
  });

  test("switching from Highest spend to Lowest spend reverses row order", async ({ page }) => {
    await setupPage(page);
    await gotoBaseItems(page);

    await expect(page.getByText("High Spend Item")).toBeVisible({ timeout: 5_000 });

    const sortTrigger = page.getByRole("combobox").filter({ hasText: /Newest first/i });
    await expect(sortTrigger).toBeVisible({ timeout: 5_000 });

    await Promise.all([
      page.waitForResponse((res) => res.url().includes("/api/base-items") && !res.url().includes("/summary")),
      sortTrigger.click().then(async () => {
        const option = page.getByRole("option", { name: "Highest spend" });
        await expect(option).toBeVisible({ timeout: 5_000 });
        await option.click();
      }),
    ]);

    const rowsAfterDesc = page.getByRole("row").filter({ hasNot: page.getByRole("columnheader") });
    expect(await rowsAfterDesc.first().textContent()).toContain("High Spend Item");

    const switchedTrigger = page.getByRole("combobox").filter({ hasText: /Highest spend/i });
    await expect(switchedTrigger).toBeVisible({ timeout: 5_000 });

    await Promise.all([
      page.waitForResponse((res) => res.url().includes("/api/base-items") && !res.url().includes("/summary")),
      switchedTrigger.click().then(async () => {
        const option = page.getByRole("option", { name: "Lowest spend" });
        await expect(option).toBeVisible({ timeout: 5_000 });
        await option.click();
      }),
    ]);

    const rowsAfterAsc = page.getByRole("row").filter({ hasNot: page.getByRole("columnheader") });
    expect(await rowsAfterAsc.first().textContent()).toContain("Low Spend Item");
  });
});
