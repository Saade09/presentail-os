import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import { ownerUsersResponse } from "./helpers/brandsCommonRoutes";

const BRANDS_VIEW_STORAGE_KEY = "presentail.brands.view";

function makeBrand(id: number, name: string) {
  return {
    id,
    name,
    description: null,
    target_cogs: null,
    sticker_count: "0",
    product_count: "0",
    has_logo: false,
    created_at: new Date().toISOString(),
  };
}

const MULTI_BRANDS = {
  brands: [
    makeBrand(1, "Acme Brand"),
    makeBrand(2, "Globex Brand"),
    makeBrand(3, "Initech Brand"),
  ],
  workspaceJobCount: 0,
};

const SINGLE_BRAND = {
  brands: [makeBrand(1, "Solo Brand")],
  workspaceJobCount: 0,
};

const EMPTY_BRANDS = {
  brands: [],
  workspaceJobCount: 0,
};

async function mockUsers(page: import("@playwright/test").Page) {
  await page.route("**/api/users**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(ownerUsersResponse()),
    });
  });
}

async function mockBrandsList(
  page: import("@playwright/test").Page,
  payload: object,
) {
  await page.route("**/api/brands", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(payload),
      });
    } else {
      await route.continue();
    }
  });
}

test.describe("Brands list/gallery view toggle", () => {
  test(
    "renders toggle and pluralized count badge for multiple brands",
    async ({ page }) => {
      await setupClerkTestingToken({ page });
      await mockUsers(page);
      await mockBrandsList(page, MULTI_BRANDS);

      await page.goto("/brands", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Brands" })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("Acme Brand")).toBeVisible({ timeout: 12_000 });

      await expect(page.getByTestId("brands-view-toggle")).toBeVisible();
      const count = page.getByTestId("brands-count");
      await expect(count).toBeVisible();
      await expect(count).toHaveText("3 brands");

      await expect(page.getByTestId("brands-list")).toBeVisible();
      await expect(page.getByTestId("brands-gallery")).not.toBeVisible();
    },
  );

  test(
    "renders singular count badge for exactly one brand",
    async ({ page }) => {
      await setupClerkTestingToken({ page });
      await mockUsers(page);
      await mockBrandsList(page, SINGLE_BRAND);

      await page.goto("/brands", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Brands" })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("Solo Brand")).toBeVisible({ timeout: 12_000 });

      const count = page.getByTestId("brands-count");
      await expect(count).toBeVisible();
      await expect(count).toHaveText("1 brand");
    },
  );

  test(
    "clicking gallery toggle swaps to gallery view, clicking list reverses it",
    async ({ page }) => {
      await setupClerkTestingToken({ page });
      await mockUsers(page);
      await mockBrandsList(page, MULTI_BRANDS);

      await page.goto("/brands", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Brands" })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("Acme Brand")).toBeVisible({ timeout: 12_000 });

      await expect(page.getByTestId("brands-list")).toBeVisible();
      await expect(page.getByTestId("brands-gallery")).not.toBeVisible();

      await page.getByTestId("brands-view-toggle-gallery").click();

      await expect(page.getByTestId("brands-gallery")).toBeVisible();
      await expect(page.getByTestId("brands-list")).not.toBeVisible();

      await page.getByTestId("brands-view-toggle-list").click();

      await expect(page.getByTestId("brands-list")).toBeVisible();
      await expect(page.getByTestId("brands-gallery")).not.toBeVisible();
    },
  );

  test(
    "empty brands response hides the toggle and the count badge",
    async ({ page }) => {
      await setupClerkTestingToken({ page });
      await mockUsers(page);
      await mockBrandsList(page, EMPTY_BRANDS);

      await page.goto("/brands", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Brands" })).toBeVisible({ timeout: 15_000 });
      // Wait for the empty-state placeholder so we know the page settled past
      // its loading state.
      await expect(
        page.getByText("No brands yet", { exact: true }),
      ).toBeVisible({ timeout: 12_000 });
      await expect(page.getByTestId("brands-view-toggle")).toHaveCount(0);
      await expect(page.getByTestId("brands-count")).toHaveCount(0);
    },
  );

  test(
    "localStorage seeded with 'gallery' opens the page directly in gallery view",
    async ({ page }) => {
      await page.addInitScript(
        ([key, value]) => {
          try {
            window.localStorage.setItem(key, value);
          } catch {
            /* ignore */
          }
        },
        [BRANDS_VIEW_STORAGE_KEY, "gallery"],
      );

      await setupClerkTestingToken({ page });
      await mockUsers(page);
      await mockBrandsList(page, MULTI_BRANDS);

      await page.goto("/brands", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Brands" })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId("brands-gallery")).toBeVisible({
        timeout: 12_000,
      });
      await expect(page.getByTestId("brands-list")).not.toBeVisible();
    },
  );
});
