import { test, expect } from "./fixtures";
import { setupFapiWithFakeSession } from "./clerk-fapi-redirect";

test.use({
  _fapiMock: [
    async ({ page }, use) => {
      await setupFapiWithFakeSession(page);
      await use();
    },
    { auto: true },
  ],
});

const MEMBER_EMAIL = "member@example.com";

function memberUsersResponse(allowedPages: string[]) {
  return {
    members: [
      {
        id: 2,
        email: MEMBER_EMAIL,
        role: "member",
        custom_role_id: 10,
        role_name: "Operations",
        joined: true,
        joined_at: new Date().toISOString(),
        invited_at: new Date().toISOString(),
        invited_by_email: "owner@example.com",
        manager_member_id: null,
        manager_email: null,
      },
    ],
    me: {
      role: "member",
      email: MEMBER_EMAIL,
      allowedPages,
      customRoleId: 10,
    },
  };
}

test.describe("Ops Dashboard", () => {
  test("an Ops member lands on the dashboard with actionable operational counts", async ({
    page,
  }) => {
    await page.route("**/api/**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({}),
      });
    });

    await page.route("**/api/users**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          memberUsersResponse([
            "ops-dashboard",
            "orders",
            "cmc_pos.view_location_requests",
          ]),
        ),
      });
    });
    await page.route("**/api/dashboard/operations-summary**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          florist_manual_review_count: 3,
          cmc_submitted_request_count: 2,
          processing_orders_today_count: 8,
        }),
      });
    });

    await page.goto("/dashboard", { waitUntil: "domcontentloaded" });

    await expect(page).toHaveURL(/\/ops-dashboard/, { timeout: 12_000 });
    await expect(page.getByTestId("ops-dashboard")).toBeVisible();
    await expect(page.getByTestId("ops-florist-review")).toContainText("3");
    await expect(page.getByTestId("ops-cmc-requests")).toContainText("2");
    await expect(page.getByTestId("ops-processing-orders")).toContainText("8");
    await expect(page.getByTestId("ops-florist-review").locator("xpath=..")).toHaveAttribute(
      "href",
      "/florist-orders",
    );
    await expect(page.getByTestId("ops-cmc-requests").locator("xpath=..")).toHaveAttribute(
      "href",
      "/cmc-pos/location-requests?status=submitted",
    );
  });

  test("Ops landing takes precedence without changing Project Manager-only landing", async ({
    page,
  }) => {
    await page.route("**/api/**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({}),
      });
    });

    let allowedPages = ["project-manager-dashboard", "ops-dashboard"];
    await page.route("**/api/users**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(memberUsersResponse(allowedPages)),
      });
    });
    await page.route("**/api/dashboard/operations-summary**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          florist_manual_review_count: 0,
          cmc_submitted_request_count: 0,
          processing_orders_today_count: 0,
        }),
      });
    });
    await page.route("**/api/dashboard/summary**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          total_brands: 0,
          total_locations: 0,
          total_channels: 0,
          products_available: 0,
          products_out_of_stock: 0,
          products_not_available: 0,
        }),
      });
    });

    await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/ops-dashboard/, { timeout: 12_000 });

    allowedPages = ["project-manager-dashboard"];
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/project-manager-dashboard/, {
      timeout: 12_000,
    });
  });
});