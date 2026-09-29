import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";

const OWNER_EMAIL = "e2e-tester+clerk_test@presentail.com";

const MOCK_STICKER_ID = 99;
const MOCK_STICKER_NAME = "My Custom Label";

const MOCK_BRANDS = { brands: [] };

const MOCK_STICKERS = {
  stickers: [
    {
      id: MOCK_STICKER_ID,
      name: MOCK_STICKER_NAME,
      file_name: "my-custom-label.pdf",
      created_at: new Date().toISOString(),
      brand_id: null,
      brand_name: null,
    },
  ],
};

// Minimal 1×1 transparent PNG so img.onError does not fire after regen.
const MINIMAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

function usersResponse(role: "owner" | "member", allowedPages: string[] | null = null) {
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
      allowedPages,
      customRoleId: null,
    },
  };
}

async function setupStickersPage(
  page: import("@playwright/test").Page,
  role: "owner" | "member",
  allowedPages: string[] | null = null,
) {
  await setupClerkTestingToken({ page });

  await page.route("**/api/users**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(usersResponse(role, allowedPages)),
    });
  });

  await page.route("**/api/brands**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_BRANDS),
    });
  });

  await page.route(
    (url) => url.pathname === "/api/stickers",
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(MOCK_STICKERS),
      });
    },
  );

  await page.goto("/stickers", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Stickers" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(MOCK_STICKER_NAME)).toBeVisible({ timeout: 12_000 });
}

test.describe("Sticker thumbnail regeneration", () => {
  test(
    "a custom sticker with no thumbnail shows the 📄 placeholder and the Regenerate thumbnail button for owners",
    async ({ page }) => {
      await page.route("**/api/stickers/*/thumbnail**", async (route) => {
        await route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ error: "Not found" }),
        });
      });

      await setupStickersPage(page, "owner");

      const regenButton = page.getByTestId("button-regen-thumbnail");
      await expect(regenButton).toBeVisible({ timeout: 8_000 });

      const placeholder = page.getByText("📄");
      await expect(placeholder).toBeVisible({ timeout: 4_000 });
    },
  );

  test(
    "clicking Regenerate thumbnail triggers POST /api/stickers/:id/thumbnail, shows a success toast, and the button disappears",
    async ({ page }) => {
      let postCalled = false;
      let thumbnailAvailable = false;

      await page.route("**/api/stickers/*/thumbnail**", async (route) => {
        if (route.request().method() === "POST") {
          postCalled = true;
          thumbnailAvailable = true;
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ ok: true, thumbnail_generated: true }),
          });
        } else {
          if (thumbnailAvailable) {
            await route.fulfill({
              status: 200,
              contentType: "image/png",
              body: MINIMAL_PNG,
            });
          } else {
            await route.fulfill({
              status: 404,
              contentType: "application/json",
              body: JSON.stringify({ error: "Not found" }),
            });
          }
        }
      });

      await setupStickersPage(page, "owner");

      const regenButton = page.getByTestId("button-regen-thumbnail");
      await expect(regenButton).toBeVisible({ timeout: 8_000 });

      await regenButton.click();

      await expect(page.getByText("Thumbnail regenerated", { exact: true })).toBeVisible({ timeout: 8_000 });

      expect(postCalled).toBe(true);

      await expect(regenButton).not.toBeVisible({ timeout: 8_000 });
    },
  );

  test(
    "the Regenerate thumbnail button is absent for members without manage permissions",
    async ({ page }) => {
      await page.route("**/api/stickers/*/thumbnail**", async (route) => {
        await route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ error: "Not found" }),
        });
      });

      await setupStickersPage(page, "member", ["stickers"]);

      const regenButton = page.getByTestId("button-regen-thumbnail");
      await expect(regenButton).not.toBeVisible({ timeout: 5_000 });
    },
  );

  test(
    "members with the brands.manage permission do see the Regenerate thumbnail button",
    async ({ page }) => {
      await page.route("**/api/stickers/*/thumbnail**", async (route) => {
        await route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ error: "Not found" }),
        });
      });

      await setupStickersPage(page, "member", ["stickers", "brands.manage"]);

      const regenButton = page.getByTestId("button-regen-thumbnail");
      await expect(regenButton).toBeVisible({ timeout: 8_000 });
    },
  );
});
