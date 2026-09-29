import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import type { Page } from "@playwright/test";

const OWNER_EMAIL = "e2e-tester@presentail.com";
const PERSON_ID = "person-sched-42";

const MOCK_PERSON = {
  id: PERSON_ID,
  source: "team_member" as const,
  first_name: "Jane",
  last_name: "Doe",
  email: "jane.doe@example.com",
  phone: null,
  job_title: "Engineer",
  department_name: null,
  image_url: null,
  access_type: "team_member_only" as const,
  role: null,
  role_name: null,
  custom_role_id: null,
  joined: false,
  joined_at: null,
  invited_at: null,
  member_id: null,
  team_member_id: 42,
  employment_status: "full_time",
  archived_at: null,
  person_id: 42,
  profile_id: 42,
  employee_code: null,
  start_date: null,
  birthday: null,
  emergency_contact_name: null,
  emergency_contact_phone: null,
  emergency_contact_relationship: null,
  notes: null,
  manager_id: null,
  manager_name: null,
  work_schedule_id: 7,
  work_schedule_name: "Standard 9-5",
  department_id: null,
  work_schedule_days: [
    { day_of_week: "monday", is_working_day: true, start_time: "09:00:00", end_time: "17:00:00" },
    { day_of_week: "tuesday", is_working_day: true, start_time: "09:00:00", end_time: "17:00:00" },
    { day_of_week: "wednesday", is_working_day: true, start_time: "09:00:00", end_time: "17:00:00" },
    { day_of_week: "thursday", is_working_day: true, start_time: "09:00:00", end_time: "17:00:00" },
    { day_of_week: "friday", is_working_day: true, start_time: "09:00:00", end_time: "17:00:00" },
    { day_of_week: "saturday", is_working_day: false, start_time: null, end_time: null },
    { day_of_week: "sunday", is_working_day: false, start_time: null, end_time: null },
  ],
  employment_type: null,
  attendance_enabled: null,
  profile_status: null,
};

function ownerUsersResponse() {
  return {
    members: [
      {
        id: 1,
        email: OWNER_EMAIL,
        role: "owner",
        custom_role_id: null,
        role_name: null,
        joined: true,
        joined_at: new Date().toISOString(),
        invited_at: new Date().toISOString(),
        invited_by_email: null,
        manager_member_id: null,
        manager_email: null,
      },
    ],
    me: {
      role: "owner",
      email: OWNER_EMAIL,
      allowedPages: null,
      customRoleId: null,
    },
  };
}

async function setupPersonProfileRoutes(page: Page) {
  await setupClerkTestingToken({ page });

  await page.route("**/api/users/failed-access-requests**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ failedRequests: [] }),
    }),
  );

  await page.route("**/api/users**", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(ownerUsersResponse()),
      });
      return;
    }
    await route.continue();
  });

  await page.route("**/api/access-requests**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ requests: [] }),
    }),
  );

  await page.route("**/api/notifications/seen**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    }),
  );

  await page.route("**/api/time-off/notifications/events**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: "",
    }),
  );

  await page.route("**/api/time-off/notifications/seen**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    }),
  );

  await page.route("**/api/time-off/notifications**", async (route) => {
    const url = route.request().url();
    if (url.includes("/seen") || url.includes("/events")) {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ notifications: [] }),
    });
  });

  await page.route(
    (url) => url.pathname === `/api/people/${PERSON_ID}`,
    async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(MOCK_PERSON),
        });
        return;
      }
      await route.continue();
    },
  );
}

test.describe("PersonProfilePage – work schedule expand/collapse", () => {
  test("clicking the schedule name expands day rows and clicking again collapses them", async ({
    page,
  }) => {
    await setupPersonProfileRoutes(page);

    await page.goto(`/people/${PERSON_ID}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Jane Doe" })).toBeVisible({ timeout: 15_000 });

    // Person name and page are loaded.
    await expect(page.getByText("Jane Doe", { exact: false })).toBeVisible({
      timeout: 15_000,
    });

    // Switch to the Team Member tab where employment details live.
    await page.getByRole("button", { name: /team member/i }).click();

    // The work schedule label and name are visible.
    await expect(page.getByText("Work Schedule", { exact: true })).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText("Standard 9-5", { exact: true })).toBeVisible({ timeout: 5_000 });

    // Before expanding, the day rows should not be visible.
    await expect(page.getByText("09:00 – 17:00")).toHaveCount(0);

    // Click the schedule name button to expand.
    await page.getByRole("button", { name: /standard 9-5/i }).click();

    // At least one working-day row with formatted hours is now visible.
    await expect(page.getByText("09:00 – 17:00").first()).toBeVisible({
      timeout: 5_000,
    });

    // The day labels for working days are shown (Monday through Friday).
    await expect(page.getByText("Mon", { exact: true })).toBeVisible();
    await expect(page.getByText("Fri", { exact: true })).toBeVisible();

    // Non-working days show "Off".
    await expect(page.getByText("Off", { exact: true }).first()).toBeVisible();

    // Click the button again to collapse.
    await page.getByRole("button", { name: /standard 9-5/i }).click();

    // Day rows should disappear after collapsing.
    await expect(page.getByText("09:00 – 17:00")).toHaveCount(0, {
      timeout: 5_000,
    });
  });
});
