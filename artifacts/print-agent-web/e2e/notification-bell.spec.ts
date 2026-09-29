import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";

const OWNER_EMAIL = "e2e-tester+clerk_test@presentail.com";

const MOCK_USERS_OWNER = {
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

const MOCK_ROLES = { roles: [] };

const MOCK_ACCESS_REQUEST = {
  id: 101,
  requester_clerk_id: "user_test123",
  requester_name: "Alice Tester",
  requester_email: "alice@example.com",
  status: "pending",
  requested_at: new Date(Date.now() - 5 * 60_000).toISOString(),
  resolved_at: null,
};

async function setupCommonRoutes(
  page: import("@playwright/test").Page,
  requests: object[] = [],
) {
  await page.route("**/api/access-requests/events", (route) => route.abort());

  await page.route("**/api/roles**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_ROLES),
    }),
  );

  await page.route("**/api/users**", (route) => {
    const url = route.request().url();
    if (url.includes("failed")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ failedRequests: [] }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_USERS_OWNER),
    });
  });

  await page.route("**/api/access-requests", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ requests }),
    }),
  );
}

test.describe("Notification bell — desktop (1280px)", () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test.beforeEach(async ({ page }) => {
    await setupClerkTestingToken({ page });
  });

  test("bell renders in the desktop header", async ({ page }) => {
    await setupCommonRoutes(page, []);
    await page.goto("/devices", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Devices" })).toBeVisible({ timeout: 15_000 });

    const header = page.locator("header");
    await expect(header).toBeVisible({ timeout: 15_000 });

    const bell = header.getByTestId("notification-bell");
    await expect(bell).toBeVisible({ timeout: 10_000 });
  });

  test("no badge is shown when there are no pending requests", async ({
    page,
  }) => {
    await setupCommonRoutes(page, []);
    await page.goto("/devices", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Devices" })).toBeVisible({ timeout: 15_000 });

    const header = page.locator("header");
    const bell = header.getByTestId("notification-bell");
    await expect(bell).toBeVisible({ timeout: 15_000 });

    await expect(header.getByTestId("notification-badge")).toHaveCount(0);
  });

  test("badge shows correct count when there are pending requests", async ({
    page,
  }) => {
    await setupCommonRoutes(page, [MOCK_ACCESS_REQUEST]);
    await page.goto("/devices", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Devices" })).toBeVisible({ timeout: 15_000 });

    const header = page.locator("header");
    const bell = header.getByTestId("notification-bell");
    await expect(bell).toBeVisible({ timeout: 15_000 });

    const badge = header.getByTestId("notification-badge");
    await expect(badge).toBeVisible({ timeout: 10_000 });
    await expect(badge).toHaveText("1");
  });

  test("clicking the bell opens the dropdown with empty state when no requests", async ({
    page,
  }) => {
    await setupCommonRoutes(page, []);
    await page.goto("/devices", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Devices" })).toBeVisible({ timeout: 15_000 });

    const header = page.locator("header");
    const bell = header.getByTestId("notification-bell");
    await expect(bell).toBeVisible({ timeout: 15_000 });

    await bell.click();

    const dropdown = page.locator("[data-radix-popper-content-wrapper]");
    await expect(dropdown).toBeVisible({ timeout: 10_000 });

    await expect(dropdown.getByText(/no notifications/i)).toBeVisible();
    await expect(dropdown.getByTestId("notification-item")).toHaveCount(0);
  });

  test("clicking the bell opens the dropdown showing notification items", async ({
    page,
  }) => {
    await setupCommonRoutes(page, [MOCK_ACCESS_REQUEST]);
    await page.goto("/devices", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Devices" })).toBeVisible({ timeout: 15_000 });

    const header = page.locator("header");
    const bell = header.getByTestId("notification-bell");
    await expect(bell).toBeVisible({ timeout: 15_000 });

    await bell.click();

    const dropdown = page.locator("[data-radix-popper-content-wrapper]");
    await expect(dropdown).toBeVisible({ timeout: 10_000 });

    const item = dropdown.getByTestId("notification-item");
    await expect(item).toHaveCount(1);
    await expect(item).toContainText(MOCK_ACCESS_REQUEST.requester_name);

    await expect(dropdown.getByTestId("notification-view-all")).toBeVisible();
  });

  test("clicking a notification item navigates to /users and closes the dropdown", async ({
    page,
  }) => {
    await setupCommonRoutes(page, [MOCK_ACCESS_REQUEST]);
    await page.goto("/devices", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Devices" })).toBeVisible({ timeout: 15_000 });

    const header = page.locator("header");
    const bell = header.getByTestId("notification-bell");
    await expect(bell).toBeVisible({ timeout: 15_000 });

    await bell.click();

    const dropdown = page.locator("[data-radix-popper-content-wrapper]");
    await expect(dropdown).toBeVisible({ timeout: 10_000 });

    const item = dropdown.getByTestId("notification-item").first();
    await item.click();

    await expect(page).toHaveURL(/\/users/, { timeout: 10_000 });
    await expect(dropdown).not.toBeVisible();
  });

  test("clicking the 'View all' link navigates to /users and closes the dropdown", async ({
    page,
  }) => {
    await setupCommonRoutes(page, [MOCK_ACCESS_REQUEST]);
    await page.goto("/devices", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Devices" })).toBeVisible({ timeout: 15_000 });

    const header = page.locator("header");
    const bell = header.getByTestId("notification-bell");
    await expect(bell).toBeVisible({ timeout: 15_000 });

    await bell.click();

    const dropdown = page.locator("[data-radix-popper-content-wrapper]");
    await expect(dropdown).toBeVisible({ timeout: 10_000 });

    const viewAll = dropdown.getByTestId("notification-view-all");
    await expect(viewAll).toBeVisible();
    await viewAll.click();

    await expect(page).toHaveURL(/\/users/, { timeout: 10_000 });
    await expect(dropdown).not.toBeVisible();
  });

  test("badge disappears after opening the dropdown", async ({ page }) => {
    await setupCommonRoutes(page, [MOCK_ACCESS_REQUEST]);
    await page.goto("/devices", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Devices" })).toBeVisible({ timeout: 15_000 });

    const header = page.locator("header");
    const bell = header.getByTestId("notification-bell");
    await expect(bell).toBeVisible({ timeout: 15_000 });

    // Badge should be visible before opening the dropdown
    const badge = header.getByTestId("notification-badge");
    await expect(badge).toBeVisible({ timeout: 10_000 });
    await expect(badge).toHaveText("1");

    // Opening the dropdown marks all current requests as seen
    await bell.click();
    const dropdown = page.locator("[data-radix-popper-content-wrapper]");
    await expect(dropdown).toBeVisible({ timeout: 10_000 });

    // Badge should no longer be rendered
    await expect(header.getByTestId("notification-badge")).toHaveCount(0, {
      timeout: 5_000,
    });
  });

  test("seen state persists in localStorage after page refresh", async ({
    page,
  }) => {
    await setupCommonRoutes(page, [MOCK_ACCESS_REQUEST]);
    await page.goto("/devices", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Devices" })).toBeVisible({ timeout: 15_000 });

    const header = page.locator("header");
    const bell = header.getByTestId("notification-bell");
    await expect(bell).toBeVisible({ timeout: 15_000 });

    // Confirm badge is visible before opening the dropdown
    await expect(header.getByTestId("notification-badge")).toBeVisible({
      timeout: 10_000,
    });

    // Opening the dropdown auto-marks all requests as seen
    await bell.click();
    const dropdown = page.locator("[data-radix-popper-content-wrapper]");
    await expect(dropdown).toBeVisible({ timeout: 10_000 });

    // Badge gone immediately after opening
    await expect(header.getByTestId("notification-badge")).toHaveCount(0, {
      timeout: 5_000,
    });

    // Confirm the seen ID is written to localStorage
    const storedIds = await page.evaluate(() =>
      localStorage.getItem("notification_seen_ids"),
    );
    expect(storedIds).toContain(String(MOCK_ACCESS_REQUEST.id));

    // Re-register mocked routes before reloading (routes are per-page-load)
    await setupCommonRoutes(page, [MOCK_ACCESS_REQUEST]);

    // Reload the page — localStorage survives navigation
    await page.reload();
    await expect(bell).toBeVisible({ timeout: 15_000 });

    // Badge should still be absent because the seen ID is in localStorage
    await expect(header.getByTestId("notification-badge")).toHaveCount(0, {
      timeout: 10_000,
    });
  });
});

test.describe("Notification bell — time-off two-step approve/deny flow", () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  const TIME_OFF_NOTIF = {
    id: 501,
    type: "TIME_OFF_REQUEST",
    title: "New Vacation request",
    body: "Alice requested vacation from 2026-06-01 to 2026-06-03.",
    entity_id: 5001,
    is_read: false,
    created_at: new Date(Date.now() - 2 * 60_000).toISOString(),
    actor_email: "alice@example.com",
  };

  test.beforeEach(async ({ page }) => {
    await setupClerkTestingToken({ page });
  });

  async function setupTimeOffRoutes(
    page: import("@playwright/test").Page,
    onReview: (body: Record<string, unknown>) => void,
  ) {
    await setupCommonRoutes(page, []);

    await page.route("**/api/time-off/notifications/events", (route) =>
      route.abort(),
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
        body: JSON.stringify({ notifications: [TIME_OFF_NOTIF] }),
      });
    });

    await page.route(
      `**/api/time-off/requests/${TIME_OFF_NOTIF.entity_id}/status`,
      async (route) => {
        if (route.request().method() !== "PATCH") {
          await route.continue();
          return;
        }
        const body = JSON.parse(route.request().postData() ?? "{}");
        onReview(body);
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
      },
    );
  }

  test("Approve from bell shows the inline note form, then Confirm submits with the note", async ({
    page,
  }) => {
    let reviewBody: Record<string, unknown> | null = null;
    await setupTimeOffRoutes(page, (body) => {
      reviewBody = body;
    });

    await page.goto("/devices", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Devices" })).toBeVisible({ timeout: 15_000 });
    const bell = page.locator("header").getByTestId("notification-bell");
    await expect(bell).toBeVisible({ timeout: 15_000 });
    await bell.click();

    const dropdown = page.locator("[data-radix-popper-content-wrapper]");
    await expect(dropdown).toBeVisible({ timeout: 10_000 });

    const approve = dropdown.getByTestId(
      `notification-approve-${TIME_OFF_NOTIF.id}`,
    );
    await expect(approve).toBeVisible();
    await approve.click();

    // Approve/Deny replaced by the inline note form.
    await expect(approve).toHaveCount(0);
    const note = dropdown.getByTestId(`notification-note-${TIME_OFF_NOTIF.id}`);
    await expect(note).toBeVisible();

    await note.fill("Looks good — enjoy!");

    await dropdown
      .getByTestId(`notification-confirm-${TIME_OFF_NOTIF.id}`)
      .click();

    await expect.poll(() => reviewBody).toMatchObject({
      status: "APPROVED",
      managerNote: "Looks good — enjoy!",
    });
  });

  test("badge clears after Approve + Confirm from the bell dropdown", async ({
    page,
  }) => {
    await setupTimeOffRoutes(page, () => {});

    await page.goto("/devices", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Devices" })).toBeVisible({ timeout: 15_000 });

    const header = page.locator("header");
    const bell = header.getByTestId("notification-bell");
    await expect(bell).toBeVisible({ timeout: 15_000 });

    // Badge should be visible before acting
    const badge = header.getByTestId("notification-badge");
    await expect(badge).toBeVisible({ timeout: 10_000 });

    await bell.click();

    const dropdown = page.locator("[data-radix-popper-content-wrapper]");
    await expect(dropdown).toBeVisible({ timeout: 10_000 });

    await dropdown
      .getByTestId(`notification-approve-${TIME_OFF_NOTIF.id}`)
      .click();

    await expect(
      dropdown.getByTestId(`notification-note-${TIME_OFF_NOTIF.id}`),
    ).toBeVisible();

    // After Confirm the server marks the notification read — simulate that by
    // overriding the notifications route to return an empty list before clicking.
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

    await dropdown
      .getByTestId(`notification-confirm-${TIME_OFF_NOTIF.id}`)
      .click();

    // The invalidation triggers a refetch which now returns empty — badge must vanish
    await expect(header.getByTestId("notification-badge")).toHaveCount(0, {
      timeout: 10_000,
    });
  });

  test("badge clears after Deny + Confirm from the bell dropdown", async ({
    page,
  }) => {
    await setupTimeOffRoutes(page, () => {});

    await page.goto("/devices", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Devices" })).toBeVisible({ timeout: 15_000 });

    const header = page.locator("header");
    const bell = header.getByTestId("notification-bell");
    await expect(bell).toBeVisible({ timeout: 15_000 });

    // Badge should be visible before acting
    const badge = header.getByTestId("notification-badge");
    await expect(badge).toBeVisible({ timeout: 10_000 });

    await bell.click();

    const dropdown = page.locator("[data-radix-popper-content-wrapper]");
    await expect(dropdown).toBeVisible({ timeout: 10_000 });

    await dropdown
      .getByTestId(`notification-deny-${TIME_OFF_NOTIF.id}`)
      .click();

    await expect(
      dropdown.getByTestId(`notification-note-${TIME_OFF_NOTIF.id}`),
    ).toBeVisible();

    // After Confirm the server marks the notification read — simulate that by
    // overriding the notifications route to return an empty list before clicking.
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

    await dropdown
      .getByTestId(`notification-confirm-${TIME_OFF_NOTIF.id}`)
      .click();

    // The invalidation triggers a refetch which now returns empty — badge must vanish
    await expect(header.getByTestId("notification-badge")).toHaveCount(0, {
      timeout: 10_000,
    });
  });

  test("badge clears and toast shown when PATCH returns 409 (already cancelled)", async ({
    page,
  }) => {
    await setupTimeOffRoutes(page, () => {});

    // Override the PATCH endpoint to return 409 (request already cancelled)
    await page.route(
      `**/api/time-off/requests/${TIME_OFF_NOTIF.entity_id}/status`,
      async (route) => {
        if (route.request().method() !== "PATCH") {
          await route.continue();
          return;
        }
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ error: "Request already cancelled" }),
        });
      },
    );

    await page.goto("/devices", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Devices" })).toBeVisible({ timeout: 15_000 });

    const header = page.locator("header");
    const bell = header.getByTestId("notification-bell");
    await expect(bell).toBeVisible({ timeout: 15_000 });

    // Badge should be visible before acting
    const badge = header.getByTestId("notification-badge");
    await expect(badge).toBeVisible({ timeout: 10_000 });

    await bell.click();

    const dropdown = page.locator("[data-radix-popper-content-wrapper]");
    await expect(dropdown).toBeVisible({ timeout: 10_000 });

    // Enter the two-step flow by clicking Approve
    await dropdown
      .getByTestId(`notification-approve-${TIME_OFF_NOTIF.id}`)
      .click();

    await expect(
      dropdown.getByTestId(`notification-note-${TIME_OFF_NOTIF.id}`),
    ).toBeVisible();

    // Click Confirm — server responds 409
    await dropdown
      .getByTestId(`notification-confirm-${TIME_OFF_NOTIF.id}`)
      .click();

    // The 409 path calls markTimeOffIds which clears the badge locally
    await expect(header.getByTestId("notification-badge")).toHaveCount(0, {
      timeout: 10_000,
    });

    // Toast with the "already cancelled" message must appear
    await expect(
      page.getByText("Request already cancelled"),
    ).toBeVisible({ timeout: 5_000 });
  });

  test("badge clears and toast shown when PATCH returns 404 (request hard-deleted)", async ({
    page,
  }) => {
    await setupTimeOffRoutes(page, () => {});

    // Override the PATCH endpoint to return 404 (request no longer exists)
    await page.route(
      `**/api/time-off/requests/${TIME_OFF_NOTIF.entity_id}/status`,
      async (route) => {
        if (route.request().method() !== "PATCH") {
          await route.continue();
          return;
        }
        await route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ error: "Request not found" }),
        });
      },
    );

    await page.goto("/devices", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Devices" })).toBeVisible({ timeout: 15_000 });

    const header = page.locator("header");
    const bell = header.getByTestId("notification-bell");
    await expect(bell).toBeVisible({ timeout: 15_000 });

    // Badge should be visible before acting
    const badge = header.getByTestId("notification-badge");
    await expect(badge).toBeVisible({ timeout: 10_000 });

    await bell.click();

    const dropdown = page.locator("[data-radix-popper-content-wrapper]");
    await expect(dropdown).toBeVisible({ timeout: 10_000 });

    // Enter the two-step flow by clicking Approve
    await dropdown
      .getByTestId(`notification-approve-${TIME_OFF_NOTIF.id}`)
      .click();

    await expect(
      dropdown.getByTestId(`notification-note-${TIME_OFF_NOTIF.id}`),
    ).toBeVisible();

    // Click Confirm — server responds 404
    await dropdown
      .getByTestId(`notification-confirm-${TIME_OFF_NOTIF.id}`)
      .click();

    // The 404 path calls markTimeOffIds which clears the badge locally
    await expect(header.getByTestId("notification-badge")).toHaveCount(0, {
      timeout: 10_000,
    });

    // Toast with the "already cancelled" message must appear
    await expect(
      page.getByText("Request already cancelled"),
    ).toBeVisible({ timeout: 5_000 });
  });

  test("Cancel returns to the Approve/Deny buttons without making any API call", async ({
    page,
  }) => {
    let reviewBody: Record<string, unknown> | null = null;
    await setupTimeOffRoutes(page, (body) => {
      reviewBody = body;
    });

    await page.goto("/devices", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Devices" })).toBeVisible({ timeout: 15_000 });
    const bell = page.locator("header").getByTestId("notification-bell");
    await expect(bell).toBeVisible({ timeout: 15_000 });
    await bell.click();

    const dropdown = page.locator("[data-radix-popper-content-wrapper]");
    await expect(dropdown).toBeVisible({ timeout: 10_000 });

    await dropdown
      .getByTestId(`notification-deny-${TIME_OFF_NOTIF.id}`)
      .click();
    await expect(
      dropdown.getByTestId(`notification-note-${TIME_OFF_NOTIF.id}`),
    ).toBeVisible();

    await dropdown
      .getByTestId(`notification-cancel-${TIME_OFF_NOTIF.id}`)
      .click();

    await expect(
      dropdown.getByTestId(`notification-note-${TIME_OFF_NOTIF.id}`),
    ).toHaveCount(0);
    await expect(
      dropdown.getByTestId(`notification-approve-${TIME_OFF_NOTIF.id}`),
    ).toBeVisible();
    await expect(
      dropdown.getByTestId(`notification-deny-${TIME_OFF_NOTIF.id}`),
    ).toBeVisible();

    expect(reviewBody).toBeNull();
  });
});

test.describe("Notification bell — mobile (400px)", () => {
  test.use({ viewport: { width: 400, height: 800 } });

  test.beforeEach(async ({ page }) => {
    await setupClerkTestingToken({ page });
  });

  test("bell renders in the mobile top bar", async ({ page }) => {
    await setupCommonRoutes(page, []);
    await page.goto("/devices", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Devices" })).toBeVisible({ timeout: 15_000 });

    const mobileBar = page.locator(".md\\:hidden.fixed.top-0");
    await expect(mobileBar).toBeVisible({ timeout: 15_000 });

    const bell = mobileBar.getByTestId("notification-bell");
    await expect(bell).toBeVisible({ timeout: 10_000 });
  });

  test("no badge is shown on mobile when there are no pending requests", async ({
    page,
  }) => {
    await setupCommonRoutes(page, []);
    await page.goto("/devices", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Devices" })).toBeVisible({ timeout: 15_000 });

    const mobileBar = page.locator(".md\\:hidden.fixed.top-0");
    const bell = mobileBar.getByTestId("notification-bell");
    await expect(bell).toBeVisible({ timeout: 15_000 });

    await expect(mobileBar.getByTestId("notification-badge")).toHaveCount(0);
  });

  test("badge shows correct count on mobile when there are pending requests", async ({
    page,
  }) => {
    await setupCommonRoutes(page, [MOCK_ACCESS_REQUEST]);
    await page.goto("/devices", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Devices" })).toBeVisible({ timeout: 15_000 });

    const mobileBar = page.locator(".md\\:hidden.fixed.top-0");
    const bell = mobileBar.getByTestId("notification-bell");
    await expect(bell).toBeVisible({ timeout: 15_000 });

    const badge = mobileBar.getByTestId("notification-badge");
    await expect(badge).toBeVisible({ timeout: 10_000 });
    await expect(badge).toHaveText("1");
  });

  test("clicking the bell on mobile opens the dropdown with empty state", async ({
    page,
  }) => {
    await setupCommonRoutes(page, []);
    await page.goto("/devices", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Devices" })).toBeVisible({ timeout: 15_000 });

    const mobileBar = page.locator(".md\\:hidden.fixed.top-0");
    const bell = mobileBar.getByTestId("notification-bell");
    await expect(bell).toBeVisible({ timeout: 15_000 });

    await bell.click();

    const dropdown = page.locator("[data-radix-popper-content-wrapper]");
    await expect(dropdown).toBeVisible({ timeout: 10_000 });

    await expect(dropdown.getByText(/no notifications/i)).toBeVisible();
    await expect(dropdown.getByTestId("notification-item")).toHaveCount(0);
  });

  test("clicking the bell on mobile shows notification items", async ({
    page,
  }) => {
    await setupCommonRoutes(page, [MOCK_ACCESS_REQUEST]);
    await page.goto("/devices", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Devices" })).toBeVisible({ timeout: 15_000 });

    const mobileBar = page.locator(".md\\:hidden.fixed.top-0");
    const bell = mobileBar.getByTestId("notification-bell");
    await expect(bell).toBeVisible({ timeout: 15_000 });

    await bell.click();

    const dropdown = page.locator("[data-radix-popper-content-wrapper]");
    await expect(dropdown).toBeVisible({ timeout: 10_000 });

    const item = dropdown.getByTestId("notification-item");
    await expect(item).toHaveCount(1);
    await expect(item).toContainText(MOCK_ACCESS_REQUEST.requester_name);

    await expect(dropdown.getByTestId("notification-view-all")).toBeVisible();
  });
});
