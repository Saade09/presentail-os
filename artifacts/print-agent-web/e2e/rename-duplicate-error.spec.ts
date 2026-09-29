import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";

const OWNER_EMAIL = "e2e-tester@presentail.com";

const MOCK_BRANDS = {
  brands: [
    {
      id: 1,
      name: "Acme Brand",
      description: null,
      target_cogs: null,
      sticker_count: "0",
      product_count: "0",
      has_logo: false,
      created_at: new Date().toISOString(),
    },
    {
      id: 2,
      name: "Globex Brand",
      description: null,
      target_cogs: null,
      sticker_count: "0",
      product_count: "0",
      has_logo: false,
      created_at: new Date().toISOString(),
    },
  ],
  workspaceJobCount: 0,
};

function ownerUsersResponse() {
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

test.describe("Brands list — rename duplicate-name inline error", () => {
  test(
    "shows inline duplicate error when PATCH returns 409, then clears it on input",
    async ({ page }) => {
      let patchCallCount = 0;

      await setupClerkTestingToken({ page });

      await page.route("**/api/users**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(ownerUsersResponse()),
        });
      });

      await page.route("**/api/brands", async (route) => {
        if (route.request().method() === "GET") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(MOCK_BRANDS),
          });
        } else {
          await route.continue();
        }
      });

      // PATCH /api/brands/1 always returns 409 (the new name "Globex Brand"
      // collides with brand id=2).
      await page.route("**/api/brands/1", async (route) => {
        if (route.request().method() === "PATCH") {
          patchCallCount += 1;
          await route.fulfill({
            status: 409,
            contentType: "application/json",
            body: JSON.stringify({ error: "A brand with this name already exists" }),
          });
        } else {
          await route.continue();
        }
      });

      await page.goto("/brands", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Brands" })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("Acme Brand")).toBeVisible({ timeout: 12_000 });
      await expect(page.getByText("Globex Brand")).toBeVisible();

      // Open the rename dialog for "Acme Brand" (id=1).
      await page.getByTestId("button-rename-brand-1").click();

      const nameInput = page.getByTestId("input-brand-rename");
      await expect(nameInput).toBeVisible({ timeout: 4_000 });
      await expect(nameInput).toHaveValue("Acme Brand");

      // Type the existing name of brand id=2.
      await nameInput.fill("Globex Brand");

      // The duplicate inline server error must NOT appear yet — only after Save.
      await expect(page.getByTestId("rename-error-duplicate")).not.toBeVisible();

      await page.getByRole("button", { name: /^Save$/ }).click();

      // The 409 should produce the inline error and the dialog should remain open.
      const duplicateError = page.getByTestId("rename-error-duplicate");
      await expect(duplicateError).toBeVisible({ timeout: 5_000 });
      await expect(duplicateError).toContainText(
        "A brand with this name already exists",
      );
      await expect(nameInput).toBeVisible();

      expect(patchCallCount).toBe(1);

      // Editing the field should immediately clear the inline server error.
      await nameInput.fill("Globex Brand!");
      await expect(page.getByTestId("rename-error-duplicate")).not.toBeVisible({
        timeout: 2_000,
      });

      // No additional PATCH should fire just from typing.
      expect(patchCallCount).toBe(1);
    },
  );

});
