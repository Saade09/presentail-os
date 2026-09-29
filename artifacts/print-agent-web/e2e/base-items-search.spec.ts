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

test.describe("Base Items search URL persistence", () => {
  test("typing in the search box adds a q= param to the URL", async ({ page }) => {
    await setupPage(page);
    await gotoBaseItems(page);

    const searchInput = page.getByPlaceholder("Search by name or code…");
    await expect(searchInput).toBeVisible({ timeout: 5_000 });

    await searchInput.fill("flour");

    await expect(page).toHaveURL(/[?&]q=flour/, { timeout: 5_000 });
  });

  test("navigating to /base-items?q=flour pre-fills the search input", async ({ page }) => {
    await setupPage(page);
    await gotoBaseItems(page, "/base-items?q=flour");

    const searchInput = page.getByPlaceholder("Search by name or code…");
    await expect(searchInput).toBeVisible({ timeout: 5_000 });
    await expect(searchInput).toHaveValue("flour", { timeout: 5_000 });
  });

  test("clearing the search input removes the q= param from the URL", async ({ page }) => {
    await setupPage(page);
    await gotoBaseItems(page, "/base-items?q=flour");

    const searchInput = page.getByPlaceholder("Search by name or code…");
    await expect(searchInput).toHaveValue("flour", { timeout: 5_000 });

    await searchInput.clear();

    await expect(page).not.toHaveURL(/[?&]q=/, { timeout: 5_000 });
  });
});
