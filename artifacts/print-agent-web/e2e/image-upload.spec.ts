import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";

const MOCK_CATEGORIES: { categories: unknown[] } = { categories: [] };

const MOCK_BASE_ITEMS = {
  items: [],
  total: 0,
};

async function setupPage(page: Parameters<typeof setupClerkTestingToken>[0]["page"]) {
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
      body: JSON.stringify(MOCK_CATEGORIES),
    });
  });

  await page.route(/\/api\/base-items\b(?!\/)\??/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_BASE_ITEMS),
    });
  });
}

test.describe("Image upload flow", () => {
  test("disables the upload area and shows Uploading… while an upload is in progress", async ({ page }) => {
    await setupPage(page);

    await page.route("**/api/base-items/upload-image", async (route) => {
      // Hold the request open long enough to inspect the uploading state,
      // then fulfill with a successful response.
      await new Promise<void>((r) => setTimeout(r, 3_000));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ url: "https://example.com/image.jpg" }),
      });
    });

    await page.goto("/base-items", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Base Items" })).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: /new base item/i }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 8_000 });

    const fileInput = page.locator('input[type="file"][accept*="image"]');
    await fileInput.setInputFiles({
      name: "test-image.jpg",
      mimeType: "image/jpeg",
      buffer: Buffer.from("fake-image-data"),
    });

    // Upload area should show "Uploading…" and be disabled while the request is pending
    const uploadArea = page.getByRole("button", { name: /uploading/i });
    await expect(uploadArea).toBeVisible({ timeout: 10_000 });
    await expect(uploadArea).toBeDisabled();

    // "Generate with AI" button should also be disabled while uploading
    const generateBtn = page.getByRole("button", { name: /generate with ai/i });
    await expect(generateBtn).toBeDisabled({ timeout: 5_000 });

    // After the mock request resolves (~3 s), the component switches to the thumbnail
    // branch: an <img> preview is shown and the action button becomes "Replace"
    await expect(page.locator('img[src="https://example.com/image.jpg"]')).toBeVisible({ timeout: 8_000 });
    const replaceBtn = page.getByRole("button", { name: /replace/i });
    await expect(replaceBtn).toBeVisible({ timeout: 8_000 });
    await expect(replaceBtn).toBeEnabled({ timeout: 8_000 });
  });

  test("shows the image preview and Remove button after a successful upload", async ({ page }) => {
    await setupPage(page);

    await page.route("**/api/base-items/upload-image", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ url: "https://example.com/uploaded.jpg" }),
      });
    });

    await page.goto("/base-items", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Base Items" })).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: /new base item/i }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 8_000 });

    const fileInput = page.locator('input[type="file"][accept*="image"]');
    await fileInput.setInputFiles({
      name: "test-image.jpg",
      mimeType: "image/jpeg",
      buffer: Buffer.from("fake-image-data"),
    });

    // After upload completes, an <img> preview with the returned URL must be visible
    await expect(page.locator('img[src="https://example.com/uploaded.jpg"]')).toBeVisible({ timeout: 10_000 });

    // The dashed upload area ("Click to upload image") must be gone
    await expect(page.getByRole("button", { name: /click to upload image/i })).not.toBeVisible();

    // "Generate with AI" moves into the thumbnail toolbar — still visible so the user can regenerate
    const generateBtn = page.getByRole("button", { name: /generate with ai/i });
    await expect(generateBtn).toBeVisible();

    // The Remove button must appear so the user can clear the image
    const removeBtn = page.getByRole("button", { name: /remove/i });
    await expect(removeBtn).toBeVisible();
    await expect(removeBtn).toBeEnabled();
  });

  test("shows a destructive toast and re-enables the upload area when upload fails", async ({ page }) => {
    await setupPage(page);

    await page.route("**/api/base-items/upload-image", async (route) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Internal server error" }),
      });
    });

    await page.goto("/base-items", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Base Items" })).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: /new base item/i }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 8_000 });

    const fileInput = page.locator('input[type="file"][accept*="image"]');

    await fileInput.setInputFiles({
      name: "test-image.jpg",
      mimeType: "image/jpeg",
      buffer: Buffer.from("fake-image-data"),
    });

    await expect(page.getByText(/upload failed/i)).toBeVisible({ timeout: 10_000 });

    const uploadArea = page.getByRole("button", { name: /click to upload image/i });
    await expect(uploadArea).toBeVisible({ timeout: 5_000 });
    await expect(uploadArea).toBeEnabled({ timeout: 5_000 });
  });
});
