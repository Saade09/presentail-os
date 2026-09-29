import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import { ownerUsersResponse } from "./helpers/productsCommonRoutes";

function makeProduct(id: number, name: string, status = "available") {
  return {
    id,
    workspace_owner_id: "user_1",
    name,
    price_usd: "10.00",
    price_aed: "36.72",
    main_image_url: null,
    additional_image_urls: [],
    description: null,
    status,
    brand: "TestBrand",
    tags: [],
    category: "TestCategory",
    sku: null,
    created_at: new Date().toISOString(),
    cogs_usd: null,
  };
}

const PRODUCTS_RESPONSE = {
  products: [
    makeProduct(1, "Alpha Box"),
    makeProduct(2, "Beta Card", "out_of_stock"),
    makeProduct(3, "Gamma Tag"),
  ],
  total: 3,
  page: 1,
  pageSize: 25,
  totalPages: 1,
};

const SUMMARY_RESPONSE = {
  total: 3,
  available_count: 2,
  hidden_count: 0,
  missing_info_count: 3,
  missing_images_count: 3,
  avg_cogs_pct: null,
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

async function mockProducts(page: import("@playwright/test").Page) {
  await page.route("**/api/products/summary**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(SUMMARY_RESPONSE),
    });
  });
  await page.route("**/api/products/categories**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ categories: ["TestCategory"] }),
    });
  });
  await page.route("**/api/products?**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(PRODUCTS_RESPONSE),
    });
  });
  await page.route("**/api/brands**", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ brands: [] }),
      });
    } else {
      await route.continue();
    }
  });
}

test.describe("Products gallery view toggle", () => {
  test(
    "list view is active by default and gallery is not visible",
    async ({ page }) => {
      await setupClerkTestingToken({ page });
      await mockUsers(page);
      await mockProducts(page);

      await page.goto("/dashboard/products", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Products" })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("Alpha Box")).toBeVisible({ timeout: 12_000 });

      await expect(page.getByTestId("products-view-toggle")).toBeVisible();
      await expect(page.getByTestId("products-list")).toBeVisible();
      await expect(page.getByTestId("products-gallery")).not.toBeVisible();
    },
  );

  test(
    "clicking gallery toggle shows gallery grid and hides the table",
    async ({ page }) => {
      await setupClerkTestingToken({ page });
      await mockUsers(page);
      await mockProducts(page);

      await page.goto("/dashboard/products", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Products" })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("Alpha Box")).toBeVisible({ timeout: 12_000 });

      await expect(page.getByTestId("products-list")).toBeVisible();
      await expect(page.getByTestId("products-gallery")).not.toBeVisible();

      await page.getByTestId("products-view-toggle-gallery").click();

      await expect(page.getByTestId("products-gallery")).toBeVisible();
      await expect(page.getByTestId("products-list")).not.toBeVisible();

      // Gallery cards should contain product names
      await expect(page.getByTestId("products-gallery").getByText("Alpha Box")).toBeVisible();
      await expect(page.getByTestId("products-gallery").getByText("Beta Card")).toBeVisible();
    },
  );

  test(
    "gallery toggle persists ?view=gallery in the URL",
    async ({ page }) => {
      await setupClerkTestingToken({ page });
      await mockUsers(page);
      await mockProducts(page);

      await page.goto("/dashboard/products", { waitUntil: "domcontentloaded" });
      await expect(page.getByText("Alpha Box")).toBeVisible({ timeout: 12_000 });

      await page.getByTestId("products-view-toggle-gallery").click();

      await expect(page).toHaveURL(/view=gallery/);
    },
  );

  test(
    "navigating directly to ?view=gallery shows gallery grid",
    async ({ page }) => {
      await setupClerkTestingToken({ page });
      await mockUsers(page);
      await mockProducts(page);

      await page.goto("/dashboard/products?view=gallery", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Products" })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("Alpha Box")).toBeVisible({ timeout: 12_000 });

      await expect(page.getByTestId("products-gallery")).toBeVisible();
      await expect(page.getByTestId("products-list")).not.toBeVisible();
    },
  );

  test(
    "clicking list toggle from gallery view switches back and removes ?view=gallery",
    async ({ page }) => {
      await setupClerkTestingToken({ page });
      await mockUsers(page);
      await mockProducts(page);

      await page.goto("/dashboard/products?view=gallery", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Products" })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("Alpha Box")).toBeVisible({ timeout: 12_000 });

      await expect(page.getByTestId("products-gallery")).toBeVisible();

      await page.getByTestId("products-view-toggle-list").click();

      await expect(page.getByTestId("products-list")).toBeVisible();
      await expect(page.getByTestId("products-gallery")).not.toBeVisible();
      await expect(page).not.toHaveURL(/view=gallery/);
    },
  );

  test(
    "view mode is preserved when applying a search filter in gallery view",
    async ({ page }) => {
      await setupClerkTestingToken({ page });
      await mockUsers(page);
      await mockProducts(page);

      await page.goto("/dashboard/products?view=gallery", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Products" })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("Alpha Box")).toBeVisible({ timeout: 12_000 });

      await expect(page.getByTestId("products-gallery")).toBeVisible();

      // Type a search query
      await page.getByPlaceholder("Search products by name or SKU…").fill("Alpha");

      // Wait for URL to update with search param
      await expect(page).toHaveURL(/q=Alpha/, { timeout: 5_000 });

      // Gallery view param must still be present
      await expect(page).toHaveURL(/view=gallery/);
      await expect(page.getByTestId("products-gallery")).toBeVisible();
    },
  );
});
