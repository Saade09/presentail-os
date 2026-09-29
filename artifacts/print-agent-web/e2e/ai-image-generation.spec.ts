import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";

const MOCK_CATEGORIES: { categories: unknown[] } = { categories: [] };

const MOCK_BASE_ITEMS = {
  items: [],
  total: 0,
};

const MOCK_GENERATED_URL = "/objects/workspaces/1/base-items/generated-test.jpg";

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

test.describe("AI image generation flow", () => {
  test("prompt field stays visible after a successful AI generation", async ({ page }) => {
    await setupPage(page);

    await page.route("**/api/base-items/generate-image", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ url: MOCK_GENERATED_URL }),
      });
    });

    await page.goto("/base-items", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Base Items" })).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: /new base item/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 8_000 });

    await page.getByRole("button", { name: /generate with ai/i }).click();

    const promptInput = page.getByPlaceholder(/describe the image/i);
    await expect(promptInput).toBeVisible();
    await promptInput.fill("red roses bouquet");

    await page.getByRole("button", { name: /^generate$/i }).click();

    await expect(promptInput).toBeVisible({ timeout: 10_000 });
    await expect(page.getByAltText("")).toBeVisible({ timeout: 10_000 });
  });

  test("spinner and disabled state appear while generation is in progress", async ({ page }) => {
    await setupPage(page);

    let releaseGenerate!: () => void;
    const generateGate = new Promise<void>((resolve) => {
      releaseGenerate = resolve;
    });

    await page.route("**/api/base-items/generate-image", async (route) => {
      await generateGate;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ url: MOCK_GENERATED_URL }),
      });
    });

    await page.goto("/base-items", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Base Items" })).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: /new base item/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 8_000 });

    await page.getByRole("button", { name: /generate with ai/i }).click();

    const promptInput = page.getByPlaceholder(/describe the image/i);
    await expect(promptInput).toBeVisible();
    await promptInput.fill("red roses bouquet");

    await page.getByRole("button", { name: /^generate$/i }).click();

    const generatingButton = page.getByRole("button", { name: /generating…/i });
    await expect(generatingButton).toBeVisible({ timeout: 5_000 });
    await expect(generatingButton).toBeDisabled();

    await expect(promptInput).toBeDisabled();

    releaseGenerate();

    await expect(generatingButton).not.toBeVisible({ timeout: 10_000 });
  });

  test("shows a destructive toast and re-enables inputs when generation fails", async ({ page }) => {
    await setupPage(page);

    await page.route("**/api/base-items/generate-image", async (route) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Internal server error" }),
      });
    });

    await page.goto("/base-items", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Base Items" })).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: /new base item/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 8_000 });

    await page.getByRole("button", { name: /generate with ai/i }).click();

    const promptInput = page.getByPlaceholder(/describe the image/i);
    await expect(promptInput).toBeVisible();
    await promptInput.fill("red roses bouquet");

    await page.getByRole("button", { name: /^generate$/i }).click();

    await expect(page.getByText(/generation failed/i)).toBeVisible({ timeout: 10_000 });

    await expect(promptInput).toBeEnabled({ timeout: 5_000 });
    await expect(page.getByRole("button", { name: /^generate$/i })).toBeEnabled({ timeout: 5_000 });
  });

  test("clicking Regenerate issues a second request with the same prompt", async ({ page }) => {
    await setupPage(page);

    let generateCallCount = 0;
    let lastPrompt = "";

    await page.route("**/api/base-items/generate-image", async (route) => {
      generateCallCount++;
      const body = JSON.parse(route.request().postData() ?? "{}");
      lastPrompt = body.prompt ?? "";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ url: MOCK_GENERATED_URL }),
      });
    });

    await page.goto("/base-items", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Base Items" })).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: /new base item/i }).click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 8_000 });

    await page.getByRole("button", { name: /generate with ai/i }).click();

    const promptInput = page.getByPlaceholder(/describe the image/i);
    await expect(promptInput).toBeVisible();
    await promptInput.fill("red roses bouquet");

    await page.getByRole("button", { name: /^generate$/i }).click();

    await expect(page.getByAltText("")).toBeVisible({ timeout: 10_000 });
    expect(generateCallCount).toBe(1);
    expect(lastPrompt).toBe("red roses bouquet");

    await page.getByRole("button", { name: /generate with ai/i }).click();
    const promptInputAfter = page.getByPlaceholder(/describe the image/i);
    await expect(promptInputAfter).toBeVisible();

    await page.getByRole("button", { name: /^regenerate$/i }).click();

    await expect(page.getByAltText("")).toBeVisible({ timeout: 10_000 });
    expect(generateCallCount).toBe(2);
    expect(lastPrompt).toBe("red roses bouquet");
  });
});
