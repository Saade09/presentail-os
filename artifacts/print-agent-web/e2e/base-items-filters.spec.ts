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

const MOCK_CATEGORIES = {
  categories: [
    {
      id: 1,
      name: "Floral",
      parent_id: null,
      subcategories: [
        { id: 10, name: "Roses", parent_id: 1 },
        { id: 11, name: "Tulips", parent_id: 1 },
      ],
    },
    {
      id: 2,
      name: "Packaging",
      parent_id: null,
      subcategories: [],
    },
  ],
};

const MOCK_BASE_ITEMS = { items: [], total: 0, page: 1, pageSize: 10 };
const MOCK_SUMMARY = { total: 0, flower: 0, packaging: 0, uncategorized: 0 };

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
      body: JSON.stringify(MOCK_BASE_ITEMS),
    });
  });
}

/**
 * Navigate to a base-items URL and wait until the page shell is fully
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

test.describe("Base Items category filter URL persistence", () => {
  test("selecting a main category adds main_cat= to the URL", async ({ page }) => {
    await setupPage(page);
    await gotoBaseItems(page);

    await expect(page.getByText("All categories")).toBeVisible({ timeout: 5_000 });

    const trigger = page.getByText("All categories").first();
    await trigger.click();

    const floralOption = page.getByRole("option", { name: "Floral" });
    await expect(floralOption).toBeVisible({ timeout: 5_000 });
    await floralOption.click();

    await expect(page).toHaveURL(/[?&]main_cat=1/, { timeout: 5_000 });
  });

  test("navigating to /base-items?main_cat=1 pre-selects the correct category in the dropdown", async ({ page }) => {
    await setupPage(page);
    await gotoBaseItems(page, "/base-items?main_cat=1");

    await expect(page.getByText("Floral")).toBeVisible({ timeout: 5_000 });

    const url = new URL(page.url());
    expect(url.searchParams.get("main_cat")).toBe("1");
  });

  test("selecting a subcategory adds sub_cat= to the URL alongside main_cat=", async ({ page }) => {
    await setupPage(page);
    await gotoBaseItems(page, "/base-items?main_cat=1");

    await expect(page.getByText("Floral")).toBeVisible({ timeout: 5_000 });

    const subcategoryTrigger = page.getByText("All subcategories").first();
    await subcategoryTrigger.click();

    const rosesOption = page.getByRole("option", { name: "Roses" });
    await expect(rosesOption).toBeVisible({ timeout: 5_000 });
    await rosesOption.click();

    await expect(page).toHaveURL(/[?&]main_cat=1/, { timeout: 5_000 });
    await expect(page).toHaveURL(/[?&]sub_cat=10/, { timeout: 5_000 });
  });

  test("navigating to /base-items?main_cat=1&sub_cat=10 pre-selects both dropdowns", async ({ page }) => {
    await setupPage(page);
    await gotoBaseItems(page, "/base-items?main_cat=1&sub_cat=10");

    await expect(page.getByText("Floral")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Roses")).toBeVisible({ timeout: 5_000 });

    const url = new URL(page.url());
    expect(url.searchParams.get("main_cat")).toBe("1");
    expect(url.searchParams.get("sub_cat")).toBe("10");
  });

  test("Clear button removes q=, main_cat=, and sub_cat= from the URL", async ({ page }) => {
    await setupPage(page);
    await gotoBaseItems(page, "/base-items?q=flour&main_cat=1&sub_cat=10");

    const clearButton = page.getByRole("button", { name: "Clear", exact: true });
    await expect(clearButton).toBeVisible({ timeout: 5_000 });
    await clearButton.click();

    await expect(page).not.toHaveURL(/[?&]q=/, { timeout: 5_000 });
    await expect(page).not.toHaveURL(/[?&]main_cat=/, { timeout: 5_000 });
    await expect(page).not.toHaveURL(/[?&]sub_cat=/, { timeout: 5_000 });
  });
});

test.describe("Base Items category filter API query params", () => {
  test("selecting a main category sends main_category_id=1 to GET /api/base-items", async ({ page }) => {
    await setupPage(page);
    await gotoBaseItems(page);

    await expect(page.getByText("All categories")).toBeVisible({ timeout: 5_000 });

    const trigger = page.getByText("All categories").first();
    await trigger.click();

    const floralOption = page.getByRole("option", { name: "Floral" });
    await expect(floralOption).toBeVisible({ timeout: 5_000 });

    const [request] = await Promise.all([
      page.waitForRequest((req) => req.url().includes("/api/base-items") && !req.url().includes("/summary")),
      floralOption.click(),
    ]);

    const sentUrl = new URL(request.url());
    expect(sentUrl.searchParams.get("main_category_id")).toBe("1");
  });

  test("selecting a subcategory sends category_id=10 to GET /api/base-items", async ({ page }) => {
    await setupPage(page);
    await gotoBaseItems(page, "/base-items?main_cat=1");

    await expect(page.getByText("Floral")).toBeVisible({ timeout: 5_000 });

    const subcategoryTrigger = page.getByText("All subcategories").first();
    await subcategoryTrigger.click();

    const rosesOption = page.getByRole("option", { name: "Roses" });
    await expect(rosesOption).toBeVisible({ timeout: 5_000 });

    const [request] = await Promise.all([
      page.waitForRequest((req) => req.url().includes("/api/base-items") && !req.url().includes("/summary")),
      rosesOption.click(),
    ]);

    const sentUrl = new URL(request.url());
    expect(sentUrl.searchParams.get("category_id")).toBe("10");
  });
});
