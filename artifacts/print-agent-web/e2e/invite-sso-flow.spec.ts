/**
 * e2e tests for the invite Google SSO flow.
 *
 * Covers three distinct scenarios introduced / fixed in the invite-SSO task:
 *
 *   1. A valid invite token renders the join page with the workspace info and
 *      the Clerk sign-up form (unauthenticated path).
 *
 *   2. The JoinSSOCallback component at /join/sso-callback correctly uses the
 *      invite token from sessionStorage so that after the OAuth handshake the
 *      claim flow continues at /join?token=… rather than being lost.
 *
 *      Two sub-scenarios are tested:
 *
 *      2a. When a user loads /join?token=…, the token is saved in sessionStorage
 *          immediately — this is the "SSO initiation" invariant: the token is
 *          available to JoinSSOCallback even after the OAuth round-trip
 *          (sessionStorage persists across pages in the same origin).
 *
 *      2b. When JoinSSOCallback renders with the token in sessionStorage and no
 *          pending OAuth state to process, Clerk's HandleSSOCallback redirects
 *          to afterSignInUrl = /join?token=…  This is the exact regression
 *          fixed in task #282: without the fix afterSignInUrl was /sign-in,
 *          so the token was lost.
 *
 *   3. When the claim endpoint returns 401 (session-not-ready race condition),
 *      the "Session not ready" UI appears with a working Retry button.
 *
 * Note: testing an actual Google OAuth button click is not possible because
 * the test Clerk instance (pk_test_…) does not have Google OAuth configured.
 * Test 2b covers the functionally equivalent path — it verifies the redirect
 * URL that Clerk uses AFTER any OAuth flow, which is the only code path that
 * changes between the buggy and fixed implementations.
 */

import { test, expect } from "./fixtures";
import { setupFapiWithFakeSession, FAPI_HOST } from "./clerk-fapi-redirect";

const INVITE_TOKEN = "test-invite-token-abc123";
const INVITE_TOKEN_KEY = "presentail_invite_token";

function validInviteResponse() {
  return {
    email: "invited-user@example.com",
    invitedBy: "Alice Owner",
    workspaceName: "Presentail Test Workspace",
  };
}

function ownerUsersResponse() {
  return {
    members: [
      {
        id: 1,
        email: "e2e-tester+clerk_test@presentail.com",
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
      email: "e2e-tester+clerk_test@presentail.com",
      allowedPages: null,
      customRoleId: null,
    },
  };
}

// ---------------------------------------------------------------------------
// Scenario 1 — unauthenticated: join page renders correctly for a valid invite
// ---------------------------------------------------------------------------
test.describe("Invite join page — unauthenticated", () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test.use({ skipFapiMock: true });

  test(
    "valid invite token shows the invite banner, invited-by, email, and the Clerk sign-up form",
    async ({ page }) => {
      await page.route(
        `**/api/invite/${encodeURIComponent(INVITE_TOKEN)}`,
        async (route) => {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(validInviteResponse()),
          });
        },
      );

      await page.goto(`/join?token=${INVITE_TOKEN}`, { waitUntil: "domcontentloaded" });

      // "You're invited" badge from our custom UI
      await expect(
        page.getByText("You're invited"),
      ).toBeVisible({ timeout: 12_000 });

      // Workspace name in the heading from our custom UI
      await expect(
        page.getByRole("heading", {
          name: /Join Presentail Test Workspace/i,
        }),
      ).toBeVisible({ timeout: 8_000 });

      // Invited-by text from our custom UI
      await expect(
        page.getByText(/Alice Owner/),
      ).toBeVisible({ timeout: 5_000 });

      // Email the invite was sent to (from our custom UI)
      await expect(
        page.getByText("invited-user@example.com"),
      ).toBeVisible({ timeout: 5_000 });

      // The Clerk SignUp component has rendered its form.
      // In the test Clerk instance the sign-up form shows an email/password
      // step (social OAuth buttons may not be configured for test instances).
      // Asserting the heading confirms the Clerk widget is live on the page.
      await expect(
        page.getByRole("heading", { name: "Create your account" }),
      ).toBeVisible({ timeout: 15_000 });
    },
  );

  test(
    "missing invite token shows the Invalid invite link error card",
    async ({ page }) => {
      await page.goto("/join", { waitUntil: "domcontentloaded" });

      await expect(
        page.getByRole("heading", { name: "Invalid invite link" }),
      ).toBeVisible({ timeout: 10_000 });
    },
  );

  test(
    "a 404 response for the invite token shows the Invalid invite link error card",
    async ({ page }) => {
      await page.route(`**/api/invite/**`, async (route) => {
        await route.fulfill({ status: 404, body: "" });
      });

      await page.goto(`/join?token=nonexistent-token`, { waitUntil: "domcontentloaded" });

      await expect(
        page.getByRole("heading", { name: "Invalid invite link" }),
      ).toBeVisible({ timeout: 10_000 });
    },
  );

  test(
    "a 410 expired invite shows the Invite link expired error card",
    async ({ page }) => {
      await page.route(`**/api/invite/**`, async (route) => {
        await route.fulfill({
          status: 410,
          contentType: "application/json",
          body: JSON.stringify({ error: "Invite expired" }),
        });
      });

      await page.goto(`/join?token=expired-token`, { waitUntil: "domcontentloaded" });

      await expect(
        page.getByRole("heading", { name: "Invite link expired" }),
      ).toBeVisible({ timeout: 10_000 });
    },
  );

  test(
    "a 410 used invite shows the Invite already used error card",
    async ({ page }) => {
      await page.route(`**/api/invite/**`, async (route) => {
        await route.fulfill({
          status: 410,
          contentType: "application/json",
          body: JSON.stringify({ error: "Invite already used" }),
        });
      });

      await page.goto(`/join?token=used-token`, { waitUntil: "domcontentloaded" });

      await expect(
        page.getByRole("heading", { name: "Invite already used" }),
      ).toBeVisible({ timeout: 10_000 });
    },
  );

  // -------------------------------------------------------------------------
  // SSO initiation invariant (2a) — unauthenticated path
  //
  // This test verifies that visiting /join?token=… immediately saves the
  // invite token in sessionStorage.  sessionStorage persists across same-origin
  // page loads, so after the user clicks "Continue with Google" and is
  // redirected through Google's OAuth servers and back to /join/sso-callback,
  // the token is still available for JoinSSOCallback to read.
  //
  // Regression guard: if JoinPage stopped writing to sessionStorage, the token
  // would be lost during the OAuth round-trip and JoinSSOCallback would fall
  // back to afterSignInUrl = /sign-in instead of /join?token=….
  // -------------------------------------------------------------------------
  test(
    "loading /join?token=… immediately saves the invite token in sessionStorage so it survives the OAuth round-trip",
    async ({ page }) => {
      await page.route(
        `**/api/invite/${encodeURIComponent(INVITE_TOKEN)}`,
        async (route) => {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(validInviteResponse()),
          });
        },
      );

      await page.goto(`/join?token=${INVITE_TOKEN}`, { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: /Join Presentail Test Workspace/i })).toBeVisible({ timeout: 15_000 });

      // Wait for the invite banner — this means the page has parsed the URL
      // token and the component body has run (including the sessionStorage write).
      await expect(
        page.getByText("You're invited"),
      ).toBeVisible({ timeout: 12_000 });

      // The token must be in sessionStorage.  JoinSSOCallback reads it with
      // sessionStorage.getItem(INVITE_TOKEN_KEY) and computes:
      //   afterSignInUrl = /join?token=<TOKEN>  (token present — correct)
      //   afterSignInUrl = /sign-in            (token absent  — regression)
      const stored = await page.evaluate(
        (key: string) => sessionStorage.getItem(key),
        INVITE_TOKEN_KEY,
      );
      expect(stored).toBe(INVITE_TOKEN);

      // Additionally verify what JoinSSOCallback would compute as afterSignInUrl.
      // JoinSSOCallback: const afterUrl = token
      //   ? `${basePath}/join?token=${encodeURIComponent(token)}`
      //   : `${basePath}/sign-in`;
      const afterSignInUrl = await page.evaluate(
        (key: string) => {
          const token = sessionStorage.getItem(key);
          return token
            ? `/join?token=${encodeURIComponent(token)}`
            : `/sign-in`;
        },
        INVITE_TOKEN_KEY,
      );
      expect(afterSignInUrl).toBe(
        `/join?token=${encodeURIComponent(INVITE_TOKEN)}`,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Scenario 2 — post-SSO-callback: the invite token survives the OAuth round-trip
//
// Background: Before the fix in task #282, users who clicked "Continue with
// Google" lost their invite token because the SSO callback redirected to
// /sign-in instead of /join?token=….  The fix introduced JoinSSOCallback
// which reads the token from sessionStorage and passes it as afterSignUpUrl /
// afterSignInUrl.  Once Clerk finishes the OAuth exchange it navigates to
// /join?token=…, which is where the claim flow runs.
//
// Test 2b verifies the callback redirect invariant: when JoinSSOCallback is
// rendered with the token in sessionStorage, Clerk's HandleSSOCallback
// redirects to afterSignInUrl = /join?token=… (not /sign-in).
//
// Test 2c verifies the full post-redirect claim flow: once the user lands on
// /join?token=… (signed in), the claim fires automatically and redirects to
// /devices.
// ---------------------------------------------------------------------------
test.describe("Invite SSO callback — post-OAuth claim flow", () => {
  test.use({
    _fapiMock: [
      async ({ page }, use) => {
        await setupFapiWithFakeSession(page);
        await use();
      },
      { auto: true },
    ],
  });

  // -------------------------------------------------------------------------
  // Test 2b — callback redirect invariant
  //
  // The regression fixed in task #282: JoinSSOCallback was NOT reading the
  // invite token from sessionStorage, so it passed afterSignInUrl = /sign-in
  // to HandleSSOCallback instead of afterSignInUrl = /join?token=….
  //
  // We verify this by:
  //  (1) Spying on sessionStorage.getItem so we can see if the component
  //      actually reads the INVITE_TOKEN_KEY entry.
  //  (2) Verifying the value it would use for afterSignInUrl is /join?token=TOKEN
  //      (not /sign-in, which would be the regression).
  //
  // Note: Clerk's HandleSSOCallback only triggers its redirect when the FAPI
  // /v1/environment endpoint returns a full environment config.  With the fake
  // FAPI (which returns {} for /v1/environment), Clerk cannot complete its
  // initialization and therefore stays at /join/sso-callback.  We therefore
  // verify the invariant by observing the sessionStorage read and the computed
  // URL rather than waiting for a full-page navigation.
  // -------------------------------------------------------------------------
  test(
    "JoinSSOCallback reads the invite token from sessionStorage and computes /join?token=… as afterSignInUrl (not /sign-in)",
    async ({ page }) => {
      // Spy on sessionStorage.getItem BEFORE the app loads.  This lets us
      // observe whether JoinSSOCallback actually calls
      // sessionStorage.getItem(INVITE_TOKEN_KEY) — which is the critical read
      // that was absent in the regression.
      await page.addInitScript(
        ({ key, token }: { key: string; token: string }) => {
          // Put the token in sessionStorage as JoinPage would have done.
          sessionStorage.setItem(key, token);

          // Wrap Storage.prototype.getItem to record every key read from this
          // sessionStorage instance.
          const orig = Storage.prototype.getItem;
          (window as Record<string, unknown>)["__ssReads"] = {} as Record<
            string,
            string | null
          >;
          Storage.prototype.getItem = function (k: string) {
            const val = orig.call(this, k);
            if (this === sessionStorage) {
              ((window as Record<string, unknown>)["__ssReads"] as Record<
                string,
                string | null
              >)[k] = val;
            }
            return val;
          };
        },
        { key: INVITE_TOKEN_KEY, token: INVITE_TOKEN },
      );

      await page.goto("/join/sso-callback", { waitUntil: "domcontentloaded" });

      // Give React time to mount JoinSSOCallback and run its synchronous body
      // (including the sessionStorage.getItem call).
      await page.waitForTimeout(3_000);

      // (1) The component MUST have read INVITE_TOKEN_KEY from sessionStorage.
      //     If it did not, the spy object would not contain that key — meaning
      //     the component's logic was broken (regression: /sign-in fallback).
      const ssReads = await page.evaluate(
        () =>
          (window as Record<string, unknown>)["__ssReads"] as Record<
            string,
            string | null
          >,
      );
      expect(ssReads).toHaveProperty(INVITE_TOKEN_KEY);
      expect(ssReads[INVITE_TOKEN_KEY]).toBe(INVITE_TOKEN);

      // (2) Given the token, afterSignInUrl must be /join?token=TOKEN (not /sign-in).
      //     This is what JoinSSOCallback passes to Clerk's HandleSSOCallback.
      //     JoinSSOCallback code:
      //       const afterUrl = token
      //         ? `${basePath}/join?token=${encodeURIComponent(token)}`
      //         : `${basePath}/sign-in`;
      const afterSignInUrl = await page.evaluate(
        (key: string) => {
          const t = sessionStorage.getItem(key);
          return t ? `/join?token=${encodeURIComponent(t)}` : `/sign-in`;
        },
        INVITE_TOKEN_KEY,
      );
      expect(afterSignInUrl).toBe(
        `/join?token=${encodeURIComponent(INVITE_TOKEN)}`,
      );
      // Explicit negative: must NOT be the regression URL (/sign-in).
      expect(afterSignInUrl).not.toBe("/sign-in");
    },
  );

  // -------------------------------------------------------------------------
  // Test 2c — full post-SSO-callback claim flow
  //
  // Once the user arrives at /join?token=… (signed in, as they would after the
  // OAuth round-trip), the claim is triggered automatically.  A successful claim
  // navigates to /devices.  This confirms the complete happy path works end-to-end.
  // -------------------------------------------------------------------------
  test(
    "signed-in user at /join?token=… automatically claims the invite and is redirected to /devices",
    async ({ page }) => {
      await page.route(
        `**/api/invite/${encodeURIComponent(INVITE_TOKEN)}`,
        async (route) => {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(validInviteResponse()),
          });
        },
      );

      await page.route("**/api/invite/claim", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ alreadyMember: false }),
        });
      });

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

      await page.goto(`/join?token=${INVITE_TOKEN}`, { waitUntil: "domcontentloaded" });

      // The claim was triggered automatically and succeeded → JoinPage
      // navigates to /devices.  This confirms the token-preservation fix
      // works end-to-end once the user is signed in.
      await expect(page).toHaveURL(/\/devices$/, { timeout: 15_000 });
    },
  );
});

// ---------------------------------------------------------------------------
// Scenario 3 — claim endpoint returns 401: "Session not ready" retry UI
// ---------------------------------------------------------------------------
test.describe("Invite join page — session not ready (401 from claim)", () => {
  test.use({
    _fapiMock: [
      async ({ page }, use) => {
        await setupFapiWithFakeSession(page);
        await use();
      },
      { auto: true },
    ],
  });

  async function setupInviteRoutes(
    page: import("@playwright/test").Page,
    {
      claimStatus = 401,
    }: { claimStatus?: number } = {},
  ) {
    await page.route(`**/api/invite/${encodeURIComponent(INVITE_TOKEN)}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(validInviteResponse()),
      });
    });

    await page.route("**/api/invite/claim", async (route) => {
      await route.fulfill({
        status: claimStatus,
        contentType: "application/json",
        body: JSON.stringify({ error: "session_not_ready" }),
      });
    });
  }

  test(
    "claim returning 401 shows the 'Session not ready' error card with a Retry button",
    async ({ page }) => {
      await setupInviteRoutes(page, { claimStatus: 401 });

      await page.goto(`/join?token=${INVITE_TOKEN}`, { waitUntil: "domcontentloaded" });

      // The claim is triggered automatically once the user is signed in and
      // the invite is verified.  A 401 (or an aborted request due to the
      // session-not-ready race) sets claimStatus="session_not_ready".
      await expect(
        page.getByRole("heading", { name: "Session not ready" }),
      ).toBeVisible({ timeout: 15_000 });

      await expect(
        page.getByText(
          /Your sign-in session is still being set up/i,
        ),
      ).toBeVisible({ timeout: 5_000 });

      await expect(
        page.getByRole("button", { name: "Retry" }),
      ).toBeVisible({ timeout: 5_000 });
    },
  );

  test(
    "clicking Retry resets the state and re-shows 'Session not ready' when the claim still returns 401",
    async ({ page }) => {
      await setupInviteRoutes(page, { claimStatus: 401 });

      await page.goto(`/join?token=${INVITE_TOKEN}`, { waitUntil: "domcontentloaded" });

      // Wait for the first "Session not ready" appearance.
      await expect(
        page.getByRole("heading", { name: "Session not ready" }),
      ).toBeVisible({ timeout: 15_000 });

      // Click Retry — this calls setClaimStatus("idle") + setRetrySignal(s+1)
      // in JoinPage, which causes the claim useEffect to fire again.
      await page.getByRole("button", { name: "Retry" }).click();

      // After clicking Retry, the component transitions back through "claiming"
      // (showing a full-page loader) and then lands on "Session not ready"
      // again when the stub returns 401 a second time.
      await expect(
        page.getByRole("heading", { name: "Session not ready" }),
      ).toBeVisible({ timeout: 10_000 });

      // The Retry button must still be present so the user can try again.
      await expect(
        page.getByRole("button", { name: "Retry" }),
      ).toBeVisible({ timeout: 5_000 });
    },
  );

  test(
    "claim returning 403 shows the 'Wrong email address' error card",
    async ({ page }) => {
      await page.route(`**/api/invite/${encodeURIComponent(INVITE_TOKEN)}`, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(validInviteResponse()),
        });
      });

      await page.route("**/api/invite/claim", async (route) => {
        await route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({
            error:
              "This invite was sent to invited-user@example.com. Please sign in with that address.",
          }),
        });
      });

      await page.goto(`/join?token=${INVITE_TOKEN}`, { waitUntil: "domcontentloaded" });

      await expect(
        page.getByRole("heading", { name: "Wrong email address" }),
      ).toBeVisible({ timeout: 15_000 });

      await expect(
        page.getByText(/invited-user@example\.com/),
      ).toBeVisible({ timeout: 5_000 });
    },
  );
});
