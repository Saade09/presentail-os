import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";

const EXISTING_ROLE_NAME = "Designer";

const MOCK_ROLES = {
  roles: [
    { id: 1, name: EXISTING_ROLE_NAME, allowed_pages: [], channel_ids: [] },
  ],
};

test.describe("Name duplicate warning in the create-role form", () => {
  test.beforeEach(async ({ page }) => {
    await setupClerkTestingToken({ page });

    await page.route("**/api/roles**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(MOCK_ROLES),
      });
    });

    await page.route("**/api/users**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ members: [], me: { role: "owner", email: "owner@test.com", allowedPages: null, customRoleId: null } }),
      });
    });

    await page.goto("/roles", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Roles" })).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("button-new-role").click();
    await expect(page.getByTestId("input-role-name")).toBeVisible({ timeout: 8_000 });
  });

  test("shows no warning when the name input is empty", async ({ page }) => {
    await expect(page.getByTestId("name-warning-exact")).not.toBeVisible();
    await expect(page.getByTestId("name-warning-similar")).not.toBeVisible();
  });

  test("shows an exact-match warning when typing an existing role name", async ({ page }) => {
    await page.getByTestId("input-role-name").fill(EXISTING_ROLE_NAME);

    await expect(page.getByTestId("name-warning-exact")).toBeVisible({ timeout: 3_000 });
    await expect(page.getByTestId("name-warning-exact")).toContainText(EXISTING_ROLE_NAME);
    await expect(page.getByTestId("name-warning-similar")).not.toBeVisible();
  });

  test("exact-match warning is case-insensitive", async ({ page }) => {
    await page.getByTestId("input-role-name").fill(EXISTING_ROLE_NAME.toUpperCase());

    await expect(page.getByTestId("name-warning-exact")).toBeVisible({ timeout: 3_000 });
  });

  test("shows a similar-match warning when typing a substring of an existing role name", async ({ page }) => {
    await page.getByTestId("input-role-name").fill("Design");

    await expect(page.getByTestId("name-warning-similar")).toBeVisible({ timeout: 3_000 });
    await expect(page.getByTestId("name-warning-similar")).toContainText(EXISTING_ROLE_NAME);
    await expect(page.getByTestId("name-warning-exact")).not.toBeVisible();
  });

  test("warning disappears when name is changed to something unrelated", async ({ page }) => {
    const nameInput = page.getByTestId("input-role-name");

    await nameInput.fill(EXISTING_ROLE_NAME);
    await expect(page.getByTestId("name-warning-exact")).toBeVisible({ timeout: 3_000 });

    await nameInput.fill("Finance");
    await expect(page.getByTestId("name-warning-exact")).not.toBeVisible({ timeout: 3_000 });
    await expect(page.getByTestId("name-warning-similar")).not.toBeVisible();
  });
});
