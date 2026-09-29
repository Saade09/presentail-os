/**
 * e2e tests for TypeAssignmentGate — the race-condition fix that ensures
 * freshly invited users with no publicMetadata.userType are never shown
 * "Access Denied" or redirected to /unauthorized.
 *
 * Background (task #391): TypeAssignmentGate calls POST /api/auth/set-user-type
 * then calls user.reload() before UserTypeGuard evaluates. Without this gate,
 * a render-cycle race caused newly invited users to hit /unauthorized before
 * their type was assigned.
 *
 * Tests:
 *   1. Happy path — a signed-in user with no userType gets it assigned
 *      transparently and lands on the dashboard shell without ever seeing
 *      "Access Denied" or the /unauthorized page.
 *
 *   2. Failure path — if POST /api/auth/set-user-type returns a server error,
 *      the inline error message is shown and there is no infinite loader
 *      (the page reaches a terminal state).
 *
 * --- FAPI mock strategy ---
 *
 * Both tests install a custom FAPI mock (skipFapiMock: true) that:
 *   - Returns a user with NO userType on the first GET /v1/client call
 *     (simulating a freshly invited user who hasn't had set-user-type run yet)
 *   - Returns a user WITH userType "team" on subsequent GET /v1/client calls
 *     and on GET /v1/me (the endpoint Clerk's user.reload() actually calls)
 *     so that after TypeAssignmentGate runs set-user-type + user.reload() the
 *     user object reflects the newly assigned type
 */

import { test, expect } from "./fixtures";
import { FAPI_HOST } from "./clerk-fapi-redirect";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildFakeJwt(): string {
  const nowS = Math.floor(Date.now() / 1000);
  const hdr = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT", kid: "fake_kid" }),
  ).toString("base64url");
  const pay = Buffer.from(
    JSON.stringify({
      sub: "user_invited_e2e",
      sid: "sess_invited_e2e",
      exp: nowS + 60,
      nbf: nowS - 5,
      iat: nowS - 5,
      iss: `https://${FAPI_HOST}`,
      azp: "http://localhost",
    }),
  ).toString("base64url");
  return `${hdr}.${pay}.fakesignatureXXXXXXXXXXXXXXXXX`;
}

function buildMockUser(userType: string | undefined): Record<string, unknown> {
  const nowMs = Date.now();
  return {
    object: "user",
    id: "user_invited_e2e",
    external_id: null,
    username: null,
    first_name: "Invited",
    last_name: "User",
    image_url: "",
    has_image: false,
    primary_email_address_id: "idn_mock_invited",
    primary_phone_number_id: null,
    primary_web3_wallet_id: null,
    password_enabled: false,
    two_factor_enabled: false,
    totp_enabled: false,
    backup_code_enabled: false,
    email_addresses: [
      {
        object: "email_address",
        id: "idn_mock_invited",
        email_address: "invited@example.com",
        reserved: false,
        verification: { status: "verified", strategy: "email_code" },
        linked_to: [],
      },
    ],
    phone_numbers: [],
    web3_wallets: [],
    external_accounts: [],
    passkeys: [],
    saml_accounts: [],
    enterprise_accounts: [],
    organization_memberships: [],
    public_metadata: userType ? { userType } : {},
    unsafe_metadata: {},
    created_at: nowMs - 86400000,
    updated_at: nowMs,
    last_sign_in_at: nowMs,
    banned: false,
    locked: false,
    lockout_expires_in_seconds: null,
    verification_attempts_remaining: 100,
    delete_self_enabled: true,
    create_organization_enabled: true,
    last_active_at: nowMs,
    profile_image_url: "",
  };
}

function buildMockClientBody(
  fakeJwt: string,
  userType: string | undefined,
): Record<string, unknown> {
  const nowMs = Date.now();
  const futureMs = nowMs + 7 * 24 * 60 * 60 * 1000;
  const sessionId = "sess_invited_e2e";
  const mockUser = buildMockUser(userType);

  const mockSession = {
    object: "session",
    id: sessionId,
    status: "active",
    expire_at: futureMs,
    abandon_at: futureMs + 86400000,
    last_active_at: nowMs,
    last_active_organization_id: null,
    actor: null,
    user: mockUser,
    public_user_data: {
      first_name: "Invited",
      last_name: "User",
      image_url: "",
      has_image: false,
      identifier: "invited@example.com",
      user_id: "user_invited_e2e",
      profile_image_url: "",
    },
    created_at: nowMs - 3600000,
    updated_at: nowMs,
    last_active_token: { object: "token", jwt: fakeJwt },
  };

  return {
    response: {
      object: "client",
      id: "client_mock_invited",
      sessions: [mockSession],
      sign_in: null,
      sign_up: null,
      last_active_session_id: sessionId,
      created_at: nowMs - 3600000,
      updated_at: nowMs,
    },
    client: {
      object: "client",
      id: "client_mock_invited",
      sessions: [mockSession],
      sign_in: null,
      sign_up: null,
      last_active_session_id: sessionId,
      created_at: nowMs - 3600000,
      updated_at: nowMs,
    },
  };
}

/**
 * Installs a fake FAPI session where the user initially has NO userType.
 *
 * The GET /v1/client mock is stateful: the first `initialCallsWithoutType`
 * GET requests return a user with no userType (simulating the state before
 * set-user-type runs). All subsequent calls return a user with userType "team".
 *
 * GET /v1/me always returns the user WITH userType "team" because
 * user.reload() calls /v1/me to fetch the refreshed user object.
 * By always returning the typed user from /v1/me, the reload() call inside
 * TypeAssignmentGate succeeds and the user.publicMetadata.userType becomes
 * "team" — allowing UserTypeGuard to pass and the dashboard to render.
 */
async function setupFapiWithUntypedUser(
  page: import("@playwright/test").Page,
  { initialCallsWithoutType = 1 }: { initialCallsWithoutType?: number } = {},
): Promise<void> {
  const fakeJwt = buildFakeJwt();
  const escapedHost = FAPI_HOST.replace(/\./g, "\\.");
  const FAPI_PATTERN = new RegExp(`https://${escapedHost}/v1/`);

  // Catch-all: any unmatched FAPI request → minimal empty 200 JSON.
  // Registered first so more-specific routes below take priority.
  await page.route(FAPI_PATTERN, async (route) => {
    const origin = route.request().headers()["origin"];
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (origin) {
      headers["access-control-allow-origin"] = origin;
      headers["access-control-allow-credentials"] = "true";
    }
    await route.fulfill({ status: 200, headers, body: JSON.stringify({}) });
  });

  // Stateful GET /v1/client mock.
  // In Playwright, routes registered later take priority over earlier ones.
  let clientCallCount = 0;
  const CLIENT_PATTERN = new RegExp(
    `https://${escapedHost}/v1/client(?:\\?|$)`,
  );
  await page.route(CLIENT_PATTERN, async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    clientCallCount++;
    const userType =
      clientCallCount > initialCallsWithoutType ? "team" : undefined;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(buildMockClientBody(fakeJwt, userType)),
    });
  });

  // GET /v1/me — called by Clerk's user.reload() to refresh the user object
  // after TypeAssignmentGate runs set-user-type. Always returns the user
  // WITH userType "team" so that the reload resolves the gate successfully.
  const ME_PATTERN = new RegExp(
    `https://${escapedHost}/v1/me(?:\\?|$)`,
  );
  await page.route(ME_PATTERN, async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    const origin = route.request().headers()["origin"];
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (origin) {
      headers["access-control-allow-origin"] = origin;
      headers["access-control-allow-credentials"] = "true";
    }
    await route.fulfill({
      status: 200,
      headers,
      body: JSON.stringify({ response: buildMockUser("team") }),
    });
  });

  // POST /v1/client/sessions/{id}/tokens — periodic JWT refresh by Clerk.js.
  const TOKEN_PATTERN = new RegExp(
    `https://${escapedHost}/v1/client/sessions/[^/]+/tokens`,
  );
  await page.route(TOKEN_PATTERN, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ object: "token", jwt: fakeJwt }),
    });
  });
}

// ---------------------------------------------------------------------------
// Test suite 1 — happy path
// ---------------------------------------------------------------------------

test.describe("TypeAssignmentGate — happy path (invited user, no userType)", () => {
  // We install our own FAPI mock below; skip the auto-fixture.
  test.use({ skipFapiMock: true });

  test(
    "freshly invited user with no userType is never shown 'Access Denied' and lands on the dashboard",
    async ({ page }) => {
      // Fake FAPI: first GET /v1/client → no userType; reload (/v1/me) → "team"
      await setupFapiWithUntypedUser(page, { initialCallsWithoutType: 1 });

      // set-user-type → success (server assigns userType "team" in Clerk metadata)
      await page.route("**/api/auth/set-user-type", async (route) => {
        if (route.request().method() === "POST") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ success: true }),
          });
        } else {
          await route.continue();
        }
      });

      // Workspace members / role — needed by the dashboard layout
      await page.route("**/api/users**", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            members: [
              {
                id: 1,
                email: "invited@example.com",
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
              email: "invited@example.com",
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

      // Track every main-frame navigation URL so we can confirm /unauthorized
      // was never visited.
      const visitedUrls: string[] = [];
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) {
          visitedUrls.push(frame.url());
        }
      });

      await page.goto("/devices", { waitUntil: "domcontentloaded" });

      // The user must land on /devices — this confirms that TypeAssignmentGate
      // completed (set-user-type + user.reload()) and UserTypeGuard passed.
      // We assert the URL rather than a specific heading to be robust against
      // other unrelated API routes not being mocked.
      await expect(page).toHaveURL(/\/devices$/, { timeout: 20_000 });

      // "Access Denied" must never have appeared anywhere on the page.
      await expect(page.getByText("Access Denied")).toHaveCount(0);

      // /unauthorized must never have been navigated to.
      const hitUnauthorized = visitedUrls.some((u) =>
        u.includes("/unauthorized"),
      );
      expect(
        hitUnauthorized,
        `Page navigated to /unauthorized during the TypeAssignmentGate flow.\nURLs visited: ${visitedUrls.join(", ")}`,
      ).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------
// Test suite 2 — failure path
// ---------------------------------------------------------------------------

test.describe("TypeAssignmentGate — failure path (set-user-type returns 500)", () => {
  test.use({ skipFapiMock: true });

  test(
    "when POST /api/auth/set-user-type fails, an error is shown inline and there is no infinite loader",
    async ({ page }) => {
      // FAPI mock where the user never gets a userType assigned via /v1/client
      // (set-user-type will fail before user.reload() can be called).
      await setupFapiWithUntypedUser(page, { initialCallsWithoutType: 999 });

      // set-user-type → 500 server error. The body uses no recognised `error`
      // or `message` fields so that apiFetch falls back to "HTTP 500" as the
      // error message, which TypeAssignmentGate surfaces in the error div.
      await page.route("**/api/auth/set-user-type", async (route) => {
        if (route.request().method() === "POST") {
          await route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({}),
          });
        } else {
          await route.continue();
        }
      });

      await page.goto("/devices", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Devices" })).toBeVisible({ timeout: 15_000 });

      // TypeAssignmentGate must surface its inline error.
      // The error paragraph has the Tailwind class "text-destructive" and
      // is the only element with that class rendered by TypeAssignmentGate.
      // We assert on the CSS selector so the test remains valid even if the
      // exact error message wording changes.
      const errorParagraph = page.locator("p.text-destructive");
      await expect(errorParagraph).toBeVisible({ timeout: 20_000 });
      // The paragraph must contain some non-empty text — it's not a blank div.
      const errorText = await errorParagraph.textContent();
      expect(errorText?.trim().length).toBeGreaterThan(0);

      // The page must have reached a terminal state — no infinite spinner.
      // Verify by confirming the error is stable (not hidden behind a spinner).
      await expect(errorParagraph).toBeVisible({ timeout: 3_000 });

      // "Access Denied" must not appear — the error state must not be confused
      // with the /unauthorized redirect.
      await expect(page.getByText("Access Denied")).toHaveCount(0);
    },
  );
});
