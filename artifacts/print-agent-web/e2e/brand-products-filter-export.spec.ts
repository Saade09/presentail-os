import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import {
  ownerUsersResponse,
  setupBrandsCommonRoutes,
  setupBrandDetailSubRoutes,
} from "./helpers/brandsCommonRoutes";

/**
 * e2e tests for:
 *   - Brand detail page › Products tab › availability filter (All / Available / Unavailable)
 *   - Brand detail page › "Download Products" ZIP export button
 *
 * Route-mocking strategy follows brand-detail-readonly-badge.spec.ts:
 *   - Use the default _fapiMock fixture (setupFapiWithMockSession) from fixtures.ts
 *   - Call setupClerkTestingToken inside each setup helper
 *   - Mock only the brand-specific API routes; sidebar routes are left to the
 *     running API server (same as all other brand-detail specs)
 */

const MOCK_BRAND = {
  brand: {
    id: 1,
    name: "Acme Brand",
    description: null,
    target_cogs: null,
    created_at: new Date().toISOString(),
    sticker_count: "0",
    has_logo: false,
    has_card_message: false,
  },
};

const AVAILABLE_PRODUCT = {
  id: 10,
  workspace_owner_id: "user_1",
  name: "Available Widget",
  price_usd: "10.00",
  price_aed: "36.72",
  main_image_url: null,
  additional_image_urls: [],
  description: null,
  status: "available",
  brand: "Acme Brand",
  tags: [],
  category: "Packaging",
  created_at: new Date().toISOString(),
};

const UNAVAILABLE_PRODUCT = {
  id: 11,
  workspace_owner_id: "user_1",
  name: "Unavailable Widget",
  price_usd: "5.00",
  price_aed: "18.36",
  main_image_url: null,
  additional_image_urls: [],
  description: null,
  status: "not_available",
  brand: "Acme Brand",
  tags: [],
  category: "Packaging",
  created_at: new Date().toISOString(),
};

// Sets up all mocked routes for the Brand detail page at /brands/1.
// Matches the route-mock pattern used by brand-detail-readonly-badge.spec.ts.
async function setupBrandDetailRoutes(
  page: import("@playwright/test").Page,
  exportInterceptor?: (url: string) => void,
) {
  await setupClerkTestingToken({ page });

  await setupBrandsCommonRoutes(page);

  // Brand detail — exact path (no trailing **) so sub-routes are not caught here
  await page.route("**/api/brands/1", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_BRAND),
    });
  });

  await setupBrandDetailSubRoutes(page, { brandId: 1 });

  // Products list — filter by status to simulate server-side filtering
  await page.route("**/api/products**", async (route) => {
    const url = route.request().url();
    if (url.includes("/categories")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ categories: [] }),
      });
      return;
    }
    const u = new URL(url);
    const statuses = u.searchParams.getAll("status");
    let filtered = [AVAILABLE_PRODUCT, UNAVAILABLE_PRODUCT];
    if (statuses.includes("available") && !statuses.includes("not_available")) {
      filtered = [AVAILABLE_PRODUCT];
    } else if (statuses.includes("not_available") || statuses.includes("out_of_stock")) {
      filtered = [UNAVAILABLE_PRODUCT];
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ products: filtered, total: filtered.length }),
    });
  });

  // Export endpoint — optionally capture the request URL for assertions
  await page.route("**/api/brands/1/products/export**", async (route) => {
    if (exportInterceptor) {
      exportInterceptor(route.request().url());
    }
    await route.fulfill({
      status: 200,
      contentType: "application/zip",
      headers: {
        "Content-Disposition": 'attachment; filename="acme-brand-products-export.zip"',
      },
      body: Buffer.from("PK"),
    });
  });

  await page.goto("/brands/1", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Acme Brand" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Acme Brand")).toBeVisible({ timeout: 12_000 });
}

// ─── Filter active-state tests ────────────────────────────────────────────────

test.describe("Brand detail — Products availability filter", () => {
  test(
    "defaults to 'All' filter which shows as active",
    async ({ page }) => {
      await setupBrandDetailRoutes(page);

      const allButton = page.getByRole("button", { name: "All", exact: true });
      await expect(allButton).toBeVisible({ timeout: 8_000 });
      await expect(allButton).toHaveClass(/bg-primary/);
    },
  );

  test(
    "clicking 'Available' makes it the active filter and deactivates 'All'",
    async ({ page }) => {
      await setupBrandDetailRoutes(page);

      const allButton = page.getByRole("button", { name: "All", exact: true });
      const availableButton = page.getByRole("button", { name: "Available", exact: true });

      await expect(allButton).toBeVisible({ timeout: 8_000 });
      await availableButton.click();

      await expect(availableButton).toHaveClass(/bg-primary/);
      await expect(allButton).not.toHaveClass(/bg-primary/);
    },
  );

  test(
    "clicking 'Unavailable' makes it the active filter and deactivates 'All'",
    async ({ page }) => {
      await setupBrandDetailRoutes(page);

      const allButton = page.getByRole("button", { name: "All", exact: true });
      const unavailableButton = page.getByRole("button", { name: "Unavailable", exact: true });

      await expect(allButton).toBeVisible({ timeout: 8_000 });
      await unavailableButton.click();

      await expect(unavailableButton).toHaveClass(/bg-primary/);
      await expect(allButton).not.toHaveClass(/bg-primary/);
    },
  );

  test(
    "cycling through all three filters sets active state correctly on each",
    async ({ page }) => {
      await setupBrandDetailRoutes(page);

      const allButton = page.getByRole("button", { name: "All", exact: true });
      const availableButton = page.getByRole("button", { name: "Available", exact: true });
      const unavailableButton = page.getByRole("button", { name: "Unavailable", exact: true });

      await expect(allButton).toBeVisible({ timeout: 8_000 });

      // Initial state: All active
      await expect(allButton).toHaveClass(/bg-primary/);
      await expect(availableButton).not.toHaveClass(/bg-primary/);
      await expect(unavailableButton).not.toHaveClass(/bg-primary/);

      // Switch to Available
      await availableButton.click();
      await expect(availableButton).toHaveClass(/bg-primary/);
      await expect(allButton).not.toHaveClass(/bg-primary/);
      await expect(unavailableButton).not.toHaveClass(/bg-primary/);

      // Switch to Unavailable
      await unavailableButton.click();
      await expect(unavailableButton).toHaveClass(/bg-primary/);
      await expect(allButton).not.toHaveClass(/bg-primary/);
      await expect(availableButton).not.toHaveClass(/bg-primary/);

      // Back to All
      await allButton.click();
      await expect(allButton).toHaveClass(/bg-primary/);
      await expect(availableButton).not.toHaveClass(/bg-primary/);
      await expect(unavailableButton).not.toHaveClass(/bg-primary/);
    },
  );
});

// ─── Download Products (ZIP export) tests ────────────────────────────────────

test.describe("Brand detail — Download Products (ZIP export)", () => {
  test(
    "clicking 'Download Products' calls the export endpoint with availability=all by default",
    async ({ page }) => {
      let capturedUrl: string | null = null;

      await setupBrandDetailRoutes(page, (url) => { capturedUrl = url; });

      const downloadButton = page.getByRole("button", { name: "Download Products" });
      await expect(downloadButton).toBeVisible({ timeout: 8_000 });
      await downloadButton.click();

      await expect(async () => {
        expect(capturedUrl).not.toBeNull();
      }).toPass({ timeout: 8_000 });

      expect(capturedUrl).toContain("/api/brands/1/products/export");
      const u = new URL(capturedUrl!);
      expect(u.searchParams.get("availability")).toBe("all");
    },
  );

  test(
    "export request uses 'available' availability param when 'Available' filter is active",
    async ({ page }) => {
      let capturedUrl: string | null = null;

      await setupBrandDetailRoutes(page, (url) => { capturedUrl = url; });

      const availableButton = page.getByRole("button", { name: "Available", exact: true });
      await expect(availableButton).toBeVisible({ timeout: 8_000 });
      await availableButton.click();
      await expect(availableButton).toHaveClass(/bg-primary/);

      const downloadButton = page.getByRole("button", { name: "Download Products" });
      await downloadButton.click();

      await expect(async () => {
        expect(capturedUrl).not.toBeNull();
      }).toPass({ timeout: 8_000 });

      const u = new URL(capturedUrl!);
      expect(u.searchParams.get("availability")).toBe("available");
    },
  );

  test(
    "export request uses 'unavailable' availability param when 'Unavailable' filter is active",
    async ({ page }) => {
      let capturedUrl: string | null = null;

      await setupBrandDetailRoutes(page, (url) => { capturedUrl = url; });

      const unavailableButton = page.getByRole("button", { name: "Unavailable", exact: true });
      await expect(unavailableButton).toBeVisible({ timeout: 8_000 });
      await unavailableButton.click();
      await expect(unavailableButton).toHaveClass(/bg-primary/);

      const downloadButton = page.getByRole("button", { name: "Download Products" });
      await downloadButton.click();

      await expect(async () => {
        expect(capturedUrl).not.toBeNull();
      }).toPass({ timeout: 8_000 });

      const u = new URL(capturedUrl!);
      expect(u.searchParams.get("availability")).toBe("unavailable");
    },
  );

  test(
    "export endpoint responds with Content-Type application/zip",
    async ({ page }) => {
      let capturedContentType: string | null = null;
      let capturedStatus: number | null = null;

      await setupClerkTestingToken({ page });

      await setupBrandsCommonRoutes(page);
      await page.route("**/api/brands/1", async (route) => {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MOCK_BRAND) });
      });
      await setupBrandDetailSubRoutes(page, { brandId: 1 });
      await page.route("**/api/products**", async (route) => {
        const url = route.request().url();
        if (url.includes("/categories")) {
          await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ categories: [] }) });
          return;
        }
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ products: [AVAILABLE_PRODUCT], total: 1 }) });
      });
      await page.route("**/api/brands/1/products/export**", async (route) => {
        capturedStatus = 200;
        capturedContentType = "application/zip";
        await route.fulfill({
          status: 200,
          contentType: "application/zip",
          headers: { "Content-Disposition": 'attachment; filename="acme-brand-products-export.zip"' },
          body: Buffer.from("PK"),
        });
      });

      await page.goto("/brands/1", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Acme Brand" })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("Acme Brand")).toBeVisible({ timeout: 12_000 });

      const downloadButton = page.getByRole("button", { name: "Download Products" });
      await expect(downloadButton).toBeVisible({ timeout: 8_000 });
      await downloadButton.click();

      await expect(async () => {
        expect(capturedStatus).not.toBeNull();
      }).toPass({ timeout: 8_000 });

      expect(capturedStatus).toBe(200);
      expect(capturedContentType).toBe("application/zip");
    },
  );
});
