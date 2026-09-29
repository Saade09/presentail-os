import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import { setupTimeOffCommonRoutes } from "./helpers/timeOffCommonRoutes";

const OWNER_EMAIL = "e2e-tester@presentail.com";
const ASSIGNED_MEMBER_ID = 2;
const ASSIGNED_MEMBER_EMAIL = "assigned-member@example.com";
const ELIGIBLE_MEMBER_ID = 3;
const ELIGIBLE_MEMBER_EMAIL = "eligible-member@example.com";

const now = new Date().toISOString();

const USERS_RESPONSE = {
  members: [
    {
      id: 1,
      email: OWNER_EMAIL,
      role: "owner",
      custom_role_id: null,
      role_name: null,
      joined: true,
      joined_at: now,
      invited_at: now,
      invited_by_email: null,
      manager_member_id: null,
      manager_email: null,
      first_name: null,
      last_name: null,
      image_url: null,
    },
    {
      id: ASSIGNED_MEMBER_ID,
      email: ASSIGNED_MEMBER_EMAIL,
      role: "member",
      custom_role_id: null,
      role_name: null,
      joined: true,
      joined_at: now,
      invited_at: now,
      invited_by_email: null,
      manager_member_id: null,
      manager_email: null,
      first_name: "Assigned",
      last_name: "Member",
      image_url: null,
    },
    {
      id: ELIGIBLE_MEMBER_ID,
      email: ELIGIBLE_MEMBER_EMAIL,
      role: "member",
      custom_role_id: null,
      role_name: null,
      joined: true,
      joined_at: now,
      invited_at: now,
      invited_by_email: null,
      manager_member_id: null,
      manager_email: null,
      first_name: "Eligible",
      last_name: "Member",
      image_url: null,
    },
  ],
  me: {
    role: "owner",
    email: OWNER_EMAIL,
    allowedPages: null,
    customRoleId: null,
  },
};

const POLICY = {
  id: 101,
  workspace_owner_id: "owner-1",
  name: "Standard Full-Time",
  description: null,
  vacation_days_per_year: 20,
  sick_leave_days_per_year: 10,
  accrual_type: "ANNUAL_GRANT",
  annual_grant_month: 1,
  carryover_allowed: false,
  max_carryover_days: null,
  applies_after_months_of_employment: 0,
  is_active: true,
  created_at: now,
  updated_at: now,
};

const ASSIGNEES = [
  {
    member_id: ASSIGNED_MEMBER_ID,
    member_email: ASSIGNED_MEMBER_EMAIL,
    member_name: "Assigned Member",
    member_user_id: "user_assigned",
    location_id: null,
    location_name: null,
    manager_member_id: null,
    manager_name: null,
    effective_from: null,
    vacation_remaining: 20,
  },
];

test.describe("Assign Policy modal — Already assigned badge", () => {
  test.beforeEach(async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupTimeOffCommonRoutes(page, { getUsersResponse: () => USERS_RESPONSE });

    await page.route("**/api/time-off/policies/*/assignees", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ assignees: ASSIGNEES }),
      }),
    );

    await page.route("**/api/time-off/policies", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ policies: [POLICY] }),
        });
        return;
      }
      await route.continue();
    });

    await page.route("**/api/time-off/member-policy-check**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ assigned: false, policyName: null }),
      }),
    );
  });

  test(
    "selecting an eligible member shows checkmark, enables Assign button, and fires POST with correct payload",
    async ({ page }) => {
      let capturedBody: unknown = null;
      await page.route("**/api/time-off/policies/*/assign", async (route) => {
        if (route.request().method() === "POST") {
          capturedBody = JSON.parse(route.request().postData() ?? "{}");
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ ok: true }),
          });
          return;
        }
        await route.continue();
      });

      await page.goto("/admin/time-off/policies", { waitUntil: "domcontentloaded" });

      await expect(
        page.getByRole("heading", { name: /Time-Off Policies/i }),
      ).toBeVisible({ timeout: 12_000 });

      await expect(page.getByText("Standard Full-Time")).toBeVisible({
        timeout: 8_000,
      });

      await page.getByRole("button", { name: /^Assign$/ }).click();
      const assignDialog = page.getByRole("dialog");
      await expect(assignDialog).toBeVisible({ timeout: 5_000 });
      await expect(assignDialog.getByText("Assign Policy")).toBeVisible();

      const scopeCombo = assignDialog.getByRole("combobox");
      await scopeCombo.click();
      await page.getByRole("option", { name: "Specific user" }).click();

      await expect(
        assignDialog.getByText(ELIGIBLE_MEMBER_EMAIL),
      ).toBeVisible({ timeout: 8_000 });

      const assignButton = assignDialog.getByRole("button", { name: /^Assign$/ });
      await expect(assignButton).toBeDisabled();

      const eligibleRow = assignDialog.locator("button").filter({
        has: page.getByText(ELIGIBLE_MEMBER_EMAIL),
      });
      await expect(eligibleRow).toBeVisible();

      await eligibleRow.click();

      await expect(
        eligibleRow.locator("div.rounded-full.bg-primary"),
      ).toBeVisible({ timeout: 3_000 });

      await expect(assignButton).toBeEnabled({ timeout: 3_000 });

      await assignButton.click();

      await expect(async () => {
        expect(capturedBody).toMatchObject({
          scope: "specific_user",
          userId: ELIGIBLE_MEMBER_ID,
        });
      }).toPass({ timeout: 5_000 });
    },
  );

  test(
    "shows Already assigned badge on pre-assigned member, prevents selection, and keeps Assign button disabled",
    async ({ page }) => {
      await page.goto("/admin/time-off/policies", { waitUntil: "domcontentloaded" });

      await expect(
        page.getByRole("heading", { name: /Time-Off Policies/i }),
      ).toBeVisible({ timeout: 12_000 });

      await expect(page.getByText("Standard Full-Time")).toBeVisible({
        timeout: 8_000,
      });

      await page.getByRole("button", { name: /^Assign$/ }).click();
      const assignDialog = page.getByRole("dialog");
      await expect(assignDialog).toBeVisible({ timeout: 5_000 });
      await expect(assignDialog.getByText("Assign Policy")).toBeVisible();

      const scopeCombo = assignDialog.getByRole("combobox");
      await scopeCombo.click();
      await page.getByRole("option", { name: "Specific user" }).click();

      await expect(
        assignDialog.getByText(ASSIGNED_MEMBER_EMAIL),
      ).toBeVisible({ timeout: 8_000 });

      await expect(
        assignDialog.getByText("Already assigned"),
      ).toBeVisible({ timeout: 5_000 });

      const assignedRow = assignDialog.locator("button").filter({
        has: page.getByText(ASSIGNED_MEMBER_EMAIL),
      });
      await expect(assignedRow).toBeVisible();

      await assignedRow.click();

      await expect(
        assignDialog.getByText("Already assigned"),
      ).toBeVisible();
      await expect(
        assignedRow.locator("div.rounded-full.bg-primary"),
      ).toHaveCount(0);

      const assignButton = assignDialog.getByRole("button", { name: /^Assign$/ });
      await expect(assignButton).toBeDisabled();

      await expect(
        assignDialog.getByText(ELIGIBLE_MEMBER_EMAIL),
      ).toBeVisible();

      const eligibleRow = assignDialog.locator("button").filter({
        has: page.getByText(ELIGIBLE_MEMBER_EMAIL),
      });
      await expect(
        eligibleRow.getByText("Already assigned"),
      ).toHaveCount(0);
    },
  );
});
