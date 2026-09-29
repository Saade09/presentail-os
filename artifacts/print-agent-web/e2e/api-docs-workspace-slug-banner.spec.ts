import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import type { Page } from "@playwright/test";

const OWNER_EMAIL = "e2e-tester@presentail.com";

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

async function setupCommonRoutes(page: Page, workspaceSlug: string | null) {
  await page.route("**/api/users**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(ownerUsersResponse()),
    }),
  );

  await page.route("**/api/roles**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ roles: [] }),
    }),
  );

  await page.route("**/api/api-keys**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ keys: [] }),
    }),
  );

  await page.route("**/api/devices**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ devices: [] }),
    }),
  );

  await page.route("**/api/profile**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ phone: null, job_title: null, birthday: null, gender: null }),
    }),
  );

  await page.route("**/api/settings**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        workspace_slug: workspaceSlug,
        offline_alert_threshold_minutes: 5,
        offline_alert_email_enabled: false,
        available_countries: [],
        available_country_details: [],
        country_catalogue: [],
        undo_duration_seconds: 5,
      }),
    }),
  );
}

test.describe("API Docs — WorkspaceSlugBanner", () => {
  test("shows the slug and Copy param button when a workspace slug is set", async ({
    page,
  }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page, "my-store");

    await page.goto("/api-docs", { waitUntil: "domcontentloaded" });

    await expect(
      page.getByRole("heading", { name: /API Documentation/i }),
    ).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText("Your workspace slug")).toBeVisible({
      timeout: 10_000,
    });

    await expect(page.getByText("my-store")).toBeVisible();

    await expect(
      page.getByRole("button", { name: /Copy param/i }),
    ).toBeVisible();
  });

  test("shows the amber 'not set' prompt with a Settings link when no slug is configured", async ({
    page,
  }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page, null);

    await page.goto("/api-docs", { waitUntil: "domcontentloaded" });

    await expect(
      page.getByRole("heading", { name: /API Documentation/i }),
    ).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText("Workspace slug not set")).toBeVisible({
      timeout: 10_000,
    });

    await expect(
      page.getByText(/Set a workspace slug in Settings/i),
    ).toBeVisible();

    const settingsLink = page.getByRole("link", { name: /Settings/i }).first();
    await expect(settingsLink).toBeVisible();
    await expect(settingsLink).toHaveAttribute("href", /\/dashboard\/settings/);
  });
});
