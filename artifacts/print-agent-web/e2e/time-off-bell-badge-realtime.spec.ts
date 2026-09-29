import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import { setupTimeOffCommonRoutes } from "./helpers/timeOffCommonRoutes";

const NOTIF_ID = 8801;
const REQUESTER_EMAIL = "employee@example.com";
const CURRENT_YEAR = new Date().getFullYear();

const TIME_OFF_NOTIF = {
  id: NOTIF_ID,
  type: "TIME_OFF_REQUEST",
  title: "New Vacation request",
  body: `${REQUESTER_EMAIL} requested vacation from ${CURRENT_YEAR}-08-01 to ${CURRENT_YEAR}-08-05.`,
  entity_id: 6601,
  is_read: false,
  created_at: new Date().toISOString(),
  actor_name: null,
  actor_email: REQUESTER_EMAIL,
};

test.describe("Notification bell badge increments in real-time via SSE", () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test.beforeEach(async ({ page }) => {
    await setupClerkTestingToken({ page });
  });

  test("bell badge increments from 0 to 1 when SSE fires a changed event", async ({
    page,
  }) => {
    // Register common routes first. These become the "base" layer.
    await setupTimeOffCommonRoutes(page, {
      getNotifications: () => [],
    });

    // Override the notifications route (LIFO: wins over the common handler).
    // First fetch returns [] so the badge starts at 0.
    // After SSE-triggered invalidation the second fetch returns the fixture.
    let fetchCount = 0;
    await page.route("**/api/time-off/notifications**", async (route) => {
      const url = route.request().url();
      if (url.includes("/seen") || url.includes("/events")) {
        await route.continue();
        return;
      }
      fetchCount += 1;
      const notifications = fetchCount >= 2 ? [TIME_OFF_NOTIF] : [];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ notifications }),
      });
    });

    // Hold the SSE connection open until we explicitly release it (LIFO: wins
    // over the common handler's empty-body SSE mock).  This lets us assert the
    // badge is hidden *before* the "changed" event fires.
    let fireSseEvent!: () => void;
    const sseReady = new Promise<void>((resolve) => {
      fireSseEvent = resolve;
    });

    await page.route("**/api/time-off/notifications/events**", async (route) => {
      await sseReady;
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: { "Cache-Control": "no-cache", Connection: "keep-alive" },
        body: "event: changed\ndata: {}\n\n",
      });
    });

    await page.goto("/time-off/my", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Time Off" })).toBeVisible({
      timeout: 15_000,
    });

    const header = page.locator("header");
    const badge = header.getByTestId("notification-badge");

    // Verify the badge is absent before the SSE event fires.
    await expect(badge).not.toBeVisible();

    // Release the SSE stream — EventSource receives "event: changed" and the
    // hook calls queryClient.invalidateQueries, triggering a second fetch that
    // returns TIME_OFF_NOTIF.
    fireSseEvent();

    // The badge should now appear with count 1 — no navigation required.
    await expect(badge).toBeVisible({ timeout: 10_000 });
    await expect(badge).toHaveText("1");
  });
});
