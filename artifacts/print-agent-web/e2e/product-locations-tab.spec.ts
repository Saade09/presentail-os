import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import { setupProductsCommonRoutes } from "./helpers/productsCommonRoutes";

const PRODUCT_ID = 42;

const LOC_A_ID = 201;
const LOC_A_NAME = "Downtown";
const LOC_B_ID = 202;
const LOC_B_NAME = "Airport";

const MOCK_PRODUCT = {
  id: PRODUCT_ID,
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

type LocationStatus = { location_id: number; location_name: string; is_active: boolean };

async function setupBaseRoutes(
  page: import("@playwright/test").Page,
  locationStatuses: LocationStatus[],
  onPatch?: (locationId: number, body: unknown) => void | Promise<void>,
) {
  await setupProductsCommonRoutes(page);

  await page.route("**/api/brands**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ brands: [] }),
    });
  });

  await page.route(`**/api/products/${PRODUCT_ID}`, async (route) => {
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

  await page.route(`**/api/products/${PRODUCT_ID}/recipe`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ recipe: MOCK_RECIPE }),
    });
  });

  // GET /api/products/:id/location-statuses
  await page.route(`**/api/products/${PRODUCT_ID}/location-statuses`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ locationStatuses }),
    });
  });

  // PATCH /api/products/:id/location-statuses/:locationId
  await page.route(`**/api/products/${PRODUCT_ID}/location-statuses/*`, async (route) => {
    const url = route.request().url();
    const patchMatch = url.match(/\/location-statuses\/(\d+)(?:\?.*)?$/);
    const locationId = patchMatch ? parseInt(patchMatch[1], 10) : -1;
    const body = route.request().postDataJSON();
    if (onPatch) await onPatch(locationId, body);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
  });
}

async function goToLocationsTab(page: import("@playwright/test").Page) {
  await page.goto(`/products/${PRODUCT_ID}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Test Product" })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("tab", { name: "Locations" }).click();
}

test.describe("Product Locations tab", () => {
  test("renders location rows with names and switches", async ({ page }) => {
    await setupClerkTestingToken({ page });

    await setupBaseRoutes(page, [
      { location_id: LOC_A_ID, location_name: LOC_A_NAME, is_active: true },
      { location_id: LOC_B_ID, location_name: LOC_B_NAME, is_active: false },
    ]);

    await goToLocationsTab(page);

    await expect(page.getByText(LOC_A_NAME)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(LOC_B_NAME)).toBeVisible();

    const switchA = page.getByRole("switch", { name: `${LOC_A_NAME} active` });
    const switchB = page.getByRole("switch", { name: `${LOC_B_NAME} active` });

    await expect(switchA).toBeVisible();
    await expect(switchB).toBeVisible();

    await expect(switchA).toHaveAttribute("aria-checked", "true");
    await expect(switchB).toHaveAttribute("aria-checked", "false");
  });

  test("toggling an active location off sends PATCH with isActive: false", async ({ page }) => {
    await setupClerkTestingToken({ page });

    const patchCalls: { locationId: number; body: unknown }[] = [];

    await setupBaseRoutes(
      page,
      [{ location_id: LOC_A_ID, location_name: LOC_A_NAME, is_active: true }],
      (locationId, body) => {
        patchCalls.push({ locationId, body });
      },
    );

    await goToLocationsTab(page);

    const switchA = page.getByRole("switch", { name: `${LOC_A_NAME} active` });
    await expect(switchA).toBeVisible({ timeout: 10_000 });
    await expect(switchA).toHaveAttribute("aria-checked", "true");

    await switchA.click();

    await expect(async () => {
      expect(patchCalls.length).toBeGreaterThan(0);
    }).toPass({ timeout: 8_000 });

    expect(patchCalls[0].locationId).toBe(LOC_A_ID);
    expect((patchCalls[0].body as { isActive: boolean }).isActive).toBe(false);
  });

  test("toggling an inactive location on sends PATCH with isActive: true", async ({ page }) => {
    await setupClerkTestingToken({ page });

    const patchCalls: { locationId: number; body: unknown }[] = [];

    await setupBaseRoutes(
      page,
      [{ location_id: LOC_B_ID, location_name: LOC_B_NAME, is_active: false }],
      (locationId, body) => {
        patchCalls.push({ locationId, body });
      },
    );

    await goToLocationsTab(page);

    const switchB = page.getByRole("switch", { name: `${LOC_B_NAME} active` });
    await expect(switchB).toBeVisible({ timeout: 10_000 });
    await expect(switchB).toHaveAttribute("aria-checked", "false");

    await switchB.click();

    await expect(async () => {
      expect(patchCalls.length).toBeGreaterThan(0);
    }).toPass({ timeout: 8_000 });

    expect(patchCalls[0].locationId).toBe(LOC_B_ID);
    expect((patchCalls[0].body as { isActive: boolean }).isActive).toBe(true);
  });

  test("shows empty state when no locations are configured", async ({ page }) => {
    await setupClerkTestingToken({ page });

    await setupBaseRoutes(page, []);

    await goToLocationsTab(page);

    await expect(page.getByText("No locations configured")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/Add locations in the Locations section/)).toBeVisible();
  });

  test("shows inline error and toast when PATCH returns 500", async ({ page }) => {
    await setupClerkTestingToken({ page });

    await setupBaseRoutes(page, [
      { location_id: LOC_A_ID, location_name: LOC_A_NAME, is_active: true },
    ]);

    // Override location-status PATCH to return 500
    await page.route(`**/api/products/${PRODUCT_ID}/location-statuses/**`, async (route) => {
      if (route.request().method() === "PATCH") {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "Internal Server Error" }),
        });
        return;
      }
      await route.continue();
    });

    await goToLocationsTab(page);

    const switchA = page.getByRole("switch", { name: `${LOC_A_NAME} active` });
    await expect(switchA).toBeVisible({ timeout: 10_000 });

    await switchA.click();

    await expect(page.getByText("Failed to save. Please try again.")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText("Failed to update location").first()).toBeVisible({ timeout: 5_000 });

    // Toggle must snap back to its original position after the failed save
    await expect(switchA).toHaveAttribute("aria-checked", "true", { timeout: 5_000 });
  });

  test("toggle snaps back and shows error when network is offline (request aborted)", async ({
    page,
  }) => {
    await setupClerkTestingToken({ page });

    await setupBaseRoutes(page, [
      { location_id: LOC_A_ID, location_name: LOC_A_NAME, is_active: true },
    ]);

    // Override location-status PATCH to abort (simulates network offline / connection drop)
    await page.route(`**/api/products/${PRODUCT_ID}/location-statuses/**`, async (route) => {
      if (route.request().method() === "PATCH") {
        await route.abort();
        return;
      }
      await route.continue();
    });

    await goToLocationsTab(page);

    const switchA = page.getByRole("switch", { name: `${LOC_A_NAME} active` });
    await expect(switchA).toBeVisible({ timeout: 10_000 });
    await expect(switchA).toHaveAttribute("aria-checked", "true");

    await switchA.click();

    await expect(page.getByText("Failed to save. Please try again.")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText("Failed to update location").first()).toBeVisible({ timeout: 5_000 });

    // Toggle must snap back to its original position after the aborted request
    await expect(switchA).toHaveAttribute("aria-checked", "true", { timeout: 5_000 });
  });

  test("PATCH is sent to the correct endpoint URL", async ({ page }) => {
    await setupClerkTestingToken({ page });

    const capturedUrls: string[] = [];

    await setupBaseRoutes(
      page,
      [{ location_id: LOC_A_ID, location_name: LOC_A_NAME, is_active: true }],
    );

    // Override to capture the URL
    await page.route(`**/api/products/${PRODUCT_ID}/location-statuses/**`, async (route) => {
      if (route.request().method() === "PATCH") {
        capturedUrls.push(route.request().url());
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
        return;
      }
      await route.continue();
    });

    await goToLocationsTab(page);

    const switchA = page.getByRole("switch", { name: `${LOC_A_NAME} active` });
    await expect(switchA).toBeVisible({ timeout: 10_000 });
    await switchA.click();

    await expect(async () => {
      expect(capturedUrls.length).toBeGreaterThan(0);
    }).toPass({ timeout: 8_000 });

    expect(capturedUrls[0]).toMatch(
      new RegExp(`/api/products/${PRODUCT_ID}/location-statuses/${LOC_A_ID}$`),
    );
  });
});
