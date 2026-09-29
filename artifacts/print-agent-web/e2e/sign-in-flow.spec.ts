/**
 * End-to-end sign-in flow spec.
 *
 * Verifies two things:
 *
 * 1. The Clerk sign-in widget renders on /sign-in — which proves the
 *    vendor-clerk chunk (@clerk/react + @clerk/themes) was loaded and
 *    initialized correctly.  A missing or mis-ordered vendor-clerk chunk
 *    causes Clerk.js to throw a TypeError before mounting, leaving the
 *    page blank or stuck at "Loading…".
 *
 * 2. The email OTP auth flow completes end-to-end: entering the
 *    "+clerk_test" email address, clicking through to the code step,
 *    entering the test OTP "424242" (accepted by Clerk's test instance for
 *    any "+clerk_test" email address), and landing on an authenticated
 *    dashboard page.
 *
 * These tests import directly from @playwright/test (not from ./fixtures)
 * because they exercise the unauthenticated → authenticated transition and
 * must NOT have the _fapiMock auto-fixture inject a pre-authenticated
 * session — that would bypass the sign-in UI entirely and defeat the point
 * of the test.
 *
 * setupFapiRedirect is used so that all Clerk FAPI calls (which the browser
 * would normally send to becoming-man-73.clerk.accounts.dev) are forwarded
 * via Node.js fetch with the __clerk_testing_token appended.  This bypasses
 * Cloudflare bot-protection that blocks headless Chromium, and is the same
 * mechanism used by the existing sign-in-ticket-error.spec.ts tests.
 */

// e2e-unauthenticated

import { test, expect } from "@playwright/test";
import { setupFapiRedirect } from "./clerk-fapi-redirect";

const TEST_USER_EMAIL = "e2e-tester+clerk_test@presentail.com";
const CLERK_TEST_OTP = "424242";

test.describe("Sign-in flow — vendor-clerk chunk + widget render", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test(
    "the Clerk sign-in widget loads on /sign-in with no TypeError (vendor-clerk chunk intact)",
    async ({ page }) => {
      await setupFapiRedirect(page);

      const typeErrors: string[] = [];
      page.on("pageerror", (err) => {
        if (err instanceof Error && err.name === "TypeError") {
          typeErrors.push(err.message);
        } else if (err.message?.includes("TypeError")) {
          typeErrors.push(err.message);
        }
      });
      page.on("console", (msg) => {
        if (msg.type() === "error" && msg.text().includes("TypeError")) {
          typeErrors.push(msg.text());
        }
      });

      await page.goto("/sign-in", { waitUntil: "domcontentloaded" });

      // The Clerk <SignIn> component renders a heading once it boots
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible({
        timeout: 15_000,
      });

      // "Continue with Google" is the first interactive element Clerk renders
      // when the vendor-clerk chunk is intact and the instance is reachable.
      // Its absence means the chunk failed to load or Clerk threw on init.
      await expect(
        page.getByText("Continue with Google"),
      ).toBeVisible({ timeout: 15_000 });

      // All three sign-in strategies must be present
      await expect(
        page.getByText("Continue with Email + Password"),
      ).toBeVisible({ timeout: 5_000 });

      await expect(
        page.getByText("Continue with Email (One-Time Code)"),
      ).toBeVisible({ timeout: 5_000 });

      // No TypeErrors: a missing vendor-clerk chunk or a mis-ordered module
      // graph throws a TypeError before the component mounts.
      expect(
        typeErrors,
        `Unexpected TypeError(s) in the browser console:\n${typeErrors.join("\n")}`,
      ).toHaveLength(0);
    },
  );
});

test.describe("Sign-in flow — OTP auth end-to-end", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test(
    "completing email OTP sign-in lands on the authenticated dashboard",
    async ({ page }) => {
      // Proxy all FAPI calls through Node.js fetch to bypass Cloudflare
      // bot-protection that blocks headless Chromium.
      await setupFapiRedirect(page);

      // Mock the API calls the dashboard shell makes immediately after sign-in.
      await page.route("**/api/users**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            members: [
              {
                id: 1,
                email: TEST_USER_EMAIL,
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
              email: TEST_USER_EMAIL,
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

      // Stub SSE endpoints so they don't keep the connection open indefinitely.
      await page.route("**/api/omnichannel/events**", async (route) => {
        await route.fulfill({ status: 200, contentType: "text/plain", body: "" });
      });
      await page.route("**/api/access-requests/events**", async (route) => {
        await route.fulfill({ status: 200, contentType: "text/plain", body: "" });
      });

      // 1. Navigate to the sign-in page (unauthenticated).
      await page.goto("/sign-in", { waitUntil: "domcontentloaded" });

      // Wait for the Clerk sign-in heading — confirms the widget is mounted.
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible({
        timeout: 15_000,
      });

      // Verify the OTP strategy option is visible before we try to interact.
      await expect(
        page.getByText("Continue with Email (One-Time Code)"),
      ).toBeVisible({ timeout: 15_000 });

      // 2. Choose "Email (One-Time Code)" strategy.
      await page.getByText("Continue with Email (One-Time Code)").click();

      // 3. Enter the test user's email address.
      //    "+clerk_test" in the address tells Clerk's test instance to accept
      //    the fixed OTP "424242" without sending a real email.
      const emailInput = page.getByLabel(/email address/i);
      await expect(emailInput).toBeVisible({ timeout: 8_000 });
      await emailInput.fill(TEST_USER_EMAIL);
      await page.getByRole("button", { name: /continue/i }).click();

      // 4. Wait for the OTP / verification-code step.
      //    Clerk renders the code field as 6 individual single-character inputs
      //    inside a fieldset, each with maxlength="1".  After clicking the
      //    first one the keyboard events auto-advance between inputs.
      const firstOtpInput = page.locator('input[maxlength="1"]').first();
      await expect(firstOtpInput).toBeVisible({ timeout: 15_000 });
      await firstOtpInput.click();

      // Type all 6 digits — Clerk auto-advances between the individual inputs.
      await page.keyboard.type(CLERK_TEST_OTP);

      // 5. Submit the OTP.  Clerk submits automatically once all 6 digits are
      //    entered, so an explicit button click may not be needed — but we wait
      //    for the URL to change as the authoritative success signal.
      // Allow some extra time for the sign-in to complete and the redirect to
      // the dashboard to settle.
      await expect(page).toHaveURL(/\/(devices|dashboard)/, {
        timeout: 20_000,
      });

      // 6. The Devices heading is the canonical proof that the authenticated
      //    dashboard shell rendered — not just a redirect to an auth wall.
      await expect(
        page.getByRole("heading", { name: "Devices" }),
      ).toBeVisible({ timeout: 10_000 });
    },
  );
});
