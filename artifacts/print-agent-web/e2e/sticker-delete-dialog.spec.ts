import { test, expect } from "./fixtures";

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

const MOCK_STICKERS_EMPTY = { stickers: [] };

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
  stickerResponseAfterDelete: object = MOCK_STICKERS_EMPTY,
) {
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

  let stickerFetchCount = 0;
  await page.route(
    (url) => url.pathname === "/api/stickers",
    async (route) => {
      stickerFetchCount++;
      const body = stickerFetchCount === 1 ? MOCK_STICKERS : stickerResponseAfterDelete;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    },
  );

  await page.route("**/api/stickers/*/thumbnail**", async (route) => {
    await route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: "Not found" }),
    });
  });

  await page.goto("/stickers", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Stickers" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(MOCK_STICKER_NAME)).toBeVisible({ timeout: 12_000 });
}

test.describe("Sticker delete dialog", () => {
  test(
    "clicking Delete on a custom sticker opens the confirmation dialog",
    async ({ page }) => {
      await setupStickersPage(page, "owner");

      const deleteButton = page.getByTestId("button-delete-sticker");
      await expect(deleteButton).toBeVisible({ timeout: 8_000 });
      await deleteButton.click();

      const dialog = page.getByTestId("dialog-delete-sticker");
      await expect(dialog).toBeVisible({ timeout: 4_000 });

      await expect(dialog.getByText(`Delete "${MOCK_STICKER_NAME}"?`)).toBeVisible();
      await expect(
        dialog.getByText("This sticker will be permanently removed and can't be recovered."),
      ).toBeVisible();
    },
  );

  test(
    "confirming deletion calls DELETE /api/stickers/:id and removes the sticker card",
    async ({ page }) => {
      let deleteCalled = false;
      let deletedId: string | null = null;

      await page.route(`**/api/stickers/${MOCK_STICKER_ID}`, async (route) => {
        if (route.request().method() === "DELETE") {
          deleteCalled = true;
          deletedId = route.request().url().split("/").pop() ?? null;
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ ok: true }),
          });
        } else {
          await route.fallback();
        }
      });

      await setupStickersPage(page, "owner", null, MOCK_STICKERS_EMPTY);

      const deleteButton = page.getByTestId("button-delete-sticker");
      await expect(deleteButton).toBeVisible({ timeout: 8_000 });
      await deleteButton.click();

      const dialog = page.getByTestId("dialog-delete-sticker");
      await expect(dialog).toBeVisible({ timeout: 4_000 });

      const confirmButton = page.getByTestId("button-confirm-delete");
      await expect(confirmButton).toBeVisible();
      await confirmButton.click();

      await expect(page.getByText("Sticker deleted", { exact: true })).toBeVisible({ timeout: 8_000 });

      expect(deleteCalled).toBe(true);
      expect(deletedId).toBe(String(MOCK_STICKER_ID));

      await expect(page.getByText(MOCK_STICKER_NAME)).not.toBeVisible({ timeout: 8_000 });

      await expect(page.getByTestId("dialog-delete-sticker")).not.toBeVisible();
    },
  );

  test(
    "cancelling the dialog leaves the sticker card intact",
    async ({ page }) => {
      let deleteCalled = false;

      await page.route(`**/api/stickers/${MOCK_STICKER_ID}`, async (route) => {
        if (route.request().method() === "DELETE") {
          deleteCalled = true;
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ ok: true }),
          });
        } else {
          await route.fallback();
        }
      });

      await setupStickersPage(page, "owner");

      const deleteButton = page.getByTestId("button-delete-sticker");
      await expect(deleteButton).toBeVisible({ timeout: 8_000 });
      await deleteButton.click();

      const dialog = page.getByTestId("dialog-delete-sticker");
      await expect(dialog).toBeVisible({ timeout: 4_000 });

      const cancelButton = page.getByTestId("button-cancel-delete");
      await expect(cancelButton).toBeVisible();
      await cancelButton.click();

      await expect(dialog).not.toBeVisible({ timeout: 4_000 });

      expect(deleteCalled).toBe(false);

      await expect(page.getByText(MOCK_STICKER_NAME)).toBeVisible({ timeout: 4_000 });
    },
  );
});
