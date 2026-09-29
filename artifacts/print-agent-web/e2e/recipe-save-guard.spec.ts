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
  { base_item_id: 1, name: "Item Alpha", code: "A01", image_url: null, quantity: "1" },
  { base_item_id: 2, name: "Item Beta", code: "B01", image_url: null, quantity: "2" },
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

async function setupRoutes(
  page: import("@playwright/test").Page,
  onRecipePut?: (body: unknown) => void,
) {
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
      if (onRecipePut) onRecipePut(route.request().postDataJSON());
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

test.describe("Recipe Save guard", () => {
  test("clicking Save with a zero quantity does NOT call the recipe API", async ({ page }) => {
    await setupClerkTestingToken({ page });

    let recipePutCalled = false;
    await setupRoutes(page, () => {
      recipePutCalled = true;
    });

    await page.goto("/products/42", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Test Product" })).toBeVisible({ timeout: 15_000 });
    await navigateToEditRecipeTab(page);
    await expect(page.getByTestId("recipe-row-1")).toBeVisible({ timeout: 10_000 });

    const qtyInput = page.getByTestId("recipe-row-1").locator("input[type='number']");
    await qtyInput.fill("0");

    await page.getByTestId("save-button-wrapper").dispatchEvent("mousedown");

    await page.waitForTimeout(500);

    expect(recipePutCalled).toBe(false);
  });

  test("clicking Save with a blank quantity does NOT call the recipe API", async ({ page }) => {
    await setupClerkTestingToken({ page });

    let recipePutCalled = false;
    await setupRoutes(page, () => {
      recipePutCalled = true;
    });

    await page.goto("/products/42", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Test Product" })).toBeVisible({ timeout: 15_000 });
    await navigateToEditRecipeTab(page);
    await expect(page.getByTestId("recipe-row-1")).toBeVisible({ timeout: 10_000 });

    const qtyInput = page.getByTestId("recipe-row-1").locator("input[type='number']");
    await qtyInput.fill("");

    await page.getByTestId("save-button-wrapper").dispatchEvent("mousedown");

    await page.waitForTimeout(500);

    expect(recipePutCalled).toBe(false);
  });

  test("clicking Save with a negative quantity does NOT call the recipe API", async ({ page }) => {
    await setupClerkTestingToken({ page });

    let recipePutCalled = false;
    await setupRoutes(page, () => {
      recipePutCalled = true;
    });

    await page.goto("/products/42", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Test Product" })).toBeVisible({ timeout: 15_000 });
    await navigateToEditRecipeTab(page);
    await expect(page.getByTestId("recipe-row-1")).toBeVisible({ timeout: 10_000 });

    const qtyInput = page.getByTestId("recipe-row-1").locator("input[type='number']");
    await qtyInput.fill("-5");

    await page.getByTestId("save-button-wrapper").dispatchEvent("mousedown");

    await page.waitForTimeout(500);

    expect(recipePutCalled).toBe(false);
  });

  test("all invalid rows show their error message after a Save attempt", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupRoutes(page);

    await page.goto("/products/42", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Test Product" })).toBeVisible({ timeout: 15_000 });
    await navigateToEditRecipeTab(page);
    await expect(page.getByTestId("recipe-row-1")).toBeVisible({ timeout: 10_000 });

    const qtyInput1 = page.getByTestId("recipe-row-1").locator("input[type='number']");
    const qtyInput2 = page.getByTestId("recipe-row-2").locator("input[type='number']");

    await qtyInput1.fill("0");
    await qtyInput2.fill("-1");

    await page.getByTestId("save-button-wrapper").dispatchEvent("mousedown");

    const errorMessages = page.getByText("Must be greater than 0");
    await expect(errorMessages).toHaveCount(2, { timeout: 3_000 });
  });

  test("fixing all quantities allows the Save to proceed and calls the API", async ({ page }) => {
    await setupClerkTestingToken({ page });

    let capturedBody: unknown = null;
    await setupRoutes(page, (body) => {
      capturedBody = body;
    });

    await page.goto("/products/42", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Test Product" })).toBeVisible({ timeout: 15_000 });
    await navigateToEditRecipeTab(page);
    await expect(page.getByTestId("recipe-row-1")).toBeVisible({ timeout: 10_000 });

    const qtyInput1 = page.getByTestId("recipe-row-1").locator("input[type='number']");
    await qtyInput1.fill("0");

    await page.getByTestId("save-button-wrapper").dispatchEvent("mousedown");

    await expect(page.getByText("Must be greater than 0")).toBeVisible({ timeout: 3_000 });

    await qtyInput1.fill("3");

    await page.getByRole("button", { name: "Save" }).click();

    await expect(async () => {
      expect(capturedBody).not.toBeNull();
    }).toPass({ timeout: 8_000 });
  });
});
