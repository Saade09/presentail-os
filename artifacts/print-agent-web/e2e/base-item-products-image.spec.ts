import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";

const BASE_ITEM_ID = 42;

const MOCK_BASE_ITEM = {
  item: {
    id: BASE_ITEM_ID,
    workspace_owner_id: "user_test",
    name: "Red Roses",
    code: "ATEST1",
    image_url: null,
    category_id: null,
    alternate_name: null,
    accounting_category: null,
    tax_rate: null,
    created_at: "2024-01-01T00:00:00.000Z",
    main_category_name: null,
    sub_category_name: null,
  },
};

const PRODUCT_WITH_IMAGE = {
  id: 101,
  name: "Bouquet Deluxe",
  category: "Floral",
  status: "available",
  image_url: "https://example.com/bouquet-deluxe.jpg",
  brand_id: null,
  brand_logo_id: null,
};

const PRODUCT_WITHOUT_IMAGE = {
  id: 102,
  name: "Simple Arrangement",
  category: null,
  status: "available",
  image_url: null,
  brand_id: null,
  brand_logo_id: null,
};

const PRODUCT_WITH_BRAND_LOGO = {
  id: 103,
  name: "Branded Bouquet",
  category: "Floral",
  status: "available",
  image_url: "https://example.com/branded-bouquet.jpg",
  brand_id: 7,
  brand_logo_id: 15,
};

const PRODUCT_WITH_BRAND_ONLY = {
  id: 104,
  name: "Partial Brand Bouquet",
  category: "Floral",
  status: "available",
  image_url: "https://example.com/partial-brand-bouquet.jpg",
  brand_id: 7,
  brand_logo_id: null,
};

const MOCK_PRODUCTS = {
  products: [
    PRODUCT_WITH_IMAGE,
    PRODUCT_WITHOUT_IMAGE,
    PRODUCT_WITH_BRAND_LOGO,
    PRODUCT_WITH_BRAND_ONLY,
  ],
};

async function setupPage(page: import("@playwright/test").Page) {
  await setupClerkTestingToken({ page });

  await page.route("**/api/users**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        members: [],
        me: { role: "owner", email: "e2e-tester@presentail.com", allowedPages: null, customRoleId: null },
      }),
    });
  });

  await page.route("**/api/base-item-categories**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ categories: [] }),
    });
  });

  await page.route(`**/api/base-items/${BASE_ITEM_ID}/products`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_PRODUCTS),
    });
  });

  await page.route(`**/api/base-items/${BASE_ITEM_ID}/location-statuses`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ locationStatuses: [] }),
    });
  });

  await page.route(`**/api/base-items/${BASE_ITEM_ID}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_BASE_ITEM),
    });
  });
}

test.describe("Base Item detail – Products tab image display", () => {
  test("renders an <img> with the correct src for a product that has image_url", async ({ page }) => {
    await setupPage(page);
    await page.goto(`/base-items/${BASE_ITEM_ID}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Red Roses" })).toBeVisible({ timeout: 15_000 });

    await page.getByRole("tab", { name: "Products" }).click();

    const productRow = page.getByRole("link", { name: /Bouquet Deluxe/i });
    await expect(productRow).toBeVisible({ timeout: 8_000 });

    const img = productRow.locator("img").first();
    await expect(img).toBeVisible();
    await expect(img).toHaveAttribute("src", PRODUCT_WITH_IMAGE.image_url);
  });

  test("renders no <img> inside the row for a product without image_url", async ({ page }) => {
    await setupPage(page);
    await page.goto(`/base-items/${BASE_ITEM_ID}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Red Roses" })).toBeVisible({ timeout: 15_000 });

    await page.getByRole("tab", { name: "Products" }).click();

    const productRow = page.getByRole("link", { name: /Simple Arrangement/i });
    await expect(productRow).toBeVisible({ timeout: 8_000 });

    await expect(productRow.locator("img")).toHaveCount(0);
  });

  test("renders a brand logo <img> with the correct src for a product that has brand_id and brand_logo_id", async ({ page }) => {
    await setupPage(page);
    await page.goto(`/base-items/${BASE_ITEM_ID}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Red Roses" })).toBeVisible({ timeout: 15_000 });

    await page.getByRole("tab", { name: "Products" }).click();

    const productRow = page.getByRole("link", { name: /Branded Bouquet/i });
    await expect(productRow).toBeVisible({ timeout: 8_000 });

    await expect(productRow.locator("img")).toHaveCount(2);

    const thumbnailImg = productRow.locator(`img[src="${PRODUCT_WITH_BRAND_LOGO.image_url}"]`);
    await expect(thumbnailImg).toHaveCount(1);

    const expectedBrandLogoSrc = `/api/brands/${PRODUCT_WITH_BRAND_LOGO.brand_id}/logos/${PRODUCT_WITH_BRAND_LOGO.brand_logo_id}/image`;
    const brandLogoImg = productRow.locator(`img[src="${expectedBrandLogoSrc}"]`);
    await expect(brandLogoImg).toHaveCount(1);
    await expect(brandLogoImg).toHaveAttribute("src", expectedBrandLogoSrc);
  });

  test("renders no brand logo <img> for a product with brand_id set but brand_logo_id null", async ({ page }) => {
    await setupPage(page);
    await page.goto(`/base-items/${BASE_ITEM_ID}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Red Roses" })).toBeVisible({ timeout: 15_000 });

    await page.getByRole("tab", { name: "Products" }).click();

    const productRow = page.getByRole("link", { name: /Partial Brand Bouquet/i });
    await expect(productRow).toBeVisible({ timeout: 8_000 });

    await expect(productRow.locator("img")).toHaveCount(1);

    const thumbnailImg = productRow.locator("img").first();
    await expect(thumbnailImg).toHaveAttribute("src", PRODUCT_WITH_BRAND_ONLY.image_url);

    await expect(
      productRow.locator('img[src*="/api/brands/"][src*="/logos/"]'),
    ).toHaveCount(0);
  });
});
