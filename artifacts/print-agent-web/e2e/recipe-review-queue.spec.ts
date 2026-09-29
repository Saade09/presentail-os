/**
 * E2E tests for the Recipe Review Queue page (/recipe-review).
 *
 * Tests cover:
 * - Page renders with product table
 * - Summary stats display (loading then resolved)
 * - Filter buttons switch between all/no-recipe/pending-suggestion views
 * - Search filters by product name
 * - Pending suggestion badge is shown in product rows
 * - "View recipe" / "Review suggestion" links navigate to the correct product recipe tab
 * - Empty states are shown for each filter when there are no results
 * - Summary unavailable warning banner is shown when the summary endpoint is not deployed
 */
import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";

const OWNER_EMAIL = "e2e-tester@presentail.com";

const MOCK_PRODUCTS = [
  {
    id: 1,
    name: "Rose Bouquet",
    status: "available",
    brand: "Floral Co",
    category: "Flowers",
    main_image_url: null,
  },
  {
    id: 2,
    name: "Balloon Set",
    status: "available",
    brand: null,
    category: "Balloons",
    main_image_url: null,
  },
  {
    id: 3,
    name: "Chocolate Box",
    status: "available",
    brand: "Sweet Things",
    category: "Food",
    main_image_url: null,
  },
];

const MOCK_SUMMARY = {
  attention_count: 3,
  products_without_recipe: [1, 3],
  products_with_pending_suggestion: [
    {
      product_id: 2,
      suggestion_id: 101,
      version: 1,
      confidence: 0.78,
      created_at: new Date().toISOString(),
    },
  ],
};

function usersResponse() {
  return {
    members: [
      {
        id: 1,
        email: OWNER_EMAIL,
        role: "owner",
        custom_role_id: null,
        role_name: null,
        joined: true,
        joined_at: new Date().toISOString(),
        invited_at: new Date().toISOString(),
        invited_by_email: null,
        manager_member_id: null,
        manager_email: null,
      },
    ],
    me: {
      role: "owner",
      email: OWNER_EMAIL,
      allowedPages: null,
      customRoleId: null,
    },
  };
}

async function setupRoutes(
  page: import("@playwright/test").Page,
  opts: {
    summaryStatus?: number;
    summaryBody?: unknown;
  } = {},
) {
  const { summaryStatus = 200, summaryBody = MOCK_SUMMARY } = opts;

  await page.route("**/api/users**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(usersResponse()),
    });
  });

  await page.route("**/api/products?limit=500", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ products: MOCK_PRODUCTS }),
    });
  });

  await page.route("**/api/products/recipe-review-summary", async (route) => {
    await route.fulfill({
      status: summaryStatus,
      contentType: "application/json",
      body: summaryStatus === 200 ? JSON.stringify(summaryBody) : JSON.stringify({ error: "not found" }),
    });
  });
}

test.describe("Recipe Review Queue", () => {
  test("renders the page with product rows", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupRoutes(page);

    await page.goto("/recipe-review", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Product Recipes" })).toBeVisible({
      timeout: 15_000,
    });

    await expect(page.getByTestId("recipe-review-row-1")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("recipe-review-row-2")).toBeVisible();
    await expect(page.getByTestId("recipe-review-row-3")).toBeVisible();
  });

  test("resolves private product images through the authenticated storage URL", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupRoutes(page);

    await page.goto("/recipe-review", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Product Recipes" })).toBeVisible({
      timeout: 15_000,
    });
    const row2 = page.getByTestId("recipe-review-row-2");
    await expect(row2).toBeVisible({ timeout: 10_000 });

    await expect(row2.locator("img")).toHaveAttribute(
      "src",
      "/api/storage/objects/private/balloon-set.jpg",
    );
  });

  test("shows the shopping-bag placeholder when a product has no image", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupRoutes(page);

    await page.goto("/recipe-review", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Product Recipes" })).toBeVisible({
      timeout: 15_000,
    });
    const row1 = page.getByTestId("recipe-review-row-1");
    await expect(row1).toBeVisible({ timeout: 10_000 });

    await expect(row1.locator("img")).toHaveCount(0);
    await expect(row1.locator("svg.lucide-shopping-bag")).toHaveCount(1);
  });

  test("shows 'No recipe' badge for products without recipes", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupRoutes(page);

    await page.goto("/recipe-review", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Product Recipes" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("recipe-review-row-1")).toBeVisible({ timeout: 10_000 });

    // Products 1 and 3 have no recipe
    const row1 = page.getByTestId("recipe-review-row-1");
    await expect(row1.getByText("No recipe")).toBeVisible();

    const row3 = page.getByTestId("recipe-review-row-3");
    await expect(row3.getByText("No recipe")).toBeVisible();
  });

  test("shows 'Recipe set' badge for products with a recipe", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupRoutes(page);

    await page.goto("/recipe-review", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Product Recipes" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("recipe-review-row-2")).toBeVisible({ timeout: 10_000 });

    // Product 2 has a recipe (not in no-recipe list)
    const row2 = page.getByTestId("recipe-review-row-2");
    await expect(row2.getByText("Recipe set")).toBeVisible();
  });

  test("shows pending suggestion badge for products with an awaiting suggestion", async ({
    page,
  }) => {
    await setupClerkTestingToken({ page });
    await setupRoutes(page);

    await page.goto("/recipe-review", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Product Recipes" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("recipe-review-row-2")).toBeVisible({ timeout: 10_000 });

    // Product 2 has a pending suggestion
    const row2 = page.getByTestId("recipe-review-row-2");
    await expect(row2.getByText(/awaiting review/i)).toBeVisible();
  });

  test("'Review suggestion' link navigates to the product's recipe tab", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupRoutes(page);

    await page.goto("/recipe-review", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Product Recipes" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("recipe-review-row-2")).toBeVisible({ timeout: 10_000 });

    const openLink = page.getByTestId("recipe-review-open-2");
    await expect(openLink).toBeVisible();
    await expect(openLink).toHaveAttribute("href", "/products/2?tab=recipe");
  });

  test("'View recipe' link navigates to the product's recipe tab", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupRoutes(page);

    await page.goto("/recipe-review", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Product Recipes" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("recipe-review-row-1")).toBeVisible({ timeout: 10_000 });

    const openLink = page.getByTestId("recipe-review-open-1");
    await expect(openLink).toHaveAttribute("href", "/products/1?tab=recipe");
  });

  test("search filters products by name", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupRoutes(page);

    await page.goto("/recipe-review", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Product Recipes" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("recipe-review-row-1")).toBeVisible({ timeout: 10_000 });

    await page.getByPlaceholder("Search products…").fill("balloon");

    await expect(page.getByTestId("recipe-review-row-2")).toBeVisible();
    await expect(page.getByTestId("recipe-review-row-1")).not.toBeVisible();
    await expect(page.getByTestId("recipe-review-row-3")).not.toBeVisible();
  });

  test("'No recipe' filter shows only products without a recipe", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupRoutes(page);

    await page.goto("/recipe-review", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Product Recipes" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("recipe-review-row-1")).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: "No recipe" }).click();

    // Products 1 and 3 have no recipe; product 2 has one
    await expect(page.getByTestId("recipe-review-row-1")).toBeVisible();
    await expect(page.getByTestId("recipe-review-row-3")).toBeVisible();
    await expect(page.getByTestId("recipe-review-row-2")).not.toBeVisible();
  });

  test("'Pending suggestion' filter shows only products with an awaiting suggestion", async ({
    page,
  }) => {
    await setupClerkTestingToken({ page });
    await setupRoutes(page);

    await page.goto("/recipe-review", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Product Recipes" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("recipe-review-row-1")).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: "Pending suggestion" }).click();

    await expect(page.getByTestId("recipe-review-row-2")).toBeVisible();
    await expect(page.getByTestId("recipe-review-row-1")).not.toBeVisible();
    await expect(page.getByTestId("recipe-review-row-3")).not.toBeVisible();
  });

  test("shows empty state for 'Pending suggestion' filter when there are none", async ({
    page,
  }) => {
    await setupClerkTestingToken({ page });
    await setupRoutes(page, {
      summaryBody: {
        attention_count: 0,
        products_without_recipe: [],
        products_with_pending_suggestion: [],
      },
    });

    await page.goto("/recipe-review", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Product Recipes" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("recipe-review-row-1")).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: "Pending suggestion" }).click();

    await expect(
      page.getByText(/no products have a pending suggestion/i),
    ).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole("button", { name: "Show all" })).toBeVisible();
  });

  test("stat cards display correct counts when summary is available", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupRoutes(page);

    await page.goto("/recipe-review", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Product Recipes" })).toBeVisible({
      timeout: 15_000,
    });

    // Total products = 3
    await expect(page.getByText("3").first()).toBeVisible({ timeout: 10_000 });
    // No recipe = 2
    await expect(page.getByText("2")).toBeVisible();
    // Pending suggestions = 1
    await expect(page.getByText("1")).toBeVisible();
  });

  test("shows warning banner when summary endpoint is unavailable", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupRoutes(page, { summaryStatus: 404 });

    await page.goto("/recipe-review", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Product Recipes" })).toBeVisible({
      timeout: 15_000,
    });

    // Wait for products to load and summary to fail
    await expect(page.getByTestId("recipe-review-row-1")).toBeVisible({ timeout: 10_000 });

    await expect(
      page.getByText(/recipe status summary is not yet available/i),
    ).toBeVisible({ timeout: 5_000 });
  });

  test("keeps the current Product Recipes route while the Products disclosure is toggled", async ({
    page,
  }) => {
    await setupClerkTestingToken({ page });
    await setupRoutes(page);

    await page.goto("/recipe-review", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Product Recipes" })).toBeVisible({
      timeout: 15_000,
    });

    const productsLink = page.getByTestId("nav-products");
    const productsToggle = page.getByTestId("nav-products-toggle");
    await expect(productsLink).toHaveAttribute("href", "/products");
    await expect(productsToggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("nav-product-recipes")).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId("recipe-attention-badge")).toHaveText("3");

    await productsToggle.click();
    await expect(productsToggle).toHaveAttribute("aria-expanded", "false");
    await expect(page).toHaveURL(/\/recipe-review$/);
    await expect(page.getByTestId("nav-product-recipes")).toBeHidden();

    await productsToggle.click();
    await expect(productsToggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("nav-product-recipes")).toBeVisible();
  });
});
