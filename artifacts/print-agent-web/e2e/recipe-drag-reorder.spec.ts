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
  { base_item_id: 2, name: "Item Beta",  code: "B01", image_url: null, quantity: "2" },
  { base_item_id: 3, name: "Item Gamma", code: "G01", image_url: null, quantity: "3" },
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
    if (route.request().method() !== "PUT") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ recipe: MOCK_RECIPE }),
    });
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

test.describe("Recipe drag-to-reorder", () => {
  test("read-only recipe item links navigate to the matching base item", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupRoutes(page);
    await page.goto("/products/42", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Test Product" })).toBeVisible({ timeout: 15_000 });

    await page.getByRole("tab", { name: "Recipe" }).click();
    await expect(page.getByTestId("recipe-base-item-link-1")).toBeVisible({ timeout: 10_000 });

    await expect(page.getByTestId("recipe-base-item-link-1")).toHaveAttribute("href", "/base-items/1");
    await expect(page.getByTestId("recipe-base-item-link-2")).toHaveAttribute("href", "/base-items/2");
    await page.getByTestId("recipe-base-item-link-2").click();

    await expect(page).toHaveURL(/\/base-items\/2$/);
  });

  test("editable recipe item links navigate without affecting the drag handle", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupRoutes(page);
    await page.goto("/products/42", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Test Product" })).toBeVisible({ timeout: 15_000 });

    await navigateToEditRecipeTab(page);
    await expect(page.getByTestId("recipe-base-item-link-1")).toBeVisible({ timeout: 10_000 });

    await expect(page.getByTestId("recipe-base-item-link-3")).toHaveAttribute("href", "/base-items/3");
    await expect(page.getByTestId("recipe-drag-handle-3")).toBeVisible();
    await expect(page.getByTestId("recipe-row-3").locator('input[type="number"]')).toHaveValue("3");

    await page.getByTestId("recipe-base-item-link-3").click();
    await expect(page).toHaveURL(/\/base-items\/3$/);
  });

  test("drag handle buttons are visible for owner on product detail page", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupRoutes(page);
    await page.goto("/products/42", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Test Product" })).toBeVisible({ timeout: 15_000 });
    await navigateToEditRecipeTab(page);

    const rowAlpha = page.getByTestId("recipe-row-1");
    await expect(rowAlpha).toBeVisible({ timeout: 10_000 });

    const handleAlpha = page.getByTestId("recipe-drag-handle-1");
    const handleBeta  = page.getByTestId("recipe-drag-handle-2");
    const handleGamma = page.getByTestId("recipe-drag-handle-3");

    await expect(handleAlpha).toBeVisible();
    await expect(handleBeta).toBeVisible();
    await expect(handleGamma).toBeVisible();
  });

  test("keyboard reorder moves a recipe item down one position", async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupRoutes(page);
    await page.goto("/products/42", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Test Product" })).toBeVisible({ timeout: 15_000 });
    await navigateToEditRecipeTab(page);

    await expect(page.getByTestId("recipe-row-1")).toBeVisible({ timeout: 10_000 });

    const rows = page.locator("[data-testid^='recipe-row-']");
    await expect(rows).toHaveCount(3);

    await expect(rows.nth(0)).toHaveAttribute("data-testid", "recipe-row-1");
    await expect(rows.nth(1)).toHaveAttribute("data-testid", "recipe-row-2");
    await expect(rows.nth(2)).toHaveAttribute("data-testid", "recipe-row-3");

    const handle = page.getByTestId("recipe-drag-handle-1");
    await handle.focus();
    // Allow the component to fully settle after the initial assertions and
    // focus change before sending keyboard events to the drag handle.  Without
    // this brief pause, dnd-kit's KeyboardSensor occasionally misses the first
    // Space keydown and the row order does not change.
    await page.waitForTimeout(150);

    await page.keyboard.press("Space");
    await expect(page.getByTestId("recipe-row-1")).toHaveCSS("opacity", "0.5", { timeout: 5_000 });
    await page.waitForTimeout(200);
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(100);
    await page.keyboard.press("Space");

    await expect(rows.nth(0)).toHaveAttribute("data-testid", "recipe-row-2");
    await expect(rows.nth(1)).toHaveAttribute("data-testid", "recipe-row-1");
    await expect(rows.nth(2)).toHaveAttribute("data-testid", "recipe-row-3");
  });

  test("saving after reorder sends correct sort_order values in PUT request", async ({ page }) => {
    await setupClerkTestingToken({ page });

    let capturedRecipeBody: { items: Array<{ base_item_id: number; sort_order: number }> } | null = null;

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
        const body = route.request().postDataJSON() as typeof capturedRecipeBody;
        capturedRecipeBody = body;
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

    await page.goto("/products/42", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Test Product" })).toBeVisible({ timeout: 15_000 });
    await navigateToEditRecipeTab(page);
    await expect(page.getByTestId("recipe-row-1")).toBeVisible({ timeout: 10_000 });

    const handle = page.getByTestId("recipe-drag-handle-1");
    await handle.focus();

    await page.keyboard.press("Space");
    await expect(page.getByTestId("recipe-row-1")).toHaveCSS("opacity", "0.5", { timeout: 5_000 });
    await page.waitForTimeout(200);
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(100);
    await page.keyboard.press("Space");

    const rows = page.locator("[data-testid^='recipe-row-']");
    await expect(rows.nth(0)).toHaveAttribute("data-testid", "recipe-row-2");

    await page.getByRole("button", { name: "Save" }).click();

    await expect(async () => {
      expect(capturedRecipeBody).not.toBeNull();
    }).toPass({ timeout: 8_000 });

    const items = capturedRecipeBody!.items;

    const alphaEntry = items.find((it) => it.base_item_id === 1);
    const betaEntry  = items.find((it) => it.base_item_id === 2);

    expect(alphaEntry).toBeDefined();
    expect(betaEntry).toBeDefined();
    expect(betaEntry!.sort_order).toBeLessThan(alphaEntry!.sort_order);
  });
});
