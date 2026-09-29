/**
 * Real production Clerk release gate.
 *
 * This file is intentionally not included in the normal mocked/test-instance
 * Playwright config. It must run against a published URL with an operator-
 * supplied authenticated browser state and login credentials held outside git.
 *
 * Required environment:
 *   PRODUCTION_SMOKE_BASE_URL
 *   PRODUCTION_SMOKE_STORAGE_STATE
 *   PRODUCTION_SMOKE_EMAIL
 *   PRODUCTION_SMOKE_PASSWORD
 *   PRODUCTION_SMOKE_ENTITY_ID (optional, defaults to 3)
 *
 * The suite is serial and fail-closed. The Odoo audit is a separate command and
 * must not be run unless this suite exits successfully.
 */
// e2e-unauthenticated: this spec intentionally bypasses the mocked test Clerk
// fixture; it is only run against the published production Clerk instance.
import { test, expect } from "@playwright/test";

const email = process.env.PRODUCTION_SMOKE_EMAIL;
const password = process.env.PRODUCTION_SMOKE_PASSWORD;
const entityId = process.env.PRODUCTION_SMOKE_ENTITY_ID ?? "3";

if (!email || !password) {
  throw new Error(
    "PRODUCTION_SMOKE_EMAIL and PRODUCTION_SMOKE_PASSWORD are required; " +
      "store them as secrets and never place them in source or command history.",
  );
}

const authHeader = async (page: import("@playwright/test").Page): Promise<string> => {
  const token = await page.evaluate(async () => {
    const clerk = (window as Window & {
      Clerk?: { session?: { getToken(opts?: { skipCache?: boolean }): Promise<string | null> } };
    }).Clerk;
    const value = await clerk?.session?.getToken({ skipCache: true });
    if (!value) throw new Error("Clerk did not return a session token");
    return value;
  });
  return `Bearer ${token}`;
};

async function expectApiJson(
  page: import("@playwright/test").Page,
  path: string,
  expectedStatus: number,
  headers: Record<string, string> = {},
) {
  const response = await page.request.get(path, { headers });
  expect(response.status(), `${path} returned an unexpected status`).toBe(expectedStatus);
  return response;
}

test.describe.configure({ mode: "serial" });

test("production Clerk release gate", async ({ browser, page, baseURL }) => {
  test.setTimeout(120_000);
  expect(baseURL).toMatch(/^https:\/\//);

  // The existing authenticated state must survive a fresh page load.
  await page.goto("/devices", { waitUntil: "domcontentloaded" });
  await expect(page).not.toHaveURL(/\/sign-in(?:\/|$)/, { timeout: 30_000 });
  const existingBearer = await authHeader(page);
  await expectApiJson(page, "/api/users", 200, { Authorization: existingBearer });

  // The same browser session must refresh a token and continue to authenticate.
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page).not.toHaveURL(/\/sign-in(?:\/|$)/, { timeout: 30_000 });
  const refreshedBearer = await authHeader(page);
  expect(refreshedBearer).toMatch(/^Bearer \S+/);
  await expectApiJson(page, "/api/users", 200, { Authorization: refreshedBearer });

  // Finance audit authentication is checked before any audit command is
  // allowed to run. limit=1 keeps this probe read-only and bounded.
  const audit = await expectApiJson(
    page,
    `/api/finance/invoice-review/audit-approved-to-odoo?entity_id=${encodeURIComponent(entityId)}&limit=1`,
    200,
    { Authorization: refreshedBearer },
  );
  const auditBody = await audit.json();
  expect(auditBody).toBeTruthy();

  // Invalid and expired bearer tokens must remain authentication failures.
  await expectApiJson(page, "/api/users", 401, {
    Authorization: "Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJpbnZhbGlkIn0.invalid",
  });
  await expectApiJson(page, "/api/users", 401, {
    Authorization: "Bearer expired.production.smoke.token",
  });

  // Logout must clear the browser session, and a subsequent login must create
  // a usable new session. This is deliberately UI-driven, not a mocked FAPI.
    const loggedOut = await browser.newContext({
      // Explicitly clear the supplied authenticated state for the fresh
      // login/logout cycle. This is also important to keep this production-
      // only spec honest if the config is ever reused by the normal runner.
      storageState: { cookies: [], origins: [] },
    });
  const loggedOutPage = await loggedOut.newPage();
  try {
    await loggedOutPage.goto("/sign-in", { waitUntil: "domcontentloaded" });
    await loggedOutPage.getByRole("button", { name: "Continue with Email + Password" }).click();
    await loggedOutPage.locator("#pw-email").fill(email);
    await loggedOutPage.locator("#pw-password").fill(password);
    await loggedOutPage.getByRole("button", { name: "Sign in" }).click();
    await expect(loggedOutPage).not.toHaveURL(/\/sign-in(?:\/|$)/, { timeout: 45_000 });
    const freshBearer = await authHeader(loggedOutPage);
    await expectApiJson(loggedOutPage, "/api/users", 200, {
      Authorization: freshBearer,
    });

    const session = await loggedOutPage.evaluate(async () => {
      const clerk = (window as Window & {
        Clerk?: { signOut?: () => Promise<void> };
      }).Clerk;
      if (!clerk?.signOut) throw new Error("Clerk signOut is unavailable");
      await clerk.signOut();
      return true;
    });
    expect(session).toBe(true);
    await loggedOutPage.goto("/devices", { waitUntil: "domcontentloaded" });
    await expect(loggedOutPage).toHaveURL(/\/sign-in(?:\/|$)/, { timeout: 30_000 });
  } finally {
    await loggedOut.close();
  }
});

test("production and development Clerk instances stay separated", async ({ page, baseURL }) => {
  expect(baseURL).not.toContain("replit.dev");
  const bundle = await page.request.get("/");
  expect(bundle.status()).toBe(200);
  const html = await bundle.text();
  expect(html).not.toContain("becoming-man-73.clerk.accounts.dev");
  expect(html).not.toContain("clerk.os.presentail.com");
});