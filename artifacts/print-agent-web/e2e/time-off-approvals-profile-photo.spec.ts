import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import { setupTimeOffCommonRoutes } from "./helpers/timeOffCommonRoutes";

const CURRENT_YEAR = new Date().getFullYear();

const MEMBER_WITH_PHOTO_ID = 51;
const MEMBER_WITH_PHOTO_NAME = "Alice Photo";
const MEMBER_WITH_PHOTO_EMAIL = "alice.photo@example.com";
const MEMBER_WITH_PHOTO_URL = "https://example.com/alice-avatar.jpg";

const MEMBER_NO_PHOTO_ID = 52;
const MEMBER_NO_PHOTO_NAME = "Bob Initials";
const MEMBER_NO_PHOTO_EMAIL = "bob.initials@example.com";

const REVIEWER_WITH_PHOTO_NAME = "Dana Reviewer";
const REVIEWER_WITH_PHOTO_URL = "https://example.com/dana-reviewer.jpg";

const REVIEWER_NO_PHOTO_NAME = "Sam Manager";

const REVIEWED_AT = "2026-04-10T09:00:00.000Z";

interface TeamRequest {
  id: number;
  member_id: number;
  member_name: string | null;
  member_email: string;
  member_image_url: string | null;
  member_working_days: null;
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
  reviewed_at: string | null;
  reviewed_by_name: string | null;
  reviewed_by_image_url: string | null;
}

function makeRequest(
  id: number,
  memberId: number,
  memberName: string | null,
  memberEmail: string,
  memberImageUrl: string | null,
  status = "PENDING",
  overrides: Partial<TeamRequest> = {},
): TeamRequest {
  return {
    id,
    member_id: memberId,
    member_name: memberName,
    member_email: memberEmail,
    member_image_url: memberImageUrl,
    member_working_days: null,
    type_id: 1,
    type_code: "VACATION",
    type_name: "Vacation",
    type_color: "#10b981",
    start_date: `${CURRENT_YEAR}-09-01`,
    end_date: `${CURRENT_YEAR}-09-03`,
    total_days: "3.0",
    half_day: false,
    half_day_period: null,
    reason: "Holiday",
    status,
    manager_note: null,
    vacation_remaining: 10,
    created_at: new Date().toISOString(),
    reviewed_at: null,
    reviewed_by_name: null,
    reviewed_by_image_url: null,
    ...overrides,
  };
}

test.describe("Profile photo / initials avatar in time-off approvals list", () => {
  test.beforeEach(async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupTimeOffCommonRoutes(page, { includeTeamBalances: true });
  });

  test(
    "renders a profile photo <img> when member_image_url is present",
    async ({ page }) => {
      const requests: TeamRequest[] = [
        makeRequest(
          9201,
          MEMBER_WITH_PHOTO_ID,
          MEMBER_WITH_PHOTO_NAME,
          MEMBER_WITH_PHOTO_EMAIL,
          MEMBER_WITH_PHOTO_URL,
        ),
      ];

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
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ requests }),
        });
      });

      await page.goto("/time-off/approvals", { waitUntil: "domcontentloaded" });

      await expect(
        page.getByRole("heading", { name: /Team Time-Off Approvals/i }),
      ).toBeVisible({ timeout: 12_000 });

      await expect(page.getByText(MEMBER_WITH_PHOTO_NAME).first()).toBeVisible({
        timeout: 10_000,
      });

      const avatar = page.locator(`img.rounded-full[src="${MEMBER_WITH_PHOTO_URL}"]`);
      await expect(avatar).toBeVisible({ timeout: 5_000 });
      await expect(avatar).toHaveAttribute("alt", MEMBER_WITH_PHOTO_NAME);
    },
  );

  test(
    "renders an initials div when member_image_url is null",
    async ({ page }) => {
      const requests: TeamRequest[] = [
        makeRequest(
          9202,
          MEMBER_NO_PHOTO_ID,
          MEMBER_NO_PHOTO_NAME,
          MEMBER_NO_PHOTO_EMAIL,
          null,
        ),
      ];

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
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ requests }),
        });
      });

      await page.goto("/time-off/approvals", { waitUntil: "domcontentloaded" });

      await expect(
        page.getByRole("heading", { name: /Team Time-Off Approvals/i }),
      ).toBeVisible({ timeout: 12_000 });

      await expect(page.getByText(MEMBER_NO_PHOTO_NAME).first()).toBeVisible({
        timeout: 10_000,
      });

      const initialsDiv = page.locator("div.rounded-full.bg-muted").filter({
        hasText: MEMBER_NO_PHOTO_NAME[0].toUpperCase(),
      });
      await expect(initialsDiv).toBeVisible({ timeout: 5_000 });

      const photoImg = page.locator("img.rounded-full");
      await expect(photoImg).toHaveCount(0);
    },
  );
});

test.describe("Reviewer avatar in expanded time-off request details", () => {
  test.beforeEach(async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupTimeOffCommonRoutes(page, { includeTeamBalances: true });
  });

  test(
    "shows reviewer photo <img> in expanded approved row when reviewed_by_image_url is present",
    async ({ page }) => {
      const requests: TeamRequest[] = [
        makeRequest(
          9301,
          MEMBER_WITH_PHOTO_ID,
          MEMBER_WITH_PHOTO_NAME,
          MEMBER_WITH_PHOTO_EMAIL,
          null,
          "APPROVED",
          {
            reviewed_at: REVIEWED_AT,
            reviewed_by_name: REVIEWER_WITH_PHOTO_NAME,
            reviewed_by_image_url: REVIEWER_WITH_PHOTO_URL,
          },
        ),
      ];

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
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ requests }),
        });
      });

      await page.goto("/time-off/approvals", { waitUntil: "domcontentloaded" });

      await expect(
        page.getByRole("heading", { name: /Team Time-Off Approvals/i }),
      ).toBeVisible({ timeout: 12_000 });

      const statusCombo = page.getByRole("combobox").filter({ hasText: "Pending" });
      await statusCombo.click();
      await page.getByRole("option", { name: "Approved" }).click({ timeout: 10_000 });

      await expect(page.getByText(MEMBER_WITH_PHOTO_NAME).first()).toBeVisible({
        timeout: 10_000,
      });

      await page.getByText(MEMBER_WITH_PHOTO_NAME).first().click();

      const reviewerImg = page.locator(`img[data-testid="reviewer-avatar-img"][src="${REVIEWER_WITH_PHOTO_URL}"]`);
      await expect(reviewerImg).toBeVisible({ timeout: 5_000 });
      await expect(reviewerImg).toHaveAttribute("alt", REVIEWER_WITH_PHOTO_NAME);

      await expect(
        page.getByText(new RegExp(`Reviewed by\\s+${REVIEWER_WITH_PHOTO_NAME}`)),
      ).toBeVisible({ timeout: 5_000 });
    },
  );

  test(
    "shows reviewer initials div in expanded declined row when reviewed_by_image_url is null",
    async ({ page }) => {

      const requests: TeamRequest[] = [
        makeRequest(
          9302,
          MEMBER_NO_PHOTO_ID,
          MEMBER_NO_PHOTO_NAME,
          MEMBER_NO_PHOTO_EMAIL,
          null,
          "DECLINED",
          {
            reviewed_at: REVIEWED_AT,
            reviewed_by_name: REVIEWER_NO_PHOTO_NAME,
            reviewed_by_image_url: null,
          },
        ),
      ];

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
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ requests }),
        });
      });

      await page.goto("/time-off/approvals", { waitUntil: "domcontentloaded" });

      await expect(
        page.getByRole("heading", { name: /Team Time-Off Approvals/i }),
      ).toBeVisible({ timeout: 12_000 });

      const statusCombo = page.getByRole("combobox").filter({ hasText: "Pending" });
      await statusCombo.click();
      await page.getByRole("option", { name: "Declined" }).click({ timeout: 10_000 });

      await expect(page.getByText(MEMBER_NO_PHOTO_NAME).first()).toBeVisible({
        timeout: 10_000,
      });

      await page.getByText(MEMBER_NO_PHOTO_NAME).first().click();

      const reviewerInitials = page.locator('[data-testid="reviewer-avatar-initials"]');
      await expect(reviewerInitials).toBeVisible({ timeout: 5_000 });
      await expect(reviewerInitials).toHaveText(REVIEWER_NO_PHOTO_NAME[0].toUpperCase());

      const reviewerImg = page.locator('[data-testid="reviewer-avatar-img"]');
      await expect(reviewerImg).toHaveCount(0);

      await expect(
        page.getByText(new RegExp(`Reviewed by\\s+${REVIEWER_NO_PHOTO_NAME}`)),
      ).toBeVisible({ timeout: 5_000 });
    },
  );
});
