import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import { setupTimeOffCommonRoutes } from "./helpers/timeOffCommonRoutes";

const CORRECTION_BASE = {
  id: 8801,
  employee_id: 11,
  employee_name: "Test Employee",
  request_type: "missed_clock_out",
  reason: "Forgot to clock out",
  status: "pending",
  is_read: false,
  created_at: new Date().toISOString(),
};

/** Registers routes for the attendance correction notification endpoints. */
async function setupCorrectionRoutes(
  page: Parameters<typeof setupTimeOffCommonRoutes>[0],
  opts: {
    getRequests: () => typeof CORRECTION_BASE[];
  },
) {
  await page.route("**/api/admin/attendance/requests/events**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: "",
    }),
  );

  await page.route("**/api/admin/attendance/requests/seen**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    }),
  );

  await page.route("**/api/admin/attendance/requests**", async (route) => {
    const url = route.request().url();
    if (url.includes("/seen") || url.includes("/events")) {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true, requests: opts.getRequests(), limit: 50, offset: 0 }),
    });
  });
}

test.describe("Correction-request bell badge does not reappear after navigation when already read", () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test.beforeEach(async ({ page }) => {
    await setupClerkTestingToken({ page });
  });

  test("badge stays clear on second page load when server returns is_read=true", async ({
    page,
  }) => {
    const UNREAD = { ...CORRECTION_BASE, is_read: false };
    const READ = { ...CORRECTION_BASE, is_read: true };

    // First page load: correction request is unread → badge shows.
    await setupTimeOffCommonRoutes(page, { getNotifications: () => [] });
    await setupCorrectionRoutes(page, { getRequests: () => [UNREAD] });

    await page.goto("/time-off/my", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Time Off" })).toBeVisible({
      timeout: 15_000,
    });

    const header = page.locator("header");
    const bell = header.getByTestId("notification-bell");
    const badge = header.getByTestId("notification-badge");

    await expect(badge).toBeVisible({ timeout: 10_000 });
    await expect(badge).toHaveText("1");

    // Open the bell → onMarkCorrectionSeen fires → localSeenIds updated + server PATCH.
    await bell.click();
    await expect(badge).not.toBeVisible({ timeout: 5_000 });

    // Navigate to a different page.
    // Re-register routes so that after the page transition the fresh fetch
    // returns is_read=true from the server.
    await setupTimeOffCommonRoutes(page, { getNotifications: () => [] });
    await setupCorrectionRoutes(page, { getRequests: () => [READ] });
    await page.goto("/devices", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Devices" })).toBeVisible({
      timeout: 15_000,
    });

    // Badge must remain absent because effectiveCorrectionSeenIds now includes
    // server-read IDs derived from is_read=true on the fresh fetch.
    await expect(badge).not.toBeVisible({ timeout: 5_000 });
  });
});
