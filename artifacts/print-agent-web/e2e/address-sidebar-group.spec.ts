import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import type { Page } from "@playwright/test";

const OWNER_EMAIL = "e2e-tester@presentail.com";

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
        invited_at: null,
        invited_by_email: null,
        manager_member_id: null,
        manager_email: null,
      },
    ],
    me: { role: "owner", email: OWNER_EMAIL, allowedPages: null, customRoleId: null },
  };
}

async function setupRoutes(page: Page) {
  const json = (body: unknown) => ({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

  await page.route("**/api/users/failed-access-requests**", (route) =>
    route.fulfill(json({ failedRequests: [] })),
  );
  await page.route("**/api/users**", (route) =>
    route.fulfill(json(ownerUsersResponse())),
  );
  await page.route("**/api/roles**", (route) =>
    route.fulfill(json({ roles: [] })),
  );
  await page.route("**/api/access-requests**", (route) =>
    route.fulfill(json({ requests: [] })),
  );
  await page.route(/\/api\/address-book\/places(?:\?.*)?$/, (route) =>
    route.fulfill(json({
      success: true,
      places: [],
      total: 0,
      summary: {
        verified_count: 0,
        needs_review_count: 0,
        linked_deliveries_count: 0,
        possible_duplicates_count: 0,
        missing_coordinates_count: 0,
      },
    })),
  );
  await page.route("**/api/address-book/areas", (route) =>
    route.fulfill(json({ success: true, areas: [] })),
  );
  await page.route(/\/api\/address-collector(?:\?.*)?$/, (route) =>
    route.fulfill(json({
      kpis: {
        total: 0,
        scheduled: 0,
        waiting: 0,
        received: 0,
        attention: 0,
        collectedAutomatically: 0,
      },
      requests: [],
      total: 0,
    })),
  );
}

test.describe("Addresses sidebar group", () => {
  test("uses a parent destination and independent chevron while preserving address-route history", async ({
    page,
  }) => {
    await setupClerkTestingToken({ page });
    await setupRoutes(page);

    await page.goto("/address-collector", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Address Collector" })).toBeVisible({
      timeout: 15_000,
    });

    const sidebar = page.getByTestId("dashboard-sidebar");
    const groupToggle = sidebar.getByTestId("nav-orders-delivery");
    const collectorLink = sidebar.getByTestId("nav-address-collector");

    await expect(groupToggle).toHaveAttribute("aria-expanded", "true");
    await expect(collectorLink).toHaveAttribute("aria-current", "page");

    await sidebar.getByTestId("nav-address-book").click();
    await expect(page).toHaveURL(/\/address-book$/);
    await expect(page.getByRole("heading", { name: "Address Book" })).toBeVisible();
    await expect(sidebar.getByTestId("nav-address-book")).toHaveAttribute("aria-current", "page");

    await page.goBack();
    await expect(page).toHaveURL(/\/address-collector$/);
    await expect(groupToggle).toHaveAttribute("aria-expanded", "true");
    await expect(sidebar.getByTestId("nav-address-collector")).toHaveAttribute("aria-current", "page");

    await groupToggle.click();
    await expect(page).toHaveURL(/\/address-collector$/);
    await expect(groupToggle).toHaveAttribute("aria-expanded", "false");
    await expect(sidebar.getByTestId("nav-address-book")).toHaveCount(0);
    await expect(sidebar.getByTestId("nav-address-collector")).toHaveCount(0);
  });
});