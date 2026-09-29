import { test, expect } from "./fixtures";
import {
  setupFapiWithFakeSession,
} from "./clerk-fapi-redirect";

// Override the _fapiMock auto-fixture with setupFapiWithFakeSession for this
// spec.  All API routes are mocked via page.route, so the backend never
// validates the JWT — a fully static fake Clerk session is sufficient and
// avoids any dependency on the live FAPI host (clerk.presentail.com) or a
// real .auth-session.json written by global-setup.
test.use({
  _fapiMock: [
    async ({ page }, use) => {
      await setupFapiWithFakeSession(page);
      await use();
    },
    { auto: true },
  ],
});

const OWNER_EMAIL = "e2e-tester+clerk_test@presentail.com";

const CHANNEL_A_ID = 31;
const CHANNEL_A_NAME = "Facebook";

const CHANNEL_B_ID = 32;
const CHANNEL_B_NAME = "TikTok";

const PRODUCT_ID = 201;
const IMAGE_PATH = "/lightbox-dim-test.png";
const MOCK_IMAGE_URL = `https://example.com${IMAGE_PATH}`;

// A tiny 1×1 transparent PNG so canvas-based crop dialogs can load the image
// in headless mode without making a real network request.
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADklEQVQI12P4z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==";

const MOCK_PRODUCT = {
  id: PRODUCT_ID,
  workspace_owner_id: "user_1",
  name: "Lightbox Dim Test Product",
  price_usd: "9.99",
  price_aed: "36.69",
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

function usersResponse() {
  return {
    members: [
      {
        id: 1,
        email: OWNER_EMAIL,
        role: "owner",
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
      role: "owner",
      email: OWNER_EMAIL,
      allowedPages: null,
      customRoleId: null,
    },
  };
}

type ImageConfig = {
  id: number;
  channel_id: number;
  channel_name: string;
  image_type: "product" | "banner" | "logo";
  width_px: number;
  height_px: number;
  output_format: "jpeg" | "png" | "webp";
  created_at: string;
};

/**
 * Registers all routes needed for the ProductDetail page + lightbox.
 * The lightbox queries:
 *   GET /api/channel-image-configs?image_type=product  → { image_configs: [...] }
 *   GET /api/channels                                  → { channels: [...] }
 *
 * `imageConfigs` is a live reference — mutating it between route calls
 * (e.g. after a ChannelDetail PUT) lets subsequent GET calls reflect the
 * updated state without re-registering routes.
 */
async function setupProductDetailRoutes(
  page: import("@playwright/test").Page,
  opts: {
    imageConfigs: ImageConfig[];
    channels: Array<{
      id: number;
      name: string;
      has_cover_photo: boolean;
      cover_photo_width: number | null;
      cover_photo_height: number | null;
      has_logo: boolean;
    }>;
  },
) {
  // Serve the product image as a tiny PNG so any canvas operations succeed.
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
      body: JSON.stringify(usersResponse()),
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
        body: JSON.stringify({ channels: opts.channels }),
      });
    },
  );

  // This is the endpoint the lightbox now reads from.
  await page.route(
    (url) =>
      url.pathname === "/api/channel-image-configs" &&
      url.searchParams.get("image_type") === "product",
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ image_configs: opts.imageConfigs }),
      });
    },
  );
}

/**
 * Registers all routes needed for the ChannelDetail page for CHANNEL_A.
 * Supports GET / POST / PUT on image-configs so the format-change flow can
 * be exercised end-to-end.
 *
 * The same `imageConfigs` array reference passed to `setupProductDetailRoutes`
 * should be passed here.  The PUT handler mutates the array in place so that
 * subsequent GET requests to /api/channel-image-configs return the new value.
 */
async function setupChannelDetailRoutes(
  page: import("@playwright/test").Page,
  opts: {
    channelId: number;
    channelName: string;
    imageConfigs: ImageConfig[];
  },
) {
  const { channelId, channelName, imageConfigs } = opts;

  await page.route(`**/api/channels/${channelId}`, async (route) => {
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
          id: channelId,
          name: channelName,
          has_cover_photo: true,
          cover_photo_width: 1080,
          cover_photo_height: 1080,
          has_logo: false,
          created_at: new Date().toISOString(),
          image_configs: imageConfigs.filter(
            (c) => c.channel_id === channelId,
          ),
          contacts: [],
        },
      }),
    });
  });

  await page.route(
    (url) => url.pathname === `/api/channels/${channelId}/image-configs`,
    async (route) => {
      const req = route.request();
      if (req.method() === "POST") {
        const body = req.postDataJSON() as Record<string, unknown>;
        const newConfig: ImageConfig = {
          id: 9001,
          channel_id: channelId,
          channel_name: channelName,
          image_type: (body.image_type as ImageConfig["image_type"]) ?? "product",
          width_px: body.width_px as number,
          height_px: body.height_px as number,
          output_format: (body.output_format as ImageConfig["output_format"]) ?? "jpeg",
          created_at: new Date().toISOString(),
        };
        imageConfigs.push(newConfig);
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({ config: newConfig }),
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
      const idMatch = new URL(req.url()).pathname.match(/\/image-configs\/(\d+)$/);
      const configId = idMatch ? parseInt(idMatch[1]!, 10) : NaN;
      const idx = imageConfigs.findIndex((c) => c.id === configId);

      if (idx === -1) {
        await route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ error: "Not found" }),
        });
        return;
      }

      if (req.method() === "PUT") {
        const body = req.postDataJSON() as Record<string, unknown>;
        imageConfigs[idx] = {
          ...imageConfigs[idx]!,
          width_px: (body.width_px as number) ?? imageConfigs[idx]!.width_px,
          height_px: (body.height_px as number) ?? imageConfigs[idx]!.height_px,
          output_format:
            (body.output_format as ImageConfig["output_format"]) ??
            imageConfigs[idx]!.output_format,
        };
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ config: imageConfigs[idx] }),
        });
        return;
      }

      if (req.method() === "DELETE") {
        imageConfigs.splice(idx, 1);
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
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

const MOCK_CHANNELS = [
  {
    id: CHANNEL_A_ID,
    name: CHANNEL_A_NAME,
    has_cover_photo: true,
    cover_photo_width: 1080,
    cover_photo_height: 1080,
    has_logo: false,
    created_at: new Date().toISOString(),
  },
  {
    id: CHANNEL_B_ID,
    name: CHANNEL_B_NAME,
    has_cover_photo: false,
    cover_photo_width: null,
    cover_photo_height: null,
    has_logo: false,
    created_at: new Date().toISOString(),
  },
];

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

test.describe("Download lightbox – channel_image_configs dimension display", () => {
  test("channel with a configured product image config shows correct width × height and format badge", async ({
    page,
  }) => {
    const WIDTH = 1200;
    const HEIGHT = 628;
    const FORMAT = "webp";

    const imageConfigs: ImageConfig[] = [
      {
        id: 101,
        channel_id: CHANNEL_A_ID,
        channel_name: CHANNEL_A_NAME,
        image_type: "product",
        width_px: WIDTH,
        height_px: HEIGHT,
        output_format: FORMAT,
        created_at: new Date().toISOString(),
      },
    ];

    await setupProductDetailRoutes(page, {
      imageConfigs,
      channels: MOCK_CHANNELS,
    });

    await page.goto(`/products/${PRODUCT_ID}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Lightbox Dim Test Product" })).toBeVisible({ timeout: 15_000 });

    const thumb = page.getByTestId("product-image-thumb");
    await expect(thumb).toBeVisible({ timeout: 12_000 });
    await thumb.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 8_000 });

    // Both channel rows appear.
    await expect(dialog.getByText(CHANNEL_A_NAME, { exact: true })).toBeVisible({
      timeout: 8_000,
    });
    await expect(dialog.getByText(CHANNEL_B_NAME, { exact: true })).toBeVisible();

    // Facebook row shows the configured dimensions and format badge.
    await expect(
      dialog.getByText(`${WIDTH} × ${HEIGHT} px · ${FORMAT.toUpperCase()}`, {
        exact: true,
      }),
    ).toBeVisible({ timeout: 8_000 });

    // Facebook has a config; TikTok does not. So the Download button counts
    // should be 2 total (one enabled for Facebook, one disabled for TikTok).
    // Facebook is rendered first (id=31 < id=32) so .nth(0) is Facebook's button.
    const downloadButtons = dialog.getByRole("button", { name: /^Download$/ });
    await expect(downloadButtons).toHaveCount(2, { timeout: 8_000 });
    await expect(downloadButtons.nth(0)).toBeEnabled();
    await expect(downloadButtons.nth(1)).toBeDisabled();
  });

  test("channel without a product config shows 'No dimensions configured' and its Download button is disabled", async ({
    page,
  }) => {
    // Only Facebook has a config; TikTok has none.
    const imageConfigs: ImageConfig[] = [
      {
        id: 102,
        channel_id: CHANNEL_A_ID,
        channel_name: CHANNEL_A_NAME,
        image_type: "product",
        width_px: 800,
        height_px: 400,
        output_format: "jpeg",
        created_at: new Date().toISOString(),
      },
    ];

    await setupProductDetailRoutes(page, {
      imageConfigs,
      channels: MOCK_CHANNELS,
    });

    await page.goto(`/products/${PRODUCT_ID}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Lightbox Dim Test Product" })).toBeVisible({ timeout: 15_000 });

    const thumb = page.getByTestId("product-image-thumb");
    await expect(thumb).toBeVisible({ timeout: 12_000 });
    await thumb.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 8_000 });

    // TikTok row appears.
    await expect(dialog.getByText(CHANNEL_B_NAME, { exact: true })).toBeVisible({
      timeout: 8_000,
    });

    // TikTok row shows the "No dimensions configured" italic text.
    await expect(
      dialog.getByText("No dimensions configured", { exact: true }),
    ).toBeVisible();

    // TikTok's Download button is disabled (rendered in a disabled wrapper with data-testid).
    const disabledWrapper = page.getByTestId(
      `download-disabled-${CHANNEL_B_ID}`,
    );
    await expect(disabledWrapper).toBeVisible();
    const disabledBtn = disabledWrapper.getByRole("button", {
      name: /^Download$/,
    });
    await expect(disabledBtn).toBeDisabled();
  });

  test("hovering the disabled Download button for a channel with no config shows a helpful tooltip", async ({
    page,
  }) => {
    const imageConfigs: ImageConfig[] = [];

    await setupProductDetailRoutes(page, {
      imageConfigs,
      channels: [
        {
          id: CHANNEL_A_ID,
          name: CHANNEL_A_NAME,
          has_cover_photo: true,
          cover_photo_width: 1080,
          cover_photo_height: 1080,
          has_logo: false,
          created_at: new Date().toISOString(),
        },
      ],
    });

    await page.goto(`/products/${PRODUCT_ID}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Lightbox Dim Test Product" })).toBeVisible({ timeout: 15_000 });

    const thumb = page.getByTestId("product-image-thumb");
    await expect(thumb).toBeVisible({ timeout: 12_000 });
    await thumb.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 8_000 });

    await expect(dialog.getByText(CHANNEL_A_NAME, { exact: true })).toBeVisible({
      timeout: 8_000,
    });

    const disabledWrapper = page.getByTestId(
      `download-disabled-${CHANNEL_A_ID}`,
    );
    await expect(disabledWrapper).toBeVisible();
    await disabledWrapper.hover();

    // Tooltip explains what's missing and provides a link to fix it.
    // The same text appears in the TooltipContent AND the disabledReason paragraph,
    // so scope the check to the tooltip role element to avoid a strict-mode violation.
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toBeVisible({ timeout: 4_000 });
    await expect(
      tooltip.getByText(
        `No image size configured for ${CHANNEL_A_NAME}. Configure dimensions in channel settings.`,
      ),
    ).toBeVisible();

    const channelsLink = tooltip.locator('a[href="/channels"]');
    await expect(channelsLink).toBeVisible();
  });
});

test.describe("Download lightbox – format change in ChannelDetail propagates to lightbox", () => {
  test("updating output_format from jpeg to png in ChannelDetail is reflected when the lightbox is opened", async ({
    page,
  }) => {
    // Shared mutable store — both setupChannelDetailRoutes and
    // setupProductDetailRoutes reference the same array.  When the
    // ChannelDetail PUT handler mutates an entry, the next GET request from
    // the lightbox reads the updated value.
    const imageConfigs: ImageConfig[] = [
      {
        id: 501,
        channel_id: CHANNEL_A_ID,
        channel_name: CHANNEL_A_NAME,
        image_type: "product",
        width_px: 1080,
        height_px: 1080,
        output_format: "jpeg",
        created_at: new Date().toISOString(),
      },
    ];

    // Register all routes up-front — both sets share the imageConfigs reference.
    await setupChannelDetailRoutes(page, {
      channelId: CHANNEL_A_ID,
      channelName: CHANNEL_A_NAME,
      imageConfigs,
    });

    await setupProductDetailRoutes(page, {
      imageConfigs,
      channels: [
        {
          id: CHANNEL_A_ID,
          name: CHANNEL_A_NAME,
          has_cover_photo: true,
          cover_photo_width: 1080,
          cover_photo_height: 1080,
          has_logo: false,
          created_at: new Date().toISOString(),
        },
      ],
    });

    // ── Step 1: open ChannelDetail and change the format to PNG ──────────────

    await page.goto(`/channels/${CHANNEL_A_ID}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Facebook" })).toBeVisible({ timeout: 15_000 });

    await expect(page.getByTestId("channel-detail-name")).toBeVisible({
      timeout: 12_000,
    });

    // The existing config renders an Edit button.
    await page.getByTestId("btn-edit-product-config").click();

    // Change output format from JPEG to PNG.
    await page.getByTestId("select-product-format").click();
    await page.getByRole("option", { name: "PNG", exact: true }).click();

    // Submit the form — this sends a PUT that mutates imageConfigs[0].output_format.
    await page.getByTestId("btn-submit-product-config").click();

    // Wait until the mutation has been processed.  After the PUT responds the
    // in-memory array entry holds output_format: "png".
    await expect(page.getByTestId("btn-edit-product-config")).toBeVisible({
      timeout: 8_000,
    });

    // ── Step 2: navigate to ProductDetail and verify the lightbox ────────────

    await page.goto(`/products/${PRODUCT_ID}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Lightbox Dim Test Product" })).toBeVisible({ timeout: 15_000 });

    const thumb = page.getByTestId("product-image-thumb");
    await expect(thumb).toBeVisible({ timeout: 12_000 });
    await thumb.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 8_000 });

    await expect(dialog.getByText(CHANNEL_A_NAME, { exact: true })).toBeVisible({
      timeout: 8_000,
    });

    // The dimension row must now show "· PNG" — confirming the format change
    // made in ChannelDetail is reflected in the lightbox.
    await expect(
      dialog.getByText(`1080 × 1080 px · PNG`, { exact: true }),
    ).toBeVisible({ timeout: 8_000 });

    // The old "JPEG" badge must not appear.
    await expect(
      dialog.getByText(`1080 × 1080 px · JPEG`, { exact: true }),
    ).toHaveCount(0);
  });
});
