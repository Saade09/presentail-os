import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import { setupTimeOffCommonRoutes } from "./helpers/timeOffCommonRoutes";

const REQUEST_ID = 5501;
const NOTIF_ID = 7701;
const REQUESTER_EMAIL = "teammate@example.com";
const CURRENT_YEAR = new Date().getFullYear();

const TIME_OFF_NOTIF = {
  id: NOTIF_ID,
  type: "TIME_OFF_REQUEST",
  title: "New Vacation request",
  body: `${REQUESTER_EMAIL} requested vacation from ${CURRENT_YEAR}-07-10 to ${CURRENT_YEAR}-07-12.`,
  entity_id: REQUEST_ID,
  is_read: false,
  created_at: new Date(Date.now() - 2 * 60_000).toISOString(),
  actor_email: REQUESTER_EMAIL,
};

const PENDING_TEAM_REQUEST = {
  id: REQUEST_ID,
  member_id: 2,
  member_name: REQUESTER_EMAIL,
  member_email: REQUESTER_EMAIL,
  type_id: 1,
  type_code: "VACATION",
  type_name: "Vacation",
  type_color: "#10b981",
  start_date: `${CURRENT_YEAR}-07-10`,
  end_date: `${CURRENT_YEAR}-07-12`,
  total_days: "3.0",
  half_day: false,
  half_day_period: null,
  reason: "Family trip",
  status: "PENDING",
  manager_note: null,
  vacation_remaining: 15,
  created_at: new Date().toISOString(),
};

async function setupTeamRoute(
  page: import("@playwright/test").Page,
  teamRequests: typeof PENDING_TEAM_REQUEST[],
) {
  await page.route("**/api/time-off/team**", async (route) => {
    const url = route.request().url();
    if (url.includes("/team/balances")) {
      await route.continue();
      return;
    }
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    const status = new URL(url).searchParams.get("status");
    const filtered = status
      ? teamRequests.filter((r) => r.status === status)
      : teamRequests;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ requests: filtered }),
    });
  });
}

test.describe("Manager notification bell clears after acting on the approvals page", () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test.beforeEach(async ({ page }) => {
    await setupClerkTestingToken({ page });
  });

  test("bell badge disappears after approving a request from the Team Time Off page", async ({
    page,
  }) => {
    const notifications = { current: [{ ...TIME_OFF_NOTIF }] };
    const teamRequests = [{ ...PENDING_TEAM_REQUEST }];

    await setupTimeOffCommonRoutes(page, {
      getNotifications: () => notifications.current,
      includeTeamBalances: true,
    });
    await setupTeamRoute(page, teamRequests);

    await page.route("**/api/time-off/requests/*/approve", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      const match = route.request().url().match(/\/requests\/(\d+)\/approve/);
      const id = match ? Number(match[1]) : null;
      const target = teamRequests.find((r) => r.id === id);
      if (target) target.status = "APPROVED";
      notifications.current = [];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    await page.goto("/time-off/approvals", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: /Team Time-Off Approvals/i }),
    ).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText(REQUESTER_EMAIL).first()).toBeVisible({
      timeout: 10_000,
    });

    const header = page.locator("header");
    const badge = header.getByTestId("notification-badge");
    await expect(badge).toBeVisible({ timeout: 10_000 });
    await expect(badge).toHaveText("1");

    await page.getByRole("button", { name: /^Approve$/ }).click();
    await expect(
      page.getByText(/no pending requests/i).first(),
    ).toBeVisible({ timeout: 10_000 });

    await expect(header.getByTestId("notification-badge")).toHaveCount(0, {
      timeout: 10_000,
    });
  });

  test("bell badge disappears after declining a request from the Team Time Off page", async ({
    page,
  }) => {
    const notifications = { current: [{ ...TIME_OFF_NOTIF }] };
    const teamRequests = [{ ...PENDING_TEAM_REQUEST }];

    await setupTimeOffCommonRoutes(page, {
      getNotifications: () => notifications.current,
      includeTeamBalances: true,
    });
    await setupTeamRoute(page, teamRequests);

    await page.route("**/api/time-off/requests/*/decline", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      const match = route.request().url().match(/\/requests\/(\d+)\/decline/);
      const id = match ? Number(match[1]) : null;
      const target = teamRequests.find((r) => r.id === id);
      if (target) {
        target.status = "DECLINED";
      }
      notifications.current = [];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    await page.goto("/time-off/approvals", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", { name: /Team Time-Off Approvals/i }),
    ).toBeVisible({ timeout: 12_000 });
    await expect(page.getByText(REQUESTER_EMAIL).first()).toBeVisible({
      timeout: 10_000,
    });

    const header = page.locator("header");
    const badge = header.getByTestId("notification-badge");
    await expect(badge).toBeVisible({ timeout: 10_000 });
    await expect(badge).toHaveText("1");

    await page.getByRole("button", { name: /^Decline$/ }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await dialog.locator("#manager-note").fill("Conflicts with sprint launch");
    await dialog.getByRole("button", { name: /Confirm Decline/i }).click();

    await expect(dialog).not.toBeVisible({ timeout: 8_000 });
    await expect(
      page.getByText(/no pending requests/i).first(),
    ).toBeVisible({ timeout: 10_000 });

    await expect(header.getByTestId("notification-badge")).toHaveCount(0, {
      timeout: 10_000,
    });
  });
});
