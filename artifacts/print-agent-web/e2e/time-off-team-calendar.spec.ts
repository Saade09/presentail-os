import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import { setupTimeOffCommonRoutes } from "./helpers/timeOffCommonRoutes";

const TEAMMATE_NAME = "Alex Teammate";

test.describe("Team time-off calendar shows teammate's approved time off", () => {
  test.beforeEach(async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupTimeOffCommonRoutes(page);
  });

  test("approved request from a teammate renders as a calendar event", async ({
    page,
  }) => {
    // Use a fixed date that always exists in any month so the test is
    // year/month independent: pick the 15th of the current month.
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1; // 1-12
    const eventDate = `${year}-${String(month).padStart(2, "0")}-15`;
    const eventTitle = `Vacation — ${TEAMMATE_NAME}`;

    await page.route("**/api/time-off/calendar**", async (route) => {
      const url = new URL(route.request().url());
      const qYear = Number(url.searchParams.get("year"));
      const qMonth = Number(url.searchParams.get("month"));
      // Only return the event when the page is asking for the current month
      // we placed the event in. Other months get an empty list.
      const isTargetMonth = qYear === year && qMonth === month;
      const events = isTargetMonth
        ? [
            {
              id: 1,
              type: "request",
              title: eventTitle,
              start_date: eventDate,
              end_date: eventDate,
              status: "APPROVED",
              color: "#10b981",
              member_name: TEAMMATE_NAME,
              member_user_id: "user_teammate",
              member_email: "teammate@example.com",
              is_paid: null,
            },
          ]
        : [];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ events }),
      });
    });

    await page.goto("/time-off/calendar", { waitUntil: "domcontentloaded" });

    await expect(
      page.getByRole("heading", { name: /Team Calendar/i }),
    ).toBeVisible({ timeout: 12_000 });

    // The "X leave events" header chip and the event pill itself both render
    // the teammate's vacation. Assert both visible signals.
    await expect(page.getByText(/1 leave event/i)).toBeVisible({
      timeout: 8_000,
    });
    await expect(page.getByText(eventTitle).first()).toBeVisible({
      timeout: 8_000,
    });

    // The "Events this month" summary list also contains the title and an
    // "approved" badge for the request event.
    await expect(page.getByText(/Events this month/i)).toBeVisible();
    await expect(page.getByText(/^approved$/i).first()).toBeVisible();
  });
});
