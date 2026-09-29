import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";

const OWNER_EMAIL = "e2e-tester@presentail.com";

const PHOTO_URL = "https://example.com/avatar/alice-clerk.jpg";

const MEMBER_WITH_PHOTO = {
  id: 1,
  first_name: "Alice",
  last_name: "Smith",
  email: "alice@example.com",
  phone: null,
  job_title: "Engineer",
  department_id: null,
  department_name: null,
  employment_status: "full_time",
  start_date: null,
  archived_at: null,
  image_url: PHOTO_URL,
};

const MEMBER_NO_PHOTO = {
  id: 2,
  first_name: "Bob",
  last_name: "Jones",
  email: "bob@example.com",
  phone: null,
  job_title: null,
  department_id: null,
  department_name: null,
  employment_status: "part_time",
  start_date: null,
  archived_at: null,
  image_url: null,
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

async function setupTeamMembersPage(
  page: import("@playwright/test").Page,
  members: typeof MEMBER_WITH_PHOTO[],
) {
  await setupClerkTestingToken({ page });

  await page.route("**/api/users**", async (route) => {
    const url = route.request().url();
    if (
      route.request().method() === "GET" &&
      (url.endsWith("/api/users") || url.endsWith("/api/users/"))
    ) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(usersResponse()),
      });
      return;
    }
    await route.continue();
  });

  await page.route("**/api/users/failed-access-requests**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ failedRequests: [] }),
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
      body: JSON.stringify({ count: 0, notifications: [] }),
    });
  });

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
      body: JSON.stringify({ success: true, departments: [] }),
    }),
  );

  await page.route("**/api/team-members**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true, team_members: members }),
    });
  });
}

test.describe("Team Members page — profile photo avatar", () => {
  test(
    "renders a profile photo <img> when image_url is present",
    async ({ page }) => {
      await setupTeamMembersPage(page, [MEMBER_WITH_PHOTO, MEMBER_NO_PHOTO]);

      await page.goto("/admin/people/team-members", {
        waitUntil: "domcontentloaded",
      });

      await expect(
        page.getByRole("heading", { name: /Team Members/i }),
      ).toBeVisible({ timeout: 15_000 });

      await expect(page.getByText("Alice Smith")).toBeVisible({
        timeout: 10_000,
      });

      const avatar = page.locator(`img[src="${PHOTO_URL}"]`);
      await expect(avatar).toBeVisible({ timeout: 5_000 });
    },
  );

  test(
    "renders an initials fallback when image_url is null",
    async ({ page }) => {
      await setupTeamMembersPage(page, [MEMBER_WITH_PHOTO, MEMBER_NO_PHOTO]);

      await page.goto("/admin/people/team-members", {
        waitUntil: "domcontentloaded",
      });

      await expect(
        page.getByRole("heading", { name: /Team Members/i }),
      ).toBeVisible({ timeout: 15_000 });

      await expect(page.getByText("Bob Jones")).toBeVisible({
        timeout: 10_000,
      });

      const bobRow = page
        .locator("tr")
        .filter({ has: page.getByText("Bob Jones") });

      await expect(bobRow).toBeVisible({ timeout: 5_000 });

      const initialsDiv = bobRow.locator("div.rounded-full.bg-secondary").filter({
        hasText: "BJ",
      });
      await expect(initialsDiv).toBeVisible({ timeout: 5_000 });

      const photoImg = bobRow.locator("img");
      await expect(photoImg).toHaveCount(0);
    },
  );
});
