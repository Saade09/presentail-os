import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import { setupTimeOffCommonRoutes } from "./helpers/timeOffCommonRoutes";

const OWNER_EMAIL = "e2e-tester@presentail.com";
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
  ],
  me: {
    role: "owner",
    email: OWNER_EMAIL,
    allowedPages: null,
    customRoleId: null,
  },
};

const POLICY = {
  id: 42,
  workspace_owner_id: "owner-1",
  name: "Photo Test Policy",
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

const MEMBER_WITH_PHOTO_EMAIL = "alice@example.com";
const MEMBER_WITHOUT_PHOTO_EMAIL = "bob@example.com";
const PHOTO_URL = "https://example.com/avatar/alice.jpg";

const ASSIGNEES = [
  {
    member_id: 10,
    member_email: MEMBER_WITH_PHOTO_EMAIL,
    member_name: "Alice Smith",
    member_user_id: "user_alice",
    member_image_url: PHOTO_URL,
    location_id: null,
    location_name: null,
    manager_member_id: null,
    manager_name: null,
    effective_from: "2025-01-01",
    vacation_remaining: 18,
  },
  {
    member_id: 11,
    member_email: MEMBER_WITHOUT_PHOTO_EMAIL,
    member_name: "Bob Jones",
    member_user_id: "user_bob",
    member_image_url: null,
    location_id: null,
    location_name: null,
    manager_member_id: null,
    manager_name: null,
    effective_from: "2025-01-01",
    vacation_remaining: 15,
  },
];

test.describe("Time-off policy Employees tab — profile photos", () => {
  test.beforeEach(async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupTimeOffCommonRoutes(page, { getUsersResponse: () => USERS_RESPONSE });

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

    await page.route("**/api/time-off/policies/*/assignees", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ assignees: ASSIGNEES }),
      }),
    );
  });

  test(
    "renders a profile photo <img> for a member who has a Clerk image URL",
    async ({ page }) => {
      await page.goto("/admin/time-off/policies", { waitUntil: "domcontentloaded" });

      await expect(
        page.getByRole("heading", { name: /Time-Off Policies/i }),
      ).toBeVisible({ timeout: 12_000 });

      await expect(page.getByText("Photo Test Policy")).toBeVisible({
        timeout: 8_000,
      });

      // The Employees tab is shown by default (defaultValue="employees").
      // Wait for the assignee row to appear.
      await expect(page.getByText(MEMBER_WITH_PHOTO_EMAIL)).toBeVisible({
        timeout: 8_000,
      });

      // An <img> with rounded-full must be present for Alice who has a photo URL.
      const photoImg = page.locator(`img.rounded-full[src="${PHOTO_URL}"]`);
      await expect(photoImg).toBeVisible({ timeout: 5_000 });
    },
  );

  test(
    "renders an initials circle for a member who has no profile photo",
    async ({ page }) => {
      await page.goto("/admin/time-off/policies", { waitUntil: "domcontentloaded" });

      await expect(
        page.getByRole("heading", { name: /Time-Off Policies/i }),
      ).toBeVisible({ timeout: 12_000 });

      await expect(page.getByText("Photo Test Policy")).toBeVisible({
        timeout: 8_000,
      });

      await expect(page.getByText(MEMBER_WITHOUT_PHOTO_EMAIL)).toBeVisible({
        timeout: 8_000,
      });

      // For Bob who has no photo, an initials <div> with rounded-full should
      // be present.  The InitialsAvatar component renders the first letter of
      // the member's name ("B") inside a rounded div.
      const bobRow = page
        .locator("tr")
        .filter({ has: page.getByText(MEMBER_WITHOUT_PHOTO_EMAIL) });

      await expect(bobRow).toBeVisible({ timeout: 5_000 });

      // The initials avatar is a <div> with rounded-full that contains "B".
      const initialsDiv = bobRow.locator("div.rounded-full").filter({
        hasText: "B",
      });
      await expect(initialsDiv).toBeVisible({ timeout: 5_000 });
    },
  );
});
