import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";

const OWNER_EMAIL = "e2e-tester@presentail.com";

const MOCK_PRODUCT = {
  id: 42,
  workspace_owner_id: "user_1",
  name: "Test Product",
  price_usd: "10.00",
  price_aed: "36.72",
  main_image_url: null,
  additional_image_urls: [],
  description: null,
  status: "available",
  brand: null,
  tags: [],
  category: null,
  sku: null,
  created_at: new Date().toISOString(),
};

const MOCK_RECIPE = [
  { base_item_id: 1, name: "Item Alpha", code: "A01", image_url: null, quantity: "2" },
];

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

async function setupRoutes(page: import("@playwright/test").Page) {
  await page.route("**/api/users**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(usersResponse()),
    });
  });

  await page.route("**/api/brands**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ brands: [] }),
    });
  });

  await page.route("**/api/products/42/recipe", async (route) => {
    if (route.request().method() === "PUT") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ recipe: MOCK_RECIPE }),
      });
      return;
    }
    await route.continue();
  });

  await page.route("**/api/products/42", async (route) => {
    if (route.request().method() === "PATCH") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ product: MOCK_PRODUCT }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ product: MOCK_PRODUCT, recipe: MOCK_RECIPE }),
    });
  });

  await page.route("**/api/products/42/location-statuses", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ statuses: [] }) });
  });
}

async function navigateToEditRecipeTab(page: import("@playwright/test").Page) {
  await page.getByTestId("button-edit-product").click();
  await page.getByRole("tab", { name: "Recipe" }).click();
}

test.describe("Recipe quantity validation", () => {
  test("clearing the quantity field disables the Save button", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupRoutes(page);
    await page.goto("/products/42", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Test Product" })).toBeVisible({ timeout: 15_000 });
    await navigateToEditRecipeTab(page);

    await expect(page.getByTestId("recipe-row-1")).toBeVisible({ timeout: 10_000 });

    const qtyInput = page.getByTestId("recipe-row-1").locator('input[type="number"]');
    const saveButton = page.getByRole("button", { name: "Save" });

    await qtyInput.fill("");

    await expect(saveButton).toBeDisabled();
  });

  test("setting quantity to zero disables the Save button", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupRoutes(page);
    await page.goto("/products/42", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Test Product" })).toBeVisible({ timeout: 15_000 });
    await navigateToEditRecipeTab(page);

    await expect(page.getByTestId("recipe-row-1")).toBeVisible({ timeout: 10_000 });

    const qtyInput = page.getByTestId("recipe-row-1").locator('input[type="number"]');
    const saveButton = page.getByRole("button", { name: "Save" });

    await qtyInput.fill("0");

    await expect(saveButton).toBeDisabled();
  });

  test("an empty quantity shows a validation error message", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupRoutes(page);
    await page.goto("/products/42", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Test Product" })).toBeVisible({ timeout: 15_000 });
    await navigateToEditRecipeTab(page);

    await expect(page.getByTestId("recipe-row-1")).toBeVisible({ timeout: 10_000 });

    const qtyInput = page.getByTestId("recipe-row-1").locator('input[type="number"]');

    await qtyInput.fill("");
    await qtyInput.blur();

    const errorMessage = page.getByTestId("recipe-row-1").getByText("Must be greater than 0");
    await expect(errorMessage).toBeVisible();
  });

  test("restoring a valid quantity re-enables the Save button", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupRoutes(page);
    await page.goto("/products/42", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Test Product" })).toBeVisible({ timeout: 15_000 });
    await navigateToEditRecipeTab(page);

    await expect(page.getByTestId("recipe-row-1")).toBeVisible({ timeout: 10_000 });

    const qtyInput = page.getByTestId("recipe-row-1").locator('input[type="number"]');
    const saveButton = page.getByRole("button", { name: "Save" });

    await qtyInput.fill("");
    await expect(saveButton).toBeDisabled();

    await qtyInput.fill("3");
    await expect(saveButton).toBeEnabled();
  });

  test("a negative quantity disables the Save button", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupRoutes(page);
    await page.goto("/products/42", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Test Product" })).toBeVisible({ timeout: 15_000 });
    await navigateToEditRecipeTab(page);

    await expect(page.getByTestId("recipe-row-1")).toBeVisible({ timeout: 10_000 });

    const qtyInput = page.getByTestId("recipe-row-1").locator('input[type="number"]');
    const saveButton = page.getByRole("button", { name: "Save" });

    await qtyInput.fill("-1");
    await expect(saveButton).toBeDisabled();
  });
});
