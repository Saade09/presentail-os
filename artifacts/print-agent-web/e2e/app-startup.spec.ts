import { test, expect } from "./fixtures";
import { setupClerkTestingToken } from "@clerk/testing/playwright";

/**
 * App startup smoke tests.
 *
 * These tests verify the Presentail OS app loads without runtime crashes on
 * startup. They specifically guard against regressions like the
 * Clerk/React duplicate-instance crash (TypeError: Cannot read properties of
 * null) which was previously caught only manually.
 *
 * All tests in this file run without an authenticated session so they can
 * observe the raw boot sequence and sign-in screen rendering.
 */
test.describe("App startup — no crash on load", () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test.use({ skipFapiMock: true });

  test("navigating to / produces no uncaught TypeError in the browser console", async ({
    page,
  }) => {
    const typeErrors: string[] = [];

    page.on("pageerror", (err) => {
      if (err instanceof Error && err.name === "TypeError") {
        typeErrors.push(err.message);
      } else if (err.message?.includes("TypeError")) {
        typeErrors.push(err.message);
      }
    });

    page.on("console", (msg) => {
      if (msg.type() === "error") {
        const text = msg.text();
        if (text.includes("TypeError")) {
          typeErrors.push(text);
        }
      }
    });

    await page.goto("/", { waitUntil: "domcontentloaded" });

    // Wait for the page to fully settle — the homepage heading is the
    // canonical signal that the app has booted and React has hydrated.
    await expect(
      page.getByRole("heading", {
        level: 1,
        name: /Your entire operation,\s*under control/i,
      }),
    ).toBeVisible({ timeout: 15_000 });

    expect(
      typeErrors,
      `Unexpected TypeError(s) in the browser console:\n${typeErrors.join("\n")}`,
    ).toHaveLength(0);
  });

  test("navigating to /sign-in produces no uncaught TypeError and renders the sign-in UI", async ({
    page,
  }) => {
    const typeErrors: string[] = [];

    page.on("pageerror", (err) => {
      if (err instanceof Error && err.name === "TypeError") {
        typeErrors.push(err.message);
      } else if (err.message?.includes("TypeError")) {
        typeErrors.push(err.message);
      }
    });

    page.on("console", (msg) => {
      if (msg.type() === "error") {
        const text = msg.text();
        if (text.includes("TypeError")) {
          typeErrors.push(text);
        }
      }
    });

    await page.goto("/sign-in", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15_000 });

    // Clerk renders its sign-in widget; "Continue with Google" is the first
    // visible interactive element after a successful boot with no crash.
    await expect(
      page.getByText("Continue with Google"),
    ).toBeVisible({ timeout: 15_000 });

    expect(
      typeErrors,
      `Unexpected TypeError(s) in the browser console:\n${typeErrors.join("\n")}`,
    ).toHaveLength(0);
  });

  test("the root page renders without a React error overlay", async ({
    page,
  }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });

    // Wait for the page to settle
    await expect(
      page.getByRole("heading", {
        level: 1,
        name: /Your entire operation,\s*under control/i,
      }),
    ).toBeVisible({ timeout: 15_000 });

    // React's error overlay (development mode) renders a full-screen div with
    // role="dialog" and the text "Unhandled Runtime Error". Assert it is absent.
    const errorOverlay = page.getByRole("dialog").filter({
      hasText: /Unhandled Runtime Error/i,
    });
    await expect(errorOverlay).toHaveCount(0);

    // Also check for the Vite/React error overlay element used in dev builds.
    const viteOverlay = page.locator("vite-error-overlay");
    await expect(viteOverlay).toHaveCount(0);
  });
});

/**
 * Signed-in dashboard boot smoke tests.
 *
 * These tests verify the authenticated dashboard shell loads without runtime
 * crashes. They guard against regressions in React contexts and data-fetching
 * hooks that only run after sign-in — failures that the signed-out tests above
 * cannot catch.
 */
test.describe("App startup — signed-in dashboard, no crash on load", () => {
  test(
    "navigating to /devices as a signed-in owner produces no uncaught TypeError and renders the dashboard shell",
    async ({ page }) => {
      await setupClerkTestingToken({ page });

      await page.route("**/api/users**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            members: [
              {
                id: 1,
                email: "e2e-tester@presentail.com",
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
              email: "e2e-tester@presentail.com",
              allowedPages: null,
              customRoleId: null,
            },
          }),
        });
      });

      await page.route("**/api/devices**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ devices: [] }),
        });
      });

      // Mock SSE/long-poll endpoints that hold connections open and prevent
      // "networkidle" from ever firing.
      await page.route("**/api/omnichannel/events**", async (route) => {
        await route.fulfill({ status: 200, contentType: "text/plain", body: "" });
      });
      await page.route("**/api/access-requests/events**", async (route) => {
        await route.fulfill({ status: 200, contentType: "text/plain", body: "" });
      });

      const typeErrors: string[] = [];

      page.on("pageerror", (err) => {
        if (err instanceof Error && err.name === "TypeError") {
          typeErrors.push(err.message);
        } else if (err.message?.includes("TypeError")) {
          typeErrors.push(err.message);
        }
      });

      page.on("console", (msg) => {
        if (msg.type() === "error") {
          const text = msg.text();
          if (text.includes("TypeError")) {
            typeErrors.push(text);
          }
        }
      });

      // Use "load" instead of "networkidle" — SSE streams would otherwise
      // keep the connection open indefinitely and cause a timeout. The heading
      // assertion below is the real signal that the page fully rendered.
      await page.goto("/devices", { waitUntil: "load" });

      // The Devices page heading is the canonical signal that the dashboard
      // shell has booted and React has fully hydrated.
      await expect(
        page.getByRole("heading", { name: "Devices" }),
      ).toBeVisible({ timeout: 15_000 });

      // The sidebar navigation must be present — assert a known nav link by
      // its data-testid so any crash in the layout/nav render is caught.
      await expect(page.getByTestId("nav-devices")).toBeVisible({
        timeout: 5_000,
      });

      expect(
        typeErrors,
        `Unexpected TypeError(s) in the browser console:\n${typeErrors.join("\n")}`,
      ).toHaveLength(0);

      // React's error overlay must be absent.
      const errorOverlay = page.getByRole("dialog").filter({
        hasText: /Unhandled Runtime Error/i,
      });
      await expect(errorOverlay).toHaveCount(0);

      // Vite dev error overlay must also be absent.
      const viteOverlay = page.locator("vite-error-overlay");
      await expect(viteOverlay).toHaveCount(0);
    },
  );
});
