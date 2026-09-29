import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";

const OWNER_EMAIL = "e2e-tester@presentail.com";

const MOCK_SUMMARY = {
  total_brands: 5,
  total_locations: 12,
  total_channels: 3,
  products_available: 44,
  products_out_of_stock: 7,
  products_not_available: 2,
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

function memberUsersResponse(allowedPages: string[]) {
  return {
    members: [
      {
        id: 2,
        email: "member@example.com",
        role: "member",
        custom_role_id: 10,
        role_name: "Project Manager",
        joined: true,
        joined_at: new Date().toISOString(),
        invited_at: new Date().toISOString(),
        invited_by_email: OWNER_EMAIL,
        manager_member_id: null,
        manager_email: null,
      },
    ],
    me: {
      role: "member",
      email: "member@example.com",
      allowedPages,
      customRoleId: 10,
    },
  };
}

test.describe("Project Manager Dashboard", () => {
  test(
    "all six stat cards render with numeric values for an owner",
    async ({ page }) => {
      await setupClerkTestingToken({ page });

      await page.route("**/api/users**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(ownerUsersResponse()),
        });
      });

      await page.route("**/api/dashboard/summary**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(MOCK_SUMMARY),
        });
      });

      await page.goto("/project-manager-dashboard", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15_000 });

      await expect(
        page.getByTestId("pm-stat-skeleton").first(),
      ).not.toBeVisible({ timeout: 12_000 });

      await expect(page.getByTestId("pm-stat-brands")).toHaveText("5", { timeout: 8_000 });
      await expect(page.getByTestId("pm-stat-locations")).toHaveText("12");
      await expect(page.getByTestId("pm-stat-channels")).toHaveText("3");
      await expect(page.getByTestId("pm-stat-products-available")).toHaveText("44");
      await expect(page.getByTestId("pm-stat-products-out-of-stock")).toHaveText("7");
      await expect(page.getByTestId("pm-stat-products-not-available")).toHaveText("2");
    },
  );

  test(
    "member with project-manager-dashboard in allowedPages is redirected there from /dashboard",
    async ({ page }) => {
      await setupClerkTestingToken({ page });

      await page.route("**/api/users**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(
            memberUsersResponse(["project-manager-dashboard"]),
          ),
        });
      });

      await page.route("**/api/dashboard/summary**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(MOCK_SUMMARY),
        });
      });

      await page.goto("/dashboard", { waitUntil: "domcontentloaded" });

      await expect(page).toHaveURL(/\/project-manager-dashboard/, {
        timeout: 12_000,
      });

      await expect(
        page.getByRole("heading", { level: 1 }),
      ).toBeVisible({ timeout: 8_000 });
    },
  );

  test(
    "member without project-manager-dashboard in allowedPages cannot access /dashboard/project-manager-dashboard",
    async ({ page }) => {
      await setupClerkTestingToken({ page });

      await page.route("**/api/users**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(memberUsersResponse(["devices"])),
        });
      });

      await page.route("**/api/devices**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ devices: [] }),
        });
      });

      await page.goto("/project-manager-dashboard", { waitUntil: "domcontentloaded" });

      await expect(page).toHaveURL(/\/devices/, {
        timeout: 12_000,
      });

      await expect(
        page.getByRole("heading", { name: "Devices" }),
      ).toBeVisible({ timeout: 8_000 });

      await expect(
        page.getByTestId("pm-stat-skeleton"),
      ).not.toBeVisible();

      await expect(page.getByTestId("pm-stat-brands")).toHaveCount(0);
      await expect(page.getByTestId("pm-stat-locations")).toHaveCount(0);
      await expect(page.getByTestId("pm-stat-channels")).toHaveCount(0);
      await expect(page.getByTestId("pm-stat-products-available")).toHaveCount(0);
      await expect(page.getByTestId("pm-stat-products-out-of-stock")).toHaveCount(0);
      await expect(page.getByTestId("pm-stat-products-not-available")).toHaveCount(0);
    },
  );
});
