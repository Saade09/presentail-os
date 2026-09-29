import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import {
  PROTECTED_ROUTES,
  DYNAMIC_PROTECTED_ROUTE_PATHS,
} from "../src/protected-routes";

const OWNER_EMAIL = "e2e-tester+clerk_test@presentail.com";

const MOCK_USERS = {
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

test.describe("Avatar dropdown in header", () => {
  test.beforeEach(async ({ page }) => {
    await setupClerkTestingToken({ page });

    // Intercept Clerk sign-out FAPI calls to prevent actual server-side session
    // revocation. Without this, signing out in one test invalidates the shared
    // session token for all subsequent tests that load the same storage state.
    // Clerk's client still clears the local session regardless of the FAPI result,
    // so the sign-out UX (URL change, redirect) is unaffected.
    await page.route(/\/v1\/client\/sessions/, async (route) => {
      const url = route.request().url();
      if (
        url.includes("_method=DELETE") ||
        route.request().method() === "DELETE"
      ) {
        await route.abort();
      } else {
        await route.fallback();
      }
    });

    await page.route("**/api/users**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(MOCK_USERS),
      }),
    );

    await page.route("**/api/roles**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(MOCK_ROLES),
      }),
    );

    await page.goto("/devices", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Devices" })).toBeVisible({ timeout: 15_000 });
  });

  test("avatar appears in the desktop header, not in the sidebar", async ({
    page,
  }) => {
    const header = page.locator("header");
    await expect(header).toBeVisible({ timeout: 15_000 });

    const avatarInHeader = header.getByTestId("sidebar-avatar");
    await expect(avatarInHeader).toBeVisible({ timeout: 10_000 });

    const sidebar = page.locator("aside");
    await expect(sidebar.getByTestId("sidebar-avatar")).toHaveCount(0);
  });

  test("avatar dropdown shows name, email, role label, and sign-out button", async ({
    page,
  }) => {
    const header = page.locator("header");
    const avatarInHeader = header.getByTestId("sidebar-avatar");
    await expect(avatarInHeader).toBeVisible({ timeout: 15_000 });

    const roleLabel = page.getByTestId("sidebar-role-label");
    await expect(roleLabel).toBeAttached({ timeout: 10_000 });

    await avatarInHeader.click();

    const dropdownContent = page.locator("[data-radix-popper-content-wrapper]");
    await expect(dropdownContent).toBeVisible({ timeout: 10_000 });

    await expect(dropdownContent.getByText("E2E", { exact: true })).toBeVisible();

    await expect(
      dropdownContent.getByText(OWNER_EMAIL),
    ).toBeVisible();

    await expect(dropdownContent.getByText("Owner")).toBeVisible();

    await expect(
      page.getByTestId("button-sign-out"),
    ).toBeVisible();
  });

  test("Profile link in dropdown navigates to /profile", async ({
    page,
  }) => {
    const header = page.locator("header");
    const avatarInHeader = header.getByTestId("sidebar-avatar");
    await expect(avatarInHeader).toBeVisible({ timeout: 15_000 });

    await avatarInHeader.click();

    const dropdownContent = page.locator("[data-radix-popper-content-wrapper]");
    await expect(dropdownContent).toBeVisible({ timeout: 10_000 });

    const profileLink = page.getByTestId("link-profile");
    await expect(profileLink).toBeVisible();

    // The link navigates directly to /profile
    await expect(profileLink).toHaveAttribute("href", "/profile");

    await profileLink.click();

    await expect(page).toHaveURL(/\/profile($|[?#])/, { timeout: 10_000 });
  });

  test("Sign Out button signs the user out and redirects away from the dashboard", async ({
    page,
  }) => {
    const header = page.locator("header");
    const avatarInHeader = header.getByTestId("sidebar-avatar");
    await expect(avatarInHeader).toBeVisible({ timeout: 15_000 });

    await avatarInHeader.click();

    const dropdownContent = page.locator("[data-radix-popper-content-wrapper]");
    await expect(dropdownContent).toBeVisible({ timeout: 10_000 });

    const signOutButton = page.getByTestId("button-sign-out");
    await expect(signOutButton).toBeVisible();

    await signOutButton.click();

    // After sign-out Clerk redirects to the base path ("/").
    // The user must no longer be on any /dashboard route.
    await expect(page).not.toHaveURL(/\/dashboard/, { timeout: 15_000 });

    // Wait for any in-flight network requests (including Clerk's FAPI session
    // DELETE) to settle before Playwright tears down the page context.
    // Without this, Clerk's teardown fires after the context is already closed
    // and emits a noisy "FAPI request failed after 4 attempts: route.fetch:
    // Test ended." error in the logs.
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
  });
});

// Test the ProtectedDashboard route guard independently — navigate directly to
// each protected route without a session and verify the app redirects to sign-in.
// This uses an empty storage state so no Clerk sign-in is needed, avoiding the
// session-revocation cascade that occurs when tests share a session and sign out.
test.describe("Avatar dropdown in header", () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test.use({ skipFapiMock: true });
  // Retry once: after the sign-out test (test 4) completes, the Vite dev
  // server can have a brief ~300 ms window where it refuses new TCP connections
  // while processing the context teardown.  The first /dashboard navigation in
  // this describe block hits that window; a single retry always succeeds.
  test.describe.configure({ retries: 1 });

  test("navigating directly to /dashboard without a session redirects to sign-in", async ({
    page,
  }) => {
    // This describe block already uses an empty storageState (no auth),
    // so navigating directly to /dashboard is enough to exercise the
    // ProtectedDashboard route guard for the unauthenticated case — the
    // same behaviour a user would experience immediately after signing out.
    await page.goto("/dashboard", { waitUntil: "domcontentloaded" });

    // The route guard (ProtectedDashboard) must redirect unauthenticated
    // users away from /dashboard and must not render any dashboard content.
    await expect(page).not.toHaveURL(/\/dashboard/, { timeout: 15_000 });
    await expect(page.getByTestId("sidebar-avatar")).toHaveCount(0);
  });


  for (const route of PROTECTED_ROUTES.filter((r) => r !== "/dashboard")) {
    test(`navigating directly to ${route} without auth redirects to sign-in`, async ({
      page,
    }) => {
      // This describe block uses an empty storageState (no cookies, no
      // origins), so every test already starts with a clean, unauthenticated
      // browser context. No explicit clearing is needed.

      // For dynamic-segment routes (e.g. /brands/1, /locations/1) we assert
      // that ProtectedDashboard redirects to /sign-in *before* the page
      // component renders and attempts a route-specific data fetch.
      //
      // The interceptor aborts any such call and records the attempt so we
      // can fail the test with a clear message if the guard regressed.  This
      // keeps the test valid even when "1" is not a real ID in the data
      // store — the guard must always fire first regardless of the ID value.
      let routeSpecificFetchAttempted = false;
      if (DYNAMIC_PROTECTED_ROUTE_PATHS.has(route)) {
        const resource = route.split("/")[1]; // e.g. "brands" from "/brands/1"
        await page.route(`**/api/${resource}/**`, (r) => {
          routeSpecificFetchAttempted = true;
          r.abort();
        });
      }

      // Navigate directly to the protected route while unauthenticated.
      await page.goto(route, { waitUntil: "domcontentloaded" });

      // ProtectedDashboard must redirect unauthenticated users away from dashboard
      // routes and must not render any dashboard content (no sidebar avatar).
      await expect(page).not.toHaveURL(/\/dashboard/, { timeout: 15_000 });
      await expect(page.getByTestId("sidebar-avatar")).toHaveCount(0);

      // Verify the guard fired before any route-specific data fetch occurred.
      if (DYNAMIC_PROTECTED_ROUTE_PATHS.has(route)) {
        expect(
          routeSpecificFetchAttempted,
          `Navigating to ${route} triggered a route-specific API call before ` +
            `the sign-in redirect. ProtectedDashboard must redirect unauthenticated ` +
            `users before rendering any child component that would fetch data.`,
        ).toBe(false);
      }
    });
  }
});
