import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import {
  setupBrandsCommonRoutes,
  setupBrandDetailSubRoutes,
} from "./helpers/brandsCommonRoutes";

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

async function setupOwnerPage(page: import("@playwright/test").Page) {
  await setupClerkTestingToken({ page });

  await setupBrandsCommonRoutes(page);

  await page.route("**/api/brands/1", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(MOCK_BRAND),
      });
    } else {
      await route.continue();
    }
  });

  await setupBrandDetailSubRoutes(page, { brandId: 1 });

  await page.goto("/brands/1", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Acme Brand" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Acme Brand")).toBeVisible({ timeout: 12_000 });
}

test.describe("BrandDetail rename flow", () => {
  test(
    "clicking the rename button opens an inline text input on the brand title",
    async ({ page }) => {
      await setupOwnerPage(page);

      await page.hover("h1");
      await page.click('button[title="Rename brand"]');

      const nameInput = page.locator("input.text-2xl");
      await expect(nameInput).toBeVisible({ timeout: 4_000 });
      await expect(nameInput).toHaveValue("Acme Brand");

      await expect(page.getByRole("button", { name: /^Save$/ })).toBeVisible();
      await expect(page.getByRole("button", { name: /^Cancel$/ })).toBeVisible();
    },
  );

  test(
    "entering a new name and clicking Save triggers PATCH /api/brands/:id and updates the heading",
    async ({ page }) => {
      const NEW_NAME = "Renamed Brand";

      let patchBody: Record<string, unknown> | null = null;

      await setupClerkTestingToken({ page });

      await setupBrandsCommonRoutes(page);

      let brandName = "Acme Brand";

      await page.route("**/api/brands/1", async (route) => {
        if (route.request().method() === "PATCH") {
          const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
          patchBody = body;
          brandName = body.name as string;
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              brand: { ...MOCK_BRAND.brand, name: brandName },
            }),
          });
        } else {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ brand: { ...MOCK_BRAND.brand, name: brandName } }),
          });
        }
      });

      await setupBrandDetailSubRoutes(page, { brandId: 1 });

      await page.goto("/brands/1", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Acme Brand" })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("Acme Brand")).toBeVisible({ timeout: 12_000 });

      await page.hover("h1");
      await page.click('button[title="Rename brand"]');

      const nameInput = page.locator("input.text-2xl");
      await expect(nameInput).toBeVisible({ timeout: 4_000 });

      await nameInput.fill(NEW_NAME);

      await page.getByRole("button", { name: /^Save$/ }).click();

      await expect(page.locator("h1").filter({ hasText: NEW_NAME })).toBeVisible({ timeout: 8_000 });

      expect(patchBody).not.toBeNull();
      expect((patchBody as Record<string, unknown>).name).toBe(NEW_NAME);

      await expect(page.locator("input.text-2xl")).not.toBeAttached();
    },
  );

  test(
    "clearing the name and clicking Save shows a 'Name is required' toast and does not call PATCH",
    async ({ page }) => {
      let patchCalled = false;

      await setupClerkTestingToken({ page });

      await setupBrandsCommonRoutes(page);

      await page.route("**/api/brands/1", async (route) => {
        if (route.request().method() === "PATCH") {
          patchCalled = true;
          await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MOCK_BRAND) });
        } else {
          await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MOCK_BRAND) });
        }
      });

      await setupBrandDetailSubRoutes(page, { brandId: 1 });

      await page.goto("/brands/1", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Acme Brand" })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("Acme Brand")).toBeVisible({ timeout: 12_000 });

      await page.hover("h1");
      await page.click('button[title="Rename brand"]');

      const nameInput = page.locator("input.text-2xl");
      await expect(nameInput).toBeVisible({ timeout: 4_000 });

      await nameInput.fill("");

      await page.getByRole("button", { name: /^Save$/ }).click();

      await expect(page.getByText("Name is required", { exact: true })).toBeVisible({ timeout: 4_000 });

      await expect(nameInput).toBeVisible();

      expect(patchCalled).toBe(false);
    },
  );

  test(
    "typing only spaces and clicking Save shows a 'Name is required' toast and does not call PATCH",
    async ({ page }) => {
      let patchCalled = false;

      await setupClerkTestingToken({ page });

      await setupBrandsCommonRoutes(page);

      await page.route("**/api/brands/1", async (route) => {
        if (route.request().method() === "PATCH") {
          patchCalled = true;
          await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MOCK_BRAND) });
        } else {
          await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MOCK_BRAND) });
        }
      });

      await setupBrandDetailSubRoutes(page, { brandId: 1 });

      await page.goto("/brands/1", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Acme Brand" })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("Acme Brand")).toBeVisible({ timeout: 12_000 });

      await page.hover("h1");
      await page.click('button[title="Rename brand"]');

      const nameInput = page.locator("input.text-2xl");
      await expect(nameInput).toBeVisible({ timeout: 4_000 });

      await nameInput.fill("   ");

      await page.getByRole("button", { name: /^Save$/ }).click();

      await expect(page.getByText("Name is required", { exact: true })).toBeVisible({ timeout: 4_000 });

      await expect(nameInput).toBeVisible();

      expect(patchCalled).toBe(false);
    },
  );

  test(
    "typing a name with leading/trailing spaces saves the trimmed version",
    async ({ page }) => {
      const PADDED_NAME = "  Acme  ";
      const TRIMMED_NAME = "Acme";

      let patchBody: Record<string, unknown> | null = null;

      await setupClerkTestingToken({ page });

      await setupBrandsCommonRoutes(page);

      let brandName = "Acme Brand";

      await page.route("**/api/brands/1", async (route) => {
        if (route.request().method() === "PATCH") {
          const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
          patchBody = body;
          brandName = body.name as string;
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ brand: { ...MOCK_BRAND.brand, name: brandName } }),
          });
        } else {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ brand: { ...MOCK_BRAND.brand, name: brandName } }),
          });
        }
      });

      await setupBrandDetailSubRoutes(page, { brandId: 1 });

      await page.goto("/brands/1", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Acme Brand" })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("Acme Brand")).toBeVisible({ timeout: 12_000 });

      await page.hover("h1");
      await page.click('button[title="Rename brand"]');

      const nameInput = page.locator("input.text-2xl");
      await expect(nameInput).toBeVisible({ timeout: 4_000 });

      await nameInput.fill(PADDED_NAME);

      await page.getByRole("button", { name: /^Save$/ }).click();

      await expect(page.locator("h1").filter({ hasText: TRIMMED_NAME })).toBeVisible({ timeout: 8_000 });

      expect(patchBody).not.toBeNull();
      expect((patchBody as Record<string, unknown>).name).toBe(TRIMMED_NAME);

      await expect(page.locator("input.text-2xl")).not.toBeAttached();
    },
  );

  test(
    "a server 500 on PATCH shows a 'Rename failed' toast, keeps the input visible, and preserves the original heading",
    async ({ page }) => {
      await setupClerkTestingToken({ page });

      await setupBrandsCommonRoutes(page);

      await page.route("**/api/brands/1", async (route) => {
        if (route.request().method() === "PATCH") {
          await route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ error: "Internal Server Error" }),
          });
        } else {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(MOCK_BRAND),
          });
        }
      });

      await setupBrandDetailSubRoutes(page, { brandId: 1 });

      await page.goto("/brands/1", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Acme Brand" })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("Acme Brand")).toBeVisible({ timeout: 12_000 });

      await page.hover("h1");
      await page.click('button[title="Rename brand"]');

      const nameInput = page.locator("input.text-2xl");
      await expect(nameInput).toBeVisible({ timeout: 4_000 });

      await nameInput.fill("New Name");

      await page.getByRole("button", { name: /^Save$/ }).click();

      await expect(page.getByText("Rename failed", { exact: true })).toBeVisible({ timeout: 8_000 });

      await expect(nameInput).toBeVisible();

      const saveButton = page.getByRole("button", { name: /^Save$/ });
      const cancelButton = page.getByRole("button", { name: /^Cancel$/ });

      await expect(saveButton).toBeEnabled();
      await expect(cancelButton).toBeEnabled();
      await expect(saveButton).toHaveText("Save");
      await expect(page.getByRole("button", { name: /Saving…/ })).toHaveCount(0);

      await cancelButton.click();

      await expect(nameInput).not.toBeAttached();
      await expect(page.locator("h1").filter({ hasText: "Acme Brand" })).toBeVisible({ timeout: 4_000 });
    },
  );

  test(
    "clicking Cancel discards the change and reverts the heading to the original name",
    async ({ page }) => {
      let patchCalled = false;

      await setupClerkTestingToken({ page });

      await setupBrandsCommonRoutes(page);

      await page.route("**/api/brands/1", async (route) => {
        if (route.request().method() === "PATCH") {
          patchCalled = true;
          await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MOCK_BRAND) });
        } else {
          await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MOCK_BRAND) });
        }
      });

      await setupBrandDetailSubRoutes(page, { brandId: 1 });

      await page.goto("/brands/1", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Acme Brand" })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("Acme Brand")).toBeVisible({ timeout: 12_000 });

      await page.hover("h1");
      await page.click('button[title="Rename brand"]');

      const nameInput = page.locator("input.text-2xl");
      await expect(nameInput).toBeVisible({ timeout: 4_000 });

      await nameInput.fill("Something Else");

      await page.getByRole("button", { name: /^Cancel$/ }).click();

      await expect(page.locator("input.text-2xl")).not.toBeAttached();
      await expect(page.locator("h1").filter({ hasText: "Acme Brand" })).toBeVisible({ timeout: 4_000 });

      expect(patchCalled).toBe(false);
    },
  );

  test(
    "clicking Save again after a failed PATCH retries successfully and updates the heading",
    async ({ page }) => {
      const NEW_NAME = "Retried Brand";

      let patchCallCount = 0;
      let brandName = "Acme Brand";

      await setupClerkTestingToken({ page });

      await setupBrandsCommonRoutes(page);

      await page.route("**/api/brands/1", async (route) => {
        if (route.request().method() === "PATCH") {
          patchCallCount += 1;
          if (patchCallCount === 1) {
            await route.fulfill({
              status: 500,
              contentType: "application/json",
              body: JSON.stringify({ error: "Internal Server Error" }),
            });
          } else {
            const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
            brandName = body.name as string;
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({ brand: { ...MOCK_BRAND.brand, name: brandName } }),
            });
          }
        } else {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ brand: { ...MOCK_BRAND.brand, name: brandName } }),
          });
        }
      });

      await setupBrandDetailSubRoutes(page, { brandId: 1 });

      await page.goto("/brands/1", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Acme Brand" })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("Acme Brand")).toBeVisible({ timeout: 12_000 });

      await page.hover("h1");
      await page.click('button[title="Rename brand"]');

      const nameInput = page.locator("input.text-2xl");
      await expect(nameInput).toBeVisible({ timeout: 4_000 });

      await nameInput.fill(NEW_NAME);

      const saveButton = page.getByRole("button", { name: /^Save$/ });
      await saveButton.click();

      await expect(page.getByText("Rename failed", { exact: true })).toBeVisible({ timeout: 8_000 });

      await expect(saveButton).toBeEnabled();
      await expect(nameInput).toBeVisible();
      await expect(nameInput).toHaveValue(NEW_NAME);

      await saveButton.click();

      await expect(page.getByText("Brand renamed", { exact: true })).toBeVisible({ timeout: 8_000 });
      await expect(page.locator("h1").filter({ hasText: NEW_NAME })).toBeVisible({ timeout: 8_000 });
      await expect(page.locator("input.text-2xl")).not.toBeAttached();

      expect(patchCallCount).toBe(2);
    },
  );
});
