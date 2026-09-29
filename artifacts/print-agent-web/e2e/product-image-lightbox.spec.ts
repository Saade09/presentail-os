import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import {
  ownerUsersResponse,
  setupProductsCommonRoutes,
} from "./helpers/productsCommonRoutes";

const PRODUCT_ID = 73;

const MOCK_PRODUCT = {
  id: PRODUCT_ID,
  workspace_owner_id: "user_1",
  name: "Lightbox Test Product",
  price_usd: "12.50",
  price_aed: "45.91",
  // Use an absolute URL so imageUrl() returns it as-is — no real storage call needed.
  main_image_url: "https://example.com/lightbox-test.png",
  additional_image_urls: [] as string[],
  description: null,
  status: "available",
  brand: "Acme",
  tags: [] as string[],
  category: null,
  sku: null,
  created_at: new Date().toISOString(),
};

const MOCK_CHANNELS = {
  channels: [
    {
      id: 11,
      name: "Instagram",
      has_cover_photo: true,
      cover_photo_width: 1080,
      cover_photo_height: 1080,
      has_logo: false,
      created_at: new Date().toISOString(),
    },
    {
      id: 12,
      name: "Storefront",
      has_cover_photo: false,
      cover_photo_width: null,
      cover_photo_height: null,
      has_logo: false,
      created_at: new Date().toISOString(),
    },
  ],
};

// Use non-square dimensions so a regression that swaps width/height in the
// download URL would be caught.
const INSTAGRAM_WIDTH = 1200;
const INSTAGRAM_HEIGHT = 628;

// Image configs are channel-scoped and use width_px/height_px/output_format fields.
const MOCK_CHANNEL_IMAGE_CONFIGS = {
  image_configs: [
    {
      id: 501,
      channel_id: 11,
      channel_name: "Instagram",
      width_px: INSTAGRAM_WIDTH,
      height_px: INSTAGRAM_HEIGHT,
      output_format: "jpeg",
    },
  ],
};

async function setupRoutes(
  page: import("@playwright/test").Page,
  { imageConfigs = MOCK_CHANNEL_IMAGE_CONFIGS }: { imageConfigs?: object } = {},
) {
  await setupClerkTestingToken({ page });

  await setupProductsCommonRoutes(page, {
    getUsersResponse: () => ownerUsersResponse("e2e-tester+clerk_test@presentail.com"),
  });

  await page.route("**/api/products/categories**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ categories: [] }),
    });
  });

  await page.route(`**/api/products/${PRODUCT_ID}/recipe**`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ recipe: [] }),
    });
  });

  await page.route(`**/api/products/${PRODUCT_ID}/location-statuses`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ locationStatuses: [] }),
    });
  });

  await page.route(`**/api/products/${PRODUCT_ID}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ product: MOCK_PRODUCT, recipe: [] }),
    });
  });

  await page.route(
    (url) => url.pathname === "/api/channels",
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(MOCK_CHANNELS),
      });
    },
  );

  await page.route(
    (url) =>
      url.pathname === "/api/channel-image-configs" &&
      url.searchParams.get("image_type") === "product",
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(imageConfigs),
      });
    },
  );
}

test.describe("Product image lightbox", () => {
  test("clicking the product thumbnail opens the lightbox with download options and the close button dismisses it", async ({
    page,
  }) => {
    await setupRoutes(page);

    await page.goto(`/products/${PRODUCT_ID}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Lightbox Test Product" })).toBeVisible({ timeout: 15_000 });

    // Wait for product details to render — the thumbnail button is rendered in the
    // read-only details view as soon as the product query resolves.
    const thumb = page.getByTestId("product-image-thumb");
    await expect(thumb).toBeVisible({ timeout: 12_000 });

    // Dialog should not be present before the user clicks the thumbnail.
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await thumb.click();

    // Dialog opens with the product name as its title.
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 8_000 });
    await expect(dialog.getByText(MOCK_PRODUCT.name).first()).toBeVisible();

    // Download Options section appears.
    await expect(dialog.getByText("Download Options", { exact: true })).toBeVisible();
    await expect(
      dialog.getByText("Download this image resized for each channel."),
    ).toBeVisible();

    // Each channel row appears (after dimensions/channels queries resolve).
    await expect(dialog.getByText("Instagram", { exact: true })).toBeVisible({
      timeout: 8_000,
    });
    await expect(dialog.getByText("Storefront", { exact: true })).toBeVisible();

    // Instagram has configured dimensions so its Download button is enabled;
    // Storefront has no dims so its Download button is disabled.
    const downloadButtons = dialog.getByRole("button", { name: /^Download$/ });
    await expect(downloadButtons).toHaveCount(2);
    await expect(downloadButtons.nth(0)).toBeEnabled();
    await expect(downloadButtons.nth(1)).toBeDisabled();

    // Close button (Radix Dialog renders an X with sr-only "Close" label).
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("hovering the disabled Storefront Download button shows why it is greyed out", async ({
    page,
  }) => {
    await setupRoutes(page);

    await page.goto(`/products/${PRODUCT_ID}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Lightbox Test Product" })).toBeVisible({ timeout: 15_000 });

    const thumb = page.getByTestId("product-image-thumb");
    await expect(thumb).toBeVisible({ timeout: 12_000 });
    await thumb.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 8_000 });

    // Wait for the Storefront row to appear.
    await expect(dialog.getByText("Storefront", { exact: true })).toBeVisible({
      timeout: 8_000,
    });

    // Hover over the disabled Download button wrapper for the Storefront channel (id 12).
    const disabledTrigger = page.getByTestId("download-disabled-12");
    await expect(disabledTrigger).toBeVisible();
    await disabledTrigger.hover();

    // The tooltip should explain that no image size has been configured for
    // this channel and tell the user where to fix it.
    const explanation =
      "No image size configured for Storefront. Configure dimensions in channel settings.";
    await expect(page.getByText(explanation)).toBeVisible({
      timeout: 4_000,
    });

    // The tooltip should also include a link that takes the user straight to
    // the channels settings page so they can fix the missing dimension.
    const channelsLink = page.locator('a[href="/channels"]');
    await expect(channelsLink).toBeVisible();
  });

  test("all Download buttons are disabled when no image configs are returned", async ({
    page,
  }) => {
    // Return an empty image_configs array — no channel has a configured size.
    await setupRoutes(page, { imageConfigs: { image_configs: [] } });

    await page.goto(`/products/${PRODUCT_ID}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Lightbox Test Product" })).toBeVisible({ timeout: 15_000 });

    const thumb = page.getByTestId("product-image-thumb");
    await expect(thumb).toBeVisible({ timeout: 12_000 });
    await thumb.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 8_000 });

    // Both channel rows should appear.
    await expect(dialog.getByText("Instagram", { exact: true })).toBeVisible({
      timeout: 8_000,
    });
    await expect(dialog.getByText("Storefront", { exact: true })).toBeVisible();

    // With no configs, every Download button must be disabled.
    const downloadButtons = dialog.getByRole("button", { name: /^Download$/ });
    await expect(downloadButtons).toHaveCount(2);
    await expect(downloadButtons.nth(0)).toBeDisabled();
    await expect(downloadButtons.nth(1)).toBeDisabled();
  });

  test("clicking a channel's Download button requests the correct sized image URL with the right filename", async ({
    page,
  }) => {
    // Capture every download anchor that the page programmatically clicks.
    //
    // The lightbox triggers downloads by appending an `<a download href=...>`
    // to the DOM and calling `.click()` on it. Chromium's download manager can
    // bypass `page.route` interception for these anchor-download requests, so
    // we monkey-patch `HTMLAnchorElement.prototype.click` via an init script
    // and forward the anchor's resolved `href` and `download` attribute back
    // to the test through an exposed binding. This captures exactly what the
    // browser would request (the resolved URL) and what filename it would be
    // saved as, which is precisely what the task requires us to verify.
    const captured: Array<{ href: string; download: string }> = [];
    await page.exposeFunction(
      "__recordDownloadClick",
      (href: string, download: string) => {
        captured.push({ href, download });
      },
    );
    await page.addInitScript(() => {
      const origClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
        if (this.hasAttribute("download")) {
          const w = window as unknown as {
            __recordDownloadClick: (href: string, download: string) => void;
          };
          w.__recordDownloadClick(this.href, this.getAttribute("download") ?? "");
        }
        return origClick.call(this);
      };
    });

    await setupRoutes(page);

    await page.goto(`/products/${PRODUCT_ID}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Lightbox Test Product" })).toBeVisible({ timeout: 15_000 });

    const thumb = page.getByTestId("product-image-thumb");
    await expect(thumb).toBeVisible({ timeout: 12_000 });
    await thumb.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 8_000 });

    // Wait for the Instagram row (which has configured dimensions) to render
    // and for its Download button to become enabled.
    await expect(dialog.getByText("Instagram", { exact: true })).toBeVisible({
      timeout: 8_000,
    });
    const downloadButtons = dialog.getByRole("button", { name: /^Download$/ });
    await expect(downloadButtons.nth(0)).toBeEnabled();

    // Click the Instagram Download button — this synchronously creates and
    // clicks the hidden anchor, which our init script forwards to us.
    await downloadButtons.nth(0).click();

    await expect.poll(() => captured.length, { timeout: 4_000 }).toBeGreaterThan(0);

    expect(captured).toHaveLength(1);
    const { href, download } = captured[0]!;

    // Verify the request URL: pathname targets THIS product's download-image
    // endpoint, and width/height match the Instagram dimension row exactly
    // (in the correct order — not swapped, not dropped).
    const parsed = new URL(href);
    expect(parsed.pathname).toBe(`/api/products/${PRODUCT_ID}/download-image`);
    expect(parsed.searchParams.get("width")).toBe(String(INSTAGRAM_WIDTH));
    expect(parsed.searchParams.get("height")).toBe(String(INSTAGRAM_HEIGHT));

    // Verify the suggested filename in the anchor's `download` attribute
    // includes the product name and `<width>x<height>`.
    expect(download).toContain(MOCK_PRODUCT.name);
    expect(download).toContain(`${INSTAGRAM_WIDTH}x${INSTAGRAM_HEIGHT}`);
  });
});
