import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import { setupTimeOffCommonRoutes } from "./helpers/timeOffCommonRoutes";

const NOTIF_BASE = {
  id: 9901,
  title: "Vacation request submitted",
  body: "employee@example.com submitted a vacation request.",
  is_read: false,
  created_at: new Date().toISOString(),
  actor_name: null,
  actor_email: "employee@example.com",
};

/**
 * Non-actionable: entity_id is null.
 * isActionableTimeOff returns false → included in nonActionableTimeOffIds.
 * Opening the bell auto-marks it read.
 */
const NON_ACTIONABLE_NOTIF = {
  ...NOTIF_BASE,
  type: "TIME_OFF_REQUEST",
  entity_id: null as null,
};

/**
 * Actionable: entity_id is set.
 * isActionableTimeOff returns true → excluded from nonActionableTimeOffIds.
 * Opening the bell does NOT auto-mark it read; the manager must approve/deny.
 */
const ACTIONABLE_NOTIF = {
  ...NOTIF_BASE,
  id: 9902,
  type: "TIME_OFF_REQUEST",
  entity_id: 7701,
};

test.describe("Notification bell badge does not reappear after navigation when already read", () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test.beforeEach(async ({ page }) => {
    await setupClerkTestingToken({ page });
  });

  test("badge stays clear on second page load when server returns is_read=true", async ({
    page,
  }) => {
    const NOTIF_UNREAD = {
      ...NON_ACTIONABLE_NOTIF,
      is_read: false,
    };
    const NOTIF_READ = {
      ...NON_ACTIONABLE_NOTIF,
      is_read: true,
    };

    // First page load: notification is unread → badge shows.
    await setupTimeOffCommonRoutes(page, { getNotifications: () => [NOTIF_UNREAD] });

    await page.goto("/time-off/my", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Time Off" })).toBeVisible({
      timeout: 15_000,
    });

    const header = page.locator("header");
    const bell = header.getByTestId("notification-bell");
    const badge = header.getByTestId("notification-badge");

    await expect(badge).toBeVisible({ timeout: 10_000 });
    await expect(badge).toHaveText("1");

    // Open the bell → auto-marks the non-actionable notification read locally.
    await bell.click();
    await expect(badge).not.toBeVisible({ timeout: 5_000 });

    // Navigate to a different page — this triggers a full route change.
    // Re-register routes so the second page load returns is_read=true from the server.
    await setupTimeOffCommonRoutes(page, { getNotifications: () => [NOTIF_READ] });
    await page.goto("/devices", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Devices" })).toBeVisible({
      timeout: 15_000,
    });

    // Badge must remain absent because effectiveSeenTimeOffIds now includes
    // server-read IDs derived from is_read=true on the fresh fetch.
    await expect(badge).not.toBeVisible({ timeout: 5_000 });
  });
});

test.describe("Notification bell badge clears after SSE-delivered notification is read", () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test.beforeEach(async ({ page }) => {
    await setupClerkTestingToken({ page });
  });

  test("badge auto-clears when the bell is opened for a non-actionable notification", async ({
    page,
  }) => {
    await setupTimeOffCommonRoutes(page, { getNotifications: () => [] });

    // Stage the notifications responses:
    //   fetch 1 → []  (badge = 0 on load)
    //   fetch 2+ → [NON_ACTIONABLE_NOTIF]  (badge = 1 after SSE)
    let fetchCount = 0;
    await page.route("**/api/time-off/notifications**", async (route) => {
      const url = route.request().url();
      if (url.includes("/seen") || url.includes("/events")) {
        await route.continue();
        return;
      }
      fetchCount += 1;
      const notifications = fetchCount >= 2 ? [NON_ACTIONABLE_NOTIF] : [];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ notifications }),
      });
    });

    // Hold SSE until we're ready, then fire "event: changed" to trigger
    // queryClient.invalidateQueries → second fetch → badge = 1.
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
    const bell = header.getByTestId("notification-bell");
    const badge = header.getByTestId("notification-badge");

    // Badge absent before SSE fires.
    await expect(badge).not.toBeVisible();

    // Release SSE → second fetch returns NON_ACTIONABLE_NOTIF → badge = 1.
    fireSseEvent();
    await expect(badge).toBeVisible({ timeout: 10_000 });
    await expect(badge).toHaveText("1");

    // Open the bell.  handleOpenChange calls markTimeOffIds() immediately for
    // non-actionable IDs, adding to localSeenTimeOffIds → unreadCount = 0.
    await bell.click();

    await expect(badge).not.toBeVisible({ timeout: 5_000 });
  });

  test("badge shows 2 for mixed notifications, drops to 1 after bell open, then clears after approve", async ({
    page,
  }) => {
    await setupTimeOffCommonRoutes(page, { getNotifications: () => [] });

    // Notifications mock gated on two flags:
    //   sseHasFired = false → fetch 1 (initial load): return []
    //   sseHasFired = true, approved = false: return both notifications.
    //     This covers the post-SSE refetch (badge=2) AND the extra refetch
    //     triggered by markTimeOffSeenMutation.onSettled after bell open —
    //     the component's localSeenTimeOffIds already holds the non-actionable
    //     id, so the badge stays at 1 even when the raw list still includes it.
    //   approved = true: return [] (badge drops to 0 after PATCH succeeds).
    let sseHasFired = false;
    let approved = false;
    await page.route("**/api/time-off/notifications**", async (route) => {
      const url = route.request().url();
      if (url.includes("/seen") || url.includes("/events")) {
        await route.continue();
        return;
      }
      const notifications =
        sseHasFired && !approved
          ? [NON_ACTIONABLE_NOTIF, ACTIONABLE_NOTIF]
          : [];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ notifications }),
      });
    });

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

    // Mock the review (approve) endpoint; set approved=true before responding
    // so that the invalidateQueries-triggered refetch immediately returns [].
    await page.route(
      `**/api/time-off/requests/${ACTIONABLE_NOTIF.entity_id}/status`,
      async (route) => {
        if (route.request().method() !== "PATCH") {
          await route.continue();
          return;
        }
        approved = true;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
      },
    );

    await page.goto("/time-off/my", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Time Off" })).toBeVisible({
      timeout: 15_000,
    });

    const header = page.locator("header");
    const bell = header.getByTestId("notification-bell");
    const badge = header.getByTestId("notification-badge");

    // Badge absent before SSE fires.
    await expect(badge).not.toBeVisible();

    // Flip sseHasFired then release SSE → next notifications fetch returns both
    // notifications (sseHasFired=true, approved=false) → badge = 2.
    sseHasFired = true;
    fireSseEvent();
    await expect(badge).toBeVisible({ timeout: 10_000 });
    await expect(badge).toHaveText("2");

    // Open the bell.  handleOpenChange auto-marks the non-actionable notification
    // (entity_id = null) via markTimeOffIds().  The actionable one (entity_id set)
    // is excluded from nonActionableTimeOffIds → badge drops from 2 to 1.
    // Note: markTimeOffSeenMutation.onSettled will also invalidate the query and
    // trigger an extra refetch — because approved is still false, the mock returns
    // [NON_ACTIONABLE_NOTIF, ACTIONABLE_NOTIF] again, but localSeenTimeOffIds
    // already holds NON_ACTIONABLE_NOTIF.id, so the badge stays at 1.
    await bell.click();

    const dropdown = page.locator("[data-radix-popper-content-wrapper]");
    await expect(dropdown).toBeVisible({ timeout: 5_000 });
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText("1");

    // Click Approve on the actionable notification → note form appears → Confirm.
    // handleConfirmReview PATCHes /status (sets approved=true), then invalidates
    // time-off notifications.  Next refetch returns [] → badge drops to 0.
    const approveBtn = dropdown.getByTestId(
      `notification-approve-${ACTIONABLE_NOTIF.id}`,
    );
    await expect(approveBtn).toBeVisible();
    await approveBtn.click();

    const confirmBtn = dropdown.getByTestId(
      `notification-confirm-${ACTIONABLE_NOTIF.id}`,
    );
    await expect(confirmBtn).toBeVisible({ timeout: 3_000 });
    await confirmBtn.click();

    // After the PATCH succeeds and the refetch (fetch 3) returns [], badge clears.
    await expect(badge).not.toBeVisible({ timeout: 10_000 });
  });

  test("badge does NOT auto-clear on bell open for actionable requests, but clears after approve", async ({
    page,
  }) => {
    await setupTimeOffCommonRoutes(page, { getNotifications: () => [] });

    // Three-stage notifications mock:
    //   fetch 1 → []                (badge = 0 on load)
    //   fetch 2 → [ACTIONABLE_NOTIF] (badge = 1 after SSE)
    //   fetch 3+ → []               (badge = 0 after approve invalidation)
    let fetchCount = 0;
    await page.route("**/api/time-off/notifications**", async (route) => {
      const url = route.request().url();
      if (url.includes("/seen") || url.includes("/events")) {
        await route.continue();
        return;
      }
      fetchCount += 1;
      const notifications = fetchCount === 2 ? [ACTIONABLE_NOTIF] : [];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ notifications }),
      });
    });

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

    // Mock the review (approve/deny) endpoint.
    await page.route(
      `**/api/time-off/requests/${ACTIONABLE_NOTIF.entity_id}/status`,
      async (route) => {
        if (route.request().method() !== "PATCH") {
          await route.continue();
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
      },
    );

    await page.goto("/time-off/my", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Time Off" })).toBeVisible({
      timeout: 15_000,
    });

    const header = page.locator("header");
    const bell = header.getByTestId("notification-bell");
    const badge = header.getByTestId("notification-badge");

    await expect(badge).not.toBeVisible();

    // Release SSE → fetch 2 returns ACTIONABLE_NOTIF → badge = 1.
    fireSseEvent();
    await expect(badge).toBeVisible({ timeout: 10_000 });
    await expect(badge).toHaveText("1");

    // Open the bell.  Actionable notifications are intentionally excluded from
    // the auto-mark-read path — the badge must still show 1 after the dropdown
    // renders.
    await bell.click();

    const dropdown = page.locator("[data-radix-popper-content-wrapper]");
    await expect(dropdown).toBeVisible({ timeout: 5_000 });
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText("1");

    // Click Approve → inline note form appears → click Confirm.
    // handleConfirmReview POSTs to /status, then invalidates time-off
    // notifications.  Fetch 3 returns [] → badge drops to 0.
    const approveBtn = dropdown.getByTestId(
      `notification-approve-${ACTIONABLE_NOTIF.id}`,
    );
    await expect(approveBtn).toBeVisible();
    await approveBtn.click();

    const confirmBtn = dropdown.getByTestId(
      `notification-confirm-${ACTIONABLE_NOTIF.id}`,
    );
    await expect(confirmBtn).toBeVisible({ timeout: 3_000 });
    await confirmBtn.click();

    // After the PATCH succeeds and the refetch (fetch 3) returns [], badge clears.
    await expect(badge).not.toBeVisible({ timeout: 10_000 });
  });
});
