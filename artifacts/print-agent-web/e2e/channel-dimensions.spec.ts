import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";

const OWNER_EMAIL = "e2e-tester+clerk_test@presentail.com";

const CHANNEL_ID = 21;
const CHANNEL_NAME = "Instagram";

const MOCK_CHANNELS = {
  channels: [
    {
      id: CHANNEL_ID,
      name: CHANNEL_NAME,
      has_cover_photo: true,
      cover_photo_width: 1080,
      cover_photo_height: 1080,
      has_logo: false,
      created_at: new Date().toISOString(),
    },
  ],
};

type Dimension = {
  id: number;
  channel_id: number;
  channel_name: string;
  width: number;
  height: number;
  output_format?: "jpeg" | "png" | "webp";
};

function usersResponse(role: "owner" | "member") {
  return {
    members: [
      {
        id: 1,
        email: OWNER_EMAIL,
        role,
        custom_role_id: null,
        role_name: null,
        joined: true,
        joined_at: new Date().toISOString(),
        invited_at: new Date().toISOString(),
        invited_by_email: null,
        manager_member_id: null,
        manager_email: null,
      },
    ],
    me: {
      role,
      email: OWNER_EMAIL,
      allowedPages: null,
      customRoleId: null,
    },
  };
}

/**
 * Sets up the Channels page with a single channel and a mutable in-memory
 * store of channel-product-dimensions that responds to GET / POST / PUT /
 * DELETE so add/edit/delete flows can be exercised end-to-end.
 */
async function setupChannelsPage(
  page: import("@playwright/test").Page,
  opts: {
    role: "owner" | "member";
    initialDimensions?: Dimension[];
  },
) {
  const dimensions: Dimension[] = [...(opts.initialDimensions ?? [])];
  let nextId = (dimensions.reduce((m, d) => Math.max(m, d.id), 0) || 0) + 1;

  await setupClerkTestingToken({ page });

  await page.route("**/api/users**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(usersResponse(opts.role)),
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

  // List + create dimensions
  await page.route(
    (url) => url.pathname === "/api/channel-product-dimensions",
    async (route) => {
      const req = route.request();
      const method = req.method();

      if (method === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ dimensions }),
        });
        return;
      }

      if (method === "POST") {
        const body = req.postDataJSON() as {
          channel_id: number;
          width: number;
          height: number;
          output_format?: "jpeg" | "png" | "webp";
        };
        const newDim: Dimension = {
          id: nextId++,
          channel_id: body.channel_id,
          channel_name: CHANNEL_NAME,
          width: body.width,
          height: body.height,
          output_format: body.output_format ?? "jpeg",
        };
        dimensions.push(newDim);
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({ dimension: newDim }),
        });
        return;
      }

      await route.fulfill({ status: 405, body: "" });
    },
  );

  // Update + delete an existing dimension
  await page.route(
    (url) => /\/api\/channel-product-dimensions\/\d+$/.test(url.pathname),
    async (route) => {
      const req = route.request();
      const method = req.method();
      const idMatch = new URL(req.url()).pathname.match(/\/(\d+)$/);
      const id = idMatch ? parseInt(idMatch[1], 10) : NaN;
      const idx = dimensions.findIndex((d) => d.id === id);

      if (idx === -1) {
        await route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ error: "Not found" }),
        });
        return;
      }

      if (method === "PUT") {
        const body = req.postDataJSON() as {
          width: number;
          height: number;
          output_format?: "jpeg" | "png" | "webp";
        };
        dimensions[idx] = {
          ...dimensions[idx],
          width: body.width,
          height: body.height,
          output_format:
            body.output_format ?? dimensions[idx].output_format ?? "jpeg",
        };
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ dimension: dimensions[idx] }),
        });
        return;
      }

      if (method === "DELETE") {
        dimensions.splice(idx, 1);
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
        return;
      }

      await route.fulfill({ status: 405, body: "" });
    },
  );

  await page.goto("/channels", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Channels" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(CHANNEL_NAME, { exact: true })).toBeVisible({
    timeout: 12_000,
  });
}

// A tiny 1×1 red PNG (binary, served as image/png) so the Cropper can load
// the image in headless mode without making a real network request.
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADklEQVQI12P4z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==";

const PRODUCT_ID = 91;
const IMAGE_HOSTNAME = "example.com";
const IMAGE_PATH = "/format-test-dim.png";
const MOCK_IMAGE_URL = `https://${IMAGE_HOSTNAME}${IMAGE_PATH}`;

const MOCK_PRODUCT = {
  id: PRODUCT_ID,
  workspace_owner_id: "user_1",
  name: "Format Test Product",
  price_usd: "10.00",
  price_aed: "36.73",
  main_image_url: MOCK_IMAGE_URL,
  additional_image_urls: [] as string[],
  description: null,
  status: "available",
  brand: null,
  tags: [] as string[],
  category: null,
  sku: null,
  created_at: new Date().toISOString(),
};

const PNG_DIMENSION_WIDTH = 750;
const PNG_DIMENSION_HEIGHT = 300;

/**
 * Sets up routes for the ProductDetail page with a single channel dimension,
 * and intercepts the product image URL to return a real (tiny) PNG so the
 * canvas-based ImageCropDownloadModal can load it in headless mode.
 */
async function setupProductDetailRoutes(
  page: import("@playwright/test").Page,
  opts: { outputFormat: "jpeg" | "png" | "webp" } = { outputFormat: "png" },
) {
  await setupClerkTestingToken({ page });

  // Serve the product image as a real tiny PNG so the Cropper can load it.
  await page.route(`**${IMAGE_PATH}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      body: Buffer.from(TINY_PNG_BASE64, "base64"),
    });
  });

  await page.route("**/api/users**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(usersResponse("owner")),
    });
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

  await page.route(
    `**/api/products/${PRODUCT_ID}/location-statuses`,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ locationStatuses: [] }),
      });
    },
  );

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
    (url) => url.pathname === "/api/channel-product-dimensions",
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          dimensions: [
            {
              id: 601,
              channel_id: CHANNEL_ID,
              channel_name: CHANNEL_NAME,
              width: PNG_DIMENSION_WIDTH,
              height: PNG_DIMENSION_HEIGHT,
              output_format: opts.outputFormat,
            },
          ],
        }),
      });
    },
  );
}

/**
 * Sets up routes for the ChannelDetail page so the image-config form can be
 * tested with real testids (`btn-edit-product-config`, `select-product-format`,
 * `btn-submit-product-config`, etc.) that already exist in ChannelDetail.tsx.
 */
async function setupChannelDetailRoutes(
  page: import("@playwright/test").Page,
  opts: {
    imageConfigs?: Array<{
      id: number;
      channel_id: number;
      image_type: "product" | "banner" | "logo";
      width_px: number;
      height_px: number;
      output_format: "jpeg" | "png" | "webp";
      created_at: string;
    }>;
    onImageConfigPost?: (body: Record<string, unknown>) => void;
    onImageConfigPut?: (
      id: number,
      body: Record<string, unknown>,
    ) => void;
  } = {},
) {
  const imageConfigs = opts.imageConfigs ?? [];

  await setupClerkTestingToken({ page });

  await page.route("**/api/users**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(usersResponse("owner")),
    });
  });

  await page.route(`**/api/channels/${CHANNEL_ID}`, async (route) => {
    const req = route.request();
    if (req.method() !== "GET") {
      await route.fulfill({ status: 405, body: "" });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        channel: {
          id: CHANNEL_ID,
          name: CHANNEL_NAME,
          has_cover_photo: true,
          cover_photo_width: 1080,
          cover_photo_height: 1080,
          has_logo: false,
          created_at: new Date().toISOString(),
          image_configs: imageConfigs,
          contacts: [],
        },
      }),
    });
  });

  await page.route(
    (url) =>
      url.pathname === `/api/channels/${CHANNEL_ID}/image-configs`,
    async (route) => {
      const req = route.request();
      if (req.method() === "POST") {
        const body = req.postDataJSON() as Record<string, unknown>;
        opts.onImageConfigPost?.(body);
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({
            config: {
              id: 999,
              channel_id: CHANNEL_ID,
              image_type: body.image_type,
              width_px: body.width_px,
              height_px: body.height_px,
              output_format: body.output_format ?? "jpeg",
              created_at: new Date().toISOString(),
            },
          }),
        });
        return;
      }
      await route.fulfill({ status: 405, body: "" });
    },
  );

  await page.route(
    (url) =>
      /\/api\/channels\/\d+\/image-configs\/\d+$/.test(url.pathname),
    async (route) => {
      const req = route.request();
      const pathname = new URL(req.url()).pathname;
      const idMatch = pathname.match(/\/image-configs\/(\d+)$/);
      const configId = idMatch ? parseInt(idMatch[1], 10) : NaN;
      if (req.method() === "PUT") {
        const body = req.postDataJSON() as Record<string, unknown>;
        opts.onImageConfigPut?.(configId, body);
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            config: {
              id: configId,
              channel_id: CHANNEL_ID,
              image_type: "product",
              width_px: body.width_px,
              height_px: body.height_px,
              output_format: body.output_format ?? "jpeg",
              created_at: new Date().toISOString(),
            },
          }),
        });
        return;
      }
      await route.fulfill({ status: 405, body: "" });
    },
  );
}

test.describe("Channels page – product image dimensions manager (owner)", () => {
  test("owner can add a new dimension row for a channel", async ({ page }) => {
    await setupChannelsPage(page, { role: "owner", initialDimensions: [] });

    // Expand the dimensions section for this channel.
    await page.getByTestId(`btn-expand-dimensions-${CHANNEL_ID}`).click();

    // No dims yet — the empty state copy is shown.
    await expect(page.getByText("No dimensions configured.")).toBeVisible();

    // No "Brand" or "Select brand" label is visible anywhere on the page.
    await expect(page.getByText("Brand", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Select brand", { exact: true })).toHaveCount(0);

    // Open the add form.
    await page.getByTestId(`btn-add-dim-${CHANNEL_ID}`).click();

    // Still no brand UI after the form opens.
    await expect(page.getByText("Select brand", { exact: true })).toHaveCount(0);

    // Fill in width + height and submit (no brand selection needed).
    await page.getByTestId("input-add-dim-width").fill("1080");
    await page.getByTestId("input-add-dim-height").fill("1350");
    await page.getByTestId("btn-add-dim-submit").click();

    // The new row is rendered in the table inside this channel.
    const channelRow = page.getByTestId(`channel-row-${CHANNEL_ID}`);
    await expect(channelRow.getByText("1080", { exact: true })).toBeVisible({
      timeout: 8_000,
    });
    await expect(channelRow.getByText("1350", { exact: true })).toBeVisible();

    // The empty-state text is gone.
    await expect(page.getByText("No dimensions configured.")).toHaveCount(0);
  });

  test("owner can edit an existing dimension row's width and height", async ({
    page,
  }) => {
    const existingId = 555;
    await setupChannelsPage(page, {
      role: "owner",
      initialDimensions: [
        {
          id: existingId,
          channel_id: CHANNEL_ID,
          channel_name: CHANNEL_NAME,
          width: 800,
          height: 800,
        },
      ],
    });

    await page.getByTestId(`btn-expand-dimensions-${CHANNEL_ID}`).click();

    // Existing row visible.
    await expect(page.getByText("800", { exact: true }).first()).toBeVisible({
      timeout: 8_000,
    });

    // Enter edit mode.
    await page.getByTestId(`btn-edit-dim-${existingId}`).click();

    // Both inputs are pre-filled with current values; replace them.
    const numberInputs = page.locator('input[type="number"]');
    // The two edit inputs for this row are the first two number inputs in the table.
    await numberInputs.nth(0).fill("1200");
    await numberInputs.nth(1).fill("1500");

    await page.getByRole("button", { name: "Save", exact: true }).click();

    // After saving, the row exits edit mode and shows the new values.
    await expect(page.getByText("1200", { exact: true })).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByText("1500", { exact: true })).toBeVisible();
    // Old values are gone.
    await expect(page.getByText("800", { exact: true })).toHaveCount(0);
  });

  test("owner can delete an existing dimension row", async ({ page }) => {
    const existingId = 777;
    await setupChannelsPage(page, {
      role: "owner",
      initialDimensions: [
        {
          id: existingId,
          channel_id: CHANNEL_ID,
          channel_name: CHANNEL_NAME,
          width: 600,
          height: 900,
        },
      ],
    });

    await page.getByTestId(`btn-expand-dimensions-${CHANNEL_ID}`).click();

    // Confirm the row is visible first.
    await expect(page.getByText("600", { exact: true })).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByText("900", { exact: true })).toBeVisible();

    // Click the row's delete button.
    await page.getByTestId(`btn-delete-dim-${existingId}`).click();

    // After deletion the row disappears and the empty-state text returns.
    await expect(page.getByText("600", { exact: true })).toHaveCount(0, {
      timeout: 8_000,
    });
    await expect(page.getByText("No dimensions configured.")).toBeVisible();
  });
});

test.describe("Channels page – product image dimensions manager (validation)", () => {
  test("add form blocks invalid widths and heights with inline errors", async ({
    page,
  }) => {
    await setupChannelsPage(page, { role: "owner", initialDimensions: [] });

    await page.getByTestId(`btn-expand-dimensions-${CHANNEL_ID}`).click();
    await page.getByTestId(`btn-add-dim-${CHANNEL_ID}`).click();

    const widthInput = page.getByTestId("input-add-dim-width");
    const heightInput = page.getByTestId("input-add-dim-height");
    const submitBtn = page.getByTestId("btn-add-dim-submit");
    const widthError = page.getByTestId("add-dim-width-error");
    const heightError = page.getByTestId("add-dim-height-error");

    // 1. Zero width is rejected.
    await widthInput.fill("0");
    await heightInput.fill("1080");
    await expect(widthError).toHaveText("Width must be a valid pixel value.");
    await expect(submitBtn).toBeDisabled();

    // 2. Negative width is rejected.
    await widthInput.fill("-5");
    await expect(widthError).toHaveText("Width must be a valid pixel value.");
    await expect(submitBtn).toBeDisabled();

    // 3. Decimal width is rejected.
    await widthInput.fill("1.5");
    await expect(widthError).toHaveText("Width must be a valid pixel value.");
    await expect(submitBtn).toBeDisabled();

    // 4. Blank width is rejected (after the user has touched the field).
    await widthInput.fill("");
    await expect(widthError).toHaveText("Width must be a valid pixel value.");
    await expect(submitBtn).toBeDisabled();

    // The same checks apply to the height field independently.
    await widthInput.fill("1080");
    await heightInput.fill("0");
    await expect(heightError).toHaveText("Height must be a valid pixel value.");
    await expect(submitBtn).toBeDisabled();

    await heightInput.fill("2.7");
    await expect(heightError).toHaveText("Height must be a valid pixel value.");
    await expect(submitBtn).toBeDisabled();

    await heightInput.fill("");
    await expect(heightError).toHaveText("Height must be a valid pixel value.");
    await expect(submitBtn).toBeDisabled();

    // Once both fields hold valid positive integers, the button becomes
    // clickable again — proving the validation is what was blocking it.
    await heightInput.fill("1080");
    await expect(widthError).toHaveCount(0);
    await expect(heightError).toHaveCount(0);
    await expect(submitBtn).toBeEnabled();
  });

  test("edit form blocks invalid widths and heights with inline errors", async ({
    page,
  }) => {
    const existingId = 999;
    await setupChannelsPage(page, {
      role: "owner",
      initialDimensions: [
        {
          id: existingId,
          channel_id: CHANNEL_ID,
          channel_name: CHANNEL_NAME,
          width: 800,
          height: 800,
        },
      ],
    });

    await page.getByTestId(`btn-expand-dimensions-${CHANNEL_ID}`).click();
    await page.getByTestId(`btn-edit-dim-${existingId}`).click();

    const widthInput = page.getByTestId(`input-edit-dim-width-${existingId}`);
    const heightInput = page.getByTestId(`input-edit-dim-height-${existingId}`);
    const widthError = page.getByTestId(`edit-dim-width-error-${existingId}`);
    const heightError = page.getByTestId(`edit-dim-height-error-${existingId}`);
    const saveBtn = page.getByRole("button", { name: "Save", exact: true });

    // Decimal width is rejected.
    await widthInput.fill("1.5");
    await expect(widthError).toHaveText("Width must be a valid pixel value.");
    await expect(saveBtn).toBeDisabled();

    // Zero width is rejected.
    await widthInput.fill("0");
    await expect(widthError).toHaveText("Width must be a valid pixel value.");
    await expect(saveBtn).toBeDisabled();

    // Negative width is rejected.
    await widthInput.fill("-10");
    await expect(widthError).toHaveText("Width must be a valid pixel value.");
    await expect(saveBtn).toBeDisabled();

    // Blank width is rejected.
    await widthInput.fill("");
    await expect(widthError).toHaveText("Width must be a valid pixel value.");
    await expect(saveBtn).toBeDisabled();

    // Restoring a valid width re-enables Save (height is still 800).
    await widthInput.fill("1200");
    await expect(widthError).toHaveCount(0);
    await expect(saveBtn).toBeEnabled();

    // Same set of checks now exercised against the height field.
    await heightInput.fill("0");
    await expect(heightError).toHaveText("Height must be a valid pixel value.");
    await expect(saveBtn).toBeDisabled();

    await heightInput.fill("3.14");
    await expect(heightError).toHaveText("Height must be a valid pixel value.");
    await expect(saveBtn).toBeDisabled();

    await heightInput.fill("");
    await expect(heightError).toHaveText("Height must be a valid pixel value.");
    await expect(saveBtn).toBeDisabled();

    await heightInput.fill("1500");
    await expect(heightError).toHaveCount(0);
    await expect(saveBtn).toBeEnabled();
  });

  test("no Brand label or Select brand UI is visible in the dimensions section", async ({
    page,
  }) => {
    await setupChannelsPage(page, { role: "owner", initialDimensions: [] });

    await page.getByTestId(`btn-expand-dimensions-${CHANNEL_ID}`).click();
    await page.getByTestId(`btn-add-dim-${CHANNEL_ID}`).click();

    // The add form should never show a "Brand" label or "Select brand" placeholder.
    await expect(page.getByText("Select brand", { exact: true })).toHaveCount(0);
    // There should be no combobox for brand selection in the dimensions add form.
    const channelRow = page.getByTestId(`channel-row-${CHANNEL_ID}`);
    const dimSection = channelRow
      .locator('[data-testid^="btn-expand-dimensions"]')
      .locator("..");
    await expect(dimSection.getByRole("combobox")).toHaveCount(0);
  });
});

test.describe("Channels page – product image dimensions manager (member)", () => {
  test("non-owner members do not see the dimensions manager at all", async ({
    page,
  }) => {
    await setupChannelsPage(page, { role: "member", initialDimensions: [] });

    // The whole ChannelDimensionsSection is gated on isOwner inside the channel
    // row, so members never see the expand toggle.
    await expect(
      page.getByTestId(`btn-expand-dimensions-${CHANNEL_ID}`),
    ).toHaveCount(0);
    await expect(page.getByText("Product Image Dimensions")).toHaveCount(0);
  });
});

test.describe("output_format field – channel product dimensions (display)", () => {
  test("dimension with png output_format shows PNG suffix in the product lightbox dialog", async ({
    page,
  }) => {
    await setupProductDetailRoutes(page, { outputFormat: "png" });

    await page.goto(`/products/${PRODUCT_ID}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: MOCK_PRODUCT.name })).toBeVisible({ timeout: 15_000 });

    const thumb = page.getByTestId("product-image-thumb");
    await expect(thumb).toBeVisible({ timeout: 12_000 });
    await thumb.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 8_000 });

    // Wait for the channel row with dimensions to load.
    await expect(dialog.getByText(CHANNEL_NAME, { exact: true })).toBeVisible({
      timeout: 8_000,
    });

    // The dimension line in the lightbox must show "· PNG" — confirming that
    // output_format is read from the API response and displayed correctly.
    await expect(
      dialog.getByText(
        `${PNG_DIMENSION_WIDTH} × ${PNG_DIMENSION_HEIGHT} px · PNG`,
        { exact: true },
      ),
    ).toBeVisible({ timeout: 8_000 });
  });

  test("dimension with jpeg output_format shows JPEG suffix in the product lightbox dialog", async ({
    page,
  }) => {
    await setupProductDetailRoutes(page, { outputFormat: "jpeg" });

    await page.goto(`/products/${PRODUCT_ID}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: MOCK_PRODUCT.name })).toBeVisible({ timeout: 15_000 });

    const thumb = page.getByTestId("product-image-thumb");
    await expect(thumb).toBeVisible({ timeout: 12_000 });
    await thumb.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 8_000 });

    await expect(dialog.getByText(CHANNEL_NAME, { exact: true })).toBeVisible({
      timeout: 8_000,
    });

    await expect(
      dialog.getByText(
        `${PNG_DIMENSION_WIDTH} × ${PNG_DIMENSION_HEIGHT} px · JPEG`,
        { exact: true },
      ),
    ).toBeVisible({ timeout: 8_000 });
  });

  test("dimension with webp output_format shows WEBP suffix in the product lightbox dialog", async ({
    page,
  }) => {
    await setupProductDetailRoutes(page, { outputFormat: "webp" });

    await page.goto(`/products/${PRODUCT_ID}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: MOCK_PRODUCT.name })).toBeVisible({ timeout: 15_000 });

    const thumb = page.getByTestId("product-image-thumb");
    await expect(thumb).toBeVisible({ timeout: 12_000 });
    await thumb.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 8_000 });

    await expect(dialog.getByText(CHANNEL_NAME, { exact: true })).toBeVisible({
      timeout: 8_000,
    });

    await expect(
      dialog.getByText(
        `${PNG_DIMENSION_WIDTH} × ${PNG_DIMENSION_HEIGHT} px · WEBP`,
        { exact: true },
      ),
    ).toBeVisible({ timeout: 8_000 });
  });
});

test.describe("output_format field – crop modal description and download filename", () => {
  test("crop modal shows PNG suffix in its description and download uses .png extension", async ({
    page,
  }) => {
    // Intercept programmatic <a download> clicks to capture the filename.
    // ImageCropDownloadModal creates an anchor with `a.download = "...filename.ext"`
    // and calls `a.click()`. This init script captures that attribute so the
    // test can assert the extension without triggering a real file save.
    const captured: Array<{ download: string }> = [];
    await page.exposeFunction(
      "__recordFormatDownloadClick",
      (download: string) => {
        captured.push({ download });
      },
    );
    await page.addInitScript(() => {
      const origClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
        if (this.hasAttribute("download")) {
          const w = window as unknown as {
            __recordFormatDownloadClick: (download: string) => void;
          };
          w.__recordFormatDownloadClick(this.getAttribute("download") ?? "");
        }
        return origClick.call(this);
      };
    });

    await setupProductDetailRoutes(page, { outputFormat: "png" });

    await page.goto(`/products/${PRODUCT_ID}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: MOCK_PRODUCT.name })).toBeVisible({ timeout: 15_000 });

    const thumb = page.getByTestId("product-image-thumb");
    await expect(thumb).toBeVisible({ timeout: 12_000 });
    await thumb.click();

    // Wait for the product lightbox dialog.
    const lightboxDialog = page.getByRole("dialog");
    await expect(lightboxDialog).toBeVisible({ timeout: 8_000 });
    await expect(
      lightboxDialog.getByText(CHANNEL_NAME, { exact: true }),
    ).toBeVisible({ timeout: 8_000 });

    // Verify "· PNG" appears in the dimension row before opening the crop modal.
    await expect(
      lightboxDialog.getByText(
        `${PNG_DIMENSION_WIDTH} × ${PNG_DIMENSION_HEIGHT} px · PNG`,
        { exact: true },
      ),
    ).toBeVisible({ timeout: 4_000 });

    // Click the channel's Download button to open the ImageCropDownloadModal.
    const channelDownloadBtn = lightboxDialog
      .getByRole("button", { name: /^Download$/ })
      .first();
    await expect(channelDownloadBtn).toBeEnabled({ timeout: 8_000 });
    await channelDownloadBtn.click();

    // The crop modal opens alongside the lightbox. Locate it by its title.
    const cropModal = page.getByRole("dialog").filter({
      has: page.getByText(`Crop for ${CHANNEL_NAME}`, { exact: true }),
    });
    await expect(cropModal).toBeVisible({ timeout: 8_000 });

    // The modal description must contain "· PNG" — confirming output_format is
    // passed through from the dimension row to ImageCropDownloadModal.
    await expect(
      cropModal.getByText(
        `${PNG_DIMENSION_WIDTH} × ${PNG_DIMENSION_HEIGHT} px · PNG`,
      ),
    ).toBeVisible({ timeout: 4_000 });

    // Wait for the Download button inside the crop modal to become enabled.
    // It becomes enabled once the Cropper fires onCropComplete (after image load).
    const cropDownloadBtn = cropModal.getByRole("button", {
      name: "Download",
      exact: true,
    });
    await expect(cropDownloadBtn).toBeEnabled({ timeout: 12_000 });

    // Click the Download button — the modal calls canvas.toBlob + URL.createObjectURL
    // then programmatically clicks a hidden <a download="filename.png"> anchor.
    await cropDownloadBtn.click();

    // Wait for the anchor click to be captured by our init script.
    await expect
      .poll(() => captured.length, { timeout: 8_000 })
      .toBeGreaterThan(0);

    // The download filename must end with ".png" because output_format is "png"
    // (FILE_EXT["png"] === "png" in ImageCropDownloadModal.tsx).
    expect(captured[0]!.download).toMatch(/\.png$/);
  });
});

test.describe("output_format field – ChannelDetail image config form", () => {
  test("PNG output_format is submitted when adding a product image config via channel detail page", async ({
    page,
  }) => {
    const capturedBodies: Array<Record<string, unknown>> = [];

    await setupChannelDetailRoutes(page, {
      imageConfigs: [],
      onImageConfigPost: (body) => capturedBodies.push(body),
    });

    await page.goto(`/channels/${CHANNEL_ID}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Instagram" })).toBeVisible({ timeout: 15_000 });

    // Wait for the channel detail page to load.
    await expect(page.getByTestId("channel-detail-name")).toBeVisible({
      timeout: 12_000,
    });

    // Click "Add" for the Product Image Dimensions section.
    await page.getByTestId("btn-edit-product-config").click();

    // The inline form opens. Fill in width and height.
    await page.getByTestId("input-product-width").fill("750");
    await page.getByTestId("input-product-height").fill("300");

    // Change the Output Format to PNG using the Select control.
    await page.getByTestId("select-product-format").click();
    await page.getByRole("option", { name: "PNG", exact: true }).click();

    // Submit the form.
    await page.getByTestId("btn-submit-product-config").click();

    // After saving, the form closes (editing state resets). Wait for the
    // success response to propagate by polling the captured POST body.
    await expect
      .poll(() => capturedBodies.length, { timeout: 8_000 })
      .toBeGreaterThan(0);

    // The POST payload must include output_format: "png".
    expect(capturedBodies[0]!.output_format).toBe("png");
    expect(capturedBodies[0]!.width_px).toBe(750);
    expect(capturedBodies[0]!.height_px).toBe(300);
    expect(capturedBodies[0]!.image_type).toBe("product");
  });

  test("WEBP output_format is submitted when editing an existing product image config", async ({
    page,
  }) => {
    const capturedPuts: Array<Record<string, unknown>> = [];
    const existingConfigId = 200;

    await setupChannelDetailRoutes(page, {
      imageConfigs: [
        {
          id: existingConfigId,
          channel_id: CHANNEL_ID,
          image_type: "product",
          width_px: 1080,
          height_px: 1080,
          output_format: "jpeg",
          created_at: new Date().toISOString(),
        },
      ],
      onImageConfigPut: (_id, body) => capturedPuts.push(body),
    });

    await page.goto(`/channels/${CHANNEL_ID}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Instagram" })).toBeVisible({ timeout: 15_000 });

    await expect(page.getByTestId("channel-detail-name")).toBeVisible({
      timeout: 12_000,
    });

    // The existing config shows "Edit" instead of "Add".
    await page.getByTestId("btn-edit-product-config").click();

    // Change the format to WEBP.
    await page.getByTestId("select-product-format").click();
    await page.getByRole("option", { name: "WEBP", exact: true }).click();

    // Submit.
    await page.getByTestId("btn-submit-product-config").click();

    await expect
      .poll(() => capturedPuts.length, { timeout: 8_000 })
      .toBeGreaterThan(0);

    // The PUT payload must include output_format: "webp".
    expect(capturedPuts[0]!.output_format).toBe("webp");
  });
});
