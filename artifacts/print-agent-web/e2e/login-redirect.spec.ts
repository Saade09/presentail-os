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

function pmUsersResponse() {
  return {
    members: [
      {
        id: 2,
        email: "pm@example.com",
        role: "member",
        custom_role_id: 10,
        role_name: "Project Manager",
        joined: true,
        joined_at: new Date().toISOString(),
        invited_at: new Date().toISOString(),
        invited_by_email: OWNER_EMAIL,
        manager_member_id: null,
        manager_email: null,
      },
    ],
    me: {
      role: "member",
      email: "pm@example.com",
      allowedPages: ["project-manager-dashboard"],
      customRoleId: 10,
    },
  };
}

/**
 * Collect distinct URL pathnames navigated to by the main frame between
 * page.goto(startPath) and the page settling on finalUrlPattern.
 *
 * Returns the ordered list of unique pathnames so callers can assert both the
 * correct final destination and the absence of unwanted intermediate stops.
 */
async function collectNavHops(
  page: import("@playwright/test").Page,
  startPath: string,
  finalUrlPattern: RegExp,
  timeoutMs = 12_000,
): Promise<string[]> {
  const hops: string[] = [];

  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) {
      try {
        const pathname = new URL(frame.url()).pathname;
        if (hops[hops.length - 1] !== pathname) {
          hops.push(pathname);
        }
      } catch {
        // ignore non-parseable frames (about:blank etc.)
      }
    }
  });

  await page.goto(startPath, { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(finalUrlPattern, { timeout: timeoutMs });

  return hops;
}

test.describe("Login redirect — signed out", () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test.use({ skipFapiMock: true });

  test("visiting / while signed out shows the Home page with no redirect", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });

    // Home page content must be visible — wait for full render
    await expect(
      page.getByRole("heading", {
        level: 1,
        name: /Your entire operation,\s*under control/i,
      }),
    ).toBeVisible({ timeout: 8_000 });

    // Once the page has rendered, the pathname must still be "/" — no redirect fired
    const url = new URL(page.url());
    expect(url.pathname, `Expected pathname "/", got "${url.pathname}"`).toBe("/");
  });
});

test.describe("Login redirect — no workspace access", () => {
  test(
    "signed-in user whose /api/users returns 403 no_access sees the NoAccess page and does not redirect",
    async ({ page }) => {
      await setupClerkTestingToken({ page });

      await page.route("**/api/users**", async (route) => {
        await route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({ error: "no_access" }),
        });
      });

      // NoAccess page calls this on mount; stub it so no network error is thrown
      await page.route("**/api/request-access/status**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ requested: false }),
        });
      });

      await page.goto("/devices", { waitUntil: "domcontentloaded" });

      // The NoAccess page must appear — no blank screen, no infinite redirect
      await expect(
        page.getByRole("heading", { level: 1, name: /Access restricted/i }),
      ).toBeVisible({ timeout: 12_000 });

      // The page must stay on the current path and not have redirected away
      const url = new URL(page.url());
      expect(
        url.pathname,
        `Expected to stay on /devices, got "${url.pathname}"`,
      ).toBe("/devices");
    },
  );
});

test.describe("NoAccess page — Request Access button", () => {
  async function goToNoAccessPage(page: import("@playwright/test").Page) {
    await setupClerkTestingToken({ page });

    await page.route("**/api/users**", async (route) => {
      await route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ error: "no_access" }),
      });
    });

    await page.route("**/api/request-access/status**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ requested: false }),
      });
    });

    await page.goto("/devices", { waitUntil: "domcontentloaded" });

    await expect(
      page.getByRole("heading", { level: 1, name: /Access restricted/i }),
    ).toBeVisible({ timeout: 12_000 });
  }

  test(
    "clicking 'Request Access' on a 200 response changes the button to 'Request sent!'",
    async ({ page }) => {
      await goToNoAccessPage(page);

      await page.route("**/api/request-access**", async (route) => {
        if (route.request().method() === "POST") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ ok: true }),
          });
        } else {
          await route.continue();
        }
      });

      const button = page.getByRole("button", { name: "Request Access" });
      await expect(button).toBeEnabled({ timeout: 5_000 });
      await button.click();

      await expect(
        page.getByRole("button", { name: "Request sent!" }),
      ).toBeVisible({ timeout: 5_000 });

      await expect(
        page.getByRole("button", { name: "Request sent!" }),
      ).toBeDisabled();
    },
  );

  test(
    "button shows 'Request sent!' and is disabled on load when status endpoint returns { requested: true }",
    async ({ page }) => {
      await setupClerkTestingToken({ page });

      await page.route("**/api/users**", async (route) => {
        await route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({ error: "no_access" }),
        });
      });

      // Simulate the user having already submitted a request in a previous session
      await page.route("**/api/request-access/status**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ requested: true }),
        });
      });

      await page.goto("/devices", { waitUntil: "domcontentloaded" });

      await expect(
        page.getByRole("heading", { level: 1, name: /Access restricted/i }),
      ).toBeVisible({ timeout: 12_000 });

      // The button must show "Request sent!" immediately — no click required
      const button = page.getByRole("button", { name: "Request sent!" });
      await expect(button).toBeVisible({ timeout: 5_000 });
      await expect(button).toBeDisabled();
    },
  );

  test(
    "clicking 'Request Access' on a 409 response shows 'Request sent!' and the already-requested helper text",
    async ({ page }) => {
      await goToNoAccessPage(page);

      await page.route("**/api/request-access**", async (route) => {
        if (route.request().method() === "POST") {
          await route.fulfill({
            status: 409,
            contentType: "application/json",
            body: JSON.stringify({ error: "already_requested" }),
          });
        } else {
          await route.continue();
        }
      });

      const button = page.getByRole("button", { name: "Request Access" });
      await expect(button).toBeEnabled({ timeout: 5_000 });
      await button.click();

      await expect(
        page.getByRole("button", { name: "Request sent!" }),
      ).toBeVisible({ timeout: 5_000 });

      await expect(
        page.getByRole("button", { name: "Request sent!" }),
      ).toBeDisabled();

      await expect(
        page.getByText(
          /You've already requested access/i,
        ),
      ).toBeVisible({ timeout: 5_000 });
    },
  );

  test(
    "clicking 'Request Access' on a 500 response shows the error message and re-enables the button",
    async ({ page }) => {
      await goToNoAccessPage(page);

      await page.route("**/api/request-access**", async (route) => {
        if (route.request().method() === "POST") {
          await route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ error: "internal_server_error" }),
          });
        } else {
          await route.continue();
        }
      });

      const button = page.getByRole("button", { name: "Request Access" });
      await expect(button).toBeEnabled({ timeout: 5_000 });
      await button.click();

      await expect(
        page.getByText("Something went wrong. Please try again."),
      ).toBeVisible({ timeout: 5_000 });

      await expect(
        page.getByRole("button", { name: "Request Access" }),
      ).toBeEnabled({ timeout: 5_000 });
    },
  );

  test(
    "clicking 'Request Access' again after a 500 error succeeds on retry",
    async ({ page }) => {
      await goToNoAccessPage(page);

      let postCount = 0;
      await page.route("**/api/request-access**", async (route) => {
        if (route.request().method() === "POST") {
          postCount += 1;
          if (postCount === 1) {
            await route.fulfill({
              status: 500,
              contentType: "application/json",
              body: JSON.stringify({ error: "internal_server_error" }),
            });
          } else {
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({ ok: true }),
            });
          }
        } else {
          await route.continue();
        }
      });

      const button = page.getByRole("button", { name: "Request Access" });
      await expect(button).toBeEnabled({ timeout: 5_000 });
      await button.click();

      await expect(
        page.getByText("Something went wrong. Please try again."),
      ).toBeVisible({ timeout: 5_000 });

      const retryButton = page.getByRole("button", { name: "Request Access" });
      await expect(retryButton).toBeEnabled({ timeout: 5_000 });
      await retryButton.click();

      await expect(
        page.getByRole("button", { name: "Request sent!" }),
      ).toBeVisible({ timeout: 5_000 });

      await expect(
        page.getByRole("button", { name: "Request sent!" }),
      ).toBeDisabled();
    },
  );
});

test.describe("Login redirect — signed in", () => {
  test(
    "owner visiting / lands on /devices with no intermediate /dashboard detour",
    async ({ page }) => {
      await setupClerkTestingToken({ page });

      await page.route("**/api/users**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(ownerUsersResponse()),
        });
      });

      await page.route("**/api/devices**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ devices: [] }),
        });
      });

      // HomeRedirect redirects signed-in owners to /devices (not via /dashboard)
      const hops = await collectNavHops(page, "/", /\/devices$/);

      // Final destination reached and rendered
      await expect(
        page.getByRole("heading", { name: "Devices" }),
      ).toBeVisible({ timeout: 8_000 });

      // Navigation must only pass through "/" and "/devices" — no bare "/dashboard"
      // intermediate that would indicate the old pre-simplification detour is back.
      const unexpectedHops = hops.filter(
        (p) => p !== "/" && !/\/devices$/.test(p),
      );
      expect(
        unexpectedHops,
        `Unexpected intermediate navigation stops: ${JSON.stringify(hops)}`,
      ).toHaveLength(0);
    },
  );

  test(
    "signed-in owner visiting /sign-in is redirected away to /devices",
    async ({ page }) => {
      await setupClerkTestingToken({ page });

      await page.route("**/api/users**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(ownerUsersResponse()),
        });
      });

      await page.route("**/api/devices**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ devices: [] }),
        });
      });

      // SignInPage redirects signed-in users to "/" which then sends owners to /devices
      await page.goto("/sign-in", { waitUntil: "domcontentloaded" });
      await expect(page).toHaveURL(/\/devices$/, { timeout: 12_000 });

      // Must never stay on /sign-in
      const url = new URL(page.url());
      expect(
        url.pathname,
        `Expected to leave /sign-in but stayed at "${url.pathname}"`,
      ).not.toMatch(/\/sign-in/);
    },
  );

  test(
    "project-manager-only user visiting / lands on /project-manager-dashboard with no intermediate /dashboard detour",
    async ({ page }) => {
      await setupClerkTestingToken({ page });

      await page.route("**/api/users**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(pmUsersResponse()),
        });
      });

      await page.route("**/api/dashboard/summary**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            total_brands: 0,
            total_locations: 0,
            total_channels: 0,
            products_available: 0,
            products_out_of_stock: 0,
            products_not_available: 0,
          }),
        });
      });

      // HomeRedirect redirects PM-only members to /project-manager-dashboard
      const hops = await collectNavHops(
        page,
        "/",
        /\/project-manager-dashboard$/,
      );

      // Final destination reached and rendered with the PM dashboard heading
      await expect(
        page.getByRole("heading", { level: 1, name: "Dashboard" }),
      ).toBeVisible({ timeout: 8_000 });

      // Navigation must only pass through "/" and "/project-manager-dashboard"
      const unexpectedHops = hops.filter(
        (p) => p !== "/" && !/\/project-manager-dashboard$/.test(p),
      );
      expect(
        unexpectedHops,
        `Unexpected intermediate navigation stops: ${JSON.stringify(hops)}`,
      ).toHaveLength(0);
    },
  );
});
