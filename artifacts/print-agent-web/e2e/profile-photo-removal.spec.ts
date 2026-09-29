import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";

const OWNER_EMAIL = "e2e-tester@presentail.com";

const MOCK_USERS_RESPONSE = {
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

const MOCK_PROFILE_RESPONSE = {
  phone: null,
  job_title: null,
};

const MOCK_ROLES_RESPONSE = {
  roles: [],
};

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

async function setupCommonRoutes(page: import("@playwright/test").Page) {
  await page.route("**/api/users**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_USERS_RESPONSE),
    });
  });

  await page.route("**/api/roles**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_ROLES_RESPONSE),
    });
  });
}

test.describe("Profile error paths", () => {
  test(
    "shows a destructive toast when name save fails (Clerk PATCH returns 500)",
    async ({ page }) => {
      await setupClerkTestingToken({ page });
      await setupCommonRoutes(page);

      await page.route("**/api/profile**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(MOCK_PROFILE_RESPONSE),
        });
      });

      await page.goto("/profile", { waitUntil: "domcontentloaded" });

      await expect(
        page.getByRole("heading", { name: "Profile" }),
      ).toBeVisible({ timeout: 12_000 });

      const saveNameButton = page.getByTestId("save-name-button");
      await expect(saveNameButton).toBeVisible({ timeout: 8_000 });

      await page.evaluate(() => {
        const win = window as unknown as {
          Clerk?: { user?: { update?: (...args: unknown[]) => Promise<unknown> } };
        };
        if (win.Clerk?.user) {
          win.Clerk.user.update = async () => {
            throw new Error("Simulated Clerk 500 error");
          };
        }
      });

      await saveNameButton.click();

      await expect(
        page.getByText("Failed to update name").first(),
      ).toBeVisible({ timeout: 15_000 });
    },
  );

  test(
    "shows a destructive toast when profile save fails (PATCH /api/profile returns 500)",
    async ({ page }) => {
      await setupClerkTestingToken({ page });
      await setupCommonRoutes(page);

      await page.route("**/api/profile**", async (route) => {
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
            body: JSON.stringify(MOCK_PROFILE_RESPONSE),
          });
        }
      });

      await page.goto("/profile", { waitUntil: "domcontentloaded" });

      await expect(
        page.getByRole("heading", { name: "Profile" }),
      ).toBeVisible({ timeout: 12_000 });

      const saveProfileButton = page.getByTestId("save-profile-button");
      await expect(saveProfileButton).toBeVisible({ timeout: 8_000 });

      await saveProfileButton.click();

      await expect(
        page.getByText("Failed to save").first(),
      ).toBeVisible({ timeout: 15_000 });
    },
  );
});

test.describe("Profile photo removal flow", () => {
  test(
    "shows an error toast when photo upload fails",
    async ({ page }) => {
      await setupClerkTestingToken({ page });

      await page.route("**/api/users**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(MOCK_USERS_RESPONSE),
        });
      });

      await page.route("**/api/roles**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(MOCK_ROLES_RESPONSE),
        });
      });

      await page.route("**/api/profile**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(MOCK_PROFILE_RESPONSE),
        });
      });

      await page.route("**/v1/me/profile_image**", async (route) => {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "Internal Server Error" }),
        });
      });

      await page.goto("/profile", { waitUntil: "domcontentloaded" });

      await expect(
        page.getByRole("heading", { name: "Profile" }),
      ).toBeVisible({ timeout: 12_000 });

      const fileInput = page.getByTestId("photo-file-input");
      await expect(fileInput).toBeAttached({ timeout: 8_000 });

      await fileInput.setInputFiles({
        name: "test-avatar.png",
        mimeType: "image/png",
        buffer: Buffer.from(TINY_PNG_BASE64, "base64"),
      });

      await expect(
        page.getByText("Could not update your photo. Please try again.").first(),
      ).toBeVisible({ timeout: 20_000 });
    },
  );

  test(
    "shows an error toast when photo removal fails",
    async ({ page }) => {
      await setupClerkTestingToken({ page });

      await page.route("**/api/users**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(MOCK_USERS_RESPONSE),
        });
      });

      await page.route("**/api/roles**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(MOCK_ROLES_RESPONSE),
        });
      });

      await page.route("**/api/profile**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(MOCK_PROFILE_RESPONSE),
        });
      });

      await page.route("**/v1/me/profile_image**", async (route) => {
        await route.continue();
      });

      await page.goto("/profile", { waitUntil: "domcontentloaded" });

      await expect(
        page.getByRole("heading", { name: "Profile" }),
      ).toBeVisible({ timeout: 12_000 });

      const fileInput = page.getByTestId("photo-file-input");
      await expect(fileInput).toBeAttached({ timeout: 8_000 });

      await fileInput.setInputFiles({
        name: "test-avatar.png",
        mimeType: "image/png",
        buffer: Buffer.from(TINY_PNG_BASE64, "base64"),
      });

      await expect(page.getByText("Photo updated").first()).toBeVisible({
        timeout: 20_000,
      });

      const removeButton = page.getByTestId("remove-photo-button");
      await expect(removeButton).toBeVisible({ timeout: 10_000 });

      await page.route("**/v1/me/profile_image**", async (route) => {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "Internal Server Error" }),
        });
      });

      await removeButton.click();

      await expect(
        page.getByText("Could not remove your photo. Please try again.").first(),
      ).toBeVisible({ timeout: 20_000 });
    },
  );

  test(
    "upload a photo, confirm Remove button appears, remove it, verify toast and sidebar revert to initials",
    async ({ page }) => {
      await setupClerkTestingToken({ page });

      await page.route("**/api/users**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(MOCK_USERS_RESPONSE),
        });
      });

      await page.route("**/api/roles**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(MOCK_ROLES_RESPONSE),
        });
      });

      await page.route("**/api/profile**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(MOCK_PROFILE_RESPONSE),
        });
      });

      let profileImageDeleteCalled = false;
      await page.route("**/v1/me/profile_image**", async (route) => {
        const url = route.request().url();
        if (url.includes("_method=DELETE")) {
          profileImageDeleteCalled = true;
        }
        await route.continue();
      });

      await page.goto("/profile", { waitUntil: "domcontentloaded" });

      await expect(
        page.getByRole("heading", { name: "Profile" }),
      ).toBeVisible({ timeout: 12_000 });

      const fileInput = page.getByTestId("photo-file-input");
      await expect(fileInput).toBeAttached({ timeout: 8_000 });

      await fileInput.setInputFiles({
        name: "test-avatar.png",
        mimeType: "image/png",
        buffer: Buffer.from(TINY_PNG_BASE64, "base64"),
      });

      await expect(page.getByText("Photo updated").first()).toBeVisible({
        timeout: 20_000,
      });

      const removeButton = page.getByTestId("remove-photo-button");
      await expect(removeButton).toBeVisible({ timeout: 10_000 });

      const sidebarAvatar = page.getByTestId("sidebar-avatar");
      await expect(sidebarAvatar).toBeVisible();
      await expect(sidebarAvatar.getByTestId("sidebar-avatar-img")).toBeVisible(
        { timeout: 10_000 },
      );

      await removeButton.click();

      await expect(page.getByText("Photo removed").first()).toBeVisible({
        timeout: 15_000,
      });

      expect(profileImageDeleteCalled).toBe(true);

      await expect(removeButton).not.toBeVisible({ timeout: 10_000 });

      await expect(
        sidebarAvatar.getByTestId("sidebar-avatar-img"),
      ).not.toBeVisible({ timeout: 10_000 });
    },
  );
});
