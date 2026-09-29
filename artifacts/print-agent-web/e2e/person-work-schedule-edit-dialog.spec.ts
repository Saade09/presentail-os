import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import type { Page } from "@playwright/test";

const OWNER_EMAIL = "e2e-tester@presentail.com";
const PERSON_ID = "tm_sched-edit-99";

const INITIAL_PERSON = {
  id: PERSON_ID,
  source: "team_member" as const,
  first_name: "Alex",
  last_name: "Smith",
  email: "alex.smith@example.com",
  phone: null,
  job_title: "Developer",
  department_name: null,
  department_id: null,
  image_url: null,
  access_type: "team_member_only" as const,
  role: null,
  role_name: null,
  custom_role_id: null,
  joined: false,
  joined_at: null,
  invited_at: null,
  member_id: null,
  team_member_id: 99,
  employment_status: "full_time",
  archived_at: null,
  person_id: 99,
  profile_id: 99,
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
  work_schedule_weekly_hours: 40,
  work_schedule_days: [
    { day_of_week: "monday", is_working_day: true, start_time: "09:00:00", end_time: "17:00:00", break_minutes: 0 },
    { day_of_week: "tuesday", is_working_day: true, start_time: "09:00:00", end_time: "17:00:00", break_minutes: 0 },
    { day_of_week: "wednesday", is_working_day: true, start_time: "09:00:00", end_time: "17:00:00", break_minutes: 0 },
    { day_of_week: "thursday", is_working_day: true, start_time: "09:00:00", end_time: "17:00:00", break_minutes: 0 },
    { day_of_week: "friday", is_working_day: true, start_time: "09:00:00", end_time: "17:00:00", break_minutes: 0 },
    { day_of_week: "saturday", is_working_day: false, start_time: null, end_time: null, break_minutes: 0 },
    { day_of_week: "sunday", is_working_day: false, start_time: null, end_time: null, break_minutes: 0 },
  ],
  employment_type: null,
  attendance_enabled: false,
  profile_status: null,
};

const UPDATED_PERSON = {
  ...INITIAL_PERSON,
  work_schedule_id: 12,
  work_schedule_name: "Flexible Hours",
};

const CLEARED_PERSON = {
  ...INITIAL_PERSON,
  work_schedule_id: null,
  work_schedule_name: null,
  work_schedule_weekly_hours: null,
  work_schedule_days: [],
};

const NO_SCHEDULE_PERSON_ID = "tm_sched-edit-100";

const NO_SCHEDULE_PERSON = {
  ...INITIAL_PERSON,
  id: NO_SCHEDULE_PERSON_ID,
  team_member_id: 100,
  person_id: 100,
  profile_id: 100,
  work_schedule_id: null,
  work_schedule_name: null,
  work_schedule_weekly_hours: null,
  work_schedule_days: [],
};

const NO_SCHEDULE_PERSON_AFTER_ASSIGN = {
  ...NO_SCHEDULE_PERSON,
  work_schedule_id: 7,
  work_schedule_name: "Standard 9-5",
  work_schedule_weekly_hours: 40,
  work_schedule_days: INITIAL_PERSON.work_schedule_days,
};

const MOCK_WORK_SCHEDULES = [
  { id: 7, name: "Standard 9-5" },
  { id: 12, name: "Flexible Hours" },
];

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

async function setupCommonRoutes(page: Page) {
  await page.route("**/api/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true }),
    }),
  );

  await page.route("**/api/users**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(ownerUsersResponse()),
    }),
  );

  await page.route("**/api/notifications/seen**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    }),
  );

  await page.route("**/api/time-off/notifications**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ notifications: [] }),
    }),
  );

  await page.route("**/api/access-requests**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ requests: [] }),
    }),
  );

  await page.route("**/api/departments**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ departments: [] }),
    }),
  );

  await page.route("**/api/work-schedules**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ work_schedules: MOCK_WORK_SCHEDULES }),
    }),
  );

  await page.route("**/api/team-members**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ team_members: [] }),
    }),
  );
}

test.describe("PersonProfilePage – work schedule edit dialog", () => {
  test.beforeEach(async ({ page }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page);
  });

  test("edit dialog pre-fills the current schedule, allows changing it, and reflects the new schedule after save", async ({
    page,
  }) => {
    let patchCalled = false;
    let patchRequestBody: Record<string, unknown> | null = null;

    await page.route("**/api/people**", async (route) => {
      const method = route.request().method();
      const url = route.request().url();
      const isPerson = url.includes(`/api/people/${PERSON_ID}`);

      if (isPerson && method === "PATCH") {
        patchCalled = true;
        patchRequestBody = route.request().postDataJSON() as Record<string, unknown>;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(UPDATED_PERSON),
        });
        return;
      }

      if (isPerson) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(patchCalled ? UPDATED_PERSON : INITIAL_PERSON),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ people: [], stats: {} }),
      });
    });

    await page.goto(`/people/${PERSON_ID}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Alex Smith" })).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText("Alex Smith")).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: /team member/i }).click();

    await expect(
      page.getByRole("button", { name: /edit hr profile/i }),
    ).toBeVisible({ timeout: 5_000 });
    await page.getByRole("button", { name: /edit hr profile/i }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    const scheduleSelect = dialog.locator("#edit-work-schedule");

    await expect(scheduleSelect).toHaveValue("7", { timeout: 5_000 });

    await scheduleSelect.selectOption("12");
    await expect(scheduleSelect).toHaveValue("12");

    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes(`/api/people/${PERSON_ID}`) &&
          r.request().method() === "PATCH",
      ),
      page.getByRole("button", { name: /save changes/i }).click(),
    ]);

    expect(patchCalled).toBe(true);
    expect(patchRequestBody).not.toBeNull();
    expect((patchRequestBody as Record<string, unknown>).work_schedule_id).toBe(12);

    await expect(dialog).not.toBeVisible({ timeout: 5_000 });

    await expect(page.getByText("Flexible Hours")).toBeVisible({ timeout: 10_000 });
  });

  test("clearing the work schedule sends work_schedule_id: null and removes the schedule name from the profile", async ({
    page,
  }) => {
    let patchCalled = false;
    let patchRequestBody: Record<string, unknown> | null = null;

    await page.route("**/api/people**", async (route) => {
      const method = route.request().method();
      const url = route.request().url();
      const isPerson = url.includes(`/api/people/${PERSON_ID}`);

      if (isPerson && method === "PATCH") {
        patchCalled = true;
        patchRequestBody = route.request().postDataJSON() as Record<string, unknown>;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(CLEARED_PERSON),
        });
        return;
      }

      if (isPerson) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(patchCalled ? CLEARED_PERSON : INITIAL_PERSON),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ people: [], stats: {} }),
      });
    });

    await page.goto(`/people/${PERSON_ID}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Alex Smith" })).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText("Alex Smith")).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: /team member/i }).click();

    await expect(
      page.getByRole("button", { name: /edit hr profile/i }),
    ).toBeVisible({ timeout: 5_000 });
    await page.getByRole("button", { name: /edit hr profile/i }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    const scheduleSelect = dialog.locator("#edit-work-schedule");

    await expect(scheduleSelect).toHaveValue("7", { timeout: 5_000 });

    await scheduleSelect.selectOption("");
    await expect(scheduleSelect).toHaveValue("");

    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes(`/api/people/${PERSON_ID}`) &&
          r.request().method() === "PATCH",
      ),
      page.getByRole("button", { name: /save changes/i }).click(),
    ]);

    expect(patchCalled).toBe(true);
    expect(patchRequestBody).not.toBeNull();
    expect((patchRequestBody as Record<string, unknown>).work_schedule_id).toBeNull();

    await expect(dialog).not.toBeVisible({ timeout: 5_000 });

    await expect(page.getByText("Standard 9-5")).not.toBeVisible({ timeout: 10_000 });
  });

  test("assigning a schedule from none sends work_schedule_id: 7 and shows the schedule name on the profile", async ({
    page,
  }) => {
    let patchCalled = false;
    let patchRequestBody: Record<string, unknown> | null = null;

    await page.route("**/api/people**", async (route) => {
      const method = route.request().method();
      const url = route.request().url();
      const isPerson = url.includes(`/api/people/${NO_SCHEDULE_PERSON_ID}`);

      if (isPerson && method === "PATCH") {
        patchCalled = true;
        patchRequestBody = route.request().postDataJSON() as Record<string, unknown>;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(NO_SCHEDULE_PERSON_AFTER_ASSIGN),
        });
        return;
      }

      if (isPerson) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(patchCalled ? NO_SCHEDULE_PERSON_AFTER_ASSIGN : NO_SCHEDULE_PERSON),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ people: [], stats: {} }),
      });
    });

    await page.goto(`/people/${NO_SCHEDULE_PERSON_ID}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Alex Smith" })).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText("Alex Smith")).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: /team member/i }).click();

    await expect(
      page.getByRole("button", { name: /edit hr profile/i }),
    ).toBeVisible({ timeout: 5_000 });
    await page.getByRole("button", { name: /edit hr profile/i }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    const scheduleSelect = dialog.locator("#edit-work-schedule");

    await expect(scheduleSelect).toHaveValue("", { timeout: 5_000 });

    await scheduleSelect.selectOption("7");
    await expect(scheduleSelect).toHaveValue("7");

    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes(`/api/people/${NO_SCHEDULE_PERSON_ID}`) &&
          r.request().method() === "PATCH",
      ),
      page.getByRole("button", { name: /save changes/i }).click(),
    ]);

    expect(patchCalled).toBe(true);
    expect(patchRequestBody).not.toBeNull();
    expect((patchRequestBody as Record<string, unknown>).work_schedule_id).toBe(7);

    await expect(dialog).not.toBeVisible({ timeout: 5_000 });

    await expect(page.getByText("Standard 9-5")).toBeVisible({ timeout: 10_000 });
  });
});
