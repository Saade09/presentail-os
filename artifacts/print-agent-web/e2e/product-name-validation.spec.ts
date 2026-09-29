import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import { setupProductsCommonRoutes } from "./helpers/productsCommonRoutes";

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

const MOCK_RECIPE: unknown[] = [];

async function setupRoutes(
  page: import("@playwright/test").Page,
  onPatch?: (body: unknown) => void,
) {
  await setupClerkTestingToken({ page });

  await setupProductsCommonRoutes(page);

  await page.route("**/api/brands**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ brands: [] }),
    });
  });

  await page.route("**/api/products/42/recipe**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ recipe: MOCK_RECIPE }),
    });
  });

  await page.route("**/api/products/categories**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ categories: [] }),
    });
  });

  await page.route("**/api/products/42", async (route) => {
    if (route.request().method() === "PATCH") {
      if (onPatch) onPatch(route.request().postDataJSON());
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

test.describe("ProductDetail name validation", () => {
  test("blurring the name input while empty shows a Required error and a red border", async ({
    page,
  }) => {
    await setupRoutes(page);

    await page.goto("/products/42", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Test Product" })).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("button-edit-product").click();

    const nameInput = page.locator("#pd-name");
    await expect(nameInput).toBeVisible({ timeout: 12_000 });
    await expect(nameInput).toHaveValue("Test Product");

    await nameInput.fill("");
    await nameInput.blur();

    await expect(page.getByText("Required", { exact: true })).toBeVisible({
      timeout: 5_000,
    });

    await expect(nameInput).toHaveClass(/border-destructive/);
  });

  test("Save button is disabled when the name is empty", async ({ page }) => {
    await setupRoutes(page);

    await page.goto("/products/42", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Test Product" })).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("button-edit-product").click();

    const nameInput = page.locator("#pd-name");
    await expect(nameInput).toBeVisible({ timeout: 12_000 });

    await nameInput.fill("");
    await nameInput.blur();

    await expect(page.getByText("Required", { exact: true })).toBeVisible({
      timeout: 5_000,
    });

    const saveButton = page.getByRole("button", { name: /^Save$/i });
    await expect(saveButton).toBeDisabled();
  });

  test("re-typing a valid name clears the Required error", async ({ page }) => {
    await setupRoutes(page);

    await page.goto("/products/42", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Test Product" })).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("button-edit-product").click();

    const nameInput = page.locator("#pd-name");
    await expect(nameInput).toBeVisible({ timeout: 12_000 });

    await nameInput.fill("");
    await nameInput.blur();

    await expect(page.getByText("Required", { exact: true })).toBeVisible({
      timeout: 5_000,
    });

    await nameInput.fill("Updated Name");

    await expect(page.getByText("Required", { exact: true })).not.toBeVisible();
    await expect(nameInput).not.toHaveClass(/border-destructive/);
  });

  test("clicking Save with a blank name does NOT call the PATCH API", async ({ page }) => {
    let patchCalled = false;
    await setupRoutes(page, () => {
      patchCalled = true;
    });

    await page.goto("/products/42", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Test Product" })).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("button-edit-product").click();

    const nameInput = page.locator("#pd-name");
    await expect(nameInput).toBeVisible({ timeout: 12_000 });

    await nameInput.fill("");

    await page.getByTestId("save-button-wrapper").dispatchEvent("mousedown");

    await page.waitForTimeout(500);

    expect(patchCalled).toBe(false);
  });

  test("Required error appears for name after clicking Save with a blank name", async ({ page }) => {
    await setupRoutes(page);

    await page.goto("/products/42", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Test Product" })).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("button-edit-product").click();

    const nameInput = page.locator("#pd-name");
    await expect(nameInput).toBeVisible({ timeout: 12_000 });

    await nameInput.fill("");

    await page.getByTestId("save-button-wrapper").dispatchEvent("mousedown");

    await expect(page.getByText("Required", { exact: true })).toBeVisible({ timeout: 5_000 });
  });

  test("filling in a valid name after clearing it and clicking Save calls the PATCH API", async ({ page }) => {
    let capturedBody: unknown = null;
    await setupRoutes(page, (body) => {
      capturedBody = body;
    });

    await page.goto("/products/42", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Test Product" })).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("button-edit-product").click();

    const nameInput = page.locator("#pd-name");
    await expect(nameInput).toBeVisible({ timeout: 12_000 });

    await nameInput.fill("");
    await nameInput.blur();

    await expect(page.getByText("Required", { exact: true })).toBeVisible({ timeout: 5_000 });

    await nameInput.fill("Updated Product Name");

    await page.getByRole("button", { name: /^Save$/i }).click();

    await expect(async () => {
      expect(capturedBody).not.toBeNull();
    }).toPass({ timeout: 8_000 });
  });
});
