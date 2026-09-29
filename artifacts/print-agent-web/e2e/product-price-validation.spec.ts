import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import { setupProductsCommonRoutes } from "./helpers/productsCommonRoutes";

const MOCK_PRODUCT = {
  id: 1,
  workspace_owner_id: "user_1",
  name: "Test Widget",
  price_usd: "12.50",
  price_aed: "45.89",
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

const MOCK_RECIPE: { recipe: unknown[] } = { recipe: [] };
const MOCK_BRANDS: { brands: unknown[] } = { brands: [] };
const MOCK_BASE_ITEMS = { items: [], total: 0 };

async function setupProductDetailPage(
  page: import("@playwright/test").Page,
  onPatch?: (body: unknown) => void,
) {
  await setupClerkTestingToken({ page });

  await setupProductsCommonRoutes(page);

  await page.route("**/api/products/1/recipe**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_RECIPE),
    });
  });

  await page.route("**/api/products/categories**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ categories: [] }),
    });
  });

  await page.route("**/api/products/1**", async (route) => {
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
      body: JSON.stringify({ product: MOCK_PRODUCT, recipe: [] }),
    });
  });

  await page.route("**/api/brands**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_BRANDS),
    });
  });

  await page.route(/\/api\/base-items\b(?!\/)\??/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_BASE_ITEMS),
    });
  });

  await page.route("**/api/products/1/location-statuses", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ statuses: [] }) });
  });

  await page.goto("/products/1", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Test Widget" })).toBeVisible({ timeout: 12_000 });
  await page.getByTestId("button-edit-product").click();
}

/**
 * Sets a non-numeric string value on a type="number" input by temporarily
 * switching it to type="text", filling the value (which triggers React's
 * onChange and updates the controlled component state), then restoring the
 * type so the browser no longer sanitizes the stored string.
 */
async function fillNonNumeric(
  page: import("@playwright/test").Page,
  inputId: string,
  value: string,
) {
  await page.evaluate((id) => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) el.type = "text";
  }, inputId);
  await page.locator(`#${inputId}`).fill(value);
  await page.evaluate((id) => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) el.type = "number";
  }, inputId);
}

test.describe("ProductDetail — price field validation", () => {
  test(
    "clearing the USD price and blurring shows Required error and red border",
    async ({ page }) => {
      await setupProductDetailPage(page);

      const usdInput = page.locator("#pd-price-usd");
      await expect(usdInput).toBeVisible();

      await usdInput.fill("");
      await usdInput.blur();

      await expect(page.locator("#pd-price-usd + p")).toHaveText("Required", { timeout: 4_000 });
      await expect(usdInput).toHaveClass(/border-destructive/);
    },
  );

  test(
    "clearing the AED price and blurring shows Required error and red border",
    async ({ page }) => {
      await setupProductDetailPage(page);

      const aedInput = page.locator("#pd-price-aed");
      await expect(aedInput).toBeVisible();

      await aedInput.fill("");
      await aedInput.blur();

      await expect(page.locator("#pd-price-aed + p")).toHaveText("Required", { timeout: 4_000 });
      await expect(aedInput).toHaveClass(/border-destructive/);
    },
  );

  test(
    "Save button is disabled when USD price is empty",
    async ({ page }) => {
      await setupProductDetailPage(page);

      const usdInput = page.locator("#pd-price-usd");
      await expect(usdInput).toBeVisible();

      await usdInput.fill("");
      await usdInput.blur();

      await expect(page.locator("#pd-price-usd + p")).toHaveText("Required", { timeout: 4_000 });

      const saveButton = page.getByRole("button", { name: /^Save$/i });
      await expect(saveButton).toBeDisabled();
    },
  );

  test(
    "Save button is disabled when AED price is empty",
    async ({ page }) => {
      await setupProductDetailPage(page);

      const aedInput = page.locator("#pd-price-aed");
      await expect(aedInput).toBeVisible();

      await aedInput.fill("");
      await aedInput.blur();

      await expect(page.locator("#pd-price-aed + p")).toHaveText("Required", { timeout: 4_000 });

      const saveButton = page.getByRole("button", { name: /^Save$/i });
      await expect(saveButton).toBeDisabled();
    },
  );

  test(
    "non-numeric USD price shows 'Must be a valid number' after blur",
    async ({ page }) => {
      await setupProductDetailPage(page);

      await fillNonNumeric(page, "pd-price-usd", "abc");
      await page.locator("#pd-price-usd").blur();

      await expect(page.locator("#pd-price-usd + p")).toHaveText(
        "Must be a valid number",
        { timeout: 4_000 },
      );
      await expect(page.locator("#pd-price-usd")).toHaveClass(/border-destructive/);
    },
  );

  test(
    "non-numeric AED price shows 'Must be a valid number' after blur",
    async ({ page }) => {
      await setupProductDetailPage(page);

      await fillNonNumeric(page, "pd-price-aed", "xyz");
      await page.locator("#pd-price-aed").blur();

      await expect(page.locator("#pd-price-aed + p")).toHaveText(
        "Must be a valid number",
        { timeout: 4_000 },
      );
      await expect(page.locator("#pd-price-aed")).toHaveClass(/border-destructive/);
    },
  );

  test(
    "re-typing a valid number after 'Must be a valid number' clears the USD error",
    async ({ page }) => {
      await setupProductDetailPage(page);

      await fillNonNumeric(page, "pd-price-usd", "abc");
      await page.locator("#pd-price-usd").blur();

      await expect(page.locator("#pd-price-usd + p")).toHaveText(
        "Must be a valid number",
        { timeout: 4_000 },
      );

      await page.locator("#pd-price-usd").fill("9.99");
      await page.locator("#pd-price-usd").blur();

      await expect(page.locator("#pd-price-usd + p")).not.toBeAttached({ timeout: 4_000 });
      await expect(page.locator("#pd-price-usd")).not.toHaveClass(/border-destructive/);
    },
  );

  test(
    "re-typing a valid number after 'Must be a valid number' clears the AED error",
    async ({ page }) => {
      await setupProductDetailPage(page);

      await fillNonNumeric(page, "pd-price-aed", "xyz");
      await page.locator("#pd-price-aed").blur();

      await expect(page.locator("#pd-price-aed + p")).toHaveText(
        "Must be a valid number",
        { timeout: 4_000 },
      );

      await page.locator("#pd-price-aed").fill("36.00");
      await page.locator("#pd-price-aed").blur();

      await expect(page.locator("#pd-price-aed + p")).not.toBeAttached({ timeout: 4_000 });
      await expect(page.locator("#pd-price-aed")).not.toHaveClass(/border-destructive/);
    },
  );

  test(
    "fixing a blank USD price clears the Required error",
    async ({ page }) => {
      await setupProductDetailPage(page);

      const usdInput = page.locator("#pd-price-usd");
      await expect(usdInput).toBeVisible();

      await usdInput.fill("");
      await usdInput.blur();
      await expect(page.locator("#pd-price-usd + p")).toHaveText("Required", { timeout: 4_000 });

      await usdInput.fill("9.99");
      await usdInput.blur();
      await expect(page.locator("#pd-price-usd + p")).not.toBeAttached({ timeout: 4_000 });
    },
  );

  test(
    "fixing a blank AED price clears the Required error",
    async ({ page }) => {
      await setupProductDetailPage(page);

      const aedInput = page.locator("#pd-price-aed");
      await expect(aedInput).toBeVisible();

      await aedInput.fill("");
      await aedInput.blur();
      await expect(page.locator("#pd-price-aed + p")).toHaveText("Required", { timeout: 4_000 });

      await aedInput.fill("36.00");
      await aedInput.blur();
      await expect(page.locator("#pd-price-aed + p")).not.toBeAttached({ timeout: 4_000 });
    },
  );

  test(
    "Required errors appear for name and price fields after a save attempt with invalid values",
    async ({ page }) => {
      await setupProductDetailPage(page);

      const nameInput = page.locator("#pd-name");
      const usdInput = page.locator("#pd-price-usd");
      await expect(nameInput).toBeVisible();
      await expect(usdInput).toBeVisible();

      await nameInput.fill("");
      await usdInput.fill("");

      await page.getByTestId("save-button-wrapper").dispatchEvent("mousedown");

      const requiredErrors = page.getByText("Required", { exact: true });
      await expect(requiredErrors).toHaveCount(2, { timeout: 5_000 });
    },
  );

  test(
    "clearing both USD and AED prices shows both errors, both red borders, and disables Save",
    async ({ page }) => {
      await setupProductDetailPage(page);

      const usdInput = page.locator("#pd-price-usd");
      const aedInput = page.locator("#pd-price-aed");
      await expect(usdInput).toBeVisible();
      await expect(aedInput).toBeVisible();

      await usdInput.fill("");
      await usdInput.blur();
      await aedInput.fill("");
      await aedInput.blur();

      await expect(page.locator("#pd-price-usd + p")).toHaveText("Required", { timeout: 4_000 });
      await expect(page.locator("#pd-price-aed + p")).toHaveText("Required", { timeout: 4_000 });
      await expect(usdInput).toHaveClass(/border-destructive/);
      await expect(aedInput).toHaveClass(/border-destructive/);

      const saveButton = page.getByRole("button", { name: /^Save$/i });
      await expect(saveButton).toBeDisabled();
    },
  );

  test(
    "filling in valid name and price values and clicking Save calls the PATCH API",
    async ({ page }) => {
      let capturedBody: unknown = null;
      await setupProductDetailPage(page, (body) => {
        capturedBody = body;
      });

      const usdInput = page.locator("#pd-price-usd");
      await expect(usdInput).toBeVisible();

      await usdInput.fill("");
      await usdInput.blur();
      await expect(page.locator("#pd-price-usd + p")).toHaveText("Required", { timeout: 4_000 });

      await usdInput.fill("19.99");
      await usdInput.blur();
      await expect(page.locator("#pd-price-usd + p")).not.toBeAttached({ timeout: 4_000 });

      await page.getByRole("button", { name: /^Save$/i }).click();

      await expect(async () => {
        expect(capturedBody).not.toBeNull();
      }).toPass({ timeout: 8_000 });
    },
  );
});
