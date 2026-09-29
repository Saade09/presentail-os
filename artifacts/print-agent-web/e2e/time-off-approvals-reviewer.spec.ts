import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import { setupTimeOffCommonRoutes } from "./helpers/timeOffCommonRoutes";

const REQUESTER_ID = 2;
const REQUESTER_EMAIL = "requester@example.com";

const REVIEWER_NAME = "Casey Reviewer";
const APPROVED_REQUEST_ID = 9101;
const DECLINED_REQUEST_ID = 9102;

const APPROVED_REVIEWED_AT = "2026-02-15T10:30:00.000Z";
const DECLINED_REVIEWED_AT = "2026-03-22T14:45:00.000Z";

const CURRENT_YEAR = new Date().getFullYear();

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
  reviewed_at: string | null;
  reviewed_by_name: string | null;
}

function makeApprovedRequest(): TeamRequest {
  return {
    id: APPROVED_REQUEST_ID,
    member_id: REQUESTER_ID,
    member_name: REQUESTER_EMAIL,
    member_email: REQUESTER_EMAIL,
    type_id: 1,
    type_code: "VACATION",
    type_name: "Vacation",
    type_color: "#10b981",
    start_date: `${CURRENT_YEAR}-08-04`,
    end_date: `${CURRENT_YEAR}-08-06`,
    total_days: "3.0",
    half_day: false,
    half_day_period: null,
    reason: "Family vacation",
    status: "APPROVED",
    manager_note: null,
    vacation_remaining: 12,
    created_at: new Date(`${CURRENT_YEAR}-07-20T09:00:00Z`).toISOString(),
    reviewed_at: APPROVED_REVIEWED_AT,
    reviewed_by_name: REVIEWER_NAME,
  };
}

function makeDeclinedRequest(): TeamRequest {
  return {
    id: DECLINED_REQUEST_ID,
    member_id: REQUESTER_ID,
    member_name: REQUESTER_EMAIL,
    member_email: REQUESTER_EMAIL,
    type_id: 1,
    type_code: "VACATION",
    type_name: "Vacation",
    type_color: "#10b981",
    start_date: `${CURRENT_YEAR}-09-12`,
    end_date: `${CURRENT_YEAR}-09-13`,
    total_days: "2.0",
    half_day: false,
    half_day_period: null,
    reason: "Personal time",
    status: "DECLINED",
    manager_note: "Conflicts with launch week",
    vacation_remaining: 14,
    created_at: new Date(`${CURRENT_YEAR}-08-25T09:00:00Z`).toISOString(),
    reviewed_at: DECLINED_REVIEWED_AT,
    reviewed_by_name: REVIEWER_NAME,
  };
}

function expectedReviewedDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

test.describe("Reviewer attribution on Team Time-Off Approvals page", () => {
  test.beforeEach(async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupTimeOffCommonRoutes(page, { includeTeamBalances: true });
  });

  test(
    "shows 'Reviewed by <name> on <date>' for APPROVED and DECLINED rows",
    async ({ page }) => {
      const approved = makeApprovedRequest();
      const declined = makeDeclinedRequest();
      const allRequests: TeamRequest[] = [approved, declined];

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
          ? allRequests.filter((r) => r.status === status)
          : allRequests;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ requests: filtered }),
        });
      });

      await page.goto("/time-off/approvals", { waitUntil: "domcontentloaded" });

      await expect(
        page.getByRole("heading", { name: /Team Time-Off Approvals/i }),
      ).toBeVisible({ timeout: 12_000 });

      // --- APPROVED filter ---
      const statusCombo = page
        .getByRole("combobox")
        .filter({ hasText: "Pending" });
      await statusCombo.click();
      await page
        .getByRole("option", { name: "Approved" })
        .click({ timeout: 10_000 });

      const approvedRow = page.getByText(REQUESTER_EMAIL).first();
      await expect(approvedRow).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText("Approved").first()).toBeVisible();

      await approvedRow.click();

      const approvedDate = expectedReviewedDate(APPROVED_REVIEWED_AT);
      await expect(
        page.getByText(
          new RegExp(
            `Reviewed by\\s+${REVIEWER_NAME}\\s+on\\s+${approvedDate.replace(
              /[.*+?^${}()|[\]\\]/g,
              "\\$&",
            )}`,
          ),
        ),
      ).toBeVisible({ timeout: 5_000 });

      // --- DECLINED filter ---
      const statusCombo2 = page
        .getByRole("combobox")
        .filter({ hasText: "Approved" });
      await statusCombo2.click();
      await page
        .getByRole("option", { name: "Declined" })
        .click({ timeout: 10_000 });

      const declinedRow = page.getByText(REQUESTER_EMAIL).first();
      await expect(declinedRow).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText("Declined").first()).toBeVisible();

      await declinedRow.click();

      const declinedDate = expectedReviewedDate(DECLINED_REVIEWED_AT);
      await expect(
        page.getByText(
          new RegExp(
            `Reviewed by\\s+${REVIEWER_NAME}\\s+on\\s+${declinedDate.replace(
              /[.*+?^${}()|[\]\\]/g,
              "\\$&",
            )}`,
          ),
        ),
      ).toBeVisible({ timeout: 5_000 });
    },
  );
});
