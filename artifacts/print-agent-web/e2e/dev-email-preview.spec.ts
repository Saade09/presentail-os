/**
 * End-to-end tests for the dev-only email preview route.
 *
 * Route: GET /api/dev/email-preview/:template
 *
 * These tests verify:
 *  1. Every registered template slug returns HTTP 200 with text/html content.
 *  2. Each response contains key strings specific to that template
 *     (brand name, headline text, CTA buttons, sample data values) — catching
 *     regressions when templates are edited or builder functions are renamed.
 *  3. An unknown slug returns HTTP 404.
 *
 * Production-guard note:
 *  The router only registers these routes when NODE_ENV !== "production".
 *  This guard is enforced at server startup (conditional route registration),
 *  not per-request, so it cannot be exercised via HTTP in a dev/test
 *  environment without restarting the server with NODE_ENV=production.
 *  The guard is covered by code inspection: the `if (process.env.NODE_ENV !== "production")`
 *  block wrapping the router.get() calls in devEmailPreview.ts is the source of
 *  truth. Registering routes conditionally at startup is the correct pattern for
 *  dev-only endpoints — it is not bypassable at request time.
 *
 * Auth:
 *  The email preview endpoints are unauthenticated dev helpers.
 *  These tests use a bare browser request context — no Clerk session needed.
 */

// e2e-unauthenticated
import { test, expect } from "@playwright/test";

// Bypass any stored Clerk auth state — these endpoints need no authentication.
test.use({ storageState: { cookies: [], origins: [] } });

const BASE = "/api/dev/email-preview";

test.describe("Email preview route — all templates return 200 with HTML", () => {
  test("template: invite (standard)", async ({ page }) => {
    const res = await page.request.get(`${BASE}/invite`);

    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/html");

    const html = await res.text();
    expect(html).toContain("Presentail OS");
    expect(html).toContain("You're invited");
    expect(html).toContain("Join your team on");
    expect(html).toContain("Accept invitation");
    expect(html).toContain("Designer");
    expect(html).toContain("admin@acme.com");
    expect(html).toContain("sample-invite-token-abc123");
  });

  test("template: invite-access-approval", async ({ page }) => {
    const res = await page.request.get(`${BASE}/invite-access-approval`);

    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/html");

    const html = await res.text();
    expect(html).toContain("Presentail OS");
    expect(html).toContain("Access request approved");
    expect(html).toContain("Your access request");
    expect(html).toContain("has been approved");
    expect(html).toContain("Sign in to your workspace");
    expect(html).toContain("Customer Service Agent");
  });

  test("template: access-request", async ({ page }) => {
    const res = await page.request.get(`${BASE}/access-request`);

    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/html");

    const html = await res.text();
    expect(html).toContain("Presentail OS");
    expect(html).toContain("Access Request");
    expect(html).toContain("Someone wants access");
    expect(html).toContain("Manage Users");
    expect(html).toContain("John Smith");
    expect(html).toContain("john.smith@example.com");
  });

  test("template: access-rejection", async ({ page }) => {
    const res = await page.request.get(`${BASE}/access-rejection`);

    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/html");

    const html = await res.text();
    expect(html).toContain("Presentail OS");
    expect(html).toContain("Access request update");
    expect(html).toContain("Your access request");
    expect(html).toContain("was not approved");
    expect(html).toContain("john.smith@example.com");
  });

  test("template: offline-alert", async ({ page }) => {
    const res = await page.request.get(`${BASE}/offline-alert`);

    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/html");

    const html = await res.text();
    expect(html).toContain("Presentail OS");
    expect(html).toContain("Device Alert");
    expect(html).toContain("gone offline");
    expect(html).toContain("View Device Monitor");
    expect(html).toContain("POS Terminal");
    expect(html).toContain("Kiosk #3");
    expect(html).toContain("15 minutes");
  });

  test("template: time-off-approved", async ({ page }) => {
    const res = await page.request.get(`${BASE}/time-off-approved`);

    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/html");

    const html = await res.text();
    expect(html).toContain("Presentail OS");
    expect(html).toContain("Time off approved");
    expect(html).toContain("Sarah Johnson");
    expect(html).toContain("Annual Leave");
    expect(html).toContain("Enjoy your well-deserved vacation");
    expect(html).toContain("Michael Chen");
    expect(html).toContain("View time off");
  });

  test("template: time-off-declined", async ({ page }) => {
    const res = await page.request.get(`${BASE}/time-off-declined`);

    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/html");

    const html = await res.text();
    expect(html).toContain("Presentail OS");
    expect(html).toContain("Time off declined");
    expect(html).toContain("Sarah Johnson");
    expect(html).toContain("Annual Leave");
    expect(html).toContain("major launch");
    expect(html).toContain("Michael Chen");
    expect(html).toContain("View time off");
  });

  test("template: time-off-submitted", async ({ page }) => {
    const res = await page.request.get(`${BASE}/time-off-submitted`);

    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/html");

    const html = await res.text();
    expect(html).toContain("Presentail OS");
    expect(html).toContain("New time-off request");
    expect(html).toContain("Sarah Johnson");
    expect(html).toContain("Annual Leave");
    expect(html).toContain("Family vacation");
    expect(html).toContain("Review request");
  });

  test("template: leave-policy-assigned", async ({ page }) => {
    const res = await page.request.get(`${BASE}/leave-policy-assigned`);

    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/html");

    const html = await res.text();
    expect(html).toContain("Presentail OS");
    expect(html).toContain("Leave policy");
    expect(html).toContain("Hi Sarah");
    expect(html).toContain("Standard Employee Policy 2026");
    expect(html).toContain("21");
    expect(html).toContain("2026");
    expect(html).toContain("View leave balance");
  });
});

test.describe("Email preview route — index page", () => {
  test("GET /api/dev/email-preview lists all templates with links", async ({
    page,
  }) => {
    const res = await page.request.get(BASE);

    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/html");

    const html = await res.text();
    expect(html).toContain("Email Template Preview");
    expect(html).toContain("Dev only");
    expect(html).toContain(`href="/api/dev/email-preview/invite"`);
    expect(html).toContain(`href="/api/dev/email-preview/access-request"`);
    expect(html).toContain(`href="/api/dev/email-preview/offline-alert"`);
    expect(html).toContain(`href="/api/dev/email-preview/time-off-approved"`);
    expect(html).toContain(`href="/api/dev/email-preview/leave-policy-assigned"`);
  });
});

test.describe("Email preview route — error cases", () => {
  test("unknown template slug returns 404 with helpful message", async ({
    page,
  }) => {
    const res = await page.request.get(`${BASE}/does-not-exist`);

    expect(res.status()).toBe(404);

    const body = await res.text();
    expect(body).toContain("Unknown template");
    expect(body).toContain("does-not-exist");
    expect(body).toContain("invite");
  });

  test("another unknown slug also returns 404 and lists available templates", async ({
    page,
  }) => {
    const res = await page.request.get(`${BASE}/welcome-email`);

    expect(res.status()).toBe(404);

    const body = await res.text();
    expect(body).toContain("Unknown template");
    expect(body).toContain("welcome-email");
    expect(body).toContain("invite");
  });
});
