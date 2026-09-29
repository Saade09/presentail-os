/**
 * Custom Playwright test fixtures.
 *
 * Extends the base `page` fixture to automatically install the FAPI mock
 * session before every test.  This is necessary because the test Clerk
 * instance (pk_test_ / sk_test_) lives on a clerk.accounts.dev host derived
 * which is behind Cloudflare bot-protection that blocks headless Chromium.
 * The FAPI sign-in in globalSetup therefore does not produce real __session
 * cookies, so we install a mocked GET /v1/client response that makes Clerk.js
 * believe the tester is signed in as the e2e test user.
 *
 * Every spec file that needs an authenticated session should import { test,
 * expect } from this module instead of from @playwright/test.  Tests that
 * intentionally exercise unauthenticated flows (e.g. sign-in-ticket-error)
 * must continue to import directly from @playwright/test.
 *
 * Tests or describe blocks that need NO active session (i.e. they test pages
 * visible only while signed-out) should add:
 *   test.use({ skipFapiMock: true });
 * This prevents the auto-fixture from intercepting FAPI calls and injecting
 * a fake authenticated session.
 */

import { test as base, expect } from "@playwright/test";
import { setupFapiWithMockSession } from "./clerk-fapi-redirect";

export { expect };

export const test = base.extend<{ skipFapiMock: boolean; _fapiMock: void }>({
  skipFapiMock: [false, { option: true }],
  _fapiMock: [
    async ({ page, skipFapiMock }, use) => {
      if (!skipFapiMock) {
        await setupFapiWithMockSession(page);
      }
      await use();
    },
    { auto: true },
  ],
});
