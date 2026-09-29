import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import { setupBrandsCommonRoutes } from "./helpers/brandsCommonRoutes";

const MOCK_BRANDS = {
  brands: [
    {
      id: 1,
      name: "Acme Brand",
      description: null,
      target_cogs: null,
      sticker_count: "0",
      product_count: "0",
      has_logo: false,
      created_at: new Date().toISOString(),
    },
    {
      id: 2,
      name: "Globex Brand",
      description: null,
      target_cogs: null,
      sticker_count: "0",
      product_count: "0",
      has_logo: false,
      created_at: new Date().toISOString(),
    },
  ],
  workspaceJobCount: 0,
};

async function setupBrandsPage(page: import("@playwright/test").Page) {
  await setupClerkTestingToken({ page });

  await setupBrandsCommonRoutes(page);

  await page.route("**/api/brands", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(MOCK_BRANDS),
      });
    } else {
      await route.continue();
    }
  });

  await page.goto("/brands", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Brands" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Acme Brand")).toBeVisible({ timeout: 12_000 });
}

test.describe("Brands list — create dialog whitespace validation", () => {
  test.beforeEach(async ({ page }) => {
    await setupBrandsPage(page);
    await page.getByRole("button", { name: /(New Brand|brands\.newBrand)/i }).first().click();
    await expect(page.getByLabel(/Brand name/i)).toBeVisible({ timeout: 4_000 });
  });

  test("shows the whitespace error when the name is all spaces", async ({ page }) => {
    await page.getByLabel(/Brand name/i).fill("   ");

    const error = page.getByTestId("name-error-whitespace");
    await expect(error).toBeVisible({ timeout: 3_000 });
    await expect(error).toContainText("Brand name cannot be blank.");
  });

  test("disables the Create button when the name is all spaces", async ({ page }) => {
    await page.getByLabel(/Brand name/i).fill("   ");

    await expect(page.getByRole("button", { name: /^Create$/i })).toBeDisabled();
  });
});

test.describe("Brands list — rename dialog whitespace validation", () => {
  test.beforeEach(async ({ page }) => {
    await setupBrandsPage(page);
    await page.getByTestId("button-rename-brand-1").click();
    await expect(page.getByTestId("input-brand-rename")).toBeVisible({ timeout: 4_000 });
  });

  test("shows the whitespace error when the rename field is all spaces", async ({ page }) => {
    await page.getByTestId("input-brand-rename").fill("   ");

    const error = page.getByTestId("rename-error-whitespace");
    await expect(error).toBeVisible({ timeout: 3_000 });
    await expect(error).toContainText("Brand name cannot be blank.");
  });

  test("disables the Save button when the rename field is all spaces", async ({ page }) => {
    await page.getByTestId("input-brand-rename").fill("   ");

    await expect(page.getByRole("button", { name: /^Save$/i })).toBeDisabled();
  });
});
