import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";

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

function restrictedUsersResponse() {
  return {
    members: [
      {
        id: 1,
        email: OWNER_EMAIL,
        role: "member",
        custom_role_id: 99,
        role_name: "Staff",
        joined: true,
        joined_at: new Date().toISOString(),
        invited_at: new Date().toISOString(),
        invited_by_email: null,
        manager_member_id: null,
        manager_email: null,
      },
    ],
    me: {
      role: "member",
      email: OWNER_EMAIL,
      allowedPages: ["stickers"],
      customRoleId: 99,
    },
  };
}

async function setupCommonRoutes(page: import("@playwright/test").Page, usersBody: object) {
  await page.route("**/api/users**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(usersBody),
    });
  });
  await page.route("**/api/roles**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ roles: [] }),
    });
  });
  await page.route("**/api/api-keys**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ keys: [] }),
    });
  });
  await page.route("**/api/devices**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ devices: [] }),
    });
  });
  await page.route("**/api/profile**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ phone: null, job_title: null, birthday: null, gender: null }),
    });
  });
}

test.describe("Developer Tools sidebar group", () => {
  test("auto-expands and highlights the active child when navigating to /api-keys", async ({
    page,
  }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page, ownerUsersResponse());

    await page.goto("/api-keys", { waitUntil: "domcontentloaded" });

    await expect(page.getByRole("heading", { name: "API Keys" })).toBeVisible({
      timeout: 15_000,
    });

    const groupToggle = page.getByTestId("nav-developer");
    await expect(groupToggle).toBeVisible({ timeout: 10_000 });

    const apiKeysChild = page.getByTestId("nav-api-keys");
    await expect(apiKeysChild).toBeVisible();

    const webhookChild = page.getByTestId("nav-webhook-endpoints");
    await expect(webhookChild).toBeVisible();

    const apiDocsChild = page.getByTestId("nav-api-docs");
    await expect(apiDocsChild).toBeVisible();

    await expect(apiKeysChild).toHaveAttribute("aria-current", "page");
    await expect(apiDocsChild).not.toHaveAttribute("aria-current", "page");
  });

  test("collapses and hides children when the group header is clicked", async ({
    page,
  }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page, ownerUsersResponse());

    await page.goto("/api-keys", { waitUntil: "domcontentloaded" });

    await expect(page.getByRole("heading", { name: "API Keys" })).toBeVisible({
      timeout: 15_000,
    });

    const groupToggle = page.getByTestId("nav-developer");
    await expect(groupToggle).toBeVisible({ timeout: 10_000 });

    await expect(page.getByTestId("nav-api-keys")).toBeVisible();
    await expect(page.getByTestId("nav-api-docs")).toBeVisible();

    await groupToggle.click();

    await expect(page.getByTestId("nav-api-keys")).toHaveCount(0);
    await expect(page.getByTestId("nav-webhook-endpoints")).toHaveCount(0);
    await expect(page.getByTestId("nav-api-docs")).toHaveCount(0);

    await expect(groupToggle).toBeVisible();
  });

  test("is hidden entirely for a role with no access to any Developer Tools page", async ({
    page,
  }) => {
    await setupClerkTestingToken({ page });
    await setupCommonRoutes(page, restrictedUsersResponse());

    await page.goto("/profile", { waitUntil: "domcontentloaded" });

    await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible({
      timeout: 15_000,
    });

    await expect(page.getByTestId("nav-developer")).toHaveCount(0);
    await expect(page.getByTestId("nav-api-keys")).toHaveCount(0);
    await expect(page.getByTestId("nav-webhook-endpoints")).toHaveCount(0);
    await expect(page.getByTestId("nav-api-docs")).toHaveCount(0);
  });
});
