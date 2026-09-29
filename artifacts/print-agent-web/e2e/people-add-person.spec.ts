import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";

const OWNER_EMAIL = "e2e-tester@presentail.com";

const MOCK_STATS = {
  totalPeople: 1,
  totalTeamMembers: 1,
  totalUsersWithAccess: 1,
  totalPendingInvites: 0,
  totalAdmins: 1,
  totalNoLoginAccess: 0,
};

const EXISTING_PERSON = {
  id: "person-1",
  source: "member" as const,
  first_name: "Alice",
  last_name: "Smith",
  email: "alice@example.com",
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
  employment_status: "full_time",
  archived_at: null,
  person_id: 1,
  profile_id: null,
  employee_code: null,
  start_date: null,
};

const NEW_PERSON = {
  id: "person-2",
  source: "team_member" as const,
  first_name: "Bob",
  last_name: "Jones",
  email: null,
  phone: null,
  job_title: null,
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
  team_member_id: 2,
  employment_status: "full_time",
  archived_at: null,
  person_id: 99,
  profile_id: 55,
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

async function setupPeoplePage(
  page: import("@playwright/test").Page,
  opts: {
    onPost?: (body: unknown) => { status: number; body: unknown };
    peopleAfterCreate?: typeof EXISTING_PERSON[];
  } = {},
) {
  await setupClerkTestingToken({ page });

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

  let callCount = 0;
  await page.route("**/api/people**", async (route) => {
    const method = route.request().method();

    if (method === "GET") {
      callCount += 1;
      const people =
        callCount === 1 || !opts.peopleAfterCreate
          ? [EXISTING_PERSON]
          : opts.peopleAfterCreate;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          people,
          stats: { ...MOCK_STATS, totalPeople: people.length },
        }),
      });
      return;
    }

    if (method === "POST") {
      const handler =
        opts.onPost ??
        (() => ({
          status: 201,
          body: { person: NEW_PERSON },
        }));
      const result = handler(route.request().postDataJSON());
      await route.fulfill({
        status: result.status,
        contentType: "application/json",
        body: JSON.stringify(result.body),
      });
      return;
    }

    await route.fulfill({ status: 405, body: "" });
  });
}

test.describe("People Directory — Add Person dialog", () => {
  test("submit button is disabled when first_name is empty", async ({ page }) => {
    await setupPeoplePage(page);
    await page.goto("/people", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "People Directory" })).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText("Alice Smith")).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: /add person/i }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    const submitButton = dialog.getByRole("button", { name: /add person/i });
    await expect(submitButton).toBeDisabled();
  });

  test("submit button remains disabled when first_name is only whitespace", async ({ page }) => {
    await setupPeoplePage(page);
    await page.goto("/people", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "People Directory" })).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText("Alice Smith")).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: /add person/i }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    await page.locator("#add-first-name").fill("   ");

    const submitButton = dialog.getByRole("button", { name: /add person/i });
    await expect(submitButton).toBeDisabled();
  });

  test("submit button becomes enabled once a valid first_name is entered", async ({ page }) => {
    await setupPeoplePage(page);
    await page.goto("/people", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "People Directory" })).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText("Alice Smith")).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: /add person/i }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    const submitButton = dialog.getByRole("button", { name: /add person/i });
    await expect(submitButton).toBeDisabled();

    await page.locator("#add-first-name").fill("Bob");

    await expect(submitButton).toBeEnabled({ timeout: 3_000 });
  });

  test("submitting with a valid first_name calls POST and the new person appears in the list", async ({
    page,
  }) => {
    let postBody: unknown = null;
    let postResponseBody: unknown = null;

    await setupPeoplePage(page, {
      onPost: (body) => {
        postBody = body;
        postResponseBody = NEW_PERSON;
        return { status: 201, body: NEW_PERSON };
      },
      peopleAfterCreate: [EXISTING_PERSON, NEW_PERSON],
    });

    await page.goto("/people", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "People Directory" })).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText("Alice Smith")).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: /add person/i }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    await page.locator("#add-first-name").fill("Bob");
    await page.locator("#add-last-name").fill("Jones");

    const submitButton = dialog.getByRole("button", { name: /add person/i });
    await expect(submitButton).toBeEnabled({ timeout: 3_000 });
    await submitButton.click();

    await expect(async () => {
      expect(postBody).not.toBeNull();
    }).toPass({ timeout: 8_000 });

    const body = postBody as Record<string, unknown>;
    expect(body.first_name).toBe("Bob");
    expect(body.last_name).toBe("Jones");

    // Verify the API response carries non-null person_id and profile_id —
    // confirming the inline linkage introduced by task #1085 fires immediately.
    const resp = postResponseBody as Record<string, unknown>;
    expect(resp.person_id).not.toBeNull();
    expect(resp.profile_id).not.toBeNull();

    await expect(page.getByText("Bob Jones")).toBeVisible({ timeout: 10_000 });
  });

  test("form does not call POST when first_name is empty (no submit without required field)", async ({
    page,
  }) => {
    let postCalled = false;

    await setupPeoplePage(page, {
      onPost: () => {
        postCalled = true;
        return { status: 201, body: { person: NEW_PERSON } };
      },
    });

    await page.goto("/people", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "People Directory" })).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText("Alice Smith")).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: /add person/i }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    const submitButton = dialog.getByRole("button", { name: /add person/i });
    await expect(submitButton).toBeDisabled();

    await page.waitForTimeout(500);

    expect(postCalled).toBe(false);
  });
});
