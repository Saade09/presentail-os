import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";

const OWNER_EMAIL = "e2e-tester@presentail.com";
const PERSON_ID = "tm_42";

const INITIAL_PERSON = {
  id: PERSON_ID,
  source: "team_member" as const,
  first_name: "Bob",
  last_name: "Jones",
  email: null,
  phone: null,
  job_title: null,
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
  team_member_id: 42,
  employment_status: "full_time",
  archived_at: null,
  person_id: 99,
  profile_id: 55,
  employee_code: null,
  start_date: null,
  birthday: null,
  manager_id: null,
  manager_name: null,
  work_schedule_id: null,
  work_schedule_name: null,
  work_schedule_days: null,
  work_schedule_weekly_hours: null,
  emergency_contact_name: null,
  emergency_contact_phone: null,
  emergency_contact_relationship: null,
  notes: null,
  attendance_enabled: false,
  employment_type: null,
  profile_status: null,
};

const UPDATED_PERSON = {
  ...INITIAL_PERSON,
  first_name: "Charlie",
  phone: "+9613000000",
};

const MOCK_STATS = {
  totalPeople: 2,
  totalTeamMembers: 1,
  totalUsersWithAccess: 1,
  totalPendingInvites: 0,
  totalAdmins: 1,
  totalNoLoginAccess: 1,
};

const OWNER_PERSON = {
  id: "wm_1",
  source: "member" as const,
  first_name: "Alice",
  last_name: "Owner",
  email: OWNER_EMAIL,
  phone: null,
  job_title: null,
  department_name: null,
  image_url: null,
  access_type: "owner" as const,
  role: "owner",
  role_name: null,
  custom_role_id: null,
  joined: true,
  joined_at: new Date().toISOString(),
  invited_at: new Date().toISOString(),
  member_id: 1,
  team_member_id: null,
  employment_status: null,
  archived_at: null,
  person_id: 1,
  profile_id: null,
  employee_code: null,
  start_date: null,
};

function usersResponse() {
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

async function setupCommonRoutes(page: import("@playwright/test").Page) {
  await page.route("**/api/users**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(usersResponse()),
    }),
  );

  await page.route("**/api/roles**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ roles: [] }),
    }),
  );

  await page.route("**/api/notifications/seen**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ seen: [] }),
    }),
  );

  await page.route("**/api/time-off/notifications**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ count: 0, notifications: [] }),
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
      body: JSON.stringify({ work_schedules: [] }),
    }),
  );

  await page.route("**/api/team-members**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ team_members: [] }),
    }),
  );

  await page.route("**/api/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true }),
    }),
  );
}

test.describe("Person profile edit reflects in people directory", () => {
  test("editing name and phone on a team member profile page updates the people directory without a page refresh", async ({
    page,
  }) => {
    await setupClerkTestingToken({ page });

    let patchCalled = false;

    await setupCommonRoutes(page);

    await page.route("**/api/people**", async (route) => {
      const method = route.request().method();
      const url = route.request().url();
      const isPerson = url.includes(`/api/people/${PERSON_ID}`);

      if (isPerson && method === "PATCH") {
        patchCalled = true;
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
          body: JSON.stringify(INITIAL_PERSON),
        });
        return;
      }

      const people = patchCalled
        ? [OWNER_PERSON, UPDATED_PERSON]
        : [OWNER_PERSON, INITIAL_PERSON];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ people, stats: MOCK_STATS }),
      });
    });

    await page.goto(`/people/${PERSON_ID}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Bob Jones" })).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText("Bob Jones")).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: "Team Member" }).click();

    await expect(
      page.getByRole("button", { name: /edit hr profile/i }),
    ).toBeVisible({ timeout: 5_000 });
    await page.getByRole("button", { name: /edit hr profile/i }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    const firstNameInput = dialog.locator("#edit-first-name");
    await expect(firstNameInput).toHaveValue("Bob", { timeout: 3_000 });
    await firstNameInput.clear();
    await firstNameInput.fill("Charlie");

    const phoneInput = dialog.locator("#edit-phone");
    await phoneInput.clear();
    await phoneInput.fill("+9613000000");

    const [patchResponse] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes(`/api/people/${PERSON_ID}`) &&
          r.request().method() === "PATCH",
      ),
      page.getByRole("button", { name: /save changes/i }).click(),
    ]);

    expect(patchResponse.status()).toBe(200);

    const patchBody = (await patchResponse.json()) as {
      first_name?: string;
      phone?: string;
    };
    expect(patchBody.first_name).toBe("Charlie");
    expect(patchBody.phone).toBe("+9613000000");

    await expect(
      page.getByText("Profile updated successfully").first(),
    ).toBeVisible({ timeout: 10_000 });

    await expect(dialog).not.toBeVisible({ timeout: 5_000 });

    await page.goto("/people", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "People Directory" })).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText("Charlie Jones")).toBeVisible({
      timeout: 15_000,
    });

    await expect(page.getByText("+9613000000")).toBeVisible({
      timeout: 5_000,
    });
  });

  test("profile page header reflects new name immediately after saving without waiting for refetch", async ({
    page,
  }) => {
    await setupClerkTestingToken({ page });

    await setupCommonRoutes(page);

    let refetchCount = 0;
    await page.route("**/api/people**", async (route) => {
      const method = route.request().method();
      const url = route.request().url();
      const isPerson = url.includes(`/api/people/${PERSON_ID}`);

      if (isPerson && method === "PATCH") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ success: true }),
        });
        return;
      }

      if (isPerson && method === "GET") {
        refetchCount += 1;
        if (refetchCount > 1) {
          await new Promise((r) => setTimeout(r, 5_000));
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(INITIAL_PERSON),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ people: [OWNER_PERSON, INITIAL_PERSON], stats: MOCK_STATS }),
      });
    });

    await page.goto(`/people/${PERSON_ID}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Bob Jones" })).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText("Bob Jones")).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: "Team Member" }).click();

    await expect(
      page.getByRole("button", { name: /edit hr profile/i }),
    ).toBeVisible({ timeout: 5_000 });
    await page.getByRole("button", { name: /edit hr profile/i }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    const firstNameInput = dialog.locator("#edit-first-name");
    await expect(firstNameInput).toHaveValue("Bob", { timeout: 3_000 });
    await firstNameInput.clear();
    await firstNameInput.fill("Charlie");

    const jobTitleInput = dialog.locator("#edit-job-title");
    await jobTitleInput.clear();
    await jobTitleInput.fill("Software Engineer");

    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes(`/api/people/${PERSON_ID}`) &&
          r.request().method() === "PATCH",
      ),
      page.getByRole("button", { name: /save changes/i }).click(),
    ]);

    await expect(dialog).not.toBeVisible({ timeout: 5_000 });

    // The header must update immediately via the optimistic cache write —
    // the refetch is artificially delayed 5 s so this assertion passes only
    // if the optimistic setQueryData fired synchronously in onSuccess.
    await expect(page.getByRole("heading", { name: "Charlie Jones" })).toBeVisible({
      timeout: 2_000,
    });
    await expect(page.getByText("Bob Jones")).not.toBeVisible();

    // The job title sub-heading must also reflect the new value immediately,
    // without waiting for the background refetch to complete.
    await expect(page.getByText("Software Engineer")).toBeVisible({ timeout: 2_000 });
  });

  test("Overview tab reflects updated job title immediately after saving without waiting for refetch", async ({
    page,
  }) => {
    await setupClerkTestingToken({ page });

    await setupCommonRoutes(page);

    let refetchCount = 0;
    await page.route("**/api/people**", async (route) => {
      const method = route.request().method();
      const url = route.request().url();
      const isPerson = url.includes(`/api/people/${PERSON_ID}`);

      if (isPerson && method === "PATCH") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ success: true }),
        });
        return;
      }

      if (isPerson && method === "GET") {
        refetchCount += 1;
        if (refetchCount > 1) {
          // Delay subsequent fetches so the assertion can only pass via
          // the optimistic cache write, not a completed background refetch.
          await new Promise((r) => setTimeout(r, 5_000));
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(INITIAL_PERSON),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ people: [OWNER_PERSON, INITIAL_PERSON], stats: MOCK_STATS }),
      });
    });

    await page.goto(`/people/${PERSON_ID}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Bob Jones" })).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText("Bob Jones")).toBeVisible({ timeout: 15_000 });

    // Navigate to Team Member tab to access the edit dialog
    await page.getByRole("button", { name: "Team Member" }).click();

    await expect(
      page.getByRole("button", { name: /edit hr profile/i }),
    ).toBeVisible({ timeout: 5_000 });
    await page.getByRole("button", { name: /edit hr profile/i }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    const jobTitleInput = dialog.locator("#edit-job-title");
    await jobTitleInput.clear();
    await jobTitleInput.fill("Software Engineer");

    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes(`/api/people/${PERSON_ID}`) &&
          r.request().method() === "PATCH",
      ),
      page.getByRole("button", { name: /save changes/i }).click(),
    ]);

    await expect(dialog).not.toBeVisible({ timeout: 5_000 });

    // Switch back to the Overview tab
    await page.getByRole("button", { name: "Overview" }).click();

    // The job title in the profile header must be visible immediately on the
    // Overview tab via the optimistic cache write — the refetch is delayed 5 s
    // so this assertion passes only if setQueryData fired synchronously in onSuccess.
    await expect(page.getByText("Software Engineer")).toBeVisible({ timeout: 2_000 });
  });

  test("people directory list reflects updated name immediately on navigation back without additional refetch", async ({
    page,
  }) => {
    await setupClerkTestingToken({ page });

    await setupCommonRoutes(page);

    let listRefetchCount = 0;
    await page.route("**/api/people**", async (route) => {
      const method = route.request().method();
      const url = route.request().url();
      const isPerson = url.includes(`/api/people/${PERSON_ID}`);

      if (isPerson && method === "PATCH") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ success: true }),
        });
        return;
      }

      if (isPerson && method === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(INITIAL_PERSON),
        });
        return;
      }

      // List endpoint — always returns the OLD name to confirm the directory
      // update comes from the optimistic cache write, not a fresh network response.
      listRefetchCount += 1;
      if (listRefetchCount > 1) {
        await new Promise((r) => setTimeout(r, 5_000));
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ people: [OWNER_PERSON, INITIAL_PERSON], stats: MOCK_STATS }),
      });
    });

    await page.goto(`/people/${PERSON_ID}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Bob Jones" })).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText("Bob Jones")).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: "Team Member" }).click();

    await page.getByRole("button", { name: /edit hr profile/i }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    const firstNameInput = dialog.locator("#edit-first-name");
    await expect(firstNameInput).toHaveValue("Bob", { timeout: 3_000 });
    await firstNameInput.clear();
    await firstNameInput.fill("Charlie");

    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes(`/api/people/${PERSON_ID}`) &&
          r.request().method() === "PATCH",
      ),
      page.getByRole("button", { name: /save changes/i }).click(),
    ]);

    await expect(dialog).not.toBeVisible({ timeout: 5_000 });

    // Navigate back to the directory using the back link on the profile page
    await page.getByRole("link", { name: /back to directory/i }).click();

    // The directory must immediately show "Charlie Jones" from the optimistic
    // cache update — the list refetch is delayed 5 s so this assertion passes
    // only if setQueriesData fired synchronously in onSuccess.
    await expect(page.getByText("Charlie Jones")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Bob Jones")).not.toBeVisible();
  });
});
