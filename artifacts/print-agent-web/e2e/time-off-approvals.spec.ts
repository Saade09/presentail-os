import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import { setupTimeOffCommonRoutes } from "./helpers/timeOffCommonRoutes";

const TEAMMATE_ID = 2;
const TEAMMATE_EMAIL = "teammate@example.com";
const REQUEST_ID = 901;
const CURRENT_YEAR = new Date().getFullYear();

const INITIAL_ENTITLED = 20;
const INITIAL_CARRYOVER = 0;
const INITIAL_USED = 2;
const INITIAL_PENDING = 3;
const INITIAL_REMAINING =
  INITIAL_ENTITLED + INITIAL_CARRYOVER - INITIAL_USED - INITIAL_PENDING;
const REQUEST_DAYS = 3;

interface TeamRequest {
  id: number;
  member_id: number;
  member_name: string;
  member_email: string;
  type_id: number;
  type_code: string;
  type_name: string;
  type_color: string;
  start_date: string;
  end_date: string;
  total_days: string;
  half_day: boolean;
  half_day_period: string | null;
  reason: string | null;
  status: string;
  manager_note: string | null;
  vacation_remaining: number | null;
  created_at: string;
}

function makePendingRequest(overrides: Partial<TeamRequest> = {}): TeamRequest {
  return {
    id: REQUEST_ID,
    member_id: TEAMMATE_ID,
    member_name: TEAMMATE_EMAIL,
    member_email: TEAMMATE_EMAIL,
    type_id: 1,
    type_code: "VACATION",
    type_name: "Vacation",
    type_color: "#10b981",
    start_date: `${CURRENT_YEAR}-07-10`,
    end_date: `${CURRENT_YEAR}-07-12`,
    total_days: String(REQUEST_DAYS) + ".0",
    half_day: false,
    half_day_period: null,
    reason: "Family trip",
    status: "PENDING",
    manager_note: null,
    vacation_remaining: INITIAL_REMAINING,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

interface MockBalance {
  vacation_entitled: number;
  vacation_carryover: number;
  vacation_used: number;
  vacation_pending: number;
}

function balanceRemaining(b: MockBalance) {
  return (
    b.vacation_entitled + b.vacation_carryover - b.vacation_used - b.vacation_pending
  );
}

test.describe("Manager time-off approvals flow", () => {
  test.beforeEach(async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupTimeOffCommonRoutes(page, { includeTeamBalances: true });
  });

  test(
    "manager approves a pending request: chip flips to Approved and bookkeeping updates",
    async ({ page }) => {
      const requests: TeamRequest[] = [makePendingRequest()];
      const balance: MockBalance = {
        vacation_entitled: INITIAL_ENTITLED,
        vacation_carryover: INITIAL_CARRYOVER,
        vacation_used: INITIAL_USED,
        vacation_pending: INITIAL_PENDING,
      };

      let approvePostId: number | null = null;

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
        const parsed = new URL(url);
        const status = parsed.searchParams.get("status");
        const filtered = status
          ? requests.filter((r) => r.status === status)
          : requests;
        const withRemaining = filtered.map((r) => ({
          ...r,
          vacation_remaining:
            r.type_code === "VACATION" ? balanceRemaining(balance) : r.vacation_remaining,
        }));
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ requests: withRemaining }),
        });
      });

      await page.route(
        "**/api/time-off/requests/*/approve",
        async (route) => {
          if (route.request().method() !== "POST") {
            await route.continue();
            return;
          }
          const match = route
            .request()
            .url()
            .match(/\/api\/time-off\/requests\/(\d+)\/approve/);
          approvePostId = match ? Number(match[1]) : null;

          const target = requests.find((r) => r.id === approvePostId);
          if (target && target.status === "PENDING") {
            const days = Number(target.total_days);
            target.status = "APPROVED";
            balance.vacation_pending = Math.max(
              0,
              balance.vacation_pending - days,
            );
            balance.vacation_used += days;
          }

          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ ok: true }),
          });
        },
      );

      await page.goto("/time-off/approvals", { waitUntil: "domcontentloaded" });

      await expect(
        page.getByRole("heading", { name: /Team Time-Off Approvals/i }),
      ).toBeVisible({ timeout: 12_000 });

      await expect(page.getByText(TEAMMATE_EMAIL).first()).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByText("Pending").first()).toBeVisible();

      await page.getByRole("button", { name: /^Approve$/ }).click();

      await expect.poll(() => approvePostId).toBe(REQUEST_ID);

      expect(balance.vacation_pending).toBe(INITIAL_PENDING - REQUEST_DAYS);
      expect(balance.vacation_used).toBe(INITIAL_USED + REQUEST_DAYS);
      expect(balanceRemaining(balance)).toBe(INITIAL_REMAINING);

      await expect(
        page.getByText(/no pending requests/i).first(),
      ).toBeVisible({ timeout: 10_000 });
      await expect(page.getByRole("button", { name: /^Approve$/ })).toHaveCount(0);

      const statusCombo = page
        .getByRole("combobox")
        .filter({ hasText: "Pending" });
      await statusCombo.click();
      await page
        .getByRole("option", { name: "Approved" })
        .click({ timeout: 10_000 });

      await expect(page.getByText(TEAMMATE_EMAIL).first()).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByText("Approved").first()).toBeVisible();
      await expect(page.getByRole("button", { name: /^Approve$/ })).toHaveCount(0);
    },
  );

  test(
    "manager declines a pending request with a note: chip flips to Declined and remaining balance is re-released",
    async ({ page }) => {
      const requests: TeamRequest[] = [makePendingRequest()];
      const balance: MockBalance = {
        vacation_entitled: INITIAL_ENTITLED,
        vacation_carryover: INITIAL_CARRYOVER,
        vacation_used: INITIAL_USED,
        vacation_pending: INITIAL_PENDING,
      };

      let declinePostBody: Record<string, unknown> | null = null;
      let declinePostId: number | null = null;

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
        const parsed = new URL(url);
        const status = parsed.searchParams.get("status");
        const filtered = status
          ? requests.filter((r) => r.status === status)
          : requests;
        const withRemaining = filtered.map((r) => ({
          ...r,
          vacation_remaining:
            r.type_code === "VACATION" ? balanceRemaining(balance) : r.vacation_remaining,
        }));
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ requests: withRemaining }),
        });
      });

      await page.route(
        "**/api/time-off/requests/*/decline",
        async (route) => {
          if (route.request().method() !== "POST") {
            await route.continue();
            return;
          }
          const match = route
            .request()
            .url()
            .match(/\/api\/time-off\/requests\/(\d+)\/decline/);
          declinePostId = match ? Number(match[1]) : null;
          declinePostBody = JSON.parse(route.request().postData() ?? "{}");

          const target = requests.find((r) => r.id === declinePostId);
          if (target && target.status === "PENDING") {
            const days = Number(target.total_days);
            target.status = "DECLINED";
            target.manager_note =
              (declinePostBody?.managerNote as string | null) ?? null;
            balance.vacation_pending = Math.max(
              0,
              balance.vacation_pending - days,
            );
          }

          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ ok: true }),
          });
        },
      );

      await page.goto("/time-off/approvals", { waitUntil: "domcontentloaded" });

      await expect(
        page.getByRole("heading", { name: /Team Time-Off Approvals/i }),
      ).toBeVisible({ timeout: 12_000 });
      await expect(page.getByText(TEAMMATE_EMAIL).first()).toBeVisible({
        timeout: 10_000,
      });

      await page.getByRole("button", { name: /^Decline$/ }).click();

      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible({ timeout: 5_000 });
      await expect(dialog.getByText(/Decline Time-Off Request/i)).toBeVisible();
      await expect(dialog.getByText(TEAMMATE_EMAIL)).toBeVisible();

      await dialog.locator("#manager-note").fill("Conflicts with sprint launch");
      await dialog.getByRole("button", { name: /Confirm Decline/i }).click();

      await expect.poll(() => declinePostId).toBe(REQUEST_ID);
      expect(declinePostBody).toMatchObject({
        managerNote: "Conflicts with sprint launch",
      });

      expect(balance.vacation_pending).toBe(INITIAL_PENDING - REQUEST_DAYS);
      expect(balance.vacation_used).toBe(INITIAL_USED);
      expect(balanceRemaining(balance)).toBe(INITIAL_REMAINING + REQUEST_DAYS);

      await expect(dialog).not.toBeVisible({ timeout: 8_000 });

      await expect(
        page.getByText(/no pending requests/i).first(),
      ).toBeVisible({ timeout: 10_000 });

      const statusCombo = page
        .getByRole("combobox")
        .filter({ hasText: "Pending" });
      await statusCombo.click();
      await page
        .getByRole("option", { name: "Declined" })
        .click({ timeout: 10_000 });

      await expect(page.getByText(TEAMMATE_EMAIL).first()).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByText("Declined").first()).toBeVisible();

      await page.getByText(TEAMMATE_EMAIL).first().click();
      const expectedRemaining =
        (INITIAL_REMAINING + REQUEST_DAYS).toFixed(1) + " vacation days";
      await expect(
        page.getByText(new RegExp(`Balance remaining:\\s*${expectedRemaining}`)),
      ).toBeVisible({ timeout: 5_000 });
    },
  );
});
