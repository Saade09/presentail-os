import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";

const OWNER_EMAIL = "e2e-tester@presentail.com";
const LOCATION_ID = 601;
const LOCATION_NAME = "Gemmayzeh Hub";

function makeLocation(overrides: Record<string, unknown> = {}) {
  return {
    id: LOCATION_ID,
    name: LOCATION_NAME,
    country: "Lebanon",
    location_type: "Point of Sale",
    status: "setup_incomplete",
    annual_rent: null,
    rent_currency: null,
    payments_per_year: null,
    daily_capacity: 30,
    address: null,
    created_at: new Date().toISOString(),
    device_count: 1,
    devices_online: 1,
    devices_offline: 0,
    job_count: 0,
    page_sum: 0,
    brands_count: 2,
    products_count: 5,
    orders_today: 0,
    pending_prep: 0,
    has_operating_hours: true,
    has_routing: true,
    has_capacity: true,
    ...overrides,
  };
}

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
        image_url: null,
        invite_token: null,
        assigned_locations: [],
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

async function setupCommonRoutes(page: import("@playwright/test").Page) {
  await page.route("**/api/users/failed-access-requests**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ failedRequests: [] }),
    }),
  );

  await page.route("**/api/users**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(ownerUsersResponse()),
    });
  });

  await page.route("**/api/access-requests**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ requests: [] }),
    }),
  );

  await page.route("**/api/notifications/seen**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    }),
  );

  await page.route("**/api/time-off/notifications/events**", (route) =>
    route.fulfill({ status: 200, contentType: "text/event-stream", body: "" }),
  );

  await page.route("**/api/time-off/notifications/seen**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    }),
  );

  await page.route("**/api/time-off/notifications**", async (route) => {
    const url = route.request().url();
    if (url.includes("/seen") || url.includes("/events")) {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ notifications: [] }),
    });
  });
}

test.describe("Location activation flow", () => {
  test(
    "shows 'All steps complete' bar and 'Activate location' button when all 6 setup flags are satisfied, then transitions to active",
    async ({ page }) => {
      await setupClerkTestingToken({ page });
      await setupCommonRoutes(page);

      let currentStatus: "setup_incomplete" | "active" = "setup_incomplete";

      await page.route("**/api/locations**", async (route) => {
        const url = route.request().url();
        const method = route.request().method();

        // POST .../resume — activate the location
        if (method === "POST" && url.includes(`/locations/${LOCATION_ID}/resume`)) {
          currentStatus = "active";
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ ok: true }),
          });
          return;
        }

        // GET /api/locations (the list)
        if (method === "GET" && !url.match(/\/locations\/\d+\//)) {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              locations: [makeLocation({ status: currentStatus })],
            }),
          });
          return;
        }

        await route.continue();
      });

      await page.goto("/locations", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Locations" })).toBeVisible({ timeout: 15_000 });

      // The location card should be visible
      const locationCard = page.getByTestId(`location-card-${LOCATION_ID}`);
      await expect(locationCard).toBeVisible({ timeout: 15_000 });

      // Status pill should read "Setup incomplete"
      await expect(locationCard).toContainText("Setup incomplete");

      // "All steps complete" bar and message should be visible (all 6 flags are true)
      await expect(locationCard).toContainText("All steps complete");
      await expect(locationCard).toContainText(
        "This location is ready to go live",
      );

      // "Activate location" button should be present and enabled
      const activateBtn = page.getByTestId("button-activate-location");
      await expect(activateBtn).toBeVisible({ timeout: 5_000 });
      await expect(activateBtn).toBeEnabled();

      // Click to activate
      await activateBtn.click();

      // Success toast should appear
      await expect(page.getByText("Location activated").first()).toBeVisible({
        timeout: 8_000,
      });

      // After the query refetches, the card should now show "Active" status
      await expect(locationCard).toContainText("Active", { timeout: 8_000 });

      // The setup incomplete section should be gone
      await expect(locationCard).not.toContainText("All steps complete");
      await expect(activateBtn).not.toBeVisible({ timeout: 5_000 });
    },
  );

  test(
    "does not show 'Activate location' button when setup steps are still incomplete",
    async ({ page }) => {
      await setupClerkTestingToken({ page });
      await setupCommonRoutes(page);

      // Location with only 3 of 6 flags satisfied
      const incompleteLocation = makeLocation({
        device_count: 0,
        brands_count: 0,
        has_operating_hours: false,
      });

      await page.route("**/api/locations**", async (route) => {
        const url = route.request().url();
        const method = route.request().method();
        if (method === "GET" && !url.match(/\/locations\/\d+\//)) {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ locations: [incompleteLocation] }),
          });
          return;
        }
        await route.continue();
      });

      await page.goto("/locations", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Locations" })).toBeVisible({ timeout: 15_000 });

      const locationCard = page.getByTestId(`location-card-${LOCATION_ID}`);
      await expect(locationCard).toBeVisible({ timeout: 15_000 });

      // Should show the incomplete progress bar, not the "all done" state
      await expect(locationCard).toContainText("Setup incomplete");
      await expect(locationCard).toContainText("Setup progress");
      await expect(locationCard).toContainText("Missing items");

      // "Activate location" button must not appear
      await expect(page.getByTestId("button-activate-location")).not.toBeVisible();
    },
  );
});
