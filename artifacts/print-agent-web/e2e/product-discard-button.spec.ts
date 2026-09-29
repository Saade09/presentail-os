import { test, expect } from "./fixtures";
import {
  ownerUsersResponse,
  setupProductsCommonRoutes,
} from "./helpers/productsCommonRoutes";

const MOCK_RECIPE = [
  { base_item_id: 1, name: "Item Alpha", code: "A01", image_url: null, quantity: "3" },
  { base_item_id: 2, name: "Item Beta", code: "B01", image_url: null, quantity: "5" },
];

const MOCK_BASE_ITEM = { id: 99, name: "Item Gamma", code: "G01", image_url: null };

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

async function setupRoutes(page: import("@playwright/test").Page) {
  await setupProductsCommonRoutes(page, {
    getUsersResponse: () => ownerUsersResponse("e2e-tester+clerk_test@presentail.com"),
  });

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
      body: JSON.stringify({ recipe: [] }),
    });
  });

  await page.route("**/api/products/categories**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ categories: [] }),
    });
  });

  await page.route("**/api/products/42/location-statuses", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ statuses: [] }),
    });
  });

  await page.route(/\/api\/base-items\b(?!\/)\??/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [], total: 0 }),
    });
  });

  await page.route("**/api/products/42", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ product: MOCK_PRODUCT, recipe: [] }),
    });
  });
}

/**
 * Navigate to a URL and wait for Clerk to finish loading + sign us in before
 * resolving.  The Clerk FAPI mock auto-fixture registers routes for
 * GET /v1/client and the token endpoint, but Clerk.js still has to fetch
 * /v1/environment + /v1/client at page load.  If `page.goto` resolves while
 * Clerk is still booting and the protected route guard sees `isSignedIn=false`
 * for one render, the app briefly redirects to `/sign-in`, after which the
 * Clerk listener pushes us back — but by then the 12s heading wait may have
 * already failed under load.
 *
 * This helper:
 *   1. Navigates with `domcontentloaded` (not `load`) so we don't wait on
 *      every async resource.
 *   2. Waits for `window.Clerk?.loaded === true && Clerk.user` so we know
 *      auth is settled before we assert visible UI.
 *   3. If the URL ended up on `/sign-in` (rare race where the redirect
 *      happened before Clerk hydrated), navigates back to the intended URL
 *      one more time.
 */
async function gotoAuthenticated(
  page: import("@playwright/test").Page,
  url: string,
) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => {
      const c = (window as unknown as { Clerk?: { loaded?: boolean; user?: unknown } }).Clerk;
      return Boolean(c?.loaded && c?.user);
    },
    null,
    { timeout: 15_000 },
  );
  if (/\/sign-in(\/|$|\?)/.test(new URL(page.url()).pathname)) {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => {
        const c = (window as unknown as { Clerk?: { loaded?: boolean; user?: unknown } }).Clerk;
        return Boolean(c?.loaded && c?.user);
      },
      null,
      { timeout: 10_000 },
    );
  }
}

/** Navigate to the product page and click Edit to enter edit mode. */
async function openEditMode(page: import("@playwright/test").Page) {
  await setupRoutes(page);
  await gotoAuthenticated(page, "/products/42");
  await expect(page.getByRole("heading", { name: "Test Product" })).toBeVisible({ timeout: 12_000 });
  await page.getByTestId("button-edit-product").click();
  const nameInput = page.locator("#pd-name");
  await expect(nameInput).toBeVisible({ timeout: 5_000 });
  return nameInput;
}

/** Set up routes that return a non-empty recipe (MOCK_RECIPE). */
async function setupRoutesWithRecipe(page: import("@playwright/test").Page) {
  await setupProductsCommonRoutes(page, {
    getUsersResponse: () => ownerUsersResponse("e2e-tester+clerk_test@presentail.com"),
  });

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

  await page.route("**/api/products/42/location-statuses", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ statuses: [] }),
    });
  });

  await page.route(/\/api\/base-items\b(?!\/)\??/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [], total: 0 }),
    });
  });

  await page.route("**/api/products/42", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ product: MOCK_PRODUCT, recipe: MOCK_RECIPE }),
    });
  });
}

/** Navigate to the product page, enter edit mode, and open the Recipe tab. */
async function openEditRecipeTab(page: import("@playwright/test").Page) {
  await setupRoutesWithRecipe(page);
  await gotoAuthenticated(page, "/products/42");
  await expect(page.getByRole("heading", { name: "Test Product" })).toBeVisible({ timeout: 12_000 });
  await page.getByTestId("button-edit-product").click();
  await page.getByRole("tab", { name: "Recipe" }).click();
  await expect(page.getByTestId("recipe-row-1")).toBeVisible({ timeout: 10_000 });
}

/**
 * Set up routes for a non-empty recipe AND a `/api/base-items` endpoint that
 * returns one selectable base item (MOCK_BASE_ITEM). The override route is
 * registered LAST so Playwright (which consults routes in reverse registration
 * order, newest first) uses it instead of the empty-list route registered by
 * `setupRoutesWithRecipe`.
 */
async function setupRoutesWithRecipeAndBaseItem(page: import("@playwright/test").Page) {
  await setupRoutesWithRecipe(page);
  await page.route(/\/api\/base-items\b(?!\/)\??/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [MOCK_BASE_ITEM], total: 1 }),
    });
  });
}

/** Navigate to the product page, enter edit mode, and open the Recipe tab with a selectable base item. */
async function openEditRecipeTabWithBaseItem(page: import("@playwright/test").Page) {
  await setupRoutesWithRecipeAndBaseItem(page);
  await gotoAuthenticated(page, "/products/42");
  await expect(page.getByRole("heading", { name: "Test Product" })).toBeVisible({ timeout: 12_000 });
  await page.getByTestId("button-edit-product").click();
  await page.getByRole("tab", { name: "Recipe" }).click();
  await expect(page.getByTestId("recipe-row-1")).toBeVisible({ timeout: 10_000 });
}

test.describe("ProductDetail Cancel (discard) button", () => {
  test("Cancel button is not visible before entering edit mode", async ({ page }) => {
    await setupRoutes(page);
    await gotoAuthenticated(page, "/products/42");
    await expect(page.getByRole("heading", { name: "Test Product" })).toBeVisible({ timeout: 12_000 });

    const cancelButton = page.getByRole("button", { name: /^Cancel$/i });
    await expect(cancelButton).not.toBeVisible();
  });

  test("Cancel button appears after entering edit mode", async ({ page }) => {
    await openEditMode(page);
    const cancelButton = page.getByRole("button", { name: /^Cancel$/i });
    await expect(cancelButton).toBeVisible({ timeout: 5_000 });
  });

  test("clicking Cancel resets the name field to its original value", async ({ page }) => {
    const nameInput = await openEditMode(page);
    await expect(nameInput).toHaveValue("Test Product");

    await nameInput.fill("Modified Name");
    await expect(nameInput).toHaveValue("Modified Name");

    await page.getByRole("button", { name: /^Cancel$/i }).click();

    await expect(nameInput).not.toBeVisible();
    await expect(page.getByRole("heading", { name: "Test Product" })).toBeVisible();
  });

  test("clicking Cancel exits edit mode and hides the Cancel button", async ({ page }) => {
    await openEditMode(page);

    const cancelButton = page.getByRole("button", { name: /^Cancel$/i });
    await expect(cancelButton).toBeVisible({ timeout: 5_000 });

    await cancelButton.click();

    await expect(cancelButton).not.toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("button-edit-product")).toBeVisible({ timeout: 5_000 });
  });

  test("clicking Cancel clears a visible name validation error", async ({ page }) => {
    const nameInput = await openEditMode(page);

    await nameInput.fill("");
    await nameInput.blur();

    await expect(page.getByText("Required", { exact: true })).toBeVisible({ timeout: 5_000 });

    await page.getByRole("button", { name: /^Cancel$/i }).click();

    await expect(page.getByText("Required", { exact: true })).not.toBeVisible();
    await expect(page.getByRole("heading", { name: "Test Product" })).toBeVisible();
  });

  test("clicking Cancel clears a validation error triggered via the Save button", async ({ page }) => {
    const nameInput = await openEditMode(page);

    await nameInput.fill("");

    await page.getByTestId("save-button-wrapper").dispatchEvent("mousedown");

    await expect(page.getByText("Required", { exact: true })).toBeVisible({ timeout: 5_000 });

    await page.getByRole("button", { name: /^Cancel$/i }).click();

    await expect(page.getByText("Required", { exact: true })).not.toBeVisible();
    await expect(page.getByRole("heading", { name: "Test Product" })).toBeVisible();
  });

  test("clicking Cancel restores a cleared USD price field to its original value", async ({ page }) => {
    await openEditMode(page);

    const usdInput = page.locator("#pd-price-usd");
    await expect(usdInput).toHaveValue("10.00");

    await usdInput.fill("");
    await expect(usdInput).toHaveValue("");

    await page.getByRole("button", { name: /^Cancel$/i }).click();

    await expect(usdInput).not.toBeVisible();
    await expect(page.getByTestId("button-edit-product")).toBeVisible({ timeout: 5_000 });

    // Re-enter edit mode and confirm the original USD price is restored in the form.
    await page.getByTestId("button-edit-product").click();
    await expect(page.locator("#pd-price-usd")).toHaveValue("10.00", { timeout: 5_000 });
  });

  test("clicking Cancel restores a cleared AED price field to its original value", async ({ page }) => {
    await openEditMode(page);

    const aedInput = page.locator("#pd-price-aed");
    await expect(aedInput).toHaveValue("36.72");

    await aedInput.fill("");
    await expect(aedInput).toHaveValue("");

    await page.getByRole("button", { name: /^Cancel$/i }).click();

    await expect(aedInput).not.toBeVisible();
    await expect(page.getByTestId("button-edit-product")).toBeVisible({ timeout: 5_000 });

    // Re-enter edit mode and confirm the original AED price is restored in the form.
    await page.getByTestId("button-edit-product").click();
    await expect(page.locator("#pd-price-aed")).toHaveValue("36.72", { timeout: 5_000 });
  });

  test("clicking Cancel clears a visible USD price validation error", async ({ page }) => {
    await openEditMode(page);

    const usdInput = page.locator("#pd-price-usd");
    await usdInput.fill("");
    await usdInput.blur();

    await expect(page.locator("#pd-price-usd + p")).toHaveText("Required", { timeout: 5_000 });
    await expect(usdInput).toHaveClass(/border-destructive/);

    await page.getByRole("button", { name: /^Cancel$/i }).click();

    await expect(page.locator("#pd-price-usd + p")).not.toBeAttached();
    await expect(usdInput).not.toBeVisible();
    await expect(page.getByTestId("button-edit-product")).toBeVisible({ timeout: 5_000 });

    // Re-enter edit mode and confirm the price error does not reappear (touched state was reset).
    await page.getByTestId("button-edit-product").click();
    await expect(page.locator("#pd-price-usd")).toHaveValue("10.00", { timeout: 5_000 });
    await expect(page.locator("#pd-price-usd + p")).not.toBeAttached();
    await expect(page.locator("#pd-price-usd")).not.toHaveClass(/border-destructive/);
  });

  test("clicking Cancel clears a visible AED price validation error", async ({ page }) => {
    await openEditMode(page);

    const aedInput = page.locator("#pd-price-aed");
    await aedInput.fill("");
    await aedInput.blur();

    await expect(page.locator("#pd-price-aed + p")).toHaveText("Required", { timeout: 5_000 });
    await expect(aedInput).toHaveClass(/border-destructive/);

    await page.getByRole("button", { name: /^Cancel$/i }).click();

    await expect(page.locator("#pd-price-aed + p")).not.toBeAttached();
    await expect(aedInput).not.toBeVisible();
    await expect(page.getByTestId("button-edit-product")).toBeVisible({ timeout: 5_000 });

    // Re-enter edit mode and confirm the price error does not reappear (touched state was reset).
    await page.getByTestId("button-edit-product").click();
    await expect(page.locator("#pd-price-aed")).toHaveValue("36.72", { timeout: 5_000 });
    await expect(page.locator("#pd-price-aed + p")).not.toBeAttached();
    await expect(page.locator("#pd-price-aed")).not.toHaveClass(/border-destructive/);
  });

  test("clicking Cancel restores an edited recipe quantity to its original value", async ({ page }) => {
    await openEditRecipeTab(page);

    const qtyInput = page.getByTestId("recipe-row-1").locator('input[type="number"]');
    await expect(qtyInput).toHaveValue("3");

    await qtyInput.fill("99");
    await expect(qtyInput).toHaveValue("99");

    await page.getByRole("button", { name: /^Cancel$/i }).click();

    await expect(page.getByTestId("button-edit-product")).toBeVisible({ timeout: 5_000 });

    // Re-enter edit mode, navigate to the Recipe tab, and confirm the quantity was restored.
    await page.getByTestId("button-edit-product").click();
    await page.getByRole("tab", { name: "Recipe" }).click();
    await expect(page.getByTestId("recipe-row-1")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("recipe-row-1").locator('input[type="number"]')).toHaveValue("3");
  });

  test("clicking Cancel restores the original recipe order after a keyboard reorder", async ({ page }) => {
    await openEditRecipeTab(page);

    const rows = page.locator("[data-testid^='recipe-row-']");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toHaveAttribute("data-testid", "recipe-row-1");
    await expect(rows.nth(1)).toHaveAttribute("data-testid", "recipe-row-2");

    // Reorder: move Item Alpha (base_item_id 1) down one slot using the
    // dnd-kit keyboard sensor (Space to pick up, ArrowDown to move, Space to drop).
    const handle = page.getByTestId("recipe-drag-handle-1");
    await handle.focus();
    await page.waitForTimeout(150);

    await page.keyboard.press("Space");
    await expect(page.getByTestId("recipe-row-1")).toHaveCSS("opacity", "0.5", { timeout: 5_000 });
    await page.waitForTimeout(200);
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(100);
    await page.keyboard.press("Space");

    // Confirm the reorder took effect locally before clicking Cancel.
    await expect(rows.nth(0)).toHaveAttribute("data-testid", "recipe-row-2");
    await expect(rows.nth(1)).toHaveAttribute("data-testid", "recipe-row-1");

    await page.getByRole("button", { name: /^Cancel$/i }).click();

    await expect(page.getByTestId("button-edit-product")).toBeVisible({ timeout: 5_000 });

    // Re-enter edit mode, navigate to the Recipe tab, and confirm the original
    // server-fetched order (base_item_id 1, then 2) was restored.
    await page.getByTestId("button-edit-product").click();
    await page.getByRole("tab", { name: "Recipe" }).click();
    await expect(page.getByTestId("recipe-row-1")).toBeVisible({ timeout: 10_000 });

    const rowsAfter = page.locator("[data-testid^='recipe-row-']");
    await expect(rowsAfter).toHaveCount(2);
    await expect(rowsAfter.nth(0)).toHaveAttribute("data-testid", "recipe-row-1");
    await expect(rowsAfter.nth(1)).toHaveAttribute("data-testid", "recipe-row-2");
  });

  test("clicking Cancel removes a newly-added recipe item", async ({ page }) => {
    await openEditRecipeTabWithBaseItem(page);

    await expect(page.getByTestId("recipe-row-1")).toBeVisible();
    await expect(page.getByTestId("recipe-row-2")).toBeVisible();

    await page.getByRole("button", { name: /Add base item/i }).click();
    await expect(page.getByPlaceholder("Search base items…")).toBeVisible({ timeout: 5_000 });

    await page.getByRole("option", { name: /Item Gamma/ }).click();

    await expect(page.getByTestId("recipe-row-99")).toBeVisible({ timeout: 5_000 });

    await page.getByRole("button", { name: /^Cancel$/i }).click();

    await expect(page.getByTestId("button-edit-product")).toBeVisible({ timeout: 5_000 });

    // Re-enter edit mode, navigate to the Recipe tab, and confirm the added item is gone.
    await page.getByTestId("button-edit-product").click();
    await page.getByRole("tab", { name: "Recipe" }).click();
    await expect(page.getByTestId("recipe-row-1")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("recipe-row-2")).toBeVisible();
    await expect(page.getByTestId("recipe-row-99")).not.toBeAttached();
  });

  test("clicking Cancel restores a recipe item that was removed during editing", async ({ page }) => {
    await openEditRecipeTab(page);

    await expect(page.getByTestId("recipe-row-1")).toBeVisible();
    await expect(page.getByTestId("recipe-row-2")).toBeVisible();

    // Remove Item Alpha (base_item_id 1).
    await page.getByTestId("recipe-row-1").getByTitle("Remove").click();
    await expect(page.getByTestId("recipe-row-1")).not.toBeAttached({ timeout: 5_000 });

    await page.getByRole("button", { name: /^Cancel$/i }).click();

    await expect(page.getByTestId("button-edit-product")).toBeVisible({ timeout: 5_000 });

    // Re-enter edit mode, navigate to the Recipe tab, and confirm both items are back.
    await page.getByTestId("button-edit-product").click();
    await page.getByRole("tab", { name: "Recipe" }).click();
    await expect(page.getByTestId("recipe-row-1")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("recipe-row-2")).toBeVisible();
  });
});
